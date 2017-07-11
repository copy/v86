#!/usr/bin/env node
"use strict";

// http://ref.x86asm.net/coder32.html

// TODO
// - lea (and all modrm/sib addressing modes)
// - fix style (single quote, brace position)
// - memory tests
// - multiple random tests
// - 16 bit
// - describe which registers are written and read

const fs = require("fs");

const zf = 1 << 6;
const of = 1 << 11;
const cf = 1 << 0;
const af = 1 << 4;


// os: the instruction behaves differently depending on the operand size

const encodings = [
    { opcode: 0x06, os: 1, skip: 1, },
    { opcode: 0x07, os: 1, skip: 1, },
    { opcode: 0x0E, os: 1, skip: 1, },
    { opcode: 0x0F, os: 1, prefix: 1, },
    { opcode: 0x16, os: 1, skip: 1, },
    { opcode: 0x17, os: 1, skip: 1, },
    { opcode: 0x1E, os: 1, skip: 1, },
    { opcode: 0x1F, os: 1, skip: 1, },
    { opcode: 0x26, prefix: 1, },
    { opcode: 0x27, mask_flags: of, },
    { opcode: 0x2E, prefix: 1, },
    { opcode: 0x2F, mask_flags: of, },
    { opcode: 0x36, prefix: 1, },
    { opcode: 0x37, skip: 1, },
    { opcode: 0x3E, prefix: 1, },
    { opcode: 0x3F, skip: 1, },

    { opcode: 0x40, os: 1, },
    { opcode: 0x41, os: 1, },
    { opcode: 0x42, os: 1, },
    { opcode: 0x43, os: 1, },
    { opcode: 0x44, os: 1, skip: 1, }, // inc esp
    { opcode: 0x45, os: 1, },
    { opcode: 0x46, os: 1, },
    { opcode: 0x47, os: 1, },

    { opcode: 0x48, os: 1, },
    { opcode: 0x49, os: 1, },
    { opcode: 0x4A, os: 1, },
    { opcode: 0x4B, os: 1, },
    { opcode: 0x4C, os: 1, skip: 1, }, // dec esp
    { opcode: 0x4D, os: 1, },
    { opcode: 0x4E, os: 1, },
    { opcode: 0x4F, os: 1, },

    { opcode: 0x50, os: 1, },
    { opcode: 0x51, os: 1, },
    { opcode: 0x52, os: 1, },
    { opcode: 0x53, os: 1, },
    { opcode: 0x54, os: 1, skip: 1, }, // push esp
    { opcode: 0x55, os: 1, },
    { opcode: 0x56, os: 1, },
    { opcode: 0x57, os: 1, },

    { opcode: 0x58, os: 1, },
    { opcode: 0x59, os: 1, },
    { opcode: 0x5A, os: 1, },
    { opcode: 0x5B, os: 1, },
    { opcode: 0x5C, os: 1, skip: 1, }, // pop esp
    { opcode: 0x5D, os: 1, },
    { opcode: 0x5E, os: 1, },
    { opcode: 0x5F, os: 1, },

    { opcode: 0x60, os: 1, skip: 1, },
    { opcode: 0x61, os: 1, },
    { opcode: 0x62, e: 1, g: 1, skip: 1, },
    { opcode: 0x63, e: 1, g: 1, },
    { opcode: 0x64, prefix: 1, },
    { opcode: 0x65, prefix: 1, },
    { opcode: 0x66, prefix: 1, },
    { opcode: 0x67, prefix: 1, },

    { opcode: 0x68, os: 1, imm1632: 1, },
    { opcode: 0x69, os: 1, e: 1, g: 1, imm: 1, mask_flags: 0, }, // zf?
    { opcode: 0x6A, os: 1, imm8: 1, },
    { opcode: 0x6B, os: 1, e: 1, g: 1, imm8: 1, mask_flags: 0, }, // zf?

    { opcode: 0x6C, skip: 1, },
    { opcode: 0x6D, os: 1, skip: 1, },
    { opcode: 0x6E, skip: 1, },
    { opcode: 0x6F, os: 1, skip: 1, },

    { opcode: 0x84, e: 1, g: 1, },
    { opcode: 0x85, os: 1, e: 1, g: 1, },
    { opcode: 0x86, e: 1, g: 1, },
    { opcode: 0x87, os: 1, e: 1, g: 1, },
    { opcode: 0x88, e: 1, g: 1, },
    { opcode: 0x89, os: 1, e: 1, g: 1, },
    { opcode: 0x8A, e: 1, g: 1, },
    { opcode: 0x8B, os: 1, e: 1, g: 1, },

    { opcode: 0x8C, os: 1, e: 1, g: 1, skip: 1, },
    { opcode: 0x8D, os: 1, e: 1, g: 1, skip: 1, }, // lea
    { opcode: 0x8E, e: 1, g: 1, skip: 1, },
    { opcode: 0x8F, os: 1, e: 1, g: 1, },

    { opcode: 0x90, },
    { opcode: 0x91, os: 1, },
    { opcode: 0x92, os: 1, },
    { opcode: 0x93, os: 1, },
    { opcode: 0x94, os: 1, skip: 1, }, // xchg eax, esp
    { opcode: 0x95, os: 1, },
    { opcode: 0x96, os: 1, },
    { opcode: 0x97, os: 1, },

    { opcode: 0x98, os: 1, },
    { opcode: 0x99, os: 1, },
    { opcode: 0x9A, os: 1, imm3248: 1, skip: 1, },
    { opcode: 0x9B, skip: 1, },
    { opcode: 0x9C, os: 1, skip: 1, },
    { opcode: 0x9D, os: 1, skip: 1, },
    { opcode: 0x9E, },
    { opcode: 0x9F, },

    { opcode: 0xA0, immaddr: 1, skip: 1, },
    { opcode: 0xA1, os: 1, immaddr: 1, skip: 1, },
    { opcode: 0xA2, immaddr: 1, skip: 1, },
    { opcode: 0xA3, os: 1, immaddr: 1, skip: 1, },

    { opcode: 0xA4, skip: 1, },
    { opcode: 0xA5, os: 1, skip: 1, },
    { opcode: 0xA6, skip: 1, },
    { opcode: 0xA7, os: 1, skip: 1, },

    { opcode: 0xA8, imm: 1, },
    { opcode: 0xA9, os: 1, imm: 1, },

    { opcode: 0xAA, skip: 1, },
    { opcode: 0xAB, os: 1, skip: 1, },
    { opcode: 0xAC, skip: 1, },
    { opcode: 0xAD, os: 1, skip: 1, },
    { opcode: 0xAE, skip: 1, },
    { opcode: 0xAF, os: 1, skip: 1, },

    { opcode: 0xC2, os: 1, imm16: 1, skip: 1, },
    { opcode: 0xC3, os: 1, skip: 1, },

    { opcode: 0xC4, os: 1, e: 1, g: 1, skip: 1, },
    { opcode: 0xC5, os: 1, e: 1, g: 1, skip: 1, },

    { opcode: 0xC6, e: 1, g: 1, imm: 1, },
    { opcode: 0xC7, os: 1, e: 1, g: 1, imm: 1, },

    { opcode: 0xC8, os: 1, imm24: 1, skip: 1, }, // enter
    { opcode: 0xC9, os: 1, skip: 1, },
    { opcode: 0xCA, os: 1, imm16: 1, skip: 1, },
    { opcode: 0xCB, os: 1, skip: 1, },
    { opcode: 0xCC, skip: 1, },
    { opcode: 0xCD, skip: 1, },
    { opcode: 0xCE, skip: 1, },
    { opcode: 0xCF, os: 1, skip: 1, },

    { opcode: 0xD4, imm8: 1, },
    { opcode: 0xD5, imm8: 1, mask_flags: of | cf | af, },
    { opcode: 0xD6, },
    { opcode: 0xD7, skip: 1, },

    { opcode: 0xD8, e: 1, skip: 1, },
    { opcode: 0xD9, e: 1, skip: 1, },
    { opcode: 0xDA, e: 1, skip: 1, },
    { opcode: 0xDB, e: 1, skip: 1, },
    { opcode: 0xDC, e: 1, skip: 1, },
    { opcode: 0xDD, e: 1, skip: 1, },
    { opcode: 0xDE, e: 1, skip: 1, },
    { opcode: 0xDF, e: 1, skip: 1, },

    { opcode: 0xE0, imm8: 1, skip: 1, },
    { opcode: 0xE1, imm8: 1, skip: 1, },
    { opcode: 0xE2, imm8: 1, skip: 1, },
    { opcode: 0xE3, imm8: 1, skip: 1, },

    { opcode: 0xE4, imm8: 1, skip: 1, },
    { opcode: 0xE5, os: 1, imm8: 1, skip: 1, },
    { opcode: 0xE6, imm8: 1, skip: 1, },
    { opcode: 0xE7, os: 1, imm8: 1, skip: 1, },

    { opcode: 0xE8, os: 1, imm: 1, skip: 1, },
    { opcode: 0xE9, os: 1, imm: 1, skip: 1, },
    { opcode: 0xEA, os: 1, imm: 1, skip: 1, },
    { opcode: 0xEB, imm: 1, skip: 1, },

    { opcode: 0xEC, skip: 1, },
    { opcode: 0xED, os: 1, skip: 1, },
    { opcode: 0xEE, skip: 1, },
    { opcode: 0xEF, os: 1, skip: 1, },

    { opcode: 0xF0, prefix: 1, },
    { opcode: 0xF1, skip: 1, },
    { opcode: 0xF2, prefix: 1, },
    { opcode: 0xF3, prefix: 1, },
    { opcode: 0xF4, skip: 1, },
    { opcode: 0xF5, },

    { opcode: 0xF6, fixed_g: 0, imm: 1, },
    { opcode: 0xF6, fixed_g: 1, imm: 1, },
    { opcode: 0xF6, fixed_g: 2, },
    { opcode: 0xF6, fixed_g: 3, },
    { opcode: 0xF6, fixed_g: 4, mask_flags: zf, },
    { opcode: 0xF6, fixed_g: 5, mask_flags: zf, },
    { opcode: 0xF6, fixed_g: 6, skip: 1, }, // zero divide
    { opcode: 0xF6, fixed_g: 7, skip: 1, },

    { opcode: 0xF7, os: 1, fixed_g: 0, imm: 1, },
    { opcode: 0xF7, os: 1, fixed_g: 1, imm: 1, },
    { opcode: 0xF7, os: 1, fixed_g: 2, },
    { opcode: 0xF7, os: 1, fixed_g: 3, },
    { opcode: 0xF7, os: 1, fixed_g: 4, mask_flags: zf, },
    { opcode: 0xF7, os: 1, fixed_g: 5, mask_flags: zf, },
    { opcode: 0xF7, os: 1, fixed_g: 6, skip: 1, }, // zero divide
    { opcode: 0xF7, os: 1, fixed_g: 7, skip: 1, },

    { opcode: 0xF8, },
    { opcode: 0xF9, },
    { opcode: 0xFA, skip: 1, },
    { opcode: 0xFB, skip: 1, },
    { opcode: 0xFC, },
    { opcode: 0xFD, },

    { opcode: 0xFE, e: 1, fixed_g: 0, },
    { opcode: 0xFE, e: 1, fixed_g: 1, },
    { opcode: 0xFF, os: 1, e: 1, fixed_g: 0, },
    { opcode: 0xFF, os: 1, e: 1, fixed_g: 1, },
    { opcode: 0xFF, os: 1, e: 1, fixed_g: 2, skip: 1, },
    { opcode: 0xFF, os: 1, e: 1, fixed_g: 3, skip: 1, },
    { opcode: 0xFF, os: 1, e: 1, fixed_g: 4, skip: 1, },
    { opcode: 0xFF, os: 1, e: 1, fixed_g: 5, skip: 1, },
    { opcode: 0xFF, os: 1, e: 1, fixed_g: 6, },

    { opcode: 0x0F00, e: 1, g: 1, skip: 1 },
    { opcode: 0x0F01, e: 1, g: 1, skip: 1 },
    { opcode: 0x0F02, os: 1, e: 1, g: 1, skip: 1 },
    { opcode: 0x0F03, os: 1, e: 1, g: 1, skip: 1 },
    { opcode: 0x0F04, skip: 1 },
    { opcode: 0x0F05, skip: 1 },
    { opcode: 0x0F06, skip: 1 },
    { opcode: 0x0F07, skip: 1 },
    { opcode: 0x0F08, skip: 1 },
    { opcode: 0x0F09, skip: 1 },
    { opcode: 0x0F09, skip: 1 },
    { opcode: 0x0F0A, skip: 1 },
    { opcode: 0x0F0B, skip: 1 },
    { opcode: 0x0F0C, skip: 1 },
    { opcode: 0x0F0D, skip: 1 },
    { opcode: 0x0F0E, skip: 1 },
    { opcode: 0x0F0F, skip: 1 },

    { opcode: 0x0F20, e: 1, g: 1, skip: 1 },
    { opcode: 0x0F21, e: 1, g: 1, skip: 1 },
    { opcode: 0x0F22, e: 1, g: 1, skip: 1 },
    { opcode: 0x0F23, e: 1, g: 1, skip: 1 },

    { opcode: 0x0F30, skip: 1 },
    { opcode: 0x0F31, skip: 1 },
    { opcode: 0x0F32, skip: 1 },
    { opcode: 0x0F33, skip: 1 },
    { opcode: 0x0F34, skip: 1 },
    { opcode: 0x0F35, skip: 1 },

    { opcode: 0x0F40, e: 1, g: 1, os: 1, },
    { opcode: 0x0F41, e: 1, g: 1, os: 1, },
    { opcode: 0x0F42, e: 1, g: 1, os: 1, },
    { opcode: 0x0F43, e: 1, g: 1, os: 1, },
    { opcode: 0x0F44, e: 1, g: 1, os: 1, },
    { opcode: 0x0F45, e: 1, g: 1, os: 1, },
    { opcode: 0x0F46, e: 1, g: 1, os: 1, },
    { opcode: 0x0F47, e: 1, g: 1, os: 1, },
    { opcode: 0x0F48, e: 1, g: 1, os: 1, },
    { opcode: 0x0F49, e: 1, g: 1, os: 1, },
    { opcode: 0x0F4A, e: 1, g: 1, os: 1, },
    { opcode: 0x0F4B, e: 1, g: 1, os: 1, },
    { opcode: 0x0F4C, e: 1, g: 1, os: 1, },
    { opcode: 0x0F4D, e: 1, g: 1, os: 1, },
    { opcode: 0x0F4E, e: 1, g: 1, os: 1, },
    { opcode: 0x0F4F, e: 1, g: 1, os: 1, },

    { opcode: 0x0F80, os: 1, skip: 1, },
    { opcode: 0x0F81, os: 1, skip: 1, },
    { opcode: 0x0F82, os: 1, skip: 1, },
    { opcode: 0x0F83, os: 1, skip: 1, },
    { opcode: 0x0F84, os: 1, skip: 1, },
    { opcode: 0x0F85, os: 1, skip: 1, },
    { opcode: 0x0F86, os: 1, skip: 1, },
    { opcode: 0x0F87, os: 1, skip: 1, },
    { opcode: 0x0F88, os: 1, skip: 1, },
    { opcode: 0x0F89, os: 1, skip: 1, },
    { opcode: 0x0F8A, os: 1, skip: 1, },
    { opcode: 0x0F8B, os: 1, skip: 1, },
    { opcode: 0x0F8C, os: 1, skip: 1, },
    { opcode: 0x0F8D, os: 1, skip: 1, },
    { opcode: 0x0F8E, os: 1, skip: 1, },
    { opcode: 0x0F8F, os: 1, skip: 1, },

    { opcode: 0x0F90, e: 1, g: 1, },
    { opcode: 0x0F91, e: 1, g: 1, },
    { opcode: 0x0F92, e: 1, g: 1, },
    { opcode: 0x0F93, e: 1, g: 1, },
    { opcode: 0x0F94, e: 1, g: 1, },
    { opcode: 0x0F95, e: 1, g: 1, },
    { opcode: 0x0F96, e: 1, g: 1, },
    { opcode: 0x0F97, e: 1, g: 1, },
    { opcode: 0x0F98, e: 1, g: 1, },
    { opcode: 0x0F99, e: 1, g: 1, },
    { opcode: 0x0F9A, e: 1, g: 1, },
    { opcode: 0x0F9B, e: 1, g: 1, },
    { opcode: 0x0F9C, e: 1, g: 1, },
    { opcode: 0x0F9D, e: 1, g: 1, },
    { opcode: 0x0F9E, e: 1, g: 1, },
    { opcode: 0x0F9F, e: 1, g: 1, },

    { opcode: 0x0FA0, os: 1, skip: 1, },
    { opcode: 0x0FA1, os: 1, skip: 1, },
    { opcode: 0x0FA2, skip: 1, },

    { opcode: 0x0FA8, os: 1, skip: 1, },
    { opcode: 0x0FA9, os: 1, skip: 1, },

    { opcode: 0x0FA3, os: 1, e: 1, g: 1, only_reg: 1, }, // bt (can also index memory, but not supported by test right now)
    { opcode: 0x0FAB, os: 1, e: 1, g: 1, only_reg: 1, },
    { opcode: 0x0FB3, os: 1, e: 1, g: 1, only_reg: 1, },
    { opcode: 0x0FBB, os: 1, e: 1, g: 1, only_reg: 1, },

    { opcode: 0x0FBA, os: 1, e: 1, fixed_g: 4, imm8: 1, only_reg: 1, }, // bt
    { opcode: 0x0FBA, os: 1, e: 1, fixed_g: 5, imm8: 1, only_reg: 1, },
    { opcode: 0x0FBA, os: 1, e: 1, fixed_g: 6, imm8: 1, only_reg: 1, },
    { opcode: 0x0FBA, os: 1, e: 1, fixed_g: 7, imm8: 1, only_reg: 1, },

    { opcode: 0x0FBC, os: 1, e: 1, g: 1, }, // bsf
    { opcode: 0x0FBD, os: 1, e: 1, g: 1, },

    // note: overflow flag only undefined if shift is > 1
    { opcode: 0x0FA4, os: 1, e: 1, g: 1, imm8: 1, mask_flags: of, }, // shld
    { opcode: 0x0FA5, os: 1, e: 1, g: 1, mask_flags: of, },
    { opcode: 0x0FAC, os: 1, e: 1, g: 1, imm8: 1, mask_flags: of, },
    { opcode: 0x0FAD, os: 1, e: 1, g: 1, mask_flags: of, },

    { opcode: 0x0FAE, e: 1, g: 1, skip: 1, },

    { opcode: 0x0FAF, os: 1, e: 1, g: 1, mask_flags: zf }, // imul

    { opcode: 0x0FB0, e: 1, g: 1 }, // cmxchg
    { opcode: 0x0FB1, os: 1, e: 1, g: 1 },
    { opcode: 0x0FC7, e: 1, fixed_g: 1, only_mem: 1, }, // cmpxchg8b (memory)

    { opcode: 0x0FB2, os: 1, e: 1, g: 1, skip: 1, }, // lss, lfs, lgs
    { opcode: 0x0FB4, os: 1, e: 1, g: 1, skip: 1, },
    { opcode: 0x0FB5, os: 1, e: 1, g: 1, skip: 1, },

    { opcode: 0x0FB6, os: 1, e: 1, g: 1, }, // movzx
    { opcode: 0x0FB7, os: 1, e: 1, g: 1, },

    { opcode: 0xF30FB8, os: 1, e: 1, g: 1 }, // popcnt

    { opcode: 0x0FBE, os: 1, e: 1, g: 1, }, // movzx
    { opcode: 0x0FBF, os: 1, e: 1, g: 1, },

    { opcode: 0x0FC0, e: 1, g: 1, }, // xadd
    { opcode: 0x0FC1, os: 1, e: 1, g: 1, },

    { opcode: 0x0FC8, }, // bswap
    { opcode: 0x0FC9, },
    { opcode: 0x0FCA, },
    { opcode: 0x0FCB, },
    { opcode: 0x0FCC, skip: 1, }, // bswap esp
    { opcode: 0x0FCD, },
    { opcode: 0x0FCE, },
    { opcode: 0x0FCF, },


    // mmx, sse
    // - Commented out are not implemented
    // - Missing are sse3+, and floating point

    { opcode: 0x660F12, only_mem: 1, e: 1, g: 1 },
    { opcode: 0x660F13, only_mem: 1, e: 1, g: 1 },
    { opcode: 0x660F14, e: 1, g: 1 },

    { opcode: 0x0F28, e: 1, g: 1 },
    { opcode: 0x660F28, e: 1, g: 1 },
    { opcode: 0x0F29, only_mem: 1, e: 1, g: 1 }, // XXX: Remove only_mem once supported by v86
    { opcode: 0x660F29, only_mem: 1, e: 1, g: 1 }, // XXX: Remove only_mem once supported by v86
    { opcode: 0x0F2B, only_mem: 1, e: 1, g: 1 },
    { opcode: 0x660F2B, only_mem: 1, e: 1, g: 1 },

    { opcode: 0xF20F2C, e: 1, g: 1 },

    { opcode: 0x0F54, e: 1, g: 1 },
    { opcode: 0x660F54, e: 1, g: 1 },
    { opcode: 0x0F57, e: 1, g: 1 },
    { opcode: 0x660F57, e: 1, g: 1 },

    { opcode: 0x660F60, e: 1, g: 1 },
    { opcode: 0x0F60, e: 1, g: 1 },
    { opcode: 0x660F61, e: 1, g: 1 },
    { opcode: 0x0F61, e: 1, g: 1 },
    //{ opcode: 0x660F62, e: 1, g: 1 },
    { opcode: 0x0F62, e: 1, g: 1 },
    //{ opcode: 0x660F63, e: 1, g: 1 },
    { opcode: 0x0F63, e: 1, g: 1 },
    //{ opcode: 0x660F64, e: 1, g: 1 },
    { opcode: 0x0F64, e: 1, g: 1 },
    //{ opcode: 0x660F65, e: 1, g: 1 },
    { opcode: 0x0F65, e: 1, g: 1 },
    //{ opcode: 0x660F66, e: 1, g: 1 },
    { opcode: 0x0F66, e: 1, g: 1 },
    { opcode: 0x660F67, e: 1, g: 1 },
    { opcode: 0x0F67, e: 1, g: 1 },
    { opcode: 0x660F68, e: 1, g: 1 },
    { opcode: 0x0F68, e: 1, g: 1 },
    //{ opcode: 0x660F69, e: 1, g: 1 },
    { opcode: 0x0F69, e: 1, g: 1 },
    //{ opcode: 0x660F6A, e: 1, g: 1 },
    { opcode: 0x0F6A, e: 1, g: 1 },
    //{ opcode: 0x660F6B, e: 1, g: 1 },
    { opcode: 0x0F6B, e: 1, g: 1 },
    //{ opcode: 0x660F6C, e: 1, g: 1 },
    //{ opcode: 0x660F6D, e: 1, g: 1 },
    //{ opcode: 0xF30F6E, e: 1, g: 1 },
    { opcode: 0x660F6E, e: 1, g: 1 },
    { opcode: 0x0F6E, e: 1, g: 1 },
    { opcode: 0xF30F6F, e: 1, g: 1 },
    { opcode: 0x660F6F, e: 1, g: 1 },
    { opcode: 0x0F6F, e: 1, g: 1 },

    { opcode: 0x660F70, e: 1, g: 1, imm8: 1, },
    { opcode: 0xF20F70, e: 1, g: 1, imm8: 1, },
    { opcode: 0xF30F70, e: 1, g: 1, imm8: 1, },
    { opcode: 0x0F70, e: 1, g: 1, imm8: 1, },

    { opcode: 0x0F71, e: 1, fixed_g: 2, imm8: 1, only_reg: 1, },
    //{ opcode: 0x660F71, e: 1, fixed_g: 2, imm8: 1, only_reg: 1, },
    { opcode: 0x0F71, e: 1, fixed_g: 4, imm8: 1, only_reg: 1, },
    //{ opcode: 0x660F71, e: 1, fixed_g: 4, imm8: 1, only_reg: 1, },
    { opcode: 0x0F71, e: 1, fixed_g: 6, imm8: 1, only_reg: 1, },
    //{ opcode: 0x660F71, e: 1, fixed_g: 6, imm8: 1, only_reg: 1, },

    { opcode: 0x0F72, e: 1, fixed_g: 2, imm8: 1, only_reg: 1, },
    //{ opcode: 0x660F72, e: 1, fixed_g: 2, imm8: 1, only_reg: 1, },
    { opcode: 0x0F72, e: 1, fixed_g: 4, imm8: 1, only_reg: 1, },
    //{ opcode: 0x660F72, e: 1, fixed_g: 4, imm8: 1, only_reg: 1, },
    { opcode: 0x0F72, e: 1, fixed_g: 6, imm8: 1, only_reg: 1, },
    //{ opcode: 0x660F72, e: 1, fixed_g: 6, imm8: 1, only_reg: 1, },

    { opcode: 0x0F73, e: 1, fixed_g: 2, imm8: 1, only_reg: 1, },
    { opcode: 0x660F73, e: 1, fixed_g: 2, imm8: 1, only_reg: 1, },
    //{ opcode: 0x660F73, e: 1, fixed_g: 3, imm8: 1, only_reg: 1, },
    { opcode: 0x0F73, e: 1, fixed_g: 6, imm8: 1, only_reg: 1, },
    //{ opcode: 0x660F73, e: 1, fixed_g: 6, imm8: 1, only_reg: 1, },
    //{ opcode: 0x660F73, e: 1, fixed_g: 7, imm8: 1, only_reg: 1, },

    { opcode: 0x0F74, e: 1, g: 1, },
    { opcode: 0x660F74, e: 1, g: 1, },
    { opcode: 0x0F75, e: 1, g: 1, },
    { opcode: 0x660F75, e: 1, g: 1, },
    { opcode: 0x0F76, e: 1, g: 1, },
    { opcode: 0x660F76, e: 1, g: 1, },
    { opcode: 0x0F77 },

    { opcode: 0x0F7E, e: 1, g: 1 },
    { opcode: 0x660F7E, e: 1, g: 1 },
    { opcode: 0xF30F7E, e: 1, g: 1 },
    { opcode: 0x0F7F, e: 1, g: 1 },
    { opcode: 0x660F7F, only_mem: 1, e: 1, g: 1 }, // XXX: Remove only_mem once supported by v86
    { opcode: 0xF30F7F, only_mem: 1, e: 1, g: 1 }, // XXX: Remove only_mem once supported by v86

    { opcode: 0x0FC3, e: 1, g: 1, only_mem: 1, },
    { opcode: 0x660FC5, e: 1, g: 1, only_reg: 1, imm8: 1, },

    { opcode: 0x0FD1, e: 1, g: 1 },
    //{ opcode: 0x660FD1, e: 1, g: 1 },
    { opcode: 0x0FD2, e: 1, g: 1 },
    //{ opcode: 0x660FD2, e: 1, g: 1 },
    { opcode: 0x0FD3, e: 1, g: 1 },
    { opcode: 0x660FD3, e: 1, g: 1 },
    { opcode: 0x0FD3, e: 1, g: 1 },
    //{ opcode: 0x660FD3, e: 1, g: 1 },
    //{ opcode: 0x0FD4, e: 1, g: 1 },
    //{ opcode: 0x660FD4, e: 1, g: 1 },
    { opcode: 0x0FD5, e: 1, g: 1 },
    { opcode: 0x660FD5, e: 1, g: 1 },

    { opcode: 0x660FD6, only_mem: 1, e: 1, g: 1 }, // XXX: Remove only_mem once supported by v86
    //{ opcode: 0xF20FD6, e: 1, g: 1 },
    //{ opcode: 0xF30FD6, e: 1, g: 1 },

    //{ opcode: 0x0FD7, e: 1, g: 1, only_reg: 1, },
    { opcode: 0x660FD7, e: 1, g: 1, only_reg: 1, },
    { opcode: 0x0FD8, e: 1, g: 1 },
    //{ opcode: 0x660FD8, e: 1, g: 1 },
    { opcode: 0x0FD9, e: 1, g: 1 },
    //{ opcode: 0x660FD9, e: 1, g: 1 },
    //{ opcode: 0x0FDA, e: 1, g: 1 },
    { opcode: 0x660FDA, e: 1, g: 1 },
    { opcode: 0x0FDB, e: 1, g: 1 },
    //{ opcode: 0x660FDB, e: 1, g: 1 },
    { opcode: 0x0FDC, e: 1, g: 1 },
    { opcode: 0x660FDC, e: 1, g: 1 },
    { opcode: 0x0FDD, e: 1, g: 1 },
    { opcode: 0x660FDD, e: 1, g: 1 },
    //{ opcode: 0x0FDE, e: 1, g: 1 },
    { opcode: 0x660FDE, e: 1, g: 1 },
    { opcode: 0x0FDF, e: 1, g: 1 },
    //{ opcode: 0x660FDF, e: 1, g: 1 },

    //{ opcode: 0x0FE0, e: 1, g: 1 },
    //{ opcode: 0x660FE0, e: 1, g: 1 },
    { opcode: 0x0FE1, e: 1, g: 1 },
    //{ opcode: 0x660FE1, e: 1, g: 1 },
    { opcode: 0x0FE2, e: 1, g: 1 },
    //{ opcode: 0x660FE2, e: 1, g: 1 },
    //{ opcode: 0x0FE3, e: 1, g: 1 },
    //{ opcode: 0x660FE3, e: 1, g: 1 },
    //{ opcode: 0x0FE4, e: 1, g: 1 },
    { opcode: 0x660FE4, e: 1, g: 1 },
    { opcode: 0x0FE5, e: 1, g: 1 },
    //{ opcode: 0x660FE5, e: 1, g: 1 },

    //{ opcode: 0x660FE6, e: 1, g: 1 },
    //{ opcode: 0xF20FE6, e: 1, g: 1 },
    //{ opcode: 0xF30FE6, e: 1, g: 1 },
    //{ opcode: 0x0FE7, e: 1, g: 1, only_mem: 1, },
    { opcode: 0x660FE7, e: 1, g: 1, only_mem: 1, },

    { opcode: 0x0FE8, e: 1, g: 1 },
    //{ opcode: 0x660FE8, e: 1, g: 1 },
    { opcode: 0x0FE9, e: 1, g: 1 },
    //{ opcode: 0x660FE9, e: 1, g: 1 },
    //{ opcode: 0x0FEA, e: 1, g: 1 },
    //{ opcode: 0x660FEA, e: 1, g: 1 },
    { opcode: 0x0FEB, e: 1, g: 1 },
    { opcode: 0x660FEB, e: 1, g: 1 },
    { opcode: 0x0FEC, e: 1, g: 1 },
    //{ opcode: 0x660FEC, e: 1, g: 1 },
    { opcode: 0x0FED, e: 1, g: 1 },
    //{ opcode: 0x660FED, e: 1, g: 1 },
    //{ opcode: 0x0FEE, e: 1, g: 1 },
    //{ opcode: 0x660FEE, e: 1, g: 1 },
    { opcode: 0x0FEF, e: 1, g: 1 },
    { opcode: 0x660FEF, e: 1, g: 1 },

    { opcode: 0x0FF1, e: 1, g: 1 },
    //{ opcode: 0x660FF1, e: 1, g: 1 },
    { opcode: 0x0FF2, e: 1, g: 1 },
    //{ opcode: 0x660FF2, e: 1, g: 1 },
    { opcode: 0x0FF3, e: 1, g: 1 },
    //{ opcode: 0x660FF3, e: 1, g: 1 },
    //{ opcode: 0x0FF4, e: 1, g: 1 },
    //{ opcode: 0x660FF4, e: 1, g: 1 },
    { opcode: 0x0FF5, e: 1, g: 1 },
    //{ opcode: 0x660FF5, e: 1, g: 1 },
    //{ opcode: 0x0FF6, e: 1, g: 1 },
    //{ opcode: 0x660FF6, e: 1, g: 1 },
    //{ opcode: 0x0FF7, e: 1, g: 1 },
    //{ opcode: 0x660FF7, e: 1, g: 1 },
    { opcode: 0x0FF8, e: 1, g: 1 },
    //{ opcode: 0x660FF8, e: 1, g: 1 },
    { opcode: 0x0FF9, e: 1, g: 1 },
    //{ opcode: 0x660FF9, e: 1, g: 1 },
    { opcode: 0x0FFA, e: 1, g: 1 },
    { opcode: 0x660FFA, e: 1, g: 1 },
    //{ opcode: 0x0FFB, e: 1, g: 1 },
    //{ opcode: 0x660FFB, e: 1, g: 1 },
    { opcode: 0x0FFC, e: 1, g: 1 },
    //{ opcode: 0x660FFC, e: 1, g: 1 },
    { opcode: 0x0FFD, e: 1, g: 1 },
    //{ opcode: 0x660FFD, e: 1, g: 1 },
    { opcode: 0x0FFE, e: 1, g: 1 },
    //{ opcode: 0x660FFE, e: 1, g: 1 },
];

for(var i = 0; i < 8; i++)
{
    encodings.push.apply(encodings, [
        { opcode: 0x00 | i << 3, e: 1, g: 1, },
        { opcode: 0x01 | i << 3, os: 1, e: 1, g: 1, },
        { opcode: 0x02 | i << 3, e: 1, g: 1, },
        { opcode: 0x03 | i << 3, os: 1, e: 1, g: 1, },
        { opcode: 0x04 | i << 3, eax: 1, imm: 1, },
        { opcode: 0x05 | i << 3, os: 1, eax: 1, imm: 1, },

        { opcode: 0x70 | i, imm8: 1, skip: 1, },
        { opcode: 0x78 | i, imm8: 1, skip: 1, },

        { opcode: 0x80, e: 1, fixed_g: i, imm: 1, },
        { opcode: 0x81, os: 1, e: 1, fixed_g: i, imm: 1, },
        { opcode: 0x82, e: 1, fixed_g: i, imm: 1, },
        { opcode: 0x83, os: 1, e: 1, fixed_g: i, imm8: 1, },

        { opcode: 0xB0 | i, imm8: 1, skip: 1, },
        { opcode: 0xB8 | i, os: 1, imm1632: 1, skip: 1, },

        // note: overflow flag only undefined if shift is > 1
        { opcode: 0xC0, e: 1, fixed_g: i, imm8: 1, mask_flags: of, },
        { opcode: 0xC1, os: 1, e: 1, fixed_g: i, imm8: 1, mask_flags: of, },
        { opcode: 0xD0, e: 1, fixed_g: i, mask_flags: of, },
        { opcode: 0xD1, os: 1, e: 1, fixed_g: i, mask_flags: of, },
        { opcode: 0xD2, e: 1, fixed_g: i, mask_flags: of, },
        { opcode: 0xD3, os: 1, e: 1, fixed_g: i, mask_flags: of, },
    ]);
}

encodings.sort((e1, e2) => {
    let o1 = (e1.opcode & 0xFF00) === 0x0F00 ? e1.opcode & 0xFFFF : e1.opcode & 0xFF;
    let o2 = (e2.opcode & 0xFF00) === 0x0F00 ? e2.opcode & 0xFFFF : e2.opcode & 0xFF;
    return o1 - o2 || e1.fixed_g - e2.fixed_g;
});

function repeat(s, n)
{
    let out = "";
    for(let i = 0; i < n; i++) out += s;
    return out;
}

function indent(lines, how_much)
{
    return lines.map(line => repeat(" ", how_much) + line);
}

function print_syntax_tree(statements)
{
    let code = [];

    for(let statement of statements)
    {
        if(typeof statement === "string")
        {
            code.push(statement);
        }
        else if(statement.type === "switch")
        {
            console.assert(statement.condition);
            code.push(`switch(${statement.condition})`);
            code.push(`{`);
            code.push.apply(code, indent(print_syntax_tree(statement.body), 4));
            code.push(`}`);
        }
        else if(statement.type === "case")
        {
            for(let case_ of statement.cases)
            {
                code.push(`case ${case_}:`);
            }

            code.push(`{`);
            code.push.apply(code, indent(print_syntax_tree(statement.body), 4));
            code.push(`}`);
            code.push(`break;`);
        }
        else if(statement.type === "default-case")
        {
            console.assert(statement.body);

            code.push(`default:`);
            code.push.apply(code, indent(statement.body, 4));
        }
        else
        {
            console.assert(false, "Unexpected type: " + statement.type);
        }
    }

    return code;
}

function gen_instruction_body(encoding, variant)
{
    let suffix = encoding[0].os ? `${variant}` : "";
    let opcode = encoding[0].opcode & 0xFF;

    let opcode_hex = opcode.toString(16).toUpperCase();
    if(opcode_hex.length === 1) opcode_hex = "0" + opcode_hex;

    //if(opcode === 0 || opcode === 1 || opcode === 2 || opcode === 3)
    //{
    //    return [
    //        `int32_t modrm_byte = read_imm8();`,
    //        `modrm_byte < 0xC0 ?`,
    //        `    instr${suffix}_${opcode_hex}_mem(modrm_resolve(modrm_byte), modrm_byte >> 3 & 7) :`,
    //        `    instr${suffix}_${opcode_hex}_reg(modrm_byte & 7, modrm_byte >> 3 & 7);`,
    //    ];
    //}
    //else
    if(encoding.length > 1)
    {
        let cases = encoding.slice().sort((e1, e2) => e1.fixed_g - e2.fixed_g);

        for(let case_ of cases)
        {
            console.assert(typeof case_.fixed_g === "number");
        }

        return [
            "read_modrm_byte();",
            {
                type: "switch",
                condition: "*modrm_byte >> 3 & 7",
                body: cases.map(case_ => {
                    return {
                        type: "case",
                        cases: [case_.fixed_g],
                        body: [`instr${suffix}_${opcode_hex}_${case_.fixed_g}();`]
                    };
                }).concat([
                    {
                        type: "default-case",
                        body: ["assert(false);"],
                    }
                ]),
            }
        ];
    }
    else
    {
        return [`instr${suffix}_${opcode_hex}();`];
    }
}

function gen_table()
{
    let by_opcode = Object.create(null);
    let by_opcode0f = Object.create(null);

    for(let o of encodings)
    {
        let opcode = o.opcode;

        if(opcode >= 0x100)
        {
            if((opcode & 0xFF00) === 0x0F00)
            {
                opcode &= 0xFF;
                by_opcode0f[opcode] = by_opcode0f[opcode] || [];
                by_opcode0f[opcode].push(o);
            }
        }
        else
        {
            by_opcode[opcode] = by_opcode[opcode] || [];
            by_opcode[opcode].push(o);
        }
    }

    let t = [];
    for(let opcode = 0; opcode < 0x100; opcode++)
    {
        let encoding = by_opcode[opcode];
        console.assert(encoding && encoding.length);

        let opcode_hex = opcode.toString(16).toUpperCase();
        if(opcode_hex.length === 1) opcode_hex = "0" + opcode_hex;

        if(encoding[0].os)
        {
            t.push({
                type: "case",
                cases: [`0x${opcode_hex}`],
                body: gen_instruction_body(encoding, 16),
            });
            t.push({
                type: "case",
                cases: [`0x${opcode_hex}|0x100`],
                body: gen_instruction_body(encoding, 32),
            });
        }
        else
        {
            t.push({
                type: "case",
                cases: [`0x${opcode_hex}`, `0x${opcode_hex}|0x100`],
                body: gen_instruction_body(encoding, undefined),
            });
        }
    }
    t.push({
        type: "default-case",
        body: ["assert(false);"],
    });
    fs.writeFileSync("/tmp/table", print_syntax_tree(t).join("\n"));

    let t0f_16 = ``;
    let t0f_32 = ``;
    for(let opcode = 0; opcode < 0x100; opcode++)
    {
        let encoding = by_opcode0f[opcode];

        if(!encoding)
        {
            encoding = [
                {},
            ];
        }

        console.assert(encoding && encoding.length);

        let opcode_hex = opcode.toString(16).toUpperCase();
        if(opcode_hex.length === 1) opcode_hex = "0" + opcode_hex;

        if(encoding[0].os)
        {
            t0f_16 += `case 0x${opcode_hex}:\n`;
            t0f_16 += `    instr16_0F${opcode_hex}();\n`;
            t0f_16 += `    break;\n`;

            t0f_32 += `case 0x${opcode_hex}:\n`;
            t0f_32 += `    instr32_0F${opcode_hex}();\n`;
            t0f_32 += `    break;\n`;
        }
        else
        {
            t0f_16 += `case 0x${opcode_hex}:\n`;
            t0f_16 += `    instr_0F${opcode_hex}();\n`;
            t0f_16 += `    break;\n`;

            t0f_32 += `case 0x${opcode_hex}:\n`;
            t0f_32 += `    instr_0F${opcode_hex}();\n`;
            t0f_32 += `    break;\n`;
        }
    }
    t0f_16 += `default: assert(false);\n`;
    t0f_32 += `default: assert(false);\n`;
    fs.writeFileSync("/tmp/table0f_16", t0f_16);
    fs.writeFileSync("/tmp/table0f_32", t0f_32);
}
gen_table();

for(const op of encodings)
{
    const configurations = [
        { mem: 0, size: 16, },
        { mem: 0, size: 32, },
        { mem: 1, size: 16, },
        { mem: 1, size: 32, },
    ];

    let i = 0;

    for(const config of configurations)
    {
        for(const code of create_nasm(op, config))
        {
            const filename = "gen_" + format_opcode(op.opcode) + "_" + (op.fixed_g || 0) + "_" + i + ".asm";
            const dirname = __dirname + "/build/" + filename;

            let old_code = undefined;

            try
            {
                old_code = fs.readFileSync(dirname, { encoding: "ascii" });
            }
            catch(e)
            {
            }

            if(old_code !== code)
            {
                console.log("Creating %s", filename);
                fs.writeFileSync(dirname, code);
            }
            else
            {
                console.log("Unchanged: %s", filename);
            }

            i++;
        }
    }
}

function format_opcode(n)
{
    let x = n.toString(16);
    return (x.length === 1 || x.length === 3) ? "0" + x : x;
}

function random_int32()
{
    return Math.random() * 0x100000000 | 0;
}

function create_nasm(op, config)
{
    if(op.prefix || op.skip)
    {
        return [];
    }

    if(config.mem ? op.only_reg : op.only_mem)
    {
        // illegal opcode
        return [];
    }

    if(!op.e)
    {
        if(config.mem)
        {
            // doesn't use memory, don't test both
            return [];
        }
    }

    if(!op.os)
    {
        if(config.size === 16)
        {
            // equivalent to 32-bit version, don't test both
            return [];
        }
    }

    var size = (op.os || op.opcode % 2 === 1) ? config.size : 8;
    var is_modrm = op.e || op.g || op.fixed_g !== undefined;

    var codes = [];

    for(let reg of ["eax", "ecx", "edx", "ebx", "ebp", "esi", "edi"])
    {
        let rand = random_int32();
        codes.push("mov " + reg + ", " + rand);
    }

    if(true) // generate random mmx registers
    {
        codes.push("sub esp, 8");
        for(let i = 0; i < 8; i++)
        {
            codes.push("mov dword [esp], " + random_int32());
            codes.push("mov dword [esp + 4], " + random_int32());
            codes.push("movq mm" + i + ", [esp]");
        }
        codes.push("add esp, 8");
    }

    if(true) // generate random xmm registers
    {
        codes.push("sub esp, 16");
        for(let i = 0; i < 8; i++)
        {
            codes.push("mov dword [esp], " + random_int32());
            codes.push("mov dword [esp + 4], " + random_int32());
            codes.push("mov dword [esp + 8], " + random_int32());
            codes.push("mov dword [esp + 12], " + random_int32());
            codes.push("movdqu xmm" + i + ", [esp]");
        }
        codes.push("add esp, 16");
    }

    if(true) // generate random stack memory
    {
        for(let i = 0; i < 8; i++)
        {
            codes.push("sub esp, 4");
            codes.push("mov dword [esp], " + random_int32());
        }
    }

    codes.push("push dword " + (random_int32() & ~(1 << 8 | 1 << 9)));
    codes.push("popf");

    if(size === 16)
    {
        codes.push("db 66h ; 16 bit");
    }

    let opcode = op.opcode;
    console.assert(opcode < 0x1000000);
    if(opcode >= 0x10000)
    {
        let c = opcode >> 16;
        console.assert(c === 0x66 || c === 0xF3 || c === 0xF2);
        codes.push("db " + c);
        opcode &= ~0xFF0000;
    }
    if(opcode >= 0x100)
    {
        let c = opcode >> 8;
        console.assert(c === 0x0F, "Expected 0f prefix, got " + c.toString(16));
        codes.push("db " + c);
        opcode &= ~0xFF00;
    }
    codes.push("db " + opcode);

    if(is_modrm)
    {
        let g = 0;

        if(op.fixed_g !== undefined)
        {
            g = op.fixed_g;
        }

        let e;
        let sib;

        if(config.mem)
        {
            e = 0x04; // [esp]
            sib = 0x24;
        }
        else // op.only_mem
        {
            e = 0xc2; // edx
            sib = "<invalid>";
        }

        codes.push("db " + (e | g << 3));
        if(e < 0xC0)
        {
            codes.push("db " + sib);
        }
    }

    if(op.imm || op.imm8 || op.imm1632 || op.immaddr)
    {
        if(op.imm8 || (op.imm && size === 8))
        {
            codes.push("db 12h");
        }
        else
        {
            if(op.immaddr)
            {
                // immaddr: depends on address size
                codes.push("dd 1234abcdh");
            }
            else
            {
                console.assert(op.imm1632 || (op.imm && (size === 16 || size === 32)));

                if(size === 16)
                {
                    codes.push("dw 34cdh");
                }
                else
                {
                    codes.push("dd 1234abcdh");
                }
            }
        }
    }

    if(op.mask_flags)
    {
        codes.push(
            "pushf",
            "and dword [esp], ~" + op.mask_flags,
            "popf"
        );
    }

    return all_combinations(codes).map(c => {
        return (
            "global _start\n" +
            '%include "header.inc"\n\n' +
            c.join("\n") + "\n" +
            '%include "footer.inc"\n'
        );
    });
}

function all_combinations(xs)
{
    var result = [xs];

    for(let i = 0; i < xs.length; i++)
    {
        let x = xs[i];

        if(x instanceof Array)
        {
            let new_result = [];

            for(let r of result)
            {
                for(let x_ of x)
                {
                    r = r.slice();
                    r[i] = x_;
                    new_result.push(r);
                }
            }

            result = new_result;
        }
    }

    return result;
}
