"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), {spawnSync} = require("node:child_process");
const S = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_state.js"), reference = require("./fixtures/d3d_object_defaults_reference.json");
(async () => {
    const {site_directory} = await import("../lib/site.mjs"), site = site_directory(path.resolve(__dirname, "../.."));
    const header = process.env.D9WG_OBJECT_DEFAULTS_HEADER || site + "/glbridge/runtime/d9wg_state_defaults.h";
    const source = fs.readFileSync(process.env.D9WG_OBJECT_DEFAULTS_D9_SOURCE || site + "/glbridge/d3d9proxy/d3d9_proxy.c", "utf8");
    const native = require("./fixtures/d3d7_native_object_defaults.json");
    assert.equal(native.cases.length, 82);
    assert.equal(require("node:crypto").createHash("sha256").update(fs.readFileSync(site + "/" + native.source)).digest("hex"), native.sourceSha256);
    for (const line of native.cases) assert.match(line, /value=00000000 hr=00000000$/);
    for (const api of [7, 8, 9]) {
        const m = S.materialDefaults(api), floats = [...m.diffuse, ...m.ambient, ...m.specular, ...m.emissive, m.power];
        assert.deepEqual(Array.from(new Uint32Array(new Float32Array(floats).buffer)), reference.materialWords[api]);
        m.diffuse[0] = 0.5;
        assert.notEqual(S.materialDefaults(api).diffuse[0], 0.5);
    }
    const {makeExecutor} = require("./d3d9_webgpu_executor_test.js"), {executor} = makeExecutor();
    const a = executor.createDeviceState(1), b = executor.createDeviceState(2);
    assert.deepEqual(a.material, S.materialDefaults(9));
    for (const plane of a.clipPlanes) assert.deepEqual(plane, [0, 0, 0, 0]);
    a.material.diffuse[0] = 1; a.clipPlanes[0][3] = 7;
    assert.equal(b.material.diffuse[0], 0); assert.equal(b.clipPlanes[0][3], 0); assert.equal(a.clipPlanes[1][3], 0);
    const P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
    await executor.initialize();
    const create = P.encode("CreateDevice", {device_handle: 31, width: 64, height: 64, windowed: 1, backbuffer_format: 22});
    executor.onCreateDevice(create, new DataView(create.buffer), 0, create.length);
    const old = executor.devices.get(31); old.material.diffuse[0] = 1; old.clipPlanes[5][0] = 2;
    old.lights.set(0xffffffff, {enabled: true}); old.lightEnabled.set(0xffffffff, true);
    const reset = P.encode("ResetDevice", {old_device_handle: 31, new_device_handle: 32, width: 64, height: 64, windowed: 1, backbuffer_format: 22});
    executor.onReset(reset, new DataView(reset.buffer), 0, reset.length);
    const fresh = executor.devices.get(32);
    assert.deepEqual(fresh.material, S.materialDefaults(9)); assert.deepEqual(fresh.clipPlanes, Array.from({length: 6}, () => [0, 0, 0, 0])); assert.equal(fresh.lights.size, 0); assert.equal(fresh.lightEnabled.size, 0);
    function extract(name) {
        const m = new RegExp("static (?:void|UINT) " + name + "\\([^;]*?\\)\\s*\\{").exec(source); assert(m, name);
        let at = source.indexOf("{", m.index) + 1, depth = 1;
        for (; depth; ++at) { assert(at < source.length); if (source[at] === "{") ++depth; if (source[at] === "}") --depth; }
        return source.slice(m.index, at);
    }
    const code = `#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "${header}"
#include "${site}/glbridge/d3d9proxy/d3d9_protocol.h"
typedef uint32_t UINT,DWORD;typedef int BOOL;
#define TRUE 1
#define FALSE 0
#define ZeroMemory(p,n) memset(p,0,n)
#define CopyMemory(p,q,n) memcpy(p,q,n)
typedef struct {uint32_t words[26];} Light;
#define D9WG_LIGHTING_SDK_LIGHT Light
static unsigned freed;
static void release_light(void *p){++freed;free(p);}
#define D9WG_LIGHT_ALLOC(n) calloc(1,n)
#define D9WG_LIGHT_FREE(p) release_light(p)
#include "${site}/glbridge/runtime/d9wg_light_state.h"
#define D9_MAX_CLIP_PLANES 6
#define D9_MAX_TEXTURE_STAGES 8
#define D9_MAX_SAMPLERS 20
#define D9_MAX_STREAMS 16
#define D9_MAX_TRANSFORMS 512
typedef struct {float MaxPointSize;} D3DCAPS9;
static void fill_caps(D3DCAPS9 *c){c->MaxPointSize=256;}
static void d9wg_clip_status_init(UINT *p){*p=0;}
typedef struct {UINT compatibility_api;} D9Parent;
typedef struct {D9Parent *parent;UINT current_palette,clip_status;BOOL clip_status_valid;
 DWORD render_states[256],texture_stage_states[8][33],sampler_states[20][14];
 float material[17],clip_planes[6][4];Light lights[8];BOOL light_set[8],light_enabled[8];D9WGLightState *extra_lights;
 struct {UINT frequency;} streams[16];float transforms[512][16];struct {BOOL EnableAutoDepthStencil;} present;
} D9Device;
${extract("device_compatibility_api")}
${extract("device_init_states_for_api")}
${extract("device_init_states")}
static UINT emitted,attempts;static BOOL fail;static D9WGSetMaterial command;
static BOOL emit_command(uint16_t op,const void *p,uint32_t n){++attempts;if(fail)return FALSE;if(op!=D9WG_OP_SET_MATERIAL||n!=sizeof(command))return FALSE;++emitted;memcpy(&command,p,n);return TRUE;}
#include "${process.env.D9WG_OBJECT_DEFAULTS_BRIDGE || site + "/glbridge/runtime/d9wg_state_defaults_bridge.h"}"
#define CHECK(x) do{if(!(x)){fprintf(stderr,"object default line %u: %s\\n",__LINE__,#x);return 1;}}while(0)
static const uint32_t refs[3][17]={${[7,8,9].map(api => "{" + reference.materialWords[api].join(",") + "}").join(",")}};
static int zero(const void *p,size_t n){const unsigned char *v=p;while(n--)if(*v++)return 0;return 1;}
int main(void){
 struct {uint32_t before,material[17],after;} m;struct {uint32_t before,planes[24],after;} p;
 for(UINT api=7;api<=9;++api){memset(&m,0xcc,sizeof(m));memset(&p,0xcc,sizeof(p));d9wg_object_defaults(api,m.material,p.planes,6);
 CHECK(!memcmp(m.material,refs[api-7],68));CHECK(zero(p.planes,96));CHECK(m.before==0xccccccccu&&m.after==0xccccccccu&&p.before==0xccccccccu&&p.after==0xccccccccu);
 for(UINT i=0;i<17;++i)CHECK(d9wg_material_default_word(api,i)==refs[api-7][i]);
 UINT before=emitted;CHECK(emit_object_default_patches(77,m.material));CHECK(emitted-before==(api==8));
 if(api==8){CHECK(command.device_handle==77&&!memcmp(command.diffuse,refs[1],68));fail=TRUE;UINT old=attempts;CHECK(!emit_object_default_patches(77,m.material)&&attempts==old+1);fail=FALSE;CHECK(!memcmp(m.material,refs[1],68));}}
 CHECK(emitted==1&&attempts==2);
 static D9Device d;D9Parent parent={9};memset(&d,0x5a,sizeof(d));d.parent=&parent;d.extra_lights=0;CHECK(d9wg_light_get(&d.extra_lights,8,1)&&d9wg_light_get(&d.extra_lights,0xffffffffu,1));
 device_init_states(&d);CHECK(!d.extra_lights&&freed==2);CHECK(zero(d.material,sizeof(d.material))&&zero(d.clip_planes,sizeof(d.clip_planes)));
 CHECK(zero(d.lights,sizeof(d.lights))&&zero(d.light_set,sizeof(d.light_set))&&zero(d.light_enabled,sizeof(d.light_enabled)));
 device_init_states(&d);CHECK(!d.extra_lights&&freed==2);
 puts("PASS C object defaults: 51 independent material words, guarded zero planes, exact API8 wire material, failure propagation and actual D3D9 Reset low/sparse light cleanup");return 0;}
`;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "d9wg-object-defaults-"));
    try {
        const file = path.join(directory, "defaults.c"), binary = path.join(directory, "defaults"); fs.writeFileSync(file, code);
        const build = spawnSync(process.env.HOST_CC || "cc", ["-std=c11", "-Os", "-Wall", "-Wextra", "-Werror", "-I", site + "/glbridge/runtime", file, "-o", binary], {encoding: "utf8"}); assert.equal(build.status, 0, build.stderr);
        const run = spawnSync(binary, [], {encoding: "utf8"}); assert.equal(run.status, 0, run.stderr); process.stdout.write(run.stdout);
    } finally { fs.rmSync(directory, {recursive: true, force: true}); }
    console.log("PASS JS object defaults: native7/SDK8/SDK9 facts, device isolation and host Reset");
})().catch(error => {console.error(error); process.exitCode = 1;});
