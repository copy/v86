import assert from "node:assert/strict";
import fs from "node:fs";
import {createRequire} from "node:module";
const require=createRequire(import.meta.url),P=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"),W=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js"),reference=JSON.parse(fs.readFileSync(new URL("../glbridge/fixtures/d3d_gamma_reference.json",import.meta.url)));
export function inspect_gamma_wire(bytes,result){
 assert.equal(result.owners.length,2);const summaries=new Map(result.owners.map((owner,i)=>[owner,{owner,api:[8,9][i],created:0,resets:0,destroyed:0,ramps:0,clears:0,presents:0,mode:0,windowed:1,device:0}])),frames=[];
 for(let at=0;at<bytes.length;){assert(at+20<=bytes.length);const owner=bytes.readUInt32LE(at),size=bytes.readUInt32LE(at+8),s=summaries.get(owner);assert(s);assert(at+12+size<=bytes.length);const carrier=bytes.subarray(at+12,at+12+size);assert.equal(carrier.readUInt16LE(0),0xffe1);assert.equal(carrier.readUInt32LE(4),size-8);const packet=carrier.subarray(8),h=W.readHeader(packet);W.checkStream(h.view,h.end,h.commandCount);
  for(let x=P.STRUCTS.BatchHeader.size;x<h.end;){const op=h.view.getUint16(x,true),length=h.view.getUint32(x+P.F.CommandHeader.size,true),decode=name=>P.decode(name,h.view,x+P.STRUCTS.CommandHeader.size,length-P.STRUCTS.CommandHeader.size);
   if(op===P.OP.CREATE_DEVICE){const q=decode('CreateDevice');assert.equal(++s.created,1);s.device=q.device_handle;assert.equal(q.width,64);assert.equal(q.height,64);assert.equal(q.windowed,1);assert.equal(q.multisample_type,0);}
   if(op===P.OP.RESET){const q=decode('ResetDevice');assert.equal(q.old_device_handle,s.device);assert(q.new_device_handle!==s.device);s.device=q.new_device_handle;assert.equal(q.width,64);assert.equal(q.height,64);assert.equal(q.windowed,s.resets?1:0);assert.equal(s.presents,s.resets?5:3);s.windowed=q.windowed;s.mode=0;s.resets++;}
   if(op===P.OP.SET_GAMMA_RAMP){const q=decode('SetGammaRamp'),n=s.ramps++,mode=reference.rampSequence[n];assert(mode!==undefined);assert.equal(q.device_handle,s.device);assert.equal(q.swap_chain,0);assert.equal(q.flags,reference.flagSequence[n]);assert.equal(q.reserved,0);assert.equal(q.ramp.length,768);for(let c=0;c<3;c++)for(let i=0;i<256;i++)assert.equal(q.ramp[c*256+i],reference.rampModes[mode][c][i],'exact WORD RGB gamma');s.mode=mode;}
   if(op===P.OP.CLEAR){const q=decode('Clear');assert.equal(q.device_handle,s.device);assert.equal(q.rect_count,0);assert.equal(q.clear_flags,1);assert.equal(q.color,0xff80a0c0);s.clears++;}
   if(op===P.OP.PRESENT){const q=decode('Present'),e=reference.frames[s.presents];assert(e);assert.equal(q.device_handle,s.device);assert.equal(q.width,64);assert.equal(q.height,64);assert.equal(s.mode,e.mode);assert.equal(s.windowed,e.windowed);assert.equal(s.clears,s.presents+1);assert.equal(s.ramps,[0,1,3,4,5,6,7,7][s.presents]);const frame={owner,api:s.api,device:s.device,...e};assert(result.logs['GAMMA'+s.api+'.TXT'].includes(`GAMMA ${s.api} ${e.scene} ${e.mode} ${e.windowed} FF80A0C0`));frames.push(frame);s.presents++;}
   if(op===P.OP.DESTROY_RESOURCE){const q=decode('DestroyResource');assert.equal(q.resource_kind,0);assert.equal(q.resource_handle,s.device);s.destroyed++;}
   assert(![P.OP.CREATE_TEXTURE_2D,P.OP.CREATE_TEXTURE_CUBE,P.OP.CREATE_TEXTURE_VOLUME,P.OP.DRAW_PRIMITIVE_UP,P.OP.READBACK_SURFACE].includes(op),'gamma probe must contain only known clears and presentation, without app texture/draw/readback shortcuts');
   x+=length;
  }at+=12+size;
 }
 for(const s of summaries.values()){assert.equal(s.created,1);assert.equal(s.resets,2);assert.equal(s.destroyed,1);assert.equal(s.ramps,7);assert.equal(s.clears,8);assert.equal(s.presents,8);assert(result.logs['GAMMA'+s.api+'.TXT'].includes('CHECK identity, exact RGB, live recording, flags and gamma Reset replay'));assert(result.logs['GAMMA'+s.api+'.TXT'].includes('PASS gamma API='+s.api));}
 assert.equal(frames.length,16);return{perAPI:[...summaries.values()],frames};
}
