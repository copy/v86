#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash as create_hash } from "node:crypto";
import { execFileSync as run } from "node:child_process";
import { fileURLToPath as file_url_to_path } from "node:url";
import { site_directory } from "../lib/site.mjs";
import { run_xp_ram_probe } from "../lib/xp_ram_probe.mjs";
const proxy=process.argv.includes("--proxy");assert(!(proxy&&process.argv.includes("--write-fixture")));
const root=file_url_to_path(new URL("../../",import.meta.url)),site=site_directory(root),out=path.resolve(process.env.D9WG_NATIVE_STATE_BLOCK_OUT||root+"build/d3d-review/stage4d2j3c-native-state-xp");fs.mkdirSync(out,{recursive:true});
const source="glbridge/sample/d3d7_native_state_block_reference.c",hash=p=>create_hash("sha256").update(fs.readFileSync(p)).digest("hex"),source_sha=hash(site+"/"+source);
run(process.env.D9WG_CC||"i686-w64-mingw32-gcc",["-mwindows","-std=gnu99","-Os","-s","-nostdlib","-Wall","-Wextra","-Werror",...(proxy?["-DD9WG_PROXY_CAPTURE"]:[]),"-Wl,--subsystem,windows:5.01","-Wl,-e,_WinMainCRTStartup@0","-o",out+"/CLIP.EXE",site+"/"+source,"-luser32","-lkernel32","-ldxguid"],{stdio:"pipe"});const executable_sha=hash(out+"/CLIP.EXE");
const files={"CLIP.EXE":fs.readFileSync(out+"/CLIP.EXE"),"PROBE.CMD":Buffer.from("@echo off\r\n%~d0\\CLIP.EXE\r\n")};
if(proxy){run("sh",[site+"/glbridge/ddrawproxy/build.sh",out+"/ddraw.dll"],{stdio:"pipe"});files["DDRAW.DLL"]=fs.readFileSync(out+"/ddraw.dll");files["V86GL.SYS"]=fs.readFileSync(site+"/glbridge/v86gl_driver/v86gl.sys");files["PROBE.CMD"]=Buffer.from(["@echo off","sc stop v86gl","copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys","sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys","sc start v86gl","%~d0\\CLIP.EXE",""].join("\r\n"));}
const result=await run_xp_ram_probe({root,out,files,image:process.env.XP_IMAGE||site+"/windowsxp/windowsxp_multidisk_C_4G.img",result_file:"CLIP.TXT",success:"PASS native state-block reference finished",log_files:["CLIP.TXT"],inspect(result){if(proxy){assert(result.batches>0);assert.equal(result.owners.length,1);assert.equal(result.releases.length,1);}else{assert.equal(result.batches,0);assert.equal(result.owners.length,0);}}});
const cases=result.text.split(/\r?\n/).filter(l=>l.startsWith("STATE ")).map(line=>{const match=/^STATE type=(\d+) phase=(\w+) field=(\w+) hr=([0-9a-f]+) words=([0-9a-f,]+)$/i.exec(line);assert(match,line);return {type:Number(match[1]),phase:match[2],field:match[3],hr:parseInt(match[4],16),words:match[5].split(",").map(s=>parseInt(s,16))};});assert.equal(cases.length,170);assert(cases.every(r=>r.hr===0),"Native state getter failed: "+JSON.stringify(cases.filter(r=>r.hr!==0)));
const fixture_path=root+"tests/glbridge/fixtures/d3d7_native_state_blocks.json";
if(process.argv.includes("--write-fixture"))fs.writeFileSync(fixture_path,JSON.stringify({description:"Original Microsoft system D3D7 RGB state-block scope and recording observations; independent of proxy state helpers; RAM tools and unchanged base XP image.",source,sourceSha256:source_sha,executableSha256:executable_sha,api:"Original system Microsoft D3D7 RGB",cases},null,2)+"\n");else assert.deepEqual(cases,JSON.parse(fs.readFileSync(fixture_path)).cases);
console.log(JSON.stringify({status:result.status,seconds:result.seconds,cases:cases.length,states:cases.map(r=>({type:r.type,phase:r.phase,field:r.field,first:r.words[0]}))}));
