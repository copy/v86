"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"),
    zlib = require("node:zlib"), { execFileSync } = require("node:child_process");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
for (const part of ["objects", "state", "raster", "fixed", "misc", "stencil_ext", "render", "arrays", "images", "textures", "buffers", "queries", "glsl", "arb"])
    require("../../src/browser/glbridge/gl-webgpu/gl_shadow_" + part + ".js");
const { Glslang } = require("../../src/browser/glbridge/gl-webgpu/gl_glslang.js"),
    { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"), { GLStream, GL } = require("./gl_stream_builder.js"),
    { createFakeHost } = require("./gl_fake_gpu.js"), { names, scene } = require("./gl_s3_render_cases.js"),
    { requireNaga } = require("./naga.js");
(async () => {
    const apple = require("./gl_conformance/s3_render_reference.json").cases,
        mesa = JSON.parse(zlib.gunzipSync(fs.readFileSync(__dirname + "/gl_conformance/mesa_reference.json.gz"))).fixtures.s3_render.cases,
        compiler = new Glslang(fs.readFileSync(__dirname + "/../../bios/glslang.wasm")), codes = new Set(),
        nativeDifferences = new Set(["fog_singular_below", "fog_singular_above", "eye_homogeneous_lighting", "stipple_fill"]);
    assert.deepEqual(apple.map(e => e.name), names);assert.deepEqual(mesa.map(e => e.name), names);
    for (let i = 0; i < names.length; ++i) {
        assert.equal(apple[i].error, 0);assert.equal(mesa[i].error, 0);
        if (!nativeDifferences.has(names[i])) assert.ok(apple[i].rgba.every((v, c) => Math.abs(v - mesa[i].rgba[c]) <= 1), names[i]);
    }
    assert.deepEqual(apple[6].rgba, apple[7].rgba, "equivalent normalized eye/light positions");
    assert.deepEqual(apple[12].rgba, [255, 255, 255, 255], "RGB DXT1 selector three is opaque");
    assert.deepEqual(apple[4].rgba, [0, 180, 0, 255], "directional lights do apply their spot term");
    assert.deepEqual(apple[10].rgba, [128, 0, 0, 128]);assert.deepEqual(apple[11].rgba, [34, 68, 153, 255]);
    for (const copied of [false, true]) {
        const { host, log } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true });await gpu.initialize();
        const cpu = new GLShadow();cpu.setCapabilities(gpu.capabilities());cpu.setGlslang(compiler);
        for (const [i, name] of names.entries()) {
            const memory = scene(new GLStream().makeCurrent(1, 0, 0, 16, 16, i + 1, i + 1), name).bytes(), segments = cpu.process(memory);
            for (const segment of segments || [{ offset: 0, length: memory.length }]) {
                const bytes = segment.bytes || memory.subarray(segment.offset, segment.offset + segment.length);gpu.submit(copied ? bytes.slice() : bytes, {});
            }
            assert.equal(cpu.current.error, 0, name);gpu.flushFrame();await gpu.idle();
        }
        for (const module of log.modules) if (/eyePosition|samplerState/.test(module.code)) codes.add(module.code);
        assert.equal(gpu.stats.refusals, 1);assert.equal(gpu.stats.refusalsByOp["glGenerateMipmap:a compressed level cannot be downsampled"], 1, "D-23 compressed mip generation refusal");
        const original = gpu.limits;gpu.limits = new Proxy(original, { get: (target, key) => key === "maxStorageBufferBindingSize" ? 256 : Reflect.get(target, key, target) });
        const data = new Float32Array(9 * 4);for (let i = 3; i < data.length; i += 4) data[i] = 1;
        gpu.drawClippedPolygons({ cpu: { count: 9, data, stride: 4, layout: [{ location: 0, components: 4, offsetFloats: 0 }] }, vertexCount: 9, buffers: [] },
            { vertices: Array.from({ length: 9 }, (_, i) => i), starts: [0, 9], provoking: [8], boundary: Array(9).fill(1) });
        gpu.limits = original;assert.equal(gpu.stats.refusalsByOp["polygon capture:one polygon exceeds the available temporary GPU storage"], 1, "D-24 a single over-budget polygon is explicitly refused before unbounded allocation");
        assert.equal(gpu.stats.refusals, 2);assert.equal(gpu.hostErrors.length, 0);assert.equal(gpu.gpuErrors.errors.length, 0);
    }
    const naga = requireNaga("gl_s3_render_test");
    if (naga) {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gl-s3-render-"));
        try { let i = 0;for (const code of codes) { const file = path.join(directory, i++ + ".wgsl");fs.writeFileSync(file, code);execFileSync(naga, [file], { stdio: "pipe" }); } }
        finally { fs.rmSync(directory, { recursive: true, force: true }); }
    }
    console.log("gl_s3_render_test: 20 native audit scenes, homogeneous lighting, opaque RGB DXT1, stipple scope, explicit native differences and generated WGSL in both modes passed");
})().catch(error => {console.error(String(error.stack || error));process.exitCode = 1;});
