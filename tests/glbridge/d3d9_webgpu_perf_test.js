#!/usr/bin/env node
// M6 steady-state budget guard for the D3D9 WebGPU executor. This is a
// counting WebGPU device rather than a timing benchmark: it pins the resource
// creation/submission invariants that make frame time predictable on real GPU
// drivers.

"use strict";

const assert = require("node:assert/strict");
const { errorScopes } = require("./fake_error_scopes.js");
const { D3D9WebGPUExecutor } = require("../../src/browser/glbridge/d3d9-webgpu/d3d9_executor.js");
const P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");

const DEVICE = 0x100002;
const OP = P.OP;

function u32(...values) {
    const out = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => out.writeUInt32LE(value >>> 0, index * 4));
    return out;
}

function command(opcode, payload) { return { opcode, payload }; }

function batch(commands, present) { return Buffer.from(P.encodeBatch(commands, { version_minor: 3, flags: present ? P.C.D9WG_BATCH_FLAG_PRESENT : 0 })); }

function createDevice() { return Buffer.from(P.encode("CreateDevice", { device_handle: DEVICE, hwnd: 0x1234, width: 800, height: 600, backbuffer_format: 22, windowed: 1 })); }

function createBuffer(handle, bytes) {
    return Buffer.from(P.encode("CreateBuffer", {
        device_handle: DEVICE, resource_handle: handle, resource_kind: 1, byte_count: bytes }));
}

function fvf() { return Buffer.concat([Buffer.from(P.encode("SetFVF", { device_handle: DEVICE, fvf: 2, element_count: 1 })), Buffer.from(P.encode("VertexElement", { type: 2 }))]); }

function frameCommands(includeSetup, drawCount = 150) {
    const commands = [];
    if (includeSetup) {
        commands.push(command(OP.CREATE_DEVICE, createDevice()));
        commands.push(command(OP.CREATE_BUFFER, createBuffer(0x201, 4096)));
        commands.push(command(OP.SET_FVF, fvf()));
        commands.push(command(OP.SET_STREAM_SOURCE,
            P.encode("SetStreamSource", { device_handle: DEVICE, stream: 0, buffer_handle: 0x201, stride: 12, offset_in_bytes: 0 }).subarray(0, 20)));
    }
    // 150 draws with 300 state writes. CULLMODE alternates between two real
    // pipeline states; TEXTUREFACTOR changes twice per draw but is not read by
    // this untextured cascade, so it must not force a GPU resource allocation.
    for (let draw = 0; draw < drawCount; ++draw) {
        commands.push(command(OP.SET_RENDER_STATE,
            P.encode("SetRenderState", { device_handle: DEVICE, state: 22, value: draw & 1 ? 1 : 3, reserved: 0 })));
        commands.push(command(OP.SET_RENDER_STATE,
            P.encode("SetRenderState", { device_handle: DEVICE, state: 60, value: 0xff000000 | draw, reserved: 0 })));
        commands.push(command(OP.DRAW_PRIMITIVE,
            P.encode("DrawPrimitive", { device_handle: DEVICE, primitive_type: 4, start_vertex: 0, primitive_count: 1 })));
    }
    commands.push(command(OP.PRESENT,
        P.encode("Present", { device_handle: DEVICE, hwnd: 0x1234, width: 800, height: 600 })));
    return commands;
}

function countingWebGPU() {
    const counts = new Map();
    const hit = name => counts.set(name, (counts.get(name) || 0) + 1);
    class BufferObject {
        constructor(descriptor) { this.size = descriptor.size; }
        destroy() { hit("destroyBuffer"); }
    }
    class TextureObject {
        constructor(descriptor) { this.descriptor = descriptor; }
        createView() { return { texture: this }; }
        destroy() { hit("destroyTexture"); }
    }
    class Pass {
        setPipeline() {}
        setBindGroup() {}
        setBlendConstant() {}
        setStencilReference() {}
        setViewport() {}
        setScissorRect() {}
        setVertexBuffer() {}
        setIndexBuffer() {}
        draw() { hit("draw"); }
        drawIndexed() { hit("drawIndexed"); }
        end() {}
    }
    const queue = {
        writeBuffer() { hit("writeBuffer"); },
        writeTexture() { hit("writeTexture"); },
        submit() { hit("submit"); },
        onSubmittedWorkDone() { return Promise.resolve(); },
    };
    const device = {
        queue, lost: new Promise(() => {}),
        ...errorScopes(),
        createBuffer(descriptor) { hit("createBuffer"); return new BufferObject(descriptor); },
        createTexture(descriptor) { hit("createTexture"); return new TextureObject(descriptor); },
        createShaderModule(descriptor) {
            hit("createShaderModule");
            return { code: descriptor.code,
                getCompilationInfo: async () => ({ messages: [] }) };
        },
        createSampler() { hit("createSampler"); return {}; },
        createBindGroupLayout(descriptor) {
            hit("createBindGroupLayout");
            return { bindings: new Set(descriptor.entries.map(entry => entry.binding)) };
        },
        createPipelineLayout(descriptor) {
            hit("createPipelineLayout"); return { bindGroupLayouts: descriptor.bindGroupLayouts };
        },
        createRenderPipeline(descriptor) {
            hit("createRenderPipeline"); return { descriptor };
        },
        createBindGroup(descriptor) { hit("createBindGroup"); return descriptor; },
        createCommandEncoder() {
            hit("createCommandEncoder");
            return { beginRenderPass() { hit("beginRenderPass"); return new Pass(); },
                copyTextureToTexture() { hit("copyTextureToTexture"); },
                finish() { return {}; } };
        },
    };
    const context = {
        configure() {},
        getCurrentTexture() {
            return { width: 800, height: 600, createView: () => ({ swapchain: true }) };
        },
    };
    return { device, context, counts,
        snapshot: () => Object.fromEntries(counts) };
}

function delta(after, before, key) {
    return (after[key] || 0) - (before[key] || 0);
}

async function main() {
    const fake = countingWebGPU();
    const executor = new D3D9WebGPUExecutor({ getContext: () => fake.context }, {
        device: fake.device, context: fake.context, format: "bgra8unorm",
        uniformRingBytes: 4 * 1024 * 1024,
    });

    // Two warm-up frames populate both alternating pipeline/bind-group keys.
    await executor.submit(batch(frameCommands(true), true));
    await executor.submit(batch(frameCommands(false), true));
    await executor.idle();
    const before = fake.snapshot();
    const statsBefore = executor.getStats();

    await executor.submit(batch(frameCommands(false), true));
    await executor.idle();
    const after = fake.snapshot();
    const stats = executor.getStats();

    assert.equal(delta(after, before, "createRenderPipeline"), 0,
        "steady frame created a pipeline");
    assert.equal(delta(after, before, "createBindGroup"), 0,
        "steady frame created a bind group");
    assert.equal(delta(after, before, "createBuffer"), 0,
        "steady frame created a GPU buffer");
    assert.equal(delta(after, before, "createTexture"), 0,
        "steady frame created a texture");
    assert.equal(delta(after, before, "submit"), 1,
        "one D3D frame should be one WebGPU queue submit");
    assert.equal(delta(after, before, "beginRenderPass"), 1,
        "compatible draws should merge into one render pass");
    assert.equal(delta(after, before, "copyTextureToBuffer"), 0,
        "normal rendering must not read the GPU back");
    assert.equal(delta(after, before, "mapAsync"), 0,
        "normal rendering must not map GPU results");
    assert.equal(stats.lastFrame.pipelineCreations, 0);
    assert.equal(stats.lastFrame.bindGroupCreations, 0);
    assert.ok(stats.bindGroupHits - statsBefore.bindGroupHits >= 150,
        "every steady draw should hit the bind-group cache");
    /*
     * This frame writes two render states before every draw, so the constant
     * slot is invalidated 150 times by design -- the dirty serial is answering
     * "did any command run", not "did the resulting bytes differ", which is how
     * a driver answers it and is O(1) instead of a hash over the block.
     *
     * What has to hold is the property that actually costs anything: however
     * many slots the frame burns, they reach the GPU in one upload. The old
     * assertion here counted slot reuses because each slot used to carry its
     * own writeBuffer; now they do not.
     */
    assert.equal(delta(after, before, "writeBuffer"), 1,
        "a frame's constants must reach the GPU in one staged upload");
    assert.equal(stats.uniformStagingUploads -
        statsBefore.uniformStagingUploads, 1);
    assert.equal(stats.uniformRingOverflows, 0);
    assert.ok(stats.lastFrame.queueSubmits <= 5, "M6 submit budget exceeded");

    console.log("PASS d3d9 M6 steady-state: 150 draws, 0 pipeline/bind-group/buffer " +
        "creations, 1 pass, 1 submit");
}

if (require.main === module) main().catch(error => {
    console.error(error);
    process.exit(1);
});

module.exports = { countingWebGPU, frameCommands, batch };
