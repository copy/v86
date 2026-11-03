import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {inspect_private_surface_wire} from './d3d_private_surface_wire.mjs';
const require=createRequire(import.meta.url),P=require('../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js'),W=require('../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js');
export function inspect_implicit_identity_wire(bytes,result){
 assert.equal(result.owners.length,4);assert.equal(new Set(result.owners).size,4);const states=new Map(result.owners.slice(0,2).map((owner,i)=>[owner,{owner,api:[8,9][i],device:0,created:0,resets:0,destroyed:0,targets:0,depthTargets:0}])),retained=[];
 const forbidden=new Set(Object.entries(P.OP).filter(([name])=>/^DRAW_|^CREATE_TEXTURE_|^UPDATE_(BUFFER|TEXTURE)$|^(READBACK_SURFACE|CREATE_BUFFER|PRESENT|PRESENT_SWAP_CHAIN|CLEAR|CREATE_SWAP_CHAIN)$/.test(name)).map(([,op])=>op));
 for(let at=0;at<bytes.length;){assert(at+20<=bytes.length);const owner=bytes.readUInt32LE(at),size=bytes.readUInt32LE(at+8);assert(result.owners.includes(owner)&&size>=8&&at+12+size<=bytes.length);const s=states.get(owner);if(!s){retained.push(bytes.subarray(at,at+12+size));at+=12+size;continue;}assert.equal(bytes.readUInt16LE(at+12),0xffe1);assert.equal(bytes.readUInt32LE(at+16),size-8);const h=W.readHeader(bytes.subarray(at+20,at+12+size));W.checkStream(h.view,h.end,h.commandCount);
  for(let x=P.STRUCTS.BatchHeader.size;x<h.end;){const op=h.view.getUint16(x,true),length=h.view.getUint32(x+P.F.CommandHeader.size,true),decode=name=>P.decode(name,h.view,x+P.STRUCTS.CommandHeader.size,length-P.STRUCTS.CommandHeader.size);assert(!forbidden.has(op),'implicit COM calls must not create extra resources or render');
   if(op===P.OP.CREATE_DEVICE){const q=decode('CreateDevice');assert.equal(s.created++,0);assert.equal(q.width,64);assert.equal(q.height,64);assert.equal(q.backbuffer_format,22);assert.equal(q.enable_auto_depth_stencil,1);assert.equal(q.auto_depth_stencil_format,75);assert.equal(q.multisample_type,4);assert.equal(q.multisample_quality,0);s.device=q.device_handle;}
   if(op===P.OP.RESET){const q=decode('ResetDevice');assert.equal(s.resets++,0);assert.equal(q.old_device_handle,s.device);assert.notEqual(q.new_device_handle,s.device);assert.equal(q.width,80);assert.equal(q.height,72);assert.equal(q.backbuffer_format,22);assert.equal(q.enable_auto_depth_stencil,1);assert.equal(q.auto_depth_stencil_format,75);assert.equal(q.multisample_type,4);assert.equal(q.multisample_quality,0);s.device=q.new_device_handle;}
   if(op===P.OP.SET_RENDER_TARGET){const q=decode('SetRenderTarget');assert.equal(q.device_handle,s.device);assert.equal(q.target_index,0);assert.equal(q.color_texture_handle,0);assert.equal(q.color_level,0);assert.equal(q.color_face,0);s.targets++;}
   if(op===P.OP.SET_DEPTH_STENCIL_SURFACE_LEVEL){const q=decode('SetDepthStencilSurfaceLevel');assert.equal(q.device_handle,s.device);assert.equal(q.depth_texture_handle,P.C.D9WG_AUTO_DEPTH_STENCIL_HANDLE);assert.equal(q.depth_level,0);assert.equal(q.width,s.resets?80:64);assert.equal(q.height,s.resets?72:64);s.depthTargets++;}
   if(op===P.OP.DESTROY_RESOURCE){const q=decode('DestroyResource');assert.equal(q.resource_kind,0);assert.equal(q.resource_handle,s.device);assert.equal(s.destroyed++,0);}
   x+=length;
  }at+=12+size;
 }
 const perAPI=[...states.values()];for(const s of perAPI){assert.equal(s.created,1);assert.equal(s.resets,1);assert.equal(s.destroyed,1);assert(s.targets>=1&&s.depthTargets>=1);assert.deepEqual(result.logs['IMP'+s.api+'.TXT'].trim().replace(/\r/g,'').split('\n'),[0,1].map(kind=>'IMPLICIT '+s.api+' kind='+kind+' count=0 pin=1 live=1 revived=1 stereo='+(kind?0:1)+' container=1').concat('RESET IMPLICIT '+s.api+' width=80 height=72 samples=4 owned=1','FINAL IMPLICIT '+s.api+' device=2 back=0 depth=0','PASS implicit API='+s.api));}
 return{perAPI,regression:inspect_private_surface_wire(Buffer.concat(retained),{owners:result.owners.slice(2),logs:result.logs}).perAPI};
}
