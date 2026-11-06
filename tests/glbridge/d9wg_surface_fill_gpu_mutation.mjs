#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const directory=root+'build/d3d-review/surface-fill-gpu-mutations';fs.mkdirSync(directory,{recursive:true});
fs.copyFileSync(root+'src/browser/glbridge/d3d9-webgpu/d3d9_shader_worker.js',directory+'/d3d9_shader_worker.js');
const html=fs.readFileSync(root+'tests/glbridge/d3d9_conformance_browser_test.html','utf8').replaceAll('src="../../src/','src="/src/').replace(/src="(d3d[^"/]+\.js)"/g,'src="/tests/glbridge/$1"');
for(const [name,file,group,before,after] of [
 ['ignore-implicit-backbuffer','d3d9_executor.js','surface-fill','const resource = handle ? this.resources.get(handle) : state && {','const resource = handle ? this.resources.get(handle) : null && {'],
 ['wrong-g16-unused-channel','d3d9_executor.js','surface-fill','rgba[2] = 1; rgba[3] = 1;','rgba[2] = 0; rgba[3] = 1;'],
]) {
 const source=fs.readFileSync(root+'src/browser/glbridge/d3d9-webgpu/'+file,'utf8');assert.equal(source.split(before).length,2,name);
 fs.writeFileSync(directory+'/'+file,source.replace(before,after));
 let page=html.replace('src="/src/browser/glbridge/d3d9-webgpu/'+file+'"','src="/build/d3d-review/surface-fill-gpu-mutations/'+file+'"');
 if(file==='d3d9_shader_pipeline.js')page=page.replace('shaderWorkerUrl: null','shaderWorkerUrl: "/build/d3d-review/surface-fill-gpu-mutations/d3d9_shader_worker.js"');
 fs.writeFileSync(directory+'/test.html',page);
 const run=spawnSync(process.execPath,[root+'tests/glbridge/gl_multipass_browser_runner.js','../../build/d3d-review/surface-fill-gpu-mutations/test.html?group='+group],{cwd:root,encoding:'utf8',timeout:180000});
 assert.equal(run.status,1,name+run.stderr);const result=JSON.parse(run.stdout);assert.equal(result.status,'FAIL');
 assert(result.details.includes('FAIL  '));assert(!/WebGPU |FAIL exception|host:/.test(result.details),result.details);
 fs.writeFileSync(directory+'/'+name+'.json',JSON.stringify(result,null,2)+'\n');
}
console.log('PASS surface-fill GPU mutations: 2/2 implicit backbuffer and G16 unused-channel defects detected by pixels without GPU errors');
