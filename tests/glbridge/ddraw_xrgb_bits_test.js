"use strict";
const assert=require('node:assert/strict'),F=require(process.env.DDRAW_XRGB_FORMATS_SOURCE||'../../src/browser/glbridge/d3d9-webgpu/d9wg_formats.js'),P=require('../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js');
if(process.env.DDRAW_XRGB_RESOURCES_SOURCE)require(process.env.DDRAW_XRGB_RESOURCES_SOURCE);
const {makeExecutor,flushTextureUploads}=require('./d3d9_webgpu_executor_test.js');
let checks=0;
for(let x=0;x<256;x++)for(const rgb of[0,0x010203,0xff00ff,0xcccccc,0xffffff]){
 const word=(x*0x1000000+rgb)>>>0,src=new Uint8Array(8).fill(0x51);new DataView(src.buffer).setUint32(2,word,true);
 for(const raw of[false,true]){
  const gpu=new Uint8Array(12).fill(0x71),out=new Uint8Array(12).fill(0x61);
  F.expandRowToGPU(22,src,2,1,gpu,4,null,raw);assert.deepEqual([...gpu.subarray(4,8)],[rgb>>>16,(rgb>>>8)&255,rgb&255,raw?x:255]);checks++;
  F.packGPUReadbackRow(22,'rgba8unorm',gpu,4,1,out,3,raw);assert.equal(new DataView(out.buffer).getUint32(3,true),raw?word:(rgb+0xff000000)>>>0);checks++;
  assert(out.subarray(0,3).every(x=>x===0x61)&&out.subarray(7).every(x=>x===0x61));checks++;
  assert.deepEqual(F.nativeFillRGBA(22,word,raw).map(v=>Math.round(v*255)),[rgb>>>16,(rgb>>>8)&255,rgb&255,raw?x:255]);checks++;
 }
}
assert.equal(F.samplingSwizzle(22),'rgb1');
(async()=>{
 const {executor,find}=makeExecutor();
 const metadata={writeGuestMemory(){}};
 const tex=(handle,format,usage,cube=false)=>({opcode:cube?P.OP.CREATE_TEXTURE_CUBE:P.OP.CREATE_TEXTURE_2D,payload:{device_handle:1,resource_handle:handle,...(cube?{edge_length:4}:{width:4,height:1}),level_count:1,format,usage,pool:0}});
 await executor.submit(P.encodeBatch([{opcode:P.OP.CREATE_DEVICE,payload:{device_handle:1,width:4,height:1}},tex(2,22,P.C.D9WG_USAGE_DDRAW_XRGB_BITS),tex(3,22,0),tex(4,21,P.C.D9WG_USAGE_DDRAW_XRGB_BITS),tex(5,22,P.C.D9WG_USAGE_DDRAW_XRGB_BITS,true)]),metadata);
 assert(executor.resources.get(2).ddXrgbBits);assert(!executor.resources.get(3).ddXrgbBits&&!executor.resources.get(4).ddXrgbBits);assert(executor.resources.get(5).ddXrgbBits);
 const update=h=>({opcode:P.OP.UPDATE_TEXTURE,payload:{resource_handle:h,width:4,height:1,depth:1,row_pitch:16,data_bytes:16},blobs:[{field:'data_offset',data:Uint8Array.of(3,2,1,0x77,3,2,1,0,255,0,255,0x77,255,0,255,0)}]});
 await executor.submit(P.encodeBatch([update(2),update(3),update(5)]),metadata);await executor.idle();
 // The fake device records actual staged GPU upload bytes, not inferred flags.
 const writes=flushTextureUploads(executor,find);
 for(const h of[2,3,5]){
  const texture=executor.resources.get(h).gpuTexture,copy=writes.find(c=>c[1].texture===texture);assert(copy,'Missing staged texture '+h);
  assert.deepEqual([...copy[2].subarray(0,16)],[1,2,3,h===3?255:0x77,1,2,3,h===3?255:0,255,0,255,h===3?255:0x77,255,0,255,h===3?255:0]);
 }

 assert(!executor.stats.commandsFailed&&!executor.hostErrors.length);
 console.log('PASS XRGB conversion '+checks+' checks; resource opt-in/cube creation and real upload dispatch; GPU pixel test required separately');
})().catch(e=>{console.error(e);process.exitCode=1;});
