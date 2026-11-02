#!/usr/bin/env node
// Actual app-local D3D7/8/9 software lighting through COM; no GPU claim.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { inspect_d3d9_scalar_recording_wire } from "../lib/d3d9_scalar_recording_wire.mjs";
import { inspect_d3d8_shader_lifetime_wire } from "../lib/d3d_shader_lifetime_wire.mjs";
import { inspect_d3d8_recording_wire } from "../lib/d3d_recording_wire.mjs";
import { execFileSync as run } from "node:child_process";
import { fileURLToPath as file_url_to_path } from "node:url";
import { site_directory } from "../lib/site.mjs";
import { run_xp_ram_probe } from "../lib/xp_ram_probe.mjs";
const root = file_url_to_path(new URL("../../", import.meta.url)), site = site_directory(root);
const out = path.resolve(process.env.D9WG_TNL_OUT || root + "build/d3d-review/stage4d2c-xp");
const recording_wire = process.argv.includes("--recording-wire");
fs.mkdirSync(out, { recursive: true });
const files = { "V86GL.SYS": fs.readFileSync(site + "/glbridge/v86gl_driver/v86gl.sys") };
for(const api of [7, 8, 9])
{
    const name = api === 7 ? "ddraw" : "d3d" + api;
    run("sh", [site + "/glbridge/" + name + "proxy/build.sh", out + "/" + name + ".dll"], { stdio: "pipe" });
    run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror",
        ...(recording_wire ? ["-DD9WG_RECORDING_WIRE_BARRIERS"] : []), "-DD9WG_TNL_API=" + api, "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/TNL" + api + ".EXE",
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
const result = await run_xp_ram_probe({ root, out, files, capture_graphics: recording_wire,
    image: process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img",
    success: "PASS all real XP TNL probes", log_files: ["TNL7.TXT", "TNL8.TXT", "TNL9.TXT"],
    inspect(result) {
        for(const text of Object.values(result.logs)) {
            assert(text.includes("PASS all real XP ProcessVertices lighting checks"));
            assert(text.includes("PASS shared vertex copy, bounds and layout checks"));
            assert(text.includes("PASS shared vertex fog checks"));
            assert(text.includes("PASS shared texture coordinate checks"));
            assert(text.includes("PASS shared vertex blend checks"));
        }
        assert(result.logs["TNL8.TXT"].includes("PASS D3D8 shader lifetime:"));
        assert(result.logs["TNL8.TXT"].includes("PASS D3D8 deferred recording:"));
        assert(result.logs["TNL8.TXT"].includes("PASS D3D8 constant and plane recording:"));
        assert(result.logs["TNL8.TXT"].includes("PASS D3D8 sparse recorded block restoration and masks"));
        for(const api of [8,9]) {
            assert(result.logs["TNL"+api+".TXT"].includes("PASS sparse light state:"));
            assert(result.logs["TNL"+api+".TXT"].includes("PASS shared D3D8/9 state scope checks:"));
        }
        assert(result.logs["TNL9.TXT"].includes("PASS D3D9 scalar deferred recording:"));
        assert(result.logs["TNL9.TXT"].includes("PASS D3D9 sparse recorded block restoration and masks"));
        assert.equal(result.releases.length, 3);assert.equal(new Set(result.releases).size, 3);
        assert(result.releases.every(owner => owner > 0));assert.equal(result.owners.length, 3);
    } });
if(recording_wire) {
    const wire=inspect_d3d8_recording_wire(fs.readFileSync(out+"/graphics.bin"));
    fs.writeFileSync(out+"/recording-wire.json",JSON.stringify(wire,null,2)+"\n");
    const scalar=inspect_d3d9_scalar_recording_wire(fs.readFileSync(out+"/graphics.bin"));
    fs.writeFileSync(out+"/scalar-recording-wire.json",JSON.stringify(scalar,null,2)+"\n");
    const lifetime=inspect_d3d8_shader_lifetime_wire(fs.readFileSync(out+"/graphics.bin"));
    fs.writeFileSync(out+"/shader-lifetime-wire.json",JSON.stringify(lifetime,null,2)+"\n");
    console.log("PASS D3D8 recording wire: no commands before Apply; recorded bindings, exact registers and plane coefficients emitted by Apply");
}
console.log(JSON.stringify(result));
