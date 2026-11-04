#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {execFileSync as run} from "node:child_process";
import {createRequire} from "node:module";
import {backend_front_scenes} from "../lib/d3d8_backend_front_wire.mjs";
import {fileURLToPath} from "node:url";
import {site_directory} from "../lib/site.mjs";
import {run_xp_ram_probe} from "../lib/xp_ram_probe.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url)), site = site_directory(root);
const out = path.resolve(process.env.D8WG_BACKEND_FRONT_OUT || root + "build/d3d-review/stage4k28-backend-front-xp");
const require=createRequire(import.meta.url),P=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"),W=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js"),scenes=backend_front_scenes();let replies=0;
process.chdir(root);
fs.mkdirSync(out, {recursive: true});
fs.rmSync(out + "/probe-result.json", {force: true}); fs.rmSync(out + "/graphics.bin", {force: true});
const files = {"V86GL.SYS": fs.readFileSync(site + "/glbridge/v86gl_driver/v86gl.sys")};
const baseline=run("git",["show","c5221bb:glbridge/d3d8proxy/d3d8.dll"],{cwd:site,stdio:"pipe"});fs.writeFileSync(out+"/BASE8.DLL",baseline);files["BASE8.DLL"]=baseline;run("sh",[site+"/glbridge/d3d8proxy/build.sh",out+"/d3d8.dll"],{stdio:"pipe"});files["D3D8.DLL"]=fs.readFileSync(out+"/d3d8.dll");
run("sh", [site + "/glbridge/d3d9proxy/build.sh", out + "/d3d9.dll"], {stdio: "pipe"});
run("sh", [site + "/glbridge/d3d9proxy/build.sh", "--static",out + "/libd9wg_d3d9.a"], {stdio: "pipe"});
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-shared","-std=gnu99","-Os","-s","-nostdlib","-Wall","-Wextra","-Werror","-Wl,--subsystem,windows:5.01","-Wl,-e,_DllMain@12","-Wl,--kill-at","-Wl,--exclude-all-symbols","-o",out+"/CORE8.DLL",site+"/glbridge/sample/d3d8_backend_front_consumer.c",site+"/glbridge/sample/d3d8_backend_front_consumer.def",out+"/libd9wg_d3d9.a","-luser32","-lgdi32","-lkernel32"],{stdio:"pipe"});
files["CORE8.DLL"]=fs.readFileSync(out+"/CORE8.DLL");
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror", "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/FRCORE.EXE", site + "/glbridge/sample/d3d8_backend_front_test.c",site+"/glbridge/sample/d3d8_backend_front8_probe.c", "-ldxguid", "-luser32", "-lkernel32"], {stdio: "pipe"});
files["D3D9.DLL"] = fs.readFileSync(out + "/d3d9.dll"); files["FRCORE.EXE"] = fs.readFileSync(out + "/FRCORE.EXE");
files["PROBE.CMD"] = Buffer.from(["@echo off", "set D9WG_GDI_CURSOR=0", "sc stop v86gl", "copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc start v86gl", "if errorlevel 1 goto failed", "%~d0\\FRCORE.EXE", "if errorlevel 1 goto failed", "echo PASS private front probes >%~d0\\OWNER.TXT", "exit /b", ":failed", "echo FAIL private front probes >%~d0\\OWNER.TXT", ""].join("\r\n"));
const result = await run_xp_ram_probe({root, out, files, image: process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img", success: "PASS private front probes", log_files: ["FRCORE.TXT"], capture_graphics: true, expected_releases: 1, simulated_host_features:0, rendering: "Shared API8 front readback withprivatecore8@8: accurate4K27old/currentpublic8,ordinary9,core8SDK120/220. Larger targets/exterior/X8 and2D/cube views uselegacy8rules;ordinary9referencekeepsstrictA8/equalCPUtargetrules. Five devices/fiveReset/35frontcases,29accept6reject/4095localDWORDs,10textures/18uploads,20inside/borderdraws,49readbacks/2940pixels. Reset8x8to5x3. FrontA8source replies deliberatelyretainalpha0 beforetheAPIforcesopaque,whileX8replybytesopaque byformat. Analytic CPUreadbackinjectionexplicit;actualpixels needbothGPUs. Proxyoutputscope only,nofulldesktop/windowoffset/Presenttiming/nativeHALclaim", observe_batch(message,read,write){const h=W.readHeader(message.bytes.subarray(8));W.checkStream(h.view,h.end,h.commandCount);for(let x=P.STRUCTS.BatchHeader.size;x<h.end;){const op=h.view.getUint16(x,true),n=h.view.getUint32(x+P.F.CommandHeader.size,true);if(op===P.OP.READBACK_SURFACE){const q=P.decode("ReadbackSurface",h.view,x+16,n-16),scene=scenes[replies];assert(scene,"unexpectedreadback");assert.deepEqual([q.width,q.height,q.format,q.destination_pitch,q.destination_bytes],[scene.width,scene.height,scene.format,scene.width*4,scene.width*scene.height*4]);const payload=Buffer.alloc(16+q.destination_bytes);Buffer.from(P.encode("ReadbackResponse",{request_id:q.request_id,byte_count:q.destination_bytes,status:P.C.D9WG_RESPONSE_OK})).copy(payload);for(let i=0;i<scene.pixels.length;i++)payload.writeUInt32LE(scene.pixels[i],16+i*4);write((16<<20)-P.C.D9WG_RESPONSE_REGION_BYTES+q.response_offset,payload);replies++;}x+=n;}}, inspect(r) {
    assert.equal(replies,49);assert.equal(r.owners.length,1);assert.deepEqual(r.releases,r.owners);assert(r.logs["FRCORE.TXT"].includes("PASS private front modes=5 devices=5 resets=5 cases=35 accepted=29 rejected=6 frames=20 localWords=4095 finalRefs=0"));for(let mode=0;mode<5;mode++)assert(r.logs["FRCORE.TXT"].includes(`FRONTCORE CHECK mode=${mode} accepted=${mode===2?1:7} rejected=${mode===2?6:0} localWords=819 frames=4 reset=1 finalRefs=0`));
}});
console.log(JSON.stringify(result));
