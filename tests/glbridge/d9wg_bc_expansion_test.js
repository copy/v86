"use strict";
const assert = require("node:assert/strict");
const F = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_formats.js");
let pixels = 0;
// Independent BigInt selector packing and direct per-code interpolation.
// Covers every bit position, both endpoint orders, padded rows/slices and edges.
for (const channels of [1, 2]) for (let width = 1; width <= 9; width++)
for (let height = 1; height <= 9; height++) for (const depth of [1, 2]) {
    const format = channels === 1 ? F.D3DFMT_ATI1N : F.D3DFMT_ATI2N;
    assert.equal(F.atiNeedsExpansion(format,width,height),!!((width|height)&3));
    const columns=Math.ceil(width/4),rows=Math.ceil(height/4),pitch=columns*channels*8+8,slice=pitch*rows+16;
    const input=new Uint8Array(slice*depth),expected=new Uint8Array(width*height*depth*4);
    for(let z=0;z<depth;z++)for(let y=0;y<rows;y++)for(let x=0;x<columns;x++)for(let c=0;c<channels;c++) {
        const a=(width*29+x*33+c*151+z*64)&255,b=(height*31+y*67+c*77)&255;
        const start=z*slice+y*pitch+x*channels*8+c*8;input[start]=a;input[start+1]=b;
        let packed=0n;
        for(let k=0;k<16;k++) {
            const code=(k+x+y+z+c)&7;packed|=BigInt(code)<<BigInt(k*3);
            const xx=x*4+k%4,yy=y*4+Math.floor(k/4);
            if(xx>=width||yy>=height)continue;
            const value=code===0?a:code===1?b:a>b?((8-code)*a+(code-1)*b)/7
                :code<6?((6-code)*a+(code-1)*b)/5:code===6?0:255;
            const to=((z*height+yy)*width+xx)*4;expected[to+c]=Math.round(value);expected[to+3]=255;
        }
        for(let byte=0;byte<6;byte++)input[start+2+byte]=Number((packed>>BigInt(byte*8))&255n);
    }
    assert.deepEqual(F.expandATIBlocks(format,input,width,height,depth,pitch,slice),expected);
    pixels+=width*height*depth;
    assert.throws(()=>F.expandATIBlocks(format,input.subarray(0,1),width,height,depth,pitch,slice));
    assert.throws(()=>F.expandATIBlocks(format,input,width,height,depth,1,slice));
}
assert(!F.atiNeedsExpansion(F.D3DFMT_A8R8G8B8,7,5));
assert.throws(()=>F.expandATIBlocks(21,new Uint8Array(16),1,1,1,8,8));
console.log(`PASS ATI block expansion: ${pixels} pixels, BC4/BC5 selectors, endpoint orders, odd edges, rows/slices and malformed extents`);

// Compare padded/layered DXT input against the separately exercised OpenGL
// decoder's tightly packed input, and pin transparent/opaque BC1 contracts.
const {decodeDXT}=require("../../src/browser/glbridge/gl-webgpu/gl_executor.js");
let random=0x482015ad,dxtPixels=0;
const byte=()=>{random^=random<<13;random^=random>>>17;random^=random<<5;return random&255;};
for(let dxt=1;dxt<=5;dxt++)for(let w=1;w<=9;w++)for(let h=1;h<=9;h++)for(const depth of [1,2]) {
    const format=F['D3DFMT_DXT'+dxt],columns=Math.ceil(w/4),rows=Math.ceil(h/4),size=dxt===1?8:16;
    const pitch=columns*size+8,slice=pitch*rows+16,source=Uint8Array.from({length:slice*depth},byte);
    const expected=new Uint8Array(w*h*depth*4);
    for(let z=0;z<depth;z++) {
        const tight=new Uint8Array(columns*size*rows);
        for(let row=0;row<rows;row++)tight.set(source.subarray(z*slice+row*pitch,z*slice+row*pitch+columns*size),row*columns*size);
        expected.set(decodeDXT(dxt===2?3:dxt===4?5:dxt,tight,w,h),z*w*h*4);
    }
    assert.deepEqual(F.expandBCBlocks(format,source,w,h,depth,pitch,slice),expected);
    assert.equal(F.bcNeedsExpansion(format,w,h),!!((w|h)&3));
    assert.throws(()=>F.expandBCBlocks(format,source.subarray(0,1),w,h,depth,pitch,slice));
    dxtPixels+=w*h*depth;
}
assert.deepEqual([...F.expandBCBlocks(F.D3DFMT_DXT1,Uint8Array.of(0,0,0,248,255,255,255,255),1,1,1,8,8)],[0,0,0,0]);
assert.deepEqual([...F.expandBCBlocks(F.D3DFMT_DXT1,Uint8Array.of(0,248,0,0,0,0,0,0),1,1,1,8,8)],[255,0,0,255]);
console.log(`PASS DXT expansion: ${dxtPixels} pixels, DXT1-5, independent row/slice packing and pinned BC1 alpha contracts`);
