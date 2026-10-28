#!/usr/bin/env node
// renderControl (src/gles/render_control.js; docs/gles-proxy-plan.md E1,
// E2), through the host's services as a transport drives them, the guest's
// bytes made by the test encoder:
// - the configurations as gfxstream packs them (the attributes' row, then
//   one row each), eglChooseConfig's matching and order for what
//   SurfaceFlinger and GLSurfaceView ask, the EGL and GL strings by the
//   current context's API, the screen's parameters;
// - contexts, window surfaces, make-current; color buffers opened and
//   closed by reference, a process's going (its GLProcessPipe closed)
//   dropping what it had, and the page hearing of every object made and
//   gone; sync objects; client images;
// - the plugin as built (build/v86-gles.js): its descriptor and service.
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL as path_to_file_url } from "node:url";
import { GLESHost } from "../../src/gles/gles_host.js";
import { CONFIGS, CONFIG_ATTRIBUTES, EGL, choose_configs } from "../../src/gles/gles_caps.js";
import { encode_command } from "../../src/gles/gles_wire.js";
import { client, fake_renderer, i32s, ints, settle, text } from "./lib.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const DISPLAY = { width: 480, height: 800, dpi: 240 };

// ---- configurations

{
    const host = new GLESHost(DISPLAY, fake_renderer());
    const { call } = await client(host).connect();
    assert.equal((await call("rcGetRendererVersion")).ret, 1);
    const version = await call("rcGetEGLVersion", 4, 4);
    assert.deepEqual([i32s(version.outs[0])[0], i32s(version.outs[1])[0], version.ret], [1, 4, EGL.TRUE]);
    const count = await call("rcGetNumConfigs", 4);
    assert.equal(count.ret, CONFIGS.length);
    assert.equal(i32s(count.outs[0])[0], CONFIG_ATTRIBUTES.length);
    const size = (CONFIGS.length + 1) * CONFIG_ATTRIBUTES.length * 4;
    assert.equal((await call("rcGetConfigs", 16, 16)).ret, -size, "too small: minus the size needed");
    const configs = await call("rcGetConfigs", size, size);
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
    const n = await call("rcChooseConfig", ints(surfaceflinger), surfaceflinger.length * 4, 0, 0);
    assert.equal(n.ret, 8, "the 8-bit configurations, with and without alpha");
    const chosen = await call("rcChooseConfig", ints(surfaceflinger), surfaceflinger.length * 4, 16, 4);
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
    assert.equal((await call("rcChooseConfig", null, 0, 0, 0)).ret, CONFIGS.length);

    // the screen
    const params = [];
    for(const p of [1, 2, 3, 4, 5, 6, 7, 99]) params.push((await call("rcGetFBParam", p)).ret);
    assert.deepEqual(params, [480, 800, 240, 240, 60, 1, 1, -1]);
    // strings: EGL's, GL's by the current context's API
    const egl = await call("rcQueryEGLString", EGL.VENDOR, 64, 64);
    assert.equal(text(egl.outs[0]), "v86");
    assert.equal((await call("rcQueryEGLString", EGL.VERSION, 2, 2)).ret, -8, "too small: minus the length with the NUL");
    // (as the guest's EGL asks: the size first, then the string)
    const gl = async name =>
    {
        const size = -(await call("rcGetGLString", name, 0, 0)).ret;
        const reply = await call("rcGetGLString", name, size, size);
        assert.equal(reply.ret, size);
        return text(reply.outs[0]);
    };
    assert.equal(await gl(0x1F02), "OpenGL ES 2.0 v86", "no context: GLES 2.0's");
    assert.match(await gl(0x1F03), /GL_OES_EGL_image_external /);
    assert.doesNotMatch(await gl(0x1F03), /ANDROID_EMU/, "no host features: no checksums, GLES 2.0");
    const context1 = (await call("rcCreateContext", 1, 0, 1)).ret;
    const surface = (await call("rcCreateWindowSurface", 1, 480, 800)).ret;
    assert.equal((await call("rcMakeCurrent", context1, surface, surface)).ret, EGL.TRUE);
    assert.equal(await gl(0x1F02), "OpenGL ES-CM 1.1 v86");
    assert.match(await gl(0x1F03), /GL_OES_draw_texture/);
    console.log("PASS: configurations, the screen, strings");
}

// ---- contexts, surfaces, color buffers, processes

{
    const renderer = fake_renderer();
    const host = new GLESHost(DISPLAY, renderer);
    const rc = host.rc;
    const a = client(host), b = client(host);
    assert.notEqual(a.puid, b.puid, "each process its own id");
    const ca = (await a.connect()).call, cb = (await b.connect()).call;
    // (SurfaceFlinger's process: a context, a window surface, current)
    const context = (await ca("rcCreateContext", 0, 0, 2)).ret;
    const shared = (await ca("rcCreateContext", 0, context, 2)).ret;
    assert.ok(context > 0 && shared > context);
    assert.equal((await ca("rcCreateContext", 99, 0, 2)).ret, 0, "no such configuration");
    assert.equal((await ca("rcCreateContext", 0, 12345, 2)).ret, 0, "no such context to share with");
    const surface = (await ca("rcCreateWindowSurface", 0, 480, 800)).ret;
    assert.equal((await ca("rcMakeCurrent", context, surface, surface)).ret, EGL.TRUE);
    assert.equal((await ca("rcMakeCurrent", 999, surface, surface)).ret, EGL.FALSE);
    assert.equal((await ca("rcMakeCurrent", context, 0, 0)).ret, EGL.TRUE, "surfaceless");
    assert.equal((await ca("rcMakeCurrent", 0, 0, 0)).ret, EGL.TRUE, "nothing current");
    // gralloc: a buffer of process a, imported by b, freed by a, released by b
    const buffer = (await ca("rcCreateColorBuffer", 480, 800, 0x1908)).ret;
    assert.ok(buffer > 0);
    assert.equal((await cb("rcOpenColorBuffer2", buffer)).ret, 0);
    assert.equal((await cb("rcOpenColorBuffer2", 4242)).ret, -1);
    await ca("rcSetWindowColorBuffer", surface, buffer);
    assert.equal(rc.surfaces.get(surface).color_buffer, buffer);
    assert.equal((await ca("rcFlushWindowColorBuffer", surface)).ret, 0);
    assert.equal((await ca("rcFlushWindowColorBuffer", 4242)).ret, -1);
    await ca("rcFBPost", buffer);
    assert.equal(rc.posts, 1);
    const pixels = new Uint8Array(480 * 800 * 4);
    assert.equal((await cb("rcUpdateColorBuffer", buffer, 0, 0, 480, 800, 0x1908, 0x1401, pixels)).ret, 0);
    assert.equal(rc.update_bytes, pixels.length);
    const read = await cb("rcReadColorBuffer", buffer, 0, 0, 2, 2, 0x1908, 0x1401, 16);
    assert.ok(read.outs[0].length === 16 && read.outs[0].every(v => v === read.outs[0][0] && v !== 0), "the page's pixels");
    await ca("rcCloseColorBuffer", buffer);
    assert.ok(rc.color_buffers.has(buffer), "b's reference keeps it");
    await cb("rcCloseColorBuffer", buffer);
    assert.ok(!rc.color_buffers.has(buffer), "the last reference gone");
    // images: a texture of a context, a gralloc buffer
    const other = (await cb("rcCreateColorBuffer", 64, 64, 0x1908)).ret;
    const image = (await cb("rcCreateClientImage", 0, 0x3140, other)).ret;
    assert.ok(image > 0);
    assert.equal((await cb("rcCreateClientImage", 0, 0x3140, 777)).ret, 0, "no such buffer");
    assert.equal((await cb("rcDestroyClientImage", image)).ret, 1);
    // syncs signal at once
    const sync = await ca("rcCreateSyncKHR", 0x30F9, ints([EGL.NONE]), 4, 0, 8, 8);
    const handle = Number(new BigUint64Array(sync.outs[0].slice().buffer)[0]);
    assert.ok(rc.syncs.has(handle));
    assert.equal((await ca("rcClientWaitSyncKHR", handle, 0, 1e9)).ret, EGL.CONDITION_SATISFIED_KHR);
    assert.equal((await ca("rcDestroySyncKHR", handle)).ret, 0);
    assert.ok(!rc.syncs.has(handle));
    // a process goes: its objects and references go with it
    const kept = (await cb("rcCreateColorBuffer", 32, 32, 0x1908)).ret;
    await ca("rcOpenColorBuffer", kept);
    a.process_pipe.close();
    assert.ok(!rc.contexts.has(context) && !rc.contexts.has(shared) && !rc.surfaces.has(surface), "process a's contexts and surface");
    assert.ok(rc.color_buffers.has(kept) && !rc.color_buffers.get(kept).refs.has("p" + a.puid), "b's buffer stays, a's reference goes");
    b.process_pipe.close();
    assert.equal(rc.color_buffers.size, 0);
    // (and the page heard of it all: every object made, every one gone)
    host.flush();
    const key = r => r.name.replace(/_(CREATE|DESTROY)$/, "") + ":" + (r.context || r.surface || r.color_buffer || r.image);
    const made = new Set(renderer.records().filter(r => r.name.endsWith("_CREATE")).map(key));
    const gone = new Set(renderer.records().filter(r => r.name.endsWith("_DESTROY")).map(key));
    assert.deepEqual([...made].sort(), [...gone].sort(), "every object the page heard of is gone again");
    assert.ok(made.has("CONTEXT:" + context) && made.has("COLOR_BUFFER:" + kept) && made.has("IMAGE:" + image));
    console.log("PASS: contexts, surfaces, color buffers, images, syncs, processes");
}

// ---- the plugin as built

{
    const file = root + "build/v86-gles.js";
    assert.ok(fs.existsSync(file), "build/v86-gles.js (make build/v86-gles.js)");
    await import(path_to_file_url(file).href);
    const descriptor = globalThis.V86GlesHosts && globalThis.V86GlesHosts.gles;
    assert.equal(descriptor.name, "gles");
    const renderer = fake_renderer();
    const device = descriptor.create({}, { display: DISPLAY, renderer });
    for(const name of ["service", "summary", "get_state", "set_state", "reset"]) assert.equal(typeof device[name], "function", name);
    assert.equal(device.service("qemud:other", () => {}), null);
    const service = device.service("opengles", () => {});
    service.write(new Uint8Array(4));
    service.write(encode_command("rcGetFBParam", [1]));
    await settle();
    assert.ok(service.available());
    assert.deepEqual(service.read(16), new Uint8Array([224, 1, 0, 0]), "480");
    assert.equal(device.summary().counts.rcGetFBParam, 1);
    service.close();
    device.set_state(device.get_state());
    // (the count of connections made is kept; none is open)
    assert.equal(device.summary().connections, 1);
    assert.equal(device.summary().open_connections, 0);
    assert.ok(renderer.messages.includes("hello") && renderer.messages.includes("reset"));
    console.log("PASS: build/v86-gles.js");
}
