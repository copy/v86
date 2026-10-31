"use strict";
const assert = require("node:assert/strict"), P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_buffers.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_lists.js");
const { GLStream, GL } = require("./gl_stream_builder.js");
const payload = new GLStream().bufferData(GL.ARRAY_BUFFER, 1024, GL.STATIC_DRAW, new Uint8Array(1024).map((v, i) => i)).bytes().slice(4);
const scene = () => new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1).call("BIND_BUFFER", GL.ARRAY_BUFFER, 1).bufferData(GL.ARRAY_BUFFER, 4, GL.STATIC_DRAW, new Uint8Array([9, 8, 7, 6]));
function chunk(token, offset, length, fields = {}) {
    const data = payload.slice(offset, offset + length), header = P.encodeRecord("UPLOAD_CHUNK", { token, opcode: P.GLFN.BUFFER_DATA, total_size: payload.length, offset, data_size: data.length, ...fields }), bytes = new Uint8Array(header.length + data.length);
    bytes.set(header);bytes.set(data, header.length);return new GLStream().record(P.GLFN.UPLOAD_CHUNK, bytes).bytes();
}
const s = new GLShadow();s.process(scene().bytes());
assert.deepEqual(s.process(chunk(1, 0, 400)), []);assert.deepEqual([...s.boundBuffer(GL.ARRAY_BUFFER).data], [9, 8, 7, 6]);
assert.deepEqual(s.process(chunk(1, 0, 400)), [], "identical retry is not appended twice");
const restored = new GLShadow();restored.setState(JSON.parse(JSON.stringify(s.getState())));
assert.equal(restored.current.upload.received, 400);assert.deepEqual([...restored.boundBuffer(GL.ARRAY_BUFFER).data], [9, 8, 7, 6]);
const final = chunk(1, 400, payload.length - 400), segments = restored.process(final);
assert.equal(segments.length, 1);assert.equal(segments[0].bytes.length, payload.length + 8);assert.deepEqual([...restored.boundBuffer(GL.ARRAY_BUFFER).data], [...payload.slice(16)]);
assert.deepEqual(restored.process(final), [], "duplicate final cannot execute twice");assert.equal(restored.current.error, 0, "a successful duplicate does not become a GL error");
const saved = restored.getState(), again = new GLShadow();again.setState(saved);assert.deepEqual(again.process(final), [], "completed token survives restore");assert.equal(again.current.error, 0);
for (const [name, make, expected] of [
    ["hole", () => [chunk(2, 0, 400), chunk(2, 401, 100)], GL.INVALID_OPERATION],
    ["mismatched token", () => [chunk(2, 0, 400), chunk(3, 400, 100)], GL.INVALID_OPERATION],
    ["mismatched opcode", () => [chunk(2, 0, 400), chunk(2, 400, 100, { opcode: P.GLFN.BUFFER_SUB_DATA })], GL.INVALID_OPERATION],
    ["query cannot be fragmented", () => [chunk(2, 0, 400, { opcode: P.GLFN.QUERY_ERROR })], GL.INVALID_OPERATION],
    ["bounded total", () => [chunk(2, 0, 400, { total_size: P.C.V86GL_MAX_UPLOAD_BYTES + 1 })], GL.OUT_OF_MEMORY],
    ["wrong length", () => [chunk(2, 0, 400, { data_size: 401 })], GL.INVALID_OPERATION],
    ["changed retry", () => { const different = chunk(2, 0, 400);different[different.length - 1] ^= 1;return [chunk(2, 0, 400), different]; }, GL.INVALID_OPERATION],
]) {
    const cpu = new GLShadow();cpu.process(scene().bytes());for (const bytes of make()) cpu.process(bytes);
    assert.equal(cpu.current.error, expected, name);assert.equal(cpu.current.upload, null, name);assert.deepEqual([...cpu.boundBuffer(GL.ARRAY_BUFFER).data], [9, 8, 7, 6], name);
}
// Another context can make progress while an upload is suspended. Switching
// back resumes the original context's bytes and object binding.
s.process(new GLStream().makeCurrent(2, 0, 0, 16, 16, 2, 2).call("BIND_BUFFER", GL.ARRAY_BUFFER, 2).bytes());s.process(chunk(1, 0, 200));
s.process(new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1).bytes());s.process(chunk(1, 400, payload.length - 400));assert.equal(s.boundBuffer(GL.ARRAY_BUFFER).size, 1024);
s.process(new GLStream().record(P.CTRL.DESTROY_CONTEXT, P.encodeRecord("DESTROY_CONTEXT", { context_id: 2 })).bytes());assert.equal(s.contexts.size, 1);
const budget = new GLShadow();
for (const id of [1, 2, 3]) {
    budget.process(new GLStream().makeCurrent(id, 0, 0, 16, 16, id, id).bytes());
    budget.process(chunk(id, 0, 400, { total_size: id === 3 ? payload.length : P.C.V86GL_MAX_UPLOAD_BYTES / 2 }));
    assert.equal(budget.current.error, id === 3 ? GL.OUT_OF_MEMORY : 0, "combined in-flight storage is bounded across contexts");
}
budget.reset();
const bad = JSON.parse(JSON.stringify(restored.getState()));bad.contexts[0].upload = { token: 9, opcode: P.GLFN.BUFFER_DATA, total_size: 100, received: 2, record: [0] };
assert.throws(() => new GLShadow().setState(bad), /upload checkpoint/);
console.log("PASS upload fragments: atomic state, bounded assembly, exact retries, CPU checkpoint, context isolation and malformed input");
