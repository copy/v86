"use strict";
const assert = require("node:assert/strict"), P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
const SP = require("../../src/browser/glbridge/d3d9-webgpu/d3d9_shader_pipeline.js");
const { makeExecutor, buildBatch, command, createDevicePayload, createBufferPayload,
    fvfPayload, element, setStreamSourcePayload, drawPrimitivePayload, DEVICE } = require("./d3d9_webgpu_executor_test.js");
(async () => {
    for (const major of [0, 1, 2, 3]) {
        const { executor } = makeExecutor({ diagnostics: false });
        const enc = (op, name, values) => command(op, P.encode(name, values));
        const screen = () => [command(P.OP.SET_FVF, fvfPayload(0x44, [element(0, 0, 3, 9), element(0, 16, 4, 10)])),
            command(P.OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
            command(P.OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1))];
        const setup = [command(P.OP.CREATE_DEVICE, createDevicePayload(64, 64)),
            command(P.OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 128)),
            enc(P.OP.SET_RENDER_STATE, "SetRenderState", { device_handle: DEVICE, state: 137, value: 0 }),
            enc(P.OP.SET_CLIP_PLANE, "SetClipPlane", { device_handle: DEVICE, index: 0, plane: [0, 0, 0, -1] }),
            enc(P.OP.SET_RENDER_STATE, "SetRenderState", { device_handle: DEVICE, state: 152, value: 63 })];
        if (major) {
            const tokens = new Uint32Array([0xffff0000 | major << 8 | (major === 1 ? 1 : 0), major === 1 ? 1 : 0x02000001,
                major === 1 ? 0x800f0000 : 0x800f0800, 0xa0e40000, 0xffff]);
            const hash = SP.hashTokens(tokens);
            setup.push(command(P.OP.CREATE_PIXEL_SHADER, P.encode("CreateVertexShader", { device_handle: DEVICE, resource_handle: 0x401,
                instruction_token_count: tokens.length, bytecode_hash_low: hash.low, bytecode_hash_high: hash.high }), Buffer.from(tokens.buffer), "code_offset"),
            enc(P.OP.SET_PIXEL_SHADER, "SetShader", { device_handle: DEVICE, shader_handle: 0x401 }));
        }
        await executor.submit(buildBatch([...setup, ...screen()]), { writeGuestMemory() {} });
        const state = executor.devices.get(DEVICE), first = state.lastProgram.program;
        assert.equal(state.clipPlaneCapacity, 6);
        assert.equal(first.fixedFunctionSignature.clipPlaneCount, 0, "POSITIONT skips all six user planes for pixel path " + major);
        assert(!first.vertexModule.code.includes("clip_planes"));
        assert(!(first.pixelSignature || first.pixelReflection).clipPlaneCount);
        await executor.submit(buildBatch([
            command(P.OP.SET_FVF, fvfPayload(2, [element(0, 0, 2, 0)])),
            command(P.OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
            command(P.OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        ]), { writeGuestMemory() {} });
        assert.equal(state.lastProgram.program.fixedFunctionSignature.clipPlaneCount, 6, "XYZ retains cached user planes");
        await executor.submit(buildBatch(screen()), { writeGuestMemory() {} });
        assert.equal(state.lastProgram.program.vertexModule, first.vertexModule, "returning to POSITIONT reuses the matching plane-free module");
        assert.equal(state.lastProgram.program.fragmentModule, first.fragmentModule);
        executor.finishFrame(false);await executor.idle();
        assert.equal(executor.hostErrors.length, 0);assert.equal(executor.gpuErrors.errors.length, 0);
    }
    console.log("PASS POSITIONT user planes: FFP and PS1/2/3 skip user clipping, XYZ retains planes and switching preserves cached modules");
})().catch(error => { console.error(error);process.exitCode = 1; });
