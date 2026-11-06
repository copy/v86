#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const directory=root+'build/d3d-review/transformed-semantics-gpu-mutations';fs.mkdirSync(directory,{recursive:true});
const html=fs.readFileSync(root+'tests/glbridge/d3d9_conformance_browser_test.html','utf8').replaceAll('src="../../src/','src="/src/').replace(/src="(d3d[^"/]+\.js)"/g,'src="/tests/glbridge/$1"');
for(const [name,file,before,after] of [
 ['missing-semantic','d9wg_ffp.js','input ? "in"+input.location','input && write.usage !== 12 ? "in"+input.location'],
 ['lost-component-mask','d9wg_ffp.js','"xyzw"[write.component]','"xyzw"[0]'],
 ['lost-packed-color-conversion','d3d9_executor.js','if (conversion && binding && (binding.bufferHandle || binding.userPointer))','if (conversion && conversion !== "color" && binding && (binding.bufferHandle || binding.userPointer))'],
 ['lost-point-semantic','d9wg_ffp.js','if (write.usage !== DECLUSAGE_TEXCOORD) continue;','if (write.usage !== DECLUSAGE_TEXCOORD || write.usageIndex) continue;'],
]) {
 const source=fs.readFileSync(root+'src/browser/glbridge/d3d9-webgpu/'+file,'utf8');assert.equal(source.split(before).length,2,name);
 fs.writeFileSync(directory+'/'+file,source.replace(before,after));
 fs.writeFileSync(directory+'/test.html',html.replace('src="/src/browser/glbridge/d3d9-webgpu/'+file+'"','src="/build/d3d-review/transformed-semantics-gpu-mutations/'+file+'"'));
 const run=spawnSync(process.execPath,[root+'tests/glbridge/gl_multipass_browser_runner.js','../../build/d3d-review/transformed-semantics-gpu-mutations/test.html?group=transformed-semantics'],{cwd:root,encoding:'utf8',timeout:120000});
 assert.equal(run.status,1,name+run.stderr);const result=JSON.parse(run.stdout);assert.equal(result.status,'FAIL');
 assert(result.details.includes('FAIL  '));assert(!/WebGPU |FAIL exception|host:/.test(result.details),result.details);
 fs.writeFileSync(directory+'/'+name+'.json',JSON.stringify(result,null,2)+'\n');
}
console.log('PASS transformed semantic GPU mutations: 4/4 missing semantics, component masks, packed color conversion and generated point coordinates rejected by real pixels without GPU errors');
