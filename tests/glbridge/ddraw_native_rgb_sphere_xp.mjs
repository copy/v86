#!/usr/bin/env node
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import{createHash}from'node:crypto';import{execFileSync}from'node:child_process';import{fileURLToPath}from'node:url';import{site_directory}from'../lib/site.mjs';import{run_xp_ram_probe}from'../lib/xp_ram_probe.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),site=site_directory(root),vendor=root+'tests/glbridge/wine/',out=path.resolve(process.env.DDRAW_RGB_SPHERE_OUT||root+'build/d3d-review/stage6-native-rgb-sphere'),cc=process.env.D9WG_CC||'i686-w64-mingw32-gcc',sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex'),manifest=JSON.parse(fs.readFileSync(vendor+'manifest.json'));
const providedDll=process.env.DDRAW_RGB_SPHERE_PROXY_DLL&&path.resolve(process.env.DDRAW_RGB_SPHERE_PROXY_DLL);
for(const f of manifest.files)assert.equal(sha(vendor+f.path),f.sha256);fs.mkdirSync(out,{recursive:true});
const source=root+'tests/glbridge/wine_native_rgb_sphere.c',prepare=root+'tests/glbridge/wine_xp_desktop_prepare.c';fs.copyFileSync(source,out+'/wine_native_rgb_sphere.c');fs.copyFileSync(prepare,out+'/wine_xp_desktop_prepare.c');fs.copyFileSync(fileURLToPath(import.meta.url),out+'/runner.mjs');
execFileSync(cc,['-std=gnu99','-O1','-g','-DDECLSPEC_EXPORT=','-I'+vendor+'include','-c',root+'tests/glbridge/wine_debug_standalone.c','-o',out+'/debug.o']);
execFileSync(cc,['-std=gnu99','-O1','-g','-DPSAPI_VERSION=1','-DDECLSPEC_EXPORT=','-DCOBJMACROS=','-D__WINESRC__','-include','windows.h','-include','initguid.h','-DDDRAW_RGB_SOURCE="'+vendor+'ddraw_ddraw4.c"','-I'+vendor+'include','-I'+root+'tests/glbridge/wine-compat',...(providedDll?['-DDDRAW_RGB_PROXY=1']:[]),source,out+'/debug.o','-o',out+'/RGB4.EXE','-lddraw','-ldxguid','-luser32','-lgdi32','-lole32','-lpsapi'],{stdio:'inherit'});
execFileSync(cc,['-std=gnu99','-Os','-Wall','-Wextra','-Werror',prepare,'-o',out+'/PREPARE.EXE','-luser32']);
fs.writeFileSync(out+'/source.json',JSON.stringify({proxy:!!providedDll,...(providedDll?{dllSha256:sha(providedDll)}:{}),minimumBootSeconds:210,pinnedWineCommit:manifest.commit,originalSourceSha256:sha(vendor+'ddraw_ddraw4.c'),wrapperSha256:sha(source),preparationSha256:sha(prepare),executableSha256:sha(out+'/RGB4.EXE'),scope:(providedDll?'App-local DLL numerical replay; no GPU pixel claim. ':'System DLL numerical reference. ')+'At most two executions in the same RAM VM only after explicit environment rejection; all raw logs retained. Only original test_compute_sphere_visibility, unchanged assertions and Windows expectations; original helper factory GUID explicitly substituted HAL to RGB after SDK declarations. Software-device diagnostic only; not a full-suite or native HAL certificate.'},null,2)+'\n');
if(process.env.DDRAW_RGB_SPHERE_BUILD_ONLY==='1')process.exit(0);
const names=['START.TXT','PREP.TXT','RGB4.TXT','AFTER.TXT','SELECT.TXT',
    'PREP1.TXT','RGB1.TXT','AFTER1.TXT','PREP2.TXT','RGB2.TXT','AFTER2.TXT'];
const files={'RGB4.EXE':fs.readFileSync(out+'/RGB4.EXE'),'PREPARE.EXE':fs.readFileSync(out+'/PREPARE.EXE'),
    'PROBE.CMD':Buffer.from([
    '@echo off','set WINETEST_PLATFORM=windows','set WINETEST_INTERACTIVE=0',
    'echo START native RGB sphere >%~d0\\START.TXT',
    ...(providedDll?['set D9WG_GDI_CURSOR=0','sc stop v86gl',
        'copy /y %~d0\\V86GL.SYS C:\\WINDOWS\\system32\\drivers\\v86gl.sys',
        'sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys','sc start v86gl',
        'if errorlevel 1 goto driver_failed']:[]),
    'set ATTEMPT=1',':attempt',
    '%~d0\\PREPARE.EXE >%~d0\\PREP%ATTEMPT%.TXT 2>&1','if errorlevel 1 goto setup_failed',
    '%~d0\\RGB4.EXE >%~d0\\RGB%ATTEMPT%.TXT 2>&1',
    '%~d0\\PREPARE.EXE --check-only >%~d0\\AFTER%ATTEMPT%.TXT 2>&1','if errorlevel 1 goto retry_environment',
    'copy /y %~d0\\PREP%ATTEMPT%.TXT %~d0\\PREP.TXT >nul',
    'copy /y %~d0\\RGB%ATTEMPT%.TXT %~d0\\RGB4.TXT >nul',
    'copy /y %~d0\\AFTER%ATTEMPT%.TXT %~d0\\AFTER.TXT >nul',
    'echo SELECTED attempt=%ATTEMPT% >%~d0\\SELECT.TXT',
    'echo COMPLETE native RGB sphere >%~d0\\OWNER.TXT','exit /b',':retry_environment',
    'findstr /c:"COMPLETE native_rgb_sphere=1" %~d0\\RGB%ATTEMPT%.TXT >nul','if errorlevel 1 goto execution_failed',
    'if "%ATTEMPT%"=="2" goto environment_failed','set ATTEMPT=2','goto attempt',
    ':execution_failed','echo FAIL native RGB execution incomplete >%~d0\\OWNER.TXT','exit /b',
    ':setup_failed','echo FAIL native RGB preparation >%~d0\\OWNER.TXT','exit /b',
    ':environment_failed','echo FAIL native RGB environment >%~d0\\OWNER.TXT','exit /b',
    ':driver_failed','echo FAIL proxy driver startup >%~d0\\OWNER.TXT','exit /b',''].join('\r\n'))};
if(providedDll)Object.assign(files,{'DDRAW.DLL':fs.readFileSync(providedDll),'V86GL.SYS':fs.readFileSync(site+'/glbridge/v86gl_driver/v86gl.sys')});
const rows=text=>text.split(/\r?\n/).filter(line=>line.startsWith('RGB_ROW '));
try{
    const r=await run_xp_ram_probe({root,out,files,image:process.env.XP_IMAGE||site+'/windowsxp/windowsxp_multidisk_C_4G.img',
        success:'COMPLETE native RGB sphere',log_files:names,
        log_completion:{'START.TXT':'START native RGB sphere','PREP.TXT':'COMPLETE desktop_prepare=1',
            'RGB4.TXT':'COMPLETE native_rgb_sphere=1','AFTER.TXT':'COMPLETE desktop_postcheck=1'},
        expected_releases:providedDll?null:0,minimum_boot_seconds:210,probe_timeout_seconds:600,
        inspect(result){
            for(const name of names)fs.writeFileSync(out+'/'+name,result.logs[name]);
            const selected=Number(/SELECTED attempt=([12])/.exec(result.logs['SELECT.TXT'])?.[1]);
            assert(selected===1||selected===2);assert.equal(result.logs['RGB4.TXT'],result.logs['RGB'+selected+'.TXT']);
            fs.writeFileSync(out+'/environment-attempts.json',JSON.stringify({selected,
                attempts:[1,2].filter(n=>result.logs['RGB'+n+'.TXT']).map(n=>({attempt:n,
                    selected:n===selected,preparation:result.logs['PREP'+n+'.TXT'],postcheck:result.logs['AFTER'+n+'.TXT']})),
                scope:'One RAM VM, identical original numerical assertions and native EXE; at most one repeat after a completed execution is explicitly rejected by the OS environment postcheck. No repeat based on numerical failures.'},null,2)+'\n');
            if(selected===2){assert.match(result.logs['AFTER1.TXT'],/UNREADY desktop changed during suite/);
                assert.match(result.logs['RGB1.TXT'],/COMPLETE native_rgb_sphere=1/);
                assert.deepEqual(rows(result.logs['RGB1.TXT']),rows(result.logs['RGB2.TXT']));}
            assert.equal(rows(result.logs['RGB4.TXT']).length,264);
            if(providedDll){
                const referencePath=root+'tests/glbridge/fixtures/ddraw_native_rgb_spheres.json';
                const reference=JSON.parse(fs.readFileSync(referencePath));
                const observed=rows(result.logs['RGB4.TXT']).map(line=>Object.fromEntries(
                    [...line.matchAll(/(\w+)=([0-9a-f]+)/g)].map(([,key,value])=>[key,parseInt(value,key==='projection'||key==='center'?10:16)])));
                assert.deepEqual(observed,reference.rows,'Exact native RGB sphere words differ');
                assert.equal(result.owners.length,selected);
                assert.deepEqual([...result.releases].sort(),[...result.owners].sort());
                fs.writeFileSync(out+'/comparison.json',JSON.stringify({passed:true,rows:observed.length,
                    dllSha256:sha(providedDll),nativeFixtureSha256:sha(referencePath),
                    scope:'Original selected sphere assertions and264 exact native numeric words match the app-local shipping DLL; acknowledged metadata transport only, no pixel certificate.'},null,2)+'\n');
            }else{assert.equal(result.batches,0);assert.deepEqual(result.owners,[]);}
            assert.match(result.logs['RGB4.TXT'],/RGB_SPHERE_TOTAL failures=0 flaky=0 skipped=0/);
        }});
    console.log(JSON.stringify({seconds:r.seconds,batches:r.batches,log:r.logs['RGB4.TXT']}));
}finally{
    if(fs.existsSync(out+'/probe-failure.json')){const r=JSON.parse(fs.readFileSync(out+'/probe-failure.json'));
        for(const name of names)if(typeof r.logs?.[name]==='string')fs.writeFileSync(out+'/'+name,r.logs[name]);}
}
