#!/usr/bin/env node
// SSE4.1 and SSE4.2 integer forms in the x64 engine (docs/simd-xsave-plan.md
// P4b): in 64-bit mode (XMM8-15 through REX, PEXTRQ/PINSRQ through REX.W,
// register destinations zero-extended to 64 bits) and in compatibility mode,
// with register and memory sources, against QEMU and the SDM model of
// tests/rust/sse4_model.mjs; PTEST's flags; #GP(0) for a misaligned m128
// (none for narrow operands), #NM with CR0.TS, #UD with CR0.EM, F3 or
// MOVNTDQA from a register. SSE4.2: PCMPxSTRx (lengths in EAX/EDX, or RAX/RDX
// with REX.W; the index to ECX, zero-extended; an unaligned m128), CRC32 (REX.W,
// AH and SIL, the destination zero-extended, the flags kept) and POPCNT, all
// without XMM state checks but PCMPxSTRx's. Interpreted, with the x64 page
// tier, and with compatibility-mode code compiled. Both blocks loop so that
// they become hot.
import assert from "node:assert/strict";
import {assemble, reference, actual} from "./guest_runner.mjs";
import {long_mode_guest} from "./guest_builder.mjs";
import {Fp, compare_strings, crc32, dot_product, extract, get, insert, insertps, ptest, round_lane, set, sse4_38, sse4_3a} from "../rust/sse4_model.mjs";

const OUT = 0x300000, CASE = OUT + 0x80, SKIP = OUT + 0x84, MATCH = OUT + 0xC0, FAULTS = OUT + 0x100, RESULTS = OUT + 0x1000;
// the MXCSR settings of the ROUND and DPP cases (default, RC down, up, toward zero; DAZ)
const MXCSR_VALUES = [0x1F80, 0x3F80, 0x5F80, 0x7F80, 0x1FC0];
// (compatibility-mode code is compiled only after a while)
const IDT = 0x380000, ROUNDS = 400, COMPAT_ROUNDS = 20000;

// 16 sample vectors: random bytes and lanes of edge values; then fractional,
// halfway, tiny and special floating-point values (16-18 single, 19-20 double)
const samples = new Uint8Array(26 * 16);
{
    const view = new DataView(samples.buffer);
    let seed = 0x2468ACE1;
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    const edges = [[1, [0x00, 0x01, 0x7F, 0x80, 0x81, 0xFF, 0x40, 0xC0]],
        [2, [0x0000, 0x0001, 0x7FFF, 0x8000, 0x8001, 0xFFFF, 0x4000, 0xC000]],
        [4, [0, 1, 0x7FFFFFFF, 0x80000000, 0x80000001, 0xFFFFFFFF, 0x40000000, 0xC0000000]]];
    for(let n = 0; n < 16; n++)
    {
        const [size, values] = edges[n % 4] || [1, null];
        for(let i = 0; i < 16; i += size)
        {
            const value = values ? values[random() & 7] : random() & 255;
            if(size === 1) samples[n * 16 + i] = value;
            else if(size === 2) view.setUint16(n * 16 + i, value, true);
            else view.setUint32(n * 16 + i, value, true);
        }
    }
}
{
    const view = new DataView(samples.buffer);
    [[0.5, -1.5, 2.5, -0.25], [3.7, -2.3, 1e-40, -1e30], [NaN, -0, Infinity, 1e-45]].forEach((values, n) =>
        values.forEach((v, i) => view.setFloat32((16 + n) * 16 + i * 4, v, true)));
    [[2.5, -0.5], [1e-310, -1234.5678]].forEach((values, n) => values.forEach((v, i) => view.setFloat64((19 + n) * 16 + i * 8, v, true)));
    // (an SNaN in the last single lane)
    view.setUint32(18 * 16 + 12, 0x7F800001, true);
    // strings (21-24): a haystack, a needle, ranges, words of either sign (a
    // zero element in each but the haystack); 25 pads the unaligned reads
    samples.set([0x61, 0x62, 0x63, 0x61, 0x62, 0x63, 0x64, 0x62, 0x63, 0x7A, 0x41, 0x80, 0xFF, 0x62, 0x63, 0x61], 21 * 16);
    samples.set([0x62, 0x63, 0x00, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6A, 0x6B, 0x6C, 0x6D], 22 * 16);
    samples.set([0x61, 0x63, 0x7A, 0x7A, 0x80, 0x81, 0x41, 0x5A, 0x00, 0x00, 0x30, 0x39, 0x01, 0x02, 0x03, 0x04], 23 * 16);
    [0x0061, 0x8000, 0x0062, 0xFFFF, 0x7FFF, 0x0000, 0x0061, 0x0063].forEach((v, i) => view.setUint16(24 * 16 + i * 2, v, true));
}
const sample = i => samples.subarray(i * 16, i * 16 + 16);
const hex = b => Buffer.from(b).toString("hex");

// [name, 66 0F 38 opcode byte, memory bytes]
const BINARY = [["pblendvb", 0x10], ["blendvps", 0x14], ["blendvpd", 0x15], ["pmovsxbw", 0x20, 8], ["pmovsxbd", 0x21, 4],
    ["pmovsxbq", 0x22, 2], ["pmovsxwd", 0x23, 8], ["pmovsxwq", 0x24, 4], ["pmovsxdq", 0x25, 8], ["pmuldq", 0x28], ["pcmpeqq", 0x29],
    ["packusdw", 0x2B], ["pmovzxbw", 0x30, 8], ["pmovzxbd", 0x31, 4], ["pmovzxbq", 0x32, 2], ["pmovzxwd", 0x33, 8],
    ["pmovzxwq", 0x34, 4], ["pmovzxdq", 0x35, 8], ["pcmpgtq", 0x37], ["pminsb", 0x38], ["pminsd", 0x39], ["pminuw", 0x3A],
    ["pminud", 0x3B], ["pmaxsb", 0x3C], ["pmaxsd", 0x3D], ["pmaxuw", 0x3E], ["pmaxud", 0x3F], ["pmulld", 0x40], ["phminposuw", 0x41]];
const IMMEDIATE = [["blendps", 0x0C], ["blendpd", 0x0D], ["pblendw", 0x0E], ["insertps", 0x21], ["mpsadbw", 0x42]];

// the cases: {long, kind, name, op, memory, dst, src, a, b, mask, imm8, offset}; the result is at RESULTS + 16 n
const cases = [];
const regs = long => long ? 16 : 8;
for(const long of [true, false])
{
    const base = long ? 8 : 0;
    for(const [name, op, bytes = 16] of BINARY) for(const memory of [false, true])
    {
        for(const [a, b, mask] of memory ? [[3, 6, 9]] : [[0, 1, 2], [2, 5, 11], [7, 7, 4]])
        {
            const n = cases.length;
            const dst = base + n % 8;
            const src = memory ? undefined : a === b ? dst : (dst + 1 + n * 5 % (regs(long) - 1)) % regs(long);
            cases.push({long, kind: "binary", name, op, memory, dst, src, a, b, mask, imm8: 0, offset: memory && bytes < 16 ? n & 7 : 0});
        }
    }
    for(const [name, op] of IMMEDIATE) for(const memory of [false, true]) for(const imm8 of memory ? [0x1B, 0xE4] : [0x00, 0x5A, 0xA5, 0xFF, 0x93])
    {
        const n = cases.length;
        const dst = base + n % 8, src = memory ? undefined : (dst + 3) % regs(long);
        cases.push({long, kind: "immediate", name, op, memory, dst, src, a: n % 16, b: (n + 5) % 16, imm8, offset: 0});
    }
    for(const memory of [false, true]) for(const [a, b] of [[1, 2], [5, 5], [10, 12]])
    {
        const n = cases.length;
        cases.push({long, kind: "ptest", name: "ptest", op: 0x17, memory, dst: base + n % 8, src: memory ? undefined : base + (n + 1) % 8, a, b, imm8: 0, offset: 0});
    }
    // extracts to a GPR (preloaded with ones: zero-extended) and to memory, inserts from a GPR and memory
    for(const [name, op, size] of [["pextrb", 0x14, 1], ["pextrw", 0x15, 2], ["pextrd", 0x16, 4], ["extractps", 0x17, 4],
        ...long ? [["pextrq", 0x16, 8]] : []]) for(const memory of [false, true]) for(const imm8 of [0, 3, 6, 13])
    {
        const n = cases.length;
        cases.push({long, kind: "extract", name, op, size, memory, dst: base + n % 8, a: n % 16, imm8, offset: memory ? n & 7 : 0});
    }
    for(const [name, op, size] of [["pinsrb", 0x20, 1], ["pinsrd", 0x22, 4], ...long ? [["pinsrq", 0x22, 8]] : []])
        for(const memory of [false, true]) for(const imm8 of [0, 1, 7, 14])
    {
        const n = cases.length;
        cases.push({long, kind: "insert", name, op, size, memory, dst: base + n % 8, a: n % 16, b: (n + 9) % 16, imm8, offset: memory ? n & 7 : 0});
    }
    {
        const n = cases.length;
        cases.push({long, kind: "movntdqa", name: "movntdqa", op: 0x2A, memory: true, dst: base + n % 8, a: n % 16, b: (n + 4) % 16, imm8: 0, offset: 0});
    }
    // ROUND and DPPS/DPPD from the default MXCSR; its flags afterwards in the next slot
    for(const [name, op, double, scalar] of [["roundps", 0x08, false, false], ["roundpd", 0x09, true, false],
        ["roundss", 0x0A, false, true], ["roundsd", 0x0B, true, true]])
        for(const memory of [false, true]) for(const imm8 of [0, 1, 2, 3, 4, 8, 9, 10, 11, 12])
    {
        const n = cases.length;
        cases.push({long, kind: "round", name, op, double, scalar, memory, dst: base + n % 8, src: memory ? undefined : base + (n + 3) % 8,
            a: n % 16, b: double ? 19 + (n & 1) : 16 + n % 3, imm8, offset: 0});
        cases.push({long, kind: "mxcsr", name: name + " MXCSR"});
    }
    // ROUND from other MXCSR settings, which the page tier retries in the
    // interpreter: MXCSR.RC for imm8[2], DAZ with denormal lanes
    for(const [name, op, double, scalar] of [["roundss", 0x0A, false, true], ["roundpd", 0x09, true, false]])
        for(const [mxcsr, imm8s, b] of [[0x3F80, [4, 12, 1], double ? 19 : 16], [0x5F80, [4], double ? 19 : 17],
            [0x7F80, [12], double ? 20 : 16], [0x1FC0, [1, 2, 10], double ? 20 : 17]])
            for(const imm8 of imm8s)
    {
        const n = cases.length;
        cases.push({long, kind: "round", name, op, double, scalar, memory: n % 2 === 0, dst: base + n % 8, src: n % 2 === 0 ? undefined : base + (n + 3) % 8,
            a: n % 16, b, imm8, offset: 0, mxcsr});
        cases.push({long, kind: "mxcsr", name: name + " MXCSR"});
    }
    // (QEMU 10.2 propagates SSE NaNs as the x87 does, the larger significand
    // of two QNaNs: against it, at most one NaN product meets in an addition.
    // tests/rust/sse_fp.mjs checks every combination against the model.)
    const operands = [[16, 17, [0xFF, 0xF1, 0x3C, 0x81, 0x33, 0x12]], [17, 16, [0xFF, 0x5A]],
        [17, 18, [0x81, 0x3C, 0x12, 0x33]], [18, 16, [0x81, 0x3C, 0x12, 0x33]]];
    for(const [name, op, double] of [["dpps", 0x40, false], ["dppd", 0x41, true]])
        for(const memory of [false, true]) for(const [a, b, imms] of double ? [[19, 20, [0xFF, 0x31, 0x12, 0x23]], [20, 19, [0x33, 0x11]]] : operands) for(const imm8 of imms)
    {
        const n = cases.length;
        cases.push({long, kind: "dot", name, op, double, memory, dst: base + n % 8, src: memory ? undefined : base + (n + 3) % 8, a, b, imm8, offset: 0});
        cases.push({long, kind: "mxcsr", name: name + " MXCSR"});
    }
    // PCMPxSTRx: XMM0 (preset) in its slot, RCX/ECX (ones before) and the
    // flags in the next; explicit lengths in RAX/RDX with REX.W (o64), else
    // EAX/EDX (the low halves: other lengths)
    const lengths = [[5n, 3n], [-4n, 17n], [0x100000003n, -0x100000002n], [0xFFFFFFFFn, 0x80000000n], [-0x8000000000000000n, 7n]];
    for(const [name, op] of [["pcmpestrm", 0x60], ["pcmpestri", 0x61], ["pcmpistrm", 0x62], ["pcmpistri", 0x63]])
        for(const memory of [false, true])
            for(const [imm8, a, b] of [[0x00, 22, 21], [0x0C, 22, 21], [0x04, 23, 21], [0x48, 21, 22], [0x3B, 24, 24], [0x75, 24, 23], [0x18, 21, 21]])
                for(const w of long && op < 0x62 ? [false, true] : [false])
    {
        const n = cases.length;
        const [la, lb] = lengths[n % lengths.length];
        cases.push({long, kind: "pcmpstr", name, op, memory, w, dst: base + n % 8, src: memory ? undefined : base + (n + 3) % 8, a, b, imm8, la, lb,
            offset: memory ? n % 16 : 0});
        cases.push({long, kind: "registers", name: name + " RCX, flags"});
    }
    // CRC32 and POPCNT: [instruction, destination, its value before, the
    // source's register and its value (or a memory operand), the operation's
    // width]; the destination and the flags (set before) in the slot
    const ONES = 0xFFFFFFFF00000000n;
    const scalar = long ? [
        ["crc32 eax,byte [samples + 3]", "rax", ONES | 0x12345678n, undefined, 0n, 8],
        ["crc32 rax,byte [samples + 17]", "rax", ONES, undefined, 0n, 8],
        ["crc32 eax,word [samples + 33]", "rax", ONES | 0xFFFFFFFFn, undefined, 0n, 16],
        ["crc32 eax,dword [samples + 50]", "rax", ONES | 0x80000001n, undefined, 0n, 32],
        ["crc32 rax,qword [samples + 67]", "rax", ONES | 0x1n, undefined, 0n, 64],
        ["crc32 eax,ah", "rax", ONES | 0x0000C300n, undefined, 0n, 8],
        ["crc32 eax,sil", "rax", ONES | 0x5A5A5A5An, "rsi", 0x1234567890ABCDEFn, 8],
        ["crc32 r9d,r10w", "r9", ONES | 0xDEADBEEFn, "r10", 0xFEDCBA9876543210n, 16],
        ["crc32 r9,r10", "r9", ONES | 0xDEADBEEFn, "r10", 0xFEDCBA9876543210n, 64],
        ["crc32 r11d,ecx", "r11", ONES, "rcx", 0xFFFFFFFF00000000n, 32],
        ["popcnt ax,cx", "rax", ONES | 0x12345678n, "rcx", 0xFFFF0000FFFFFFFFn, 16],
        ["popcnt eax,ecx", "rax", ONES, "rcx", 0xFFFFFFFF00000000n, 32],
        ["popcnt rax,rcx", "rax", 0n, "rcx", 0x8000000000000001n, 64],
        ["popcnt r10,qword [samples + 160]", "r10", ONES, undefined, 0n, 64],
        ["popcnt r10w,word [samples + 177]", "r10", ONES, undefined, 0n, 16],
    ] : [
        ["crc32 eax,byte [samples + 5]", "eax", 0x12345678n, undefined, 0n, 8],
        ["crc32 eax,word [samples + 37]", "eax", 0xFFFFFFFFn, undefined, 0n, 16],
        ["crc32 eax,dword [samples + 71]", "eax", 0n, undefined, 0n, 32],
        ["crc32 eax,dh", "eax", 0x87654321n, "edx", 0x0000A500n, 8],
        ["crc32 eax,cx", "eax", 0x87654321n, "ecx", 0x12345678n, 16],
        ["crc32 ebx,ebx", "ebx", 0x55AA55AAn, undefined, 0n, 32],
        ["popcnt ax,word [samples + 177]", "eax", 0xFFFFFFFFn, undefined, 0n, 16],
        ["popcnt ecx,eax", "ecx", 0n, "eax", 0n, 32],
    ];
    for(const [instruction, dst, before, src, value, width] of scalar)
    {
        cases.push({long, kind: "scalar", name: instruction, instruction, dst, before, src, value, width});
    }
}
// (X64_SSE4_FILTER=text: only the cases whose name has it, for debugging)
if(process.env.X64_SSE4_FILTER)
{
    const kept = cases.filter((c, n) => c.name.includes(process.env.X64_SSE4_FILTER) || c.kind === "mxcsr" && cases[n - 1].name.includes(process.env.X64_SSE4_FILTER));
    cases.length = 0;
    cases.push(...kept);
}
const at = (i, offset = 0) => `[samples + ${i * 16 + offset}]`;
const code = (c, n) => {
    const x = r => "xmm" + r, out = RESULTS + n * 16;
    const lines = [];
    switch(c.kind)
    {
        case "binary":
            lines.push(`movdqu xmm0,${at(c.mask)}`, `movdqu ${x(c.dst)},${at(c.a)}`);
            if(!c.memory) lines.push(`movdqu ${x(c.src)},${at(c.b)}`);
            lines.push(`${c.name} ${x(c.dst)},${c.memory ? at(c.b, c.offset) : x(c.src)}`, `movdqu [${out}],${x(c.dst)}`);
            break;
        case "immediate":
            lines.push(`movdqu ${x(c.dst)},${at(c.a)}`);
            if(!c.memory) lines.push(`movdqu ${x(c.src)},${at(c.b)}`);
            lines.push(`${c.name} ${x(c.dst)},${c.memory ? at(c.b) : x(c.src)},${c.imm8}`, `movdqu [${out}],${x(c.dst)}`);
            break;
        case "ptest":
            lines.push(`movdqu ${x(c.dst)},${at(c.a)}`);
            if(!c.memory) lines.push(`movdqu ${x(c.src)},${at(c.b)}`);
            // (OF, SF, AF set by 0x7F + 1, CF by STC)
            lines.push("mov al,0x7F", "add al,1", "stc", `ptest ${x(c.dst)},${c.memory ? at(c.b) : x(c.src)}`);
            lines.push(c.long ? "pushfq\npop rax" : "pushfd\npop eax", "and eax,0x8D5", `mov [${out}],eax`);
            break;
        case "extract":
        {
            lines.push(`movdqu ${x(c.dst)},${at(c.a)}`);
            if(c.memory)
            {
                lines.push(`mov dword [${out}],0xEEEEEEEE`, `mov dword [${out + 4}],0xEEEEEEEE`, `mov dword [${out + 8}],0xEEEEEEEE`, `mov dword [${out + 12}],0xEEEEEEEE`);
                const width = ["", "byte", "word", "", "dword", "", "", "", "qword"][c.size];
                lines.push(`${c.name} ${width} [${out + c.offset}],${x(c.dst)},${c.imm8}`);
            }
            else
            {
                // (the register written, zero-extended: ones before)
                lines.push(c.long ? "mov rdx,-1" : "mov edx,-1");
                // (PEXTRW to a register: the SSE4.1 encoding, 66 0F 3A 15)
                if(c.op === 0x15)
                {
                    const rex = c.dst >= 8 ? [0x44] : [];
                    lines.push(`db 0x66, ${[...rex, 0x0F, 0x3A, 0x15, 0xC0 | (c.dst & 7) << 3 | 2, c.imm8].join(", ")}`);
                }
                else lines.push(`${c.name} ${c.size === 8 ? "rdx" : "edx"},${x(c.dst)},${c.imm8}`);
                lines.push(c.long ? `mov [${out}],rdx` : `mov [${out}],edx\nmov dword [${out + 4}],0`);
            }
            break;
        }
        case "insert":
            lines.push(`movdqu ${x(c.dst)},${at(c.a)}`);
            if(c.memory) lines.push(`${c.name} ${x(c.dst)},${["", "byte", "", "", "dword", "", "", "", "qword"][c.size]} ${at(c.b, c.offset)},${c.imm8}`);
            else lines.push(c.size === 8 ? `mov rdx,${at(c.b)}` : `mov edx,${at(c.b)}`, `${c.name} ${x(c.dst)},${c.size === 8 ? "rdx" : "edx"},${c.imm8}`);
            lines.push(`movdqu [${out}],${x(c.dst)}`);
            break;
        case "movntdqa":
            lines.push(`movntdqa ${x(c.dst)},${at(c.b)}`, `movdqu [${out}],${x(c.dst)}`);
            break;
        case "round": case "dot":
        {
            // (a scalar ROUND's memory operand: its lane)
            const width = c.scalar ? c.double ? "qword " : "dword " : "";
            lines.push(`ldmxcsr [mxcsr_values + ${4 * MXCSR_VALUES.indexOf(c.mxcsr ?? 0x1F80)}]`, `movdqu ${x(c.dst)},${at(c.a)}`);
            if(!c.memory) lines.push(`movdqu ${x(c.src)},${at(c.b)}`);
            lines.push(`${c.name} ${x(c.dst)},${c.memory ? width + at(c.b) : x(c.src)},${c.imm8}`, `movdqu [${out}],${x(c.dst)}`);
            lines.push(`stmxcsr [${out + 16}]`, `mov dword [${out + 20}],0`, `mov dword [${out + 24}],0`, `mov dword [${out + 28}],0`);
            break;
        }
        case "pcmpstr":
        {
            const [ax, dx, cx] = c.long ? ["rax", "rdx", "rcx"] : ["eax", "edx", "ecx"];
            const value = v => "0x" + BigInt.asUintN(c.long ? 64 : 32, v).toString(16);
            // (ECX counts the rounds)
            lines.push(`push ${cx}`, `movdqu xmm0,${at(5)}`, `movdqu ${x(c.dst)},${at(c.a)}`);
            if(!c.memory) lines.push(`movdqu ${x(c.src)},${at(c.b)}`);
            // (OF, SF, AF set by 0x7F + 1, CF by STC)
            lines.push("mov al,0x7F", "add al,1", "stc", `mov ${ax},${value(c.la)}`, `mov ${dx},${value(c.lb)}`, `mov ${cx},-1`);
            lines.push(`${c.w ? "o64 " : ""}${c.name} ${x(c.dst)},${c.memory ? at(c.b, c.offset) : x(c.src)},${c.imm8}`);
            lines.push(`mov [${out + 16}],${cx}`, ...c.long ? [] : [`mov dword [${out + 20}],0`]);
            lines.push(c.long ? "pushfq\npop rax" : "pushfd\npop eax", "and eax,0x8D5", `mov [${out + 24}],eax`, `mov dword [${out + 28}],0`);
            lines.push(`movdqu [${out}],xmm0`, `pop ${cx}`);
            break;
        }
        case "scalar":
            lines.push(c.long ? "push rcx" : "push ecx", "mov al,0x7F", "add al,1", "stc");
            if(c.src) lines.push(`mov ${c.src},0x${c.value.toString(16)}`);
            lines.push(`mov ${c.dst},0x${c.before.toString(16)}`, c.instruction, `mov [${out}],${c.dst}`, ...c.long ? [] : [`mov dword [${out + 4}],0`]);
            lines.push(c.long ? "pushfq\npop rax" : "pushfd\npop eax", "and eax,0x8D5", `mov [${out + 8}],eax`, `mov dword [${out + 12}],0`);
            lines.push(c.long ? "pop rcx" : "pop ecx");
            break;
        // (written by the case before)
        case "mxcsr": case "registers":
            break;
    }
    return lines.join("\n");
};
const block = long => cases.map((c, n) => c.long === long ? code(c, n) : "").filter(Boolean).join("\n");

// the faults: [vector, what, long, instruction, the vector QEMU raises instead]
const FAULT_CASES = [
    [13, "pminud xmm8,[misaligned]", true, "pminud xmm8,[samples + 8]"],
    // PTEST's m128 is of exception type 4 (SDM): legacy SSE raises #GP(0)
    // unless it is 16-byte aligned. QEMU 10.2 does not check (none).
    [13, "ptest xmm1,[misaligned]", false, "ptest xmm1,[samples + 4]", 0],
    [13, "movntdqa xmm9,[misaligned]", true, "movntdqa xmm9,[samples + 8]"],
    [13, "mpsadbw xmm2,[misaligned]", false, "mpsadbw xmm2,[samples + 12],5"],
    [7, "pmaxsd xmm10,xmm11 with CR0.TS", true, "pmaxsd xmm10,xmm11"],
    [7, "pextrd eax,xmm1 with CR0.TS", false, "pextrd eax,xmm1,1"],
    [6, "pblendw xmm1,xmm2 with CR0.EM", true, "pblendw xmm1,xmm2,3"],
    [6, "insertps xmm1,xmm2 with CR0.EM", false, "insertps xmm1,xmm2,0x10"],
    [6, "F3 pminud xmm1,xmm2", true, "db 0xF3, 0x66, 0x0F, 0x38, 0x3B, 0xCA"],
    [6, "F2 pextrb eax,xmm1", false, "db 0xF2, 0x66, 0x0F, 0x3A, 0x14, 0xC8, 1"],
    [6, "movntdqa xmm1,xmm2", true, "db 0x66, 0x0F, 0x38, 0x2A, 0xCA"],
    [6, "movntdqa xmm3,xmm4", false, "db 0x66, 0x0F, 0x38, 0x2A, 0xDC"],
    // (0: no fault. PCMPxSTRx: an m128 without alignment, SDM exception type
    // 4 note; CRC32 and POPCNT have no XMM state checks)
    [0, "pcmpistri xmm8,[misaligned]", true, "pcmpistri xmm8,[samples + 3],0x0C"],
    [0, "pcmpestrm xmm1,[misaligned]", false, "pcmpestrm xmm1,[samples + 9],0x40"],
    [7, "pcmpestri xmm1,xmm2 with CR0.TS", false, "pcmpestri xmm1,xmm2,0"],
    [6, "pcmpistrm xmm9,xmm10 with CR0.EM", true, "pcmpistrm xmm9,xmm10,0x40"],
    [0, "crc32 eax,ecx with CR0.TS", true, "crc32 eax,ecx"],
    [0, "crc32 rax,byte [x] with CR0.EM", true, "crc32 rax,byte [samples]"],
    [0, "crc32 eax,byte [x] with CR0.EM", false, "crc32 eax,byte [samples]"],
    [0, "popcnt eax,ecx with CR0.TS", false, "popcnt eax,ecx"],
    [6, "lock crc32 eax,ecx", true, "db 0xF0, 0xF2, 0x0F, 0x38, 0xF1, 0xC1"],
    [6, "F3 0F 38 F0", false, "db 0xF3, 0x0F, 0x38, 0xF0, 0xC1"],
];
const SET_CR0 = (bits, long) => long ? `mov rax,cr0\nor eax,${bits}\nmov cr0,rax` : `mov eax,cr0\nor eax,${bits}\nmov cr0,eax`;
const CLEAR_CR0 = long => long ? "mov rax,cr0\nand eax,~12\nmov cr0,rax" : "mov eax,cr0\nand eax,~12\nmov cr0,eax";
const faults = long => FAULT_CASES.map(([vector, what, in_long, instruction], n) => in_long !== long ? "" : `
${what.includes("CR0.TS") ? SET_CR0(8, long) : what.includes("CR0.EM") ? SET_CR0(4, long) : ""}
mov dword [${CASE}],${n}
mov dword [${SKIP}],fault_end${n} - fault${n}
fault${n}: ${instruction}
fault_end${n}:
${CLEAR_CR0(long)}
mov eax,fault${n}
cmp eax,[${FAULTS + n * 16 + 8}]
sete byte [${MATCH + n}]`).join("\n");

const directory = assemble("sse4", long_mode_guest(`
mov ebx,6
mov rax,HIGH+ud
call set_gate
mov ebx,7
mov rax,HIGH+nm
call set_gate
mov ebx,13
mov rax,HIGH+gp
call set_gate
lidt [rel idtr]
mov rax,cr4
or eax,3 << 9 ; OSFXSR, OSXMMEXCPT
mov cr4,rax
; 64-bit mode
mov ecx,${ROUNDS}
.rounds:
${block(true)}
dec ecx
jnz .rounds
${faults(true)}
; compatibility mode
push 8
mov rax,compat
push rax
o64 retf
bits 32
compat:
mov ecx,${COMPAT_ROUNDS}
.rounds:
${block(false)}
dec ecx
jnz .rounds
${faults(false)}
jmp 0x18:back
bits 64
back:
mov rax,HIGH+in_long_mode
jmp rax
in_long_mode:
`, `
set_gate:
mov rdi,rbx
shl rdi,4
add rdi,${IDT}
mov [rdi],ax
mov word [rdi + 2],0x18
mov word [rdi + 4],0x8E00
shr rax,16
mov [rdi + 6],ax
shr rax,16
mov [rdi + 8],eax
mov dword [rdi + 12],0
ret
ud:
mov ecx,6
jmp record
nm:
mov ecx,7
jmp record
gp:
add rsp,8
mov ecx,13
record:
mov edx,[${CASE}]
shl edx,4
mov [${FAULTS} + rdx],ecx
mov rax,[rsp]
mov [${FAULTS} + rdx + 8],rax
mov eax,[${SKIP}]
add [rsp],rax
iretq
align 8
idtr: dw 511
dq ${IDT}
mxcsr_values: dd ${MXCSR_VALUES.join(",")}
align 16
samples: db ${Array.from(samples).join(",")}
`));

const length = RESULTS - OUT + cases.length * 16;
// PCMPxSTRx by the model: XMM0 preset, then the destination and a register
// source. REX.W: the lengths in RAX and RDX (SDM); QEMU 10.2 does not pass
// REX.W to its helpers (target/i386/tcg/emit.c.inc, gen_PCMPESTRx) and takes
// EAX and EDX, a deviation (`qemu`)
const strings = (c, qemu = false) => {
    const registers = [];
    registers[0] = sample(5);
    registers[c.dst] = sample(c.a);
    if(!c.memory) registers[c.src] = sample(c.b);
    const b = c.memory ? samples.subarray(c.b * 16 + c.offset, c.b * 16 + c.offset + 16) : registers[c.src];
    const explicit = c.op < 0x62, width = c.w && !qemu ? 64 : 32;
    const r = compare_strings(c.imm8, registers[c.dst], b, explicit ? BigInt.asIntN(width, c.la) : undefined, explicit ? BigInt.asIntN(width, c.lb) : undefined);
    return {...r, xmm0: c.op & 1 ? registers[0] : r.mask};
};
// a register operand's name: its register, the bits' position and number
const register = name => {
    let m;
    if((m = /^r(\d+)([dwb]?)$/.exec(name))) return {key: "r" + m[1], shift: 0n, bits: {"": 64, d: 32, w: 16, b: 8}[m[2]]};
    if((m = /^([abcd])([hl])$/.exec(name))) return {key: m[1], shift: m[2] === "h" ? 8n : 0n, bits: 8};
    if((m = /^(si|di|bp|sp)l$/.exec(name))) return {key: m[1], shift: 0n, bits: 8};
    if((m = /^([re]?)([abcd])x$/.exec(name))) return {key: m[2], shift: 0n, bits: {r: 64, e: 32, "": 16}[m[1]]};
    if((m = /^([re]?)(si|di|bp|sp)$/.exec(name))) return {key: m[2], shift: 0n, bits: {r: 64, e: 32, "": 16}[m[1]]};
    throw new Error(`register ${name}`);
};
// CRC32 and POPCNT by the model: the destination register afterwards, the flags
const scalar_result = c => {
    const [, mnemonic, d, s] = /^(\S+) ([^,]+),(.+)$/.exec(c.instruction);
    const registers = {};
    if(c.src) registers[register(c.src).key] = c.value;
    registers[register(c.dst).key] = c.before;
    const memory = /\[samples \+ (\d+)\]/.exec(s);
    let source;
    if(memory) source = get(samples.subarray(+memory[1]), c.width / 8, 0);
    else
    {
        const r = register(s);
        source = registers[r.key] >> r.shift & (1n << BigInt(r.bits)) - 1n;
    }
    const old = registers[register(d).key];
    if(mnemonic === "crc32") return {value: crc32(old & 0xFFFFFFFFn, source, c.width / 8), flags: 0x891};
    const ones = BigInt(source.toString(2).split("1").length - 1);
    // (a 16-bit destination keeps the rest; a 32-bit one is zero-extended in 64-bit mode)
    const value = register(d).bits === 16 ? old & ~0xFFFFn | ones : ones;
    return {value: c.long ? value : value & 0xFFFFFFFFn, flags: source === 0n ? 0x40 : 0};
};
const floating = (c) => {
    if(c.kind === "dot") return dot_product(0x1F80, sample(c.a), sample(c.b), c.imm8, c.double);
    const fp = new Fp(c.mxcsr ?? 0x1F80), result = Uint8Array.from(sample(c.a)), size = c.double ? 8 : 4;
    for(let i = 0; i < (c.scalar ? 1 : 16 / size); i++) set(result, size, i, round_lane(fp, get(sample(c.b), size, i), c.double, c.imm8));
    return {result, mxcsr: fp.finish().mxcsr};
};
const expected_result = (c, n, qemu) => {
    const result = new Uint8Array(16);
    switch(c.kind)
    {
        case "round": case "dot":
            return floating(c).result;
        case "pcmpstr":
            return strings(c, qemu).xmm0;
        case "registers":
        {
            const c0 = cases[n - 1], r = strings(c0, qemu);
            set(result, 8, 0, c0.op & 1 ? BigInt(r.index) : c0.long ? 0xFFFFFFFFFFFFFFFFn : 0xFFFFFFFFn);
            set(result, 4, 2, BigInt((r.cf ? 1 : 0) | (r.zf ? 0x40 : 0) | (r.sf ? 0x80 : 0) | (r.of ? 0x800 : 0)));
            return result;
        }
        case "scalar":
        {
            const {value, flags} = scalar_result(c);
            set(result, 8, 0, value);
            set(result, 4, 2, BigInt(flags));
            return result;
        }
        case "mxcsr":
            set(result, 4, 0, BigInt(floating(cases[n - 1]).mxcsr));
            return result;
        case "binary":
        {
            // XMM0 loaded first, then the destination, then a register source
            const registers = [];
            registers[0] = sample(c.mask);
            registers[c.dst] = sample(c.a);
            if(!c.memory) registers[c.src] = sample(c.b);
            const bytes = BINARY.find(([name]) => name === c.name)[2] || 16;
            const source = c.memory ? Uint8Array.from({length: 16}, (_, i) => i < bytes ? samples[c.b * 16 + c.offset + i] : 0) : registers[c.src];
            return sse4_38(c.op, registers[c.dst], source, registers[0]);
        }
        case "immediate":
        {
            const s = sample(c.b), d = !c.memory && c.src === c.dst ? s : sample(c.a);
            return c.op === 0x21 && c.memory ? insertps(d, get(s, 4, 0), c.imm8) : sse4_3a(c.op, d, s, c.imm8);
        }
        case "ptest":
        {
            const s = sample(c.b), d = !c.memory && c.src === c.dst ? s : sample(c.a);
            const {zf, cf} = ptest(d, s);
            set(result, 4, 0, BigInt((zf ? 0x40 : 0) | (cf ? 1 : 0)));
            return result;
        }
        case "extract":
        {
            const value = extract(sample(c.a), c.size, c.imm8);
            if(c.memory)
            {
                result.fill(0xEE);
                set(result.subarray(c.offset), c.size, 0, value);
            }
            else set(result, 8, 0, value);
            return result;
        }
        case "insert":
        {
            const value = c.memory ? get(samples.subarray(c.b * 16 + c.offset), c.size, 0) : get(sample(c.b), c.size, 0);
            return insert(sample(c.a), c.size, value, c.imm8);
        }
        case "movntdqa":
            return sample(c.b);
    }
};
const check = (result, label) => {
    // the model first: QEMU is a reference, not the specification
    cases.forEach((c, n) => {
        const value = Uint8Array.from(result.subarray(RESULTS - OUT + n * 16, RESULTS - OUT + n * 16 + 16));
        assert.equal(hex(value), hex(expected_result(c, n, label === "QEMU")),
            `${label}: ${c.long ? "64-bit" : "compatibility"} ${["scalar", "registers", "mxcsr"].includes(c.kind) ? c.name : `${c.name} xmm${c.dst}, ${c.memory ? "[mem]" : c.src === undefined ? "r" : "xmm" + c.src} imm8=${c.imm8}`}`);
    });
    FAULT_CASES.forEach(([vector, what, , , qemu], n) => {
        const deviation = label === "QEMU" && qemu !== undefined;
        assert.equal(result.readUInt32LE(FAULTS - OUT + n * 16), deviation ? qemu : vector, `${label}: ${what}: vector`);
        assert.equal(result[MATCH - OUT + n], deviation && qemu === 0 || vector === 0 ? 0 : 1, `${label}: ${what}: RIP`);
    });
};
// v86 against QEMU, but for the fault records and the REX.W PCMPESTRx results where QEMU deviates
const comparable = buffer => {
    const copy = Buffer.from(buffer);
    cases.forEach((c, n) => {
        if(c.kind === "pcmpstr" && c.w) copy.fill(0, RESULTS - OUT + n * 16, RESULTS - OUT + n * 16 + 32);
    });
    FAULT_CASES.forEach(([, , , , qemu], n) => {
        if(qemu === undefined) return;
        copy.fill(0, FAULTS - OUT + n * 16, FAULTS - OUT + n * 16 + 16);
        copy[MATCH - OUT + n] = 0;
    });
    return copy;
};
const expected = await reference(directory, {length});
check(expected, "QEMU");
for(const [label, options, compat] of [["interpreted", {}, false],
    ["x64 page tier", {disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true}, false],
    // (Tier-0's compatibility-mode code: the page tier's is the default since M9)
    ["x64 page tier + compatibility-mode JIT", {disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true,
        jit_switches: {x64_page_compat32: 0}}, true],
    // (compatibility-mode code in the page tier, docs/jit-unification-plan.md P7.2)
    ["x64 page tier, compat32", {disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true,
        jit_switches: {x64_page_compat32: 1}}, false]])
{
    let page = 0, page32 = 0, tier0;
    const result = await actual(directory, {length, timeout: 180000, options: {cpu_features: ["SSSE3", "SSE4.1", "SSE4.2"], ...options},
        setup: emulator => {
            const x = emulator.v86.cpu.wm.exports;
            x.x64_set_compat_jit(compat);
            if(options.disable_jit === false)
            {
                x.ir_auto_set_idle_mode(0, 1);
                // (compile compatibility-mode pages at their first visit)
                assert.ok(x.ir_auto_set_page_threshold(1));
            }
        },
        inspect: emulator => {
            page = emulator.v86.cpu.wm.exports.x64_page_stat(1);
            page32 = emulator.v86.cpu.wm.exports.x64_page_stat(36);
            tier0 = emulator.v86.cpu.get_jit_info().ir?.tier0;
        }});
    check(result, label);
    assert.ok(comparable(result).equals(comparable(expected)), `${label}: equal to QEMU (but for its documented deviations)`);
    if(options.disable_jit === false) assert.ok(page > 1000, `${label}: compiled 64-bit code ran (${page})`);
    if(compat) assert.ok(tier0.activations > 0 && tier0.page_functions > 0, `${label}: compiled compatibility-mode code ran ${JSON.stringify(tier0)}`);
    if(options.jit_switches?.x64_page_compat32) assert.ok(page32 > 0, `${label}: the page tier compiled compatibility-mode code (${page32})`);
    console.log(`PASS (${label}): ${cases.length} SSE4 cases in 64-bit and compatibility mode, ${FAULT_CASES.length} faults, as QEMU and the SDM model`);
}

// The page tier has templates for the SSE4.1 forms of one Wasm SIMD operation,
// the blends with imm8 (register and aligned memory sources), ROUND and
// PCMPxSTRx: a hot loop of them runs without steps (x64_page_stat(4)),
// ROUNDPS setting PE. (R15 counts: PCMPISTRI writes ECX.)
const ITERATIONS = 100000;
const hot = assemble("sse4-hot", long_mode_guest(`
mov rax,cr4
or eax,3 << 9
mov cr4,rax
movdqu xmm9,[hot_samples]
mov r15d,${ITERATIONS}
.loop:
movdqu xmm8,[hot_samples + 16]
pminud xmm8,xmm9
pmaxsd xmm8,[hot_samples + 32]
movdqu xmm10,[hot_samples + 48]
pcmpgtq xmm10,xmm8
movdqu xmm11,[hot_samples + 64]
pmulld xmm11,xmm8
pblendw xmm11,[hot_samples + 80],0xA5
movdqu xmm12,[hot_samples + 96]
blendps xmm12,xmm10,5
packusdw xmm12,xmm11
movdqu xmm13,[hot_samples + 112]
roundsd xmm13,xmm13,9
movdqu xmm14,[hot_samples + 128]
roundss xmm14,[hot_samples + 132],10
roundps xmm15,[hot_samples + 128],0
movdqu xmm1,[hot_samples + 160]
pcmpistri xmm1,[hot_samples + 147],0x0C
movdqu xmm2,[hot_samples + 144]
mov eax,3
mov edx,-17
pcmpestrm xmm2,xmm1,0x40
dec r15d
jnz .loop
movdqu [${OUT + 16}],xmm8
movdqu [${OUT + 32}],xmm10
movdqu [${OUT + 48}],xmm11
movdqu [${OUT + 64}],xmm12
movdqu [${OUT + 80}],xmm13
movdqu [${OUT + 96}],xmm14
movdqu [${OUT + 112}],xmm15
stmxcsr [${OUT + 128}]
mov [${OUT + 132}],ecx
movdqu [${OUT + 144}],xmm0
`, `
align 16
hot_samples: db ${[...samples.subarray(0, 112), ...sample(19), ...sample(16), ...sample(21), ...sample(22), ...new Uint8Array(16)].join(",")}
`));
{
    let steps, retired;
    const result = await actual(hot, {length: 160, timeout: 60000,
        options: {cpu_features: ["SSSE3", "SSE4.1", "SSE4.2"], disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true},
        inspect: emulator => {
            steps = emulator.v86.cpu.wm.exports.x64_page_stat(4);
            retired = emulator.v86.cpu.wm.exports.x64_page_stat(1);
        }});
    const xmm8 = sse4_38(0x3D, sse4_38(0x3B, sample(1), sample(0)), sample(2));
    const xmm10 = sse4_38(0x37, sample(3), xmm8);
    const xmm11 = sse4_3a(0x0E, sse4_38(0x40, sample(4), xmm8), sample(5), 0xA5);
    const xmm12 = sse4_38(0x2B, sse4_3a(0x0C, sample(6), xmm10, 5), xmm11);
    const fp = new Fp(0x1F80);
    const rounded = (destination, source, double, lanes, imm8) => {
        const result = Uint8Array.from(destination), size = double ? 8 : 4;
        for(let i = 0; i < lanes; i++) set(result, size, i, round_lane(fp, get(source, size, i), double, imm8));
        return result;
    };
    const xmm13 = rounded(sample(19), sample(19), true, 1, 9);
    const xmm14 = rounded(sample(16), sample(16).subarray(4), false, 1, 10);
    const xmm15 = rounded(new Uint8Array(16), sample(16), false, 4, 0);
    for(const [register, value, at] of [[8, xmm8, 16], [10, xmm10, 32], [11, xmm11, 48], [12, xmm12, 64], [13, xmm13, 80], [14, xmm14, 96], [15, xmm15, 112]])
    {
        assert.equal(hex(result.subarray(at, at + 16)), hex(value), `hot loop: XMM${register}`);
    }
    assert.equal(result.readUInt32LE(128), fp.finish().mxcsr, "hot loop: MXCSR (PE from ROUNDPS)");
    // (the haystack at hot_samples + 147: sample 21 from byte 3, then sample 22)
    const haystack = Uint8Array.from([...sample(21).subarray(3), ...sample(22).subarray(0, 3)]);
    assert.equal(result.readUInt32LE(132), compare_strings(0x0C, sample(22), haystack).index, "hot loop: PCMPISTRI's ECX");
    assert.equal(hex(result.subarray(144, 160)), hex(compare_strings(0x40, sample(21), sample(22), 3n, -17n).mask), "hot loop: PCMPESTRM's XMM0");
    assert.ok(retired > ITERATIONS * 20 && steps < ITERATIONS / 10, `page tier templates: ${retired} retired, ${steps} steps`);
    console.log(`PASS (x64 page tier): SSE4.1 and SSE4.2 templates, ROUND and PCMPxSTRx included (${retired} instructions retired natively, ${steps} steps)`);
}

// The page tier's ROUND refuses MXCSR.DAZ and, for imm8[2], MXCSR.RC other
// than nearest (a retry: the runtime interprets it and runs on to an offset
// the function serves, here the loop's head, so a round retries once at
// least, x64::pages::unserved_run): in a compiled loop,
// a denormal lane rounds up to 0 with DAZ (1 without) and imm8 4 rounds down.
// The results of every round are summed: an execution the page tier got wrong
// shows even when the last round ran in the interpreter.
{
    const DAZ_ITERATIONS = 2000;
    const refusals = assemble("sse4-refusals", long_mode_guest(`
mov rax,cr4
or eax,3 << 9
mov cr4,rax
xorpd xmm4,xmm4
xorpd xmm5,xmm5
mov r15d,${DAZ_ITERATIONS}
.loop:
ldmxcsr [mxcsr_daz]
movdqu xmm1,[values]
roundpd xmm2,xmm1,2
addpd xmm4,xmm2
ldmxcsr [mxcsr_down]
roundpd xmm3,xmm1,4
addpd xmm5,xmm3
dec r15d
jnz .loop
ldmxcsr [mxcsr_default]
movdqu [${OUT + 16}],xmm4
movdqu [${OUT + 32}],xmm5
`, `
align 16
values: dq 1e-310, -2.5
mxcsr_daz: dd 0x1FC0
mxcsr_down: dd 0x3F80
mxcsr_default: dd 0x1F80
`));
    let retries;
    const result = await actual(refusals, {length: 48, timeout: 60000,
        options: {cpu_features: ["SSSE3", "SSE4.1", "SSE4.2"], disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true},
        setup: emulator => assert.ok(emulator.v86.cpu.wm.exports.ir_auto_set_page_threshold(1)),
        inspect: emulator => { retries = emulator.v86.cpu.wm.exports.x64_page_stat(2); }});
    const view = new DataView(new ArrayBuffer(16));
    view.setFloat64(0, 1e-310, true);
    view.setFloat64(8, -2.5, true);
    const values = new Uint8Array(view.buffer);
    // (the sums of small integers: exact)
    const summed = (mxcsr, imm8) => {
        const fp = new Fp(mxcsr), out = new DataView(new ArrayBuffer(16));
        for(let i = 0; i < 2; i++)
        {
            const lane = new DataView(new ArrayBuffer(8));
            lane.setBigUint64(0, round_lane(fp, get(values, 8, i), true, imm8), true);
            out.setFloat64(i * 8, lane.getFloat64(0, true) * DAZ_ITERATIONS, true);
        }
        return new Uint8Array(out.buffer);
    };
    assert.equal(hex(result.subarray(16, 32)), hex(summed(0x1FC0, 2)), "ROUNDPD with DAZ, summed");
    assert.equal(hex(result.subarray(32, 48)), hex(summed(0x3F80, 4)), "ROUNDPD with MXCSR.RC down, summed");
    assert.ok(retries > DAZ_ITERATIONS / 2, `page tier: the refused ROUNDs are retried (${retries} retries)`);
    console.log(`PASS (x64 page tier): ROUND refuses DAZ and MXCSR.RC (${retries} retries)`);
}
