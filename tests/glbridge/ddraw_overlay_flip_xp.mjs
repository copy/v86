#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {execFileSync as run} from "node:child_process";
import {fileURLToPath} from "node:url";
import {site_directory} from "../lib/site.mjs";
import {run_xp_ram_probe} from "../lib/xp_ram_probe.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url)), site = site_directory(root);
const out = path.resolve(process.env.DDRAW_OVERLAY_FLIP_OUT || root + "build/d3d-review/stage4i6-overlay-xp");
process.chdir(root);
fs.mkdirSync(out, {recursive: true});
fs.rmSync(out + "/probe-result.json", {force: true}); fs.rmSync(out + "/graphics.bin", {force: true});
const files = {"V86GL.SYS": fs.readFileSync(site + "/glbridge/v86gl_driver/v86gl.sys")};
run("sh", [site + "/glbridge/ddrawproxy/build.sh", out + "/ddraw.dll"], {stdio: "pipe"});
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror", "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/OVFL.EXE", site + "/glbridge/sample/ddraw_overlay_flip_test.c", "-ldxguid", "-luser32", "-lkernel32"], {stdio: "pipe"});
files["DDRAW.DLL"] = fs.readFileSync(out + "/ddraw.dll"); files["OVFL.EXE"] = fs.readFileSync(out + "/OVFL.EXE");
files["PROBE.CMD"] = Buffer.from(["@echo off", "set D9WG_GDI_CURSOR=0", "sc stop v86gl", "copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc start v86gl", "if errorlevel 1 goto failed", "%~d0\\OVFL.EXE", "if errorlevel 1 goto failed", "echo PASS DirectDraw overlay probes >%~d0\\OWNER.TXT", "exit /b", ":failed", "echo FAIL DirectDraw overlay probes >%~d0\\OWNER.TXT", ""].join("\r\n"));
const result = await run_xp_ram_probe({root, out, files, image: process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img", success: "PASS DirectDraw overlay probes", log_files: ["OVFL.TXT"], capture_graphics: true, expected_releases: 1, rendering: "Actual five surface Flip APIs on a three-buffer overlay chain, named/default storage and CPU-shadow checks, source rebinding, hidden/offscreen no-presentation, primary base preservation and 37 composite frames with explicit background control writes after queued SHOW/HIDE; visible Flip frames add no base write. Bridge 32x24 virtual fullscreen fallback; implicit-child cleanup remains S2-53. GPU base/composite pixels are separately replayed", inspect(r) {
    assert.equal(r.owners.length, 1); assert(r.logs["OVFL.TXT"].includes("PASS DirectDraw overlay Flip"));
}});
console.log(JSON.stringify(result));
