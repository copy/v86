// http://ref.x86asm.net/coder32.html

const zf = 1 << 6;
const of = 1 << 11;
const cf = 1 << 0;
const af = 1 << 4;
const pf = 1 << 2;
const sf = 1 << 7;

// Test intel-specific behaviour
// Setting this to true can make some tests fail
const TESTS_ASSUME_INTEL = false;

// === Types of instructions
//
// create entry | check for compiled code | instruction
// -------------+-------------------------+-----------------------------------------------------------
//      1       |        optional         | pop ds (may change cpu state)
//              |                         | trigger_ud, div (exception that doesn't generate conditional return from BB)
//              |                         | port io, popf, sti (may call interrupt or continue at next instruction)
//              |                         | hlt
// -------------+-------------------------+-----------------------------------------------------------
//      1       |            1            | call [eax], jmp [eax], int, iret, ret, jmpf, callf, sysenter, sysexit
//              |                         | Special case: normal instruction with fallthough to next page
//              |                         | Special case: after execution of compiled code
//              |                         | -> may create redundant entry points depending on last instruction?
// -------------+-------------------------+-----------------------------------------------------------
//      1       |            0            | rep movs, rep lods, rep stos, rep cmps, rep scas
//              |                         | -> Executed as follows:
//              |                         |   - Upto including the first call in compiled mode
//              |                         |   - Back to main loop and repeated in interpreted mode (as entry point is after instruction, not on)
//              |                         |   - When finished entry pointer *after* instruction is hit and execution continues in compiled mode
// -------------+-------------------------+-----------------------------------------------------------
//      0       |        optional         | jmp foo, jnz foo
//              |                         | (foo is in the same page as the instruction)
// -------------+-------------------------+-----------------------------------------------------------
//      1       |            1            | call foo
//              |                         | (foo is in the same page as the instruction)
//              |                         | -> The entry point is not created for jumps within
//              |                         |    this page, but speculatively for calls from
//              |                         |    other pages to the function in this page
// -------------+-------------------------+-----------------------------------------------------------
//      1       |            1            | call foo, jmp foo, jnz foo
//              |                         | (foo is in a different page than the instruction)


// e: a modrm byte follows the operand
// os: the instruction behaves differently depending on the operand size
// fixed_g: the reg field of the modrm byte selects an instruction
// skip: skip automatically generated tests (nasmtests)
// mask_flags: flags bits to mask in generated tests
// prefix: is a prefix instruction
// imm8, imm8s, imm16, imm1632, immaddr, extra_imm8, extra_imm16: one or two immediate bytes follows the instruction
// custom: will callback jit to generate custom code
// block_boundary: may change eip in a way not handled by the jit
// no_next_instruction: jit will stop analysing after instruction (e.g., unconditional jump, ret)
const encodings = [
    { opcode: 0x06, os: 1, custom: 1 },
    { opcode: 0x07, os: 1, skip: 1, block_boundary: 1 }, // pop es: block_boundary since it uses non-raising cpu exceptions
    { opcode: 0x0E, os: 1, custom: 1 },
    { opcode: 0x0F, os: 1, prefix: 1 },
    { opcode: 0x16, os: 1, custom: 1 },
    { opcode: 0x17, block_boundary: 1, os: 1, skip: 1 }, // pop ss
    { opcode: 0x1E, os: 1, custom: 1 },
    { opcode: 0x1F, block_boundary: 1, os: 1, skip: 1 }, // pop ds
    { opcode: 0x26, prefix: 1 },
    { opcode: 0x27, mask_flags: of },
    { opcode: 0x2E, prefix: 1 },
    { opcode: 0x2F, mask_flags: of },
    { opcode: 0x36, prefix: 1 },
    { opcode: 0x37, mask_flags: of | sf | pf | zf },
    { opcode: 0x3E, prefix: 1 },
    { opcode: 0x3F, mask_flags: of | sf | pf | zf },

    { opcode: 0x60, os: 1, block_boundary: 1 }, // pusha
    { opcode: 0x61, os: 1, block_boundary: 1 }, // popa
    { opcode: 0x62, e: 1, skip: 1 },
    { opcode: 0x63, e: 1, block_boundary: 1 }, // arpl
    { opcode: 0x64, prefix: 1 },
    { opcode: 0x65, prefix: 1 },
    { opcode: 0x66, prefix: 1 },
    { opcode: 0x67, prefix: 1 },

    { opcode: 0x68, custom: 1, os: 1, imm1632: 1 },
    { opcode: 0x69, os: 1, e: 1, custom: 1, imm1632: 1, mask_flags: TESTS_ASSUME_INTEL ? af : sf | zf | af | pf },
    { opcode: 0x6A, custom: 1, os: 1, imm8s: 1 },
    { opcode: 0x6B, os: 1, e: 1, custom: 1, imm8s: 1, mask_flags: TESTS_ASSUME_INTEL ? af : sf | zf | af | pf },

    { opcode: 0x6C, block_boundary: 1, custom: 1, is_string: 1, skip: 1 },          // ins
    { opcode: 0xF26C, block_boundary: 1, custom: 1, is_string: 1, skip: 1 },
    { opcode: 0xF36C, block_boundary: 1, custom: 1, is_string: 1, skip: 1 },
    { opcode: 0x6D, block_boundary: 1, custom: 1, is_string: 1, os: 1, skip: 1 },
    { opcode: 0xF26D, block_boundary: 1, custom: 1, is_string: 1, os: 1, skip: 1 },
    { opcode: 0xF36D, block_boundary: 1, custom: 1, is_string: 1, os: 1, skip: 1 },

    { opcode: 0x6E, block_boundary: 1, custom: 1, is_string: 1, skip: 1 },          // outs
    { opcode: 0xF26E, block_boundary: 1, custom: 1, is_string: 1, skip: 1 },
    { opcode: 0xF36E, block_boundary: 1, custom: 1, is_string: 1, skip: 1 },
    { opcode: 0x6F, block_boundary: 1, custom: 1, is_string: 1, os: 1, skip: 1 },
    { opcode: 0xF26F, block_boundary: 1, custom: 1, is_string: 1, os: 1, skip: 1 },
    { opcode: 0xF36F, block_boundary: 1, custom: 1, is_string: 1, os: 1, skip: 1 },

    { opcode: 0x84, custom: 1, e: 1 },
    { opcode: 0x85, custom: 1, e: 1, os: 1 },
    { opcode: 0x86, custom: 1, e: 1 },
    { opcode: 0x87, custom: 1, os: 1, e: 1 },
    { opcode: 0x88, custom: 1, e: 1 },
    { opcode: 0x89, custom: 1, os: 1, e: 1 },
    { opcode: 0x8A, custom: 1, e: 1 },
    { opcode: 0x8B, custom: 1, os: 1, e: 1 },

    { opcode: 0x8C, os: 1, e: 1, custom: 1, skip: 1 }, // mov reg, sreg
    { opcode: 0x8D, reg_ud: 1, os: 1, e: 1, custom_modrm_resolve: 1, custom: 1 }, // lea
    { opcode: 0x8E, block_boundary: 1, e: 1, skip: 1 }, // mov sreg
    { opcode: 0x8F, os: 1, e: 1, fixed_g: 0, custom_modrm_resolve: 1, custom: 1, block_boundary: 1 }, // pop r/m

    { opcode: 0x90, custom: 1 },
    { opcode: 0x91, custom: 1, os: 1 },
    { opcode: 0x92, custom: 1, os: 1 },
    { opcode: 0x93, custom: 1, os: 1 },
    { opcode: 0x94, custom: 1, os: 1 },
    { opcode: 0x95, custom: 1, os: 1 },
    { opcode: 0x96, custom: 1, os: 1 },
    { opcode: 0x97, custom: 1, os: 1 },

    { opcode: 0x98, os: 1, custom: 1 },
    { opcode: 0x99, os: 1, custom: 1 },
    { opcode: 0x9A, os: 1, imm1632: 1, extra_imm16: 1, skip: 1, block_boundary: 1 }, // callf
    { opcode: 0x9B, block_boundary: 1, skip: 1 }, // fwait: block_boundary since it uses non-raising cpu exceptions
    { opcode: 0x9C, os: 1, custom: 1, skip: 1 }, // pushf
    { opcode: 0x9D, os: 1, custom: 1, skip: 1 }, // popf
    { opcode: 0x9E, custom: 1 },
    { opcode: 0x9F, custom: 1 },

    { opcode: 0xA0, custom: 1, immaddr: 1 },
    { opcode: 0xA1, custom: 1, os: 1, immaddr: 1 },
    { opcode: 0xA2, custom: 1, immaddr: 1 },
    { opcode: 0xA3, custom: 1, os: 1, immaddr: 1 },

    // string instructions aren't jumps, but they modify eip due to how they're implemented
    { opcode: 0xA4, block_boundary: 0, custom: 1, is_string: 1 },
    { opcode: 0xF2A4, block_boundary: 1, custom: 1, is_string: 1 },
    { opcode: 0xF3A4, block_boundary: 1, custom: 1, is_string: 1 },
    { opcode: 0xA5, block_boundary: 0, custom: 1, is_string: 1, os: 1 },
    { opcode: 0xF2A5, block_boundary: 1, custom: 1, is_string: 1, os: 1 },
    { opcode: 0xF3A5, block_boundary: 1, custom: 1, is_string: 1, os: 1 },

    { opcode: 0xA6, block_boundary: 1, custom: 1, is_string: 1 },
    { opcode: 0xF2A6, block_boundary: 1, custom: 1, is_string: 1 },
    { opcode: 0xF3A6, block_boundary: 1, custom: 1, is_string: 1 },
    { opcode: 0xA7, block_boundary: 1, custom: 1, is_string: 1, os: 1 },
    { opcode: 0xF2A7, block_boundary: 1, custom: 1, is_string: 1, os: 1 },
    { opcode: 0xF3A7, block_boundary: 1, custom: 1, is_string: 1, os: 1 },

    { opcode: 0xA8, custom: 1, imm8: 1 },
    { opcode: 0xA9, custom: 1, os: 1, imm1632: 1 },

    { opcode: 0xAA, block_boundary: 0, custom: 1, is_string: 1 },
    { opcode: 0xF2AA, block_boundary: 1, custom: 1, is_string: 1 },
    { opcode: 0xF3AA, block_boundary: 1, custom: 1, is_string: 1 },
    { opcode: 0xAB, block_boundary: 0, custom: 1, is_string: 1, os: 1 },
    { opcode: 0xF2AB, block_boundary: 1, custom: 1, is_string: 1, os: 1 },
    { opcode: 0xF3AB, block_boundary: 1, custom: 1, is_string: 1, os: 1 },

    { opcode: 0xAC, block_boundary: 0, custom: 1, is_string: 1 },
    { opcode: 0xF2AC, block_boundary: 1, custom: 1, is_string: 1 },
    { opcode: 0xF3AC, block_boundary: 1, custom: 1, is_string: 1 },
    { opcode: 0xAD, block_boundary: 0, custom: 1, is_string: 1, os: 1 },
    { opcode: 0xF2AD, block_boundary: 1, custom: 1, is_string: 1, os: 1 },
    { opcode: 0xF3AD, block_boundary: 1, custom: 1, is_string: 1, os: 1 },

    { opcode: 0xAE, block_boundary: 0, custom: 1, is_string: 1 },
    { opcode: 0xF2AE, block_boundary: 1, custom: 1, is_string: 1 },
    { opcode: 0xF3AE, block_boundary: 1, custom: 1, is_string: 1 },
    { opcode: 0xAF, block_boundary: 0, custom: 1, is_string: 1, os: 1 },
    { opcode: 0xF2AF, block_boundary: 1, custom: 1, is_string: 1, os: 1 },
    { opcode: 0xF3AF, block_boundary: 1, custom: 1, is_string: 1, os: 1 },

    { opcode: 0xC2, custom: 1, block_boundary: 1, no_next_instruction: 1, os: 1, absolute_jump: 1, imm16: 1, skip: 1 }, // ret
    { opcode: 0xC3, custom: 1, block_boundary: 1, no_next_instruction: 1, os: 1, absolute_jump: 1, skip: 1 },

    { opcode: 0xC4, block_boundary: 1, os: 1, e: 1, skip: 1 }, // les
    { opcode: 0xC5, block_boundary: 1, os: 1, e: 1, skip: 1 }, // lds

    { opcode: 0xC6, custom: 1, e: 1, fixed_g: 0, imm8: 1 },
    { opcode: 0xC7, custom: 1, os: 1, e: 1, fixed_g: 0, imm1632: 1 },

    // XXX: Temporary block boundary
    { opcode: 0xC8, os: 1, imm16: 1, extra_imm8: 1, block_boundary: 1 }, // enter
    { opcode: 0xC9, custom: 1, os: 1, skip: 1 }, // leave

    { opcode: 0xCA, block_boundary: 1, no_next_instruction: 1, os: 1, imm16: 1, skip: 1 }, // retf
    { opcode: 0xCB, block_boundary: 1, no_next_instruction: 1, os: 1, skip: 1 },
    { opcode: 0xCC, block_boundary: 1, skip: 1 }, // int
    { opcode: 0xCD, block_boundary: 1, skip: 1, imm8: 1 },
    { opcode: 0xCE, block_boundary: 1, skip: 1 },
    { opcode: 0xCF, block_boundary: 1, no_next_instruction: 1, os: 1, skip: 1 }, // iret

    { opcode: 0xD4, imm8: 1, block_boundary: 1 }, // aam, may trigger #de
    { opcode: 0xD5, imm8: 1, mask_flags: of | cf | af },
    { opcode: 0xD6 },

    { opcode: 0xD7, skip: 1, custom: 1 },

    { opcode: 0xD8, e: 1, fixed_g: 0, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xD8, e: 1, fixed_g: 1, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xD8, e: 1, fixed_g: 2, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xD8, e: 1, fixed_g: 3, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xD8, e: 1, fixed_g: 4, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xD8, e: 1, fixed_g: 5, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xD8, e: 1, fixed_g: 6, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xD8, e: 1, fixed_g: 7, custom: 1, is_fpu: 1, task_switch_test: 1 },

    { opcode: 0xD9, e: 1, fixed_g: 0, custom: 1, is_fpu: 1, task_switch_test: 1, os: 1 },
    { opcode: 0xD9, e: 1, fixed_g: 1, custom: 1, is_fpu: 1, task_switch_test: 1, os: 1 },
    { opcode: 0xD9, e: 1, fixed_g: 2, custom: 1, is_fpu: 1, task_switch_test: 1, os: 1 },
    { opcode: 0xD9, e: 1, fixed_g: 3, custom: 1, is_fpu: 1, task_switch_test: 1, os: 1 },
    { opcode: 0xD9, e: 1, fixed_g: 4, custom: 1, is_fpu: 1, task_switch_test: 1, os: 1, skip_mem: 1 }, // fldenv (mem)
    { opcode: 0xD9, e: 1, fixed_g: 5, custom: 1, is_fpu: 1, task_switch_test: 1, os: 1 },
    { opcode: 0xD9, e: 1, fixed_g: 6, custom: 1, is_fpu: 1, task_switch_test: 1, os: 1, skip: 1 }, // fstenv (mem), fprem (reg)
    { opcode: 0xD9, e: 1, fixed_g: 7, custom: 1, is_fpu: 1, task_switch_test: 1, os: 1, skip_reg: 1 }, // fprem, fyl2xp1 (precision issues)

    { opcode: 0xDA, e: 1, fixed_g: 0, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xDA, e: 1, fixed_g: 1, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xDA, e: 1, fixed_g: 2, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xDA, e: 1, fixed_g: 3, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xDA, e: 1, fixed_g: 4, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xDA, e: 1, fixed_g: 5, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xDA, e: 1, fixed_g: 6, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xDA, e: 1, fixed_g: 7, custom: 1, is_fpu: 1, task_switch_test: 1 },

    { opcode: 0xDB, e: 1, fixed_g: 0, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xDB, e: 1, fixed_g: 1, custom: 1, is_fpu: 1, task_switch_test: 1 }, // fisttp (sse3)
    { opcode: 0xDB, e: 1, fixed_g: 2, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xDB, e: 1, fixed_g: 3, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xDB, e: 1, fixed_g: 4, custom: 0, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xDB, e: 1, fixed_g: 5, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xDB, e: 1, fixed_g: 6, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xDB, e: 1, fixed_g: 7, custom: 0, is_fpu: 1, task_switch_test: 1 },

    { opcode: 0xDC, e: 1, fixed_g: 0, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xDC, e: 1, fixed_g: 1, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xDC, e: 1, fixed_g: 2, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xDC, e: 1, fixed_g: 3, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xDC, e: 1, fixed_g: 4, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xDC, e: 1, fixed_g: 5, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xDC, e: 1, fixed_g: 6, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xDC, e: 1, fixed_g: 7, custom: 1, is_fpu: 1, task_switch_test: 1 },

    { opcode: 0xDD, e: 1, fixed_g: 0, custom: 1, is_fpu: 1, task_switch_test: 1, os: 1 },
    { opcode: 0xDD, e: 1, fixed_g: 1, custom: 1, is_fpu: 1, task_switch_test: 1, os: 1 }, // fisttp (sse3)
    { opcode: 0xDD, e: 1, fixed_g: 2, custom: 1, is_fpu: 1, task_switch_test: 1, os: 1 },
    { opcode: 0xDD, e: 1, fixed_g: 3, custom: 1, is_fpu: 1, task_switch_test: 1, os: 1 },
    { opcode: 0xDD, e: 1, fixed_g: 4, custom: 0, is_fpu: 1, task_switch_test: 1, os: 1, skip_mem: 1 }, // frstor
    { opcode: 0xDD, e: 1, fixed_g: 5, custom: 1, is_fpu: 1, task_switch_test: 1, os: 1 },
    { opcode: 0xDD, e: 1, fixed_g: 6, custom: 0, is_fpu: 1, task_switch_test: 1, os: 1, skip_mem: 1 }, // fsave
    { opcode: 0xDD, e: 1, fixed_g: 7, custom: 0, is_fpu: 1, task_switch_test: 1, os: 1, skip_mem: 1 }, // fstsw (denormal flag)

    { opcode: 0xDE, e: 1, fixed_g: 0, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xDE, e: 1, fixed_g: 1, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xDE, e: 1, fixed_g: 2, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xDE, e: 1, fixed_g: 3, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xDE, e: 1, fixed_g: 4, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xDE, e: 1, fixed_g: 5, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xDE, e: 1, fixed_g: 6, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xDE, e: 1, fixed_g: 7, custom: 1, is_fpu: 1, task_switch_test: 1 },

    { opcode: 0xDF, e: 1, fixed_g: 0, custom: 0, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xDF, e: 1, fixed_g: 1, custom: 1, is_fpu: 1, task_switch_test: 1 }, // fisttp (sse3)
    { opcode: 0xDF, e: 1, fixed_g: 2, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xDF, e: 1, fixed_g: 3, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xDF, e: 1, fixed_g: 4, custom: 1, is_fpu: 1, task_switch_test: 1, skip: 1 }, // unimplemented: Binary Coded Decimals / fsts (denormal flag)
    { opcode: 0xDF, e: 1, fixed_g: 5, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xDF, e: 1, fixed_g: 6, custom: 1, is_fpu: 1, task_switch_test: 1 },
    { opcode: 0xDF, e: 1, fixed_g: 7, custom: 1, is_fpu: 1, task_switch_test: 1 },

    // loop, jcxz, etc.
    { opcode: 0xE0, os: 1, imm8s: 1, no_block_boundary_in_interpreted: 1, skip: 1, block_boundary: 1, jump_offset_imm: 1, custom: 1, conditional_jump: 1 },
    { opcode: 0xE1, os: 1, imm8s: 1, no_block_boundary_in_interpreted: 1, skip: 1, block_boundary: 1, jump_offset_imm: 1, custom: 1, conditional_jump: 1 },
    { opcode: 0xE2, os: 1, imm8s: 1, no_block_boundary_in_interpreted: 1, skip: 1, block_boundary: 1, jump_offset_imm: 1, custom: 1, conditional_jump: 1 },
    { opcode: 0xE3, os: 1, imm8s: 1, no_block_boundary_in_interpreted: 1, skip: 1, block_boundary: 1, jump_offset_imm: 1, custom: 1, conditional_jump: 1 },

    // port functions aren't jumps, but they may modify eip due to how they are implemented
    { opcode: 0xE4, block_boundary: 1, imm8: 1, skip: 1 }, // in
    { opcode: 0xE5, block_boundary: 1, os: 1, imm8: 1, skip: 1 },
    { opcode: 0xE6, block_boundary: 1, imm8: 1, skip: 1 }, // out
    { opcode: 0xE7, block_boundary: 1, os: 1, imm8: 1, skip: 1 },

    { opcode: 0xE8, block_boundary: 1, jump_offset_imm: 1, os: 1, imm1632: 1, custom: 1, skip: 1 }, // call
    { opcode: 0xE9, block_boundary: 1, no_block_boundary_in_interpreted: 1, jump_offset_imm: 1, no_next_instruction: 1, os: 1, imm1632: 1, custom: 1, skip: 1 },
    { opcode: 0xEA, block_boundary: 1, no_next_instruction: 1, os: 1, imm1632: 1, extra_imm16: 1, skip: 1 }, // jmpf
    { opcode: 0xEB, block_boundary: 1, no_block_boundary_in_interpreted: 1, jump_offset_imm: 1, no_next_instruction: 1, os: 1, imm8s: 1, custom: 1, skip: 1 },

    { opcode: 0xEC, block_boundary: 1, skip: 1 }, // in
    { opcode: 0xED, block_boundary: 1, os: 1, skip: 1 },
    { opcode: 0xEE, block_boundary: 1, skip: 1 }, // out
    { opcode: 0xEF, block_boundary: 1, os: 1, skip: 1 },

    { opcode: 0xF0, prefix: 1 },
    { opcode: 0xF1, skip: 1 },
    { opcode: 0xF2, prefix: 1 },
    { opcode: 0xF3, prefix: 1 },
    { opcode: 0xF4, block_boundary: 1, no_next_instruction: 1, skip: 1 }, // hlt
    { opcode: 0xF5 },

    { opcode: 0xF6, e: 1, fixed_g: 0, imm8: 1, custom: 1 },
    { opcode: 0xF6, e: 1, fixed_g: 1, imm8: 1, custom: 1 },
    { opcode: 0xF6, e: 1, fixed_g: 2, custom: 1 },
    { opcode: 0xF6, e: 1, fixed_g: 3, custom: 1 },
    { opcode: 0xF6, e: 1, fixed_g: 4, mask_flags: TESTS_ASSUME_INTEL ? af | zf : sf | zf | af | pf },
    { opcode: 0xF6, e: 1, fixed_g: 5, mask_flags: TESTS_ASSUME_INTEL ? af | zf : sf | zf | af | pf },
    // div/idiv: Not a block boundary, but doesn't use control flow exceptions
    { opcode: 0xF6, e: 1, fixed_g: 6, mask_flags: TESTS_ASSUME_INTEL ? 0 : sf | zf | af | pf, block_boundary: 1 },
    { opcode: 0xF6, e: 1, fixed_g: 7, mask_flags: TESTS_ASSUME_INTEL ? 0 : sf | zf | af | pf, block_boundary: 1 },

    { opcode: 0xF7, os: 1, e: 1, fixed_g: 0, imm1632: 1, custom: 1 },
    { opcode: 0xF7, os: 1, e: 1, fixed_g: 1, imm1632: 1, custom: 1 },
    { opcode: 0xF7, os: 1, e: 1, fixed_g: 2, custom: 1 },
    { opcode: 0xF7, os: 1, e: 1, fixed_g: 3, custom: 1 },
    { opcode: 0xF7, os: 1, e: 1, fixed_g: 4, mask_flags: TESTS_ASSUME_INTEL ? af | zf : sf | zf | af | pf, custom: 1 },
    { opcode: 0xF7, os: 1, e: 1, fixed_g: 5, mask_flags: TESTS_ASSUME_INTEL ? af | zf : sf | zf | af | pf, custom: 1 },
    { opcode: 0xF7, os: 1, e: 1, fixed_g: 6, mask_flags: TESTS_ASSUME_INTEL ? 0 : sf | zf | af | pf, custom: 1 },
    { opcode: 0xF7, os: 1, e: 1, fixed_g: 7, mask_flags: TESTS_ASSUME_INTEL ? 0 : sf | zf | af | pf, custom: 1 },

    { opcode: 0xF8, custom: 1 },
    { opcode: 0xF9, custom: 1 },
    { opcode: 0xFA, custom: 1, skip: 1 },
    // STI: Note: Has special handling in jit in order to call handle_irqs safely
    { opcode: 0xFB, custom: 1, custom_sti: 1, skip: 1 },
    { opcode: 0xFC, custom: 1 },
    { opcode: 0xFD, custom: 1 },

    { opcode: 0xFE, e: 1, fixed_g: 0, custom: 1 },
    { opcode: 0xFE, e: 1, fixed_g: 1, custom: 1 },
    { opcode: 0xFF, os: 1, e: 1, fixed_g: 0, custom: 1 },
    { opcode: 0xFF, os: 1, e: 1, fixed_g: 1, custom: 1 },
    { opcode: 0xFF, os: 1, e: 1, fixed_g: 2, custom: 1, block_boundary: 1, absolute_jump: 1, skip: 1 },
    { opcode: 0xFF, os: 1, e: 1, fixed_g: 3, block_boundary: 1, skip: 1 },
    { opcode: 0xFF, os: 1, e: 1, fixed_g: 4, custom: 1, block_boundary: 1, absolute_jump: 1, no_next_instruction: 1, skip: 1 },
    { opcode: 0xFF, os: 1, e: 1, fixed_g: 5, block_boundary: 1, no_next_instruction: 1, skip: 1 },
    { opcode: 0xFF, custom: 1, os: 1, e: 1, fixed_g: 6 },

    { opcode: 0x0F00, fixed_g: 0, e: 1, skip: 1, block_boundary: 1, os: 1 }, // sldt, ...
    { opcode: 0x0F00, fixed_g: 1, e: 1, skip: 1, block_boundary: 1, os: 1 },
    { opcode: 0x0F00, fixed_g: 2, e: 1, skip: 1, block_boundary: 1, os: 1 },
    { opcode: 0x0F00, fixed_g: 3, e: 1, skip: 1, block_boundary: 1, os: 1 },
    { opcode: 0x0F00, fixed_g: 4, e: 1, skip: 1, block_boundary: 1, os: 1 },
    { opcode: 0x0F00, fixed_g: 5, e: 1, skip: 1, block_boundary: 1, os: 1 },

    { opcode: 0x0F01, fixed_g: 0, e: 1, skip: 1, block_boundary: 1, os: 1 }, // sgdt, ...
    { opcode: 0x0F01, fixed_g: 1, e: 1, skip: 1, block_boundary: 1, os: 1 },
    { opcode: 0x0F01, fixed_g: 2, e: 1, skip: 1, block_boundary: 1, os: 1 },
    { opcode: 0x0F01, fixed_g: 3, e: 1, skip: 1, block_boundary: 1, os: 1 },
    { opcode: 0x0F01, fixed_g: 4, e: 1, skip: 1, block_boundary: 1, os: 1 },
    { opcode: 0x0F01, fixed_g: 6, e: 1, skip: 1, block_boundary: 1, os: 1 },
    { opcode: 0x0F01, fixed_g: 7, e: 1, skip: 1, block_boundary: 1, os: 1 },

    { opcode: 0x0F02, os: 1, e: 1, skip: 1, block_boundary: 1 }, // lar
    { opcode: 0x0F03, os: 1, e: 1, skip: 1, block_boundary: 1 }, // lsl
    { opcode: 0x0F04, skip: 1, block_boundary: 1 },
    { opcode: 0x0F05, skip: 1, block_boundary: 1 },
    { opcode: 0x0F06, skip: 1, block_boundary: 1 }, // clts
    { opcode: 0x0F07, skip: 1, block_boundary: 1 },
    { opcode: 0x0F08, skip: 1, block_boundary: 1 },
    { opcode: 0x0F09, skip: 1, block_boundary: 1 }, // wbinvd
    { opcode: 0x0F0A, skip: 1, block_boundary: 1 },
    // ud2
    // Technically has a next instruction, but Linux uses this for assertions
    // and embeds the assertion message after this instruction, which is likely
    // the most common use case of ud2
    { opcode: 0x0F0B, skip: 1, block_boundary: 1, custom: 1, no_next_instruction: 1 },
    { opcode: 0x0F0C, skip: 1, block_boundary: 1 },
    { opcode: 0x0F0D, skip: 1, block_boundary: 1 },
    { opcode: 0x0F0E, skip: 1, block_boundary: 1 },
    { opcode: 0x0F0F, skip: 1, block_boundary: 1 },

    { opcode: 0x0F18, e: 1, custom: 1 },
    { opcode: 0x0F19, custom: 1, e: 1 },
    { opcode: 0x0F1A, skip: 1, block_boundary: 1 },
    { opcode: 0x0F1B, skip: 1, block_boundary: 1 },
    { opcode: 0x0F1C, custom: 1, e: 1 },
    { opcode: 0x0F1D, custom: 1, e: 1 },
    { opcode: 0x0F1E, custom: 1, e: 1 },
    { opcode: 0x0F1F, custom: 1, e: 1 },

    { opcode: 0x0F20, ignore_mod: 1, e: 1, skip: 1, block_boundary: 1 }, // mov reg, creg
    { opcode: 0x0F21, ignore_mod: 1, e: 1, skip: 1, block_boundary: 1 }, // mov reg, dreg
    { opcode: 0x0F22, ignore_mod: 1, e: 1, skip: 1, block_boundary: 1 }, // mov creg, reg
    { opcode: 0x0F23, ignore_mod: 1, e: 1, skip: 1, block_boundary: 1 }, // mov dreg, reg
    { opcode: 0x0F24, skip: 1, block_boundary: 1 },
    { opcode: 0x0F25, skip: 1, block_boundary: 1 },
    { opcode: 0x0F26, skip: 1, block_boundary: 1 },
    { opcode: 0x0F27, skip: 1, block_boundary: 1 },

    { opcode: 0x0F30, skip: 1, block_boundary: 1 }, // wrmsr
    { opcode: 0x0F31, skip: 1, custom: 1 }, // rdtsc
    { opcode: 0x0F32, skip: 1, block_boundary: 1 }, // rdmsr
    { opcode: 0x0F33, skip: 1, block_boundary: 1 }, // rdpmc
    { opcode: 0x0F34, skip: 1, block_boundary: 1, no_next_instruction: 1 }, // sysenter
    { opcode: 0x0F35, skip: 1, block_boundary: 1, no_next_instruction: 1 }, // sysexit

    { opcode: 0x0F36, skip: 1, block_boundary: 1 }, // ud
    { opcode: 0x0F37, skip: 1, block_boundary: 1 }, // getsec

    // ssse3+
    { opcode: 0x0F38, skip: 1, block_boundary: 1 },
    { opcode: 0x0F39, skip: 1, block_boundary: 1 },
    { opcode: 0x0F3A, skip: 1, block_boundary: 1 },
    { opcode: 0x0F3B, skip: 1, block_boundary: 1 },
    { opcode: 0x0F3C, skip: 1, block_boundary: 1 },
    { opcode: 0x0F3D, skip: 1, block_boundary: 1 },
    { opcode: 0x0F3E, skip: 1, block_boundary: 1 },
    { opcode: 0x0F3F, skip: 1, block_boundary: 1 },

    { opcode: 0x0FA0, os: 1, custom: 1 },
    { opcode: 0x0FA1, os: 1, block_boundary: 1, skip: 1 }, // pop fs: block_boundary since it uses non-raising cpu exceptions

    { opcode: 0x0FA2, skip: 1 },

    { opcode: 0x0FA8, os: 1, custom: 1 },
    { opcode: 0x0FA9, os: 1, block_boundary: 1, skip: 1 }, // pop gs

    { opcode: 0x0FA3, os: 1, e: 1, custom: 1, skip_mem: 1 }, // bt (can also index memory, but not supported by test right now)
    { opcode: 0x0FAB, os: 1, e: 1, custom: 1, skip_mem: 1 },
    { opcode: 0x0FB3, os: 1, e: 1, custom: 1, skip_mem: 1 },
    { opcode: 0x0FBB, os: 1, e: 1, custom: 1, skip_mem: 1 },

    { opcode: 0x0FBA, os: 1, e: 1, fixed_g: 4, imm8: 1, custom: 1 }, // bt
    { opcode: 0x0FBA, os: 1, e: 1, fixed_g: 5, imm8: 1, custom: 1 },
    { opcode: 0x0FBA, os: 1, e: 1, fixed_g: 6, imm8: 1, custom: 1 },
    { opcode: 0x0FBA, os: 1, e: 1, fixed_g: 7, imm8: 1, custom: 1 },

    { opcode: 0x0FBC, os: 1, e: 1, mask_flags: of | sf | af | pf | cf, custom: 1 }, // bsf
    { opcode: 0x0FBD, os: 1, e: 1, mask_flags: of | sf | af | pf | cf, custom: 1 },

    // note: overflow flag only undefined if shift is > 1
    { opcode: 0x0FA4, os: 1, e: 1, custom: 1, imm8: 1, mask_flags: af | of }, // shld
    { opcode: 0x0FA5, os: 1, e: 1, custom: 1, mask_flags: af | of },
    { opcode: 0x0FAC, os: 1, e: 1, custom: 1, imm8: 1, mask_flags: af | of },
    { opcode: 0x0FAD, os: 1, e: 1, custom: 1, mask_flags: af | of },

    { opcode: 0x0FA6, skip: 1, block_boundary: 1 }, // ud
    { opcode: 0x0FA7, skip: 1, block_boundary: 1 }, // ud

    { opcode: 0x0FAA, skip: 1 },

    { opcode: 0x0FAE, e: 1, fixed_g: 0, reg_ud: 1, task_switch_test: 1, skip: 1, block_boundary: 1 }, // fxsave
    { opcode: 0x0FAE, e: 1, fixed_g: 1, reg_ud: 1, task_switch_test: 1, skip: 1, block_boundary: 1 }, // fxrstor
    { opcode: 0x0FAE, e: 1, fixed_g: 2, reg_ud: 1, sse: 1, skip: 1, block_boundary: 1 }, // ldmxcsr
    { opcode: 0x0FAE, e: 1, fixed_g: 3, reg_ud: 1, sse: 1, skip: 1, block_boundary: 1 }, // stmxcsr

    { opcode: 0x0FAE, e: 1, fixed_g: 4, reg_ud: 1, skip: 1, block_boundary: 1 }, // xsave (mem, not implemented)
    { opcode: 0x0FAE, e: 1, fixed_g: 5, skip: 1, custom: 1 }, // lfence (reg, only 0), xrstor (mem, not implemented)
    { opcode: 0x0FAE, e: 1, fixed_g: 6, skip: 1, block_boundary: 1 }, // mfence (reg, only 0), xsaveopt (mem, not implemented)
    { opcode: 0x0FAE, e: 1, fixed_g: 7, skip: 1, block_boundary: 1 }, // sfence (reg, only 0), clflush (mem)

    { opcode: 0x0FAF, os: 1, e: 1, mask_flags: TESTS_ASSUME_INTEL ? af | zf : sf | zf | af | pf, custom: 1 }, // imul

    { opcode: 0x0FB0, e: 1 }, // cmxchg
    { opcode: 0x0FB1, os: 1, e: 1, custom: 1 },
    { opcode: 0x0FC7, e: 1, fixed_g: 1, os: 1, reg_ud: 1, custom: 1 }, // cmpxchg8b (memory)
    { opcode: 0x0FC7, e: 1, fixed_g: 6, os: 1, mem_ud: 1, skip: 1 }, // rdrand

    { opcode: 0x0FB2, block_boundary: 1, os: 1, e: 1, skip: 1 }, // lss
    { opcode: 0x0FB4, block_boundary: 1, os: 1, e: 1, skip: 1 }, // lfs
    { opcode: 0x0FB5, block_boundary: 1, os: 1, e: 1, skip: 1 }, // lgs

    { opcode: 0x0FB6, os: 1, e: 1, custom: 1 }, // movzx
    { opcode: 0x0FB7, os: 1, e: 1, custom: 1 },

    { opcode: 0xF30FB8, os: 1, e: 1, custom: 1 }, // popcnt
    { opcode: 0x0FB8, os: 1, e: 1, block_boundary: 1 }, // ud

    { opcode: 0x0FB9, block_boundary: 1 }, // ud2

    { opcode: 0x0FBE, os: 1, e: 1, custom: 1 }, // movsx
    { opcode: 0x0FBF, os: 1, e: 1, custom: 1 },

    { opcode: 0x0FC0, e: 1 }, // xadd
    { opcode: 0x0FC1, os: 1, e: 1, custom: 1 },

    { opcode: 0x0FC8, custom: 1 }, // bswap
    { opcode: 0x0FC9, custom: 1 },
    { opcode: 0x0FCA, custom: 1 },
    { opcode: 0x0FCB, custom: 1 },
    { opcode: 0x0FCC, custom: 1 },
    { opcode: 0x0FCD, custom: 1 },
    { opcode: 0x0FCE, custom: 1 },
    { opcode: 0x0FCF, custom: 1 },


    // mmx, sse

    { sse: 1, opcode: 0x0F10, e: 1, custom: 1 },
    { sse: 1, opcode: 0xF30F10, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F10, e: 1, custom: 1 },
    { sse: 1, opcode: 0xF20F10, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F11, e: 1, custom: 1 },
    { sse: 1, opcode: 0xF30F11, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F11, e: 1, custom: 1 },
    { sse: 1, opcode: 0xF20F11, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F12, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F12, reg_ud: 1, e: 1, custom: 1 },
    { sse: 1, opcode: 0xF20F12, e: 1, custom: 1 }, // sse3
    { sse: 1, opcode: 0xF30F12, e: 1, custom: 1 }, // sse3
    { sse: 1, opcode: 0x0F13, reg_ud: 1, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F13, reg_ud: 1, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F14, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F14, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F15, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F15, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F16, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F16, reg_ud: 1, e: 1, custom: 1 },
    { sse: 1, opcode: 0xF30F16,  e: 1, custom: 1 }, // sse3
    { sse: 1, opcode: 0x0F17, reg_ud: 1, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F17, reg_ud: 1, e: 1, custom: 1 },

    { sse: 1, opcode: 0x0F28, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F28, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F29, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F29, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F2A, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F2A, e: 1, custom: 1 },
    { sse: 1, opcode: 0xF20F2A, e: 1, custom: 1 },
    { sse: 1, opcode: 0xF30F2A, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F2B, reg_ud: 1, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F2B, reg_ud: 1, e: 1, custom: 1 },

    { sse: 1, opcode: 0x0F2C, e: 1 },
    { sse: 1, opcode: 0x660F2C, e: 1 },
    { sse: 1, opcode: 0xF20F2C, e: 1, custom: 1 },
    { sse: 1, opcode: 0xF30F2C, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F2D, e: 1 },
    { sse: 1, opcode: 0x660F2D, e: 1 },
    { sse: 1, opcode: 0xF20F2D, e: 1, custom: 1 },
    { sse: 1, opcode: 0xF30F2D, e: 1, custom: 1 },

    { sse: 1, opcode: 0x0F2E, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F2E, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F2F, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F2F, e: 1, custom: 1 },

    { sse: 1, opcode: 0x0F50, mem_ud: 1, e: 1 },
    { sse: 1, opcode: 0x660F50, mem_ud: 1, e: 1 },
    { sse: 1, opcode: 0x0F51, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F51, e: 1, custom: 1 },
    { sse: 1, opcode: 0xF20F51, e: 1, custom: 1 },
    { sse: 1, opcode: 0xF30F51, e: 1, custom: 1 },

    // approximation of 1/sqrt(x). Skipped because our approximation doesn't match intel's
    { sse: 1, opcode: 0x0F52, e: 1, skip: 1, custom: 1 },
    { sse: 1, opcode: 0xF30F52, e: 1, skip: 1, custom: 1 },

    // reciprocal: approximation of 1/x. Skipped because our approximation doesn't match intel's
    { sse: 1, opcode: 0x0F53, e: 1, skip: 1, custom: 1 },
    { sse: 1, opcode: 0xF30F53, e: 1, skip: 1, custom: 1 },

    { sse: 1, opcode: 0x0F54, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F54, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F55, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F55, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F56, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F56, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F57, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F57, e: 1, custom: 1 },

    { sse: 1, opcode: 0x0F58, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F58, e: 1, custom: 1 },
    { sse: 1, opcode: 0xF20F58, e: 1, custom: 1 },
    { sse: 1, opcode: 0xF30F58, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F59, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F59, e: 1, custom: 1 },
    { sse: 1, opcode: 0xF20F59, e: 1, custom: 1 },
    { sse: 1, opcode: 0xF30F59, e: 1, custom: 1 },

    { sse: 1, opcode: 0x0F5A, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F5A, e: 1, custom: 1 },
    { sse: 1, opcode: 0xF20F5A, e: 1, custom: 1 },
    { sse: 1, opcode: 0xF30F5A, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F5B, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F5B, e: 1, custom: 1 },
    // no F2 variant
    { sse: 1, opcode: 0xF30F5B, e: 1, custom: 1 },

    { sse: 1, opcode: 0x0F5C, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F5C, e: 1, custom: 1 },
    { sse: 1, opcode: 0xF20F5C, e: 1, custom: 1 },
    { sse: 1, opcode: 0xF30F5C, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F5D, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F5D, e: 1, custom: 1 },
    { sse: 1, opcode: 0xF20F5D, e: 1, custom: 1 },
    { sse: 1, opcode: 0xF30F5D, e: 1, custom: 1 },

    { sse: 1, opcode: 0x0F5E, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F5E, e: 1, custom: 1 },
    { sse: 1, opcode: 0xF20F5E, e: 1, custom: 1 },
    { sse: 1, opcode: 0xF30F5E, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F5F, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F5F, e: 1, custom: 1 },
    { sse: 1, opcode: 0xF20F5F, e: 1, custom: 1 },
    { sse: 1, opcode: 0xF30F5F, e: 1, custom: 1 },

    { sse: 1, opcode: 0x660F60, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F60, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F61, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F61, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F62, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F62, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F63, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F63, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F64, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F64, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F65, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F65, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F66, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F66, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F67, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F67, e: 1, custom: 1 },

    { sse: 1, opcode: 0x660F68, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F68, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F69, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F69, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F6A, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F6A, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F6B, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F6B, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F6C, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F6C, e: 1, block_boundary: 1 }, // ud
    { sse: 1, opcode: 0x660F6D, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F6D, e: 1, block_boundary: 1 }, // ud
    { sse: 1, opcode: 0x660F6E, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F6E, e: 1, custom: 1 },
    { sse: 1, opcode: 0xF30F6F, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F6F, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F6F, e: 1, custom: 1 },

    { sse: 1, opcode: 0x0F70, e: 1, imm8: 1, custom: 1 },
    { sse: 1, opcode: 0x660F70, e: 1, imm8: 1, custom: 1 },
    { sse: 1, opcode: 0xF20F70, e: 1, imm8: 1, custom: 1 },
    { sse: 1, opcode: 0xF30F70, e: 1, imm8: 1, custom: 1 },

    { sse: 1, opcode: 0x0F71, e: 1, fixed_g: 2, imm8: 1, mem_ud: 1, custom: 1 },
    { sse: 1, opcode: 0x660F71, e: 1, fixed_g: 2, imm8: 1, mem_ud: 1, custom: 1 },
    { sse: 1, opcode: 0x0F71, e: 1, fixed_g: 4, imm8: 1, mem_ud: 1, custom: 1 },
    { sse: 1, opcode: 0x660F71, e: 1, fixed_g: 4, imm8: 1, mem_ud: 1, custom: 1 },
    { sse: 1, opcode: 0x0F71, e: 1, fixed_g: 6, imm8: 1, mem_ud: 1, custom: 1 },
    { sse: 1, opcode: 0x660F71, e: 1, fixed_g: 6, imm8: 1, mem_ud: 1, custom: 1 },

    { sse: 1, opcode: 0x0F72, e: 1, fixed_g: 2, imm8: 1, mem_ud: 1, custom: 1 },
    { sse: 1, opcode: 0x660F72, e: 1, fixed_g: 2, imm8: 1, mem_ud: 1, custom: 1 },
    { sse: 1, opcode: 0x0F72, e: 1, fixed_g: 4, imm8: 1, mem_ud: 1, custom: 1 },
    { sse: 1, opcode: 0x660F72, e: 1, fixed_g: 4, imm8: 1, mem_ud: 1, custom: 1 },
    { sse: 1, opcode: 0x0F72, e: 1, fixed_g: 6, imm8: 1, mem_ud: 1, custom: 1 },
    { sse: 1, opcode: 0x660F72, e: 1, fixed_g: 6, imm8: 1, mem_ud: 1, custom: 1 },

    { sse: 1, opcode: 0x0F73, e: 1, fixed_g: 2, imm8: 1, mem_ud: 1, custom: 1 },
    { sse: 1, opcode: 0x660F73, e: 1, fixed_g: 2, imm8: 1, mem_ud: 1, custom: 1 },
    { sse: 1, opcode: 0x660F73, e: 1, fixed_g: 3, imm8: 1, mem_ud: 1, custom: 1 },
    { sse: 1, opcode: 0x0F73, e: 1, fixed_g: 6, imm8: 1, mem_ud: 1, custom: 1 },
    { sse: 1, opcode: 0x660F73, e: 1, fixed_g: 6, imm8: 1, mem_ud: 1, custom: 1 },
    { sse: 1, opcode: 0x660F73, e: 1, fixed_g: 7, imm8: 1, mem_ud: 1, custom: 1 },

    { sse: 1, opcode: 0x0F74, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F74, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F75, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F75, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F76, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F76, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F77, skip: 1 }, // emms (skip as it breaks gdb printing of float registers)

    // vmx instructions
    { opcode: 0x0F78, skip: 1, block_boundary: 1 },
    { opcode: 0x0F79, skip: 1, block_boundary: 1 },

    { opcode: 0x0F7A, skip: 1, block_boundary: 1 }, // ud
    { opcode: 0x0F7B, skip: 1, block_boundary: 1 }, // ud

    { sse: 1, opcode: 0x660F7C, e: 1, custom: 1 }, // sse3
    { sse: 1, opcode: 0xF20F7C, e: 1, custom: 1 }, // sse3
    { sse: 1, opcode: 0x660F7D, e: 1, custom: 1 }, // sse3
    { sse: 1, opcode: 0xF20F7D, e: 1, custom: 1 }, // sse3

    { opcode: 0x0F7C, skip: 1, block_boundary: 1 }, // ud
    { opcode: 0x0F7D, skip: 1, block_boundary: 1 }, // ud

    { sse: 1, opcode: 0x0F7E, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F7E, e: 1, custom: 1 },
    { sse: 1, opcode: 0xF30F7E, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0F7F, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660F7F, e: 1, custom: 1 },
    { sse: 1, opcode: 0xF30F7F, e: 1, custom: 1 },

    { sse: 1, opcode: 0x0FC2, e: 1, imm8: 1, custom: 1 },
    { sse: 1, opcode: 0x660FC2, e: 1, imm8: 1, custom: 1 },
    { sse: 1, opcode: 0xF20FC2, e: 1, imm8: 1, custom: 1 },
    { sse: 1, opcode: 0xF30FC2, e: 1, imm8: 1, custom: 1 },

    { opcode: 0x0FC3, e: 1, custom: 1, reg_ud: 1 }, // movnti: Uses normal registers, hence not marked as sse

    { sse: 1, opcode: 0x0FC4, e: 1, imm8: 1, custom: 1 },
    { sse: 1, opcode: 0x660FC4, e: 1, imm8: 1, custom: 1 },
    { sse: 1, opcode: 0x0FC5, e: 1, mem_ud: 1, imm8: 1, custom: 1 },
    { sse: 1, opcode: 0x660FC5, e: 1, mem_ud: 1, imm8: 1, custom: 1 },

    { sse: 1, opcode: 0x0FC6, e: 1, imm8: 1, custom: 1 },
    { sse: 1, opcode: 0x660FC6, e: 1, imm8: 1, custom: 1 },

    { sse: 1, opcode: 0x0FD0, skip: 1, block_boundary: 1 }, // sse3

    { sse: 1, opcode: 0x0FD1, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FD1, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FD2, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FD2, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FD3, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FD3, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FD4, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FD4, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FD5, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FD5, e: 1, custom: 1 },

    { sse: 1, opcode: 0x660FD6, e: 1, custom: 1 },
    { sse: 1, opcode: 0xF20FD6, mem_ud: 1, e: 1 },
    { sse: 1, opcode: 0xF30FD6, mem_ud: 1, e: 1 },
    { sse: 1, opcode: 0x0FD6, e: 1, block_boundary: 1 }, // ud

    { sse: 1, opcode: 0x0FD7, e: 1, mem_ud: 1, custom: 1 },
    { sse: 1, opcode: 0x660FD7, e: 1, mem_ud: 1, custom: 1 },

    { sse: 1, opcode: 0x0FD8, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FD8, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FD9, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FD9, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FDA, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FDA, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FDB, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FDB, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FDC, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FDC, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FDD, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FDD, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FDE, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FDE, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FDF, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FDF, e: 1, custom: 1 },

    { sse: 1, opcode: 0x0FE0, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FE0, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FE1, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FE1, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FE2, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FE2, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FE3, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FE3, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FE4, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FE4, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FE5, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FE5, e: 1, custom: 1 },

    { sse: 1, opcode: 0x660FE6, e: 1, custom: 1 },
    { sse: 1, opcode: 0xF20FE6, e: 1, custom: 1 },
    { sse: 1, opcode: 0xF30FE6, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FE6, e: 1, block_boundary: 1 }, // ud
    { sse: 1, opcode: 0x0FE7, e: 1, reg_ud: 1 },
    { sse: 1, opcode: 0x660FE7, e: 1, reg_ud: 1, custom: 1 },

    { sse: 1, opcode: 0x0FE8, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FE8, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FE9, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FE9, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FEA, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FEA, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FEB, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FEB, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FEC, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FEC, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FED, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FED, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FEE, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FEE, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FEF, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FEF, e: 1, custom: 1 },

    { sse: 1, opcode: 0x0FF0, skip: 1, block_boundary: 1 }, // sse3

    { sse: 1, opcode: 0x0FF1, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FF1, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FF2, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FF2, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FF3, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FF3, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FF4, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FF4, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FF5, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FF5, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FF6, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FF6, e: 1, custom: 1 },
    // maskmovq (0FF7), maskmovdqu (660FF7) tested manually
    // Generated tests don't setup EDI as required (yet)
    { sse: 1, opcode: 0x0FF7, mem_ud: 1, e: 1, custom: 1, skip: 1 },
    { sse: 1, opcode: 0x660FF7, mem_ud: 1, e: 1, custom: 1, skip: 1 },

    { sse: 1, opcode: 0x0FF8, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FF8, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FF9, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FF9, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FFA, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FFA, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FFB, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FFB, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FFC, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FFC, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FFD, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FFD, e: 1, custom: 1 },
    { sse: 1, opcode: 0x0FFE, e: 1, custom: 1 },
    { sse: 1, opcode: 0x660FFE, e: 1, custom: 1 },

    { opcode: 0x0FFF, block_boundary: 1 }, // ud
];

for(let i = 0; i < 8; i++)
{
    encodings.push.apply(encodings, [
        { opcode: 0x00 | i << 3, custom: 1, e: 1 },
        { opcode: 0x01 | i << 3, custom: 1, os: 1, e: 1 },
        { opcode: 0x02 | i << 3, custom: 1, e: 1 },
        { opcode: 0x03 | i << 3, custom: 1, os: 1, e: 1 },
        { opcode: 0x04 | i << 3, custom: 1, imm8: 1 },
        { opcode: 0x05 | i << 3, custom: 1, os: 1, imm1632: 1 },

        { opcode: 0x40 | i, os: 1, custom: 1 },
        { opcode: 0x48 | i, os: 1, custom: 1 },

        { opcode: 0x50 | i, custom: 1, os: 1 },
        { opcode: 0x58 | i, custom: 1, os: 1 },

        { opcode: 0x70 | i, block_boundary: 1, no_block_boundary_in_interpreted: 1, jump_offset_imm: 1, conditional_jump: 1, os: 1, imm8s: 1, custom: 1, skip: 1 },
        { opcode: 0x78 | i, block_boundary: 1, no_block_boundary_in_interpreted: 1, jump_offset_imm: 1, conditional_jump: 1, os: 1, imm8s: 1, custom: 1, skip: 1 },

        { opcode: 0x80, e: 1, fixed_g: i, imm8: 1, custom: 1 },
        { opcode: 0x81, os: 1, e: 1, fixed_g: i, imm1632: 1, custom: 1 },
        { opcode: 0x82, e: 1, fixed_g: i, imm8: 1, custom: 1 },
        { opcode: 0x83, os: 1, e: 1, fixed_g: i, imm8s: 1, custom: 1 },

        { opcode: 0xB0 | i, custom: 1, imm8: 1 },
        { opcode: 0xB8 | i, custom: 1, os: 1, imm1632: 1 },

        // note: overflow flag only undefined if shift is > 1
        // note: the adjust flag is undefined for shifts > 0 and unaffected by rotates
        { opcode: 0xC0, e: 1, fixed_g: i, imm8: 1, mask_flags: of | af, custom: 1 },
        { opcode: 0xC1, os: 1, e: 1, fixed_g: i, imm8: 1, mask_flags: of | af, custom: 1 },
        { opcode: 0xD0, e: 1, fixed_g: i, mask_flags: af, custom: 1 },
        { opcode: 0xD1, os: 1, e: 1, fixed_g: i, mask_flags: af, custom: 1 },
        { opcode: 0xD2, e: 1, fixed_g: i, mask_flags: of | af, custom: 1 },
        { opcode: 0xD3, os: 1, e: 1, fixed_g: i, mask_flags: of | af, custom: 1 },

        { opcode: 0x0F40 | i, e: 1, os: 1, custom: 1 },
        { opcode: 0x0F48 | i, e: 1, os: 1, custom: 1 },

        { opcode: 0x0F80 | i, block_boundary: 1, no_block_boundary_in_interpreted: 1, jump_offset_imm: 1, conditional_jump: 1, imm1632: 1, os: 1, custom: 1, skip: 1 },
        { opcode: 0x0F88 | i, block_boundary: 1, no_block_boundary_in_interpreted: 1, jump_offset_imm: 1, conditional_jump: 1, imm1632: 1, os: 1, custom: 1, skip: 1 },

        { opcode: 0x0F90 | i, e: 1, custom: 1 },
        { opcode: 0x0F98 | i, e: 1, custom: 1 },
    ]);
}

encodings.sort((e1, e2) => {
    let o1 = (e1.opcode & 0xFF00) === 0x0F00 ? e1.opcode & 0xFFFF : e1.opcode & 0xFF;
    let o2 = (e2.opcode & 0xFF00) === 0x0F00 ? e2.opcode & 0xFFFF : e2.opcode & 0xFF;
    return o1 - o2 || e1.fixed_g - e2.fixed_g;
});

const result = Object.freeze(encodings.map(entry => Object.freeze(entry)));
export default result;
