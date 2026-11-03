#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {execFileSync as run} from "node:child_process";
import {fileURLToPath} from "node:url";
import {site_directory} from "../lib/site.mjs";
import {run_xp_ram_probe} from "../lib/xp_ram_probe.mjs";
const root=fileURLToPath(new URL("../../",import.meta.url)),site=site_directory(root),out=path.resolve(process.env.D9WG_IMPLICIT_OUT||root+"build/d3d-review/stage4h6f2-implicit-xp");fs.mkdirSync(out,{recursive:true});
const files={"V86GL.SYS":fs.readFileSync(site+"/glbridge/v86gl_driver/v86gl.sys")};
for(const api of [8,9]){const name="d3d"+api;run("sh",[site+"/glbridge/"+name+"proxy/build.sh",out+"/"+name+".dll"],{stdio:"pipe"});run(process.env.D9WG_CC||"i686-w64-mingw32-gcc",["-mwindows","-std=gnu99","-Os","-s","-nostdlib","-Wall","-Wextra","-Werror","-DD9WG_IMPLICIT_API="+api,"-Wl,--subsystem,windows:5.01","-Wl,-e,_WinMainCRTStartup@0","-o",out+"/IMP"+api+".EXE",site+"/glbridge/sample/d3d_implicit_identity_test.c","-luser32","-lkernel32"],{stdio:"pipe"});files[name.toUpperCase()+".DLL"]=fs.readFileSync(out+"/"+name+".dll");files["IMP"+api+".EXE"]=fs.readFileSync(out+"/IMP"+api+".EXE");}
for(const api of [8,9]){run(process.env.D9WG_CC||"i686-w64-mingw32-gcc",["-mwindows","-std=gnu99","-Os","-s","-nostdlib","-Wall","-Wextra","-Werror","-DD9WG_PRIVATE_TEXTURES=1","-DD9WG_PRIVATE_SURFACES=1","-DD9WG_PRIVATE_API="+api,"-Wl,--subsystem,windows:5.01","-Wl,-e,_WinMainCRTStartup@0","-o",out+"/PRIV"+api+".EXE",site+"/glbridge/sample/d3d_private_data_test.c","-luser32","-lkernel32"],{stdio:"pipe"});files["PRIV"+api+".EXE"]=fs.readFileSync(out+"/PRIV"+api+".EXE");}
const commands=["@echo off","set D9WG_GDI_CURSOR=0","set D9WG_PRESENT_NO_THROTTLE=0","sc stop v86gl","copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys","sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys","sc start v86gl","if errorlevel 1 goto failed"];
for(const api of [8,9])commands.push("%~d0\\IMP"+api+".EXE","if errorlevel 1 goto failed");for(const api of [8,9])commands.push("%~d0\\PRIV"+api+".EXE","if errorlevel 1 goto failed");commands.push("echo PASS implicit probes >%~d0\\OWNER.TXT","exit /b",":failed","echo FAIL implicit probes >%~d0\\OWNER.TXT","");files["PROBE.CMD"]=Buffer.from(commands.join("\r\n"));
const result=await run_xp_ram_probe({root,out,files,image:process.env.XP_IMAGE||site+"/windowsxp/windowsxp_multidisk_C_4G.img",success:"PASS implicit probes",log_files:["IMP8.TXT","IMP9.TXT","PRIV8.TXT","PRIV9.TXT"],capture_graphics:true,expected_releases:4,rendering:"not exercised; implicit surface identity, zero/nonzero device pins, device-owned Reset and private-data regressions; no GPU pixel execution",inspect(r){assert.equal(r.owners.length,4);for(const api of [8,9]){assert(r.logs["IMP"+api+".TXT"].includes("PASS implicit API="+api));assert(r.logs["PRIV"+api+".TXT"].includes("PASS private API="+api));}}});
console.log(JSON.stringify(result));
