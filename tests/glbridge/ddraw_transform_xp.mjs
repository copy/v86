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
import {parse_native_transform_text} from '../lib/ddraw_transform_reference.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),site=site_directory(root);
const source='glbridge/sample/ddraw_transform_reference.c';
const out=path.resolve(process.env.DDRAW_TRANSFORM_OUT||root+'build/d3d-review/stage6-native-transforms');
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function check(transform,bound,metadata){const data=parse_native_transform_text(transform,bound);if(process.argv.includes('--write-fixture')){assert.equal(sha(site+'/'+metadata.source),metadata.sourceSha256);assert.equal(sha(site+'/'+metadata.boundSource),metadata.boundSourceSha256);fs.writeFileSync(root+'tests/glbridge/fixtures/ddraw_native_transforms.json',JSON.stringify({...metadata,...data},null,2)+'\n');}return{views:data.views.length,vertices:data.vertices.length,matrices:data.matrices.length,bindings:data.bindings.length};}
if(process.env.DDRAW_TRANSFORM_REFERENCE){const folder=path.resolve(process.env.DDRAW_TRANSFORM_REFERENCE),metadata=JSON.parse(fs.readFileSync(folder+'/reference.json'));console.log(JSON.stringify({savedReference:folder,...check(fs.readFileSync(folder+'/TRNREF.TXT','utf8'),fs.readFileSync(folder+'/BNDREF.TXT','utf8'),metadata)}));process.exit(0);}
fs.mkdirSync(out,{recursive:true});
execFileSync(process.env.D9WG_CC||'i686-w64-mingw32-gcc',['-std=gnu99','-Os','-Wall','-Wextra','-Werror','-nostdlib','-Wl,--subsystem,windows:5.01','-Wl,-e,_WinMainCRTStartup@0',site+'/'+source,'-o',out+'/TRNREF.EXE','-lkernel32','-luser32','-ldxguid'],{stdio:'pipe'});
const boundSource='glbridge/sample/ddraw_bound_matrix_reference.c';
execFileSync(process.env.D9WG_CC||'i686-w64-mingw32-gcc',['-std=gnu99','-Os','-Wall','-Wextra','-Werror','-nostdlib','-Wl,--subsystem,windows:5.01','-Wl,-e,_WinMainCRTStartup@0',site+'/'+boundSource,'-o',out+'/BNDREF.EXE','-lkernel32','-luser32','-ldxguid'],{stdio:'pipe'});
const metadata={source,sourceSha256:sha(site+'/'+source),executableSha256:sha(out+'/TRNREF.EXE'),boundSource,boundSourceSha256:sha(site+'/'+boundSource),boundExecutableSha256:sha(out+'/BNDREF.EXE')};
const result=await run_xp_ram_probe({root,out,image:process.env.XP_IMAGE||site+'/windowsxp/windowsxp_multidisk_C_4G.img',files:{'TRNREF.EXE':fs.readFileSync(out+'/TRNREF.EXE'),'BNDREF.EXE':fs.readFileSync(out+'/BNDREF.EXE'),'PROBE.CMD':Buffer.from('@echo off\r\n%~d0\\TRNREF.EXE\r\n%~d0\\BNDREF.EXE\r\n')},result_file:'TRNREF.TXT',success:'COMPLETE transform=1',log_files:['TRNREF.TXT','BNDREF.TXT'],log_completion:{'BNDREF.TXT':'COMPLETE bound=1'},expected_releases:0,inspect(r){assert.equal(r.batches,0);assert.equal(r.owners.length,0);}});
for(const name of ['TRNREF.TXT','BNDREF.TXT'])fs.writeFileSync(out+'/'+name,result.logs[name]);
fs.writeFileSync(out+'/reference.json',JSON.stringify({...metadata,seconds:result.seconds,batches:result.batches},null,2)+'\n');
console.log(JSON.stringify({seconds:result.seconds,batches:result.batches,...check(result.logs['TRNREF.TXT'],result.logs['BNDREF.TXT'],metadata)}));
