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
blendState.methods.set(0x314,0x18003);blendState.methods.set(0x31C,0x40204060);
assert.equal(new Map(nv40_blend_state(blendState)).get(193),0x40404040,"constant alpha is replicated without changing alpha factors");
blendState.methods.set(0x318,0x8001);assert.throws(()=>nv40_blend_state(blendState),/mixed constant-color\/constant-alpha/);
blendState.methods.set(0x31C,0x40404040);assert.equal(new Map(nv40_blend_state(blendState)).get(193),0x40404040);
const depthState={methods:new Map([[0xA74,1],[0xA70,1],[0xA6C,0x203],[0x328,1],[0x344,0x8507]])};
const depthRegisters=new Map(nv40_depth_state(depthState).states);
assert.equal(depthRegisters.get(23),4);assert.equal(depthRegisters.get(55),7);
depthState.methods.set(0xA6C,4);depthState.methods.set(0x330,3);depthState.methods.set(0x344,8);
assert.equal(new Map(nv40_depth_state(depthState).states).get(23),4,"native 99 uses DirectX LEQUAL alias 4");
assert.equal(new Map(nv40_depth_state(depthState).states).get(56),3);assert.equal(new Map(nv40_depth_state(depthState).states).get(55),8);
const dxBlend=new Map(nv40_blend_state({methods:new Map([[0x310,1],[0x304,1],[0x308,5],
    [0x314,0x10021005],[0x318,0x10011006],[0x320,0x00010001]])}));
assert.equal(dxBlend.get(25),5);assert.equal(dxBlend.get(19),5);assert.equal(dxBlend.get(20),6);assert.equal(dxBlend.get(207),2);assert.equal(dxBlend.get(171),1);
depthState.methods.set(0x348,1);depthState.methods.set(0x350,0x201);depthState.methods.set(0x364,0x8508);
assert.equal(new Map(nv40_depth_state(depthState).states).get(56),2,"CCW fronts put back comparison in D3D's CW bank");
assert.equal(new Map(nv40_depth_state(depthState).states).get(189),3);
depthState.methods.set(0x1834,0x900);
assert.equal(new Map(nv40_depth_state(depthState).states).get(188),8,"CW fronts put back operations in D3D's CCW bank");
depthState.methods.set(0x354,1);assert.throws(()=>nv40_depth_state(depthState),/independent stencil references/);
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
    device.registers.set(0x90000,0x1D74);device.registers.set(0x90004,0xABCD1234);device.registers.set(0x3210,4);device.registers.set(0x3270,0);
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
        method(0x208,0x143);method(0x20C,16);
        method(0x1808,6);for(const word of new Uint32Array(Float32Array.of(0,0,0,16,16,0).buffer))method(0x1818,word);
        method(0x1808,0);await engine.backend.wait();
        assert.equal(view.getUint16(0x10000,true),6<<11|25<<5|19,"RGB565 target stores red in the high bits, including host conversion/readback");
        method(0x208,0x148);method(0x20C,32);
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
        method(0x310,1);method(0x31C,0x40204060);method(0x320,0x80068006);
        for(const [src,dst,expected]of [[0x8003,0x8004,[115,76,102,128]],[0x8004,0x8003,[38,26,204,128]]])
        {
            for(let at=0x10000;at<0x10100;at+=4)vram.set([153,102,51,255],at);
            method(0x314,0x10000|src);method(0x318,dst);
            method(0x1808,5);method(0x1814,2<<24);method(0x1808,0);await engine.backend.wait();
            const actual=[...vram.subarray(0x10000,0x10004)];
            expected.forEach((value,i)=>assert(Math.abs(actual[i]-value)<=1,"constant-alpha blend "+src.toString(16)+": "+actual));
        }
        method(0x310,0);
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
        const depthDraw=async(z,color,slope=0)=>{
            new Float32Array(vram.buffer,0x4000,12).set([0,0,z,1,0,16,z,1,16,0,z+slope,1]);
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
        for(const [at,value]of [[0x328,1],[0x348,1],[0x32C,255],[0x34C,255],[0x334,0],[0x354,0],
            [0x338,255],[0x358,255],[0x330,8],[0x350,8],[0x33C,1],[0x35C,1],[0x344,7],[0x364,8]])method(at,value);
        const beforeTwoSided=view.getUint32(0x24000,true)&255;
        method(0x1834,0x901);await depthDraw(.5,[1,0,0,1]);
        assert.equal(view.getUint32(0x24000,true)&255,(beforeTwoSided+1)&255,"CCW front stencil increments");
        method(0x1834,0x900);await depthDraw(.5,[0,0,1,1]);
        assert.equal(view.getUint32(0x24000,true)&255,beforeTwoSided,"CW front selects the back stencil decrement");
        method(0x350,1);await depthDraw(.5,[0,1,0,1]);
        assert.deepEqual([...vram.subarray(0x10000,0x10004)],[255,0,0,255],"back stencil NEVER rejects color independently");
        method(0x350,8);method(0x348,0);await depthDraw(.5,[0,1,0,1]);
        assert.deepEqual([...vram.subarray(0x10000,0x10004)],[0,255,0,255],"disabling two-sided mode restores the ordinary bank for both windings");
        method(0x328,0);method(0x1834,0x901);
        console.log("PASS: real WebGPU two-sided stencil comparisons/operations, programmable front winding and one-sided restore");
        method(0xA74,1);method(0xA70,1);method(0xA6C,8);await depthDraw(.25,[0,1,0,1]);
        const unbiased=view.getUint32(0x24000,true)>>>8;
        method(0xA7C,floatWord(65536));method(0xA68,1);await depthDraw(.25,[0,1,0,1]);
        assert(Math.abs((view.getUint32(0x24000,true)>>>8)-unbiased-32768)<=1,"NV40 polygon units are half a stored step");
        method(0xA68,0);await depthDraw(.25,[0,1,0,1],.125);
        const sloped=view.getUint32(0x24000,true)>>>8,gradient=(view.getUint32(0x24004,true)>>>8)-sloped;
        method(0xA7C,0);method(0xA78,floatWord(1));method(0xA68,1);await depthDraw(.25,[0,1,0,1],.125);
        assert(gradient>0 && Math.abs((view.getUint32(0x24000,true)>>>8)-sloped-gradient)<=2,"slope factor follows the actual window-space depth derivative");
        method(0xA68,0);method(0xA78,0);method(0xA7C,0);method(0xA6C,2);
        for(const [at,value]of [[0x208,0x128],[0x214,0x25000],[0x22C,16],[0xA74,1],[0xA70,1],[0x328,1],[0x330,1]])method(at,value);
        vram.fill(255,0x25000,0x25080);await depthDraw(.25,[0,1,0,1]);
        assert.deepEqual([...vram.subarray(0x10000,0x10004)],[0,255,0,255],"D16 has no stencil bits: enabled NEVER stencil does not reject the draw");
        assert(Math.abs(view.getUint16(0x25000,true)-Math.round(.25*65535))<=1);
        method(0xA6C,8);const d16Unbiased=view.getUint16(0x25000,true);
        method(0xA7C,floatWord(256));method(0xA68,1);await depthDraw(.25,[0,1,0,1]);
        assert(Math.abs(view.getUint16(0x25000,true)-d16Unbiased-128)<=1,"D16 polygon units use the attachment's own depth step");
        method(0xA68,0);method(0xA7C,0);method(0xA6C,2);
        console.log("PASS: real WebGPU polygon offset units for D24/D16, slope bias and disabled-state restore");
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
        method(0x1A08,0x730303);method(0x1A18,1<<16|1);method(0x1840,4);method(0x1A14,0x01010000);
        vram.set([128,64,32,200],0x20000);
        const gammaDraw=async(u=.5,v=.5)=>{
            method(0x1808,6);
            for(const word of new Uint32Array(Float32Array.of(0,0,u,v,0,16,u,v,16,0,u,v).buffer))method(0x1818,word);
            method(0x1808,0);await engine.backend.wait();assert.equal(engine.backend.stats.failures,0,JSON.stringify(graph.faults));
            return [...vram.subarray(0x10000,0x10004)];
        };
        const gammaPixel=await gammaDraw();
        [55,13,4,200].forEach((value,i)=>assert(Math.abs(gammaPixel[i]-value)<=1,"sRGB conversion preserves alpha: "+gammaPixel));
        method(0x1A18,2<<16|2);method(0x1840,8);method(0x1A14,0x02020000);
        vram.set([0,0,0,200,255,255,255,200,255,255,255,200,0,0,0,200],0x20000);
        assert.deepEqual(await gammaDraw(),[128,128,128,200],"sRGB conversion precedes bilinear filtering");
        method(0x1A08,0x30303);
        console.log("PASS: real WebGPU native RGB sRGB conversion, preserved alpha and filtering in linear space");
        method(0x1A04,0x12519);method(0x1A18,2<<16);method(0x1840,8);method(0x1A08,0x403);method(0x1A14,0x01010000);
        vram.set([0,0,255,255,255,0,0,255],0x20000);
        for(const [opcode,coordinate,expected]of [[23,[.25,99,0,2],[0,0,255,255]],
            [24,[1.5,-99,0,2],[255,0,0,255]]])
        {
            [opcode<<24|128|15<<9|1,7<<18|0x1C802,0,0,...new Uint32Array(Float32Array.from(coordinate).buffer)]
                .forEach((word,i)=>view.setUint32(0x9000+i*4,word,true));
            assert.deepEqual(await gammaDraw(),expected,"1D sample ignores out-of-range Y, including projection: "+opcode);
        }
        method(0x1A04,0x16519);
        [23<<24|128|15<<9|1,7<<18|0x1C802,0,0,...new Uint32Array(Float32Array.of(1.5,999,0,1).buffer)]
            .forEach((word,i)=>view.setUint32(0x9000+i*4,word,true));
        assert.deepEqual(await gammaDraw(),[255,0,0,255],"1D rectangle coordinates normalise X while ignoring the unused height");
        method(0x1A08,0x30303);
        method(0x1FCC,0x55);
        for(let channel=8;channel<10;channel++)
        {
            method(0x1FF4,1<<(channel+4));
            [1<<24|(4+channel)<<13|15<<9|128|1,7<<18|0x1C801,0,0]
                .forEach((word,i)=>view.setUint32(0x9000+i*4,word,true));
            assert.deepEqual(await gammaDraw(.125,.75),[0,191,32,255],"TEX"+channel+" routes the selected raw TBUF register through the semantic link");
        }
        method(0x1FF4,1<<14);
        [23<<24|4<<13|15<<9|128|1,7<<18|0x1C801,0x1C800,0x1C800].forEach((word,i)=>view.setUint32(0x9000+i*4,word,true));
        console.log("PASS: real WebGPU 1D fragment textures, ignored Y/border, projective and rectangle X coordinates");
        console.log("PASS: real WebGPU native TEX8/TEX9 interpolator routing through the vertex/fragment semantic link");
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
        method(0x1A0C,0x8A018000);await mipDraw(0x01050000,[64,191,0,255]);
        method(0x1A0C,0x80004000);await mipDraw(0x01050000,[0,128,128,255]);
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
        const mrtDraw=async(full=false)=>{
            method(0x1D60,0x04000000|+full<<6);
            let at=0x9000;
            mrtColors.forEach((color,index)=>{
                const register=(full?[0,2,3,4]:[0,4,6,8])[index],words=[0x01001E00|+!full<<7|register<<1|+(index===3),0x1DC802,0,0,
                    ...new Uint32Array(Float32Array.from(color).buffer)];
                for(const word of words){view.setUint32(at,word,true);at+=4;}
            });
            method(0x1808,6);for(const word of new Uint32Array(floats.buffer))method(0x1818,word);
            method(0x1808,0);await engine.backend.wait();
        };
        await mrtDraw();assert.equal(engine.backend.stats.failures,0,JSON.stringify(graph.faults));
        for(const [index,expected]of [[0,[0,0,255,255]],[1,[0,255,0,255]],[2,[255,0,0,255]],[3,[0,255,255,128]]])
            assert.deepEqual([...vram.subarray(mrtOffsets[index],mrtOffsets[index]+4)],expected,"MRT color "+index);
        await mrtDraw(true);
        for(const [index,expected]of [[0,[0,0,255,255]],[1,[0,255,0,255]],[2,[255,0,0,255]],[3,[0,255,255,128]]])
            assert.deepEqual([...vram.subarray(mrtOffsets[index],mrtOffsets[index]+4)],expected,"FP32 MRT color "+index);
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
        method(0x1D60,0);
        console.log("PASS: real WebGPU four FP16/FP32 MRT exports, independent color masks, atomic DMA validation and single-target reuse");
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
        for(const [code,values,expected]of [[27,[2,-1,.5,.25],[0x4000,0xBC00,0x3800,0x3400]],
            [28,[.5],[0x3800,0,0,0x3C00]]])
        {
            method(0x1A04,0x12029|code<<8);method(0x1A10,0xAAE4);method(0x1A14,0x01010000);
            method(0x1A18,1<<16|1);method(0x1840,values.length*4);
            vram.set(new Uint8Array(Float32Array.from(values).buffer),0x20000);
            method(0x1808,6);
            for(const word of new Uint32Array(Float32Array.of(0,0,.5,.5,0,16,.5,.5,16,0,.5,.5).buffer))method(0x1818,word);
            method(0x1808,0);await engine.backend.wait();assert.equal(engine.backend.stats.failures,0,JSON.stringify(graph.faults));
            assert.deepEqual([...new Uint16Array(vram.buffer,0x10000,4)],expected,"sampled FP32 fragment format "+code);
        }
        console.log("PASS: real WebGPU RGBA32F/R32F fragment textures retain HDR, signed values and scalar zero/one expansion");
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
        const ccInstruction=(value,{condition=7,swizzle=[0,1,2,3],update=false,disabled=false,mask=15,saturate=false,end=false,read=0,write=0}={})=>[
            (1<<24|128|mask<<9|+update<<8|+disabled<<30|+saturate<<31|+end)>>>0,
            condition<<18|conditionSwizzle(swizzle)|0x1C802|read<<31|write<<30,0,0,...new Uint32Array(Float32Array.from(value).buffer)];
        const conditionalDraw=async(words)=>{
            words.forEach((word,i)=>view.setUint32(0x9000+i*4,word,true));
            method(0x1808,6);for(const word of new Uint32Array(floats.buffer))method(0x1818,word);
            method(0x1808,0);await engine.backend.wait();assert.equal(engine.backend.stats.failures,0,JSON.stringify(graph.faults));
            return [...vram.subarray(0x10000,0x10004)];
        };
        const conditions=[()=>false,x=>x<0,x=>x===0,x=>x<=0,x=>x>0,x=>x!==0,x=>x>=0,()=>true];
        const fpMove=(destination,half,source,sourceHalf,{mask=15,swizzle=[0,1,2,3],condition=7,end=false}={})=>[
            (1<<24|destination<<1|+half<<7|mask<<9|+end)>>>0,
            source<<2|+sourceHalf<<8|swizzle.reduce((bits,value,i)=>bits|value<<(9+i*2),0)|condition<<18,0,0];
        const fpLiteral=(destination,half,values,{mask=15,end=false}={})=>[
            (1<<24|destination<<1|+half<<7|mask<<9|+end)>>>0,7<<18|0x1C802,0,0,
            ...new Uint32Array(Float32Array.from(values).buffer)];
        assert.deepEqual(await conditionalDraw([
            ...fpLiteral(2,true,[.25,.5,.75,1]),...fpMove(0,false,1,false,{end:true})]),[191,128,64,255],
            "full-register MOV copies both packed halves to their aliased H output");
        assert.deepEqual(await conditionalDraw([
            ...fpLiteral(0,false,[1,1,1,1]),...fpLiteral(0,true,[.25,.5,.75,1],{mask:5}),
            ...fpMove(2,true,0,true,{swizzle:[3,2,1,0]}),...fpMove(0,false,1,false,{end:true})]),[255,191,255,64],
            "masked H writes preserve the adjacent half and copies read all old lanes before writing");
        // NaN payload 0x7fff3800 must survive an R MOV. Changing just H0.y
        // afterwards makes the low payload observable as H0.x == 0.5.
        assert.deepEqual(await conditionalDraw([
            ...fpLiteral(1,false,[new Float32Array(Uint32Array.of(0x7fff3800).buffer)[0],0,0,0]),
            ...fpMove(0,false,1,false),...fpLiteral(0,true,[0,1,.25,.75],{mask:14,end:true})]),[64,255,128,191],
            "raw MOV preserves NaN payload bits across full/half aliases");
        for(const [value,expected]of [[2**-24,255],[2**-25,0],[2**-25+2**-35,255]])
        {
            const multiply=[2<<24|128|15<<9|1,7<<18|0x1C900,0x1C802,0,...new Uint32Array(Float32Array.of(2**24,2**24,2**24,2**24).buffer)];
            assert.deepEqual(await conditionalDraw([...fpLiteral(0,true,Array(4).fill(value)),...multiply]),Array(4).fill(expected),
                "FP16 subnormal rounding " + value);
        }
        for(const [value,expected]of [[1+2**-11,0],[1+3*2**-11,255]])
        {
            const add=[3<<24|128|15<<9,7<<18|0x1C900,0x1C802,0,...new Uint32Array(Float32Array.of(-1,-1,-1,-1).buffer)];
            const scale=[2<<24|128|15<<9|1,7<<18|0x1C900,0x1C802,0,...new Uint32Array(Float32Array.of(512,512,512,512).buffer)];
            assert.deepEqual(await conditionalDraw([...fpLiteral(0,true,Array(4).fill(value)),...add,...scale]),Array(4).fill(expected),
                "FP16 normal halfway cases round to the even mantissa");
        }
        assert.deepEqual(await conditionalDraw([
            ...fpLiteral(0,true,[0,0,0,0]),...ccInstruction([2**-25,-(2**-25),2**-24,-(2**-24)],{update:true,disabled:true}),
            ...ccInstruction([1,1,1,1],{condition:2,end:true})]),[0,255,255,0],
            "half destination condition codes observe rounded signed zero");
        console.log("PASS: real WebGPU shared R/H bits, partial half writes, raw NaN MOV, FP16 subnormals and rounded condition codes");
        const fpPacked=(opcode,destination,half,source,{swizzle=[0,1,2,3],mask=15,condition=7,end=false}={})=>[
            (opcode<<24|destination<<1|+half<<7|mask<<9|+end)>>>0,
            source<<2|swizzle.reduce((bits,value,i)=>bits|value<<(9+i*2),0)|condition<<18,0,0];
        for(const [pack,unpack,values,expected]of [
            [36,37,[.25,.75,0,0],[64,191,64,191]],
            [41,42,[.25,1,0,0],[64,255,64,255]],
            [39,40,[.25,.5,1,127/255],[255,128,64,127]],
            [19,40,[-128/127,0,1,2],[255,128,0,255]],
            [19,20,[0,.5,1,1],[255,128,0,255]]])
        {
            for(let component=0;component<4;component++)
                assert.deepEqual(await conditionalDraw([
                    ...fpLiteral(2,false,values),...fpPacked(pack,3,false,2),...fpMove(1,false,3,false),
                    ...fpPacked(unpack,0,true,1,{swizzle:Array(4).fill(component),end:true})]),expected,
                    "pack " + pack + " replicates raw bits, survives MOV, and unpacks component " + component);
        }
        // Constant/input operands and raw full-register operands take separate
        // routes through the private instruction; neither may normalize NaNs.
        assert.deepEqual(await conditionalDraw([
            40<<24|128|15<<9|1,7<<18|0x1C802,0,0,0x7FFF8040,0,0,0]),[255,128,64,127],
            "unpacking an inline NaN payload preserves all four encoded bytes");
        assert.deepEqual(await conditionalDraw([
            ...fpLiteral(0,true,[.5,.5,.5,.5]),...fpLiteral(2,false,[1,0,.25,1]),
            ...ccInstruction([1,-1,1,-1],{update:true,disabled:true}),
            ...fpPacked(39,3,false,2,{mask:5,condition:4}),
            ...fpPacked(40,0,true,3,{mask:5,end:true})]),[64,128,255,128],
            "pack and unpack honor masks and per-component predicates");
        console.log("PASS: real WebGPU all pack/unpack formats, biased signed bytes, replication, raw NaN payloads and predicates");
        for(const [values,expected]of [
            [[.9,.5,.8,-2],[64,128,255,255]],[[.9,0,.8,-2],[0,0,255,255]],
            [[.9,-.5,.8,1],[0,0,255,255]],[[0,.25,0,0],[255,64,255,255]]])
            assert.deepEqual(await conditionalDraw([
                0x3C<<24|128|15<<9|1,7<<18|0x1C802,0,0,...new Uint32Array(Float32Array.from(values).buffer)]),expected,
                "native LITEX2 uses Y/W and suppresses specular for nonpositive diffuse");
        console.log("PASS: real WebGPU native LITEX2 diffuse/specular final lighting stage");
        const fpUnary=(opcode,values,{destination=0,half=true,disabled=false,update=false,end=false}={})=>[
            (opcode<<24|destination<<1|+half<<7|15<<9|+update<<8|+disabled<<30|+end)>>>0,7<<18|0x1C802,0,0,
            ...new Uint32Array(Float32Array.from(values).buffer)];
        assert.deepEqual(await conditionalDraw(fpUnary(0x1A,[-0,-0,-0,-0],{end:true})),[0,0,0,0],
            "fragment RCP preserves negative zero as negative infinity");
        assert.deepEqual(await conditionalDraw([
            ...fpLiteral(0,true,[.25,.25,.25,.25]),...fpUnary(0x1D,[-2,-2,-2,-2],{disabled:true,update:true}),
            ...ccInstruction([1,1,1,1],{condition:4,end:true})]),Array(4).fill(64),"fragment LG2 negative input is unordered");
        const reciprocalBits=fpMove(0,true,2,true);reciprocalBits[0]|=1<<8|1<<30;
        assert.deepEqual(await conditionalDraw([
            ...fpLiteral(0,true,[.25,.25,.25,.25]),...fpUnary(0x1A,[0,0,0,0],{destination:1,half:false}),
            ...reciprocalBits,...ccInstruction([1,1,1,1],{condition:2,swizzle:[0,0,0,0],end:true})]),Array(4).fill(255),
            "RCP(0) has exact infinity bits rather than the D3D finite maximum");
        const fpDivide=(denominator,{disabled=false,update=false,end=false}={})=>[
            (0x3A<<24|128|15<<9|+disabled<<30|+update<<8|+end)>>>0,7<<18|0x1C808,0x1C802,0,
            ...new Uint32Array(Float32Array.from(denominator).buffer)];
        assert.deepEqual(await conditionalDraw([
            ...fpLiteral(2,false,[1,.5,0,1]),...fpDivide([2,4,8,16],{end:true})]),[0,64,128,128],
            "native DIV divides all lanes by source-one X");
        assert.deepEqual(await conditionalDraw([
            ...fpLiteral(2,false,[1,0,-1,2]),...fpDivide([-0,-0,-0,-0],{end:true})]),[255,0,0,0],
            "DIV signed-zero denominator keeps infinity signs");
        assert.deepEqual(await conditionalDraw([
            ...fpLiteral(0,true,[.25,.25,.25,.25]),...fpLiteral(2,false,[1,0,-1,2]),...fpDivide([0,0,0,0],{disabled:true,update:true}),
            ...ccInstruction([1,1,1,1],{condition:2,swizzle:[1,1,1,1],end:true})]),Array(4).fill(64),"DIV zero over zero updates CC as unordered");
        console.log("PASS: real WebGPU native fragment RCP/LG2/DIV special values, exact infinity bits, scalar divisor and unordered CC");
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
        assert.deepEqual(saturated,[191,191,64,64],"CC classification follows result saturation, including NaN to zero");
        for(const [component,killed]of [[1,false],[0,true]])
        {
            for(let at=0x10000;at<0x10100;at+=4)vram.set([13,17,19,23],at);
            const pixel=await conditionalDraw([...ccInstruction([1,1,1,1]),
                ...ccInstruction([-1,0,1,0],{update:true,disabled:true}),
                18<<24|1,1<<18|conditionSwizzle(Array(4).fill(component)),0,0]);
            assert.deepEqual(pixel,killed?[13,17,19,23]:[255,255,255,255],"KIL tests swizzled condition codes");
        }
        console.log("PASS: real WebGPU all fragment conditions, NaN/unordered, masked CC updates, saturation and conditional discard");
        for(let read=0;read<2;read++)for(let condition=0;condition<8;condition++)
        {
            const values=[[-1,0,1,NaN],[1,-1,0,NaN]],pixel=await conditionalDraw([
                ...ccInstruction([.25,.25,.25,.25]),
                ...ccInstruction(values[0],{update:true,disabled:true,write:0}),
                ...ccInstruction(values[1],{update:true,disabled:true,write:1}),
                ...ccInstruction([.75,.75,.75,.75],{condition,swizzle:[3,2,1,0],read,end:true})]);
            const rgba=[...values[read]].reverse().map(value=>conditions[condition](value)?191:64);
            assert.deepEqual(pixel,[rgba[2],rgba[1],rgba[0],rgba[3]],"independent fragment condition bank "+read+" condition "+condition);
        }
        assert.deepEqual(await conditionalDraw([
            ...ccInstruction([0,0,0,0]),...ccInstruction([1,-1,1,-1],{update:true,disabled:true,write:0}),
            ...ccInstruction([0,1,-1,1],{update:true,disabled:true,write:1}),
            ...ccInstruction([-1,-1,-1,-1],{condition:4,update:true,disabled:true,read:0,write:1}),
            ...ccInstruction([1,1,1,1],{condition:1,read:1,end:true})]),[255,0,255,0],
            "predicate reads one CC bank while a masked update preserves the other bank's false lanes");
        console.log("PASS: real WebGPU both fragment condition banks, separate read/write selectors and preserved false lanes");
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
        const fpAdd=(value,end=false)=>[3<<24|128|15<<9|+end,7<<18|0x1C900,0x1C802,0,
            ...new Uint32Array(Float32Array.of(value,value,value,value).buffer)];
        const fpReturn=()=>fpBranch(5,0,0),fpGap=[0,7<<18,0,0];
        for(const condition of [0,1,2,4,7])
            assert.deepEqual(await conditionalDraw([...ccInstruction([.125,.125,.125,.125]),...fpBranch(1,24,0,condition),
                ...fpAdd(.125,true),...fpGap,...fpAdd(.25),...fpReturn()]),Array(4).fill(condition===2 || condition===7?128:64),
                "fragment conditional call and return across the main END, condition "+condition);
        assert.deepEqual(await conditionalDraw([...ccInstruction([.25,.25,.25,.25]),...fpReturn(),
            ...ccInstruction([.75,.75,.75,.75],{end:true})]),Array(4).fill(64),"empty-stack RET terminates and exports the current result");
        assert.deepEqual(await conditionalDraw(fpReturn()),[0,0,0,0],"unwritten outputs on an empty return use the defined zero fallback");
        for(const condition of [0,2])
            assert.deepEqual(await conditionalDraw([...ccInstruction([.125,.125,.125,.125]),...fpBranch(1,24,0),
                ...fpAdd(.125,true),...fpGap,...fpBranch(5,0,0,condition),...fpAdd(.25),...fpReturn()]),Array(4).fill(condition===2?64:128),
                "conditional RET uses the current condition code");
        assert.deepEqual(await conditionalDraw([...ccInstruction([.25,.25,.25,.25]),...fpBranch(1,24,0),
            ...ccInstruction([.75,.75,.75,.75],{condition:1,read:1,end:true}),...fpGap,
            ...ccInstruction([-1,-1,-1,-1],{update:true,disabled:true,write:1}),...fpReturn()]),Array(4).fill(191),
            "a callee's condition-code update remains visible to its caller");
        assert.deepEqual(await conditionalDraw([...ccInstruction([.125,.125,.125,.125]),...fpBranch(1,24,0),
            ...fpAdd(1,true),...fpGap,...fpAdd(.25,true)]),Array(4).fill(96),"END inside a callee terminates the whole fragment program");
        assert.deepEqual(await conditionalDraw([...ccInstruction([0,0,0,0]),...fpBranch(1,24,0),
            ...ccInstruction([1,1,1,1],{end:true}),...fpGap,...fpAdd(.125),...fpBranch(1,24,0),...fpReturn()]),Array(4).fill(128),
            "recursive calls terminate at the four-entry stack limit without executing caller writes");
        assert.deepEqual(await conditionalDraw([...ccInstruction([.125,.125,.125,.125]),...fpBranch(1,24,0),
            ...fpAdd(.125,true),...fpGap,...fpBranch(3,3<<2|2<<10|1<<19,44),...fpAdd(.125),
            ...fpReturn(),...fpGap,...fpReturn()]),Array(4).fill(96),"RET exits a callee's LOOP immediately");
        assert.deepEqual(await conditionalDraw([...ccInstruction([.25,.25,.25,.25]),
            ...Array.from({length:4},()=>fpBranch(3,1<<2|1<<19,28)).flat(),...fpBranch(1,44,0),
            ...ccInstruction([1,1,1,1],{end:true}),...fpGap,...fpGap,
            ...fpBranch(3,1<<2|1<<19,56),...fpAdd(.125),...fpReturn()]),Array(4).fill(64),
            "a callee exceeding the caller's active four-loop limit terminates the whole program");
        console.log("PASS: real WebGPU fragment calls, conditional/empty returns, callee END and bounded recursion");

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
        const compareTests=[()=>false,(r,d)=>r>d,(r,d)=>r===d,(r,d)=>r>=d,(r,d)=>r<d,(r,d)=>r!==d,(r,d)=>r<=d,()=>true];
        const shadowDraw=async(reference,{project=false,crossbar=0xAA6C,coordinate=.5}={})=>{
            method(0x1A10,crossbar);
            [((project?24:23)<<24|128|15<<9|1)>>>0,7<<18|0x1C802,0,0,
                ...new Uint32Array(Float32Array.of(coordinate,coordinate,reference*(project?2:1),project?2:1).buffer)]
                .forEach((word,i)=>view.setUint32(0x9000+i*4,word,true));
            method(0x1808,6);
            for(const word of new Uint32Array(Float32Array.of(0,0,0,0,0,0,16,0,0,0,16,0,0,0,0).buffer))method(0x1818,word);
            method(0x1808,0);await engine.backend.wait();assert.equal(engine.backend.stats.failures,0,JSON.stringify(graph.faults));
            return [...vram.subarray(0x10000,0x10004)];
        };
        for(const [code,bpp,word]of [[16,4,0x8000005A],[18,2,0x8000]])
        {
            for(const [at,value]of [[0x1A00,0x70000],[0x1A04,0x12021|code<<8],[0x1A18,1<<16|1],[0x1840,bpp],
                [0x1A0C,0x80000000],[0x1A14,0x01010000]])method(at,value);
            if(bpp===4)view.setUint32(0x70000,word,true);else view.setUint16(0x70000,word,true);
            const depth=Math.fround(bpp===4?(word>>>8)/0xFFFFFF:word/65535);
            for(let compare=0;compare<8;compare++)for(const reference of [.25,depth,.75])
            {
                method(0x1A08,compare<<28|0x303);
                assert.deepEqual(await shadowDraw(reference),Array(4).fill(compareTests[compare](reference,depth)?255:0),
                    "native depth format " + code + " compare function " + compare);
            }
            method(0x1A08,6<<28|0x303);
            assert.deepEqual(await shadowDraw(.25,{project:true,coordinate:1}),Array(4).fill(255),"projected shadow reference divides by W");
            assert.deepEqual(await shadowDraw(.75,{crossbar:0xAA6C&~0xC000|0x4000}),[0,0,255,0],
                "depth-result component crossbar can select constant one");
        }
        // Four PCF taps must compare individually before their linear blend.
        method(0x1A18,2<<16|2);method(0x1840,4);method(0x1A14,0x02020000);
        [0,65535,65535,0].forEach((z,i)=>view.setUint16(0x70000+i*2,z,true));
        const pcf=await shadowDraw(.5);assert(pcf.every(value=>Math.abs(value-128)<=1),"bilinear depth PCF blends comparison results: "+pcf);
        console.log("PASS: real WebGPU Z16/Z24 comparisons, all eight functions, projective reference, crossbar and four-tap PCF");
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
            const vertexTextureDraw=async(unit,coordinate)=>{
                const position=structuredClone(base),color=structuredClone(base);
                color.vector={name:"TXL",type:"output",index:1,mask:15};color.texture=unit;
                color.sources[0]={...base.sources[0],type:"constant",index:0};
                vertexProgram={instructions:[position,color]};
                method(0x1EFC,0);new Uint32Array(Float32Array.from(coordinate).buffer).forEach((word,i)=>method(0x1F00+i*4,word));
                method(0x1808,6);for(const word of new Uint32Array(Float32Array.of(0,0,0,1,0,16,0,1,16,0,0,1).buffer))method(0x1818,word);
                method(0x1808,0);await engine.backend.wait();assert.equal(engine.backend.stats.failures,0,JSON.stringify(graph.faults));
                return [...vram.subarray(0x10000,0x10004)];
            };
            for(let unit=0;unit<4;unit++)
            {
                const at=0x900+unit*32,offset=0x80000+unit*128;
                for(const [field,value]of [[0,offset],[4,0x1BB21],[8,0x303],[12,0x80000000],[16,16],[20,0],[24,1<<16|1]])method(at+field,value);
                vram.set(new Uint8Array(Float32Array.of(.25,unit/4,.75,1).buffer),offset);
                assert.deepEqual(await vertexTextureDraw(unit,[.5,.5,0,0]),[191,Math.round(unit/4*255),64,255],
                    "vertex texture unit " + unit + " uses independent RGBA32F storage and vertex sampler binding");
            }
            for(const [at,value]of [[0x904,0x2BC11],[0x910,12],[0x918,2<<16|1],[0x90C,0x80008000]])method(at,value);
            vram.set(new Uint8Array(Float32Array.of(.25,.75,123,.5).buffer),0x80000);
            assert.deepEqual(await vertexTextureDraw(0,[.75,999,0,0]),[0,0,191,255],"1D R32F ignores Y and supplies zero G/B and one alpha");
            assert.deepEqual(await vertexTextureDraw(0,[.75,999,0,1]),[0,0,128,255],"vertex TXL W selects the padded mip level");
            method(0x914,256);assert.deepEqual(await vertexTextureDraw(0,[.75,999,0,0]),[0,0,128,255],"vertex sampler bias is added to explicit LOD");
            method(0x914,0);method(0x90C,0x80000000);
            assert.deepEqual(await vertexTextureDraw(0,[.75,999,0,1]),[0,0,191,255],"vertex maximum LOD clamps the instruction operand");
            method(0x90C,0x80000000|192<<19|192<<7);
            assert.deepEqual(await vertexTextureDraw(0,[.75,999,0,0]),[0,0,128,255],"fractional vertex LOD clamp selects the nearest mip");
            console.log("PASS: real WebGPU four vertex samplers, RGBA32F/R32F, 1D coordinates, explicit LOD, bias and fractional clamp");
            method(0x1EFC,0);
            [...new Uint32Array(Float32Array.of(.25,.5,0,2).buffer)].forEach((word,i)=>method(0x1F00+i*4,word));
            for(const [name,swizzle,expected]of [["MOV",[0,1,2,3],[0,128,64,255]],
                ["LIT",[0,1,2,3],[64,64,255,255]],["LIT",[1,0,2,3],[16,128,255,255]]])
            {
                const position=structuredClone(base),color=structuredClone(base);
                color.vector={name:"NOP",mask:0};color.scalar={name,type:"output",index:1,mask:15};
                color.sources[2]={...color.sources[2],type:"constant",index:0,swizzle};
                vertexProgram={stage:"vertex",instructions:[position,color]};
                method(0x1808,5);for(const word of new Uint32Array(Float32Array.of(0,0,0,1,0,16,0,1,16,0,0,1).buffer))method(0x1818,word);
                method(0x1808,0);await engine.backend.wait();
                assert.deepEqual([...vram.subarray(0x10000,0x10004)],expected,"scalar-slot "+name+" retains vector source swizzle");
            }
            for(const [name,value,scale,bias,expected]of [
                ["EXP",-.25,[1,1,1,1],0,[214,191,128,255]],
                ["LOG",-3,[.5,.5,.25,1],0,[101,191,128,255]],
                ["LOG",1.9999998807907104,[1,.25,.5,1],0,[127,127,0,255]],
                ["RCC",0,Array(4).fill(2**-64),0,Array(4).fill(255)],
                ["RCC",-0,Array(4).fill(2**-64),1,Array(4).fill(0)],
                ["RCC",Infinity,Array(4).fill(2**64),0,Array(4).fill(255)],
                ["RCC",-Infinity,Array(4).fill(2**64),1,Array(4).fill(0)],
                ["RCC",2,Array(4).fill(1),0,Array(4).fill(128)],
                ["RCP",-0,Array(4).fill(1),0,Array(4).fill(0)],
                ["RCP",0,Array(4).fill(1),0,Array(4).fill(255)],
                ["RSQ",4,Array(4).fill(1),0,Array(4).fill(128)],
                ["LG2",2,Array(4).fill(.5),0,Array(4).fill(128)],
                ["LIT",[1,0,0,-1],[1,1,1,1],0,Array(4).fill(255)]])
            {
                method(0x1EFC,0);
                [...new Uint32Array(Float32Array.of(...(Array.isArray(value)?value:Array(4).fill(value)),...scale,...Array(4).fill(bias)).buffer)]
                    .forEach((word,i)=>method(0x1F00+(i%4)*4,word));
                const position=structuredClone(base),calculate=structuredClone(base),color=structuredClone(base);
                calculate.vector={name:"NOP",mask:0};calculate.scalar={name,type:"temp",index:0,mask:15};
                calculate.sources[2]={...calculate.sources[2],type:"constant",index:0};
                color.vector={name:"MAD",type:"output",index:1,mask:15};
                color.sources=[{...base.sources[0],type:"temp",index:0},
                    {...base.sources[0],type:"constant",index:1},{...base.sources[0],type:"constant",index:2}];
                vertexProgram={stage:"vertex",instructions:[position,calculate,color]};
                method(0x1808,5);for(const word of new Uint32Array(Float32Array.of(0,0,0,1,0,16,0,1,16,0,0,1).buffer))method(0x1818,word);
                method(0x1808,0);await engine.backend.wait();
                const pixel=[...vram.subarray(0x10000,0x10004)];
                expected.forEach((value,i)=>assert(Math.abs(pixel[i]-value)<=1,"NV "+name+" "+value+": "+pixel));
            }
            for(const name of ["RSQ","LG2"])
            {
                method(0x1EFC,0);[...new Uint32Array(Float32Array.of(-4,-4,-4,-4).buffer)].forEach((word,i)=>method(0x1F00+i*4,word));
                const position=structuredClone(base),calculate=structuredClone(base),initial=structuredClone(base),color=structuredClone(base);
                calculate.vector={name:"NOP",mask:0};calculate.scalar={name,type:"temp",index:0,mask:15};
                calculate.sources[2]={...calculate.sources[2],type:"constant",index:0};
                calculate.predicate={...calculate.predicate,update:true,vector:false,register:0};
                initial.vector={name:"SFL",type:"output",index:1,mask:15};color.vector={name:"STR",type:"output",index:1,mask:15};
                color.predicate={...color.predicate,enabled:true,condition:4,register:0};
                vertexProgram={stage:"vertex",instructions:[position,calculate,initial,color]};
                method(0x1808,5);for(const word of new Uint32Array(Float32Array.of(0,0,0,1,0,16,0,1,16,0,0,1).buffer))method(0x1818,word);
                method(0x1808,0);await engine.backend.wait();
                assert.deepEqual([...vram.subarray(0x10000,0x10004)],Array(4).fill(0),name+" negative input is unordered, without D3D abs");
            }
            method(0x1EFC,0);
            [...new Uint32Array(Float32Array.of(-1,0,1,NaN,.25,.25,.25,.25,.75,.75,.75,.75).buffer)].forEach((word,i)=>method(0x1F00+(i%4)*4,word));
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
            for(const [name,value,baseIndex,relativeInput,expected,component=0]of [
                ["ARL",1.75,1,false,Array(4).fill(191)],["ARR",1.75,1,false,Array(4).fill(128)],
                ["ARL",-.25,3,false,Array(4).fill(191)],["ARR",-.25,3,false,Array(4).fill(128)],
                ["ARL",300,200,false,[128,255,0,255]],["ARL",1.75,1,true,[128,0,255,255]],
                ["ARL",[0,1.75,0,0],1,false,Array(4).fill(191),1]])
            {
                method(0x1EFC,0);
                [...new Uint32Array(Float32Array.of(...(Array.isArray(value)?value:[value,value,value,value]),.25,.25,.25,.25,.75,.75,.75,.75,.5,.5,.5,.5).buffer)]
                    .forEach((word,i)=>method(0x1F00+(i%4)*4,word));
                method(0x1EFC,500);[...new Uint32Array(Float32Array.of(0,1,.5,1).buffer)].forEach((word,i)=>method(0x1F00+i*4,word));
                [...new Uint32Array(Float32Array.of(1,0,.5,1).buffer)].forEach((word,i)=>method(0x1C20+i*4,word));
                const position=structuredClone(base),load=structuredClone(base),color=structuredClone(base);
                load.vector={name,type:"temp",index:1,mask:15};load.sources[0]={...load.sources[0],type:"constant",index:0};
                color.vector.index=1;color.sources[0]={...color.sources[0],type:relativeInput?"input":"constant",index:baseIndex};
                color.address={register:1,component,input:relativeInput,constant:!relativeInput};
                vertexProgram={stage:"vertex",instructions:[position,load,color]};
                method(0x1808,5);for(const word of new Uint32Array(Float32Array.of(0,0,0,1,0,16,0,1,16,0,0,1).buffer))method(0x1818,word);
                method(0x1808,0);await engine.backend.wait();assert.equal(engine.backend.stats.failures,0,JSON.stringify(graph.faults));
                assert.deepEqual([...vram.subarray(0x10000,0x10004)],expected,name+" relative "+(relativeInput?"attribute":"constant")+" value "+value);
            }
            for(const [values,component,mask,expected]of [
                [[1,2,1,1],1,15,191],[[1,2,1,1],1,1,64],[[400,0,400,0],0,15,128]])
            {
                method(0x1EFC,0);[...new Uint32Array(Float32Array.of(...values,.25,.25,.25,.25,.25,.25,.25,.25,.75,.75,.75,.75).buffer)]
                    .forEach((word,i)=>method(0x1F00+(i%4)*4,word));
                method(0x1EFC,511);[...new Uint32Array(Float32Array.of(.5,.5,.5,.5).buffer)].forEach((word,i)=>method(0x1F00+i*4,word));
                const position=structuredClone(base),load=structuredClone(base),add=structuredClone(base),color=structuredClone(base);
                load.vector={name:"ARL",type:"temp",index:1,mask:15};load.sources[0]={...load.sources[0],type:"constant",index:0};
                add.vector={name:"ARA",type:"temp",index:1,mask};add.address.register=1;
                add.sources=add.sources.map(s=>({...s,type:"invalid"})); // ARA reads ASRC, without float operand swizzle.
                color.vector.index=1;color.sources[0]={...color.sources[0],type:"constant",index:0};
                color.address={register:1,component,input:false,constant:true};
                vertexProgram={stage:"vertex",instructions:[position,load,add,color]};
                method(0x1808,5);for(const word of new Uint32Array(Float32Array.of(0,0,0,1,0,16,0,1,16,0,0,1).buffer))method(0x1818,word);
                method(0x1808,0);await engine.backend.wait();
                assert.deepEqual([...vram.subarray(0x10000,0x10004)],Array(4).fill(expected),"ARA paired sums, destination mask and address saturation");
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
                assert.deepEqual([...vram.subarray(0x10000,0x10004)],Array.isArray(expected)?expected:Array(4).fill(expected));
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
            method(0x1EFC,0);
            [...new Uint32Array(Float32Array.of(1,2,3,4,...Array(4).fill(.25),...Array(4).fill(.5),
                ...Array(4).fill(.75),...Array(4).fill(1),...Array(4).fill(0),...Array(4).fill(4)).buffer)]
                .forEach((word,i)=>method(0x1F00+(i%4)*4,word));
            const loadAddress=(pc,register=1,constant=0)=>instruction(pc,"ARL",register,"temp",constant);
            const addressPush=pc=>{const i=flowInstruction(pc,"PUSHA");i.address.register=1;return i;};
            const addressPop=pc=>{const i=flowInstruction(pc,"POPA");i.scalar={name:"POPA",type:"temp",index:0,mask:15};return i;};
            const addressColor=(pc,component)=>{const i=instruction(pc,"MOV",1,"output",0);i.address={register:0,component,constant:true,input:false};return i;};
            const terminal=pc=>{const i=instruction(pc);i.end=true;return i;};
            for(let component=0;component<4;component++)
                await flowDraw([position,loadAddress(1),addressPush(2),loadAddress(3,1,5),addressPop(4),addressColor(5,component),terminal(6)],
                    [64,128,191,255][component]);
            await flowDraw([position,loadAddress(1),addressPush(2),flowInstruction(3,"CAL",8),addressPop(4),addressColor(5,2),terminal(6),
                loadAddress(8,1,5),flowInstruction(9,"RET")],191);
            await flowDraw([position,loadAddress(1),flowInstruction(2,"CAL",7),addressColor(3,2),terminal(4),
                addressPush(7),loadAddress(8,1,5),addressPop(9),flowInstruction(10,"RET")],191);
            const simultaneousPush=addressPush(2);simultaneousPush.vector=loadAddress(2,1,5).vector;
            simultaneousPush.sources[0]=loadAddress(2,1,5).sources[0];
            await flowDraw([position,loadAddress(1),simultaneousPush,addressPop(3),addressColor(4,2),terminal(5)],191);
            const black=pc=>instruction(pc,"SFL",1,"output"),white=pc=>instruction(pc,"STR",1,"output");
            await flowDraw([position,black(1),addressPop(2),white(3),terminal(4)],0);
            await flowDraw([position,black(1),flowInstruction(2,"CAL",6),white(3),terminal(4),addressPop(6),white(7),terminal(8)],0);
            await flowDraw([position,black(1),loadAddress(2,1,6),addressPush(3),flowInstruction(4,"RET"),white(5),terminal(6)],0);
            await flowDraw([position,black(1),loadAddress(2),...Array.from({length:8},(_,i)=>addressPush(3+i)),
                flowInstruction(11,"CAL",15),white(12),terminal(13),flowInstruction(15,"RET")],0);
            await flowDraw([position,black(1),...Array.from({length:9},(_,i)=>addressPush(2+i)),white(11),terminal(12)],0);
            method(0x1EFC,7);[...new Uint32Array(Float32Array.of(-2,-2,-2,-2).buffer)].forEach((word,i)=>method(0x1F00+i*4,word));
            for(const [baseIndex,constant,mask,condition,expected]of [[0,4,15,7,128],[15,4,15,7,64],
                [1,7,15,7,64],[0,4,1,7,[64,64,128,64]],[0,4,15,0,64]])
            {
                const indexedColor=instruction(3,"MOV",baseIndex,"output",2);indexedColor.vector.mask=mask;
                indexedColor.address={register:1,component:0,input:false,constant:false,output:true};
                indexedColor.predicate={...indexedColor.predicate,enabled:true,condition};
                await flowDraw([position,instruction(1,"MOV",1,"output",1),loadAddress(2,1,constant),indexedColor,terminal(4)],expected);
            }
            const pairedOutput=instruction(3,"ARL",1,"temp",5);
            pairedOutput.scalar={name:"MOV",type:"output",index:0,mask:15};pairedOutput.sources[2]={...base.sources[2],type:"constant",index:2};
            pairedOutput.address={register:1,component:0,input:false,constant:false,output:true};
            await flowDraw([position,instruction(1,"MOV",1,"output",1),loadAddress(2,1,4),pairedOutput,terminal(4)],128);


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
