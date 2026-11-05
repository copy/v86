#!/usr/bin/env node
// Sequential XP acceptance with actual GPU replies, never injected readbacks.
// Requires the local installed-driver XP image and MinGW guest compiler.
import fs from "node:fs";
import path from "node:path";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
const root=fileURLToPath(new URL("../../",import.meta.url));
const out=path.resolve(process.env.D3D_LIVE_MATRIX_OUT || root+"build/d3d-review/live-xp-matrix");
const profiles=[
    {api:"8",script:"d3d8_frontend_device_xp.mjs",flag:"D8WG_LIVE_GPU",output:"D8WG_FRONTEND_DEVICE_OUT",frames:28,pixels:1408},
    {api:"9",script:"d3d9_state_binding_xp.mjs",flag:"D9WG_LIVE_GPU",output:"D9WG_STATE_BINDING_OUT",frames:5,pixels:320},
    {api:"ddraw",script:"ddraw_rop_dc_xp.mjs",flag:"DDRAW_LIVE_GPU",output:"DDRAW_ROP_DC_OUT",frames:30,pixels:1920},
];
fs.mkdirSync(out,{recursive:true});
const result={status:"RUNNING",readbacks:"actual live GPU",runs:[]};
function save(){fs.writeFileSync(out+"/matrix.json",JSON.stringify(result,null,2)+"\n");}
try {
    for(const backend of ["swift","metal"])for(const profile of profiles) {
        const directory=out+"/"+profile.api+"-"+backend;
        fs.mkdirSync(directory,{recursive:true});
        const env={...process.env,GL_SWIFTSHADER:backend==="swift"?"1":"0",D8WG_PUBLIC_DEVICE:"1",[profile.flag]:"1",[profile.output]:directory};
        delete env.D8WG_FRONTEND_DEVICE_PREBUILT;
        const fd=fs.openSync(directory+"/run.log","w");
        console.log("XP live GPU:",profile.api,backend);
        let code;
        try {code=await new Promise((resolve,reject)=>{
            const child=spawn(process.execPath,[root+"tests/glbridge/"+profile.script],{cwd:root,env,stdio:["ignore",fd,fd]});
            child.on("error",reject);child.on("exit",(status,signal)=>signal?reject(new Error("Probe killed by "+signal)):resolve(status));
        });} finally {fs.closeSync(fd);}
        result.runs.push({api:profile.api,backend,directory,exitCode:code,frames:profile.frames,pixels:profile.pixels});save();
        if(code!==0)throw new Error("XP probe failed: "+directory+"/run.log");
    }
    result.status="PASS";save();console.log("PASS six XP runs: D3D8/9 and DirectDraw, SwiftShader and Metal");
} catch(error) {result.status="FAIL";result.error=String(error);save();throw error;}
