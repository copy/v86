#!/usr/bin/env node
import assert from "node:assert/strict";
import {NVDMA} from "../../src/graphics_adapters/geforce_6800/nv_dma.js";
import {NV2D} from "../../src/graphics_adapters/geforce_6800/nv_2d.js";
import {NV40State} from "../../src/graphics_adapters/geforce_6800/nv40_state.js";
import {NV40Texture} from "../../src/graphics_adapters/geforce_6800/nv40_texture.js";
const vram=new Uint8Array(2<<20),ramin=new DataView(vram.buffer,1<<20);
const device={vram_size:vram.length,vram:()=>vram,vga:{lfb_region:1},machine:{mmio_ram_mark_dirty(){},is_bus_master:()=>true}};
device.dma=new NVDMA(device);device.graph={device};device.graph.engine2d=new NV2D(device.graph);
const state=new NV40State(device),texture=new NV40Texture(state),o={methods:new Map([[0x184,0x10],[0x1A00,0x1000],
    [0x1A04,0x12529],[0x1A08,0x30303],[0x1A0C,0x80000000],[0x1A10,0xAA6C],[0x1A14,0x01010000],[0x1A18,2<<16|2],[0x1840,12]])};
ramin.setUint32(0x100,0x303D,true);ramin.setUint32(0x104,0xFFFF,true);ramin.setUint32(0x108,3,true);
vram.set([0,0,255,255,0,255,0,255,99,98,97,96,255,0,0,255,255,255,255,255],0x1000);
let t=texture.describe(o,0);assert.deepEqual([...texture.read(t)],[255,0,0,255,0,255,0,255,0,0,255,255,255,255,255,255]);
o.methods.set(0x1A10,0xAAE4);assert.deepEqual([...texture.read(texture.describe(o,0)).subarray(0,4)],[0,0,255,255],"crossbar selects storage components, not format names");
o.methods.set(0x1A18,4<<16|2);o.methods.set(0x1A04,0x10529);o.methods.set(0x1A00,0x2000);
[1,2,5,6,3,4,7,8].forEach((red,i)=>vram.set([red,0,0,255],0x2000+i*4));
const morton=texture.read(texture.describe(o,0));assert.deepEqual(Array.from({length:8},(_,i)=>morton[i*4]),[1,2,3,4,5,6,7,8]);
o.methods.set(0x1A04,0x12429);o.methods.set(0x1A18,1<<16|1);o.methods.set(0x1A10,0xAA6C);o.methods.set(0x1840,2);
vram.set([0,0xF8],0x2000);assert.deepEqual([...texture.read(texture.describe(o,0))],[255,0,0,255],"RGB565 storage components expand before swizzling");
o.methods.set(0x1A04,0x12129);o.methods.set(0x1A10,0xA9FC);o.methods.set(0x1840,1);vram[0x2000]=128;
assert.deepEqual([...texture.read(texture.describe(o,0))],[128,128,128,255],"luminance and constant-one component selection");
o.methods.set(0x1A04,0x12B29);o.methods.set(0x1A10,0xAAFC);o.methods.set(0x1840,2);vram.set([64,128],0x2000);
assert.deepEqual([...texture.read(texture.describe(o,0))],[64,64,64,128],"A8L8 alpha occupies storage component 3");
o.methods.set(0x1A0C,0);assert.throws(()=>texture.describe(o,0),/disabled/);o.methods.set(0x1A0C,0x80000000);
o.methods.set(0x1A04,0x22B29);assert.throws(()=>texture.describe(o,0),/mip count/);
o.methods.set(0x1A04,0x12B29);o.methods.set(0x1A14,0x11010000);assert.throws(()=>texture.describe(o,0),/signed/);
const invalid={...t,dma:{...t.dma,limit:0x100F}};assert.throws(()=>texture.read(invalid),/limit/);
o.methods.set(0x1A04,0x30529);o.methods.set(0x1A18,4<<16|2);o.methods.set(0x1A10,0xAAE4);
o.methods.set(0x1A0C,0x80010000);o.methods.set(0x1A14,0x01050080);
for(let i=0;i<8;i++)vram.set([i+1,0,0,255],0x2000+i*4);
vram.set([21,0,0,255,22,0,0,255,31,0,0,255],0x2020);
t=texture.describe(o,0);const chain=texture.images(t);
assert.deepEqual(chain.map(bytes=>bytes.length),[32,8,4]);
assert.deepEqual(Array.from({length:8},(_,i)=>chain[0][i*4]),[1,2,5,6,3,4,7,8]);
assert.deepEqual([...chain[1]],[21,0,0,255,22,0,0,255]);assert.equal(chain[2][0],31);
assert.equal(t.mip,2);assert.equal(new Float32Array(Uint32Array.of(t.bias).buffer)[0],.5);
assert.throws(()=>texture.images({...t,dma:{...t.dma,limit:0x202A}}),/limit/,"all mip DMA is checked");
o.methods.set(0x1A04,0x32529);o.methods.set(0x1840,20);
vram.set([41,0,0,255,42,0,0,255],0x2028);vram.set([51,0,0,255],0x203C);
const linear=texture.images(texture.describe(o,0));assert.equal(linear[1][0],41);assert.equal(linear[2][0],51,"linear levels retain the base pitch");
o.methods.set(0x1A0C,0x80000080);assert.throws(()=>texture.describe(o,0),/fractional/);
// BC1 four-color indices and transparent mode; BC2 explicit alpha and BC3
// both alpha endpoint orderings, including selectors straddling byte borders.
o.methods.set(0x1A0C,0x80000000);o.methods.set(0x1A14,0x01010000);o.methods.set(0x1A18,4<<16|4);
o.methods.set(0x1A04,0x10629);o.methods.set(0x1A10,0xAA6C);
vram.set([0,0xF8,0x1F,0,0xE4,0xE4,0xE4,0xE4],0x2000);
let bc=texture.read(texture.describe(o,0));assert.deepEqual([...bc.subarray(0,16)],[255,0,0,255,0,0,255,255,170,0,85,255,85,0,170,255]);
vram.set([0,0,255,255,255,255,255,255],0x2000);
assert.deepEqual([...texture.read(texture.describe(o,0)).subarray(0,4)],[0,0,0,0]);
o.methods.set(0x1A04,0x10729);vram.set([0x10,0x32,0x54,0x76,0x98,0xBA,0xDC,0xFE,0,0xF8,0,0,0,0,0,0],0x2000);
bc=texture.read(texture.describe(o,0));assert.deepEqual(Array.from({length:16},(_,i)=>bc[i*4+3]),Array.from({length:16},(_,i)=>i*17));
o.methods.set(0x1A04,0x10829);
for(const endpoints of [[255,0],[0,255]])
{
    let selectors=0n;for(let i=0;i<16;i++)selectors|=BigInt(i%8)<<BigInt(i*3);
    vram.set([...endpoints,...Array.from({length:6},(_,i)=>Number(selectors>>BigInt(i*8)&255n)),0,0xF8,0,0,0,0,0,0],0x2000);
    bc=texture.read(texture.describe(o,0));
    const expected=endpoints[0]? [255,0,219,182,146,109,73,36]:[0,255,51,102,153,204,0,255];
    assert.deepEqual(Array.from({length:16},(_,i)=>bc[i*4+3]),Array.from({length:16},(_,i)=>expected[i%8]));
}
// Packed BC mip tails occupy one complete block each, with NPOT edge cropping.
o.methods.set(0x1A04,0x30629);o.methods.set(0x1A18,4<<16|4);o.methods.set(0x1A0C,0x80010000);
for(let i=0;i<3;i++)vram.set([0,0xF8,0,0,0,0,0,0],0x2000+i*8);
const bcChain=texture.images(texture.describe(o,0));assert.deepEqual(bcChain.map(x=>x.length),[64,16,4]);assert.equal(bcChain[2][0],255);
o.methods.set(0x1A04,0x10629);o.methods.set(0x1A18,3<<16|2);assert.equal(texture.read(texture.describe(o,0)).length,24);
assert.throws(()=>texture.read({...texture.describe(o,0),dma:{...t.dma,limit:0x2006}}),/limit/);
o.methods.set(0x1A04,0x13A29);o.methods.set(0x1A18,1<<16|1);o.methods.set(0x1840,8);o.methods.set(0x1A10,0xAAE4);
new Uint16Array(vram.buffer,0x2000,4).set([0x4000,0xBC00,0x3800,0x3400]);
const fp16=texture.describe(o,0);assert.equal(fp16.d3d,113);assert.equal(fp16.upload_bpp,8);
assert.deepEqual([...new Uint16Array(texture.read(fp16).buffer)],[0x4000,0xBC00,0x3800,0x3400],"FP16 preserves HDR, negative channels and exact half bits");
o.methods.set(0x1A10,0xAA6C);assert.deepEqual([...new Uint16Array(texture.read(texture.describe(o,0)).buffer)],
    [0x3800,0xBC00,0x4000,0x3400],"FP16 component crossbar");
// Each packed cube face carries its complete mip chain and starts on a
// 128-byte boundary. A clamped upload must not move the following faces.
o.methods.set(0x1A04,0x3052D);o.methods.set(0x1A18,4<<16|4);o.methods.set(0x1A10,0xAAE4);o.methods.set(0x1A0C,0x80010000);
for(let face=0;face<6;face++)
{
    for(const [offset,count,red]of [[0,16,10+face],[64,4,30+face],[80,1,50+face]])
        for(let pixel=0;pixel<count;pixel++)vram.set([red,0,0,255],0x2000+face*128+offset+pixel*4);
}
const cube=texture.describe(o,0);assert.equal(cube.cube,true);
assert.deepEqual(texture.images(cube).map(bytes=>bytes[0]),Array.from({length:6},(_,face)=>[10+face,30+face,50+face]).flat());
o.methods.set(0x1A0C,0x80000000);
assert.deepEqual(texture.images(texture.describe(o,0)).map(bytes=>bytes[0]),Array.from({length:6},(_,face)=>10+face),"LOD clamp retains full face strides");
assert.throws(()=>texture.images({...cube,dma:{...cube.dma,limit:0x2000+5*128+82}}),/limit/,"last face mip is checked before any upload");
o.methods.set(0x1A04,0x3252D);o.methods.set(0x1840,16);o.methods.set(0x1A0C,0x80010000);
for(let face=0;face<6;face++)for(const [offset,red]of [[0,70+face],[64,90+face],[96,110+face]])vram.set([red,0,0,255],0x2000+face*112+offset);
assert.deepEqual(texture.images(texture.describe(o,0)).map(bytes=>bytes[0]),Array.from({length:6},(_,face)=>[70+face,90+face,110+face]).flat(),"uniform-pitch cube faces are not padded");
o.methods.set(0x1A18,4<<16|2);assert.throws(()=>texture.describe(o,0),/square/);
// Three-axis Morton order interleaves only the remaining dimension bits.
o.methods.set(0x1A04,0x30539);o.methods.set(0x1A18,4<<16|2);o.methods.set(0x1840,2<<20);
for(let z=0;z<2;z++)for(let y=0;y<2;y++)for(let x=0;x<4;x++)
{
    const index=(x&1)|(y<<1)|(z<<2)|(x&2)<<2;
    vram.set([(z*2+y)*4+x+1,0,0,255],0x2000+index*4);
}
vram.set([21,0,0,255,22,0,0,255,31,0,0,255],0x2040);
const volume=texture.describe(o,0),volumeImages=texture.images(volume);
assert.equal(volume.volume,true);assert.equal(volume.depth,2);
assert.deepEqual(Array.from({length:16},(_,i)=>volumeImages[0][i*4]),Array.from({length:16},(_,i)=>i+1));
assert.deepEqual(volumeImages.map(image=>image.length),[64,8,4]);assert.equal(volumeImages[1][0],21);assert.equal(volumeImages[2][0],31);
assert.throws(()=>texture.images({...volume,dma:{...volume.dma,limit:0x204A}}),/limit/);
o.methods.set(0x1A04,0x32539);o.methods.set(0x1840,2<<20|20);
for(let row=0;row<4;row++)for(let x=0;x<4;x++)vram.set([row*4+x+1,0,0,255],0x2000+row*20+x*4);
vram.set([21,0,0,255,22,0,0,255],0x2050);vram.set([31,0,0,255],0x2064);
const volumeLinear=texture.images(texture.describe(o,0));assert.deepEqual(volumeLinear.map(image=>image[0]),[1,21,31]);
assert.deepEqual(Array.from({length:16},(_,i)=>volumeLinear[0][i*4]),Array.from({length:16},(_,i)=>i+1),"linear volume slice and row pitches");
o.methods.set(0x1840,0);assert.throws(()=>texture.describe(o,0),/volume.*dimensions/);
assert.throws(()=>texture.storage({...volume,width:128,height:128,depth:128,u:7,v:7,w:7,bpp:1}),/upload budget/,"expanded payload is bounded before allocating volume storage");
console.log("PASS: NV40 linear/Morton texture DMA, storage swizzles, RGB565/L8/A8L8 and unsupported-state faults");
