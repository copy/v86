#!/usr/bin/env node
// Keep only procedural input data. Desktop/cursor pixels and diagnostic text
// are zeroed without changing command sizes, offsets, owner or sequence IDs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gzipSync as gzip_sync } from "node:zlib";
import { createHash as create_hash } from "node:crypto";
import { createRequire as create_require } from "node:module";
import { fileURLToPath as file_url_to_path } from "node:url";
const root=file_url_to_path(new URL("../",import.meta.url)),require=create_require(import.meta.url);
const P=require("../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"),W=require("../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
const input_path=path.resolve(process.argv[2]||root+"build/d3d-review/stage4d2i3e-typed-xp/graphics.bin"),input=fs.readFileSync(input_path),bytes=Buffer.from(input);
const build=JSON.parse(fs.readFileSync(path.join(path.dirname(input_path),"capture.json"))),hash=data=>create_hash("sha256").update(data).digest("hex");
assert.equal(build.api,9);assert.equal(build.bytes,input.length);assert.equal(build.sha256,hash(input));assert.equal(build.frames,76);
assert.equal(hash(fs.readFileSync(path.join(path.dirname(input_path),"D3D9.DLL"))),build.dllSha256);assert.equal(hash(fs.readFileSync(path.join(path.dirname(input_path),"CLIP.EXE"))),build.executableSha256);
const allowed=new Set("HELLO GUEST_LOG CREATE_DEVICE DD_SET_DISPLAY_MODE CREATE_TEXTURE_2D DD_SET_COLOR_KEY UPDATE_TEXTURE SET_TEXTURE SET_RENDER_TARGET SET_DEPTH_STENCIL_SURFACE_LEVEL SET_VIEWPORT SET_MATERIAL SET_LIGHT LIGHT_ENABLE SET_TRANSFORM SET_RENDER_STATE SET_CLIP_PLANE SET_SAMPLER_STATE SET_TEXTURE_STAGE_STATE CREATE_BUFFER CLEAR UPDATE_BUFFER BEGIN_SCENE SET_FVF DRAW_PRIMITIVE DRAW_INDEXED_PRIMITIVE DRAW_PRIMITIVE_UP SET_STREAM_SOURCE SET_STREAM_SOURCE_FREQ SET_INDICES SET_VERTEX_SHADER CREATE_VERTEX_DECLARATION SET_VERTEX_DECLARATION END_SCENE DD_BLT WINDOW_STATE SET_CURSOR_PROPERTIES SET_CURSOR_POSITION SHOW_CURSOR SET_SCISSOR_RECT PRESENT DESTROY_RESOURCE CREATE_PIXEL_SHADER SET_PIXEL_SHADER SET_PIXEL_SHADER_CONSTANT_F".split(" "));
const expected_shader=Buffer.alloc(36);[0xffff0300,0x0200001f,0x8001000a,0x900f0000,0x03000005,0x800f0800,0x90e40000,0xa0e40000,0xffff].forEach((word,i)=>expected_shader.writeUInt32LE(word,i*4));
const shaders=new Set(),removed=[],counts={};let carrier=0,frames=0;
while(carrier<bytes.length){
 assert(carrier+12<=bytes.length);const owner=bytes.readUInt32LE(carrier),size=bytes.readUInt32LE(carrier+8),start=carrier+20;
 assert(build.owners.includes(owner));assert(size>=8&&size<=bytes.length-carrier-12);assert.equal(bytes.readUInt16LE(carrier+12),0xffe1);assert.equal(bytes.readUInt16LE(carrier+14),0xffff);assert.equal(bytes.readUInt32LE(carrier+16),size-8);
 const packet=bytes.subarray(start,carrier+12+size),header=W.readHeader(packet);W.checkStream(header.view,header.end,header.commandCount);
 for(let at=P.STRUCTS.BatchHeader.size;at<header.end;){const opcode=header.view.getUint16(at,true),name=P.OP_NAME[opcode],length=header.view.getUint32(at+P.F.CommandHeader.size,true),payload=at+P.STRUCTS.CommandHeader.size;
  assert(allowed.has(name),"Unexpected procedural command: "+name);counts[name]=(counts[name]||0)+1;
  const value=P.decode(P.commandStruct(opcode),header.view,payload,length-P.STRUCTS.CommandHeader.size);
  if(name==="SET_VERTEX_SHADER")assert.equal(value.shader_handle,0);
  if(name==="CREATE_PIXEL_SHADER") {
   const count=value.instruction_token_count*4,first=value.code_offset;
   assert(first>=payload&&first+count<=at+length);assert(packet.subarray(first,first+count).equals(expected_shader));shaders.add(value.resource_handle);
  }
  if(name==="SET_PIXEL_SHADER")assert(value.shader_handle===0||shaders.has(value.shader_handle));
  if(name==="SET_PIXEL_SHADER_CONSTANT_F") {
   assert.equal(value.start_register,0);assert.equal(value.vector_count,1);
   assert(value.data_offset>=payload&&value.data_offset+16<=at+length);
   assert.deepEqual(Array.from({length:4},(_,i)=>header.view.getFloat32(value.data_offset+i*4,true)),[64,64,64,1]);
  }
  if(name==="UPDATE_TEXTURE"||name==="SET_CURSOR_PROPERTIES"||name==="GUEST_LOG"){
   const first=name==="GUEST_LOG"?payload+P.STRUCTS.GuestLog.size:value.data_offset,count=name==="GUEST_LOG"?value.text_bytes:value.data_bytes;
   assert(first>=payload&&first+count<=at+length);
   bytes.fill(0,start+first,start+first+count);removed.push({command:name,bytes:count});
  }
  if(name==="PRESENT")frames++;
  at+=length;
 }
 carrier+=12+size;
}
assert.equal(frames,76);assert.equal(shaders.size,1,"Only the specified nine-token procedural shader is retained");
const stem="d3d9_processed_typed_clip_xp",directory=path.join(root,"tests/glbridge/fixtures");
const reference=JSON.parse(fs.readFileSync(directory+"/d3d_typed_clip_reference.json"));
fs.writeFileSync(directory+"/"+stem+".bin.gz",gzip_sync(bytes));
fs.writeFileSync(directory+"/"+stem+".json",JSON.stringify({description:"Actual XP D3D9 COM: 19 four-frame typed attribute clipping controls. All desktop/cursor pixels and diagnostic text zeroed; only the explicitly specified nine-token procedural PS3 remains.",api:9,frames,framesPerCase:4,frameOrder:reference.frameOrder,pairs:reference.pairs,reference:"d3d_typed_clip_reference.json",sourceCaptureSha256:hash(input),traceSha256:hash(bytes),traceBytes:bytes.length,removedPayloads:removed,proceduralShaderTokens:Array.from({length:9},(_,i)=>expected_shader.readUInt32LE(i*4)),counts,captureBuild:build,scope:"Frozen replay of the exact captured DLL; changing guest C requires fresh captures. No complete native/Wine/game acceptance claim."},null,2)+"\n");
console.log("PASS procedural typed clipping fixture: 76 frames, one specified shader, "+removed.reduce((sum,row)=>sum+row.bytes,0)+" unrelated bytes zeroed");
