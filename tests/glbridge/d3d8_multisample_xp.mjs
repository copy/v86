#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createRequire} from "node:module";
import {execFileSync as run} from "node:child_process";
import {fileURLToPath} from "node:url";
import {site_directory} from "../lib/site.mjs";
import {run_xp_ram_probe} from "../lib/xp_ram_probe.mjs";
import {inspect_multisample_wire,create_multisample_model} from "../lib/d3d8_multisample_wire.mjs";
const require=createRequire(import.meta.url),P=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"),root=fileURLToPath(new URL("../../",import.meta.url)),site=site_directory(root),out=path.resolve(process.env.D8WG_MSAA_OUT||root+"build/d3d-review/stage4h5b-msaa-xp");fs.mkdirSync(out,{recursive:true});
run("sh",[site+"/glbridge/d3d8proxy/build.sh",out+"/d3d8.dll"],{stdio:"pipe"});run(process.env.D9WG_CC||"i686-w64-mingw32-gcc",["-mwindows","-std=gnu99","-Os","-s","-nostdlib","-Wall","-Wextra","-Werror","-DD9WG_DRAW_API=8","-Wl,--subsystem,windows:5.01","-Wl,-e,_WinMainCRTStartup@0","-o",out+"/MSAA.EXE",site+"/glbridge/sample/d3d8_multisample_test.c","-luser32","-lkernel32","-ldxguid"],{stdio:"pipe"});
const files={"V86GL.SYS":fs.readFileSync(site+"/glbridge/v86gl_driver/v86gl.sys"),"D3D8.DLL":fs.readFileSync(out+"/d3d8.dll"),"MSAA.EXE":fs.readFileSync(out+"/MSAA.EXE"),"PROBE.CMD":Buffer.from(["@echo off","sc stop v86gl","copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys","sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys","sc start v86gl","if errorlevel 1 goto failed","%~d0\\MSAA.EXE","if errorlevel 1 goto failed","echo PASS D3D8 MSAA probe >%~d0\\OWNER.TXT","exit /b",":failed","echo FAIL shared readback probe >%~d0\\OWNER.TXT",""] .join("\r\n"))};
const model=create_multisample_model();
const result=await run_xp_ram_probe({root,out,files,image:process.env.XP_IMAGE||site+"/windowsxp/windowsxp_multidisk_C_4G.img",success:"PASS D3D8 MSAA probe",log_files:["MSAA.TXT"],capture_graphics:true,expected_releases:1,rendering:"Explicit simulated host replies for guest readback/fault recovery only; actual GPU color validation is separate replay",observe_batch(message,read,write){for(const reply of model.batch(Buffer.from(message.bytes))){write((16<<20)-P.C.D9WG_RESPONSE_REGION_BYTES+reply.request.response_offset,reply.bytes);}},inspect(r){assert.equal(r.owners.length,1);assert(r.logs["MSAA.TXT"].includes("PASS D3D8 MSAA API=8"));}});
const analysis=inspect_multisample_wire(fs.readFileSync(out+"/graphics.bin"),result);fs.writeFileSync(out+"/msaa-wire.json",JSON.stringify(analysis.wire,null,2)+"\n");fs.writeFileSync(out+"/expected-pixels.bin",analysis.expectedPixels);console.log(JSON.stringify({status:result.status,seconds:result.seconds,owners:result.owners.length,requests:analysis.wire.requests.length,pixels:analysis.wire.pixels}));
