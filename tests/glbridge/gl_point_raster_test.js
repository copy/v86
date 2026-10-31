"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), zlib = require("node:zlib");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
for (const part of ["objects", "state", "raster", "fixed", "misc", "stencil_ext", "render", "arrays", "images", "textures", "buffers", "queries", "glsl", "arb"])
    require("../../src/browser/glbridge/gl-webgpu/gl_shadow_" + part + ".js");
const { Glslang } = require("../../src/browser/glbridge/gl-webgpu/gl_glslang.js"),
    { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"), { GLStream } = require("./gl_stream_builder.js"),
    { createFakeHost } = require("./gl_fake_gpu.js"), { cases, setup, draw, expected } = require("./gl_point_raster_cases.js");
(async () => {
    const apple = require("./gl_conformance/point_raster_reference.json").cases,
        mesa = JSON.parse(zlib.gunzipSync(fs.readFileSync(__dirname + "/gl_conformance/mesa_reference.json.gz"))).fixtures.point_raster.cases,
        compiler = new Glslang(fs.readFileSync(__dirname + "/../../bios/glslang.wasm"));
    assert.deepEqual(apple.map(e => e.name), cases.map(e => e.name));assert.equal(mesa.length, cases.length);
    for (let i = 0; i < cases.length; ++i) {
        assert.equal(apple[i].error, 0, cases[i].name);assert.equal(mesa[i].error, 0, cases[i].name);
        if (["fixed_clipped", "glsl_clipped", "arb_clipped"].includes(cases[i].name)) {
            assert.deepEqual(apple[i].rows, mesa[i].rows, "raw guard-band expansion retained");assert.ok(expected(apple[i]).every(n => n === 0));
        } else if (cases[i].name === "glsl_minimum") {
            assert.deepEqual(apple[i].rows, apple.find(c => c.name === "fixed_even").rows);
            assert.deepEqual(mesa[i].rows, mesa.find(c => c.name === "fixed_minimum").rows, "raw Mesa point minimum difference retained");
        } else assert.deepEqual(expected(apple[i]), mesa[i].rows, cases[i].name + " native agreement after named differences");
    }
    for (const copied of [false, true]) {
        const { host, log } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true });await gpu.initialize();
        const cpu = new GLShadow();cpu.setCapabilities(gpu.capabilities());cpu.setGlslang(compiler);
        for (const [i, entry] of cases.entries()) {
            const stream = setup(new GLStream().makeCurrent(1, 0, 0, 16, 16, i + 1, i + 1), entry);draw(stream, entry);
            const memory = stream.bytes(), segments = cpu.process(memory);
            for (const segment of segments || [{ offset: 0, length: memory.length }]) {
                const bytes = segment.bytes || memory.subarray(segment.offset, segment.offset + segment.length);gpu.submit(copied ? bytes.slice() : bytes, {});
            }
            gpu.flushFrame();await gpu.idle();assert.equal(cpu.current.error, 0, entry.name);
            const primitive = log.draws.at(-1), buffers = primitive.pipeline.descriptor.vertex.buffers;
            if (entry.polygon) {
                assert.equal(primitive.indirect, true, "the GPU supplies the clipped point count");assert.equal(buffers.length, 0);
            } else {
                assert.ok(buffers.every(b => b.stepMode === "instance"), entry.name + " one input per point");
                assert.equal(buffers.length, 1, "no extra corner buffer");assert.equal(primitive.indexed, undefined);
                assert.equal(primitive.count, 6);assert.equal(primitive.instances, entry.indexed ? 2 : 1);
            }
            if (entry.attributes) assert.equal(buffers[0].attributes.length, 16, "all sixteen attributes remain available");
        }
        assert.equal(gpu.stats.refusals, 0);assert.equal(gpu.hostErrors.length, 0);assert.equal(gpu.gpuErrors.errors.length, 0);
    }
    console.log("gl_point_raster_test: 28 native cases, all attributes, matrix columns, indexed/polygon instances, GLSL/ARB point size and named native differences in both modes passed");
})().catch(error => {console.error(String(error.stack || error));process.exitCode = 1;});
