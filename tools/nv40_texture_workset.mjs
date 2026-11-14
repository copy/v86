#!/usr/bin/env node
// Replay captured native texture accesses against fixed snapshot VRAM.
// This measures decode-cache misses and exact output bytes, not guest FPS.
import fs from "node:fs";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {NVDMA} from "../src/graphics_adapters/geforce_6800/nv_dma.js";
import {NV40State} from "../src/graphics_adapters/geforce_6800/nv40_state.js";
import {NV40Texture} from "../src/graphics_adapters/geforce_6800/nv40_texture.js";

const [stateFile,capturesFile,output="build/nv40-texture-workset.json"]=process.argv.slice(2);
assert(stateFile && capturesFile,"usage: node tools/nv40_texture_workset.mjs <state> <draw-captures.jsonl> [report.json]");
assert(output!==stateFile && output!==capturesFile,"report must not overwrite an input");
const fd=fs.openSync(stateFile,"r");let vram;
try
{
    const header=Buffer.alloc(16);assert.equal(fs.readSync(fd,header),16);
    assert.equal(header.readUInt32LE(0),0x86768676);assert.equal(header.readUInt32LE(4),8);
    const json=Buffer.alloc(header.readUInt32LE(12));assert.equal(fs.readSync(fd,json),json.length);
    const snapshot=JSON.parse(json),adapter=snapshot.state[52];
    assert.equal(adapter[0],"graphics_adapter");assert.equal(adapter[2],"geforce_6800");
    const nv=adapter[3];assert.equal(nv[0],9,"unsupported NV snapshot layout");
    const info=snapshot.buffer_infos[nv[2][39].buffer_id];assert.equal(info.length,nv[1]);
    vram=new Uint8Array(info.length);
    assert.equal(fs.readSync(fd,vram,0,vram.length,((16+json.length+3)&~3)+info.offset),vram.length);
}
finally {fs.closeSync(fd);}
const device={vram:()=>vram,vram_size:vram.length,machine:{is_bus_master:()=>true,
    validate_physical_range(){throw new Error("workset replay needs a VRAM-only texture capture");}}};
device.dma=new NVDMA(device);const state=new NV40State(device);
const captures=fs.readFileSync(capturesFile,"utf8").trim().split("\n").map(JSON.parse);
const surfaces=captures.flatMap(capture=>capture.textures||[]).map(texture=>texture.surface);
assert(surfaces.length && surfaces.every(surface=>surface.dma.target===0),"workset replay needs captured VRAM textures");
const configurations=[];
for(const [mib,entries]of [[64,256],[256,1024]])
{
    const texture=new NV40Texture(state);texture.cache_limit=mib*1048576;texture.cache_entries=entries;
    const digest=createHash("sha256"),rounds=[];
    for(let round=0;round<3;round++)
    {
        const before={...texture.stats};
        for(const surface of surfaces)for(const image of texture.images(surface))digest.update(image);
        rounds.push(Object.fromEntries(Object.entries(texture.stats).map(([key,value])=>[key,value-before[key]])));
    }
    configurations.push({mib,entries,rounds,residentBytes:texture.stats.bytes,outputSha256:digest.digest("hex")});
}
assert.equal(configurations[0].outputSha256,configurations[1].outputSha256,"cache policies must return identical native texture bytes");
const report={state:stateFile,captures:capturesFile,vramMiB:vram.length/1048576,
    draws:captures.length,textureBindings:surfaces.length,configurations,
    scope:"Captured native access order against fixed snapshot VRAM. No GPU or guest execution, evolving render-to-texture data or benchmark FPS is inferred."};
fs.writeFileSync(output,JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify(report,null,2));
