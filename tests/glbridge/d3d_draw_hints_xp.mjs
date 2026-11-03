#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {execFileSync as run} from "node:child_process";
import {fileURLToPath} from "node:url";
import {site_directory} from "../lib/site.mjs";
import {run_xp_ram_probe} from "../lib/xp_ram_probe.mjs";
import {inspect_draw_hints_wire} from "../lib/d3d_draw_hints_wire.mjs";
const root=fileURLToPath(new URL("../../",import.meta.url)),site=site_directory(root),out=path.resolve(process.env.D9WG_DRAW_HINTS_OUT||root+"build/d3d-review/stage4h2a-draw-xp");fs.mkdirSync(out,{recursive:true});
const files={"V86GL.SYS":fs.readFileSync(site+"/glbridge/v86gl_driver/v86gl.sys")};
for(const api of [8,9]){const name="d3d"+api;run("sh",[site+"/glbridge/"+name+"proxy/build.sh",out+"/"+name+".dll"],{stdio:"pipe"});run(process.env.D9WG_CC||"i686-w64-mingw32-gcc",["-mwindows","-std=gnu99","-Os","-s","-nostdlib","-Wall","-Wextra","-Werror","-DD9WG_DRAW_API="+api,"-Wl,--subsystem,windows:5.01","-Wl,-e,_WinMainCRTStartup@0","-o",out+"/DRAW"+api+".EXE",site+"/glbridge/sample/d3d_draw_hints_test.c","-luser32","-lkernel32"],{stdio:"pipe"});files[name.toUpperCase()+".DLL"]=fs.readFileSync(out+"/"+name+".dll");files["DRAW"+api+".EXE"]=fs.readFileSync(out+"/DRAW"+api+".EXE");}
const commands=["@echo off","sc stop v86gl","copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys","sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys","sc start v86gl","if errorlevel 1 goto failed"];
for(const api of [8,9])commands.push("%~d0\\DRAW"+api+".EXE","if errorlevel 1 goto failed");commands.push("echo PASS draw hint probes >%~d0\\OWNER.TXT","exit /b",":failed","echo FAIL draw hint probes >%~d0\\OWNER.TXT","");files["PROBE.CMD"]=Buffer.from(commands.join("\r\n"));
const result=await run_xp_ram_probe({root,out,files,image:process.env.XP_IMAGE||site+"/windowsxp/windowsxp_multidisk_C_4G.img",success:"PASS draw hint probes",log_files:["DRAW8.TXT","DRAW9.TXT"],capture_graphics:true,expected_releases:2,rendering:"captured proxy draw commands only; pixel validation is separate GPU replay",inspect(r){assert.equal(r.owners.length,2);for(const api of [8,9])assert(r.logs["DRAW"+api+".TXT"].includes("PASS draw hints API="+api));}});
const wire=inspect_draw_hints_wire(fs.readFileSync(out+"/graphics.bin"),result);fs.writeFileSync(out+"/draw-hints-wire.json",JSON.stringify(wire,null,2)+"\n");console.log(JSON.stringify({status:result.status,seconds:result.seconds,owners:result.owners.length,wire}));
