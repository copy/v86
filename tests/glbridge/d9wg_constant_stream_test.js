"use strict";
const assert = require("node:assert/strict");
const P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
const { makeExecutor, buildBatch, command, createDevicePayload, createBufferPayload,
    fvfPayload, element, setStreamSourcePayload, drawPrimitivePayload, DEVICE } = require("./d3d9_webgpu_executor_test.js");
const enc = (op, name, values) => command(op, P.encode(name, values));
(async () => {
    for (const mode of ["triangles", "points", "indexed-points", "instanced"]) {
        const { executor, find } = makeExecutor({ diagnostics: false });
        const indexed = mode === "indexed-points" || mode === "instanced";
        const setup = [command(P.OP.CREATE_DEVICE, createDevicePayload(64, 64)),
            command(P.OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 64)),
            command(P.OP.CREATE_BUFFER, createBufferPayload(0x202, 1, 64)),
            command(P.OP.CREATE_BUFFER, createBufferPayload(0x203, 2, 6, 101)),
            command(P.OP.SET_FVF, fvfPayload(0x42, [element(3, 0, 2, 0), element(15, 4, 4, 10)])),
            command(P.OP.SET_STREAM_SOURCE, setStreamSourcePayload(3, 0x201, 12, 4)),
            command(P.OP.SET_STREAM_SOURCE, setStreamSourcePayload(15, 0x202, 0, 4))];
        if (mode === "instanced") setup.push(
            enc(P.OP.SET_STREAM_SOURCE_FREQ, "SetStreamSourceFreq", { device_handle: DEVICE, stream: 0, divider: 0x40000004 }),
            enc(P.OP.SET_STREAM_SOURCE_FREQ, "SetStreamSourceFreq", { device_handle: DEVICE, stream: 15, divider: 0x80000003 }));
        if (indexed) setup.push(enc(P.OP.SET_INDICES, "SetIndices", { device_handle: DEVICE, buffer_handle: 0x203 }),
            enc(P.OP.DRAW_INDEXED_PRIMITIVE, "DrawIndexedPrimitive", { device_handle: DEVICE, primitive_type: mode === "indexed-points" ? 1 : 4, primitive_count: 1 }));
        else setup.push(command(P.OP.DRAW_PRIMITIVE, drawPrimitivePayload(mode === "points" ? 1 : 4, 1, 1)));
        await executor.submit(buildBatch(setup), { writeGuestMemory() {} });
        const draw = executor.frame.ops.filter(op => op.kind === "draw").at(-1);
        assert(draw, mode + " records a draw");
        const pipeline = find("createRenderPipeline").at(-1)[1];
        const slot = pipeline.vertex.buffers.findIndex(b => b.attributes.some(a => a.shaderLocation === 1));
        assert(slot >= 0, mode + " retains the constant colour input");
        assert.equal(pipeline.vertex.buffers[slot].arrayStride, 0);
        assert.equal(pipeline.vertex.buffers[slot].attributes.find(a => a.shaderLocation === 1).offset, 4);
        assert.equal(draw.vertexBuffers[slot].offset, 4, "source offset survives start/index/divisor changes");
        assert.equal(draw.vertexBuffers[slot].buffer, executor.resources.get(0x202).gpuBuffer);
        assert.equal(executor.stats.expandedInstanceStreams, 0, "constant instance streams need no expansion");
        if (mode === "instanced") assert.equal(draw.instanceCount, 4);
        if (mode === "indexed-points") assert.equal(executor.stats.indexedPointExpansions, 1);
        assert.equal(executor.stats.droppedDraws, 0);assert.equal(executor.hostErrors.length, 0);
        if (mode === "triangles") {
            const original = draw.pipeline;
            await executor.submit(buildBatch([
                command(P.OP.SET_STREAM_SOURCE, setStreamSourcePayload(15, 0x202, 8, 4)),
                command(P.OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 1, 1)),
            ]), { writeGuestMemory() {} });
            const changed = executor.frame.ops.filter(op => op.kind === "draw").at(-1);
            assert.notEqual(changed.pipeline, original, "positive and zero stride cannot share a pipeline layout");
            assert.equal(find("createRenderPipeline").at(-1)[1].vertex.buffers[slot].arrayStride, 8);
            await executor.submit(buildBatch([
                command(P.OP.SET_STREAM_SOURCE, setStreamSourcePayload(15, 0x202, 0, 4)),
                command(P.OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 1, 1)),
            ]), { writeGuestMemory() {} });
            assert.equal(executor.frame.ops.filter(op => op.kind === "draw").at(-1).pipeline, original,
                "returning to constant data reuses only the matching layout");
        }
        executor.finishFrame(false);await executor.idle();assert.equal(executor.gpuErrors.errors.length, 0);
    }
    console.log("PASS constant vertex streams: declarations, source/attribute offsets, absent stream 0, points, indexed compaction and instance divisors retain the original constant binding");
})().catch(error => { console.error(error);process.exitCode = 1; });
