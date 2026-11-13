#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {site_directory} from '../lib/site.mjs';
import {run_xp_ram_probe} from '../lib/xp_ram_probe.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url)), site = site_directory(root);
const dll = process.env.DDRAW_CREATION_PROXY_DLL && path.resolve(process.env.DDRAW_CREATION_PROXY_DLL);
const out = path.resolve(process.env.DDRAW_CREATION_OUT || root+'build/d3d-review/stage6-'+(dll?'proxy':'native')+'-creation');
const source = 'glbridge/sample/ddraw_creation_reference.c';
const sha = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const fixture = root+'tests/glbridge/fixtures/ddraw_native_creation.json';
fs.mkdirSync(out,{recursive:true});
let input = site+'/'+source;
if (dll) {
    const before = String.raw`GetSystemDirectoryA(path, sizeof(path)); lstrcatA(path, "\\ddraw.dll");`;
    const original = fs.readFileSync(input,'utf8');
    assert(original.includes(before));
    input = out+'/CREATE-PROXY.c';
    fs.writeFileSync(input,original.replace(before,String.raw`GetModuleFileNameA(NULL, path, sizeof(path)); at=lstrlenA(path); while(at && path[at-1]!='\\')--at; path[at]=0; lstrcatA(path,"ddraw.dll");`));
}
const abiSource = '#define COBJMACROS\n#include <ddraw.h>\n#include <stddef.h>\n' + ['CreateSurface','SetCooperativeLevel','SetDisplayMode','RestoreDisplayMode'].map(name => '_Static_assert(offsetof(IDirectDraw2Vtbl,'+name+')==offsetof(IDirectDraw3Vtbl,'+name+'),"Draw3 inherits Draw2 '+name+' slot");').join('\n');
fs.writeFileSync(out+'/controller-abi.c',abiSource+'\n');
execFileSync(process.env.D9WG_CC||'i686-w64-mingw32-gcc',['-std=gnu99','-Wall','-Wextra','-Werror','-fsyntax-only',out+'/controller-abi.c']);
execFileSync(process.env.D9WG_CC||'i686-w64-mingw32-gcc',['-std=gnu99','-Os','-Wall','-Wextra','-Werror','-nostdlib','-Wl,--subsystem,windows:5.01','-Wl,-e,_WinMainCRTStartup@0',input,'-o',out+'/CREATE.EXE','-lkernel32','-luser32','-ldxguid']);
const meta = {source,sourceSha256:sha(site+'/'+source),executableSha256:sha(out+'/CREATE.EXE'),controllerAbiSha256:sha(out+'/controller-abi.c'),...(dll?{proxyProducerSha256:sha(input),dllSha256:sha(dll)}:{})};
fs.writeFileSync(out+'/reference.json',JSON.stringify(meta,null,2)+'\n');
const commands=['@echo off'];
const files={'CREATE.EXE':fs.readFileSync(out+'/CREATE.EXE')};
if(dll){files['DDRAW.DLL']=fs.readFileSync(dll);files['V86GL.SYS']=fs.readFileSync(site+'/glbridge/v86gl_driver/v86gl.sys');commands.push('sc stop v86gl','copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys','sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys','sc start v86gl');}
commands.push('%~d0\\CREATE.EXE','');files['PROBE.CMD']=Buffer.from(commands.join('\r\n'));
const r=await run_xp_ram_probe({root,out,files,image:process.env.XP_IMAGE||site+'/windowsxp/windowsxp_multidisk_C_4G.img',result_file:'CREATE.TXT',log_files:['CREATE.TXT'],success:'COMPLETE creation_reference=1',probe_timeout_seconds:600,expected_releases:dll?1:0,inspect(r){if(!dll){assert.equal(r.batches,0);assert.equal(r.owners.length,0);}}});
fs.writeFileSync(out+'/CREATE.TXT',r.text);
const results=[...r.text.matchAll(/RESULT version=(\d+) name=(\w+) hr=([0-9A-F]+) output=(\d+)/g)].map(m=>({version:+m[1],name:m[2],hr:parseInt(m[3],16),output:+m[4]}));
assert.equal(results.length,dll?60:49);
const evidence={...meta,seconds:r.seconds,batches:r.batches,results};
fs.writeFileSync(out+'/reference.json',JSON.stringify(evidence,null,2)+'\n');
if(dll){const native=JSON.parse(fs.readFileSync(fixture));assert.equal(meta.sourceSha256,native.sourceSha256);const supported=new Set(native.results.filter(x=>x.name==='query_view'&&x.hr===0).map(x=>x.version)); assert.deepEqual(results.filter(x=>supported.has(x.version)),native.results.filter(x=>supported.has(x.version))); const native2=native.results.filter(x=>x.version===2).map(x=>({...x,version:3})); assert.deepEqual(results.filter(x=>x.version===3),native2);fs.writeFileSync(out+'/comparison.json',JSON.stringify({passed:true,records:results.filter(x=>x.version!==3).length,nativeUnsupportedViews:native.results.filter(x=>x.name==='query_view'&&x.hr!==0),proxyAdditionalViews:results.filter(x=>x.version===3),proxyAdditionalViewsCertified:true,proxyAdditionalViewsReference:"Native Draw2 inherited controller API slots and descriptor ABI; direct Native Draw3 QueryInterface remains E_NOINTERFACE. All12 proxy3 observations match Native2 with only the version label remapped.",scope:"Exact48-record comparison for native-supported views1/2/4/7 plus12 proxy3 records against Native2 inherited API behavior. Control/creation only, not complete Wine conformance or a pixel rendering claim.",nativeFixtureSha256:sha(fixture)},null,2)+'\n');}
if(process.argv.includes('--write-fixture')){assert(!dll);fs.writeFileSync(fixture,JSON.stringify(evidence,null,2)+'\n');}
console.log(JSON.stringify(evidence));
