#!/usr/bin/env node
function volume8_scenes(){const colors=[0xffb02010,0xff20a040,0xff1040c0,0xffc0a020];return Array.from({length:30},(_,index)=>{const step=index%6,color=step<4?colors[step]:step===4?0xffd06020:colors[2];return{index,width:8,height:8,pixels:Array(64).fill(color)};});}
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createRequire} from "node:module";
import {execFileSync as run} from "node:child_process";
import {fileURLToPath} from "node:url";
import {site_directory} from "../lib/site.mjs";
import {run_xp_ram_probe} from "../lib/xp_ram_probe.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url)), site = site_directory(root);
const out = path.resolve(process.env.D8WG_BACKEND_VOLUME_OUT || root + "build/d3d-review/stage4k24-backend-volume-xp");
const require=createRequire(import.meta.url), P=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");let replies=0;
process.chdir(root);
fs.mkdirSync(out, {recursive: true});
fs.rmSync(out + "/probe-result.json", {force: true}); fs.rmSync(out + "/graphics.bin", {force: true});
const scenes=volume8_scenes();
const files = {"V86GL.SYS": fs.readFileSync(site + "/glbridge/v86gl_driver/v86gl.sys")};
const baseline=run("git",["show","34f8555:glbridge/d3d8proxy/d3d8.dll"],{cwd:site,stdio:"pipe"});fs.writeFileSync(out+"/BASE8.DLL",baseline);files["BASE8.DLL"]=baseline;run("sh",[site+"/glbridge/d3d8proxy/build.sh",out+"/d3d8.dll"],{stdio:"pipe"});files["D3D8.DLL"]=fs.readFileSync(out+"/d3d8.dll");
run("sh", [site + "/glbridge/d3d9proxy/build.sh", out + "/d3d9.dll"], {stdio: "pipe"});
run("sh", [site + "/glbridge/d3d9proxy/build.sh", "--static",out + "/libd9wg_d3d9.a"], {stdio: "pipe"});
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-shared","-std=gnu99","-Os","-s","-nostdlib","-Wall","-Wextra","-Werror","-Wl,--subsystem,windows:5.01","-Wl,-e,_DllMain@12","-Wl,--kill-at","-Wl,--exclude-all-symbols","-o",out+"/CORE8.DLL",site+"/glbridge/sample/d3d8_backend_volume_consumer.c",site+"/glbridge/sample/d3d8_backend_volume_consumer.def",out+"/libd9wg_d3d9.a","-luser32","-lgdi32","-lkernel32"],{stdio:"pipe"});
files["CORE8.DLL"]=fs.readFileSync(out+"/CORE8.DLL");
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror", "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/VOLCORE.EXE", site + "/glbridge/sample/d3d8_backend_volume_test.c",site+"/glbridge/sample/d3d8_backend_volume8_probe.c", "-ldxguid", "-luser32", "-lkernel32"], {stdio: "pipe"});
files["D3D9.DLL"] = fs.readFileSync(out + "/d3d9.dll"); files["VOLCORE.EXE"] = fs.readFileSync(out + "/VOLCORE.EXE");
files["PROBE.CMD"] = Buffer.from(["@echo off", "set D9WG_GDI_CURSOR=0", "sc stop v86gl", "copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc start v86gl", "if errorlevel 1 goto failed", "%~d0\\VOLCORE.EXE", "if errorlevel 1 goto failed", "echo PASS private volume8 probes >%~d0\\OWNER.TXT", "exit /b", ":failed", "echo FAIL private volume8 probes >%~d0\\OWNER.TXT", ""].join("\r\n"));
const result = await run_xp_ram_probe({root, out, files, image: process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img", success: "PASS private volume8 probes", log_files: ["VOLCORE.TXT"], capture_graphics: true, expected_releases: 1, simulated_host_features:0, rendering: "Private API8 volume creation/SDK8Size32/ordinaryCPU boxlock andsliceuploads,lazy8-eager9level views. Accurate4K23old/current public8,ordinary9,core8SDK120/220;fivedevices/fiveReset/9volumes/56uploads/30sampleimages1920pixels. Fourcoloredslices/three mips,partialchild-volumeboxedit ofslice1andunchangedslice2. FourAPI8 modes CPU65twomip bit-preservation/row-slice pitch/Size and52badcalls;ordinary9refusal. GPUreadbackCPUreplies explicit analytic injection;actualpixels requiredualGPU. Fullpublic8wrapping/native alignment/full3Dfiltering remain pending", observe_batch(message,read,write){const h=W.readHeader(message.bytes.subarray(8));W.checkStream(h.view,h.end,h.commandCount);for(let x=P.STRUCTS.BatchHeader.size;x<h.end;){const op=h.view.getUint16(x,true),n=h.view.getUint32(x+P.F.CommandHeader.size,true);if(op===P.OP.READBACK_SURFACE){const q=P.decode("ReadbackSurface",h.view,x+16,n-16);const scene=scenes[replies];assert(scene);assert.equal(q.width,scene.width);assert.equal(q.height,scene.height);assert.equal(q.destination_bytes,scene.pixels.length*4);const payload=Buffer.alloc(16+q.destination_bytes);Buffer.from(P.encode("ReadbackResponse",{request_id:q.request_id,byte_count:q.destination_bytes,status:P.C.D9WG_RESPONSE_OK})).copy(payload);for(let i=0;i<scene.pixels.length;i++)payload.writeUInt32LE(scene.pixels[i],16+i*4);write((16<<20)-P.C.D9WG_RESPONSE_REGION_BYTES+q.response_offset,payload);replies++;}x+=n;}}, inspect(r) {
    assert.equal(replies,30);assert.equal(r.owners.length,1);assert(r.logs["VOLCORE.TXT"].includes("PASS private volume8 modes=5 devices=5 resets=5 frames=30 finalRefs=0"));for(let mode=0;mode<5;mode++)assert(r.logs["VOLCORE.TXT"].includes(`VOLCORE CHECK mode=${mode} invalidCases=${mode===2?0:13} cpu65=${mode===2?0:1} slices=4 mipLevels=3 partialRowPitch=16 partialSlicePitch=64 viewIdentity=1 reset=1 finalRefs=0`));
}});
console.log(JSON.stringify(result));
