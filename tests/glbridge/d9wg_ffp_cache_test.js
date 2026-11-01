"use strict";
const assert = require("node:assert/strict");
const factory = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_ffp.js"), original = factory.createGenerator;
const generated = { vertex: 0, pixel: 0 };
factory.createGenerator = dependencies => {
    const generator = original(dependencies);
    for (const [stage, name] of [["vertex", "buildFixedFunctionVertexShader"], ["pixel", "buildFixedFunctionPixelShader"]]) {
        const build = generator[name];
        generator[name] = (...args) => { generated[stage]++;return build(...args); };
    }
    return generator;
};
const { D3D9WebGPUExecutor } = require("../../src/browser/glbridge/d3d9-webgpu/d3d9_executor.js");
const { countingWebGPU, frameCommands, batch } = require("./d3d9_webgpu_perf_test.js");
(async () => {
    const fake = countingWebGPU(), executor = new D3D9WebGPUExecutor({ getContext: () => fake.context }, { device: fake.device, context: fake.context });
    await executor.submit(batch(frameCommands(true), true));await executor.idle();
    assert.deepEqual(generated, { vertex: 1, pixel: 1 });
    await executor.submit(batch(frameCommands(false), true));await executor.idle();
    assert.deepEqual(generated, { vertex: 1, pixel: 1 }, "repeated public draws must not regenerate either FFP stage");
    await executor.clearShaderCache();
    await executor.submit(batch(frameCommands(false), true));await executor.idle();
    assert.deepEqual(generated, { vertex: 2, pixel: 2 }, "clearing shaders must invalidate signature-indexed modules too");
    assert.equal(executor.hostErrors.length, 0);assert.equal(executor.gpuErrors.errors.length, 0);
    console.log("D9WG FFP: signature hits avoid generation across draws and shader clearing invalidates both stages");
})().catch(error => { console.error(error);process.exitCode = 1; });
