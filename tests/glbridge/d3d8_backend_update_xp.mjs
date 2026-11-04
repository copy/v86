#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {execFileSync as run} from "node:child_process";
import {fileURLToPath} from "node:url";
import {site_directory} from "../lib/site.mjs";
import {run_xp_ram_probe} from "../lib/xp_ram_probe.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url)), site = site_directory(root);
const out = path.resolve(process.env.D8WG_BACKEND_UPDATE_OUT || root + "build/d3d-review/stage4k27-backend-update-xp");
process.chdir(root);
fs.mkdirSync(out, {recursive: true});
fs.rmSync(out + "/probe-result.json", {force: true}); fs.rmSync(out + "/graphics.bin", {force: true});
const files = {"V86GL.SYS": fs.readFileSync(site + "/glbridge/v86gl_driver/v86gl.sys")};
const baseline=run("git",["show","2a43549:glbridge/d3d8proxy/d3d8.dll"],{cwd:site,stdio:"pipe"});fs.writeFileSync(out+"/BASE8.DLL",baseline);files["BASE8.DLL"]=baseline;run("sh",[site+"/glbridge/d3d8proxy/build.sh",out+"/d3d8.dll"],{stdio:"pipe"});files["D3D8.DLL"]=fs.readFileSync(out+"/d3d8.dll");
run("sh", [site + "/glbridge/d3d9proxy/build.sh", out + "/d3d9.dll"], {stdio: "pipe"});
run("sh", [site + "/glbridge/d3d9proxy/build.sh", "--static",out + "/libd9wg_d3d9.a"], {stdio: "pipe"});
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-shared","-std=gnu99","-Os","-s","-nostdlib","-Wall","-Wextra","-Werror","-Wl,--subsystem,windows:5.01","-Wl,-e,_DllMain@12","-Wl,--kill-at","-Wl,--exclude-all-symbols","-o",out+"/CORE8.DLL",site+"/glbridge/sample/d3d8_backend_update_consumer.c",site+"/glbridge/sample/d3d8_backend_update_consumer.def",out+"/libd9wg_d3d9.a","-luser32","-lgdi32","-lkernel32"],{stdio:"pipe"});
files["CORE8.DLL"]=fs.readFileSync(out+"/CORE8.DLL");
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror", "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/UPCORE.EXE", site + "/glbridge/sample/d3d8_backend_update_test.c",site+"/glbridge/sample/d3d8_backend_update8_probe.c", "-ldxguid", "-luser32", "-lkernel32"], {stdio: "pipe"});
files["D3D9.DLL"] = fs.readFileSync(out + "/d3d9.dll"); files["UPCORE.EXE"] = fs.readFileSync(out + "/UPCORE.EXE");
files["PROBE.CMD"] = Buffer.from(["@echo off", "set D9WG_GDI_CURSOR=0", "sc stop v86gl", "copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc start v86gl", "if errorlevel 1 goto failed", "%~d0\\UPCORE.EXE", "if errorlevel 1 goto failed", "echo PASS private UpdateTexture probes >%~d0\\OWNER.TXT", "exit /b", ":failed", "echo FAIL private UpdateTexture probes >%~d0\\OWNER.TXT", ""].join("\r\n"));
const result = await run_xp_ram_probe({root, out, files, image: process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img", success: "PASS private UpdateTexture probes", log_files: ["UPCORE.TXT"], capture_graphics: true, expected_releases: 1, simulated_host_features:0, rendering: "Shared native8/9 SYSTEMMEM-to-DEFAULT UpdateTexture policy andprivate8@12 entry usingactual9 copy/preflight/uploads. Accurate4K26old8 intentionallyreproduces45wrong-pool successes;currentpublic8/ordinary9/core8SDK120/220 eachreject45badpairs andaccept3nativevalidpairs. Five devices/fiveReset/480textures/240poolcases/640localDWORD reads includingallcube faces. Sourceanddestination1x1x1;noGPUdraw/readback/injectedresponse/newpixelclaim. Finalmoduleunload/session/ownerrelease checked", inspect(r) {
    assert.equal(r.owners.length,1);assert.deepEqual(r.releases,r.owners);assert(r.logs["UPCORE.TXT"].includes("PASS private UpdateTexture modes=5 devices=5 resets=5 poolCases=240 legacyWrongPools=45 correctedRejected=180 localWords=640 finalRefs=0"));for(let mode=0;mode<5;mode++)assert(r.logs["UPCORE.TXT"].includes(`UPCORE CHECK mode=${mode} poolCases=48 accepted=${mode===0?48:3} rejected=${mode===0?0:45} localWords=128 kinds=3 reset=1 finalRefs=0`));
}});
console.log(JSON.stringify(result));
