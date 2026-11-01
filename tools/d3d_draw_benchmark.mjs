// Public wire draw recording on a no-op counting GPU; excludes replay, driver
// and GPU time. Run with --uncached-ffp for the former generation-per-draw path.
import { createRequire as create_require } from "node:module";
import { performance } from "node:perf_hooks";
import { cpus } from "node:os";
const require = create_require(import.meta.url);
const { countingWebGPU: counting_gpu, frameCommands: frame_commands, batch } = require("../tests/glbridge/d3d9_webgpu_perf_test.js");
const { D3D9WebGPUExecutor, buildFixedFunctionVertexShader: build_vertex, buildFixedFunctionPixelShader: build_pixel } = require("../src/browser/glbridge/d3d9-webgpu/d3d9_executor.js");
const fake = counting_gpu();
const executor = new D3D9WebGPUExecutor({ getContext: () => fake.context }, {
    device: fake.device, context: fake.context, uniformRingBytes: 16 * 1024 * 1024,
});
const uncached = process.argv.includes("--uncached-ffp"), draws = 2000, rounds = 30;
if(uncached) executor.options.cachePrograms = false;
if(uncached) executor.fixedModuleFor = function(key, stage, signature, debug_mode) {
    return this.moduleFor(stage === "vertex" ? build_vertex(signature)
        : build_pixel(signature, debug_mode), key);
};
await executor.submit(batch(frame_commands(true), true));
await executor.idle();
const commands = frame_commands(false, draws);
commands.pop(); // Present/replay is deliberately outside the recorded interval.
const wire = batch(commands, false), samples = [];
for(let round = 0; round < rounds + 10; round++) {
    const start = performance.now();
    await executor.submit(wire);
    const micros = (performance.now() - start) * 1000 / draws;
    if(round >= 10) samples.push(micros);
    executor.finishFrame(false);
    await executor.idle();
}
samples.sort((a, b) => a - b);
if(executor.hostErrors.length || executor.gpuErrors.errors.length || executor.stats.droppedDraws)
    throw new Error("benchmark encountered a renderer failure");
console.log(JSON.stringify({ benchmark: "wire decode + two state writes + fixed-function DrawPrimitive recording", draws, rounds,
    uncachedFFP: uncached, programBuilds: executor.stats.programBuilds, programCacheHits: executor.stats.programCacheHits, medianMicrosPerDraw: samples[Math.floor(rounds / 2)], p90MicrosPerDraw: samples[Math.floor(rounds * 0.9)],
    device: "no-op counting GPU", includesReplay: false, includesGPUTime: false,
    environment: { node: process.version, arch: process.arch, platform: process.platform, cpu: cpus()[0].model } }));
