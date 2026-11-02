#!/usr/bin/env node
// Freeze the guest trace only after checking all application-provided bytes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gzipSync as gzip_sync } from "node:zlib";
import { createHash as create_hash } from "node:crypto";
import { createRequire as create_require } from "node:module";
const require=create_require(import.meta.url),P=require("../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"),W=require("../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
const input_path=path.resolve(process.argv[2]),directory=path.dirname(input_path),build=JSON.parse(fs.readFileSync(directory+"/capture.json")),input=fs.readFileSync(input_path),bytes=Buffer.from(input);
const hash=b=>create_hash("sha256").update(b).digest("hex");assert.equal(build.api,8);assert.equal(hash(input),build.sha256);assert.equal(hash(fs.readFileSync(directory+"/D3D8.DLL")),build.dllSha256);assert.equal(hash(fs.readFileSync(directory+"/TWEEN.EXE")),build.executableSha256);
const scenes=[{name:"both/.25",mode:"both",factor:.25},{name:"both/.75/indexed-base",mode:"both",factor:.75,indexed:true},{name:"position-only",mode:"position",factor:.75},{name:"normal-only",mode:"normal",factor:.75},{name:"constant-secondary",mode:"both",factor:.25,constant:true},{name:"world-user-plane",mode:"both",factor:.75,indexed:true,plane:true},{name:"normalized-normal",mode:"both",factor:.75,normalize:true},{name:"secondary-normal-alone",mode:"normal-alone",factor:.75}];
const first=[[-.875,-.875,.25,0,0,1],[-.875,-.875,.25,0,0,1],[-.75,-.5,.25,0,0,1],[-.25,.5,.25,0,0,1],[.25,-.5,.25,0,0,1]],second=first.map(p=>[p[0]+.5,p[1]+.25,.75,0,1,0]);second[0]=[.5,0,.75,0,1,0];
const round=n=>Math.max(0,Math.min(255,Math.floor(n*255+.5)));
function expected(scene){const position=scene.mode==="both"||scene.mode==="position",normal=scene.mode!=="position",t=scene.factor;
 let gain=normal?t:0;if(scene.normalize)gain/=Math.hypot(t,1-t);const eyeZ=position?.25+.5*t:.25,fog=1-eyeZ,alpha=round(.75),color=[round(gain),round(gain*.5),round(gain*.25),alpha],diffuse=((alpha<<24)|(color[0]<<16)|(color[1]<<8)|color[2])>>>0;
 const vertices=first.slice(2).map((p,i)=>{const q=scene.constant?second[0]:second[i+2],object=p.slice(0,3).map((n,c)=>position?n*(1-t)+q[c]*t:n);return [(object[0]*2+1)*32,(1-object[1]+.125)*32,object[2]*.5,1];});
 const storedVertices=vertices.map(p=>p[0]<0||p[0]>64||p[1]<0||p[1]>64||(scene.plane&&p[0]<32)?[p[0]/64,1-p[1]/64,p[2],1]:p);
 let polygon=vertices.map(p=>p.slice(0,2));for(const [axis,bound,greater] of [[0,0,true],[0,64,false],[1,0,true],[1,64,false],...(scene.plane?[[0,32,true]]:[])]){const out=[];for(let i=0;i<polygon.length;++i){const a=polygon[i],b=polygon[(i+1)%polygon.length],da=greater?a[axis]-bound:bound-a[axis],db=greater?b[axis]-bound:bound-b[axis];if(da>=0)out.push(a);if((da>0&&db<0)||(da<0&&db>0)){const f=da/(da-db);out.push(a.map((v,c)=>c===axis?bound:v+(b[c]-v)*f));}}polygon=out;}
 return {vertices,storedVertices,polygon,diffuse,specular:(round(fog)<<24)>>>0,colorRGBA:color,fogFactor:fog,pixelRGBA:[...color.slice(0,3).map((n,c)=>Math.round(n*fog+[32,64,96][c]*(1-fog))),alpha]};
}
for(const scene of scenes)scene.expected=expected(scene);
const allowed=new Set("HELLO CREATE_DEVICE CREATE_TEXTURE_2D SET_RENDER_TARGET SET_DEPTH_STENCIL_SURFACE_LEVEL CREATE_VERTEX_DECLARATION CREATE_BUFFER UPDATE_BUFFER SET_INDICES SET_TRANSFORM SET_MATERIAL SET_LIGHT LIGHT_ENABLE SET_RENDER_STATE SET_TEXTURE_STAGE_STATE SET_CLIP_PLANE SET_VERTEX_DECLARATION SET_VERTEX_SHADER SET_STREAM_SOURCE CLEAR BEGIN_SCENE DRAW_PRIMITIVE END_SCENE PRESENT SET_FVF DRAW_PRIMITIVE_UP DRAW_INDEXED_PRIMITIVE DESTROY_RESOURCE SESSION_END GUEST_LOG WINDOW_STATE SET_VIEWPORT SET_CURSOR_PROPERTIES SET_CURSOR_POSITION SHOW_CURSOR".split(" "));
const buffers=new Map(),counts={},removed=[];let frames=0,primary=0,secondary=0,index=0,processed=0,declarations=0;
const floats=data=>Array.from({length:data.length/4},(_,i)=>data.readFloatLE(i*4));
for(let at=0;at<bytes.length;){assert(at+12<=bytes.length);const size=bytes.readUInt32LE(at+8),start=at+20;assert(build.owners.includes(bytes.readUInt32LE(at)));assert(size>=8&&size<=bytes.length-at-12);assert.equal(bytes.readUInt16LE(at+12),0xffe1);assert.equal(bytes.readUInt16LE(at+14),0xffff);assert.equal(bytes.readUInt32LE(at+16),size-8);const packet=bytes.subarray(start,at+12+size),h=W.readHeader(packet);W.checkStream(h.view,h.end,h.commandCount);
 for(let offset=P.STRUCTS.BatchHeader.size;offset<h.end;){const op=h.view.getUint16(offset,true),name=P.OP_NAME[op],length=h.view.getUint32(offset+P.F.CommandHeader.size,true),payload=offset+P.STRUCTS.CommandHeader.size;assert(allowed.has(name),"unexpected command "+name);counts[name]=(counts[name]||0)+1;const v=P.decode(P.commandStruct(op),h.view,payload,length-P.STRUCTS.CommandHeader.size);
  const blob=(first,count)=>{assert(first>=payload&&first+count<=offset+length);return packet.subarray(first,first+count);};
  if(name==="CREATE_BUFFER")buffers.set(v.resource_handle,v);
  if(name==="UPDATE_BUFFER"){const buffer=buffers.get(v.resource_handle);assert(buffer);const data=blob(v.data_offset,v.byte_count);assert.equal(v.destination_offset,0);
   if(v.byte_count===120){const a=floats(data);if(a[0]===-.875){assert.deepEqual(a,first.flat());primary++;}else{assert.deepEqual(a,second.flat());secondary++;}}
   else if(v.byte_count===6){assert.equal(buffer.resource_kind,2);assert.deepEqual([...data],[1,0,2,0,3,0]);index++;}
   else{assert.equal(v.byte_count,72);assert.equal(frames%2,1);const e=scenes[frames>>1].expected;for(let i=0;i<3;++i){assert.deepEqual(floats(data.subarray(i*24,i*24+16)),e.storedVertices[i]);assert.equal(data.readUInt32LE(i*24+16),e.diffuse);assert.equal(data.readUInt32LE(i*24+20),e.specular);}processed++;}
  }
  if(name==="CREATE_VERTEX_DECLARATION"){assert(v.element_count>=2&&v.element_count<=4);for(let i=0;i<v.element_count;++i){const e=P.decode("VertexElement",h.view,payload+P.STRUCTS.CreateVertexDeclaration.size+i*8,8);assert([1,15].includes(e.stream));assert.equal(e.type,2);assert([0,3].includes(e.usage));assert(e.usage_index<=1);}declarations++;}
  if(name==="CREATE_VERTEX_SHADER"||name==="CREATE_PIXEL_SHADER")assert.fail("fixed declarations must have no shader code");
  if(name==="UPDATE_TEXTURE")assert.fail("no application texture uploads expected");
  if(name==="DRAW_PRIMITIVE_UP"){assert.equal(frames%2,1);assert.equal(v.stride,24);assert.equal(v.primitive_type,4);const data=blob(v.vertex_data_offset,v.vertex_bytes),e=scenes[frames>>1].expected;assert.equal(v.vertex_count,(e.polygon.length-2)*3);for(let i=0;i<v.vertex_count;++i){const vertex=floats(data.subarray(i*24,i*24+16));assert(e.polygon.some(p=>Math.abs(p[0]-vertex[0])<1e-5&&Math.abs(p[1]-vertex[1])<1e-5));assert.equal(data.readUInt32LE(i*24+16),e.diffuse);assert.equal(data.readUInt32LE(i*24+20),e.specular);}}
  if(name==="GUEST_LOG"||name==="SET_CURSOR_PROPERTIES"){const first=name==="GUEST_LOG"?payload+P.STRUCTS.GuestLog.size:v.data_offset,count=name==="GUEST_LOG"?v.text_bytes:v.data_bytes;if(count)blob(first,count);bytes.fill(0,start+first,start+first+count);removed.push({command:name,bytes:count});}
  if(name==="PRESENT")frames++;offset+=length;
 }at+=12+size;
}
assert.equal(frames,16);assert.equal(primary,1);assert.equal(secondary,1);assert.equal(index,1);assert.equal(processed,8);assert.equal(declarations,4);
const target=new URL("../tests/glbridge/fixtures/d3d8_tween_xp",import.meta.url);fs.writeFileSync(new URL(target.href+".bin.gz"),gzip_sync(bytes));fs.writeFileSync(new URL(target.href+".json"),JSON.stringify({description:"Actual XP D3D8 fixed declaration Tween draws paired with CPU processing; all source/index/output bytes independently checked, diagnostics/cursors zeroed.",frames,scenes,counts,traceBytes:bytes.length,traceSha256:hash(bytes),sourceCaptureSha256:hash(input),removedPayloads:removed,captureBuild:build,reference:"Independent affine position/normal, directional diffuse and linear fog formulas; no production vertex/shader helper"},null,2)+"\n");console.log("PASS sanitized D3D8 Tween fixture: 16 frames, 8 independent processed vertex/color references and checked procedural inputs");
