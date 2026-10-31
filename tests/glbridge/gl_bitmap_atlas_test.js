"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), zlib = require("node:zlib"), os = require("node:os"), path = require("node:path"), { execFileSync } = require("node:child_process");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
for (const part of ["objects", "state", "raster", "rasterpos", "pixelmaps", "fixed", "misc", "stencil_ext", "render", "arrays", "images", "textures", "buffers", "queries", "glsl", "arb"])
    require("../../src/browser/glbridge/gl-webgpu/gl_shadow_" + part + ".js");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"), { GLStream, GL } = require("./gl_stream_builder.js"),
    { createFakeHost } = require("./gl_fake_gpu.js"), cases = require("./gl_bitmap_atlas_cases.js"), { requireNaga } = require("./naga.js");
(async () => {
    const apple = require("./gl_conformance/bitmap_atlas_reference.json").cases,
        mesa = JSON.parse(zlib.gunzipSync(fs.readFileSync(__dirname + "/gl_conformance/mesa_reference.json.gz"))).fixtures.bitmap_atlas.cases, codes = new Set();
    assert.deepEqual(apple.map(e => e.name), cases.names);assert.deepEqual(mesa.map(e => e.name), cases.names);
    for (let i = 0; i < cases.names.length; ++i) {
        assert.equal(apple[i].error, 0);assert.equal(mesa[i].error, 0);
        assert.ok(apple[i].pixels.every((v, c) => Math.abs(v - mesa[i].pixels[c]) <= 1), cases.names[i]);assert.deepEqual(apple[i].stencil, mesa[i].stencil);
        assert.ok(apple[i].depth.every((v, c) => Math.abs(v - mesa[i].depth[c]) < 1e-6));
    }
    for (const copied of [false, true]) {
        const { host, log } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true });await gpu.initialize();
        const cpu = new GLShadow();cpu.setCapabilities(gpu.capabilities());
        const send = s => {
            const memory = s.bytes(), segments = cpu.process(memory);
            for (const segment of segments || [{ offset: 0, length: memory.length }]) {
                const bytes = segment.bytes || memory.subarray(segment.offset, segment.offset + segment.length);gpu.submit(copied ? bytes.slice() : bytes, {});
            }
            assert.equal(cpu.current.error, 0);
        };
        for (const [i, name] of cases.names.entries()) {
            const first = log.draws.length;send(cases.scene(new GLStream().makeCurrent(1, 0, 0, 16, 16, i + 1, i + 1), name));
            if (i === 0) {
                assert.equal(log.draws.length - first, 4);assert.equal(gpu.bitmapAtlas.entries.size, 1);
                assert.equal(gpu.bitmapAtlas.pages.length, 1);assert.equal(log.textureWrites.filter(w => w.destination.texture.descriptor.label === "GL bitmap mask atlas").length, 1);
                const draws = log.draws.slice(first);assert.equal(new Set(draws.map(d => d.pipeline)).size, 1);
                const groups = log.bindGroups.filter(g => g.descriptor.entries.some(e => e.resource === gpu.bitmapAtlas.pages[0].view));assert.equal(groups.length, 1, "color changes share atlas bindings");
            }
            if (i === 5) {assert.equal(log.draws.length - first, 2);assert.equal(gpu.current.current.rasterValid, false);}
            gpu.flushFrame();await gpu.idle();
        }
        // Canonical unpack state, not padding or source bit order, identifies a glyph.
        send(new GLStream().makeCurrent(1, 0, 0, 16, 16, 30, 30).call("PIXEL_STOREI", 0x0CF5, 1));
        const a = gpu.bitmapGlyph(new Uint8Array([0x80]), 1, 1);gpu.current.pixelStore.unpackLsbFirst = true;
        assert.equal(gpu.bitmapGlyph(new Uint8Array([1, 99]), 1, 1), a);gpu.current.pixelStore.unpackLsbFirst = false;
        const before = gpu.bitmapAtlas.pages[0].texture;
        for (let i = 1; i <= 5; ++i) {const bytes = new Uint8Array(512 * 64);bytes[0] = i;gpu.bitmapGlyph(bytes, 512, 512);}
        assert.ok(gpu.bitmapAtlas.pages.length <= 4);assert.ok(gpu.bitmapAtlas.entries.size <= 2048);assert.ok(!gpu.bitmapAtlas.pages.some(p => p.texture === before));
        const large = gpu.bitmapGlyph(new Uint8Array(65), 513, 1);assert.equal(large.transient, true);gpu.retire(large.texture);
        gpu.flushFrame();await gpu.idle();assert.equal(before.destroyed, true);
        for (const module of log.modules) if (module.code.includes("glBitmapColor")) codes.add(module.code);
        gpu.resources.invalidate();assert.equal(gpu.bitmapAtlas, null, "device invalidation drops atlas views and masks");
        assert.equal(gpu.stats.refusals, 0);assert.equal(gpu.hostErrors.length, 0);assert.equal(gpu.gpuErrors.errors.length, 0);
    }
    const naga = requireNaga("gl_bitmap_atlas_test");
    if (naga) {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gl-bitmap-atlas-"));
        try {let i = 0;for (const code of codes) {const file = path.join(directory, i++ + ".wgsl");fs.writeFileSync(file, code);execFileSync(naga, [file], { stdio: "pipe" });}}
        finally {fs.rmSync(directory, { recursive: true, force: true });}
    }
    console.log("gl_bitmap_atlas_test: eight dual-native scenes, canonical masks, cross-color sharing, bounded pages, oversized glyph and device invalidation passed in both modes");
})().catch(error => {console.error(String(error.stack || error));process.exitCode = 1;});
