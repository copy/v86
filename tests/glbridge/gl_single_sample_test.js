"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"),
    zlib = require("node:zlib"), { execFileSync } = require("node:child_process");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
for (const part of ["objects", "state", "raster", "fixed", "misc", "stencil_ext", "render", "arrays", "images", "textures", "buffers", "queries", "glsl", "arb"])
    require("../../src/browser/glbridge/gl-webgpu/gl_shadow_" + part + ".js");
const { Glslang } = require("../../src/browser/glbridge/gl-webgpu/gl_glslang.js"),
    { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"), { GLStream, GL } = require("./gl_stream_builder.js"),
    { createFakeHost } = require("./gl_fake_gpu.js"), { cases, scene } = require("./gl_single_sample_cases.js"),
    { requireNaga } = require("./naga.js");
(async () => {
    const apple = require("./gl_conformance/single_sample_reference.json").cases,
        mesa = JSON.parse(zlib.gunzipSync(fs.readFileSync(__dirname + "/gl_conformance/mesa_reference.json.gz"))).fixtures.single_sample.cases,
        compiler = new Glslang(fs.readFileSync(__dirname + "/../../bios/glslang.wasm")), codes = new Set();
    for (const reference of [apple, mesa]) {
        assert.deepEqual(reference.map(e => e.name), cases.flatMap(name => [name, name]));
        for (let i = 0; i < reference.length; i += 2) {
            const single = reference[i], multi = reference[i + 1];assert.equal(single.error, 0);assert.equal(multi.error, 0);
            for (const field of ["pixels", "depth", "stencil"]) assert.deepEqual(multi[field], single[field], single.name + " native full coverage " + field);
        }
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
        for (const [i, name] of cases.entries()) {
            send(scene(new GLStream().makeCurrent(1, 0, 0, 16, 16, i + 1, i + 1, 4 << 8), name));gpu.flushFrame();await gpu.idle();
        }
        const original = gpu.limits;gpu.limits = new Proxy(original, { get: (target, key) => key === "maxStorageBufferBindingSize" ? 256 : Reflect.get(target, key, target) });
        send(scene(new GLStream().makeCurrent(1, 0, 0, 16, 16, 100, 100, 4 << 8), "blend"));gpu.flushFrame();await gpu.idle();gpu.limits = original;
        const coverage = log.buffers.filter(b => b.descriptor.label === "GL center-sample coverage");assert.ok(coverage.some(b => b.size === 256), "large metadata is tiled to the binding budget");
        assert.ok(coverage.every(b => b.destroyed));
        assert.ok(log.textures.filter(t => /GL center-sample|GL per-sample logic destination/.test(t.descriptor.label || "")).every(t => t.destroyed), "all temporary targets retire");
        const composite = log.draws.filter(d => d.pipeline.descriptor.label === "GL center fragment to all samples");
        assert.ok(composite.length > 0);assert.ok(composite.every(d => d.pipeline.descriptor.multisample.count === 4 && !d.pipeline.descriptor.multisample.alphaToCoverageEnabled));
        assert.ok(log.draws.some(d => d.pipeline.descriptor.label === "GL per-sample logic copy"), "logic uses each destination sample");
        for (const module of log.modules) if (/gl_single_|single_depth|SingleOut|CopyOut/.test(module.code)) codes.add(module.code);
        assert.equal(gpu.stats.refusals, 0);assert.equal(gpu.hostErrors.length, 0);assert.equal(gpu.gpuErrors.errors.length, 0);
    }
    const naga = requireNaga("gl_single_sample_test");
    if (naga) {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gl-single-sample-"));
        try { let i = 0;for (const code of codes) { const file = path.join(directory, i++ + ".wgsl");fs.writeFileSync(file, code);execFileSync(naga, [file], { stdio: "pipe" }); } }
        finally { fs.rmSync(directory, { recursive: true, force: true }); }
    }
    console.log("gl_single_sample_test: native single/four sample cases, bounded coverage tiles, per-sample composite, complete retirement and generated WGSL in both modes passed");
})().catch(error => {console.error(String(error.stack || error));process.exitCode = 1;});
