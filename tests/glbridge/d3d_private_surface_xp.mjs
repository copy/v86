#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {execFileSync as run} from "node:child_process";
import {fileURLToPath} from "node:url";
import {site_directory} from "../lib/site.mjs";
import {run_xp_ram_probe} from "../lib/xp_ram_probe.mjs";
const root=fileURLToPath(new URL("../../",import.meta.url)),site=site_directory(root),out=path.resolve(process.env.D9WG_PRIVATE_SURFACE_OUT||root+"build/d3d-review/stage4h6d3-private-xp");fs.mkdirSync(out,{recursive:true});
const files={"V86GL.SYS":fs.readFileSync(site+"/glbridge/v86gl_driver/v86gl.sys")};
for(const api of [8,9]){const name="d3d"+api;run("sh",[site+"/glbridge/"+name+"proxy/build.sh",out+"/"+name+".dll"],{stdio:"pipe"});run(process.env.D9WG_CC||"i686-w64-mingw32-gcc",["-mwindows","-std=gnu99","-Os","-s","-nostdlib","-Wall","-Wextra","-Werror","-DD9WG_PRIVATE_TEXTURES=1","-DD9WG_PRIVATE_SURFACES=1","-DD9WG_PRIVATE_API="+api,"-Wl,--subsystem,windows:5.01","-Wl,-e,_WinMainCRTStartup@0","-o",out+"/PRIV"+api+".EXE",site+"/glbridge/sample/d3d_private_data_test.c","-luser32","-lkernel32"],{stdio:"pipe"});files[name.toUpperCase()+".DLL"]=fs.readFileSync(out+"/"+name+".dll");files["PRIV"+api+".EXE"]=fs.readFileSync(out+"/PRIV"+api+".EXE");}
const commands=["@echo off","set D9WG_GDI_CURSOR=0","sc stop v86gl","copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys","sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys","sc start v86gl","if errorlevel 1 goto failed"];
for(const api of [8,9])commands.push("%~d0\\PRIV"+api+".EXE","if errorlevel 1 goto failed");commands.push("echo PASS private probes >%~d0\\OWNER.TXT","exit /b",":failed","echo FAIL private probes >%~d0\\OWNER.TXT","");files["PROBE.CMD"]=Buffer.from(commands.join("\r\n"));
const result=await run_xp_ram_probe({root,out,files,image:process.env.XP_IMAGE||site+"/windowsxp/windowsxp_multidisk_C_4G.img",success:"PASS private probes",log_files:["PRIV8.TXT","PRIV9.TXT"],capture_graphics:true,expected_releases:2,rendering:"not exercised; CPU-only private data and COM lifetime",inspect(r){assert.equal(r.owners.length,2);for(const api of [8,9])assert(r.logs["PRIV"+api+".TXT"].includes("PASS private API="+api));}});
console.log(JSON.stringify(result));
