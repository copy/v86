"use strict";
const assert = require("node:assert/strict"), P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
const SP = require("../../src/browser/glbridge/d3d9-webgpu/d3d9_shader_pipeline.js");
const { D3D9WebGPUExecutor } = require("../../src/browser/glbridge/d3d9-webgpu/d3d9_executor.js");
const { countingWebGPU, frameCommands, batch } = require("./d3d9_webgpu_perf_test.js");
const command = (opcode, name, payload, blobs) => ({ opcode, payload: P.encode(name, payload), blobs });
const type = value => (value & 7) << 28 | (value & 24) << 8;
const dst = (kind, index) => (0x800f0000 | type(kind) | index) >>> 0;
const src = (kind, index) => (0x80e40000 | type(kind) | index) >>> 0;
(async () => {
    for (const major of [0, 1, 2, 3]) {
        const fake = countingWebGPU(), executor = new D3D9WebGPUExecutor({ getContext: () => fake.context }, { device: fake.device, context: fake.context });
        const setup = frameCommands(true, 0);setup.pop();
        setup.push(command(P.OP.CREATE_TEXTURE_2D, "CreateTexture2D", { device_handle: 0x100002, resource_handle: 0x401, width: 4, height: 4, level_count: 1, format: 21 }),
            command(P.OP.SET_TEXTURE, "SetTexture", { device_handle: 0x100002, texture_handle: 0x401 }));
        if (major) {
            const tokens = new Uint32Array(major === 1 ? [0xffff0101, 66, dst(3, 0), 1, dst(0, 0), src(3, 0), 0xffff]
                : [0xffff0000 | major << 8, 0x0200001f, 0x80000005, dst(major === 3 ? 1 : 3, 0),
                    0x0200001f, 0x90000000, dst(10, 0), 0x03000042, dst(0, 0), src(major === 3 ? 1 : 3, 0), src(10, 0),
                    0x02000001, dst(8, 0), src(0, 0), 0xffff]);
            const hash = SP.hashTokens(tokens);
            setup.push(command(P.OP.CREATE_PIXEL_SHADER, "CreateVertexShader", { device_handle: 0x100002, resource_handle: 0x501,
                instruction_token_count: tokens.length, bytecode_hash_low: hash.low, bytecode_hash_high: hash.high }, [{ field: "code_offset", data: new Uint8Array(tokens.buffer) }]),
            command(P.OP.SET_PIXEL_SHADER, "SetShader", { device_handle: 0x100002, shader_handle: 0x501 }));
        }
        const draw = command(P.OP.DRAW_PRIMITIVE, "DrawPrimitive", { device_handle: 0x100002, primitive_type: 4, primitive_count: 1 });
        const present = command(P.OP.PRESENT, "Present", { device_handle: 0x100002, width: 800, height: 600 });
        await executor.submit(batch([...setup, draw, present], true));await executor.idle();
        const before = fake.snapshot(), commands = [], bits = new DataView(new ArrayBuffer(4));
        for (let index = 0; index < 256; index++) {
            bits.setFloat32(0, (index - 128) / 31, true);
            commands.push(command(P.OP.SET_SAMPLER_STATE, "SetSamplerState", { device_handle: 0x100002, state: 8, value: bits.getUint32(0, true) }), draw);
        }
        await executor.submit(batch([...commands, present], true));await executor.idle();
        const after = fake.snapshot();
        assert.equal(after.createShaderModule, before.createShaderModule, "LOD bias must not create shader modules for path " + major);
        assert.equal(after.createRenderPipeline, before.createRenderPipeline, "LOD bias must not create pipelines for path " + major);
        assert.equal(after.draw - before.draw, 256);
        assert.equal(executor.hostErrors.length, 0);assert.equal(executor.gpuErrors.errors.length, 0);
    }
    console.log("D9WG LOD bias: 256 float values reuse modules and pipelines across FFP and SM1/2/3");
})().catch(error => { console.error(error);process.exitCode = 1; });
