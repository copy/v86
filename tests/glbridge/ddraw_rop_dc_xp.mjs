#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createRequire} from "node:module";
import {execFileSync as run} from "node:child_process";
import {fileURLToPath} from "node:url";
import {site_directory} from "../lib/site.mjs";
import {create_d3d_live_renderer} from "../lib/d3d_live_renderer.mjs";
import {rop_dc_scenes} from "../lib/ddraw_rop_dc_wire.mjs";
import {run_xp_ram_probe} from "../lib/xp_ram_probe.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url)), site = site_directory(root);
const out = path.resolve(process.env.DDRAW_ROP_DC_OUT || root + "build/d3d-review/stage4i11-rop-dc-xp");
const require=createRequire(import.meta.url), P=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");let replies=0;
process.chdir(root);
fs.mkdirSync(out, {recursive: true});
fs.rmSync(out + "/probe-result.json", {force: true}); fs.rmSync(out + "/graphics.bin", {force: true});
const files = {"V86GL.SYS": fs.readFileSync(site + "/glbridge/v86gl_driver/v86gl.sys")};
run("sh", [site + "/glbridge/ddrawproxy/build.sh", out + "/ddraw.dll"], {stdio: "pipe"});
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror", "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/ROPDC.EXE", site + "/glbridge/sample/ddraw_rop_dc_test.c", "-ldxguid", "-luser32", "-lgdi32", "-lkernel32"], {stdio: "pipe"});
files["DDRAW.DLL"] = fs.readFileSync(out + "/ddraw.dll"); files["ROPDC.EXE"] = fs.readFileSync(out + "/ROPDC.EXE");
files["PROBE.CMD"] = Buffer.from(["@echo off", "set D9WG_GDI_CURSOR=0", "sc stop v86gl", "copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc start v86gl", "if errorlevel 1 goto failed", "%~d0\\ROPDC.EXE", "if errorlevel 1 goto failed", "echo PASS ROP DC probes >%~d0\\OWNER.TXT", "exit /b", ":failed", "echo FAIL legacy light probes >%~d0\\OWNER.TXT", ""].join("\r\n"));
const live=process.env.DDRAW_LIVE_GPU === "1" ? await create_d3d_live_renderer() : null;
const scenes=rop_dc_scenes();
try {
const result = await run_xp_ram_probe({graphics_renderer:live,root, out, files, image: process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img", success: "PASS ROP DC probes", log_files: ["ROPDC.TXT"], capture_graphics: true, expected_releases: 1, rendering: live ? "XP checks all 1920 pixels returned by the actual GPU for DirectDraw1/2/3/4/7 ROPs, GDI writes and own/inherited/absent palettes. No simulated replies." : "Actual DirectDraw surface1/2/3/4/7 ROPs: sourceless BLACKNESS and locked ignored-source WHITENESS, caller immutability and three refusals per API. P8 GetDC queries complete256-entry tables and uses real GDI SetPixelV for own/primary/replaced-primary/no-palette states, verifies no implicit palette binding, explicitly attaches palettes only for independent index previews. Thirty actual readbacks have simulated transport pixels; dual GPU replay validates1920 independent pixels and cleanup", observe_batch:live ? null : function(message,read,write){const h=W.readHeader(message.bytes.subarray(8));W.checkStream(h.view,h.end,h.commandCount);for(let x=P.STRUCTS.BatchHeader.size;x<h.end;){const op=h.view.getUint16(x,true),n=h.view.getUint32(x+P.F.CommandHeader.size,true);if(op===P.OP.READBACK_SURFACE){const q=P.decode("ReadbackSurface",h.view,x+16,n-16);assert.equal(q.destination_bytes,256);const payload=Buffer.alloc(272);Buffer.from(P.encode("ReadbackResponse",{request_id:q.request_id,byte_count:256,status:P.C.D9WG_RESPONSE_OK})).copy(payload);assert(scenes[replies]);for(let i=0;i<64;i++)payload.writeUInt32LE(scenes[replies].pixels[i],16+i*4);write((16<<20)-P.C.D9WG_RESPONSE_REGION_BYTES+q.response_offset,payload);replies++;}x+=n;}}, inspect(r) {
    if(live){assert.equal(live.stats.snapshot.stats.readbackRequests,30);assert.equal(live.stats.snapshot.cleanup.length,1);assert(live.stats.snapshot.cleanup.every(v=>!v.devices&&!v.resources));}else assert.equal(replies,30);assert.equal(r.owners.length, 1); assert(r.logs["ROPDC.TXT"].includes("PASS DirectDraw ROP and DC palette"));
}});
console.log(JSON.stringify(result));
} finally {if(live){fs.writeFileSync(out+"/live-gpu.json",JSON.stringify(live.stats,null,2)+"\n");await live.close();}}
