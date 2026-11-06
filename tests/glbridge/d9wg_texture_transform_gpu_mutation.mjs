#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const directory=root+'build/d3d-review/texture-transform-gpu-mutations';fs.mkdirSync(directory,{recursive:true});
fs.copyFileSync(root+'src/browser/glbridge/d3d9-webgpu/d3d9_shader_worker.js',directory+'/d3d9_shader_worker.js');
const html=fs.readFileSync(root+'tests/glbridge/d3d9_conformance_browser_test.html','utf8').replaceAll('src="../../src/','src="/src/').replace(/src="(d3d[^"/]+\.js)"/g,'src="/tests/glbridge/$1"');
for(const [name,file,group,before,after] of [
 ['missing-projection-w','d9wg_ffp.js','texture-transform-flags','if (stage.projected && count < 4)','if (false && stage.projected && count < 4)'],
 ['wrong-unused-components','d9wg_ffp.js','texture-transform-flags','Array(4 - count).fill("0.0")','Array(4 - count).fill("1.0")'],
 ['transform-invalid-flags','d3d9_executor.js','texture-transform-flags','? flags & ~D3DTTFF_PROJECTED : 0','? flags & ~D3DTTFF_PROJECTED : 4'],
 ['ignore-vs-projection','d3d9_executor.js','texture-transform-flags','stage.transformCount = 0;','stage.transformCount = 0;stage.projected = false;'],
 ['zero-normalized-w','d3d9_shader_pipeline.js','shader-normalize','this.store(dest, "d9_normalize(" + s(0) + ")");','this.store(dest, "vec4<f32>(d9_normalize(" + s(0) + ").xyz, 0.0)");'],
]) {
 const source=fs.readFileSync(root+'src/browser/glbridge/d3d9-webgpu/'+file,'utf8');assert.equal(source.split(before).length,2,name);
 fs.writeFileSync(directory+'/'+file,source.replace(before,after));
 let page=html.replace('src="/src/browser/glbridge/d3d9-webgpu/'+file+'"','src="/build/d3d-review/texture-transform-gpu-mutations/'+file+'"');
 if(file==='d3d9_shader_pipeline.js')page=page.replace('shaderWorkerUrl: null','shaderWorkerUrl: "/build/d3d-review/texture-transform-gpu-mutations/d3d9_shader_worker.js"');
 fs.writeFileSync(directory+'/test.html',page);
 const run=spawnSync(process.execPath,[root+'tests/glbridge/gl_multipass_browser_runner.js','../../build/d3d-review/texture-transform-gpu-mutations/test.html?group='+group],{cwd:root,encoding:'utf8',timeout:180000});
 assert.equal(run.status,1,name+run.stderr);const result=JSON.parse(run.stdout);assert.equal(result.status,'FAIL');
 assert(result.details.includes('FAIL  '));assert(!/WebGPU |FAIL exception|host:/.test(result.details),result.details);
 fs.writeFileSync(directory+'/'+name+'.json',JSON.stringify(result,null,2)+'\n');
}
console.log('PASS texture transform/NRM GPU mutations: 5/5 projection W, unused components, invalid transform flags, VS projection and normalized W defects detected by pixels without GPU errors');
