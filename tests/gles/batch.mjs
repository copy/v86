#!/usr/bin/env node
// GLES batches (src/gles/gles_host.js, gles_batch.js; docs/gles-proxy-plan.md
// E2): what the host sends the renderer channel and when:
// - records as written and read back (every field, a command's bytes and
//   its decoded arguments, an update's pixels);
// - sent at the flush points (a frame, glFinish, a post), not before; a big
//   upload sends the batch at once;
// - backpressure: with MAX_IN_FLIGHT batches not yet run, the frame's
//   answer waits for the oldest; glFinish's likewise;
// - reads: glReadPixels and rcReadColorBuffer wait for the page's pixels;
// - a lost renderer: what waited is answered (zeros), nothing more is sent;
//   without a renderer nothing waits at all;
// - the reader refuses what is not a batch.
import assert from "node:assert/strict";
import { GLESHost, FLUSH_BYTES, MAX_IN_FLIGHT } from "../../src/gles/gles_host.js";
import { read_gles_batch } from "../../src/gles/gles_batch.js";
import { GLES, GLES_MAGIC, GXWriter } from "../../src/graphics_adapters/renderer_protocol.js";
import { client, cstring, fake_renderer, settle } from "./lib.mjs";

const DISPLAY = { width: 480, height: 800, dpi: 240 };

/** A host, a connection with a GLES 2.0 context on a 64 by 64 window and its color buffer */
async function setup(renderer)
{
    const host = new GLESHost(DISPLAY, renderer);
    const conn = await client(host).connect();
    const context = (await conn.call("rcCreateContext", 0, 0, 2)).ret;
    const surface = (await conn.call("rcCreateWindowSurface", 0, 64, 64)).ret;
    const buffer = (await conn.call("rcCreateColorBuffer", 64, 64, 0x1908)).ret;
    await conn.call("rcSetWindowColorBuffer", surface, buffer);
    await conn.call("rcMakeCurrent", context, surface, surface);
    return { host, conn, context, surface, buffer };
}

// ---- records, flush points

{
    const renderer = fake_renderer();
    const { host, conn, context, surface, buffer } = await setup(renderer);
    assert.equal(renderer.batches.length, 0, "nothing sent before a flush point");
    conn.send("gles2:glClearColor", 0.25, 0.5, 0.75, 1);
    conn.send("gles2:glClear", 0x4000);
    const pixels = new Uint8Array(8 * 8 * 4).map((_, i) => i);
    await conn.call("rcUpdateColorBuffer", buffer, 4, 4, 8, 8, 0x1908, 0x1401, pixels);
    assert.equal(renderer.batches.length, 0);
    assert.equal((await conn.call("rcFlushWindowColorBuffer", surface)).ret, 0);
    assert.equal(renderer.batches.length, 1, "the frame sent the batch");
    const records = read_gles_batch(renderer.batches[0], true);
    const names = records.map(r => r.name);
    assert.deepEqual(names, ["CONTEXT_CREATE", "SURFACE_CREATE", "COLOR_BUFFER_CREATE", "SURFACE_COLOR_BUFFER", "MAKE_CURRENT",
        "COMMAND", "COMMAND", "COLOR_BUFFER_UPDATE", "FLUSH_SURFACE"]);
    const by = name => records.find(r => r.name === name);
    assert.deepEqual([by("CONTEXT_CREATE").context, by("CONTEXT_CREATE").config, by("CONTEXT_CREATE").share, by("CONTEXT_CREATE").api], [context, 0, 0, 2]);
    assert.deepEqual([by("SURFACE_CREATE").width, by("SURFACE_CREATE").height], [64, 64]);
    assert.deepEqual([by("MAKE_CURRENT").context, by("MAKE_CURRENT").draw, by("MAKE_CURRENT").read], [context, surface, surface]);
    const clear = records[5];
    assert.equal(clear.command.name, "glClearColor");
    assert.deepEqual(clear.args, [0.25, 0.5, 0.75, 1]);
    assert.equal(records[6].command.name, "glClear");
    const update = by("COLOR_BUFFER_UPDATE");
    assert.deepEqual([update.color_buffer, update.x, update.y, update.width, update.height, update.length], [buffer, 4, 4, 8, 8, 256]);
    assert.deepEqual(update.bytes, pixels);
    assert.equal(by("FLUSH_SURFACE").surface, surface);
    // a post, glFinish
    await conn.call("rcFBPost", buffer);
    assert.equal(renderer.batches.length, 2);
    assert.deepEqual(read_gles_batch(renderer.batches[1]).map(r => r.name), ["POST"]);
    conn.send("gles2:glViewport", 0, 0, 32, 32);
    assert.equal((await conn.call("gles2:glFinishRoundTrip")).ret, 0);
    assert.equal(renderer.batches.length, 3, "glFinishRoundTrip sent it");
    await conn.call("gles2:glFinishRoundTrip");
    assert.equal(renderer.batches.length, 3, "an empty batch is not sent");
    // a big upload: sent once the batch passes FLUSH_BYTES
    const big = new Uint8Array(1024 * 1024 * 4 + 1024);
    for(let i = 0; i * big.length <= FLUSH_BYTES; i++) await conn.call("rcUpdateColorBuffer", buffer, 0, 0, 1024, 1025, 0x1908, 0x1401, big);
    assert.equal(renderer.batches.length, 4, "the size sent it");
    assert.equal(host.summary().batches.submitted, 4);
    console.log("PASS: records, flush points");
}

// ---- backpressure

{
    const renderer = fake_renderer({ manual: true });
    const { conn, surface } = await setup(renderer);
    const frames = [];
    for(let i = 0; i < MAX_IN_FLIGHT; i++)
    {
        conn.send("gles2:glClear", 0x4000);
        frames.push(await conn.call("rcFlushWindowColorBuffer", surface));
    }
    assert.ok(frames.every(f => f.ret === 0), "two frames in flight: answered at once");
    conn.send("gles2:glClear", 0x4000);
    let answered = false;
    const third = conn.call("rcFlushWindowColorBuffer", surface).then(r => { answered = true; return r; });
    await settle();
    assert.equal(answered, false, "a third waits for the first to run");
    renderer.run(1);
    assert.equal((await third).ret, 0);
    assert.ok(answered);
    renderer.run();
    console.log("PASS: backpressure");
}

// ---- reads

{
    const renderer = fake_renderer({ manual: true });
    const { conn, buffer } = await setup(renderer);
    let read = null;
    const pending = conn.call("gles2:glReadPixels", 0, 0, 2, 2, 0x1908, 0x1401, 16).then(r => { read = r; });
    await settle();
    assert.equal(read, null, "the read waits for the page");
    const sent = read_gles_batch(renderer.batches.at(-1));
    const request = sent.find(r => r.name === "READ_PIXELS");
    assert.deepEqual([request.x, request.y, request.width, request.height, request.format, request.type], [0, 0, 2, 2, 0x1908, 0x1401]);
    renderer.run();
    await pending;
    assert.deepEqual(read.outs[0], new Uint8Array(16).fill(request.request), "the page's pixels");
    const cb = conn.call("rcReadColorBuffer", buffer, 0, 0, 1, 1, 0x1908, 0x1401, 4);
    await settle();
    renderer.run();
    const answer = await cb;
    assert.equal(answer.outs[0].length, 4);
    // a refused read is not sent and does not wait
    const before = renderer.batches.length;
    assert.deepEqual((await conn.call("gles2:glReadPixels", 0, 0, 2, 2, 0x1907, 0x1401, 12)).outs[0], new Uint8Array(12));
    assert.equal(renderer.batches.length, before);
    assert.equal((await conn.call("gles2:glGetError")).ret, 0x0502, "RGB is not a read format");
    console.log("PASS: reads");
}

// ---- a lost renderer; none

{
    const renderer = fake_renderer({ manual: true });
    const { host, conn, surface } = await setup(renderer);
    let read = null;
    const pending = conn.call("gles2:glReadPixels", 0, 0, 1, 1, 0x1908, 0x1401, 4).then(r => { read = r; });
    await settle();
    const warn = console.warn;
    console.warn = () => {};
    host.receive({ type: "lost", reason: "test" });
    console.warn = warn;
    await pending;
    assert.deepEqual(read.outs[0], new Uint8Array(4), "answered: zeros");
    const count = renderer.batches.length;
    conn.send("gles2:glClear", 0x4000);
    assert.equal((await conn.call("rcFlushWindowColorBuffer", surface)).ret, 0);
    assert.equal(renderer.batches.length, count, "nothing more is sent");

    const alone = await setup(null);
    alone.conn.send("gles2:glClear", 0x4000);
    assert.equal((await alone.conn.call("rcFlushWindowColorBuffer", alone.surface)).ret, 0);
    assert.deepEqual((await alone.conn.call("gles2:glReadPixels", 0, 0, 1, 1, 0x1908, 0x1401, 4)).outs[0], new Uint8Array(4));
    assert.equal(alone.host.summary().batches.submitted, 0);
    void cstring;
    console.log("PASS: a lost renderer, none");
}

// ---- the reader

{
    const writer = new GXWriter(GLES_MAGIC);
    writer.command(GLES.POST, [7]);
    const bytes = writer.finish();
    assert.deepEqual(read_gles_batch(bytes), [{ op: GLES.POST, name: "POST", color_buffer: 7 }]);
    const bad = bytes.slice();
    bad[0] ^= 1;
    assert.throws(() => read_gles_batch(bad), /magic/);
    const short = bytes.slice(0, bytes.length - 4);
    assert.throws(() => read_gles_batch(short), /dwords in the header/);
    const gx = new GXWriter();
    gx.command(1, [1]);
    assert.throws(() => read_gles_batch(gx.finish()), /magic/, "a GX batch is not a GLES one");
    console.log("PASS: the reader");
}
