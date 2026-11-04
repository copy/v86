#!/usr/bin/env node
function cube8_scenes(){const colors=[0xffb02010,0xff20a040,0xff1040c0,0xffc0a020,0xff8020c0,0xff20a0c0];return Array.from({length:45},(_,index)=>{const step=index%9,color=step<6?colors[step]:step===6?0xffd06020:step===7?colors[5]:0xff0000ff;return{index,width:8,height:8,pixels:Array(64).fill(color)};});}
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createRequire} from "node:module";
import {execFileSync as run} from "node:child_process";
import {fileURLToPath} from "node:url";
import {site_directory} from "../lib/site.mjs";
import {run_xp_ram_probe} from "../lib/xp_ram_probe.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url)), site = site_directory(root);
const out = path.resolve(process.env.D8WG_BACKEND_CUBE_OUT || root + "build/d3d-review/stage4k23-backend-cube-xp");
const require=createRequire(import.meta.url), P=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");let replies=0;
process.chdir(root);
fs.mkdirSync(out, {recursive: true});
fs.rmSync(out + "/probe-result.json", {force: true}); fs.rmSync(out + "/graphics.bin", {force: true});
const scenes=cube8_scenes();
const files = {"V86GL.SYS": fs.readFileSync(site + "/glbridge/v86gl_driver/v86gl.sys")};
const baseline=run("git",["show","6c4f81d:glbridge/d3d8proxy/d3d8.dll"],{cwd:site,stdio:"pipe"});fs.writeFileSync(out+"/BASE8.DLL",baseline);files["BASE8.DLL"]=baseline;run("sh",[site+"/glbridge/d3d8proxy/build.sh",out+"/d3d8.dll"],{stdio:"pipe"});files["D3D8.DLL"]=fs.readFileSync(out+"/d3d8.dll");
run("sh", [site + "/glbridge/d3d9proxy/build.sh", out + "/d3d9.dll"], {stdio: "pipe"});
run("sh", [site + "/glbridge/d3d9proxy/build.sh", "--static",out + "/libd9wg_d3d9.a"], {stdio: "pipe"});
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-shared","-std=gnu99","-Os","-s","-nostdlib","-Wall","-Wextra","-Werror","-Wl,--subsystem,windows:5.01","-Wl,-e,_DllMain@12","-Wl,--kill-at","-Wl,--exclude-all-symbols","-o",out+"/CORE8.DLL",site+"/glbridge/sample/d3d8_backend_cube_consumer.c",site+"/glbridge/sample/d3d8_backend_cube_consumer.def",out+"/libd9wg_d3d9.a","-luser32","-lgdi32","-lkernel32"],{stdio:"pipe"});
files["CORE8.DLL"]=fs.readFileSync(out+"/CORE8.DLL");
run(process.env.D9WG_CC || "i686-w64-mingw32-gcc", ["-mwindows", "-std=gnu99", "-Os", "-s", "-nostdlib", "-Wall", "-Wextra", "-Werror", "-Wl,--subsystem,windows:5.01", "-Wl,-e,_WinMainCRTStartup@0", "-o", out + "/CUBECORE.EXE", site + "/glbridge/sample/d3d8_backend_cube_test.c",site+"/glbridge/sample/d3d8_backend_cube8_probe.c", "-ldxguid", "-luser32", "-lkernel32"], {stdio: "pipe"});
files["D3D9.DLL"] = fs.readFileSync(out + "/d3d9.dll"); files["CUBECORE.EXE"] = fs.readFileSync(out + "/CUBECORE.EXE");
files["PROBE.CMD"] = Buffer.from(["@echo off", "set D9WG_GDI_CURSOR=0", "sc stop v86gl", "copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys", "sc start v86gl", "if errorlevel 1 goto failed", "%~d0\\CUBECORE.EXE", "if errorlevel 1 goto failed", "echo PASS private cube8 probes >%~d0\\OWNER.TXT", "exit /b", ":failed", "echo FAIL private cube8 probes >%~d0\\OWNER.TXT", ""].join("\r\n"));
const result = await run_xp_ram_probe({root, out, files, image: process.env.XP_IMAGE || site + "/windowsxp/windowsxp_multidisk_C_4G.img", success: "PASS private cube8 probes", log_files: ["CUBECORE.TXT"], capture_graphics: true, expected_releases: 1, simulated_host_features:0, rendering: "Private API8 cube creation/ordinary CPU face locks/uploads,accurate4K22old/current public8,ordinary9,core8SDK120/220. Sixfaces/three mips,face4partial surfacechildedit andface5isolation,BC1cubeblue. Five devices/fiveReset/45images2880pixels,14cubes/173uploads. CPU65sixfaces/twomips in4API8modes,ordinary9refusal,32invalidAPI8calls. CPU GPUreadback replies explicitlyanalytic injection;actual samplingrequires independentSwiftShader/Metal. Renderablecubeface readback/fullpublic8wrapping/native alignment remain pending", observe_batch(message,read,write){const h=W.readHeader(message.bytes.subarray(8));W.checkStream(h.view,h.end,h.commandCount);for(let x=P.STRUCTS.BatchHeader.size;x<h.end;){const op=h.view.getUint16(x,true),n=h.view.getUint32(x+P.F.CommandHeader.size,true);if(op===P.OP.READBACK_SURFACE){const q=P.decode("ReadbackSurface",h.view,x+16,n-16);const scene=scenes[replies];assert(scene);assert.equal(q.width,scene.width);assert.equal(q.height,scene.height);assert.equal(q.destination_bytes,scene.pixels.length*4);const payload=Buffer.alloc(16+q.destination_bytes);Buffer.from(P.encode("ReadbackResponse",{request_id:q.request_id,byte_count:q.destination_bytes,status:P.C.D9WG_RESPONSE_OK})).copy(payload);for(let i=0;i<scene.pixels.length;i++)payload.writeUInt32LE(scene.pixels[i],16+i*4);write((16<<20)-P.C.D9WG_RESPONSE_REGION_BYTES+q.response_offset,payload);replies++;}x+=n;}}, inspect(r) {
    assert.equal(replies,45);assert.equal(r.owners.length,1);assert(r.logs["CUBECORE.TXT"].includes("PASS private cube8 modes=5 devices=5 resets=5 frames=45 finalRefs=0"));for(let mode=0;mode<5;mode++)assert(r.logs["CUBECORE.TXT"].includes(`CUBECORE CHECK mode=${mode} invalidCases=${mode===2?0:8} cpu65=${mode===2?0:1} faces=6 mipLevels=3 partialPitch=16 surfaceIdentity=1 BC1=1 reset=1 finalRefs=0`));
}});
console.log(JSON.stringify(result));
