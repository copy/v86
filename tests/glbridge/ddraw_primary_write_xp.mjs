#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createRequire} from "node:module";
import {execFileSync as run} from "node:child_process";
import {fileURLToPath} from "node:url";
import {site_directory} from "../lib/site.mjs";
import {run_xp_ram_probe} from "../lib/xp_ram_probe.mjs";
const require=createRequire(import.meta.url),P=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"),W=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");let replies=0;
const root = fileURLToPath(new URL("../../", import.meta.url)), site = site_directory(root);
const out = path.resolve(process.env.DDRAW_PRIMARY_WRITE_OUT || root + "build/d3d-review/stage4i5-primary-xp");
process.chdir(root);
fs.mkdirSync(out, {recursive: true});
fs.rmSync(out + "/probe-result.json", {force: true}); fs.rmSync(out + "/graphics.bin", {force: true});
const files = {"V86GL.SYS": fs.readFileSync(site + "/glbridge/v86gl_driver/v86gl.sys")};
run("sh", [site + "/glbridge/ddrawproxy/build.sh", out + "/ddraw.dll"], {stdio: "pipe"});
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror", "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/PRIM.EXE", site + "/glbridge/sample/ddraw_primary_write_test.c", "-ldxguid", "-lgdi32", "-luser32", "-lkernel32"], {stdio: "pipe"});
files["DDRAW.DLL"] = fs.readFileSync(out + "/ddraw.dll"); files["PRIM.EXE"] = fs.readFileSync(out + "/PRIM.EXE");
files["PROBE.CMD"] = Buffer.from(["@echo off", "set D9WG_GDI_CURSOR=0", "sc stop v86gl", "copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc start v86gl", "if errorlevel 1 goto failed", "%~d0\\PRIM.EXE", "if errorlevel 1 goto failed", "echo PASS DirectDraw primary probes >%~d0\\OWNER.TXT", "exit /b", ":failed", "echo FAIL DirectDraw primary probes >%~d0\\OWNER.TXT", ""].join("\r\n"));
const result = await run_xp_ram_probe({root, out, files, image: process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img", success: "PASS DirectDraw primary probes", log_files: ["PRIM.TXT"], capture_graphics: true, expected_releases: 1, rendering: "Actual DD1/2/3/4/7 Blt, BltFast, WRITEONLY Unlock and GDI ReleaseDC on windowed desktop and flip-chain fronts, no Flip call; forty presentations. CPU dirty-shadow replies are zero intent data consumed only before complete overwrites, not pixel validation. GPU replay separately validates client bounds and actual colors. Existing implicit back-buffer CPU cleanup defect S2-53 remains tracked", observe_batch(message,read,write){const h=W.readHeader(message.bytes.subarray(8));W.checkStream(h.view,h.end,h.commandCount);for(let x=P.STRUCTS.BatchHeader.size;x<h.end;){const op=h.view.getUint16(x,true),n=h.view.getUint32(x+P.F.CommandHeader.size,true);if(op===P.OP.READBACK_SURFACE){const q=P.decode("ReadbackSurface",h.view,x+16,n-16),payload=Buffer.alloc(16+q.destination_bytes);Buffer.from(P.encode("ReadbackResponse",{request_id:q.request_id,byte_count:q.destination_bytes,status:P.C.D9WG_RESPONSE_OK})).copy(payload);write((16<<20)-P.C.D9WG_RESPONSE_REGION_BYTES+q.response_offset,payload);replies++;}x+=n;}}, inspect(r) {
    assert.equal(replies,10); assert.equal(r.owners.length, 1); assert(r.logs["PRIM.TXT"].includes("PASS DirectDraw primary writes"));
}});
console.log(JSON.stringify(result));
