"use strict";
const assert = require("node:assert/strict");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_objects.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_images.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_textures.js");
const parameters = require("../../src/browser/glbridge/gl-webgpu/gl_texture_parameters.js");
const caps = require("../../src/browser/glbridge/gl-webgpu/gl_caps.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const residencyApple = require("./gl_conformance/texture_residency_reference.json").cases;
const residencyMesa = JSON.parse(require("node:zlib").gunzipSync(require("node:fs").readFileSync(require("node:path").join(__dirname, "gl_conformance/mesa_reference.json.gz")))).fixtures.texture_residency.cases;
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js");
const { createFakeHost } = require("./gl_fake_gpu.js");
const { GLStream, GL } = require("./gl_stream_builder.js");
const tests = [], test = (name, fn) => tests.push({ name, fn });
const scene = () => new GLStream().makeCurrent(1, 0, 0, 64, 64, 1, 1);
const shadow = () => { const s = new GLShadow(); s.setCapabilities(caps.capabilities({}, {})); return s; };
function query(s, pname, kind, target = GL.TEXTURE_2D, family = P.C.V86GL_PARAMETER_TEXTURE, index = 0) {
    const at = s.length + 4, h = P.encodeRecord("QUERY_PARAMETER", { query_kind: family,
        target, pname, index, value_kind: kind, data_size: 32 });
    const payload = new Uint8Array(h.length + 32); payload.fill(0xA5, h.length); payload.set(h); s.record(P.GLFN.QUERY_PARAMETER, payload);
    return () => {
        const b = s.bytes(), v = new DataView(b.buffer, b.byteOffset, b.byteLength);
        return { status: v.getUint32(at + P.F.QUERY_PARAMETER.status, true), error: v.getUint32(at + P.F.QUERY_PARAMETER.error, true),
            values: Array.from({ length: v.getUint32(at + P.F.QUERY_PARAMETER.count, true) }, (_, i) => v.getFloat64(at + h.length + i * 8, true)),
            bytes: b.subarray(at + h.length, at + h.length + 32) };
    };
}
function prioritize(s, names, values) {
    const b = new Uint8Array(4 + names.length * 8), v = new DataView(b.buffer); v.setInt32(0, names.length, true);
    names.forEach((n, i) => { v.setUint32(4 + i * 8, n, true); v.setFloat32(8 + i * 8, values[i], true); });
    return s.record(P.GLFN.PRIORITIZE_TEXTURES, b);
}
test("residency validates live names, sharing, deletion and Begin/End on the CPU", () => {
    const s = shadow(), family = P.C.V86GL_PARAMETER_TEXTURE_RESIDENCY;
    assert.deepEqual(residencyApple.live, residencyMesa.live);
    // GL 2.1 3.8.12/6.1.4: a generated but unbound name has no texture
    // object. Apple rejects it; Mesa accepts it. Empty returns also differ;
    // the no-working-set implementation follows Mesa's TRUE empty result.
    assert.equal(residencyApple.reserved[3], GL.INVALID_VALUE);assert.equal(residencyMesa.reserved[3], 0);
    assert.equal(residencyApple.empty[0], 0);assert.equal(residencyMesa.empty[0], 1);
    const check = (stream, name, validate, expected) => {
        const read = query(stream, validate, P.C.V86GL_STATE_BOOLEAN, name, family);s.process(stream.bytes());
        assert.equal(read().status, expected ? 1 : 2);assert.equal(read().error, expected ? 0 : GL.INVALID_VALUE);
        if (expected) assert.deepEqual(read().values, [residencyMesa.live[0]]);else assert.ok(read().bytes.every(v => v === 0xA5));
    };
    check(scene().call("BIND_TEXTURE", GL.TEXTURE_2D, 7).names(P.GLFN.GEN_TEXTURES, [8]), 7, 1, true);
    check(new GLStream(), 0, 1, false);check(new GLStream(), 8, 1, false);
    check(new GLStream(), 0, 0, true);
    check(new GLStream().makeCurrent(2, 0, 0, 64, 64, 2, 1), 7, 1, true);
    check(new GLStream().makeCurrent(3, 0, 0, 64, 64, 3, 2), 7, 1, false);
    check(new GLStream().makeCurrent(2, 0, 0, 64, 64, 2, 1).names(P.GLFN.DELETE_TEXTURES, [7]), 7, 1, false);
    const inside = new GLStream().call("BEGIN", GL.POINTS), read = query(inside, 0, P.C.V86GL_STATE_BOOLEAN, 0, family);s.process(inside.bytes());
    assert.equal(read().status, 2);assert.equal(read().error, residencyApple.inside_begin[1]);assert.equal(read().error, residencyMesa.inside_begin[1]);
});

test("typed texture queries and renderer setters match independent desktop GL conversions", async () => {
    const s = shadow(), { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host }); await gpu.initialize();
    const init = scene(); s.process(init.bytes()); gpu.submit(init.bytes(), {});
    const reference = require("./gl_conformance/texture_parameters_reference.json").cases;
    const steps = [
        ["default_min", GL.TEXTURE_MIN_FILTER], ["default_priority", GL.TEXTURE_PRIORITY],
        ["default_border", GL.TEXTURE_BORDER_COLOR], ["default_compare", GL.TEXTURE_COMPARE_FUNC],
        ["float_border", GL.TEXTURE_BORDER_COLOR, "TEX_PARAMETERFV", 4, -2, 0.5, 2, 1],
        ["int_border", GL.TEXTURE_BORDER_COLOR, "TEX_PARAMETERIV", 4, -2147483648, 0, 1073741824, 2147483647],
        ["int_priority", GL.TEXTURE_PRIORITY, "TEX_PARAMETERI", 1],
        ["float_priority", GL.TEXTURE_PRIORITY, "TEX_PARAMETERF", 0.75],
        ["float_base", GL.TEXTURE_BASE_LEVEL, "TEX_PARAMETERF", 2.75],
        ["float_boolean", GL.GENERATE_MIPMAP, "TEX_PARAMETERF", 0.25],
        ["float_boolean_high", GL.GENERATE_MIPMAP, "TEX_PARAMETERF", 0.75],
        ["min_lod", GL.TEXTURE_MIN_LOD, "TEX_PARAMETERF", -2.75],
        ["lod_bias", GL.TEXTURE_LOD_BIAS, "TEX_PARAMETERF", 100],
        ["anisotropy", GL.TEXTURE_MAX_ANISOTROPY_EXT, "TEX_PARAMETERF", 2.5],
        ["float_enum", GL.TEXTURE_MIN_FILTER, "TEX_PARAMETERF", GL.LINEAR + 0.25],
        ["float_enum_high", GL.TEXTURE_MIN_FILTER, "TEX_PARAMETERF", GL.LINEAR + 0.75],
    ];
    for (const [name, pname, command, ...args] of steps) {
        const stream = new GLStream(); if (command) stream.call(command, GL.TEXTURE_2D, pname, ...args);
        const floats = query(stream, pname, P.C.V86GL_STATE_FLOAT), ints = query(stream, pname, P.C.V86GL_STATE_INTEGER);
        s.process(stream.bytes()); gpu.submit(stream.bytes(), {});
        // GL 2.1 section 3.8.4 normalizes integer priorities; Apple's driver
        // instead clamps the raw integer. Keep its original fixture.
        const expected = name === "int_priority" ? { float: [Math.fround(1 / 0x7FFFFFFF)], int: [0] } : reference[name];
        assert.equal(floats().status, 1, name); assert.equal(ints().status, 1, name);
        assert.deepEqual(floats().values, expected.float, name); assert.deepEqual(ints().values, expected.int, name);
        const image = gpu.boundTexture(GL.TEXTURE_2D), d = parameters.definitions.get(pname);
        if (d.field) assert.deepEqual(d.initial.length > 1 ? Array.from(image.sampler[d.field]) : [image.sampler[d.field]], expected.float, "renderer " + name);
    }
    assert.equal(s.stats.rejected, 0);
});
test("texture attributes restore object parameters across sharing, deletion and snapshots", async () => {
    const s = shadow(), { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host }); await gpu.initialize();
    const stream = scene().call("BIND_TEXTURE", GL.TEXTURE_2D, 7)
        .call("TEX_PARAMETERFV", GL.TEXTURE_2D, GL.TEXTURE_BORDER_COLOR, 4, 0.25, 0.5, 0.75, 1)
        .call("PUSH_ATTRIB", 0x40000).makeCurrent(2, 0, 0, 64, 64, 2, 1).call("BIND_TEXTURE", GL.TEXTURE_2D, 7)
        .call("TEX_PARAMETERF", GL.TEXTURE_2D, GL.TEXTURE_MIN_LOD, 9)
        .makeCurrent(1, 0, 0, 64, 64, 1, 1).names(P.GLFN.DELETE_TEXTURES, [7]).call("BIND_TEXTURE", GL.TEXTURE_2D, 7)
        .call("TEX_PARAMETERFV", GL.TEXTURE_2D, GL.TEXTURE_BORDER_COLOR, 4, 1, 0, 0, 1).call("POP_ATTRIB");
    const color = query(stream, GL.TEXTURE_BORDER_COLOR, P.C.V86GL_STATE_FLOAT), lod = query(stream, GL.TEXTURE_MIN_LOD, P.C.V86GL_STATE_FLOAT);
    s.process(stream.bytes()); gpu.submit(stream.bytes(), {});
    assert.deepEqual(color().values, [0.25, 0.5, 0.75, 1]); assert.deepEqual(lod().values, [-1000]);
    assert.deepEqual(Array.from(gpu.boundTexture(GL.TEXTURE_2D).sampler.borderColor), color().values);
    assert.equal(gpu.boundTexture(GL.TEXTURE_2D).sampler.minLod, -1000);
    const copy = shadow(); copy.setState(JSON.parse(JSON.stringify(s.getState())));
    const again = new GLStream().makeCurrent(2, 0, 0, 64, 64, 2, 1), after = query(again, GL.TEXTURE_BORDER_COLOR, P.C.V86GL_STATE_FLOAT);
    copy.process(again.bytes()); assert.deepEqual(after().values, color().values);
    const defaultStack = scene().call("BIND_TEXTURE", GL.TEXTURE_2D, 0).call("PUSH_ATTRIB", 0x40000)
        .call("TEX_PARAMETERFV", GL.TEXTURE_2D, GL.TEXTURE_BORDER_COLOR, 4, 1, 1, 1, 1).call("POP_ATTRIB");
    const initial = query(defaultStack, GL.TEXTURE_BORDER_COLOR, P.C.V86GL_STATE_FLOAT); copy.process(defaultStack.bytes());
    assert.deepEqual(initial().values, [0, 0, 0, 0]);
});
test("named priorities update unbound created textures and ignore zero, missing and reserved names", async () => {
    const s = shadow(), { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host }); await gpu.initialize();
    const stream = scene().call("BIND_TEXTURE", GL.TEXTURE_2D, 7).call("BIND_TEXTURE", GL.TEXTURE_2D, 9).names(P.GLFN.GEN_TEXTURES, [8]);
    prioritize(stream, [0, 7, 8, 99], [0, 0.25, 0.5, 1]);
    stream.call("BIND_TEXTURE", GL.TEXTURE_2D, 7); const first = query(stream, GL.TEXTURE_PRIORITY, P.C.V86GL_STATE_FLOAT);
    prioritize(stream, [7, 7], [-1, 2]); const last = query(stream, GL.TEXTURE_PRIORITY, P.C.V86GL_STATE_FLOAT);
    s.process(stream.bytes()); gpu.submit(stream.bytes(), {});
    assert.deepEqual(first().values, [0.25]); assert.deepEqual(last().values, [1]);
    assert.equal(gpu.boundTexture(GL.TEXTURE_2D).priority, 1);
    assert.equal(s.current.group.textures.get(8).parameters, undefined); assert.equal(s.current.group.textures.has(99), false);
});
test("invalid parameter calls and failed queries preserve existing values and output", () => {
    for (const [name, pname, args, error] of [
        ["TEX_PARAMETERI", GL.TEXTURE_MIN_FILTER, [0], GL.INVALID_ENUM],
        ["TEX_PARAMETERI", GL.TEXTURE_MAG_FILTER, [GL.NEAREST_MIPMAP_LINEAR], GL.INVALID_ENUM],
        ["TEX_PARAMETERF", GL.TEXTURE_BASE_LEVEL, [-1], GL.INVALID_VALUE],
        ["TEX_PARAMETERF", GL.TEXTURE_MAX_ANISOTROPY_EXT, [0.5], GL.INVALID_VALUE],
        ["TEX_PARAMETERI", GL.TEXTURE_BORDER_COLOR, [1], GL.INVALID_ENUM],
        ["TEX_PARAMETERIV", GL.TEXTURE_BORDER_COLOR, [1, 1, 0, 0, 0], GL.INVALID_VALUE],
    ]) {
        const s = shadow(), stream = scene().call(name, GL.TEXTURE_2D, pname, ...args), q = query(stream, GL.TEXTURE_BORDER_COLOR, P.C.V86GL_STATE_FLOAT);
        s.process(stream.bytes()); assert.equal(s.current.error, error); assert.deepEqual(q().values, [0, 0, 0, 0]);
        assert.equal(s.stats.rejected, 1);
    }
    const s = shadow(), stream = scene(), q = query(stream, 0, P.C.V86GL_STATE_INTEGER);
    s.process(stream.bytes()); assert.equal(q().status, 2); assert.equal(q().error, GL.INVALID_ENUM); assert.ok(q().bytes.every(v => v === 0xA5));
});
test("texture level queries preserve dimensions, faces and effective component precision", () => {
    const native = require("./gl_conformance/texture_levels_reference.json").cases;
    const pnames = [GL.TEXTURE_WIDTH, GL.TEXTURE_HEIGHT, GL.TEXTURE_DEPTH, GL.TEXTURE_INTERNAL_FORMAT, GL.TEXTURE_BORDER,
        GL.TEXTURE_RED_SIZE, GL.TEXTURE_GREEN_SIZE, GL.TEXTURE_BLUE_SIZE, GL.TEXTURE_ALPHA_SIZE,
        GL.TEXTURE_LUMINANCE_SIZE, GL.TEXTURE_INTENSITY_SIZE, GL.TEXTURE_DEPTH_SIZE, GL.TEXTURE_COMPRESSED];
    const s = shadow(); s.process(scene().bytes());
    const image = (name, target, level, internalformat, width, height = 1, depth = 1) => stream => {
        stream.record(P.GLFN[name], P.encodeRecord(name, { target, level, internalformat, width, height, depth,
            border: 0, format: internalformat === GL.DEPTH_COMPONENT16 ? GL.DEPTH_COMPONENT : GL.RGBA, type: GL.UNSIGNED_BYTE, data_size: 0 }));
    };
    for (const [key, target, level, define] of [
        ["undefined", GL.TEXTURE_2D, 0],
        ["rgba4_level2", GL.TEXTURE_2D, 2, image("TEX_IMAGE_2D", GL.TEXTURE_2D, 2, GL.RGBA4, 3, 5)],
        ["other_level", GL.TEXTURE_2D, 1],
        ["zero_width", GL.TEXTURE_2D, 0, image("TEX_IMAGE_2D", GL.TEXTURE_2D, 0, GL.RGBA8, 0, 5)],
        ["rgb1d", GL.TEXTURE_1D, 0, image("TEX_IMAGE_1D", GL.TEXTURE_1D, 0, GL.RGB8, 7)],
        ["luminance3d", GL.TEXTURE_3D, 0, image("TEX_IMAGE_3D", GL.TEXTURE_3D, 0, GL.LUMINANCE4, 4, 3, 2)],
        ["cube_positive_x", GL.TEXTURE_CUBE_MAP_POSITIVE_X, 0,
            image("TEX_IMAGE_2D", GL.TEXTURE_CUBE_MAP_POSITIVE_X, 0, GL.RGBA8, 4, 4)],
        ["cube_negative_x", GL.TEXTURE_CUBE_MAP_NEGATIVE_X, 0],
        ["depth16", GL.TEXTURE_2D, 0, image("TEX_IMAGE_2D", GL.TEXTURE_2D, 0, GL.DEPTH_COMPONENT16, 4, 4)],
        ["rgba16f", GL.TEXTURE_2D, 0, image("TEX_IMAGE_2D", GL.TEXTURE_2D, 0, GL.RGBA16F_ARB, 4, 4)],
        ["dxt1", GL.TEXTURE_2D, 0, stream => stream.compressedTexImage2D(GL.TEXTURE_2D, 0,
            GL.COMPRESSED_RGBA_S3TC_DXT1_EXT, 4, 4, new Uint8Array(8))],
    ]) {
        const stream = new GLStream(); if (define) define(stream);
        const queries = pnames.map(pname => query(stream, pname, P.C.V86GL_STATE_INTEGER, target, P.C.V86GL_PARAMETER_TEXTURE_LEVEL, level));
        s.process(stream.bytes()); const expected = native[key].slice(0, 13);
        // Our uploader quantizes these formats instead of selecting Apple's
        // eight-bit alternative; a never-defined cube face keeps GL's initial 1.
        if (key === "rgba4_level2") { expected[3] = GL.RGBA4; expected.fill(4, 5, 9); }
        if (key === "luminance3d") { expected[3] = GL.LUMINANCE4; expected[9] = 4; }
        if (key === "cube_negative_x") expected[3] = 1;
        assert.deepEqual(queries.map(q => q().values[0]), expected, key);
        assert.ok(queries.every(q => q().status === 1));
    }
    const stream = new GLStream(), size = query(stream, GL.TEXTURE_COMPRESSED_IMAGE_SIZE, P.C.V86GL_STATE_INTEGER,
        GL.TEXTURE_2D, P.C.V86GL_PARAMETER_TEXTURE_LEVEL);
    s.process(stream.bytes()); assert.deepEqual(size().values, [native.compressed_size[1]]);
    const copy = shadow(); copy.setState(JSON.parse(JSON.stringify(s.getState())));
    const check = new GLStream(), restored = query(check, GL.TEXTURE_COMPRESSED_IMAGE_SIZE, P.C.V86GL_STATE_INTEGER,
        GL.TEXTURE_2D, P.C.V86GL_PARAMETER_TEXTURE_LEVEL);
    copy.process(check.bytes()); assert.deepEqual(restored().values, [8]);
});

test("texture level query errors preserve output and report bad target, level and compression", () => {
    for (const [target, level, pname, error] of [[GL.TEXTURE_CUBE_MAP, 0, GL.TEXTURE_WIDTH, GL.INVALID_ENUM],
        [GL.TEXTURE_2D, -1, GL.TEXTURE_WIDTH, GL.INVALID_VALUE], [GL.TEXTURE_3D, 12, GL.TEXTURE_WIDTH, GL.INVALID_VALUE],
        [GL.TEXTURE_2D, 0, 0, GL.INVALID_ENUM], [GL.TEXTURE_2D, 0, GL.TEXTURE_COMPRESSED_IMAGE_SIZE, GL.INVALID_OPERATION]]) {
        const s = shadow(), stream = scene(), q = query(stream, pname, P.C.V86GL_STATE_FLOAT, target, P.C.V86GL_PARAMETER_TEXTURE_LEVEL, level);
        s.process(stream.bytes()); assert.equal(q().status, 2); assert.equal(q().error, error);
        assert.ok(q().bytes.every(v => v === 0xA5));
    }
});

test("automatic mipmap queries retain image metadata after definition and snapshot", () => {
    const s = shadow(), stream = scene().call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.GENERATE_MIPMAP, 1)
        .texImage2D(GL.TEXTURE_2D, 0, GL.RGBA4, 8, 4, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(0));
    const queries = [0, 1, 2, 3, 4].map(level => query(stream, GL.TEXTURE_WIDTH, P.C.V86GL_STATE_INTEGER,
        GL.TEXTURE_2D, P.C.V86GL_PARAMETER_TEXTURE_LEVEL, level));
    s.process(stream.bytes()); assert.deepEqual(queries.map(q => q().values[0]), [8, 4, 2, 1, 0]);
    const copy = shadow(); copy.setState(JSON.parse(JSON.stringify(s.getState())));
    const check = new GLStream(), bits = query(check, GL.TEXTURE_RED_SIZE, P.C.V86GL_STATE_FLOAT,
        GL.TEXTURE_2D, P.C.V86GL_PARAMETER_TEXTURE_LEVEL, 2);
    const type = query(check, 0x8C10, P.C.V86GL_STATE_INTEGER, GL.TEXTURE_2D, P.C.V86GL_PARAMETER_TEXTURE_LEVEL, 2);
    copy.process(check.bytes()); assert.deepEqual(bits().values, [4]); assert.deepEqual(type().values, [0x8C17]);
});

test("proxy images are context-local metadata and never allocate renderer images", async () => {
    const native = require("./gl_conformance/texture_levels_reference.json").cases;
    const s = shadow(), { host, log } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true }); await gpu.initialize();
    const initial = scene(); s.process(initial.bytes()); gpu.submit(initial.bytes(), {});
    const allocated = log.textures.length;
    const stream = new GLStream().texImage2D(GL.PROXY_TEXTURE_2D, 0, GL.RGBA8, 64, 32, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(0));
    const pnames = [GL.TEXTURE_WIDTH, GL.TEXTURE_HEIGHT, GL.TEXTURE_DEPTH, GL.TEXTURE_INTERNAL_FORMAT, GL.TEXTURE_RED_SIZE];
    const answers = pnames.map(pname => query(stream, pname, P.C.V86GL_STATE_INTEGER, GL.PROXY_TEXTURE_2D, P.C.V86GL_PARAMETER_TEXTURE_LEVEL));
    s.process(stream.bytes()); gpu.submit(stream.bytes().slice(), {});
    assert.deepEqual(answers.map(q => q().values[0]), [native.proxy_ok[0], native.proxy_ok[1], native.proxy_ok[2], native.proxy_ok[3], native.proxy_ok[5]]);
    assert.equal(log.textures.length, allocated); assert.equal(s.current.group.textureImages.size, 0);
    assert.equal(gpu.current.shareGroup.textureImages.size, 0, "proxy metadata must remain entirely on the CPU");
    const large = new GLStream().texImage2D(GL.PROXY_TEXTURE_2D, 0, GL.RGBA8, 1 << 30, 32, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(0));
    const old = query(large, GL.TEXTURE_WIDTH, P.C.V86GL_STATE_FLOAT, GL.PROXY_TEXTURE_2D, P.C.V86GL_PARAMETER_TEXTURE_LEVEL);
    s.process(large.bytes()); gpu.submit(large.bytes(), {});
    // Apple preserves the previous probe and reports INVALID_VALUE. GL 2.1
    // 3.8.11 instead requires an unsupported-size probe to clear without error.
    assert.equal(native.proxy_oversized.at(-1), GL.INVALID_VALUE);
    assert.equal(s.current.error, 0); assert.deepEqual(old().values, [0]);
    const emptyProbe = new GLStream(), cleared = [GL.TEXTURE_HEIGHT, GL.TEXTURE_DEPTH, GL.TEXTURE_INTERNAL_FORMAT,
        GL.TEXTURE_BORDER, GL.TEXTURE_RED_SIZE, GL.TEXTURE_COMPRESSED].map(pname => query(emptyProbe, pname,
        P.C.V86GL_STATE_INTEGER, GL.PROXY_TEXTURE_2D, P.C.V86GL_PARAMETER_TEXTURE_LEVEL));
    s.process(emptyProbe.bytes()); assert.deepEqual(cleared.map(q => q().values[0]), [0, 0, 0, 0, 0, 0]);
    const replacement = new GLStream().texImage2D(GL.PROXY_TEXTURE_2D, 0, GL.RGBA8, 64, 32, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(0));
    s.process(replacement.bytes());
    const copy = shadow(); copy.setState(JSON.parse(JSON.stringify(s.getState())));
    const other = new GLStream().makeCurrent(1, 0, 0, 64, 64, 2, 1);
    const empty = query(other, GL.TEXTURE_WIDTH, P.C.V86GL_STATE_INTEGER, GL.PROXY_TEXTURE_2D, P.C.V86GL_PARAMETER_TEXTURE_LEVEL);
    copy.process(other.bytes()); assert.deepEqual(empty().values, [0]);
    const back = scene(), restored = query(back, GL.TEXTURE_WIDTH, P.C.V86GL_STATE_INTEGER, GL.PROXY_TEXTURE_2D, P.C.V86GL_PARAMETER_TEXTURE_LEVEL);
    copy.process(back.bytes()); assert.deepEqual(restored().values, [64]);
    assert.equal(log.textures.length, allocated); assert.equal(gpu.hostErrors.length, 0); assert.equal(gpu.stats.refusals, 0);
});

test("proxy validation rejects bad dimensions and formats without changing accepted metadata", () => {
    for (const [name, fields, error] of [
        ["TEX_IMAGE_1D", { target: GL.PROXY_TEXTURE_2D }, GL.INVALID_ENUM],
        ["TEX_IMAGE_2D", { target: GL.PROXY_TEXTURE_CUBE_MAP, width: 4, height: 2 }, GL.INVALID_VALUE],
        ["TEX_IMAGE_2D", { level: -1 }, GL.INVALID_VALUE],
        ["TEX_IMAGE_2D", { internalformat: 0 }, GL.INVALID_VALUE],
        ["TEX_IMAGE_2D", { format: 0 }, GL.INVALID_ENUM],
        ["TEX_IMAGE_2D", { type: GL.UNSIGNED_SHORT_5_6_5, format: GL.RGBA }, GL.INVALID_OPERATION],
        ["TEX_IMAGE_2D", { internalformat: GL.DEPTH_COMPONENT16, format: GL.RGBA }, GL.INVALID_OPERATION],
        ["COMPRESSED_TEX_IMAGE_1D", { target: GL.PROXY_TEXTURE_1D, internalformat: GL.COMPRESSED_RGBA_S3TC_DXT1_EXT }, GL.INVALID_ENUM],
        ["COMPRESSED_TEX_IMAGE_2D", { internalformat: GL.COMPRESSED_RGBA_S3TC_DXT1_EXT, image_size: 7 }, GL.INVALID_VALUE],
        ["COMPRESSED_TEX_IMAGE_2D", { internalformat: GL.COMPRESSED_RGBA_S3TC_DXT1_EXT, border: 1 }, GL.INVALID_OPERATION],
    ]) {
        const s = shadow(), initial = scene().texImage2D(GL.PROXY_TEXTURE_2D, 0, GL.RGBA8, 4, 4, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(0));
        s.process(initial.bytes());
        const stream = new GLStream().record(P.GLFN[name], P.encodeRecord(name, { target: GL.PROXY_TEXTURE_2D, level: 0,
            internalformat: GL.RGBA8, width: 4, height: 4, depth: 1, border: 0, format: GL.RGBA, type: GL.UNSIGNED_BYTE, ...fields }));
        s.process(stream.bytes()); assert.equal(s.current.error, error, name + JSON.stringify(fields));
        assert.equal(s.current.proxyImages.get(GL.PROXY_TEXTURE_2D).get(0).width, 4);
    }
});

function upload(stream, name, fields, data = new Uint8Array(0)) {
    const header = P.encodeRecord(name, { target: GL.TEXTURE_2D, level: 0, internalformat: GL.RGBA8,
        width: 4, height: 4, depth: 1, border: 0, format: GL.RGBA, type: GL.UNSIGNED_BYTE,
        data_size: data.length, image_size: data.length, ...fields });
    const payload = new Uint8Array(header.length + data.length); payload.set(header); payload.set(data, header.length);
    return stream.record(P.GLFN[name], payload);
}

test("ordinary texture uploads reject invalid parameters atomically against desktop GL", () => {
    const native = require("./gl_conformance/texture_uploads_reference.json").cases;
    for (const [key, fields] of [["valid", {}], ["target", { target: GL.TEXTURE_CUBE_MAP }],
        ["negative_level", { level: -1 }], ["large_level", { level: 1000 }], ["negative_width", { width: -1 }],
        ["border2", { border: 2 }], ["border_too_large", { width: 1, height: 1, border: 1 }],
        ["bad_internal", { internalformat: 0 }], ["bgr_internal", { internalformat: GL.BGR }],
        ["rgb565_internal", { internalformat: GL.RGB565, format: GL.RGB, type: GL.UNSIGNED_SHORT_5_6_5 }],
        ["bad_format", { format: 0 }], ["bad_type", { type: 0 }],
        ["bgr565", { internalformat: GL.RGB8, format: GL.BGR, type: GL.UNSIGNED_SHORT_5_6_5 }],
        ["rgb565", { internalformat: GL.RGB8, format: GL.RGB, type: GL.UNSIGNED_SHORT_5_6_5 }],
        ["rgba565", { type: GL.UNSIGNED_SHORT_5_6_5 }], ["bgra4444", { format: GL.BGRA, type: GL.UNSIGNED_SHORT_4_4_4_4 }],
        ["rgb4444", { internalformat: GL.RGB8, format: GL.RGB, type: GL.UNSIGNED_SHORT_4_4_4_4 }],
        ["bitmap_rgb", { internalformat: GL.RGB8, format: GL.RGB, type: 0x1A00 }],
        ["bitmap_index", { internalformat: GL.RGB8, format: GL.COLOR_INDEX, type: 0x1A00 }],
        ["depth_as_color", { format: GL.DEPTH_COMPONENT, type: GL.FLOAT }],
        ["color_as_depth", { internalformat: GL.DEPTH_COMPONENT16 }],
        ["cube_rectangle", { target: GL.TEXTURE_CUBE_MAP_POSITIVE_X, height: 2 }]]) {
        const s = shadow(), initial = scene().texImage2D(GL.TEXTURE_2D, 0, GL.RGBA4, 3, 5, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(0));
        s.process(initial.bytes());
        const image = s.boundImage(GL.TEXTURE_2D).texture, previous = image.levels.get(0).get(0);
        const stream = upload(new GLStream(), "TEX_IMAGE_2D", fields); s.process(stream.bytes());
        // GL 2.1 3.8.1 specifies INVALID_VALUE for an invalid internal format;
        // Apple's driver reports INVALID_ENUM instead. Keep its raw fixture.
        const error = ["bad_internal", "bgr_internal", "rgb565_internal"].includes(key) ? GL.INVALID_VALUE : native[key];
        assert.equal(s.current.error, error, key); assert.equal(s.stats.rejected, +!!error, key);
        if (error) assert.equal(image.levels.get(0).get(0), previous, key + " replaced the old image");
    }
});

test("upload bounds honor row padding, image strides, skipped pixels and bitmap bit offsets", () => {
    const cases = [
        ["TEX_IMAGE_2D", { width: 1, height: 2, format: GL.RGB }, [], 7],
        ["TEX_IMAGE_3D", { target: GL.TEXTURE_3D, width: 2, height: 2, depth: 2, format: GL.RGB, type: GL.UNSIGNED_SHORT },
            [[GL.UNPACK_ALIGNMENT, 8], [GL.UNPACK_ROW_LENGTH, 4], [GL.UNPACK_IMAGE_HEIGHT, 3], [GL.UNPACK_SKIP_IMAGES, 1],
                [GL.UNPACK_SKIP_ROWS, 1], [GL.UNPACK_SKIP_PIXELS, 1]], 210],
        ["TEX_IMAGE_2D", { width: 1, height: 1 }, [[GL.UNPACK_ROW_LENGTH, 3], [GL.UNPACK_SKIP_ROWS, 2],
            [GL.UNPACK_SKIP_PIXELS, 1], [GL.UNPACK_SKIP_IMAGES, 7]], 32],
        ["TEX_IMAGE_2D", { width: 6, height: 2, format: GL.COLOR_INDEX, type: 0x1A00 },
            [[GL.UNPACK_ROW_LENGTH, 9], [GL.UNPACK_SKIP_ROWS, 1], [GL.UNPACK_SKIP_PIXELS, 3]], 10],
        ["TEX_IMAGE_2D", { width: 3, height: 2 }, [[GL.UNPACK_ROW_LENGTH, 1]], 16],
    ];
    for (const [name, fields, stores, required] of cases) for (const complete of [false, true]) {
        const s = shadow(), stream = scene(); for (const [pname, value] of stores) stream.call("PIXEL_STOREI", pname, value);
        upload(stream, name, fields, new Uint8Array(required - (complete ? 0 : 1))); s.process(stream.bytes());
        assert.equal(s.current.error, complete ? 0 : GL.INVALID_OPERATION, JSON.stringify([name, fields, stores, complete]));
        assert.equal(s.stats.rejected, +!complete);
    }
    const s = shadow(), stream = scene(); upload(stream, "TEX_IMAGE_2D", { width: 1, height: 1, data_size: 5 }, new Uint8Array(4));
    s.process(stream.bytes()); assert.equal(s.current.error, GL.INVALID_VALUE, "a truncated declared payload is rejected before storage");
});

test("uncompressed compression hints resolve to base formats and compressed payloads require exact sizes", () => {
    for (const format of [GL.COMPRESSED_RGB, GL.COMPRESSED_RGBA, GL.COMPRESSED_RGBA_S3TC_DXT1_EXT]) {
        const s = shadow(), stream = scene(); upload(stream, "TEX_IMAGE_2D", { internalformat: format });
        const q = query(stream, GL.TEXTURE_INTERNAL_FORMAT, P.C.V86GL_STATE_INTEGER, GL.TEXTURE_2D, P.C.V86GL_PARAMETER_TEXTURE_LEVEL);
        s.process(stream.bytes()); assert.equal(s.current.error, 0); assert.deepEqual(q().values, [format === GL.COMPRESSED_RGB ? GL.RGB : GL.RGBA]);
    }
    for (const [fields, bytes, error] of [
        [{}, 8, 0], [{ image_size: 7 }, 7, GL.INVALID_VALUE], [{ image_size: 8 }, 7, GL.INVALID_VALUE],
        [{ border: 1 }, 8, GL.INVALID_OPERATION], [{ internalformat: GL.COMPRESSED_RGB }, 8, GL.INVALID_ENUM],
    ]) {
        const s = shadow(), stream = scene(); upload(stream, "COMPRESSED_TEX_IMAGE_2D",
            { internalformat: GL.COMPRESSED_RGBA_S3TC_DXT1_EXT, ...fields }, new Uint8Array(bytes));
        s.process(stream.bytes()); assert.equal(s.current.error, error); assert.equal(s.stats.rejected, +!!error);
    }
});

test("ordinary and compressed subimages match native boundaries and S3TC operation errors", () => {
    const native = require("./gl_conformance/texture_subimages_reference.json").cases;
    for (const [key, fields, compressed, bytes = 1024] of [
        ["valid", { xoffset: 1, yoffset: 1, width: 2, height: 2 }],
        ["undefined_level", { level: 1 }], ["negative_offset", { xoffset: -1 }],
        ["past_edge", { xoffset: 3, width: 2 }], ["negative_width", { width: -1 }],
        ["empty_at_edge", { xoffset: 4, width: 0 }], ["empty_past_edge", { xoffset: 5, width: 0 }],
        ["bad_format", { format: 0 }], ["bad_type", { type: 0 }], ["depth_as_color", { format: GL.DEPTH_COMPONENT, type: GL.FLOAT }],
        ["valid_3d", { target: GL.TEXTURE_3D, zoffset: 1, depth: 1 }],
        ["past_slice", { target: GL.TEXTURE_3D, zoffset: 2, depth: 1 }],
        ["compressed_valid", { width: 4, height: 4 }, true, 8],
        ["compressed_unaligned", { xoffset: 1, width: 4, height: 4 }, true, 8],
        ["compressed_partial_block", { width: 2, height: 4 }, true, 8],
        ["compressed_edge", { xoffset: 4, width: 4, height: 4 }, true, 8],
        ["compressed_past_edge", { xoffset: 8, width: 4, height: 4 }, true, 8],
        ["compressed_bad_size", { width: 4, height: 4 }, true, 7],
        ["compressed_wrong_format", { width: 4, height: 4, format: GL.COMPRESSED_RGBA_S3TC_DXT3_EXT }, true, 16],
        ["compressed_unknown_format", { width: 4, height: 4, format: GL.RGBA }, true, 8],
        ["ordinary_partial_origin", { width: 2, height: 4 }],
        ["ordinary_partial_non_origin", { xoffset: 4, width: 2, height: 4 }],
        ["undefined_empty", { width: 0, height: 0 }],
    ]) {
        const s = shadow(), initial = scene();
        upload(initial, "TEX_IMAGE_2D", {});
        upload(initial, "TEX_IMAGE_3D", { target: GL.TEXTURE_3D, depth: 2 });
        if (compressed || key.startsWith("ordinary_partial"))
            upload(initial, "COMPRESSED_TEX_IMAGE_2D", { internalformat: GL.COMPRESSED_RGBA_S3TC_DXT1_EXT, width: 8, height: 8 }, new Uint8Array(32));
        if (key === "undefined_empty") initial.call("BIND_TEXTURE", GL.TEXTURE_2D, 17);
        s.process(initial.bytes()); assert.equal(s.current.error, 0);
        const dimensions = fields.target === GL.TEXTURE_3D ? 3 : 2;
        const stream = upload(new GLStream(), (compressed ? "COMPRESSED_TEX_SUB_IMAGE_" : "TEX_SUB_IMAGE_") + dimensions + "D",
            { xoffset: 0, yoffset: 0, zoffset: 0, width: 1, height: 1, depth: 1,
                ...(compressed ? { format: GL.COMPRESSED_RGBA_S3TC_DXT1_EXT } : {}), ...fields }, new Uint8Array(bytes));
        s.process(stream.bytes());
        // EXT_texture_compression_s3tc requires INVALID_OPERATION here;
        // Apple reports INVALID_VALUE for these two block-shape failures.
        const error = ["compressed_unaligned", "compressed_partial_block"].includes(key) ? GL.INVALID_OPERATION : native[key];
        assert.equal(s.current.error, error, key); assert.equal(s.stats.rejected, +!!error, key);
    }
});

test("subimage payload failures preserve mipmaps and valid border offsets are accepted", () => {
    const s = shadow(), initial = scene(); upload(initial, "TEX_IMAGE_2D", {}); upload(initial, "TEX_IMAGE_2D", { level: 1, width: 3, height: 3 });
    initial.call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.GENERATE_MIPMAP, 1); s.process(initial.bytes());
    const texture = s.boundImage(GL.TEXTURE_2D).texture;
    const invalid = upload(new GLStream(), "TEX_SUB_IMAGE_2D", { width: 1, height: 1 }, new Uint8Array(3));
    s.process(invalid.bytes()); assert.equal(s.current.error, GL.INVALID_OPERATION); assert.equal(texture.levels.get(0).get(1).width, 3);
    const valid = upload(new GLStream(), "TEX_SUB_IMAGE_2D", { width: 1, height: 1 }, new Uint8Array(4));
    s.process(valid.bytes()); assert.equal(s.stats.rejected, 1); assert.equal(texture.levels.get(0).get(1).width, 2);
    const cut = shadow(), setup = upload(scene(), "TEX_IMAGE_2D", {}); cut.process(setup.bytes());
    const truncated = upload(new GLStream(), "TEX_SUB_IMAGE_2D", { width: 1, height: 1, data_size: 4 }, new Uint8Array(3));
    cut.process(truncated.bytes()); assert.equal(cut.current.error, GL.INVALID_VALUE);
    for (const xoffset of [-1, -2]) {
        const current = shadow(), stream = scene(); upload(stream, "TEX_IMAGE_2D", { width: 6, height: 6, border: 1 });
        upload(stream, "TEX_SUB_IMAGE_2D", { xoffset, yoffset: -1, width: 2, height: 2 }, new Uint8Array(16));
        current.process(stream.bytes()); assert.equal(current.current.error, xoffset === -1 ? 0 : GL.INVALID_VALUE);
    }
    for (const complete of [false, true]) {
        const current = shadow(), stream = scene(); upload(stream, "TEX_IMAGE_3D", { target: GL.TEXTURE_3D, depth: 2 });
        for (const [pname, value] of [[GL.UNPACK_ALIGNMENT, 8], [GL.UNPACK_ROW_LENGTH, 4], [GL.UNPACK_IMAGE_HEIGHT, 3],
            [GL.UNPACK_SKIP_IMAGES, 1], [GL.UNPACK_SKIP_ROWS, 1], [GL.UNPACK_SKIP_PIXELS, 1]]) stream.call("PIXEL_STOREI", pname, value);
        upload(stream, "TEX_SUB_IMAGE_3D", { target: GL.TEXTURE_3D, width: 2, height: 2, depth: 2, format: GL.RGB, type: GL.UNSIGNED_SHORT },
            new Uint8Array(complete ? 210 : 209));
        current.process(stream.bytes()); assert.equal(current.current.error, complete ? 0 : GL.INVALID_OPERATION);
    }
});

function copySetup() {
    return scene().call("BIND_TEXTURE", GL.TEXTURE_2D, 100)
        .texImage2D(GL.TEXTURE_2D, 0, GL.RGBA8, 4, 4, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(0))
        .call("BIND_FRAMEBUFFER", GL.FRAMEBUFFER_EXT, 1)
        .call("FRAMEBUFFER_TEXTURE", GL.FRAMEBUFFER_EXT, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, 100, 0, 0)
        .call("BIND_RENDERBUFFER", GL.RENDERBUFFER_EXT, 1).call("RENDERBUFFER_STORAGE", GL.RENDERBUFFER_EXT, GL.DEPTH_COMPONENT16, 4, 4)
        .call("FRAMEBUFFER_RENDERBUFFER", GL.FRAMEBUFFER_EXT, GL.DEPTH_ATTACHMENT, GL.RENDERBUFFER_EXT, 1)
        .call("BIND_TEXTURE", GL.TEXTURE_2D, 2);
}

test("CopyTexImage and CopyTexSubImage use native parameter and read-framebuffer errors", () => {
    const native = require("./gl_conformance/texture_copies_reference.json").cases;
    for (const [key, args, sub] of [
        ["valid", [GL.TEXTURE_2D, 0, GL.RGBA8, 0, 0, 2, 2, 0]],
        ["target", [GL.TEXTURE_CUBE_MAP, 0, GL.RGBA8, 0, 0, 2, 2, 0]],
        ["negative_level", [GL.TEXTURE_2D, -1, GL.RGBA8, 0, 0, 2, 2, 0]],
        ["negative_width", [GL.TEXTURE_2D, 0, GL.RGBA8, 0, 0, -1, 2, 0]],
        ["bad_border", [GL.TEXTURE_2D, 0, GL.RGBA8, 0, 0, 2, 2, 2]],
        ["bad_internal", [GL.TEXTURE_2D, 0, 0, 0, 0, 2, 2, 0]],
        ["legacy_internal", [GL.TEXTURE_2D, 0, 1, 0, 0, 2, 2, 0]],
        ["cube_rectangle", [GL.TEXTURE_CUBE_MAP_POSITIVE_X, 0, GL.RGBA8, 0, 0, 4, 2, 0]],
        ["depth", [GL.TEXTURE_2D, 0, GL.DEPTH_COMPONENT16, 0, 0, 2, 2, 0]],
        ["outside_source", [GL.TEXTURE_2D, 0, GL.RGBA8, -2, -2, 2, 2, 0]],
        ["sub_valid", [GL.TEXTURE_2D, 0, 1, 1, 0, 0, 2, 2], true],
        ["undefined_level", [GL.TEXTURE_2D, 1, 0, 0, 0, 0, 1, 1], true],
        ["negative_offset", [GL.TEXTURE_2D, 0, -1, 0, 0, 0, 1, 1], true],
        ["past_edge", [GL.TEXTURE_2D, 0, 3, 0, 0, 0, 2, 1], true],
        ["empty_at_edge", [GL.TEXTURE_2D, 0, 4, 0, 0, 0, 0, 1], true],
        ["read_none_color", [GL.TEXTURE_2D, 0, GL.RGBA8, 0, 0, 2, 2, 0]],
        ["read_none_depth", [GL.TEXTURE_2D, 0, GL.DEPTH_COMPONENT16, 0, 0, 2, 2, 0]],
        ["missing_depth", [GL.TEXTURE_2D, 0, GL.DEPTH_COMPONENT16, 0, 0, 2, 2, 0]],
        ["incomplete_source", [GL.TEXTURE_2D, 0, GL.RGBA8, 0, 0, 2, 2, 0]],
    ]) {
        const s = shadow(), initial = copySetup();
        if (sub) initial.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA8, 4, 4, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(0));
        if (key.startsWith("read_none")) initial.call("READ_BUFFER", GL.NONE);
        if (["missing_depth", "incomplete_source"].includes(key)) initial.call("FRAMEBUFFER_RENDERBUFFER", GL.FRAMEBUFFER_EXT, GL.DEPTH_ATTACHMENT, GL.RENDERBUFFER_EXT, 0);
        if (key === "incomplete_source") initial.call("FRAMEBUFFER_TEXTURE", GL.FRAMEBUFFER_EXT, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, 0, 0, 0);
        s.process(initial.bytes()); assert.equal(s.current.error, 0);
        const texture = s.current.group.textures.get(2), before = texture.levels.get(0)?.get(0);
        s.process(new GLStream().call(sub ? "COPY_TEX_SUB_IMAGE_2D" : "COPY_TEX_IMAGE_2D", ...args).bytes());
        assert.equal(s.current.error, native[key], key); assert.equal(s.stats.rejected, +!!native[key], key);
        if (native[key]) assert.equal(texture.levels.get(0)?.get(0), before, key + " changed the destination");
        if (!native[key] && !sub) assert.equal(texture.levels.get(0).get(0).width, 2);
    }
});

test("copy ranges include 1D, cube faces, 3D slices and split read/draw framebuffer selection", () => {
    const s = shadow(), initial = copySetup();
    initial.call("BIND_FRAMEBUFFER", GL.DRAW_FRAMEBUFFER, 9);
    initial.call("COPY_TEX_IMAGE_1D", GL.TEXTURE_1D, 0, GL.RGB8, 0, 0, 4, 0);
    initial.call("COPY_TEX_IMAGE_2D", GL.TEXTURE_CUBE_MAP_POSITIVE_X, 0, GL.RGBA8, 0, 0, 4, 4, 0);
    upload(initial, "TEX_IMAGE_3D", { target: GL.TEXTURE_3D, depth: 2 }); s.process(initial.bytes());
    assert.equal(s.current.error, 0, "an incomplete draw FBO does not prevent a valid read copy");
    for (const args of [["COPY_TEX_SUB_IMAGE_1D", GL.TEXTURE_1D, 0, 3, 0, 0, 1],
        ["COPY_TEX_SUB_IMAGE_2D", GL.TEXTURE_CUBE_MAP_POSITIVE_X, 0, 3, 3, 0, 0, 1, 1],
        ["COPY_TEX_SUB_IMAGE_3D", GL.TEXTURE_3D, 0, 3, 3, 1, 0, 0, 1, 1]]) {
        s.process(new GLStream().call(...args).bytes()); assert.equal(s.current.error, 0);
    }
    s.process(new GLStream().call("COPY_TEX_SUB_IMAGE_3D", GL.TEXTURE_3D, 0, 0, 0, 2, 0, 0, 1, 1).bytes());
    assert.equal(s.current.error, GL.INVALID_VALUE);
    for (const sub of [false, true]) {
        const current = shadow(), stream = copySetup();
        if (sub) upload(stream, "TEX_IMAGE_2D", { internalformat: GL.COLOR_INDEX8_EXT, format: GL.COLOR_INDEX });
        stream.call(sub ? "COPY_TEX_SUB_IMAGE_2D" : "COPY_TEX_IMAGE_2D", GL.TEXTURE_2D, 0,
            ...(sub ? [0, 0, 0, 0, 1, 1] : [GL.COLOR_INDEX8_EXT, 0, 0, 1, 1, 0]));
        current.process(stream.bytes()); assert.equal(current.current.error, sub ? GL.INVALID_OPERATION : GL.INVALID_ENUM);
    }
});

test("mipmap validation and metadata match desktop GL with explicit specification corrections", () => {
    const native = require("./gl_conformance/texture_mipmaps_reference.json").cases;
    const s = shadow(); s.process(scene().bytes());
    const current = (stream, key, level, expected = native[key], target = GL.TEXTURE_2D) => {
        s.current.error = 0;
        const answers = [GL.TEXTURE_WIDTH, GL.TEXTURE_HEIGHT, GL.TEXTURE_DEPTH, GL.TEXTURE_BORDER, GL.TEXTURE_INTERNAL_FORMAT]
            .map(pname => query(stream, pname, P.C.V86GL_STATE_INTEGER, target, P.C.V86GL_PARAMETER_TEXTURE_LEVEL, level));
        s.process(stream.bytes()); assert.deepEqual([s.current.error, ...answers.map(q => q().values[0])], expected, key);
    };
    current(new GLStream().call("GENERATE_MIPMAP", GL.TEXTURE_2D), "undefined", 1);
    current(new GLStream().call("GENERATE_MIPMAP", GL.PROXY_TEXTURE_2D), "proxy_target", 1);
    const setup = new GLStream().texImage2D(GL.TEXTURE_2D, 2, GL.RGBA8, 8, 4, GL.RGBA, GL.UNSIGNED_BYTE, null)
        .texImage2D(GL.TEXTURE_2D, 5, GL.RGB8, 1, 1, GL.RGB, GL.UNSIGNED_BYTE, null)
        .call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_BASE_LEVEL, 2)
        .call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_MAX_LEVEL, 4).call("GENERATE_MIPMAP", GL.TEXTURE_2D);
    current(setup, "nonzero_base", 3); current(new GLStream(), "maximum", 4);
    // Apple generates beyond MAX_LEVEL. EXT/ARB_framebuffer_object limits
    // manual generation to q; level 5 must retain its RGB8 definition.
    current(new GLStream(), "beyond_maximum", 5, [0, 1, 1, 1, 0, GL.RGB8]);
    current(new GLStream().call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.GENERATE_MIPMAP, 1)
        .texImage2D(GL.TEXTURE_2D, 2, GL.RGBA8, 4, 2, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(32)),
    "auto_base", 3, [0, 2, 1, 1, 0, GL.RGBA8]);
    current(new GLStream().texImage2D(GL.TEXTURE_2D, 0, GL.RGBA8, 64, 32, GL.RGBA, GL.UNSIGNED_BYTE, null),
        "auto_other", 3, [0, 2, 1, 1, 0, GL.RGBA8]);
    current(new GLStream().call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_MAX_LEVEL, 1).call("GENERATE_MIPMAP", GL.TEXTURE_2D),
        "inverted_range", 3, [0, 2, 1, 1, 0, GL.RGBA8]);
    const border = new GLStream().call("BIND_TEXTURE", GL.TEXTURE_2D, 2);
    upload(border, "TEX_IMAGE_2D", { width: 10, height: 6, border: 1 }); border.call("GENERATE_MIPMAP", GL.TEXTURE_2D);
    current(border, "border_level1", 1); current(new GLStream(), "border_level3", 3);
    const cube = new GLStream().call("BIND_TEXTURE", GL.TEXTURE_CUBE_MAP, 3);
    const cubeStep = (stream, key, level = 1) => {
        s.current.error = 0; s.process(stream.call("GENERATE_MIPMAP", GL.TEXTURE_CUBE_MAP).bytes());
        assert.equal(s.current.error, native[key][0], key);
        if (s.current.error) assert.ok(!s.boundImage(GL.TEXTURE_CUBE_MAP).texture.levels.get(0)?.has(level), "failed cube generation changed level " + key);
    };
    cubeStep(cube, "cube_empty");
    const faces = new GLStream(); for (let face = 0; face < 5; ++face)
        faces.texImage2D(GL.TEXTURE_CUBE_MAP_POSITIVE_X + face, 0, GL.RGBA8, 8, 8, GL.RGBA, GL.UNSIGNED_BYTE, null);
    cubeStep(faces, "cube_missing");
    cubeStep(new GLStream().texImage2D(GL.TEXTURE_CUBE_MAP_NEGATIVE_Z, 0, GL.RGBA8, 4, 4, GL.RGBA, GL.UNSIGNED_BYTE, null), "cube_size");
    cubeStep(new GLStream().texImage2D(GL.TEXTURE_CUBE_MAP_NEGATIVE_Z, 0, GL.RGB8, 8, 8, GL.RGB, GL.UNSIGNED_BYTE, null), "cube_format");
    cubeStep(new GLStream().texImage2D(GL.TEXTURE_CUBE_MAP_NEGATIVE_Z, 0, GL.RGBA8, 8, 8, GL.RGBA, GL.UNSIGNED_BYTE, null), "cube_complete");
    current(new GLStream(), "cube_complete", 3, native.cube_complete, GL.TEXTURE_CUBE_MAP_NEGATIVE_Z);
    const volume = new GLStream().call("BIND_TEXTURE", GL.TEXTURE_3D, 4);
    upload(volume, "TEX_IMAGE_3D", { width: 9, height: 5, depth: 3, target: GL.TEXTURE_3D });
    current(volume.call("GENERATE_MIPMAP", GL.TEXTURE_3D), "volume", 1, native.volume, GL.TEXTURE_3D);
});

test("automatic mipmaps follow the changed base face and ignore MAX_LEVEL while manual generation preserves other levels", () => {
    const s = shadow(), stream = scene().call("BIND_TEXTURE", GL.TEXTURE_CUBE_MAP, 7)
        .call("TEX_PARAMETERI", GL.TEXTURE_CUBE_MAP, GL.TEXTURE_BASE_LEVEL, 1)
        .call("TEX_PARAMETERI", GL.TEXTURE_CUBE_MAP, GL.TEXTURE_MAX_LEVEL, 1)
        .call("TEX_PARAMETERI", GL.TEXTURE_CUBE_MAP, GL.GENERATE_MIPMAP, 1);
    stream.texImage2D(GL.TEXTURE_CUBE_MAP_POSITIVE_X, 1, GL.RGBA8, 8, 8, GL.RGBA, GL.UNSIGNED_BYTE, null);
    stream.texImage2D(GL.TEXTURE_CUBE_MAP_NEGATIVE_X, 1, GL.RGB8, 4, 4, GL.RGB, GL.UNSIGNED_BYTE, null);
    s.process(stream.bytes()); assert.equal(s.current.error, 0);
    const image = s.boundImage(GL.TEXTURE_CUBE_MAP).texture;
    assert.equal(image.levels.get(0).get(2).width, 4); assert.equal(image.levels.get(1).get(2).width, 2);
    assert.equal(image.levels.get(0).get(4).internalFormat, GL.RGBA8);
    s.process(new GLStream().texImage2D(GL.TEXTURE_CUBE_MAP_NEGATIVE_X, 2, GL.RGB8, 3, 3, GL.RGB, GL.UNSIGNED_BYTE, null).bytes());
    const update = new GLStream().texImage2D(GL.TEXTURE_CUBE_MAP_POSITIVE_X, 1, GL.RGBA8, 2, 2, GL.RGBA, GL.UNSIGNED_BYTE, null);
    s.process(update.bytes()); assert.equal(image.levels.get(0).get(2).width, 1);
    assert.equal(image.levels.get(1).get(2).width, 3, "a different face must retain its explicitly replaced image");
    assert.equal(image.levels.get(0).get(4).width, 1, "levels beyond the replacement pyramid survive");
    const volume = scene().call("BIND_TEXTURE", GL.TEXTURE_3D, 8);
    upload(volume, "TEX_IMAGE_3D", { target: GL.TEXTURE_3D, width: 10, height: 6, depth: 4, border: 1 });
    volume.call("GENERATE_MIPMAP", GL.TEXTURE_3D); s.process(volume.bytes());
    assert.deepEqual(s.boundImage(GL.TEXTURE_3D).texture.levels.get(0).get(1),
        { width: 6, height: 4, depth: 3, internalFormat: GL.RGBA8, border: 1, compressed: false });
    const copy = shadow(); copy.setState(JSON.parse(JSON.stringify(s.getState())));
    assert.deepEqual(copy.boundImage(GL.TEXTURE_3D).texture.levels.get(0).get(1), s.boundImage(GL.TEXTURE_3D).texture.levels.get(0).get(1));
    const one = new GLStream().call("BIND_TEXTURE", GL.TEXTURE_1D, 9);
    upload(one, "TEX_IMAGE_1D", { target: GL.TEXTURE_1D, width: 10, border: 1 });
    one.call("GENERATE_MIPMAP", GL.TEXTURE_1D); s.process(one.bytes());
    assert.deepEqual(s.boundImage(GL.TEXTURE_1D).texture.levels.get(0).get(1),
        { width: 6, height: 1, depth: 1, internalFormat: GL.RGBA8, border: 1, compressed: false });
});

test("compressed definitions and updates regenerate mipmap metadata at a nonzero base", () => {
    const s = shadow(), stream = scene().call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_BASE_LEVEL, 1)
        .call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.GENERATE_MIPMAP, 1);
    upload(stream, "COMPRESSED_TEX_IMAGE_2D", { level: 1, width: 8, height: 8, internalformat: GL.COMPRESSED_RGBA_S3TC_DXT5_EXT, image_size: 64 }, new Uint8Array(64));
    s.process(stream.bytes()); const layer = s.boundImage(GL.TEXTURE_2D).texture.levels.get(0);
    assert.equal(s.current.error, 0); assert.deepEqual([2, 3, 4].map(level => [layer.get(level).width, layer.get(level).compressedSize]), [[4, 16], [2, 16], [1, 16]]);
    layer.delete(3);
    const update = new GLStream(); upload(update, "COMPRESSED_TEX_SUB_IMAGE_2D",
        { level: 1, width: 4, height: 4, format: GL.COMPRESSED_RGBA_S3TC_DXT5_EXT, image_size: 16 }, new Uint8Array(16));
    s.process(update.bytes()); assert.equal(s.current.error, 0); assert.equal(layer.get(3).width, 2);
    const during = new GLStream().call("BEGIN", GL.POINTS).call("GENERATE_MIPMAP", GL.TEXTURE_2D).call("END");
    s.process(during.bytes()); assert.equal(s.current.error, GL.INVALID_OPERATION);
});

(async () => {
    for (const { name, fn } of tests) {
        try { await fn(); console.log("ok   " + name); }
        catch (e) { console.error("FAIL " + name + "\n" + e.stack); process.exitCode = 1; return; }
    }
    console.log(tests.length + " GL texture parameter tests passed");
})();
