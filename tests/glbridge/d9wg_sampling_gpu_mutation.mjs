#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const directory=root+'build/d3d-review/sampling-gpu-mutations';fs.mkdirSync(directory,{recursive:true});
fs.copyFileSync(root+'src/browser/glbridge/d3d9-webgpu/d3d9_shader_worker.js',directory+'/d3d9_shader_worker.js');
const html=fs.readFileSync(root+'tests/glbridge/d3d9_conformance_browser_test.html','utf8').replaceAll('src="../../src/','src="/src/').replace(/src="(d3d[^"/]+\.js)"/g,'src="/tests/glbridge/$1"');
for(const [name,file,group,before,after] of [
 ['disable-fetch4','d9wg_formats.js','fetch4','function fetch4Channel(format) {','function fetch4Channel(format) { return -1;'],
 ['wrong-gather-order','d3d9_shader_pipeline.js','fetch4','shifted + ").zxyw"','shifted + ").xyzw"'],
 ['wrong-shadow-reference','d9wg_ffp.js','shadow-ffp','let shadowReference = coord + ".z";','let shadowReference = "0.0";'],
 ['white-unbound-sampler','d3d9_executor.js','shader-legacy-sampling','unfilterable, !!programmable && !depth);','unfilterable, false);'],
 ['gl-sphere-pole','d9wg_ffp.js','sphere-map','(r.z - 1.0) * (r.z - 1.0)','(r.z + 1.0) * (r.z + 1.0)'],
 ['forced-normal-length','d9wg_ffp.js','sphere-map','reflect(normalize(position_view.xyz), normal_view)))','reflect(normalize(position_view.xyz), normalize(normal_view))))'],
]) {
 const source=fs.readFileSync(root+'src/browser/glbridge/d3d9-webgpu/'+file,'utf8');assert.equal(source.split(before).length,2,name);
 fs.writeFileSync(directory+'/'+file,source.replace(before,after));
 let page=html.replace('src="/src/browser/glbridge/d3d9-webgpu/'+file+'"','src="/build/d3d-review/sampling-gpu-mutations/'+file+'"');
 if(file==='d3d9_shader_pipeline.js')page=page.replace('shaderWorkerUrl: null','shaderWorkerUrl: "/build/d3d-review/sampling-gpu-mutations/d3d9_shader_worker.js"');
 fs.writeFileSync(directory+'/test.html',page);
 const run=spawnSync(process.execPath,[root+'tests/glbridge/gl_multipass_browser_runner.js','../../build/d3d-review/sampling-gpu-mutations/test.html?group='+group],{cwd:root,encoding:'utf8',timeout:180000});
 assert.equal(run.status,1,name+run.stderr);const result=JSON.parse(run.stdout);assert.equal(result.status,'FAIL');
 assert(result.details.includes('FAIL  '));assert(!/WebGPU |FAIL exception|host:/.test(result.details),result.details);
 fs.writeFileSync(directory+'/'+name+'.json',JSON.stringify(result,null,2)+'\n');
}
console.log('PASS sampling GPU mutations: 6/6 disabled Fetch4, gather order, shadow reference, unbound sampler and sphere projection defects detected by pixels without GPU errors');
