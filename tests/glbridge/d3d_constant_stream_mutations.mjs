#!/usr/bin/env node
// Exclusive real-GPU mutations: restore the production source after each run,
// including process exit/signals. Do not build or test concurrently.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash as create_hash } from "node:crypto";
import { spawnSync as spawn } from "node:child_process";
import { fileURLToPath as file_url_to_path } from "node:url";
const root=file_url_to_path(new URL("../../",import.meta.url));
const file=root+"src/browser/glbridge/d3d9-webgpu/d3d9_executor.js",original=fs.readFileSync(file,"utf8");
const out=path.resolve(process.env.D9WG_CONSTANT_MUTATION_OUT||root+"build/d3d-review/stage4d2i3b");fs.mkdirSync(out,{recursive:true});
const restore=()=>{if(fs.readFileSync(file,"utf8")!==original)fs.writeFileSync(file,original);};
process.once("exit",restore);for(const signal of ["SIGINT","SIGTERM"])process.once(signal,()=>{restore();process.exit(130);});
const run=()=>{const result=spawn(process.execPath,[root+"tests/glbridge/gl_multipass_browser_runner.js","d3d_constant_streams_browser_test.html"],{cwd:root,env:{...process.env,GL_SWIFTSHADER:"1"},encoding:"utf8",timeout:120000,maxBuffer:8<<20});const line=result.stdout.split(/\r?\n/).find(l=>l.startsWith('{"status"'));assert(line,result.stderr.slice(-1500)||"GPU runner did not report");return JSON.parse(line);};
try{
 const baseline_ref="8658879e",old=spawn("git",["show",baseline_ref+":src/browser/glbridge/d3d9-webgpu/d3d9_executor.js"],{cwd:root,encoding:"utf8"});assert.equal(old.status,0,old.stderr);
 fs.writeFileSync(file,old.stdout);const baseline=run();assert.equal(baseline.status,"FAIL");assert.match(baseline.details,/Constant stream mismatch/);
 const before=JSON.parse(fs.readFileSync(root+"build/browser-test-output/d9wg-constant-streams.json"));assert(before.scenes.some(s=>s.differingPixels));fs.copyFileSync(root+"build/browser-test-output/d9wg-constant-streams.json",out+"/before.json");restore();
 const mutations=[
  ["constant attribute omitted","if (!stream || (!stream.stride && !stream.bufferHandle)) continue;","if (!stream || !stream.stride) continue;"],
  ["constant instance divisor unnecessarily expanded","if (divisor === 1 || binding.stride === 0) continue;","if (divisor === 1) continue;"],
  ["constant indexed-point binding discarded","if (stride === 0) {","if (stride === 0 && false) {"],
 ],results=[];
 for(const [label,before,after] of mutations){assert.equal(original.split(before).length,2,"unique mutation: "+label);fs.writeFileSync(file,original.replace(before,after));try{const result=run();assert.equal(result.status,"FAIL","survived: "+label);assert.match(result.details,/Constant stream mismatch/);results.push({label,killed:true});}finally{restore();}}
 fs.writeFileSync(out+"/mutations.json",JSON.stringify({baselineRef:baseline_ref,baselineFailingScenes:before.scenes.filter(s=>s.differingPixels||s.coveredPixels<100||s.wrongColorPixels).map(s=>s.name),sourceSha256:create_hash("sha256").update(original).digest("hex"),mutations:results},null,2)+"\n");
 console.log("PASS constant stream GPU mutations: 3/3 plus previous-source regression, original source restored");
}finally{restore();}
