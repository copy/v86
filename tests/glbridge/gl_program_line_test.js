"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"),
    zlib = require("node:zlib"), { execFileSync } = require("node:child_process");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
for (const part of ["objects", "state", "raster", "fixed", "misc", "stencil_ext", "render", "arrays", "images", "textures", "buffers", "queries", "glsl", "arb"])
    require("../../src/browser/glbridge/gl-webgpu/gl_shadow_" + part + ".js");
const { Glslang } = require("../../src/browser/glbridge/gl-webgpu/gl_glslang.js"),
    { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"), { GLStream } = require("./gl_stream_builder.js"),
    { createFakeHost } = require("./gl_fake_gpu.js"), { cases, setup, draw } = require("./gl_program_line_cases.js"),
    geometry = require("../../src/browser/glbridge/gl-webgpu/gl_program_geometry.js"), { requireNaga } = require("./naga.js");
(async () => {
    const apple = require("./gl_conformance/program_line_reference.json").cases,
        mesa = JSON.parse(zlib.gunzipSync(fs.readFileSync(__dirname + "/gl_conformance/mesa_reference.json.gz"))).fixtures.program_line.cases,
        compiler = new Glslang(fs.readFileSync(__dirname + "/../../bios/glslang.wasm")), codes = new Set([geometry.lineAnalysis]),
        differences = new Set(["glsl_horizontal", "glsl_diagonal", "glsl_wide_stipple", "glsl_strip", "glsl_loop", "glsl_indexed", "glsl_vbo", "glsl_flat", "glsl_cross_w",
            "arb_horizontal", "arb_stipple", "arb_strip", "arb_flat", "glsl_matrix", "glsl_attributes", "glsl_polygon", "glsl_polygon_flat"]);
    assert.deepEqual(apple.map(e => e.name), cases.map(e => e.name));assert.equal(mesa.length, cases.length);
    for (let i = 0; i < cases.length; ++i) {
        assert.equal(apple[i].error, 0, cases[i].name);assert.equal(mesa[i].error, 0, cases[i].name);
        const differs = apple[i].pixels.some((v, c) => Math.abs(v - mesa[i].pixels[c]) > 1);
        assert.equal(differs, differences.has(cases[i].name), cases[i].name + " retained native endpoint/clipping difference");
        if (cases[i].crossW) {
            assert.ok(mesa[i].pixels.every((v, c) => c % 4 === 3 ? v === 255 || v === 0 : v === 0), "raw Mesa transparent-black output at w=0 retained");
            assert.equal(mesa[i].pixels.filter((v, c) => c % 4 === 3 && v === 0).length, 11);
            assert.ok(apple[i].pixels.some((v, c) => c % 4 === 1 && v));
        }
        if (cases[i].polygon && cases[i].stipple) {
            assert.equal(mesa[i].loopPixels.length, 1024);assert.equal(apple[i].loopPixels.length, 1024);
            assert.notDeepEqual(mesa[i].pixels, mesa[i].loopPixels, "direct polygon edge traversal and explicit boundary loop both retained");
        }
    }
    for (const copied of [false, true]) {
        const { host, log } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true });await gpu.initialize();gpu.flushThreshold = 4;
        const cpu = new GLShadow();cpu.setCapabilities(gpu.capabilities());cpu.setGlslang(compiler);
        for (const [i, entry] of cases.entries()) {
            const stream = setup(new GLStream().makeCurrent(1, 0, 0, 16, 16, i + 1, i + 1), entry);draw(stream, entry);
            const memory = stream.bytes(), segments = cpu.process(memory), before = log.draws.length;
            for (const segment of segments || [{ offset: 0, length: memory.length }]) {
                const bytes = segment.bytes || memory.subarray(segment.offset, segment.offset + segment.length);gpu.submit(copied ? bytes.slice() : bytes, {});
            }
            gpu.flushFrame();await gpu.idle();assert.equal(cpu.current.error, 0, entry.name);
            const lines = log.draws.slice(before);assert.equal(lines.length, entry.polygon ? 6 : entry.strip ? 2 : entry.loop ? 3 : 1, entry.name + " primitive order");
            for (const line of lines) {
                assert.equal(line.pipeline.descriptor.primitive.topology, "line-list");assert.equal(line.count, 2);assert.equal(line.instances, entry.width);
                assert.equal(line.pipeline.descriptor.vertex.buffers.length, 0, "application attributes arrive through canonical storage without reserving a slot");
            }
        }
        const count = 600, data = new Float32Array((count + 1) * 4);for (let i = 0; i <= count; ++i) data.set([i % 2 ? 0.125 : 0, 0, 0, 1], i * 4);
        const packed = { count: count + 1, data, stride: 4, layout: [{ location: 0, components: 4, offsetFloats: 0 }] },
            segments = Array.from({ length: count }, (_, i) => ({ a: i, b: i + 1, restart: i === 0 || i === 300 })), result = gpu.captureLineDistances(packed, segments);
        gpu.flushFrame();await gpu.idle();assert.equal(result.destroyed, false, "distance owner survives chunk and upload flushes");
        gpu.retire(result);gpu.flushFrame();await gpu.idle();assert.equal(result.destroyed, true);
        for (const module of log.modules) if (module.code.includes("gl_line_vertex_entry") || module.code.includes("gl_line_fragment_entry")) codes.add(module.code);
        assert.equal(gpu.stats.refusals, 0);assert.equal(gpu.hostErrors.length, 0);assert.equal(gpu.gpuErrors.errors.length, 0);
    }
    const naga = requireNaga("gl_program_line_test");if (naga) {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gl-program-lines-"));
        try { let i = 0;for (const code of codes) { const file = path.join(directory, i++ + ".wgsl");fs.writeFileSync(file, code);execFileSync(naga, [file], { stdio: "pipe" }); } }
        finally { fs.rmSync(directory, { recursive: true, force: true }); }
    }
    console.log("gl_program_line_test: 22 native cases, replicated line width, continuous stipple, flat/polygon geometry, bounded prefix ownership and generated WGSL in both modes passed");
})().catch(error => {console.error(String(error.stack || error));process.exitCode = 1;});
