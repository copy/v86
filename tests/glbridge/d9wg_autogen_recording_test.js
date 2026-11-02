"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),Module=require("node:module");
const F=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_formats.js"),P=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"),{makeExecutor,buildBatch,command,createDevicePayload,DEVICE}=require("./d3d9_webgpu_executor_test.js");
(async()=>{
 for(const filterable of [false,true]){
  const {executor,fake,find}=makeExecutor();if(filterable)fake.device.features.add("float32-filterable");await executor.initialize();
  if(process.env.D9WG_AUTOGEN_RESOURCE_SOURCE){const methods=require(path.resolve(process.env.D9WG_AUTOGEN_RESOURCE_SOURCE)).createMethods({...F,D9WG:P,D9WGStreamError:Error});for(const name of ["flushGeneratedMips","onGenerateMips"])executor[name]=methods[name];}
  if(process.env.D9WG_AUTOGEN_SURFACE_SOURCE){const methods=require(path.resolve(process.env.D9WG_AUTOGEN_SURFACE_SOURCE)).createMethods(F);executor.replayGenerateMips=methods.replayGenerateMips;}
  if(process.env.D9WG_AUTOGEN_EXECUTOR_SOURCE){const file=path.resolve(__dirname,"../../src/browser/glbridge/d3d9-webgpu/d3d9_executor.js"),m=new Module(file);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(fs.readFileSync(process.env.D9WG_AUTOGEN_EXECUTOR_SOURCE,"utf8"),file);executor.onColorFill=m.exports.D3D9WebGPUExecutor.prototype.onColorFill;}
  const commands=[command(P.OP.CREATE_DEVICE,createDevicePayload(64,64))];
  for(const [handle,format]of [[101,21],[102,114],[103,0x31545844],[104,60],[105,63]])commands.push(command(P.OP.CREATE_TEXTURE_2D,P.encode("CreateTexture2D",{device_handle:DEVICE,resource_handle:handle,width:4,height:4,level_count:1,format,usage:0x400})));
  await executor.submit(buildBatch(commands),{writeGuestMemory(){}});await executor.idle();
  assert.equal(executor.resources.get(101).levelCount,3);assert.equal(executor.resources.get(101).autoGenFilter,2);
  assert.equal(executor.resources.get(102).levelCount,3);assert.equal(executor.resources.get(102).autoGenFilter,filterable?2:1);
  for(const handle of [103,104,105]){const resource=executor.resources.get(handle);assert.equal(resource.levelCount,1);assert(!resource.autoGenerateMips);}
  const resource=executor.resources.get(101),send=async(filter,defer,legacy=false)=>{let payload=P.encode("GenerateMips",{device_handle:DEVICE,resource_handle:101,filter_type:filter,defer_generation:defer});if(legacy)payload=payload.subarray(0,8);await executor.submit(buildBatch([command(P.OP.GENERATE_MIPS,payload)]),{writeGuestMemory(){}});await executor.idle();};
  await send(1,1);assert(resource.mipsDirty);assert.equal(executor.stats.explicitMipGenerations,0);assert(!executor.frame || !executor.frame.ops.some(op=>op.kind==="generate-mips"));
  executor.flushGeneratedMips(resource);await send(2,1);executor.flushGeneratedMips(resource);await send(3,1);await send(0,0,true);
  const ops=executor.frame.ops.filter(op=>op.kind==="generate-mips");assert.deepEqual(ops.map(op=>op.filterType),[1,2,3],"each operation captures its filter, including legacy immediate generation");assert.equal(executor.stats.explicitMipGenerations,1);
  executor.finishFrame(false);await executor.idle();
  assert(executor.blitPipelines.has("bgra8unorm|point|filterable"));assert(executor.blitPipelines.has("bgra8unorm|linear|filterable"));assert(executor.blitPipelines.has("bgra8unorm|linear|filterable|aniso16"));
  assert(find("createSampler").some(call=>call[1].minFilter==="nearest"));assert(find("createSampler").some(call=>call[1].minFilter==="linear"));
  const anisotropic=find("createSampler").find(call=>call[1].maxAnisotropy===16);assert(anisotropic);assert.equal(anisotropic[1].mipmapFilter,"linear");assert.equal(anisotropic[1].magFilter,"linear");
  resource.mipsDirty=false;await executor.submit(buildBatch([command(P.OP.COLOR_FILL,P.encode("ColorFill",{device_handle:DEVICE,texture_handle:101,color:0xffff0000,left:0,top:0,right:4,bottom:4}))]),{writeGuestMemory(){}});await executor.idle();assert(resource.mipsDirty,"GPU ColorFill invalidates generated levels");
  assert.equal(executor.stats.commandsFailed,0);assert.equal(executor.hostErrors.length,0);executor.discardFrame();
 }
 console.log("PASS automatic mip recording: real storage/default feature gates, deferred/snapshotted/legacy generation, POINT/LINEAR/ANISOTROPIC replay and GPU-write invalidation");
})().catch(error=>{console.error(error);process.exitCode=1});
