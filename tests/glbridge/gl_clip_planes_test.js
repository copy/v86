"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"),
    zlib = require("node:zlib"), { execFileSync } = require("node:child_process");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
for (const part of ["objects", "state", "raster", "fixed", "misc", "stencil_ext", "render", "arrays", "images", "textures", "buffers", "queries", "glsl", "arb"])
    require("../../src/browser/glbridge/gl-webgpu/gl_shadow_" + part + ".js");
const { Glslang } = require("../../src/browser/glbridge/gl-webgpu/gl_glslang.js"),
    { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"), { GLStream, GL } = require("./gl_stream_builder.js"),
    { createFakeHost } = require("./gl_fake_gpu.js"), { cases, setup, draw, equations, stress } = require("./gl_clip_planes_cases.js"), { requireNaga } = require("./naga.js");
(async () => {
    const apple = require("./gl_conformance/clip_planes_reference.json").cases,
        mesa = JSON.parse(zlib.gunzipSync(fs.readFileSync(__dirname + "/gl_conformance/mesa_reference.json.gz"))).fixtures.clip_planes.cases,
        compiler = new Glslang(fs.readFileSync(__dirname + "/../../bios/glslang.wasm")), codes = new Set();
    assert.deepEqual(apple.map(e => e.name), cases.map(e => e.name));assert.equal(mesa.length, cases.length);
    for (let i = 0; i < cases.length; ++i) {
        assert.equal(apple[i].error, 0, cases[i].name);assert.equal(mesa[i].error, 0, cases[i].name);
        if (cases[i].ignored) {
            // ARB_vertex_program section 2.11 treats client planes as disabled
            // without ARB_position_invariant. Preserve Mesa's contrary output.
            assert.ok(mesa[i].rows.every(n => n === 0));assert.ok(apple[i].rows.some(n => n === 16380));
        } else assert.deepEqual(apple[i].rows, mesa[i].rows, cases[i].name + " native agreement");
    }
    const translator = require("../../src/browser/glbridge/gl-webgpu/gl_shader_translator.js"),
        vertex = translator.compileShader("void main(){gl_Position=gl_Vertex;gl_ClipVertex=gl_Vertex;gl_FrontColor=gl_Color;}", "vertex"),
        fragment = translator.compileShader("void main(){gl_FragColor=gl_Color;}", "fragment"),
        first = translator.linkProgram(vertex, fragment, { variant: { clipPlaneCount: 6, clipPlaneMask: 32 } }),
        second = translator.linkProgram(vertex, fragment, { variant: { clipPlaneCount: 6, clipPlaneMask: 33 } });
    assert.ok(first.ok && second.ok);assert.notEqual(first.wgslVertex, second.wgslVertex);
    assert.notEqual(first.cacheKey, second.cacheKey, "distinct enabled planes produce distinct reusable shader identities");
    for (const copied of [false, true]) {
        const { host, log } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true });await gpu.initialize();
        const cpu = new GLShadow();cpu.setCapabilities(gpu.capabilities());cpu.setGlslang(compiler);
        const send = stream => {
            const memory = stream.bytes(), segments = cpu.process(memory);
            for (const segment of segments || [{ offset: 0, length: memory.length }]) {
                const bytes = segment.bytes || memory.subarray(segment.offset, segment.offset + segment.length);gpu.submit(copied ? bytes.slice() : bytes, {});
            }
            assert.equal(cpu.current.error, 0);
        };
        for (const [i, entry] of cases.entries()) {
            const stream = setup(new GLStream().makeCurrent(1, 0, 0, 16, 16, i + 1, i + 1), entry);send(draw(stream, entry));gpu.flushFrame();await gpu.idle();
            assert.equal(gpu.currentVariant().clipPlaneMask, entry.mask, "public enables survive ARB suppression");
            const shaders = gpu.resolveShaders(), snapshot = gpu.stateSnapshot(shaders);
            assert.deepEqual(Array.from(snapshot.clipPlanes[0]), equations(entry)[0], "inactive builtin equation remains stored");
            if (entry.ignored) assert.ok(gpu.current.enabled.has(GL.CLIP_PLANE0 + 5));
        }
        send(stress(new GLStream().makeCurrent(1, 0, 0, 16, 16, 100, 100)));gpu.flushFrame();await gpu.idle();
        for (const module of log.modules) codes.add(module.code);
        assert.equal(gpu.stats.refusals, 0);assert.equal(gpu.hostErrors.length, 0);assert.equal(gpu.gpuErrors.errors.length, 0);
    }
    const naga = requireNaga("gl_clip_planes_test");if (naga) {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gl-clip-planes-"));
        try { let i = 0;for (const code of codes) { const file = path.join(directory, i++ + ".wgsl");fs.writeFileSync(file, code);execFileSync(naga, [file], { stdio: "pipe" }); } }
        finally { fs.rmSync(directory, { recursive: true, force: true }); }
    }
    console.log("gl_clip_planes_test: 22 native scenes, six distances, homogeneous w, enable masks, inactive equations, ARB invariance and all 16 varying slots in both modes passed");
})().catch(error => {console.error(String(error.stack || error));process.exitCode = 1;});
