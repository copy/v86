#!/usr/bin/env node
import assert from "node:assert/strict";
import {NVGraph} from "../../src/graphics_adapters/geforce_6800/nv_graph.js";
import {NVFIFO} from "../../src/graphics_adapters/geforce_6800/nv_fifo.js";
import {NVDMA} from "../../src/graphics_adapters/geforce_6800/nv_dma.js";
import {NVTrace} from "../../src/graphics_adapters/geforce_6800/nv_trace.js";
import {d9wg_commands} from "../../src/graphics_adapters/vmware_svga/svga3d_d9wg.js";
import {OP,FIELD_LAYOUT} from "../../src/graphics_adapters/vmware_svga/d9wg_constants.js";
import {expand_primitives,nv40_blend_state,nv40_depth_state,nv40_cull_state} from "../../src/graphics_adapters/geforce_6800/nv40_render.js";
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
depthState.methods.set(0xA6C,4);depthState.methods.set(0x330,3);depthState.methods.set(0x344,8);
assert.equal(new Map(nv40_depth_state(depthState).states).get(23),4,"native 99 uses DirectX LEQUAL alias 4");
assert.equal(new Map(nv40_depth_state(depthState).states).get(56),3);assert.equal(new Map(nv40_depth_state(depthState).states).get(55),8);
const dxBlend=new Map(nv40_blend_state({methods:new Map([[0x310,1],[0x304,1],[0x308,5],
    [0x314,0x10021005],[0x318,0x10011006],[0x320,0x00010001]])}));
assert.equal(dxBlend.get(25),5);assert.equal(dxBlend.get(19),5);assert.equal(dxBlend.get(20),6);assert.equal(dxBlend.get(207),2);assert.equal(dxBlend.get(171),1);
depthState.methods.set(0x348,1);assert.throws(()=>nv40_depth_state(depthState),/two-sided/);
assert.deepEqual(nv40_cull_state({methods:new Map([[0x183C,1],[0x1830,0x405],[0x1834,0x900]])}),{state:3,all:false});
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
    method(0x1A8,0x100);method(0x17C8,1);method(0x17CC,1);
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
        const query=commands.find(command=>command.opcode===OP.END_QUERY);assert(query);
        const queryBytes=new Uint8Array(16),queryView=new DataView(queryBytes.buffer);
        queryView.setUint32(0,query.view.getUint32(query.at+offset("QueryIssue","request_id"),true),true);
        queryView.setUint32(4,64,true);queryView.setUint32(12,1,true);
        listener({type:"write",bytes:queryBytes,offset:12<<20});
        assert.equal(graph.object(0,0x2000).methods.get(0x50008),0,"query counter waits for done too");
        listener({type:"done",seq:submitted.seq});
    }
    let timer;
    try {await Promise.race([drained,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("NV40 GPU completion timeout")),30000);})]);}
    finally {clearTimeout(timer);}
    assert.equal(engine.busy,false);assert.equal(engine.backend.stats.failures,0,JSON.stringify(graph.faults));
    for(let at=0x10000;at<0x10100;at+=4)assert.deepEqual([...vram.subarray(at,at+4)],[0x99,0x66,0x33,0xFF],"actual target pixel "+at.toString(16));
    method(0x1800,0x01000810);
    assert.equal(view.getUint32(0x818,true),64,"actual GPU occlusion count is written in the hardware report");
    method(0x17CC,0);
    assert.equal(device.fifo.drain(),true);assert.equal(view.getUint32(0x800,true),0xABCD1234,"fence follows committed VRAM");
    method(0x120,0);method(0x124,0);method(0x128,3);method(0x130,0);
    device.registers.set(0x90004,0x1234ABCD);device.registers.set(0x3270,0);
    assert.equal(device.fifo.drain(),false);assert.equal(view.getUint32(0x800,true),0xABCD1234,"flip wait holds the next fence");
    graph.written(0x40071C,2);assert.equal(device.fifo.drain(),true);
    assert.equal(view.getUint32(0x800,true),0x1234ABCD,"display ISR releases the queued fence");
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
        for(const [at,value]of [[0x310,1],[0x314,0x10021005],[0x318,0x10011006],[0x320,0x00010001]])method(at,value);
        method(0x1808,5);method(0x1814,2<<24);method(0x1808,0);await engine.backend.wait();
        const blended=[...vram.subarray(0x10000,0x10004)];
        [77,51,153,128].forEach((expected,i)=>assert(Math.abs(blended[i]-expected)<=1,"blend component "+i+": "+blended[i]));
        method(0x310,0);method(0x304,1);method(0x308,5);method(0x30C,192);
        method(0x1808,5);method(0x1814,2<<24);method(0x1808,0);await engine.backend.wait();
        assert.deepEqual([...vram.subarray(0x10000,0x10004)],blended,"failed alpha comparison preserves destination");
        method(0x308,2);method(0x1808,5);method(0x1814,2<<24);method(0x1808,0);await engine.backend.wait();
        assert.deepEqual([...vram.subarray(0x10000,0x10004)],[0,0,255,128],"passing alpha comparison writes the source");
        method(0x304,0);
        // The affine transform and pixel-center clipping must both survive
        // lowering fractional NV viewports into an integer host viewport.
        new Float32Array(vram.buffer,0x9010,4).set([.2,.4,.6,1]);
        new Float32Array(vram.buffer,0x4000,6).set([-1,1,-1,-3,3,1]);vram.fill(0,0x10000,0x10100);
        const floatWord=value=>new Uint32Array(Float32Array.of(value).buffer)[0];
        for(const [at,value]of [[0xA20,4],[0xA24,3],[0xA28,0],[0xA30,2],[0xA34,-2],[0xA38,1]])method(at,floatWord(value));
        method(0x1E94,0x11);method(0x1808,5);method(0x1814,2<<24);method(0x1808,0);await engine.backend.wait();
        for(let y=0;y<8;y++)for(let x=0;x<8;x++)
            assert.deepEqual([...vram.subarray(0x10000+(y*8+x)*4,0x10000+(y*8+x)*4+4)],
                x>=2 && x<6 && y>=1 && y<5?[0x99,0x66,0x33,255]:[0,0,0,0],"offset clip-space viewport "+x+","+y);
        for(const [tx,ty,sx,sy,left,top,right,bottom]of [
            [4.5,4.5,4,-4,0,0,8,8], // native Direct3D half-pixel bias
            [1.75,2.25,3,-3,0,0,5,5], // negative origin, fractional lower edge
            [6.25,5.75,3,-3,3,3,8,8]])
        {
            vram.fill(0,0x10000,0x10100);
            for(const [at,value]of [[0xA20,tx],[0xA24,ty],[0xA30,sx],[0xA34,sy]])method(at,floatWord(value));
            method(0x1808,5);method(0x1814,2<<24);method(0x1808,0);await engine.backend.wait();
            assert.equal(engine.backend.stats.failures,0,JSON.stringify(graph.faults));
            for(let y=0;y<8;y++)for(let x=0;x<8;x++)
                assert.deepEqual([...vram.subarray(0x10000+(y*8+x)*4,0x10000+(y*8+x)*4+4)],
                    x>=left && x<right && y>=top && y<bottom?[0x99,0x66,0x33,255]:[0,0,0,0],"fractional viewport "+tx+","+ty+": "+x+","+y);
        }
        method(0xA20,floatWord(20));const outside=engine.backend.stats.draws;
        method(0x1808,5);method(0x1814,2<<24);method(0x1808,0);await engine.backend.wait();
        assert.equal(engine.backend.stats.draws,outside,"a fully clipped viewport emits no GPU work");
        method(0x1E94,0x101);
        for(const [at,value]of [[0x198,0x100],[0x214,0x24000],[0x22C,32],[0x1740,0x1042],[0xA74,1],[0xA70,1],[0xA6C,2]])method(at,value);
        for(let at=0x24000;at<0x24100;at+=4)view.setUint32(at,0xFFFFFF5A,true);
        const depthDraw=async(z,color)=>{
            new Float32Array(vram.buffer,0x4000,12).set([0,0,z,1,0,16,z,1,16,0,z,1]);
            new Float32Array(vram.buffer,0x9010,4).set(color);
            method(0x1808,5);method(0x1814,2<<24);method(0x1808,0);await engine.backend.wait();
            assert.equal(engine.backend.stats.failures,0,JSON.stringify(graph.faults));
        };
        method(0x17C8,1);method(0x17CC,1);
        await depthDraw(.75,[.2,.4,.6,1]);
        method(0x1800,0x01000810);assert.equal(view.getUint32(0x818,true),64);
        const firstDepth=view.getUint32(0x24000,true);
        assert.equal(firstDepth&255,0x5A,"depth upload/readback preserves stencil bytes");
        assert(Math.abs((firstDepth>>>8)-Math.round(.75*0xFFFFFF))<=1,"actual depth value is downloaded");
        await depthDraw(.9,[1,0,0,1]);
        assert.deepEqual([...vram.subarray(0x10000,0x10004)],[0x99,0x66,0x33,255],"farther draw fails LESS after depth reupload");
        assert.equal(view.getUint32(0x24000,true),firstDepth);
        method(0x1800,0x01000810);assert.equal(view.getUint32(0x818,true),64,"occluded draw adds zero samples");
        await depthDraw(.25,[1,0,0,1]);assert.deepEqual([...vram.subarray(0x10000,0x10004)],[0,0,255,255]);
        method(0x1800,0x01000810);assert.equal(view.getUint32(0x818,true),128,"separate visible draws accumulate");
        method(0x17C8,2);method(0x17CC,0);method(0x1800,0x01000810);
        assert.equal(view.getUint32(0x818,true),0,"reset clears the accumulated count");
        const nearDepth=view.getUint32(0x24000,true);assert(Math.abs((nearDepth>>>8)-Math.round(.25*0xFFFFFF))<=1);
        for(const [at,value]of [[0xA74,0],[0xA70,0],[0x328,1],[0x330,3],[0x334,0x34],[0x338,255],[0x32C,15],[0x33C,7]])method(at,value);
        await depthDraw(.5,[0,1,0,1]);assert.equal(view.getUint32(0x24000,true)&255,0x5B,"stencil fail increments through the write mask");
        assert.deepEqual([...vram.subarray(0x10000,0x10004)],[0,0,255,255],"stencil failure preserves color");
        method(0x330,8);method(0x334,0x2C);method(0x344,3);
        await depthDraw(.5,[0,1,0,1]);assert.equal(view.getUint32(0x24000,true)&255,0x5C,"stencil replace preserves masked high bits");
        assert.equal(view.getUint32(0x24000,true)>>>8,nearDepth>>>8,"stencil-only rendering preserves depth");
        assert.deepEqual([...vram.subarray(0x10000,0x10004)],[0,255,0,255]);method(0x328,0);
        console.log("PASS: real WebGPU depth rejection, depth/stencil VRAM round trips and masked stencil operations");
        method(0x183C,1);method(0x1830,0x405);method(0x1834,0x900);
        await depthDraw(.5,[1,0,0,1]);assert.deepEqual([...vram.subarray(0x10000,0x10004)],[0,255,0,255],"CW front faces cull the CCW window-space triangle");
        method(0x1834,0x901);await depthDraw(.5,[1,0,0,1]);
        assert.deepEqual([...vram.subarray(0x10000,0x10004)],[0,0,255,255],"switching front winding keeps the same geometry");
        method(0x1830,0x404);await depthDraw(.5,[0,0,1,1]);
        assert.deepEqual([...vram.subarray(0x10000,0x10004)],[0,0,255,255],"front-face culling preserves the target");
        method(0x1830,0x408);const beforeCull=engine.backend.stats.draws;await depthDraw(.5,[0,0,1,1]);
        assert.equal(engine.backend.stats.draws,beforeCull,"FRONT_AND_BACK emits no triangle work");
        method(0x1830,0x405);method(0x1834,0x900);method(0x1808,5);
        for(const index of [0,2,1])method(0x1810,index);method(0x1808,0);await engine.backend.wait();
        assert.deepEqual([...vram.subarray(0x10000,0x10004)],[255,0,0,255],"reversing array indices reverses face classification");
        method(0x183C,0);
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
        // Distinct solid levels expose derivative LOD, signed sampler bias and
        // trilinear interpolation without depending on checkerboard placement.
        let mipOffset=0x20000;
        for(const [size,color]of [[8,[0,0,255,255]],[4,[0,255,0,255]],[2,[255,0,0,255]],[1,[255,255,255,255]]])
        {
            for(let i=0;i<size*size;i++)vram.set(color,mipOffset+i*4);
            mipOffset+=size*size*4;
        }
        method(0x1A04,0x40529);method(0x1A18,8<<16|8);method(0x1A0C,0x80018000);
        const mipDraw=async(filter,expected)=>{
            method(0x1A14,filter);method(0x1808,6);
            for(const word of new Uint32Array(Float32Array.of(0,0,0,0,0,16,0,4,16,0,4,0).buffer))method(0x1818,word);
            method(0x1808,0);await engine.backend.wait();
            assert.equal(engine.backend.stats.failures,0,JSON.stringify(graph.faults));
            const pixel=[...vram.subarray(0x10000+(3*8+3)*4,0x10000+(3*8+3)*4+4)];
            expected.forEach((value,i)=>assert(Math.abs(pixel[i]-value)<=1,"mip filter "+filter.toString(16)+" component "+i+": "+pixel));
        };
        await mipDraw(0x01030000,[0,255,0,255]);
        await mipDraw(0x01030100,[255,0,0,255]);
        await mipDraw(0x01031F00,[0,0,255,255]);
        await mipDraw(0x01050080,[128,128,0,255]);
        method(0x1A0C,0x88018000);await mipDraw(0x01031F00,[0,255,0,255]);
        console.log("PASS: real WebGPU mip derivative selection, positive/negative LOD bias, minimum level and trilinear filtering");
        method(0x1A18,4<<16|4);method(0x1A0C,0x80000000);
        for(const [format,bytes,expected]of [
            [0x10629,[0,0xF8,0x1F,0,0xAA,0xAA,0xAA,0xAA],[85,0,170,255]],
            [0x10729,[...Array(8).fill(0x88),0,0xF8,0,0,0,0,0,0],[0,0,255,136]],
            [0x10829,[128,0,0,0,0,0,0,0,0,0xF8,0,0,0,0,0,0],[0,0,255,128]]])
        {
            method(0x1A04,format);vram.set(bytes,0x20000);await mipDraw(0x01010000,expected);
        }
        console.log("PASS: real WebGPU BC1/BC2/BC3 sampled colors, component routing and alpha");
        const operand=swizzle=>2|swizzle.reduce((bits,value,i)=>bits|value<<(9+i*2),0),identity=[0,1,2,3],reverse=[3,2,1,0];
        for(const [opcode,swizzle,expected]of [[12,reverse,[0,255,255,0]],[13,reverse,[255,0,0,255]],
            [15,identity,[255,255,255,255]],[15,reverse,[0,0,0,0]],[14,identity,[0,0,0,0]],[14,reverse,[255,255,255,255]],
            [32,identity,[255,255,255,255]],[33,identity,[0,0,0,0]],[58,[1,1,1,1],[255,255,128,255]],[46,reverse,[153,153,153,153]]])
        {
            const words=[opcode<<24|0x1E81,7<<18|operand(identity),operand(swizzle),operand(identity),
                ...new Uint32Array(Float32Array.of(.2,.4,.6,.8).buffer)];
            words.forEach((word,i)=>view.setUint32(0x9000+i*4,word,true));
            method(0x1808,6);for(const word of new Uint32Array(floats.buffer))method(0x1818,word);
            method(0x1808,0);await engine.backend.wait();
            const pixel=[...vram.subarray(0x10000,0x10004)];
            expected.forEach((value,i)=>assert(Math.abs(pixel[i]-value)<=1,"native ALU opcode "+opcode+" component "+i+": "+pixel));
        }
        console.log("PASS: real WebGPU native SLE/SGT/SEQ/SNE/STR/SFL/DIV/DP2A instruction pixels");
        for(const [at,value]of [[0x18C,0x100],[0x1B4,0x100],[0x1B8,0x100],[0x218,0x30000],[0x288,0x31000],
            [0x28C,0x60000],[0x21C,32],[0x280,32],[0x284,32],[0x220,0x1F],[0x370,0xFFF0]])method(at,value);
        const mrtColors=[[1,0,0,1],[0,1,0,1],[0,0,1,1],[1,1,0,.5]],mrtOffsets=[0x10000,0x30000,0x31000,0x60000];
        const mrtDraw=async()=>{
            let at=0x9000;
            mrtColors.forEach((color,index)=>{
                const register=[0,4,6,8][index],words=[0x01001E80|register<<1|+(index===3),0x1DC802,0,0,
                    ...new Uint32Array(Float32Array.from(color).buffer)];
                for(const word of words){view.setUint32(at,word,true);at+=4;}
            });
            method(0x1808,6);for(const word of new Uint32Array(floats.buffer))method(0x1818,word);
            method(0x1808,0);await engine.backend.wait();
        };
        await mrtDraw();assert.equal(engine.backend.stats.failures,0,JSON.stringify(graph.faults));
        for(const [index,expected]of [[0,[0,0,255,255]],[1,[0,255,0,255]],[2,[255,0,0,255]],[3,[0,255,255,128]]])
            assert.deepEqual([...vram.subarray(mrtOffsets[index],mrtOffsets[index]+4)],expected,"MRT color "+index);
        method(0x370,0x1020);method(0x324,0);mrtColors[1]=[1,0,0,.25];mrtColors[3]=[0,0,0,.25];
        await mrtDraw();
        assert.deepEqual([...vram.subarray(0x30000,0x30004)],[0,255,255,255],"MRT1 independent red write mask");
        assert.deepEqual([...vram.subarray(0x31000,0x31004)],[255,0,0,255],"MRT2 zero mask preserves VRAM");
        assert.deepEqual([...vram.subarray(0x60000,0x60004)],[0,255,255,64],"MRT3 alpha-only write mask");
        const beforeMrtFault=engine.backend.stats.draws;ram.setUint32(0x1004,0x6000F,true);
        method(0x1808,6);for(const word of new Uint32Array(floats.buffer))method(0x1818,word);
        graph.method(0,0,0x2000,0x1808,0);assert.match(graph.faults.pop().reason,/limit/);
        assert.equal(engine.backend.stats.draws,beforeMrtFault,"invalid MRT3 DMA emits no partial GPU work");
        ram.setUint32(0x1004,0xFFFFF,true);method(0x220,1);method(0x324,0x01010101);
        await mrtDraw();assert.equal(engine.backend.stats.failures,0,JSON.stringify(graph.faults));
        console.log("PASS: real WebGPU four MRT outputs, independent color masks, atomic DMA validation and single-target reuse");
        method(0x208,0x14B);method(0x20C,64);vram.fill(0,0x10000,0x10200);
        const fp16Draw=async(color)=>{
            [0x01001E81,0x001DC802,0,0,...new Uint32Array(Float32Array.from(color).buffer)]
                .forEach((word,i)=>view.setUint32(0x9000+i*4,word,true));
            method(0x1808,6);for(const word of new Uint32Array(floats.buffer))method(0x1818,word);
            method(0x1808,0);await engine.backend.wait();
            assert.equal(engine.backend.stats.failures,0,JSON.stringify(graph.faults));
        };
        await fp16Draw([-.5,.25,2,.5]);
        assert.deepEqual([...new Uint16Array(vram.buffer,0x10000,4)],[0xB800,0x3400,0x4000,0x3800],"FP16 target preserves negative and HDR channels in VRAM");
        for(const [at,value]of [[0x310,1],[0x314,0x00010001],[0x318,0x00010001],[0x320,0x80068006]])method(at,value);
        await fp16Draw([.5,.25,-1,.5]);
        assert.deepEqual([...new Uint16Array(vram.buffer,0x10000,4)],[0,0x3800,0x3C00,0x3C00],"FP16 additive blending uses the previously downloaded target");
        method(0x310,0);
        for(const [at,value]of [[0x1A04,0x13A29],[0x1A18,2<<16|1],[0x1A10,0xAAE4],[0x1A14,0x02020000],[0x1840,16]])method(at,value);
        new Uint16Array(vram.buffer,0x20000,8).set([0x4000,0xBC00,0x3800,0x3400,0x4400,0x3C00,0x3C00,0x3A00]);
        [23<<24|4<<13|15<<9|128|1,7<<18|0x1C801,0x1C800,0x1C800].forEach((word,i)=>view.setUint32(0x9000+i*4,word,true));
        method(0x1808,6);
        for(const word of new Uint32Array(Float32Array.of(0,0,.5,.5,0,16,.5,.5,16,0,.5,.5).buffer))method(0x1818,word);
        method(0x1808,0);await engine.backend.wait();assert.equal(engine.backend.stats.failures,0,JSON.stringify(graph.faults));
        assert.deepEqual([...new Uint16Array(vram.buffer,0x10000,4)],[0x4200,0,0x3A00,0x3800],"bilinear FP16 texture sampling retains HDR and signed values");
        console.log("PASS: real WebGPU FP16 render targets, additive blending, exact VRAM half bits and HDR bilinear textures");
        method(0x208,0x148);method(0x20C,32);method(0x1FC4,0x06144321);method(0x1FF4,(1<<14)|(1<<4));
        [1<<24|3<<13|15<<9|128|1,7<<18|0x1C801,0x1C800,0x1C800]
            .forEach((word,i)=>view.setUint32(0x9000+i*4,word,true));
        for(const [mode,coordinate,constant,linear,factor]of [[0x2601,.25,1,1,.25],[0x2601,.75,1.5,-1,0],
            [0x2601,.25,1.5,3,1],[0x804,-.25,1,2,.5],
            [0x800,.5,1.5,-1/16,Math.SQRT1_2],[0x802,-.5,1.5,-1/16,Math.SQRT1_2],
            [0x801,.5,1.5,.25,Math.SQRT1_2],[0x803,-.5,1.5,.25,Math.SQRT1_2],
            [0x800,1,1.5,1,1]])
        {
            method(0x8CC,mode);method(0x8D0,floatWord(constant));method(0x8D4,floatWord(linear));
            method(0x1808,6);
            for(const word of new Uint32Array(Float32Array.of(0,0,coordinate,0,0,16,coordinate,0,16,0,coordinate,0).buffer))method(0x1818,word);
            method(0x1808,0);await engine.backend.wait();assert.equal(engine.backend.stats.failures,0,JSON.stringify(graph.faults));
            const pixel=[...vram.subarray(0x10000,0x10004)],expected=[0,Math.round(factor*255),Math.round(Math.max(0,coordinate)*255),0];
            expected.forEach((value,i)=>assert(Math.abs(pixel[i]-value)<=1,"FOGC component "+i+": "+pixel));
        }
        method(0x8CC,0x2601);method(0x8D0,floatWord(1));method(0x8D4,floatWord(1));method(0x1808,6);
        for(const word of new Uint32Array(Float32Array.of(0,0,-1,0,0,16,-1,0,16,0,3,0).buffer))method(0x1818,word);
        method(0x1808,0);await engine.backend.wait();
        for(let x=0;x<8;x++)assert(Math.abs(vram[0x10000+x*4+1]-Math.round(Math.max(0,(x+.5)/4-1)*255))<=1,
            "fog clamp happens after interpolation at pixel "+x);
        console.log("PASS: real WebGPU NV linear/exponential/absolute fog factors, post-interpolation clamp and FOGC zero components");
        const conditionSwizzle=swizzle=>swizzle.reduce((bits,value,i)=>bits|value<<(21+i*2),0);
        const ccInstruction=(value,{condition=7,swizzle=[0,1,2,3],update=false,disabled=false,mask=15,saturate=false,end=false}={})=>[
            (1<<24|128|mask<<9|+update<<8|+disabled<<30|+saturate<<31|+end)>>>0,
            condition<<18|conditionSwizzle(swizzle)|0x1C802,0,0,...new Uint32Array(Float32Array.from(value).buffer)];
        const conditionalDraw=async(words)=>{
            words.forEach((word,i)=>view.setUint32(0x9000+i*4,word,true));
            method(0x1808,6);for(const word of new Uint32Array(floats.buffer))method(0x1818,word);
            method(0x1808,0);await engine.backend.wait();assert.equal(engine.backend.stats.failures,0,JSON.stringify(graph.faults));
            return [...vram.subarray(0x10000,0x10004)];
        };
        const conditions=[()=>false,x=>x<0,x=>x===0,x=>x<=0,x=>x>0,x=>x!==0,x=>x>=0,()=>true];
        for(let condition=0;condition<8;condition++)
        {
            const pixel=await conditionalDraw([
                ...ccInstruction([.25,.25,.25,.25]),...ccInstruction([-1,0,1,NaN],{update:true,disabled:true}),
                ...ccInstruction([.75,.75,.75,.75],{condition,swizzle:[3,2,1,0],end:true})]);
            const rgba=[NaN,1,0,-1].map(value=>conditions[condition](value)?191:64),expected=[rgba[2],rgba[1],rgba[0],rgba[3]];
            expected.forEach((value,i)=>assert(Math.abs(pixel[i]-value)<=1,"CC condition "+condition+" component "+i+": "+pixel));
        }
        const masked=await conditionalDraw([
            ...ccInstruction([.5,.5,.5,.5]),...ccInstruction([-1,0,1,1],{update:true,disabled:true}),
            ...ccInstruction([1,0,0,0],{condition:2,swizzle:[1,1,1,1],update:true,disabled:true,mask:1}),
            ...ccInstruction([1,1,1,1],{condition:4,end:true})]);
        assert.deepEqual(masked,[255,128,255,255],"conditional CC update respects swizzle and destination component mask");
        const saturated=await conditionalDraw([
            ...ccInstruction([.25,.25,.25,.25]),...ccInstruction([-1,.5,2,NaN],{update:true,disabled:true,saturate:true}),
            ...ccInstruction([.75,.75,.75,.75],{condition:5,end:true})]);
        assert.deepEqual(saturated.slice(0,3),[191,191,64],"CC classification follows result saturation");
        for(const [component,killed]of [[1,false],[0,true]])
        {
            for(let at=0x10000;at<0x10100;at+=4)vram.set([13,17,19,23],at);
            const pixel=await conditionalDraw([...ccInstruction([1,1,1,1]),
                ...ccInstruction([-1,0,1,0],{update:true,disabled:true}),
                18<<24|1,1<<18|conditionSwizzle(Array(4).fill(component)),0,0]);
            assert.deepEqual(pixel,killed?[13,17,19,23]:[255,255,255,255],"KIL tests swizzled condition codes");
        }
        console.log("PASS: real WebGPU all fragment conditions, NaN/unordered, masked CC updates, saturation and conditional discard");
        method(0x1FF4,1<<14);method(0xA74,1);method(0xA70,0);method(0xA6C,8);
        for(const [at,value]of [[0x1A04,0x12529],[0x1A18,1<<16|1],[0x1A10,0xAA6C],[0x1A14,0x01010000],[0x1840,4]])method(at,value);
        [23<<24|4<<13|15<<9|128|1,7<<18|0x1C801,0x1C800,0x1C800].forEach((word,i)=>view.setUint32(0x9000+i*4,word,true));
        for(let frame=0;frame<70;frame++)
        {
            const at=0x20000+frame*256,color=[frame,frame+16,255-frame,255];vram.set(color,at);method(0x1A00,at);
            method(0x1808,6);for(const word of new Uint32Array(floats.buffer))method(0x1818,word);
            method(0x1808,0);await engine.backend.wait();
            assert.equal(engine.backend.stats.failures,0,JSON.stringify(graph.faults));
            assert.deepEqual([...vram.subarray(0x10000,0x10004)],color,"live color/depth targets survive texture cache turnover "+frame);
        }
        assert.equal(engine.backend.resources.size,64,"texture resources remain bounded while hot attachments survive");
        console.log("PASS: real WebGPU color/depth attachments survive 70 rotating textures in the bounded resource cache");
        const cubeColors=[[0,0,255,255],[0,255,0,255],[255,0,0,255],[0,255,255,255],[255,0,255,255],[255,255,0,255]],
            directions=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
        for(const [at,value]of [[0x1A00,0x50000],[0x1A04,0x1052D],[0x1A18,1<<16|1],[0x1760,0x1032]])method(at,value);
        cubeColors.forEach((color,face)=>vram.set(color,0x50000+face*128));
        for(const [face,direction]of directions.entries())
        {
            method(0x1808,6);
            for(const word of new Uint32Array(Float32Array.of(0,0,...direction,0,16,...direction,16,0,...direction).buffer))method(0x1818,word);
            method(0x1808,0);await engine.backend.wait();assert.equal(engine.backend.stats.failures,0,JSON.stringify(graph.faults));
            assert.deepEqual([...vram.subarray(0x10000,0x10004)],cubeColors[face],"native cube direction selects face "+face);
        }
        method(0x1A04,0x2052D);method(0x1A18,2<<16|2);method(0x1A0C,0x80008000);
        for(let face=0;face<6;face++)
        {
            for(let pixel=0;pixel<4;pixel++)vram.set(cubeColors[pixel],0x50000+face*128+pixel*4);
            vram.set(cubeColors[5-face],0x50000+face*128+16);
        }
        const cubeDraw=async(direction)=>{
            method(0x1808,6);
            for(const word of new Uint32Array(Float32Array.of(0,0,...direction,0,16,...direction,16,0,...direction).buffer))method(0x1818,word);
            method(0x1808,0);await engine.backend.wait();assert.equal(engine.backend.stats.failures,0,JSON.stringify(graph.faults));
            return [...vram.subarray(0x10000,0x10004)];
        };
        for(const [corner,direction]of [[1,.5,.5],[1,.5,-.5],[1,-.5,.5],[1,-.5,-.5]].entries())
            assert.deepEqual(await cubeDraw(direction),cubeColors[corner],"cube +X face coordinate orientation "+corner);
        [47<<24|4<<13|15<<9|128|1,7<<18|0x1C801,0x1C800,0x1C800].forEach((word,i)=>view.setUint32(0x9000+i*4,word,true));
        method(0x1A14,0x01030000);
        for(const [face,direction]of directions.entries())
            assert.deepEqual(await cubeDraw(direction),cubeColors[5-face],"explicit cube mip retains guest face alignment "+face);
        console.log("PASS: real WebGPU NV cubemap face directions, coordinate orientation and per-face mip chains");

        for(const [at,value]of [[0x1A00,0x60000],[0x1A04,0x20539],[0x1840,2<<20],[0x1A08,0x30303],[0x1A14,0x01010000]])method(at,value);
        for(let pixel=0;pixel<8;pixel++)vram.set(cubeColors[pixel<4?0:2],0x60000+pixel*4);
        vram.set(cubeColors[3],0x60020);
        [23<<24|4<<13|15<<9|128|1,7<<18|0x1C801,0x1C800,0x1C800].forEach((word,i)=>view.setUint32(0x9000+i*4,word,true));
        assert.deepEqual(await cubeDraw([.5,.5,.25]),cubeColors[0],"3D sampler selects first volume slice");
        assert.deepEqual(await cubeDraw([.5,.5,.75]),cubeColors[2],"3D sampler selects second volume slice");
        method(0x1A14,0x02020000);const volumeMiddle=await cubeDraw([.5,.5,.5]);
        [128,0,128,255].forEach((expected,i)=>assert(Math.abs(volumeMiddle[i]-expected)<=1,"trilinear spatial volume filter "+volumeMiddle));
        [47<<24|4<<13|15<<9|128|1,7<<18|0x1C801,0x1C800,0x1C800].forEach((word,i)=>view.setUint32(0x9000+i*4,word,true));
        method(0x1A14,0x01030000);assert.deepEqual(await cubeDraw([.5,.5,.5]),cubeColors[3],"volume mip chain shrinks all three dimensions");
        console.log("PASS: real WebGPU NV 3D textures, Morton slice order, spatial filtering and volume mip levels");
        const beforeReuse=engine.backend.stats.uploads;
        assert.deepEqual(await cubeDraw([.5,.5,.5]),cubeColors[3]);
        assert.equal(engine.backend.stats.uploads,beforeReuse,"unchanged texture and read-back attachments stay on the GPU");
        vram.set(cubeColors[2],0x60020);assert.deepEqual(await cubeDraw([.5,.5,.5]),cubeColors[2]);
        assert.equal(engine.backend.stats.uploads,beforeReuse+1,"a guest texture write uploads only the changed mip");
        const untouched=0x10000+7*4;vram.set([9,8,7,6],untouched);method(0x8C0,4<<16);
        await cubeDraw([.5,.5,.5]);assert.deepEqual([...vram.subarray(untouched,untouched+4)],[9,8,7,6],"guest target writes survive outside the new scissor");
        assert.equal(engine.backend.stats.uploads,beforeReuse+2,"a guest color attachment change forces one upload");
        console.log("PASS: real WebGPU exact-byte upload reuse, changed-mip uploads and CPU-authoritative attachment edits");
        console.log("PASS: real WebGPU nearest/bilinear texture sampling and TBUF5 to TEX0 routing");
    }
    console.log("PASS: NV40 primitive expansion, partial draw snapshot, GPU readback ordering and delayed fence"+(remote?"; real WebGPU pixels matched":""));
}
finally {if(remote)await remote.close();}
