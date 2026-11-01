#!/usr/bin/env node
// Actual app-local D3D7/8/9 software lighting through COM; no GPU claim.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync as run } from "node:child_process";
import { fileURLToPath as file_url_to_path } from "node:url";
import { site_directory } from "../lib/site.mjs";
import { run_xp_ram_probe } from "../lib/xp_ram_probe.mjs";
const root = file_url_to_path(new URL("../../", import.meta.url)), site = site_directory(root);
const out = path.resolve(process.env.D9WG_TNL_OUT || root + "build/d3d-review/stage4d2c-xp");
fs.mkdirSync(out, { recursive: true });
const files = { "V86GL.SYS": fs.readFileSync(site + "/glbridge/v86gl_driver/v86gl.sys") };
for(const api of [7, 8, 9])
{
    const name = api === 7 ? "ddraw" : "d3d" + api;
    run("sh", [site + "/glbridge/" + name + "proxy/build.sh", out + "/" + name + ".dll"], { stdio: "pipe" });
    run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror",
        "-DD9WG_TNL_API=" + api, "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/TNL" + api + ".EXE",
        site + "/glbridge/sample/d3d_process_lighting_test.c", "-luser32", "-lkernel32", "-ldxguid"], { stdio: "pipe" });
    files[name.toUpperCase() + ".DLL"] = fs.readFileSync(out + "/" + name + ".dll");
    files["TNL" + api + ".EXE"] = fs.readFileSync(out + "/TNL" + api + ".EXE");
}
files["PROBE.CMD"] = Buffer.from([
    "@echo off", "sc stop v86gl", "copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys",
    "sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc start v86gl", "if errorlevel 1 goto failed",
    "echo READY real XP TNL probes >%~d0\\OWNER.TXT", "%~d0\\tnl7.exe", "if errorlevel 1 goto failed", "type %~d0\\TNL7.TXT >>%~d0\\OWNER.TXT", "%~d0\\tnl8.exe", "if errorlevel 1 goto failed", "type %~d0\\TNL8.TXT >>%~d0\\OWNER.TXT",
    "%~d0\\tnl9.exe", "if errorlevel 1 goto failed", "type %~d0\\TNL9.TXT >>%~d0\\OWNER.TXT",
    "echo PASS all real XP TNL probes >>%~d0\\OWNER.TXT", "exit /b", ":failed", "echo FAIL real XP TNL probe >>%~d0\\OWNER.TXT", "",
].join("\r\n"));
const result = await run_xp_ram_probe({ root, out, files,
    image: process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img",
    success: "PASS all real XP TNL probes", log_files: ["TNL7.TXT", "TNL8.TXT", "TNL9.TXT"],
    inspect(result) {
        for(const text of Object.values(result.logs)) assert(text.includes("PASS all real XP ProcessVertices lighting checks"));
        assert.equal(result.releases.length, 3);assert.equal(new Set(result.releases).size, 3);
        assert(result.releases.every(owner => owner > 0));assert.equal(result.owners.length, 3);
    } });
console.log(JSON.stringify(result));
