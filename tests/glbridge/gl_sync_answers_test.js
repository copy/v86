#!/usr/bin/env node
// What the guest reads back for an OpenGL query, end to end -- v86gl_device.js
// takes the batch from guest memory, graphics_proxy.js hands it to the
// renderer, the GL executor answers -- in both of the proxy's modes: the
// page's, where the renderer runs beside the CPU and the batch the executor
// writes its answers into IS guest memory, and the CPU worker's (the site's
// default), where the batch crosses to the renderer as a copy.
//
// CPU metadata is answered before copying. Remaining renderer answers use
// the inline guest-memory writer, which also preserves their original
// addresses when CPU validation removes rejected records from execution.
"use strict";

const assert = require("node:assert/strict");
require("../../src/browser/glbridge/gl-webgpu/gl_glslang.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_glsl.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_objects.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_state.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_raster.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_fixed.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_misc.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_rasterpos.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_pixelmaps.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_images.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_textures.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_buffers.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_arrays.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_names.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_queries.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_arb.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
require("../../src/browser/glbridge/v86_network_bridge.js");
const { V86WebGPUCompositor } = require("../../src/browser/glbridge/webgpu_compositor.js");
const { createV86GLDevice } = require("../../src/browser/glbridge/v86gl_device.js");
const { V86GraphicsProxy } = require("../../src/browser/glbridge/graphics_proxy.js");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js");
const { createFakeHost } = require("./gl_fake_gpu.js");
const { GLStream } = require("./gl_stream_builder.js");

// mode -> query kind -> why it is not answered there yet
const KNOWN_FAILURES = {};

const ARENA = 0x100000, ARENA_BYTES = 16 * 1024 * 1024, HEADER = 32;
const SYNC_STATUS_OK = 1;

async function guestAnswers(remote) {
    const memory = new Uint8Array(ARENA + ARENA_BYTES);
    // the two ends of the channel; across threads a message is a copy
    let toRenderer = null, toDevice = null;
    const pass = message => remote ? globalThis.structuredClone(message) : message;
    const deviceEnd = { remote, post: message => toRenderer(pass(message)), listen: handler => { toDevice = handler; } };
    const rendererEnd = { remote, post: message => toDevice(pass(message)), listen: handler => { toRenderer = handler; } };

    const queue = [];
    const handle = {
        is_feature_negotiated: () => true,
        has_request: () => queue.length > 0,
        pop_request: () => queue.shift(),
        flush() {},
        needs_reset() { throw new Error("needs_reset"); },
        is_ram: () => true,
        read_memory: (address, length) => memory.subarray(address, address + length),
        write_memory: (bytes, address) => memory.set(bytes, address),
    };
    const request = words => new Promise(resolve => {
        queue.push({ readable: 24, writable: 16, read: () => new Uint8Array(new Uint32Array(words).buffer),
            write: reply => resolve(new Uint32Array(reply.buffer, reply.byteOffset, 4)[0]), complete() {} });
        device.notify();
    });
    const device = createV86GLDevice(deviceEnd);
    device.init(handle);

    const { host } = createFakeHost();
    const executor = new GLWebGPUExecutor(null, { host });
    await executor.initialize();
    const plugin = V86GraphicsProxy({ glslang: readFileSync(join(__dirname, "../../bios/glslang.wasm")), createBridge: () => {
        const bridge = global.installV86GLNetworkBridge(null, null, {
            compositor: new V86WebGPUCompositor({ width: 64, height: 64 }), glExecutor: executor, d3d9Executor: null });
        bridge.ready = Promise.resolve();
        return bridge;
    } });
    await plugin.start({ emulator: {}, channel: rendererEnd,
        screen: { canvas: {}, set_backend() {}, fallback() {}, is_graphical: () => true } });

    assert.equal(await request([1, ARENA, 0, ARENA_BYTES, 0, 0]), 0, "the arena registers");
    // one batch: a context, then glGetError, glGetString(GL_VENDOR) and two
    // glGetIntegerv, a limit and the host-capability bits
    const stream = new GLStream().makeCurrent(1, 0, 0, 64, 64);
    // (each record: a 4-byte header, then the payload; the status word is
    // the payload's first for glGetError, its second for the others)
    const errorAt = stream.length + 4;
    stream.queryError();
    const stringAt = stream.length + 4 + 4;
    stream.queryString(0x1F00, 64);
    const limitAt = stream.length + 4 + 4;
    stream.queryInteger(0x0D33);
    const capsAt = stream.length + 4 + 4;
    stream.queryInteger(0x76380001);
    stream.call("VIEWPORT", -10, 4, 100, 50);
    const stateAt = stream.length + 4;
    const stateHeader = P.encodeRecord("QUERY_STATE", { pname: 0x0BA2, value_kind: P.C.V86GL_STATE_INTEGER, data_size: 128 });
    const statePayload = new Uint8Array(stateHeader.length + 128); statePayload.set(stateHeader);
    stream.record(P.GLFN.QUERY_STATE, statePayload);
    stream.call("ACTIVE_TEXTURE", 0x84C2).call("ENABLE", 0x0DE1);
    const extraState = (pname, value_kind, capacity = 8) => {
        const at = stream.length + 4;
        const header = P.encodeRecord("QUERY_STATE", { pname, value_kind, data_size: capacity });
        const payload = new Uint8Array(header.length + capacity); payload.set(header);
        stream.record(P.GLFN.QUERY_STATE, payload); return at;
    };
    const enabledAt = extraState(0x0DE1, P.C.V86GL_STATE_IS_ENABLED);
    const maskAt = extraState(0x0B93, P.C.V86GL_STATE_INTEGER);
    stream.call("FOGF", 0x0B62, 2.75);
    const fogAt = extraState(0x0B62, P.C.V86GL_STATE_DOUBLE);
    stream.call("TRANSLATEF", 2, 3, 4).call("LIGHTFV", 0x4002, 0x1203, 4, 1, 2, 3, 1).call("LOAD_IDENTITY");
    const parameterAt = stream.length + 4;
    const parameterHeader = P.encodeRecord("QUERY_PARAMETER", { pname: 0x1203, value_kind: P.C.V86GL_STATE_DOUBLE,
        data_size: 32, query_kind: P.C.V86GL_PARAMETER_LIGHT, target: 0x4002 });
    const parameterPayload = new Uint8Array(parameterHeader.length + 32); parameterPayload.set(parameterHeader);
    stream.record(P.GLFN.QUERY_PARAMETER, parameterPayload);
    stream.call("RASTER_POS4F", 0, 0, 0, 2);
    const rasterAt = extraState(0x0B07, P.C.V86GL_STATE_DOUBLE, 32);
    stream.pixelMap("PIXEL_MAPUSV", 0x0C76, [0, 32768, 65535, 16384]);
    const mapAt = stream.length + 4, mapHeader = P.encodeRecord("QUERY_PARAMETER", { query_kind: P.C.V86GL_PARAMETER_PIXEL_MAP,
        target: 0x0C76, value_kind: P.C.V86GL_STATE_UNSIGNED_SHORT, data_size: 32 });
    const mapPayload = new Uint8Array(mapHeader.length + 32); mapPayload.set(mapHeader); stream.record(P.GLFN.QUERY_PARAMETER, mapPayload);
    // a GLSL program: its link status and a uniform's location
    stream.call("CREATE_SHADER", 1, 0x8B31).shaderSource(1, "uniform float gain; void main() { gl_Position = gl_Vertex * gain; }")
        .call("COMPILE_SHADER", 1).call("CREATE_SHADER", 2, 0x8B30)
        .shaderSource(2, "void main() { gl_FragColor = vec4(1.0); }").call("COMPILE_SHADER", 2)
        .call("CREATE_PROGRAM", 5).call("ATTACH_SHADER", 5, 1).call("ATTACH_SHADER", 5, 2).call("LINK_PROGRAM", 5);
    const linkAt = stream.length + 4 + P.F.QUERY_OBJECT_IV.status;
    stream.queryObjectiv(P.C.V86GL_OBJECT_KIND_PROGRAM, 5, 0x8B82);
    const locationAt = stream.length + 4 + P.F.QUERY_LOCATION.status;
    stream.queryLocation(P.C.V86GL_LOCATION_KIND_UNIFORM, 5, "gain", 16);
    stream.call("USE_PROGRAM", 5).uniformfv(5 * 4096, 1, 1, [2])
        .shaderSource(2, "void main() { gl_FragColor = unknownValue; }").call("COMPILE_SHADER", 2).call("LINK_PROGRAM", 5);
    const failedLinkAt = stream.length + 4 + P.F.QUERY_OBJECT_IV.status;
    stream.queryObjectiv(P.C.V86GL_OBJECT_KIND_PROGRAM, 5, 0x8B82);
    const failedUniformAt = stream.length + 4;
    const guardedUniform = stream.queryUniform(5, 5 * 4096, 1, 16); guardedUniform.bytes.fill(0xA5, 32);
    // a framebuffer object with a texture: glCheckFramebufferStatus
    stream.call("BIND_TEXTURE", 0x0DE1, 7).texImage2D(0x0DE1, 0, 0x1908, 16, 16, 0x1908, 0x1401, null)
        .call("BIND_FRAMEBUFFER", 0x8D40, 3).call("FRAMEBUFFER_TEXTURE", 0x8D40, 0x8CE0, 0x0DE1, 7, 0, 0);
    const fboAt = stream.length + 4 + P.F.CHECK_FRAMEBUFFER_STATUS.status;
    stream.record(P.GLFN.CHECK_FRAMEBUFFER_STATUS, P.encodeRecord("CHECK_FRAMEBUFFER_STATUS", { target: 0x8D40 }));
    const isTextureAt = stream.length + 4;
    const objectHeader = P.encodeRecord("QUERY_PARAMETER", { query_kind: P.C.V86GL_PARAMETER_IS_OBJECT,
        target: P.C.V86GL_OBJECT_KIND_TEXTURE, pname: 7, value_kind: P.C.V86GL_STATE_BOOLEAN, data_size: 8 });
    const objectPayload = new Uint8Array(objectHeader.length + 8); objectPayload.set(objectHeader);
    stream.record(P.GLFN.QUERY_PARAMETER, objectPayload);
    const attachmentAt = stream.length + 4;
    const attachmentHeader = P.encodeRecord("QUERY_PARAMETER", { query_kind: P.C.V86GL_PARAMETER_FRAMEBUFFER_ATTACHMENT,
        target: 0x8D40, index: 0x8CE0, pname: 0x8CD1, value_kind: P.C.V86GL_STATE_INTEGER, data_size: 8 });
    const attachmentPayload = new Uint8Array(attachmentHeader.length + 8); attachmentPayload.set(attachmentHeader);
    stream.record(P.GLFN.QUERY_PARAMETER, attachmentPayload);
    stream.call("BIND_RENDERBUFFER", 0x8D41, 9).call("RENDERBUFFER_STORAGE", 0x8D41, 0x8D49, 7, 5);
    const rbAt = stream.length + 4, rbHeader = P.encodeRecord("QUERY_PARAMETER", { query_kind: P.C.V86GL_PARAMETER_RENDERBUFFER,
        target: 0x8D41, pname: 0x8D55, value_kind: P.C.V86GL_STATE_INTEGER, data_size: 8 });
    const rbPayload = new Uint8Array(rbHeader.length + 8); rbPayload.set(rbHeader); stream.record(P.GLFN.QUERY_PARAMETER, rbPayload);
    stream.call("TEX_PARAMETERIV", 0x0DE1, 0x1004, 4, -2147483648, 0, 1073741824, 2147483647);
    const textureAt = stream.length + 4, textureHeader = P.encodeRecord("QUERY_PARAMETER", { query_kind: P.C.V86GL_PARAMETER_TEXTURE,
        target: 0x0DE1, pname: 0x1004, value_kind: P.C.V86GL_STATE_FLOAT, data_size: 32 });
    const texturePayload = new Uint8Array(textureHeader.length + 32); texturePayload.set(textureHeader);
    stream.record(P.GLFN.QUERY_PARAMETER, texturePayload);
    stream.call("DRAW_BUFFER", 0x8CE1).call("READ_BUFFER", 0).call("BIND_FRAMEBUFFER", 0x8D40, 4).call("BIND_FRAMEBUFFER", 0x8D40, 3);
    const drawBufferAt = extraState(0x8825, P.C.V86GL_STATE_INTEGER);
    const readBufferAt = extraState(0x0C02, P.C.V86GL_STATE_INTEGER);
    // an ARB program that does not assemble: where it stopped
    stream.call("BIND_PROGRAM_ARB", 0x8804, 4).programStringARB(0x8804, "!!ARBfp1.0\nMOV result.color, nothing;\nEND\n");
    const arbAt = stream.length + 4 + 4;
    stream.queryInteger(0x864B);
    // what only the renderer can answer, written into guest memory later:
    // glFinish and the occlusion queries' results
    const finishAt = stream.length + 4;
    stream.record(P.GLFN.FINISH, new Uint8Array(4));
    const batchAt = stream.length + 4 + 8;
    stream.record(P.GLFN.QUERY_OBJECT_BATCH, new Uint8Array(new Uint32Array([0, P.C.V86GL_OBJECT_KIND_QUERY, 0, 0]).buffer));
    const bytes = stream.bytes();
    const header = new DataView(memory.buffer, ARENA, HEADER);
    header.setUint32(0, 0x324C4756, true);
    header.setUint32(4, 1, true);
    header.setUint32(12, 7, true);
    header.setUint32(16, 1, true);
    header.setUint32(20, bytes.byteLength, true);
    memory.set(bytes, ARENA + HEADER);
    assert.equal(await request([2, 0, 0, HEADER + bytes.byteLength, 0, 0]), 0, "the batch is taken");
    assert.equal(new DataView(memory.buffer, ARENA + HEADER).getUint32(stateAt + P.F.QUERY_STATE.status, true),
        SYNC_STATUS_OK, "typed state is answered before the request returns, including in worker mode");
    assert.equal(new DataView(memory.buffer, ARENA + HEADER).getUint32(enabledAt + P.F.QUERY_STATE.status, true),
        SYNC_STATUS_OK, "enable queries are also synchronous in worker mode");
    await plugin.idle();
    await executor.idle();
    const view = new DataView(memory.buffer, ARENA + HEADER);
    const answer = (at, value) => view.getUint32(at, true) === SYNC_STATUS_OK ? value() : "status " + view.getUint32(at, true);
    return {
        error: answer(errorAt, () => view.getUint32(errorAt + 4, true)),
        string: answer(stringAt, () => String.fromCharCode(...new Uint8Array(memory.buffer, ARENA + HEADER + stringAt + 12,
            view.getUint32(stringAt + 4, true) - 1))),
        limit: answer(limitAt, () => view.getUint32(limitAt + 4, true)),
        caps: answer(capsAt, () => view.getUint32(capsAt + 4, true)),
        state: answer(stateAt + P.F.QUERY_STATE.status, () => Array.from({ length: view.getUint32(stateAt + P.F.QUERY_STATE.count, true) },
            (_, i) => view.getFloat64(stateAt + P.RECORDS.QUERY_STATE.size + i * 8, true))),
        enabled: answer(enabledAt + P.F.QUERY_STATE.status, () => view.getFloat64(enabledAt + P.RECORDS.QUERY_STATE.size, true)),
        stencilMask: answer(maskAt + P.F.QUERY_STATE.status, () => view.getFloat64(maskAt + P.RECORDS.QUERY_STATE.size, true)),
        fogDensity: answer(fogAt + P.F.QUERY_STATE.status, () => view.getFloat64(fogAt + P.RECORDS.QUERY_STATE.size, true)),
        rasterPosition: answer(rasterAt + P.F.QUERY_STATE.status, () => Array.from({ length: 4 },
            (_, i) => view.getFloat64(rasterAt + P.RECORDS.QUERY_STATE.size + i * 8, true))),
        pixelMap: answer(mapAt + P.F.QUERY_PARAMETER.status, () => Array.from({ length: 4 },
            (_, i) => view.getFloat64(mapAt + P.RECORDS.QUERY_PARAMETER.size + i * 8, true))),
        lightPosition: answer(parameterAt + P.F.QUERY_PARAMETER.status, () => Array.from({ length: 4 },
            (_, i) => view.getFloat64(parameterAt + P.RECORDS.QUERY_PARAMETER.size + i * 8, true))),
        linked: answer(linkAt, () => view.getUint32(linkAt + 4, true)),
        failedLink: answer(failedLinkAt, () => view.getUint32(failedLinkAt + 4, true)),
        failedUniform: view.getUint32(failedUniformAt + P.F.QUERY_UNIFORM.status, true) === P.C.V86GL_SYNC_QUERY_STATUS_FAILED &&
            new Uint8Array(memory.buffer, ARENA + HEADER + failedUniformAt + 32, 16).every(v => v === 0xA5),
        location: answer(locationAt, () => view.getInt32(locationAt + 4, true)),
        framebuffer: answer(fboAt, () => view.getUint32(fboAt + 4, true)),
        isTexture: answer(isTextureAt + P.F.QUERY_PARAMETER.status, () => view.getFloat64(isTextureAt + P.RECORDS.QUERY_PARAMETER.size, true)),
        attachment: answer(attachmentAt + P.F.QUERY_PARAMETER.status, () => view.getFloat64(attachmentAt + P.RECORDS.QUERY_PARAMETER.size, true)),
        renderbufferBits: answer(rbAt + P.F.QUERY_PARAMETER.status, () => view.getFloat64(rbAt + P.RECORDS.QUERY_PARAMETER.size, true)),
        textureBorder: answer(textureAt + P.F.QUERY_PARAMETER.status, () => Array.from({ length: 4 },
            (_, i) => view.getFloat64(textureAt + P.RECORDS.QUERY_PARAMETER.size + i * 8, true))),
        drawBuffer: answer(drawBufferAt + P.F.QUERY_STATE.status, () => view.getFloat64(drawBufferAt + P.RECORDS.QUERY_STATE.size, true)),
        readBuffer: answer(readBufferAt + P.F.QUERY_STATE.status, () => view.getFloat64(readBufferAt + P.RECORDS.QUERY_STATE.size, true)),
        arb: answer(arbAt, () => view.getInt32(arbAt + 4, true)),
        finish: answer(finishAt, () => "done"),
        queries: answer(batchAt, () => "done"),
    };
}

(async () => {
    const failures = [];
    const results = {};
    for (const [mode, remote] of [["page", false], ["worker", true]]) {
        const answers = results[mode] = await guestAnswers(remote);
        for (const [kind, value] of Object.entries(answers)) {
            const answered = !(typeof value === "string" && value.startsWith("status "));
            const known = (KNOWN_FAILURES[mode] || {})[kind];
            if (known) {
                if (answered) failures.push(mode + " answers " + kind + " now: delete its known failure (" + known + ")");
                else console.log("known " + mode + " " + kind + ": " + known);
            } else if (!answered) {
                failures.push(mode + ": the guest read " + kind + " " + value);
            }
        }
    }
    // the same answers in both modes
    for (const kind of ["string", "limit", "caps", "linked", "location", "framebuffer", "arb", "finish", "queries"])
        if (results.page[kind] !== results.worker[kind])
            failures.push(kind + ": page " + JSON.stringify(results.page[kind]) + ", worker " + JSON.stringify(results.worker[kind]));
    if (results.page.string !== "VMware, Inc.") failures.push("GL_VENDOR is " + JSON.stringify(results.page.string));
    if (results.page.linked !== 1) failures.push("the program did not link: " + results.page.linked);
    if (!(results.page.location >= 0)) failures.push("gain has no location: " + results.page.location);
    if (results.page.framebuffer !== 0x8CD5) failures.push("the framebuffer is " + results.page.framebuffer);
    if (results.page.arb !== 29) failures.push("the ARB error position is " + results.page.arb);
    assert.deepEqual(results.page.state, [-10, 4, 100, 50]);
    assert.deepEqual(results.worker.state, results.page.state);
    assert.equal(results.page.enabled, 1); assert.equal(results.worker.enabled, 1);
    assert.equal(results.page.stencilMask, -1); assert.equal(results.worker.stencilMask, -1);
    assert.deepEqual(results.page.lightPosition, [3, 5, 7, 1]);
    assert.deepEqual(results.worker.lightPosition, results.page.lightPosition);
    assert.equal(results.page.fogDensity, 2.75); assert.equal(results.worker.fogDensity, results.page.fogDensity);
    assert.deepEqual(results.page.rasterPosition, [40, 29, 0.5, 2]); assert.deepEqual(results.worker.rasterPosition, results.page.rasterPosition);
    assert.deepEqual(results.page.pixelMap, [0, 32768, 65535, 16384]); assert.deepEqual(results.worker.pixelMap, results.page.pixelMap);
    assert.equal(results.page.failedLink, 0); assert.equal(results.worker.failedLink, 0);
    assert.equal(results.page.failedUniform, true); assert.equal(results.worker.failedUniform, true);
    assert.equal(results.page.isTexture, 1); assert.equal(results.worker.isTexture, 1);
    assert.equal(results.page.attachment, 7); assert.equal(results.worker.attachment, 7);
    assert.equal(results.page.renderbufferBits, 8); assert.equal(results.worker.renderbufferBits, 8);
    assert.deepEqual(results.page.textureBorder, [0, 0, 0.5, 1]); assert.deepEqual(results.worker.textureBorder, results.page.textureBorder);
    assert.equal(results.page.drawBuffer, 0x8CE1); assert.equal(results.worker.drawBuffer, 0x8CE1);
    assert.equal(results.page.readBuffer, 0); assert.equal(results.worker.readBuffer, 0);
    if (failures.length) {
        console.error(failures.join("\n"));
        process.exitCode = 1;
        return;
    }
    console.log("gl_sync_answers_test: both modes answer typed state, capability, GLSL, framebuffer, ARB, glFinish, query results and errors alike (passed)");
})();
