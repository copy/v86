#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const directory=root+'build/d3d-review/software-constants-gpu-mutations';fs.mkdirSync(directory,{recursive:true});
const html=fs.readFileSync(root+'tests/glbridge/d3d9_conformance_browser_test.html','utf8').replaceAll('src="../../src/','src="/src/').replace(/src="(d3d[^"/]+\.js)"/g,'src="/tests/glbridge/$1"');
for(const [name,file,before,after] of [
 ['truncate-software-floats','d3d9_executor.js','state.vsConstF = new Float32Array(8192 * 4);','state.vsConstF = new Float32Array(256 * 4);'],
 ['truncate-software-integers','d3d9_executor.js','state.vsConstI = new Int32Array(2048 * 4);','state.vsConstI = new Int32Array(16 * 4);'],
 ['truncate-software-booleans','d3d9_executor.js','state.vsConstB = new Uint32Array(2048);','state.vsConstB = new Uint32Array(16);'],
 ['clamp-software-relative-to-hardware','d3d9_shader_pipeline.js','(this.constantCapacity() - 1) + ";"','Math.min(255, this.constantCapacity() - 1) + ";"'],
]) {
 const source=fs.readFileSync(root+'src/browser/glbridge/d3d9-webgpu/'+file,'utf8');assert.equal(source.split(before).length,2,name);
 fs.writeFileSync(directory+'/'+file,source.replace(before,after));
 fs.writeFileSync(directory+'/test.html',html.replace('src="/src/browser/glbridge/d3d9-webgpu/'+file+'"','src="/build/d3d-review/software-constants-gpu-mutations/'+file+'"'));
 const run=spawnSync(process.execPath,[root+'tests/glbridge/gl_multipass_browser_runner.js','../../build/d3d-review/software-constants-gpu-mutations/test.html?group=software-constants'],{cwd:root,encoding:'utf8',timeout:120000});
 assert.equal(run.status,1,name+run.stderr);const result=JSON.parse(run.stdout);assert.equal(result.status,'FAIL');
 assert(result.details.includes('FAIL  '));assert(!/WebGPU |FAIL exception|host:/.test(result.details),result.details);
 fs.writeFileSync(directory+'/'+name+'.json',JSON.stringify(result,null,2)+'\n');
}
console.log('PASS software constants GPU mutations: 4/4 float/integer/Boolean bank truncation and relative address clamp detected by pixels without GPU errors');
