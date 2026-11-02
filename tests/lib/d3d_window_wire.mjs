import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require=createRequire(import.meta.url),P=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"),W=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
export function inspect_window_wire(bytes,observations,result){
 const steps=new Map(),apiByOwner=new Map(result.owners.map((owner,i)=>[owner,[8,9,7][i]])),reports=new Map();
 for(const api of [8,9,7])for(const line of result.logs["WINDOW"+api+".TXT"].split(/\r?\n/))if(line.startsWith("STEP ")){const row=line.slice(5).split(" ").map(Number);assert.equal(row.length,16);assert.equal(row[0],api);steps.set(api+"/"+row[1],row);}
 assert.equal(steps.size,22);let index=0,windowReports=0;
 for(let at=0;at<bytes.length;){assert(at+20<=bytes.length);const owner=bytes.readUInt32LE(at),size=bytes.readUInt32LE(at+8),observation=observations[index++];assert.equal(observation.owner,owner);assert(size>=8&&at+12+size<=bytes.length);assert.equal(bytes.readUInt16LE(at+12),0xffe1);const packet=bytes.subarray(at+20,at+12+size),h=W.readHeader(packet);W.checkStream(h.view,h.end,h.commandCount);
  for(let x=P.STRUCTS.BatchHeader.size;x<h.end;){const op=h.view.getUint16(x,true),length=h.view.getUint32(x+P.F.CommandHeader.size,true);if(op===P.OP.WINDOW_STATE){const v=P.decode("WindowState",h.view,x+P.STRUCTS.CommandHeader.size,length-P.STRUCTS.CommandHeader.size);windowReports++;const key=apiByOwner.get(owner)+"/"+observation.phase;if(steps.has(key)){if(!reports.has(key))reports.set(key,[]);reports.get(key).push(v);}}x+=length;}at+=12+size;
 }
 assert.equal(index,observations.length);const accepted=[];
 for(const [key,row]of steps){const [api,phase,hwnd,foreground,valid,visible,iconic,originX,originY,clientWidth,clientHeight,outerWidth,outerHeight,outerX,outerY,noSurface]=row,hidden=api===8&&(!visible||iconic);
  const expected={hwnd,foreground_hwnd:foreground,window_x:hidden?0:noSurface?outerX:originX,window_y:hidden?0:noSurface?outerY:originY,window_width:hidden?0:api===8?clientWidth:outerWidth,window_height:hidden?0:api===8?clientHeight:outerHeight,client_width:hidden?0:clientWidth,client_height:hidden?0:clientHeight};
  const flags=hidden?0:(valid?1:0)|(!noSurface&&visible?2:0)|(iconic?4:0)|(hwnd===foreground?8:0),candidates=reports.get(key)||[],matches=v=>Object.entries(expected).every(([name,value])=>v[name]===value)&&(v.flags&15)===flags&&!!(v.flags&32)===!!noSurface&&!(v.flags&16);
  assert(candidates.some(matches),key+" no window report matching independent Win32 state: "+JSON.stringify({expected,flags,candidates}));accepted.push({api,phase,expected,flags,noSurface:!!noSurface,matchingReports:candidates.filter(matches).length});
 }
 return {windowReports,batches:index,steps:accepted};
}
