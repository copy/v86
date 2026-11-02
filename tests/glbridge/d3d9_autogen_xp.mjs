#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {execFileSync as run} from "node:child_process";
import {fileURLToPath} from "node:url";
import {site_directory} from "../lib/site.mjs";
import {inspect_autogen_wire} from "../lib/d3d_autogen_wire.mjs";
import {run_xp_ram_probe} from "../lib/xp_ram_probe.mjs";
const root=fileURLToPath(new URL("../../",import.meta.url)),site=site_directory(root),mask=Number(process.env.D9WG_AUTOGEN_HOST_MASK||15),out=path.resolve(process.env.D9WG_AUTOGEN_OUT||root+"build/d3d-review/stage4f2c-autogen-"+mask+"-xp");assert([12,15].includes(mask));fs.mkdirSync(out,{recursive:true});
run("sh",[site+"/glbridge/d3d9proxy/build.sh",out+"/D3D9.DLL"],{stdio:"pipe"});
run(process.env.D9WG_CC||"i686-w64-mingw32-gcc",["-mwindows","-std=gnu99","-Os","-s","-nostdlib","-Wall","-Wextra","-Werror","-DD9WG_AUTOGEN_HOST_MASK="+mask,"-Wl,--subsystem,windows:5.01","-Wl,-e,_WinMainCRTStartup@0","-o",out+"/AUTO.EXE",site+"/glbridge/sample/d3d9_autogen_test.c","-luser32","-lkernel32"],{stdio:"pipe"});
const files={"V86GL.SYS":fs.readFileSync(site+"/glbridge/v86gl_driver/v86gl.sys"),"D3D9.DLL":fs.readFileSync(out+"/D3D9.DLL"),"AUTO.EXE":fs.readFileSync(out+"/AUTO.EXE")};
files["PROBE.CMD"]=Buffer.from(["@echo off","sc stop v86gl","copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys","sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys","sc start v86gl","%~d0\\AUTO.EXE","if errorlevel 1 goto failed","type %~d0\\AUTO.TXT >%~d0\\OWNER.TXT","exit /b",":failed","echo FAIL autogen SDK probe >%~d0\\OWNER.TXT",""].join("\r\n"));
const result=await run_xp_ram_probe({root,out,files,image:process.env.XP_IMAGE||site+"/windowsxp/windowsxp_multidisk_C_4G.img",success:"PASS autogen SDK:",log_files:["AUTO.TXT"],capture_graphics:true,expected_releases:1,simulated_host_features:mask,rendering:"not exercised; explicitly simulated capability mask; GPU mip acceptance runs separately",inspect(r){assert(r.logs["AUTO.TXT"].includes("simulatedHost="+mask+" formats=48 objects=291 observations=2705"));assert.equal(r.owners.length,1);}});
const wire=inspect_autogen_wire(fs.readFileSync(out+"/graphics.bin"),mask);fs.writeFileSync(out+"/autogen-wire.json",JSON.stringify(wire,null,2)+"\n");
console.log(JSON.stringify({status:result.status,seconds:result.seconds,simulatedHostFeatures:mask,objects:291,observations:2705,owners:result.owners.length}));
