#!/usr/bin/env node
// Executor-level tests for the D9WG 1.7 DirectDraw group
// (glbridge/d3d9-webgpu/ddraw_ops.js) against a fake WebGPU device.
//
// These drive real D9WG batches -- built byte for byte the way ddraw_proxy.c
// emits them -- through the executor and assert on what comes out: which
// pipeline variant, which bindings, what lands in the blit uniform block, and
// which blits are refused rather than performed wrongly. The fake device
// reproduces the validation rule that bites hardest here (a bind group must
// supply exactly the bindings its layout declares), so a wiring mistake fails
// here rather than as a silent black screen inside v86.

"use strict";

const assert = require("node:assert/strict");
const P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
const encodePayload = (name, values) => Buffer.from(P.encode(name, values));
const { flushTextureUploads } = require("./d3d9_webgpu_executor_test.js");
const { errorScopes } = require("./fake_error_scopes.js");
const { D3D9WebGPUExecutor } = require("../../src/browser/glbridge/d3d9-webgpu/d3d9_executor.js");
const ddraw = require("../../src/browser/glbridge/d3d9-webgpu/ddraw_ops.js");
ddraw.installDDrawOps(D3D9WebGPUExecutor);

const OP = P.OP;

const BATCH_FLAG_PRESENT = 1;
const DEVICE = 0x00100002;
const FMT_X8R8G8B8 = 22;
const FMT_R5G6B5 = 23;
const FMT_P8 = 41;
const FMT_D16 = 80;
const USAGE_DEPTHSTENCIL = 0x2;
const USAGE_DDRAW_INDEXED = 0x80000000;

const DDBLT = {
    KEY_SOURCE: 1 << 0, KEY_DESTINATION: 1 << 1,
    MIRROR_X: 1 << 2, MIRROR_Y: 1 << 3,
    COLOR_FILL: 1 << 4, DEPTH_FILL: 1 << 5, FILTER_LINEAR: 1 << 6,
};

const DDOVER = {
    SHOW: 1 << 0, HIDE: 1 << 1,
    KEY_SOURCE: 1 << 2, KEY_DESTINATION: 1 << 3,
    MIRROR_X: 1 << 4, MIRROR_Y: 1 << 5,
    KEY_SOURCE_OVERRIDE: 1 << 6, KEY_DESTINATION_OVERRIDE: 1 << 7,
};

// ---- batch builder (same shape as d3d9_webgpu_executor_test.js) ----

function command(opcode, payload, blob, blobOffsetField) {
    return { opcode, payload, blob: blob || null, blobOffsetField };
}

function buildBatch(commands, options = {}) {
    const batch = Buffer.from(P.encodeBatch(commands.map(item => ({ opcode: item.opcode, payload: item.payload,
        blobs: item.blob ? [{ field: item.blobOffsetField, data: item.blob }] : [] })), {
        version_minor: options.versionMinor ?? 7, frame_id: options.frameId || 1,
        flags: options.present ? BATCH_FLAG_PRESENT : 0, session_id_low: options.sessionLow || 0, session_id_high: options.sessionHigh || 0,
    }));
    // Older framing tests locate/mutate the caller's payload after building.
    // Preserve that test API using schema offsets; packet assembly stays shared.
    let at = P.STRUCTS.BatchHeader.size;
    for (const item of commands) {
        if (item.blob) {
            const field = P.F[P.commandStruct(item.opcode)][item.blobOffsetField];
            new DataView(item.payload.buffer, item.payload.byteOffset, item.payload.byteLength)
                .setUint32(field, batch.readUInt32LE(at + P.STRUCTS.CommandHeader.size + field), true);
        }
        at += batch.readUInt32LE(at + P.F.CommandHeader.size);
    }
    return batch;
}

function u32(...values) {
    const buffer = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => buffer.writeUInt32LE(value >>> 0, index * 4));
    return buffer;
}

function createDevicePayload(width, height) { return encodePayload("CreateDevice", { device_handle: DEVICE, hwnd: 0x1234, width, height, backbuffer_format: FMT_X8R8G8B8, windowed: 1 }); }

function createSurfacePayload(handle, width, height, format, usage = 0, levelCount = 1) { return encodePayload("CreateTexture2D", { device_handle: DEVICE, resource_handle: handle, width, height, level_count: levelCount, format, usage }); }

function createCubePayload(handle, edge, levelCount, format, usage = 0) { return encodePayload("CreateTextureCube", { device_handle: DEVICE, resource_handle: handle, edge_length: edge, level_count: levelCount, format, usage }); }

function updateTexturePayload(handle, width, height, rowPitch, data, options = {}) {
    const payload = encodePayload("UpdateTexture", { resource_handle: handle, level: options.level || 0, x: options.x || 0, y: options.y || 0, z: options.face || 0,
        width, height, depth: 1, row_pitch: rowPitch, slice_pitch: options.slicePitch || rowPitch * height, data_bytes: data.length });
    return { payload, blob: data, blobOffsetField: "data_offset" };
}

function bltPayload(options) { return encodePayload("DDBlt", { device_handle: DEVICE, source_handle: options.sourceHandle || 0,
    source_level: options.sourceLevel || 0, source_face: options.sourceFace || 0, source_rect: options.sourceRect || [0, 0, 0, 0],
    destination_handle: options.destinationHandle || 0, destination_level: options.destinationLevel || 0, destination_face: options.destinationFace || 0,
    flags: options.flags || 0, destination_rect: options.destinationRect || [0, 0, 0, 0], fill_color: options.fillColor || 0, fill_depth: options.fillDepth || 0, fill_stencil: options.fillStencil || 0 }); }

function colorKeyPayload(handle, kind, low, high, present = 1) { return encodePayload("DDSetColorKey", { surface_handle: handle, key_kind: kind, color_low: low, color_high: high, present }); }

function overlayPayload(options) { return encodePayload("DDUpdateOverlay", { surface_handle: options.surfaceHandle, overlay_id: options.overlayId,
    source_rect: options.sourceRect || [0, 0, 0, 0], destination_rect: options.destinationRect || [0, 0, 0, 0], flags: options.flags || 0,
    z_order: options.zOrder || 0, destination_handle: options.destinationHandle || 0 }); }

function surfacePalettePayload(handle, index) { return encodePayload("DDSetSurfacePalette", { surface_handle: handle, palette_index: index, flags: 1 }); }

function displayModePayload(width, height, bpp, flags, changed) { return encodePayload("DDSetDisplayMode", { device_handle: DEVICE, width, height, bits_per_pixel: bpp, refresh_rate: 60, cooperative_flags: flags, guest_mode_changed: changed ? 1 : 0 }); }

function palettePayload(index, entries) { const payload = encodePayload("SetPalette", { device_handle: DEVICE, palette_index: index, entry_count: 256 });
    const blob = Buffer.alloc(256 * 4);for (let i = 0; i < 256; ++i) blob.writeUInt32LE(entries(i) >>> 0, i * 4);
    return { payload, blob, blobOffsetField: "data_offset" };
}

// ---- fake WebGPU ----

function makeFakeWebGPU() {
    const calls = [];
    class FakeBuffer {
        constructor(descriptor) {
            this.descriptor = descriptor;
            this.data = new Uint8Array(descriptor.size);
        }
        destroy() { this.destroyed = true; }
    }
    class FakeTexture {
        constructor(descriptor) { this.descriptor = descriptor; }
        createView(descriptor) { return { texture: this, descriptor }; }
        destroy() { this.destroyed = true; }
    }
    class FakePass {
        constructor(descriptor) {
            for (const attachment of descriptor.colorAttachments || []) {
                const storage = attachment?.view?.texture?.descriptor;
                if (storage?.usage !== undefined)
                    assert.ok(storage.usage & 0x10, "color attachment storage requires RENDER_ATTACHMENT");
            }
            this.descriptor = descriptor;
            calls.push(["beginRenderPass", descriptor, this]);
        }
        setPipeline(pipeline) { calls.push(["setPipeline", pipeline, this]); }
        setBindGroup(...a) { calls.push(["setBindGroup", ...a]); }
        setViewport(...a) { calls.push(["setViewport", ...a]); }
        setScissorRect(...a) { calls.push(["setScissorRect", ...a]); }
        setStencilReference(...a) { calls.push(["setStencilReference", ...a]); }
        setVertexBuffer(...a) { calls.push(["setVertexBuffer", ...a]); }
        setIndexBuffer(...a) { calls.push(["setIndexBuffer", ...a]); }
        draw(...a) { calls.push(["draw", ...a]); }
        drawIndexed(...a) { calls.push(["drawIndexed", ...a]); }
        end() { calls.push(["endPass", this]); }
    }
    class FakeEncoder {
        beginRenderPass(descriptor) { return new FakePass(descriptor); }
        copyTextureToTexture(...a) { calls.push(["copyTextureToTexture", ...a]); }
        copyBufferToTexture(source, destination, size) {
            assert.equal(source.offset % 256, 0);assert.equal(source.bytesPerRow % 256, 0);
            assert(source.buffer.usage & 4 || source.buffer.descriptor?.usage & 4, "upload source needs COPY_SRC");
            assert(source.offset + source.bytesPerRow * source.rowsPerImage * size.depthOrArrayLayers <= source.buffer.data.length);
            const format = destination.texture.descriptor.format;
            const bpp = ({ r16float: 2, rg16float: 4, rgba16float: 8, rg32float: 8, rgba32float: 16, r8uint: 1, r8unorm: 1 })[format] || 4;
            const compressed = format.startsWith("bc"), blockBytes = /^bc[14]-/.test(format) ? 8 : 16;
            const pitch = compressed ? Math.ceil(size.width / 4) * blockBytes : size.width * bpp;
            const rows = compressed ? Math.ceil(size.height / 4) : size.height;
            const data = new Uint8Array(pitch * rows * size.depthOrArrayLayers);
            for (let slice = 0; slice < size.depthOrArrayLayers; slice++) for (let row = 0; row < rows; row++) {
                const from = source.offset + (slice * source.rowsPerImage + row) * source.bytesPerRow;
                data.set(source.buffer.data.subarray(from, from + pitch), (slice * rows + row) * pitch);
            }
            calls.push(["copyBufferToTexture", source, destination, size, data, { bytesPerRow: pitch, rowsPerImage: rows }]);
        }
        copyTextureToBuffer(...a) { calls.push(["copyTextureToBuffer", ...a]); }
        copyBufferToBuffer(source, at, destination, offset, size) {
            destination.data.set(source.data.subarray(at, at + size), offset);
            calls.push(["copyBufferToBuffer", source, at, destination, offset, size]);
        }
        finish() { return { encoder: this }; }
    }
    const queue = {
        writeBuffer(buffer, offset, data, dataOffset, size) {
            const view = ArrayBuffer.isView(data)
                ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                : new Uint8Array(data);
            const start = dataOffset || 0, count = size === undefined ? view.length - start : size;
            const copied = view.slice(start, start + count);buffer.data.set(copied, offset);
            calls.push(["writeBuffer", buffer, offset, copied]);
        },
        writeTexture(destination, data, layout, size) {
            const view = ArrayBuffer.isView(data)
                ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                : new Uint8Array(data);
            calls.push(["writeTexture", destination, view.slice(), layout, size]);
        },
        submit(buffers) { calls.push(["submit", buffers]); },
        onSubmittedWorkDone() { return Promise.resolve(); },
    };
    const device = {
        queue,
        lost: new Promise(() => {}),
        ...errorScopes(),
        features: new Set(),
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
        createCommandEncoder() { return new FakeEncoder(); },
        createQuerySet(descriptor) {
            return { descriptor, values: new BigUint64Array(descriptor.count),
                destroy() {} };
        },
        createBindGroupLayout(descriptor) {
            const layout = { descriptor,
                bindings: new Set(descriptor.entries.map(e => e.binding)) };
            calls.push(["createBindGroupLayout", descriptor, layout]);
            return layout;
        },
        createPipelineLayout(descriptor) { return { descriptor }; },
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
            return { width: 640, height: 480,
                createView: () => ({ swapchain: true }) };
        },
    };
    const gpu = {
        async requestAdapter() {
            return { features: new Set(),
                async requestDevice() { return device; } };
        },
        getPreferredCanvasFormat() { return "bgra8unorm"; },
    };
    return { calls, device, context, gpu };
}

const liveExecutors = [];
function makeExecutor(options = {}) {
    const fake = makeFakeWebGPU();
    const canvas = { width: 1, height: 1, getContext: () => fake.context };
    const executor = new D3D9WebGPUExecutor(canvas, { gpu: fake.gpu, strict: true, ...options });
    liveExecutors.push(executor);
    return { fake, executor, calls: fake.calls,
        find: name => fake.calls.filter(call => call[0] === name),
        last: name => {
            const matches = fake.calls.filter(call => call[0] === name);
            return matches[matches.length - 1];
        } };
}

// The blit uniform block, read back out of the writeBuffer the replay made.
function uniformBytes(find, size) {
    const groups = find("createBindGroup").map(call => call[1]);
    const binding = groups.map(group => group.entries.find(entry => entry.binding === 0)?.resource).filter(resource => resource?.size === size).pop();
    assert.ok(binding, "no utility uniform binding of size " + size);
    const write = find("writeBuffer").filter(call => call[1] === binding.buffer && call[2] <= binding.offset && call[2] + call[3].length >= binding.offset + size).pop();
    assert.ok(write, "the bound utility uniform range was not uploaded");
    return write[3].subarray(binding.offset - write[2], binding.offset - write[2] + size);
}
function uniformBlock(find) {
    const bytes = uniformBytes(find, 128);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
        sourceRect: [view.getFloat32(0, true), view.getFloat32(4, true),
            view.getFloat32(8, true), view.getFloat32(12, true)],
        sourceSize: [view.getFloat32(16, true), view.getFloat32(20, true)],
        keyLow: [view.getUint32(32, true), view.getUint32(36, true),
            view.getUint32(40, true)],
        keyHigh: [view.getUint32(48, true), view.getUint32(52, true),
            view.getUint32(56, true)],
        fill: [view.getFloat32(64, true), view.getFloat32(68, true),
            view.getFloat32(72, true), view.getFloat32(76, true)],
        fillIndex: view.getUint32(80, true),
        destinationKeyLow: [view.getUint32(96, true),
            view.getUint32(100, true), view.getUint32(104, true)],
        destinationKeyHigh: [view.getUint32(112, true),
            view.getUint32(116, true), view.getUint32(120, true)],
    };
}

// ---- harness ----

const failures = [];
let passed = 0;

async function test(name, body) {
    try {
        await body();
        for (const executor of liveExecutors.splice(0)) {
            await executor.idle();
            assert.equal(executor.hostErrors.length, 0, "unexpected DirectDraw host error");
            assert.equal(executor.gpuErrors.errors.length, 0, "unexpected DirectDraw GPU error");
        }
        ++passed;
    } catch (error) {
        failures.push({ name, error });
    }
}

const SURFACE_SETUP = (handle, width, height, format, usage) =>
    command(OP.CREATE_TEXTURE_2D,
        createSurfacePayload(handle, width, height, format, usage));

async function main() {

await test("a palettised surface is stored as r8uint indices, not expanded to RGBA",
        async () => {
    const { executor, find } = makeExecutor();
    const indices = Buffer.alloc(4 * 4);
    for (let i = 0; i < indices.length; ++i) indices[i] = i * 7;
    const update = updateTexturePayload(0x300, 4, 4, 4, indices);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        SURFACE_SETUP(0x300, 4, 4, FMT_P8, USAGE_DDRAW_INDEXED),
        command(OP.UPDATE_TEXTURE, update.payload, update.blob,
            update.blobOffsetField),
    ]));
    const created = find("createTexture")
        .find(call => call[1].size.width === 4);
    assert.ok(created, "the surface was never created");
    assert.equal(created[1].format, "r8uint",
        "an indexed DirectDraw surface must keep its indices");
    const resource = executor.resources.get(0x300);
    assert.equal(resource.ddIndexed, true);
    assert.equal(resource.gpuBytesPerTexel, 1,
        "one byte per texel, not the four an expanded P8 would take");
    assert.equal(resource.textureShadows, undefined, "GPU indices must not retain a CPU texture copy");
    const upload = flushTextureUploads(executor, find).find(call =>
        call[1].texture === resource.gpuTexture);
    assert.ok(upload, "the r8uint texture itself was never uploaded");
    assert.deepEqual([...upload[2].subarray(0, 4)], [0, 7, 14, 21]);
});

await test("D3D sampling resolves a surface palette and keys the original index",
        async () => {
    const { executor, find } = makeExecutor();
    const indices = Buffer.from([7, 9]);
    const update = updateTexturePayload(0x300, 2, 1, 2, indices);
    const palette = palettePayload(3,
        index => (0xff000000 | (index << 16) | (index << 8)) >>> 0);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        SURFACE_SETUP(0x300, 2, 1, FMT_P8, USAGE_DDRAW_INDEXED),
        command(OP.UPDATE_TEXTURE, update.payload, update.blob,
            update.blobOffsetField),
        command(OP.SET_PALETTE, palette.payload, palette.blob,
            palette.blobOffsetField),
        command(OP.DD_SET_SURFACE_PALETTE, surfacePalettePayload(0x300, 3)),
        command(OP.DD_SET_COLOR_KEY, colorKeyPayload(0x300, 0, 9, 9)),
    ]));
    const resource = executor.resources.get(0x300);
    const sampled = executor.ddIndexedSampleViewFor(resource,
        resource.ddColorKey[0]);
    assert.ok(sampled, "no filterable sampling companion was created");
    const resolvedTexture = find("createTexture").find(call =>
        call[1].label === "DirectDraw indexed D3D sample view")[2];
    const resolve = executor.frame.ops.find(op => op.kind === "ddblit" && op.destinationView.texture === resolvedTexture);
    assert.ok(resolve, "the sampling companion needs an ordered GPU resolve");
    assert.equal(resolve.sourceView.texture, resource.gpuTexture);
    assert.equal(resolve.sourceKind, "index");assert.equal(resolve.keyToAlpha, true);
    assert.deepEqual(resolve.colorKey, resource.ddColorKey[0]);
    executor.finishFrame(false);
    assert.ok(find("beginRenderPass").some(call => call[1].colorAttachments[0].view.texture === resolvedTexture));
    assert.equal(executor.getStats().ddIndexedSampleResolves, 1);
});

await test("cube mip uploads and DirectDraw blits address the requested subresources",
        async () => {
    const { executor, find } = makeExecutor();
    const texels = Buffer.alloc(2 * 2 * 4, 0x5a);
    const update = updateTexturePayload(0x300, 2, 2, 8, texels,
        { level: 2, face: 5 });
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.CREATE_TEXTURE_CUBE,
            createCubePayload(0x300, 8, 4, FMT_X8R8G8B8)),
        SURFACE_SETUP(0x301, 2, 2, FMT_X8R8G8B8),
        command(OP.UPDATE_TEXTURE, update.payload, update.blob,
            update.blobOffsetField),
        command(OP.DD_BLT, bltPayload({
            sourceHandle: 0x300, sourceLevel: 2, sourceFace: 5,
            sourceRect: [0, 0, 2, 2],
            destinationHandle: 0x301, destinationRect: [0, 0, 2, 2],
        })),
    ], { present: true }));
    const cube = executor.resources.get(0x300);
    assert.equal(cube.textureType, "cube");
    assert.equal(cube.levelCount, 4);
    assert.equal(cube.layerCount, 6);
    const upload = flushTextureUploads(executor, find).find(call =>
        call[1].texture === cube.gpuTexture);
    assert.ok(upload, "the cube face/mip upload never reached WebGPU");
    assert.equal(upload[1].mipLevel, 2);
    assert.deepEqual(upload[1].origin, { x: 0, y: 0, z: 5 });
    const copy = find("copyTextureToTexture").find(call =>
        call[1].texture === cube.gpuTexture);
    assert.ok(copy, "the cube subresource blit was not copied");
    assert.equal(copy[1].mipLevel, 2);
    assert.deepEqual(copy[1].origin, { x: 0, y: 0, z: 5 });
    assert.equal(copy[2].mipLevel, 0);
    assert.deepEqual(copy[2].origin, { x: 0, y: 0, z: 0 });
});

await test("ordinary RGB and indexed cube faces support colour fills at every mip",
        async () => {
    const { executor, find } = makeExecutor();
    for (const [handle, format, usage] of [[0x330, FMT_X8R8G8B8, 0], [0x331, FMT_P8, USAGE_DDRAW_INDEXED]]) {
        await executor.submit(buildBatch([
            ...(handle === 0x330 ? [command(OP.CREATE_DEVICE, createDevicePayload(64, 64))] : []),
            command(OP.CREATE_TEXTURE_CUBE, createCubePayload(handle, 8, 3, format, usage)),
            ...Array.from({ length: 6 }, (_, face) => Array.from({ length: 3 }, (_, level) =>
                command(OP.DD_BLT, bltPayload({ destinationHandle: handle,
                    destinationFace: face, destinationLevel: level,
                    destinationRect: [0, 0, 8 >> level, 8 >> level],
                    flags: DDBLT.COLOR_FILL, fillColor: format === FMT_P8 ? 7 : 0xff123456 })))).flat(),
        ], { present: true }));
        await executor.idle();
        const resource = executor.resources.get(handle);
        assert.equal(resource.usage, usage, "public usage flags stay as requested");
        assert.ok(resource.gpuTexture.descriptor.usage & 0x10,
            "a normal colour cube must receive blit fills without the public render-target flag");
        for (let face = 0; face < 6; face++) for (let level = 0; level < 3; level++)
            assert.ok(find("beginRenderPass").some(call => {
                const view = call[1].colorAttachments?.[0]?.view;
                return view?.texture === resource.gpuTexture &&
                    (view.descriptor.baseArrayLayer || 0) === face && (view.descriptor.baseMipLevel || 0) === level;
            }), "missing cube colour attachment " + handle + ":" + face + ":" + level);
    }
    await executor.submit(buildBatch([
        command(OP.CREATE_TEXTURE_CUBE, createCubePayload(0x332, 8, 4, 0x31545844)),
    ]));
    assert.equal(executor.resources.get(0x332).gpuTexture.descriptor.usage & 0x10, 0,
        "block-compressed cubes must remain non-attachments");
    assert.equal(executor.stats.commandsFailed, 0);
});

await test("a plain same-format blit is a copy, not a render pass", async () => {
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        SURFACE_SETUP(0x300, 64, 64, FMT_P8, USAGE_DDRAW_INDEXED),
        SURFACE_SETUP(0x301, 64, 64, FMT_P8, USAGE_DDRAW_INDEXED),
        command(OP.DD_BLT, bltPayload({
            sourceHandle: 0x300, sourceRect: [0, 0, 32, 32],
            destinationHandle: 0x301, destinationRect: [8, 8, 40, 40],
        })),
    ], { present: true }));
    // Filtered by extent: a present copies the back buffer too, and that
    // copy is not the one under test.
    const copies = find("copyTextureToTexture")
        .filter(call => call[3] && call[3].width === 32);
    assert.equal(copies.length, 1, "the blit should be one texture copy");
    assert.deepEqual(copies[0][1].origin, { x: 0, y: 0, z: 0 });
    assert.deepEqual(copies[0][2].origin, { x: 8, y: 8, z: 0 });
    assert.deepEqual(copies[0][3], { width: 32, height: 32, depthOrArrayLayers: 1 });
    assert.equal(executor.getStats().ddBlitsCopied, 1);
    assert.deepEqual([...executor.resources.get(0x301).uploadedLevels], [0],
        "a GPU copy must initialize the destination level");
});

await test("a scaled DirectDraw blit initializes its texture destination",
        async () => {
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        SURFACE_SETUP(0x300, 320, 320, FMT_X8R8G8B8),
        SURFACE_SETUP(0x301, 256, 256, FMT_X8R8G8B8),
        command(OP.DD_BLT, bltPayload({
            sourceHandle: 0x300, sourceRect: [0, 0, 320, 320],
            destinationHandle: 0x301, destinationRect: [0, 0, 256, 256],
        })),
    ], { present: true }));
    const destination = executor.resources.get(0x301);
    assert.deepEqual([...destination.uploadedLevels], [0],
        "the render-blit path must count as a level-0 GPU write");
    assert.ok(find("createRenderPipeline").some(call =>
        String(call[1].label).startsWith("DirectDraw blit")),
    "the test must exercise the scaled render-blit path");
});

await test("a colour-keyed indexed blit discards on the index and stays indexed",
        async () => {
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        SURFACE_SETUP(0x300, 64, 64, FMT_P8, USAGE_DDRAW_INDEXED),
        SURFACE_SETUP(0x301, 64, 64, FMT_P8, USAGE_DDRAW_INDEXED),
        command(OP.DD_SET_COLOR_KEY, colorKeyPayload(0x300, 0, 253, 253)),
        command(OP.DD_BLT, bltPayload({
            sourceHandle: 0x300, sourceRect: [0, 0, 16, 16],
            destinationHandle: 0x301, destinationRect: [0, 0, 16, 16],
            flags: DDBLT.KEY_SOURCE,
        })),
    ], { present: true }));
    const pipeline = find("createRenderPipeline")
        .find(call => String(call[1].label).startsWith("DirectDraw blit"));
    assert.ok(pipeline, "no DirectDraw blit pipeline was created");
    assert.equal(pipeline[1].fragment.targets[0].format, "r8uint",
        "an indexed destination must be written as indices");
    const module = find("createShaderModule")
        .find(call => String(call[1].label).startsWith("ddraw blit"));
    assert.match(module[1].code, /texture_2d<u32>/,
        "an indexed source is read with textureLoad, not sampled");
    assert.match(module[1].code,
        /index >= blit\.key_low\.x && index <= blit\.key_high\.x/,
        "the colour key must compare the index itself");
    assert.match(module[1].code, /-> @location\(0\) vec4<u32>/);
    const block = uniformBlock(find);
    assert.equal(block.keyLow[0], 253);
    assert.equal(block.keyHigh[0], 253);
    assert.equal(executor.getStats().ddBlitsColorKeyed, 1);
});

await test("an indexed surface presented to the canvas resolves through its palette",
        async () => {
    const { executor, find } = makeExecutor();
    const palette = palettePayload(0, i => (0xff000000 | (i << 16)) >>> 0);
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        SURFACE_SETUP(0x300, 640, 480, FMT_P8, USAGE_DDRAW_INDEXED),
        command(OP.SET_PALETTE, palette.payload, palette.blob,
            palette.blobOffsetField),
        command(OP.DD_SET_SURFACE_PALETTE, surfacePalettePayload(0x300, 0)),
        command(OP.DD_BLT, bltPayload({
            sourceHandle: 0x300, sourceRect: [0, 0, 640, 480],
            destinationHandle: 0, destinationRect: [0, 0, 640, 480],
        })),
        command(OP.PRESENT, encodePayload("Present", { device_handle: DEVICE, hwnd: 0x1234, x: 0, y: 0, width: 640, height: 480 })),
    ], { present: true }));
    const module = find("createShaderModule")
        .find(call => String(call[1].label).includes("pal"));
    assert.ok(module, "no palette-resolving blit shader was built");
    assert.match(module[1].code, /d9dd_palette\.entries\[index\]/);
    const layout = find("createBindGroupLayout")
        .find(call => call[1].entries.some(entry => entry.binding === 3));
    assert.ok(layout, "the palette buffer has no binding");
    const paletteBuffer = find("createBuffer")
        .find(call => String(call[1].label || "").startsWith("DirectDraw palette"));
    assert.ok(paletteBuffer, "the palette was never uploaded to the GPU");
    assert.equal(paletteBuffer[1].size, 256 * 16);
    const copy = find("copyBufferToBuffer").find(call => call[3] === paletteBuffer[2]);
    assert.ok(copy, "the palette needs an ordered destination copy");
    assert.equal(find("writeBuffer").some(call => call[1] === paletteBuffer[2]), false);
    const floats = new Float32Array(paletteBuffer[2].data.buffer);
    // Entry 3 was 0xff030000: red = 3/255, and the wire is BGRA-ordered
    // D3DCOLOR, so the red channel has to survive the swap.
    assert.ok(Math.abs(floats[3 * 4] - 3 / 255) < 1e-6,
        "palette entry red channel: got " + floats[3 * 4]);
    assert.equal(floats[3 * 4 + 3], 1, "palette alpha");
});

await test("mirroring is a negative source extent, not a second pipeline",
        async () => {
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        SURFACE_SETUP(0x300, 64, 64, FMT_X8R8G8B8),
        SURFACE_SETUP(0x301, 64, 64, FMT_X8R8G8B8),
        command(OP.DD_BLT, bltPayload({
            sourceHandle: 0x300, sourceRect: [0, 0, 32, 32],
            destinationHandle: 0x301, destinationRect: [0, 0, 32, 32],
            flags: DDBLT.MIRROR_X,
        })),
    ], { present: true }));
    const block = uniformBlock(find);
    assert.equal(block.sourceRect[0], 0.5, "u starts at the right edge");
    assert.equal(block.sourceRect[2], -0.5, "and runs backwards");
    assert.equal(block.sourceRect[3], 0.5, "v is untouched");
    assert.equal(executor.getStats().ddBlitsMirrored, 1);
    const pipelines = find("createRenderPipeline")
        .filter(call => String(call[1].label).startsWith("DirectDraw blit"));
    assert.equal(pipelines.length, 1, "mirroring must not fork the pipeline");
});

await test("a destination rectangle clipped to the surface takes the source with it",
        async () => {
    const clipped = ddraw.clipRects(
        { left: 0, top: 0, right: 32, bottom: 32 },
        { left: -16, top: -16, right: 16, bottom: 16 }, 640, 480);
    assert.deepEqual(clipped.viewport, [0, 0, 16, 16]);
    assert.deepEqual(clipped.source,
        { left: 16, top: 16, right: 32, bottom: 32 },
        "the visible half of the sprite is the half that gets read");

    const scaled = ddraw.clipRects(
        { left: 0, top: 0, right: 32, bottom: 32 },
        { left: 0, top: 0, right: 64, bottom: 64 }, 32, 32);
    assert.deepEqual(scaled.viewport, [0, 0, 32, 32]);
    assert.deepEqual(scaled.source,
        { left: 0, top: 0, right: 16, bottom: 16 },
        "a 2x stretch clipped in half reads half the source");
});

await test("a true-colour blit into a palettised surface is refused", async () => {
    const warnings = [];
    const { executor } = makeExecutor({ onWarning: (...a) => warnings.push(a) });
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        SURFACE_SETUP(0x300, 64, 64, FMT_X8R8G8B8),
        SURFACE_SETUP(0x301, 64, 64, FMT_P8, USAGE_DDRAW_INDEXED),
        command(OP.DD_BLT, bltPayload({
            sourceHandle: 0x300, sourceRect: [0, 0, 16, 16],
            destinationHandle: 0x301, destinationRect: [0, 0, 16, 16],
        })),
    ], { present: true }));
    assert.equal(executor.getStats().ddBlitsSkipped, 1);
    assert.equal(executor.getStats().ddBlitsCopied, undefined);
});

await test("DDBLT_KEYSRC with no key attached is refused, not blitted opaquely",
        async () => {
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        SURFACE_SETUP(0x300, 64, 64, FMT_X8R8G8B8),
        SURFACE_SETUP(0x301, 64, 64, FMT_X8R8G8B8),
        command(OP.DD_BLT, bltPayload({
            sourceHandle: 0x300, sourceRect: [0, 0, 16, 16],
            destinationHandle: 0x301, destinationRect: [0, 0, 16, 16],
            flags: DDBLT.KEY_SOURCE,
        })),
    ], { present: true }));
    assert.equal(executor.getStats().ddBlitsSkipped, 1);
    assert.equal(find("copyTextureToTexture")
        .filter(call => call[3] && call[3].width === 16).length, 0,
        "nothing may be copied when the blit was refused");
});

await test("a destination colour key snapshots and tests the old target pixels",
        async () => {
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        SURFACE_SETUP(0x300, 64, 64, FMT_X8R8G8B8),
        SURFACE_SETUP(0x301, 64, 64, FMT_X8R8G8B8),
        command(OP.DD_SET_COLOR_KEY,
            colorKeyPayload(0x301, 1, 0x00112233, 0x00445566)),
        command(OP.DD_BLT, bltPayload({
            sourceHandle: 0x300, sourceRect: [0, 0, 16, 16],
            destinationHandle: 0x301, destinationRect: [0, 0, 16, 16],
            flags: DDBLT.KEY_DESTINATION,
        })),
    ], { present: true }));
    const destination = executor.resources.get(0x301);
    const snapshot = find("createTexture").find(call =>
        call[1].label === "DirectDraw destination colour-key snapshot");
    assert.ok(snapshot, "the target was not snapshotted before drawing");
    const copy = find("copyTextureToTexture").find(call =>
        call[1].texture === destination.gpuTexture &&
        call[2].texture === snapshot[2]);
    assert.ok(copy, "the key shader must read the pre-blit target pixels");
    const layout = find("createBindGroupLayout").find(call =>
        call[1].entries.some(entry => entry.binding === 4));
    assert.ok(layout, "the destination snapshot has no shader binding");
    const shader = find("createShaderModule").find(call =>
        String(call[1].label).includes("dest-key"));
    assert.ok(shader, "the destination-key shader variant was not selected");
    assert.match(shader[1].code, /d9dd_destination_key/);
    assert.match(shader[1].code,
        /any\(destination_quantised < blit\.destination_key_low\.rgb\)/);
    const block = uniformBlock(find);
    assert.deepEqual(block.destinationKeyLow, [0x11, 0x22, 0x33]);
    assert.deepEqual(block.destinationKeyHigh, [0x44, 0x55, 0x66]);
    assert.equal(executor.getStats().ddBlitsDestinationKeyed, 1);
    assert.equal(executor.getStats().ddBlitsSkipped, undefined);
});

await test("a destination-keyed self blit samples only a detached snapshot",
        async () => {
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        SURFACE_SETUP(0x300, 64, 64, FMT_X8R8G8B8),
        command(OP.DD_SET_COLOR_KEY,
            colorKeyPayload(0x300, 1, 0, 0x00ffffff)),
        command(OP.DD_BLT, bltPayload({
            sourceHandle: 0x300, sourceRect: [0, 0, 32, 32],
            destinationHandle: 0x300, destinationRect: [16, 16, 48, 48],
            flags: DDBLT.KEY_DESTINATION,
        })),
    ], { present: true }));
    const surface = executor.resources.get(0x300);
    const snapshot = find("createTexture").find(call =>
        call[1].label === "DirectDraw destination colour-key snapshot");
    assert.ok(snapshot);
    const bindGroup = find("createBindGroup").find(call =>
        call[1].entries.some(entry => entry.binding === 4));
    const sourceBinding = bindGroup[1].entries.find(entry => entry.binding === 1);
    const destinationBinding = bindGroup[1].entries.find(
        entry => entry.binding === 4);
    assert.equal(sourceBinding.resource.texture, snapshot[2]);
    assert.equal(destinationBinding.resource.texture, snapshot[2]);
    assert.notEqual(sourceBinding.resource.texture, surface.gpuTexture,
        "sampling a texture while rendering to it violates WebGPU validation");
});

await test("depth-fill on a colour target is still refused", async () => {
    const { executor } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        SURFACE_SETUP(0x301, 64, 64, FMT_X8R8G8B8),
        command(OP.DD_BLT, bltPayload({
            destinationHandle: 0x301, destinationRect: [0, 0, 16, 16],
            flags: DDBLT.DEPTH_FILL,
        })),
    ], { present: true }));
    assert.equal(executor.getStats().ddBlitsSkipped, 1);
});

await test("overlays composite by identity, z order, keys and mirroring",
        async () => {
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(320, 200)),
        SURFACE_SETUP(0x310, 64, 32, FMT_X8R8G8B8),
        SURFACE_SETUP(0x311, 320, 200, FMT_X8R8G8B8),
        command(OP.DD_SET_COLOR_KEY,
            colorKeyPayload(0x310, 2, 0x00010203, 0x00010203)),
        command(OP.DD_UPDATE_OVERLAY, overlayPayload({
            surfaceHandle: 0x310, overlayId: 0xabc001,
            sourceRect: [0, 0, 64, 32], destinationRect: [10, 20, 138, 84],
            flags: DDOVER.SHOW | DDOVER.KEY_SOURCE | DDOVER.MIRROR_X,
            zOrder: 7, destinationHandle: 0x311,
        })),
        command(OP.PRESENT, encodePayload("Present", { device_handle: DEVICE, hwnd: 0x1234, x: 0, y: 0, width: 320, height: 200 })),
    ], { present: true }));

    const state = executor.devices.get(DEVICE);
    assert.equal(state.ddOverlays.size, 1);
    const entry = state.ddOverlays.get(0xabc001);
    assert.ok(entry, "the overlay must be keyed by COM-surface identity");
    assert.equal(entry.surfaceHandle, 0x310);
    assert.equal(entry.zOrder, 7);
    const composite = find("createTexture").find(call =>
        call[1].label === "DirectDraw overlay composite");
    assert.ok(composite, "present did not build an overlay scanout image");
    const viewport = find("setViewport").find(call =>
        call[1] === 10 && call[2] === 20 && call[3] === 128 && call[4] === 64);
    assert.ok(viewport, "overlay destination position/stretch was lost");
    const block = uniformBlock(find);
    assert.equal(block.sourceRect[0], 1, "mirrored overlay begins at right edge");
    assert.equal(block.sourceRect[2], -1, "mirrored overlay walks backwards");
    assert.deepEqual(block.keyLow, [1, 2, 3]);
    assert.equal(executor.getStats().ddOverlayUpdates, 1);
    assert.equal(executor.getStats().ddOverlayComposites, 1);

    await executor.submit(buildBatch([
        command(OP.DD_UPDATE_OVERLAY, overlayPayload({
            surfaceHandle: 0x310, overlayId: 0xabc001,
            sourceRect: [0, 0, 64, 32], destinationRect: [10, 20, 138, 84],
            flags: DDOVER.HIDE, zOrder: 7, destinationHandle: 0x311,
        })),
        command(OP.PRESENT, encodePayload("Present", { device_handle: DEVICE, hwnd: 0x1234, x: 0, y: 0, width: 320, height: 200 })),
    ], { present: true, frameId: 2 }));
    assert.equal(state.ddOverlays.has(0xabc001), false,
        "hiding releases the host-side persistent overlay entry");
    assert.equal(executor.getStats().ddOverlayComposites, 1,
        "a hidden overlay must not be composited again");
});

await test("duplicate overlay aliases keep independent host state",
        async () => {
    const { executor } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(320, 200)),
        SURFACE_SETUP(0x310, 64, 32, FMT_X8R8G8B8),
        SURFACE_SETUP(0x311, 320, 200, FMT_X8R8G8B8),
        command(OP.DD_UPDATE_OVERLAY, overlayPayload({
            surfaceHandle: 0x310, overlayId: 0xabc001,
            sourceRect: [0, 0, 64, 32], destinationRect: [8, 8, 72, 40],
            flags: DDOVER.SHOW, zOrder: 0, destinationHandle: 0x311,
        })),
        command(OP.DD_UPDATE_OVERLAY, overlayPayload({
            surfaceHandle: 0x310, overlayId: 0xabc002,
            sourceRect: [0, 0, 64, 32], destinationRect: [80, 8, 144, 40],
            flags: DDOVER.SHOW | DDOVER.MIRROR_Y,
            zOrder: 1, destinationHandle: 0x311,
        })),
    ]));
    const overlays = executor.devices.get(DEVICE).ddOverlays;
    assert.equal(overlays.size, 2,
        "shared pixels must not collapse two COM overlay objects");
    assert.deepEqual(overlays.get(0xabc001).destinationRect, [8, 8, 72, 40]);
    assert.deepEqual(overlays.get(0xabc002).destinationRect,
        [80, 8, 144, 40]);
    assert.equal(overlays.get(0xabc001).visible, true);
    assert.equal(overlays.get(0xabc002).visible, true);
});

await test("DDBLT_DEPTHFILL clears the requested depth rectangle", async () => {
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        SURFACE_SETUP(0x302, 64, 64, FMT_D16, USAGE_DEPTHSTENCIL),
        command(OP.DD_BLT, bltPayload({
            destinationHandle: 0x302,
            destinationRect: [8, 12, 40, 44],
            flags: DDBLT.DEPTH_FILL, fillDepth: 0.5,
        })),
    ], { present: true }));
    const pass = find("beginRenderPass").find(call =>
        call[1].colorAttachments.length === 0 &&
        call[1].depthStencilAttachment);
    assert.ok(pass, "the depth fill did not open a depth-only render pass");
    const viewport = find("setViewport").find(call =>
        call[1] === 8 && call[2] === 12 && call[3] === 32 && call[4] === 32);
    assert.ok(viewport, "the depth fill did not preserve its destination rect");
    const bytes = uniformBytes(find, 32);
    const depth = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(16, true);
    assert.equal(depth, 0.5);
    assert.equal(executor.getStats().ddDepthFills, 1);
});

await test("a colour fill needs no source binding at all", async () => {
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        SURFACE_SETUP(0x300, 64, 64, FMT_P8, USAGE_DDRAW_INDEXED),
        command(OP.DD_BLT, bltPayload({
            destinationHandle: 0x300, destinationRect: [0, 0, 64, 64],
            flags: DDBLT.COLOR_FILL, fillColor: 42,
        })),
    ], { present: true }));
    const layout = find("createBindGroupLayout")
        .find(call => call[1].entries.length === 1 &&
            call[1].entries[0].buffer);
    assert.ok(layout, "the fill variant should declare only its uniform block");
    assert.equal(uniformBlock(find).fillIndex, 42,
        "an indexed fill carries the palette index, not a colour");
    assert.equal(executor.getStats().ddFills, 1);
});

await test("a normal primary presents only the 3DMark splash dirty rectangle",
        async () => {
    const presented = [];
    const { executor } = makeExecutor({
        onPresent: surface => presented.push({ ...surface,
            clipRect: surface.clipRect && { ...surface.clipRect } }),
    });
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(800, 600)),
        command(OP.DD_SET_DISPLAY_MODE,
            displayModePayload(800, 600, 32, 1 << 0, false)),
        SURFACE_SETUP(0x300, 800, 600, FMT_X8R8G8B8),
        command(OP.DD_BLT, bltPayload({
            sourceHandle: 0x300, sourceRect: [190, 215, 610, 385],
            destinationHandle: 0, destinationRect: [190, 215, 610, 385],
        })),
        // 3DMark reports the 800x600 desktop at Present even though it changed
        // only the centred 420x170 splash rectangle.
        command(OP.PRESENT, encodePayload("Present", { device_handle: DEVICE, hwnd: 0x1234, x: 0, y: 0, width: 800, height: 600 })),
    ], { present: true }));
    assert.equal(presented.length, 1);
    assert.equal(presented[0].ddDesktopPrimary, true);
    assert.equal(presented[0].displayWidth, 800);
    assert.equal(presented[0].displayHeight, 600);
    assert.deepEqual(presented[0].clipRect, {
        left: 190, top: 215, right: 610, bottom: 385,
        baseWidth: 800, baseHeight: 600,
    });
    assert.equal(presented[0].width, 800);
});

await test("an exclusive fullscreen display mode repositions the overlay",
        async () => {
    const surfaces = [];
    const { executor } = makeExecutor({
        onSurface: (surface, reason) => surfaces.push({ ...surface, reason }),
    });
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(1024, 768)),
        command(OP.DD_SET_DISPLAY_MODE,
            displayModePayload(640, 480, 8, (1 << 1) | (1 << 2), true)),
    ]));
    const mode = surfaces.filter(s => s.reason === "display-mode").pop();
    assert.ok(mode, "a display mode change must reach the page");
    assert.equal(mode.width, 640);
    assert.equal(mode.height, 480);
    assert.equal(mode.x, 0, "a real mode change puts the window at the origin");
    assert.equal(mode.fullscreen, true);

    // ChangeDisplaySettings failed in the guest: the window is still a window,
    // so the overlay must not jump to the origin.
    const windowed = makeExecutor({
        onSurface: (surface, reason) => surfaces.push({ ...surface, reason }),
    });
    await windowed.executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(1024, 768)),
        command(OP.DD_SET_DISPLAY_MODE,
            displayModePayload(640, 480, 16, (1 << 1) | (1 << 2), false)),
    ]));
    const state = windowed.executor.devices.get(DEVICE);
    assert.equal(state.ddDisplayMode.guestModeChanged, false);
    assert.equal(state.ddDisplayMode.bitsPerPixel, 16);
});

await test("a DirectDraw display mode resizes the implicit back buffer",
        async () => {
    const { executor, find } = makeExecutor();

    // dxdiag sets its cooperative level while its temporary client area is
    // only 106x2, then switches to a 640x480 DirectDraw display mode.
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(106, 2)),
        command(OP.PRESENT, encodePayload("Present", { device_handle: DEVICE, hwnd: 0x1234, x: 0, y: 0, width: 106, height: 2 })),
    ], { present: true }));
    const oldBackBuffer = executor.backBufferTexture;
    assert.ok(oldBackBuffer, "the transient-size back buffer was not created");
    assert.equal(executor.canvas.width, 106);
    assert.equal(executor.canvas.height, 2);

    await executor.submit(buildBatch([
        command(OP.DD_SET_DISPLAY_MODE,
            displayModePayload(640, 480, 16,
                (1 << 1) | (1 << 2), true)),
        SURFACE_SETUP(0x300, 640, 480, FMT_R5G6B5),
        command(OP.DD_BLT, bltPayload({
            sourceHandle: 0x300, sourceRect: [0, 0, 640, 480],
            destinationHandle: 0, destinationRect: [0, 0, 640, 480],
        })),
        command(OP.PRESENT, encodePayload("Present", { device_handle: DEVICE, hwnd: 0x1234, x: 0, y: 0, width: 640, height: 480 })),
    ], { present: true }));
    await Promise.resolve();

    const state = executor.devices.get(DEVICE);
    assert.equal(state.backBufferWidth, 640);
    assert.equal(state.backBufferHeight, 480);
    assert.equal(executor.canvas.width, 640);
    assert.equal(executor.canvas.height, 480);
    assert.notEqual(executor.backBufferTexture, oldBackBuffer);
    assert.equal(oldBackBuffer.destroyed, true,
        "the retained 106x2 back buffer survived the mode switch");
    assert.deepEqual(executor.backBufferTexture.descriptor.size,
        { width: 640, height: 480, depthOrArrayLayers: 1 });

    const blitViewport = find("setViewport")
        .find(call => call[1] === 0 && call[2] === 0 &&
            call[3] === 640 && call[4] === 480);
    assert.ok(blitViewport,
        "SCREEN_BLT was still clipped to the transient device size");
});

await test("an unknown surface handle is skipped rather than guessed at",
        async () => {
    const { executor, find } = makeExecutor();
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
        command(OP.DD_BLT, bltPayload({
            sourceHandle: 0x999, sourceRect: [0, 0, 16, 16],
            destinationHandle: 0, destinationRect: [0, 0, 16, 16],
        })),
    ], { present: true }));
    assert.equal(executor.getStats().ddBlitsSkipped, 1);
    assert.equal(find("beginRenderPass").length, 0);
});

await test("retained back buffers are isolated by process session", async () => {
    const { executor } = makeExecutor();
    const sessionA = { sessionLow: 0x11111111, sessionHigh: 0xaaaaaaaa };
    const sessionB = { sessionLow: 0x22222222, sessionHigh: 0xbbbbbbbb };
    const keyA = "aaaaaaaa11111111";
    const keyB = "bbbbbbbb22222222";
    const present = () => command(OP.PRESENT,
        encodePayload("Present", { device_handle: DEVICE, hwnd: 0x1234, x: 0, y: 0, width: 320, height: 200 }));

    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(320, 200)), present(),
    ], { ...sessionA, present: true }));
    const backBufferA = executor.sessionStates.get(keyA).backBufferTexture;
    assert.ok(backBufferA, "session A retained no back buffer");
    assert.equal(executor.canvas.width, 320);
    assert.equal(executor.canvas.height, 200);

    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(640, 480)),
    ], sessionB));
    assert.equal(executor.canvas.width, 320,
        "a non-presenting helper must not resize the visible canvas");
    assert.equal(executor.canvas.height, 200);
    await executor.submit(buildBatch([
        command(OP.PRESENT, encodePayload("Present", { device_handle: DEVICE, hwnd: 0x1234, x: 0, y: 0, width: 640, height: 480 })),
    ], { ...sessionB, present: true }));
    const backBufferB = executor.sessionStates.get(keyB).backBufferTexture;
    assert.ok(backBufferB, "session B retained no back buffer");
    assert.equal(executor.canvas.width, 640);
    assert.equal(executor.canvas.height, 480);
    assert.notEqual(backBufferB, backBufferA,
        "two processes must not alias one retained texture");
    assert.notEqual(backBufferA.destroyed, true,
        "switching sessions must not destroy the inactive owner's frame");

    await executor.submit(buildBatch([present()],
        { ...sessionA, present: true }));
    assert.equal(executor.backBufferTexture, backBufferA,
        "switching back must restore session A's retained texture");
    assert.equal(executor.canvas.width, 320);
    assert.equal(executor.canvas.height, 200);
    assert.notEqual(backBufferB.destroyed, true);
});

await test("destroying the DirectDraw device retires its retained frame",
        async () => {
    const destroyed = [];
    const { executor } = makeExecutor({
        onDestroy: (surface, reason) => destroyed.push({ ...surface, reason }),
    });
    const session = { sessionLow: 0x33333333, sessionHigh: 0xcccccccc };
    const key = "cccccccc33333333";
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(320, 200)),
        command(OP.PRESENT, encodePayload("Present", { device_handle: DEVICE, hwnd: 0x1234, x: 0, y: 0, width: 320, height: 200 })),
    ], { ...session, present: true }));
    const backBuffer = executor.sessionStates.get(key).backBufferTexture;

    await executor.submit(buildBatch([
        command(OP.DESTROY_RESOURCE, encodePayload("DestroyResource", { resource_handle: DEVICE, resource_kind: 0 })),
    ], session));
    await Promise.resolve();
    assert.equal(executor.devices.size, 0);
    assert.equal(executor.backBufferTexture, null);
    assert.equal(backBuffer.destroyed, true);
    assert.equal(destroyed.length, 1);
    assert.equal(destroyed[0].visible, false);
    assert.equal(destroyed[0].reason, "device");
});

await test("SESSION_END releases every live object owned by the process",
        async () => {
    const destroyed = [];
    const { executor } = makeExecutor({
        onDestroy: (surface, reason) => destroyed.push({ ...surface, reason }),
    });
    const session = { sessionLow: 0x44444444, sessionHigh: 0xdddddddd };
    const key = "dddddddd44444444";
    await executor.submit(buildBatch([
        command(OP.CREATE_DEVICE, createDevicePayload(320, 200)),
        SURFACE_SETUP(0x300, 16, 16, FMT_X8R8G8B8),
        command(OP.PRESENT, encodePayload("Present", { device_handle: DEVICE, hwnd: 0x1234, x: 0, y: 0, width: 320, height: 200 })),
    ], { ...session, present: true }));
    const state = executor.sessionStates.get(key);
    const backBuffer = state.backBufferTexture;
    const surfaceTexture = state.resources.get(0x300).gpuTexture;

    await executor.submit(buildBatch([
        command(OP.SESSION_END,
            encodePayload("SessionEnd", { session_id_low: session.sessionLow, session_id_high: session.sessionHigh })),
    ], session));
    await Promise.resolve();
    assert.equal(executor.sessionKey, null);
    assert.equal(executor.sessionStates.has(key), false);
    assert.equal(executor.getStats().sessionsEnded, 1);
    assert.equal(backBuffer.destroyed, true);
    assert.equal(surfaceTexture.destroyed, true);
    assert.equal(destroyed.length, 1);
    assert.equal(destroyed[0].reason, "session-end");
    assert.equal(destroyed[0].visible, false);
});

// ---- report ----

if (failures.length) {
    for (const failure of failures) {
        console.error("FAIL " + failure.name);
        console.error("     " + (failure.error && failure.error.message));
    }
    console.error(failures.length + " failed, " + passed + " passed");
    process.exit(1);
}
console.log(passed + " ddraw executor tests passed");
}

if (require.main === module) main().catch(error => { console.error(error); process.exit(1); });

module.exports = { makeExecutor, buildBatch, command, u32, createDevicePayload, createSurfacePayload, updateTexturePayload, bltPayload, palettePayload, OP, DEVICE, FMT_P8, USAGE_DDRAW_INDEXED };
