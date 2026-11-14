"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),{spawnSync}=require("node:child_process");
const S=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_state.js"),reference=require("./fixtures/d3d_texture_defaults_reference.json"),root=path.resolve(__dirname,"../.."),word=(value,stage)=>value==="stage"?stage:value==="colorOp"?(stage?1:4):value==="alphaOp"?(stage?1:2):value;
(async()=>{const {site_directory}=await import("../lib/site.mjs"),site=site_directory(root),header=process.env.D9WG_TEXTURE_DEFAULTS_HEADER||site+"/glbridge/runtime/d9wg_state_defaults.h",source=fs.readFileSync(process.env.D9WG_TEXTURE_DEFAULTS_D8_SOURCE||site+"/glbridge/d3d8proxy/d3d8_core_device.c","utf8"),directory=fs.mkdtempSync(path.join(os.tmpdir(),"d9wg-texture-defaults-"));
 const rows=[];for(const api of [8,9]){const map=S.textureDefaults(api);for(let stage=0;stage<8;++stage){for(const [id,,value] of [...reference.texture,...(api===9?reference.d3d9OnlyTexture:[])]){const expected=word(value,stage);assert.equal(map.get(stage*64+id),expected);rows.push([0,api,stage,id,expected]);}if(api===8)for(const [,,value,legacy] of reference.sampler)if(legacy!==null){assert.equal(map.get(stage*64+legacy),value);rows.push([0,api,stage,legacy,value]);}}}
 const samplers=S.samplerDefaults();for(const sampler of [...reference.pixelSamplerIndices,...reference.vertexSamplerIndices])for(const [id,,value] of reference.sampler){assert.equal(samplers.get(sampler*64+id),value);rows.push([1,9,sampler,id,value]);}assert.equal(rows.length,620);
 const {makeExecutor}=require("./d3d9_webgpu_executor_test.js"),{executor}=makeExecutor(),a=executor.createDeviceState(1),b=executor.createDeviceState(2);assert.equal(a.textureStageStates.get(64+26),1);assert.equal(a.samplerStates.get(260*64+3),1);a.textureStageStates.set(64+26,0);a.samplerStates.set(260*64+3,3);assert.equal(b.textureStageStates.get(64+26),1);assert.equal(b.samplerStates.get(260*64+3),1);
 const coreSource=fs.readFileSync(process.env.D9WG_TEXTURE_DEFAULTS_D9_SOURCE||site+"/glbridge/d3d9proxy/d3d9_proxy.c","utf8");
 function extract(text,name){const m=new RegExp("(?:static )?(?:UINT|BOOL|HRESULT)(?: WINAPI)? "+name+"\\([^;]*?\\)\\s*\\{").exec(text);assert(m,name);let at=text.indexOf("{",m.index)+1,depth=1;for(;depth;++at){assert(at<text.length);if(text[at]==="{")depth++;if(text[at]==="}")depth--;}return text.slice(m.index,at);}
 const code=`#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "${header}"
#include "${site}/glbridge/d3d9proxy/d3d9_protocol.h"
#include "${site}/glbridge/runtime/d9wg_state_bridge8.h"
typedef uint32_t DWORD,UINT,D3DTEXTURESTAGESTATETYPE,D3DSAMPLERSTATETYPE;typedef int BOOL,HRESULT;
#define WINAPI
#define TRUE 1
#define FALSE 0
#define SUCCEEDED(h) ((h)>=0)
#define D3D_OK 0
#define D3DERR_INVALIDCALL (-1)
#define D3DERR_DRIVERINTERNALERROR (-2)
#define TRACE_REFUSE(x) (x)
#define D9_MAX_TEXTURE_STAGES 8
#define D9_MAX_TEXTURE_STAGE_STATES 33
#define D9_MAX_SAMPLER_STATES 14
#define D3DVERTEXTEXTURESAMPLER0 257u
typedef struct {DWORD compatibility_api;} D9Parent;
typedef struct {DWORD texture_stage_states[8][33],sampler_states[20][14];BOOL has_texture_stage_state[8][33],has_sampler_state[20][14];}D9StateBlock;
typedef struct {D9Parent*parent;DWORD handle,texture_stage_states[8][33],sampler_states[20][14];D9StateBlock*recording_result;}D9Device,IDirect3DDevice9;
static D9Device*device_from_iface(IDirect3DDevice9*p){return p;}
static UINT emitted,opcode;static D9WGSetTextureStageState command;static D9WGSetSamplerState sampler_command;
static BOOL emit_command(uint16_t op,const void *data,uint32_t bytes){if(bytes!=sizeof(command))return FALSE;memcpy(&command,data,bytes);memcpy(&sampler_command,data,bytes);opcode=op;++emitted;return TRUE;}
${['device_compatibility_api','state_block_record_texture_stage_state','state_block_record_sampler_state','sampler_state_slot','device_set_texture_stage_state','device_set_sampler_state'].map(n=>extract(coreSource,n)).join('\n')}
#define IDirect3DDevice9_SetSamplerState device_set_sampler_state
#define IDirect3DDevice9_SetTextureStageState device_set_texture_stage_state
${extract(coreSource,'d9wg_d3d9_core_set_texture_stage_state8')}
typedef struct{DWORD texture[8][32];uint8_t texture_mask[8][32];}D8CoreRawState;
typedef struct{D8CoreRawState raw;}D8CoreBlock;
typedef struct{D9Device*backend;D8CoreRawState live;D8CoreBlock*recording;}D8CoreDevice,IDirect3DDevice8;
static D8CoreDevice*core_device8(IDirect3DDevice8*p){return p;}
${extract(source,'core_device8_SetTextureStageState')}
#define CHECK(x) do{if(!(x)){fprintf(stderr,"texture default line %u: %s\\n",__LINE__,#x);return 1;}}while(0)
struct Reference {UINT sampler,api,stage,state,expected;};static const struct Reference reference[]={${rows.map(r=>'{'+r.join(',')+'}').join(',')}};
int main(void){for(UINT i=0;i<sizeof(reference)/sizeof(reference[0]);++i){const struct Reference *r=reference+i;CHECK((r->sampler?d9wg_sampler_default(r->state):d9wg_texture_default(r->api,r->stage,r->state))==r->expected);}
 D9Parent parent={8};D9Device backend={.parent=&parent,.handle=7};D8CoreDevice device={.backend=&backend};
 for(UINT stage=0;stage<8;++stage)for(UINT state=0;state<32;++state)device.live.texture[stage][state]=backend.texture_stage_states[stage][state]=d9wg_texture_default(8,stage,state);
 for(UINT slot=0;slot<20;++slot)for(UINT state=0;state<14;++state)backend.sampler_states[slot][state]=d9wg_sampler_default(state);
 CHECK(core_device8_SetTextureStageState(&device,1,26,1)==0&&!emitted);
 CHECK(core_device8_SetTextureStageState(&device,1,26,0)==0&&emitted==1&&opcode==D9WG_OP_SET_TEXTURE_STAGE_STATE&&command.stage==1&&command.state==26&&command.value==0);
 CHECK(core_device8_SetTextureStageState(&device,1,27,0)==0&&emitted==2&&command.state==27&&command.value==0);
 CHECK(core_device8_SetTextureStageState(&device,7,25,3)==0&&emitted==3&&opcode==D9WG_OP_SET_SAMPLER_STATE&&sampler_command.sampler==7&&sampler_command.state==3&&sampler_command.value==3);
 CHECK(core_device8_SetTextureStageState(&device,7,25,3)==0&&emitted==3);
 D8CoreBlock block={0};D9StateBlock core_block={0};device.recording=&block;backend.recording_result=&core_block;
 CHECK(core_device8_SetTextureStageState(&device,1,26,1)==0&&emitted==3&&device.live.texture[1][26]==0&&block.raw.texture_mask[1][26]&&block.raw.texture[1][26]==1);
 CHECK(backend.texture_stage_states[1][26]==0&&core_block.has_texture_stage_state[1][26]&&core_block.texture_stage_states[1][26]==1);
 device.recording=0;backend.recording_result=0;
 CHECK(core_device8_SetTextureStageState(&device,8,26,0)==D3DERR_INVALIDCALL&&core_device8_SetTextureStageState(&device,0,32,0)==D3DERR_INVALIDCALL&&emitted==3);
 CHECK(d9wg_texture_default(9,7,25)==0&&d9wg_texture_default(9,7,16)==0&&d9wg_sampler_default(0)==0);
 puts("PASS C texture defaults: 620 independent SDK texture/sampler values, actual public8-to-core9 legacy mapping, first zero transitions, equal suppression and both deferred state records");return 0;}
`;
 try{const file=path.join(directory,"defaults.c"),binary=path.join(directory,"defaults");fs.writeFileSync(file,code);const build=spawnSync(process.env.HOST_CC||"cc",["-std=c11","-Os","-Wall","-Wextra","-Werror",file,"-o",binary],{encoding:"utf8"});assert.equal(build.status,0,build.stderr);const run=spawnSync(binary,[],{encoding:"utf8"});assert.equal(run.status,0,run.stderr);process.stdout.write(run.stdout);}finally{fs.rmSync(directory,{recursive:true,force:true});}
 console.log("PASS JS texture defaults: eight stages, sixteen pixel/four vertex samplers and device isolation");
})().catch(error=>{console.error(error);process.exitCode=1;});
