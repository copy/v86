#!/usr/bin/env node
// Complete, pinned Wine suites. A completed audit is not a conformance pass.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {site_directory} from "../lib/site.mjs";
import {parse_wine_result} from "../lib/wine_test_result.mjs";
import {run_xp_ram_probe} from "../lib/xp_ram_probe.mjs";
import {create_d3d_live_renderer} from "../lib/d3d_live_renderer.mjs";

const root=fileURLToPath(new URL("../../",import.meta.url)),site=site_directory(root);
const suites={d3d8_visual:"d3d8",d3d9_device:"d3d9",d3d9_visual:"d3d9",
    ddraw_ddraw1:"ddraw",ddraw_ddraw2:"ddraw",ddraw_ddraw4:"ddraw",ddraw_ddraw7:"ddraw"};
const suite=process.env.D3D_WINE_SUITE||"d3d8_visual",api=suites[suite];
assert(api,"Unknown complete Wine suite");
const vendor=root+"tests/glbridge/wine/",out=path.resolve(process.env.D3D_WINE_OUT||root+"build/d3d-review/wine-full-"+suite);
const manifest=JSON.parse(fs.readFileSync(vendor+"manifest.json"));
for(const file of manifest.files)assert.equal(createHash("sha256").update(fs.readFileSync(vendor+file.path)).digest("hex"),file.sha256,"Modified upstream source: "+file.path);
const applicabilityFile=process.env.D3D_WINE_APPLICABILITY;
const applicability=applicabilityFile?JSON.parse(fs.readFileSync(applicabilityFile)):null;
if(applicability) {
    assert.equal(applicability.suite,suite,"Applicability suite mismatch");
    assert.equal(applicability.sourceSha256,manifest.files.find(f=>f.path===suite+".c").sha256,"Applicability source mismatch");
    assert(Array.isArray(applicability.inapplicable),"Missing applicability records");
}
fs.mkdirSync(out,{recursive:true});
if(applicability)fs.writeFileSync(out+"/applicability.json",JSON.stringify(applicability,null,2)+"\n");
const cc=process.env.D9WG_CC||"i686-w64-mingw32-gcc";
execFileSync(cc,["-std=gnu99","-O1","-g","-DDECLSPEC_EXPORT=","-I"+vendor+"include","-c",root+"tests/glbridge/wine_debug_standalone.c","-o",out+"/debug.o"],{stdio:"inherit"});
// XP provides the PSAPI exports, not the Win7+ K32 aliases selected by newer
// SDK defaults. Keep the original tests while targeting their actual guest ABI.
execFileSync(cc,["-std=gnu99","-O1","-g","-DSTANDALONE","-DPSAPI_VERSION=1","-DDECLSPEC_EXPORT=","-I"+vendor+"include","-I"+root+"tests/glbridge/wine-compat",
    ...(suite==="d3d8_visual"?["-include",root+"tests/glbridge/wine_mingw_teb.h"]:[]),
    ...(api==="ddraw"?["-DCOBJMACROS=","-D__WINESRC__","-include","windows.h","-include","initguid.h"]:[]),
    vendor+suite+".c",out+"/debug.o","-o",out+"/WINE.EXE","-l"+api,"-ldxguid","-luser32","-lgdi32","-lole32","-lpsapi"],{stdio:"inherit"});
execFileSync("sh",[site+"/glbridge/"+api+"proxy/build.sh",out+"/"+api+".dll"],{stdio:"pipe"});
const sha256=file=>createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const rendererPage=root+"tests/glbridge/d3d_remote_renderer.html";
const rendererSources=Object.fromEntries([...fs.readFileSync(rendererPage,"utf8").matchAll(/<script src="([^"]+)"/g)]
    .map(([,relative])=>{const file=path.resolve(path.dirname(rendererPage),relative);return [path.relative(root,file),sha256(file)];}));
fs.writeFileSync(out+"/source.json",JSON.stringify({suite,commit:manifest.commit,source:manifest.files.find(f=>f.path===suite+".c"),
    dllSha256:sha256(out+"/"+api+".dll"),executableSha256:sha256(out+"/WINE.EXE"),rendererPageSha256:sha256(rendererPage),rendererSources},null,2)+"\n");
if(process.env.D3D_WINE_BUILD_ONLY==="1")process.exit(0);

const files={"V86GL.SYS":fs.readFileSync(site+"/glbridge/v86gl_driver/v86gl.sys"),
    [api.toUpperCase()+".DLL"]:fs.readFileSync(out+"/"+api+".dll"),"WINE.EXE":fs.readFileSync(out+"/WINE.EXE")};
files["PROBE.CMD"]=Buffer.from(["@echo off","set D9WG_GDI_CURSOR=0","set WINETEST_PLATFORM=windows","set WINETEST_DEBUG=1","set WINETEST_INTERACTIVE=0",
    "sc stop v86gl","copy /y %~d0\\v86gl.sys C:\\WINDOWS\\system32\\drivers\\v86gl.sys","sc config v86gl binPath= C:\\WINDOWS\\system32\\drivers\\v86gl.sys","sc start v86gl","if errorlevel 1 goto failed",
    "echo RUNNING "+suite+" >%~d0\\WINE.TXT","%~d0\\WINE.EXE >>%~d0\\WINE.TXT 2>&1","echo exit=%errorlevel% >>%~d0\\WINE.TXT","echo COMPLETE Wine full suite >%~d0\\OWNER.TXT","exit /b",":failed","echo FAIL driver startup >%~d0\\OWNER.TXT",""].join("\r\n"));
const live=await create_d3d_live_renderer();
try {
    const result=await run_xp_ram_probe({root,out,files,image:process.env.XP_IMAGE||site+"/windowsxp/windowsxp_multidisk_C_4G.img",
        success:"COMPLETE Wine full suite",log_files:["WINE.TXT"],log_completion:{"WINE.TXT":"exit="},graphics_renderer:live,
        probe_timeout_seconds:1800,
        rendering:"Complete upstream "+suite+" with Windows expectations and actual GPU readbacks; no failed assertion or unreviewed skip is accepted.",
        inspect(result) {
            fs.writeFileSync(out+"/WINE.TXT",result.logs["WINE.TXT"]);
            result.wineSummary=parse_wine_result(result.logs["WINE.TXT"],suite,{inapplicable:applicability?.inapplicable||[]});
            assert.deepEqual([...result.releases].sort(),[...result.owners].sort(),"Unreleased transport owner");
            assert(live.stats.snapshot.sessionCleanup.length>0,"Missing cleanup evidence");
            assert(live.stats.snapshot.sessionCleanup.every(row=>!row.devices&&!row.resources),"Guest left graphics resources alive");
        }});
    console.log(JSON.stringify(result));
} finally {
    fs.writeFileSync(out+"/live-gpu.json",JSON.stringify(live.stats,null,2)+"\n");
    await live.close();
}
