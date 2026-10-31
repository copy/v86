"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), zlib = require("node:zlib");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
for (const part of ["objects", "state", "raster", "fixed", "misc", "stencil_ext", "render", "arrays", "images", "textures", "buffers", "queries"])
    require("../../src/browser/glbridge/gl-webgpu/gl_shadow_" + part + ".js");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"), { GLStream, GL } = require("./gl_stream_builder.js"),
    { createFakeHost } = require("./gl_fake_gpu.js"), { setup, scene } = require("./gl_texture_images_cases.js");
(async () => {
    const apple = require("./gl_conformance/texture_images_reference.json").cases,
        mesa = JSON.parse(zlib.gunzipSync(fs.readFileSync(__dirname + "/gl_conformance/mesa_reference.json.gz"))).fixtures.texture_images?.cases;
    // NULL data has undefined contents in GL. The renderer deliberately uses
    // zeroed allocations; only the defined native probes are cross-checked.
    assert.deepEqual(apple.filter(e => e.name !== "null_image"), mesa?.filter(e => e.name !== "null_image"));
    for (const copied of [false, true]) {
        const { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true });await gpu.initialize();
        const cpu = new GLShadow();cpu.setCapabilities(gpu.capabilities());
        const send = s => {
            const memory = s.bytes(), segments = cpu.process(memory);
            for (const segment of segments || [{ offset: 0, length: memory.length }]) {
                const bytes = segment.bytes || memory.subarray(segment.offset, segment.offset + segment.length);gpu.submit(copied ? bytes.slice() : bytes, {});
            }
            assert.equal(cpu.current.error, 0);
        };
        for (const entry of apple) {
            send(setup(new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1), entry.name));
            const texture = gpu.boundTexture(GL.TEXTURE_2D), before = texture.levels[0].map(slot => slot.storage.texture);
            assert.notEqual(before[0], before[1], "incompatible images have independent allocations");
            for (let n = 0; n < 5; ++n) {
                send(scene(new GLStream(), entry.name));gpu.flushFrame();await gpu.idle();
                for (const slot of texture.levels[0]) {
                    const location = slot.storage, descriptor = location.texture.descriptor;
                    assert.equal(descriptor.format, slot.gpuFormat);
                    assert.equal(Math.max(1, descriptor.size.width >> location.mipLevel), slot.width);
                    assert.equal(Math.max(1, descriptor.size.height >> location.mipLevel), slot.height);
                    assert.equal(location.texture.destroyed, false);
                }
                assert.ok(texture.storageTextures.size <= 2, "obsolete allocations retire after migration");
            }
        }
        const resources = [...gpu.current.shareGroup.textureImages.values()].flatMap(t => [...t.storageTextures]);
        gpu.destroyContext(new Uint8Array(0));gpu.flushFrame();await gpu.idle();
        assert.ok(resources.every(t => t.destroyed), "context teardown releases all independent images");
        assert.equal(gpu.stats.refusals, 0);assert.equal(gpu.gpuErrors.errors.length, 0);
    }
    console.log("gl_texture_images_test: native heterogeneous formats/sizes, repeated migration, inactive updates, replacement and complete image retirement in both modes passed");
})().catch(error => {console.error(error);process.exitCode = 1;});
