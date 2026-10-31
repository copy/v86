"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_glsl.js");require("../../src/browser/glbridge/gl-webgpu/gl_shadow_render.js");
const { Glslang } = require("../../src/browser/glbridge/gl-webgpu/gl_glslang.js"), { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"),
    translator = require("../../src/browser/glbridge/gl-webgpu/gl_shader_translator.js"), { createFakeHost } = require("./gl_fake_gpu.js"), { GLStream, GL } = require("./gl_stream_builder.js");
const compiler = new Glslang(fs.readFileSync(__dirname + "/../../bios/glslang.wasm"));
const vertex = "#version 120\nuniform float bias;void main(){gl_Position=gl_Vertex+vec4(bias,0,0,0);}",
    red = "#version 120\nvoid main(){gl_FragColor=vec4(1.0,0.0,0.0,1.0);}", blue = red.replace("1.0,0.0,0.0", "0.0,0.0,1.0");
const build = s => s.call("CREATE_PROGRAM", 5).call("CREATE_SHADER", 1, GL.VERTEX_SHADER).shaderSource(1, vertex).call("COMPILE_SHADER", 1).call("ATTACH_SHADER", 5, 1)
    .call("CREATE_SHADER", 2, GL.FRAGMENT_SHADER).shaderSource(2, red).call("COMPILE_SHADER", 2).call("ATTACH_SHADER", 5, 2).call("LINK_PROGRAM", 5).call("USE_PROGRAM", 5);
const triangle = () => new GLStream().call("BEGIN", GL.TRIANGLES).call("VERTEX3F", -1, -1, 0).call("VERTEX3F", 1, -1, 0).call("VERTEX3F", 0, 1, 0).call("END");
(async () => {
    const original = translator.hashString;translator.hashString = () => 0;
    try {
        for (const copied of [false, true]) {
            const cpu = new GLShadow(), { host, log } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true });await gpu.initialize();cpu.setCapabilities(gpu.capabilities());cpu.setGlslang(compiler);
            const submit = async s => {
                const bytes = s.bytes(), segments = cpu.process(bytes);
                for (const segment of segments || [{ offset: 0, length: bytes.length }]) {
                    const part = segment.bytes || bytes.subarray(segment.offset, segment.offset + segment.length);gpu.submit(copied ? part.slice() : part, {});
                }
                await gpu.idle();
            };
            const draw = async () => {await submit(triangle());return log.draws.at(-1).pipeline;};
            await submit(build(new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1)));
            const first = await draw(), object = gpu.current.shareGroup.programs.get(5), objectId = object.cpuObjectId;
            const bias = cpu.current.group.programs.get(5).linked.uniforms.find(u => u.name === "bias").location;
            await submit(new GLStream().uniformfv(bias, 1, 1, [0.1]));assert.equal(await draw(), first, "uniform writes do not create pipelines");
            await submit(new GLStream().call("STENCIL_FUNC", GL.NEVER, 17, 0x55).call("STENCIL_OP", GL.REPLACE, GL.REPLACE, GL.REPLACE).call("STENCIL_MASK", 0x33));
            assert.equal(await draw(), first, "remembered stencil state is ignored while disabled");
            const disabled = first.descriptor.depthStencil;assert.equal(disabled.stencilFront.compare, "always");assert.equal(disabled.stencilFront.passOp, "keep");assert.equal(disabled.stencilWriteMask, 0);
            await submit(new GLStream().call("ENABLE", GL.STENCIL_TEST));const enabled = await draw();assert.notEqual(enabled, first);
            await submit(new GLStream().call("STENCIL_FUNC", GL.NEVER, 99, 0x55));assert.equal(await draw(), enabled, "stencil reference is dynamic pass state");
            await submit(new GLStream().call("DISABLE", GL.STENCIL_TEST));assert.equal(await draw(), first);
            await submit(new GLStream().call("COLOR_MASK", 0, 1, 1, 1));assert.notEqual(await draw(), first, "complete fragment target write masks participate");
            await submit(new GLStream().call("COLOR_MASK", 1, 1, 1, 1));assert.equal(await draw(), first);
            await submit(new GLStream().call("LINK_PROGRAM", 5));const relinked = await draw();assert.notEqual(relinked, first);assert.equal(object.cpuObjectId, objectId);assert.equal(object.cpuLinkGeneration, 2);
            await submit(new GLStream().shaderSource(2, "void main(){broken;}").call("COMPILE_SHADER", 2).call("LINK_PROGRAM", 5));assert.equal(await draw(), relinked, "a failed relink retains the installed executable's pipeline");
            await submit(new GLStream().shaderSource(2, blue).call("COMPILE_SHADER", 2).call("LINK_PROGRAM", 5));const changed = await draw();
            assert.notEqual(changed, relinked);assert.notEqual(changed.descriptor.fragment.module.code, relinked.descriptor.fragment.module.code, "forced source-hash collisions cannot reuse the old executable");
            assert.equal(object.cpuLinkGeneration, 4);
            await submit(build(new GLStream().makeCurrent(2, 0, 0, 16, 16, 2, 2)));const separate = await draw();assert.notEqual(separate, first, "equal public names and CPU ids in another share group are distinct objects");
            await submit(new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1).call("USE_PROGRAM", 0).call("DELETE_PROGRAM", 5).call("CREATE_PROGRAM", 5)
                .call("ATTACH_SHADER", 5, 1).call("ATTACH_SHADER", 5, 2).call("LINK_PROGRAM", 5).call("USE_PROGRAM", 5));
            assert.notEqual(await draw(), changed);assert.ok(gpu.current.shareGroup.programs.get(5).cpuObjectId > objectId);
            const singleSample = log.draws.at(-1).pipeline;
            await submit(new GLStream().makeCurrent(3, 0, 0, 16, 16, 3, 1, 4 << 8).call("USE_PROGRAM", 5));
            const multisample = await draw();assert.notEqual(multisample, singleSample);assert.equal(multisample.descriptor.multisample.count, 4);
            for (const key of gpu.pipelineCache.keys()) assert.equal(typeof key, "number");
            for (const key of gpu.shaderCache.keys()) assert.equal(typeof key, "number");
            assert.equal(cpu.current.error, 0);assert.equal(gpu.stats.refusals, 0);assert.equal(gpu.hostErrors.length, 0);assert.equal(gpu.gpuErrors.errors.length, 0);
        }
    } finally {translator.hashString = original;}
    console.log("gl_pipeline_keys_test: integer descriptor keys, disabled stencil, dynamic references, CPU program/link identity, name reuse and forced hash collisions in both modes passed");
})().catch(error => { console.error(error);process.exitCode = 1; });
