#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {execFileSync as run} from "node:child_process";
import {createRequire} from "node:module";
import {backend_rect_scenes} from "../lib/d3d8_backend_rect_wire.mjs";
import {fileURLToPath} from "node:url";
import {site_directory} from "../lib/site.mjs";
import {run_xp_ram_probe} from "../lib/xp_ram_probe.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url)), site = site_directory(root);
const out = path.resolve(process.env.D8WG_BACKEND_RECT_OUT || root + "build/d3d-review/stage4k29-backend-rect-xp");
const require=createRequire(import.meta.url),P=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"),W=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js"),scenes=backend_rect_scenes();let replies=0;
process.chdir(root);
fs.mkdirSync(out, {recursive: true});
fs.rmSync(out + "/probe-result.json", {force: true}); fs.rmSync(out + "/graphics.bin", {force: true});
const files = {"V86GL.SYS": fs.readFileSync(site + "/glbridge/v86gl_driver/v86gl.sys")};
const baseline=run("git",["show","84e5015:glbridge/d3d8proxy/d3d8.dll"],{cwd:site,stdio:"pipe"});fs.writeFileSync(out+"/BASE8.DLL",baseline);files["BASE8.DLL"]=baseline;run("sh",[site+"/glbridge/d3d8proxy/build.sh",out+"/d3d8.dll"],{stdio:"pipe"});files["D3D8.DLL"]=fs.readFileSync(out+"/d3d8.dll");
run("sh", [site + "/glbridge/d3d9proxy/build.sh", out + "/d3d9.dll"], {stdio: "pipe"});
run("sh", [site + "/glbridge/d3d9proxy/build.sh", "--static",out + "/libd9wg_d3d9.a"], {stdio: "pipe"});
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-shared","-std=gnu99","-Os","-s","-nostdlib","-Wall","-Wextra","-Werror","-Wl,--subsystem,windows:5.01","-Wl,-e,_DllMain@12","-Wl,--kill-at","-Wl,--exclude-all-symbols","-o",out+"/CORE8.DLL",site+"/glbridge/sample/d3d8_backend_rect_consumer.c",site+"/glbridge/sample/d3d8_backend_rect_consumer.def",out+"/libd9wg_d3d9.a","-luser32","-lgdi32","-lkernel32"],{stdio:"pipe"});
files["CORE8.DLL"]=fs.readFileSync(out+"/CORE8.DLL");
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror", "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/RECTCORE.EXE", site + "/glbridge/sample/d3d8_backend_rect_test.c",site+"/glbridge/sample/d3d8_backend_rect8_probe.c", "-ldxguid", "-luser32", "-lkernel32"], {stdio: "pipe"});
files["D3D9.DLL"] = fs.readFileSync(out + "/d3d9.dll"); files["RECTCORE.EXE"] = fs.readFileSync(out + "/RECTCORE.EXE");
files["PROBE.CMD"] = Buffer.from(["@echo off", "set D9WG_GDI_CURSOR=0", "sc stop v86gl", "copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc start v86gl", "if errorlevel 1 goto failed", "%~d0\\RECTCORE.EXE", "if errorlevel 1 goto failed", "echo PASS private CopyRects probes >%~d0\\OWNER.TXT", "exit /b", ":failed", "echo FAIL private CopyRects probes >%~d0\\OWNER.TXT", ""].join("\r\n"));
const result = await run_xp_ram_probe({root, out, files, image: process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img", success: "PASS private CopyRects probes", log_files: ["RECTCORE.TXT"], capture_graphics: true, expected_releases: 1, simulated_host_features:0, rendering: "Actual SDK8 publicbaseline4K28/current8 andprivatecore8SDK120/220: ordered CopyRects arrays with partial failure, CPU andcube overlap snapshots, GPU texture/cube face4 mip1 identities, regionstaging, bounds/locks/noop/Reset8x8to5x3 andlifetime. Fourdevices/fourReset/1148localDWORD checks. CPU readbackreplies explicitlyanalytic injection;20readbacks1084pixels needindependentSwiftShader/Metal replay. NoDraw/Present/nativeHAL/FPSclaim", observe_batch(message,read,write){const h=W.readHeader(message.bytes.subarray(8));W.checkStream(h.view,h.end,h.commandCount);for(let x=P.STRUCTS.BatchHeader.size;x<h.end;){const op=h.view.getUint16(x,true),n=h.view.getUint32(x+P.F.CommandHeader.size,true);if(op===P.OP.READBACK_SURFACE){const q=P.decode("ReadbackSurface",h.view,x+16,n-16),scene=scenes[replies];assert(scene,"unexpectedreadback");assert.deepEqual([q.width,q.height,q.format,q.destination_pitch,q.destination_bytes],[scene.width,scene.height,scene.format,scene.width*4,scene.width*scene.height*4]);const payload=Buffer.alloc(16+q.destination_bytes);Buffer.from(P.encode("ReadbackResponse",{request_id:q.request_id,byte_count:q.destination_bytes,status:P.C.D9WG_RESPONSE_OK})).copy(payload);for(let i=0;i<scene.pixels.length;i++)payload.writeUInt32LE(scene.pixels[i],16+i*4);write((16<<20)-P.C.D9WG_RESPONSE_REGION_BYTES+q.response_offset,payload);replies++;}x+=n;}}, inspect(r) {
    assert.equal(replies,20);assert.equal(r.owners.length,1);assert.deepEqual(r.releases,r.owners);assert(r.logs["RECTCORE.TXT"].includes("PASS private CopyRects modes=4 devices=4 resets=4 localWords=1148 finalRefs=0"));for(let mode=0;mode<4;mode++)assert(r.logs["RECTCORE.TXT"].includes(`RECTCORE CHECK mode=${mode} sdk=${mode===3?220:120} localWords=287 reset=1 finalRefs=0`));
}});
console.log(JSON.stringify(result));
