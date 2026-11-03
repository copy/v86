#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {execFileSync as run} from "node:child_process";
import {fileURLToPath} from "node:url";
import {site_directory} from "../lib/site.mjs";
import {run_xp_ram_probe} from "../lib/xp_ram_probe.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url)), site = site_directory(root);
const out = path.resolve(process.env.D9WG_ADDITIONAL_LIFETIME_OUT || root + "build/d3d-review/stage4h6f7d-lifetime-xp");
process.chdir(root);
fs.mkdirSync(out, {recursive: true});
fs.rmSync(out + "/probe-result.json", {force: true}); fs.rmSync(out + "/graphics.bin", {force: true});
run("sh", [site + "/glbridge/d3d9proxy/build.sh", out + "/d3d9.dll"], {stdio: "pipe"});
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror", "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/REF9.EXE", site + "/glbridge/sample/d3d9_additional_lifetime_test.c", "-luser32", "-lkernel32"], {stdio: "pipe"});
const files = {"V86GL.SYS": fs.readFileSync(site + "/glbridge/v86gl_driver/v86gl.sys"), "D3D9.DLL": fs.readFileSync(out + "/d3d9.dll"), "REF9.EXE": fs.readFileSync(out + "/REF9.EXE")};
files["PROBE.CMD"] = Buffer.from(["@echo off", "set D9WG_GDI_CURSOR=0", "sc stop v86gl", "copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc start v86gl", "if errorlevel 1 goto failed", "%~d0\\REF9.EXE", "if errorlevel 1 goto failed", "echo PASS additional lifetime probe >%~d0\\OWNER.TXT", "exit /b", ":failed", "echo FAIL additional lifetime probe >%~d0\\OWNER.TXT", ""].join("\r\n"));
const result = await run_xp_ram_probe({root, out, files, image: process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img", success: "PASS additional lifetime probe", log_files: ["REF9.TXT"], capture_graphics: true, expected_releases: 1, rendering: "not exercised; D3D9 additional-buffer independent public counts, 32 cached surface and 32 chain-container zero-count revivals, exact device pin edges, private IUnknown finalization, device/chain-first teardown, live-chain Reset rejection/recovery and binding-only Reset cleanup", inspect(r) {
    assert.equal(r.owners.length, 1); assert(r.logs["REF9.TXT"].includes("PASS additional lifetime API=9"));
}});
console.log(JSON.stringify(result));
