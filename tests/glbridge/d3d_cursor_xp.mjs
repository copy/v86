#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {execFileSync as run} from "node:child_process";
import {fileURLToPath} from "node:url";
import {site_directory} from "../lib/site.mjs";
import {run_xp_ram_probe} from "../lib/xp_ram_probe.mjs";
import {createRequire} from "node:module";
import {create_cursor_model,inspect_cursor_wire} from "../lib/d3d_cursor_wire.mjs";
const root=fileURLToPath(new URL("../../",import.meta.url)),site=site_directory(root),out=path.resolve(process.env.D9WG_CURSOR_OUT||root+"build/d3d-review/stage4h6c-cursor-xp");fs.mkdirSync(out,{recursive:true});
const files={"V86GL.SYS":fs.readFileSync(site+"/glbridge/v86gl_driver/v86gl.sys")};
for(const api of [8,9]){const name="d3d"+api;run("sh",[site+"/glbridge/"+name+"proxy/build.sh",out+"/"+name+".dll"],{stdio:"pipe"});run(process.env.D9WG_CC||"i686-w64-mingw32-gcc",["-mwindows","-std=gnu99","-Os","-s","-nostdlib","-Wall","-Wextra","-Werror","-DD9WG_CURSOR_API="+api,"-Wl,--subsystem,windows:5.01","-Wl,-e,_WinMainCRTStartup@0","-o",out+"/CUR"+api+".EXE",site+"/glbridge/sample/d3d_cursor_test.c","-luser32","-lkernel32"],{stdio:"pipe"});files[name.toUpperCase()+".DLL"]=fs.readFileSync(out+"/"+name+".dll");files["CUR"+api+".EXE"]=fs.readFileSync(out+"/CUR"+api+".EXE");}
const commands=["@echo off","set D9WG_GDI_CURSOR=0","sc stop v86gl","copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys","sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys","sc start v86gl","if errorlevel 1 goto failed"];
for(const api of [8,9])commands.push("%~d0\\CUR"+api+".EXE","if errorlevel 1 goto failed");commands.push("echo PASS cursor probes >%~d0\\OWNER.TXT","exit /b",":failed","echo FAIL cursor probes >%~d0\\OWNER.TXT","");files["PROBE.CMD"]=Buffer.from(commands.join("\r\n"));
const P=createRequire(import.meta.url)("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"),models=new Map();
const result=await run_xp_ram_probe({root,out,files,image:process.env.XP_IMAGE||site+"/windowsxp/windowsxp_multidisk_C_4G.img",success:"PASS cursor probes",log_files:["CUR8.TXT","CUR9.TXT"],capture_graphics:true,expected_releases:2,rendering:"Explicit simulated GPU cube readback for guest cursor packing; actual source, cursor scanout and raw pixels are separate GPU replay",observe_batch(message,read,write){const owner=message.ownerToken;if(!models.has(owner))models.set(owner,create_cursor_model([8,9][models.size],owner));for(const reply of models.get(owner).batch(Buffer.from(message.bytes)))write((16<<20)-P.C.D9WG_RESPONSE_REGION_BYTES+reply.request.response_offset,reply.bytes);},inspect(r){assert.equal(r.owners.length,2);for(const api of [8,9])assert(r.logs["CUR"+api+".TXT"].includes("PASS cursor API="+api));}});
const wire=inspect_cursor_wire(fs.readFileSync(out+"/graphics.bin"),result);fs.writeFileSync(out+"/cursor-wire.json",JSON.stringify(wire,null,2)+"\n");console.log(JSON.stringify({status:result.status,seconds:result.seconds,owners:result.owners.length,wire}));
