"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), zlib = require("node:zlib");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
for (const part of ["objects", "state", "raster", "fixed", "misc", "stencil_ext", "render", "arrays", "images", "buffers", "queries"])
    require("../../src/browser/glbridge/gl-webgpu/gl_shadow_" + part + ".js");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"), { GLStream } = require("./gl_stream_builder.js"),
    { createFakeHost } = require("./gl_fake_gpu.js"), { scene } = require("./gl_polygon_order_cases.js");
(async () => {
    const apple = require("./gl_conformance/polygon_order_reference.json"),
        mesa = JSON.parse(zlib.gunzipSync(fs.readFileSync(__dirname + "/gl_conformance/mesa_reference.json.gz"))).fixtures.polygon_order;
    assert.equal(apple.error, 0);assert.equal(mesa.error, 0);
    assert.ok(apple.probes.every((p, i) => p.rgba.every((v, j) => Math.abs(v - mesa.probes[i].rgba[j]) <= 1)));
    assert.ok(mesa.directProbes.every((p, i) => p.rgba.every((v, j) => Math.abs(v - mesa.probes[i].rgba[j]) <= 1)), "Mesa mixed modes equal explicit primitive order");
    for (const copied of [false, true]) {
        const { host, log } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true });await gpu.initialize();
        const cpu = new GLShadow();cpu.setCapabilities(gpu.capabilities());
        const memory = scene(new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1)).bytes(), segments = cpu.process(memory);
        for (const segment of segments || [{ offset: 0, length: memory.length }]) {
            const bytes = segment.bytes || memory.subarray(segment.offset, segment.offset + segment.length);gpu.submit(copied ? bytes.slice() : bytes, {});
        }
        assert.equal(cpu.current.error, 0);await gpu.idle();
        // Each original polygon schedules its front fill and back boundary
        // draws together. GPU clipping owns their counts (the wrong side is
        // an indirect no-op); the browser test checks the blended pixels.
        assert.deepEqual(log.draws.map(d => d.pipeline.descriptor.primitive.topology),
            Array.from({ length: 3 }, () => ["triangle-list", ...Array(9).fill("line-list")]).flat());
        assert.ok(log.draws.every(d => d.indirect));assert.equal(gpu.stats.refusals, 0);assert.equal(gpu.gpuErrors.errors.length, 0);
    }
    console.log("gl_polygon_order_test: Mesa mixed/explicit order, Apple explicit oracle, interleaved fill/line/fill blending order in both modes passed");
})().catch(error => {console.error(error);process.exitCode = 1;});
