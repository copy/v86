"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
for (const part of ["objects", "state", "raster", "fixed", "misc", "stencil_ext", "render", "arrays", "images", "buffers", "queries", "glsl"])
    require("../../src/browser/glbridge/gl-webgpu/gl_shadow_" + part + ".js");
const { Glslang } = require("../../src/browser/glbridge/gl-webgpu/gl_glslang.js"), { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"),
    { GLStream, GL } = require("./gl_stream_builder.js"), { createFakeHost } = require("./gl_fake_gpu.js"), { scene } = require("./gl_stencil_faces_cases.js");
const oracle = require("./gl_conformance/stencil_faces_reference.json").cases, compiler = new Glslang(fs.readFileSync(__dirname + "/../../bios/glslang.wasm"));
const mesa = JSON.parse(require("node:zlib").gunzipSync(fs.readFileSync(__dirname + "/gl_conformance/mesa_reference.json.gz"))).fixtures.stencil_faces.cases;
assert.deepEqual(mesa, oracle, "both native drivers agree on every pixel");
(async () => {
    for (const copied of [false, true]) {
        const { host, log } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true });await gpu.initialize();
        const cpu = new GLShadow();cpu.setCapabilities(gpu.capabilities());cpu.setGlslang(compiler);
        const submit = s => {
            const memory = s.bytes(), segments = cpu.process(memory);
            for (const segment of segments || [{ offset: 0, length: memory.length }]) {
                const bytes = segment.bytes || memory.subarray(segment.offset, segment.offset + segment.length);gpu.submit(copied ? bytes.slice() : bytes, {});
            }
            assert.equal(cpu.current.error, 0);
        };
        submit(new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1).call("ENABLE", GL.STENCIL_TEST));
        for (const entry of oracle) {
            const before = log.draws.length;submit(scene(new GLStream(), entry.name));
            const draws = log.draws.slice(before), front = draws[0].pipeline.descriptor;
            assert.equal(front.depthStencil.stencilFront.compare, front.depthStencil.stencilBack.compare);
            if (entry.name === "front_ref" || entry.name === "back_ref") assert.deepEqual(draws.map(d => d.stencilReference), [3, 9]);
            if (entry.name === "ordered_overlap") {
                assert.equal(draws.length, 6, "each overlapping primitive retains its adjacent front/back draws");
                assert.deepEqual(draws.map(d => d.pipeline.descriptor.primitive.cullMode), ["back", "front", "back", "front", "back", "front"]);
            }
            if (entry.name === "write_masks") assert.deepEqual(draws.map(d => d.pipeline.descriptor.depthStencil.stencilWriteMask), [15, 240, 15, 240]);
            if (entry.name === "back_read_mask") assert.deepEqual(draws.map(d => d.pipeline.descriptor.depthStencil.stencilReadMask), [15, 240]);
            if (entry.name === "cull_back") assert.ok(draws.every(d => d.pipeline.descriptor.primitive.cullMode === "back"));
        }
        await gpu.idle();assert.equal(gpu.stats.refusals, 0);assert.equal(gpu.gpuErrors.errors.length, 0);
    }
    console.log("gl_stencil_faces_test: per-primitive ordered front/back pipelines, distinct refs/read/write masks and culling in both modes passed");
})().catch(error => {console.error(error);process.exitCode = 1;});
