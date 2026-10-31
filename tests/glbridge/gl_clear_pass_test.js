"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"),
    zlib = require("node:zlib"), { execFileSync } = require("node:child_process");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
for (const part of ["objects", "state", "raster", "fixed", "misc", "stencil_ext", "render", "arrays", "images", "textures", "buffers", "queries", "glsl", "arb"])
    require("../../src/browser/glbridge/gl-webgpu/gl_shadow_" + part + ".js");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"), { GLStream, GL } = require("./gl_stream_builder.js"),
    { createFakeHost } = require("./gl_fake_gpu.js"), { names, setup, draw, scene } = require("./gl_clear_pass_cases.js"),
    { requireNaga } = require("./naga.js");
(async () => {
    const apple = require("./gl_conformance/clear_pass_reference.json").cases,
        mesa = JSON.parse(zlib.gunzipSync(fs.readFileSync(__dirname + "/gl_conformance/mesa_reference.json.gz"))).fixtures.clear_pass.cases, codes = new Set();
    assert.deepEqual(apple.map(e => e.name), names);assert.deepEqual(mesa.map(e => e.name), names);
    for (let i = 0; i < names.length; ++i) {
        assert.equal(apple[i].error, 0);assert.equal(mesa[i].error, 0);
        assert.ok(apple[i].pixels.every((v, c) => Math.abs(v - mesa[i].pixels[c]) <= 1), names[i]);assert.deepEqual(apple[i].stencil, mesa[i].stencil);
        assert.equal(!!apple[i].samples, i === 4);assert.equal(!!mesa[i].samples, i === 4);
    }
    for (const copied of [false, true]) {
        const { host, log } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true });await gpu.initialize();gpu.flushThreshold = 100000;
        const cpu = new GLShadow();cpu.setCapabilities(gpu.capabilities());
        const send = s => {
            const memory = s.bytes(), segments = cpu.process(memory);
            for (const segment of segments || [{ offset: 0, length: memory.length }]) {
                const bytes = segment.bytes || memory.subarray(segment.offset, segment.offset + segment.length);gpu.submit(copied ? bytes.slice() : bytes, {});
            }
            assert.equal(cpu.current.error, 0);
        };
        for (const [i, name] of names.entries()) {
            const first = log.draws.length, passes = log.passes.length;send(scene(new GLStream().makeCurrent(1, 0, 0, 16, 16, i + 1, i + 1), name));
            const draws = log.draws.slice(first);assert.equal(new Set(draws.map(d => d.pass)).size, 1, name + " keeps its draws in one pass");
            if (i === 0) {
                assert.equal(log.passes.length - passes, 1);assert.equal(draws.length, 18);
                assert.equal(new Set(draws.filter(d => d.pipeline.descriptor.label === "GL clear pipeline").map(d => d.pipeline)).size, 1, "clear colors do not produce pipelines");
                assert.equal(log.bindGroups.filter(g => g.descriptor.entries.length === 1 && g.descriptor.entries[0].resource.size === 32).length, 1, "attribute restore preserves the compatible clear bind group");
            }
            if (i >= 2) {
                const calls = draws[0].pass.calls.filter(c => c[0] === "beginQuery");assert.equal(calls.length, i === 2 ? 0 : 2);
                assert.equal(new Set(calls.map(c => c[1])).size, calls.length, "query segments never reuse a slot in the same pass");
                const query = [...gpu.queries.values()].at(-1);assert.equal(query.pendingSegments, i === 2 ? 0 : 2);
            }
            gpu.flushFrame();await gpu.idle();
        }
        let presented = 0;gpu.presentToCanvas = () => {++presented;return true;};
        const s = setup(new GLStream().makeCurrent(1, 0, 0, 16, 16, 20, 20)).call("DRAW_BUFFER", GL.FRONT).call("PUSH_ATTRIB", GL.COLOR_BUFFER_BIT).call("DRAW_BUFFER", GL.BACK);
        draw(s.call("COLOR4F", 0, 0, 1, 1)).call("POP_ATTRIB");draw(s.call("COLOR4F", 1, 0, 0, 1)).call("FLUSH");send(s);assert.equal(presented, 1, "restored FRONT buffer presents even when the physical target did not change");
        for (const module of log.modules) if (module.code.includes("glClearValues")) codes.add(module.code);
        gpu.flushFrame();await gpu.idle();assert.equal(gpu.stats.refusals, 0);assert.equal(gpu.hostErrors.length, 0);assert.equal(gpu.gpuErrors.errors.length, 0);
    }
    const naga = requireNaga("gl_clear_pass_test");
    if (naga) {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gl-clear-pass-"));
        try { let i = 0;for (const code of codes) { const file = path.join(directory, i++ + ".wgsl");fs.writeFileSync(file, code);execFileSync(naga, [file], { stdio: "pipe" }); } }
        finally { fs.rmSync(directory, { recursive: true, force: true }); }
    }
    console.log("gl_clear_pass_test: five dual-native scenes, one-pass color changes/attribute restores, query suspension, distinct slots, FRONT restore and WGSL passed in both modes");
})().catch(error => {console.error(String(error.stack || error));process.exitCode = 1;});
