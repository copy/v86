#!/usr/bin/env node
// renderControl and E1's GLES answers (src/gles/render_control.js,
// gles_defaults.js, gles_host.js; docs/gles-proxy-plan.md E1), through the
// host's services as a transport drives them, the guest's bytes made by
// the test encoder:
// - the configurations as gfxstream packs them (the attributes' row, then
//   one row each), eglChooseConfig's matching and order for what
//   SurfaceFlinger and GLSurfaceView ask, the EGL and GL strings by the
//   current context's API, the screen's parameters;
// - contexts, window surfaces, make-current; color buffers opened and
//   closed by reference, a process's going (its GLProcessPipe closed)
//   dropping what it had; sync objects; client images;
// - the GLES defaults: names, compile and link, queries' limits and initial
//   values, enables, the viewport of the first surface;
// - the plugin as built (build/v86-gles.js): its descriptor and service.
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL as path_to_file_url } from "node:url";
import { GLESHost } from "../../src/gles/gles_host.js";
import { CONFIGS, CONFIG_ATTRIBUTES, EGL, choose_configs } from "../../src/gles/gles_caps.js";
import { decode_reply, encode_command } from "../../src/gles/gles_wire.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const DISPLAY = { width: 480, height: 800, dpi: 240 };

/** A client of a host's services: a process pipe and connections, the replies read back */
function client(host)
{
    const process_pipe = host.service("GLProcessPipe", () => {});
    process_pipe.write(new Uint8Array(new Uint32Array([100]).buffer));
    const id = process_pipe.read(8);
    const puid = new DataView(id.buffer, id.byteOffset).getUint32(0, true);
    const connect = () =>
    {
        const service = host.service("opengles", () => {});
        service.write(new Uint8Array(4));
        /** @return {{outs: !Array<!Uint8Array>, ret: number}} */
        const call = (name, ...args) =>
        {
            service.write(encode_command(name, args));
            const parts = [];
            for(let bytes; (bytes = service.read(1 << 20));) parts.push(bytes.slice());
            const reply = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
            let at = 0;
            for(const p of parts) { reply.set(p, at); at += p.length; }
            return reply.length ? decode_reply(name, args, reply) : { outs: [], ret: undefined };
        };
        call("rcSetPuid", puid);
        return { call, service };
    };
    return { puid, process_pipe, connect };
}
const i32s = bytes => Array.from(new Int32Array(bytes.slice().buffer));
const text = bytes => new TextDecoder().decode(bytes.subarray(0, bytes.indexOf(0)));
const ints = values => new Uint8Array(new Int32Array(values).buffer);

// ---- configurations

{
    const host = new GLESHost(DISPLAY);
    const { call } = client(host).connect();
    assert.equal(call("rcGetRendererVersion").ret, 1);
    const version = call("rcGetEGLVersion", 4, 4);
    assert.deepEqual([i32s(version.outs[0])[0], i32s(version.outs[1])[0], version.ret], [1, 4, EGL.TRUE]);
    const count = call("rcGetNumConfigs", 4);
    assert.equal(count.ret, CONFIGS.length);
    assert.equal(i32s(count.outs[0])[0], CONFIG_ATTRIBUTES.length);
    const size = (CONFIGS.length + 1) * CONFIG_ATTRIBUTES.length * 4;
    assert.equal(call("rcGetConfigs", 16, 16).ret, -size, "too small: minus the size needed");
    const configs = call("rcGetConfigs", size, size);
    assert.equal(configs.ret, CONFIGS.length);
    const table = i32s(configs.outs[0]);
    assert.deepEqual(table.slice(0, CONFIG_ATTRIBUTES.length), CONFIG_ATTRIBUTES, "the attributes' ids first");
    const row = (config, attribute) => table[(config + 1) * CONFIG_ATTRIBUTES.length + CONFIG_ATTRIBUTES.indexOf(attribute)];
    assert.deepEqual([EGL.DEPTH_SIZE, EGL.STENCIL_SIZE, EGL.RENDERABLE_TYPE, EGL.SURFACE_TYPE, EGL.CONFIG_ID].map(a => CONFIG_ATTRIBUTES.indexOf(a)),
        [0, 1, 2, 3, 4], "gfxstream's first five");
    for(let c = 0; c < CONFIGS.length; c++) assert.equal(row(c, EGL.CONFIG_ID), c + 1);

    // SurfaceFlinger's (RenderEngine's selectEGLConfig with GLES 2.0)
    const surfaceflinger = [EGL.RENDERABLE_TYPE, EGL.OPENGL_ES2_BIT, EGL.RECORDABLE_ANDROID, EGL.TRUE,
        EGL.SURFACE_TYPE, EGL.WINDOW_BIT | EGL.PBUFFER_BIT, EGL.FRAMEBUFFER_TARGET_ANDROID, EGL.TRUE,
        EGL.RED_SIZE, 8, EGL.GREEN_SIZE, 8, EGL.BLUE_SIZE, 8, EGL.NONE, EGL.NONE];
    const n = call("rcChooseConfig", ints(surfaceflinger), surfaceflinger.length * 4, 0, 0);
    assert.equal(n.ret, 8, "the 8-bit configurations, with and without alpha");
    const chosen = call("rcChooseConfig", ints(surfaceflinger), surfaceflinger.length * 4, 16, 4);
    assert.equal(chosen.ret, 4);
    const first = i32s(chosen.outs[0]);
    assert.deepEqual(first.map(c => [row(c, EGL.ALPHA_SIZE), row(c, EGL.DEPTH_SIZE), row(c, EGL.STENCIL_SIZE)]),
        [[0, 0, 0], [0, 16, 0], [0, 24, 0], [0, 24, 8]], "EGL's order: the smaller buffer, then the smaller depth and stencil");
    assert.equal(row(first[0], EGL.NATIVE_VISUAL_ID), 2, "HAL_PIXEL_FORMAT_RGBX_8888");
    // (the fallback: any configuration whose visual is RGBA_8888)
    assert.ok(choose_configs([EGL.NONE]).some(c => CONFIGS[c][CONFIG_ATTRIBUTES.indexOf(EGL.NATIVE_VISUAL_ID)] === 1));
    // GLSurfaceView's default (8, 8, 8, 0 with depth 16), RGB565, ES 1, ES 3 (none), a config id
    const pick = list => choose_configs([...list, EGL.NONE]).map(c => c + 1);
    assert.deepEqual(pick([EGL.RED_SIZE, 8, EGL.GREEN_SIZE, 8, EGL.BLUE_SIZE, 8, EGL.DEPTH_SIZE, 16, EGL.RENDERABLE_TYPE, EGL.OPENGL_ES2_BIT]),
        [6, 7, 8, 2, 3, 4], "depth 16 and up; RGBX before RGBA (the smaller buffer)");
    const rgb565 = pick([EGL.RED_SIZE, 5, EGL.GREEN_SIZE, 6, EGL.BLUE_SIZE, 5]);
    assert.deepEqual([rgb565.length, rgb565[0], rgb565[8]], [12, 5, 9], "EGL's rule: the most color bits first, RGB565 last");
    assert.deepEqual(pick([EGL.RENDERABLE_TYPE, EGL.OPENGL_ES3_BIT]), []);
    assert.deepEqual(pick([EGL.CONFIG_ID, 6]), [6]);
    assert.deepEqual(pick([EGL.BUFFER_SIZE, 16, EGL.RED_SIZE, 5, EGL.ALPHA_SIZE, EGL.DONT_CARE]).slice(0, 1), [5],
        "red asked: its bits count, then the smaller buffer");
    // (no attributes at all: every configuration with a window and ES 1)
    assert.equal(call("rcChooseConfig", null, 0, 0, 0).ret, CONFIGS.length);

    // the screen
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 99].map(p => call("rcGetFBParam", p).ret), [480, 800, 240, 240, 60, 1, 1, -1]);
    // strings: EGL's, GL's by the current context's API
    const egl = call("rcQueryEGLString", EGL.VENDOR, 64, 64);
    assert.equal(text(egl.outs[0]), "v86");
    assert.equal(call("rcQueryEGLString", EGL.VERSION, 2, 2).ret, -8, "too small: minus the length with the NUL");
    assert.ok(call("rcGetGLString", 0x1F03, 0, 0).ret < 0, "the guest asks with no buffer first");
    // (as the guest's EGL asks: the size first, then the string)
    const gl = name =>
    {
        const size = -call("rcGetGLString", name, 0, 0).ret;
        const reply = call("rcGetGLString", name, size, size);
        assert.equal(reply.ret, size);
        return text(reply.outs[0]);
    };
    assert.equal(gl(0x1F02), "OpenGL ES 2.0 v86", "no context: GLES 2.0's");
    assert.match(gl(0x1F03), /GL_OES_EGL_image_external /);
    assert.doesNotMatch(gl(0x1F03), /ANDROID_EMU/, "no host features: no checksums, GLES 2.0");
    const context1 = call("rcCreateContext", 1, 0, 1).ret;
    const surface = call("rcCreateWindowSurface", 1, 480, 800).ret;
    assert.equal(call("rcMakeCurrent", context1, surface, surface).ret, EGL.TRUE);
    assert.equal(gl(0x1F02), "OpenGL ES-CM 1.1 v86");
    assert.match(gl(0x1F03), /GL_OES_draw_texture/);
    console.log("PASS: configurations, the screen, strings");
}

// ---- contexts, surfaces, color buffers, processes

{
    const host = new GLESHost(DISPLAY);
    const rc = host.rc;
    const a = client(host), b = client(host);
    assert.notEqual(a.puid, b.puid, "each process its own id");
    const ca = a.connect().call, cb = b.connect().call;
    // (SurfaceFlinger's process: a context, a window surface, current)
    const context = ca("rcCreateContext", 0, 0, 2).ret;
    const shared = ca("rcCreateContext", 0, context, 2).ret;
    assert.ok(context > 0 && shared > context);
    assert.equal(ca("rcCreateContext", 99, 0, 2).ret, 0, "no such configuration");
    assert.equal(ca("rcCreateContext", 0, 12345, 2).ret, 0, "no such context to share with");
    const surface = ca("rcCreateWindowSurface", 0, 480, 800).ret;
    assert.equal(ca("rcMakeCurrent", context, surface, surface).ret, EGL.TRUE);
    assert.equal(ca("rcMakeCurrent", 999, surface, surface).ret, EGL.FALSE);
    assert.equal(ca("rcMakeCurrent", context, 0, 0).ret, EGL.TRUE, "surfaceless");
    assert.equal(ca("rcMakeCurrent", 0, 0, 0).ret, EGL.TRUE, "nothing current");
    // gralloc: a buffer of process a, imported by b, freed by a, released by b
    const buffer = ca("rcCreateColorBuffer", 480, 800, 0x1908).ret;
    assert.ok(buffer > 0);
    assert.equal(cb("rcOpenColorBuffer2", buffer).ret, 0);
    assert.equal(cb("rcOpenColorBuffer2", 4242).ret, -1);
    ca("rcSetWindowColorBuffer", surface, buffer);
    assert.equal(rc.surfaces.get(surface).color_buffer, buffer);
    assert.equal(ca("rcFlushWindowColorBuffer", surface).ret, 0);
    assert.equal(ca("rcFlushWindowColorBuffer", 4242).ret, -1);
    ca("rcFBPost", buffer);
    assert.equal(rc.posts, 1);
    const pixels = new Uint8Array(480 * 800 * 4);
    assert.equal(cb("rcUpdateColorBuffer", buffer, 0, 0, 480, 800, 0x1908, 0x1401, pixels).ret, 0);
    assert.equal(rc.update_bytes, pixels.length);
    const read = cb("rcReadColorBuffer", buffer, 0, 0, 2, 2, 0x1908, 0x1401, 16);
    assert.deepEqual(read.outs[0], new Uint8Array(16), "E1: zeros");
    ca("rcCloseColorBuffer", buffer);
    assert.ok(rc.color_buffers.has(buffer), "b's reference keeps it");
    cb("rcCloseColorBuffer", buffer);
    assert.ok(!rc.color_buffers.has(buffer), "the last reference gone");
    // images: a texture of a context, a gralloc buffer
    const other = cb("rcCreateColorBuffer", 64, 64, 0x1908).ret;
    const image = cb("rcCreateClientImage", 0, 0x3140, other).ret;
    assert.ok(image > 0);
    assert.equal(cb("rcCreateClientImage", 0, 0x3140, 777).ret, 0, "no such buffer");
    assert.equal(cb("rcDestroyClientImage", image).ret, 1);
    // syncs signal at once
    const sync = ca("rcCreateSyncKHR", 0x30F9, ints([EGL.NONE]), 4, 0, 8, 8);
    const handle = Number(new BigUint64Array(sync.outs[0].slice().buffer)[0]);
    assert.ok(rc.syncs.has(handle));
    assert.equal(ca("rcClientWaitSyncKHR", handle, 0, 1e9).ret, EGL.CONDITION_SATISFIED_KHR);
    assert.equal(ca("rcDestroySyncKHR", handle).ret, 0);
    assert.ok(!rc.syncs.has(handle));
    // a process goes: its objects and references go with it
    const kept = cb("rcCreateColorBuffer", 32, 32, 0x1908).ret;
    ca("rcOpenColorBuffer", kept);
    a.process_pipe.close();
    assert.ok(!rc.contexts.has(context) && !rc.contexts.has(shared) && !rc.surfaces.has(surface), "process a's contexts and surface");
    assert.ok(rc.color_buffers.has(kept) && !rc.color_buffers.get(kept).refs.has("p" + a.puid), "b's buffer stays, a's reference goes");
    b.process_pipe.close();
    assert.equal(rc.color_buffers.size, 0);
    console.log("PASS: contexts, surfaces, color buffers, images, syncs, processes");
}

// ---- E1's GLES answers

{
    const host = new GLESHost(DISPLAY);
    const { call } = client(host).connect();
    const context = call("rcCreateContext", 3, 0, 2).ret;
    const surface = call("rcCreateWindowSurface", 3, 320, 240).ret;
    call("rcMakeCurrent", context, surface, surface);
    const get = (pname, n = 4) => i32s(call("gles2:glGetIntegerv", pname, 4 * n).outs[0]);
    assert.deepEqual(get(0x0D33, 1), [4096], "GL_MAX_TEXTURE_SIZE");
    assert.deepEqual(get(0x8869, 1), [16], "GL_MAX_VERTEX_ATTRIBS");
    assert.deepEqual(get(0x0BA2), [0, 0, 320, 240], "GL_VIEWPORT: the first surface's");
    call("gles2:glViewport", 1, 2, 3, 4);
    assert.deepEqual(get(0x0BA2), [1, 2, 3, 4]);
    assert.deepEqual([0x0D52, 0x0D53, 0x0D54, 0x0D55, 0x0D56, 0x0D57].map(p => get(p, 1)[0]), [8, 8, 8, 8, 24, 8], "config 3's bits");
    assert.deepEqual(get(0x86A3, 1), [0x8D64], "ETC1");
    assert.equal(call("gles2:glGetError").ret, 0);
    assert.equal(call("gles2:glIsEnabled", 0x0BE2).ret, 0, "GL_BLEND off");
    assert.equal(call("gles2:glIsEnabled", 0x0BD0).ret, 1, "GL_DITHER on");
    call("gles2:glEnable", 0x0BE2);
    assert.equal(call("gles2:glIsEnabled", 0x0BE2).ret, 1);
    assert.deepEqual(Array.from(call("gles2:glGetBooleanv", 0x0BE2, 1).outs[0]), [1]);
    assert.deepEqual(Array.from(new Float32Array(call("gles2:glGetFloatv", 0x0B70, 8).outs[0].slice().buffer)), [0, 1], "GL_DEPTH_RANGE");
    const names = i32s(call("gles2:glGenTextures", 3, 12).outs[0]);
    assert.deepEqual(names, [1, 2, 3]);
    assert.equal(call("gles2:glIsTexture", 2).ret, 1);
    call("gles2:glDeleteTextures", 1, ints([2]));
    assert.equal(call("gles2:glIsTexture", 2).ret, 0);
    const vs = call("gles2:glCreateShader", 0x8B31).ret, fs_ = call("gles2:glCreateShader", 0x8B30).ret;
    const program = call("gles2:glCreateProgram").ret;
    assert.deepEqual([vs, fs_, program], [1, 2, 3], "shaders and programs: one name space");
    const source = "attribute vec4 p; void main() { gl_Position = p; }";
    call("gles2:glShaderString", vs, new TextEncoder().encode(source + "\0"), source.length + 1);
    call("gles2:glCompileShader", vs);
    assert.deepEqual(i32s(call("gles2:glGetShaderiv", vs, 0x8B81, 4).outs[0]), [1], "GL_COMPILE_STATUS");
    assert.deepEqual(i32s(call("gles2:glGetShaderiv", vs, 0x8B88, 4).outs[0]), [source.length + 1], "GL_SHADER_SOURCE_LENGTH");
    const got = call("gles2:glGetShaderSource", vs, 100, 4, 100);
    assert.equal(text(got.outs[1]), source);
    call("gles2:glAttachShader", program, vs);
    call("gles2:glAttachShader", program, fs_);
    call("gles2:glBindAttribLocation", program, 0, new TextEncoder().encode("q\0"));
    call("gles2:glLinkProgram", program);
    assert.deepEqual(i32s(call("gles2:glGetProgramiv", program, 0x8B82, 4).outs[0]), [1], "GL_LINK_STATUS");
    assert.deepEqual(i32s(call("gles2:glGetProgramiv", program, 0x8B85, 4).outs[0]), [2], "GL_ATTACHED_SHADERS");
    assert.equal(call("gles2:glGetAttribLocation", program, new TextEncoder().encode("p\0")).ret, 1, "after the bound one");
    assert.equal(call("gles2:glGetUniformLocation", program, new TextEncoder().encode("u\0")).ret, 0);
    assert.equal(call("gles2:glGetUniformLocation", program, new TextEncoder().encode("v\0")).ret, 1);
    assert.equal(call("gles2:glGetUniformLocation", program, new TextEncoder().encode("u\0")).ret, 0, "the same name, the same location");
    assert.equal(call("gles2:glCheckFramebufferStatus", 0x8D40).ret, 0x8CD5);
    const precision = call("gles2:glGetShaderPrecisionFormat", 0x8B30, 0x8DF2, 8, 4);
    assert.deepEqual([...i32s(precision.outs[0]), ...i32s(precision.outs[1])], [127, 127, 23]);
    assert.equal(call("gles2:glFinishRoundTrip").ret, 0);
    const pixels = call("gles2:glReadPixels", 0, 0, 2, 2, 0x1908, 0x1401, 16);
    assert.deepEqual(pixels.outs[0], new Uint8Array(16));
    // GLES 1.1
    const context1 = call("rcCreateContext", 0, 0, 1).ret;
    call("rcMakeCurrent", context1, surface, surface);
    assert.deepEqual(i32s(call("gles1:glGetIntegerv", 0x0D31, 4).outs[0]), [8], "GL_MAX_LIGHTS");
    assert.deepEqual(i32s(call("gles1:glGetFixedv", 0x0B53, 16).outs[0]), [13107, 13107, 13107, 65536], "GL_LIGHT_MODEL_AMBIENT as 16.16");
    assert.deepEqual(i32s(call("gles1:glGenTextures", 1, 4).outs[0]), [1], "its own share group");
    const summary = host.summary();
    assert.equal(summary.counts.glGetIntegerv, 12, "GLESv2's 11 and GLESv1's 1");
    assert.deepEqual(summary.unknown, {});
    assert.deepEqual(summary.malformed, {});
    console.log("PASS: E1's GLES answers");
}

// ---- the plugin as built

{
    const file = root + "build/v86-gles.js";
    assert.ok(fs.existsSync(file), "build/v86-gles.js (make build/v86-gles.js)");
    await import(path_to_file_url(file).href);
    const descriptor = globalThis.V86GlesHosts && globalThis.V86GlesHosts.gles;
    assert.equal(descriptor.name, "gles");
    const device = descriptor.create({}, { display: DISPLAY });
    for(const name of ["service", "summary", "get_state", "set_state", "reset"]) assert.equal(typeof device[name], "function", name);
    assert.equal(device.service("qemud:other", () => {}), null);
    const service = device.service("opengles", () => {});
    service.write(new Uint8Array(4));
    service.write(encode_command("rcGetFBParam", [1]));
    assert.ok(service.available());
    assert.deepEqual(service.read(16), new Uint8Array([224, 1, 0, 0]), "480");
    assert.equal(device.summary().counts.rcGetFBParam, 1);
    service.close();
    device.set_state(device.get_state());
    assert.equal(device.summary().connections, 0);
    console.log("PASS: build/v86-gles.js");
}
