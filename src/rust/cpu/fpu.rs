use crate::cpu::cpu::*;
use crate::cpu::global_pointers::*;
use crate::paging::OrPageFault;
use crate::softfloat::{Precision, RoundingMode, F80};

use std::f64;

const FPU_C0: u16 = 0x100;
const FPU_C1: u16 = 0x200;
const FPU_C2: u16 = 0x400;
const FPU_C3: u16 = 0x4000;
const FPU_RESULT_FLAGS: u16 = FPU_C0 | FPU_C1 | FPU_C2 | FPU_C3;

const FPU_EX_I: u16 = 1 << 0; // invalid operation
#[allow(dead_code)]
const FPU_EX_D: u16 = 1 << 1; // denormal operand
const FPU_EX_Z: u16 = 1 << 2; // zero divide
#[allow(dead_code)]
const FPU_EX_O: u16 = 1 << 3; // overflow
const FPU_EX_U: u16 = 1 << 4; // underflow
#[allow(dead_code)]
const FPU_EX_P: u16 = 1 << 5; // precision
const FPU_EX_SF: u16 = 1 << 6;

pub fn fpu_write_st(index: i32, value: F80) {
    dbg_assert!(index >= 0 && index < 8);
    unsafe {
        *fpu_st.offset(index as isize) = value;
    }
}

pub unsafe fn fpu_get_st0() -> F80 {
    dbg_assert!(*fpu_stack_ptr < 8);
    if 0 != *fpu_stack_empty >> *fpu_stack_ptr & 1 {
        *fpu_status_word &= !FPU_C1;
        fpu_stack_fault();
        return F80::INDEFINITE_NAN;
    }
    else {
        return *fpu_st.offset(*fpu_stack_ptr as isize);
    };
}
pub unsafe fn fpu_stack_fault() {
    // TODO: Interrupt
    *fpu_status_word |= FPU_EX_SF | FPU_EX_I;
}

pub unsafe fn fpu_zero_fault() {
    // TODO: Interrupt
    *fpu_status_word |= FPU_EX_Z;
}

pub unsafe fn fpu_underflow_fault() {
    // TODO: Interrupt
    *fpu_status_word |= FPU_EX_U;
}

pub unsafe fn fpu_sti_empty(mut i: i32) -> bool {
    dbg_assert!(i >= 0 && i < 8);
    i = i + *fpu_stack_ptr as i32 & 7;
    return 0 != *fpu_stack_empty >> i & 1;
}

#[no_mangle]
pub unsafe fn fpu_get_sti_jit(dst: *mut F80, i: i32) { *dst = fpu_get_sti(i); }

pub unsafe fn fpu_get_sti(mut i: i32) -> F80 {
    dbg_assert!(i >= 0 && i < 8);
    i = i + *fpu_stack_ptr as i32 & 7;
    if 0 != *fpu_stack_empty >> i & 1 {
        *fpu_status_word &= !FPU_C1;
        fpu_stack_fault();
        return F80::INDEFINITE_NAN;
    }
    else {
        return *fpu_st.offset(i as isize);
    };
}

// only used for debugging
#[no_mangle]
pub unsafe fn fpu_get_sti_f64(mut i: i32) -> f64 {
    i = i + *fpu_stack_ptr as i32 & 7;
    f64::from_bits((*fpu_st.offset(i as isize)).to_f64())
}

#[no_mangle]
pub unsafe fn f32_to_f80_jit(dst: *mut F80, v: i32) { *dst = f32_to_f80(v) }
pub unsafe fn f32_to_f80(v: i32) -> F80 {
    F80::clear_exception_flags();
    let x = F80::of_f32(v);
    *fpu_status_word |= F80::get_exception_flags() as u16;
    x
}
#[no_mangle]
pub unsafe fn f64_to_f80_jit(dst: *mut F80, v: u64) { *dst = f64_to_f80(v) }
pub unsafe fn f64_to_f80(v: u64) -> F80 {
    F80::clear_exception_flags();
    let x = F80::of_f64(v);
    *fpu_status_word |= F80::get_exception_flags() as u16;
    x
}
#[no_mangle]
pub unsafe fn f80_to_f32(v: F80) -> i32 {
    F80::clear_exception_flags();
    let x = v.to_f32();
    *fpu_status_word |= F80::get_exception_flags() as u16;
    x
}
#[no_mangle]
pub unsafe fn f80_to_f64(v: F80) -> u64 {
    F80::clear_exception_flags();
    let x = v.to_f64();
    *fpu_status_word |= F80::get_exception_flags() as u16;
    x
}

#[no_mangle]
pub unsafe fn i32_to_f80_jit(dst: *mut F80, v: i32) { *dst = i32_to_f80(v) }
pub unsafe fn i32_to_f80(v: i32) -> F80 { F80::of_i32(v) }
#[no_mangle]
pub unsafe fn i64_to_f80_jit(dst: *mut F80, v: i64) { *dst = i64_to_f80(v) }
pub unsafe fn i64_to_f80(v: i64) -> F80 { F80::of_i64(v) }

pub unsafe fn fpu_load_i16(addr: i32) -> OrPageFault<F80> {
    let v = safe_read16(addr)? as i16 as i32;
    Ok(F80::of_i32(v))
}
pub unsafe fn fpu_load_i32(addr: i32) -> OrPageFault<F80> {
    let v = safe_read32s(addr)?;
    Ok(F80::of_i32(v))
}
pub unsafe fn fpu_load_i64(addr: i32) -> OrPageFault<F80> {
    let v = safe_read64s(addr)? as i64;
    Ok(F80::of_i64(v))
}

pub unsafe fn fpu_load_m32(addr: i32) -> OrPageFault<F80> {
    F80::clear_exception_flags();
    let v = F80::of_f32(safe_read32s(addr)?);
    *fpu_status_word |= F80::get_exception_flags() as u16;
    Ok(v)
}
pub unsafe fn fpu_load_m64(addr: i32) -> OrPageFault<F80> {
    F80::clear_exception_flags();
    let v = F80::of_f64(safe_read64s(addr)?);
    *fpu_status_word |= F80::get_exception_flags() as u16;
    Ok(v)
}
pub unsafe fn fpu_load_m80(addr: i32) -> OrPageFault<F80> {
    let mantissa = safe_read64s(addr)?;
    let sign_exponent = safe_read16(addr + 8)? as u16;
    // TODO: Canonical form
    Ok(F80 {
        mantissa,
        sign_exponent,
    })
}

#[no_mangle]
pub unsafe fn fpu_load_status_word() -> u16 {
    dbg_assert!(*fpu_stack_ptr < 8);
    return *fpu_status_word & !(7 << 11) | (*fpu_stack_ptr as u16) << 11;
}
#[no_mangle]
pub unsafe fn fpu_fadd(target_index: i32, val: F80) {
    F80::clear_exception_flags();
    let st0 = fpu_get_st0();
    fpu_write_st(*fpu_stack_ptr as i32 + target_index & 7, st0 + val);
    *fpu_status_word |= F80::get_exception_flags() as u16;
}
pub unsafe fn fpu_fclex() { *fpu_status_word = 0; }
pub unsafe fn fpu_fcmovcc(condition: bool, r: i32) {
    // outside of the condition is correct: A stack fault happens even if the condition is not
    // fulfilled
    let x = fpu_get_sti(r);
    if fpu_sti_empty(r) {
        fpu_write_st(*fpu_stack_ptr as i32, F80::INDEFINITE_NAN)
    }
    else {
        if condition {
            fpu_write_st(*fpu_stack_ptr as i32, x);
            *fpu_stack_empty &= !(1 << *fpu_stack_ptr)
        };
    }
}

#[no_mangle]
pub unsafe fn fpu_fcom(y: F80) {
    F80::clear_exception_flags();
    let x = fpu_get_st0();
    *fpu_status_word &= !FPU_RESULT_FLAGS;
    match x.partial_cmp(&y) {
        Some(std::cmp::Ordering::Greater) => {},
        Some(std::cmp::Ordering::Less) => *fpu_status_word |= FPU_C0,
        Some(std::cmp::Ordering::Equal) => *fpu_status_word |= FPU_C3,
        None => *fpu_status_word |= FPU_C0 | FPU_C2 | FPU_C3,
    }
    *fpu_status_word |= F80::get_exception_flags() as u16;
}

#[no_mangle]
pub unsafe fn fpu_fcomi(r: i32) {
    F80::clear_exception_flags();
    let x = fpu_get_st0();
    let y = fpu_get_sti(r);
    *flags_changed = 0;
    *flags &= !FLAGS_ALL;
    match x.partial_cmp(&y) {
        Some(std::cmp::Ordering::Greater) => {},
        Some(std::cmp::Ordering::Less) => *flags |= 1,
        Some(std::cmp::Ordering::Equal) => *flags |= FLAG_ZERO,
        None => *flags |= 1 | FLAG_PARITY | FLAG_ZERO,
    }
    *fpu_status_word |= F80::get_exception_flags() as u16;
}

#[no_mangle]
pub unsafe fn fpu_fcomip(r: i32) {
    fpu_fcomi(r);
    fpu_pop();
}

#[no_mangle]
pub unsafe fn fpu_pop() {
    dbg_assert!(*fpu_stack_ptr < 8);
    *fpu_stack_empty |= 1 << *fpu_stack_ptr;
    *fpu_stack_ptr = *fpu_stack_ptr + 1 & 7;
}

#[no_mangle]
pub unsafe fn fpu_fcomp(val: F80) {
    fpu_fcom(val);
    fpu_pop();
}

#[no_mangle]
pub unsafe fn fpu_fdiv(target_index: i32, val: F80) {
    F80::clear_exception_flags();
    let st0 = fpu_get_st0();
    fpu_write_st(*fpu_stack_ptr as i32 + target_index & 7, st0 / val);
    *fpu_status_word |= F80::get_exception_flags() as u16;
}
#[no_mangle]
pub unsafe fn fpu_fdivr(target_index: i32, val: F80) {
    F80::clear_exception_flags();
    let st0 = fpu_get_st0();
    fpu_write_st(*fpu_stack_ptr as i32 + target_index & 7, val / st0);
    *fpu_status_word |= F80::get_exception_flags() as u16;
}
#[no_mangle]
pub unsafe fn fpu_ffree(r: i32) { *fpu_stack_empty |= 1 << (*fpu_stack_ptr as i32 + r & 7); }

pub unsafe fn fpu_fildm16(addr: i32) { fpu_push(return_on_pagefault!(fpu_load_i16(addr))); }
pub unsafe fn fpu_fildm32(addr: i32) { fpu_push(return_on_pagefault!(fpu_load_i32(addr))); }
pub unsafe fn fpu_fildm64(addr: i32) { fpu_push(return_on_pagefault!(fpu_load_i64(addr))); }

#[no_mangle]
pub unsafe fn fpu_push(x: F80) {
    *fpu_stack_ptr = *fpu_stack_ptr - 1 & 7;
    if 0 != *fpu_stack_empty >> *fpu_stack_ptr & 1 {
        *fpu_status_word &= !FPU_C1;
        *fpu_stack_empty &= !(1 << *fpu_stack_ptr);
        fpu_write_st(*fpu_stack_ptr as i32, x);
    }
    else {
        *fpu_status_word |= FPU_C1;
        fpu_stack_fault();
        fpu_write_st(*fpu_stack_ptr as i32, F80::INDEFINITE_NAN);
    };
}
pub unsafe fn fpu_finit() {
    set_control_word(0x37F);
    *fpu_status_word = 0;
    *fpu_ip = 0;
    *fpu_dp = 0;
    *fpu_opcode = 0;
    *fpu_stack_empty = 0xFF;
    *fpu_stack_ptr = 0;
}

#[no_mangle]
pub unsafe fn set_control_word(cw: u16) {
    *fpu_control_word = cw;

    let rc = cw >> 10 & 3;
    F80::set_rounding_mode(match rc {
        0 => RoundingMode::NearEven,
        1 => RoundingMode::Floor,
        2 => RoundingMode::Ceil,
        3 => RoundingMode::Trunc,
        _ => {
            dbg_assert!(false);
            RoundingMode::NearEven
        },
    });

    let precision_control = cw >> 8 & 3;
    F80::set_precision(match precision_control {
        0 => Precision::P32,
        1 => Precision::P80, // undefined
        2 => Precision::P64,
        3 => Precision::P80,
        _ => {
            dbg_assert!(false);
            Precision::P80
        },
    });
}

pub unsafe fn fpu_invalid_arithmetic() { *fpu_status_word |= FPU_EX_I; }

#[no_mangle]
pub unsafe fn fpu_convert_to_i16(f: F80) -> i16 {
    let st0 = fpu_convert_to_i32(f);
    if st0 < -0x8000 || st0 > 0x7FFF {
        fpu_invalid_arithmetic();
        -0x8000
    }
    else {
        st0 as i16
    }
}
pub unsafe fn fpu_fistm16(addr: i32) {
    return_on_pagefault!(writable_or_pagefault(addr, 2));
    let v = fpu_convert_to_i16(fpu_get_st0());
    safe_write16(addr, v as i32 & 0xFFFF).unwrap();
}
pub unsafe fn fpu_fistm16p(addr: i32) {
    return_on_pagefault!(writable_or_pagefault(addr, 2));
    let v = fpu_convert_to_i16(fpu_get_st0());
    safe_write16(addr, v as i32 & 0xFFFF).unwrap();
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_truncate_to_i16(f: F80) -> i16 {
    let st0 = fpu_truncate_to_i32(f);
    if st0 < -0x8000 || st0 > 0x7FFF {
        fpu_invalid_arithmetic();
        -0x8000
    }
    else {
        st0 as i16
    }
}
pub unsafe fn fpu_fisttpm16(addr: i32) {
    return_on_pagefault!(writable_or_pagefault(addr, 2));
    let v = fpu_truncate_to_i16(fpu_get_st0());
    safe_write16(addr, v as i32 & 0xFFFF).unwrap();
    fpu_pop();
}

#[no_mangle]
pub unsafe fn fpu_convert_to_i32(f: F80) -> i32 {
    F80::clear_exception_flags();
    let x = f.to_i32();
    *fpu_status_word |= F80::get_exception_flags() as u16;
    x
}
pub unsafe fn fpu_fistm32(addr: i32) {
    return_on_pagefault!(writable_or_pagefault(addr, 4));
    let v = fpu_convert_to_i32(fpu_get_st0());
    safe_write32(addr, v).unwrap();
}
pub unsafe fn fpu_fistm32p(addr: i32) {
    return_on_pagefault!(writable_or_pagefault(addr, 4));
    let v = fpu_convert_to_i32(fpu_get_st0());
    safe_write32(addr, v).unwrap();
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_truncate_to_i32(f: F80) -> i32 {
    F80::clear_exception_flags();
    let x = f.truncate_to_i32();
    *fpu_status_word |= F80::get_exception_flags() as u16;
    x
}
pub unsafe fn fpu_fisttpm32(addr: i32) {
    return_on_pagefault!(writable_or_pagefault(addr, 4));
    let v = fpu_truncate_to_i32(fpu_get_st0());
    safe_write32(addr, v).unwrap();
    fpu_pop();
}

#[no_mangle]
pub unsafe fn fpu_convert_to_i64(f: F80) -> i64 {
    F80::clear_exception_flags();
    let x = f.to_i64();
    *fpu_status_word |= F80::get_exception_flags() as u16;
    x
}
pub unsafe fn fpu_fistm64p(addr: i32) {
    return_on_pagefault!(writable_or_pagefault(addr, 8));
    let v = fpu_convert_to_i64(fpu_get_st0());
    safe_write64(addr, v as u64).unwrap();
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_truncate_to_i64(f: F80) -> i64 {
    F80::clear_exception_flags();
    let x = f.truncate_to_i64();
    *fpu_status_word |= F80::get_exception_flags() as u16;
    x
}
pub unsafe fn fpu_fisttpm64(addr: i32) {
    return_on_pagefault!(writable_or_pagefault(addr, 8));
    let v = fpu_truncate_to_i64(fpu_get_st0());
    safe_write64(addr, v as u64).unwrap();
    fpu_pop();
}

pub unsafe fn fpu_fldcw(addr: i32) {
    let word = return_on_pagefault!(safe_read16(addr)) as u16;
    set_control_word(word);
}

#[no_mangle]
pub unsafe fn fpu_fldenv16(_addr: i32) {
    dbg_log!("fldenv16");
    fpu_unimpl();
}
#[no_mangle]
pub unsafe fn fpu_fldenv32(addr: i32) {
    if let Err(()) = readable_or_pagefault(addr, 28) {
        *page_fault = true;
        return;
    }
    *page_fault = false;
    set_control_word(safe_read16(addr).unwrap() as u16);
    fpu_set_status_word(safe_read16(addr + 4).unwrap() as u16);
    fpu_set_tag_word(safe_read16(addr + 8).unwrap());
    *fpu_ip = safe_read32s(addr + 12).unwrap();
    *fpu_ip_selector = safe_read16(addr + 16).unwrap();
    *fpu_opcode = safe_read16(addr + 18).unwrap();
    *fpu_dp = safe_read32s(addr + 20).unwrap();
    *fpu_dp_selector = safe_read16(addr + 24).unwrap()
}
pub unsafe fn fpu_unimpl() {
    dbg_assert!(false);
    trigger_ud();
}
pub unsafe fn fpu_set_tag_word(tag_word: i32) {
    *fpu_stack_empty = 0;
    for i in 0..8 {
        let empty = tag_word >> (2 * i) & 3 == 3;
        *fpu_stack_empty |= (empty as u8) << i;
    }
}
pub unsafe fn fpu_set_status_word(sw: u16) {
    *fpu_status_word = sw & !(7 << 11);
    *fpu_stack_ptr = (sw >> 11 & 7) as u8;
}

pub unsafe fn fpu_fldm32(addr: i32) { fpu_push(return_on_pagefault!(fpu_load_m32(addr))); }
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
pub unsafe fn fpu_fmul(target_index: i32, val: F80) {
    let st0 = fpu_get_st0();
    fpu_write_st(*fpu_stack_ptr as i32 + target_index & 7, st0 * val);
}
pub unsafe fn fpu_fnstsw_mem(addr: i32) {
    return_on_pagefault!(safe_write16(addr, fpu_load_status_word().into()));
}
pub unsafe fn fpu_fnstsw_reg() { write_reg16(AX, fpu_load_status_word().into()); }
pub unsafe fn fpu_fprem(ieee: bool) {
    // false: Faster, fails nasmtests
    // true: Slower, fails qemutests
    let intel_compatibility = false;

    let st0 = fpu_get_st0();
    let st1 = fpu_get_sti(1);

    if st1 == F80::ZERO {
        if st0 == F80::ZERO {
            fpu_invalid_arithmetic();
        }
        else {
            fpu_zero_fault();
        }
        fpu_write_st(*fpu_stack_ptr as i32, F80::INDEFINITE_NAN);
        return;
    }

    let exp0 = st0.log2();
    let exp1 = st1.log2();
    let d = (exp0 - exp1).abs();
    if !intel_compatibility || d < F80::of_f64(f64::to_bits(64.0)) {
        let fprem_quotient =
            (if ieee { (st0 / st1).round() } else { (st0 / st1).trunc() }).to_i32();
        fpu_write_st(*fpu_stack_ptr as i32, st0 % st1);
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
        let n = F80::of_f64(f64::to_bits(32.0));
        let fprem_quotient =
            (if ieee { (st0 / st1).round() } else { (st0 / st1).trunc() } / (d - n).two_pow());
        fpu_write_st(
            *fpu_stack_ptr as i32,
            st0 - st1 * fprem_quotient * (d - n).two_pow(),
        );
        *fpu_status_word |= FPU_C2;
    }
}

pub unsafe fn fpu_frstor16(_addr: i32) {
    dbg_log!("frstor16");
    fpu_unimpl();
}
pub unsafe fn fpu_frstor32(mut addr: i32) {
    return_on_pagefault!(readable_or_pagefault(addr, 28 + 8 * 10));
    fpu_fldenv32(addr);
    addr += 28;
    for i in 0..8 {
        let reg_index = *fpu_stack_ptr as i32 + i & 7;
        *fpu_st.offset(reg_index as isize) = fpu_load_m80(addr).unwrap();
        addr += 10;
    }
}

pub unsafe fn fpu_fsave16(_addr: i32) {
    dbg_log!("fsave16");
    fpu_unimpl();
}
pub unsafe fn fpu_fsave32(mut addr: i32) {
    return_on_pagefault!(writable_or_pagefault(addr, 108));
    fpu_fstenv32(addr);
    addr += 28;
    for i in 0..8 {
        let reg_index = i + *fpu_stack_ptr as i32 & 7;
        fpu_store_m80(addr, *fpu_st.offset(reg_index as isize));
        addr += 10;
    }
    fpu_finit();
}

pub unsafe fn fpu_store_m80(addr: i32, f: F80) {
    // writable_or_pagefault must have checked called by the caller!
    safe_write64(addr, f.mantissa).unwrap();
    safe_write16(addr + 8, f.sign_exponent as i32).unwrap();
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
    let high_bits = 0xFFFF0000u32 as i32;
    safe_write32(addr + 0, high_bits + *fpu_control_word as i32).unwrap();
    safe_write32(addr + 4, high_bits + fpu_load_status_word() as i32).unwrap();
    safe_write32(addr + 8, high_bits + fpu_load_tag_word()).unwrap();
    safe_write32(addr + 12, *fpu_ip).unwrap();
    safe_write16(addr + 16, *fpu_ip_selector).unwrap();
    safe_write16(addr + 18, *fpu_opcode).unwrap();
    safe_write32(addr + 20, *fpu_dp).unwrap();
    safe_write32(addr + 24, high_bits | *fpu_dp_selector).unwrap();
}
#[no_mangle]
pub unsafe fn fpu_load_tag_word() -> i32 {
    let mut tag_word = 0;
    for i in 0..8 {
        let value = *fpu_st.offset(i as isize);
        if 0 != *fpu_stack_empty >> i & 1 {
            tag_word |= 3 << (i << 1)
        }
        else if value == F80::ZERO {
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
pub unsafe fn fpu_fst80p(addr: i32) {
    return_on_pagefault!(writable_or_pagefault(addr, 10));
    fpu_store_m80(addr, fpu_get_st0());
    fpu_pop();
}

pub unsafe fn fpu_fstcw(addr: i32) {
    return_on_pagefault!(safe_write16(addr, (*fpu_control_word).into()));
}

pub unsafe fn fpu_fstm32(addr: i32) {
    return_on_pagefault!(fpu_store_m32(addr, fpu_get_st0()));
}
pub unsafe fn fpu_store_m32(addr: i32, x: F80) -> OrPageFault<()> {
    F80::clear_exception_flags();
    safe_write32(addr, x.to_f32())?;
    *fpu_status_word |= F80::get_exception_flags() as u16;
    Ok(())
}
pub unsafe fn fpu_fstm32p(addr: i32) {
    return_on_pagefault!(fpu_store_m32(addr, fpu_get_st0()));
    fpu_pop();
}
pub unsafe fn fpu_fstm64(addr: i32) {
    return_on_pagefault!(fpu_store_m64(addr, fpu_get_st0()));
}
pub unsafe fn fpu_store_m64(addr: i32, x: F80) -> OrPageFault<()> { safe_write64(addr, x.to_f64()) }
pub unsafe fn fpu_fstm64p(addr: i32) {
    // XXX: writable_or_pagefault before get_st0
    return_on_pagefault!(fpu_store_m64(addr, fpu_get_st0()));
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_fstp(r: i32) {
    fpu_fst(r);
    fpu_pop();
}

#[no_mangle]
pub unsafe fn fpu_fbstp(addr: i32) {
    match writable_or_pagefault(addr, 26) {
        Ok(()) => *page_fault = false,
        Err(()) => {
            *page_fault = true;
            return;
        },
    }
    let st0 = fpu_get_st0();
    let mut x = st0.to_i64().unsigned_abs();
    if x <= 99_9999_9999_9999_9999 {
        for i in 0..=8 {
            let low = x % 10;
            x /= 10;
            let high = x % 10;
            x /= 10;
            safe_write8(addr + i, (high as i32) << 4 | low as i32).unwrap();
        }
        safe_write8(addr + 9, if st0.sign() { 0x80 } else { 0 }).unwrap();
    }
    else {
        fpu_invalid_arithmetic();
        safe_write64(addr + 0, 0xC000_0000_0000_0000).unwrap();
        safe_write16(addr + 8, 0xFFFF).unwrap();
    }
    fpu_pop();
}

#[no_mangle]
pub unsafe fn fpu_fsub(target_index: i32, val: F80) {
    let st0 = fpu_get_st0();
    fpu_write_st(*fpu_stack_ptr as i32 + target_index & 7, st0 - val)
}
#[no_mangle]
pub unsafe fn fpu_fsubr(target_index: i32, val: F80) {
    let st0 = fpu_get_st0();
    fpu_write_st(*fpu_stack_ptr as i32 + target_index & 7, val - st0)
}

pub unsafe fn fpu_ftst() {
    let x = fpu_get_st0();
    *fpu_status_word &= !FPU_RESULT_FLAGS;
    if x.is_nan() {
        *fpu_status_word |= FPU_C3 | FPU_C2 | FPU_C0
    }
    else if x == F80::ZERO {
        *fpu_status_word |= FPU_C3
    }
    else if x < F80::ZERO {
        *fpu_status_word |= FPU_C0
    }
    // TODO: unordered (x is nan, etc)
}

#[no_mangle]
pub unsafe fn fpu_fucom(r: i32) {
    F80::clear_exception_flags();
    let x = fpu_get_st0();
    let y = fpu_get_sti(r);
    *fpu_status_word &= !FPU_RESULT_FLAGS;
    match x.partial_cmp_quiet(&y) {
        Some(std::cmp::Ordering::Greater) => {},
        Some(std::cmp::Ordering::Less) => *fpu_status_word |= FPU_C0,
        Some(std::cmp::Ordering::Equal) => *fpu_status_word |= FPU_C3,
        None => *fpu_status_word |= FPU_C0 | FPU_C2 | FPU_C3,
    }
    *fpu_status_word |= F80::get_exception_flags() as u16;
}

#[no_mangle]
pub unsafe fn fpu_fucomi(r: i32) {
    F80::clear_exception_flags();
    let x = fpu_get_st0();
    let y = fpu_get_sti(r);
    *flags_changed = 0;
    *flags &= !FLAGS_ALL;
    match x.partial_cmp_quiet(&y) {
        Some(std::cmp::Ordering::Greater) => {},
        Some(std::cmp::Ordering::Less) => *flags |= 1,
        Some(std::cmp::Ordering::Equal) => *flags |= FLAG_ZERO,
        None => *flags |= 1 | FLAG_PARITY | FLAG_ZERO,
    }
    *fpu_status_word |= F80::get_exception_flags() as u16;
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

pub unsafe fn fpu_fxam() {
    let x = fpu_get_st0();
    *fpu_status_word &= !FPU_RESULT_FLAGS;
    *fpu_status_word |= (x.sign() as u16) << 9;
    if 0 != *fpu_stack_empty >> *fpu_stack_ptr & 1 {
        *fpu_status_word |= FPU_C3 | FPU_C0
    }
    else if x.is_nan() {
        *fpu_status_word |= FPU_C0
    }
    else if x == F80::ZERO {
        *fpu_status_word |= FPU_C3
    }
    else if !x.is_finite() {
        *fpu_status_word |= FPU_C2 | FPU_C0
    }
    else {
        *fpu_status_word |= FPU_C2
    }
    // TODO:
    // Unsupported, Denormal
}

#[no_mangle]
pub unsafe fn fpu_fxch(i: i32) {
    let sti = fpu_get_sti(i);
    fpu_write_st(*fpu_stack_ptr as i32 + i & 7, fpu_get_st0());
    fpu_write_st(*fpu_stack_ptr as i32, sti);
}
pub unsafe fn fpu_fyl2x() {
    let st0 = fpu_get_st0();
    if st0 < F80::ZERO {
        fpu_invalid_arithmetic();
    }
    else if st0 == F80::ZERO {
        fpu_zero_fault();
    }
    fpu_write_st(
        *fpu_stack_ptr as i32 + 1 & 7,
        fpu_get_sti(1) * st0.ln() / F80::LN_2,
    );
    fpu_pop();
}

pub unsafe fn fpu_fxtract() {
    let st0 = fpu_get_st0();
    if st0 == F80::ZERO {
        fpu_zero_fault();
        fpu_write_st(*fpu_stack_ptr as i32, F80::NEG_INFINITY);
        fpu_push(st0);
    }
    else {
        let exp = st0.exponent();
        fpu_write_st(*fpu_stack_ptr as i32, F80::of_i32(exp.into()));
        fpu_push(F80 {
            sign_exponent: 0x3FFF,
            mantissa: st0.mantissa,
        });
    }
}

pub unsafe fn fwait() {
    // NOP unless FPU instructions run in parallel with CPU instructions
}

pub unsafe fn fpu_fchs() {
    let st0 = fpu_get_st0();
    fpu_write_st(*fpu_stack_ptr as i32, -st0);
}

pub unsafe fn fpu_fabs() {
    let st0 = fpu_get_st0();
    fpu_write_st(*fpu_stack_ptr as i32, st0.abs());
}

pub unsafe fn fpu_f2xm1() {
    let st0 = fpu_get_st0();
    let r = st0.two_pow() - F80::ONE;
    fpu_write_st(*fpu_stack_ptr as i32, r)
}

pub unsafe fn fpu_fptan() {
    let st0 = fpu_get_st0();
    //if -pow(2.0, 63.0) < st0 && st0 < pow(2.0, 63.0) {
    fpu_write_st(*fpu_stack_ptr as i32, st0.tan());
    // no bug: push constant 1
    fpu_push(F80::ONE);
    *fpu_status_word &= !FPU_C2;
    //}
    //else {
    //    *fpu_status_word |= FPU_C2;
    //}
}

pub unsafe fn fpu_fpatan() {
    let st0 = fpu_get_st0();
    let st1 = fpu_get_sti(1);
    fpu_write_st(*fpu_stack_ptr as i32 + 1 & 7, st1.atan2(st0));
    fpu_pop();
}

pub unsafe fn fpu_fyl2xp1() {
    // fyl2xp1: y * log2(x+1) and pop
    let st0 = fpu_get_st0();
    let st1 = fpu_get_sti(1);
    let y = st1 * (st0 + F80::ONE).ln() / F80::LN_2;
    fpu_write_st(*fpu_stack_ptr as i32 + 1 & 7, y);
    fpu_pop();
}

pub unsafe fn fpu_fsqrt() {
    let st0 = fpu_get_st0();
    //if st0 < 0.0 {
    //    fpu_invalid_arithmetic();
    //}
    fpu_write_st(*fpu_stack_ptr as i32, st0.sqrt())
}

pub unsafe fn fpu_fsincos() {
    let st0 = fpu_get_st0();
    //if pow(-2.0, 63.0) < st0 && st0 < pow(2.0, 63.0) {
    fpu_write_st(*fpu_stack_ptr as i32, st0.sin());
    fpu_push(st0.cos());
    *fpu_status_word &= !FPU_C2;
    //}
    //else {
    //    *fpu_status_word |= FPU_C2;
    //}
}

pub unsafe fn fpu_frndint() {
    let st0 = fpu_get_st0();
    fpu_write_st(*fpu_stack_ptr as i32, st0.round());
}

pub unsafe fn fpu_fscale() {
    let st0 = fpu_get_st0();
    let y = st0 * fpu_get_sti(1).trunc().two_pow();
    fpu_write_st(*fpu_stack_ptr as i32, y);
}

pub unsafe fn fpu_fsin() {
    let st0 = fpu_get_st0();
    //if pow(-2.0, 63.0) < st0 && st0 < pow(2.0, 63.0) {
    fpu_write_st(*fpu_stack_ptr as i32, st0.sin());
    *fpu_status_word &= !FPU_C2;
    //}
    //else {
    //    *fpu_status_word |= FPU_C2;
    //}
}

pub unsafe fn fpu_fcos() {
    let st0 = fpu_get_st0();
    //if pow(-2.0, 63.0) < st0 && st0 < pow(2.0, 63.0) {
    fpu_write_st(*fpu_stack_ptr as i32, st0.cos());
    *fpu_status_word &= !FPU_C2;
    //}
    //else {
    //    *fpu_status_word |= FPU_C2;
    //}
}

pub unsafe fn fpu_fdecstp() {
    *fpu_stack_ptr = *fpu_stack_ptr - 1 & 7;
    *fpu_status_word &= !FPU_C1
}

pub unsafe fn fpu_fincstp() {
    *fpu_stack_ptr = *fpu_stack_ptr + 1 & 7;
    *fpu_status_word &= !FPU_C1
}
