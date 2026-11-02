#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash as create_hash } from "node:crypto";
import { execFileSync as run } from "node:child_process";
import { fileURLToPath as file_url_to_path } from "node:url";
import { site_directory } from "../lib/site.mjs";
import { run_xp_ram_probe } from "../lib/xp_ram_probe.mjs";
const root=file_url_to_path(new URL("../../",import.meta.url)),site=site_directory(root),out=path.resolve(process.env.D8WG_TWEEN_OUT||root+"build/d3d-review/stage4d2k3d-tween-xp");
fs.mkdirSync(out,{recursive:true});
const hash=p=>create_hash("sha256").update(fs.readFileSync(p)).digest("hex");
const source="glbridge/sample/d3d8_tween_draw_test.c",proxy="glbridge/d3d8proxy/d3d8_proxy.c";
run("sh",[site+"/glbridge/d3d8proxy/build.sh",out+"/D3D8.DLL"],{stdio:"pipe"});
run(process.env.D9WG_CC||"i686-w64-mingw32-gcc",["-mwindows","-std=gnu99","-Os","-s","-nostdlib","-Wall","-Wextra","-Werror","-Wl,--subsystem,windows:5.01","-Wl,-e,_WinMainCRTStartup@0","-o",out+"/TWEEN.EXE",site+"/"+source,"-luser32","-lkernel32","-ldxguid"],{stdio:"pipe"});
const files={"TWEEN.EXE":fs.readFileSync(out+"/TWEEN.EXE"),"D3D8.DLL":fs.readFileSync(out+"/D3D8.DLL"),"V86GL.SYS":fs.readFileSync(site+"/glbridge/v86gl_driver/v86gl.sys"),"PROBE.CMD":Buffer.from(["@echo off","sc stop v86gl","copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys","sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys","sc start v86gl","%~d0\\TWEEN.EXE",""].join("\r\n"))};
const result=await run_xp_ram_probe({root,out,files,image:process.env.XP_IMAGE||site+"/windowsxp/windowsxp_multidisk_C_4G.img",result_file:"TWEEN.TXT",success:"PASS D3D8 Tween draws:",log_files:["TWEEN.TXT"],capture_graphics:true,inspect(result){assert.equal(result.owners.length,1);assert.equal(result.releases.length,1);assert(result.artifacts["graphics.bin"].bytes>10000);}});
fs.writeFileSync(out+"/capture.json",JSON.stringify({api:8,source,sourceSha256:hash(site+"/"+source),proxySourceSha256:hash(site+"/"+proxy),dllSha256:hash(out+"/D3D8.DLL"),executableSha256:hash(out+"/TWEEN.EXE"),sha256:hash(out+"/graphics.bin"),bytes:fs.statSync(out+"/graphics.bin").size,frames:16,owners:result.owners},null,2)+"\n");
console.log(JSON.stringify({status:result.status,seconds:result.seconds,owners:result.owners.length,releases:result.releases.length}));
