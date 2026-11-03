#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {execFileSync as run} from "node:child_process";
import {fileURLToPath} from "node:url";
import {site_directory} from "../lib/site.mjs";
import {run_xp_ram_probe} from "../lib/xp_ram_probe.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url)), site = site_directory(root);
const out = path.resolve(process.env.DDRAW_COLOR_KEY_OUT || root + "build/d3d-review/stage4i1-color-key-xp");
process.chdir(root);
fs.mkdirSync(out, {recursive: true});
fs.rmSync(out + "/probe-result.json", {force: true}); fs.rmSync(out + "/graphics.bin", {force: true});
const files = {"V86GL.SYS": fs.readFileSync(site + "/glbridge/v86gl_driver/v86gl.sys")};
run("sh", [site + "/glbridge/ddrawproxy/build.sh", out + "/ddraw.dll"], {stdio: "pipe"});
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror", "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/CKEY.EXE", site + "/glbridge/sample/ddraw_color_key_test.c", "-ldxguid", "-luser32", "-lkernel32"], {stdio: "pipe"});
files["DDRAW.DLL"] = fs.readFileSync(out + "/ddraw.dll"); files["CKEY.EXE"] = fs.readFileSync(out + "/CKEY.EXE");
files["PROBE.CMD"] = Buffer.from(["@echo off", "set D9WG_GDI_CURSOR=0", "sc stop v86gl", "copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc start v86gl", "if errorlevel 1 goto failed", "%~d0\\CKEY.EXE", "if errorlevel 1 goto failed", "echo PASS DirectDraw color key probes >%~d0\\OWNER.TXT", "exit /b", ":failed", "echo FAIL DirectDraw color key probes >%~d0\\OWNER.TXT", ""].join("\r\n"));
const result = await run_xp_ram_probe({root, out, files, image: process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img", success: "PASS DirectDraw color key probes", log_files: ["CKEY.TXT"], capture_graphics: true, expected_releases: 1, rendering: "DirectDraw 1/2/3/4/7 surface-key creation/set/get/descriptions, explicit ranges and immutable inputs; six 32-bit canonical/override Blt/BltFast readback requests; XP transport replies are simulated, independent GPU replay verifies the actual pixels", inspect(r) {
    assert.equal(r.owners.length, 1); assert(r.logs["CKEY.TXT"].includes("PASS DirectDraw surface color keys"));
}});
console.log(JSON.stringify(result));
