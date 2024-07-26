use cpu::cpu::*;
use cpu::global_pointers::*;
use cpu::memory::{read8, write8};
use cpu::misc_instr::{getaf, getcf, getzf};

fn int_log2(x: i32) -> i32 { 31 - x.leading_zeros() as i32 }

unsafe fn add(dest_operand: i32, source_operand: i32, op_size: i32) -> i32 {
    let res = dest_operand + source_operand;
    *last_op1 = dest_operand;
    *last_result = res & (2 << op_size) - 1;
    *last_op_size = op_size;
    *flags_changed = FLAGS_ALL;
    return res;
}
unsafe fn adc(dest_operand: i32, source_operand: i32, op_size: i32) -> i32 {
    let cf = getcf() as i32;
    let res = dest_operand + source_operand + cf;
    *last_op1 = dest_operand;
    *last_result = res & (2 << op_size) - 1;
    *last_op_size = op_size;
    *flags_changed = FLAGS_ALL & !FLAG_CARRY & !FLAG_ADJUST & !FLAG_OVERFLOW;
    *flags = *flags & !FLAG_CARRY & !FLAG_ADJUST & !FLAG_OVERFLOW
        | (dest_operand ^ ((dest_operand ^ source_operand) & (source_operand ^ res))) >> op_size
            & FLAG_CARRY
        | (dest_operand ^ source_operand ^ res) & FLAG_ADJUST
        | ((source_operand ^ res) & (dest_operand ^ res)) >> op_size << 11 & FLAG_OVERFLOW;
    return res;
}
unsafe fn sub(dest_operand: i32, source_operand: i32, op_size: i32) -> i32 {
    let res = dest_operand - source_operand;
    *last_op1 = dest_operand;
    *last_result = res & (2 << op_size) - 1;
    *last_op_size = op_size;
    *flags_changed = FLAGS_ALL | FLAG_SUB;
    return res;
}
unsafe fn sbb(dest_operand: i32, source_operand: i32, op_size: i32) -> i32 {
    let cf = getcf() as i32;
    let res = dest_operand - source_operand - cf;
    *last_op1 = dest_operand;
    *last_result = res & (2 << op_size) - 1;
    *last_op_size = op_size;
    *flags_changed = FLAGS_ALL & !FLAG_CARRY & !FLAG_ADJUST & !FLAG_OVERFLOW | FLAG_SUB;
    *flags = *flags & !FLAG_CARRY & !FLAG_ADJUST & !FLAG_OVERFLOW
        | (res ^ ((res ^ source_operand) & (source_operand ^ dest_operand))) >> op_size
            & FLAG_CARRY
        | (dest_operand ^ source_operand ^ res) & FLAG_ADJUST
        | ((source_operand ^ dest_operand) & (res ^ dest_operand)) >> op_size << 11 & FLAG_OVERFLOW;
    return res;
}
pub unsafe fn add8(x: i32, y: i32) -> i32 {
    dbg_assert!(x >= 0 && x < 0x100);
    dbg_assert!(y >= 0 && y < 0x100);
    return add(x, y, OPSIZE_8);
}
#[no_mangle]
pub unsafe fn add16(x: i32, y: i32) -> i32 {
    dbg_assert!(x >= 0 && x < 0x10000);
    dbg_assert!(y >= 0 && y < 0x10000);
    return add(x, y, OPSIZE_16);
}
pub unsafe fn add32(x: i32, y: i32) -> i32 { return add(x, y, OPSIZE_32); }
pub unsafe fn sub8(x: i32, y: i32) -> i32 { return sub(x, y, OPSIZE_8); }
#[no_mangle]
pub unsafe fn sub16(x: i32, y: i32) -> i32 { return sub(x, y, OPSIZE_16); }
pub unsafe fn sub32(x: i32, y: i32) -> i32 { return sub(x, y, OPSIZE_32); }
#[no_mangle]
pub unsafe fn adc8(x: i32, y: i32) -> i32 { return adc(x, y, OPSIZE_8); }
#[no_mangle]
pub unsafe fn adc16(x: i32, y: i32) -> i32 { return adc(x, y, OPSIZE_16); }
pub unsafe fn adc32(x: i32, y: i32) -> i32 { return adc(x, y, OPSIZE_32); }
#[no_mangle]
pub unsafe fn sbb8(x: i32, y: i32) -> i32 { return sbb(x, y, OPSIZE_8); }
#[no_mangle]
pub unsafe fn sbb16(x: i32, y: i32) -> i32 { return sbb(x, y, OPSIZE_16); }
pub unsafe fn sbb32(x: i32, y: i32) -> i32 { return sbb(x, y, OPSIZE_32); }
pub unsafe fn cmp8(x: i32, y: i32) {
    dbg_assert!(x >= 0 && x < 0x100);
    dbg_assert!(y >= 0 && y < 0x100);
    sub(x, y, OPSIZE_8);
}
pub unsafe fn cmp16(x: i32, y: i32) {
    dbg_assert!(x >= 0 && x < 0x10000);
    dbg_assert!(y >= 0 && y < 0x10000);
    sub(x, y, OPSIZE_16);
}
pub unsafe fn cmp32(x: i32, y: i32) { sub(x, y, OPSIZE_32); }
unsafe fn inc(dest_operand: i32, op_size: i32) -> i32 {
    *flags = *flags & !1 | getcf() as i32;
    let res = dest_operand + 1;
    *last_op1 = dest_operand;
    *last_result = res & (2 << op_size) - 1;
    *last_op_size = op_size;
    *flags_changed = FLAGS_ALL & !1;
    return res;
}
unsafe fn dec(dest_operand: i32, op_size: i32) -> i32 {
    *flags = *flags & !1 | getcf() as i32;
    let res = dest_operand - 1;
    *last_op1 = dest_operand;
    *last_result = res & (2 << op_size) - 1;
    *last_op_size = op_size;
    *flags_changed = FLAGS_ALL & !1 | FLAG_SUB;
    return res;
}
#[no_mangle]
pub unsafe fn inc8(x: i32) -> i32 { return inc(x, OPSIZE_8); }
pub unsafe fn inc16(x: i32) -> i32 { return inc(x, OPSIZE_16); }
pub unsafe fn inc32(x: i32) -> i32 { return inc(x, OPSIZE_32); }
#[no_mangle]
pub unsafe fn dec8(x: i32) -> i32 { return dec(x, OPSIZE_8); }
pub unsafe fn dec16(x: i32) -> i32 { return dec(x, OPSIZE_16); }
pub unsafe fn dec32(x: i32) -> i32 { return dec(x, OPSIZE_32); }

unsafe fn neg(dest_operand: i32, op_size: i32) -> i32 { sub(0, dest_operand, op_size) }
#[no_mangle]
pub unsafe fn not8(x: i32) -> i32 { return !x; }
#[no_mangle]
pub unsafe fn neg8(x: i32) -> i32 { return neg(x, OPSIZE_8); }
#[no_mangle]
pub unsafe fn neg16(x: i32) -> i32 { return neg(x, OPSIZE_16); }
pub unsafe fn neg32(x: i32) -> i32 { return neg(x, OPSIZE_32); }

#[no_mangle]
pub unsafe fn mul8(source_operand: i32) {
    let result = source_operand * read_reg8(AL);
    write_reg16(AX, result);
    *last_result = result & 255;
    *last_op_size = OPSIZE_8;
    if result < 256 {
        *flags &= !1 & !FLAG_OVERFLOW
    }
    else {
        *flags |= 1 | FLAG_OVERFLOW
    }
    *flags_changed = FLAGS_ALL & !1 & !FLAG_OVERFLOW;
}
#[no_mangle]
pub unsafe fn imul8(source_operand: i32) {
    let result = source_operand * (read_reg8(AL) << 24 >> 24);
    write_reg16(AX, result);
    *last_result = result & 255;
    *last_op_size = OPSIZE_8;
    if result > 127 || result < -128 {
        *flags |= 1 | FLAG_OVERFLOW
    }
    else {
        *flags &= !1 & !FLAG_OVERFLOW
    }
    *flags_changed = FLAGS_ALL & !1 & !FLAG_OVERFLOW;
}
#[no_mangle]
pub unsafe fn mul16(source_operand: u32) {
    let result = source_operand * read_reg16(AX) as u32;
    let high_result = result >> 16;
    write_reg16(AX, result as i32);
    write_reg16(DX, high_result as i32);
    *last_result = (result & 0xFFFF) as i32;
    *last_op_size = OPSIZE_16;
    if high_result == 0 {
        *flags &= !1 & !FLAG_OVERFLOW
    }
    else {
        *flags |= 1 | FLAG_OVERFLOW
    }
    *flags_changed = FLAGS_ALL & !1 & !FLAG_OVERFLOW;
}
#[no_mangle]
pub unsafe fn imul16(source_operand: i32) {
    let result = source_operand * (read_reg16(AX) << 16 >> 16);
    write_reg16(AX, result);
    write_reg16(DX, result >> 16);
    *last_result = result & 0xFFFF;
    *last_op_size = OPSIZE_16;
    if result > 32767 || result < -32768 {
        *flags |= 1 | FLAG_OVERFLOW
    }
    else {
        *flags &= !1 & !FLAG_OVERFLOW
    }
    *flags_changed = FLAGS_ALL & !1 & !FLAG_OVERFLOW;
}
#[no_mangle]
pub unsafe fn imul_reg16(mut operand1: i32, mut operand2: i32) -> i32 {
    operand1 = operand1 << 16 >> 16;
    operand2 = operand2 << 16 >> 16;
    let result = operand1 * operand2;
    *last_result = result & 0xFFFF;
    *last_op_size = OPSIZE_16;
    if result > 32767 || result < -32768 {
        *flags |= 1 | FLAG_OVERFLOW
    }
    else {
        *flags &= !1 & !FLAG_OVERFLOW
    }
    *flags_changed = FLAGS_ALL & !1 & !FLAG_OVERFLOW;
    return result;
}
#[no_mangle]
pub unsafe fn mul32(source_operand: i32) {
    let dest_operand = read_reg32(EAX);
    let result = (dest_operand as u32 as u64) * (source_operand as u32 as u64);
    let result_low = result as i32;
    let result_high = (result >> 32) as i32;
    write_reg32(EAX, result_low);
    write_reg32(EDX, result_high);
    *last_result = result_low;
    *last_op_size = OPSIZE_32;
    if result_high == 0 {
        *flags &= !1 & !FLAG_OVERFLOW
    }
    else {
        *flags |= 1 | FLAG_OVERFLOW
    }
    *flags_changed = FLAGS_ALL & !1 & !FLAG_OVERFLOW;
}
pub unsafe fn imul32(source_operand: i32) {
    let dest_operand = read_reg32(EAX);
    let result = dest_operand as i64 * source_operand as i64;
    let result_low = result as i32;
    let result_high = (result >> 32) as i32;
    write_reg32(EAX, result_low);
    write_reg32(EDX, result_high);
    *last_result = result_low;
    *last_op_size = OPSIZE_32;
    if result_high == result_low >> 31 {
        *flags &= !1 & !FLAG_OVERFLOW
    }
    else {
        *flags |= 1 | FLAG_OVERFLOW
    }
    *flags_changed = FLAGS_ALL & !1 & !FLAG_OVERFLOW;
}
pub unsafe fn imul_reg32(operand1: i32, operand2: i32) -> i32 {
    let result = operand1 as i64 * operand2 as i64;
    let result_low = result as i32;
    let result_high = (result >> 32) as i32;
    *last_result = result_low;
    *last_op_size = OPSIZE_32;
    if result_high == result_low >> 31 {
        *flags &= !1 & !FLAG_OVERFLOW
    }
    else {
        *flags |= 1 | FLAG_OVERFLOW
    }
    *flags_changed = FLAGS_ALL & !1 & !FLAG_OVERFLOW;
    return result_low;
}

#[no_mangle]
pub unsafe fn xadd8(source_operand: i32, reg: i32) -> i32 {
    let tmp = read_reg8(reg);
    write_reg8(reg, source_operand);
    return add(source_operand, tmp, OPSIZE_8);
}
#[no_mangle]
pub unsafe fn xadd16(source_operand: i32, reg: i32) -> i32 {
    let tmp = read_reg16(reg);
    write_reg16(reg, source_operand);
    return add(source_operand, tmp, OPSIZE_16);
}
pub unsafe fn xadd32(source_operand: i32, reg: i32) -> i32 {
    let tmp = read_reg32(reg);
    write_reg32(reg, source_operand);
    return add(source_operand, tmp, OPSIZE_32);
}

#[no_mangle]
pub unsafe fn cmpxchg8(data: i32, r: i32) -> i32 {
    cmp8(read_reg8(AL), data);
    if getzf() {
        read_reg8(r)
    }
    else {
        write_reg8(AL, data);
        data
    }
}
#[no_mangle]
pub unsafe fn cmpxchg16(data: i32, r: i32) -> i32 {
    cmp16(read_reg16(AX), data);
    if getzf() {
        read_reg16(r)
    }
    else {
        write_reg16(AX, data);
        data
    }
}
pub unsafe fn cmpxchg32(data: i32, r: i32) -> i32 {
    cmp32(read_reg32(EAX), data);
    if getzf() {
        read_reg32(r)
    }
    else {
        write_reg32(EAX, data);
        data
    }
}

#[no_mangle]
pub unsafe fn bcd_daa() {
    let old_al = read_reg8(AL);
    let old_cf = getcf();
    let old_af = getaf();
    *flags &= !1 & !FLAG_ADJUST;
    if old_al & 15 > 9 || old_af {
        write_reg8(AL, read_reg8(AL) + 6);
        *flags |= FLAG_ADJUST
    }
    if old_al > 153 || old_cf {
        write_reg8(AL, read_reg8(AL) + 96);
        *flags |= 1
    }
    *last_result = read_reg8(AL);
    *last_op_size = OPSIZE_8;
    *flags_changed = FLAGS_ALL & !1 & !FLAG_ADJUST & !FLAG_OVERFLOW;
}
#[no_mangle]
pub unsafe fn bcd_das() {
    let old_al = read_reg8(AL);
    let old_cf = getcf();
    *flags &= !1;
    if old_al & 15 > 9 || getaf() {
        write_reg8(AL, read_reg8(AL) - 6);
        *flags |= FLAG_ADJUST;
        *flags = *flags & !1 | old_cf as i32 | (old_al < 6) as i32
    }
    else {
        *flags &= !FLAG_ADJUST
    }
    if old_al > 153 || old_cf {
        write_reg8(AL, read_reg8(AL) - 96);
        *flags |= 1
    }
    *last_result = read_reg8(AL);
    *last_op_size = OPSIZE_8;
    *flags_changed = FLAGS_ALL & !1 & !FLAG_ADJUST & !FLAG_OVERFLOW;
}
#[no_mangle]
pub unsafe fn bcd_aad(imm8: i32) {
    let result = read_reg8(AL) + read_reg8(AH) * imm8;
    *last_result = result & 255;
    write_reg16(AX, *last_result);
    *last_op_size = OPSIZE_8;
    *flags_changed = FLAGS_ALL & !1 & !FLAG_ADJUST & !FLAG_OVERFLOW;
    *flags &= !1 & !FLAG_ADJUST & !FLAG_OVERFLOW;
    if result > 0xFFFF {
        *flags |= 1
    };
}
#[no_mangle]
pub unsafe fn bcd_aam(imm8: i32) {
    // ascii adjust after multiplication
    if imm8 == 0 {
        trigger_de();
    }
    else {
        let temp = read_reg8(AL);
        write_reg8(AH, temp as i32 / imm8);
        write_reg8(AL, temp as i32 % imm8);
        *last_result = read_reg8(AL);
        *last_op_size = OPSIZE_8;
        *flags_changed = FLAGS_ALL & !1 & !FLAG_ADJUST & !FLAG_OVERFLOW;
        *flags &= !1 & !FLAG_ADJUST & !FLAG_OVERFLOW
    };
}
#[no_mangle]
pub unsafe fn bcd_aaa() {
    if read_reg8(AL) & 15 > 9 || getaf() {
        write_reg16(AX, read_reg16(AX) + 6);
        write_reg8(AH, read_reg8(AH) + 1);
        *flags |= FLAG_ADJUST | 1
    }
    else {
        *flags &= !FLAG_ADJUST & !1
    }
    write_reg8(AL, read_reg8(AL) & 15);
    *flags_changed &= !FLAG_ADJUST & !1;
}
#[no_mangle]
pub unsafe fn bcd_aas() {
    if read_reg8(AL) & 15 > 9 || getaf() {
        write_reg16(AX, read_reg16(AX) - 6);
        write_reg8(AH, read_reg8(AH) - 1);
        *flags |= FLAG_ADJUST | 1
    }
    else {
        *flags &= !FLAG_ADJUST & !1
    }
    write_reg8(AL, read_reg8(AL) & 15);
    *flags_changed &= !FLAG_ADJUST & !1;
}
unsafe fn and(dest_operand: i32, source_operand: i32, op_size: i32) -> i32 {
    let result = dest_operand & source_operand;
    *last_result = result;
    *last_op_size = op_size;
    *flags &= !1 & !FLAG_OVERFLOW & !FLAG_ADJUST;
    *flags_changed = FLAGS_ALL & !1 & !FLAG_OVERFLOW & !FLAG_ADJUST;
    return result;
}
unsafe fn or(dest_operand: i32, source_operand: i32, op_size: i32) -> i32 {
    let result = dest_operand | source_operand;
    *last_result = result;
    *last_op_size = op_size;
    *flags &= !1 & !FLAG_OVERFLOW & !FLAG_ADJUST;
    *flags_changed = FLAGS_ALL & !1 & !FLAG_OVERFLOW & !FLAG_ADJUST;
    return result;
}
unsafe fn xor(dest_operand: i32, source_operand: i32, op_size: i32) -> i32 {
    let result = dest_operand ^ source_operand;
    *last_result = result;
    *last_op_size = op_size;
    *flags &= !1 & !FLAG_OVERFLOW & !FLAG_ADJUST;
    *flags_changed = FLAGS_ALL & !1 & !FLAG_OVERFLOW & !FLAG_ADJUST;
    return result;
}
pub unsafe fn and8(x: i32, y: i32) -> i32 { return and(x, y, OPSIZE_8); }
#[no_mangle]
pub unsafe fn and16(x: i32, y: i32) -> i32 { return and(x, y, OPSIZE_16); }
pub unsafe fn and32(x: i32, y: i32) -> i32 { return and(x, y, OPSIZE_32); }
pub unsafe fn test8(x: i32, y: i32) { and(x, y, OPSIZE_8); }
pub unsafe fn test16(x: i32, y: i32) { and(x, y, OPSIZE_16); }
pub unsafe fn test32(x: i32, y: i32) { and(x, y, OPSIZE_32); }
pub unsafe fn or8(x: i32, y: i32) -> i32 { return or(x, y, OPSIZE_8); }
#[no_mangle]
pub unsafe fn or16(x: i32, y: i32) -> i32 { return or(x, y, OPSIZE_16); }
pub unsafe fn or32(x: i32, y: i32) -> i32 { return or(x, y, OPSIZE_32); }
pub unsafe fn xor8(x: i32, y: i32) -> i32 { return xor(x, y, OPSIZE_8); }
#[no_mangle]
pub unsafe fn xor16(x: i32, y: i32) -> i32 { return xor(x, y, OPSIZE_16); }
pub unsafe fn xor32(x: i32, y: i32) -> i32 { return xor(x, y, OPSIZE_32); }

#[no_mangle]
pub unsafe fn rol8(dest_operand: i32, mut count: i32) -> i32 {
    dbg_assert!(count >= 0 && count < 32);
    if 0 == count {
        return dest_operand;
    }
    else {
        count &= 7;
        let result = dest_operand << count | dest_operand >> 8 - count;
        *flags_changed &= !1 & !FLAG_OVERFLOW;
        *flags = *flags & !1 & !FLAG_OVERFLOW
            | result & 1
            | (result << 11 ^ result << 4) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe fn rol16(dest_operand: i32, mut count: i32) -> i32 {
    dbg_assert!(count >= 0 && count < 32);
    if 0 == count {
        return dest_operand;
    }
    else {
        count &= 15;
        let result = dest_operand << count | dest_operand >> 16 - count;
        *flags_changed &= !1 & !FLAG_OVERFLOW;
        *flags = *flags & !1 & !FLAG_OVERFLOW
            | result & 1
            | (result << 11 ^ result >> 4) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe fn rol32(dest_operand: i32, count: i32) -> i32 {
    dbg_assert!(count >= 0 && count < 32);
    if 0 == count {
        return dest_operand;
    }
    else {
        let result = ((dest_operand << count) as u32 | dest_operand as u32 >> 32 - count) as i32;
        *flags_changed &= !1 & !FLAG_OVERFLOW;
        *flags = *flags & !1 & !FLAG_OVERFLOW
            | result & 1
            | (result << 11 ^ result >> 20) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe fn rcl8(dest_operand: i32, mut count: i32) -> i32 {
    dbg_assert!(count >= 0 && count < 32);
    count %= 9;
    if 0 == count {
        return dest_operand;
    }
    else {
        let result =
            dest_operand << count | (getcf() as i32) << count - 1 | dest_operand >> 9 - count;
        *flags_changed &= !1 & !FLAG_OVERFLOW;
        *flags = *flags & !1 & !FLAG_OVERFLOW
            | result >> 8 & 1
            | (result << 3 ^ result << 4) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe fn rcl16(dest_operand: i32, mut count: i32) -> i32 {
    dbg_assert!(count >= 0 && count < 32);
    count %= 17;
    if 0 == count {
        return dest_operand;
    }
    else {
        let result =
            dest_operand << count | (getcf() as i32) << count - 1 | dest_operand >> 17 - count;
        *flags_changed &= !1 & !FLAG_OVERFLOW;
        *flags = *flags & !1 & !FLAG_OVERFLOW
            | result >> 16 & 1
            | (result >> 5 ^ result >> 4) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe fn rcl32(dest_operand: i32, count: i32) -> i32 {
    dbg_assert!(count >= 0 && count < 32);
    if 0 == count {
        return dest_operand;
    }
    else {
        let mut result = dest_operand << count | (getcf() as i32) << count - 1;
        if count > 1 {
            result = (result as u32 | dest_operand as u32 >> 33 - count) as i32
        }
        *flags_changed &= !1 & !FLAG_OVERFLOW;
        let b = (dest_operand as u32 >> 32 - count & 1) as i32;
        *flags = (*flags & !1 & !FLAG_OVERFLOW | b) | (b << 11 ^ result >> 20) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe fn ror8(dest_operand: i32, mut count: i32) -> i32 {
    dbg_assert!(count >= 0 && count < 32);
    if 0 == count {
        return dest_operand;
    }
    else {
        count &= 7;
        let result = dest_operand >> count | dest_operand << 8 - count;
        *flags_changed &= !1 & !FLAG_OVERFLOW;
        *flags = *flags & !1 & !FLAG_OVERFLOW
            | result >> 7 & 1
            | (result << 4 ^ result << 5) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe fn ror16(dest_operand: i32, mut count: i32) -> i32 {
    dbg_assert!(count >= 0 && count < 32);
    if 0 == count {
        return dest_operand;
    }
    else {
        count &= 15;
        let result = dest_operand >> count | dest_operand << 16 - count;
        *flags_changed &= !1 & !FLAG_OVERFLOW;
        *flags = *flags & !1 & !FLAG_OVERFLOW
            | result >> 15 & 1
            | (result >> 4 ^ result >> 3) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe fn ror32(dest_operand: i32, count: i32) -> i32 {
    dbg_assert!(count >= 0 && count < 32);
    if 0 == count {
        return dest_operand;
    }
    else {
        let result = (dest_operand as u32 >> count | (dest_operand << 32 - count) as u32) as i32;
        *flags_changed &= !1 & !FLAG_OVERFLOW;
        *flags = *flags & !1 & !FLAG_OVERFLOW
            | result >> 31 & 1
            | (result >> 20 ^ result >> 19) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe fn rcr8(dest_operand: i32, mut count: i32) -> i32 {
    dbg_assert!(count >= 0 && count < 32);
    count %= 9;
    if 0 == count {
        return dest_operand;
    }
    else {
        let result =
            dest_operand >> count | (getcf() as i32) << 8 - count | dest_operand << 9 - count;
        *flags_changed &= !1 & !FLAG_OVERFLOW;
        *flags = *flags & !1 & !FLAG_OVERFLOW
            | result >> 8 & 1
            | (result << 4 ^ result << 5) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe fn rcr16(dest_operand: i32, mut count: i32) -> i32 {
    dbg_assert!(count >= 0 && count < 32);
    count %= 17;
    if 0 == count {
        return dest_operand;
    }
    else {
        let result =
            dest_operand >> count | (getcf() as i32) << 16 - count | dest_operand << 17 - count;
        *flags_changed &= !1 & !FLAG_OVERFLOW;
        *flags = *flags & !1 & !FLAG_OVERFLOW
            | result >> 16 & 1
            | (result >> 4 ^ result >> 3) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe fn rcr32(dest_operand: i32, count: i32) -> i32 {
    dbg_assert!(count >= 0 && count < 32);
    if 0 == count {
        return dest_operand;
    }
    else {
        let mut result =
            (dest_operand as u32 >> count | ((getcf() as i32) << 32 - count) as u32) as i32;
        if count > 1 {
            result |= dest_operand << 33 - count
        }
        *flags_changed &= !1 & !FLAG_OVERFLOW;
        *flags = *flags & !1 & !FLAG_OVERFLOW
            | dest_operand >> count - 1 & 1
            | (result >> 20 ^ result >> 19) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe fn div8(source_operand: u32) {
    if source_operand == 0 {
        trigger_de();
        return;
    }
    let target_operand = read_reg16(AX) as u32;
    let result = target_operand / source_operand;
    if result >= 0x100 {
        trigger_de();
        return;
    }
    write_reg8(AL, result as i32);
    write_reg8(AH, (target_operand % source_operand) as i32);
}

#[no_mangle]
pub unsafe fn idiv8(source_operand: i32) {
    if source_operand == 0 {
        trigger_de();
        return;
    }
    let target_operand = read_reg16(AX) << 16 >> 16;
    let result = target_operand / source_operand;
    if result >= 0x80 || result < -0x80 {
        trigger_de();
        return;
    }
    write_reg8(AL, result);
    write_reg8(AH, target_operand % source_operand);
}

#[no_mangle]
pub unsafe fn div16_without_fault(source_operand: u32) -> bool {
    let target_operand = (read_reg16(AX) | read_reg16(DX) << 16) as u32;
    let result = match target_operand.checked_div(source_operand) {
        None => return false,
        Some(r) => r,
    };
    if result >= 0x10000 {
        return false;
    }
    write_reg16(AX, result as i32);
    write_reg16(DX, (target_operand % source_operand) as i32);
    return true;
}
pub unsafe fn div16(source_operand: u32) {
    if !div16_without_fault(source_operand) {
        trigger_de()
    }
}
#[no_mangle]
pub unsafe fn idiv16_without_fault(source_operand: i32) -> bool {
    let target_operand = read_reg16(AX) | read_reg16(DX) << 16;
    let result = match target_operand.checked_div(source_operand) {
        None => return false,
        Some(r) => r,
    };
    if result >= 0x8000 || result < -0x8000 {
        return false;
    }
    write_reg16(AX, result);
    write_reg16(DX, (target_operand % source_operand) as i32);
    return true;
}
pub unsafe fn idiv16(source_operand: i32) {
    if !idiv16_without_fault(source_operand) {
        trigger_de()
    }
}

#[no_mangle]
pub unsafe fn div32_without_fault(source_operand: u32) -> bool {
    let source_operand = source_operand as u64;
    let target_low = read_reg32(EAX) as u32;
    let target_high = read_reg32(EDX) as u32;
    let target_operand = (target_high as u64) << 32 | target_low as u64;
    let result = match target_operand.checked_div(source_operand) {
        None => return false,
        Some(r) => r,
    };
    if result > 0xFFFFFFFF {
        return false;
    }
    let modulo = target_operand % source_operand;
    write_reg32(EAX, result as i32);
    write_reg32(EDX, modulo as i32);
    return true;
}
pub unsafe fn div32(source_operand: u32) {
    if !div32_without_fault(source_operand) {
        trigger_de()
    }
}
#[no_mangle]
pub unsafe fn idiv32_without_fault(source_operand: i32) -> bool {
    let source_operand = source_operand as i64;
    let target_low = read_reg32(EAX) as u32;
    let target_high = read_reg32(EDX) as u32;
    let target_operand = (target_high as i64) << 32 | target_low as i64;
    let result = match target_operand.checked_div(source_operand) {
        None => return false,
        Some(r) => r,
    };
    if result < -0x80000000 || result > 0x7FFFFFFF {
        return false;
    }
    let modulo = target_operand % source_operand;
    write_reg32(EAX, result as i32);
    write_reg32(EDX, modulo as i32);
    return true;
}
pub unsafe fn idiv32(source_operand: i32) {
    if !idiv32_without_fault(source_operand) {
        trigger_de()
    }
}

#[no_mangle]
pub unsafe fn shl8(dest_operand: i32, count: i32) -> i32 {
    dbg_assert!(count >= 0 && count < 32);
    if count == 0 {
        return dest_operand;
    }
    else {
        let result = dest_operand << count;
        *last_result = result;
        *last_op_size = OPSIZE_8;
        *flags_changed = FLAGS_ALL & !1 & !FLAG_OVERFLOW;
        *flags = *flags & !1 & !FLAG_OVERFLOW
            | result >> 8 & 1
            | (result << 3 ^ result << 4) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe fn shl16(dest_operand: i32, count: i32) -> i32 {
    dbg_assert!(count >= 0 && count < 32);
    if count == 0 {
        return dest_operand;
    }
    else {
        let result = dest_operand << count;
        *last_result = result;
        *last_op_size = OPSIZE_16;
        *flags_changed = FLAGS_ALL & !1 & !FLAG_OVERFLOW;
        *flags = *flags & !1 & !FLAG_OVERFLOW
            | result >> 16 & 1
            | (result >> 5 ^ result >> 4) & FLAG_OVERFLOW;
        return result;
    };
}
pub unsafe fn shl32(dest_operand: i32, count: i32) -> i32 {
    dbg_assert!(count >= 0 && count < 32);
    if count == 0 {
        return dest_operand;
    }
    else {
        let result = dest_operand << count;
        *last_result = result;
        *last_op_size = OPSIZE_32;
        *flags_changed = FLAGS_ALL & !1 & !FLAG_OVERFLOW;
        let b = dest_operand >> 32 - count & 1;
        *flags = *flags & !1 & !FLAG_OVERFLOW | b | (b ^ result >> 31) << 11 & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe fn shr8(dest_operand: i32, count: i32) -> i32 {
    dbg_assert!(count >= 0 && count < 32);
    if count == 0 {
        return dest_operand;
    }
    else {
        let result = dest_operand >> count;
        *last_result = result;
        *last_op_size = OPSIZE_8;
        *flags_changed = FLAGS_ALL & !1 & !FLAG_OVERFLOW;
        *flags = *flags & !1 & !FLAG_OVERFLOW
            | dest_operand >> count - 1 & 1
            | (dest_operand >> 7 & 1) << 11 & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe fn shr16(dest_operand: i32, count: i32) -> i32 {
    dbg_assert!(count >= 0 && count < 32);
    if count == 0 {
        return dest_operand;
    }
    else {
        let result = dest_operand >> count;
        *last_result = result;
        *last_op_size = OPSIZE_16;
        *flags_changed = FLAGS_ALL & !1 & !FLAG_OVERFLOW;
        *flags = *flags & !1 & !FLAG_OVERFLOW
            | dest_operand >> count - 1 & 1
            | dest_operand >> 4 & FLAG_OVERFLOW;
        return result;
    };
}
pub unsafe fn shr32(dest_operand: i32, count: i32) -> i32 {
    dbg_assert!(count >= 0 && count < 32);
    if count == 0 {
        return dest_operand;
    }
    else {
        let result = (dest_operand as u32 >> count) as i32;
        *last_result = result;
        *last_op_size = OPSIZE_32;
        *flags_changed = FLAGS_ALL & !1 & !FLAG_OVERFLOW;
        *flags = (*flags & !1 & !FLAG_OVERFLOW)
            | (dest_operand as u32 >> count - 1 & 1) as i32
            | (dest_operand >> 20 & FLAG_OVERFLOW);
        return result;
    };
}
#[no_mangle]
pub unsafe fn sar8(dest_operand: i32, count: i32) -> i32 {
    dbg_assert!(count >= 0 && count < 32);
    if count == 0 {
        return dest_operand;
    }
    else {
        let result;
        if count < 8 {
            result = dest_operand << 24 >> count + 24;
            // of is zero
            *flags = *flags & !1 & !FLAG_OVERFLOW | dest_operand >> count - 1 & 1
        }
        else {
            result = dest_operand << 24 >> 31;
            *flags = *flags & !1 & !FLAG_OVERFLOW | result & 1
        }
        *last_result = result;
        *last_op_size = OPSIZE_8;
        *flags_changed = FLAGS_ALL & !1 & !FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe fn sar16(dest_operand: i32, count: i32) -> i32 {
    dbg_assert!(count >= 0 && count < 32);
    if count == 0 {
        return dest_operand;
    }
    else {
        let result;
        if count < 16 {
            result = dest_operand << 16 >> count + 16;
            *flags = *flags & !1 & !FLAG_OVERFLOW | dest_operand >> count - 1 & 1
        }
        else {
            result = dest_operand << 16 >> 31;
            *flags = *flags & !1 & !FLAG_OVERFLOW | result & 1
        }
        *last_result = result;
        *last_op_size = OPSIZE_16;
        *flags_changed = FLAGS_ALL & !1 & !FLAG_OVERFLOW;
        return result;
    };
}
pub unsafe fn sar32(dest_operand: i32, count: i32) -> i32 {
    dbg_assert!(count >= 0 && count < 32);
    if count == 0 {
        return dest_operand;
    }
    else {
        let result = dest_operand >> count;
        *last_result = result;
        *last_op_size = OPSIZE_32;
        *flags_changed = FLAGS_ALL & !1 & !FLAG_OVERFLOW;
        *flags = (*flags & !1 & !FLAG_OVERFLOW) | (dest_operand as u32 >> count - 1 & 1) as i32;
        return result;
    };
}

#[no_mangle]
pub unsafe fn shrd16(dest_operand: i32, source_operand: i32, count: i32) -> i32 {
    dbg_assert!(count >= 0 && count < 32);
    if count == 0 {
        return dest_operand;
    }
    else {
        let result;
        if count <= 16 {
            result = dest_operand >> count | source_operand << 16 - count;
            *flags = *flags & !1 | dest_operand >> count - 1 & 1
        }
        else {
            result = dest_operand << 32 - count | source_operand >> count - 16;
            *flags = *flags & !1 | source_operand >> count - 17 & 1
        }
        *last_result = result;
        *last_op_size = OPSIZE_16;
        *flags_changed = FLAGS_ALL & !1 & !FLAG_OVERFLOW;
        *flags = *flags & !FLAG_OVERFLOW | (result ^ dest_operand) >> 4 & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe fn shrd32(dest_operand: i32, source_operand: i32, count: i32) -> i32 {
    dbg_assert!(count >= 0 && count < 32);
    if count == 0 {
        return dest_operand;
    }
    else {
        let result = (dest_operand as u32 >> count | (source_operand << 32 - count) as u32) as i32;
        *last_result = result;
        *last_op_size = OPSIZE_32;
        *flags_changed = FLAGS_ALL & !1 & !FLAG_OVERFLOW;
        *flags = ((*flags & !1 & !FLAG_OVERFLOW) | (dest_operand as u32 >> count - 1 & 1) as i32)
            | (result ^ dest_operand) >> 20 & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe fn shld16(dest_operand: i32, source_operand: i32, count: i32) -> i32 {
    dbg_assert!(count >= 0 && count < 32);
    if count == 0 {
        return dest_operand;
    }
    else {
        let result;
        if count <= 16 {
            result = ((dest_operand << count) as u32 | source_operand as u32 >> 16 - count) as i32;
            *flags = (*flags & !1) | (dest_operand as u32 >> 16 - count & 1) as i32;
        }
        else {
            result = dest_operand >> 32 - count | source_operand << count - 16;
            *flags = (*flags & !1) | (source_operand as u32 >> 32 - count & 1) as i32;
        }
        *last_result = result;
        *last_op_size = OPSIZE_16;
        *flags_changed = FLAGS_ALL & !1 & !FLAG_OVERFLOW;
        *flags = *flags & !FLAG_OVERFLOW | (*flags & 1 ^ result >> 15 & 1) << 11;
        return result;
    };
}
#[no_mangle]
pub unsafe fn shld32(dest_operand: i32, source_operand: i32, count: i32) -> i32 {
    dbg_assert!(count >= 0 && count < 32);
    if count == 0 {
        return dest_operand;
    }
    else {
        let result = ((dest_operand << count) as u32 | source_operand as u32 >> 32 - count) as i32;
        *last_result = result;
        *last_op_size = OPSIZE_32;
        *flags_changed = FLAGS_ALL & !1 & !FLAG_OVERFLOW;
        *flags = (*flags & !1) | (dest_operand as u32 >> 32 - count & 1) as i32;
        if count == 1 {
            *flags = *flags & !FLAG_OVERFLOW | (*flags & 1 ^ result >> 31 & 1) << 11
        }
        else {
            *flags &= !FLAG_OVERFLOW
        }
        return result;
    };
}

pub unsafe fn bt_reg(bit_base: i32, bit_offset: i32) {
    *flags = *flags & !1 | bit_base >> bit_offset & 1;
    *flags_changed &= !1;
}
pub unsafe fn btc_reg(bit_base: i32, bit_offset: i32) -> i32 {
    *flags = *flags & !1 | bit_base >> bit_offset & 1;
    *flags_changed &= !1;
    return bit_base ^ 1 << bit_offset;
}
pub unsafe fn bts_reg(bit_base: i32, bit_offset: i32) -> i32 {
    *flags = *flags & !1 | bit_base >> bit_offset & 1;
    *flags_changed &= !1;
    return bit_base | 1 << bit_offset;
}
pub unsafe fn btr_reg(bit_base: i32, bit_offset: i32) -> i32 {
    *flags = *flags & !1 | bit_base >> bit_offset & 1;
    *flags_changed &= !1;
    return bit_base & !(1 << bit_offset);
}

pub unsafe fn bt_mem(virt_addr: i32, mut bit_offset: i32) {
    let bit_base = return_on_pagefault!(safe_read8(virt_addr + (bit_offset >> 3)));
    bit_offset &= 7;
    *flags = *flags & !1 | bit_base >> bit_offset & 1;
    *flags_changed &= !1;
}
pub unsafe fn btc_mem(virt_addr: i32, mut bit_offset: i32) {
    let phys_addr = return_on_pagefault!(translate_address_write(virt_addr + (bit_offset >> 3)));
    let bit_base = read8(phys_addr);
    bit_offset &= 7;
    *flags = *flags & !1 | bit_base >> bit_offset & 1;
    *flags_changed &= !1;
    write8(phys_addr, bit_base ^ 1 << bit_offset);
}
pub unsafe fn btr_mem(virt_addr: i32, mut bit_offset: i32) {
    let phys_addr = return_on_pagefault!(translate_address_write(virt_addr + (bit_offset >> 3)));
    let bit_base = read8(phys_addr);
    bit_offset &= 7;
    *flags = *flags & !1 | bit_base >> bit_offset & 1;
    *flags_changed &= !1;
    write8(phys_addr, bit_base & !(1 << bit_offset));
}
pub unsafe fn bts_mem(virt_addr: i32, mut bit_offset: i32) {
    let phys_addr = return_on_pagefault!(translate_address_write(virt_addr + (bit_offset >> 3)));
    let bit_base = read8(phys_addr);
    bit_offset &= 7;
    *flags = *flags & !1 | bit_base >> bit_offset & 1;
    *flags_changed &= !1;
    write8(phys_addr, bit_base | 1 << bit_offset);
}

#[no_mangle]
pub unsafe fn bsf16(old: i32, bit_base: i32) -> i32 {
    *flags_changed = FLAGS_ALL & !FLAG_ZERO & !FLAG_CARRY;
    *flags &= !FLAG_CARRY;
    *last_op_size = OPSIZE_16;
    if bit_base == 0 {
        *flags |= FLAG_ZERO;
        *last_result = bit_base;
        // not defined in the docs, but value doesn't change on my intel machine
        return old;
    }
    else {
        *flags &= !FLAG_ZERO;
        *last_result = int_log2(-bit_base & bit_base);
        return *last_result;
    };
}
#[no_mangle]
pub unsafe fn bsf32(old: i32, bit_base: i32) -> i32 {
    *flags_changed = FLAGS_ALL & !FLAG_ZERO & !FLAG_CARRY;
    *flags &= !FLAG_CARRY;
    *last_op_size = OPSIZE_32;
    if bit_base == 0 {
        *flags |= FLAG_ZERO;
        *last_result = bit_base;
        return old;
    }
    else {
        *flags &= !FLAG_ZERO;
        *last_result = int_log2(-bit_base & bit_base);
        return *last_result;
    };
}
#[no_mangle]
pub unsafe fn bsr16(old: i32, bit_base: i32) -> i32 {
    *flags_changed = FLAGS_ALL & !FLAG_ZERO & !FLAG_CARRY;
    *flags &= !FLAG_CARRY;
    *last_op_size = OPSIZE_16;
    if bit_base == 0 {
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
pub unsafe fn bsr32(old: i32, bit_base: i32) -> i32 {
    *flags_changed = FLAGS_ALL & !FLAG_ZERO & !FLAG_CARRY;
    *flags &= !FLAG_CARRY;
    *last_op_size = OPSIZE_32;
    if bit_base == 0 {
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
pub unsafe fn popcnt(v: i32) -> i32 {
    *flags_changed = 0;
    *flags &= !FLAGS_ALL;
    if 0 != v {
        return v.count_ones() as i32;
    }
    else {
        *flags |= FLAG_ZERO;
        return 0;
    };
}

pub unsafe fn saturate_sw_to_ub(v: u16) -> u8 {
    let mut ret = v;
    if ret >= 32768 {
        ret = 0
    }
    else if ret > 255 {
        ret = 255
    }
    return ret as u8;
}
pub unsafe fn saturate_sw_to_sb(v: i32) -> u8 {
    dbg_assert!(v as u32 & 0xFFFF_0000 == 0);
    let mut ret = v;
    if ret > 65408 {
        ret = ret & 255
    }
    else if ret > 32767 {
        ret = 128
    }
    else if ret > 127 {
        ret = 127
    }
    dbg_assert!(ret as u32 & 0xFFFF_FF00 == 0);
    return ret as u8;
}
pub unsafe fn saturate_sd_to_sw(v: u32) -> u16 {
    let mut ret = v;
    if ret > 4294934528 {
        ret = ret & 0xFFFF
    }
    else if ret > 0x7FFFFFFF {
        ret = 32768
    }
    else if ret > 32767 {
        ret = 32767
    }
    dbg_assert!(ret & 0xFFFF_0000 == 0);
    return ret as u16;
}
pub unsafe fn saturate_sd_to_sb(v: u32) -> i8 {
    let mut ret = v;
    if ret > 0xFFFFFF80 {
        ret = ret & 255
    }
    else if ret > 0x7FFFFFFF {
        ret = 128
    }
    else if ret > 127 {
        ret = 127
    }
    dbg_assert!(ret & 0xFFFF_FF00 == 0);
    return ret as i8;
}
pub unsafe fn saturate_sd_to_ub(v: i32) -> i32 {
    let mut ret = v;
    if ret < 0 {
        ret = 0
    }
    dbg_assert!(ret as u32 & 0xFFFF_FF00 == 0);
    return ret;
}
pub unsafe fn saturate_ud_to_ub(v: u32) -> u8 {
    let mut ret = v;
    if ret > 255 {
        ret = 255
    }
    dbg_assert!(ret & 0xFFFF_FF00 == 0);
    return ret as u8;
}
pub unsafe fn saturate_uw(v: u32) -> u16 {
    let mut ret = v;
    if ret > 0x7FFFFFFF {
        ret = 0
    }
    else if ret > 0xFFFF {
        ret = 0xFFFF
    }
    dbg_assert!(ret & 0xFFFF_0000 == 0);
    return ret as u16;
}
