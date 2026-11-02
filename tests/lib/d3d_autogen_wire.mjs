import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require=createRequire(import.meta.url),P=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"),W=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
export function inspect_autogen_wire(bytes,mask){
    const resources=new Map(),uniqueAuto=new Set(),counts={creates:0,autoCreates:0,configurations:0,explicitGenerations:0,resetFiltersPreserved:0},owners=new Set();let expectConfig;
    for(let at=0;at<bytes.length;){
        assert(at+20<=bytes.length);const owner=bytes.readUInt32LE(at),size=bytes.readUInt32LE(at+8);owners.add(owner);assert(size>=8&&at+12+size<=bytes.length);assert.equal(bytes.readUInt16LE(at+12),0xffe1);
        const packet=bytes.subarray(at+20,at+12+size),h=W.readHeader(packet);W.checkStream(h.view,h.end,h.commandCount);assert.equal(h.view.getUint16(P.F.BatchHeader.version_minor,true),8);
        for(let x=32;x<h.end;){const op=h.view.getUint16(x,true),length=h.view.getUint32(x+P.F.CommandHeader.size,true),name=P.OP_NAME[op],v=P.decode(P.commandStruct(op),h.view,x+16,length-16);
            if(expectConfig){assert.equal(name,"GENERATE_MIPS","create/Reset must immediately restore generation filter");assert.equal(v.resource_handle,expectConfig.resource_handle);assert.equal(v.defer_generation,1);assert.equal(v.filter_type,[114,115,116].includes(expectConfig.format)&&!(mask&1)?1:2,"independent format default filter");expectConfig=null;}
            if(["CREATE_TEXTURE_2D","CREATE_TEXTURE_CUBE","CREATE_TEXTURE_VOLUME"].includes(name)){
                counts.creates++;if(v.usage&0x400){assert(name!=="CREATE_TEXTURE_VOLUME");assert.equal(v.level_count,1);counts.autoCreates++;assert(!uniqueAuto.has(v.resource_handle),"Reset retains managed resources rather than recreating them");uniqueAuto.add(v.resource_handle);expectConfig=v;}else resources.set(v.resource_handle,{auto:false});
            }
            if(name==="GENERATE_MIPS"){
                assert.equal(length-16,16);assert(v.filter_type>=1&&v.filter_type<=3);assert(v.defer_generation<=1);
                const prior=resources.get(v.resource_handle);assert(prior?.auto!==false,"normal textures must not emit generation commands");resources.set(v.resource_handle,{auto:true,filter:v.filter_type});
                if(v.defer_generation)counts.configurations++;else{assert.equal(v.filter_type,1,"SDK probe explicitly generates after selecting POINT");counts.explicitGenerations++;}
            }
            if(name==="RESET"){const live=[...resources.values()].filter(r=>r.auto);assert.equal(live.length,1);assert.equal(live[0].filter,3);counts.resetFiltersPreserved++;}
            if(name==="DESTROY_RESOURCE")resources.delete(v.resource_handle);
            x+=length;
        }
        at+=12+size;
    }
    assert(!expectConfig);assert.equal(owners.size,1);assert.equal(uniqueAuto.size,194);assert.equal(counts.autoCreates,194);assert.equal(counts.resetFiltersPreserved,2);assert.equal(counts.explicitGenerations,96);assert.equal(counts.configurations,mask&1?484:472);
    return {...counts,uniqueAutoTextures:uniqueAuto.size,owners:[...owners]};
}
