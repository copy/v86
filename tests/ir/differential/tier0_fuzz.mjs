#!/usr/bin/env node
// Legacy-mode differential fuzzing: random integer/SSE/x87 instruction
// sequences run hot in a loop (so their page is compiled by the x64 page tier,
// x64_page_legacy32, docs/jit-unification-plan.md P7.3; written for IR Tier-0,
// deleted in P7.5) and must leave exactly the interpreter's state: GPRs,
// EFLAGS (including the rarely read AF/OF, captured by PUSHFD/LAHF inside the
// loop), memory, XMM and x87 registers, and the retired-instruction count.
// Each program must also have entered page functions, and most of all
// programs' instructions must have run in them: else the comparison proves
// nothing about the page tier.
//
//   node tests/ir/differential/tier0_fuzz.mjs [cases=40] [seed=1] [wasm]
// Needs build/bench/boot.bin (make bench-build): flat protected mode, paging.
// FUZZ_STRADDLE=1 places each program across a page boundary (multi-page
// functions, P7.3b). Debugging: FUZZ_DEBUG=1 prints each case's MXCSR and
// code, FUZZ_BODY=<hex> replaces the random instructions. JIT_SWITCHES applies
// to the compiled machine (tests/lib/jit_switches.mjs). FUZZ_COVERAGE=<share>
// lowers the share of instructions that must run in page functions (0.5).
// FUZZ_SS16=1 runs the programs on a 16-bit stack (SS.B clear, a 64 KiB
// segment at SS16; half the cases start at SP 0xFFF0, half at SP 8, whose
// pushes wrap): 32-bit code on a 16-bit stack, as Windows 98's thunks (M11).
import fs from "node:fs";
import assert from "node:assert/strict";
import { V86 } from "../../../build/libv86.mjs";
import { jit_switches_from_env } from "../../lib/jit_switches.mjs";

const cases = Number(process.argv[2] || 40);
let seed = Number(process.argv[3] || 1) >>> 0;
const wasm = process.argv[4] || "build/v86.wasm";
const manifest = JSON.parse(fs.readFileSync("build/bench/manifest.json", "utf8"));
const boot = fs.readFileSync(manifest.boot);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// (a program's first instructions run interpreted until its page is hot; FP
// programs also reload MXCSR, interpreted, at the top, and the page tier
// must recompile the page with an entry after it)
const CODE = 0x500000, DATA = 0x600000, STACK = 0x610000, SS16 = 0x640000, ITERATIONS = 50000;
const random = () => {
    seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
    return seed;
};
const pick = list => list[random() % list.length];
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
// EBX holds DATA (never written); ESP the stack. Byte registers exclude BL/BH.
const REGS = [0, 1, 2, 5, 6, 7];
const BYTE_REGS = [0, 1, 2, 4, 5, 6];
const reg = () => pick(REGS);
const disp = () => random() % 28 * 4;                    // [ebx + disp8], 0..108 (signed disp8)
const mem = r => [0x43 | r << 3, disp()];                 // modrm for [ebx + disp8]
const rr = (r, m) => 0xC0 | r << 3 | m;

// FUZZ_KIND=i0..i33 / s0..s13 restricts programs to one instruction kind
// (s11: SSE floating point over special values, see fp_instruction; s13: VEX
// forms among legacy ones, see vex_instruction; b: BMI, see bmi_instruction;
// j, g, e, d, o, a, m, v, c, p: P3.7's templates, r: P3.1's, see
// p37_instruction).
const only = process.env.FUZZ_KIND || "";
const straddle = process.env.FUZZ_STRADDLE === "1";
const ss16 = process.env.FUZZ_SS16 === "1";
function instruction() {
    const op = random() % 8, r = reg(), m = reg();
    const kind = random() % 34;
    switch(only.startsWith("i") ? Number(only.slice(1)) : kind) {
        case 0: return [op << 3 | 1, rr(r, m)];                                  // ALU r/m32, r32
        case 1: return [0x81, rr(op, m), ...u32(random())];                       // ALU r/m32, imm32
        case 2: return [0x83, rr(op, m), random() & 255];                         // ALU r/m32, imm8
        case 3: return [op << 3 | 3, ...mem(r)];                                  // ALU r32, m32
        case 4: return [op << 3 | 1, ...mem(r)];                                  // ALU m32, r32
        case 5: return [op << 3, rr(pick(BYTE_REGS), pick(BYTE_REGS))];          // ALU r/m8, r8
        case 6: return [0x66, op << 3 | 1, rr(r, m)];                             // ALU r/m16, r16
        case 7: return [0x80, rr(op, pick(BYTE_REGS)), random() & 255];           // ALU r/m8, imm8
        case 8: return [pick([0x40, 0x48]) | r];                                   // INC/DEC r32
        case 9: return [0xFF, 0x43 | (random() & 1) << 3, disp()];                // INC/DEC m32
        case 10: return [0xF7, rr(pick([2, 3]), m)];                              // NOT/NEG
        case 11: return [0xC1, rr(op, m), random() & 63];                         // shift/rotate imm
        case 12: return [0xD1, rr(op, m)];                                        // shift/rotate 1
        case 13: return [0xD3, rr(op, m)];                                        // shift/rotate CL
        case 14: return [0xC0, rr(op, pick(BYTE_REGS)), random() & 31];           // 8-bit shift/rotate
        case 15: return [0x66, 0xD3, rr(op, m)];                                  // 16-bit by CL
        case 16: return [0x0F, 0xAF, rr(r, m)];                                   // IMUL r, r/m
        case 17: return [0x6B, rr(r, m), random() & 255];                         // IMUL r, r/m, imm8
        case 18: return [0xF7, rr(pick([4, 5]), m)];                              // MUL/IMUL edx:eax
        case 19: return [0x0F, pick([0xA3, 0xAB, 0xB3, 0xBB]), rr(r, m)];         // BT* r, r
        case 20: return [0x0F, 0xBA, rr(4 + (random() & 3), m), random() & 255];  // BT* r, imm8
        case 21: return [0x0F, pick([0xBC, 0xBD]), rr(r, m)];                     // BSF/BSR
        case 22: return [0x0F, pick([0xA4, 0xAC]), rr(r, m), random() & 31];      // SHLD/SHRD imm
        case 23: return [0x0F, pick([0xA5, 0xAD]), rr(r, m)];                     // SHLD/SHRD CL
        case 24: return [0x0F, 0x40 | random() % 16, rr(r, m)];                   // CMOVcc
        case 25: return [0x0F, 0x90 | random() % 16, 0x43, disp()];               // SETcc m8
        case 26: return [0x0F, pick([0xC1, 0xB1]), rr(r, m)];                     // XADD/CMPXCHG
        case 27: return [0x0F, pick([0xC1, 0xB1]), ...mem(r)];                    // on memory
        case 28: return [0x9C, 0x8F, 0x43, disp()];                               // PUSHFD; POP m32
        case 29: return [0x9F, 0x88, 0x63, disp()];                               // LAHF; MOV m8, AH
        case 30: return [0x8D, 0x44 | r << 3, (random() & 3) << 6 | m << 3 | 3, random() & 255]; // LEA
        case 31: return [0x0F, pick([0xB6, 0xB7, 0xBE, 0xBF]), rr(r, m)];         // MOVZX/MOVSX
        case 32: return [pick([0x99, 0x98]), 0x87, rr(r, m)];                     // CDQ/CWDE; XCHG
        default: {                                                                 // DIV/IDIV ecx
            const signed = random() & 1;
            return [0xB9, ...u32(random() | 0x10000), 0x31, 0xD2, 0xF7, rr(6 + signed, 1)];
        }
    }
}
// P3.7's templates (docs/jit-unification-plan.md; IR Tier-0's, one kind per
// switch, t0_*, now the page tier's forms), among integer instructions:
// j: JECXZ and JCXZ over the instruction after them, taken and
//   not: ECX is often zero, or CX zero with the rest of ECX not
// g: MOV r32/r16/m16, Sreg; PUSH Sreg then POP r32 (the
//   push writes 16 bits of the slot)
// e: XCHG [ebx + disp8] with r32, r16 and r8
// d: CLD and STD
// o: POP m32 after PUSH r32/imm32/m32; POP [esp + disp8]
//   stays a step (its address uses ESP)
// a: PUSHAD, an instruction, POPAD
// v: MOVQ from MMX and XMM, MOVDQU and MOVSS stores
//   across the end of DATA's page (EDI = EBX + 0xFFE), which the fast path
//   refuses (the bytes there are compared)
// c: CLI (IF is clear in these programs: PUSHFD shows it)
// p: POP [ESP] and POP [ESP + 4]
// r (P3.1t): REP MOVS and STOS of bytes,
//   words and dwords between ESI and EDI in DATA: apart, overlapping
//   forward and backward, with DF set, ECX 0, across the end of DATA's
//   page, with a 16-bit address size or a DS override, STOS of a repeated
//   byte and of other values
// m: MOV ES/FS/GS from r16 and m16 with the flat data
//   selector, a null one or 0x18 (based at 4 KiB, added to the GDT for
//   it), then a load through the segment; MOV DS with the flat selector;
//   DS to 0x18 and back, which change flat segmentation (refused: steps)
function p37_instruction() {
    if(random() % 3 === 0) return instruction();
    const r = reg(), seg = random() % 6;
    switch(only) {
        case "j": switch(random() % 4) {
            case 0: return random() & 1 ? [0x31, 0xC9] : [0xB9, ...u32(random() & 0xFFFF0000)]; // ECX 0, CX 0
            case 1: { const next = instruction(); return [0x67, 0xE3, next.length, ...next]; }   // JCXZ over it
            default: { const next = instruction(); return [0xE3, next.length, ...next]; }       // JECXZ over it
        }
        case "g": switch(random() % 4) {
            case 0: return [0x8C, rr(seg, r)];                                    // MOV r32, Sreg
            case 1: return [0x66, 0x8C, rr(seg, r)];                              // MOV r16, Sreg
            case 2: return [0x8C, 0x43 | seg << 3, disp()];                       // MOV m16, Sreg
            default: return [...pick([[0x06], [0x0E], [0x16], [0x1E], [0x0F, 0xA0], [0x0F, 0xA8]]), 0x58 | r]; // PUSH Sreg; POP r32
        }
        case "e": switch(random() % 3) {
            case 0: return [0x87, ...mem(r)];                                     // XCHG m32, r32
            case 1: return [0x66, 0x87, ...mem(r)];                               // XCHG m16, r16
            default: return [0x86, 0x43 | pick(BYTE_REGS) << 3, disp()];          // XCHG m8, r8
        }
        case "d": return [pick([0xFC, 0xFD])];                                    // CLD, STD
        case "o": switch(random() % 4) {
            case 0: return [0x50 | r, 0x8F, 0x43, disp()];                        // PUSH r32; POP m32
            case 1: return [0x68, ...u32(random()), 0x8F, 0x43, disp()];          // PUSH imm32; POP m32
            case 2: return [0xFF, 0x73, disp(), 0x8F, 0x43, disp()];              // PUSH m32; POP m32
            default: return [0x50 | r, 0x50 | r, 0x8F, 0x44, 0x24, 0x00, 0x58 | r]; // POP [esp] (a step)
        }
        case "r": {
            const size = pick([1, 2, 4]), movs = random() & 1;
            const op = [...size === 2 ? [0x66] : [], (movs ? 0xA4 : 0xAA) | (size > 1 ? 1 : 0)];
            const lea = (register, offset) => [0x8D, 0x83 | register << 3, ...u32(offset)]; // LEA r32, [EBX + offset]
            const count = n => [0xB9, ...u32(n)];                                 // MOV ECX, n
            // (stores stay below DATA + 120, the loop counter at 124: at
            // most 56 bytes from a destination at most 60)
            const n = random() % (56 / size + 1);
            const a = random() % 120, b = random() % 61;
            const rep = (prefix = [], stos = false) => [0xF3, ...prefix, ...stos ? [...size === 2 ? [0x66] : [], 0xAA | (size > 1 ? 1 : 0)] : op];
            switch(random() % 8) {
                case 0: return [...lea(6, a), ...lea(7, b), ...count(n), ...rep()];       // apart or overlapping
                case 1: { const s = random() % 48; return [...lea(6, s), ...lea(7, s + size * (1 + random() % 3)), ...count(n), ...rep()]; } // forward overlap
                case 2: return [...lea(6, 60 + a % 40), ...lea(7, 60 + b % 40), ...count(n), 0xFD, ...rep(), 0xFC]; // DF set: downward
                case 3: return [...lea(6, a), ...lea(7, b), ...count(0), ...rep()];       // ECX 0
                case 4: return [...lea(6, a), ...lea(7, 0xFF0 - 2 * (random() & 7)), ...count(4 + random() % 8), ...rep()]; // across the page end
                case 5: return [0xB8, ...u32(pick([0, 0x41414141, 0xFFFFFFFF, random()])), ...lea(7, b), ...count(n), ...rep([], true)]; // STOS values
                case 6: return [...lea(6, a), ...lea(7, b), ...count(0x10000), 0x67, ...rep()]; // 16-bit address size: CX 0
                default: return [...lea(6, a), ...lea(7, b), ...count(n), ...rep([0x3E])]; // a DS override
            }
        }
        case "v": {
            const x = random() & 7;
            const store = pick([[0x0F, 0x7F], [0x66, 0x0F, 0xD6], [0xF3, 0x0F, 0x7F], [0xF3, 0x0F, 0x11]]);
            return [0x8D, 0xBB, ...u32(0xFFE), ...store, 0x07 | x << 3];          // LEA EDI, [EBX+0xFFE]; store [EDI]
        }
        case "c": return [0xFA];                                                  // CLI
        case "p": return random() & 1
            ? [0x50 | r, 0x50 | r, 0x8F, 0x04, 0x24, 0x58 | r, 0x58 | r]          // POP [ESP]
            : [0x50 | r, 0x50 | r, 0x50 | r, 0x8F, 0x44, 0x24, 0x04, 0x58 | r, 0x58 | r]; // POP [ESP+4]
        case "m": {
            // (ES, FS or GS, and its segment-override prefix)
            const s = pick([0, 4, 5]), prefix = { 0: 0x26, 4: 0x64, 5: 0x65 }[s], sel = pick([0x10, 0x18]);
            const load = (selector, sreg) => [0x66, 0xB8 | r, selector, 0x00, 0x8E, rr(sreg, r)];
            switch(random() % 6) {
                case 0: return load(sel, s);                                      // MOV Sreg, r16
                case 1: { const d = disp(); return [0x66, 0xC7, 0x43, d, sel, 0x00, 0x8E, 0x43 | s << 3, d]; } // MOV Sreg, m16
                case 2: return [0x66, 0x31, rr(r, r), 0x8E, rr(s, r), ...load(0x18, s)]; // null, then 0x18
                case 3: return load(0x10, 3);                                     // MOV DS, the flat selector
                case 4: return [...load(0x18, 3), 0x8B, 0x43 | r << 3, disp(), ...load(0x10, 3)]; // DS non-flat and back
                default: return [...load(0x18, s), prefix, 0x8B, 0x43 | r << 3, disp()]; // a load through it
            }
        }
        default: return [0x60, ...instruction(), 0x61];                          // PUSHAD; ...; POPAD
    }
}
// b: BMI1 and BMI2's VEX forms, TZCNT, LZCNT and MOVBE (P10; the page tier
// has templates for the hot ones of plan 5.1 and steps the others) on registers
// and [ebx + disp8]
function bmi_instruction() {
    // (then a SETcc m8 half the time: a condition right after the flags,
    // mostly of CF)
    const setcc = random() & 1 ? [0x0F, 0x90 | (random() & 1 ? pick([2, 3, 6, 7]) : random() % 16), 0x43, disp()] : [];
    return [...bmi_form(), ...setcc];
}
function bmi_form() {
    const r = reg(), v = reg(), m = reg();
    const rm = field => random() % 3 ? [rr(field, m)] : [0x43 | field << 3, disp()];
    const vex = (map, pp, op, field, vvvv) => [0xC4, 0xE0 | map, (~vvvv & 15) << 3 | pp, op, ...rm(field)];
    switch(random() % 10) {
        case 0: return vex(2, 0, 0xF2, r, v);                                        // ANDN
        case 1: return vex(2, 0, 0xF3, 1 + random() % 3, v);                         // BLSR/BLSMSK/BLSI
        case 2: return [0xB8 | v, ...u32(random() % 40), ...vex(2, 0, 0xF5, r, v)];  // BZHI (index 0-39)
        case 3: return vex(2, 1 + random() % 3, 0xF7, r, v);                         // SHLX/SARX/SHRX
        case 4: return [...random() & 1 ? [0xB8 | m, 0, 0, 0, 0] : [], 0xF3, 0x0F, pick([0xBC, 0xBD]), rr(r, m)]; // TZCNT/LZCNT (of 0: CF)
        case 5: return [...random() & 1 ? [] : [0xF3, 0x0F, pick([0xBC, 0xBD]), 0x43 | r << 3, disp()], 0x66, 0xF3, 0x0F, pick([0xBC, 0xBD]), ...rm(r)]; // (memory, 16-bit)
        case 6: return [...pick([[], [0x66]]), 0x0F, 0x38, pick([0xF0, 0xF1]), 0x43 | r << 3, disp()]; // MOVBE
        case 7: return [0xB8 | v, ...u32(random() & 0xFF0F), ...vex(2, 0, 0xF7, r, v)]; // BEXTR
        case 8: return vex(2, pick([2, 3]), 0xF5, r, v);                             // PEXT/PDEP
        default: return random() & 1 ? vex(2, 3, 0xF6, r, v)                         // MULX
            : [0xC4, 0xE3, 0x7B, 0xF0, ...rm(r), random() & 255];                  // RORX
    }
}
// SSE floating point (docs/simd-xsave-plan.md 7.4): the arithmetic forms,
// conversions and compares, and the moves and shuffles carrying values between
// them (compiled code tracks which registers hold neither NaNs nor denormals), on
// zeros, denormals, infinities, NaNs and values that overflow or underflow.
function fp_instruction(x, y) {
    const prefix = pick([[], [0x66], [0xF3], [0xF2]]);
    const packed = prefix.length === 0 || prefix[0] === 0x66;
    const source = () => random() % 3 ? [rr(x, y)] : [0x43 | x << 3, packed ? disp() & ~15 : disp() & ~7];
    switch(random() % 16) {
        case 0: case 1: case 2: case 3: case 4: case 5:
            return [...prefix, 0x0F, pick([0x51, 0x58, 0x59, 0x5C, 0x5D, 0x5E, 0x5F]), ...source()];
        case 6: return [...pick([[], [0xF3]]), 0x0F, pick([0x52, 0x53]), rr(x, y)];      // RCP/RSQRT
        case 7: return [...prefix, 0x0F, 0x5A, rr(x, y)];                                  // CVTPS2PD...
        case 8: return [...pick([[], [0x66], [0xF3]]), 0x0F, 0x5B, rr(x, y)];              // CVTDQ2PS...
        case 9: return [...pick([[0x66], [0xF2], [0xF3]]), 0x0F, 0xE6, rr(x, y)];          // CVTDQ2PD...
        case 10: {                                                                     // CVTSI2SS... CVT(T)SS2SI...
            const op = pick([0x2A, 0x2C, 0x2D]);
            return [pick([0xF3, 0xF2]), 0x0F, op, op === 0x2A ? rr(x, y) : rr(reg(), y)];
        }
        case 11: return [...pick([[], [0x66]]), 0x0F, pick([0x2E, 0x2F]), rr(x, y)];        // (U)COMIS*
        case 12: return random() % 3 ? [pick([0xF3, 0xF2]), 0x0F, 0x10, rr(x, y)]         // MOVSS/MOVSD
            : [0x0F, 0x28, rr(x, y)];                                                      // MOVAPS
        case 13: return random() & 1 ? [0x0F, pick([0x14, 0x15, 0x16]), rr(x, y)]          // UNPCK*/MOVLHPS
            : [0x0F, 0xC6, rr(x, y), random() & 255];                                      // SHUFPS
        case 14: return [0x0F, 0x57, rr(x, random() & 1 ? x : y)];                         // XORPS (zero idiom)
        default: return random() & 1 ? [0x0F, 0x28, 0x43 | x << 3, disp() & ~15]          // MOVAPS xmm, m128
            : [pick([0xF3, 0xF2]), 0x0F, 0x10, 0x43 | x << 3, disp() & ~7];               // MOVSS/MOVSD xmm, m
    }
}
const SPECIAL_SINGLE = [0, 0x80000000, 0x3F800000, 0xBF800000, 1, 0x807FFFFF, 0x00800000, 0x00800001, 0x7F7FFFFF,
    0x7F800000, 0xFF800000, 0x7FC00000, 0x7FA00000, 0xFFC12345, 0x3EFFFFFF, 0x01000000, 0x1F800000, 0x5F000000,
    0x40490FDB, 0x3DCCCCCD, 0x4F000000, 0xCF000001];
const SPECIAL_DOUBLE = [[0, 0], [0, 0x80000000], [0, 0x3FF00000], [1, 0], [0xFFFFFFFF, 0x800FFFFF], [0, 0x00100000],
    [1, 0x00100000], [0xFFFFFFFF, 0x7FEFFFFF], [0, 0x7FF00000], [0, 0xFFF00000], [0, 0x7FF80000], [1, 0x7FF00000],
    [0xFFFFFFFF, 0x3FDFFFFF], [0, 0x00200000], [0, 0x1FF00000], [0, 0x5FF00000], [0x54442D18, 0x400921FB],
    [0x9999999A, 0x3FB99999], [0, 0x41E00000], [0, 0xC1E00000]];
/** 16 bytes of special floats (4 singles or 2 doubles) as words */
function special_words() {
    if(random() & 1) return Array.from({ length: 4 }, () => random() % 5 ? pick(SPECIAL_SINGLE) : random());
    return Array.from({ length: 2 }, () => random() % 5 ? pick(SPECIAL_DOUBLE) : [random(), random()]).flat();
}
// s12: what compiled code knows about registers within a block. Values around the
// smallest normal, whose sums and differences are exact denormals, consumed
// by forms that are then admitted natively unless that knowledge is right
// (MXCSR with only PE set keeps a missed DE or IE visible).
// (no denormals or NaNs to begin with: they would set DE and IE anyway)
const NEAR_SINGLE = [0x00800000, 0x00800001, 0x00800003, 0x80800000, 0x80800001, 0x00C00000, 0x3F800000,
    0x4B000000, 0, 0x80000000];
const NEAR_DOUBLE = [[0, 0x00100000], [1, 0x00100000], [3, 0x00100000], [0, 0x80100000], [1, 0x80100000],
    [0, 0x00180000], [0, 0x3FF00000], [0, 0x43300000], [0, 0], [0, 0x80000000]];
// (one precision per program: the halves of doubles are often denormal
// singles, which would set DE anyway)
let near_single = true, last = 0;
function near_words() {
    const near = (list, k) => random() & 1 ? list[k] : pick(list);
    // (a fourth of the registers with a denormal or NaN above lane 0, which a
    // check of lane 0 alone or a wrong shuffle would let through)
    const odd = random() % 4 ? -1 : 1 + random() % (near_single ? 3 : 1);
    if(near_single) return Array.from({ length: 4 }, (_, i) => i === odd ? pick([0x00000003, 0x80400000, 0x7FC00000]) : near(NEAR_SINGLE, random() % 5));
    return Array.from({ length: 2 }, (_, i) => i === odd ? pick([[3, 0], [0, 0x80080000], [0, 0x7FF80000]]) : near(NEAR_DOUBLE, random() % 5)).flat();
}
function tracking_instruction(x, y) {
    const single = near_single;
    // Patterns for each fact compiled code keeps, a consumer reading what a wrong
    // fact would leave unchecked (z: another register)
    const z = (x + 1 + random() % 7) & 7;
    const packed = single ? [] : [0x66], scalar = single ? [0xF3] : [0xF2];
    switch(random() % 8) {
        case 0: // a clean register shuffled with an unchecked one
            return [...packed, 0x0F, 0x59, rr(x, x),
                ...single ? [0x0F, 0xC6, rr(x, y), random() & 255] : [0x66, 0x0F, pick([0x14, 0x15]), rr(x, y)],
                ...packed, 0x0F, 0x58, rr(z, x)];
        case 1: // a scalar check covers lane 0 only
            return [...scalar, 0x0F, pick([0x58, 0x59, 0x5D]), rr(x, y), ...packed, 0x0F, pick([0x58, 0x5F]), rr(z, y)];
        case 2: // a sum may be an exact denormal
            return [...packed, 0x0F, pick([0x58, 0x5C]), rr(x, y), ...packed, 0x0F, pick([0x58, 0x5D, 0x59]), rr(z, x)];
        case 3: // copies and scalar moves
            return [...packed, 0x0F, 0x59, rr(x, x), ...pick([[0x0F, 0x28, rr(z, y)], [...scalar, 0x0F, 0x10, rr(x, y)]]),
                ...packed, 0x0F, 0x58, rr(z, x)];
    }
    // (reading the last result half of the time)
    if(random() & 1) y = last;
    last = x;
    const prefix = single ? pick([[], [0xF3]]) : pick([[0x66], [0xF2]]);
    switch(random() % 10) {
        case 0: case 1: case 2: return [...prefix, 0x0F, pick([0x58, 0x5C]), rr(x, y)];        // ADD/SUB
        case 3: return [...prefix, 0x0F, pick([0x59, 0x5D, 0x5F, 0x51, 0x5E]), rr(x, y)];      // MUL/MIN/MAX/SQRT/DIV
        // (only templated forms: an interpreted one ends the block)
        case 4: return [single ? 0xF3 : 0xF2, 0x0F, 0x10, rr(x, y)];                             // MOVSS/MOVSD
        case 5: return [...(single ? [] : [0x66]), 0x0F, pick([0x2E, 0x2F]), rr(x, y)];         // (U)COMIS*
        case 6: return [0x0F, 0x28, rr(x, y)];                                                    // MOVAPS
        case 7: return single ? [0x0F, 0xC6, rr(x, y), random() & 255]                          // SHUFPS
            : random() & 1 ? [0x66, 0x0F, 0xC6, rr(x, y), random() & 3]                          // SHUFPD
            : [0x66, 0x0F, pick([0x14, 0x15]), rr(x, y)];                                        // UNPCKxPD
        case 8: return single ? [0x0F, 0x5A, rr(x, y)] : [0x66, 0x0F, 0x28, rr(x, y)];          // CVTPS2PD / MOVAPD
        default: return [0x0F, 0x57, rr(x, x)];                                                   // XORPS x, x
    }
}
// s13: VEX forms (AVX, P5 part 5; their templates are the legacy ones
// with a first source and bits 255:128 of the destination zeroed) among legacy
// forms with templates (CMPPS, MOVMSKPS, PMOVMSKB, BLENDVPS...), over special
// values. VEX.vvvv (z) is the first source; an immediate shift's destination.
function vex_instruction(x, y) {
    const z = random() & 7;
    const c5 = (pp, vvvv = 0) => [0xC5, 0x80 | (~vvvv & 15) << 3 | pp];
    const c4 = (map, pp, vvvv = 0) => [0xC4, 0xE0 | map, (~vvvv & 15) << 3 | pp];
    const source = () => random() % 3 ? [rr(x, y)] : [0x43 | x << 3, disp()];
    const legacy_source = aligned => random() % 3 ? [rr(x, y)] : [0x43 | x << 3, aligned ? disp() & ~15 : disp() & ~7];
    switch(random() % 20) {
        case 0: case 1: case 2: {                                                 // VSQRT VADD VMUL VSUB VMIN VDIV VMAX
            const pp = random() & 3, op = pick([0x51, 0x58, 0x59, 0x5C, 0x5D, 0x5E, 0x5F]);
            return [...c5(pp, op === 0x51 && pp < 2 ? 0 : z), op, ...source()];
        }
        case 3: return [...c5(pick([0, 1]), z), pick([0x54, 0x55, 0x56, 0x57, 0x14, 0x15]), ...source()]; // logic, unpacks
        case 4: return [...c5(1, z), pick([0xFC, 0xFE, 0xEF, 0xDB, 0xDF, 0x74, 0x76, 0x64, 0xD5, 0xF6, 0x62, 0x6B, 0xD2, 0xE2]), ...source()];
        case 5: return [...c5(random() & 3, z), 0xC2, ...source(), random() & 31];   // VCMPxx
        case 6: return [...c5(pick([0, 1])), pick([0x2E, 0x2F]), rr(x, y)];          // V(U)COMIS*
        case 7: return [...c5(pick([2, 3]), z), 0x10, rr(x, y)];                     // VMOVSS/SD xmm, xmm, xmm
        case 8: return [...c5(pick([2, 3])), pick([0x10, 0x11]), 0x43 | x << 3, disp()]; // VMOVSS/SD with memory
        case 9: return [...c5(pick([0, 1])), pick([0x28, 0x10, 0x11]), rr(x, y)];   // VMOVAPS/UPS
        case 10: {                                                                    // VPMOVMSKB, VMOVMSKPS/PD
            // (VPMOVMSKB has no NP form: #UD would end the program early)
            const pp = pick([0, 1, 1]), op = random() & 1 ? 0xD7 : 0x50;
            return [...c5(op === 0xD7 ? 1 : pp), op, rr(reg(), y)];
        }
        case 11: return [...c4(3, 1, z), pick([0x4A, 0x4B, 0x4C]), ...source(), (random() & 7) << 4]; // VBLENDVPS/PD, VPBLENDVB
        case 12: {                                                                    // VPSxx imm: VEX.vvvv the destination
            const op = pick([0x71, 0x72, 0x73]);
            return [...c5(1, x), op, rr(op === 0x73 ? pick([2, 3, 6, 7]) : pick([2, 4, 6]), y), random() & 63];
        }
        case 13: return [...c5(0), 0x77];                                             // VZEROUPPER
        case 14: return [...c5(pick([2, 3]), z), 0x5A, ...source()];                 // VCVTSS2SD/SD2SS
        case 15: return [...c5(pick([2, 3]), z), 0x2A, rr(x, reg())];                // VCVTSI2SS/SD
        case 16: return [...c5(pick([2, 3])), pick([0x2C, 0x2D]), rr(reg(), y)];     // VCVT(T)SS2SI/SD2SI
        case 17: return [...pick([[], [0x66], [0xF3], [0xF2]]), 0x0F, 0xC2, ...legacy_source(true), random() & 255]; // CMPxx
        case 18: return [...pick([[], [0x66]]), 0x0F, 0x50, rr(reg(), y)];          // MOVMSKPS/PD
        default: return random() & 1 ? [0x66, 0x0F, 0xD7, rr(reg(), y)]             // PMOVMSKB
            : [0x66, 0x0F, 0x38, pick([0x10, 0x14, 0x15]), ...legacy_source(true)];   // PBLENDVB, BLENDVPS/PD
    }
}
// Masked MXCSRs: defaults, PE set, all flags set, rounding modes, DAZ and FZ
const FP_MXCSRS = [0x1F80, 0x1FA0, 0x1FBF, 0x3FA0, 0x5F80, 0x7FA0, 0x1FE0, 0x9FA0, 0x9FE0];
function simd() {
    const x = random() & 7, y = random() & 7;
    const kind = random() % 13;
    switch(only.startsWith("s") ? Number(only.slice(1)) : kind) {
        case 0: return [0x0F, 0x10, 0x43 | x << 3, disp() & ~15];                 // MOVUPS xmm, m128
        case 1: return [0x0F, pick([0x58, 0x59, 0x5C, 0x5D, 0x5F]), rr(x, y)];     // ADDPS...
        case 2: return random() & 1 ? [0xF2, 0x0F, pick([0x58, 0x59, 0x5C, 0x51]), rr(x, y)] // ADDSD...
            : [0xF2, 0x0F, pick([0x10, 0x11, 0x58, 0x59]), 0x43 | x << 3, disp()];
        case 3: return [0x66, 0x0F, pick([0xFE, 0xFD, 0xEF, 0xDB, 0xD5, 0xF6, 0x62, 0x6B]), rr(x, y)];
        case 4: return random() & 1 ? [0x0F, 0xC6, rr(x, y), random() & 255]      // SHUFPS
            : [0x0F, 0xC6, 0x43 | x << 3, disp() & ~15, random() & 255];
        case 5: return [0x66, 0x0F, 0x70, rr(x, y), random() & 255];              // PSHUFD
        case 6: return [0x0F, 0x2E, rr(x, y)];                                    // UCOMISS
        case 7: return [0xF2, 0x0F, 0x2C, rr(reg(), y)];                          // CVTTSD2SI
        case 8: return [0x0F, 0x11, 0x43 | x << 3, disp() & ~15];                 // MOVUPS m128, xmm
        case 10: {                                                                 // SSSE3
            const op = pick([0x00, 0x00, 0x01, 0x04, 0x0B, 0x1C]);                 // (PSHUFB has a template)
            switch(random() % 3) {
                case 0: return [0x66, 0x0F, 0x38, op, rr(x, y)];
                case 1: return [0x66, 0x0F, 0x38, op, 0x43 | x << 3, disp() & ~15];
                default: return [0x66, 0x0F, 0x3A, 0x0F, rr(x, y), random() & 31];  // PALIGNR
            }
        }
        case 11: return fp_instruction(x, y);
        case 12: return tracking_instruction(x, y);
        case 13: return vex_instruction(x, y);
        default: return [0x66, 0x0F, 0x72, rr(pick([2, 4, 6]), x), random() & 63]; // PSxLD imm
    }
}
// Register-only x87 runs between loads and stores (depth-tracked).
function x87_run() {
    const d = () => disp() & ~7, out = [];
    let depth = 0;
    for(let k = 0; k < 2 + (random() & 1); k++) { out.push(0xDD, 0x43, d()); depth++; }
    for(let k = 0; k < 4 + random() % 8; k++) {
        const r = random() % depth, op = random() % 11;
        if(op === 0 && depth < 7) { out.push(0xD9, 0xC0 + r); depth++; }                       // FLD ST(r)
        else if(op === 1 && depth < 7) { out.push(0xD9, random() & 1 ? 0xE8 : 0xEE); depth++; } // FLD1/FLDZ
        else if(op === 2) out.push(0xD9, 0xC8 + r);                                              // FXCH
        else if(op === 3) out.push(0xD8, 0xC0 + 8 * pick([0, 1, 4, 5, 6, 7]) + r);               // Fop ST0, ST(r)
        else if(op === 4) out.push(0xDC, 0xC0 + 8 * pick([0, 1, 4, 5, 6, 7]) + r);               // Fop ST(r), ST0
        else if(op === 5 && depth >= 2) { out.push(0xDE, 0xC0 + 8 * pick([0, 1, 4, 5, 6, 7]) + Math.max(1, r)); depth--; } // FopP
        else if(op === 6) out.push(0xD9, random() & 1 ? 0xE0 : 0xE1);                           // FCHS/FABS
        else if(op === 7) out.push(0xDD, 0xD0 + r);                                              // FST ST(r)
        else if(op === 8 && depth >= 2) { out.push(0xDD, 0xD8 + Math.max(1, r)); depth--; }      // FSTP ST(r)
    }
    while(depth--) out.push(0xDD, 0x5B, d());                                                   // FSTP m64
    return out;
}
// Balanced x87 sequences (the stack is empty between them).
function x87() {
    const d = () => disp() & ~7, i = random() & 1;
    if(random() & 1) return x87_run();
    switch(random() % 8) {
        case 0: return [0xD9, 0x43, d(), 0xDD, 0x43, d(), 0xDE, 0xC9, 0xD8, 0xC0, 0xDD, 0x5B, d()]; // FLD m32; FLD m64; FMULP; FADD st0; FSTP m64
        case 1: return [0xDB, 0x43, d(), 0xDB, 0x5B, d()];                                   // FILD m32; FISTP m32
        case 2: return [0xD9, 0xE8, 0xD9, 0xEE, 0xDF, 0xF1, 0xDD, 0xD8];                     // FLD1; FLDZ; FCOMIP st1; FSTP st0
        case 3: return [0xD9, 0x43, d(), 0xD9, 0xE0, 0xD9, 0xE1, 0xD9, 0x5B, d()];            // FLD; FCHS; FABS; FSTP m32
        case 4: return [0xDD, 0x43, d(), 0xDD, 0x43, d(), 0xD9, 0xC9, 0xDE, 0xE9, 0xDF, 0xE0, 0xDD, 0x5B, d()]; // FXCH; FSUBP; FNSTSW AX
        case 5: return [0xD9, 0xE8, 0xDD, 0x43, d(), 0xDB, 0xF1, 0xDA, 0xC1 + 8 * i, 0xDD, 0xD9, 0xDD, 0xD8]; // FCOMI; FCMOVB/E
        case 6: return [0xDF, 0x43, d(), 0xDE, 0x43, d(), 0xDF, 0x5B, d()];                  // FILD m16; FIADD m16; FISTP m16
        default: return [0xD9, 0x7B, d(), 0xD9, 0x6B, d(), 0xDD, 0x43, d(), 0xDD, 0x5B, d()];  // FNSTCW; FLDCW; FLD; FSTP
    }
}
// s11/s12 iterations start alike: LDMXCSR and MOVAPS of all registers from
// DATA + 256.. (not compared), so that a flag missed in compiled code is not
// set by a later iteration (MXCSR's flags are sticky).
const RESET = 256;
function reset() {
    const out = [0x0F, 0xAE, 0x93, ...u32(RESET + 128)];
    for(let k = 0; k < 8; k++) out.push(0x0F, 0x28, 0x83 | k << 3, ...u32(RESET + 16 * k));
    return out;
}
function program() {
    const body = ["s11", "s12", "s13"].includes(only) ? reset() : [];
    const mix = random() % 5;
    if(process.env.FUZZ_BODY) body.push(...process.env.FUZZ_BODY.match(/../g).map(h => parseInt(h, 16)));
    else
    // (s12: short, so that one missed flag is not set by anything else)
    for(let k = 0; k < (only === "s12" ? 4 + random() % 6 : 40); k++) {
        const vector = only ? only.startsWith("s") : !(mix && random() % 5);
        const float = only ? only === "x" : random() % 7 === 0;
        // Single-kind programs still interleave PUSHFD/LAHF to expose FLAGS.
        body.push(...(only && only !== "s12" && k % 4 === 3 ? [0x9C, 0x8F, 0x43, disp()] : only === "b" ? bmi_instruction() :
            ["j", "g", "e", "d", "o", "a", "m", "v", "c", "p", "r"].includes(only) ? p37_instruction() :
            float ? x87() : vector ? simd() : instruction()));
    }
    // DEC DWORD [ebx + 124]; JNZ top; HLT
    const tail = [0xFF, 0x4B, 124];
    const jump = -(body.length + tail.length + 6);
    return [...body, ...tail, 0x0F, 0x85, ...u32(jump), 0xF4];
}

async function machine(compiled) {
    const vm = new V86({
        graphics_adapter: "bochs_vga",
        wasm_path: wasm, disable_jit: !compiled, memory_size: 128 << 20, // reference: the interpreter only
        // (page functions are installed as they are compiled, not in a Promise
        // continuation, which a whole program can run ahead of)
        ir_sync_publication: true,
        // (AVX for s13: CR4.OSXSAVE and XCR0 set in run; BMI for b, with the
        // x86-64 profile's LZCNT)
        cpu_features: ["SSSE3", "SSE4.1", "SSE4.2", "XSAVE", "AVX", ...only === "b" ? ["BMI1", "BMI2", "LZCNT", "MOVBE"] : []],
        ...only === "b" ? { cpu_type: "x86_64" } : {}, cpu_features_unreleased: true,
        // (the page tier counts each instruction: blocks count theirs at
        // entry by default, more than run when a retry leaves one early; and
        // compiles, and recompiles for new entries, as soon as long mode)
        ...compiled ? { jit_switches: { x64_block_count: 0, x64_legacy_heat: 2000, x64_legacy_recompile_misses: 64,
            ...jit_switches_from_env() } } : {},
        bios: { buffer: Uint8Array.from(boot).buffer }, disable_keyboard: true, disable_mouse: true,
        disable_speaker: true, net_device: { type: "none" }, autostart: false,
    });
    await new Promise((resolve, reject) => { vm.add_listener("emulator-loaded", resolve); vm.add_listener("emulator-error", reject); });
    const cpu = vm.v86.cpu, e = cpu.wm.exports;
    vm.run();
    const end = performance.now() + 15000;
    while(new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).getUint32(0x500, true) !== 0xCAFE) {
        assert(performance.now() < end, "benchmark BIOS did not start");
        await sleep(1);
    }
    await vm.stop();
    if(only === "m") {
        // A fourth descriptor: data based at 0x1000, not yet accessed (run
        // clears the bit again for each case)
        const view = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset), gdt = cpu.gdtr_offset[0] >>> 0;
        view.setUint32(gdt + 24, 0x1000FFFF, true);
        view.setUint32(gdt + 28, 0x00CF9200, true);
        cpu.gdtr_size[0] = 31;
    }
    return { vm, cpu, e, compiled };
}

async function run(m, code, init, page, split) {
    const { vm, cpu, e } = m;
    // A fresh code page per case: mem8.set bypasses code-write detection.
    // Straddling programs start `split` bytes before the end of a page.
    const base = split ? CODE + page * 0x2000 + 0x1000 - split : CODE + page * 0x1000;
    cpu.mem8.set(code, base);
    cpu.mem8.set(init.data, DATA);
    if(only === "v" || only === "r") cpu.mem8.fill(0, DATA + 0xFF0, DATA + 0x1010);
    if(only === "m") cpu.mem8[(cpu.gdtr_offset[0] >>> 0) + 29] &= ~1;
    cpu.mem8.fill(0, STACK - 0x1000, STACK);
    new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).setUint32(DATA + 124, ITERATIONS, true);
    cpu.reg32.set(init.regs);
    cpu.reg32[3] = DATA; cpu.reg32[4] = STACK;
    if(ss16) {
        // (SS 0x20, a 16-bit data segment at SS16)
        cpu.mem8.fill(0, SS16, SS16 + 0x10000);
        cpu.sreg[2] = 0x20; cpu.segment_offsets[2] = SS16; cpu.segment_limits[2] = 0xFFFF;
        cpu.segment_access_bytes[2] = 0x93; cpu.segment_is_null[2] = 0; cpu.stack_size_32[0] = 0;
        cpu.reg32[4] = init.sp16;
    }
    cpu.flags[0] = 2; cpu.flags_changed[0] = 0; cpu.in_hlt[0] = 0;
    cpu.instruction_pointer[0] = base;
    e.fpu_discard_cache();
    new Uint32Array(cpu.reg_xmm32s.buffer, cpu.reg_xmm32s.byteOffset, 32).set(init.xmm);
    // AVX: CR4.OSXSAVE, XCR0 7 and the YMM registers' upper halves (gp::xcr0
    // and gp::ymm_hi, 1600 and 1616 bytes after the XMM registers)
    cpu.cr[4] |= 1 << 18;
    new Uint32Array(cpu.reg_xmm32s.buffer, cpu.reg_xmm32s.byteOffset + 1600, 2).set([7, 0]);
    new Uint32Array(cpu.reg_xmm32s.buffer, cpu.reg_xmm32s.byteOffset + 1616, 32).set(init.ymm);
    cpu.mxcsr[0] = init.mxcsr;
    cpu.fpu_st.fill(0); cpu.fpu_stack_empty[0] = 255; cpu.fpu_stack_ptr[0] = 0;
    e.set_control_word(0x37F); cpu.fpu_status_word[0] = 0;
    e.update_state_flags();
    new Uint32Array(e.memory.buffer)[664 >> 2] = 0;
    // (page function activations, and native and stepped instructions)
    const activations = e.x64_page_stat(13), native = e.x64_page_stat(1), steps = e.x64_page_stat(4);
    vm.run();
    const end = performance.now() + 20000;
    while(!cpu.in_hlt[0]) {
        if(performance.now() > end) {
            await vm.stop();
            const v = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
            throw new Error(`timeout (${m.compiled ? "page tier" : "interpreter"}): eip ${(cpu.instruction_pointer[0] >>> 0).toString(16)} ` +
                `status ${v.getUint32(0x608, true).toString(16)} counter ${v.getUint32(DATA + 124, true)} ` +
                `retired ${new Uint32Array(e.memory.buffer)[664 >> 2] >>> 0} code ${Buffer.from(code).toString("hex")}`);
        }
        await sleep(0);
    }
    await vm.stop();
    const count = new Uint32Array(e.memory.buffer)[664 >> 2] >>> 0;
    m.entries = e.x64_page_stat(13) - activations;
    m.interpreted = Math.max(0, count - (e.x64_page_stat(1) - native) - (e.x64_page_stat(4) - steps));
    return {
        regs: Array.from(cpu.reg32, v => v >>> 0),
        eip: cpu.instruction_pointer[0] >>> 0,
        eflags: e.get_eflags() >>> 0,
        data: Array.from(cpu.mem8.subarray(DATA, DATA + 256)),
        stack: Array.from(cpu.mem8.subarray(STACK - 64, STACK)),
        ...ss16 ? { stack_low: Array.from(cpu.mem8.subarray(SS16, SS16 + 64)), stack_top: Array.from(cpu.mem8.subarray(SS16 + 0xFFC0, SS16 + 0x10000)) } : {},
        xmm: Array.from(new Uint32Array(cpu.reg_xmm32s.buffer, cpu.reg_xmm32s.byteOffset, 32), v => v >>> 0),
        ymm: Array.from(new Uint32Array(cpu.reg_xmm32s.buffer, cpu.reg_xmm32s.byteOffset + 1616, 32), v => v >>> 0),
        mxcsr: cpu.mxcsr[0] >>> 0,
        count: new Uint32Array(e.memory.buffer)[664 >> 2] >>> 0,
        fpu: (e.fpu_sync_all(), [cpu.fpu_stack_ptr[0], cpu.fpu_stack_empty[0], cpu.fpu_status_word[0], ...Array.from(new Uint8Array(cpu.fpu_st.buffer, cpu.fpu_st.byteOffset, 128))]),
        status: new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).getUint32(0x608, true),
        // (v: the bytes across the end of DATA's page)
        ...only === "v" || only === "r" ? { page_end: Array.from(cpu.mem8.subarray(DATA + 0xFF0, DATA + 0x1010)) } : {},
        // (m: the descriptor at 0x18, whose accessed bit its first load sets)
        ...only === "m" ? { descriptor: Array.from(cpu.mem8.subarray((cpu.gdtr_offset[0] >>> 0) + 24, (cpu.gdtr_offset[0] >>> 0) + 32)) } : {},
    };
}

const reference = await machine(false), page = await machine(true);
// (instructions retired in all, and in page functions; the smallest share of
// one program's in page functions)
let failures = 0, uncompiled = 0, retired = 0, compiled = 0, least = 1;
for(let c = 0; c < cases; c++) {
    near_single = (random() & 1) === 1;
    const code = program();
    const special = only === "s11" || only === "s13", near = only === "s12";
    const reset_state = (xmm, mxcsr) => [...xmm.flatMap(u32), ...u32(mxcsr)];
    const init = {
        regs: Array.from({ length: 8 }, () => random()),
        // (FUZZ_SS16: the initial SP, below STACK or wrapping)
        sp16: ss16 ? random() & 1 ? 0xFFF0 : 8 : 0,
        data: special ? Array.from({ length: 16 }, () => special_words().flatMap(u32)).flat()
            : Array.from({ length: 256 }, () => random() & 255),
        // Finite floats: exponents kept in range so arithmetic rarely makes NaNs.
        xmm: special ? Array.from({ length: 8 }, special_words).flat()
            : near ? Array.from({ length: 8 }, near_words).flat()
            : Array.from({ length: 32 }, () => random() & 0xBFFFFFFF),
        mxcsr: special ? pick(FP_MXCSRS) : near ? 0x1FA0 : 0x1F80,
        ymm: Array.from({ length: 32 }, () => random()),
    };
    if(special || near) init.data.push(...reset_state(init.xmm, init.mxcsr));
    const split = straddle ? 4 + random() % (code.length - 8) : 0;
    const expected = await run(reference, code, init, c, split), actual = await run(page, code, init, c, split);
    if(process.env.FUZZ_DEBUG) console.log(`case ${c}: mxcsr ${expected.mxcsr.toString(16)} / ${actual.mxcsr.toString(16)} count ${expected.count} ` +
        `page function entries ${page.entries} interpreted ${page.interpreted} code ${Buffer.from(code).toString("hex")}` +
        ` (compiled ${page.e.x64_page_stat(0)} failed ${page.e.x64_page_stat(7)} retries ` +
        `${page.e.x64_page_stat(2)} steps ${page.e.x64_page_stat(4)} unknown ${page.e.x64_page_stat(3)})`);
    retired += actual.count;
    compiled += actual.count - page.interpreted;
    least = Math.min(least, 1 - page.interpreted / actual.count);
    if(!page.entries) {
        uncompiled++;
        console.log(`case ${c}: no page function ran (${actual.count} instructions, eip ${actual.eip.toString(16)}, status ${actual.status.toString(16)})\n` +
            `  code ${Buffer.from(code).toString("hex")}`);
    }
    for(const key of Object.keys(expected)) {
        try { assert.deepEqual(actual[key], expected[key]); }
        catch{
            failures++;
            console.log(`case ${c}: ${key} differs\n  code ${Buffer.from(code).toString("hex")}\n  expected ${JSON.stringify(expected[key])}\n  actual   ${JSON.stringify(actual[key])}`);
            break;
        }
    }
}
// (legacy-mode compiles, x64_page_stat 37, and steps: instructions that page
// functions left to the interpreter)
const pages = page.e.x64_page_stat(37), stepped = page.e.x64_page_stat(4);
await reference.vm.destroy(); await page.vm.destroy();
assert(pages > 0, "no page was compiled");
const percent = share => `${(100 * share).toFixed(1)}%`;
const coverage = `${percent(compiled / retired)} of the instructions ran in page functions (${percent((compiled - stepped) / retired)} ` +
    `templated), at least ${percent(least)} of each program's`;
if(failures || uncompiled || compiled < retired * Number(process.env.FUZZ_COVERAGE || 0.5)) {
    console.log(`FAIL: ${failures}/${cases} cases differ, no page function ran in ${uncompiled}; ${coverage}`);
    process.exit(1);
}
console.log(`PASS: ${cases} random programs, the page tier (${pages} page compiles) matches the interpreter; ${coverage}`);
process.exit(0);
