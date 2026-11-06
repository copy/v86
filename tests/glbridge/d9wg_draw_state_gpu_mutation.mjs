#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const directory=root+'build/d3d-review/draw-state-gpu-mutations';fs.mkdirSync(directory,{recursive:true});
const html=fs.readFileSync(root+'tests/glbridge/d3d9_conformance_browser_test.html','utf8').replaceAll('src="../../src/','src="/src/').replace(/src="(d3d[^"/]+\.js)"/g,'src="/tests/glbridge/$1"');
for(const [name,file,group,before,after] of [
 ['collapsed-depth-span','d3d9_executor.js','viewport-minimum','maxZ = Math.max(maxZ, Math.fround(minZ + .001));','maxZ = Math.max(maxZ, minZ);'],
 ['nonindexed-uses-instance-count','d9wg_draw_recorder.js','stream-frequency','geometry.indexInfo ? this.drawInstanceCount(state) : 1','this.drawInstanceCount(state)'],
 ['zero-divisor-advances','d3d9_executor.js','stream-frequency','(divisor ? Math.floor(instance / divisor) : 0) * stride','Math.floor(instance / Math.max(1, divisor)) * stride'],
 ['zero-instance-count-draws-once','d3d9_executor.js','stream-frequency','return frequency & D3DSTREAMSOURCE_FREQUENCY_MASK;','return Math.max(1, frequency & D3DSTREAMSOURCE_FREQUENCY_MASK);'],
]) {
 const source=fs.readFileSync(root+'src/browser/glbridge/d3d9-webgpu/'+file,'utf8');assert.equal(source.split(before).length,2,name);
 fs.writeFileSync(directory+'/'+file,source.replace(before,after));
 fs.writeFileSync(directory+'/test.html',html.replace('src="/src/browser/glbridge/d3d9-webgpu/'+file+'"','src="/build/d3d-review/draw-state-gpu-mutations/'+file+'"'));
 const run=spawnSync(process.execPath,[root+'tests/glbridge/gl_multipass_browser_runner.js','../../build/d3d-review/draw-state-gpu-mutations/test.html?group='+group],{cwd:root,encoding:'utf8',timeout:120000});
 assert.equal(run.status,1,name+run.stderr);const result=JSON.parse(run.stdout);assert.equal(result.status,'FAIL');
 assert(result.details.includes('FAIL  '));assert(!/WebGPU |FAIL exception|host:/.test(result.details),result.details);
 fs.writeFileSync(directory+'/'+name+'.json',JSON.stringify(result,null,2)+'\n');
}
console.log('PASS draw state GPU mutations: 4/4 minimum depth span, non-indexed draw count, zero instance divisor and zero instance count detected by pixels without GPU errors');
