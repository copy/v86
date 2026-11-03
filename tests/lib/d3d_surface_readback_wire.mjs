import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require=createRequire(import.meta.url),P=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"),W=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
export function inspect_surface_readback_wire(bytes,result){
 assert.equal(result.owners.length,1);const owner=result.owners[0],requests=[];let target=0,bound=0,draws=0,destroyed=false;
 for(let at=0;at<bytes.length;){assert.equal(bytes.readUInt32LE(at),owner);const size=bytes.readUInt32LE(at+8);assert(size>=8&&at+12+size<=bytes.length);assert.equal(bytes.readUInt16LE(at+12),0xffe1);assert.equal(bytes.readUInt32LE(at+16),size-8);const packet=bytes.subarray(at+20,at+12+size),h=W.readHeader(packet);W.checkStream(h.view,h.end,h.commandCount);
  for(let x=P.STRUCTS.BatchHeader.size;x<h.end;){const op=h.view.getUint16(x,true),length=h.view.getUint32(x+P.F.CommandHeader.size,true),decode=name=>P.decode(name,h.view,x+P.STRUCTS.CommandHeader.size,length-P.STRUCTS.CommandHeader.size);
   if(op===P.OP.CREATE_TEXTURE_2D){const d=decode("CreateTexture2D");if(d.width===1024){assert(!target);assert.equal(d.height,1024);assert.equal(d.format,21);assert.equal(d.usage,1);assert.equal(d.pool,0);assert.equal(d.level_count,1);target=d.resource_handle;}}
   if(op===P.OP.SET_RENDER_TARGET){const d=decode("SetRenderTarget");if(!d.target_index)bound=d.color_texture_handle;}
   if(op===P.OP.DRAW_PRIMITIVE_UP){assert(target&&bound===target&&!draws++);const d=decode("DrawPrimitiveUP");assert.equal(d.primitive_type,5);assert.equal(d.primitive_count,2);assert.equal(d.stride,20);assert.equal(d.vertex_count,4);assert.equal(d.vertex_bytes,80);for(let v=0;v<4;v++){const p=d.vertex_data_offset+v*20;assert.equal(packet.readFloatLE(p),(v&1)*1024);assert.equal(packet.readFloatLE(p+4),(v>>>1)*1024);assert.equal(packet.readFloatLE(p+8),.5);assert.equal(packet.readFloatLE(p+12),1);assert.equal(packet.readUInt32LE(p+16),0xffd02060);}}
   if(op===P.OP.READBACK_SURFACE){assert.equal(draws,1);const q=decode("ReadbackSurface"),i=requests.length,rows=[1019,5,1019,1019,1019,1019,5];assert(i<7&&!destroyed);assert.equal(q.texture_handle,target);assert.equal(q.format,21);assert.equal(q.width,1024);assert.equal(q.height,1024);assert.equal(q.face,0);assert.equal(q.level,0);assert.equal(q.first_row,i===1||i===6?1019:0);assert.equal(q.row_count,rows[i]);assert.equal(q.destination_pitch,4096);assert.equal(q.destination_bytes,rows[i]*4096);assert.equal(q.response_offset,P.C.D9WG_READBACK_REGION_OFFSET);assert.equal(q.request_id,i+1);requests.push(q);}
   if(op===P.OP.DESTROY_RESOURCE&&decode("DestroyResource").resource_handle===target){assert.equal(requests.length,7);destroyed=true;}x+=length;
  }at+=12+size;
 }
 assert(target&&destroyed&&draws===1);assert.equal(requests.length,7);for(let phase=0;phase<5;phase++)assert(result.logs["READ.TXT"].includes(`READ ${phase} ${phase===0||phase===4?"00000000":"88760827"}`));assert(result.logs["READ.TXT"].includes("PASS shared readback API=9"));return{owner,draws,requests,pixelsPerSuccessfulCopy:1048576,successfulCopies:2,faults:["stale-id","failed","short-size"],expectedARGB:0xffd02060};
}
