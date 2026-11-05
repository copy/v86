"use strict";
const assert = require("node:assert/strict"), P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
const { D3D9WebGPUExecutor } = require("../../src/browser/glbridge/d3d9-webgpu/d3d9_executor.js");
const { countingWebGPU, frameCommands, batch } = require("./d3d9_webgpu_perf_test.js");
(async () => {
    const fake = countingWebGPU(), executor = new D3D9WebGPUExecutor({ getContext: () => fake.context }, { device: fake.device, context: fake.context });
    await executor.submit(batch(frameCommands(true, 1), true));await executor.idle();
    const before = fake.snapshot(), commands = [];
    for (let value = 0; value < 128; value++) {
        for (const [state, item] of [[193, (0xff000000 | value * 0x010101) >>> 0], [57, value]])
            commands.push({ opcode: P.OP.SET_RENDER_STATE, payload: P.encode("SetRenderState", { device_handle: 0x100002, state, value: item }) });
        commands.push({ opcode: P.OP.DRAW_PRIMITIVE, payload: P.encode("DrawPrimitive", { device_handle: 0x100002, primitive_type: 4, primitive_count: 1 }) });
    }
    commands.push({ opcode: P.OP.PRESENT, payload: P.encode("Present", { device_handle: 0x100002, width: 800, height: 600 }) });
    await executor.submit(batch(commands, true));await executor.idle();
    const after = fake.snapshot();
    assert.equal(after.createRenderPipeline, before.createRenderPipeline, "128 blend/stencil values must reuse the same immutable pipeline");
    assert.equal(after.draw - before.draw, 128);
    assert.equal(executor.hostErrors.length, 0);assert.equal(executor.gpuErrors.errors.length, 0);
    const state=executor.devices.get(0x100002),program=state.lastProgram.program;
    state.renderStates.set(27,1);state.renderStates.set(19,7);state.renderStates.set(20,8);
    const mixed={hasDepth:false,formats:["rgba8unorm","rgba8unorm"],opaqueTargetMask:1};
    const first=executor.pipelineFor(program,executor.pipelineStateFor(state,mixed),"triangle-list");
    assert.deepEqual(first.descriptor.fragment.targets.map(t=>[t.blend.color.srcFactor,t.blend.color.dstFactor]),
        [["one","zero"],["dst-alpha","one-minus-dst-alpha"]],"MRT factors follow each logical format");
    const reversed={...mixed,opaqueTargetMask:2};
    const second=executor.pipelineFor(program,executor.pipelineStateFor(state,reversed),"triangle-list");
    assert.notEqual(second,first,"A8/X8 swaps need a distinct pipeline despite identical GPU formats");
    assert.deepEqual(second.descriptor.fragment.targets.map(t=>[t.blend.color.srcFactor,t.blend.color.dstFactor]),
        [["dst-alpha","one-minus-dst-alpha"],["one","zero"]]);
    assert.equal(executor.pipelineFor(program,executor.pipelineStateFor(state,mixed),"triangle-list"),first);
    await executor.submit(batch([{opcode:P.OP.RESET,payload:P.encode("ResetDevice",{old_device_handle:0x100002,
        new_device_handle:0x100002,width:800,height:600,backbuffer_format:22})}],false));
    const reset=executor.devices.get(0x100002);
    assert.equal(reset.backBufferD3DFormat,22);
    assert.equal(executor.renderTargetsFor(reset).opaqueTargetMask,1);
    console.log("D9WG pipeline state: 128 dynamic blend/stencil values create no additional render pipelines");
    console.log("D9WG pipeline state: logical MRT alpha factors, A8/X8 cache separation and Reset format retained");
})().catch(error => { console.error(error);process.exitCode = 1; });
