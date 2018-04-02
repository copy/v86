"use strict";

// http://ref.x86asm.net/coder32.html

const zf = 1 << 6;
const of = 1 << 11;
const cf = 1 << 0;
const af = 1 << 4;
const pf = 1 << 2;
const sf = 1 << 7;

// TODO:
// - describe which registers are written and read

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
    { opcode: 0x27, nonfaulting: 1, mask_flags: of, },
    { opcode: 0x2E, prefix: 1, },
    { opcode: 0x2F, nonfaulting: 1, mask_flags: of, },
    { opcode: 0x36, prefix: 1, },
    { opcode: 0x37, nonfaulting: 1, mask_flags: of | sf | pf | zf, },
    { opcode: 0x3E, prefix: 1, },
    { opcode: 0x3F, nonfaulting: 1, mask_flags: of | sf | pf | zf, },

    { opcode: 0x40, nonfaulting: 1, os: 1, },
    { opcode: 0x41, nonfaulting: 1, os: 1, },
    { opcode: 0x42, nonfaulting: 1, os: 1, },
    { opcode: 0x43, nonfaulting: 1, os: 1, },
    { opcode: 0x44, nonfaulting: 1, os: 1, },
    { opcode: 0x45, nonfaulting: 1, os: 1, },
    { opcode: 0x46, nonfaulting: 1, os: 1, },
    { opcode: 0x47, nonfaulting: 1, os: 1, },

    { opcode: 0x48, nonfaulting: 1, os: 1, },
    { opcode: 0x49, nonfaulting: 1, os: 1, },
    { opcode: 0x4A, nonfaulting: 1, os: 1, },
    { opcode: 0x4B, nonfaulting: 1, os: 1, },
    { opcode: 0x4C, nonfaulting: 1, os: 1, },
    { opcode: 0x4D, nonfaulting: 1, os: 1, },
    { opcode: 0x4E, nonfaulting: 1, os: 1, },
    { opcode: 0x4F, nonfaulting: 1, os: 1, },

    { opcode: 0x50, custom: 1, os: 1, },
    { opcode: 0x51, custom: 1, os: 1, },
    { opcode: 0x52, custom: 1, os: 1, },
    { opcode: 0x53, custom: 1, os: 1, },
    { opcode: 0x54, custom: 1, os: 1, },
    { opcode: 0x55, custom: 1, os: 1, },
    { opcode: 0x56, custom: 1, os: 1, },
    { opcode: 0x57, custom: 1, os: 1, },

    { opcode: 0x58, custom: 1, os: 1, },
    { opcode: 0x59, custom: 1, os: 1, },
    { opcode: 0x5A, custom: 1, os: 1, },
    { opcode: 0x5B, custom: 1, os: 1, },
    { opcode: 0x5C, os: 1, },
    { opcode: 0x5D, custom: 1, os: 1, },
    { opcode: 0x5E, custom: 1, os: 1, },
    { opcode: 0x5F, custom: 1, os: 1, },

    { opcode: 0x60, os: 1, },
    { opcode: 0x61, os: 1, },
    { opcode: 0x62, e: 1, skip: 1, },
    { opcode: 0x63, e: 1, },
    { opcode: 0x64, prefix: 1, },
    { opcode: 0x65, prefix: 1, },
    { opcode: 0x66, prefix: 1, },
    { opcode: 0x67, prefix: 1, },

    { opcode: 0x68, custom: 1, os: 1, imm1632: 1, },
    { opcode: 0x69, nonfaulting: 1, os: 1, e: 1, imm1632: 1, mask_flags: af, }, // zf?
    { opcode: 0x6A, custom: 1, os: 1, imm8s: 1, },
    { opcode: 0x6B, nonfaulting: 1, os: 1, e: 1, imm8s: 1, mask_flags: af, }, // zf?

    { opcode: 0x6C, block_boundary: 1, is_string: 1, skip: 1, },          // ins
    { opcode: 0x6D, block_boundary: 1, is_string: 1, os: 1, skip: 1, },
    { opcode: 0x6E, block_boundary: 1, is_string: 1, skip: 1, },          // outs
    { opcode: 0x6F, block_boundary: 1, is_string: 1, os: 1, skip: 1, },

    { opcode: 0x84, nonfaulting: 1, e: 1, },
    { opcode: 0x85, nonfaulting: 1, os: 1, e: 1, },
    { opcode: 0x86, nonfaulting: 1, e: 1, },
    { opcode: 0x87, nonfaulting: 1, os: 1, e: 1, },
    { opcode: 0x88, nonfaulting: 1, e: 1, },
    { opcode: 0x89, nonfaulting: 1, os: 1, e: 1, },
    { opcode: 0x8A, nonfaulting: 1, e: 1, },
    { opcode: 0x8B, nonfaulting: 1, os: 1, e: 1, },

    { opcode: 0x8C, os: 1, e: 1, skip: 1, },
    { opcode: 0x8D, nonfaulting: 1, os: 1, e: 1, only_mem: 1, requires_prefix_call: 1, custom: 1, }, // lea
    { opcode: 0x8E, e: 1, skip: 1, },
    { opcode: 0x8F, os: 1, e: 1, fixed_g: 0, requires_prefix_call: 1, }, // pop r/m

    { opcode: 0x90, nonfaulting: 1, },
    { opcode: 0x91, nonfaulting: 1, os: 1, },
    { opcode: 0x92, nonfaulting: 1, os: 1, },
    { opcode: 0x93, nonfaulting: 1, os: 1, },
    { opcode: 0x94, nonfaulting: 1, os: 1, },
    { opcode: 0x95, nonfaulting: 1, os: 1, },
    { opcode: 0x96, nonfaulting: 1, os: 1, },
    { opcode: 0x97, nonfaulting: 1, os: 1, },

    { opcode: 0x98, nonfaulting: 1, os: 1, },
    { opcode: 0x99, nonfaulting: 1, os: 1, },
    { opcode: 0x9A, os: 1, imm1632: 1, extra_imm16: 1, skip: 1, block_boundary: 1, }, // callf
    { opcode: 0x9B, skip: 1, },
    { opcode: 0x9C, os: 1, },
    // popf: not a jump, but can cause an eip change due to updating the interrupt flag
    { opcode: 0x9D, os: 1, block_boundary: 1, skip: 1, },
    { opcode: 0x9E, },
    { opcode: 0x9F, },

    { opcode: 0xA0, immaddr: 1, },
    { opcode: 0xA1, os: 1, immaddr: 1, },
    { opcode: 0xA2, immaddr: 1, },
    { opcode: 0xA3, os: 1, immaddr: 1, },

    // string instructions aren't jumps, but they modify eip due to how they're implemented
    { opcode: 0xA4, block_boundary: 1, is_string: 1, },
    { opcode: 0xA5, block_boundary: 1, is_string: 1, os: 1, },
    { opcode: 0xA6, block_boundary: 1, is_string: 1, },
    { opcode: 0xA7, block_boundary: 1, is_string: 1, os: 1, },

    { opcode: 0xA8, nonfaulting: 1, imm8: 1, },
    { opcode: 0xA9, nonfaulting: 1, os: 1, imm1632: 1, },

    { opcode: 0xAA, block_boundary: 1, is_string: 1, },
    { opcode: 0xAB, block_boundary: 1, is_string: 1, os: 1, },
    { opcode: 0xAC, block_boundary: 1, is_string: 1, },
    { opcode: 0xAD, block_boundary: 1, is_string: 1, os: 1, },
    { opcode: 0xAE, block_boundary: 1, is_string: 1, },
    { opcode: 0xAF, block_boundary: 1, is_string: 1, os: 1, },

    { opcode: 0xC2, block_boundary: 1, os: 1, imm16: 1, skip: 1, }, // ret
    { opcode: 0xC3, block_boundary: 1, os: 1, skip: 1, },

    { opcode: 0xC4, os: 1, e: 1, skip: 1, },
    { opcode: 0xC5, os: 1, e: 1, skip: 1, },

    { opcode: 0xC6, e: 1, fixed_g: 0, nonfaulting: 1, imm8: 1, },
    { opcode: 0xC7, os: 1, e: 1, fixed_g: 0, nonfaulting: 1, imm1632: 1, },

    { opcode: 0xC8, os: 1, imm16: 1, extra_imm8: 1, }, // enter
    { opcode: 0xC9, os: 1, skip: 1, }, // leave: requires valid ebp
    { opcode: 0xCA, block_boundary: 1, os: 1, imm16: 1, skip: 1, }, // retf
    { opcode: 0xCB, block_boundary: 1, os: 1, skip: 1, },
    { opcode: 0xCC, block_boundary: 1, skip: 1, },
    { opcode: 0xCD, block_boundary: 1, skip: 1, imm8: 1, },
    { opcode: 0xCE, block_boundary: 1, skip: 1, },
    { opcode: 0xCF, block_boundary: 1, os: 1, skip: 1, },

    { opcode: 0xD4, imm8: 1, }, // aam, may trigger #de
    { opcode: 0xD5, nonfaulting: 1, imm8: 1, mask_flags: of | cf | af, },
    { opcode: 0xD6, nonfaulting: 1, },
    { opcode: 0xD7, skip: 1, },

    { opcode: 0xE0, imm8s: 1, skip: 1, block_boundary: 1, },
    { opcode: 0xE1, imm8s: 1, skip: 1, block_boundary: 1, },
    { opcode: 0xE2, imm8s: 1, skip: 1, block_boundary: 1, },
    { opcode: 0xE3, imm8s: 1, skip: 1, block_boundary: 1, },

    // port functions aren't jumps, but they may modify eip due to how they are implemented
    { opcode: 0xE4, block_boundary: 1, imm8: 1, skip: 1, }, // in
    { opcode: 0xE5, block_boundary: 1, os: 1, imm8: 1, skip: 1, },
    { opcode: 0xE6, block_boundary: 1, imm8: 1, skip: 1, }, // out
    { opcode: 0xE7, block_boundary: 1, os: 1, imm8: 1, skip: 1, },

    { opcode: 0xE8, block_boundary: 1, os: 1, imm1632: 1, custom: 1, skip: 1, },
    { opcode: 0xE9, block_boundary: 1, os: 1, imm1632: 1, custom: 1, skip: 1, },
    { opcode: 0xEA, block_boundary: 1, os: 1, imm1632: 1, extra_imm16: 1, skip: 1, }, // jmpf
    { opcode: 0xEB, block_boundary: 1, imm8s: 1, custom: 1, skip: 1, },

    { opcode: 0xEC, block_boundary: 1, skip: 1, },
    { opcode: 0xED, block_boundary: 1, os: 1, skip: 1, },
    { opcode: 0xEE, block_boundary: 1, skip: 1, },
    { opcode: 0xEF, block_boundary: 1, os: 1, skip: 1, },

    { opcode: 0xF0, prefix: 1, },
    { opcode: 0xF1, skip: 1, },
    { opcode: 0xF2, prefix: 1, },
    { opcode: 0xF3, prefix: 1, },
    { opcode: 0xF4, block_boundary: 1, skip: 1, },
    { opcode: 0xF5, nonfaulting: 1, },

    { opcode: 0xF6, fixed_g: 0, nonfaulting: 1, imm8: 1, },
    { opcode: 0xF6, fixed_g: 1, nonfaulting: 1, imm8: 1, },
    { opcode: 0xF6, fixed_g: 2, nonfaulting: 1, },
    { opcode: 0xF6, fixed_g: 3, nonfaulting: 1, },
    { opcode: 0xF6, fixed_g: 4, nonfaulting: 1, mask_flags: af | zf, },
    { opcode: 0xF6, fixed_g: 5, nonfaulting: 1, mask_flags: af | zf, },
    { opcode: 0xF6, fixed_g: 6, },
    { opcode: 0xF6, fixed_g: 7, },

    { opcode: 0xF7, os: 1, fixed_g: 0, nonfaulting: 1, imm1632: 1, },
    { opcode: 0xF7, os: 1, fixed_g: 1, nonfaulting: 1, imm1632: 1, },
    { opcode: 0xF7, os: 1, fixed_g: 2, nonfaulting: 1, },
    { opcode: 0xF7, os: 1, fixed_g: 3, nonfaulting: 1, },
    { opcode: 0xF7, os: 1, fixed_g: 4, nonfaulting: 1, mask_flags: zf | af, },
    { opcode: 0xF7, os: 1, fixed_g: 5, nonfaulting: 1, mask_flags: zf | af, },
    { opcode: 0xF7, os: 1, fixed_g: 6, },
    { opcode: 0xF7, os: 1, fixed_g: 7, },

    { opcode: 0xF8, nonfaulting: 1, },
    { opcode: 0xF9, nonfaulting: 1, },
    { opcode: 0xFA, skip: 1, },
    // sti: not a jump, but can cause a change in eip
    { opcode: 0xFB, block_boundary: 1, skip: 1, },
    { opcode: 0xFC, nonfaulting: 1, },
    { opcode: 0xFD, nonfaulting: 1, },

    { opcode: 0xFE, e: 1, fixed_g: 0, nonfaulting: 1, },
    { opcode: 0xFE, e: 1, fixed_g: 1, nonfaulting: 1, },
    { opcode: 0xFF, os: 1, e: 1, fixed_g: 0, nonfaulting: 1, },
    { opcode: 0xFF, os: 1, e: 1, fixed_g: 1, nonfaulting: 1, },
    { opcode: 0xFF, os: 1, e: 1, fixed_g: 2, block_boundary: 1, skip: 1, },
    { opcode: 0xFF, os: 1, e: 1, fixed_g: 3, block_boundary: 1, skip: 1, },
    { opcode: 0xFF, os: 1, e: 1, fixed_g: 4, block_boundary: 1, skip: 1, },
    { opcode: 0xFF, os: 1, e: 1, fixed_g: 5, block_boundary: 1, skip: 1, },
    { opcode: 0xFF, custom: 1, os: 1, e: 1, fixed_g: 6, },

    { opcode: 0x0F00, fixed_g: 0, e: 1, skip: 1 },
    { opcode: 0x0F00, fixed_g: 1, e: 1, skip: 1 },
    { opcode: 0x0F00, fixed_g: 2, e: 1, skip: 1 },
    { opcode: 0x0F00, fixed_g: 3, e: 1, skip: 1 },
    { opcode: 0x0F00, fixed_g: 4, e: 1, skip: 1 },
    { opcode: 0x0F00, fixed_g: 5, e: 1, skip: 1 },

    { opcode: 0x0F01, fixed_g: 0, e: 1, skip: 1 },
    { opcode: 0x0F01, fixed_g: 1, e: 1, skip: 1 },
    { opcode: 0x0F01, fixed_g: 2, e: 1, skip: 1 },
    { opcode: 0x0F01, fixed_g: 3, e: 1, skip: 1 },
    { opcode: 0x0F01, fixed_g: 4, e: 1, skip: 1 },
    { opcode: 0x0F01, fixed_g: 6, e: 1, skip: 1 },
    { opcode: 0x0F01, fixed_g: 7, e: 1, skip: 1 },

    { opcode: 0x0F02, os: 1, e: 1, skip: 1 },
    { opcode: 0x0F03, os: 1, e: 1, skip: 1 },
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

    { opcode: 0x0F18, only_mem: 1, e: 1, },
    { opcode: 0x0F1F, e: 1, },

    { opcode: 0x0F20, ignore_mod: 1, e: 1, skip: 1 },
    { opcode: 0x0F21, ignore_mod: 1, e: 1, skip: 1 },
    { opcode: 0x0F22, ignore_mod: 1, e: 1, skip: 1 },
    { opcode: 0x0F23, ignore_mod: 1, e: 1, skip: 1 },

    { opcode: 0x0F30, skip: 1 },
    { opcode: 0x0F31, skip: 1 },
    { opcode: 0x0F32, skip: 1 },
    { opcode: 0x0F33, skip: 1 },
    { opcode: 0x0F34, skip: 1, block_boundary: 1, }, // sysenter
    { opcode: 0x0F35, skip: 1, block_boundary: 1, }, // sysexit

    { opcode: 0x0F40, nonfaulting: 1, e: 1, os: 1, },
    { opcode: 0x0F41, nonfaulting: 1, e: 1, os: 1, },
    { opcode: 0x0F42, nonfaulting: 1, e: 1, os: 1, },
    { opcode: 0x0F43, nonfaulting: 1, e: 1, os: 1, },
    { opcode: 0x0F44, nonfaulting: 1, e: 1, os: 1, },
    { opcode: 0x0F45, nonfaulting: 1, e: 1, os: 1, },
    { opcode: 0x0F46, nonfaulting: 1, e: 1, os: 1, },
    { opcode: 0x0F47, nonfaulting: 1, e: 1, os: 1, },
    { opcode: 0x0F48, nonfaulting: 1, e: 1, os: 1, },
    { opcode: 0x0F49, nonfaulting: 1, e: 1, os: 1, },
    { opcode: 0x0F4A, nonfaulting: 1, e: 1, os: 1, },
    { opcode: 0x0F4B, nonfaulting: 1, e: 1, os: 1, },
    { opcode: 0x0F4C, nonfaulting: 1, e: 1, os: 1, },
    { opcode: 0x0F4D, nonfaulting: 1, e: 1, os: 1, },
    { opcode: 0x0F4E, nonfaulting: 1, e: 1, os: 1, },
    { opcode: 0x0F4F, nonfaulting: 1, e: 1, os: 1, },

    { opcode: 0x0F80, block_boundary: 1, imm1632: 1, os: 1, custom: 1, skip: 1, },
    { opcode: 0x0F81, block_boundary: 1, imm1632: 1, os: 1, custom: 1, skip: 1, },
    { opcode: 0x0F82, block_boundary: 1, imm1632: 1, os: 1, custom: 1, skip: 1, },
    { opcode: 0x0F83, block_boundary: 1, imm1632: 1, os: 1, custom: 1, skip: 1, },
    { opcode: 0x0F84, block_boundary: 1, imm1632: 1, os: 1, custom: 1, skip: 1, },
    { opcode: 0x0F85, block_boundary: 1, imm1632: 1, os: 1, custom: 1, skip: 1, },
    { opcode: 0x0F86, block_boundary: 1, imm1632: 1, os: 1, custom: 1, skip: 1, },
    { opcode: 0x0F87, block_boundary: 1, imm1632: 1, os: 1, custom: 1, skip: 1, },
    { opcode: 0x0F88, block_boundary: 1, imm1632: 1, os: 1, custom: 1, skip: 1, },
    { opcode: 0x0F89, block_boundary: 1, imm1632: 1, os: 1, custom: 1, skip: 1, },
    { opcode: 0x0F8A, block_boundary: 1, imm1632: 1, os: 1, custom: 1, skip: 1, },
    { opcode: 0x0F8B, block_boundary: 1, imm1632: 1, os: 1, custom: 1, skip: 1, },
    { opcode: 0x0F8C, block_boundary: 1, imm1632: 1, os: 1, custom: 1, skip: 1, },
    { opcode: 0x0F8D, block_boundary: 1, imm1632: 1, os: 1, custom: 1, skip: 1, },
    { opcode: 0x0F8E, block_boundary: 1, imm1632: 1, os: 1, custom: 1, skip: 1, },
    { opcode: 0x0F8F, block_boundary: 1, imm1632: 1, os: 1, custom: 1, skip: 1, },

    { opcode: 0x0F90, nonfaulting: 1, e: 1, },
    { opcode: 0x0F91, nonfaulting: 1, e: 1, },
    { opcode: 0x0F92, nonfaulting: 1, e: 1, },
    { opcode: 0x0F93, nonfaulting: 1, e: 1, },
    { opcode: 0x0F94, nonfaulting: 1, e: 1, },
    { opcode: 0x0F95, nonfaulting: 1, e: 1, },
    { opcode: 0x0F96, nonfaulting: 1, e: 1, },
    { opcode: 0x0F97, nonfaulting: 1, e: 1, },
    { opcode: 0x0F98, nonfaulting: 1, e: 1, },
    { opcode: 0x0F99, nonfaulting: 1, e: 1, },
    { opcode: 0x0F9A, nonfaulting: 1, e: 1, },
    { opcode: 0x0F9B, nonfaulting: 1, e: 1, },
    { opcode: 0x0F9C, nonfaulting: 1, e: 1, },
    { opcode: 0x0F9D, nonfaulting: 1, e: 1, },
    { opcode: 0x0F9E, nonfaulting: 1, e: 1, },
    { opcode: 0x0F9F, nonfaulting: 1, e: 1, },

    { opcode: 0x0FA0, os: 1, skip: 1, },
    { opcode: 0x0FA1, os: 1, skip: 1, },
    { opcode: 0x0FA2, skip: 1, },

    { opcode: 0x0FA8, os: 1, skip: 1, },
    { opcode: 0x0FA9, os: 1, skip: 1, },

    { opcode: 0x0FA3, os: 1, e: 1, only_reg: 1, }, // bt (can also index memory, but not supported by test right now)
    { opcode: 0x0FAB, os: 1, e: 1, only_reg: 1, },
    { opcode: 0x0FB3, os: 1, e: 1, only_reg: 1, },
    { opcode: 0x0FBB, os: 1, e: 1, only_reg: 1, },

    { opcode: 0x0FBA, os: 1, e: 1, fixed_g: 4, imm8: 1, only_reg: 1, }, // bt
    { opcode: 0x0FBA, os: 1, e: 1, fixed_g: 5, imm8: 1, only_reg: 1, },
    { opcode: 0x0FBA, os: 1, e: 1, fixed_g: 6, imm8: 1, only_reg: 1, },
    { opcode: 0x0FBA, os: 1, e: 1, fixed_g: 7, imm8: 1, only_reg: 1, },

    { opcode: 0x0FBC, os: 1, e: 1, mask_flags: af, }, // bsf
    { opcode: 0x0FBD, os: 1, e: 1, mask_flags: af, },

    // note: overflow flag only undefined if shift is > 1
    { opcode: 0x0FA4, nonfaulting: 1, os: 1, e: 1, imm8: 1, mask_flags: af | of, }, // shld
    { opcode: 0x0FA5, nonfaulting: 1, os: 1, e: 1, mask_flags: af | of, },
    { opcode: 0x0FAC, nonfaulting: 1, os: 1, e: 1, imm8: 1, mask_flags: af | of, },
    { opcode: 0x0FAD, nonfaulting: 1, os: 1, e: 1, mask_flags: af | of, },

    { opcode: 0x0FAE, e: 1, fixed_g: 0, only_mem: 1, skip: 1, }, // fxsave, ...
    { opcode: 0x0FAE, e: 1, fixed_g: 1, only_mem: 1, skip: 1, },
    { opcode: 0x0FAE, e: 1, fixed_g: 2, only_mem: 1, skip: 1, },
    { opcode: 0x0FAE, e: 1, fixed_g: 3, only_mem: 1, skip: 1, },
    { opcode: 0x0FAE, e: 1, fixed_g: 4, only_mem: 1, skip: 1, },

    { opcode: 0x0FAE, e: 1, fixed_g: 5, only_reg: 1, skip: 1, }, // lfence (reg, only 0), xrstor (mem)
    { opcode: 0x0FAE, e: 1, fixed_g: 6, only_reg: 1, skip: 1, }, // mfence (reg, only 0)
    { opcode: 0x0FAE, e: 1, fixed_g: 7, only_reg: 1, skip: 1, }, // sfence (reg, only 0), clflush (mem)

    { opcode: 0x0FAF, nonfaulting: 1, os: 1, e: 1, mask_flags: af | zf }, // imul

    { opcode: 0x0FB0, nonfaulting: 1, e: 1 }, // cmxchg
    { opcode: 0x0FB1, nonfaulting: 1, os: 1, e: 1 },
    { opcode: 0x0FC7, e: 1, fixed_g: 1, only_mem: 1, }, // cmpxchg8b (memory)
    { opcode: 0x0FC7, e: 1, fixed_g: 6, only_reg: 1, skip: 1, }, // rdrand

    { opcode: 0x0FB2, os: 1, e: 1, skip: 1, }, // lss, lfs, lgs
    { opcode: 0x0FB4, os: 1, e: 1, skip: 1, },
    { opcode: 0x0FB5, os: 1, e: 1, skip: 1, },

    { opcode: 0x0FB6, nonfaulting: 1, os: 1, e: 1, }, // movzx
    { opcode: 0x0FB7, nonfaulting: 1, os: 1, e: 1, },

    { opcode: 0xF30FB8, os: 1, e: 1 }, // popcnt

    { opcode: 0x0FBE, nonfaulting: 1, os: 1, e: 1, }, // movsx
    { opcode: 0x0FBF, nonfaulting: 1, os: 1, e: 1, },

    { opcode: 0x0FC0, nonfaulting: 1, e: 1, }, // xadd
    { opcode: 0x0FC1, nonfaulting: 1, os: 1, e: 1, },

    { opcode: 0x0FC8, nonfaulting: 1, }, // bswap
    { opcode: 0x0FC9, nonfaulting: 1, },
    { opcode: 0x0FCA, nonfaulting: 1, },
    { opcode: 0x0FCB, nonfaulting: 1, },
    { opcode: 0x0FCC, nonfaulting: 1, },
    { opcode: 0x0FCD, nonfaulting: 1, },
    { opcode: 0x0FCE, nonfaulting: 1, },
    { opcode: 0x0FCF, nonfaulting: 1, },


    // mmx, sse
    // - Skipped are not implemented
    // - Missing are sse3+, and floating point

    { opcode: 0x0F10, e: 1 },
    { opcode: 0xF30F10, e: 1 },
    { opcode: 0x660F10, e: 1 },
    { opcode: 0xF20F10, e: 1 },
    { opcode: 0x0F11, e: 1 },
    { opcode: 0xF30F11, e: 1 },
    { opcode: 0x660F11, e: 1 },
    { opcode: 0xF20F11, e: 1 },
    { opcode: 0x0F12, e: 1 },
    { opcode: 0x660F12, only_mem: 1, e: 1 },
    { opcode: 0xF20F12, e: 1, skip: 1, },
    { opcode: 0xF30F12, e: 1, skip: 1, },
    { opcode: 0x0F13, only_mem: 1, e: 1 },
    { opcode: 0x660F13, only_mem: 1, e: 1 },
    { opcode: 0x0F14, e: 1 },
    { opcode: 0x660F14, e: 1 },
    { opcode: 0x0F15, e: 1 },
    { opcode: 0x660F15, e: 1 },
    { opcode: 0x0F16, e: 1 },
    { opcode: 0x660F16, only_mem: 1, e: 1 },
    { opcode: 0x0F17, only_mem: 1, e: 1 },
    { opcode: 0x660F17, only_mem: 1, e: 1 },

    { opcode: 0x0F28, e: 1 },
    { opcode: 0x660F28, e: 1 },
    { opcode: 0x0F29, e: 1 },
    { opcode: 0x660F29, e: 1 },
    { opcode: 0x0F2B, only_mem: 1, e: 1 },
    { opcode: 0x660F2B, only_mem: 1, e: 1 },

    { opcode: 0xF20F2C, e: 1, },
    { opcode: 0x0F2C, e: 1, skip: 1, },
    { opcode: 0xF30F2C, e: 1, skip: 1, },
    { opcode: 0x660F2C, e: 1, skip: 1, },

    { opcode: 0x0F50, only_reg: 1, e: 1 },
    { opcode: 0x660F50, only_reg: 1, e: 1 },
    { opcode: 0x0F54, e: 1 },
    { opcode: 0x660F54, e: 1 },
    { opcode: 0x0F55, e: 1 },
    { opcode: 0x660F55, e: 1 },
    { opcode: 0x0F56, e: 1 },
    { opcode: 0x660F56, e: 1 },
    { opcode: 0x0F57, e: 1 },
    { opcode: 0x660F57, e: 1 },

    { opcode: 0x660F60, e: 1 },
    { opcode: 0x0F60, e: 1 },
    { opcode: 0x660F61, e: 1 },
    { opcode: 0x0F61, e: 1 },
    { opcode: 0x660F62, e: 1 },
    { opcode: 0x0F62, e: 1 },
    { opcode: 0x660F63, e: 1 },
    { opcode: 0x0F63, e: 1 },
    { opcode: 0x660F64, e: 1 },
    { opcode: 0x0F64, e: 1 },
    { opcode: 0x660F65, e: 1 },
    { opcode: 0x0F65, e: 1 },
    { opcode: 0x660F66, e: 1 },
    { opcode: 0x0F66, e: 1 },
    { opcode: 0x660F67, e: 1 },
    { opcode: 0x0F67, e: 1 },

    { opcode: 0x660F68, e: 1 },
    { opcode: 0x0F68, e: 1 },
    { opcode: 0x660F69, e: 1 },
    { opcode: 0x0F69, e: 1 },
    { opcode: 0x660F6A, e: 1 },
    { opcode: 0x0F6A, e: 1 },
    { opcode: 0x660F6B, e: 1 },
    { opcode: 0x0F6B, e: 1 },
    { opcode: 0x660F6C, e: 1 },
    { opcode: 0x660F6D, e: 1 },
    { opcode: 0x660F6E, e: 1 },
    { opcode: 0x0F6E, e: 1 },
    { opcode: 0xF30F6F, e: 1 },
    { opcode: 0x660F6F, e: 1 },
    { opcode: 0x0F6F, e: 1 },

    { opcode: 0x0F70, e: 1, imm8: 1, },
    { opcode: 0x660F70, e: 1, imm8: 1, },
    { opcode: 0xF20F70, e: 1, imm8: 1, },
    { opcode: 0xF30F70, e: 1, imm8: 1, },

    { opcode: 0x0F71, e: 1, fixed_g: 2, imm8: 1, only_reg: 1, },
    { opcode: 0x660F71, e: 1, fixed_g: 2, imm8: 1, only_reg: 1 },
    { opcode: 0x0F71, e: 1, fixed_g: 4, imm8: 1, only_reg: 1, },
    { opcode: 0x660F71, e: 1, fixed_g: 4, imm8: 1, only_reg: 1 },
    { opcode: 0x0F71, e: 1, fixed_g: 6, imm8: 1, only_reg: 1, },
    { opcode: 0x660F71, e: 1, fixed_g: 6, imm8: 1, only_reg: 1 },

    { opcode: 0x0F72, e: 1, fixed_g: 2, imm8: 1, only_reg: 1, },
    { opcode: 0x660F72, e: 1, fixed_g: 2, imm8: 1, only_reg: 1 },
    { opcode: 0x0F72, e: 1, fixed_g: 4, imm8: 1, only_reg: 1, },
    { opcode: 0x660F72, e: 1, fixed_g: 4, imm8: 1, only_reg: 1 },
    { opcode: 0x0F72, e: 1, fixed_g: 6, imm8: 1, only_reg: 1, },
    { opcode: 0x660F72, e: 1, fixed_g: 6, imm8: 1, only_reg: 1 },

    { opcode: 0x0F73, e: 1, fixed_g: 2, imm8: 1, only_reg: 1, },
    { opcode: 0x660F73, e: 1, fixed_g: 2, imm8: 1, only_reg: 1, },
    { opcode: 0x660F73, e: 1, fixed_g: 3, imm8: 1, only_reg: 1 },
    { opcode: 0x0F73, e: 1, fixed_g: 6, imm8: 1, only_reg: 1, },
    { opcode: 0x660F73, e: 1, fixed_g: 6, imm8: 1, only_reg: 1 },
    { opcode: 0x660F73, e: 1, fixed_g: 7, imm8: 1, only_reg: 1 },

    { opcode: 0x0F74, e: 1, },
    { opcode: 0x660F74, e: 1, },
    { opcode: 0x0F75, e: 1, },
    { opcode: 0x660F75, e: 1, },
    { opcode: 0x0F76, e: 1, },
    { opcode: 0x660F76, e: 1, },
    { opcode: 0x0F77 },

    { opcode: 0x0F7E, e: 1 },
    { opcode: 0x660F7E, e: 1 },
    { opcode: 0xF30F7E, e: 1 },
    { opcode: 0x0F7F, e: 1 },
    { opcode: 0x660F7F, e: 1 },
    { opcode: 0xF30F7F, e: 1 },

    { opcode: 0x0FC3, e: 1, only_mem: 1, },
    { opcode: 0x0FC4, e: 1, imm8: 1 },
    { opcode: 0x660FC4, e: 1, imm8: 1 },

    { opcode: 0x0FC5, e: 1, only_reg: 1, imm8: 1 },
    { opcode: 0x660FC5, e: 1, only_reg: 1, imm8: 1, },

    { opcode: 0x0FD1, e: 1 },
    { opcode: 0x660FD1, e: 1 },
    { opcode: 0x0FD2, e: 1 },
    { opcode: 0x660FD2, e: 1 },
    { opcode: 0x0FD3, e: 1 },
    { opcode: 0x660FD3, e: 1 },
    { opcode: 0x0FD4, e: 1 },
    { opcode: 0x660FD4, e: 1 },
    { opcode: 0x0FD5, e: 1 },
    { opcode: 0x660FD5, e: 1 },

    { opcode: 0x660FD6, e: 1 },
    { opcode: 0xF20FD6, only_reg: 1, e: 1 },
    { opcode: 0xF30FD6, only_reg: 1, e: 1 },
    { opcode: 0x0FD7, e: 1, only_reg: 1 },
    { opcode: 0x660FD7, e: 1, only_reg: 1, },

    { opcode: 0x0FD8, e: 1 },
    { opcode: 0x660FD8, e: 1 },
    { opcode: 0x0FD9, e: 1 },
    { opcode: 0x660FD9, e: 1 },
    { opcode: 0x0FDA, e: 1 },
    { opcode: 0x660FDA, e: 1 },
    { opcode: 0x0FDB, e: 1 },
    { opcode: 0x660FDB, e: 1 },
    { opcode: 0x0FDC, e: 1 },
    { opcode: 0x660FDC, e: 1 },
    { opcode: 0x0FDD, e: 1 },
    { opcode: 0x660FDD, e: 1 },
    { opcode: 0x0FDE, e: 1 },
    { opcode: 0x660FDE, e: 1 },
    { opcode: 0x0FDF, e: 1 },
    { opcode: 0x660FDF, e: 1 },

    { opcode: 0x0FE0, e: 1 },
    { opcode: 0x660FE0, e: 1 },
    { opcode: 0x0FE1, e: 1 },
    { opcode: 0x660FE1, e: 1 },
    { opcode: 0x0FE2, e: 1 },
    { opcode: 0x660FE2, e: 1 },
    { opcode: 0x0FE3, e: 1 },
    { opcode: 0x660FE3, e: 1 },
    { opcode: 0x0FE4, e: 1 },
    { opcode: 0x660FE4, e: 1 },
    { opcode: 0x0FE5, e: 1 },
    { opcode: 0x660FE5, e: 1 },

    { opcode: 0x660FE6, e: 1, skip: 1, },
    { opcode: 0xF20FE6, e: 1, skip: 1, },
    { opcode: 0xF30FE6, e: 1, skip: 1, },
    { opcode: 0x0FE7, e: 1, only_mem: 1 },
    { opcode: 0x660FE7, e: 1, only_mem: 1, },

    { opcode: 0x0FE8, e: 1 },
    { opcode: 0x660FE8, e: 1 },
    { opcode: 0x0FE9, e: 1 },
    { opcode: 0x660FE9, e: 1 },
    { opcode: 0x0FEA, e: 1 },
    { opcode: 0x660FEA, e: 1 },
    { opcode: 0x0FEB, e: 1 },
    { opcode: 0x660FEB, e: 1 },
    { opcode: 0x0FEC, e: 1 },
    { opcode: 0x660FEC, e: 1 },
    { opcode: 0x0FED, e: 1 },
    { opcode: 0x660FED, e: 1 },
    { opcode: 0x0FEE, e: 1 },
    { opcode: 0x660FEE, e: 1 },
    { opcode: 0x0FEF, e: 1 },
    { opcode: 0x660FEF, e: 1 },

    { opcode: 0x0FF1, e: 1 },
    { opcode: 0x660FF1, e: 1 },
    { opcode: 0x0FF2, e: 1 },
    { opcode: 0x660FF2, e: 1 },
    { opcode: 0x0FF3, e: 1 },
    { opcode: 0x660FF3, e: 1, },
    { opcode: 0x0FF4, e: 1 },
    { opcode: 0x660FF4, e: 1 },
    { opcode: 0x0FF5, e: 1 },
    { opcode: 0x660FF5, e: 1 },
    { opcode: 0x0FF6, e: 1 },
    { opcode: 0x660FF6, e: 1 },
    // maskmovq (0FF7), maskmovdqu (660FF7) tested manually
    // Generated tests don't setup EDI as required (yet)
    { opcode: 0x0FF7, only_reg: 1, e: 1, skip: 1, },
    { opcode: 0x660FF7, only_reg: 1, e: 1, skip: 1, },

    { opcode: 0x0FF8, e: 1 },
    { opcode: 0x660FF8, e: 1 },
    { opcode: 0x0FF9, e: 1 },
    { opcode: 0x660FF9, e: 1 },
    { opcode: 0x0FFA, e: 1 },
    { opcode: 0x660FFA, e: 1 },
    { opcode: 0x0FFB, e: 1 },
    { opcode: 0x660FFB, e: 1 },
    { opcode: 0x0FFC, e: 1 },
    { opcode: 0x660FFC, e: 1 },
    { opcode: 0x0FFD, e: 1 },
    { opcode: 0x660FFD, e: 1 },
    { opcode: 0x0FFE, e: 1 },
    { opcode: 0x660FFE, e: 1 },
];

for(let i = 0; i < 8; i++)
{
    encodings.push.apply(encodings, [
        { opcode: 0x00 | i << 3, nonfaulting: 1, e: 1, },
        { opcode: 0x01 | i << 3, nonfaulting: 1, os: 1, e: 1, },
        { opcode: 0x02 | i << 3, nonfaulting: 1, e: 1, },
        { opcode: 0x03 | i << 3, nonfaulting: 1, os: 1, e: 1, },
        { opcode: 0x04 | i << 3, nonfaulting: 1, eax: 1, imm8: 1, },
        { opcode: 0x05 | i << 3, nonfaulting: 1, os: 1, eax: 1, imm1632: 1, },

        { opcode: 0x70 | i, block_boundary: 1, imm8s: 1, custom: 1, skip: 1, },
        { opcode: 0x78 | i, block_boundary: 1, imm8s: 1, custom: 1, skip: 1, },

        { opcode: 0x80, nonfaulting: 1, e: 1, fixed_g: i, imm8: 1, },
        { opcode: 0x81, nonfaulting: 1, os: 1, e: 1, fixed_g: i, imm1632: 1, },
        { opcode: 0x82, nonfaulting: 1, e: 1, fixed_g: i, imm8: 1, },
        { opcode: 0x83, nonfaulting: 1, os: 1, e: 1, fixed_g: i, imm8s: 1, },

        { opcode: 0xB0 | i, nonfaulting: 1, imm8: 1, },
        { opcode: 0xB8 | i, nonfaulting: 1, os: 1, imm1632: 1, },

        // note: overflow flag only undefined if shift is > 1
        // note: the adjust flag is undefined for shifts > 0 and unaffected by rotates
        { opcode: 0xC0, nonfaulting: 1, e: 1, fixed_g: i, imm8: 1, mask_flags: of | af, },
        { opcode: 0xC1, nonfaulting: 1, os: 1, e: 1, fixed_g: i, imm8: 1, mask_flags: of | af, },
        { opcode: 0xD0, nonfaulting: 1, e: 1, fixed_g: i, mask_flags: af, },
        { opcode: 0xD1, nonfaulting: 1, os: 1, e: 1, fixed_g: i, mask_flags: af, },
        { opcode: 0xD2, nonfaulting: 1, e: 1, fixed_g: i, mask_flags: of | af, },
        { opcode: 0xD3, nonfaulting: 1, os: 1, e: 1, fixed_g: i, mask_flags: of | af, },

        { opcode: 0xD8, e: 1, fixed_g: i, skip: 1, },
        { opcode: 0xD9, e: 1, fixed_g: i, skip: 1, },
        { opcode: 0xDA, e: 1, fixed_g: i, skip: 1, },
        { opcode: 0xDB, e: 1, fixed_g: i, skip: 1, },
        { opcode: 0xDC, e: 1, fixed_g: i, skip: 1, },
        { opcode: 0xDD, e: 1, fixed_g: i, skip: 1, },
        { opcode: 0xDE, e: 1, fixed_g: i, skip: 1, },
        { opcode: 0xDF, e: 1, fixed_g: i, skip: 1, },
    ]);
}

encodings.sort((e1, e2) => {
    let o1 = (e1.opcode & 0xFF00) === 0x0F00 ? e1.opcode & 0xFFFF : e1.opcode & 0xFF;
    let o2 = (e2.opcode & 0xFF00) === 0x0F00 ? e2.opcode & 0xFFFF : e2.opcode & 0xFF;
    return o1 - o2 || e1.fixed_g - e2.fixed_g;
});

module.exports = Object.freeze(encodings);
