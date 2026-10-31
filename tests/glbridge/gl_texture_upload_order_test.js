"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), zlib = require("node:zlib");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
for (const part of ["objects", "state", "raster", "fixed", "misc", "stencil_ext", "render", "arrays", "images", "textures", "buffers", "queries"])
    require("../../src/browser/glbridge/gl-webgpu/gl_shadow_" + part + ".js");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"), { GLStream } = require("./gl_stream_builder.js"),
    { createFakeHost } = require("./gl_fake_gpu.js"), { scene } = require("./gl_texture_upload_order_cases.js");
(async () => {
    const apple = require("./gl_conformance/texture_upload_order_reference.json").cases,
        mesa = JSON.parse(zlib.gunzipSync(fs.readFileSync(__dirname + "/gl_conformance/mesa_reference.json.gz"))).fixtures.texture_upload_order?.cases;
    assert.deepEqual(apple, mesa);
    for (const copied of [false, true]) {
        const { host, log } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true });await gpu.initialize();
        const cpu = new GLShadow();cpu.setCapabilities(gpu.capabilities());
        for (const entry of apple) {
            const before = log.textureWrites.length, memory = scene(new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1), entry.name).bytes(), segments = cpu.process(memory);
            for (const segment of segments || [{ offset: 0, length: memory.length }]) {
                const bytes = segment.bytes || memory.subarray(segment.offset, segment.offset + segment.length);gpu.submit(copied ? bytes.slice() : bytes, {});
            }
            assert.equal(cpu.current.error, 0, entry.name);gpu.flushFrame();await gpu.idle();
            if (entry.name !== "depth16") assert.ok(log.textureWrites.slice(before).some(w => w.ordered), entry.name + " ordered upload");
        }
        // Exercise bounded staging independently of the adapter's texture
        // limit: a padded two-layer source crosses the 4 MiB chunk boundary.
        const height = 17000, rowsPerImage = height + 2, bytesPerRow = 20, offset = 8,
            data = new Uint8Array(offset + rowsPerImage * bytesPerRow * 2 + 32);
        for (let z = 0; z < 2; ++z) for (let y = 0; y < height; ++y)
            data.fill((y + z * 7) % 251 + 1, offset + (z * rowsPerImage + y) * bytesPerRow, offset + (z * rowsPerImage + y + 1) * bytesPerRow);
        const texture = gpu.createGPUTexture({ size: { width: 3, height, depthOrArrayLayers: 3 }, format: "rgba8unorm", usage: 2 });
        gpu.ensureEncoder();const start = log.textureWrites.length;
        gpu.uploadTexture({ texture, origin: { x: 0, y: 0, z: 1 } }, data.subarray(0, data.length - 16), { bytesPerRow, rowsPerImage, offset }, { width: 3, height, depthOrArrayLayers: 2 });
        const writes = log.textureWrites.slice(start);assert.equal(writes.length, 4);
        for (const write of writes) {
            assert.ok(write.ordered);assert.equal(write.layout.bytesPerRow, 256);
            const buffer = write.layout.buffer, z = write.destination.origin.z - 1, y = write.destination.origin.y, count = write.size.height,
                staged = new Uint8Array(buffer.storage);
            assert.ok(buffer.size <= 4 * 1024 * 1024);assert.equal(buffer.destroyed, false);
            for (const row of [0, count - 1]) {
                const at = offset + (z * rowsPerImage + y + row) * bytesPerRow;
                assert.deepEqual(staged.subarray(row * 256, row * 256 + bytesPerRow), data.subarray(at, at + bytesPerRow));
                assert.ok(staged.subarray(row * 256 + bytesPerRow, (row + 1) * 256).every(v => v === 0));
            }
        }
        gpu.flushFrame();await gpu.idle();assert.ok(writes.every(w => w.layout.buffer.destroyed));
        assert.equal(gpu.stats.refusals, 0);assert.equal(gpu.gpuErrors.errors.length, 0);
    }
    console.log("gl_texture_upload_order_test: seven Apple/Mesa sequences, bounded padded multi-layer staging and deferred retirement in both modes passed");
})().catch(error => {console.error(error);process.exitCode = 1;});
