#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {execFileSync as run} from "node:child_process";
import {fileURLToPath} from "node:url";
import {site_directory} from "../lib/site.mjs";
import {run_xp_ram_probe} from "../lib/xp_ram_probe.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url)), site = site_directory(root);
const out = path.resolve(process.env.D8WG_ADDITIONAL_CONTAINER_OUT || root + "build/d3d-review/stage4h6f7b-container-xp");
process.chdir(root);
fs.mkdirSync(out, {recursive: true});
fs.rmSync(out + "/probe-result.json", {force: true}); fs.rmSync(out + "/graphics.bin", {force: true});
run("sh", [site + "/glbridge/d3d8proxy/build.sh", out + "/d3d8.dll"], {stdio: "pipe"});
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror", "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/CNT8.EXE", site + "/glbridge/sample/d3d8_additional_container_test.c", "-luser32", "-lkernel32"], {stdio: "pipe"});
const files = {"V86GL.SYS": fs.readFileSync(site + "/glbridge/v86gl_driver/v86gl.sys"), "D3D8.DLL": fs.readFileSync(out + "/d3d8.dll"), "CNT8.EXE": fs.readFileSync(out + "/CNT8.EXE")};
files["PROBE.CMD"] = Buffer.from(["@echo off", "set D9WG_GDI_CURSOR=0", "sc stop v86gl", "copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc start v86gl", "if errorlevel 1 goto failed", "%~d0\\CNT8.EXE", "if errorlevel 1 goto failed", "echo PASS additional container probe >%~d0\\OWNER.TXT", "exit /b", ":failed", "echo FAIL additional container probe >%~d0\\OWNER.TXT", ""].join("\r\n"));
const result = await run_xp_ram_probe({root, out, files, image: process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img", success: "PASS additional container probe", log_files: ["CNT8.TXT"], capture_graphics: true, expected_releases: 1, rendering: "not exercised; D3D8 additional backbuffer Device/IUnknown containers, exact relative device references, rejected texture IIDs, cached surface/private marker survival after chain Release, ordinary 2D/cube texture and implicit device containers", inspect(r) {
    assert.equal(r.owners.length, 1); assert(r.logs["CNT8.TXT"].includes("PASS additional container API=8"));
}});
console.log(JSON.stringify(result));
