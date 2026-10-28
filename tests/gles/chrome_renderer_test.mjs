#!/usr/bin/env node
// The GLES host with a real GPU behind it (tests/gles/chrome_renderer.mjs:
// headless Chrome's renderer page): a window cleared green with a
// scissored red corner, its frame flushed into its color buffer and posted,
// the frame read back (rows from the top: the red corner, GL's bottom left,
// at the frame's bottom left), a color buffer read with its pixels; a
// snapshot's page state over the bridge and back; a read whose answers
// both ways are lost on the way (a suspend breaks the requests) asked again.
import assert from "node:assert/strict";
import { GLESHost } from "../../src/gles/gles_host.js";
import { chrome_renderer } from "./chrome_renderer.mjs";
import { client } from "./lib.mjs";

const renderer = await chrome_renderer();
try
{
    const frames = [];
    const host = new GLESHost({ width: 8, height: 8, dpi: 160 }, renderer, (rgba, width, height) => frames.push({ rgba, width, height }));
    const { call, send } = await client(host).connect();
    const context = (await call("rcCreateContext", 3, 0, 2)).ret;
    const surface = (await call("rcCreateWindowSurface", 3, 8, 8)).ret;
    const buffer = (await call("rcCreateColorBuffer", 8, 8, 0x1908)).ret;
    await call("rcSetWindowColorBuffer", surface, buffer);
    await call("rcMakeCurrent", context, surface, surface);
    send("gles2:glClearColor", 0, 1, 0, 1);
    send("gles2:glClear", 0x4000);
    send("gles2:glEnable", 0x0C11);
    send("gles2:glScissor", 0, 0, 2, 2);
    send("gles2:glClearColor", 1, 0, 0, 1);
    send("gles2:glClear", 0x4000);
    assert.equal((await call("rcFlushWindowColorBuffer", surface)).ret, 0);
    await call("rcFBPost", buffer);
    const read = await call("rcReadColorBuffer", buffer, 0, 7, 1, 1, 0x1908, 0x1401, 4);
    assert.deepEqual(Array.from(read.outs[0]), [255, 0, 0, 255], "the color buffer's last row (the bottom) begins red");
    for(let i = 0; i < 100 && !frames.length; i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(frames.length, 1, "the post came back as a frame");
    const f = frames[0];
    const at = (x, y) => Array.from(f.rgba.subarray((y * f.width + x) * 4, (y * f.width + x) * 4 + 4));
    assert.deepEqual([f.width, f.height, at(0, 7), at(0, 0), at(7, 7)], [8, 8, [255, 0, 0, 255], [0, 255, 0, 255], [0, 255, 0, 255]]);
    // a snapshot over the bridge (E5): the page's state fetched, the page
    // reset and given it back; the color buffer reads as before
    await host.prepare_save();
    const state = host.get_state();
    assert.ok(state[2] && state[2][1].length > 0, "the page's state, with the GPU's contents");
    host.set_state(state);
    const back = await call("rcReadColorBuffer", buffer, 0, 0, 8, 8, 0x1908, 0x1401, 256);
    const px = (x, y) => Array.from(back.outs[0].subarray((y * 8 + x) * 4, (y * 8 + x) * 4 + 4));
    assert.deepEqual([px(0, 7), px(0, 0), px(7, 7)], [[255, 0, 0, 255], [0, 255, 0, 255], [0, 255, 0, 255]], "restored: the color buffer's picture");
    // the device's batch and the page's reply each lost once: the page asks
    // for the batch again and posts its reply again, which is taken once
    renderer.lose_answers();
    const lost = await call("rcReadColorBuffer", buffer, 0, 7, 1, 1, 0x1908, 0x1401, 4);
    assert.deepEqual(Array.from(lost.outs[0]), [255, 0, 0, 255], "read after the lost answers");
    assert.ok(renderer.stats.resent >= 1 && renderer.stats.repeated >= 1, "the batch sent again, the reply posted again: " + JSON.stringify(renderer.stats));
    console.log("PASS: the GLES host on a real GPU, a snapshot round trip (" + JSON.stringify(renderer.stats) + ")");
}
finally
{
    renderer.close();
}
