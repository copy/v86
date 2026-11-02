"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),{spawnSync}=require("node:child_process");
(async()=>{const {site_directory}=await import("../lib/site.mjs"),site=site_directory(path.resolve(__dirname,"../..")),header=fs.readFileSync(site+"/glbridge/runtime/d9wg_state_defaults.h","utf8"),bridge=fs.readFileSync(site+"/glbridge/runtime/d9wg_state_defaults_bridge.h","utf8"),directory=fs.mkdtempSync(path.join(os.tmpdir(),"d9wg-default-mutants-"));
 const cases=[
 ["D3D8 point minimum",false,"api == 8u ? 0x0u : 0x3F800000u","api == 8u ? 0x3F800000u : 0x3F800000u"],
 ["fill mode",false,"case 8u: return 0x3u;","case 8u: return 0x2u;"],
 ["clipping",false,"case 136u: return 0x1u;","case 136u: return 0x0u;"],
 ["creation depth",false,"(auto_depth != 0)","(auto_depth || 1)"],
 ["reported point maximum",false,"(point_max_bits > 0x3F800000u ? point_max_bits : 0x42800000u)","(point_max_bits ? 0x42800000u : 0x42800000u)"],
 ["point attenuation",false,"case 158u: return 0x3F800000u;","case 158u: return 0x0u;"],
 ["patch degree",false,"case 172u: return 0x3u;","case 172u: return 0x0u;"],
 ["API default patch",true,"{155u, 166u}","{166u, 166u}"],
 ["patch transport error",true,"if (!emit_command(D9WG_OP_SET_RENDER_STATE, &command, sizeof(command))) return FALSE;","if (!emit_command(D9WG_OP_SET_RENDER_STATE, &command, sizeof(command))) return TRUE;"],
 ];
 try{for(const [name,isBridge,before,after] of cases){const original=isBridge?bridge:header;assert.equal(original.split(before).length,2,name);const file=path.join(directory,"mutated.h");fs.writeFileSync(file,original.replace(before,after));const env={...process.env,D9WG_STATE_DEFAULTS_HEADER:isBridge?site+"/glbridge/runtime/d9wg_state_defaults.h":file,...(isBridge?{D9WG_STATE_DEFAULTS_BRIDGE:file}:{})};const run=spawnSync(process.execPath,[path.join(__dirname,"d9wg_state_defaults_test.js")],{env,encoding:"utf8"});assert.notEqual(run.status,0,"survived "+name);assert.match(run.stderr,/render default line/,"runtime assertion required: "+name);}console.log("PASS shared render-default mutations: 9/9; SDK defaults, version minimum, creation depth/cap maximum and exact host patch failure semantics");}finally{fs.rmSync(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
