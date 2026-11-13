#!/usr/bin/env node
import assert from "node:assert/strict";
import {NVGraph} from "../../src/graphics_adapters/geforce_6800/nv_graph.js";
import {NVFIFO} from "../../src/graphics_adapters/geforce_6800/nv_fifo.js";
import {NVDMA} from "../../src/graphics_adapters/geforce_6800/nv_dma.js";
import {NVTrace} from "../../src/graphics_adapters/geforce_6800/nv_trace.js";
import {d9wg_commands} from "../../src/graphics_adapters/vmware_svga/svga3d_d9wg.js";
import {OP,FIELD_LAYOUT} from "../../src/graphics_adapters/vmware_svga/d9wg_constants.js";
import {expand_primitives,nv40_blend_state,nv40_depth_state} from "../../src/graphics_adapters/geforce_6800/nv40_render.js";
const offset=(name,field)=>FIELD_LAYOUT[name].fields.find(item=>item[0]===field)[1];
const input={bytes:Uint8Array.of(0,1,2,3,4),count:5,stride:1};
assert.deepEqual([...expand_primitives(input,6).bytes],[0,1,2,2,1,3,2,3,4]);
assert.deepEqual([...expand_primitives(input,8).bytes],[0,1,2,0,2,3]);
assert.deepEqual([...expand_primitives(input,3).bytes],[0,1,1,2,2,3,3,4,4,0]);
const blendState={methods:new Map([[0x310,1],[0x314,0x00010302],[0x318,0x303],[0x320,0x800A8006]])};
const blendRegisters=new Map(nv40_blend_state(blendState));
assert.equal(blendRegisters.get(19),5);assert.equal(blendRegisters.get(20),6);
assert.equal(blendRegisters.get(207),2);assert.equal(blendRegisters.get(209),2,"separate alpha equation");
blendState.methods.set(0x314,0x18003);assert.throws(()=>nv40_blend_state(blendState),/constant-alpha/);
const depthState={methods:new Map([[0xA74,1],[0xA70,1],[0xA6C,0x203],[0x328,1],[0x344,0x8507]])};
const depthRegisters=new Map(nv40_depth_state(depthState).states);
assert.equal(depthRegisters.get(23),4);assert.equal(depthRegisters.get(55),7);
depthState.methods.set(0x348,1);assert.throws(()=>nv40_depth_state(depthState),/two-sided/);
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
    // Inline indices and DMA batches share one index stream, retained mid-BEGIN.
    const draw=engine.backend.draw;let captured;
    engine.backend.draw=(...args)=>{captured=args;};
    method(0x1808,5);method(0x180C,1<<16);const indexedSaved=graph.get_state();graph.set_state(indexedSaved);
    method(0x1810,2);method(0x1808,0);
    assert.equal(captured[2],null);assert.deepEqual(captured[3],[0,1,2]);
    method(0x1808,5);method(0x1814,2<<24|5);method(0x1808,0);assert.deepEqual(captured[3],[5,6,7]);
    method(0x19C,0x100);method(0x181C,0x3000);method(0x1820,0x10);
    new Uint16Array(vram.buffer,0x3000,4).set([99,2,0,1]);
    method(0x1808,5);method(0x1824,2<<24|1);method(0x1808,0);assert.deepEqual(captured[3],[2,0,1]);
    method(0x1808,5);method(0x1810,0);
    assert.throws(()=>engine.method(graph.objects.values().next().value,0x1818,0),/mixed/);
    method(0x1808,0);assert.deepEqual(captured[3],[0],"rejected mixed data leaves the index stream intact");
    engine.backend.draw=draw;
    if(remote)
    {
        method(0x1680,0x4000);new Float32Array(vram.buffer,0x4000,6).set([0,0,0,16,16,0]);
        method(0x1808,5);method(0x1824,2<<24|1);method(0x1808,0);await engine.backend.wait();
        assert.equal(engine.backend.stats.failures,0,JSON.stringify(graph.faults));
        assert.deepEqual([...vram.subarray(0x10000,0x10004)],[0x99,0x66,0x33,0xFF],"DMA indexed triangle renders actual pixels");
        // Alpha comparison and independent RGB/alpha blending on the same VRAM.
        new Float32Array(vram.buffer,0x9010,4).set([1,0,0,.5]);
        for(const [at,value]of [[0x310,1],[0x314,0x10302],[0x318,0x303],[0x320,0x80068006]])method(at,value);
        method(0x1808,5);method(0x1814,2<<24);method(0x1808,0);await engine.backend.wait();
        const blended=[...vram.subarray(0x10000,0x10004)];
        [77,51,153,128].forEach((expected,i)=>assert(Math.abs(blended[i]-expected)<=1,"blend component "+i+": "+blended[i]));
        method(0x310,0);method(0x304,1);method(0x308,0x204);method(0x30C,192);
        method(0x1808,5);method(0x1814,2<<24);method(0x1808,0);await engine.backend.wait();
        assert.deepEqual([...vram.subarray(0x10000,0x10004)],blended,"failed alpha comparison preserves destination");
        method(0x308,0x201);method(0x1808,5);method(0x1814,2<<24);method(0x1808,0);await engine.backend.wait();
        assert.deepEqual([...vram.subarray(0x10000,0x10004)],[0,0,255,128],"passing alpha comparison writes the source");
        method(0x304,0);
        // Clip before a smaller, offset viewport. Transforming XY into the
        // full target first would incorrectly paint outside this rectangle.
        new Float32Array(vram.buffer,0x9010,4).set([.2,.4,.6,1]);
        new Float32Array(vram.buffer,0x4000,6).set([-1,1,-1,-3,3,1]);vram.fill(0,0x10000,0x10100);
        const floatWord=value=>new Uint32Array(Float32Array.of(value).buffer)[0];
        for(const [at,value]of [[0xA20,4],[0xA24,3],[0xA28,0],[0xA30,2],[0xA34,-2],[0xA38,1]])method(at,floatWord(value));
        method(0x1E94,0x11);method(0x1808,5);method(0x1814,2<<24);method(0x1808,0);await engine.backend.wait();
        for(let y=0;y<8;y++)for(let x=0;x<8;x++)
            assert.deepEqual([...vram.subarray(0x10000+(y*8+x)*4,0x10000+(y*8+x)*4+4)],
                x>=2 && x<6 && y>=1 && y<5?[0x99,0x66,0x33,255]:[0,0,0,0],"offset clip-space viewport "+x+","+y);
        method(0x1E94,0x101);
        for(const [at,value]of [[0x198,0x100],[0x214,0x24000],[0x22C,32],[0x1740,0x1042],[0xA74,1],[0xA70,1],[0xA6C,0x201]])method(at,value);
        for(let at=0x24000;at<0x24100;at+=4)view.setUint32(at,0xFFFFFF5A,true);
        const depthDraw=async(z,color)=>{
            new Float32Array(vram.buffer,0x4000,12).set([0,0,z,1,0,16,z,1,16,0,z,1]);
            new Float32Array(vram.buffer,0x9010,4).set(color);
            method(0x1808,5);method(0x1814,2<<24);method(0x1808,0);await engine.backend.wait();
            assert.equal(engine.backend.stats.failures,0,JSON.stringify(graph.faults));
        };
        await depthDraw(.75,[.2,.4,.6,1]);
        const firstDepth=view.getUint32(0x24000,true);
        assert.equal(firstDepth&255,0x5A,"depth upload/readback preserves stencil bytes");
        assert(Math.abs((firstDepth>>>8)-Math.round(.75*0xFFFFFF))<=1,"actual depth value is downloaded");
        await depthDraw(.9,[1,0,0,1]);
        assert.deepEqual([...vram.subarray(0x10000,0x10004)],[0x99,0x66,0x33,255],"farther draw fails LESS after depth reupload");
        assert.equal(view.getUint32(0x24000,true),firstDepth);
        await depthDraw(.25,[1,0,0,1]);assert.deepEqual([...vram.subarray(0x10000,0x10004)],[0,0,255,255]);
        const nearDepth=view.getUint32(0x24000,true);assert(Math.abs((nearDepth>>>8)-Math.round(.25*0xFFFFFF))<=1);
        for(const [at,value]of [[0xA74,0],[0xA70,0],[0x328,1],[0x330,0x202],[0x334,0x34],[0x338,255],[0x32C,15],[0x33C,0x8507]])method(at,value);
        await depthDraw(.5,[0,1,0,1]);assert.equal(view.getUint32(0x24000,true)&255,0x5B,"stencil fail increments through the write mask");
        assert.deepEqual([...vram.subarray(0x10000,0x10004)],[0,0,255,255],"stencil failure preserves color");
        method(0x330,0x207);method(0x334,0x2C);method(0x344,0x1E01);
        await depthDraw(.5,[0,1,0,1]);assert.equal(view.getUint32(0x24000,true)&255,0x5C,"stencil replace preserves masked high bits");
        assert.equal(view.getUint32(0x24000,true)>>>8,nearDepth>>>8,"stencil-only rendering preserves depth");
        assert.deepEqual([...vram.subarray(0x10000,0x10004)],[0,255,0,255]);method(0x328,0);
        console.log("PASS: real WebGPU depth rejection, depth/stencil VRAM round trips and masked stencil operations");
        // A real sampled checkerboard also tests Curie's output crossbar:
        // the VP writes raw TBUF5, mapped to the FP's TEX0 input.
        method(0x1E9C,0);
        [0x401F9C6C,0x0040080D,0x81000000,0x0001EF94,
         0x401F9C6C,0x0040000D,0x81000000,0x0001EF81].forEach((word,i)=>method(0xB80+(i%4)*4,word));
        [23<<24|4<<13|15<<9|128|1,7<<18|0x1C801,0x1C800,0x1C800].forEach((word,i)=>view.setUint32(0x9000+i*4,word,true));
        for(const [at,value]of [[0x1FC8,5],[0x1FF4,1<<14],[0x1740,0x1022],[0x1760,0x1022],
            [0x1A00,0x20000],[0x1A04,0x12529],[0x1A08,0x30303],[0x1A0C,0x80000000],
            [0x1A10,0xAA6C],[0x1A14,0x01010000],[0x1A18,2<<16|2],[0x1840,8]])method(at,value);
        vram.set([0,0,255,255,0,255,0,255,255,0,0,255,255,255,255,255],0x20000);
        method(0x1808,6);
        const floats=Float32Array.of(0,0,0,0,0,16,0,2,16,0,2,0);
        for(const word of new Uint32Array(floats.buffer))method(0x1818,word);
        method(0x1808,0);await engine.backend.wait();
        assert.equal(engine.backend.stats.failures,0,JSON.stringify(graph.faults));
        for(let y=0;y<8;y++)for(let x=0;x<8;x++)
        {
            const expected=y<4?x<4?[0,0,255,255]:[0,255,0,255]:x<4?[255,0,0,255]:[255,255,255,255];
            assert.deepEqual([...vram.subarray(0x10000+(y*8+x)*4,0x10000+(y*8+x)*4+4)],expected,"sampled checker "+x+","+y);
        }
        method(0x1A14,0x02020000);method(0x1808,6);
        for(const word of new Uint32Array(floats.buffer))method(0x1818,word);
        method(0x1808,0);await engine.backend.wait();
        const center=[...vram.subarray(0x10000+(3*8+3)*4,0x10000+(3*8+3)*4+4)];
        [96,96,135,255].forEach((expected,i)=>assert(Math.abs(center[i]-expected)<=1,"bilinear center component "+i+": "+center[i]));
        console.log("PASS: real WebGPU nearest/bilinear texture sampling and TBUF5 to TEX0 routing");
    }
    console.log("PASS: NV40 primitive expansion, partial draw snapshot, GPU readback ordering and delayed fence"+(remote?"; real WebGPU pixels matched":""));
}
finally {if(remote)await remote.close();}
