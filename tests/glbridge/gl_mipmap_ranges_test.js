"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), zlib = require("node:zlib");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
for (const part of ["objects", "state", "raster", "fixed", "misc", "stencil_ext", "render", "arrays", "images", "textures", "buffers", "queries"])
    require("../../src/browser/glbridge/gl-webgpu/gl_shadow_" + part + ".js");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"), { GLStream } = require("./gl_stream_builder.js"),
    { createFakeHost } = require("./gl_fake_gpu.js"), { scene, phases, expected } = require("./gl_mipmap_ranges_cases.js");
(async () => {
    const apple = require("./gl_conformance/mipmap_ranges_reference.json").cases,
        mesa = JSON.parse(zlib.gunzipSync(fs.readFileSync(__dirname + "/gl_conformance/mesa_reference.json.gz"))).fixtures.mipmap_ranges.cases;
    assert.equal(mesa.length, 26);
    assert.ok(mesa.every(e => e.error === 0));assert.ok(apple.every(e => e.error === 0));
    assert.deepEqual(mesa.filter(e => e.phase === "before_manual"), apple.filter(e => e.phase === "before_manual"));
    // Apple also confirms automatic depth generation beyond MAX_LEVEL.
    assert.deepEqual(expected(mesa.find(e => e.phase === "depth_auto" && e.level === 3)), apple.find(e => e.phase === "depth_auto" && e.level === 3).values);
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
        for (const phase of phases) {
            const before = log.passes.length;send(scene(new GLStream(), phase));
            const object = gpu.current.shareGroup.textures.get(phase.startsWith("depth") ? 2 : 1), levels = object.levels[0], passes = log.passes.slice(before);
            if (phase === "cpu_manual") {
                assert.deepEqual(Array.from(levels[0].pixels.subarray(0, 4)), [255, 0, 0, 255]);
                assert.deepEqual(Array.from(levels[3].pixels.subarray(0, 4)), [0, 255, 0, 255]);
                assert.deepEqual(Array.from(levels[4].pixels.subarray(0, 4)), [255, 255, 0, 255]);
            }
            if (phase === "gpu_manual") assert.deepEqual(passes.filter(p => p.descriptor.label.startsWith("GL mipmap level")).map(p => p.descriptor.colorAttachments[0].view.options.baseMipLevel), [3]);
            if (phase === "gpu_auto_sub") assert.deepEqual(passes.filter(p => p.descriptor.label.startsWith("GL mipmap level")).map(p => p.descriptor.colorAttachments[0].view.options.baseMipLevel), [3, 4]);
            if (phase === "gpu_no_auto_render") assert.ok(!passes.some(p => p.descriptor.label.startsWith("GL mipmap")), "rendering is not an automatic mip trigger");
            if (phase === "depth_manual") {
                assert.deepEqual(passes.filter(p => p.descriptor.label === "GL depth mip level").map(p => p.descriptor.depthStencilAttachment.view.options.baseMipLevel), [2]);
                assert.equal(new Float32Array(levels[3].pixels.buffer)[0], 0.875);
            }
            if (phase === "depth_auto") assert.deepEqual(passes.filter(p => p.descriptor.label === "GL depth mip level").map(p => p.descriptor.depthStencilAttachment.view.options.baseMipLevel), [2, 3]);
            gpu.flushFrame();await gpu.idle();
        }
        assert.equal(gpu.stats.refusals, 0);assert.equal(gpu.gpuErrors.errors.length, 0);
    }
    console.log("gl_mipmap_ranges_test: 26 native probes, bounded manual/full automatic pyramids, retained images, FBO no-auto and GPU depth pipelines in both modes passed");
})().catch(error => {console.error(error);process.exitCode = 1;});
