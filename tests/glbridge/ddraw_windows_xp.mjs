#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {site_directory} from '../lib/site.mjs';
import {run_xp_ram_probe} from '../lib/xp_ram_probe.mjs';
import {compare_window_events} from '../lib/ddraw_window_trace.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),site=site_directory(root);
const proxyDll=process.env.DDRAW_WINDOWS_PROXY_DLL&&path.resolve(process.env.DDRAW_WINDOWS_PROXY_DLL);
const driverReference=process.env.DDRAW_WINDOWS_DRIVER_REFERENCE==='1',bootstrap=!!proxyDll||driverReference;
const out=path.resolve(process.env.DDRAW_WINDOWS_OUT||root+'build/d3d-review/'+(proxyDll?'stage6-proxy-windows':'stage6-native-windows'));
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function observations(text,logs,metadata){
    assert.match(text,/COMPLETE windows=1/);
    if(!proxyDll&&!driverReference)assert.match(logs['NLOAD.TXT'],/COMPLETE native_load=1/);
    const lines=text.split(/\r?\n/),windows=lines.filter(l=>l.startsWith('WINDOW ')),events=lines.filter(l=>l.startsWith('EVENT ')),surfaces=lines.filter(l=>l.startsWith('SURFACE ')),results=lines.filter(l=>l.startsWith('RESULT '));
    assert.equal(windows.length,24);assert.equal(surfaces.length,15);assert.equal(results.length,24);assert(events.length<2048);
    if(proxyDll){
        const fixture=root+'tests/glbridge/fixtures/ddraw_native_windows.json',reference=JSON.parse(fs.readFileSync(fixture));
        for(const [f,h]of Object.entries(reference.sources))assert.equal(sha(site+'/'+f),h);
        assert.deepEqual(windows,reference.windows,'native window snapshots');
        const messageComparison=compare_window_events(reference.events,events,windows);
        assert.deepEqual(results.filter(l=>!l.includes('name=restore_primary ')),reference.results.filter(l=>!l.includes('name=restore_primary ')),'native control return values');
        const lf=root+'tests/glbridge/fixtures/ddraw_native_control_lifetime.json',lifetime=JSON.parse(fs.readFileSync(lf)),raw=logs['LIFE.TXT'];assert.match(raw,/COMPLETE control_lifetime=1/);const releases=[...raw.matchAll(/RELEASE version=(\d+) refs=(\d+) proc_changed=(\d+)/g)].map(m=>({version:+m[1],refs:+m[2],procChanged:+m[3]})),lifetimeResults=[...raw.matchAll(/RESULT version=(\d+) name=(\w+) hr=([0-9A-F]+)/g)].map(m=>({version:+m[1],name:m[2],hr:parseInt(m[3],16)}));assert.equal(sha(site+'/'+lifetime.source),lifetime.sourceSha256);assert.deepEqual(releases,lifetime.releases);assert.deepEqual(lifetimeResults,lifetime.results);fs.writeFileSync(out+'/comparison.json',JSON.stringify({messageComparison,lifetime:{releases,results:lifetimeResults,nativeFixtureSha256:sha(lf)},windows:windows.length,events:events.length,controlResults:results.length-3,unresolvedSurfaceResults:surfaces,primaryRestoreResults:results.filter(l=>l.includes('name=restore_primary ')),nativeFixtureSha256:sha(fixture),passed:true},null,2)+'\n');
    }
    if(process.argv.includes('--write-fixture')){
        assert(!proxyDll,'Only the original system DLL can produce the reference');
        for(const [f,h]of Object.entries(metadata.sources))assert.equal(sha(site+'/'+f),h);
        fs.writeFileSync(root+'tests/glbridge/fixtures/ddraw_native_windows.json',JSON.stringify({description:'Original XP window event traces and primary restore/duplicate-mode observations; local proxy/system DLL coexistence checked separately in the same RAM probe.',...metadata,windows,events,surfaces,results,nativeLoad:logs['NLOAD.TXT']},null,2)+'\n');
    }
    return {windows:windows.length,events:events.length,surfaces:surfaces.length};
}
if(process.env.DDRAW_WINDOWS_REFERENCE){
    const file=path.resolve(process.env.DDRAW_WINDOWS_REFERENCE),dir=path.dirname(file),metadata=JSON.parse(fs.readFileSync(dir+'/reference.json'));
    console.log(JSON.stringify(observations(fs.readFileSync(file,'utf8'),proxyDll?{'LIFE.TXT':fs.readFileSync(dir+'/LIFE.TXT','utf8')}:{'NLOAD.TXT':fs.readFileSync(dir+'/NLOAD.TXT','utf8')},metadata)));process.exit(0);
}
fs.mkdirSync(out,{recursive:true});
const samples=[['glbridge/sample/ddraw_window_reference.c','WINDOWS.EXE',[]],...proxyDll?[['glbridge/sample/ddraw_control_lifetime_reference.c','LIFE.EXE',[]]]:driverReference?[]:[['glbridge/sample/ddraw_native_load_reference.c','NLOAD.EXE',['-lddraw']]]],sources={},executables={};let proxyProducerSha256,proxyLifetimeProducerSha256;
for(const [source,name,libs]of samples){
    let input=site+'/'+source;
    if(proxyDll){
        const text=fs.readFileSync(input,'utf8'),before=String.raw`GetSystemDirectoryA(p,sizeof(p));lstrcatA(p,"\\ddraw.dll");`;
        assert(text.includes(before));
        const transformed=text.replace(before,String.raw`GetModuleFileNameA(NULL,p,sizeof(p));at=lstrlenA(p);while(at&&p[at-1]!='\\')--at;p[at]=0;lstrcatA(p,"ddraw.dll");`);
        input=out+'/'+(name==='WINDOWS.EXE'?'WINDOWS-PROXY.c':'LIFE-PROXY.c');fs.writeFileSync(input,transformed);if(name==='WINDOWS.EXE')proxyProducerSha256=sha(input);else proxyLifetimeProducerSha256=sha(input);
    }
    execFileSync(process.env.D9WG_CC||'i686-w64-mingw32-gcc',['-std=gnu99','-Os','-Wall','-Wextra','-Werror','-nostdlib','-Wl,--subsystem,windows:5.01','-Wl,-e,_WinMainCRTStartup@0',input,'-o',out+'/'+name,'-lkernel32','-luser32','-ldxguid',...libs]);
    sources[source]=sha(site+'/'+source);executables[name]=sha(out+'/'+name);
}
const metadata={sources,executables,shippingDdrawSha256:sha(proxyDll||site+'/glbridge/ddrawproxy/ddraw.dll'),...(proxyDll?{proxyProducerSha256,proxyLifetimeProducerSha256}:{}),...(bootstrap?{driverSha256:sha(site+'/glbridge/v86gl_driver/v86gl.sys')}:{})};
fs.writeFileSync(out+'/reference.json',JSON.stringify(metadata,null,2)+'\n');
const commands=['@echo off'];
if(bootstrap)commands.push('sc stop v86gl','copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys','sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys','sc start v86gl','if errorlevel 1 goto failed');
if(!bootstrap)commands.push('%~d0\\NLOAD.EXE');
commands.push('%~d0\\WINDOWS.EXE');if(proxyDll)commands.push('%~d0\\LIFE.EXE');commands.push('exit /b',':failed','echo FAIL driver startup >%~d0\\WINDOWS.TXT','');
const files={'WINDOWS.EXE':fs.readFileSync(out+'/WINDOWS.EXE'),'DDRAW.DLL':fs.readFileSync(proxyDll||site+'/glbridge/ddrawproxy/ddraw.dll'),'PROBE.CMD':Buffer.from(commands.join('\r\n'))};
if(bootstrap)files['V86GL.SYS']=fs.readFileSync(site+'/glbridge/v86gl_driver/v86gl.sys');
if(proxyDll){files['V86GL.SYS']=fs.readFileSync(site+'/glbridge/v86gl_driver/v86gl.sys');files['LIFE.EXE']=fs.readFileSync(out+'/LIFE.EXE');}
else if(!driverReference)files['NLOAD.EXE']=fs.readFileSync(out+'/NLOAD.EXE');
const result=await run_xp_ram_probe({root,out,image:process.env.XP_IMAGE||site+'/windowsxp/windowsxp_multidisk_C_4G.img',files,result_file:'WINDOWS.TXT',success:'COMPLETE windows=',log_files:proxyDll?['WINDOWS.TXT','LIFE.TXT']:driverReference?['WINDOWS.TXT']:['WINDOWS.TXT','NLOAD.TXT'],log_completion:proxyDll?{'LIFE.TXT':'COMPLETE control_lifetime='}:driverReference?{}:{'NLOAD.TXT':'COMPLETE native_load=1'},probe_timeout_seconds:600,expected_releases:proxyDll?2:0,inspect(r){if(!proxyDll){assert.equal(r.batches,0);assert.equal(r.owners.length,0);}}});
for(const name of ['WINDOWS.TXT','NLOAD.TXT','LIFE.TXT'])if(result.logs[name])fs.writeFileSync(out+'/'+name,result.logs[name]);
fs.writeFileSync(out+'/reference.json',JSON.stringify({...metadata,seconds:result.seconds,batches:result.batches},null,2)+'\n');
console.log(JSON.stringify({seconds:result.seconds,...observations(result.text,result.logs,metadata)}));
