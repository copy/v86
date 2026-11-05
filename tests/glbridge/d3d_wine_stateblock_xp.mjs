#!/usr/bin/env node
// Unmodified Wine stateblock suites, using Windows expectations inside XP.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {parse_wine_result} from "../lib/wine_test_result.mjs";
import {site_directory} from "../lib/site.mjs";
import {run_xp_ram_probe} from "../lib/xp_ram_probe.mjs";
import {create_d3d_live_renderer} from "../lib/d3d_live_renderer.mjs";
const root=fileURLToPath(new URL("../../",import.meta.url)),site=site_directory(root);
const vendor=root+"tests/glbridge/wine/",out=path.resolve(process.env.D3D_WINE_OUT || root+"build/d3d-review/wine-stateblocks");
const manifest=JSON.parse(fs.readFileSync(vendor+"manifest.json"));
for(const file of manifest.files)assert.equal(createHash("sha256").update(fs.readFileSync(vendor+file.path)).digest("hex"),file.sha256,"Modified upstream Wine source: "+file.path);
fs.mkdirSync(out,{recursive:true});
const files={"V86GL.SYS":fs.readFileSync(site+"/glbridge/v86gl_driver/v86gl.sys")};
for(const api of ["8","9"]) {
    execFileSync("sh",[site+"/glbridge/d3d"+api+"proxy/build.sh",out+"/d3d"+api+".dll"],{stdio:"pipe"});
    execFileSync(process.env.D9WG_CC || "i686-w64-mingw32-gcc",["-std=gnu99","-O1","-g","-DSTANDALONE","-DDECLSPEC_EXPORT=","-I"+vendor+"include",vendor+"d3d"+api+"_stateblock.c","-o",out+"/WINE"+api+"SB.EXE","-ld3d"+api,"-ldxguid","-luser32","-lgdi32","-lole32"],{stdio:"pipe"});
    files["D3D"+api+".DLL"]=fs.readFileSync(out+"/d3d"+api+".dll");files["WINE"+api+"SB.EXE"]=fs.readFileSync(out+"/WINE"+api+"SB.EXE");
}
files["PROBE.CMD"]=Buffer.from(["@echo off","set D9WG_GDI_CURSOR=0","set WINETEST_PLATFORM=windows","set WINETEST_DEBUG=1","set WINETEST_INTERACTIVE=0","sc stop v86gl","copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys","sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys","sc start v86gl","if errorlevel 1 goto failed","echo RUNNING Wine8 >%~d0\\WINE8.TXT","echo WAITING Wine9 >%~d0\\WINE9.TXT","%~d0\\WINE8SB.EXE >>%~d0\\WINE8.TXT 2>&1","echo exit=%errorlevel% >>%~d0\\WINE8.TXT","%~d0\\WINE9SB.EXE >>%~d0\\WINE9.TXT 2>&1","echo exit=%errorlevel% >>%~d0\\WINE9.TXT","echo COMPLETE Wine stateblock probes >%~d0\\OWNER.TXT","exit /b",":failed","echo FAIL driver startup >%~d0\\OWNER.TXT",""].join("\r\n"));
const live=await create_d3d_live_renderer();
try {
    const result=await run_xp_ram_probe({root,out,files,image:process.env.XP_IMAGE || site+"/windowsxp/windowsxp_multidisk_C_4G.img",success:"COMPLETE Wine stateblock probes",log_files:["WINE8.TXT","WINE9.TXT"],log_completion:{"WINE8.TXT":"exit=","WINE9.TXT":"exit="},capture_graphics:true,expected_releases:2,graphics_renderer:live,
        rendering:"Unmodified Wine stateblock suites with Windows expectations and actual GPU transport. Both complete suites must finish with zero failures, todos, flaky failures and skips.",inspect(result) {
            for(const [name,log] of Object.entries(result.logs)) {
                fs.writeFileSync(out+"/"+name,log);
                result.wineSummaries ??= {};result.wineSummaries[name]=parse_wine_result(log,name);
            }
            assert.deepEqual(result.releases,result.owners);
            assert.equal(live.stats.snapshot.sessionCleanup.length,2);assert(live.stats.snapshot.sessionCleanup.every(row=>!row.devices&&!row.resources));
        }});
    console.log(JSON.stringify(result));
} finally {fs.writeFileSync(out+"/live-gpu.json",JSON.stringify(live.stats,null,2)+"\n");live.close();}
