import assert from "node:assert/strict";
import { createRequire as create_require } from "node:module";
export function inspect_d3d8_shader_lifetime_wire(bytes) {
 const require=create_require(import.meta.url),P=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"),W=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js"),resources=new Map(),bindings=new Map();let ordinal=0;
 for(let at=0;at<bytes.length;){assert(at+20<=bytes.length);const owner=bytes.readUInt32LE(at),size=bytes.readUInt32LE(at+8);assert(size>=8&&at+12+size<=bytes.length);assert.equal(bytes.readUInt16LE(at+12),0xffe1);assert.equal(bytes.readUInt16LE(at+14),0xffff);assert.equal(bytes.readUInt32LE(at+16),size-8);const packet=bytes.subarray(at+20,at+12+size),h=W.readHeader(packet);W.checkStream(h.view,h.end,h.commandCount);
  for(let offset=P.STRUCTS.BatchHeader.size;offset<h.end;){const op=h.view.getUint16(offset,true),length=h.view.getUint32(offset+P.F.CommandHeader.size,true),name=P.OP_NAME[op],v=P.decode(P.commandStruct(op),h.view,offset+P.STRUCTS.CommandHeader.size,length-P.STRUCTS.CommandHeader.size);ordinal++;const key=handle=>owner+":"+handle;
   if(["CREATE_VERTEX_SHADER","CREATE_PIXEL_SHADER","CREATE_VERTEX_DECLARATION"].includes(name)){const id=key(v.resource_handle);assert(!resources.has(id));resources.set(id,{handle:v.resource_handle,owner,kind:name,created:ordinal,binds:[],destroyed:null});}
   if(["SET_VERTEX_SHADER","SET_PIXEL_SHADER","SET_VERTEX_DECLARATION","SET_FVF"].includes(name)){const type=name==="SET_VERTEX_SHADER"?"vertex":name==="SET_PIXEL_SHADER"?"pixel":"declaration",id=owner+":"+v.device_handle+":"+type,handle=name==="SET_FVF"?0:name==="SET_VERTEX_DECLARATION"?v.declaration_handle:v.shader_handle;bindings.set(id,handle);if(handle){const resource=resources.get(key(handle));assert(resource,"binding unknown shader/declaration");assert.equal(resource.destroyed,null,"binding destroyed shader/declaration");resource.binds.push(ordinal);}}
   if(name==="DESTROY_RESOURCE"){const resource=resources.get(key(v.resource_handle));if(resource){assert.equal(resource.destroyed,null,"duplicate shader destruction");for(const [binding,handle] of bindings)if(binding.startsWith(owner+":"))assert.notEqual(handle,v.resource_handle,"destroying a live binding");resource.destroyed=ordinal;}}
   offset+=length;
  }at+=12+size;
 }
 const shaders=[...resources.values()].filter(r=>r.kind!=="CREATE_VERTEX_DECLARATION");assert.equal(shaders.length,12);assert.equal(shaders.filter(r=>r.kind==="CREATE_VERTEX_SHADER").length,6);assert.equal(shaders.filter(r=>r.kind==="CREATE_PIXEL_SHADER").length,6);assert(shaders.every(r=>r.binds.length&&r.destroyed>Math.max(...r.binds)));
 const owners=new Set(shaders.map(r=>r.owner));
 const declarations=[...resources.values()].filter(r=>owners.has(r.owner)&&r.kind==="CREATE_VERTEX_DECLARATION"&&r.destroyed!==null);assert.equal(declarations.length,6);assert(declarations.every(r=>r.destroyed>r.created));
 return {shaders:shaders.length,vertexShaders:6,pixelShaders:6,vertexDeclarationsDestroyed:declarations.length,resources:[...shaders,...declarations]};
}
