#![allow(non_snake_case, unused_variables)]

extern "C" {
    #[no_mangle]
    fn lss16(x: i32, y: i32, z: i32);
    #[no_mangle]
    fn lss32(x: i32, y: i32, z: i32);
    #[no_mangle]
    fn enter16(size: i32, nesting_level: i32);
    #[no_mangle]
    fn enter32(size: i32, nesting_level: i32);

    #[no_mangle]
    fn arpl(seg: i32, r: i32) -> i32;
    #[no_mangle]
    fn far_jump(eip: i32, selector: i32, is_call: bool);
    #[no_mangle]
    fn far_return(eip: i32, selector: i32, stack_adjust: i32);

    #[no_mangle]
    fn hlt_op();
}

use cpu2::arith::*;
use cpu2::cpu::*;
use cpu2::fpu::*;
use cpu2::fpu::{fpu_load_m32, fpu_load_m64, fpu_write_st};
use cpu2::global_pointers::*;
use cpu2::misc_instr::*;
use cpu2::misc_instr::{pop16, pop32s, push16, push32};
use cpu2::string::*;

#[no_mangle]
pub unsafe fn instr_00_mem(addr: i32, r: i32) {
    SAFE_READ_WRITE8!(___, addr, add8(___, read_reg8(r)));
}
#[no_mangle]
pub unsafe fn instr_00_reg(r1: i32, r: i32) { write_reg8(r1, add8(read_reg8(r1), read_reg8(r))); }
#[no_mangle]
pub unsafe fn instr16_01_mem(addr: i32, r: i32) {
    SAFE_READ_WRITE16!(___, addr, add16(___, read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr16_01_reg(r1: i32, r: i32) {
    write_reg16(r1, add16(read_reg16(r1), read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr32_01_mem(addr: i32, r: i32) {
    SAFE_READ_WRITE32!(___, addr, add32(___, read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr32_01_reg(r1: i32, r: i32) {
    write_reg32(r1, add32(read_reg32(r1), read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr_02_mem(addr: i32, r: i32) {
    write_reg8(
        r,
        add8(read_reg8(r), return_on_pagefault!(safe_read8(addr))),
    );
}
#[no_mangle]
pub unsafe fn instr_02_reg(r1: i32, r: i32) { write_reg8(r, add8(read_reg8(r), read_reg8(r1))); }
#[no_mangle]
pub unsafe fn instr16_03_mem(addr: i32, r: i32) {
    write_reg16(
        r,
        add16(read_reg16(r), return_on_pagefault!(safe_read16(addr))),
    );
}
#[no_mangle]
pub unsafe fn instr16_03_reg(r1: i32, r: i32) {
    write_reg16(r, add16(read_reg16(r), read_reg16(r1)));
}
#[no_mangle]
pub unsafe fn instr32_03_mem(addr: i32, r: i32) {
    write_reg32(
        r,
        add32(read_reg32(r), return_on_pagefault!(safe_read32s(addr))),
    );
}
#[no_mangle]
pub unsafe fn instr32_03_reg(r1: i32, r: i32) {
    write_reg32(r, add32(read_reg32(r), read_reg32(r1)));
}
#[no_mangle]
pub unsafe fn instr_04(imm8: i32) {
    *reg8.offset(AL as isize) = add8(*reg8.offset(AL as isize) as i32, imm8) as u8;
}
#[no_mangle]
pub unsafe fn instr16_05(imm16: i32) {
    *reg16.offset(AX as isize) = add16(*reg16.offset(AX as isize) as i32, imm16) as u16;
}
#[no_mangle]
pub unsafe fn instr32_05(imm32: i32) {
    *reg32.offset(EAX as isize) = add32(*reg32.offset(EAX as isize), imm32);
}
#[no_mangle]
pub unsafe fn instr16_06() {
    return_on_pagefault!(push16(*sreg.offset(ES as isize) as i32));
}
#[no_mangle]
pub unsafe fn instr32_06() {
    return_on_pagefault!(push32(*sreg.offset(ES as isize) as i32));
}
#[no_mangle]
pub unsafe fn instr16_07() {
    if !switch_seg(ES, return_on_pagefault!(safe_read16(get_stack_pointer(0)))) {
        return;
    }
    else {
        adjust_stack_reg(2);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr32_07() {
    if !switch_seg(
        ES,
        return_on_pagefault!(safe_read32s(get_stack_pointer(0))) & 0xFFFF,
    ) {
        return;
    }
    else {
        adjust_stack_reg(4);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_08_mem(addr: i32, r: i32) {
    SAFE_READ_WRITE8!(___, addr, or8(___, read_reg8(r)));
}
#[no_mangle]
pub unsafe fn instr_08_reg(r1: i32, r: i32) { write_reg8(r1, or8(read_reg8(r1), read_reg8(r))); }
#[no_mangle]
pub unsafe fn instr16_09_mem(addr: i32, r: i32) {
    SAFE_READ_WRITE16!(___, addr, or16(___, read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr16_09_reg(r1: i32, r: i32) {
    write_reg16(r1, or16(read_reg16(r1), read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr32_09_mem(addr: i32, r: i32) {
    SAFE_READ_WRITE32!(___, addr, or32(___, read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr32_09_reg(r1: i32, r: i32) {
    write_reg32(r1, or32(read_reg32(r1), read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr_0A_mem(addr: i32, r: i32) {
    write_reg8(r, or8(read_reg8(r), return_on_pagefault!(safe_read8(addr))));
}
#[no_mangle]
pub unsafe fn instr_0A_reg(r1: i32, r: i32) { write_reg8(r, or8(read_reg8(r), read_reg8(r1))); }
#[no_mangle]
pub unsafe fn instr16_0B_mem(addr: i32, r: i32) {
    write_reg16(
        r,
        or16(read_reg16(r), return_on_pagefault!(safe_read16(addr))),
    );
}
#[no_mangle]
pub unsafe fn instr16_0B_reg(r1: i32, r: i32) {
    write_reg16(r, or16(read_reg16(r), read_reg16(r1)));
}
#[no_mangle]
pub unsafe fn instr32_0B_mem(addr: i32, r: i32) {
    write_reg32(
        r,
        or32(read_reg32(r), return_on_pagefault!(safe_read32s(addr))),
    );
}
#[no_mangle]
pub unsafe fn instr32_0B_reg(r1: i32, r: i32) {
    write_reg32(r, or32(read_reg32(r), read_reg32(r1)));
}
#[no_mangle]
pub unsafe fn instr_0C(imm8: i32) {
    *reg8.offset(AL as isize) = or8(*reg8.offset(AL as isize) as i32, imm8) as u8;
}
#[no_mangle]
pub unsafe fn instr16_0D(imm16: i32) {
    *reg16.offset(AX as isize) = or16(*reg16.offset(AX as isize) as i32, imm16) as u16;
}
#[no_mangle]
pub unsafe fn instr32_0D(imm32: i32) {
    *reg32.offset(EAX as isize) = or32(*reg32.offset(EAX as isize), imm32);
}
#[no_mangle]
pub unsafe fn instr16_0E() {
    return_on_pagefault!(push16(*sreg.offset(CS as isize) as i32));
}
#[no_mangle]
pub unsafe fn instr32_0E() {
    return_on_pagefault!(push32(*sreg.offset(CS as isize) as i32));
}
#[no_mangle]
pub unsafe fn instr16_0F() { run_instruction0f_16(return_on_pagefault!(read_imm8())); }
#[no_mangle]
pub unsafe fn instr32_0F() { run_instruction0f_32(return_on_pagefault!(read_imm8())); }
#[no_mangle]
pub unsafe fn instr_10_mem(addr: i32, r: i32) {
    SAFE_READ_WRITE8!(___, addr, adc8(___, read_reg8(r)));
}
#[no_mangle]
pub unsafe fn instr_10_reg(r1: i32, r: i32) { write_reg8(r1, adc8(read_reg8(r1), read_reg8(r))); }
#[no_mangle]
pub unsafe fn instr16_11_mem(addr: i32, r: i32) {
    SAFE_READ_WRITE16!(___, addr, adc16(___, read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr16_11_reg(r1: i32, r: i32) {
    write_reg16(r1, adc16(read_reg16(r1), read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr32_11_mem(addr: i32, r: i32) {
    SAFE_READ_WRITE32!(___, addr, adc32(___, read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr32_11_reg(r1: i32, r: i32) {
    write_reg32(r1, adc32(read_reg32(r1), read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr_12_mem(addr: i32, r: i32) {
    write_reg8(
        r,
        adc8(read_reg8(r), return_on_pagefault!(safe_read8(addr))),
    );
}
#[no_mangle]
pub unsafe fn instr_12_reg(r1: i32, r: i32) { write_reg8(r, adc8(read_reg8(r), read_reg8(r1))); }
#[no_mangle]
pub unsafe fn instr16_13_mem(addr: i32, r: i32) {
    write_reg16(
        r,
        adc16(read_reg16(r), return_on_pagefault!(safe_read16(addr))),
    );
}
#[no_mangle]
pub unsafe fn instr16_13_reg(r1: i32, r: i32) {
    write_reg16(r, adc16(read_reg16(r), read_reg16(r1)));
}
#[no_mangle]
pub unsafe fn instr32_13_mem(addr: i32, r: i32) {
    write_reg32(
        r,
        adc32(read_reg32(r), return_on_pagefault!(safe_read32s(addr))),
    );
}
#[no_mangle]
pub unsafe fn instr32_13_reg(r1: i32, r: i32) {
    write_reg32(r, adc32(read_reg32(r), read_reg32(r1)));
}
#[no_mangle]
pub unsafe fn instr_14(imm8: i32) {
    *reg8.offset(AL as isize) = adc8(*reg8.offset(AL as isize) as i32, imm8) as u8;
}
#[no_mangle]
pub unsafe fn instr16_15(imm16: i32) {
    *reg16.offset(AX as isize) = adc16(*reg16.offset(AX as isize) as i32, imm16) as u16;
}
#[no_mangle]
pub unsafe fn instr32_15(imm32: i32) {
    *reg32.offset(EAX as isize) = adc32(*reg32.offset(EAX as isize), imm32);
}
#[no_mangle]
pub unsafe fn instr16_16() {
    return_on_pagefault!(push16(*sreg.offset(SS as isize) as i32));
}
#[no_mangle]
pub unsafe fn instr32_16() {
    return_on_pagefault!(push32(*sreg.offset(SS as isize) as i32));
}
#[no_mangle]
pub unsafe fn instr16_17() {
    if !switch_seg(SS, return_on_pagefault!(safe_read16(get_stack_pointer(0)))) {
        return;
    }
    else {
        adjust_stack_reg(2);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr32_17() {
    if !switch_seg(
        SS,
        return_on_pagefault!(safe_read32s(get_stack_pointer(0))) & 0xFFFF,
    ) {
        return;
    }
    else {
        adjust_stack_reg(4);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_18_mem(addr: i32, r: i32) {
    SAFE_READ_WRITE8!(___, addr, sbb8(___, read_reg8(r)));
}
#[no_mangle]
pub unsafe fn instr_18_reg(r1: i32, r: i32) { write_reg8(r1, sbb8(read_reg8(r1), read_reg8(r))); }
#[no_mangle]
pub unsafe fn instr16_19_mem(addr: i32, r: i32) {
    SAFE_READ_WRITE16!(___, addr, sbb16(___, read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr16_19_reg(r1: i32, r: i32) {
    write_reg16(r1, sbb16(read_reg16(r1), read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr32_19_mem(addr: i32, r: i32) {
    SAFE_READ_WRITE32!(___, addr, sbb32(___, read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr32_19_reg(r1: i32, r: i32) {
    write_reg32(r1, sbb32(read_reg32(r1), read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr_1A_mem(addr: i32, r: i32) {
    write_reg8(
        r,
        sbb8(read_reg8(r), return_on_pagefault!(safe_read8(addr))),
    );
}
#[no_mangle]
pub unsafe fn instr_1A_reg(r1: i32, r: i32) { write_reg8(r, sbb8(read_reg8(r), read_reg8(r1))); }
#[no_mangle]
pub unsafe fn instr16_1B_mem(addr: i32, r: i32) {
    write_reg16(
        r,
        sbb16(read_reg16(r), return_on_pagefault!(safe_read16(addr))),
    );
}
#[no_mangle]
pub unsafe fn instr16_1B_reg(r1: i32, r: i32) {
    write_reg16(r, sbb16(read_reg16(r), read_reg16(r1)));
}
#[no_mangle]
pub unsafe fn instr32_1B_mem(addr: i32, r: i32) {
    write_reg32(
        r,
        sbb32(read_reg32(r), return_on_pagefault!(safe_read32s(addr))),
    );
}
#[no_mangle]
pub unsafe fn instr32_1B_reg(r1: i32, r: i32) {
    write_reg32(r, sbb32(read_reg32(r), read_reg32(r1)));
}
#[no_mangle]
pub unsafe fn instr_1C(imm8: i32) {
    *reg8.offset(AL as isize) = sbb8(*reg8.offset(AL as isize) as i32, imm8) as u8;
}
#[no_mangle]
pub unsafe fn instr16_1D(imm16: i32) {
    *reg16.offset(AX as isize) = sbb16(*reg16.offset(AX as isize) as i32, imm16) as u16;
}
#[no_mangle]
pub unsafe fn instr32_1D(imm32: i32) {
    *reg32.offset(EAX as isize) = sbb32(*reg32.offset(EAX as isize), imm32);
}
#[no_mangle]
pub unsafe fn instr16_1E() {
    return_on_pagefault!(push16(*sreg.offset(DS as isize) as i32));
}
#[no_mangle]
pub unsafe fn instr32_1E() {
    return_on_pagefault!(push32(*sreg.offset(DS as isize) as i32));
}
#[no_mangle]
pub unsafe fn instr16_1F() {
    if !switch_seg(DS, return_on_pagefault!(safe_read16(get_stack_pointer(0)))) {
        return;
    }
    else {
        adjust_stack_reg(2);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr32_1F() {
    if !switch_seg(
        DS,
        return_on_pagefault!(safe_read32s(get_stack_pointer(0))) & 0xFFFF,
    ) {
        return;
    }
    else {
        adjust_stack_reg(4);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_20_mem(addr: i32, r: i32) {
    SAFE_READ_WRITE8!(___, addr, and8(___, read_reg8(r)));
}
#[no_mangle]
pub unsafe fn instr_20_reg(r1: i32, r: i32) { write_reg8(r1, and8(read_reg8(r1), read_reg8(r))); }
#[no_mangle]
pub unsafe fn instr16_21_mem(addr: i32, r: i32) {
    SAFE_READ_WRITE16!(___, addr, and16(___, read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr16_21_reg(r1: i32, r: i32) {
    write_reg16(r1, and16(read_reg16(r1), read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr32_21_mem(addr: i32, r: i32) {
    SAFE_READ_WRITE32!(___, addr, and32(___, read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr32_21_reg(r1: i32, r: i32) {
    write_reg32(r1, and32(read_reg32(r1), read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr_22_mem(addr: i32, r: i32) {
    write_reg8(
        r,
        and8(read_reg8(r), return_on_pagefault!(safe_read8(addr))),
    );
}
#[no_mangle]
pub unsafe fn instr_22_reg(r1: i32, r: i32) { write_reg8(r, and8(read_reg8(r), read_reg8(r1))); }
#[no_mangle]
pub unsafe fn instr16_23_mem(addr: i32, r: i32) {
    write_reg16(
        r,
        and16(read_reg16(r), return_on_pagefault!(safe_read16(addr))),
    );
}
#[no_mangle]
pub unsafe fn instr16_23_reg(r1: i32, r: i32) {
    write_reg16(r, and16(read_reg16(r), read_reg16(r1)));
}
#[no_mangle]
pub unsafe fn instr32_23_mem(addr: i32, r: i32) {
    write_reg32(
        r,
        and32(read_reg32(r), return_on_pagefault!(safe_read32s(addr))),
    );
}
#[no_mangle]
pub unsafe fn instr32_23_reg(r1: i32, r: i32) {
    write_reg32(r, and32(read_reg32(r), read_reg32(r1)));
}
#[no_mangle]
pub unsafe fn instr_24(imm8: i32) {
    *reg8.offset(AL as isize) = and8(*reg8.offset(AL as isize) as i32, imm8) as u8;
}
#[no_mangle]
pub unsafe fn instr16_25(imm16: i32) {
    *reg16.offset(AX as isize) = and16(*reg16.offset(AX as isize) as i32, imm16) as u16;
}
#[no_mangle]
pub unsafe fn instr32_25(imm32: i32) {
    *reg32.offset(EAX as isize) = and32(*reg32.offset(EAX as isize), imm32);
}
#[no_mangle]
pub unsafe fn instr_26() { segment_prefix_op(ES); }
#[no_mangle]
pub unsafe fn instr_27() { bcd_daa(); }
#[no_mangle]
pub unsafe fn instr_28_mem(addr: i32, r: i32) {
    SAFE_READ_WRITE8!(___, addr, sub8(___, read_reg8(r)));
}
#[no_mangle]
pub unsafe fn instr_28_reg(r1: i32, r: i32) { write_reg8(r1, sub8(read_reg8(r1), read_reg8(r))); }
#[no_mangle]
pub unsafe fn instr16_29_mem(addr: i32, r: i32) {
    SAFE_READ_WRITE16!(___, addr, sub16(___, read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr16_29_reg(r1: i32, r: i32) {
    write_reg16(r1, sub16(read_reg16(r1), read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr32_29_mem(addr: i32, r: i32) {
    SAFE_READ_WRITE32!(___, addr, sub32(___, read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr32_29_reg(r1: i32, r: i32) {
    write_reg32(r1, sub32(read_reg32(r1), read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr_2A_mem(addr: i32, r: i32) {
    write_reg8(
        r,
        sub8(read_reg8(r), return_on_pagefault!(safe_read8(addr))),
    );
}
#[no_mangle]
pub unsafe fn instr_2A_reg(r1: i32, r: i32) { write_reg8(r, sub8(read_reg8(r), read_reg8(r1))); }
#[no_mangle]
pub unsafe fn instr16_2B_mem(addr: i32, r: i32) {
    write_reg16(
        r,
        sub16(read_reg16(r), return_on_pagefault!(safe_read16(addr))),
    );
}
#[no_mangle]
pub unsafe fn instr16_2B_reg(r1: i32, r: i32) {
    write_reg16(r, sub16(read_reg16(r), read_reg16(r1)));
}
#[no_mangle]
pub unsafe fn instr32_2B_mem(addr: i32, r: i32) {
    write_reg32(
        r,
        sub32(read_reg32(r), return_on_pagefault!(safe_read32s(addr))),
    );
}
#[no_mangle]
pub unsafe fn instr32_2B_reg(r1: i32, r: i32) {
    write_reg32(r, sub32(read_reg32(r), read_reg32(r1)));
}
#[no_mangle]
pub unsafe fn instr_2C(imm8: i32) {
    *reg8.offset(AL as isize) = sub8(*reg8.offset(AL as isize) as i32, imm8) as u8;
}
#[no_mangle]
pub unsafe fn instr16_2D(imm16: i32) {
    *reg16.offset(AX as isize) = sub16(*reg16.offset(AX as isize) as i32, imm16) as u16;
}
#[no_mangle]
pub unsafe fn instr32_2D(imm32: i32) {
    *reg32.offset(EAX as isize) = sub32(*reg32.offset(EAX as isize), imm32);
}
#[no_mangle]
pub unsafe fn instr_2E() { segment_prefix_op(CS); }
#[no_mangle]
pub unsafe fn instr_2F() { bcd_das(); }
#[no_mangle]
pub unsafe fn instr_30_mem(addr: i32, r: i32) {
    SAFE_READ_WRITE8!(___, addr, xor8(___, read_reg8(r)));
}
#[no_mangle]
pub unsafe fn instr_30_reg(r1: i32, r: i32) { write_reg8(r1, xor8(read_reg8(r1), read_reg8(r))); }
#[no_mangle]
pub unsafe fn instr16_31_mem(addr: i32, r: i32) {
    SAFE_READ_WRITE16!(___, addr, xor16(___, read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr16_31_reg(r1: i32, r: i32) {
    write_reg16(r1, xor16(read_reg16(r1), read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr32_31_mem(addr: i32, r: i32) {
    SAFE_READ_WRITE32!(___, addr, xor32(___, read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr32_31_reg(r1: i32, r: i32) {
    write_reg32(r1, xor32(read_reg32(r1), read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr_32_mem(addr: i32, r: i32) {
    write_reg8(
        r,
        xor8(read_reg8(r), return_on_pagefault!(safe_read8(addr))),
    );
}
#[no_mangle]
pub unsafe fn instr_32_reg(r1: i32, r: i32) { write_reg8(r, xor8(read_reg8(r), read_reg8(r1))); }
#[no_mangle]
pub unsafe fn instr16_33_mem(addr: i32, r: i32) {
    write_reg16(
        r,
        xor16(read_reg16(r), return_on_pagefault!(safe_read16(addr))),
    );
}
#[no_mangle]
pub unsafe fn instr16_33_reg(r1: i32, r: i32) {
    write_reg16(r, xor16(read_reg16(r), read_reg16(r1)));
}
#[no_mangle]
pub unsafe fn instr32_33_mem(addr: i32, r: i32) {
    write_reg32(
        r,
        xor32(read_reg32(r), return_on_pagefault!(safe_read32s(addr))),
    );
}
#[no_mangle]
pub unsafe fn instr32_33_reg(r1: i32, r: i32) {
    write_reg32(r, xor32(read_reg32(r), read_reg32(r1)));
}
#[no_mangle]
pub unsafe fn instr_34(imm8: i32) {
    *reg8.offset(AL as isize) = xor8(*reg8.offset(AL as isize) as i32, imm8) as u8;
}
#[no_mangle]
pub unsafe fn instr16_35(imm16: i32) {
    *reg16.offset(AX as isize) = xor16(*reg16.offset(AX as isize) as i32, imm16) as u16;
}
#[no_mangle]
pub unsafe fn instr32_35(imm32: i32) {
    *reg32.offset(EAX as isize) = xor32(*reg32.offset(EAX as isize), imm32);
}
#[no_mangle]
pub unsafe fn instr_36() { segment_prefix_op(SS); }
#[no_mangle]
pub unsafe fn instr_37() { bcd_aaa(); }
#[no_mangle]
pub unsafe fn instr_38_mem(addr: i32, r: i32) {
    cmp8(return_on_pagefault!(safe_read8(addr)), read_reg8(r));
}
#[no_mangle]
pub unsafe fn instr_38_reg(r1: i32, r: i32) { cmp8(read_reg8(r1), read_reg8(r)); }
#[no_mangle]
pub unsafe fn instr16_39_mem(addr: i32, r: i32) {
    cmp16(return_on_pagefault!(safe_read16(addr)), read_reg16(r));
}
#[no_mangle]
pub unsafe fn instr16_39_reg(r1: i32, r: i32) { cmp16(read_reg16(r1), read_reg16(r)); }
#[no_mangle]
pub unsafe fn instr32_39_mem(addr: i32, r: i32) {
    cmp32(return_on_pagefault!(safe_read32s(addr)), read_reg32(r));
}
#[no_mangle]
pub unsafe fn instr32_39_reg(r1: i32, r: i32) { cmp32(read_reg32(r1), read_reg32(r)); }
#[no_mangle]
pub unsafe fn instr_3A_mem(addr: i32, r: i32) {
    cmp8(read_reg8(r), return_on_pagefault!(safe_read8(addr)));
}
#[no_mangle]
pub unsafe fn instr_3A_reg(r1: i32, r: i32) { cmp8(read_reg8(r), read_reg8(r1)); }
#[no_mangle]
pub unsafe fn instr16_3B_mem(addr: i32, r: i32) {
    cmp16(read_reg16(r), return_on_pagefault!(safe_read16(addr)));
}
#[no_mangle]
pub unsafe fn instr16_3B_reg(r1: i32, r: i32) { cmp16(read_reg16(r), read_reg16(r1)); }
#[no_mangle]
pub unsafe fn instr32_3B_mem(addr: i32, r: i32) {
    cmp32(read_reg32(r), return_on_pagefault!(safe_read32s(addr)));
}
#[no_mangle]
pub unsafe fn instr32_3B_reg(r1: i32, r: i32) { cmp32(read_reg32(r), read_reg32(r1)); }
#[no_mangle]
pub unsafe fn instr_3C(imm8: i32) { cmp8(*reg8.offset(AL as isize) as i32, imm8); }
#[no_mangle]
pub unsafe fn instr16_3D(imm16: i32) { cmp16(*reg16.offset(AX as isize) as i32, imm16); }
#[no_mangle]
pub unsafe fn instr32_3D(imm32: i32) { cmp32(*reg32.offset(EAX as isize), imm32); }
#[no_mangle]
pub unsafe fn instr_3E() { segment_prefix_op(DS); }
#[no_mangle]
pub unsafe fn instr_3F() { bcd_aas(); }
#[no_mangle]
pub unsafe fn instr16_40() {
    *reg16.offset(AX as isize) = inc16(*reg16.offset(AX as isize) as i32) as u16;
}
#[no_mangle]
pub unsafe fn instr32_40() { *reg32.offset(EAX as isize) = inc32(*reg32.offset(EAX as isize)); }
#[no_mangle]
pub unsafe fn instr16_41() {
    *reg16.offset(CX as isize) = inc16(*reg16.offset(CX as isize) as i32) as u16;
}
#[no_mangle]
pub unsafe fn instr32_41() { *reg32.offset(ECX as isize) = inc32(*reg32.offset(ECX as isize)); }
#[no_mangle]
pub unsafe fn instr16_42() {
    *reg16.offset(DX as isize) = inc16(*reg16.offset(DX as isize) as i32) as u16;
}
#[no_mangle]
pub unsafe fn instr32_42() { *reg32.offset(EDX as isize) = inc32(*reg32.offset(EDX as isize)); }
#[no_mangle]
pub unsafe fn instr16_43() {
    *reg16.offset(BX as isize) = inc16(*reg16.offset(BX as isize) as i32) as u16;
}
#[no_mangle]
pub unsafe fn instr32_43() { *reg32.offset(EBX as isize) = inc32(*reg32.offset(EBX as isize)); }
#[no_mangle]
pub unsafe fn instr16_44() {
    *reg16.offset(SP as isize) = inc16(*reg16.offset(SP as isize) as i32) as u16;
}
#[no_mangle]
pub unsafe fn instr32_44() { *reg32.offset(ESP as isize) = inc32(*reg32.offset(ESP as isize)); }
#[no_mangle]
pub unsafe fn instr16_45() {
    *reg16.offset(BP as isize) = inc16(*reg16.offset(BP as isize) as i32) as u16;
}
#[no_mangle]
pub unsafe fn instr32_45() { *reg32.offset(EBP as isize) = inc32(*reg32.offset(EBP as isize)); }
#[no_mangle]
pub unsafe fn instr16_46() {
    *reg16.offset(SI as isize) = inc16(*reg16.offset(SI as isize) as i32) as u16;
}
#[no_mangle]
pub unsafe fn instr32_46() { *reg32.offset(ESI as isize) = inc32(*reg32.offset(ESI as isize)); }
#[no_mangle]
pub unsafe fn instr16_47() {
    *reg16.offset(DI as isize) = inc16(*reg16.offset(DI as isize) as i32) as u16;
}
#[no_mangle]
pub unsafe fn instr32_47() { *reg32.offset(EDI as isize) = inc32(*reg32.offset(EDI as isize)); }
#[no_mangle]
pub unsafe fn instr16_48() {
    *reg16.offset(AX as isize) = dec16(*reg16.offset(AX as isize) as i32) as u16;
}
#[no_mangle]
pub unsafe fn instr32_48() { *reg32.offset(EAX as isize) = dec32(*reg32.offset(EAX as isize)); }
#[no_mangle]
pub unsafe fn instr16_49() {
    *reg16.offset(CX as isize) = dec16(*reg16.offset(CX as isize) as i32) as u16;
}
#[no_mangle]
pub unsafe fn instr32_49() { *reg32.offset(ECX as isize) = dec32(*reg32.offset(ECX as isize)); }
#[no_mangle]
pub unsafe fn instr16_4A() {
    *reg16.offset(DX as isize) = dec16(*reg16.offset(DX as isize) as i32) as u16;
}
#[no_mangle]
pub unsafe fn instr32_4A() { *reg32.offset(EDX as isize) = dec32(*reg32.offset(EDX as isize)); }
#[no_mangle]
pub unsafe fn instr16_4B() {
    *reg16.offset(BX as isize) = dec16(*reg16.offset(BX as isize) as i32) as u16;
}
#[no_mangle]
pub unsafe fn instr32_4B() { *reg32.offset(EBX as isize) = dec32(*reg32.offset(EBX as isize)); }
#[no_mangle]
pub unsafe fn instr16_4C() {
    *reg16.offset(SP as isize) = dec16(*reg16.offset(SP as isize) as i32) as u16;
}
#[no_mangle]
pub unsafe fn instr32_4C() { *reg32.offset(ESP as isize) = dec32(*reg32.offset(ESP as isize)); }
#[no_mangle]
pub unsafe fn instr16_4D() {
    *reg16.offset(BP as isize) = dec16(*reg16.offset(BP as isize) as i32) as u16;
}
#[no_mangle]
pub unsafe fn instr32_4D() { *reg32.offset(EBP as isize) = dec32(*reg32.offset(EBP as isize)); }
#[no_mangle]
pub unsafe fn instr16_4E() {
    *reg16.offset(SI as isize) = dec16(*reg16.offset(SI as isize) as i32) as u16;
}
#[no_mangle]
pub unsafe fn instr32_4E() { *reg32.offset(ESI as isize) = dec32(*reg32.offset(ESI as isize)); }
#[no_mangle]
pub unsafe fn instr16_4F() {
    *reg16.offset(DI as isize) = dec16(*reg16.offset(DI as isize) as i32) as u16;
}
#[no_mangle]
pub unsafe fn instr32_4F() { *reg32.offset(EDI as isize) = dec32(*reg32.offset(EDI as isize)); }

pub unsafe fn push16_reg(r: i32) {
    return_on_pagefault!(push16(*reg16.offset(r as isize) as i32));
}
pub unsafe fn push32_reg(r: i32) {
    return_on_pagefault!(push32(*reg32.offset(r as isize) as i32));
}

#[no_mangle]
pub unsafe fn instr16_50() { push16_reg(AX) }
#[no_mangle]
pub unsafe fn instr32_50() { push32_reg(EAX) }
#[no_mangle]
pub unsafe fn instr16_51() { push16_reg(CX) }
#[no_mangle]
pub unsafe fn instr32_51() { push32_reg(ECX) }
#[no_mangle]
pub unsafe fn instr16_52() { push16_reg(DX) }
#[no_mangle]
pub unsafe fn instr32_52() { push32_reg(EDX) }
#[no_mangle]
pub unsafe fn instr16_53() { push16_reg(BX) }
#[no_mangle]
pub unsafe fn instr32_53() { push32_reg(EBX) }
#[no_mangle]
pub unsafe fn instr16_54() { push16_reg(SP) }
#[no_mangle]
pub unsafe fn instr32_54() { push32_reg(ESP) }
#[no_mangle]
pub unsafe fn instr16_55() { push16_reg(BP) }
#[no_mangle]
pub unsafe fn instr32_55() { push32_reg(EBP) }
#[no_mangle]
pub unsafe fn instr16_56() { push16_reg(SI) }
#[no_mangle]
pub unsafe fn instr32_56() { push32_reg(ESI) }
#[no_mangle]
pub unsafe fn instr16_57() { push16_reg(DI) }
#[no_mangle]
pub unsafe fn instr32_57() { push32_reg(EDI) }
#[no_mangle]
pub unsafe fn instr16_58() { *reg16.offset(AX as isize) = return_on_pagefault!(pop16()) as u16; }
#[no_mangle]
pub unsafe fn instr32_58() { *reg32.offset(EAX as isize) = return_on_pagefault!(pop32s()); }
#[no_mangle]
pub unsafe fn instr16_59() { *reg16.offset(CX as isize) = return_on_pagefault!(pop16()) as u16; }
#[no_mangle]
pub unsafe fn instr32_59() { *reg32.offset(ECX as isize) = return_on_pagefault!(pop32s()); }
#[no_mangle]
pub unsafe fn instr16_5A() { *reg16.offset(DX as isize) = return_on_pagefault!(pop16()) as u16; }
#[no_mangle]
pub unsafe fn instr32_5A() { *reg32.offset(EDX as isize) = return_on_pagefault!(pop32s()); }
#[no_mangle]
pub unsafe fn instr16_5B() { *reg16.offset(BX as isize) = return_on_pagefault!(pop16()) as u16; }
#[no_mangle]
pub unsafe fn instr32_5B() { *reg32.offset(EBX as isize) = return_on_pagefault!(pop32s()); }
#[no_mangle]
pub unsafe fn instr16_5C() {
    *reg16.offset(SP as isize) = return_on_pagefault!(safe_read16(get_stack_pointer(0))) as u16;
}
#[no_mangle]
pub unsafe fn instr32_5C() {
    *reg32.offset(ESP as isize) = return_on_pagefault!(safe_read32s(get_stack_pointer(0)));
}
#[no_mangle]
pub unsafe fn instr16_5D() { *reg16.offset(BP as isize) = return_on_pagefault!(pop16()) as u16; }
#[no_mangle]
pub unsafe fn instr32_5D() { *reg32.offset(EBP as isize) = return_on_pagefault!(pop32s()); }
#[no_mangle]
pub unsafe fn instr16_5E() { *reg16.offset(SI as isize) = return_on_pagefault!(pop16()) as u16; }
#[no_mangle]
pub unsafe fn instr32_5E() { *reg32.offset(ESI as isize) = return_on_pagefault!(pop32s()); }
#[no_mangle]
pub unsafe fn instr16_5F() { *reg16.offset(DI as isize) = return_on_pagefault!(pop16()) as u16; }
#[no_mangle]
pub unsafe fn instr32_5F() { *reg32.offset(EDI as isize) = return_on_pagefault!(pop32s()); }
#[no_mangle]
pub unsafe fn instr16_60() { pusha16(); }
#[no_mangle]
pub unsafe fn instr32_60() { pusha32(); }
#[no_mangle]
pub unsafe fn instr16_61() { popa16(); }
#[no_mangle]
pub unsafe fn instr32_61() { popa32(); }
#[no_mangle]
pub unsafe fn instr_62_reg(r2: i32, r: i32) {
    // bound
    dbg_log!("Unimplemented BOUND instruction");
    dbg_assert!(false);
}
#[no_mangle]
pub unsafe fn instr_62_mem(addr: i32, r: i32) {
    dbg_log!("Unimplemented BOUND instruction");
    dbg_assert!(false);
}
#[no_mangle]
pub unsafe fn instr_63_mem(addr: i32, r: i32) {
    if !*protected_mode || vm86_mode() {
        dbg_log!("arpl #ud");
        trigger_ud();
        return;
    }
    SAFE_READ_WRITE16!(___, addr, arpl(___, read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr_63_reg(r1: i32, r: i32) {
    if !*protected_mode || vm86_mode() {
        dbg_log!("arpl #ud");
        trigger_ud();
        return;
    }
    write_reg16(r1, arpl(read_reg16(r1), read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr_64() { segment_prefix_op(FS); }
#[no_mangle]
pub unsafe fn instr_65() { segment_prefix_op(GS); }
#[no_mangle]
pub unsafe fn instr_66() {
    // Operand-size override prefix
    *prefixes = (*prefixes as i32 | PREFIX_MASK_OPSIZE) as u8;
    run_prefix_instruction();
    *prefixes = 0;
}
#[no_mangle]
pub unsafe fn instr_67() {
    // Address-size override prefix
    dbg_assert!(is_asize_32() == *is_32);
    *prefixes = (*prefixes as i32 | PREFIX_MASK_ADDRSIZE) as u8;
    run_prefix_instruction();
    *prefixes = 0;
}
#[no_mangle]
pub unsafe fn instr16_68(imm16: i32) {
    return_on_pagefault!(push16(imm16));
}
#[no_mangle]
pub unsafe fn instr32_68(imm32: i32) {
    return_on_pagefault!(push32(imm32));
}
#[no_mangle]
pub unsafe fn instr16_69_mem(addr: i32, r: i32, imm: i32) {
    write_reg16(r, imul_reg16(return_on_pagefault!(safe_read16(addr)), imm));
}
#[no_mangle]
pub unsafe fn instr16_69_reg(r1: i32, r: i32, imm: i32) {
    write_reg16(r, imul_reg16(read_reg16(r1), imm));
}
#[no_mangle]
pub unsafe fn instr32_69_mem(addr: i32, r: i32, imm: i32) {
    write_reg32(r, imul_reg32(return_on_pagefault!(safe_read32s(addr)), imm));
}
#[no_mangle]
pub unsafe fn instr32_69_reg(r1: i32, r: i32, imm: i32) {
    write_reg32(r, imul_reg32(read_reg32(r1), imm));
}
#[no_mangle]
pub unsafe fn instr16_6A(imm8: i32) {
    return_on_pagefault!(push16(imm8));
}
#[no_mangle]
pub unsafe fn instr32_6A(imm8: i32) {
    return_on_pagefault!(push32(imm8));
}
#[no_mangle]
pub unsafe fn instr16_6B_mem(addr: i32, r: i32, imm: i32) {
    write_reg16(r, imul_reg16(return_on_pagefault!(safe_read16(addr)), imm));
}
#[no_mangle]
pub unsafe fn instr16_6B_reg(r1: i32, r: i32, imm: i32) {
    write_reg16(r, imul_reg16(read_reg16(r1), imm));
}
#[no_mangle]
pub unsafe fn instr32_6B_mem(addr: i32, r: i32, imm: i32) {
    write_reg32(r, imul_reg32(return_on_pagefault!(safe_read32s(addr)), imm));
}
#[no_mangle]
pub unsafe fn instr32_6B_reg(r1: i32, r: i32, imm: i32) {
    write_reg32(r, imul_reg32(read_reg32(r1), imm));
}
#[no_mangle]
pub unsafe fn instr_6C() { insb_no_rep(); }
#[no_mangle]
pub unsafe fn instr16_6D() { insw_no_rep(); }
#[no_mangle]
pub unsafe fn instr32_6D() { insd_no_rep(); }
#[no_mangle]
pub unsafe fn instr_6E() { outsb_no_rep(); }
#[no_mangle]
pub unsafe fn instr16_6F() { outsw_no_rep(); }
#[no_mangle]
pub unsafe fn instr32_6F() { outsd_no_rep(); }
#[no_mangle]
pub unsafe fn instr_80_0_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE8!(___, addr, add8(___, imm));
}
#[no_mangle]
pub unsafe fn instr_80_0_reg(r1: i32, imm: i32) { write_reg8(r1, add8(read_reg8(r1), imm)); }
#[no_mangle]
pub unsafe fn instr_80_1_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE8!(___, addr, or8(___, imm));
}
#[no_mangle]
pub unsafe fn instr_80_1_reg(r1: i32, imm: i32) { write_reg8(r1, or8(read_reg8(r1), imm)); }
#[no_mangle]
pub unsafe fn instr_80_2_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE8!(___, addr, adc8(___, imm));
}
#[no_mangle]
pub unsafe fn instr_80_2_reg(r1: i32, imm: i32) { write_reg8(r1, adc8(read_reg8(r1), imm)); }
#[no_mangle]
pub unsafe fn instr_80_3_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE8!(___, addr, sbb8(___, imm));
}
#[no_mangle]
pub unsafe fn instr_80_3_reg(r1: i32, imm: i32) { write_reg8(r1, sbb8(read_reg8(r1), imm)); }
#[no_mangle]
pub unsafe fn instr_80_4_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE8!(___, addr, and8(___, imm));
}
#[no_mangle]
pub unsafe fn instr_80_4_reg(r1: i32, imm: i32) { write_reg8(r1, and8(read_reg8(r1), imm)); }
#[no_mangle]
pub unsafe fn instr_80_5_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE8!(___, addr, sub8(___, imm));
}
#[no_mangle]
pub unsafe fn instr_80_5_reg(r1: i32, imm: i32) { write_reg8(r1, sub8(read_reg8(r1), imm)); }
#[no_mangle]
pub unsafe fn instr_80_6_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE8!(___, addr, xor8(___, imm));
}
#[no_mangle]
pub unsafe fn instr_80_6_reg(r1: i32, imm: i32) { write_reg8(r1, xor8(read_reg8(r1), imm)); }
#[no_mangle]
pub unsafe fn instr_80_7_reg(r: i32, imm: i32) { cmp8(read_reg8(r), imm); }
#[no_mangle]
pub unsafe fn instr_80_7_mem(addr: i32, imm: i32) {
    cmp8(return_on_pagefault!(safe_read8(addr)), imm);
}
#[no_mangle]
pub unsafe fn instr16_81_0_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE16!(___, addr, add16(___, imm));
}
#[no_mangle]
pub unsafe fn instr16_81_0_reg(r1: i32, imm: i32) { write_reg16(r1, add16(read_reg16(r1), imm)); }
#[no_mangle]
pub unsafe fn instr16_81_1_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE16!(___, addr, or16(___, imm));
}
#[no_mangle]
pub unsafe fn instr16_81_1_reg(r1: i32, imm: i32) { write_reg16(r1, or16(read_reg16(r1), imm)); }
#[no_mangle]
pub unsafe fn instr16_81_2_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE16!(___, addr, adc16(___, imm));
}
#[no_mangle]
pub unsafe fn instr16_81_2_reg(r1: i32, imm: i32) { write_reg16(r1, adc16(read_reg16(r1), imm)); }
#[no_mangle]
pub unsafe fn instr16_81_3_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE16!(___, addr, sbb16(___, imm));
}
#[no_mangle]
pub unsafe fn instr16_81_3_reg(r1: i32, imm: i32) { write_reg16(r1, sbb16(read_reg16(r1), imm)); }
#[no_mangle]
pub unsafe fn instr16_81_4_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE16!(___, addr, and16(___, imm));
}
#[no_mangle]
pub unsafe fn instr16_81_4_reg(r1: i32, imm: i32) { write_reg16(r1, and16(read_reg16(r1), imm)); }
#[no_mangle]
pub unsafe fn instr16_81_5_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE16!(___, addr, sub16(___, imm));
}
#[no_mangle]
pub unsafe fn instr16_81_5_reg(r1: i32, imm: i32) { write_reg16(r1, sub16(read_reg16(r1), imm)); }
#[no_mangle]
pub unsafe fn instr16_81_6_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE16!(___, addr, xor16(___, imm));
}
#[no_mangle]
pub unsafe fn instr16_81_6_reg(r1: i32, imm: i32) { write_reg16(r1, xor16(read_reg16(r1), imm)); }
#[no_mangle]
pub unsafe fn instr16_81_7_reg(r: i32, imm: i32) { cmp16(read_reg16(r), imm); }
#[no_mangle]
pub unsafe fn instr16_81_7_mem(addr: i32, imm: i32) {
    cmp16(return_on_pagefault!(safe_read16(addr)), imm);
}
#[no_mangle]
pub unsafe fn instr32_81_0_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE32!(___, addr, add32(___, imm));
}
#[no_mangle]
pub unsafe fn instr32_81_0_reg(r1: i32, imm: i32) { write_reg32(r1, add32(read_reg32(r1), imm)); }
#[no_mangle]
pub unsafe fn instr32_81_1_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE32!(___, addr, or32(___, imm));
}
#[no_mangle]
pub unsafe fn instr32_81_1_reg(r1: i32, imm: i32) { write_reg32(r1, or32(read_reg32(r1), imm)); }
#[no_mangle]
pub unsafe fn instr32_81_2_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE32!(___, addr, adc32(___, imm));
}
#[no_mangle]
pub unsafe fn instr32_81_2_reg(r1: i32, imm: i32) { write_reg32(r1, adc32(read_reg32(r1), imm)); }
#[no_mangle]
pub unsafe fn instr32_81_3_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE32!(___, addr, sbb32(___, imm));
}
#[no_mangle]
pub unsafe fn instr32_81_3_reg(r1: i32, imm: i32) { write_reg32(r1, sbb32(read_reg32(r1), imm)); }
#[no_mangle]
pub unsafe fn instr32_81_4_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE32!(___, addr, and32(___, imm));
}
#[no_mangle]
pub unsafe fn instr32_81_4_reg(r1: i32, imm: i32) { write_reg32(r1, and32(read_reg32(r1), imm)); }
#[no_mangle]
pub unsafe fn instr32_81_5_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE32!(___, addr, sub32(___, imm));
}
#[no_mangle]
pub unsafe fn instr32_81_5_reg(r1: i32, imm: i32) { write_reg32(r1, sub32(read_reg32(r1), imm)); }
#[no_mangle]
pub unsafe fn instr32_81_6_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE32!(___, addr, xor32(___, imm));
}
#[no_mangle]
pub unsafe fn instr32_81_6_reg(r1: i32, imm: i32) { write_reg32(r1, xor32(read_reg32(r1), imm)); }
#[no_mangle]
pub unsafe fn instr32_81_7_reg(r: i32, imm: i32) { cmp32(read_reg32(r), imm); }
#[no_mangle]
pub unsafe fn instr32_81_7_mem(addr: i32, imm: i32) {
    cmp32(return_on_pagefault!(safe_read32s(addr)), imm);
}
#[no_mangle]
pub unsafe fn instr_82_0_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE8!(___, addr, add8(___, imm));
}
#[no_mangle]
pub unsafe fn instr_82_0_reg(r1: i32, imm: i32) { write_reg8(r1, add8(read_reg8(r1), imm)); }
#[no_mangle]
pub unsafe fn instr_82_1_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE8!(___, addr, or8(___, imm));
}
#[no_mangle]
pub unsafe fn instr_82_1_reg(r1: i32, imm: i32) { write_reg8(r1, or8(read_reg8(r1), imm)); }
#[no_mangle]
pub unsafe fn instr_82_2_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE8!(___, addr, adc8(___, imm));
}
#[no_mangle]
pub unsafe fn instr_82_2_reg(r1: i32, imm: i32) { write_reg8(r1, adc8(read_reg8(r1), imm)); }
#[no_mangle]
pub unsafe fn instr_82_3_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE8!(___, addr, sbb8(___, imm));
}
#[no_mangle]
pub unsafe fn instr_82_3_reg(r1: i32, imm: i32) { write_reg8(r1, sbb8(read_reg8(r1), imm)); }
#[no_mangle]
pub unsafe fn instr_82_4_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE8!(___, addr, and8(___, imm));
}
#[no_mangle]
pub unsafe fn instr_82_4_reg(r1: i32, imm: i32) { write_reg8(r1, and8(read_reg8(r1), imm)); }
#[no_mangle]
pub unsafe fn instr_82_5_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE8!(___, addr, sub8(___, imm));
}
#[no_mangle]
pub unsafe fn instr_82_5_reg(r1: i32, imm: i32) { write_reg8(r1, sub8(read_reg8(r1), imm)); }
#[no_mangle]
pub unsafe fn instr_82_6_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE8!(___, addr, xor8(___, imm));
}
#[no_mangle]
pub unsafe fn instr_82_6_reg(r1: i32, imm: i32) { write_reg8(r1, xor8(read_reg8(r1), imm)); }
#[no_mangle]
pub unsafe fn instr_82_7_reg(r: i32, imm: i32) { cmp8(read_reg8(r), imm); }
#[no_mangle]
pub unsafe fn instr_82_7_mem(addr: i32, imm: i32) {
    cmp8(return_on_pagefault!(safe_read8(addr)), imm);
}
#[no_mangle]
pub unsafe fn instr16_83_0_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE16!(___, addr, add16(___, imm));
}
#[no_mangle]
pub unsafe fn instr16_83_0_reg(r1: i32, imm: i32) { write_reg16(r1, add16(read_reg16(r1), imm)); }
#[no_mangle]
pub unsafe fn instr16_83_1_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE16!(___, addr, or16(___, imm));
}
#[no_mangle]
pub unsafe fn instr16_83_1_reg(r1: i32, imm: i32) { write_reg16(r1, or16(read_reg16(r1), imm)); }
#[no_mangle]
pub unsafe fn instr16_83_2_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE16!(___, addr, adc16(___, imm));
}
#[no_mangle]
pub unsafe fn instr16_83_2_reg(r1: i32, imm: i32) { write_reg16(r1, adc16(read_reg16(r1), imm)); }
#[no_mangle]
pub unsafe fn instr16_83_3_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE16!(___, addr, sbb16(___, imm));
}
#[no_mangle]
pub unsafe fn instr16_83_3_reg(r1: i32, imm: i32) { write_reg16(r1, sbb16(read_reg16(r1), imm)); }
#[no_mangle]
pub unsafe fn instr16_83_4_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE16!(___, addr, and16(___, imm));
}
#[no_mangle]
pub unsafe fn instr16_83_4_reg(r1: i32, imm: i32) { write_reg16(r1, and16(read_reg16(r1), imm)); }
#[no_mangle]
pub unsafe fn instr16_83_5_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE16!(___, addr, sub16(___, imm));
}
#[no_mangle]
pub unsafe fn instr16_83_5_reg(r1: i32, imm: i32) { write_reg16(r1, sub16(read_reg16(r1), imm)); }
#[no_mangle]
pub unsafe fn instr16_83_6_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE16!(___, addr, xor16(___, imm));
}
#[no_mangle]
pub unsafe fn instr16_83_6_reg(r1: i32, imm: i32) { write_reg16(r1, xor16(read_reg16(r1), imm)); }
#[no_mangle]
pub unsafe fn instr16_83_7_reg(r: i32, imm: i32) { cmp16(read_reg16(r), imm); }
#[no_mangle]
pub unsafe fn instr16_83_7_mem(addr: i32, imm: i32) {
    cmp16(return_on_pagefault!(safe_read16(addr)), imm);
}
#[no_mangle]
pub unsafe fn instr32_83_0_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE32!(___, addr, add32(___, imm));
}
#[no_mangle]
pub unsafe fn instr32_83_0_reg(r1: i32, imm: i32) { write_reg32(r1, add32(read_reg32(r1), imm)); }
#[no_mangle]
pub unsafe fn instr32_83_1_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE32!(___, addr, or32(___, imm));
}
#[no_mangle]
pub unsafe fn instr32_83_1_reg(r1: i32, imm: i32) { write_reg32(r1, or32(read_reg32(r1), imm)); }
#[no_mangle]
pub unsafe fn instr32_83_2_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE32!(___, addr, adc32(___, imm));
}
#[no_mangle]
pub unsafe fn instr32_83_2_reg(r1: i32, imm: i32) { write_reg32(r1, adc32(read_reg32(r1), imm)); }
#[no_mangle]
pub unsafe fn instr32_83_3_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE32!(___, addr, sbb32(___, imm));
}
#[no_mangle]
pub unsafe fn instr32_83_3_reg(r1: i32, imm: i32) { write_reg32(r1, sbb32(read_reg32(r1), imm)); }
#[no_mangle]
pub unsafe fn instr32_83_4_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE32!(___, addr, and32(___, imm));
}
#[no_mangle]
pub unsafe fn instr32_83_4_reg(r1: i32, imm: i32) { write_reg32(r1, and32(read_reg32(r1), imm)); }
#[no_mangle]
pub unsafe fn instr32_83_5_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE32!(___, addr, sub32(___, imm));
}
#[no_mangle]
pub unsafe fn instr32_83_5_reg(r1: i32, imm: i32) { write_reg32(r1, sub32(read_reg32(r1), imm)); }
#[no_mangle]
pub unsafe fn instr32_83_6_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE32!(___, addr, xor32(___, imm));
}
#[no_mangle]
pub unsafe fn instr32_83_6_reg(r1: i32, imm: i32) { write_reg32(r1, xor32(read_reg32(r1), imm)); }
#[no_mangle]
pub unsafe fn instr32_83_7_reg(r: i32, imm: i32) { cmp32(read_reg32(r), imm); }
#[no_mangle]
pub unsafe fn instr32_83_7_mem(addr: i32, imm: i32) {
    cmp32(return_on_pagefault!(safe_read32s(addr)), imm);
}
#[no_mangle]
pub unsafe fn instr_84_mem(addr: i32, r: i32) {
    test8(return_on_pagefault!(safe_read8(addr)), read_reg8(r));
}
#[no_mangle]
pub unsafe fn instr_84_reg(r1: i32, r: i32) { test8(read_reg8(r1), read_reg8(r)); }
#[no_mangle]
pub unsafe fn instr16_85_mem(addr: i32, r: i32) {
    test16(return_on_pagefault!(safe_read16(addr)), read_reg16(r));
}
#[no_mangle]
pub unsafe fn instr16_85_reg(r1: i32, r: i32) { test16(read_reg16(r1), read_reg16(r)); }
#[no_mangle]
pub unsafe fn instr32_85_mem(addr: i32, r: i32) {
    test32(return_on_pagefault!(safe_read32s(addr)), read_reg32(r));
}
#[no_mangle]
pub unsafe fn instr32_85_reg(r1: i32, r: i32) { test32(read_reg32(r1), read_reg32(r)); }
#[no_mangle]
pub unsafe fn instr_86_mem(addr: i32, r: i32) {
    SAFE_READ_WRITE8!(___, addr, xchg8(___, get_reg8_index(r)));
}
#[no_mangle]
pub unsafe fn instr_86_reg(r1: i32, r: i32) {
    write_reg8(r1, xchg8(read_reg8(r1), get_reg8_index(r)));
}
#[no_mangle]
pub unsafe fn instr16_87_mem(addr: i32, r: i32) {
    SAFE_READ_WRITE16!(___, addr, xchg16(___, get_reg16_index(r)));
}
#[no_mangle]
pub unsafe fn instr16_87_reg(r1: i32, r: i32) {
    write_reg16(r1, xchg16(read_reg16(r1), get_reg16_index(r)));
}
#[no_mangle]
pub unsafe fn instr32_87_mem(addr: i32, r: i32) {
    SAFE_READ_WRITE32!(___, addr, xchg32(___, r));
}
#[no_mangle]
pub unsafe fn instr32_87_reg(r1: i32, r: i32) { write_reg32(r1, xchg32(read_reg32(r1), r)); }
#[no_mangle]
pub unsafe fn instr_88_reg(r2: i32, r: i32) { write_reg8(r2, read_reg8(r)); }
#[no_mangle]
pub unsafe fn instr_88_mem(addr: i32, r: i32) {
    return_on_pagefault!(safe_write8(addr, read_reg8(r)));
}
#[no_mangle]
pub unsafe fn instr16_89_reg(r2: i32, r: i32) { write_reg16(r2, read_reg16(r)); }
#[no_mangle]
pub unsafe fn instr16_89_mem(addr: i32, r: i32) {
    return_on_pagefault!(safe_write16(addr, read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr32_89_reg(r2: i32, r: i32) { write_reg32(r2, read_reg32(r)); }
#[no_mangle]
pub unsafe fn instr32_89_mem(addr: i32, r: i32) {
    return_on_pagefault!(safe_write32(addr, read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr_8A_mem(addr: i32, r: i32) {
    write_reg8(r, return_on_pagefault!(safe_read8(addr)));
}
#[no_mangle]
pub unsafe fn instr_8A_reg(r1: i32, r: i32) { write_reg8(r, read_reg8(r1)); }
#[no_mangle]
pub unsafe fn instr16_8B_mem(addr: i32, r: i32) {
    write_reg16(r, return_on_pagefault!(safe_read16(addr)));
}
#[no_mangle]
pub unsafe fn instr16_8B_reg(r1: i32, r: i32) { write_reg16(r, read_reg16(r1)); }
#[no_mangle]
pub unsafe fn instr32_8B_mem(addr: i32, r: i32) {
    write_reg32(r, return_on_pagefault!(safe_read32s(addr)));
}
#[no_mangle]
pub unsafe fn instr32_8B_reg(r1: i32, r: i32) { write_reg32(r, read_reg32(r1)); }
#[no_mangle]
pub unsafe fn instr_8C_check_sreg(seg: i32) -> bool {
    if seg >= 6 {
        dbg_log!("mov sreg #ud");
        trigger_ud();
        return false;
    }
    else {
        return true;
    };
}
#[no_mangle]
pub unsafe fn instr16_8C_reg(r: i32, seg: i32) {
    if instr_8C_check_sreg(seg) {
        write_reg16(r, *sreg.offset(seg as isize) as i32);
    };
}
#[no_mangle]
pub unsafe fn instr16_8C_mem(addr: i32, seg: i32) {
    if instr_8C_check_sreg(seg) {
        return_on_pagefault!(safe_write16(addr, *sreg.offset(seg as isize) as i32));
    };
}
#[no_mangle]
pub unsafe fn instr32_8C_reg(r: i32, seg: i32) {
    if instr_8C_check_sreg(seg) {
        write_reg32(r, *sreg.offset(seg as isize) as i32);
    };
}
#[no_mangle]
pub unsafe fn instr32_8C_mem(addr: i32, seg: i32) {
    if instr_8C_check_sreg(seg) {
        return_on_pagefault!(safe_write16(addr, *sreg.offset(seg as isize) as i32));
    };
}
#[no_mangle]
pub unsafe fn instr16_8D_reg(r: i32, r2: i32) {
    dbg_log!("lea #ud");
    trigger_ud();
}
#[no_mangle]
pub unsafe fn instr16_8D_mem(modrm_byte: i32, r: i32) {
    // lea
    *prefixes = (*prefixes as i32 | SEG_PREFIX_ZERO) as u8;
    if let Ok(addr) = modrm_resolve(modrm_byte) {
        write_reg16(r, addr);
    }
    *prefixes = 0;
}
#[no_mangle]
pub unsafe fn instr32_8D_reg(r: i32, r2: i32) {
    dbg_log!("lea #ud");
    trigger_ud();
}
#[no_mangle]
pub unsafe fn instr32_8D_mem(modrm_byte: i32, r: i32) {
    // lea
    // override prefix, so modrm_resolve does not return the segment part
    *prefixes = (*prefixes as i32 | SEG_PREFIX_ZERO) as u8;
    if let Ok(addr) = modrm_resolve(modrm_byte) {
        write_reg32(r, addr);
    }
    *prefixes = 0;
}
#[no_mangle]
pub unsafe fn instr_8E_helper(data: i32, mod_0: i32) {
    if mod_0 == ES || mod_0 == SS || mod_0 == DS || mod_0 == FS || mod_0 == GS {
        if !switch_seg(mod_0, data) {
            return;
        }
    }
    else {
        dbg_log!("mov sreg #ud");
        trigger_ud();
    };
}
#[no_mangle]
pub unsafe fn instr_8E_mem(addr: i32, r: i32) {
    instr_8E_helper(return_on_pagefault!(safe_read16(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_8E_reg(r1: i32, r: i32) { instr_8E_helper(read_reg16(r1), r); }

#[no_mangle]
pub unsafe fn instr16_8F_0_mem(modrm_byte: i32) {
    // pop
    // Update esp *before* resolving the address
    adjust_stack_reg(2);
    match modrm_resolve(modrm_byte) {
        Err(()) => {
            // a pagefault happened, reset esp
            adjust_stack_reg(-2);
        },
        Ok(addr) => {
            adjust_stack_reg(-2);
            let stack_value = return_on_pagefault!(safe_read16(get_stack_pointer(0)));
            return_on_pagefault!(safe_write16(addr, stack_value));
            adjust_stack_reg(2);
        },
    }
}

#[no_mangle]
pub unsafe fn instr16_8F_0_reg(r: i32) { write_reg16(r, return_on_pagefault!(pop16())); }
#[no_mangle]
pub unsafe fn instr32_8F_0_mem(modrm_byte: i32) {
    // Update esp *before* resolving the address
    adjust_stack_reg(4);
    match modrm_resolve(modrm_byte) {
        Err(()) => {
            // a pagefault happened, reset esp
            adjust_stack_reg(-4);
        },
        Ok(addr) => {
            adjust_stack_reg(-4);
            let stack_value = return_on_pagefault!(safe_read32s(get_stack_pointer(0)));
            return_on_pagefault!(safe_write32(addr, stack_value));
            adjust_stack_reg(4);
        },
    }
}

#[no_mangle]
pub unsafe fn instr32_8F_0_reg(r: i32) { write_reg32(r, return_on_pagefault!(pop32s())); }

#[no_mangle]
pub unsafe fn instr_90() {}
#[no_mangle]
pub unsafe fn instr16_91() { xchg16r(CX); }
#[no_mangle]
pub unsafe fn instr32_91() { xchg32r(ECX); }
#[no_mangle]
pub unsafe fn instr16_92() { xchg16r(DX); }
#[no_mangle]
pub unsafe fn instr32_92() { xchg32r(EDX); }
#[no_mangle]
pub unsafe fn instr16_93() { xchg16r(BX); }
#[no_mangle]
pub unsafe fn instr32_93() { xchg32r(EBX); }
#[no_mangle]
pub unsafe fn instr16_94() { xchg16r(SP); }
#[no_mangle]
pub unsafe fn instr32_94() { xchg32r(ESP); }
#[no_mangle]
pub unsafe fn instr16_95() { xchg16r(BP); }
#[no_mangle]
pub unsafe fn instr32_95() { xchg32r(EBP); }
#[no_mangle]
pub unsafe fn instr16_96() { xchg16r(SI); }
#[no_mangle]
pub unsafe fn instr32_96() { xchg32r(ESI); }
#[no_mangle]
pub unsafe fn instr16_97() { xchg16r(DI); }
#[no_mangle]
pub unsafe fn instr32_97() { xchg32r(EDI); }
#[no_mangle]
pub unsafe fn instr16_98() { *reg16.offset(AX as isize) = *reg8s.offset(AL as isize) as u16; }
#[no_mangle]
pub unsafe fn instr32_98() { *reg32.offset(EAX as isize) = *reg16s.offset(AX as isize) as i32; }
#[no_mangle]
pub unsafe fn instr16_99() {
    *reg16.offset(DX as isize) = (*reg16s.offset(AX as isize) as i32 >> 15) as u16;
}
#[no_mangle]
pub unsafe fn instr32_99() { *reg32.offset(EDX as isize) = *reg32.offset(EAX as isize) >> 31; }
#[no_mangle]
pub unsafe fn instr16_9A(new_ip: i32, new_cs: i32) {
    // callf
    far_jump(new_ip, new_cs, true);
    dbg_assert!(is_asize_32() || get_real_eip() < 0x10000);
}
#[no_mangle]
pub unsafe fn instr32_9A(new_ip: i32, new_cs: i32) {
    if !*protected_mode || vm86_mode() {
        if 0 != new_ip as u32 & 0xFFFF0000 {
            dbg_assert!(false);
        }
    }
    far_jump(new_ip, new_cs, true);
    dbg_assert!(is_asize_32() || get_real_eip() < 0x10000);
}
#[no_mangle]
pub unsafe fn instr_9B() {
    // fwait: check for pending fpu exceptions
    if *cr & (CR0_MP | CR0_TS) == CR0_MP | CR0_TS {
        // Note: Different from task_switch_test
        // Triggers when TS and MP bits are set (EM bit is ignored)
        trigger_nm();
    }
    else {
        fwait();
    };
}
#[no_mangle]
pub unsafe fn instr_9C_check() -> bool { 0 != *flags & FLAG_VM && getiopl() < 3 }
#[no_mangle]
pub unsafe fn instr16_9C() {
    // pushf
    if instr_9C_check() {
        dbg_assert!(*protected_mode);
        dbg_log!("pushf #gp");
        trigger_gp(0);
    }
    else {
        return_on_pagefault!(push16(get_eflags()));
    };
}
#[no_mangle]
pub unsafe fn instr32_9C() {
    // pushf
    if instr_9C_check() {
        // trap to virtual 8086 monitor
        dbg_assert!(*protected_mode);
        dbg_log!("pushf #gp");
        trigger_gp(0);
    }
    else {
        // vm and rf flag are cleared in image stored on the stack
        return_on_pagefault!(push32(get_eflags() & 0xFCFFFF));
    };
}
#[no_mangle]
pub unsafe fn instr16_9D() {
    // popf
    if 0 != *flags & FLAG_VM && getiopl() < 3 {
        dbg_log!("popf #gp");
        trigger_gp(0);
        return;
    }
    else {
        let old_eflags = *flags;
        update_eflags(*flags & !0xFFFF | return_on_pagefault!(pop16()));
        if old_eflags & FLAG_INTERRUPT == 0 && *flags & FLAG_INTERRUPT != 0 {
            handle_irqs();
        }
        if *flags & FLAG_TRAP != 0 {
            dbg_log!("Not supported: trap flag");
        }
        *flags &= !FLAG_TRAP;
        return;
    };
}
#[no_mangle]
pub unsafe fn instr32_9D() {
    // popf
    if 0 != *flags & FLAG_VM && getiopl() < 3 {
        dbg_log!("popf #gp");
        trigger_gp(0);
        return;
    }
    else {
        let old_eflags = *flags;
        update_eflags(return_on_pagefault!(pop32s()));
        if old_eflags & FLAG_INTERRUPT == 0 && *flags & FLAG_INTERRUPT != 0 {
            handle_irqs();
        }
        if *flags & FLAG_TRAP != 0 {
            dbg_log!("Not supported: trap flag");
        }
        *flags &= !FLAG_TRAP;
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_9E() {
    // sahf
    *flags = *flags & !255 | *reg8.offset(AH as isize) as i32;
    *flags = *flags & FLAGS_MASK | FLAGS_DEFAULT;
    *flags_changed &= !255;
}
#[no_mangle]
pub unsafe fn instr_9F() {
    // lahf
    *reg8.offset(AH as isize) = get_eflags() as u8;
}
#[no_mangle]
pub unsafe fn instr_A0(moffs: i32) {
    // mov
    let data = return_on_pagefault!(safe_read8(get_seg_prefix_ds(moffs)));
    *reg8.offset(AL as isize) = data as u8;
}
#[no_mangle]
pub unsafe fn instr16_A1(moffs: i32) {
    // mov
    let data = return_on_pagefault!(safe_read16(get_seg_prefix_ds(moffs)));
    *reg16.offset(AX as isize) = data as u16;
}
#[no_mangle]
pub unsafe fn instr32_A1(moffs: i32) {
    let data = return_on_pagefault!(safe_read32s(get_seg_prefix_ds(moffs)));
    *reg32.offset(EAX as isize) = data;
}
#[no_mangle]
pub unsafe fn instr_A2(moffs: i32) {
    // mov
    return_on_pagefault!(safe_write8(
        get_seg_prefix_ds(moffs),
        *reg8.offset(AL as isize) as i32
    ));
}
#[no_mangle]
pub unsafe fn instr16_A3(moffs: i32) {
    // mov
    return_on_pagefault!(safe_write16(
        get_seg_prefix_ds(moffs),
        *reg16.offset(AX as isize) as i32
    ));
}
#[no_mangle]
pub unsafe fn instr32_A3(moffs: i32) {
    return_on_pagefault!(safe_write32(
        get_seg_prefix_ds(moffs),
        *reg32.offset(EAX as isize)
    ));
}
#[no_mangle]
pub unsafe fn instr_A4() { movsb_no_rep(); }
#[no_mangle]
pub unsafe fn instr16_A5() { movsw_no_rep(); }
#[no_mangle]
pub unsafe fn instr32_A5() { movsd_no_rep(); }
#[no_mangle]
pub unsafe fn instr_A6() { cmpsb_no_rep(); }
#[no_mangle]
pub unsafe fn instr16_A7() { cmpsw_no_rep(); }
#[no_mangle]
pub unsafe fn instr32_A7() { cmpsd_no_rep(); }
#[no_mangle]
pub unsafe fn instr_A8(imm8: i32) { test8(*reg8.offset(AL as isize) as i32, imm8); }
#[no_mangle]
pub unsafe fn instr16_A9(imm16: i32) { test16(*reg16.offset(AX as isize) as i32, imm16); }
#[no_mangle]
pub unsafe fn instr32_A9(imm32: i32) { test32(*reg32.offset(EAX as isize), imm32); }
#[no_mangle]
pub unsafe fn instr_AA() { stosb_no_rep(); }
#[no_mangle]
pub unsafe fn instr16_AB() { stosw_no_rep(); }
#[no_mangle]
pub unsafe fn instr32_AB() { stosd_no_rep(); }
#[no_mangle]
pub unsafe fn instr_AC() { lodsb_no_rep(); }
#[no_mangle]
pub unsafe fn instr16_AD() { lodsw_no_rep(); }
#[no_mangle]
pub unsafe fn instr32_AD() { lodsd_no_rep(); }
#[no_mangle]
pub unsafe fn instr_AE() { scasb_no_rep(); }
#[no_mangle]
pub unsafe fn instr16_AF() { scasw_no_rep(); }
#[no_mangle]
pub unsafe fn instr32_AF() { scasd_no_rep(); }

pub unsafe fn instr_B0(imm8: i32) { *reg8.offset(AL as isize) = imm8 as u8; }
pub unsafe fn instr_B1(imm8: i32) { *reg8.offset(CL as isize) = imm8 as u8; }
pub unsafe fn instr_B2(imm8: i32) { *reg8.offset(DL as isize) = imm8 as u8; }
pub unsafe fn instr_B3(imm8: i32) { *reg8.offset(BL as isize) = imm8 as u8; }
pub unsafe fn instr_B4(imm8: i32) { *reg8.offset(AH as isize) = imm8 as u8; }
pub unsafe fn instr_B5(imm8: i32) { *reg8.offset(CH as isize) = imm8 as u8; }
pub unsafe fn instr_B6(imm8: i32) { *reg8.offset(DH as isize) = imm8 as u8; }
pub unsafe fn instr_B7(imm8: i32) { *reg8.offset(BH as isize) = imm8 as u8; }
pub unsafe fn instr16_B8(imm: i32) { *reg16.offset(AX as isize) = imm as u16; }
pub unsafe fn instr32_B8(imm: i32) { *reg32.offset(EAX as isize) = imm; }
pub unsafe fn instr16_B9(imm: i32) { *reg16.offset(CX as isize) = imm as u16; }
pub unsafe fn instr32_B9(imm: i32) { *reg32.offset(ECX as isize) = imm; }
pub unsafe fn instr16_BA(imm: i32) { *reg16.offset(DX as isize) = imm as u16; }
pub unsafe fn instr32_BA(imm: i32) { *reg32.offset(EDX as isize) = imm; }
pub unsafe fn instr16_BB(imm: i32) { *reg16.offset(BX as isize) = imm as u16; }
pub unsafe fn instr32_BB(imm: i32) { *reg32.offset(EBX as isize) = imm; }
pub unsafe fn instr16_BC(imm: i32) { *reg16.offset(SP as isize) = imm as u16; }
pub unsafe fn instr32_BC(imm: i32) { *reg32.offset(ESP as isize) = imm; }
pub unsafe fn instr16_BD(imm: i32) { *reg16.offset(BP as isize) = imm as u16; }
pub unsafe fn instr32_BD(imm: i32) { *reg32.offset(EBP as isize) = imm; }
pub unsafe fn instr16_BE(imm: i32) { *reg16.offset(SI as isize) = imm as u16; }
pub unsafe fn instr32_BE(imm: i32) { *reg32.offset(ESI as isize) = imm; }
pub unsafe fn instr16_BF(imm: i32) { *reg16.offset(DI as isize) = imm as u16; }
pub unsafe fn instr32_BF(imm: i32) { *reg32.offset(EDI as isize) = imm; }

#[no_mangle]
pub unsafe fn instr_C0_0_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE8!(___, addr, rol8(___, imm & 31));
}
#[no_mangle]
pub unsafe fn instr_C0_0_reg(r1: i32, imm: i32) { write_reg8(r1, rol8(read_reg8(r1), imm & 31)); }
#[no_mangle]
pub unsafe fn instr_C0_1_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE8!(___, addr, ror8(___, imm & 31));
}
#[no_mangle]
pub unsafe fn instr_C0_1_reg(r1: i32, imm: i32) { write_reg8(r1, ror8(read_reg8(r1), imm & 31)); }
#[no_mangle]
pub unsafe fn instr_C0_2_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE8!(___, addr, rcl8(___, imm & 31));
}
#[no_mangle]
pub unsafe fn instr_C0_2_reg(r1: i32, imm: i32) { write_reg8(r1, rcl8(read_reg8(r1), imm & 31)); }
#[no_mangle]
pub unsafe fn instr_C0_3_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE8!(___, addr, rcr8(___, imm & 31));
}
#[no_mangle]
pub unsafe fn instr_C0_3_reg(r1: i32, imm: i32) { write_reg8(r1, rcr8(read_reg8(r1), imm & 31)); }
#[no_mangle]
pub unsafe fn instr_C0_4_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE8!(___, addr, shl8(___, imm & 31));
}
#[no_mangle]
pub unsafe fn instr_C0_4_reg(r1: i32, imm: i32) { write_reg8(r1, shl8(read_reg8(r1), imm & 31)); }
#[no_mangle]
pub unsafe fn instr_C0_5_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE8!(___, addr, shr8(___, imm & 31));
}
#[no_mangle]
pub unsafe fn instr_C0_5_reg(r1: i32, imm: i32) { write_reg8(r1, shr8(read_reg8(r1), imm & 31)); }
#[no_mangle]
pub unsafe fn instr_C0_6_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE8!(___, addr, shl8(___, imm & 31));
}
#[no_mangle]
pub unsafe fn instr_C0_6_reg(r1: i32, imm: i32) { write_reg8(r1, shl8(read_reg8(r1), imm & 31)); }
#[no_mangle]
pub unsafe fn instr_C0_7_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE8!(___, addr, sar8(___, imm & 31));
}
#[no_mangle]
pub unsafe fn instr_C0_7_reg(r1: i32, imm: i32) { write_reg8(r1, sar8(read_reg8(r1), imm & 31)); }
#[no_mangle]
pub unsafe fn instr16_C1_0_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE16!(___, addr, rol16(___, imm & 31));
}
#[no_mangle]
pub unsafe fn instr16_C1_0_reg(r1: i32, imm: i32) {
    write_reg16(r1, rol16(read_reg16(r1), imm & 31));
}
#[no_mangle]
pub unsafe fn instr16_C1_1_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE16!(___, addr, ror16(___, imm & 31));
}
#[no_mangle]
pub unsafe fn instr16_C1_1_reg(r1: i32, imm: i32) {
    write_reg16(r1, ror16(read_reg16(r1), imm & 31));
}
#[no_mangle]
pub unsafe fn instr16_C1_2_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE16!(___, addr, rcl16(___, imm & 31));
}
#[no_mangle]
pub unsafe fn instr16_C1_2_reg(r1: i32, imm: i32) {
    write_reg16(r1, rcl16(read_reg16(r1), imm & 31));
}
#[no_mangle]
pub unsafe fn instr16_C1_3_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE16!(___, addr, rcr16(___, imm & 31));
}
#[no_mangle]
pub unsafe fn instr16_C1_3_reg(r1: i32, imm: i32) {
    write_reg16(r1, rcr16(read_reg16(r1), imm & 31));
}
#[no_mangle]
pub unsafe fn instr16_C1_4_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE16!(___, addr, shl16(___, imm & 31));
}
#[no_mangle]
pub unsafe fn instr16_C1_4_reg(r1: i32, imm: i32) {
    write_reg16(r1, shl16(read_reg16(r1), imm & 31));
}
#[no_mangle]
pub unsafe fn instr16_C1_5_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE16!(___, addr, shr16(___, imm & 31));
}
#[no_mangle]
pub unsafe fn instr16_C1_5_reg(r1: i32, imm: i32) {
    write_reg16(r1, shr16(read_reg16(r1), imm & 31));
}
#[no_mangle]
pub unsafe fn instr16_C1_6_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE16!(___, addr, shl16(___, imm & 31));
}
#[no_mangle]
pub unsafe fn instr16_C1_6_reg(r1: i32, imm: i32) {
    write_reg16(r1, shl16(read_reg16(r1), imm & 31));
}
#[no_mangle]
pub unsafe fn instr16_C1_7_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE16!(___, addr, sar16(___, imm & 31));
}
#[no_mangle]
pub unsafe fn instr16_C1_7_reg(r1: i32, imm: i32) {
    write_reg16(r1, sar16(read_reg16(r1), imm & 31));
}
#[no_mangle]
pub unsafe fn instr32_C1_0_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE32!(___, addr, rol32(___, imm & 31));
}
#[no_mangle]
pub unsafe fn instr32_C1_0_reg(r1: i32, imm: i32) {
    write_reg32(r1, rol32(read_reg32(r1), imm & 31));
}
#[no_mangle]
pub unsafe fn instr32_C1_1_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE32!(___, addr, ror32(___, imm & 31));
}
#[no_mangle]
pub unsafe fn instr32_C1_1_reg(r1: i32, imm: i32) {
    write_reg32(r1, ror32(read_reg32(r1), imm & 31));
}
#[no_mangle]
pub unsafe fn instr32_C1_2_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE32!(___, addr, rcl32(___, imm & 31));
}
#[no_mangle]
pub unsafe fn instr32_C1_2_reg(r1: i32, imm: i32) {
    write_reg32(r1, rcl32(read_reg32(r1), imm & 31));
}
#[no_mangle]
pub unsafe fn instr32_C1_3_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE32!(___, addr, rcr32(___, imm & 31));
}
#[no_mangle]
pub unsafe fn instr32_C1_3_reg(r1: i32, imm: i32) {
    write_reg32(r1, rcr32(read_reg32(r1), imm & 31));
}
#[no_mangle]
pub unsafe fn instr32_C1_4_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE32!(___, addr, shl32(___, imm & 31));
}
#[no_mangle]
pub unsafe fn instr32_C1_4_reg(r1: i32, imm: i32) {
    write_reg32(r1, shl32(read_reg32(r1), imm & 31));
}
#[no_mangle]
pub unsafe fn instr32_C1_5_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE32!(___, addr, shr32(___, imm & 31));
}
#[no_mangle]
pub unsafe fn instr32_C1_5_reg(r1: i32, imm: i32) {
    write_reg32(r1, shr32(read_reg32(r1), imm & 31));
}
#[no_mangle]
pub unsafe fn instr32_C1_6_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE32!(___, addr, shl32(___, imm & 31));
}
#[no_mangle]
pub unsafe fn instr32_C1_6_reg(r1: i32, imm: i32) {
    write_reg32(r1, shl32(read_reg32(r1), imm & 31));
}
#[no_mangle]
pub unsafe fn instr32_C1_7_mem(addr: i32, imm: i32) {
    SAFE_READ_WRITE32!(___, addr, sar32(___, imm & 31));
}
#[no_mangle]
pub unsafe fn instr32_C1_7_reg(r1: i32, imm: i32) {
    write_reg32(r1, sar32(read_reg32(r1), imm & 31));
}
#[no_mangle]
pub unsafe fn instr16_C2(imm16: i32) {
    // retn
    let cs = get_seg_cs();
    *instruction_pointer = cs + return_on_pagefault!(pop16());
    dbg_assert!(is_asize_32() || get_real_eip() < 0x10000);
    adjust_stack_reg(imm16);
}
#[no_mangle]
pub unsafe fn instr32_C2(imm16: i32) {
    // retn
    let cs = get_seg_cs();
    let ip = return_on_pagefault!(pop32s());
    dbg_assert!(is_asize_32() || ip < 0x10000);
    *instruction_pointer = cs + ip;
    adjust_stack_reg(imm16);
}
#[no_mangle]
pub unsafe fn instr16_C3() {
    // retn
    let cs = get_seg_cs();
    *instruction_pointer = cs + return_on_pagefault!(pop16());
}
#[no_mangle]
pub unsafe fn instr32_C3() {
    // retn
    let cs = get_seg_cs();
    let ip = return_on_pagefault!(pop32s());
    dbg_assert!(is_asize_32() || ip < 0x10000);
    *instruction_pointer = cs + ip;
}
#[no_mangle]
pub unsafe fn instr16_C4_reg(_unused1: i32, _unused2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr16_C4_mem(addr: i32, r: i32) { lss16(addr, get_reg16_index(r), ES); }
#[no_mangle]
pub unsafe fn instr32_C4_reg(_unused1: i32, _unused2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr32_C4_mem(addr: i32, r: i32) { lss32(addr, r, ES); }
#[no_mangle]
pub unsafe fn instr16_C5_reg(_unused1: i32, _unused2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr16_C5_mem(addr: i32, r: i32) { lss16(addr, get_reg16_index(r), DS); }
#[no_mangle]
pub unsafe fn instr32_C5_reg(_unused1: i32, _unused2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr32_C5_mem(addr: i32, r: i32) { lss32(addr, r, DS); }
#[no_mangle]
pub unsafe fn instr_C6_0_reg(r: i32, imm: i32) { write_reg8(r, imm); }
#[no_mangle]
pub unsafe fn instr_C6_0_mem(addr: i32, imm: i32) {
    return_on_pagefault!(safe_write8(addr, imm));
}
#[no_mangle]
pub unsafe fn instr16_C7_0_reg(r: i32, imm: i32) { write_reg16(r, imm); }
#[no_mangle]
pub unsafe fn instr16_C7_0_mem(addr: i32, imm: i32) {
    return_on_pagefault!(safe_write16(addr, imm));
}
#[no_mangle]
pub unsafe fn instr32_C7_0_reg(r: i32, imm: i32) { write_reg32(r, imm); }
#[no_mangle]
pub unsafe fn instr32_C7_0_mem(addr: i32, imm: i32) {
    return_on_pagefault!(safe_write32(addr, imm));
}
#[no_mangle]
pub unsafe fn instr16_C8(size: i32, nesting: i32) { enter16(size, nesting); }
#[no_mangle]
pub unsafe fn instr32_C8(size: i32, nesting: i32) { enter32(size, nesting); }
#[no_mangle]
pub unsafe fn instr16_C9() {
    // leave
    let old_vbp = if *stack_size_32 {
        *reg32.offset(EBP as isize)
    }
    else {
        *reg16.offset(BP as isize) as i32
    };
    let new_bp = return_on_pagefault!(safe_read16(get_seg_ss() + old_vbp));
    set_stack_reg(old_vbp + 2);
    *reg16.offset(BP as isize) = new_bp as u16;
}
#[no_mangle]
pub unsafe fn instr32_C9() {
    let old_vbp = if *stack_size_32 {
        *reg32.offset(EBP as isize)
    }
    else {
        *reg16.offset(BP as isize) as i32
    };
    let new_ebp = return_on_pagefault!(safe_read32s(get_seg_ss() + old_vbp));
    set_stack_reg(old_vbp + 4);
    *reg32.offset(EBP as isize) = new_ebp;
}
#[no_mangle]
pub unsafe fn instr16_CA(imm16: i32) {
    // retf
    let ip = return_on_pagefault!(safe_read16(get_stack_pointer(0)));
    let cs = return_on_pagefault!(safe_read16(get_stack_pointer(2)));
    far_return(ip, cs, imm16);
}
#[no_mangle]
pub unsafe fn instr32_CA(imm16: i32) {
    // retf
    let ip = return_on_pagefault!(safe_read32s(get_stack_pointer(0)));
    let cs = return_on_pagefault!(safe_read32s(get_stack_pointer(4))) & 0xFFFF;
    far_return(ip, cs, imm16);
    dbg_assert!(is_asize_32() || get_real_eip() < 0x10000);
}
#[no_mangle]
pub unsafe fn instr16_CB() {
    // retf
    let ip = return_on_pagefault!(safe_read16(get_stack_pointer(0)));
    let cs = return_on_pagefault!(safe_read16(get_stack_pointer(2)));
    far_return(ip, cs, 0);
    dbg_assert!(is_asize_32() || get_real_eip() < 0x10000);
}
#[no_mangle]
pub unsafe fn instr32_CB() {
    // retf
    let ip = return_on_pagefault!(safe_read32s(get_stack_pointer(0)));
    let cs = return_on_pagefault!(safe_read32s(get_stack_pointer(4))) & 0xFFFF;
    far_return(ip, cs, 0);
    dbg_assert!(is_asize_32() || get_real_eip() < 0x10000);
}
#[no_mangle]
pub unsafe fn instr_CC() {
    // INT3
    // TODO: inhibit iopl checks
    dbg_log!("INT3");
    call_interrupt_vector(3, true, None);
}
#[no_mangle]
pub unsafe fn instr_CD(imm8: i32) {
    // INT
    call_interrupt_vector(imm8, true, None);
}
#[no_mangle]
pub unsafe fn instr_CE() {
    // INTO
    dbg_log!("INTO");
    if getof() {
        // TODO: inhibit iopl checks
        call_interrupt_vector(CPU_EXCEPTION_OF, true, None);
    };
}
#[no_mangle]
pub unsafe fn instr16_CF() {
    // iret
    iret16();
}
#[no_mangle]
pub unsafe fn instr32_CF() { iret32(); }
#[no_mangle]
pub unsafe fn instr_D0_0_mem(addr: i32) {
    SAFE_READ_WRITE8!(___, addr, rol8(___, 1));
}
#[no_mangle]
pub unsafe fn instr_D0_0_reg(r1: i32) { write_reg8(r1, rol8(read_reg8(r1), 1)); }
#[no_mangle]
pub unsafe fn instr_D0_1_mem(addr: i32) {
    SAFE_READ_WRITE8!(___, addr, ror8(___, 1));
}
#[no_mangle]
pub unsafe fn instr_D0_1_reg(r1: i32) { write_reg8(r1, ror8(read_reg8(r1), 1)); }
#[no_mangle]
pub unsafe fn instr_D0_2_mem(addr: i32) {
    SAFE_READ_WRITE8!(___, addr, rcl8(___, 1));
}
#[no_mangle]
pub unsafe fn instr_D0_2_reg(r1: i32) { write_reg8(r1, rcl8(read_reg8(r1), 1)); }
#[no_mangle]
pub unsafe fn instr_D0_3_mem(addr: i32) {
    SAFE_READ_WRITE8!(___, addr, rcr8(___, 1));
}
#[no_mangle]
pub unsafe fn instr_D0_3_reg(r1: i32) { write_reg8(r1, rcr8(read_reg8(r1), 1)); }
#[no_mangle]
pub unsafe fn instr_D0_4_mem(addr: i32) {
    SAFE_READ_WRITE8!(___, addr, shl8(___, 1));
}
#[no_mangle]
pub unsafe fn instr_D0_4_reg(r1: i32) { write_reg8(r1, shl8(read_reg8(r1), 1)); }
#[no_mangle]
pub unsafe fn instr_D0_5_mem(addr: i32) {
    SAFE_READ_WRITE8!(___, addr, shr8(___, 1));
}
#[no_mangle]
pub unsafe fn instr_D0_5_reg(r1: i32) { write_reg8(r1, shr8(read_reg8(r1), 1)); }
#[no_mangle]
pub unsafe fn instr_D0_6_mem(addr: i32) {
    SAFE_READ_WRITE8!(___, addr, shl8(___, 1));
}
#[no_mangle]
pub unsafe fn instr_D0_6_reg(r1: i32) { write_reg8(r1, shl8(read_reg8(r1), 1)); }
#[no_mangle]
pub unsafe fn instr_D0_7_mem(addr: i32) {
    SAFE_READ_WRITE8!(___, addr, sar8(___, 1));
}
#[no_mangle]
pub unsafe fn instr_D0_7_reg(r1: i32) { write_reg8(r1, sar8(read_reg8(r1), 1)); }
#[no_mangle]
pub unsafe fn instr16_D1_0_mem(addr: i32) {
    SAFE_READ_WRITE16!(___, addr, rol16(___, 1));
}
#[no_mangle]
pub unsafe fn instr16_D1_0_reg(r1: i32) { write_reg16(r1, rol16(read_reg16(r1), 1)); }
#[no_mangle]
pub unsafe fn instr16_D1_1_mem(addr: i32) {
    SAFE_READ_WRITE16!(___, addr, ror16(___, 1));
}
#[no_mangle]
pub unsafe fn instr16_D1_1_reg(r1: i32) { write_reg16(r1, ror16(read_reg16(r1), 1)); }
#[no_mangle]
pub unsafe fn instr16_D1_2_mem(addr: i32) {
    SAFE_READ_WRITE16!(___, addr, rcl16(___, 1));
}
#[no_mangle]
pub unsafe fn instr16_D1_2_reg(r1: i32) { write_reg16(r1, rcl16(read_reg16(r1), 1)); }
#[no_mangle]
pub unsafe fn instr16_D1_3_mem(addr: i32) {
    SAFE_READ_WRITE16!(___, addr, rcr16(___, 1));
}
#[no_mangle]
pub unsafe fn instr16_D1_3_reg(r1: i32) { write_reg16(r1, rcr16(read_reg16(r1), 1)); }
#[no_mangle]
pub unsafe fn instr16_D1_4_mem(addr: i32) {
    SAFE_READ_WRITE16!(___, addr, shl16(___, 1));
}
#[no_mangle]
pub unsafe fn instr16_D1_4_reg(r1: i32) { write_reg16(r1, shl16(read_reg16(r1), 1)); }
#[no_mangle]
pub unsafe fn instr16_D1_5_mem(addr: i32) {
    SAFE_READ_WRITE16!(___, addr, shr16(___, 1));
}
#[no_mangle]
pub unsafe fn instr16_D1_5_reg(r1: i32) { write_reg16(r1, shr16(read_reg16(r1), 1)); }
#[no_mangle]
pub unsafe fn instr16_D1_6_mem(addr: i32) {
    SAFE_READ_WRITE16!(___, addr, shl16(___, 1));
}
#[no_mangle]
pub unsafe fn instr16_D1_6_reg(r1: i32) { write_reg16(r1, shl16(read_reg16(r1), 1)); }
#[no_mangle]
pub unsafe fn instr16_D1_7_mem(addr: i32) {
    SAFE_READ_WRITE16!(___, addr, sar16(___, 1));
}
#[no_mangle]
pub unsafe fn instr16_D1_7_reg(r1: i32) { write_reg16(r1, sar16(read_reg16(r1), 1)); }
#[no_mangle]
pub unsafe fn instr32_D1_0_mem(addr: i32) {
    SAFE_READ_WRITE32!(___, addr, rol32(___, 1));
}
#[no_mangle]
pub unsafe fn instr32_D1_0_reg(r1: i32) { write_reg32(r1, rol32(read_reg32(r1), 1)); }
#[no_mangle]
pub unsafe fn instr32_D1_1_mem(addr: i32) {
    SAFE_READ_WRITE32!(___, addr, ror32(___, 1));
}
#[no_mangle]
pub unsafe fn instr32_D1_1_reg(r1: i32) { write_reg32(r1, ror32(read_reg32(r1), 1)); }
#[no_mangle]
pub unsafe fn instr32_D1_2_mem(addr: i32) {
    SAFE_READ_WRITE32!(___, addr, rcl32(___, 1));
}
#[no_mangle]
pub unsafe fn instr32_D1_2_reg(r1: i32) { write_reg32(r1, rcl32(read_reg32(r1), 1)); }
#[no_mangle]
pub unsafe fn instr32_D1_3_mem(addr: i32) {
    SAFE_READ_WRITE32!(___, addr, rcr32(___, 1));
}
#[no_mangle]
pub unsafe fn instr32_D1_3_reg(r1: i32) { write_reg32(r1, rcr32(read_reg32(r1), 1)); }
#[no_mangle]
pub unsafe fn instr32_D1_4_mem(addr: i32) {
    SAFE_READ_WRITE32!(___, addr, shl32(___, 1));
}
#[no_mangle]
pub unsafe fn instr32_D1_4_reg(r1: i32) { write_reg32(r1, shl32(read_reg32(r1), 1)); }
#[no_mangle]
pub unsafe fn instr32_D1_5_mem(addr: i32) {
    SAFE_READ_WRITE32!(___, addr, shr32(___, 1));
}
#[no_mangle]
pub unsafe fn instr32_D1_5_reg(r1: i32) { write_reg32(r1, shr32(read_reg32(r1), 1)); }
#[no_mangle]
pub unsafe fn instr32_D1_6_mem(addr: i32) {
    SAFE_READ_WRITE32!(___, addr, shl32(___, 1));
}
#[no_mangle]
pub unsafe fn instr32_D1_6_reg(r1: i32) { write_reg32(r1, shl32(read_reg32(r1), 1)); }
#[no_mangle]
pub unsafe fn instr32_D1_7_mem(addr: i32) {
    SAFE_READ_WRITE32!(___, addr, sar32(___, 1));
}
#[no_mangle]
pub unsafe fn instr32_D1_7_reg(r1: i32) { write_reg32(r1, sar32(read_reg32(r1), 1)); }
#[no_mangle]
pub unsafe fn instr_D2_0_mem(addr: i32) {
    SAFE_READ_WRITE8!(___, addr, rol8(___, *reg8.offset(CL as isize) as i32 & 31));
}
#[no_mangle]
pub unsafe fn instr_D2_0_reg(r1: i32) {
    write_reg8(
        r1,
        rol8(read_reg8(r1), *reg8.offset(CL as isize) as i32 & 31),
    );
}
#[no_mangle]
pub unsafe fn instr_D2_1_mem(addr: i32) {
    SAFE_READ_WRITE8!(___, addr, ror8(___, *reg8.offset(CL as isize) as i32 & 31));
}
#[no_mangle]
pub unsafe fn instr_D2_1_reg(r1: i32) {
    write_reg8(
        r1,
        ror8(read_reg8(r1), *reg8.offset(CL as isize) as i32 & 31),
    );
}
#[no_mangle]
pub unsafe fn instr_D2_2_mem(addr: i32) {
    SAFE_READ_WRITE8!(___, addr, rcl8(___, *reg8.offset(CL as isize) as i32 & 31));
}
#[no_mangle]
pub unsafe fn instr_D2_2_reg(r1: i32) {
    write_reg8(
        r1,
        rcl8(read_reg8(r1), *reg8.offset(CL as isize) as i32 & 31),
    );
}
#[no_mangle]
pub unsafe fn instr_D2_3_mem(addr: i32) {
    SAFE_READ_WRITE8!(___, addr, rcr8(___, *reg8.offset(CL as isize) as i32 & 31));
}
#[no_mangle]
pub unsafe fn instr_D2_3_reg(r1: i32) {
    write_reg8(
        r1,
        rcr8(read_reg8(r1), *reg8.offset(CL as isize) as i32 & 31),
    );
}
#[no_mangle]
pub unsafe fn instr_D2_4_mem(addr: i32) {
    SAFE_READ_WRITE8!(___, addr, shl8(___, *reg8.offset(CL as isize) as i32 & 31));
}
#[no_mangle]
pub unsafe fn instr_D2_4_reg(r1: i32) {
    write_reg8(
        r1,
        shl8(read_reg8(r1), *reg8.offset(CL as isize) as i32 & 31),
    );
}
#[no_mangle]
pub unsafe fn instr_D2_5_mem(addr: i32) {
    SAFE_READ_WRITE8!(___, addr, shr8(___, *reg8.offset(CL as isize) as i32 & 31));
}
#[no_mangle]
pub unsafe fn instr_D2_5_reg(r1: i32) {
    write_reg8(
        r1,
        shr8(read_reg8(r1), *reg8.offset(CL as isize) as i32 & 31),
    );
}
#[no_mangle]
pub unsafe fn instr_D2_6_mem(addr: i32) {
    SAFE_READ_WRITE8!(___, addr, shl8(___, *reg8.offset(CL as isize) as i32 & 31));
}
#[no_mangle]
pub unsafe fn instr_D2_6_reg(r1: i32) {
    write_reg8(
        r1,
        shl8(read_reg8(r1), *reg8.offset(CL as isize) as i32 & 31),
    );
}
#[no_mangle]
pub unsafe fn instr_D2_7_mem(addr: i32) {
    SAFE_READ_WRITE8!(___, addr, sar8(___, *reg8.offset(CL as isize) as i32 & 31));
}
#[no_mangle]
pub unsafe fn instr_D2_7_reg(r1: i32) {
    write_reg8(
        r1,
        sar8(read_reg8(r1), *reg8.offset(CL as isize) as i32 & 31),
    );
}
#[no_mangle]
pub unsafe fn instr16_D3_0_mem(addr: i32) {
    SAFE_READ_WRITE16!(___, addr, rol16(___, *reg8.offset(CL as isize) as i32 & 31));
}
#[no_mangle]
pub unsafe fn instr16_D3_0_reg(r1: i32) {
    write_reg16(
        r1,
        rol16(read_reg16(r1), *reg8.offset(CL as isize) as i32 & 31),
    );
}
#[no_mangle]
pub unsafe fn instr16_D3_1_mem(addr: i32) {
    SAFE_READ_WRITE16!(___, addr, ror16(___, *reg8.offset(CL as isize) as i32 & 31));
}
#[no_mangle]
pub unsafe fn instr16_D3_1_reg(r1: i32) {
    write_reg16(
        r1,
        ror16(read_reg16(r1), *reg8.offset(CL as isize) as i32 & 31),
    );
}
#[no_mangle]
pub unsafe fn instr16_D3_2_mem(addr: i32) {
    SAFE_READ_WRITE16!(___, addr, rcl16(___, *reg8.offset(CL as isize) as i32 & 31));
}
#[no_mangle]
pub unsafe fn instr16_D3_2_reg(r1: i32) {
    write_reg16(
        r1,
        rcl16(read_reg16(r1), *reg8.offset(CL as isize) as i32 & 31),
    );
}
#[no_mangle]
pub unsafe fn instr16_D3_3_mem(addr: i32) {
    SAFE_READ_WRITE16!(___, addr, rcr16(___, *reg8.offset(CL as isize) as i32 & 31));
}
#[no_mangle]
pub unsafe fn instr16_D3_3_reg(r1: i32) {
    write_reg16(
        r1,
        rcr16(read_reg16(r1), *reg8.offset(CL as isize) as i32 & 31),
    );
}
#[no_mangle]
pub unsafe fn instr16_D3_4_mem(addr: i32) {
    SAFE_READ_WRITE16!(___, addr, shl16(___, *reg8.offset(CL as isize) as i32 & 31));
}
#[no_mangle]
pub unsafe fn instr16_D3_4_reg(r1: i32) {
    write_reg16(
        r1,
        shl16(read_reg16(r1), *reg8.offset(CL as isize) as i32 & 31),
    );
}
#[no_mangle]
pub unsafe fn instr16_D3_5_mem(addr: i32) {
    SAFE_READ_WRITE16!(___, addr, shr16(___, *reg8.offset(CL as isize) as i32 & 31));
}
#[no_mangle]
pub unsafe fn instr16_D3_5_reg(r1: i32) {
    write_reg16(
        r1,
        shr16(read_reg16(r1), *reg8.offset(CL as isize) as i32 & 31),
    );
}
#[no_mangle]
pub unsafe fn instr16_D3_6_mem(addr: i32) {
    SAFE_READ_WRITE16!(___, addr, shl16(___, *reg8.offset(CL as isize) as i32 & 31));
}
#[no_mangle]
pub unsafe fn instr16_D3_6_reg(r1: i32) {
    write_reg16(
        r1,
        shl16(read_reg16(r1), *reg8.offset(CL as isize) as i32 & 31),
    );
}
#[no_mangle]
pub unsafe fn instr16_D3_7_mem(addr: i32) {
    SAFE_READ_WRITE16!(___, addr, sar16(___, *reg8.offset(CL as isize) as i32 & 31));
}
#[no_mangle]
pub unsafe fn instr16_D3_7_reg(r1: i32) {
    write_reg16(
        r1,
        sar16(read_reg16(r1), *reg8.offset(CL as isize) as i32 & 31),
    );
}
#[no_mangle]
pub unsafe fn instr32_D3_0_mem(addr: i32) {
    SAFE_READ_WRITE32!(___, addr, rol32(___, *reg8.offset(CL as isize) as i32 & 31));
}
#[no_mangle]
pub unsafe fn instr32_D3_0_reg(r1: i32) {
    write_reg32(
        r1,
        rol32(read_reg32(r1), *reg8.offset(CL as isize) as i32 & 31),
    );
}
#[no_mangle]
pub unsafe fn instr32_D3_1_mem(addr: i32) {
    SAFE_READ_WRITE32!(___, addr, ror32(___, *reg8.offset(CL as isize) as i32 & 31));
}
#[no_mangle]
pub unsafe fn instr32_D3_1_reg(r1: i32) {
    write_reg32(
        r1,
        ror32(read_reg32(r1), *reg8.offset(CL as isize) as i32 & 31),
    );
}
#[no_mangle]
pub unsafe fn instr32_D3_2_mem(addr: i32) {
    SAFE_READ_WRITE32!(___, addr, rcl32(___, *reg8.offset(CL as isize) as i32 & 31));
}
#[no_mangle]
pub unsafe fn instr32_D3_2_reg(r1: i32) {
    write_reg32(
        r1,
        rcl32(read_reg32(r1), *reg8.offset(CL as isize) as i32 & 31),
    );
}
#[no_mangle]
pub unsafe fn instr32_D3_3_mem(addr: i32) {
    SAFE_READ_WRITE32!(___, addr, rcr32(___, *reg8.offset(CL as isize) as i32 & 31));
}
#[no_mangle]
pub unsafe fn instr32_D3_3_reg(r1: i32) {
    write_reg32(
        r1,
        rcr32(read_reg32(r1), *reg8.offset(CL as isize) as i32 & 31),
    );
}
#[no_mangle]
pub unsafe fn instr32_D3_4_mem(addr: i32) {
    SAFE_READ_WRITE32!(___, addr, shl32(___, *reg8.offset(CL as isize) as i32 & 31));
}
#[no_mangle]
pub unsafe fn instr32_D3_4_reg(r1: i32) {
    write_reg32(
        r1,
        shl32(read_reg32(r1), *reg8.offset(CL as isize) as i32 & 31),
    );
}
#[no_mangle]
pub unsafe fn instr32_D3_5_mem(addr: i32) {
    SAFE_READ_WRITE32!(___, addr, shr32(___, *reg8.offset(CL as isize) as i32 & 31));
}
#[no_mangle]
pub unsafe fn instr32_D3_5_reg(r1: i32) {
    write_reg32(
        r1,
        shr32(read_reg32(r1), *reg8.offset(CL as isize) as i32 & 31),
    );
}
#[no_mangle]
pub unsafe fn instr32_D3_6_mem(addr: i32) {
    SAFE_READ_WRITE32!(___, addr, shl32(___, *reg8.offset(CL as isize) as i32 & 31));
}
#[no_mangle]
pub unsafe fn instr32_D3_6_reg(r1: i32) {
    write_reg32(
        r1,
        shl32(read_reg32(r1), *reg8.offset(CL as isize) as i32 & 31),
    );
}
#[no_mangle]
pub unsafe fn instr32_D3_7_mem(addr: i32) {
    SAFE_READ_WRITE32!(___, addr, sar32(___, *reg8.offset(CL as isize) as i32 & 31));
}
#[no_mangle]
pub unsafe fn instr32_D3_7_reg(r1: i32) {
    write_reg32(
        r1,
        sar32(read_reg32(r1), *reg8.offset(CL as isize) as i32 & 31),
    );
}
#[no_mangle]
pub unsafe fn instr_D4(arg: i32) { bcd_aam(arg); }
#[no_mangle]
pub unsafe fn instr_D5(arg: i32) { bcd_aad(arg); }
#[no_mangle]
pub unsafe fn instr_D6() {
    // salc
    *reg8.offset(AL as isize) = -(getcf() as i32) as u8;
}
#[no_mangle]
pub unsafe fn instr_D7() {
    // xlat
    if is_asize_32() {
        *reg8.offset(AL as isize) = return_on_pagefault!(safe_read8(
            get_seg_prefix(DS) + *reg32.offset(EBX as isize) + *reg8.offset(AL as isize) as i32,
        )) as u8
    }
    else {
        *reg8.offset(AL as isize) = return_on_pagefault!(safe_read8(
            get_seg_prefix(DS)
                + (*reg16.offset(BX as isize) as i32 + *reg8.offset(AL as isize) as i32 & 0xFFFF),
        )) as u8
    };
}
#[no_mangle]
pub unsafe fn instr_E4(port: i32) {
    if !test_privileges_for_io(port, 1) {
        return;
    }
    else {
        *reg8.offset(AL as isize) = io_port_read8(port) as u8;
        return;
    };
}
#[no_mangle]
pub unsafe fn instr16_E5(port: i32) {
    if !test_privileges_for_io(port, 2) {
        return;
    }
    else {
        *reg16.offset(AX as isize) = io_port_read16(port) as u16;
        return;
    };
}
#[no_mangle]
pub unsafe fn instr32_E5(port: i32) {
    if !test_privileges_for_io(port, 4) {
        return;
    }
    else {
        *reg32.offset(EAX as isize) = io_port_read32(port);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_E6(port: i32) {
    if !test_privileges_for_io(port, 1) {
        return;
    }
    else {
        io_port_write8(port, *reg8.offset(AL as isize) as i32);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr16_E7(port: i32) {
    if !test_privileges_for_io(port, 2) {
        return;
    }
    else {
        io_port_write16(port, *reg16.offset(AX as isize) as i32);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr32_E7(port: i32) {
    if !test_privileges_for_io(port, 4) {
        return;
    }
    else {
        io_port_write32(port, *reg32.offset(EAX as isize));
        return;
    };
}
#[no_mangle]
pub unsafe fn instr16_E8(imm16: i32) {
    // call
    return_on_pagefault!(push16(get_real_eip()));
    jmp_rel16(imm16);
}
#[no_mangle]
pub unsafe fn instr32_E8(imm32s: i32) {
    // call
    return_on_pagefault!(push32(get_real_eip()));
    *instruction_pointer = *instruction_pointer + imm32s;
    // dbg_assert!(is_asize_32() || get_real_eip() < 0x10000);
}
#[no_mangle]
pub unsafe fn instr16_E9(imm16: i32) {
    // jmp
    jmp_rel16(imm16);
}
#[no_mangle]
pub unsafe fn instr32_E9(imm32s: i32) {
    // jmp
    *instruction_pointer = *instruction_pointer + imm32s;
    dbg_assert!(is_asize_32() || get_real_eip() < 0x10000);
}
#[no_mangle]
pub unsafe fn instr16_EA(new_ip: i32, cs: i32) {
    // jmpf
    far_jump(new_ip, cs, false);
    dbg_assert!(is_asize_32() || get_real_eip() < 0x10000);
}
#[no_mangle]
pub unsafe fn instr32_EA(new_ip: i32, cs: i32) {
    // jmpf
    far_jump(new_ip, cs, false);
    dbg_assert!(is_asize_32() || get_real_eip() < 0x10000);
}
#[no_mangle]
pub unsafe fn instr_EC() {
    let port = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 1) {
        return;
    }
    else {
        *reg8.offset(AL as isize) = io_port_read8(port) as u8;
        return;
    };
}
#[no_mangle]
pub unsafe fn instr16_ED() {
    let port = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 2) {
        return;
    }
    else {
        *reg16.offset(AX as isize) = io_port_read16(port) as u16;
        return;
    };
}
#[no_mangle]
pub unsafe fn instr32_ED() {
    let port = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 4) {
        return;
    }
    else {
        *reg32.offset(EAX as isize) = io_port_read32(port);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_EE() {
    let port = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 1) {
        return;
    }
    else {
        io_port_write8(port, *reg8.offset(AL as isize) as i32);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr16_EF() {
    let port = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 2) {
        return;
    }
    else {
        io_port_write16(port, *reg16.offset(AX as isize) as i32);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr32_EF() {
    let port = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 4) {
        return;
    }
    else {
        io_port_write32(port, *reg32.offset(EAX as isize));
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_F0() {
    // lock
    if false {
        dbg_log!("lock");
    }
    // TODO
    // This triggers UD when used with
    // some instructions that don't write to memory
    run_prefix_instruction();
}
#[no_mangle]
pub unsafe fn instr_F1() {
    // INT1
    // https://code.google.com/p/corkami/wiki/x86oddities#IceBP
    dbg_assert!(false);
}
#[no_mangle]
pub unsafe fn instr_F2() {
    // repnz
    dbg_assert!(*prefixes as i32 & PREFIX_MASK_REP == 0);
    *prefixes = (*prefixes as i32 | PREFIX_REPNZ) as u8;
    run_prefix_instruction();
    *prefixes = 0;
}
#[no_mangle]
pub unsafe fn instr_F3() {
    // repz
    dbg_assert!(*prefixes as i32 & PREFIX_MASK_REP == 0);
    *prefixes = (*prefixes as i32 | PREFIX_REPZ) as u8;
    run_prefix_instruction();
    *prefixes = 0;
}
#[no_mangle]
pub unsafe fn instr_F4() { hlt_op(); }
#[no_mangle]
pub unsafe fn instr_F5() {
    // cmc
    *flags = (*flags | 1) ^ getcf() as i32;
    *flags_changed &= !1;
}
#[no_mangle]
pub unsafe fn instr_F6_0_mem(addr: i32, imm: i32) {
    test8(return_on_pagefault!(safe_read8(addr)), imm);
}
#[no_mangle]
pub unsafe fn instr_F6_0_reg(r1: i32, imm: i32) { test8(read_reg8(r1), imm); }
#[no_mangle]
pub unsafe fn instr_F6_1_mem(addr: i32, imm: i32) {
    test8(return_on_pagefault!(safe_read8(addr)), imm);
}
#[no_mangle]
pub unsafe fn instr_F6_1_reg(r1: i32, imm: i32) { test8(read_reg8(r1), imm); }
#[no_mangle]
pub unsafe fn instr_F6_2_mem(addr: i32) {
    SAFE_READ_WRITE8!(___, addr, !___);
}
#[no_mangle]
pub unsafe fn instr_F6_2_reg(r1: i32) { write_reg8(r1, !read_reg8(r1)); }
#[no_mangle]
pub unsafe fn instr_F6_3_mem(addr: i32) {
    SAFE_READ_WRITE8!(___, addr, neg8(___));
}
#[no_mangle]
pub unsafe fn instr_F6_3_reg(r1: i32) { write_reg8(r1, neg8(read_reg8(r1))); }
#[no_mangle]
pub unsafe fn instr_F6_4_mem(addr: i32) { mul8(return_on_pagefault!(safe_read8(addr))); }
#[no_mangle]
pub unsafe fn instr_F6_4_reg(r1: i32) { mul8(read_reg8(r1)); }
#[no_mangle]
pub unsafe fn instr_F6_5_mem(addr: i32) {
    imul8(return_on_pagefault!(safe_read8(addr)) << 24 >> 24);
}
#[no_mangle]
pub unsafe fn instr_F6_5_reg(r1: i32) { imul8(read_reg8(r1) << 24 >> 24); }
#[no_mangle]
pub unsafe fn instr_F6_6_mem(addr: i32) { div8(return_on_pagefault!(safe_read8(addr)) as u32); }
#[no_mangle]
pub unsafe fn instr_F6_6_reg(r1: i32) { div8(read_reg8(r1) as u32); }
#[no_mangle]
pub unsafe fn instr_F6_7_mem(addr: i32) {
    idiv8(return_on_pagefault!(safe_read8(addr)) << 24 >> 24);
}
#[no_mangle]
pub unsafe fn instr_F6_7_reg(r1: i32) { idiv8(read_reg8(r1) << 24 >> 24); }
#[no_mangle]
pub unsafe fn instr16_F7_0_mem(addr: i32, imm: i32) {
    test16(return_on_pagefault!(safe_read16(addr)), imm);
}
#[no_mangle]
pub unsafe fn instr16_F7_0_reg(r1: i32, imm: i32) { test16(read_reg16(r1), imm); }
#[no_mangle]
pub unsafe fn instr16_F7_1_mem(addr: i32, imm: i32) {
    test16(return_on_pagefault!(safe_read16(addr)), imm);
}
#[no_mangle]
pub unsafe fn instr16_F7_1_reg(r1: i32, imm: i32) { test16(read_reg16(r1), imm); }
#[no_mangle]
pub unsafe fn instr16_F7_2_mem(addr: i32) {
    SAFE_READ_WRITE16!(___, addr, !___);
}
#[no_mangle]
pub unsafe fn instr16_F7_2_reg(r1: i32) { write_reg16(r1, !read_reg16(r1)); }
#[no_mangle]
pub unsafe fn instr16_F7_3_mem(addr: i32) {
    SAFE_READ_WRITE16!(___, addr, neg16(___));
}
#[no_mangle]
pub unsafe fn instr16_F7_3_reg(r1: i32) { write_reg16(r1, neg16(read_reg16(r1))); }
#[no_mangle]
pub unsafe fn instr16_F7_4_mem(addr: i32) { mul16(return_on_pagefault!(safe_read16(addr)) as u32); }
#[no_mangle]
pub unsafe fn instr16_F7_4_reg(r1: i32) { mul16(read_reg16(r1) as u32); }
#[no_mangle]
pub unsafe fn instr16_F7_5_mem(addr: i32) {
    imul16(return_on_pagefault!(safe_read16(addr)) << 16 >> 16);
}
#[no_mangle]
pub unsafe fn instr16_F7_5_reg(r1: i32) { imul16(read_reg16(r1) << 16 >> 16); }
#[no_mangle]
pub unsafe fn instr16_F7_6_mem(addr: i32) { div16(return_on_pagefault!(safe_read16(addr)) as u32); }
#[no_mangle]
pub unsafe fn instr16_F7_6_reg(r1: i32) { div16(read_reg16(r1) as u32); }
#[no_mangle]
pub unsafe fn instr16_F7_7_mem(addr: i32) {
    idiv16(return_on_pagefault!(safe_read16(addr)) << 16 >> 16);
}
#[no_mangle]
pub unsafe fn instr16_F7_7_reg(r1: i32) { idiv16(read_reg16(r1) << 16 >> 16); }
#[no_mangle]
pub unsafe fn instr32_F7_0_mem(addr: i32, imm: i32) {
    test32(return_on_pagefault!(safe_read32s(addr)), imm);
}
#[no_mangle]
pub unsafe fn instr32_F7_0_reg(r1: i32, imm: i32) { test32(read_reg32(r1), imm); }
#[no_mangle]
pub unsafe fn instr32_F7_1_mem(addr: i32, imm: i32) {
    test32(return_on_pagefault!(safe_read32s(addr)), imm);
}
#[no_mangle]
pub unsafe fn instr32_F7_1_reg(r1: i32, imm: i32) { test32(read_reg32(r1), imm); }
#[no_mangle]
pub unsafe fn instr32_F7_2_mem(addr: i32) {
    SAFE_READ_WRITE32!(___, addr, !___);
}
#[no_mangle]
pub unsafe fn instr32_F7_2_reg(r1: i32) { write_reg32(r1, !read_reg32(r1)); }
#[no_mangle]
pub unsafe fn instr32_F7_3_mem(addr: i32) {
    SAFE_READ_WRITE32!(___, addr, neg32(___));
}
#[no_mangle]
pub unsafe fn instr32_F7_3_reg(r1: i32) { write_reg32(r1, neg32(read_reg32(r1))); }
#[no_mangle]
pub unsafe fn instr32_F7_4_mem(addr: i32) { mul32(return_on_pagefault!(safe_read32s(addr))); }
#[no_mangle]
pub unsafe fn instr32_F7_4_reg(r1: i32) { mul32(read_reg32(r1)); }
#[no_mangle]
pub unsafe fn instr32_F7_5_mem(addr: i32) { imul32(return_on_pagefault!(safe_read32s(addr))); }
#[no_mangle]
pub unsafe fn instr32_F7_5_reg(r1: i32) { imul32(read_reg32(r1)); }
#[no_mangle]
pub unsafe fn instr32_F7_6_mem(addr: i32) {
    div32(return_on_pagefault!(safe_read32s(addr)) as u32);
}
#[no_mangle]
pub unsafe fn instr32_F7_6_reg(r1: i32) { div32(read_reg32(r1) as u32); }
#[no_mangle]
pub unsafe fn instr32_F7_7_mem(addr: i32) { idiv32(return_on_pagefault!(safe_read32s(addr))); }
#[no_mangle]
pub unsafe fn instr32_F7_7_reg(r1: i32) { idiv32(read_reg32(r1)); }
#[no_mangle]
pub unsafe fn instr_F8() {
    // clc
    *flags &= !FLAG_CARRY;
    *flags_changed &= !1;
}
#[no_mangle]
pub unsafe fn instr_F9() {
    // stc
    *flags |= FLAG_CARRY;
    *flags_changed &= !1;
}
#[no_mangle]
pub unsafe fn instr_FA_without_fault() -> bool {
    // cli
    if !*protected_mode
        || if 0 != *flags & FLAG_VM {
            getiopl() == 3
        }
        else {
            getiopl() >= *cpl as i32
        }
    {
        *flags &= !FLAG_INTERRUPT;
        return true;
    }
    else if false
        && getiopl() < 3
        && if 0 != *flags & FLAG_VM {
            0 != *cr.offset(4) & CR4_VME
        }
        else {
            *cpl == 3 && 0 != *cr.offset(4) & CR4_PVI
        }
    {
        *flags &= !FLAG_VIF;
        return true;
    }
    else {
        dbg_log!("cli #gp");
        return false;
    };
}
#[no_mangle]
pub unsafe fn instr_FA() {
    if !instr_FA_without_fault() {
        trigger_gp(0);
    }
}
#[no_mangle]
pub unsafe fn instr_FB() {
    // sti
    let old_if = *flags & FLAG_INTERRUPT;
    if !*protected_mode
        || if 0 != *flags & FLAG_VM {
            getiopl() == 3
        }
        else {
            getiopl() >= *cpl as i32
        }
    {
        *flags |= FLAG_INTERRUPT;
        if old_if == 0 {
            handle_irqs();
        }
    }
    else if false
        && getiopl() < 3
        && *flags & FLAG_VIP == 0
        && if 0 != *flags & FLAG_VM {
            0 != *cr.offset(4) & CR4_VME
        }
        else {
            *cpl == 3 && 0 != *cr.offset(4) & CR4_PVI
        }
    {
        *flags |= FLAG_VIF
    }
    else {
        dbg_log!("sti #gp");
        trigger_gp(0);
    };
}
#[no_mangle]
pub unsafe fn instr_FC() {
    // cld
    *flags &= !FLAG_DIRECTION;
}
#[no_mangle]
pub unsafe fn instr_FD() {
    // std
    *flags |= FLAG_DIRECTION;
}
#[no_mangle]
pub unsafe fn instr_FE_0_mem(addr: i32) {
    SAFE_READ_WRITE8!(___, addr, inc8(___));
}
#[no_mangle]
pub unsafe fn instr_FE_0_reg(r1: i32) { write_reg8(r1, inc8(read_reg8(r1))); }
#[no_mangle]
pub unsafe fn instr_FE_1_mem(addr: i32) {
    SAFE_READ_WRITE8!(___, addr, dec8(___));
}
#[no_mangle]
pub unsafe fn instr_FE_1_reg(r1: i32) { write_reg8(r1, dec8(read_reg8(r1))); }
#[no_mangle]
pub unsafe fn instr16_FF_0_mem(addr: i32) {
    SAFE_READ_WRITE16!(___, addr, inc16(___));
}
#[no_mangle]
pub unsafe fn instr16_FF_0_reg(r1: i32) { write_reg16(r1, inc16(read_reg16(r1))); }
#[no_mangle]
pub unsafe fn instr16_FF_1_mem(addr: i32) {
    SAFE_READ_WRITE16!(___, addr, dec16(___));
}
#[no_mangle]
pub unsafe fn instr16_FF_1_reg(r1: i32) { write_reg16(r1, dec16(read_reg16(r1))); }
#[no_mangle]
pub unsafe fn instr16_FF_2_helper(data: i32) {
    // call near
    let cs = get_seg_cs();
    return_on_pagefault!(push16(get_real_eip()));
    *instruction_pointer = cs + data;
    dbg_assert!(is_asize_32() || get_real_eip() < 0x10000);
}
#[no_mangle]
pub unsafe fn instr16_FF_2_mem(addr: i32) {
    instr16_FF_2_helper(return_on_pagefault!(safe_read16(addr)));
}
#[no_mangle]
pub unsafe fn instr16_FF_2_reg(r1: i32) { instr16_FF_2_helper(read_reg16(r1)); }
#[no_mangle]
pub unsafe fn instr16_FF_3_reg(r: i32) {
    dbg_log!("callf #ud");
    trigger_ud();
}
#[no_mangle]
pub unsafe fn instr16_FF_3_mem(addr: i32) {
    // callf
    let new_ip = return_on_pagefault!(safe_read16(addr));
    let new_cs = return_on_pagefault!(safe_read16(addr + 2));
    far_jump(new_ip, new_cs, true);
    dbg_assert!(is_asize_32() || get_real_eip() < 0x10000);
}
#[no_mangle]
pub unsafe fn instr16_FF_4_helper(data: i32) {
    // jmp near
    *instruction_pointer = get_seg_cs() + data;
    dbg_assert!(is_asize_32() || get_real_eip() < 0x10000);
}
#[no_mangle]
pub unsafe fn instr16_FF_4_mem(addr: i32) {
    instr16_FF_4_helper(return_on_pagefault!(safe_read16(addr)));
}
#[no_mangle]
pub unsafe fn instr16_FF_4_reg(r1: i32) { instr16_FF_4_helper(read_reg16(r1)); }
#[no_mangle]
pub unsafe fn instr16_FF_5_reg(r: i32) {
    dbg_log!("jmpf #ud");
    trigger_ud();
}
#[no_mangle]
pub unsafe fn instr16_FF_5_mem(addr: i32) {
    // jmpf
    let new_ip = return_on_pagefault!(safe_read16(addr));
    let new_cs = return_on_pagefault!(safe_read16(addr + 2));
    far_jump(new_ip, new_cs, false);
    dbg_assert!(is_asize_32() || get_real_eip() < 0x10000);
}
#[no_mangle]
pub unsafe fn instr16_FF_6_mem(addr: i32) {
    return_on_pagefault!(push16(return_on_pagefault!(safe_read16(addr))));
}
#[no_mangle]
pub unsafe fn instr16_FF_6_reg(r1: i32) {
    return_on_pagefault!(push16(read_reg16(r1)));
}
#[no_mangle]
pub unsafe fn instr32_FF_0_mem(addr: i32) {
    SAFE_READ_WRITE32!(___, addr, inc32(___));
}
#[no_mangle]
pub unsafe fn instr32_FF_0_reg(r1: i32) { write_reg32(r1, inc32(read_reg32(r1))); }
#[no_mangle]
pub unsafe fn instr32_FF_1_mem(addr: i32) {
    SAFE_READ_WRITE32!(___, addr, dec32(___));
}
#[no_mangle]
pub unsafe fn instr32_FF_1_reg(r1: i32) { write_reg32(r1, dec32(read_reg32(r1))); }
#[no_mangle]
pub unsafe fn instr32_FF_2_helper(data: i32) {
    // call near
    let cs = get_seg_cs();
    return_on_pagefault!(push32(get_real_eip()));
    dbg_assert!(is_asize_32() || data < 0x10000);
    *instruction_pointer = cs + data;
}
#[no_mangle]
pub unsafe fn instr32_FF_2_mem(addr: i32) {
    instr32_FF_2_helper(return_on_pagefault!(safe_read32s(addr)));
}
#[no_mangle]
pub unsafe fn instr32_FF_2_reg(r1: i32) { instr32_FF_2_helper(read_reg32(r1)); }
#[no_mangle]
pub unsafe fn instr32_FF_3_reg(r: i32) {
    dbg_log!("callf #ud");
    trigger_ud();
}
#[no_mangle]
pub unsafe fn instr32_FF_3_mem(addr: i32) {
    // callf
    let new_ip = return_on_pagefault!(safe_read32s(addr));
    let new_cs = return_on_pagefault!(safe_read16(addr + 4));
    if !*protected_mode || vm86_mode() {
        if 0 != new_ip as u32 & 0xFFFF0000 {
            dbg_assert!(false);
        }
    }
    far_jump(new_ip, new_cs, true);
    dbg_assert!(is_asize_32() || new_ip < 0x10000);
}
#[no_mangle]
pub unsafe fn instr32_FF_4_helper(data: i32) {
    // jmp near
    dbg_assert!(is_asize_32() || data < 0x10000);
    *instruction_pointer = get_seg_cs() + data;
}
#[no_mangle]
pub unsafe fn instr32_FF_4_mem(addr: i32) {
    instr32_FF_4_helper(return_on_pagefault!(safe_read32s(addr)));
}
#[no_mangle]
pub unsafe fn instr32_FF_4_reg(r1: i32) { instr32_FF_4_helper(read_reg32(r1)); }
#[no_mangle]
pub unsafe fn instr32_FF_5_reg(r: i32) {
    dbg_log!("jmpf #ud");
    trigger_ud();
}
#[no_mangle]
pub unsafe fn instr32_FF_5_mem(addr: i32) {
    // jmpf
    let new_ip = return_on_pagefault!(safe_read32s(addr));
    let new_cs = return_on_pagefault!(safe_read16(addr + 4));
    if !*protected_mode || vm86_mode() {
        if 0 != new_ip as u32 & 0xFFFF0000 {
            dbg_assert!(false);
        }
    }
    far_jump(new_ip, new_cs, false);
    dbg_assert!(is_asize_32() || new_ip < 0x10000);
}
#[no_mangle]
pub unsafe fn instr32_FF_6_mem(addr: i32) {
    return_on_pagefault!(push32(return_on_pagefault!(safe_read32s(addr))));
}
#[no_mangle]
pub unsafe fn instr32_FF_6_reg(r1: i32) {
    return_on_pagefault!(push32(read_reg32(r1)));
}
#[no_mangle]
pub unsafe fn instr_F26C() { insb_rep(); }
#[no_mangle]
pub unsafe fn instr_F36C() { insb_rep(); }
#[no_mangle]
pub unsafe fn instr16_F26D() { insw_rep(); }
#[no_mangle]
pub unsafe fn instr16_F36D() { insw_rep(); }
#[no_mangle]
pub unsafe fn instr32_F26D() { insd_rep(); }
#[no_mangle]
pub unsafe fn instr32_F36D() { insd_rep(); }
#[no_mangle]
pub unsafe fn instr_F26E() { outsb_rep(); }
#[no_mangle]
pub unsafe fn instr_F36E() { outsb_rep(); }
#[no_mangle]
pub unsafe fn instr16_F26F() { outsw_rep(); }
#[no_mangle]
pub unsafe fn instr16_F36F() { outsw_rep(); }
#[no_mangle]
pub unsafe fn instr32_F26F() { outsd_rep(); }
#[no_mangle]
pub unsafe fn instr32_F36F() { outsd_rep(); }
#[no_mangle]
pub unsafe fn instr16_70(imm8: i32) { jmpcc16(test_o(), imm8); }
#[no_mangle]
pub unsafe fn instr16_71(imm8: i32) { jmpcc16(!test_o(), imm8); }
#[no_mangle]
pub unsafe fn instr16_72(imm8: i32) { jmpcc16(test_b(), imm8); }
#[no_mangle]
pub unsafe fn instr16_73(imm8: i32) { jmpcc16(!test_b(), imm8); }
#[no_mangle]
pub unsafe fn instr16_74(imm8: i32) { jmpcc16(test_z(), imm8); }
#[no_mangle]
pub unsafe fn instr16_75(imm8: i32) { jmpcc16(!test_z(), imm8); }
#[no_mangle]
pub unsafe fn instr16_76(imm8: i32) { jmpcc16(test_be(), imm8); }
#[no_mangle]
pub unsafe fn instr16_77(imm8: i32) { jmpcc16(!test_be(), imm8); }
#[no_mangle]
pub unsafe fn instr16_78(imm8: i32) { jmpcc16(test_s(), imm8); }
#[no_mangle]
pub unsafe fn instr16_79(imm8: i32) { jmpcc16(!test_s(), imm8); }
#[no_mangle]
pub unsafe fn instr16_7A(imm8: i32) { jmpcc16(test_p(), imm8); }
#[no_mangle]
pub unsafe fn instr16_7B(imm8: i32) { jmpcc16(!test_p(), imm8); }
#[no_mangle]
pub unsafe fn instr16_7C(imm8: i32) { jmpcc16(test_l(), imm8); }
#[no_mangle]
pub unsafe fn instr16_7D(imm8: i32) { jmpcc16(!test_l(), imm8); }
#[no_mangle]
pub unsafe fn instr16_7E(imm8: i32) { jmpcc16(test_le(), imm8); }
#[no_mangle]
pub unsafe fn instr16_7F(imm8: i32) { jmpcc16(!test_le(), imm8); }
#[no_mangle]
pub unsafe fn instr32_70(imm8: i32) { jmpcc32(test_o(), imm8); }
#[no_mangle]
pub unsafe fn instr32_71(imm8: i32) { jmpcc32(!test_o(), imm8); }
#[no_mangle]
pub unsafe fn instr32_72(imm8: i32) { jmpcc32(test_b(), imm8); }
#[no_mangle]
pub unsafe fn instr32_73(imm8: i32) { jmpcc32(!test_b(), imm8); }
#[no_mangle]
pub unsafe fn instr32_74(imm8: i32) { jmpcc32(test_z(), imm8); }
#[no_mangle]
pub unsafe fn instr32_75(imm8: i32) { jmpcc32(!test_z(), imm8); }
#[no_mangle]
pub unsafe fn instr32_76(imm8: i32) { jmpcc32(test_be(), imm8); }
#[no_mangle]
pub unsafe fn instr32_77(imm8: i32) { jmpcc32(!test_be(), imm8); }
#[no_mangle]
pub unsafe fn instr32_78(imm8: i32) { jmpcc32(test_s(), imm8); }
#[no_mangle]
pub unsafe fn instr32_79(imm8: i32) { jmpcc32(!test_s(), imm8); }
#[no_mangle]
pub unsafe fn instr32_7A(imm8: i32) { jmpcc32(test_p(), imm8); }
#[no_mangle]
pub unsafe fn instr32_7B(imm8: i32) { jmpcc32(!test_p(), imm8); }
#[no_mangle]
pub unsafe fn instr32_7C(imm8: i32) { jmpcc32(test_l(), imm8); }
#[no_mangle]
pub unsafe fn instr32_7D(imm8: i32) { jmpcc32(!test_l(), imm8); }
#[no_mangle]
pub unsafe fn instr32_7E(imm8: i32) { jmpcc32(test_le(), imm8); }
#[no_mangle]
pub unsafe fn instr32_7F(imm8: i32) { jmpcc32(!test_le(), imm8); }
#[no_mangle]
pub unsafe fn instr_F2A4() { movsb_rep(); }
#[no_mangle]
pub unsafe fn instr_F3A4() { movsb_rep(); }
#[no_mangle]
pub unsafe fn instr16_F2A5() { movsw_rep(); }
#[no_mangle]
pub unsafe fn instr16_F3A5() { movsw_rep(); }
#[no_mangle]
pub unsafe fn instr32_F2A5() { movsd_rep(); }
#[no_mangle]
pub unsafe fn instr32_F3A5() { movsd_rep(); }
#[no_mangle]
pub unsafe fn instr_F2A6() { cmpsb_rep(PREFIX_F2); }
#[no_mangle]
pub unsafe fn instr_F3A6() { cmpsb_rep(PREFIX_F3); }
#[no_mangle]
pub unsafe fn instr16_F2A7() { cmpsw_rep(PREFIX_F2); }
#[no_mangle]
pub unsafe fn instr16_F3A7() { cmpsw_rep(PREFIX_F3); }
#[no_mangle]
pub unsafe fn instr32_F2A7() { cmpsd_rep(PREFIX_F2); }
#[no_mangle]
pub unsafe fn instr32_F3A7() { cmpsd_rep(PREFIX_F3); }
#[no_mangle]
pub unsafe fn instr_F2AA() { stosb_rep(); }
#[no_mangle]
pub unsafe fn instr_F3AA() { stosb_rep(); }
#[no_mangle]
pub unsafe fn instr16_F2AB() { stosw_rep(); }
#[no_mangle]
pub unsafe fn instr16_F3AB() { stosw_rep(); }
#[no_mangle]
pub unsafe fn instr32_F2AB() { stosd_rep(); }
#[no_mangle]
pub unsafe fn instr32_F3AB() { stosd_rep(); }
#[no_mangle]
pub unsafe fn instr_F2AC() { lodsb_rep(); }
#[no_mangle]
pub unsafe fn instr_F3AC() { lodsb_rep(); }
#[no_mangle]
pub unsafe fn instr16_F2AD() { lodsw_rep(); }
#[no_mangle]
pub unsafe fn instr16_F3AD() { lodsw_rep(); }
#[no_mangle]
pub unsafe fn instr32_F2AD() { lodsd_rep(); }
#[no_mangle]
pub unsafe fn instr32_F3AD() { lodsd_rep(); }
#[no_mangle]
pub unsafe fn instr_F2AE() { scasb_rep(PREFIX_F2); }
#[no_mangle]
pub unsafe fn instr_F3AE() { scasb_rep(PREFIX_F3); }
#[no_mangle]
pub unsafe fn instr16_F2AF() { scasw_rep(PREFIX_F2); }
#[no_mangle]
pub unsafe fn instr16_F3AF() { scasw_rep(PREFIX_F3); }
#[no_mangle]
pub unsafe fn instr32_F2AF() { scasd_rep(PREFIX_F2); }
#[no_mangle]
pub unsafe fn instr32_F3AF() { scasd_rep(PREFIX_F3); }

#[no_mangle]
pub unsafe fn instr_D8_0_mem(addr: i32) { fpu_fadd(0, return_on_pagefault!(fpu_load_m32(addr))); }
#[no_mangle]
pub unsafe fn instr_D8_0_reg(r: i32) { fpu_fadd(0, fpu_get_sti(r)); }
#[no_mangle]
pub unsafe fn instr_D8_1_mem(addr: i32) { fpu_fmul(0, return_on_pagefault!(fpu_load_m32(addr))); }
#[no_mangle]
pub unsafe fn instr_D8_1_reg(r: i32) { fpu_fmul(0, fpu_get_sti(r)); }
#[no_mangle]
pub unsafe fn instr_D8_2_mem(addr: i32) { fpu_fcom(return_on_pagefault!(fpu_load_m32(addr))); }
#[no_mangle]
pub unsafe fn instr_D8_2_reg(r: i32) { fpu_fcom(fpu_get_sti(r)); }
#[no_mangle]
pub unsafe fn instr_D8_3_mem(addr: i32) { fpu_fcomp(return_on_pagefault!(fpu_load_m32(addr))); }
#[no_mangle]
pub unsafe fn instr_D8_3_reg(r: i32) { fpu_fcomp(fpu_get_sti(r)); }
#[no_mangle]
pub unsafe fn instr_D8_4_mem(addr: i32) { fpu_fsub(0, return_on_pagefault!(fpu_load_m32(addr))); }
#[no_mangle]
pub unsafe fn instr_D8_4_reg(r: i32) { fpu_fsub(0, fpu_get_sti(r)); }
#[no_mangle]
pub unsafe fn instr_D8_5_mem(addr: i32) { fpu_fsubr(0, return_on_pagefault!(fpu_load_m32(addr))); }
#[no_mangle]
pub unsafe fn instr_D8_5_reg(r: i32) { fpu_fsubr(0, fpu_get_sti(r)); }
#[no_mangle]
pub unsafe fn instr_D8_6_mem(addr: i32) { fpu_fdiv(0, return_on_pagefault!(fpu_load_m32(addr))); }
#[no_mangle]
pub unsafe fn instr_D8_6_reg(r: i32) { fpu_fdiv(0, fpu_get_sti(r)); }
#[no_mangle]
pub unsafe fn instr_D8_7_mem(addr: i32) { fpu_fdivr(0, return_on_pagefault!(fpu_load_m32(addr))); }
#[no_mangle]
pub unsafe fn instr_D8_7_reg(r: i32) { fpu_fdivr(0, fpu_get_sti(r)); }
#[no_mangle]
pub unsafe fn instr_D9_0_mem(addr: i32) { fpu_push(return_on_pagefault!(fpu_load_m32(addr))); }
#[no_mangle]
pub unsafe fn instr_D9_0_reg(r: i32) { fpu_push(fpu_get_sti(r)); }
#[no_mangle]
pub unsafe fn instr_D9_1_mem(addr: i32) {
    dbg_log!("d9/1");
    trigger_ud();
}
#[no_mangle]
pub unsafe fn instr_D9_1_reg(r: i32) { fpu_fxch(r); }
#[no_mangle]
pub unsafe fn instr_D9_2_mem(addr: i32) { fpu_fstm32(addr); }
#[no_mangle]
pub unsafe fn instr_D9_2_reg(r: i32) {
    if r != 0 {
        trigger_ud();
    };
}
#[no_mangle]
pub unsafe fn instr_D9_3_mem(addr: i32) { fpu_fstm32p(addr); }
#[no_mangle]
pub unsafe fn instr_D9_3_reg(r: i32) { fpu_fstp(r) }
#[no_mangle]
pub unsafe fn instr_D9_4_mem(addr: i32) { fpu_fldenv(addr); }
#[no_mangle]
pub unsafe fn instr_D9_4_reg(r: i32) {
    let st0 = fpu_get_st0();
    match r {
        0 => {
            // fchs
            fpu_write_st(*fpu_stack_ptr as i32, -st0);
        },
        1 => {
            // fabs
            fpu_write_st(*fpu_stack_ptr as i32, st0.abs());
        },
        4 => {
            fpu_ftst(st0);
        },
        5 => {
            fpu_fxam(st0);
        },
        _ => {
            dbg_log!("{:x}", r);
            trigger_ud();
        },
    };
}
#[no_mangle]
pub unsafe fn instr_D9_5_mem(addr: i32) { fpu_fldcw(addr); }
#[no_mangle]
pub unsafe fn instr_D9_5_reg(r: i32) {
    // fld1/fldl2t/fldl2e/fldpi/fldlg2/fldln2/fldz
    match r {
        0 => {
            fpu_push(1.0);
        },
        1 => {
            fpu_push(M_LN10 / M_LN2);
        },
        2 => {
            fpu_push(M_LOG2E);
        },
        3 => {
            fpu_push(M_PI);
        },
        4 => {
            fpu_push(M_LN2 / M_LN10);
        },
        5 => {
            fpu_push(M_LN2);
        },
        6 => {
            fpu_push(0.0);
        },
        7 => {
            dbg_log!("d9/5/7");
            trigger_ud();
        },
        _ => {},
    };
}
#[no_mangle]
pub unsafe fn instr_D9_6_mem(addr: i32) { fpu_fstenv(addr); }
#[no_mangle]
pub unsafe fn instr_D9_6_reg(r: i32) {
    let st0 = fpu_get_st0();
    match r {
        0 => {
            // f2xm1
            let mut r = pow(2.0, st0) - 1.0;
            if r == -1.0 {
                // Intel ...
                r = -3.475818901301751e+184
            }
            fpu_write_st(*fpu_stack_ptr as i32, r)
        },
        1 => {
            // fyl2x
            fpu_fyl2x();
        },
        2 => {
            // fptan
            if pow(-2.0, 63.0) < st0 && st0 < pow(2.0, 63.0) {
                fpu_write_st(*fpu_stack_ptr as i32, st0.tan());
                // no bug: push constant 1
                fpu_push(1.0);
                *fpu_status_word &= !FPU_C2;
            }
            else {
                *fpu_status_word |= FPU_C2;
            }
        },
        3 => {
            // fpatan
            fpu_write_st(*fpu_stack_ptr as i32 + 1 & 7, fpu_get_sti(1).atan2(st0));
            fpu_pop();
        },
        4 => {
            fpu_fxtract();
        },
        5 => {
            // fprem1
            fpu_fprem(true);
        },
        6 => {
            // fdecstp
            *fpu_stack_ptr = (*fpu_stack_ptr).wrapping_sub(1) & 7;
            *fpu_status_word &= !FPU_C1
        },
        7 => {
            // fincstp
            *fpu_stack_ptr = (*fpu_stack_ptr).wrapping_add(1) & 7;
            *fpu_status_word &= !FPU_C1
        },
        _ => {
            dbg_assert!(false);
        },
    };
}
#[no_mangle]
pub unsafe fn instr_D9_7_mem(addr: i32) { fpu_fstcw(addr); }
#[no_mangle]
pub unsafe fn instr_D9_7_reg(r: i32) {
    let st0 = fpu_get_st0();
    match r {
        0 => {
            // fprem
            fpu_fprem(false);
        },
        1 => {
            // fyl2xp1: y * log2(x+1) and pop
            let y = fpu_get_sti(1) * (st0 + 1.0).ln() / M_LN2;
            fpu_write_st(*fpu_stack_ptr as i32 + 1 & 7, y);
            fpu_pop();
        },
        2 => {
            if st0 < 0.0 {
                fpu_invalid_arithmetic();
            }
            fpu_write_st(*fpu_stack_ptr as i32, st0.sqrt())
        },
        3 => {
            // fsincos
            if pow(-2.0, 63.0) < st0 && st0 < pow(2.0, 63.0) {
                fpu_write_st(*fpu_stack_ptr as i32, st0.sin());
                fpu_push(st0.cos());
                *fpu_status_word &= !FPU_C2;
            }
            else {
                *fpu_status_word |= FPU_C2;
            }
        },
        4 => {
            // frndint
            fpu_write_st(*fpu_stack_ptr as i32, fpu_integer_round(st0));
        },
        5 => {
            // fscale
            let y = st0 * pow(2.0, trunc(fpu_get_sti(1)));
            fpu_write_st(*fpu_stack_ptr as i32, y);
        },
        6 => {
            if pow(-2.0, 63.0) < st0 && st0 < pow(2.0, 63.0) {
                fpu_write_st(*fpu_stack_ptr as i32, st0.sin());
                *fpu_status_word &= !FPU_C2;
            }
            else {
                *fpu_status_word |= FPU_C2;
            }
        },
        7 => {
            if pow(-2.0, 63.0) < st0 && st0 < pow(2.0, 63.0) {
                fpu_write_st(*fpu_stack_ptr as i32, st0.cos());
                *fpu_status_word &= !FPU_C2;
            }
            else {
                *fpu_status_word |= FPU_C2;
            }
        },
        _ => {
            dbg_assert!(false);
        },
    };
}
#[no_mangle]
pub unsafe fn instr_DA_0_mem(addr: i32) {
    fpu_fadd(0, return_on_pagefault!(safe_read32s(addr)) as f64);
}
#[no_mangle]
pub unsafe fn instr_DA_1_mem(addr: i32) {
    fpu_fmul(0, return_on_pagefault!(safe_read32s(addr)) as f64);
}
#[no_mangle]
pub unsafe fn instr_DA_2_mem(addr: i32) {
    fpu_fcom(return_on_pagefault!(safe_read32s(addr)) as f64);
}
#[no_mangle]
pub unsafe fn instr_DA_3_mem(addr: i32) {
    fpu_fcomp(return_on_pagefault!(safe_read32s(addr)) as f64);
}
#[no_mangle]
pub unsafe fn instr_DA_4_mem(addr: i32) {
    fpu_fsub(0, return_on_pagefault!(safe_read32s(addr)) as f64);
}
#[no_mangle]
pub unsafe fn instr_DA_5_mem(addr: i32) {
    fpu_fsubr(0, return_on_pagefault!(safe_read32s(addr)) as f64);
}
#[no_mangle]
pub unsafe fn instr_DA_6_mem(addr: i32) {
    fpu_fdiv(0, return_on_pagefault!(safe_read32s(addr)) as f64);
}
#[no_mangle]
pub unsafe fn instr_DA_7_mem(addr: i32) {
    fpu_fdivr(0, return_on_pagefault!(safe_read32s(addr)) as f64);
}
#[no_mangle]
pub unsafe fn instr_DA_0_reg(r: i32) { fpu_fcmovcc(test_b(), r); }
#[no_mangle]
pub unsafe fn instr_DA_1_reg(r: i32) { fpu_fcmovcc(test_z(), r); }
#[no_mangle]
pub unsafe fn instr_DA_2_reg(r: i32) { fpu_fcmovcc(test_be(), r); }
#[no_mangle]
pub unsafe fn instr_DA_3_reg(r: i32) { fpu_fcmovcc(test_p(), r); }
#[no_mangle]
pub unsafe fn instr_DA_4_reg(r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_DA_5_reg(r: i32) {
    if r == 1 {
        fpu_fucompp();
    }
    else {
        trigger_ud();
    };
}
#[no_mangle]
pub unsafe fn instr_DA_6_reg(r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_DA_7_reg(r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_DB_0_mem(addr: i32) { fpu_fldm32(addr); }
#[no_mangle]
pub unsafe fn instr_DB_1_mem(addr: i32) {
    dbg_log!("fisttp");
    fpu_unimpl();
}
#[no_mangle]
pub unsafe fn instr_DB_2_mem(addr: i32) { fpu_fistm32(addr); }
#[no_mangle]
pub unsafe fn instr_DB_3_mem(addr: i32) { fpu_fistm32p(addr); }
#[no_mangle]
pub unsafe fn instr_DB_4_mem(addr: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_DB_5_mem(addr: i32) { fpu_fldm80(addr); }
#[no_mangle]
pub unsafe fn instr_DB_6_mem(addr: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_DB_7_mem(addr: i32) { fpu_fst80p(addr); }
#[no_mangle]
pub unsafe fn instr_DB_0_reg(r: i32) { fpu_fcmovcc(!test_b(), r); }
#[no_mangle]
pub unsafe fn instr_DB_1_reg(r: i32) { fpu_fcmovcc(!test_z(), r); }
#[no_mangle]
pub unsafe fn instr_DB_2_reg(r: i32) { fpu_fcmovcc(!test_be(), r); }
#[no_mangle]
pub unsafe fn instr_DB_3_reg(r: i32) { fpu_fcmovcc(!test_p(), r); }
#[no_mangle]
pub unsafe fn instr_DB_4_reg(r: i32) {
    if r == 3 {
        fpu_finit();
    }
    else if r == 4 || r == 1 || r == 0 {
        // fsetpm, fdisi, fneni; treated as nop
    }
    else if r == 2 {
        fpu_fclex();
    }
    else {
        trigger_ud();
    };
}
#[no_mangle]
pub unsafe fn instr_DB_5_reg(r: i32) { fpu_fucomi(r); }
#[no_mangle]
pub unsafe fn instr_DB_6_reg(r: i32) { fpu_fcomi(r); }
#[no_mangle]
pub unsafe fn instr_DB_7_reg(r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_DC_0_mem(addr: i32) { fpu_fadd(0, return_on_pagefault!(fpu_load_m64(addr))); }
#[no_mangle]
pub unsafe fn instr_DC_1_mem(addr: i32) { fpu_fmul(0, return_on_pagefault!(fpu_load_m64(addr))); }
#[no_mangle]
pub unsafe fn instr_DC_2_mem(addr: i32) { fpu_fcom(return_on_pagefault!(fpu_load_m64(addr))); }
#[no_mangle]
pub unsafe fn instr_DC_3_mem(addr: i32) { fpu_fcomp(return_on_pagefault!(fpu_load_m64(addr))); }
#[no_mangle]
pub unsafe fn instr_DC_4_mem(addr: i32) { fpu_fsub(0, return_on_pagefault!(fpu_load_m64(addr))); }
#[no_mangle]
pub unsafe fn instr_DC_5_mem(addr: i32) { fpu_fsubr(0, return_on_pagefault!(fpu_load_m64(addr))); }
#[no_mangle]
pub unsafe fn instr_DC_6_mem(addr: i32) { fpu_fdiv(0, return_on_pagefault!(fpu_load_m64(addr))); }
#[no_mangle]
pub unsafe fn instr_DC_7_mem(addr: i32) { fpu_fdivr(0, return_on_pagefault!(fpu_load_m64(addr))); }
#[no_mangle]
pub unsafe fn instr_DC_0_reg(r: i32) { fpu_fadd(r, fpu_get_sti(r)); }
#[no_mangle]
pub unsafe fn instr_DC_1_reg(r: i32) { fpu_fmul(r, fpu_get_sti(r)); }
#[no_mangle]
pub unsafe fn instr_DC_2_reg(r: i32) { fpu_fcom(fpu_get_sti(r)); }
#[no_mangle]
pub unsafe fn instr_DC_3_reg(r: i32) { fpu_fcomp(fpu_get_sti(r)); }
#[no_mangle]
pub unsafe fn instr_DC_4_reg(r: i32) { fpu_fsub(r, fpu_get_sti(r)); }
#[no_mangle]
pub unsafe fn instr_DC_5_reg(r: i32) { fpu_fsubr(r, fpu_get_sti(r)); }
#[no_mangle]
pub unsafe fn instr_DC_6_reg(r: i32) { fpu_fdiv(r, fpu_get_sti(r)); }
#[no_mangle]
pub unsafe fn instr_DC_7_reg(r: i32) { fpu_fdivr(r, fpu_get_sti(r)); }
#[no_mangle]
pub unsafe fn instr_DD_0_mem(addr: i32) { fpu_fldm64(addr); }
#[no_mangle]
pub unsafe fn instr_DD_1_mem(addr: i32) {
    dbg_log!("fisttp");
    fpu_unimpl();
}
#[no_mangle]
pub unsafe fn instr_DD_2_mem(addr: i32) { fpu_fstm64(addr); }
#[no_mangle]
pub unsafe fn instr_DD_3_mem(addr: i32) { fpu_fstm64p(addr); }
#[no_mangle]
pub unsafe fn instr_DD_4_mem(addr: i32) { fpu_frstor(addr); }
#[no_mangle]
pub unsafe fn instr_DD_5_mem(addr: i32) {
    dbg_log!("dd/5");
    trigger_ud();
}
#[no_mangle]
pub unsafe fn instr_DD_6_mem(addr: i32) { fpu_fsave(addr); }
#[no_mangle]
pub unsafe fn instr_DD_7_mem(addr: i32) { fpu_fnstsw_mem(addr); }
#[no_mangle]
pub unsafe fn instr_DD_0_reg(r: i32) { fpu_ffree(r); }
#[no_mangle]
pub unsafe fn instr_DD_1_reg(r: i32) { fpu_fxch(r) }
#[no_mangle]
pub unsafe fn instr_DD_2_reg(r: i32) { fpu_fst(r); }
#[no_mangle]
pub unsafe fn instr_DD_3_reg(r: i32) { fpu_fstp(r); }
#[no_mangle]
pub unsafe fn instr_DD_4_reg(r: i32) { fpu_fucom(r); }
#[no_mangle]
pub unsafe fn instr_DD_5_reg(r: i32) { fpu_fucomp(r); }
#[no_mangle]
pub unsafe fn instr_DD_6_reg(r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_DD_7_reg(r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_DE_0_mem(addr: i32) {
    fpu_fadd(0, return_on_pagefault!(safe_read16(addr)) as i16 as f64);
}
#[no_mangle]
pub unsafe fn instr_DE_1_mem(addr: i32) {
    fpu_fmul(0, return_on_pagefault!(safe_read16(addr)) as i16 as f64);
}
#[no_mangle]
pub unsafe fn instr_DE_2_mem(addr: i32) {
    fpu_fcom(return_on_pagefault!(safe_read16(addr)) as i16 as f64);
}
#[no_mangle]
pub unsafe fn instr_DE_3_mem(addr: i32) {
    fpu_fcomp(return_on_pagefault!(safe_read16(addr)) as i16 as f64);
}
#[no_mangle]
pub unsafe fn instr_DE_4_mem(addr: i32) {
    fpu_fsub(0, return_on_pagefault!(safe_read16(addr)) as i16 as f64);
}
#[no_mangle]
pub unsafe fn instr_DE_5_mem(addr: i32) {
    fpu_fsubr(0, return_on_pagefault!(safe_read16(addr)) as i16 as f64);
}
#[no_mangle]
pub unsafe fn instr_DE_6_mem(addr: i32) {
    fpu_fdiv(0, return_on_pagefault!(safe_read16(addr)) as i16 as f64);
}
#[no_mangle]
pub unsafe fn instr_DE_7_mem(addr: i32) {
    fpu_fdivr(0, return_on_pagefault!(safe_read16(addr)) as i16 as f64);
}
#[no_mangle]
pub unsafe fn instr_DE_0_reg(r: i32) {
    fpu_fadd(r, fpu_get_sti(r));
    fpu_pop();
}
#[no_mangle]
pub unsafe fn instr_DE_1_reg(r: i32) {
    fpu_fmul(r, fpu_get_sti(r));
    fpu_pop();
}
#[no_mangle]
pub unsafe fn instr_DE_2_reg(r: i32) {
    fpu_fcom(fpu_get_sti(r));
    fpu_pop();
}
#[no_mangle]
pub unsafe fn instr_DE_3_reg(r: i32) {
    if r == 1 {
        fpu_fcomp(fpu_get_sti(r));
        fpu_pop();
    }
    else {
        trigger_ud();
    }
}
#[no_mangle]
pub unsafe fn instr_DE_4_reg(r: i32) {
    fpu_fsub(r, fpu_get_sti(r));
    fpu_pop();
}
#[no_mangle]
pub unsafe fn instr_DE_5_reg(r: i32) {
    fpu_fsubr(r, fpu_get_sti(r));
    fpu_pop();
}
#[no_mangle]
pub unsafe fn instr_DE_6_reg(r: i32) {
    fpu_fdiv(r, fpu_get_sti(r));
    fpu_pop();
}
#[no_mangle]
pub unsafe fn instr_DE_7_reg(r: i32) {
    fpu_fdivr(r, fpu_get_sti(r));
    fpu_pop();
}
#[no_mangle]
pub unsafe fn instr_DF_0_mem(addr: i32) {
    fpu_push(return_on_pagefault!(safe_read16(addr)) as i16 as f64);
}
#[no_mangle]
pub unsafe fn instr_DF_1_mem(addr: i32) {
    dbg_log!("fisttp");
    fpu_unimpl();
}
#[no_mangle]
pub unsafe fn instr_DF_2_mem(addr: i32) { fpu_fistm16(addr); }
#[no_mangle]
pub unsafe fn instr_DF_3_mem(addr: i32) { fpu_fistm16p(addr); }
#[no_mangle]
pub unsafe fn instr_DF_4_mem(addr: i32) {
    dbg_log!("fbld");
    fpu_unimpl();
}
#[no_mangle]
pub unsafe fn instr_DF_5_mem(addr: i32) { fpu_fildm64(addr); }
#[no_mangle]
pub unsafe fn instr_DF_6_mem(addr: i32) {
    dbg_log!("fbstp");
    fpu_unimpl();
}
#[no_mangle]
pub unsafe fn instr_DF_7_mem(addr: i32) { fpu_fistm64p(addr); }
#[no_mangle]

pub unsafe fn instr_DF_0_reg(r: i32) {
    fpu_ffree(r);
    fpu_pop();
}
#[no_mangle]
pub unsafe fn instr_DF_1_reg(r: i32) { fpu_fxch(r) }
#[no_mangle]
pub unsafe fn instr_DF_2_reg(r: i32) { fpu_fstp(r); }
#[no_mangle]
pub unsafe fn instr_DF_3_reg(r: i32) { fpu_fstp(r); }
#[no_mangle]
pub unsafe fn instr_DF_4_reg(r: i32) {
    if r == 0 {
        fpu_fnstsw_reg();
    }
    else {
        trigger_ud();
    };
}
#[no_mangle]
pub unsafe fn instr_DF_5_reg(r: i32) { fpu_fucomip(r); }
#[no_mangle]
pub unsafe fn instr_DF_6_reg(r: i32) { fpu_fcomip(r); }
#[no_mangle]
pub unsafe fn instr_DF_7_reg(r: i32) { trigger_ud(); }

#[no_mangle]
pub unsafe fn instr16_E0(imm8s: i32) { loopne16(imm8s); }
#[no_mangle]
pub unsafe fn instr16_E1(imm8s: i32) { loope16(imm8s); }
#[no_mangle]
pub unsafe fn instr16_E2(imm8s: i32) { loop16(imm8s); }
#[no_mangle]
pub unsafe fn instr16_E3(imm8s: i32) { jcxz16(imm8s); }
#[no_mangle]
pub unsafe fn instr32_E0(imm8s: i32) { loopne32(imm8s); }
#[no_mangle]
pub unsafe fn instr32_E1(imm8s: i32) { loope32(imm8s); }
#[no_mangle]
pub unsafe fn instr32_E2(imm8s: i32) { loop32(imm8s); }
#[no_mangle]
pub unsafe fn instr32_E3(imm8s: i32) { jcxz32(imm8s); }
#[no_mangle]
pub unsafe fn instr16_EB(imm8: i32) {
    // jmp near
    jmp_rel16(imm8);
    dbg_assert!(is_asize_32() || get_real_eip() < 0x10000);
}
#[no_mangle]
pub unsafe fn instr32_EB(imm8: i32) {
    // jmp near
    *instruction_pointer = *instruction_pointer + imm8;
    dbg_assert!(is_asize_32() || get_real_eip() < 0x10000);
}
