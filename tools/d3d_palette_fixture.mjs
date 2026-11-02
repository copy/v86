#!/usr/bin/env node
// Freeze only explicitly checked procedural texture, palette and vertex bytes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gzipSync as gzip_sync } from "node:zlib";
import { createHash as create_hash } from "node:crypto";
import { createRequire as create_require } from "node:module";
const require=create_require(import.meta.url),P=require("../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"),W=require("../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
const input_path=path.resolve(process.argv[2]),directory=path.dirname(input_path),build=JSON.parse(fs.readFileSync(directory+"/capture.json")),input=fs.readFileSync(input_path),bytes=Buffer.from(input);
const hash=b=>create_hash("sha256").update(b).digest("hex");assert([8,9].includes(build.api));assert.equal(hash(input),build.sha256);assert.equal(hash(fs.readFileSync(directory+"/D3D"+build.api+".DLL")),build.dllSha256);assert.equal(hash(fs.readFileSync(directory+"/PALETTE.EXE")),build.executableSha256);
const allowed=new Set("HELLO GUEST_LOG CREATE_DEVICE CREATE_TEXTURE_2D SET_RENDER_TARGET SET_DEPTH_STENCIL_SURFACE_LEVEL SET_VERTEX_SHADER SET_PIXEL_SHADER SET_FVF SET_RENDER_STATE SET_TEXTURE_STAGE_STATE SET_SAMPLER_STATE UPDATE_TEXTURE CLEAR BEGIN_SCENE SET_TEXTURE DRAW_PRIMITIVE_UP END_SCENE PRESENT SET_PALETTE SET_CURRENT_TEXTURE_PALETTE SET_VERTEX_SHADER_CONSTANT_F SET_PIXEL_SHADER_CONSTANT_F SET_CLIP_PLANE SET_TRANSFORM SET_VIEWPORT SET_SCISSOR_RECT SET_MATERIAL DESTROY_RESOURCE SESSION_END WINDOW_STATE SET_CURSOR_PROPERTIES SET_CURSOR_POSITION SHOW_CURSOR".split(" "));
const reference=JSON.parse(fs.readFileSync(new URL("../tests/glbridge/fixtures/d3d_palette_reference.json",import.meta.url))),textures=new Map(),counts={},removed=[];let frames=0;
for(let at=0;at<bytes.length;){assert(at+12<=bytes.length);const size=bytes.readUInt32LE(at+8),start=at+20;assert(build.owners.includes(bytes.readUInt32LE(at)));assert(size>=8&&size<=bytes.length-at-12);assert.equal(bytes.readUInt16LE(at+12),0xffe1);assert.equal(bytes.readUInt16LE(at+14),0xffff);assert.equal(bytes.readUInt32LE(at+16),size-8);const packet=bytes.subarray(start,at+12+size),h=W.readHeader(packet);W.checkStream(h.view,h.end,h.commandCount);
 for(let offset=P.STRUCTS.BatchHeader.size;offset<h.end;){const op=h.view.getUint16(offset,true),name=P.OP_NAME[op],length=h.view.getUint32(offset+P.F.CommandHeader.size,true),payload=offset+P.STRUCTS.CommandHeader.size;assert(allowed.has(name),"unexpected command "+name);counts[name]=(counts[name]||0)+1;const v=P.decode(P.commandStruct(op),h.view,payload,length-P.STRUCTS.CommandHeader.size);
  const blob=(first,count)=>{assert(first>=payload&&first+count<=offset+length);return packet.subarray(first,first+count);};
  if(name==="CREATE_TEXTURE_2D")textures.set(v.resource_handle,v.format);
  if(name==="UPDATE_TEXTURE"){const format=textures.get(v.resource_handle);assert([40,41].includes(format));assert.equal(v.width,2);assert.equal(v.height,2);assert.equal(v.data_bytes,format===40?8:4);assert.deepEqual([...blob(v.data_offset,v.data_bytes)],format===40?[173,64,173,64,173,64,173,64]:[173,173,173,173]);}
  if(name==="SET_PALETTE"){assert([0,65535].includes(v.palette_index));assert.equal(v.entry_count,256);const data=blob(v.data_offset,1024),color=data.readUInt32LE(0);assert([0xc9115395,0x63d32f65,0x973db317].includes(color));for(let i=0;i<256;++i)assert.equal(data.readUInt32LE(i*4),color);}
  if(name==="SET_CURRENT_TEXTURE_PALETTE")assert([0,40000,65535].includes(v.palette_index));
  if(name==="SET_VERTEX_SHADER"||name==="SET_PIXEL_SHADER")assert.equal(v.shader_handle,0);
  if(name==="DRAW_PRIMITIVE_UP"){assert.equal(v.stride,24);assert.equal(v.vertex_count,4);const data=blob(v.vertex_data_offset,v.stride*v.vertex_count);const first=data.readFloatLE(0);assert([0,32].includes(first));const expected=[];for(let i=0;i<4;++i)expected.push((i&1?32:0)+first,i<2?0:64,.5,1,i&1,i<2?0:1);assert.deepEqual(Array.from({length:24},(_,i)=>data.readFloatLE(i*4)),expected);}
  if(name==="GUEST_LOG"||name==="SET_CURSOR_PROPERTIES"){const first=name==="GUEST_LOG"?payload+P.STRUCTS.GuestLog.size:v.data_offset,count=name==="GUEST_LOG"?v.text_bytes:v.data_bytes;if(count)blob(first,count);bytes.fill(0,start+first,start+first+count);removed.push({command:name,bytes:count});}
  if(name==="PRESENT")frames++;offset+=length;
 }at+=12+size;
}
assert.equal(frames,reference.frames.length);assert.equal(counts.DRAW_PRIMITIVE_UP,24);assert.equal(counts.UPDATE_TEXTURE,2);
const stem="d3d"+build.api+"_palette_xp",target=new URL("../tests/glbridge/fixtures/",import.meta.url);fs.writeFileSync(new URL(stem+".bin.gz",target),gzip_sync(bytes));fs.writeFileSync(new URL(stem+".json",target),JSON.stringify({description:"Actual XP D3D"+build.api+" procedural palette COM capture; all variable blobs checked against explicit texture, palette and vertex bytes; diagnostics/cursors zeroed.",frames,counts,traceBytes:bytes.length,traceSha256:hash(bytes),sourceCaptureSha256:hash(input),removedPayloads:removed,captureBuild:build,reference:"d3d_palette_reference.json"},null,2)+"\n");console.log("PASS sanitized D3D"+build.api+" palette fixture: 12 frames, 24 procedural draws");
