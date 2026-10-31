"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
for (const part of ["objects", "state", "raster", "fixed", "misc", "render", "arrays", "images", "textures", "glsl", "arb"])
    require("../../src/browser/glbridge/gl-webgpu/gl_shadow_" + part + ".js");
const { Glslang } = require("../../src/browser/glbridge/gl-webgpu/gl_glslang.js"), { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"),
    { CacheKeys } = require("../../src/browser/glbridge/gl-webgpu/gl_cache_keys.js"), { createFakeHost } = require("./gl_fake_gpu.js"), { GLStream, GL } = require("./gl_stream_builder.js");
(async () => {
    const compiler = new Glslang(fs.readFileSync(__dirname + "/../../bios/glslang.wasm"));
    const keys = new CacheKeys(() => 0), a = keys.key(["first"]);keys.clearKeys(true);assert.equal(keys.atoms.size, 0);assert.equal(keys.entryCount, 0);
    const b = keys.key(["second"]);assert.notEqual(a, b, "trim never reuses a live compiler variant ID");assert.notEqual(keys.key(["third"]), b, "collisions still compare full descriptors");
    for (const copied of [false, true]) {
        const { host, log } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true });await gpu.initialize();
        const cpu = new GLShadow();cpu.setGlslang(compiler);cpu.setCapabilities(gpu.capabilities());
        const send = s => {const memory = s.bytes(), segments = cpu.process(memory);for (const segment of segments || [{ offset: 0, length: memory.length }]) {const bytes = segment.bytes || memory.subarray(segment.offset, segment.offset + segment.length);gpu.submit(copied ? bytes.slice() : bytes, {});}assert.equal(cpu.current.error, 0);};
        send(new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1));
        const module = gpu.shaderModule("// original\n@vertex fn vs_main()->@builtin(position) vec4f{return vec4f(0);}");
        for (let i = 0; i < 600; ++i) gpu.shaderModule("// " + i + "\n@vertex fn vs_main()->@builtin(position) vec4f{return vec4f(0);}");
        assert.equal(gpu.moduleCache.size, 512);assert.ok(![...gpu.moduleCache.values()].includes(module));
        const sampler = { minFilter: GL.NEAREST, magFilter: GL.NEAREST, wrapS: GL.REPEAT, wrapT: GL.REPEAT, wrapR: GL.REPEAT, maxAnisotropy: 1, minLod: 0, maxLod: 10 };
        for (let i = 0; i < 600; ++i) {sampler.minLod = i / 100;gpu.samplerFor({ sampler });}assert.equal(gpu.samplerCache.size, 512);
        const targets = gpu.currentTargets();
        for (let i = 0; i < 300; ++i) {gpu.current.stencil.front.writeMask = i;gpu.clearPipeline(targets, true, false, true);}
        assert.ok(gpu.clearPipelineCache.size <= 256);assert.ok(gpu.pipelineKeyTables.get(gpu.clearPipelineCache).entryCount <= 256);
        for (let i = 0; i < 2600; ++i) gpu.variantKeyFor({ marker: i });assert.ok(gpu.variantKeys.entryCount <= 2048);assert.ok(gpu.variantKeys.atoms.size < 4096);
        const old = gpu.codeKey("old vertex", "old fragment");for (let i = 0; i < 600; ++i) gpu.codeKey("vertex" + i, "fragment" + i);
        assert.ok(gpu.shaderCodeKeys.entryCount <= 512);assert.ok(gpu.shaderCodeKeys.atoms.size < 2048);assert.notEqual(gpu.codeKey("old vertex", "old fragment"), old);
        const first = {}, second = {};gpu.pairKey(first, second, "v", "f");assert.ok(gpu.compiledPairKeys.get(first) instanceof WeakMap, "paired shaders do not retain deleted partners");
        send(new GLStream().call("CREATE_PROGRAM", 1).call("CREATE_SHADER", 2, GL.VERTEX_SHADER).shaderSource(2, "void main(){gl_Position=gl_Vertex;}").call("COMPILE_SHADER", 2).call("ATTACH_SHADER", 1, 2)
            .call("CREATE_SHADER", 3, GL.FRAGMENT_SHADER).shaderSource(3, "void main(){gl_FragColor=vec4(1,0,0,1);}").call("COMPILE_SHADER", 3).call("ATTACH_SHADER", 1, 3).call("LINK_PROGRAM", 1).call("USE_PROGRAM", 1));
        const program = gpu.currentProgramObject(), variant = gpu.currentVariant;
        for (let i = 0; i < 600; ++i) {
            gpu.currentVariant = () => ({ ...variant.call(gpu), clipPlaneCount: 6, clipPlaneMask: i % 64, colorTargets: (i >> 6) % 8 + 1, flatShading: i >= 512 });
            assert.ok(gpu.resolveShaders());
        }
        gpu.currentVariant = variant;assert.equal(program.variants.size, 128);assert.ok(gpu.shaderCache.size <= 512);assert.ok(gpu.linkKeys.entryCount <= 512);
        send(new GLStream().call("USE_PROGRAM", 0));
        for (let i = 0; i < 600; ++i) {
            gpu.currentVariant = () => ({ ...variant.call(gpu), clipPlaneCount: 6, clipPlaneMask: i % 64, colorTargets: (i >> 6) % 8 + 1, flatShading: i >= 512 });
            assert.ok(gpu.resolveShaders());
        }
        gpu.currentVariant = variant;assert.equal(gpu.ffCache.size, 512);
        send(new GLStream().call("BIND_PROGRAM_ARB", GL.VERTEX_PROGRAM_ARB, 1).programStringARB(GL.VERTEX_PROGRAM_ARB,
            "!!ARBvp1.0\nOPTION ARB_position_invariant;\nMOV result.color, vertex.color;\nEND").call("ENABLE", GL.VERTEX_PROGRAM_ARB));
        const arb = gpu.arbProgramFor(GL.VERTEX_PROGRAM_ARB);
        for (let i = 0; i < 200; ++i) {
            gpu.currentVariant = () => ({ ...variant.call(gpu), clipPlaneCount: 6, clipPlaneMask: i % 64, colorTargets: (i >> 6) % 8 + 1 });
            assert.ok(gpu.resolveShaders());
        }
        gpu.currentVariant = variant;assert.equal(arb.variants.size, 128);
        send(new GLStream().call("BIND_PROGRAM_ARB", GL.FRAGMENT_PROGRAM_ARB, 2).programStringARB(GL.FRAGMENT_PROGRAM_ARB,
            "!!ARBfp1.0\nMOV result.color, fragment.color;\nEND").call("ENABLE", GL.FRAGMENT_PROGRAM_ARB));
        for (let i = 0; i < 200; ++i) {
            gpu.currentVariant = () => ({ ...variant.call(gpu), clipPlaneCount: 6, clipPlaneMask: i % 64, colorTargets: (i >> 6) % 8 + 1 });
            assert.ok(gpu.resolveShaders());
        }
        gpu.currentVariant = variant;assert.equal(gpu.arbProgramFor(GL.FRAGMENT_PROGRAM_ARB).variants.size, 128);assert.equal(arb.variants.size, 128);
        send(new GLStream().call("DISABLE", GL.VERTEX_PROGRAM_ARB).call("DISABLE", GL.FRAGMENT_PROGRAM_ARB));
        send(new GLStream().call("BIND_TEXTURE", GL.TEXTURE_2D, 99).call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST)
            .texImage2D(GL.TEXTURE_2D, 0, GL.RGBA8, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255])));
        const texture = gpu.boundTexture(GL.TEXTURE_2D), view = gpu.textureViewFor(texture, { target: "2D" });
        for (let i = 0; i < 600; ++i) {texture.sampler.maxLevel = i;assert.equal(gpu.textureViewFor(texture, { target: "2D" }), view);}
        assert.equal(texture.viewCache.size, 1, "equivalent mip ranges share a view");
        // Index entries are limited by bytes as well as by count.
        for (let i = 0; i < 20; ++i) gpu.expansionIndices(GL.QUADS, 200000 + i * 4);
        assert.ok(gpu.indexExpansionBytes <= 16 * 1024 * 1024);assert.ok(gpu.indexExpansionCache.size < 20);
        gpu.expansionIndices(GL.QUADS, 3000000);assert.ok(gpu.indexExpansionBytes <= 16 * 1024 * 1024);assert.equal(gpu.indexExpansionCache.size, 0, "oversized expansion is not retained");
        // Immediate vertices append scalars into one retained typed block. A
        // later batch reuses it; latched colors and homogeneous w survive.
        send(new GLStream().call("USE_PROGRAM", 0));gpu.beginImmediate(GL.POINTS);const data = gpu.current.immediate.data;
        for (let i = 0; i < 1000; ++i) {gpu.current.current.color[0] = i / 1000;gpu.immediateVertex(i, 2, 3, 2);}
        const batch = gpu.current.immediate;assert.equal(batch.data, data);assert.equal(batch.count, 1000);assert.equal(data[3], 2);assert.equal(data[999 * batch.stride + 4], Math.fround(.999));
        gpu.endImmediate();gpu.beginImmediate(GL.POINTS);assert.equal(gpu.current.immediate.data, data);gpu.current.immediate = null;
        gpu.flushFrame();await gpu.idle();assert.equal(gpu.stats.refusals, 0);assert.equal(gpu.hostErrors.length, 0);assert.equal(gpu.gpuErrors.errors.length, 0);assert.ok(log.draws.length);
    }
    console.log("gl_cache_bounds_test: modules, samplers, pipeline descriptors, compiler variants and atoms, weak shader pairs, byte-bounded index expansions and retained immediate blocks passed in both modes");
})().catch(error => {console.error(String(error.stack || error));process.exitCode = 1;});
