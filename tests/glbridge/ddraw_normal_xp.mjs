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
import {assert_native_normal_text,native_normal_inputs} from '../lib/ddraw_normal_reference.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),site=site_directory(root);
const source='glbridge/sample/ddraw_normal_reference.c';
const out=path.resolve(process.env.DDRAW_NORMAL_OUT||root+'build/d3d-review/stage6-native-normals');
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function check(text,metadata){const data=assert_native_normal_text(text);if(process.argv.includes('--write-fixture')){assert.equal(metadata.sourceSha256,sha(site+'/'+source));fs.writeFileSync(root+'tests/glbridge/fixtures/ddraw_native_normals.json',JSON.stringify({description:'Original XP Microsoft system RGB D3D3/7 CPU and drawn normal-transform observations. RGB GPU results are not a blanket HAL reference; original Wine HAL singular expectations differ.',...metadata,...data,inputs:native_normal_inputs(fs.readFileSync(site+'/'+source,'utf8')),inputProvenance:'Float32 input matrices and vertices compiled from the same hashed native C source, with both native API view setups checked. No proxy transform/lighting code.'},null,2)+'\n');}return{vertices:data.cpu.length,pixels:data.pixels.length,histories:data.history.length};}
if(process.env.DDRAW_NORMAL_REFERENCE){const file=path.resolve(process.env.DDRAW_NORMAL_REFERENCE),metadata=JSON.parse(fs.readFileSync(path.join(path.dirname(file),'reference.json')));console.log(JSON.stringify({savedReference:file,...check(fs.readFileSync(file,'utf8'),{source:metadata.source,sourceSha256:metadata.sourceSha256,executableSha256:metadata.executableSha256})}));process.exit(0);}
fs.mkdirSync(out,{recursive:true});
execFileSync(process.env.D9WG_CC||'i686-w64-mingw32-gcc',['-std=gnu99','-Os','-Wall','-Wextra','-Werror','-nostdlib','-Wl,--subsystem,windows:5.01','-Wl,-e,_WinMainCRTStartup@0',site+'/'+source,'-o',out+'/NORMREF.EXE','-lkernel32','-luser32','-ldxguid'],{stdio:'pipe'});
const metadata={source,sourceSha256:sha(site+'/'+source),executableSha256:sha(out+'/NORMREF.EXE')};
const result=await run_xp_ram_probe({root,out,image:process.env.XP_IMAGE||site+'/windowsxp/windowsxp_multidisk_C_4G.img',files:{'NORMREF.EXE':fs.readFileSync(out+'/NORMREF.EXE'),'PROBE.CMD':Buffer.from('@echo off\r\n%~d0\\NORMREF.EXE\r\n')},result_file:'NORMREF.TXT',success:'PASS native normal-transform reference complete',log_files:['NORMREF.TXT'],expected_releases:0,inspect(r){assert.equal(r.batches,0);assert.equal(r.owners.length,0);}});
fs.writeFileSync(out+'/NORMREF.TXT',result.text);
fs.writeFileSync(out+'/reference.json',JSON.stringify({...metadata,seconds:result.seconds,batches:result.batches,text:result.text},null,2)+'\n');
console.log(JSON.stringify({seconds:result.seconds,batches:result.batches,...check(result.text,metadata)}));
