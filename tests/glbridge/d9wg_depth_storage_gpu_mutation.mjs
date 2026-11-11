#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const directory=root+'build/d3d-review/depth-storage-gpu-mutations';fs.mkdirSync(directory,{recursive:true});
fs.copyFileSync(root+'src/browser/glbridge/d3d9-webgpu/d3d9_shader_worker.js',directory+'/d3d9_shader_worker.js');
const html=fs.readFileSync(root+'tests/glbridge/d3d9_conformance_browser_test.html','utf8').replaceAll('src="../../src/','src="/src/').replace(/src="(d3d[^"/]+\.js)"/g,'src="/tests/glbridge/$1"');
for(const [name,file,group,before,after] of [
 ['missing-format-storage','d9wg_resources.js','sampled-depth-storage','|| [70,71,73,75,77,79,80].includes(format)','|| false'],
 ['wrong-16-bit-depth','d9wg_surface_ops.js','sampled-depth-storage',': sixteen ? packed/65535',': sixteen ? 1.0-packed/65535'],
 ['wrong-packed-depth-channel','d9wg_surface_ops.js','sampled-depth-storage',': (packed>>>8)/16777215',': (packed&255)/16777215'],
 ['bump-writes-result-register','d9wg_ffp.js','bump-registers','stage.colorOp === D3DTOP_BUMPENVMAPLUMINANCE) continue;','stage.colorOp === D3DTOP_BUMPENVMAPLUMINANCE) {}'],
]) {
 const source=fs.readFileSync(root+'src/browser/glbridge/d3d9-webgpu/'+file,'utf8');assert.equal(source.split(before).length,2,name);
 fs.writeFileSync(directory+'/'+file,source.replace(before,after));
 let page=html.replace('src="/src/browser/glbridge/d3d9-webgpu/'+file+'"','src="/build/d3d-review/depth-storage-gpu-mutations/'+file+'"');
 if(file==='d3d9_shader_pipeline.js')page=page.replace('shaderWorkerUrl: null','shaderWorkerUrl: "/build/d3d-review/depth-storage-gpu-mutations/d3d9_shader_worker.js"');
 fs.writeFileSync(directory+'/test.html',page);
 const run=spawnSync(process.execPath,[root+'tests/glbridge/gl_multipass_browser_runner.js','../../build/d3d-review/depth-storage-gpu-mutations/test.html?group='+group],{cwd:root,encoding:'utf8',timeout:180000});
 assert.equal(run.status,1,name+run.stderr);const result=JSON.parse(run.stdout);assert.equal(result.status,'FAIL');
 assert(result.details.includes('FAIL  '));assert(!/WebGPU |FAIL exception|host:/.test(result.details),result.details);
 fs.writeFileSync(directory+'/'+name+'.json',JSON.stringify(result,null,2)+'\n');
}
console.log('PASS resource consistency GPU mutations: 4/4 missing depth storage, inverted UNORM16, packed channel and bump register writes detected by pixels without GPU errors');
