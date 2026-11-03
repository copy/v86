#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {execFileSync as run} from "node:child_process";
import {fileURLToPath} from "node:url";
import {site_directory} from "../lib/site.mjs";
import {run_xp_ram_probe} from "../lib/xp_ram_probe.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url)), site = site_directory(root);
const out = path.resolve(process.env.D9WG_SELECTOR_OUT || root + "build/d3d-review/stage4h6f5b-selector-xp");
fs.mkdirSync(out, {recursive: true});
fs.rmSync(out + "/probe-result.json", {force: true}); fs.rmSync(out + "/graphics.bin", {force: true});
const files = {"V86GL.SYS": fs.readFileSync(site + "/glbridge/v86gl_driver/v86gl.sys")};
for (const api of [8, 9]) {
    run("sh", [site + "/glbridge/d3d" + api + "proxy/build.sh", out + "/d3d" + api + ".dll"], {stdio: "pipe"});
    const exe = "SEL" + api + ".EXE";
    run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror", "-DD9WG_IMPLICIT_API=" + api, "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/" + exe, site + "/glbridge/sample/d3d_backbuffer_selector_test.c", "-luser32", "-lkernel32"], {stdio: "pipe"});
    files["D3D" + api + ".DLL"] = fs.readFileSync(out + "/d3d" + api + ".dll"); files[exe] = fs.readFileSync(out + "/" + exe);
}
files["PROBE.CMD"] = Buffer.from(["@echo off", "set D9WG_GDI_CURSOR=0", "sc stop v86gl", "copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc start v86gl", "if errorlevel 1 goto failed", "%~d0\\SEL8.EXE", "if errorlevel 1 goto failed", "%~d0\\SEL9.EXE", "if errorlevel 1 goto failed", "echo PASS backbuffer selector probes >%~d0\\OWNER.TXT", "exit /b", ":failed", "echo FAIL backbuffer selector probes >%~d0\\OWNER.TXT", ""].join("\r\n"));
const result = await run_xp_ram_probe({root, out, files, image: process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img", success: "PASS backbuffer selector probes", log_files: ["SEL8.TXT", "SEL9.TXT"], capture_graphics: true, expected_releases: 2, rendering: "not exercised; D3D8/9 chain backbuffer selector/invalid-output boundaries; D3D9 implicit route and retained resource ownership", inspect(r) {
    assert.equal(r.owners.length, 2); for (const api of [8, 9]) assert(r.logs["SEL" + api + ".TXT"].includes("PASS backbuffer selectors API=" + api));
}});
console.log(JSON.stringify(result));
