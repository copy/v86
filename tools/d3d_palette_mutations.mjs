#!/usr/bin/env node
// Run exclusively: each mutant is restored byte for byte before the next one.
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync as spawn_sync } from "node:child_process";
const cases=[
 ["default palette zero not selected","src/browser/glbridge/d3d9-webgpu/d9wg_state.js","currentPalette: 0,","currentPalette: null,"],
 ["selection fails to repaint indices","src/browser/glbridge/d3d9-webgpu/d9wg_resources.js","state.currentPalette = index;","state.currentPalette = index; return;"],
 ["A8P8 uses palette alpha","src/browser/glbridge/d3d9-webgpu/d9wg_formats.js","dest[out + 3] = stride === 2\n                        ? source[at + 1] : palette[entry + 3];","dest[out + 3] = palette[entry + 3];"]
];
const results=[];
for(const [label,file,before,after] of cases){const original=fs.readFileSync(file),source=original.toString();assert.equal(source.split(before).length,2,label);try{fs.writeFileSync(file,source.replace(before,after));const run=spawn_sync(process.execPath,["tests/glbridge/gl_multipass_browser_runner.js","d3d_palette_replay_browser_test.html"],{encoding:"utf8",env:{...process.env,GL_SWIFTSHADER:"1"},maxBuffer:4*1024*1024});assert.notEqual(run.status,0,"survived "+label);assert.match(run.stdout+run.stderr,/palette replay mismatch/,"pixel failure required: "+label);results.push({label,killed:true});}finally{fs.writeFileSync(file,original);assert(fs.readFileSync(file).equals(original));}}
fs.writeFileSync("build/d3d-review/stage4d2j2d/gpu-mutations.json",JSON.stringify(results,null,2)+"\n");console.log("PASS actual XP palette GPU mutations: 3/3; exact original sources restored");
