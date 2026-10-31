"use strict";
const assert = require("node:assert/strict"), { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_render.js"); require("../../src/browser/glbridge/gl-webgpu/gl_shadow_images.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js"), { GLStream, GL } = require("./gl_stream_builder.js"),
    { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"), { createFakeHost } = require("./gl_fake_gpu.js"), reference = require("./gl_conformance/render_errors_reference.json").cases;
function phase(s, name) {
    const multi = (primcount, counts) => { const bytes = new Uint8Array(8 + counts.length * 8); bytes.set(P.encodeRecord("MULTI_DRAW_ARRAYS_DIRECT", { mode: GL.POINTS, primcount })); counts.forEach((count, i) => bytes.set(P.encodeRecord("MULTI_DRAW_ARRAYS_ENTRY", { first: 0, count }), 8 + i * 8)); return s.record(P.GLFN.MULTI_DRAW_ARRAYS_DIRECT, bytes); };
    const read = (width, format = GL.RGBA, type = GL.UNSIGNED_BYTE) => s.readPixels(0, 0, width, 1, format, type, 4);
    const draw = (width, format = GL.RGBA, type = GL.UNSIGNED_BYTE) => s.drawPixels(width, 1, format, type, new Uint8Array(4));
    switch (name) {
        case "clear_mask": return s.call("CLEAR", 1);
        case "clear_accum": return s.call("CLEAR", GL.ACCUM_BUFFER_BIT);
        case "clear_begin": return s.call("BEGIN", GL.POINTS).call("CLEAR", GL.COLOR_BUFFER_BIT).call("END");
        case "arrays_mode": return s.call("DRAW_ARRAYS_DIRECT", 0xFFFF, 0, 0);
        case "arrays_first": return s.call("DRAW_ARRAYS_DIRECT", GL.POINTS, -1, 0);
        case "arrays_count": return s.call("DRAW_ARRAYS_DIRECT", GL.POINTS, 0, -1);
        case "elements_type": case "elements_count": return s.record(P.GLFN.DRAW_ELEMENTS_DIRECT, P.encodeRecord("DRAW_ELEMENTS_DIRECT", { mode: GL.POINTS, count: name === "elements_count" ? -1 : 0, type: name === "elements_type" ? GL.FLOAT : GL.UNSIGNED_BYTE }));
        case "multi_primcount": return multi(-1, []);
        case "multi_count": return multi(2, [0, -1]);
        case "read_width": return read(-1);
        case "read_format": return read(1, 0xFFFF);
        case "read_type": return read(1, GL.RGBA, 0xFFFF);
        case "read_packed": return read(1, GL.RGBA, GL.UNSIGNED_SHORT_5_6_5);
        case "read_color_index": return read(1, GL.COLOR_INDEX);
        case "read_zero": return read(0);
        case "read_bitmap": return read(0, GL.RGBA, 0x1A00);
        case "draw_width": return draw(-1);
        case "draw_format": return draw(1, 0xFFFF);
        case "draw_type": return draw(1, GL.RGBA, 0xFFFF);
        case "draw_packed": return draw(1, GL.RGBA, GL.UNSIGNED_SHORT_5_6_5);
        case "draw_zero": return draw(0);
        case "copy_width": return s.call("COPY_PIXELS", 0, 0, -1, 1, GL.COLOR);
        case "copy_type": return s.call("COPY_PIXELS", 0, 0, 1, 1, 0xFFFF);
        case "accum_op": return s.call("ACCUM", 0xFFFF, 1);
        case "accum_missing": return s.call("ACCUM", 0x101, 1);
        case "blit_mask": case "blit_filter": case "blit_depth_linear": case "blit_zero": return s.call("BLIT_FRAMEBUFFER", 0, 0, 1, 1, 0, 0, 1, 1,
            name === "blit_mask" ? 1 : name === "blit_depth_linear" ? GL.DEPTH_BUFFER_BIT : 0, name === "blit_filter" ? 0xFFFF : name === "blit_depth_linear" ? GL.LINEAR : GL.NEAREST);
        case "get_error_begin": s.call("BEGIN", GL.POINTS).queryError(); return s.call("END");
        case "get_error_compile_begin": s.record(P.GLFN.LIST_COMMAND, P.encodeRecord("LIST_COMMAND", { operation: 1, name: 1, value: GL.COMPILE })).call("BEGIN", GL.POINTS); s.queryError(); s.call("END"); return s.record(P.GLFN.LIST_COMMAND, P.encodeRecord("LIST_COMMAND", { operation: 2 }));
        default: throw new Error(name);
    }
}
(async () => {
    for (const copied of [false, true]) for (const entry of reference) {
        const shadow = new GLShadow(), { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true }); await gpu.initialize(); shadow.setCapabilities(gpu.capabilities());
        const submit = s => { const bytes = s.bytes(), segments = shadow.process(bytes); for (const segment of segments || [{ offset: 0, length: bytes.length }]) { const part = segment.bytes || bytes.subarray(segment.offset, segment.offset + segment.length); gpu.submit(copied ? part.slice() : part, {}); } };
        submit(new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1));
        const stream = new GLStream(); phase(stream, entry.name); const payload = entry.name.startsWith("read_") ? stream.payloadView() : null;
        stream.queryError(); const answer = stream.payloadView(); stream.queryError(); const cleared = stream.payloadView(), memory = stream.bytes(), segments = shadow.process(memory);
        const expected = entry.name === "accum_op" ? GL.INVALID_ENUM : entry.error; // Both INVALID_ENUM and no-buffer INVALID_OPERATION are applicable.
        assert.equal(answer.view.getUint32(P.F.QUERY_ERROR.status, true), 1, entry.name + " CPU status");
        assert.equal(answer.view.getUint32(P.F.QUERY_ERROR.value, true), expected, entry.name);
        assert.equal(cleared.view.getUint32(P.F.QUERY_ERROR.status, true), 1); assert.equal(cleared.view.getUint32(P.F.QUERY_ERROR.value, true), 0);
        if (payload) { assert.equal(payload.view.getUint32(P.F.READ_PIXELS.status, true), expected ? 2 : 1, entry.name + " read status"); assert.deepEqual(Array.from(payload.bytes.subarray(32)), [205, 205, 205, 205]); }
        for (const segment of segments || [{ offset: 0, length: memory.length }]) { const part = segment.bytes || memory.subarray(segment.offset, segment.offset + segment.length); gpu.submit(copied ? part.slice() : part, {}); }
        await gpu.idle(); assert.equal(gpu.stats.refusals, 0, entry.name); assert.equal(gpu.hostErrors.length, 0, entry.name);
    }
    // Direct packets must only address captured buffer storage; the range
    // hint does not limit actual indices (DrawRangeElements' end is a hint).
    const buffers = new GLShadow(); buffers.process(new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1)
        .call("BIND_BUFFER", GL.ARRAY_BUFFER, 1).bufferData(GL.ARRAY_BUFFER, 36, GL.STATIC_DRAW, new Uint8Array(36))
        .pointerVBO("VERTEX_POINTER_VBO", 3, GL.FLOAT, 0, 0).call("ENABLE_CLIENT_STATE", GL.VERTEX_ARRAY)
        .call("BIND_BUFFER", GL.ELEMENT_ARRAY_BUFFER, 2).bufferData(GL.ELEMENT_ARRAY_BUFFER, 3, GL.STATIC_DRAW, Uint8Array.of(0, 1, 2)).bytes());
    for (const [stream, error] of [[new GLStream().call("DRAW_ARRAYS_DIRECT", GL.TRIANGLES, 0, 3), 0],
        [new GLStream().call("DRAW_ARRAYS_DIRECT", GL.TRIANGLES, 1, 3), GL.INVALID_OPERATION],
        [new GLStream().record(P.GLFN.DRAW_RANGE_ELEMENTS_DIRECT, P.encodeRecord("DRAW_RANGE_ELEMENTS_DIRECT", { mode: GL.TRIANGLES, start: 0, end: 1, count: 3, type: GL.UNSIGNED_BYTE })), 0],
        [new GLStream().record(P.GLFN.DRAW_RANGE_ELEMENTS_DIRECT, P.encodeRecord("DRAW_RANGE_ELEMENTS_DIRECT", { mode: GL.TRIANGLES, start: 2, end: 1, count: 3, type: GL.UNSIGNED_BYTE })), GL.INVALID_VALUE],
        [new GLStream().record(P.GLFN.DRAW_ELEMENTS_DIRECT, P.encodeRecord("DRAW_ELEMENTS_DIRECT", { mode: GL.TRIANGLES, count: 4, type: GL.UNSIGNED_BYTE })), GL.INVALID_OPERATION],
        [new GLStream().drawArrays(GL.TRIANGLES, 4, { vertex: { enabled: true, size: 3, type: GL.FLOAT, stride: 0, data: new Uint8Array(36) } }), GL.INVALID_OPERATION]]) {
        buffers.process(stream.bytes()); assert.equal(buffers.current.error, error); buffers.current.error = 0;
    }
    for (const [name, fields] of [["QUERY_INTEGER", { pname: 0xFFFF }], ["QUERY_GL_STRING", { name: 0xFFFF }],
        ["QUERY_STATE", { pname: 0xFFFF, value_kind: 1 }], ["QUERY_PARAMETER", { query_kind: 0xFFFF, value_kind: 1 }],
        ["QUERY_OBJECT_IV", { object_kind: 0xFFFF }], ["QUERY_OBJECT_LOG", { object_kind: 0xFFFF }], ["QUERY_OBJECT_BATCH", { object_kind: 0xFFFF }],
        ["QUERY_ACTIVE", { active_kind: 0xFFFF }], ["QUERY_LOCATION", { location_kind: 0xFFFF }], ["QUERY_UNIFORM", { value_kind: 0xFFFF }]]) {
        const cpu = new GLShadow(); cpu.setCapabilities(require("../../src/browser/glbridge/gl-webgpu/gl_caps.js").capabilities({}, {}));
        const stream = new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1).record(P.GLFN[name], P.encodeRecord(name, fields)), query = stream.payloadView();
        stream.queryError(); const error = stream.payloadView(); cpu.process(stream.bytes()); assert.equal(query.view.getUint32(P.F[name].status, true), 2, name);
        assert.equal(error.view.getUint32(P.F.QUERY_ERROR.value, true), GL.INVALID_ENUM, name);
    }
    const cpu = new GLShadow(), inside = new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1).call("BEGIN", GL.POINTS)
        .record(P.GLFN.QUERY_OBJECT_IV, P.encodeRecord("QUERY_OBJECT_IV", { object_kind: P.C.V86GL_OBJECT_KIND_SHADER, name: 1, pname: GL.COMPILE_STATUS })), illegal = inside.payloadView();
    inside.call("END").queryError(); const error = inside.payloadView(); cpu.process(inside.bytes());
    assert.equal(illegal.view.getUint32(P.F.QUERY_OBJECT_IV.status, true), 2); assert.equal(error.view.getUint32(P.F.QUERY_ERROR.value, true), GL.INVALID_OPERATION);
    const beginRead = new GLStream().call("BEGIN", GL.POINTS), readReply = beginRead.readPixels(0, 0, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, 4);
    beginRead.call("END").queryError(); const readError = beginRead.payloadView(); buffers.process(beginRead.bytes());
    assert.equal(readReply.view.getUint32(P.F.READ_PIXELS.status, true), 2); assert.equal(readError.view.getUint32(P.F.QUERY_ERROR.value, true), GL.INVALID_OPERATION);
    // A malformed tail is discarded; already accepted state remains ordered.
    for (const tail of [Uint8Array.of(1, 0, 255, 255), Uint8Array.of(1, 0, 4, 0, 0), Uint8Array.of(1, 2, 3)]) {
        const shadow = new GLShadow(), stream = new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1).call("LINE_WIDTH", 3), prefix = stream.bytes(), bytes = new Uint8Array(prefix.length + tail.length); bytes.set(prefix); bytes.set(tail, prefix.length);
        const segments = shadow.process(bytes); assert.equal(shadow.current.state.values[GL.LINE_WIDTH][0], 3); assert.equal(shadow.stats.malformed, 1);
        assert.deepEqual(segments, [{ offset: 0, length: prefix.length }]);
    }
    const shadow = new GLShadow(), short = new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1).record(P.GLFN.CLEAR, new Uint8Array(1)).record(254, new Uint8Array()).record(P.GLFN.QUERY_STATE, new Uint8Array(16)); const shortQuery = short.payloadView(); short.queryError(); const memory = short.bytes(), segments = shadow.process(memory);
    assert.equal(shadow.stats.malformed, 3); assert.equal(shortQuery.view.getUint32(P.F.QUERY_STATE.status, true), 2); assert.equal(short.payloadView().view.getUint32(P.F.QUERY_ERROR.value, true), GL.INVALID_OPERATION); assert.equal(segments.length, 2);
    console.log("gl_render_validation_test: 32 native render errors/no-ops, CPU-only GetError, read destination guards and malformed stream filtering passed in both modes");
})().catch(error => { console.error(error); process.exitCode = 1; });
