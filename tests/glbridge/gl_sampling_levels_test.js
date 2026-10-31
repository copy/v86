"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), zlib = require("node:zlib");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
for (const part of ["objects", "state", "raster", "fixed", "misc", "stencil_ext", "render", "arrays", "images", "buffers", "queries"])
    require("../../src/browser/glbridge/gl-webgpu/gl_shadow_" + part + ".js");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"), { GLStream, GL } = require("./gl_stream_builder.js"),
    { createFakeHost } = require("./gl_fake_gpu.js"), { scene } = require("./gl_sampling_levels_cases.js"),
    { samplerDefaults } = require("../../src/browser/glbridge/gl-webgpu/gl_texture_parameters.js");
(async () => {
    const apple = require("./gl_conformance/sampling_levels_reference.json").cases,
        mesa = JSON.parse(zlib.gunzipSync(fs.readFileSync(__dirname + "/gl_conformance/mesa_reference.json.gz"))).fixtures.sampling_levels.cases;
    for (let i = 0; i < apple.length; ++i) {
        if (apple[i].name === "base_above_max") {
            // GL 2.1 3.8.9 always magnifies the base array. Completeness
            // disables texturing only with a mip filter (3.8.10). Mesa
            // instead samples the red zero array for this inverted range.
            assert.deepEqual(mesa[i], { name: "base_above_max", error: 0, rgba: [255, 0, 0, 255] });
        } else assert.deepEqual(apple[i], mesa[i]);
    }
    for (const copied of [false, true]) {
        const { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true });await gpu.initialize();
        const cpu = new GLShadow();cpu.setCapabilities(gpu.capabilities());
        for (const entry of apple) {
            const memory = scene(new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1), entry.name).bytes(), segments = cpu.process(memory);
            for (const segment of segments || [{ offset: 0, length: memory.length }]) {
                const bytes = segment.bytes || memory.subarray(segment.offset, segment.offset + segment.length);gpu.submit(copied ? bytes.slice() : bytes, {});
            }
            assert.equal(cpu.current.error, 0);await gpu.idle();
            const object = gpu.boundTexture(GL.TEXTURE_2D);
            assert.equal(gpu.textureIsComplete(object), !["incomplete", "zero_base"].includes(entry.name), entry.name);
            if (entry.name === "base_without_zero") assert.ok(object.gpuTexture);
            if (entry.name === "fbo_nonmipmap") { gpu.currentTargets();assert.equal(object.gpuLevels, 2, "authored attachment mip exists independently of minFilter"); }
            if (entry.name === "npot_base") assert.equal(object.gpuWidth, 9, "changing base preserves a compatible NPOT root");
        }
        const image = (width, depth) => ({ width, height: width, depth, base: "RGBA", gpuFormat: "rgba8unorm" });
        const volume = { kind: "3D", sampler: { ...samplerDefaults(), maxLevel: 1 }, levels: [[image(4, 4), image(2, 4)]] };
        assert.equal(gpu.textureIsComplete(volume), false, "3D mip depth must halve");volume.levels[0][1].depth = 2;assert.equal(gpu.textureIsComplete(volume), true);
        assert.equal(gpu.stats.refusals, 0);assert.equal(gpu.gpuErrors.errors.length, 0);
    }
    console.log("gl_sampling_levels_test: eight Apple/Mesa ranges with named inverted-range difference, missing/zero base, independent FBO mip allocation, NPOT roots and 3D completeness in both modes passed");
})().catch(error => {console.error(error);process.exitCode = 1;});
