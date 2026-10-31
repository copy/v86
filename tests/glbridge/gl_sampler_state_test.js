"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), zlib = require("node:zlib");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
for (const part of ["objects", "state", "raster", "fixed", "misc", "stencil_ext", "render", "arrays", "images", "textures", "buffers", "queries", "glsl", "arb"])
    require("../../src/browser/glbridge/gl-webgpu/gl_shadow_" + part + ".js");
const { Glslang } = require("../../src/browser/glbridge/gl-webgpu/gl_glslang.js"),
    { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"), { GLStream } = require("./gl_stream_builder.js"),
    { createFakeHost } = require("./gl_fake_gpu.js"), { names, setup, draw, expected } = require("./gl_sampler_state_cases.js"),
    P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
(async () => {
    const apple = require("./gl_conformance/sampler_state_reference.json").cases,
        mesa = JSON.parse(zlib.gunzipSync(fs.readFileSync(__dirname + "/gl_conformance/mesa_reference.json.gz"))).fixtures.sampler_state.cases,
        compiler = new Glslang(fs.readFileSync(__dirname + "/../../bios/glslang.wasm"));
    assert.deepEqual(apple.map(e => e.name), names);assert.equal(mesa.length, names.length);
    for (let i = 0; i < names.length; ++i) {
        assert.equal(apple[i].error, 0, names[i]);assert.equal(mesa[i].error, 0, names[i]);
        if (names[i] === "glsl_shadow_clamp") assert.deepEqual(apple[i].rgba, [255, 255, 255, 255], "retained Apple reference-clamping difference");
        assert.ok(expected(apple[i]).every((v, c) => Math.abs(v - mesa[i].rgba[c]) <= 1), names[i] + " native agreement");
    }
    for (const copied of [false, true]) {
        const { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true });await gpu.initialize();
        const cpu = new GLShadow();cpu.setCapabilities(gpu.capabilities());cpu.setGlslang(compiler);
        const send = s => {
            const memory = s.bytes(), segments = cpu.process(memory);
            for (const segment of segments || [{ offset: 0, length: memory.length }]) {
                const bytes = segment.bytes || memory.subarray(segment.offset, segment.offset + segment.length);gpu.submit(copied ? bytes.slice() : bytes, {});
            }
            assert.equal(cpu.current.error, 0);
        };
        send(new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1));
        for (const name of names) {
            const initial = new GLStream(), { location, unit } = setup(initial, name);send(initial);
            const stream = new GLStream();if (location) stream.uniformiv(location.view.getInt32(P.F.QUERY_LOCATION.result, true), 1, 1, [unit]);
            send(draw(stream, name));gpu.flushFrame();await gpu.idle();
            const shaders = gpu.resolveShaders(), snapshot = gpu.stateSnapshot(shaders);
            if (name === "glsl_target") assert.equal(snapshot.samplerState[4], 0x812D, "sampler2D state ignores enabled 3D target");
            if (name === "glsl_param") assert.deepEqual(Array.from(snapshot.samplerState.subarray(0, 4)), [1, 1, 0, 1], "function parameter retains its unit-3 border");
            if (name === "glsl_array") assert.deepEqual(Array.from(snapshot.samplerState.subarray(16, 20)), [1, 1, 0, 1], "sampler array element has independent state");
            if (name === "glsl_bias_sum") assert.equal(snapshot.samplerState[11], 32, "biases are clamped only after shader bias is added");
            if (name === "fixed_nonmip") {
                const object = gpu.current.shareGroup.textures.get(names.indexOf(name) + 100);
                assert.equal(object.gpuLevels, 3, "all images remain allocated");
                assert.equal(gpu.textureViewFor(object, { target: "2D", shadow: false }).options.mipLevelCount, 1, "non-mip sampling view selects only its base image");
            }
        }
        assert.equal(gpu.stats.refusals, 0);assert.equal(gpu.hostErrors.length, 0);assert.equal(gpu.gpuErrors.errors.length, 0);
    }
    console.log("gl_sampler_state_test: native border/LOD cases, typed targets, parameter/array identity, single bias clamp and non-mip views in both modes passed");
})().catch(error => {console.error(error);process.exitCode = 1;});
