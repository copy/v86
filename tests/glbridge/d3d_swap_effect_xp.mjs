#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {execFileSync as run} from "node:child_process";
import {fileURLToPath} from "node:url";
import {site_directory} from "../lib/site.mjs";
import {run_xp_ram_probe} from "../lib/xp_ram_probe.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url)), site = site_directory(root);
const out = path.resolve(process.env.D9WG_SWAP_EFFECT_OUT || root + "build/d3d-review/stage4h6f8a-swap-effect-xp");
process.chdir(root);
fs.mkdirSync(out, {recursive: true});
fs.rmSync(out + "/probe-result.json", {force: true}); fs.rmSync(out + "/graphics.bin", {force: true});
const files = {"V86GL.SYS": fs.readFileSync(site + "/glbridge/v86gl_driver/v86gl.sys")};
for (const api of [8, 9]) {
    run("sh", [site + "/glbridge/d3d" + api + "proxy/build.sh", out + "/d3d" + api + ".dll"], {stdio: "pipe"});
    const exe = "SFX" + api + ".EXE";
    run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror", "-DD9WG_IMPLICIT_API=" + api, "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/" + exe, site + "/glbridge/sample/d3d_swap_effect_test.c", "-luser32", "-lkernel32"], {stdio: "pipe"});
    files["D3D" + api + ".DLL"] = fs.readFileSync(out + "/d3d" + api + ".dll"); files[exe] = fs.readFileSync(out + "/" + exe);
}
files["PROBE.CMD"] = Buffer.from(["@echo off", "set D9WG_GDI_CURSOR=0", "sc stop v86gl", "copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc start v86gl", "if errorlevel 1 goto failed", "%~d0\\SFX8.EXE", "if errorlevel 1 goto failed", "%~d0\\SFX9.EXE", "if errorlevel 1 goto failed", "echo PASS swap-effect probes >%~d0\\OWNER.TXT", "exit /b", ":failed", "echo FAIL swap-effect probes >%~d0\\OWNER.TXT", ""].join("\r\n"));
const result = await run_xp_ram_probe({root, out, files, image: process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img", success: "PASS swap-effect probes", log_files: ["SFX8.TXT", "SFX9.TXT"], capture_graphics: true, expected_releases: 2, rendering: "not exercised; all three D3D8/9 swap-effect entry points, COPY/COPY_VSYNC single-buffer constraints, accepted cached buffers, invalid enum/count failure atomicity, failed Reset lost state/no Present emission and successful recovery", inspect(r) {
    assert.equal(r.owners.length, 2); for (const api of [8, 9]) assert(r.logs["SFX" + api + ".TXT"].includes("PASS swap-effect validation API=" + api));
}});
console.log(JSON.stringify(result));
