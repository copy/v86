"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
for (const part of ["objects", "state", "raster", "fixed", "misc", "rasterpos", "images", "textures", "buffers", "arrays", "queries", "arb", "glsl"])
    require("../../src/browser/glbridge/gl-webgpu/gl_shadow_" + part + ".js");
const { createV86GLDevice } = require("../../src/browser/glbridge/v86gl_device.js");
require("../../src/browser/glbridge/gl-webgpu/gl_glslang.js");
const caps = require("../../src/browser/glbridge/gl-webgpu/gl_caps.js");
const { GLStream, GL } = require("./gl_stream_builder.js");
const {GLWebGPUExecutor} = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js");
const {createFakeHost} = require("./gl_fake_gpu.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const wasm = new WebAssembly.Module(fs.readFileSync(path.join(__dirname, "../../bios/glslang.wasm")));
const values = [-0, NaN, Infinity, -Infinity], ENV = P.C.V86GL_PROGRAM_PARAMETER_ENV;
async function fixture(remote) {
    const address = 0x100000, size = 16 * 1024 * 1024, memory = new Uint8Array(size), queue = [];
    let listen, reply;
    const {host} = createFakeHost(), gpu = new GLWebGPUExecutor(null,{host,strict:true});await gpu.initialize();
    const device = createV86GLDevice({ remote, listen: handler => { listen = handler; }, post: message => {
        if (message.type === "batch") {
            for (const segment of message.segments || [{offset:0,length:message.bytes.length}]) {
                const bytes = segment.bytes || message.bytes.subarray(segment.offset,segment.offset+segment.length);
                gpu.submit(remote ? bytes.slice() : bytes,{onProgramLink: result => listen({type:"gl_program_link_result",generation:message.generation,...result})});
            }
            listen({ type: "done", id: message.id });
        }
    } });
    device.init({ is_feature_negotiated: () => true, has_request: () => !!queue.length, pop_request: () => queue.shift(),
        flush() {}, needs_reset() { throw new Error("unexpected device reset"); }, is_ram: () => true,
        read_memory: (at, length) => memory.subarray(at - address, at - address + length),
        write_memory: (bytes, at) => memory.set(bytes, at - address) });
    const request = words => {
        queue.push({ readable: 24, writable: 16, read: () => new Uint8Array(new Uint32Array(words).buffer),
            write: bytes => { reply = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true); }, complete() {} });
        device.notify(); assert.equal(reply, 0);
    };
    listen({ type: "available", value: true }); listen({ type: "capabilities", value: caps.capabilities({}, {}) });
    listen({ type: "glslang", module: wasm }); request([1, address, 0, size, 0, 0]);
    return { device, async run(s) {
        const bytes = s.bytes(), header = new DataView(memory.buffer);
        header.setUint32(0, 0x324C4756, true); header.setUint32(4, 1, true); header.setUint32(20, bytes.length, true);
        memory.set(bytes, 32); request([2, 0, 0, 32 + bytes.length, 0, 0]);
        await gpu.idle();
        s.buffer.set(memory.subarray(32, 32 + bytes.length));
    } };
}
function query(s, pname, parameter) {
    const name = parameter ? "QUERY_PARAMETER" : "QUERY_STATE", header = P.encodeRecord(name,
        { pname, value_kind: P.C.V86GL_STATE_DOUBLE, data_size: 32, ...parameter });
    const payload = new Uint8Array(header.length + 32); payload.fill(0xA5); payload.set(header); s.record(P.GLFN[name], payload);
    return { name, record: s.payloadView() };
}
function check(q, expected) {
    const { name, record } = q;
    assert.equal(record.view.getUint32(P.F[name].status, true), 1);
    const n = record.view.getUint32(P.F[name].count, true); assert.equal(n, expected.length);
    assert.deepEqual(Array.from({ length: n }, (_, i) => record.view.getFloat64(P.RECORDS[name].size + i * 8, true)), expected);
}
(async () => {
for (const remote of [false, true]) {
    const { device, run } = await fixture(remote), setup = new GLStream().makeCurrent(1, 0, 0, 64, 64, 1, 1);
    setup.call("NORMAL3F", -0, Infinity, -Infinity).call("FOG_COORDF", NaN)
        .call("MULTI_TEX_COORD4F", GL.TEXTURE0 + 3, ...values).call("ACTIVE_TEXTURE", GL.TEXTURE0 + 3)
        .call("POLYGON_OFFSET", NaN, Infinity).call("VERTEX_ATTRIB4F", 2, ...values)
        .call("TEX_ENVF", GL.TEXTURE_FILTER_CONTROL, GL.TEXTURE_LOD_BIAS, Infinity)
        .call("MATERIALFV", GL.FRONT, GL.DIFFUSE, 4, ...values)
        .programParameterARB(ENV, GL.VERTEX_PROGRAM_ARB, 3, values)
        .call("CREATE_PROGRAM", 10).call("CREATE_SHADER", 11, GL.VERTEX_SHADER).shaderSource(11, "void main(){gl_Position=gl_Vertex;}")
        .call("COMPILE_SHADER", 11).call("ATTACH_SHADER", 10, 11).call("CREATE_SHADER", 12, GL.FRAGMENT_SHADER)
        .shaderSource(12, "uniform vec4 u;void main(){gl_FragColor=u;}").call("COMPILE_SHADER", 12).call("ATTACH_SHADER", 10, 12)
        .call("LINK_PROGRAM", 10).call("USE_PROGRAM", 10);
    const location = setup.queryLocation(P.C.V86GL_LOCATION_KIND_UNIFORM, 10, "u", 16); await run(setup);
    const loc = location.view.getInt32(P.F.QUERY_LOCATION.result, true); assert.ok(loc >= 0);
    const push = new GLStream().uniformfv(loc, 4, 1, values).call("PUSH_ATTRIB", 1 | 0x8 | 0x40 | 0x40000)
        .call("NORMAL3F", 1, 2, 3).call("FOG_COORDF", 0).call("VERTEX_ATTRIB4F", 2, 1, 2, 3, 4)
        .call("MULTI_TEX_COORD4F", GL.TEXTURE0 + 3, 1, 2, 3, 4).call("POLYGON_OFFSET", 0, 0)
        .call("MATERIALFV", GL.FRONT, GL.DIFFUSE, 4, 1, 1, 1, 1).call("TEX_ENVF", GL.TEXTURE_FILTER_CONTROL, GL.TEXTURE_LOD_BIAS, 0);
    await run(push);
    const snapshot = JSON.parse(JSON.stringify(device.get_state()));
    assert.match(snapshot[6], /\$v86glNumber/);
    device.set_state(snapshot);
    // A restored snapshot must own its contents independently of its input.
    snapshot[6] = "";
    const pop = new GLStream().call("POP_ATTRIB");
    const normal = query(pop, GL.CURRENT_NORMAL), fog = query(pop, GL.CURRENT_FOG_COORDINATE_EXT), coords = query(pop, GL.CURRENT_TEXTURE_COORDS);
    const offset = query(pop, GL.POLYGON_OFFSET_FACTOR), units = query(pop, GL.POLYGON_OFFSET_UNITS);
    const attrib = query(pop, GL.CURRENT_VERTEX_ATTRIB, { query_kind: P.C.V86GL_PARAMETER_VERTEX_ATTRIB, target: 2 });
    const material = query(pop, GL.DIFFUSE, { query_kind: P.C.V86GL_PARAMETER_MATERIAL, target: GL.FRONT });
    const bias = query(pop, GL.TEXTURE_LOD_BIAS, { query_kind: P.C.V86GL_PARAMETER_TEX_ENV, target: GL.TEXTURE_FILTER_CONTROL });
    const arb = pop.queryProgramParameterARB(ENV, GL.VERTEX_PROGRAM_ARB, 3), uniform = pop.queryUniform(10, loc, 1, 16); await run(pop);
    check(normal, [-0, Infinity, -Infinity]); check(fog, [NaN]); check(coords, values); check(offset, [NaN]); check(units, [Infinity]);
    check(attrib, values); check(material, values); check(bias, [Infinity]);
    assert.equal(arb.view.getUint32(P.F.QUERY_PROGRAM_PARAMETER_FV_ARB.status, true), 1);
    assert.deepEqual([0, 1, 2, 3].map(i => arb.view.getFloat32(24 + i * 4, true)), values);
    assert.equal(uniform.view.getUint32(P.F.QUERY_UNIFORM.status, true), 1);
    assert.deepEqual([0, 1, 2, 3].map(i => uniform.view.getFloat32(32 + i * 4, true)), values);
}
const shadow = new GLShadow(), setup = new GLStream().makeCurrent(1, 0, 0, 64, 64);
setup.call("FOG_COORDF", -0); shadow.process(setup.bytes());
const saved = shadow.getState(); saved.typed[0][1].values[GL.CURRENT_FOG_COORDINATE_EXT] = [7];
assert.ok(Object.is(shadow.current.state.values[GL.CURRENT_FOG_COORDINATE_EXT][0], -0), "snapshot cannot alias live state");
const legacy = shadow.getState(); delete legacy.numberEncoding;
legacy.typed[0][1].values[GL.CURRENT_FOG_COORDINATE_EXT] = [0.25];
const restored = new GLShadow(); restored.setState(legacy); legacy.typed[0][1].values[GL.CURRENT_FOG_COORDINATE_EXT][0] = 9;
assert.equal(restored.current.state.values[GL.CURRENT_FOG_COORDINATE_EXT][0], 0.25, "legacy input cannot alias restored state");
const begin = new GLStream().call("FOG_COORDF", 0.25).call("BEGIN_QUERY", GL.SAMPLES_PASSED, 7); shadow.process(begin.bytes());
const owned = shadow.getState(), queryObject = snapshot => snapshot.queryObjects[0][1].find(p => p[0] === 7)[1];
queryObject(owned).target = GL.ANY_SAMPLES_PASSED;
assert.equal(shadow.current.queryObjects.get(7).target, GL.SAMPLES_PASSED, "snapshot cannot alias query object contents");
delete owned.numberEncoding; restored.setState(owned); queryObject(owned).target = 123;
assert.equal(restored.current.queryObjects.get(7).target, GL.ANY_SAMPLES_PASSED, "legacy restore cannot alias query object contents");
const copied = GLShadow.clone({ values, typed: Float32Array.from(values), map: new Map([[1, values]]), set: new Set([Infinity]) });
assert.deepEqual(copied.values, values); assert.deepEqual(Array.from(copied.typed), values);
assert.notEqual(copied.map.get(1), values); assert.equal(copied.set.has(Infinity), true);
console.log("gl_shadow_numeric_state_test: special floats survive attribute stacks, uniform queries, legacy snapshots and actual device JSON restore in both modes (passed)");

})().catch(error => {console.error(error);process.exitCode=1;});
