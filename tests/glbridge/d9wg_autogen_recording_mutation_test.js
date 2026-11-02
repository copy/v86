"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),{spawnSync}=require("node:child_process");
const root=path.resolve(__dirname,"../../src/browser/glbridge/d3d9-webgpu"),sources={RESOURCE:fs.readFileSync(root+"/d9wg_resources.js","utf8"),SURFACE:fs.readFileSync(root+"/d9wg_surface_ops.js","utf8"),EXECUTOR:fs.readFileSync(root+"/d3d9_executor.js","utf8")};
const cases=[
 ["deferred setter", "RESOURCE", "if (defer) return;", "if (false && defer) return;"],
 ["legacy immediate", "RESOURCE", "? view.getUint32(offset + D9WG.F.GenerateMips.defer_generation, true) : 0;", "? view.getUint32(offset + D9WG.F.GenerateMips.defer_generation, true) : 1;"],
 ["filter snapshot", "RESOURCE", "filterType: resource.autoGenFilter", "filterType: 2"],
 ["filter update", "RESOURCE", "if (filter) resource.autoGenFilter = filter;", "/* filter state ignored */"],
 ["point replay", "SURFACE", "filterPoint: op.filterType === 1", "filterPoint: false"],
 ["anisotropic replay", "SURFACE", "maxAnisotropy: op.filterType === 3 ? 16 : 1", "maxAnisotropy: 1"],
 ["GPU write invalidation", "EXECUTOR", "this.markTextureSubresourceWritten(resource, level, face);\n            resource.frameReferenced = frame.serial;", "resource.frameReferenced = frame.serial;"],
];
const directory=fs.mkdtempSync(path.join(os.tmpdir(),"d9wg-autogen-recording-"));
try{for(const [name,kind,before,after]of cases){assert.equal(sources[kind].split(before).length,2,name);const file=path.join(directory,"mutated.js");fs.writeFileSync(file,sources[kind].replace(before,after));const run=spawnSync(process.execPath,[path.join(__dirname,"d9wg_autogen_recording_test.js")],{env:{...process.env,["D9WG_AUTOGEN_"+kind+"_SOURCE"]:file},encoding:"utf8"});assert.notEqual(run.status,0,"survived "+name);assert.match(run.stderr,/AssertionError/,"runtime assertion required: "+name);}}finally{fs.rmSync(directory,{recursive:true,force:true});}
console.log("PASS automatic mip host mutations: 7/7 deferred/legacy operations, captured filter state, POINT/ANISOTROPIC replay and GPU-write invalidation");
