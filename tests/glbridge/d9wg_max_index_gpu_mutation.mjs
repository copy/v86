#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const directory=path.join(root,'build/d3d-review/max-index-gpu-mutations');fs.mkdirSync(directory,{recursive:true});
const html=fs.readFileSync(root+'tests/glbridge/d3d9_conformance_browser_test.html','utf8').replaceAll('src="../../src/','src="/src/').replace(/src="(d3d[^"/]+\.js)"/g,'src="/tests/glbridge/$1"');
for(const [name,file,before,after] of [
 ['bound-max-index-lost','d9wg_resources.js','const widened = new Uint32Array(indices);','const widened = Uint32Array.from(indices, n => n === 65535 ? 0 : n);'],
 ['up-max-index-lost','d3d9_executor.js','widened[i] = view.getUint16(indexDataOffset + i * 2, true);','widened[i] = view.getUint16(indexDataOffset + i * 2, true) % 65535;'],
 ['cached-update-stale','d9wg_resources.js','if (resource.stripIndexBuffer) {','if (false && resource.stripIndexBuffer) {'],
]) {
 const source=fs.readFileSync(root+'src/browser/glbridge/d3d9-webgpu/'+file,'utf8');assert.equal(source.split(before).length,2);
 fs.writeFileSync(directory+'/'+file,source.replace(before,after));
 fs.writeFileSync(directory+'/test.html',html.replace('src="/src/browser/glbridge/d3d9-webgpu/'+file+'"','src="/build/d3d-review/max-index-gpu-mutations/'+file+'"'));
 const r=spawnSync(process.execPath,[root+'tests/glbridge/gl_multipass_browser_runner.js','../../build/d3d-review/max-index-gpu-mutations/test.html?group=max-index'],{cwd:root,encoding:'utf8',timeout:120000});
 assert.equal(r.status,1,name+': '+r.stderr);const result=JSON.parse(r.stdout);assert.equal(result.status,'FAIL');
 assert(result.details.includes('FAIL  '));assert(!/WebGPU |FAIL exception|host:/.test(result.details),result.details);
 fs.writeFileSync(directory+'/'+name+'.json',JSON.stringify(result,null,2)+'\n');
}
console.log('PASS max index GPU mutations: 3/3 bound/UP index loss and stale partial updates rejected by pixel readbacks without GPU validation errors');
