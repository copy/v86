"use strict";
const assert = require("node:assert/strict"), path = require("node:path");
const F = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_formats.js"), P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
const {makeExecutor, buildBatch, command, createDevicePayload, DEVICE} = require("./d3d9_webgpu_executor_test.js");
(async () => {
    const {executor} = makeExecutor();
    await executor.submit(buildBatch([command(P.OP.CREATE_DEVICE, createDevicePayload(64, 64)),
        ...[false, true].map(cube => command(cube ? P.OP.CREATE_TEXTURE_CUBE : P.OP.CREATE_TEXTURE_2D,
            P.encode(cube ? "CreateTextureCube" : "CreateTexture2D", {device_handle: DEVICE, resource_handle: cube ? 102 : 101,
                ...(cube ? {edge_length: 4} : {width: 4, height: 4}), level_count: 3, format: 0x31545844})))])); await executor.idle();
    if (process.env.D9WG_BC_SRGB_SOURCE) {
        const methods = require(path.resolve(process.env.D9WG_BC_SRGB_SOURCE)).createMethods(F);
        for (const name of ["sampledViewFor", "markTextureSubresourceWritten", "retireResourceState"]) executor[name] = methods[name];
    }
    for (const [handle, layers, dimension] of [[101, 1, "2d"], [102, 6, "cube"]]) {
        const resource = executor.resources.get(handle), frame = executor.ensureFrame(), start = frame.ops.length;
        assert.equal(executor.sampledViewFor(resource, false), resource.view); assert(!resource.srgbCopyTexture);
        const srgb = executor.sampledViewFor(resource, true), mirror = resource.srgbCopyTexture;
        assert(mirror && mirror !== resource.gpuTexture, "BC sRGB requires native sRGB storage, not a reinterpretation view");
        assert.equal(mirror.descriptor.format, "bc1-rgba-unorm-srgb"); assert.deepEqual(mirror.descriptor.viewFormats, []);
        assert.equal(mirror.descriptor.mipLevelCount, 3); assert.equal(mirror.descriptor.size.depthOrArrayLayers, layers);
        assert.equal(srgb.texture, mirror); assert.equal(srgb.descriptor.dimension, dimension);
        let ops = frame.ops.slice(start); assert.equal(ops.length, 3);
        for (let level = 0; level < 3; ++level) {
            const op = ops[level]; assert.equal(op.kind, "copy"); assert.equal(op.source.texture, resource.gpuTexture);
            assert.equal(op.destination.texture, mirror); assert.equal(op.source.mipLevel, level); assert.equal(op.destination.mipLevel, level);
            assert.deepEqual(op.size, {width: 4, height: 4, depthOrArrayLayers: layers}, "2x2/1x1 BC mip tails still occupy a full physical block");
        }
        assert.equal(executor.sampledViewFor(resource, true), srgb); assert.equal(frame.ops.length, start + 3, "unchanged sRGB sampling reuses the copy");
        assert.equal(executor.sampledViewFor(resource, false), resource.view, "linear sampling keeps the original representation");
        executor.markTextureSubresourceWritten(resource, 2, layers - 1); frame.record({kind: "test-upload"});
        assert.equal(executor.sampledViewFor(resource, true), srgb); ops = frame.ops.slice(start + 3);
        assert.equal(ops[0].kind, "test-upload"); assert.equal(ops.length, 4); assert(ops.slice(1).every(op => op.kind === "copy"));
        assert.equal(resource.frameReferenced, frame.serial);
        executor.retireResourceState(resource); assert(resource.destroyed); assert(!mirror.destroyed, "in-flight mirror must survive resource release");
        assert(frame.transientBuffers.includes(mirror)); assert(frame.transientBuffers.includes(resource.gpuTexture));
    }
    executor.discardFrame(); assert(executor.resources.get(101).srgbCopyTexture.destroyed); assert(executor.resources.get(102).srgbCopyTexture.destroyed);
    assert.equal(executor.stats.srgbCopyTexturesCreated, 2); assert.equal(executor.stats.srgbTextureCopies, 12);
    console.log("PASS BC sRGB: native sRGB storage, cached ordered copies, write invalidation, all mip tails/cube layers, simultaneous linear view and deferred retirement");
})().catch(error => {console.error(error); process.exitCode = 1;});
