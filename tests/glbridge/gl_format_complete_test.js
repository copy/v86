"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"),
    zlib = require("node:zlib");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
for (const part of ["objects", "state", "raster", "fixed", "misc", "stencil_ext", "render", "arrays", "images", "textures", "buffers", "queries", "glsl", "arb"])
    require("../../src/browser/glbridge/gl-webgpu/gl_shadow_" + part + ".js");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"), { GLStream, GL } = require("./gl_stream_builder.js"),
    { createFakeHost } = require("./gl_fake_gpu.js"), { cases, scene } = require("./gl_format_complete_cases.js");
(async () => {
    const apple = require("./gl_conformance/format_complete_reference.json").cases,
        mesa = JSON.parse(zlib.gunzipSync(fs.readFileSync(__dirname + "/gl_conformance/mesa_reference.json.gz"))).fixtures.format_complete.cases,
        differences = new Set(["rgba_rgba8", "numeric_rgba8", "srgb_srgb8", "numeric_rgba"]);
    assert.deepEqual(apple.map(e => e.name), cases.map(e => e[0]));assert.deepEqual(mesa.map(e => e.name), cases.map(e => e[0]));
    for (let i = 0; i < cases.length; ++i) {
        assert.equal(apple[i].error, 0);assert.equal(mesa[i].error, 0);
        if (differences.has(cases[i][0])) {assert.notDeepEqual(apple[i].rgba, mesa[i].rgba);assert.deepEqual(mesa[i].rgba, [255, 255, 255, 255]);}
        else assert.deepEqual(apple[i].rgba, mesa[i].rgba);
    }
    for (const copied of [false, true]) {
        const { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true });await gpu.initialize();
        const cpu = new GLShadow();cpu.setCapabilities(gpu.capabilities());
        for (const [i, entry] of cases.entries()) {
            const memory = scene(new GLStream().makeCurrent(1, 0, 0, 16, 16, i + 1, i + 1), entry).bytes(), segments = cpu.process(memory);
            for (const segment of segments || [{ offset: 0, length: memory.length }]) {
                const bytes = segment.bytes || memory.subarray(segment.offset, segment.offset + segment.length);gpu.submit(copied ? bytes.slice() : bytes, {});
            }
            assert.equal(cpu.current.error, 0);gpu.flushFrame();await gpu.idle();
            assert.equal(gpu.textureIsComplete(gpu.boundTexture(GL.TEXTURE_2D)), ["same_rgba4", "numeric_rgba"].includes(entry[0]), entry[0]);
        }
        const source = gpu.boundTexture(GL.TEXTURE_2D), cube = { ...source, kind: "Cube", sampler: { ...source.sampler, minFilter: GL.NEAREST },
            levels: Array.from({ length: 6 }, () => [{ ...source.levels[0][0] }]) };
        assert.equal(gpu.textureIsComplete(cube), true);
        cube.levels[5][0].formatClass = GL.RGBA8;assert.equal(gpu.textureIsComplete(cube), false, "cube faces also require the same defined internal format");
        assert.equal(gpu.stats.refusals, 0);assert.equal(gpu.hostErrors.length, 0);assert.equal(gpu.gpuErrors.errors.length, 0);
    }
    console.log("gl_format_complete_test: 13 Apple/Mesa references, strict sized identity, legacy numeric aliases, mip and cube completeness in both modes passed");
})().catch(error => {console.error(String(error.stack || error));process.exitCode = 1;});
