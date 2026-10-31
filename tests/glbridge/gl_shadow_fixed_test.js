#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_objects.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_raster.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_fixed.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const { GLStream, GL } = require("./gl_stream_builder.js");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js");
const { createFakeHost } = require("./gl_fake_gpu.js");
const reference = require("./gl_conformance/fixed_reference.json").cases;
const tests = [], test = (name, fn) => tests.push({ name, fn });
const { C } = P;
function scene() {
    const s = new GLStream().makeCurrent(1, 0, 0, 64, 64, 1, 1);
    s.ask = (query_kind, target, pname, value_kind = C.V86GL_STATE_FLOAT, capacity = 32) => {
        const name = query_kind ? "QUERY_PARAMETER" : "QUERY_STATE";
        const header = P.encodeRecord(name, { query_kind, target, pname, value_kind, data_size: capacity });
        const payload = new Uint8Array(header.length + capacity); payload.fill(0xA5, header.length); payload.set(header);
        s.record(P.GLFN[name], payload);
        const { view } = s.payloadView();
        return () => ({ status: view.getUint32(P.F[name].status, true), error: view.getUint32(P.F[name].error, true),
            values: Array.from({ length: view.getUint32(P.F[name].count, true) }, (_, i) => view.getFloat64(header.length + i * 8, true)),
            untouched: Array.from({ length: capacity }, (_, i) => view.getUint8(header.length + i)).every(v => v === 0xA5) });
    };
    return s;
}
const check = (answer, expected) => { assert.equal(answer().status, 1); assert.deepEqual(answer().values, expected); };
test("light, material, texture environment and texgen agree with independent GL 2.1 queries", () => {
    const s = scene(), pending = [];
    function compare(name, family, target, pname, kinds = ["integer", "float"]) {
        for (const kind of kinds) pending.push([s.ask(C["V86GL_PARAMETER_" + family], target, pname,
            C["V86GL_STATE_" + kind.toUpperCase()]), reference[name][kind]]);
    }
    compare("material_default", "MATERIAL", GL.FRONT, GL.AMBIENT);
    s.call("TRANSLATEF", 2, 3, 4).call("SCALEF", 2, 4, 8)
        .call("LIGHTFV", GL.LIGHT0 + 2, GL.POSITION, 4, 1, 2, 3, 1)
        .call("LIGHTFV", GL.LIGHT0 + 2, GL.SPOT_DIRECTION, 3, 2, 3, -1, 0)
        .call("CLIP_PLANE", GL.CLIP_PLANE0 + 2, 1, 2, 4, 8)
        .call("TEX_GENFV", GL.S, GL.EYE_PLANE, 4, 1, 2, 4, 8).call("LOAD_IDENTITY");
    compare("position", "LIGHT", GL.LIGHT0 + 2, GL.POSITION);
    compare("direction", "LIGHT", GL.LIGHT0 + 2, GL.SPOT_DIRECTION);
    compare("clip", "CLIP_PLANE", GL.CLIP_PLANE0 + 2, 0, ["double"]);
    compare("eye", "TEX_GEN", GL.S, GL.EYE_PLANE, ["integer", "float", "double"]);
    s.call("LIGHTFV", GL.LIGHT0 + 2, GL.DIFFUSE, 4, 0.5, 0.25, 0, 1);
    compare("light_color", "LIGHT", GL.LIGHT0 + 2, GL.DIFFUSE);
    s.call("MATERIALIV", GL.FRONT_AND_BACK, GL.DIFFUSE, 4, 2147483647, 0, 1073741824, 2147483647);
    compare("material_int", "MATERIAL", GL.BACK, GL.DIFFUSE);
    s.call("LIGHTF", GL.LIGHT0 + 2, GL.SPOT_EXPONENT, 12.75);
    compare("exponent", "LIGHT", GL.LIGHT0 + 2, GL.SPOT_EXPONENT);
    s.call("ACTIVE_TEXTURE", GL.TEXTURE0 + 3).call("TEX_ENVFV", GL.TEXTURE_ENV, GL.TEXTURE_ENV_COLOR, 4, 0.5, 0.25, 0, 1);
    compare("env_color", "TEX_ENV", GL.TEXTURE_ENV, GL.TEXTURE_ENV_COLOR);
    s.call("TEX_ENVIV", GL.TEXTURE_ENV, GL.TEXTURE_ENV_COLOR, 4, 2147483647, 0, 1073741824, 2147483647);
    compare("env_int", "TEX_ENV", GL.TEXTURE_ENV, GL.TEXTURE_ENV_COLOR);
    s.call("TEX_ENVI", GL.TEXTURE_ENV, GL.COMBINE_RGB, GL.INTERPOLATE);
    compare("combine", "TEX_ENV", GL.TEXTURE_ENV, GL.COMBINE_RGB);
    s.call("TEX_ENVF", GL.TEXTURE_FILTER_CONTROL, GL.TEXTURE_LOD_BIAS, 2.75);
    compare("bias", "TEX_ENV", GL.TEXTURE_FILTER_CONTROL, GL.TEXTURE_LOD_BIAS);
    s.call("TEX_ENVI", GL.POINT_SPRITE, GL.COORD_REPLACE, 1);
    compare("replace", "TEX_ENV", GL.POINT_SPRITE, GL.COORD_REPLACE);
    s.call("TEX_GENI", GL.T, GL.TEXTURE_GEN_MODE, GL.SPHERE_MAP);
    compare("gen_mode", "TEX_GEN", GL.T, GL.TEXTURE_GEN_MODE, ["integer", "float", "double"]);
    s.call("ACTIVE_TEXTURE", GL.TEXTURE0); compare("env_unit0", "TEX_ENV", GL.TEXTURE_ENV, GL.TEXTURE_ENV_MODE);
    new GLShadow().process(s.bytes()); for (const [answer, values] of pending) check(answer, values);
});
test("current values and glMaterial remain legal inside Begin/End; tracked material latches colors", () => {
    const s = scene().call("COLOR_MATERIAL", GL.BACK, GL.EMISSION).call("ENABLE", GL.COLOR_MATERIAL)
        .call("BEGIN", GL.TRIANGLES).call("COLOR4F", 0.25, 0.5, 0.75, 1).call("NORMAL3F", 1, 2, 3)
        .call("MATERIALF", GL.FRONT, GL.SHININESS, 37).call("MULTI_TEX_COORD4F", GL.TEXTURE0 + 2, 2, 3, 4, 5).call("END")
        .call("DISABLE", GL.COLOR_MATERIAL).call("COLOR4F", 1, 0, 0, 1);
    const tracked = s.ask(C.V86GL_PARAMETER_MATERIAL, GL.BACK, GL.EMISSION), front = s.ask(C.V86GL_PARAMETER_MATERIAL, GL.FRONT, GL.EMISSION);
    const shiny = s.ask(C.V86GL_PARAMETER_MATERIAL, GL.FRONT, GL.SHININESS), normal = s.ask(0, 0, GL.CURRENT_NORMAL);
    s.call("ACTIVE_TEXTURE", GL.TEXTURE0 + 2); const coord = s.ask(0, 0, GL.CURRENT_TEXTURE_COORDS);
    const shadow = new GLShadow(); shadow.process(s.bytes()); assert.equal(shadow.stats.rejected, 0);
    check(tracked, reference.tracked.float); check(front, [0, 0, 0, 1]); check(shiny, [37]); check(normal, [1, 2, 3]); check(coord, [2, 3, 4, 5]);
    // Apple's glGetMaterialiv for a color-material tracked color truncates
    // the components directly. Follow the specified normalized conversion.
    const next = scene(), integer = next.ask(C.V86GL_PARAMETER_MATERIAL, GL.BACK, GL.EMISSION, C.V86GL_STATE_INTEGER);
    shadow.process(next.bytes()); check(integer, [536870911, 1073741823, 1610612735, 2147483647]);
});
test("integer positions, planes and material shininess keep their unnormalized values", () => {
    const s = scene().call("LIGHTIV", GL.LIGHT0, GL.POSITION, 4, 2, 3, 4, 1)
        .call("MATERIALI", GL.FRONT, GL.SHININESS, 47).call("TEX_GENIV", GL.S, GL.OBJECT_PLANE, 4, 1, 2, 3, 4);
    const pos = s.ask(C.V86GL_PARAMETER_LIGHT, GL.LIGHT0, GL.POSITION), shiny = s.ask(C.V86GL_PARAMETER_MATERIAL, GL.FRONT, GL.SHININESS);
    const plane = s.ask(C.V86GL_PARAMETER_TEX_GEN, GL.S, GL.OBJECT_PLANE);
    new GLShadow().process(s.bytes()); check(pos, [2, 3, 4, 1]); check(shiny, [47]); check(plane, [1, 2, 3, 4]);
});
test("attribute groups and serialized contexts restore fixed-function values independently", () => {
    const first = new GLShadow(), s = scene().call("LIGHTF", GL.LIGHT0, GL.SPOT_EXPONENT, 17)
        .call("TEX_ENVI", GL.TEXTURE_ENV, GL.TEXTURE_ENV_MODE, GL.REPLACE).call("PUSH_ATTRIB", 0x40 | 0x40000 | 1 | 0x1000)
        .call("LIGHTF", GL.LIGHT0, GL.SPOT_EXPONENT, 31).call("TEX_ENVI", GL.TEXTURE_ENV, GL.TEXTURE_ENV_MODE, GL.ADD)
        .call("COLOR4F", 1, 0, 0, 1).call("MULTI_TEX_COORD4F", GL.TEXTURE0, 2, 3, 4, 5).call("CLIP_PLANE", GL.CLIP_PLANE0, 1, 0, 0, 0);
    first.process(s.bytes()); const saved = JSON.parse(JSON.stringify(first.getState())), copy = new GLShadow(); copy.setState(saved);
    assert.deepEqual(copy.getState(), saved);
    const next = scene().call("POP_ATTRIB"), light = next.ask(C.V86GL_PARAMETER_LIGHT, GL.LIGHT0, GL.SPOT_EXPONENT);
    const env = next.ask(C.V86GL_PARAMETER_TEX_ENV, GL.TEXTURE_ENV, GL.TEXTURE_ENV_MODE), color = next.ask(0, 0, GL.CURRENT_COLOR);
    const coord = next.ask(0, 0, GL.CURRENT_TEXTURE_COORDS), clip = next.ask(C.V86GL_PARAMETER_CLIP_PLANE, GL.CLIP_PLANE0, 0);
    copy.process(next.bytes()); check(light, [17]); check(env, [GL.REPLACE]); check(color, [1, 1, 1, 1]); check(coord, [0, 0, 0, 1]); check(clip, [0, 0, 0, 0]);
    for (const [, typed] of saved.typed) delete typed.fixed;
    copy.setState(saved); const old = scene(), defaults = old.ask(C.V86GL_PARAMETER_LIGHT, GL.LIGHT0, GL.SPOT_EXPONENT);
    copy.process(old.bytes()); check(defaults, [0]);
});
test("invalid parameters are tagged before either state machine changes", async () => {
    const s = scene().call("LIGHTF", GL.LIGHT0, GL.SPOT_EXPONENT, 129).call("LIGHTF", GL.LIGHT0 + 8, GL.SPOT_CUTOFF, 45)
        .call("MATERIALF", GL.FRONT, GL.SHININESS, -1).call("LIGHT_MODELI", GL.LIGHT_MODEL_COLOR_CONTROL, 0)
        .call("TEX_ENVI", GL.TEXTURE_ENV, GL.RGB_SCALE, 3).call("TEX_GENI", GL.Q, GL.TEXTURE_GEN_MODE, GL.SPHERE_MAP)
        .call("TEX_ENVI", GL.POINT_SPRITE, GL.COORD_REPLACE, 3).call("LIGHTFV", GL.LIGHT0, GL.POSITION, 2, 1, 2, 3, 4)
        .call("CLIP_PLANE", GL.CLIP_PLANE0 + 6, 1, 2, 3, 4)
        .call("BEGIN", GL.TRIANGLES).call("LIGHTF", GL.LIGHT0, GL.SPOT_CUTOFF, 45).call("END");
    const shadow = new GLShadow(), bytes = s.bytes(); shadow.process(bytes); assert.equal(shadow.stats.rejected, 10);
    const { host } = createFakeHost(), executor = new GLWebGPUExecutor(null, { host }); await executor.initialize(); executor.submit(bytes, {});
    assert.equal(executor.current.lights[0].spotExponent, 0); assert.equal(executor.current.lights[0].spotCutoff, 180);
    assert.equal(executor.current.textureUnits[0].env.rgbScale, 1);
});
test("failed parameter queries preserve output and latch errors; unknown kinds fail on the CPU", () => {
    const s = scene(), a = s.ask(C.V86GL_PARAMETER_LIGHT, GL.LIGHT0 + 8, GL.POSITION);
    const b = s.ask(C.V86GL_PARAMETER_MATERIAL, GL.FRONT_AND_BACK, GL.AMBIENT), c = s.ask(C.V86GL_PARAMETER_TEX_ENV, GL.TEXTURE_ENV, 0xDEAD);
    const small = s.ask(C.V86GL_PARAMETER_LIGHT, GL.LIGHT0, GL.POSITION, C.V86GL_STATE_DOUBLE, 8);
    const unsupported = s.ask(0xFFFF, 0, 0);
    s.call("BEGIN", GL.TRIANGLES); const begin = s.ask(C.V86GL_PARAMETER_CLIP_PLANE, GL.CLIP_PLANE0, 0); s.call("END");
    const shadow = new GLShadow(); shadow.process(s.bytes());
    for (const q of [a, b, c]) { assert.equal(q().status, 2); assert.equal(q().error, GL.INVALID_ENUM); assert.ok(q().untouched); }
    assert.equal(small().error, GL.INVALID_VALUE); assert.ok(small().untouched);
    assert.equal(begin().error, GL.INVALID_OPERATION); assert.ok(begin().untouched);
    assert.equal(unsupported().status, C.V86GL_SYNC_QUERY_STATUS_FAILED); assert.equal(shadow.current.error, GL.INVALID_ENUM);
});
(async () => { for (const { name, fn } of tests) { await fn(); console.log("ok   " + name); } console.log(tests.length + " CPU fixed-function state tests passed"); })()
    .catch(error => { console.error(error); process.exitCode = 1; });
