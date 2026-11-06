#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const directory=path.join(root,'build/d3d-review/viewport-gpu-mutations');fs.mkdirSync(directory,{recursive:true});
const html=fs.readFileSync(root+'tests/glbridge/d3d9_conformance_browser_test.html','utf8').replaceAll('src="../../src/','src="/src/').replace(/src="(d3d[^"/]+\.js)"/g,'src="/tests/glbridge/$1"');
for(const [name,file,before,after] of [
 ['fixed-endpoints-clamped','d9wg_ffp.js','const range = signature.viewportDepthRange;','const range = signature.viewportDepthRange?.map(x=>Math.min(1,Math.max(0,x)));'],
 ['shader-endpoints-clamped','d3d9_shader_pipeline.js','const viewportDepthRange = this.options.viewportDepthRange;','const viewportDepthRange = this.options.viewportDepthRange?.map(x=>Math.min(1,Math.max(0,x)));'],
]) {
 const source=fs.readFileSync(root+'src/browser/glbridge/d3d9-webgpu/'+file,'utf8');assert.equal(source.split(before).length,2);
 fs.writeFileSync(directory+'/'+file,source.replace(before,after));
 fs.writeFileSync(directory+'/test.html',html.replace('src="/src/browser/glbridge/d3d9-webgpu/'+file+'"','src="/build/d3d-review/viewport-gpu-mutations/'+file+'"'));
 const r=spawnSync(process.execPath,[root+'tests/glbridge/gl_multipass_browser_runner.js','../../build/d3d-review/viewport-gpu-mutations/test.html?group=viewport-range'],{cwd:root,encoding:'utf8',timeout:120000});
 assert.equal(r.status,1,name+': '+r.stderr);const result=JSON.parse(r.stdout);assert.equal(result.status,'FAIL');
 assert(result.details.includes('FAIL  '));assert(!/WebGPU |FAIL exception|host:/.test(result.details),result.details);
 fs.writeFileSync(directory+'/'+name+'.json',JSON.stringify(result,null,2)+'\n');
}
console.log('PASS viewport GPU mutations: 2/2 endpoint-clamp faults rejected by independent pixel readbacks, with no GPU validation error');
