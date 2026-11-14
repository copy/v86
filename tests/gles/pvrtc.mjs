import assert from "node:assert/strict";
import { decode_pvrtc, pvrtc_bytes } from "../../src/gles/pvrtc.js";
let seed = 0x41390ca3;
for(const [w, h, two, expected] of [[8, 8, false, 0xcd1aeb1b], [16, 32, false, 0xe0ecced6], [32, 8, true, 0xcbd8c393], [1, 4, true, 0xe608485a]])
{
    const data = new Uint8Array(pvrtc_bytes(w, h, two));
    for(let i = 0; i < data.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; data[i] = seed >>> 24; }
    let hash = 2166136261;
    for(const v of decode_pvrtc(w, h, data, two, true)) hash = Math.imul(hash ^ v, 16777619) >>> 0;
    assert.equal(hash, expected, `${w}x${h} ${two ? 2 : 4} bpp reference`);
    const rgb = decode_pvrtc(w, h, data, two, false);
    for(let i = 3; i < rgb.length; i += 4) assert.equal(rgb[i], 255);
}
assert.equal(pvrtc_bytes(15, 4, true), 0);
assert.throws(() => decode_pvrtc(8, 8, new Uint8Array(2), false, true));
console.log("PASS: host PVRTC matches reference hashes, alpha, rectangular wrapping and small mip levels");
const { GLESHost } = await import("../../src/gles/gles_host.js");
const { client, fake_renderer, i32s } = await import("./lib.mjs");
const host = new GLESHost({width:640,height:960,dpi:326}, fake_renderer());
const {call} = await client(host).connect();
const ctx = (await call("rcCreateContext",3,0,2)).ret;
await call("rcMakeCurrent",ctx,0,0);
await call("gles2:glBindTexture",0x0DE1,1);
for(const format of [0x8C00,0x8C01,0x8C02,0x8C03])
{
    const bytes = new Uint8Array(32);
    await call("gles2:glCompressedTexImage2D",0x0DE1,0,format,4,4,0,32,bytes);
    assert.equal((await call("gles2:glGetError")).ret,0);
    await call("gles2:glCompressedTexSubImage2D",0x0DE1,0,0,0,4,4,format,32,bytes);
    assert.equal((await call("gles2:glGetError")).ret,0);
    await call("gles2:glCompressedTexSubImage2D",0x0DE1,0,1,0,4,4,format,32,bytes);
    assert.equal((await call("gles2:glGetError")).ret,0x502);
    await call("gles2:glCompressedTexImage2D",0x0DE1,0,format,4,4,0,16,bytes);
    assert.equal((await call("gles2:glGetError")).ret,0x501);
}
assert.deepEqual(i32s((await call("gles2:glGetIntegerv",0x86A3,20)).outs[0]),[0x8D64,0x8C00,0x8C01,0x8C02,0x8C03]);
console.log("PASS: compressed PVRTC wire uploads, full replacements, format queries and invalid ranges");
