"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"),
    { execFileSync } = require("node:child_process");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
for (const part of ["objects", "state", "raster", "fixed", "misc", "stencil_ext", "render", "arrays", "images", "textures", "buffers", "queries", "glsl", "arb"])
    require("../../src/browser/glbridge/gl-webgpu/gl_shadow_" + part + ".js");
const { Glslang } = require("../../src/browser/glbridge/gl-webgpu/gl_glslang.js"),
    { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"), { GLStream, GL } = require("./gl_stream_builder.js"),
    { createFakeHost } = require("./gl_fake_gpu.js"), { setup, draw, stripes } = require("./gl_bind_layout_cases.js"),
    { requireNaga } = require("./naga.js");
(async () => {
    const compiler = new Glslang(fs.readFileSync(__dirname + "/../../bios/glslang.wasm")), codes = new Set();
    for (const copied of [false, true]) {
        const { host, log } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true });await gpu.initialize();gpu.flushThreshold = 100000;
        const cpu = new GLShadow();cpu.setCapabilities(gpu.capabilities());cpu.setGlslang(compiler);
        const send = s => {
            const memory = s.bytes(), segments = cpu.process(memory);
            for (const segment of segments || [{ offset: 0, length: memory.length }]) {
                const bytes = segment.bytes || memory.subarray(segment.offset, segment.offset + segment.length);gpu.submit(copied ? bytes.slice() : bytes, {});
            }
            assert.equal(cpu.current.error, 0);
        };
        // Force descriptor hashes to collide: full comparisons must still
        // distinguish the empty group and fragment uniform group.
        gpu.bindLayoutKeys.hash = () => 0;
        send(setup(new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1)));
        const query = new GLStream(), result = query.queryLocation(1, 1, "tint", 16);send(query);
        const location = result.view.getInt32(16, true);assert.ok(location >= 0);
        send(stripes(new GLStream(), location, 40));
        assert.equal(log.draws.length, 56);assert.equal(gpu.stats.bindGroups, 1, "all offsets share one resource group");
        assert.ok(gpu.stats.uniformStampHits >= 40, "unchanged user uniforms avoid repacking and byte comparison");
        const calls = log.draws[0].pass.calls.filter(call => call[0] === "bindGroup" && call[1] === 1);
        assert.equal(new Set(calls.map(call => call[2])).size, 1);
        for (let i = 0; i < 16; ++i) {
            const call = calls[i], entry = call[2].descriptor.entries[0], offset = entry.resource.offset + call[3][0], values = new Float32Array(entry.resource.buffer.storage, offset, 4);
            assert.ok(Math.abs(values[0] - i / 15) < 1e-6);assert.ok(Math.abs(values[1] - (1 - i / 15)) < 1e-6);
        }
        const before = gpu.stats.uniformByteChecks;send(new GLStream().uniformfv(location, 4, 1, [1, 0, .25, 1]));send(draw(new GLStream()));send(draw(new GLStream()));
        assert.equal(gpu.stats.uniformByteChecks, before + 1, "a no-op setter advances its stamp after one equality check");
        const groupsBefore = gpu.stats.bindGroups;send(draw(new GLStream().call("COLOR_MASK", 0, 1, 1, 1)));send(draw(new GLStream().call("COLOR_MASK", 1, 1, 1, 1)));
        assert.equal(gpu.stats.bindGroups, groupsBefore, "compatible layouts share their group across distinct color-mask pipelines");
        const oldLayout = log.draws[0].pipeline.glBindGroupLayouts[1];assert.equal(oldLayout.descriptor.entries[0].buffer.hasDynamicOffset, true);
        assert.equal(oldLayout.descriptor.entries[0].visibility, 2, "fragment-only block stays fragment-only");
        const other = { wgslVertex: "@group(1) @binding(1) var<uniform> tint:vec4f; @vertex fn vs_main()->@builtin(position) vec4f{return tint;}",
            wgslFragment: "@fragment fn fs_main()->@location(0) vec4f{return vec4f(1);}" },
            different = gpu.explicitShaderLayout(other, gpu.shaderModule(other.wgslVertex), gpu.shaderModule(other.wgslFragment));
        assert.notEqual(different.groups[1], oldLayout);assert.equal(different.groups[1].descriptor.entries[0].visibility, 1, "colliding keys still separate vertex and fragment visibility");
        const original = gpu.resolveShaders();
        for (let i = 0; i < 600; ++i) {
            const shaders = { ...original, wgslVertex: original.wgslVertex + "\n// layout cache " + i };
            gpu.explicitShaderLayout(shaders, gpu.shaderModule(shaders.wgslVertex), gpu.shaderModule(shaders.wgslFragment));
        }
        assert.ok(gpu.explicitShaderLayouts.size <= 512);assert.ok(gpu.explicitGroupLayouts.size <= 512);assert.ok(gpu.explicitPipelineLayouts.size <= 512);
        for (const module of log.modules.slice(0, 3)) codes.add(module.code);
        gpu.flushFrame();await gpu.idle();assert.equal(gpu.stats.refusals, 0);assert.equal(gpu.hostErrors.length, 0);assert.equal(gpu.gpuErrors.errors.length, 0);
        gpu.resources.invalidate();assert.equal(gpu.explicitGroupLayouts.size, 0);assert.equal(gpu.explicitPipelineLayouts.size, 0);assert.equal(gpu.explicitShaderLayouts.size, 0);assert.equal(gpu.bindLayoutKeys.buckets.size, 0);assert.equal(gpu.lastShaderLayout, null);
    }
    const naga = requireNaga("gl_bind_layout_test");
    if (naga) {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gl-bind-layout-"));
        try { let i = 0;for (const code of codes) { const file = path.join(directory, i++ + ".wgsl");fs.writeFileSync(file, code);execFileSync(naga, [file], { stdio: "pipe" }); } }
        finally { fs.rmSync(directory, { recursive: true, force: true }); }
    }
    console.log("gl_bind_layout_test: dynamic offsets preserve each draw, one cached group, uniform stamps, forced collisions, cache bounds and device cleanup in both modes passed");
})().catch(error => {console.error(String(error.stack || error));process.exitCode = 1;});
