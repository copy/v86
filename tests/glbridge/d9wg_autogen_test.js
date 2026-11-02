"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), {spawnSync} = require("node:child_process");
const F = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_formats.js"), ref = require("./fixtures/d3d_autogen_reference.json");
(async () => {
    const {site_directory} = await import("../lib/site.mjs"), site = site_directory(path.resolve(__dirname, "../.."));
    const generated = spawnSync(process.execPath, [path.resolve(__dirname, "../../tools/gen_d3d_autogen_reference.mjs")], {encoding: "utf8"});assert.equal(generated.status, 0, generated.stderr);assert.equal(fs.readFileSync(site + "/glbridge/sample/d3d_autogen_reference.h", "utf8"), generated.stdout);
    const source = fs.readFileSync(process.env.D9WG_AUTOGEN_SOURCE || site + "/glbridge/d3d9proxy/d3d9_proxy.c", "utf8");
    const extract = name => {const match = source.match(new RegExp("static [^\\n]*\\b" + name + "\\([^;]*?\\)\\n\\{[\\s\\S]*?\\n}\\n")); assert(match, name);return match[0];};
    const filters = [0, 1, 2, 3, 4, 5, 0xffffffff], formats = [...ref.generationFormats, ...ref.nonGeneratingSnormFormats, ...require("./fixtures/d3d_format_query_reference.json").nativeBCFormats, 75, 0x4c4c554e, 0xffffffff], rows = [];
    for (const format of formats) for (const host of [0, 1, 2, 3, 12, 13, 14, 15]) {
        const fp32 = ref.float32Formats.includes(format), initial = fp32 && !(host & 1) ? 1 : 2;
        assert.equal(F.autoGenDefaultFilter(format, host), initial);
        for (const filter of filters) {const expected = ref.acceptedFilters.includes(filter) && (filter === 1 || !fp32 || !!(host & 1)); assert.equal(F.autoGenFilterSupported(format, filter, host), expected);rows.push([format,host,filter,Number(expected),initial]);}
        for (const type of [1,3,4,5,6]) assert.equal(F.autoGenMipsSupported(type, format), ref.validTypes.includes(type) && ref.generationFormats.includes(format));
    }
    const creation = [];
    for (const levels of [0,1,2,4,0xffffffff]) for (const pool of [0,1,2,3,0xffffffff]) for (const usage of [0,0x200,0x400,0x401,0x402,0x600,0x80000400]) {
        const expected = !(usage & ref.autoGen) || (ref.validAutoGenLevels.includes(levels) && ref.validAutoGenPools.includes(pool) && !(usage & ref.dynamic));
        assert.equal(F.autoGenCreationValid(levels,usage,pool),expected);creation.push([levels,usage,pool,Number(expected)]);
    }
    const functions = ["emit_generate_mips", "texture_set_auto_gen_filter_type", "texture_get_auto_gen_filter_type", "texture_generate_mip_sublevels", "cube_set_auto_gen_filter_type", "cube_get_auto_gen_filter_type", "cube_generate_mip_sublevels", "emit_texture_create", "emit_cube_texture_create"].map(extract).join("\n");
    const code = `#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "${process.env.D9WG_AUTOGEN_HEADER || site + "/glbridge/runtime/d9wg_format_queries.h"}"
#include "${site}/glbridge/d3d9proxy/d3d9_protocol.h"
typedef uint32_t DWORD,UINT,D3DTEXTUREFILTERTYPE;typedef int BOOL;typedef int32_t HRESULT;
#define WINAPI
#define TRUE 1
#define FALSE 0
#define D3D_OK 0
#define D3DERR_INVALIDCALL ((HRESULT)0x8876086cu)
#define D3DERR_DRIVERINTERNALERROR ((HRESULT)0x88760827u)
#define TRACE_REFUSE(hr) (hr)
#define D3DUSAGE_AUTOGENMIPMAP 0x400u
#define D3DTEXF_NONE 0u
#define D3DTEXF_POINT 1u
#define D3DTEXF_LINEAR 2u
#define ZeroMemory(p,n) memset(p,0,n)
typedef struct {UINT handle;} D9Device;
typedef struct {D9Device *device;UINT handle,usage,format,autogen_filter,width,height,edge_length,level_count,pool,multisample,multisample_quality;} D9Texture;
typedef D9Texture D9CubeTexture,IDirect3DTexture9,IDirect3DCubeTexture9;
static D9Texture *texture_from_iface(IDirect3DTexture9 *p){return p;}static D9CubeTexture *cube_from_iface(IDirect3DCubeTexture9 *p){return p;}
static uint32_t host_bits,emissions,fail_emit,last_opcode;static D9WGGenerateMips packet;
static uint32_t runtime_host_features(void){return host_bits;}
static BOOL emit_command(uint32_t opcode,const void *data,uint32_t size){emissions++;last_opcode=opcode;if(opcode==D9WG_OP_GENERATE_MIPS){if(size!=16)return FALSE;memcpy(&packet,data,size);}return !fail_emit;}
${functions}
static const uint32_t filters[][5]={${rows.map(r=>"{"+r.map(n=>n+"u").join(",")+"}").join(",")}};
static const uint32_t creation[][4]={${creation.map(r=>"{"+r.map(n=>n+"u").join(",")+"}").join(",")}};
#define CHECK(x) do{if(!(x)){fprintf(stderr,"autogen line %u row=%u: %s\\n",__LINE__,i,#x);return 1;}}while(0)
int main(void){UINT i=0;D9Device device={101};D9Texture t={0};t.device=&device;t.handle=202;t.usage=0x400;
 for(;i<sizeof(filters)/sizeof(filters[0]);++i){const uint32_t *r=filters[i];host_bits=r[1];CHECK(d9wg_autogen_default_filter(r[0],r[1])==r[4]);CHECK(d9wg_autogen_filter_supported(r[0],r[2],r[1])==(int)r[3]);
  for(UINT cube=0;cube<2;++cube){t.format=r[0];t.autogen_filter=r[4];emissions=0;fail_emit=0;HRESULT hr=cube?cube_set_auto_gen_filter_type(&t,r[2]):texture_set_auto_gen_filter_type(&t,r[2]);CHECK(hr==(r[3]?D3D_OK:D3DERR_INVALIDCALL));CHECK(t.autogen_filter==(r[3]?r[2]:r[4]));CHECK(emissions==r[3]);if(r[3]){CHECK(packet.device_handle==101&&packet.resource_handle==202&&packet.filter_type==r[2]&&packet.defer_generation==1);CHECK(last_opcode==D9WG_OP_GENERATE_MIPS);}CHECK((cube?cube_get_auto_gen_filter_type(&t):texture_get_auto_gen_filter_type(&t))==t.autogen_filter);
   fail_emit=1;UINT old=t.autogen_filter;CHECK((cube?cube_set_auto_gen_filter_type(&t,1):texture_set_auto_gen_filter_type(&t,1))==D3DERR_DRIVERINTERNALERROR);CHECK(t.autogen_filter==old);fail_emit=0;
   emissions=0;if(cube)cube_generate_mip_sublevels(&t);else texture_generate_mip_sublevels(&t);CHECK(emissions==1&&packet.defer_generation==0&&packet.filter_type==old);
   emissions=0;CHECK(cube?emit_cube_texture_create(&device,&t):emit_texture_create(&device,&t));CHECK(emissions==2&&packet.defer_generation==1&&packet.filter_type==old);
  }
 }
 for(i=0;i<sizeof(creation)/sizeof(creation[0]);++i){const uint32_t *r=creation[i];CHECK(d9wg_autogen_creation_valid(r[0],r[1],r[2])==(int)r[3]);}
 t.usage=0;emissions=0;CHECK(texture_set_auto_gen_filter_type(&t,1)==D3DERR_INVALIDCALL);CHECK(cube_set_auto_gen_filter_type(&t,1)==D3DERR_INVALIDCALL);CHECK(texture_get_auto_gen_filter_type(&t)==0&&cube_get_auto_gen_filter_type(&t)==0);texture_generate_mip_sublevels(&t);cube_generate_mip_sublevels(&t);CHECK(!emissions);
 puts("PASS actual autogen C: 2856 filter contexts, 175 creation combinations, real setters/getters/generation/config replay, SDK invalid NONE and atomic transport failures");return 0;}
`;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "d9wg-autogen-"));
    try {const input=path.join(directory,"autogen.c"),binary=path.join(directory,"autogen");fs.writeFileSync(input,code);const build=spawnSync(process.env.HOST_CC||"cc",["-std=c11","-Os","-Wall","-Wextra","-Werror",input,"-o",binary],{encoding:"utf8"});assert.equal(build.status,0,build.stderr);const run=spawnSync(binary,[],{encoding:"utf8"});assert.equal(run.status,0,run.stderr);process.stdout.write(run.stdout);}finally{fs.rmSync(directory,{recursive:true,force:true});}
    console.log("PASS independent JS autogen format, filter, default and creation facts");
})().catch(error=>{console.error(error);process.exitCode=1});
