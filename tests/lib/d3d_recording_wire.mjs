import assert from "node:assert/strict";
import { createRequire as create_require } from "node:module";
export function inspect_d3d8_recording_wire(bytes) {
    const require=create_require(import.meta.url),P=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"),W=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
    const groups=[{recordingCommands:[],applyCommands:[],values:[]},{recordingCommands:[],applyCommands:[],values:[]}];let frames=0,recordingOwner=null;
    for(let carrier=0;carrier<bytes.length;){
        assert(carrier+20<=bytes.length);const size=bytes.readUInt32LE(carrier+8),owner=bytes.readUInt32LE(carrier);
        assert(size>=8&&carrier+12+size<=bytes.length);assert.equal(bytes.readUInt16LE(carrier+12),0xffe1);assert.equal(bytes.readUInt16LE(carrier+14),0xffff);assert.equal(bytes.readUInt32LE(carrier+16),size-8);
        const packet=bytes.subarray(carrier+20,carrier+12+size),header=W.readHeader(packet);W.checkStream(header.view,header.end,header.commandCount);
        for(let at=P.STRUCTS.BatchHeader.size;at<header.end;){
            const opcode=header.view.getUint16(at,true),length=header.view.getUint32(at+P.F.CommandHeader.size,true);
            if(owner===recordingOwner&&frames<6&&frames%3)groups[Math.floor(frames/3)][frames%3===1?"recordingCommands":"applyCommands"].push(P.OP_NAME[opcode]);
            if(owner===recordingOwner&&frames===5&&[P.OP.SET_VERTEX_SHADER_CONSTANT_F,P.OP.SET_PIXEL_SHADER_CONSTANT_F,P.OP.SET_CLIP_PLANE].includes(opcode)) {
                const payload=at+P.STRUCTS.CommandHeader.size,value=P.decode(P.commandStruct(opcode),header.view,payload,length-P.STRUCTS.CommandHeader.size);
                if(opcode===P.OP.SET_CLIP_PLANE)groups[1].values.push({command:P.OP_NAME[opcode],index:value.index,values:value.plane});
                else {
                    assert.equal(value.vector_count,1);assert(value.data_offset>=payload+P.STRUCTS.SetShaderConstantF.size&&value.data_offset+16<=at+length);
                    groups[1].values.push({command:P.OP_NAME[opcode],index:value.start_register,values:Array.from({length:4},(_,i)=>header.view.getFloat32(value.data_offset+i*4,true))});
                }
            }
            if(opcode===P.OP.PRESENT){if(recordingOwner===null)recordingOwner=owner;if(owner===recordingOwner)frames++;}
            at+=length;
        }
        carrier+=12+size;
    }
    assert.equal(frames,6);for(const group of groups)assert(group.recordingCommands.every(name=>name==="PRESENT"||name==="WINDOW_STATE"),"recording leaked host commands: "+group.recordingCommands);
    const expected=[["SET_RENDER_STATE","SET_TEXTURE_STAGE_STATE","SET_VIEWPORT","SET_MATERIAL","SET_TRANSFORM","SET_STREAM_SOURCE","SET_INDICES","SET_TEXTURE","SET_FVF"],["SET_VERTEX_SHADER_CONSTANT_F","SET_PIXEL_SHADER_CONSTANT_F","SET_CLIP_PLANE"]];
    for(let i=0;i<2;++i)for(const name of expected[i])assert(groups[i].applyCommands.includes(name),"missing Apply command: "+name);
    assert.deepEqual(groups[1].values,[
        {command:"SET_VERTEX_SHADER_CONSTANT_F",index:94,values:[.375,.625,.875,1]},
        {command:"SET_VERTEX_SHADER_CONSTANT_F",index:95,values:[.125,.25,.5,.75]},
        {command:"SET_PIXEL_SHADER_CONSTANT_F",index:6,values:[.375,.625,.875,1]},
        {command:"SET_PIXEL_SHADER_CONSTANT_F",index:7,values:[.125,.25,.5,.75]},
        {command:"SET_CLIP_PLANE",index:5,values:[1,-2,.5,3]}
    ]);
    return {frames,groups};
}
