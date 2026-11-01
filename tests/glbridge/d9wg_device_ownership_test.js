"use strict";
const assert = require("node:assert/strict");
const P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
const { makeExecutor } = require("./d3d9_webgpu_executor_test.js");
const create = (device, width, height) => ({ opcode: P.OP.CREATE_DEVICE, payload: {
    device_handle: device, width, height, enable_auto_depth_stencil: 1 } });
const clear = (device, color) => ({ opcode: P.OP.CLEAR, payload: { device_handle: device, clear_flags: 3, color, depth: 1 } });
(async () => {
    const { executor, fake, find } = makeExecutor();
    await executor.submit(P.encodeBatch([create(11, 64, 64), clear(11, 0xffff0000), create(22, 128, 32), clear(22, 0xff00ff00)]));
    assert.equal(executor.frame.ops.length, 2, "creating B cannot discard A's pending clear");
    const a = executor.devices.get(11), b = executor.devices.get(22), oldA = a.backBufferTexture, oldB = b.backBufferTexture;
    assert.notEqual(oldA, oldB);
    executor.finishFrame(false);await executor.idle();
    const passes = find("beginRenderPass").filter(call => call[1].colorAttachments[0]);
    assert.equal(passes.length, 2, "distinct back buffers need distinct render passes");
    assert.equal(passes[0][1].colorAttachments[0].view.texture, oldA);
    assert.equal(passes[1][1].colorAttachments[0].view.texture, oldB);
    assert.deepEqual(oldA.descriptor.size, { width: 64, height: 64, depthOrArrayLayers: 1 });
    assert.deepEqual(oldB.descriptor.size, { width: 128, height: 32, depthOrArrayLayers: 1 });
    await executor.submit(P.encodeBatch([clear(22, 0xff0000ff), { opcode: P.OP.RESET, payload: {
        old_device_handle: 11, new_device_handle: 33, width: 32, height: 16, enable_auto_depth_stencil: 1 } }]));
    assert.equal(executor.devices.get(22).backBufferTexture, oldB, "reset A must retain B's buffer");
    assert.equal(oldA.destroyed, undefined, "old A is alive until its GPU work completes");
    fake.completeSubmittedWork();await Promise.resolve();
    assert.equal(oldA.destroyed, true);assert.equal(oldB.destroyed, undefined);
    await executor.submit(P.encodeBatch([clear(33, 0xffffffff)]));
    assert.deepEqual(executor.devices.get(33).backBufferTexture.descriptor.size, { width: 32, height: 16, depthOrArrayLayers: 1 });
    assert.equal(executor.hostErrors.length, 0);assert.equal(executor.gpuErrors.errors.length, 0);
    console.log("D9WG devices: mixed-size pending frames, captured views and reset/retirement isolation checked");
})().catch(error => { console.error(error);process.exitCode = 1; });
