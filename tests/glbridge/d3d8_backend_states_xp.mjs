#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {execFileSync as run} from "node:child_process";
import {fileURLToPath} from "node:url";
import {site_directory} from "../lib/site.mjs";
import {run_xp_ram_probe} from "../lib/xp_ram_probe.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url)), site = site_directory(root);
const out = path.resolve(process.env.D8WG_BACKEND_STATES_OUT || root + "build/d3d-review/stage4k26-backend-states-xp");
process.chdir(root);
fs.mkdirSync(out, {recursive: true});
fs.rmSync(out + "/probe-result.json", {force: true}); fs.rmSync(out + "/graphics.bin", {force: true});
const files = {"V86GL.SYS": fs.readFileSync(site + "/glbridge/v86gl_driver/v86gl.sys")};
const baseline=run("git",["show","2e3982d:glbridge/d3d8proxy/d3d8.dll"],{cwd:site,stdio:"pipe"});fs.writeFileSync(out+"/BASE8.DLL",baseline);files["BASE8.DLL"]=baseline;run("sh",[site+"/glbridge/d3d8proxy/build.sh",out+"/d3d8.dll"],{stdio:"pipe"});files["D3D8.DLL"]=fs.readFileSync(out+"/d3d8.dll");
run("sh", [site + "/glbridge/d3d9proxy/build.sh", out + "/d3d9.dll"], {stdio: "pipe"});
run("sh", [site + "/glbridge/d3d9proxy/build.sh", "--static",out + "/libd9wg_d3d9.a"], {stdio: "pipe"});
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-shared","-std=gnu99","-Os","-s","-nostdlib","-Wall","-Wextra","-Werror","-Wl,--subsystem,windows:5.01","-Wl,-e,_DllMain@12","-Wl,--kill-at","-Wl,--exclude-all-symbols","-o",out+"/CORE8.DLL",site+"/glbridge/sample/d3d8_backend_states_consumer.c",site+"/glbridge/sample/d3d8_backend_states_consumer.def",out+"/libd9wg_d3d9.a","-luser32","-lgdi32","-lkernel32"],{stdio:"pipe"});
files["CORE8.DLL"]=fs.readFileSync(out+"/CORE8.DLL");
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror", "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/STCORE.EXE", site + "/glbridge/sample/d3d8_backend_states_test.c",site+"/glbridge/sample/d3d8_backend_states8_probe.c", "-ldxguid", "-luser32", "-lkernel32"], {stdio: "pipe"});
files["D3D9.DLL"] = fs.readFileSync(out + "/d3d9.dll"); files["STCORE.EXE"] = fs.readFileSync(out + "/STCORE.EXE");
files["PROBE.CMD"] = Buffer.from(["@echo off", "set D9WG_GDI_CURSOR=0", "sc stop v86gl", "copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc start v86gl", "if errorlevel 1 goto failed", "%~d0\\STCORE.EXE", "if errorlevel 1 goto failed", "echo PASS private states8 probes >%~d0\\OWNER.TXT", "exit /b", ":failed", "echo FAIL private states8 probes >%~d0\\OWNER.TXT", ""].join("\r\n"));
const result = await run_xp_ram_probe({root, out, files, image: process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img", success: "PASS private states8 probes", log_files: ["STCORE.TXT"], capture_graphics: true, expected_releases: 1, simulated_host_features:0, rendering: "Pure shared API8 render/TSS translation and private8 backend setters. Accurate4K25old/currentpublic8,ordinary9,core8SDK120/220;five devices/fiveReset/seven droppedstates each/six ZBIAS inputs/400sampler configurations. Raw8 getters/recorded deletedstate stayfrontend-owned. Core9 onlyrecords translatedstates;recording emitsnone untilApply,Capture andReset/finalcleanup tested. No draws/readbacks/CPU injectedresponses;this is state/wire evidence,notnew GPU pixels", inspect(r) {
    assert.equal(r.owners.length,1);assert.deepEqual(r.releases,r.owners);assert(r.logs["STCORE.TXT"].includes("PASS private states8 modes=5 devices=5 resets=5 sevenDrops=35 samplers=400 finalRefs=0"));for(let mode=0;mode<5;mode++)assert(r.logs["STCORE.TXT"].includes(`STATECORE CHECK mode=${mode} sevenDrops=1 zbias=6 samplers=80 recording=1 apply=1 capture=1 rawMetadata=${mode<2?1:0} reset=1 finalRefs=0`));
}});
console.log(JSON.stringify(result));
