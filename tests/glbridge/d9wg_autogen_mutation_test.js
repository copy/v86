"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),{spawnSync}=require("node:child_process");
(async()=>{
 const {site_directory}=await import("../lib/site.mjs"),site=site_directory(path.resolve(__dirname,"../..")),sources={header:fs.readFileSync(site+"/glbridge/runtime/d9wg_format_queries.h","utf8"),frontend:fs.readFileSync(site+"/glbridge/d3d9proxy/d3d9_proxy.c","utf8")};
 const cases=[
 ["levels", "header", "levels <= 1u", "levels <= 2u"],
 ["pool", "header", "pool <= 1u", "pool <= 2u"],
 ["dynamic", "header", "&& !(usage & 0x200u)", "&& 1"],
 ["NONE filter", "header", "return filter == 1u ||", "return filter <= 1u ||"],
 ["FP32 filter feature", "header", "(!(d9wg_format_query_info(format) & 4u) || (host_features & 1u))", "(!(d9wg_format_query_info(format) & 4u) || (host_features & 2u))"],
 ["FP32 default", "header", "? 1u : 2u;", "? 2u : 2u;"],
 ["2D setter state", "frontend", "texture->autogen_filter = filter;", "texture->autogen_filter = D3DTEXF_LINEAR;"],
 ["cube setter state", "frontend", "texture->autogen_filter = type;", "texture->autogen_filter = D3DTEXF_LINEAR;"],
 ["deferred generation", "frontend", "command.defer_generation = defer_generation ? 1u : 0u;", "command.defer_generation = defer_generation ? 0u : 1u;"],
 ["atomic failed setter", "frontend", "if (!emit_generate_mips(texture->device, texture->handle, filter, TRUE))", "texture->autogen_filter = filter;\n    if (!emit_generate_mips(texture->device, texture->handle, filter, TRUE))"],
 ["creation config", "frontend", "|| emit_generate_mips(device, texture->handle, texture->autogen_filter, TRUE);", "|| TRUE;",2],
 ["explicit generation", "frontend", "emit_generate_mips(texture->device, texture->handle, texture->autogen_filter, FALSE);", "emit_generate_mips(texture->device, texture->handle, texture->autogen_filter, TRUE);",2],
 ];
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),"d9wg-autogen-mutants-"));
 try{for(const [name,kind,before,after,count=1]of cases){assert.equal(sources[kind].split(before).length,count+1,name);const file=path.join(directory,kind==="header"?"mutated.h":"mutated.c");fs.writeFileSync(file,sources[kind].replaceAll(before,after));const run=spawnSync(process.execPath,[path.join(__dirname,"d9wg_autogen_test.js")],{env:{...process.env,[kind==="header"?"D9WG_AUTOGEN_HEADER":"D9WG_AUTOGEN_SOURCE"]:file},encoding:"utf8"});assert.notEqual(run.status,0,"survived "+name);assert.match(run.stderr,/autogen line/,"native runtime assertion required: "+name);}}finally{fs.rmSync(directory,{recursive:true,force:true});}
 console.log("PASS automatic mip C mutations: 12/12 levels/pool/dynamic, filter/default feature gates, real setters, atomic failure, deferred/explicit generation and create/recreation config");
})().catch(error=>{console.error(error);process.exitCode=1});
