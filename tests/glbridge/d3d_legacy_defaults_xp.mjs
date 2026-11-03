#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {execFileSync as run} from "node:child_process";
import {fileURLToPath} from "node:url";
import {site_directory} from "../lib/site.mjs";
import {run_xp_ram_probe} from "../lib/xp_ram_probe.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url)), site = site_directory(root);
const out = path.resolve(process.env.D3D_LEGACY_DEFAULTS_OUT || root + "build/d3d-review/stage4i2-legacy-defaults-xp");
process.chdir(root);
fs.mkdirSync(out, {recursive: true});
fs.rmSync(out + "/probe-result.json", {force: true}); fs.rmSync(out + "/graphics.bin", {force: true});
const files = {"V86GL.SYS": fs.readFileSync(site + "/glbridge/v86gl_driver/v86gl.sys")};
run("sh", [site + "/glbridge/ddrawproxy/build.sh", out + "/ddraw.dll"], {stdio: "pipe"});
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror", "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/LDEF.EXE", site + "/glbridge/sample/d3d_legacy_defaults_test.c", "-ldxguid", "-luser32", "-lkernel32"], {stdio: "pipe"});
files["DDRAW.DLL"] = fs.readFileSync(out + "/ddraw.dll"); files["LDEF.EXE"] = fs.readFileSync(out + "/LDEF.EXE");
files["PROBE.CMD"] = Buffer.from(["@echo off", "set D9WG_GDI_CURSOR=0", "sc stop v86gl", "copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc start v86gl", "if errorlevel 1 goto failed", "%~d0\\LDEF.EXE", "if errorlevel 1 goto failed", "echo PASS legacy D3D defaults probes >%~d0\\OWNER.TXT", "exit /b", ":failed", "echo FAIL legacy D3D defaults probes >%~d0\\OWNER.TXT", ""].join("\r\n"));
const result = await run_xp_ram_probe({root, out, files, image: process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img", success: "PASS legacy D3D defaults probes", log_files: ["LDEF.TXT"], capture_graphics: true, expected_releases: 1, rendering: "Actual D3D1 Surface QI, D3D2/3/7 CreateDevice defaults; shared Device3/7 state and texture calls, legacy alpha mode opt-out/reactivation, ignored legacy states and modern obsolete state refusal; sixteen ARGB/RGB textured quads and real readback commands. XP replies are simulated; independent GPU replay validates pixels", inspect(r) {
    assert.equal(r.owners.length, 1); assert(r.logs["LDEF.TXT"].includes("PASS legacy D3D defaults and alpha"));
}});
console.log(JSON.stringify(result));
