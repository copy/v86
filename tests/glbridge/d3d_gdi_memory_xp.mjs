#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {run_xp_ram_probe} from '../lib/xp_ram_probe.mjs';
import {site_directory} from '../lib/site.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),site=site_directory(root),out=path.resolve(process.env.D3D_GDI_OUT||root+'build/d3d-review/stage6-gdi-memory');
fs.mkdirSync(out,{recursive:true});
const source=root+'tests/glbridge/d3d_gdi_memory.c',helper=site+'/glbridge/d3d9proxy/d3d9_gdi_memory.inc';
execFileSync(process.env.D9WG_CC||'i686-w64-mingw32-gcc',['-std=gnu99','-O1','-Wall','-Wextra','-Werror','-I'+path.dirname(helper),source,'-o',out+'/PROBE.EXE','-luser32','-lgdi32'],{stdio:'inherit'});
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
fs.writeFileSync(out+'/source.json',JSON.stringify({sourceSha256:sha(source),helperSha256:sha(helper),executableSha256:sha(out+'/PROBE.EXE')},null,2)+'\n');
const files={'PROBE.EXE':fs.readFileSync(out+'/PROBE.EXE'),'PROBE.CMD':Buffer.from('@echo off\r\n%~d0\\PROBE.EXE >%~d0\\GDI.TXT 2>&1\r\necho exit=%errorlevel% >>%~d0\\GDI.TXT\r\necho COMPLETE GDI memory >%~d0\\OWNER.TXT\r\n')};
const result=await run_xp_ram_probe({root,out,files,image:process.env.XP_IMAGE||site+'/windowsxp/windowsxp_multidisk_C_4G.img',success:'COMPLETE GDI memory',log_files:['GDI.TXT'],log_completion:{'GDI.TXT':'exit='},rendering:'CPU/GDI only: actual installed XP runtime, no graphics transport or proxy draws',inspect(r){fs.writeFileSync(out+'/GDI.TXT',r.logs['GDI.TXT']);assert.match(r.logs['GDI.TXT'],/PASS GDI memory: \d+ checks/);assert.match(r.logs['GDI.TXT'],/exit=0/);assert(!r.logs['GDI.TXT'].includes('FAIL'));}});
console.log(result.logs['GDI.TXT']);
