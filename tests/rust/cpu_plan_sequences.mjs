import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../build/libv86.mjs";
import { COMPILED_ARMS, compiled_activations } from "./compiled_arms.mjs";

// cpu_plan_sequences.mjs [baseline.wasm] [candidate.wasm]: machine 0 is the
// interpreter (or, with arguments, the baseline core); the candidate core runs
// every sequence once per IR arm (the page tier and regions) and must match it.
const candidate = process.argv[3] || "build/v86.wasm";
const baseline = process.argv[2] || candidate;
const bios = Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const CODE = 0x100000, DATA = 0x200000, OUT = 0x210000;
const machines = [], labels = [];
const word = (vm, a) => new DataView(Uint8Array.from(vm.read_memory(a, 4)).buffer).getUint32(0, true);
const data = Uint8Array.from({ length: 8192 }, (_, i) => (i * 37 ^ i >> 3) & 255);
const programs = [];
const oracles = new Map();
for(const mmx of [false, true]) {
    const prefix = mmx ? [] : [0x66];
    for(let seed = 0; seed < 16; seed++) {
        const p = [0xDB, 0xE3];
        for(let r = 0; r < 8; r++) p.push(...(mmx ? [] : [0xF3]), 0x0F, 0x6F, 5 | r << 3, ...u32(DATA + r * 16));
        // Consecutive cached destinations, source aliases, shifts reading a
        // cached count, old custom logic emitters, and MMX custom emitters.
        const ops = [0xFC,0xD5,0xE4,0xF6,0xDB,0xDF,0xEB,0xEF,0xF5,0xFE,0xD1,0xF3];
        for(let i = 0; i < 96; i++) {
            p.push(...prefix, 0x0F, ops[(i + seed) % ops.length], 0xC0 | (i & 7) << 3 | ((i + seed) & 7));
            // Memory, float/helper and group boundaries must flush all values.
            if(i % 19 === 18) p.push(...(mmx ? [] : [0xF3]), 0x0F, 0x6F, 0x05, ...u32(DATA + i));
            if(i % 23 === 22) p.push(...prefix, 0x0F, 0x71, 0xD0, seed);
        }
        for(let r = 0; r < 8; r++) p.push(...(mmx ? [] : [0xF3]), 0x0F, 0x7F, 5 | r << 3, ...u32(OUT + r * 16));
        if(mmx) p.push(0xD9, 0x05, ...u32(DATA), 0xDD, 0x35, ...u32(OUT + 128)); // x87 observer/FNSAVE
        programs.push([`cached ${mmx ? "MMX" : "XMM"} sequence ${seed}`, p]);
    }
}
for(const prefix of [[], [0x66], [0xF2], [0xF3]]) for(let seed = 0; seed < 8; seed++) {
    const p = [];
    for(let r = 0; r < 8; r++) p.push(0xF3, 0x0F, 0x6F, 5 | r << 3, ...u32(DATA + r * 16));
    for(let i = 0; i < 64; i++) {
        p.push(...prefix, 0x0F, [0x58,0x59,0x5C,0x5D,0x5E,0x5F,0x51][i % 7], 0xC0 | (i & 7) << 3 | ((i + seed) & 7));
        if(i % 11 === 10) p.push(0x66, 0x0F, 0xEF, 0xC1);
    }
    for(let r = 0; r < 8; r++) p.push(0xF3, 0x0F, 0x7F, 5 | r << 3, ...u32(OUT + r * 16));
    programs.push([`floating cache prefix=${prefix} aliases=${seed}`, p]);
}
const bits = new DataView(data.buffer);
for(const [i, v] of [0n, 0x8000000000000000n, 0x7FF0000000000000n, 0x7FF123456789ABCDn,
    0x3FF0000000000000n, 0x7FC123457F812345n, 0x3F800000BF800000n, 1n].entries()) bits.setBigUint64(i * 16, v, true);
for(let pc = 0; pc < 3; pc++) for(let rc = 0; rc < 4; rc++) {
    const control = [0,2,3][pc] << 8 | rc << 10 | 0x3F;
    bits.setUint16(7800 + (pc * 4 + rc) * 2,control,true);
    const p = [0xDB,0xE3,0xD9,0x2D,...u32(DATA+7800+(pc*4+rc)*2)];
    for(const [i, exponent] of [-1023,-1022,-1.75,0,1.75,1023,1024].entries()) {
        bits.setFloat64(2000+i*16,1.23456789,true);
        bits.setFloat64(2008+i*16,exponent,true);
        p.push(0xDD,0x05,...u32(DATA+2008+i*16),0xDD,0x05,...u32(DATA+2000+i*16),
            0xD9,0xFD,0xDB,0x3D,...u32(OUT+i*32),0xDB,0x3D,...u32(OUT+i*32+16));
    }
    p.push(0xDF,0xE0,0xA3,...u32(OUT+256));
    programs.push([`FSCALE pc=${pc} rc=${rc}`,p]);
}
// Exercise both FST and FSTP through the JIT, with exact values, rounding,
// signed zero, subnormal, overflow and NaN cases under every x87 control mode.
const doubles = [0n, 0x8000000000000000n, 1n, 0xFFFFFFFFFFFFFn, 0x10000000000000n,
    0x3FF3C0CA4283DE1Bn, 0xBFF3C0CA4283DE1Bn, 0x7FEFFFFFFFFFFFFFn,
    0xFFEFFFFFFFFFFFFFn, 0x7FF0000000000000n, 0x7FF0000000000001n, 0x7FF8123456789ABCn];
const wide_stores = [[0x8000000000000000n,0x3C01], [0xFFFFFFFFFFFFF800n,0x43FE],
    [0x8000000000000400n,0x3FFF], [0x8000000000000C00n,0xBFFF],
    [0xFFFFFFFFFFFFFFFFn,0x43FE], [0x8000000000000001n,0x3C00],
    [0x8000000000000000n,0x7FFF], [0x8000000000000001n,0x7FFF]];
for(const [i,value] of doubles.entries()) bits.setBigUint64(3000+i*16,value,true);
for(const [i,[mantissa,exponent]] of wide_stores.entries()) {
    bits.setBigUint64(3400+i*16,mantissa,true); bits.setUint16(3408+i*16,exponent,true);
}
for(let pc = 0; pc < 3; pc++) for(let rc = 0; rc < 4; rc++) {
    const p = [0xDB,0xE3,0xD9,0x2D,...u32(DATA+7800+(pc*4+rc)*2)];
    // FNINIT marks registers empty without erasing their old payloads. Seed
    // all eight slots so FNSAVE is independent of earlier benchmark programs.
    p.unshift(0xDB,0xE3,...Array.from({ length: 8 }, () => [0xD9,0xEE]).flat());
    for(let i = 0; i < doubles.length + wide_stores.length; i++) {
        p.push(...(i < doubles.length ? [0xDD,0x05,...u32(DATA+3000+i*16)] :
            [0xDB,0x2D,...u32(DATA+3400+(i-doubles.length)*16)]),
        0xDD,0x15,...u32(OUT+i*32), 0xDD,0x3D,...u32(OUT+i*32+8),
        0xDD,0x1D,...u32(OUT+i*32+16), 0xDD,0x3D,...u32(OUT+i*32+24));
    }
    p.push(0xDD,0x35,...u32(OUT+4096));
    programs.push([`binary64 stores pc=${pc} rc=${rc}`,p]);
}
for(const prefix of [0xF3,0xF2,0]) for(let seed=0;seed<8;seed++) {
    const p=[];
    for(let r=0;r<8;r++) p.push(0x0F,0x10,5|r<<3,...u32(DATA+r*16));
    for(let i=0;i<64;i++) {
        p.push(prefix || (i&1 ? 0xF3 : 0xF2),0x0F,[0x58,0x59,0x5C,0x5D,0x5E,0x5F,0x51][i%7],
            0xC0|(i&7)<<3|((i+seed)&7));
        if(i%11 === 10) p.push(0x0F,0x11,5|(i&7)<<3,...u32(OUT+i*16));
        if(i%19 === 18) p.push(0x66,0x0F,0xEF,0xC1);
    }
    for(let r=0;r<8;r++) p.push(0x0F,0x11,5|r<<3,...u32(OUT+2048+r*16));
    programs.push([`scalar lane cache prefix=${prefix} aliases=${seed}`,p]);
}
for(const xor of [false,true]) for(const count of [1,7,8,9,128,129,1024])
for(const start of [0,1,4093]) for(const [dest,counter,value] of [[6,1,0],[3,7,2],[0,2,1]]) {
    const p=[0xFC,0xBE,...u32(DATA),0xBF,...u32(OUT),0xB9,...u32(2048),0xF3,0xA5,
        0xB8+dest,...u32(OUT+start),0xB8+counter,...u32(count),0xB8+value,...u32(0x87654321),
        xor ? 0x31 : 0x01,value<<3|dest,0x83,0xC0|dest,4,0x48|counter,0x75,0xF8];
    for(let reg=0;reg<8;reg++) p.push(0x89,5|reg<<3,...u32(OUT+8120+reg*4));
    p.push(0x9C,0x58,0xA3,...u32(OUT+8152));
    programs.push([`bulk RMW xor=${xor} count=${count} start=${start} regs=${dest},${counter},${value}`,p]);
}
for(const size of [1,4]) for(const count of [17,257]) for(const start of [1,4093])
for(const [source,dest,counter,temp] of [[6,7,3,1],[3,6,7,0],[0,7,6,2]]) {
    const p=[0xB8+source,...u32(DATA+start),0xB8+dest,...u32(OUT+start),0xB8+counter,...u32(count)];
    p.push(size === 1 ? 0x8A : 0x8B,temp<<3|source,size === 1 ? 0x88 : 0x89,temp<<3|dest,
        ...(size === 1 ? [0x40|source,0x40|dest] : [0x83,0xC0|source,4,0x83,0xC0|dest,4]),
        0x48|counter,0x75,size === 1 ? 0xF7 : 0xF3);
    p.push(0x89,5|counter<<3,...u32(OUT+8100),0x89,5|dest<<3,...u32(OUT+8104));
    programs.push([`bulk copy allocation size=${size} count=${count} start=${start} regs=${source},${dest},${counter},${temp}`,p]);
}
for(const kind of ["mul16","imul16","div16","idiv16","idiv32","xadd16","cmpxchg16"])
for(const r of [0,1,2,3,5,6,7]) for(const value of [1,17,1234]) {
    if(r === 2 && kind.includes("div")) continue;
    // MUL/DIV leave some flags undefined/preserved. Seed both VMs identically
    // instead of inheriting flags from whichever previous loop was stopped.
    const p=[0x31,0xFF,0x83,0xC7,0];
    for(const reg of [0,1,2,3,5,6,7]) p.push(0xB8+reg,...u32(
        reg === 2 ? kind === "idiv32" ? 0 : 0xABCD0000 : reg === 0 ? value : 0x12340011));
    if(kind === "idiv32") p.push(0xF7,0xF8|r);
    else if(kind === "xadd16" || kind === "cmpxchg16") p.push(0x66,0x0F,kind === "xadd16" ? 0xC1 : 0xB1,0xC3|r<<3);
    else p.push(0x66,0xF7,0xC0|(["mul16","imul16","div16","idiv16"].indexOf(kind)+4)<<3|r);
    for(let reg=0;reg<8;reg++) p.push(0x89,5|reg<<3,...u32(OUT+reg*4));
    p.push(0x9C,0x58,0xA3,...u32(OUT+32));
    programs.push([`helper effects ${kind} r=${r} value=${value}`,p]);
}
for(const start of [0,1,4080,4093,4095]) for(const gap of [
    [0x01,0xD8], [0x83,0xC3,1], [0x40], [0x49], [0xB9,...u32(123),0x90],
    [0x8D,0x48,4,0x31,0xC9], [0x39,0xC8,0x85,0xC0],
    [0x83,0xC6,4], [0xBE,...u32(DATA+4096)], [0x66,0xBE,0,0],
    [0xC7,0x46,4,...u32(0xABCDEF)], [0x50,0x59], Array(9).fill(0x90)]) {
    const p=[0xBE,...u32(DATA+start),0xBB,...u32(17),0xB9,...u32(9),0x8B,0x06,
        ...gap,0x8B,0x56,4,0x8B,0x5E,8,0x9C,0x59];
    for(const [i,r] of [0,1,2,3,6].entries()) p.push(0x89,5|r<<3,...u32(OUT+i*4));
    programs.push([`RAM read gaps start=${start} gap=${gap}`,p]);
}
for(const size of [1,4]) for(const count of [1,7,8,9,31,128,129,1024])
for(const start of [0,1,3967,4093]) for(const overlap of [null,0,1,-1]) {
    const source = overlap === null ? DATA+start : OUT+1024;
    const dest = overlap === null ? OUT+start : source+overlap;
    const p=[0xFC,0xBE,...u32(DATA),0xBF,...u32(OUT),0xB9,...u32(2048),0xF3,0xA5,
        0xB8,...u32(0x87654321),0xBE,...u32(source),0xBF,...u32(dest),0xB9,...u32(count),0xF9];
    p.push(...(size === 1 ? [0x8A,0x06,0x88,0x07,0x46,0x47,0x49,0x75,0xF7] :
        [0x8B,0x06,0x89,0x07,0x83,0xC6,4,0x83,0xC7,4,0x49,0x75,0xF3]));
    p.push(0x9C,0x5A);
    for(const [i,r] of [0,1,2,6,7].entries()) p.push(0x89,5|r<<3,...u32(OUT+8100+i*4));
    programs.push([`ordinary copy size=${size} count=${count} start=${start} overlap=${overlap}`,p]);
}
for(const size of [1,4]) {
    const p=[0xFC,0xBE,...u32(DATA),0xBF,...u32(0x101100),0xB9,...u32(512),0xF3,0xA4,
        0xBE,...u32(0x101100),0xBF,...u32(0x801101),0xB9,...u32(64)];
    p.push(...(size === 1 ? [0x8A,0x06,0x88,0x07,0x46,0x47,0x49,0x75,0xF7] :
        [0x8B,0x06,0x89,0x07,0x83,0xC6,4,0x83,0xC7,4,0x49,0x75,0xF3]));
    p.push(0xBE,...u32(0x101100),0xBF,...u32(OUT),0xB9,...u32(512),0xF3,0xA4);
    programs.push([`ordinary copy physical alias size=${size}`,p]);
}
for(const start of [0, 1, 3968, 4092, 4093, 4095, 4096]) for(const immediate of [false, true]) {
    const p = [0xBE,...u32(OUT+start),0xB8,...u32(0x12345678)];
    for(let i=0;i<24;i++) {
        const size = [1,2,4][i%3];
        p.push(...(size === 2 ? [0x66] : []), immediate ? size === 1 ? 0xC6 : 0xC7 : size === 1 ? 0x88 : 0x89,
            0x46, i*4, ...(immediate ? size === 1 ? [i] : size === 2 ? [i,0xAB] : u32(0xABCDEF00+i) : []));
    }
    programs.push([`RAM writes start=${start} immediate=${immediate}`,p]);
}
for(const gap of [[0x46], [0x66,0xBE,0xFC,0x0F], [0x8B,0x06], [0xFF,0x06]]) {
    const p=[0xBE,...u32(OUT),0xB8,...u32(0x12345678),0x89,0x06,0x89,0x46,4,...gap,0x89,0x46,8,0x89,0x46,12];
    programs.push([`RAM write barrier ${gap}`,p]);
}
for(const size of [2, 4]) for(const backward of [false, true])
for(const start of [512, 513, 4092, 4093, 4095, 4096])
for(const count of [0, 1, 3, 7, 8, 17, 64]) for(const value of [0, 0xFFFFFFFF, 0x12345678, 0xAAAA5555]) {
    const p = [0xB8, ...u32(value), 0xB9, ...u32(count), 0xBF, ...u32(OUT + start),
        backward ? 0xFD : 0xFC, 0xF9, 0xF3, ...(size === 2 ? [0x66] : []), 0xAB,
        0x89, 0x0D, ...u32(OUT + 8000), 0x89, 0x3D, ...u32(OUT + 8004),
        0x9C, 0x5A, 0x89, 0x15, ...u32(OUT + 8008), 0xFC];
    const name=`memory fill size=${size} backward=${backward} start=${start} count=${count} value=${value}`;
    programs.push([name,p]);
    oracles.set(name,result => {
        const expected=new Uint8Array(8000);
        for(let i=0;i<count;i++) for(let j=0;j<size;j++)
            expected[start+(backward ? -i : i)*size+j]=value >>> (j*8)&255;
        assert.deepEqual(result.slice(0,8000),expected,name+" independent fill bytes");
        const view=new DataView(result.buffer,result.byteOffset,result.byteLength);
        assert.equal(view.getUint32(8000,true),0,name+" final count");
        assert.equal(view.getUint32(8004,true),OUT+start+(backward ? -count : count)*size,name+" final EDI");
        assert.equal(view.getUint32(8008,true)&0x401,(backward ? 0x400 : 0)|1,name+" CF/DF preserved");
    });
}
for(const start of [0, 1, 4080, 4093, 4095]) {
    for(const indexed of [false, true]) {
        const p = [0xBE, ...u32(DATA + start), 0xBF, ...u32(0)];
        for(let r = 0; r < 4; r++) p.push(0x8B,
            (indexed ? 0x84 : 0x86) | r << 3, ...(indexed ? [0xBE] : []), ...u32(r * 4));
        for(let r = 0; r < 4; r++) p.push(0x89, 5 | r << 3, ...u32(OUT + r * 4));
        programs.push([`relative RAM reads offset=${start} indexed=${indexed}`, p]);
    }
    const p = [0xBE, ...u32(DATA + start), 0xB9, ...u32(0xFEDC0000),
        0x0F, 0xBE, 0x06, // movsx eax,byte [esi]
        0x0F, 0xBF, 0x5E, 1, // movsx ebx,word [esi+1]
        0x66, 0x8B, 0x4E, 3, // mov cx,[esi+3]
        0x0F, 0xB7, 0x56, 5, // movzx edx,word [esi+5]
        0x8A, 0x66, 7]; // mov ah,[esi+7]
    for(let r = 0; r < 4; r++) p.push(0x89, 5 | r << 3, ...u32(OUT + r * 4));
    programs.push([`mixed-width RAM reads offset=${start}`, p]);
}
for(const gap of [4, 4096]) {
    const p = [0xBE, ...u32(DATA), 0x8B, 0x06, 0x8B, 0x9E, ...u32(gap),
        0xC7, 0x06, ...u32(0x12345678), // store must end the cache region
        0x8B, 0x0E, 0x8B, 0x56, 4];
    for(let r = 0; r < 4; r++) p.push(0x89, 5 | r << 3, ...u32(OUT + r * 4));
    programs.push([`RAM cache store barrier gap=${gap}`, p]);
}
{
    const p = [0xC7, 0x05, ...u32(DATA), ...u32(DATA + 4096),
        0xBE, ...u32(DATA), 0x8B, 0x36, 0x8B, 0x06, 0x8B, 0x5E, 4,
        0xA3, ...u32(OUT), 0x89, 0x1D, ...u32(OUT + 4)];
    programs.push(["RAM read changes base register/page", p]);
}
{
    const p = [0xB8, ...u32(DATA + 1), 0x8A, 0x00, // mov al,[eax] changes the base
        0x8B, 0x58, 4, 0x8B, 0x48, 8,
        0x89, 0x1D, ...u32(OUT), 0x89, 0x0D, ...u32(OUT + 4)];
    programs.push(["RAM read overwrites partial base register", p]);
}
for(const start of [0, 1, 4080, 4093, 4095]) {
    const p = [];
    for(let r = 0; r < 4; r++) p.push(0x8B, 5 | r << 3, ...u32(DATA + start + r * 4));
    for(let r = 0; r < 4; r++) p.push(0x89, 5 | r << 3, ...u32(OUT + r * 4));
    // A write ends the translation region and must be visible on the next read.
    p.push(0xA1, ...u32(DATA), 0xC7, 0x05, ...u32(DATA + 4), ...u32(0xABCD1234), 0xA1, ...u32(DATA + 4), 0xA3, ...u32(OUT + 16));
    programs.push([`RAM translation, offset ${start}`, p]);
}
for(const first of [[0x05, ...u32(1)], [0x2D, ...u32(1)], [0x3D, ...u32(1)],
    [0x83, 0xC0, 1], [0x83, 0xE8, 1], [0x83, 0xF8, 1], [0x21, 0xD8], [0x09, 0xD8], [0x31, 0xD8], [0x85, 0xD8]]) {
    for(const barrier of [[], [0xB9,...u32(7),0x89,0xDA,0x90], [0x9C,0x59], [0x83,0xD0,0], [0x40], [0xD3,0xE0]]) {
        const p = [0xB8,...u32(0xFFFFFFFF),0xBB,...u32(1),0xB9,...u32(0),0xBA,...u32(0),
            ...first,...barrier,0x29,0xD8,0xA3,...u32(OUT),0x89,0x0D,...u32(OUT+4),0x9C,0x58,0xA3,...u32(OUT+8)];
        programs.push([`flags opcode=${first} barrier=${barrier}`,p]);
    }
}
for(const width of [1, 2, 4]) for(const backward of [false, true]) for(const distance of [1, 2, 3, 16, 127]) {
    const source = 0x220000 + (backward ? 4200 : 4000);
    const dest = source + (backward ? -distance : distance);
    const p = [0xFC, 0xBE, ...u32(DATA), 0xBF, ...u32(0x220000), 0xB9, ...u32(8192), 0xF3, 0xA4,
        backward ? 0xFD : 0xFC, 0xBE, ...u32(source), 0xBF, ...u32(dest), 0xB9, ...u32(64),
        ...(width === 2 ? [0x66] : []), 0xF3, width === 1 ? 0xA4 : 0xA5,
        0x89, 0x0D, ...u32(OUT + 8000), 0x89, 0x35, ...u32(OUT + 8004), 0x89, 0x3D, ...u32(OUT + 8008),
        0xFC, 0xBE, ...u32(0x220000 + 3600), 0xBF, ...u32(OUT), 0xB9, ...u32(1024), 0xF3, 0xA4];
    programs.push([`ordered REP width=${width} backward=${backward} distance=${distance}`, p]);
}
for(const producer of [[0x39,0xD8],[0x85,0xD8],[0x30,0xD8],[0x00,0xF8],[0x28,0xFC],
    [0x66,0x39,0xD8],[0x66,0x85,0xD8],[0x80,0xFC,0x80],[0xF6,0xC4,0x80]])
for(const branch of [false,true]) for(const value of [0,0x80000080,0x7FFFFF7F]) {
    const p=[0xB8,...u32(value),0xBB,...u32(0xFF),0xBE,...u32(DATA)];
    for(let i=0;i<16;i++) {
        p.push(...producer,...(branch?[0xEB,0]:[]),0x8B,0x56,i*4,
            0x9C,0x59,0x89,0x0D,...u32(OUT+i*8),0xA3,...u32(OUT+i*8+4));
    }
    programs.push([`expanded flags ${producer} branch=${branch} value=${value}`,p]);
}
for(const offset of [0,1,2,4000,4093,4095]) for(const count of [2,16,40]) {
    const p=[0x89,0xE7,0xBC,...u32(DATA+4096+offset),0xB8,...u32(0x87654321)];
    for(let i=0;i<count;i++) p.push(0x50,0x8D,0x40,1);
    for(let i=0;i<count;i++) p.push(0x58,0xA3,...u32(OUT+i*4));
    p.push(0x89,0xFC);
    programs.push([`stack cache offset=${offset} count=${count}`,p]);
}
for(const opcode of [0x00,0x01,0x09,0x21,0x29,0x31,0xFE,0xFF])
for(const offset of [0,1,3968,4093,4095]) {
    const p=[0xBE,...u32(DATA+offset),0xB8,...u32(0x87654321)];
    // Initialize in the guest so repetitions remain deterministic.
    for(let i=0;i<32;i++) p.push(0xC7,0x46,i*4,...u32(i*0x1234567));
    for(let i=0;i<32;i++) p.push(opcode,0x46,i*4);
    p.push(0x9C,0x58,0xA3,...u32(OUT+256));
    for(let i=0;i<32;i++) p.push(0x8B,0x46,i*4,0xA3,...u32(OUT+i*4));
    programs.push([`rmw cache opcode=${opcode} offset=${offset}`,p]);
}
for(const padding of [0,3,17]) for(const near of [false,true]) {
    const p=[0xB8,...u32(0x7FFFFFFF),0xBB,...u32(1)];
    for(let i=0;i<8;i++) {
        p.push(0x01,0xD8,...(near?[0xE9,...u32(padding)]:[0xEB,padding]));
        for(let j=0;j<padding;j++) p.push(0xF4); // skipped bytes must never execute
        p.push(0x89,0xC2,0x9C,0x59,0x89,0x0D,...u32(OUT+i*4));
    }
    // CALL next / POP is an instruction-pointer idiom, not a removable JMP.
    p.push(0xE8,0,0,0,0,0x58,0xA3,...u32(OUT+128));
    programs.push([`linear region near=${near} padding=${padding}`,p]);
}
// Two instruction streams can overlap inside a MOV immediate and converge at
// the same indirect JMP. The target cache must own one set of locals per site.
for(const taken of [false, true]) for(const offset of [1, 2, 3, 4]) {
    const p = [0xBA, ...u32(CODE + 19), 0x31, 0xC0,
        0x83, 0xF8, taken ? 1 : 0, 0x75, offset,
        0xB8, 0x90, 0x90, 0x90, 0x90, 0xFF, 0xE2,
        0xA3, ...u32(OUT)];
    const name = `overlapping indirect site taken=${taken} offset=${offset}`;
    programs.push([name, p]);
    oracles.set(name, result => assert.equal(new DataView(result.buffer).getUint32(0, true),
        taken ? 0 : 0x90909090, name));
}
try {
    for(const [label, wasm_path, options] of [
        [process.argv[2] ? baseline : "interpreter", baseline, process.argv[2] ? {} : { disable_jit: true }],
        ...COMPILED_ARMS.map(arm => [arm.label, candidate, arm.options])]) {
        const vm = new V86({ graphics_adapter: "bochs_vga", wasm_path, bios: { buffer: bios.slice(0) }, memory_size: 32 << 20,
            ...options, disable_keyboard: true, disable_mouse: true, disable_speaker: true,
            net_device: { type: "none" }, autostart: false });
        machines.push(vm); labels.push(label);
        await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
        vm.run();
        const deadline = performance.now() + 10000;
        while(word(vm, 0x500) !== 0xCAFE) { assert(performance.now() < deadline); await sleep(1); }
        await vm.stop();
        // SSE enabled (CR4.OSFXSR, OSXMMEXCPT: the BIOS leaves them clear)
        vm.v86.cpu.cr[4] |= 0x600;
    }
    const selected = programs.filter(([name]) => !process.env.SEQUENCE_FILTER || (process.env.SEQUENCE_FILTER === "nonfloating" ? !name.startsWith("floating") : name.includes(process.env.SEQUENCE_FILTER)));
    for(const [name, body] of selected) {
        // Loop until 0x604 is set, then halt at the end of an iteration: a VM
        // stopped at an arbitrary point (page tier and region boundaries differ
        // from the loop head) can hold a partially rewritten OUT.
        const p = [...body, 0xC7, 0x05, ...u32(0x600), ...u32(0xCAFE), 0x80, 0x3D, ...u32(0x604), 0, 0x75, 5];
        p.push(0xE9, ...u32(-p.length - 5), 0xF4);
        const results = [];
        for(const [i, vm] of machines.entries()) {
            const cpu = vm.v86.cpu, e = cpu.wm.exports;
            // Programs reuse CODE: start each from an empty compiler state
            // (compiled code needs more heat to recompile a page after each rewrite).
            cpu.jit_clear_cache();
            vm.write_memory(data, DATA);
            vm.write_memory(new Uint8Array(8192), OUT);
            vm.write_memory(new Uint8Array(8), 0x600);
            vm.write_memory(Uint8Array.from(p), CODE);
            cpu.instruction_pointer[0] = CODE; cpu.in_hlt[0] = 0;
            const start = compiled_activations(e);
            vm.run();
            const deadline = performance.now() + 10000;
            while(word(vm, 0x600) !== 0xCAFE || (i > 0 || process.argv[2]) && compiled_activations(e) === start) {
                assert(performance.now() < deadline, `${labels[i]}: ${name}`); await sleep(1);
            }
            await sleep(20); await vm.stop();
            vm.write_memory(Uint8Array.of(1), 0x604);
            vm.run();
            while(!cpu.in_hlt[0]) { assert(performance.now() < deadline, `${labels[i]}: ${name} halt`); await sleep(1); }
            await vm.stop();
            const result=Uint8Array.from(vm.read_memory(OUT,8192));
            if(oracles.has(name)) oracles.get(name)(result);
            results.push(result);
        }
        for(let i = 1; i < machines.length; i++) assert.deepEqual(results[i], results[0], `${labels[i]}: ${name}`);
    }
    console.log(`PASS: ${selected.length} actual sequences on the page tier and regions, aliases, MMX/x87 transitions and RAM boundaries`);
} finally { for(const vm of machines) await vm.destroy(); }
