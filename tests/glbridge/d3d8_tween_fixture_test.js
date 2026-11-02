"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),{gunzipSync}=require("node:zlib"),{createHash}=require("node:crypto");
const P=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"),W=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js"),stem=path.join(__dirname,"fixtures/d3d8_tween_xp"),metadata=JSON.parse(fs.readFileSync(stem+".json")),bytes=gunzipSync(fs.readFileSync(stem+".bin.gz"));
assert.equal(createHash("sha256").update(bytes).digest("hex"),metadata.traceSha256);assert.equal(bytes.length,metadata.traceBytes);assert.equal(metadata.frames,16);assert.equal(metadata.captureBuild.api,8);assert.equal(metadata.captureBuild.frames,16);assert.equal(metadata.scenes.length,8);
assert.deepEqual(metadata.scenes.map(s=>s.factor),[.25,.75,.75,.75,.25,.75,.75,.75]);
assert.deepEqual(metadata.scenes[0].expected.vertices,[[-8,50,.1875,1],[24,18,.1875,1],[56,50,.1875,1]]);
assert.deepEqual(metadata.scenes[0].expected.storedVertices,[[-.125,.21875,.1875,1],[24,18,.1875,1],[56,50,.1875,1]]);
assert.deepEqual(metadata.scenes[4].expected.vertices,[[4,48,.1875,1],[28,24,.1875,1],[52,48,.1875,1]]);
assert.deepEqual(metadata.scenes.map(s=>s.expected.diffuse),[0xbf402010,0xbfbf6030,0xbf000000,0xbfbf6030,0xbf402010,0xbfbf6030,0xbff2793c,0xbfbf6030]);
const declarations=new Map(),streams=new Map([[0,{buffer_handle:0,stride:0}]]),states=new Map([[137,1]]),counts={};let carrier=0,frame=0,draws=0,bound=0,fvf=0,shader=0,raw=0,processed=0,removed=0;
while(carrier<bytes.length){assert(carrier+12<=bytes.length);const size=bytes.readUInt32LE(carrier+8);assert(size>=8&&size<=bytes.length-carrier-12);assert.equal(bytes.readUInt16LE(carrier+12),0xffe1);assert.equal(bytes.readUInt16LE(carrier+14),0xffff);assert.equal(bytes.readUInt32LE(carrier+16),size-8);const packet=bytes.subarray(carrier+20,carrier+12+size),h=W.readHeader(packet);W.checkStream(h.view,h.end,h.commandCount);
 for(let at=P.STRUCTS.BatchHeader.size;at<h.end;){const opcode=h.view.getUint16(at,true),name=P.OP_NAME[opcode],length=h.view.getUint32(at+P.F.CommandHeader.size,true),payload=at+P.STRUCTS.CommandHeader.size,v=P.decode(P.commandStruct(opcode),h.view,payload,length-P.STRUCTS.CommandHeader.size);counts[name]=(counts[name]||0)+1;
  const blob=(first,count)=>{assert(first>=payload&&first+count<=at+length);return packet.subarray(first,first+count);};
  if(name==="CREATE_VERTEX_DECLARATION"){const elements=[];for(let i=0;i<v.element_count;++i){const e=P.decode("VertexElement",h.view,payload+P.STRUCTS.CreateVertexDeclaration.size+i*8,8);elements.push([e.stream,e.offset,e.type,e.usage,e.usage_index]);}declarations.set(v.resource_handle,elements);}
  if(name==="SET_VERTEX_DECLARATION")bound=v.declaration_handle;
  if(name==="SET_VERTEX_SHADER"){shader=v.shader_handle;assert.equal(shader,0);}
  if(name==="SET_FVF"){fvf=v.fvf;bound=0;}
  if(name==="SET_RENDER_STATE")states.set(v.state,v.value);
  if(name==="SET_STREAM_SOURCE")streams.set(v.stream,v);
  if(name==="UPDATE_BUFFER")blob(v.data_offset,v.byte_count);
  if(name==="DRAW_PRIMITIVE"||name==="DRAW_INDEXED_PRIMITIVE"){assert.equal(frame%2,0);assert.equal(draws,0);assert.equal(shader,0);assert.equal(states.get(151),255);assert.equal(states.get(137),1);assert.equal(streams.get(0).buffer_handle,0);assert.equal(streams.get(15).stride,24);assert.equal(streams.get(1).stride,frame===8?0:24);assert(declarations.has(bound));assert.equal(v.primitive_count,1);if(name==="DRAW_INDEXED_PRIMITIVE"){assert([2,10].includes(frame));assert.equal(v.base_vertex_index,1);assert.equal(v.min_vertex_index,1);assert.equal(v.vertex_count,3);}else assert.equal(v.start_vertex,2);draws++;raw++;}
  if(name==="DRAW_PRIMITIVE_UP"){assert.equal(frame%2,1);assert.equal(fvf,0xc4);assert.equal(shader,0);assert.equal(states.get(151),0);assert.equal(states.get(137),0);assert.equal(v.stride,24);assert.equal(v.vertex_count,(metadata.scenes[frame>>1].expected.polygon.length-2)*3);const data=blob(v.vertex_data_offset,v.vertex_bytes),e=metadata.scenes[frame>>1].expected;for(let i=0;i<v.vertex_count;++i){assert.equal(data.readUInt32LE(i*24+16),e.diffuse);assert.equal(data.readUInt32LE(i*24+20),e.specular);}draws++;processed++;}
  if(name==="GUEST_LOG"||name==="SET_CURSOR_PROPERTIES"){const first=name==="GUEST_LOG"?payload+P.STRUCTS.GuestLog.size:v.data_offset,count=name==="GUEST_LOG"?v.text_bytes:v.data_bytes;if(count){assert(blob(first,count).every(b=>b===0));removed+=count;}}
  assert(!["UPDATE_TEXTURE","CREATE_VERTEX_SHADER","CREATE_PIXEL_SHADER"].includes(name));
  if(name==="PRESENT"){assert.equal(draws,1);draws=0;frame++;}at+=length;
 }carrier+=12+size;
}
assert.equal(carrier,bytes.length);assert.equal(frame,16);assert.equal(raw,8);assert.equal(processed,8);assert.equal(declarations.size,4);assert.deepEqual(counts,metadata.counts);assert.equal(removed,metadata.removedPayloads.reduce((sum,r)=>sum+r.bytes,0));
assert.deepEqual([...declarations.values()],[ [[15,0,2,0,0],[15,12,2,3,0],[1,0,2,0,1],[1,12,2,3,1]], [[15,0,2,0,0],[15,12,2,3,0],[1,0,2,0,1]], [[15,0,2,0,0],[15,12,2,3,0],[1,12,2,3,1]], [[15,0,2,0,0],[1,12,2,3,1]] ]);
console.log("PASS frozen XP D3D8 Tween: 16 frames, four exact declarations, eight primary-15/secondary-1 raw draws and eight independently anchored CPU outputs, constant/indexed ranges and private payload removal");
