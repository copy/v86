#!/usr/bin/env node
import assert from "node:assert/strict";
import {decode_vertex_program} from "../../src/graphics_adapters/geforce_6800/nv40_program.js";
import {translate_vertex_program} from "../../src/graphics_adapters/geforce_6800/nv40_shader.js";
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
        assert.equal(view.getUint32(0x818,true),128,"ZCULL reset preserves the ZPASS counter");
        method(0x17C8,1);method(0x1800,0x01000810);
        assert.equal(view.getUint32(0x818,true),0,"ZPASS reset clears the accumulated count");
        const nearDepth=view.getUint32(0x24000,true);assert(Math.abs((nearDepth>>>8)-Math.round(.25*0xFFFFFF))<=1);
        for(const [at,value]of [[0xA74,0],[0xA70,0],[0x328,1],[0x330,3],[0x334,0x34],[0x338,255],[0x32C,15],[0x33C,7]])method(at,value);
        await depthDraw(.5,[0,1,0,1]);assert.equal(view.getUint32(0x24000,true)&255,0x5B,"stencil fail increments through the write mask");
        assert.deepEqual([...vram.subarray(0x10000,0x10004)],[0,0,255,255],"stencil failure preserves color");
        method(0x330,8);method(0x334,0x2C);method(0x344,3);
        await depthDraw(.5,[0,1,0,1]);assert.equal(view.getUint32(0x24000,true)&255,0x5C,"stencil replace preserves masked high bits");
        assert.equal(view.getUint32(0x24000,true)>>>8,nearDepth>>>8,"stencil-only rendering preserves depth");
        assert.deepEqual([...vram.subarray(0x10000,0x10004)],[0,255,0,255]);method(0x328,0);
        for(const [at,value]of [[0x208,0x128],[0x214,0x25000],[0x22C,16],[0xA74,1],[0xA70,1],[0x328,1],[0x330,1]])method(at,value);
        vram.fill(255,0x25000,0x25080);await depthDraw(.25,[0,1,0,1]);
        assert.deepEqual([...vram.subarray(0x10000,0x10004)],[0,255,0,255],"D16 has no stencil bits: enabled NEVER stencil does not reject the draw");
        assert(Math.abs(view.getUint16(0x25000,true)-Math.round(.25*65535))<=1);
        for(const [at,value]of [[0x208,0x148],[0x214,0x24000],[0x22C,32],[0xA74,0],[0x328,0]])method(at,value);
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
        const normalizedPixels=vram.slice(0x10000,0x10100);
        method(0x1A04,0x16529);method(0x1808,6);
        const pixelCoordinates=floats.map((value,index)=>index%4>=2?value*2:value);
        for(const word of new Uint32Array(pixelCoordinates.buffer))method(0x1818,word);
        method(0x1808,0);await engine.backend.wait();assert.deepEqual(vram.slice(0x10000,0x10100),normalizedPixels,
            "pixel-unit coordinates preserve bilinear texel centers and interpolation");
        method(0x1A04,0x12529);
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
        const fpBranch=(opcode,otherwise,end,condition=7,swizzle=[0,1,2,3])=>[
            opcode<<24|0x40000000,condition<<18|conditionSwizzle(swizzle),0x80000000|otherwise,end];
        for(const condition of [0,1,2,4,5,7])
        {
            const pixel=await conditionalDraw([
                ...ccInstruction([.25,.25,.25,.25]),
                ...ccInstruction([-1,0,1,NaN],{update:true,disabled:true}),
                ...fpBranch(2,28,36,condition,[2,2,2,2]),
                ...ccInstruction([.75,.75,.75,.75]),
                ...ccInstruction([.5,.5,.5,.5]),0x00000001,7<<18,0,0]);
            assert.deepEqual(pixel,Array(4).fill(conditions[condition](1)?191:128),"fragment IF/ELSE condition "+condition);
        }
        for(const count of [0,1,3,255])
        {
            const add=[3<<24|128|15<<9,7<<18|0x1C900,0x1C802,0,...new Uint32Array(Float32Array.of(.125,.125,.125,.125).buffer)];
            const pixel=await conditionalDraw([...ccInstruction([0,0,0,0]),
                ...fpBranch(4,count<<2|count<<10|count<<19,20),...add,1,7<<18,0,0]);
            assert.deepEqual(pixel,Array(4).fill(Math.min(255,Math.round(count*.125*255))),"fragment REP count "+count);
        }
        const broken=await conditionalDraw([...ccInstruction([.25,.25,.25,.25]),
            ...fpBranch(4,3<<2|3<<10|3<<19,24),...fpBranch(0,0,0),
            ...ccInstruction([.75,.75,.75,.75]),1,7<<18,0,0]);
        assert.deepEqual(broken,Array(4).fill(64),"BRK exits the innermost REP before the next write");
        const nestedAdd=[3<<24|128|15<<9,7<<18|0x1C900,0x1C802,0,...new Uint32Array(Float32Array.of(.125,.125,.125,.125).buffer)];
        const nestedWords=(outer,inner)=>[...ccInstruction([0,0,0,0]),
            ...fpBranch(4,outer<<2|outer<<10|outer<<19,28),...fpBranch(4,inner<<2|inner<<10|inner<<19,24),
            ...nestedAdd,0,7<<18,0,0,1,7<<18,0,0];
        assert.deepEqual(await conditionalDraw(nestedWords(2,3)),Array(4).fill(191),"nested REP counters remain independent");
        const unrestrictedShaders=engine.shaders;
        try
        {
            engine.shaders=function(o,options){return unrestrictedShaders.call(this,o,{...options,instruction_limit:8});};
            assert.deepEqual(await conditionalDraw(nestedWords(255,255)),Array(4).fill(96),"fragment execution budget exits nested loops with the last computed color");
        }
        finally {engine.shaders=unrestrictedShaders;}
        console.log("PASS: real WebGPU fragment IF/ELSE conditions, zero/255 repeat counts and loop break");

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
        // Feed decoded VLIW programs through the actual GPU, retaining native
        // fetch, interpolators and fragment exports around vertex predicates.
        for(let attribute=0;attribute<16;attribute++)method(0x1740+attribute*4,attribute?0:0x42);
        for(const [at,value]of [[0x1E94,0x101],[0xA74,0],[0x328,0],[0x8C0,8<<16],[0x8C4,8<<16],[0x1FF4,1]])method(at,value);
        [1<<24|1<<13|15<<9|128|1,7<<18|0x1C801,0,0].forEach((word,i)=>view.setUint32(0x9000+i*4,word,true));
        method(0x1EFC,0);
        [...new Uint32Array(Float32Array.of(-1,0,1,NaN,.25,.25,.25,.25,.75,.75,.75,.75).buffer)].forEach((word,i)=>method(0x1F00+(i%4)*4,word));
        const base=decode_vertex_program(Uint32Array.of(0x401F9C6C,0x0040000D,0x81000000,0x0001EF81)).instructions[0];
        let vertexProgram=null;const nativeShaders=engine.shaders;
        engine.shaders=function(o,options){return {...nativeShaders.call(this,o,options),vertex:translate_vertex_program(vertexProgram,
            {...options,result_map:[[0,0,-1,true],[1,1,-1,true]]})};};
        try
        {
            for(let register=0;register<2;register++)for(let condition=0;condition<8;condition++)
            {
                const position=structuredClone(base),update=structuredClone(base),initial=structuredClone(base),conditional=structuredClone(base);
                update.vector={name:"MOV",type:"temp",index:0,mask:15};update.sources[0]={...update.sources[0],type:"constant",index:0};
                update.predicate={...update.predicate,update:true,vector:true,register};
                initial.vector.index=1;initial.sources[0]={...initial.sources[0],type:"constant",index:1};
                conditional.vector.index=1;conditional.sources[0]={...conditional.sources[0],type:"constant",index:2};
                conditional.predicate={...conditional.predicate,enabled:true,register,condition,swizzle:[3,2,1,0]};
                vertexProgram={stage:"vertex",instructions:[position,update,initial,conditional]};
                method(0x1808,5);
                for(const word of new Uint32Array(Float32Array.of(0,0,0,1,0,16,0,1,16,0,0,1).buffer))method(0x1818,word);
                method(0x1808,0);await engine.backend.wait();
                assert.equal(engine.backend.stats.failures,0,JSON.stringify(graph.faults));
                const rgba=[NaN,1,0,-1].map(value=>conditions[condition](value)?191:64),expected=[rgba[2],rgba[1],rgba[0],rgba[3]],pixel=[...vram.subarray(0x10000,0x10004)];
                expected.forEach((value,i)=>assert(Math.abs(pixel[i]-value)<=1,"vertex CC bank "+register+" condition "+condition+": "+pixel));
            }
            for(const vector of [false,true])
            {
                const position=structuredClone(base),update=structuredClone(base),initial=structuredClone(base),conditional=structuredClone(base);
                update.vector={name:"STR",type:"temp",index:0,mask:15};update.scalar={name:"MOV",type:"temp",index:1,mask:15};
                update.sources[2]={...update.sources[2],type:"constant",index:0};
                update.predicate={...update.predicate,update:true,vector,register:1};
                initial.vector.index=1;initial.sources[0]={...initial.sources[0],type:"constant",index:1};
                conditional.vector.index=1;conditional.sources[0]={...conditional.sources[0],type:"constant",index:2};
                conditional.predicate={...conditional.predicate,enabled:true,register:1,condition:1,swizzle:[0,0,0,0]};
                vertexProgram={stage:"vertex",instructions:[position,update,initial,conditional]};
                method(0x1808,5);for(const word of new Uint32Array(Float32Array.of(0,0,0,1,0,16,0,1,16,0,0,1).buffer))method(0x1818,word);
                method(0x1808,0);await engine.backend.wait();
                assert.deepEqual([...vram.subarray(0x10000,0x10004)],Array(4).fill(vector?64:191),"CDST selects the original vector/scalar VLIW result");
            }
            for(const [name,value,baseIndex,relativeInput,expected]of [
                ["ARL",1.75,1,false,Array(4).fill(191)],["ARR",1.75,1,false,Array(4).fill(128)],
                ["ARL",-.25,3,false,Array(4).fill(191)],["ARR",-.25,3,false,Array(4).fill(128)],
                ["ARL",300,200,false,[128,255,0,255]],["ARL",1.75,1,true,[128,0,255,255]]])
            {
                method(0x1EFC,0);
                [...new Uint32Array(Float32Array.of(value,value,value,value,.25,.25,.25,.25,.75,.75,.75,.75,.5,.5,.5,.5).buffer)]
                    .forEach((word,i)=>method(0x1F00+(i%4)*4,word));
                method(0x1EFC,500);[...new Uint32Array(Float32Array.of(0,1,.5,1).buffer)].forEach((word,i)=>method(0x1F00+i*4,word));
                [...new Uint32Array(Float32Array.of(1,0,.5,1).buffer)].forEach((word,i)=>method(0x1C20+i*4,word));
                const position=structuredClone(base),load=structuredClone(base),color=structuredClone(base);
                load.vector={name,type:"temp",index:1,mask:15};load.sources[0]={...load.sources[0],type:"constant",index:0};
                color.vector.index=1;color.sources[0]={...color.sources[0],type:relativeInput?"input":"constant",index:baseIndex};
                color.address={register:1,component:0,input:relativeInput,constant:!relativeInput};
                vertexProgram={stage:"vertex",instructions:[position,load,color]};
                method(0x1808,5);for(const word of new Uint32Array(Float32Array.of(0,0,0,1,0,16,0,1,16,0,0,1).buffer))method(0x1818,word);
                method(0x1808,0);await engine.backend.wait();assert.equal(engine.backend.stats.failures,0,JSON.stringify(graph.faults));
                assert.deepEqual([...vram.subarray(0x10000,0x10004)],expected,name+" relative "+(relativeInput?"attribute":"constant")+" value "+value);
            }
            method(0x1EFC,0);[...new Uint32Array(Float32Array.of(0,0,0,0,.25,.25,.25,.25,.75,.75,.75,.75,1,1,1,1).buffer)]
                .forEach((word,i)=>method(0x1F00+(i%4)*4,word));
            const instruction=(pc,name="NOP",destination=0,type="temp",constant=1)=>{
                const i=structuredClone(base);i.pc=pc;i.end=false;i.vector={name,index:destination,type,mask:name==="NOP"?0:15};
                i.sources[0]={...i.sources[0],type:"constant",index:constant};return i;
            };
            const flowInstruction=(pc,name,target=0,condition=7)=>{
                const i=instruction(pc);i.scalar={name,mask:0};i.target=target;i.predicate.condition=condition;return i;
            };
            const flowDraw=async(instructions,expected)=>{
                vertexProgram={stage:"vertex",entry:0,instructions};
                method(0x1808,5);for(const word of new Uint32Array(Float32Array.of(0,0,0,1,0,16,0,1,16,0,0,1).buffer))method(0x1818,word);
                method(0x1808,0);await engine.backend.wait();assert.equal(engine.backend.stats.failures,0,JSON.stringify(graph.faults));
                assert.deepEqual([...vram.subarray(0x10000,0x10004)],Array(4).fill(expected));
            };
            const position=structuredClone(base);position.end=false;
            for(const condition of [7,1,2])
            {
                const end=instruction(4);end.end=true;
                await flowDraw([position,instruction(1,"MOV",1,"output"),flowInstruction(2,"BRA",4,condition),instruction(3,"MOV",1,"output",2),end],condition===1?191:64);
            }
            const copied=instruction(3,"MOV",1,"output");copied.sources[0]={...copied.sources[0],type:"temp",index:0};
            const end=instruction(4);end.end=true;
            await flowDraw([position,instruction(1,"MOV",1,"output"),flowInstruction(2,"CAL",6),copied,end,
                instruction(6,"MOV",0,"temp",2),flowInstruction(7,"RET")],191);
            const add=instruction(2,"ADD",0);add.sources[0]={...add.sources[0],type:"temp",index:0};add.sources[2]={...add.sources[0],type:"constant",index:1};
            const compare=instruction(3,"ADD",1);compare.sources[0]={...compare.sources[0],type:"temp",index:0};
            compare.sources[2]={...compare.sources[0],type:"constant",index:3,negate:true};compare.predicate={...compare.predicate,update:true,vector:true};
            const color=instruction(5,"MOV",1,"output");color.sources[0]={...color.sources[0],type:"temp",index:0};
            const loopEnd=instruction(6);loopEnd.end=true;
            await flowDraw([position,instruction(1,"MOV",0),add,compare,flowInstruction(4,"BRA",2,1),color,loopEnd],255);
        }
        finally {engine.shaders=nativeShaders;}
        console.log("PASS: real WebGPU vertex predicates, relative addressing, forward/backward branches and call/return");
        method(0x1E9C,0);
        [0x401F9C6C,0x0040000D,0x81000000,0x0001EF80,
            0x401F9C6C,0x0040100D,0x81800000,0x0001EF85].forEach((word,i)=>method(0xB80+i*4,word));
        method(0x310,1);method(0x314,0x10021002);method(0x318,0x10021002);method(0x320,0x00010001);
        vram.fill(0,0x10000,0x10100);
        const queued=[];const queue=(at,value)=>queued.push([at,value]);
        const queuedDraw=()=>{
            queue(0x1808,5);for(const word of new Uint32Array(Float32Array.of(0,0,0,1,0,16,0,1,16,0,0,1).buffer))queue(0x1818,word);
            queue(0x1808,0);
        };
        queuedDraw();queuedDraw();queue(0x50,0x76543210);
        const start=device.registers.get(0x3270)||0;
        queued.forEach(([at,value],i)=>{const slot=(start+i*4)&0xFFC,offset=0x90000+(slot&0x7FC)*2;device.registers.set(offset,at);device.registers.set(offset+4,value);});
        for(const [at,value]of [[0x3210,(start+queued.length*4)&0xFFC],[0x3240,0],[0x3244,0],[0x3248,0],[0x3228,0],[0x322C,0x100],
            [0x3200,1],[0x3220,1],[0x2504,1],[0x2508,1],[0x3254,0]])device.registers.set(at,value);
        const beforeBatch={...engine.backend.stats};device.fifo.run();
        assert.equal(engine.backend.stats.draws-beforeBatch.draws,2);assert.equal(engine.backend.stats.batches-beforeBatch.batches,1);
        assert.equal(device.registers.get(0x3248),0,"REF remains behind the whole GPU batch");
        await engine.backend.wait();assert.equal(engine.backend.stats.failures,0,JSON.stringify(graph.faults));
        assert.equal(engine.backend.stats.readbacks-beforeBatch.readbacks,1,"both draws share one authoritative color download");
        assert.equal(device.registers.get(0x3248),0x76543210,"REF follows the combined readback");
        assert.deepEqual([...vram.subarray(0x10000,0x10004)],[128,128,128,128],"second draw blends against the first draw's GPU pixels");
        console.log("PASS: real FIFO batches two draws, preserves GPU blend history and orders REF after one download");
        method(0x310,0);method(0x8E4,0x9001);vram.fill(0,0x10000,0x10100);
        [23<<24|1<<13|15<<9|128|1,7<<18|0x1C801,0,0].forEach((word,i)=>view.setUint32(0x9100+i*4,word,true));
        queued.length=0;queuedDraw();
        for(const [at,value]of [[0x8E4,0x9101],[0x1A00,0x10000],[0x1A04,0x12529],[0x1A08,0x303],[0x1A0C,0x80000000],
            [0x1A10,0xAA6C],[0x1A14,0x01010000],[0x1A18,8<<16|8],[0x1840,32]])queue(at,value);
        queuedDraw();queue(0x50,0x11223344);
        const feedbackStart=device.registers.get(0x3270),beforeFeedback={...engine.backend.stats};
        queued.forEach(([at,value],i)=>{const slot=(feedbackStart+i*4)&0xFFC,offset=0x90000+(slot&0x7FC)*2;device.registers.set(offset,at);device.registers.set(offset+4,value);});
        device.registers.set(0x3210,(feedbackStart+queued.length*4)&0xFFC);device.registers.set(0x2508,1);device.fifo.run();
        assert.equal(engine.backend.stats.draws-beforeFeedback.draws,1,"feedback END stays queued until its source is downloaded");
        await engine.backend.wait();assert.equal(engine.backend.stats.failures,0,JSON.stringify(graph.faults));
        assert.equal(engine.backend.stats.draws-beforeFeedback.draws,2);assert.equal(engine.backend.stats.batches-beforeFeedback.batches,2);
        assert.equal(device.registers.get(0x3248),0x11223344,"waiting for a batch also drains the feedback continuation");
        assert.deepEqual([...vram.subarray(0x10000,0x10004)],[64,64,64,64],"render-to-texture sees the preceding GPU pixels through a different texture handle");
        console.log("PASS: render-to-texture alias barrier, preserved END stream and recursive snapshot quiescence");
        const loopShaders=engine.shaders,loopPosition=structuredClone(base),loopValues=[.125,.25,.5,.75];
        const loopVertex={stage:"vertex",instructions:[loopPosition,...loopValues.map((_,index)=>{
            const i=structuredClone(base);i.vector.index=7+index;i.sources[0]={...i.sources[0],type:"constant",index};return i;
        })]};
        method(0x1EFC,0);for(const value of loopValues)for(let component=0;component<4;component++)method(0x1F00+component*4,floatWord(value));
        engine.shaders=function(o,options){return {...loopShaders.call(this,o,options),vertex:translate_vertex_program(loopVertex,
            {...options,result_map:[[0,0,-1,true],...loopValues.map((_,index)=>[7+index,7+index,-1,true]) ]})};};
        const indexedMove=offset=>[1<<24|15<<9|128,7<<18|0x1C801,0,0x40000000|offset<<19];
        const loopHeader=(count,initial,step,end)=>fpBranch(3,count<<2|initial<<10|step<<19,end);
        const indexedDraw=async words=>{
            method(0x8E4,0x9001);words.forEach((word,i)=>view.setUint32(0x9000+i*4,word,true));
            method(0x1808,5);for(const word of new Uint32Array(Float32Array.of(0,0,0,1,0,16,0,1,16,0,0,1).buffer))method(0x1818,word);
            method(0x1808,0);await engine.backend.wait();assert.equal(engine.backend.stats.failures,0,JSON.stringify(graph.faults));
            return [...vram.subarray(0x10000,0x10004)];
        };
        try
        {
            for(const [initial,step,offset]of [[1,1,0],[0,1,1],[0,2,0]])
                assert.deepEqual(await indexedDraw([...ccInstruction([0,0,0,0]),...loopHeader(2,initial,step,16),
                    ...indexedMove(offset),1,7<<18,0,0]),Array(4).fill(128),"LOOP initial/index step and relative TEX offset");
            assert.deepEqual(await indexedDraw([...ccInstruction([0,0,0,0]),...loopHeader(2,0,1,24),
                ...loopHeader(1,3,0,20),...indexedMove(0),...indexedMove(0),1,7<<18,0,0]),Array(4).fill(64),
                "inner LOOP restores the outer address register before subsequent indexed reads");
        }
        finally {engine.shaders=loopShaders;}
        console.log("PASS: real WebGPU fragment LOOP counters, indexed texture attributes and nested index restoration");



    }
    console.log("PASS: NV40 primitive expansion, partial draw snapshot, GPU readback ordering and delayed fence"+(remote?"; real WebGPU pixels matched":""));
}
finally {if(remote)await remote.close();}
