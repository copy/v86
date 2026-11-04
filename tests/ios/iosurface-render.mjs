// Render to a shareable N90 IOSurface and read the actual GPU pixels
// through an independent process's texture attachment.
import assert from "node:assert/strict";
import { GLESHost } from "../../src/gles/gles_host.js";
import { chrome_renderer } from "../gles/chrome_renderer.mjs";
import { client } from "../gles/lib.mjs";

const renderer = await chrome_renderer();
try
{
    const host = new GLESHost({ width: 64, height: 48, dpi: 326 }, renderer);
    async function attach(texture)
    {
        const process = client(host);
        const { call, send } = await process.connect();
        const context = (await call("rcCreateContext", 3, 0, 2)).ret;
        assert.equal((await call("rcMakeCurrent", context, 0, 0)).ret, 1);
        const buffer = (await call("v86AcquireIOSurface", 42, 64, 48, 0x42475241)).ret;
        assert.ok(buffer);
        send("gles2:glBindFramebuffer", 0x8d40, 1);
        if(texture)
        {
            send("gles2:glBindTexture", 0x0de1, 2);
            send("rcBindTexture", buffer);
            send("gles2:glFramebufferTexture2D", 0x8d40, 0x8ce0, 0x0de1, 2, 0);
        }
        else
        {
            send("gles2:glBindRenderbuffer", 0x8d41, 3);
            send("rcBindRenderbuffer", buffer);
            send("gles2:glFramebufferRenderbuffer", 0x8d40, 0x8ce0, 0x8d41, 3);
        }
        assert.equal((await call("gles2:glCheckFramebufferStatus", 0x8d40)).ret, 0x8cd5);
        return { process, call, send, buffer };
    }
    const writer = await attach(false), reader = await attach(true);
    assert.equal(writer.buffer, reader.buffer);
    const cpuPixels = new Uint8Array(64 * 48 * 4);
    for(let y = 0; y < 48; y++)
        for(let x = 0; x < 64; x++) cpuPixels.set([x, y, 200, 255], (64 * y + x) * 4);
    assert.equal((await reader.call("v86IOSurfaceIsCurrent", reader.buffer, 17)).ret, 0);
    assert.equal((await reader.call("v86UploadIOSurface", reader.buffer, 17, cpuPixels)).ret, 1);
    const verifyCPU = async () => {
        const { outs } = await reader.call("gles2:glReadPixels", 0, 0, 64, 48, 0x1908, 0x1401, cpuPixels.length);
        for(let y = 0; y < 48; y++)
            for(let x = 0; x < 64; x++)
            {
                const at = (64 * y + x) * 4;
                assert.deepEqual([...outs[0].subarray(at, at + 4)], [200, 47 - y, x, 255]);
            }
    };
    await verifyCPU();
    writer.send("gles2:glClearColor", 0, 1, 0, 1);
    writer.send("gles2:glClear", 0x4000);
    writer.send("gles2:glEnable", 0xc11);
    writer.send("gles2:glScissor", 0, 0, 2, 2);
    writer.send("gles2:glClearColor", 1, 0, 0, 1);
    writer.send("gles2:glClear", 0x4000);
    await writer.call("gles2:glFinish");
    const check = async (corner = [255, 0, 0, 255]) => {
        const { outs } = await reader.call("gles2:glReadPixels", 0, 0, 64, 48, 0x1908, 0x1401, 64 * 48 * 4);
        for(let y = 0; y < 48; y++)
            for(let x = 0; x < 64; x++)
            {
                const at = (64 * y + x) * 4;
                assert.deepEqual([...outs[0].subarray(at, at + 4)], x < 2 && y < 2 ? corner : [0, 255, 0, 255]);
            }
    };
    assert.equal((await writer.call("v86IOSurfaceIsCurrent", writer.buffer, 17)).ret, 1);
    assert.equal((await reader.call("v86UploadIOSurface", reader.buffer, 17, cpuPixels)).ret, 1);
    await check();
    await host.prepare_save();
    host.set_state(host.get_state());
    // The writer's renderbuffer must still alias the restored color buffer.
    writer.send("gles2:glClearColor", 1, 1, 0, 1);
    writer.send("gles2:glClear", 0x4000);
    await writer.call("gles2:glFinish");
    await check([255, 255, 0, 255]);
    // Reallocating this renderbuffer detaches the IOSurface. Clearing the
    // private storage must leave the other process's pixels untouched.
    writer.send("gles2:glRenderbufferStorage", 0x8d41, 0x8056, 64, 48);
    writer.send("gles2:glDisable", 0xc11);
    writer.send("gles2:glClearColor", 0, 0, 1, 1);
    writer.send("gles2:glClear", 0x4000);
    await writer.call("gles2:glFinish");
    writer.process.process_pipe.close();
    await check([255, 255, 0, 255]);
    assert.equal((await reader.call("v86IOSurfaceIsCurrent", reader.buffer, 17)).ret, 1);
    assert.equal((await reader.call("v86UploadIOSurface", reader.buffer, 18, cpuPixels)).ret, 1);
    await verifyCPU();
    reader.process.process_pipe.close();
    console.log("PASS: IOSurface renderbuffer writes are visible through another process's texture, including after restore");
}
finally { renderer.close(); }
