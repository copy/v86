"use strict";
const assert = require("node:assert/strict");
const { makeExecutor } = require("./d3d9_webgpu_executor_test.js");
const { frameCommands, batch } = require("./d3d9_webgpu_perf_test.js");
const P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
const DEVICE = 0x100002;
const rs = (id, value) => ({ opcode: P.OP.SET_RENDER_STATE,
    payload: P.encode("SetRenderState", { device_handle: DEVICE, state: id, value }) });
const tss = (id, value) => ({ opcode: P.OP.SET_TEXTURE_STAGE_STATE,
    payload: P.encode("SetTextureStageState", { device_handle: DEVICE, stage: 0, state: id, value }) });
const draw = { opcode: P.OP.DRAW_PRIMITIVE,
    payload: P.encode("DrawPrimitive", { device_handle: DEVICE, primitive_type: 4, primitive_count: 1 }) };

(async () => {
    const { executor } = makeExecutor({ diagnostics: false });
    const setup = frameCommands(true, 3);setup.pop();
    await executor.submit(batch(setup, false));
    assert.equal(executor.stats.programBuilds, 1);
    assert.equal(executor.stats.programCacheHits, 2);
    assert.equal(executor.stats.uniformSlotReuses, 2);
    const state = executor.devices.get(DEVICE), original = state.lastProgram.program;
    const constants = state.lastConstants.slot;
    await executor.submit(batch([rs(22, 2), rs(60, 0xff123456), draw], false));
    assert.equal(state.lastProgram.program, original);
    assert.equal(state.lastConstants.slot, constants, "cull and unused texture factor cannot invalidate uniforms");
    await executor.submit(batch([rs(24, 123), draw], false));
    assert.equal(state.lastProgram.program, original, "ALPHAREF is dynamic");
    assert.notEqual(state.lastConstants.slot, constants, "dynamic ALPHAREF must invalidate uniform bytes");

    // Consuming TFACTOR changes the layout once. Its subsequent values must
    // change the packed bytes without rebuilding either shader or program.
    await executor.submit(batch([tss(1, 2), tss(2, 3), draw], false));
    const textured = state.lastProgram.program, firstFactor = state.lastConstants.slot;
    assert(textured.pixelSignature.usesTextureFactor);
    const builds = executor.stats.programBuilds;
    await executor.submit(batch([rs(60, 0xffabcdef), draw], false));
    assert.equal(executor.stats.programBuilds, builds);
    assert.equal(state.lastProgram.program, textured);
    assert.notEqual(state.lastConstants.slot, firstFactor);

    executor.debug.forceSolidAllDraws = true;
    await executor.submit(batch([draw], false));
    assert.equal(executor.stats.programBuilds, builds + 1, "direct debug changes invalidate programs");
    const solid = state.lastProgram.program;
    await executor.clearShaderCache();
    await executor.submit(batch([draw], false));
    assert.notEqual(state.lastProgram.program.vertexModule, solid.vertexModule, "shader clearing must retire program references");

    // A comparison executor takes the original full builder on every wire
    // draw. Draw diagnostics must count draws equally on cache hits.
    const cached = makeExecutor({ diagnostics: false }), uncached = makeExecutor({ diagnostics: false, cachePrograms: false });
    const commands = frameCommands(true, 9);commands.pop();
    commands.push(tss(1, 2), tss(2, 2), draw, draw, draw);
    await cached.executor.submit(batch(commands, false));
    await uncached.executor.submit(batch(commands, false));
    for (const name of Object.keys(cached.executor.stats).filter(name => /^(drawsWith|zeroNormal|blendedDraws|drawCalls|indexedDrawCalls)/.test(name)))
        assert.equal(cached.executor.stats[name], uncached.executor.stats[name], name + " must count cache hits as draws");
    assert(cached.executor.stats.programBuilds < uncached.executor.stats.programBuilds);
    for (const item of [executor, cached.executor, uncached.executor]) {
        item.finishFrame(false);await item.idle();
        assert.equal(item.hostErrors.length, 0);assert.equal(item.gpuErrors.errors.length, 0);
    }
    console.log("D9WG program reuse: public state changes, uniform liveness, debug toggles, cache clearing and per-draw counters pass");
})().catch(error => { console.error(error);process.exitCode = 1; });
