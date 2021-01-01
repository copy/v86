use cpu::cpu::*;
use cpu::global_pointers::mxcsr;

pub unsafe fn mov_r_m64(addr: i32, r: i32) {
    // mov* m64, mm
    let data = read_mmx64s(r);
    return_on_pagefault!(safe_write64(addr, data));
    transition_fpu_to_mmx();
}
pub unsafe fn movl_r128_m64(addr: i32, r: i32) {
    // mov* m64, xmm
    let data = read_xmm64s(r);
    return_on_pagefault!(safe_write64(addr, data));
}
pub unsafe fn mov_r_r128(r1: i32, r2: i32) {
    // mov* xmm, xmm
    let data = read_xmm128s(r2);
    write_xmm_reg128(r1, data);
}
pub unsafe fn mov_r_m128(addr: i32, r: i32) {
    // mov* m128, xmm
    let data = read_xmm128s(r);
    return_on_pagefault!(safe_write128(addr, data));
}
pub unsafe fn mov_rm_r128(source: reg128, r: i32) {
    // mov* xmm, xmm/m128
    write_xmm_reg128(r, source);
}
pub unsafe fn movh_m64_r128(addr: i32, r: i32) {
    // movhp* xmm, m64
    let data = return_on_pagefault!(safe_read64s(addr));
    let orig = read_xmm128s(r);
    write_xmm128(
        r,
        orig.u32_0[0] as i32,
        orig.u32_0[1] as i32,
        data as i32,
        (data >> 32) as i32,
    );
}
pub unsafe fn movh_r128_m64(addr: i32, r: i32) {
    // movhp* m64, xmm
    let data = read_xmm128s(r);
    return_on_pagefault!(safe_write64(addr, data.u64_0[1]));
}

pub unsafe fn pand_r128(source: reg128, r: i32) {
    // pand xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8_0: [0; 16] };
    result.u64_0[0] = source.u64_0[0] & destination.u64_0[0];
    result.u64_0[1] = source.u64_0[1] & destination.u64_0[1];
    write_xmm_reg128(r, result);
}
pub unsafe fn pandn_r128(source: reg128, r: i32) {
    // pandn xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8_0: [0; 16] };
    result.u64_0[0] = source.u64_0[0] & !destination.u64_0[0];
    result.u64_0[1] = source.u64_0[1] & !destination.u64_0[1];
    write_xmm_reg128(r, result);
}
pub unsafe fn pxor_r128(source: reg128, r: i32) {
    // pxor xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8_0: [0; 16] };
    result.u64_0[0] = source.u64_0[0] ^ destination.u64_0[0];
    result.u64_0[1] = source.u64_0[1] ^ destination.u64_0[1];
    write_xmm_reg128(r, result);
}
pub unsafe fn por_r128(source: reg128, r: i32) {
    // por xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8_0: [0; 16] };
    result.u64_0[0] = source.u64_0[0] | destination.u64_0[0];
    result.u64_0[1] = source.u64_0[1] | destination.u64_0[1];
    write_xmm_reg128(r, result);
}

pub unsafe fn psrlw_r64(r: i32, shift: u64) {
    // psrlw mm, {shift}
    let destination: [u16; 4] = std::mem::transmute(read_mmx64s(r));
    let shift = if shift > 15 { 16 } else { shift };
    let mut result = [0; 4];
    for i in 0..4 {
        result[i] = ((destination[i] as u32) >> shift) as u16
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn psraw_r64(r: i32, shift: u64) {
    // psraw mm, {shift}
    let destination: [i16; 4] = std::mem::transmute(read_mmx64s(r));
    let shift = if shift > 15 { 16 } else { shift };
    let mut result = [0; 4];
    for i in 0..4 {
        result[i] = (destination[i] as i32 >> shift) as i16
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn psllw_r64(r: i32, shift: u64) {
    // psllw mm, {shift}
    let destination: [i16; 4] = std::mem::transmute(read_mmx64s(r));
    let mut result = [0; 4];
    if shift <= 15 {
        for i in 0..4 {
            result[i] = destination[i] << shift
        }
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn psrld_r64(r: i32, shift: u64) {
    // psrld mm, {shift}
    let destination: [u32; 2] = std::mem::transmute(read_mmx64s(r));
    let mut result = [0; 2];
    if shift <= 31 {
        for i in 0..2 {
            result[i] = destination[i] >> shift;
        }
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn psrad_r64(r: i32, shift: u64) {
    // psrad mm, {shift}
    let destination: [i32; 2] = std::mem::transmute(read_mmx64s(r));
    let shift = if shift > 31 { 31 } else { shift };
    let mut result = [0; 2];
    for i in 0..2 {
        result[i] = destination[i] >> shift;
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn pslld_r64(r: i32, shift: u64) {
    // pslld mm, {shift}
    let destination: [i32; 2] = std::mem::transmute(read_mmx64s(r));
    let mut result = [0; 2];
    if shift <= 31 {
        for i in 0..2 {
            result[i] = destination[i] << shift;
        }
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn psrlq_r64(r: i32, shift: u64) {
    // psrlq mm, {shift}
    let destination = read_mmx64s(r);
    let mut result = 0;
    if shift <= 63 {
        result = destination >> shift
    }
    write_mmx_reg64(r, result);
    transition_fpu_to_mmx();
}
pub unsafe fn psllq_r64(r: i32, shift: u64) {
    // psllq mm, {shift}
    let destination = read_mmx64s(r);
    let mut result = 0;
    if shift <= 63 {
        result = destination << shift
    }
    write_mmx_reg64(r, result);
    transition_fpu_to_mmx();
}
pub unsafe fn psrlw_r128(r: i32, shift: u64) {
    // psrlw xmm, {shift}
    let destination = read_xmm128s(r);
    let mut dword0: i32 = 0;
    let mut dword1: i32 = 0;
    let mut dword2: i32 = 0;
    let mut dword3: i32 = 0;
    if shift <= 15 {
        dword0 = destination.u16_0[0] as i32 >> shift | destination.u16_0[1] as i32 >> shift << 16;
        dword1 = destination.u16_0[2] as i32 >> shift | destination.u16_0[3] as i32 >> shift << 16;
        dword2 = destination.u16_0[4] as i32 >> shift | destination.u16_0[5] as i32 >> shift << 16;
        dword3 = destination.u16_0[6] as i32 >> shift | destination.u16_0[7] as i32 >> shift << 16
    }
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
pub unsafe fn psraw_r128(r: i32, shift: u64) {
    // psraw xmm, {shift}
    let destination = read_xmm128s(r);
    let shift_clamped = (if shift > 15 { 16 } else { shift as u32 }) as i32;
    let dword0 = destination.i16_0[0] as i32 >> shift_clamped & 0xFFFF
        | destination.i16_0[1] as i32 >> shift_clamped << 16;
    let dword1 = destination.i16_0[2] as i32 >> shift_clamped & 0xFFFF
        | destination.i16_0[3] as i32 >> shift_clamped << 16;
    let dword2 = destination.i16_0[4] as i32 >> shift_clamped & 0xFFFF
        | destination.i16_0[5] as i32 >> shift_clamped << 16;
    let dword3 = destination.i16_0[6] as i32 >> shift_clamped & 0xFFFF
        | destination.i16_0[7] as i32 >> shift_clamped << 16;
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
pub unsafe fn psllw_r128(r: i32, shift: u64) {
    // psllw xmm, {shift}
    let destination = read_xmm128s(r);
    let mut dword0: i32 = 0;
    let mut dword1: i32 = 0;
    let mut dword2: i32 = 0;
    let mut dword3: i32 = 0;
    if shift <= 15 {
        dword0 = (destination.u16_0[0] as i32) << shift & 0xFFFF
            | (destination.u16_0[1] as i32) << shift << 16;
        dword1 = (destination.u16_0[2] as i32) << shift & 0xFFFF
            | (destination.u16_0[3] as i32) << shift << 16;
        dword2 = (destination.u16_0[4] as i32) << shift & 0xFFFF
            | (destination.u16_0[5] as i32) << shift << 16;
        dword3 = (destination.u16_0[6] as i32) << shift & 0xFFFF
            | (destination.u16_0[7] as i32) << shift << 16
    }
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
pub unsafe fn psrld_r128(r: i32, shift: u64) {
    // psrld xmm, {shift}
    let destination = read_xmm128s(r);
    let mut dword0: i32 = 0;
    let mut dword1: i32 = 0;
    let mut dword2: i32 = 0;
    let mut dword3: i32 = 0;
    if shift <= 31 {
        dword0 = (destination.u32_0[0] >> shift) as i32;
        dword1 = (destination.u32_0[1] >> shift) as i32;
        dword2 = (destination.u32_0[2] >> shift) as i32;
        dword3 = (destination.u32_0[3] >> shift) as i32
    }
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
pub unsafe fn psrad_r128(r: i32, shift: u64) {
    // psrad xmm, {shift}
    let destination = read_xmm128s(r);
    let shift_clamped = (if shift > 31 { 31 } else { shift }) as i32;
    let dword0 = destination.i32_0[0] >> shift_clamped;
    let dword1 = destination.i32_0[1] >> shift_clamped;
    let dword2 = destination.i32_0[2] >> shift_clamped;
    let dword3 = destination.i32_0[3] >> shift_clamped;
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
pub unsafe fn pslld_r128(r: i32, shift: u64) {
    // pslld xmm, {shift}
    let destination = read_xmm128s(r);
    let mut dword0: i32 = 0;
    let mut dword1: i32 = 0;
    let mut dword2: i32 = 0;
    let mut dword3: i32 = 0;
    if shift <= 31 {
        dword0 = destination.i32_0[0] << shift;
        dword1 = destination.i32_0[1] << shift;
        dword2 = destination.i32_0[2] << shift;
        dword3 = destination.i32_0[3] << shift
    }
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
pub unsafe fn psrlq_r128(r: i32, shift: u64) {
    // psrlq xmm, {shift}
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8_0: [0; 16] };
    if shift <= 63 {
        result.u64_0[0] = destination.u64_0[0] >> shift;
        result.u64_0[1] = destination.u64_0[1] >> shift
    }
    write_xmm_reg128(r, result);
}
pub unsafe fn psllq_r128(r: i32, shift: u64) {
    // psllq xmm, {shift}
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8_0: [0; 16] };
    if shift <= 63 {
        result.u64_0[0] = destination.u64_0[0] << shift;
        result.u64_0[1] = destination.u64_0[1] << shift
    }
    write_xmm_reg128(r, result);
}

pub unsafe fn sse_comparison(op: i32, x: f64, y: f64) -> bool {
    // TODO: Signaling
    match op & 7 {
        0 => return x == y,
        1 => return x < y,
        2 => return x <= y,
        3 => return x.is_nan() || y.is_nan(),
        4 => return x != y || x.is_nan() || y.is_nan(),
        5 => return x >= y || x.is_nan() || y.is_nan(),
        6 => return x > y || x.is_nan() || y.is_nan(),
        7 => return !x.is_nan() && !y.is_nan(),
        _ => {
            dbg_assert!(false);
            return false;
        },
    };
}
pub unsafe fn sse_min(x: f64, y: f64) -> f64 {
    // if both x and y are 0 or x is nan, y is returned
    return if x < y { x } else { y };
}
pub unsafe fn sse_max(x: f64, y: f64) -> f64 {
    // if both x and y are 0 or x is nan, y is returned
    return if x > y { x } else { y };
}

#[no_mangle]
pub unsafe fn sse_convert_with_truncation_f32_to_i32(x: f32) -> i32 {
    let x = x.trunc();
    if x >= -2147483648.0 && x < 2147483648.0 {
        return x as i64 as i32;
    }
    else {
        // TODO: Signal
        return -0x80000000;
    };
}
#[no_mangle]
pub unsafe fn sse_convert_f32_to_i32(x: f32) -> i32 {
    let x = sse_integer_round(x as f64);
    if x >= -2147483648.0 && x < 2147483648.0 {
        return x as i64 as i32;
    }
    else {
        // TODO: Signal
        return -0x80000000;
    };
}

#[no_mangle]
pub unsafe fn sse_convert_with_truncation_f64_to_i32(x: f64) -> i32 {
    let x = x.trunc();
    if x >= -2147483648.0 && x < 2147483648.0 {
        return x as i64 as i32;
    }
    else {
        // TODO: Signal
        return -0x80000000;
    };
}
#[no_mangle]
pub unsafe fn sse_convert_f64_to_i32(x: f64) -> i32 {
    let x = sse_integer_round(x);
    if x >= -2147483648.0 && x < 2147483648.0 {
        return x as i64 as i32;
    }
    else {
        // TODO: Signal
        return -0x80000000;
    };
}

pub unsafe fn sse_integer_round(f: f64) -> f64 {
    // see fpu_integer_round
    let rc = *mxcsr >> MXCSR_RC_SHIFT & 3;
    if rc == 0 {
        // Round to nearest, or even if equidistant
        let mut rounded = f.round();
        let diff = rounded - f;
        if diff == 0.5 || diff == -0.5 {
            rounded = 2.0 * (f * 0.5).round()
        }
        return rounded;
    }
    else if rc == 1 || rc == 3 && f > 0.0 {
        // rc=3 is truncate -> floor for positive numbers
        return f.floor();
    }
    else {
        return f.ceil();
    };
}
