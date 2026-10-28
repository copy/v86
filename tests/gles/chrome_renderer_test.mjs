#!/usr/bin/env node
// The GLES host with a real GPU behind it (tests/gles/chrome_renderer.mjs:
// headless Chrome's renderer page): a window cleared green with a
// scissored red corner, its frame flushed into its color buffer and posted,
// the frame read back (rows from the top: the red corner, GL's bottom left,
// at the frame's bottom left), a color buffer read with its pixels.
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
    console.log("PASS: the GLES host on a real GPU (" + JSON.stringify(renderer.stats) + ")");
}
finally
{
    renderer.close();
}
