#!/usr/bin/env node
// Exclusive fixture mutations; restore the original compressed bytes on exit.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {gzipSync as gzip_sync,gunzipSync as gunzip_sync} from "node:zlib";
import {createHash as create_hash} from "node:crypto";
import {createRequire as create_require} from "node:module";
import {spawnSync as spawn} from "node:child_process";
import {fileURLToPath as file_url_to_path} from "node:url";
const root=file_url_to_path(new URL("../../",import.meta.url)),require=create_require(import.meta.url);
const P=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"),W=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
const fixture=root+"tests/glbridge/fixtures/d3d9_processed_typed_clip_xp.bin.gz",compressed=fs.readFileSync(fixture),original=gunzip_sync(compressed);
const hash=data=>create_hash("sha256").update(data).digest("hex"),out=path.resolve(process.env.D9WG_TYPED_CLIP_MUTATION_OUT||root+"build/d3d-review/stage4d2i3e");fs.mkdirSync(out,{recursive:true});
const restore=()=>{if(!fs.readFileSync(fixture).equals(compressed))fs.writeFileSync(fixture,compressed);};
process.once("exit",restore);for(const signal of ["SIGINT","SIGTERM"])process.once(signal,()=>{restore();process.exit(130);});
const results=[];
try{
 for(const mode of ["premature-color-quantization","floating-specular-alpha","half-point-size"]){
  const bytes=Buffer.from(original);let frame=0,changed=0;
  for(let carrier=0;carrier<bytes.length;){
   const size=bytes.readUInt32LE(carrier+8),packet=bytes.subarray(carrier+20,carrier+12+size),header=W.readHeader(packet);W.checkStream(header.view,header.end,header.commandCount);
   for(let at=P.STRUCTS.BatchHeader.size;at<header.end;){
    const opcode=header.view.getUint16(at,true),length=header.view.getUint32(at+P.F.CommandHeader.size,true),payload=at+P.STRUCTS.CommandHeader.size,value=P.decode(P.commandStruct(opcode),header.view,payload,length-P.STRUCTS.CommandHeader.size);
    const selected=frame===(mode==="premature-color-quantization"?13:mode==="floating-specular-alpha"?73:69);
    if(selected&&opcode===P.OP.SET_FVF&&value.fvf===0&&mode==="premature-color-quantization"){
     const type=payload+P.STRUCTS.SetFVF.size+8+P.F.VertexElement.type;assert.equal(header.view.getUint8(type),3);header.view.setUint8(type,4);changed++;
    }
    if(selected&&opcode===P.OP.DRAW_PRIMITIVE_UP){
     for(let v=0;v<value.vertex_count;++v){const base=value.vertex_data_offset+v*value.stride;
      if(mode==="premature-color-quantization"){
       const color=Array.from({length:4},(_,c)=>Math.max(0,Math.min(255,Math.floor(header.view.getFloat32(base+16+c*4,true)*255+.5))));
       header.view.setUint32(base+16,((color[3]<<24)|(color[0]<<16)|(color[1]<<8)|color[2])>>>0,true);packet.fill(0,base+20,base+32);
      }else if(mode==="floating-specular-alpha")header.view.setFloat32(base+28,0,true);
      else{assert.equal(header.view.getFloat32(base+32,true),8.5);header.view.setFloat32(base+32,1,true);}
     }changed++;
    }
    if(opcode===P.OP.PRESENT)frame++;
    at+=length;
   }carrier+=12+size;
  }
  assert.equal(changed,mode==="premature-color-quantization"?2:1);fs.writeFileSync(fixture,gzip_sync(bytes));
  try{
   const run=spawn(process.execPath,[root+"tests/glbridge/gl_multipass_browser_runner.js","d3d_typed_clip_replay_browser_test.html"],{cwd:root,env:{...process.env,GL_SWIFTSHADER:"1"},encoding:"utf8",timeout:120000,maxBuffer:8<<20});
   const line=run.stdout.split(/\r?\n/).find(l=>l.startsWith('{"status"'));assert(line,run.stderr.slice(-1200)||"GPU runner did not report");const result=JSON.parse(line);
   assert.equal(result.status,"FAIL","survived: "+mode);assert.match(result.details,/XP typed clipped draw mismatch/);results.push({label:mode,killed:true,mutatedTraceSha256:hash(bytes)});
  }finally{restore();}
 }
 assert(fs.readFileSync(fixture).equals(compressed));fs.writeFileSync(out+"/gpu-mutations.json",JSON.stringify({fixtureSha256:hash(compressed),mutations:results},null,2)+"\n");
 console.log("PASS typed clipping GPU mutations: 3/3, exact compressed fixture restored");
}finally{restore();}
