#!/usr/bin/env node
// Actual app-local D3D8/9 CreateDevice x87 behavior; no GPU rendering claim.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync as run } from "node:child_process";
import { fileURLToPath as file_url_to_path } from "node:url";
import { site_directory } from "../lib/site.mjs";
import { run_xp_ram_probe } from "../lib/xp_ram_probe.mjs";
const root = file_url_to_path(new URL("../../", import.meta.url)), site = site_directory(root);
const out = path.resolve(process.env.D9WG_FPU_OUT || root + "build/d3d-review/stage4d2a-xp");
fs.mkdirSync(out, { recursive: true });
const files = { "V86GL.SYS": fs.readFileSync(site + "/glbridge/v86gl_driver/v86gl.sys") };
for(const api of [8, 9])
{
    const name = "d3d" + api;
    run("sh", [site + "/glbridge/" + name + "proxy/build.sh", out + "/" + name + ".dll"], { stdio: "pipe" });
    run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror",
        "-DD9WG_FPU_API=" + api, "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/FPU" + api + ".EXE",
        site + "/glbridge/sample/d3d_fpu_test.c", "-luser32", "-lkernel32"], { stdio: "pipe" });
    files[name.toUpperCase() + ".DLL"] = fs.readFileSync(out + "/" + name + ".dll");
    files["FPU" + api + ".EXE"] = fs.readFileSync(out + "/FPU" + api + ".EXE");
}
files["PROBE.CMD"] = Buffer.from([
    "@echo off", "sc stop v86gl", "copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys",
    "sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc start v86gl", "if errorlevel 1 goto failed",
    "echo READY real XP FPU probes >%~d0\\OWNER.TXT", "%~d0\\fpu8.exe", "if errorlevel 1 goto failed", "type %~d0\\FPU8.TXT >>%~d0\\OWNER.TXT",
    "%~d0\\fpu9.exe", "if errorlevel 1 goto failed", "type %~d0\\FPU9.TXT >>%~d0\\OWNER.TXT",
    "echo PASS all real XP FPU probes >>%~d0\\OWNER.TXT", "exit /b", ":failed", "echo FAIL real XP FPU probe >>%~d0\\OWNER.TXT", "",
].join("\r\n"));
const result = await run_xp_ram_probe({ root, out, files,
    image: process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img",
    success: "PASS all real XP FPU probes", log_files: ["FPU8.TXT", "FPU9.TXT"],
    inspect(result) {
        for(const text of Object.values(result.logs)) assert(text.includes("PASS all real XP FPU checks"));
        assert.equal(result.releases.length, 2);assert.equal(new Set(result.releases).size, 2);
        assert(result.releases.every(owner => owner > 0));assert.equal(result.owners.length, 2);
    } });
console.log(JSON.stringify(result));
