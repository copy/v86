"use strict";
const assert = require("node:assert/strict");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_objects.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_images.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_buffers.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_arrays.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_render.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const { GLStream, GL } = require("./gl_stream_builder.js");
const tests = [], test = (name, fn) => tests.push({ name, fn });
const scene = () => new GLStream().makeCurrent(1, 0, 0, 64, 64, 1, 1);
function parameter(stream, family, target, pname) {
    const header = P.encodeRecord("QUERY_PARAMETER", { query_kind: family, target, pname,
        value_kind: P.C.V86GL_STATE_INTEGER, data_size: 8 });
    const payload = new Uint8Array(header.length + 8); payload.fill(0xA5); payload.set(header); stream.record(P.GLFN.QUERY_PARAMETER, payload);
    const offset = stream.length - payload.length;
    return () => { const b = stream.bytes(), v = new DataView(b.buffer, b.byteOffset + offset, payload.length);
        return [v.getUint32(P.F.QUERY_PARAMETER.status, true), v.getUint32(P.F.QUERY_PARAMETER.error, true), v.getFloat64(header.length, true)]; };
}
const bufferQuery = (stream, pname, target = GL.ARRAY_BUFFER) => parameter(stream, P.C.V86GL_PARAMETER_BUFFER, target, pname);
function sub(stream, offset, size, data, declared = data.length) {
    const header = P.encodeRecord("BUFFER_SUB_DATA", { target: GL.ARRAY_BUFFER, offset, size, data_size: declared });
    const payload = new Uint8Array(header.length + data.length); payload.set(header); payload.set(data, header.length);
    return stream.record(P.GLFN.BUFFER_SUB_DATA, payload);
}
function operation(stream, name, fields, capacity = 0) {
    const header = P.encodeRecord(name, fields), payload = new Uint8Array(header.length + capacity);
    payload.fill(0xA5); payload.set(header); stream.record(P.GLFN[name], payload);
    const at = stream.length - payload.length;
    return () => { const b = stream.bytes(), v = new DataView(b.buffer, b.byteOffset + at, payload.length);
        return { status: v.getUint32(P.F[name].status, true), error: v.getUint32(P.F[name].error, true),
            data: Array.from(b.subarray(at + header.length, at + payload.length)),
            result: name === "QUERY_BUFFER_UNMAP" ? v.getUint32(P.F[name].result, true) : undefined }; };
}
test("buffer validation, existence and defaults follow native desktop GL", () => {
    const native = require("./gl_conformance/buffers_reference.json").cases, s = new GLShadow(), stream = scene().names(P.GLFN.GEN_BUFFERS, [7]);
    const exists = () => parameter(stream, P.C.V86GL_PARAMETER_IS_OBJECT, P.C.V86GL_OBJECT_KIND_BUFFER, 7);
    const reserved = exists(); stream.call("BIND_BUFFER", GL.ARRAY_BUFFER, 7); const bound = exists();
    const initial = [GL.BUFFER_SIZE_ARB, GL.BUFFER_USAGE_ARB].map(p => bufferQuery(stream, p));
    s.process(stream.bytes()); assert.equal(reserved()[2], native.reserved); assert.equal(bound()[2], native.bound);
    assert.deepEqual(initial.map(q => q()[2]), native.initial.slice(0, 2));
    for (const [key, command] of [
        ["valid_data", st => st.bufferData(GL.ARRAY_BUFFER, 8, GL.STATIC_DRAW, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))],
        ["bad_target", st => st.bufferData(GL.TEXTURE_2D, 8, GL.STATIC_DRAW, null)],
        ["negative_size", st => st.bufferData(GL.ARRAY_BUFFER, -1, GL.STATIC_DRAW, null)],
        ["bad_usage", st => st.bufferData(GL.ARRAY_BUFFER, 8, 0, null)],
        ["valid_sub", st => sub(st, 2, 2, new Uint8Array([1, 2]))],
        ["negative_offset", st => sub(st, -1, 1, new Uint8Array(1))],
        ["negative_sub_size", st => sub(st, 0, -1, new Uint8Array(0))],
        ["past_edge", st => sub(st, 7, 2, new Uint8Array(2))],
        ["empty_at_edge", st => sub(st, 8, 0, new Uint8Array(0))],
        ["empty_past_edge", st => sub(st, 9, 0, new Uint8Array(0))],
    ]) {
        // GL 2.1 2.9 rejects offset+size beyond the store even for an empty
        // update; Apple's driver skips this check for size zero.
        s.current.error = 0; s.process(command(new GLStream()).bytes()); assert.equal(s.current.error, key === "empty_past_edge" ? GL.INVALID_VALUE : native[key], key);
    }
    assert.deepEqual(Array.from(s.boundBuffer(GL.ARRAY_BUFFER).data), [1, 2, 1, 2, 5, 6, 7, 8]);
    const alias = new GLStream().call("BIND_BUFFER", GL.PIXEL_PACK_BUFFER, 7), size = bufferQuery(alias, GL.BUFFER_SIZE_ARB, GL.PIXEL_PACK_BUFFER);
    s.process(alias.bytes()); assert.equal(size()[2], native.second_target_size);
    const unbind = new GLStream().call("BIND_BUFFER", GL.ARRAY_BUFFER, 0).bufferData(GL.ARRAY_BUFFER, 8, GL.STATIC_DRAW, null);
    s.current.error = 0; s.process(unbind.bytes()); assert.equal(s.current.error, native.unbound_data);
    s.current.error = 0; s.process(sub(new GLStream(), 0, 0, new Uint8Array(0)).bytes()); assert.equal(s.current.error, native.unbound_sub);
    s.process(new GLStream().call("BIND_BUFFER", GL.ARRAY_BUFFER, 7).bufferData(GL.ARRAY_BUFFER, 0, 0x88E1, null).bytes());
    assert.equal(s.boundBuffer(GL.ARRAY_BUFFER).size, 0); assert.equal(s.boundBuffer(GL.ARRAY_BUFFER).usage, 0x88E1);
    s.process(new GLStream().names(P.GLFN.DELETE_BUFFERS, [7]).bytes()); assert.equal(s.boundBuffer(GL.ARRAY_BUFFER), undefined);
    assert.equal(s.boundBuffer(GL.PIXEL_PACK_BUFFER), undefined);
});
test("invalid buffer payloads preserve prior storage, usages and bindings", () => {
    for (const command of [st => st.bufferData(GL.ARRAY_BUFFER, 8, GL.DYNAMIC_DRAW_ARB, new Uint8Array(4)),
        st => sub(st, 0, 4, new Uint8Array(2), 4), st => sub(st, 0, 4, new Uint8Array(4), 2),
        st => st.call("BIND_BUFFER", GL.TEXTURE_2D, 9)]) {
        const s = new GLShadow(); s.process(scene().call("BIND_BUFFER", GL.ARRAY_BUFFER, 7)
            .bufferData(GL.ARRAY_BUFFER, 8, GL.STATIC_DRAW, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])).bytes());
        const id = s.boundBuffer(GL.ARRAY_BUFFER).id; s.process(command(new GLStream()).bytes());
        assert.ok(s.current.error); assert.equal(s.stats.rejected, 1); assert.equal(s.boundBuffer(GL.ARRAY_BUFFER).id, id);
        assert.equal(s.boundBuffer(GL.ARRAY_BUFFER).usage, GL.STATIC_DRAW);
        assert.deepEqual(Array.from(s.boundBuffer(GL.ARRAY_BUFFER).data), [1, 2, 3, 4, 5, 6, 7, 8]);
    }
    for (const name of ["GEN_BUFFERS", "DELETE_BUFFERS"]) {
        const s = new GLShadow(), stream = scene().record(P.GLFN[name], P.encodeRecord(name, { count: 2 }));
        s.process(stream.bytes()); assert.equal(s.current.error, GL.INVALID_VALUE); assert.equal(s.current.group.buffers.size, 0);
    }
});
test("shared buffer identities survive deletion, name reuse, client attributes and snapshots", () => {
    const s = new GLShadow(), stream = scene().call("BIND_BUFFER", GL.ARRAY_BUFFER, 7)
        .bufferData(GL.ARRAY_BUFFER, 3, GL.DYNAMIC_DRAW_ARB, new Uint8Array([1, 2, 3]))
        .makeCurrent(2, 0, 0, 64, 64, 2, 1).call("BIND_BUFFER", GL.ARRAY_BUFFER, 7)
        .makeCurrent(1, 0, 0, 64, 64, 1, 1).names(P.GLFN.DELETE_BUFFERS, [7])
        .call("BIND_BUFFER", GL.ARRAY_BUFFER, 7).bufferData(GL.ARRAY_BUFFER, 2, GL.STATIC_DRAW, new Uint8Array([8, 9]));
    s.process(stream.bytes()); const replacement = s.boundBuffer(GL.ARRAY_BUFFER);
    s.process(new GLStream().makeCurrent(2, 0, 0, 64, 64, 2, 1).bytes()); const retained = s.boundBuffer(GL.ARRAY_BUFFER);
    assert.notEqual(retained.id, replacement.id); assert.equal(retained.deleted, true); assert.deepEqual(Array.from(retained.data), [1, 2, 3]);
    const attrib = new GLStream().call("PUSH_CLIENT_ATTRIB", 2).call("BIND_BUFFER", GL.ARRAY_BUFFER, 7).call("POP_CLIENT_ATTRIB");
    s.process(attrib.bytes()); assert.equal(s.boundBuffer(GL.ARRAY_BUFFER), retained);
    const copy = new GLShadow(); copy.setState(JSON.parse(JSON.stringify(s.getState())));
    assert.deepEqual(Array.from(copy.boundBuffer(GL.ARRAY_BUFFER).data), [1, 2, 3]);
    copy.process(new GLStream().makeCurrent(1, 0, 0, 64, 64, 1, 1).bytes()); assert.deepEqual(Array.from(copy.boundBuffer(GL.ARRAY_BUFFER).data), [8, 9]);
    const zero = new GLStream().call("BIND_BUFFER", GL.ARRAY_BUFFER, 0).call("PUSH_CLIENT_ATTRIB", 2)
        .call("BIND_BUFFER", GL.ARRAY_BUFFER, 7).call("POP_CLIENT_ATTRIB"); copy.process(zero.bytes()); assert.equal(copy.boundBuffer(GL.ARRAY_BUFFER), undefined);
});
test("all buffer usages are accepted, failed parameter queries preserve output, and Begin rejects changes", () => {
    const s = new GLShadow(); s.process(scene().call("BIND_BUFFER", GL.ARRAY_BUFFER, 7).bytes());
    for (const usage of [0x88E0, 0x88E1, 0x88E2, 0x88E4, 0x88E5, 0x88E6, 0x88E8, 0x88E9, 0x88EA]) {
        const stream = new GLStream().bufferData(GL.ARRAY_BUFFER, 1, usage, null), q = bufferQuery(stream, GL.BUFFER_USAGE_ARB);
        s.process(stream.bytes()); assert.deepEqual(q(), [1, 0, usage]);
    }
    for (const [target, pname, error] of [[GL.TEXTURE_2D, GL.BUFFER_SIZE_ARB, GL.INVALID_ENUM], [GL.ARRAY_BUFFER, 0, GL.INVALID_ENUM],
        [GL.PIXEL_PACK_BUFFER, GL.BUFFER_SIZE_ARB, GL.INVALID_OPERATION]]) {
        const stream = new GLStream(), q = bufferQuery(stream, pname, target); s.process(stream.bytes());
        assert.deepEqual(q().slice(0, 2), [2, error]);
        const untouched = new DataView(new Uint8Array(8).fill(0xA5).buffer).getFloat64(0, true);
        assert.equal(q()[2], untouched, "failed queries preserve the destination bytes");
    }
    s.current.error = 0; s.process(new GLStream().call("BEGIN", GL.POINTS).call("BIND_BUFFER", GL.ARRAY_BUFFER, 8).call("END").bytes());
    assert.equal(s.current.error, GL.INVALID_OPERATION); assert.equal(s.boundBuffer(GL.ARRAY_BUFFER).name, 7);
});
test("CPU buffer reads validate the entire range before changing any destination bytes", () => {
    const s = new GLShadow(); s.process(scene().call("BIND_BUFFER", GL.ARRAY_BUFFER, 7)
        .bufferData(GL.ARRAY_BUFFER, 8, GL.STATIC_DRAW, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])).bytes());
    for (const [fields, capacity, error] of [
        [{ offset: 2, size: 3, range_size: 6, data_size: 3 }, 3, 0],
        [{ offset: 7, size: 1, range_size: 2, data_size: 1 }, 1, GL.INVALID_VALUE],
        [{ offset: 0, size: 2, range_size: 1, data_size: 2 }, 2, GL.INVALID_VALUE],
        [{ offset: 0, size: 2, range_size: 2, data_size: 1 }, 2, GL.INVALID_VALUE],
        [{ offset: 0, size: 2, range_size: 2, data_size: 3 }, 2, GL.INVALID_VALUE],
        [{ offset: -1, size: 0, range_size: 0, data_size: 0 }, 0, GL.INVALID_VALUE],
        [{ offset: 8, size: 0, range_size: 0, data_size: 0 }, 0, 0],
        [{ offset: 9, size: 0, range_size: 0, data_size: 0 }, 0, GL.INVALID_VALUE],
        [{ target: GL.TEXTURE_2D, offset: 0, size: 0, range_size: 0, data_size: 0 }, 0, GL.INVALID_ENUM],
    ]) {
        const stream = new GLStream(), result = operation(stream, "QUERY_BUFFER_DATA", { target: GL.ARRAY_BUFFER, ...fields }, capacity);
        s.process(stream.bytes()); assert.equal(result().status, error ? 2 : 1); assert.equal(result().error, error);
        assert.deepEqual(result().data, error ? Array(capacity).fill(0xA5) : fields.size ? [3, 4, 5] : []);
    }
    const none = new GLShadow(), stream = new GLStream(), answer = operation(stream, "QUERY_BUFFER_DATA",
        { target: GL.ARRAY_BUFFER, offset: 0, size: 0, range_size: 0, data_size: 0 });
    none.process(stream.bytes()); assert.equal(answer().status, 2); assert.equal(answer().error, GL.INVALID_OPERATION);
});
test("buffer mapping is shared CPU state with atomic errors, pointer queries, reset and snapshot recovery", () => {
    const native = require("./gl_conformance/buffers_reference.json").cases;
    const s = new GLShadow(); s.process(scene().call("BIND_BUFFER", GL.ARRAY_BUFFER, 7)
        .bufferData(GL.ARRAY_BUFFER, 4, GL.STATIC_DRAW, new Uint8Array([1, 2, 3, 4])).bytes());
    const map = (access, pointer = 0xFEDCBA98) => { const stream = new GLStream(), answer = operation(stream, "QUERY_BUFFER_MAP", { target: GL.ARRAY_BUFFER, access, pointer }); s.process(stream.bytes()); return answer(); };
    assert.equal(map(GL.READ_ONLY_ARB).error, native.valid_map);
    assert.equal(s.boundBuffer(GL.ARRAY_BUFFER).pointer, 0xFEDCBA98);
    assert.equal(map(GL.READ_WRITE_ARB, 100).error, native.already_mapped);
    assert.equal(s.boundBuffer(GL.ARRAY_BUFFER).access, GL.READ_ONLY_ARB); assert.equal(s.boundBuffer(GL.ARRAY_BUFFER).pointer, 0xFEDCBA98);
    const blocked = new GLStream(), read = operation(blocked, "QUERY_BUFFER_DATA", { target: GL.ARRAY_BUFFER, offset: 0, size: 1, range_size: 1, data_size: 1 }, 1);
    sub(blocked, 0, 1, new Uint8Array([8])); s.current.error = 0; s.process(blocked.bytes());
    assert.equal(read().error, native.mapped_read); assert.deepEqual(read().data, [0xA5]);
    assert.equal(s.current.error, native.mapped_sub); assert.equal(s.boundBuffer(GL.ARRAY_BUFFER).data[0], 1);
    const saved = new GLShadow(); saved.setState(JSON.parse(JSON.stringify(s.getState())));
    const queries = new GLStream().makeCurrent(2, 0, 0, 64, 64, 2, 1).call("BIND_BUFFER", GL.ARRAY_BUFFER, 7);
    const mapped = bufferQuery(queries, GL.BUFFER_MAPPED_ARB), access = bufferQuery(queries, GL.BUFFER_ACCESS_ARB);
    const pointer = parameter(queries, P.C.V86GL_PARAMETER_BUFFER_POINTER, GL.ARRAY_BUFFER, GL.BUFFER_MAP_POINTER_ARB);
    saved.process(queries.bytes()); assert.equal(mapped()[2], 1); assert.equal(access()[2], GL.READ_ONLY_ARB);
    assert.equal(pointer()[2], 0xFEDCBA98 | 0);
    const unmapStream = new GLStream(), unmap = operation(unmapStream, "QUERY_BUFFER_UNMAP", { target: GL.ARRAY_BUFFER });
    saved.process(unmapStream.bytes()); assert.deepEqual(unmap(), { status: 1, error: 0, result: 1, data: [] });
    assert.equal(saved.boundBuffer(GL.ARRAY_BUFFER).pointer, 0); assert.equal(saved.boundBuffer(GL.ARRAY_BUFFER).mapped, false);
    const again = new GLStream(), fail = operation(again, "QUERY_BUFFER_UNMAP", { target: GL.ARRAY_BUFFER }); saved.process(again.bytes());
    assert.equal(fail().error, GL.INVALID_OPERATION);
    // GL 2.1 table 2.7 and section 2.9 permit reinitialization to unmap a
    // store. Apple rejects it and leaves BUFFER_MAPPED true; keep its fixture.
    s.current.error = 0; s.process(new GLStream().bufferData(GL.ARRAY_BUFFER, 2, GL.STATIC_DRAW, null).bytes()); assert.equal(s.current.error, 0);
    assert.equal(s.boundBuffer(GL.ARRAY_BUFFER).mapped, false); assert.equal(s.boundBuffer(GL.ARRAY_BUFFER).pointer, 0);
    assert.equal(s.boundBuffer(GL.ARRAY_BUFFER).access, GL.READ_WRITE_ARB);
    assert.equal(map(0).error, native.bad_access); assert.equal(map(GL.READ_ONLY_ARB, 0).error, GL.OUT_OF_MEMORY);
    assert.equal(s.boundBuffer(GL.ARRAY_BUFFER).mapped, false);
    map(GL.READ_WRITE_ARB);
    s.process(new GLStream().makeCurrent(2, 0, 0, 64, 64, 2, 1).call("BIND_BUFFER", GL.ARRAY_BUFFER, 7)
        .makeCurrent(1, 0, 0, 64, 64, 1, 1).names(P.GLFN.DELETE_BUFFERS, [7]).makeCurrent(2, 0, 0, 64, 64, 2, 1).bytes());
    assert.equal(s.boundBuffer(GL.ARRAY_BUFFER).mapped, true); assert.equal(s.boundBuffer(GL.ARRAY_BUFFER).pointer, 0xFEDCBA98);
});

test("internal array reads work within Begin while public buffer reads retain their GL error", () => {
    const s = new GLShadow();s.process(scene().call("BIND_BUFFER",GL.ARRAY_BUFFER,7)
        .bufferData(GL.ARRAY_BUFFER,4,GL.STATIC_DRAW,new Uint8Array([1,2,3,4]))
        .record(P.GLFN.VERTEX_POINTER_VBO,P.encodeRecord("VERTEX_POINTER_VBO",{size:3,type:GL.FLOAT,stride:0,offset:0})).call("BEGIN",GL.POINTS).bytes());
    const internal = new GLStream(), read = operation(internal,"QUERY_BUFFER_DATA",{target:GL.VERTEX_ARRAY,offset:0,size:4,range_size:4,data_size:4},4);
    s.process(internal.bytes());assert.equal(read().status,1);assert.deepEqual(read().data,[1,2,3,4]);assert.equal(s.current.error,0);
    const publicQuery = new GLStream(), failed = operation(publicQuery,"QUERY_BUFFER_DATA",{target:GL.ARRAY_BUFFER,offset:0,size:4,range_size:4,data_size:4},4);
    s.process(publicQuery.bytes());assert.equal(failed().error,GL.INVALID_OPERATION);assert.deepEqual(failed().data,[0xA5,0xA5,0xA5,0xA5]);
    assert.equal(s.current.state.begin,true);s.process(new GLStream().call("END").bytes());
});
test("encoding selectors retain the captured VBO after another context deletes and reuses its name", () => {
    const s = new GLShadow();s.process(scene().call("BIND_BUFFER",GL.ARRAY_BUFFER,7)
        .bufferData(GL.ARRAY_BUFFER,4,GL.STATIC_DRAW,new Uint8Array([1,2,3,4]))
        .record(P.GLFN.VERTEX_POINTER_VBO,P.encodeRecord("VERTEX_POINTER_VBO",{size:3,type:GL.FLOAT,stride:0,offset:0}))
        .call("BIND_BUFFER",GL.ARRAY_BUFFER,9).bufferData(GL.ARRAY_BUFFER,4,GL.STATIC_DRAW,new Uint8Array([22,22,22,22]))
        .makeCurrent(2,0,0,64,64,2,1).names(P.GLFN.DELETE_BUFFERS,[7]).call("BIND_BUFFER",GL.ARRAY_BUFFER,7)
        .bufferData(GL.ARRAY_BUFFER,4,GL.STATIC_DRAW,new Uint8Array([9,8,7,6])).makeCurrent(1,0,0,64,64,1,1).bytes());
    const stream = new GLStream(), old = operation(stream,"QUERY_BUFFER_DATA",{target:GL.VERTEX_ARRAY,buffer:0,offset:0,size:4,range_size:4,data_size:4},4),
        fresh = operation(stream,"QUERY_BUFFER_DATA",{target:GL.ARRAY_BUFFER,buffer:7,offset:0,size:4,range_size:4,data_size:4},4);
    s.process(stream.bytes());assert.deepEqual(old().data,[1,2,3,4]);assert.deepEqual(fresh().data,[9,8,7,6]);
    assert.equal(s.current.error,0);
});
test("named encoding reads validate the CPU store without rebinding or trusting guest mirrors", () => {
    const s = new GLShadow();s.process(scene().call("BIND_BUFFER",GL.ARRAY_BUFFER,7)
        .bufferData(GL.ARRAY_BUFFER,8,GL.STATIC_DRAW,new Uint8Array([1,2,3,4,5,6,7,8]))
        .call("BIND_BUFFER",GL.ARRAY_BUFFER,9).bufferData(GL.ARRAY_BUFFER,4,GL.STATIC_DRAW,new Uint8Array([9,9,9,9])).bytes());
    const binding = s.boundBuffer(GL.ARRAY_BUFFER);
    const read = (buffer, offset, size, range_size = size) => {
        const stream = new GLStream(), result = operation(stream,"QUERY_BUFFER_DATA",{target:GL.ARRAY_BUFFER,buffer,offset,size,range_size,data_size:Math.max(size,0)},Math.max(size,0));
        s.current.error=0;s.process(stream.bytes());assert.equal(s.boundBuffer(GL.ARRAY_BUFFER),binding);return result();
    };
    assert.deepEqual(read(7,2,3).data,[3,4,5]);assert.deepEqual(read(9,1,2).data,[9,9]);
    assert.equal(read(7,7,2).error,GL.INVALID_VALUE);assert.equal(read(7,0,1,9).error,GL.INVALID_VALUE);
    assert.equal(read(17,0,1).error,GL.INVALID_OPERATION);
    s.current.group.buffers.get(7).mapped=true;assert.equal(read(7,0,1).error,GL.INVALID_OPERATION);
    s.current.group.buffers.get(7).mapped=false;s.process(new GLStream().names(P.GLFN.DELETE_BUFFERS,[7]).bytes());
    assert.equal(read(7,0,1).error,GL.INVALID_OPERATION);assert.deepEqual([...binding.data],[9,9,9,9]);
});

(async () => { for (const { name, fn } of tests) { try { await fn(); console.log("ok   " + name); }
    catch (e) { console.error("FAIL " + name + "\n" + e.stack); process.exitCode = 1; return; } }
console.log(tests.length + " CPU buffer tests passed"); })();
