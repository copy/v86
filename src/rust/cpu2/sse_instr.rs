#![allow(
    dead_code,
    mutable_transmutes,
    non_camel_case_types,
    non_snake_case,
    non_upper_case_globals,
    unused_mut
)]

use cpu2::cpu::*;

#[no_mangle]
pub unsafe fn mov_r_m64(mut addr: i32, mut r: i32) -> () {
    c_comment!(("mov* m64, mm"));
    let mut data: reg64 = read_mmx64s(r);
    return_on_pagefault!(safe_write64(addr, data.u64_0[0usize] as i64));
}
#[no_mangle]
pub unsafe fn movl_r128_m64(mut addr: i32, mut r: i32) -> () {
    c_comment!(("mov* m64, xmm"));
    let mut data: reg64 = read_xmm64s(r);
    return_on_pagefault!(safe_write64(addr, data.u64_0[0usize] as i64));
}
#[no_mangle]
pub unsafe fn mov_r_r128(mut r1: i32, mut r2: i32) -> () {
    c_comment!(("mov* xmm, xmm"));
    let mut data: reg128 = read_xmm128s(r2);
    write_xmm_reg128(r1, data);
}
#[no_mangle]
pub unsafe fn mov_r_m128(mut addr: i32, mut r: i32) -> () {
    c_comment!(("mov* m128, xmm"));
    let mut data: reg128 = read_xmm128s(r);
    return_on_pagefault!(safe_write128(addr, data));
}
#[no_mangle]
pub unsafe fn mov_rm_r128(mut source: reg128, mut r: i32) -> () {
    c_comment!(("mov* xmm, xmm/m128"));
    write_xmm_reg128(r, source);
}
#[no_mangle]
pub unsafe fn movh_m64_r128(mut addr: i32, mut r: i32) -> () {
    c_comment!(("movhp* xmm, m64"));
    let mut data: reg64 = return_on_pagefault!(safe_read64s(addr));
    let mut orig: reg128 = read_xmm128s(r);
    write_xmm128(
        r,
        orig.u32_0[0usize] as i32,
        orig.u32_0[1usize] as i32,
        data.u32_0[0usize] as i32,
        data.u32_0[1usize] as i32,
    );
}
#[no_mangle]
pub unsafe fn movh_r128_m64(mut addr: i32, mut r: i32) -> () {
    c_comment!(("movhp* m64, xmm"));
    let mut data: reg128 = read_xmm128s(r);
    return_on_pagefault!(safe_write64(addr, data.u64_0[1usize] as i64));
}
#[no_mangle]
pub unsafe fn pand_r128(mut source: reg128, mut r: i32) -> () {
    c_comment!(("pand xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 {
        i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    };
    result.u64_0[0usize] = source.u64_0[0usize] & destination.u64_0[0usize];
    result.u64_0[1usize] = source.u64_0[1usize] & destination.u64_0[1usize];
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn pandn_r128(mut source: reg128, mut r: i32) -> () {
    c_comment!(("pandn xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 {
        i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    };
    result.u64_0[0usize] = source.u64_0[0usize] & !destination.u64_0[0usize];
    result.u64_0[1usize] = source.u64_0[1usize] & !destination.u64_0[1usize];
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn pxor_r128(mut source: reg128, mut r: i32) -> () {
    c_comment!(("pxor xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 {
        i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    };
    result.u64_0[0usize] = source.u64_0[0usize] ^ destination.u64_0[0usize];
    result.u64_0[1usize] = source.u64_0[1usize] ^ destination.u64_0[1usize];
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn por_r128(mut source: reg128, mut r: i32) -> () {
    c_comment!(("por xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 {
        i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    };
    result.u64_0[0usize] = source.u64_0[0usize] | destination.u64_0[0usize];
    result.u64_0[1usize] = source.u64_0[1usize] | destination.u64_0[1usize];
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn psrlw_r64(mut r: i32, mut shift: u32) -> () {
    c_comment!(("psrlw mm, {shift}"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut dword0: i32 = 0i32;
    let mut dword1: i32 = 0i32;
    if shift <= 15i32 as u32 {
        dword0 = destination.u16_0[0usize] as i32 >> shift
            | destination.u16_0[1usize] as i32 >> shift << 16i32;
        dword1 = destination.u16_0[2usize] as i32 >> shift
            | destination.u16_0[3usize] as i32 >> shift << 16i32
    }
    write_mmx64(r, dword0, dword1);
}
#[no_mangle]
pub unsafe fn psraw_r64(mut r: i32, mut shift: u32) -> () {
    c_comment!(("psraw mm, {shift}"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut shift_clamped: i32 = (if shift > 15i32 as u32 {
        16i32 as u32
    }
    else {
        shift
    }) as i32;
    let mut dword0: i32 = destination.i16_0[0usize] as i32 >> shift_clamped & 65535i32
        | destination.i16_0[1usize] as i32 >> shift_clamped << 16i32;
    let mut dword1: i32 = destination.i16_0[2usize] as i32 >> shift_clamped & 65535i32
        | destination.i16_0[3usize] as i32 >> shift_clamped << 16i32;
    write_mmx64(r, dword0, dword1);
}
#[no_mangle]
pub unsafe fn psllw_r64(mut r: i32, mut shift: u32) -> () {
    c_comment!(("psllw mm, {shift}"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut dword0: i32 = 0i32;
    let mut dword1: i32 = 0i32;
    if shift <= 15i32 as u32 {
        dword0 = (destination.u16_0[0usize] as i32) << shift & 65535i32
            | (destination.u16_0[1usize] as i32) << shift << 16i32;
        dword1 = (destination.u16_0[2usize] as i32) << shift & 65535i32
            | (destination.u16_0[3usize] as i32) << shift << 16i32
    }
    write_mmx64(r, dword0, dword1);
}
#[no_mangle]
pub unsafe fn psrld_r64(mut r: i32, mut shift: u32) -> () {
    c_comment!(("psrld mm, {shift}"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut dword0: i32 = 0i32;
    let mut dword1: i32 = 0i32;
    if shift <= 31i32 as u32 {
        dword0 = (destination.u32_0[0usize] >> shift) as i32;
        dword1 = (destination.u32_0[1usize] >> shift) as i32
    }
    write_mmx64(r, dword0, dword1);
}
#[no_mangle]
pub unsafe fn psrad_r64(mut r: i32, mut shift: u32) -> () {
    c_comment!(("psrad mm, {shift}"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut shift_clamped: i32 = (if shift > 31i32 as u32 {
        31i32 as u32
    }
    else {
        shift
    }) as i32;
    let mut dword0: i32 = destination.i32_0[0usize] >> shift_clamped;
    let mut dword1: i32 = destination.i32_0[1usize] >> shift_clamped;
    write_mmx64(r, dword0, dword1);
}
#[no_mangle]
pub unsafe fn pslld_r64(mut r: i32, mut shift: u32) -> () {
    c_comment!(("pslld mm, {shift}"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut dword0: i32 = 0i32;
    let mut dword1: i32 = 0i32;
    if shift <= 31i32 as u32 {
        dword0 = destination.i32_0[0usize] << shift;
        dword1 = destination.i32_0[1usize] << shift
    }
    write_mmx64(r, dword0, dword1);
}
#[no_mangle]
pub unsafe fn psrlq_r64(mut r: i32, mut shift: u32) -> () {
    c_comment!(("psrlq mm, {shift}"));
    if shift == 0i32 as u32 {
        return;
    }
    else {
        let mut destination: reg64 = read_mmx64s(r);
        let mut result: reg64 = reg64 {
            i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0],
        };
        if shift <= 63i32 as u32 {
            result.u64_0[0usize] = destination.u64_0[0usize] >> shift
        }
        write_mmx_reg64(r, result);
        return;
    };
}
#[no_mangle]
pub unsafe fn psllq_r64(mut r: i32, mut shift: u32) -> () {
    c_comment!(("psllq mm, {shift}"));
    let mut destination: reg64 = read_mmx64s(r);
    if shift == 0i32 as u32 {
        return;
    }
    else {
        let mut result: reg64 = reg64 {
            i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0],
        };
        if shift <= 63i32 as u32 {
            result.u64_0[0usize] = destination.u64_0[0usize] << shift
        }
        write_mmx_reg64(r, result);
        return;
    };
}
#[no_mangle]
pub unsafe fn psrlw_r128(mut r: i32, mut shift: u32) -> () {
    c_comment!(("psrlw xmm, {shift}"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut dword0: i32 = 0i32;
    let mut dword1: i32 = 0i32;
    let mut dword2: i32 = 0i32;
    let mut dword3: i32 = 0i32;
    if shift <= 15i32 as u32 {
        dword0 = destination.u16_0[0usize] as i32 >> shift
            | destination.u16_0[1usize] as i32 >> shift << 16i32;
        dword1 = destination.u16_0[2usize] as i32 >> shift
            | destination.u16_0[3usize] as i32 >> shift << 16i32;
        dword2 = destination.u16_0[4usize] as i32 >> shift
            | destination.u16_0[5usize] as i32 >> shift << 16i32;
        dword3 = destination.u16_0[6usize] as i32 >> shift
            | destination.u16_0[7usize] as i32 >> shift << 16i32
    }
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
#[no_mangle]
pub unsafe fn psraw_r128(mut r: i32, mut shift: u32) -> () {
    c_comment!(("psraw xmm, {shift}"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut shift_clamped: i32 = (if shift > 15i32 as u32 {
        16i32 as u32
    }
    else {
        shift
    }) as i32;
    let mut dword0: i32 = destination.i16_0[0usize] as i32 >> shift_clamped & 65535i32
        | destination.i16_0[1usize] as i32 >> shift_clamped << 16i32;
    let mut dword1: i32 = destination.i16_0[2usize] as i32 >> shift_clamped & 65535i32
        | destination.i16_0[3usize] as i32 >> shift_clamped << 16i32;
    let mut dword2: i32 = destination.i16_0[4usize] as i32 >> shift_clamped & 65535i32
        | destination.i16_0[5usize] as i32 >> shift_clamped << 16i32;
    let mut dword3: i32 = destination.i16_0[6usize] as i32 >> shift_clamped & 65535i32
        | destination.i16_0[7usize] as i32 >> shift_clamped << 16i32;
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
#[no_mangle]
pub unsafe fn psllw_r128(mut r: i32, mut shift: u32) -> () {
    c_comment!(("psllw xmm, {shift}"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut dword0: i32 = 0i32;
    let mut dword1: i32 = 0i32;
    let mut dword2: i32 = 0i32;
    let mut dword3: i32 = 0i32;
    if shift <= 15i32 as u32 {
        dword0 = (destination.u16_0[0usize] as i32) << shift & 65535i32
            | (destination.u16_0[1usize] as i32) << shift << 16i32;
        dword1 = (destination.u16_0[2usize] as i32) << shift & 65535i32
            | (destination.u16_0[3usize] as i32) << shift << 16i32;
        dword2 = (destination.u16_0[4usize] as i32) << shift & 65535i32
            | (destination.u16_0[5usize] as i32) << shift << 16i32;
        dword3 = (destination.u16_0[6usize] as i32) << shift & 65535i32
            | (destination.u16_0[7usize] as i32) << shift << 16i32
    }
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
#[no_mangle]
pub unsafe fn psrld_r128(mut r: i32, mut shift: u32) -> () {
    c_comment!(("psrld xmm, {shift}"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut dword0: i32 = 0i32;
    let mut dword1: i32 = 0i32;
    let mut dword2: i32 = 0i32;
    let mut dword3: i32 = 0i32;
    if shift <= 31i32 as u32 {
        dword0 = (destination.u32_0[0usize] >> shift) as i32;
        dword1 = (destination.u32_0[1usize] >> shift) as i32;
        dword2 = (destination.u32_0[2usize] >> shift) as i32;
        dword3 = (destination.u32_0[3usize] >> shift) as i32
    }
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
#[no_mangle]
pub unsafe fn psrad_r128(mut r: i32, mut shift: u32) -> () {
    c_comment!(("psrad xmm, {shift}"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut shift_clamped: i32 = (if shift > 31i32 as u32 {
        31i32 as u32
    }
    else {
        shift
    }) as i32;
    let mut dword0: i32 = destination.i32_0[0usize] >> shift_clamped;
    let mut dword1: i32 = destination.i32_0[1usize] >> shift_clamped;
    let mut dword2: i32 = destination.i32_0[2usize] >> shift_clamped;
    let mut dword3: i32 = destination.i32_0[3usize] >> shift_clamped;
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
#[no_mangle]
pub unsafe fn pslld_r128(mut r: i32, mut shift: u32) -> () {
    c_comment!(("pslld xmm, {shift}"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut dword0: i32 = 0i32;
    let mut dword1: i32 = 0i32;
    let mut dword2: i32 = 0i32;
    let mut dword3: i32 = 0i32;
    if shift <= 31i32 as u32 {
        dword0 = destination.i32_0[0usize] << shift;
        dword1 = destination.i32_0[1usize] << shift;
        dword2 = destination.i32_0[2usize] << shift;
        dword3 = destination.i32_0[3usize] << shift
    }
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
#[no_mangle]
pub unsafe fn psrlq_r128(mut r: i32, mut shift: u32) -> () {
    c_comment!(("psrlq xmm, {shift}"));
    if shift == 0i32 as u32 {
        return;
    }
    else {
        let mut destination: reg128 = read_xmm128s(r);
        let mut result: reg128 = reg128 {
            i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        };
        if shift <= 63i32 as u32 {
            result.u64_0[0usize] = destination.u64_0[0usize] >> shift;
            result.u64_0[1usize] = destination.u64_0[1usize] >> shift
        }
        write_xmm_reg128(r, result);
        return;
    };
}
#[no_mangle]
pub unsafe fn psllq_r128(mut r: i32, mut shift: u32) -> () {
    c_comment!(("psllq xmm, {shift}"));
    let mut destination: reg128 = read_xmm128s(r);
    if shift == 0i32 as u32 {
        return;
    }
    else {
        let mut result: reg128 = reg128 {
            i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        };
        if shift <= 63i32 as u32 {
            result.u64_0[0usize] = destination.u64_0[0usize] << shift;
            result.u64_0[1usize] = destination.u64_0[1usize] << shift
        }
        write_xmm_reg128(r, result);
        return;
    };
}
#[no_mangle]
pub unsafe fn sse_comparison(mut op: i32, mut x: f64, mut y: f64) -> bool {
    c_comment!(("TODO: Signaling"));
    match op & 7i32 {
        0 => return x == y,
        1 => return x < y,
        2 => return x <= y,
        3 => return 0 != x.is_nan() as i32 || 0 != y.is_nan() as i32,
        4 => return x != y || 0 != x.is_nan() as i32 || 0 != y.is_nan() as i32,
        5 => return x >= y || 0 != x.is_nan() as i32 || 0 != y.is_nan() as i32,
        6 => return x > y || 0 != x.is_nan() as i32 || 0 != y.is_nan() as i32,
        7 => return !x.is_nan() && !y.is_nan(),
        _ => {
            dbg_assert!(0 != 0i32);
            return 0 != 0i32;
        },
    };
}
#[no_mangle]
pub unsafe fn sse_min(mut x: f64, mut y: f64) -> f64 {
    c_comment!(("if both x and y are 0 or x is nan, y is returned"));
    return if x < y { x } else { y };
}
#[no_mangle]
pub unsafe fn sse_max(mut x: f64, mut y: f64) -> f64 {
    c_comment!(("if both x and y are 0 or x is nan, y is returned"));
    return if x > y { x } else { y };
}
#[no_mangle]
pub unsafe fn sse_convert_f64_to_i32(mut x: f64) -> i32 {
    c_comment!(("TODO: Rounding modes"));
    if x >= 2147483648u32.wrapping_neg() as f64 && x < 2147483648u32 as f64 {
        return x as i64 as i32;
    }
    else {
        c_comment!(("TODO: Signal"));
        return 2147483648u32.wrapping_neg() as i32;
    };
}
