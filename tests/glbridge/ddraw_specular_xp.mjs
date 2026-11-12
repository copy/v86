#!/usr/bin/env node
// Original XP legacy RGB specular input grid; no proxy or GPU substitution.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {site_directory} from '../lib/site.mjs';
import {run_xp_ram_probe} from '../lib/xp_ram_probe.mjs';
import {assert_native_attenuation_text} from '../lib/ddraw_attenuation_reference.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),site=site_directory(root),source='glbridge/sample/ddraw_specular_reference.c';
const out=path.resolve(process.env.DDRAW_SPECULAR_OUT||root+'build/d3d-review/stage6-native-specular-grid');
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function check(text,metadata,vertexText){const {rows,vertexCompatibility}=assert_native_attenuation_text(text,vertexText);if(process.argv.includes('--write-fixture')){assert.equal(sha(site+'/'+source),metadata.sourceSha256);assert.equal(sha(site+'/'+metadata.vertexSource),metadata.vertexSourceSha256);fs.writeFileSync(root+'tests/glbridge/fixtures/ddraw_native_specular_grid.json',JSON.stringify({description:'Independent original XP RGB3 specular input grid, raw observations; applicability still governed by unmodified Wine tests.',...metadata,depths:[.25,1,2,4],ranges:[1,2,10,100,1000],powers:[1,5,30,32],attenuations:[[1,0,0],[0,1,0],[0,0,1],[1,1,1]],rows,vertexCompatibility},null,2)+'\n');}return rows.length;}
if(process.env.DDRAW_SPECULAR_REFERENCE){const file=path.resolve(process.env.DDRAW_SPECULAR_REFERENCE),metadata=JSON.parse(fs.readFileSync(path.join(path.dirname(file),'reference.json')));console.log(JSON.stringify({savedReference:file,rows:check(fs.readFileSync(file,'utf8'),metadata,fs.readFileSync(path.join(path.dirname(file),'VTXREF.TXT'),'utf8'))}));process.exit(0);}
fs.mkdirSync(out,{recursive:true});execFileSync(process.env.D9WG_CC||'i686-w64-mingw32-gcc',['-std=gnu99','-Os','-Wall','-Wextra','-Werror','-nostdlib','-Wl,--subsystem,windows:5.01','-Wl,-e,_WinMainCRTStartup@0',site+'/'+source,'-o',out+'/SPECREF.EXE','-lkernel32','-luser32','-ldxguid']);
const vertexSource='glbridge/sample/ddraw_vertex_compat_reference.c';
execFileSync(process.env.D9WG_CC||'i686-w64-mingw32-gcc',['-std=gnu99','-Os','-Wall','-Wextra','-Werror','-nostdlib','-Wl,--subsystem,windows:5.01','-Wl,-e,_WinMainCRTStartup@0',site+'/'+vertexSource,'-o',out+'/VTXREF.EXE','-lkernel32','-luser32','-ldxguid']);
const metadata={source,sourceSha256:sha(site+'/'+source),executableSha256:sha(out+'/SPECREF.EXE'),vertexSource,vertexSourceSha256:sha(site+'/'+vertexSource),vertexExecutableSha256:sha(out+'/VTXREF.EXE')};
const result=await run_xp_ram_probe({root,out,image:process.env.XP_IMAGE||site+'/windowsxp/windowsxp_multidisk_C_4G.img',files:{'SPECREF.EXE':fs.readFileSync(out+'/SPECREF.EXE'),'VTXREF.EXE':fs.readFileSync(out+'/VTXREF.EXE'),'PROBE.CMD':Buffer.from('@echo off\r\n%~d0\\SPECREF.EXE\r\n%~d0\\VTXREF.EXE\r\n')},result_file:'SPECREF.TXT',success:'COMPLETE specular=1',log_files:['SPECREF.TXT','VTXREF.TXT'],log_completion:{'VTXREF.TXT':'COMPLETE vertex=1'},probe_timeout_seconds:600,expected_releases:0,inspect(r){assert.equal(r.batches,0);assert.equal(r.owners.length,0);}});
fs.writeFileSync(out+'/SPECREF.TXT',result.text);fs.writeFileSync(out+'/VTXREF.TXT',result.logs['VTXREF.TXT']);fs.writeFileSync(out+'/reference.json',JSON.stringify({...metadata,seconds:result.seconds,batches:result.batches},null,2)+'\n');console.log(JSON.stringify({seconds:result.seconds,batches:result.batches,rows:check(result.text,metadata,result.logs['VTXREF.TXT'])}));
