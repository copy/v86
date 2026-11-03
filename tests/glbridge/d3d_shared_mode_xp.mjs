#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {execFileSync as run} from "node:child_process";
import {fileURLToPath} from "node:url";
import {site_directory} from "../lib/site.mjs";
import {run_xp_ram_probe} from "../lib/xp_ram_probe.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url)), site = site_directory(root);
const out = path.resolve(process.env.D9WG_SHARED_MODE_OUT || root + "build/d3d-review/stage4h6f4c-mode-xp");
fs.mkdirSync(out, {recursive: true});
fs.rmSync(out + "/probe-result.json", {force: true}); fs.rmSync(out + "/graphics.bin", {force: true});
const files = {"V86GL.SYS": fs.readFileSync(site + "/glbridge/v86gl_driver/v86gl.sys")}, logs = [], commands = ["@echo off", "set D9WG_GDI_CURSOR=0", "set D9WG_PRESENT_NO_THROTTLE=0", "sc stop v86gl", "copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc start v86gl", "if errorlevel 1 goto failed"];
for (const api of [8, 9]) {
    run("sh", [site + "/glbridge/d3d" + api + "proxy/build.sh", out + "/d3d" + api + ".dll"], {stdio: "pipe"}); files["D3D" + api + ".DLL"] = fs.readFileSync(out + "/d3d" + api + ".dll");
    for (const unicode of [0, 1]) {
        const name = "M" + api + unicode, exe = name + ".EXE";
        run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror", "-DD9WG_MODE_API=" + api, "-DD9WG_MODE_UNICODE=" + unicode, "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/" + exe, site + "/glbridge/sample/d3d_reset_mode_test.c", "-luser32", "-lkernel32"], {stdio: "pipe"});
        files[exe] = fs.readFileSync(out + "/" + exe); logs.push(name + ".TXT"); commands.push("%~d0\\" + exe, "if errorlevel 1 goto failed");
    }
}
commands.push("echo PASS shared mode probes >%~d0\\OWNER.TXT", "exit /b", ":failed", "echo FAIL shared mode probes >%~d0\\OWNER.TXT", ""); files["PROBE.CMD"] = Buffer.from(commands.join("\r\n"));
const result = await run_xp_ram_probe({root, out, files, image: process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img", success: "PASS shared mode probes", log_files: logs, capture_graphics: true, expected_releases: 4, rendering: "shared D3D8/9 constructor/Reset/display/style/message policy, ANSI/Unicode, seven Clear/Present phases per process; GPU pixels separately replayed", inspect(r) {
    assert.equal(r.owners.length, 4); for (const name of logs) assert(r.logs[name].includes("PASS reset mode"));
}});
console.log(JSON.stringify(result));
