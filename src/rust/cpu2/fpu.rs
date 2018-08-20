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

#[no_mangle]
pub static mut M_LOG2E: f64 = unsafe { 1.4426950408889634f64 };
#[no_mangle]
pub static mut M_LN2: f64 = unsafe { 0.6931471805599453f64 };
#[no_mangle]
pub static mut M_LN10: f64 = unsafe { 2.302585092994046f64 };
#[no_mangle]
pub static mut M_PI: f64 = unsafe { 3.141592653589793f64 };
#[no_mangle]
pub static mut FPU_C0: i32 = unsafe { 256i32 };
#[no_mangle]
pub static mut FPU_C1: i32 = unsafe { 512i32 };
#[no_mangle]
pub static mut FPU_C2: i32 = unsafe { 1024i32 };
#[no_mangle]
pub static mut FPU_C3: i32 = unsafe { 16384i32 };
#[no_mangle]
pub static mut FPU_RESULT_FLAGS: i32 = unsafe { FPU_C0 | FPU_C1 | FPU_C2 | FPU_C3 };
#[no_mangle]
pub static mut FPU_STACK_TOP: i32 = unsafe { 14336i32 };
#[no_mangle]
pub unsafe fn fpu_get_st0() -> f64 {
    if 0 != *fpu_stack_empty >> *fpu_stack_ptr & 1i32 {
        *fpu_status_word &= !FPU_C1;
        fpu_stack_fault();
        return INDEFINITE_NAN;
    }
    else {
        return *fpu_st.offset(*fpu_stack_ptr as isize);
    };
}
#[no_mangle]
pub static mut INDEFINITE_NAN: f64 = unsafe { ::std::f32::NAN as f64 };
#[no_mangle]
pub unsafe fn fpu_stack_fault() -> () {
    c_comment!(("TODO: Interrupt"));
    *fpu_status_word |= FPU_EX_SF | FPU_EX_I;
}
#[no_mangle]
pub static mut FPU_EX_I: i32 = unsafe { 1i32 << 0i32 };
#[no_mangle]
pub static mut FPU_EX_SF: i32 = unsafe { 1i32 << 6i32 };
#[no_mangle]
pub unsafe fn fpu_get_sti(mut i: i32) -> f64 {
    dbg_assert!(i >= 0i32 && i < 8i32);
    i = ((i as u32).wrapping_add(*fpu_stack_ptr) & 7i32 as u32) as i32;
    if 0 != *fpu_stack_empty >> i & 1i32 {
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
    let mut rc: i32 = *fpu_control_word >> 10i32 & 3i32;
    c_comment!(("XXX: See https://en.wikipedia.org/wiki/C_mathematical_functions"));
    if rc == 0i32 {
        c_comment!(("Round to nearest, or even if equidistant"));
        let mut rounded: f64 = round(f);
        let mut diff: f64 = rounded - f;
        if diff == 0.5f64 || diff == -0.5f64 {
            rounded = 2.0f64 * round(f * 0.5f64)
        }
        return rounded;
    }
    else if rc == 1i32 || rc == 3i32 && f > 0i32 as f64 {
        c_comment!(("rc=3 is truncate -> floor for positive numbers"));
        return floor(f);
    }
    else {
        return ceil(f);
    };
}
#[no_mangle]
pub unsafe fn fpu_load_m32(mut addr: i32) -> Result<f64, ()> {
    let mut v: f32_int = f32_int {
        i32_0: safe_read32s(addr)?,
    };
    Ok(v.f32_0 as f64)
}
#[no_mangle]
pub unsafe fn fpu_load_m64(mut addr: i32) -> Result<f64, ()> {
    let mut value: u64 = safe_read64s(addr)?.u64_0[0usize];
    let mut v: f64_int = f64_int { u64_0: [value] };
    Ok(v.f64_0)
}
#[no_mangle]
pub unsafe fn fpu_load_m80(mut addr: u32) -> Result<f64, ()> {
    let mut value: u64 = safe_read64s(addr as i32)?.u64_0[0usize];
    let mut low: u32 = value as u32;
    let mut high: u32 = (value >> 32i32) as u32;
    let mut exponent: i32 = safe_read16(addr.wrapping_add(8i32 as u32) as i32)?;
    let mut sign: i32 = exponent >> 15i32;
    exponent &= !32768i32;
    if exponent == 0i32 {
        c_comment!(("TODO: denormal numbers"));
        Ok(0i32 as f64)
    }
    else if exponent < 32767i32 {
        exponent -= 16383i32;
        c_comment!(("Note: some bits might be lost at this point"));
        let mut mantissa: f64 = low as f64 + 4294967296i64 as f64 * high as f64;
        if 0 != sign {
            mantissa = -mantissa
        }
        c_comment!(("Simply compute the 64 bit floating point number."));
        c_comment!(("An alternative write the mantissa, sign and exponent in the"));
        c_comment!(("float64_byte and return float64[0]"));
        Ok(mantissa * pow(2i32 as f64, (exponent - 63i32) as f64))
    }
    else {
        c_comment!(("TODO: NaN, Infinity"));
        if 0 != 0i32 * 0i32 {
            dbg_log_c!("Load m80 TODO");
        }
        let mut double_int_view: f64_int = f64_int { u8_0: [0; 8] };
        double_int_view.u8_0[7usize] = (127i32 | sign << 7i32) as u8;
        double_int_view.u8_0[6usize] = (240i32 as u32 | high >> 30i32 << 3i32 & 8i32 as u32) as u8;
        double_int_view.u8_0[5usize] = 0i32 as u8;
        double_int_view.u8_0[4usize] = 0i32 as u8;
        double_int_view.i32_0[0usize] = 0i32;
        Ok(double_int_view.f64_0)
    }
}
#[no_mangle]
pub unsafe fn fpu_load_status_word() -> i32 {
    return ((*fpu_status_word & !(7i32 << 11i32)) as u32 | *fpu_stack_ptr << 11i32) as i32;
}
#[no_mangle]
pub unsafe fn fpu_fadd(mut target_index: i32, mut val: f64) -> () {
    let mut st0: f64 = fpu_get_st0();
    *fpu_st.offset(((*fpu_stack_ptr).wrapping_add(target_index as u32) & 7i32 as u32) as isize) =
        st0 + val;
}
#[no_mangle]
pub unsafe fn fpu_fclex() -> () { *fpu_status_word = 0i32; }
#[no_mangle]
pub unsafe fn fpu_fcmovcc(mut condition: bool, mut r: i32) -> () {
    if condition {
        *fpu_st.offset(*fpu_stack_ptr as isize) = fpu_get_sti(r);
        *fpu_stack_empty &= !(1i32 << *fpu_stack_ptr)
    };
}
#[no_mangle]
pub unsafe fn fpu_fcom(mut y: f64) -> () {
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
pub unsafe fn fpu_fcomi(mut r: i32) -> () {
    let mut y: f64 = fpu_get_sti(r);
    let mut x: f64 = *fpu_st.offset(*fpu_stack_ptr as isize);
    *flags_changed &= !(1i32 | FLAG_PARITY | FLAG_ZERO);
    *flags &= !(1i32 | FLAG_PARITY | FLAG_ZERO);
    if !(x > y) {
        if y > x {
            *flags |= 1i32
        }
        else if x == y {
            *flags |= FLAG_ZERO
        }
        else {
            *flags |= 1i32 | FLAG_PARITY | FLAG_ZERO
        }
    };
}
#[no_mangle]
pub unsafe fn fpu_fcomip(mut r: i32) -> () {
    fpu_fcomi(r);
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_pop() -> () {
    *fpu_stack_empty |= 1i32 << *fpu_stack_ptr;
    *fpu_stack_ptr = (*fpu_stack_ptr).wrapping_add(1i32 as u32) & 7i32 as u32;
}
#[no_mangle]
pub unsafe fn fpu_fcomp(mut val: f64) -> () {
    fpu_fcom(val);
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_fdiv(mut target_index: i32, mut val: f64) -> () {
    let mut st0: f64 = fpu_get_st0();
    *fpu_st.offset(((*fpu_stack_ptr).wrapping_add(target_index as u32) & 7i32 as u32) as isize) =
        st0 / val;
}
#[no_mangle]
pub unsafe fn fpu_fdivr(mut target_index: i32, mut val: f64) -> () {
    let mut st0: f64 = fpu_get_st0();
    *fpu_st.offset(((*fpu_stack_ptr).wrapping_add(target_index as u32) & 7i32 as u32) as isize) =
        val / st0;
}
#[no_mangle]
pub unsafe fn fpu_ffree(mut r: i32) -> () {
    *fpu_stack_empty |= 1i32 << (*fpu_stack_ptr).wrapping_add(r as u32);
}
#[no_mangle]
pub unsafe fn fpu_fildm64(mut addr: i32) -> () {
    let mut value: i64 = return_on_pagefault!(safe_read64s(addr)).i64_0[0usize];
    let mut m64: f64 = value as f64;
    fpu_push(m64);
}
#[no_mangle]
pub unsafe fn fpu_push(mut x: f64) -> () {
    *fpu_stack_ptr = (*fpu_stack_ptr).wrapping_sub(1i32 as u32) & 7i32 as u32;
    if 0 != *fpu_stack_empty >> *fpu_stack_ptr & 1i32 {
        *fpu_status_word &= !FPU_C1;
        *fpu_stack_empty &= !(1i32 << *fpu_stack_ptr);
        *fpu_st.offset(*fpu_stack_ptr as isize) = x
    }
    else {
        *fpu_status_word |= FPU_C1;
        fpu_stack_fault();
        *fpu_st.offset(*fpu_stack_ptr as isize) = INDEFINITE_NAN
    };
}
#[no_mangle]
pub unsafe fn fpu_finit() -> () {
    *fpu_control_word = 895i32;
    *fpu_status_word = 0i32;
    *fpu_ip.offset(0isize) = 0i32;
    *fpu_dp.offset(0isize) = 0i32;
    *fpu_opcode.offset(0isize) = 0i32;
    *fpu_stack_empty = 255i32;
    *fpu_stack_ptr = 0i32 as u32;
}
#[no_mangle]
pub unsafe fn fpu_fistm16(mut addr: i32) -> () {
    let mut st0: f64 = fpu_integer_round(fpu_get_st0());
    if st0 <= 32767i32 as f64 && st0 >= -32768i32 as f64 {
        return_on_pagefault!(safe_write16(addr, st0 as i32));
    }
    else {
        fpu_invalid_arithmetic();
        return_on_pagefault!(safe_write16(addr, 32768i32));
    };
}
#[no_mangle]
pub unsafe fn fpu_invalid_arithmetic() -> () { *fpu_status_word |= FPU_EX_I; }
#[no_mangle]
pub unsafe fn fpu_fistm16p(mut addr: i32) -> () {
    fpu_fistm16(addr);
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_fistm32(mut addr: i32) -> () {
    let mut st0: f64 = fpu_integer_round(fpu_get_st0());
    let mut i: i32 = convert_f64_to_i32(st0);
    if i == 2147483648u32 as i32 {
        c_comment!(("XXX: Probably not correct if st0 == 0x80000000"));
        c_comment!(("(input fits, but same value as error value)"));
        fpu_invalid_arithmetic();
    }
    return_on_pagefault!(safe_write32(addr, i));
}
#[no_mangle]
pub unsafe fn fpu_fistm32p(mut addr: i32) -> () {
    fpu_fistm32(addr);
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_fistm64p(mut addr: i32) -> () {
    let mut st0: f64 = fpu_integer_round(fpu_get_st0());
    let mut value: i64 = 0;
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
pub static mut TWO_POW_63: f64 = unsafe { 9223372036854775808u64 as f64 };
#[no_mangle]
pub unsafe fn fpu_fldcw(mut addr: i32) -> () {
    let mut word: i32 = return_on_pagefault!(safe_read16(addr));
    *fpu_control_word = word;
}
#[no_mangle]
pub unsafe fn fpu_fldenv(mut addr: i32) -> () {
    if is_osize_32() {
        // TODO: Add readable_or_pagefault
        return_on_pagefault!(translate_address_read(addr));
        return_on_pagefault!(translate_address_read(addr + 28));
        *fpu_control_word = safe_read16(addr).unwrap();
        fpu_set_status_word(safe_read16(addr + 4i32).unwrap());
        fpu_set_tag_word(safe_read16(addr + 8i32).unwrap());
        *fpu_ip.offset(0isize) = safe_read32s(addr + 12i32).unwrap();
        *fpu_ip_selector.offset(0isize) = safe_read16(addr + 16i32).unwrap();
        *fpu_opcode.offset(0isize) = safe_read16(addr + 18i32).unwrap();
        *fpu_dp.offset(0isize) = safe_read32s(addr + 20i32).unwrap();
        *fpu_dp_selector.offset(0isize) = safe_read16(addr + 24i32).unwrap()
    }
    else {
        dbg_log_c!("fldenv16");
        fpu_unimpl();
    };
}
#[no_mangle]
pub unsafe fn fpu_unimpl() -> () {
    if DEBUG {
        dbg_assert!(0 != 0i32);
    }
    else {
        trigger_ud();
    };
}
#[no_mangle]
pub unsafe fn fpu_set_tag_word(mut tag_word: i32) -> () {
    *fpu_stack_empty = 0i32;
    let mut i: i32 = 0i32;
    while i < 8i32 {
        *fpu_stack_empty |= tag_word >> i & tag_word >> i + 1i32 & 1i32 << i;
        i += 1
    }
}
#[no_mangle]
pub unsafe fn fpu_set_status_word(mut sw: i32) -> () {
    *fpu_status_word = sw & !(7i32 << 11i32);
    *fpu_stack_ptr = (sw >> 11i32 & 7i32) as u32;
}
#[no_mangle]
pub unsafe fn fpu_fldm32(mut addr: i32) -> () {
    fpu_push(return_on_pagefault!(safe_read32s(addr)) as f64);
}
#[no_mangle]
pub unsafe fn fpu_fldm64(mut addr: i32) -> () {
    fpu_push(return_on_pagefault!(fpu_load_m64(addr)));
}
#[no_mangle]
pub unsafe fn fpu_fldm80(mut addr: i32) -> () {
    fpu_push(return_on_pagefault!(fpu_load_m80(addr as u32)));
}
#[no_mangle]
pub unsafe fn fpu_fmul(mut target_index: i32, mut val: f64) -> () {
    let mut st0: f64 = fpu_get_st0();
    *fpu_st.offset(((*fpu_stack_ptr).wrapping_add(target_index as u32) & 7i32 as u32) as isize) =
        st0 * val;
}
#[no_mangle]
pub unsafe fn fpu_fnstsw_mem(mut addr: i32) -> () {
    return_on_pagefault!(safe_write16(addr, fpu_load_status_word()));
}
#[no_mangle]
pub unsafe fn fpu_fnstsw_reg() -> () { *reg16.offset(AX as isize) = fpu_load_status_word() as u16; }
#[no_mangle]
pub unsafe fn fpu_fprem() -> () {
    c_comment!(("XXX: This implementation differs from the description in Intel\'s manuals"));
    let mut st0: f64 = fpu_get_st0();
    let mut st1: f64 = fpu_get_sti(1i32);
    let mut fprem_quotient: i32 = convert_f64_to_i32(trunc(st0 / st1));
    *fpu_st.offset(*fpu_stack_ptr as isize) = fmod(st0, st1);
    *fpu_status_word &= !(FPU_C0 | FPU_C1 | FPU_C3);
    if 0 != fprem_quotient & 1i32 {
        *fpu_status_word |= FPU_C1
    }
    if 0 != fprem_quotient & 1i32 << 1i32 {
        *fpu_status_word |= FPU_C3
    }
    if 0 != fprem_quotient & 1i32 << 2i32 {
        *fpu_status_word |= FPU_C0
    }
    *fpu_status_word &= !FPU_C2;
}
#[no_mangle]
pub unsafe fn fpu_frstor(mut addr: i32) -> () {
    // TODO: Add readable_or_pagefault
    return_on_pagefault!(translate_address_read(addr));
    return_on_pagefault!(translate_address_read(addr + 28 + 8 * 10));
    fpu_fldenv(addr);
    addr += 28i32;
    let mut i: i32 = 0i32;
    while i < 8i32 {
        *fpu_st.offset(((i as u32).wrapping_add(*fpu_stack_ptr) & 7i32 as u32) as isize) =
            fpu_load_m80(addr as u32).unwrap();
        addr += 10i32;
        i += 1
    }
}
#[no_mangle]
pub unsafe fn fpu_fsave(mut addr: i32) -> () {
    return_on_pagefault!(writable_or_pagefault(addr, 108i32));
    fpu_fstenv(addr);
    addr += 28i32;
    let mut i: i32 = 0i32;
    while i < 8i32 {
        fpu_store_m80(
            addr as u32,
            *fpu_st.offset(((*fpu_stack_ptr).wrapping_add(i as u32) & 7i32 as u32) as isize),
        );
        addr += 10i32;
        i += 1
    }
    fpu_finit();
}
#[no_mangle]
pub unsafe fn fpu_store_m80(mut addr: u32, mut n: f64) -> () {
    let mut double_int_view: f64_int = f64_int { f64_0: n };
    let mut sign: u8 = (double_int_view.u8_0[7usize] as i32 & 128i32) as u8;
    let mut exponent: i32 = (double_int_view.u8_0[7usize] as i32 & 127i32) << 4i32
        | double_int_view.u8_0[6usize] as i32 >> 4i32;
    let mut low: i32 = 0;
    let mut high: i32 = 0;
    if exponent == 2047i32 {
        c_comment!(("all bits set (NaN and infinity)"));
        exponent = 32767i32;
        low = 0i32;
        high =
            (2147483648u32 | ((double_int_view.i32_0[1usize] & 524288i32) << 11i32) as u32) as i32
    }
    else if exponent == 0i32 {
        c_comment!(("zero and denormal numbers"));
        c_comment!(("Just assume zero for now"));
        low = 0i32;
        high = 0i32
    }
    else {
        exponent += 16383i32 - 1023i32;
        c_comment!(("does the mantissa need to be adjusted?"));
        low = double_int_view.i32_0[0usize] << 11i32;
        high = (2147483648u32
            | ((double_int_view.i32_0[1usize] & 1048575i32) << 11i32) as u32
            | double_int_view.i32_0[0usize] as u32 >> 21i32) as i32
    }
    dbg_assert!(exponent >= 0i32 && exponent < 32768i32);
    c_comment!(("writable_or_pagefault must have checked called by the caller!"));
    safe_write64(
        addr as i32,
        (low as u64 & 4294967295u32 as u64 | (high as u64) << 32i32) as i64,
    ).unwrap();
    safe_write16(
        addr.wrapping_add(8i32 as u32) as i32,
        (sign as i32) << 8i32 | exponent,
    ).unwrap();
}
#[no_mangle]
pub unsafe fn fpu_fstenv(mut addr: i32) -> () {
    if is_osize_32() {
        return_on_pagefault!(writable_or_pagefault(addr, 26i32));
        safe_write16(addr, *fpu_control_word).unwrap();
        safe_write16(addr + 4i32, fpu_load_status_word()).unwrap();
        safe_write16(addr + 8i32, fpu_load_tag_word()).unwrap();
        safe_write32(addr + 12i32, *fpu_ip.offset(0isize)).unwrap();
        safe_write16(addr + 16i32, *fpu_ip_selector.offset(0isize)).unwrap();
        safe_write16(addr + 18i32, *fpu_opcode.offset(0isize)).unwrap();
        safe_write32(addr + 20i32, *fpu_dp.offset(0isize)).unwrap();
        safe_write16(addr + 24i32, *fpu_dp_selector.offset(0isize)).unwrap();
    }
    else {
        dbg_log_c!("fstenv16");
        fpu_unimpl();
    };
}
#[no_mangle]
pub unsafe fn fpu_load_tag_word() -> i32 {
    let mut tag_word: i32 = 0i32;
    let mut i: i32 = 0i32;
    while i < 8i32 {
        let mut value: f64 = *fpu_st.offset(i as isize);
        if 0 != *fpu_stack_empty >> i & 1i32 {
            tag_word |= 3i32 << (i << 1i32)
        }
        else if value == 0i32 as f64 {
            tag_word |= 1i32 << (i << 1i32)
        }
        else if !value.is_finite() {
            tag_word |= 2i32 << (i << 1i32)
        }
        i += 1
    }
    return tag_word;
}
#[no_mangle]
pub unsafe fn fpu_fst(mut r: i32) -> () {
    *fpu_st.offset((*fpu_stack_ptr).wrapping_add(r as u32) as isize) = fpu_get_st0();
}
#[no_mangle]
pub unsafe fn fpu_fst80p(mut addr: i32) -> () {
    return_on_pagefault!(writable_or_pagefault(addr, 10i32));
    fpu_store_m80(addr as u32, fpu_get_st0());
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_fstcw(mut addr: i32) -> () {
    return_on_pagefault!(safe_write16(addr, *fpu_control_word));
}
#[no_mangle]
pub unsafe fn fpu_fstm32(mut addr: i32) -> () {
    return_on_pagefault!(fpu_store_m32(addr, fpu_get_st0()));
}
#[no_mangle]
pub unsafe fn fpu_store_m32(mut addr: i32, mut x: f64) -> Result<(), ()> {
    let mut v: f32_int = f32_int { f32_0: x as f32 };
    safe_write32(addr, v.i32_0)
}
#[no_mangle]
pub unsafe fn fpu_fstm32p(mut addr: i32) -> () {
    fpu_fstm32(addr);
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_fstm64(mut addr: i32) -> () {
    return_on_pagefault!(fpu_store_m64(addr, fpu_get_st0()));
}
#[no_mangle]
pub unsafe fn fpu_store_m64(mut addr: i32, mut x: f64) -> Result<(), ()> {
    let mut v: f64_int = f64_int { f64_0: x };
    safe_write64(addr, v.u64_0[0usize] as i64)
}
#[no_mangle]
pub unsafe fn fpu_fstm64p(mut addr: i32) -> () {
    fpu_fstm64(addr);
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_fstp(mut r: i32) -> () {
    fpu_fst(r);
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_fsub(mut target_index: i32, mut val: f64) -> () {
    let mut st0: f64 = fpu_get_st0();
    *fpu_st.offset(((*fpu_stack_ptr).wrapping_add(target_index as u32) & 7i32 as u32) as isize) =
        st0 - val;
}
#[no_mangle]
pub unsafe fn fpu_fsubr(mut target_index: i32, mut val: f64) -> () {
    let mut st0: f64 = fpu_get_st0();
    *fpu_st.offset(((*fpu_stack_ptr).wrapping_add(target_index as u32) & 7i32 as u32) as isize) =
        val - st0;
}
#[no_mangle]
pub unsafe fn fpu_ftst(mut x: f64) -> () {
    *fpu_status_word &= !FPU_RESULT_FLAGS;
    if x.is_nan() {
        *fpu_status_word |= FPU_C3 | FPU_C2 | FPU_C0
    }
    else if x == 0i32 as f64 {
        *fpu_status_word |= FPU_C3
    }
    else if x < 0i32 as f64 {
        *fpu_status_word |= FPU_C0
    }
    c_comment!(("TODO: unordered (x is nan, etc)"));
}
#[no_mangle]
pub unsafe fn fpu_fucom(mut r: i32) -> () {
    c_comment!(("TODO"));
    fpu_fcom(fpu_get_sti(r));
}
#[no_mangle]
pub unsafe fn fpu_fucomi(mut r: i32) -> () {
    c_comment!(("TODO"));
    fpu_fcomi(r);
}
#[no_mangle]
pub unsafe fn fpu_fucomip(mut r: i32) -> () {
    fpu_fucomi(r);
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_fucomp(mut r: i32) -> () {
    fpu_fucom(r);
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_fucompp() -> () {
    fpu_fucom(1i32);
    fpu_pop();
    fpu_pop();
}
#[no_mangle]
pub unsafe fn fpu_fxam(mut x: f64) -> () {
    *fpu_status_word &= !FPU_RESULT_FLAGS;
    *fpu_status_word |= fpu_sign(0i32) << 9i32;
    if 0 != *fpu_stack_empty >> *fpu_stack_ptr & 1i32 {
        *fpu_status_word |= FPU_C3 | FPU_C0
    }
    else if x.is_nan() {
        *fpu_status_word |= FPU_C0
    }
    else if x == 0i32 as f64 {
        *fpu_status_word |= FPU_C3
    }
    else if x == ::std::f32::INFINITY as f64 || x == -::std::f32::INFINITY as f64 {
        *fpu_status_word |= FPU_C2 | FPU_C0
    }
    else {
        *fpu_status_word |= FPU_C2
    }
    c_comment!(("TODO:"));
    c_comment!(("Unsupported, Denormal"));
}
#[no_mangle]
pub unsafe fn fpu_sign(mut i: i32) -> i32 {
    c_comment!(("sign of a number on the stack"));
    return *fpu_st8.offset(
        (((*fpu_stack_ptr).wrapping_add(i as u32) & 7i32 as u32) << 3i32 | 7i32 as u32) as isize,
    ) as i32
        >> 7i32;
}
#[no_mangle]
pub unsafe fn fpu_fxch(mut i: i32) -> () {
    let mut sti: f64 = fpu_get_sti(i);
    *fpu_st.offset((*fpu_stack_ptr).wrapping_add(i as u32) as isize) = fpu_get_st0();
    *fpu_st.offset(*fpu_stack_ptr as isize) = sti;
}
#[no_mangle]
pub unsafe fn fpu_fxtract() -> () {
    let mut double_int_view: f64_int = f64_int {
        f64_0: fpu_get_st0(),
    };
    let mut exponent: f64 = (((double_int_view.u8_0[7usize] as i32 & 127i32) << 4i32
        | double_int_view.u8_0[6usize] as i32 >> 4i32)
        - 1023i32) as f64;
    double_int_view.u8_0[7usize] = (63i32 | double_int_view.u8_0[7usize] as i32 & 128i32) as u8;
    double_int_view.u8_0[6usize] = (double_int_view.u8_0[6usize] as i32 | 240i32) as u8;
    *fpu_st.offset(*fpu_stack_ptr as isize) = exponent;
    fpu_push(double_int_view.f64_0);
}
#[no_mangle]
pub unsafe fn fwait() -> () {
    c_comment!(("NOP unless FPU instructions run in parallel with CPU instructions"));
}
#[no_mangle]
pub static mut FPU_PC: i32 = unsafe { 3i32 << 8i32 };
#[no_mangle]
pub static mut FPU_RC: i32 = unsafe { 3i32 << 10i32 };
#[no_mangle]
pub static mut FPU_IF: i32 = unsafe { 1i32 << 12i32 };
#[no_mangle]
pub static mut FPU_EX_P: i32 = unsafe { 1i32 << 5i32 };
#[no_mangle]
pub static mut FPU_EX_U: i32 = unsafe { 1i32 << 4i32 };
#[no_mangle]
pub static mut FPU_EX_O: i32 = unsafe { 1i32 << 3i32 };
#[no_mangle]
pub static mut FPU_EX_Z: i32 = unsafe { 1i32 << 2i32 };
#[no_mangle]
pub static mut FPU_EX_D: i32 = unsafe { 1i32 << 1i32 };
