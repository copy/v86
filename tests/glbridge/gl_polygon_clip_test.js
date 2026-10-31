"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"),
    zlib = require("node:zlib"), { execFileSync } = require("node:child_process");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
for (const part of ["objects", "state", "raster", "fixed", "misc", "stencil_ext", "render", "arrays", "images", "textures", "buffers", "queries", "glsl", "arb"])
    require("../../src/browser/glbridge/gl-webgpu/gl_shadow_" + part + ".js");
const { Glslang } = require("../../src/browser/glbridge/gl-webgpu/gl_glslang.js"),
    { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"), { GLStream, GL } = require("./gl_stream_builder.js"),
    { createFakeHost } = require("./gl_fake_gpu.js"), { cases, setup, draw } = require("./gl_polygon_clip_cases.js"),
    { requireNaga } = require("./naga.js");
(async () => {
    const apple = require("./gl_conformance/polygon_clip_reference.json"),
        mesa = JSON.parse(zlib.gunzipSync(fs.readFileSync(__dirname + "/gl_conformance/mesa_reference.json.gz"))).fixtures.polygon_clip,
        compiler = new Glslang(fs.readFileSync(__dirname + "/../../bios/glslang.wasm")), codes = new Set();
    for (const reference of [apple, mesa]) {
        assert.equal(reference.clipInset, 1 / 65536);assert.deepEqual(reference.cases.map(e => e.name), cases.map(e => e.name));
        for (const entry of reference.cases) {
            assert.equal(entry.error, 0, entry.name);assert.equal(entry.strictError, 0, entry.name);
            assert.equal(entry.pixels.length, 1024);assert.equal(entry.strictPixels.length, 1024);
        }
    }
    const pixel = (name, x, y) => mesa.cases.find(e => e.name === name).strictPixels.slice((y * 16 + x) * 4, (y * 16 + x) * 4 + 4);
    assert.deepEqual(pixel("fixed_view_line", 15, 8), [0, 255, 0, 255], "new frustum boundary is rasterized");
    assert.deepEqual(pixel("glsl_nonlinear_point", 8, 8), [0, 83, 0, 255], "interpolate vertex outputs instead of re-running the vertex shader at a new position");
    assert.deepEqual(pixel("fixed_clipped_provoking", 15, 8), [0, 182, 0, 255], "a clipped-away provoking vertex still supplies flat lighting");
    assert.notDeepEqual(mesa.cases[0].pixels, mesa.cases[0].strictPixels, "retain native guard-band behavior separately from the forced-clipping reference");
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
            send(draw(setup(new GLStream().makeCurrent(1, 0, 0, 16, 16, i + 1, i + 1), entry), entry));gpu.flushFrame();await gpu.idle();
        }
        assert.ok(log.draws.some(d => d.indirect), "clipped counts stay GPU-owned");
        send(setup(new GLStream().makeCurrent(1, 0, 0, 16, 16, 100, 100), { glsl: true }).call("POLYGON_MODE", GL.FRONT_AND_BACK, GL.LINE));
        const original = gpu.limits;gpu.limits = new Proxy(original, { get: (target, key) => key === "maxStorageBufferBindingSize" ? 4096 : Reflect.get(target, key, target) });
        const count = 300, data = new Float32Array(count * 8), faces = { vertices: [], starts: [0], provoking: [], boundary: [] };
        for (let i = 0; i < count; ++i) {
            data.set([i % 3 === 1 ? 3 : -.75, i % 3 === 2 ? .75 : -.75, 0, 1, 0, 1, 0, 1], i * 8);
            faces.vertices.push(i);faces.boundary.push(1);if (i % 3 === 2) { faces.starts.push(i + 1);faces.provoking.push(i); }
        }
        const before = log.buffers.length;
        gpu.drawClippedPolygons({ cpu: { count, data, stride: 8, layout: [{ location: 0, components: 4, offsetFloats: 0 }, { location: 3, components: 4, offsetFloats: 4 }] }, vertexCount: count, buffers: [] }, faces);
        gpu.flushFrame();await gpu.idle();gpu.limits = original;
        const captures = log.buffers.slice(before).filter(b => b.descriptor.label === "GL captured polygon outputs");
        assert.ok(captures.length > 1, "oversized draws are split at polygon boundaries");assert.ok(captures.every(b => b.size <= 4096));
        for (const label of ["GL captured polygon outputs", "GL clip capture input", "GL clipped polygon A", "GL clipped polygon B", "GL clipped polygon indirect"]) {
            const buffers = log.buffers.filter(b => b.descriptor.label === label);assert.ok(buffers.length > 0, label);
            assert.ok(buffers.every(b => b.destroyed), label + " retires after the final submitted consumer");
        }
        for (const module of log.modules) if (module.code.includes("gl_clip_")) codes.add(module.code);
        assert.equal(gpu.stats.refusals, 0);assert.equal(gpu.hostErrors.length, 0);assert.equal(gpu.gpuErrors.errors.length, 0);
    }
    const naga = requireNaga("gl_polygon_clip_test");
    if (naga) {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gl-polygon-clip-"));
        try { let i = 0;for (const code of codes) { const file = path.join(directory, i++ + ".wgsl");fs.writeFileSync(file, code);execFileSync(naga, [file], { stdio: "pipe" }); } }
        finally { fs.rmSync(directory, { recursive: true, force: true }); }
    }
    console.log("gl_polygon_clip_test: 34 native references, bounded polygon batches, indirect ownership, complete retirement and generated WGSL in both modes passed");
})().catch(error => {console.error(String(error.stack || error));process.exitCode = 1;});
