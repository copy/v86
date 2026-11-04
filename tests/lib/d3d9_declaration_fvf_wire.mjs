import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require=createRequire(import.meta.url),P=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"),W=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
export function declaration_fvf_layouts(){return [
    {fvf:2,converted:false,elements:[[0,0,2,0,0,0]]},
    {fvf:2,converted:true,elements:[[0,0,2,0,0,0]]},
    {fvf:4,converted:true,elements:[[0,0,3,0,9,0]]},
    {fvf:4,converted:false,elements:[[0,0,3,0,9,0]]},
    {fvf:0,converted:false,elements:[[0,0,2,0,3,0]]},
    {fvf:0,converted:false,elements:[[0,0,4,0,10,0]]},
    {fvf:0,converted:false,elements:[[0,0,1,0,5,0]]},
    {fvf:0,converted:false,elements:[[0,0,2,0,0,1]]},
    {fvf:0,converted:false,elements:[]},
];}
export function declaration_fvf_scenes(){return [0xffb02010,0xff1040c0,0xff20a040,0xffc0a020,0xff304050].map((color,index)=>({index,color,pixels:Array(64).fill(color)}));}
export function inspect_declaration_fvf_wire(bytes,result){
    assert.equal(result.owners.length,1);assert(result.owners[0]);assert.deepEqual(result.releases,result.owners);
    const owner=result.owners[0],layouts=declaration_fvf_layouts(),specs=declaration_fvf_scenes(),objects=[],frames=[],retired=[],bindings=[];
    const wantedFVFs=[...Array(65).fill(2),...Array(66).fill(4),2,4];
    const wantedBindings=[{index:0,frame:0},...Array.from({length:64},()=>({index:0,frame:1})),{index:3,frame:2},...Array.from({length:65},()=>({index:3,frame:3})),...[4,5,6,7,8].flatMap(index=>[{index,frame:4},{index:null,frame:4}])];
    let device=0,initialDevice=0,created=0,destroyed=0,hello=0,draws=0,resets=0,fvfSets=0,mode=null,factor=0,factorSets=0;
    function dimensions(q){assert.deepEqual([q.width,q.height,q.backbuffer_format,q.windowed,q.multisample_type],[8,8,21,1,0]);}
    function elements(packet,at,layout){const expected=layout.elements;assert(at+expected.length*8<=packet.length);for(let i=0;i<expected.length;i++){const p=at+i*8;assert.deepEqual([packet.readUInt16LE(p),packet.readUInt16LE(p+2),...packet.subarray(p+4,p+8)],expected[i]);}}
    for(let at=0;at<bytes.length;){assert(at+20<=bytes.length);const size=bytes.readUInt32LE(at+8);assert.equal(bytes.readUInt32LE(at),owner);assert(size>=8&&at+12+size<=bytes.length);assert.equal(bytes.readUInt16LE(at+12),0xffe1);assert.equal(bytes.readUInt32LE(at+16),size-8);const packet=bytes.subarray(at+20,at+12+size),h=W.readHeader(packet);W.checkStream(h.view,h.end,h.commandCount);
        for(let x=P.STRUCTS.BatchHeader.size;x<h.end;){const op=h.view.getUint16(x,true),length=h.view.getUint32(x+4,true),decode=name=>P.decode(name,h.view,x+16,length-16);
            if(op===P.OP.HELLO)assert.equal(hello++,0);
            if(op===P.OP.CREATE_DEVICE){const q=decode("CreateDevice");assert.equal(created++,0);dimensions(q);device=initialDevice=q.device_handle;assert(device);}
            if(op===P.OP.CREATE_VERTEX_DECLARATION){const q=decode("CreateVertexDeclaration"),index=objects.length,layout=layouts[index];assert(layout);assert.equal(q.device_handle,device);assert(q.resource_handle&&!objects.some(o=>o.handle===q.resource_handle));assert.equal(q.reserved,0);assert.equal(q.element_count,layout.elements.length);elements(packet,x+16+P.STRUCTS.CreateVertexDeclaration.size,layout);assert.equal(frames.length,[0,1,2,2,4,4,4,4,4][index]);objects.push({index,handle:q.resource_handle,fvf:layout.fvf,converted:layout.converted,retired:false});}
            if(op===P.OP.SET_FVF){const q=decode("SetFVF"),key=wantedFVFs[fvfSets],layout=layouts[key===2?1:2];assert(key);assert.equal(q.device_handle,device);assert.equal(q.fvf,key);assert.equal(q.element_count,1);assert.equal(q.reserved,0);elements(packet,x+16+P.STRUCTS.SetFVF.size,layout);assert.equal(frames.length,fvfSets<65?1:fvfSets===65?2:fvfSets<131?3:4);assert.equal(resets,fvfSets>=131?1:0);mode={type:"fvf",key};fvfSets++;}
            if(op===P.OP.SET_VERTEX_DECLARATION){const q=decode("SetVertexDeclaration"),wanted=wantedBindings[bindings.length];assert(wanted);const o=wanted.index===null?null:objects[wanted.index];assert(!o||!o.retired);assert.equal(q.device_handle,device);assert.equal(q.declaration_handle,o?o.handle:0);assert.equal(frames.length,wanted.frame);assert.equal(resets,0);mode={type:"declaration",index:wanted.index};bindings.push({index:wanted.index,handle:q.declaration_handle,frame:frames.length});}
            if(op===P.OP.SET_RENDER_STATE){const q=decode("SetRenderState");assert.equal(q.device_handle,device);if(q.state===60){assert.equal(q.value,specs[factorSets].color);factor=q.value;factorSets++;}}
            if(op===P.OP.DRAW_PRIMITIVE_UP){const q=decode("DrawPrimitiveUP");assert(draws<5);assert.equal(q.device_handle,device);const transformed=draws>=2,stride=transformed?16:12;assert.deepEqual([q.primitive_type,q.primitive_count,q.stride,q.vertex_count,q.vertex_bytes],[4,2,stride,6,stride*6]);assert.deepEqual(mode,[{type:"declaration",index:0},{type:"fvf",key:2},{type:"declaration",index:3},{type:"fvf",key:4},{type:"fvf",key:4}][draws]);assert.equal(factor,specs[draws].color);assert(q.vertex_data_offset+q.vertex_bytes<=packet.length);const xy=transformed?[[-.5,-.5],[7.5,-.5],[-.5,7.5],[-.5,7.5],[7.5,-.5],[7.5,7.5]]:[[-1.25,1.25],[1.25,1.25],[-1.25,-1.25],[-1.25,-1.25],[1.25,1.25],[1.25,-1.25]];for(let v=0;v<6;v++){const pos=q.vertex_data_offset+v*stride;assert.deepEqual([0,4,8].map(n=>packet.readFloatLE(pos+n)),[...xy[v],.5]);if(transformed)assert.equal(packet.readFloatLE(pos+12),1);}assert.equal(resets,draws===4?1:0);draws++;}
            if(op===P.OP.READBACK_SURFACE){const q=decode("ReadbackSurface"),scene=specs[frames.length];assert(scene);assert.equal(q.device_handle,device);assert.equal(q.texture_handle,0);assert.deepEqual([q.width,q.height,q.format,q.level,q.face,q.first_row,q.row_count,q.destination_pitch,q.destination_bytes],[8,8,21,0,0,0,8,32,256]);assert.equal(q.response_offset,P.C.D9WG_READBACK_REGION_OFFSET);assert.equal(q.request_id,frames.length+1);assert.equal(draws,frames.length+1);assert.equal(resets,frames.length===4?1:0);frames.push({owner,device,texture:0,request:q.request_id,...scene});}
            if(op===P.OP.RESET){const q=decode("ResetDevice");assert.equal(resets,0);assert.equal(frames.length,4);assert.equal(retired.length,7);assert.equal(q.old_device_handle,device);dimensions(q);assert(q.new_device_handle&&q.new_device_handle!==device);device=q.new_device_handle;mode=null;factor=0;resets++;}
            if(op===P.OP.DESTROY_RESOURCE){const q=decode("DestroyResource");if(!q.resource_kind){assert.equal(q.resource_handle,device);assert.equal(frames.length,5);assert.equal(resets,1);assert(objects.every(o=>o.retired));assert.equal(destroyed++,0);device=0;}else{const o=objects[[0,3,4,5,6,7,8,2,1][retired.length]];assert(o&&!o.retired);assert.equal(q.resource_kind,6);assert.equal(q.resource_handle,o.handle);assert.equal(resets,retired.length<7?0:1);assert.equal(frames.length,retired.length===0?2:retired.length<7?4:5);o.retired=true;retired.push(o.handle);}}
            assert(![P.OP.PRESENT,P.OP.PRESENT_SWAP_CHAIN,P.OP.CLEAR,P.OP.CREATE_BUFFER,P.OP.CREATE_TEXTURE_2D,P.OP.CREATE_TEXTURE_CUBE,P.OP.CREATE_TEXTURE_VOLUME,P.OP.CREATE_VERTEX_SHADER,P.OP.CREATE_PIXEL_SHADER].includes(op));x+=length;
        }at+=12+size;
    }
    assert.equal(hello,1);assert.equal(created,1);assert.equal(destroyed,1);assert.equal(objects.length,9);assert(objects.every(o=>o.retired));assert.equal(fvfSets,133);assert.equal(bindings.length,141);assert.equal(draws,5);assert.equal(factorSets,5);assert.equal(resets,1);assert.equal(frames.length,5);
    const lines=specs.map(s=>`DECL FRAME step=${s.index} color=${s.color.toString(16).toUpperCase()} readback=1`);lines.push("DECL STATUS userDeclarations=7 cacheDeclarations=2 collisionPairs=128 queries=269 metadataRounds=269 applies=1 captures=1 resetSuccesses=1 frames=5 readbacks=5 factoryRefs=0","PASS D3D9 user declaration FVF");assert.equal(result.logs["DECL9.TXT"].replace(/\r/g,"").trim(),lines.join("\n"));
    return {owners:result.owners,ownerReleases:result.releases,initialDevice,objects,frames,bindings,retired,fvfSets,draws,factorSets,resets,explicitDeclarationDestroys:9,implicitGuestLeaks:0,readbacks:5,pixels:320};
}
