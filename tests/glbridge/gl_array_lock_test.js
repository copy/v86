"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), zlib = require("node:zlib"), path = require("node:path");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_arrays.js");require("../../src/browser/glbridge/gl-webgpu/gl_shadow_lists.js");require("../../src/browser/glbridge/gl-webgpu/gl_shadow_render.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js"), caps = require("../../src/browser/glbridge/gl-webgpu/gl_caps.js"), { GLStream, GL } = require("./gl_stream_builder.js");
const native = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, "gl_conformance/mesa_reference.json.gz")))) .fixtures.array_lock;
assert.equal(native.supported, true);const apple = require("./gl_conformance/array_lock_reference.json");if (apple.supported) assert.deepEqual(apple.cases, native.cases);else assert.deepEqual(apple.cases, {});
assert.ok(caps.extensions(caps.capabilities({}, {})).split(" ").includes("GL_EXT_compiled_vertex_array"));
const s = new GLShadow();s.process(new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1).bytes());
function query(operation, first = 0, count = 0) {
    const stream = new GLStream().record(P.GLFN.QUERY_ARRAY_LOCK, P.encodeRecord("QUERY_ARRAY_LOCK", { operation, first, count })), answer = stream.payloadView();
    s.process(stream.bytes());assert.equal(answer.view.getUint32(P.F.QUERY_ARRAY_LOCK.status, true), answer.view.getUint32(P.F.QUERY_ARRAY_LOCK.error, true) ? P.C.V86GL_SYNC_QUERY_STATUS_FAILED : P.C.V86GL_SYNC_QUERY_STATUS_OK);return answer;
}
function observe(name) {
    assert.deepEqual([s.stateValue(GL.ARRAY_ELEMENT_LOCK_FIRST_EXT)[0][0], s.stateValue(GL.ARRAY_ELEMENT_LOCK_COUNT_EXT)[0][0], s.current.error], native.cases[name], name);s.current.error = 0;
}
observe("initial");query(0, -1, 3);observe("negative_first");query(0, 0, 0);observe("zero_count");query(0, 0, -1);observe("negative_count");query(0, 2, 3);observe("locked");query(0, 4, 2);observe("nested");
s.process(new GLStream().call("PUSH_CLIENT_ATTRIB", GL.CLIENT_VERTEX_ARRAY_BIT).bytes());query(1);observe("unlocked_inside_stack");s.process(new GLStream().call("POP_CLIENT_ATTRIB").bytes());observe("restored_lock");query(1);observe("unlocked");query(1);observe("unbalanced");
s.process(new GLStream().call("BEGIN", GL.POINTS).bytes());const inside = query(0, 0, 3);assert.equal(inside.view.getUint32(P.F.QUERY_ARRAY_LOCK.error, true), GL.INVALID_OPERATION);s.process(new GLStream().call("END").bytes());observe("inside_begin");
const list = (operation, name = 0, value = 0) => new GLStream().record(P.GLFN.LIST_COMMAND, P.encodeRecord("LIST_COMMAND", { operation, name, value })).bytes();
s.process(list(1, 99, GL.COMPILE));query(0, 1, 4);s.process(list(2));observe("during_compile");query(1);s.process(list(3, 99));observe("list_does_not_lock");
query(0, 2, 3);s.process(new GLStream().call("PUSH_CLIENT_ATTRIB", GL.CLIENT_PIXEL_STORE_BIT).bytes());query(1);s.process(new GLStream().call("POP_CLIENT_ATTRIB").bytes());observe("unlocked");
query(0, 2, 3);const saved = JSON.parse(JSON.stringify(s.getState())), restored = new GLShadow();restored.setState(saved);assert.deepEqual(restored.current.state.arrays.lock, { first: 2, count: 3 });
s.process(new GLStream().makeCurrent(2, 0, 0, 16, 16, 2, 1).bytes());observe("initial");query(0, 10, 20);s.process(new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1).bytes());observe("locked");
const read = query(2);assert.equal(read.view.getInt32(P.F.QUERY_ARRAY_LOCK.first, true), 2);assert.equal(read.view.getInt32(P.F.QUERY_ARRAY_LOCK.count, true), 3);
query(3);assert.equal(s.current.error, GL.INVALID_ENUM);assert.deepEqual(s.current.state.arrays.lock, { first: 2, count: 3 });
for (const [, state] of saved.typed) delete state.arrays.lock;const old = new GLShadow();old.setState(saved);assert.deepEqual(old.stateValue(GL.ARRAY_ELEMENT_LOCK_COUNT_EXT)[0], [0]);
console.log("PASS LockArrays: Mesa native state/errors, client stacks, immediate list semantics, context isolation and current/legacy checkpoints");
