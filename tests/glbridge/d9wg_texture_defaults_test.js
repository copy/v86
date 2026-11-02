"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),{spawnSync}=require("node:child_process");
const S=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_state.js"),reference=require("./fixtures/d3d_texture_defaults_reference.json"),root=path.resolve(__dirname,"../.."),word=(value,stage)=>value==="stage"?stage:value==="colorOp"?(stage?1:4):value==="alphaOp"?(stage?1:2):value;
(async()=>{const {site_directory}=await import("../lib/site.mjs"),site=site_directory(root),header=process.env.D9WG_TEXTURE_DEFAULTS_HEADER||site+"/glbridge/runtime/d9wg_state_defaults.h",source=fs.readFileSync(process.env.D9WG_TEXTURE_DEFAULTS_D8_SOURCE||site+"/glbridge/d3d8proxy/d3d8_proxy.c","utf8"),directory=fs.mkdtempSync(path.join(os.tmpdir(),"d9wg-texture-defaults-"));
 const rows=[];for(const api of [8,9]){const map=S.textureDefaults(api);for(let stage=0;stage<8;++stage){for(const [id,,value] of [...reference.texture,...(api===9?reference.d3d9OnlyTexture:[])]){const expected=word(value,stage);assert.equal(map.get(stage*64+id),expected);rows.push([0,api,stage,id,expected]);}if(api===8)for(const [,,value,legacy] of reference.sampler)if(legacy!==null){assert.equal(map.get(stage*64+legacy),value);rows.push([0,api,stage,legacy,value]);}}}
 const samplers=S.samplerDefaults();for(const sampler of [...reference.pixelSamplerIndices,...reference.vertexSamplerIndices])for(const [id,,value] of reference.sampler){assert.equal(samplers.get(sampler*64+id),value);rows.push([1,9,sampler,id,value]);}assert.equal(rows.length,620);
 const {makeExecutor}=require("./d3d9_webgpu_executor_test.js"),{executor}=makeExecutor(),a=executor.createDeviceState(1),b=executor.createDeviceState(2);assert.equal(a.textureStageStates.get(64+26),1);assert.equal(a.samplerStates.get(260*64+3),1);a.textureStageStates.set(64+26,0);a.samplerStates.set(260*64+3,3);assert.equal(b.textureStageStates.get(64+26),1);assert.equal(b.samplerStates.get(260*64+3),1);
 function extract(name){const m=new RegExp("static (?:BOOL|HRESULT)(?: WINAPI)? "+name+"\\([^;]*?\\)\\s*\\{").exec(source);assert(m,name);let at=source.indexOf("{",m.index)+1,depth=1;for(;depth;++at){assert(at<source.length);if(source[at]==="{")depth++;if(source[at]==="}")depth--;}return source.slice(m.index,at);}
 const code=`#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "${header}"
#include "${site}/glbridge/d3d8proxy/d3d8_protocol.h"
typedef uint32_t DWORD,UINT,D3DTEXTURESTAGESTATETYPE;typedef int BOOL,HRESULT;
#define WINAPI
#define TRUE 1
#define FALSE 0
#define D3D_OK 0
#define D3DERR_INVALIDCALL (-1)
#define D3DERR_DRIVERINTERNALERROR (-2)
#define D8WG_TRACE_ERROR(x) (x)
#define D8WG_MAX_TEXTURE_STAGES 8
#define D8WG_MAX_TEXTURE_STAGE_STATES 32
struct D8StateSnapshot {DWORD texture_stage_states[8][32];uint8_t texture_stage_mask[8][32];};typedef struct D8StateSnapshot D8StateSnapshot;
struct D8StateBlock {D8StateSnapshot state;};
typedef struct D8Device {DWORD handle;DWORD texture_stage_states[8][32];struct D8StateBlock *recording_state_block;} D8Device;typedef D8Device IDirect3DDevice8;
static D8Device *device_from_iface(IDirect3DDevice8 *p){return p;}
static UINT emitted,opcode;static D9WGSetTextureStageState command;
static BOOL emit_command(uint16_t op,const void *data,uint32_t bytes){if(bytes!=sizeof(command))return FALSE;memcpy(&command,data,bytes);opcode=op;++emitted;return TRUE;}
${extract('emit_texture_stage_state')}
${extract('device_set_texture_stage_state')}
#define CHECK(x) do{if(!(x)){fprintf(stderr,"texture default line %u: %s\\n",__LINE__,#x);return 1;}}while(0)
struct Reference {UINT sampler,api,stage,state,expected;};static const struct Reference reference[]={${rows.map(r=>'{'+r.join(',')+'}').join(',')}};
int main(void){for(UINT i=0;i<sizeof(reference)/sizeof(reference[0]);++i){const struct Reference *r=reference+i;CHECK((r->sampler?d9wg_sampler_default(r->state):d9wg_texture_default(r->api,r->stage,r->state))==r->expected);}
 D8Device device={.handle=7};for(UINT stage=0;stage<8;++stage)for(UINT state=0;state<32;++state)device.texture_stage_states[stage][state]=d9wg_texture_default(8,stage,state);
 CHECK(device_set_texture_stage_state(&device,1,26,1)==0&&!emitted);
 CHECK(device_set_texture_stage_state(&device,1,26,0)==0&&emitted==1&&opcode==D9WG_OP_SET_TEXTURE_STAGE_STATE&&command.stage==1&&command.state==26&&command.value==0);
 CHECK(device_set_texture_stage_state(&device,1,27,0)==0&&emitted==2&&command.state==27&&command.value==0);
 CHECK(device_set_texture_stage_state(&device,7,25,3)==0&&emitted==3&&opcode==D9WG_OP_SET_SAMPLER_STATE&&command.stage==7&&command.state==3&&command.value==3);
 CHECK(device_set_texture_stage_state(&device,7,25,3)==0&&emitted==3);
 struct D8StateBlock block={0};device.recording_state_block=&block;CHECK(device_set_texture_stage_state(&device,1,26,1)==0&&emitted==3&&device.texture_stage_states[1][26]==0&&block.state.texture_stage_mask[1][26]&&block.state.texture_stage_states[1][26]==1);device.recording_state_block=0;
 CHECK(device_set_texture_stage_state(&device,8,26,0)==D3DERR_INVALIDCALL&&device_set_texture_stage_state(&device,0,32,0)==D3DERR_INVALIDCALL&&emitted==3);
 CHECK(d9wg_texture_default(9,7,25)==0&&d9wg_texture_default(9,7,16)==0&&d9wg_sampler_default(0)==0);
 puts("PASS C texture defaults: 620 independent SDK texture/sampler values, exact legacy mappings, actual D3D8 first zero transitions, equal suppression and deferred recording");return 0;}
`;
 try{const file=path.join(directory,"defaults.c"),binary=path.join(directory,"defaults");fs.writeFileSync(file,code);const build=spawnSync(process.env.HOST_CC||"cc",["-std=c11","-Os","-Wall","-Wextra","-Werror",file,"-o",binary],{encoding:"utf8"});assert.equal(build.status,0,build.stderr);const run=spawnSync(binary,[],{encoding:"utf8"});assert.equal(run.status,0,run.stderr);process.stdout.write(run.stdout);}finally{fs.rmSync(directory,{recursive:true,force:true});}
 console.log("PASS JS texture defaults: eight stages, sixteen pixel/four vertex samplers and device isolation");
})().catch(error=>{console.error(error);process.exitCode=1;});
