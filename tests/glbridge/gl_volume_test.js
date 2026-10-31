"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), zlib = require("node:zlib");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
for (const part of ["objects", "state", "raster", "fixed", "misc", "stencil_ext", "render", "arrays", "images", "buffers", "queries"])
    require("../../src/browser/glbridge/gl-webgpu/gl_shadow_" + part + ".js");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"), { GLStream } = require("./gl_stream_builder.js"),
    { createFakeHost } = require("./gl_fake_gpu.js"), { setup, scene } = require("./gl_volume_cases.js");
const apple = require("./gl_conformance/volume_attachment_reference.json").cases;
(async () => {
    const mesa = JSON.parse(zlib.gunzipSync(fs.readFileSync(__dirname + "/gl_conformance/mesa_reference.json.gz"))).fixtures.volume_attachment.cases;
    for (let i = 0; i < apple.length; ++i) {
        assert.equal(mesa[i].name, apple[i].name);assert.equal(mesa[i].error, apple[i].error);
        assert.ok(mesa[i].rgba.every((v, j) => Math.abs(v - apple[i].rgba[j]) <= (apple[i].name.startsWith("mip") ? 1 : 0)));
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
        send(setup(new GLStream().makeCurrent(1, 0, 0, 4, 4, 1, 1)));
        for (const { name } of apple) send(scene(new GLStream(), name));
        const volumePasses = log.passes.filter(p => p.descriptor.colorAttachments.some(a => a?.view.texture.descriptor.dimension === "3d"));
        assert.ok(volumePasses.length >= 7);
        for (const pass of volumePasses) for (const a of pass.descriptor.colorAttachments) if (a?.view.texture.descriptor.dimension === "3d") {
            assert.equal(a.view.options.dimension, "3d");assert.ok(Number.isInteger(a.depthSlice));
        }
        const copies = log.passes.filter(p => p.descriptor.label === "GL colour copy pass");
        assert.ok(copies.some(p => p.descriptor.colorAttachments[0].depthSlice === 2), "CopyTexSubImage3D writes the specified z offset");
        const mips = log.passes.filter(p => p.descriptor.label === "GL 3D mipmap slice");
        assert.deepEqual(mips.map(p => p.descriptor.colorAttachments[0].depthSlice), [0, 1, 0]);
        assert.ok(mips.every(p => p.pipeline.descriptor.fragment.module.code.includes("texture_3d<f32>")));
        await gpu.idle();assert.equal(gpu.stats.refusals, 0);assert.equal(gpu.gpuErrors.errors.length, 0);
    }
    console.log("gl_volume_test: dual-native slices/copies/blit/mips, valid 3D depthSlice views, masked clears and 3D mip passes in both modes passed");
})().catch(error => {console.error(error);process.exitCode = 1;});
