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
import { unpack_program } from "../../src/gles/glsl_program.js";
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
