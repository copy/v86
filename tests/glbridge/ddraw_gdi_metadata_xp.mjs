#!/usr/bin/env node
// Independent Microsoft GDI / system-ddraw observations. No proxy is loaded.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {site_directory} from "../lib/site.mjs";
import {run_xp_ram_probe} from "../lib/xp_ram_probe.mjs";
const root=fileURLToPath(new URL("../../",import.meta.url)),site=site_directory(root);
const bitmap=process.argv.includes("--bitmap"),source="glbridge/sample/ddraw_gdi_"+(bitmap?"bitmap":"surface")+"_reference.c";
const out=path.resolve(process.env.DDRAW_GDI_OUT||root+"build/d3d-review/native-gdi-"+(bitmap?"bitmap":"surface"));fs.mkdirSync(out,{recursive:true});
const sha=file=>createHash("sha256").update(fs.readFileSync(file)).digest("hex");
execFileSync(process.env.D9WG_CC||"i686-w64-mingw32-gcc",["-std=gnu99","-Os","-Wall","-Wextra","-Werror","-nostdlib","-include","stdint.h","-Wl,--subsystem,windows:5.01","-Wl,-e,_WinMainCRTStartup@0",site+"/"+source,"-o",out+"/DIBMETA.EXE","-lkernel32","-luser32","-lgdi32"],{stdio:"pipe"});
const result=await run_xp_ram_probe({root,out,image:process.env.XP_IMAGE||site+"/windowsxp/windowsxp_multidisk_C_4G.img",
    files:{"DIBMETA.EXE":fs.readFileSync(out+"/DIBMETA.EXE"),"PROBE.CMD":Buffer.from("@echo off\r\n%~d0\\DIBMETA.EXE\r\n")},
    result_file:"DIBMETA.TXT",success:"PASS DIB metadata probe finished",log_files:["DIBMETA.TXT"],expected_releases:0,
    inspect(r){assert.equal(r.batches,0,"Native reference must not use the proxy");assert.equal(r.owners.length,0);}});
fs.writeFileSync(out+"/DIBMETA.TXT",result.text);
if(bitmap){
    for(const kind of ["CreateDIBSection","GdiEntry9"]){const lines=result.text.split(/\r?\n/).filter(line=>line.startsWith("META kind="+kind+" "));assert.equal(lines.length,20);assert(lines.every(line=>/objectSize=84/.test(line)&&!/imageSize=0 /.test(line)));}
    const locks=result.text.split(/\r?\n/).filter(line=>line.startsWith("LOCK "));
    assert.equal(locks.length,2);assert(locks.every(line=>/hr=00000000 flags=0000100F ptr=(?!00000000)/.test(line)),"Native Lock returns bits without DDSD_LPSURFACE");
    const native=result.text.split(/\r?\n/).filter(line=>line.startsWith("META kind=SystemDirectDraw "));assert.equal(native.length,2);assert(native.every(line=>line.includes("imageSize=0 ")));
}else{
    for(const [depth,pixel]of [[16,"00004459"],[32,"004488CC"]]){
        assert(new RegExp("GDI DC depth="+depth+" .*objectSize=84 imageSize=0 bitsAlias=1 ").test(result.text));
        assert(result.text.includes("GDI PIXEL depth="+depth+" value="+pixel));
    }
}
fs.writeFileSync(out+"/reference.json",JSON.stringify({status:"PASS",source,sourceSha256:sha(site+"/"+source),executableSha256:sha(out+"/DIBMETA.EXE"),batches:result.batches,seconds:result.seconds,text:result.text},null,2)+"\n");
console.log(JSON.stringify({status:"PASS",reference:bitmap?"ordinary / identity DIB and system DirectDraw metadata":"native system-memory GDI DC metadata and actual borrowed pixels",seconds:result.seconds,batches:result.batches}));
