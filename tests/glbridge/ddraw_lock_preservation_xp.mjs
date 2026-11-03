#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createRequire} from "node:module";
import {lock_requests} from "../lib/ddraw_lock_preservation_wire.mjs";
import {execFileSync as run} from "node:child_process";
import {fileURLToPath} from "node:url";
import {site_directory} from "../lib/site.mjs";
import {run_xp_ram_probe} from "../lib/xp_ram_probe.mjs";
const require = createRequire(import.meta.url), P=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js"), requests=lock_requests();let replies=0;
const root = fileURLToPath(new URL("../../", import.meta.url)), site = site_directory(root);
const out = path.resolve(process.env.DDRAW_LOCK_OUT || root + "build/d3d-review/stage4i3-lock-xp");
process.chdir(root);
fs.mkdirSync(out, {recursive: true});
fs.rmSync(out + "/probe-result.json", {force: true}); fs.rmSync(out + "/graphics.bin", {force: true});
const files = {"V86GL.SYS": fs.readFileSync(site + "/glbridge/v86gl_driver/v86gl.sys")};
run("sh", [site + "/glbridge/ddrawproxy/build.sh", out + "/ddraw.dll"], {stdio: "pipe"});
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror", "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/LOCK.EXE", site + "/glbridge/sample/ddraw_lock_preservation_test.c", "-ldxguid", "-luser32", "-lkernel32"], {stdio: "pipe"});
files["DDRAW.DLL"] = fs.readFileSync(out + "/ddraw.dll"); files["LOCK.EXE"] = fs.readFileSync(out + "/LOCK.EXE");
files["PROBE.CMD"] = Buffer.from(["@echo off", "set D9WG_GDI_CURSOR=0", "sc stop v86gl", "copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc start v86gl", "if errorlevel 1 goto failed", "%~d0\\LOCK.EXE", "if errorlevel 1 goto failed", "echo PASS DirectDraw lock probes >%~d0\\OWNER.TXT", "exit /b", ":failed", "echo FAIL DirectDraw lock probes >%~d0\\OWNER.TXT", ""].join("\r\n"));
const result = await run_xp_ram_probe({root, out, files, image: process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img", success: "PASS DirectDraw lock probes", log_files: ["LOCK.TXT"], capture_graphics: true, expected_releases: 1, rendering: "Actual DD1/2/3/4/7 full/partial WRITEONLY locks after GPU fills, exact preserved upload bytes, three malformed reply refusals and successful retries. Replies are explicit independent intent data; real pixels are separately validated by GPU replay", observe_batch(message,read,write){const h=W.readHeader(message.bytes.subarray(8));W.checkStream(h.view,h.end,h.commandCount);for(let x=P.STRUCTS.BatchHeader.size;x<h.end;){const op=h.view.getUint16(x,true),length=h.view.getUint32(x+P.F.CommandHeader.size,true);if(op===P.OP.READBACK_SURFACE){const q=P.decode("ReadbackSurface",h.view,x+P.STRUCTS.CommandHeader.size,length-P.STRUCTS.CommandHeader.size),scene=requests[replies++];assert(scene);assert.equal(q.destination_bytes,64);const payload=Buffer.alloc(80);Buffer.from(P.encode("ReadbackResponse",{request_id:q.request_id+(scene.mode==="stale-id"?1:0),byte_count:64-(scene.mode==="short-size"?4:0),status:scene.mode==="failed"?P.C.D9WG_RESPONSE_FAILED:P.C.D9WG_RESPONSE_OK})).copy(payload);for(let i=0;i<16;i++)payload.writeUInt32LE(scene.pixels[i],16+i*4);write((16<<20)-P.C.D9WG_RESPONSE_REGION_BYTES+q.response_offset,payload);}x+=length;}}, inspect(r) {
    assert.equal(replies,29); assert.equal(r.owners.length, 1); assert(r.logs["LOCK.TXT"].includes("PASS DirectDraw lock preservation"));
}});
console.log(JSON.stringify(result));
