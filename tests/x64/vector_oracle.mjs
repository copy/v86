#!/usr/bin/env node
// Identical real long-mode guest bytes run on independent QEMU TCG and v86.
import assert from "node:assert/strict";
import fs from "node:fs";
import {assemble, reference, actual} from "./guest_runner.mjs";
import {step_profile} from "../../tools/step_profile.mjs";
const cases = [];
function add(name, code, a = [0x3F800000,0x40000000,0x40400000,0x40800000], b = [0x40000000,0x40800000,0x40C00000,0x41000000], mxcsr = 0x1F80)
{
    cases.push({name,code,a,b,mxcsr});
}
const floats = [[0x3F800000,0x33800000,0x00800000,0x80000001], [0x7FC12345,0x7F812345,0x7F800000,0xFF800000], [0x00000001,0x80000000,0x7F7FFFFF,0xBF800000]];
const doubles = [[0x00000000,0x3FF00000,0x00000000,0x40000000], [0x00000001,0x7FF80000,0x00000001,0x7FF00000], [1,0,0xFFFFFFFF,0x7FEFFFFF]];
for(const instruction of ["addps","subps","mulps","divps","minps","maxps","sqrtps","addss","subss","mulss","divss","minss","maxss","sqrtss"])
    for(const [n,values] of floats.entries()) for(const rounding of [0,1,2,3])
        add(`${instruction} sample ${n} rounding ${rounding}`, `${instruction} xmm8,xmm9`, values, floats[(n+1)%floats.length],0x1F80|(rounding<<13));
for(const instruction of ["addpd","subpd","mulpd","divpd","minpd","maxpd","sqrtpd","addsd","subsd","mulsd","divsd","minsd","maxsd","sqrtsd"])
    for(const [n,values] of doubles.entries()) for(const rounding of [0,1,2,3])
        add(`${instruction} sample ${n} rounding ${rounding}`, `${instruction} xmm8,xmm9`, values,doubles[(n+1)%doubles.length],0x1F80|(rounding<<13));
for(const instruction of ["addps","mulps","divps","sqrtps","addpd","mulpd","divpd","sqrtpd"])
    for(const mode of [0x1FC0,0x9F80,0x9FC0]) add(`${instruction} DAZ/FZ ${mode.toString(16)}`,`${instruction} xmm8,xmm9`,[1,0x80000001,0x00800000,0x80000000],[0x3F000000,0x40000000,0x7F7FFFFF,0],mode);
for(const ins of ["paddb","paddw","paddd","paddq","psubb","psubw","psubd","psubq","paddsb","paddsw","paddusb","paddusw","psubsb","psubsw","psubusb","psubusw","pand","pandn","por","pxor","pcmpeqb","pcmpeqw","pcmpeqd","pcmpgtb","pcmpgtw","pcmpgtd","packsswb","packssdw","packuswb","punpcklbw","punpcklwd","punpckldq","punpcklqdq","punpckhbw","punpckhwd","punpckhdq","punpckhqdq","pmullw","pmulhw","pmulhuw","pmuludq","pmaddwd","psadbw","pminub","pmaxub","pminsw","pmaxsw","pavgb","pavgw","psrlw","psrld","psrlq","psraw","psrad","psllw","pslld","psllq"])
    add(ins,`${ins} xmm8,xmm9`,[0x807F0180,0x80007FFF,0xFFFF0001,0x80000000],[0xFFFF0101,0x80008000,0x7FFF0001,0xFFFFFFFF]);
for(const ins of ["psrlw","psrld","psrlq","psraw","psrad","psllw","pslld","psllq","psrldq","pslldq"])
    for(const n of [0,1,15,16,31,32,63,64,255]) add(`${ins} ${n}`,`${ins} xmm15,${n}`);
for(const ins of ["pshufd","pshuflw","pshufhw","shufps","shufpd"])
    for(const n of [0,27,255]) add(`${ins} ${n}`,`${ins} xmm8,xmm9,${n}`);
for(const ins of ["cmpps","cmppd","cmpss","cmpsd"]) for(let predicate=0;predicate<8;predicate++)
    for(const values of [[0x3F800000,0,0xBF800000,0x7F800000],[0x7FC12345,0x7F812345,0x7FC00000,0xFFC00000]]) add(`${ins} ${predicate} ${values[0].toString(16)}`,`${ins} xmm8,xmm9,${predicate}`,values,values.toReversed());
for(const ins of ["ucomiss","comiss","ucomisd","comisd"]) for(const values of floats) add(ins+values[0],`${ins} xmm8,xmm9`,values,values.toReversed());
for(const ins of ["haddps","haddpd","hsubps","hsubpd","addsubps","addsubpd"]) add(ins,`${ins} xmm8,xmm9`);
for(const ins of ["cvtps2pd","cvtpd2ps","cvtss2sd","cvtsd2ss","cvtdq2ps","cvtps2dq","cvttps2dq","cvtdq2pd","cvtpd2dq","cvttpd2dq"]) for(const values of floats) for(const rounding of [0,1,2,3])
    add(`${ins} ${values[0]} round ${rounding}`,`${ins} xmm8,xmm9`,undefined,values,0x1F80|rounding<<13);
// (MXCSR.PE set: where the page tier's conversion templates admit them, they
// run natively; P2.5, switch x64_cvt)
for(const ins of ["cvtps2pd","cvtpd2ps","cvtdq2ps","cvtps2dq","cvttps2dq","cvtdq2pd","cvtpd2dq","cvttpd2dq"])
    for(const [n,values] of [...floats,...doubles,[0x3FC00000,0xBFC00000,0x4B800001,0xCF000000],[1,2,0x7FFFFFFF,0x80000000]].entries())
        for(const operand of ["xmm9","[rel .b]"]) add(`${ins} PE ${n} ${operand}`,`${ins} xmm8,${operand}`,undefined,values,0x1FA0);
for(const ins of ["cvtsi2ss","cvtsi2sd"]) for(const n of ["0x7FFFFFFFFFFFFFFF","0x8000000000000000","0x20000000000001"]) for(const rounding of [0,1,2,3]) add(`${ins} ${n} ${rounding}`,`mov r10,${n}\n${ins} xmm8,r10`,undefined,undefined,0x1F80|rounding<<13);
for(const ins of ["cvtss2si","cvttss2si","cvtsd2si","cvttsd2si"]) for(const values of floats) for(const rounding of [0,1,2,3]) add(`${ins} ${values[0]} ${rounding}`,`${ins} rax,xmm9`,undefined,values,0x1F80|rounding<<13);
for(const code of ["movq xmm15,xmm8","movd xmm8,r10d","movq xmm8,r10","movq rax,xmm9","movd eax,xmm9","movhlps xmm8,xmm9","movlhps xmm8,xmm9","movss xmm8,xmm9","movsd xmm8,xmm9","movddup xmm8,xmm9","movsldup xmm8,xmm9","movshdup xmm8,xmm9","movmskps eax,xmm9","movmskpd eax,xmm9","pmovmskb eax,xmm9","pinsrw xmm8,r10d,7","pextrw eax,xmm9,7"])
    add(code,`mov r10,0xFFEEDDCCBBAA9988\n${code}`);
add("FXSAVE64/FXRSTOR64 all sixteen registers", "fxsave64 [0x510000]\npxor xmm8,xmm8\npxor xmm9,xmm9\npxor xmm15,xmm15\nfxrstor64 [0x510000]");
add("x87 arithmetic and m80 full pointer", "fld qword [rel .a]\nfld qword [rel .b]\nfaddp st1,st0\nfstp tword [0x510300]\nfld tword [0x510300]\nfstp qword [0x510310]\nmovq xmm8,[0x510310]",doubles[0],doubles[0]);
add("x87 save/restore environment", "fld1\nfldpi\nfnsave [0x510400]\nfrstor [0x510400]\nfaddp st1,st0\nfstp qword [0x510310]\nmovq xmm8,[0x510310]");
for(let r=0;r<16;r++) add(`FXRSTOR preserves XMM${r}`,`movdqa xmm${r},xmm9\nfxsave64 [0x510000]\npxor xmm${r},xmm${r}\nfxrstor64 [0x510000]\nmovdqa xmm8,xmm${r}`);
add("FXSAVE64 high FIP and FDP", "lea rax,[rel .fld]\n.fld:\nfld qword [rel .a]\nfxsave64 [0x510000]\nmov rdx,[0x510008]\nsub rdx,rax\nmovq xmm8,rdx\nlea rax,[rel .a]\nmov rdx,[0x510010]\nsub rdx,rax\nmovq xmm9,rdx\nfstp st0\nmov eax,0", doubles[0],doubles[0]);
for(const ins of ["faddp","fmulp","fsubp","fsubrp","fdivp","fdivrp"]) add("x87 "+ins,`fld qword [rel .a]\nfld qword [rel .b]\n${ins} st1,st0\nfstp qword [0x510310]\nmovq xmm8,[0x510310]`,doubles[0],[0,0x40080000,0,0]);
for(const ins of ["cvtsd2si","cvttsd2si"]) for(const values of [[0,0x43E00000,0,0],[0,0xC3E00000,0,0],[0xFFFFFFFF,0x43DFFFFF,0,0]]) for(const rounding of [0,1,2,3]) add(`${ins} int64 boundary ${values[1]} ${rounding}`,`${ins} rax,xmm9`,undefined,values,0x1F80|rounding<<13);
for(const ins of ["paddb","paddw","paddd","paddq","psubb","psubw","psubd","psubq","paddsb","paddsw","paddusb","paddusw","psubsb","psubsw","psubusb","psubusw","pand","pandn","por","pxor","pcmpeqb","pcmpeqw","pcmpeqd","pcmpgtb","pcmpgtw","pcmpgtd","packsswb","packssdw","packuswb","punpcklbw","punpcklwd","punpckldq","punpckhbw","punpckhwd","punpckhdq","pmullw","pmulhw","pmulhuw","pmuludq","pmaddwd","psadbw","pminub","pmaxub","pminsw","pmaxsw","pavgb","pavgw"]) add("MMX "+ins,`movq mm7,[rel .a]\nmovq mm6,[rel .b]\n${ins} mm7,mm6\nmovq [0x510310],mm7\nmovq xmm8,[0x510310]\nemms`,[0x807F0180,0x80007FFF,0,0],[0xFFFF0101,0x80008000,0,0]);
for(const ins of ["cvtpi2ps","cvtpi2pd"]) add(ins,`movq mm7,[rel .b]\n${ins} xmm8,mm7\nemms`,undefined,[0x80000000,0x7FFFFFFF,0,0]);
for(const ins of ["cvtps2pi","cvtpd2pi","cvttps2pi","cvttpd2pi"]) add(ins,`${ins} mm7,xmm9\nmovq [0x510310],mm7\nmovq xmm8,[0x510310]\nemms`,undefined,[0x3FC00000,0xBFC00000,0,0]);
for(const ins of ["rcpps","rcpss","rsqrtps","rsqrtss"]) add(ins,`${ins} xmm8,xmm9`,undefined,[0x3F800000,0x40800000,0x7F800000,0x80000000]);
add("SSE full base and address32 override", "mov r10,HIGH+0x510000\nmovdqu [r10],xmm9\nmovdqu xmm8,[r10]\na32 movdqu xmm15,[r10d]");
add("SSE full FS base", "mov ecx,0xC0000100\nmov eax,0x510000\nmov edx,0xFFFF8000\nwrmsr\nmovdqu [fs:0],xmm9\nmovdqu xmm8,[fs:0]\nxor eax,eax\nxor edx,edx\nwrmsr");
add("CLFLUSH coherent cache line", "clflush [0x510000]");
for(const rounding of [0,1,2,3]) for(const value of [[0,0x3FF80000,0,0],[0,0xBFF80000,0,0],[0xFFFFFFFF,0x43DFFFFF,0,0]]) add(`x87 integer rounding ${rounding} ${value[1]}`,`mov word [0x510820],${0x37F | rounding << 10}\nfldcw [0x510820]\nfld qword [rel .a]\nfistp qword [0x510310]\nmovq xmm8,[0x510310]\nfnstsw ax`,value);
add("x87 FNCLEX preserves condition flags", "fld1\nfldz\nfcom st1\nfnclex\nfnstsw ax");
for(const [kind,cw,load] of [["divide zero",0x37B,"fldz\nfld1"],["invalid",0x37E,"fldz\nfldz"]]) add("x87 deferred #MF "+kind,`lea rax,[rel .resume]\nmov [0x500010],rax\nmov word [0x510820],${cw}\nfldcw [0x510820]\n${load}\nfdiv st0,st1\nfwait\n.resume:\nmov eax,0\nfnstsw ax\nfnclex`);

const fault = (name,code,mxcsr=0x1F80,a,b) => add(name,`lea rax,[rel .resume]\nmov [0x500010],rax\n${code}\n.resume:\nclts\nmov rax,cr4\nor eax,0x600\nmov cr4,rax\nmov eax,0`,a,b,mxcsr);
fault("unmasked SIMD invalid destination suppression","divps xmm8,xmm9",0x1F00,[0,0,0,0],[0,0,0,0]);
fault("unmasked SIMD divzero destination suppression","divpd xmm8,xmm9",0x1D80,doubles[0],[0,0,0,0]);
fault("SIMD disabled OSFXSR","mov rax,cr4\nbtr rax,9\nmov cr4,rax\npxor xmm8,xmm9");
fault("SIMD TS lazy switch","mov rax,cr0\nbts rax,3\nmov cr0,rax\nmovaps xmm8,xmm9");
fault("unaligned packed #GP","movaps xmm8,[0x600FF8]");
fault("unaligned MOVSLDUP #GP","movsldup xmm8,[0x600FF8]");
fault("unaligned MOVSHDUP #GP","movshdup xmm8,[0x600FF8]");
fault("cross-page vector load #PF","movdqu xmm8,[0x600FF8]");
fault("cross-page vector store no partial write","movdqu [0x600FF8],xmm8");
fault("cross-page FXSAVE no partial write","fxsave64 [0x600F00]");
fault("cross-page FXRSTOR no partial state","fxrstor64 [0x600F00]");
// VMASKMOVPS/PD across into the absent page: lanes there that the mask
// (XMM9's sign bits) does not select are not accessed; a selected one faults
// before any lane is stored (docs/simd-xsave-plan.md 8)
const AVX = "mov rax,cr4\nbts rax,18\nmov cr4,rax\nxor ecx,ecx\nmov eax,7\nxor edx,edx\nxsetbv";
for(const [suffix, size, selections] of [["ps", 4, [[0, 1], [0, 2], [3]]], ["pd", 8, [[0], [0, 1]]]])
    for(const lanes of selections)
    {
        // (the dwords of XMM9 with the sign bit of a selected lane)
        const mask = [0, 1, 2, 3].map(i => lanes.includes(i / (size / 4) | 0) && (size === 4 || i & 1) ? 0x80000000 : 0);
        const what = `lanes ${lanes.join(",")} across into an absent page`;
        fault(`vmaskmov${suffix} load ${what}`, `${AVX}\nvmaskmov${suffix} xmm8,xmm9,[0x600FF8]`, undefined, undefined, mask);
        fault(`vmaskmov${suffix} store ${what}`, `${AVX}\nvmaskmov${suffix} [0x600FF8],xmm9,xmm8`, undefined, undefined, mask);
    }
// VEX.256 (P6): 32 bytes across into the absent page, the load a #PF and the
// store one without a partial write; the aligned moves need 32-byte alignment
fault("cross-page VEX.256 load #PF", `${AVX}\nvmovdqu ymm8,[0x600FF0]`);
fault("cross-page VEX.256 store no partial write", `${AVX}\nvmovdqu [0x600FF0],ymm8`);
fault("VEX.256 aligned load at 16 bytes #GP", `${AVX}\nvmovaps ymm8,[0x600FD0]`);
fault("VEX.256 aligned store at 16 bytes #GP", `${AVX}\nvmovntdq [0x600FD0],ymm8`);
// AVX2 gathers (P8). The destination YMM8 is filled with D0 to D7 and the
// mask YMM9 has junk beside its sign bits and beyond the elements; base,
// index register, scale and address size vary. After it, the high halves of
// both go to XMM15 and XMM0. A gather loads each selected element in turn,
// clearing its mask; it zeroes the mask beyond the elements first and the
// destination beyond them last (docs/simd-xsave-plan.md 9)
const HALVES = "vextracti128 xmm15,ymm8,1\nvextracti128 xmm0,ymm9,1";
// (the fill's dwords, D0 to D7, and mask elements)
const [D1, D2, D3, D4, D5, D6, D7] = [1, 2, 3, 4, 5, 6, 7].map(n => 0xD0D0D0D0 + n * 0x01010101), ALL = 0xFFFFFFFF, SIGN = 0x80000000;
function gather(name, instruction, mask, index, setup, index_register = 10)
{
    const dwords = v => v.map(x => typeof x === "string" ? x : "0x" + (x >>> 0).toString(16)).join(",");
    const code = `jmp .gskip\nalign 32\n.gmask: dd ${dwords(mask)}\n.gindex: dd ${dwords(index)}\n.gskip:\n${AVX}\nvmovdqu ymm8,[rel gfill]\nvmovdqu ymm9,[rel .gmask]\nvmovdqu ymm${index_register},[rel .gindex]\n${setup}\n${instruction}`;
    // (each may fault: an unexpected one in QEMU, too, a difference)
    add(name, `lea rax,[rel .resume]\nmov [0x500010],rax\n${code}\n.resume:\n${HALVES}\nmov eax,0`);
}
{
    let seed = 0x2468ACE;
    const random = () => (seed = Math.imul(seed, 1103515245) + 12345 >>> 0) >>> 1;
    const junk = () => (random() << 1 ^ random()) >>> 0;
    // (base and displacement around the term of the index; `table`+256 each)
    const ADDRESSES = [
        ["rbx", "lea rbx,[rel table+256]", x => `[rbx+${x}]`],
        ["r13 disp8", "lea r13,[rel table+256+64]", x => `[r13+${x}-64]`],
        ["r12 disp32", "lea r12,[rel table+256-0x1000]", x => `[r12+${x}+0x1000]`],
        ["no base", "", x => `[${x}+table+256]`],
        ["address32", "lea ebx,[rel table+256]", x => `[ebx+${x}]`],
    ];
    let k = 0;
    for(const [mnemonic, size, index_size] of [["vpgatherdd", 4, 4], ["vpgatherdq", 8, 4], ["vpgatherqd", 4, 8], ["vpgatherqq", 8, 8],
        ["vgatherdps", 4, 4], ["vgatherdpd", 8, 4], ["vgatherqps", 4, 8], ["vgatherqpd", 8, 8]])
        for(const wide of [false, true])
            for(let variant = 0; variant < 3; variant++, k++)
            {
                const count = (wide ? 32 : 16) / Math.max(size, index_size);
                const scale = [1, 2, 4, 8][k % 4];
                const [where, setup, address] = ADDRESSES[k % ADDRESSES.length];
                const r = [10, 2, 14][k % 3];
                const vector = wide && !(size === 4 && index_size === 8) ? "ymm" : "xmm";
                const index_vector = wide && !(size === 8 && index_size === 4) ? "ymm" : "xmm";
                const mask = Array.from({length: 8}, junk), index = Array.from({length: 8}, junk);
                for(let n = 0; n < count; n++)
                {
                    const selected = variant === 0 || random() & 1;
                    mask[(n + 1) * size / 4 - 1] = (selected ? 0x80000000 : 0) | random() & 0x7FFFFFFF;
                    const low = Math.ceil(-256 / scale), high = Math.floor((256 - size) / scale);
                    const value = low + random() % (high - low + 1);
                    if(index_size === 4) index[n] = value;
                    else [index[2 * n], index[2 * n + 1]] = [value, value < 0 ? -1 : 0];
                }
                gather(`${mnemonic} ${vector} ${index_vector} indices ${where} scale ${scale} #${variant}`,
                    `${mnemonic} ${vector}8,${address(`${index_vector}${r}*${scale}`)},${vector}9`, mask, index, setup, r);
            }
    // nothing selected: nothing loaded, the destination still zeroed beyond
    // the elements (the high dwords of the mask beyond them have sign bits)
    gather("vpgatherqd ymm indices none selected", "vpgatherqd xmm8,[rbx+ymm10*4],xmm9",
        [0x7FFFFFFF, 1, 0x12345678, 0, SIGN, SIGN, SIGN, SIGN], [0, 0, 1, 0, 2, 0, 3, 0], "lea rbx,[rel table+256]");
    gather("vpgatherdd xmm none selected", "vpgatherdd xmm8,[rbx+xmm10*4],xmm9",
        [0, 0x7FFFFFFF, 0, 1, SIGN, ALL, SIGN, ALL], [0, 1, 2, 3, 0, 0, 0, 0], "lea rbx,[rel table+256]");
    // address size 32: the element's address wraps at 4 GiB (base 0xFFFFFFF0)
    gather("vpgatherdd address32 wraps at 4 GiB", "vpgatherdd xmm8,[ebx+xmm10*1],xmm9",
        [ALL, 0, ALL, ALL, 0, 0, 0, 0], ["table+256+0x10", "table+256+0x18", "table+256+0x14", "table+256+0x23", 0, 0, 0, 0], "mov ebx,0xFFFFFFF0");
    // an unselected element is not accessed, so not in an absent page either
    gather("vpgatherqq ymm unselected elements in an absent page", "vpgatherqq ymm8,[rbx+ymm10*8],ymm9",
        [0, SIGN, 0, 0x7FFFFFFF, 0, SIGN, 0, 0], [0, 0, 2, 0, 1, 0, 0x100, 0], "mov ebx,0x600FF0");
    // a fault: the elements before the faulting one loaded and their masks
    // clear, the rest as before (the mask normalized, zero beyond the
    // elements), the destination not yet zeroed beyond the elements
    gather("vpgatherdd xmm element 2 in an absent page", "vpgatherdd xmm8,[rbx+xmm10*4],xmm9",
        [ALL, ALL, ALL, ALL, SIGN, SIGN, ALL, ALL], [0, 1, 4, 2, 0, 0, 0, 0], "mov ebx,0x600FF0");
    gather("vpgatherdd ymm element 5 in an absent page", "vpgatherdd ymm8,[rbx+ymm10*1],ymm9",
        [ALL, ALL, 0, ALL, ALL, ALL, ALL, ALL], [0, 4, 8, 12, 0, 16, 0, 4], "mov ebx,0x600FF0");
    gather("vpgatherdq xmm element 1 across into an absent page", "vpgatherdq xmm8,[rbx+xmm10*4],xmm9",
        [ALL, ALL, ALL, ALL, ALL, ALL, ALL, ALL], [0, 3, 0, 0, 0, 0, 0, 0], "mov ebx,0x600FF0");
    gather("vpgatherqd ymm element 3 in an absent page", "vpgatherqd xmm8,[rbx+ymm10*1],xmm9",
        [ALL, 0, ALL, ALL, SIGN, SIGN, SIGN, SIGN], [0, 0, 4, 0, 8, 0, 16, 0], "mov ebx,0x600FF0");
    gather("vpgatherdd xmm fault with unnormalized mask elements", "vpgatherdd xmm8,[rbx+xmm10*4],xmm9",
        [SIGN | 1, SIGN | 2, SIGN | 3, 0xC0000000, 0, 0, 0, 0], [0, 1, 4, 2, 0, 0, 0, 0], "mov ebx,0x600FF0");
    // quadword indices beyond 32 bits: 4 GiB below the table, the base
    gather("vpgatherqq ymm indices beyond 32 bits", "vpgatherqq ymm8,[rbx+ymm10*1],ymm9",
        [0, SIGN, 0, SIGN, 0, SIGN, 0, SIGN], [0, 1, 8, 1, -8, 0, 16, 1], "mov rbx,HIGH+table+256-0x100000000");
    // a qword index is not truncated: 2^31 above the base, not below it
    gather("vpgatherqq xmm index 2^31 not truncated", "vpgatherqq xmm8,[rbx+xmm10*1],xmm9",
        [0, SIGN, 0, SIGN, 0, 0, 0, 0], [0, 0, SIGN, 0, 0, 0, 0, 0], "mov ebx,0x600FF0");
    // an override's segment, FS or GS, for every element (the base from its
    // MSR, 4 KiB; zero again after)
    for(const [segment, msr] of [["fs", 0xC0000100], ["gs", 0xC0000101]])
        gather(`vpgatherdd ymm ${segment} base`, `vpgatherdd ymm8,[${segment}:rbx+ymm10*4],ymm9\nmov ecx,${msr}\nxor eax,eax\nxor edx,edx\nwrmsr`,
            [ALL, 0, ALL, SIGN, ALL, ALL, 0x7FFFFFFF, ALL], [0, -3, 5, 7, -8, 2, 1, 63], `mov ecx,${msr}\nmov eax,0x1000\nxor edx,edx\nwrmsr\nlea rbx,[rel table+256-0x1000]`);
    // a non-canonical element: #GP(0), or #SS(0) with RBP the base
    gather("vpgatherdd non-canonical element #GP", "vpgatherdd xmm8,[rbx+xmm10*1],xmm9",
        [ALL, ALL, ALL, ALL, 0, 0, 0, 0], [0, "-0x601000", 4, 8, 0, 0, 0, 0], "mov rbx,HIGH+0x600FF0");
    gather("vpgatherdd non-canonical element from RBP #SS", "vpgatherdd xmm8,[rbp+xmm10*1],xmm9",
        [ALL, ALL, ALL, ALL, 0, 0, 0, 0], [0, "-0x601000", 4, 8, 0, 0, 0, 0], "mov rbp,HIGH+0x600FF0");
}
// #UD: two of destination, mask and index the same register; no SIB byte;
// a register operand
for(const [name, code] of [["destination is index", "vpgatherdd xmm8,[rbx+xmm8*4],xmm9"], ["destination is mask", "vpgatherdd xmm8,[rbx+xmm10*4],xmm8"],
    ["mask is index", "vpgatherdd xmm8,[rbx+xmm9*4],xmm9"], ["no SIB byte", "db 0xC4,0x62,0x31,0x90,0x03"], ["register operand", "db 0xC4,0x62,0x31,0x90,0xC4"]])
    fault("invalid gather form " + name, `${AVX}\n${code}`);
fault("invalid MXCSR high bits","mov dword [0x510800],0xFFFFFFFF\nldmxcsr [0x510800]");
for(const [name,encoding] of [["MOVDQ2Q memory","0xF2,0x0F,0xD6,0x00"],["MOVQ2DQ memory","0xF3,0x0F,0xD6,0x00"],["MOVNTPS register","0x0F,0x2B,0xC0"],["MOVLPD register","0x66,0x0F,0x12,0xC0"],["MOVLPS store register","0x0F,0x13,0xC0"],["MOVMSKPS memory","0x0F,0x50,0x00"],["PEXTRW memory","0x66,0x0F,0xC5,0x00,0"],["MASKMOVDQU memory","0x66,0x0F,0xF7,0x00"],["LDDQU register","0xF2,0x0F,0xF0,0xC0"]]) fault("invalid SIMD form "+name,"db "+encoding);

// QEMU 10.2 TCG does not raise unmasked SSE exceptions or reject high
// LDMXCSR bits. Its source also documents x87-style SSE NaN propagation.
// Keep those reference results visible and check explicit architectural
// postconditions separately; do not change execution to match oracle gaps.
add("first SSE NaN payload wins", "addps xmm8,xmm9", [0x7FC12345,0x7F812345,0x7FC12345,0x7F812345], [0x7FC54321,0x7FC54321,0x7F854321,0x7F854321]);
const specification = new Map([
    ["unmasked SIMD invalid destination suppression", {vector:19,mxcsr:0x1F01,unchanged:true}],
    ["unmasked SIMD divzero destination suppression", {vector:19,mxcsr:0x1D84,unchanged:true}],
    ["invalid MXCSR high bits", {vector:13,mxcsr:0x1F80,unchanged:true}],
    ["FXSAVE64 high FIP and FDP", {vector:0,mxcsr:0x1F80,result:[0,0,0,0],zero_xmm9:true}],
    ["first SSE NaN payload wins", {vector:0,mxcsr:0x1F81,result:[0x7FC12345,0x7FC12345,0x7FC12345,0x7FC12345]}],
    // SDM opcode map Table A-3 gives 66 0F 12 only an Mq source (memory);
    // QEMU 10.2 executes the undefined register form as a low-qword move.
    ["invalid SIMD form MOVLPD register", {vector:6,mxcsr:0x1F80,unchanged:true}],
    // MOVSLDUP/MOVSHDUP take an m128 of exception type 4 (SDM): legacy SSE
    // raises #GP(0) unless it is 16-byte aligned (only LDDQU and PCMPxSTRx
    // are exempt). QEMU 10.2 does not check, and page-faults on the crossing.
    ["unaligned MOVSLDUP #GP", {vector:13,mxcsr:0x1F80,unchanged:true}],
    ["unaligned MOVSHDUP #GP", {vector:13,mxcsr:0x1F80,unchanged:true}],
    // VMASKMOVPS/PD access only the selected lanes (SDM: no fault for a lane
    // whose mask bit is 0) and, faulting, store none (a fault restores the
    // state before the instruction, SDM vol. 3 6.5). QEMU 10.2 loads the
    // whole operand (a fault for unselected lanes, CR2 at the page boundary)
    // and stores lane by lane (those before the faulting one written).
    ["vmaskmovps load lanes 0,1 across into an absent page", {vector:0,mxcsr:0x1F80,result:[0x44332211,0x88776655,0,0]}],
    ["vmaskmovpd load lanes 0 across into an absent page", {vector:0,mxcsr:0x1F80,result:[0x44332211,0x88776655,0,0]}],
    ["vmaskmovps load lanes 3 across into an absent page", {vector:14,mxcsr:0x1F80,unchanged:true,error_code:0,cr2:0x601004}],
    ["vmaskmovps store lanes 0,2 across into an absent page", {vector:14,mxcsr:0x1F80,unchanged:true,error_code:2,cr2:0x601000,memory:true}],
    ["vmaskmovpd store lanes 0,1 across into an absent page", {vector:14,mxcsr:0x1F80,unchanged:true,error_code:2,cr2:0x601000,memory:true}],
    // A VEX.256 store faulting on its high half writes nothing (SDM vol. 3
    // 6.5); QEMU 10.2 stores the low half first
    ["cross-page VEX.256 store no partial write", {vector:14,mxcsr:0x1F80,unchanged:true,error_code:2,cr2:0x601000,memory:true}],
    // A gather sets each element's mask to all ones or zero by its sign and
    // zeroes the mask beyond the elements before loading any (SDM VPGATHERDD
    // operation; the zeroing allowed even with a fault), so a fault leaves
    // them so. QEMU 10.2 leaves the mask as it was from the faulting element.
    ...[["vpgatherdd xmm element 2 in an absent page", [0x55667788,0x11223344,D2,D3, 0,0,ALL,ALL, D4,D5,D6,D7, 0,0,0,0], 0x601000],
        ["vpgatherdq xmm element 1 across into an absent page", [0x55667788,0x11223344,D2,D3, 0,0,ALL,ALL, D4,D5,D6,D7, 0,0,0,0], 0x601000],
        ["vpgatherqd ymm element 3 in an absent page", [0x55667788,D1,0x44332211,D3, 0,0,0,ALL, D4,D5,D6,D7, 0,0,0,0], 0x601000],
        ["vpgatherdd xmm fault with unnormalized mask elements", [0x55667788,0x11223344,D2,D3, 0,0,ALL,ALL, D4,D5,D6,D7, 0,0,0,0], 0x601000],
        ["vpgatherqq xmm index 2^31 not truncated", [0x55667788,0x11223344,D2,D3, 0,0,ALL,ALL, D4,D5,D6,D7, 0,0,0,0], 0x80600FF0]]
        .map(([name, registers, cr2]) => [name, {vector:14,mxcsr:0x1F80,registers,error_code:0,cr2}]),
    // a non-canonical address relative to SS is #SS(0) (exception type 12);
    // QEMU 10.2 raises #GP(0)
    ["vpgatherdd non-canonical element from RBP #SS", {vector:12,mxcsr:0x1F80,registers:[0x55667788,D1,D2,D3, 0,ALL,ALL,ALL, D4,D5,D6,D7, 0,0,0,0],error_code:0,cr2:0}],
    // address size 32 computes each element's address modulo 2^32 (as
    // Bochs); QEMU 10.2 adds the index at 64 bits and faults above 4 GiB
    ["vpgatherdd address32 wraps at 4 GiB", {vector:0,mxcsr:0x1F80,registers:[0xA54080C0,D1,0xA54182C3,0x458ACFA5, 0,0,0,0, 0,0,0,0, 0,0,0,0]}],
]);
const selected = process.env.X64_VECTOR_FILTER ? cases.filter(x=>x.name.includes(process.env.X64_VECTOR_FILTER)) : cases;
assert.ok(selected.length);
let body="";
for(const [n,test] of selected.entries())
{
    body+=`\ncase_${n}:\nmov dword [0x300004],${n}\nmov qword [0x500010],0\nmov qword [0x500020],0\nmov qword [0x500028],0\nmov qword [0x500030],0\nfninit\nmov dword [0x510800],${test.mxcsr}\nldmxcsr [0x510800]\nmovdqu xmm8,[rel .a]\nmovdqu xmm9,[rel .b]\nmovdqu xmm15,[rel .a]\nmovdqu xmm0,[rel sentinel]\nmovdqu [0x600FF0],xmm0\nmovdqu [0x600F00],xmm0\nmov eax,0\nmov cr2,rax\npush 2\npopfq\n${test.code}\nmov rdi,${0x300008+n*128}\nmovdqu [rdi],xmm8\nmovdqu [rdi+16],xmm9\nmovdqu [rdi+32],xmm15\nmovdqu [rdi+48],xmm0\nstmxcsr [rdi+64]\nmov [rdi+72],rax\npushfq\npop rax\nand eax,0x8D5\nmov [rdi+80],rax\nmov eax,[0x500020]\nmov [rdi+68],eax\nmov rax,[0x500028]\nmov [rdi+88],rax\nmov rax,[0x500030]\nmov [rdi+96],rax\nmovdqu xmm0,[0x600FF0]\nmovdqu [rdi+104],xmm0\nmov rax,[0x600F00]\nmov [rdi+120],rax\njmp .done\nalign 16\n.a: dd ${test.a.join(",")}\n.b: dd ${test.b.join(",")}\n.done:\n`;
}
const source=`bits 32
org 0x100000
%define HIGH 0xFFFF800000000000
header: dd 0x1BADB002,0x10000,-(0x1BADB002+0x10000)
dd header,header,image_end,image_end,start
start:
cli
cld
lgdt [gdtr]
jmp 8:protected
protected:
mov ax,16
mov ds,ax
mov es,ax
mov ss,ax
mov esp,0x3F0000
mov dword [0x200000],0x201003
mov dword [0x200800],0x201003
mov dword [0x201000],0x202003
mov edi,0x202000
mov eax,0x83
mov ecx,512
.pages:
mov [edi],eax
add eax,0x200000
add edi,8
loop .pages
mov dword [0x202018],0x203003
mov dword [0x203000],0x600003
mov eax,cr4
or eax,0x620
mov cr4,eax
mov eax,0x200000
mov cr3,eax
mov ecx,0xC0000080
mov eax,0x900
xor edx,edx
wrmsr
mov eax,cr0
and eax,~12
or eax,0x80010021
mov cr0,eax
jmp 24:long_mode
bits 64
long_mode:
mov rax,HIGH+high_mode
jmp rax
high_mode:
lidt [rel idtr]
lea rdi,[rel idt]
mov ecx,256
lea rax,[rel unexpected]
.idt:
mov word [rdi],ax
mov word [rdi+2],0x18
mov word [rdi+4],0x8E00
mov rdx,rax
shr rdx,16
mov word [rdi+6],dx
shr rdx,16
mov dword [rdi+8],edx
add rdi,16
loop .idt
%macro GATE 1
lea rax,[rel handler_%1]
lea rdi,[rel idt+%1*16]
mov word [rdi],ax
mov rdx,rax
shr rdx,16
mov word [rdi+6],dx
shr rdx,16
mov dword [rdi+8],edx
%endmacro
GATE 6
GATE 7
GATE 12
GATE 13
GATE 14
GATE 16
GATE 19
${process.env.X64_JIT ? "mov ecx,1000000\n.warm: add r10,3\nxor r11,r10\npxor xmm8,xmm9\nsub ecx,1\njnz .warm\n" : ""}
${body}
mov dword [0x300000],0xC064C064
hlt
jmp $
%macro HANDLER 2
handler_%1:
%if %2 == 0
push 0
%endif
push %1
jmp handler
%endmacro
HANDLER 6,0
HANDLER 7,0
HANDLER 12,1
HANDLER 13,1
HANDLER 14,1
HANDLER 16,0
HANDLER 19,0
handler:
push rax
mov rax,[rsp+8]
mov [0x500020],rax
mov rax,[rsp+16]
mov [0x500028],rax
mov rax,cr2
mov [0x500030],rax
mov rax,[0x500010]
test rax,rax
jz unexpected
mov [rsp+24],rax
pop rax
add rsp,16
iretq
unexpected:
cli
hlt
jmp $
align 16
sentinel: dq 0x1122334455667788,0x8877665544332211
align 32
gfill: dd 0xD0D0D0D0,0xD1D1D1D1,0xD2D2D2D2,0xD3D3D3D3,0xD4D4D4D4,0xD5D5D5D5,0xD6D6D6D6,0xD7D7D7D7
table:
%assign i 0
%rep 128
dd 0xA5000000+i*0x10203
%assign i i+1
%endrep
gdt: dq 0,0x00CF9A000000FFFF,0x00CF92000000FFFF,0x00AF9A000000FFFF
gdtr: dw 31
dd gdt
idtr: dw 4095
dq HIGH+idt
align 16
idt: times 4096 db 0
image_end:
`;
const directory=assemble("vector",source),length=8+selected.length*128;
fs.writeFileSync(directory+"cases.json",JSON.stringify(selected.map(x=>x.name),null,2)+"\n");
const expected=await reference(directory,{length});
console.log(`QEMU vector reference: ${selected.length} real long-mode cases`);
if(!process.env.X64_ORACLE_ONLY)
{
    const received=await actual(directory,{length,timeout:60000,
        options: {disable_jit:!process.env.X64_JIT,experimental_smp_jit:true,
            ir_tier0:process.env.X64_JIT === "pages",ir_sync_publication:true,
            // (the VMASKMOV and gather cases)
            cpu_features:["SSSE3","SSE4.1","SSE4.2","XSAVE","AVX","AVX2"],cpu_features_unreleased:true},
        inspect: emulator => {
            if(process.env.X64_JIT)
            {
                const retired = emulator.v86.cpu.wm.exports.x64_page_stat(1);
                assert.ok(retired > 1000,`mixed vector/native loop executed compiled instructions: retired=${retired}, compiled=${emulator.v86.cpu.wm.exports.x64_page_stat(0)}`);
                console.log(`native retirement=${retired} backend=${process.env.X64_JIT}`);
                // (X64_STEP_PROFILE=1 with JIT_SWITCHES=step_profile=1: what the page tier stepped)
                if(process.env.X64_STEP_PROFILE) for(const {name,count} of step_profile(emulator.v86.cpu.wm.exports,Number(process.env.X64_STEP_PROFILE)||12)) console.log(`step ${name}: ${count}`);
            }
        }});
    const failures=[];
    for(let n=0;n<selected.length;n++)
    {
        const from=8+n*128,e=expected.subarray(from,from+128),a=received.subarray(from,from+128);
        const spec = specification.get(selected[n].name);
        if(spec)
        {
            assert.equal(a.readUInt32LE(68),spec.vector,selected[n].name+" exception vector");
            assert.equal(a.readUInt32LE(64),spec.mxcsr,selected[n].name+" MXCSR");
            // (`registers`: XMM8, XMM9, XMM15 and XMM0, the gathers' halves)
            const value = Buffer.alloc(spec.registers ? 64 : 16);
            (spec.registers || spec.result || selected[n].a).forEach((v,i)=>value.writeUInt32LE(v,i*4));
            assert.deepEqual(a.subarray(0,value.length),value,selected[n].name+(spec.registers ? " registers" : " destination commit"));
            if(spec.zero_xmm9) assert.deepEqual(a.subarray(16,32),Buffer.alloc(16),selected[n].name+" data pointer");
            if(spec.error_code !== undefined) assert.equal(a.readUInt32LE(88),spec.error_code,selected[n].name+" error code");
            if(spec.cr2 !== undefined) assert.equal(a.readBigUInt64LE(96),BigInt(spec.cr2),selected[n].name+" CR2");
            // (nothing stored: the sentinel at 0x600FF0)
            if(spec.memory) assert.equal(a.subarray(104,120).toString("hex"),"88776655443322111122334455667788",selected[n].name+" memory");
            continue;
        }
        if(!e.equals(a)) failures.push({case:n,name:selected[n].name,expected:e.toString("hex"),actual:a.toString("hex"),offsets:Array.from({length:128},(_,i)=>i).filter(i=>e[i]!==a[i])});
    }
    fs.writeFileSync(directory+"differences.json",JSON.stringify(failures,null,2)+"\n");
    assert.equal(failures.length,0,JSON.stringify(failures.slice(0,10),null,2));
    console.log(`v86 vector/x87: ${selected.length} cases pass (${selected.filter(x=>specification.has(x.name)).length} explicit SDM cases for documented QEMU gaps)`);
}
