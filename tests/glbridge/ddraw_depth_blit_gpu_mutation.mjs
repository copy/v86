#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url)),directory=root+'build/d3d-review/depth-blit-gpu-mutations';fs.mkdirSync(directory,{recursive:true});
const file='d9wg_surface_ops.js',source=fs.readFileSync(root+'src/browser/glbridge/d3d9-webgpu/'+file,'utf8');
const html=fs.readFileSync(root+'tests/glbridge/ddraw_depth_blit_browser_test.html','utf8').replaceAll('src="../../src/','src="/src/').replace(/src="(d3d[^"/]+\.js)"/g,'src="/tests/glbridge/$1"');
const cases=[
 ['source-scale-ignored','(rect.right-rect.left) / width;','1;'],
 ['self-snapshot-not-populated','encoder.copyTextureToTexture({texture:source,mipLevel:level},{texture:snapshot},size);','(void 0);'],
 ['stencil-bits-not-written','pass.setStencilReference(clear?0:mask);','pass.setStencilReference(0);'],
 ['destination-offset-ignored','(position.xy - params.destination.xy) * params.source.zw','position.xy * params.source.zw'],
];
for(const [name,before,after] of cases){assert.equal(source.split(before).length,2,name);fs.writeFileSync(directory+'/'+file,source.replace(before,after));fs.writeFileSync(directory+'/test.html',html.replace('src="/src/browser/glbridge/d3d9-webgpu/'+file+'"','src="/build/d3d-review/depth-blit-gpu-mutations/'+file+'"'));
 const run=spawnSync(process.execPath,[root+'tests/glbridge/gl_multipass_browser_runner.js','../../build/d3d-review/depth-blit-gpu-mutations/test.html'],{cwd:root,encoding:'utf8',timeout:120000});assert.equal(run.status,1,name+run.stderr);const result=JSON.parse(run.stdout);assert.equal(result.status,'FAIL');assert.match(result.details,/FAIL Error: (?:depth|stencil) blit /);assert(result.details.includes('"errors":[],"host":[]'),result.details);fs.writeFileSync(directory+'/'+name+'.json',JSON.stringify(result,null,2)+'\n');}
console.log('PASS depth/stencil blit GPU mutations: 4/4 scaling, self snapshot, stencil writes and destination origin defects detected by pixels without GPU errors');
