#!/usr/bin/env node
// The GLES host's GLES 3.x (docs/gles3-plan.md L2): the versions announced
// and the contexts made, GLSL ES 3.x's shaders compiled and linked by
// glslang on the CPU side, their link handed to the page in the batch
// (PROGRAM_LINK), and GLES 3.0's state, queries and errors, against the
// GLES 3.0 specification.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GLESHost } from "../../src/gles/gles_host.js";
import { GLESShadow } from "../../src/gles/gles_shadow.js";
import { compile_glslang, create_glslang } from "../../src/gles/glslang.js";
import { link_glslang_program, unpack_program } from "../../src/gles/glsl_program.js";
import { block_layout, parse_spirv } from "../../src/gles/spirv_patch.js";
import { client, cstring, fake_renderer, i32s, text } from "./lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..") + "/";
const glslang = await create_glslang(await compile_glslang(fs.readFileSync(root + "bios/glslang.wasm")));
const DISPLAY = { width: 480, height: 800, dpi: 240 };
const GL_VERSION = 0x1F02, GL_EXTENSIONS = 0x1F03, GL_SHADING_LANGUAGE_VERSION = 0x8B8C;

/** A host announcing `max_version`, a connection, a context of `api` current on a surface */
async function setup(max_version, api)
{
    const renderer = fake_renderer();
    const host = new GLESHost(DISPLAY, renderer, undefined, { glslang, max_version });
    const { call } = await client(host).connect();
    const context = (await call("rcCreateContext", 3, 0, api)).ret;
    let c = null;
    if(context)
    {
        const surface = (await call("rcCreateWindowSurface", 3, 320, 240)).ret;
        await call("rcMakeCurrent", context, surface, surface);
        c = host.shadow.context(context);
    }
    const gl_string = async name => text((await call("rcGetGLString", name, 2048, 2048)).outs[0]);
    return { host, renderer, call, context, c, gl_string };
}

// ---- versions: what is announced, what contexts are made
{
    const two = await setup("2.0", 3);
    assert.equal(two.context, 0, "no GLES 3 context where 2.0 is the highest announced");
    assert.ok(!(await two.gl_string(GL_EXTENSIONS)).includes("ANDROID_EMU"), "2.0: no host feature string");

    for(const [max, number] of [["3.0", 30], ["3.1", 31], ["3.2", 32]])
    {
        const s = await setup(max, 3);
        assert.ok(s.context, max + ": a GLES 3 context");
        assert.equal(s.c.api, 3);
        assert.equal(s.c.version, number, max + ": the context is the highest version announced");
        assert.equal(await s.gl_string(GL_VERSION), "OpenGL ES " + max + " v86");
        assert.equal(await s.gl_string(GL_SHADING_LANGUAGE_VERSION), "OpenGL ES GLSL ES " + (number / 10).toFixed(2));
        assert.ok((await s.gl_string(GL_EXTENSIONS)).includes("ANDROID_EMU_gles_max_version_" + max.replace(".", "_")),
            max + ": the host feature string the guest's libraries look for");
        // (GLES 2.0's extensions that 3.0 has in core: the guest's EGL makes GLES 2.0 contexts 3.x ones)
        const extensions = (await s.gl_string(GL_EXTENSIONS)).split(" ");
        for(const e of ["GL_OES_texture_npot", "GL_OES_element_index_uint", "GL_OES_standard_derivatives", "GL_OES_depth24"]) assert.ok(extensions.includes(e), max + ": " + e);
    }
    const four = await setup("3.2", 4);
    assert.equal(four.c.version, 32, "the guest asks 4 for 3.1 and 3.2");
    const es2 = await setup("3.2", 2);
    assert.equal(es2.c.api, 2, "a GLES 2.0 context stays one where 3.2 is announced");
    assert.equal(await es2.gl_string(GL_VERSION), "OpenGL ES 2.0 v86");
    console.log("PASS: versions announced, contexts made");
}

// ---- GLSL ES 3.x: glslang compiles and links on the CPU side; the page gets the link
{
    const { host, renderer, call } = await setup("3.0", 3);
    const VERTEX = 0x8B31, FRAGMENT = 0x8B30;
    const shader = async (type, source) =>
    {
        const name = (await call("gles2:glCreateShader", type)).ret;
        await call("gles2:glShaderString", name, cstring(source), source.length + 1);
        await call("gles2:glCompileShader", name);
        return name;
    };
    const shader_iv = async (name, pname) => i32s((await call("gles2:glGetShaderiv", name, pname, 4)).outs[0])[0];
    const program_iv = async (name, pname) => i32s((await call("gles2:glGetProgramiv", name, pname, 4)).outs[0])[0];
    const vs = await shader(VERTEX, "#version 300 es\nlayout(location = 2) in vec4 pos;\nin vec2 uv;\nuniform mat4 mvp;\nuniform float k[3];\n" +
        "out vec2 tc;\nvoid main() { tc = uv * k[2]; gl_Position = mvp * pos; }");
    const fs_ = await shader(FRAGMENT, "#version 300 es\nprecision mediump float;\nuniform sampler2D tex;\nin vec2 tc;\n" +
        "layout(location = 0) out vec4 color;\nvoid main() { color = texture(tex, tc); }");
    assert.equal(await shader_iv(vs, 0x8B81), 1, "a 300 es vertex shader compiles (GL_COMPILE_STATUS)");
    assert.equal(await shader_iv(fs_, 0x8B81), 1);
    const bad = await shader(FRAGMENT, "#version 300 es\nprecision mediump float;\nout vec4 c;\nvoid main() { c = vec4(1) + uint(1); }");
    assert.equal(await shader_iv(bad, 0x8B81), 0, "glslang's errors are the shader's");
    assert.ok(await shader_iv(bad, 0x8B84) > 1, "with an info log (GL_INFO_LOG_LENGTH)");

    const program = (await call("gles2:glCreateProgram")).ret;
    await call("gles2:glAttachShader", program, vs);
    await call("gles2:glAttachShader", program, fs_);
    await call("gles2:glBindAttribLocation", program, 5, cstring("uv"));
    await call("gles2:glLinkProgram", program);
    assert.equal(await program_iv(program, 0x8B82), 1, "linked (GL_LINK_STATUS)");
    assert.equal(await program_iv(program, 0x8B86), 3, "three active uniforms (GL_ACTIVE_UNIFORMS)");
    assert.equal(await program_iv(program, 0x8B89), 2, "two active attributes");
    assert.equal((await call("gles2:glGetAttribLocation", program, cstring("pos"))).ret, 2, "layout(location) wins");
    assert.equal((await call("gles2:glGetAttribLocation", program, cstring("uv"))).ret, 5, "glBindAttribLocation's");
    const location = async name => (await call("gles2:glGetUniformLocation", program, cstring(name))).ret;
    const mvp = await location("mvp"), k = await location("k"), k2 = await location("k[2]"), tex = await location("tex");
    assert.ok(mvp >= 0 && k >= 0 && tex >= 0 && k2 === k + 2, "uniform locations; an array's elements one after another");

    // the batch: the link's result before the glLinkProgram, which the page links with
    host.flush();
    const records = renderer.records();
    const at = records.findIndex(r => r.name === "PROGRAM_LINK");
    assert.ok(at >= 0 && records[at + 1].name === "COMMAND" && records[at + 1].command.name === "glLinkProgram",
        "PROGRAM_LINK goes just before its glLinkProgram");
    const info = unpack_program(records[at].bytes);
    assert.equal(info.ok, true);
    assert.deepEqual([info.locations.get("mvp"), info.locations.get("k[2]"), info.locations.get("tex")], [mvp, k2, tex],
        "the page's view of the program is the CPU side's");
    assert.deepEqual(info.spirv.map(m => m.stage), ["vertex", "fragment"], "with each stage's SPIR-V");
    assert.equal(info.spirv[0].words[0], 0x07230203, "SPIR-V's magic");
    const block = info.uniforms.find(u => u.name === "k[0]");
    assert.equal(block.array_stride, 16, "the default block is std140: a float array's stride is 16");

    // the page's shadow (no glslang) links with what came: the same view
    const page = new GLESShadow(null);
    page.create_context(1, 30, 0);
    const c = page.context(1);
    const object = { kind: "program", shaders: new Set(), bindings: new Map(), provided: info };
    assert.equal(page.link(object, [{ compiled: { glslang: true, ok: true }, type: VERTEX }]), info, "the provided link is the page's");
    assert.equal(object.provided, null, "and used once");
    assert.equal(page.link({ kind: "program", bindings: new Map() }, [{ compiled: { glslang: true, ok: true } }]).ok, false,
        "none provided: the page cannot link it");
    void c;
    console.log("PASS: GLSL ES 3.00 through glslang; the link in the batch");
}

// ---- GLES 3.0's state, queries and errors (GLES 3.0's tables 6.x and the commands' errors)
{
    const { call, c } = await setup("3.0", 3);
    const error = async () => (await call("gles2:glGetError")).ret;
    const get_i = async (pname, n = 1) => i32s((await call("gles2:glGetIntegerv", pname, 4 * n)).outs[0]);
    const gen = async (command, n = 1) => i32s((await call("gles2:" + command, n, 4 * n)).outs[0]);
    const ints = values => new Uint8Array(new Int32Array(values).buffer);
    const GL = { TEXTURE_2D: 0x0DE1, TEXTURE_3D: 0x806F, TEXTURE_2D_ARRAY: 0x8C1A, RGBA: 0x1908, RGBA8: 0x8058, UNSIGNED_BYTE: 0x1401,
        R32F: 0x822E, RED: 0x1903, FLOAT: 0x1406, RGBA32UI: 0x8D70, RGBA_INTEGER: 0x8D99, UNSIGNED_INT: 0x1405, FRAMEBUFFER: 0x8D40,
        DRAW_FRAMEBUFFER: 0x8CA9, READ_FRAMEBUFFER: 0x8CA8, RENDERBUFFER: 0x8D41, COLOR_ATTACHMENT0: 0x8CE0, DEPTH_ATTACHMENT: 0x8D00,
        STENCIL_ATTACHMENT: 0x8D20, DEPTH_STENCIL_ATTACHMENT: 0x821A, DEPTH24_STENCIL8: 0x88F0, DEPTH_COMPONENT16: 0x81A5,
        STENCIL_INDEX8: 0x8D48, ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893, UNIFORM_BUFFER: 0x8A11, COPY_READ: 0x8F36,
        COPY_WRITE: 0x8F37, STATIC_DRAW: 0x88E4, DYNAMIC_READ: 0x88E9 };

    assert.deepEqual(await get_i(0x821B), [3], "GL_MAJOR_VERSION");
    assert.deepEqual(await get_i(0x821C), [0], "GL_MINOR_VERSION");
    assert.deepEqual(await get_i(0x8D57), [4], "GL_MAX_SAMPLES");
    assert.deepEqual(await get_i(0x8CDF), [4], "GL_MAX_COLOR_ATTACHMENTS");
    assert.deepEqual(await get_i(0x8D6B), [0x7FFFFFFF], "GL_MAX_ELEMENT_INDEX through glGetIntegerv: clamped");
    const i64 = Array.from(new BigInt64Array((await call("gles2:glGetInteger64v", 0x8D6B, 8)).outs[0].slice().buffer));
    assert.deepEqual(i64, [0xFFFFFFFFn], "and its 64 bits through glGetInteger64v");
    assert.deepEqual(await get_i(0x8825), [0x0405], "GL_DRAW_BUFFER0 of the default framebuffer: GL_BACK");
    assert.equal(await error(), 0);

    // vertex array objects keep the attributes and the element buffer
    const [b1, b2] = await gen("glGenBuffers", 2);
    const [vao] = await gen("glGenVertexArrays");
    await call("gles2:glBindBuffer", GL.ELEMENT_ARRAY_BUFFER, b1);
    await call("gles2:glBindVertexArray", vao);
    assert.deepEqual(await get_i(0x8895), [0], "a new vertex array has no element buffer");
    await call("gles2:glBindBuffer", GL.ELEMENT_ARRAY_BUFFER, b2);
    await call("gles2:glEnableVertexAttribArray", 3);
    await call("gles2:glBindVertexArray", 0);
    assert.deepEqual(await get_i(0x8895), [b1], "the default one's came back");
    await call("gles2:glBindVertexArray", vao);
    assert.deepEqual(await get_i(0x8895), [b2], "and the vertex array's");
    assert.deepEqual(i32s((await call("gles2:glGetVertexAttribiv", 3, 0x8622, 4)).outs[0]), [1], "its enabled attribute");
    await call("gles2:glBindVertexArray", 0);
    assert.deepEqual(i32s((await call("gles2:glGetVertexAttribiv", 3, 0x8622, 4)).outs[0]), [0], "not the default one's");
    await call("gles2:glBindVertexArray", 12345);
    assert.equal(await error(), 0x0502, "binding a name glGenVertexArrays did not give: INVALID_OPERATION");
    // current values: the context's, whichever form set them last (a float form after an integer one: dEQP-GLES3
    // state_query.shader.current_vertex_attrib_float_to_int after _int and _uint), the same under another vertex array
    await call("gles2:glVertexAttribI4i", 5, -3, 4, 5, 6);
    await call("gles2:glVertexAttrib4f", 5, 2.5, -7.25, 63999.5, 1);
    assert.deepEqual(i32s((await call("gles2:glGetVertexAttribiv", 5, 0x8626, 16)).outs[0]), [3, -7, 64000, 1],
        "GL_CURRENT_VERTEX_ATTRIB of a float form after an integer one, rounded");
    await call("gles2:glBindVertexArray", vao);
    assert.deepEqual(Array.from(new Float32Array((await call("gles2:glGetVertexAttribfv", 5, 0x8626, 16)).outs[0].slice().buffer)),
        [2.5, -7.25, 63999.5, 1], "and under another vertex array");
    await call("gles2:glVertexAttrib2fv", 5, new Uint8Array(new Float32Array([-1.5, 8]).buffer));
    assert.deepEqual(i32s((await call("gles2:glGetVertexAttribiv", 5, 0x8626, 16)).outs[0]), [-1, 8, 0, 1], "glVertexAttrib2fv's, z 0 and w 1");
    await call("gles2:glBindVertexArray", 0);

    // buffers: targets, copies, mapping answers from the CPU side's bytes
    c.group; // (the share group holds buffers)
    await call("gles2:glBindBuffer", GL.COPY_READ, b1);
    await call("gles2:glBufferData", GL.COPY_READ, 8, ints([7, 9]), GL.STATIC_DRAW);
    await call("gles2:glBindBuffer", GL.COPY_WRITE, b2);
    await call("gles2:glBufferData", GL.COPY_WRITE, 8, null, GL.DYNAMIC_READ);
    assert.equal(await error(), 0);
    await call("gles2:glCopyBufferSubData", GL.COPY_READ, GL.COPY_WRITE, 0, 4, 4);
    const mapped = (await call("gles2:glMapBufferRangeAEMU", GL.COPY_WRITE, 0, 8, 1, 8)).outs[0];
    assert.deepEqual(i32s(mapped), [0, 7], "glMapBufferRange(READ) answers the copy's bytes");
    await call("gles2:glMapBufferRangeAEMU", GL.COPY_WRITE, 0, 8, 1, 8);
    assert.equal(await error(), 0x0502, "mapping a mapped buffer: INVALID_OPERATION");
    await call("gles2:glUnmapBufferAEMU", GL.COPY_WRITE, 0, 8, 1, ints([0, 0]), 1);
    await call("gles2:glMapBufferRangeAEMU", GL.COPY_WRITE, 0, 8, 2 | 4, 8);
    await call("gles2:glUnmapBufferAEMU", GL.COPY_WRITE, 0, 8, 2 | 4, ints([5, 6]), 1);
    assert.deepEqual(i32s((await call("gles2:glMapBufferRangeAEMU", GL.COPY_WRITE, 0, 8, 1, 8)).outs[0]), [5, 6], "what a write mapping wrote");
    await call("gles2:glUnmapBufferAEMU", GL.COPY_WRITE, 0, 8, 1, ints([0, 0]), 1);
    await call("gles2:glMapBufferRangeAEMU", GL.COPY_WRITE, 0, 8, 1 | 4, 8);
    assert.equal(await error(), 0x0502, "READ with INVALIDATE: INVALID_OPERATION");

    // indexed uniform buffer bindings
    await call("gles2:glBindBufferRange", GL.UNIFORM_BUFFER, 2, b1, 256, 4);
    assert.deepEqual(i32s((await call("gles2:glGetIntegeri_v", 0x8A28, 2, 4)).outs[0]), [b1], "GL_UNIFORM_BUFFER_BINDING[2]");
    assert.deepEqual(i32s((await call("gles2:glGetIntegeri_v", 0x8A29, 2, 4)).outs[0]), [256], "its start");
    await call("gles2:glBindBufferRange", GL.UNIFORM_BUFFER, 2, b1, 4, 4);
    assert.equal(await error(), 0x0501, "an offset not GL_UNIFORM_BUFFER_OFFSET_ALIGNMENT's multiple: INVALID_VALUE");

    // textures: 3D, arrays, storage, sized formats, parameters
    const [t3, ta, t2] = await gen("glGenTextures", 3);
    await call("gles2:glBindTexture", GL.TEXTURE_3D, t3);
    await call("gles2:glTexImage3D", GL.TEXTURE_3D, 0, GL.RGBA8, 4, 4, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(256));
    assert.equal(await error(), 0, "a 3D texture's image");
    await call("gles2:glTexImage3D", GL.TEXTURE_3D, 0, GL.RGBA8, 4, 4, 4, 0, GL.RGBA, GL.FLOAT, null);
    assert.equal(await error(), 0x0502, "RGBA8 of floats: INVALID_OPERATION");
    await call("gles2:glBindTexture", GL.TEXTURE_2D_ARRAY, ta);
    await call("gles2:glTexStorage3D", GL.TEXTURE_2D_ARRAY, 3, GL.R32F, 8, 8, 2);
    assert.equal(await error(), 0);
    const tex_i = async (target, pname) => i32s((await call("gles2:glGetTexParameteriv", target, pname, 4)).outs[0])[0];
    assert.equal(await tex_i(GL.TEXTURE_2D_ARRAY, 0x912F), 1, "GL_TEXTURE_IMMUTABLE_FORMAT");
    assert.equal(await tex_i(GL.TEXTURE_2D_ARRAY, 0x82DF), 3, "GL_TEXTURE_IMMUTABLE_LEVELS");
    await call("gles2:glTexImage3D", GL.TEXTURE_2D_ARRAY, 0, GL.R32F, 8, 8, 2, 0, GL.RED, GL.FLOAT, null);
    assert.equal(await error(), 0x0502, "an immutable texture's image: INVALID_OPERATION");
    await call("gles2:glTexStorage3D", GL.TEXTURE_2D_ARRAY, 5, GL.R32F, 8, 8, 2);
    assert.equal(await error(), 0x0502, "more levels than log2(8) + 1: INVALID_OPERATION");
    await call("gles2:glBindTexture", GL.TEXTURE_2D, t2);
    await call("gles2:glTexParameteri", GL.TEXTURE_2D, 0x8E42, 0x1906);
    await call("gles2:glTexParameteri", GL.TEXTURE_2D, 0x813C, 2);
    assert.equal(await tex_i(GL.TEXTURE_2D, 0x8E42), 0x1906, "GL_TEXTURE_SWIZZLE_R");
    assert.equal(await tex_i(GL.TEXTURE_2D, 0x813C), 2, "GL_TEXTURE_BASE_LEVEL");
    await call("gles2:glTexParameteri", GL.TEXTURE_2D, 0x813C, -1);
    assert.equal(await error(), 0x0501, "a negative base level: INVALID_VALUE");

    // samplers
    const [s1] = i32s((await call("gles2:glGenSamplers", 1, 4)).outs[0]);
    await call("gles2:glBindSampler", 3, s1);
    await call("gles2:glSamplerParameteri", s1, 0x2802, 0x812F);
    assert.deepEqual(i32s((await call("gles2:glGetSamplerParameteriv", s1, 0x2802, 4)).outs[0]), [0x812F], "a sampler's wrap");
    await call("gles2:glActiveTexture", 0x84C3);
    assert.deepEqual(await get_i(0x8919), [s1], "GL_SAMPLER_BINDING of unit 3");
    await call("gles2:glSamplerParameteri", s1, 0x813C, 1);
    assert.equal(await error(), 0x0500, "a texture's own parameter on a sampler: INVALID_ENUM");

    // framebuffers: draw and read, GLES 3.0's completeness
    const [fbo] = await gen("glGenFramebuffers");
    const [rb_color, rb_depth] = await gen("glGenRenderbuffers", 2);
    await call("gles2:glBindFramebuffer", GL.DRAW_FRAMEBUFFER, fbo);
    assert.deepEqual(await get_i(0x8CA6), [fbo], "GL_DRAW_FRAMEBUFFER_BINDING");
    assert.deepEqual(await get_i(0x8CAA), [0], "GL_READ_FRAMEBUFFER_BINDING stays");
    const status = async target => (await call("gles2:glCheckFramebufferStatus", target)).ret;
    assert.equal(await status(GL.DRAW_FRAMEBUFFER), 0x8CD7, "no attachment: INCOMPLETE_MISSING_ATTACHMENT");
    await call("gles2:glBindRenderbuffer", GL.RENDERBUFFER, rb_color);
    await call("gles2:glRenderbufferStorage", GL.RENDERBUFFER, GL.RGBA8, 16, 16);
    await call("gles2:glFramebufferRenderbuffer", GL.DRAW_FRAMEBUFFER, GL.COLOR_ATTACHMENT0 + 1, GL.RENDERBUFFER, rb_color);
    await call("gles2:glBindRenderbuffer", GL.RENDERBUFFER, rb_depth);
    await call("gles2:glRenderbufferStorage", GL.RENDERBUFFER, GL.DEPTH24_STENCIL8, 32, 32);
    await call("gles2:glFramebufferRenderbuffer", GL.DRAW_FRAMEBUFFER, GL.DEPTH_STENCIL_ATTACHMENT, GL.RENDERBUFFER, rb_depth);
    assert.equal(await status(GL.DRAW_FRAMEBUFFER), 0x8CD5, "complete: sizes may differ in GLES 3.0");
    const attachment_i = async (attachment, pname) =>
        i32s((await call("gles2:glGetFramebufferAttachmentParameteriv", GL.DRAW_FRAMEBUFFER, attachment, pname, 4)).outs[0])[0];
    assert.equal(await attachment_i(GL.STENCIL_ATTACHMENT, 0x8CD1), rb_depth, "DEPTH_STENCIL_ATTACHMENT attached both");
    assert.equal(await attachment_i(GL.COLOR_ATTACHMENT0 + 1, 0x8215), 8, "GL_FRAMEBUFFER_ATTACHMENT_ALPHA_SIZE");
    assert.equal(await attachment_i(GL.COLOR_ATTACHMENT0 + 1, 0x8211), 0x8C17, "GL_FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE");
    await call("gles2:glDrawBuffers", 2, ints([0, GL.COLOR_ATTACHMENT0 + 1]));
    assert.deepEqual([...await get_i(0x8825), ...await get_i(0x8826)], [0, GL.COLOR_ATTACHMENT0 + 1], "GL_DRAW_BUFFER0 and 1");
    await call("gles2:glDrawBuffers", 1, ints([GL.COLOR_ATTACHMENT0 + 1]));
    assert.equal(await error(), 0x0502, "COLOR_ATTACHMENT1 as draw buffer 0: INVALID_OPERATION");
    const [rb_stencil] = await gen("glGenRenderbuffers");
    await call("gles2:glBindRenderbuffer", GL.RENDERBUFFER, rb_stencil);
    await call("gles2:glRenderbufferStorage", GL.RENDERBUFFER, GL.STENCIL_INDEX8, 32, 32);
    await call("gles2:glFramebufferRenderbuffer", GL.DRAW_FRAMEBUFFER, GL.STENCIL_ATTACHMENT, GL.RENDERBUFFER, rb_stencil);
    assert.equal(await status(GL.DRAW_FRAMEBUFFER), 0x8CDD, "depth and stencil as two images: UNSUPPORTED");
    await call("gles2:glRenderbufferStorageMultisample", GL.RENDERBUFFER, 4, GL.RGBA32UI, 8, 8);
    assert.equal(await error(), 0x0502, "an integer format multisampled: INVALID_OPERATION");
    await call("gles2:glRenderbufferStorageMultisample", GL.RENDERBUFFER, 4, GL.RGBA8, 8, 8);
    assert.deepEqual(i32s((await call("gles2:glGetRenderbufferParameteriv", GL.RENDERBUFFER, 0x8CAB, 4)).outs[0]), [4], "GL_RENDERBUFFER_SAMPLES");
    await call("gles2:glBindFramebuffer", GL.FRAMEBUFFER, 0);
    await call("gles2:glBlitFramebuffer", 0, 0, 1, 1, 0, 0, 1, 1, 0x0100, 0x2601);
    assert.equal(await error(), 0x0502, "a linear blit of depth: INVALID_OPERATION");
    await call("gles2:glClearBufferfv", 0x1800, 4, ints([0, 0, 0, 0]));
    assert.equal(await error(), 0x0501, "clearing draw buffer 4 of 4: INVALID_VALUE");

    // queries and syncs
    const [q] = await gen("glGenQueries");
    await call("gles2:glBeginQuery", 0x8C2F, q);
    await call("gles2:glBeginQuery", 0x8D6A, q);
    assert.equal(await error(), 0x0502, "two occlusion queries at once: INVALID_OPERATION");
    assert.deepEqual(i32s((await call("gles2:glGetQueryiv", 0x8C2F, 0x8865, 4)).outs[0]), [q], "GL_CURRENT_QUERY");
    await call("gles2:glDrawArrays", 4, 0, 3);
    await call("gles2:glEndQuery", 0x8C2F);
    assert.deepEqual(i32s((await call("gles2:glGetQueryObjectuiv", q, 0x8867, 4)).outs[0]), [1], "GL_QUERY_RESULT_AVAILABLE");
    const sync = (await call("gles2:glFenceSyncAEMU", 0x9117, 0)).ret;
    assert.ok(sync > 0, "a fence");
    assert.equal((await call("gles2:glClientWaitSyncAEMU", sync, 0, 0)).ret, 0x911A, "GL_ALREADY_SIGNALED");
    assert.equal((await call("gles2:glIsSyncAEMU", sync)).ret, 1);
    await call("gles2:glDeleteSyncAEMU", sync);
    assert.equal((await call("gles2:glIsSyncAEMU", sync)).ret, 0);
    assert.equal(await error(), 0);
    // (an unused name bound makes a buffer, texture, framebuffer or renderbuffer, as in GLES 2.0: the guest's
    // EGL makes GLES 2.0's contexts the host's highest version, and dEQP-GLES2 binds names it never generated;
    // a vertex array's must be generated)
    await call("gles2:glBindBuffer", 0x8892, 900);
    await call("gles2:glBindBufferBase", 0x8A11, 0, 901);
    await call("gles2:glBindTexture", 0x0DE1, 902);
    await call("gles2:glBindFramebuffer", 0x8D40, 903);
    await call("gles2:glBindRenderbuffer", 0x8D41, 904);
    await call("gles2:glRenderbufferStorage", 0x8D41, 0x8058, 4, 4);
    await call("gles2:glFramebufferRenderbuffer", 0x8D40, 0x8CE0, 0x8D41, 904);
    assert.equal(await error(), 0, "unused names bound");
    assert.deepEqual(i32s((await call("gles2:glGetFramebufferAttachmentParameteriv", 0x8D40, 0x8CE0, 0x8CD1, 4)).outs[0]), [904]);
    assert.equal((await call("gles2:glIsFramebuffer", 903)).ret, 1);
    await call("gles2:glBindFramebuffer", 0x8D40, 0);
    await call("gles2:glBindVertexArray", 905);
    assert.equal(await error(), 0x0502, "an unused vertex array name: INVALID_OPERATION");
    // (errors dEQP-GLES3's negative_api expects of these: a 3D texture of depth's format, a depth of 0, an unpack buffer's
    // offset not a whole number of the type's datums, a level past the largest; SAMPLES of a multisampled framebuffer)
    const tex3d = 910, tex_array = 911, unpack = 912;
    await call("gles2:glBindTexture", 0x806F, tex3d);
    await call("gles2:glTexImage3D", 0x806F, 0, 0x84F9, 1, 1, 1, 0, 0x84F9, 0x84FA, null);
    assert.equal(await error(), 0x0502, "TexImage3D of TEXTURE_3D and DEPTH_STENCIL: INVALID_OPERATION");
    await call("gles2:glTexStorage3D", 0x806F, 1, 0x8058, 4, 4, 0);
    assert.equal(await error(), 0x0501, "TexStorage3D of depth 0: INVALID_VALUE");
    await call("gles2:glBindTexture", 0x0DE1, 913);
    await call("gles2:glTexStorage2D", 0x0DE1, 1, 0x8056, 4, 4);
    await call("gles2:glBindBuffer", 0x88EC, unpack);
    await call("gles2:glBufferData", 0x88EC, 64, null, 0x88E4);
    await call("gles2:glTexSubImage2DOffsetAEMU", 0x0DE1, 0, 0, 0, 4, 4, 0x1908, 0x8033, 3);
    assert.equal(await error(), 0x0502, "an unpack buffer's offset of 3 for 16-bit datums: INVALID_OPERATION");
    await call("gles2:glBindBuffer", 0x88EC, 0);
    await call("gles2:glBindTexture", 0x8C1A, tex_array);
    await call("gles2:glCompressedTexSubImage3D", 0x8C1A, 13, 0, 0, 0, 0, 0, 0, 0x9278, 0, null);
    assert.equal(await error(), 0x0501, "CompressedTexSubImage3D of level 13: INVALID_VALUE");
    await call("gles2:glBindRenderbuffer", 0x8D41, 914);
    await call("gles2:glRenderbufferStorageMultisample", 0x8D41, 4, 0x8058, 4, 4);
    await call("gles2:glBindFramebuffer", 0x8D40, 915);
    await call("gles2:glFramebufferRenderbuffer", 0x8D40, 0x8CE0, 0x8D41, 914);
    assert.deepEqual([i32s((await call("gles2:glGetIntegerv", 0x80A8, 4)).outs[0])[0], i32s((await call("gles2:glGetIntegerv", 0x80A9, 4)).outs[0])[0]], [1, 4],
        "SAMPLE_BUFFERS and SAMPLES of a multisampled framebuffer");
    await call("gles2:glBindFramebuffer", 0x8D40, 0);
    assert.equal(await error(), 0);
    // (a buffer deleted is unbound from the bound vertex array alone; a cube map face's attachment answers its target;
    // a renderbuffer of GLES 3.0's sized formats its sizes)
    const two_vaos = i32s((await call("gles2:glGenVertexArrays", 2, 8)).outs[0]);
    const kept = i32s((await call("gles2:glGenBuffers", 1, 4)).outs[0])[0];
    await call("gles2:glBindVertexArray", two_vaos[1]);
    await call("gles2:glBindBuffer", 0x8893, kept);
    await call("gles2:glBindVertexArray", two_vaos[0]);
    await call("gles2:glDeleteBuffers", 1, new Uint8Array(new Int32Array([kept]).buffer));
    await call("gles2:glBindVertexArray", two_vaos[1]);
    assert.deepEqual(i32s((await call("gles2:glGetIntegerv", 0x8895, 4)).outs[0]), [kept], "another vertex array keeps a deleted buffer's name");
    await call("gles2:glBindVertexArray", 0);
    await call("gles2:glBindTexture", 0x8513, 920);
    await call("gles2:glTexStorage2D", 0x8513, 1, 0x8058, 4, 4);
    await call("gles2:glBindFramebuffer", 0x8D40, 921);
    await call("gles2:glFramebufferTexture2D", 0x8D40, 0x8CE0, 0x8515, 920, 0);
    assert.deepEqual(i32s((await call("gles2:glGetFramebufferAttachmentParameteriv", 0x8D40, 0x8CE0, 0x8CD3, 4)).outs[0]), [0x8515], "the face POSITIVE_X");
    await call("gles2:glBindFramebuffer", 0x8D40, 0);
    await call("gles2:glBindRenderbuffer", 0x8D41, 922);
    await call("gles2:glRenderbufferStorage", 0x8D41, 0x8229, 4, 4);
    assert.deepEqual(i32s((await call("gles2:glGetRenderbufferParameteriv", 0x8D41, 0x8D50, 4)).outs[0]), [8], "R8's RENDERBUFFER_RED_SIZE");
    assert.equal(await error(), 0);
    // (a stencil mask is unsigned, a level of detail rounded by an integer query)
    await call("gles2:glStencilFunc", 0x0207, 0, 0xFFFFFFFF);
    assert.deepEqual(Array.from(new Float32Array((await call("gles2:glGetFloatv", 0x0B93, 4)).outs[0].slice().buffer)), [4294967296], "STENCIL_VALUE_MASK as a float");
    await call("gles2:glTexParameterf", 0x0DE1, 0x813A, -74.75);
    assert.deepEqual(i32s((await call("gles2:glGetTexParameteriv", 0x0DE1, 0x813A, 4)).outs[0]), [-75], "TEXTURE_MIN_LOD rounded");
    // (GLES 3.0 takes SRC_ALPHA_SATURATE as a destination factor too; GLES 2.0 as a source's alone)
    await call("gles2:glBlendFuncSeparate", 0x0305, 0x0308, 0x0303, 0x0308);
    assert.equal(await error(), 0, "SRC_ALPHA_SATURATE as a destination factor");
    console.log("PASS: GLES 3.0's state: vertex arrays, buffers, textures, samplers, framebuffers, queries, syncs; unused names bound");
}

// ---- GLES 3.0's programs: uniform blocks, unsigned and non-square uniforms, transform feedback's varyings
{
    const { call, renderer } = await setup("3.0", 3);
    const error = async () => (await call("gles2:glGetError")).ret;
    const shader = async (type, source) =>
    {
        const name = (await call("gles2:glCreateShader", type)).ret;
        await call("gles2:glShaderString", name, cstring(source), source.length + 1);
        await call("gles2:glCompileShader", name);
        return name;
    };
    const vs = await shader(0x8B31, "#version 300 es\nlayout(std140) uniform Light { vec4 color; mat3 m; float k[2]; } light;\n" +
        "uniform uint count;\nuniform mat2x3 tm;\nin vec4 pos;\nout vec3 v;\nflat out uint n;\n" +
        "void main() { v = light.m * light.color.rgb * light.k[1] + tm * vec2(1.0); n = count; gl_Position = pos; }");
    const fs_ = await shader(0x8B30, "#version 300 es\nprecision mediump float;\nin vec3 v;\nflat in uint n;\nout vec4 c;\n" +
        "void main() { c = vec4(v, float(n)); }");
    const program = (await call("gles2:glCreateProgram")).ret;
    await call("gles2:glAttachShader", program, vs);
    await call("gles2:glAttachShader", program, fs_);
    await call("gles2:glTransformFeedbackVaryingsAEMU", program, 2, cstring("v;gl_Position;"), 16, 0x8C8C);
    await call("gles2:glLinkProgram", program);
    assert.equal(i32s((await call("gles2:glGetProgramiv", program, 0x8B82, 4)).outs[0])[0], 1, "linked");
    const block = (await call("gles2:glGetUniformBlockIndex", program, cstring("Light"))).ret;
    assert.equal(block, 0, "glGetUniformBlockIndex");
    const block_iv = async pname => i32s((await call("gles2:glGetActiveUniformBlockiv", program, block, pname, 64)).outs[0]);
    assert.equal((await block_iv(0x8A40))[0], 96, "GL_UNIFORM_BLOCK_DATA_SIZE: std140's vec4, mat3, float[2]");
    assert.equal((await block_iv(0x8A42))[0], 3, "three active uniforms in it");
    const indices = i32s((await call("gles2:glGetUniformIndicesAEMU", program, 2, cstring("Light.m;Light.k[0]"), 18, 8)).outs[0]);
    assert.ok(indices.every(i => i >= 0), "glGetUniformIndices");
    const offsets = i32s((await call("gles2:glGetActiveUniformsiv", program, 2, new Uint8Array(new Int32Array(indices).buffer), 0x8A3B, 8)).outs[0]);
    assert.deepEqual(offsets, [16, 64], "std140 offsets: mat3 at 16, the float array at 64");
    const strides = i32s((await call("gles2:glGetActiveUniformsiv", program, 2, new Uint8Array(new Int32Array(indices).buffer), 0x8A3C, 8)).outs[0]);
    assert.deepEqual(strides, [0, 16], "the array's stride 16");
    await call("gles2:glUniformBlockBinding", program, block, 5);
    assert.equal((await block_iv(0x8A3F))[0], 5, "GL_UNIFORM_BLOCK_BINDING");

    await call("gles2:glUseProgram", program);
    const count = (await call("gles2:glGetUniformLocation", program, cstring("count"))).ret;
    const tm = (await call("gles2:glGetUniformLocation", program, cstring("tm"))).ret;
    await call("gles2:glUniform1ui", count, 0xFFFFFFF0);
    assert.deepEqual(Array.from(new Uint32Array((await call("gles2:glGetUniformuiv", program, count, 4)).outs[0].slice().buffer)), [0xFFFFFFF0],
        "glUniform1ui and glGetUniformuiv");
    await call("gles2:glUniform1i", count, 3);
    assert.equal(await error(), 0x0502, "glUniform1i on a uint: INVALID_OPERATION");
    await call("gles2:glUniformMatrix2x3fv", tm, 1, 0, new Uint8Array(new Float32Array([1, 2, 3, 4, 5, 6]).buffer));
    assert.equal(await error(), 0);
    await call("gles2:glUniformMatrix3x2fv", tm, 1, 0, new Uint8Array(new Float32Array([1, 2, 3, 4, 5, 6]).buffer));
    assert.equal(await error(), 0x0502, "a 3x2 matrix into a 2x3: INVALID_OPERATION");

    assert.deepEqual(i32s((await call("gles2:glGetProgramiv", program, 0x8C83, 4)).outs[0]), [2], "GL_TRANSFORM_FEEDBACK_VARYINGS");
    const varying = await call("gles2:glGetTransformFeedbackVarying", program, 0, 16, 4, 4, 4, 16);
    assert.deepEqual([text(varying.outs[3]), i32s(varying.outs[2])[0], i32s(varying.outs[1])[0]], ["v", 0x8B51, 1], "varying 0: v, vec3");
    const bad = (await call("gles2:glCreateProgram")).ret;
    await call("gles2:glAttachShader", bad, vs);
    await call("gles2:glAttachShader", bad, fs_);
    await call("gles2:glTransformFeedbackVaryingsAEMU", bad, 1, cstring("nothing;"), 9, 0x8C8C);
    await call("gles2:glLinkProgram", bad);
    assert.equal(i32s((await call("gles2:glGetProgramiv", bad, 0x8B82, 4)).outs[0])[0], 0, "a varying the shader lacks: no link");

    // a buffer transform feedback wrote: its map's bytes are the page's (BUFFER_READ), unless the map invalidates them
    const feedback = i32s((await call("gles2:glGenBuffers", 1, 4)).outs[0])[0];
    await call("gles2:glBindBuffer", 0x8C8E, feedback);
    await call("gles2:glBufferData", 0x8C8E, 84, null, 0x88E1);
    await call("gles2:glBindBufferBase", 0x8C8E, 0, feedback);
    await call("gles2:glBeginTransformFeedback", 4);
    await call("gles2:glDrawArrays", 4, 0, 3);
    await call("gles2:glEndTransformFeedback");
    assert.equal(await error(), 0, "a capture of a triangle");
    const reads = () => renderer.records().filter(r => r.name === "BUFFER_READ");
    const mapped = (await call("gles2:glMapBufferRangeAEMU", 0x8C8E, 8, 76, 1, 76)).outs[0];
    const read = reads().at(-1);
    assert.ok(read && read.buffer === feedback && read.offset === 8 && read.length === 76, "glMapBufferRange of it asks the page");
    assert.ok(mapped.every(b => b === (read.request & 0xFF)), "the page's bytes mapped");
    await call("gles2:glUnmapBufferAEMU", 0x8C8E, 8, 76, 1, null, 4);
    await call("gles2:glMapBufferRangeAEMU", 0x8C8E, 0, 84, 2 | 8, 84);
    assert.equal(reads().length, 1, "a map that invalidates the buffer asks nothing");
    await call("gles2:glUnmapBufferAEMU", 0x8C8E, 0, 84, 2 | 8, new Uint8Array(84), 4);

    // occlusion queries: the page's result for one that drew (asked once), none for one that did not
    const queries = i32s((await call("gles2:glGenQueries", 2, 8)).outs[0]);
    const asked = () => renderer.records().filter(r => r.name === "QUERY_READ");
    await call("gles2:glBeginQuery", 0x8C2F, queries[0]);
    await call("gles2:glEndQuery", 0x8C2F);
    assert.equal(i32s((await call("gles2:glGetQueryObjectuiv", queries[0], 0x8866, 4)).outs[0])[0], 0, "nothing drawn: 0");
    assert.equal(asked().length, 0, "and the page not asked");
    await call("gles2:glBeginQuery", 0x8C2F, queries[1]);
    await call("gles2:glDrawArrays", 4, 0, 3);
    await call("gles2:glEndQuery", 0x8C2F);
    await call("gles2:glGetQueryObjectuiv", queries[1], 0x8866, 4);
    await call("gles2:glGetQueryObjectuiv", queries[1], 0x8866, 4);
    assert.ok(asked().length === 1 && asked()[0].query === queries[1], "a query that drew: the page asked, once");
    console.log("PASS: GLES 3.0's programs: uniform blocks, uint and 2x3 uniforms, transform feedback's varyings");
}

// ---- uniform blocks without a packing of their own (shared, std140 from a default statement): their structs' arrays and
// matrices at std140's offsets too, which glslang's reflection gives only blocks that name std140 (dEQP-GLES3 ubo.random.nested_structs.22)
{
    const vs = `#version 300 es
struct sB { highp mat4x2 mA[3]; highp uvec4 mB; };
struct sC { mediump uvec3 mA; sB mC; };
struct sA { mediump vec3 mA; highp mat2x3 mB; lowp mat2x3 mC; };
layout(column_major) uniform BlockC { sC d; mediump vec2 e; };
layout(std140) uniform;
layout(row_major) uniform BlockB { sA b; } blockB;
in vec4 p;
void main() { gl_Position = p + vec4(d.mC.mA[2][3], float(d.mC.mB.x), e) + vec4(blockB.b.mC[1], 1.0); }`;
    const info = link_glslang_program(glslang, [{ stage: "vertex", source: vs },
        { stage: "fragment", source: "#version 300 es\nprecision mediump float;\nout vec4 o;\nvoid main() { o = vec4(1.0); }" }], {});
    assert.ok(info.ok, info.log);
    const at = name => { const u = info.uniforms.find(x => x.name === name); return [u.offset, u.array_stride, u.matrix_stride]; };
    assert.deepEqual(["d.mC.mA[0]", "d.mC.mB", "e"].map(at), [[16, 64, 16], [208, 0, 0], [224, 0, 0]],
        "a shared block's struct: mat4x2's 64-byte elements, the members after them");
    assert.deepEqual(["BlockB.b.mB", "BlockB.b.mC"].map(at), [[16, 0, 16], [64, 0, 16]], "a default std140 block's struct: row major mat2x3s 48 bytes each");
    // (the code's offsets, the SPIR-V's)
    const words = new Uint32Array(info.spirv.find(m => m.stage === "vertex").words);
    for(const [block, prefix] of [["BlockC", ""], ["BlockB", "BlockB."]])
    {
        for(const [name, leaf] of block_layout(words, parse_spirv(words), block)) assert.equal(at(prefix + name)[0], leaf.offset, name + ": the code's offset");
    }
    console.log("PASS: uniform blocks of the default packing: their structs at std140's offsets");
}

// ---- GLSL ES 1.00 through glslang: what 3.00 reads differently
{
    const link = (vs, fs, bindings = new Map()) => link_glslang_program(glslang, [{ stage: "vertex", source: vs }, { stage: "fragment", source: fs }],
        { bindings, separable: false });
    // (a user overload of a built-in, which 1.00 allows: its calls the user's, step's own the built-in's)
    const overload = link("attribute vec4 p; void main() { gl_Position = p; }",
        "precision mediump float; int step(float i, float j, int a) { return -a; }\n" +
        "void main() { gl_FragColor = vec4(float(step(0.0, 1.0, 2)), step(0.5, 1.0), 0.0, 1.0); }");
    assert.ok(overload.ok, "an overload of step links: " + overload.log);
    // (a built-in called in a global's initializer, its argument in parentheses: a call, not the user's overload;
    // dEQP-GLES2 random.all_features)
    const global_call = link("attribute vec4 p; float b = exp(log2((float(5))) - 1.0); const float c = sqrt((4.0));\n" +
        "void main() { gl_Position = p * b * c; }", "precision mediump float; void main() { gl_FragColor = vec4(1.0); }");
    assert.ok(global_call.ok, "built-ins called in globals' initializers: " + global_call.log);
    // (unused attributes: locations of their own, not one glBindAttribLocation gave a used one)
    const unused = link("attribute vec4 a_coords; attribute vec4 a_position; attribute mat2 a_m; void main() { gl_Position = a_position; }",
        "precision mediump float; void main() { gl_FragColor = vec4(1.0); }", new Map([["a_position", 1]]));
    assert.ok(unused.ok, unused.log);
    assert.deepEqual(unused.attributes.map(a => [a.name, a.location]), [["a_position", 1]]);
    const locations = unused.unused_inputs.map(u => u.location);
    assert.ok(!locations.includes(1) && new Set(locations).size === 3, "the unused inputs' locations: " + locations);
    assert.deepEqual(unused.unused_inputs.map(u => u.components), [4, 2, 2], "a vec4, a mat2's two columns");
    // (a struct's array of one active element is still an array: a count past it is ignored, not refused)
    const nested = link("attribute vec4 p; struct T { float a; vec2 b[2]; }; uniform T t[2]; varying vec2 v; void main() { v = t[1].b[0]; gl_Position = p; }",
        "precision mediump float; varying vec2 v; void main() { gl_FragColor = vec4(v, 0.0, 1.0); }");
    const b = nested.uniforms.find(u => u.base === "t[1].b");
    assert.ok(b && b.size === 1 && b.name === "t[1].b[0]", JSON.stringify(nested.uniforms.map(u => u.name)));
    const { call } = await setup("3.0", 2);
    const program = (await call("gles2:glCreateProgram")).ret;
    for(const [type, source] of [[0x8B31, "attribute vec4 p; struct T { float a; vec2 b[2]; }; uniform T t[2]; varying vec2 v; " +
        "void main() { v = t[1].b[0]; gl_Position = p; }"], [0x8B30, "precision mediump float; varying vec2 v; void main() { gl_FragColor = vec4(v, 0.0, 1.0); }"]])
    {
        const shader = (await call("gles2:glCreateShader", type)).ret;
        await call("gles2:glShaderString", shader, cstring(source), source.length + 1);
        await call("gles2:glCompileShader", shader);
        await call("gles2:glAttachShader", program, shader);
    }
    await call("gles2:glLinkProgram", program);
    await call("gles2:glUseProgram", program);
    const location = (await call("gles2:glGetUniformLocation", program, cstring("t[1].b"))).ret;
    await call("gles2:glUniform2fv", location, 2, new Uint8Array(new Float32Array([1, 2, 3, 4]).buffer));
    assert.equal((await call("gles2:glGetError")).ret, 0, "glUniform2fv of 2 into t[1].b");
    // (GLSL ES 3.00: an #extension after the shader's code does not compile)
    const late = (await call("gles2:glCreateShader", 0x8B31)).ret;
    const late_source = "#version 300 es\nprecision mediump float;\n#extension GL_OES_EGL_image_external : enable\nvoid main() { gl_Position = vec4(0.0); }";
    await call("gles2:glShaderString", late, cstring(late_source), late_source.length + 1);
    await call("gles2:glCompileShader", late);
    assert.deepEqual(i32s((await call("gles2:glGetShaderiv", late, 0x8B81, 4)).outs[0]), [0], "an #extension after code: not compiled");
    // (the built-in constants are glGet's answers: an array sized -1 when one differs does not compile)
    const compiles = async (type, source) =>
    {
        const shader = (await call("gles2:glCreateShader", type)).ret;
        await call("gles2:glShaderString", shader, cstring(source), source.length + 1);
        await call("gles2:glCompileShader", shader);
        return i32s((await call("gles2:glGetShaderiv", shader, 0x8B81, 4)).outs[0])[0];
    };
    const sized = (version, test) => `${version}float a[${test} ? 1 : -1]; void main() { gl_Position = vec4(a[0]); }`;
    for(const [name, pname] of [["gl_MaxVertexAttribs", 0x8869], ["gl_MaxVertexUniformVectors", 0x8DFB], ["gl_MaxVaryingVectors", 0x8DFC],
        ["gl_MaxFragmentUniformVectors", 0x8DFD], ["gl_MaxCombinedTextureImageUnits", 0x8B4D], ["gl_MaxVertexTextureImageUnits", 0x8B4C],
        ["gl_MaxTextureImageUnits", 0x8872]])
    {
        const value = i32s((await call("gles2:glGetIntegerv", pname, 4)).outs[0])[0];
        assert.equal(await compiles(0x8B31, sized("", `${name} == ${value}`)), 1, `GLSL ES 1.00's ${name} is ${value}`);
        // (GLSL ES 3.00 has no gl_MaxVaryingVectors: its outputs' and inputs' instead)
        if(pname !== 0x8DFC) assert.equal(await compiles(0x8B31, sized("#version 300 es\n", `${name} == ${value}`)), 1, `GLSL ES 3.00's ${name} is ${value}`);
    }
    assert.equal(await compiles(0x8B31, sized("", "gl_MaxDrawBuffers == 1")), 1, "GLSL ES 1.00's gl_MaxDrawBuffers: 1");
    assert.equal(await compiles(0x8B31, sized("#version 300 es\n", "gl_MaxDrawBuffers == 4 && gl_MaxVertexOutputVectors == 16 && " +
        "gl_MaxFragmentInputVectors == 15 && gl_MinProgramTexelOffset == -8 && gl_MaxProgramTexelOffset == 7")), 1, "GLSL ES 3.00's");
    assert.equal(await compiles(0x8B31, sized("", "gl_MaxVertexTextureImageUnits == 32")), 0, "glslang's own default is not");
    console.log("PASS: GLSL ES 1.00 through glslang: overloads of built-ins, unused attributes, a one-element array; a late #extension; " +
        "the built-in constants");
}
