#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const directory=root+'build/d3d-review/depth-lock-gpu-mutations';fs.mkdirSync(directory,{recursive:true});
const html=fs.readFileSync(root+'tests/glbridge/d3d9_depth_lock_browser_test.html','utf8').replaceAll('src="../../src/','src="/src/').replace(/src="(d3d[^"/]+\.js)"/g,'src="/tests/glbridge/$1"');
const cases=[
 ['readback-ignores-first-row','d9wg_surface_ops.js','[0,firstRow,0,0]','[0,0,0,0]'],
 ['readback-fakes-full-depth','d9wg_formats.js','unorm(r,65535)','65535'],
 ['upload-discards-source-pitch','d9wg_surface_ops.js','row*rowPitch+col*2','row*width*2+col*2'],
 ['upload-does-not-write-depth','d9wg_surface_ops.js','depthWriteEnabled:true,depthCompare:"always",stencilWriteMask:0','depthWriteEnabled:false,depthCompare:"always",stencilWriteMask:0'],
];
for(const [name,file,before,after] of cases){
 const source=fs.readFileSync(root+'src/browser/glbridge/d3d9-webgpu/'+file,'utf8');assert.equal(source.split(before).length,2);
 fs.writeFileSync(directory+'/'+file,source.replace(before,after));
 fs.writeFileSync(directory+'/test.html',html.replace('src="/src/browser/glbridge/d3d9-webgpu/'+file+'"','src="/build/d3d-review/depth-lock-gpu-mutations/'+file+'"'));
 const run=spawnSync(process.execPath,[root+'tests/glbridge/gl_multipass_browser_runner.js','../../build/d3d-review/depth-lock-gpu-mutations/test.html'],{cwd:root,encoding:'utf8',timeout:120000});
 assert.equal(run.status,1,name+run.stderr);const result=JSON.parse(run.stdout);
 assert.equal(result.status,'FAIL');assert.match(result.details,/FAIL Error: depth \d+,\d+/);
 assert(result.details.includes('"errors":[],"host":[]'),result.details);
 fs.writeFileSync(directory+'/'+name+'.json',JSON.stringify(result,null,2)+'\n');
}
console.log('PASS depth lock GPU mutations: 4/4 sliced reads, real depth values, padded upload pitch and actual GPU depth writes');
