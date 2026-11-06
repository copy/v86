#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const directory=path.join(root,'build/d3d-review/legacy-raster-gpu-mutations');fs.mkdirSync(directory,{recursive:true});
const html=fs.readFileSync(root+'tests/glbridge/d3d9_conformance_browser_test.html','utf8').replaceAll('src="../../src/','src="/src/').replace(/src="(d3d[^"/]+\.js)"/g,'src="/tests/glbridge/$1"');
for(const [name,file,before,after] of [
 ['screen-clip-retained','d3d9_executor.js','const screenDepthUnclipped = pretransformed && !pipelineState.depthEnabled;','const screenDepthUnclipped = false;'],
 ['fog-reads-zero-depth','d9wg_ffp.js','".y * stage_in.position.w" : "stage_in.position.z")','".y * 0.0" : "stage_in.position.z")'],
 ['vertex-equal-range-step','d9wg_ffp.js','[D3DFOG_LINEAR]: vertex ?','[D3DFOG_LINEAR]: false ?'],
 ['normal-drops-projective-terms','d3d9_executor.js','if (m[3] || m[7] || m[11] || m[15] !== 1) {','if (false && (m[3] || m[7] || m[11] || m[15] !== 1)) {'],
]) {
 const source=fs.readFileSync(root+'src/browser/glbridge/d3d9-webgpu/'+file,'utf8');assert.equal(source.split(before).length,2);
 fs.writeFileSync(directory+'/'+file,source.replace(before,after));
 fs.writeFileSync(directory+'/test.html',html.replace('src="/src/browser/glbridge/d3d9-webgpu/'+file+'"','src="/build/d3d-review/legacy-raster-gpu-mutations/'+file+'"'));
 const r=spawnSync(process.execPath,[root+'tests/glbridge/gl_multipass_browser_runner.js','../../build/d3d-review/legacy-raster-gpu-mutations/test.html?group=legacy-raster'],{cwd:root,encoding:'utf8',timeout:120000});
 assert.equal(r.status,1,name+': '+r.stderr);const result=JSON.parse(r.stdout);assert.equal(result.status,'FAIL');
 assert(result.details.includes('FAIL  '));assert(!/WebGPU |FAIL exception|host:/.test(result.details),result.details);
 fs.writeFileSync(directory+'/'+name+'.json',JSON.stringify(result,null,2)+'\n');
}
console.log('PASS legacy raster GPU mutations: 4/4 clipping, fog-depth, degenerate fog and normal-transform faults rejected by pixel readbacks without GPU validation errors');
