import assert from "node:assert/strict";
import { GLESHost } from "../../src/gles/gles_host.js";
import { GLESExecutor } from "../../src/gles/page/gles_executor.js";
import { client, fake_renderer, f32s, i32s } from "./lib.mjs";

const host = new GLESHost({ width: 640, height: 960, dpi: 326 }, fake_renderer());
const { call } = await client(host).connect();
for(const api of [1, 2])
{
    const context = (await call("rcCreateContext", 3, 0, api)).ret;
    await call("rcMakeCurrent", context, 0, 0);
    const prefix = api === 1 ? "gles1:" : "gles2:";
    const gl = (name, ...args) => call(prefix + name, ...args);
    const get = async() => f32s((await gl("glGetTexParameterfv", 0x0DE1, 0x84FE, 4)).outs[0])[0];
    assert.deepEqual(i32s((await gl("glGetIntegerv", 0x84FF, 4)).outs[0]), [16]);
    await gl("glBindTexture", 0x0DE1, 1);
    assert.equal(await get(), 1);
    await gl("glTexParameterf", 0x0DE1, 0x84FE, 3.5);
    assert.equal(await get(), 3.5);
    await gl("glTexParameteri", 0x0DE1, 0x84FE, 100);
    assert.equal(await get(), 16);
    await gl("glTexParameterf", 0x0DE1, 0x84FE, 0.5);
    assert.equal((await gl("glGetError")).ret, 0x501);
    assert.equal(await get(), 16, "invalid parameter preserves the sampler");
    await gl("glBindTexture", 0x0DE1, 2);
    assert.equal(await get(), 1, "per texture state");
    assert.equal((await gl("glGetError")).ret, 0);
}
const descriptors = [];
const executor = Object.create(GLESExecutor.prototype);
executor.samplers = new Map();
executor.device = { createSampler: descriptor => { descriptors.push(descriptor); return descriptor; } };
const texture = { min_filter: 0x2600, mag_filter: 0x2600, wrap_s: 0x812F, wrap_t: 0x812F, anisotropy: 3.5 };
for(const sampler of [executor.sampler(texture), executor.sampler3(texture, true, false)])
{
    assert.equal(sampler.maxAnisotropy, 4);
    for(const key of ["minFilter", "magFilter", "mipmapFilter"]) assert.equal(sampler[key], "linear", "WebGPU anisotropy requires linear filtering");
}
assert.equal(descriptors[0].lodMaxClamp, 0, "non mipmapped textures do not access higher levels");
assert.equal(executor.sampler3(texture, false, false).maxAnisotropy, 1, "integer textures retain nearest filtering");
const previous = executor.sampler(texture);
texture.anisotropy = 8;
assert.notEqual(executor.sampler(texture), previous, "anisotropy participates in the cache key");
console.log("PASS: GLES anisotropy state, limits, errors and real WebGPU sampler descriptors");
