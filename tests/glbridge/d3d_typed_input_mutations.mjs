#!/usr/bin/env node
// Real GPU mutations, run in isolation: source files are restored after every
// variant, including interruption. Do not build or run other tests concurrently.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash as create_hash } from "node:crypto";
import { spawnSync as spawn } from "node:child_process";
import { fileURLToPath as file_url_to_path } from "node:url";
const root=file_url_to_path(new URL("../../",import.meta.url));
const files=["src/browser/glbridge/d3d9-webgpu/d3d9_shader_pipeline.js","src/browser/glbridge/d3d9-webgpu/d9wg_ffp.js","src/browser/glbridge/d3d9-webgpu/d3d9_executor.js"];
const originals=new Map(files.map(file=>[file,fs.readFileSync(root+file,"utf8")]));
const baseline_ref=process.env.D9WG_TYPED_BASELINE_REF||"03a16ca3";
const out=path.resolve(process.env.D9WG_TYPED_MUTATION_OUT||root+"build/d3d-review/stage4d2i2b");fs.mkdirSync(out,{recursive:true});
const restore=()=>{for(const [file,source] of originals)if(fs.readFileSync(root+file,"utf8")!==source)fs.writeFileSync(root+file,source);};
process.once("exit",restore);for(const signal of ["SIGINT","SIGTERM"])process.once(signal,()=>{restore();process.exit(130);});
function run(page) {
    const result=spawn(process.execPath,[root+"tests/glbridge/gl_multipass_browser_runner.js",page],{cwd:root,env:{...process.env,GL_SWIFTSHADER:"1"},encoding:"utf8",timeout:120000,maxBuffer:8<<20});
    const line=result.stdout.split(/\r?\n/).find(line=>line.startsWith('{"status"'));assert(line,result.stderr.slice(-1500)||"GPU runner did not report");
    return {exit:result.status,...JSON.parse(line)};
}
const page="d3d_fixed_vertex_formats_browser_test.html", results=[];
try {
    for(const file of files){const old=spawn("git",["show",baseline_ref+":"+file],{cwd:root,encoding:"utf8"});assert.equal(old.status,0,old.stderr);fs.writeFileSync(root+file,old.stdout);}
    const before=run(page);assert.equal(before.status,"FAIL");assert.match(before.details,/Typed fixed-function mismatch/);
    fs.copyFileSync(root+"build/browser-test-output/d9wg-fixed-vertex-formats.json",out+"/before-85.json");restore();
    const mutations=[
        ["raw integer input routing lost",0,'case 5: return "ubyte4";','case 5: return "";',page],
        ["ARGB geometry/normal/texture swizzle lost",0,'case "color": return name + ".bgra";','case "color": return name + ".rgba";',page],
        ["signed two-component input loses default w",0,'"), 0.0, 1.0)";','"), 0.0, 0.0)";',"d3d_vertex_formats_browser_test.html"],
        ["signed 10-bit minimum is not clamped",0,'return max(f32(signed_value) / 511.0, -1.0);','return f32(signed_value) / 511.0;',"d3d_vertex_formats_browser_test.html"],
        ["fixed-function ignores the declaration conversion",1,'const conversions = signature.inputConversions || {}, inputLines = [];','const conversions = {}, inputLines = [];',page],
        ["fixed shader cache aliases different input conversions",1,'JSON.stringify([signature, debugMode || ""])','JSON.stringify([{...signature, inputConversions: null}, debugMode || ""])',page],
    ];
    for(const [label,index,before,after,detector] of mutations){
        const file=files[index],source=originals.get(file);assert.equal(source.split(before).length,2,"unique mutation: "+label);
        fs.writeFileSync(root+file,source.replace(before,after));
        try {const result=run(detector);assert.equal(result.status,"FAIL","survived: "+label);assert.match(result.details,/(Typed fixed-function mismatch|D3DDECLTYPE)/,"executed semantic check: "+label);results.push({label,detector,killed:true});}
        finally {restore();}
    }
    fs.writeFileSync(out+"/mutations.json",JSON.stringify({baselineRef:baseline_ref,before:"85 actual fixed-function scenes under the baseline production sources",sourceSha256:Object.fromEntries([...originals].map(([file,source])=>[file,create_hash("sha256").update(source).digest("hex")])),mutations:results},null,2)+"\n");
    console.log("PASS typed vertex GPU mutations: 6/6 plus previous-source regression, original sources restored");
}finally{restore();}
