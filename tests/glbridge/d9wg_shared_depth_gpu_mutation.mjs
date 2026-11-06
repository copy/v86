#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const directory=path.join(root,'build/d3d-review/shared-depth-gpu-mutations');fs.mkdirSync(directory,{recursive:true});
const html=fs.readFileSync(root+'tests/glbridge/d3d9_conformance_browser_test.html','utf8').replaceAll('src="../../src/','src="/src/').replace(/src="(d3d[^"/]+\.js)"/g,'src="/tests/glbridge/$1"');
for(const [name,file,before,after] of [
 ['clear-erases-depth-outside-small-target','d3d9_executor.js','const bounds = intersectRects(state.viewport, scissor, targets.width, targets.height);','const bounds = {x:0,y:0,width:targets.width,height:targets.height};'],
 ['large-viewport-depth-clear-clipped-to-target0','d3d9_executor.js','const bounds = intersectRects(state.viewport, scissor, targets.width, targets.height);','const base = this.renderTargetsFor(state, true); const bounds = intersectRects(state.viewport, scissor, Math.min(targets.width, base.width), Math.min(targets.height, base.height));'],
 ['all-samples-read-sample-zero','d9wg_surface_ops.js','vec2<i32>(position.xy), i32(sample)','vec2<i32>(position.xy), 0'],
 ['color-is-not-restored','d9wg_surface_ops.js','if (!targets || !targets.promotedColors) return;','if (targets || !targets) return;'],
 ['old-color-is-not-loaded','d9wg_surface_ops.js','if (!targets.promotedColors) return;','if (targets.promotedColors || !targets.promotedColors) return;'],
 ['cube-face-lost','d9wg_surface_ops.js','z: original.face || 0','z: 0'],
]) {
 const source=fs.readFileSync(root+'src/browser/glbridge/d3d9-webgpu/'+file,'utf8');assert.equal(source.split(before).length,2);
 fs.writeFileSync(directory+'/'+file,source.replace(before,after));
 fs.writeFileSync(directory+'/test.html',html.replace('src="/src/browser/glbridge/d3d9-webgpu/'+file+'"','src="/build/d3d-review/shared-depth-gpu-mutations/'+file+'"'));
 const r=spawnSync(process.execPath,[root+'tests/glbridge/gl_multipass_browser_runner.js','../../build/d3d-review/shared-depth-gpu-mutations/test.html?group=shared-depth'],{cwd:root,encoding:'utf8',timeout:120000});
 assert.equal(r.status,1,name+': '+r.stderr);const result=JSON.parse(r.stdout);assert.equal(result.status,'FAIL');
 assert(result.details.includes('FAIL  '));assert(!/WebGPU |FAIL exception|host:/.test(result.details),result.details);
 fs.writeFileSync(directory+'/'+name+'.json',JSON.stringify(result,null,2)+'\n');
}
console.log('PASS shared depth GPU mutations: 6/6 viewport clear bounds, per-sample loss, missing color load/store and wrong cube face rejected by pixel readbacks without GPU validation errors');
