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
import {assert_native_material_text} from '../lib/ddraw_material_reference.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),site=site_directory(root);
const source='glbridge/sample/ddraw_material_reference.c';
const out=path.resolve(process.env.DDRAW_MATERIAL_OUT||root+'build/d3d-review/stage6-native-material');
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function check(text){const data=assert_native_material_text(text);return{pixels:data.pixels.length,vertices:data.rows.length};}
if(process.env.DDRAW_MATERIAL_REFERENCE){const file=path.resolve(process.env.DDRAW_MATERIAL_REFERENCE);console.log(JSON.stringify({savedReference:file,...check(fs.readFileSync(file,'utf8'))}));process.exit(0);}
fs.mkdirSync(out,{recursive:true});
execFileSync(process.env.D9WG_CC||'i686-w64-mingw32-gcc',['-std=gnu99','-Os','-Wall','-Wextra','-Werror','-nostdlib','-Wl,--subsystem,windows:5.01','-Wl,-e,_WinMainCRTStartup@0',site+'/'+source,'-o',out+'/MATREF.EXE','-lkernel32','-luser32','-ldxguid'],{stdio:'pipe'});
const metadata={source,sourceSha256:sha(site+'/'+source),executableSha256:sha(out+'/MATREF.EXE')};
const result=await run_xp_ram_probe({root,out,image:process.env.XP_IMAGE||site+'/windowsxp/windowsxp_multidisk_C_4G.img',files:{'MATREF.EXE':fs.readFileSync(out+'/MATREF.EXE'),'PROBE.CMD':Buffer.from('@echo off\r\n%~d0\\MATREF.EXE\r\n')},result_file:'MATREF.TXT',success:'PASS native material reference complete',log_files:['MATREF.TXT'],expected_releases:0,inspect(r){assert.equal(r.batches,0);assert.equal(r.owners.length,0);}});
fs.writeFileSync(out+'/MATREF.TXT',result.text);
fs.writeFileSync(out+'/reference.json',JSON.stringify({...metadata,seconds:result.seconds,batches:result.batches,text:result.text},null,2)+'\n');
console.log(JSON.stringify({seconds:result.seconds,batches:result.batches,...check(result.text)}));
