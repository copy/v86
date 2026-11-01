"use strict";
const assert = require("node:assert/strict"), P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
const SP = require("../../src/browser/glbridge/d3d9-webgpu/d3d9_shader_pipeline.js");
const { D3D9WebGPUExecutor } = require("../../src/browser/glbridge/d3d9-webgpu/d3d9_executor.js");
const { countingWebGPU, frameCommands, batch } = require("./d3d9_webgpu_perf_test.js");
const command = (opcode, name, payload, blobs) => ({ opcode, payload: P.encode(name, payload), blobs });
(async () => {
    for (const major of [0, 1, 2, 3]) {
        const fake = countingWebGPU(), executor = new D3D9WebGPUExecutor({ getContext: () => fake.context }, { device: fake.device, context: fake.context });
        const setup = frameCommands(true, 0);setup.pop();
        if (major) {
            const tokens = new Uint32Array([0xffff0000 | major << 8 | (major === 1 ? 1 : 0), major === 1 ? 1 : 0x02000001,
                major === 1 ? 0x800f0000 : 0x800f0800, 0xa0e40000, 0xffff]);
            const hash = SP.hashTokens(tokens);
            setup.push(command(P.OP.CREATE_PIXEL_SHADER, "CreateVertexShader", { device_handle: 0x100002, resource_handle: 0x401,
                instruction_token_count: tokens.length, bytecode_hash_low: hash.low, bytecode_hash_high: hash.high }, [{ field: "code_offset", data: new Uint8Array(tokens.buffer) }]),
            command(P.OP.SET_PIXEL_SHADER, "SetShader", { device_handle: 0x100002, shader_handle: 0x401 }));
        }
        for (const [state, value] of [[15, 1], [25, 3]]) setup.push(command(P.OP.SET_RENDER_STATE, "SetRenderState", { device_handle: 0x100002, state, value }));
        const draw = command(P.OP.DRAW_PRIMITIVE, "DrawPrimitive", { device_handle: 0x100002, primitive_type: 4, primitive_count: 1 });
        const present = command(P.OP.PRESENT, "Present", { device_handle: 0x100002, width: 800, height: 600 });
        await executor.submit(batch([...setup, draw, present], true));await executor.idle();
        const before = fake.snapshot(), commands = [];
        for (let reference = 1; reference < 256; reference++) commands.push(command(P.OP.SET_RENDER_STATE, "SetRenderState",
            { device_handle: 0x100002, state: 24, value: reference }), draw);
        await executor.submit(batch([...commands, present], true));await executor.idle();
        const after = fake.snapshot();
        assert.equal(after.createShaderModule, before.createShaderModule, "ALPHAREF must not compile new shader modules for path " + major);
        assert.equal(after.createRenderPipeline, before.createRenderPipeline, "ALPHAREF must not create new pipelines for path " + major);
        assert.equal(after.draw - before.draw, 255);
        assert.equal(executor.hostErrors.length, 0);assert.equal(executor.gpuErrors.errors.length, 0);
    }
    console.log("D9WG ALPHAREF: all 256 references reuse modules and pipelines across FFP and SM1/2/3");
})().catch(error => { console.error(error);process.exitCode = 1; });
