#!/usr/bin/env node
// Observe original XP system-memory copies and compressed encodings.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {site_directory} from '../lib/site.mjs';
import {run_xp_ram_probe} from '../lib/xp_ram_probe.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),site=site_directory(root),source='glbridge/sample/ddraw_blit_reference.c';
const out=path.resolve(process.env.DDRAW_BLIT_OUT||root+'build/d3d-review/stage6-native-blits');
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function check(text,metadata){
 assert.match(text,/COMPLETE blit=1/);
 const self=[...text.matchAll(/SELF_RESULT case=([0-9]+) mismatches=([0-9]+) hash=([0-9a-f]+)/g)].map(m=>({case:+m[1],mismatches:+m[2],hash:m[3]}));
 assert.equal(self.length,4);assert.deepEqual(self.map(r=>r.case),[0,1,2,3]);assert.ok(self.every(r=>!r.mismatches));
 const blocks=[...text.matchAll(/BLOCK pattern=([0-9]+) format=([0-9]+) words=([0-9]+) ([0-9a-f]+) ([0-9a-f]+) ([0-9a-f]+) ([0-9a-f]+)/g)].map(m=>({pattern:+m[1],format:+m[2],words:m.slice(4,4+Number(m[3])).map(x=>parseInt(x,16))}));
 const conversions=[...text.matchAll(/(COMP_CREATE|ENCODE|COMP_LOCK|DECODE) pattern=([0-9]+) format=([0-9]+) hr=([0-9a-f]+)/g)].map(m=>({operation:m[1],pattern:+m[2],format:+m[3],hr:m[4]}));
 const decoded=[...text.matchAll(/ROW pattern=([0-9]+) format=([0-9]+) y=([0-9]+) ([0-9a-f]+) ([0-9a-f]+) ([0-9a-f]+) ([0-9a-f]+)/g)].map(m=>({pattern:+m[1],format:+m[2],y:+m[3],pixels:m.slice(4).map(x=>parseInt(x,16))}));
 assert.equal(conversions.length,80);assert.equal(blocks.length,20);assert.equal(decoded.length,48);
 for(const row of conversions)assert.equal(row.hr,row.operation==='DECODE'&&[2,4].includes(row.format)?'80004001':'00000000');
 for(const m of text.matchAll(/^SELF case=([0-9]+) hr=([0-9a-f]+)/gm))assert.equal(m[2],'00000000');
 assert.equal(new Set(blocks.map(r=>r.pattern+':'+r.format)).size,20);
 if(process.argv.includes('--write-fixture')){assert.equal(sha(site+'/'+source),metadata.sourceSha256);fs.writeFileSync(root+'tests/glbridge/fixtures/ddraw_native_blits.json',JSON.stringify({description:'Independent original XP system-memory blit and encoding observations; failed native conversions retained individually.',...metadata,self,conversions,blocks,decoded},null,2)+'\n');}
 return {self:self.length,blocks:blocks.length,decodedRows:decoded.length,conversions:conversions.length};
}
if(process.env.DDRAW_BLIT_REFERENCE){const file=path.resolve(process.env.DDRAW_BLIT_REFERENCE),metadata=JSON.parse(fs.readFileSync(path.join(path.dirname(file),'reference.json')));console.log(check(fs.readFileSync(file,'utf8'),metadata));process.exit(0);}
fs.mkdirSync(out,{recursive:true});execFileSync(process.env.D9WG_CC||'i686-w64-mingw32-gcc',['-std=gnu99','-Os','-Wall','-Wextra','-Werror','-nostdlib','-Wl,--subsystem,windows:5.01','-Wl,-e,_WinMainCRTStartup@0',site+'/'+source,'-o',out+'/BLTREF.EXE','-lkernel32','-luser32','-ldxguid']);
const metadata={source,sourceSha256:sha(site+'/'+source),executableSha256:sha(out+'/BLTREF.EXE')};
const result=await run_xp_ram_probe({root,out,image:process.env.XP_IMAGE||site+'/windowsxp/windowsxp_multidisk_C_4G.img',files:{'BLTREF.EXE':fs.readFileSync(out+'/BLTREF.EXE'),'PROBE.CMD':Buffer.from('@echo off\r\n%~d0\\BLTREF.EXE\r\n')},result_file:'BLTREF.TXT',success:'COMPLETE blit=1',log_files:['BLTREF.TXT'],probe_timeout_seconds:600,expected_releases:0,inspect(r){assert.equal(r.batches,0);assert.equal(r.owners.length,0);}});
fs.writeFileSync(out+'/BLTREF.TXT',result.text);fs.writeFileSync(out+'/reference.json',JSON.stringify({...metadata,seconds:result.seconds,batches:result.batches},null,2)+'\n');console.log(JSON.stringify({seconds:result.seconds,batches:result.batches,...check(result.text,metadata)}));
