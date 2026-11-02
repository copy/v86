#!/usr/bin/env node
// Actual app-local D3D7/8/9 software lighting through COM; no GPU claim.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire as create_require } from "node:module";
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
        assert(result.logs["TNL8.TXT"].includes("PASS D3D8 deferred recording:"));
        assert(result.logs["TNL8.TXT"].includes("PASS D3D8 sparse recorded block restoration and masks"));
        for(const api of [8,9]) assert(result.logs["TNL"+api+".TXT"].includes("PASS sparse light state:"));
        assert(result.logs["TNL9.TXT"].includes("PASS D3D9 sparse recorded block restoration and masks"));
        assert.equal(result.releases.length, 3);assert.equal(new Set(result.releases).size, 3);
        assert(result.releases.every(owner => owner > 0));assert.equal(result.owners.length, 3);
    } });
if(recording_wire) {
    const require=create_require(import.meta.url),P=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"),W=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
    const bytes=fs.readFileSync(out+"/graphics.bin"),segments=[[],[]];let frames=0;
    for(let carrier=0;carrier<bytes.length;){
        const size=bytes.readUInt32LE(carrier+8),packet=bytes.subarray(carrier+20,carrier+12+size),header=W.readHeader(packet);W.checkStream(header.view,header.end,header.commandCount);
        for(let at=P.STRUCTS.BatchHeader.size;at<header.end;){
            const opcode=header.view.getUint16(at,true),length=header.view.getUint32(at+P.F.CommandHeader.size,true);
            if(frames===1||frames===2)segments[frames-1].push(P.OP_NAME[opcode]);
            if(opcode===P.OP.PRESENT)frames++;
            at+=length;
        }
        carrier+=12+size;
    }
    assert.equal(frames,3);assert(segments[0].every(name=>name==="PRESENT"||name==="WINDOW_STATE"),"recording leaked host commands: "+segments[0]);
    for(const name of ["SET_RENDER_STATE","SET_TEXTURE_STAGE_STATE","SET_VIEWPORT","SET_MATERIAL","SET_TRANSFORM","SET_STREAM_SOURCE","SET_INDICES","SET_TEXTURE","SET_FVF"])assert(segments[1].includes(name),"missing Apply command: "+name);
    fs.writeFileSync(out+"/recording-wire.json",JSON.stringify({frames,recordingCommands:segments[0],applyCommands:segments[1]},null,2)+"\n");
    console.log("PASS D3D8 recording wire: no state commands before Apply, all recorded state classes emitted by Apply");
}
console.log(JSON.stringify(result));
