"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),{gunzipSync}=require("node:zlib"),{createHash}=require("node:crypto");
const P=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"),W=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js"),directory=path.join(__dirname,"fixtures"),reference=JSON.parse(fs.readFileSync(directory+"/d3d_palette_reference.json"));
for(const api of [8,9]){const stem=directory+"/d3d"+api+"_palette_xp",metadata=JSON.parse(fs.readFileSync(stem+".json")),bytes=gunzipSync(fs.readFileSync(stem+".bin.gz")),palettes=new Map(),formats=new Map(),sources=new Map();assert.equal(createHash("sha256").update(bytes).digest("hex"),metadata.traceSha256);assert.equal(bytes.length,metadata.traceBytes);let selected=0,texture=0,frame=0,draws=0;
 for(let at=0;at<bytes.length;){assert(at+12<=bytes.length);const size=bytes.readUInt32LE(at+8);assert(size>=8&&size<=bytes.length-at-12);assert.equal(bytes.readUInt16LE(at+12),0xffe1);assert.equal(bytes.readUInt16LE(at+14),0xffff);assert.equal(bytes.readUInt32LE(at+16),size-8);const packet=bytes.subarray(at+20,at+12+size),h=W.readHeader(packet);W.checkStream(h.view,h.end,h.commandCount);
  for(let offset=P.STRUCTS.BatchHeader.size;offset<h.end;){const opcode=h.view.getUint16(offset,true),name=P.OP_NAME[opcode],length=h.view.getUint32(offset+P.F.CommandHeader.size,true),payload=offset+P.STRUCTS.CommandHeader.size,v=P.decode(P.commandStruct(opcode),h.view,payload,length-P.STRUCTS.CommandHeader.size);const blob=(first,count)=>{assert(first>=payload&&first+count<=offset+length);return packet.subarray(first,first+count);};
   if(name==="CREATE_TEXTURE_2D")formats.set(v.resource_handle,v.format);
   if(name==="UPDATE_TEXTURE"){assert([40,41].includes(formats.get(v.resource_handle)));sources.set(v.resource_handle,Buffer.from(blob(v.data_offset,v.data_bytes)));}
   if(name==="SET_PALETTE"){assert.equal(v.entry_count,256);palettes.set(v.palette_index,Buffer.from(blob(v.data_offset,1024)));}
   if(name==="SET_CURRENT_TEXTURE_PALETTE")selected=v.palette_index;
   if(name==="SET_TEXTURE"&&v.stage===0)texture=v.texture_handle;
   if(name==="DRAW_PRIMITIVE_UP"){assert(frame<reference.frames.length);assert(draws<2);assert.equal(formats.get(texture),draws?40:41);const source=sources.get(texture);assert(source);const table=palettes.get(selected),value=table?table.readUInt32LE(source[0]*4):0xffffffff;const color=[value&255,(value>>>8)&255,(value>>>16)&255,draws?source[1]:value>>>24],expected=reference.paletteBGRA[reference.frames[frame].palette].slice();if(draws)expected[3]=64;assert.deepEqual(color,expected,"API "+api+" frame "+frame+" "+reference.frames[frame].name);draws++;}
   if(name==="PRESENT"){assert.equal(draws,2);draws=0;frame++;}
   if(name==="GUEST_LOG"){const data=blob(payload+P.STRUCTS.GuestLog.size,v.text_bytes);assert(data.every(b=>b===0));}
   if(name==="SET_CURSOR_PROPERTIES"&&v.data_bytes)assert(blob(v.data_offset,v.data_bytes).every(b=>b===0));
   offset+=length;
  }at+=12+size;
 }assert.equal(frame,12);assert.equal(draws,0);assert.equal(sources.size,2);assert.equal(palettes.size,2);assert.equal(metadata.captureBuild.api,api);
}
console.log("PASS frozen XP palette traces: 24 frames, 48 independent indexed colors and alpha values, checked boundaries, two uploads per API and cleared private payloads");
