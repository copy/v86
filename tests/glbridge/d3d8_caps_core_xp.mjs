#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createRequire} from "node:module";
import {execFileSync as run} from "node:child_process";
import {fileURLToPath} from "node:url";
import {site_directory} from "../lib/site.mjs";
import {run_xp_ram_probe} from "../lib/xp_ram_probe.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url)), site = site_directory(root);
const out = path.resolve(process.env.D8WG_CAPS_CORE_OUT || root + "build/d3d-review/stage4k3-caps-core-xp");
const require=createRequire(import.meta.url), P=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");let replies=0;
process.chdir(root);
fs.mkdirSync(out, {recursive: true});
fs.rmSync(out + "/probe-result.json", {force: true}); fs.rmSync(out + "/graphics.bin", {force: true});
const files = {"V86GL.SYS": fs.readFileSync(site + "/glbridge/v86gl_driver/v86gl.sys")};
// Immutable previously accepted DLL is the regression oracle, never a new build.
const baseline=run("git",["show","b3f9da5:glbridge/d3d8proxy/d3d8.dll"],{cwd:site,stdio:"pipe"});
fs.writeFileSync(out+"/BASE8.DLL",baseline);files["BASE8.DLL"]=baseline;

run("sh", [site + "/glbridge/d3d9proxy/build.sh", out + "/d3d9.dll"], {stdio: "pipe"});
run("sh", [site + "/glbridge/d3d8proxy/build.sh", out + "/d3d8.dll"], {stdio: "pipe"});
files["D3D8.DLL"]=fs.readFileSync(out+"/d3d8.dll");
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror", "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/CAPS8.EXE", site + "/glbridge/sample/d3d8_caps_core_test.c", site + "/glbridge/sample/d3d8_factory_core9_probe.c", "-ldxguid", "-luser32", "-lkernel32"], {stdio: "pipe"});
files["D3D9.DLL"] = fs.readFileSync(out + "/d3d9.dll"); files["CAPS8.EXE"] = fs.readFileSync(out + "/CAPS8.EXE");
files["PROBE.CMD"] = Buffer.from(["@echo off", "set D9WG_GDI_CURSOR=0", "sc stop v86gl", "copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc start v86gl", "if errorlevel 1 goto failed", "%~d0\\CAPS8.EXE", "if errorlevel 1 goto failed", "echo PASS D3D8 caps core probes >%~d0\\OWNER.TXT", "exit /b", ":failed", "echo FAIL D3D8 caps core probes >%~d0\\OWNER.TXT", ""].join("\r\n"));
const result = await run_xp_ram_probe({root, out, files, image: process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img", success: "PASS D3D8 caps core probes", log_files: ["CAPS8.TXT"], capture_graphics: true, expected_releases: 1, rendering: "Actual D3D8 shared-core caps conversion compared byte-for-byte with immutable accepted4K2 D3D8 DLL.130 root/device queries compare all53 words across four D3D9 environment configurations; native tests independently verify shared table propagation and unchanged D3D9 profiles. Retains128 factory cycles/264 identities,SDK120/220 device lifetimes and D3D9 surviving two D3D8 unloads. Baseline module keeps same owner alive;four compatibility Hellos0/0/3/0,three devices,one cache declaration,five UP/readbacks,one final owner/session end. Simulated transport replies require independent dual GPU320-pixel replay", observe_batch(message,read,write){const h=W.readHeader(message.bytes.subarray(8));W.checkStream(h.view,h.end,h.commandCount);for(let x=P.STRUCTS.BatchHeader.size;x<h.end;){const op=h.view.getUint16(x,true),n=h.view.getUint32(x+P.F.CommandHeader.size,true);if(op===P.OP.READBACK_SURFACE){const q=P.decode("ReadbackSurface",h.view,x+16,n-16);assert.equal(q.destination_bytes,256);const payload=Buffer.alloc(272);Buffer.from(P.encode("ReadbackResponse",{request_id:q.request_id,byte_count:256,status:P.C.D9WG_RESPONSE_OK})).copy(payload);write((16<<20)-P.C.D9WG_RESPONSE_REGION_BYTES+q.response_offset,payload);replies++;}x+=n;}}, inspect(r) {
    assert.equal(replies,5);assert.equal(r.owners.length, 1); assert(r.logs["CAPS8.TXT"].includes("PASS D3D8 caps core conversion"));
}});
console.log(JSON.stringify(result));
