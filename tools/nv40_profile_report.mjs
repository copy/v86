#!/usr/bin/env node
// Summarize a real NV guest sampling window. Pending wall time overlaps CPU
// samples; neither semaphore counts nor concurrent runs are benchmark FPS.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const directory=process.argv[2];
assert(directory,"usage: node tools/nv40_profile_report.mjs <native-run-directory>");
const read=name=>JSON.parse(fs.readFileSync(path.join(directory,name),"utf8"));
const profile=read("cpu-profile.cpuprofile"),window=read("profile-window.json");
const nodes=new Map(profile.nodes.map(node=>[node.id,node])),parents=new Map();
for(const node of profile.nodes)for(const child of node.children||[])parents.set(child,node.id);
const chain=id=>{
    const frames=[],seen=new Set();
    while(nodes.has(id) && !seen.has(id))
    {seen.add(id);frames.push(nodes.get(id).callFrame);id=parents.get(id);}
    return frames;
};
const isNV=frame=>/nv40_|nv_(?:device|display|fifo|graph|dma|2d)|v86-geforce-6800/.test(frame.url);
const classify=id=>{
    const frames=chain(id),top=frames[0];
    if(top.functionName==="(idle)")return "Node idle";
    if(top.functionName==="(garbage collector)")return "Garbage collection";
    if(frames.some(frame=>/picture_sink|png|zlib/i.test(frame.url) || frame.functionName==="save_png"))return "PNG and capture";
    if(frames.some(frame=>isNV(frame) && frame.functionName==="render"))return "NV scanout";
    if(frames.some(frame=>/nv40_texture/.test(frame.url) || isNV(frame) && ["decode","blocks","encoded","storage","images"].includes(frame.functionName)))return "NV texture preparation";
    if(frames.some(frame=>/nv40_shader|nv40_program/.test(frame.url) || /translate_(?:vertex|fragment)_program|decode_(?:vertex|fragment)_program/.test(frame.functionName) ||
        isNV(frame) && ["program","shaders"].includes(frame.functionName)))return "NV program decode and translation";
    if(frames.some(frame=>isNV(frame) && /^(?:array_vertices|inline_vertices|vertex_value|vertex_layout)$/.test(frame.functionName)))return "NV vertex fetch";
    if(frames.some(frame=>isNV(frame) && frame.functionName==="target"))return "NV upload and attachment preparation";
    // Inspect the leaf before walking its callers: guest WASM entered from
    // NV FIFO wakeup is still guest execution, not NV device CPU work.
    if(/^wasm:/.test(top.url) || /^wasm-function|^x64_page_|^t0_|^jit_/.test(top.functionName))return "Guest WASM and JIT";
    if(isNV(top))return "Other NV device CPU";
    if(/libv86|\/src\/(?:cpu|browser\/main|main|memory|clock|jit)/.test(top.url))return "Guest runtime helpers";
    return "Node and harness";
};
assert.equal(profile.samples.length,profile.timeDeltas.length,"profile samples need their actual time weights");
const categories=new Map(),functions=new Map();let sampled=0,rawTime=0,nonMonotonicSamples=0,backwardUs=0;
for(let index=0;index<profile.samples.length;index++)
{
    const id=profile.samples[index],delta=profile.timeDeltas[index];
    assert(nodes.has(id) && Number.isFinite(delta));
    // V8 can return slightly out-of-order sample timestamps. Reconstruct
    // timestamps and hold the monotonic frontier; the next forward sample
    // absorbs that overlap instead of inventing extra elapsed time.
    rawTime+=delta;
    if(delta<0){nonMonotonicSamples++;backwardUs-=delta;}
    const next=Math.max(sampled,rawTime),us=next-sampled;
    const category=classify(id),frame=nodes.get(id).callFrame;
    categories.set(category,(categories.get(category)||0)+us);sampled=next;
    const label=(frame.functionName||"(anonymous)")+" — "+frame.url+":"+(frame.lineNumber+1);
    functions.set(label,(functions.get(label)||0)+us);
}
const duration=profile.endTime-profile.startTime;
assert(duration>0 && sampled>0);
const total=Math.max(duration,sampled),tail=Math.max(0,duration-sampled);
if(tail)categories.set("Unsampled tail",tail);
const rows=[...categories].map(([name,us])=>({name,ms:us/1000,percent:100*us/total})).sort((a,b)=>b.ms-a.ms);
const delta=(before,after)=>after?Object.fromEntries(Object.entries(after).map(([key,value])=>[key,value-(before?.[key]||0)])):null;
const result={directory,build:window.build,state:window.state,guest:window.guest,vramMiB:window.vramMiB,textureCache:window.textureCache,
    samplingWallMs:duration/1000,counterWindowMs:window.wallMs,startHandshakeMs:window.startHandshakeMs,stopHandshakeMs:window.stopHandshakeMs,
    nodeCpuMs:{user:window.nodeCpuUs.user/1000,system:window.nodeCpuUs.system/1000},
    backendPendingMs:window.backendPendingMs,primarySemaphoreReleases:window.primarySemaphoreReleases,
    gpu:delta(window.before.gpu,window.after.gpu),texture:delta(window.before.texture,window.after.texture),
    shader:delta(window.before.shader,window.after.shader),graphFaults:window.after.graphFaults,
    categories:rows,topSelfFunctions:[...functions].sort((a,b)=>b[1]-a[1]).slice(0,25).map(([name,us])=>({name,ms:us/1000,percent:100*us/total})),
    scope:"Weighted Node event-loop sampling, including idle; not Chrome/GPU hardware timings. Node process CPU includes worker threads and may exceed elapsed wall time. Pending wall time overlaps CPU samples. Isolation and scene correctness must be checked separately. No FPS or whole-suite acceptance is inferred.",
    nonMonotonicSamples,backwardUs,sampleDurationExcessUs:Math.max(0,sampled-duration)};
fs.writeFileSync(path.join(directory,"profile-report.json"),JSON.stringify(result,null,2)+"\n");
console.log(JSON.stringify({samplingWallMs:result.samplingWallMs,counterWindowMs:result.counterWindowMs,
    backendPendingMs:result.backendPendingMs,gpu:result.gpu,categories:rows},null,2));
