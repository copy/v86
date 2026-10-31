#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_objects.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_state.js");
const caps = require("../../src/browser/glbridge/gl-webgpu/gl_caps.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const { GLStream, GL } = require("./gl_stream_builder.js");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js");
const { createFakeHost } = require("./gl_fake_gpu.js");
const { C, F, RECORDS } = P;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const shadow = () => { const s = new GLShadow(); s.setCapabilities(caps.capabilities({ maxTextureDimension2D: 4096 }, {})); return s; };
function scene(format = 0) {
    const s = new GLStream().makeCurrent(1, 0, 0, 80, 60, 1, 1);
    // makeCurrent's helper predates the format field.
    s.record(P.CTRL.MAKE_CURRENT, P.encodeRecord("MAKE_CURRENT", { hwnd: 2, width: 80, height: 60, context_id: 2, format }));
    s.ask = (pname, kind = C.V86GL_STATE_DOUBLE, capacity = 128) => {
        const header = P.encodeRecord("QUERY_STATE", { pname, value_kind: kind, data_size: capacity });
        const payload = new Uint8Array(header.length + capacity).fill(0xA5); payload.set(header);
        s.record(P.GLFN.QUERY_STATE, payload);
        const response = s.payloadView();
        return () => {
            const view = response.view;
            const count = view.getUint32(F.QUERY_STATE.count, true);
            return { status: view.getUint32(F.QUERY_STATE.status, true), error: view.getUint32(F.QUERY_STATE.error, true),
                values: Array.from({ length: count }, (_, i) => view.getFloat64(RECORDS.QUERY_STATE.size + i * 8, true)),
                tail: response.bytes.subarray(RECORDS.QUERY_STATE.size + count * 8) };
        };
    };
    return s;
}
const check = (answer, values) => { const a = answer(); assert.equal(a.status, C.V86GL_SYNC_QUERY_STATUS_OK); assert.deepEqual(a.values, values); assert.ok(a.tail.every(b => b === 0xA5), "only returned values are written"); };

test("vectors and conversions follow GL types rather than scalar QUERY_INTEGER", () => {
    const s = scene();
    const initial = s.ask(GL.VIEWPORT);
    s.call("VIEWPORT", -20, 5, 120, 45).call("DEPTH_RANGE", -2, 0.75).call("CLEAR_COLOR", 0.5, 0, 1, 0.25);
    const viewport = s.ask(GL.VIEWPORT, C.V86GL_STATE_INTEGER), depth = s.ask(GL.DEPTH_RANGE), color = s.ask(GL.COLOR_CLEAR_VALUE, C.V86GL_STATE_INTEGER);
    s.call("LINE_WIDTH", 2.75);
    const rounded = s.ask(GL.LINE_WIDTH, C.V86GL_STATE_INTEGER), flags = s.ask(GL.COLOR_CLEAR_VALUE, C.V86GL_STATE_BOOLEAN);
    shadow().process(s.bytes());
    check(initial, [0, 0, 80, 60]); check(viewport, [-20, 5, 120, 45]); check(depth, [0, 0.75]);
    check(color, [1073741823, 0, 2147483647, 536870911]); check(rounded, [3]); check(flags, [1, 0, 1, 1]);
});
test("all four query types agree with the recorded Apple GL 2.1 reference", () => {
    const reference = require("./gl_conformance/state_reference.json");
    const s = scene();
    const asks = [];
    const record = (name, pname) => {
        for (const [key, kind] of [["integer", C.V86GL_STATE_INTEGER], ["float", C.V86GL_STATE_FLOAT],
                ["double", C.V86GL_STATE_DOUBLE], ["boolean", C.V86GL_STATE_BOOLEAN]]) {
            const expected = reference.cases[name][key].slice();
            // GL's reference page specifies INT_MIN at -1. Apple's legacy
            // driver instead returns -INT_MAX. Keep the specified endpoint.
            if (name === "accum" && key === "integer") expected[0] = -2147483648;
            asks.push([s.ask(pname, kind), expected, name + "/" + key]);
        }
    };
    s.call("CLEAR_COLOR", 0.5, 0, 1, 0.25); record("color", GL.COLOR_CLEAR_VALUE);
    s.call("CLEAR_ACCUM", -1, -0.5, 0, 0.5); record("accum", GL.ACCUM_CLEAR_VALUE);
    s.call("DEPTH_RANGE", 0.25, 0.75); record("depth", GL.DEPTH_RANGE);
    s.call("LINE_WIDTH", 2.75); record("width", GL.LINE_WIDTH);
    s.call("VIEWPORT", -20, 5, 120, 45); record("viewport", GL.VIEWPORT);
    s.call("MATRIX_MODE", GL.MODELVIEW).call("TRANSLATEF", 2, 3, 4).call("SCALEF", 2, 4, 8); record("modelview", GL.MODELVIEW_MATRIX);
    s.call("MATRIX_MODE", GL.TEXTURE).call("ACTIVE_TEXTURE", GL.TEXTURE0 + 3).call("TRANSLATEF", 7, 8, 9); record("texture3", GL.TEXTURE_MATRIX);
    s.call("ACTIVE_TEXTURE", GL.TEXTURE0); record("texture0", GL.TEXTURE_MATRIX);
    s.call("PUSH_CLIENT_ATTRIB", 1).call("PIXEL_STOREI", GL.UNPACK_ROW_LENGTH, 31).call("POP_CLIENT_ATTRIB"); record("unpack", GL.UNPACK_ROW_LENGTH);
    shadow().process(s.bytes());
    for (const [answer, expected, label] of asks) assert.deepEqual(answer().values, expected, label);
});
test("matrices use column-major multiplication and independent texture stacks", () => {
    const s = scene().call("TRANSLATEF", 2, 3, 4).call("SCALEF", 2, 4, 8);
    const model = s.ask(GL.MODELVIEW_MATRIX);
    s.call("MATRIX_MODE", GL.TEXTURE).call("ACTIVE_TEXTURE", GL.TEXTURE0 + 3).call("TRANSLATEF", 7, 8, 9).call("PUSH_MATRIX").call("SCALEF", 3, 3, 3);
    const depth = s.ask(GL.TEXTURE_STACK_DEPTH);
    s.call("POP_MATRIX"); const texture3 = s.ask(GL.TEXTURE_MATRIX);
    s.call("ACTIVE_TEXTURE", GL.TEXTURE0); const texture0 = s.ask(GL.TEXTURE_MATRIX);
    shadow().process(s.bytes());
    check(model, [2, 0, 0, 0, 0, 4, 0, 0, 0, 0, 8, 0, 2, 3, 4, 1]); check(depth, [2]);
    check(texture3, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 7, 8, 9, 1]);
    check(texture0, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
});
test("attribute masks restore only their state; client pixel store is separate", () => {
    const s = scene().call("PUSH_ATTRIB", 0x800).call("VIEWPORT", 3, 4, 5, 6).call("LINE_WIDTH", 4).call("POP_ATTRIB");
    const viewport = s.ask(GL.VIEWPORT), line = s.ask(GL.LINE_WIDTH);
    s.call("PUSH_CLIENT_ATTRIB", 1).call("PIXEL_STOREI", GL.UNPACK_ROW_LENGTH, 31).call("POP_CLIENT_ATTRIB");
    const unpack = s.ask(GL.UNPACK_ROW_LENGTH);
    s.call("ACTIVE_TEXTURE", GL.TEXTURE0 + 3).call("PUSH_ATTRIB", 0x40000).call("ACTIVE_TEXTURE", GL.TEXTURE0).call("POP_ATTRIB");
    const unit = s.ask(GL.ACTIVE_TEXTURE);
    shadow().process(s.bytes());
    check(viewport, [0, 0, 80, 60]); check(line, [4]); check(unpack, [0]); check(unit, [GL.TEXTURE0 + 3]);
});
test("format queries describe the drawable, not the adapter", () => {
    const s = scene(C.V86GL_FORMAT_SINGLE_BUFFER | 4 << C.V86GL_FORMAT_SAMPLES_SHIFT);
    const double = s.ask(GL.DOUBLEBUFFER), samples = s.ask(GL.SAMPLES), buffers = s.ask(GL.SAMPLE_BUFFERS), max = s.ask(GL.MAX_VIEWPORT_DIMS);
    shadow().process(s.bytes()); check(double, [0]); check(samples, [4]); check(buffers, [1]); check(max, [4096, 4096]);
});
test("unsupported, undersized and Begin/End queries preserve the output", () => {
    const s = scene(); const unknown = s.ask(0xDEADBEEF), small = s.ask(GL.VIEWPORT, C.V86GL_STATE_FLOAT, 8);
    s.call("BEGIN", GL.POINTS); const inside = s.ask(GL.VIEWPORT); s.call("END"); const after = s.ask(GL.VIEWPORT);
    shadow().process(s.bytes());
    assert.equal(unknown().status, C.V86GL_SYNC_QUERY_STATUS_FAILED); assert.equal(unknown().error, GL.INVALID_ENUM);
    for (const a of [unknown(), small(), inside()]) { assert.deepEqual(a.values, []); assert.ok(a.tail.every(b => b === 0xA5)); }
    assert.equal(small().error, GL.INVALID_VALUE); assert.equal(inside().error, GL.INVALID_OPERATION); check(after, [0, 0, 80, 60]);
});
test("snapshot and context switches preserve the state and its stacks", () => {
    const first = shadow(), s = scene().call("LINE_WIDTH", 3).call("PUSH_ATTRIB", 4).call("LINE_WIDTH", 6).call("TRANSLATEF", 1, 2, 3);
    first.process(s.bytes()); const saved = JSON.parse(JSON.stringify(first.getState())), copy = shadow(); copy.setState(saved);
    assert.deepEqual(copy.getState(), saved);
    const next = scene().call("POP_ATTRIB"), width = next.ask(GL.LINE_WIDTH), matrix = next.ask(GL.MODELVIEW_MATRIX);
    copy.process(next.bytes()); check(width, [3]); check(matrix, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1]);
});
test("the renderer leaves answered typed queries untouched", async () => {
    const s = scene().call("VIEWPORT", 2, 3, 4, 5), answer = s.ask(GL.VIEWPORT);
    const bytes = s.bytes(); shadow().process(bytes); const before = bytes.slice();
    const { host } = createFakeHost(), executor = new GLWebGPUExecutor(null, { host }); await executor.initialize();
    executor.submit(bytes, {}); assert.deepEqual(bytes, before); check(answer, [2, 3, 4, 5]);
});
(async () => {
    for (const { name, fn } of tests) { await fn(); console.log("ok   " + name); }
    console.log(tests.length + " typed GL state tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
