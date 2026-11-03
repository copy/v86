#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {execFileSync as run} from "node:child_process";
import {fileURLToPath} from "node:url";
import {site_directory} from "../lib/site.mjs";
import {run_xp_ram_probe} from "../lib/xp_ram_probe.mjs";
const root=fileURLToPath(new URL("../../",import.meta.url)),site=site_directory(root),out=path.resolve(process.env.D9WG_RESET_OUT||root+"build/d3d-review/stage4h6f3c-scene-xp");fs.mkdirSync(out,{recursive:true});
const files={"V86GL.SYS":fs.readFileSync(site+"/glbridge/v86gl_driver/v86gl.sys")};
for(const api of [8,9]){const name="d3d"+api;run("sh",[site+"/glbridge/"+name+"proxy/build.sh",out+"/"+name+".dll"],{stdio:"pipe"});run(process.env.D9WG_CC||"i686-w64-mingw32-gcc",["-mwindows","-std=gnu99","-Os","-s","-nostdlib","-Wall","-Wextra","-Werror","-DD9WG_RESET_API="+api,"-Wl,--subsystem,windows:5.01","-Wl,-e,_WinMainCRTStartup@0","-o",out+"/RST"+api+".EXE",site+"/glbridge/sample/d3d_reset_resources_test.c","-luser32","-lkernel32"],{stdio:"pipe"});files[name.toUpperCase()+".DLL"]=fs.readFileSync(out+"/"+name+".dll");files["RST"+api+".EXE"]=fs.readFileSync(out+"/RST"+api+".EXE");}
const commands=["@echo off","set D9WG_GDI_CURSOR=0","set D9WG_PRESENT_NO_THROTTLE=0","sc stop v86gl","copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys","sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys","sc start v86gl","if errorlevel 1 goto failed"];
for(const api of [8,9])commands.push("%~d0\\RST"+api+".EXE","if errorlevel 1 goto failed");commands.push("echo PASS reset probes >%~d0\\OWNER.TXT","exit /b",":failed","echo FAIL reset probes >%~d0\\OWNER.TXT","");files["PROBE.CMD"]=Buffer.from(commands.join("\r\n"));
const result=await run_xp_ram_probe({root,out,files,image:process.env.XP_IMAGE||site+"/windowsxp/windowsxp_multidisk_C_4G.img",success:"PASS reset probes",log_files:["RST8.TXT","RST9.TXT"],capture_graphics:true,expected_releases:2,rendering:"not exercised; Reset active-Scene termination, HRESULT/cooperative-level recovery and lost Present rejection; post-Reset rendering command sequence; GPU pixels separately replayed",inspect(r){assert.equal(r.owners.length,2);for(const api of [8,9]){assert(r.logs["RST"+api+".TXT"].includes("PASS reset API="+api));assert(r.logs["RST"+api+".TXT"].includes("RESET SCENE "+api+" resetOpen=8 endRefused=15 freshPairs=15"));assert(r.logs["RST"+api+".TXT"].includes("RESET STATUS "+api+" refused=7 recovered=15 lostPresents=7 coopNotReset=28 coopReady=15 resetHR="+(api===8?"88760868":"8876086C")+" coopHR=88760869 presentHR=88760868"));};}});
console.log(JSON.stringify(result));
