#!/usr/bin/env node
// CPU rejection must keep both state machines unchanged, without moving the
// inline response addresses. Expectations are GL 2.1's errors, not handler stats.
"use strict";
const assert = require("node:assert/strict");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_objects.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_state.js");
const caps = require("../../src/browser/glbridge/gl-webgpu/gl_caps.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js");
const { createFakeHost } = require("./gl_fake_gpu.js");
const { GLStream, GL } = require("./gl_stream_builder.js");
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const shadow = () => { const s = new GLShadow(); s.setCapabilities(caps.capabilities({ maxTextureDimension2D: 4096 }, {})); return s; };
const scene = () => new GLStream().makeCurrent(1, 0, 0, 64, 64, 1, 1);
function ask(stream, pname) {
    const header = P.encodeRecord("QUERY_STATE", { pname, value_kind: P.C.V86GL_STATE_DOUBLE, data_size: 128 });
    const payload = new Uint8Array(header.length + 128); payload.set(header);
    stream.record(P.GLFN.QUERY_STATE, payload); const response = stream.payloadView();
    return () => {
        assert.equal(response.view.getUint32(P.F.QUERY_STATE.status, true), 1);
        return Array.from({ length: response.view.getUint32(P.F.QUERY_STATE.count, true) },
            (_, i) => response.view.getFloat64(header.length + i * 8, true));
    };
}
function error(stream) { stream.queryError(); const response = stream.payloadView(); return () => {
    assert.equal(response.view.getUint32(P.F.QUERY_ERROR.status, true), 1); return response.view.getUint32(P.F.QUERY_ERROR.value, true);
}; }
async function render(bytes) {
    const { host } = createFakeHost(), executor = new GLWebGPUExecutor(null, { host, strict: true });
    await executor.initialize(); executor.submit(bytes, {}); await executor.idle();
    assert.equal(executor.stats.refusals, 0); assert.deepEqual(executor.hostErrors, []);
    return executor;
}

test("invalid enums and values are discarded before either side mutates state", async () => {
    const cases = [
        ["VIEWPORT", [0, 0, -1, 64], GL.INVALID_VALUE, GL.VIEWPORT, [0, 0, 64, 64]],
        ["SCISSOR", [0, 0, 64, -1], GL.INVALID_VALUE, GL.SCISSOR_BOX, [0, 0, 64, 64]],
        ["DEPTH_FUNC", [0], GL.INVALID_ENUM, GL.DEPTH_FUNC, [GL.LESS]],
        ["CULL_FACE", [0], GL.INVALID_ENUM, GL.CULL_FACE_MODE, [GL.BACK]],
        ["FRONT_FACE", [0], GL.INVALID_ENUM, GL.FRONT_FACE, [GL.CCW]],
        ["SHADE_MODEL", [0], GL.INVALID_ENUM, GL.SHADE_MODEL, [GL.SMOOTH]],
        ["LINE_WIDTH", [0], GL.INVALID_VALUE, GL.LINE_WIDTH, [1]],
        ["POINT_SIZE", [-1], GL.INVALID_VALUE, GL.POINT_SIZE, [1]],
        ["POLYGON_MODE", [0, GL.FILL], GL.INVALID_ENUM, GL.POLYGON_MODE, [GL.FILL, GL.FILL]],
        ["BLEND_FUNC", [GL.ONE, GL.SRC_ALPHA_SATURATE], GL.INVALID_ENUM, GL.BLEND_DST, [GL.ZERO]],
        ["BLEND_FUNC_SEPARATE", [GL.ZERO, GL.ONE, GL.ONE, 0xDEAD], GL.INVALID_ENUM, GL.BLEND_SRC_RGB, [GL.ONE]],
        ["BLEND_EQUATION_SEPARATE", [GL.FUNC_SUBTRACT, 0xDEAD], GL.INVALID_ENUM, GL.BLEND_EQUATION_RGB, [GL.FUNC_ADD]],
        ["ALPHA_FUNC", [0, 0.5], GL.INVALID_ENUM, GL.ALPHA_TEST_REF, [0]],
        ["PIXEL_STOREI", [GL.PACK_ALIGNMENT, 3], GL.INVALID_VALUE, GL.PACK_ALIGNMENT, [4]],
        ["PIXEL_STOREI", [GL.UNPACK_ROW_LENGTH, -1], GL.INVALID_VALUE, GL.UNPACK_ROW_LENGTH, [0]],
        ["ACTIVE_TEXTURE", [GL.TEXTURE0 + 8], GL.INVALID_ENUM, GL.ACTIVE_TEXTURE, [GL.TEXTURE0]],
        ["MATRIX_MODE", [GL.COLOR_MATRIX_SGI], GL.INVALID_ENUM, GL.MATRIX_MODE, [GL.MODELVIEW]],
        ["ORTHO", [0, 0, -1, 1, 1, 10], GL.INVALID_VALUE, GL.MODELVIEW_MATRIX, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]],
        ["FRUSTUM", [-1, 1, -1, 1, 0, 10], GL.INVALID_VALUE, GL.MODELVIEW_STACK_DEPTH, [1]],
    ];
    for (const [name, args, expectedError, pname, expected] of cases) {
        const s = scene(), at = s.length;
        s.call(name, ...args); const value = ask(s, pname), first = error(s), clear = error(s);
        const bytes = s.bytes(), before = bytes.slice(), length = bytes.length;
        shadow().process(bytes);
        assert.equal(bytes.length, length); assert.ok(P.isRejected(new DataView(bytes.buffer).getUint16(at, true)), name);
        assert.deepEqual(bytes.subarray(at + 2, at + 4 + P.payloadBytes(P.SIGNATURES[name][1])),
            before.subarray(at + 2, at + 4 + P.payloadBytes(P.SIGNATURES[name][1])), "payload/size remain at their original addresses");
        await render(bytes); assert.deepEqual(value(), expected, name); assert.equal(first(), expectedError, name); assert.equal(clear(), GL.NO_ERROR);
    }
});
test("Begin/End rejects nested Begin and state changes without losing the outer primitive", async () => {
    const s = scene().call("BEGIN", GL.TRIANGLES).call("BEGIN", GL.LINES).call("LINE_WIDTH", 5).call("TRANSLATEF", 2, 3, 4).call("END");
    const width = ask(s, GL.LINE_WIDTH), matrix = ask(s, GL.MODELVIEW_MATRIX), first = error(s);
    const bytes = s.bytes(); shadow().process(bytes); await render(bytes);
    assert.equal(first(), GL.INVALID_OPERATION); assert.deepEqual(width(), [1]); assert.deepEqual(matrix(), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
});
test("matrix and attribute stack bounds report errors and keep usable stacks", async () => {
    const s = scene().call("POP_MATRIX"), underflow = error(s);
    for (let i = 0; i < 32; ++i) s.call("PUSH_MATRIX");
    const depth = ask(s, GL.MODELVIEW_STACK_DEPTH), overflow = error(s);
    s.call("POP_ATTRIB"); const attribUnderflow = error(s);
    for (let i = 0; i < 17; ++i) s.call("PUSH_ATTRIB", 4);
    const attribOverflow = error(s);
    const bytes = s.bytes(); shadow().process(bytes); await render(bytes);
    assert.equal(underflow(), GL.STACK_UNDERFLOW); assert.deepEqual(depth(), [32]); assert.equal(overflow(), GL.STACK_OVERFLOW);
    assert.equal(attribUnderflow(), GL.STACK_UNDERFLOW); assert.equal(attribOverflow(), GL.STACK_OVERFLOW);
});
test("valid calls after a rejected call continue in the same batch", async () => {
    const s = scene().call("DEPTH_FUNC", 0).call("DEPTH_FUNC", GL.GEQUAL), value = ask(s, GL.DEPTH_FUNC), first = error(s);
    const bytes = s.bytes(); shadow().process(bytes); const renderer = await render(bytes);
    assert.deepEqual(value(), [GL.GEQUAL]); assert.equal(renderer.current.depthFunc, GL.GEQUAL); assert.equal(first(), GL.INVALID_ENUM);
});
test("accepted viewport limits are normalized before forwarding", async () => {
    const s = scene().call("VIEWPORT", -10, 7, 10000, 12000), value = ask(s, GL.VIEWPORT);
    const bytes = s.bytes(); shadow().process(bytes); const renderer = await render(bytes);
    assert.deepEqual(value(), [-10, 7, 4096, 4096]); assert.equal(renderer.current.viewport.width, 4096);
});
test("GL_COLOR is a matrix mode and SRC_ALPHA_SATURATE is legal for separate source alpha", async () => {
    const s = scene().call("MATRIX_MODE", GL.COLOR).call("TRANSLATEF", 1, 2, 3)
        .call("BLEND_FUNC_SEPARATE", GL.ONE, GL.ZERO, GL.SRC_ALPHA_SATURATE, GL.ONE);
    const mode = ask(s, GL.MATRIX_MODE), matrix = ask(s, GL.COLOR_MATRIX_SGI), alpha = ask(s, GL.BLEND_SRC_ALPHA), first = error(s);
    const bytes = s.bytes(); shadow().process(bytes); await render(bytes);
    assert.deepEqual(mode(), [GL.COLOR]); assert.deepEqual(matrix(), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1]);
    assert.deepEqual(alpha(), [GL.SRC_ALPHA_SATURATE]); assert.equal(first(), GL.NO_ERROR);
});
test("short fixed headers never enter CPU handlers or throw a DataView range error", () => {
    const s = scene().record(P.GLFN.LOAD_MATRIXF, new Uint8Array(4)).record(P.GLFN.MATRIX_MODE, new Uint8Array(1));
    const value = ask(s, GL.MATRIX_MODE), state = shadow(); state.process(s.bytes());
    assert.deepEqual(value(), [GL.MODELVIEW]); assert.equal(state.stats.malformed, 2);
});
(async () => { for (const { name, fn } of tests) { await fn(); console.log("ok   " + name); } console.log(tests.length + " GL CPU validation tests passed"); })()
    .catch(error => { console.error(error); process.exitCode = 1; });
