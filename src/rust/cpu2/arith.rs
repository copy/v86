#![allow(
    dead_code,
    mutable_transmutes,
    non_camel_case_types,
    non_snake_case,
    non_upper_case_globals,
    unused_mut
)]

use cpu2::cpu::*;
use cpu2::global_pointers::*;
use cpu2::memory::{read8, write8};
use cpu2::misc_instr::{getaf, getcf};

pub fn int_log2(x: i32) -> i32 { 31 - x.leading_zeros() as i32 }

#[no_mangle]
pub unsafe extern "C" fn add(
    mut dest_operand: i32,
    mut source_operand: i32,
    mut op_size: i32,
) -> i32 {
    *last_op1 = dest_operand;
    *last_op2 = source_operand;
    let mut res: i32 = dest_operand + source_operand;
    *last_result = res;
    *last_add_result = *last_result;
    *last_op_size = op_size;
    *flags_changed = FLAGS_ALL;
    return res;
}
#[no_mangle]
pub unsafe extern "C" fn adc(
    mut dest_operand: i32,
    mut source_operand: i32,
    mut op_size: i32,
) -> i32 {
    let mut cf: i32 = getcf() as i32;
    *last_op1 = dest_operand;
    *last_op2 = source_operand;
    let mut res: i32 = dest_operand + source_operand + cf;
    *last_result = res;
    *last_add_result = *last_result;
    *last_op_size = op_size;
    *flags_changed = FLAGS_ALL;
    return res;
}
#[no_mangle]
pub unsafe extern "C" fn sub(
    mut dest_operand: i32,
    mut source_operand: i32,
    mut op_size: i32,
) -> i32 {
    *last_add_result = dest_operand;
    *last_op2 = source_operand;
    let mut res: i32 = dest_operand - source_operand;
    *last_result = res;
    *last_op1 = *last_result;
    *last_op_size = op_size;
    *flags_changed = FLAGS_ALL;
    return res;
}
#[no_mangle]
pub unsafe extern "C" fn sbb(
    mut dest_operand: i32,
    mut source_operand: i32,
    mut op_size: i32,
) -> i32 {
    let mut cf: i32 = getcf() as i32;
    *last_add_result = dest_operand;
    *last_op2 = source_operand;
    let mut res: i32 = dest_operand - source_operand - cf;
    *last_result = res;
    *last_op1 = *last_result;
    *last_op_size = op_size;
    *flags_changed = FLAGS_ALL;
    return res;
}
#[no_mangle]
pub unsafe extern "C" fn add8(mut x: i32, mut y: i32) -> i32 { return add(x, y, OPSIZE_8); }
#[no_mangle]
pub unsafe extern "C" fn add16(mut x: i32, mut y: i32) -> i32 { return add(x, y, OPSIZE_16); }
#[no_mangle]
pub unsafe extern "C" fn add32(mut x: i32, mut y: i32) -> i32 { return add(x, y, OPSIZE_32); }
#[no_mangle]
pub unsafe extern "C" fn sub8(mut x: i32, mut y: i32) -> i32 { return sub(x, y, OPSIZE_8); }
#[no_mangle]
pub unsafe extern "C" fn sub16(mut x: i32, mut y: i32) -> i32 { return sub(x, y, OPSIZE_16); }
#[no_mangle]
pub unsafe extern "C" fn sub32(mut x: i32, mut y: i32) -> i32 { return sub(x, y, OPSIZE_32); }
#[no_mangle]
pub unsafe extern "C" fn adc8(mut x: i32, mut y: i32) -> i32 { return adc(x, y, OPSIZE_8); }
#[no_mangle]
pub unsafe extern "C" fn adc16(mut x: i32, mut y: i32) -> i32 { return adc(x, y, OPSIZE_16); }
#[no_mangle]
pub unsafe extern "C" fn adc32(mut x: i32, mut y: i32) -> i32 { return adc(x, y, OPSIZE_32); }
#[no_mangle]
pub unsafe extern "C" fn sbb8(mut x: i32, mut y: i32) -> i32 { return sbb(x, y, OPSIZE_8); }
#[no_mangle]
pub unsafe extern "C" fn sbb16(mut x: i32, mut y: i32) -> i32 { return sbb(x, y, OPSIZE_16); }
#[no_mangle]
pub unsafe extern "C" fn sbb32(mut x: i32, mut y: i32) -> i32 { return sbb(x, y, OPSIZE_32); }
#[no_mangle]
pub unsafe extern "C" fn cmp8(mut x: i32, mut y: i32) -> () { sub(x, y, OPSIZE_8); }
#[no_mangle]
pub unsafe extern "C" fn cmp16(mut x: i32, mut y: i32) -> () { sub(x, y, OPSIZE_16); }
#[no_mangle]
pub unsafe extern "C" fn cmp32(mut x: i32, mut y: i32) -> () { sub(x, y, OPSIZE_32); }
#[no_mangle]
pub unsafe extern "C" fn inc(mut dest_operand: i32, mut op_size: i32) -> i32 {
    *flags = *flags & !1i32 | getcf() as i32;
    *last_op1 = dest_operand;
    *last_op2 = 1i32;
    let mut res: i32 = dest_operand + 1i32;
    *last_result = res;
    *last_add_result = *last_result;
    *last_op_size = op_size;
    *flags_changed = FLAGS_ALL & !1i32;
    return res;
}
#[no_mangle]
pub unsafe extern "C" fn dec(mut dest_operand: i32, mut op_size: i32) -> i32 {
    *flags = *flags & !1i32 | getcf() as i32;
    *last_add_result = dest_operand;
    *last_op2 = 1i32;
    let mut res: i32 = dest_operand - 1i32;
    *last_result = res;
    *last_op1 = *last_result;
    *last_op_size = op_size;
    *flags_changed = FLAGS_ALL & !1i32;
    return res;
}
#[no_mangle]
pub unsafe extern "C" fn inc8(mut x: i32) -> i32 { return inc(x, OPSIZE_8); }
#[no_mangle]
pub unsafe extern "C" fn inc16(mut x: i32) -> i32 { return inc(x, OPSIZE_16); }
#[no_mangle]
pub unsafe extern "C" fn inc32(mut x: i32) -> i32 { return inc(x, OPSIZE_32); }
#[no_mangle]
pub unsafe extern "C" fn dec8(mut x: i32) -> i32 { return dec(x, OPSIZE_8); }
#[no_mangle]
pub unsafe extern "C" fn dec16(mut x: i32) -> i32 { return dec(x, OPSIZE_16); }
#[no_mangle]
pub unsafe extern "C" fn dec32(mut x: i32) -> i32 { return dec(x, OPSIZE_32); }
#[no_mangle]
pub unsafe extern "C" fn neg(mut dest_operand: i32, mut op_size: i32) -> i32 {
    let mut res: i32 = -dest_operand;
    *last_result = res;
    *last_op1 = *last_result;
    *flags_changed = FLAGS_ALL;
    *last_add_result = 0i32;
    *last_op2 = dest_operand;
    *last_op_size = op_size;
    return res;
}
#[no_mangle]
pub unsafe extern "C" fn neg8(mut x: i32) -> i32 { return neg(x, OPSIZE_8); }
#[no_mangle]
pub unsafe extern "C" fn neg16(mut x: i32) -> i32 { return neg(x, OPSIZE_16); }
#[no_mangle]
pub unsafe extern "C" fn neg32(mut x: i32) -> i32 { return neg(x, OPSIZE_32); }
#[no_mangle]
pub unsafe extern "C" fn mul8(mut source_operand: i32) -> () {
    let mut result: i32 = source_operand * *reg8.offset(AL as isize) as i32;
    *reg16.offset(AX as isize) = result as u16;
    *last_result = result & 255i32;
    *last_op_size = OPSIZE_8;
    if result < 256i32 {
        *flags = *flags & !1i32 & !FLAG_OVERFLOW
    }
    else {
        *flags = *flags | 1i32 | FLAG_OVERFLOW
    }
    *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
}
#[no_mangle]
pub unsafe extern "C" fn imul8(mut source_operand: i32) -> () {
    let mut result: i32 = source_operand * *reg8s.offset(AL as isize) as i32;
    *reg16.offset(AX as isize) = result as u16;
    *last_result = result & 255i32;
    *last_op_size = OPSIZE_8;
    if result > 127i32 || result < -128i32 {
        *flags = *flags | 1i32 | FLAG_OVERFLOW
    }
    else {
        *flags = *flags & !1i32 & !FLAG_OVERFLOW
    }
    *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
}
#[no_mangle]
pub unsafe extern "C" fn mul16(mut source_operand: u32) -> () {
    let mut result: u32 = source_operand.wrapping_mul(*reg16.offset(AX as isize) as u32);
    let mut high_result: u32 = result >> 16i32;
    *reg16.offset(AX as isize) = result as u16;
    *reg16.offset(DX as isize) = high_result as u16;
    *last_result = (result & 65535i32 as u32) as i32;
    *last_op_size = OPSIZE_16;
    if high_result == 0i32 as u32 {
        *flags &= !1i32 & !FLAG_OVERFLOW
    }
    else {
        *flags |= *flags | 1i32 | FLAG_OVERFLOW
    }
    *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
}
#[no_mangle]
pub unsafe extern "C" fn imul16(mut source_operand: i32) -> () {
    let mut result: i32 = source_operand * *reg16s.offset(AX as isize) as i32;
    *reg16.offset(AX as isize) = result as u16;
    *reg16.offset(DX as isize) = (result >> 16i32) as u16;
    *last_result = result & 65535i32;
    *last_op_size = OPSIZE_16;
    if result > 32767i32 || result < -32768i32 {
        *flags |= 1i32 | FLAG_OVERFLOW
    }
    else {
        *flags &= !1i32 & !FLAG_OVERFLOW
    }
    *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
}
#[no_mangle]
pub unsafe extern "C" fn imul_reg16(mut operand1: i32, mut operand2: i32) -> i32 {
    dbg_assert!(operand1 < 32768i32 && operand1 >= -32768i32);
    dbg_assert!(operand2 < 32768i32 && operand2 >= -32768i32);
    let mut result: i32 = operand1 * operand2;
    *last_result = result & 65535i32;
    *last_op_size = OPSIZE_16;
    if result > 32767i32 || result < -32768i32 {
        *flags |= 1i32 | FLAG_OVERFLOW
    }
    else {
        *flags &= !1i32 & !FLAG_OVERFLOW
    }
    *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
    return result;
}
#[no_mangle]
pub unsafe extern "C" fn mul32(mut source_operand: i32) -> () {
    let mut dest_operand: i32 = *reg32s.offset(EAX as isize);
    let mut result: u64 = (dest_operand as u32 as u64).wrapping_mul(source_operand as u32 as u64);
    let mut result_low: i32 = result as i32;
    let mut result_high: i32 = (result >> 32i32) as i32;
    *reg32s.offset(EAX as isize) = result_low;
    *reg32s.offset(EDX as isize) = result_high;
    *last_result = result_low;
    *last_op_size = OPSIZE_32;
    if result_high == 0i32 {
        *flags &= !1i32 & !FLAG_OVERFLOW
    }
    else {
        *flags |= 1i32 | FLAG_OVERFLOW
    }
    *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
}
#[no_mangle]
pub unsafe extern "C" fn imul32(mut source_operand: i32) -> () {
    let mut dest_operand: i32 = *reg32s.offset(EAX as isize);
    let mut result: i64 = dest_operand as i64 * source_operand as i64;
    let mut result_low: i32 = result as i32;
    let mut result_high: i32 = (result >> 32i32) as i32;
    *reg32s.offset(EAX as isize) = result_low;
    *reg32s.offset(EDX as isize) = result_high;
    *last_result = result_low;
    *last_op_size = OPSIZE_32;
    if result_high == result_low >> 31i32 {
        *flags &= !1i32 & !FLAG_OVERFLOW
    }
    else {
        *flags |= 1i32 | FLAG_OVERFLOW
    }
    *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
}
#[no_mangle]
pub unsafe extern "C" fn imul_reg32(mut operand1: i32, mut operand2: i32) -> i32 {
    let mut result: i64 = operand1 as i64 * operand2 as i64;
    let mut result_low: i32 = result as i32;
    let mut result_high: i32 = (result >> 32i32) as i32;
    *last_result = result_low;
    *last_op_size = OPSIZE_32;
    if result_high == result_low >> 31i32 {
        *flags &= !1i32 & !FLAG_OVERFLOW
    }
    else {
        *flags |= 1i32 | FLAG_OVERFLOW
    }
    *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
    return result_low;
}
#[no_mangle]
pub unsafe extern "C" fn xadd8(mut source_operand: i32, mut reg: i32) -> i32 {
    let mut tmp: i32 = *reg8.offset(reg as isize) as i32;
    *reg8.offset(reg as isize) = source_operand as u8;
    return add(source_operand, tmp, OPSIZE_8);
}
#[no_mangle]
pub unsafe extern "C" fn xadd16(mut source_operand: i32, mut reg: i32) -> i32 {
    let mut tmp: i32 = *reg16.offset(reg as isize) as i32;
    *reg16.offset(reg as isize) = source_operand as u16;
    return add(source_operand, tmp, OPSIZE_16);
}
#[no_mangle]
pub unsafe extern "C" fn xadd32(mut source_operand: i32, mut reg: i32) -> i32 {
    let mut tmp: i32 = *reg32s.offset(reg as isize);
    *reg32s.offset(reg as isize) = source_operand;
    return add(source_operand, tmp, OPSIZE_32);
}
#[no_mangle]
pub unsafe extern "C" fn bcd_daa() -> () {
    let mut old_al: i32 = *reg8.offset(AL as isize) as i32;
    let mut old_cf: i32 = getcf() as i32;
    let mut old_af: i32 = getaf() as i32;
    *flags &= !1i32 & !FLAG_ADJUST;
    if old_al & 15i32 > 9i32 || 0 != old_af {
        let ref mut fresh0 = *reg8.offset(AL as isize);
        *fresh0 = (*fresh0 as i32 + 6i32) as u8;
        *flags |= FLAG_ADJUST
    }
    if old_al > 153i32 || 0 != old_cf {
        let ref mut fresh1 = *reg8.offset(AL as isize);
        *fresh1 = (*fresh1 as i32 + 96i32) as u8;
        *flags |= 1i32
    }
    *last_result = *reg8.offset(AL as isize) as i32;
    *last_op_size = OPSIZE_8;
    *last_op2 = 0i32;
    *last_op1 = *last_op2;
    *flags_changed = FLAGS_ALL & !1i32 & !FLAG_ADJUST & !FLAG_OVERFLOW;
}
#[no_mangle]
pub unsafe extern "C" fn bcd_das() -> () {
    let mut old_al: i32 = *reg8.offset(AL as isize) as i32;
    let mut old_cf: i32 = getcf() as i32;
    *flags &= !1i32;
    if old_al & 15i32 > 9i32 || 0 != getaf() as i32 {
        let ref mut fresh2 = *reg8.offset(AL as isize);
        *fresh2 = (*fresh2 as i32 - 6i32) as u8;
        *flags |= FLAG_ADJUST;
        *flags = *flags & !1i32 | old_cf | (old_al < 6i32) as i32
    }
    else {
        *flags &= !FLAG_ADJUST
    }
    if old_al > 153i32 || 0 != old_cf {
        let ref mut fresh3 = *reg8.offset(AL as isize);
        *fresh3 = (*fresh3 as i32 - 96i32) as u8;
        *flags |= 1i32
    }
    *last_result = *reg8.offset(AL as isize) as i32;
    *last_op_size = OPSIZE_8;
    *last_op2 = 0i32;
    *last_op1 = *last_op2;
    *flags_changed = FLAGS_ALL & !1i32 & !FLAG_ADJUST & !FLAG_OVERFLOW;
}
#[no_mangle]
pub unsafe extern "C" fn bcd_aad(mut imm8: i32) -> () {
    let mut result: i32 =
        *reg8.offset(AL as isize) as i32 + *reg8.offset(AH as isize) as i32 * imm8;
    *last_result = result & 255i32;
    *reg16.offset(AX as isize) = *last_result as u16;
    *last_op_size = OPSIZE_8;
    *flags_changed = FLAGS_ALL & !1i32 & !FLAG_ADJUST & !FLAG_OVERFLOW;
    *flags &= !1i32 & !FLAG_ADJUST & !FLAG_OVERFLOW;
    if result > 65535i32 {
        *flags |= 1i32
    };
}
#[no_mangle]
pub unsafe extern "C" fn bcd_aam(mut imm8: i32) -> () {
    c_comment!(("ascii adjust after multiplication"));
    if imm8 == 0i32 {
        trigger_de();
    }
    else {
        let mut temp: u8 = *reg8.offset(AL as isize);
        *reg8.offset(AH as isize) = (temp as i32 / imm8) as u8;
        *reg8.offset(AL as isize) = (temp as i32 % imm8) as u8;
        *last_result = *reg8.offset(AL as isize) as i32;
        *flags_changed = FLAGS_ALL & !1i32 & !FLAG_ADJUST & !FLAG_OVERFLOW;
        *flags &= !1i32 & !FLAG_ADJUST & !FLAG_OVERFLOW
    };
}
#[no_mangle]
pub unsafe extern "C" fn bcd_aaa() -> () {
    if *reg8.offset(AL as isize) as i32 & 15i32 > 9i32 || 0 != getaf() as i32 {
        let ref mut fresh4 = *reg16.offset(AX as isize);
        *fresh4 = (*fresh4 as i32 + 6i32) as u16;
        let ref mut fresh5 = *reg8.offset(AH as isize);
        *fresh5 = (*fresh5 as i32 + 1i32) as u8;
        *flags |= FLAG_ADJUST | 1i32
    }
    else {
        *flags &= !FLAG_ADJUST & !1i32
    }
    let ref mut fresh6 = *reg8.offset(AL as isize);
    *fresh6 = (*fresh6 as i32 & 15i32) as u8;
    *flags_changed &= !FLAG_ADJUST & !1i32;
}
#[no_mangle]
pub unsafe extern "C" fn bcd_aas() -> () {
    if *reg8.offset(AL as isize) as i32 & 15i32 > 9i32 || 0 != getaf() as i32 {
        let ref mut fresh7 = *reg16.offset(AX as isize);
        *fresh7 = (*fresh7 as i32 - 6i32) as u16;
        let ref mut fresh8 = *reg8.offset(AH as isize);
        *fresh8 = (*fresh8 as i32 - 1i32) as u8;
        *flags |= FLAG_ADJUST | 1i32
    }
    else {
        *flags &= !FLAG_ADJUST & !1i32
    }
    let ref mut fresh9 = *reg8.offset(AL as isize);
    *fresh9 = (*fresh9 as i32 & 15i32) as u8;
    *flags_changed &= !FLAG_ADJUST & !1i32;
}
#[no_mangle]
pub unsafe extern "C" fn and(
    mut dest_operand: i32,
    mut source_operand: i32,
    mut op_size: i32,
) -> i32 {
    *last_result = dest_operand & source_operand;
    *last_op_size = op_size;
    *flags &= !1i32 & !FLAG_OVERFLOW & !FLAG_ADJUST;
    *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW & !FLAG_ADJUST;
    return *last_result;
}
#[no_mangle]
pub unsafe extern "C" fn or(
    mut dest_operand: i32,
    mut source_operand: i32,
    mut op_size: i32,
) -> i32 {
    *last_result = dest_operand | source_operand;
    *last_op_size = op_size;
    *flags &= !1i32 & !FLAG_OVERFLOW & !FLAG_ADJUST;
    *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW & !FLAG_ADJUST;
    return *last_result;
}
#[no_mangle]
pub unsafe extern "C" fn xor(
    mut dest_operand: i32,
    mut source_operand: i32,
    mut op_size: i32,
) -> i32 {
    *last_result = dest_operand ^ source_operand;
    *last_op_size = op_size;
    *flags &= !1i32 & !FLAG_OVERFLOW & !FLAG_ADJUST;
    *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW & !FLAG_ADJUST;
    return *last_result;
}
#[no_mangle]
pub unsafe extern "C" fn and8(mut x: i32, mut y: i32) -> i32 { return and(x, y, OPSIZE_8); }
#[no_mangle]
pub unsafe extern "C" fn and16(mut x: i32, mut y: i32) -> i32 { return and(x, y, OPSIZE_16); }
#[no_mangle]
pub unsafe extern "C" fn and32(mut x: i32, mut y: i32) -> i32 { return and(x, y, OPSIZE_32); }
#[no_mangle]
pub unsafe extern "C" fn test8(mut x: i32, mut y: i32) -> () { and(x, y, OPSIZE_8); }
#[no_mangle]
pub unsafe extern "C" fn test16(mut x: i32, mut y: i32) -> () { and(x, y, OPSIZE_16); }
#[no_mangle]
pub unsafe extern "C" fn test32(mut x: i32, mut y: i32) -> () { and(x, y, OPSIZE_32); }
#[no_mangle]
pub unsafe extern "C" fn or8(mut x: i32, mut y: i32) -> i32 { return or(x, y, OPSIZE_8); }
#[no_mangle]
pub unsafe extern "C" fn or16(mut x: i32, mut y: i32) -> i32 { return or(x, y, OPSIZE_16); }
#[no_mangle]
pub unsafe extern "C" fn or32(mut x: i32, mut y: i32) -> i32 { return or(x, y, OPSIZE_32); }
#[no_mangle]
pub unsafe extern "C" fn xor8(mut x: i32, mut y: i32) -> i32 { return xor(x, y, OPSIZE_8); }
#[no_mangle]
pub unsafe extern "C" fn xor16(mut x: i32, mut y: i32) -> i32 { return xor(x, y, OPSIZE_16); }
#[no_mangle]
pub unsafe extern "C" fn xor32(mut x: i32, mut y: i32) -> i32 { return xor(x, y, OPSIZE_32); }
#[no_mangle]
pub unsafe extern "C" fn rol8(mut dest_operand: i32, mut count: i32) -> i32 {
    if 0 == count {
        return dest_operand;
    }
    else {
        count &= 7i32;
        let mut result: i32 = dest_operand << count | dest_operand >> 8i32 - count;
        *flags_changed &= !1i32 & !FLAG_OVERFLOW;
        *flags = *flags & !1i32 & !FLAG_OVERFLOW
            | result & 1i32
            | (result << 11i32 ^ result << 4i32) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn rol16(mut dest_operand: i32, mut count: i32) -> i32 {
    if 0 == count {
        return dest_operand;
    }
    else {
        count &= 15i32;
        let mut result: i32 = dest_operand << count | dest_operand >> 16i32 - count;
        *flags_changed &= !1i32 & !FLAG_OVERFLOW;
        *flags = *flags & !1i32 & !FLAG_OVERFLOW
            | result & 1i32
            | (result << 11i32 ^ result >> 4i32) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn rol32(mut dest_operand: i32, mut count: i32) -> i32 {
    if 0 == count {
        return dest_operand;
    }
    else {
        let mut result: i32 =
            ((dest_operand << count) as u32 | dest_operand as u32 >> 32i32 - count) as i32;
        *flags_changed &= !1i32 & !FLAG_OVERFLOW;
        *flags = *flags & !1i32 & !FLAG_OVERFLOW
            | result & 1i32
            | (result << 11i32 ^ result >> 20i32) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn rcl8(mut dest_operand: i32, mut count: i32) -> i32 {
    count %= 9i32;
    if 0 == count {
        return dest_operand;
    }
    else {
        let mut result: i32 =
            dest_operand << count | (getcf() as i32) << count - 1i32 | dest_operand >> 9i32 - count;
        *flags_changed &= !1i32 & !FLAG_OVERFLOW;
        *flags = *flags & !1i32 & !FLAG_OVERFLOW
            | result >> 8i32 & 1i32
            | (result << 3i32 ^ result << 4i32) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn rcl16(mut dest_operand: i32, mut count: i32) -> i32 {
    count %= 17i32;
    if 0 == count {
        return dest_operand;
    }
    else {
        let mut result: i32 = dest_operand << count
            | (getcf() as i32) << count - 1i32
            | dest_operand >> 17i32 - count;
        *flags_changed &= !1i32 & !FLAG_OVERFLOW;
        *flags = *flags & !1i32 & !FLAG_OVERFLOW
            | result >> 16i32 & 1i32
            | (result >> 5i32 ^ result >> 4i32) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn rcl32(mut dest_operand: i32, mut count: i32) -> i32 {
    if 0 == count {
        return dest_operand;
    }
    else {
        let mut result: i32 = dest_operand << count | (getcf() as i32) << count - 1i32;
        if count > 1i32 {
            result = (result as u32 | dest_operand as u32 >> 33i32 - count) as i32
        }
        *flags_changed &= !1i32 & !FLAG_OVERFLOW;
        *flags = ((*flags & !1i32 & !FLAG_OVERFLOW) as u32
            | dest_operand as u32 >> 32i32 - count & 1i32 as u32) as i32;
        *flags |= (*flags << 11i32 ^ result >> 20i32) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn ror8(mut dest_operand: i32, mut count: i32) -> i32 {
    if 0 == count {
        return dest_operand;
    }
    else {
        count &= 7i32;
        let mut result: i32 = dest_operand >> count | dest_operand << 8i32 - count;
        *flags_changed &= !1i32 & !FLAG_OVERFLOW;
        *flags = *flags & !1i32 & !FLAG_OVERFLOW
            | result >> 7i32 & 1i32
            | (result << 4i32 ^ result << 5i32) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn ror16(mut dest_operand: i32, mut count: i32) -> i32 {
    if 0 == count {
        return dest_operand;
    }
    else {
        count &= 15i32;
        let mut result: i32 = dest_operand >> count | dest_operand << 16i32 - count;
        *flags_changed &= !1i32 & !FLAG_OVERFLOW;
        *flags = *flags & !1i32 & !FLAG_OVERFLOW
            | result >> 15i32 & 1i32
            | (result >> 4i32 ^ result >> 3i32) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn ror32(mut dest_operand: i32, mut count: i32) -> i32 {
    if 0 == count {
        return dest_operand;
    }
    else {
        let mut result: i32 =
            (dest_operand as u32 >> count | (dest_operand << 32i32 - count) as u32) as i32;
        *flags_changed &= !1i32 & !FLAG_OVERFLOW;
        *flags = *flags & !1i32 & !FLAG_OVERFLOW
            | result >> 31i32 & 1i32
            | (result >> 20i32 ^ result >> 19i32) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn rcr8(mut dest_operand: i32, mut count: i32) -> i32 {
    count %= 9i32;
    if 0 == count {
        return dest_operand;
    }
    else {
        let mut result: i32 =
            dest_operand >> count | (getcf() as i32) << 8i32 - count | dest_operand << 9i32 - count;
        *flags_changed &= !1i32 & !FLAG_OVERFLOW;
        *flags = *flags & !1i32 & !FLAG_OVERFLOW
            | result >> 8i32 & 1i32
            | (result << 4i32 ^ result << 5i32) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn rcr16(mut dest_operand: i32, mut count: i32) -> i32 {
    count %= 17i32;
    if 0 == count {
        return dest_operand;
    }
    else {
        let mut result: i32 = dest_operand >> count
            | (getcf() as i32) << 16i32 - count
            | dest_operand << 17i32 - count;
        *flags_changed &= !1i32 & !FLAG_OVERFLOW;
        *flags = *flags & !1i32 & !FLAG_OVERFLOW
            | result >> 16i32 & 1i32
            | (result >> 4i32 ^ result >> 3i32) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn rcr32(mut dest_operand: i32, mut count: i32) -> i32 {
    if 0 == count {
        return dest_operand;
    }
    else {
        let mut result: i32 =
            (dest_operand as u32 >> count | ((getcf() as i32) << 32i32 - count) as u32) as i32;
        if count > 1i32 {
            result |= dest_operand << 33i32 - count
        }
        *flags_changed &= !1i32 & !FLAG_OVERFLOW;
        *flags = *flags & !1i32 & !FLAG_OVERFLOW
            | dest_operand >> count - 1i32 & 1i32
            | (result >> 20i32 ^ result >> 19i32) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn div8(mut source_operand: u32) -> () {
    if source_operand == 0i32 as u32 {
        trigger_de();
        return;
    }
    else {
        let mut target_operand: u16 = *reg16.offset(AX as isize);
        let mut result: u16 = (target_operand as u32).wrapping_div(source_operand) as u16;
        if result as i32 >= 256i32 {
            trigger_de();
        }
        else {
            *reg8.offset(AL as isize) = result as u8;
            *reg8.offset(AH as isize) = (target_operand as u32).wrapping_rem(source_operand) as u8
        }
        return;
    };
}
#[no_mangle]
pub unsafe extern "C" fn idiv8(mut source_operand: i32) -> () {
    if source_operand == 0i32 {
        trigger_de();
        return;
    }
    else {
        let mut target_operand: i32 = *reg16s.offset(AX as isize) as i32;
        let mut result: i32 = target_operand / source_operand;
        if result >= 128i32 || result <= -129i32 {
            trigger_de();
        }
        else {
            *reg8.offset(AL as isize) = result as u8;
            *reg8.offset(AH as isize) = (target_operand % source_operand) as u8
        }
        return;
    };
}
#[no_mangle]
pub unsafe extern "C" fn div16(mut source_operand: u32) -> () {
    if source_operand == 0i32 as u32 {
        trigger_de();
        return;
    }
    else {
        let mut target_operand: u32 = (*reg16.offset(AX as isize) as i32
            | (*reg16.offset(DX as isize) as i32) << 16i32)
            as u32;
        let mut result: u32 = target_operand.wrapping_div(source_operand);
        if result >= 65536i32 as u32 {
            trigger_de();
        }
        else {
            *reg16.offset(AX as isize) = result as u16;
            *reg16.offset(DX as isize) = target_operand.wrapping_rem(source_operand) as u16
        }
        return;
    };
}
#[no_mangle]
pub unsafe extern "C" fn idiv16(mut source_operand: i32) -> () {
    if source_operand == 0i32 {
        trigger_de();
        return;
    }
    else {
        let mut target_operand: i32 =
            *reg16.offset(AX as isize) as i32 | (*reg16.offset(DX as isize) as i32) << 16i32;
        let mut result: i32 = target_operand / source_operand;
        if result >= 32768i32 || result <= -32769i32 {
            trigger_de();
        }
        else {
            *reg16.offset(AX as isize) = result as u16;
            *reg16.offset(DX as isize) = (target_operand % source_operand) as u16
        }
        return;
    };
}
#[no_mangle]
pub unsafe extern "C" fn div32(mut source_operand: u32) -> () {
    if source_operand == 0i32 as u32 {
        trigger_de();
        return;
    }
    else {
        let mut target_low: u32 = *reg32s.offset(EAX as isize) as u32;
        let mut target_high: u32 = *reg32s.offset(EDX as isize) as u32;
        let mut target_operand: u64 = (target_high as u64) << 32i32 | target_low as u64;
        let mut result: u64 = target_operand.wrapping_div(source_operand as u64);
        if result > 4294967295u32 as u64 {
            trigger_de();
            return;
        }
        else {
            let mut mod_0: i32 = target_operand.wrapping_rem(source_operand as u64) as i32;
            *reg32s.offset(EAX as isize) = result as i32;
            *reg32s.offset(EDX as isize) = mod_0;
            return;
        }
    };
}
#[no_mangle]
pub unsafe extern "C" fn idiv32(mut source_operand: i32) -> () {
    if source_operand == 0i32 {
        trigger_de();
        return;
    }
    else {
        let mut target_low: u32 = *reg32s.offset(EAX as isize) as u32;
        let mut target_high: u32 = *reg32s.offset(EDX as isize) as u32;
        let mut target_operand: i64 = ((target_high as u64) << 32i32 | target_low as u64) as i64;
        if source_operand == -1i32
            && target_operand == (-1i32 as i64 - 9223372036854775807i64) as i64
        {
            trigger_de();
            return;
        }
        else {
            let mut result: i64 = target_operand / source_operand as i64;
            if result < (-1i32 - 2147483647i32) as i64 || result > 2147483647i32 as i64 {
                trigger_de();
                return;
            }
            else {
                let mut mod_0: i32 = (target_operand % source_operand as i64) as i32;
                *reg32s.offset(EAX as isize) = result as i32;
                *reg32s.offset(EDX as isize) = mod_0;
                return;
            }
        }
    };
}
#[no_mangle]
pub unsafe extern "C" fn shl8(mut dest_operand: i32, mut count: i32) -> i32 {
    if count == 0i32 {
        return dest_operand;
    }
    else {
        *last_result = dest_operand << count;
        *last_op_size = OPSIZE_8;
        *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
        *flags = *flags & !1i32 & !FLAG_OVERFLOW
            | *last_result >> 8i32 & 1i32
            | (*last_result << 3i32 ^ *last_result << 4i32) & FLAG_OVERFLOW;
        return *last_result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn shl16(mut dest_operand: i32, mut count: i32) -> i32 {
    if count == 0i32 {
        return dest_operand;
    }
    else {
        *last_result = dest_operand << count;
        *last_op_size = OPSIZE_16;
        *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
        *flags = *flags & !1i32 & !FLAG_OVERFLOW
            | *last_result >> 16i32 & 1i32
            | (*last_result >> 5i32 ^ *last_result >> 4i32) & FLAG_OVERFLOW;
        return *last_result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn shl32(mut dest_operand: i32, mut count: i32) -> i32 {
    if count == 0i32 {
        return dest_operand;
    }
    else {
        *last_result = dest_operand << count;
        *last_op_size = OPSIZE_32;
        *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
        c_comment!(("test this"));
        *flags = *flags & !1i32 & !FLAG_OVERFLOW | dest_operand >> 32i32 - count & 1i32;
        *flags |= (*flags & 1i32 ^ *last_result >> 31i32 & 1i32) << 11i32 & FLAG_OVERFLOW;
        return *last_result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn shr8(mut dest_operand: i32, mut count: i32) -> i32 {
    if count == 0i32 {
        return dest_operand;
    }
    else {
        *last_result = dest_operand >> count;
        *last_op_size = OPSIZE_8;
        *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
        *flags = *flags & !1i32 & !FLAG_OVERFLOW
            | dest_operand >> count - 1i32 & 1i32
            | (dest_operand >> 7i32 & 1i32) << 11i32 & FLAG_OVERFLOW;
        return *last_result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn shr16(mut dest_operand: i32, mut count: i32) -> i32 {
    if count == 0i32 {
        return dest_operand;
    }
    else {
        *last_result = dest_operand >> count;
        *last_op_size = OPSIZE_16;
        *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
        *flags = *flags & !1i32 & !FLAG_OVERFLOW
            | dest_operand >> count - 1i32 & 1i32
            | dest_operand >> 4i32 & FLAG_OVERFLOW;
        return *last_result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn shr32(mut dest_operand: i32, mut count: i32) -> i32 {
    if count == 0i32 {
        return dest_operand;
    }
    else {
        *last_result = (dest_operand as u32 >> count) as i32;
        *last_op_size = OPSIZE_32;
        *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
        *flags = ((*flags & !1i32 & !FLAG_OVERFLOW) as u32
            | dest_operand as u32 >> count - 1i32 & 1i32 as u32
            | (dest_operand >> 20i32 & FLAG_OVERFLOW) as u32) as i32;
        return *last_result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn sar8(mut dest_operand: i32, mut count: i32) -> i32 {
    if count == 0i32 {
        return dest_operand;
    }
    else {
        if count < 8i32 {
            *last_result = dest_operand << 24i32 >> count + 24i32;
            c_comment!(("of is zero"));
            *flags = *flags & !1i32 & !FLAG_OVERFLOW | dest_operand >> count - 1i32 & 1i32
        }
        else {
            *last_result = dest_operand << 24i32 >> 31i32;
            *flags = *flags & !1i32 & !FLAG_OVERFLOW | *last_result & 1i32
        }
        *last_op_size = OPSIZE_8;
        *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
        return *last_result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn sar16(mut dest_operand: i32, mut count: i32) -> i32 {
    if count == 0i32 {
        return dest_operand;
    }
    else {
        if count < 16i32 {
            *last_result = dest_operand << 16i32 >> count + 16i32;
            *flags = *flags & !1i32 & !FLAG_OVERFLOW | dest_operand >> count - 1i32 & 1i32
        }
        else {
            *last_result = dest_operand << 16i32 >> 31i32;
            *flags = *flags & !1i32 & !FLAG_OVERFLOW | *last_result & 1i32
        }
        *last_op_size = OPSIZE_16;
        *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
        return *last_result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn sar32(mut dest_operand: i32, mut count: i32) -> i32 {
    if count == 0i32 {
        return dest_operand;
    }
    else {
        *last_result = dest_operand >> count;
        *last_op_size = OPSIZE_32;
        *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
        *flags = ((*flags & !1i32 & !FLAG_OVERFLOW) as u32
            | dest_operand as u32 >> count - 1i32 & 1i32 as u32) as i32;
        return *last_result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn shrd16(
    mut dest_operand: i32,
    mut source_operand: i32,
    mut count: i32,
) -> i32 {
    if count == 0i32 {
        return dest_operand;
    }
    else {
        if count <= 16i32 {
            *last_result = dest_operand >> count | source_operand << 16i32 - count;
            *flags = *flags & !1i32 | dest_operand >> count - 1i32 & 1i32
        }
        else {
            *last_result = dest_operand << 32i32 - count | source_operand >> count - 16i32;
            *flags = *flags & !1i32 | source_operand >> count - 17i32 & 1i32
        }
        *last_op_size = OPSIZE_16;
        *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
        *flags = *flags & !FLAG_OVERFLOW | (*last_result ^ dest_operand) >> 4i32 & FLAG_OVERFLOW;
        return *last_result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn shrd32(
    mut dest_operand: i32,
    mut source_operand: i32,
    mut count: i32,
) -> i32 {
    if count == 0i32 {
        return dest_operand;
    }
    else {
        *last_result =
            (dest_operand as u32 >> count | (source_operand << 32i32 - count) as u32) as i32;
        *last_op_size = OPSIZE_32;
        *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
        *flags =
            ((*flags & !1i32) as u32 | dest_operand as u32 >> count - 1i32 & 1i32 as u32) as i32;
        *flags = *flags & !FLAG_OVERFLOW | (*last_result ^ dest_operand) >> 20i32 & FLAG_OVERFLOW;
        return *last_result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn shld16(
    mut dest_operand: i32,
    mut source_operand: i32,
    mut count: i32,
) -> i32 {
    if count == 0i32 {
        return dest_operand;
    }
    else {
        if count <= 16i32 {
            *last_result =
                ((dest_operand << count) as u32 | source_operand as u32 >> 16i32 - count) as i32;
            *flags = ((*flags & !1i32) as u32 | dest_operand as u32 >> 16i32 - count & 1i32 as u32)
                as i32
        }
        else {
            *last_result = dest_operand >> 32i32 - count | source_operand << count - 16i32;
            *flags = ((*flags & !1i32) as u32
                | source_operand as u32 >> 32i32 - count & 1i32 as u32) as i32
        }
        *last_op_size = OPSIZE_16;
        *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
        *flags = *flags & !FLAG_OVERFLOW | (*flags & 1i32 ^ *last_result >> 15i32 & 1i32) << 11i32;
        return *last_result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn shld32(
    mut dest_operand: i32,
    mut source_operand: i32,
    mut count: i32,
) -> i32 {
    if count == 0i32 {
        return dest_operand;
    }
    else {
        *last_result =
            ((dest_operand << count) as u32 | source_operand as u32 >> 32i32 - count) as i32;
        *last_op_size = OPSIZE_32;
        *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
        *flags =
            ((*flags & !1i32) as u32 | dest_operand as u32 >> 32i32 - count & 1i32 as u32) as i32;
        if count == 1i32 {
            *flags =
                *flags & !FLAG_OVERFLOW | (*flags & 1i32 ^ *last_result >> 31i32 & 1i32) << 11i32
        }
        else {
            *flags &= !FLAG_OVERFLOW
        }
        return *last_result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn bt_reg(mut bit_base: i32, mut bit_offset: i32) -> () {
    *flags = *flags & !1i32 | bit_base >> bit_offset & 1i32;
    *flags_changed &= !1i32;
}
#[no_mangle]
pub unsafe extern "C" fn btc_reg(mut bit_base: i32, mut bit_offset: i32) -> i32 {
    *flags = *flags & !1i32 | bit_base >> bit_offset & 1i32;
    *flags_changed &= !1i32;
    return bit_base ^ 1i32 << bit_offset;
}
#[no_mangle]
pub unsafe extern "C" fn bts_reg(mut bit_base: i32, mut bit_offset: i32) -> i32 {
    *flags = *flags & !1i32 | bit_base >> bit_offset & 1i32;
    *flags_changed &= !1i32;
    return bit_base | 1i32 << bit_offset;
}
#[no_mangle]
pub unsafe extern "C" fn btr_reg(mut bit_base: i32, mut bit_offset: i32) -> i32 {
    *flags = *flags & !1i32 | bit_base >> bit_offset & 1i32;
    *flags_changed &= !1i32;
    return bit_base & !(1i32 << bit_offset);
}
#[no_mangle]
pub unsafe extern "C" fn bt_mem(mut virt_addr: i32, mut bit_offset: i32) -> () {
    let mut bit_base: i32 = return_on_pagefault!(safe_read8(virt_addr + (bit_offset >> 3i32)));
    bit_offset &= 7i32;
    *flags = *flags & !1i32 | bit_base >> bit_offset & 1i32;
    *flags_changed &= !1i32;
}
#[no_mangle]
pub unsafe extern "C" fn btc_mem(mut virt_addr: i32, mut bit_offset: i32) -> () {
    let mut phys_addr: i32 =
        return_on_pagefault!(translate_address_write(virt_addr + (bit_offset >> 3i32))) as i32;
    let mut bit_base: i32 = read8(phys_addr as u32);
    bit_offset &= 7i32;
    *flags = *flags & !1i32 | bit_base >> bit_offset & 1i32;
    *flags_changed &= !1i32;
    write8(phys_addr as u32, bit_base ^ 1i32 << bit_offset);
}
#[no_mangle]
pub unsafe extern "C" fn btr_mem(mut virt_addr: i32, mut bit_offset: i32) -> () {
    let mut phys_addr: i32 =
        return_on_pagefault!(translate_address_write(virt_addr + (bit_offset >> 3i32))) as i32;
    let mut bit_base: i32 = read8(phys_addr as u32);
    bit_offset &= 7i32;
    *flags = *flags & !1i32 | bit_base >> bit_offset & 1i32;
    *flags_changed &= !1i32;
    write8(phys_addr as u32, bit_base & !(1i32 << bit_offset));
}
#[no_mangle]
pub unsafe extern "C" fn bts_mem(mut virt_addr: i32, mut bit_offset: i32) -> () {
    let mut phys_addr: i32 =
        return_on_pagefault!(translate_address_write(virt_addr + (bit_offset >> 3i32))) as i32;
    let mut bit_base: i32 = read8(phys_addr as u32);
    bit_offset &= 7i32;
    *flags = *flags & !1i32 | bit_base >> bit_offset & 1i32;
    *flags_changed &= !1i32;
    write8(phys_addr as u32, bit_base | 1i32 << bit_offset);
}
#[no_mangle]
pub unsafe extern "C" fn bsf16(mut old: i32, mut bit_base: i32) -> i32 {
    *flags_changed = FLAGS_ALL & !FLAG_ZERO;
    *last_op_size = OPSIZE_16;
    if bit_base == 0i32 {
        *flags |= FLAG_ZERO;
        *last_result = bit_base;
        c_comment!(("not defined in the docs, but value doesn\'t change on my intel machine"));
        return old;
    }
    else {
        *flags &= !FLAG_ZERO;
        *last_result = int_log2(-bit_base & bit_base);
        return *last_result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn bsf32(mut old: i32, mut bit_base: i32) -> i32 {
    *flags_changed = FLAGS_ALL & !FLAG_ZERO;
    *last_op_size = OPSIZE_32;
    if bit_base == 0i32 {
        *flags |= FLAG_ZERO;
        *last_result = bit_base;
        return old;
    }
    else {
        *flags &= !FLAG_ZERO;
        *last_result = int_log2((-bit_base & bit_base) as u32 as i32);
        return *last_result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn bsr16(mut old: i32, mut bit_base: i32) -> i32 {
    *flags_changed = FLAGS_ALL & !FLAG_ZERO;
    *last_op_size = OPSIZE_16;
    if bit_base == 0i32 {
        *flags |= FLAG_ZERO;
        *last_result = bit_base;
        return old;
    }
    else {
        *flags &= !FLAG_ZERO;
        *last_result = int_log2(bit_base);
        return *last_result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn bsr32(mut old: i32, mut bit_base: i32) -> i32 {
    *flags_changed = FLAGS_ALL & !FLAG_ZERO;
    *last_op_size = OPSIZE_32;
    if bit_base == 0i32 {
        *flags |= FLAG_ZERO;
        *last_result = bit_base;
        return old;
    }
    else {
        *flags &= !FLAG_ZERO;
        *last_result = int_log2(bit_base as u32 as i32);
        return *last_result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn popcnt(mut v: i32) -> i32 {
    *flags_changed = 0i32;
    *flags &= !FLAGS_ALL;
    if 0 != v {
        c_comment!(("http://graphics.stanford.edu/~seander/bithacks.html#CountBitsSetParallel"));
        v = v - (v >> 1i32 & 1431655765i32);
        v = (v & 858993459i32) + (v >> 2i32 & 858993459i32);
        return (v + (v >> 4i32) & 252645135i32) * 16843009i32 >> 24i32;
    }
    else {
        *flags |= FLAG_ZERO;
        return 0i32;
    };
}
#[no_mangle]
pub unsafe extern "C" fn saturate_sw_to_ub(mut v: u32) -> u32 {
    dbg_assert!(v & 4294901760u32 == 0i32 as u32);
    let mut ret: u32 = v;
    if ret >= 32768i32 as u32 {
        ret = 0i32 as u32
    }
    else if ret > 255i32 as u32 {
        ret = 255i32 as u32
    }
    dbg_assert!(ret & 4294967040u32 == 0i32 as u32);
    return ret;
}
#[no_mangle]
pub unsafe extern "C" fn saturate_sw_to_sb(mut v: i32) -> i32 {
    dbg_assert!(v as u32 & 4294901760u32 == 0i32 as u32);
    let mut ret: i32 = v;
    if ret > 65408i32 {
        ret = ret & 255i32
    }
    else if ret > 32767i32 {
        ret = 128i32
    }
    else if ret > 127i32 {
        ret = 127i32
    }
    dbg_assert!(ret as u32 & 4294967040u32 == 0i32 as u32);
    return ret;
}
#[no_mangle]
pub unsafe extern "C" fn saturate_sd_to_sw(mut v: u32) -> u32 {
    let mut ret: u32 = v;
    if ret > 4294934528u32 {
        ret = ret & 65535i32 as u32
    }
    else if ret > 2147483647i32 as u32 {
        ret = 32768i32 as u32
    }
    else if ret > 32767i32 as u32 {
        ret = 32767i32 as u32
    }
    dbg_assert!(ret & 4294901760u32 == 0i32 as u32);
    return ret;
}
#[no_mangle]
pub unsafe extern "C" fn saturate_sd_to_sb(mut v: u32) -> u32 {
    let mut ret: u32 = v;
    if ret > 4294967168u32 {
        ret = ret & 255i32 as u32
    }
    else if ret > 2147483647i32 as u32 {
        ret = 128i32 as u32
    }
    else if ret > 127i32 as u32 {
        ret = 127i32 as u32
    }
    dbg_assert!(ret & 4294967040u32 == 0i32 as u32);
    return ret;
}
#[no_mangle]
pub unsafe extern "C" fn saturate_sd_to_ub(mut v: i32) -> i32 {
    let mut ret: i32 = v;
    if ret < 0i32 {
        ret = 0i32
    }
    dbg_assert!(ret as u32 & 4294967040u32 == 0i32 as u32);
    return ret;
}
#[no_mangle]
pub unsafe extern "C" fn saturate_ud_to_ub(mut v: u32) -> u32 {
    let mut ret: u32 = v;
    if ret > 255i32 as u32 {
        ret = 255i32 as u32
    }
    dbg_assert!(ret & 4294967040u32 == 0i32 as u32);
    return ret;
}
#[no_mangle]
pub unsafe extern "C" fn saturate_uw(mut v: u32) -> i32 {
    let mut ret: u32 = v;
    if ret > 2147483647i32 as u32 {
        ret = 0i32 as u32
    }
    else if ret > 65535i32 as u32 {
        ret = 65535i32 as u32
    }
    dbg_assert!(ret & 4294901760u32 == 0i32 as u32);
    return ret as i32;
}
