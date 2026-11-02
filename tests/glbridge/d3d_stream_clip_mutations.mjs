#!/usr/bin/env node
// Exclusive GPU mutations. Restore the exact frozen fixture and production
// executor on success, failure and signals; do not run other tests/builds here.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gzipSync as gzip_sync, gunzipSync as gunzip_sync } from "node:zlib";
import { createHash as create_hash } from "node:crypto";
import { createRequire as create_require } from "node:module";
import { spawnSync as spawn } from "node:child_process";
import { fileURLToPath as file_url_to_path } from "node:url";
const root=file_url_to_path(new URL("../../",import.meta.url)),require=create_require(import.meta.url);
const P=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"),W=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
const fixture=root+"tests/glbridge/fixtures/d3d9_processed_stream_clip_xp.bin.gz",executor=root+"src/browser/glbridge/d3d9-webgpu/d3d9_executor.js";
const compressed=fs.readFileSync(fixture),original=gunzip_sync(compressed),source=fs.readFileSync(executor,"utf8"),hash=data=>create_hash("sha256").update(data).digest("hex");
const out=path.resolve(process.env.D9WG_STREAM_CLIP_MUTATION_OUT||root+"build/d3d-review/stage4d2i3d");fs.mkdirSync(out,{recursive:true});
const restore=()=>{if(!fs.readFileSync(fixture).equals(compressed))fs.writeFileSync(fixture,compressed);if(fs.readFileSync(executor,"utf8")!==source)fs.writeFileSync(executor,source);};
process.once("exit",restore);for(const signal of ["SIGINT","SIGTERM"])process.once(signal,()=>{restore();process.exit(130);});
function run(page){const result=spawn(process.execPath,[root+"tests/glbridge/gl_multipass_browser_runner.js",page],{cwd:root,env:{...process.env,GL_SWIFTSHADER:"1"},encoding:"utf8",timeout:120000,maxBuffer:8<<20});const line=result.stdout.split(/\r?\n/).find(l=>l.startsWith('{"status"'));assert(line,result.stderr.slice(-1200)||"GPU runner did not report");return JSON.parse(line);}
const results=[];
try{
 for(const mode of ["restore","texture-offset","colour-offset"]){const bytes=Buffer.from(original);let changed=0,pending=false;
  for(let carrier=0;carrier<bytes.length;){const size=bytes.readUInt32LE(carrier+8),packet=bytes.subarray(carrier+20,carrier+12+size),header=W.readHeader(packet);W.checkStream(header.view,header.end,header.commandCount);
   for(let at=P.STRUCTS.BatchHeader.size;at<header.end;){const opcode=header.view.getUint16(at,true),length=header.view.getUint32(at+P.F.CommandHeader.size,true),payload=at+P.STRUCTS.CommandHeader.size;
    const value=P.decode(P.commandStruct(opcode),header.view,payload,length-P.STRUCTS.CommandHeader.size);
    if(opcode===P.OP.SET_FVF&&value.fvf===0){pending=true;
     if(mode!=="restore"){const index=mode==="texture-offset"?2:1,offset=payload+P.STRUCTS.SetFVF.size+index*8+P.F.VertexElement.offset;assert.equal(header.view.getUint16(offset,true),index===2?32:16);header.view.setUint16(offset,20,true);changed++;}
    }
    if(pending&&opcode===P.OP.SET_VERTEX_DECLARATION){if(mode==="restore"){assert(value.declaration_handle>0);header.view.setUint32(payload+P.F.SetVertexDeclaration.declaration_handle,0,true);changed++;}pending=false;}
    at+=length;
   }
   carrier+=12+size;
  }
  assert.equal(changed,3);fs.writeFileSync(fixture,gzip_sync(bytes));try{const result=run("d3d_stream_clip_replay_browser_test.html");assert.equal(result.status,"FAIL","survived: "+mode);assert.match(result.details,/XP multi-stream clipped draw mismatch/);results.push({label:mode,killed:true,mutatedTraceSha256:hash(bytes)});}finally{restore();}
 }
 const before="const clipPlaneCount = pretransformed ? 0 : state.clipPlaneCapacity || 0;";assert.equal(source.split(before).length,2);
 fs.writeFileSync(executor,source.replace(before,"const clipPlaneCount = state.clipPlaneCapacity || 0;"));try{const result=run("d3d9_conformance_browser_test.html");assert.equal(result.status,"FAIL","POSITIONT plane regression survived");assert.match(result.details,/POSITIONT bypasses enabled user clipping planes/);results.push({label:"POSITIONT applies user planes again",killed:true});}finally{restore();}
 assert(fs.readFileSync(fixture).equals(compressed));assert.equal(fs.readFileSync(executor,"utf8"),source);
 fs.writeFileSync(out+"/gpu-mutations.json",JSON.stringify({fixtureSha256:hash(compressed),executorSha256:hash(source),mutations:results},null,2)+"\n");
 console.log("PASS multi-stream clipping GPU mutations: 4/4, exact fixture and executor restored");
}finally{restore();}
