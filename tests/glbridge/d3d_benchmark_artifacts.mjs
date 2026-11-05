#!/usr/bin/env node
// Export the current hdb RAM overlay, extract named FAT32 benchmark artifacts,
// then remove only this export's chunks after every requested file was found.
// Wait for XP to flush saved files before running; a missing file is a failure.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {read_fat32_file, list_fat32_directory} from "../lib/fat32_reader.mjs";
const [directory, ...requested] = process.argv.slice(2);
if(!directory || !requested.length) throw new Error("Usage: d3d_benchmark_artifacts.mjs RUN_DIRECTORY FILE... [Quality/*]");
const output = path.resolve(directory), prefix = "artifact-" + crypto.randomUUID();
const control = JSON.parse(fs.readFileSync(path.join(output, "control.json")));
const ws = new WebSocket(control.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {ws.onopen=resolve;ws.onerror=reject;});
let manifest;
try {
    manifest = await new Promise((resolve, reject) => {
        const timeout=setTimeout(()=>reject(new Error("Guest disk export timed out")),300000);
        ws.onmessage=({data})=>{
            const message=JSON.parse(data);if(message.id!==1)return;
            clearTimeout(timeout);
            if(message.error || message.result.exceptionDetails) reject(new Error(JSON.stringify(message)));
            else resolve(message.result.result.value);
        };
        const expression=`(async()=>{
            const chunks=[];
            await vm.export_disk_image("hdb",{write:async bytes=>{
                const name=${JSON.stringify(prefix)}+"-"+String(chunks.length).padStart(6,"0")+".bin";
                const response=await fetch("/__test_file?name="+name,{method:"POST",body:bytes});
                if(!response.ok)throw new Error("Artifact upload failed");
                chunks.push({name,size:bytes.length});
            }});
            return {state:"complete",chunks};
        })()`;
        ws.send(JSON.stringify({id:1,method:"Runtime.evaluate",params:{expression,awaitPromise:true,returnByValue:true}}));
    });
} finally { ws.close(); }
fs.writeFileSync(path.join(output,prefix+".json"),JSON.stringify(manifest,null,2)+"\n");
let length=0;
for(const chunk of manifest.chunks) {
    if(!chunk.name.startsWith(prefix+"-") || path.basename(chunk.name)!==chunk.name ||
            fs.statSync(path.join(output,chunk.name)).size!==chunk.size) throw new Error("Invalid export chunk");
    chunk.offset=length;length+=chunk.size;
}
const disk={byteLength:length,get(at,size,callback){
    const bytes=Buffer.alloc(size);let used=0;
    for(const chunk of manifest.chunks) {
        if(at>=chunk.offset+chunk.size || at+size<=chunk.offset)continue;
        const start=Math.max(at,chunk.offset),end=Math.min(at+size,chunk.offset+chunk.size);
        const fd=fs.openSync(path.join(output,chunk.name),"r");
        try {
            const count=fs.readSync(fd,bytes,start-at,end-start,start-chunk.offset);
            if(count!==end-start)throw new Error("Short disk read");used+=count;
        } finally {fs.closeSync(fd);}
    }
    if(used!==size)throw new Error("Missing disk bytes");callback(bytes);
}};
const files=[];
for(const request of requested) {
    if(request.endsWith("/*")) {
        const dirname=request.slice(0,-2),entries=await list_fat32_directory(disk,dirname);
        if(!entries?.length)throw new Error("Missing artifact directory: "+dirname);
        for(const entry of entries)if(!entry.directory)files.push(dirname+"/"+entry.name);
    } else files.push(request);
}
const evidence=[],names=new Set();
for(const file of files) {
    const bytes=await read_fat32_file(disk,file);
    if(!bytes) {evidence.push({file,missing:true});continue;}
    const name=file.replaceAll(/[^a-zA-Z0-9._-]/g,"_");
    if(name==="." || name===".." || names.has(name))throw new Error("Ambiguous artifact name: "+file);
    names.add(name);fs.writeFileSync(path.join(output,name),bytes);
    evidence.push({file,name,bytes:bytes.length,sha256:crypto.createHash("sha256").update(bytes).digest("hex")});
}
fs.writeFileSync(path.join(output,"extracted-artifacts.json"),JSON.stringify(evidence,null,2)+"\n");
if(evidence.some(entry=>entry.missing))throw new Error("Missing artifacts; export chunks retained for inspection");
for(const chunk of manifest.chunks)fs.unlinkSync(path.join(output,chunk.name));
console.log(JSON.stringify(evidence,null,2));
