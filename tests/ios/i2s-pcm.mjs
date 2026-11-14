import assert from "node:assert/strict";
import { AppleCDMA } from "../../src/apple/cdma.js";
import { AppleI2S } from "../../src/apple/audio.js";

let now = 0;
const mem8 = new Uint8Array(65536), events = [], signals = [], ports = new Map();
const cpu = {
    mem8, clock:{now:()=>now}, devices:{apple_timer:{regs:new Uint32Array(0x6000/4)}},
    io:{register_mmio:(base,size,port)=>ports.set(base,port)},
    ram_offset:(at,n)=>at>=0x40000000&&at+n<=0x40010000?at-0x40000000:-1,
    read_blob_physical:(at,n)=>mem8.slice(at-0x40000000,at-0x40000000+n),
};
const dma = new AppleCDMA(cpu,(n,level)=>signals.push([n,level]));
const i2s = new AppleI2S(cpu,0,{send:(name,value)=>events.push([name,value])},dma);
const v = new DataView(mem8.buffer), count = 441 * 4;
[0,0x103,0x40001000,count].forEach((w,i)=>v.setUint32(0x100+4*i,w,true));
for(let i=0;i<441;i++){v.setInt16(0x1000+4*i,8192,true);v.setInt16(0x1002+4*i,-16384,true);}
cpu.devices.apple_timer.regs[0x104/4]=44100*64;
i2s.write(0,1);
const base=26*4096;
dma.write(base+8,0x84500410);dma.write(base+12,count);dma.write(base+20,0x40000100);dma.write(base,0x19);
i2s.poll();assert.equal(i2s.frames,0,'PCM cannot play without elapsed hardware time');
now=5;i2s.poll();
assert.equal(i2s.frames,220);assert.equal(dma.channel[26*8+3],count-220*4);
assert.equal(dma.channel[26*8+4],0x40001000+220*4,'native position follows actual consumed PCM');
assert.equal(dma.channel[26*8+5],0x40000100);
assert.equal(signals.some(([,on])=>on),false,'no early completion');
now=10;i2s.poll();
assert.equal(i2s.frames,441);assert.ok(dma.channel[26*8]&0x80000);
const data=events.filter(([name])=>name==='dac-send-data');
assert.equal(data.reduce((n,[,channels])=>n+channels[0].length,0),441);
assert.equal(data[0][1][0][0],0.25);assert.equal(data[0][1][1][0],-0.5);
assert.ok(signals.some(([n,on])=>n===26&&on));
console.log('PASS: native-clock-paced I2S PCM, live DMA cursor, stereo samples and ordered completion');
