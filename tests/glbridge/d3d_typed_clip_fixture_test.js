"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),{gunzipSync}=require("node:zlib"),{createHash}=require("node:crypto");
const P=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"),W=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
const metadata=require("./fixtures/d3d9_processed_typed_clip_xp.json"),reference=require("./fixtures/d3d_typed_clip_reference.json");
const bytes=gunzipSync(fs.readFileSync(path.join(__dirname,"fixtures/d3d9_processed_typed_clip_xp.bin.gz")));
assert.equal(createHash("sha256").update(bytes).digest("hex"),metadata.traceSha256);assert.equal(bytes.length,metadata.traceBytes);
assert.equal(metadata.captureBuild.frames,76);assert.equal(reference.cases.length,19);assert.deepEqual(metadata.pairs,[[0,1],[3,2]]);
let carrier=0,frames=0,remapped=false,remaps=0,restores=0,emissions=0,removed=0,shaders=0;
const observed=new Set();let elements;
while (carrier<bytes.length){
 const size=bytes.readUInt32LE(carrier+8),packet=bytes.subarray(carrier+20,carrier+12+size),header=W.readHeader(packet);
 assert.equal(bytes.readUInt16LE(carrier+12),0xffe1);assert.equal(bytes.readUInt16LE(carrier+14),0xffff);assert.equal(bytes.readUInt32LE(carrier+16),size-8);
 W.checkStream(header.view,header.end,header.commandCount);
 for (let at=P.STRUCTS.BatchHeader.size;at<header.end;){
  const opcode=header.view.getUint16(at,true),length=header.view.getUint32(at+P.F.CommandHeader.size,true),payload=at+P.STRUCTS.CommandHeader.size;
  const value=P.decode(P.commandStruct(opcode),header.view,payload,length-P.STRUCTS.CommandHeader.size);
  if ([P.OP.UPDATE_TEXTURE,P.OP.GUEST_LOG,P.OP.SET_CURSOR_PROPERTIES].includes(opcode)){
   const first=opcode===P.OP.GUEST_LOG?payload+P.STRUCTS.GuestLog.size:value.data_offset,count=opcode===P.OP.GUEST_LOG?value.text_bytes:value.data_bytes;
   assert(first>=payload&&first+count<=at+length);assert(packet.subarray(first,first+count).every(n=>n===0));removed+=count;
  }
  if (opcode===P.OP.CREATE_PIXEL_SHADER){assert.equal(value.instruction_token_count,9);assert.deepEqual(Array.from({length:9},(_,i)=>header.view.getUint32(value.code_offset+i*4,true)),metadata.proceduralShaderTokens);shaders++;}
  if (opcode===P.OP.SET_FVF&&value.fvf===0){
   assert(!remapped);const row=reference.cases[Math.floor(frames/4)];assert(frames%4===1||row.point);
   elements=Array.from({length:value.element_count},(_,i)=>P.decode("VertexElement",header.view,payload+P.STRUCTS.SetFVF.size+i*8,8));
   assert.deepEqual(elements.map(e=>[e.stream,e.offset,e.type,e.usage,e.usage_index]),[[0,0,3,9,0],[0,16,row.type===4?4:3,10,row.specular?1:0],...(row.point?[[0,32,0,4,0]]:[])]);
   remapped=true;remaps++;
  }
  if (remapped&&opcode===P.OP.DRAW_PRIMITIVE_UP){
   const row=reference.cases[Math.floor(frames/4)];assert.equal(value.stride,row.point?36:row.type===4?20:32);assert.equal(value.vertex_bytes,value.vertex_count*value.stride);assert.equal(value.primitive_type,row.point?1:4);
   for (let v=0;v<value.vertex_count;++v){const base=value.vertex_data_offset+v*value.stride;
    for (let c=0;c<4;++c)assert(Number.isFinite(header.view.getFloat32(base+c*4,true)));assert(header.view.getFloat32(base+12,true)>0);
    if (row.type===4)assert.equal(header.view.getUint32(base+16,true),Buffer.from(row.bytes).readUInt32LE());
    else for (let c=0;c<4;++c)assert.equal(header.view.getFloat32(base+16+c*4,true),Math.fround(row.decoded[c]));
    if (row.point)assert.equal(header.view.getFloat32(base+32,true),8.5);
   }
   observed.add(Math.floor(frames/4));emissions++;
  }
  if (remapped&&opcode===P.OP.SET_VERTEX_DECLARATION){assert(value.declaration_handle>0);remapped=false;restores++;}
  if (opcode===P.OP.PRESENT){assert(!remapped);frames++;}
  at+=length;
 }
 carrier+=12+size;
}
assert.equal(carrier,bytes.length);assert.equal(frames,76);assert.equal(observed.size,19);assert.equal(remaps,21);assert.equal(restores,remaps);assert.equal(emissions,remaps);assert.equal(shaders,1);
assert.equal(removed,metadata.removedPayloads.reduce((sum,row)=>sum+row.bytes,0));
console.log("PASS XP typed clipping fixture: 76 frames, 19 cases, 21 bounded expanded emissions/restores, exact floating/packed values and one specified procedural shader; unrelated pixels/text absent");
