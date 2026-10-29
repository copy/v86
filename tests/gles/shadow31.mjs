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

// ---- block instance arrays: each element lists the array's variables (dEQP sizes an element's buffer by its unsized array's
// stride); a shared buffer block nothing uses stays active, a packed one does not
{
    const compute = await program([[0x91B9, `#version 310 es
layout(local_size_x = 1) in;
struct S { highp uvec2 a; mediump vec3 c; };
layout(std430, binding = 0) buffer Block { lowp vec2 u; S s[]; } block[3];
layout(shared, binding = 3) buffer Unused { highp ivec2 l[]; };
layout(packed, binding = 4) buffer Packed { highp int k[]; };
layout(std140, binding = 1) uniform Values { highp vec4 v; } values[2];
void main() { block[0].u = values[1].v.xy; block[2].s[1].a = uvec2(1u); }`]]);
    assert.equal(await linked(compute), 1, "a compute program of block instance arrays links");
    const index = async (iface, name) => (await call("gles2:glGetProgramResourceIndex", compute, iface, cstring(name))).ret >>> 0;
    const props = async (iface, i, list, n) => i32s((await call("gles2:glGetProgramResourceiv", compute, iface, i, list.length,
        new Uint8Array(new Int32Array(list).buffer), n, 4, 4 * n)).outs[1]);
    assert.deepEqual(await ints("glGetProgramInterfaceiv", compute, 0x92E6, 0x92F5, 4), [4], "four storage blocks: Block[0..2], Unused");
    const variables = await props(0x92E6, await index(0x92E6, "Block[0]"), [0x9304, 0x9305], 4);
    assert.equal(variables[0], 3, "Block[0]'s variables: u, s[0].a, s[0].c");
    for(const element of ["Block[1]", "Block[2]"])
    {
        assert.deepEqual(await props(0x92E6, await index(0x92E6, element), [0x9304, 0x9305], 4), variables, element + "'s variables, Block[0]'s");
    }
    const unused = await index(0x92E6, "Unused");
    assert.notEqual(unused, 0xFFFFFFFF, "a shared block nothing uses is active");
    assert.deepEqual(await props(0x92E6, unused, [0x9302, 0x9304], 2), [3, 1], "its binding and variable");
    assert.equal(await index(0x92E6, "Packed"), 0xFFFFFFFF, "a packed block nothing uses is not");
    assert.notEqual(await index(0x92E5, "l[0]"), 0xFFFFFFFF, "the shared block's variable");
    const uniforms = await props(0x92E2, await index(0x92E2, "Values[0]"), [0x9304, 0x9305], 2);
    assert.deepEqual(await props(0x92E2, await index(0x92E2, "Values[1]"), [0x9304, 0x9305], 2), uniforms, "Values[1]'s uniforms, Values[0]'s");
    assert.deepEqual(await ints("glGetActiveUniformBlockiv", compute, await index(0x92E2, "Values[1]"), 0x8A42, 4), [1],
        "GL_UNIFORM_BLOCK_ACTIVE_UNIFORMS of Values[1]");
    assert.equal(await error(), 0);
    // (a buffer block std140 from a default statement: its struct's arrays and matrices at std140's offsets, as glslang's reflection
    // gives only blocks that name std140; an array of arrays of matrices in a uniform block's struct the same, dEQP-GLES31
    // ubo.random.all_shared_buffer.37)
    const std140 = await program([[0x91B9, `#version 310 es
layout(local_size_x = 1) in;
layout(std140) buffer;
struct S { highp mat3x2 m[2]; float f; };
buffer B { S s; float g; };
struct T { highp mat4x2 mA[3][3]; highp uvec4 mB; };
layout(column_major) uniform U { mediump uvec3 a; T t; };
void main() { g = s.m[1][2].y + s.f + t.mA[2][1][3].x + float(t.mB.x); }`]]);
    assert.equal(await linked(std140), 1, "a program of std140 structs links");
    const std140_props = async (iface, name, list) => i32s((await call("gles2:glGetProgramResourceiv", std140, iface,
        (await call("gles2:glGetProgramResourceIndex", std140, iface, cstring(name))).ret, list.length, new Uint8Array(new Int32Array(list).buffer),
        list.length, 4, 4 * list.length)).outs[1]);
    assert.deepEqual(await std140_props(0x92E5, "s.m[0]", [0x92FC, 0x92FE, 0x92FF]), [0, 48, 16], "a struct's mat3x2[2] in a std140 buffer block");
    assert.deepEqual([(await std140_props(0x92E5, "s.f", [0x92FC]))[0], (await std140_props(0x92E5, "g", [0x92FC]))[0]], [96, 112], "the members after it");
    assert.deepEqual(await std140_props(0x92E1, "t.mA[1][0]", [0x92FC, 0x92FE]), [208, 64], "a struct's mat4x2[3][3] in a shared uniform block");
    assert.deepEqual(await std140_props(0x92E1, "t.mB", [0x92FC]), [592], "the member after it");
    assert.equal(await error(), 0);
    console.log("PASS: block instance arrays' variables, an unused shared block, std140 structs");
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

    // clamp to border: the wrap and the color, a texture's and a sampler's; the scalar calls refused
    const tex32 = i32s((await call32("gles2:glGenTextures", 1, 4)).outs[0])[0];
    await call32("gles2:glBindTexture", 0x0DE1, tex32);
    await call32("gles2:glTexParameteri", 0x0DE1, 0x2802, 0x812D);
    assert.equal((await call32("gles2:glGetError")).ret, 0, "GL_CLAMP_TO_BORDER");
    await call32("gles2:glTexParameterfv", 0x0DE1, 0x1004, new Uint8Array(new Float32Array([0.25, 0.5, 0.75, 1]).buffer));
    assert.deepEqual(Array.from(new Float32Array((await call32("gles2:glGetTexParameterfv", 0x0DE1, 0x1004, 16)).outs[0].slice().buffer)),
        [0.25, 0.5, 0.75, 1], "GL_TEXTURE_BORDER_COLOR");
    await call32("gles2:glTexParameterf", 0x0DE1, 0x1004, 1);
    assert.equal((await call32("gles2:glGetError")).ret, 0x0500, "a border color of one value: INVALID_ENUM");
    const sampler32 = i32s((await call32("gles2:glGenSamplers", 1, 4)).outs[0])[0];
    await call32("gles2:glSamplerParameteriv", sampler32, 0x1004, new Uint8Array(new Int32Array([0x7FFFFFFF, 0, 0, 0x7FFFFFFF]).buffer));
    const color = Array.from(new Float32Array((await call32("gles2:glGetSamplerParameterfv", sampler32, 0x1004, 16)).outs[0].slice().buffer));
    assert.ok(color[0] === 1 && Math.abs(color[1]) < 1e-6 && color[3] === 1, "an integer border color, normalized: " + color);
    assert.deepEqual(i32s((await call32("gles2:glGetSamplerParameteriv", sampler32, 0x1004, 16)).outs[0]), [0x7FFFFFFF, 0, 0, 0x7FFFFFFF]);
    assert.equal((await call32("gles2:glGetError")).ret, 0);
    console.log("PASS: GLES 3.2's clamp to border");

    // blend equations: MIN and MAX (GLES 3.0's); the advanced ones glBlendEquation's alone, a draw by one the fragment shader's declared
    await call32("gles2:glBlendEquation", 0x8007);
    assert.equal((await call32("gles2:glGetError")).ret, 0, "GL_MIN");
    await call32("gles2:glBlendEquationSeparate", 0x9294, 0x8006);
    assert.equal((await call32("gles2:glGetError")).ret, 0x0500, "an advanced equation, separate: INVALID_ENUM");
    await call32("gles2:glBlendEquation", 0x9294);
    assert.deepEqual(i32s((await call32("gles2:glGetIntegerv", 0x8009, 4)).outs[0]), [0x9294], "GL_BLEND_EQUATION_RGB: MULTIPLY_KHR");
    const blending = async declared =>
    {
        const program = (await call32("gles2:glCreateProgram")).ret;
        await call32("gles2:glAttachShader", program, await shader32(0x8B31, "#version 320 es\nin vec4 p;\nvoid main() { gl_Position = p; }"));
        await call32("gles2:glAttachShader", program, await shader32(0x8B30, "#version 320 es\nprecision mediump float;\n" + declared +
            "out vec4 o;\nvoid main() { o = vec4(1.0); }"));
        await call32("gles2:glLinkProgram", program);
        await call32("gles2:glUseProgram", program);
        await call32("gles2:glDrawArrays", 4, 0, 3);
        return (await call32("gles2:glGetError")).ret;
    };
    await call32("gles2:glEnable", 0x0BE2);
    assert.equal(await blending(""), 0x0502, "a fragment shader without blend_support_multiply: INVALID_OPERATION");
    assert.equal(await blending("layout(blend_support_all_equations) out;\n"), 0, "blend_support_all_equations");
    await call32("gles2:glDisable", 0x0BE2);
    await call32("gles2:glBlendEquation", 0x8006);
    await call32("gles2:glUseProgram", 0);
    console.log("PASS: GLES 3.2's blend equations");

    // tessellation: the program's layout; patches its draws', and only its
    const tessellation = (await call32("gles2:glCreateProgram")).ret;
    await call32("gles2:glAttachShader", tessellation, await shader32(0x8B31, "#version 320 es\nin vec4 p;\nvoid main() { gl_Position = p; }"));
    await call32("gles2:glAttachShader", tessellation, await shader32(0x8E88, "#version 320 es\nlayout(vertices = 4) out;\n" +
        "void main() { gl_out[gl_InvocationID].gl_Position = gl_in[0].gl_Position; gl_TessLevelOuter[0] = 2.0; }"));
    await call32("gles2:glAttachShader", tessellation, await shader32(0x8E87, "#version 320 es\nlayout(quads, fractional_odd_spacing, cw, point_mode) in;\n" +
        "void main() { gl_Position = gl_in[0].gl_Position; }"));
    await call32("gles2:glAttachShader", tessellation, await shader32(0x8B30, "#version 320 es\nprecision mediump float;\nout vec4 o;\nvoid main() { o = vec4(1.0); }"));
    await call32("gles2:glLinkProgram", tessellation);
    const tess_ints = async pname => i32s((await call32("gles2:glGetProgramiv", tessellation, pname, 4)).outs[0])[0];
    assert.equal(await tess_ints(0x8B82), 1, "a program of tessellation shaders links");
    assert.deepEqual([await tess_ints(0x8E75), await tess_ints(0x8E76), await tess_ints(0x8E77), await tess_ints(0x8E78), await tess_ints(0x8E79)],
        [4, 0x0007, 0x8E7B, 0x0900, 1], "TESS_CONTROL_OUTPUT_VERTICES, TESS_GEN_MODE, _SPACING, _VERTEX_ORDER, _POINT_MODE");
    await call32("gles2:glUseProgram", tessellation);
    await call32("gles2:glDrawArrays", 4, 0, 3);
    assert.equal((await call32("gles2:glGetError")).ret, 0x0502, "triangles to tessellation: INVALID_OPERATION");
    await call32("gles2:glDrawArrays", 0xE, 0, 3);
    assert.equal((await call32("gles2:glGetError")).ret, 0, "patches");
    await call32("gles2:glUseProgram", 0);
    await call32("gles2:glDrawArrays", 0xE, 0, 3);
    assert.equal((await call32("gles2:glGetError")).ret, 0x0502, "patches without tessellation: INVALID_OPERATION");
    console.log("PASS: GLES 3.2's tessellation");
}
