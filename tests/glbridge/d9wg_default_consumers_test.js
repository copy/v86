"use strict";
const assert = require("node:assert/strict");
const {makeExecutor} = require("./d3d9_webgpu_executor_test.js");
(async () => {
const {executor, find} = makeExecutor(), a = executor.createDeviceState(1), b = executor.createDeviceState(2);
await executor.initialize();
const samplers = new Map();
for (const state of [a, b]) for (const stage of [0, 5]) {
    for (const mag of [1, 2, 3]) for (const min of [1, 2, 3]) {
        state.samplerStates.set(stage * 64 + 5, mag); state.samplerStates.set(stage * 64 + 6, min);
        const sampler = executor.comparisonSamplerFor(state, stage), descriptor = find("createSampler").find(c => c[2] === sampler)[1];
        const magName = mag === 1 ? "nearest" : "linear", minName = min === 1 ? "nearest" : "linear", key = magName + "/" + minName;
        assert.equal(descriptor.magFilter, magName); assert.equal(descriptor.minFilter, minName); assert.equal(descriptor.compare, "less-equal");
        assert.equal(descriptor.addressModeU, "repeat"); assert.equal(descriptor.addressModeV, "repeat");
        if (samplers.has(key)) assert.equal(sampler, samplers.get(key)); else samplers.set(key, sampler);
    }
}
assert.equal(samplers.size, 4, "mixed MAG/MIN filters need separate cache entries");
a.samplerStates.clear(); assert.equal(executor.comparisonSamplerFor(a, 0), samplers.get("nearest/nearest"), "missing state uses SDK POINT defaults");
assert.throws(() => executor.device.createSampler({compare: null}), TypeError,
    "the fake must reject the null comparison enum rejected by the real browser");
assert.equal(executor.comparisonSamplerFor(a, 0, null), samplers.get("nearest/nearest"),
    "a fixed-function program's null pixel reflection selects the default comparison");
for (const compare of ["never", "less", "equal", "less-equal", "greater", "not-equal", "greater-equal", "always"]) {
    const sampler = executor.comparisonSamplerFor(a, 0, compare);
    assert.equal(sampler.descriptor.compare, compare, "explicit comparison survives: " + compare);
    assert.equal(executor.comparisonSamplerFor(a, 0, compare), sampler, "comparison cache: " + compare);
}
b.samplerStates.set(1, 3); assert.notEqual(executor.comparisonSamplerFor(b, 0), samplers.get("linear/linear"), "addressing is part of the comparison cache");
const layout = {byteLength: 32, entries: [{name: "stage_constant0", source: 0, offset: 0}, {name: "stage_constant3", source: 3, offset: 16}]};
const colors = [0, 0xff000000, 0x00ff0080, 0xa0102030, 0xffffffff];
for (let i = 0; i < colors.length; ++i) {
    const left = colors[i], right = colors[colors.length - 1 - i], backing = new ArrayBuffer(64), words = new Uint32Array(backing);
    words.fill(0xcccccccc); a.textureStageStates.set(32, left); a.textureStageStates.set(3 * 64 + 32, right);
    executor.writeFixedPixelUniforms(a, {pixelUniformLayout: layout}, backing, 16);
    const expected = [left, right].flatMap(argb => [argb >>> 16 & 255, argb >>> 8 & 255, argb & 255, argb >>> 24].map(v => v / 255));
    assert.deepEqual(new Float32Array(backing, 16, 8), new Float32Array(expected));
    assert.deepEqual(Array.from(words.subarray(0, 4)), Array(4).fill(0xcccccccc)); assert.deepEqual(Array.from(words.subarray(12)), Array(4).fill(0xcccccccc));
}
console.log("PASS default consumers: independent POINT/LINEAR/ANISOTROPIC MAG/MIN cache and addressing, exact two-stage RGBA zero/nonzero uniforms with guarded offsets");

})().catch(error => {console.error(error); process.exitCode = 1;});
