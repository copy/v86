#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
const root=fileURLToPath(new URL("../../",import.meta.url)),directory=path.join(root,"build/d3d-review/stage4f2c-gpu-mutations");fs.mkdirSync(directory,{recursive:true});
const html=fs.readFileSync(root+"tests/glbridge/d3d9_conformance_browser_test.html","utf8").replaceAll('src="../../src/','src="/src/').replace(/src="(d3d[^"/]+\.js)"/g,'src="/tests/glbridge/$1"'),results=[];
for(const [name,file,before,after,failure]of [
 ["point-filter-ignored","d9wg_surface_ops.js","filterPoint: op.filterType === 1","filterPoint: false","2D filter 1"],
 ["GPU-write-stale-mips","d3d9_executor.js","this.markTextureSubresourceWritten(resource, level, face);\n            resource.frameReferenced = frame.serial;","resource.frameReferenced = frame.serial;","autogen observes GPU writes to level zero"],
]){
 const source=fs.readFileSync(root+"src/browser/glbridge/d3d9-webgpu/"+file,"utf8");assert.equal(source.split(before).length,2);fs.writeFileSync(directory+"/"+file,source.replace(before,after));
 fs.writeFileSync(directory+"/test.html",html.replace('src="/src/browser/glbridge/d3d9-webgpu/'+file+'"','src="/build/d3d-review/stage4f2c-gpu-mutations/'+file+'"'));
 const run=spawnSync(process.execPath,[root+"tests/glbridge/gl_multipass_browser_runner.js","../../build/d3d-review/stage4f2c-gpu-mutations/test.html?group=autogen"],{cwd:root,env:{...process.env,GL_SWIFTSHADER:"1"},encoding:"utf8",timeout:120000});assert.equal(run.status,1,"GPU mutant survived: "+name+": "+run.stderr);
 const result=JSON.parse(run.stdout);assert.equal(result.status,"FAIL");assert(result.details.includes("FAIL  ")&&result.details.includes(failure));assert(!/WebGPU |FAIL exception|host:/.test(result.details),"independent pixel mismatches must kill the mutant");fs.writeFileSync(directory+"/"+name+".json",JSON.stringify(result,null,2)+"\n");results.push({name,killed:true,result});
}
fs.writeFileSync(directory+"/result.json",JSON.stringify({status:"PASS",killed:2,total:2,results},null,2)+"\n");console.log("PASS real GPU automatic mip mutations: 2/2 ignored POINT filter and stale GPU-write chain produce independent pixel failures");
