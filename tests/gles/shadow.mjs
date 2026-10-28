#!/usr/bin/env node
// The shadow state (src/gles/gles_shadow.js; docs/gles-proxy-plan.md E2)
// against the OpenGL ES 2.0 specification, through the host as the guest
// drives it:
// - the initial state and glGet's conversions (booleans, integers, floats,
//   normalized colors), enables;
// - errors: the first one stays until glGetError; a refused call changes
//   nothing and does not reach the page, nor does a query;
// - names and objects: glGen reserves, binding makes, deleting unbinds and
//   detaches; textures' images, formats and parameters (and external ones');
//   buffers; renderbuffers; framebuffers and their completeness, draws on an
//   incomplete one refused; the bits of what is drawn to;
// - shaders and programs with GLSL ES (compile logs, link, active
//   attributes and uniforms, locations, glUniform's checks and values,
//   deletion while in use); vertex attributes;
// - a GLES 1.1 context's limits and its texture parameters.
import assert from "node:assert/strict";
import { GLESHost } from "../../src/gles/gles_host.js";
import { client, cstring, f32s, fake_renderer, floats, i32s, ints, text } from "./lib.mjs";

const GL = {
    NO_ERROR: 0, INVALID_ENUM: 0x0500, INVALID_VALUE: 0x0501, INVALID_OPERATION: 0x0502, INVALID_FRAMEBUFFER_OPERATION: 0x0506,
    TEXTURE_2D: 0x0DE1, TEXTURE_CUBE_MAP: 0x8513, TEXTURE_EXTERNAL_OES: 0x8D65, RGBA: 0x1908, RGB: 0x1907, LUMINANCE: 0x1909,
    UNSIGNED_BYTE: 0x1401, UNSIGNED_SHORT_5_6_5: 0x8363, UNSIGNED_SHORT_4_4_4_4: 0x8033, FLOAT: 0x1406,
    ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893, STATIC_DRAW: 0x88E4, FRAMEBUFFER: 0x8D40, RENDERBUFFER: 0x8D41,
    COLOR_ATTACHMENT0: 0x8CE0, DEPTH_ATTACHMENT: 0x8D00, STENCIL_ATTACHMENT: 0x8D20, DEPTH_COMPONENT16: 0x81A5,
    RGB565: 0x8D62, RGBA8_OES: 0x8058, DEPTH24_STENCIL8_OES: 0x88F0, STENCIL_INDEX8: 0x8D48,
    VERTEX_SHADER: 0x8B31, FRAGMENT_SHADER: 0x8B30, BLEND: 0x0BE2, DITHER: 0x0BD0,
};

const DISPLAY = { width: 480, height: 800, dpi: 240 };
const renderer = fake_renderer();
const host = new GLESHost(DISPLAY, renderer);
const { call, send } = await client(host).connect();
// (config 3: RGBA8888 with 24-bit depth and 8-bit stencil)
const context = (await call("rcCreateContext", 3, 0, 2)).ret;
const surface = (await call("rcCreateWindowSurface", 3, 320, 240)).ret;
await call("rcMakeCurrent", context, surface, surface);
const c = host.shadow.context(context);
const error = async () => (await call("gles2:glGetError")).ret;
const get_i = async (pname, n = 1) => i32s((await call("gles2:glGetIntegerv", pname, 4 * n)).outs[0]);
const get_f = async (pname, n = 1) => f32s((await call("gles2:glGetFloatv", pname, 4 * n)).outs[0]);
const get_b = async (pname, n = 1) => Array.from((await call("gles2:glGetBooleanv", pname, n)).outs[0]);
/** one call after another: replies on a connection come in order */
const each = async (list, f) => { const out = []; for(const item of list) out.push(...await f(item)); return out; };
/** the GLES commands that reached the page */
const sent = () => { host.flush(); return renderer.records().filter(r => r.name === "COMMAND").map(r => r.command.name); };

// ---- the initial state, glGet's conversions, enables

{
    assert.deepEqual(await get_i(0x0BA2, 4), [0, 0, 320, 240], "GL_VIEWPORT: the surface's at the first MakeCurrent");
    assert.deepEqual(await get_i(0x0C10, 4), [0, 0, 320, 240], "GL_SCISSOR_BOX");
    assert.deepEqual(await get_f(0x0B70, 2), [0, 1], "GL_DEPTH_RANGE");
    assert.deepEqual(await get_i(0x0B70, 2), [0, 0x7FFFFFFF], "GL_DEPTH_RANGE as integers: 1.0 is the largest");
    assert.deepEqual(await get_b(0x0C23, 4), [1, 1, 1, 1], "GL_COLOR_WRITEMASK");
    assert.deepEqual(await get_i(0x0B74), [0x0201], "GL_DEPTH_FUNC: GL_LESS");
    assert.deepEqual(await get_i(0x0B98), [-1], "GL_STENCIL_WRITEMASK: all ones");
    assert.deepEqual(await get_i(0x0CF5), [4], "GL_UNPACK_ALIGNMENT");
    assert.deepEqual(await get_i(0x0D33), [4096], "GL_MAX_TEXTURE_SIZE");
    assert.deepEqual(await each([0x0D52, 0x0D53, 0x0D54, 0x0D55, 0x0D56, 0x0D57], p => get_i(p)),
        [8, 8, 8, 8, 24, 8], "the surface's bits");
    assert.equal((await call("gles2:glIsEnabled", GL.DITHER)).ret, 1, "GL_DITHER on at first");
    assert.equal((await call("gles2:glIsEnabled", GL.BLEND)).ret, 0);
    await call("gles2:glEnable", GL.BLEND);
    assert.deepEqual(await get_b(GL.BLEND), [1]);
    await call("gles2:glClearColor", 0.5, -1, 2, 0.25);
    assert.deepEqual(await get_f(0x0C22, 4), [0.5, 0, 1, 0.25], "clamped to [0, 1]");
    await call("gles2:glLineWidth", 2.5);
    assert.deepEqual(await get_i(0x0B21), [3], "a float as an integer: rounded");
    assert.equal(await error(), GL.NO_ERROR);
    await call("gles2:glGetIntegerv", 0x1234, 4);
    assert.equal(await error(), GL.INVALID_ENUM, "an unknown pname");
    console.log("PASS: the initial state, glGet's conversions, enables");
}

// ---- errors

{
    await call("gles2:glEnable", 0x0B10); // GL_POINT_SMOOTH: GLES 1.1's only
    await call("gles2:glBlendFunc", 0x0300, 0x0308); // SRC_ALPHA_SATURATE as the destination
    assert.equal(await error(), GL.INVALID_ENUM, "the first error");
    assert.equal(await error(), GL.NO_ERROR, "only the first: the second was dropped");
    await call("gles2:glLineWidth", 0);
    assert.equal(await error(), GL.INVALID_VALUE);
    assert.deepEqual(await get_f(0x0B21), [2.5], "a refused call changes nothing");
    await call("gles2:glViewport", 0, 0, -1, 5);
    await call("gles2:glPixelStorei", 0x0CF5, 3);
    await call("gles2:glStencilOpSeparate", 0x0404, 0x1E00, 0x1E00, 0x1234);
    assert.equal(await error(), GL.INVALID_VALUE);
    const commands = sent();
    for(const refused of ["glLineWidth", "glPixelStorei", "glStencilOpSeparate", "glViewport"]) assert.equal(commands.filter(n => n === refused).length, refused === "glLineWidth" ? 1 : 0, refused);
    assert.ok(!commands.some(n => /^gl(Get|Is)/.test(n)), "no query reaches the page");
    console.log("PASS: errors");
}

// ---- textures

{
    const names = i32s((await call("gles2:glGenTextures", 3, 12)).outs[0]);
    assert.equal(names.length, 3);
    assert.equal((await call("gles2:glIsTexture", names[0])).ret, 0, "generated, not yet an object");
    await call("gles2:glBindTexture", GL.TEXTURE_2D, names[0]);
    assert.equal((await call("gles2:glIsTexture", names[0])).ret, 1);
    // (glCopyTexSubImage2D: a level above log2 of the largest size is INVALID_VALUE, not "no image")
    await call("gles2:glCopyTexSubImage2D", GL.TEXTURE_2D, 13, 0, 0, 0, 0, 1, 1);
    assert.equal(await error(), GL.INVALID_VALUE);
    await call("gles2:glBindTexture", GL.TEXTURE_CUBE_MAP, names[0]);
    assert.equal(await error(), GL.INVALID_OPERATION, "a texture keeps its first target");
    const rgba = new Uint8Array(16 * 16 * 4);
    await call("gles2:glTexImage2D", GL.TEXTURE_2D, 0, GL.RGBA, 16, 16, 0, GL.RGBA, GL.UNSIGNED_BYTE, rgba);
    assert.equal(await error(), GL.NO_ERROR);
    await call("gles2:glTexImage2D", GL.TEXTURE_2D, 0, GL.RGB, 16, 16, 0, GL.RGBA, GL.UNSIGNED_BYTE, rgba);
    assert.equal(await error(), GL.INVALID_OPERATION, "format and internal format differ");
    await call("gles2:glTexImage2D", GL.TEXTURE_2D, 0, GL.RGBA, 16, 16, 0, GL.RGBA, GL.UNSIGNED_SHORT_5_6_5, rgba);
    assert.equal(await error(), GL.INVALID_OPERATION, "RGBA with 5_6_5");
    await call("gles2:glTexImage2D", GL.TEXTURE_2D, 0, GL.RGBA, 16, 16, 1, GL.RGBA, GL.UNSIGNED_BYTE, rgba);
    assert.equal(await error(), GL.INVALID_VALUE, "a border");
    await call("gles2:glTexImage2D", GL.TEXTURE_2D, 13, GL.RGBA, 1, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE, rgba);
    assert.equal(await error(), GL.INVALID_VALUE, "a level beyond log2 of the largest size");
    await call("gles2:glTexImage2D", GL.TEXTURE_2D, 0, GL.RGBA, 16, 16, 0, 0x1234, GL.UNSIGNED_BYTE, rgba);
    assert.equal(await error(), GL.INVALID_ENUM, "no such format");
    await call("gles2:glTexSubImage2D", GL.TEXTURE_2D, 0, 8, 8, 9, 8, GL.RGBA, GL.UNSIGNED_BYTE, rgba);
    assert.equal(await error(), GL.INVALID_VALUE, "beyond the image");
    await call("gles2:glTexSubImage2D", GL.TEXTURE_2D, 1, 0, 0, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, rgba);
    assert.equal(await error(), GL.INVALID_OPERATION, "a level with no image");
    await call("gles2:glGenerateMipmap", GL.TEXTURE_2D);
    await call("gles2:glTexSubImage2D", GL.TEXTURE_2D, 4, 0, 0, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, rgba);
    assert.equal(await error(), GL.NO_ERROR, "glGenerateMipmap made levels 1 to 4");
    // ETC1: the size by its blocks; no partial updates
    await call("gles2:glCompressedTexImage2D", GL.TEXTURE_2D, 0, 0x8D64, 6, 6, 0, 32, new Uint8Array(32));
    assert.equal(await error(), GL.NO_ERROR);
    await call("gles2:glCompressedTexImage2D", GL.TEXTURE_2D, 0, 0x8D64, 6, 6, 0, 24, new Uint8Array(24));
    assert.equal(await error(), GL.INVALID_VALUE);
    await call("gles2:glCompressedTexSubImage2D", GL.TEXTURE_2D, 0, 0, 0, 4, 4, 0x8D64, 8, new Uint8Array(8));
    assert.equal(await error(), GL.INVALID_OPERATION);
    // parameters
    const param = async (target, pname) => i32s((await call("gles2:glGetTexParameteriv", target, pname, 4)).outs[0])[0];
    assert.equal(await param(GL.TEXTURE_2D, 0x2801), 0x2702, "MIN_FILTER: NEAREST_MIPMAP_LINEAR");
    await call("gles2:glTexParameteri", GL.TEXTURE_2D, 0x2802, 0x812F);
    assert.equal(await param(GL.TEXTURE_2D, 0x2802), 0x812F);
    await call("gles2:glTexParameteri", GL.TEXTURE_2D, 0x2800, 0x2701);
    assert.equal(await error(), GL.INVALID_ENUM, "a mipmap filter for magnification");
    await call("gles2:glBindTexture", GL.TEXTURE_EXTERNAL_OES, names[1]);
    assert.equal(await param(GL.TEXTURE_EXTERNAL_OES, 0x2801), 0x2601, "an external texture: LINEAR");
    assert.equal(await param(GL.TEXTURE_EXTERNAL_OES, 0x2803), 0x812F, "CLAMP_TO_EDGE");
    await call("gles2:glTexParameteri", GL.TEXTURE_EXTERNAL_OES, 0x2802, 0x2901);
    assert.equal(await error(), GL.INVALID_ENUM, "external textures only clamp");
    // deleting unbinds
    await call("gles2:glActiveTexture", 0x84C3);
    await call("gles2:glBindTexture", GL.TEXTURE_2D, names[2]);
    assert.deepEqual(await get_i(0x8069), [names[2]]);
    await call("gles2:glDeleteTextures", 1, ints([names[2]]));
    assert.deepEqual(await get_i(0x8069), [0], "the binding went with it");
    await call("gles2:glActiveTexture", 0x84C0 + 32);
    assert.equal(await error(), GL.INVALID_ENUM, "unit 32 is beyond the 32 units");
    await call("gles2:glActiveTexture", 0x84C0);
    console.log("PASS: textures");
}

// ---- buffers

{
    const [buffer] = i32s((await call("gles2:glGenBuffers", 1, 4)).outs[0]);
    await call("gles2:glBindBuffer", GL.ARRAY_BUFFER, 0);
    await call("gles2:glBufferData", GL.ARRAY_BUFFER, 16, new Uint8Array(16), GL.STATIC_DRAW);
    assert.equal(await error(), GL.INVALID_OPERATION, "no buffer bound");
    await call("gles2:glBindBuffer", GL.ARRAY_BUFFER, buffer);
    await call("gles2:glBufferData", GL.ARRAY_BUFFER, 64, new Uint8Array(64), 0x88E8);
    const parameter = async pname => i32s((await call("gles2:glGetBufferParameteriv", GL.ARRAY_BUFFER, pname, 4)).outs[0])[0];
    assert.deepEqual([await parameter(0x8764), await parameter(0x8765)], [64, 0x88E8]);
    await call("gles2:glBufferSubData", GL.ARRAY_BUFFER, 60, 8, new Uint8Array(8));
    assert.equal(await error(), GL.INVALID_VALUE, "beyond the buffer");
    await call("gles2:glBufferData", GL.ARRAY_BUFFER, 4, null, 0x1234);
    assert.equal(await error(), GL.INVALID_ENUM, "no such usage");
    await call("gles2:glVertexAttribPointerOffset", 3, 2, GL.FLOAT, 0, 8, 16);
    const attrib = async pname => i32s((await call("gles2:glGetVertexAttribiv", 3, pname, 16)).outs[0]);
    assert.deepEqual([...await attrib(0x8623), ...await attrib(0x8624), ...await attrib(0x889F)].slice(0, 9).filter((v, i) => i % 4 === 0),
        [2, 8, buffer], "size, stride, the buffer");
    await call("gles2:glDeleteBuffers", 1, ints([buffer]));
    assert.deepEqual(await get_i(0x8894), [0]);
    assert.equal((await attrib(0x889F))[0], 0, "the attribute's binding went with it");
    await call("gles2:glVertexAttrib3f", 5, 1, 2, 3);
    assert.deepEqual(f32s((await call("gles2:glGetVertexAttribfv", 5, 0x8626, 16)).outs[0]), [1, 2, 3, 1], "the current value, w 1");
    await call("gles2:glVertexAttrib1f", 16, 1);
    assert.equal(await error(), GL.INVALID_VALUE, "attribute 16 of 16");
    console.log("PASS: buffers, vertex attributes");
}

// ---- renderbuffers and framebuffers

{
    const status = async () => (await call("gles2:glCheckFramebufferStatus", GL.FRAMEBUFFER)).ret;
    assert.equal(await status(), 0x8CD5, "the window: complete");
    const [fbo] = i32s((await call("gles2:glGenFramebuffers", 1, 4)).outs[0]);
    const [color, depth] = i32s((await call("gles2:glGenRenderbuffers", 2, 8)).outs[0]);
    await call("gles2:glFramebufferRenderbuffer", GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.RENDERBUFFER, color);
    assert.equal(await error(), GL.INVALID_OPERATION, "framebuffer 0 has no attachments");
    await call("gles2:glBindFramebuffer", GL.FRAMEBUFFER, fbo);
    assert.equal(await status(), 0x8CD7, "MISSING_ATTACHMENT");
    await call("gles2:glBindRenderbuffer", GL.RENDERBUFFER, color);
    await call("gles2:glRenderbufferStorage", GL.RENDERBUFFER, GL.RGB565, 64, 32);
    await call("gles2:glFramebufferRenderbuffer", GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.RENDERBUFFER, color);
    assert.equal(await status(), 0x8CD5);
    assert.deepEqual(await each([0x0D52, 0x0D53, 0x0D54, 0x0D55, 0x0D56], p => get_i(p)), [5, 6, 5, 0, 0],
        "the bits of the framebuffer's images");
    await call("gles2:glBindRenderbuffer", GL.RENDERBUFFER, depth);
    await call("gles2:glRenderbufferStorage", GL.RENDERBUFFER, GL.DEPTH_COMPONENT16, 32, 32);
    await call("gles2:glFramebufferRenderbuffer", GL.FRAMEBUFFER, GL.DEPTH_ATTACHMENT, GL.RENDERBUFFER, depth);
    assert.equal(await status(), 0x8CD9, "INCOMPLETE_DIMENSIONS");
    const draws = sent().filter(n => n === "glDrawArrays").length;
    await call("gles2:glDrawArrays", 4, 0, 3);
    assert.equal(await error(), GL.INVALID_FRAMEBUFFER_OPERATION);
    assert.equal(sent().filter(n => n === "glDrawArrays").length, draws, "the refused draw is not sent");
    await call("gles2:glRenderbufferStorage", GL.RENDERBUFFER, GL.DEPTH_COMPONENT16, 64, 32);
    assert.equal(await status(), 0x8CD5);
    await call("gles2:glFramebufferRenderbuffer", GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.RENDERBUFFER, depth);
    assert.equal(await status(), 0x8CD6, "a depth image as the color attachment: INCOMPLETE_ATTACHMENT");
    // a texture attachment: a luminance one is not color-renderable
    const [texture] = i32s((await call("gles2:glGenTextures", 1, 4)).outs[0]);
    await call("gles2:glBindTexture", GL.TEXTURE_2D, texture);
    await call("gles2:glTexImage2D", GL.TEXTURE_2D, 0, GL.LUMINANCE, 64, 32, 0, GL.LUMINANCE, GL.UNSIGNED_BYTE, null);
    await call("gles2:glFramebufferTexture2D", GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, texture, 0);
    assert.equal(await status(), 0x8CD6);
    await call("gles2:glTexImage2D", GL.TEXTURE_2D, 0, GL.RGBA, 64, 32, 0, GL.RGBA, GL.UNSIGNED_SHORT_4_4_4_4, null);
    assert.equal(await status(), 0x8CD5, "RGBA4444: color-renderable");
    const attachment = async pname => i32s((await call("gles2:glGetFramebufferAttachmentParameteriv", GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, pname, 4)).outs[0])[0];
    assert.deepEqual([await attachment(0x8CD0), await attachment(0x8CD1), await attachment(0x8CD2)], [0x1702, texture, 0]);
    await call("gles2:glFramebufferTexture2D", GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, texture, 1);
    assert.equal(await error(), GL.INVALID_VALUE, "GLES 2.0 attaches level 0 only");
    // depth and stencil: one packed renderbuffer, or unsupported
    const [stencil] = i32s((await call("gles2:glGenRenderbuffers", 1, 4)).outs[0]);
    await call("gles2:glBindRenderbuffer", GL.RENDERBUFFER, stencil);
    await call("gles2:glRenderbufferStorage", GL.RENDERBUFFER, GL.STENCIL_INDEX8, 64, 32);
    await call("gles2:glFramebufferRenderbuffer", GL.FRAMEBUFFER, GL.STENCIL_ATTACHMENT, GL.RENDERBUFFER, stencil);
    assert.equal(await status(), 0x8CDD, "UNSUPPORTED: separate depth and stencil");
    await call("gles2:glRenderbufferStorage", GL.RENDERBUFFER, GL.DEPTH24_STENCIL8_OES, 64, 32);
    await call("gles2:glFramebufferRenderbuffer", GL.FRAMEBUFFER, GL.DEPTH_ATTACHMENT, GL.RENDERBUFFER, stencil);
    assert.equal(await status(), 0x8CD5, "the packed one for both");
    const rb = async pname => i32s((await call("gles2:glGetRenderbufferParameteriv", GL.RENDERBUFFER, pname, 4)).outs[0])[0];
    assert.deepEqual([await rb(0x8D42), await rb(0x8D43), await rb(0x8D44), await rb(0x8D54), await rb(0x8D55)], [64, 32, GL.DEPTH24_STENCIL8_OES, 24, 8]);
    // deleting an attached renderbuffer detaches it
    await call("gles2:glDeleteRenderbuffers", 1, ints([stencil]));
    assert.equal(await status(), 0x8CD5);
    assert.equal(i32s((await call("gles2:glGetFramebufferAttachmentParameteriv", GL.FRAMEBUFFER, GL.DEPTH_ATTACHMENT, 0x8CD0, 4)).outs[0])[0], 0);
    await call("gles2:glDeleteFramebuffers", 1, ints([fbo]));
    assert.deepEqual(await get_i(0x8CA6), [0], "deleting the bound framebuffer binds the window");
    console.log("PASS: renderbuffers, framebuffers and their completeness");
}

// ---- shaders and programs

{
    const vs_source = "attribute vec4 position; attribute vec2 uv; uniform mat4 mvp; uniform vec4 tints[2]; varying vec2 v; " +
        "void main() { v = uv; gl_Position = mvp * position + tints[1]; }";
    const fs_source = "precision mediump float; uniform sampler2D tex; uniform bool flip; uniform ivec2 offset; varying vec2 v; " +
        "void main() { gl_FragColor = texture2D(tex, flip ? v.yx : v) + vec4(float(offset.x)); }";
    const shader = async (type, source) =>
    {
        const name = (await call("gles2:glCreateShader", type)).ret;
        await call("gles2:glShaderString", name, cstring(source), source.length + 1);
        await call("gles2:glCompileShader", name);
        return name;
    };
    const shader_iv = async (name, pname) => i32s((await call("gles2:glGetShaderiv", name, pname, 4)).outs[0])[0];
    const program_iv = async (name, pname) => i32s((await call("gles2:glGetProgramiv", name, pname, 4)).outs[0])[0];
    const vs = await shader(GL.VERTEX_SHADER, vs_source), fs = await shader(GL.FRAGMENT_SHADER, fs_source);
    assert.deepEqual([await shader_iv(vs, 0x8B81), await shader_iv(fs, 0x8B81)], [1, 1], "both compile");
    assert.equal(await shader_iv(vs, 0x8B4F), GL.VERTEX_SHADER);
    assert.equal(await shader_iv(vs, 0x8B88), vs_source.length + 1, "GL_SHADER_SOURCE_LENGTH");
    const bad = await shader(GL.FRAGMENT_SHADER, "void main() { gl_FragColor = undeclared; }");
    assert.equal(await shader_iv(bad, 0x8B81), 0);
    const log_length = await shader_iv(bad, 0x8B84);
    const log = await call("gles2:glGetShaderInfoLog", bad, log_length, 4, log_length);
    assert.match(text(log.outs[1]), /ERROR: 0:1: .*undeclared/);
    assert.equal(i32s(log.outs[0])[0], log_length - 1);
    const program = (await call("gles2:glCreateProgram")).ret;
    await call("gles2:glAttachShader", program, vs);
    await call("gles2:glAttachShader", program, bad);
    assert.equal(await error(), GL.NO_ERROR);
    await call("gles2:glAttachShader", program, fs);
    assert.equal(await error(), GL.INVALID_OPERATION, "a second fragment shader");
    await call("gles2:glLinkProgram", program);
    assert.equal(await program_iv(program, 0x8B82), 0, "the bad fragment shader: no link");
    await call("gles2:glUseProgram", program);
    assert.equal(await error(), GL.INVALID_OPERATION, "a program that did not link is not used");
    await call("gles2:glDetachShader", program, bad);
    await call("gles2:glAttachShader", program, fs);
    await call("gles2:glBindAttribLocation", program, 5, cstring("uv"));
    await call("gles2:glBindAttribLocation", program, 1, cstring("gl_Vertex"));
    assert.equal(await error(), GL.INVALID_OPERATION, "gl_ names are reserved");
    await call("gles2:glLinkProgram", program);
    assert.equal(await program_iv(program, 0x8B82), 1);
    assert.deepEqual([await program_iv(program, 0x8B89), await program_iv(program, 0x8B86)], [2, 5], "2 attributes, 5 uniforms");
    assert.equal((await call("gles2:glGetAttribLocation", program, cstring("uv"))).ret, 5, "the bound location");
    assert.equal((await call("gles2:glGetAttribLocation", program, cstring("position"))).ret, 0);
    const active = [];
    for(let i = 0; i < 5; i++)
    {
        const r = await call("gles2:glGetActiveUniform", program, i, 64, 4, 4, 4, 64);
        active.push([text(r.outs[3]), i32s(r.outs[1])[0], i32s(r.outs[2])[0].toString(16)]);
    }
    assert.deepEqual(active.sort(), [["flip", 1, "8b56"], ["mvp", 1, "8b5c"], ["offset", 1, "8b53"], ["tex", 1, "8b5e"], ["tints[0]", 2, "8b52"]]);
    const location = async name => (await call("gles2:glGetUniformLocation", program, cstring(name))).ret;
    const [mvp, tints, tints1, flip, offset, tex] = [await location("mvp"), await location("tints"), await location("tints[1]"),
        await location("flip"), await location("offset"), await location("tex")];
    assert.equal(tints1, tints + 1);
    assert.equal(await location("nothing"), -1);
    await call("gles2:glUseProgram", program);
    await call("gles2:glUniform4f", tints, 1, 2, 3, 4);
    assert.equal(await error(), GL.NO_ERROR);
    await call("gles2:glUniform4fv", tints1, 2, floats([5, 6, 7, 8, 9, 9, 9, 9]));
    assert.deepEqual(f32s((await call("gles2:glGetUniformfv", program, tints1, 16)).outs[0]), [5, 6, 7, 8], "the rest of the array is cut off");
    await call("gles2:glUniform3f", tints, 1, 2, 3);
    assert.equal(await error(), GL.INVALID_OPERATION, "a vec3 function on a vec4");
    await call("gles2:glUniform1f", tex, 1);
    assert.equal(await error(), GL.INVALID_OPERATION, "a sampler takes glUniform1i only");
    await call("gles2:glUniform1i", tex, 3);
    await call("gles2:glUniform1f", flip, 2.5);
    await call("gles2:glUniform2i", offset, 7, -1);
    await call("gles2:glUniform2f", offset, 7, -1);
    assert.equal(await error(), GL.INVALID_OPERATION, "a float function on an ivec2");
    assert.deepEqual(i32s((await call("gles2:glGetUniformiv", program, flip, 4)).outs[0]), [1], "a bool: true");
    assert.deepEqual(i32s((await call("gles2:glGetUniformiv", program, offset, 8)).outs[0]), [7, -1]);
    await call("gles2:glUniformMatrix4fv", mvp, 1, 1, new Uint8Array(64));
    assert.equal(await error(), GL.INVALID_VALUE, "transpose must be GL_FALSE");
    await call("gles2:glUniform1f", -1, 1);
    assert.equal(await error(), GL.NO_ERROR, "location -1 is ignored");
    await call("gles2:glUniform1f", 99, 1);
    assert.equal(await error(), GL.INVALID_OPERATION, "no such location");
    // deleting a program in use: it stays until it is not
    await call("gles2:glDeleteProgram", program);
    assert.equal((await call("gles2:glIsProgram", program)).ret, 1);
    assert.equal(await program_iv(program, 0x8B80), 1, "GL_DELETE_STATUS");
    await call("gles2:glDeleteShader", vs);
    assert.equal((await call("gles2:glIsShader", vs)).ret, 1, "attached: deleted later");
    await call("gles2:glUseProgram", 0);
    assert.equal((await call("gles2:glIsProgram", program)).ret, 0);
    assert.equal((await call("gles2:glIsShader", vs)).ret, 0, "its program went: so did it");
    await call("gles2:glGetShaderiv", program, 0x8B81, 4);
    assert.equal(await error(), GL.INVALID_VALUE, "no such object");
    await call("gles2:glGetProgramiv", fs, 0x8B82, 4);
    assert.equal(await error(), GL.INVALID_OPERATION, "a shader is no program");
    // (the page got the names: glCreateShader's answer with the command)
    host.flush();
    const created = renderer.records().filter(r => r.name === "COMMAND" && r.command.name === "glCreateShader").map(r => r.ret);
    assert.ok(created.includes(vs) && created.includes(fs));
    console.log("PASS: shaders and programs, uniforms");
}

// ---- GLES 1.1

{
    const context1 = (await call("rcCreateContext", 3, 0, 1)).ret;
    await call("rcMakeCurrent", context1, surface, surface);
    assert.deepEqual(i32s((await call("gles1:glGetIntegerv", 0x0D31, 4)).outs[0]), [8], "GL_MAX_LIGHTS");
    assert.deepEqual(i32s((await call("gles1:glGetFixedv", 0x0B53, 16)).outs[0]), [13107, 13107, 13107, 65536], "GL_LIGHT_MODEL_AMBIENT as 16.16");
    await call("gles1:glEnable", 0x0B50);
    assert.equal((await call("gles1:glGetError")).ret, GL.NO_ERROR, "GL_LIGHTING is a GLES 1.1 capability");
    assert.equal((await call("gles1:glIsEnabled", 0x809D)).ret, 1, "GL_MULTISAMPLE on at first");
    const [texture] = i32s((await call("gles1:glGenTextures", 1, 4)).outs[0]);
    assert.equal(texture, 1, "its own share group");
    await call("gles1:glBindTexture", GL.TEXTURE_2D, texture);
    await call("gles1:glTexParameteri", GL.TEXTURE_2D, 0x8191, 1);
    assert.deepEqual(i32s((await call("gles1:glGetTexParameteriv", GL.TEXTURE_2D, 0x8191, 4)).outs[0]), [1], "GL_GENERATE_MIPMAP");
    await call("gles1:glActiveTexture", 0x84C4);
    assert.equal((await call("gles1:glGetError")).ret, GL.INVALID_ENUM, "4 texture units");
    await call("rcMakeCurrent", context, surface, surface);
    await call("gles2:glTexParameteri", GL.TEXTURE_2D, 0x8191, 1);
    assert.equal(await error(), GL.INVALID_ENUM, "GLES 2.0 has no GL_GENERATE_MIPMAP");
    void c;
    void send;
    console.log("PASS: GLES 1.1");
}

// ---- GLES 1.1's fixed-function state

{
    const context1 = (await call("rcCreateContext", 3, 0, 1)).ret;
    await call("rcMakeCurrent", context1, surface, surface);
    const e1 = async () => (await call("gles1:glGetError")).ret;
    const getf = async (pname, n) => f32s((await call("gles1:glGetFloatv", pname, 4 * n)).outs[0]);
    // matrices: the stacks' depths and their errors
    assert.deepEqual(await getf(0x0BA6, 16), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], "GL_MODELVIEW_MATRIX: the identity");
    await call("gles1:glTranslatef", 1, 2, 3);
    await call("gles1:glScalef", 2, 2, 2);
    assert.deepEqual(await getf(0x0BA6, 16), [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, 2, 3, 1], "translate, then scale");
    await call("gles1:glMatrixMode", 0x1701);
    await call("gles1:glPushMatrix");
    await call("gles1:glPushMatrix");
    assert.equal(await e1(), 0x0503, "GL_STACK_OVERFLOW: the projection stack holds 2");
    await call("gles1:glPopMatrix");
    await call("gles1:glPopMatrix");
    assert.equal(await e1(), 0x0504, "GL_STACK_UNDERFLOW");
    await call("gles1:glOrthof", 0, 1, 0, 1, 1, 1);
    assert.equal(await e1(), 0x0501, "an orthographic projection with near = far");
    await call("gles1:glFrustumx", -65536, 65536, -65536, 65536, 65536, 10 * 65536);
    const frustum = await getf(0x0BA7, 16);
    assert.ok(Math.abs(frustum[0] - 1) < 1e-6 && frustum[11] === -1, "glFrustumx: 16.16 arguments");
    await call("gles1:glMatrixMode", 0x1234);
    assert.equal(await e1(), 0x0500);
    await call("gles1:glMatrixMode", 0x1700);
    // a light's position in eye coordinates: the modelview when it was set
    await call("gles1:glLoadIdentity");
    await call("gles1:glTranslatef", 0, 0, -5);
    await call("gles1:glLightfv", 0x4001, 0x1203, floats([1, 0, 0, 1]));
    assert.deepEqual(f32s((await call("gles1:glGetLightfv", 0x4001, 0x1203, 16)).outs[0]), [1, 0, -5, 1]);
    await call("gles1:glLightf", 0x4001, 0x1206, 120);
    assert.equal(await e1(), 0x0501, "a spot cutoff of 120 degrees");
    assert.deepEqual(f32s((await call("gles1:glGetLightfv", 0x4000, 0x1201, 16)).outs[0]), [1, 1, 1, 1], "light 0's diffuse: white");
    assert.deepEqual(f32s((await call("gles1:glGetLightfv", 0x4001, 0x1201, 16)).outs[0]), [0, 0, 0, 1], "the others': black");
    // the material: front and back together
    await call("gles1:glMaterialfv", 0x0404, 0x1201, floats([1, 0, 0, 1]));
    assert.equal(await e1(), 0x0500, "GLES 1.1 sets both faces only");
    await call("gles1:glMaterialx", 0x0408, 0x1601, 64 * 65536);
    assert.deepEqual(f32s((await call("gles1:glGetMaterialfv", 0x0405, 0x1601, 4)).outs[0]), [64], "GL_SHININESS by its 16.16");
    // texture environments: per unit, enums as themselves in the fixed form
    await call("gles1:glActiveTexture", 0x84C1);
    await call("gles1:glTexEnvx", 0x2300, 0x2200, 0x8570);
    assert.deepEqual(i32s((await call("gles1:glGetTexEnviv", 0x2300, 0x2200, 4)).outs[0]), [0x8570], "unit 1: GL_COMBINE");
    await call("gles1:glActiveTexture", 0x84C0);
    assert.deepEqual(i32s((await call("gles1:glGetTexEnviv", 0x2300, 0x2200, 4)).outs[0]), [0x2100], "unit 0: GL_MODULATE still");
    await call("gles1:glTexEnvi", 0x2300, 0x8573, 3);
    assert.equal(await e1(), 0x0501, "GL_RGB_SCALE: 1, 2 or 4");
    // fog, the alpha test, the shade model
    await call("gles1:glFogx", 0x0B65, 0x2601);
    await call("gles1:glFogf", 0x0B62, -1);
    assert.equal(await e1(), 0x0501, "a negative fog density");
    assert.deepEqual(i32s((await call("gles1:glGetIntegerv", 0x0B65, 4)).outs[0]), [0x2601], "GL_FOG_MODE: GL_LINEAR");
    await call("gles1:glAlphaFunc", 0x0204, 2);
    assert.deepEqual(await getf(0x0BC2, 1), [1], "the alpha reference clamped to 1");
    await call("gles1:glShadeModel", 0x1D00);
    assert.deepEqual(i32s((await call("gles1:glGetIntegerv", 0x0B54, 4)).outs[0]), [0x1D00]);
    // a clip plane in eye coordinates: the inverse modelview's
    await call("gles1:glClipPlanef", 0x3000, floats([0, 0, 1, 0]));
    assert.deepEqual(f32s((await call("gles1:glGetClipPlanef", 0x3000, 16)).outs[0]), [0, 0, 1, 5], "z = 0 in object space is z = -5 in eye space");
    // client arrays: glEnableClientState's, not glEnable's; their pointers
    await call("gles1:glEnable", 0x8074);
    assert.equal(await e1(), 0x0500, "GL_VERTEX_ARRAY is not glEnable's");
    await call("gles1:glEnableClientState", 0x8074);
    assert.equal((await call("gles1:glIsEnabled", 0x8074)).ret, 1);
    await call("gles1:glVertexPointerData", 1, 0x1406, 0, floats([0, 0]), 8);
    assert.equal(await e1(), 0x0501, "a vertex array of size 1");
    await call("gles1:glColorPointerData", 3, 0x1401, 0, new Uint8Array(3), 3);
    assert.equal(await e1(), 0x0501, "a color array of size 3");
    await call("gles1:glClientActiveTexture", 0x84C1);
    await call("gles1:glTexCoordPointerOffset", 2, 0x140C, 8, 0);
    assert.deepEqual(i32s((await call("gles1:glGetIntegerv", 0x8088, 4)).outs[0]), [2], "unit 1's texture coordinates: size 2");
    assert.deepEqual(i32s((await call("gles1:glGetIntegerv", 0x84E1, 4)).outs[0]), [0x84C1], "GL_CLIENT_ACTIVE_TEXTURE");
    // the texture enable is per unit
    await call("gles1:glEnable", 0x0DE1);
    await call("gles1:glActiveTexture", 0x84C1);
    assert.equal((await call("gles1:glIsEnabled", 0x0DE1)).ret, 0, "GL_TEXTURE_2D off on unit 1");
    await call("gles1:glActiveTexture", 0x84C0);
    assert.equal((await call("gles1:glIsEnabled", 0x0DE1)).ret, 1, "on on unit 0");
    // the current values; draw_texture's checks
    await call("gles1:glColor4ub", 255, 0, 51, 255);
    assert.deepEqual(await getf(0x0B00, 4), [1, 0, 0.2, 1].map(Math.fround));
    await call("gles1:glDrawTexiOES", 0, 0, 0, 0, 4);
    assert.equal(await e1(), 0x0501, "a draw_texture rectangle of width 0");
    assert.equal(await e1(), 0);
    console.log("PASS: GLES 1.1's fixed-function state");
}
