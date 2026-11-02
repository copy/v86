"use strict";
const assert=require("node:assert/strict"),P=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
const {makeExecutor,buildBatch,command,createDevicePayload,createBufferPayload,fvfPayload,element,setStreamSourcePayload,drawPrimitivePayload,DEVICE}=require("./d3d9_webgpu_executor_test.js");
const rs=(state,value)=>command(P.OP.SET_RENDER_STATE,P.encode("SetRenderState",{device_handle:DEVICE,state,value}));
(async()=>{
 const {executor,find}=makeExecutor({diagnostics:false}),draw=command(P.OP.DRAW_PRIMITIVE,drawPrimitivePayload(4,0,1));
 const elements=[element(0,0,2,0),element(0,12,2,3),element(0,24,2,0,1),element(0,36,2,3,1)];
 await executor.submit(buildBatch([command(P.OP.CREATE_DEVICE,createDevicePayload(64,64)),command(P.OP.CREATE_BUFFER,createBufferPayload(0x201,1,144)),command(P.OP.SET_FVF,fvfPayload(0,elements)),command(P.OP.SET_STREAM_SOURCE,setStreamSourcePayload(0,0x201,48)),rs(22,1),rs(151,255),rs(170,0x3e800000),draw]),{writeGuestMemory(){}});
 const first=executor.frame.ops.filter(op=>op.kind==="draw").length,modules=find("createShaderModule").length,pipelines=find("createRenderPipeline").length;assert.equal(first,1);
 await executor.submit(buildBatch([rs(170,0x3f400000),draw]),{writeGuestMemory(){}});
 assert.equal(executor.frame.ops.filter(op=>op.kind==="draw").length,2);
 assert.equal(find("createShaderModule").length,modules,"a tween factor change uses existing shader code");assert.equal(find("createRenderPipeline").length,pipelines,"a tween factor change uses the existing pipeline");
 assert.equal(executor.stats.commandsFailed,0);assert.equal(executor.hostErrors.length,0);
 await executor.submit(buildBatch([command(P.OP.SET_FVF,fvfPayload(0,[element(0,0,2,0)])),draw]),{writeGuestMemory(){}});
 assert.equal(executor.frame.ops.filter(op=>op.kind==="draw").length,2,"missing secondary channels cannot draw world0 geometry");assert.equal(executor.stats.commandsFailed,1);
 executor.finishFrame(false);await executor.idle();console.log("PASS public tween wire: valid draws, factor-only shader/pipeline reuse and missing-channel refusal without a recorded draw");
})().catch(error=>{console.error(error);process.exitCode=1;});
