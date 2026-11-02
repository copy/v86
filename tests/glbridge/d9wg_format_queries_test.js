"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), {spawnSync} = require("node:child_process");
const F = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_formats.js"), ref = require("./fixtures/d3d_format_query_reference.json"), layout = require("./fixtures/d3d_format_layout_reference.json"), autogen = require("./fixtures/d3d_autogen_reference.json");
(async () => {
    const {site_directory} = await import("../lib/site.mjs"), site = site_directory(path.resolve(__dirname, "../..")), bits = Object.values(ref.queryBits), color = new Set(layout.frontendFormats[9]), depth = new Set(ref.comparisonDepthFormats), raw = new Set(ref.rawDepthFormats), srgb = new Set(ref.srgbStorageFormats), fp32 = new Set(ref.float32Formats), targets = new Set(ref.renderTargetFormats), bc = new Set(ref.nativeBCFormats);
    for (const [name, value] of Object.entries(ref.queryBits)) assert.equal(F.FORMAT_QUERY[name], value);
    const formats = [...color, ...depth, ...raw, 0x4c4c554e, 0xffffffff], contexts = [];
    for (const format of formats) for (const type of Object.values(ref.resourceTypes)) for (const host of [0, 1, 2, 3, 12, 13, 14, 15]) for (const profile of ref.shaderProfiles) {
        // Independent permitted-bitset model: a compound request succeeds only
        // if every requested capability is in the permitted set for its context.
        const texture = [3, 4, 5].includes(type), renderable = targets.has(format), output = renderable && [1, 3, 5].includes(type), available = !bc.has(format) || !!(host & 4), allowed = [];
        if (texture && (color.has(format) || depth.has(format)) && (!fp32.has(format) || (host & 1))) allowed.push("FILTER");
        if (texture && srgb.has(format)) allowed.push("SRGBREAD");
        if (output && srgb.has(format)) allowed.push("SRGBWRITE");
        if (output && color.has(format) && (!fp32.has(format) || (host & 2))) allowed.push("BLENDING");
        if (type === 3 && profile === 3 && color.has(format)) allowed.push("VERTEXTEXTURE");
        if (texture && color.has(format)) allowed.push("WRAPANDMIP");
        const mask = allowed.reduce((n, name) => n | ref.queryBits[name], 0), base = type !== 6 && color.has(format);
        contexts.push([format, type, host, profile, Number(renderable), mask, Number(base), Number(available), Number(autogen.validTypes.includes(type) && autogen.generationFormats.includes(format))]);
        for (let combination = 0; combination < 128; ++combination) {
            const request = bits.reduce((q, bit, i) => q | (combination & (1 << i) ? bit : 0), 0), expected = available && (request & ~mask) === 0;
            assert.equal(F.formatQuerySupported(type, request, format, host, profile, renderable), expected, `${format}/${type}/${host}/${profile}/${request}`);
            assert.equal(F.formatQuerySupported(type, request | 0x10, format, host, profile, renderable), false);
        }
    }
    assert.equal(formats.length, 60); assert.equal(contexts.length, 7200);
    const source = fs.readFileSync(process.env.D9WG_FORMAT_QUERY_D9_SOURCE || site + "/glbridge/d3d9proxy/d3d9_proxy.c", "utf8"), start = source.indexOf("static HRESULT WINAPI d3d_check_device_format("), end = source.indexOf("\n}\n", start) + 3; assert(start >= 0 && end > start);
    const code = `#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "${process.env.D9WG_FORMAT_QUERY_HEADER || site + "/glbridge/runtime/d9wg_format_queries.h"}"
#include "${site}/glbridge/d3d9proxy/d3d9_protocol.h"
typedef uint32_t DWORD,UINT,D3DFORMAT,D3DDEVTYPE,D3DRESOURCETYPE;typedef int BOOL;typedef int32_t HRESULT;typedef void IDirect3D9;
#define WINAPI
#define TRUE 1
#define FALSE 0
#define D3D_OK 0
#define D3DOK_NOAUTOGEN ((HRESULT)0x0876086fu)
#define D3DERR_NOTAVAILABLE ((HRESULT)0x8876086au)
#define D3DDEVTYPE_HAL 1u
#define D3DPOOL_DEFAULT 0u
#define D3DRTYPE_TEXTURE 3u
#define D3DRTYPE_VOLUMETEXTURE 4u
#define D3DRTYPE_CUBETEXTURE 5u
#define D3DUSAGE_SOFTWAREPROCESSING 0x10u
#define D3DUSAGE_AUTOGENMIPMAP 0x400u
#define D3DUSAGE_DYNAMIC 0x200u
#define D3DUSAGE_DMAP 0x4000u
${Object.entries(ref.queryBits).map(([n, v]) => "#define D3DUSAGE_QUERY_" + (n === "BLENDING" ? "POSTPIXELSHADER_BLENDING" : n) + " " + v + "u").join("\n")}
#define D9FOURCC_NO_PCF 0x4643502du
#define TRACE(...) ((void)0)
#define HOSTLOG_INFO(...) ((void)0)
#define HOSTLOG_REFUSED(...) ((void)0)
#define SUCCEEDED(x) ((HRESULT)(x)>=0)
static UINT host_bits,profile,renderable,base,requests,wanted_usage;static int g_transport_lock;static void *g_process;
static void EnterCriticalSection(int *lock){++*lock;}static void LeaveCriticalSection(int *lock){--*lock;}
static BOOL submit_batch_locked(BOOL present){(void)present;return TRUE;}
static UINT shader_model_version(void){return profile;}
static BOOL supported_render_target_format(D3DFORMAT format){(void)format;return renderable;}
static BOOL texture_create_supported(D3DRESOURCETYPE type,DWORD usage,D3DFORMAT format,DWORD pool){(void)type;(void)format;if(usage!=wanted_usage||pool) return FALSE;return base;}
static uint32_t d9wg_transport_host_features(void *process,uint32_t features,BOOL (*flush)(BOOL)){(void)process;if(g_transport_lock!=1||features!=(profile>=3?3u:profile>=2?1u:0u)||flush!=submit_batch_locked)return 0;requests++;return host_bits;}
${source.match(/static uint32_t runtime_host_features\(void\)[\s\S]*?\n}/)[0]}
${source.slice(start, end)}
static const uint32_t contexts[][9]={${contexts.map(r => "{" + r.map(n => n + "u").join(",") + "}").join(",")}};
static const uint32_t bits[]={${bits.map(n => n + "u").join(",")}};
#define CHECK(x) do{if(!(x)){fprintf(stderr,"format query line %u context=%u combo=%u: %s\\n",__LINE__,context,combo,#x);return 1;}}while(0)
int main(void){UINT context=0,combo=0;for(;context<sizeof(contexts)/sizeof(contexts[0]);++context){const uint32_t *r=contexts[context];host_bits=r[2];profile=r[3];renderable=r[4];base=r[6];for(combo=0;combo<128;++combo){UINT query=0;for(UINT i=0;i<7;++i)if(combo&(1u<<i))query|=bits[i];int expected=r[7]&&(query&~r[5])==0;CHECK(d9wg_format_query_supported(r[1],query,r[0],r[2],r[3],r[4])==expected);CHECK(!d9wg_format_query_supported(r[1],query|0x10u,r[0],r[2],r[3],r[4]));requests=0;CHECK((d3d_check_device_format(0,0,1,22,query,r[1],r[0])==0)==(base&&expected));CHECK((d3d_check_device_format(0,0,1,22,query|0x10u,r[1],r[0])==0)==0);CHECK(!!d9wg_autogen_mips_supported(r[1],r[0])==!!r[8]);CHECK(d3d_check_device_format(0,0,1,22,query|0x400u,r[1],r[0])==((base&&expected&&(r[1]==3||r[1]==5))?(r[8]?D3D_OK:D3DOK_NOAUTOGEN):D3DERR_NOTAVAILABLE));wanted_usage=0x200u;CHECK(d3d_check_device_format(0,0,1,22,query|0x600u,r[1],r[0])==D3DERR_NOTAVAILABLE);wanted_usage=0;CHECK(!g_transport_lock);if(!base)CHECK(!requests);}}
 for(UINT mask=0;mask<4;++mask){host_bits=mask;profile=3;renderable=base=1;wanted_usage=1;CHECK((d3d_check_device_format(0,0,1,22,D3DUSAGE_QUERY_FILTER|1u,3,116)==0)==!!(mask&1u));CHECK((d3d_check_device_format(0,0,1,22,D3DUSAGE_QUERY_POSTPIXELSHADER_BLENDING|1u,1,116)==0)==!!(mask&2u));}
 wanted_usage=2;host_bits=3;renderable=0;base=1;CHECK(d3d_check_device_format(0,0,1,22,D3DUSAGE_QUERY_FILTER|2u,3,75)==0);CHECK(d3d_check_device_format(0,0,1,22,D3DUSAGE_QUERY_FILTER|2u,3,0x5a544e49u)==D3DERR_NOTAVAILABLE);
 CHECK(d3d_check_device_format(0,1,1,22,0,3,21)==D3DERR_NOTAVAILABLE);CHECK(d3d_check_device_format(0,0,2,22,0,3,21)==D3DERR_NOTAVAILABLE);
 puts("PASS actual C format queries: 7200 independent permitted-bitset contexts, all 128 query combinations, software-processing refusal, autogen/NOAUTOGEN/dynamic combinations and SDK frontend feature/lock integration");return 0;}
`;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "d9wg-format-queries-"));
    try {
        if (!process.env.D9WG_FORMAT_QUERY_HEADER) { const check = spawnSync(process.execPath, [path.resolve(__dirname, "../../tools/gen_d9wg_format_queries.mjs"), "--check", site + "/glbridge/runtime/d9wg_format_queries.h"], {encoding: "utf8"}); assert.equal(check.status, 0, check.stderr); }
        const facts = spawnSync(process.execPath, [path.resolve(__dirname, "../../tools/gen_d3d_format_query_reference.mjs")], {encoding: "utf8"}); assert.equal(facts.status, 0, facts.stderr);
        assert.equal(fs.readFileSync(site + "/glbridge/sample/d3d_format_query_reference.h", "utf8"), facts.stdout);
        const file = path.join(directory, "queries.c"), binary = path.join(directory, "queries"); fs.writeFileSync(file, code);
        const build = spawnSync(process.env.HOST_CC || "cc", ["-std=c11", "-Os", "-Wall", "-Wextra", "-Werror", file, "-o", binary], {encoding: "utf8"}); assert.equal(build.status, 0, build.stderr);
        const run = spawnSync(binary, [], {encoding: "utf8"}); assert.equal(run.status, 0, run.stderr); process.stdout.write(run.stdout);
    } finally {fs.rmSync(directory, {recursive: true, force: true});}
    console.log("PASS JS query policy: independent SDK flags and physical sRGB/float/depth facts, eight host masks including absent BC, shader profiles and compound requests");
})().catch(error => {console.error(error); process.exitCode = 1;});
