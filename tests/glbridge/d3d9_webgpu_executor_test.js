#!/usr/bin/env node
// Executor-level tests for glbridge/d3d9-webgpu/d3d9_executor.js against a
// fake WebGPU device.
//
// These drive real D9WG batches (built byte-for-byte the way d3d9_proxy.c
// emits them) through the executor and assert on the WebGPU calls that come
// out: which shader modules, which pipeline topology, which bind group
// entries, and what actually lands in the shader constant buffer. The fake
// device reproduces the two validation rules that bite hardest in practice --
// a bind group must supply exactly the bindings its layout declares, and
// writeBuffer offsets/sizes must be multiples of 4 -- so a wiring mistake
// fails here rather than as a silent black screen inside v86.

"use strict";

const assert = require("node:assert/strict");
const { D3D9WebGPUExecutor, buildFixedFunctionPixelShader } =
    require("../../src/browser/glbridge/d3d9-webgpu/d3d9_executor.js");
const shaderPipeline = require("../../src/browser/glbridge/d3d9-webgpu/d3d9_shader_pipeline.js");

const OP = {
    HELLO: 1, CREATE_DEVICE: 2, RESET: 3, PRESENT: 4, CLEAR: 5, COLOR_FILL: 9,
    BEGIN_SCENE: 6, END_SCENE: 7, GUEST_LOG: 11, READBACK_SURFACE: 12,
    CREATE_BUFFER: 0x100, UPDATE_BUFFER: 0x101, DESTROY_RESOURCE: 0x103,
    CREATE_TEXTURE_2D: 0x110, CREATE_TEXTURE_CUBE: 0x111,
    CREATE_TEXTURE_VOLUME: 0x112,
    UPDATE_TEXTURE: 0x113,
    CREATE_VERTEX_DECLARATION: 0x120,
    CREATE_VERTEX_SHADER: 0x121, CREATE_PIXEL_SHADER: 0x122,
    CREATE_QUERY: 0x123,
    SET_RENDER_STATE: 0x200, SET_SAMPLER_STATE: 0x201,
    SET_TEXTURE: 0x203, SET_VIEWPORT: 0x204, SET_TRANSFORM: 0x206,
    SET_MATERIAL: 0x207, SET_LIGHT: 0x208, LIGHT_ENABLE: 0x209,
    SET_STREAM_SOURCE: 0x20A, SET_STREAM_SOURCE_FREQ: 0x20B,
    SET_INDICES: 0x20C,
    SET_VERTEX_DECLARATION: 0x20D, SET_FVF: 0x20E,
    SET_RENDER_TARGET: 0x20F, SET_DEPTH_STENCIL_SURFACE_LEVEL: 0x21E,
    SET_VERTEX_SHADER: 0x211, SET_PIXEL_SHADER: 0x212,
    SET_VS_CONST_F: 0x213, SET_VS_CONST_I: 0x214, SET_VS_CONST_B: 0x215,
    SET_PS_CONST_F: 0x216, SET_PS_CONST_I: 0x217, SET_PS_CONST_B: 0x218,
    SET_CLIP_PLANE: 0x219, SET_PALETTE: 0x21F, SET_CURRENT_PALETTE: 0x220,
    GENERATE_MIPS: 0x221,
    DRAW_PRIMITIVE: 0x300, DRAW_INDEXED_PRIMITIVE: 0x301,
    DRAW_PRIMITIVE_UP: 0x302, DRAW_INDEXED_PRIMITIVE_UP: 0x303,
    BEGIN_QUERY: 0x400, END_QUERY: 0x401,
};

const D9WG_MAGIC = 0x47573944;
const BATCH_FLAG_PRESENT = 1;
const DECLUSAGE = { POSITION: 0, BLENDWEIGHT: 1, BLENDINDICES: 2, NORMAL: 3,
    PSIZE: 4, TEXCOORD: 5, TANGENT: 6, BINORMAL: 7, POSITIONT: 9, COLOR: 10 };
const DECLTYPE = { FLOAT1: 0, FLOAT2: 1, FLOAT3: 2, FLOAT4: 3, D3DCOLOR: 4,
    UBYTE4: 5, SHORT2: 6, SHORT4: 7, UBYTE4N: 8, UDEC3: 13, DEC3N: 14 };
const DEVICE = 0x00100002;

// ---- D9WG batch builder ----
//
// `blob` is the trailing variable-length payload some commands carry (shader
// bytecode, vertex data, constant values); the builder patches the recorded
// offset once the command's position in the batch is known, exactly as
// reserve_command_locked() does on the guest.

function command(opcode, payload, blob, blobOffsetField) {
    return { opcode, payload, blob: blob || null, blobOffsetField };
}

function buildBatch(commands, options = {}) {
    let commandBytes = 0;
    for (const item of commands) {
        const raw = 16 + item.payload.length + (item.blob ? item.blob.length : 0);
        item.size = (raw + 7) & ~7;
        item.offset = 32 + commandBytes;
        commandBytes += item.size;
    }
    const batch = Buffer.alloc(32 + commandBytes);
    batch.writeUInt32LE(D9WG_MAGIC, 0);
    batch.writeUInt16LE(1, 4);
    batch.writeUInt16LE(options.versionMinor ?? 4, 6);
    batch.writeUInt32LE(options.frameId || 1, 8);
    batch.writeUInt32LE(options.present ? BATCH_FLAG_PRESENT : 0, 12);
    batch.writeUInt32LE(commands.length, 16);
    batch.writeUInt32LE(commandBytes, 20);
    batch.writeUInt32LE(options.sessionLow || 0, 24);
    batch.writeUInt32LE(options.sessionHigh || 0, 28);
    let sequence = 1;
    for (const item of commands) {
        batch.writeUInt16LE(item.opcode, item.offset);
        batch.writeUInt32LE(item.size, item.offset + 4);
        batch.writeUInt32LE(sequence++, item.offset + 8);
        if (item.blob) {
            const blobOffset = item.offset + 16 + item.payload.length;
            item.payload.writeUInt32LE(blobOffset, item.blobOffsetField);
            item.blob.copy(batch, blobOffset);
        }
        item.payload.copy(batch, item.offset + 16);
    }
    return batch;
}

function u32(...values) {
    const buffer = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => buffer.writeUInt32LE(value >>> 0, index * 4));
    return buffer;
}

function createDevicePayload(width, height, autoDepth = 1) {
    const payload = Buffer.alloc(52);
    payload.writeUInt32LE(DEVICE, 0);
    payload.writeUInt32LE(0x1234, 4);
    payload.writeUInt32LE(width, 16);
    payload.writeUInt32LE(height, 20);
    payload.writeUInt32LE(22, 24);
    payload.writeUInt32LE(1, 28);
    payload.writeUInt32LE(autoDepth, 36);
    payload.writeUInt32LE(0, 44); // D3DMULTISAMPLE_NONE
    payload.writeUInt32LE(0, 48); // multisample quality
    return payload;
}

function element(stream, offset, type, usage, usageIndex = 0) {
    const buffer = Buffer.alloc(8);
    buffer.writeUInt16LE(stream, 0);
    buffer.writeUInt16LE(offset, 2);
    buffer.writeUInt8(type, 4);
    buffer.writeUInt8(0, 5);
    buffer.writeUInt8(usage, 6);
    buffer.writeUInt8(usageIndex, 7);
    return buffer;
}

function declarationPayload(handle, elements) {
    return Buffer.concat([u32(DEVICE, handle, elements.length, 0), ...elements]);
}

function fvfPayload(fvf, elements) {
    return Buffer.concat([u32(DEVICE, fvf, elements.length, 0), ...elements]);
}

function createBufferPayload(handle, kind, byteCount, format = 0) {
    return u32(DEVICE, handle, kind, byteCount, 0, format, 0, 0);
}

function setStreamSourcePayload(stream, handle, stride, offsetInBytes = 0) {
    return u32(DEVICE, stream, handle, stride, offsetInBytes, 0);
}

function setStreamSourceFreqPayload(stream, divider) {
    return u32(DEVICE, stream, divider);
}

function drawPrimitivePayload(type, startVertex, primitiveCount) {
    return u32(DEVICE, type, startVertex, primitiveCount);
}

function drawIndexedPayload(type, baseVertex, startIndex, primitiveCount) {
    const payload = Buffer.alloc(28);
    payload.writeUInt32LE(DEVICE, 0);
    payload.writeUInt32LE(type, 4);
    payload.writeInt32LE(baseVertex, 8);
    payload.writeUInt32LE(0, 12);
    payload.writeUInt32LE(0, 16);
    payload.writeUInt32LE(startIndex, 20);
    payload.writeUInt32LE(primitiveCount, 24);
    return payload;
}

function shaderCreatePayload(handle, tokens) {
    const payload = Buffer.alloc(24);
    payload.writeUInt32LE(DEVICE, 0);
    payload.writeUInt32LE(handle, 4);
    payload.writeUInt32LE(tokens.length, 8);
    const hash = shaderPipeline.hashTokens(tokens);
    payload.writeUInt32LE(hash.low, 16);
    payload.writeUInt32LE(hash.high, 20);
    const blob = Buffer.alloc(tokens.length * 4);
    tokens.forEach((token, index) => blob.writeUInt32LE(token >>> 0, index * 4));
    return { payload, blob, blobOffsetField: 12 };
}

function constantPayload(startRegister, vectorCount, values, writer) {
    const payload = Buffer.alloc(16);
    payload.writeUInt32LE(DEVICE, 0);
    payload.writeUInt32LE(startRegister, 4);
    payload.writeUInt32LE(vectorCount, 8);
    const stride = values.length / vectorCount;
    const blob = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => writer(blob, value, index * 4));
    void stride;
    return { payload, blob, blobOffsetField: 12 };
}

const floatConstants = (start, values) => constantPayload(start, values.length / 4,
    values, (buffer, value, at) => buffer.writeFloatLE(value, at));
const intConstants = (start, values) => constantPayload(start, values.length / 4,
    values, (buffer, value, at) => buffer.writeInt32LE(value, at));
const boolConstants = (start, values) => constantPayload(start, values.length,
    values, (buffer, value, at) => buffer.writeUInt32LE(value, at));

// ---- shader bytecode fixtures ----

const VS = (major, minor) => (0xfffe0000 | (major << 8) | minor) >>> 0;
const PS = (major, minor) => (0xffff0000 | (major << 8) | minor) >>> 0;
const END = 0x0000ffff;
const REG = shaderPipeline.REGISTER;
const SIO = shaderPipeline.OP;
const regTypeBits = type => (((type & 0x7) << 28) | ((type & 0x18) << 8)) >>> 0;
const instr = (opcode, length = 0) =>
    ((opcode & 0xffff) | ((length & 0xf) << 24)) >>> 0;
const dst = (type, index, mask = 0xf) =>
    (0x80000000 | (index & 0x7ff) | regTypeBits(type) | (mask << 16)) >>> 0;
const src = (type, index) =>
    (0x80000000 | (index & 0x7ff) | regTypeBits(type) | (0xe4 << 16)) >>> 0;
const dcl = (usage, usageIndex = 0, textureType = 0) =>
    (0x80000000 | usage | (usageIndex << 16) | (textureType << 27)) >>> 0;

// vs_2_0: dcl_position v0 / dcl_color0 v1 / m4x4 oPos, v0, c0 / mov oD0, v1
const VS_BYTECODE = [
    VS(2, 0),
    instr(SIO.DCL, 2), dcl(DECLUSAGE.POSITION), dst(REG.INPUT, 0),
    instr(SIO.DCL, 2), dcl(DECLUSAGE.COLOR, 0), dst(REG.INPUT, 1),
    instr(SIO.M4x4, 3), dst(REG.RASTOUT, 0), src(REG.INPUT, 0), src(REG.CONST, 0),
    instr(SIO.MOV, 2), dst(REG.ATTROUT, 0), src(REG.INPUT, 1),
    END,
];

// vs_2_0: dcl_position v0 / dcl_texcoord v5 / m4x4 oPos, v0, c0 /
// mov oT0, v5. This is the fixed-function-pixel-stage boundary GTA SA's
// character vertex shaders use: once a vertex shader is bound, stage 0 must
// consume oT0 even if stale fixed-function TEXCOORDINDEX state says otherwise.
const VS_TEXCOORD0_BYTECODE = [
    VS(2, 0),
    instr(SIO.DCL, 2), dcl(DECLUSAGE.POSITION), dst(REG.INPUT, 0),
    instr(SIO.DCL, 2), dcl(DECLUSAGE.TEXCOORD), dst(REG.INPUT, 5),
    instr(SIO.M4x4, 3), dst(REG.RASTOUT, 0), src(REG.INPUT, 0), src(REG.CONST, 0),
    instr(SIO.MOV, 2), dst(REG.OUTPUT, 0), src(REG.INPUT, 5),
    END,
];

// M5 skeletal-layout fixture. The maths is intentionally small; the important
// contract here is that BLENDWEIGHT/BLENDINDICES and the compact auxiliary
// semantics all reach v# with D3D9 float4 values, ready for a real matrix
// palette shader to index the c# register file.
const VS_M5_SKINNING_INPUTS = [
    VS(2, 0),
    instr(SIO.DCL, 2), dcl(DECLUSAGE.POSITION), dst(REG.INPUT, 0),
    instr(SIO.DCL, 2), dcl(DECLUSAGE.BLENDWEIGHT), dst(REG.INPUT, 1),
    instr(SIO.DCL, 2), dcl(DECLUSAGE.BLENDINDICES), dst(REG.INPUT, 2),
    instr(SIO.DCL, 2), dcl(DECLUSAGE.TEXCOORD), dst(REG.INPUT, 3),
    instr(SIO.DCL, 2), dcl(DECLUSAGE.TANGENT), dst(REG.INPUT, 4),
    instr(SIO.DCL, 2), dcl(DECLUSAGE.NORMAL), dst(REG.INPUT, 5),
    instr(SIO.DCL, 2), dcl(DECLUSAGE.BINORMAL), dst(REG.INPUT, 6),
    instr(SIO.M4x4, 3), dst(REG.RASTOUT, 0), src(REG.INPUT, 0), src(REG.CONST, 0),
    instr(SIO.ADD, 3), dst(REG.ATTROUT, 0), src(REG.INPUT, 1), src(REG.INPUT, 2),
    END,
];

// ps_2_0: dcl_2d s0 / dcl t0 / texld r0, t0, s0 / mul oC0, r0, c1
const PS_BYTECODE = [
    PS(2, 0),
    instr(SIO.DCL, 2), dcl(0, 0, 2), dst(REG.SAMPLER, 0),
    instr(SIO.DCL, 2), dcl(DECLUSAGE.TEXCOORD, 0), dst(REG.TEXTURE, 0),
    instr(SIO.TEX, 3), dst(REG.TEMP, 0), src(REG.TEXTURE, 0), src(REG.SAMPLER, 0),
    instr(SIO.MUL, 3), dst(REG.COLOROUT, 0), src(REG.TEMP, 0), src(REG.CONST, 1),
    END,
];

const PS_SAMPLER15_BYTECODE = [
    PS(2, 0),
    instr(SIO.DCL, 2), dcl(0, 0, 2), dst(REG.SAMPLER, 15),
    instr(SIO.DCL, 2), dcl(DECLUSAGE.TEXCOORD, 0), dst(REG.TEXTURE, 0),
    instr(SIO.TEX, 3), dst(REG.TEMP, 0),
        src(REG.TEXTURE, 0), src(REG.SAMPLER, 15),
    instr(SIO.MOV, 2), dst(REG.COLOROUT, 0), src(REG.TEMP, 0),
    END,
];

// A shader the translator refuses. texbem and the texm3x* family used to sit
// here; they are translated now, so this reaches for one of the few ps_1_x
// instructions that still has no honest translation -- texdepth replaces the
// fragment's depth, which this pipeline has no frag_depth path for.
const PS_UNSUPPORTED = [
    PS(1, 4),
    instr(SIO.TEXDEPTH), dst(REG.TEMP, 0),
    END,
];

// vs_3_0: dcl_2d s0 / dcl_position v0 / dcl_position o0 /
// texldl r0, v0, s0 / mov o0, r0. Vertex texture samplers live in D3D9's
// 256..259 namespace and must not alias pixel sampler s0.
const VS3_VERTEX_TEXTURE_FETCH = [
    VS(3, 0),
    instr(SIO.DCL, 2), dcl(0, 0, 2), dst(REG.SAMPLER, 0),
    instr(SIO.DCL, 2), dcl(DECLUSAGE.POSITION), dst(REG.INPUT, 0),
    instr(SIO.DCL, 2), dcl(DECLUSAGE.POSITION), dst(REG.OUTPUT, 0),
    instr(SIO.TEXLDL, 3), dst(REG.TEMP, 0),
        src(REG.INPUT, 0), src(REG.SAMPLER, 0),
    instr(SIO.MOV, 2), dst(REG.OUTPUT, 0), src(REG.TEMP, 0),
    END,
];

// ---- fake WebGPU ----

function makeFakeWebGPU(options) {
    options = options || {};
    const calls = [];
    const submittedWorkResolvers = [];
    class FakeBuffer {
        constructor(descriptor) {
            this.descriptor = descriptor;
            this.size = descriptor.size;
            this.data = new Uint8Array(descriptor.size);
        }
        mapAsync() {
            // A lost or errored device accepts the submit and then never
            // signals; makeFakeWebGPU({ hangMapAsync: true }) reproduces it.
            if (options.hangMapAsync) return new Promise(() => {});
            return Promise.resolve();
        }
        getMappedRange() { return this.data.buffer; }
        unmap() { this.mapped = false; }
        destroy() { this.destroyed = true; }
    }
    class FakeTexture {
        constructor(descriptor) { this.descriptor = descriptor; }
        createView(descriptor) {
            const view = { texture: this, descriptor: descriptor || null };
            calls.push(["createView", this, descriptor || null, view]);
            return view;
        }
        destroy() { this.destroyed = true; }
    }
    class FakePass {
        constructor(descriptor) { this.descriptor = descriptor; this.ops = []; }
        setPipeline(p) { this.ops.push(["pipeline", p]); }
        setBindGroup(i, g, dynamicOffsets) {
            this.ops.push(["bindGroup", i, g, dynamicOffsets]);
            calls.push(["setBindGroup", i, g, dynamicOffsets]);
        }
        setViewport(...a) { this.ops.push(["viewport", ...a]); }
        setScissorRect(...a) {
            this.ops.push(["scissor", ...a]);
            calls.push(["setScissorRect", ...a]);
        }
        setBlendConstant(value) {
            this.ops.push(["blendConstant", value]);
            calls.push(["setBlendConstant", value]);
        }
        setStencilReference(value) {
            this.ops.push(["stencilReference", value]);
            calls.push(["setStencilReference", value]);
        }
        setVertexBuffer(slot, buffer, offset) {
            this.ops.push(["vertexBuffer", slot, buffer, offset]);
        }
        setIndexBuffer(buffer, format, offset) {
            this.ops.push(["indexBuffer", buffer, format, offset]);
        }
        draw(...a) { this.ops.push(["draw", ...a]); }
        drawIndexed(...a) { this.ops.push(["drawIndexed", ...a]); }
        beginOcclusionQuery(slot) {
            this.occlusionSlot = slot;
            this.ops.push(["beginOcclusionQuery", slot]);
        }
        endOcclusionQuery() {
            if (this.descriptor.occlusionQuerySet &&
                    this.occlusionSlot !== undefined)
                this.descriptor.occlusionQuerySet.values[this.occlusionSlot] = 37n;
            this.ops.push(["endOcclusionQuery"]);
            this.occlusionSlot = undefined;
        }
        end() { this.ended = true; }
    }
    class FakeEncoder {
        constructor() { this.passes = []; }
        beginRenderPass(descriptor) {
            const pass = new FakePass(descriptor);
            this.passes.push(pass);
            calls.push(["beginRenderPass", descriptor, pass]);
            return pass;
        }
        copyTextureToTexture(...args) {
            calls.push(["copyTextureToTexture", ...args]);
        }
        copyTextureToBuffer(source, destination, size) {
            const texture = source.texture;
            const input = texture.readbackData || new Uint8Array(0);
            const sourcePitch = texture.readbackPitch || size.width * 4;
            const originY = source.origin ? source.origin.y || 0 : 0;
            // For BC formats size.height is a texel extent rounded to four,
            // while rowsPerImage is the number of actual block rows in the
            // buffer. They are equal for ordinary textures.
            const copiedRows = destination.rowsPerImage || size.height;
            for (let row = 0; row < copiedRows; ++row) {
                const from = (originY + row) * sourcePitch;
                destination.buffer.data.set(input.subarray(from,
                    from + Math.min(sourcePitch, destination.bytesPerRow)),
                    row * destination.bytesPerRow);
            }
            calls.push(["copyTextureToBuffer", source, destination, size]);
        }
        writeTimestamp(querySet, slot) {
            querySet.values[slot] = 1000n + BigInt(slot);
        }
        resolveQuerySet(querySet, first, count, buffer, offset) {
            const out = new DataView(buffer.data.buffer);
            for (let i = 0; i < count; ++i)
                out.setBigUint64(offset + i * 8,
                    querySet.values[first + i] || 0n, true);
        }
        copyBufferToBuffer(source, sourceOffset, destination,
                destinationOffset, size) {
            destination.data.set(source.data.subarray(sourceOffset,
                sourceOffset + size), destinationOffset);
        }
        finish() { return { encoder: this }; }
    }
    const queue = {
        writeBuffer(buffer, offset, data, dataOffset, size) {
            const length = size !== undefined ? size
                : (data.byteLength !== undefined ? data.byteLength : data.length);
            assert.equal(offset % 4, 0, "writeBuffer destination offset must be 4-aligned");
            assert.equal(length % 4, 0, "writeBuffer size must be a multiple of 4");
            // WebGPU copies the source at call time. Snapshotting here rather
            // than holding the caller's view matters: the executor writes
            // straight out of a buffer's CPU shadow, which keeps mutating, so
            // a live reference would make every recorded write appear to
            // contain the frame's final contents.
            const view = ArrayBuffer.isView(data)
                ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                : new Uint8Array(data);
            const start = ArrayBuffer.isView(data) ? (dataOffset || 0) * 1 : (dataOffset || 0);
            const snapshot = view.slice(start, start + length);
            calls.push(["writeBuffer", buffer, offset, data, dataOffset, size, snapshot]);
        },
        writeTexture(...a) { calls.push(["writeTexture", ...a]); },
        submit(buffers) { calls.push(["submit", buffers]); },
        onSubmittedWorkDone() {
            return new Promise(resolve => submittedWorkResolvers.push(resolve));
        },
    };
    const device = {
        queue,
        lost: new Promise(() => {}),
        // A real GPUDevice reports the features it was actually created with,
        // which is what the shared host reads to decide capability flags --
        // the adapter's list is only what *could* have been requested.
        features: new Set(["texture-compression-bc", "timestamp-query"]),
        createShaderModule(descriptor) {
            const module = { descriptor, code: descriptor.code,
                getCompilationInfo: async () => ({ messages: [] }) };
            calls.push(["createShaderModule", descriptor, module]);
            return module;
        },
        createBuffer(descriptor) {
            const buffer = new FakeBuffer(descriptor);
            calls.push(["createBuffer", descriptor, buffer]);
            return buffer;
        },
        createTexture(descriptor) {
            const texture = new FakeTexture(descriptor);
            calls.push(["createTexture", descriptor, texture]);
            return texture;
        },
        createSampler(descriptor) {
            const sampler = { descriptor };
            calls.push(["createSampler", descriptor, sampler]);
            return sampler;
        },
        createCommandEncoder() {
            const encoder = new FakeEncoder();
            calls.push(["createCommandEncoder", encoder]);
            return encoder;
        },
        createQuerySet(descriptor) {
            const querySet = { descriptor,
                values: new BigUint64Array(descriptor.count),
                destroy() { this.destroyed = true; } };
            calls.push(["createQuerySet", descriptor, querySet]);
            return querySet;
        },
        createBindGroupLayout(descriptor) {
            const layout = { descriptor,
                bindings: new Set(descriptor.entries.map(e => e.binding)) };
            calls.push(["createBindGroupLayout", descriptor, layout]);
            return layout;
        },
        createPipelineLayout(descriptor) {
            calls.push(["createPipelineLayout", descriptor]);
            return { descriptor };
        },
        createRenderPipeline(descriptor) {
            const pipeline = { descriptor };
            calls.push(["createRenderPipeline", descriptor, pipeline]);
            return pipeline;
        },
        createBindGroup(descriptor) {
            const declared = descriptor.layout.bindings;
            const supplied = new Set(descriptor.entries.map(e => e.binding));
            for (const binding of supplied)
                assert.ok(declared.has(binding),
                    "bind group supplies binding " + binding +
                    " which its layout does not declare");
            for (const binding of declared)
                assert.ok(supplied.has(binding),
                    "bind group layout declares binding " + binding +
                    " but the bind group does not supply it");
            calls.push(["createBindGroup", descriptor]);
            return descriptor;
        },
    };
    const context = {
        configure(descriptor) { calls.push(["configure", descriptor]); },
        getCurrentTexture() {
            const texture = { width: 640, height: 480,
                createView: () => ({ swapchain: true }) };
            calls.push(["getCurrentTexture", texture]);
            return texture;
        },
    };
    const gpu = {
        async requestAdapter() {
            return {
                // A real adapter advertises optional features here, and a device
                // gets none of them unless it names them in requiredFeatures.
                features: new Set(["texture-compression-bc", "timestamp-query"]),
                async requestDevice(descriptor) {
                    calls.push(["requestDevice", descriptor || null]);
                    return device;
                },
            };
        },
        getPreferredCanvasFormat() { return "bgra8unorm"; },
    };
    return { calls, device, context, gpu,
        completeSubmittedWork() {
            for (const resolve of submittedWorkResolvers.splice(0)) resolve();
        } };
}

function makeExecutor(options = {}) {
    const { fakeOptions, ...executorOptions } = options;
    const fake = makeFakeWebGPU(fakeOptions);
    const canvas = { width: 1, height: 1, getContext: () => fake.context };
    const executor = new D3D9WebGPUExecutor(canvas,
        { gpu: fake.gpu, ...executorOptions });
    return { fake, executor, calls: fake.calls,
        find: name => fake.calls.filter(call => call[0] === name),
        last: name => {
            const matches = fake.calls.filter(call => call[0] === name);
            return matches[matches.length - 1];
        } };
}

/*
 * Constants reach the GPU as one staged upload of the whole uniform ring per
 * submit -- the shape a real driver's pushbuffer uses -- rather than one
 * writeBuffer per draw. A block therefore lives inside that upload, at the
 * dynamic offset the draw actually bound it at, so a test reads it through
 * here instead of treating the write's payload as the block itself.
 */
function constantBlock(find, buffer) {
    const write = find("writeBuffer").filter(call => call[1] === buffer).pop();
    assert.ok(write, "the uniform ring was never uploaded");
    const bind = find("setBindGroup").pop();
    const offsets = bind && bind[3];
    const dynamic = offsets && offsets.length ? offsets[0] : 0;
    return { buffer: write[6].buffer,
        byteOffset: write[6].byteOffset + dynamic - write[2] };
}

// Absolute DMA offset of the liveness counter: the response region base
// plus D9WG_HEARTBEAT_OFFSET (its last 16 bytes).
const HEARTBEAT_WRITE_OFFSET = (16 * 1024 * 1024 - 4 * 1024 * 1024) +
    (4 * 1024 * 1024 - 16);

// ---- harness ----

const failures = [];
let passed = 0;

async function test(name, body) {
    try {
        await body();
        ++passed;
    } catch (error) {
        failures.push({ name, error });
    }
}

// ---- tests ----

async function main() {

await test("a frame past the flush threshold submits early and never touches the swap chain",
        async () => {
    // The batch-size test's shape: one PCI batch carrying far more draws than
    // a frame is supposed to hold. Before the flush existed they all stayed
    // live as JS ops and then went into a single command buffer.
    const THRESHOLD = 1024;                       // the option's floor
    const DRAWS = THRESHOLD + 200;
    const { executor, fake, find } = makeExecutor({ flushThreshold: THRESHOLD });
    const draws = [];
    for (let i = 0; i < DRAWS; ++i)
        draws.push(command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)));
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        ...draws,
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();

    assert.equal(executor.stats.frameFlushes, 1,
        "one flush for " + DRAWS + " draws at a threshold of " + THRESHOLD);
    assert.equal(executor.stats.queueSubmits, 2,
        "the flush submits, and Present submits the remainder");
    // The whole point of owning the back buffer: a partial frame reaches the
    // GPU without acquiring a canvas texture it would have to hold across
    // tasks. One acquisition, at Present.
    assert.equal(find("getCurrentTexture").length, 1);
    // The flush is invisible to the guest's image: the second segment loads
    // what the first one drew, because both target the same owned texture.
    const passes = find("beginRenderPass");
    assert.ok(passes.length >= 2);
    assert.ok(passes.slice(1).every(call =>
        call[1].colorAttachments.every(a => a.loadOp === "load")),
        "a flush must not clear what the previous segment drew");
    assert.equal(executor.stats.framesWithoutColorClear, 1,
        "a flush is a fragment, not a frame that failed to clear");
    assert.equal(executor.stats.framesWithNoOps, 0);
});

await test("a Present whose ops were all flushed away still reaches the canvas",
        async () => {
    // The flush makes this ordinary rather than exotic: the last flush can
    // land on the final draw, so Present arrives with an empty frame -- and a
    // canvas texture is new and undefined every frame, so "nothing to replay"
    // must not mean "nothing to show".
    const THRESHOLD = 1024;
    const { executor, fake, find } = makeExecutor({ flushThreshold: THRESHOLD });
    const draws = [];
    for (let i = 0; i < THRESHOLD; ++i)
        draws.push(command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)));
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        ...draws,
    ]));
    await executor.idle();
    assert.equal(executor.stats.frameFlushes, 1);
    assert.equal(executor.frame, null, "the flush consumed the whole frame");
    const backBuffer = executor.backBufferTexture;
    assert.ok(backBuffer);
    assert.equal(find("getCurrentTexture").length, 0,
        "a flush must never acquire the swap chain");

    // Present arrives in a later batch with nothing of its own to draw.
    await executor.submit(buildBatch([
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();

    assert.equal(find("getCurrentTexture").length, 1);
    const presented = find("copyTextureToTexture")
        .filter(call => call[1].texture === backBuffer);
    assert.equal(presented.length, 1,
        "the owned back buffer must still be copied to the canvas");
    assert.equal(executor.stats.backBufferPresents, 1);
});

await test("the host reports liveness once per batch so a backlog is not a timeout",
        async () => {
    /*
     * The fault this exists for: submission has no backpressure, so a host that
     * has fallen thousands of batches behind still answers a readback -- just
     * later than any wall-clock deadline the guest could pick. Without a
     * liveness signal the guest cannot tell that apart from a dead host, and it
     * reported "GetFrontBufferData failed" for a host that was working.
     */
    const beats = [];
    const { executor } = makeExecutor();
    const metadata = { writeGuestMemory(offset, data) {
        if (offset === HEARTBEAT_WRITE_OFFSET)
            beats.push(Buffer.from(data).readUInt32LE(0));
    } };
    for (let i = 0; i < 3; ++i) {
        await executor.submit(buildBatch([
            command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
            command(OP.CLEAR, u32(DEVICE, 1, 0xff000000, 0x3f800000, 0, 0)),
            command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
        ], { present: true }), metadata);
        await executor.idle();
    }
    assert.equal(beats.length, 3, "one beat per finished batch");
    // Strictly increasing is what lets the guest reset its deadline on change
    // rather than on a value it has to interpret.
    assert.deepEqual(beats, [1, 2, 3]);

    // A batch with no writer must not throw or stall the counter.
    await executor.submit(buildBatch([
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(beats.length, 3, "no writer, no beat, no error");
});

await test("a readback whose map never completes fails instead of hanging the guest",
        async () => {
    // The guest spins on the response with interrupts of its own, so a map that
    // never resolves is not slow -- it freezes the VM until the guest's own cap
    // expires. Bounding it here turns a stall into a reported failure the guest
    // can raise as D3DERR_DRIVERINTERNALERROR straight away.
    const { executor } = makeExecutor(
        { readbackTimeoutMs: 30, fakeOptions: { hangMapAsync: true } });
    const writes = [];
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CLEAR, u32(DEVICE, 1, 0xff000000, 0x3f800000, 0, 0)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true, versionMinor: 3 }));
    await executor.idle();

    await executor.submit(buildBatch([
        command(OP.READBACK_SURFACE,
            u32(DEVICE, 0, 0, 21, 640, 480, 0, 1, 640 * 4, 640 * 4,
                16 * 1024, 0x22334455)),
    ], { versionMinor: 3 }), { writeGuestMemory(offset, data) {
        // The host bumps a liveness counter once per batch at the very top
        // of the response region; it is not a response to anything, so it
        // must not be counted as one.
        if (offset === HEARTBEAT_WRITE_OFFSET) return;
        writes.push({ offset, data: Buffer.from(data) });
    } });
    await executor.idle();

    assert.equal(executor.stats.renderTargetReadbackFailures, 1,
        "the stalled map must be reported as a readback failure");
    assert.equal(writes.length, 1,
        "the guest must still get a response rather than spinning to its cap");
    // status is the 4th u32 of D9WGReadbackResponse; 2 is D9WG_RESPONSE_FAILED.
    assert.equal(writes[0].data.readUInt32LE(12), 2);
});

await test("constants go up as one staged upload per submit, not one per draw",
        async () => {
    // What a driver does with its pushbuffer: write constants into a mapped
    // ring with a plain CPU pointer and ring the doorbell once. A 3DMark06
    // batch-size run made 22 million per-draw writeBuffer calls carrying 6.8 GB;
    // the bytes are unavoidable, the 22 million API calls were not.
    const DRAWS = 40;
    const { executor, find } = makeExecutor();
    const body = [];
    for (let i = 0; i < DRAWS; ++i) {
        // A constant change between every pair, so no two draws can share a
        // slot and the ring genuinely holds DRAWS distinct blocks.
        const c = floatConstants(0, [i, i + 1, i + 2, i + 3]);
        body.push(command(OP.SET_VS_CONST_F, c.payload, c.blob, c.blobOffsetField));
        body.push(command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)));
    }
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        ...body,
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();

    const ring = find("createBuffer").find(call =>
        /^D3D9 uniform ring \d+$/.test(String(call[1].label || "")))[2];
    const ringWrites = find("writeBuffer").filter(call => call[1] === ring);
    assert.equal(ringWrites.length, 1,
        DRAWS + " draws must produce one ring upload, not one each");
    assert.equal(executor.stats.uniformStagingUploads, 1);
    assert.equal(ringWrites[0][2], 0, "the staged upload starts at the ring base");
    // Every distinct block is still in it: DRAWS slots at 256-byte alignment.
    assert.ok(ringWrites[0][5] >= DRAWS * 256,
        "the upload must cover every slot the frame allocated");
});

await test("a run of draws with no state change between them shares one slot",
        async () => {
    // The driver answer to "did the constants change": nothing called
    // SetConstant, so nothing did. O(1), and it replaces hashing the assembled
    // block on every draw.
    const drawBatch = extra => {
        const body = [];
        for (let i = 0; i < 8; ++i) {
            if (extra) {
                const c = floatConstants(0, [i, i, i, i]);
                body.push(command(OP.SET_VS_CONST_F, c.payload, c.blob,
                    c.blobOffsetField));
            }
            body.push(command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)));
        }
        return buildBatch([
            command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
            command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
            command(OP.SET_FVF, fvfPayload(0x2,
                [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
            command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
            ...body,
            command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
        ], { present: true });
    };

    const quiet = makeExecutor();
    await quiet.executor.submit(drawBatch(false));
    await quiet.executor.idle();
    assert.equal(quiet.executor.stats.uniformSlotReuses, 7,
        "seven draws after the first found the state unchanged");

    const busy = makeExecutor();
    await busy.executor.submit(drawBatch(true));
    await busy.executor.idle();
    assert.equal(busy.executor.stats.uniformSlotReuses, 0,
        "a SetVertexShaderConstantF between draws must invalidate the slot");
});

await test("identical consecutive draws issue one pass-state call, not nine",
        async () => {
    // The batch-size test's shape: many draws that differ only in their index
    // range. Pass state persists in WebGPU until it changes, so re-issuing it
    // per draw is pure JS->Dawn overhead -- and at this draw count it is the
    // dominant cost.
    const DRAWS = 24;
    const { executor, fake, find } = makeExecutor();
    const draws = [];
    for (let i = 0; i < DRAWS; ++i)
        draws.push(command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)));
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        ...draws,
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();

    const pass = find("beginRenderPass").pop()[2];
    const counted = kind => pass.ops.filter(op => op[0] === kind).length;
    assert.equal(counted("draw"), DRAWS, "every draw must still be issued");
    // Each of these is set once for the pass and then left alone.
    for (const kind of ["pipeline", "bindGroup", "blendConstant",
            "stencilReference", "viewport", "scissor", "vertexBuffer"])
        assert.equal(counted(kind), 1,
            kind + " should be set once per pass, not once per draw");
    assert.equal(executor.stats.redundantStateSkipped, (DRAWS - 1) * 7,
        "seven state calls skipped for each draw after the first");
});

await test("a new pass re-issues state that WebGPU forgot", async () => {
    // The skip is only sound because beginRenderPass resets all of it. A
    // target switch opens a new pass, and everything must be set again there
    // or the second pass draws with no pipeline bound at all.
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        // A Clear always starts a new pass (WebGPU spells a clear only as a
        // pass loadOp), so this is the cheapest way to force the boundary.
        command(OP.CLEAR, u32(DEVICE, 1, 0xff000000, 0x3f800000, 0, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();

    const passes = find("beginRenderPass").map(call => call[2])
        .filter(pass => pass.ops.some(op => op[0] === "draw"));
    assert.equal(passes.length, 2, "the Clear must have split the passes");
    for (const pass of passes)
        for (const kind of ["pipeline", "bindGroup", "viewport", "scissor",
                "vertexBuffer"])
            assert.equal(pass.ops.filter(op => op[0] === kind).length, 1,
                kind + " must be re-set in every pass that draws");
});

await test("uniform storage grows by pooled chunks, not one buffer per draw", async () => {
    // 3DMark06's batch-size test issues draw calls by the hundred thousand --
    // that is what it measures -- and each draw with distinct constants needs
    // its own uniform slot. One 16 MiB ring holds 65536 of them; past that the
    // old allocator handed out a fresh GPUBuffer per draw, each of which also
    // forced an uncacheable bind group, and the pair was held until Present.
    // That is what took the browser's GPU process down.
    const CHUNK = 64 * 1024;                     // the allocator's floor
    const SLOTS_PER_CHUNK = CHUNK / 256;         // UNIFORM_OFFSET_ALIGNMENT
    const { executor, fake } = makeExecutor(
        { uniformRingBytes: CHUNK, uniformRingChunks: 3 });
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(64, 64)),
    ]));

    // "D3D9 uniform ring overflow" also starts with "D3D9 uniform ring ", so
    // the chunk label is matched exactly rather than by prefix.
    const ringBuffers = () => fake.calls.filter(call =>
        call[0] === "createBuffer" &&
        /^D3D9 uniform ring \d+$/.test(String(call[1].label || "")));
    const overflowBuffers = () => fake.calls.filter(call =>
        call[0] === "createBuffer" &&
        call[1].label === "D3D9 uniform ring overflow");

    // Exactly the pool's worth of slots: every one comes out of a chunk, and
    // the chunks are the only buffers allocated.
    const distinct = new Set();
    for (let i = 0; i < SLOTS_PER_CHUNK * 3; ++i) {
        const slot = executor.allocateUniformSlot(256);
        assert.equal(slot.transient, false, "slot " + i + " should be pooled");
        distinct.add(slot.buffer);
    }
    assert.equal(distinct.size, 3, "three chunks should have been used");
    assert.equal(ringBuffers().length, 3);
    assert.equal(overflowBuffers().length, 0,
        "nothing should overflow while the pool has room");

    // Past the pool the old per-draw path is still the fallback, but it is now
    // the documented last resort rather than the first thing a big frame hits.
    const beyond = executor.allocateUniformSlot(256);
    assert.equal(beyond.transient, true);
    assert.equal(overflowBuffers().length, 1);
    assert.equal(executor.stats.uniformRingOverflows, 1);

    // A new frame rewinds to chunk 0 and reuses the same buffers rather than
    // allocating more -- stable identity is what keeps bind groups cacheable.
    executor.frame = null;
    executor.ensureFrame();
    const rewound = executor.allocateUniformSlot(256);
    assert.equal(rewound.transient, false);
    assert.equal(rewound.offset, 0);
    assert.equal(rewound.buffer, [...distinct][0],
        "the frame should restart in the first pooled chunk");
    assert.equal(ringBuffers().length, 3, "no new chunk on the second frame");
});

await test("fixed-function FVF triangle still renders (M1 regression guard)", async () => {
    const { executor, fake, find } = makeExecutor();
    const vertices = Buffer.alloc(3 * 16);
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(0, 12, DECLTYPE.D3DCOLOR, DECLUSAGE.COLOR),
    ];
    const create = shaderCreatePayload; void create;
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, vertices.length)),
        command(OP.SET_FVF, fvfPayload(0x142, elements)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 16)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.drawCalls, 1, "the draw was not recorded");
    assert.equal(executor.stats.droppedDraws, 0);
    const pipeline = find("createRenderPipeline").pop()[1];
    assert.equal(pipeline.primitive.topology, "triangle-list");
    assert.equal(pipeline.vertex.entryPoint, "d9_vs_main");
    assert.equal(pipeline.fragment.entryPoint, "d9_ps_main");
    // Position at location 0, diffuse at location 1, both from stream 0.
    assert.equal(pipeline.vertex.buffers.length, 1);
    assert.equal(pipeline.vertex.buffers[0].arrayStride, 16);
    assert.deepEqual(pipeline.vertex.buffers[0].attributes, [
        { shaderLocation: 0, offset: 0, format: "float32x3" },
        { shaderLocation: 1, offset: 12, format: "unorm8x4" },
    ]);
    const passes = fake.calls.filter(c => c[0] === "beginRenderPass");
    assert.equal(passes.length, 1);
    assert.deepEqual(passes[0][2].ops.filter(op => op[0] === "draw"), [["draw", 3]]);
});

await test("point sprites expand one source point into an instanced textured quad", async () => {
    const D3DRS_POINTSIZE = 154, D3DRS_POINTSPRITEENABLE = 156;
    const D3DRS_POINTSCALEENABLE = 157;
    const { executor, fake, find } = makeExecutor();
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(0, 12, DECLTYPE.FLOAT1, DECLUSAGE.PSIZE),
        element(0, 16, DECLTYPE.D3DCOLOR, DECLUSAGE.COLOR),
    ];
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 20 * 8)),
        command(OP.SET_FVF, fvfPayload(0x142, elements)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_POINTSIZE,
            0x41000000, 0)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_POINTSPRITEENABLE, 1, 0)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_POINTSCALEENABLE, 1, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(1, 0, 8)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();

    assert.equal(executor.stats.droppedDraws, 0);
    assert.equal(executor.stats.pointSpriteDraws, 1);
    assert.equal(executor.stats.pointSpriteInstances, 8);
    const pipeline = find("createRenderPipeline").pop()[1];
    assert.equal(pipeline.primitive.topology, "triangle-list");
    assert.equal(pipeline.primitive.cullMode, "none",
        "expanded points must not inherit triangle culling");
    assert.equal(pipeline.vertex.buffers[0].stepMode, "instance");
    assert.ok(pipeline.vertex.buffers[0].attributes.some(attribute =>
        attribute.shaderLocation === 12 && attribute.format === "float32"),
        "D3DDECLUSAGE_PSIZE must feed the point-size input");
    assert.ok(pipeline.vertex.module.code.includes("d9_point_uvs"));
    assert.ok(pipeline.vertex.module.code.includes("inverseSqrt(d9_point_denom)"),
        "D3DRS_POINTSCALEENABLE must apply A/B/C distance attenuation");
    assert.ok(pipeline.vertex.module.code.includes("result.varying2 = vec4<f32>(d9_point_uv"),
        "point-sprite UVs must replace TEXCOORD0");
    const pass = fake.calls.filter(call => call[0] === "beginRenderPass").pop()[2];
    assert.deepEqual(pass.ops.filter(op => op[0] === "draw"), [["draw", 6, 8]],
        "eight points should be one six-vertex instanced draw");
});

await test("fixed-function attribute locations follow semantics, not element order", async () => {
    // TEXCOORD declared before COLOR. M1 assigned locations by iteration
    // order while the WGSL hardcoded colour at location 1, so this
    // declaration fed texcoord bytes into the colour attribute.
    const { executor, find } = makeExecutor();
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(0, 12, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD),
        element(0, 20, DECLTYPE.D3DCOLOR, DECLUSAGE.COLOR),
    ];
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.CREATE_VERTEX_DECLARATION, declarationPayload(0x301, elements)),
        command(OP.SET_VERTEX_DECLARATION, u32(DEVICE, 0x301)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 24)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    const pipeline = find("createRenderPipeline").pop()[1];
    const byLocation = new Map(pipeline.vertex.buffers[0].attributes
        .map(a => [a.shaderLocation, a]));
    assert.equal(byLocation.get(1).offset, 20, "COLOR0 must stay at location 1");
    assert.equal(byLocation.get(1).format, "unorm8x4");
    // M3 widened the fixed-function location table to make room for NORMAL and
    // COLOR1 (lighting) plus all eight coordinate sets, so TEXCOORD0 moved from
    // 2 to 4. The property under test is unchanged: the location follows the
    // semantic, not the element's position in the declaration.
    assert.equal(byLocation.get(4).offset, 12, "TEXCOORD0 must stay at location 4");
    assert.equal(byLocation.get(4).format, "float32x2");
});

await test("programmable vs+ps: modules, bindings and constants all line up", async () => {
    const { executor, find } = makeExecutor();
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(0, 12, DECLTYPE.D3DCOLOR, DECLUSAGE.COLOR),
    ];
    const vs = shaderCreatePayload(0x40000001, VS_BYTECODE);
    const ps = shaderCreatePayload(0x40000003, PS_BYTECODE);
    const vsConst = floatConstants(0, [
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1,
    ]);
    const psConst = floatConstants(1, [0.25, 0.5, 0.75, 1]);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0x401, 4, 4, 1, 21, 0, 1)),
        command(OP.CREATE_VERTEX_DECLARATION, declarationPayload(0x301, elements)),
        command(OP.CREATE_VERTEX_SHADER, vs.payload, vs.blob, vs.blobOffsetField),
        command(OP.CREATE_PIXEL_SHADER, ps.payload, ps.blob, ps.blobOffsetField),
        command(OP.SET_VERTEX_DECLARATION, u32(DEVICE, 0x301)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 16)),
        command(OP.SET_VERTEX_SHADER, u32(DEVICE, 0x40000001)),
        command(OP.SET_PIXEL_SHADER, u32(DEVICE, 0x40000003)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x401, 0)),
        command(OP.SET_VS_CONST_F, vsConst.payload, vsConst.blob, vsConst.blobOffsetField),
        command(OP.SET_PS_CONST_F, psConst.payload, psConst.blob, psConst.blobOffsetField),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();

    assert.equal(executor.stats.shadersTranslated, 2);
    assert.equal(executor.stats.shaderTranslationFailures, 0);
    // One extra translation for the D3DCOLOR-corrected vertex variant.
    assert.equal(executor.stats.shaderVariantsTranslated, 1);
    assert.equal(executor.stats.droppedDraws, 0, "the programmable draw was dropped");
    assert.equal(executor.stats.programmableDraws, 1);

    // Vertex and fragment must come from two different modules.
    const pipeline = find("createRenderPipeline").pop()[1];
    assert.notEqual(pipeline.vertex.module, pipeline.fragment.module);
    assert.ok(pipeline.vertex.module.code.includes("@vertex"));
    assert.ok(pipeline.fragment.module.code.includes("@fragment"));
    // The v1 COLOR0 input is D3DCOLOR, so the module must swizzle it.
    assert.ok(/vin1 = in1\.bgra;/.test(pipeline.vertex.module.code),
        "D3DCOLOR vertex input was not corrected to RGBA:\n" +
        pipeline.vertex.module.code);
    // Locations follow the shader's own v# register numbers.
    assert.deepEqual(pipeline.vertex.buffers[0].attributes, [
        { shaderLocation: 0, offset: 0, format: "float32x3" },
        { shaderLocation: 1, offset: 12, format: "unorm8x4" },
    ]);

    // Bind group layout: vertex constants at 0, pixel constants at 1,
    // sampler 0's texture/sampler pair at 2/3.
    const layout = find("createBindGroupLayout").pop()[1];
    assert.deepEqual(layout.entries.map(e => e.binding).sort((a, b) => a - b),
        [0, 1, 2, 3]);
    const bindGroup = find("createBindGroup").pop()[1];
    const entries = new Map(bindGroup.entries.map(e => [e.binding, e]));
    assert.ok(entries.get(0).resource.buffer, "vertex constants are not a buffer");
    assert.equal(entries.get(0).resource.offset, 0);
    assert.equal(entries.get(1).resource.offset % 256, 0,
        "the pixel constant region must start on a 256-byte boundary");

    // And the values themselves: c0..c3 for the vertex stage, c1 for the
    // pixel stage at its own offset.
    const block = constantBlock(find, entries.get(0).resource.buffer);
    const data = new DataView(block.buffer, block.byteOffset);
    assert.equal(data.getFloat32(12 * 4, true), 5, "vs c3.x");
    assert.equal(data.getFloat32(13 * 4, true), 6, "vs c3.y");
    const pixelBase = entries.get(1).resource.offset;
    assert.equal(data.getFloat32(pixelBase + 16, true), 0.25, "ps c1.x");
    assert.equal(data.getFloat32(pixelBase + 28, true), 1, "ps c1.w");
});

await test("SM1 sampler variants follow cube/2D/volume bindings without poisoning the base shader",
        async () => {
    const { executor, find } = makeExecutor();
    const psHandle = 0x40000189; // NFS9's reported dropped ps_1_1 draw.
    const code = [PS(1, 1), instr(SIO.TEX), dst(REG.TEXTURE, 0),
        instr(SIO.MOV), dst(REG.TEMP, 0), src(REG.TEXTURE, 0), END];
    const ps = shaderCreatePayload(psHandle, code);
    const vs = shaderCreatePayload(0x40000001, VS_TEXCOORD0_BYTECODE);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(64, 64)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 72)),
        command(OP.CREATE_VERTEX_DECLARATION, declarationPayload(0x301, [
            element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
            element(0, 12, DECLTYPE.FLOAT3, DECLUSAGE.TEXCOORD),
        ])),
        command(OP.SET_VERTEX_DECLARATION, u32(DEVICE, 0x301)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 24)),
        command(OP.CREATE_VERTEX_SHADER, vs.payload, vs.blob, vs.blobOffsetField),
        command(OP.CREATE_PIXEL_SHADER, ps.payload, ps.blob, ps.blobOffsetField),
        command(OP.SET_VERTEX_SHADER, u32(DEVICE, 0x40000001)),
        command(OP.SET_PIXEL_SHADER, u32(DEVICE, psHandle)),
        command(OP.CREATE_TEXTURE_CUBE, u32(DEVICE, 0x401, 4, 1, 21, 0, 1, 0)),
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0x402, 4, 4, 1, 21, 0, 1)),
        command(OP.CREATE_TEXTURE_VOLUME, u32(DEVICE, 0x403, 4, 4, 4, 1, 21, 0, 1)),
    ]));
    for (const [handle, type] of [[0x401, "cube"], [0x402, "2d"],
            [0x403, "3d"], [0x401, "cube"]]) {
        const before = executor.stats.programmableDraws;
        await executor.submit(buildBatch([
            command(OP.SET_TEXTURE, u32(DEVICE, 0, handle, 0)),
            command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
            command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 64, 64)),
        ], { present: true }));
        assert.equal(executor.stats.programmableDraws, before + 1, type + " draw must execute");
        assert.equal(executor.stats.droppedDraws, 0);
        const group = find("setBindGroup").filter(call =>
            call[2].entries.some(entry => entry.binding === 3)).pop()[2];
        assert.equal(group.layout.descriptor.entries.find(entry => entry.binding === 2)
            .texture.viewDimension, type);
        const view = group.entries.find(entry => entry.binding === 2).resource;
        assert.equal((view.descriptor && view.descriptor.dimension) ||
            view.texture.descriptor.dimension || "2d", type);
    }
    const shader = executor.resources.get(psHandle);
    assert.equal(shader.translated.reflection.samplers[0].type, "2d");
    assert.equal(shader.variants.size, 2, "revisiting cube must reuse its variant");
    // SM2 really does declare 2D; the same binding is still invalid for it.
    const explicit = shaderCreatePayload(0x40000200, PS_BYTECODE);
    await executor.submit(buildBatch([
        command(OP.CREATE_PIXEL_SHADER, explicit.payload, explicit.blob, explicit.blobOffsetField),
        command(OP.SET_PIXEL_SHADER, u32(DEVICE, 0x40000200)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
    ]));
    assert.equal(executor.stats.droppedDraws, 1);
});

await test("all-draw solid probe overrides programmable shading and rejecting state",
        async () => {
    const { executor, find } = makeExecutor();
    executor.debug.forceSolidAllDraws = true;
    // The all-draw probe must win over the older diagnostic which drops
    // programmable draws; otherwise a user carrying both toggles forward sees
    // black and receives the same false geometry diagnosis as before.
    executor.debug.skipProgrammableDraws = true;
    const ps = shaderCreatePayload(0x40000003, PS_BYTECODE);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.CREATE_PIXEL_SHADER, ps.payload, ps.blob, ps.blobOffsetField),
        command(OP.SET_PIXEL_SHADER, u32(DEVICE, 0x40000003)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, 15, 1, 0)),   // alpha test
        command(OP.SET_RENDER_STATE, u32(DEVICE, 25, 1, 0)),   // NEVER
        command(OP.SET_RENDER_STATE, u32(DEVICE, 27, 1, 0)),   // blending
        command(OP.SET_RENDER_STATE, u32(DEVICE, 168, 0, 0)),  // no colour writes
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();

    assert.equal(executor.stats.droppedDraws, 0);
    assert.equal(executor.stats.programmableDraws, 1);
    const descriptor = find("createRenderPipeline").pop()[1];
    assert.ok(descriptor.fragment.module.code.includes(
        "return vec4<f32>(0.0, 1.0, 0.0, 1.0)"));
    assert.ok(!descriptor.fragment.module.code.includes("discard;"));
    assert.equal(descriptor.fragment.targets[0].writeMask, 0xf);
    assert.equal(descriptor.fragment.targets[0].blend, undefined);
    assert.equal(descriptor.primitive.cullMode, "none");
    assert.equal(descriptor.depthStencil.depthCompare, "always");
    assert.equal(descriptor.depthStencil.depthWriteEnabled, false);

    const pipelines = executor.debug.dumpPipelineStates();
    assert.equal(pipelines.length, 1);
    assert.equal(pipelines[0].draws, 1);
    assert.equal(pipelines[0].state.writeMask, 0xf);
    assert.equal(pipelines[0].state.alphaTest.enabled, false);
    const report = executor.debug.blackScreenReport();
    assert.equal(report.debug.forceSolidAllDraws, true);
    assert.ok(report.draws.programmable);
    assert.equal(report.draws.programmable.effectiveClip.width, 640);
    assert.equal(report.draws.programmable.effectiveClip.height, 480);
});

await test("a programmable VS routes fixed-function stage n through oTn", async () => {
    const { executor, find } = makeExecutor();
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(0, 12, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD),
    ];
    const vs = shaderCreatePayload(0x40000004, VS_TEXCOORD0_BYTECODE);
    const tss = (stage, state, value) =>
        command(0x202, u32(DEVICE, stage, state, value));
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0x401, 4, 4, 1, 21, 0, 1)),
        command(OP.CREATE_VERTEX_DECLARATION, declarationPayload(0x301, elements)),
        command(OP.CREATE_VERTEX_SHADER, vs.payload, vs.blob, vs.blobOffsetField),
        command(OP.SET_VERTEX_DECLARATION, u32(DEVICE, 0x301)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.SET_VERTEX_SHADER, u32(DEVICE, 0x40000004)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x401, 0)),
        // This may be stale vertex-state from a preceding fixed-function pass.
        // D3D9 still routes stage 0 to oT0 while a vertex shader is bound.
        tss(0, 11 /* D3DTSS_TEXCOORDINDEX */, 1),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();

    assert.equal(executor.stats.droppedDraws, 0);
    assert.equal(executor.stats.drawsWithUnwrittenCoordVarying, 0,
        "stage 0 must not follow stale TEXCOORDINDEX while a VS is bound");
    const pipeline = find("createRenderPipeline").pop()[1];
    assert.ok(executor.resources.get(0x40000004).translated.reflection
        .writtenVaryings.includes(2),
    "the translated vertex shader must write oT0 into varying2");
    assert.ok(pipeline.fragment.module.code.includes("stage_in.varying2.xy"),
        "fixed-function stage 0 must sample the translated oT0 varying:\n" +
        pipeline.fragment.module.code);
    assert.ok(!pipeline.fragment.module.code.includes("stage_in.varying3.xy"),
        "stale TEXCOORDINDEX must not redirect stage 0 to oT1");
});

await test("persistent WGSL cache is restored before CREATE_SHADER executes", async () => {
    const cache = new shaderPipeline.D3D9ShaderCache();
    const stream = new Uint32Array(VS_BYTECODE);
    const hash = shaderPipeline.hashTokens(stream);
    cache.compile(stream, hash.low, hash.high);
    const payload = cache.exportEntries();
    let loads = 0;
    const storage = {
        async load() { ++loads; return payload; },
        async save() { throw new Error("a restored hit must not schedule a save"); },
    };
    const { executor } = makeExecutor({ shaderCacheStorage: storage });
    const vs = shaderCreatePayload(0x40000100, VS_BYTECODE);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_VERTEX_SHADER, vs.payload, vs.blob, vs.blobOffsetField),
    ]));
    await executor.idle();
    const stats = executor.getStats();
    assert.equal(loads, 1);
    assert.equal(stats.shaderCachePersistentLoads, 1);
    assert.equal(stats.shaderCachePersistentBackend, "injected");
    assert.equal(stats.shaderCacheMisses, 0);
    assert.equal(stats.shaderCacheHits, 1);
    assert.equal(stats.shadersCached, 1);
    assert.ok(stats.shaderWGSLBytesCached > 0);
    assert.deepEqual(stats.occlusionQueries, { mode: "webgpu-query-set",
        active: 0, perFrameCapacity: 8192, resolved: 0 });
});

await test("CREATE_SHADER verifies guest hashes before cache lookup", async () => {
    const { executor } = makeExecutor();
    const firstHandle = 0x40000110;
    const secondHandle = 0x40000111;
    const first = shaderCreatePayload(firstHandle, VS_BYTECODE);
    const second = shaderCreatePayload(secondHandle, VS_TEXCOORD0_BYTECODE);
    // Reproduce the legacy D3D8 proxy bug: every CREATE_SHADER command
    // advertised the same all-zero cache key despite carrying different code.
    for (const shader of [first, second]) {
        shader.payload.writeUInt32LE(0, 16);
        shader.payload.writeUInt32LE(0, 20);
    }
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_VERTEX_SHADER, first.payload, first.blob,
            first.blobOffsetField),
        command(OP.CREATE_VERTEX_SHADER, second.payload, second.blob,
            second.blobOffsetField),
    ]));
    await executor.idle();

    const stats = executor.getStats();
    assert.equal(stats.shaderCacheMisses, 2,
        "different bytecode must compile as two cache entries");
    assert.equal(stats.shaderCacheHits, 0);
    assert.notEqual(executor.resources.get(firstHandle).translated.wgsl,
        executor.resources.get(secondHandle).translated.wgsl,
        "a bogus guest hash must not alias distinct translated shaders");
});

await test("CREATE_SHADER translation can run through the M6 Worker path", async () => {
    class CompileWorker {
        postMessage(message) {
            queueMicrotask(() => this.onmessage({ data: { id: message.id,
                result: shaderPipeline.compileShader(
                    new Uint32Array(message.tokens)) } }));
        }
        terminate() {}
    }
    const { executor } = makeExecutor({ Worker: CompileWorker,
        shaderWorkerUrl: "fake://d3d9_shader_worker.js" });
    const vs = shaderCreatePayload(0x40000101, VS_BYTECODE);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_VERTEX_SHADER, vs.payload, vs.blob, vs.blobOffsetField),
    ]));
    await executor.idle();
    const stats = executor.getStats();
    assert.equal(stats.shaderWorkerCompiles, 1);
    assert.equal(stats.shaderWorkerFallbacks, 0);
    assert.equal(stats.shaderCacheMisses, 1);
    assert.equal(stats.shaderCompileLatencyMs.samples, 1);
});

await test("shader `def` literals override app-set constants for that register", async () => {
    const { executor, find } = makeExecutor();
    // ps_2_0 with `def c0, 0.5, 0.25, 0, 1` and mov oC0, c0.
    const bytecode = [
        PS(2, 0),
        instr(SIO.DEF, 5), dst(REG.CONST, 0),
        0x3f000000, 0x3e800000, 0x00000000, 0x3f800000,
        instr(SIO.MOV, 2), dst(REG.COLOROUT, 0), src(REG.CONST, 0),
        END,
    ];
    const ps = shaderCreatePayload(0x40000005, bytecode);
    const psConst = floatConstants(0, [9, 9, 9, 9]);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.CREATE_PIXEL_SHADER, ps.payload, ps.blob, ps.blobOffsetField),
        command(OP.SET_PIXEL_SHADER, u32(DEVICE, 0x40000005)),
        command(OP.SET_PS_CONST_F, psConst.payload, psConst.blob, psConst.blobOffsetField),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);
    const bindGroup = find("createBindGroup").pop()[1];
    const pixelEntry = bindGroup.entries.find(e => e.binding === 1);
    const block = constantBlock(find, pixelEntry.resource.buffer);
    const data = new DataView(block.buffer, block.byteOffset);
    const base = pixelEntry.resource.offset;
    assert.equal(data.getFloat32(base, true), 0.5,
        "def c0 must win over SetPixelShaderConstantF");
    assert.equal(data.getFloat32(base + 4, true), 0.25);
});

await test("int and bool constant registers land after the float region", async () => {
    const { executor, find } = makeExecutor();
    // vs_2_0 with rep i0 { add r0, r0, c0 } and if b0.
    const bytecode = [
        VS(2, 0),
        instr(SIO.DCL, 2), dcl(DECLUSAGE.POSITION), dst(REG.INPUT, 0),
        instr(SIO.REP, 1), src(REG.CONSTINT, 0),
        instr(SIO.ADD, 3), dst(REG.TEMP, 0), src(REG.TEMP, 0), src(REG.CONST, 0),
        instr(SIO.ENDREP),
        instr(SIO.IF, 1), src(REG.CONSTBOOL, 0),
        instr(SIO.MOV, 2), dst(REG.TEMP, 0), src(REG.CONST, 1),
        instr(SIO.ENDIF),
        instr(SIO.MOV, 2), dst(REG.RASTOUT, 0), src(REG.TEMP, 0),
        END,
    ];
    const vs = shaderCreatePayload(0x40000007, bytecode);
    const ints = intConstants(0, [3, 0, 1, 0]);
    const bools = boolConstants(0, [1]);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.CREATE_VERTEX_SHADER, vs.payload, vs.blob, vs.blobOffsetField),
        command(OP.SET_VERTEX_SHADER, u32(DEVICE, 0x40000007)),
        command(OP.SET_VS_CONST_I, ints.payload, ints.blob, ints.blobOffsetField),
        command(OP.SET_VS_CONST_B, bools.payload, bools.blob, bools.blobOffsetField),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);
    const bindGroup = find("createBindGroup").pop()[1];
    const block = constantBlock(find, bindGroup.entries[0].resource.buffer);
    const data = new DataView(block.buffer, block.byteOffset);
    // The shader reads c0 and c1, so the float region is two vec4s (32 bytes),
    // then i0 (16 bytes), then the bool vector.
    assert.equal(data.getInt32(32, true), 3, "i0.x");
    assert.equal(data.getInt32(40, true), 1, "i0.z");
    assert.equal(data.getUint32(48, true), 1, "b0");
});

await test("a shader the translator refuses skips its draws and keeps the batch alive", async () => {
    const { executor } = makeExecutor();
    const ps = shaderCreatePayload(0x40000009, PS_UNSUPPORTED);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.CREATE_PIXEL_SHADER, ps.payload, ps.blob, ps.blobOffsetField),
        command(OP.SET_PIXEL_SHADER, u32(DEVICE, 0x40000009)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.SET_PIXEL_SHADER, u32(DEVICE, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.failed, null, "the batch must not fail as a whole");
    assert.equal(executor.stats.shaderTranslationFailures, 1);
    assert.equal(executor.stats.droppedDraws, 1, "only the shader-bound draw is skipped");
    assert.equal(executor.stats.drawsSkippedForBadShader, 1,
        "the skip must be attributed to the shader, not to missing geometry");
    assert.equal(executor.stats.drawCalls, 1, "the fixed-function draw still ran");
});

await test("independent sampler state drives the GPUSampler, not the texture", async () => {
    const { executor, find } = makeExecutor();
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(0, 12, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD),
    ];
    const D3DSAMP_ADDRESSU = 1, D3DSAMP_ADDRESSV = 2;
    const D3DSAMP_MAGFILTER = 5, D3DSAMP_MINFILTER = 6, D3DSAMP_MIPFILTER = 7;
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0x401, 4, 4, 1, 21, 0, 1)),
        command(OP.SET_FVF, fvfPayload(0x102, elements)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x401, 0)),
        command(OP.SET_SAMPLER_STATE, u32(DEVICE, 0, D3DSAMP_ADDRESSU, 3)), // CLAMP
        command(OP.SET_SAMPLER_STATE, u32(DEVICE, 0, D3DSAMP_ADDRESSV, 2)), // MIRROR
        command(OP.SET_SAMPLER_STATE, u32(DEVICE, 0, D3DSAMP_MAGFILTER, 2)), // LINEAR
        command(OP.SET_SAMPLER_STATE, u32(DEVICE, 0, D3DSAMP_MINFILTER, 2)),
        command(OP.SET_SAMPLER_STATE, u32(DEVICE, 0, D3DSAMP_MIPFILTER, 2)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);
    const samplers = find("createSampler");
    assert.equal(samplers.length, 1, "expected exactly one sampler to be created");
    assert.deepEqual({
        u: samplers[0][1].addressModeU, v: samplers[0][1].addressModeV,
        mag: samplers[0][1].magFilter, min: samplers[0][1].minFilter,
        mip: samplers[0][1].mipmapFilter,
    }, { u: "clamp-to-edge", v: "mirror-repeat", mag: "linear",
        min: "linear", mip: "linear" });
    assert.equal(executor.stats.samplersCreated, 1);
});

// The vendor FOURCC formats. These are outside the D3D9 specification but not
// outside what 9.0c-era games actually ship against, and the three below are
// exact WebGPU mappings rather than approximations.
await test("ATI1N and ATI2N map to BC4 and BC5", async () => {
    // 3Dc is BC4/BC5 under its pre-DX10 name, so this is a rename. Getting the
    // block size wrong is the failure that matters: BC4 is 8 bytes per 4x4
    // block and BC5 is 16, and a mismatched stride corrupts every level.
    const ATI1N = 0x31495441, ATI2N = 0x32495441;
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0xA01, 16, 16, 1, ATI1N, 0, 0)),
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0xA02, 16, 16, 1, ATI2N, 0, 0)),
    ]));
    await executor.idle();
    const formats = find("createTexture").map(call => call[1].format);
    assert.ok(formats.includes("bc4-r-unorm"),
        "ATI1N is BC4: " + formats.join(", "));
    assert.ok(formats.includes("bc5-rg-unorm"),
        "ATI2N is BC5: " + formats.join(", "));
});

await test("a NULL render target allocates the cheapest renderable format",
        async () => {
    // Nothing reads it -- it exists so a depth-only pass need not allocate a
    // colour buffer -- so the size must still match while the per-texel cost
    // need not.
    const D3DFMT_NULL = 0x4C4C554E;
    const D3DUSAGE_RENDERTARGET = 1;
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0xA03, 256, 256, 1, D3DFMT_NULL,
                D3DUSAGE_RENDERTARGET, 0)),
    ]));
    await executor.idle();
    const descriptor = find("createTexture")
        .map(call => call[1])
        .find(entry => entry.size && entry.size.width === 256);
    assert.ok(descriptor, "the NULL target still has to be allocated");
    assert.equal(descriptor.format, "r8unorm");
});

await test("ATOC in D3DRS_ADAPTIVETESS_Y enables alpha-to-coverage",
        async () => {
    // D3D9 never grew a state for alpha-to-coverage, so every vendor smuggled
    // a FOURCC through a state that meant something else. WebGPU has it
    // natively, which makes this one of the few exact mappings in the family.
    const D3DRS_ADAPTIVETESS_Y = 181, ATOC = 0x434F5441;
    const D3DMULTISAMPLE_4_SAMPLES = 4;
    const { executor, find } = makeExecutor();
    const createDevice = createDevicePayload(640, 480);
    createDevice.writeUInt32LE(D3DMULTISAMPLE_4_SAMPLES, 44);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevice),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_ADAPTIVETESS_Y, ATOC)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);
    assert.equal(
        find("createRenderPipeline").pop()[1].multisample.alphaToCoverageEnabled,
        true);
});

await test("ATOC on a single-sampled target stays off", async () => {
    // WebGPU rejects alphaToCoverage without multisampling, and with one
    // sample there is no coverage to spread an alpha value over anyway.
    const D3DRS_ADAPTIVETESS_Y = 181, ATOC = 0x434F5441;
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_ADAPTIVETESS_Y, ATOC)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);
    assert.equal(find("createRenderPipeline").pop()[1].multisample, undefined,
        "no multisample block at all on a single-sampled target");
});

// CreateAdditionalSwapChain targets a second guest window, so the host needs a
// second drawing surface. The back buffer is an ordinary render-target texture
// -- that is what keeps draws, StretchRect and readback unchanged -- and the
// chain is special only in the step that moves the finished image onto its own
// canvas.
const OP_CREATE_SWAP_CHAIN = 0x224;
const OP_DESTROY_SWAP_CHAIN = 0x225;
const OP_PRESENT_SWAP_CHAIN = 0x226;
const D3DUSAGE_RENDERTARGET_BIT = 1;

function makeSwapChainCanvas(calls) {
    return {
        width: 1, height: 1, style: {},
        getContext(kind) {
            calls.push(["swapchain-getContext", kind]);
            return {
                configure(descriptor) {
                    calls.push(["swapchain-configure", descriptor]);
                },
                unconfigure() { calls.push(["swapchain-unconfigure"]); },
                getCurrentTexture() {
                    const texture = { width: 256, height: 128,
                        createView: () => ({ swapchainOverlay: true }) };
                    calls.push(["swapchain-getCurrentTexture", texture]);
                    return texture;
                },
            };
        },
    };
}

await test("an additional swap chain gets its own configured canvas",
        async () => {
    const created = [];
    const surfaces = [];
    const { executor, find, calls } = makeExecutor({
        createSwapChainCanvas: (surface) => {
            created.push(surface);
            return makeSwapChainCanvas(calls);
        },
        onSwapChainSurface: (surface, reason) => surfaces.push([reason, surface]),
    });
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0x901, 256, 128, 1, 21, D3DUSAGE_RENDERTARGET_BIT, 0)),
        command(OP_CREATE_SWAP_CHAIN,
            u32(DEVICE, 0x77, 0x901, 0xBEEF, 12, 34, 256, 128)),
    ]));
    await executor.idle();
    assert.equal(executor.stats.swapChainsCreated, 1);
    assert.equal(executor.stats.swapChainsRefused, 0);
    assert.equal(created.length, 1, "the embedder must be asked for a canvas");
    assert.equal(created[0].swapChain, 0x77);
    assert.deepEqual(
        { x: created[0].x, y: created[0].y,
          width: created[0].width, height: created[0].height },
        { x: 12, y: 34, width: 256, height: 128 });
    assert.ok(find("swapchain-configure").length === 1,
        "the chain's context has to be configured before it can be presented to");
    assert.deepEqual(surfaces.map(entry => entry[0]), ["create"]);
});

await test("presenting an additional chain blits its back buffer to its canvas",
        async () => {
    const { executor, find, calls } = makeExecutor({
        createSwapChainCanvas: () => makeSwapChainCanvas(calls),
    });
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0x901, 256, 128, 1, 21, D3DUSAGE_RENDERTARGET_BIT, 0)),
        command(OP_CREATE_SWAP_CHAIN,
            u32(DEVICE, 0x77, 0x901, 0xBEEF, 12, 34, 256, 128)),
        command(OP_PRESENT_SWAP_CHAIN,
            u32(DEVICE, 0x77, 0xBEEF, 40, 50, 256, 128, 0)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.swapChainPresents, 1);
    assert.equal(executor.stats.swapChainPresentsDropped, 0);
    assert.equal(find("swapchain-getCurrentTexture").length, 1,
        "the chain's canvas is acquired inside the submitting task");
    // A blit, not a copy: the back buffer is an ordinary D3D texture whose
    // format need not match the canvas format, and a copy requires a match.
    const blitPipelines = find("createRenderPipeline")
        .map(call => call[1])
        .filter(descriptor => /blit/.test(descriptor.label || ""));
    assert.ok(blitPipelines.length >= 1,
        "the present has to go through the format-converting blit path");
});

await test("an additional swap chain with no canvas hook is counted, not silent",
        async () => {
    // Rendering nowhere in silence is the failure mode that costs the most to
    // diagnose; a refusal that says so costs nothing.
    const { executor } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0x901, 256, 128, 1, 21, D3DUSAGE_RENDERTARGET_BIT, 0)),
        command(OP_CREATE_SWAP_CHAIN,
            u32(DEVICE, 0x77, 0x901, 0xBEEF, 0, 0, 256, 128)),
        command(OP_PRESENT_SWAP_CHAIN,
            u32(DEVICE, 0x77, 0xBEEF, 0, 0, 256, 128, 0)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.swapChainsRefused, 1);
    assert.equal(executor.stats.swapChainPresentsDropped, 1,
        "the frame is dropped and counted rather than rendered nowhere");
});

await test("destroying an additional swap chain unconfigures and reports it",
        async () => {
    const surfaces = [];
    const { executor, find, calls } = makeExecutor({
        createSwapChainCanvas: () => makeSwapChainCanvas(calls),
        onSwapChainSurface: (surface, reason) => surfaces.push([reason, surface]),
    });
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0x901, 256, 128, 1, 21, D3DUSAGE_RENDERTARGET_BIT, 0)),
        command(OP_CREATE_SWAP_CHAIN,
            u32(DEVICE, 0x77, 0x901, 0xBEEF, 0, 0, 256, 128)),
        command(OP_DESTROY_SWAP_CHAIN, u32(DEVICE, 0x77)),
        // A present after destruction must not resurrect it.
        command(OP_PRESENT_SWAP_CHAIN,
            u32(DEVICE, 0x77, 0xBEEF, 0, 0, 256, 128, 0)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.swapChainsDestroyed, 1);
    assert.equal(find("swapchain-unconfigure").length, 1);
    assert.equal(executor.stats.swapChainPresentsDropped, 1);
    assert.deepEqual(surfaces.map(entry => entry[0]), ["create", "destroy"]);
    assert.equal(surfaces[1][1].visible, false,
        "the page needs to know the overlay is gone, not just that it existed");
});

await test("a multisampled target makes the pipeline declare its sample count",
        async () => {
    // WebGPU takes the count on the pipeline as well as on the attachments and
    // rejects a mismatch, so a multisampled device used to fail every draw.
    const D3DMULTISAMPLE_4_SAMPLES = 4;
    const { executor, find } = makeExecutor();
    const createDevice = createDevicePayload(640, 480);
    createDevice.writeUInt32LE(D3DMULTISAMPLE_4_SAMPLES, 44);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevice),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);
    const descriptor = find("createRenderPipeline").pop()[1];
    assert.ok(descriptor.multisample,
        "a multisampled pass needs a multisample block on the pipeline");
    assert.equal(descriptor.multisample.count, 4);
    assert.equal(descriptor.multisample.mask, 0xffffffff,
        "the default D3DRS_MULTISAMPLEMASK writes every sample");
});

await test("D3DRS_MULTISAMPLEMASK reaches the pipeline's sample mask",
        async () => {
    const D3DRS_MULTISAMPLEMASK = 162, D3DMULTISAMPLE_4_SAMPLES = 4;
    const { executor, find } = makeExecutor();
    const createDevice = createDevicePayload(640, 480);
    createDevice.writeUInt32LE(D3DMULTISAMPLE_4_SAMPLES, 44);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevice),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_MULTISAMPLEMASK, 0x5)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(find("createRenderPipeline").pop()[1].multisample.mask, 0x5);
});

await test("a single-sampled target leaves the multisample block off",
        async () => {
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(find("createRenderPipeline").pop()[1].multisample, undefined,
        "the ordinary path must be untouched");
});

await test("D3DFILL_WIREFRAME turns each triangle into its three edges",
        async () => {
    // WebGPU has no polygon mode, so wireframe is different geometry rather
    // than a pipeline flag: a line list carrying every triangle's edges.
    const D3DRS_FILLMODE = 8, D3DFILL_WIREFRAME = 2;
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.SET_RENDER_STATE,
            u32(DEVICE, D3DRS_FILLMODE, D3DFILL_WIREFRAME)),
        // Two triangles, non-indexed.
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 2)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);
    assert.equal(executor.stats.fillModeDraws, 1);
    const pipeline = find("createRenderPipeline").pop()[1];
    assert.equal(pipeline.primitive.topology, "line-list",
        "the pipeline has to rasterise lines, not triangles");
    // Two triangles -> six edges -> twelve indices.
    const write = find("writeBuffer")
        .map(call => call[3])
        .filter(data => data instanceof Uint32Array).pop();
    assert.ok(write, "an index buffer of edges must have been written");
    assert.equal(write.length, 12,
        "two triangles are six edges, and each edge is two indices");
    assert.deepEqual(Array.from(write.slice(0, 6)), [0, 1, 1, 2, 2, 0],
        "the first triangle's edges are (0,1) (1,2) (2,0)");
});

await test("D3DFILL_SOLID is the default and rewrites nothing", async () => {
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 2)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.fillModeDraws, 0,
        "solid fill must cost nothing at all");
    assert.equal(find("createRenderPipeline").pop()[1].primitive.topology,
        "triangle-list");
});

await test("D3DFILL_WIREFRAME unrolls a triangle strip before building edges",
        async () => {
    // A strip of N+2 vertices is N triangles that share edges; unrolling is
    // what makes the edge set match the solid form's silhouette.
    const D3DRS_FILLMODE = 8, D3DFILL_WIREFRAME = 2;
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.SET_RENDER_STATE,
            u32(DEVICE, D3DRS_FILLMODE, D3DFILL_WIREFRAME)),
        // D3DPT_TRIANGLESTRIP, two triangles = four vertices.
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(5, 0, 2)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);
    assert.equal(find("createRenderPipeline").pop()[1].primitive.topology,
        "line-list");
    const write = find("writeBuffer")
        .map(call => call[3])
        .filter(data => data instanceof Uint32Array).pop();
    assert.equal(write.length, 12, "two strip triangles are still six edges");
});

await test("D3DSHADE_FLAT stops interpolating the two colour varyings",
        async () => {
    const D3DRS_SHADEMODE = 9, D3DSHADE_FLAT = 1;
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x42, [
            element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
            element(0, 12, DECLTYPE.D3DCOLOR, DECLUSAGE.COLOR)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 16)),
        command(OP.SET_RENDER_STATE,
            u32(DEVICE, D3DRS_SHADEMODE, D3DSHADE_FLAT)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);
    const pipeline = find("createRenderPipeline").pop()[1];
    // Both sides of the interface have to agree or the pipeline is invalid.
    for (const [name, wgsl] of [["vertex", pipeline.vertex.module.code],
            ["fragment", pipeline.fragment.module.code]]) {
        assert.match(wgsl, /@location\(0\) @interpolate\(flat\) varying0/,
            "the diffuse varying must be flat in the " + name + " stage:\n" + wgsl);
        assert.match(wgsl, /@location\(1\) @interpolate\(flat\) varying1/,
            "the specular varying must be flat in the " + name + " stage");
        // Texture coordinates keep interpolating under flat shading in D3D9.
        assert.doesNotMatch(wgsl, /@location\(2\) @interpolate\(flat\)/,
            "only the colour varyings are flat in the " + name + " stage");
    }
});

await test("D3DSHADE_FLAT: both stages agree whichever of them is a translated shader",
        async () => {
    // A vertex output and the fragment input at the same location must have
    // the same interpolation, or createRenderPipeline fails and the frame's
    // command buffer with it (GTA San Andreas: its vertex shaders with the
    // fixed-function pixel stage drew nothing). D3D9 flat-shades COLOR0/1
    // with shaders too, as wined3d does.
    const D3DRS_SHADEMODE = 9, D3DSHADE_FLAT = 1, D3DSHADE_GOURAUD = 2;
    const interpolation = code => {
        const slots = new Map();
        for (const match of code.matchAll(
                /@location\((\d+)\)\s*(@interpolate\([^)]*\))?\s*varying\d+/g))
            slots.set(+match[1], match[2] || "perspective");
        return slots;
    };
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(0, 12, DECLTYPE.D3DCOLOR, DECLUSAGE.COLOR),
    ];
    for (const [label, vertexShader, pixelShader] of [
            ["vs + fixed-function ps", true, false],
            ["fixed-function vs + ps", false, true],
            ["vs + ps", true, true]]) {
        const { executor, find } = makeExecutor();
        const vs = shaderCreatePayload(0x40000001, VS_BYTECODE);
        const ps = shaderCreatePayload(0x40000003, PS_BYTECODE);
        const draw = shadeMode => [
            command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_SHADEMODE, shadeMode)),
            command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        ];
        await executor.submit(buildBatch([
            command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
            command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
            command(OP.CREATE_VERTEX_DECLARATION, declarationPayload(0x301, elements)),
            command(OP.CREATE_VERTEX_SHADER, vs.payload, vs.blob, vs.blobOffsetField),
            command(OP.CREATE_PIXEL_SHADER, ps.payload, ps.blob, ps.blobOffsetField),
            command(OP.SET_VERTEX_DECLARATION, u32(DEVICE, 0x301)),
            command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 16)),
            ...(vertexShader ? [command(OP.SET_VERTEX_SHADER, u32(DEVICE, 0x40000001))] : []),
            ...(pixelShader ? [command(OP.SET_PIXEL_SHADER, u32(DEVICE, 0x40000003))] : []),
            ...draw(D3DSHADE_FLAT),
            // and back: the same shaders, interpolating again
            ...draw(D3DSHADE_GOURAUD),
            command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
        ], { present: true }));
        await executor.idle();
        assert.equal(executor.stats.droppedDraws, 0, label);
        const [flat, gouraud] = find("createRenderPipeline").slice(-2).map(call => call[1]);
        for (const [shading, pipeline] of [["flat", flat], ["gouraud", gouraud]]) {
            const out = interpolation(pipeline.vertex.module.code);
            const into = interpolation(pipeline.fragment.module.code);
            for (const [slot, mode] of into)
                assert.equal(out.get(slot), mode, label + ", " + shading +
                    ": location " + slot + " differs between the stages:\n" +
                    pipeline.vertex.module.code + "\n" + pipeline.fragment.module.code);
            const expected = shading === "flat" ? "@interpolate(flat)" : "perspective";
            assert.equal(out.get(0), expected, label + ", " + shading + ": COLOR0");
            assert.equal(out.get(1), expected, label + ", " + shading + ": COLOR1");
            assert.equal(out.get(2), "perspective",
                label + ": texture coordinates keep interpolating");
        }
    }
});

await test("gouraud shading is the default and adds no interpolate attribute",
        async () => {
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x42, [
            element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
            element(0, 12, DECLTYPE.D3DCOLOR, DECLUSAGE.COLOR)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 16)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    const wgsl = find("createRenderPipeline").pop()[1].vertex.module.code;
    assert.doesNotMatch(wgsl, /@interpolate\(flat\)/,
        "the default must not change the shader at all:\n" + wgsl);
});

await test("D3DTADDRESS_MIRRORONCE mirrors the coordinate about zero",
        async () => {
    // The sampler is already clamp-to-edge for the mode, so abs() on that axis
    // is the whole of what is left -- not an approximation of it.
    const D3DSAMP_ADDRESSU = 1, D3DSAMP_ADDRESSV = 2;
    const D3DTADDRESS_MIRRORONCE = 5;
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(0, 12, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD),
    ];
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0x401, 4, 4, 1, 21, 0, 1)),
        command(OP.SET_FVF, fvfPayload(0x102, elements)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x401, 0)),
        command(OP.SET_SAMPLER_STATE,
            u32(DEVICE, 0, D3DSAMP_ADDRESSU, D3DTADDRESS_MIRRORONCE)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);
    assert.equal(find("createSampler").pop()[1].addressModeU, "clamp-to-edge",
        "the physical sampler clamps; the mirror is the shader's half");
    const wgsl = find("createRenderPipeline").pop()[1].fragment.module.code;
    assert.match(wgsl, /abs\(/,
        "the U axis has to be mirrored about zero:\n" + wgsl);
    // Only the axis that asked for it.
    assert.doesNotMatch(wgsl, /abs\([^)]*\)\.y/,
        "V is still WRAP and must be left alone:\n" + wgsl);
});

// D3D9 applies the gamma ramp at scanout, so the host applies it in the step
// that puts the finished frame on the canvas -- and only when it would change
// anything, because a lookup pass costs a full-screen draw the plain copy does
// not.
function gammaRampPayload(build) {
    const payload = Buffer.alloc(16 + 768 * 2);
    payload.writeUInt32LE(DEVICE, 0);
    for (let index = 0; index < 256; ++index) {
        const [r, g, b] = build(index);
        payload.writeUInt16LE(r & 0xffff, 16 + index * 2);
        payload.writeUInt16LE(g & 0xffff, 16 + (256 + index) * 2);
        payload.writeUInt16LE(b & 0xffff, 16 + (512 + index) * 2);
    }
    return payload;
}

await test("a non-identity gamma ramp turns the present copy into a lookup pass",
        async () => {
    const OP_SET_GAMMA_RAMP = 0x223;
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        // A half-brightness ramp: entry = index * 257 / 2.
        command(OP_SET_GAMMA_RAMP,
            gammaRampPayload(index => {
                const value = Math.round(index * 257 / 2);
                return [value, value, value];
            })),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.gammaRampUpdates, 1);
    assert.equal(executor.stats.gammaPresents, 1,
        "the ramp has to be applied on the way to the canvas");
    assert.equal(find("copyTextureToTexture").length, 0,
        "the plain copy cannot also run, or the ramp would be overwritten");
    const wgsl = find("createRenderPipeline")
        .map(call => call[1].fragment && call[1].fragment.module.code)
        .find(code => code && /d9_gamma_ramp/.test(code));
    assert.ok(wgsl, "a gamma lookup pipeline must have been built");
    assert.match(wgsl, /textureLoad\(d9_gamma_ramp/,
        "the table is indexed, never interpolated:\n" + wgsl);
});

await test("the identity gamma ramp keeps the plain present copy", async () => {
    // Titles set the identity ramp on startup and on exit. Paying for a
    // full-screen pass on every frame for a no-op transform is exactly the
    // cost this has to avoid.
    const OP_SET_GAMMA_RAMP = 0x223;
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP_SET_GAMMA_RAMP,
            gammaRampPayload(index => [index * 257, index * 257, index * 257])),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.gammaRampUpdates, 1);
    assert.equal(executor.stats.gammaPresents, 0,
        "an identity ramp changes nothing and must not add a pass");
    assert.equal(find("copyTextureToTexture").length, 1,
        "the ordinary present copy still runs");
});

await test("a gamma ramp reset back to identity releases the lookup pass",
        async () => {
    const OP_SET_GAMMA_RAMP = 0x223;
    const { executor } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP_SET_GAMMA_RAMP, gammaRampPayload(() => [0, 0, 0])),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.gammaPresents, 1);
    await executor.submit(buildBatch([
        command(OP_SET_GAMMA_RAMP,
            gammaRampPayload(index => [index * 257, index * 257, index * 257])),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.gammaPresents, 1,
        "the second present is back on the copy path");
});

await test("D3DSAMP_MAXMIPLEVEL becomes the sampler's LOD floor", async () => {
    const { executor, find } = makeExecutor();
    const D3DSAMP_MIPFILTER = 7, D3DSAMP_MAXMIPLEVEL = 9;
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(0, 12, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD),
    ];
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        // Four levels, so a floor of 2 is inside the chain.
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0x401, 8, 8, 4, 21, 0, 1)),
        command(OP.SET_FVF, fvfPayload(0x102, elements)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x401, 0)),
        command(OP.SET_SAMPLER_STATE, u32(DEVICE, 0, D3DSAMP_MIPFILTER, 2)),
        command(OP.SET_SAMPLER_STATE, u32(DEVICE, 0, D3DSAMP_MAXMIPLEVEL, 2)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);
    const descriptor = find("createSampler").pop()[1];
    assert.equal(descriptor.lodMinClamp, 2,
        "MAXMIPLEVEL 2 forbids sampling levels 0 and 1");
    assert.ok(descriptor.lodMaxClamp === undefined ||
        descriptor.lodMaxClamp > 2,
        "the coarse end of the chain stays available");
});

await test("SetLOD reaches the host and combines with D3DSAMP_MAXMIPLEVEL",
        async () => {
    // Two independent floors; D3D9 applies the more restrictive of the pair.
    const OP_SET_TEXTURE_LOD = 0x222;
    const D3DSAMP_MIPFILTER = 7, D3DSAMP_MAXMIPLEVEL = 9;
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(0, 12, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD),
    ];
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0x401, 8, 8, 4, 21, 0, 1)),
        command(OP.SET_FVF, fvfPayload(0x102, elements)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x401, 0)),
        command(OP.SET_SAMPLER_STATE, u32(DEVICE, 0, D3DSAMP_MIPFILTER, 2)),
        command(OP.SET_SAMPLER_STATE, u32(DEVICE, 0, D3DSAMP_MAXMIPLEVEL, 1)),
        command(OP_SET_TEXTURE_LOD, u32(DEVICE, 0x401, 3, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);
    assert.equal(find("createSampler").pop()[1].lodMinClamp, 3,
        "SetLOD(3) is more restrictive than MAXMIPLEVEL(1) and wins");
});

await test("a SetLOD past the end of the chain is clamped, not passed through",
        async () => {
    // lodMinClamp above lodMaxClamp is a WebGPU validation error, so a stale
    // level index has to be clamped against the chain that actually exists.
    const OP_SET_TEXTURE_LOD = 0x222;
    const D3DSAMP_MIPFILTER = 7;
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(0, 12, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD),
    ];
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0x401, 8, 8, 4, 21, 0, 1)),
        command(OP.SET_FVF, fvfPayload(0x102, elements)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x401, 0)),
        command(OP.SET_SAMPLER_STATE, u32(DEVICE, 0, D3DSAMP_MIPFILTER, 2)),
        command(OP_SET_TEXTURE_LOD, u32(DEVICE, 0x401, 99, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);
    assert.equal(find("createSampler").pop()[1].lodMinClamp, 3,
        "a four-level chain floors at level 3, not 99");
});

await test("D3DSAMP_MIPMAPLODBIAS becomes textureSampleBias in the cascade",
        async () => {
    // WebGPU samplers carry no bias field, so the only place it can land is
    // the sample call.
    const D3DSAMP_MIPFILTER = 7, D3DSAMP_MIPMAPLODBIAS = 8;
    const floatBits = value => {
        const buffer = Buffer.alloc(4);
        buffer.writeFloatLE(value, 0);
        return buffer.readUInt32LE(0);
    };
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(0, 12, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD),
    ];
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0x401, 8, 8, 4, 21, 0, 1)),
        command(OP.SET_FVF, fvfPayload(0x102, elements)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x401, 0)),
        command(OP.SET_SAMPLER_STATE, u32(DEVICE, 0, D3DSAMP_MIPFILTER, 2)),
        command(OP.SET_SAMPLER_STATE,
            u32(DEVICE, 0, D3DSAMP_MIPMAPLODBIAS, floatBits(-1.5))),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);
    const wgsl = find("createRenderPipeline").pop()[1].fragment.module.code;
    assert.match(wgsl, /textureSampleBias\(d9_tex0, d9_smp0, .*-1\.5/,
        "the bias has to reach the sample call:\n" + wgsl);
});

await test("a zero D3DSAMP_MIPMAPLODBIAS leaves the plain sample form alone",
        async () => {
    // The bias is baked as a literal, so every distinct value is a pipeline
    // variant. The default must not mint one.
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(0, 12, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD),
    ];
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0x401, 8, 8, 1, 21, 0, 1)),
        command(OP.SET_FVF, fvfPayload(0x102, elements)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x401, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    const wgsl = find("createRenderPipeline").pop()[1].fragment.module.code;
    assert.ok(!/textureSampleBias/.test(wgsl),
        "an unbiased stage keeps textureSample:\n" + wgsl);
});

await test("a second draw with the same sampler state reuses the cached sampler", async () => {
    const { executor } = makeExecutor();
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(0, 12, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD),
    ];
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0x401, 4, 4, 1, 21, 0, 1)),
        command(OP.SET_FVF, fvfPayload(0x102, elements)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x401, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.samplersCreated, 1);
    assert.equal(executor.stats.samplerHits, 1);
});

await test("fixed-function BORDER sampler state reaches the generated shader",
        async () => {
    const { executor, find } = makeExecutor();
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(0, 12, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD),
    ];
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0x401, 4, 4, 1, 21, 0, 1)),
        command(OP.SET_FVF, fvfPayload(0x102, elements)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x401, 0)),
        command(OP.SET_SAMPLER_STATE, u32(DEVICE, 0, 1, 4)),
        command(OP.SET_SAMPLER_STATE, u32(DEVICE, 0, 2, 4)),
        command(OP.SET_SAMPLER_STATE, u32(DEVICE, 0, 4, 0x80402010)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    const wgsl = find("createRenderPipeline").pop()[1].fragment.module.code;
    assert.ok(wgsl.includes("let tex0 = select(vec4<f32>("));
    assert.ok(wgsl.includes("0.25098039") && wgsl.includes("0.50196078"));
    assert.ok(!executor.stats.unreadStateIds ||
        !(executor.stats.unreadStateIds.samplerStates || []).includes(4),
    "BORDERCOLOR is consumed together with BORDER addressing");
});

await test("multi-stream declarations bind one vertex buffer per stream", async () => {
    const { executor, fake, find } = makeExecutor();
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(1, 0, DECLTYPE.D3DCOLOR, DECLUSAGE.COLOR),
        element(1, 4, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD),
    ];
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x202, 1, 96)),
        command(OP.CREATE_VERTEX_DECLARATION, declarationPayload(0x301, elements)),
        command(OP.SET_VERTEX_DECLARATION, u32(DEVICE, 0x301)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(1, 0x202, 12, 32)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);
    const pipeline = find("createRenderPipeline").pop()[1];
    assert.equal(pipeline.vertex.buffers.length, 2, "expected two vertex buffer layouts");
    assert.deepEqual(pipeline.vertex.buffers[0].attributes,
        [{ shaderLocation: 0, offset: 0, format: "float32x3" }]);
    assert.equal(pipeline.vertex.buffers[1].arrayStride, 12);
    const pass = fake.calls.filter(c => c[0] === "beginRenderPass").pop()[2];
    const binds = pass.ops.filter(op => op[0] === "vertexBuffer");
    assert.equal(binds.length, 2);
    assert.equal(binds[1][3], 32, "stream 1's OffsetInBytes was lost");
});

await test("indexed instancing maps D3D9 stream frequencies to WebGPU instances",
        async () => {
    const { executor, fake, find } = makeExecutor();
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(1, 0, DECLTYPE.D3DCOLOR, DECLUSAGE.COLOR),
    ];
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 36)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x202, 1, 12)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x203, 2, 6, 101)),
        command(OP.CREATE_VERTEX_DECLARATION,
            declarationPayload(0x301, elements)),
        command(OP.SET_VERTEX_DECLARATION, u32(DEVICE, 0x301)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(1, 0x202, 4)),
        command(OP.SET_STREAM_SOURCE_FREQ,
            setStreamSourceFreqPayload(0, 0x40000003)),
        command(OP.SET_STREAM_SOURCE_FREQ,
            setStreamSourceFreqPayload(1, 0x80000001)),
        command(OP.SET_INDICES, u32(DEVICE, 0x203)),
        command(OP.DRAW_INDEXED_PRIMITIVE,
            drawIndexedPayload(4, 0, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();

    const pipeline = find("createRenderPipeline").pop()[1];
    assert.equal(pipeline.vertex.buffers[0].stepMode, "vertex");
    assert.equal(pipeline.vertex.buffers[1].stepMode, "instance");
    const pass = fake.calls.filter(c => c[0] === "beginRenderPass").pop()[2];
    assert.deepEqual(pass.ops.find(op => op[0] === "drawIndexed"),
        ["drawIndexed", 3, 3, 0, 0]);
    assert.equal(executor.stats.instancedDraws, 1);
    assert.equal(executor.stats.instancesDrawn, 3);
    assert.equal(executor.stats.expandedInstanceStreams, 0);
});

await test("D3D9 instance divisors greater than one are expanded exactly",
        async () => {
    const { executor, fake, find } = makeExecutor();
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(1, 0, DECLTYPE.D3DCOLOR, DECLUSAGE.COLOR),
    ];
    const instanceData = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const update = Buffer.alloc(24);
    update.writeUInt32LE(0x202, 0);
    update.writeUInt32LE(0, 4);
    update.writeUInt32LE(instanceData.length, 8);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 36)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x202, 1, 8)),
        command(OP.UPDATE_BUFFER, update, instanceData, 12),
        command(OP.CREATE_BUFFER, createBufferPayload(0x203, 2, 6, 101)),
        command(OP.CREATE_VERTEX_DECLARATION,
            declarationPayload(0x301, elements)),
        command(OP.SET_VERTEX_DECLARATION, u32(DEVICE, 0x301)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(1, 0x202, 4)),
        command(OP.SET_STREAM_SOURCE_FREQ,
            setStreamSourceFreqPayload(0, 0x40000004)),
        command(OP.SET_STREAM_SOURCE_FREQ,
            setStreamSourceFreqPayload(1, 0x80000002)),
        command(OP.SET_INDICES, u32(DEVICE, 0x203)),
        command(OP.DRAW_INDEXED_PRIMITIVE,
            drawIndexedPayload(4, 0, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();

    const expanded = find("createBuffer").find(call =>
        call[1].label === "D3D9 instance divisor expansion");
    assert.ok(expanded, "divisor > 1 did not create an expanded instance stream");
    const upload = find("writeBuffer").find(call => call[1] === expanded[2]);
    assert.ok(upload, "expanded instance stream was not uploaded");
    assert.deepEqual([...upload[6].subarray(0, 16)], [
        1, 2, 3, 4, 1, 2, 3, 4,
        5, 6, 7, 8, 5, 6, 7, 8,
    ]);
    const pipeline = find("createRenderPipeline").pop()[1];
    assert.equal(pipeline.vertex.buffers[1].stepMode, "instance");
    const pass = fake.calls.filter(c => c[0] === "beginRenderPass").pop()[2];
    assert.deepEqual(pass.ops.find(op => op[0] === "drawIndexed"),
        ["drawIndexed", 3, 4, 0, 0]);
    assert.equal(executor.stats.expandedInstanceStreams, 1);
});

await test("triangle strips use strip topology instead of being reinterpreted as a list", async () => {
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(5, 0, 4)), // 4 tris
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    const pipeline = find("createRenderPipeline").pop()[1];
    assert.equal(pipeline.primitive.topology, "triangle-strip");
    assert.equal(pipeline.primitive.stripIndexFormat, undefined,
        "a non-indexed strip must not declare stripIndexFormat");
});

await test("indexed triangle strips declare the strip index format", async () => {
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x202, 2, 64, 101)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.SET_INDICES, u32(DEVICE, 0x202)),
        command(OP.DRAW_INDEXED_PRIMITIVE, drawIndexedPayload(5, 0, 0, 4)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    const pipeline = find("createRenderPipeline").pop()[1];
    assert.equal(pipeline.primitive.topology, "triangle-strip");
    assert.equal(pipeline.primitive.stripIndexFormat, "uint16");
});

await test("triangle fans become an indexed triangle list", async () => {
    const { executor, fake, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(6, 0, 3)), // fan, 3 tris
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    const pipeline = find("createRenderPipeline").pop()[1];
    assert.equal(pipeline.primitive.topology, "triangle-list");
    const pass = fake.calls.filter(c => c[0] === "beginRenderPass").pop()[2];
    const drawIndexed = pass.ops.filter(op => op[0] === "drawIndexed");
    assert.equal(drawIndexed.length, 1);
    assert.equal(drawIndexed[0][1], 9, "3 fan triangles == 9 list indices");
    // (0,1,2) (0,2,3) (0,3,4)
    const indexWrite = find("writeBuffer").find(
        call => call[3] instanceof Uint32Array && call[3].length === 9);
    assert.ok(indexWrite, "the generated fan index buffer was not uploaded");
    assert.deepEqual([...indexWrite[3]], [0, 1, 2, 0, 2, 3, 0, 3, 4]);
});

await test("DrawIndexedPrimitiveUP works (M1 threw a ReferenceError on every call)", async () => {
    const { executor, fake } = makeExecutor();
    const vertexBytes = 4 * 12;
    const indexBytes = 6 * 2;
    const blob = Buffer.alloc(indexBytes + vertexBytes);
    for (let i = 0; i < 6; ++i) blob.writeUInt16LE([0, 1, 2, 0, 2, 3][i], i * 2);
    const payload = Buffer.alloc(48);
    payload.writeUInt32LE(DEVICE, 0);
    payload.writeUInt32LE(4, 4);       // D3DPT_TRIANGLELIST
    payload.writeUInt32LE(0, 8);       // min_vertex_index
    payload.writeUInt32LE(4, 12);      // vertex_count
    payload.writeUInt32LE(2, 16);      // primitive_count
    payload.writeUInt32LE(101, 20);    // D3DFMT_INDEX16
    payload.writeUInt32LE(12, 24);     // stride
    payload.writeUInt32LE(6, 28);      // index_count
    payload.writeUInt32LE(indexBytes, 32);
    payload.writeUInt32LE(vertexBytes, 36);
    // index_data_offset / vertex_data_offset are patched below.
    const built = buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.DRAW_INDEXED_PRIMITIVE_UP, payload, blob, 40),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true });
    // buildBatch patched index_data_offset (field 40); the vertex data sits
    // straight after the index data in the same blob, so field 44 is patched
    // here, in the assembled batch, to point past it.
    const blobOffset = payload.readUInt32LE(40);
    const commandOffset = built.indexOf(payload, 32);
    built.writeUInt32LE(blobOffset + indexBytes, commandOffset + 44);

    await executor.submit(built);
    await executor.idle();
    assert.equal(executor.failed, null,
        "DrawIndexedPrimitiveUP must not blow up the batch: " + executor.failed);
    assert.equal(executor.stats.upDrawCalls, 1);
    assert.equal(executor.stats.droppedDraws, 0);
    const pass = fake.calls.filter(c => c[0] === "beginRenderPass").pop()[2];
    assert.equal(pass.ops.filter(op => op[0] === "drawIndexed").length, 1);
});

await test("identical bytecode is translated once and shares one shader module", async () => {
    const { executor, find } = makeExecutor();
    const first = shaderCreatePayload(0x40000011, VS_BYTECODE);
    const second = shaderCreatePayload(0x40000013, VS_BYTECODE);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_VERTEX_SHADER, first.payload, first.blob, first.blobOffsetField),
        command(OP.CREATE_VERTEX_SHADER, second.payload, second.blob, second.blobOffsetField),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.shaderCache.stats.compiles, 1);
    assert.equal(executor.shaderCache.stats.hits, 1);
    assert.equal(find("createShaderModule").length, 0,
        "modules are only created when a pipeline needs them");
});

await test("HELLO's feature bits report which guest DLL is loaded", async () => {
    const { executor } = makeExecutor();
    // guest_pointer_bits / feature_bits / session_id_low / session_id_high.
    await executor.submit(buildBatch([
        command(OP.HELLO, u32(32, 3 /* SM2 | SM3 */, 0, 0)),
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.guestShaderModel2, true);
    assert.equal(executor.stats.guestShaderModel3, true);

    const stale = makeExecutor();
    await stale.executor.submit(buildBatch([
        command(OP.HELLO, u32(32, 0, 0, 0)),
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await stale.executor.idle();
    assert.equal(stale.executor.stats.guestShaderModel2, false,
        "a pre-M2 guest must be distinguishable from one that simply drew " +
        "no shaders");
    assert.equal(stale.executor.stats.guestShaderModel3, false);
});

await test("an empty client rect on Present keeps the last known surface size", async () => {
    const { executor } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CLEAR, u32(DEVICE, 1, 0xff102030, 0x3f800000, 0, 0)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    const surfaceChangesAfterFirst = executor.stats.surfaceChanges;
    // Fullscreen War3 reports 0x0 here; letting that through would resize the
    // overlay canvas every other frame.
    await executor.submit(buildBatch([
        command(OP.CLEAR, u32(DEVICE, 1, 0xff102030, 0x3f800000, 0, 0)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 0, 0)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.emptySurfaceReports, 1);
    assert.equal(executor.stats.surfaceChanges, surfaceChangesAfterFirst,
        "an empty rect must not count as a surface change");
    const state = executor.devices.get(DEVICE);
    assert.equal(state.surface.width, 640);
    assert.equal(state.surface.height, 480);
});

await test("a frame without Clear restores the previous D3D9 back buffer",
        async () => {
    const { executor, fake, find } = makeExecutor();
    // Establish the persistent image that the next Present must inherit.
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CLEAR, u32(DEVICE, 1, 0xff102030, 0x3f800000, 0, 0)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    const backBuffer = executor.backBufferTexture;
    assert.ok(backBuffer, "the back buffer is an executor-owned texture");
    assert.equal(executor.stats.backBufferAllocations, 1);
    const passCountAfterFirst =
        fake.calls.filter(call => call[0] === "beginRenderPass").length;

    await executor.submit(buildBatch([
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        // 3DMark06's loading loop follows this path: it changes a small part
        // of the already-presented image and deliberately does not Clear.
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.framesWithoutColorClear, 1);
    assert.equal(executor.stats.framesWithNoOps, 0);
    // The image is inherited because it is literally the same texture, not
    // because anything was copied back into a fresh canvas texture.
    assert.equal(executor.backBufferTexture, backBuffer,
        "the second frame must draw into the same owned texture");
    assert.equal(executor.stats.backBufferAllocations, 1,
        "no reallocation, so nothing to restore");
    const secondFramePasses = fake.calls
        .filter(call => call[0] === "beginRenderPass")
        .slice(passCountAfterFirst);
    assert.ok(secondFramePasses.length, "the draw must open a pass");
    assert.ok(secondFramePasses.every(call =>
        call[1].colorAttachments.every(attachment =>
            attachment.loadOp === "load")),
        "a frame that never Clears must load the existing image");
    // Present is the only place the swap chain is touched.
    const presented = find("copyTextureToTexture")
        .filter(call => call[1].texture === backBuffer);
    assert.equal(presented.length, 2, "one copy to the canvas per Present");
    assert.notEqual(presented[0][2].texture, backBuffer,
        "the copy target is the acquired swap-chain texture");
    assert.equal(executor.stats.backBufferPresents, 2);
});

await test("a dynamic buffer rewritten between draws does not corrupt the earlier draw", async () => {
    // The exact idiom that made War3's scene geometry explode: one shared
    // dynamic vertex buffer, refilled and drawn twice inside a single frame.
    // Draws are recorded and replayed at Present, while writeBuffer takes
    // effect in queue order -- so without renaming, both draws would read the
    // second batch of vertices.
    const { executor, fake, find } = makeExecutor();
    const batchA = Buffer.alloc(36, 0x11);
    const batchB = Buffer.alloc(36, 0x22);
    const updatePayload = (handle, byteCount) => {
        const payload = Buffer.alloc(24);
        payload.writeUInt32LE(handle, 0);
        payload.writeUInt32LE(0, 4);
        payload.writeUInt32LE(byteCount, 8);
        return payload;
    };
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 36)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.UPDATE_BUFFER, updatePayload(0x201, 36), batchA, 12),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.UPDATE_BUFFER, updatePayload(0x201, 36), batchB, 12),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();

    assert.equal(executor.stats.drawCalls, 2);
    assert.equal(executor.stats.bufferRenames, 1,
        "the second write must rename, not overwrite what draw 1 reads");

    // The two draws must end up bound to two different GPUBuffers.
    const pass = fake.calls.filter(c => c[0] === "beginRenderPass").pop()[2];
    const bound = pass.ops.filter(op => op[0] === "vertexBuffer").map(op => op[2]);
    assert.equal(bound.length, 2);
    assert.notEqual(bound[0], bound[1],
        "both draws are reading the same buffer, so the first one renders " +
        "the second one's vertices");

    // And each buffer must hold the batch its draw was issued with.
    const contentsOf = buffer => {
        const write = find("writeBuffer").filter(call => call[1] === buffer).pop();
        assert.ok(write, "no upload for a bound vertex buffer");
        return write[6][0]; // the snapshot taken at writeBuffer time
    };
    assert.equal(contentsOf(bound[0]), 0x11, "draw 1 lost its vertex data");
    assert.equal(contentsOf(bound[1]), 0x22, "draw 2 got the wrong vertex data");
});

await test("a buffer rewritten with no draw in between is updated in place", async () => {
    // Renaming must stay off the ordinary path: upload once, draw many.
    const { executor } = makeExecutor();
    const payload = Buffer.alloc(24);
    payload.writeUInt32LE(0x201, 0);
    payload.writeUInt32LE(0, 4);
    payload.writeUInt32LE(36, 8);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 36)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.UPDATE_BUFFER, payload, Buffer.alloc(36, 0x11), 12),
        command(OP.UPDATE_BUFFER, payload, Buffer.alloc(36, 0x22), 12),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.bufferRenames, 0,
        "no draw observed the first contents, so nothing needed renaming");
});

await test("a buffer rewritten in a later frame is updated in place", async () => {
    const { executor } = makeExecutor();
    const payload = Buffer.alloc(24);
    payload.writeUInt32LE(0x201, 0);
    payload.writeUInt32LE(0, 4);
    payload.writeUInt32LE(36, 8);
    const frame = data => buildBatch([
        command(OP.UPDATE_BUFFER, payload, data, 12),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true });
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 36)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
    ]));
    await executor.submit(frame(Buffer.alloc(36, 0x11)));
    await executor.submit(frame(Buffer.alloc(36, 0x22)));
    await executor.idle();
    assert.equal(executor.stats.drawCalls, 2);
    assert.equal(executor.stats.bufferRenames, 0,
        "the previous frame was already submitted; its draws cannot be " +
        "affected by this frame's writes");
});

await test("alpha test becomes a discard in both fixed-function and translated shaders", async () => {
    const D3DRS_ALPHATESTENABLE = 15, D3DRS_ALPHAREF = 24, D3DRS_ALPHAFUNC = 25;
    const D3DCMP_GREATEREQUAL = 7;
    const { executor, find } = makeExecutor();
    const ps = shaderCreatePayload(0x40000021, PS_BYTECODE);
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(0, 12, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD),
    ];
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0x401, 4, 4, 1, 21, 0, 1)),
        command(OP.SET_FVF, fvfPayload(0x102, elements)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x401, 0)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_ALPHATESTENABLE, 1, 0)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_ALPHAFUNC, D3DCMP_GREATEREQUAL, 0)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_ALPHAREF, 128, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        // Same draw with a translated pixel shader bound.
        command(OP.CREATE_PIXEL_SHADER, ps.payload, ps.blob, ps.blobOffsetField),
        command(OP.SET_PIXEL_SHADER, u32(DEVICE, 0x40000021)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);

    const pipelines = find("createRenderPipeline").map(call => call[1]);
    assert.equal(pipelines.length, 2);
    for (const pipeline of pipelines) {
        const code = pipeline.fragment.module.code;
        assert.ok(code.includes("discard;"),
            "alpha test did not emit a discard:\n" + code);
        // GREATEREQUAL passes when a >= ref, so the discard is its negation.
        assert.ok(code.includes("0.501961"),
            "alpha reference 128 should normalise to ~0.501961:\n" + code);
    }
});

await test("turning alpha test off again returns to the untested shader", async () => {
    const D3DRS_ALPHATESTENABLE = 15;
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_ALPHATESTENABLE, 1, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_ALPHATESTENABLE, 0, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    const pipelines = find("createRenderPipeline").map(call => call[1]);
    assert.equal(pipelines.length, 2, "the two states must not share a pipeline");
    // D3DCMP_ALWAYS is the default, so enabling alpha test without setting a
    // function is still a no-op -- the first draw must not gain a discard.
    assert.ok(!pipelines[0].fragment.module.code.includes("discard;"),
        "ALPHAFUNC defaults to ALWAYS, which tests nothing");
    assert.ok(!pipelines[1].fragment.module.code.includes("discard;"));
});

await test("the D3D9 hardware cursor is uploaded and composited over the frame", async () => {
    const { executor, fake, find } = makeExecutor();
    const size = 8;
    const bitmap = Buffer.alloc(size * size * 4, 0x80);
    const cursorProps = Buffer.alloc(32);
    cursorProps.writeUInt32LE(DEVICE, 0);
    cursorProps.writeUInt32LE(2, 4);   // hotspot x
    cursorProps.writeUInt32LE(3, 8);   // hotspot y
    cursorProps.writeUInt32LE(size, 12);
    cursorProps.writeUInt32LE(size, 16);
    cursorProps.writeUInt32LE(bitmap.length, 20);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CLEAR, u32(DEVICE, 1, 0xff102030, 0x3f800000, 0, 0)),
        command(0x21A, cursorProps, bitmap, 24),
        command(0x21B, u32(DEVICE, 100, 50, 0)),   // SET_CURSOR_POSITION
        command(0x21C, u32(DEVICE, 1)),            // SHOW_CURSOR
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();

    assert.equal(executor.stats.cursorUploads, 1);
    assert.equal(executor.stats.cursorDraws, 1);
    // The cursor gets its own final pass, loading the frame underneath.
    const passes = fake.calls.filter(c => c[0] === "beginRenderPass");
    const cursorPass = passes[passes.length - 1];
    assert.equal(cursorPass[1].colorAttachments[0].loadOp, "load",
        "the cursor pass must not clear the frame it sits on");
    assert.equal(cursorPass[1].depthStencilAttachment, undefined,
        "the cursor must not be depth-tested against the game's scene");
    assert.deepEqual(cursorPass[2].ops.filter(op => op[0] === "draw"),
        [["draw", 6]]);

    // Position is placed by the hotspot, in normalised back-buffer space.
    const rectWrite = find("writeBuffer")
        .filter(call => call[6] && call[6].byteLength === 16).pop();
    const rect = new Float32Array(rectWrite[6].buffer, rectWrite[6].byteOffset, 4);
    assert.ok(Math.abs(rect[0] - (100 - 2) / 640) < 1e-6, "cursor origin x");
    assert.ok(Math.abs(rect[1] - (50 - 3) / 480) < 1e-6, "cursor origin y");
    assert.ok(Math.abs(rect[2] - size / 640) < 1e-6, "cursor width");
});

await test("a hidden cursor is not composited", async () => {
    const { executor } = makeExecutor();
    const size = 4;
    const bitmap = Buffer.alloc(size * size * 4, 0xff);
    const cursorProps = Buffer.alloc(32);
    cursorProps.writeUInt32LE(DEVICE, 0);
    cursorProps.writeUInt32LE(size, 12);
    cursorProps.writeUInt32LE(size, 16);
    cursorProps.writeUInt32LE(bitmap.length, 20);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CLEAR, u32(DEVICE, 1, 0xff102030, 0x3f800000, 0, 0)),
        command(0x21A, cursorProps, bitmap, 24),
        command(0x21C, u32(DEVICE, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.submit(buildBatch([
        command(OP.CLEAR, u32(DEVICE, 1, 0xff102030, 0x3f800000, 0, 0)),
        command(0x21C, u32(DEVICE, 0)),  // ShowCursor(FALSE)
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.cursorUploads, 1);
    assert.equal(executor.stats.cursorDraws, 1, "only the visible frame draws it");
});

await test("the lock flags decide whether a mid-frame write has to rename", async () => {
    const D3DLOCK_NOOVERWRITE = 0x1000, D3DLOCK_DISCARD = 0x2000;
    const run = async lockFlags => {
        const { executor } = makeExecutor();
        const payload = Buffer.alloc(24);
        payload.writeUInt32LE(0x201, 0);
        payload.writeUInt32LE(0, 4);
        payload.writeUInt32LE(36, 8);
        payload.writeUInt32LE(lockFlags, 16);
        await executor.submit(buildBatch([
            command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
            command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 36)),
            command(OP.SET_FVF, fvfPayload(0x2,
                [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
            command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
            command(OP.UPDATE_BUFFER, payload, Buffer.alloc(36, 0x11), 12),
            command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
            command(OP.UPDATE_BUFFER, payload, Buffer.alloc(36, 0x22), 12),
            command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
            command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
        ], { present: true }));
        await executor.idle();
        return executor.stats;
    };

    // NOOVERWRITE is the application promising it is not touching bytes an
    // issued draw reads -- exactly the guarantee the hazard needs. Renaming
    // there is pure waste, and it is the idiom that made War3 rename ~277
    // times a frame.
    const noOverwrite = await run(D3DLOCK_NOOVERWRITE);
    assert.equal(noOverwrite.bufferRenames, 0);
    assert.equal(noOverwrite.bufferNoOverwriteWrites, 1);

    // DISCARD renames, but the replacement only carries the bytes being
    // written now: the rest is contents the application has abandoned.
    const discard = await run(D3DLOCK_DISCARD);
    assert.equal(discard.bufferRenames, 1);
    assert.equal(discard.bufferFullCopyRenames, 0);

    // A plain lock keeps the old contents readable, so the whole shadow has
    // to be copied forward. Correct, and the only case that costs that.
    const plain = await run(0);
    assert.equal(plain.bufferRenames, 1);
    assert.equal(plain.bufferFullCopyRenames, 1);
});

// The D3D8 frontend sends WINDOW_STATE on move/size/show because a title that
// draws one frame and then only pumps messages has no further Present to carry
// its geometry. If the host only logged it, the overlay would stay where the
// window used to be.
await test("window state moves the overlay for a title that stops presenting",
        async () => {
    const surfaces = [];
    const { executor } = makeExecutor({
        onSurface: (surface, reason) => surfaces.push({ ...surface, reason }) });
    const windowState = (flags, x, y, width, height) => {
        const payload = Buffer.alloc(40);
        payload.writeUInt32LE(DEVICE, 0);
        payload.writeUInt32LE(0xa0180, 4);
        payload.writeUInt32LE(0xa0180, 8);   // foreground is the game itself
        payload.writeUInt32LE(flags, 12);
        payload.writeInt32LE(x, 16);
        payload.writeInt32LE(y, 20);
        payload.writeUInt32LE(width, 24);
        payload.writeUInt32LE(height, 28);
        payload.writeUInt32LE(width, 32);    // client width
        payload.writeUInt32LE(height, 36);   // client height
        return payload;
    };
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.PRESENT, u32(DEVICE, 0xa0180, 10, 20, 640, 480)),
    ], { present: true }));
    await executor.idle();
    const afterPresent = executor.stats.surfaceChanges;

    // IS_WINDOW | VISIBLE | FOREGROUND, moved to a new origin.
    await executor.submit(buildBatch([
        command(0x21D, windowState(1 | 2 | 8, 100, 200, 640, 480)),
    ]));
    await executor.idle();
    assert.equal(executor.stats.surfaceChanges, afterPresent + 1,
        "a move with no Present must still reposition the overlay");
    const moved = surfaces[surfaces.length - 1];
    assert.equal(moved.reason, "window-state");
    assert.equal(moved.x, 100);
    assert.equal(moved.y, 200);
    assert.equal(moved.visible, true);

    // Repeating the identical report must not churn the canvas.
    await executor.submit(buildBatch([
        command(0x21D, windowState(1 | 2 | 8, 100, 200, 640, 480)),
    ]));
    await executor.idle();
    assert.equal(executor.stats.surfaceChanges, afterPresent + 1,
        "an unchanged window report must not re-notify");

    // Minimised: hide rather than move.
    await executor.submit(buildBatch([
        command(0x21D, windowState(1 | 2 | 4 | 8, 100, 200, 640, 480)),
    ]));
    await executor.idle();
    assert.equal(surfaces[surfaces.length - 1].visible, false,
        "a minimised window hides the overlay");
});

// Other guest windows over the device window (Warcraft III's cinematic popup,
// a message box) are state the surface keeps until the guest reports again: a
// Present meanwhile does not uncover anything.
await test("window state reports covered windows and the parts that show", async () => {
    const surfaces = [];
    const { executor } = makeExecutor({
        onSurface: (surface, reason) => surfaces.push({ ...surface, reason }) });
    const windowState = (flags, rects) => {
        const payload = Buffer.alloc(40 + (rects ? 4 + rects.length * 16 : 0));
        payload.writeUInt32LE(DEVICE, 0);
        payload.writeUInt32LE(0xa0180, 4);
        payload.writeUInt32LE(0xa0180, 8);
        payload.writeUInt32LE(flags | (rects ? 1 << 7 : 0), 12);
        payload.writeInt32LE(10, 16);        // client origin
        payload.writeInt32LE(20, 20);
        payload.writeUInt32LE(648, 24);      // window, frame included
        payload.writeUInt32LE(507, 28);
        payload.writeUInt32LE(640, 32);      // client
        payload.writeUInt32LE(480, 36);
        if (rects) {
            payload.writeUInt32LE(rects.length, 40);
            rects.forEach((r, i) => r.forEach((v, j) => payload.writeInt32LE(v, 44 + i * 16 + j * 4)));
        }
        return payload;
    };
    const last = () => surfaces[surfaces.length - 1];
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.PRESENT, u32(DEVICE, 0xa0180, 10, 20, 640, 480)),
    ], { present: true }));
    await executor.idle();

    // IS_WINDOW | VISIBLE | FOREGROUND | OCCLUDED
    await executor.submit(buildBatch([command(0x21D, windowState(1 | 2 | 8 | 64))]));
    await executor.idle();
    assert.equal(last().visible, true, "a covered window is still up");
    assert.equal(last().occluded, true);
    await executor.submit(buildBatch([
        command(OP.PRESENT, u32(DEVICE, 0xa0180, 10, 20, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.devices.get(DEVICE).surface.occluded, true,
        "presenting behind the popup does not uncover the window");

    // A message box over the middle: the bands around it show
    const bands = [[0, 0, 640, 200], [0, 200, 220, 280], [420, 200, 640, 280], [0, 280, 640, 480]];
    await executor.submit(buildBatch([command(0x21D, windowState(1 | 2 | 8, bands))]));
    await executor.idle();
    assert.equal(last().occluded, false);
    assert.deepEqual(last().visibleRegion, {
        rects: bands.map(([left, top, right, bottom]) => ({ left, top, right, bottom })),
        baseWidth: 640, baseHeight: 480, originX: 10, originY: 20 });
    assert.equal(executor.stats.windowRegionReports, 1);
    const changes = executor.stats.surfaceChanges;
    await executor.submit(buildBatch([command(0x21D, windowState(1 | 2 | 8, bands))]));
    await executor.idle();
    assert.equal(executor.stats.surfaceChanges, changes, "the same region again changes nothing");

    // The box closes
    await executor.submit(buildBatch([command(0x21D, windowState(1 | 2 | 8))]));
    await executor.idle();
    assert.equal(last().visibleRegion, null, "all of the window shows again");
    assert.equal(last().occluded, false);

    // A region that does not fit the record is ignored rather than misread
    const truncated = windowState(1 | 2 | 8, bands).subarray(0, 60);
    await executor.submit(buildBatch([command(0x21D, truncated)]));
    await executor.idle();
    assert.equal(executor.devices.get(DEVICE).surface.visibleRegion, null);
});

await test("window state reports a game whose window cannot receive input", async () => {
    const { executor } = makeExecutor();
    const windowState = (flags) => {
        const payload = Buffer.alloc(40);
        payload.writeUInt32LE(DEVICE, 0);
        payload.writeUInt32LE(0xa0180, 4);   // hwnd
        payload.writeUInt32LE(0xb1234, 8);   // foreground hwnd (someone else)
        payload.writeUInt32LE(flags, 12);
        payload.writeUInt32LE(800, 24);
        payload.writeUInt32LE(600, 28);
        return payload;
    };
    // IS_WINDOW | VISIBLE | FULLSCREEN, but not FOREGROUND.
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(0x21D, windowState(1 | 2 | 16)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    const stats = executor.getStats();
    assert.equal(stats.windowStateChanges, 1);
    assert.equal(stats.window.isWindow, true);
    assert.equal(stats.window.fullscreen, true);
    assert.equal(stats.window.foreground, false,
        "a game that is not the foreground window is exactly the case this " +
        "report exists to make visible");
    assert.equal(stats.window.hwnd, 0xa0180);
    assert.notEqual(stats.window.foregroundHwnd, stats.window.hwnd);
});

await test("the stage-0 texture matrix transforms fixed-function texcoords", async () => {
    const D3DTSS_TEXTURETRANSFORMFLAGS = 24, D3DTTFF_COUNT2 = 2;
    const D3DTS_TEXTURE0 = 16;
    const { executor, find } = makeExecutor();
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(0, 12, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD),
    ];
    // A scrolling matrix: D3D9 games put the offset in row 3 (_31/_32) for
    // COUNT2, because the coordinate enters as the row vector (u, v, 1, 1).
    const scroll = [1, 0, 0, 0, 0, 1, 0, 0, 0.25, 0.5, 1, 0, 0, 0, 0, 1];
    const transform = Buffer.alloc(72);
    transform.writeUInt32LE(DEVICE, 0);
    transform.writeUInt32LE(D3DTS_TEXTURE0, 4);
    scroll.forEach((value, index) => transform.writeFloatLE(value, 8 + index * 4));
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0x401, 4, 4, 1, 21, 0, 1)),
        command(OP.SET_FVF, fvfPayload(0x102, elements)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x401, 0)),
        command(OP.SET_TRANSFORM, transform),
        // This test isolates texture transforms; keep the vertex uniform layout
        // independent of D3D9's default-enabled fixed-function lighting.
        command(OP.SET_RENDER_STATE, u32(DEVICE, 137 /* D3DRS_LIGHTING */, 0, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(0x202, u32(DEVICE, 0, D3DTSS_TEXTURETRANSFORMFLAGS, D3DTTFF_COUNT2)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);

    const pipelines = find("createRenderPipeline").map(call => call[1]);
    assert.equal(pipelines.length, 2,
        "enabling the transform must not reuse the untransformed pipeline");
    assert.ok(!pipelines[0].vertex.module.code.includes("texture_transform0 *"),
        "the first draw has D3DTTFF_DISABLE and must pass texcoords through");
    assert.ok(pipelines[1].vertex.module.code.includes("texture_transform0 *"),
        "the second draw must apply the matrix:\n" + pipelines[1].vertex.module.code);
    // Entering as (u, v, 1, 1) is what puts the game's offset in row 3.
    assert.ok(pipelines[1].vertex.module.code.includes(".xy, 1.0, 1.0)"),
        "the coordinate must enter the matrix as (u, v, 1, 1)");

    // And the matrix has to actually reach the uniform, after the WVP,
    // viewport and padding.
    const bindGroup = find("createBindGroup").pop()[1];
    const block = constantBlock(find, bindGroup.entries[0].resource.buffer);
    const data = new Float32Array(block.buffer, block.byteOffset, 36);
    assert.deepEqual([...data.slice(20, 36)], scroll);
});

await test("fixed-function fog tints the fragment towards D3DRS_FOGCOLOR", async () => {
    const D3DRS_FOGENABLE = 28, D3DRS_FOGCOLOR = 34, D3DRS_FOGTABLEMODE = 35;
    const D3DRS_FOGSTART = 36, D3DRS_FOGEND = 37;
    const D3DFOG_LINEAR = 3;
    const floatBitsOf = value => {
        const buffer = new ArrayBuffer(4);
        new Float32Array(buffer)[0] = value;
        return new Uint32Array(buffer)[0];
    };
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        // This test isolates fog and asserts exact uniform offsets.
        command(OP.SET_RENDER_STATE, u32(DEVICE, 137 /* D3DRS_LIGHTING */, 0, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_FOGENABLE, 1, 0)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_FOGTABLEMODE, D3DFOG_LINEAR, 0)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_FOGCOLOR, 0x00405060, 0)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_FOGSTART, floatBitsOf(10), 0)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_FOGEND, floatBitsOf(200), 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);

    const pipelines = find("createRenderPipeline").map(call => call[1]);
    assert.equal(pipelines.length, 2, "fog must not reuse the unfogged pipeline");
    assert.ok(!pipelines[0].fragment.module.code.includes("mix(uniforms.fog_color"),
        "the pre-fog draw must not blend");
    assert.ok(!pipelines[1].vertex.module.code.includes("fog_distance"),
        "table fog must not be reduced to a per-vertex factor");
    assert.ok(pipelines[1].fragment.module.code.includes(
        "fog_distance = 1.0 / max(abs(stage_in.position.w), 1e-6)"),
        "W table fog must recover clip W and evaluate per fragment:\n" +
        pipelines[1].fragment.module.code);
    assert.ok(pipelines[1].fragment.module.code.includes("mix(uniforms.fog_color"),
        "the pixel stage must blend towards the fog colour");

    // The fixed-function pixel stage has no register file, so binding 1 carries
    // the fog colour and, for table fog, its distance parameters.
    const layout = find("createBindGroupLayout").pop()[1];
    assert.ok(layout.entries.some(entry => entry.binding === 1),
        "the fog colour needs its own pixel-stage uniform binding");

    const bindGroup = find("createBindGroup").pop()[1];
    const pixelEntry = bindGroup.entries.find(entry => entry.binding === 1);
    const block = constantBlock(find, pixelEntry.resource.buffer);
    const data = new Float32Array(block.buffer, block.byteOffset);
    const fog = data.subarray(pixelEntry.resource.offset / 4,
        pixelEntry.resource.offset / 4 + 3);
    assert.deepEqual([...fog].map(v => Math.round(v * 255)), [0x40, 0x50, 0x60],
        "D3DRS_FOGCOLOR is 0x00RRGGBB and must reach the shader as RGB");

    // FOGSTART/FOGEND are float bits inside a DWORD, not integers.
    // Table fog evaluates in the fragment stage, so the parameters immediately
    // follow fog_color in the fixed pixel block.
    const pixelBase = pixelEntry.resource.offset / 4;
    assert.equal(data[pixelBase + 4], 10, "FOGSTART decoded as float bits");
    assert.equal(data[pixelBase + 5], 200, "FOGEND decoded as float bits");
});

await test("table fog with a translated VS uses fragment W instead of oFog",
        async () => {
    const D3DRS_FOGENABLE = 28, D3DRS_FOGTABLEMODE = 35;
    const D3DFOG_LINEAR = 3;
    const { executor, find } = makeExecutor();
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(0, 12, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD),
    ];
    const vs = shaderCreatePayload(0x40000016, VS_TEXCOORD0_BYTECODE);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0x401, 4, 4, 1, 21, 0, 1)),
        command(OP.CREATE_VERTEX_DECLARATION, declarationPayload(0x301, elements)),
        command(OP.CREATE_VERTEX_SHADER, vs.payload, vs.blob, vs.blobOffsetField),
        command(OP.SET_VERTEX_DECLARATION, u32(DEVICE, 0x301)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.SET_VERTEX_SHADER, u32(DEVICE, 0x40000016)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x401, 0)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_FOGENABLE, 1, 0)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_FOGTABLEMODE,
            D3DFOG_LINEAR, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();

    assert.equal(executor.stats.droppedDraws, 0);
    const pipeline = find("createRenderPipeline").pop()[1];
    assert.ok(pipeline.fragment.module.code.includes("mix(uniforms.fog_color"),
        "fixed-function fog remains enabled for the mixed VS/FF pixel path");
    assert.ok(pipeline.fragment.module.code.includes(
        "fog_distance = 1.0 / max(abs(stage_in.position.w), 1e-6)"),
        "table fog must be evaluated from per-fragment W");
    assert.ok(!pipeline.fragment.module.code.includes(
        "clamp(stage_in.varying10.x"),
        "table fog must ignore a programmable VS oFog output");
});

await test("vertex fog with a translated VS still consumes oFog", async () => {
    const D3DRS_FOGENABLE = 28, D3DRS_FOGVERTEXMODE = 140;
    const D3DFOG_LINEAR = 3;
    const { executor, find } = makeExecutor();
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(0, 12, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD),
    ];
    const vs = shaderCreatePayload(0x40000017, VS_TEXCOORD0_BYTECODE);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0x401, 4, 4, 1, 21, 0, 1)),
        command(OP.CREATE_VERTEX_DECLARATION, declarationPayload(0x301, elements)),
        command(OP.CREATE_VERTEX_SHADER, vs.payload, vs.blob, vs.blobOffsetField),
        command(OP.SET_VERTEX_DECLARATION, u32(DEVICE, 0x301)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.SET_VERTEX_SHADER, u32(DEVICE, 0x40000017)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x401, 0)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_FOGENABLE, 1, 0)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_FOGVERTEXMODE,
            D3DFOG_LINEAR, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();

    assert.equal(executor.stats.droppedDraws, 0);
    const pipeline = find("createRenderPipeline").pop()[1];
    assert.ok(pipeline.fragment.module.code.includes(
        "clamp(stage_in.varying10.x"),
        "vertex fog must consume the VS oFog varying");
    assert.ok(!pipeline.fragment.module.code.includes("let fog_distance"),
        "vertex fog must not be replaced by table fog");
    assert.ok(pipeline.vertex.module.code.includes(
        "o_varying10: vec4<f32> = vec4<f32>(1.0, 0.0, 0.0, 0.0);"),
        "an unwritten oFog defaults to factor one for vertex fog");
});

await test("table and vertex fog do not collide in the shader cache", async () => {
    const D3DRS_FOGENABLE = 28, D3DRS_FOGTABLEMODE = 35;
    const D3DRS_FOGVERTEXMODE = 140, D3DRS_LIGHTING = 137;
    const D3DFOG_NONE = 0, D3DFOG_LINEAR = 3;
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_LIGHTING, 0, 0)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_FOGENABLE, 1, 0)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_FOGTABLEMODE,
            D3DFOG_LINEAR, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_FOGTABLEMODE,
            D3DFOG_NONE, 0)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_FOGVERTEXMODE,
            D3DFOG_LINEAR, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();

    assert.equal(executor.stats.droppedDraws, 0);
    const pipelines = find("createRenderPipeline").map(call => call[1]);
    assert.equal(pipelines.length, 2);
    assert.ok(pipelines[0].fragment.module.code.includes("let fog_distance"),
        "the table-fog fragment module must use fragment W");
    assert.ok(!pipelines[0].vertex.module.code.includes("let fog_distance"),
        "table fog must not run in the vertex shader");
    assert.ok(pipelines[1].fragment.module.code.includes(
        "clamp(stage_in.varying10.x"),
        "the vertex-fog fragment module must consume oFog");
    assert.ok(pipelines[1].vertex.module.code.includes("let fog_distance"),
        "fixed-function vertex fog must be computed in the vertex shader");
});

await test("a malformed batch is rejected rather than half-executed", async () => {
    const { executor } = makeExecutor();
    const batch = buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
    ]);
    batch.writeUInt32LE(0xffffffff, 20); // command_bytes past the record
    await executor.submit(batch);
    await executor.idle();
    assert.ok(executor.failed, "an overrunning command_bytes must fail the batch");
    assert.equal(executor.stats.malformedBatches, 1);
});

await test("shader bytecode that overruns the batch is rejected", async () => {
    const { executor } = makeExecutor();
    const vs = shaderCreatePayload(0x40000015, VS_BYTECODE);
    const batch = buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_VERTEX_SHADER, vs.payload, vs.blob, vs.blobOffsetField),
    ]);
    // Claim far more tokens than the batch can hold.
    const commandOffset = batch.indexOf(vs.payload, 32);
    batch.writeUInt32LE(0x10000, commandOffset + 8);
    await executor.submit(batch);
    await executor.idle();
    assert.ok(executor.failed, "an overrunning token count must fail the batch");
});

// ---- M3: fixed-function lighting and the texture-blending cascade ----

const D3DRS = {
    LIGHTING: 137, AMBIENT: 139, SPECULARENABLE: 29, COLORVERTEX: 141,
    NORMALIZENORMALS: 143, TEXTUREFACTOR: 60, SCISSORTESTENABLE: 174,
    DIFFUSEMATERIALSOURCE: 145, VERTEXBLEND: 151,
    INDEXEDVERTEXBLENDENABLE: 167,
};
const D3DVBF = { DISABLE: 0, ONE: 1, TWO: 2, THREE: 3, TWEENING: 255,
    ZERO: 256 };
const D3DTSS = {
    COLOROP: 1, COLORARG1: 2, COLORARG2: 3, ALPHAOP: 4, ALPHAARG1: 5,
    ALPHAARG2: 6, TEXCOORDINDEX: 11, TEXTURETRANSFORMFLAGS: 24,
    COLORARG0: 26, RESULTARG: 28, CONSTANT: 32,
};
const D3DTOP = {
    DISABLE: 1, SELECTARG1: 2, SELECTARG2: 3, MODULATE: 4, ADD: 7,
    ADDSIGNED: 8, BLENDTEXTUREALPHA: 13, DOTPRODUCT3: 24, MULTIPLYADD: 25,
    LERP: 26, PREMODULATE: 17, MODULATEALPHA_ADDCOLOR: 18,
    MODULATECOLOR_ADDALPHA: 19, MODULATEINVALPHA_ADDCOLOR: 20,
    MODULATEINVCOLOR_ADDALPHA: 21,
};
const D3DTA = { DIFFUSE: 0, CURRENT: 1, TEXTURE: 2, TFACTOR: 3, SPECULAR: 4,
    TEMP: 5, CONSTANT: 6, COMPLEMENT: 0x10, ALPHAREPLICATE: 0x20 };

function materialPayload(diffuse, ambient, specular, emissive, power) {
    const payload = Buffer.alloc(72);
    payload.writeUInt32LE(DEVICE, 0);
    [...diffuse, ...ambient, ...specular, ...emissive].forEach((value, index) =>
        payload.writeFloatLE(value, 4 + index * 4));
    payload.writeFloatLE(power, 68);
    return payload;
}

function lightPayload(index, type, options = {}) {
    const payload = Buffer.alloc(112);
    payload.writeUInt32LE(DEVICE, 0);
    payload.writeUInt32LE(index, 4);
    payload.writeUInt32LE(type, 8);
    const diffuse = options.diffuse || [1, 1, 1, 1];
    const specular = options.specular || [1, 1, 1, 1];
    const ambient = options.ambient || [0, 0, 0, 0];
    [...diffuse, ...specular, ...ambient].forEach((value, i) =>
        payload.writeFloatLE(value, 12 + i * 4));
    (options.position || [0, 0, 0]).forEach((value, i) =>
        payload.writeFloatLE(value, 60 + i * 4));
    (options.direction || [0, 0, 1]).forEach((value, i) =>
        payload.writeFloatLE(value, 72 + i * 4));
    payload.writeFloatLE(options.range === undefined ? 1000 : options.range, 84);
    payload.writeFloatLE(options.falloff === undefined ? 1 : options.falloff, 88);
    (options.attenuation || [1, 0, 0]).forEach((value, i) =>
        payload.writeFloatLE(value, 92 + i * 4));
    payload.writeFloatLE(options.theta === undefined ? 0.5 : options.theta, 104);
    payload.writeFloatLE(options.phi === undefined ? 1.0 : options.phi, 108);
    return payload;
}

function transformPayload(state, matrix) {
    const payload = Buffer.alloc(72);
    payload.writeUInt32LE(DEVICE, 0);
    payload.writeUInt32LE(state, 4);
    matrix.forEach((value, index) => payload.writeFloatLE(value, 8 + index * 4));
    return payload;
}

// ---- fixed-function vertex blending (D3DRS_VERTEXBLEND) ----
//
// The bug these cover: a skinned mesh whose every vertex was posed by world
// matrix 0 renders in bind pose -- rigid, in the right place, fully lit. It
// looks like a working draw, which is why it survived so long, and why these
// assert on the *matrices reaching the block* and not merely on the draw
// succeeding.

// Two world matrices whose translations differ in every component, so a vertex
// posed by the wrong one, or by their unweighted average, lands somewhere no
// other mistake would put it.
const WORLD0 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1];
const WORLD1 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 40, 50, 60, 1];
const WORLD2 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 700, 800, 900, 1];

function blendedVertexUniforms(find) {
    const bindGroup = find("createBindGroup").pop()[1];
    const block = constantBlock(find, bindGroup.entries[0].resource.buffer);
    return new Float32Array(block.buffer, block.byteOffset);
}

await test("D3DRS_VERTEXBLEND poses a vertex by several world matrices",
        async () => {
    const { executor, find } = makeExecutor();
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(0, 12, DECLTYPE.FLOAT1, DECLUSAGE.BLENDWEIGHT),
    ];
    const projection = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1];
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 160)),
        command(OP.SET_FVF, fvfPayload(0, elements)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 16)),
        command(OP.SET_TRANSFORM, transformPayload(256, WORLD0)),
        command(OP.SET_TRANSFORM, transformPayload(257, WORLD1)),
        command(OP.SET_TRANSFORM, transformPayload(3, projection)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS.VERTEXBLEND, D3DVBF.ONE, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);
    assert.equal(executor.stats.blendedDraws, 1, "the draw must be blended");
    assert.equal(executor.stats.drawsWithUnappliedVertexBlend, 0);

    const pipeline = find("createRenderPipeline").pop()[1];
    const wgsl = pipeline.vertex.module.code;
    assert.ok(wgsl.includes("blend_worlds: array<mat4x4<f32>, 2>"),
        "D3DVBF_1WEIGHTS names one weight and therefore two matrices:\n" + wgsl);
    assert.ok(wgsl.includes("uniforms.blend_worlds[0u]") &&
        wgsl.includes("uniforms.blend_worlds[1u]"),
        "an unindexed blend takes its matrices in order");
    // The last weight is D3D9's leftover, not a second attribute component.
    assert.ok(wgsl.includes("let d9_blend_last = 1.0 - (in13.x);"),
        "the final matrix takes 1 - sum(the supplied weights)");
    assert.ok(wgsl.includes("uniforms.view_projection * d9_blend_position"),
        "a blended draw may not pre-multiply the world matrix");
    assert.ok(!wgsl.includes("world_view_projection"),
        "world_view_projection would silently re-apply world matrix 0");
    // BLENDWEIGHT has to actually be fetched, or the shader reads garbage.
    const byLocation = new Map(pipeline.vertex.buffers[0].attributes
        .map(a => [a.shaderLocation, a]));
    assert.equal(byLocation.get(13).offset, 12, "BLENDWEIGHT belongs at 13");
    assert.equal(byLocation.get(13).format, "float32");

    // view_projection(16) viewport(4) blend_worlds(2 * 16)
    const data = blendedVertexUniforms(find);
    assert.deepEqual([...data.slice(0, 16)], projection,
        "with an identity view, view_projection is the projection alone");
    assert.deepEqual([...data.slice(20, 36)], WORLD0);
    assert.deepEqual([...data.slice(36, 52)], WORLD1);
});

await test("indexed vertex blending reads BLENDINDICES as an integer attribute",
        async () => {
    const { executor, find } = makeExecutor();
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(0, 12, DECLTYPE.FLOAT3, DECLUSAGE.NORMAL),
        element(0, 24, DECLTYPE.FLOAT2, DECLUSAGE.BLENDWEIGHT),
        element(0, 32, DECLTYPE.UBYTE4, DECLUSAGE.BLENDINDICES),
    ];
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 216)),
        command(OP.SET_FVF, fvfPayload(0, elements)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 36)),
        command(OP.SET_TRANSFORM, transformPayload(256, WORLD0)),
        command(OP.SET_TRANSFORM, transformPayload(257, WORLD1)),
        command(OP.SET_TRANSFORM, transformPayload(258, WORLD2)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS.VERTEXBLEND, D3DVBF.TWO, 0)),
        command(OP.SET_RENDER_STATE,
            u32(DEVICE, D3DRS.INDEXEDVERTEXBLENDENABLE, 1, 0)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS.LIGHTING, 1, 0)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS.NORMALIZENORMALS, 1, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);
    assert.equal(executor.stats.blendedDraws, 1);

    const pipeline = find("createRenderPipeline").pop()[1];
    const wgsl = pipeline.vertex.module.code;
    // UBYTE4 is uint8x4, an integer format: WebGPU rejects a pipeline whose
    // WGSL declares that location as f32, so the base type has to follow the
    // declaration's D3DDECLTYPE rather than the vec4<f32> everything else uses.
    assert.ok(wgsl.includes("@location(14) in14: vec4<u32>"),
        "BLENDINDICES must be declared with its format's base type:\n" + wgsl);
    assert.ok(wgsl.includes("uniforms.blend_worlds[d9_blend_index.x]") &&
        wgsl.includes("uniforms.blend_worlds[d9_blend_index.z]"),
        "an indexed blend selects each slot's matrix per vertex");
    assert.ok(/min\(in14,\s*vec4<u32>\(\d+u\)\)/.test(wgsl),
        "an out-of-range index has no defined uniform read, so clamp it");
    // The palette is sized from the highest matrix the guest has set (2), then
    // rounded up to a bucket so adding a bone does not mint a new pipeline.
    assert.ok(wgsl.includes("blend_worlds: array<mat4x4<f32>, 4>"),
        "three world matrices set must round up to the 4-entry bucket");
    // The blended normal must go through the blend, and then through the view
    // half only -- normal_matrix no longer carries the world half.
    assert.ok(wgsl.includes("vec4<f32>(d9_blend_normal, 0.0)"),
        "the normal has to ride the same blend as the position");

    const byLocation = new Map(pipeline.vertex.buffers[0].attributes
        .map(a => [a.shaderLocation, a]));
    assert.equal(byLocation.get(14).format, "uint8x4");
    assert.equal(byLocation.get(14).offset, 32);

    // view_projection(16) viewport(4) blend_worlds(4 * 16) view_matrix(16)
    const data = blendedVertexUniforms(find);
    assert.deepEqual([...data.slice(20, 36)], WORLD0);
    assert.deepEqual([...data.slice(36, 52)], WORLD1);
    assert.deepEqual([...data.slice(52, 68)], WORLD2);
    // The unset fourth palette entry is identity, not leftover memory.
    assert.deepEqual([...data.slice(68, 84)],
        [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
});

await test("D3DCOLOR blend indices are scaled back from unorm", async () => {
    // D3DFVF_LASTBETA_D3DCOLOR is the FVF spelling of "the last beta DWORD
    // holds matrix indices", and D3DCOLOR maps to unorm8x4 -- so the shader
    // receives index 2 as 2/255, not as 2. Truncating that selects bone 0 for
    // every vertex, which is bind pose again, arrived at by a different route.
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 144)),
        command(OP.SET_FVF, fvfPayload(0, [
            element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
            element(0, 12, DECLTYPE.FLOAT1, DECLUSAGE.BLENDWEIGHT),
            element(0, 16, DECLTYPE.D3DCOLOR, DECLUSAGE.BLENDINDICES)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.SET_TRANSFORM, transformPayload(256, WORLD0)),
        command(OP.SET_TRANSFORM, transformPayload(257, WORLD1)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS.VERTEXBLEND, D3DVBF.ONE, 0)),
        command(OP.SET_RENDER_STATE,
            u32(DEVICE, D3DRS.INDEXEDVERTEXBLENDENABLE, 1, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.blendedDraws, 1);
    const pipeline = find("createRenderPipeline").pop()[1];
    const wgsl = pipeline.vertex.module.code;
    assert.ok(wgsl.includes("@location(14) in14: vec4<f32>"),
        "unorm8x4 is a float format:\n" + wgsl);
    assert.ok(wgsl.includes("round(in14 * 255.0)"),
        "the index bytes have to be scaled back, and rounded not truncated");
    // No .bgra here: the swizzle a D3DCOLOR *colour* needs would reverse the
    // index order, since these bytes are indices in memory order, not channels.
    assert.ok(!wgsl.includes("in14.bgra"),
        "blend indices are bytes in order, not colour channels");
    const byLocation = new Map(pipeline.vertex.buffers[0].attributes
        .map(a => [a.shaderLocation, a]));
    assert.equal(byLocation.get(14).format, "unorm8x4");
});

await test("blend data with D3DRS_VERTEXBLEND disabled is ignored, as D3D9 does",
        async () => {
    // Engines share one declaration between their skinned and unskinned passes,
    // so blend elements are present far more often than blending is on. D3D9
    // poses those draws by D3DTS_WORLD alone; so must this. The counter is what
    // keeps the case visible without a warning that would fire every frame.
    const { executor, find } = makeExecutor();
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(0, 12, DECLTYPE.FLOAT1, DECLUSAGE.BLENDWEIGHT),
        element(0, 16, DECLTYPE.UBYTE4, DECLUSAGE.BLENDINDICES),
    ];
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 120)),
        command(OP.SET_FVF, fvfPayload(0, elements)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.SET_TRANSFORM, transformPayload(256, WORLD0)),
        command(OP.SET_TRANSFORM, transformPayload(257, WORLD1)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);
    assert.equal(executor.stats.blendedDraws, 0);
    assert.equal(executor.stats.drawsWithUnappliedVertexBlend, 1,
        "ignored-but-present skinning data stays countable");

    const pipeline = find("createRenderPipeline").pop()[1];
    const wgsl = pipeline.vertex.module.code;
    assert.ok(wgsl.includes("uniforms.world_view_projection * in0"),
        "an unblended draw keeps the folded matrix chain:\n" + wgsl);
    assert.ok(!wgsl.includes("blend_worlds"), "no palette is uploaded");
    // A vertex attribute the shader never declares is a pipeline the driver
    // may reject, so the layout has to drop them too.
    const locations = pipeline.vertex.buffers[0].attributes
        .map(a => a.shaderLocation);
    assert.deepEqual(locations, [0],
        "unread skinning attributes must stay out of the vertex layout");
});

await test("vertex blending falls back when the declaration cannot supply it",
        async () => {
    // D3DRS_VERTEXBLEND on, but nothing to blend with: D3D9's result is
    // undefined, so posing by world matrix 0 and saying so beats inventing one.
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 72)),
        command(OP.SET_FVF, fvfPayload(0x2, [
            element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.SET_TRANSFORM, transformPayload(256, WORLD0)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS.VERTEXBLEND, D3DVBF.TWO, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0, "the draw still renders");
    assert.equal(executor.stats.blendedDraws, 0);
    const wgsl = find("createRenderPipeline").pop()[1].vertex.module.code;
    assert.ok(!wgsl.includes("blend_worlds"),
        "a blend with no weights must not be attempted:\n" + wgsl);
});

await test("pre-transformed vertices are never blended", async () => {
    // XYZRHW geometry has already been through the whole transform pipeline, so
    // there is nothing for a world matrix to pose -- D3D9 ignores VERTEXBLEND
    // for it, and a blend applied here would move UI off screen.
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 120)),
        command(OP.SET_FVF, fvfPayload(0x4, [
            element(0, 0, DECLTYPE.FLOAT4, DECLUSAGE.POSITIONT),
            element(0, 16, DECLTYPE.FLOAT1, DECLUSAGE.BLENDWEIGHT)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.SET_TRANSFORM, transformPayload(256, WORLD0)),
        command(OP.SET_TRANSFORM, transformPayload(257, WORLD1)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS.VERTEXBLEND, D3DVBF.ONE, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.blendedDraws, 0);
    const wgsl = find("createRenderPipeline").pop()[1].vertex.module.code;
    assert.ok(!wgsl.includes("blend_worlds"),
        "XYZRHW must keep its screen-space path:\n" + wgsl);
    assert.ok(wgsl.includes("let ndc_x"), "and still be mapped through NDC");
});

await test("pre-transformed vertices survive stale camera-space texgen",
        async () => {
    // Exact state shape from 3DMark 2001 test 16: an XYZRHW+DIFFUSE stream has
    // no normal or texcoord, while stage 0 still asks for the camera-space
    // reflection vector and a COUNT3 texture transform. The generated value
    // is undefined, but compiling an identifier that was never declared drops
    // the draw and invalidates the rest of the WebGPU command buffer.
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 120)),
        command(OP.SET_FVF, fvfPayload(0x104, [
            element(0, 0, DECLTYPE.FLOAT4, DECLUSAGE.POSITIONT),
            element(0, 16, DECLTYPE.D3DCOLOR, DECLUSAGE.COLOR)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.SET_TEXTURE_STAGE_STATE,
            u32(DEVICE, 0, D3DTSS.TEXCOORDINDEX, 0x30000)),
        command(OP.SET_TEXTURE_STAGE_STATE,
            u32(DEVICE, 0, D3DTSS.TEXTURETRANSFORMFLAGS, 3)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();

    assert.equal(executor.stats.droppedDraws, 0, "the draw remains encodable");
    const wgsl = find("createRenderPipeline").pop()[1].vertex.module.code;
    assert.ok(!wgsl.includes("position_view"),
        "XYZRHW must not read an unavailable view-space position:\n" + wgsl);
    assert.ok(!wgsl.includes("normal_view"),
        "XYZRHW must not read an unavailable view-space normal:\n" + wgsl);
    assert.ok(wgsl.includes("vec4<f32>(0.0, 0.0, 0.0, 1.0)"),
        "a missing source coordinate needs a finite fallback:\n" + wgsl);
});

await test("fixed-function lighting accepts a sparse light index",
        async () => {
    const { executor, find } = makeExecutor();
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(0, 12, DECLTYPE.FLOAT3, DECLUSAGE.NORMAL),
    ];
    // A view matrix with a translation, so "the light was transformed into view
    // space" is distinguishable from "the light was passed through untouched" --
    // an identity view would make the two indistinguishable, which is exactly
    // the mistake the M1 WVP-order bug was.
    const view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1];
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 240)),
        command(OP.SET_FVF, fvfPayload(0x102, elements)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 24)),
        command(OP.SET_TRANSFORM, transformPayload(2, view)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS.LIGHTING, 1, 0)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS.AMBIENT, 0x00204060, 0)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS.NORMALIZENORMALS, 1, 0)),
        command(OP.SET_MATERIAL, materialPayload(
            [0.5, 0.25, 0.125, 0.75], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0], 16)),
        // MaxActiveLights limits the simultaneous count, not the DWORD index.
        // 3DMark2001 uses scene-object light indices well above seven.
        command(OP.SET_LIGHT, lightPayload(37, 1 /* POINT */,
            { position: [1, 2, 3], attenuation: [1, 0, 0] })),
        command(OP.LIGHT_ENABLE, u32(DEVICE, 37, 1, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);
    assert.equal(executor.stats.drawsWithUnappliedLighting, 0,
        "a declaration with a NORMAL must actually be lit");

    const pipeline = find("createRenderPipeline").pop()[1];
    const wgsl = pipeline.vertex.module.code;
    assert.ok(wgsl.includes("struct D9Light"),
        "the light array has to be declared:\n" + wgsl);
    assert.ok(wgsl.includes("normal_matrix"),
        "normals need the inverse-transpose matrix");
    assert.ok(wgsl.includes("uniforms.lights[0]"), "light 0 must be read");
    assert.ok(wgsl.includes("light.range_falloff.x"),
        "a point light must honour its range");
    // The normal has to reach the pipeline as its own attribute.
    const byLocation = new Map(pipeline.vertex.buffers[0].attributes
        .map(a => [a.shaderLocation, a]));
    assert.equal(byLocation.get(3).offset, 12, "NORMAL belongs at location 3");

    // And the light's position must arrive already multiplied by the view
    // matrix. (1,2,3) * view = (11,22,33).
    const bindGroup = find("createBindGroup").pop()[1];
    const block = constantBlock(find, bindGroup.entries[0].resource.buffer);
    const data = new Float32Array(block.buffer, block.byteOffset);
    // world_view_projection(16) viewport(4) world_view(16) normal_matrix(16)
    // material diffuse/ambient/specular/emissive(16) ambient_power(4) lights...
    const materialDiffuse = 16 + 4 + 16 + 16;
    assert.deepEqual([...data.slice(materialDiffuse, materialDiffuse + 4)],
        [0.5, 0.25, 0.125, 0.75], "material diffuse must reach the block");
    const ambientPower = materialDiffuse + 16;
    assert.deepEqual([...data.slice(ambientPower, ambientPower + 4)]
        .map(v => Math.round(v * 255) / 255),
        [0x20 / 255, 0x40 / 255, 0x60 / 255, 16 / 255].map(v =>
            Math.round(v * 255) / 255).slice(0, 3).concat([
                Math.round(16 * 255) / 255]),
        "D3DRS_AMBIENT is 0x00RRGGBB and the material power shares the vec4");
    const lightBase = ambientPower + 4;
    const position = [...data.slice(lightBase + 12, lightBase + 15)];
    assert.deepEqual(position, [11, 22, 33],
        "the light position must be transformed into view space");
});

await test("D3DRS_LIGHTING with no NORMAL preserves ambient and emissive",
        async () => {
    // D3D9 supplies a zero normal when the declaration has no NORMAL. The
    // light-direction dot products disappear, but ambient and emissive still
    // have to be evaluated. GTA SA relies on that distinction for character
    // batches whose pre-lit vertex colour is black.
    const { executor, find } = makeExecutor();
    const defaultWarnings = [];
    const originalConsoleWarn = console.warn;
    console.warn = (...args) => defaultWarnings.push(args);
    try {
        await executor.submit(buildBatch([
            command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
            command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
            command(OP.SET_FVF, fvfPayload(0x42, [
                element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
                element(0, 12, DECLTYPE.D3DCOLOR, DECLUSAGE.COLOR)])),
            command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 16)),
            command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS.LIGHTING, 1, 0)),
            command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS.AMBIENT,
                0x00ffffff, 0)),
            command(OP.SET_MATERIAL, materialPayload(
                [1, 1, 1, 1], [0.25, 0.5, 0.75, 1], [0, 0, 0, 0],
                [0.05, 0, 0, 0], 0)),
            command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
            command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
        ], { present: true }));
        await executor.idle();
    } finally {
        console.warn = originalConsoleWarn;
    }
    assert.equal(defaultWarnings.filter(args =>
        /coordinate set|lit draw with no NORMAL/.test(String(args[0]))).length, 0,
    "valid but suspicious draw state must not warn unless diagnostics are enabled");
    assert.equal(executor.stats.droppedDraws, 0);
    assert.equal(executor.stats.drawsWithUnappliedLighting, 0,
        "normal-less lighting is implemented, not dropped");
    assert.equal(executor.stats.drawsWithZeroNormalLighting, 1,
        "normal-less lit draws remain visible in diagnostics");
    assert.equal(executor.stats.zeroNormalDrawsWithoutTexture, 0);
    assert.equal(executor.stats.zeroNormalDrawsWithMissingTexture, 1,
        "the default stage-0 texture read must expose its missing binding");
    assert.equal(executor.stats.zeroNormalDrawsWithLiveTexture, 0);

    const pipeline = find("createRenderPipeline").pop()[1];
    const wgsl = pipeline.vertex.module.code;
    assert.ok(wgsl.includes("let normal_view = vec3<f32>(0.0);"),
        "a missing NORMAL must become the D3D9 zero normal:\n" + wgsl);
    assert.ok(wgsl.includes("total_ambient * material_ambient.xyz"),
        "global ambient and material ambient must still be evaluated");
    assert.ok(wgsl.includes("material_emissive.xyz"),
        "material emissive must survive a missing normal");
    assert.ok(!wgsl.includes("let out_diffuse = vertex_diffuse;"),
        "black pre-lit COLOR0 must not bypass ambient lighting");

    const bindGroup = find("createBindGroup").pop()[1];
    const block = constantBlock(find, bindGroup.entries[0].resource.buffer);
    const data = new Float32Array(block.buffer, block.byteOffset);
    // world_view_projection(16) viewport(4) world_view(16) normal_matrix(16)
    const materialDiffuse = 16 + 4 + 16 + 16;
    assert.deepEqual([...data.slice(materialDiffuse + 4, materialDiffuse + 8)],
        [0.25, 0.5, 0.75, 1], "material ambient must reach the uniform block");
    const ambientPower = materialDiffuse + 16;
    assert.deepEqual([...data.slice(ambientPower, ambientPower + 3)], [1, 1, 1],
        "white D3DRS_AMBIENT must reach the uniform block");

    // The same evidence remains available on demand without changing the
    // rendering path or disabling the always-on counters above.
    const diagnosticWarnings = [];
    executor.debug.warnOnSuspiciousDraws = true;
    console.warn = (...args) => diagnosticWarnings.push(args);
    try {
        await executor.submit(buildBatch([
            command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
            command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
        ], { present: true }));
        await executor.idle();
    } finally {
        console.warn = originalConsoleWarn;
    }
    assert.ok(diagnosticWarnings.some(args =>
        String(args[0]).includes("coordinate set")),
    "the missing-coordinate diagnostic must remain available on demand");
    assert.ok(diagnosticWarnings.some(args =>
        String(args[0]).includes("lit draw with no NORMAL")),
    "the zero-normal diagnostic must remain available on demand");
});

await test("a multi-stage texture cascade generates one blend per stage",
        async () => {
    // Terrain splatting in miniature: stage 0 selects its texture, stage 1
    // blends a second texture over it by the first's alpha, stage 2 modulates
    // the result with the diffuse colour.
    const { executor, find } = makeExecutor();
    const tss = (stage, state, value) =>
        command(0x202, u32(DEVICE, stage, state, value));
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 240)),
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0x401, 4, 4, 1, 21, 0, 1)),
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0x402, 4, 4, 1, 21, 0, 1)),
        command(OP.SET_FVF, fvfPayload(0x144, [
            element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
            element(0, 12, DECLTYPE.D3DCOLOR, DECLUSAGE.COLOR),
            element(0, 16, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD, 0),
            element(0, 24, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD, 1)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 32)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x401, 0)),
        command(OP.SET_TEXTURE, u32(DEVICE, 1, 0x402, 0)),
        tss(0, D3DTSS.COLOROP, D3DTOP.SELECTARG1),
        tss(0, D3DTSS.COLORARG1, D3DTA.TEXTURE),
        tss(1, D3DTSS.COLOROP, D3DTOP.BLENDTEXTUREALPHA),
        tss(1, D3DTSS.COLORARG1, D3DTA.TEXTURE),
        tss(1, D3DTSS.COLORARG2, D3DTA.CURRENT),
        tss(1, D3DTSS.TEXCOORDINDEX, 1),
        tss(2, D3DTSS.COLOROP, D3DTOP.MODULATE),
        tss(2, D3DTSS.COLORARG1, D3DTA.CURRENT),
        tss(2, D3DTSS.COLORARG2, D3DTA.DIFFUSE),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);
    assert.equal(executor.stats.drawsWithUnsupportedTextureOp, 0,
        "every operation used here is inside TextureOpCaps");

    const pipeline = find("createRenderPipeline").pop()[1];
    const wgsl = pipeline.fragment.module.code;
    assert.ok(wgsl.includes("d9_tex0") && wgsl.includes("d9_tex1"),
        "both sampled stages need their own texture binding:\n" + wgsl);
    assert.ok(!wgsl.includes("d9_tex2"),
        "stage 2 samples nothing and must not declare a texture");
    assert.ok(wgsl.includes("mix("),
        "BLENDTEXTUREALPHA is a mix by the stage's texture alpha");
    // Stage 2 reads the running result, so `current` has to thread through.
    assert.ok(/current = vec4<f32>\(stage_rgb, stage_a\);/.test(wgsl),
        "each stage must write the cascade register");

    // Two textures bound means two texture/sampler binding pairs.
    const layout = find("createBindGroupLayout").pop()[1];
    for (const binding of [2, 3, 4, 5])
        assert.ok(layout.entries.some(entry => entry.binding === binding),
            "binding " + binding + " must be declared for two sampled stages");
    assert.ok(!layout.entries.some(entry => entry.binding === 6),
        "stage 2 samples nothing, so no third pair");
});

await test("D3DTSS_RESULTARG threads a stage result through the temp register",
        async () => {
    const { executor, find } = makeExecutor();
    const tss = (stage, state, value) =>
        command(0x202, u32(DEVICE, stage, state, value));
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 240)),
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0x401, 4, 4, 1, 21, 0, 1)),
        command(OP.SET_FVF, fvfPayload(0x104, [
            element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
            element(0, 12, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD, 0)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x401, 0)),
        tss(0, D3DTSS.COLOROP, D3DTOP.SELECTARG1),
        tss(0, D3DTSS.COLORARG1, D3DTA.TEXTURE),
        tss(0, D3DTSS.RESULTARG, D3DTA.TEMP),
        tss(1, D3DTSS.COLOROP, D3DTOP.MULTIPLYADD),
        tss(1, D3DTSS.COLORARG0, D3DTA.TEMP),
        tss(1, D3DTSS.COLORARG1, D3DTA.DIFFUSE),
        tss(1, D3DTSS.COLORARG2, D3DTA.TFACTOR),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS.TEXTUREFACTOR, 0x80402010, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);
    const wgsl = find("createRenderPipeline").pop()[1].fragment.module.code;
    assert.ok(/temp = vec4<f32>\(stage_rgb, stage_a\);/.test(wgsl),
        "stage 0 must write the temp register:\n" + wgsl);
    assert.ok(wgsl.includes("temp.rgb"), "stage 1 must read it back");
    assert.ok(wgsl.includes("uniforms.texture_factor"),
        "D3DTA_TFACTOR needs the texture factor uniform");

    // The texture factor has to actually be uploaded, as 0xAARRGGBB.
    const bindGroup = find("createBindGroup").pop()[1];
    const pixelEntry = bindGroup.entries.find(entry => entry.binding === 1);
    const block = constantBlock(find, pixelEntry.resource.buffer);
    const data = new Float32Array(block.buffer, block.byteOffset);
    const factor = [...data.slice(pixelEntry.resource.offset / 4,
        pixelEntry.resource.offset / 4 + 4)].map(v => Math.round(v * 255));
    assert.deepEqual(factor, [0x40, 0x20, 0x10, 0x80],
        "D3DRS_TEXTUREFACTOR is 0xAARRGGBB");
});

const D3DTOP_BUMPENVMAP = 22;
const D3DTOP_BUMPENVMAPLUMINANCE = 23;
const D3DTSS_BUMPENVMAT00 = 7, D3DTSS_BUMPENVMAT01 = 8;
const D3DTSS_BUMPENVMAT10 = 9, D3DTSS_BUMPENVMAT11 = 10;

// A bump stage displaces the *next* stage's coordinate, so a BUMPENVMAP with
// no stage after it displaces nothing at all. That renders a frame which looks
// almost right, which is exactly the case worth reporting rather than drawing
// silently.
await test("a trailing D3DTOP_BUMPENVMAP has nothing to displace and is reported",
        async () => {
    const { executor } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 240)),
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0x401, 4, 4, 1, 21, 0, 1)),
        command(OP.SET_FVF, fvfPayload(0x104, [
            element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
            element(0, 12, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD, 0)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x401, 0)),
        command(0x202, u32(DEVICE, 0, D3DTSS.COLOROP, D3DTOP_BUMPENVMAP)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.drawsWithUnsupportedTextureOp, 1,
        "a bump stage with no consumer must be reported");
    assert.equal(executor.stats.droppedDraws, 0,
        "the draw still renders rather than disappearing");
});

await test("D3DTOP_BUMPENVMAP displaces the next stage through its matrix",
        async () => {
    const { executor, find } = makeExecutor();
    const floatBitsOf = value => {
        const buffer = new ArrayBuffer(4);
        new Float32Array(buffer)[0] = value;
        return new Uint32Array(buffer)[0];
    };
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 240)),
        // Stage 0 is the (du, dv) map, stage 1 the environment it displaces.
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0x401, 4, 4, 1, 60, 0, 1)),
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0x402, 4, 4, 1, 21, 0, 1)),
        command(OP.SET_FVF, fvfPayload(0x104, [
            element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
            element(0, 12, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD, 0)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x401, 0)),
        command(OP.SET_TEXTURE, u32(DEVICE, 1, 0x402, 0)),
        command(0x202, u32(DEVICE, 0, D3DTSS.COLOROP, D3DTOP_BUMPENVMAP)),
        command(0x202, u32(DEVICE, 0, D3DTSS_BUMPENVMAT00, floatBitsOf(0.25))),
        command(0x202, u32(DEVICE, 0, D3DTSS_BUMPENVMAT01, floatBitsOf(0.5))),
        command(0x202, u32(DEVICE, 0, D3DTSS_BUMPENVMAT10, floatBitsOf(0.75))),
        command(0x202, u32(DEVICE, 0, D3DTSS_BUMPENVMAT11, floatBitsOf(1.5))),
        command(0x202, u32(DEVICE, 1, D3DTSS.COLOROP, 2 /* SELECTARG1 */)),
        command(0x202, u32(DEVICE, 1, D3DTSS.COLORARG1, 2 /* TEXTURE */)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.drawsWithUnsupportedTextureOp, 0,
        "a bump pair is supported and must not be reported as unsupported");
    assert.equal(executor.stats.drawCalls, 1);

    // The bump stage must sample even though no argument named its texture:
    // the displacement is its whole purpose.
    const module = find("createShaderModule")
        .map(call => call[1].code)
        .find(code => /stage_bump0/.test(code));
    assert.ok(module, "the cascade must declare a bump matrix uniform");
    const code = module;
    assert.match(code, /textureSample\(d9_tex0/,
        "the bump stage samples its own (du, dv) map");
    assert.match(code,
        /stage_bump0\.x \* tex0\.r \+ uniforms\.stage_bump0\.z \* tex0\.g/,
        "u is displaced by m00*du + m10*dv: " + code);
    assert.match(code,
        /stage_bump0\.y \* tex0\.r \+ uniforms\.stage_bump0\.w \* tex0\.g/,
        "v is displaced by m01*du + m11*dv");
});

// The MODULATE*_ADD* family is the one part of the cascade that mixes a
// argument's colour with the *same* argument's alpha, so each case is checked
// against the algebra D3D9 documents rather than against "it compiled".
for (const { name, op, pattern } of [
    { name: "MODULATEALPHA_ADDCOLOR", op: D3DTOP.MODULATEALPHA_ADDCOLOR,
      // Arg1.RGB + Arg1.A * Arg2.RGB
      pattern: /\(tex0\.rgb \+ tex0\.a \* [a-z_0-9.]+\.rgb\)/ },
    { name: "MODULATECOLOR_ADDALPHA", op: D3DTOP.MODULATECOLOR_ADDALPHA,
      // Arg1.RGB * Arg2.RGB + Arg1.A
      pattern: /\(tex0\.rgb \* [a-z_0-9.]+\.rgb \+ vec3<f32>\(tex0\.a\)\)/ },
    { name: "MODULATEINVALPHA_ADDCOLOR", op: D3DTOP.MODULATEINVALPHA_ADDCOLOR,
      // (1 - Arg1.A) * Arg2.RGB + Arg1.RGB
      pattern: /\(\(1\.0 - tex0\.a\) \* [a-z_0-9.]+\.rgb \+ tex0\.rgb\)/ },
    { name: "MODULATEINVCOLOR_ADDALPHA", op: D3DTOP.MODULATEINVCOLOR_ADDALPHA,
      // (1 - Arg1.RGB) * Arg2.RGB + Arg1.A
      pattern: /\(\(vec3<f32>\(1\.0\) - tex0\.rgb\) \* [a-z_0-9.]+\.rgb \+ vec3<f32>\(tex0\.a\)\)/ },
]) {
    await test("D3DTOP_" + name + " emits the algebra D3D9 documents",
            async () => {
        const { executor, find } = makeExecutor();
        const tss = (stage, state, value) =>
            command(0x202, u32(DEVICE, stage, state, value));
        await executor.submit(buildBatch([
            command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
            command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 240)),
            command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0x401, 4, 4, 1, 21, 0, 1)),
            command(OP.SET_FVF, fvfPayload(0x104, [
                element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
                element(0, 12, DECLTYPE.D3DCOLOR, DECLUSAGE.COLOR),
                element(0, 16, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD, 0)])),
            command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 24)),
            command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x401, 0)),
            tss(0, D3DTSS.COLOROP, op),
            tss(0, D3DTSS.COLORARG1, D3DTA.TEXTURE),
            tss(0, D3DTSS.COLORARG2, D3DTA.DIFFUSE),
            command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
            command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
        ], { present: true }));
        await executor.idle();
        assert.equal(executor.stats.drawsWithUnsupportedTextureOp, 0,
            "D3DTOP_" + name + " is advertised in TextureOpCaps and must " +
            "not be counted as unsupported");
        assert.equal(executor.stats.droppedDraws, 0);
        const wgsl = find("createRenderPipeline").pop()[1].fragment.module.code;
        assert.match(wgsl, pattern,
            "D3DTOP_" + name + " must emit its documented form:\n" + wgsl);
    });
}

await test("the MODULATE*_ADD* family is refused as an alpha operation",
        async () => {
    // D3D9 defines all four for D3DTSS_COLOROP only. Counting the refusal is
    // what keeps a caps claim from covering a channel it was never made for.
    const { executor } = makeExecutor();
    const tss = (stage, state, value) =>
        command(0x202, u32(DEVICE, stage, state, value));
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 240)),
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0x401, 4, 4, 1, 21, 0, 1)),
        command(OP.SET_FVF, fvfPayload(0x104, [
            element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
            element(0, 12, DECLTYPE.D3DCOLOR, DECLUSAGE.COLOR),
            element(0, 16, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD, 0)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 24)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x401, 0)),
        tss(0, D3DTSS.COLOROP, D3DTOP.SELECTARG1),
        tss(0, D3DTSS.COLORARG1, D3DTA.TEXTURE),
        tss(0, D3DTSS.ALPHAOP, D3DTOP.MODULATEALPHA_ADDCOLOR),
        tss(0, D3DTSS.ALPHAARG1, D3DTA.TEXTURE),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.drawsWithUnsupportedTextureOp, 1,
        "an alpha-channel MODULATEALPHA_ADDCOLOR must be counted, not emitted");
});

await test("D3DTOP_PREMODULATE stays refused and is counted", async () => {
    // It modulates against the *next* stage's texture; nothing in the cascade
    // carries a value backwards, and fill_caps() does not advertise it.
    const { executor } = makeExecutor();
    const tss = (stage, state, value) =>
        command(0x202, u32(DEVICE, stage, state, value));
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 240)),
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0x401, 4, 4, 1, 21, 0, 1)),
        command(OP.SET_FVF, fvfPayload(0x104, [
            element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
            element(0, 12, DECLTYPE.D3DCOLOR, DECLUSAGE.COLOR),
            element(0, 16, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD, 0)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 24)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x401, 0)),
        tss(0, D3DTSS.COLOROP, D3DTOP.PREMODULATE),
        tss(0, D3DTSS.COLORARG1, D3DTA.TEXTURE),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.drawsWithUnsupportedTextureOp, 1,
        "PREMODULATE is outside TextureOpCaps and must be counted");
});

await test("a render target redirects the pass and keys its own pipeline",
        async () => {
    const D3DUSAGE_RENDERTARGET = 1;
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        // A render target arrives as a CREATE_TEXTURE_2D carrying the usage.
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0x501, 256, 256, 1, 21, D3DUSAGE_RENDERTARGET, 0)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        // Into the texture...
        command(OP.SET_RENDER_TARGET, u32(DEVICE, 0, 0x501, 0)),
        command(OP.SET_DEPTH_STENCIL_SURFACE_LEVEL,
            u32(DEVICE, 0, 0, 0, 0)),
        command(OP.SET_VIEWPORT, u32(DEVICE, 0, 0, 256, 256, 0, 0x3f800000, 0)),
        command(OP.CLEAR, u32(DEVICE, 1, 0xff112233, 0, 0, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        // ...and back to the back buffer, restoring the implicit depth surface
        // (D9WG_AUTO_DEPTH_STENCIL_HANDLE) the way an app that saved it does.
        command(OP.SET_RENDER_TARGET, u32(DEVICE, 0, 0, 0)),
        command(OP.SET_DEPTH_STENCIL_SURFACE_LEVEL,
            u32(DEVICE, 0xffffffff, 0, 640, 480)),
        command(OP.SET_VIEWPORT, u32(DEVICE, 0, 0, 640, 480, 0, 0x3f800000, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);
    assert.equal(executor.stats.renderTargetsCreated, 1);
    assert.equal(executor.stats.renderTargetBinds, 2);
    // The texture pass has no depth attachment and the back-buffer pass does,
    // so they cannot share a pipeline -- that is the whole point of baking
    // hasDepth into the key.
    const pipelines = find("createRenderPipeline").map(call => call[1]);
    assert.equal(pipelines.length, 2,
        "a target with a different depth configuration needs its own pipeline");
    assert.ok(!pipelines[0].depthStencil,
        "the render-to-texture pass was given no depth surface");
    assert.ok(pipelines[1].depthStencil,
        "the back-buffer pass still has the auto depth-stencil");
    // Two distinct targets means at least two passes, and the first must not be
    // pointed at the swap chain.
    const passes = find("beginRenderPass").map(call => call[1]);
    assert.ok(passes.length >= 2, "each target needs its own pass");
    assert.notEqual(passes[0].colorAttachments[0].view,
        passes[passes.length - 1].colorAttachments[0].view,
        "the texture pass must not render into the back buffer");
    assert.equal(executor.stats.renderPasses, passes.length);
});

await test("a pre-1.3 batch is rejected before any command executes",
        async () => {
    const { executor } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
    ], { versionMinor: 2 }));
    await executor.idle();
    assert.match(executor.failed && executor.failed.message,
        /unsupported D9WG version 1\.2/);
    assert.equal(executor.stats.malformedBatches, 1);
    assert.equal(executor.devices.size, 0,
        "an obsolete DLL must not partially initialize host state");
});

await test("a short pre-1.3 device payload is not decoded as 1.3", async () => {
    const { executor } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, Buffer.alloc(44)),
    ]));
    await executor.idle();
    assert.match(executor.failed && executor.failed.message,
        /CREATE_DEVICE payload is not protocol 1\.3/);
    assert.equal(executor.stats.malformedBatches, 1);
    assert.equal(executor.devices.size, 0);
});

await test("a depth texture sampled by a pixel shader becomes a shadow map",
        async () => {
    const D3DUSAGE_DEPTHSTENCIL = 2;
    const D3DFMT_D24S8 = 75;
    const { executor, find } = makeExecutor();
    const ps = shaderCreatePayload(0x40000003, PS_BYTECODE);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0x502, 1024, 1024, 1, D3DFMT_D24S8,
                D3DUSAGE_DEPTHSTENCIL, 0)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.CREATE_PIXEL_SHADER, ps.payload, ps.blob, ps.blobOffsetField),
        command(OP.SET_PIXEL_SHADER, u32(DEVICE, 0x40000003)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x502, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();

    // The regression this guards: the depth resource carried a null view, the
    // null reached createBindGroup as a binding resource, and the TypeError it
    // threw took the whole batch down with it.
    assert.equal(executor.stats.commandsFailed, 0,
        "sampling a depth texture must not throw out of its command");
    assert.equal(executor.stats.droppedDraws, 0);
    assert.equal(executor.stats.depthStageWithoutDepthTexture, 0);

    const layout = find("createBindGroupLayout").pop()[1];
    const textureEntry = layout.entries.find(entry => entry.binding === 2);
    const samplerEntry = layout.entries.find(entry => entry.binding === 3);
    assert.equal(textureEntry.texture.sampleType, "depth");
    assert.equal(samplerEntry.sampler.type, "comparison");
    assert.ok(find("createSampler").some(call =>
        call[1].compare === "less-equal"),
        "a shadow map is read through a comparison sampler");

    // The module and the layout have to agree: a texture_2d<f32> paired with a
    // depth layout entry fails pipeline creation outright.
    assert.ok(find("createShaderModule").some(call =>
        call[1].code.includes("texture_depth_2d") &&
        call[1].code.includes("sampler_comparison")),
        "the pixel stage must be translated to a comparison sample");
});

await test("a shadow map still bound as the depth attachment is not sampled",
        async () => {
    const D3DUSAGE_DEPTHSTENCIL = 2;
    const D3DFMT_D24S8 = 75;
    const { executor } = makeExecutor();
    const ps = shaderCreatePayload(0x40000003, PS_BYTECODE);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480, 0)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0x502, 640, 480, 1, D3DFMT_D24S8,
                D3DUSAGE_DEPTHSTENCIL, 0)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.CREATE_PIXEL_SHADER, ps.payload, ps.blob, ps.blobOffsetField),
        command(OP.SET_PIXEL_SHADER, u32(DEVICE, 0x40000003)),
        // Attachment and sampler at once: legal enough in D3D9, a submit-level
        // validation error in WebGPU.
        command(OP.SET_DEPTH_STENCIL_SURFACE_LEVEL,
            u32(DEVICE, 0x502, 0, 640, 480)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x502, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();

    assert.equal(executor.stats.commandsFailed, 0);
    assert.equal(executor.stats.droppedDraws, 0);
    assert.equal(executor.stats.depthAttachmentSampledInPlace, 1,
        "the read-write hazard must degrade the stage, not the submit");
});

await test("a depth texture on a fixed-function stage reads the white fallback",
        async () => {
    const D3DUSAGE_DEPTHSTENCIL = 2;
    const D3DFMT_D24S8 = 75;
    const { executor } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0x502, 256, 256, 1, D3DFMT_D24S8,
                D3DUSAGE_DEPTHSTENCIL, 0)),
        command(OP.SET_FVF, fvfPayload(0x102,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
             element(0, 12, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x502, 0)),
        // COLOROP = MODULATE with ARG1 = TEXTURE, so the cascade samples.
        command(OP.SET_TEXTURE_STAGE_STATE, u32(DEVICE, 0, 1, 4)),
        command(OP.SET_TEXTURE_STAGE_STATE, u32(DEVICE, 0, 2, 2)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();

    // Fixed function has no comparison reference to offer, so the stage cannot
    // be a shadow map. It has to degrade to the white fallback rather than
    // reach a float layout entry with a depth view, which is invalid.
    assert.equal(executor.stats.commandsFailed, 0);
    assert.equal(executor.stats.droppedDraws, 0);
    assert.equal(executor.stats.depthTextureOnNonDepthStage, 1);
});

await test("one failing command does not discard the rest of its batch",
        async () => {
    const { executor, fake } = makeExecutor();
    // Force a runtime failure that is not a framing error, the way a bad
    // binding resource used to be one.
    executor.handlers[OP.SET_RENDER_STATE] = () => {
        throw new Error("synthetic command failure");
    };
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, 27, 1, 0)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();

    assert.equal(executor.stats.commandsFailed, 1);
    assert.equal(executor.failed, null,
        "one bad command is not a bad batch");
    assert.equal(executor.stats.droppedDraws, 0);
    const pass = fake.calls.filter(call => call[0] === "beginRenderPass").pop()[2];
    assert.ok(pass.ops.some(op => op[0] === "draw"),
        "commands queued behind the failure must still execute");
});

await test("a framing error still fails the whole batch", async () => {
    const { executor } = makeExecutor();
    const vs = shaderCreatePayload(0x40000015, VS_BYTECODE);
    const batch = buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_VERTEX_SHADER, vs.payload, vs.blob, vs.blobOffsetField),
    ]);
    batch.writeUInt32LE(0x10000, batch.indexOf(vs.payload, 32) + 8);
    await executor.submit(batch);
    await executor.idle();

    // The per-command guard must not swallow this: a blob reaching past the
    // record means the byte layout itself is wrong, so nothing in the batch
    // can be trusted -- unlike a command that simply could not be carried out.
    assert.ok(executor.failed, "a malformed stream must still fail the batch");
    assert.equal(executor.stats.commandsFailed, 0);
});

await test("a D24S8 mip is used as the explicit depth attachment",
        async () => {
    const D3DUSAGE_DEPTHSTENCIL = 2;
    const D3DFMT_D24S8 = 75;
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        // Disable the automatic depth surface so the pass can only succeed by
        // resolving the texture bound below.
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480, 0)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0x502, 2560, 1920, 4, D3DFMT_D24S8,
                D3DUSAGE_DEPTHSTENCIL, 0)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.SET_DEPTH_STENCIL_SURFACE_LEVEL,
            u32(DEVICE, 0x502, 2, 640, 480)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();

    assert.equal(executor.stats.droppedDraws, 0);
    assert.equal(executor.stats.texturesRejected, 0);
    const creation = find("createTexture").find(call =>
        call[1].label === "D3D9 depth surface");
    assert.ok(creation, "CreateTexture(D24S8) must allocate a GPU depth target");
    assert.equal(creation[1].format, "depth24plus-stencil8");
    assert.equal(creation[1].mipLevelCount, 4);
    assert.equal(creation[1].usage, 0x14,
        "a depth texture is a render attachment AND sampleable: D3D9 shadow " +
        "mapping renders into it and then binds it to a sampler");

    const pass = find("beginRenderPass").find(call =>
        call[1].depthStencilAttachment);
    assert.ok(pass, "the draw must open a pass with the explicit depth surface");
    assert.equal(pass[1].depthStencilAttachment.view.texture, creation[2]);
    assert.deepEqual(pass[1].depthStencilAttachment.view.descriptor, {
        baseMipLevel: 2,
        mipLevelCount: 1,
        dimension: "2d",
        baseArrayLayer: 0,
        arrayLayerCount: 1,
    }, "the attachment view must address exactly the selected depth mip");
    const pipeline = find("createRenderPipeline").pop()[1];
    assert.equal(pipeline.depthStencil.format, "depth24plus-stencil8");
});

await test("an out-of-range depth mip is rejected at binding without invalidating WebGPU",
        async () => {
    const warnings = [];
    const realWarn = console.warn;
    const { executor, find } = makeExecutor();
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
        await executor.submit(buildBatch([
            command(OP.CREATE_DEVICE, createDevicePayload(640, 480, 0)),
            command(OP.CREATE_TEXTURE_2D,
                u32(DEVICE, 0x503, 640, 480, 2, 75, 2, 0)),
            command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
            command(OP.SET_FVF, fvfPayload(0x2,
                [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
            command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
            command(OP.SET_DEPTH_STENCIL_SURFACE_LEVEL,
                u32(DEVICE, 0x503, 2, 160, 120)),
            command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
            command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
        ], { present: true }));
        await executor.idle();
    } finally {
        console.warn = realWarn;
    }
    assert.equal(executor.stats.texturesRejected, 0);
    assert.ok(find("createTexture").some(call =>
        call[1].label === "D3D9 depth surface"),
        "a valid multi-mip depth descriptor must reach WebGPU");
    assert.ok(warnings.some(line => line.includes("out-of-range texture level")),
        "the invalid binding should explain why depth was omitted");
    const pass = find("beginRenderPass").find(call =>
        call[1].colorAttachments);
    assert.ok(pass && !pass[1].depthStencilAttachment,
        "an invalid mip must be dropped before render-pass validation");
});

await test("an oversized depth surface still depth-tests a smaller target",
        async () => {
    const D3DUSAGE_DEPTHSTENCIL = 2;
    const D3DUSAGE_RENDERTARGET = 1;
    const D3DFMT_D24S8 = 75;
    const D3DFMT_A16B16G16R16F = 113;
    const { executor, fake } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480, 0)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        // The render-to-texture idiom D3D9 allows and WebGPU does not: one
        // full-size depth surface reused by a half-resolution HDR pass.
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0xC01, 640, 480, 1, D3DFMT_D24S8,
                D3DUSAGE_DEPTHSTENCIL, 0)),
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0xC02, 320, 240, 1, D3DFMT_A16B16G16R16F,
                D3DUSAGE_RENDERTARGET, 0)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.SET_RENDER_TARGET, u32(DEVICE, 0, 0xC02, 0, 0)),
        command(OP.SET_DEPTH_STENCIL_SURFACE_LEVEL,
            u32(DEVICE, 0xC01, 0, 640, 480)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();

    assert.equal(executor.stats.droppedDraws, 0);
    assert.equal(executor.stats.commandsFailed, 0);
    assert.equal(executor.stats.depthTargetSubstitutions, 1);
    // The point of the substitution: the pass keeps depth testing. Running it
    // with no depth attachment lets every blended draw paint over geometry
    // that should have occluded it, which reads as a washed-out translucent
    // frame rather than as an error.
    const pass = fake.calls.filter(call => call[0] === "beginRenderPass")
        .map(call => call[1])
        .find(descriptor => descriptor.depthStencilAttachment);
    assert.ok(pass, "the half-resolution pass must still have depth");
    const substitute = fake.calls.filter(call => call[0] === "createTexture")
        .find(call => call[1].label &&
            call[1].label.startsWith("D3D9 substitute depth"));
    assert.ok(substitute, "a matching depth texture has to be allocated");
    assert.equal(substitute[1].size.width, 320);
    assert.equal(substitute[1].size.height, 240);
    // Nothing was lost -- the draw did not depth-test against contents an
    // earlier pass wrote -- so the substitution must not be reported as one.
    assert.equal(executor.stats.depthTargetSubstitutionsUncleared, 0);
});

await test("an uncleared oversized-depth pass is reported, a cleared one is not",
        async () => {
    const D3DUSAGE_DEPTHSTENCIL = 2;
    const D3DUSAGE_RENDERTARGET = 1;
    const D3DFMT_D24S8 = 75;
    const D3DFMT_A8R8G8B8 = 21;
    const D3DRS_ZENABLE = 7;
    const D3DCLEAR_ZBUFFER = 2;
    const setup = () => [
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480, 0)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0xF01, 640, 480, 1, D3DFMT_D24S8, D3DUSAGE_DEPTHSTENCIL, 0)),
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0xF02, 320, 240, 1, D3DFMT_A8R8G8B8, D3DUSAGE_RENDERTARGET, 0)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_ZENABLE, 1, 0)),
        command(OP.SET_RENDER_TARGET, u32(DEVICE, 0, 0xF02, 0, 0)),
        command(OP.SET_DEPTH_STENCIL_SURFACE_LEVEL, u32(DEVICE, 0xF01, 0, 640, 480)),
    ];

    // Clearing depth on entry is what render-to-texture does, and it makes the
    // stand-in exactly equivalent to the surface it replaced.
    {
        const { executor } = makeExecutor();
        await executor.submit(buildBatch([
            ...setup(),
            command(OP.CLEAR, u32(DEVICE, D3DCLEAR_ZBUFFER, 0, 0x3f800000, 0)),
            command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
            command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
        ], { present: true }));
        await executor.idle();
        // Counted per target resolution, and both the Clear and the draw
        // resolve, so the interesting number is the second one.
        assert.ok(executor.stats.depthTargetSubstitutions >= 1);
        assert.equal(executor.stats.depthTargetSubstitutionsUncleared, 0,
            "a cleared substitute loses nothing and must stay quiet");
    }

    // Depth-testing without clearing reads a stand-in that never received what
    // an earlier pass wrote, which is the case worth reporting.
    {
        const { executor } = makeExecutor();
        await executor.submit(buildBatch([
            ...setup(),
            command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
            command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
        ], { present: true }));
        await executor.idle();
        assert.equal(executor.stats.depthTargetSubstitutionsUncleared, 1);
    }
});

await test("an autogen texture allocates the chain and fills it after a write",
        async () => {
    const D3DUSAGE_AUTOGENMIPMAP = 0x400;
    const D3DFMT_A8R8G8B8 = 21;
    const { executor, fake, find } = makeExecutor();
    const ps = shaderCreatePayload(0x40000003, PS_BYTECODE);
    // The guest reports one level, which is what D3D9's GetLevelCount says for
    // an autogen texture; the chain lives entirely on this side.
    const update = Buffer.alloc(48);
    update.writeUInt32LE(0xE01, 0);
    update.writeUInt32LE(8, 20);   // width
    update.writeUInt32LE(8, 24);   // height
    update.writeUInt32LE(1, 28);
    update.writeUInt32LE(32, 32);  // row pitch
    update.writeUInt32LE(256, 40);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0xE01, 8, 8, 1, D3DFMT_A8R8G8B8,
                D3DUSAGE_AUTOGENMIPMAP, 0)),
        command(OP.UPDATE_TEXTURE, update, Buffer.alloc(256, 0x80), 44),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.CREATE_PIXEL_SHADER, ps.payload, ps.blob, ps.blobOffsetField),
        command(OP.SET_PIXEL_SHADER, u32(DEVICE, 0x40000003)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0xE01, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();

    assert.equal(executor.stats.commandsFailed, 0);
    assert.equal(executor.stats.droppedDraws, 0);
    const created = find("createTexture").find(call =>
        call[1].size && call[1].size.width === 8)[1];
    assert.equal(created.mipLevelCount, 4, "8x8 is a four-level chain");
    assert.ok(created.usage & 0x10,
        "each level is rendered from the one above, so it is an attachment");

    // The chain has to be filled between the upload and the draw that samples
    // it -- not at some later point, and not never.
    assert.equal(executor.stats.mipChainsGenerated, 1);
    assert.equal(executor.stats.mipLevelsGenerated, 3, "levels 1..3");
    // And it must not be reported as an incomplete upload: the app only ever
    // supplies level 0 by design.
    assert.equal(executor.stats.drawsWithIncompleteMipChain, 0);
});

await test("an untouched scratch texture is not an incomplete mip chain",
        async () => {
    const D3DFMT_X8R8G8B8 = 22;
    const { executor } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 60)),
        // 3DMark 99 creates and binds its dynamic frame-capture texture before
        // the first DirectDraw Blt fills it. A wholly untouched single-level
        // allocation is not evidence that the proxy lost a subresource write.
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0xE10, 256, 256, 1, D3DFMT_X8R8G8B8, 0, 0)),
        command(OP.SET_FVF, fvfPayload(0x104, [
            element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
            element(0, 12, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD, 0)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0xE10, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();

    assert.equal(executor.stats.droppedDraws, 0);
    assert.equal(executor.stats.drawsWithIncompleteMipChain, 0,
        "a texture with no writes must not masquerade as a partial chain");
});

await test("a partially uploaded mip chain still reports missing levels",
        async () => {
    const D3DFMT_A8R8G8B8 = 21;
    const { executor } = makeExecutor();
    const update = Buffer.alloc(48);
    update.writeUInt32LE(0xE11, 0);
    update.writeUInt32LE(0, 4);    // level
    update.writeUInt32LE(0, 8);    // x
    update.writeUInt32LE(0, 12);   // y
    update.writeUInt32LE(0, 16);   // z
    update.writeUInt32LE(4, 20);   // width
    update.writeUInt32LE(4, 24);   // height
    update.writeUInt32LE(1, 28);   // depth
    update.writeUInt32LE(16, 32);  // row pitch
    update.writeUInt32LE(0, 36);   // slice pitch
    update.writeUInt32LE(64, 40);  // data bytes
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 60)),
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0xE11, 4, 4, 3, D3DFMT_A8R8G8B8, 0, 0)),
        command(OP.UPDATE_TEXTURE, update, Buffer.alloc(64, 0x80), 44),
        command(OP.SET_FVF, fvfPayload(0x104, [
            element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
            element(0, 12, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD, 0)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0xE11, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();

    assert.equal(executor.stats.drawsWithIncompleteMipChain, 1,
        "writing only level 0 of a three-level chain remains diagnostic");
});

await test("an autogen chain is regenerated only when level 0 changes",
        async () => {
    const D3DUSAGE_AUTOGENMIPMAP = 0x400;
    const D3DFMT_A8R8G8B8 = 21;
    const { executor } = makeExecutor();
    const ps = shaderCreatePayload(0x40000003, PS_BYTECODE);
    // A factory, not an array: buildBatch() stamps size/offset onto each
    // command object, so reusing one twice rewrites the first copy's framing.
    const draw = () => [
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0xE02, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
    ];
    const update = Buffer.alloc(48);
    update.writeUInt32LE(0xE02, 0);
    update.writeUInt32LE(8, 20);
    update.writeUInt32LE(8, 24);
    update.writeUInt32LE(1, 28);
    update.writeUInt32LE(32, 32);
    update.writeUInt32LE(256, 40);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0xE02, 8, 8, 1, D3DFMT_A8R8G8B8,
                D3DUSAGE_AUTOGENMIPMAP, 0)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.CREATE_PIXEL_SHADER, ps.payload, ps.blob, ps.blobOffsetField),
        command(OP.SET_PIXEL_SHADER, u32(DEVICE, 0x40000003)),
        command(OP.UPDATE_TEXTURE, update, Buffer.alloc(256, 0x80), 44),
        ...draw(),
        // Sampling again without touching level 0 must not rebuild anything.
        ...draw(),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.mipChainsGenerated, 1,
        "a clean chain is not rebuilt on every draw");

    // An explicit GenerateMipSubLevels rebuilds regardless.
    await executor.submit(buildBatch([
        command(OP.GENERATE_MIPS, u32(DEVICE, 0xE02)),
    ]));
    await executor.idle();
    assert.equal(executor.stats.explicitMipGenerations, 1);
    assert.equal(executor.stats.mipChainsGenerated, 2);
});

await test("two depth surfaces of one size get separate substitutes",
        async () => {
    const D3DUSAGE_DEPTHSTENCIL = 2;
    const D3DUSAGE_RENDERTARGET = 1;
    const D3DFMT_D24S8 = 75;
    const D3DFMT_A8R8G8B8 = 21;
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480, 0)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        // Two full-size depth surfaces, two half-size targets. Sharing one
        // substitute across both passes would let them depth-test against
        // each other's fragments.
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0xD01, 640, 480, 1, D3DFMT_D24S8, D3DUSAGE_DEPTHSTENCIL, 0)),
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0xD02, 640, 480, 1, D3DFMT_D24S8, D3DUSAGE_DEPTHSTENCIL, 0)),
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0xD03, 320, 240, 1, D3DFMT_A8R8G8B8, D3DUSAGE_RENDERTARGET, 0)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.SET_RENDER_TARGET, u32(DEVICE, 0, 0xD03, 0, 0)),
        command(OP.SET_DEPTH_STENCIL_SURFACE_LEVEL, u32(DEVICE, 0xD01, 0, 640, 480)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.SET_DEPTH_STENCIL_SURFACE_LEVEL, u32(DEVICE, 0xD02, 0, 640, 480)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();

    assert.equal(executor.stats.droppedDraws, 0);
    assert.equal(executor.stats.depthTargetSubstitutions, 2);
    const substitutes = find("createTexture").filter(call =>
        call[1].label && call[1].label.startsWith("D3D9 substitute depth"));
    assert.equal(substitutes.length, 2,
        "each depth surface needs its own stand-in, not one shared by size");
});

await test("packed 4:2:2 and RGBG formats expand two pixels per block",
        async () => {
    const { executor, find } = makeExecutor();
    const D3DFMT_YUY2 = 0x32595559;
    const D3DFMT_UYVY = 0x59565955;
    const D3DFMT_R8G8_B8G8 = 0x47424752;
    const D3DFMT_G8R8_G8B8 = 0x42475247;
    // BT.601 studio swing: Y=16 is black, Y=235 white, neutral chroma at 128.
    const cases = [
        // Y0 U Y1 V -- black then white, both neutral.
        { name: "YUY2", format: D3DFMT_YUY2, source: [16, 128, 235, 128] },
        // U Y0 V Y1 -- same two pixels, chroma first.
        { name: "UYVY", format: D3DFMT_UYVY, source: [128, 16, 128, 235] },
        // R G0 B G1 -- shared red and blue, per-pixel green.
        { name: "RGBG", format: D3DFMT_R8G8_B8G8, source: [10, 0, 30, 255],
          expected: [[10, 0, 30, 255], [10, 255, 30, 255]] },
        // G0 R G1 B -- the same pair, bytes reordered.
        { name: "GRGB", format: D3DFMT_G8R8_G8B8, source: [0, 10, 255, 30],
          expected: [[10, 0, 30, 255], [10, 255, 30, 255]] },
    ];
    const commands = [command(OP.CREATE_DEVICE, createDevicePayload(640, 480))];
    cases.forEach((item, index) => {
        const handle = 0x900 + index;
        const source = Buffer.from(item.source);
        const update = Buffer.alloc(48);
        update.writeUInt32LE(handle, 0);
        update.writeUInt32LE(2, 20); // width: one block is two pixels
        update.writeUInt32LE(1, 24); // height
        update.writeUInt32LE(1, 28); // depth
        update.writeUInt32LE(4, 32); // row pitch
        update.writeUInt32LE(4, 40); // data bytes
        commands.push(command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, handle, 2, 1, 1, item.format, 0, 1)));
        commands.push(command(OP.UPDATE_TEXTURE, update, source, 44));
    });
    await executor.submit(buildBatch(commands));
    await executor.idle();

    assert.equal(executor.stats.texturesRejected, 0,
        "every packed format must be accepted");
    const writes = find("writeTexture").slice(-cases.length);
    cases.forEach((item, index) => {
        const data = Array.from(writes[index][2]);
        assert.equal(data.length, 8, item.name + ": two RGBA8 pixels");
        if (item.expected) {
            assert.deepEqual(data, item.expected.flat(),
                item.name + ": the pair shares chroma and differs in green");
            return;
        }
        // YUV: neutral chroma means grey, and the two luma values must not
        // come out equal -- that is the failure a naive "use byte 0 twice"
        // expansion produces, and it looks like a plausible dark image.
        assert.ok(data[0] < 40 && data[1] < 40 && data[2] < 40,
            item.name + ": Y=16 is black, got " + data.slice(0, 3));
        assert.ok(data[4] > 215 && data[5] > 215 && data[6] > 215,
            item.name + ": Y=235 is white, got " + data.slice(4, 7));
    });
});

await test("INDEX16 and INDEX32 texture uploads preserve little-endian bytes",
        async () => {
    const { executor, find } = makeExecutor();
    const cases = [
        { name: "INDEX16", format: 101, source: [0x34, 0x12],
          expected: [0x34, 0x12, 0x00, 0xff] },
        { name: "INDEX32", format: 102, source: [0x78, 0x56, 0x34, 0x12],
          expected: [0x78, 0x56, 0x34, 0x12] },
    ];
    const commands = [command(OP.CREATE_DEVICE, createDevicePayload(640, 480))];
    cases.forEach((item, index) => {
        const handle = 0x920 + index;
        const source = Buffer.from(item.source);
        const update = Buffer.alloc(48);
        update.writeUInt32LE(handle, 0);
        update.writeUInt32LE(1, 20);
        update.writeUInt32LE(1, 24);
        update.writeUInt32LE(1, 28);
        update.writeUInt32LE(source.length, 32);
        update.writeUInt32LE(source.length, 40);
        commands.push(command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, handle, 1, 1, 1, item.format, 0, 1)));
        commands.push(command(OP.UPDATE_TEXTURE, update, source, 44));
    });
    await executor.submit(buildBatch(commands));
    await executor.idle();

    assert.equal(executor.stats.texturesRejected, 0,
        "both index formats must be accepted as textures");
    const writes = find("writeTexture").slice(-cases.length);
    cases.forEach((item, index) => {
        assert.deepEqual(Array.from(writes[index][2]), item.expected,
            item.name + ": exact index bytes survive RGBA8 expansion");
    });
});

await test("a palette change repaints P8 textures without a re-upload",
        async () => {
    const D3DFMT_P8 = 41;
    const { executor, find } = makeExecutor();
    const paletteCommand = (index, colorFor) => {
        const payload = Buffer.alloc(16);
        payload.writeUInt32LE(DEVICE, 0);
        payload.writeUInt32LE(index, 4);
        payload.writeUInt32LE(256, 8);
        const blob = Buffer.alloc(256 * 4);
        for (let entry = 0; entry < 256; ++entry)
            blob.writeUInt32LE(colorFor(entry) >>> 0, entry * 4);
        return command(OP.SET_PALETTE, payload, blob, 12);
    };
    // Index 1 is opaque red under palette 0, opaque blue under palette 1.
    const indices = Buffer.from([1, 1, 1, 1]);
    const update = Buffer.alloc(48);
    update.writeUInt32LE(0xA01, 0);
    update.writeUInt32LE(2, 20);
    update.writeUInt32LE(2, 24);
    update.writeUInt32LE(1, 28);
    update.writeUInt32LE(2, 32);  // row pitch: one byte per texel
    update.writeUInt32LE(4, 40);

    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        paletteCommand(0, entry => entry === 1 ? 0xffff0000 : 0xff000000),
        paletteCommand(1, entry => entry === 1 ? 0xff0000ff : 0xff000000),
        command(OP.SET_CURRENT_PALETTE, u32(DEVICE, 0)),
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0xA01, 2, 2, 1, D3DFMT_P8, 0, 1)),
        command(OP.UPDATE_TEXTURE, update, indices, 44),
    ]));
    await executor.idle();

    assert.equal(executor.stats.palettesSet, 2);
    assert.equal(executor.stats.texturesRejected, 0);
    const first = Array.from(find("writeTexture").pop()[2]).slice(0, 4);
    assert.deepEqual(first, [255, 0, 0, 255],
        "palette 0 makes index 1 red");

    // The whole point of a palettized format: switching tables repaints the
    // texture with no new upload from the guest.
    const uploadsBefore = executor.stats.textureUploads;
    await executor.submit(buildBatch([
        command(OP.SET_CURRENT_PALETTE, u32(DEVICE, 1)),
    ]));
    await executor.idle();

    assert.equal(executor.stats.textureUploads, uploadsBefore,
        "a palette swap is not a guest upload");
    assert.equal(executor.stats.palettizedRepaints, 1);
    const second = Array.from(find("writeTexture").pop()[2]).slice(0, 4);
    assert.deepEqual(second, [0, 0, 255, 255],
        "palette 1 makes the same indices blue");
});

await test("FOURCC depth textures read the stored value, not a comparison",
        async () => {
    const D3DFMT_INTZ = 0x5A544E49;
    const { executor, find } = makeExecutor();
    const ps = shaderCreatePayload(0x40000003, PS_BYTECODE);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        // INTZ is routinely created with usage 0 and then used as depth.
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0xB01, 256, 256, 1, D3DFMT_INTZ, 0, 0)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.CREATE_PIXEL_SHADER, ps.payload, ps.blob, ps.blobOffsetField),
        command(OP.SET_PIXEL_SHADER, u32(DEVICE, 0x40000003)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0xB01, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();

    assert.equal(executor.stats.commandsFailed, 0);
    assert.equal(executor.stats.droppedDraws, 0);
    const created = find("createTexture").find(call =>
        call[1].label === "D3D9 depth surface");
    assert.ok(created, "a FOURCC depth format allocates a depth target");

    // Depth sample type, but an ordinary sampler: a raw fetch does not compare.
    const layout = find("createBindGroupLayout").pop()[1];
    assert.equal(layout.entries.find(e => e.binding === 2).texture.sampleType,
        "depth");
    assert.equal(layout.entries.find(e => e.binding === 3).sampler.type,
        "non-filtering",
        "an INTZ fetch reads through a plain sampler, not a comparison one");
    assert.ok(find("createShaderModule").some(call =>
        call[1].code.includes("texture_depth_2d") &&
        !call[1].code.includes("sampler_comparison")),
        "the stage must be a depth fetch, not a shadow-map comparison");
});

await test("a cube render target attaches one face per pass", async () => {
    const D3DUSAGE_RENDERTARGET = 1;
    const { executor, fake, find } = makeExecutor();
    // SetRenderTarget with the protocol-1.4 face field.
    const setCubeTarget = face =>
        command(OP.SET_RENDER_TARGET, u32(DEVICE, 0, 0x601, 0, face));
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(0x111, u32(DEVICE, 0x601, 64, 1, 21, D3DUSAGE_RENDERTARGET, 0, 0)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        // The environment-map idiom: render the scene once per face.
        ...[0, 1, 2, 3, 4, 5].flatMap(face => [
            setCubeTarget(face),
            command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        ]),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();

    assert.equal(executor.stats.droppedDraws, 0);
    assert.equal(executor.stats.commandsFailed, 0);
    const created = find("createTexture").find(call =>
        call[1].label === "D3D9 cube 64")[1];
    assert.ok(created.usage & 0x10,
        "a cube render target needs the attachment usage");

    // Six distinct attachment views, one per layer. Before the face reached
    // the host every one of these was layer 0, so five faces of an environment
    // map were painted over the first.
    const attachmentLayers = find("createView")
        .filter(call => call[2] && call[2].arrayLayerCount === 1 &&
            call[2].mipLevelCount === 1)
        .map(call => call[2].baseArrayLayer);
    for (const face of [0, 1, 2, 3, 4, 5])
        assert.ok(attachmentLayers.includes(face),
            "face " + face + " must get its own attachment view");
    assert.equal(executor.stats.cubeFaceTargetBinds, 5,
        "faces 1..5 are non-zero binds");

    // And they must not be merged into one pass: same texture, different
    // subresource, so the pass key has to separate them.
    const passes = fake.calls.filter(call => call[0] === "beginRenderPass");
    assert.ok(passes.length >= 6,
        "each face is its own render pass, got " + passes.length);
});

await test("a cube texture binds as a cube view and uploads per face",
        async () => {
    const { executor, find } = makeExecutor();
    const face = (index, level) => {
        const payload = Buffer.alloc(48);
        payload.writeUInt32LE(0x601, 0);
        payload.writeUInt32LE(level, 4);
        payload.writeUInt32LE(0, 8);   // x
        payload.writeUInt32LE(0, 12);  // y
        payload.writeUInt32LE(index, 16); // z == cube face
        payload.writeUInt32LE(4, 20);  // width
        payload.writeUInt32LE(4, 24);  // height
        payload.writeUInt32LE(1, 28);  // depth
        payload.writeUInt32LE(16, 32); // row pitch
        payload.writeUInt32LE(0, 36);
        payload.writeUInt32LE(64, 40); // data bytes
        return { payload, blob: Buffer.alloc(64, index + 1), field: 44 };
    };
    const uploads = [0, 1, 2, 3, 4, 5].map(index => face(index, 0));
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 240)),
        command(0x111, u32(DEVICE, 0x601, 4, 1, 21, 0, 1, 0)),
        ...uploads.map(upload =>
            command(OP.UPDATE_TEXTURE, upload.payload, upload.blob, upload.field)),
        command(OP.SET_FVF, fvfPayload(0x104, [
            element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
            element(0, 12, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD, 0)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x601, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);
    assert.equal(executor.stats.cubeTexturesCreated, 1);
    assert.equal(executor.stats.textureUploads, 6, "one upload per face");
    assert.equal(executor.stats.drawsWithIncompleteMipChain, 0,
        "all six faces of the single level were uploaded");

    const created = find("createTexture").find(call =>
        call[1].label === "D3D9 cube 4")[1];
    assert.equal(created.size.depthOrArrayLayers, 6,
        "a cube is six array layers");
    assert.ok(find("createView").some(call =>
        call[2] && call[2].dimension === "cube"),
        "the sampled view has to be a cube view");
    // Each face has to land on its own layer, or five of them overwrite one.
    const layers = find("writeTexture")
        .filter(call => call[1] && call[1].origin)
        .map(call => call[1].origin.z);
    assert.deepEqual(layers, [0, 1, 2, 3, 4, 5]);
    // And the fixed-function cascade has to sample it as a cube.
    const wgsl = find("createRenderPipeline").pop()[1].fragment.module.code;
    assert.ok(wgsl.includes("texture_cube<f32>"),
        "the cascade must declare a cube sampler:\n" + wgsl);
});

await test("legacy D3D9 texture formats preserve colour and signed bump values",
        async () => {
    const { executor, find } = makeExecutor();
    const halfMinusOne = [0x00, 0xbc];
    const halfZero = [0x00, 0x00];
    const halfHalf = [0x00, 0x38];
    const halfOne = [0x00, 0x3c];
    const cases = [
        { format: 20, gpu: "rgba8unorm", source: [0x33, 0x22, 0x11],
          expected: [0x11, 0x22, 0x33, 0xff] }, // R8G8B8: B,G,R
        { format: 27, gpu: "rgba8unorm", source: [0xe3],
          expected: [0xff, 0x00, 0xff, 0xff] },
        { format: 29, gpu: "rgba8unorm", source: [0xe3, 0x80],
          expected: [0xff, 0x00, 0xff, 0x80] },
        { format: 30, gpu: "rgba8unorm", source: [0x23, 0xf1],
          expected: [0x11, 0x22, 0x33, 0xff] },
        { format: 32, gpu: "rgba8unorm", source: [0x11, 0x22, 0x33, 0x44],
          expected: [0x11, 0x22, 0x33, 0x44] },
        { format: 33, gpu: "rgba8unorm", source: [0x11, 0x22, 0x33, 0x44],
          expected: [0x11, 0x22, 0x33, 0xff] },
        { format: 28, gpu: "rgba8unorm", source: [0x40],
          expected: [0x00, 0x00, 0x00, 0x40] }, // A8 missing RGB is zero
        { format: 51, gpu: "rgba8unorm", source: [0x40, 0x80],
          expected: [0x40, 0x40, 0x40, 0x80] },
        { format: 52, gpu: "rgba8unorm", source: [0xa5],
          expected: [0x55, 0x55, 0x55, 0xaa] },
        { format: 81, gpu: "rgba16float", source: [0x00, 0x80],
          expected: [...halfHalf, ...halfHalf, ...halfHalf, ...halfOne] },
        // 10:10:10:2 and 16-bit integer formats are expanded to RGBA16F so
        // sampling and blending preserve their precision and component order.
        { format: 31, gpu: "rgba16float", source: [0xff, 0x03, 0x00, 0xc0],
          expected: [...halfOne, ...halfZero, ...halfZero, ...halfOne] },
        { format: 35, gpu: "rgba16float", source: [0x00, 0x00, 0xf0, 0xff],
          expected: [...halfOne, ...halfZero, ...halfZero, ...halfOne] },
        { format: 34, gpu: "rgba16float", source: [0x00, 0x80, 0xff, 0xff],
          expected: [...halfHalf, ...halfOne, ...halfZero, ...halfOne] },
        { format: 36, gpu: "rgba16float",
          source: [0x00, 0x00, 0x00, 0x80, 0xff, 0xff, 0xff, 0xff],
          expected: [...halfZero, ...halfHalf, ...halfOne, ...halfOne] },
        // D3D half-float texels already have the exact representation WebGPU
        // needs; missing channels receive D3D's documented (0,0,1) defaults.
        { format: 111, gpu: "rgba16float", source: halfHalf,
          expected: [...halfHalf, ...halfZero, ...halfZero, ...halfOne] },
        { format: 112, gpu: "rgba16float",
          source: [...halfHalf, ...halfOne],
          expected: [...halfHalf, ...halfOne, ...halfZero, ...halfOne] },
        { format: 113, gpu: "rgba16float",
          source: [...halfHalf, ...halfZero, ...halfOne, ...halfOne],
          expected: [...halfHalf, ...halfZero, ...halfOne, ...halfOne] },
        // WebGPU has native 32-bit float texture formats.  Their texels must
        // remain bit-exact: CPU conversion would both waste time and destroy
        // NaN/Inf payloads an HDR post-process is entitled to preserve.
        { format: 114, gpu: "r32float",
          source: [0x00, 0x00, 0x00, 0x3f],
          expected: [0x00, 0x00, 0x00, 0x3f] },
        { format: 115, gpu: "rg32float",
          source: [0x00, 0x00, 0x00, 0x3f,
                   0x00, 0x00, 0x80, 0x3f],
          expected: [0x00, 0x00, 0x00, 0x3f,
                     0x00, 0x00, 0x80, 0x3f] },
        { format: 116, gpu: "rgba32float",
          source: [0x00, 0x00, 0x00, 0x3f,
                   0x00, 0x00, 0x80, 0x3f,
                   0x00, 0x00, 0x00, 0x40,
                   0x00, 0x00, 0x40, 0x40],
          expected: [0x00, 0x00, 0x00, 0x3f,
                     0x00, 0x00, 0x80, 0x3f,
                     0x00, 0x00, 0x00, 0x40,
                     0x00, 0x00, 0x40, 0x40] },
        { format: 60, gpu: "rgba8snorm", source: [0x80, 0x7f],
          expected: [0x80, 0x7f, 0x7f, 0x7f] },
        { format: 63, gpu: "rgba8snorm", source: [0x80, 0xc0, 0x40, 0x7f],
          expected: [0x80, 0xc0, 0x40, 0x7f] },
        { format: 61, gpu: "rgba16float", source: [0xf0, 0xfd],
          expected: [...halfMinusOne, ...halfOne, ...halfOne, ...halfOne] },
        { format: 62, gpu: "rgba16float", source: [0x80, 0x7f, 0xff, 0],
          expected: [...halfMinusOne, ...halfOne, ...halfOne, ...halfOne] },
        { format: 64, gpu: "rgba16float", source: [0x00, 0x80, 0xff, 0x7f],
          expected: [...halfMinusOne, ...halfOne, ...halfOne, ...halfOne] },
        // W11V11U10: U is 10 signed bits at 0-9, V and W are 11 each at
        // 10-20 and 21-31. 0x7FEFFE00 is (u,v,w) = (-1, +1, +1).
        { format: 65, gpu: "rgba16float", source: [0x00, 0xfe, 0xef, 0x7f],
          expected: [...halfMinusOne, ...halfOne, ...halfOne, ...halfOne] },
        { format: 67, gpu: "rgba16float", source: [0x00, 0xfe, 0x07, 0xc0],
          expected: [...halfMinusOne, ...halfOne, ...halfZero, ...halfOne] },
        { format: 117, gpu: "rgba16float", source: [0x80, 0x00],
          expected: [...halfMinusOne, ...halfZero, ...halfZero, ...halfOne] },
    ];
    const commands = [command(OP.CREATE_DEVICE, createDevicePayload(640, 480))];
    cases.forEach((item, index) => {
        const handle = 0x700 + index;
        const source = Buffer.from(item.source);
        const update = Buffer.alloc(48);
        update.writeUInt32LE(handle, 0);
        update.writeUInt32LE(1, 20); // width
        update.writeUInt32LE(1, 24); // height
        update.writeUInt32LE(1, 28); // depth
        update.writeUInt32LE(source.length, 32); // source row pitch
        update.writeUInt32LE(source.length, 40);
        commands.push(command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, handle, 1, 1, 1, item.format, 0, 1)));
        commands.push(command(OP.UPDATE_TEXTURE, update, source, 44));
    });
    await executor.submit(buildBatch(commands));
    await executor.idle();
    assert.equal(executor.stats.texturesRejected, 0);
    const descriptors = find("createTexture").slice(-cases.length)
        .map(call => call[1]);
    const writes = find("writeTexture").slice(-cases.length);
    cases.forEach((item, index) => {
        assert.equal(descriptors[index].format, item.gpu,
            "wrong GPU format for D3DFMT " + item.format);
        if (item.gpu === "rgba8snorm")
            assert.equal(descriptors[index].usage & 0x10, 0,
                "SNORM textures must not request RENDER_ATTACHMENT");
        assert.deepEqual(Array.from(writes[index][2]), item.expected,
            "wrong texel conversion for D3DFMT " + item.format);
        assert.equal(writes[index][3].bytesPerRow, item.expected.length);
    });
});

await test("HDR render targets use a blendable rgba16float attachment",
        async () => {
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0x76f, 320, 180, 1, 113, 1, 0)),
        command(OP.SET_RENDER_TARGET, u32(DEVICE, 0, 0x76f, 0)),
        command(OP.CLEAR, u32(DEVICE, 1, 0xff102030, 0x3f800000, 0, 0)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.texturesRejected, 0);
    const texture = find("createTexture").find(call =>
        call[1].label === "D3D9 render target");
    assert.ok(texture, "A16B16G16R16F must allocate a render target");
    assert.equal(texture[1].format, "rgba16float");
    assert.ok(texture[1].usage & 0x10,
        "the HDR texture must carry RENDER_ATTACHMENT usage");
    assert.ok(find("beginRenderPass").some(call =>
        call[1].colorAttachments?.[0]?.view?.texture === texture[2]));
});

await test("FP32 textures use unfilterable bindings on baseline WebGPU",
        async () => {
    const { executor, find } = makeExecutor();
    const tss = (stage, state, value) =>
        command(0x202, u32(DEVICE, stage, state, value));
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x780, 1, 60)),
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0x781, 4, 4, 1, 114 /* R32F */, 0, 1)),
        command(OP.SET_FVF, fvfPayload(0x104, [
            element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
            element(0, 12, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD, 0)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x780, 20)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x781, 0)),
        // Ask for linear filtering.  A baseline device without the optional
        // float32-filterable feature must legally degrade this one sampler to
        // nearest instead of creating an invalid bind group.
        command(OP.SET_SAMPLER_STATE, u32(DEVICE, 0, 5, 2)),
        command(OP.SET_SAMPLER_STATE, u32(DEVICE, 0, 6, 2)),
        tss(0, D3DTSS.COLOROP, D3DTOP.SELECTARG1),
        tss(0, D3DTSS.COLORARG1, D3DTA.TEXTURE),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);
    const layout = find("createBindGroupLayout").find(call =>
        call[1].entries.some(entry => entry.binding === 2));
    assert.ok(layout, "sampled FP32 draw needs a texture binding layout");
    assert.equal(layout[1].entries.find(entry => entry.binding === 2)
        .texture.sampleType, "unfilterable-float");
    assert.equal(layout[1].entries.find(entry => entry.binding === 3)
        .sampler.type, "non-filtering");
    const sampler = find("createSampler").pop()[1];
    assert.equal(sampler.minFilter, "nearest");
    assert.equal(sampler.magFilter, "nearest");
});

await test("signed textures reject render-target use but keep direct copies",
        async () => {
    const { executor, find } = makeExecutor();
    const stretch = (destinationSize) => {
        const payload = Buffer.alloc(56);
        payload.writeUInt32LE(DEVICE, 0);
        payload.writeUInt32LE(0x771, 4);
        payload.writeUInt32LE(0, 8);
        [0, 0, 4, 4].forEach((value, index) =>
            payload.writeInt32LE(value, 12 + index * 4));
        payload.writeUInt32LE(0x772, 28);
        payload.writeUInt32LE(0, 32);
        [0, 0, destinationSize, destinationSize].forEach((value, index) =>
            payload.writeInt32LE(value, 36 + index * 4));
        return payload;
    };
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        // A stale or malformed guest must not make the host create an illegal
        // rgba8snorm RENDER_ATTACHMENT descriptor.
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0x770, 4, 4, 1, 60, 1, 0)),
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0x771, 4, 4, 1, 60, 0, 1)),
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0x772, 4, 4, 1, 60, 0, 1)),
        command(0x8, stretch(4)),
        command(0x8, stretch(2)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.texturesRejected, 1);
    assert.equal(executor.stats.blits, 1,
        "same-size same-format signed textures can use a GPU copy");
    assert.equal(executor.stats.blitsSkipped, 1,
        "scaling cannot render into an rgba8snorm texture");
    // Present's own back-buffer-to-canvas copy is not one of the blits.
    assert.equal(find("copyTextureToTexture").filter(call =>
        call[1].texture !== executor.backBufferTexture).length, 1);
    assert.ok(!find("createTexture").some(call =>
        call[1].format === "rgba8snorm" && (call[1].usage & 0x10)),
        "rgba8snorm must never request RENDER_ATTACHMENT");
});

await test("R8G8B8 upload honours a padded source pitch", async () => {
    const { executor, find } = makeExecutor();
    const source = Buffer.from([
        0x30, 0x20, 0x10, 0xee,
        0x60, 0x50, 0x40, 0xee,
    ]);
    const update = Buffer.alloc(48);
    update.writeUInt32LE(0x750, 0);
    update.writeUInt32LE(1, 20);
    update.writeUInt32LE(2, 24);
    update.writeUInt32LE(1, 28);
    update.writeUInt32LE(4, 32);
    update.writeUInt32LE(source.length, 40);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0x750, 1, 2, 1, 20, 0, 1)),
        command(OP.UPDATE_TEXTURE, update, source, 44),
    ]));
    await executor.idle();
    const write = find("writeTexture").pop();
    assert.deepEqual(Array.from(write[2]), [
        0x10, 0x20, 0x30, 0xff,
        0x40, 0x50, 0x60, 0xff,
    ]);
    assert.equal(write[3].bytesPerRow, 4);
    assert.equal(write[3].rowsPerImage, 2);
});

await test("DXT2 and DXT4 reuse BC2 and BC3 block storage", async () => {
    const { executor, find } = makeExecutor();
    const commands = [command(OP.CREATE_DEVICE, createDevicePayload(640, 480))];
    [
        { handle: 0x760, format: 0x32545844, gpu: "bc2-rgba-unorm" },
        { handle: 0x761, format: 0x34545844, gpu: "bc3-rgba-unorm" },
    ].forEach(item => {
        const update = Buffer.alloc(48);
        update.writeUInt32LE(item.handle, 0);
        update.writeUInt32LE(4, 20);
        update.writeUInt32LE(4, 24);
        update.writeUInt32LE(1, 28);
        update.writeUInt32LE(16, 32);
        update.writeUInt32LE(16, 40);
        commands.push(command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, item.handle, 4, 4, 1, item.format, 0, 1)));
        commands.push(command(OP.UPDATE_TEXTURE, update,
            Buffer.alloc(16, item.handle & 0xff), 44));
    });
    await executor.submit(buildBatch(commands));
    await executor.idle();
    assert.deepEqual(find("createTexture").slice(-2).map(call => call[1].format),
        ["bc2-rgba-unorm", "bc3-rgba-unorm"]);
    assert.deepEqual(find("writeTexture").slice(-2).map(call => call[3]), [
        { bytesPerRow: 16, rowsPerImage: 1 },
        { bytesPerRow: 16, rowsPerImage: 1 },
    ]);
});

await test("exhausting the debug preview budget never drops a game texture upload",
        async () => {
    const { executor, find } = makeExecutor();
    executor.previewBudget = 0;
    const payload = Buffer.alloc(48);
    payload.writeUInt32LE(0x611, 0);
    payload.writeUInt32LE(0, 4);
    payload.writeUInt32LE(0, 8);
    payload.writeUInt32LE(0, 12);
    payload.writeUInt32LE(0, 16);
    payload.writeUInt32LE(4, 20);
    payload.writeUInt32LE(4, 24);
    payload.writeUInt32LE(1, 28);
    payload.writeUInt32LE(16, 32);
    payload.writeUInt32LE(0, 36);
    payload.writeUInt32LE(64, 40);
    await executor.submit(buildBatch([
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0x611, 4, 4, 1, 21, 0, 1)),
        command(OP.UPDATE_TEXTURE, payload, Buffer.alloc(64, 0x7f), 44),
    ]));
    await executor.idle();
    assert.equal(executor.stats.texturePreviewsSkipped, 1,
        "the bounded diagnostic copy should be skipped");
    assert.equal(executor.stats.textureUploads, 1,
        "the actual upload must still be counted");
    assert.ok(find("writeTexture").some(call =>
        call[1].texture && call[1].texture.descriptor.size.width === 4),
        "preview exhaustion must not bypass queue.writeTexture");
});

await test("a texture updated after a recorded draw is renamed", async () => {
    const { executor, find } = makeExecutor();
    const upload = fill => {
        const payload = Buffer.alloc(48);
        payload.writeUInt32LE(0x612, 0);
        payload.writeUInt32LE(0, 4);
        payload.writeUInt32LE(0, 8);
        payload.writeUInt32LE(0, 12);
        payload.writeUInt32LE(0, 16);
        payload.writeUInt32LE(4, 20);
        payload.writeUInt32LE(4, 24);
        payload.writeUInt32LE(1, 28);
        payload.writeUInt32LE(16, 32);
        payload.writeUInt32LE(0, 36);
        payload.writeUInt32LE(64, 40);
        return command(OP.UPDATE_TEXTURE, payload, Buffer.alloc(64, fill), 44);
    };
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(0, 12, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD),
    ];
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 60)),
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0x612, 4, 4, 1, 21, 0, 1)),
        upload(0x11),
        command(OP.SET_FVF, fvfPayload(0x102, elements)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x612, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        upload(0x22),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.textureUpdateHazards, 1);
    assert.equal(executor.stats.textureRenames, 1);
    const groups = find("createBindGroup").filter(call =>
        call[1].entries.some(entry => entry.binding === 2));
    assert.equal(groups.length, 2);
    const firstView = groups[0][1].entries.find(entry => entry.binding === 2).resource;
    const secondView = groups[1][1].entries.find(entry => entry.binding === 2).resource;
    assert.notEqual(firstView.texture, secondView.texture,
        "the earlier bind group must retain the old GPU texture");
});

await test("D3DRS_SCISSORTESTENABLE gates the scissor rect", async () => {
    const { executor, find } = makeExecutor();
    const scissor = Buffer.alloc(20);
    scissor.writeUInt32LE(DEVICE, 0);
    scissor.writeInt32LE(10, 4);
    scissor.writeInt32LE(20, 8);
    scissor.writeInt32LE(110, 12);
    scissor.writeInt32LE(220, 16);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(0x205, scissor),
        // Rect set but the test disabled: D3D9 ignores it.
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS.SCISSORTESTENABLE, 1, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);
    assert.equal(executor.stats.drawsWithScissor, 1,
        "only the draw with the test enabled is scissored");
    // Every draw carries a clip rect, because a D3D9 viewport clips and a
    // WebGPU one does not. With the test off that rect is the full viewport;
    // with it on it is the viewport intersected with the app's rect, which D3D9
    // also applies on top of the viewport rather than instead of it.
    const calls = find("setScissorRect");
    assert.equal(calls.length, 2, "each draw sets its own clip rect");
    assert.deepEqual(calls[0].slice(1), [0, 0, 640, 480],
        "with the test disabled the clip rect is the whole viewport");
    assert.deepEqual(calls[1].slice(1), [10, 20, 100, 200]);
});

// A D3D9 viewport clips geometry; WebGPU's setViewport only maps NDC to pixels.
// Nothing else would cut a draw off at the viewport edge, so a game that
// restricts a small panel with SetViewport alone had its geometry drawn across
// the whole target instead.
await test("a viewport clips, and carries its D3D9 depth range", async () => {
    const { executor, find } = makeExecutor();
    const viewport = Buffer.alloc(32);
    viewport.writeUInt32LE(DEVICE, 0);
    viewport.writeUInt32LE(64, 4);    // x
    viewport.writeUInt32LE(48, 8);    // y
    viewport.writeUInt32LE(128, 12);  // width
    viewport.writeUInt32LE(96, 16);   // height
    viewport.writeFloatLE(0.25, 20);  // MinZ
    viewport.writeFloatLE(0.5, 24);   // MaxZ
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.SET_VIEWPORT, viewport),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);
    assert.deepEqual(find("setScissorRect").pop().slice(1), [64, 48, 128, 96],
        "the clip rect has to follow the viewport with no app scissor set");
    // MinZ/MaxZ have always been on the wire; they used to be dropped here.
    const pass = find("beginRenderPass").pop()[2];
    assert.deepEqual(pass.ops.find(op => op[0] === "viewport").slice(1),
        [64, 48, 128, 96, 0.25, 0.5]);
});

await test("concurrent guest sessions keep colliding handles isolated",
        async () => {
    const { executor } = makeExecutor();
    const hello = (low, high) => {
        const payload = Buffer.alloc(16);
        payload.writeUInt32LE(32, 0);
        payload.writeUInt32LE(3, 4); // SM2 | SM3
        payload.writeUInt32LE(low, 8);
        payload.writeUInt32LE(high, 12);
        return command(OP.HELLO, payload);
    };
    await executor.submit(buildBatch([
        hello(0x1001, 0xfedcba98),
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
    ], { sessionLow: 0x1001, sessionHigh: 0xfedcba98 }));
    await executor.idle();
    assert.equal(executor.resources.size, 1);
    assert.equal(executor.stats.sessionChanges, 0);
    assert.equal(executor.resources.get(0x201).byteCount, 96);

    // A Futuremark helper process is alive concurrently and reuses both the
    // device and buffer handles. Its objects must occupy another namespace,
    // without destroying the benchmark process's resources. The two 64-bit
    // IDs differ only in their low bit, so converting them to Number would
    // round them together above 2^53.
    await executor.submit(buildBatch([
        hello(0x1002, 0xfedcba98),
        command(OP.CREATE_DEVICE, createDevicePayload(320, 240)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 128)),
    ], { sessionLow: 0x1002, sessionHigh: 0xfedcba98 }));
    await executor.idle();
    assert.equal(executor.stats.sessionChanges, 1);
    assert.equal(executor.resources.get(0x201).byteCount, 128);

    // A later batch from the first process carries no HELLO. The batch header
    // alone must restore its exact resource table and in-flight state.
    await executor.submit(buildBatch([], {
        sessionLow: 0x1001, sessionHigh: 0xfedcba98,
    }));
    await executor.idle();
    assert.equal(executor.stats.sessionChanges, 2);
    assert.equal(executor.resources.get(0x201).byteCount, 96,
        "the benchmark process's buffer was replaced by its helper");
    assert.equal(executor.devices.get(DEVICE).backBufferWidth, 640);
    const stats = executor.getStats();
    assert.equal(stats.activeSession, "fedcba9800001001");
    assert.equal(stats.sessionsLive, 2);
    assert.equal(stats.devicesLive, 2);
    assert.equal(stats.resourcesLive, 2);
});

await test("a helper process cannot discard another session's in-flight frame",
        async () => {
    const { executor } = makeExecutor();
    const helloPayload = Buffer.alloc(16);
    helloPayload.writeUInt32LE(32, 0);
    helloPayload.writeUInt32LE(3, 4); // SM2 | SM3
    helloPayload.writeUInt32LE(0xa001, 8);
    await executor.submit(buildBatch([
        command(OP.HELLO, helloPayload),
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
    ], { sessionLow: 0xa001 }));
    await executor.idle();
    assert.ok(executor.frame, "the benchmark frame should remain pending");
    assert.equal(executor.stats.queueSubmits, 0,
        "the recorded frame must wait for Present before GPU submission");

    // 3DMark06 launches short-lived capability helpers while the benchmark
    // process is alive. Merely receiving their HELLO used to release every
    // resource and drop the benchmark's recorded draw operations.
    const helperHello = Buffer.from(helloPayload);
    helperHello.writeUInt32LE(0xb002, 8);
    await executor.submit(buildBatch([
        command(OP.HELLO, helperHello),
    ], { sessionLow: 0xb002 }));
    await executor.idle();
    assert.equal(executor.frame, null,
        "the helper must see its own empty frame context");

    await executor.submit(buildBatch([
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { sessionLow: 0xa001, present: true }));
    await executor.idle();
    assert.equal(executor.stats.drawCalls, 1,
        "the benchmark's draw command should be retained exactly once");
    assert.equal(executor.stats.droppedDraws, 0);
    assert.equal(executor.stats.queueSubmits, 1);
});

await test("the device requests texture-compression-bc so DXT textures work",
        async () => {
    // Without this, every createTexture for a DXT format throws
    // ("requires the 'texture-compression-bc' feature") and takes the whole
    // batch -- and therefore the whole frame -- down with it. DXT1/3/5 is where
    // a D3D9 game of this era keeps nearly all of its art, so the symptom is a
    // blank screen, not a missing texture.
    const { executor, find, fake } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0x401, 16, 16, 1, 0x33545844 /* DXT3 */, 0, 1)),
    ]));
    await executor.idle();
    const request = find("requestDevice").pop();
    assert.ok(request, "requestDevice must be observed");
    assert.deepEqual(request[1] && request[1].requiredFeatures,
        ["texture-compression-bc", "timestamp-query"],
        "the adapter's optional BC and timestamp features must be requested");
    const created = find("createTexture").map(call => call[1]);
    assert.ok(created.some(descriptor => descriptor.format === "bc2-rgba-unorm"),
        "DXT3 must reach WebGPU as bc2-rgba-unorm");
    assert.equal(executor.stats.texturesRejected, 0);
    assert.equal(executor.stats.malformedBatches, 0);
    assert.ok(!executor.failed, "a DXT texture must not fail the batch");
});

await test("a texture format the device refuses costs one texture, not the frame",
        async () => {
    const { executor, fake } = makeExecutor();
    const realCreateTexture = fake.device.createTexture.bind(fake.device);
    fake.device.createTexture = descriptor => {
        if (descriptor.format === "bc1-rgba-unorm")
            throw new Error("simulated: unsupported format");
        return realCreateTexture(descriptor);
    };
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 240)),
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0x401, 16, 16, 1, 0x31545844 /* DXT1 */, 0, 1)),
        command(OP.SET_FVF, fvfPayload(0x104, [
            element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
            element(0, 12, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD, 0)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x401, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.ok(!executor.failed, "the batch must survive one refused texture");
    assert.equal(executor.stats.texturesRejected, 1);
    assert.equal(executor.stats.droppedDraws, 0,
        "the draw still renders, with the white fallback bound");
    assert.equal(executor.stats.drawsWithFallbackTexture, 1);
    assert.equal(executor.stats.presents, 1);
});

await test("StretchRect from the back buffer becomes a deferred blit", async () => {
    // The back buffer has no view until Present (the swap chain texture is only
    // valid inside the task that acquired it), so this cannot be submitted where
    // the command arrives. Doing it eagerly is what produced "the host cannot
    // address this surface" -- and grabbing the frame into a texture is how a
    // D3D9 game does full-screen post-processing, so it is not a rare path.
    const D3DUSAGE_RENDERTARGET = 1;
    const stretch = (sourceHandle, destinationHandle) => {
        const payload = Buffer.alloc(56);
        payload.writeUInt32LE(DEVICE, 0);
        payload.writeUInt32LE(sourceHandle, 4);
        payload.writeUInt32LE(0, 8);
        [0, 0, 640, 480].forEach((v, i) => payload.writeInt32LE(v, 12 + i * 4));
        payload.writeUInt32LE(destinationHandle, 28);
        payload.writeUInt32LE(0, 32);
        [0, 0, 256, 256].forEach((v, i) => payload.writeInt32LE(v, 36 + i * 4));
        payload.writeUInt32LE(0, 52); // linear filter
        return payload;
    };
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0x501, 256, 256, 1, 21, D3DUSAGE_RENDERTARGET, 0)),
        command(OP.CLEAR, u32(DEVICE, 1, 0xff000000, 0, 0, 0)),
        // Source handle 0 == the back buffer.
        command(0x8, stretch(0, 0x501)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.ok(!executor.failed, executor.failed && executor.failed.message);
    assert.equal(executor.stats.blitsSkipped, 0,
        "a back-buffer StretchRect must no longer be skipped");
    assert.equal(executor.stats.blits, 1);
    assert.equal(executor.stats.blitsThroughBackBuffer, 1);

    // It has to run as its own pass, drawing the six-vertex quad, into the
    // texture -- not into the back buffer.
    const passes = find("beginRenderPass").map(call => call[2]);
    const blitPass = passes.find(pass =>
        pass.ops.some(op => op[0] === "draw" && op[1] === 6));
    assert.ok(blitPass, "the blit must draw its quad in a pass of its own");
    const viewport = blitPass.ops.find(op => op[0] === "viewport");
    assert.deepEqual(viewport.slice(1, 5), [0, 0, 256, 256],
        "the destination rect becomes the viewport");
    // The source rect reaches the shader normalised against the source size.
    const uniformWrite = find("writeBuffer").pop();
    assert.deepEqual([...new Float32Array(uniformWrite[6].buffer,
        uniformWrite[6].byteOffset, 4)], [0, 0, 1, 1]);
});

await test("D3DSAMP_SRGBTEXTURE samples through an -srgb view", async () => {
    // Ignoring it hands the shader values substantially brighter than the app
    // intends (sRGB 0.5 is linear 0.21), which on an additive environment
    // reflection reads as blown-out white rather than as a gamma difference.
    const D3DSAMP_SRGBTEXTURE = 11;
    const { executor, find } = makeExecutor();
    const draw = extra => [
        command(OP.SET_FVF, fvfPayload(0x104, [
            element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
            element(0, 12, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD, 0)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.SET_TEXTURE, u32(DEVICE, 0, 0x401, 0)),
        ...extra,
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
    ];
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 240)),
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0x401, 4, 4, 1, 21, 0, 1)),
        ...draw([]),
        ...draw([command(OP.SET_SAMPLER_STATE,
            u32(DEVICE, 0, D3DSAMP_SRGBTEXTURE, 1))]),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);
    assert.equal(executor.stats.srgbTextureSamples, 1,
        "only the second draw asked for sRGB decoding");
    assert.equal(executor.stats.srgbViewsCreated, 1);
    assert.equal(executor.stats.srgbTextureUnavailable, 0);

    // The texture has to declare the view format up front, or the view is
    // invalid however it is requested later.
    const created = find("createTexture")
        .map(call => call[1]).find(d => d.size.width === 4);
    assert.deepEqual(created.viewFormats, ["rgba8unorm-srgb"]);
    assert.ok(find("createView").some(call =>
        call[2] && call[2].format === "rgba8unorm-srgb"),
        "the second draw must sample through the -srgb view");
});

await test("D3DRS_SRGBWRITEENABLE renders through an -srgb target view", async () => {
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, 194, 1, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.srgbWriteRequests, 1);
    assert.equal(executor.stats.srgbWriteUnavailable, 0);
    assert.deepEqual(find("configure").pop()[1].viewFormats,
        ["bgra8unorm-srgb"]);
    assert.equal(find("createRenderPipeline").pop()[1]
        .fragment.targets[0].format, "bgra8unorm-srgb");
});

await test("a state nothing reads is listed rather than silently dropped",
        async () => {
    // The expensive failures on this path have all been silent: a state the app
    // clearly cares about that the renderer never looks at, producing a picture
    // that is wrong in a plausible way with nothing saying so.
    const D3DRS_WRAP0 = 128, D3DSAMP_MIPMAPLODBIAS = 8;
    const { executor } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_WRAP0, 3, 0)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, 22 /* CULLMODE, read */, 1, 0)),
        command(OP.SET_SAMPLER_STATE, u32(DEVICE, 0, D3DSAMP_MIPMAPLODBIAS, 1)),
        command(OP.SET_SAMPLER_STATE, u32(DEVICE, 0, 5 /* MAGFILTER, read */, 2)),
    ]));
    await executor.idle();
    assert.deepEqual(executor.stats.unreadStateIds, {
        renderStates: [D3DRS_WRAP0],
        samplerStates: [D3DSAMP_MIPMAPLODBIAS],
    }, "only the unread ones, and each listed once");
});

await test("M5 compact declarations feed skeletal shader inputs without CPU repacking",
        async () => {
    const { executor, find } = makeExecutor();
    const shader = shaderCreatePayload(0x40000021, VS_M5_SKINNING_INPUTS);
    const elements = [
        element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
        element(0, 12, DECLTYPE.UBYTE4N, DECLUSAGE.BLENDWEIGHT),
        element(0, 16, DECLTYPE.UBYTE4, DECLUSAGE.BLENDINDICES),
        element(0, 20, DECLTYPE.SHORT2, DECLUSAGE.TEXCOORD),
        element(0, 24, DECLTYPE.SHORT4, DECLUSAGE.TANGENT),
        element(0, 32, DECLTYPE.DEC3N, DECLUSAGE.NORMAL),
        element(0, 36, DECLTYPE.UDEC3, DECLUSAGE.BINORMAL),
    ];
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 400)),
        command(OP.CREATE_VERTEX_DECLARATION,
            declarationPayload(0x30000021, elements)),
        command(OP.CREATE_VERTEX_SHADER, shader.payload, shader.blob,
            shader.blobOffsetField),
        command(OP.SET_VERTEX_DECLARATION, u32(DEVICE, 0x30000021)),
        command(OP.SET_VERTEX_SHADER, u32(DEVICE, 0x40000021)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 40)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.droppedDraws, 0);
    assert.equal(executor.stats.drawsWithCompactVertexInputs, 1);
    const pipeline = find("createRenderPipeline").pop()[1];
    assert.deepEqual(pipeline.vertex.buffers[0].attributes.map(a => a.format),
        ["float32x3", "unorm8x4", "uint8x4", "sint16x2", "sint16x4",
            "uint32", "uint32"]);
    const wgsl = pipeline.vertex.module.code;
    assert.ok(wgsl.includes("@location(2) in2: vec4<u32>"));
    assert.ok(wgsl.includes("d9_unpack_dec3n(in5)"));
    assert.ok(wgsl.includes("d9_unpack_udec3(in6)"));
});

await test("shadow render states map to signed projection, exact blend and depth-stencil",
        async () => {
    const floatBitsOf = value => {
        const bits = new ArrayBuffer(4);
        new Float32Array(bits)[0] = value;
        return new Uint32Array(bits)[0];
    };
    const R = { SRCBLEND: 19, DESTBLEND: 20, ALPHABLENDENABLE: 27,
        STENCILENABLE: 52, STENCILFAIL: 53, STENCILZFAIL: 54,
        STENCILPASS: 55, STENCILFUNC: 56, STENCILREF: 57,
        STENCILMASK: 58, STENCILWRITEMASK: 59, BLENDFACTOR: 193,
        DEPTHBIAS: 195, SLOPE: 175, SEPARATEALPHA: 206,
        SRCBLENDALPHA: 207, DESTBLENDALPHA: 208, BLENDOPALPHA: 209 };
    const { executor, find } = makeExecutor();
    const states = [
        [R.ALPHABLENDENABLE, 1], [R.SRCBLEND, 14], [R.DESTBLEND, 15],
        [R.BLENDFACTOR, 0x80402010], [R.SEPARATEALPHA, 1],
        [R.SRCBLENDALPHA, 2], [R.DESTBLENDALPHA, 1],
        [R.BLENDOPALPHA, 1], [R.STENCILENABLE, 1], [R.STENCILFAIL, 3],
        [R.STENCILZFAIL, 4], [R.STENCILPASS, 5], [R.STENCILFUNC, 7],
        [R.STENCILREF, 0x55], [R.STENCILMASK, 0xff],
        [R.STENCILWRITEMASK, 0x0f], [R.DEPTHBIAS, floatBitsOf(1 / 0x1000000)],
        [R.SLOPE, floatBitsOf(1.5)],
    ].map(([id, value]) => command(OP.SET_RENDER_STATE,
        u32(DEVICE, id, value, 0)));
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        ...states,
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    const pipeline = find("createRenderPipeline").pop()[1];
    assert.deepEqual(pipeline.fragment.targets[0].blend, {
        color: { srcFactor: "constant", dstFactor: "one-minus-constant",
            operation: "add" },
        alpha: { srcFactor: "one", dstFactor: "zero", operation: "add" },
    });
    assert.equal(pipeline.depthStencil.depthBias, 1);
    assert.equal(pipeline.depthStencil.depthBiasSlopeScale, 1.5);
    assert.deepEqual(pipeline.depthStencil.stencilFront, {
        compare: "greater-equal", failOp: "replace",
        depthFailOp: "increment-clamp", passOp: "decrement-clamp",
    });
    assert.equal(pipeline.depthStencil.stencilReadMask, 0xff);
    assert.equal(pipeline.depthStencil.stencilWriteMask, 0x0f);
    assert.deepEqual(find("setBlendConstant").pop()[1], {
        r: 0x40 / 255, g: 0x20 / 255, b: 0x10 / 255, a: 0x80 / 255,
    });
    assert.equal(find("setStencilReference").pop()[1], 0x55);

    const projected = buildFixedFunctionPixelShader({
        usesTextureFactor: false, specularEnable: false, fogMode: 0,
        alphaTest: { enabled: false, func: 8, reference: 0 },
        stages: [{ index: 0, colorOp: 2, colorArg0: 1, colorArg1: 2,
            colorArg2: 1, alphaOp: 2, alphaArg0: 1, alphaArg1: 2,
            alphaArg2: 1, resultArg: 1, samplesTexture: true,
            textureType: "2d", coordVarying: 0, projected: true,
            transformCount: 3, usesConstant: false }],
    }, null);
    assert.ok(projected.includes("select(-max(abs("),
        "projected shadows must preserve a negative q divisor");

    const bordered = buildFixedFunctionPixelShader({
        usesTextureFactor: false, specularEnable: false, fogMode: 0,
        alphaTest: { enabled: false, func: 8, reference: 0 },
        stages: [{ index: 0, colorOp: 2, colorArg0: 1, colorArg1: 2,
            colorArg2: 1, alphaOp: 2, alphaArg0: 1, alphaArg1: 2,
            alphaArg2: 1, resultArg: 1, samplesTexture: true,
            textureType: "2d", coordVarying: 0, projected: true,
            transformCount: 3, usesConstant: false, addressU: 4,
            addressV: 4, addressW: 1, borderColor: 0x80402010 }],
    }, null);
    assert.ok(bordered.includes("let tex0 = select(vec4<f32>("),
        "BORDER addressing must select the D3D border colour in WGSL");
    assert.ok(bordered.includes(".x >= 0.0") &&
        bordered.includes(".y <= 1.0"),
        "both BORDER axes must reject projected coordinates outside [0,1]");
    assert.ok(bordered.includes("0.25098039") &&
        bordered.includes("0.50196078"),
        "D3DCOLOR border bytes must be converted from ARGB to RGBA");
});

await test("D3D9 default blending is ONE/ZERO when blending is first enabled",
        async () => {
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 96)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.SET_RENDER_STATE, u32(DEVICE, 27, 1, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.deepEqual(find("createRenderPipeline").pop()[1]
        .fragment.targets[0].blend, {
        color: { srcFactor: "one", dstFactor: "zero", operation: "add" },
        alpha: { srcFactor: "one", dstFactor: "zero", operation: "add" },
    });
});

await test("M4 ColorFill preserves pixels outside a partial rectangle", async () => {
    const D3DUSAGE_RENDERTARGET = 1;
    const payload = Buffer.alloc(32);
    payload.writeUInt32LE(DEVICE, 0);
    payload.writeUInt32LE(0x501, 4);
    payload.writeUInt32LE(0, 8);
    payload.writeUInt32LE(0x80402010, 12);
    [4, 6, 20, 22].forEach((value, index) =>
        payload.writeInt32LE(value, 16 + index * 4));
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0x501, 64, 64, 1, 21, D3DUSAGE_RENDERTARGET, 0)),
        command(OP.COLOR_FILL, payload),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.blitsSkipped, 0);
    assert.equal(executor.stats.colorFills, 1);
    const pass = find("beginRenderPass").pop()[2];
    assert.equal(pass.descriptor.colorAttachments[0].loadOp, "load",
        "a sub-rect fill must retain the rest of the attachment");
    assert.deepEqual(pass.ops.find(op => op[0] === "viewport").slice(1, 5),
        [4, 6, 16, 16]);
    assert.deepEqual(pass.ops.find(op => op[0] === "draw"), ["draw", 3]);
});

await test("M4 target fills and copies retain D3D command order", async () => {
    const D3DUSAGE_RENDERTARGET = 1;
    const fill = Buffer.alloc(32);
    fill.writeUInt32LE(DEVICE, 0);
    fill.writeUInt32LE(0x501, 4);
    fill.writeUInt32LE(0, 8);
    fill.writeUInt32LE(0xff204060, 12);
    [0, 0, 64, 64].forEach((value, index) =>
        fill.writeInt32LE(value, 16 + index * 4));
    const stretch = Buffer.alloc(56);
    stretch.writeUInt32LE(DEVICE, 0);
    stretch.writeUInt32LE(0x501, 4);
    stretch.writeUInt32LE(0, 8);
    [0, 0, 64, 64].forEach((value, index) =>
        stretch.writeInt32LE(value, 12 + index * 4));
    stretch.writeUInt32LE(0x502, 28);
    stretch.writeUInt32LE(0, 32);
    [0, 0, 64, 64].forEach((value, index) =>
        stretch.writeInt32LE(value, 36 + index * 4));
    stretch.writeUInt32LE(1, 52);
    const { executor, fake } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0x501, 64, 64, 1, 21, D3DUSAGE_RENDERTARGET, 0)),
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0x502, 64, 64, 1, 21, D3DUSAGE_RENDERTARGET, 0)),
        command(OP.COLOR_FILL, fill),
        command(0x8, stretch),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    const fillIndex = fake.calls.findIndex(call => call[0] === "beginRenderPass");
    const copyIndex = fake.calls.findIndex(call => call[0] ===
        "copyTextureToTexture");
    assert.ok(fillIndex >= 0 && copyIndex > fillIndex,
        "ColorFill must be encoded before the following StretchRect copy");
    assert.equal(executor.stats.queueSubmits, 1,
        "ordered target operations share the Present submission");
});

await test("M4 Clear honours its rectangle list", async () => {
    const clear = Buffer.alloc(40);
    clear.writeUInt32LE(DEVICE, 0);
    clear.writeUInt32LE(1, 4); // D3DCLEAR_TARGET
    clear.writeUInt32LE(0xff336699, 8);
    clear.writeFloatLE(1, 12);
    clear.writeUInt32LE(0, 16);
    clear.writeUInt32LE(1, 20);
    [8, 10, 28, 34].forEach((value, index) =>
        clear.writeInt32LE(value, 24 + index * 4));
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CLEAR, clear),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    assert.equal(executor.stats.partialClears, 1);
    const pass = find("beginRenderPass").pop()[2];
    assert.equal(pass.descriptor.colorAttachments[0].loadOp, "load");
    assert.deepEqual(pass.ops.find(op => op[0] === "viewport").slice(1, 5),
        [8, 10, 20, 24]);
    assert.deepEqual(pass.ops.find(op => op[0] === "draw"), ["draw", 3]);
});

// WebGPU requires a pipeline's attachment state -- colour formats, presence of
// a depth-stencil attachment, sample count -- to match the pass it draws into.
// The rectangle-clear pipeline cache keyed only on the clear flags, so the
// pipeline built for a depth-less pass was handed to a pass that had depth:
// setPipeline failed validation, the whole command buffer was rejected, and
// the frame drew nothing. 3DMark 2001 reached this the moment one pass dropped
// depth (an undersized depth surface does exactly that) and the next had it.
await test("a rectangle clear caches one pipeline per pass attachment state",
        async () => {
    const clear = Buffer.alloc(40);
    clear.writeUInt32LE(DEVICE, 0);
    clear.writeUInt32LE(1, 4); // D3DCLEAR_TARGET
    clear.writeUInt32LE(0xff336699, 8);
    clear.writeFloatLE(1, 12);
    clear.writeUInt32LE(0, 16);
    clear.writeUInt32LE(1, 20);
    [0, 0, 16, 16].forEach((value, index) =>
        clear.writeInt32LE(value, 24 + index * 4));
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CLEAR, clear),
        // Unbind the depth surface, so the next clear's pass has no
        // depth-stencil attachment while the clear flags stay identical.
        command(OP.SET_DEPTH_STENCIL_SURFACE_LEVEL,
            u32(DEVICE, 0, 0, 640, 480)),
        command(OP.CLEAR, clear),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true }));
    await executor.idle();
    const pipelines = find("createRenderPipeline").map(call => call[1])
        .filter(descriptor =>
            (descriptor.label || "").startsWith("D3D9 rectangle clear"));
    assert.equal(pipelines.length, 2,
        "the two passes disagree about depth, so they cannot share a pipeline");
    assert.ok(pipelines.some(descriptor => descriptor.depthStencil),
        "the pass that has a depth attachment needs a depth-stencil state");
    assert.ok(pipelines.some(descriptor => !descriptor.depthStencil),
        "the pass without one must not declare a depth-stencil state");
});

// WebGPU counts a block-compressed copy in whole 4x4 blocks, and a mip level's
// physical extent is its logical size rounded up to that grid. The tail of a
// DXT mip chain is logically 2x2 and 1x1, so passing the logical size makes
// writeTexture fail validation. That failure arrives as an uncaptured device
// error rather than an exception, so the only symptom is that the smallest mips
// keep whatever the texture was created with -- which is how Kart Rider's UI
// atlases sampled as garbage while the console filled with "copySize.width (1)
// is not a multiple of compressed texture format block width (4)".
await test("a DXT mip chain's sub-block levels upload as whole 4x4 blocks",
        async () => {
    const { executor, find } = makeExecutor();
    const DXT1 = 0x31545844;
    // 8x8 DXT1 with a full chain: 8x8, 4x4, 2x2, 1x1. Every level occupies at
    // least one 8-byte block, and the last two are smaller than one block.
    const level = (index, size) => {
        const blockRow = Math.ceil(size / 4) * 8;
        const bytes = blockRow * Math.ceil(size / 4);
        const payload = Buffer.alloc(48);
        payload.writeUInt32LE(0x401, 0);
        payload.writeUInt32LE(index, 4);
        payload.writeUInt32LE(0, 8);       // x
        payload.writeUInt32LE(0, 12);      // y
        payload.writeUInt32LE(0, 16);      // z
        payload.writeUInt32LE(size, 20);   // logical width
        payload.writeUInt32LE(size, 24);   // logical height
        payload.writeUInt32LE(1, 28);      // depth
        payload.writeUInt32LE(blockRow, 32); // row pitch, in bytes per block row
        payload.writeUInt32LE(0, 36);
        payload.writeUInt32LE(bytes, 40);
        return { payload, blob: Buffer.alloc(bytes, index + 1), field: 44 };
    };
    const uploads = [[0, 8], [1, 4], [2, 2], [3, 1]]
        .map(([index, size]) => level(index, size));
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_TEXTURE_2D, u32(DEVICE, 0x401, 8, 8, 4, DXT1, 0, 1)),
        ...uploads.map(upload =>
            command(OP.UPDATE_TEXTURE, upload.payload, upload.blob, upload.field)),
    ]));
    await executor.idle();

    // The executor also writes its 1x1 fallback texture, which carries no
    // mipLevel; only the mip uploads are of interest here.
    const writes = find("writeTexture")
        .filter(call => call[1].mipLevel !== undefined);
    assert.equal(writes.length, 4, "every level has to be written");
    for (const write of writes) {
        const mipLevel = write[1].mipLevel;
        const size = write[4];
        assert.equal(size.width % 4, 0,
            "level " + mipLevel + " copy width " + size.width +
            " is not a whole number of 4x4 blocks");
        assert.equal(size.height % 4, 0,
            "level " + mipLevel + " copy height " + size.height +
            " is not a whole number of 4x4 blocks");
        // Rounding up must not overshoot the level's physical extent either.
        const physical = Math.max(4, Math.ceil((8 >> mipLevel) / 4) * 4);
        assert.equal(size.width, physical);
        assert.equal(size.height, physical);
    }
});

// PRESENT carries the window's *client rect* so the page can place the overlay
// canvas; emit_present_and_flush fills it from GetClientRect. It is not the back
// buffer's size, and a windowed game's client area is shorter than the back
// buffer it hosts. Treating it as the render size made the swap-chain colour
// attachment look like it disagreed with the auto depth target created beside
// it, and the mismatch path then dropped depth for every pass -- depth testing
// off for the whole game, from a window border.
await test("a client rect smaller than the back buffer keeps depth attached",
        async () => {
    const { executor, find } = makeExecutor();
    // 640x467 client rect for a 640x480 back buffer: the window has a title bar.
    const clientRect = u32(DEVICE, 0x1234, 0, 0, 640, 467);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.PRESENT, clientRect),
    ], { present: true }));
    await executor.idle();

    await executor.submit(buildBatch([
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 240)),
        command(OP.SET_FVF, fvfPayload(0x104, [
            element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 12)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, clientRect),
    ], { present: true }));
    await executor.idle();

    assert.equal(executor.stats.depthTargetSizeMismatches, 0,
        "the client rect must not be mistaken for the back buffer's size");
    const pass = find("beginRenderPass").pop()[1];
    assert.ok(pass.depthStencilAttachment,
        "the back-buffer pass keeps its auto depth-stencil");
});

// D3D9 rasterises with the sample point at a pixel's integer corner; WebGPU
// samples at the pixel centre. A title that blits UI 1:1 has already subtracted
// that half pixel itself, so replaying its geometry unchanged lands every
// sample on a texel boundary and bilinear filtering returns the mean of two
// texels -- invisible on 3D art, ruinous on small text. XYZRHW UI is the case
// that shows it, but the offset belongs on every fixed-function draw.
await test("fixed-function draws carry the D3D9 half-pixel offset", async () => {
    const { executor, find } = makeExecutor();
    const drawWith = position => buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 240)),
        command(OP.SET_FVF, fvfPayload(0x104, [
            element(0, 0, DECLTYPE.FLOAT4, position),
            element(0, 16, DECLTYPE.D3DCOLOR, DECLUSAGE.COLOR)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
    ]);

    // POSITIONT: pre-transformed UI, the path the shop text goes through.
    await executor.submit(drawWith(DECLUSAGE.POSITIONT));
    await executor.idle();
    // POSITION: ordinary world-space geometry, through world_view_projection.
    await executor.submit(drawWith(DECLUSAGE.POSITION));
    await executor.idle();

    const vertexShaders = find("createShaderModule")
        .map(call => call[1].code)
        .filter(code => code.includes("d9_vs_main"));
    assert.ok(vertexShaders.length >= 2,
        "both a screen-space and a world-space vertex shader were built");
    for (const code of vertexShaders) {
        assert.ok(code.includes(
            "result.position.x + result.position.w / uniforms.viewport.x"),
            "a fixed-function vertex shader is missing the half-pixel offset");
        // Screen y grows downward, NDC y grows upward: the y term is negated.
        assert.ok(code.includes(
            "result.position.y - result.position.w / uniforms.viewport.y"),
            "the half-pixel offset must negate y");
    }
});

// The same case as "blend data with D3DRS_VERTEXBLEND disabled", reached from
// the FVF side rather than a real declaration, and with the four-weight shape a
// skinned mesh actually ships. D3D9 poses this by D3DTS_WORLD alone because the
// render state never enabled blending, and so does this -- but a model stuck in
// bind pose looks like a working draw, so the count is what makes the case
// visible when it turns out to be the reason a character does not move.
await test("a fixed-function skinned declaration is counted when blending is off",
        async () => {
    const { executor } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 240)),
        command(OP.SET_FVF, fvfPayload(0x104, [
            element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
            element(0, 12, DECLTYPE.FLOAT4, DECLUSAGE.BLENDWEIGHT),
            element(0, 28, DECLTYPE.UBYTE4, DECLUSAGE.BLENDINDICES),
            element(0, 32, DECLTYPE.FLOAT3, DECLUSAGE.NORMAL)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 44)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
    ]));
    await executor.idle();
    assert.equal(executor.stats.drawsWithUnappliedVertexBlend, 1,
        "a declaration carrying blend weights has to be counted");
});

// XYZRHW coordinates are absolute render-target pixels. setViewport already
// puts the viewport's origin back when it maps NDC into the viewport rect, so
// the shader has to take that origin off first. Getting this wrong cancels out
// exactly when the viewport sits at 0,0 -- which is every full-screen UI pass,
// and is why it stayed invisible until a game drew pre-transformed geometry
// through a small offset viewport (Kart Rider's shop item panels) and the
// geometry landed several viewport-widths outside the box.
await test("pre-transformed geometry subtracts the viewport origin",
        async () => {
    const { executor, find } = makeExecutor();
    const viewport = Buffer.alloc(32);
    viewport.writeUInt32LE(DEVICE, 0);
    viewport.writeUInt32LE(368, 4);   // x
    viewport.writeUInt32LE(104, 8);   // y
    viewport.writeUInt32LE(110, 12);  // width
    viewport.writeUInt32LE(109, 16);  // height
    viewport.writeFloatLE(0, 20);
    viewport.writeFloatLE(1, 24);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(800, 600)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x201, 1, 240)),
        command(OP.SET_VIEWPORT, viewport),
        command(OP.SET_FVF, fvfPayload(0x104, [
            element(0, 0, DECLTYPE.FLOAT4, DECLUSAGE.POSITIONT),
            element(0, 16, DECLTYPE.D3DCOLOR, DECLUSAGE.COLOR)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x201, 20)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        // Constants are staged and go up with the frame's submit, so the
        // upload only exists once the frame is actually presented.
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 800, 600)),
    ], { present: true }));
    await executor.idle();

    const vertexShader = find("createShaderModule").map(call => call[1].code)
        .filter(code => code.includes("d9_vs_main")).pop();
    assert.ok(vertexShader, "a screen-space vertex shader was built");
    assert.ok(vertexShader.includes("- viewport.z") &&
        vertexShader.includes("- viewport.w"),
        "the XYZRHW path must subtract the viewport origin:\n" + vertexShader);

    // The origin has to actually reach the uniform, not just the WGSL.
    const writes = find("writeBuffer");
    assert.ok(writes.length > 0, "constants were uploaded");
    const carriesOrigin = writes.some(call => {
        // call[6] is the snapshot of exactly the bytes this write sent, which
        // for a staged ring upload is its used prefix rather than the whole
        // mirror.
        const data = call[6];
        if (!data || !data.byteLength) return false;
        const floats = new Float32Array(data.buffer, data.byteOffset,
            Math.floor(data.byteLength / 4));
        for (let i = 0; i + 3 < floats.length; ++i) {
            if (floats[i] === 110 && floats[i + 1] === 109 &&
                    floats[i + 2] === 368 && floats[i + 3] === 104)
                return true;
        }
        return false;
    });
    assert.ok(carriesOrigin,
        "the viewport uniform must carry size in xy and origin in zw");
});

await test("volume textures allocate 3D storage and upload every slice", async () => {
    const { executor, find } = makeExecutor();
    const pixels = Buffer.alloc(32);
    for (let i = 0; i < pixels.length; ++i) pixels[i] = i;
    // D9WGUpdateTexture: handle, level, xyz, whd, row/slice pitch,
    // byte count and batch-relative data offset.
    const update = u32(0x900, 0, 0, 0, 0, 2, 2, 2, 8, 16, 32, 0);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_TEXTURE_VOLUME,
            u32(DEVICE, 0x900, 2, 2, 2, 1, 21, 0, 1, 0)),
        command(OP.UPDATE_TEXTURE, update, pixels, 44),
    ], { versionMinor: 3 }));
    await executor.idle();

    const resource = executor.resources.get(0x900);
    assert.equal(resource.textureType, "3d");
    const descriptor = find("createTexture").find(call =>
        call[1].label === "D3D9 volume texture")[1];
    assert.equal(descriptor.dimension, "3d");
    assert.deepEqual(descriptor.size,
        { width: 2, height: 2, depthOrArrayLayers: 2 });
    const upload = find("writeTexture").pop();
    assert.deepEqual(upload[4],
        { width: 2, height: 2, depthOrArrayLayers: 2 });
    assert.equal(upload[3].rowsPerImage, 2);
    assert.equal(executor.stats.volumeTexturesCreated, 1);
});

await test("GPU render-target readback writes a converted D3D surface response",
        async () => {
    const { executor } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0x901, 2, 1, 1, 21, 1, 0)),
    ], { versionMinor: 3 }));
    await executor.idle();
    // The physical texture is rgba8unorm. GetRenderTargetData must return
    // D3DFMT_A8R8G8B8's in-memory BGRA byte order.
    executor.resources.get(0x901).gpuTexture.readbackData =
        Uint8Array.from([0x11, 0x22, 0x33, 0x44,
            0x55, 0x66, 0x77, 0x88]);
    executor.resources.get(0x901).gpuTexture.readbackPitch = 8;
    const writes = [];
    const responseOffset = 16 * 1024;
    await executor.submit(buildBatch([
        command(OP.READBACK_SURFACE,
            u32(DEVICE, 0x901, 0, 21, 2, 1, 0, 1, 8, 8,
                responseOffset, 0x12345678)),
    ], { versionMinor: 3 }), {
        writeGuestMemory(offset, data) {
            // The host bumps a liveness counter once per batch at the very top
        // of the response region; it is not a response to anything, so it
        // must not be counted as one.
        if (offset === HEARTBEAT_WRITE_OFFSET) return;
        writes.push({ offset, data: Buffer.from(data) });
        },
    });
    await executor.idle();

    assert.equal(writes.length, 1);
    assert.equal(writes[0].offset, 12 * 1024 * 1024 + responseOffset);
    assert.equal(writes[0].data.readUInt32LE(0), 0x12345678);
    assert.equal(writes[0].data.readUInt32LE(4), 8);
    assert.equal(writes[0].data.readUInt32LE(12), 1);
    assert.deepEqual([...writes[0].data.subarray(16)],
        [0x33, 0x22, 0x11, 0x44, 0x77, 0x66, 0x55, 0x88]);
    assert.equal(executor.stats.renderTargetReadbacks, 1);
});

await test("DirectDraw P8 readback preserves raw indices and destination pitch",
        async () => {
    const { executor } = makeExecutor();
    const P8 = 41;
    const DD_INDEXED = 0x80000000;
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0x902, 4, 2, 1, P8, DD_INDEXED, 0, 0, 0)),
    ], { versionMinor: 7 }));
    await executor.idle();
    const texture = executor.resources.get(0x902).gpuTexture;
    texture.readbackData = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    texture.readbackPitch = 4;
    const writes = [];
    const responseOffset = 16 * 1024;
    await executor.submit(buildBatch([
        command(OP.READBACK_SURFACE,
            u32(DEVICE, 0x902, 0, P8, 4, 2, 0, 2, 8, 16,
                responseOffset, 0x31415926, 0)),
    ], { versionMinor: 7 }), { writeGuestMemory(offset, data) {
        if (offset !== HEARTBEAT_WRITE_OFFSET)
            writes.push(Buffer.from(data));
    } });
    await executor.idle();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].readUInt32LE(4), 16);
    assert.deepEqual([...writes[0].subarray(16)],
        [1, 2, 3, 4, 0, 0, 0, 0, 5, 6, 7, 8, 0, 0, 0, 0]);
});

await test("DXT cube readback returns one raw block from the selected mip face",
        async () => {
    const { executor, find } = makeExecutor();
    const DXT1 = 0x31545844;
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_TEXTURE_CUBE,
            u32(DEVICE, 0x903, 8, 4, DXT1, 0, 0, 0)),
    ], { versionMinor: 7 }));
    await executor.idle();
    const texture = executor.resources.get(0x903).gpuTexture;
    texture.readbackData = Uint8Array.from(
        [0x10, 0x21, 0x32, 0x43, 0x54, 0x65, 0x76, 0x87]);
    texture.readbackPitch = 8;
    const writes = [];
    await executor.submit(buildBatch([
        command(OP.READBACK_SURFACE,
            u32(DEVICE, 0x903, 2, DXT1, 2, 2, 0, 2, 8, 8,
                16 * 1024, 0x27182818, 5)),
    ], { versionMinor: 7 }), { writeGuestMemory(offset, data) {
        if (offset !== HEARTBEAT_WRITE_OFFSET)
            writes.push(Buffer.from(data));
    } });
    await executor.idle();
    assert.equal(writes.length, 1);
    assert.deepEqual([...writes[0].subarray(16)],
        [0x10, 0x21, 0x32, 0x43, 0x54, 0x65, 0x76, 0x87]);
    const copy = find("copyTextureToBuffer").pop();
    assert.equal(copy[1].mipLevel, 2);
    assert.deepEqual(copy[1].origin, { x: 0, y: 0, z: 5 });
    assert.deepEqual(copy[3],
        { width: 4, height: 4, depthOrArrayLayers: 1 });
});

await test("back-buffer readback uses a persistent post-Present snapshot",
        async () => {
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CLEAR, u32(DEVICE, 1, 0xff000000, 0x3f800000, 0, 0)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true, versionMinor: 3 }));
    await executor.idle();
    // The readback request arrives in a later task, by which time a canvas
    // texture would have expired; the owned back buffer has not.
    const snapshot = executor.backBufferTexture;
    assert.ok(snapshot, "the back buffer must outlive the task that drew it");
    snapshot.readbackData = new Uint8Array(640 * 4);
    snapshot.readbackData.set([0x11, 0x22, 0x33, 0x44]);
    snapshot.readbackPitch = 640 * 4;

    const writes = [];
    await executor.submit(buildBatch([
        command(OP.READBACK_SURFACE,
            u32(DEVICE, 0, 0, 21, 640, 480, 0, 1, 640 * 4, 640 * 4,
                16 * 1024, 0x22334455)),
    ], { versionMinor: 3 }), { writeGuestMemory(offset, data) {
        // The host bumps a liveness counter once per batch at the very top
        // of the response region; it is not a response to anything, so it
        // must not be counted as one.
        if (offset === HEARTBEAT_WRITE_OFFSET) return;
        writes.push({ offset, data: Buffer.from(data) });
    } });
    await executor.idle();

    const copy = find("copyTextureToBuffer").pop();
    assert.equal(copy[1].texture, snapshot);
    assert.equal(writes.length, 1);
    // The canvas is physically BGRA, already the memory order D3D9 expects.
    assert.deepEqual([...writes[0].data.subarray(16, 20)],
        [0x11, 0x22, 0x33, 0x44]);
    assert.equal(executor.stats.backBufferPresents, 1);
});

await test("event queries complete only after the submitted GPU fence", async () => {
    const { executor, fake } = makeExecutor();
    const writes = [];
    const metadata = { writeGuestMemory(offset, data) {
        // The host bumps a liveness counter once per batch at the very top
        // of the response region; it is not a response to anything, so it
        // must not be counted as one.
        if (offset === HEARTBEAT_WRITE_OFFSET) return;
        writes.push({ offset, data: Buffer.from(data) });
    } };
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_QUERY, u32(DEVICE, 0x902, 8, 0)),
        command(OP.END_QUERY, u32(DEVICE, 0x902, 0, 41)),
    ], { versionMinor: 3 }), metadata);
    await executor.idle();
    assert.equal(writes.length, 0, "an event query is not an immediate CPU answer");
    fake.completeSubmittedWork();
    await Promise.resolve();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].offset, 12 * 1024 * 1024);
    assert.equal(writes[0].data.readUInt32LE(0), 41);
    assert.equal(writes[0].data.readUInt32LE(4), 1);
    assert.equal(writes[0].data.readUInt32LE(12), 1);
    assert.equal(executor.stats.eventQueriesResolved, 1);
});

await test("occlusion queries return the GPU query-set sample count", async () => {
    const { executor } = makeExecutor();
    const writes = [];
    const elements = [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)];
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x903, 1, 36)),
        command(OP.SET_FVF, fvfPayload(0x2, elements)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x903, 12)),
        command(OP.CREATE_QUERY, u32(DEVICE, 0x904, 9, 16)),
        command(OP.BEGIN_QUERY, u32(DEVICE, 0x904, 16, 50)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.END_QUERY, u32(DEVICE, 0x904, 16, 51)),
    ], { versionMinor: 3 }), { writeGuestMemory(offset, data) {
        // The host bumps a liveness counter once per batch at the very top
        // of the response region; it is not a response to anything, so it
        // must not be counted as one.
        if (offset === HEARTBEAT_WRITE_OFFSET) return;
        writes.push({ offset, data: Buffer.from(data) });
    } });
    await executor.idle();
    await Promise.resolve();

    assert.equal(writes.length, 1);
    assert.equal(writes[0].data.readUInt32LE(0), 51);
    assert.equal(writes[0].data.readUInt32LE(4), 37);
    assert.equal(writes[0].data.readUInt32LE(12), 1);
    assert.equal(executor.stats.occlusionQueriesResolved, 1);
});

await test("occlusion queries accumulate GPU segments across Present", async () => {
    const { executor } = makeExecutor();
    const writes = [];
    const metadata = { writeGuestMemory(offset, data) {
        // The host bumps a liveness counter once per batch at the very top
        // of the response region; it is not a response to anything, so it
        // must not be counted as one.
        if (offset === HEARTBEAT_WRITE_OFFSET) return;
        writes.push({ offset, data: Buffer.from(data) });
    } };
    const elements = [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)];
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x914, 1, 36)),
        command(OP.SET_FVF, fvfPayload(0x2, elements)),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x914, 12)),
        command(OP.CREATE_QUERY, u32(DEVICE, 0x915, 9, 80)),
        command(OP.BEGIN_QUERY, u32(DEVICE, 0x915, 80, 70)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true, versionMinor: 3 }), metadata);
    await executor.idle();
    await Promise.resolve();
    assert.equal(writes.length, 0, "BEGIN remains pending across Present");

    await executor.submit(buildBatch([
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.END_QUERY, u32(DEVICE, 0x915, 80, 71)),
    ], { versionMinor: 3 }), metadata);
    await executor.idle();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].data.readUInt32LE(0), 71);
    assert.equal(writes[0].data.readUInt32LE(4), 74);
    assert.equal(writes[0].data.readUInt32LE(12), 1);
    assert.equal(executor.stats.occlusionQueriesResolved, 1);
});

await test("timestamp, frequency and disjoint query classes return real results",
        async () => {
    const { executor, fake } = makeExecutor();
    const writes = [];
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_QUERY, u32(DEVICE, 0x908, 10, 32)),
        command(OP.CREATE_QUERY, u32(DEVICE, 0x909, 12, 48)),
        command(OP.CREATE_QUERY, u32(DEVICE, 0x90a, 11, 64)),
        command(OP.END_QUERY, u32(DEVICE, 0x908, 32, 61)),
        command(OP.END_QUERY, u32(DEVICE, 0x909, 48, 62)),
        command(OP.END_QUERY, u32(DEVICE, 0x90a, 64, 63)),
    ], { versionMinor: 3 }), { writeGuestMemory(offset, data) {
        // The host bumps a liveness counter once per batch at the very top
        // of the response region; it is not a response to anything, so it
        // must not be counted as one.
        if (offset === HEARTBEAT_WRITE_OFFSET) return;
        writes.push({ offset, data: Buffer.from(data) });
    } });
    await executor.idle();
    await Promise.resolve();
    assert.equal(writes.length, 1, "the GPU timestamp maps independently");
    assert.equal(writes[0].data.readUInt32LE(0), 61);
    assert.equal(writes[0].data.readUInt32LE(4), 1000);
    fake.completeSubmittedWork();
    await Promise.resolve();
    assert.equal(writes.length, 3);
    const byRequest = new Map(writes.map(write =>
        [write.data.readUInt32LE(0), write.data]));
    assert.equal(byRequest.get(62).readBigUInt64LE(4), 1000000000n);
    assert.equal(byRequest.get(63).readBigUInt64LE(4), 0n);
    assert.equal(executor.stats.timestampQueriesResolved, 1);
});

await test("enabled user clip planes reach both fixed shader stages", async () => {
    const D3DRS_CLIPPLANEENABLE = 152;
    const { executor, find } = makeExecutor();
    const plane = Buffer.alloc(24);
    plane.writeUInt32LE(DEVICE, 0);
    plane.writeUInt32LE(0, 4);
    plane.writeFloatLE(1, 8);
    plane.writeFloatLE(0, 12);
    plane.writeFloatLE(0, 16);
    plane.writeFloatLE(-0.25, 20);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x905, 1, 36)),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x905, 12)),
        command(OP.SET_CLIP_PLANE, plane),
        command(OP.SET_RENDER_STATE, u32(DEVICE, D3DRS_CLIPPLANEENABLE, 1, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true, versionMinor: 3 }));
    await executor.idle();

    const pipeline = find("createRenderPipeline").pop()[1];
    assert.match(pipeline.vertex.module.code,
        /dot\(d9_clip_position, uniforms\.clip_planes\[0\]\)/);
    assert.match(pipeline.vertex.module.code,
        /d9_clip_position = uniforms\.world_matrix \* in0/);
    assert.match(pipeline.fragment.module.code,
        /if \(stage_in\.clip0\.x < 0\.0\) \{ discard; \}/);
    assert.deepEqual(executor.devices.get(DEVICE).clipPlanes[0],
        [1, 0, 0, -0.25]);
});

await test("vs_3_0 vertex texture fetch binds D3D vertex sampler 0 at 34/35",
        async () => {
    const { executor, find } = makeExecutor();
    const vs = shaderCreatePayload(0x40000906, VS3_VERTEX_TEXTURE_FETCH);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x906, 1, 48)),
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0x907, 4, 4, 1, 21, 0, 1)),
        command(OP.CREATE_VERTEX_SHADER,
            vs.payload, vs.blob, vs.blobOffsetField),
        command(OP.SET_FVF, fvfPayload(0x2,
            [element(0, 0, DECLTYPE.FLOAT4, DECLUSAGE.POSITION)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x906, 16)),
        command(OP.SET_VERTEX_SHADER, u32(DEVICE, 0x40000906)),
        command(OP.SET_TEXTURE, u32(DEVICE, 256, 0x907, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true, versionMinor: 3 }));
    await executor.idle();

    assert.equal(executor.stats.droppedDraws, 0);
    const layout = find("createBindGroupLayout").pop()[1];
    assert.ok(layout.entries.some(entry => entry.binding === 34 &&
        entry.visibility === 1));
    assert.ok(layout.entries.some(entry => entry.binding === 35 &&
        entry.visibility === 1));
    const group = find("createBindGroup").pop()[1];
    assert.ok(group.entries.some(entry => entry.binding === 34));
    assert.ok(group.entries.some(entry => entry.binding === 35));
});

await test("programmable pixel samplers expose the complete s0 through s15 range",
        async () => {
    const { executor, find } = makeExecutor();
    const ps = shaderCreatePayload(0x40000908, PS_SAMPLER15_BYTECODE);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_BUFFER, createBufferPayload(0x90b, 1, 60)),
        command(OP.CREATE_TEXTURE_2D,
            u32(DEVICE, 0x90c, 4, 4, 1, 21, 0, 1)),
        command(OP.SET_FVF, fvfPayload(0x102,
            [element(0, 0, DECLTYPE.FLOAT3, DECLUSAGE.POSITION),
             element(0, 12, DECLTYPE.FLOAT2, DECLUSAGE.TEXCOORD)])),
        command(OP.SET_STREAM_SOURCE, setStreamSourcePayload(0, 0x90b, 20)),
        command(OP.CREATE_PIXEL_SHADER,
            ps.payload, ps.blob, ps.blobOffsetField),
        command(OP.SET_PIXEL_SHADER, u32(DEVICE, 0x40000908)),
        command(OP.SET_TEXTURE, u32(DEVICE, 15, 0x90c, 0)),
        command(OP.DRAW_PRIMITIVE, drawPrimitivePayload(4, 0, 1)),
        command(OP.PRESENT, u32(DEVICE, 0x1234, 0, 0, 640, 480)),
    ], { present: true, versionMinor: 3 }));
    await executor.idle();

    assert.equal(executor.stats.droppedDraws, 0);
    const layout = find("createBindGroupLayout").pop()[1];
    assert.ok(layout.entries.some(entry => entry.binding === 32));
    assert.ok(layout.entries.some(entry => entry.binding === 33));
});

// Guest-to-host diagnostics. Everything the guest DLL refuses used to be
// invisible from the page -- the console sees only valid commands, and the
// guest's trace file is inside a VM whose filesystem the developer cannot
// reach -- which repeatedly turned "the picture is wrong" into guesswork.
await test("a guest log command reaches the console with its text intact",
        async () => {
    const { executor } = makeExecutor();
    const text = "CreateVertexBuffer refused: length=0 usage=00000008";
    const payload = Buffer.alloc(8 + text.length);
    payload.writeUInt32LE(2, 0);            // severity: failed
    payload.writeUInt32LE(text.length, 4);
    payload.write(text, 8, "ascii");

    const errors = [];
    const realError = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    try {
        await executor.submit(buildBatch([
            command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
            command(OP.GUEST_LOG, payload),
        ]));
        await executor.idle();
    } finally {
        console.error = realError;
    }
    assert.equal(executor.stats.guestReports, 1);
    assert.equal(executor.stats.unsupportedCommands, 0,
        "the opcode has to be handled, not counted as unknown");
    assert.ok(errors.some(line => line === "[d3d9-guest] " + text),
        "the guest's text has to arrive verbatim, got: " + errors.join(" | "));
});

// The guest identifies itself at startup so that a session with no other
// guest messages means "nothing was refused" rather than "the DLL inside the
// disk image predates this channel and cannot say anything". Info severity has
// to reach the console like the rest, just not as a warning.
await test("an info-severity guest log is reported without being a warning",
        async () => {
    const { executor } = makeExecutor();
    const text = "proxy build guest-log-20260816 loaded";
    const payload = Buffer.alloc(8 + text.length);
    payload.writeUInt32LE(0, 0);            // severity: info
    payload.writeUInt32LE(text.length, 4);
    payload.write(text, 8, "ascii");

    const logs = [];
    const warnings = [];
    const realLog = console.log;
    const realWarn = console.warn;
    console.log = (...args) => logs.push(args.join(" "));
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
        await executor.submit(buildBatch([
            command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
            command(OP.GUEST_LOG, payload),
        ]));
        await executor.idle();
    } finally {
        console.log = realLog;
        console.warn = realWarn;
    }
    assert.equal(executor.stats.guestReports, 1);
    assert.ok(logs.some(line => line === "[d3d9-guest] " + text),
        "the identification line has to reach the console");
    assert.ok(!warnings.some(line => line.includes(text)),
        "identification is not a warning");
});

// Restoring a state replays the graphics journal, which holds every report
// since the guest started (3DMark06's: one identification line per process
// that loaded the DLL). Those were printed when they happened.
await test("a replayed guest log is kept but not printed again", async () => {
    const { executor } = makeExecutor();
    const text = "proxy build guest-log-20260816 loaded";
    const payload = Buffer.alloc(8 + text.length);
    payload.writeUInt32LE(0, 0);            // severity: info
    payload.writeUInt32LE(text.length, 4);
    payload.write(text, 8, "ascii");

    const printed = [];
    const real = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = (...args) => printed.push(args.join(" "));
    try {
        await executor.submit(buildBatch([
            command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
            command(OP.GUEST_LOG, payload),
        ]), { replay: true });
        await executor.idle();
    } finally {
        Object.assign(console, real);
    }
    assert.equal(executor.stats.guestReports, 1);
    assert.deepEqual(executor.guestReports, [text], "the black-screen report still has it");
    assert.ok(!printed.some(line => line.includes(text)),
        "a replay does not print it again: " + printed.join(" | "));
});

// A truncated length field must not read past the command into whatever
// follows it in the batch.
await test("a guest log claiming more text than it carries is rejected",
        async () => {
    const { executor } = makeExecutor();
    const payload = Buffer.alloc(12);
    payload.writeUInt32LE(1, 0);
    payload.writeUInt32LE(0xffff, 4); // far more than the 4 bytes present
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.GUEST_LOG, payload),
    ]));
    await executor.idle();
    assert.equal(executor.stats.malformedBatches, 1);
    assert.equal(executor.stats.guestReports, 0);
});

// ---- report ----

if (failures.length) {
    for (const failure of failures) {
        console.error("FAIL " + failure.name);
        console.error("  " + (failure.error && failure.error.message));
        if (process.env.D9_TEST_STACK) console.error(failure.error);
    }
    console.error("\n" + failures.length + " failed, " + passed + " passed");
    process.exit(1);
}
console.log(passed + " executor tests passed");
}

if (require.main === module) main().catch(error => { console.error(error); process.exit(1); });

module.exports = { makeExecutor, buildBatch, command, u32, createDevicePayload, createBufferPayload, shaderCreatePayload, fvfPayload, element, setStreamSourcePayload, drawPrimitivePayload, OP, DEVICE, DECLTYPE, DECLUSAGE };
