#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createRequire} from "node:module";
import {execFileSync as run} from "node:child_process";
import {fileURLToPath} from "node:url";
import {site_directory} from "../lib/site.mjs";
import {create_d3d_live_renderer} from "../lib/d3d_live_renderer.mjs";
import {run_xp_ram_probe} from "../lib/xp_ram_probe.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url)), site = site_directory(root);
const out = path.resolve(process.env.D9WG_STATE_BINDING_OUT || root + "build/d3d-review/stage4j6-state-binding-xp");
const require=createRequire(import.meta.url), P=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");let replies=0;
process.chdir(root);
fs.mkdirSync(out, {recursive: true});
fs.rmSync(out + "/probe-result.json", {force: true}); fs.rmSync(out + "/graphics.bin", {force: true});
const files = {"V86GL.SYS": fs.readFileSync(site + "/glbridge/v86gl_driver/v86gl.sys")};
run("sh", [site + "/glbridge/d3d9proxy/build.sh", out + "/d3d9.dll"], {stdio: "pipe"});
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror", "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/STATE9.EXE", site + "/glbridge/sample/d3d9_state_binding_test.c", "-ldxguid", "-luser32", "-lkernel32"], {stdio: "pipe"});
files["D3D9.DLL"] = fs.readFileSync(out + "/d3d9.dll"); files["STATE9.EXE"] = fs.readFileSync(out + "/STATE9.EXE");
files["PROBE.CMD"] = Buffer.from(["@echo off", "set D9WG_GDI_CURSOR=0", "sc stop v86gl", "copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc start v86gl", "if errorlevel 1 goto failed", "%~d0\\STATE9.EXE", "if errorlevel 1 goto failed", "echo PASS stateblock binding probes >%~d0\\OWNER.TXT", "exit /b", ":failed", "echo FAIL stateblock binding probes >%~d0\\OWNER.TXT", ""].join("\r\n"));
const live=process.env.D9WG_LIVE_GPU === "1" ? await create_d3d_live_renderer() : null;
try {
const result = await run_xp_ram_probe({graphics_renderer:live,root, out, files, image: process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img", success: "PASS stateblock binding probes", log_files: ["STATE9.TXT"], capture_graphics: true, expected_releases: 1, rendering: live ? "XP checks all 320 pixels returned by the actual live GPU, across stateblock capture/replacement/deletion and Reset. No simulated replies." : "Actual recorded stateblock private holds for2D/cube/volume/VB/IB/declaration/VS/PS:16 resources,two groups,65 captures,528 getter queries,64 metadata rounds. Public zero resources survive only in stateblock across successful Reset and actual Apply. Capture replacement retires original eight; block release retains live eight until explicit unbind. Recording Capture/Apply are refused. Five simulated XP replies acknowledge transport; dual GPU independently verifies320 pixels and complete guest resource cleanup", observe_batch:live ? null : function(message,read,write){const h=W.readHeader(message.bytes.subarray(8));W.checkStream(h.view,h.end,h.commandCount);for(let x=P.STRUCTS.BatchHeader.size;x<h.end;){const op=h.view.getUint16(x,true),n=h.view.getUint32(x+P.F.CommandHeader.size,true);if(op===P.OP.READBACK_SURFACE){const q=P.decode("ReadbackSurface",h.view,x+16,n-16);assert.equal(q.destination_bytes,256);const payload=Buffer.alloc(272);Buffer.from(P.encode("ReadbackResponse",{request_id:q.request_id,byte_count:256,status:P.C.D9WG_RESPONSE_OK})).copy(payload);const colors=[0xffb02010,0xff1040c0,0xff20a040,0xffc0a020,0xff304050];assert(replies<colors.length);for(let at=16;at<payload.length;at+=4)payload.writeUInt32LE(colors[replies],at);write((16<<20)-P.C.D9WG_RESPONSE_REGION_BYTES+q.response_offset,payload);replies++;}x+=n;}}, inspect(r) {
    if(live){assert.equal(live.stats.snapshot.stats.readbackRequests,5);assert.equal(live.stats.snapshot.cleanup.length,1);assert(live.stats.snapshot.cleanup.every(v=>!v.devices&&!v.resources));}else assert.equal(replies,5);assert.equal(r.owners.length, 1); assert(r.logs["STATE9.TXT"].includes("PASS D3D9 stateblock bindings"));
}});
console.log(JSON.stringify(result));
} finally {if(live){fs.writeFileSync(out+"/live-gpu.json",JSON.stringify(live.stats,null,2)+"\n");live.close();}}
