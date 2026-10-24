#!/usr/bin/env node
// The AArch32 single-instruction oracle (docs/aarch32-plan.md Q0.3): random
// instructions of each encoding class, generated here with the operands an
// instruction may have without being UNPREDICTABLE (no PC where it is one,
// pointers into the data buffer for the loads and stores, small indexes),
// each run once at EL0 by tests/a64/aarch32/oracle.c on QEMU (cortex-a35)
// and on v86 (profile v3), with random registers, NZCV, Q and GE; the two
// outputs must be the same. The classes are A32's integer instructions (Q2),
// T32's (Q3) and the VFP and Advanced SIMD ones (Q4) as they come.
//
// A64_AARCH32_SEED (default 1), A64_AARCH32_COUNT (cases per class, default
// 40), A64_AARCH32_ONLY=<class,...>, A64_AARCH32_SET=a32|t32 (default both
// that have classes)
import assert from "node:assert/strict";
import fs from "node:fs";
import { build, reference, actual, root } from "./guest_runner.mjs";

let seed = +(process.env.A64_AARCH32_SEED || 1) >>> 0 || 1;
const random = () => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed;
};
const bits = n => n >= 32 ? random() : random() & ((1 << n) - 1) >>> 0;
const pick = list => list[random() % list.length];
/** a register 0-14 (no PC), other than those given */
const reg = (...not) => { for(;;) { const r = random() % 15; if(!not.includes(r) && r !== 13) return r; } };
/** a register 0-14 with R13 allowed (a pointer's base) */
const cond = () => random() % 4 === 0 ? random() % 15 : 14;

// A case: the instruction's encoding, its set, the masks of the registers
// that point into the buffer and are small, the pointer offset
const A32 = {
    // (the fields that should be zero are: QEMU's decoder takes them as UNDEFINED)
    dp_imm() {
        const op = bits(4), s = op >= 8 && op <= 11 ? 1 : bits(1);
        const rd = op >= 8 && op <= 11 ? 0 : reg(), rn = op === 13 || op === 15 ? 0 : reg();
        return { word: cond() << 28 | 1 << 25 | op << 21 | s << 20 | rn << 16 | rd << 12 | bits(12) };
    },
    dp_shift() {
        const op = bits(4), s = op >= 8 && op <= 11 ? 1 : bits(1);
        const rd = op >= 8 && op <= 11 ? 0 : reg(), rn = op === 13 || op === 15 ? 0 : reg();
        return { word: cond() << 28 | op << 21 | s << 20 | rn << 16 | rd << 12 | bits(5) << 7 | bits(2) << 5 | reg() };
    },
    dp_register_shift() {
        const op = bits(4), s = op >= 8 && op <= 11 ? 1 : bits(1);
        const rd = op >= 8 && op <= 11 ? 0 : reg(), rn = op === 13 || op === 15 ? 0 : reg();
        return { word: cond() << 28 | op << 21 | s << 20 | rn << 16 | rd << 12 | reg() << 8 | bits(2) << 5 | 1 << 4 | reg() };
    },
    movw_movt() {
        return { word: cond() << 28 | 0x03 << 24 | pick([0, 4]) << 20 | bits(4) << 16 | reg() << 12 | bits(12) };
    },
    multiply() {
        const op = pick([0, 1, 2, 3, 4, 5, 6, 7]);
        const s = op === 2 || op === 3 ? 0 : bits(1);
        const rd = reg(), ra = op === 0 ? 0 : op >= 4 || op === 2 ? reg(rd) : reg();
        return { word: cond() << 28 | op << 21 | s << 20 | rd << 16 | ra << 12 | reg() << 8 | 0x9 << 4 | reg() };
    },
    halfword_multiply() {
        const op = bits(2), rd = reg(), xy = bits(2);
        // (SMULxy, SMULWy: no accumulator, its field 0)
        const ra = op === 2 ? reg(rd) : op === 3 || op === 1 && xy & 1 ? 0 : reg();
        return { word: cond() << 28 | 0x10 << 20 | op << 21 | rd << 16 | ra << 12 | reg() << 8 | 1 << 7 | xy << 5 | reg() };
    },
    signed_multiply() {
        const [op1, op2] = pick([[0, 0], [0, 1], [0, 2], [0, 3], [4, 0], [4, 1], [4, 2], [4, 3], [5, 0], [5, 1], [5, 6], [5, 7], [1, 0], [3, 0]]);
        const rd = reg();
        // (SMMLS's accumulator is not optional)
        const ra = op1 === 1 || op1 === 3 ? 15 : op1 === 4 || op1 === 5 && op2 >= 6 ? reg(rd) : random() % 3 === 0 ? 15 : reg();
        return { word: cond() << 28 | 0x7 << 24 | op1 << 20 | rd << 16 | ra << 12 | reg() << 8 | op2 << 5 | 1 << 4 | reg() };
    },
    parallel() {
        const kind = pick([1, 2, 3, 5, 6, 7]), op = pick([0, 1, 2, 3, 4, 7]);
        return { word: cond() << 28 | 0x6 << 24 | kind << 20 | reg() << 16 | reg() << 12 | 0xF << 8 | op << 5 | 1 << 4 | reg() };
    },
    pack_extend() {
        const [op1, op2] = pick([[0, 0], [0, 2], [0, 4], [0, 6], [0, 3], [0, 5], [2, 1], [2, 3], [3, 1], [3, 3], [3, 5], [4, 3], [6, 1], [6, 3],
            [7, 1], [7, 3], [7, 5]]);
        const rn = op2 === 3 && random() % 2 ? 15 : reg();
        let word = cond() << 28 | 0x6 << 24 | 1 << 23 | op1 << 20 | rn << 16 | reg() << 12 | op2 << 5 | 1 << 4 | reg();
        if(op2 === 3) word |= bits(2) << 10;
        else if(op2 === 1 || op2 === 5) word |= 0xF << 8 | (op1 === 2 || op1 === 6 || op1 === 0 ? 0 : 0xF << 16);
        else word |= bits(5) << 7;
        // (SSAT16, USAT16: the saturation in 19:16, 11:8 1111)
        if(op2 === 1 && (op1 === 2 || op1 === 6)) word = word & ~(0xF << 16) | bits(4) << 16;
        if(op2 === 5 && op1 === 0) word = word & ~(0xF << 8) | 0xF << 8;
        return { word };
    },
    saturate() {
        const unsigned = bits(1);
        return { word: cond() << 28 | 0x6 << 24 | 1 << 23 | (unsigned ? 6 : 2) << 20 | bits(5) << 16 | reg() << 12 | bits(5) << 7 | bits(1) << 6 | 1 << 4 | reg() };
    },
    reverse_clz() {
        if(random() % 4 === 0) return { word: cond() << 28 | 0x016F0F10 | reg() << 12 | reg() };
        const [op1, op2] = pick([[3, 1], [3, 5], [7, 1], [7, 5]]);
        return { word: cond() << 28 | 0x6 << 24 | 1 << 23 | op1 << 20 | 0xF << 16 | reg() << 12 | 0xF << 8 | op2 << 5 | 1 << 4 | reg() };
    },
    bitfield() {
        const kind = pick(["sbfx", "ubfx", "bfi", "bfc"]);
        const lsb = bits(5);
        if(kind === "sbfx" || kind === "ubfx")
        {
            const width = 1 + random() % (32 - lsb);
            return { word: cond() << 28 | (kind === "sbfx" ? 0x07A : 0x07E) << 20 | (width - 1) << 16 | reg() << 12 | lsb << 7 | 0x5 << 4 | reg() };
        }
        const msb = lsb + random() % (32 - lsb);
        return { word: cond() << 28 | 0x07C << 20 | msb << 16 | reg() << 12 | lsb << 7 | 0x1 << 4 | (kind === "bfc" ? 15 : reg()) };
    },
    usad() {
        return { word: cond() << 28 | 0x078 << 20 | reg() << 16 | (random() % 2 ? 15 : reg()) << 12 | reg() << 8 | 0x1 << 4 | reg() };
    },
    saturating_add() {
        return { word: cond() << 28 | 0x01 << 24 | bits(2) << 21 | reg() << 16 | reg() << 12 | 0x05 << 4 | reg() };
    },
    status() {
        const k = random() % 3;
        if(k === 0) return { word: cond() << 28 | 0x010F0000 | reg() << 12 };
        if(k === 1) return { word: cond() << 28 | 0x0120F000 | pick([1, 2, 3]) << 18 | reg() };
        return { word: cond() << 28 | 0x0320F000 | pick([1, 2, 3]) << 18 | bits(12) };
    },
    crc32() {
        return { word: cond() << 28 | 0x01 << 24 | bits(2) % 3 << 21 | reg() << 16 | reg() << 12 | bits(1) << 9 | 0x04 << 4 | reg() };
    },
    load_store() {
        const register = bits(1), p = bits(1), u = bits(1), b = bits(1), w = p ? bits(1) : 0, l = bits(1);
        const rn = reg(), rt = reg(rn);
        let word = cond() << 28 | 1 << 26 | register << 25 | p << 24 | u << 23 | b << 22 | w << 21 | l << 20 | rn << 16 | rt << 12;
        let small = 0;
        if(register)
        {
            const rm = reg(rn, rt);
            word |= bits(2) << 7 | pick([0, 1]) << 5 | rm;
            small |= 1 << rm;
        }
        else word |= bits(8);
        return { word, pointers: 1 << rn, small, offset: 0x100 * (random() % 2) | 0x100 };
    },
    extra_load_store() {
        const op2 = pick([1, 2, 3]), p = bits(1), u = bits(1), imm = bits(1), w = p ? bits(1) : 0;
        let l = bits(1);
        const dual = op2 >= 2 && !l;
        const rn = reg();
        let rt = reg(rn);
        if(dual) { rt = rt & ~1; if(rt === 12 || rt === rn || rt + 1 === rn) rt = (rn + 2) & ~1 % 12; if(rt === rn || rt + 1 === rn || rt >= 12) rt = rn < 6 ? 8 : 2; }
        let word = cond() << 28 | p << 24 | u << 23 | imm << 22 | w << 21 | l << 20 | rn << 16 | rt << 12 | 1 << 7 | op2 << 5 | 1 << 4;
        let small = 0;
        if(imm) word |= bits(4) << 8 | bits(4);
        else { const rm = reg(rn, rt, rt + 1); word |= rm; small |= 1 << rm; }
        return { word, pointers: 1 << rn, small, offset: 0x100 };
    },
    block() {
        const p = bits(1), u = bits(1), w = bits(1), l = bits(1);
        const rn = reg();
        let list = bits(15) & ~(1 << 13);
        if(w || l) list &= ~(1 << rn);
        if(!list) list = 1 << reg(rn);
        return { word: cond() << 28 | 0x4 << 25 | p << 24 | u << 23 | w << 21 | l << 20 | rn << 16 | list, pointers: 1 << rn, offset: 0x80 };
    },
    exclusive() {
        const size = bits(2), l = bits(1), kind = pick([3, 2, 0]);
        const rn = reg();
        let rt = reg(rn);
        if(size === 1) rt = rt & ~1 === rn || (rt & ~1) + 1 === rn ? (rn < 6 ? 8 : 2) : rt & ~1;
        if(size === 1 && rt >= 12) rt = rn < 6 ? 8 : 2;
        const status = kind === 0 ? 15 : l ? 15 : reg(rn, rt, rt + 1);
        const word = cond() << 28 | 0x1 << 24 | 1 << 23 | size << 21 | l << 20 | rn << 16 | (l ? rt : status) << 12 | 0x3 << 10 | kind << 8 | 0x9 << 4 |
            (l ? 15 : rt);
        return { word: kind === 0 && !l ? word | 0xF << 12 : word, pointers: 1 << rn, offset: 0 };
    },
    cp15() {
        const k = random() % 4;
        if(k === 0) return { word: cond() << 28 | 0x0E1D0F50 | 1 << 20 | reg() << 12 };            // MRC TPIDRURW
        if(k === 1) return { word: cond() << 28 | 0x0E0D0F50 | reg() << 12 };                    // MCR TPIDRURW
        if(k === 2) return { word: cond() << 28 | 0x0E1D0F70 | reg() << 12 };                    // MRC TPIDRURO
        return { word: cond() << 28 | 0x0E070FBA | (random() % 2 ? 0x10 : 0) | reg() << 12 };    // MCR CP15DMB, CP15DSB
    },
};

// T32: 16-bit instructions are their halfword, 32-bit ones first << 16 | second
const lo = (...not) => { for(;;) { const r = random() % 8; if(!not.includes(r)) return r; } };
/** a T32 register 0-14 but SP */
const treg = (...not) => reg(...not);
/** T32's data processing op (bits 8:5 of the first halfword) */
const T32_OPS = [0, 1, 2, 3, 4, 8, 10, 11, 13, 14];
const T32 = {
    t16_shift_add_mov() { return { word: bits(14) }; },
    t16_data_processing() { return { word: 0x4000 | bits(10) }; },
    t16_special() {
        const op = pick([0, 1, 2]);
        let rdn = treg(), rm = treg();
        if(op === 1 && rdn < 8 && rm < 8) rdn = 8 + random() % 5;
        return { word: 0x4400 | op << 8 | (rdn & 8) << 4 | rm << 3 | rdn & 7 };
    },
    t16_load_store() {
        const k = random() % 4;
        if(k === 0)
        {
            const rn = lo(), rm = lo(rn), rt = lo(rn);
            return { word: 0x5000 | bits(3) << 9 | rm << 6 | rn << 3 | rt, pointers: 1 << rn, small: 1 << rm, offset: 0x100 };
        }
        if(k === 1 || k === 2)
        {
            const rn = lo(), rt = lo();
            const top = pick([0x6000, 0x7000, 0x8000]);
            return { word: top | bits(1) << 11 | bits(5) << 6 | rn << 3 | rt, pointers: 1 << rn, offset: 0 };
        }
        return { word: 0x9000 | bits(1) << 11 | lo() << 8 | bits(6), pointers: 1 << 13, offset: 0 };
    },
    t16_misc() {
        const k = random() % 6;
        if(k === 0) return { word: 0xB000 | bits(8) };
        if(k === 1) return { word: 0xB200 | bits(6) };
        if(k === 2) return { word: 0xBA00 | pick([0, 1, 3]) << 6 | bits(6) };
        if(k === 3) return { word: 0xA000 | bits(11) };
        if(k === 4) return { word: 0xB400 | bits(9) | 1, pointers: 1 << 13, offset: 0x80 };
        return { word: 0xBC00 | (bits(8) | 1), pointers: 1 << 13, offset: 0 };
    },
    t16_ldm_stm() {
        const rn = lo();
        let list = bits(8) & ~(1 << rn) | 1 << lo(rn);
        if(random() % 4 === 0) list |= 1 << rn;
        const l = bits(1);
        // (STM with the base in the list: only as the lowest register)
        if(!l && list & 1 << rn && list & ((1 << rn) - 1)) list &= ~(1 << rn);
        return { word: 0xC000 | l << 11 | rn << 8 | list, pointers: 1 << rn, offset: 0 };
    },
    t32_modified_immediate() {
        const op = pick(T32_OPS), s = bits(1);
        let rn = treg(), rd = treg();
        let sbit = s;
        if(random() % 5 === 0 && (op === 0 || op === 4 || op === 8 || op === 13)) { rd = 15; sbit = 1; }
        if(random() % 5 === 0 && (op === 2 || op === 3)) rn = 15;
        return { word: (0xF000 | bits(1) << 10 | op << 5 | sbit << 4 | rn) << 16 | bits(3) << 12 | rd << 8 | bits(8) };
    },
    t32_shifted_register() {
        const op = pick([...T32_OPS, 6]), s = op === 6 ? 0 : bits(1);
        let rn = treg(), rd = treg();
        let sbit = s;
        if(random() % 5 === 0 && (op === 0 || op === 4 || op === 8 || op === 13)) { rd = 15; sbit = 1; }
        if(random() % 5 === 0 && (op === 2 || op === 3)) rn = 15;
        const type = op === 6 ? bits(1) << 1 : bits(2);
        return { word: (0xEA00 | op << 5 | sbit << 4 | rn) << 16 | bits(3) << 12 | rd << 8 | bits(2) << 6 | type << 4 | treg() };
    },
    t32_plain_immediate() {
        const k = random() % 6;
        const rd = treg(), rn = treg();
        if(k === 0) return { word: (0xF200 | bits(1) << 10 | pick([0, 0xA]) << 4 | (random() % 4 ? rn : 15)) << 16 | bits(3) << 12 | rd << 8 | bits(8) };
        if(k === 1) return { word: (0xF240 | bits(1) << 10 | pick([0, 8]) << 4 | bits(4)) << 16 | bits(3) << 12 | rd << 8 | bits(8) };
        if(k === 2)
        {
            const op = pick([0x10, 0x12, 0x18, 0x1A]);
            const sixteen = random() % 3 === 0;
            const h1 = 0xF300 | (op & 0xF) << 4 | (sixteen ? 0x20 : bits(1) << 5) | rn;
            if(sixteen) return { word: (0xF300 | (op | 2) << 4 & 0xF0 | 0x20 | rn) << 16 | rd << 8 | bits(4) };
            const imm = bits(5);
            return { word: h1 << 16 | (imm >> 2) << 12 | rd << 8 | (imm & 3) << 6 | (imm === 0 && h1 & 0x20 ? 1 : bits(5)) };
        }
        const lsb = bits(5);
        if(k === 3 || k === 4)
        {
            const width = 1 + random() % (32 - lsb);
            return { word: (0xF340 | (k === 3 ? 0 : 0x80) | rn) << 16 | (lsb >> 2) << 12 | rd << 8 | (lsb & 3) << 6 | width - 1 };
        }
        const msb = lsb + random() % (32 - lsb);
        return { word: (0xF360 | (random() % 3 ? rn : 15)) << 16 | (lsb >> 2) << 12 | rd << 8 | (lsb & 3) << 6 | msb };
    },
    t32_data_register() {
        const k = random() % 6;
        const rd = treg(), rn = treg(), rm = treg();
        if(k === 0) return { word: (0xFA00 | bits(2) << 5 | bits(1) << 4 | rn) << 16 | 0xF000 | rd << 8 | rm };
        if(k === 1) return { word: (0xFA00 | pick([0, 1, 2, 3, 4, 5]) << 4 | (random() % 2 ? rn : 15)) << 16 | 0xF000 | rd << 8 | 0x80 | bits(2) << 4 | rm };
        if(k === 2) return { word: (0xFA80 | pick([1, 2, 6, 5, 0, 4]) << 4 | rn) << 16 | 0xF000 | rd << 8 | pick([0, 1, 2, 4, 5, 6]) << 4 | rm };
        if(k === 3) return { word: (0xFA80 | rn) << 16 | 0xF000 | rd << 8 | 0x80 | bits(2) << 4 | rm };
        if(k === 4)
        {
            const [op1, op2] = pick([[1, 0], [1, 1], [1, 2], [1, 3], [2, 0], [3, 0]]);
            const n = op1 === 2 ? rn : rm;
            return { word: (0xFA80 | (8 | op1) << 4 | n) << 16 | 0xF000 | rd << 8 | (8 | op2) << 4 | rm };
        }
        return { word: (0xFAC0 | bits(1) << 4 | rn) << 16 | 0xF000 | rd << 8 | 0x80 | (random() % 3) << 4 | rm };
    },
    t32_multiply() {
        const rd = treg(), rn = treg(), rm = treg();
        if(random() % 2)
        {
            const [op1, op2s] = pick([[0, [0, 1]], [1, [0, 1, 2, 3]], [2, [0, 1]], [3, [0, 1]], [4, [0, 1]], [5, [0, 1]], [6, [0, 1]], [7, [0]]]);
            const op2 = pick(op2s);
            const ra = op1 === 6 || op1 === 0 && op2 === 1 ? treg() : random() % 3 ? treg() : 15;
            return { word: (0xFB00 | op1 << 4 | rn) << 16 | ra << 12 | rd << 8 | op2 << 4 | rm };
        }
        const [op1, op2] = pick([[0, 0], [1, 15], [2, 0], [3, 15], [4, 0], [4, 8], [4, 9], [4, 10], [4, 11], [4, 12], [4, 13], [5, 12], [5, 13], [6, 0], [6, 6]]);
        const lo_ = op2 === 15 ? 15 : treg(rd);
        return { word: (0xFB80 | op1 << 4 | rn) << 16 | lo_ << 12 | rd << 8 | op2 << 4 | rm };
    },
    t32_load_store() {
        const size = random() % 3, signed = size < 2 ? bits(1) : 0, l = signed ? 1 : bits(1);
        const rn = treg(), rt = treg(rn);
        const h1 = 0xF800 | signed << 8 | size << 5 | l << 4;
        const k = random() % 4;
        if(k === 0) return { word: (h1 | 0x80 | rn) << 16 | rt << 12 | bits(8), pointers: 1 << rn, offset: 0 };
        if(k === 1)
        {
            const p = bits(1), w = p ? bits(1) : 1;
            return { word: (h1 | rn) << 16 | rt << 12 | 0x800 | p << 10 | bits(1) << 9 | w << 8 | bits(8), pointers: 1 << rn, offset: 0x100 };
        }
        if(k === 2)
        {
            const rm = treg(rn, rt);
            return { word: (h1 | rn) << 16 | rt << 12 | bits(2) << 4 | rm, pointers: 1 << rn, small: 1 << rm, offset: 0 };
        }
        return { word: (h1 | rn) << 16 | rt << 12 | 0xE00 | bits(8), pointers: 1 << rn, offset: 0 };
    },
    t32_ldm_stm() {
        const rn = treg(), l = bits(1), w = bits(1);
        let list = bits(13) & ~(1 << rn);
        if(list.toString(2).replace(/0/g, "").length < 2) list |= 1 << treg(rn) | 1 << treg(rn);
        list &= ~(1 << rn) & ~(1 << 13);
        if(list.toString(2).replace(/0/g, "").length < 2) list = (rn === 0 ? 6 : 1 | 1 << (rn === 1 ? 2 : 1));
        return { word: (0xE800 | pick([1, 2]) << 7 | w << 5 | l << 4 | rn) << 16 | list, pointers: 1 << rn, offset: 0x80 };
    },
    t32_ldrd_strd() {
        const rn = treg(), l = bits(1);
        const rt = treg(rn), rt2 = treg(rn, rt);
        const p = bits(1), w = p ? bits(1) : 1;
        return { word: (0xE840 | p << 8 | bits(1) << 7 | w << 5 | l << 4 | rn) << 16 | rt << 12 | rt2 << 8 | bits(6) & ~3, pointers: 1 << rn, offset: 0x100 };
    },
    t32_exclusive() {
        const rn = treg(), l = bits(1), rt = treg(rn);
        const k = random() % 3;
        if(k === 0)
        {
            const rd = l ? 15 : treg(rn, rt);
            return { word: (0xE840 | l << 4 | rn) << 16 | rt << 12 | rd << 8 | bits(2), pointers: 1 << rn, offset: 0 };
        }
        if(k === 1)
        {
            const op = pick([4, 5, 7]);
            const rt2 = op === 7 ? treg(rn, rt) : 15;
            const rd = l ? 15 : treg(rn, rt, rt2);
            return { word: (0xE8C0 | l << 4 | rn) << 16 | rt << 12 | rt2 << 8 | op << 4 | rd, pointers: 1 << rn, offset: 0 };
        }
        const op = pick([8, 9, 10, 12, 13, 14, 15]);
        const rt2 = op === 15 ? treg(rn, rt) : 15;
        const rd = l || op < 12 ? 15 : treg(rn, rt, rt2);
        return { word: (0xE8C0 | l << 4 | rn) << 16 | rt << 12 | rt2 << 8 | op << 4 | rd, pointers: 1 << rn, offset: 0 };
    },
    // (one instruction in an IT block: the 16-bit ones do not set the flags there)
    t16_in_it() {
        const c = random() % 14, first = c;
        // (IT <cond> with one instruction: mask 1000)
        const it = 0xBF00 | first << 4 | 0x8;
        let word;
        do word = random() % 2 ? bits(14) : 0x4000 | bits(10); while(word >> 11 === 0 && (word >> 6 & 31) === 0);
        return { word, prefix: it };
    },
    t32_in_it() {
        const c = random() % 14;
        const inner = pick([T32.t32_modified_immediate, T32.t32_shifted_register, T32.t32_data_register, T32.t32_multiply])();
        return { ...inner, prefix: 0xBF00 | c << 4 | 0x8 };
    },
    t32_status() {
        if(random() % 2) return { word: 0xF3EF8000 | treg() << 8 };
        return { word: (0xF380 | treg()) << 16 | 0x8000 | pick([1, 2, 3]) << 10 };
    },
};

const sets = (process.env.A64_AARCH32_SET || "a32,t32").split(",");
const only = process.env.A64_AARCH32_ONLY ? process.env.A64_AARCH32_ONLY.split(",") : null;
const count = +process.env.A64_AARCH32_COUNT || 40;
const cases = [];
for(const [set, classes] of [["a32", A32], ["t32", T32]])
{
    if(!sets.includes(set)) continue;
    for(const [name, make] of Object.entries(classes))
    {
        if(only && !only.includes(name)) continue;
        for(let i = 0; i < count; i++)
        {
            const c = make();
            cases.push({ set, name, word: c.word >>> 0, prefix: c.prefix, pointers: c.pointers || 0, small: c.small || 0, offset: c.offset || 0,
                psr: (random() & 0xF80F0000) >>> 0, seed: random() });
        }
    }
}
assert.ok(cases.length, "no cases");

// the binary: the table, then each case's code (the instruction, SVC #0) in 8 bytes
const lines = ["// Generated by tests/a64/aarch32_oracle.mjs; do not edit.", "    .syntax unified", "    .arm", "base:", `    .word ${cases.length}`];
const code = [];
cases.forEach((c, i) => {
    const at = `code_${i} - base`;
    const thumb = c.set === "t32";
    const wide = thumb && c.word > 0xFFFF;
    const delta = thumb ? (wide ? 6 : 4) + (c.prefix ? 2 : 0) : 8;
    const prefix = c.prefix ? `0x${c.prefix.toString(16)}, ` : "";
    lines.push(`    .word ${at}${thumb ? " + 1" : ""}, 0x${c.psr.toString(16)}, 0x${c.pointers.toString(16)}, 0x${c.small.toString(16)}, 0x${c.seed.toString(16)}, ` +
        `0x${(delta << 16 | c.offset).toString(16)}`);
    if(thumb)
    {
        code.push(`    .balign 8`, `code_${i}:`, wide ? `    .hword ${prefix}0x${(c.word >>> 16).toString(16)}, 0x${(c.word & 0xFFFF).toString(16)}, 0xdf00` :
            `    .hword ${prefix}0x${c.word.toString(16)}, 0xdf00`);
    }
    else code.push(`    .balign 8`, `code_${i}:`, `    .word 0x${c.word.toString(16)}, 0xef000000`);
});
const source = root + "build/a64-aarch32-oracle-cases/oracle.a32.S";
fs.mkdirSync(root + "build/a64-aarch32-oracle-cases", { recursive: true });
fs.writeFileSync(source, lines.join("\n") + "\n" + code.join("\n") + "\n");

const directory = build("aarch32-oracle", [root + "tests/a64/aarch32/oracle.c", root + "tests/a64/aarch32/el0_run.S", source]);
const expected = await reference(directory, { timeout: 120000 });
assert.equal(expected.status, "ok", "QEMU: " + expected.status + "\n" + expected.text.slice(-2000));
const got = await actual(directory, { options: { a64_profile: "v3" }, timeout: 120000 });
const a = expected.text.split("\n"), b = got.text.split("\n");
const differences = [];
for(let i = 0; i < cases.length; i++)
{
    if(a[i] !== b[i]) differences.push(i);
}
const by_class = {};
for(const i of differences) (by_class[cases[i].set + ":" + cases[i].name] = by_class[cases[i].set + ":" + cases[i].name] || []).push(i);
for(const [name, list] of Object.entries(by_class))
{
    console.log(`${name}: ${list.length} differences`);
    for(const i of list.slice(0, 3))
    {
        console.log(`  ${cases[i].set} ${cases[i].word.toString(16).padStart(8, "0")} psr ${cases[i].psr.toString(16)}\n    QEMU: ${a[i]}\n    v86:  ${b[i]}`);
    }
}
assert.equal(got.status, "ok", "v86: " + got.status + "\n" + got.text.slice(-500));
const classes = new Set(cases.map(c => c.set + ":" + c.name)).size;
assert.equal(differences.length, 0, `${differences.length} of ${cases.length} cases differ`);
console.log(`aarch32 oracle: ${cases.length} cases (${classes} classes, seed ${process.env.A64_AARCH32_SEED || 1}), 0 differences`);
