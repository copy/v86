"use strict";
const assert = require("node:assert/strict"), P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
const { makeExecutor } = require("./d3d9_webgpu_executor_test.js");
const C = require("../../src/browser/glbridge/d3d9-webgpu/d3d9_executor.js").D3D9WebGPUExecutor;
require("../../src/browser/glbridge/d3d9-webgpu/ddraw_ops.js").installDDrawOps(C);
(async () => {
    const { executor, find } = makeExecutor();
    const commands = [];
    for (let i = 0; i < 64; i++) commands.push(
        { opcode: P.OP.COLOR_FILL, payload: { device_handle: 1, texture_handle: 2, color: 0xff112233, left: 1, top: 1, right: 7, bottom: 7 } },
        { opcode: P.OP.DD_BLT, payload: { device_handle: 1, destination_handle: 2, destination_rect: [1, 1, 7, 7], flags: P.C.D9WG_DDBLT_COLOR_FILL, fill_color: 0xff445566 } });
    commands.push({ opcode: P.OP.PRESENT, payload: { device_handle: 1, width: 8, height: 8 } });
    const frame = setup => P.encodeBatch([...(setup ? [
        { opcode: P.OP.CREATE_DEVICE, payload: { device_handle: 1, width: 8, height: 8 } },
        { opcode: P.OP.CREATE_TEXTURE_2D, payload: { device_handle: 1, resource_handle: 2, width: 8, height: 8, level_count: 1, format: 21, usage: 1 } },
    ] : []), ...commands], { flags: P.C.D9WG_BATCH_FLAG_PRESENT });
    await executor.submit(frame(true));await executor.idle();
    const buffers = find("createBuffer").length;
    assert.equal(buffers, 1, "128 utility passes should share one uniform allocation");
    const bindings = find("createBindGroup").map(call => call[1].entries[0].resource).filter(resource => resource.buffer);
    assert.equal(bindings.length, 128);assert.equal(new Set(bindings.map(binding => binding.buffer)).size, 1);
    assert.equal(new Set(bindings.map(binding => binding.offset)).size, 128, "each pass needs its own immutable constant range");
    await executor.submit(frame(false));await executor.idle();
    assert.equal(find("createBuffer").length, buffers, "steady utility passes must reuse their GPU buffer");
    assert.equal(executor.hostErrors.length, 0);assert.equal(executor.gpuErrors.errors.length, 0);
    const overflow = makeExecutor();
    overflow.executor.uniformRingCapacity = 256;overflow.executor.uniformRingMaxChunks = 1;
    await overflow.executor.submit(frame(true));await overflow.executor.idle();
    assert.equal(overflow.executor.frame, null, "overflow must not create a phantom next frame or rewind the active ring");
    const ring = overflow.executor.uniformRingChunks[0], transient = overflow.find("createBuffer").map(call => call[2]).filter(buffer => buffer !== ring);
    assert.equal(transient.length, 127, "each overflow pass gets a distinct temporary uniform buffer");
    overflow.fake.completeSubmittedWork();await Promise.resolve();
    assert(transient.every(buffer => buffer.destroyed), "overflow storage retires only after the GPU fence");
    assert.equal(ring.destroyed, undefined, "the reusable ring remains alive");
    assert.equal(overflow.executor.hostErrors.length, 0);assert.equal(overflow.executor.gpuErrors.errors.length, 0);
    console.log("D9WG surfaces: 128 mixed fill/blit passes use distinct uniform ranges and allocate no steady-state buffers");
})().catch(error => { console.error(error);process.exitCode = 1; });
