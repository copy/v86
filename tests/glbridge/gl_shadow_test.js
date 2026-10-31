#!/usr/bin/env node
// gl_shadow.js, the CPU side's GL state (docs/opengl-webgpu-plan.md C3): what
// it answers in the guest's memory, what it leaves to the executor, and that
// the device runs it, keeps it across snapshots and resets it when the arena's
// owner or the machine goes.
"use strict";

const assert = require("node:assert/strict");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
const glCaps = require("../../src/browser/glbridge/gl-webgpu/gl_caps.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js");
const translator = require("../../src/browser/glbridge/gl-webgpu/gl_shader_translator.js");
const { createV86GLDevice } = require("../../src/browser/glbridge/v86gl_device.js");
const { createFakeHost } = require("./gl_fake_gpu.js");
const { GLStream, GL } = require("./gl_stream_builder.js");

const OK = P.C.V86GL_SYNC_QUERY_STATUS_OK, PENDING = P.C.V86GL_SYNC_QUERY_STATUS_PENDING;
const CAPS = glCaps.capabilities({ maxTextureDimension2D: 4096 }, { bc: true });

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// A stream and where each query's payload starts
function queries(build) {
    const stream = new GLStream().makeCurrent(1, 0, 0, 64, 64, 1, 1);
    const at = {};
    build(stream, name => { at[name] = stream.length + 4; });
    return { bytes: stream.bytes(), at };
}
const u32 = (bytes, at) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(at, true);
const text = (bytes, at, length) => String.fromCharCode(...bytes.subarray(at, at + length));

test("capability integers and strings are answered in place", () => {
    const shadow = new GLShadow();
    shadow.setCapabilities(CAPS);
    const { bytes, at } = queries((s, mark) => {
        mark("size"); s.queryInteger(GL.MAX_TEXTURE_SIZE);
        mark("caps"); s.queryInteger(P.C.V86GL_QUERY_HOST_CAPABILITIES);
        mark("vendor"); s.queryString(GL.VENDOR, 64);
        mark("extensions"); s.queryString(GL.EXTENSIONS, 4096);
        mark("short"); s.queryString(GL.VENDOR, 4);
    });
    shadow.process(bytes);
    const F = P.F.QUERY_INTEGER, S = P.F.QUERY_GL_STRING, header = P.RECORDS.QUERY_GL_STRING.size;
    assert.equal(u32(bytes, at.size + F.status), OK);
    assert.equal(u32(bytes, at.size + F.value), 4096);
    assert.equal(u32(bytes, at.caps + F.value), glCaps.integer(CAPS, P.C.V86GL_QUERY_HOST_CAPABILITIES));
    assert.equal(u32(bytes, at.vendor + S.status), OK);
    assert.equal(u32(bytes, at.vendor + S.length), "VMware, Inc.".length + 1);
    assert.equal(text(bytes, at.vendor + header, 13), "VMware, Inc.\0");
    const extensions = text(bytes, at.extensions + header, u32(bytes, at.extensions + S.length) - 1);
    assert.equal(extensions, glCaps.extensions(CAPS));
    assert.ok(extensions.includes("GL_EXT_texture_compression_s3tc"));
    assert.ok(!extensions.split(" ").includes("GL_EXT_paletted_texture"), "palette API is not implemented");
    // a buffer too small takes what fits; length says how long it is
    assert.equal(u32(bytes, at.short + S.status), OK);
    assert.equal(text(bytes, at.short + header, 4), "VMwa");
    assert.equal(shadow.stats.answered, 5);
});

test("capability readiness and unknown standalone queries have explicit statuses", () => {
    const shadow = new GLShadow();
    const { bytes, at } = queries((s, mark) => {
        mark("size"); s.queryInteger(GL.MAX_TEXTURE_SIZE);
        mark("viewport"); s.queryInteger(GL.VIEWPORT);
        mark("error"); s.queryError();
        mark("arb"); s.queryString(GL.PROGRAM_ERROR_STRING_ARB, 64);
    });
    // no capabilities yet: nothing
    shadow.process(bytes);
    assert.equal(u32(bytes, at.size + P.F.QUERY_INTEGER.status), PENDING);
    shadow.setCapabilities(CAPS);
    shadow.process(bytes);
    assert.equal(u32(bytes, at.size + P.F.QUERY_INTEGER.status), OK);
    // This isolated test loads no typed-state or ARB query modules.
    // Error queries, including NO_ERROR, are always CPU answers.
    assert.equal(u32(bytes, at.viewport + P.F.QUERY_INTEGER.status), P.C.V86GL_SYNC_QUERY_STATUS_FAILED);
    assert.equal(u32(bytes, at.error + P.F.QUERY_ERROR.status), OK);
    assert.equal(u32(bytes, at.arb + P.F.QUERY_GL_STRING.status), P.C.V86GL_SYNC_QUERY_STATUS_FAILED);
});

test("the executor preserves CPU answers and failures", async () => {
    const shadow = new GLShadow();
    shadow.setCapabilities(CAPS);
    const { host } = createFakeHost();
    const executor = new GLWebGPUExecutor(null, { host });
    await executor.initialize();
    const { bytes, at } = queries((s, mark) => {
        mark("size"); s.queryInteger(GL.MAX_TEXTURE_SIZE);
        mark("viewport"); s.queryInteger(GL.VIEWPORT);
    });
    shadow.process(bytes);
    // (the fake adapter's limit differs from the shadow's capabilities)
    assert.notEqual(glCaps.integer(executor.capabilities(), GL.MAX_TEXTURE_SIZE), 4096);
    executor.submit(bytes, {});
    assert.equal(u32(bytes, at.size + P.F.QUERY_INTEGER.value), 4096, "the shadow's answer stands");
    assert.equal(u32(bytes, at.viewport + P.F.QUERY_INTEGER.status), P.C.V86GL_SYNC_QUERY_STATUS_FAILED);
    assert.equal(u32(bytes, at.viewport + P.F.QUERY_INTEGER.value), 0);
});

test("the capability limits agree with the translator's", () => {
    assert.equal(glCaps.LIMITS.MAX_VARYING_FLOATS, translator.MAX_INTER_STAGE_SLOTS * 4);
});

test("capability profiles survive backend revisions, isolate host input and keep restored strings", () => {
    const raw = glCaps.capabilities({ maxTextureDimension2D: 4096 }, { bc: true }), one = new GLShadow(); one.setCapabilities(raw);
    raw.limits.maxTextureDimension2D = 16384; raw.features.bc = false;
    assert.equal(glCaps.integer(one.capabilities, GL.MAX_TEXTURE_SIZE), 4096);
    assert.ok(glCaps.extensions(one.capabilities).includes("GL_EXT_texture_compression_s3tc"));
    const saved = JSON.parse(JSON.stringify(one.getState())), maxLights = glCaps.LIMITS.MAX_LIGHTS;
    saved.capabilities.profile.strings[GL.RENDERER] = "Saved GL renderer";
    saved.capabilities.profile.strings[GL.EXTENSIONS] = "GL_EXT_framebuffer_object";
    try {
        glCaps.LIMITS.MAX_LIGHTS = 99;
        const copy = new GLShadow(); copy.setState(saved);
        saved.capabilities.profile.integers[GL.MAX_LIGHTS] = 77;
        assert.equal(glCaps.integer(glCaps.capabilities({}, {}), GL.MAX_LIGHTS), 99, "a fresh device sees the changed implementation");
        assert.equal(glCaps.integer(copy.capabilities, GL.MAX_LIGHTS), maxLights);
        assert.equal(glCaps.extensions(copy.capabilities), "GL_EXT_framebuffer_object");
        const { bytes, at } = queries((s, mark) => {
            mark("limit"); s.queryInteger(GL.MAX_LIGHTS); mark("renderer"); s.queryString(GL.RENDERER, 128);
            mark("extensions"); s.queryString(GL.EXTENSIONS, 128);
        });
        copy.process(bytes); assert.equal(u32(bytes, at.limit + P.F.QUERY_INTEGER.value), maxLights);
        const stringAt = name => text(bytes, at[name] + P.RECORDS.QUERY_GL_STRING.size, u32(bytes, at[name] + P.F.QUERY_GL_STRING.length) - 1);
        assert.equal(stringAt("renderer"), "Saved GL renderer"); assert.equal(stringAt("extensions"), "GL_EXT_framebuffer_object");
        assert.ok(Object.isFrozen(copy.capabilities.profile.integers));
        const legacy = new GLShadow(); legacy.setState({ ...saved, capabilities: raw });
        assert.equal(glCaps.integer(legacy.capabilities, GL.MAX_LIGHTS), 99, "older snapshots without profiles acquire the current table once");
    } finally { glCaps.LIMITS.MAX_LIGHTS = maxLights; }
});

test("contexts follow MAKE_CURRENT and DESTROY_CONTEXT, and survive a snapshot", () => {
    const shadow = new GLShadow();
    shadow.setCapabilities(CAPS);
    const stream = new GLStream().makeCurrent(1, 0, 0, 64, 64, 7, 3).makeCurrent(1, 0, 0, 64, 64, 8, 3);
    shadow.process(stream.bytes());
    assert.deepEqual([...shadow.contexts.keys()], ["context:7", "context:8"]);
    assert.equal(shadow.current.id, 8);
    const copy = new GLShadow();
    copy.setState(JSON.parse(JSON.stringify(shadow.getState())));
    assert.deepEqual(copy.getState(), shadow.getState());
    assert.deepEqual(copy.capabilities, glCaps.freeze(CAPS));
    shadow.process(new GLStream().record(P.CTRL.DESTROY_CONTEXT, new Uint8Array(new Uint32Array([8]).buffer)).bytes());
    assert.deepEqual([...shadow.contexts.keys()], ["context:7"]);
    assert.equal(shadow.current, null);
    // without a payload: every context (an older guest's process teardown)
    shadow.process(new GLStream().record(P.CTRL.DESTROY_CONTEXT).bytes());
    assert.equal(shadow.contexts.size, 0);
});

test("a malformed stream stops the walk and is counted", () => {
    const shadow = new GLShadow();
    shadow.setCapabilities(CAPS);
    const { bytes } = queries((s, mark) => { mark("size"); s.queryInteger(GL.MAX_TEXTURE_SIZE); });
    shadow.process(bytes.subarray(0, bytes.length - 3));
    assert.equal(shadow.stats.malformed, 1);
});

test("the device runs the shadow on GL batches, keeps it in its state and resets it with its owner", () => {
    globalThis.V86GLShadow = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
    const ARENA = 0x100000, ARENA_BYTES = 16 * 1024 * 1024, HEADER = 32;
    const memory = new Uint8Array(ARENA + ARENA_BYTES);
    const posted = [];
    let toDevice = null;
    const device = createV86GLDevice({ remote: true, post: message => posted.push(message),
        listen: handler => { toDevice = handler; } });
    delete globalThis.V86GLShadow;
    const queue = [], replies = [];
    device.init({
        is_feature_negotiated: () => true, has_request: () => queue.length > 0, pop_request: () => queue.shift(),
        flush() {}, needs_reset() { throw new Error("needs_reset"); }, is_ram: () => true,
        read_memory: (address, length) => memory.subarray(address, address + length),
        write_memory: (bytes, address) => memory.set(bytes, address),
    });
    const request = words => {
        queue.push({ readable: 24, writable: 16, read: () => new Uint8Array(new Uint32Array(words).buffer),
            write: reply => replies.push(new Uint32Array(reply.buffer, reply.byteOffset, 4)[0]), complete() {} });
        device.notify();
        return replies[replies.length - 1];
    };
    const submit = bytes => {
        const header = new DataView(memory.buffer, ARENA, HEADER);
        header.setUint32(0, 0x324C4756, true);
        header.setUint32(4, 1, true);
        header.setUint32(16, 1, true);
        header.setUint32(20, bytes.byteLength, true);
        memory.set(bytes, ARENA + HEADER);
        return request([2, 0, 0, HEADER + bytes.byteLength, 0, 0]);
    };
    toDevice({ type: "available", value: true });
    toDevice({ type: "capabilities", value: CAPS });
    assert.equal(request([1, ARENA, 0, ARENA_BYTES, 0, 0]), 0);
    const { bytes, at } = queries((s, mark) => { mark("size"); s.queryInteger(GL.MAX_TEXTURE_SIZE); });
    assert.equal(submit(bytes), 0);
    const guest = new DataView(memory.buffer, ARENA + HEADER);
    assert.equal(guest.getUint32(at.size + P.F.QUERY_INTEGER.status, true), OK, "answered in guest memory");
    assert.equal(guest.getUint32(at.size + P.F.QUERY_INTEGER.value, true), 4096);
    // the renderer got a copy taken after the answer
    const copy = posted.find(m => m.type === "batch").bytes;
    assert.equal(new DataView(copy.buffer, copy.byteOffset).getUint32(at.size + P.F.QUERY_INTEGER.status, true), OK);

    // a D3D batch is not the shadow's
    const d3d = new Uint8Array(16);
    new DataView(d3d.buffer).setUint32(0, 0xFFFFFFE1, true);
    new DataView(d3d.buffer).setUint32(4, 8, true);
    const records = device.shadow_stats().records;
    assert.equal(submit(d3d), 0);
    assert.equal(device.shadow_stats().records, records, "a D3D envelope is not walked");

    const state = device.get_state();
    assert.equal(state[0], 3);
    // the owner unmaps: its contexts end
    assert.equal(request([3, 0, 0, 0, 0, 0]), 0);
    assert.equal(JSON.parse(device.get_state()[6]).contexts.length, 0);
    // a later renderer's capabilities do not replace the ones the guest was told
    toDevice({ type: "capabilities", value: glCaps.capabilities({ maxTextureDimension2D: 16384 }, {}) });
    assert.equal(JSON.parse(device.get_state()[6]).capabilities.limits.maxTextureDimension2D, 4096);
    // the machine resets: no contexts, the capabilities stay
    device.set_state(state);
    assert.equal(JSON.parse(device.get_state()[6]).contexts.length, 1);
    toDevice({ type: "machine_reset" });
    assert.equal(JSON.parse(device.get_state()[6]).contexts.length, 0);
    // a version-2 snapshot (no shadow) restores, with this renderer's capabilities
    device.set_state([2, ARENA, ARENA_BYTES, 0, 0, 0]);
    assert.equal(JSON.parse(device.get_state()[6]).contexts.length, 0);
    assert.equal(JSON.parse(device.get_state()[6]).capabilities.limits.maxTextureDimension2D, 4096);
});

(async () => {
    for (const { name, fn } of tests) {
        try {
            await fn();
            console.log("ok   " + name);
        } catch (error) {
            console.error("FAIL " + name + "\n" + (error && error.stack || error));
            process.exitCode = 1;
            return;
        }
    }
    console.log(tests.length + " GL shadow tests passed");
})();
