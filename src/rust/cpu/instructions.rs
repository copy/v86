#![allow(non_snake_case)]

use crate::cpu::arith::*;
use crate::cpu::cpu::js;
use crate::cpu::cpu::*;
use crate::cpu::fpu::*;
use crate::cpu::global_pointers::*;
use crate::cpu::misc_instr::*;
use crate::cpu::string::*;
use crate::prefix;
use crate::softfloat::F80;

pub unsafe fn instr_00_mem(addr: i32, r: i32) { safe_read_write8(addr, &|x| add8(x, read_reg8(r))) }
pub unsafe fn instr_00_reg(r1: i32, r: i32) { write_reg8(r1, add8(read_reg8(r1), read_reg8(r))); }
pub unsafe fn instr16_01_mem(addr: i32, r: i32) {
    safe_read_write16(addr, &|x| add16(x, read_reg16(r)))
}
pub unsafe fn instr16_01_reg(r1: i32, r: i32) {
    write_reg16(r1, add16(read_reg16(r1), read_reg16(r)));
}
pub unsafe fn instr32_01_mem(addr: i32, r: i32) {
    safe_read_write32(addr, &|x| add32(x, read_reg32(r)))
}
pub unsafe fn instr32_01_reg(r1: i32, r: i32) {
    write_reg32(r1, add32(read_reg32(r1), read_reg32(r)));
}
pub unsafe fn instr_02_mem(addr: i32, r: i32) {
    write_reg8(
        r,
        add8(read_reg8(r), return_on_pagefault!(safe_read8(addr))),
    );
}
pub unsafe fn instr_02_reg(r1: i32, r: i32) { write_reg8(r, add8(read_reg8(r), read_reg8(r1))); }
pub unsafe fn instr16_03_mem(addr: i32, r: i32) {
    write_reg16(
        r,
        add16(read_reg16(r), return_on_pagefault!(safe_read16(addr))),
    );
}
pub unsafe fn instr16_03_reg(r1: i32, r: i32) {
    write_reg16(r, add16(read_reg16(r), read_reg16(r1)));
}
pub unsafe fn instr32_03_mem(addr: i32, r: i32) {
    write_reg32(
        r,
        add32(read_reg32(r), return_on_pagefault!(safe_read32s(addr))),
    );
}
pub unsafe fn instr32_03_reg(r1: i32, r: i32) {
    write_reg32(r, add32(read_reg32(r), read_reg32(r1)));
}
pub unsafe fn instr_04(imm8: i32) { write_reg8(AL, add8(read_reg8(AL), imm8)); }
pub unsafe fn instr16_05(imm16: i32) { write_reg16(AX, add16(read_reg16(AX), imm16)); }
pub unsafe fn instr32_05(imm32: i32) { write_reg32(EAX, add32(read_reg32(EAX), imm32)); }
pub unsafe fn instr16_06() {
    return_on_pagefault!(push16(*sreg.offset(ES as isize) as i32));
}
pub unsafe fn instr32_06() { return_on_pagefault!(push32_sreg(ES)) }

#[no_mangle]
pub unsafe fn instr16_07() {
    if !switch_seg(ES, return_on_pagefault!(safe_read16(get_stack_pointer(0)))) {
        return;
    }
    adjust_stack_reg(2);
}
#[no_mangle]
pub unsafe fn instr32_07() {
    if !switch_seg(
        ES,
        return_on_pagefault!(safe_read32s(get_stack_pointer(0))) & 0xFFFF,
    ) {
        return;
    }
    adjust_stack_reg(4);
}

pub unsafe fn instr_08_mem(addr: i32, r: i32) { safe_read_write8(addr, &|x| or8(x, read_reg8(r))) }
pub unsafe fn instr_08_reg(r1: i32, r: i32) { write_reg8(r1, or8(read_reg8(r1), read_reg8(r))); }
pub unsafe fn instr16_09_mem(addr: i32, r: i32) {
    safe_read_write16(addr, &|x| or16(x, read_reg16(r)))
}
pub unsafe fn instr16_09_reg(r1: i32, r: i32) {
    write_reg16(r1, or16(read_reg16(r1), read_reg16(r)));
}
pub unsafe fn instr32_09_mem(addr: i32, r: i32) {
    safe_read_write32(addr, &|x| or32(x, read_reg32(r)))
}
pub unsafe fn instr32_09_reg(r1: i32, r: i32) {
    write_reg32(r1, or32(read_reg32(r1), read_reg32(r)));
}
pub unsafe fn instr_0A_mem(addr: i32, r: i32) {
    write_reg8(r, or8(read_reg8(r), return_on_pagefault!(safe_read8(addr))));
}
pub unsafe fn instr_0A_reg(r1: i32, r: i32) { write_reg8(r, or8(read_reg8(r), read_reg8(r1))); }
pub unsafe fn instr16_0B_mem(addr: i32, r: i32) {
    write_reg16(
        r,
        or16(read_reg16(r), return_on_pagefault!(safe_read16(addr))),
    );
}
pub unsafe fn instr16_0B_reg(r1: i32, r: i32) {
    write_reg16(r, or16(read_reg16(r), read_reg16(r1)));
}
pub unsafe fn instr32_0B_mem(addr: i32, r: i32) {
    write_reg32(
        r,
        or32(read_reg32(r), return_on_pagefault!(safe_read32s(addr))),
    );
}
pub unsafe fn instr32_0B_reg(r1: i32, r: i32) {
    write_reg32(r, or32(read_reg32(r), read_reg32(r1)));
}
pub unsafe fn instr_0C(imm8: i32) { write_reg8(AL, or8(read_reg8(AL), imm8)); }
pub unsafe fn instr16_0D(imm16: i32) { write_reg16(AX, or16(read_reg16(AX), imm16)); }
pub unsafe fn instr32_0D(imm32: i32) { write_reg32(EAX, or32(read_reg32(EAX), imm32)); }

pub unsafe fn instr16_0E() {
    return_on_pagefault!(push16(*sreg.offset(CS as isize) as i32));
}
pub unsafe fn instr32_0E() { return_on_pagefault!(push32_sreg(CS)) }

pub unsafe fn instr16_0F() { run_instruction0f_16(return_on_pagefault!(read_imm8())); }
pub unsafe fn instr32_0F() { run_instruction0f_32(return_on_pagefault!(read_imm8())); }

pub unsafe fn instr_10_mem(addr: i32, r: i32) { safe_read_write8(addr, &|x| adc8(x, read_reg8(r))) }
pub unsafe fn instr_10_reg(r1: i32, r: i32) { write_reg8(r1, adc8(read_reg8(r1), read_reg8(r))); }
pub unsafe fn instr16_11_mem(addr: i32, r: i32) {
    safe_read_write16(addr, &|x| adc16(x, read_reg16(r)))
}
pub unsafe fn instr16_11_reg(r1: i32, r: i32) {
    write_reg16(r1, adc16(read_reg16(r1), read_reg16(r)));
}
pub unsafe fn instr32_11_mem(addr: i32, r: i32) {
    safe_read_write32(addr, &|x| adc32(x, read_reg32(r)))
}
pub unsafe fn instr32_11_reg(r1: i32, r: i32) {
    write_reg32(r1, adc32(read_reg32(r1), read_reg32(r)));
}
pub unsafe fn instr_12_mem(addr: i32, r: i32) {
    write_reg8(
        r,
        adc8(read_reg8(r), return_on_pagefault!(safe_read8(addr))),
    );
}
pub unsafe fn instr_12_reg(r1: i32, r: i32) { write_reg8(r, adc8(read_reg8(r), read_reg8(r1))); }
pub unsafe fn instr16_13_mem(addr: i32, r: i32) {
    write_reg16(
        r,
        adc16(read_reg16(r), return_on_pagefault!(safe_read16(addr))),
    );
}
pub unsafe fn instr16_13_reg(r1: i32, r: i32) {
    write_reg16(r, adc16(read_reg16(r), read_reg16(r1)));
}
pub unsafe fn instr32_13_mem(addr: i32, r: i32) {
    write_reg32(
        r,
        adc32(read_reg32(r), return_on_pagefault!(safe_read32s(addr))),
    );
}
pub unsafe fn instr32_13_reg(r1: i32, r: i32) {
    write_reg32(r, adc32(read_reg32(r), read_reg32(r1)));
}
pub unsafe fn instr_14(imm8: i32) { write_reg8(AL, adc8(read_reg8(AL), imm8)); }
pub unsafe fn instr16_15(imm16: i32) { write_reg16(AX, adc16(read_reg16(AX), imm16)); }
pub unsafe fn instr32_15(imm32: i32) { write_reg32(EAX, adc32(read_reg32(EAX), imm32)); }

pub unsafe fn instr16_16() {
    return_on_pagefault!(push16(*sreg.offset(SS as isize) as i32));
}
pub unsafe fn instr32_16() { return_on_pagefault!(push32_sreg(SS)) }

#[no_mangle]
pub unsafe fn instr16_17() {
    if !switch_seg(SS, return_on_pagefault!(safe_read16(get_stack_pointer(0)))) {
        return;
    }
    adjust_stack_reg(2);
}
#[no_mangle]
pub unsafe fn instr32_17() {
    if !switch_seg(
        SS,
        return_on_pagefault!(safe_read32s(get_stack_pointer(0))) & 0xFFFF,
    ) {
        return;
    }
    adjust_stack_reg(4);
}

pub unsafe fn instr_18_mem(addr: i32, r: i32) { safe_read_write8(addr, &|x| sbb8(x, read_reg8(r))) }
pub unsafe fn instr_18_reg(r1: i32, r: i32) { write_reg8(r1, sbb8(read_reg8(r1), read_reg8(r))); }
pub unsafe fn instr16_19_mem(addr: i32, r: i32) {
    safe_read_write16(addr, &|x| sbb16(x, read_reg16(r)))
}
pub unsafe fn instr16_19_reg(r1: i32, r: i32) {
    write_reg16(r1, sbb16(read_reg16(r1), read_reg16(r)));
}
pub unsafe fn instr32_19_mem(addr: i32, r: i32) {
    safe_read_write32(addr, &|x| sbb32(x, read_reg32(r)))
}
pub unsafe fn instr32_19_reg(r1: i32, r: i32) {
    write_reg32(r1, sbb32(read_reg32(r1), read_reg32(r)));
}
pub unsafe fn instr_1A_mem(addr: i32, r: i32) {
    write_reg8(
        r,
        sbb8(read_reg8(r), return_on_pagefault!(safe_read8(addr))),
    );
}
pub unsafe fn instr_1A_reg(r1: i32, r: i32) { write_reg8(r, sbb8(read_reg8(r), read_reg8(r1))); }
pub unsafe fn instr16_1B_mem(addr: i32, r: i32) {
    write_reg16(
        r,
        sbb16(read_reg16(r), return_on_pagefault!(safe_read16(addr))),
    );
}
pub unsafe fn instr16_1B_reg(r1: i32, r: i32) {
    write_reg16(r, sbb16(read_reg16(r), read_reg16(r1)));
}
pub unsafe fn instr32_1B_mem(addr: i32, r: i32) {
    write_reg32(
        r,
        sbb32(read_reg32(r), return_on_pagefault!(safe_read32s(addr))),
    );
}
pub unsafe fn instr32_1B_reg(r1: i32, r: i32) {
    write_reg32(r, sbb32(read_reg32(r), read_reg32(r1)));
}
pub unsafe fn instr_1C(imm8: i32) { write_reg8(AL, sbb8(read_reg8(AL), imm8)); }
pub unsafe fn instr16_1D(imm16: i32) { write_reg16(AX, sbb16(read_reg16(AX), imm16)); }
pub unsafe fn instr32_1D(imm32: i32) { write_reg32(EAX, sbb32(read_reg32(EAX), imm32)); }

pub unsafe fn instr16_1E() {
    return_on_pagefault!(push16(*sreg.offset(DS as isize) as i32));
}
pub unsafe fn instr32_1E() { return_on_pagefault!(push32_sreg(DS)) }

#[no_mangle]
pub unsafe fn instr16_1F() {
    if !switch_seg(DS, return_on_pagefault!(safe_read16(get_stack_pointer(0)))) {
        return;
    }
    adjust_stack_reg(2);
}
#[no_mangle]
pub unsafe fn instr32_1F() {
    if !switch_seg(
        DS,
        return_on_pagefault!(safe_read32s(get_stack_pointer(0))) & 0xFFFF,
    ) {
        return;
    }
    adjust_stack_reg(4);
}

pub unsafe fn instr_20_mem(addr: i32, r: i32) { safe_read_write8(addr, &|x| and8(x, read_reg8(r))) }
pub unsafe fn instr_20_reg(r1: i32, r: i32) { write_reg8(r1, and8(read_reg8(r1), read_reg8(r))); }
pub unsafe fn instr16_21_mem(addr: i32, r: i32) {
    safe_read_write16(addr, &|x| and16(x, read_reg16(r)))
}
pub unsafe fn instr16_21_reg(r1: i32, r: i32) {
    write_reg16(r1, and16(read_reg16(r1), read_reg16(r)));
}
pub unsafe fn instr32_21_mem(addr: i32, r: i32) {
    safe_read_write32(addr, &|x| and32(x, read_reg32(r)))
}
pub unsafe fn instr32_21_reg(r1: i32, r: i32) {
    write_reg32(r1, and32(read_reg32(r1), read_reg32(r)));
}
pub unsafe fn instr_22_mem(addr: i32, r: i32) {
    write_reg8(
        r,
        and8(read_reg8(r), return_on_pagefault!(safe_read8(addr))),
    );
}
pub unsafe fn instr_22_reg(r1: i32, r: i32) { write_reg8(r, and8(read_reg8(r), read_reg8(r1))); }
pub unsafe fn instr16_23_mem(addr: i32, r: i32) {
    write_reg16(
        r,
        and16(read_reg16(r), return_on_pagefault!(safe_read16(addr))),
    );
}
pub unsafe fn instr16_23_reg(r1: i32, r: i32) {
    write_reg16(r, and16(read_reg16(r), read_reg16(r1)));
}
pub unsafe fn instr32_23_mem(addr: i32, r: i32) {
    write_reg32(
        r,
        and32(read_reg32(r), return_on_pagefault!(safe_read32s(addr))),
    );
}
pub unsafe fn instr32_23_reg(r1: i32, r: i32) {
    write_reg32(r, and32(read_reg32(r), read_reg32(r1)));
}
pub unsafe fn instr_24(imm8: i32) { write_reg8(AL, and8(read_reg8(AL), imm8)); }
pub unsafe fn instr16_25(imm16: i32) { write_reg16(AX, and16(read_reg16(AX), imm16)); }
pub unsafe fn instr32_25(imm32: i32) { write_reg32(EAX, and32(read_reg32(EAX), imm32)); }

pub unsafe fn instr_26() { segment_prefix_op(ES); }

#[no_mangle]
pub unsafe fn instr_27() { bcd_daa(); }

pub unsafe fn instr_28_mem(addr: i32, r: i32) { safe_read_write8(addr, &|x| sub8(x, read_reg8(r))) }
pub unsafe fn instr_28_reg(r1: i32, r: i32) { write_reg8(r1, sub8(read_reg8(r1), read_reg8(r))); }
pub unsafe fn instr16_29_mem(addr: i32, r: i32) {
    safe_read_write16(addr, &|x| sub16(x, read_reg16(r)))
}
pub unsafe fn instr16_29_reg(r1: i32, r: i32) {
    write_reg16(r1, sub16(read_reg16(r1), read_reg16(r)));
}
pub unsafe fn instr32_29_mem(addr: i32, r: i32) {
    safe_read_write32(addr, &|x| sub32(x, read_reg32(r)))
}
pub unsafe fn instr32_29_reg(r1: i32, r: i32) {
    write_reg32(r1, sub32(read_reg32(r1), read_reg32(r)));
}
pub unsafe fn instr_2A_mem(addr: i32, r: i32) {
    write_reg8(
        r,
        sub8(read_reg8(r), return_on_pagefault!(safe_read8(addr))),
    );
}
pub unsafe fn instr_2A_reg(r1: i32, r: i32) { write_reg8(r, sub8(read_reg8(r), read_reg8(r1))); }
pub unsafe fn instr16_2B_mem(addr: i32, r: i32) {
    write_reg16(
        r,
        sub16(read_reg16(r), return_on_pagefault!(safe_read16(addr))),
    );
}
pub unsafe fn instr16_2B_reg(r1: i32, r: i32) {
    write_reg16(r, sub16(read_reg16(r), read_reg16(r1)));
}
pub unsafe fn instr32_2B_mem(addr: i32, r: i32) {
    write_reg32(
        r,
        sub32(read_reg32(r), return_on_pagefault!(safe_read32s(addr))),
    );
}
pub unsafe fn instr32_2B_reg(r1: i32, r: i32) {
    write_reg32(r, sub32(read_reg32(r), read_reg32(r1)));
}
pub unsafe fn instr_2C(imm8: i32) { write_reg8(AL, sub8(read_reg8(AL), imm8)); }
pub unsafe fn instr16_2D(imm16: i32) { write_reg16(AX, sub16(read_reg16(AX), imm16)); }
pub unsafe fn instr32_2D(imm32: i32) { write_reg32(EAX, sub32(read_reg32(EAX), imm32)); }

pub unsafe fn instr_2E() { segment_prefix_op(CS); }

#[no_mangle]
pub unsafe fn instr_2F() { bcd_das(); }

pub unsafe fn instr_30_mem(addr: i32, r: i32) { safe_read_write8(addr, &|x| xor8(x, read_reg8(r))) }
pub unsafe fn instr_30_reg(r1: i32, r: i32) { write_reg8(r1, xor8(read_reg8(r1), read_reg8(r))); }
pub unsafe fn instr16_31_mem(addr: i32, r: i32) {
    safe_read_write16(addr, &|x| xor16(x, read_reg16(r)))
}
pub unsafe fn instr16_31_reg(r1: i32, r: i32) {
    write_reg16(r1, xor16(read_reg16(r1), read_reg16(r)));
}
pub unsafe fn instr32_31_mem(addr: i32, r: i32) {
    safe_read_write32(addr, &|x| xor32(x, read_reg32(r)))
}
pub unsafe fn instr32_31_reg(r1: i32, r: i32) {
    write_reg32(r1, xor32(read_reg32(r1), read_reg32(r)));
}
pub unsafe fn instr_32_mem(addr: i32, r: i32) {
    write_reg8(
        r,
        xor8(read_reg8(r), return_on_pagefault!(safe_read8(addr))),
    );
}
pub unsafe fn instr_32_reg(r1: i32, r: i32) { write_reg8(r, xor8(read_reg8(r), read_reg8(r1))); }
pub unsafe fn instr16_33_mem(addr: i32, r: i32) {
    write_reg16(
        r,
        xor16(read_reg16(r), return_on_pagefault!(safe_read16(addr))),
    );
}
pub unsafe fn instr16_33_reg(r1: i32, r: i32) {
    write_reg16(r, xor16(read_reg16(r), read_reg16(r1)));
}
pub unsafe fn instr32_33_mem(addr: i32, r: i32) {
    write_reg32(
        r,
        xor32(read_reg32(r), return_on_pagefault!(safe_read32s(addr))),
    );
}
pub unsafe fn instr32_33_reg(r1: i32, r: i32) {
    write_reg32(r, xor32(read_reg32(r), read_reg32(r1)));
}
pub unsafe fn instr_34(imm8: i32) { write_reg8(AL, xor8(read_reg8(AL), imm8)); }
pub unsafe fn instr16_35(imm16: i32) { write_reg16(AX, xor16(read_reg16(AX), imm16)); }
pub unsafe fn instr32_35(imm32: i32) { write_reg32(EAX, xor32(read_reg32(EAX), imm32)); }

pub unsafe fn instr_36() { segment_prefix_op(SS); }

#[no_mangle]
pub unsafe fn instr_37() { bcd_aaa(); }

pub unsafe fn instr_38_mem(addr: i32, r: i32) {
    cmp8(return_on_pagefault!(safe_read8(addr)), read_reg8(r));
}
pub unsafe fn instr_38_reg(r1: i32, r: i32) { cmp8(read_reg8(r1), read_reg8(r)); }
pub unsafe fn instr16_39_mem(addr: i32, r: i32) {
    cmp16(return_on_pagefault!(safe_read16(addr)), read_reg16(r));
}
pub unsafe fn instr16_39_reg(r1: i32, r: i32) { cmp16(read_reg16(r1), read_reg16(r)); }
pub unsafe fn instr32_39_mem(addr: i32, r: i32) {
    cmp32(return_on_pagefault!(safe_read32s(addr)), read_reg32(r));
}
pub unsafe fn instr32_39_reg(r1: i32, r: i32) { cmp32(read_reg32(r1), read_reg32(r)); }
pub unsafe fn instr_3A_mem(addr: i32, r: i32) {
    cmp8(read_reg8(r), return_on_pagefault!(safe_read8(addr)));
}
pub unsafe fn instr_3A_reg(r1: i32, r: i32) { cmp8(read_reg8(r), read_reg8(r1)); }
pub unsafe fn instr16_3B_mem(addr: i32, r: i32) {
    cmp16(read_reg16(r), return_on_pagefault!(safe_read16(addr)));
}
pub unsafe fn instr16_3B_reg(r1: i32, r: i32) { cmp16(read_reg16(r), read_reg16(r1)); }
pub unsafe fn instr32_3B_mem(addr: i32, r: i32) {
    cmp32(read_reg32(r), return_on_pagefault!(safe_read32s(addr)));
}
pub unsafe fn instr32_3B_reg(r1: i32, r: i32) { cmp32(read_reg32(r), read_reg32(r1)); }
pub unsafe fn instr_3C(imm8: i32) { cmp8(read_reg8(AL), imm8); }
pub unsafe fn instr16_3D(imm16: i32) { cmp16(read_reg16(AX), imm16); }
pub unsafe fn instr32_3D(imm32: i32) { cmp32(read_reg32(EAX), imm32); }

pub unsafe fn instr_3E() { segment_prefix_op(DS); }

#[no_mangle]
pub unsafe fn instr_3F() { bcd_aas(); }

pub unsafe fn instr16_40() { write_reg16(AX, inc16(read_reg16(AX))); }
pub unsafe fn instr32_40() { write_reg32(EAX, inc32(read_reg32(EAX))); }
pub unsafe fn instr16_41() { write_reg16(CX, inc16(read_reg16(CX))); }
pub unsafe fn instr32_41() { write_reg32(ECX, inc32(read_reg32(ECX))); }
pub unsafe fn instr16_42() { write_reg16(DX, inc16(read_reg16(DX))); }
pub unsafe fn instr32_42() { write_reg32(EDX, inc32(read_reg32(EDX))); }
pub unsafe fn instr16_43() { write_reg16(BX, inc16(read_reg16(BX))); }
pub unsafe fn instr32_43() { write_reg32(EBX, inc32(read_reg32(EBX))); }
pub unsafe fn instr16_44() { write_reg16(SP, inc16(read_reg16(SP))); }
pub unsafe fn instr32_44() { write_reg32(ESP, inc32(read_reg32(ESP))); }
pub unsafe fn instr16_45() { write_reg16(BP, inc16(read_reg16(BP))); }
pub unsafe fn instr32_45() { write_reg32(EBP, inc32(read_reg32(EBP))); }
pub unsafe fn instr16_46() { write_reg16(SI, inc16(read_reg16(SI))); }
pub unsafe fn instr32_46() { write_reg32(ESI, inc32(read_reg32(ESI))); }
pub unsafe fn instr16_47() { write_reg16(DI, inc16(read_reg16(DI))); }
pub unsafe fn instr32_47() { write_reg32(EDI, inc32(read_reg32(EDI))); }
pub unsafe fn instr16_48() { write_reg16(AX, dec16(read_reg16(AX))); }
pub unsafe fn instr32_48() { write_reg32(EAX, dec32(read_reg32(EAX))); }
pub unsafe fn instr16_49() { write_reg16(CX, dec16(read_reg16(CX))); }
pub unsafe fn instr32_49() { write_reg32(ECX, dec32(read_reg32(ECX))); }
pub unsafe fn instr16_4A() { write_reg16(DX, dec16(read_reg16(DX))); }
pub unsafe fn instr32_4A() { write_reg32(EDX, dec32(read_reg32(EDX))); }
pub unsafe fn instr16_4B() { write_reg16(BX, dec16(read_reg16(BX))); }
pub unsafe fn instr32_4B() { write_reg32(EBX, dec32(read_reg32(EBX))); }
pub unsafe fn instr16_4C() { write_reg16(SP, dec16(read_reg16(SP))); }
pub unsafe fn instr32_4C() { write_reg32(ESP, dec32(read_reg32(ESP))); }
pub unsafe fn instr16_4D() { write_reg16(BP, dec16(read_reg16(BP))); }
pub unsafe fn instr32_4D() { write_reg32(EBP, dec32(read_reg32(EBP))); }
pub unsafe fn instr16_4E() { write_reg16(SI, dec16(read_reg16(SI))); }
pub unsafe fn instr32_4E() { write_reg32(ESI, dec32(read_reg32(ESI))); }
pub unsafe fn instr16_4F() { write_reg16(DI, dec16(read_reg16(DI))); }
pub unsafe fn instr32_4F() { write_reg32(EDI, dec32(read_reg32(EDI))); }

pub unsafe fn push16_reg(r: i32) {
    return_on_pagefault!(push16(read_reg16(r)));
}
pub unsafe fn push32_reg(r: i32) {
    return_on_pagefault!(push32(read_reg32(r)));
}

pub unsafe fn instr16_50() { push16_reg(AX) }
pub unsafe fn instr32_50() { push32_reg(EAX) }
pub unsafe fn instr16_51() { push16_reg(CX) }
pub unsafe fn instr32_51() { push32_reg(ECX) }
pub unsafe fn instr16_52() { push16_reg(DX) }
pub unsafe fn instr32_52() { push32_reg(EDX) }
pub unsafe fn instr16_53() { push16_reg(BX) }
pub unsafe fn instr32_53() { push32_reg(EBX) }
pub unsafe fn instr16_54() { push16_reg(SP) }
pub unsafe fn instr32_54() { push32_reg(ESP) }
pub unsafe fn instr16_55() { push16_reg(BP) }
pub unsafe fn instr32_55() { push32_reg(EBP) }
pub unsafe fn instr16_56() { push16_reg(SI) }
pub unsafe fn instr32_56() { push32_reg(ESI) }
pub unsafe fn instr16_57() { push16_reg(DI) }
pub unsafe fn instr32_57() { push32_reg(EDI) }
pub unsafe fn instr16_58() { write_reg16(AX, return_on_pagefault!(pop16())); }
pub unsafe fn instr32_58() { write_reg32(EAX, return_on_pagefault!(pop32s())); }
pub unsafe fn instr16_59() { write_reg16(CX, return_on_pagefault!(pop16())); }
pub unsafe fn instr32_59() { write_reg32(ECX, return_on_pagefault!(pop32s())); }
pub unsafe fn instr16_5A() { write_reg16(DX, return_on_pagefault!(pop16())); }
pub unsafe fn instr32_5A() { write_reg32(EDX, return_on_pagefault!(pop32s())); }
pub unsafe fn instr16_5B() { write_reg16(BX, return_on_pagefault!(pop16())); }
pub unsafe fn instr32_5B() { write_reg32(EBX, return_on_pagefault!(pop32s())); }
pub unsafe fn instr16_5C() {
    write_reg16(SP, return_on_pagefault!(safe_read16(get_stack_pointer(0))));
}
pub unsafe fn instr32_5C() {
    write_reg32(
        ESP,
        return_on_pagefault!(safe_read32s(get_stack_pointer(0))),
    );
}
pub unsafe fn instr16_5D() { write_reg16(BP, return_on_pagefault!(pop16())); }
pub unsafe fn instr32_5D() { write_reg32(EBP, return_on_pagefault!(pop32s())); }
pub unsafe fn instr16_5E() { write_reg16(SI, return_on_pagefault!(pop16())); }
pub unsafe fn instr32_5E() { write_reg32(ESI, return_on_pagefault!(pop32s())); }
pub unsafe fn instr16_5F() { write_reg16(DI, return_on_pagefault!(pop16())); }
pub unsafe fn instr32_5F() { write_reg32(EDI, return_on_pagefault!(pop32s())); }

#[no_mangle]
pub unsafe fn instr16_60() { pusha16(); }
#[no_mangle]
pub unsafe fn instr32_60() { pusha32(); }
#[no_mangle]
pub unsafe fn instr16_61() { popa16(); }
#[no_mangle]
pub unsafe fn instr32_61() { popa32(); }

#[no_mangle]
pub unsafe fn instr_62_reg(_r2: i32, _r: i32) {
    // bound
    dbg_log!("Unimplemented BOUND instruction");
    dbg_assert!(false);
}
#[no_mangle]
pub unsafe fn instr_62_mem(_addr: i32, _r: i32) {
    dbg_log!("Unimplemented BOUND instruction");
    dbg_assert!(false);
}

pub unsafe fn arpl(seg: i32, r16: i32) -> i32 {
    *flags_changed &= !FLAG_ZERO;

    if (seg & 3) < (r16 & 3) {
        *flags |= FLAG_ZERO;
        seg & !3 | r16 & 3
    }
    else {
        *flags &= !FLAG_ZERO;
        seg
    }
}

#[no_mangle]
pub unsafe fn instr_63_mem(addr: i32, r: i32) {
    if !*protected_mode || vm86_mode() {
        dbg_log!("arpl #ud");
        trigger_ud();
        return;
    }
    safe_read_write16(addr, &|x| arpl(x, read_reg16(r)))
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

pub unsafe fn instr_64() { segment_prefix_op(FS); }
pub unsafe fn instr_65() { segment_prefix_op(GS); }

pub unsafe fn instr_66() {
    // Operand-size override prefix
    *prefixes |= prefix::PREFIX_MASK_OPSIZE;
    run_prefix_instruction();
    *prefixes = 0;
}
pub unsafe fn instr_67() {
    // Address-size override prefix
    *prefixes |= prefix::PREFIX_MASK_ADDRSIZE;
    run_prefix_instruction();
    *prefixes = 0;
}

pub unsafe fn instr16_68(imm16: i32) {
    return_on_pagefault!(push16(imm16));
}
pub unsafe fn instr32_68(imm32: i32) {
    return_on_pagefault!(push32(imm32));
}
pub unsafe fn instr16_69_mem(addr: i32, r: i32, imm: i32) {
    write_reg16(r, imul_reg16(return_on_pagefault!(safe_read16(addr)), imm));
}
pub unsafe fn instr16_69_reg(r1: i32, r: i32, imm: i32) {
    write_reg16(r, imul_reg16(read_reg16(r1), imm));
}
pub unsafe fn instr32_69_mem(addr: i32, r: i32, imm: i32) {
    write_reg32(r, imul_reg32(return_on_pagefault!(safe_read32s(addr)), imm));
}
pub unsafe fn instr32_69_reg(r1: i32, r: i32, imm: i32) {
    write_reg32(r, imul_reg32(read_reg32(r1), imm));
}

pub unsafe fn instr16_6A(imm8: i32) {
    return_on_pagefault!(push16(imm8 & 0xFFFF));
}
pub unsafe fn instr32_6A(imm8: i32) {
    return_on_pagefault!(push32(imm8));
}
pub unsafe fn instr16_6B_mem(addr: i32, r: i32, imm: i32) {
    write_reg16(r, imul_reg16(return_on_pagefault!(safe_read16(addr)), imm));
}
pub unsafe fn instr16_6B_reg(r1: i32, r: i32, imm: i32) {
    write_reg16(r, imul_reg16(read_reg16(r1), imm));
}
pub unsafe fn instr32_6B_mem(addr: i32, r: i32, imm: i32) {
    write_reg32(r, imul_reg32(return_on_pagefault!(safe_read32s(addr)), imm));
}
pub unsafe fn instr32_6B_reg(r1: i32, r: i32, imm: i32) {
    write_reg32(r, imul_reg32(read_reg32(r1), imm));
}

pub unsafe fn instr_6C() { insb_no_rep(is_asize_32()); }
pub unsafe fn instr_F26C() { insb_rep(is_asize_32()); }
pub unsafe fn instr_F36C() { insb_rep(is_asize_32()); }
pub unsafe fn instr16_6D() { insw_no_rep(is_asize_32()); }
pub unsafe fn instr32_6D() { insd_no_rep(is_asize_32()); }
pub unsafe fn instr16_F26D() { insw_rep(is_asize_32()); }
pub unsafe fn instr16_F36D() { insw_rep(is_asize_32()); }
pub unsafe fn instr32_F26D() { insd_rep(is_asize_32()); }
pub unsafe fn instr32_F36D() { insd_rep(is_asize_32()); }

pub unsafe fn instr_6E() { outsb_no_rep(is_asize_32(), segment_prefix(DS)); }
pub unsafe fn instr_F26E() { outsb_rep(is_asize_32(), segment_prefix(DS)); }
pub unsafe fn instr_F36E() { outsb_rep(is_asize_32(), segment_prefix(DS)); }

pub unsafe fn instr16_6F() { outsw_no_rep(is_asize_32(), segment_prefix(DS)); }
pub unsafe fn instr32_6F() { outsd_no_rep(is_asize_32(), segment_prefix(DS)); }
pub unsafe fn instr16_F26F() { outsw_rep(is_asize_32(), segment_prefix(DS)); }
pub unsafe fn instr16_F36F() { outsw_rep(is_asize_32(), segment_prefix(DS)); }
pub unsafe fn instr32_F26F() { outsd_rep(is_asize_32(), segment_prefix(DS)); }
pub unsafe fn instr32_F36F() { outsd_rep(is_asize_32(), segment_prefix(DS)); }

pub unsafe fn instr16_70(imm8: i32) { jmpcc16(test_o(), imm8); }
pub unsafe fn instr16_71(imm8: i32) { jmpcc16(!test_o(), imm8); }
pub unsafe fn instr16_72(imm8: i32) { jmpcc16(test_b(), imm8); }
pub unsafe fn instr16_73(imm8: i32) { jmpcc16(!test_b(), imm8); }
pub unsafe fn instr16_74(imm8: i32) { jmpcc16(test_z(), imm8); }
pub unsafe fn instr16_75(imm8: i32) { jmpcc16(!test_z(), imm8); }
pub unsafe fn instr16_76(imm8: i32) { jmpcc16(test_be(), imm8); }
pub unsafe fn instr16_77(imm8: i32) { jmpcc16(!test_be(), imm8); }
pub unsafe fn instr16_78(imm8: i32) { jmpcc16(test_s(), imm8); }
pub unsafe fn instr16_79(imm8: i32) { jmpcc16(!test_s(), imm8); }
pub unsafe fn instr16_7A(imm8: i32) { jmpcc16(test_p(), imm8); }
pub unsafe fn instr16_7B(imm8: i32) { jmpcc16(!test_p(), imm8); }
pub unsafe fn instr16_7C(imm8: i32) { jmpcc16(test_l(), imm8); }
pub unsafe fn instr16_7D(imm8: i32) { jmpcc16(!test_l(), imm8); }
pub unsafe fn instr16_7E(imm8: i32) { jmpcc16(test_le(), imm8); }
pub unsafe fn instr16_7F(imm8: i32) { jmpcc16(!test_le(), imm8); }
pub unsafe fn instr32_70(imm8: i32) { jmpcc32(test_o(), imm8); }
pub unsafe fn instr32_71(imm8: i32) { jmpcc32(!test_o(), imm8); }
pub unsafe fn instr32_72(imm8: i32) { jmpcc32(test_b(), imm8); }
pub unsafe fn instr32_73(imm8: i32) { jmpcc32(!test_b(), imm8); }
pub unsafe fn instr32_74(imm8: i32) { jmpcc32(test_z(), imm8); }
pub unsafe fn instr32_75(imm8: i32) { jmpcc32(!test_z(), imm8); }
pub unsafe fn instr32_76(imm8: i32) { jmpcc32(test_be(), imm8); }
pub unsafe fn instr32_77(imm8: i32) { jmpcc32(!test_be(), imm8); }
pub unsafe fn instr32_78(imm8: i32) { jmpcc32(test_s(), imm8); }
pub unsafe fn instr32_79(imm8: i32) { jmpcc32(!test_s(), imm8); }
pub unsafe fn instr32_7A(imm8: i32) { jmpcc32(test_p(), imm8); }
pub unsafe fn instr32_7B(imm8: i32) { jmpcc32(!test_p(), imm8); }
pub unsafe fn instr32_7C(imm8: i32) { jmpcc32(test_l(), imm8); }
pub unsafe fn instr32_7D(imm8: i32) { jmpcc32(!test_l(), imm8); }
pub unsafe fn instr32_7E(imm8: i32) { jmpcc32(test_le(), imm8); }
pub unsafe fn instr32_7F(imm8: i32) { jmpcc32(!test_le(), imm8); }

pub unsafe fn instr_80_0_mem(addr: i32, imm: i32) { safe_read_write8(addr, &|x| add8(x, imm)) }
pub unsafe fn instr_80_0_reg(r1: i32, imm: i32) { write_reg8(r1, add8(read_reg8(r1), imm)); }
pub unsafe fn instr_80_1_mem(addr: i32, imm: i32) { safe_read_write8(addr, &|x| or8(x, imm)) }
pub unsafe fn instr_80_1_reg(r1: i32, imm: i32) { write_reg8(r1, or8(read_reg8(r1), imm)); }
pub unsafe fn instr_80_2_mem(addr: i32, imm: i32) { safe_read_write8(addr, &|x| adc8(x, imm)) }
pub unsafe fn instr_80_2_reg(r1: i32, imm: i32) { write_reg8(r1, adc8(read_reg8(r1), imm)); }
pub unsafe fn instr_80_3_mem(addr: i32, imm: i32) { safe_read_write8(addr, &|x| sbb8(x, imm)) }
pub unsafe fn instr_80_3_reg(r1: i32, imm: i32) { write_reg8(r1, sbb8(read_reg8(r1), imm)); }
pub unsafe fn instr_80_4_mem(addr: i32, imm: i32) { safe_read_write8(addr, &|x| and8(x, imm)) }
pub unsafe fn instr_80_4_reg(r1: i32, imm: i32) { write_reg8(r1, and8(read_reg8(r1), imm)); }
pub unsafe fn instr_80_5_mem(addr: i32, imm: i32) { safe_read_write8(addr, &|x| sub8(x, imm)) }
pub unsafe fn instr_80_5_reg(r1: i32, imm: i32) { write_reg8(r1, sub8(read_reg8(r1), imm)); }
pub unsafe fn instr_80_6_mem(addr: i32, imm: i32) { safe_read_write8(addr, &|x| xor8(x, imm)) }
pub unsafe fn instr_80_6_reg(r1: i32, imm: i32) { write_reg8(r1, xor8(read_reg8(r1), imm)); }
pub unsafe fn instr_80_7_reg(r: i32, imm: i32) { cmp8(read_reg8(r), imm); }
pub unsafe fn instr_80_7_mem(addr: i32, imm: i32) {
    cmp8(return_on_pagefault!(safe_read8(addr)), imm);
}
pub unsafe fn instr16_81_0_mem(addr: i32, imm: i32) { safe_read_write16(addr, &|x| add16(x, imm)) }
pub unsafe fn instr16_81_0_reg(r1: i32, imm: i32) { write_reg16(r1, add16(read_reg16(r1), imm)); }
pub unsafe fn instr16_81_1_mem(addr: i32, imm: i32) { safe_read_write16(addr, &|x| or16(x, imm)) }
pub unsafe fn instr16_81_1_reg(r1: i32, imm: i32) { write_reg16(r1, or16(read_reg16(r1), imm)); }
pub unsafe fn instr16_81_2_mem(addr: i32, imm: i32) { safe_read_write16(addr, &|x| adc16(x, imm)) }
pub unsafe fn instr16_81_2_reg(r1: i32, imm: i32) { write_reg16(r1, adc16(read_reg16(r1), imm)); }
pub unsafe fn instr16_81_3_mem(addr: i32, imm: i32) { safe_read_write16(addr, &|x| sbb16(x, imm)) }
pub unsafe fn instr16_81_3_reg(r1: i32, imm: i32) { write_reg16(r1, sbb16(read_reg16(r1), imm)); }
pub unsafe fn instr16_81_4_mem(addr: i32, imm: i32) { safe_read_write16(addr, &|x| and16(x, imm)) }
pub unsafe fn instr16_81_4_reg(r1: i32, imm: i32) { write_reg16(r1, and16(read_reg16(r1), imm)); }
pub unsafe fn instr16_81_5_mem(addr: i32, imm: i32) { safe_read_write16(addr, &|x| sub16(x, imm)) }
pub unsafe fn instr16_81_5_reg(r1: i32, imm: i32) { write_reg16(r1, sub16(read_reg16(r1), imm)); }
pub unsafe fn instr16_81_6_mem(addr: i32, imm: i32) { safe_read_write16(addr, &|x| xor16(x, imm)) }
pub unsafe fn instr16_81_6_reg(r1: i32, imm: i32) { write_reg16(r1, xor16(read_reg16(r1), imm)); }
pub unsafe fn instr16_81_7_reg(r: i32, imm: i32) { cmp16(read_reg16(r), imm); }
pub unsafe fn instr16_81_7_mem(addr: i32, imm: i32) {
    cmp16(return_on_pagefault!(safe_read16(addr)), imm);
}
pub unsafe fn instr32_81_0_mem(addr: i32, imm: i32) { safe_read_write32(addr, &|x| add32(x, imm)) }
pub unsafe fn instr32_81_0_reg(r1: i32, imm: i32) { write_reg32(r1, add32(read_reg32(r1), imm)); }
pub unsafe fn instr32_81_1_mem(addr: i32, imm: i32) { safe_read_write32(addr, &|x| or32(x, imm)) }
pub unsafe fn instr32_81_1_reg(r1: i32, imm: i32) { write_reg32(r1, or32(read_reg32(r1), imm)); }
pub unsafe fn instr32_81_2_mem(addr: i32, imm: i32) { safe_read_write32(addr, &|x| adc32(x, imm)) }
pub unsafe fn instr32_81_2_reg(r1: i32, imm: i32) { write_reg32(r1, adc32(read_reg32(r1), imm)); }
pub unsafe fn instr32_81_3_mem(addr: i32, imm: i32) { safe_read_write32(addr, &|x| sbb32(x, imm)) }
pub unsafe fn instr32_81_3_reg(r1: i32, imm: i32) { write_reg32(r1, sbb32(read_reg32(r1), imm)); }
pub unsafe fn instr32_81_4_mem(addr: i32, imm: i32) { safe_read_write32(addr, &|x| and32(x, imm)) }
pub unsafe fn instr32_81_4_reg(r1: i32, imm: i32) { write_reg32(r1, and32(read_reg32(r1), imm)); }
pub unsafe fn instr32_81_5_mem(addr: i32, imm: i32) { safe_read_write32(addr, &|x| sub32(x, imm)) }
pub unsafe fn instr32_81_5_reg(r1: i32, imm: i32) { write_reg32(r1, sub32(read_reg32(r1), imm)); }
pub unsafe fn instr32_81_6_mem(addr: i32, imm: i32) { safe_read_write32(addr, &|x| xor32(x, imm)) }
pub unsafe fn instr32_81_6_reg(r1: i32, imm: i32) { write_reg32(r1, xor32(read_reg32(r1), imm)); }
pub unsafe fn instr32_81_7_reg(r: i32, imm: i32) { cmp32(read_reg32(r), imm); }
pub unsafe fn instr32_81_7_mem(addr: i32, imm: i32) {
    cmp32(return_on_pagefault!(safe_read32s(addr)), imm);
}
pub unsafe fn instr_82_0_mem(addr: i32, imm: i32) { safe_read_write8(addr, &|x| add8(x, imm)) }
pub unsafe fn instr_82_0_reg(r1: i32, imm: i32) { write_reg8(r1, add8(read_reg8(r1), imm)); }
pub unsafe fn instr_82_1_mem(addr: i32, imm: i32) { safe_read_write8(addr, &|x| or8(x, imm)) }
pub unsafe fn instr_82_1_reg(r1: i32, imm: i32) { write_reg8(r1, or8(read_reg8(r1), imm)); }
pub unsafe fn instr_82_2_mem(addr: i32, imm: i32) { safe_read_write8(addr, &|x| adc8(x, imm)) }
pub unsafe fn instr_82_2_reg(r1: i32, imm: i32) { write_reg8(r1, adc8(read_reg8(r1), imm)); }
pub unsafe fn instr_82_3_mem(addr: i32, imm: i32) { safe_read_write8(addr, &|x| sbb8(x, imm)) }
pub unsafe fn instr_82_3_reg(r1: i32, imm: i32) { write_reg8(r1, sbb8(read_reg8(r1), imm)); }
pub unsafe fn instr_82_4_mem(addr: i32, imm: i32) { safe_read_write8(addr, &|x| and8(x, imm)) }
pub unsafe fn instr_82_4_reg(r1: i32, imm: i32) { write_reg8(r1, and8(read_reg8(r1), imm)); }
pub unsafe fn instr_82_5_mem(addr: i32, imm: i32) { safe_read_write8(addr, &|x| sub8(x, imm)) }
pub unsafe fn instr_82_5_reg(r1: i32, imm: i32) { write_reg8(r1, sub8(read_reg8(r1), imm)); }
pub unsafe fn instr_82_6_mem(addr: i32, imm: i32) { safe_read_write8(addr, &|x| xor8(x, imm)) }
pub unsafe fn instr_82_6_reg(r1: i32, imm: i32) { write_reg8(r1, xor8(read_reg8(r1), imm)); }
pub unsafe fn instr_82_7_reg(r: i32, imm: i32) { cmp8(read_reg8(r), imm); }
pub unsafe fn instr_82_7_mem(addr: i32, imm: i32) {
    cmp8(return_on_pagefault!(safe_read8(addr)), imm);
}
pub unsafe fn instr16_83_0_mem(addr: i32, imm: i32) {
    safe_read_write16(addr, &|x| add16(x, imm & 0xFFFF))
}
pub unsafe fn instr16_83_0_reg(r1: i32, imm: i32) {
    write_reg16(r1, add16(read_reg16(r1), imm & 0xFFFF));
}
pub unsafe fn instr16_83_1_mem(addr: i32, imm: i32) {
    safe_read_write16(addr, &|x| or16(x, imm & 0xFFFF))
}
pub unsafe fn instr16_83_1_reg(r1: i32, imm: i32) {
    write_reg16(r1, or16(read_reg16(r1), imm & 0xFFFF));
}
pub unsafe fn instr16_83_2_mem(addr: i32, imm: i32) {
    safe_read_write16(addr, &|x| adc16(x, imm & 0xFFFF))
}
pub unsafe fn instr16_83_2_reg(r1: i32, imm: i32) {
    write_reg16(r1, adc16(read_reg16(r1), imm & 0xFFFF));
}
pub unsafe fn instr16_83_3_mem(addr: i32, imm: i32) {
    safe_read_write16(addr, &|x| sbb16(x, imm & 0xFFFF))
}
pub unsafe fn instr16_83_3_reg(r1: i32, imm: i32) {
    write_reg16(r1, sbb16(read_reg16(r1), imm & 0xFFFF));
}
pub unsafe fn instr16_83_4_mem(addr: i32, imm: i32) {
    safe_read_write16(addr, &|x| and16(x, imm & 0xFFFF))
}
pub unsafe fn instr16_83_4_reg(r1: i32, imm: i32) {
    write_reg16(r1, and16(read_reg16(r1), imm & 0xFFFF));
}
pub unsafe fn instr16_83_5_mem(addr: i32, imm: i32) {
    safe_read_write16(addr, &|x| sub16(x, imm & 0xFFFF))
}
pub unsafe fn instr16_83_5_reg(r1: i32, imm: i32) {
    write_reg16(r1, sub16(read_reg16(r1), imm & 0xFFFF));
}
pub unsafe fn instr16_83_6_mem(addr: i32, imm: i32) {
    safe_read_write16(addr, &|x| xor16(x, imm & 0xFFFF))
}
pub unsafe fn instr16_83_6_reg(r1: i32, imm: i32) {
    write_reg16(r1, xor16(read_reg16(r1), imm & 0xFFFF));
}
pub unsafe fn instr16_83_7_reg(r: i32, imm: i32) { cmp16(read_reg16(r), imm & 0xFFFF); }
pub unsafe fn instr16_83_7_mem(addr: i32, imm: i32) {
    cmp16(return_on_pagefault!(safe_read16(addr)), imm & 0xFFFF);
}

pub unsafe fn instr32_83_0_mem(addr: i32, imm: i32) { safe_read_write32(addr, &|x| add32(x, imm)) }
pub unsafe fn instr32_83_0_reg(r1: i32, imm: i32) { write_reg32(r1, add32(read_reg32(r1), imm)); }
pub unsafe fn instr32_83_1_mem(addr: i32, imm: i32) { safe_read_write32(addr, &|x| or32(x, imm)) }
pub unsafe fn instr32_83_1_reg(r1: i32, imm: i32) { write_reg32(r1, or32(read_reg32(r1), imm)); }
pub unsafe fn instr32_83_2_mem(addr: i32, imm: i32) { safe_read_write32(addr, &|x| adc32(x, imm)) }
pub unsafe fn instr32_83_2_reg(r1: i32, imm: i32) { write_reg32(r1, adc32(read_reg32(r1), imm)); }
pub unsafe fn instr32_83_3_mem(addr: i32, imm: i32) { safe_read_write32(addr, &|x| sbb32(x, imm)) }
pub unsafe fn instr32_83_3_reg(r1: i32, imm: i32) { write_reg32(r1, sbb32(read_reg32(r1), imm)); }
pub unsafe fn instr32_83_4_mem(addr: i32, imm: i32) { safe_read_write32(addr, &|x| and32(x, imm)) }
pub unsafe fn instr32_83_4_reg(r1: i32, imm: i32) { write_reg32(r1, and32(read_reg32(r1), imm)); }
pub unsafe fn instr32_83_5_mem(addr: i32, imm: i32) { safe_read_write32(addr, &|x| sub32(x, imm)) }
pub unsafe fn instr32_83_5_reg(r1: i32, imm: i32) { write_reg32(r1, sub32(read_reg32(r1), imm)); }
pub unsafe fn instr32_83_6_mem(addr: i32, imm: i32) { safe_read_write32(addr, &|x| xor32(x, imm)) }
pub unsafe fn instr32_83_6_reg(r1: i32, imm: i32) { write_reg32(r1, xor32(read_reg32(r1), imm)); }
pub unsafe fn instr32_83_7_reg(r: i32, imm: i32) { cmp32(read_reg32(r), imm); }
pub unsafe fn instr32_83_7_mem(addr: i32, imm: i32) {
    cmp32(return_on_pagefault!(safe_read32s(addr)), imm);
}

pub unsafe fn instr_84_mem(addr: i32, r: i32) {
    test8(return_on_pagefault!(safe_read8(addr)), read_reg8(r));
}
pub unsafe fn instr_84_reg(r1: i32, r: i32) { test8(read_reg8(r1), read_reg8(r)); }
pub unsafe fn instr16_85_mem(addr: i32, r: i32) {
    test16(return_on_pagefault!(safe_read16(addr)), read_reg16(r));
}
pub unsafe fn instr16_85_reg(r1: i32, r: i32) { test16(read_reg16(r1), read_reg16(r)); }
pub unsafe fn instr32_85_mem(addr: i32, r: i32) {
    test32(return_on_pagefault!(safe_read32s(addr)), read_reg32(r));
}
pub unsafe fn instr32_85_reg(r1: i32, r: i32) { test32(read_reg32(r1), read_reg32(r)); }
pub unsafe fn instr_86_mem(addr: i32, r: i32) { safe_read_write8(addr, &|x| xchg8(x, r)) }
pub unsafe fn instr_86_reg(r1: i32, r: i32) { write_reg8(r1, xchg8(read_reg8(r1), r)); }
pub unsafe fn instr16_87_mem(addr: i32, r: i32) { safe_read_write16(addr, &|x| xchg16(x, r)) }
pub unsafe fn instr16_87_reg(r1: i32, r: i32) { write_reg16(r1, xchg16(read_reg16(r1), r)); }
pub unsafe fn instr32_87_mem(addr: i32, r: i32) { safe_read_write32(addr, &|x| xchg32(x, r)) }
pub unsafe fn instr32_87_reg(r1: i32, r: i32) { write_reg32(r1, xchg32(read_reg32(r1), r)); }
pub unsafe fn instr_88_reg(r2: i32, r: i32) { write_reg8(r2, read_reg8(r)); }
pub unsafe fn instr_88_mem(addr: i32, r: i32) {
    return_on_pagefault!(safe_write8(addr, read_reg8(r)));
}
pub unsafe fn instr16_89_reg(r2: i32, r: i32) { write_reg16(r2, read_reg16(r)); }
pub unsafe fn instr16_89_mem(addr: i32, r: i32) {
    return_on_pagefault!(safe_write16(addr, read_reg16(r)));
}
pub unsafe fn instr32_89_reg(r2: i32, r: i32) { write_reg32(r2, read_reg32(r)); }
pub unsafe fn instr32_89_mem(addr: i32, r: i32) {
    return_on_pagefault!(safe_write32(addr, read_reg32(r)));
}
pub unsafe fn instr_8A_mem(addr: i32, r: i32) {
    write_reg8(r, return_on_pagefault!(safe_read8(addr)));
}
pub unsafe fn instr_8A_reg(r1: i32, r: i32) { write_reg8(r, read_reg8(r1)); }
pub unsafe fn instr16_8B_mem(addr: i32, r: i32) {
    write_reg16(r, return_on_pagefault!(safe_read16(addr)));
}
pub unsafe fn instr16_8B_reg(r1: i32, r: i32) { write_reg16(r, read_reg16(r1)); }
pub unsafe fn instr32_8B_mem(addr: i32, r: i32) {
    write_reg32(r, return_on_pagefault!(safe_read32s(addr)));
}
pub unsafe fn instr32_8B_reg(r1: i32, r: i32) { write_reg32(r, read_reg32(r1)); }

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
pub unsafe fn instr16_8C_reg(r: i32, seg: i32) {
    if instr_8C_check_sreg(seg) {
        write_reg16(r, *sreg.offset(seg as isize) as i32);
    };
}
pub unsafe fn instr16_8C_mem(addr: i32, seg: i32) {
    if instr_8C_check_sreg(seg) {
        return_on_pagefault!(safe_write16(addr, *sreg.offset(seg as isize) as i32));
    };
}
pub unsafe fn instr32_8C_reg(r: i32, seg: i32) {
    if instr_8C_check_sreg(seg) {
        write_reg32(r, *sreg.offset(seg as isize) as i32);
    };
}
pub unsafe fn instr32_8C_mem(addr: i32, seg: i32) {
    if instr_8C_check_sreg(seg) {
        return_on_pagefault!(safe_write16(addr, *sreg.offset(seg as isize) as i32));
    };
}

pub unsafe fn instr16_8D_reg(_r: i32, _r2: i32) {
    dbg_log!("lea #ud");
    trigger_ud();
}
pub unsafe fn instr16_8D_mem(modrm_byte: i32, r: i32) {
    // lea
    *prefixes |= prefix::SEG_PREFIX_ZERO;
    if let Ok(addr) = modrm_resolve(modrm_byte) {
        write_reg16(r, addr);
    }
    *prefixes = 0;
}
pub unsafe fn instr32_8D_reg(_r: i32, _r2: i32) {
    dbg_log!("lea #ud");
    trigger_ud();
}
pub unsafe fn instr32_8D_mem(modrm_byte: i32, r: i32) {
    // lea
    // override prefix, so modrm_resolve does not return the segment part
    *prefixes |= prefix::SEG_PREFIX_ZERO;
    if let Ok(addr) = modrm_resolve(modrm_byte) {
        write_reg32(r, addr);
    }
    *prefixes = 0;
}

#[no_mangle]
pub unsafe fn instr_8E_mem(addr: i32, r: i32) {
    if r == ES || r == SS || r == DS || r == FS || r == GS {
        if !switch_seg(r, return_on_pagefault!(safe_read16(addr))) {
            return;
        }
    }
    else {
        dbg_log!("mov sreg #ud");
        trigger_ud();
    }
}
#[no_mangle]
pub unsafe fn instr_8E_reg(r1: i32, r: i32) {
    if r == ES || r == SS || r == DS || r == FS || r == GS {
        switch_seg(r, read_reg16(r1));
    }
    else {
        dbg_log!("mov sreg #ud");
        trigger_ud();
    }
}

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
pub unsafe fn instr16_8F_0_reg(r: i32) { write_reg16(r, return_on_pagefault!(pop16())); }
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
pub unsafe fn instr32_8F_0_reg(r: i32) { write_reg32(r, return_on_pagefault!(pop32s())); }

pub unsafe fn instr_90() {}
pub unsafe fn instr16_91() { xchg16r(CX); }
pub unsafe fn instr32_91() { xchg32r(ECX); }
pub unsafe fn instr16_92() { xchg16r(DX); }
pub unsafe fn instr32_92() { xchg32r(EDX); }
pub unsafe fn instr16_93() { xchg16r(BX); }
pub unsafe fn instr32_93() { xchg32r(EBX); }
pub unsafe fn instr16_94() { xchg16r(SP); }
pub unsafe fn instr32_94() { xchg32r(ESP); }
pub unsafe fn instr16_95() { xchg16r(BP); }
pub unsafe fn instr32_95() { xchg32r(EBP); }
pub unsafe fn instr16_96() { xchg16r(SI); }
pub unsafe fn instr32_96() { xchg32r(ESI); }
pub unsafe fn instr16_97() { xchg16r(DI); }
pub unsafe fn instr32_97() { xchg32r(EDI); }

pub unsafe fn instr16_98() { write_reg16(AX, read_reg8(AL) << 24 >> 24); }
pub unsafe fn instr32_98() { write_reg32(EAX, read_reg16(AX) as i16 as i32); }
pub unsafe fn instr16_99() { write_reg16(DX, read_reg16(AX) as i16 as i32 >> 15); }
pub unsafe fn instr32_99() { write_reg32(EDX, read_reg32(EAX) >> 31); }

#[no_mangle]
pub unsafe fn instr16_9A(new_ip: i32, new_cs: i32) {
    // callf
    far_jump(new_ip, new_cs, true, false);
}
#[no_mangle]
pub unsafe fn instr32_9A(new_ip: i32, new_cs: i32) {
    if !*protected_mode || vm86_mode() {
        if 0 != new_ip as u32 & 0xFFFF0000 {
            dbg_assert!(false);
        }
    }
    far_jump(new_ip, new_cs, true, true);
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
unsafe fn instr_pushf_popf_check() -> bool { 0 != *flags & FLAG_VM && getiopl() < 3 }
pub unsafe fn instr16_9C() {
    // pushf
    if instr_pushf_popf_check() {
        dbg_assert!(*protected_mode);
        dbg_log!("pushf #gp");
        trigger_gp(0);
    }
    else {
        return_on_pagefault!(push16(get_eflags() & 0xFFFF));
    };
}
pub unsafe fn instr32_9C() {
    // pushf
    if instr_pushf_popf_check() {
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

pub unsafe fn instr16_9D() {
    // popf
    if instr_pushf_popf_check() {
        dbg_log!("popf #gp");
        trigger_gp(0);
        return;
    }
    let old_eflags = *flags;
    update_eflags(*flags & !0xFFFF | return_on_pagefault!(pop16()));
    if old_eflags & FLAG_INTERRUPT == 0 && *flags & FLAG_INTERRUPT != 0 {
        handle_irqs();
    }
}
pub unsafe fn instr32_9D() {
    // popf
    if instr_pushf_popf_check() {
        dbg_log!("popf #gp");
        trigger_gp(0);
        return;
    }
    let old_eflags = *flags;
    update_eflags(return_on_pagefault!(pop32s()));
    if old_eflags & FLAG_INTERRUPT == 0 && *flags & FLAG_INTERRUPT != 0 {
        handle_irqs();
    }
}

pub unsafe fn instr_9E() {
    // sahf
    *flags = *flags & !255 | read_reg8(AH);
    *flags = *flags & FLAGS_MASK | FLAGS_DEFAULT;
    *flags_changed &= !255;
}
pub unsafe fn instr_9F() {
    // lahf
    write_reg8(AH, get_eflags());
}

pub unsafe fn instr_A0(moffs: i32) {
    // mov
    let data = return_on_pagefault!(safe_read8(return_on_pagefault!(get_seg_prefix_ds(moffs))));
    write_reg8(AL, data);
}
pub unsafe fn instr16_A1(moffs: i32) {
    // mov
    let data = return_on_pagefault!(safe_read16(return_on_pagefault!(get_seg_prefix_ds(moffs))));
    write_reg16(AX, data);
}
pub unsafe fn instr32_A1(moffs: i32) {
    let data = return_on_pagefault!(safe_read32s(return_on_pagefault!(get_seg_prefix_ds(moffs))));
    write_reg32(EAX, data);
}
pub unsafe fn instr_A2(moffs: i32) {
    // mov
    return_on_pagefault!(safe_write8(
        return_on_pagefault!(get_seg_prefix_ds(moffs)),
        read_reg8(AL)
    ));
}
pub unsafe fn instr16_A3(moffs: i32) {
    // mov
    return_on_pagefault!(safe_write16(
        return_on_pagefault!(get_seg_prefix_ds(moffs)),
        read_reg16(AX)
    ));
}
pub unsafe fn instr32_A3(moffs: i32) {
    return_on_pagefault!(safe_write32(
        return_on_pagefault!(get_seg_prefix_ds(moffs)),
        read_reg32(EAX)
    ));
}

pub unsafe fn instr_A4() { movsb_no_rep(is_asize_32(), segment_prefix(DS)); }
pub unsafe fn instr_F2A4() { movsb_rep(is_asize_32(), segment_prefix(DS)); }
pub unsafe fn instr_F3A4() { movsb_rep(is_asize_32(), segment_prefix(DS)); }

pub unsafe fn instr16_A5() { movsw_no_rep(is_asize_32(), segment_prefix(DS)); }
pub unsafe fn instr32_A5() { movsd_no_rep(is_asize_32(), segment_prefix(DS)); }
pub unsafe fn instr16_F2A5() { movsw_rep(is_asize_32(), segment_prefix(DS)); }
pub unsafe fn instr16_F3A5() { movsw_rep(is_asize_32(), segment_prefix(DS)); }
pub unsafe fn instr32_F2A5() { movsd_rep(is_asize_32(), segment_prefix(DS)); }
pub unsafe fn instr32_F3A5() { movsd_rep(is_asize_32(), segment_prefix(DS)); }

pub unsafe fn instr_A6() { cmpsb_no_rep(is_asize_32(), segment_prefix(DS)); }
pub unsafe fn instr_F2A6() { cmpsb_repnz(is_asize_32(), segment_prefix(DS)); }
pub unsafe fn instr_F3A6() { cmpsb_repz(is_asize_32(), segment_prefix(DS)); }
pub unsafe fn instr16_A7() { cmpsw_no_rep(is_asize_32(), segment_prefix(DS)); }
pub unsafe fn instr32_A7() { cmpsd_no_rep(is_asize_32(), segment_prefix(DS)); }
pub unsafe fn instr16_F2A7() { cmpsw_repnz(is_asize_32(), segment_prefix(DS)); }
pub unsafe fn instr16_F3A7() { cmpsw_repz(is_asize_32(), segment_prefix(DS)); }
pub unsafe fn instr32_F2A7() { cmpsd_repnz(is_asize_32(), segment_prefix(DS)); }
pub unsafe fn instr32_F3A7() { cmpsd_repz(is_asize_32(), segment_prefix(DS)); }

pub unsafe fn instr_A8(imm8: i32) { test8(read_reg8(AL), imm8); }
pub unsafe fn instr16_A9(imm16: i32) { test16(read_reg16(AX), imm16); }
pub unsafe fn instr32_A9(imm32: i32) { test32(read_reg32(EAX), imm32); }

pub unsafe fn instr_AA() { stosb_no_rep(is_asize_32()); }
pub unsafe fn instr_F2AA() { stosb_rep(is_asize_32()); }
pub unsafe fn instr_F3AA() { stosb_rep(is_asize_32()); }

pub unsafe fn instr16_AB() { stosw_no_rep(is_asize_32()); }
pub unsafe fn instr32_AB() { stosd_no_rep(is_asize_32()); }
pub unsafe fn instr16_F2AB() { stosw_rep(is_asize_32()); }
pub unsafe fn instr16_F3AB() { stosw_rep(is_asize_32()); }
pub unsafe fn instr32_F2AB() { stosd_rep(is_asize_32()); }
pub unsafe fn instr32_F3AB() { stosd_rep(is_asize_32()); }

pub unsafe fn instr_AC() { lodsb_no_rep(is_asize_32(), segment_prefix(DS)); }
pub unsafe fn instr_F2AC() { lodsb_rep(is_asize_32(), segment_prefix(DS)); }
pub unsafe fn instr_F3AC() { lodsb_rep(is_asize_32(), segment_prefix(DS)); }

pub unsafe fn instr16_AD() { lodsw_no_rep(is_asize_32(), segment_prefix(DS)); }
pub unsafe fn instr32_AD() { lodsd_no_rep(is_asize_32(), segment_prefix(DS)); }
pub unsafe fn instr16_F2AD() { lodsw_rep(is_asize_32(), segment_prefix(DS)); }
pub unsafe fn instr16_F3AD() { lodsw_rep(is_asize_32(), segment_prefix(DS)); }
pub unsafe fn instr32_F2AD() { lodsd_rep(is_asize_32(), segment_prefix(DS)); }
pub unsafe fn instr32_F3AD() { lodsd_rep(is_asize_32(), segment_prefix(DS)); }

pub unsafe fn instr_AE() { scasb_no_rep(is_asize_32()); }
pub unsafe fn instr_F2AE() { scasb_repnz(is_asize_32()); }
pub unsafe fn instr_F3AE() { scasb_repz(is_asize_32()); }

pub unsafe fn instr16_AF() { scasw_no_rep(is_asize_32()); }
pub unsafe fn instr32_AF() { scasd_no_rep(is_asize_32()); }
pub unsafe fn instr16_F2AF() { scasw_repnz(is_asize_32()); }
pub unsafe fn instr16_F3AF() { scasw_repz(is_asize_32()); }
pub unsafe fn instr32_F2AF() { scasd_repnz(is_asize_32()); }
pub unsafe fn instr32_F3AF() { scasd_repz(is_asize_32()); }

pub unsafe fn instr_B0(imm8: i32) { write_reg8(AL, imm8); }
pub unsafe fn instr_B1(imm8: i32) { write_reg8(CL, imm8); }
pub unsafe fn instr_B2(imm8: i32) { write_reg8(DL, imm8); }
pub unsafe fn instr_B3(imm8: i32) { write_reg8(BL, imm8); }
pub unsafe fn instr_B4(imm8: i32) { write_reg8(AH, imm8); }
pub unsafe fn instr_B5(imm8: i32) { write_reg8(CH, imm8); }
pub unsafe fn instr_B6(imm8: i32) { write_reg8(DH, imm8); }
pub unsafe fn instr_B7(imm8: i32) { write_reg8(BH, imm8); }
pub unsafe fn instr16_B8(imm: i32) { write_reg16(AX, imm); }
pub unsafe fn instr32_B8(imm: i32) { write_reg32(EAX, imm); }
pub unsafe fn instr16_B9(imm: i32) { write_reg16(CX, imm); }
pub unsafe fn instr32_B9(imm: i32) { write_reg32(ECX, imm); }
pub unsafe fn instr16_BA(imm: i32) { write_reg16(DX, imm); }
pub unsafe fn instr32_BA(imm: i32) { write_reg32(EDX, imm); }
pub unsafe fn instr16_BB(imm: i32) { write_reg16(BX, imm); }
pub unsafe fn instr32_BB(imm: i32) { write_reg32(EBX, imm); }
pub unsafe fn instr16_BC(imm: i32) { write_reg16(SP, imm); }
pub unsafe fn instr32_BC(imm: i32) { write_reg32(ESP, imm); }
pub unsafe fn instr16_BD(imm: i32) { write_reg16(BP, imm); }
pub unsafe fn instr32_BD(imm: i32) { write_reg32(EBP, imm); }
pub unsafe fn instr16_BE(imm: i32) { write_reg16(SI, imm); }
pub unsafe fn instr32_BE(imm: i32) { write_reg32(ESI, imm); }
pub unsafe fn instr16_BF(imm: i32) { write_reg16(DI, imm); }
pub unsafe fn instr32_BF(imm: i32) { write_reg32(EDI, imm); }

pub unsafe fn instr_C0_0_mem(addr: i32, imm: i32) { safe_read_write8(addr, &|x| rol8(x, imm & 31)) }
pub unsafe fn instr_C0_0_reg(r1: i32, imm: i32) { write_reg8(r1, rol8(read_reg8(r1), imm & 31)); }
pub unsafe fn instr_C0_1_mem(addr: i32, imm: i32) { safe_read_write8(addr, &|x| ror8(x, imm & 31)) }
pub unsafe fn instr_C0_1_reg(r1: i32, imm: i32) { write_reg8(r1, ror8(read_reg8(r1), imm & 31)); }
pub unsafe fn instr_C0_2_mem(addr: i32, imm: i32) { safe_read_write8(addr, &|x| rcl8(x, imm & 31)) }
pub unsafe fn instr_C0_2_reg(r1: i32, imm: i32) { write_reg8(r1, rcl8(read_reg8(r1), imm & 31)); }
pub unsafe fn instr_C0_3_mem(addr: i32, imm: i32) { safe_read_write8(addr, &|x| rcr8(x, imm & 31)) }
pub unsafe fn instr_C0_3_reg(r1: i32, imm: i32) { write_reg8(r1, rcr8(read_reg8(r1), imm & 31)); }
pub unsafe fn instr_C0_4_mem(addr: i32, imm: i32) { safe_read_write8(addr, &|x| shl8(x, imm & 31)) }
pub unsafe fn instr_C0_4_reg(r1: i32, imm: i32) { write_reg8(r1, shl8(read_reg8(r1), imm & 31)); }
pub unsafe fn instr_C0_5_mem(addr: i32, imm: i32) { safe_read_write8(addr, &|x| shr8(x, imm & 31)) }
pub unsafe fn instr_C0_5_reg(r1: i32, imm: i32) { write_reg8(r1, shr8(read_reg8(r1), imm & 31)); }
pub unsafe fn instr_C0_6_mem(addr: i32, imm: i32) { safe_read_write8(addr, &|x| shl8(x, imm & 31)) }
pub unsafe fn instr_C0_6_reg(r1: i32, imm: i32) { write_reg8(r1, shl8(read_reg8(r1), imm & 31)); }
pub unsafe fn instr_C0_7_mem(addr: i32, imm: i32) { safe_read_write8(addr, &|x| sar8(x, imm & 31)) }
pub unsafe fn instr_C0_7_reg(r1: i32, imm: i32) { write_reg8(r1, sar8(read_reg8(r1), imm & 31)); }
pub unsafe fn instr16_C1_0_mem(addr: i32, imm: i32) {
    safe_read_write16(addr, &|x| rol16(x, imm & 31))
}
pub unsafe fn instr16_C1_0_reg(r1: i32, imm: i32) {
    write_reg16(r1, rol16(read_reg16(r1), imm & 31));
}
pub unsafe fn instr16_C1_1_mem(addr: i32, imm: i32) {
    safe_read_write16(addr, &|x| ror16(x, imm & 31))
}
pub unsafe fn instr16_C1_1_reg(r1: i32, imm: i32) {
    write_reg16(r1, ror16(read_reg16(r1), imm & 31));
}
pub unsafe fn instr16_C1_2_mem(addr: i32, imm: i32) {
    safe_read_write16(addr, &|x| rcl16(x, imm & 31))
}
pub unsafe fn instr16_C1_2_reg(r1: i32, imm: i32) {
    write_reg16(r1, rcl16(read_reg16(r1), imm & 31));
}
pub unsafe fn instr16_C1_3_mem(addr: i32, imm: i32) {
    safe_read_write16(addr, &|x| rcr16(x, imm & 31))
}
pub unsafe fn instr16_C1_3_reg(r1: i32, imm: i32) {
    write_reg16(r1, rcr16(read_reg16(r1), imm & 31));
}
pub unsafe fn instr16_C1_4_mem(addr: i32, imm: i32) {
    safe_read_write16(addr, &|x| shl16(x, imm & 31))
}
pub unsafe fn instr16_C1_4_reg(r1: i32, imm: i32) {
    write_reg16(r1, shl16(read_reg16(r1), imm & 31));
}
pub unsafe fn instr16_C1_5_mem(addr: i32, imm: i32) {
    safe_read_write16(addr, &|x| shr16(x, imm & 31))
}
pub unsafe fn instr16_C1_5_reg(r1: i32, imm: i32) {
    write_reg16(r1, shr16(read_reg16(r1), imm & 31));
}
pub unsafe fn instr16_C1_6_mem(addr: i32, imm: i32) {
    safe_read_write16(addr, &|x| shl16(x, imm & 31))
}
pub unsafe fn instr16_C1_6_reg(r1: i32, imm: i32) {
    write_reg16(r1, shl16(read_reg16(r1), imm & 31));
}
pub unsafe fn instr16_C1_7_mem(addr: i32, imm: i32) {
    safe_read_write16(addr, &|x| sar16(x, imm & 31))
}
pub unsafe fn instr16_C1_7_reg(r1: i32, imm: i32) {
    write_reg16(r1, sar16(read_reg16(r1), imm & 31));
}
pub unsafe fn instr32_C1_0_mem(addr: i32, imm: i32) {
    safe_read_write32(addr, &|x| rol32(x, imm & 31))
}
pub unsafe fn instr32_C1_0_reg(r1: i32, imm: i32) {
    write_reg32(r1, rol32(read_reg32(r1), imm & 31));
}
pub unsafe fn instr32_C1_1_mem(addr: i32, imm: i32) {
    safe_read_write32(addr, &|x| ror32(x, imm & 31))
}
pub unsafe fn instr32_C1_1_reg(r1: i32, imm: i32) {
    write_reg32(r1, ror32(read_reg32(r1), imm & 31));
}
pub unsafe fn instr32_C1_2_mem(addr: i32, imm: i32) {
    safe_read_write32(addr, &|x| rcl32(x, imm & 31))
}
pub unsafe fn instr32_C1_2_reg(r1: i32, imm: i32) {
    write_reg32(r1, rcl32(read_reg32(r1), imm & 31));
}
pub unsafe fn instr32_C1_3_mem(addr: i32, imm: i32) {
    safe_read_write32(addr, &|x| rcr32(x, imm & 31))
}
pub unsafe fn instr32_C1_3_reg(r1: i32, imm: i32) {
    write_reg32(r1, rcr32(read_reg32(r1), imm & 31));
}
pub unsafe fn instr32_C1_4_mem(addr: i32, imm: i32) {
    safe_read_write32(addr, &|x| shl32(x, imm & 31))
}
pub unsafe fn instr32_C1_4_reg(r1: i32, imm: i32) {
    write_reg32(r1, shl32(read_reg32(r1), imm & 31));
}
pub unsafe fn instr32_C1_5_mem(addr: i32, imm: i32) {
    safe_read_write32(addr, &|x| shr32(x, imm & 31))
}
pub unsafe fn instr32_C1_5_reg(r1: i32, imm: i32) {
    write_reg32(r1, shr32(read_reg32(r1), imm & 31));
}
pub unsafe fn instr32_C1_6_mem(addr: i32, imm: i32) {
    safe_read_write32(addr, &|x| shl32(x, imm & 31))
}
pub unsafe fn instr32_C1_6_reg(r1: i32, imm: i32) {
    write_reg32(r1, shl32(read_reg32(r1), imm & 31));
}
pub unsafe fn instr32_C1_7_mem(addr: i32, imm: i32) {
    safe_read_write32(addr, &|x| sar32(x, imm & 31))
}
pub unsafe fn instr32_C1_7_reg(r1: i32, imm: i32) {
    write_reg32(r1, sar32(read_reg32(r1), imm & 31));
}

pub unsafe fn instr16_C2(imm16: i32) {
    // retn
    let cs = get_seg_cs();
    *instruction_pointer = cs + return_on_pagefault!(pop16());
    dbg_assert!(*is_32 || get_real_eip() < 0x10000);
    adjust_stack_reg(imm16);
}
pub unsafe fn instr32_C2(imm16: i32) {
    // retn
    let cs = get_seg_cs();
    let ip = return_on_pagefault!(pop32s());
    dbg_assert!(*is_32 || ip < 0x10000);
    *instruction_pointer = cs + ip;
    adjust_stack_reg(imm16);
}
pub unsafe fn instr16_C3() {
    // retn
    let cs = get_seg_cs();
    *instruction_pointer = cs + return_on_pagefault!(pop16());
}
pub unsafe fn instr32_C3() {
    // retn
    let cs = get_seg_cs();
    let ip = return_on_pagefault!(pop32s());
    dbg_assert!(*is_32 || ip < 0x10000);
    *instruction_pointer = cs + ip;
}

#[no_mangle]
pub unsafe fn instr16_C4_reg(_unused1: i32, _unused2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr16_C4_mem(addr: i32, r: i32) { lss16(addr, r, ES); }
#[no_mangle]
pub unsafe fn instr32_C4_reg(_unused1: i32, _unused2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr32_C4_mem(addr: i32, r: i32) { lss32(addr, r, ES); }
#[no_mangle]
pub unsafe fn instr16_C5_reg(_unused1: i32, _unused2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr16_C5_mem(addr: i32, r: i32) { lss16(addr, r, DS); }
#[no_mangle]
pub unsafe fn instr32_C5_reg(_unused1: i32, _unused2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr32_C5_mem(addr: i32, r: i32) { lss32(addr, r, DS); }

pub unsafe fn instr_C6_0_reg(r: i32, imm: i32) { write_reg8(r, imm); }
pub unsafe fn instr_C6_0_mem(addr: i32, imm: i32) {
    return_on_pagefault!(safe_write8(addr, imm));
}
pub unsafe fn instr16_C7_0_reg(r: i32, imm: i32) { write_reg16(r, imm); }
pub unsafe fn instr16_C7_0_mem(addr: i32, imm: i32) {
    return_on_pagefault!(safe_write16(addr, imm));
}
pub unsafe fn instr32_C7_0_reg(r: i32, imm: i32) { write_reg32(r, imm); }
pub unsafe fn instr32_C7_0_mem(addr: i32, imm: i32) {
    return_on_pagefault!(safe_write32(addr, imm));
}

#[no_mangle]
pub unsafe fn instr16_C8(size: i32, nesting: i32) { enter16(size, nesting); }
#[no_mangle]
pub unsafe fn instr32_C8(size: i32, nesting: i32) { enter32(size, nesting); }

pub unsafe fn instr16_C9() {
    // leave
    let old_vbp = if *stack_size_32 { read_reg32(EBP) } else { read_reg16(BP) };
    let new_bp = return_on_pagefault!(safe_read16(get_seg_ss() + old_vbp));
    set_stack_reg(old_vbp + 2);
    write_reg16(BP, new_bp);
}
pub unsafe fn instr32_C9() {
    let old_vbp = if *stack_size_32 { read_reg32(EBP) } else { read_reg16(BP) };
    let new_ebp = return_on_pagefault!(safe_read32s(get_seg_ss() + old_vbp));
    set_stack_reg(old_vbp + 4);
    write_reg32(EBP, new_ebp);
}
#[no_mangle]
pub unsafe fn instr16_CA(imm16: i32) {
    // retf
    let ip = return_on_pagefault!(safe_read16(get_stack_pointer(0)));
    let cs = return_on_pagefault!(safe_read16(get_stack_pointer(2)));
    far_return(ip, cs, imm16, false);
}
#[no_mangle]
pub unsafe fn instr32_CA(imm16: i32) {
    // retf
    let ip = return_on_pagefault!(safe_read32s(get_stack_pointer(0)));
    let cs = return_on_pagefault!(safe_read32s(get_stack_pointer(4))) & 0xFFFF;
    far_return(ip, cs, imm16, true);
    dbg_assert!(*is_32 || get_real_eip() < 0x10000);
}
#[no_mangle]
pub unsafe fn instr16_CB() {
    // retf
    let ip = return_on_pagefault!(safe_read16(get_stack_pointer(0)));
    let cs = return_on_pagefault!(safe_read16(get_stack_pointer(2)));
    far_return(ip, cs, 0, false);
    dbg_assert!(*is_32 || get_real_eip() < 0x10000);
}
#[no_mangle]
pub unsafe fn instr32_CB() {
    // retf
    let ip = return_on_pagefault!(safe_read32s(get_stack_pointer(0)));
    let cs = return_on_pagefault!(safe_read32s(get_stack_pointer(4))) & 0xFFFF;
    far_return(ip, cs, 0, true);
    dbg_assert!(*is_32 || get_real_eip() < 0x10000);
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

pub unsafe fn instr_D0_0_mem(addr: i32) { safe_read_write8(addr, &|x| rol8(x, 1)) }
pub unsafe fn instr_D0_0_reg(r1: i32) { write_reg8(r1, rol8(read_reg8(r1), 1)); }
pub unsafe fn instr_D0_1_mem(addr: i32) { safe_read_write8(addr, &|x| ror8(x, 1)) }
pub unsafe fn instr_D0_1_reg(r1: i32) { write_reg8(r1, ror8(read_reg8(r1), 1)); }
pub unsafe fn instr_D0_2_mem(addr: i32) { safe_read_write8(addr, &|x| rcl8(x, 1)) }
pub unsafe fn instr_D0_2_reg(r1: i32) { write_reg8(r1, rcl8(read_reg8(r1), 1)); }
pub unsafe fn instr_D0_3_mem(addr: i32) { safe_read_write8(addr, &|x| rcr8(x, 1)) }
pub unsafe fn instr_D0_3_reg(r1: i32) { write_reg8(r1, rcr8(read_reg8(r1), 1)); }
pub unsafe fn instr_D0_4_mem(addr: i32) { safe_read_write8(addr, &|x| shl8(x, 1)) }
pub unsafe fn instr_D0_4_reg(r1: i32) { write_reg8(r1, shl8(read_reg8(r1), 1)); }
pub unsafe fn instr_D0_5_mem(addr: i32) { safe_read_write8(addr, &|x| shr8(x, 1)) }
pub unsafe fn instr_D0_5_reg(r1: i32) { write_reg8(r1, shr8(read_reg8(r1), 1)); }
pub unsafe fn instr_D0_6_mem(addr: i32) { safe_read_write8(addr, &|x| shl8(x, 1)) }
pub unsafe fn instr_D0_6_reg(r1: i32) { write_reg8(r1, shl8(read_reg8(r1), 1)); }
pub unsafe fn instr_D0_7_mem(addr: i32) { safe_read_write8(addr, &|x| sar8(x, 1)) }
pub unsafe fn instr_D0_7_reg(r1: i32) { write_reg8(r1, sar8(read_reg8(r1), 1)); }
pub unsafe fn instr16_D1_0_mem(addr: i32) { safe_read_write16(addr, &|x| rol16(x, 1)) }
pub unsafe fn instr16_D1_0_reg(r1: i32) { write_reg16(r1, rol16(read_reg16(r1), 1)); }
pub unsafe fn instr16_D1_1_mem(addr: i32) { safe_read_write16(addr, &|x| ror16(x, 1)) }
pub unsafe fn instr16_D1_1_reg(r1: i32) { write_reg16(r1, ror16(read_reg16(r1), 1)); }
pub unsafe fn instr16_D1_2_mem(addr: i32) { safe_read_write16(addr, &|x| rcl16(x, 1)) }
pub unsafe fn instr16_D1_2_reg(r1: i32) { write_reg16(r1, rcl16(read_reg16(r1), 1)); }
pub unsafe fn instr16_D1_3_mem(addr: i32) { safe_read_write16(addr, &|x| rcr16(x, 1)) }
pub unsafe fn instr16_D1_3_reg(r1: i32) { write_reg16(r1, rcr16(read_reg16(r1), 1)); }
pub unsafe fn instr16_D1_4_mem(addr: i32) { safe_read_write16(addr, &|x| shl16(x, 1)) }
pub unsafe fn instr16_D1_4_reg(r1: i32) { write_reg16(r1, shl16(read_reg16(r1), 1)); }
pub unsafe fn instr16_D1_5_mem(addr: i32) { safe_read_write16(addr, &|x| shr16(x, 1)) }
pub unsafe fn instr16_D1_5_reg(r1: i32) { write_reg16(r1, shr16(read_reg16(r1), 1)); }
pub unsafe fn instr16_D1_6_mem(addr: i32) { safe_read_write16(addr, &|x| shl16(x, 1)) }
pub unsafe fn instr16_D1_6_reg(r1: i32) { write_reg16(r1, shl16(read_reg16(r1), 1)); }
pub unsafe fn instr16_D1_7_mem(addr: i32) { safe_read_write16(addr, &|x| sar16(x, 1)) }
pub unsafe fn instr16_D1_7_reg(r1: i32) { write_reg16(r1, sar16(read_reg16(r1), 1)); }
pub unsafe fn instr32_D1_0_mem(addr: i32) { safe_read_write32(addr, &|x| rol32(x, 1)) }
pub unsafe fn instr32_D1_0_reg(r1: i32) { write_reg32(r1, rol32(read_reg32(r1), 1)); }
pub unsafe fn instr32_D1_1_mem(addr: i32) { safe_read_write32(addr, &|x| ror32(x, 1)) }
pub unsafe fn instr32_D1_1_reg(r1: i32) { write_reg32(r1, ror32(read_reg32(r1), 1)); }
pub unsafe fn instr32_D1_2_mem(addr: i32) { safe_read_write32(addr, &|x| rcl32(x, 1)) }
pub unsafe fn instr32_D1_2_reg(r1: i32) { write_reg32(r1, rcl32(read_reg32(r1), 1)); }
pub unsafe fn instr32_D1_3_mem(addr: i32) { safe_read_write32(addr, &|x| rcr32(x, 1)) }
pub unsafe fn instr32_D1_3_reg(r1: i32) { write_reg32(r1, rcr32(read_reg32(r1), 1)); }
pub unsafe fn instr32_D1_4_mem(addr: i32) { safe_read_write32(addr, &|x| shl32(x, 1)) }
pub unsafe fn instr32_D1_4_reg(r1: i32) { write_reg32(r1, shl32(read_reg32(r1), 1)); }
pub unsafe fn instr32_D1_5_mem(addr: i32) { safe_read_write32(addr, &|x| shr32(x, 1)) }
pub unsafe fn instr32_D1_5_reg(r1: i32) { write_reg32(r1, shr32(read_reg32(r1), 1)); }
pub unsafe fn instr32_D1_6_mem(addr: i32) { safe_read_write32(addr, &|x| shl32(x, 1)) }
pub unsafe fn instr32_D1_6_reg(r1: i32) { write_reg32(r1, shl32(read_reg32(r1), 1)); }
pub unsafe fn instr32_D1_7_mem(addr: i32) { safe_read_write32(addr, &|x| sar32(x, 1)) }
pub unsafe fn instr32_D1_7_reg(r1: i32) { write_reg32(r1, sar32(read_reg32(r1), 1)); }
pub unsafe fn instr_D2_0_mem(addr: i32) { safe_read_write8(addr, &|x| rol8(x, read_reg8(CL) & 31)) }
pub unsafe fn instr_D2_0_reg(r1: i32) { write_reg8(r1, rol8(read_reg8(r1), read_reg8(CL) & 31)); }
pub unsafe fn instr_D2_1_mem(addr: i32) { safe_read_write8(addr, &|x| ror8(x, read_reg8(CL) & 31)) }
pub unsafe fn instr_D2_1_reg(r1: i32) { write_reg8(r1, ror8(read_reg8(r1), read_reg8(CL) & 31)); }
pub unsafe fn instr_D2_2_mem(addr: i32) { safe_read_write8(addr, &|x| rcl8(x, read_reg8(CL) & 31)) }
pub unsafe fn instr_D2_2_reg(r1: i32) { write_reg8(r1, rcl8(read_reg8(r1), read_reg8(CL) & 31)); }
pub unsafe fn instr_D2_3_mem(addr: i32) { safe_read_write8(addr, &|x| rcr8(x, read_reg8(CL) & 31)) }
pub unsafe fn instr_D2_3_reg(r1: i32) { write_reg8(r1, rcr8(read_reg8(r1), read_reg8(CL) & 31)); }
pub unsafe fn instr_D2_4_mem(addr: i32) { safe_read_write8(addr, &|x| shl8(x, read_reg8(CL) & 31)) }
pub unsafe fn instr_D2_4_reg(r1: i32) { write_reg8(r1, shl8(read_reg8(r1), read_reg8(CL) & 31)); }
pub unsafe fn instr_D2_5_mem(addr: i32) { safe_read_write8(addr, &|x| shr8(x, read_reg8(CL) & 31)) }
pub unsafe fn instr_D2_5_reg(r1: i32) { write_reg8(r1, shr8(read_reg8(r1), read_reg8(CL) & 31)); }
pub unsafe fn instr_D2_6_mem(addr: i32) { safe_read_write8(addr, &|x| shl8(x, read_reg8(CL) & 31)) }
pub unsafe fn instr_D2_6_reg(r1: i32) { write_reg8(r1, shl8(read_reg8(r1), read_reg8(CL) & 31)); }
pub unsafe fn instr_D2_7_mem(addr: i32) { safe_read_write8(addr, &|x| sar8(x, read_reg8(CL) & 31)) }
pub unsafe fn instr_D2_7_reg(r1: i32) { write_reg8(r1, sar8(read_reg8(r1), read_reg8(CL) & 31)); }
pub unsafe fn instr16_D3_0_mem(addr: i32) {
    safe_read_write16(addr, &|x| rol16(x, read_reg8(CL) & 31))
}
pub unsafe fn instr16_D3_0_reg(r1: i32) {
    write_reg16(r1, rol16(read_reg16(r1), read_reg8(CL) & 31));
}
pub unsafe fn instr16_D3_1_mem(addr: i32) {
    safe_read_write16(addr, &|x| ror16(x, read_reg8(CL) & 31))
}
pub unsafe fn instr16_D3_1_reg(r1: i32) {
    write_reg16(r1, ror16(read_reg16(r1), read_reg8(CL) & 31));
}
pub unsafe fn instr16_D3_2_mem(addr: i32) {
    safe_read_write16(addr, &|x| rcl16(x, read_reg8(CL) & 31))
}
pub unsafe fn instr16_D3_2_reg(r1: i32) {
    write_reg16(r1, rcl16(read_reg16(r1), read_reg8(CL) & 31));
}
pub unsafe fn instr16_D3_3_mem(addr: i32) {
    safe_read_write16(addr, &|x| rcr16(x, read_reg8(CL) & 31))
}
pub unsafe fn instr16_D3_3_reg(r1: i32) {
    write_reg16(r1, rcr16(read_reg16(r1), read_reg8(CL) & 31));
}
pub unsafe fn instr16_D3_4_mem(addr: i32) {
    safe_read_write16(addr, &|x| shl16(x, read_reg8(CL) & 31))
}
pub unsafe fn instr16_D3_4_reg(r1: i32) {
    write_reg16(r1, shl16(read_reg16(r1), read_reg8(CL) & 31));
}
pub unsafe fn instr16_D3_5_mem(addr: i32) {
    safe_read_write16(addr, &|x| shr16(x, read_reg8(CL) & 31))
}
pub unsafe fn instr16_D3_5_reg(r1: i32) {
    write_reg16(r1, shr16(read_reg16(r1), read_reg8(CL) & 31));
}
pub unsafe fn instr16_D3_6_mem(addr: i32) {
    safe_read_write16(addr, &|x| shl16(x, read_reg8(CL) & 31))
}
pub unsafe fn instr16_D3_6_reg(r1: i32) {
    write_reg16(r1, shl16(read_reg16(r1), read_reg8(CL) & 31));
}
pub unsafe fn instr16_D3_7_mem(addr: i32) {
    safe_read_write16(addr, &|x| sar16(x, read_reg8(CL) & 31))
}
pub unsafe fn instr16_D3_7_reg(r1: i32) {
    write_reg16(r1, sar16(read_reg16(r1), read_reg8(CL) & 31));
}
pub unsafe fn instr32_D3_0_mem(addr: i32) {
    safe_read_write32(addr, &|x| rol32(x, read_reg8(CL) & 31))
}
pub unsafe fn instr32_D3_0_reg(r1: i32) {
    write_reg32(r1, rol32(read_reg32(r1), read_reg8(CL) & 31));
}
pub unsafe fn instr32_D3_1_mem(addr: i32) {
    safe_read_write32(addr, &|x| ror32(x, read_reg8(CL) & 31))
}
pub unsafe fn instr32_D3_1_reg(r1: i32) {
    write_reg32(r1, ror32(read_reg32(r1), read_reg8(CL) & 31));
}
pub unsafe fn instr32_D3_2_mem(addr: i32) {
    safe_read_write32(addr, &|x| rcl32(x, read_reg8(CL) & 31))
}
pub unsafe fn instr32_D3_2_reg(r1: i32) {
    write_reg32(r1, rcl32(read_reg32(r1), read_reg8(CL) & 31));
}
pub unsafe fn instr32_D3_3_mem(addr: i32) {
    safe_read_write32(addr, &|x| rcr32(x, read_reg8(CL) & 31))
}
pub unsafe fn instr32_D3_3_reg(r1: i32) {
    write_reg32(r1, rcr32(read_reg32(r1), read_reg8(CL) & 31));
}
pub unsafe fn instr32_D3_4_mem(addr: i32) {
    safe_read_write32(addr, &|x| shl32(x, read_reg8(CL) & 31))
}
pub unsafe fn instr32_D3_4_reg(r1: i32) {
    write_reg32(r1, shl32(read_reg32(r1), read_reg8(CL) & 31));
}
pub unsafe fn instr32_D3_5_mem(addr: i32) {
    safe_read_write32(addr, &|x| shr32(x, read_reg8(CL) & 31))
}
pub unsafe fn instr32_D3_5_reg(r1: i32) {
    write_reg32(r1, shr32(read_reg32(r1), read_reg8(CL) & 31));
}
pub unsafe fn instr32_D3_6_mem(addr: i32) {
    safe_read_write32(addr, &|x| shl32(x, read_reg8(CL) & 31))
}
pub unsafe fn instr32_D3_6_reg(r1: i32) {
    write_reg32(r1, shl32(read_reg32(r1), read_reg8(CL) & 31));
}
pub unsafe fn instr32_D3_7_mem(addr: i32) {
    safe_read_write32(addr, &|x| sar32(x, read_reg8(CL) & 31))
}
pub unsafe fn instr32_D3_7_reg(r1: i32) {
    write_reg32(r1, sar32(read_reg32(r1), read_reg8(CL) & 31));
}

#[no_mangle]
pub unsafe fn instr_D4(arg: i32) { bcd_aam(arg); }
#[no_mangle]
pub unsafe fn instr_D5(arg: i32) { bcd_aad(arg); }
#[no_mangle]
pub unsafe fn instr_D6() {
    // salc
    write_reg8(AL, -(getcf() as i32));
}
pub unsafe fn instr_D7() {
    // xlat
    dbg_assert!(!in_jit);
    if is_asize_32() {
        write_reg8(
            AL,
            return_on_pagefault!(safe_read8(
                return_on_pagefault!(get_seg_prefix(DS)) + read_reg32(EBX) + read_reg8(AL),
            )),
        )
    }
    else {
        write_reg8(
            AL,
            return_on_pagefault!(safe_read8(
                return_on_pagefault!(get_seg_prefix(DS))
                    + (read_reg16(BX) + read_reg8(AL) & 0xFFFF),
            )),
        )
    };
}

pub unsafe fn instr_D8_0_mem(addr: i32) { fpu_fadd(0, return_on_pagefault!(fpu_load_m32(addr))); }
pub unsafe fn instr_D8_0_reg(r: i32) { fpu_fadd(0, fpu_get_sti(r)); }
pub unsafe fn instr_D8_1_mem(addr: i32) { fpu_fmul(0, return_on_pagefault!(fpu_load_m32(addr))); }
pub unsafe fn instr_D8_1_reg(r: i32) { fpu_fmul(0, fpu_get_sti(r)); }
pub unsafe fn instr_D8_2_mem(addr: i32) { fpu_fcom(return_on_pagefault!(fpu_load_m32(addr))); }
pub unsafe fn instr_D8_2_reg(r: i32) { fpu_fcom(fpu_get_sti(r)); }
pub unsafe fn instr_D8_3_mem(addr: i32) { fpu_fcomp(return_on_pagefault!(fpu_load_m32(addr))); }
pub unsafe fn instr_D8_3_reg(r: i32) { fpu_fcomp(fpu_get_sti(r)); }
pub unsafe fn instr_D8_4_mem(addr: i32) { fpu_fsub(0, return_on_pagefault!(fpu_load_m32(addr))); }
pub unsafe fn instr_D8_4_reg(r: i32) { fpu_fsub(0, fpu_get_sti(r)); }
pub unsafe fn instr_D8_5_mem(addr: i32) { fpu_fsubr(0, return_on_pagefault!(fpu_load_m32(addr))); }
pub unsafe fn instr_D8_5_reg(r: i32) { fpu_fsubr(0, fpu_get_sti(r)); }
pub unsafe fn instr_D8_6_mem(addr: i32) { fpu_fdiv(0, return_on_pagefault!(fpu_load_m32(addr))); }
pub unsafe fn instr_D8_6_reg(r: i32) { fpu_fdiv(0, fpu_get_sti(r)); }
pub unsafe fn instr_D8_7_mem(addr: i32) { fpu_fdivr(0, return_on_pagefault!(fpu_load_m32(addr))); }
pub unsafe fn instr_D8_7_reg(r: i32) { fpu_fdivr(0, fpu_get_sti(r)); }

pub unsafe fn instr16_D9_0_mem(addr: i32) { fpu_fldm32(addr); }
pub unsafe fn instr16_D9_0_reg(r: i32) { fpu_push(fpu_get_sti(r)); }
pub unsafe fn instr16_D9_1_mem(_addr: i32) {
    dbg_log!("d9/1");
    trigger_ud();
}
pub unsafe fn instr16_D9_1_reg(r: i32) { fpu_fxch(r); }
pub unsafe fn instr16_D9_2_mem(addr: i32) { fpu_fstm32(addr); }
pub unsafe fn instr16_D9_2_reg(r: i32) {
    if r != 0 {
        trigger_ud();
    };
}
pub unsafe fn instr16_D9_3_mem(addr: i32) { fpu_fstm32p(addr); }
pub unsafe fn instr16_D9_3_reg(r: i32) { fpu_fstp(r) }
#[no_mangle]
pub unsafe fn instr16_D9_4_mem(addr: i32) { fpu_fldenv16(addr); }
pub unsafe fn instr32_D9_4_mem(addr: i32) { fpu_fldenv32(addr); }
#[no_mangle]
pub unsafe fn instr16_D9_4_reg(r: i32) {
    match r {
        0 => fpu_fchs(),
        1 => fpu_fabs(),
        4 => fpu_ftst(),
        5 => fpu_fxam(),
        _ => {
            dbg_log!("{:x}", r);
            trigger_ud();
        },
    };
}
#[no_mangle]
pub unsafe fn instr16_D9_5_mem(addr: i32) { fpu_fldcw(addr); }
#[no_mangle]
pub unsafe fn instr16_D9_5_reg(r: i32) {
    // fld1/fldl2t/fldl2e/fldpi/fldlg2/fldln2/fldz
    match r {
        0 => fpu_push(F80::ONE),
        1 => fpu_push(F80::LN_10 / F80::LN_2),
        2 => fpu_push(F80::LOG2_E),
        3 => fpu_push(F80::PI),
        4 => fpu_push(F80::LN_2 / F80::LN_10),
        5 => fpu_push(F80::LN_2),
        6 => fpu_push(F80::ZERO),
        7 => {
            dbg_log!("d9/5/7");
            trigger_ud();
        },
        _ => {},
    };
}
pub unsafe fn instr16_D9_6_mem(addr: i32) { fpu_fstenv16(addr); }
pub unsafe fn instr32_D9_6_mem(addr: i32) { fpu_fstenv32(addr); }
#[no_mangle]
pub unsafe fn instr16_D9_6_reg(r: i32) {
    match r {
        0 => fpu_f2xm1(),
        1 => fpu_fyl2x(),
        2 => fpu_fptan(),
        3 => fpu_fpatan(),
        4 => fpu_fxtract(),
        5 => fpu_fprem(true), // fprem1
        6 => fpu_fdecstp(),
        7 => fpu_fincstp(),
        _ => {
            dbg_assert!(false);
        },
    };
}
pub unsafe fn instr16_D9_7_mem(addr: i32) { fpu_fstcw(addr); }
#[no_mangle]
pub unsafe fn instr16_D9_7_reg(r: i32) {
    match r {
        0 => fpu_fprem(false),
        1 => fpu_fyl2xp1(),
        2 => fpu_fsqrt(),
        3 => fpu_fsincos(),
        4 => fpu_frndint(),
        5 => fpu_fscale(),
        6 => fpu_fsin(),
        7 => fpu_fcos(),
        _ => {
            dbg_assert!(false);
        },
    };
}

pub unsafe fn instr32_D9_0_reg(r: i32) { instr16_D9_0_reg(r) }
pub unsafe fn instr32_D9_1_reg(r: i32) { instr16_D9_1_reg(r) }
pub unsafe fn instr32_D9_2_reg(r: i32) { instr16_D9_2_reg(r) }
pub unsafe fn instr32_D9_3_reg(r: i32) { instr16_D9_3_reg(r) }
pub unsafe fn instr32_D9_4_reg(r: i32) { instr16_D9_4_reg(r) }
pub unsafe fn instr32_D9_5_reg(r: i32) { instr16_D9_5_reg(r) }
pub unsafe fn instr32_D9_6_reg(r: i32) { instr16_D9_6_reg(r) }
pub unsafe fn instr32_D9_7_reg(r: i32) { instr16_D9_7_reg(r) }

pub unsafe fn instr32_D9_0_mem(r: i32) { instr16_D9_0_mem(r) }
pub unsafe fn instr32_D9_1_mem(r: i32) { instr16_D9_1_mem(r) }
pub unsafe fn instr32_D9_2_mem(r: i32) { instr16_D9_2_mem(r) }
pub unsafe fn instr32_D9_3_mem(r: i32) { instr16_D9_3_mem(r) }
pub unsafe fn instr32_D9_5_mem(r: i32) { instr16_D9_5_mem(r) }
pub unsafe fn instr32_D9_7_mem(r: i32) { instr16_D9_7_mem(r) }

pub unsafe fn instr_DA_0_mem(addr: i32) { fpu_fadd(0, return_on_pagefault!(fpu_load_i32(addr))); }
pub unsafe fn instr_DA_1_mem(addr: i32) { fpu_fmul(0, return_on_pagefault!(fpu_load_i32(addr))); }
pub unsafe fn instr_DA_2_mem(addr: i32) { fpu_fcom(return_on_pagefault!(fpu_load_i32(addr))); }
pub unsafe fn instr_DA_3_mem(addr: i32) { fpu_fcomp(return_on_pagefault!(fpu_load_i32(addr))); }
pub unsafe fn instr_DA_4_mem(addr: i32) { fpu_fsub(0, return_on_pagefault!(fpu_load_i32(addr))); }
pub unsafe fn instr_DA_5_mem(addr: i32) { fpu_fsubr(0, return_on_pagefault!(fpu_load_i32(addr))); }
pub unsafe fn instr_DA_6_mem(addr: i32) { fpu_fdiv(0, return_on_pagefault!(fpu_load_i32(addr))); }
pub unsafe fn instr_DA_7_mem(addr: i32) { fpu_fdivr(0, return_on_pagefault!(fpu_load_i32(addr))); }
#[no_mangle]
pub unsafe fn instr_DA_0_reg(r: i32) { fpu_fcmovcc(test_b(), r); }
#[no_mangle]
pub unsafe fn instr_DA_1_reg(r: i32) { fpu_fcmovcc(test_z(), r); }
#[no_mangle]
pub unsafe fn instr_DA_2_reg(r: i32) { fpu_fcmovcc(test_be(), r); }
#[no_mangle]
pub unsafe fn instr_DA_3_reg(r: i32) { fpu_fcmovcc(test_p(), r); }
pub unsafe fn instr_DA_4_reg(_r: i32) { trigger_ud(); }
pub unsafe fn instr_DA_5_reg(r: i32) {
    if r == 1 {
        fpu_fucompp();
    }
    else {
        trigger_ud();
    };
}
pub unsafe fn instr_DA_6_reg(_r: i32) { trigger_ud(); }
pub unsafe fn instr_DA_7_reg(_r: i32) { trigger_ud(); }

pub unsafe fn instr_DB_0_mem(addr: i32) { fpu_fildm32(addr); }
pub unsafe fn instr_DB_1_mem(addr: i32) { fpu_fisttpm32(addr); }
pub unsafe fn instr_DB_2_mem(addr: i32) { fpu_fistm32(addr); }
pub unsafe fn instr_DB_3_mem(addr: i32) { fpu_fistm32p(addr); }
#[no_mangle]
pub unsafe fn instr_DB_4_mem(_addr: i32) { trigger_ud(); }
pub unsafe fn instr_DB_5_mem(addr: i32) { fpu_fldm80(addr); }
pub unsafe fn instr_DB_6_mem(_addr: i32) { trigger_ud(); }
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
pub unsafe fn instr_DB_5_reg(r: i32) { fpu_fucomi(r); }
pub unsafe fn instr_DB_6_reg(r: i32) { fpu_fcomi(r); }
#[no_mangle]
pub unsafe fn instr_DB_7_reg(_r: i32) { trigger_ud(); }

pub unsafe fn instr_DC_0_mem(addr: i32) { fpu_fadd(0, return_on_pagefault!(fpu_load_m64(addr))); }
pub unsafe fn instr_DC_1_mem(addr: i32) { fpu_fmul(0, return_on_pagefault!(fpu_load_m64(addr))); }
pub unsafe fn instr_DC_2_mem(addr: i32) { fpu_fcom(return_on_pagefault!(fpu_load_m64(addr))); }
pub unsafe fn instr_DC_3_mem(addr: i32) { fpu_fcomp(return_on_pagefault!(fpu_load_m64(addr))); }
pub unsafe fn instr_DC_4_mem(addr: i32) { fpu_fsub(0, return_on_pagefault!(fpu_load_m64(addr))); }
pub unsafe fn instr_DC_5_mem(addr: i32) { fpu_fsubr(0, return_on_pagefault!(fpu_load_m64(addr))); }
pub unsafe fn instr_DC_6_mem(addr: i32) { fpu_fdiv(0, return_on_pagefault!(fpu_load_m64(addr))); }
pub unsafe fn instr_DC_7_mem(addr: i32) { fpu_fdivr(0, return_on_pagefault!(fpu_load_m64(addr))); }
pub unsafe fn instr_DC_0_reg(r: i32) { fpu_fadd(r, fpu_get_sti(r)); }
pub unsafe fn instr_DC_1_reg(r: i32) { fpu_fmul(r, fpu_get_sti(r)); }
pub unsafe fn instr_DC_2_reg(r: i32) { fpu_fcom(fpu_get_sti(r)); }
pub unsafe fn instr_DC_3_reg(r: i32) { fpu_fcomp(fpu_get_sti(r)); }
pub unsafe fn instr_DC_4_reg(r: i32) { fpu_fsub(r, fpu_get_sti(r)); }
pub unsafe fn instr_DC_5_reg(r: i32) { fpu_fsubr(r, fpu_get_sti(r)); }
pub unsafe fn instr_DC_6_reg(r: i32) { fpu_fdiv(r, fpu_get_sti(r)); }
pub unsafe fn instr_DC_7_reg(r: i32) { fpu_fdivr(r, fpu_get_sti(r)); }

pub unsafe fn instr16_DD_0_mem(addr: i32) { fpu_fldm64(addr); }
pub unsafe fn instr16_DD_1_mem(addr: i32) { fpu_fisttpm64(addr); }
pub unsafe fn instr16_DD_2_mem(addr: i32) { fpu_fstm64(addr); }
pub unsafe fn instr16_DD_3_mem(addr: i32) { fpu_fstm64p(addr); }
#[no_mangle]
pub unsafe fn instr16_DD_4_mem(addr: i32) { fpu_frstor16(addr); }
#[no_mangle]
pub unsafe fn instr32_DD_4_mem(addr: i32) { fpu_frstor32(addr); }
pub unsafe fn instr16_DD_5_mem(_addr: i32) {
    dbg_log!("dd/5");
    trigger_ud();
}
#[no_mangle]
pub unsafe fn instr16_DD_6_mem(addr: i32) { fpu_fsave16(addr); }
#[no_mangle]
pub unsafe fn instr32_DD_6_mem(addr: i32) { fpu_fsave32(addr); }
#[no_mangle]
pub unsafe fn instr16_DD_7_mem(addr: i32) { fpu_fnstsw_mem(addr); }
pub unsafe fn instr16_DD_0_reg(r: i32) { fpu_ffree(r); }
pub unsafe fn instr16_DD_1_reg(r: i32) { fpu_fxch(r) }
pub unsafe fn instr16_DD_2_reg(r: i32) { fpu_fst(r); }
pub unsafe fn instr16_DD_3_reg(r: i32) { fpu_fstp(r); }
#[no_mangle]
pub unsafe fn instr16_DD_4_reg(r: i32) { fpu_fucom(r); }
pub unsafe fn instr16_DD_5_reg(r: i32) { fpu_fucomp(r); }
#[no_mangle]
pub unsafe fn instr16_DD_6_reg(_r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr16_DD_7_reg(_r: i32) { trigger_ud(); }

pub unsafe fn instr32_DD_0_reg(r: i32) { instr16_DD_0_reg(r) }
#[no_mangle]
pub unsafe fn instr32_DD_1_reg(r: i32) { instr16_DD_1_reg(r) }
pub unsafe fn instr32_DD_2_reg(r: i32) { instr16_DD_2_reg(r) }
pub unsafe fn instr32_DD_3_reg(r: i32) { instr16_DD_3_reg(r) }
#[no_mangle]
pub unsafe fn instr32_DD_4_reg(r: i32) { instr16_DD_4_reg(r) }
pub unsafe fn instr32_DD_5_reg(r: i32) { instr16_DD_5_reg(r) }
#[no_mangle]
pub unsafe fn instr32_DD_6_reg(r: i32) { instr16_DD_6_reg(r) }
#[no_mangle]
pub unsafe fn instr32_DD_7_reg(r: i32) { instr16_DD_7_reg(r) }

pub unsafe fn instr32_DD_0_mem(r: i32) { instr16_DD_0_mem(r) }
#[no_mangle]
pub unsafe fn instr32_DD_1_mem(r: i32) { instr16_DD_1_mem(r) }
pub unsafe fn instr32_DD_2_mem(r: i32) { instr16_DD_2_mem(r) }
pub unsafe fn instr32_DD_3_mem(r: i32) { instr16_DD_3_mem(r) }
pub unsafe fn instr32_DD_5_mem(r: i32) { instr16_DD_5_mem(r) }
#[no_mangle]
pub unsafe fn instr32_DD_7_mem(r: i32) { instr16_DD_7_mem(r) }

#[no_mangle]
pub unsafe fn instr_DE_0_mem(addr: i32) { fpu_fadd(0, return_on_pagefault!(fpu_load_i16(addr))); }
#[no_mangle]
pub unsafe fn instr_DE_1_mem(addr: i32) { fpu_fmul(0, return_on_pagefault!(fpu_load_i16(addr))); }
#[no_mangle]
pub unsafe fn instr_DE_2_mem(addr: i32) { fpu_fcom(return_on_pagefault!(fpu_load_i16(addr))); }
#[no_mangle]
pub unsafe fn instr_DE_3_mem(addr: i32) { fpu_fcomp(return_on_pagefault!(fpu_load_i16(addr))); }
#[no_mangle]
pub unsafe fn instr_DE_4_mem(addr: i32) { fpu_fsub(0, return_on_pagefault!(fpu_load_i16(addr))); }
#[no_mangle]
pub unsafe fn instr_DE_5_mem(addr: i32) { fpu_fsubr(0, return_on_pagefault!(fpu_load_i16(addr))); }
#[no_mangle]
pub unsafe fn instr_DE_6_mem(addr: i32) { fpu_fdiv(0, return_on_pagefault!(fpu_load_i16(addr))); }
#[no_mangle]
pub unsafe fn instr_DE_7_mem(addr: i32) { fpu_fdivr(0, return_on_pagefault!(fpu_load_i16(addr))); }

#[no_mangle]
pub unsafe fn instr_DE_0_reg(r: i32) {
    fpu_fadd(r, fpu_get_sti(r));
    fpu_pop();
}
pub unsafe fn instr_DE_1_reg(r: i32) {
    fpu_fmul(r, fpu_get_sti(r));
    fpu_pop();
}
pub unsafe fn instr_DE_2_reg(r: i32) {
    fpu_fcom(fpu_get_sti(r));
    fpu_pop();
}
pub unsafe fn instr_DE_3_reg(r: i32) {
    if r == 1 {
        fpu_fcomp(fpu_get_sti(r));
        fpu_pop();
    }
    else {
        trigger_ud();
    }
}
pub unsafe fn instr_DE_4_reg(r: i32) {
    fpu_fsub(r, fpu_get_sti(r));
    fpu_pop();
}
pub unsafe fn instr_DE_5_reg(r: i32) {
    fpu_fsubr(r, fpu_get_sti(r));
    fpu_pop();
}
pub unsafe fn instr_DE_6_reg(r: i32) {
    fpu_fdiv(r, fpu_get_sti(r));
    fpu_pop();
}
pub unsafe fn instr_DE_7_reg(r: i32) {
    fpu_fdivr(r, fpu_get_sti(r));
    fpu_pop();
}

#[no_mangle]
pub unsafe fn instr_DF_0_mem(addr: i32) { fpu_fildm16(addr) }
pub unsafe fn instr_DF_1_mem(addr: i32) { fpu_fisttpm16(addr); }
pub unsafe fn instr_DF_2_mem(addr: i32) { fpu_fistm16(addr); }
pub unsafe fn instr_DF_3_mem(addr: i32) { fpu_fistm16p(addr); }
pub unsafe fn instr_DF_4_mem(_addr: i32) {
    dbg_log!("fbld");
    fpu_unimpl();
}
pub unsafe fn instr_DF_5_mem(addr: i32) { fpu_fildm64(addr); }
pub unsafe fn instr_DF_6_mem(addr: i32) { fpu_fbstp(addr); }
pub unsafe fn instr_DF_7_mem(addr: i32) { fpu_fistm64p(addr); }

#[no_mangle]
pub unsafe fn instr_DF_0_reg(r: i32) {
    fpu_ffree(r);
    fpu_pop();
}
pub unsafe fn instr_DF_1_reg(r: i32) { fpu_fxch(r) }
pub unsafe fn instr_DF_2_reg(r: i32) { fpu_fstp(r); }
pub unsafe fn instr_DF_3_reg(r: i32) { fpu_fstp(r); }
pub unsafe fn instr_DF_4_reg(r: i32) {
    if r == 0 {
        fpu_fnstsw_reg();
    }
    else {
        trigger_ud();
    };
}
pub unsafe fn instr_DF_5_reg(r: i32) { fpu_fucomip(r); }
pub unsafe fn instr_DF_6_reg(r: i32) { fpu_fcomip(r); }
pub unsafe fn instr_DF_7_reg(_r: i32) { trigger_ud(); }

pub unsafe fn instr16_E0(imm8s: i32) { loopne16(imm8s); }
pub unsafe fn instr16_E1(imm8s: i32) { loope16(imm8s); }
pub unsafe fn instr16_E2(imm8s: i32) { loop16(imm8s); }
pub unsafe fn instr16_E3(imm8s: i32) { jcxz16(imm8s); }
pub unsafe fn instr32_E0(imm8s: i32) { loopne32(imm8s); }
pub unsafe fn instr32_E1(imm8s: i32) { loope32(imm8s); }
pub unsafe fn instr32_E2(imm8s: i32) { loop32(imm8s); }
pub unsafe fn instr32_E3(imm8s: i32) { jcxz32(imm8s); }

#[no_mangle]
pub unsafe fn instr_E4(port: i32) {
    if test_privileges_for_io(port, 1) {
        write_reg8(AL, io_port_read8(port));
    }
}
#[no_mangle]
pub unsafe fn instr16_E5(port: i32) {
    if test_privileges_for_io(port, 2) {
        write_reg16(AX, io_port_read16(port));
    }
}
#[no_mangle]
pub unsafe fn instr32_E5(port: i32) {
    if test_privileges_for_io(port, 4) {
        write_reg32(EAX, io_port_read32(port));
    }
}
#[no_mangle]
pub unsafe fn instr_E6(port: i32) {
    if test_privileges_for_io(port, 1) {
        io_port_write8(port, read_reg8(AL));
    }
}
#[no_mangle]
pub unsafe fn instr16_E7(port: i32) {
    if test_privileges_for_io(port, 2) {
        io_port_write16(port, read_reg16(AX));
    }
}
#[no_mangle]
pub unsafe fn instr32_E7(port: i32) {
    if test_privileges_for_io(port, 4) {
        io_port_write32(port, read_reg32(EAX));
    }
}

pub unsafe fn instr16_E8(imm16: i32) {
    // call
    return_on_pagefault!(push16(get_real_eip()));
    jmp_rel16(imm16);
}
pub unsafe fn instr32_E8(imm32s: i32) {
    // call
    return_on_pagefault!(push32(get_real_eip()));
    *instruction_pointer = *instruction_pointer + imm32s;
    dbg_assert!(*is_32 || get_real_eip() < 0x10000);
}
pub unsafe fn instr16_E9(imm16: i32) {
    // jmp
    jmp_rel16(imm16);
}
pub unsafe fn instr32_E9(imm32s: i32) {
    // jmp
    *instruction_pointer = *instruction_pointer + imm32s;
    dbg_assert!(*is_32 || get_real_eip() < 0x10000);
}

#[no_mangle]
pub unsafe fn instr16_EA(new_ip: i32, cs: i32) {
    // jmpf
    far_jump(new_ip, cs, false, false);
}
#[no_mangle]
pub unsafe fn instr32_EA(new_ip: i32, cs: i32) {
    // jmpf
    far_jump(new_ip, cs, false, true);
}

pub unsafe fn instr16_EB(imm8: i32) {
    // jmp near
    jmp_rel16(imm8);
    dbg_assert!(*is_32 || get_real_eip() < 0x10000);
}
pub unsafe fn instr32_EB(imm8: i32) {
    // jmp near
    *instruction_pointer = *instruction_pointer + imm8;
    dbg_assert!(*is_32 || get_real_eip() < 0x10000);
}

#[no_mangle]
pub unsafe fn instr_EC() {
    let port = read_reg16(DX);
    if test_privileges_for_io(port, 1) {
        write_reg8(AL, io_port_read8(port));
    }
}
#[no_mangle]
pub unsafe fn instr16_ED() {
    let port = read_reg16(DX);
    if test_privileges_for_io(port, 2) {
        write_reg16(AX, io_port_read16(port));
    }
}
#[no_mangle]
pub unsafe fn instr32_ED() {
    let port = read_reg16(DX);
    if test_privileges_for_io(port, 4) {
        write_reg32(EAX, io_port_read32(port));
    }
}
#[no_mangle]
pub unsafe fn instr_EE() {
    let port = read_reg16(DX);
    if test_privileges_for_io(port, 1) {
        io_port_write8(port, read_reg8(AL));
    }
}
#[no_mangle]
pub unsafe fn instr16_EF() {
    let port = read_reg16(DX);
    if test_privileges_for_io(port, 2) {
        io_port_write16(port, read_reg16(AX));
    }
}
#[no_mangle]
pub unsafe fn instr32_EF() {
    let port = read_reg16(DX);
    if test_privileges_for_io(port, 4) {
        io_port_write32(port, read_reg32(EAX));
    }
}

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

pub unsafe fn instr_F2() {
    // repnz
    dbg_assert!(*prefixes & prefix::PREFIX_MASK_REP == 0);
    *prefixes |= prefix::PREFIX_REPNZ;
    run_prefix_instruction();
    *prefixes = 0;
}
pub unsafe fn instr_F3() {
    // repz
    dbg_assert!(*prefixes & prefix::PREFIX_MASK_REP == 0);
    *prefixes |= prefix::PREFIX_REPZ;
    run_prefix_instruction();
    *prefixes = 0;
}

#[no_mangle]
pub unsafe fn instr_F4() {
    if 0 != *cpl {
        dbg_log!("#gp hlt with cpl != 0");
        trigger_gp(0);
        return;
    }

    *in_hlt = true;

    // Try an hlt loop right now: This will run timer interrupts, and if one is
    // due it will immediately call call_interrupt_vector and continue
    // execution without an unnecessary cycle through do_run
    if *flags & FLAG_INTERRUPT != 0 {
        js::run_hardware_timers(*acpi_enabled, js::microtick());
        handle_irqs();
    }
    else {
        // execution can never resume (until NMIs are supported)
        js::cpu_event_halt();
    }
}
#[no_mangle]
pub unsafe fn instr_F5() {
    // cmc
    *flags = (*flags | 1) ^ getcf() as i32;
    *flags_changed &= !1;
}

pub unsafe fn instr_F6_0_mem(addr: i32, imm: i32) {
    test8(return_on_pagefault!(safe_read8(addr)), imm);
}
pub unsafe fn instr_F6_0_reg(r1: i32, imm: i32) { test8(read_reg8(r1), imm); }
pub unsafe fn instr_F6_1_mem(addr: i32, imm: i32) {
    test8(return_on_pagefault!(safe_read8(addr)), imm);
}
pub unsafe fn instr_F6_1_reg(r1: i32, imm: i32) { test8(read_reg8(r1), imm); }

#[no_mangle]
pub unsafe fn instr_F6_2_mem(addr: i32) { safe_read_write8(addr, &|x| !x & 0xFF) }
#[no_mangle]
pub unsafe fn instr_F6_2_reg(r1: i32) { write_reg8(r1, !read_reg8(r1)); }
#[no_mangle]
pub unsafe fn instr_F6_3_mem(addr: i32) { safe_read_write8(addr, &|x| neg8(x)) }
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

pub unsafe fn instr16_F7_0_mem(addr: i32, imm: i32) {
    test16(return_on_pagefault!(safe_read16(addr)), imm);
}
pub unsafe fn instr16_F7_0_reg(r1: i32, imm: i32) { test16(read_reg16(r1), imm); }
pub unsafe fn instr16_F7_1_mem(addr: i32, imm: i32) {
    test16(return_on_pagefault!(safe_read16(addr)), imm);
}
pub unsafe fn instr16_F7_1_reg(r1: i32, imm: i32) { test16(read_reg16(r1), imm); }
pub unsafe fn instr16_F7_2_mem(addr: i32) { safe_read_write16(addr, &|x| !x & 0xFFFF) }
pub unsafe fn instr16_F7_2_reg(r1: i32) { write_reg16(r1, !read_reg16(r1)); }
pub unsafe fn instr16_F7_3_mem(addr: i32) { safe_read_write16(addr, &|x| neg16(x)) }
pub unsafe fn instr16_F7_3_reg(r1: i32) { write_reg16(r1, neg16(read_reg16(r1))); }
pub unsafe fn instr16_F7_4_mem(addr: i32) { mul16(return_on_pagefault!(safe_read16(addr)) as u32); }
pub unsafe fn instr16_F7_4_reg(r1: i32) { mul16(read_reg16(r1) as u32); }
pub unsafe fn instr16_F7_5_mem(addr: i32) {
    imul16(return_on_pagefault!(safe_read16(addr)) << 16 >> 16);
}
pub unsafe fn instr16_F7_5_reg(r1: i32) { imul16(read_reg16(r1) << 16 >> 16); }
pub unsafe fn instr16_F7_6_mem(addr: i32) { div16(return_on_pagefault!(safe_read16(addr)) as u32); }
pub unsafe fn instr16_F7_6_reg(r1: i32) { div16(read_reg16(r1) as u32); }
pub unsafe fn instr16_F7_7_mem(addr: i32) {
    idiv16(return_on_pagefault!(safe_read16(addr)) << 16 >> 16);
}
pub unsafe fn instr16_F7_7_reg(r1: i32) { idiv16(read_reg16(r1) << 16 >> 16); }

pub unsafe fn instr32_F7_0_mem(addr: i32, imm: i32) {
    test32(return_on_pagefault!(safe_read32s(addr)), imm);
}
pub unsafe fn instr32_F7_0_reg(r1: i32, imm: i32) { test32(read_reg32(r1), imm); }
pub unsafe fn instr32_F7_1_mem(addr: i32, imm: i32) {
    test32(return_on_pagefault!(safe_read32s(addr)), imm);
}
pub unsafe fn instr32_F7_1_reg(r1: i32, imm: i32) { test32(read_reg32(r1), imm); }
pub unsafe fn instr32_F7_2_mem(addr: i32) { safe_read_write32(addr, &|x| !x) }
pub unsafe fn instr32_F7_2_reg(r1: i32) { write_reg32(r1, !read_reg32(r1)); }
pub unsafe fn instr32_F7_3_mem(addr: i32) { safe_read_write32(addr, &|x| neg32(x)) }
pub unsafe fn instr32_F7_3_reg(r1: i32) { write_reg32(r1, neg32(read_reg32(r1))); }
pub unsafe fn instr32_F7_4_mem(addr: i32) { mul32(return_on_pagefault!(safe_read32s(addr))); }
pub unsafe fn instr32_F7_4_reg(r1: i32) { mul32(read_reg32(r1)); }
pub unsafe fn instr32_F7_5_mem(addr: i32) { imul32(return_on_pagefault!(safe_read32s(addr))); }
pub unsafe fn instr32_F7_5_reg(r1: i32) { imul32(read_reg32(r1)); }
pub unsafe fn instr32_F7_6_mem(addr: i32) {
    div32(return_on_pagefault!(safe_read32s(addr)) as u32);
}
pub unsafe fn instr32_F7_6_reg(r1: i32) { div32(read_reg32(r1) as u32); }
pub unsafe fn instr32_F7_7_mem(addr: i32) { idiv32(return_on_pagefault!(safe_read32s(addr))); }
pub unsafe fn instr32_F7_7_reg(r1: i32) { idiv32(read_reg32(r1)); }

pub unsafe fn instr_F8() {
    // clc
    *flags &= !FLAG_CARRY;
    *flags_changed &= !1;
}
pub unsafe fn instr_F9() {
    // stc
    *flags |= FLAG_CARRY;
    *flags_changed &= !1;
}
#[no_mangle]
pub unsafe fn instr_FA_without_fault() -> bool {
    // cli
    if !*protected_mode
        || if 0 != *flags & FLAG_VM { getiopl() == 3 } else { getiopl() >= *cpl as i32 }
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
pub unsafe fn instr_FA() {
    if !instr_FA_without_fault() {
        trigger_gp(0);
    }
}

#[no_mangle]
pub unsafe fn instr_FB_without_fault() -> bool {
    // sti
    if !*protected_mode
        || if 0 != *flags & FLAG_VM { getiopl() == 3 } else { getiopl() >= *cpl as i32 }
    {
        *flags |= FLAG_INTERRUPT;
        return true;
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
        *flags |= FLAG_VIF;
        return true;
    }
    else {
        dbg_log!("sti #gp");
        return false;
    };
}
pub unsafe fn instr_FB() {
    if !instr_FB_without_fault() {
        trigger_gp(0);
    }
    else {
        *prefixes = 0;
        *previous_ip = *instruction_pointer;
        *instruction_counter += 1;
        run_instruction(return_on_pagefault!(read_imm8()) | (is_osize_32() as i32) << 8);

        handle_irqs();
    }
}

pub unsafe fn instr_FC() {
    // cld
    *flags &= !FLAG_DIRECTION;
}
pub unsafe fn instr_FD() {
    // std
    *flags |= FLAG_DIRECTION;
}

pub unsafe fn instr_FE_0_mem(addr: i32) { safe_read_write8(addr, &|x| inc8(x)) }
pub unsafe fn instr_FE_0_reg(r1: i32) { write_reg8(r1, inc8(read_reg8(r1))); }
pub unsafe fn instr_FE_1_mem(addr: i32) { safe_read_write8(addr, &|x| dec8(x)) }
pub unsafe fn instr_FE_1_reg(r1: i32) { write_reg8(r1, dec8(read_reg8(r1))); }
pub unsafe fn instr16_FF_0_mem(addr: i32) { safe_read_write16(addr, &|x| inc16(x)) }
pub unsafe fn instr16_FF_0_reg(r1: i32) { write_reg16(r1, inc16(read_reg16(r1))); }
pub unsafe fn instr16_FF_1_mem(addr: i32) { safe_read_write16(addr, &|x| dec16(x)) }
pub unsafe fn instr16_FF_1_reg(r1: i32) { write_reg16(r1, dec16(read_reg16(r1))); }
pub unsafe fn instr16_FF_2_helper(data: i32) {
    // call near
    let cs = get_seg_cs();
    return_on_pagefault!(push16(get_real_eip()));
    *instruction_pointer = cs + data;
    dbg_assert!(*is_32 || get_real_eip() < 0x10000);
}
pub unsafe fn instr16_FF_2_mem(addr: i32) {
    instr16_FF_2_helper(return_on_pagefault!(safe_read16(addr)));
}
pub unsafe fn instr16_FF_2_reg(r1: i32) { instr16_FF_2_helper(read_reg16(r1)); }

#[no_mangle]
pub unsafe fn instr16_FF_3_reg(_r: i32) {
    dbg_log!("callf #ud");
    trigger_ud();
}
#[no_mangle]
pub unsafe fn instr16_FF_3_mem(addr: i32) {
    // callf
    let new_ip = return_on_pagefault!(safe_read16(addr));
    let new_cs = return_on_pagefault!(safe_read16(addr + 2));
    far_jump(new_ip, new_cs, true, false);
}
pub unsafe fn instr16_FF_4_helper(data: i32) {
    // jmp near
    *instruction_pointer = get_seg_cs() + data;
    dbg_assert!(*is_32 || get_real_eip() < 0x10000);
}
pub unsafe fn instr16_FF_4_mem(addr: i32) {
    instr16_FF_4_helper(return_on_pagefault!(safe_read16(addr)));
}
pub unsafe fn instr16_FF_4_reg(r1: i32) { instr16_FF_4_helper(read_reg16(r1)); }

#[no_mangle]
pub unsafe fn instr16_FF_5_reg(_r: i32) {
    dbg_log!("jmpf #ud");
    trigger_ud();
}
#[no_mangle]
pub unsafe fn instr16_FF_5_mem(addr: i32) {
    // jmpf
    let new_ip = return_on_pagefault!(safe_read16(addr));
    let new_cs = return_on_pagefault!(safe_read16(addr + 2));
    far_jump(new_ip, new_cs, false, false);
}
pub unsafe fn instr16_FF_6_mem(addr: i32) {
    return_on_pagefault!(push16(return_on_pagefault!(safe_read16(addr))));
}
pub unsafe fn instr16_FF_6_reg(r1: i32) {
    return_on_pagefault!(push16(read_reg16(r1)));
}

pub unsafe fn instr32_FF_0_mem(addr: i32) { safe_read_write32(addr, &|x| inc32(x)) }
pub unsafe fn instr32_FF_0_reg(r1: i32) { write_reg32(r1, inc32(read_reg32(r1))); }
pub unsafe fn instr32_FF_1_mem(addr: i32) { safe_read_write32(addr, &|x| dec32(x)) }
pub unsafe fn instr32_FF_1_reg(r1: i32) { write_reg32(r1, dec32(read_reg32(r1))); }

pub unsafe fn instr32_FF_2_helper(data: i32) {
    // call near
    let cs = get_seg_cs();
    return_on_pagefault!(push32(get_real_eip()));
    dbg_assert!(*is_32 || data < 0x10000);
    *instruction_pointer = cs + data;
}
pub unsafe fn instr32_FF_2_mem(addr: i32) {
    instr32_FF_2_helper(return_on_pagefault!(safe_read32s(addr)));
}
pub unsafe fn instr32_FF_2_reg(r1: i32) { instr32_FF_2_helper(read_reg32(r1)); }
#[no_mangle]
pub unsafe fn instr32_FF_3_reg(_r: i32) {
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
    far_jump(new_ip, new_cs, true, true);
}

pub unsafe fn instr32_FF_4_helper(data: i32) {
    // jmp near
    dbg_assert!(*is_32 || data < 0x10000);
    *instruction_pointer = get_seg_cs() + data;
}
pub unsafe fn instr32_FF_4_mem(addr: i32) {
    instr32_FF_4_helper(return_on_pagefault!(safe_read32s(addr)));
}
pub unsafe fn instr32_FF_4_reg(r1: i32) { instr32_FF_4_helper(read_reg32(r1)); }

#[no_mangle]
pub unsafe fn instr32_FF_5_reg(_r: i32) {
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
    far_jump(new_ip, new_cs, false, true);
}
pub unsafe fn instr32_FF_6_mem(addr: i32) {
    return_on_pagefault!(push32(return_on_pagefault!(safe_read32s(addr))));
}
pub unsafe fn instr32_FF_6_reg(r1: i32) {
    return_on_pagefault!(push32(read_reg32(r1)));
}
