#!/usr/bin/env node
// Independent XP system RGB ProcessVertices observations, no local proxy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {site_directory} from '../lib/site.mjs';
import {run_xp_ram_probe} from '../lib/xp_ram_probe.mjs';
import {assert_native_lighting_text} from '../lib/ddraw_lighting_reference.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),site=site_directory(root);
const source='glbridge/sample/ddraw_lighting_reference.c';
const out=path.resolve(process.env.DDRAW_LIGHT_OUT||root+'build/d3d-review/stage6-native-lighting-certified');
const fixture=root+'tests/glbridge/fixtures/ddraw_native_lighting.json';
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function check(text,metadata){
 const rows=assert_native_lighting_text(text);
 if(process.argv.includes('--write-fixture')){
  assert.equal(metadata.sourceSha256,sha(site+'/'+source));
  fs.writeFileSync(fixture,JSON.stringify({description:'Original Microsoft system D3D7 and legacy D3D3 RGB ProcessVertices observations. D3D7 specular alpha and processing-time shininess history; legacy zero-power disabling. Positive-power old point/spot approximation is recorded but remains unresolved in the proxy.',source,sourceSha256:metadata.sourceSha256,executableSha256:metadata.executableSha256,rows},null,2)+'\n');
 }else assert.deepEqual(rows,JSON.parse(fs.readFileSync(fixture)).rows);
 return rows.length;
}
if(process.env.DDRAW_LIGHT_REFERENCE){
 const saved=path.resolve(process.env.DDRAW_LIGHT_REFERENCE);
 const metadata=JSON.parse(fs.readFileSync(path.join(path.dirname(saved),'reference.json')));
 console.log(JSON.stringify({savedReference:saved,rows:check(fs.readFileSync(saved,'utf8'),metadata)}));
 process.exit(0);
}
fs.mkdirSync(out,{recursive:true});
execFileSync(process.env.D9WG_CC||'i686-w64-mingw32-gcc',['-std=gnu99','-Os','-Wall','-Wextra','-Werror','-nostdlib','-Wl,--subsystem,windows:5.01','-Wl,-e,_WinMainCRTStartup@0',site+'/'+source,'-o',out+'/LIGHTREF.EXE','-lkernel32','-luser32','-ldxguid'],{stdio:'pipe'});
const metadata={source,sourceSha256:sha(site+'/'+source),executableSha256:sha(out+'/LIGHTREF.EXE')};
const result=await run_xp_ram_probe({root,out,image:process.env.XP_IMAGE||site+'/windowsxp/windowsxp_multidisk_C_4G.img',files:{'LIGHTREF.EXE':fs.readFileSync(out+'/LIGHTREF.EXE'),'PROBE.CMD':Buffer.from('@echo off\r\n%~d0\\LIGHTREF.EXE\r\n')},result_file:'LIGHTREF.TXT',success:'PASS native lighting reference complete',log_files:['LIGHTREF.TXT'],expected_releases:0,inspect(r){assert.equal(r.batches,0);assert.equal(r.owners.length,0);}});
fs.writeFileSync(out+'/LIGHTREF.TXT',result.text);
fs.writeFileSync(out+'/reference.json',JSON.stringify({...metadata,seconds:result.seconds,batches:result.batches,text:result.text},null,2)+'\n');
console.log(JSON.stringify({seconds:result.seconds,batches:result.batches,rows:check(result.text,metadata)}));
