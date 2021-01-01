use std::mem::transmute;

use cpu2::cpu::*;
use cpu2::global_pointers::*;
use paging::OrPageFault;
use std::f64;

pub fn round(x: f64) -> f64 { x.round() }
pub fn floor(x: f64) -> f64 { x.floor() }
pub fn ceil(x: f64) -> f64 { x.ceil() }
pub fn pow(x: f64, y: f64) -> f64 { x.powf(y) }
pub fn convert_f64_to_i32(x: f64) -> i32 { x as i32 }
pub fn trunc(x: f64) -> f64 { x.trunc() }
pub fn fmod(x: f64, y: f64) -> f64 { x % y }

pub const M_LOG2E: f64 = 1.4426950408889634f64;
pub const M_LN2: f64 = 0.6931471805599453f64;
pub const M_LN10: f64 = 2.302585092994046f64;
pub const M_PI: f64 = 3.141592653589793f64;
const FPU_C0: i32 = 0x100;
pub const FPU_C1: i32 = 0x200;
pub const FPU_C2: i32 = 0x400;
const FPU_C3: i32 = 0x4000;
const FPU_RESULT_FLAGS: i32 = FPU_C0 | FPU_C1 | FPU_C2 | FPU_C3;
const INDEFINITE_NAN: f64 = ::std::f64::NAN;
const FPU_EX_I: i32 = 1 << 0;
const FPU_EX_Z: i32 = 1 << 2;
const FPU_EX_SF: i32 = 1 << 6;
const TWO_POW_63: f64 = 0x8000000000000000u64 as f64;

const F64_MANTISSA_MASK: u64 = (1 << 52) - 1;
const F64_EXPONENT_MASK: u16 = 0x7FF;
const F64_EXPONENT_NAN_INF: u16 = 0x7FF;
const F64_SIGN_SHIFT: u32 = 63;
const F64_EXPONENT_SHIFT: u32 = 52;
const F64_EXPONENT_BIAS: u16 = 0x3FF;

const F80_EXPONENT_MASK: u16 = 0x7FFF;
const F80_EXPONENT_NAN_INF: u16 = 0x7FFF;
const F80_EXPONENT_BIAS: u16 = 0x3FFF;

pub struct FloatParts {
    sign: bool,
    exponent: u16,
    mantissa: u64,
}

impl FloatParts {
    pub fn to_f64(&self) -> f64 {
        dbg_assert!(self.exponent <= F64_EXPONENT_MASK);
        dbg_assert!(self.mantissa <= F64_MANTISSA_MASK);
        let d = (self.sign as u64) << F64_SIGN_SHIFT
            | (self.exponent as u64) << F64_EXPONENT_SHIFT
            | self.mantissa;
        let f = unsafe { transmute(d) };
        f
    }

    pub fn of_f64(f: f64) -> FloatParts {
        let d: u64 = unsafe { transmute(f) };
        FloatParts {
            sign: d >> F64_SIGN_SHIFT == 1,
            exponent: (d >> F64_EXPONENT_SHIFT) as u16 & F64_EXPONENT_MASK,
            mantissa: d & F64_MANTISSA_MASK,
        }
    }
}

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
pub unsafe fn fpu_zero_fault() {
    // TODO: Interrupt
    *fpu_status_word |= FPU_EX_Z;
}

#[no_mangle]
pub unsafe fn fpu_sti_empty(mut i: i32) -> bool {
    dbg_assert!(i >= 0 && i < 8);
    i = ((i as u32).wrapping_add(*fpu_stack_ptr) & 7) as i32;
    return 0 != *fpu_stack_empty >> i & 1;
}

#[no_mangle]
pub unsafe fn fpu_get_sti(mut i: i32) -> f64 {
    dbg_assert!(i >= 0 && i < 8);
    i = ((i as u32).wrapping_add(*fpu_stack_ptr) & 7) as i32;
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
pub unsafe fn fpu_integer_round(f: f64) -> f64 {
    let rc = *fpu_control_word >> 10 & 3;
    // XXX: See https://en.wikipedia.org/wiki/C_mathematical_functions
    if rc == 0 {
        // Round to nearest, or even if equidistant
        let mut rounded: f64 = round(f);
        let diff = rounded - f;
        if diff == 0.5f64 || diff == -0.5f64 {
            rounded = 2.0f64 * round(f * 0.5f64)
        }
        return rounded;
    }
    else if rc == 1 || rc == 3 && f > 0.0 {
        // rc=3 is truncate -> floor for positive numbers
        return floor(f);
    }
    else {
        return ceil(f);
    };
}
#[no_mangle]
pub unsafe fn fpu_load_m32(addr: i32) -> OrPageFault<f64> {
    let v: f32 = transmute(safe_read32s(addr)?);
    Ok(v as f64)
}
#[no_mangle]
pub unsafe fn fpu_load_m64(addr: i32) -> OrPageFault<f64> {
    let value = safe_read64s(addr)?;
    let f = transmute(value);
    Ok(f)
}

#[no_mangle]
pub unsafe fn fpu_load_m80(addr: i32) -> OrPageFault<f64> {
    let value = safe_read64s(addr as i32)?;
    let exponent = safe_read16(addr.wrapping_add(8) as i32)?;
    let f = fpu_f80_to_f64((value, exponent as u16));
    Ok(f)
}

pub unsafe fn fpu_f80_to_f64(i: (u64, u16)) -> f64 {
    let mantissa = i.0;
    let exponent = i.1 & F80_EXPONENT_MASK;
    let sign = i.1 >> 15 == 1;

    if exponent == 0 {
        // Denormal number
        // A few bits of precision lost and "integer part" bit ignored
        let d = (sign as u64) << F64_SIGN_SHIFT | (mantissa >> 11 & F64_MANTISSA_MASK);
        let f = transmute(d);
        f
    }
    else if exponent < F80_EXPONENT_NAN_INF {
        let biased_exponent = exponent as i32 - F80_EXPONENT_BIAS as i32;
        // Note: some bits might be lost at this point
        let mut mantissa = mantissa as f64;
        if sign {
            mantissa = -mantissa
        }
        // Simply compute the 64 bit floating point number.
        // An alternative write the mantissa, sign and exponent in the
        // float64_byte and return float64[0]
        mantissa * pow(2.0, biased_exponent as f64 - 63.0)
    }
    else {
        // NaN, Infinity
        // Note: 11 bits of the NaN payload lost and "integer part" bit ignored
        let mantissa = (mantissa >> 11) & F64_MANTISSA_MASK;
        let f = FloatParts {
            sign,
            exponent: F64_EXPONENT_NAN_INF,
            mantissa,
        };
        f.to_f64()
    }
}

#[cfg(test)]
mod tests {
    use super::{fpu_f64_to_f80, fpu_f80_to_f64, FloatParts, F64_EXPONENT_NAN_INF};
    use std::mem::transmute;

    fn test_f80_f64_conversion(d: u64) -> bool {
        let f = unsafe { transmute(d) };
        let f2 = unsafe { fpu_f80_to_f64(fpu_f64_to_f80(f)) };
        let d2 = unsafe { transmute(f2) };
        d == d2
    }

    quickcheck! {
        fn f80_f64_conversion(d: u64) -> bool {
            test_f80_f64_conversion(d)
        }

        fn f80_f64_conversion_nan_inf(d: u64) -> bool {
            let f = unsafe { transmute(d) };
            let mut parts = FloatParts::of_f64(f);
            parts.exponent = F64_EXPONENT_NAN_INF;
            let d = unsafe { transmute(parts.to_f64()) };
            test_f80_f64_conversion(d)
        }

        fn f80_f64_conversion_denormal(d: u64) -> bool {
            let f = unsafe { transmute(d) };
            let mut parts = FloatParts::of_f64(f);
            parts.exponent = 0;
            let d = unsafe { transmute(parts.to_f64()) };
            test_f80_f64_conversion(d)
        }
    }

    #[test]
    fn more_f80_f64_conversions() {
        assert_eq!(unsafe { fpu_f64_to_f80(0.) }, (0, 0));
    }
}

#[no_mangle]
pub unsafe fn fpu_load_status_word() -> i32 {
    return ((*fpu_status_word & !(7 << 11)) as u32 | *fpu_stack_ptr << 11) as i32;
}
#[no_mangle]
pub unsafe fn fpu_fadd(target_index: i32, val: f64) {
    let st0 = fpu_get_st0();
    fpu_write_st(*fpu_stack_ptr as i32 + target_index & 7, st0 + val);
}
#[no_mangle]
pub unsafe fn fpu_fclex() { *fpu_status_word = 0; }
#[no_mangle]
pub unsafe fn fpu_fcmovcc(condition: bool, r: i32) {
    // outside of the condition is correct: A stack fault happens even if the condition is not
    // fulfilled
    let x = fpu_get_sti(r);
    if fpu_sti_empty(r) {
        fpu_write_st(*fpu_stack_ptr as i32, INDEFINITE_NAN)
    }
    else {
        if condition {
            fpu_write_st(*fpu_stack_ptr as i32, x);
            *fpu_stack_empty &= !(1 << *fpu_stack_ptr)
        };
    }
}
#[no_mangle]
pub unsafe fn fpu_fcom(y: f64) {
    let x = fpu_get_st0();
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
pub unsafe fn fpu_fcomi(r: i32) {
    let y = fpu_get_sti(r);
    let x = *fpu_st.offset(*fpu_stack_ptr as isize);
    *flags_changed &= !(1 | FLAG_PARITY | FLAG_ZERO | FLAG_ADJUST | FLAG_SIGN | FLAG_OVERFLOW);
    *flags &= !(1 | FLAG_PARITY | FLAG_ZERO | FLAG_ADJUST | FLAG_SIGN | FLAG_OVERFLOW);
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
pub unsafe fn fpu_fcomip(r: i32) {
    fpu_fcomi(r);
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_pop() {
    *fpu_stack_empty |= 1 << *fpu_stack_ptr;
    *fpu_stack_ptr = (*fpu_stack_ptr).wrapping_add(1) & 7;
}
#[no_mangle]
pub unsafe fn fpu_fcomp(val: f64) {
    fpu_fcom(val);
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_fdiv(target_index: i32, val: f64) {
    let st0 = fpu_get_st0();
    if val == 0.0 {
        fpu_zero_fault();
    }
    fpu_write_st(*fpu_stack_ptr as i32 + target_index & 7, st0 / val);
}
#[no_mangle]
pub unsafe fn fpu_fdivr(target_index: i32, val: f64) {
    let st0 = fpu_get_st0();
    if st0 == 0.0 {
        fpu_zero_fault();
    }
    fpu_write_st(*fpu_stack_ptr as i32 + target_index & 7, val / st0);
}
#[no_mangle]
pub unsafe fn fpu_ffree(r: i32) {
    *fpu_stack_empty |= 1 << (*fpu_stack_ptr).wrapping_add(r as u32);
}
#[no_mangle]
pub unsafe fn fpu_fildm64(addr: i32) {
    let value = return_on_pagefault!(safe_read64s(addr)) as i64;
    let m64 = value as f64;
    fpu_push(m64);
}
#[no_mangle]
pub unsafe fn fpu_push(x: f64) {
    *fpu_stack_ptr = (*fpu_stack_ptr).wrapping_sub(1) & 7;
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
    *fpu_stack_ptr = 0;
}

#[no_mangle]
pub unsafe fn fpu_invalid_arithmetic() { *fpu_status_word |= FPU_EX_I; }

#[no_mangle]
pub unsafe fn fpu_convert_to_i16(f: f64) -> i16 {
    let st0 = fpu_integer_round(f);
    if st0 <= 32767.0 && st0 >= -32768.0 {
        st0 as i16
    }
    else {
        fpu_invalid_arithmetic();
        -0x8000
    }
}
#[no_mangle]
pub unsafe fn fpu_fistm16(addr: i32) {
    let v = fpu_convert_to_i16(fpu_get_st0());
    return_on_pagefault!(safe_write16(addr, v as i32));
}
#[no_mangle]
pub unsafe fn fpu_fistm16p(addr: i32) {
    fpu_fistm16(addr);
    fpu_pop();
}

#[no_mangle]
pub unsafe fn fpu_convert_to_i32(f: f64) -> i32 {
    let st0 = fpu_integer_round(f);

    if st0 < 0x8000_0000i64 as f64 && st0 >= -0x8000_0000 as f64 {
        st0 as i32
    }
    else {
        fpu_invalid_arithmetic();
        -0x8000_0000
    }
}
#[no_mangle]
pub unsafe fn fpu_fistm32(addr: i32) {
    let v = fpu_convert_to_i32(fpu_get_st0());
    return_on_pagefault!(safe_write32(addr, v));
}
#[no_mangle]
pub unsafe fn fpu_fistm32p(addr: i32) {
    fpu_fistm32(addr);
    fpu_pop();
}

#[no_mangle]
pub unsafe fn fpu_convert_to_i64(f: f64) -> i64 {
    let st0 = fpu_integer_round(f);
    if st0 < TWO_POW_63 && st0 >= -TWO_POW_63 {
        st0 as i64
    }
    else {
        fpu_invalid_arithmetic();
        -0x80000000_00000000
    }
}
#[no_mangle]
pub unsafe fn fpu_fistm64p(addr: i32) {
    let v = fpu_convert_to_i64(fpu_get_st0());
    return_on_pagefault!(safe_write64(addr, v as u64));
    fpu_pop();
}

#[no_mangle]
pub unsafe fn fpu_fldcw(addr: i32) {
    let word = return_on_pagefault!(safe_read16(addr));
    *fpu_control_word = word;
}

#[no_mangle]
pub unsafe fn fpu_fldenv16(_addr: i32) {
    dbg_log!("fldenv16");
    fpu_unimpl();
}
#[no_mangle]
pub unsafe fn fpu_fldenv32(addr: i32) {
    // TODO: Add readable_or_pagefault
    if let Err(()) = translate_address_read(addr) {
        *page_fault = true;
        return;
    }
    if let Err(()) = translate_address_read(addr + 28) {
        *page_fault = true;
        return;
    }
    *page_fault = false;
    *fpu_control_word = safe_read16(addr).unwrap();
    fpu_set_status_word(safe_read16(addr + 4).unwrap());
    fpu_set_tag_word(safe_read16(addr + 8).unwrap());
    *fpu_ip = safe_read32s(addr + 12).unwrap();
    *fpu_ip_selector = safe_read16(addr + 16).unwrap();
    *fpu_opcode = safe_read16(addr + 18).unwrap();
    *fpu_dp = safe_read32s(addr + 20).unwrap();
    *fpu_dp_selector = safe_read16(addr + 24).unwrap()
}
#[no_mangle]
pub unsafe fn fpu_unimpl() {
    if DEBUG {
        dbg_assert!(false);
    }
    else {
        trigger_ud();
    };
}
#[no_mangle]
pub unsafe fn fpu_set_tag_word(tag_word: i32) {
    *fpu_stack_empty = 0;
    for i in 0..8 {
        let empty = tag_word >> (2 * i) & 3 == 3;
        *fpu_stack_empty |= (empty as i32) << i;
    }
}
#[no_mangle]
pub unsafe fn fpu_set_status_word(sw: i32) {
    *fpu_status_word = sw & !(7 << 11);
    *fpu_stack_ptr = (sw >> 11 & 7) as u32;
}
#[no_mangle]
pub unsafe fn fpu_fldm32(addr: i32) { fpu_push(return_on_pagefault!(safe_read32s(addr)) as f64); }
#[no_mangle]
pub unsafe fn fpu_fldm64(addr: i32) { fpu_push(return_on_pagefault!(fpu_load_m64(addr))); }
#[no_mangle]
pub unsafe fn fpu_fldm80(addr: i32) {
    match fpu_load_m80(addr) {
        Ok(x) => {
            *page_fault = false;
            fpu_push(x)
        },
        Err(()) => {
            *page_fault = true;
        },
    }
}
#[no_mangle]
pub unsafe fn fpu_fmul(target_index: i32, val: f64) {
    let st0 = fpu_get_st0();
    fpu_write_st(*fpu_stack_ptr as i32 + target_index & 7, st0 * val);
}
#[no_mangle]
pub unsafe fn fpu_fnstsw_mem(addr: i32) {
    return_on_pagefault!(safe_write16(addr, fpu_load_status_word()));
}
#[no_mangle]
pub unsafe fn fpu_fnstsw_reg() { *reg16.offset(AX as isize) = fpu_load_status_word() as u16; }
#[no_mangle]
pub unsafe fn fpu_fprem(ieee: bool) {
    // false: Faster, passes qemutests
    // true: Slower, passes nasmtests
    let intel_compatibility = false;

    let st0 = fpu_get_st0();
    let st1 = fpu_get_sti(1);

    if st1 == 0.0 {
        if st0 == 0.0 {
            fpu_invalid_arithmetic();
        }
        else {
            fpu_zero_fault();
        }
        fpu_write_st(*fpu_stack_ptr as i32, INDEFINITE_NAN);
        return;
    }

    let exp0 = st0.log2();
    let exp1 = st1.log2();
    let d = (exp0 - exp1).abs();
    if !intel_compatibility || d < 64.0 {
        let fprem_quotient =
            convert_f64_to_i32(if ieee { round(st0 / st1) } else { trunc(st0 / st1) });
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
    else {
        let n = 32.0;
        let fprem_quotient = convert_f64_to_i32(
            if ieee { round(st0 / st1) } else { trunc(st0 / st1) } / pow(2.0, d - n),
        );
        fpu_write_st(
            *fpu_stack_ptr as i32,
            st0 - st1 * (fprem_quotient as f64) * pow(2.0, d - n),
        );
        *fpu_status_word |= FPU_C2;
    }
}

#[no_mangle]
pub unsafe fn fpu_frstor16(_addr: i32) {
    dbg_log!("frstor16");
    fpu_unimpl();
}
#[no_mangle]
pub unsafe fn fpu_frstor32(mut addr: i32) {
    // TODO: Add readable_or_pagefault
    return_on_pagefault!(translate_address_read(addr));
    return_on_pagefault!(translate_address_read(addr + 28 + 8 * 10));
    fpu_fldenv32(addr);
    addr += 28;
    for i in 0..8 {
        let reg_index = *fpu_stack_ptr as i32 + i & 7;
        *fpu_st.offset(reg_index as isize) = fpu_load_m80(addr).unwrap();
        *reg_mmx.offset(reg_index as isize) = safe_read64s(addr).unwrap();
        addr += 10;
    }
    *fxsave_store_fpu_mask = 0xff;
}

#[no_mangle]
pub unsafe fn fpu_fsave16(_addr: i32) {
    dbg_log!("fsave16");
    fpu_unimpl();
}
#[no_mangle]
pub unsafe fn fpu_fsave32(mut addr: i32) {
    return_on_pagefault!(writable_or_pagefault(addr, 108));
    fpu_fstenv32(addr);
    addr += 28;
    for i in 0..8 {
        let reg_index = i + *fpu_stack_ptr as i32 & 7;
        if *fxsave_store_fpu_mask & 1 << reg_index != 0 {
            fpu_store_m80(addr, *fpu_st.offset(reg_index as isize));
        }
        else {
            safe_write64(addr, *reg_mmx.offset(reg_index as isize)).unwrap();
        }
        addr += 10;
    }
    fpu_finit();
}

#[no_mangle]
pub unsafe fn fpu_store_m80(addr: i32, n: f64) {
    let (value, exponent) = fpu_f64_to_f80(n);
    // writable_or_pagefault must have checked called by the caller!
    safe_write64(addr, value).unwrap();
    safe_write16(addr + 8, exponent as i32).unwrap();
}

pub unsafe fn fpu_f64_to_f80(f: f64) -> (u64, u16) {
    let f = FloatParts::of_f64(f);

    let exponent;

    // This bit is implicit (doesn't exist) in f32 and f64.
    // See https://en.wikipedia.org/wiki/Extended_precision#x86_extended_precision_format for normal values for this bit
    let integer_part;

    if f.exponent == F64_EXPONENT_NAN_INF {
        // all bits set (NaN and infinity)
        exponent = F80_EXPONENT_NAN_INF;
        integer_part = 1;
    }
    else if f.exponent == 0 {
        // zero and denormal numbers
        exponent = 0;
        integer_part = 0;
    }
    else {
        exponent = f.exponent + F80_EXPONENT_BIAS - F64_EXPONENT_BIAS;
        integer_part = 1;
    }

    dbg_assert!(exponent < 0x8000);
    (
        integer_part << 63 | f.mantissa << 11,
        (f.sign as u16) << 15 | exponent,
    )
}

#[no_mangle]
pub unsafe fn fpu_fstenv16(_addr: i32) {
    dbg_log!("fstenv16");
    fpu_unimpl();
}

#[no_mangle]
pub unsafe fn fpu_fstenv32(addr: i32) {
    match writable_or_pagefault(addr, 26) {
        Ok(()) => *page_fault = false,
        Err(()) => {
            *page_fault = true;
            return;
        },
    }
    safe_write16(addr, *fpu_control_word).unwrap();
    safe_write16(addr + 4, fpu_load_status_word()).unwrap();
    safe_write16(addr + 8, fpu_load_tag_word()).unwrap();
    safe_write32(addr + 12, *fpu_ip).unwrap();
    safe_write16(addr + 16, *fpu_ip_selector).unwrap();
    safe_write16(addr + 18, *fpu_opcode).unwrap();
    safe_write32(addr + 20, *fpu_dp).unwrap();
    safe_write16(addr + 24, *fpu_dp_selector).unwrap();
}
#[no_mangle]
pub unsafe fn fpu_load_tag_word() -> i32 {
    let mut tag_word: i32 = 0;
    for i in 0..8 {
        let value = *fpu_st.offset(i as isize);
        if 0 != *fpu_stack_empty >> i & 1 {
            tag_word |= 3 << (i << 1)
        }
        else if value == 0.0 {
            tag_word |= 1 << (i << 1)
        }
        else if !value.is_finite() {
            tag_word |= 2 << (i << 1)
        }
    }
    return tag_word;
}
#[no_mangle]
pub unsafe fn fpu_fst(r: i32) { fpu_write_st(*fpu_stack_ptr as i32 + r & 7, fpu_get_st0()); }
#[no_mangle]
pub unsafe fn fpu_fst80p(addr: i32) {
    return_on_pagefault!(writable_or_pagefault(addr, 10));
    fpu_store_m80(addr, fpu_get_st0());
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_fstcw(addr: i32) {
    return_on_pagefault!(safe_write16(addr, *fpu_control_word));
}
#[no_mangle]
pub unsafe fn fpu_fstm32(addr: i32) {
    return_on_pagefault!(fpu_store_m32(addr, fpu_get_st0()));
}
#[no_mangle]
pub unsafe fn fpu_store_m32(addr: i32, x: f64) -> OrPageFault<()> {
    let v = transmute(x as f32);
    safe_write32(addr, v)
}
#[no_mangle]
pub unsafe fn fpu_fstm32p(addr: i32) {
    fpu_fstm32(addr);
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_fstm64(addr: i32) {
    return_on_pagefault!(fpu_store_m64(addr, fpu_get_st0()));
}
#[no_mangle]
pub unsafe fn fpu_store_m64(addr: i32, x: f64) -> OrPageFault<()> {
    let v = transmute(x);
    safe_write64(addr, v)
}
#[no_mangle]
pub unsafe fn fpu_fstm64p(addr: i32) {
    fpu_fstm64(addr);
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_fstp(r: i32) {
    fpu_fst(r);
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_fsub(target_index: i32, val: f64) {
    let st0 = fpu_get_st0();
    fpu_write_st(*fpu_stack_ptr as i32 + target_index & 7, st0 - val)
}
#[no_mangle]
pub unsafe fn fpu_fsubr(target_index: i32, val: f64) {
    let st0 = fpu_get_st0();
    fpu_write_st(*fpu_stack_ptr as i32 + target_index & 7, val - st0)
}
#[no_mangle]
pub unsafe fn fpu_ftst(x: f64) {
    *fpu_status_word &= !FPU_RESULT_FLAGS;
    if x.is_nan() {
        *fpu_status_word |= FPU_C3 | FPU_C2 | FPU_C0
    }
    else if x == 0.0 {
        *fpu_status_word |= FPU_C3
    }
    else if x < 0.0 {
        *fpu_status_word |= FPU_C0
    }
    // TODO: unordered (x is nan, etc)
}
#[no_mangle]
pub unsafe fn fpu_fucom(r: i32) {
    // TODO
    fpu_fcom(fpu_get_sti(r));
}
#[no_mangle]
pub unsafe fn fpu_fucomi(r: i32) {
    // TODO
    fpu_fcomi(r);
}
#[no_mangle]
pub unsafe fn fpu_fucomip(r: i32) {
    fpu_fucomi(r);
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_fucomp(r: i32) {
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
pub unsafe fn fpu_fxam(x: f64) {
    *fpu_status_word &= !FPU_RESULT_FLAGS;
    *fpu_status_word |= fpu_sign(0) << 9;
    if 0 != *fpu_stack_empty >> *fpu_stack_ptr & 1 {
        *fpu_status_word |= FPU_C3 | FPU_C0
    }
    else if x.is_nan() {
        *fpu_status_word |= FPU_C0
    }
    else if x == 0.0 {
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
pub unsafe fn fpu_sign(i: i32) -> i32 {
    // sign of a number on the stack
    return *fpu_st8.offset((((*fpu_stack_ptr).wrapping_add(i as u32) & 7) << 3 | 7) as isize)
        as i32
        >> 7;
}
#[no_mangle]
pub unsafe fn fpu_fxch(i: i32) {
    let sti = fpu_get_sti(i);
    fpu_write_st(*fpu_stack_ptr as i32 + i & 7, fpu_get_st0());
    fpu_write_st(*fpu_stack_ptr as i32, sti);
}
pub unsafe fn fpu_fyl2x() {
    let st0 = fpu_get_st0();
    if st0 < 0.0 {
        fpu_invalid_arithmetic();
    }
    else if st0 == 0.0 {
        fpu_zero_fault();
    }
    fpu_write_st(
        *fpu_stack_ptr as i32 + 1 & 7,
        fpu_get_sti(1) * st0.ln() / M_LN2,
    );
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_fxtract() {
    let st0 = fpu_get_st0();
    if st0 == 0.0 {
        fpu_zero_fault();
        fpu_write_st(*fpu_stack_ptr as i32, f64::NEG_INFINITY);
        fpu_push(st0);
    }
    else {
        let mut f = FloatParts::of_f64(st0);
        fpu_write_st(
            *fpu_stack_ptr as i32,
            f.exponent as f64 - F64_EXPONENT_BIAS as f64,
        );
        f.exponent = 0x3FF;
        fpu_push(f.to_f64());
    }
}
#[no_mangle]
pub unsafe fn fwait() {
    // NOP unless FPU instructions run in parallel with CPU instructions
}
