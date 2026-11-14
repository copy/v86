"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),{spawnSync}=require("node:child_process");
(async()=>{const {site_directory}=await import("../lib/site.mjs"),site=site_directory(path.resolve(__dirname,"../..")),header=fs.readFileSync(site+"/glbridge/runtime/d9wg_state_defaults.h","utf8"),source=fs.readFileSync(site+"/glbridge/d3d8proxy/d3d8_core_device.c","utf8"),directory=fs.mkdtempSync(path.join(os.tmpdir(),"d9wg-texture-mutants-"));
 const cases=[
 ["higher color stage",false,"(stage ? 1u : 4u)","(stage ? 4u : 4u)"],
 ["higher alpha stage",false,"(stage ? 1u : 2u)","(stage ? 2u : 2u)"],
 ["color operand zero default",false,"case 26u: return 0x1u;","case 26u: return 0x0u;"],
 ["alpha operand zero default",false,"case 27u: return 0x1u;","case 27u: return 0x0u;"],
 ["texture coordinate stage",false,"case 11u: return stage;","case 11u: return 0u;"],
 ["legacy W address",false,"case 25u: return api == 8u ? d9wg_sampler_default(3u) : 0u;","case 25u: return api == 8u ? 0u : 0u;"],
 ["point magnification",false,"case 5u: return 0x1u;","case 5u: return 0x0u;"],
 ["disabled mip filtering",false,"d9wg_sampler_default(uint32_t state)\n{\n    switch (state) {","d9wg_sampler_default(uint32_t state)\n{\n    switch (state) {\n    case 7u: return 1u;"],
 ["first zero assignment suppressed",true,"if (!device->recording && raw->texture[stage][state] == value)","if (!device->recording && (!value || raw->texture[stage][state] == value))"],
 ];
 try{for(const [name,isSource,before,after] of cases){const original=isSource?source:header;assert.equal(original.split(before).length,2,name);const file=path.join(directory,isSource?"proxy.c":"mutated.h");fs.writeFileSync(file,original.replace(before,after));const env={...process.env,...(isSource?{D9WG_TEXTURE_DEFAULTS_D8_SOURCE:file}:{D9WG_TEXTURE_DEFAULTS_HEADER:file})};const run=spawnSync(process.execPath,[path.join(__dirname,"d9wg_texture_defaults_test.js")],{env,encoding:"utf8"});assert.notEqual(run.status,0,"survived "+name);assert.match(run.stderr,/texture default line/,"runtime assertion required: "+name);}console.log("PASS shared texture-default mutations: 9/9; stage ops, triadic operands, coordinates, legacy W, filtering and real first-zero suppression");}finally{fs.rmSync(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
