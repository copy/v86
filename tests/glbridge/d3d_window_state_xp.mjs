#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {execFileSync as run} from "node:child_process";
import {fileURLToPath} from "node:url";
import {site_directory} from "../lib/site.mjs";
import {run_xp_ram_probe} from "../lib/xp_ram_probe.mjs";
import {inspect_window_wire} from "../lib/d3d_window_wire.mjs";
const root=fileURLToPath(new URL("../../",import.meta.url)),site=site_directory(root),out=path.resolve(process.env.D9WG_WINDOW_OUT||root+"build/d3d-review/stage4g1-window-xp");fs.mkdirSync(out,{recursive:true});
const files={"V86GL.SYS":fs.readFileSync(site+"/glbridge/v86gl_driver/v86gl.sys"),"PHASE.DAT":Buffer.alloc(4)};
for(const api of [8,9,7]){const name=api===7?"ddraw":"d3d"+api;run("sh",[site+"/glbridge/"+name+"proxy/build.sh",out+"/"+name+".dll"],{stdio:"pipe"});run(process.env.D9WG_CC||"i686-w64-mingw32-gcc",["-mwindows","-std=gnu99","-Os","-s","-nostdlib","-Wall","-Wextra","-Werror","-DD9WG_WINDOW_API="+api,"-Wl,--subsystem,windows:5.01","-Wl,-e,_WinMainCRTStartup@0","-o",out+"/WIN"+api+".EXE",site+"/glbridge/sample/d3d_window_state_test.c","-luser32","-lkernel32","-ldxguid"],{stdio:"pipe"});files[name.toUpperCase()+".DLL"]=fs.readFileSync(out+"/"+name+".dll");files["WIN"+api+".EXE"]=fs.readFileSync(out+"/WIN"+api+".EXE");}
const commands=["@echo off","sc stop v86gl","copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys","sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys","sc start v86gl"];
for(const api of [8,9,7])commands.push("%~d0\\WIN"+api+".EXE","if errorlevel 1 goto failed");commands.push("echo PASS shared window SDK probes >%~d0\\OWNER.TXT","exit /b",":failed","echo FAIL shared window SDK probes >%~d0\\OWNER.TXT","");files["PROBE.CMD"]=Buffer.from(commands.join("\r\n"));
const observations=[];
const result=await run_xp_ram_probe({root,out,files,image:process.env.XP_IMAGE||site+"/windowsxp/windowsxp_multidisk_C_4G.img",success:"PASS shared window SDK probes",log_files:["WINDOW8.TXT","WINDOW9.TXT","WINDOW7.TXT"],capture_graphics:true,expected_releases:3,rendering:"not exercised; actual XP Win32 window geometry/foreground and emitted reports only",observe_batch(message,read){const data=read("PHASE.DAT");observations.push({owner:message.ownerToken,phase:data?.length===4?new DataView(data.buffer,data.byteOffset,data.byteLength).getUint32(0,true):-1});},inspect(r){for(const api of [8,9,7])assert(r.logs["WINDOW"+api+".TXT"].includes("PASS window SDK API="+api));assert.equal(r.owners.length,3);}});
fs.writeFileSync(out+"/batch-phases.json",JSON.stringify(observations,null,2)+"\n");const wire=inspect_window_wire(fs.readFileSync(out+"/graphics.bin"),observations,result);fs.writeFileSync(out+"/window-wire.json",JSON.stringify(wire,null,2)+"\n");console.log(JSON.stringify({status:result.status,seconds:result.seconds,owners:result.owners.length,steps:wire.steps.length,windowReports:wire.windowReports}));
