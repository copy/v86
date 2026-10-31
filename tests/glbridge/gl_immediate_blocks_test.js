"use strict";
const assert = require("node:assert/strict"), P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js"), arrays = require("../../src/browser/glbridge/gl-webgpu/gl_client_arrays.js");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_select.js");require("../../src/browser/glbridge/gl-webgpu/gl_shadow_lists.js");
const { GLStream, GL } = require("./gl_stream_builder.js"), cases = require("./gl_selection_cases.js");
const listCommand = (s, operation, name = 0, value = 0) => s.record(P.GLFN.LIST_COMMAND, P.encodeRecord("LIST_COMMAND", { operation, name, value }));
const block = (attributes, positions) => arrays.immediateRecord([{ attributes: attributes.bytes(), positions: new Uint8Array(new Float32Array(positions).buffer) }]);
const data = block(new GLStream().call("COLOR4F", 1, 0, 0, 1), [0, 0, 0, 2]);
function raw(cpu, bytes) { return cpu.process(bytes); }
const s = new GLShadow();raw(s, new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1).call("BEGIN", GL.POINTS).bytes());
const output = raw(s, data);assert.equal(output.length, 1);assert.equal(new DataView(output[0].bytes.buffer).getUint16(0, true), P.GLFN.IMMEDIATE_VERTEX_BLOCK);
assert.deepEqual(s.stateValue(GL.CURRENT_COLOR)[0], [1, 0, 0, 1]);raw(s, new GLStream().call("END").bytes());
const invalid = block(new GLStream().call("VERTEX_ATTRIB4F", 100, 0, 1, 0, 1).call("COLOR4F", 0, 1, 0, 1), [0, 0, 0, 1]);
raw(s, invalid);assert.equal(s.current.error, GL.INVALID_VALUE);assert.deepEqual(s.stateValue(GL.CURRENT_COLOR)[0], [0, 1, 0, 1]);
const filtered = raw(s, block(new GLStream(), [0, 0, 0, 1]));assert.equal(arrays.parseImmediateBlock(filtered[0].bytes, new DataView(filtered[0].bytes.buffer), 4, filtered[0].bytes.length - 4)[0].count, 0);
s.current.error = 0;
for (const broken of [
    data.slice(0, -1),
    block(new GLStream().call("CLEAR", GL.COLOR_BUFFER_BIT), []),
    block(new GLStream().call("VERTEX_ATTRIB4F", 0, 0, 0, 0, 1), []),
    block(new GLStream().record(P.GLFN.INDEX_STATE, P.encodeRecord("INDEX_STATE", { operation: 1, value: 5 })), []),
]) {
    const before = s.stats.malformed;raw(s, broken);assert.ok(s.stats.malformed > before || s.current.error === GL.INVALID_OPERATION);s.current.error = 0;
}
// List compilation owns the immutable block and does not change current GL
// state. On execution its CPU and GPU semantics equal ordinary immediate calls.
const list = new GLStream();listCommand(list, 1, 99, GL.COMPILE);list.call("BEGIN", GL.POINTS);raw(s, list.bytes());raw(s, data);
const end = new GLStream().call("END");listCommand(end, 2);raw(s, end.bytes());assert.deepEqual(s.stateValue(GL.CURRENT_COLOR)[0], [0, 1, 0, 1]);
data.fill(0);const execute = new GLStream();listCommand(execute, 3, 99);raw(s, execute.bytes());assert.deepEqual(s.stateValue(GL.CURRENT_COLOR)[0], [1, 0, 0, 1]);assert.equal(s.current.error, 0);
const setup = new GLStream();cases.query(setup, { operation: 1, size: 128, type: GL["4D_COLOR_TEXTURE"] });cases.query(setup, { operation: 2, type: GL.FEEDBACK });setup.call("BEGIN", GL.POINTS);raw(s, setup.bytes());
const vertex = block(new GLStream().call("COLOR4F", 0.25, 0.5, 0.75, 1), [0, 0, 0, 2]);raw(s, vertex);
const close = new GLStream().call("END"), result = cases.query(close, { operation: 2, type: GL.RENDER });raw(s, close.bytes());assert.equal(result.view.getInt32(P.F.QUERY_RENDER_MODE.result, true), 13);
const read = cases.read(result);raw(s, read.stream.bytes());assert.deepEqual(Array.from({ length: 9 }, (_, i) => read.response.view.getFloat32(P.RECORDS.QUERY_RENDER_MODE.size + i * 4, true)), [GL.POINT_TOKEN, 8, 8, 0.5, 2, 0.25, 0.5, 0.75, 1]);
const saved = s.getState(), again = new GLShadow();again.setState(saved);const call = new GLStream();listCommand(call, 3, 99);raw(again, call.bytes());assert.equal(again.current.error, 0);
console.log("PASS immediate blocks: CPU current state, filtering, immutable lists, feedback w/colors, snapshot and malformed attribute refusal");
