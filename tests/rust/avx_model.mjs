// The AVX forms (VEX.128, VEX.LIG and VEX.256) of tests/rust/avx.mjs and
// tests/x64/avx.mjs and their semantics, written from the SDM's operation
// sections independently of src/rust/cpu/avx.rs. Registers and memory
// operands are BigInts, lane 0 in the low bits. The forms that have legacy
// SSE counterparts use those forms' models (packed_model.mjs,
// shuffle_model.mjs, ssse3_model.mjs, sse4_model.mjs) with VEX's operands.
import assert from "node:assert/strict";
import { packed, packedImmediate as packed_immediate } from "./packed_model.mjs";
import { shuffle } from "./shuffle_model.mjs";
import { model as ssse3 } from "./ssse3_model.mjs";
import { compare_strings, extract, insert, insertps, ptest, sse4_38, sse4_3a } from "./sse4_model.mjs";
import { FORMS as SSE_FP, expect } from "./sse_fp_cases.mjs";
import { Fp } from "./sse_fp_model.mjs";

export const big = b => b.reduceRight((v, x) => v << 8n | BigInt(x), 0n);
export const le = (v, n = 16) => Uint8Array.from({ length: n }, (_, i) => Number(v >> BigInt(8 * i) & 255n));
export const mask = bits => (1n << BigInt(bits)) - 1n;
export const LOW = mask(64);
export const lanes = (v, bits, width = 128) => Array.from({ length: width / bits }, (_, i) => v >> BigInt(i * bits) & mask(bits));
// AVX2: an element (`size` bytes) in each lane of `width` bits; the variable
// shifts (VPSRLVD/Q 45, VPSRAVD 46, VPSLLVD/Q 47) of `bits`-wide elements
const splat = (v, size, width) => join(Array(width / (8 * size)).fill(v & mask(8 * size)), 8 * size);
const variable_shift = (op, bits, a, b, width = 128) => join(lanes(a, bits, width).map((x, n) => {
    const count = lanes(b, bits, width)[n], wide = count >= BigInt(bits);
    if(op === 0x46) return BigInt.asUintN(bits, BigInt.asIntN(bits, x) >> (wide ? BigInt(bits - 1) : count));
    return wide ? 0n : op === 0x45 ? x >> count : x << count & mask(bits);
}), bits);
export const join = (values, bits) => values.reduceRight((v, x) => v << BigInt(bits) | x, 0n);

const unpack = (bits, high) => (a, b) => {
    const [x, y] = [lanes(a, bits), lanes(b, bits)];
    const start = high ? x.length / 2 : 0;
    return join(x.slice(start, start + x.length / 2).flatMap((v, i) => [v, y[start + i]]), bits);
};
const signs = (bits, width = 128) => v => join(lanes(v, bits, width).map(l => l >> BigInt(bits - 1)), 1);
// VEX.256: a 256-bit value's halves, and f (of a VEX.128 form) on each
// (operands BigInts, then imm8, a Number: `high` the high half's imm8)
const low128 = v => v & mask(128), high128 = v => v >> 128n;
const halves = (f, high = imm8 => imm8) => (...operands) => {
    const imm8 = typeof operands.at(-1) === "number" ? [operands.pop()] : [];
    return join([f(...operands.map(low128), ...imm8), f(...operands.map(high128), ...imm8.map(high))], 128);
};
// the other models' operands: 32-bit words, bytes
const words = v => Array.from({ length: 4 }, (_, i) => Number(v >> BigInt(32 * i) & 0xFFFFFFFFn));
const from_words = w => w.reduceRight((v, x) => v << 32n | BigInt(x >>> 0), 0n);
const ZERO = new Uint8Array(16);
// the packed integer operations of 66 0F
const PACKED = {
    0x60: "vpunpcklbw", 0x61: "vpunpcklwd", 0x62: "vpunpckldq", 0x63: "vpacksswb", 0x64: "vpcmpgtb", 0x65: "vpcmpgtw",
    0x66: "vpcmpgtd", 0x67: "vpackuswb", 0x68: "vpunpckhbw", 0x69: "vpunpckhwd", 0x6A: "vpunpckhdq", 0x6B: "vpackssdw",
    0x6C: "vpunpcklqdq", 0x6D: "vpunpckhqdq", 0x74: "vpcmpeqb", 0x75: "vpcmpeqw", 0x76: "vpcmpeqd", 0xD1: "vpsrlw",
    0xD2: "vpsrld", 0xD3: "vpsrlq", 0xD4: "vpaddq", 0xD5: "vpmullw", 0xD8: "vpsubusb", 0xD9: "vpsubusw", 0xDA: "vpminub",
    0xDC: "vpaddusb", 0xDD: "vpaddusw", 0xDE: "vpmaxub", 0xE0: "vpavgb", 0xE1: "vpsraw", 0xE2: "vpsrad", 0xE3: "vpavgw",
    0xE4: "vpmulhuw", 0xE5: "vpmulhw", 0xE8: "vpsubsb", 0xE9: "vpsubsw", 0xEA: "vpminsw", 0xEC: "vpaddsb", 0xED: "vpaddsw",
    0xEE: "vpmaxsw", 0xF1: "vpsllw", 0xF2: "vpslld", 0xF3: "vpsllq", 0xF4: "vpmuludq", 0xF5: "vpmaddwd", 0xF6: "vpsadbw",
    0xF8: "vpsubb", 0xF9: "vpsubw", 0xFA: "vpsubd", 0xFB: "vpsubq", 0xFC: "vpaddb", 0xFD: "vpaddw", 0xFE: "vpaddd",
};
const SSSE3 = { 0x00: "vpshufb", 0x01: "vphaddw", 0x02: "vphaddd", 0x03: "vphaddsw", 0x04: "vpmaddubsw", 0x05: "vphsubw",
    0x06: "vphsubd", 0x07: "vphsubsw", 0x08: "vpsignb", 0x09: "vpsignw", 0x0A: "vpsignd", 0x0B: "vpmulhrsw" };
const SSE4 = { 0x28: "vpmuldq", 0x29: "vpcmpeqq", 0x2B: "vpackusdw", 0x37: "vpcmpgtq", 0x38: "vpminsb", 0x39: "vpminsd",
    0x3A: "vpminuw", 0x3B: "vpminud", 0x3C: "vpmaxsb", 0x3D: "vpmaxsd", 0x3E: "vpmaxuw", 0x3F: "vpmaxud", 0x40: "vpmulld" };
const EXTEND = ["bw", "bd", "bq", "wd", "wq", "dq"];
// The gathers (AVX2, P8): opcode, VEX.W, name, element and index sizes
const GATHERS = [[0x90, 0, "vpgatherdd", 4, 4], [0x90, 1, "vpgatherdq", 8, 4], [0x91, 0, "vpgatherqd", 4, 8],
    [0x91, 1, "vpgatherqq", 8, 8], [0x92, 0, "vgatherdps", 4, 4], [0x92, 1, "vgatherdpd", 8, 4], [0x93, 0, "vgatherqps", 4, 8],
    [0x93, 1, "vgatherqpd", 8, 8]];
// VPBROADCASTB/W/D/Q (AVX2): opcode, element size
const BROADCASTS = [[0x78, 1, "vpbroadcastb"], [0x79, 2, "vpbroadcastw"], [0x58, 4, "vpbroadcastd"], [0x59, 8, "vpbroadcastq"]];

/**
 * The forms: name, map (1: 0F, 2: 0F38, 3: 0F3A; 1 if absent), pp (0, 1:
 * 66, 2: F3, 3: F2), opcode, `group` (ModRM.reg, an opcode extension), and
 * what the instruction does (`kind`, with `f`). `bytes`: the memory
 * operand's size; `aligned`: #GP(0) unless 16-byte aligned; `memory` or
 * `register`: only that form of the r/m operand. `w`: the VEX.W the form
 * requires (WIG, or W0 and W1 ignored outside 64-bit mode, if absent;
 * `wig32`: required in 64-bit mode only); `lig`: VEX.L ignored. Kinds, with d the ModRM.reg register, v VEX.vvvv's
 * and m the r/m operand (a register or memory):
 *   load       d = f(m)
 *   store      m = d (a register destination is a VEX.128 one)
 *   binary     d = f(v, m)
 *   scalar     VMOVSS/VMOVSD 10: d = m from memory, zero-extended; between registers v's upper lanes, m's low one
 *   scalar_st  VMOVSS/VMOVSD 11: m = d to memory; between registers m = v's upper lanes, d's low one
 *   low, high  12/16: one quadword of d from m (a register's high/low one, or m64), the other from v
 *   store64    13/17: m64 = d's low/high quadword
 *   to_gpr     the r/m register d, the general-purpose register the ModRM.reg (f of the XMM register)
 *   gpr_load   VMOVD/VMOVQ xmm, r/m: d = m zero-extended
 *   gpr_store  VMOVD/VMOVQ r/m, xmm: m = d's low dword or quadword
 *   zero_upper VZEROUPPER
 *   ldmxcsr, stmxcsr, maskmov (VMASKMOVDQU: [rDI] = d's bytes the r/m register selects)
 *   load_imm, binary_imm   load and binary with imm8 (f's last argument)
 *   shift_imm  v = f(m register, imm8): VEX.vvvv is the destination
 *   ptest      the flags of d and m
 *   extract    m (a general-purpose register, or memory) = d's element imm8 of `size` bytes
 *   insert     d = v with element imm8 of `size` bytes from m (a general-purpose register's low bytes, or memory)
 *   insertps   d = v with m's dword imm8[7:6] (or the m32) in dword imm8[5:4], dwords imm8[3:0] zeroed
 *   blendv     d = v's or m's bytes, as the sign of the register imm8[7:4]'s bytes selects
 *   pcmpstr    PCMPxSTRx of d and m: ECX (the index) or XMM0 (the mask), and the flags
 *   vtest      ZF and CF of the sign bits of d's and m's lanes of `lane` bytes
 *   maskload   d = m's lanes the sign bits of v's select, the others zero
 *   maskstore  m's lanes the sign bits of v's select = d's
 *   fp         the floating-point form `legacy` of tests/rust/sse_fp_cases.mjs (its
 *              model, MXCSR's flags after) with `operands`: "two" (d = f(m)),
 *              "three" (d = f(v, m)), "comi" (the flags of d and m), "to_gpr" (the
 *              register d = f(m)) or "from_gpr" (d = v with lane 0 from the register
 *              or memory m); `scalar`, `double` as the legacy form's
 */
const FORMS_128 = [
    // full-width loads and stores
    { name: "vmovups", pp: 0, op: 0x10, kind: "load" }, { name: "vmovupd", pp: 1, op: 0x10, kind: "load" },
    { name: "vmovaps", pp: 0, op: 0x28, kind: "load", aligned: true }, { name: "vmovapd", pp: 1, op: 0x28, kind: "load", aligned: true },
    { name: "vmovdqa", pp: 1, op: 0x6F, kind: "load", aligned: true }, { name: "vmovdqu", pp: 2, op: 0x6F, kind: "load" },
    { name: "vlddqu", pp: 3, op: 0xF0, kind: "load", memory: true },
    { name: "vmovntdqa", map: 2, pp: 1, op: 0x2A, kind: "load", aligned: true, memory: true },
    { name: "vmovups", pp: 0, op: 0x11, kind: "store" }, { name: "vmovupd", pp: 1, op: 0x11, kind: "store" },
    { name: "vmovaps", pp: 0, op: 0x29, kind: "store", aligned: true }, { name: "vmovapd", pp: 1, op: 0x29, kind: "store", aligned: true },
    { name: "vmovdqa", pp: 1, op: 0x7F, kind: "store", aligned: true }, { name: "vmovdqu", pp: 2, op: 0x7F, kind: "store" },
    { name: "vmovntps", pp: 0, op: 0x2B, kind: "store", aligned: true, memory: true },
    { name: "vmovntpd", pp: 1, op: 0x2B, kind: "store", aligned: true, memory: true },
    { name: "vmovntdq", pp: 1, op: 0xE7, kind: "store", aligned: true, memory: true },
    // scalar moves (VEX.LIG)
    { name: "vmovss", pp: 2, op: 0x10, kind: "scalar", bytes: 4, lig: true }, { name: "vmovsd", pp: 3, op: 0x10, kind: "scalar", bytes: 8, lig: true },
    { name: "vmovss", pp: 2, op: 0x11, kind: "scalar_st", bytes: 4, lig: true }, { name: "vmovsd", pp: 3, op: 0x11, kind: "scalar_st", bytes: 8, lig: true },
    // quadword moves
    { name: "vmovhlps/vmovlps", pp: 0, op: 0x12, kind: "low" }, { name: "vmovlpd", pp: 1, op: 0x12, kind: "low", memory: true },
    { name: "vmovlhps/vmovhps", pp: 0, op: 0x16, kind: "high" }, { name: "vmovhpd", pp: 1, op: 0x16, kind: "high", memory: true },
    { name: "vmovlps", pp: 0, op: 0x13, kind: "store64", memory: true }, { name: "vmovlpd", pp: 1, op: 0x13, kind: "store64", memory: true },
    { name: "vmovhps", pp: 0, op: 0x17, kind: "store64", memory: true }, { name: "vmovhpd", pp: 1, op: 0x17, kind: "store64", memory: true },
    // duplicates
    { name: "vmovsldup", pp: 2, op: 0x12, kind: "load", f: v => { const l = lanes(v, 32); return join([l[0], l[0], l[2], l[2]], 32); } },
    { name: "vmovshdup", pp: 2, op: 0x16, kind: "load", f: v => { const l = lanes(v, 32); return join([l[1], l[1], l[3], l[3]], 32); } },
    { name: "vmovddup", pp: 3, op: 0x12, kind: "load", bytes: 8, f: v => join([v & LOW, v & LOW], 64) },
    // unpacks and logic
    { name: "vunpcklps", pp: 0, op: 0x14, kind: "binary", f: unpack(32, false) }, { name: "vunpcklpd", pp: 1, op: 0x14, kind: "binary", f: unpack(64, false) },
    { name: "vunpckhps", pp: 0, op: 0x15, kind: "binary", f: unpack(32, true) }, { name: "vunpckhpd", pp: 1, op: 0x15, kind: "binary", f: unpack(64, true) },
    ...[0, 1].flatMap(pp => [
        { name: pp ? "vandpd" : "vandps", pp, op: 0x54, kind: "binary", f: (a, b) => a & b },
        { name: pp ? "vandnpd" : "vandnps", pp, op: 0x55, kind: "binary", f: (a, b) => ~a & b & mask(128) },
        { name: pp ? "vorpd" : "vorps", pp, op: 0x56, kind: "binary", f: (a, b) => a | b },
        { name: pp ? "vxorpd" : "vxorps", pp, op: 0x57, kind: "binary", f: (a, b) => a ^ b },
    ]),
    { name: "vpand", pp: 1, op: 0xDB, kind: "binary", f: (a, b) => a & b }, { name: "vpandn", pp: 1, op: 0xDF, kind: "binary", f: (a, b) => ~a & b & mask(128) },
    { name: "vpor", pp: 1, op: 0xEB, kind: "binary", f: (a, b) => a | b }, { name: "vpxor", pp: 1, op: 0xEF, kind: "binary", f: (a, b) => a ^ b },
    // to general-purpose registers
    { name: "vmovmskps", pp: 0, op: 0x50, kind: "to_gpr", register: true, f: signs(32) },
    { name: "vmovmskpd", pp: 1, op: 0x50, kind: "to_gpr", register: true, f: signs(64) },
    { name: "vpmovmskb", pp: 1, op: 0xD7, kind: "to_gpr", register: true, f: signs(8) },
    // VMOVD and VMOVQ (W1: 64-bit general-purpose operands, 64-bit mode only)
    { name: "vmovd", pp: 1, op: 0x6E, kind: "gpr_load", w: 0, wig32: true }, { name: "vmovq", pp: 1, op: 0x6E, kind: "gpr_load", w: 1, long: true },
    { name: "vmovd", pp: 1, op: 0x7E, kind: "gpr_store", w: 0, wig32: true }, { name: "vmovq", pp: 1, op: 0x7E, kind: "gpr_store", w: 1, long: true },
    { name: "vmovq", pp: 2, op: 0x7E, kind: "load", bytes: 8, f: v => v & LOW },
    { name: "vmovq", pp: 1, op: 0xD6, kind: "store", bytes: 8, f: v => v & LOW },
    // state
    { name: "vzeroupper", pp: 0, op: 0x77, kind: "zero_upper" },
    { name: "vldmxcsr", pp: 0, op: 0xAE, group: 2, kind: "ldmxcsr", memory: true, bytes: 4 },
    { name: "vstmxcsr", pp: 0, op: 0xAE, group: 3, kind: "stmxcsr", memory: true, bytes: 4 },
    { name: "vmaskmovdqu", pp: 1, op: 0xF7, kind: "maskmov", register: true },

    // P5 part 2: the integer forms
    ...Object.entries(PACKED).map(([op, name]) => ({ name, pp: 1, op: +op, kind: "binary",
        f: (a, b) => from_words(packed(0x660F00 | +op, words(a), words(b))) })),
    ...[[0x71, 2, "vpsrlw"], [0x71, 4, "vpsraw"], [0x71, 6, "vpsllw"], [0x72, 2, "vpsrld"], [0x72, 4, "vpsrad"], [0x72, 6, "vpslld"],
        [0x73, 2, "vpsrlq"], [0x73, 3, "vpsrldq"], [0x73, 6, "vpsllq"], [0x73, 7, "vpslldq"]].map(([op, group, name]) =>
        ({ name, pp: 1, op, group, kind: "shift_imm", register: true, f: (v, imm8) => from_words(packed_immediate(0x660F00 | op, group, imm8, words(v))) })),
    ...[[1, 0x660F70, "vpshufd"], [2, 0xF30F70, "vpshufhw"], [3, 0xF20F70, "vpshuflw"]].map(([pp, key, name]) =>
        ({ name, pp, op: 0x70, kind: "load_imm", f: (v, imm8) => from_words(shuffle(key, imm8, [0, 0, 0, 0], words(v))) })),
    ...[[0, 0x0FC6, "vshufps"], [1, 0x660FC6, "vshufpd"]].map(([pp, key, name]) =>
        ({ name, pp, op: 0xC6, kind: "binary_imm", f: (a, b, imm8) => from_words(shuffle(key, imm8, words(a), words(b))) })),
    { name: "vpinsrw", pp: 1, op: 0xC4, kind: "insert", size: 2, w: 0, wig32: true },
    { name: "vpinsrw", pp: 1, op: 0xC4, kind: "insert", size: 2, w: 1, long: true },
    { name: "vpextrw", pp: 1, op: 0xC5, kind: "to_gpr", register: true, w: 0, wig32: true, imm: true },
    { name: "vpextrw", pp: 1, op: 0xC5, kind: "to_gpr", register: true, w: 1, long: true, imm: true },
    ...Object.entries(SSSE3).map(([op, name]) => ({ name, map: 2, pp: 1, op: +op, kind: "binary", f: (a, b) => big(ssse3(+op, le(a), le(b))) })),
    ...[[0x1C, "vpabsb"], [0x1D, "vpabsw"], [0x1E, "vpabsd"]].map(([op, name]) =>
        ({ name, map: 2, pp: 1, op, kind: "load", f: v => big(ssse3(op, ZERO, le(v))) })),
    { name: "vpalignr", map: 3, pp: 1, op: 0x0F, kind: "binary_imm", f: (a, b, imm8) => big(ssse3(0x0F, le(a), le(b), imm8)) },
    { name: "vptest", map: 2, pp: 1, op: 0x17, kind: "ptest" },
    ...EXTEND.flatMap((suffix, i) => [[0x20 + i, "vpmovsx" + suffix], [0x30 + i, "vpmovzx" + suffix]]).map(([op, name]) =>
        ({ name, map: 2, pp: 1, op, kind: "load", bytes: [8, 4, 2, 8, 4, 8][op & 7], f: v => big(sse4_38(op, ZERO, le(v), ZERO)) })),
    ...Object.entries(SSE4).map(([op, name]) => ({ name, map: 2, pp: 1, op: +op, kind: "binary", f: (a, b) => big(sse4_38(+op, le(a), le(b), ZERO)) })),
    { name: "vphminposuw", map: 2, pp: 1, op: 0x41, kind: "load", f: v => big(sse4_38(0x41, ZERO, le(v), ZERO)) },
    ...[[0x0C, "vblendps"], [0x0D, "vblendpd"], [0x0E, "vpblendw"], [0x42, "vmpsadbw"]].map(([op, name]) =>
        ({ name, map: 3, pp: 1, op, kind: "binary_imm", f: (a, b, imm8) => big(sse4_3a(op, le(a), le(b), imm8)) })),
    // (W1: a 64-bit general-purpose register, and VPEXTRQ/VPINSRQ, in 64-bit mode)
    ...[[0x14, 1, "vpextrb"], [0x15, 2, "vpextrw"], [0x16, 4, "vpextrd"], [0x17, 4, "vextractps"]].flatMap(([op, size, name]) => [
        { name, map: 3, pp: 1, op, kind: "extract", size, w: 0, wig32: true },
        { name: op === 0x16 ? "vpextrq" : name, map: 3, pp: 1, op, kind: "extract", size: op === 0x16 ? 8 : size, w: 1, long: true },
    ]),
    ...[[0x20, 1, "vpinsrb"], [0x22, 4, "vpinsrd"]].flatMap(([op, size, name]) => [
        { name, map: 3, pp: 1, op, kind: "insert", size, w: 0, wig32: true },
        { name: op === 0x22 ? "vpinsrq" : name, map: 3, pp: 1, op, kind: "insert", size: op === 0x22 ? 8 : size, w: 1, long: true },
    ]),
    { name: "vinsertps", map: 3, pp: 1, op: 0x21, kind: "insertps" },
    { name: "vpblendvb", map: 3, pp: 1, op: 0x4C, kind: "blendv", w: 0 },
    ...[[0x60, "vpcmpestrm"], [0x61, "vpcmpestri"]].flatMap(([op, name]) => [
        { name, map: 3, pp: 1, op, kind: "pcmpstr", w: 0, wig32: true },
        { name: name + "64", map: 3, pp: 1, op, kind: "pcmpstr", w: 1, long: true },
    ]),
    { name: "vpcmpistrm", map: 3, pp: 1, op: 0x62, kind: "pcmpstr" }, { name: "vpcmpistri", map: 3, pp: 1, op: 0x63, kind: "pcmpstr" },

    // P5 part 3: the floating-point forms
    ...SSE_FP.filter(form => !["from_mmx", "to_mmx"].includes(form.kind)).flatMap(form => {
        const pp = { "": 0, 102: 1, 243: 2, 242: 3 }[form.prefix.join()];
        const scalar = !!form.scalar || ["comi", "to_gpr", "from_gpr"].includes(form.kind);
        const two = ["from_dwords", "to_dwords"].includes(form.kind) ||
            !form.scalar && (form.op === "sqrt" || ["reciprocal", "widen", "narrow", "round"].includes(form.kind));
        const operands = ["comi", "to_gpr", "from_gpr"].includes(form.kind) ? form.kind : two ? "two" : "three";
        const double = form.double ?? form.kind === "narrow";
        // (the memory operand: a scalar's lane, an integer's dword, CVTPS2PD's and CVTDQ2PD's quadword)
        const bytes = form.kind === "from_gpr" ? 4 : scalar ? (double ? 8 : 4) :
            form.kind === "widen" || form.kind === "from_dwords" && double ? 8 : 16;
        // (the scalar forms are VEX.LIG)
        const vex = { name: "v" + form.name, map: form.map === 0x3A ? 3 : 1, pp, op: form.code, kind: "fp", legacy: form, operands, bytes, lig: scalar };
        // (the general-purpose forms: W0 32-bit integers, W1 64-bit ones in 64-bit mode)
        if(operands === "to_gpr" || operands === "from_gpr")
            return [{ ...vex, w: 0, wig32: true }, { ...vex, w: 1, long: true, bytes: operands === "from_gpr" ? 8 : bytes }];
        return [vex];
    }),
    { name: "vblendvps", map: 3, pp: 1, op: 0x4A, kind: "blendv", legacy: 0x14, w: 0 },
    { name: "vblendvpd", map: 3, pp: 1, op: 0x4B, kind: "blendv", legacy: 0x15, w: 0 },

    // P5 part 4: AVX's own 128-bit forms
    { name: "vbroadcastss", map: 2, pp: 1, op: 0x18, kind: "load", memory: true, bytes: 4, w: 0, f: v => join([v, v, v, v], 32) },
    { name: "vpermilps", map: 2, pp: 1, op: 0x0C, kind: "binary", w: 0,
        f: (a, b) => join(lanes(b, 32).map(x => lanes(a, 32)[Number(x & 3n)]), 32) },
    { name: "vpermilpd", map: 2, pp: 1, op: 0x0D, kind: "binary", w: 0,
        f: (a, b) => join(lanes(b, 64).map(x => lanes(a, 64)[Number(x >> 1n & 1n)]), 64) },
    { name: "vpermilps", map: 3, pp: 1, op: 0x04, kind: "load_imm", w: 0,
        f: (v, imm8) => join([0, 1, 2, 3].map(n => lanes(v, 32)[imm8 >> 2 * n & 3]), 32) },
    { name: "vpermilpd", map: 3, pp: 1, op: 0x05, kind: "load_imm", w: 0,
        f: (v, imm8) => join([0, 1].map(n => lanes(v, 64)[imm8 >> n & 1]), 64) },
    { name: "vtestps", map: 2, pp: 1, op: 0x0E, kind: "vtest", lane: 4, w: 0 },
    { name: "vtestpd", map: 2, pp: 1, op: 0x0F, kind: "vtest", lane: 8, w: 0 },
    { name: "vmaskmovps", map: 2, pp: 1, op: 0x2C, kind: "maskload", lane: 4, memory: true, w: 0 },
    { name: "vmaskmovpd", map: 2, pp: 1, op: 0x2D, kind: "maskload", lane: 8, memory: true, w: 0 },
    { name: "vmaskmovps", map: 2, pp: 1, op: 0x2E, kind: "maskstore", lane: 4, memory: true, w: 0 },
    { name: "vmaskmovpd", map: 2, pp: 1, op: 0x2F, kind: "maskstore", lane: 8, memory: true, w: 0 },

    // P7 part 2: AVX2's own VEX.128 forms (`isa`)
    ...BROADCASTS.map(([op, size, name]) => ({ name, map: 2, pp: 1, op, kind: "load", bytes: size, w: 0, isa: "AVX2", f: v => splat(v, size, 128) })),
    { name: "vbroadcastss", map: 2, pp: 1, op: 0x18, kind: "load", register: true, w: 0, isa: "AVX2", f: v => splat(v, 4, 128) },
    { name: "vpblendd", map: 3, pp: 1, op: 0x02, kind: "binary_imm", w: 0, isa: "AVX2",
        f: (a, b, imm8) => join(lanes(a, 32).map((x, n) => imm8 >> n & 1 ? lanes(b, 32)[n] : x), 32) },
    ...[[0x45, 0, "vpsrlvd"], [0x45, 1, "vpsrlvq"], [0x46, 0, "vpsravd"], [0x47, 0, "vpsllvd"], [0x47, 1, "vpsllvq"]].map(([op, w, name]) =>
        ({ name, map: 2, pp: 1, op, kind: "binary", w, isa: "AVX2", f: (a, b) => variable_shift(op, w ? 64 : 32, a, b) })),
    ...[[0x8C, "maskload"], [0x8E, "maskstore"]].flatMap(([op, kind]) => [0, 1].map(w =>
        ({ name: w ? "vpmaskmovq" : "vpmaskmovd", map: 2, pp: 1, op, kind, lane: w ? 8 : 4, memory: true, w, isa: "AVX2" }))),
    // P8: the gathers (`data`, `index`: the element and index sizes)
    ...GATHERS.map(([op, w, name, data, index]) => ({ name, map: 2, pp: 1, op, w, kind: "gather", data, index, memory: true, isa: "AVX2" })),
];

// P6 part 1: the VEX.256 forms (`l`: 1) of data movement, logic, shuffles,
// the cross-lane forms, tests and masks. The lane-wise ones are their VEX.128
// forms on each half (`halves`), with 32-byte memory operands (the aligned
// ones aligned to 32 bytes). Kinds of their own:
//   insert128   d = v with its half imm8[0] from m (xmm or m128)
//   extract128  m (an XMM register, bits 255:128 zeroed, or m128) = d's half imm8[0]
//   zero_all    VZEROALL
const by_name = (name, op) => FORMS_128.find(f => f.name === name && (op === undefined || f.op === op));
// (AVX2's packed integer forms that work on each half: their VEX.128 forms,
// AVX's; the shifts by xmm/m128)
const COUNT_SHIFTS = [0xD1, 0xD2, 0xD3, 0xE1, 0xE2, 0xF1, 0xF2, 0xF3];
const avx2_halves = f => !f.long && f.pp === 1 && ((f.map ?? 1) === 1 && (f.kind === "binary" && !f.map &&
    (f.op in PACKED || [0xDB, 0xDF, 0xEB, 0xEF].includes(f.op)) || f.kind === "shift_imm" || f.kind === "to_gpr" && f.op === 0xD7) ||
    f.map === 2 && (f.kind === "binary" && (f.op <= 0x0B || [0x28, 0x29, 0x2B].includes(f.op) || f.op >= 0x37 && f.op <= 0x40) ||
        f.kind === "load" && f.op >= 0x1C && f.op <= 0x1E || f.name === "vmovntdqa") ||
    f.map === 3 && [0x0E, 0x0F, 0x42, 0x4C].includes(f.op)) || f.op === 0x70 && !f.map;
const wide = (f, extra = {}) => ({ ...f, l: 1, bytes: 32, ...extra });
// VPERM2F128 (AVX), VPERM2I128 (AVX2): each half one of the sources' halves
// (imm8[1:0], imm8[5:4]) or zero (imm8[3], imm8[7])
const vperm2 = (op, name, extra = {}) => ({ name, map: 3, pp: 1, op, kind: "binary_imm", bytes: 32, w: 0, l: 1, ...extra,
    f: (a, b, imm8) => join([imm8, imm8 >> 4].map(c => c & 8 ? 0n : [low128(a), high128(a), low128(b), high128(b)][c & 3]), 128) });
const FORMS_256 = [
    // full-width loads and stores
    ...FORMS_128.filter(f => ["load", "store"].includes(f.kind) && !f.map && f.bytes === undefined && !f.f &&
        [0x10, 0x11, 0x28, 0x29, 0x2B, 0x6F, 0x7F, 0xE7, 0xF0].includes(f.op)).map(f => wide(f)),
    // duplicates, in each half (VMOVDDUP from 32 bytes too)
    ...["vmovsldup", "vmovshdup", "vmovddup"].map(name => wide(by_name(name), { f: halves(by_name(name).f) })),
    // unpacks and logic of PS and PD, in each half
    ...FORMS_128.filter(f => f.kind === "binary" && !f.map && f.pp <= 1 && [0x14, 0x15, 0x54, 0x55, 0x56, 0x57].includes(f.op))
        .map(f => wide(f, { f: halves(f.f) })),
    // VSHUFPS (imm8 for each half), VSHUFPD (imm8[3:2] for the high one)
    ...FORMS_128.filter(f => f.op === 0xC6).map(f => wide(f, { f: halves(f.f, f.pp ? imm8 => imm8 >> 2 : undefined) })),
    // VBLENDPS (imm8[7:4] for the high half), VBLENDPD (imm8[3:2])
    ...FORMS_128.filter(f => f.map === 3 && (f.op === 0x0C || f.op === 0x0D))
        .map(f => wide(f, { f: halves(f.f, imm8 => imm8 >> (f.op === 0x0C ? 4 : 2)) })),
    // VBLENDVPS, VBLENDVPD: the mask register's halves
    ...FORMS_128.filter(f => f.kind === "blendv" && f.legacy).map(f => wide(f)),
    // VPERMILPS, VPERMILPD by a vector (in each half) and by imm8 (VPERMILPD: imm8[3:2] for the high half)
    ...FORMS_128.filter(f => f.name === "vpermilps" || f.name === "vpermilpd")
        .map(f => wide(f, { f: halves(f.f, f.op === 0x05 ? imm8 => imm8 >> 2 : undefined) })),
    // VBROADCASTSS ymm, m32; VBROADCASTSD ymm, m64; VBROADCASTF128 ymm, m128
    { name: "vbroadcastss", map: 2, pp: 1, op: 0x18, kind: "load", memory: true, bytes: 4, w: 0, l: 1, f: v => join(Array(8).fill(v), 32) },
    { name: "vbroadcastsd", map: 2, pp: 1, op: 0x19, kind: "load", memory: true, bytes: 8, w: 0, l: 1, f: v => join(Array(4).fill(v), 64) },
    { name: "vbroadcastf128", map: 2, pp: 1, op: 0x1A, kind: "load", memory: true, bytes: 16, w: 0, l: 1, f: v => join([v, v], 128) },
    { name: "vinsertf128", map: 3, pp: 1, op: 0x18, kind: "insert128", bytes: 16, w: 0, l: 1 },
    { name: "vextractf128", map: 3, pp: 1, op: 0x19, kind: "extract128", bytes: 16, w: 0, l: 1 },
    // VPERM2F128: each half one of the sources' halves (imm8[1:0], imm8[5:4]) or zero (imm8[3], imm8[7])
    vperm2(0x06, "vperm2f128"),
    { name: "vzeroall", pp: 0, op: 0x77, kind: "zero_all", l: 1 },
    // the tests and sign masks over all 256 bits
    wide(by_name("vptest")), wide(by_name("vtestps")), wide(by_name("vtestpd")),
    { ...by_name("vmovmskps"), l: 1, f: signs(32, 256) }, { ...by_name("vmovmskpd"), l: 1, f: signs(64, 256) },
    // VMASKMOVPS, VMASKMOVPD: 8 and 4 lanes
    ...FORMS_128.filter(f => f.kind === "maskload" || f.kind === "maskstore").map(f => ({ ...f, l: 1 })),
    // P6 part 2: the packed floating-point forms but VDPPD, over all lanes
    // with one exception context (sse_fp_cases.mjs's expect at width 256);
    // VCVTPS2PD and VCVTDQ2PD from xmm/m128
    ...FORMS_128.filter(f => f.kind === "fp" && !f.lig && f.name !== "vdppd").map(f => ({ ...f, l: 1,
        bytes: f.legacy.kind === "widen" || f.legacy.kind === "from_dwords" && f.legacy.double ? 16 : 32 })),
    // P7 part 1 (AVX2, `isa`): the packed integer forms on each half. The
    // shifts by xmm/m128 take one count (the low quadword of the 128-bit
    // operand) for both halves; VMPSADBW takes imm8[5:3] for the high half;
    // VPMOVMSKB the sign bits of all 32 bytes; VMOVNTDQA is 32-byte aligned
    ...FORMS_128.filter(avx2_halves).map(f => {
        const isa = { isa: "AVX2" };
        if((f.map ?? 1) === 1 && COUNT_SHIFTS.includes(f.op))
            return wide(f, { ...isa, bytes: 16, f: (a, b) => join([f.f(low128(a), low128(b)), f.f(high128(a), low128(b))], 128) });
        if(f.kind === "to_gpr") return { ...f, ...isa, l: 1, f: signs(8, 256) };
        if(f.kind === "blendv" || f.name === "vmovntdqa") return wide(f, isa);
        return wide(f, { ...isa, f: halves(f.f, f.name === "vmpsadbw" ? imm8 => imm8 >> 3 : undefined) });
    }),
    // P7 part 2 (AVX2): broadcasts (an element from xmm/m, VBROADCASTI128
    // from m128), the extensions from xmm/m128 (m64, m32) over 256 bits,
    // VPERMD/PS (indices in VEX.vvvv), VPERMQ/PD (imm8), VPERM2I128,
    // VINSERTI128, VEXTRACTI128, VPBLENDD (imm8[7:4] for the high half),
    // the variable shifts and VPMASKMOVD/Q
    ...BROADCASTS.map(([op, size, name]) => ({ name, map: 2, pp: 1, op, kind: "load", bytes: size, w: 0, l: 1, isa: "AVX2", f: v => splat(v, size, 256) })),
    { name: "vbroadcastss", map: 2, pp: 1, op: 0x18, kind: "load", register: true, w: 0, l: 1, isa: "AVX2", f: v => splat(v, 4, 256) },
    { name: "vbroadcastsd", map: 2, pp: 1, op: 0x19, kind: "load", register: true, w: 0, l: 1, isa: "AVX2", f: v => splat(v, 8, 256) },
    { name: "vbroadcasti128", map: 2, pp: 1, op: 0x5A, kind: "load", memory: true, bytes: 16, w: 0, l: 1, isa: "AVX2", f: v => join([v, v], 128) },
    ...EXTEND.flatMap((suffix, i) => [[0x20 + i, "vpmovsx" + suffix], [0x30 + i, "vpmovzx" + suffix]]).map(([op, name]) => {
        const half = [8, 4, 2, 8, 4, 8][op & 7], f128 = by_name(name).f;
        return { name, map: 2, pp: 1, op, kind: "load", bytes: 2 * half, w: 0, l: 1, isa: "AVX2",
            f: v => join([f128(v & mask(8 * half)), f128(v >> BigInt(8 * half) & mask(8 * half))], 128) };
    }),
    ...[[0x36, "vpermd"], [0x16, "vpermps"]].map(([op, name]) => ({ name, map: 2, pp: 1, op, kind: "binary", w: 0, l: 1, bytes: 32, isa: "AVX2",
        f: (a, b) => join(lanes(a, 32, 256).map(i => lanes(b, 32, 256)[Number(i & 7n)]), 32) })),
    ...[[0x00, "vpermq"], [0x01, "vpermpd"]].map(([op, name]) => ({ name, map: 3, pp: 1, op, kind: "load_imm", w: 1, l: 1, bytes: 32, isa: "AVX2",
        f: (v, imm8) => join([0, 1, 2, 3].map(n => lanes(v, 64, 256)[imm8 >> 2 * n & 3]), 64) })),
    vperm2(0x46, "vperm2i128", { isa: "AVX2" }),
    { name: "vinserti128", map: 3, pp: 1, op: 0x38, kind: "insert128", bytes: 16, w: 0, l: 1, isa: "AVX2" },
    { name: "vextracti128", map: 3, pp: 1, op: 0x39, kind: "extract128", bytes: 16, w: 0, l: 1, isa: "AVX2" },
    wide(by_name("vpblendd"), { isa: "AVX2", f: halves(by_name("vpblendd").f, imm8 => imm8 >> 4) }),
    ...FORMS_128.filter(f => f.isa === "AVX2" && f.map === 2 && f.op >= 0x45 && f.op <= 0x47)
        .map(f => wide(f, { f: (a, b) => variable_shift(f.op, f.w ? 64 : 32, a, b, 256) })),
    ...FORMS_128.filter(f => f.isa === "AVX2" && (f.kind === "maskload" || f.kind === "maskstore")).map(f => ({ ...f, l: 1 })),
    // P8: the gathers' VEX.256 forms
    ...FORMS_128.filter(f => f.kind === "gather").map(f => ({ ...f, l: 1 })),
];
export const FORMS = [...FORMS_128, ...FORMS_256];

/** The memory operand's size of form `f` */
export const memory_bytes = f => f.bytes ?? f.size ?? (["store64", "low", "high"].includes(f.kind) ? 8 :
    f.kind === "gpr_load" || f.kind === "gpr_store" ? (f.w ? 8 : 4) : f.kind === "insertps" ? 4 :
    ["maskload", "maskstore"].includes(f.kind) && f.l ? 32 : 16);

/**
 * Executes form `f` on `s`: x[r] and h[r], XMM r and bits 255:128 of YMM r
 * (BigInts), mxcsr, flags (OF, SF, ZF, AF, PF, CF, for the forms that set
 * them); s.load(bytes) and s.store(bytes, value) access the memory operand
 * (s.load_at and s.store_at an element at an offset in it),
 * s.masked(value, selected) VMASKMOVDQU's, s.gpr(r) and s.set_gpr(r, value,
 * bits) the general-purpose registers. `o`: d, v (VEX.vvvv), m (the r/m
 * register; undefined for memory), imm8, `long` (64-bit mode).
 */
export function execute(f, s, { d, v, m, imm8, long, index, scale })
{
    const memory = m === undefined;
    // (a VEX.256 form's registers: both halves; its lane-wise memory operand 32 bytes)
    const ymm = f.l === 1, width = ymm ? 256 : 128, full = ymm ? 32 : 16;
    const reg = r => ymm ? s.x[r] | s.h[r] << 128n : s.x[r];
    const source = bytes => memory ? s.load(bytes) : reg(m);
    const write = (r, value) => { s.x[r] = value & mask(128); s.h[r] = ymm ? value >> 128n & mask(128) : 0n; };
    switch(f.kind)
    {
        case "load": write(d, (f.f || (x => x))(source(memory_bytes(f)))); break;
        case "store":
        {
            const value = (f.f || (x => x))(reg(d));
            if(memory) s.store(memory_bytes(f), value);
            else write(m, value);
            break;
        }
        case "binary": write(d, f.f(reg(v), source(f.bytes ?? full))); break;
        case "scalar":
        {
            const low = mask(f.bytes * 8);
            write(d, memory ? s.load(f.bytes) : s.x[v] & ~low | s.x[m] & low);
            break;
        }
        case "scalar_st":
        {
            const low = mask(f.bytes * 8);
            if(memory) s.store(f.bytes, s.x[d]);
            else write(m, s.x[v] & ~low | s.x[d] & low);
            break;
        }
        case "low": write(d, s.x[v] & ~LOW | (memory ? s.load(8) : s.x[m] >> 64n)); break;
        case "high": write(d, s.x[v] & LOW | (memory ? s.load(8) : s.x[m] & LOW) << 64n); break;
        case "store64": s.store(8, f.op === 0x13 ? s.x[d] & LOW : s.x[d] >> 64n); break;
        // (the general-purpose register: ModRM.reg, d here; VPEXTRW: word imm8[2:0])
        case "to_gpr": s.set_gpr(d, f.imm ? extract(le(s.x[m]), 2, imm8) : f.f(reg(m)), long && f.w === 1 ? 64 : 32); break;
        case "gpr_load":
        {
            const bits = long && f.w === 1 ? 64 : 32;
            write(d, memory ? s.load(bits / 8) : s.gpr(m) & mask(bits));
            break;
        }
        case "gpr_store":
        {
            const bits = long && f.w === 1 ? 64 : 32;
            if(memory) s.store(bits / 8, s.x[d] & mask(bits));
            else s.set_gpr(m, s.x[d] & mask(bits), bits);
            break;
        }
        case "zero_upper": s.h.fill(0n, 0, long ? 16 : 8); break;
        case "zero_all": s.x.fill(0n, 0, long ? 16 : 8); s.h.fill(0n, 0, long ? 16 : 8); break;
        case "insert128":
        {
            const value = memory ? s.load(16) : s.x[m], a = reg(v);
            write(d, imm8 & 1 ? low128(a) | value << 128n : value | high128(a) << 128n);
            break;
        }
        case "extract128":
        {
            const value = imm8 & 1 ? high128(reg(d)) : low128(reg(d));
            // (an XMM register: bits 255:128 of its YMM register zeroed)
            if(memory) s.store(16, value);
            else { s.x[m] = value; s.h[m] = 0n; }
            break;
        }
        case "ldmxcsr": s.mxcsr = Number(s.load(4)); break;
        case "stmxcsr": s.store(4, BigInt(s.mxcsr)); break;
        case "maskmov":
        {
            const selected = le(s.x[m]).map(b => b >> 7);
            s.masked(s.x[d], selected);
            break;
        }
        case "load_imm": write(d, f.f(source(full), imm8)); break;
        case "binary_imm": write(d, f.f(reg(v), source(full), imm8)); break;
        case "shift_imm": write(v, f.f(reg(m), imm8)); break;
        case "ptest":
        {
            // (VEX.256: over all 256 bits)
            const a = reg(d), b = source(full);
            const { zf, cf } = ymm ? { zf: (a & b) === 0n, cf: (~a & b & mask(256)) === 0n } : ptest(le(a), le(b));
            s.flags = (zf ? 0x40 : 0) | (cf ? 1 : 0);
            break;
        }
        case "extract":
        {
            const value = extract(le(s.x[d]), f.size, imm8);
            if(memory) s.store(f.size, value);
            else s.set_gpr(m, value, long && f.w === 1 ? 64 : 32);
            break;
        }
        case "insert":
        {
            const value = memory ? s.load(f.size) : s.gpr(m) & mask(8 * f.size);
            write(d, big(insert(le(s.x[v]), f.size, value, imm8)));
            break;
        }
        case "insertps":
        {
            const value = memory ? s.load(4) : s.x[m] >> BigInt(32 * (imm8 >> 6)) & mask(32);
            write(d, big(insertps(le(s.x[v]), value, imm8)));
            break;
        }
        case "blendv":
        {
            const blend = (a, b, selector) => big(sse4_38(f.legacy ?? 0x10, le(a), le(b), le(selector)));
            const selector = reg(imm8 >> 4 & (long ? 15 : 7));
            write(d, ymm ? halves(blend)(reg(v), source(full), selector) : blend(s.x[v], source(16), selector));
            break;
        }
        case "vtest":
        {
            const bits = f.lane * 8;
            const signs = join(lanes(mask(width), bits, width).map(() => 1n << BigInt(bits - 1)), bits);
            const a = reg(d), b = source(full);
            s.flags = ((a & b & signs) === 0n ? 0x40 : 0) | ((~a & b & signs) === 0n ? 1 : 0);
            break;
        }
        // a gather (`index`, the indices' register, and `scale`): the
        // selected elements from the memory operand's address plus each
        // element's sign-extended, scaled index (32-bit addressing outside
        // 64-bit mode wraps), the mask cleared
        case "gather":
        {
            const count = (ymm ? 32 : 16) / Math.max(f.data, f.index), bits = 8 * f.data;
            const selected = lanes(reg(v), bits, 256).slice(0, count).map(x => x >> BigInt(bits - 1) & 1n);
            const values = lanes(reg(d), bits, 256).slice(0, count);
            const indices = lanes(reg(index), 8 * f.index, 256);
            for(let n = 0; n < count; n++)
            {
                if(!selected[n]) continue;
                const offset = BigInt.asIntN(long ? 64 : 32, BigInt.asIntN(8 * f.index, indices[n]) << BigInt(scale));
                values[n] = s.load_at(Number(offset), f.data);
            }
            write(d, join(values, bits));
            write(v, 0n);
            break;
        }
        case "maskload": case "maskstore":
        {
            // (each selected lane on its own: s.load_at, s.store_at)
            const bits = f.lane * 8;
            const selected = lanes(reg(v), bits, width).map(x => x >> BigInt(bits - 1));
            if(f.kind === "maskload") write(d, join(selected.map((on, n) => on ? s.load_at(n * f.lane, f.lane) : 0n), bits));
            else selected.forEach((on, n) => { if(on) s.store_at(n * f.lane, f.lane, lanes(reg(d), bits, width)[n]); });
            break;
        }
        case "fp":
        {
            const form = f.legacy, double = form.double ?? false;
            if(f.operands === "to_gpr" || f.operands === "from_gpr")
            {
                // (32-bit integers, 64-bit with VEX.W1 in 64-bit mode)
                const bits = long && f.w === 1 ? 64 : 32;
                const fp = new Fp(s.mxcsr);
                if(f.operands === "to_gpr")
                {
                    const x = memory ? s.load(f.bytes) : s.x[m] & mask(double ? 64 : 32);
                    s.set_gpr(d, BigInt.asUintN(bits, fp.to_integer(x, double, bits, form.truncate)), bits);
                }
                else
                {
                    const n = BigInt.asIntN(bits, memory ? s.load(bits / 8) : s.gpr(m));
                    const lane = mask(double ? 64 : 32);
                    write(d, s.x[v] & ~lane | fp.from_integer(n, double));
                }
                s.mxcsr = fp.finish().mxcsr;
                break;
            }
            const a = f.operands === "two" ? 0n : f.operands === "comi" ? s.x[d] : reg(v);
            // (VCMP*: the 32 predicates of imm8[4:0]; VEX.256: all lanes)
            const r = expect(form, s.mxcsr, a, source(f.bytes), form.kind === "compare" ? imm8 & 31 : imm8, width);
            assert(!r.fault, `${f.name}: an unmasked exception`);
            s.mxcsr = r.after;
            if(f.operands === "comi") s.flags = Number(r.result);
            else write(d, r.result);
            break;
        }
        case "pcmpstr":
        {
            // (the explicit lengths: EAX and EDX, or RAX and RDX with VEX.W1, signed)
            const bits = long && f.w === 1 ? 64 : 32;
            const length = r => BigInt.asIntN(bits, s.gpr(r));
            const explicit = f.op < 0x62;
            const r = compare_strings(imm8, le(s.x[d]), le(source(16)), explicit ? length(0) : undefined, explicit ? length(2) : undefined);
            if(f.op & 1) s.set_gpr(1, BigInt(r.index), 32);
            else write(0, big(r.mask));
            s.flags = (r.cf ? 1 : 0) | (r.zf ? 0x40 : 0) | (r.sf ? 0x80 : 0) | (r.of ? 0x800 : 0);
            break;
        }
        default: throw new Error(`kind ${f.kind}`);
    }
}
