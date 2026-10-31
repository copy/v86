"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"),
    zlib = require("node:zlib"), { execFileSync } = require("node:child_process");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
for (const part of ["objects", "state", "raster", "fixed", "misc", "stencil_ext", "render", "arrays", "images", "textures", "buffers", "queries", "glsl", "arb"])
    require("../../src/browser/glbridge/gl-webgpu/gl_shadow_" + part + ".js");
const { Glslang } = require("../../src/browser/glbridge/gl-webgpu/gl_glslang.js"),
    { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"), { GLStream } = require("./gl_stream_builder.js"),
    { createFakeHost } = require("./gl_fake_gpu.js"), { cases, setup, draw } = require("./gl_program_polygon_cases.js"),
    { requireNaga } = require("./naga.js");
(async () => {
    const apple = require("./gl_conformance/program_polygon_reference.json").cases,
        mesa = JSON.parse(zlib.gunzipSync(fs.readFileSync(__dirname + "/gl_conformance/mesa_reference.json.gz"))).fixtures.program_polygon.cases,
        compiler = new Glslang(fs.readFileSync(__dirname + "/../../bios/glslang.wasm")), codes = new Set();
    assert.deepEqual(apple.map(e => e.name), cases.map(e => e.name));assert.equal(mesa.length, cases.length);
    for (let i = 0; i < cases.length; ++i) {
        assert.equal(apple[i].error, 0, cases[i].name);assert.equal(mesa[i].error, 0, cases[i].name);
        for (let probe = 0; probe < 3; ++probe) {
            assert.ok(apple[i].rgba[probe].every((v, c) => Math.abs(v - mesa[i].rgba[probe][c]) <= 1), cases[i].name + " native agreement");
            assert.deepEqual(mesa[i].direct[probe], mesa[i].rgba[probe], cases[i].name + " Mesa direct/explicit agreement");
        }
        if (cases[i].name === "glsl_blend_order") assert.notDeepEqual(apple[i].direct, apple[i].rgba, "retained Apple mixed-mode blend difference");
        else assert.deepEqual(apple[i].direct, apple[i].rgba);
    }
    for (const copied of [false, true]) {
        const { host, log } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true });await gpu.initialize();
        const cpu = new GLShadow();cpu.setCapabilities(gpu.capabilities());cpu.setGlslang(compiler);gpu.flushThreshold = 4;
        const send = s => {
            const memory = s.bytes(), segments = cpu.process(memory);
            for (const segment of segments || [{ offset: 0, length: memory.length }]) {
                const bytes = segment.bytes || memory.subarray(segment.offset, segment.offset + segment.length);gpu.submit(copied ? bytes.slice() : bytes, {});
            }
            assert.equal(cpu.current.error, 0);
        };
        for (const [i, entry] of cases.entries()) {
            const stream = setup(new GLStream().makeCurrent(1, 0, 0, 16, 16, i + 1, i + 1), entry);send(draw(stream, entry));gpu.flushFrame();await gpu.idle();
            if (entry.matrix) {
                const attributes = gpu.wantedAttributes(gpu.currentProgramObject()).filter(a => a.location >= 8);
                assert.deepEqual(attributes.map(a => a.location), Array.from({ length: entry.matrix }, (_, column) => 8 + column));
                assert.ok(attributes.every(a => a.components === entry.matrix));
            }
        }
        send(setup(new GLStream().makeCurrent(1, 0, 0, 16, 16, 100, 100), cases[0]));
        const count = 9000, data = new Float32Array(count * 4);for (let i = 3; i < data.length; i += 4) data[i] = 1;
        const packed = { count, data, stride: 4, layout: [{ location: 0, components: 4, offsetFloats: 0 }] },
            result = gpu.capturePolygonOutputs(packed).buffer;
        gpu.flushFrame();await gpu.idle();assert.equal(result.destroyed, false, "captured outputs survive staging submissions until the draw owner retires them");
        const inputs = log.buffers.filter(b => b.descriptor.label === "GL clip capture input");
        assert.ok(inputs.length >= 36);assert.ok(inputs.every(b => b.size <= 65536 && b.destroyed), "bounded input pages retire after submission");
        gpu.retire(result);gpu.flushFrame();await gpu.idle();assert.equal(result.destroyed, true);
        for (const module of log.modules) if (module.code.includes("gl_clip_")) codes.add(module.code);
        assert.equal(gpu.stats.refusals, 0);assert.equal(gpu.hostErrors.length, 0);assert.equal(gpu.gpuErrors.errors.length, 0);
    }
    const naga = requireNaga("gl_program_polygon_test");
    if (naga) {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gl-program-polygons-"));
        try { let i = 0;for (const code of codes) { const file = path.join(directory, i++ + ".wgsl");fs.writeFileSync(file, code);execFileSync(naga, [file], { stdio: "pipe" }); } }
        finally { fs.rmSync(directory, { recursive: true, force: true }); }
    }
    console.log("gl_program_polygon_test: 32 native cases, matrix attributes, bounded GPU output capture, result lifetime and generated WGSL in both modes passed");
})().catch(error => {console.error(String(error.stack || error));process.exitCode = 1;});
