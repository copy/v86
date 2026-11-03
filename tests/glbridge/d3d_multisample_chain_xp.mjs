#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {execFileSync as run} from "node:child_process";
import {fileURLToPath} from "node:url";
import {site_directory} from "../lib/site.mjs";
import {run_xp_ram_probe} from "../lib/xp_ram_probe.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url)), site = site_directory(root);
const out = path.resolve(process.env.D9WG_MULTISAMPLE_CHAIN_OUT || root + "build/d3d-review/stage4h6f8c-chain-xp");
process.chdir(root);
fs.mkdirSync(out, {recursive: true});
fs.rmSync(out + "/probe-result.json", {force: true}); fs.rmSync(out + "/graphics.bin", {force: true});
const files = {"V86GL.SYS": fs.readFileSync(site + "/glbridge/v86gl_driver/v86gl.sys")};
for (const api of [8, 9]) {
    run("sh", [site + "/glbridge/d3d" + api + "proxy/build.sh", out + "/d3d" + api + ".dll"], {stdio: "pipe"});
    const exe = "MSC" + api + ".EXE";
    run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror", "-DD9WG_IMPLICIT_API=" + api, "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/" + exe, site + "/glbridge/sample/d3d_multisample_chain_test.c", "-luser32", "-lkernel32"], {stdio: "pipe"});
    files["D3D" + api + ".DLL"] = fs.readFileSync(out + "/d3d" + api + ".dll"); files[exe] = fs.readFileSync(out + "/" + exe);
}
files["PROBE.CMD"] = Buffer.from(["@echo off", "set D9WG_GDI_CURSOR=0", "sc stop v86gl", "copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc start v86gl", "if errorlevel 1 goto failed", "%~d0\\MSC8.EXE", "if errorlevel 1 goto failed", "%~d0\\MSC9.EXE", "if errorlevel 1 goto failed", "echo PASS multisample chain probes >%~d0\\OWNER.TXT", "exit /b", ":failed", "echo FAIL multisample chain probes >%~d0\\OWNER.TXT", ""].join("\r\n"));
const result = await run_xp_ram_probe({root, out, files, image: process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img", success: "PASS multisample chain probes", log_files: ["MSC8.TXT", "MSC9.TXT"], capture_graphics: true, expected_releases: 2, rendering: "not exercised in XP; both APIs advertise and construct four-sample additional buffers with exact cached sample/quality metadata; two chain frames per API before/after 32 zero-public-count revivals, retained storage/private data, binding-only Reset and exact finalization; true MSAA attachment, resolved and displayed pixels replayed independently", inspect(r) {
    assert.equal(r.owners.length, 2); for (const api of [8, 9]) assert(r.logs["MSC" + api + ".TXT"].includes("PASS multisample chains API=" + api));
}});
console.log(JSON.stringify(result));
