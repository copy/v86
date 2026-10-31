"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), zlib = require("node:zlib");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
for (const part of ["objects", "state", "raster", "fixed", "misc", "stencil_ext", "render", "arrays", "images", "buffers", "queries"])
    require("../../src/browser/glbridge/gl-webgpu/gl_shadow_" + part + ".js");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"), { GLStream, GL } = require("./gl_stream_builder.js"),
    { createFakeHost } = require("./gl_fake_gpu.js"), { scene } = require("./gl_blit_aspects_cases.js");
const apple = require("./gl_conformance/blit_aspects_reference.json").cases,
    mesa = JSON.parse(zlib.gunzipSync(fs.readFileSync(__dirname + "/gl_conformance/mesa_reference.json.gz"))).fixtures.blit_aspects.cases;
for (let i = 0; i < apple.length; ++i) {
    assert.equal(mesa[i].name, apple[i].name);assert.equal(mesa[i].error, apple[i].error);
    for (let j = 0; j < 2; ++j) {
        const a = apple[i].pixels[j], m = mesa[i].pixels[j];
        assert.ok(Math.abs(a.depth - m.depth) <= 2 ** -23, "native depth quantization");
        assert.equal(m.stencil, a.stencil);assert.deepEqual(m.rgba, a.rgba);
    }
}
(async () => {
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
        send(new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1));
        for (const { name } of apple) {
            const before = log.passes.length;send(scene(new GLStream(), name));
            const passes = log.passes.slice(before), aspect = passes.filter(p => /GL (depth|stencil) blit/.test(p.descriptor.label));
            assert.equal(aspect.length, name === "missing" ? 0 : name === "depth" || name === "stencil" ? 1 : 2, name);
            if (name === "scissor") {
                assert.ok(aspect.every(p => p.scissor.join() === "4,4,8,8"));
                assert.deepEqual(passes.find(p => p.descriptor.label === "GL scaled colour blit").scissor, [4, 4, 8, 8]);
            }
        }
        assert.ok(gpu.depthStencilBlitPipelines.size > 0);
        const masks = [...gpu.depthStencilBlitPipelines.values()].map(p => p.descriptor.depthStencil.stencilWriteMask).filter(v => v !== undefined);
        assert.deepEqual(masks.sort((a, b) => a - b), [1, 2, 4, 8, 16, 32, 64, 128, 255]);
        send(new GLStream().makeCurrent(2, 0, 0, 16, 16, 2, 1, 4 << 8));
        const source = gpu.readDepthStencil("depth");assert.equal(source.sampleCount, 4);
        const scalar = gpu.depthToFloat(gpu.ensureEncoder(), source, { x: 0, y: 0, width: 16, height: 16 });gpu.retire(scalar);
        assert.ok([...gpu.scalarReadPipelines.values()].some(p => p.descriptor.fragment.module.code.includes("texture_depth_multisampled_2d")));
        gpu.stencilToColor(gpu.ensureEncoder(), gpu.readDepthStencil("stencil"));
        const stencilPipelines = [...gpu.stencilReadPipelines.values()].filter(p => p.descriptor.multisample.count === 4);
        assert.equal(stencilPipelines.length, 8);
        assert.deepEqual(stencilPipelines.map(p => p.descriptor.depthStencil.stencilReadMask), [1, 2, 4, 8, 16, 32, 64, 128]);
        await gpu.idle();assert.equal(gpu.stats.refusals, 0);assert.equal(gpu.gpuErrors.errors.length, 0);
    }
    console.log("gl_blit_aspects_test: eight dual-native patterns, aspect-only passes, scissor, bit masks and MSAA scalar pipelines in both modes passed");
})().catch(error => {console.error(error);process.exitCode = 1;});
