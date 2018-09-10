#![allow(unused_mut)]

use std::mem::transmute;

use cpu2::cpu::*;
use cpu2::global_pointers::*;
use paging::OrPageFault;

pub fn round(x: f64) -> f64 { x.round() }
pub fn floor(x: f64) -> f64 { x.floor() }
pub fn ceil(x: f64) -> f64 { x.ceil() }
pub fn pow(x: f64, y: f64) -> f64 { x.powf(y) }
pub fn convert_f64_to_i32(x: f64) -> i32 { x as i32 }
pub fn trunc(x: f64) -> f64 { x.trunc() }
pub fn fmod(x: f64, y: f64) -> f64 { x % y }

#[derive(Copy, Clone)]
#[repr(C)]
pub union f64_int {
    u8_0: [u8; 8],
    i32_0: [i32; 2],
    u64_0: [u64; 1],
    f64_0: f64,
}

#[derive(Copy, Clone)]
#[repr(C)]
pub union f32_int {
    u8_0: [u8; 4],
    i32_0: i32,
    f32_0: f32,
}

pub const M_LOG2E: f64 = 1.4426950408889634f64;
pub const M_LN2: f64 = 0.6931471805599453f64;
pub const M_LN10: f64 = 2.302585092994046f64;
pub const M_PI: f64 = 3.141592653589793f64;
const FPU_C0: i32 = 256;
pub const FPU_C1: i32 = 512;
const FPU_C2: i32 = 1024;
const FPU_C3: i32 = 16384;
const FPU_RESULT_FLAGS: i32 = FPU_C0 | FPU_C1 | FPU_C2 | FPU_C3;
const INDEFINITE_NAN: f64 = ::std::f64::NAN;
const FPU_EX_I: i32 = 1 << 0;
const FPU_EX_SF: i32 = 1 << 6;
const TWO_POW_63: f64 = 9223372036854775808u64 as f64;

pub fn fpu_write_st(index: i32, value: f64) {
    dbg_assert!(index >= 0 && index < 8);
    unsafe {
        *fxsave_store_fpu_mask |= 1 << index;
        *fpu_st.offset(index as isize) = value;
    }
}

#[no_mangle]
pub unsafe fn fpu_get_st0() -> f64 {
    if 0 != *fpu_stack_empty >> *fpu_stack_ptr & 1 {
        *fpu_status_word &= !FPU_C1;
        fpu_stack_fault();
        return INDEFINITE_NAN;
    }
    else {
        return *fpu_st.offset(*fpu_stack_ptr as isize);
    };
}
#[no_mangle]
pub unsafe fn fpu_stack_fault() {
    // TODO: Interrupt
    *fpu_status_word |= FPU_EX_SF | FPU_EX_I;
}
#[no_mangle]
pub unsafe fn fpu_get_sti(mut i: i32) -> f64 {
    dbg_assert!(i >= 0 && i < 8);
    i = ((i as u32).wrapping_add(*fpu_stack_ptr) & 7 as u32) as i32;
    if 0 != *fpu_stack_empty >> i & 1 {
        *fpu_status_word &= !FPU_C1;
        fpu_stack_fault();
        return INDEFINITE_NAN;
    }
    else {
        return *fpu_st.offset(i as isize);
    };
}
#[no_mangle]
pub unsafe fn fpu_integer_round(mut f: f64) -> f64 {
    let mut rc: i32 = *fpu_control_word >> 10 & 3;
    // XXX: See https://en.wikipedia.org/wiki/C_mathematical_functions
    if rc == 0 {
        // Round to nearest, or even if equidistant
        let mut rounded: f64 = round(f);
        let mut diff: f64 = rounded - f;
        if diff == 0.5f64 || diff == -0.5f64 {
            rounded = 2.0f64 * round(f * 0.5f64)
        }
        return rounded;
    }
    else if rc == 1 || rc == 3 && f > 0 as f64 {
        // rc=3 is truncate -> floor for positive numbers
        return floor(f);
    }
    else {
        return ceil(f);
    };
}
#[no_mangle]
pub unsafe fn fpu_load_m32(mut addr: i32) -> OrPageFault<f64> {
    let mut v: f32_int = f32_int {
        i32_0: safe_read32s(addr)?,
    };
    Ok(v.f32_0 as f64)
}
#[no_mangle]
pub unsafe fn fpu_load_m64(mut addr: i32) -> OrPageFault<f64> {
    let mut value: u64 = safe_read64s(addr)?.u64_0[0];
    let mut v: f64_int = f64_int { u64_0: [value] };
    Ok(v.f64_0)
}

#[no_mangle]
pub unsafe fn fpu_load_m80(mut addr: i32) -> OrPageFault<f64> {
    let mut value: u64 = safe_read64s(addr as i32)?.u64_0[0];
    let mut exponent: i32 = safe_read16(addr.wrapping_add(8) as i32)?;
    let f = fpu_i80_to_f64((value, exponent as u16));
    Ok(f)
}

pub unsafe fn fpu_i80_to_f64(i: (u64, u16)) -> f64 {
    let mut value: u64 = i.0;
    let mut low: u32 = value as u32;
    let mut high: u32 = (value >> 32) as u32;
    let mut exponent = i.1 as i32;
    let mut sign = exponent >> 15;
    exponent &= !32768;
    if exponent == 0 {
        let d: u64 = (sign as u64) << 63 | (high as u64) << 20 | (low as u64) >> 12;
        let f: f64 = transmute(d);
        f
    }
    else if exponent < 32767 {
        exponent -= 16383;
        // Note: some bits might be lost at this point
        let mut mantissa: f64 = low as f64 + 4294967296i64 as f64 * high as f64;
        if 0 != sign {
            mantissa = -mantissa
        }
        // Simply compute the 64 bit floating point number.
        // An alternative write the mantissa, sign and exponent in the
        // float64_byte and return float64[0]
        mantissa * pow(2 as f64, (exponent - 63) as f64)
    }
    else {
        // TODO: NaN, Infinity
        if 0 != 0 * 0 {
            dbg_log!("Load m80 TODO");
        }
        let mut double_int_view: f64_int = f64_int { u8_0: [0; 8] };
        double_int_view.u8_0[7] = (127 | sign << 7) as u8;
        double_int_view.u8_0[6] = (240 as u32 | high >> 30 << 3 & 8 as u32) as u8;
        double_int_view.u8_0[5] = 0 as u8;
        double_int_view.u8_0[4] = 0 as u8;
        double_int_view.i32_0[0] = 0;
        double_int_view.f64_0
    }
}

#[cfg(test)]
mod tests {
    use super::{f64_int, fpu_f64_to_i80, fpu_i80_to_f64};
    quickcheck! {
        fn i80_f64_conversion(d: u64) -> bool {
            let double_int_view = f64_int { u64_0: [d] };
            let f = unsafe { double_int_view.f64_0 };
            unsafe { f == fpu_i80_to_f64(fpu_f64_to_i80(f)) }
        }
    }

    #[test]
    fn more_i80_f64_conversions() {
        assert_eq!(unsafe { fpu_f64_to_i80(0.) }, (0, 0));
    }
}

#[no_mangle]
pub unsafe fn fpu_load_status_word() -> i32 {
    return ((*fpu_status_word & !(7 << 11)) as u32 | *fpu_stack_ptr << 11) as i32;
}
#[no_mangle]
pub unsafe fn fpu_fadd(mut target_index: i32, mut val: f64) {
    let mut st0: f64 = fpu_get_st0();
    fpu_write_st(*fpu_stack_ptr as i32 + target_index & 7, st0 + val);
}
#[no_mangle]
pub unsafe fn fpu_fclex() { *fpu_status_word = 0; }
#[no_mangle]
pub unsafe fn fpu_fcmovcc(mut condition: bool, mut r: i32) {
    if condition {
        fpu_write_st(*fpu_stack_ptr as i32, fpu_get_sti(r));
        *fpu_stack_empty &= !(1 << *fpu_stack_ptr)
    };
}
#[no_mangle]
pub unsafe fn fpu_fcom(mut y: f64) {
    let mut x: f64 = fpu_get_st0();
    *fpu_status_word &= !FPU_RESULT_FLAGS;
    if !(x > y) {
        if y > x {
            *fpu_status_word |= FPU_C0
        }
        else if x == y {
            *fpu_status_word |= FPU_C3
        }
        else {
            *fpu_status_word |= FPU_C0 | FPU_C2 | FPU_C3
        }
    };
}
#[no_mangle]
pub unsafe fn fpu_fcomi(mut r: i32) {
    let mut y: f64 = fpu_get_sti(r);
    let mut x: f64 = *fpu_st.offset(*fpu_stack_ptr as isize);
    *flags_changed &= !(1 | FLAG_PARITY | FLAG_ZERO);
    *flags &= !(1 | FLAG_PARITY | FLAG_ZERO);
    if !(x > y) {
        if y > x {
            *flags |= 1
        }
        else if x == y {
            *flags |= FLAG_ZERO
        }
        else {
            *flags |= 1 | FLAG_PARITY | FLAG_ZERO
        }
    };
}
#[no_mangle]
pub unsafe fn fpu_fcomip(mut r: i32) {
    fpu_fcomi(r);
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_pop() {
    *fpu_stack_empty |= 1 << *fpu_stack_ptr;
    *fpu_stack_ptr = (*fpu_stack_ptr).wrapping_add(1 as u32) & 7 as u32;
}
#[no_mangle]
pub unsafe fn fpu_fcomp(mut val: f64) {
    fpu_fcom(val);
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_fdiv(mut target_index: i32, mut val: f64) {
    let mut st0: f64 = fpu_get_st0();
    fpu_write_st(*fpu_stack_ptr as i32 + target_index & 7, st0 / val);
}
#[no_mangle]
pub unsafe fn fpu_fdivr(mut target_index: i32, mut val: f64) {
    let mut st0: f64 = fpu_get_st0();
    fpu_write_st(*fpu_stack_ptr as i32 + target_index & 7, val / st0);
}
#[no_mangle]
pub unsafe fn fpu_ffree(mut r: i32) {
    *fpu_stack_empty |= 1 << (*fpu_stack_ptr).wrapping_add(r as u32);
}
#[no_mangle]
pub unsafe fn fpu_fildm64(mut addr: i32) {
    let mut value: i64 = return_on_pagefault!(safe_read64s(addr)).i64_0[0];
    let mut m64: f64 = value as f64;
    fpu_push(m64);
}
#[no_mangle]
pub unsafe fn fpu_push(mut x: f64) {
    *fpu_stack_ptr = (*fpu_stack_ptr).wrapping_sub(1 as u32) & 7 as u32;
    if 0 != *fpu_stack_empty >> *fpu_stack_ptr & 1 {
        *fpu_status_word &= !FPU_C1;
        *fpu_stack_empty &= !(1 << *fpu_stack_ptr);
        fpu_write_st(*fpu_stack_ptr as i32, x);
    }
    else {
        *fpu_status_word |= FPU_C1;
        fpu_stack_fault();
        fpu_write_st(*fpu_stack_ptr as i32, INDEFINITE_NAN);
    };
}
#[no_mangle]
pub unsafe fn fpu_finit() {
    *fpu_control_word = 895;
    *fpu_status_word = 0;
    *fpu_ip = 0;
    *fpu_dp = 0;
    *fpu_opcode = 0;
    *fpu_stack_empty = 255;
    *fpu_stack_ptr = 0 as u32;
}
#[no_mangle]
pub unsafe fn fpu_fistm16(mut addr: i32) {
    let mut st0: f64 = fpu_integer_round(fpu_get_st0());
    if st0 <= 32767 as f64 && st0 >= -32768 as f64 {
        return_on_pagefault!(safe_write16(addr, st0 as i32));
    }
    else {
        fpu_invalid_arithmetic();
        return_on_pagefault!(safe_write16(addr, 32768));
    };
}
#[no_mangle]
pub unsafe fn fpu_invalid_arithmetic() { *fpu_status_word |= FPU_EX_I; }
#[no_mangle]
pub unsafe fn fpu_fistm16p(mut addr: i32) {
    fpu_fistm16(addr);
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_fistm32(mut addr: i32) {
    let mut st0: f64 = fpu_integer_round(fpu_get_st0());
    let mut i: i32 = convert_f64_to_i32(st0);
    if i == -0x80000000 {
        // XXX: Probably not correct if st0 == 0x80000000
        // (input fits, but same value as error value)
        fpu_invalid_arithmetic();
    }
    return_on_pagefault!(safe_write32(addr, i));
}
#[no_mangle]
pub unsafe fn fpu_fistm32p(mut addr: i32) {
    fpu_fistm32(addr);
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_fistm64p(mut addr: i32) {
    let mut st0: f64 = fpu_integer_round(fpu_get_st0());
    let mut value;
    if st0 < TWO_POW_63 && st0 >= -TWO_POW_63 {
        value = st0 as i64
    }
    else {
        value = 9223372036854775808u64 as i64;
        fpu_invalid_arithmetic();
    }
    return_on_pagefault!(safe_write64(addr, value));
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_fldcw(mut addr: i32) {
    let mut word: i32 = return_on_pagefault!(safe_read16(addr));
    *fpu_control_word = word;
}
#[no_mangle]
pub unsafe fn fpu_fldenv(mut addr: i32) {
    if is_osize_32() {
        // TODO: Add readable_or_pagefault
        return_on_pagefault!(translate_address_read(addr));
        return_on_pagefault!(translate_address_read(addr + 28));
        *fpu_control_word = safe_read16(addr).unwrap();
        fpu_set_status_word(safe_read16(addr + 4).unwrap());
        fpu_set_tag_word(safe_read16(addr + 8).unwrap());
        *fpu_ip = safe_read32s(addr + 12).unwrap();
        *fpu_ip_selector = safe_read16(addr + 16).unwrap();
        *fpu_opcode = safe_read16(addr + 18).unwrap();
        *fpu_dp = safe_read32s(addr + 20).unwrap();
        *fpu_dp_selector = safe_read16(addr + 24).unwrap()
    }
    else {
        dbg_log!("fldenv16");
        fpu_unimpl();
    };
}
#[no_mangle]
pub unsafe fn fpu_unimpl() {
    if DEBUG {
        dbg_assert!(0 != 0);
    }
    else {
        trigger_ud();
    };
}
#[no_mangle]
pub unsafe fn fpu_set_tag_word(mut tag_word: i32) {
    *fpu_stack_empty = 0;
    let mut i: i32 = 0;
    while i < 8 {
        let empty = tag_word >> (2 * i) & 3 == 3;
        *fpu_stack_empty |= (empty as i32) << i;
        i += 1
    }
}
#[no_mangle]
pub unsafe fn fpu_set_status_word(mut sw: i32) {
    *fpu_status_word = sw & !(7 << 11);
    *fpu_stack_ptr = (sw >> 11 & 7) as u32;
}
#[no_mangle]
pub unsafe fn fpu_fldm32(mut addr: i32) {
    fpu_push(return_on_pagefault!(safe_read32s(addr)) as f64);
}
#[no_mangle]
pub unsafe fn fpu_fldm64(mut addr: i32) { fpu_push(return_on_pagefault!(fpu_load_m64(addr))); }
#[no_mangle]
pub unsafe fn fpu_fldm80(mut addr: i32) { fpu_push(return_on_pagefault!(fpu_load_m80(addr))); }
#[no_mangle]
pub unsafe fn fpu_fmul(mut target_index: i32, mut val: f64) {
    let mut st0: f64 = fpu_get_st0();
    fpu_write_st(*fpu_stack_ptr as i32 + target_index & 7, st0 * val);
}
#[no_mangle]
pub unsafe fn fpu_fnstsw_mem(mut addr: i32) {
    return_on_pagefault!(safe_write16(addr, fpu_load_status_word()));
}
#[no_mangle]
pub unsafe fn fpu_fnstsw_reg() { *reg16.offset(AX as isize) = fpu_load_status_word() as u16; }
#[no_mangle]
pub unsafe fn fpu_fprem() {
    // XXX: This implementation differs from the description in Intel's manuals
    let mut st0: f64 = fpu_get_st0();
    let mut st1: f64 = fpu_get_sti(1);
    let mut fprem_quotient: i32 = convert_f64_to_i32(trunc(st0 / st1));
    fpu_write_st(*fpu_stack_ptr as i32, fmod(st0, st1));
    *fpu_status_word &= !(FPU_C0 | FPU_C1 | FPU_C3);
    if 0 != fprem_quotient & 1 {
        *fpu_status_word |= FPU_C1
    }
    if 0 != fprem_quotient & 1 << 1 {
        *fpu_status_word |= FPU_C3
    }
    if 0 != fprem_quotient & 1 << 2 {
        *fpu_status_word |= FPU_C0
    }
    *fpu_status_word &= !FPU_C2;
}
#[no_mangle]
pub unsafe fn fpu_frstor(mut addr: i32) {
    // TODO: Add readable_or_pagefault
    return_on_pagefault!(translate_address_read(addr));
    return_on_pagefault!(translate_address_read(addr + 28 + 8 * 10));
    fpu_fldenv(addr);
    addr += 28;
    let mut i: i32 = 0;
    while i < 8 {
        let reg_index = *fpu_stack_ptr as i32 + i & 7;
        *fpu_st.offset(reg_index as isize) = fpu_load_m80(addr).unwrap();
        *reg_mmx.offset(reg_index as isize) = safe_read64s(addr).unwrap();
        addr += 10;
        i += 1
    }

    *fxsave_store_fpu_mask = 0xff;
}
#[no_mangle]
pub unsafe fn fpu_fsave(mut addr: i32) {
    return_on_pagefault!(writable_or_pagefault(addr, 108));
    fpu_fstenv(addr);
    addr += 28;
    let mut i: i32 = 0;
    while i < 8 {
        let reg_index = i + *fpu_stack_ptr as i32 & 7;
        if *fxsave_store_fpu_mask & 1 << reg_index != 0 {
            fpu_store_m80(addr, *fpu_st.offset(reg_index as isize));
        }
        else {
            safe_write64(addr, (*reg_mmx.offset(reg_index as isize)).i64_0[0]).unwrap();
        }
        addr += 10;
        i += 1
    }
    fpu_finit();
}

#[no_mangle]
pub unsafe fn fpu_store_m80(mut addr: i32, mut n: f64) {
    let (value, exponent) = fpu_f64_to_i80(n);
    // writable_or_pagefault must have checked called by the caller!
    safe_write64(addr, value as i64).unwrap();
    safe_write16(addr + 8, exponent as i32).unwrap();
}

pub unsafe fn fpu_f64_to_i80(f: f64) -> (u64, u16) {
    let mut double_int_view: f64_int = f64_int { f64_0: f };
    let mut sign: u8 = double_int_view.u8_0[7] >> 7;
    let mut exponent: i32 =
        (double_int_view.u8_0[7] as i32 & 127) << 4 | double_int_view.u8_0[6] as i32 >> 4;
    let mantissa = double_int_view.u64_0[0] & ((1 << 52) - 1);
    let mut low;
    let mut high;
    if exponent == 2047 {
        // all bits set (NaN and infinity)
        exponent = 32767;
        low = 0;
        high = (2147483648 | ((double_int_view.i32_0[1] & 524288) << 11) as u32) as i32
    }
    else if exponent == 0 {
        // zero and denormal numbers
        return (mantissa << 12, (sign as u16) << 15);
    }
    else {
        exponent += 16383 - 1023;
        // does the mantissa need to be adjusted?
        low = double_int_view.i32_0[0] << 11;
        high = (2147483648
            | ((double_int_view.i32_0[1] & 1048575) << 11) as u32
            | double_int_view.i32_0[0] as u32 >> 21) as i32
    }
    dbg_assert!(exponent >= 0 && exponent < 32768);
    (
        (low as u64 & 4294967295 as u64 | (high as u64) << 32) as u64,
        ((sign as i32) << 15 | exponent) as u16,
    )
}

#[no_mangle]
pub unsafe fn fpu_fstenv(mut addr: i32) {
    if is_osize_32() {
        return_on_pagefault!(writable_or_pagefault(addr, 26));
        safe_write16(addr, *fpu_control_word).unwrap();
        safe_write16(addr + 4, fpu_load_status_word()).unwrap();
        safe_write16(addr + 8, fpu_load_tag_word()).unwrap();
        safe_write32(addr + 12, *fpu_ip).unwrap();
        safe_write16(addr + 16, *fpu_ip_selector).unwrap();
        safe_write16(addr + 18, *fpu_opcode).unwrap();
        safe_write32(addr + 20, *fpu_dp).unwrap();
        safe_write16(addr + 24, *fpu_dp_selector).unwrap();
    }
    else {
        dbg_log!("fstenv16");
        fpu_unimpl();
    };
}
#[no_mangle]
pub unsafe fn fpu_load_tag_word() -> i32 {
    let mut tag_word: i32 = 0;
    let mut i: i32 = 0;
    while i < 8 {
        let mut value: f64 = *fpu_st.offset(i as isize);
        if 0 != *fpu_stack_empty >> i & 1 {
            tag_word |= 3 << (i << 1)
        }
        else if value == 0 as f64 {
            tag_word |= 1 << (i << 1)
        }
        else if !value.is_finite() {
            tag_word |= 2 << (i << 1)
        }
        i += 1
    }
    return tag_word;
}
#[no_mangle]
pub unsafe fn fpu_fst(mut r: i32) { fpu_write_st(*fpu_stack_ptr as i32 + r & 7, fpu_get_st0()); }
#[no_mangle]
pub unsafe fn fpu_fst80p(mut addr: i32) {
    return_on_pagefault!(writable_or_pagefault(addr, 10));
    fpu_store_m80(addr, fpu_get_st0());
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_fstcw(mut addr: i32) {
    return_on_pagefault!(safe_write16(addr, *fpu_control_word));
}
#[no_mangle]
pub unsafe fn fpu_fstm32(mut addr: i32) {
    return_on_pagefault!(fpu_store_m32(addr, fpu_get_st0()));
}
#[no_mangle]
pub unsafe fn fpu_store_m32(mut addr: i32, mut x: f64) -> OrPageFault<()> {
    let mut v: f32_int = f32_int { f32_0: x as f32 };
    safe_write32(addr, v.i32_0)
}
#[no_mangle]
pub unsafe fn fpu_fstm32p(mut addr: i32) {
    fpu_fstm32(addr);
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_fstm64(mut addr: i32) {
    return_on_pagefault!(fpu_store_m64(addr, fpu_get_st0()));
}
#[no_mangle]
pub unsafe fn fpu_store_m64(mut addr: i32, mut x: f64) -> OrPageFault<()> {
    let mut v: f64_int = f64_int { f64_0: x };
    safe_write64(addr, v.u64_0[0] as i64)
}
#[no_mangle]
pub unsafe fn fpu_fstm64p(mut addr: i32) {
    fpu_fstm64(addr);
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_fstp(mut r: i32) {
    fpu_fst(r);
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_fsub(mut target_index: i32, mut val: f64) {
    let mut st0: f64 = fpu_get_st0();
    fpu_write_st(*fpu_stack_ptr as i32 + target_index & 7, st0 - val)
}
#[no_mangle]
pub unsafe fn fpu_fsubr(mut target_index: i32, mut val: f64) {
    let mut st0: f64 = fpu_get_st0();
    fpu_write_st(*fpu_stack_ptr as i32 + target_index & 7, val - st0)
}
#[no_mangle]
pub unsafe fn fpu_ftst(mut x: f64) {
    *fpu_status_word &= !FPU_RESULT_FLAGS;
    if x.is_nan() {
        *fpu_status_word |= FPU_C3 | FPU_C2 | FPU_C0
    }
    else if x == 0 as f64 {
        *fpu_status_word |= FPU_C3
    }
    else if x < 0 as f64 {
        *fpu_status_word |= FPU_C0
    }
    // TODO: unordered (x is nan, etc)
}
#[no_mangle]
pub unsafe fn fpu_fucom(mut r: i32) {
    // TODO
    fpu_fcom(fpu_get_sti(r));
}
#[no_mangle]
pub unsafe fn fpu_fucomi(mut r: i32) {
    // TODO
    fpu_fcomi(r);
}
#[no_mangle]
pub unsafe fn fpu_fucomip(mut r: i32) {
    fpu_fucomi(r);
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_fucomp(mut r: i32) {
    fpu_fucom(r);
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_fucompp() {
    fpu_fucom(1);
    fpu_pop();
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_fxam(mut x: f64) {
    *fpu_status_word &= !FPU_RESULT_FLAGS;
    *fpu_status_word |= fpu_sign(0) << 9;
    if 0 != *fpu_stack_empty >> *fpu_stack_ptr & 1 {
        *fpu_status_word |= FPU_C3 | FPU_C0
    }
    else if x.is_nan() {
        *fpu_status_word |= FPU_C0
    }
    else if x == 0 as f64 {
        *fpu_status_word |= FPU_C3
    }
    else if x == ::std::f32::INFINITY as f64 || x == -::std::f32::INFINITY as f64 {
        *fpu_status_word |= FPU_C2 | FPU_C0
    }
    else {
        *fpu_status_word |= FPU_C2
    }
    // TODO:
    // Unsupported, Denormal
}
#[no_mangle]
pub unsafe fn fpu_sign(mut i: i32) -> i32 {
    // sign of a number on the stack
    return *fpu_st8
        .offset((((*fpu_stack_ptr).wrapping_add(i as u32) & 7 as u32) << 3 | 7 as u32) as isize)
        as i32
        >> 7;
}
#[no_mangle]
pub unsafe fn fpu_fxch(mut i: i32) {
    let mut sti: f64 = fpu_get_sti(i);
    fpu_write_st(*fpu_stack_ptr as i32 + i & 7, fpu_get_st0());
    fpu_write_st(*fpu_stack_ptr as i32, sti);
}
#[no_mangle]
pub unsafe fn fpu_fxtract() {
    let mut double_int_view: f64_int = f64_int {
        f64_0: fpu_get_st0(),
    };
    let mut exponent: f64 = (((double_int_view.u8_0[7] as i32 & 127) << 4
        | double_int_view.u8_0[6] as i32 >> 4)
        - 1023) as f64;
    double_int_view.u8_0[7] = (63 | double_int_view.u8_0[7] as i32 & 128) as u8;
    double_int_view.u8_0[6] = (double_int_view.u8_0[6] as i32 | 240) as u8;
    fpu_write_st(*fpu_stack_ptr as i32, exponent);
    fpu_push(double_int_view.f64_0);
}
#[no_mangle]
pub unsafe fn fwait() {
    // NOP unless FPU instructions run in parallel with CPU instructions
}
