"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),{spawnSync}=require("node:child_process");
const S=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_state.js"),reference=require("./fixtures/d3d_render_defaults_reference.json"),root=path.resolve(__dirname,"../..");
(async()=>{
 const {site_directory}=await import("../lib/site.mjs"),site=site_directory(root),header=process.env.D9WG_STATE_DEFAULTS_HEADER||path.join(site,"glbridge/runtime/d9wg_state_defaults.h"),directory=fs.mkdtempSync(path.join(os.tmpdir(),"d9wg-state-defaults-"));
 const bits=n=>new Uint32Array(new Float32Array([n]).buffer)[0];
 function expected(row,depth,max){return row.value==="autoDepth"?Number(depth):row.value==="pointMax"?bits(max):row.value;}
 for(const api of [8,9])for(const depth of [false,true])for(const max of [64,256,8192]){const states=S.renderDefaults(api,depth,max);for(const row of reference.apis[api])assert.equal(states.get(row.state),expected(row,depth,max),api+" "+row.name);assert.equal(states.get(154),0x3f800000);assert.equal(states.get(172),3);assert.equal(states.get(173),1);}
 const {makeExecutor}=require("./d3d9_webgpu_executor_test.js"),{executor}=makeExecutor();const a=executor.createDeviceState(11,false),b=executor.createDeviceState(12,true);assert.equal(a.renderStates.get(7),0);assert.equal(b.renderStates.get(7),1);assert.equal(a.renderStates.get(166),0x43800000);a.renderStates.set(8,1);assert.equal(b.renderStates.get(8),3);
 const P=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");await executor.initialize();
 const create=P.encode("CreateDevice",{device_handle:31,width:64,height:64,windowed:1,backbuffer_format:22,enable_auto_depth_stencil:0});executor.onCreateDevice(create,new DataView(create.buffer),0,create.length);assert.equal(executor.devices.get(31).renderStates.get(7),0);
 for(const [old_handle,new_handle,enabled] of [[31,32,1],[32,33,0]]){const reset=P.encode("ResetDevice",{old_device_handle:old_handle,new_device_handle:new_handle,width:64,height:64,windowed:1,backbuffer_format:22,enable_auto_depth_stencil:enabled});executor.onReset(reset,new DataView(reset.buffer),0,reset.length);assert.equal(executor.devices.has(old_handle),false);assert.equal(executor.devices.get(new_handle).renderStates.get(7),enabled);assert.equal(executor.devices.get(new_handle).renderStates.get(8),3);}
 const {inspect_render_defaults_wire}=await import("../lib/d3d_render_defaults_wire.mjs");
 function carrier(owner,commands){const batch=Buffer.from(P.encodeBatch(commands)),packet=Buffer.alloc(20+batch.length);packet.writeUInt32LE(owner,0);packet.writeUInt32LE(8+batch.length,8);packet.writeUInt16LE(0xffe1,12);packet.writeUInt16LE(0xffff,14);packet.writeUInt32LE(batch.length,16);batch.copy(packet,20);return packet;}
 function contextWire(api,omitMinimum=false,wrongDepth=false){const commands=[];for(let generation=0;generation<3;++generation){const name=generation?"ResetDevice":"CreateDevice",depth=generation===1?1:0,opcode=generation?P.OP.RESET:P.OP.CREATE_DEVICE;commands.push({opcode,payload:P.encode(name,{...(generation?{old_device_handle:1,new_device_handle:1}:{device_handle:1}),enable_auto_depth_stencil:wrongDepth&&generation===1?0:depth})});if(api===8&&!(omitMinimum&&generation===0))commands.push({opcode:P.OP.SET_RENDER_STATE,payload:P.encode("SetRenderState",{device_handle:1,state:155,value:0})});}return carrier(api,commands);}
 assert.equal(inspect_render_defaults_wire(Buffer.concat([contextWire(8),contextWire(9)]),[8,9])[0].pointMinimumPatches,3);
 assert.throws(()=>inspect_render_defaults_wire(Buffer.concat([contextWire(8,true),contextWire(9)]),[8,9]));
 assert.throws(()=>inspect_render_defaults_wire(Buffer.concat([contextWire(8,false,true),contextWire(9)]),[8,9]));
 const rows=[];for(const api of [8,9])for(const depth of [false,true])for(const max of [64,256,8192])for(const row of reference.apis[api])rows.push(`{${api},${row.state},${Number(depth)},${bits(max)}u,${expected(row,depth,max)}u}`);
 const code=`#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "${header}"
#include "${path.join(site,'glbridge/d3d9proxy/d3d9_protocol.h')}"
typedef int BOOL;
#define TRUE 1
#define FALSE 0
static unsigned emitted,attempts,fail_at;static D9WGSetRenderState commands[2];
static BOOL emit_command(uint16_t opcode,const void *payload,uint32_t bytes){if(++attempts==fail_at)return FALSE;if(opcode!=D9WG_OP_SET_RENDER_STATE||bytes!=sizeof(D9WGSetRenderState)||emitted>=2)return FALSE;memcpy(commands+emitted++,payload,bytes);return TRUE;}
#include "${process.env.D9WG_STATE_DEFAULTS_BRIDGE||path.join(site,'glbridge/runtime/d9wg_state_defaults_bridge.h')}"
struct Reference {uint32_t api,state,depth,max,value;};
static const struct Reference reference[]={${rows.join(',')}};
#define CHECK(x) do{if(!(x)){fprintf(stderr,"render default line %u: %s\\n",__LINE__,#x);return 1;}}while(0)
static void initialize(uint32_t *states,uint32_t api,uint32_t depth,uint32_t maximum){for(unsigned state=0;state<256;++state)states[state]=d9wg_render_default(api,state,depth,maximum);}
int main(void){for(unsigned i=0;i<sizeof(reference)/sizeof(reference[0]);++i){const struct Reference *r=reference+i;CHECK(d9wg_render_default(r->api,r->state,r->depth,r->max)==r->value);}
 CHECK(d9wg_render_default(8,154,0,0)==0x3f800000&&d9wg_render_default(8,172,0,0)==3&&d9wg_render_default(8,173,0,0)==1);
 CHECK(d9wg_render_default(8,166,0,0)==0x42800000&&d9wg_render_default(9,166,0,0x3f800000)==0x42800000);
 uint32_t states[256],before[256];initialize(states,9,0,0x43800000);CHECK(emit_render_default_patches(7,9,0,states)&&!emitted&&!attempts);
 initialize(states,8,1,0x43800000);CHECK(emit_render_default_patches(7,8,1,states)&&emitted==1&&commands[0].device_handle==7&&commands[0].state==155&&commands[0].value==0&&!commands[0].reserved);
 emitted=attempts=0;initialize(states,8,0,0x46000000);memcpy(before,states,sizeof(states));CHECK(emit_render_default_patches(8,8,0,states)&&emitted==2&&commands[0].state==155&&commands[1].state==166&&commands[1].value==0x46000000&&!memcmp(before,states,sizeof(states)));
 for(unsigned failure=1;failure<=2;++failure){emitted=attempts=0;fail_at=failure;CHECK(!emit_render_default_patches(8,8,0,states)&&attempts==failure&&emitted==failure-1&&!memcmp(before,states,sizeof(states)));}fail_at=0;
 emitted=attempts=0;initialize(states,9,1,0x46000000);CHECK(emit_render_default_patches(9,9,1,states)&&emitted==1&&commands[0].state==166&&commands[0].value==0x46000000);
 puts("PASS C render defaults: 1002 independent Wine rows across depth/cap contexts, SDK point/patch defaults, exact D3D8/D3D9 host patches, zero redundant state and bounded transport failures");return 0;}
`;
 try{if(!process.env.D9WG_STATE_DEFAULTS_HEADER){const check=spawnSync(process.execPath,[path.join(root,"tools/gen_d9wg_state_defaults.mjs"),"--check",header],{encoding:"utf8"});assert.equal(check.status,0,check.stderr);}
  const facts=spawnSync(process.execPath,[path.join(root,"tools/gen_d3d_render_default_reference.mjs")],{encoding:"utf8"});assert.equal(facts.status,0,facts.stderr);assert.equal(fs.readFileSync(path.join(site,"glbridge/sample/d3d_render_default_reference.h"),"utf8"),facts.stdout);
  const file=path.join(directory,"defaults.c"),binary=path.join(directory,"defaults");fs.writeFileSync(file,code);const build=spawnSync(process.env.HOST_CC||"cc",["-std=c11","-Os","-Wall","-Wextra","-Werror","-I",path.join(site,"glbridge/runtime"),file,"-o",binary],{encoding:"utf8"});assert.equal(build.status,0,build.stderr);const run=spawnSync(binary,[],{encoding:"utf8"});assert.equal(run.status,0,run.stderr);process.stdout.write(run.stdout);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
 console.log("PASS JS render defaults: independent D3D8/9 references, isolated creation/reset depth state and version-specific wire synchronization");
})().catch(error=>{console.error(error);process.exitCode=1;});
