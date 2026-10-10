#!/usr/bin/env node
// Random 32-bit programs in IA-32e compatibility mode (WOW64's), each looped
// until its code pages are compiled by the x64 page tier with
// x64_page_compat32 (docs/jit-unification-plan.md P7.2), then compared with
// the same guest run by the interpreters alone: the eight GPRs, EFLAGS and
// the data pages must be identical. As tests/x64/page_fuzz.mjs for 64-bit
// code: templated forms of every width, memory operands (base, index,
// absolute; LOCK RMW), the 32-bit stack, calls, forward branches, string
// instructions, interpreter steps and page-crossing accesses.
//
// COMPAT_FUZZ_SEED, COMPAT_FUZZ_CASES (per guest), COMPAT_FUZZ_GUESTS,
// COMPAT_FUZZ_ITERATIONS; COMPAT_FUZZ_VERBOSE=1 prints a differing case's
// program; COMPAT_FUZZ_SAVE=<file> with COMPAT_FUZZ_SAVE_GUEST and
// COMPAT_FUZZ_SAVE_CASE saves one ({init, lines}), COMPAT_FUZZ_BODY=<file>
// runs a saved one in every case (or with COMPAT_FUZZ_BODY_GUEST and
// COMPAT_FUZZ_BODY_CASE in that one)
import assert from "node:assert/strict";
import fs from "node:fs";
import {assemble} from "./guest_runner.mjs";
import {long_mode_guest} from "./guest_builder.mjs";
import {with_jit_switches} from "../lib/jit_switches.mjs";
import {setImmediate as yield_event} from "node:timers/promises";

let seed = Number(process.env.COMPAT_FUZZ_SEED || 1) >>> 0 || 1;
const random = () => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 0x100000000;
};
const pick = list => list[Math.floor(random() * list.length)];
const int = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1));

// ebp: data base (two pages at 0x500000); esp: the stack; the loop counter
// is in memory.
const GPR32 = ["eax", "ecx", "edx", "ebx", "esi", "edi"];
const NAMES = {eax: ["eax", "ax", "al"], ecx: ["ecx", "cx", "cl"], edx: ["edx", "dx", "dl"], ebx: ["ebx", "bx", "bl"],
    esi: ["esi", "si", null], edi: ["edi", "di", null]};
const WIDTHS = [32, 16, 8];
const SIZE = {32: "dword", 16: "word", 8: "byte"};
const BYTE = ["al", "cl", "dl", "bl", "ah", "ch", "dh", "bh"];
const reg = w => w === 8 ? pick(BYTE) : NAMES[pick(GPR32)][WIDTHS.indexOf(w)];
const DATA = 0x500000, COUNTER = 0x4FF000, RESULT = 0x300000, RECORD = 0x2200, MAGIC = 0xC064C064;
const mem = w => {
    const bytes = w / 8;
    const cross = random() < 0.04;
    const disp = cross ? 4096 - int(1, Math.max(1, bytes - 1)) : int(0, 8190 - bytes) & ~(random() < 0.7 ? bytes - 1 : 0);
    switch(int(0, 2))
    {
        case 0: return `${SIZE[w]} [ebp+${disp}]`;
        case 1: return `${SIZE[w]} [${DATA + disp}]`;
        default: return `${SIZE[w]} [ebp+${disp - 64}+64]`;
    }
};
const imm = w => {
    const v = [0, 1, -1, 0x7F, 0x80, 0x7FFF, 0x8000, 0x7FFFFFFF, -0x80000000, int(-1000, 1000), int(0, 0xFFFFFFFF) | 0][int(0, 10)];
    if(w === 8) return v & 0xFF;
    if(w === 16) return v & 0xFFFF;
    return v | 0;
};
const XMM = Array.from({length: 8}, (_, i) => `xmm${i}`);
// SSE memory operands: aligned forms get 16-byte aligned addresses;
// unaligned ones sometimes cross into the second page
const vmem = (bytes, aligned) => {
    let disp = int(0, 8190 - bytes);
    if(aligned) disp &= ~15;
    else if(random() < 0.1) disp = 4096 - int(1, bytes - 1);
    return random() < 0.5 ? `[ebp+${disp}]` : `[${DATA + disp}]`;
};
function sse_instruction()
{
    const a = pick(XMM), b = pick(XMM);
    return pick([
        `movdqu ${a}, ${vmem(16, false)}`, `movdqu ${vmem(16, false)}, ${a}`, `movups ${a}, ${vmem(16, false)}`, `movups ${vmem(16, false)}, ${a}`,
        `movupd ${a}, ${b}`, `movdqu ${a}, ${b}`, `movdqa ${a}, ${vmem(16, true)}`, `movdqa ${vmem(16, true)}, ${a}`,
        `movaps ${a}, ${b}`, `movaps ${a}, ${vmem(16, true)}`, `movapd ${vmem(16, true)}, ${a}`,
        `movss ${a}, ${b}`, `movss ${a}, ${vmem(4, false)}`, `movss ${vmem(4, false)}, ${a}`,
        `movsd ${a}, ${b}`, `movsd ${a}, ${vmem(8, false)}`, `movsd ${vmem(8, false)}, ${a}`,
        `movq ${a}, ${b}`, `movq ${a}, ${vmem(8, false)}`, `movq ${vmem(8, false)}, ${a}`,
        `movd ${a}, ${reg(32)}`, `movd ${reg(32)}, ${a}`, `movd ${a}, ${vmem(4, false)}`, `movd ${vmem(4, false)}, ${a}`,
        `${pick(["pxor", "por", "pand", "pandn", "xorps", "orps", "andps", "andnps", "xorpd", "andpd"])} ${a}, ${random() < 0.5 ? b : vmem(16, true)}`,
        `${pick(["paddd", "psubd", "paddw", "psubusb", "pcmpeqd", "pcmpgtw", "pmullw", "pmaxsw", "pminub", "pavgb", "punpcklbw", "punpckhdq", "packsswb", "pmaddwd", "psadbw"])} ${a}, ${random() < 0.5 ? b : vmem(16, true)}`,
        `${pick(["addps", "subps", "mulps", "divps", "minps", "maxps", "addsd", "mulsd", "subss", "divss", "sqrtps", "sqrtsd"])} ${a}, ${random() < 0.5 ? b : vmem(16, true)}`,
        `${pick(["psllw", "psrld", "psraw", "psrlq", "pslldq", "psrldq"])} ${a}, ${int(0, 20)}`,
        `pshufd ${a}, ${b}, ${int(0, 255)}`, `shufps ${a}, ${b}, ${int(0, 255)}`,
        `cvtsi2ss ${a}, ${reg(32)}`, `cvttss2si ${reg(32)}, ${a}`, `cvtdq2ps ${a}, ${b}`, `cvttps2dq ${a}, ${b}`, `cvtss2sd ${a}, ${b}`,
        `${pick(["comiss", "ucomiss", "comisd"])} ${a}, ${b}\nset${pick(CC)} al`,
        `pmovmskb ${reg(32)}, ${a}`, `movmskps ${reg(32)}, ${a}`, `pextrw ${reg(32)}, ${a}, ${int(0, 7)}`, `pinsrw ${a}, ${reg(32)}, ${int(0, 7)}`,
        `cmpps ${a}, ${b}, ${int(0, 7)}`,
    ]);
}
// MMX (the MM registers are the x87 mantissas): each result stored to the
// data, most snippets ending with EMMS (an empty stack for the x87 ones)
const MM = Array.from({length: 8}, (_, i) => `mm${i}`);
const PACKED_MMX = ["paddb", "paddw", "paddd", "paddq", "psubb", "psubw", "psubd", "psubq", "paddsb", "paddsw", "paddusb", "paddusw",
    "psubsb", "psubsw", "psubusb", "psubusw", "pmullw", "pmulhw", "pmulhuw", "pmaddwd", "pmuludq", "pand", "pandn", "por", "pxor",
    "pcmpeqb", "pcmpeqw", "pcmpeqd", "pcmpgtb", "pcmpgtw", "pcmpgtd", "packsswb", "packssdw", "packuswb", "punpcklbw", "punpcklwd",
    "punpckldq", "punpckhbw", "punpckhwd", "punpckhdq", "psrlw", "psrld", "psrlq", "psllw", "pslld", "psllq", "psraw", "psrad",
    "pavgb", "pavgw", "pminub", "pmaxub", "pminsw", "pmaxsw", "psadbw"];
function mmx_instruction()
{
    const a = pick(MM), b = pick(MM);
    const op = pick([
        `movq ${a}, ${random() < 0.5 ? b : `qword ${vmem(8, false)}`}`,
        `movq qword ${vmem(8, false)}, ${a}`,
        `movd ${a}, ${random() < 0.5 ? reg(32) : `dword ${vmem(4, false)}`}`,
        `movd ${random() < 0.5 ? reg(32) : `dword ${vmem(4, false)}`}, ${a}`,
        `${pick(PACKED_MMX)} ${a}, ${random() < 0.5 ? b : vmem(8, false)}`,
        `${pick(PACKED_MMX)} ${a}, ${b}`,
        `${pick(["psrlw", "psraw", "psllw", "psrld", "psrad", "pslld", "psrlq", "psllq"])} ${a}, ${pick([0, 1, int(0, 70)])}`,
        `pshufw ${a}, ${random() < 0.5 ? b : vmem(8, false)}, ${int(0, 255)}`,
    ]);
    return `${op}\nmovq qword ${vmem(8, false)}, ${a}` + (random() < 0.7 ? "\nemms" : "");
}
// x87 snippets that leave the stack as they found it (stores capture the
// results; the operands are whatever the data holds)
function x87_instruction()
{
    const m = w => `${SIZE[w] || (w === 64 ? "qword" : "")} ${vmem(w / 8, false)}`;
    return pick([
        `fld dword ${vmem(4, false)}\nf${pick(["add", "sub", "mul", "div", "subr", "divr"])} qword ${vmem(8, false)}\nfstp qword ${vmem(8, false)}`,
        `fld qword ${vmem(8, false)}\nf${pick(["add", "sub", "mul", "div"])} dword ${vmem(4, false)}\nfstp dword ${vmem(4, false)}`,
        `fild dword ${vmem(4, false)}\nfi${pick(["add", "mul", "sub"])} word ${vmem(2, false)}\nfistp dword ${vmem(4, false)}`,
        `fild word ${vmem(2, false)}\nfistp word ${vmem(2, false)}`,
        `fild qword ${vmem(8, false)}\nfistp qword ${vmem(8, false)}`,
        `fld1\nfldz\nfaddp st1, st0\nfld dword ${vmem(4, false)}\nfmulp st1, st0\nfstp dword ${vmem(4, false)}`,
        `fld qword ${vmem(8, false)}\nfld st0\nfmul st0, st1\nfxch st1\nfchs\nfabs\nfaddp st1, st0\nfstp qword ${vmem(8, false)}`,
        `fld dword ${vmem(4, false)}\nfcomp dword ${vmem(4, false)}\nfnstsw ax\nsahf\nset${pick(["b", "e", "be", "p"])} cl`,
        `fld qword ${vmem(8, false)}\nfld qword ${vmem(8, false)}\nf${pick(["comi", "ucomi"])}p st0, st1\nfstp st0\nset${pick(["b", "e", "a", "p"])} dl`,
        `fld dword ${vmem(4, false)}\nfld dword ${vmem(4, false)}\nfcmov${pick(["b", "e", "be", "u", "nb", "ne", "nbe", "nu"])} st0, st1\nfstp dword ${vmem(4, false)}\nfstp st0`,
        `fnstcw word ${vmem(2, false)}\nfld dword ${vmem(4, false)}\nfstp qword ${vmem(8, false)}`,
        // register-only runs (x86tpl::x87run; integer operands: magnitudes
        // where every operation shows): reversed forms, FST/FXCH, FFREE, and
        // a run whose guard fails (ST(5) empty: masked underflow)
        `fild word ${vmem(2, false)}\nfld1\nfld st1\nfdivr st0, st1\nfsubp st2, st0\nfxch st1\nfstp qword ${vmem(8, false)}\nfstp qword ${vmem(8, false)}`,
        `fild dword ${vmem(4, false)}\nfld st0\nfst st1\nfmul st0, st1\nfsub st0, st1\nfdiv st0, st1\nfstp qword ${vmem(8, false)}\nfstp qword ${vmem(8, false)}`,
        `fild word ${vmem(2, false)}\nfld st0\nfmul st0, st1\nfxch st1\nfchs\nfabs\nfsubrp st1, st0\nfstp qword ${vmem(8, false)}`,
        `fld1\nfldz\nfxch st1\nffree st1\nfstp qword ${vmem(8, false)}`,
        `fld st5\nfld st0\nfmulp st1, st0\nfstp qword ${vmem(8, false)}`,
        // stepped forms (FNSTENV, 80-bit stores) right after compiled ones:
        // they read the x87 state the open cache holds (closed at the step)
        `fild word ${vmem(2, false)}\nfld st0\nfmul st0, st1\nfnstenv ${vmem(28, false)}\nfstp qword ${vmem(8, false)}\nfstp qword ${vmem(8, false)}`,
        `fild dword ${vmem(4, false)}\nfld1\nfaddp st1, st0\nfld st0\nfstp tword ${vmem(10, false)}\nfstp qword ${vmem(8, false)}`,
    ]);
}
const CC = ["o", "no", "b", "ae", "e", "ne", "be", "a", "s", "ns", "p", "np", "l", "ge", "le", "g"];
const ALU = ["add", "or", "adc", "sbb", "and", "sub", "xor", "cmp"];
const rm = w => random() < 0.5 ? reg(w) : mem(w);

// (COMPAT_FUZZ_SKIP=15,16: generate none of those cases)
const SKIP = new Set((process.env.COMPAT_FUZZ_SKIP || "").split(",").filter(Boolean).map(Number));
function instruction(state)
{
    const w = pick(WIDTHS);
    const alu = pick(ALU);
    const w16 = pick([16, 32]);
    let which = int(0, 57);
    while(SKIP.has(which)) which = int(0, 57);
    switch(which)
    {
        case 0: case 1: return `${alu} ${reg(w)}, ${reg(w)}`;
        case 2: return `${alu} ${reg(w)}, ${imm(w)}`;
        case 3: return `${alu} ${reg(w)}, ${mem(w)}`;
        case 4: return `${random() < 0.3 && alu !== "cmp" ? "lock " : ""}${alu} ${mem(w)}, ${reg(w)}`;
        case 5: return `${alu} ${mem(w)}, ${imm(w)}`;
        case 6: return `test ${reg(w)}, ${random() < 0.5 ? imm(w) : reg(w)}`;
        case 7: return `mov ${reg(w)}, ${imm(w)}`;
        case 8: return `mov ${reg(w)}, ${mem(w)}`;
        case 9: return `mov ${mem(w)}, ${random() < 0.5 ? reg(w) : imm(w)}`;
        case 10: return pick([`movzx ${reg(32)}, ${pick([reg(8), mem(8), reg(16), mem(16)])}`,
            `movsx ${reg(pick([16, 32]))}, ${pick([reg(8), mem(8)])}`, `movsx ${reg(32)}, ${pick([reg(16), mem(16)])}`]);
        case 11: return `lea ${reg(pick([32, 16]))}, [${reg(32)}+${reg(32)}*${pick([1, 2, 4, 8])}+${int(-2000, 2000)}]`;
        case 12: { const op = pick(["inc", "dec", "neg", "not"]); return random() < 0.5 ? `${op} ${reg(w)}` : `${random() < 0.3 ? "lock " : ""}${op} ${mem(w)}`; }
        case 13: return `${pick(["shl", "shr", "sar", "rol", "ror"])} ${random() < 0.7 ? reg(w) : mem(w)}, ${pick([1, int(0, 40), int(0, 7)])}`;
        case 14: return `${pick(["shl", "shr", "sar", "rol", "ror", "rcl", "rcr"])} ${random() < 0.8 ? reg(w) : mem(w)}, cl`;
        case 15: return `imul ${reg(w16)}, ${rm(w16)}${random() < 0.5 ? ", " + imm(16) : ""}`;
        case 16: return `${pick(["mul", "imul"])} ${rm(32)}`;
        case 17: return pick([`mov ebx, ${int(3, 0x7FFFFFF0) | 3}\nxor edx, edx\ndiv ebx`, `mov ebx, ${int(3, 0x7FFFFFF0) | 3}\ncdq\nidiv ebx`,
            (at => `or dword [ebp+${at}], 3\nxor edx, edx\ndiv dword [ebp+${at}]`)(int(0, 8000) & ~3)]);
        case 18: { const r = reg(32); return `push ${pick([r, reg(32), mem(32), String(imm(32))])}\npop ${r}`; }
        case 19: return `cmov${pick(CC)} ${reg(w16)}, ${rm(w16)}`;
        case 20: return `set${pick(CC)} ${random() < 0.6 ? reg(8) : mem(8)}`;
        case 21: { const n = state.labels++; return `j${pick(CC)} .s${n}\n${simple()}\n${simple()}\n.s${n}:`; }
        case 22: return `xchg ${reg(w)}, ${rm(w)}`;
        case 23: return `${random() < 0.5 ? "lock " : ""}xadd ${mem(w)}, ${reg(w)}`;
        case 24: return random() < 0.5 ? `cmpxchg ${reg(w)}, ${reg(w)}` : `lock cmpxchg ${mem(w)}, ${reg(w)}`;
        case 25: return pick(["cbw", "cwde", "cwd", "cdq"]);
        case 26: return `${pick(["bt", "bts", "btr", "btc"])} ${reg(w16)}, ${random() < 0.5 ? int(0, 255) : reg(w16)}`;
        case 27: return `${pick(["bsf", "bsr"])} ${reg(w16)}, ${rm(w16)}`;
        case 28: return `bswap ${reg(32)}`;
        case 29: return pick(["clc", "stc", "cmc", "lahf", "sahf", "cld", "std", "nop", "pushfd\npop eax", "xchg eax, eax"]);
        case 30: return `call ${pick(["leaf_near", "leaf_far"])}`;
        case 31: return pick(["cpuid", "mov eax, ds", `mov word [ebp+${int(0, 8000)}], ss`, "pause"]);
        case 32: { const op = pick(["movsb", "movsw", "movsd", "stosb", "stosw", "stosd", "cmpsb", "cmpsw", "cmpsd", "scasb", "scasw", "scasd"]);
            const src = int(0, 7000), dst = random() < 0.3 ? src + int(-16, 16) : int(0, 7000), count = pick([0, 1, int(2, 16), int(17, 300)]);
            const prefix = random() < 0.8 ? (/^(cmps|scas)/.test(op) ? pick(["repe ", "repne "]) : "rep ") : "";
            return `lea esi, [ebp+${src}]\nlea edi, [ebp+${Math.max(0, dst)}]\nmov ecx, ${count}\n${random() < 0.2 ? "std\n" : ""}${prefix}${op}\ncld`; }
        case 33: return `test ${mem(w)}, ${random() < 0.5 ? imm(w) : reg(w)}`;
        case 34: return `cmp ${reg(w)}, ${mem(w)}\nj${pick(CC)} .c${state.labels}\ninc edi\n.c${state.labels++}:`;
        case 35: return `sub ${reg(w)}, ${imm(8)}\nset${pick(CC)} al`;
        case 36: { const r = reg(32); return `xor ${r}, ${r}`; }
        case 37: return `and ebx, 255\n${alu} ${reg(32)}, [ebp+ebx*${pick([1, 2, 4])}+${int(0, 7000)}]`;
        case 38: return `and ecx, 255\nmov ${pick(["eax", "edx", "esi"])}, [ebp+ecx*4+${int(0, 7000)}]`;
        // a shift's SF, ZF and PF read only after leaving the page (leaf_far
        // keeps them): pending in the lazy record at the exit
        case 39: return `${pick(["shl", "shr", "sar"])} ${reg(32)}, ${pick([int(1, 31), "cl"])}\ncall leaf_far\n${pick([`set${pick(["z", "nz", "s", "ns", "p", "np", "b", "o", "le", "g"])} ${reg(8)}`, "pushfd\npop eax", "lahf"])}`;
        case 40: case 41: case 42: case 43: case 44: return sse_instruction();
        case 45: case 46: case 47: return x87_instruction();
        case 55: case 56: case 57: return mmx_instruction();
        // indirect transfers inside the loop to its own code: a CALL and RET
        // in the page, a jump table (dispatched by the loop's head, P7.2)
        case 48: { const n = state.labels++; return `call .f${n}\njmp .e${n}\n.f${n}:\n${simple()}\nret\n.e${n}:`; }
        // bit scans, counts, SHLD/SHRD and BMI (the 32-bit interpreter's
        // flags: BSF/BSR and SHLD/SHRD leave lazy ones), sources often small
        // or 0, then a condition on what they set
        case 50: case 52: case 53: {
            const t = pick(GPR32.filter(r => r !== "ecx"));
            // (added up in the data the test compares: registers are often
            // overwritten, and XOR or a byte store keeps only some rounds)
            const set = cc => (random() < 0.5 ? `\nset${pick(cc)} al\nmovzx eax, al` : `\npushfd\npop eax`) +
                `\nadd dword [ebp+${int(0, 8188) & ~3}], eax`;
            return pick([
                `and ${t}, ${int(0, 3)}\n${pick(["bsf", "bsr"])} ${reg(32)}, ${t}${set(["z", "nz", "p", "np", "s", "o", "b"])}`,
                `${pick(["bsf", "bsr"])} ${reg(w16)}, ${rm(w16)}${set(["z", "nz", "p", "o"])}`,
                `and ${t}, ${int(0, 3)}\npopcnt ${reg(32)}, ${t}${set(["z", "nz", "b", "p", "o"])}`,
                `and ${t}, ${pick([0, 0xFF, 0xFFFF0000])}\n${pick(["tzcnt", "lzcnt"])} ${reg(32)}, ${t}${set(["z", "nz", "b", "ae", "s"])}`,
                `${pick(["shld", "shrd"])} ${rm(32)}, ${reg(32)}, ${pick([1, 2, int(0, 31), 31])}${set(["o", "no", "b", "ae", "z", "s", "p"])}`,
                // (operands loaded first: the program's values are often small)
                (([d, r]) => `mov ${d}, 0x${(int(0, 0xFFFFFFFF) >>> 0).toString(16)}\nmov ${r}, 0x${(int(0, 0xFFFFFFFF) >>> 0).toString(16)}\n` +
                    `${pick(["shld", "shrd"])} ${d}, ${r}, ${int(1, 31)}${set(["o", "no", "b", "ae", "z", "s", "p"])}`)(pick([["ebx", "esi"], ["edi", "edx"], ["esi", "ebx"]])),
                `${pick(["shld", "shrd"])} ${rm(w16)}, ${reg(w16)}, cl`,
                (([d, r]) => `mov ${d}, 0x${(int(0, 0xFFFFFFFF) >>> 0).toString(16)}\nmov ${r}, 0x${(int(0, 0xFFFFFFFF) >>> 0).toString(16)}\n` +
                    `mov cl, ${pick([2, 3, 5, 9, 30, 34])}\n${pick(["shld", "shrd"])} ${d}, ${r}, cl${set(["o", "no"])}`)(pick([["ebx", "esi"], ["edi", "edx"], ["esi", "ebx"]])),
                (([d, r]) => `mov ${d}, 0x${(int(0, 0xFFFFFFFF) >>> 0).toString(16)}\nmov ${r}, 0x${(int(0, 0xFFFFFFFF) >>> 0).toString(16)}\n` +
                    `mov cl, ${pick([0, 1, 2, int(0, 255), 31, 32, 33])}\n${pick(["shld", "shrd"])} ${d}, ${r}, cl${set(["o", "no", "b", "ae", "z", "s", "p"])}`)(pick([["ebx", "esi"], ["edi", "edx"], ["esi", "ebx"]])),
            ]);
        }
        case 51: case 54: {
            const t = pick(GPR32);
            // (added up in the data the test compares: registers are often
            // overwritten, and XOR or a byte store keeps only some rounds)
            const set = cc => (random() < 0.5 ? `\nset${pick(cc)} al\nmovzx eax, al` : `\npushfd\npop eax`) +
                `\nadd dword [ebp+${int(0, 8188) & ~3}], eax`;
            return pick([`and ${t}, ${int(0, 3)}\nandn ${reg(32)}, ${reg(32)}, ${t}`, `and ${t}, ${int(0, 3)}\n${pick(["blsr", "blsmsk", "blsi"])} ${reg(32)}, ${t}`,
                `bzhi ${reg(32)}, ${rm(32)}, ${reg(32)}`, `${pick(["shlx", "sarx", "shrx"])} ${reg(32)}, ${rm(32)}, ${reg(32)}`,
                `rorx ${reg(32)}, ${rm(32)}, ${int(0, 31)}`]) + set(["z", "nz", "b", "ae", "s", "o"]);
        }
        case 49: {
            const n = state.labels++, r = pick(["ebx", "edx", "esi"]);
            return `mov ${r}, ${reg(32)}\nand ${r}, 3\njmp [.t${n}+${r}*4]\n.t${n}: dd .a${n}, .b${n}, .c${n}, .d${n}\n` +
                ["a", "b", "c", "d"].map(l => `.${l}${n}:\n${simple()}\njmp .e${n}`).join("\n") + `\n.e${n}:`;
        }
        default: return `${pick(["add", "sub", "and", "or", "xor", "adc", "sbb"])} ${mem(w)}, ${imm(w)}`;
    }
}
function simple()
{
    return pick([`add ${reg(32)}, ${int(0, 99)}`, `xor ${reg(32)}, ${reg(32)}`, `inc ${mem(32)}`, `mov ${reg(16)}, ${mem(16)}`]);
}

const cases = Number(process.env.COMPAT_FUZZ_CASES || 12);
const guests = Number(process.env.COMPAT_FUZZ_GUESTS || 4);
const ITERATIONS = Number(process.env.COMPAT_FUZZ_ITERATIONS || 300);
let failures = 0, native_total = 0, compat_compiles = 0;
for(let guest = 0; guest < guests; guest++)
{
    const first_seed = seed;
    // 64-bit code: each case in compatibility mode, back by a far jump
    let body = "mov rax, cr4\nor eax, 0x600\nmov cr4, rax\n";
    let functions = "";
    const programs = [];
    for(let c = 0; c < cases; c++)
    {
        const state = {labels: 0};
        let lines = Array.from({length: int(20, 70)}, () => instruction(state));
        let init = GPR32.map(r => `mov ${r}, 0x${(int(0, 0xFFFFFFFF) >>> 0).toString(16)}`).join("\n");
        // (COMPAT_FUZZ_BODY_GUEST and COMPAT_FUZZ_BODY_CASE: only there; the
        // others stay as the seed makes them)
        const target = (name, n) => process.env[name] === undefined || +process.env[name] === n;
        if(process.env.COMPAT_FUZZ_BODY && target("COMPAT_FUZZ_BODY_GUEST", guest) && target("COMPAT_FUZZ_BODY_CASE", c))
            ({init, lines} = JSON.parse(fs.readFileSync(process.env.COMPAT_FUZZ_BODY, "utf8")));
        if(process.env.COMPAT_FUZZ_SAVE && +process.env.COMPAT_FUZZ_SAVE_GUEST === guest && +process.env.COMPAT_FUZZ_SAVE_CASE === c)
            fs.writeFileSync(process.env.COMPAT_FUZZ_SAVE, JSON.stringify({init, lines}, null, 1));
        programs.push(init + "\n.loop:\n" + lines.join("\n"));
        body += `mov rax, HIGH+after_${c}\nmov [0x2FF000], rax\npush 8\nmov eax, case_${c}\npush rax\no64 retf\nafter_${c}:\n`;
        functions += `
align 4096
case_${c}:
fninit
${init}
${XMM.map((x, i) => `movdqu ${x}, [xmm_init_${c}+${i * 16}]`).join("\n")}
mov ebp, ${DATA}
mov dword [${COUNTER}], ${ITERATIONS}
push 0x${(int(0, 0xFFF) & 0xCD5).toString(16)}
popfd
.loop:
${lines.join("\n")}
dec dword [${COUNTER}]
jnz .loop
${["eax", "ecx", "edx", "ebx", "esi", "edi", "ebp", "esp"].map((r, i) => `mov [${RESULT + 8 + c * RECORD + i * 4}], ${r}`).join("\n")}
pushfd
pop eax
mov [${RESULT + 8 + c * RECORD + 32}], eax
cld
mov esi, ${DATA}
mov edi, ${RESULT + 8 + c * RECORD + 256}
mov ecx, 8192
rep movsb
${XMM.map((x, i) => `movdqu [${RESULT + 8 + c * RECORD + 8448 + i * 16}], ${x}`).join("\n")}
mov edi, ${DATA}
mov ecx, 8192
mov al, 0x5A
rep stosb
jmp 0x18:back_to_64
align 16
xmm_init_${c}:
${Array.from({length: 32}, () => `dd 0x${(int(0, 0xFFFFFFFF) >>> 0).toString(16)}`).join("\n")}
`;
    }
    const source = long_mode_guest(body, `
bits 32
${functions}
align 4096
leaf_near:
add esi, 7
xor edi, esi
ret
align 4096
leaf_far:
lea esi, [esi+edi*2+3]
ror edi, 5
ret
bits 64
back_to_64:
jmp [0x2FF000]
`);
    const dir = assemble(`compat-fuzz-${guest}`, source.replace("high_mode:\n", `high_mode:\nmov rdi, ${DATA}\nmov ecx, 8192\nmov al, 0x5A\nrep stosb\n`));
    const length = 8 + cases * RECORD;
    const run = async jit => {
        const {V86} = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
        // (JIT_SWITCHES adds switches, e.g. x64_loops=1 for loops in cold compiles)
        const emulator = new V86(with_jit_switches({graphics_adapter: "bochs_vga", multiboot: {url: dir + "guest.bin"}, memory_size: 32 << 20, acpi: true,
            disable_jit: !jit, experimental_smp_jit: true, ir_sync_publication: true, autostart: false, log_level: 0,
            cpu_type: "x86_64", cpu_features: ["BMI1", "BMI2", "LZCNT", "MOVBE"], cpu_features_unreleased: true,
            jit_switches: {x64_page_compat32: 1}}));
        try
        {
            await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
            const cpu = emulator.v86.cpu;
            // (COMPAT_FUZZ_RECORD=<dir>: the compiled run's page functions,
            // with TEST_RELEASE_BUILD=1 and a build/v86.wasm with ir-test-hooks)
            const record = jit && process.env.COMPAT_FUZZ_RECORD && cpu.wm.exports.x64_page_record_start;
            if(record) cpu.wm.exports.x64_page_record_start();
            const deadline = performance.now() + 120000;
            let rounds = 0;
            while(new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).getUint32(RESULT, true) !== MAGIC)
            {
                if(performance.now() > deadline) throw new Error("guest timed out: " + JSON.stringify(cpu.get_diagnostics()));
                cpu.run_cores();
                if((++rounds & 63) === 0) await yield_event();
            }
            const x = cpu.wm.exports;
            if(record)
            {
                fs.mkdirSync(process.env.COMPAT_FUZZ_RECORD, {recursive: true});
                for(let i = 0, n = x.x64_page_record_count(); i < n; i++)
                {
                    const bytes = new Uint8Array(x.memory.buffer, x.x64_page_record_address(i), x.x64_page_record_length(i)).slice();
                    new Uint8Array(x.memory.buffer, x.x64_page_replay_input(bytes.length), bytes.length).set(bytes);
                    const length = x.x64_page_replay();
                    fs.writeFileSync(`${process.env.COMPAT_FUZZ_RECORD}/g${guest}_${i}.wasm`, new Uint8Array(x.memory.buffer, x.x64_page_replay_output(), length));
                }
            }
            return {result: Buffer.from(cpu.mem8.slice(RESULT, RESULT + length)), native: jit ? x.x64_page_stat(1) : 0,
                compat_compiles: jit ? x.x64_page_stat(36) : 0, stats: jit ? Array.from({length: 13}, (_, i) => x.x64_page_stat(i)) : []};
        }
        finally { await emulator.destroy(); }
    };
    const reference = await run(false);
    const compiled = await run(true);
    native_total += compiled.native;
    compat_compiles += compiled.compat_compiles;
    for(let c = 0; c < cases; c++)
    {
        const at = 8 + c * RECORD;
        const a = reference.result.subarray(at, at + RECORD), b = compiled.result.subarray(at, at + RECORD);
        if(!a.equals(b))
        {
            failures++;
            const names = ["eax", "ecx", "edx", "ebx", "esi", "edi", "ebp", "esp", "eflags"];
            const diffs = [];
            for(let i = 0; i < 9; i++) if(a.readUInt32LE(i * 4) !== b.readUInt32LE(i * 4)) diffs.push(`${names[i]}: interpreter ${a.readUInt32LE(i * 4).toString(16)} page ${b.readUInt32LE(i * 4).toString(16)}`);
            for(let i = 256; i < 256 + 8192; i++) if(a[i] !== b[i]) { diffs.push(`data+${i - 256}: ${a[i].toString(16)} vs ${b[i].toString(16)}`); if(diffs.length > 24) break; }
            for(let i = 0; i < 8; i++) if(!a.subarray(8448 + i * 16, 8464 + i * 16).equals(b.subarray(8448 + i * 16, 8464 + i * 16)))
                diffs.push(`xmm${i}: interpreter ${a.subarray(8448 + i * 16, 8464 + i * 16).toString("hex")} page ${b.subarray(8448 + i * 16, 8464 + i * 16).toString("hex")}`);
            console.log(`FAIL guest ${guest} (seed ${first_seed}) case ${c}:\n  ` + diffs.join("\n  "));
            if(process.env.COMPAT_FUZZ_VERBOSE) console.log(programs[c]);
        }
    }
    console.log(`guest ${guest} (seed ${first_seed}): ${cases} cases, native retired ${compiled.native}, compat compiles ${compiled.compat_compiles}, stats ${JSON.stringify(compiled.stats)}`);
    assert.ok(compiled.compat_compiles > 0 && compiled.native > cases * ITERATIONS * 5, "the page tier executed the 32-bit loops");
}
assert.equal(failures, 0, `${failures} cases differ`);
console.log(`PASS compat fuzz: ${guests * cases} 32-bit programs identical to the interpreter (${native_total} native instructions, ${compat_compiles} compatibility-mode compiles)`);
