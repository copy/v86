#!/usr/bin/env node
import assert from "node:assert/strict";
import {NVGraph} from "../../src/graphics_adapters/geforce_6800/nv_graph.js";
import {NVFIFO} from "../../src/graphics_adapters/geforce_6800/nv_fifo.js";
import {NVDMA} from "../../src/graphics_adapters/geforce_6800/nv_dma.js";
import {NVTrace} from "../../src/graphics_adapters/geforce_6800/nv_trace.js";
import {d9wg_commands} from "../../src/graphics_adapters/vmware_svga/svga3d_d9wg.js";
import {OP,FIELD_LAYOUT} from "../../src/graphics_adapters/vmware_svga/d9wg_constants.js";
import {expand_primitives} from "../../src/graphics_adapters/geforce_6800/nv40_render.js";
const offset=(name,field)=>FIELD_LAYOUT[name].fields.find(item=>item[0]===field)[1];
const input={bytes:Uint8Array.of(0,1,2,3,4),count:5,stride:1};
assert.deepEqual([...expand_primitives(input,6).bytes],[0,1,2,2,1,3,2,3,4]);
assert.deepEqual([...expand_primitives(input,8).bytes],[0,1,2,0,2,3]);
assert.deepEqual([...expand_primitives(input,3).bytes],[0,1,1,2,2,3,3,4,4,0]);
let remote=null,listener=null,submitted=null;
const fake={listen:fn=>{listener=fn;},post:message=>{if(message.type==="submit")submitted=message;}};
if(process.env.NV_GPU_RENDERER==="chrome")
{
    const {create_remote_renderer}=await import("../x64/gpu_remote_renderer.mjs");
    remote=await create_remote_renderer({on_log:line=>console.log("NV40 GPU:",line)});
}
const vram=new Uint8Array(2<<20),ram=new DataView(vram.buffer,1<<20),view=new DataView(vram.buffer);
const device={renderer:remote?remote.renderer:fake,vram_size:vram.length,vram:()=>vram,vga:{lfb_region:1},
    machine:{mmio_ram_mark_dirty(){},is_bus_master:()=>true,wake(){}},time:()=>0n,update_irq(){},trace:new NVTrace(),
    registers:new Map([[0x200,0x1100],[0x400720,1],[0x3250,1],[0x3280,1]])};
device.dma=new NVDMA(device);device.graph=new NVGraph(device);device.fifo=new NVFIFO(device);device.fifo.active=0;
const graph=device.graph,engine=graph.engine3d;
ram.setUint32(0x1000,0x303D,true);ram.setUint32(0x1004,0xFFFFF,true);ram.setUint32(0x1008,3,true);
ram.setUint32(0x2000,0x4097,true);device.fifo.channel(0).bindings[0]=0x2000;
const method=(at,value)=>{device.registers.set(0x400720,1);graph.method(0,0,0x2000,at,value);assert.equal(device.registers.get(0x400720),1,JSON.stringify(graph.faults));};
try
{
    for(const [at,value]of [[0x194,0x100],[0x184,0x100],[0x1A4,0x100],[0x200,8<<16],[0x204,8<<16],
        [0x208,0x148],[0x20C,32],[0x210,0x10000],[0x220,1],[0x8C0,8<<16],[0x8C4,8<<16],
        [0x1740,0x822],[0x1E94,0x101],[0x8E4,0x9001],[0x1E9C,0]])method(at,value);
    [0x401F9C6C,0x0040000D,0x81000000,0x0001EF81].forEach((word,i)=>method(0xB80+i*4,word));
    [0x01001E81,0x001DC802,0,0,0x3E4CCCCD,0x3ECCCCCD,0x3F19999A,0x3F800000].forEach((word,i)=>view.setUint32(0x9000+i*4,word,true));
    method(0x1E94,0x11);method(0x1808,6);
    for(const word of [0,0,0,0x41800000,0x41800000,0])method(0x1818,word);
    graph.method(0,0,0x2000,0x1808,0);
    assert.equal(device.registers.get(0x400720),0,"unsupported viewport is an honest PGRAPH fault");
    assert.match(graph.faults.pop().reason,/viewport/);assert.equal(engine.busy,false);
    assert.equal(engine.backend.stats.draws,0,"a rejected draw emits no GPU work");
    method(0x1E94,0x101); // END closed the failed primitive, so a new BEGIN is valid.
    method(0x1808,6);method(0x1818,0);method(0x1818,0);
    const saved=graph.get_state();graph.set_state(saved); // a partial inline primitive survives a snapshot
    for(const word of [0,0x41800000,0x41800000,0])method(0x1818,word);
    method(0x1D6C,0x800);method(0x1808,0);
    assert.equal(engine.busy,true,"a submitted draw holds FIFO until readback completes");
    device.registers.set(0x90000,0x1D70);device.registers.set(0x90004,0xABCD1234);device.registers.set(0x3210,4);device.registers.set(0x3270,0);
    assert.equal(device.fifo.drain(),false);assert.equal(view.getUint32(0x800,true),0,"fence cannot precede GPU results");
    let savedReady=false;const drained=engine.backend.wait().then(()=>{savedReady=true;});
    if(!remote)
    {
        assert(submitted);const header=new DataView(submitted.bytes.buffer);assert.equal(header.getUint32(offset("BatchHeader","session_id_low"),true),0x3034564E);
        const commands=d9wg_commands(submitted.bytes),readback=commands.find(command=>command.opcode===OP.READBACK_SURFACE);
        assert(readback);const id=readback.view.getUint32(readback.at+offset("ReadbackSurface","request_id"),true);
        const bytes=new Uint8Array(16+8*8*4),response=new DataView(bytes.buffer);response.setUint32(0,id,true);response.setUint32(4,256,true);response.setUint32(12,1,true);
        for(let at=16;at<bytes.length;at+=4)bytes.set([0x99,0x66,0x33,0xFF],at);
        listener({type:"write",bytes,offset:(12<<20)+16384});
        assert.equal(view.getUint32(0x10000,true),0,"write response waits for the batch's done marker");assert.equal(savedReady,false);
        listener({type:"done",seq:submitted.seq});
    }
    let timer;
    try {await Promise.race([drained,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("NV40 GPU completion timeout")),30000);})]);}
    finally {clearTimeout(timer);}
    assert.equal(engine.busy,false);assert.equal(engine.backend.stats.failures,0,JSON.stringify(graph.faults));
    for(let at=0x10000;at<0x10100;at+=4)assert.deepEqual([...vram.subarray(at,at+4)],[0x99,0x66,0x33,0xFF],"actual target pixel "+at.toString(16));
    assert.equal(device.fifo.drain(),true);assert.equal(view.getUint32(0x800,true),0xABCD1234,"fence follows committed VRAM");
    console.log("PASS: NV40 primitive expansion, partial draw snapshot, GPU readback ordering and delayed fence"+(remote?"; real WebGPU pixels matched":""));
}
finally {if(remote)await remote.close();}
