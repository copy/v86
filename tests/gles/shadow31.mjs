#!/usr/bin/env node
// GLES 3.1's shadow state (src/gles/gles31_state.js; docs/gles3-plan.md
// L5) through the GLES host as the guest drives it: compute dispatches and
// what they write, storage and atomic counter buffers, image units, vertex
// attribute bindings, separable programs and pipelines, glProgramUniform,
// the program interface queries, multisampled textures, framebuffers
// without attachments, glCreateShaderProgramv and its link in the batch.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GLESHost } from "../../src/gles/gles_host.js";
import { compile_glslang, create_glslang } from "../../src/gles/glslang.js";
import { client, cstring, fake_renderer, i32s, text } from "./lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..") + "/";
const glslang = await create_glslang(await compile_glslang(fs.readFileSync(root + "bios/glslang.wasm")));
const DISPLAY = { width: 480, height: 800, dpi: 240 };

const renderer = fake_renderer();
const host = new GLESHost(DISPLAY, renderer, undefined, { glslang, max_version: "3.1" });
const { call } = await client(host).connect();
const context = (await call("rcCreateContext", 3, 0, 4)).ret;
const surface = (await call("rcCreateWindowSurface", 3, 320, 240)).ret;
await call("rcMakeCurrent", context, surface, surface);
const c = host.shadow.context(context);
const error = async () => (await call("gles2:glGetError")).ret;
const ints = async (name, ...args) => i32s((await call("gles2:" + name, ...args)).outs[0]);
const gen = async kind => (await ints("glGen" + kind, 1, 4))[0];
const shader = async (type, source) =>
{
    const name = (await call("gles2:glCreateShader", type)).ret;
    await call("gles2:glShaderString", name, cstring(source), source.length + 1);
    await call("gles2:glCompileShader", name);
    return name;
};
const program = async (sources, separable) =>
{
    const p = (await call("gles2:glCreateProgram")).ret;
    for(const [type, source] of sources) await call("gles2:glAttachShader", p, await shader(type, source));
    if(separable) await call("gles2:glProgramParameteri", p, 0x8258, 1);
    await call("gles2:glLinkProgram", p);
    return p;
};
const linked = async p => (await ints("glGetProgramiv", p, 0x8B82, 4))[0];

// ---- the version
assert.equal(c.version, 31, "a GLES 3.1 context (the guest asks 4)");
assert.deepEqual(await ints("glGetIntegerv", 0x821C, 4), [1], "GL_MINOR_VERSION");
assert.deepEqual(await ints("glGetIntegeri_v", 0x91BF, 2, 4), [64], "GL_MAX_COMPUTE_WORK_GROUP_SIZE's z");
console.log("PASS: a GLES 3.1 context and its limits");

// ---- compute: a dispatch of a program with a compute shader, its storage buffer the GPU's then
{
    const compute = await program([[0x91B9, "#version 310 es\nlayout(local_size_x = 4) in;\n" +
        "layout(std430, binding = 0) buffer Data { uint values[]; };\nvoid main() { values[gl_GlobalInvocationID.x] = gl_GlobalInvocationID.x * 2u; }"]]);
    assert.equal(await linked(compute), 1, "a compute program links");
    assert.deepEqual(await ints("glGetProgramiv", compute, 0x8267, 12), [4, 1, 1], "GL_COMPUTE_WORK_GROUP_SIZE");
    assert.deepEqual(await ints("glGetProgramiv", compute, 0x8258, 4), [0], "GL_PROGRAM_SEPARABLE: not");
    await call("gles2:glDispatchCompute", 1, 1, 1);
    assert.equal(await error(), 0x0502, "no current program: INVALID_OPERATION");
    await call("gles2:glUseProgram", compute);
    const data = await gen("Buffers");
    await call("gles2:glBindBuffer", 0x90D2, data);
    await call("gles2:glBufferData", 0x90D2, 16, null, 0x88E8);
    await call("gles2:glBindBufferRange", 0x90D2, 0, data, 4, 12);
    assert.equal(await error(), 0x0501, "a storage range's offset not a multiple of 256: INVALID_VALUE");
    await call("gles2:glBindBufferBase", 0x90D2, 0, data);
    assert.deepEqual(await ints("glGetIntegeri_v", 0x90D3, 0, 4), [data], "GL_SHADER_STORAGE_BUFFER_BINDING, indexed");
    await call("gles2:glDispatchCompute", 70000, 1, 1);
    assert.equal(await error(), 0x0501, "past MAX_COMPUTE_WORK_GROUP_COUNT: INVALID_VALUE");
    await call("gles2:glDispatchCompute", 1, 1, 1);
    assert.equal(await error(), 0, "a dispatch");
    assert.ok(c.group.buffers.get(data).gpu_newer, "the storage buffer is the GPU's now");
    const mapped = (await call("gles2:glMapBufferRangeAEMU", 0x90D2, 0, 16, 1, 16)).outs[0];
    const read = renderer.records().filter(r => r.name === "BUFFER_READ").at(-1);
    assert.ok(read && read.buffer === data && mapped.every(b => b === (read.request & 0xFF)), "its map asks the page");
    await call("gles2:glUnmapBufferAEMU", 0x90D2, 0, 16, 1, null, 4);
    console.log("PASS: compute, a storage buffer the dispatch wrote");
}

// ---- image units
{
    const mutable = await gen("Textures");
    await call("gles2:glBindTexture", 0x0DE1, mutable);
    await call("gles2:glTexImage2D", 0x0DE1, 0, 0x8814, 4, 4, 0, 0x1908, 0x1406, null);
    await call("gles2:glBindImageTexture", 0, mutable, 0, 0, 0, 0x88BA, 0x8814);
    assert.equal(await error(), 0x0502, "a mutable texture: INVALID_OPERATION");
    const storage = await gen("Textures");
    await call("gles2:glBindTexture", 0x0DE1, storage);
    await call("gles2:glTexStorage2D", 0x0DE1, 1, 0x8814, 4, 4);
    await call("gles2:glBindImageTexture", 0, storage, 0, 0, 0, 0x88BA, 0x8814);
    assert.equal(await error(), 0);
    assert.deepEqual(await ints("glGetIntegeri_v", 0x8F3A, 0, 4), [storage], "GL_IMAGE_BINDING_NAME");
    assert.deepEqual(await ints("glGetIntegeri_v", 0x906E, 0, 4), [0x8814], "GL_IMAGE_BINDING_FORMAT");
    console.log("PASS: image units");
}

// ---- vertex attribute bindings
{
    await call("gles2:glBindVertexBuffer", 0, 1, 0, 16);
    assert.equal(await error(), 0x0502, "no vertex array object: INVALID_OPERATION");
    const vao = await gen("VertexArrays");
    await call("gles2:glBindVertexArray", vao);
    const buffer = await gen("Buffers");
    await call("gles2:glBindBuffer", 0x8892, buffer);
    await call("gles2:glBufferData", 0x8892, 64, null, 0x88E4);
    await call("gles2:glVertexAttribFormat", 2, 3, 0x1406, 0, 8);
    await call("gles2:glVertexAttribBinding", 2, 5);
    await call("gles2:glBindVertexBuffer", 5, buffer, 16, 20);
    await call("gles2:glVertexBindingDivisor", 5, 3);
    assert.equal(await error(), 0);
    assert.deepEqual(await ints("glGetVertexAttribiv", 2, 0x82D4, 4), [5], "GL_VERTEX_ATTRIB_BINDING");
    assert.deepEqual(await ints("glGetVertexAttribiv", 2, 0x82D5, 4), [8], "GL_VERTEX_ATTRIB_RELATIVE_OFFSET");
    assert.deepEqual(await ints("glGetVertexAttribiv", 2, 0x889F, 4), [buffer], "the attribute's buffer is its binding point's");
    assert.deepEqual(await ints("glGetIntegeri_v", 0x82D8, 5, 4), [20], "GL_VERTEX_BINDING_STRIDE");
    const a = c.attribs[2];
    assert.deepEqual([a.buffer, a.offset, a.stride, a.divisor], [buffer, 24, 20, 3], "what the executor reads: offset 16 + 8");
    await call("gles2:glVertexAttribPointerOffset", 3, 2, 0x1406, 0, 0, 4);
    assert.deepEqual(await ints("glGetVertexAttribiv", 3, 0x82D4, 4), [3], "glVertexAttribPointer: the attribute's own binding point");
    assert.deepEqual(await ints("glGetIntegeri_v", 0x82D7, 3, 4), [4], "its offset");
    await call("gles2:glBindVertexArray", 0);
    console.log("PASS: vertex attribute bindings");
}

// ---- separable programs, a pipeline, glProgramUniform, the interface queries
const vs = "#version 310 es\nlayout(location = 0) in vec4 position;\nuniform float scale;\nvoid main() { gl_Position = position * scale; }";
const fs_ = "#version 310 es\nprecision mediump float;\nuniform vec4 color;\nlayout(location = 0) out vec4 o;\nvoid main() { o = color; }";
{
    const vertex = await program([[0x8B31, vs]], true), fragment = await program([[0x8B30, fs_]], true);
    assert.equal(await linked(vertex), 1, "a separable vertex program");
    assert.deepEqual(await ints("glGetProgramiv", vertex, 0x8258, 4), [1], "GL_PROGRAM_SEPARABLE");
    await call("gles2:glGetProgramiv", vertex, 0x8267, 12);
    assert.equal(await error(), 0x0502, "GL_COMPUTE_WORK_GROUP_SIZE of no compute stage: INVALID_OPERATION");
    assert.equal(await linked(fragment), 1, "a separable fragment program");
    const pipeline = await gen("ProgramPipelines");
    await call("gles2:glUseProgram", 0);
    await call("gles2:glBindProgramPipeline", pipeline);
    await call("gles2:glUseProgramStages", pipeline, 1, vertex);
    await call("gles2:glUseProgramStages", pipeline, 2, fragment);
    assert.equal(await error(), 0);
    assert.deepEqual(await ints("glGetProgramPipelineiv", pipeline, 0x8B31, 4), [vertex], "the pipeline's vertex program");
    await call("gles2:glValidateProgramPipeline", pipeline);
    assert.deepEqual(await ints("glGetProgramPipelineiv", pipeline, 0x8B83, 4), [1], "GL_VALIDATE_STATUS");
    const color = (await call("gles2:glGetUniformLocation", fragment, cstring("color"))).ret;
    await call("gles2:glProgramUniform4f", fragment, color, 1, 0.5, 0, 1);
    assert.equal(await error(), 0, "glProgramUniform4f");
    const got = new Float32Array((await call("gles2:glGetUniformfv", fragment, color, 16)).outs[0].slice().buffer);
    assert.deepEqual(Array.from(got), [1, 0.5, 0, 1], "the program's value");
    await call("gles2:glActiveShaderProgram", pipeline, vertex);
    const scale = (await call("gles2:glGetUniformLocation", vertex, cstring("scale"))).ret;
    await call("gles2:glUniform1f", scale, 2);
    assert.equal(await error(), 0, "glUniform with a pipeline: its active program's");
    assert.deepEqual(Array.from(new Float32Array((await call("gles2:glGetUniformfv", vertex, scale, 4)).outs[0].slice().buffer)), [2]);

    assert.deepEqual(await ints("glGetProgramInterfaceiv", fragment, 0x92E1, 0x92F5, 4), [1], "GL_UNIFORM's GL_ACTIVE_RESOURCES");
    const index = (await call("gles2:glGetProgramResourceIndex", fragment, 0x92E1, cstring("color"))).ret;
    assert.equal(index, 0, "glGetProgramResourceIndex");
    const resource = (await call("gles2:glGetProgramResourceiv", fragment, 0x92E1, index, 2, new Uint8Array(new Int32Array([0x92FA, 0x930E]).buffer),
        2, 4, 8)).outs;
    assert.deepEqual([i32s(resource[0]), i32s(resource[1])], [[2], [0x8B52, color]], "its type (vec4) and location, two values");
    assert.equal((await call("gles2:glGetProgramResourceLocation", vertex, 0x92E3, cstring("position"))).ret, 0, "an input's location");
    assert.deepEqual(await ints("glGetProgramInterfaceiv", fragment, 0x92E4, 0x92F5, 4), [1], "one output");
    await call("gles2:glBindProgramPipeline", 0);
    console.log("PASS: separable programs, a pipeline, glProgramUniform, the program interface");
}

// ---- multisampled textures, framebuffers without attachments
{
    const texture = await gen("Textures");
    await call("gles2:glBindTexture", 0x9100, texture);
    await call("gles2:glTexStorage2DMultisample", 0x9100, 4, 0x8058, 8, 8, 1);
    assert.equal(await error(), 0);
    assert.deepEqual(await ints("glGetTexLevelParameteriv", 0x9100, 0, 0x9106, 4), [4], "GL_TEXTURE_SAMPLES");
    assert.deepEqual(await ints("glGetTexLevelParameteriv", 0x9100, 0, 0x1000, 4), [8], "GL_TEXTURE_WIDTH");
    const position = new Float32Array((await call("gles2:glGetMultisamplefv", 0x8E50, 1, 8)).outs[0].slice().buffer);
    assert.deepEqual(Array.from(position), [0.875, 0.375], "sample 1's position");
    const fbo = await gen("Framebuffers");
    await call("gles2:glBindFramebuffer", 0x8D40, fbo);
    assert.equal((await call("gles2:glCheckFramebufferStatus", 0x8D40)).ret, 0x8CD7, "no attachments, no default size: incomplete");
    await call("gles2:glFramebufferParameteri", 0x8D40, 0x9310, 16);
    await call("gles2:glFramebufferParameteri", 0x8D40, 0x9311, 8);
    assert.equal((await call("gles2:glCheckFramebufferStatus", 0x8D40)).ret, 0x8CD5, "a default size: complete");
    await call("gles2:glBindFramebuffer", 0x8D40, 0);
    console.log("PASS: multisampled textures, framebuffers without attachments");
}

// ---- glCreateShaderProgramv: the program's name its answer, its link in the batch before it
{
    const source = "#version 310 es\nprecision mediump float;\nlayout(location = 0) out vec4 o;\nvoid main() { o = vec4(1.0); }";
    const made = (await call("gles2:glCreateShaderProgramvAEMU", 0x8B30, 1, cstring(source), source.length + 1)).ret;
    assert.ok(made, "a program");
    assert.equal(await linked(made), 1, "linked");
    assert.equal(c.group.objects.get(made).separable, true, "separable");
    host.flush();
    const records = renderer.records();
    const command = records.findIndex(r => r.name === "COMMAND" && r.command.name === "glCreateShaderProgramvAEMU");
    const link = records.findIndex(r => r.name === "PROGRAM_LINK" && r.program === made);
    assert.ok(command >= 0 && link >= 0 && link < command, "the page gets the command, its link first");
    console.log("PASS: glCreateShaderProgramv");
}
void text;

// ---- EXT_robustness: no reset; glReadnPixelsEXT reads as glReadPixels, its buffer's size checked
{
    assert.equal((await call("gles2:glGetGraphicsResetStatusEXT")).ret, 0, "GL_NO_ERROR: never reset");
    await call("gles2:glReadnPixelsEXT", 0, 0, 2, 2, 0x1908, 0x1401, 15, 16);
    assert.equal(await error(), 0x0502, "a buffer too small: INVALID_OPERATION");
    const before = renderer.records().filter(r => r.name === "READ_PIXELS").length;
    await call("gles2:glReadnPixelsEXT", 0, 0, 2, 2, 0x1908, 0x1401, 16, 16);
    assert.equal(await error(), 0);
    assert.equal(renderer.records().filter(r => r.name === "READ_PIXELS").length, before + 1, "the page reads them");
    console.log("PASS: EXT_robustness");
}

// ---- GLES 3.2's state: KHR_debug's initial values, the stages' limits, the bounding box, sample shading
{
    const renderer32 = fake_renderer();
    const host32 = new GLESHost(DISPLAY, renderer32, undefined, { glslang, max_version: "3.2" });
    const { call: call32 } = await client(host32).connect();
    const context32 = (await call32("rcCreateContext", 3, 0, 4)).ret;
    const surface32 = (await call32("rcCreateWindowSurface", 3, 320, 240)).ret;
    await call32("rcMakeCurrent", context32, surface32, surface32);
    const get = async pname => i32s((await call32("gles2:glGetIntegerv", pname, 32)).outs[0]).slice(0, 1)[0];
    assert.equal(host32.shadow.context(context32).version, 32);
    assert.equal(await get(0x8DE0), 256, "GL_MAX_GEOMETRY_OUTPUT_VERTICES");
    assert.equal(await get(0x8E7D), 32, "GL_MAX_PATCH_VERTICES");
    assert.equal(await get(0x82E8), 256, "GL_MAX_LABEL_LENGTH");
    const box = new Float32Array((await call32("gles2:glGetFloatv", 0x92BE, 32)).outs[0].slice().buffer);
    assert.deepEqual(Array.from(box), [-1, -1, -1, 1, 1, 1, 1, 1], "GL_PRIMITIVE_BOUNDING_BOX");
    await call32("gles2:glEnable", 0x8C36);
    assert.equal((await call32("gles2:glIsEnabled", 0x8C36)).ret, 1, "GL_SAMPLE_SHADING");
    assert.equal((await call32("gles2:glGetError")).ret, 0);
    console.log("PASS: GLES 3.2's state");

    // a geometry shader: its program's layout, the draws' modes it takes, adjacency
    const shader32 = async (type, source) =>
    {
        const name = (await call32("gles2:glCreateShader", type)).ret;
        await call32("gles2:glShaderString", name, cstring(source), source.length + 1);
        await call32("gles2:glCompileShader", name);
        return name;
    };
    const p = (await call32("gles2:glCreateProgram")).ret;
    await call32("gles2:glAttachShader", p, await shader32(0x8B31, "#version 320 es\nin vec4 position;\nvoid main() { gl_Position = position; }"));
    await call32("gles2:glAttachShader", p, await shader32(0x8DD9, "#version 320 es\nlayout(lines_adjacency, invocations = 3) in;\n" +
        "layout(line_strip, max_vertices = 2) out;\nvoid main() { gl_Position = gl_in[1].gl_Position; EmitVertex(); gl_Position = gl_in[2].gl_Position; EmitVertex(); }"));
    await call32("gles2:glAttachShader", p, await shader32(0x8B30, "#version 320 es\nprecision mediump float;\nout vec4 o;\nvoid main() { o = vec4(1.0); }"));
    await call32("gles2:glLinkProgram", p);
    const program_ints = async pname => i32s((await call32("gles2:glGetProgramiv", p, pname, 4)).outs[0])[0];
    assert.equal(await program_ints(0x8B82), 1, "a program of a geometry shader links");
    assert.deepEqual([await program_ints(0x8917), await program_ints(0x8918), await program_ints(0x8916), await program_ints(0x887F)],
        [0x000A, 0x0003, 2, 3], "GL_GEOMETRY_LINKED_INPUT_TYPE, _OUTPUT_TYPE, _VERTICES_OUT, GL_GEOMETRY_SHADER_INVOCATIONS");
    await call32("gles2:glUseProgram", p);
    await call32("gles2:glDrawArrays", 0x0004, 0, 3);
    assert.equal((await call32("gles2:glGetError")).ret, 0x0502, "triangles to a shader of lines with adjacency: INVALID_OPERATION");
    await call32("gles2:glDrawArrays", 0x000B, 0, 5);
    assert.equal((await call32("gles2:glGetError")).ret, 0, "a line strip with adjacency");
    await call32("gles2:glUseProgram", 0);
    await call32("gles2:glDrawArrays", 0x000F, 0, 3);
    assert.equal((await call32("gles2:glGetError")).ret, 0x0500, "no such mode: INVALID_ENUM");
    console.log("PASS: GLES 3.2's geometry shaders");
}
