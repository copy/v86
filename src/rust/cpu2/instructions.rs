#![allow(
    dead_code,
    mutable_transmutes,
    non_camel_case_types,
    non_snake_case,
    non_upper_case_globals,
    unused_mut
)]

extern "C" {
    #[no_mangle]
    fn switch_seg(seg: i32, value: i32) -> bool;
    #[no_mangle]
    fn lss16(x: i32, y: i32, z: i32);
    #[no_mangle]
    fn lss32(x: i32, y: i32, z: i32);
    #[no_mangle]
    fn enter16(size: i32, nesting_level: i32);
    #[no_mangle]
    fn enter32(size: i32, nesting_level: i32);

    #[no_mangle]
    fn popa16();
    #[no_mangle]
    fn popa32();
    #[no_mangle]
    fn arpl(seg: i32, r: i32) -> i32;
    #[no_mangle]
    fn far_jump(eip: i32, selector: i32, is_call: bool);
    #[no_mangle]
    fn far_return(eip: i32, selector: i32, stack_adjust: i32);
    #[no_mangle]
    fn call_interrupt_vector(interrupt: i32, is_software: bool, has_error: bool, error: i32);
    #[no_mangle]
    fn iret16();
    #[no_mangle]
    fn iret32();

    #[no_mangle]
    fn handle_irqs();
    #[no_mangle]
    fn hlt_op();
}

use cpu2::arith::*;
use cpu2::cpu::*;
use cpu2::fpu::*;
use cpu2::fpu::{fpu_load_m32, fpu_load_m64};
use cpu2::global_pointers::*;
use cpu2::misc_instr::*;
use cpu2::misc_instr::{pop16, pop32s, push16, push32};
use cpu2::string::*;

#[no_mangle]
pub unsafe fn instr_00_mem(mut addr: i32, mut r: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, add8(___, read_reg8(r)));
}
#[no_mangle]
pub unsafe fn instr_00_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, add8(____0, read_reg8(r)));
}
#[no_mangle]
pub unsafe fn instr16_01_mem(mut addr: i32, mut r: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, add16(___, read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr16_01_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, add16(____0, read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr32_01_mem(mut addr: i32, mut r: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, add32(___, read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr32_01_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, add32(____0, read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr_02_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read8(addr));
    write_reg8(r, add8(read_reg8(r), ____0));
}
#[no_mangle]
pub unsafe fn instr_02_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r, add8(read_reg8(r), ____0));
}
#[no_mangle]
pub unsafe fn instr16_03_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    write_reg16(r, add16(read_reg16(r), ____0));
}
#[no_mangle]
pub unsafe fn instr16_03_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r, add16(read_reg16(r), ____0));
}
#[no_mangle]
pub unsafe fn instr32_03_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    write_reg32(r, add32(read_reg32(r), ____0));
}
#[no_mangle]
pub unsafe fn instr32_03_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r, add32(read_reg32(r), ____0));
}
#[no_mangle]
pub unsafe fn instr_04(mut imm8: i32) -> () {
    *reg8.offset(AL as isize) = add8(*reg8.offset(AL as isize) as i32, imm8) as u8;
}
#[no_mangle]
pub unsafe fn instr16_05(mut imm16: i32) -> () {
    *reg16.offset(AX as isize) = add16(*reg16.offset(AX as isize) as i32, imm16) as u16;
}
#[no_mangle]
pub unsafe fn instr32_05(mut imm32: i32) -> () {
    *reg32s.offset(EAX as isize) = add32(*reg32s.offset(EAX as isize), imm32);
}
#[no_mangle]
pub unsafe fn instr16_06() -> () {
    return_on_pagefault!(push16(*sreg.offset(ES as isize) as i32));
}
#[no_mangle]
pub unsafe fn instr32_06() -> () {
    return_on_pagefault!(push32(*sreg.offset(ES as isize) as i32));
}
#[no_mangle]
pub unsafe fn instr16_07() -> () {
    if !switch_seg(
        ES,
        return_on_pagefault!(safe_read16(get_stack_pointer(0i32))),
    ) {
        return;
    }
    else {
        adjust_stack_reg(2i32);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr32_07() -> () {
    if !switch_seg(
        ES,
        return_on_pagefault!(safe_read32s(get_stack_pointer(0i32))) & 65535i32,
    ) {
        return;
    }
    else {
        adjust_stack_reg(4i32);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_08_mem(mut addr: i32, mut r: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, or8(___, read_reg8(r)));
}
#[no_mangle]
pub unsafe fn instr_08_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, or8(____0, read_reg8(r)));
}
#[no_mangle]
pub unsafe fn instr16_09_mem(mut addr: i32, mut r: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, or16(___, read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr16_09_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, or16(____0, read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr32_09_mem(mut addr: i32, mut r: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, or32(___, read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr32_09_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, or32(____0, read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr_0A_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read8(addr));
    write_reg8(r, or8(read_reg8(r), ____0));
}
#[no_mangle]
pub unsafe fn instr_0A_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r, or8(read_reg8(r), ____0));
}
#[no_mangle]
pub unsafe fn instr16_0B_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    write_reg16(r, or16(read_reg16(r), ____0));
}
#[no_mangle]
pub unsafe fn instr16_0B_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r, or16(read_reg16(r), ____0));
}
#[no_mangle]
pub unsafe fn instr32_0B_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    write_reg32(r, or32(read_reg32(r), ____0));
}
#[no_mangle]
pub unsafe fn instr32_0B_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r, or32(read_reg32(r), ____0));
}
#[no_mangle]
pub unsafe fn instr_0C(mut imm8: i32) -> () {
    *reg8.offset(AL as isize) = or8(*reg8.offset(AL as isize) as i32, imm8) as u8;
}
#[no_mangle]
pub unsafe fn instr16_0D(mut imm16: i32) -> () {
    *reg16.offset(AX as isize) = or16(*reg16.offset(AX as isize) as i32, imm16) as u16;
}
#[no_mangle]
pub unsafe fn instr32_0D(mut imm32: i32) -> () {
    *reg32s.offset(EAX as isize) = or32(*reg32s.offset(EAX as isize), imm32);
}
#[no_mangle]
pub unsafe fn instr16_0E() -> () {
    return_on_pagefault!(push16(*sreg.offset(CS as isize) as i32));
}
#[no_mangle]
pub unsafe fn instr32_0E() -> () {
    return_on_pagefault!(push32(*sreg.offset(CS as isize) as i32));
}
#[no_mangle]
pub unsafe fn instr16_0F() -> () { run_instruction0f_16(return_on_pagefault!(read_imm8())); }
#[no_mangle]
pub unsafe fn instr32_0F() -> () { run_instruction0f_32(return_on_pagefault!(read_imm8())); }
#[no_mangle]
pub unsafe fn instr_10_mem(mut addr: i32, mut r: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, adc8(___, read_reg8(r)));
}
#[no_mangle]
pub unsafe fn instr_10_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, adc8(____0, read_reg8(r)));
}
#[no_mangle]
pub unsafe fn instr16_11_mem(mut addr: i32, mut r: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, adc16(___, read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr16_11_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, adc16(____0, read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr32_11_mem(mut addr: i32, mut r: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, adc32(___, read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr32_11_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, adc32(____0, read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr_12_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read8(addr));
    write_reg8(r, adc8(read_reg8(r), ____0));
}
#[no_mangle]
pub unsafe fn instr_12_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r, adc8(read_reg8(r), ____0));
}
#[no_mangle]
pub unsafe fn instr16_13_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    write_reg16(r, adc16(read_reg16(r), ____0));
}
#[no_mangle]
pub unsafe fn instr16_13_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r, adc16(read_reg16(r), ____0));
}
#[no_mangle]
pub unsafe fn instr32_13_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    write_reg32(r, adc32(read_reg32(r), ____0));
}
#[no_mangle]
pub unsafe fn instr32_13_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r, adc32(read_reg32(r), ____0));
}
#[no_mangle]
pub unsafe fn instr_14(mut imm8: i32) -> () {
    *reg8.offset(AL as isize) = adc8(*reg8.offset(AL as isize) as i32, imm8) as u8;
}
#[no_mangle]
pub unsafe fn instr16_15(mut imm16: i32) -> () {
    *reg16.offset(AX as isize) = adc16(*reg16.offset(AX as isize) as i32, imm16) as u16;
}
#[no_mangle]
pub unsafe fn instr32_15(mut imm32: i32) -> () {
    *reg32s.offset(EAX as isize) = adc32(*reg32s.offset(EAX as isize), imm32);
}
#[no_mangle]
pub unsafe fn instr16_16() -> () {
    return_on_pagefault!(push16(*sreg.offset(SS as isize) as i32));
}
#[no_mangle]
pub unsafe fn instr32_16() -> () {
    return_on_pagefault!(push32(*sreg.offset(SS as isize) as i32));
}
#[no_mangle]
pub unsafe fn instr16_17() -> () {
    if !switch_seg(
        SS,
        return_on_pagefault!(safe_read16(get_stack_pointer(0i32))),
    ) {
        return;
    }
    else {
        adjust_stack_reg(2i32);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr32_17() -> () {
    if !switch_seg(
        SS,
        return_on_pagefault!(safe_read32s(get_stack_pointer(0i32))) & 65535i32,
    ) {
        return;
    }
    else {
        adjust_stack_reg(4i32);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_18_mem(mut addr: i32, mut r: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, sbb8(___, read_reg8(r)));
}
#[no_mangle]
pub unsafe fn instr_18_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, sbb8(____0, read_reg8(r)));
}
#[no_mangle]
pub unsafe fn instr16_19_mem(mut addr: i32, mut r: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, sbb16(___, read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr16_19_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, sbb16(____0, read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr32_19_mem(mut addr: i32, mut r: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, sbb32(___, read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr32_19_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, sbb32(____0, read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr_1A_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read8(addr));
    write_reg8(r, sbb8(read_reg8(r), ____0));
}
#[no_mangle]
pub unsafe fn instr_1A_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r, sbb8(read_reg8(r), ____0));
}
#[no_mangle]
pub unsafe fn instr16_1B_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    write_reg16(r, sbb16(read_reg16(r), ____0));
}
#[no_mangle]
pub unsafe fn instr16_1B_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r, sbb16(read_reg16(r), ____0));
}
#[no_mangle]
pub unsafe fn instr32_1B_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    write_reg32(r, sbb32(read_reg32(r), ____0));
}
#[no_mangle]
pub unsafe fn instr32_1B_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r, sbb32(read_reg32(r), ____0));
}
#[no_mangle]
pub unsafe fn instr_1C(mut imm8: i32) -> () {
    *reg8.offset(AL as isize) = sbb8(*reg8.offset(AL as isize) as i32, imm8) as u8;
}
#[no_mangle]
pub unsafe fn instr16_1D(mut imm16: i32) -> () {
    *reg16.offset(AX as isize) = sbb16(*reg16.offset(AX as isize) as i32, imm16) as u16;
}
#[no_mangle]
pub unsafe fn instr32_1D(mut imm32: i32) -> () {
    *reg32s.offset(EAX as isize) = sbb32(*reg32s.offset(EAX as isize), imm32);
}
#[no_mangle]
pub unsafe fn instr16_1E() -> () {
    return_on_pagefault!(push16(*sreg.offset(DS as isize) as i32));
}
#[no_mangle]
pub unsafe fn instr32_1E() -> () {
    return_on_pagefault!(push32(*sreg.offset(DS as isize) as i32));
}
#[no_mangle]
pub unsafe fn instr16_1F() -> () {
    if !switch_seg(
        DS,
        return_on_pagefault!(safe_read16(get_stack_pointer(0i32))),
    ) {
        return;
    }
    else {
        adjust_stack_reg(2i32);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr32_1F() -> () {
    if !switch_seg(
        DS,
        return_on_pagefault!(safe_read32s(get_stack_pointer(0i32))) & 65535i32,
    ) {
        return;
    }
    else {
        adjust_stack_reg(4i32);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_20_mem(mut addr: i32, mut r: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, and8(___, read_reg8(r)));
}
#[no_mangle]
pub unsafe fn instr_20_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, and8(____0, read_reg8(r)));
}
#[no_mangle]
pub unsafe fn instr16_21_mem(mut addr: i32, mut r: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, and16(___, read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr16_21_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, and16(____0, read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr32_21_mem(mut addr: i32, mut r: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, and32(___, read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr32_21_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, and32(____0, read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr_22_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read8(addr));
    write_reg8(r, and8(read_reg8(r), ____0));
}
#[no_mangle]
pub unsafe fn instr_22_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r, and8(read_reg8(r), ____0));
}
#[no_mangle]
pub unsafe fn instr16_23_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    write_reg16(r, and16(read_reg16(r), ____0));
}
#[no_mangle]
pub unsafe fn instr16_23_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r, and16(read_reg16(r), ____0));
}
#[no_mangle]
pub unsafe fn instr32_23_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    write_reg32(r, and32(read_reg32(r), ____0));
}
#[no_mangle]
pub unsafe fn instr32_23_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r, and32(read_reg32(r), ____0));
}
#[no_mangle]
pub unsafe fn instr_24(mut imm8: i32) -> () {
    *reg8.offset(AL as isize) = and8(*reg8.offset(AL as isize) as i32, imm8) as u8;
}
#[no_mangle]
pub unsafe fn instr16_25(mut imm16: i32) -> () {
    *reg16.offset(AX as isize) = and16(*reg16.offset(AX as isize) as i32, imm16) as u16;
}
#[no_mangle]
pub unsafe fn instr32_25(mut imm32: i32) -> () {
    *reg32s.offset(EAX as isize) = and32(*reg32s.offset(EAX as isize), imm32);
}
#[no_mangle]
pub unsafe fn instr_26() -> () { segment_prefix_op(ES); }
#[no_mangle]
pub unsafe fn instr_27() -> () { bcd_daa(); }
#[no_mangle]
pub unsafe fn instr_28_mem(mut addr: i32, mut r: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, sub8(___, read_reg8(r)));
}
#[no_mangle]
pub unsafe fn instr_28_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, sub8(____0, read_reg8(r)));
}
#[no_mangle]
pub unsafe fn instr16_29_mem(mut addr: i32, mut r: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, sub16(___, read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr16_29_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, sub16(____0, read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr32_29_mem(mut addr: i32, mut r: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, sub32(___, read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr32_29_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, sub32(____0, read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr_2A_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read8(addr));
    write_reg8(r, sub8(read_reg8(r), ____0));
}
#[no_mangle]
pub unsafe fn instr_2A_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r, sub8(read_reg8(r), ____0));
}
#[no_mangle]
pub unsafe fn instr16_2B_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    write_reg16(r, sub16(read_reg16(r), ____0));
}
#[no_mangle]
pub unsafe fn instr16_2B_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r, sub16(read_reg16(r), ____0));
}
#[no_mangle]
pub unsafe fn instr32_2B_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    write_reg32(r, sub32(read_reg32(r), ____0));
}
#[no_mangle]
pub unsafe fn instr32_2B_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r, sub32(read_reg32(r), ____0));
}
#[no_mangle]
pub unsafe fn instr_2C(mut imm8: i32) -> () {
    *reg8.offset(AL as isize) = sub8(*reg8.offset(AL as isize) as i32, imm8) as u8;
}
#[no_mangle]
pub unsafe fn instr16_2D(mut imm16: i32) -> () {
    *reg16.offset(AX as isize) = sub16(*reg16.offset(AX as isize) as i32, imm16) as u16;
}
#[no_mangle]
pub unsafe fn instr32_2D(mut imm32: i32) -> () {
    *reg32s.offset(EAX as isize) = sub32(*reg32s.offset(EAX as isize), imm32);
}
#[no_mangle]
pub unsafe fn instr_2E() -> () { segment_prefix_op(CS); }
#[no_mangle]
pub unsafe fn instr_2F() -> () { bcd_das(); }
#[no_mangle]
pub unsafe fn instr_30_mem(mut addr: i32, mut r: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, xor8(___, read_reg8(r)));
}
#[no_mangle]
pub unsafe fn instr_30_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, xor8(____0, read_reg8(r)));
}
#[no_mangle]
pub unsafe fn instr16_31_mem(mut addr: i32, mut r: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, xor16(___, read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr16_31_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, xor16(____0, read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr32_31_mem(mut addr: i32, mut r: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, xor32(___, read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr32_31_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, xor32(____0, read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr_32_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read8(addr));
    write_reg8(r, xor8(read_reg8(r), ____0));
}
#[no_mangle]
pub unsafe fn instr_32_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r, xor8(read_reg8(r), ____0));
}
#[no_mangle]
pub unsafe fn instr16_33_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    write_reg16(r, xor16(read_reg16(r), ____0));
}
#[no_mangle]
pub unsafe fn instr16_33_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r, xor16(read_reg16(r), ____0));
}
#[no_mangle]
pub unsafe fn instr32_33_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    write_reg32(r, xor32(read_reg32(r), ____0));
}
#[no_mangle]
pub unsafe fn instr32_33_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r, xor32(read_reg32(r), ____0));
}
#[no_mangle]
pub unsafe fn instr_34(mut imm8: i32) -> () {
    *reg8.offset(AL as isize) = xor8(*reg8.offset(AL as isize) as i32, imm8) as u8;
}
#[no_mangle]
pub unsafe fn instr16_35(mut imm16: i32) -> () {
    *reg16.offset(AX as isize) = xor16(*reg16.offset(AX as isize) as i32, imm16) as u16;
}
#[no_mangle]
pub unsafe fn instr32_35(mut imm32: i32) -> () {
    *reg32s.offset(EAX as isize) = xor32(*reg32s.offset(EAX as isize), imm32);
}
#[no_mangle]
pub unsafe fn instr_36() -> () { segment_prefix_op(SS); }
#[no_mangle]
pub unsafe fn instr_37() -> () { bcd_aaa(); }
#[no_mangle]
pub unsafe fn instr_38_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read8(addr));
    cmp8(____0, read_reg8(r));
}
#[no_mangle]
pub unsafe fn instr_38_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    cmp8(____0, read_reg8(r));
}
#[no_mangle]
pub unsafe fn instr16_39_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    cmp16(____0, read_reg16(r));
}
#[no_mangle]
pub unsafe fn instr16_39_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    cmp16(____0, read_reg16(r));
}
#[no_mangle]
pub unsafe fn instr32_39_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    cmp32(____0, read_reg32(r));
}
#[no_mangle]
pub unsafe fn instr32_39_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    cmp32(____0, read_reg32(r));
}
#[no_mangle]
pub unsafe fn instr_3A_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read8(addr));
    cmp8(read_reg8(r), ____0);
}
#[no_mangle]
pub unsafe fn instr_3A_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    cmp8(read_reg8(r), ____0);
}
#[no_mangle]
pub unsafe fn instr16_3B_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    cmp16(read_reg16(r), ____0);
}
#[no_mangle]
pub unsafe fn instr16_3B_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    cmp16(read_reg16(r), ____0);
}
#[no_mangle]
pub unsafe fn instr32_3B_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    cmp32(read_reg32(r), ____0);
}
#[no_mangle]
pub unsafe fn instr32_3B_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    cmp32(read_reg32(r), ____0);
}
#[no_mangle]
pub unsafe fn instr_3C(mut imm8: i32) -> () { cmp8(*reg8.offset(AL as isize) as i32, imm8); }
#[no_mangle]
pub unsafe fn instr16_3D(mut imm16: i32) -> () { cmp16(*reg16.offset(AX as isize) as i32, imm16); }
#[no_mangle]
pub unsafe fn instr32_3D(mut imm32: i32) -> () { cmp32(*reg32s.offset(EAX as isize), imm32); }
#[no_mangle]
pub unsafe fn instr_3E() -> () { segment_prefix_op(DS); }
#[no_mangle]
pub unsafe fn instr_3F() -> () { bcd_aas(); }
#[no_mangle]
pub unsafe fn instr16_40() -> () {
    *reg16.offset(AX as isize) = inc16(*reg16.offset(AX as isize) as i32) as u16;
}
#[no_mangle]
pub unsafe fn instr32_40() -> () {
    *reg32s.offset(EAX as isize) = inc32(*reg32s.offset(EAX as isize));
}
#[no_mangle]
pub unsafe fn instr16_41() -> () {
    *reg16.offset(CX as isize) = inc16(*reg16.offset(CX as isize) as i32) as u16;
}
#[no_mangle]
pub unsafe fn instr32_41() -> () {
    *reg32s.offset(ECX as isize) = inc32(*reg32s.offset(ECX as isize));
}
#[no_mangle]
pub unsafe fn instr16_42() -> () {
    *reg16.offset(DX as isize) = inc16(*reg16.offset(DX as isize) as i32) as u16;
}
#[no_mangle]
pub unsafe fn instr32_42() -> () {
    *reg32s.offset(EDX as isize) = inc32(*reg32s.offset(EDX as isize));
}
#[no_mangle]
pub unsafe fn instr16_43() -> () {
    *reg16.offset(BX as isize) = inc16(*reg16.offset(BX as isize) as i32) as u16;
}
#[no_mangle]
pub unsafe fn instr32_43() -> () {
    *reg32s.offset(EBX as isize) = inc32(*reg32s.offset(EBX as isize));
}
#[no_mangle]
pub unsafe fn instr16_44() -> () {
    *reg16.offset(SP as isize) = inc16(*reg16.offset(SP as isize) as i32) as u16;
}
#[no_mangle]
pub unsafe fn instr32_44() -> () {
    *reg32s.offset(ESP as isize) = inc32(*reg32s.offset(ESP as isize));
}
#[no_mangle]
pub unsafe fn instr16_45() -> () {
    *reg16.offset(BP as isize) = inc16(*reg16.offset(BP as isize) as i32) as u16;
}
#[no_mangle]
pub unsafe fn instr32_45() -> () {
    *reg32s.offset(EBP as isize) = inc32(*reg32s.offset(EBP as isize));
}
#[no_mangle]
pub unsafe fn instr16_46() -> () {
    *reg16.offset(SI as isize) = inc16(*reg16.offset(SI as isize) as i32) as u16;
}
#[no_mangle]
pub unsafe fn instr32_46() -> () {
    *reg32s.offset(ESI as isize) = inc32(*reg32s.offset(ESI as isize));
}
#[no_mangle]
pub unsafe fn instr16_47() -> () {
    *reg16.offset(DI as isize) = inc16(*reg16.offset(DI as isize) as i32) as u16;
}
#[no_mangle]
pub unsafe fn instr32_47() -> () {
    *reg32s.offset(EDI as isize) = inc32(*reg32s.offset(EDI as isize));
}
#[no_mangle]
pub unsafe fn instr16_48() -> () {
    *reg16.offset(AX as isize) = dec16(*reg16.offset(AX as isize) as i32) as u16;
}
#[no_mangle]
pub unsafe fn instr32_48() -> () {
    *reg32s.offset(EAX as isize) = dec32(*reg32s.offset(EAX as isize));
}
#[no_mangle]
pub unsafe fn instr16_49() -> () {
    *reg16.offset(CX as isize) = dec16(*reg16.offset(CX as isize) as i32) as u16;
}
#[no_mangle]
pub unsafe fn instr32_49() -> () {
    *reg32s.offset(ECX as isize) = dec32(*reg32s.offset(ECX as isize));
}
#[no_mangle]
pub unsafe fn instr16_4A() -> () {
    *reg16.offset(DX as isize) = dec16(*reg16.offset(DX as isize) as i32) as u16;
}
#[no_mangle]
pub unsafe fn instr32_4A() -> () {
    *reg32s.offset(EDX as isize) = dec32(*reg32s.offset(EDX as isize));
}
#[no_mangle]
pub unsafe fn instr16_4B() -> () {
    *reg16.offset(BX as isize) = dec16(*reg16.offset(BX as isize) as i32) as u16;
}
#[no_mangle]
pub unsafe fn instr32_4B() -> () {
    *reg32s.offset(EBX as isize) = dec32(*reg32s.offset(EBX as isize));
}
#[no_mangle]
pub unsafe fn instr16_4C() -> () {
    *reg16.offset(SP as isize) = dec16(*reg16.offset(SP as isize) as i32) as u16;
}
#[no_mangle]
pub unsafe fn instr32_4C() -> () {
    *reg32s.offset(ESP as isize) = dec32(*reg32s.offset(ESP as isize));
}
#[no_mangle]
pub unsafe fn instr16_4D() -> () {
    *reg16.offset(BP as isize) = dec16(*reg16.offset(BP as isize) as i32) as u16;
}
#[no_mangle]
pub unsafe fn instr32_4D() -> () {
    *reg32s.offset(EBP as isize) = dec32(*reg32s.offset(EBP as isize));
}
#[no_mangle]
pub unsafe fn instr16_4E() -> () {
    *reg16.offset(SI as isize) = dec16(*reg16.offset(SI as isize) as i32) as u16;
}
#[no_mangle]
pub unsafe fn instr32_4E() -> () {
    *reg32s.offset(ESI as isize) = dec32(*reg32s.offset(ESI as isize));
}
#[no_mangle]
pub unsafe fn instr16_4F() -> () {
    *reg16.offset(DI as isize) = dec16(*reg16.offset(DI as isize) as i32) as u16;
}
#[no_mangle]
pub unsafe fn instr32_4F() -> () {
    *reg32s.offset(EDI as isize) = dec32(*reg32s.offset(EDI as isize));
}

pub unsafe fn push16_reg(r: i32) {
    return_on_pagefault!(push16(*reg16.offset(r as isize) as i32));
}
pub unsafe fn push32_reg(r: i32) {
    return_on_pagefault!(push32(*reg32s.offset(r as isize) as i32));
}

#[no_mangle]
pub unsafe fn instr16_50() -> () { push16_reg(AX) }
#[no_mangle]
pub unsafe fn instr32_50() -> () { push32_reg(EAX) }
#[no_mangle]
pub unsafe fn instr16_51() -> () { push16_reg(CX) }
#[no_mangle]
pub unsafe fn instr32_51() -> () { push32_reg(ECX) }
#[no_mangle]
pub unsafe fn instr16_52() -> () { push16_reg(DX) }
#[no_mangle]
pub unsafe fn instr32_52() -> () { push32_reg(EDX) }
#[no_mangle]
pub unsafe fn instr16_53() -> () { push16_reg(BX) }
#[no_mangle]
pub unsafe fn instr32_53() -> () { push32_reg(EBX) }
#[no_mangle]
pub unsafe fn instr16_54() -> () { push16_reg(SP) }
#[no_mangle]
pub unsafe fn instr32_54() -> () { push32_reg(ESP) }
#[no_mangle]
pub unsafe fn instr16_55() -> () { push16_reg(BP) }
#[no_mangle]
pub unsafe fn instr32_55() -> () { push32_reg(EBP) }
#[no_mangle]
pub unsafe fn instr16_56() -> () { push16_reg(SI) }
#[no_mangle]
pub unsafe fn instr32_56() -> () { push32_reg(ESI) }
#[no_mangle]
pub unsafe fn instr16_57() -> () { push16_reg(DI) }
#[no_mangle]
pub unsafe fn instr32_57() -> () { push32_reg(EDI) }
#[no_mangle]
pub unsafe fn instr16_58() -> () {
    *reg16.offset(AX as isize) = return_on_pagefault!(pop16()) as u16;
}
#[no_mangle]
pub unsafe fn instr32_58() -> () { *reg32s.offset(EAX as isize) = return_on_pagefault!(pop32s()); }
#[no_mangle]
pub unsafe fn instr16_59() -> () {
    *reg16.offset(CX as isize) = return_on_pagefault!(pop16()) as u16;
}
#[no_mangle]
pub unsafe fn instr32_59() -> () { *reg32s.offset(ECX as isize) = return_on_pagefault!(pop32s()); }
#[no_mangle]
pub unsafe fn instr16_5A() -> () {
    *reg16.offset(DX as isize) = return_on_pagefault!(pop16()) as u16;
}
#[no_mangle]
pub unsafe fn instr32_5A() -> () { *reg32s.offset(EDX as isize) = return_on_pagefault!(pop32s()); }
#[no_mangle]
pub unsafe fn instr16_5B() -> () {
    *reg16.offset(BX as isize) = return_on_pagefault!(pop16()) as u16;
}
#[no_mangle]
pub unsafe fn instr32_5B() -> () { *reg32s.offset(EBX as isize) = return_on_pagefault!(pop32s()); }
#[no_mangle]
pub unsafe fn instr16_5C() -> () {
    *reg16.offset(SP as isize) = return_on_pagefault!(safe_read16(get_stack_pointer(0i32))) as u16;
}
#[no_mangle]
pub unsafe fn instr32_5C() -> () {
    *reg32s.offset(ESP as isize) = return_on_pagefault!(safe_read32s(get_stack_pointer(0i32)));
}
#[no_mangle]
pub unsafe fn instr16_5D() -> () {
    *reg16.offset(BP as isize) = return_on_pagefault!(pop16()) as u16;
}
#[no_mangle]
pub unsafe fn instr32_5D() -> () { *reg32s.offset(EBP as isize) = return_on_pagefault!(pop32s()); }
#[no_mangle]
pub unsafe fn instr16_5E() -> () {
    *reg16.offset(SI as isize) = return_on_pagefault!(pop16()) as u16;
}
#[no_mangle]
pub unsafe fn instr32_5E() -> () { *reg32s.offset(ESI as isize) = return_on_pagefault!(pop32s()); }
#[no_mangle]
pub unsafe fn instr16_5F() -> () {
    *reg16.offset(DI as isize) = return_on_pagefault!(pop16()) as u16;
}
#[no_mangle]
pub unsafe fn instr32_5F() -> () { *reg32s.offset(EDI as isize) = return_on_pagefault!(pop32s()); }
#[no_mangle]
pub unsafe fn instr16_60() -> () { pusha16(); }
#[no_mangle]
pub unsafe fn instr32_60() -> () { pusha32(); }
#[no_mangle]
pub unsafe fn instr16_61() -> () { popa16(); }
#[no_mangle]
pub unsafe fn instr32_61() -> () { popa32(); }
#[no_mangle]
pub unsafe fn instr_62_reg(mut r2: i32, mut r: i32) -> () {
    c_comment!(("bound"));
    dbg_log_c!("Unimplemented BOUND instruction");
    dbg_assert!(0 != 0i32);
}
#[no_mangle]
pub unsafe fn instr_62_mem(mut addr: i32, mut r: i32) -> () {
    dbg_log_c!("Unimplemented BOUND instruction");
    dbg_assert!(0 != 0i32);
}
#[no_mangle]
pub unsafe fn instr_63_mem(mut addr: i32, mut r: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, arpl(___, read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr_63_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, arpl(____0, read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr_64() -> () { segment_prefix_op(FS); }
#[no_mangle]
pub unsafe fn instr_65() -> () { segment_prefix_op(GS); }
#[no_mangle]
pub unsafe fn instr_66() -> () {
    c_comment!(("Operand-size override prefix"));
    *prefixes = (*prefixes as i32 | PREFIX_MASK_OPSIZE) as u8;
    run_prefix_instruction();
    *prefixes = 0i32 as u8;
}
#[no_mangle]
pub unsafe fn instr_67() -> () {
    c_comment!(("Address-size override prefix"));
    dbg_assert!(is_asize_32() as i32 == *is_32 as i32);
    *prefixes = (*prefixes as i32 | PREFIX_MASK_ADDRSIZE) as u8;
    run_prefix_instruction();
    *prefixes = 0i32 as u8;
}
#[no_mangle]
pub unsafe fn instr16_68(mut imm16: i32) -> () {
    return_on_pagefault!(push16(imm16));
}
#[no_mangle]
pub unsafe fn instr32_68(mut imm32: i32) -> () {
    return_on_pagefault!(push32(imm32));
}
#[no_mangle]
pub unsafe fn instr16_69_mem(mut addr: i32, mut r: i32, mut imm: i32) -> () {
    write_reg16(
        r,
        imul_reg16(
            return_on_pagefault!(safe_read16(addr)) << 16i32 >> 16i32,
            imm << 16i32 >> 16i32,
        ),
    );
}
#[no_mangle]
pub unsafe fn instr16_69_reg(mut r1: i32, mut r: i32, mut imm: i32) -> () {
    write_reg16(
        r,
        imul_reg16(read_reg16(r1) << 16i32 >> 16i32, imm << 16i32 >> 16i32),
    );
}
#[no_mangle]
pub unsafe fn instr32_69_mem(mut addr: i32, mut r: i32, mut imm: i32) -> () {
    write_reg32(r, imul_reg32(return_on_pagefault!(safe_read32s(addr)), imm));
}
#[no_mangle]
pub unsafe fn instr32_69_reg(mut r1: i32, mut r: i32, mut imm: i32) -> () {
    write_reg32(r, imul_reg32(read_reg32(r1), imm));
}
#[no_mangle]
pub unsafe fn instr16_6A(mut imm8: i32) -> () {
    return_on_pagefault!(push16(imm8));
}
#[no_mangle]
pub unsafe fn instr32_6A(mut imm8: i32) -> () {
    return_on_pagefault!(push32(imm8));
}
#[no_mangle]
pub unsafe fn instr16_6B_mem(mut addr: i32, mut r: i32, mut imm: i32) -> () {
    write_reg16(
        r,
        imul_reg16(
            return_on_pagefault!(safe_read16(addr)) << 16i32 >> 16i32,
            imm,
        ),
    );
}
#[no_mangle]
pub unsafe fn instr16_6B_reg(mut r1: i32, mut r: i32, mut imm: i32) -> () {
    write_reg16(r, imul_reg16(read_reg16(r1) << 16i32 >> 16i32, imm));
}
#[no_mangle]
pub unsafe fn instr32_6B_mem(mut addr: i32, mut r: i32, mut imm: i32) -> () {
    write_reg32(r, imul_reg32(return_on_pagefault!(safe_read32s(addr)), imm));
}
#[no_mangle]
pub unsafe fn instr32_6B_reg(mut r1: i32, mut r: i32, mut imm: i32) -> () {
    write_reg32(r, imul_reg32(read_reg32(r1), imm));
}
#[no_mangle]
pub unsafe fn instr_6C() -> () { insb_no_rep(); }
#[no_mangle]
pub unsafe fn instr16_6D() -> () { insw_no_rep(); }
#[no_mangle]
pub unsafe fn instr32_6D() -> () { insd_no_rep(); }
#[no_mangle]
pub unsafe fn instr_6E() -> () { outsb_no_rep(); }
#[no_mangle]
pub unsafe fn instr16_6F() -> () { outsw_no_rep(); }
#[no_mangle]
pub unsafe fn instr32_6F() -> () { outsd_no_rep(); }
#[no_mangle]
pub unsafe fn instr_80_0_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, add8(___, imm));
}
#[no_mangle]
pub unsafe fn instr_80_0_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, add8(____0, imm));
}
#[no_mangle]
pub unsafe fn instr_80_1_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, or8(___, imm));
}
#[no_mangle]
pub unsafe fn instr_80_1_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, or8(____0, imm));
}
#[no_mangle]
pub unsafe fn instr_80_2_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, adc8(___, imm));
}
#[no_mangle]
pub unsafe fn instr_80_2_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, adc8(____0, imm));
}
#[no_mangle]
pub unsafe fn instr_80_3_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, sbb8(___, imm));
}
#[no_mangle]
pub unsafe fn instr_80_3_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, sbb8(____0, imm));
}
#[no_mangle]
pub unsafe fn instr_80_4_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, and8(___, imm));
}
#[no_mangle]
pub unsafe fn instr_80_4_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, and8(____0, imm));
}
#[no_mangle]
pub unsafe fn instr_80_5_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, sub8(___, imm));
}
#[no_mangle]
pub unsafe fn instr_80_5_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, sub8(____0, imm));
}
#[no_mangle]
pub unsafe fn instr_80_6_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, xor8(___, imm));
}
#[no_mangle]
pub unsafe fn instr_80_6_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, xor8(____0, imm));
}
#[no_mangle]
pub unsafe fn instr_80_7_reg(mut r: i32, mut imm: i32) -> () { cmp8(read_reg8(r), imm); }
#[no_mangle]
pub unsafe fn instr_80_7_mem(mut addr: i32, mut imm: i32) -> () {
    cmp8(return_on_pagefault!(safe_read8(addr)), imm);
}
#[no_mangle]
pub unsafe fn instr16_81_0_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, add16(___, imm));
}
#[no_mangle]
pub unsafe fn instr16_81_0_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, add16(____0, imm));
}
#[no_mangle]
pub unsafe fn instr16_81_1_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, or16(___, imm));
}
#[no_mangle]
pub unsafe fn instr16_81_1_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, or16(____0, imm));
}
#[no_mangle]
pub unsafe fn instr16_81_2_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, adc16(___, imm));
}
#[no_mangle]
pub unsafe fn instr16_81_2_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, adc16(____0, imm));
}
#[no_mangle]
pub unsafe fn instr16_81_3_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, sbb16(___, imm));
}
#[no_mangle]
pub unsafe fn instr16_81_3_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, sbb16(____0, imm));
}
#[no_mangle]
pub unsafe fn instr16_81_4_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, and16(___, imm));
}
#[no_mangle]
pub unsafe fn instr16_81_4_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, and16(____0, imm));
}
#[no_mangle]
pub unsafe fn instr16_81_5_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, sub16(___, imm));
}
#[no_mangle]
pub unsafe fn instr16_81_5_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, sub16(____0, imm));
}
#[no_mangle]
pub unsafe fn instr16_81_6_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, xor16(___, imm));
}
#[no_mangle]
pub unsafe fn instr16_81_6_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, xor16(____0, imm));
}
#[no_mangle]
pub unsafe fn instr16_81_7_reg(mut r: i32, mut imm: i32) -> () { cmp16(read_reg16(r), imm); }
#[no_mangle]
pub unsafe fn instr16_81_7_mem(mut addr: i32, mut imm: i32) -> () {
    cmp16(return_on_pagefault!(safe_read16(addr)), imm);
}
#[no_mangle]
pub unsafe fn instr32_81_0_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, add32(___, imm));
}
#[no_mangle]
pub unsafe fn instr32_81_0_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, add32(____0, imm));
}
#[no_mangle]
pub unsafe fn instr32_81_1_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, or32(___, imm));
}
#[no_mangle]
pub unsafe fn instr32_81_1_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, or32(____0, imm));
}
#[no_mangle]
pub unsafe fn instr32_81_2_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, adc32(___, imm));
}
#[no_mangle]
pub unsafe fn instr32_81_2_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, adc32(____0, imm));
}
#[no_mangle]
pub unsafe fn instr32_81_3_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, sbb32(___, imm));
}
#[no_mangle]
pub unsafe fn instr32_81_3_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, sbb32(____0, imm));
}
#[no_mangle]
pub unsafe fn instr32_81_4_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, and32(___, imm));
}
#[no_mangle]
pub unsafe fn instr32_81_4_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, and32(____0, imm));
}
#[no_mangle]
pub unsafe fn instr32_81_5_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, sub32(___, imm));
}
#[no_mangle]
pub unsafe fn instr32_81_5_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, sub32(____0, imm));
}
#[no_mangle]
pub unsafe fn instr32_81_6_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, xor32(___, imm));
}
#[no_mangle]
pub unsafe fn instr32_81_6_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, xor32(____0, imm));
}
#[no_mangle]
pub unsafe fn instr32_81_7_reg(mut r: i32, mut imm: i32) -> () { cmp32(read_reg32(r), imm); }
#[no_mangle]
pub unsafe fn instr32_81_7_mem(mut addr: i32, mut imm: i32) -> () {
    cmp32(return_on_pagefault!(safe_read32s(addr)), imm);
}
#[no_mangle]
pub unsafe fn instr_82_0_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, add8(___, imm));
}
#[no_mangle]
pub unsafe fn instr_82_0_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, add8(____0, imm));
}
#[no_mangle]
pub unsafe fn instr_82_1_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, or8(___, imm));
}
#[no_mangle]
pub unsafe fn instr_82_1_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, or8(____0, imm));
}
#[no_mangle]
pub unsafe fn instr_82_2_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, adc8(___, imm));
}
#[no_mangle]
pub unsafe fn instr_82_2_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, adc8(____0, imm));
}
#[no_mangle]
pub unsafe fn instr_82_3_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, sbb8(___, imm));
}
#[no_mangle]
pub unsafe fn instr_82_3_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, sbb8(____0, imm));
}
#[no_mangle]
pub unsafe fn instr_82_4_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, and8(___, imm));
}
#[no_mangle]
pub unsafe fn instr_82_4_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, and8(____0, imm));
}
#[no_mangle]
pub unsafe fn instr_82_5_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, sub8(___, imm));
}
#[no_mangle]
pub unsafe fn instr_82_5_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, sub8(____0, imm));
}
#[no_mangle]
pub unsafe fn instr_82_6_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, xor8(___, imm));
}
#[no_mangle]
pub unsafe fn instr_82_6_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, xor8(____0, imm));
}
#[no_mangle]
pub unsafe fn instr_82_7_reg(mut r: i32, mut imm: i32) -> () { cmp8(read_reg8(r), imm); }
#[no_mangle]
pub unsafe fn instr_82_7_mem(mut addr: i32, mut imm: i32) -> () {
    cmp8(return_on_pagefault!(safe_read8(addr)), imm);
}
#[no_mangle]
pub unsafe fn instr16_83_0_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, add16(___, imm));
}
#[no_mangle]
pub unsafe fn instr16_83_0_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, add16(____0, imm));
}
#[no_mangle]
pub unsafe fn instr16_83_1_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, or16(___, imm));
}
#[no_mangle]
pub unsafe fn instr16_83_1_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, or16(____0, imm));
}
#[no_mangle]
pub unsafe fn instr16_83_2_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, adc16(___, imm));
}
#[no_mangle]
pub unsafe fn instr16_83_2_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, adc16(____0, imm));
}
#[no_mangle]
pub unsafe fn instr16_83_3_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, sbb16(___, imm));
}
#[no_mangle]
pub unsafe fn instr16_83_3_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, sbb16(____0, imm));
}
#[no_mangle]
pub unsafe fn instr16_83_4_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, and16(___, imm));
}
#[no_mangle]
pub unsafe fn instr16_83_4_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, and16(____0, imm));
}
#[no_mangle]
pub unsafe fn instr16_83_5_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, sub16(___, imm));
}
#[no_mangle]
pub unsafe fn instr16_83_5_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, sub16(____0, imm));
}
#[no_mangle]
pub unsafe fn instr16_83_6_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, xor16(___, imm));
}
#[no_mangle]
pub unsafe fn instr16_83_6_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, xor16(____0, imm));
}
#[no_mangle]
pub unsafe fn instr16_83_7_reg(mut r: i32, mut imm: i32) -> () { cmp16(read_reg16(r), imm); }
#[no_mangle]
pub unsafe fn instr16_83_7_mem(mut addr: i32, mut imm: i32) -> () {
    cmp16(return_on_pagefault!(safe_read16(addr)), imm);
}
#[no_mangle]
pub unsafe fn instr32_83_0_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, add32(___, imm));
}
#[no_mangle]
pub unsafe fn instr32_83_0_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, add32(____0, imm));
}
#[no_mangle]
pub unsafe fn instr32_83_1_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, or32(___, imm));
}
#[no_mangle]
pub unsafe fn instr32_83_1_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, or32(____0, imm));
}
#[no_mangle]
pub unsafe fn instr32_83_2_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, adc32(___, imm));
}
#[no_mangle]
pub unsafe fn instr32_83_2_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, adc32(____0, imm));
}
#[no_mangle]
pub unsafe fn instr32_83_3_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, sbb32(___, imm));
}
#[no_mangle]
pub unsafe fn instr32_83_3_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, sbb32(____0, imm));
}
#[no_mangle]
pub unsafe fn instr32_83_4_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, and32(___, imm));
}
#[no_mangle]
pub unsafe fn instr32_83_4_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, and32(____0, imm));
}
#[no_mangle]
pub unsafe fn instr32_83_5_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, sub32(___, imm));
}
#[no_mangle]
pub unsafe fn instr32_83_5_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, sub32(____0, imm));
}
#[no_mangle]
pub unsafe fn instr32_83_6_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, xor32(___, imm));
}
#[no_mangle]
pub unsafe fn instr32_83_6_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, xor32(____0, imm));
}
#[no_mangle]
pub unsafe fn instr32_83_7_reg(mut r: i32, mut imm: i32) -> () { cmp32(read_reg32(r), imm); }
#[no_mangle]
pub unsafe fn instr32_83_7_mem(mut addr: i32, mut imm: i32) -> () {
    cmp32(return_on_pagefault!(safe_read32s(addr)), imm);
}
#[no_mangle]
pub unsafe fn instr_84_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read8(addr));
    test8(____0, read_reg8(r));
}
#[no_mangle]
pub unsafe fn instr_84_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    test8(____0, read_reg8(r));
}
#[no_mangle]
pub unsafe fn instr16_85_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    test16(____0, read_reg16(r));
}
#[no_mangle]
pub unsafe fn instr16_85_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    test16(____0, read_reg16(r));
}
#[no_mangle]
pub unsafe fn instr32_85_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    test32(____0, read_reg32(r));
}
#[no_mangle]
pub unsafe fn instr32_85_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    test32(____0, read_reg32(r));
}
#[no_mangle]
pub unsafe fn instr_86_mem(mut addr: i32, mut r: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, xchg8(___, get_reg8_index(r)));
}
#[no_mangle]
pub unsafe fn instr_86_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, xchg8(____0, get_reg8_index(r)));
}
#[no_mangle]
pub unsafe fn instr16_87_mem(mut addr: i32, mut r: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, xchg16(___, get_reg16_index(r)));
}
#[no_mangle]
pub unsafe fn instr16_87_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, xchg16(____0, get_reg16_index(r)));
}
#[no_mangle]
pub unsafe fn instr32_87_mem(mut addr: i32, mut r: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, xchg32(___, r));
}
#[no_mangle]
pub unsafe fn instr32_87_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, xchg32(____0, r));
}
#[no_mangle]
pub unsafe fn instr_88_reg(mut r2: i32, mut r: i32) -> () { write_reg8(r2, read_reg8(r)); }
#[no_mangle]
pub unsafe fn instr_88_mem(mut addr: i32, mut r: i32) -> () {
    return_on_pagefault!(safe_write8(addr, read_reg8(r)));
}
#[no_mangle]
pub unsafe fn instr16_89_reg(mut r2: i32, mut r: i32) -> () { write_reg16(r2, read_reg16(r)); }
#[no_mangle]
pub unsafe fn instr16_89_mem(mut addr: i32, mut r: i32) -> () {
    return_on_pagefault!(safe_write16(addr, read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr32_89_reg(mut r2: i32, mut r: i32) -> () { write_reg32(r2, read_reg32(r)); }
#[no_mangle]
pub unsafe fn instr32_89_mem(mut addr: i32, mut r: i32) -> () {
    return_on_pagefault!(safe_write32(addr, read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr_8A_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read8(addr));
    write_reg8(r, ____0);
}
#[no_mangle]
pub unsafe fn instr_8A_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r, ____0);
}
#[no_mangle]
pub unsafe fn instr16_8B_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    write_reg16(r, ____0);
}
#[no_mangle]
pub unsafe fn instr16_8B_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r, ____0);
}
#[no_mangle]
pub unsafe fn instr32_8B_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    write_reg32(r, ____0);
}
#[no_mangle]
pub unsafe fn instr32_8B_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r, ____0);
}
#[no_mangle]
pub unsafe fn instr_8C_check_sreg(mut seg: i32) -> bool {
    if seg >= 6i32 {
        dbg_log_c!("mov sreg #ud");
        trigger_ud();
        return 0 != 0i32;
    }
    else {
        return 0 != 1i32;
    };
}
#[no_mangle]
pub unsafe fn instr16_8C_reg(mut r: i32, mut seg: i32) -> () {
    if instr_8C_check_sreg(seg) {
        write_reg16(r, *sreg.offset(seg as isize) as i32);
    };
}
#[no_mangle]
pub unsafe fn instr16_8C_mem(mut addr: i32, mut seg: i32) -> () {
    if instr_8C_check_sreg(seg) {
        return_on_pagefault!(safe_write16(addr, *sreg.offset(seg as isize) as i32));
    };
}
#[no_mangle]
pub unsafe fn instr32_8C_reg(mut r: i32, mut seg: i32) -> () {
    if instr_8C_check_sreg(seg) {
        write_reg32(r, *sreg.offset(seg as isize) as i32);
    };
}
#[no_mangle]
pub unsafe fn instr32_8C_mem(mut addr: i32, mut seg: i32) -> () {
    if instr_8C_check_sreg(seg) {
        return_on_pagefault!(safe_write32(addr, *sreg.offset(seg as isize) as i32));
    };
}
#[no_mangle]
pub unsafe fn instr16_8D_reg(mut r: i32, mut r2: i32) -> () {
    dbg_log_c!("lea #ud");
    trigger_ud();
}
#[no_mangle]
pub unsafe fn instr16_8D_mem(modrm_byte: i32, mut r: i32) -> () {
    c_comment!(("lea"));
    *prefixes = (*prefixes as i32 | SEG_PREFIX_ZERO) as u8;
    if let Ok(addr) = modrm_resolve(modrm_byte) {
        write_reg16(r, addr);
    }
    *prefixes = 0i32 as u8;
}
#[no_mangle]
pub unsafe fn instr32_8D_reg(mut r: i32, mut r2: i32) -> () {
    dbg_log_c!("lea #ud");
    trigger_ud();
}
#[no_mangle]
pub unsafe fn instr32_8D_mem(modrm_byte: i32, mut r: i32) -> () {
    c_comment!(("lea"));
    c_comment!(("override prefix, so modrm_resolve does not return the segment part"));
    *prefixes = (*prefixes as i32 | SEG_PREFIX_ZERO) as u8;
    if let Ok(addr) = modrm_resolve(modrm_byte) {
        write_reg32(r, addr);
    }
    *prefixes = 0i32 as u8;
}
#[no_mangle]
pub unsafe fn instr_8E_helper(mut data: i32, mut mod_0: i32) -> () {
    if mod_0 == ES || mod_0 == SS || mod_0 == DS || mod_0 == FS || mod_0 == GS {
        if !switch_seg(mod_0, data) {
            return;
        }
    }
    else {
        dbg_log_c!("mov sreg #ud");
        trigger_ud();
    };
}
#[no_mangle]
pub unsafe fn instr_8E_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    instr_8E_helper(____0, r);
}
#[no_mangle]
pub unsafe fn instr_8E_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    instr_8E_helper(____0, r);
}

#[no_mangle]
pub unsafe fn instr16_8F_0_mem(modrm_byte: i32) -> () {
    c_comment!(("pop"));
    // Update esp *before* resolving the address
    adjust_stack_reg(2i32);
    match modrm_resolve(modrm_byte) {
        Err(()) => {
            // a pagefault happened, reset esp
            adjust_stack_reg(-2i32);
        },
        Ok(addr) => {
            adjust_stack_reg(-2i32);
            let mut stack_value: i32 = return_on_pagefault!(safe_read16(get_stack_pointer(0i32)));
            return_on_pagefault!(safe_write16(addr, stack_value));
            adjust_stack_reg(2i32);
        },
    }
}

#[no_mangle]
pub unsafe fn instr16_8F_0_mem_jit(addr: i32) -> () {
    adjust_stack_reg(-2i32);
    let mut stack_value: i32 = return_on_pagefault!(safe_read16(get_stack_pointer(0i32)));
    return_on_pagefault!(safe_write16(addr, stack_value));
    adjust_stack_reg(2i32);
}

#[no_mangle]
pub unsafe fn instr16_8F_0_reg(mut r: i32) -> () { write_reg16(r, return_on_pagefault!(pop16())); }
#[no_mangle]
pub unsafe fn instr32_8F_0_mem(modrm_byte: i32) -> () {
    // Update esp *before* resolving the address
    adjust_stack_reg(4i32);
    match modrm_resolve(modrm_byte) {
        Err(()) => {
            // a pagefault happened, reset esp
            adjust_stack_reg(-4i32);
        },
        Ok(addr) => {
            adjust_stack_reg(-4i32);
            let mut stack_value: i32 = return_on_pagefault!(safe_read32s(get_stack_pointer(0i32)));
            return_on_pagefault!(safe_write32(addr, stack_value));
            adjust_stack_reg(4i32);
        },
    }
}

#[no_mangle]
pub unsafe fn instr32_8F_0_mem_jit(addr: i32) -> () {
    adjust_stack_reg(-4i32);
    let mut stack_value: i32 = return_on_pagefault!(safe_read32s(get_stack_pointer(0i32)));
    return_on_pagefault!(safe_write32(addr, stack_value));
    adjust_stack_reg(4i32);
}

#[no_mangle]
pub unsafe fn instr32_8F_0_reg(mut r: i32) -> () { write_reg32(r, return_on_pagefault!(pop32s())); }

#[no_mangle]
pub unsafe fn instr_90() -> () {}
#[no_mangle]
pub unsafe fn instr16_91() -> () { xchg16r(CX); }
#[no_mangle]
pub unsafe fn instr32_91() -> () { xchg32r(ECX); }
#[no_mangle]
pub unsafe fn instr16_92() -> () { xchg16r(DX); }
#[no_mangle]
pub unsafe fn instr32_92() -> () { xchg32r(EDX); }
#[no_mangle]
pub unsafe fn instr16_93() -> () { xchg16r(BX); }
#[no_mangle]
pub unsafe fn instr32_93() -> () { xchg32r(EBX); }
#[no_mangle]
pub unsafe fn instr16_94() -> () { xchg16r(SP); }
#[no_mangle]
pub unsafe fn instr32_94() -> () { xchg32r(ESP); }
#[no_mangle]
pub unsafe fn instr16_95() -> () { xchg16r(BP); }
#[no_mangle]
pub unsafe fn instr32_95() -> () { xchg32r(EBP); }
#[no_mangle]
pub unsafe fn instr16_96() -> () { xchg16r(SI); }
#[no_mangle]
pub unsafe fn instr32_96() -> () { xchg32r(ESI); }
#[no_mangle]
pub unsafe fn instr16_97() -> () { xchg16r(DI); }
#[no_mangle]
pub unsafe fn instr32_97() -> () { xchg32r(EDI); }
#[no_mangle]
pub unsafe fn instr16_98() -> () { *reg16.offset(AX as isize) = *reg8s.offset(AL as isize) as u16; }
#[no_mangle]
pub unsafe fn instr32_98() -> () {
    *reg32s.offset(EAX as isize) = *reg16s.offset(AX as isize) as i32;
}
#[no_mangle]
pub unsafe fn instr16_99() -> () {
    *reg16.offset(DX as isize) = (*reg16s.offset(AX as isize) as i32 >> 15i32) as u16;
}
#[no_mangle]
pub unsafe fn instr32_99() -> () {
    *reg32s.offset(EDX as isize) = *reg32s.offset(EAX as isize) >> 31i32;
}
#[no_mangle]
pub unsafe fn instr16_9A(mut new_ip: i32, mut new_cs: i32) -> () {
    c_comment!(("callf"));
    far_jump(new_ip, new_cs, true);
    dbg_assert!(0 != is_asize_32() as i32 || get_real_eip() < 65536i32);
}
#[no_mangle]
pub unsafe fn instr32_9A(mut new_ip: i32, mut new_cs: i32) -> () {
    if !*protected_mode || 0 != vm86_mode() as i32 {
        if 0 != new_ip as u32 & 4294901760u32 {
            dbg_assert!(0 != 0i32);
        }
    }
    far_jump(new_ip, new_cs, true);
    dbg_assert!(0 != is_asize_32() as i32 || get_real_eip() < 65536i32);
}
#[no_mangle]
pub unsafe fn instr_9B() -> () {
    c_comment!(("fwait: check for pending fpu exceptions"));
    if *cr.offset(0isize) & (CR0_MP | CR0_TS) == CR0_MP | CR0_TS {
        c_comment!(("Note: Different from task_switch_test"));
        c_comment!(("Triggers when TS and MP bits are set (EM bit is ignored)"));
        trigger_nm();
    }
    else {
        fwait();
    };
}
#[no_mangle]
pub unsafe fn instr16_9C() -> () {
    c_comment!(("pushf"));
    if 0 != *flags.offset(0isize) & FLAG_VM && getiopl() < 3i32 {
        dbg_assert!(*protected_mode);
        dbg_log_c!("pushf #gp");
        trigger_gp_non_raising(0i32);
    }
    else {
        return_on_pagefault!(push16(get_eflags()));
    };
}
#[no_mangle]
pub unsafe fn instr32_9C() -> () {
    c_comment!(("pushf"));
    if 0 != *flags.offset(0isize) & FLAG_VM && getiopl() < 3i32 {
        c_comment!(("trap to virtual 8086 monitor"));
        dbg_assert!(*protected_mode);
        dbg_log_c!("pushf #gp");
        trigger_gp_non_raising(0i32);
    }
    else {
        c_comment!(("vm and rf flag are cleared in image stored on the stack"));
        return_on_pagefault!(push32(get_eflags() & 16580607i32));
    };
}
#[no_mangle]
pub unsafe fn instr16_9D() -> () {
    c_comment!(("popf"));
    if 0 != *flags.offset(0isize) & FLAG_VM && getiopl() < 3i32 {
        dbg_log_c!("popf #gp");
        trigger_gp_non_raising(0i32);
        return;
    }
    else {
        update_eflags(*flags.offset(0isize) & !65535i32 | return_on_pagefault!(pop16()));
        if 0 != *flags.offset(0isize) & FLAG_TRAP {
            let ref mut fresh0 = *flags.offset(0isize);
            *fresh0 &= !FLAG_TRAP
        }
        else {
            handle_irqs();
        }
        return;
    };
}
#[no_mangle]
pub unsafe fn instr32_9D() -> () {
    c_comment!(("popf"));
    if 0 != *flags.offset(0isize) & FLAG_VM && getiopl() < 3i32 {
        dbg_log_c!("popf #gp");
        trigger_gp_non_raising(0i32);
        return;
    }
    else {
        update_eflags(return_on_pagefault!(pop32s()));
        handle_irqs();
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_9E() -> () {
    c_comment!(("sahf"));
    *flags.offset(0isize) = *flags.offset(0isize) & !255i32 | *reg8.offset(AH as isize) as i32;
    *flags.offset(0isize) = *flags.offset(0isize) & FLAGS_MASK | FLAGS_DEFAULT;
    let ref mut fresh1 = *flags_changed.offset(0isize);
    *fresh1 &= !255i32;
}
#[no_mangle]
pub unsafe fn instr_9F() -> () {
    c_comment!(("lahf"));
    *reg8.offset(AH as isize) = get_eflags() as u8;
}
#[no_mangle]
pub unsafe fn instr_A0(mut moffs: i32) -> () {
    c_comment!(("mov"));
    let mut data: i32 = return_on_pagefault!(safe_read8(get_seg_prefix_ds(moffs)));
    *reg8.offset(AL as isize) = data as u8;
}
#[no_mangle]
pub unsafe fn instr16_A1(mut moffs: i32) -> () {
    c_comment!(("mov"));
    let mut data: i32 = return_on_pagefault!(safe_read16(get_seg_prefix_ds(moffs)));
    *reg16.offset(AX as isize) = data as u16;
}
#[no_mangle]
pub unsafe fn instr32_A1(mut moffs: i32) -> () {
    let mut data: i32 = return_on_pagefault!(safe_read32s(get_seg_prefix_ds(moffs)));
    *reg32s.offset(EAX as isize) = data;
}
#[no_mangle]
pub unsafe fn instr_A2(mut moffs: i32) -> () {
    c_comment!(("mov"));
    return_on_pagefault!(safe_write8(
        get_seg_prefix_ds(moffs),
        *reg8.offset(AL as isize) as i32
    ));
}
#[no_mangle]
pub unsafe fn instr16_A3(mut moffs: i32) -> () {
    c_comment!(("mov"));
    return_on_pagefault!(safe_write16(
        get_seg_prefix_ds(moffs),
        *reg16.offset(AX as isize) as i32
    ));
}
#[no_mangle]
pub unsafe fn instr32_A3(mut moffs: i32) -> () {
    return_on_pagefault!(safe_write32(
        get_seg_prefix_ds(moffs),
        *reg32s.offset(EAX as isize)
    ));
}
#[no_mangle]
pub unsafe fn instr_A4() -> () { movsb_no_rep(); }
#[no_mangle]
pub unsafe fn instr16_A5() -> () { movsw_no_rep(); }
#[no_mangle]
pub unsafe fn instr32_A5() -> () { movsd_no_rep(); }
#[no_mangle]
pub unsafe fn instr_A6() -> () { cmpsb_no_rep(); }
#[no_mangle]
pub unsafe fn instr16_A7() -> () { cmpsw_no_rep(); }
#[no_mangle]
pub unsafe fn instr32_A7() -> () { cmpsd_no_rep(); }
#[no_mangle]
pub unsafe fn instr_A8(mut imm8: i32) -> () { test8(*reg8.offset(AL as isize) as i32, imm8); }
#[no_mangle]
pub unsafe fn instr16_A9(mut imm16: i32) -> () { test16(*reg16.offset(AX as isize) as i32, imm16); }
#[no_mangle]
pub unsafe fn instr32_A9(mut imm32: i32) -> () { test32(*reg32s.offset(EAX as isize), imm32); }
#[no_mangle]
pub unsafe fn instr_AA() -> () { stosb_no_rep(); }
#[no_mangle]
pub unsafe fn instr16_AB() -> () { stosw_no_rep(); }
#[no_mangle]
pub unsafe fn instr32_AB() -> () { stosd_no_rep(); }
#[no_mangle]
pub unsafe fn instr_AC() -> () { lodsb_no_rep(); }
#[no_mangle]
pub unsafe fn instr16_AD() -> () { lodsw_no_rep(); }
#[no_mangle]
pub unsafe fn instr32_AD() -> () { lodsd_no_rep(); }
#[no_mangle]
pub unsafe fn instr_AE() -> () { scasb_no_rep(); }
#[no_mangle]
pub unsafe fn instr16_AF() -> () { scasw_no_rep(); }
#[no_mangle]
pub unsafe fn instr32_AF() -> () { scasd_no_rep(); }
#[no_mangle]
pub unsafe fn instr_B0(mut imm8: i32) -> () { *reg8.offset(AL as isize) = imm8 as u8; }
#[no_mangle]
pub unsafe fn instr_B1(mut imm8: i32) -> () { *reg8.offset(CL as isize) = imm8 as u8; }
#[no_mangle]
pub unsafe fn instr_B2(mut imm8: i32) -> () { *reg8.offset(DL as isize) = imm8 as u8; }
#[no_mangle]
pub unsafe fn instr_B3(mut imm8: i32) -> () { *reg8.offset(BL as isize) = imm8 as u8; }
#[no_mangle]
pub unsafe fn instr_B4(mut imm8: i32) -> () { *reg8.offset(AH as isize) = imm8 as u8; }
#[no_mangle]
pub unsafe fn instr_B5(mut imm8: i32) -> () { *reg8.offset(CH as isize) = imm8 as u8; }
#[no_mangle]
pub unsafe fn instr_B6(mut imm8: i32) -> () { *reg8.offset(DH as isize) = imm8 as u8; }
#[no_mangle]
pub unsafe fn instr_B7(mut imm8: i32) -> () { *reg8.offset(BH as isize) = imm8 as u8; }
#[no_mangle]
pub unsafe fn instr16_B8(mut imm: i32) -> () { *reg16.offset(AX as isize) = imm as u16; }
#[no_mangle]
pub unsafe fn instr32_B8(mut imm: i32) -> () { *reg32s.offset(EAX as isize) = imm; }
#[no_mangle]
pub unsafe fn instr16_B9(mut imm: i32) -> () { *reg16.offset(CX as isize) = imm as u16; }
#[no_mangle]
pub unsafe fn instr32_B9(mut imm: i32) -> () { *reg32s.offset(ECX as isize) = imm; }
#[no_mangle]
pub unsafe fn instr16_BA(mut imm: i32) -> () { *reg16.offset(DX as isize) = imm as u16; }
#[no_mangle]
pub unsafe fn instr32_BA(mut imm: i32) -> () { *reg32s.offset(EDX as isize) = imm; }
#[no_mangle]
pub unsafe fn instr16_BB(mut imm: i32) -> () { *reg16.offset(BX as isize) = imm as u16; }
#[no_mangle]
pub unsafe fn instr32_BB(mut imm: i32) -> () { *reg32s.offset(EBX as isize) = imm; }
#[no_mangle]
pub unsafe fn instr16_BC(mut imm: i32) -> () { *reg16.offset(SP as isize) = imm as u16; }
#[no_mangle]
pub unsafe fn instr32_BC(mut imm: i32) -> () { *reg32s.offset(ESP as isize) = imm; }
#[no_mangle]
pub unsafe fn instr16_BD(mut imm: i32) -> () { *reg16.offset(BP as isize) = imm as u16; }
#[no_mangle]
pub unsafe fn instr32_BD(mut imm: i32) -> () { *reg32s.offset(EBP as isize) = imm; }
#[no_mangle]
pub unsafe fn instr16_BE(mut imm: i32) -> () { *reg16.offset(SI as isize) = imm as u16; }
#[no_mangle]
pub unsafe fn instr32_BE(mut imm: i32) -> () { *reg32s.offset(ESI as isize) = imm; }
#[no_mangle]
pub unsafe fn instr16_BF(mut imm: i32) -> () { *reg16.offset(DI as isize) = imm as u16; }
#[no_mangle]
pub unsafe fn instr32_BF(mut imm: i32) -> () { *reg32s.offset(EDI as isize) = imm; }
#[no_mangle]
pub unsafe fn instr_C0_0_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, rol8(___, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr_C0_0_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, rol8(____0, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr_C0_1_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, ror8(___, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr_C0_1_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, ror8(____0, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr_C0_2_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, rcl8(___, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr_C0_2_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, rcl8(____0, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr_C0_3_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, rcr8(___, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr_C0_3_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, rcr8(____0, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr_C0_4_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, shl8(___, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr_C0_4_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, shl8(____0, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr_C0_5_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, shr8(___, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr_C0_5_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, shr8(____0, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr_C0_6_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, shl8(___, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr_C0_6_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, shl8(____0, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr_C0_7_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, sar8(___, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr_C0_7_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, sar8(____0, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr16_C1_0_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, rol16(___, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr16_C1_0_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, rol16(____0, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr16_C1_1_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, ror16(___, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr16_C1_1_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, ror16(____0, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr16_C1_2_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, rcl16(___, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr16_C1_2_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, rcl16(____0, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr16_C1_3_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, rcr16(___, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr16_C1_3_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, rcr16(____0, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr16_C1_4_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, shl16(___, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr16_C1_4_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, shl16(____0, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr16_C1_5_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, shr16(___, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr16_C1_5_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, shr16(____0, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr16_C1_6_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, shl16(___, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr16_C1_6_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, shl16(____0, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr16_C1_7_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, sar16(___, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr16_C1_7_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, sar16(____0, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr32_C1_0_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, rol32(___, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr32_C1_0_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, rol32(____0, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr32_C1_1_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, ror32(___, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr32_C1_1_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, ror32(____0, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr32_C1_2_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, rcl32(___, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr32_C1_2_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, rcl32(____0, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr32_C1_3_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, rcr32(___, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr32_C1_3_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, rcr32(____0, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr32_C1_4_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, shl32(___, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr32_C1_4_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, shl32(____0, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr32_C1_5_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, shr32(___, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr32_C1_5_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, shr32(____0, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr32_C1_6_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, shl32(___, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr32_C1_6_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, shl32(____0, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr32_C1_7_mem(mut addr: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, sar32(___, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr32_C1_7_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, sar32(____0, imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr16_C2(mut imm16: i32) -> () {
    c_comment!(("retn"));
    let mut cs: i32 = get_seg_cs();
    *instruction_pointer.offset(0isize) = cs + return_on_pagefault!(pop16());
    dbg_assert!(0 != is_asize_32() as i32 || get_real_eip() < 65536i32);
    adjust_stack_reg(imm16);
}
#[no_mangle]
pub unsafe fn instr32_C2(mut imm16: i32) -> () {
    c_comment!(("retn"));
    let mut cs: i32 = get_seg_cs();
    let mut ip: i32 = return_on_pagefault!(pop32s());
    dbg_assert!(0 != is_asize_32() as i32 || ip < 65536i32);
    *instruction_pointer.offset(0isize) = cs + ip;
    adjust_stack_reg(imm16);
}
#[no_mangle]
pub unsafe fn instr16_C3() -> () {
    c_comment!(("retn"));
    let mut cs: i32 = get_seg_cs();
    *instruction_pointer.offset(0isize) = cs + return_on_pagefault!(pop16());
}
#[no_mangle]
pub unsafe fn instr32_C3() -> () {
    c_comment!(("retn"));
    let mut cs: i32 = get_seg_cs();
    let mut ip: i32 = return_on_pagefault!(pop32s());
    dbg_assert!(0 != is_asize_32() as i32 || ip < 65536i32);
    *instruction_pointer.offset(0isize) = cs + ip;
}
#[no_mangle]
pub unsafe fn instr16_C4_reg(mut _unused1: i32, mut _unused2: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr16_C4_mem(mut addr: i32, mut r: i32) -> () {
    lss16(addr, get_reg16_index(r), ES);
}
#[no_mangle]
pub unsafe fn instr32_C4_reg(mut _unused1: i32, mut _unused2: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr32_C4_mem(mut addr: i32, mut r: i32) -> () { lss32(addr, r, ES); }
#[no_mangle]
pub unsafe fn instr16_C5_reg(mut _unused1: i32, mut _unused2: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr16_C5_mem(mut addr: i32, mut r: i32) -> () {
    lss16(addr, get_reg16_index(r), DS);
}
#[no_mangle]
pub unsafe fn instr32_C5_reg(mut _unused1: i32, mut _unused2: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr32_C5_mem(mut addr: i32, mut r: i32) -> () { lss32(addr, r, DS); }
#[no_mangle]
pub unsafe fn instr_C6_0_reg(mut r: i32, mut imm: i32) -> () { write_reg8(r, imm); }
#[no_mangle]
pub unsafe fn instr_C6_0_mem(mut addr: i32, mut imm: i32) -> () {
    return_on_pagefault!(safe_write8(addr, imm));
}
#[no_mangle]
pub unsafe fn instr16_C7_0_reg(mut r: i32, mut imm: i32) -> () { write_reg16(r, imm); }
#[no_mangle]
pub unsafe fn instr16_C7_0_mem(mut addr: i32, mut imm: i32) -> () {
    return_on_pagefault!(safe_write16(addr, imm));
}
#[no_mangle]
pub unsafe fn instr32_C7_0_reg(mut r: i32, mut imm: i32) -> () { write_reg32(r, imm); }
#[no_mangle]
pub unsafe fn instr32_C7_0_mem(mut addr: i32, mut imm: i32) -> () {
    return_on_pagefault!(safe_write32(addr, imm));
}
#[no_mangle]
pub unsafe fn instr16_C8(mut size: i32, mut nesting: i32) -> () { enter16(size, nesting); }
#[no_mangle]
pub unsafe fn instr32_C8(mut size: i32, mut nesting: i32) -> () { enter32(size, nesting); }
#[no_mangle]
pub unsafe fn instr16_C9() -> () {
    c_comment!(("leave"));
    let mut old_vbp: i32 = if 0 != *stack_size_32 as i32 {
        *reg32s.offset(EBP as isize)
    }
    else {
        *reg16.offset(BP as isize) as i32
    };
    let mut new_bp: i32 = return_on_pagefault!(safe_read16(get_seg_ss() + old_vbp));
    set_stack_reg(old_vbp + 2i32);
    *reg16.offset(BP as isize) = new_bp as u16;
}
#[no_mangle]
pub unsafe fn instr32_C9() -> () {
    let mut old_vbp: i32 = if 0 != *stack_size_32 as i32 {
        *reg32s.offset(EBP as isize)
    }
    else {
        *reg16.offset(BP as isize) as i32
    };
    let mut new_ebp: i32 = return_on_pagefault!(safe_read32s(get_seg_ss() + old_vbp));
    set_stack_reg(old_vbp + 4i32);
    *reg32s.offset(EBP as isize) = new_ebp;
}
#[no_mangle]
pub unsafe fn instr16_CA(mut imm16: i32) -> () {
    c_comment!(("retf"));
    let mut ip: i32 = return_on_pagefault!(safe_read16(get_stack_pointer(0i32)));
    let mut cs: i32 = return_on_pagefault!(safe_read16(get_stack_pointer(2i32)));
    far_return(ip, cs, imm16);
}
#[no_mangle]
pub unsafe fn instr32_CA(mut imm16: i32) -> () {
    c_comment!(("retf"));
    let mut ip: i32 = return_on_pagefault!(safe_read32s(get_stack_pointer(0i32)));
    let mut cs: i32 = return_on_pagefault!(safe_read32s(get_stack_pointer(4i32))) & 65535i32;
    far_return(ip, cs, imm16);
    dbg_assert!(0 != is_asize_32() as i32 || get_real_eip() < 65536i32);
}
#[no_mangle]
pub unsafe fn instr16_CB() -> () {
    c_comment!(("retf"));
    let mut ip: i32 = return_on_pagefault!(safe_read16(get_stack_pointer(0i32)));
    let mut cs: i32 = return_on_pagefault!(safe_read16(get_stack_pointer(2i32)));
    far_return(ip, cs, 0i32);
    dbg_assert!(0 != is_asize_32() as i32 || get_real_eip() < 65536i32);
}
#[no_mangle]
pub unsafe fn instr32_CB() -> () {
    c_comment!(("retf"));
    let mut ip: i32 = return_on_pagefault!(safe_read32s(get_stack_pointer(0i32)));
    let mut cs: i32 = return_on_pagefault!(safe_read32s(get_stack_pointer(4i32))) & 65535i32;
    far_return(ip, cs, 0i32);
    dbg_assert!(0 != is_asize_32() as i32 || get_real_eip() < 65536i32);
}
#[no_mangle]
pub unsafe fn instr_CC() -> () {
    c_comment!(("INT3"));
    c_comment!(("TODO: inhibit iopl checks"));
    dbg_log_c!("INT3");
    call_interrupt_vector(3i32, 0 != 1i32, 0 != 0i32, 0i32);
}
#[no_mangle]
pub unsafe fn instr_CD(mut imm8: i32) -> () {
    c_comment!(("INT"));
    call_interrupt_vector(imm8, 0 != 1i32, 0 != 0i32, 0i32);
}
#[no_mangle]
pub unsafe fn instr_CE() -> () {
    c_comment!(("INTO"));
    dbg_log_c!("INTO");
    if getof() {
        c_comment!(("TODO: inhibit iopl checks"));
        call_interrupt_vector(CPU_EXCEPTION_OF, 0 != 1i32, 0 != 0i32, 0i32);
    };
}
#[no_mangle]
pub unsafe fn instr16_CF() -> () {
    c_comment!(("iret"));
    iret16();
}
#[no_mangle]
pub unsafe fn instr32_CF() -> () { iret32(); }
#[no_mangle]
pub unsafe fn instr_D0_0_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, rol8(___, 1i32));
}
#[no_mangle]
pub unsafe fn instr_D0_0_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, rol8(____0, 1i32));
}
#[no_mangle]
pub unsafe fn instr_D0_1_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, ror8(___, 1i32));
}
#[no_mangle]
pub unsafe fn instr_D0_1_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, ror8(____0, 1i32));
}
#[no_mangle]
pub unsafe fn instr_D0_2_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, rcl8(___, 1i32));
}
#[no_mangle]
pub unsafe fn instr_D0_2_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, rcl8(____0, 1i32));
}
#[no_mangle]
pub unsafe fn instr_D0_3_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, rcr8(___, 1i32));
}
#[no_mangle]
pub unsafe fn instr_D0_3_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, rcr8(____0, 1i32));
}
#[no_mangle]
pub unsafe fn instr_D0_4_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, shl8(___, 1i32));
}
#[no_mangle]
pub unsafe fn instr_D0_4_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, shl8(____0, 1i32));
}
#[no_mangle]
pub unsafe fn instr_D0_5_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, shr8(___, 1i32));
}
#[no_mangle]
pub unsafe fn instr_D0_5_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, shr8(____0, 1i32));
}
#[no_mangle]
pub unsafe fn instr_D0_6_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, shl8(___, 1i32));
}
#[no_mangle]
pub unsafe fn instr_D0_6_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, shl8(____0, 1i32));
}
#[no_mangle]
pub unsafe fn instr_D0_7_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, sar8(___, 1i32));
}
#[no_mangle]
pub unsafe fn instr_D0_7_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, sar8(____0, 1i32));
}
#[no_mangle]
pub unsafe fn instr16_D1_0_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, rol16(___, 1i32));
}
#[no_mangle]
pub unsafe fn instr16_D1_0_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, rol16(____0, 1i32));
}
#[no_mangle]
pub unsafe fn instr16_D1_1_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, ror16(___, 1i32));
}
#[no_mangle]
pub unsafe fn instr16_D1_1_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, ror16(____0, 1i32));
}
#[no_mangle]
pub unsafe fn instr16_D1_2_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, rcl16(___, 1i32));
}
#[no_mangle]
pub unsafe fn instr16_D1_2_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, rcl16(____0, 1i32));
}
#[no_mangle]
pub unsafe fn instr16_D1_3_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, rcr16(___, 1i32));
}
#[no_mangle]
pub unsafe fn instr16_D1_3_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, rcr16(____0, 1i32));
}
#[no_mangle]
pub unsafe fn instr16_D1_4_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, shl16(___, 1i32));
}
#[no_mangle]
pub unsafe fn instr16_D1_4_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, shl16(____0, 1i32));
}
#[no_mangle]
pub unsafe fn instr16_D1_5_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, shr16(___, 1i32));
}
#[no_mangle]
pub unsafe fn instr16_D1_5_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, shr16(____0, 1i32));
}
#[no_mangle]
pub unsafe fn instr16_D1_6_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, shl16(___, 1i32));
}
#[no_mangle]
pub unsafe fn instr16_D1_6_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, shl16(____0, 1i32));
}
#[no_mangle]
pub unsafe fn instr16_D1_7_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, sar16(___, 1i32));
}
#[no_mangle]
pub unsafe fn instr16_D1_7_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, sar16(____0, 1i32));
}
#[no_mangle]
pub unsafe fn instr32_D1_0_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, rol32(___, 1i32));
}
#[no_mangle]
pub unsafe fn instr32_D1_0_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, rol32(____0, 1i32));
}
#[no_mangle]
pub unsafe fn instr32_D1_1_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, ror32(___, 1i32));
}
#[no_mangle]
pub unsafe fn instr32_D1_1_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, ror32(____0, 1i32));
}
#[no_mangle]
pub unsafe fn instr32_D1_2_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, rcl32(___, 1i32));
}
#[no_mangle]
pub unsafe fn instr32_D1_2_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, rcl32(____0, 1i32));
}
#[no_mangle]
pub unsafe fn instr32_D1_3_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, rcr32(___, 1i32));
}
#[no_mangle]
pub unsafe fn instr32_D1_3_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, rcr32(____0, 1i32));
}
#[no_mangle]
pub unsafe fn instr32_D1_4_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, shl32(___, 1i32));
}
#[no_mangle]
pub unsafe fn instr32_D1_4_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, shl32(____0, 1i32));
}
#[no_mangle]
pub unsafe fn instr32_D1_5_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, shr32(___, 1i32));
}
#[no_mangle]
pub unsafe fn instr32_D1_5_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, shr32(____0, 1i32));
}
#[no_mangle]
pub unsafe fn instr32_D1_6_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, shl32(___, 1i32));
}
#[no_mangle]
pub unsafe fn instr32_D1_6_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, shl32(____0, 1i32));
}
#[no_mangle]
pub unsafe fn instr32_D1_7_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, sar32(___, 1i32));
}
#[no_mangle]
pub unsafe fn instr32_D1_7_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, sar32(____0, 1i32));
}
#[no_mangle]
pub unsafe fn instr_D2_0_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE8!(
        ___,
        addr,
        rol8(___, *reg8.offset(CL as isize) as i32 & 31i32)
    );
}
#[no_mangle]
pub unsafe fn instr_D2_0_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, rol8(____0, *reg8.offset(CL as isize) as i32 & 31i32));
}
#[no_mangle]
pub unsafe fn instr_D2_1_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE8!(
        ___,
        addr,
        ror8(___, *reg8.offset(CL as isize) as i32 & 31i32)
    );
}
#[no_mangle]
pub unsafe fn instr_D2_1_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, ror8(____0, *reg8.offset(CL as isize) as i32 & 31i32));
}
#[no_mangle]
pub unsafe fn instr_D2_2_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE8!(
        ___,
        addr,
        rcl8(___, *reg8.offset(CL as isize) as i32 & 31i32)
    );
}
#[no_mangle]
pub unsafe fn instr_D2_2_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, rcl8(____0, *reg8.offset(CL as isize) as i32 & 31i32));
}
#[no_mangle]
pub unsafe fn instr_D2_3_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE8!(
        ___,
        addr,
        rcr8(___, *reg8.offset(CL as isize) as i32 & 31i32)
    );
}
#[no_mangle]
pub unsafe fn instr_D2_3_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, rcr8(____0, *reg8.offset(CL as isize) as i32 & 31i32));
}
#[no_mangle]
pub unsafe fn instr_D2_4_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE8!(
        ___,
        addr,
        shl8(___, *reg8.offset(CL as isize) as i32 & 31i32)
    );
}
#[no_mangle]
pub unsafe fn instr_D2_4_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, shl8(____0, *reg8.offset(CL as isize) as i32 & 31i32));
}
#[no_mangle]
pub unsafe fn instr_D2_5_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE8!(
        ___,
        addr,
        shr8(___, *reg8.offset(CL as isize) as i32 & 31i32)
    );
}
#[no_mangle]
pub unsafe fn instr_D2_5_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, shr8(____0, *reg8.offset(CL as isize) as i32 & 31i32));
}
#[no_mangle]
pub unsafe fn instr_D2_6_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE8!(
        ___,
        addr,
        shl8(___, *reg8.offset(CL as isize) as i32 & 31i32)
    );
}
#[no_mangle]
pub unsafe fn instr_D2_6_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, shl8(____0, *reg8.offset(CL as isize) as i32 & 31i32));
}
#[no_mangle]
pub unsafe fn instr_D2_7_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE8!(
        ___,
        addr,
        sar8(___, *reg8.offset(CL as isize) as i32 & 31i32)
    );
}
#[no_mangle]
pub unsafe fn instr_D2_7_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, sar8(____0, *reg8.offset(CL as isize) as i32 & 31i32));
}
#[no_mangle]
pub unsafe fn instr16_D3_0_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE16!(
        ___,
        addr,
        rol16(___, *reg8.offset(CL as isize) as i32 & 31i32)
    );
}
#[no_mangle]
pub unsafe fn instr16_D3_0_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, rol16(____0, *reg8.offset(CL as isize) as i32 & 31i32));
}
#[no_mangle]
pub unsafe fn instr16_D3_1_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE16!(
        ___,
        addr,
        ror16(___, *reg8.offset(CL as isize) as i32 & 31i32)
    );
}
#[no_mangle]
pub unsafe fn instr16_D3_1_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, ror16(____0, *reg8.offset(CL as isize) as i32 & 31i32));
}
#[no_mangle]
pub unsafe fn instr16_D3_2_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE16!(
        ___,
        addr,
        rcl16(___, *reg8.offset(CL as isize) as i32 & 31i32)
    );
}
#[no_mangle]
pub unsafe fn instr16_D3_2_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, rcl16(____0, *reg8.offset(CL as isize) as i32 & 31i32));
}
#[no_mangle]
pub unsafe fn instr16_D3_3_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE16!(
        ___,
        addr,
        rcr16(___, *reg8.offset(CL as isize) as i32 & 31i32)
    );
}
#[no_mangle]
pub unsafe fn instr16_D3_3_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, rcr16(____0, *reg8.offset(CL as isize) as i32 & 31i32));
}
#[no_mangle]
pub unsafe fn instr16_D3_4_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE16!(
        ___,
        addr,
        shl16(___, *reg8.offset(CL as isize) as i32 & 31i32)
    );
}
#[no_mangle]
pub unsafe fn instr16_D3_4_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, shl16(____0, *reg8.offset(CL as isize) as i32 & 31i32));
}
#[no_mangle]
pub unsafe fn instr16_D3_5_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE16!(
        ___,
        addr,
        shr16(___, *reg8.offset(CL as isize) as i32 & 31i32)
    );
}
#[no_mangle]
pub unsafe fn instr16_D3_5_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, shr16(____0, *reg8.offset(CL as isize) as i32 & 31i32));
}
#[no_mangle]
pub unsafe fn instr16_D3_6_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE16!(
        ___,
        addr,
        shl16(___, *reg8.offset(CL as isize) as i32 & 31i32)
    );
}
#[no_mangle]
pub unsafe fn instr16_D3_6_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, shl16(____0, *reg8.offset(CL as isize) as i32 & 31i32));
}
#[no_mangle]
pub unsafe fn instr16_D3_7_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE16!(
        ___,
        addr,
        sar16(___, *reg8.offset(CL as isize) as i32 & 31i32)
    );
}
#[no_mangle]
pub unsafe fn instr16_D3_7_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, sar16(____0, *reg8.offset(CL as isize) as i32 & 31i32));
}
#[no_mangle]
pub unsafe fn instr32_D3_0_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE32!(
        ___,
        addr,
        rol32(___, *reg8.offset(CL as isize) as i32 & 31i32)
    );
}
#[no_mangle]
pub unsafe fn instr32_D3_0_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, rol32(____0, *reg8.offset(CL as isize) as i32 & 31i32));
}
#[no_mangle]
pub unsafe fn instr32_D3_1_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE32!(
        ___,
        addr,
        ror32(___, *reg8.offset(CL as isize) as i32 & 31i32)
    );
}
#[no_mangle]
pub unsafe fn instr32_D3_1_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, ror32(____0, *reg8.offset(CL as isize) as i32 & 31i32));
}
#[no_mangle]
pub unsafe fn instr32_D3_2_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE32!(
        ___,
        addr,
        rcl32(___, *reg8.offset(CL as isize) as i32 & 31i32)
    );
}
#[no_mangle]
pub unsafe fn instr32_D3_2_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, rcl32(____0, *reg8.offset(CL as isize) as i32 & 31i32));
}
#[no_mangle]
pub unsafe fn instr32_D3_3_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE32!(
        ___,
        addr,
        rcr32(___, *reg8.offset(CL as isize) as i32 & 31i32)
    );
}
#[no_mangle]
pub unsafe fn instr32_D3_3_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, rcr32(____0, *reg8.offset(CL as isize) as i32 & 31i32));
}
#[no_mangle]
pub unsafe fn instr32_D3_4_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE32!(
        ___,
        addr,
        shl32(___, *reg8.offset(CL as isize) as i32 & 31i32)
    );
}
#[no_mangle]
pub unsafe fn instr32_D3_4_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, shl32(____0, *reg8.offset(CL as isize) as i32 & 31i32));
}
#[no_mangle]
pub unsafe fn instr32_D3_5_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE32!(
        ___,
        addr,
        shr32(___, *reg8.offset(CL as isize) as i32 & 31i32)
    );
}
#[no_mangle]
pub unsafe fn instr32_D3_5_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, shr32(____0, *reg8.offset(CL as isize) as i32 & 31i32));
}
#[no_mangle]
pub unsafe fn instr32_D3_6_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE32!(
        ___,
        addr,
        shl32(___, *reg8.offset(CL as isize) as i32 & 31i32)
    );
}
#[no_mangle]
pub unsafe fn instr32_D3_6_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, shl32(____0, *reg8.offset(CL as isize) as i32 & 31i32));
}
#[no_mangle]
pub unsafe fn instr32_D3_7_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE32!(
        ___,
        addr,
        sar32(___, *reg8.offset(CL as isize) as i32 & 31i32)
    );
}
#[no_mangle]
pub unsafe fn instr32_D3_7_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, sar32(____0, *reg8.offset(CL as isize) as i32 & 31i32));
}
#[no_mangle]
pub unsafe fn instr_D4(mut arg: i32) -> () { bcd_aam(arg); }
#[no_mangle]
pub unsafe fn instr_D5(mut arg: i32) -> () { bcd_aad(arg); }
#[no_mangle]
pub unsafe fn instr_D6() -> () {
    c_comment!(("salc"));
    *reg8.offset(AL as isize) = -(getcf() as i32) as u8;
}
#[no_mangle]
pub unsafe fn instr_D7() -> () {
    c_comment!(("xlat"));
    if is_asize_32() {
        *reg8.offset(AL as isize) = return_on_pagefault!(safe_read8(
            get_seg_prefix(DS) + *reg32s.offset(EBX as isize) + *reg8.offset(AL as isize) as i32,
        )) as u8
    }
    else {
        *reg8.offset(AL as isize) = return_on_pagefault!(safe_read8(
            get_seg_prefix(DS)
                + (*reg16.offset(BX as isize) as i32 + *reg8.offset(AL as isize) as i32 & 65535i32),
        )) as u8
    };
}
#[no_mangle]
pub unsafe fn instr_E4(mut port: i32) -> () {
    if !test_privileges_for_io(port, 1i32) {
        return;
    }
    else {
        *reg8.offset(AL as isize) = io_port_read8(port) as u8;
        return;
    };
}
#[no_mangle]
pub unsafe fn instr16_E5(mut port: i32) -> () {
    if !test_privileges_for_io(port, 2i32) {
        return;
    }
    else {
        *reg16.offset(AX as isize) = io_port_read16(port) as u16;
        return;
    };
}
#[no_mangle]
pub unsafe fn instr32_E5(mut port: i32) -> () {
    if !test_privileges_for_io(port, 4i32) {
        return;
    }
    else {
        *reg32s.offset(EAX as isize) = io_port_read32(port);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_E6(mut port: i32) -> () {
    if !test_privileges_for_io(port, 1i32) {
        return;
    }
    else {
        io_port_write8(port, *reg8.offset(AL as isize) as i32);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr16_E7(mut port: i32) -> () {
    if !test_privileges_for_io(port, 2i32) {
        return;
    }
    else {
        io_port_write16(port, *reg16.offset(AX as isize) as i32);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr32_E7(mut port: i32) -> () {
    if !test_privileges_for_io(port, 4i32) {
        return;
    }
    else {
        io_port_write32(port, *reg32s.offset(EAX as isize));
        return;
    };
}
#[no_mangle]
pub unsafe fn instr16_E8(mut imm16: i32) -> () {
    c_comment!(("call"));
    return_on_pagefault!(push16(get_real_eip()));
    jmp_rel16(imm16);
}
#[no_mangle]
pub unsafe fn instr32_E8(mut imm32s: i32) -> () {
    c_comment!(("call"));
    return_on_pagefault!(push32(get_real_eip()));
    *instruction_pointer.offset(0isize) = *instruction_pointer.offset(0isize) + imm32s;
    c_comment!(("dbg_assert!(is_asize_32() || get_real_eip() < 0x10000);"));
}
#[no_mangle]
pub unsafe fn instr16_E9(mut imm16: i32) -> () {
    c_comment!(("jmp"));
    jmp_rel16(imm16);
}
#[no_mangle]
pub unsafe fn instr32_E9(mut imm32s: i32) -> () {
    c_comment!(("jmp"));
    *instruction_pointer.offset(0isize) = *instruction_pointer.offset(0isize) + imm32s;
    dbg_assert!(0 != is_asize_32() as i32 || get_real_eip() < 65536i32);
}
#[no_mangle]
pub unsafe fn instr16_EA(mut new_ip: i32, mut cs: i32) -> () {
    c_comment!(("jmpf"));
    far_jump(new_ip, cs, false);
    dbg_assert!(0 != is_asize_32() as i32 || get_real_eip() < 65536i32);
}
#[no_mangle]
pub unsafe fn instr32_EA(mut new_ip: i32, mut cs: i32) -> () {
    c_comment!(("jmpf"));
    far_jump(new_ip, cs, false);
    dbg_assert!(0 != is_asize_32() as i32 || get_real_eip() < 65536i32);
}
#[no_mangle]
pub unsafe fn instr_EC() -> () {
    let mut port: i32 = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 1i32) {
        return;
    }
    else {
        *reg8.offset(AL as isize) = io_port_read8(port) as u8;
        return;
    };
}
#[no_mangle]
pub unsafe fn instr16_ED() -> () {
    let mut port: i32 = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 2i32) {
        return;
    }
    else {
        *reg16.offset(AX as isize) = io_port_read16(port) as u16;
        return;
    };
}
#[no_mangle]
pub unsafe fn instr32_ED() -> () {
    let mut port: i32 = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 4i32) {
        return;
    }
    else {
        *reg32s.offset(EAX as isize) = io_port_read32(port);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_EE() -> () {
    let mut port: i32 = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 1i32) {
        return;
    }
    else {
        io_port_write8(port, *reg8.offset(AL as isize) as i32);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr16_EF() -> () {
    let mut port: i32 = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 2i32) {
        return;
    }
    else {
        io_port_write16(port, *reg16.offset(AX as isize) as i32);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr32_EF() -> () {
    let mut port: i32 = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 4i32) {
        return;
    }
    else {
        io_port_write32(port, *reg32s.offset(EAX as isize));
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_F0() -> () {
    c_comment!(("lock"));
    if 0 != 0i32 * 0i32 {
        dbg_log_c!("lock");
    }
    c_comment!(("TODO"));
    c_comment!(("This triggers UD when used with"));
    c_comment!(("some instructions that don\'t write to memory"));
    run_prefix_instruction();
}
#[no_mangle]
pub unsafe fn instr_F1() -> () {
    c_comment!(("INT1"));
    c_comment!(("https://code.google.com/p/corkami/wiki/x86oddities#IceBP"));
    dbg_assert!(0 != 0i32);
}
#[no_mangle]
pub unsafe fn instr_F2() -> () {
    c_comment!(("repnz"));
    dbg_assert!(*prefixes as i32 & PREFIX_MASK_REP == 0i32);
    *prefixes = (*prefixes as i32 | PREFIX_REPNZ) as u8;
    run_prefix_instruction();
    *prefixes = 0i32 as u8;
}
#[no_mangle]
pub unsafe fn instr_F3() -> () {
    c_comment!(("repz"));
    dbg_assert!(*prefixes as i32 & PREFIX_MASK_REP == 0i32);
    *prefixes = (*prefixes as i32 | PREFIX_REPZ) as u8;
    run_prefix_instruction();
    *prefixes = 0i32 as u8;
}
#[no_mangle]
pub unsafe fn instr_F4() -> () { hlt_op(); }
#[no_mangle]
pub unsafe fn instr_F5() -> () {
    c_comment!(("cmc"));
    *flags.offset(0isize) = (*flags.offset(0isize) | 1i32) ^ getcf() as i32;
    let ref mut fresh2 = *flags_changed.offset(0isize);
    *fresh2 &= !1i32;
}
#[no_mangle]
pub unsafe fn instr_F6_0_mem(mut addr: i32, mut imm: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read8(addr));
    test8(____0, imm);
}
#[no_mangle]
pub unsafe fn instr_F6_0_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    test8(____0, imm);
}
#[no_mangle]
pub unsafe fn instr_F6_1_mem(mut addr: i32, mut imm: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read8(addr));
    test8(____0, imm);
}
#[no_mangle]
pub unsafe fn instr_F6_1_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    test8(____0, imm);
}
#[no_mangle]
pub unsafe fn instr_F6_2_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, !___);
}
#[no_mangle]
pub unsafe fn instr_F6_2_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, !____0);
}
#[no_mangle]
pub unsafe fn instr_F6_3_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, neg8(___));
}
#[no_mangle]
pub unsafe fn instr_F6_3_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, neg8(____0));
}
#[no_mangle]
pub unsafe fn instr_F6_4_mem(mut addr: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read8(addr));
    mul8(____0);
}
#[no_mangle]
pub unsafe fn instr_F6_4_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    mul8(____0);
}
#[no_mangle]
pub unsafe fn instr_F6_5_mem(mut addr: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read8(addr));
    imul8(____0 << 24i32 >> 24i32);
}
#[no_mangle]
pub unsafe fn instr_F6_5_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    imul8(____0 << 24i32 >> 24i32);
}
#[no_mangle]
pub unsafe fn instr_F6_6_mem(mut addr: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read8(addr));
    div8(____0 as u32);
}
#[no_mangle]
pub unsafe fn instr_F6_6_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    div8(____0 as u32);
}
#[no_mangle]
pub unsafe fn instr_F6_7_mem(mut addr: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read8(addr));
    idiv8(____0 << 24i32 >> 24i32);
}
#[no_mangle]
pub unsafe fn instr_F6_7_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    idiv8(____0 << 24i32 >> 24i32);
}
#[no_mangle]
pub unsafe fn instr16_F7_0_mem(mut addr: i32, mut imm: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    test16(____0, imm);
}
#[no_mangle]
pub unsafe fn instr16_F7_0_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    test16(____0, imm);
}
#[no_mangle]
pub unsafe fn instr16_F7_1_mem(mut addr: i32, mut imm: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    test16(____0, imm);
}
#[no_mangle]
pub unsafe fn instr16_F7_1_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    test16(____0, imm);
}
#[no_mangle]
pub unsafe fn instr16_F7_2_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, !___);
}
#[no_mangle]
pub unsafe fn instr16_F7_2_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, !____0);
}
#[no_mangle]
pub unsafe fn instr16_F7_3_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, neg16(___));
}
#[no_mangle]
pub unsafe fn instr16_F7_3_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, neg16(____0));
}
#[no_mangle]
pub unsafe fn instr16_F7_4_mem(mut addr: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    mul16(____0 as u32);
}
#[no_mangle]
pub unsafe fn instr16_F7_4_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    mul16(____0 as u32);
}
#[no_mangle]
pub unsafe fn instr16_F7_5_mem(mut addr: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    imul16(____0 << 16i32 >> 16i32);
}
#[no_mangle]
pub unsafe fn instr16_F7_5_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    imul16(____0 << 16i32 >> 16i32);
}
#[no_mangle]
pub unsafe fn instr16_F7_6_mem(mut addr: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    div16(____0 as u32);
}
#[no_mangle]
pub unsafe fn instr16_F7_6_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    div16(____0 as u32);
}
#[no_mangle]
pub unsafe fn instr16_F7_7_mem(mut addr: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    idiv16(____0 << 16i32 >> 16i32);
}
#[no_mangle]
pub unsafe fn instr16_F7_7_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    idiv16(____0 << 16i32 >> 16i32);
}
#[no_mangle]
pub unsafe fn instr32_F7_0_mem(mut addr: i32, mut imm: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    test32(____0, imm);
}
#[no_mangle]
pub unsafe fn instr32_F7_0_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    test32(____0, imm);
}
#[no_mangle]
pub unsafe fn instr32_F7_1_mem(mut addr: i32, mut imm: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    test32(____0, imm);
}
#[no_mangle]
pub unsafe fn instr32_F7_1_reg(mut r1: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    test32(____0, imm);
}
#[no_mangle]
pub unsafe fn instr32_F7_2_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, !___);
}
#[no_mangle]
pub unsafe fn instr32_F7_2_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, !____0);
}
#[no_mangle]
pub unsafe fn instr32_F7_3_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, neg32(___));
}
#[no_mangle]
pub unsafe fn instr32_F7_3_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, neg32(____0));
}
#[no_mangle]
pub unsafe fn instr32_F7_4_mem(mut addr: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    mul32(____0);
}
#[no_mangle]
pub unsafe fn instr32_F7_4_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    mul32(____0);
}
#[no_mangle]
pub unsafe fn instr32_F7_5_mem(mut addr: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    imul32(____0);
}
#[no_mangle]
pub unsafe fn instr32_F7_5_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    imul32(____0);
}
#[no_mangle]
pub unsafe fn instr32_F7_6_mem(mut addr: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    div32(____0 as u32);
}
#[no_mangle]
pub unsafe fn instr32_F7_6_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    div32(____0 as u32);
}
#[no_mangle]
pub unsafe fn instr32_F7_7_mem(mut addr: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    idiv32(____0);
}
#[no_mangle]
pub unsafe fn instr32_F7_7_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    idiv32(____0);
}
#[no_mangle]
pub unsafe fn instr_F8() -> () {
    c_comment!(("clc"));
    let ref mut fresh3 = *flags.offset(0isize);
    *fresh3 &= !FLAG_CARRY;
    let ref mut fresh4 = *flags_changed.offset(0isize);
    *fresh4 &= !1i32;
}
#[no_mangle]
pub unsafe fn instr_F9() -> () {
    c_comment!(("stc"));
    let ref mut fresh5 = *flags.offset(0isize);
    *fresh5 |= FLAG_CARRY;
    let ref mut fresh6 = *flags_changed.offset(0isize);
    *fresh6 &= !1i32;
}
#[no_mangle]
pub unsafe fn instr_FA() -> () {
    c_comment!(("cli"));
    if !*protected_mode || 0 != if 0 != *flags.offset(0isize) & FLAG_VM {
        (getiopl() == 3i32) as i32
    }
    else {
        (getiopl() >= *cpl as i32) as i32
    } {
        let ref mut fresh7 = *flags.offset(0isize);
        *fresh7 &= !FLAG_INTERRUPT
    }
    else if 0 != 0i32 * 0i32 && getiopl() < 3i32 && 0 != if 0 != *flags & FLAG_VM {
        *cr.offset(4isize) & CR4_VME
    }
    else {
        (*cpl as i32 == 3i32 && 0 != *cr.offset(4isize) & CR4_PVI) as i32
    } {
        *flags &= !FLAG_VIF
    }
    else {
        dbg_log_c!("cli #gp");
        trigger_gp_non_raising(0i32);
    };
}
#[no_mangle]
pub unsafe fn instr_FB() -> () {
    c_comment!(("sti"));
    let mut old_if: i32 = *flags.offset(0isize) & FLAG_INTERRUPT;
    if !*protected_mode || 0 != if 0 != *flags.offset(0isize) & FLAG_VM {
        (getiopl() == 3i32) as i32
    }
    else {
        (getiopl() >= *cpl as i32) as i32
    } {
        let ref mut fresh8 = *flags.offset(0isize);
        *fresh8 |= FLAG_INTERRUPT;
        if old_if == 0i32 {
            handle_irqs();
        }
    }
    else if 0 != 0i32 * 0i32 && getiopl() < 3i32 && *flags & FLAG_VIP == 0i32 && 0 != if 0
        != *flags & FLAG_VM
    {
        *cr.offset(4isize) & CR4_VME
    }
    else {
        (*cpl as i32 == 3i32 && 0 != *cr.offset(4isize) & CR4_PVI) as i32
    } {
        *flags |= FLAG_VIF
    }
    else {
        dbg_log_c!("sti #gp");
        trigger_gp_non_raising(0i32);
    };
}
#[no_mangle]
pub unsafe fn instr_FC() -> () {
    c_comment!(("cld"));
    let ref mut fresh9 = *flags.offset(0isize);
    *fresh9 &= !FLAG_DIRECTION;
}
#[no_mangle]
pub unsafe fn instr_FD() -> () {
    c_comment!(("std"));
    let ref mut fresh10 = *flags.offset(0isize);
    *fresh10 |= FLAG_DIRECTION;
}
#[no_mangle]
pub unsafe fn instr_FE_0_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, inc8(___));
}
#[no_mangle]
pub unsafe fn instr_FE_0_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, inc8(____0));
}
#[no_mangle]
pub unsafe fn instr_FE_1_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, dec8(___));
}
#[no_mangle]
pub unsafe fn instr_FE_1_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, dec8(____0));
}
#[no_mangle]
pub unsafe fn instr16_FF_0_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, inc16(___));
}
#[no_mangle]
pub unsafe fn instr16_FF_0_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, inc16(____0));
}
#[no_mangle]
pub unsafe fn instr16_FF_1_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, dec16(___));
}
#[no_mangle]
pub unsafe fn instr16_FF_1_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, dec16(____0));
}
#[no_mangle]
pub unsafe fn instr16_FF_2_helper(mut data: i32) -> () {
    c_comment!(("call near"));
    let mut cs: i32 = get_seg_cs();
    return_on_pagefault!(push16(get_real_eip()));
    *instruction_pointer.offset(0isize) = cs + data;
    dbg_assert!(0 != is_asize_32() as i32 || get_real_eip() < 65536i32);
}
#[no_mangle]
pub unsafe fn instr16_FF_2_mem(mut addr: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    instr16_FF_2_helper(____0);
}
#[no_mangle]
pub unsafe fn instr16_FF_2_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    instr16_FF_2_helper(____0);
}
#[no_mangle]
pub unsafe fn instr16_FF_3_reg(mut r: i32) -> () {
    dbg_log_c!("callf #ud");
    trigger_ud();
}
#[no_mangle]
pub unsafe fn instr16_FF_3_mem(mut addr: i32) -> () {
    c_comment!(("callf"));
    let mut new_ip: i32 = return_on_pagefault!(safe_read16(addr));
    let mut new_cs: i32 = return_on_pagefault!(safe_read16(addr + 2i32));
    far_jump(new_ip, new_cs, true);
    dbg_assert!(0 != is_asize_32() as i32 || get_real_eip() < 65536i32);
}
#[no_mangle]
pub unsafe fn instr16_FF_4_helper(mut data: i32) -> () {
    c_comment!(("jmp near"));
    *instruction_pointer.offset(0isize) = get_seg_cs() + data;
    dbg_assert!(0 != is_asize_32() as i32 || get_real_eip() < 65536i32);
}
#[no_mangle]
pub unsafe fn instr16_FF_4_mem(mut addr: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    instr16_FF_4_helper(____0);
}
#[no_mangle]
pub unsafe fn instr16_FF_4_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    instr16_FF_4_helper(____0);
}
#[no_mangle]
pub unsafe fn instr16_FF_5_reg(mut r: i32) -> () {
    dbg_log_c!("jmpf #ud");
    trigger_ud();
}
#[no_mangle]
pub unsafe fn instr16_FF_5_mem(mut addr: i32) -> () {
    c_comment!(("jmpf"));
    let mut new_ip: i32 = return_on_pagefault!(safe_read16(addr));
    let mut new_cs: i32 = return_on_pagefault!(safe_read16(addr + 2i32));
    far_jump(new_ip, new_cs, false);
    dbg_assert!(0 != is_asize_32() as i32 || get_real_eip() < 65536i32);
}
#[no_mangle]
pub unsafe fn instr16_FF_6_mem(mut addr: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    return_on_pagefault!(push16(____0));
}
#[no_mangle]
pub unsafe fn instr16_FF_6_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    return_on_pagefault!(push16(____0));
}
#[no_mangle]
pub unsafe fn instr32_FF_0_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, inc32(___));
}
#[no_mangle]
pub unsafe fn instr32_FF_0_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, inc32(____0));
}
#[no_mangle]
pub unsafe fn instr32_FF_1_mem(mut addr: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, dec32(___));
}
#[no_mangle]
pub unsafe fn instr32_FF_1_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, dec32(____0));
}
#[no_mangle]
pub unsafe fn instr32_FF_2_helper(mut data: i32) -> () {
    c_comment!(("call near"));
    let mut cs: i32 = get_seg_cs();
    return_on_pagefault!(push32(get_real_eip()));
    dbg_assert!(0 != is_asize_32() as i32 || data < 65536i32);
    *instruction_pointer.offset(0isize) = cs + data;
}
#[no_mangle]
pub unsafe fn instr32_FF_2_mem(mut addr: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    instr32_FF_2_helper(____0);
}
#[no_mangle]
pub unsafe fn instr32_FF_2_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    instr32_FF_2_helper(____0);
}
#[no_mangle]
pub unsafe fn instr32_FF_3_reg(mut r: i32) -> () {
    dbg_log_c!("callf #ud");
    trigger_ud();
}
#[no_mangle]
pub unsafe fn instr32_FF_3_mem(mut addr: i32) -> () {
    c_comment!(("callf"));
    let mut new_ip: i32 = return_on_pagefault!(safe_read32s(addr));
    let mut new_cs: i32 = return_on_pagefault!(safe_read16(addr + 4i32));
    if !*protected_mode || 0 != vm86_mode() as i32 {
        if 0 != new_ip as u32 & 4294901760u32 {
            dbg_assert!(0 != 0i32);
        }
    }
    far_jump(new_ip, new_cs, true);
    dbg_assert!(0 != is_asize_32() as i32 || new_ip < 65536i32);
}
#[no_mangle]
pub unsafe fn instr32_FF_4_helper(mut data: i32) -> () {
    c_comment!(("jmp near"));
    dbg_assert!(0 != is_asize_32() as i32 || data < 65536i32);
    *instruction_pointer.offset(0isize) = get_seg_cs() + data;
}
#[no_mangle]
pub unsafe fn instr32_FF_4_mem(mut addr: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    instr32_FF_4_helper(____0);
}
#[no_mangle]
pub unsafe fn instr32_FF_4_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    instr32_FF_4_helper(____0);
}
#[no_mangle]
pub unsafe fn instr32_FF_5_reg(mut r: i32) -> () {
    dbg_log_c!("jmpf #ud");
    trigger_ud();
}
#[no_mangle]
pub unsafe fn instr32_FF_5_mem(mut addr: i32) -> () {
    c_comment!(("jmpf"));
    let mut new_ip: i32 = return_on_pagefault!(safe_read32s(addr));
    let mut new_cs: i32 = return_on_pagefault!(safe_read16(addr + 4i32));
    if !*protected_mode || 0 != vm86_mode() as i32 {
        if 0 != new_ip as u32 & 4294901760u32 {
            dbg_assert!(0 != 0i32);
        }
    }
    far_jump(new_ip, new_cs, false);
    dbg_assert!(0 != is_asize_32() as i32 || new_ip < 65536i32);
}
#[no_mangle]
pub unsafe fn instr32_FF_6_mem(mut addr: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    return_on_pagefault!(push32(____0));
}
#[no_mangle]
pub unsafe fn instr32_FF_6_reg(mut r1: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    return_on_pagefault!(push32(____0));
}
#[no_mangle]
pub unsafe fn instr_F26C() -> () { insb_rep(); }
#[no_mangle]
pub unsafe fn instr_F36C() -> () { insb_rep(); }
#[no_mangle]
pub unsafe fn instr16_F26D() -> () { insw_rep(); }
#[no_mangle]
pub unsafe fn instr16_F36D() -> () { insw_rep(); }
#[no_mangle]
pub unsafe fn instr32_F26D() -> () { insd_rep(); }
#[no_mangle]
pub unsafe fn instr32_F36D() -> () { insd_rep(); }
#[no_mangle]
pub unsafe fn instr_F26E() -> () { outsb_rep(); }
#[no_mangle]
pub unsafe fn instr_F36E() -> () { outsb_rep(); }
#[no_mangle]
pub unsafe fn instr16_F26F() -> () { outsw_rep(); }
#[no_mangle]
pub unsafe fn instr16_F36F() -> () { outsw_rep(); }
#[no_mangle]
pub unsafe fn instr32_F26F() -> () { outsd_rep(); }
#[no_mangle]
pub unsafe fn instr32_F36F() -> () { outsd_rep(); }
#[no_mangle]
pub unsafe fn instr16_70(mut imm8: i32) -> () { jmpcc16(test_o(), imm8); }
#[no_mangle]
pub unsafe fn instr16_71(mut imm8: i32) -> () { jmpcc16(!test_o(), imm8); }
#[no_mangle]
pub unsafe fn instr16_72(mut imm8: i32) -> () { jmpcc16(test_b(), imm8); }
#[no_mangle]
pub unsafe fn instr16_73(mut imm8: i32) -> () { jmpcc16(!test_b(), imm8); }
#[no_mangle]
pub unsafe fn instr16_74(mut imm8: i32) -> () { jmpcc16(test_z(), imm8); }
#[no_mangle]
pub unsafe fn instr16_75(mut imm8: i32) -> () { jmpcc16(!test_z(), imm8); }
#[no_mangle]
pub unsafe fn instr16_76(mut imm8: i32) -> () { jmpcc16(test_be(), imm8); }
#[no_mangle]
pub unsafe fn instr16_77(mut imm8: i32) -> () { jmpcc16(!test_be(), imm8); }
#[no_mangle]
pub unsafe fn instr16_78(mut imm8: i32) -> () { jmpcc16(test_s(), imm8); }
#[no_mangle]
pub unsafe fn instr16_79(mut imm8: i32) -> () { jmpcc16(!test_s(), imm8); }
#[no_mangle]
pub unsafe fn instr16_7A(mut imm8: i32) -> () { jmpcc16(test_p(), imm8); }
#[no_mangle]
pub unsafe fn instr16_7B(mut imm8: i32) -> () { jmpcc16(!test_p(), imm8); }
#[no_mangle]
pub unsafe fn instr16_7C(mut imm8: i32) -> () { jmpcc16(test_l(), imm8); }
#[no_mangle]
pub unsafe fn instr16_7D(mut imm8: i32) -> () { jmpcc16(!test_l(), imm8); }
#[no_mangle]
pub unsafe fn instr16_7E(mut imm8: i32) -> () { jmpcc16(test_le(), imm8); }
#[no_mangle]
pub unsafe fn instr16_7F(mut imm8: i32) -> () { jmpcc16(!test_le(), imm8); }
#[no_mangle]
pub unsafe fn instr32_70(mut imm8: i32) -> () { jmpcc32(test_o(), imm8); }
#[no_mangle]
pub unsafe fn instr32_71(mut imm8: i32) -> () { jmpcc32(!test_o(), imm8); }
#[no_mangle]
pub unsafe fn instr32_72(mut imm8: i32) -> () { jmpcc32(test_b(), imm8); }
#[no_mangle]
pub unsafe fn instr32_73(mut imm8: i32) -> () { jmpcc32(!test_b(), imm8); }
#[no_mangle]
pub unsafe fn instr32_74(mut imm8: i32) -> () { jmpcc32(test_z(), imm8); }
#[no_mangle]
pub unsafe fn instr32_75(mut imm8: i32) -> () { jmpcc32(!test_z(), imm8); }
#[no_mangle]
pub unsafe fn instr32_76(mut imm8: i32) -> () { jmpcc32(test_be(), imm8); }
#[no_mangle]
pub unsafe fn instr32_77(mut imm8: i32) -> () { jmpcc32(!test_be(), imm8); }
#[no_mangle]
pub unsafe fn instr32_78(mut imm8: i32) -> () { jmpcc32(test_s(), imm8); }
#[no_mangle]
pub unsafe fn instr32_79(mut imm8: i32) -> () { jmpcc32(!test_s(), imm8); }
#[no_mangle]
pub unsafe fn instr32_7A(mut imm8: i32) -> () { jmpcc32(test_p(), imm8); }
#[no_mangle]
pub unsafe fn instr32_7B(mut imm8: i32) -> () { jmpcc32(!test_p(), imm8); }
#[no_mangle]
pub unsafe fn instr32_7C(mut imm8: i32) -> () { jmpcc32(test_l(), imm8); }
#[no_mangle]
pub unsafe fn instr32_7D(mut imm8: i32) -> () { jmpcc32(!test_l(), imm8); }
#[no_mangle]
pub unsafe fn instr32_7E(mut imm8: i32) -> () { jmpcc32(test_le(), imm8); }
#[no_mangle]
pub unsafe fn instr32_7F(mut imm8: i32) -> () { jmpcc32(!test_le(), imm8); }
#[no_mangle]
pub unsafe fn instr_F2A4() -> () { movsb_rep(); }
#[no_mangle]
pub unsafe fn instr_F3A4() -> () { movsb_rep(); }
#[no_mangle]
pub unsafe fn instr16_F2A5() -> () { movsw_rep(); }
#[no_mangle]
pub unsafe fn instr16_F3A5() -> () { movsw_rep(); }
#[no_mangle]
pub unsafe fn instr32_F2A5() -> () { movsd_rep(); }
#[no_mangle]
pub unsafe fn instr32_F3A5() -> () { movsd_rep(); }
#[no_mangle]
pub unsafe fn instr_F2A6() -> () { cmpsb_rep(PREFIX_F2); }
#[no_mangle]
pub unsafe fn instr_F3A6() -> () { cmpsb_rep(PREFIX_F3); }
#[no_mangle]
pub unsafe fn instr16_F2A7() -> () { cmpsw_rep(PREFIX_F2); }
#[no_mangle]
pub unsafe fn instr16_F3A7() -> () { cmpsw_rep(PREFIX_F3); }
#[no_mangle]
pub unsafe fn instr32_F2A7() -> () { cmpsd_rep(PREFIX_F2); }
#[no_mangle]
pub unsafe fn instr32_F3A7() -> () { cmpsd_rep(PREFIX_F3); }
#[no_mangle]
pub unsafe fn instr_F2AA() -> () { stosb_rep(); }
#[no_mangle]
pub unsafe fn instr_F3AA() -> () { stosb_rep(); }
#[no_mangle]
pub unsafe fn instr16_F2AB() -> () { stosw_rep(); }
#[no_mangle]
pub unsafe fn instr16_F3AB() -> () { stosw_rep(); }
#[no_mangle]
pub unsafe fn instr32_F2AB() -> () { stosd_rep(); }
#[no_mangle]
pub unsafe fn instr32_F3AB() -> () { stosd_rep(); }
#[no_mangle]
pub unsafe fn instr_F2AC() -> () { lodsb_rep(); }
#[no_mangle]
pub unsafe fn instr_F3AC() -> () { lodsb_rep(); }
#[no_mangle]
pub unsafe fn instr16_F2AD() -> () { lodsw_rep(); }
#[no_mangle]
pub unsafe fn instr16_F3AD() -> () { lodsw_rep(); }
#[no_mangle]
pub unsafe fn instr32_F2AD() -> () { lodsd_rep(); }
#[no_mangle]
pub unsafe fn instr32_F3AD() -> () { lodsd_rep(); }
#[no_mangle]
pub unsafe fn instr_F2AE() -> () { scasb_rep(PREFIX_F2); }
#[no_mangle]
pub unsafe fn instr_F3AE() -> () { scasb_rep(PREFIX_F3); }
#[no_mangle]
pub unsafe fn instr16_F2AF() -> () { scasw_rep(PREFIX_F2); }
#[no_mangle]
pub unsafe fn instr16_F3AF() -> () { scasw_rep(PREFIX_F3); }
#[no_mangle]
pub unsafe fn instr32_F2AF() -> () { scasd_rep(PREFIX_F2); }
#[no_mangle]
pub unsafe fn instr32_F3AF() -> () { scasd_rep(PREFIX_F3); }
#[no_mangle]
pub unsafe fn instr_D8_0_mem(mut addr: i32) -> () {
    let mut ____0: f64 = return_on_pagefault!(fpu_load_m32(addr));
    fpu_fadd(0i32, ____0);
}
#[no_mangle]
pub unsafe fn instr_D8_0_reg(mut r: i32) -> () {
    let mut ____0: f64 = fpu_get_sti(r);
    fpu_fadd(0i32, ____0);
}
#[no_mangle]
pub unsafe fn instr_D8_1_mem(mut addr: i32) -> () {
    let mut ____0: f64 = return_on_pagefault!(fpu_load_m32(addr));
    fpu_fmul(0i32, ____0);
}
#[no_mangle]
pub unsafe fn instr_D8_1_reg(mut r: i32) -> () {
    let mut ____0: f64 = fpu_get_sti(r);
    fpu_fmul(0i32, ____0);
}
#[no_mangle]
pub unsafe fn instr_D8_2_mem(mut addr: i32) -> () {
    let mut ____0: f64 = return_on_pagefault!(fpu_load_m32(addr));
    fpu_fcom(____0);
}
#[no_mangle]
pub unsafe fn instr_D8_2_reg(mut r: i32) -> () {
    let mut ____0: f64 = fpu_get_sti(r);
    fpu_fcom(____0);
}
#[no_mangle]
pub unsafe fn instr_D8_3_mem(mut addr: i32) -> () {
    let mut ____0: f64 = return_on_pagefault!(fpu_load_m32(addr));
    fpu_fcomp(____0);
}
#[no_mangle]
pub unsafe fn instr_D8_3_reg(mut r: i32) -> () {
    let mut ____0: f64 = fpu_get_sti(r);
    fpu_fcomp(____0);
}
#[no_mangle]
pub unsafe fn instr_D8_4_mem(mut addr: i32) -> () {
    let mut ____0: f64 = return_on_pagefault!(fpu_load_m32(addr));
    fpu_fsub(0i32, ____0);
}
#[no_mangle]
pub unsafe fn instr_D8_4_reg(mut r: i32) -> () {
    let mut ____0: f64 = fpu_get_sti(r);
    fpu_fsub(0i32, ____0);
}
#[no_mangle]
pub unsafe fn instr_D8_5_mem(mut addr: i32) -> () {
    let mut ____0: f64 = return_on_pagefault!(fpu_load_m32(addr));
    fpu_fsubr(0i32, ____0);
}
#[no_mangle]
pub unsafe fn instr_D8_5_reg(mut r: i32) -> () {
    let mut ____0: f64 = fpu_get_sti(r);
    fpu_fsubr(0i32, ____0);
}
#[no_mangle]
pub unsafe fn instr_D8_6_mem(mut addr: i32) -> () {
    let mut ____0: f64 = return_on_pagefault!(fpu_load_m32(addr));
    fpu_fdiv(0i32, ____0);
}
#[no_mangle]
pub unsafe fn instr_D8_6_reg(mut r: i32) -> () {
    let mut ____0: f64 = fpu_get_sti(r);
    fpu_fdiv(0i32, ____0);
}
#[no_mangle]
pub unsafe fn instr_D8_7_mem(mut addr: i32) -> () {
    let mut ____0: f64 = return_on_pagefault!(fpu_load_m32(addr));
    fpu_fdivr(0i32, ____0);
}
#[no_mangle]
pub unsafe fn instr_D8_7_reg(mut r: i32) -> () {
    let mut ____0: f64 = fpu_get_sti(r);
    fpu_fdivr(0i32, ____0);
}
#[no_mangle]
pub unsafe fn instr_D9_0_mem(mut addr: i32) -> () {
    let mut ____0: f64 = return_on_pagefault!(fpu_load_m32(addr));
    fpu_push(____0);
}
#[no_mangle]
pub unsafe fn instr_D9_0_reg(mut r: i32) -> () {
    let mut ____0: f64 = fpu_get_sti(r);
    fpu_push(____0);
}
#[no_mangle]
pub unsafe fn instr_D9_1_mem(mut addr: i32) -> () {
    dbg_log_c!("d9/1");
    trigger_ud();
}
#[no_mangle]
pub unsafe fn instr_D9_1_reg(mut r: i32) -> () { fpu_fxch(r); }
#[no_mangle]
pub unsafe fn instr_D9_2_mem(mut addr: i32) -> () { fpu_fstm32(addr); }
#[no_mangle]
pub unsafe fn instr_D9_2_reg(mut r: i32) -> () {
    if r != 0i32 {
        trigger_ud();
    };
}
#[no_mangle]
pub unsafe fn instr_D9_3_mem(mut addr: i32) -> () { fpu_fstm32p(addr); }
#[no_mangle]
pub unsafe fn instr_D9_3_reg(mut r: i32) -> () {
    dbg_log_c!("fstp1");
    trigger_ud();
}
#[no_mangle]
pub unsafe fn instr_D9_4_mem(mut addr: i32) -> () { fpu_fldenv(addr); }
#[no_mangle]
pub unsafe fn instr_D9_4_reg(mut r: i32) -> () {
    let mut st0: f64 = fpu_get_st0();
    match r {
        0 => {
            c_comment!(("fchs"));
            *fpu_st.offset(*fpu_stack_ptr as isize) = -st0
        },
        1 => {
            c_comment!(("fabs"));
            *fpu_st.offset(*fpu_stack_ptr as isize) = st0.abs()
        },
        4 => {
            fpu_ftst(st0);
        },
        5 => {
            fpu_fxam(st0);
        },
        _ => {
            dbg_log_c!("%x", r);
            trigger_ud();
        },
    };
}
#[no_mangle]
pub unsafe fn instr_D9_5_mem(mut addr: i32) -> () { fpu_fldcw(addr); }
#[no_mangle]
pub unsafe fn instr_D9_5_reg(mut r: i32) -> () {
    c_comment!(("fld1/fldl2t/fldl2e/fldpi/fldlg2/fldln2/fldz"));
    match r {
        0 => {
            fpu_push(1i32 as f64);
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
            fpu_push(0i32 as f64);
        },
        7 => {
            dbg_log_c!("d9/5/7");
            trigger_ud();
        },
        _ => {},
    };
}
#[no_mangle]
pub unsafe fn instr_D9_6_mem(mut addr: i32) -> () { fpu_fstenv(addr); }
#[no_mangle]
pub unsafe fn instr_D9_6_reg(mut r: i32) -> () {
    let mut st0: f64 = fpu_get_st0();
    match r {
        0 => {
            c_comment!(("f2xm1"));
            *fpu_st.offset(*fpu_stack_ptr as isize) = pow(2i32 as f64, st0) - 1i32 as f64
        },
        1 => {
            c_comment!(("fyl2x"));
            *fpu_st.offset(((*fpu_stack_ptr).wrapping_add(1i32 as u32) & 7i32 as u32) as isize) =
                fpu_get_sti(1i32) * st0.ln() / M_LN2;
            fpu_pop();
        },
        2 => {
            c_comment!(("fptan"));
            *fpu_st.offset(*fpu_stack_ptr as isize) = st0.tan();
            fpu_push(1i32 as f64);
            c_comment!(("no bug: push constant 1"));
        },
        3 => {
            c_comment!(("fpatan"));
            *fpu_st.offset(((*fpu_stack_ptr).wrapping_add(1i32 as u32) & 7i32 as u32) as isize) =
                fpu_get_sti(1i32).atan2(st0);
            fpu_pop();
        },
        4 => {
            fpu_fxtract();
        },
        5 => {
            c_comment!(("fprem1"));
            *fpu_st.offset(*fpu_stack_ptr as isize) = fmod(st0, fpu_get_sti(1i32))
        },
        6 => {
            c_comment!(("fdecstp"));
            *fpu_stack_ptr = (*fpu_stack_ptr).wrapping_sub(1i32 as u32) & 7i32 as u32;
            *fpu_status_word &= !FPU_C1
        },
        7 => {
            c_comment!(("fincstp"));
            *fpu_stack_ptr = (*fpu_stack_ptr).wrapping_add(1i32 as u32) & 7i32 as u32;
            *fpu_status_word &= !FPU_C1
        },
        _ => {
            dbg_assert!(0 != 0i32);
        },
    };
}
#[no_mangle]
pub unsafe fn instr_D9_7_mem(mut addr: i32) -> () { fpu_fstcw(addr); }
#[no_mangle]
pub unsafe fn instr_D9_7_reg(mut r: i32) -> () {
    let mut st0: f64 = fpu_get_st0();
    match r {
        0 => {
            fpu_fprem();
        },
        1 => {
            c_comment!(("fyl2xp1: y * log2(x+1) and pop"));
            *fpu_st.offset(((*fpu_stack_ptr).wrapping_add(1i32 as u32) & 7i32 as u32) as isize) =
                fpu_get_sti(1i32) * (st0 + 1i32 as f64).ln() / M_LN2;
            fpu_pop();
        },
        2 => *fpu_st.offset(*fpu_stack_ptr as isize) = st0.sqrt(),
        3 => {
            *fpu_st.offset(*fpu_stack_ptr as isize) = st0.sin();
            fpu_push(st0.cos());
        },
        4 => {
            c_comment!(("frndint"));
            *fpu_st.offset(*fpu_stack_ptr as isize) = fpu_integer_round(st0)
        },
        5 => {
            c_comment!(("fscale"));
            *fpu_st.offset(*fpu_stack_ptr as isize) =
                st0 * pow(2i32 as f64, trunc(fpu_get_sti(1i32)))
        },
        6 => *fpu_st.offset(*fpu_stack_ptr as isize) = st0.sin(),
        7 => *fpu_st.offset(*fpu_stack_ptr as isize) = st0.cos(),
        _ => {
            dbg_assert!(0 != 0i32);
        },
    };
}
#[no_mangle]
pub unsafe fn instr_DA_0_mem(mut addr: i32) -> () {
    fpu_fadd(0i32, return_on_pagefault!(safe_read32s(addr)) as f64);
}
#[no_mangle]
pub unsafe fn instr_DA_1_mem(mut addr: i32) -> () {
    fpu_fmul(0i32, return_on_pagefault!(safe_read32s(addr)) as f64);
}
#[no_mangle]
pub unsafe fn instr_DA_2_mem(mut addr: i32) -> () {
    fpu_fcom(return_on_pagefault!(safe_read32s(addr)) as f64);
}
#[no_mangle]
pub unsafe fn instr_DA_3_mem(mut addr: i32) -> () {
    fpu_fcomp(return_on_pagefault!(safe_read32s(addr)) as f64);
}
#[no_mangle]
pub unsafe fn instr_DA_4_mem(mut addr: i32) -> () {
    fpu_fsub(0i32, return_on_pagefault!(safe_read32s(addr)) as f64);
}
#[no_mangle]
pub unsafe fn instr_DA_5_mem(mut addr: i32) -> () {
    fpu_fsubr(0i32, return_on_pagefault!(safe_read32s(addr)) as f64);
}
#[no_mangle]
pub unsafe fn instr_DA_6_mem(mut addr: i32) -> () {
    fpu_fdiv(0i32, return_on_pagefault!(safe_read32s(addr)) as f64);
}
#[no_mangle]
pub unsafe fn instr_DA_7_mem(mut addr: i32) -> () {
    fpu_fdivr(0i32, return_on_pagefault!(safe_read32s(addr)) as f64);
}
#[no_mangle]
pub unsafe fn instr_DA_0_reg(mut r: i32) -> () { fpu_fcmovcc(test_b(), r); }
#[no_mangle]
pub unsafe fn instr_DA_1_reg(mut r: i32) -> () { fpu_fcmovcc(test_z(), r); }
#[no_mangle]
pub unsafe fn instr_DA_2_reg(mut r: i32) -> () { fpu_fcmovcc(test_be(), r); }
#[no_mangle]
pub unsafe fn instr_DA_3_reg(mut r: i32) -> () { fpu_fcmovcc(test_p(), r); }
#[no_mangle]
pub unsafe fn instr_DA_4_reg(mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_DA_5_reg(mut r: i32) -> () {
    if r == 1i32 {
        fpu_fucompp();
    }
    else {
        trigger_ud();
    };
}
#[no_mangle]
pub unsafe fn instr_DA_6_reg(mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_DA_7_reg(mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_DB_0_mem(mut addr: i32) -> () { fpu_fldm32(addr); }
#[no_mangle]
pub unsafe fn instr_DB_1_mem(mut addr: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_DB_2_mem(mut addr: i32) -> () { fpu_fistm32(addr); }
#[no_mangle]
pub unsafe fn instr_DB_3_mem(mut addr: i32) -> () { fpu_fistm32p(addr); }
#[no_mangle]
pub unsafe fn instr_DB_4_mem(mut addr: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_DB_5_mem(mut addr: i32) -> () { fpu_fldm80(addr); }
#[no_mangle]
pub unsafe fn instr_DB_6_mem(mut addr: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_DB_7_mem(mut addr: i32) -> () { fpu_fst80p(addr); }
#[no_mangle]
pub unsafe fn instr_DB_0_reg(mut r: i32) -> () { fpu_fcmovcc(!test_b(), r); }
#[no_mangle]
pub unsafe fn instr_DB_1_reg(mut r: i32) -> () { fpu_fcmovcc(!test_z(), r); }
#[no_mangle]
pub unsafe fn instr_DB_2_reg(mut r: i32) -> () { fpu_fcmovcc(!test_be(), r); }
#[no_mangle]
pub unsafe fn instr_DB_3_reg(mut r: i32) -> () { fpu_fcmovcc(!test_p(), r); }
#[no_mangle]
pub unsafe fn instr_DB_4_reg(mut r: i32) -> () {
    if r == 3i32 {
        fpu_finit();
    }
    else if r == 4i32 || r == 1i32 {
        c_comment!(("fsetpm and fdisi; treated as nop"));
    }
    else if r == 2i32 {
        fpu_fclex();
    }
    else {
        trigger_ud();
    };
}
#[no_mangle]
pub unsafe fn instr_DB_5_reg(mut r: i32) -> () { fpu_fucomi(r); }
#[no_mangle]
pub unsafe fn instr_DB_6_reg(mut r: i32) -> () { fpu_fcomi(r); }
#[no_mangle]
pub unsafe fn instr_DB_7_reg(mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_DC_0_mem(mut addr: i32) -> () {
    fpu_fadd(0i32, return_on_pagefault!(fpu_load_m64(addr)));
}
#[no_mangle]
pub unsafe fn instr_DC_1_mem(mut addr: i32) -> () {
    fpu_fmul(0i32, return_on_pagefault!(fpu_load_m64(addr)));
}
#[no_mangle]
pub unsafe fn instr_DC_2_mem(mut addr: i32) -> () {
    fpu_fcom(return_on_pagefault!(fpu_load_m64(addr)));
}
#[no_mangle]
pub unsafe fn instr_DC_3_mem(mut addr: i32) -> () {
    fpu_fcomp(return_on_pagefault!(fpu_load_m64(addr)));
}
#[no_mangle]
pub unsafe fn instr_DC_4_mem(mut addr: i32) -> () {
    fpu_fsub(0i32, return_on_pagefault!(fpu_load_m64(addr)));
}
#[no_mangle]
pub unsafe fn instr_DC_5_mem(mut addr: i32) -> () {
    fpu_fsubr(0i32, return_on_pagefault!(fpu_load_m64(addr)));
}
#[no_mangle]
pub unsafe fn instr_DC_6_mem(mut addr: i32) -> () {
    fpu_fdiv(0i32, return_on_pagefault!(fpu_load_m64(addr)));
}
#[no_mangle]
pub unsafe fn instr_DC_7_mem(mut addr: i32) -> () {
    fpu_fdivr(0i32, return_on_pagefault!(fpu_load_m64(addr)));
}
#[no_mangle]
pub unsafe fn instr_DC_0_reg(mut r: i32) -> () { fpu_fadd(r, fpu_get_sti(r)); }
#[no_mangle]
pub unsafe fn instr_DC_1_reg(mut r: i32) -> () { fpu_fmul(r, fpu_get_sti(r)); }
#[no_mangle]
pub unsafe fn instr_DC_2_reg(mut r: i32) -> () { fpu_fcom(fpu_get_sti(r)); }
#[no_mangle]
pub unsafe fn instr_DC_3_reg(mut r: i32) -> () { fpu_fcomp(fpu_get_sti(r)); }
#[no_mangle]
pub unsafe fn instr_DC_4_reg(mut r: i32) -> () { fpu_fsub(r, fpu_get_sti(r)); }
#[no_mangle]
pub unsafe fn instr_DC_5_reg(mut r: i32) -> () { fpu_fsubr(r, fpu_get_sti(r)); }
#[no_mangle]
pub unsafe fn instr_DC_6_reg(mut r: i32) -> () { fpu_fdiv(r, fpu_get_sti(r)); }
#[no_mangle]
pub unsafe fn instr_DC_7_reg(mut r: i32) -> () { fpu_fdivr(r, fpu_get_sti(r)); }
#[no_mangle]
pub unsafe fn instr_DD_0_mem(mut addr: i32) -> () { fpu_fldm64(addr); }
#[no_mangle]
pub unsafe fn instr_DD_1_mem(mut addr: i32) -> () {
    dbg_log_c!("fisttp");
    trigger_ud();
}
#[no_mangle]
pub unsafe fn instr_DD_2_mem(mut addr: i32) -> () { fpu_fstm64(addr); }
#[no_mangle]
pub unsafe fn instr_DD_3_mem(mut addr: i32) -> () { fpu_fstm64p(addr); }
#[no_mangle]
pub unsafe fn instr_DD_4_mem(mut addr: i32) -> () { fpu_frstor(addr); }
#[no_mangle]
pub unsafe fn instr_DD_5_mem(mut addr: i32) -> () {
    dbg_log_c!("dd/5");
    trigger_ud();
}
#[no_mangle]
pub unsafe fn instr_DD_6_mem(mut addr: i32) -> () { fpu_fsave(addr); }
#[no_mangle]
pub unsafe fn instr_DD_7_mem(mut addr: i32) -> () { fpu_fnstsw_mem(addr); }
#[no_mangle]
pub unsafe fn instr_DD_0_reg(mut r: i32) -> () { fpu_ffree(r); }
#[no_mangle]
pub unsafe fn instr_DD_1_reg(mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_DD_2_reg(mut r: i32) -> () { fpu_fst(r); }
#[no_mangle]
pub unsafe fn instr_DD_3_reg(mut r: i32) -> () { fpu_fstp(r); }
#[no_mangle]
pub unsafe fn instr_DD_4_reg(mut r: i32) -> () { fpu_fucom(r); }
#[no_mangle]
pub unsafe fn instr_DD_5_reg(mut r: i32) -> () { fpu_fucomp(r); }
#[no_mangle]
pub unsafe fn instr_DD_6_reg(mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_DD_7_reg(mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_DE_0_mem(mut addr: i32) -> () {
    fpu_fadd(0i32, return_on_pagefault!(safe_read16(addr)) as i16 as f64);
}
#[no_mangle]
pub unsafe fn instr_DE_1_mem(mut addr: i32) -> () {
    fpu_fmul(0i32, return_on_pagefault!(safe_read16(addr)) as i16 as f64);
}
#[no_mangle]
pub unsafe fn instr_DE_2_mem(mut addr: i32) -> () {
    fpu_fcom(return_on_pagefault!(safe_read16(addr)) as i16 as f64);
}
#[no_mangle]
pub unsafe fn instr_DE_3_mem(mut addr: i32) -> () {
    fpu_fcomp(return_on_pagefault!(safe_read16(addr)) as i16 as f64);
}
#[no_mangle]
pub unsafe fn instr_DE_4_mem(mut addr: i32) -> () {
    fpu_fsub(0i32, return_on_pagefault!(safe_read16(addr)) as i16 as f64);
}
#[no_mangle]
pub unsafe fn instr_DE_5_mem(mut addr: i32) -> () {
    fpu_fsubr(0i32, return_on_pagefault!(safe_read16(addr)) as i16 as f64);
}
#[no_mangle]
pub unsafe fn instr_DE_6_mem(mut addr: i32) -> () {
    fpu_fdiv(0i32, return_on_pagefault!(safe_read16(addr)) as i16 as f64);
}
#[no_mangle]
pub unsafe fn instr_DE_7_mem(mut addr: i32) -> () {
    fpu_fdivr(0i32, return_on_pagefault!(safe_read16(addr)) as i16 as f64);
}
#[no_mangle]
pub unsafe fn instr_DE_0_reg(mut r: i32) -> () {
    fpu_fadd(r, fpu_get_sti(r));
    fpu_pop();
}
#[no_mangle]
pub unsafe fn instr_DE_1_reg(mut r: i32) -> () {
    fpu_fmul(r, fpu_get_sti(r));
    fpu_pop();
}
#[no_mangle]
pub unsafe fn instr_DE_2_reg(mut r: i32) -> () {
    fpu_fcom(fpu_get_sti(r));
    fpu_pop();
}
#[no_mangle]
pub unsafe fn instr_DE_3_reg(mut r: i32) -> () {
    fpu_fcomp(fpu_get_sti(r));
    fpu_pop();
}
#[no_mangle]
pub unsafe fn instr_DE_4_reg(mut r: i32) -> () {
    fpu_fsub(r, fpu_get_sti(r));
    fpu_pop();
}
#[no_mangle]
pub unsafe fn instr_DE_5_reg(mut r: i32) -> () {
    fpu_fsubr(r, fpu_get_sti(r));
    fpu_pop();
}
#[no_mangle]
pub unsafe fn instr_DE_6_reg(mut r: i32) -> () {
    fpu_fdiv(r, fpu_get_sti(r));
    fpu_pop();
}
#[no_mangle]
pub unsafe fn instr_DE_7_reg(mut r: i32) -> () {
    fpu_fdivr(r, fpu_get_sti(r));
    fpu_pop();
}
#[no_mangle]
pub unsafe fn instr_DF_0_mem(mut addr: i32) -> () {
    fpu_push(return_on_pagefault!(safe_read16(addr)) as i16 as f64);
}
#[no_mangle]
pub unsafe fn instr_DF_1_mem(mut addr: i32) -> () {
    dbg_log_c!("df/fisttp");
    trigger_ud();
}
#[no_mangle]
pub unsafe fn instr_DF_2_mem(mut addr: i32) -> () { fpu_fistm16(addr); }
#[no_mangle]
pub unsafe fn instr_DF_3_mem(mut addr: i32) -> () { fpu_fistm16p(addr); }
#[no_mangle]
pub unsafe fn instr_DF_4_mem(mut addr: i32) -> () {
    dbg_log_c!("fbld");
    trigger_ud();
}
#[no_mangle]
pub unsafe fn instr_DF_5_mem(mut addr: i32) -> () { fpu_fildm64(addr); }
#[no_mangle]
pub unsafe fn instr_DF_6_mem(mut addr: i32) -> () {
    dbg_log_c!("fbstp");
    trigger_ud();
}
#[no_mangle]
pub unsafe fn instr_DF_7_mem(mut addr: i32) -> () { fpu_fistm64p(addr); }
#[no_mangle]
pub unsafe fn instr_DF_0_reg(mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_DF_1_reg(mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_DF_2_reg(mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_DF_3_reg(mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_DF_4_reg(mut r: i32) -> () {
    if r == 0i32 {
        fpu_fnstsw_reg();
    }
    else {
        trigger_ud();
    };
}
#[no_mangle]
pub unsafe fn instr_DF_5_reg(mut r: i32) -> () { fpu_fucomip(r); }
#[no_mangle]
pub unsafe fn instr_DF_6_reg(mut r: i32) -> () { fpu_fcomip(r); }
#[no_mangle]
pub unsafe fn instr_DF_7_reg(mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr16_E0(mut imm8s: i32) -> () { loopne16(imm8s); }
#[no_mangle]
pub unsafe fn instr16_E1(mut imm8s: i32) -> () { loope16(imm8s); }
#[no_mangle]
pub unsafe fn instr16_E2(mut imm8s: i32) -> () { loop16(imm8s); }
#[no_mangle]
pub unsafe fn instr16_E3(mut imm8s: i32) -> () { jcxz16(imm8s); }
#[no_mangle]
pub unsafe fn instr32_E0(mut imm8s: i32) -> () { loopne32(imm8s); }
#[no_mangle]
pub unsafe fn instr32_E1(mut imm8s: i32) -> () { loope32(imm8s); }
#[no_mangle]
pub unsafe fn instr32_E2(mut imm8s: i32) -> () { loop32(imm8s); }
#[no_mangle]
pub unsafe fn instr32_E3(mut imm8s: i32) -> () { jcxz32(imm8s); }
#[no_mangle]
pub unsafe fn instr16_EB(mut imm8: i32) -> () {
    c_comment!(("jmp near"));
    jmp_rel16(imm8);
    dbg_assert!(0 != is_asize_32() as i32 || get_real_eip() < 65536i32);
}
#[no_mangle]
pub unsafe fn instr32_EB(mut imm8: i32) -> () {
    c_comment!(("jmp near"));
    *instruction_pointer.offset(0isize) = *instruction_pointer.offset(0isize) + imm8;
    dbg_assert!(0 != is_asize_32() as i32 || get_real_eip() < 65536i32);
}