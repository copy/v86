import assert from "node:assert/strict";
import { createRequire as create_require } from "node:module";
export function inspect_d3d9_object_recording_wire(bytes) {
 const require=create_require(import.meta.url),P=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"),W=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js"),owners=new Map();
 for(let at=0;at<bytes.length;){assert(at+20<=bytes.length);const owner=bytes.readUInt32LE(at),size=bytes.readUInt32LE(at+8);assert(size>=8&&at+12+size<=bytes.length);assert.equal(bytes.readUInt16LE(at+12),0xffe1);assert.equal(bytes.readUInt16LE(at+14),0xffff);assert.equal(bytes.readUInt32LE(at+16),size-8);const packet=bytes.subarray(at+20,at+12+size),h=W.readHeader(packet);W.checkStream(h.view,h.end,h.commandCount);if(!owners.has(owner))owners.set(owner,{frames:0,commands:Array.from({length:8},()=>[]),resources:new Map()});const row=owners.get(owner);
  for(let offset=P.STRUCTS.BatchHeader.size;offset<h.end;){const op=h.view.getUint16(offset,true),name=P.OP_NAME[op],length=h.view.getUint32(offset+P.F.CommandHeader.size,true),value=P.decode(P.commandStruct(op),h.view,offset+P.STRUCTS.CommandHeader.size,length-P.STRUCTS.CommandHeader.size);if(name.startsWith("CREATE_")&&value.resource_handle)row.resources.set(value.resource_handle,name);if(row.frames<8)row.commands[row.frames].push({command:name,value});if(name==="PRESENT")row.frames++;offset+=length;
  }at+=12+size;
 }
 const candidates=[...owners.values()].filter(r=>r.frames===8);assert.equal(candidates.length,1);const row=candidates[0],allowed=["PRESENT","WINDOW_STATE","SET_CURSOR_POSITION"];for(const i of [5,6])assert(row.commands[i].every(c=>allowed.includes(c.command)),"object recording/End emits live commands");const apply=row.commands[7],find=(name,check)=>{const result=apply.find(c=>c.command===name&&check(c.value));assert(result,"missing object Apply "+name);return result;};
 const kind=(handle,name)=>row.resources.get(handle)===name;
 find("SET_STREAM_SOURCE",v=>v.stream===1&&v.offset_in_bytes===4&&v.stride===12&&kind(v.buffer_handle,"CREATE_BUFFER"));find("SET_INDICES",v=>kind(v.buffer_handle,"CREATE_BUFFER"));
 for(const [stage,name] of [[0,"CREATE_TEXTURE_2D"],[1,"CREATE_TEXTURE_CUBE"],[260,"CREATE_TEXTURE_VOLUME"]])find("SET_TEXTURE",v=>v.stage===stage&&kind(v.texture_handle,name));
 find("SET_VERTEX_SHADER",v=>kind(v.shader_handle,"CREATE_VERTEX_SHADER"));find("SET_PIXEL_SHADER",v=>kind(v.shader_handle,"CREATE_PIXEL_SHADER"));find("SET_VERTEX_DECLARATION",v=>kind(v.declaration_handle,"CREATE_VERTEX_DECLARATION"));
 find("SET_LIGHT",v=>v.index===37&&v.type===3&&v.diffuse[0]===.125);find("LIGHT_ENABLE",v=>v.index===37&&v.enable===0);find("SET_LIGHT",v=>v.index===3001&&v.type===3&&v.diffuse.slice(0,3).every(n=>n===1)&&v.direction[2]===1);find("LIGHT_ENABLE",v=>v.index===3001&&v.enable===0);
 return {frames:row.frames,recordingCommands:row.commands[5].map(c=>c.command),endCommands:row.commands[6].map(c=>c.command),applyCommands:apply};
}
