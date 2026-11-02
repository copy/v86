import assert from "node:assert/strict";
import {createRequire as create_require} from "node:module";
const require=create_require(import.meta.url),P=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"),W=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
export function inspect_render_defaults_wire(bytes,owners,options={}){assert.equal(owners.length,2);const contexts=new Map(owners.map((owner,i)=>[owner,{api:i+8,generations:[],pointMinimumPatches:0,pointMaximumWrites:0,zeroColorArgWrites:0,zeroAlphaArgWrites:0,addressWWrites:0,pending:false}]));
 for(let at=0;at<bytes.length;){assert(at+20<=bytes.length);const size=bytes.readUInt32LE(at+8),context=contexts.get(bytes.readUInt32LE(at));assert(context);assert(size>=8&&at+12+size<=bytes.length);assert.equal(bytes.readUInt16LE(at+12),0xffe1);assert.equal(bytes.readUInt16LE(at+14),0xffff);assert.equal(bytes.readUInt32LE(at+16),size-8);const packet=bytes.subarray(at+20,at+12+size),h=W.readHeader(packet);W.checkStream(h.view,h.end,h.commandCount);
  for(let x=P.STRUCTS.BatchHeader.size;x<h.end;){const op=h.view.getUint16(x,true),length=h.view.getUint32(x+P.F.CommandHeader.size,true),v=P.decode(P.commandStruct(op),h.view,x+P.STRUCTS.CommandHeader.size,length-P.STRUCTS.CommandHeader.size),name=P.OP_NAME[op];
   if(name==="CREATE_DEVICE"||name==="RESET"){assert(!context.pending,"previous creation/reset must synchronize D3D8 point minimum");assert.equal(name,context.generations.length?"RESET":"CREATE_DEVICE");assert.equal(v.enable_auto_depth_stencil,context.generations.length===1?1:0);context.generations.push({kind:name,depth:v.enable_auto_depth_stencil});context.pending=context.api===8;}
   if(context.pending&&name==="SET_RENDER_STATE"){assert.equal(v.state,155,"the first post-create/reset state is the API-specific minimum");assert.equal(v.value,0);context.pointMinimumPatches++;context.pending=false;}
   else if(name==="SET_RENDER_STATE"&&v.state===166)context.pointMaximumWrites++;
   if(name==="SET_TEXTURE_STAGE_STATE"&&v.stage===1&&v.value===0){if(v.state===26)context.zeroColorArgWrites++;if(v.state===27)context.zeroAlphaArgWrites++;}
   if(name==="SET_SAMPLER_STATE"&&v.state===3&&v.value===3&&v.sampler===(context.api===8?7:260))context.addressWWrites++;
   x+=length;
  }at+=12+size;
 }
 for(const c of contexts.values()){assert(!c.pending);assert.equal(c.generations.length,3);assert.equal(c.pointMinimumPatches,c.api===8?3:0);if(options.textureChanges){assert.equal(c.zeroColorArgWrites,3);assert.equal(c.zeroAlphaArgWrites,3);assert.equal(c.addressWWrites,3);}}
 return [...contexts.values()].map(({pending,...context})=>{assert(!pending);return context;});
}
