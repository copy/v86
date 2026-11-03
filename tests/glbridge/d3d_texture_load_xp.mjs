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
const out = path.resolve(process.env.D3D_TEXTURE_LOAD_OUT || root + "build/d3d-review/stage4i9-texture-load-xp");
const require=createRequire(import.meta.url), P=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");let replies=0;
process.chdir(root);
fs.mkdirSync(out, {recursive: true});
fs.rmSync(out + "/probe-result.json", {force: true}); fs.rmSync(out + "/graphics.bin", {force: true});
const files = {"V86GL.SYS": fs.readFileSync(site + "/glbridge/v86gl_driver/v86gl.sys")};
run("sh", [site + "/glbridge/ddrawproxy/build.sh", out + "/ddraw.dll"], {stdio: "pipe"});
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror", "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/TLOAD.EXE", site + "/glbridge/sample/d3d_texture_load_test.c", "-ldxguid", "-luser32", "-lkernel32"], {stdio: "pipe"});
files["DDRAW.DLL"] = fs.readFileSync(out + "/ddraw.dll"); files["TLOAD.EXE"] = fs.readFileSync(out + "/TLOAD.EXE");
files["PROBE.CMD"] = Buffer.from(["@echo off", "set D9WG_GDI_CURSOR=0", "sc stop v86gl", "copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc start v86gl", "if errorlevel 1 goto failed", "%~d0\\TLOAD.EXE", "if errorlevel 1 goto failed", "echo PASS texture Load probes >%~d0\\OWNER.TXT", "exit /b", ":failed", "echo FAIL texture Load probes >%~d0\\OWNER.TXT", ""].join("\r\n"));
const result = await run_xp_ram_probe({root, out, files, image: process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img", success: "PASS texture Load probes", log_files: ["TLOAD.TXT"], capture_graphics: true, expected_releases: 1, rendering: "Actual Device7 selected/empty cube faces and odd partial mip rectangles, smaller top-level mip subset with offset2, exact input immutability and four bounded refusals; Texture1/2 unequal mip counts with preserved suffixes, ALLOCONLOAD accepted prefix, required versus optional destination palette, palette identity/table and source-only versus all color-key copying. 29 real readback commands across cube levels, 2D mip subset and P8 previews; XP pixels are simulated controls and independent dual GPU replay verifies subresource images", observe_batch(message,read,write){const h=W.readHeader(message.bytes.subarray(8));W.checkStream(h.view,h.end,h.commandCount);for(let x=P.STRUCTS.BatchHeader.size;x<h.end;){const op=h.view.getUint16(x,true),n=h.view.getUint32(x+P.F.CommandHeader.size,true);if(op===P.OP.READBACK_SURFACE){const q=P.decode("ReadbackSurface",h.view,x+16,n-16);assert.equal(q.format,21);const payload=Buffer.alloc(16+q.destination_bytes);Buffer.from(P.encode("ReadbackResponse",{request_id:q.request_id,byte_count:q.destination_bytes,status:P.C.D9WG_RESPONSE_OK})).copy(payload);write((16<<20)-P.C.D9WG_RESPONSE_REGION_BYTES+q.response_offset,payload);replies++;}x+=n;}}, inspect(r) {
    assert.equal(replies,29);assert.equal(r.owners.length, 1); assert(r.logs["TLOAD.TXT"].includes("PASS texture Load mip cube and metadata"));
}});
console.log(JSON.stringify(result));
