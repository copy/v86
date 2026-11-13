#!/usr/bin/env node
// Native metadata reference; a proxy replay certifies metadata, not pixels.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {site_directory} from "../lib/site.mjs";
import {run_xp_ram_probe} from "../lib/xp_ram_probe.mjs";

const root=fileURLToPath(new URL("../../",import.meta.url)),site=site_directory(root);
const dll=process.env.DDRAW_ATTACHMENT_PROXY_DLL&&path.resolve(process.env.DDRAW_ATTACHMENT_PROXY_DLL);
const source="glbridge/sample/ddraw_attachment_reference.c";
const out=path.resolve(process.env.DDRAW_ATTACHMENT_OUT||root+"build/d3d-review/stage6-"+(dll?"proxy":"native")+"-attachments");
const sha=file=>createHash("sha256").update(fs.readFileSync(file)).digest("hex");
fs.mkdirSync(out,{recursive:true});
execFileSync(process.env.D9WG_CC||"i686-w64-mingw32-gcc",[
    "-std=gnu99","-Os","-s","-nostdlib","-Wall","-Wextra","-Werror",
    "-Wl,--subsystem,windows:5.01","-Wl,-e,_WinMainCRTStartup@0",
    ...(dll?["-DDDRAW_ATTACHMENT_PROXY=1"]:[]),
    site+"/"+source,"-o",out+"/ATTREF.EXE","-ldxguid","-luser32","-lkernel32"]);
const metadata={source,sourceSha256:sha(site+"/"+source),executableSha256:sha(out+"/ATTREF.EXE"),
    proxy:!!dll,...(dll?{dllSha256:sha(dll)}:{})};
fs.writeFileSync(out+"/source.json",JSON.stringify(metadata,null,2)+"\n");
if(process.env.DDRAW_ATTACHMENT_BUILD_ONLY==="1")process.exit(0);
const files={"ATTREF.EXE":fs.readFileSync(out+"/ATTREF.EXE")};
if(dll)Object.assign(files,{"DDRAW.DLL":fs.readFileSync(dll),
    "V86GL.SYS":fs.readFileSync(site+"/glbridge/v86gl_driver/v86gl.sys")});
files["PROBE.CMD"]=Buffer.from(["@echo off","set D9WG_GDI_CURSOR=0",...(dll?[
    "sc stop v86gl","copy /y %~d0\\V86GL.SYS C:\\WINDOWS\\system32\\drivers\\v86gl.sys",
    "sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys","sc start v86gl"]:[]),
    "%~d0\\ATTREF.EXE",""].join("\r\n"));
const r=await run_xp_ram_probe({root,out,files,image:process.env.XP_IMAGE||site+"/windowsxp/windowsxp_multidisk_C_4G.img",
    result_file:"ATTREF.TXT",log_files:["ATTREF.TXT"],success:"COMPLETE attachment reference",
    expected_releases:dll?1:0,probe_timeout_seconds:300,
    inspect(result){if(!dll){assert.equal(result.batches,0);assert.equal(result.owners.length,0);}}});
fs.writeFileSync(out+"/ATTREF.TXT",r.text);
const rows=r.text.split(/\r?\n/).filter(l=>l.startsWith("ATTACH ")).map(line=>Object.fromEntries([...line.matchAll(/(\w+)=([^\s]+)/g)].map(([,k,v])=>[k,k==="action"?v:k==="refs"?v.split(",").map(Number):parseInt(v,k.startsWith("hr_")?16:10)])));
assert.equal(rows.length,95,"All attachment/view/size records must be observed");
const results=[];
const reference={...metadata,seconds:r.seconds,batches:r.batches,rows,results};
fs.writeFileSync(out+"/reference.json",JSON.stringify(reference,null,2)+"\n");
const fixture=root+"tests/glbridge/fixtures/ddraw_native_attachments.json";
if(process.argv.includes("--write-fixture")){assert(!dll);fs.writeFileSync(fixture,JSON.stringify(reference,null,2)+"\n");}
if(dll){
    const native=JSON.parse(fs.readFileSync(fixture));
    assert.equal(metadata.sourceSha256,native.sourceSha256);
    assert.deepEqual(rows,native.rows,"Native attachment HRESULT/refcount/view fields differ");
    fs.writeFileSync(out+"/comparison.json",JSON.stringify({passed:true,rows:rows.length,results:results.length,
        nativeFixtureSha256:sha(fixture),scope:"All95 attachment HRESULT/refcount/view/size records match; acknowledged metadata transport, no GPU pixel claim."},null,2)+"\n");
}
console.log(JSON.stringify({seconds:r.seconds,batches:r.batches,rows:rows.length,results}));
