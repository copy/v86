// Operation specification from the SDK probe, independent of captured packets.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),P=require('../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js'),W=require('../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js');
const dropped=[10,30,40,153,164,172,173],tss=[13,14,25,15,16,17,18,19,20,21],sampler=[1,2,3,4,5,6,7,8,9,10],values=[3,3,3,0x11223344,2,2,1,0x3f000000,2,4];
function bias(v){const b=Buffer.alloc(4);b.writeFloatLE(Math.fround(Math.fround(-.000005)*Math.min(v,16)));return b.readUInt32LE();}
export function backend_states_plan(mode){
 const raw=mode<2,shadow=new Map([['r47',0],['r195',0],['r7',0],['r137',1],['r22',3],['r60',0xffffffff]]),events=[];
 for(let stage=0;stage<8;stage++){shadow.set('t'+stage+':1',stage?1:4);for(let n=0;n<10;n++)shadow.set((raw?'t':'s')+stage+':'+(raw?tss[n]:sampler[n]),n<3||n===4||n===5||n===9?1:0);}
 function rs(s,v){const key='r'+(raw?s:s===47?195:s),skip=dropped.includes(s);if(shadow.get(key)===v&&!(s===47&&!raw))return;if(raw)shadow.set(key,v);if(skip)return;const state=s===47?195:s,value=s===47?bias(v):v;if(!raw){if(shadow.get('r'+state)===value)return;shadow.set('r'+state,value);}events.push({kind:'render',stage:0,state,value});}
 function ts(stage,state,value){const at=tss.indexOf(state),kind=at<0?'stage':'sampler',mapped=at<0?state:sampler[at],key=raw?'t'+stage+':'+state:(at<0?'t':'s')+stage+':'+mapped;if(shadow.get(key)===value)return;shadow.set(key,value);events.push({kind,stage,state:mapped,value});}
 for(let n=0;n<7;n++){rs(dropped[n],0x5aa50000+n);rs(dropped[n],0x5aa50000+n);}for(const v of[0,1,8,16,17,0xffffffff]){rs(47,v);rs(47,v);}rs(137,0);rs(22,1);rs(60,0x11223344);
 for(let stage=0;stage<8;stage++)for(let n=0;n<10;n++){ts(stage,tss[n],values[n]);ts(stage,tss[n],values[n]);}ts(0,1,3);
 // Recording leaves live state alone. Apply uses the captured masks in order.
 rs(47,2);ts(7,25,1);ts(0,1,4);rs(7,1);rs(10,0xaabb1234);rs(47,9);ts(0,1,2);ts(7,25,2);
 rs(47,6);ts(7,25,3); // Capture snapshots the current masked states.
 rs(47,2);ts(7,25,1);rs(7,1);rs(47,6);ts(0,1,2);ts(7,25,3);
 return events;
}
export function inspect_backend_states_wire(bytes,result){
 assert.equal(result.owners.length,1);assert(result.owners[0]);assert.deepEqual(result.releases,result.owners);const owner=result.owners[0],devices=[],resets=[],states=[],used=new Set();let hello=0,session,ends=0,window;
 const unique=h=>{assert(h&&!used.has(h));used.add(h);},device=h=>{const d=devices.find(d=>d.handle===h);assert(d&&!d.retired);return d;};
 const ignored=new Set(['SET_MATERIAL','WINDOW_STATE','SET_VERTEX_SHADER_CONSTANT_F','SET_PIXEL_SHADER_CONSTANT_F','SET_VERTEX_SHADER_CONSTANT_I','SET_PIXEL_SHADER_CONSTANT_I','SET_VERTEX_SHADER_CONSTANT_B','SET_PIXEL_SHADER_CONSTANT_B','GUEST_LOG'].map(n=>P.OP[n]));
 for(let at=0;at<bytes.length;){assert(at+20<=bytes.length);const size=bytes.readUInt32LE(at+8);assert.equal(bytes.readUInt32LE(at),owner);assert(size>=8&&at+12+size<=bytes.length);assert.equal(bytes.readUInt16LE(at+12),0xffe1);assert.equal(bytes.readUInt32LE(at+16),size-8);const packet=bytes.subarray(at+20,at+12+size),h=W.readHeader(packet);W.checkStream(h.view,h.end,h.commandCount);
  for(let x=P.STRUCTS.BatchHeader.size;x<h.end;){const op=h.view.getUint16(x,true),length=h.view.getUint32(x+4,true),decode=name=>P.decode(name,h.view,x+16,length-16);assert.equal(ends,0);let handled=true;
   if(op===P.OP.HELLO){const q=decode('Hello');assert.deepEqual([q.guest_pointer_bits,q.feature_bits],[32,[0,0,3][hello]]);assert.equal(devices.length,[0,1,2][hello]);if(session)assert.deepEqual([q.session_id_low,q.session_id_high],session);else{session=[q.session_id_low,q.session_id_high];assert(session.some(Boolean));}hello++;}
   else if(op===P.OP.CREATE_DEVICE){const q=decode('CreateDevice'),mode=devices.length;assert(mode<5&&devices.every(d=>d.retired));assert.deepEqual([q.width,q.height,q.backbuffer_format,q.windowed,q.behavior_flags,q.enable_auto_depth_stencil,q.auto_depth_stencil_format,q.multisample_type,q.multisample_quality,q.x,q.y],[8,8,21,1,32,0,0,0,0,0,0]);if(window)assert.equal(q.hwnd,window);else{window=q.hwnd;assert(window);}unique(q.device_handle);devices.push({mode,handle:q.device_handle,initialHandle:q.device_handle,stateCount:0,minPatches:0,reset:false,retired:false});}
   else if(op===P.OP.SET_RENDER_STATE||op===P.OP.SET_TEXTURE_STAGE_STATE||op===P.OP.SET_SAMPLER_STATE){const kind=op===P.OP.SET_RENDER_STATE?'render':op===P.OP.SET_TEXTURE_STAGE_STATE?'stage':'sampler',q=decode(kind==='render'?'SetRenderState':kind==='stage'?'SetTextureStageState':'SetSamplerState'),d=device(q.device_handle);if(kind==='render'){assert.equal(q.reserved,0);if(q.state===155){assert(d.mode!==2&&q.value===0);assert.equal(d.minPatches,d.reset?1:0);d.minPatches++;x+=length;continue;}}
    assert(!d.reset);const event={kind,stage:kind==='render'?0:kind==='stage'?q.stage:q.sampler,state:q.state,value:q.value},wanted=backend_states_plan(d.mode)[d.stateCount++];assert(wanted);assert.deepEqual(event,wanted);states.push({mode:d.mode,device:d.handle,...event});}
   else if(op===P.OP.RESET){const q=decode('ResetDevice'),d=device(q.old_device_handle);assert(!d.reset&&d.stateCount===backend_states_plan(d.mode).length);assert.deepEqual([q.width,q.height,q.backbuffer_format,q.windowed,q.behavior_flags,q.enable_auto_depth_stencil,q.auto_depth_stencil_format,q.multisample_type,q.multisample_quality,q.hwnd,q.x,q.y],[8,8,21,1,32,0,0,0,0,window,0,0]);unique(q.new_device_handle);resets.push({mode:d.mode,old:d.handle,current:q.new_device_handle});d.handle=q.new_device_handle;d.reset=true;}
   else if(op===P.OP.DESTROY_RESOURCE){const q=decode('DestroyResource');assert.equal(q.resource_kind,0);const d=device(q.resource_handle);assert(d.reset&&d.minPatches===(d.mode===2?0:2));d.retired=true;}
   else if(op===P.OP.SESSION_END){const q=decode('SessionEnd');assert(devices.every(d=>d.retired));assert.deepEqual([q.session_id_low,q.session_id_high],session);ends++;}
   else handled=false;assert(handled||ignored.has(op),'Unexpected opcode '+op);x+=length;
  }at+=12+size;
 }
 assert.equal(hello,3);assert.equal(devices.length,5);assert.equal(resets.length,5);assert.equal(ends,1);assert.equal(used.size,10);
 const lines=devices.map(d=>`STATECORE CHECK mode=${d.mode} sevenDrops=1 zbias=6 samplers=80 recording=1 apply=1 capture=1 rawMetadata=${d.mode<2?1:0} reset=1 finalRefs=0`);lines.push('PASS private states8 modes=5 devices=5 resets=5 sevenDrops=35 samplers=400 finalRefs=0');assert.equal(result.logs['STCORE.TXT'].replace(/\r/g,'').trim(),lines.join('\n'));
 return{owners:result.owners,ownerReleases:result.releases,devices,resets,states,hello,session,sessionEnds:ends,uniqueHandles:used.size,draws:0,readbacks:0,pixels:0,implicitGuestLeaks:0};
}
