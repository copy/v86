import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url);
const P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
const W = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
export function frontend_device_scenes() {
    return Array.from({length:4}, (_,mode) => [
        {width:4,height:4,color:0xff336699,role:"texture-target"},
        {width:4,height:4,color:0xff995522,role:"standalone-target"},
        ...[0xffff0000,0xffff0000,0xff00ff00,0xff00ff00,0xff00ff00].map((color,i) => ({width:8,height:8,color,role:["red-shader","recording-keeps-red","apply-green","deleted-handle-green","reset-restores-green"][i]})),
    ].map(scene => ({...scene,mode,format:21,pixels:Array(scene.width*scene.height).fill(scene.color)}))).flat().map((scene,index) => ({...scene,index}));
}
export function inspect_frontend_device_wire(bytes, result) {
    assert.equal(result.owners.length,1); assert.deepEqual(result.releases,result.owners);
    assert.match(result.logs["DEVICE8.TXT"], /PASS Device8 frontend methods=97 devices=4 images=28 checks=\d+ finalRefs=0/);
    const owner=result.owners[0],seen=new Set(),devices=new Map(),resources=new Map(),chains=new Set(),frames=[],scenes=frontend_device_scenes();
    let creates=0,resets=0,ended=0,batches=0,commands=0,presents=0;
    const unique=handle=>{assert(handle&&!seen.has(handle),"unique nonzero handle");seen.add(handle);};
    const kinds=new Map([[P.OP.CREATE_VERTEX_DECLARATION,6],[P.OP.CREATE_VERTEX_SHADER,7],[P.OP.CREATE_PIXEL_SHADER,8],[P.OP.CREATE_TEXTURE_2D,3],[P.OP.CREATE_TEXTURE_CUBE,4],[P.OP.CREATE_TEXTURE_VOLUME,5]]);
    for(let at=0;at<bytes.length;) {
        assert(at+20<=bytes.length,"carrier header");
        const size=bytes.readUInt32LE(at+8);assert(size>=40&&at+12+size<=bytes.length,"carrier length");
        assert.equal(bytes.readUInt32LE(at),owner);assert.equal(bytes.readUInt16LE(at+12),0xffe1);assert.equal(bytes.readUInt32LE(at+16),size-8);
        const packet=bytes.subarray(at+20,at+12+size),h=W.readHeader(packet);
        W.checkStream(h.view,h.end,h.commandCount);assert.equal(h.end,packet.length);++batches;
        for(let x=32;x<h.end;) {
            assert(!ended,"command after session end");
            const op=packet.readUInt16LE(x),n=packet.readUInt32LE(x+4),kind=P.commandStruct(op);
            assert(kind,"known opcode");const q=P.decode(kind,h.view,x+16,n-16);++commands;
            if(op===P.OP.CREATE_DEVICE) {
                unique(q.device_handle);const index=creates++;
                assert(index<4);assert.equal(q.behavior_flags,32+(index%2?16:0));
                assert.deepEqual([q.width,q.height,q.backbuffer_format,q.windowed,q.enable_auto_depth_stencil,q.auto_depth_stencil_format,q.multisample_type,q.multisample_quality],[8,8,21,1,1,80,0,0]);
                devices.set(q.device_handle,index);
            }
            if(op===P.OP.RESET) {
                assert(devices.has(q.old_device_handle));const index=devices.get(q.old_device_handle);
                devices.delete(q.old_device_handle);unique(q.new_device_handle);devices.set(q.new_device_handle,index);++resets;
                assert.deepEqual([q.width,q.height,q.backbuffer_format,q.windowed,q.enable_auto_depth_stencil,q.auto_depth_stencil_format,q.multisample_type,q.multisample_quality],[8,8,21,1,1,80,0,0]);
            }
            if("device_handle" in q) assert(devices.has(q.device_handle),"live device association");
            if(kinds.has(op)||op===P.OP.CREATE_BUFFER) {
                unique(q.resource_handle);resources.set(q.resource_handle,kinds.get(op)??q.resource_kind);
            }
            if(op===P.OP.CREATE_SWAP_CHAIN){unique(q.swap_chain_handle);chains.add(q.swap_chain_handle);}
            if(op===P.OP.DESTROY_SWAP_CHAIN)assert(chains.delete(q.swap_chain_handle),"live chain destruction");
            if(op===P.OP.DESTROY_RESOURCE) {
                if(q.resource_kind===0)assert(devices.delete(q.resource_handle),"live device destruction");
                else {assert.equal(resources.get(q.resource_handle),q.resource_kind,"resource kind at destruction");resources.delete(q.resource_handle);}
            }
            if(op===P.OP.READBACK_SURFACE) {
                const scene=scenes[frames.length];assert(scene,"readback count");
                assert.equal(devices.get(q.device_handle),scene.mode);
                assert.deepEqual([q.width,q.height,q.format,q.first_row,q.row_count,q.destination_pitch,q.destination_bytes,q.level,q.face],[scene.width,scene.height,21,0,scene.height,scene.width*4,scene.pixels.length*4,0,0]);
                assert.equal(q.request_id,frames.length+1);assert.equal(q.response_offset,P.C.D9WG_READBACK_REGION_OFFSET);
                if(q.texture_handle)assert.equal(resources.get(q.texture_handle),3);
                frames.push({...scene,owner,device:q.device_handle,texture:q.texture_handle,request:q.request_id});
            }
            if(op===P.OP.PRESENT)++presents;
            if(op===P.OP.SESSION_END){assert.equal(devices.size,0);assert.equal(resources.size,0);assert.equal(chains.size,0);++ended;}
            x+=n;
        }
        at+=12+size;
    }
    assert.deepEqual([creates,resets,presents,ended,frames.length,devices.size,resources.size,chains.size],[4,4,4,1,28,0,0,0]);
    return {batches,commands,creates,resets,presents,handles:seen.size,frames};
}
