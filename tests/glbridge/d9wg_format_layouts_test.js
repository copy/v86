"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), {spawnSync} = require("node:child_process");
const F = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_formats.js"), reference = require("./fixtures/d3d_format_layout_reference.json");
(async () => {
    const {site_directory} = await import("../lib/site.mjs"), site = site_directory(path.resolve(__dirname, "../.."));
    const header = process.env.D9WG_FORMAT_LAYOUTS_HEADER || site + "/glbridge/runtime/d9wg_format_layouts.h";
    const rows = reference.geometry.map(([format, w, h, bytes]) => [format, w, h, bytes, [7, 8, 9].reduce((mask, api) => mask | (reference.frontendFormats[api].includes(format) ? 1 << (api - 7) : 0), 0), Number(reference.legacyDepthFormats.includes(format))]);
    assert.equal(rows.length, 58);
    for (const row of rows) {
        assert.deepEqual(F.formatLayout(row[0]), row);
        assert.equal(F.isCompressedFormat(row[0]), row[2] === 4);
        assert.equal(F.compressedBlockBytes(row[0]), row[2] === 4 ? row[3] : 0);
        assert.equal(F.isPackedPairFormat(row[0]), row[1] === 2);
        for (const api of [7, 8, 9]) assert.deepEqual(F.formatLayout(row[0], api), row[4] & (1 << (api - 7)) ? row : null);
        assert(Object.isFrozen(F.formatLayout(row[0])));
    }
    for (const format of [0, 19, 37, 100, 199, 0xffffffff]) { assert.equal(F.formatLayout(format), null); assert.equal(F.isCompressedFormat(format), false); assert.equal(F.compressedBlockBytes(format), 0); }
    assert.equal(F.formatLayout(21, 6), null); assert.equal(F.formatLayout(21, 10), null);
    function extract(source, name, prefix) {
        const m = new RegExp("static (?:BOOL|UINT) " + name + "\\([^;]*?\\)\\s*\\{").exec(source); assert(m, name);
        let at = source.indexOf("{", m.index) + 1, depth = 1;
        for (; depth; ++at) { assert(at < source.length); if (source[at] === "{") ++depth; if (source[at] === "}") --depth; }
        return source.slice(m.index, at).replace(name + "(", prefix + name + "(");
    }
    const functions = [];
    for (const api of [8, 9]) { const source = fs.readFileSync(site + "/glbridge/d3d" + api + "proxy/d3d" + api + "_proxy.c", "utf8"); for (const name of ["texture_format_layout", "texture_level_layout"]) functions.push(extract(source, name, "d" + api + "_")); }
    const dd = fs.readFileSync(site + "/glbridge/ddrawproxy/ddraw_proxy.c", "utf8"); for (const name of ["format_bytes_per_pixel", "format_compressed_block_bytes", "format_is_depth"]) functions.push(extract(dd, name, ""));
    const sizes = [[0, 0], [1, 1], [3, 5], [4, 4], [7, 9], [4096, 4096], [0xffffffff, 1], [0xffffffff, 0xffffffff], [0, 0xffffffff], [0xfffffffe, 2]], levels = [];
    for (const api of [8, 9]) for (const row of rows) for (const [w, h] of sizes) {
        const [format, bw, bh, bytes, mask] = row, columns = (BigInt(w) + BigInt(bw) - 1n) / BigInt(bw), lines = (BigInt(h) + BigInt(bh) - 1n) / BigInt(bh), pitch = columns * BigInt(bytes), total = pitch * lines;
        const ok = !!(mask & (1 << (api - 7))) && pitch <= 0xffffffffn && total <= 0xffffffffn;
        levels.push([api, format, w, h, Number(ok), ok ? Number(pitch) : 0xcccccccc, ok ? Number(lines) : 0xcccccccc, ok ? Number(total) : 0xcccccccc]);
    }
    const code = `#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "${header}"
typedef uint32_t UINT,D3DFORMAT;typedef int BOOL;
${functions.join("\n")}
#define CHECK(x) do{if(!(x)){fprintf(stderr,"format layout line %u: %s\\n",__LINE__,#x);return 1;}}while(0)
static const uint32_t reference[][6]={${rows.map(r => "{" + r.map(n => n + "u").join(",") + "}").join(",")}};
static const uint32_t levels[][8]={${levels.map(r => "{" + r.map(n => n + "u").join(",") + "}").join(",")}};
int main(void){for(UINT i=0;i<58;++i){const uint32_t *r=reference[i];const D9WGFormatLayout *layout=d9wg_find_format(r[0]);CHECK(layout&&layout->format==r[0]&&layout->block_width==r[1]&&layout->block_height==r[2]&&layout->block_bytes==r[3]&&layout->apis==r[4]&&layout->depth==r[5]);
 CHECK(format_bytes_per_pixel(r[0])==((r[4]&1)&&r[1]==1&&r[2]==1?r[3]:0));CHECK(format_compressed_block_bytes(r[0])==((r[4]&1)&&r[2]==4?r[3]:0));CHECK(format_is_depth(r[0])==(int)r[5]);
 for(UINT api=7;api<=9;++api){UINT w=0xccccccccu,h=w,b=w;int ok=api==8?d8_texture_format_layout(r[0],&w,&h,&b):api==9?d9_texture_format_layout(r[0],&w,&h,&b):d9wg_format_layout(api,r[0],&w,&h,&b);CHECK(!!ok==!!(r[4]&(1u<<(api-7))));CHECK(w==(ok?r[1]:0xccccccccu)&&h==(ok?r[2]:0xccccccccu)&&b==(ok?r[3]:0xccccccccu));}}
 for(UINT i=0;i<sizeof(levels)/sizeof(levels[0]);++i){const UINT *r=levels[i];struct {UINT before,pitch,rows,bytes,after;} out={0x12345678,0xccccccccu,0xccccccccu,0xccccccccu,0x87654321};int ok=r[0]==8?d8_texture_level_layout(r[1],r[2],r[3],&out.pitch,&out.rows,&out.bytes):d9_texture_level_layout(r[1],r[2],r[3],&out.pitch,&out.rows,&out.bytes);CHECK(!!ok==(int)r[4]);CHECK(out.pitch==r[5]&&out.rows==r[6]&&out.bytes==r[7]&&out.before==0x12345678&&out.after==0x87654321);}
 UINT w=7,h=8,b=9;CHECK(!d9wg_find_format(0xffffffffu)&&!d9wg_format_layout(6,21,&w,&h,&b)&&w==7&&h==8&&b==9);CHECK(!d9wg_format_layout(9,21,0,&h,&b)&&h==8&&b==9);CHECK(!d9wg_texture_level_layout(9,0xffffffffu,1,1,&w,&h,&b)&&w==7&&h==8&&b==9);
 puts("PASS C format layouts: 58 SDK rows, actual D3D8/9/DDraw helpers, preserved API masks, 1160 independent BigInt level/overflow references and guarded atomic outputs");return 0;}
`;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "d9wg-format-layouts-"));
    try {
        if (!process.env.D9WG_FORMAT_LAYOUTS_HEADER) { const check = spawnSync(process.execPath, [path.resolve(__dirname, "../../tools/gen_d9wg_format_layouts.mjs"), "--check", header], {encoding: "utf8"}); assert.equal(check.status, 0, check.stderr); }
        const facts = spawnSync(process.execPath, [path.resolve(__dirname, "../../tools/gen_d3d_format_layout_reference.mjs")], {encoding: "utf8"}); assert.equal(facts.status, 0, facts.stderr);
        assert.equal(fs.readFileSync(site + "/glbridge/sample/d3d_format_layout_reference.h", "utf8"), facts.stdout);
        const file = path.join(directory, "layout.c"), binary = path.join(directory, "layout"); fs.writeFileSync(file, code);
        const build = spawnSync(process.env.HOST_CC || "cc", ["-std=c11", "-Os", "-Wall", "-Wextra", "-Werror", file, "-o", binary], {encoding: "utf8"}); assert.equal(build.status, 0, build.stderr);
        const run = spawnSync(binary, [], {encoding: "utf8"}); assert.equal(run.status, 0, run.stderr); process.stdout.write(run.stdout);
    } finally { fs.rmSync(directory, {recursive: true, force: true}); }
    console.log("PASS JS format layouts: independent SDK geometry, legacy API membership, paired/compressed routing and immutable facts");
})().catch(error => {console.error(error); process.exitCode = 1;});
