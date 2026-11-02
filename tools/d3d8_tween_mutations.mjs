#!/usr/bin/env node
// Mutate only the frozen replay input; restore exact original bytes in finally.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync as gunzip_sync, gzipSync as gzip_sync } from "node:zlib";
import { createHash as create_hash } from "node:crypto";
import { createRequire as create_require } from "node:module";
import { spawnSync as spawn_sync } from "node:child_process";
const require=create_require(import.meta.url),P=require("../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"),W=require("../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
const fixture=new URL("../tests/glbridge/fixtures/d3d8_tween_xp.bin.gz",import.meta.url),original=fs.readFileSync(fixture),input=gunzip_sync(original),out=path.resolve(process.env.D8WG_TWEEN_MUTATIONS_OUT||"build/d3d-review/stage4d2k3d-mutations"),results=[];
fs.mkdirSync(out,{recursive:true});
const hash=b=>create_hash("sha256").update(b).digest("hex");
const cases=[
 {name:"tween-factor",command:"SET_RENDER_STATE",frame:0,match:v=>v.state===170,field:"value",value:0},
 {name:"primary-constant",command:"SET_STREAM_SOURCE",frame:0,match:v=>v.stream===15,field:"stride",value:0},
 {name:"indexed-base",command:"DRAW_INDEXED_PRIMITIVE",frame:2,match:()=>true,field:"base_vertex_index",value:0},
 {name:"user-plane",command:"SET_RENDER_STATE",frame:10,match:v=>v.state===152,field:"value",value:0},
 {name:"normalization",command:"SET_RENDER_STATE",frame:12,match:v=>v.state===143,field:"value",value:0},
];
try{for(const mutation of cases){const bytes=Buffer.from(input);let frame=0,changed=0;
 for(let at=0;at<bytes.length;){const size=bytes.readUInt32LE(at+8),packet=bytes.subarray(at+20,at+12+size),h=W.readHeader(packet);
  for(let x=P.STRUCTS.BatchHeader.size;x<h.end;){const op=h.view.getUint16(x,true),length=h.view.getUint32(x+P.F.CommandHeader.size,true),payload=x+P.STRUCTS.CommandHeader.size,name=P.OP_NAME[op],v=P.decode(P.commandStruct(op),h.view,payload,length-P.STRUCTS.CommandHeader.size);
   if(frame===mutation.frame&&name===mutation.command&&mutation.match(v)){assert.notEqual(v[mutation.field],mutation.value);packet.writeUInt32LE(mutation.value,payload+P.F[P.commandStruct(op)][mutation.field]);changed++;}
   if(name==="PRESENT")frame++;x+=length;
  }at+=12+size;
 }
 assert.equal(changed,1,mutation.name);fs.writeFileSync(fixture,gzip_sync(bytes));const run=spawn_sync(process.execPath,["tests/glbridge/gl_multipass_browser_runner.js","d3d8_tween_replay_browser_test.html"],{encoding:"utf8",env:{...process.env,GL_SWIFTSHADER:"1"},timeout:120000});assert.notEqual(run.status,0,"survived "+mutation.name);assert.match(run.stdout,/"status":"FAIL"/,mutation.name+" requires browser pixel failure");const evidence=JSON.parse(fs.readFileSync("build/browser-test-output/d8wg-tween-guest.json"));assert.equal(evidence.gpuErrors.length,0);assert.equal(evidence.hostErrors.length,0);assert.equal(evidence.stats.commandsFailed,0);assert.equal(evidence.stats.droppedDraws,0);assert(evidence.comparisons.some(c=>c.differingPixels||c.coveredPixels<32||c.probe.maximumByteError>1));fs.writeFileSync(out+"/"+mutation.name+".json",JSON.stringify(evidence,null,2)+"\n");results.push({name:mutation.name,killed:true});console.log("PASS killed D3D8 Tween replay mutant: "+mutation.name);
 }
}finally{fs.writeFileSync(fixture,original);assert.equal(hash(fs.readFileSync(fixture)),hash(original));}
fs.writeFileSync(out+"/result.json",JSON.stringify({killed:results.length,total:cases.length,restoredFixtureSha256:hash(original),results},null,2)+"\n");console.log("PASS D3D8 Tween GPU mutations: 5/5; factor, primary stride, indexed base, user plane and normal normalization");
