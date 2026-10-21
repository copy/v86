#![allow(dead_code)]
#[path = "../../src/rust/profiler.rs"]
mod profiler;
include!("../../src/rust/softfloat.rs");

static mut FAILURE: [u64; 10] = [0; 10];
static mut HITS: [u32; 4] = [0; 4];

#[no_mangle]
pub unsafe fn fast_math_result(op: u32, a: u64, b: u64, precision: u8, rounding: u8) -> u64 {
    extF80_roundingPrecision = precision;
    softfloat_roundingMode = rounding;
    accelerated(op, F80::of_f64(a), F80::of_f64(b)).to_f64()
}

// Bounded Mandelbrot-style recurrence through the production F80 operators.
// Inputs/results stay in binary64 range; PC=53, nearest-even, so both policies
// must produce identical checksums. This is not the EVEREST benchmark.
#[no_mangle]
pub unsafe fn benchmark_fast_math(fast: bool, points: u32) -> u64 {
    set_x87_fast_math(fast);
    extF80_roundingPrecision = 64;
    softfloat_roundingMode = 0;
    let mut sum = 0u64;
    for i in 0..points {
        let cx = F80::of_f64x(std::hint::black_box(-0.2 + (i % 101) as f64 * 0.0001));
        let cy = F80::of_f64x(0.65);
        let mut x = F80::of_f64x(0.1);
        let mut y = F80::of_f64x(0.1);
        for _ in 0..32 {
            let next_x = x * x - y * y + cx;
            y = (x + x) * y + cy;
            x = next_x;
        }
        sum = sum.wrapping_add(x.mantissa ^ y.mantissa);
    }
    sum
}

#[inline(always)]
unsafe fn reference(op: u32, a: F80, b: F80) -> F80 {
    let mut out = F80::ZERO;
    match op {
        0 => extF80M_add(&a, &b, &mut out),
        1 => extF80M_sub(&a, &b, &mut out),
        2 => extF80M_mul(&a, &b, &mut out),
        _ => extF80M_div(&a, &b, &mut out),
    }
    out
}
#[inline(always)]
fn accelerated(op: u32, a: F80, b: F80) -> F80 {
    match op { 0 => a + b, 1 => a - b, 2 => a * b, _ => a / b }
}
fn candidate(op: u32, a: F80, b: F80) -> Option<F80> {
    match op { 0 => a.exact_add(b), 1 => a.exact_add(-b), 2 => a.exact_mul(b), 3 => a.exact_div(b), _ => None }
}
unsafe fn check(op: u32, a: F80, b: F80, flags: u8) -> bool {
    softfloat_exceptionFlags = flags;
    let expected = reference(op, a, b);
    let expected_flags = softfloat_exceptionFlags;
    softfloat_exceptionFlags = flags;
    let actual = accelerated(op, a, b);
    let actual_flags = softfloat_exceptionFlags;
    if expected.mantissa != actual.mantissa || expected.sign_exponent != actual.sign_exponent ||
        expected_flags != actual_flags {
        FAILURE = [op as u64, a.mantissa, a.sign_exponent as u64, b.mantissa, b.sign_exponent as u64,
            expected.mantissa, expected.sign_exponent as u64, actual.mantissa, actual.sign_exponent as u64,
            (expected_flags as u64) << 8 | actual_flags as u64];
        return false;
    }
    if candidate(op, a, b).is_some() { HITS[op as usize] += 1; }
    true
}
unsafe fn reference_cmp(a: &F80, b: &F80, quiet: bool) -> Option<std::cmp::Ordering> {
    use std::cmp::Ordering;
    if if quiet { extF80M_lt_quiet(a, b) } else { extF80M_lt(a, b) } { Some(Ordering::Less) }
    else if if quiet { extF80M_lt_quiet(b, a) } else { extF80M_lt(b, a) } { Some(Ordering::Greater) }
    else if extF80M_eq(a, b) { Some(Ordering::Equal) }
    else { None }
}
unsafe fn check_cmp(a: F80, b: F80, flags: u8) -> bool {
    for quiet in [false, true] {
        softfloat_exceptionFlags = flags;
        let expected = reference_cmp(&a, &b, quiet);
        let expected_flags = softfloat_exceptionFlags;
        softfloat_exceptionFlags = flags;
        let actual = if quiet { a.partial_cmp_quiet(&b) } else { a.partial_cmp(&b) };
        if expected != actual || expected_flags != softfloat_exceptionFlags {
            FAILURE = [4 + quiet as u64, a.mantissa, a.sign_exponent as u64,
                b.mantissa, b.sign_exponent as u64, expected_flags as u64,
                softfloat_exceptionFlags as u64, 0, 0, 0];
            return false;
        }
    }
    true
}
fn next(seed: &mut u64) -> u64 {
    *seed ^= *seed << 13;
    *seed ^= *seed >> 7;
    *seed ^= *seed << 17;
    *seed
}

#[no_mangle]
pub unsafe fn verify(precision: u8, rounding: u8, count: u32) -> u32 {
    extF80_roundingPrecision = precision;
    softfloat_roundingMode = rounding;
    HITS = [0; 4];
    let mantissas = [0, 1, 0x7FFFFFFFFFFFFFFF, 0x8000000000000000,
        0x8000000000000001, 0x8000000000000800, 0x8000010000000000,
        0x8000000100000000, 0xC000000000000000, 0xFFFFFFFFFFFFFFFF,
        0xFFFFFFFFFFFFF800, 0xFFFFFF0000000000, 0xFFFFFFFF00000000];
    let exponents = [0, 1, 2, 0x3FFE, 0x3FFF, 0x4000, 0x7FFD, 0x7FFE, 0x7FFF];
    let mut index = 0;
    // Cross boundary encodings, including pseudo-denormals, unnormals and NaNs.
    for &am in &mantissas { for &bm in &mantissas {
        for &ae in &exponents { for &be in &exponents { for signs in 0..4 {
            let a = F80 { mantissa: am, sign_exponent: ae | (signs & 1) << 15 };
            let b = F80 { mantissa: bm, sign_exponent: be | (signs >> 1) << 15 };
            if !check_cmp(a, b, if index & 1 == 0 { 0 } else { 0x1F }) { return index + 1; }
            for op in 0..4 {
                index += 1;
                if !check(op, a, b, if index & 1 == 0 { 0 } else { 0x1F }) { return index; }
            }
        } } }
    } }
    let mut native_seed = 0x2345ABCD12345678;
    for i in 0..100000 {
        let mask = if i & 1 == 0 { !0x7FF } else { !0xFFFFFFFFFF };
        let a = F80 { mantissa: (next(&mut native_seed) | 1 << 63) & mask,
            sign_exponent: 0x3FFF + (i % 100) as u16 | ((i & 1) as u16) << 15 };
        let b = F80 { mantissa: (next(&mut native_seed) | 1 << 63) & mask,
            sign_exponent: 0x3FFF + (i % 7) as u16 | ((i & 2) as u16) << 14 };
        for op in 0..4 { index += 1; if !check(op, a, b, (i & 31) as u8) { return index; } }
    }
    // Native reduced-precision division, including inexact ratios, signs,
    // overflow/underflow boundaries and exponent normalization on either side.
    for exponent in [0x3C01,0x3F81,0x3FFE,0x3FFF,0x4000,0x407E,0x43FE] {
        for a in 1..96u64 { for b in 1..96u64 { for signs in 0..4 {
            let x = F80 { mantissa: 0x8000000000000000 | a << 40,
                sign_exponent: exponent | (signs & 1) << 15 };
            let y = F80 { mantissa: 0x8000000000000000 | b << 40,
                sign_exponent: 0x3FFF | (signs >> 1) << 15 };
            index += 1;
            for op in 0..4 { if !check(op, x, y, (index & 31) as u8) { return index; } }
        } } }
    }
    let mut seed = 0xA0B1C2D312345678;
    for i in 0..count {
        let mask = match i % 4 { 0 => !0, 1 => !0x7FF, 2 => !0xFFFFFFFF, _ => !0xFFFFFFFFFF };
        let ae = next(&mut seed) as u16;
        let be = if i & 1 == 0 { ae.wrapping_add((i % 70) as u16) } else { next(&mut seed) as u16 };
        let a = F80 { mantissa: (next(&mut seed) | 1 << 63) & mask, sign_exponent: ae };
        let b = F80 { mantissa: if i % 7 == 0 { 1 << 63 } else { (next(&mut seed) | 1 << 63) & mask },
            sign_exponent: be };
        if !check_cmp(a, b, if i & 1 == 0 { 0 } else { 0x1F }) { return index + 1; }
        for op in 0..4 {
            index += 1;
            if !check(op, a, b, if i & 1 == 0 { 0 } else { 0x1F }) { return index; }
        }
    }
    0
}
#[no_mangle]
pub unsafe fn failure_word(index: usize) -> u64 { FAILURE[index] }
#[no_mangle]
pub unsafe fn hits(op: usize) -> u32 { HITS[op] }

#[no_mangle]
pub unsafe fn benchmark(op: u32, fast: bool, fallback: bool, count: u32) -> u64 {
    match (op, fast) {
        (0, false) => bench::<0, false>(fallback, count),
        (0, true) => bench::<0, true>(fallback, count),
        (1, false) => bench::<1, false>(fallback, count),
        (1, true) => bench::<1, true>(fallback, count),
        (2, false) => bench::<2, false>(fallback, count),
        (2, true) => bench::<2, true>(fallback, count),
        (3, false) => bench::<3, false>(fallback, count),
        _ => bench::<3, true>(fallback, count),
    }
}
unsafe fn bench<const OP: u32, const FAST: bool>(fallback: bool, count: u32) -> u64 {
    extF80_roundingPrecision = 80;
    softfloat_roundingMode = 0;
    let mut checksum = 0u64;
    for i in 0..count {
        let a = F80 { mantissa: 0x8000000000000000 | (i as u64 & 0x7FFFFF) << 40 |
            if fallback { 1 } else { 0 }, sign_exponent: 0x4000 };
        let b = F80 { mantissa: if OP == 3 && !fallback { 0x8000000000000000 }
            else { 0x9000000000000000 | if fallback { 1 } else { 0 } }, sign_exponent: 0x3FFF };
        softfloat_exceptionFlags = 0;
        let a = std::hint::black_box(a);
        let b = std::hint::black_box(b);
        let result = if FAST { accelerated(OP, a, b) } else { reference(OP, a, b) };
        checksum = checksum.wrapping_add(result.mantissa ^ result.sign_exponent as u64 ^ softfloat_exceptionFlags as u64);
    }
    checksum
}

#[no_mangle]
pub unsafe fn benchmark_compare(fast: bool, fallback: bool, count: u32) -> u64 {
    let mut sum = 0u64;
    for i in 0..count {
        let a = std::hint::black_box(F80 { mantissa: 0x8000000000000000 | i as u64,
            sign_exponent: if fallback { 0x7FFF } else { 0x3FFF } });
        let b = std::hint::black_box(F80 { mantissa: 0x8000000000000000 | (i ^ 1) as u64,
            sign_exponent: if fallback { 0x7FFF } else { 0x3FFF } });
        softfloat_exceptionFlags = 0;
        let result = if fast { a.partial_cmp_quiet(&b) } else { reference_cmp(&a, &b, true) };
        sum = sum.wrapping_add(match result { Some(std::cmp::Ordering::Less) => 1,
            Some(std::cmp::Ordering::Equal) => 2, Some(std::cmp::Ordering::Greater) => 3, None => 4 });
        sum = sum.wrapping_add(softfloat_exceptionFlags as u64);
    }
    sum
}

// Compare the conversion entry points against the linked, unchanged SoftFloat.
unsafe fn check_conversion(bits: u32, raw: F80, flags: u8) -> bool {
    softfloat_exceptionFlags = flags;
    let mut expected = F80::ZERO;
    f32_to_extF80M(bits as i32, &mut expected);
    let expected_flags = softfloat_exceptionFlags;
    softfloat_exceptionFlags = flags;
    let actual = F80::of_f32(bits as i32);
    if actual.mantissa != expected.mantissa || actual.sign_exponent != expected.sign_exponent ||
        softfloat_exceptionFlags != expected_flags {
        FAILURE = [10, bits as u64, expected.mantissa, expected.sign_exponent as u64,
            actual.mantissa, actual.sign_exponent as u64, expected_flags as u64,
            softfloat_exceptionFlags as u64, 0, 0];
        return false;
    }
    for value in [raw, expected] {
        softfloat_exceptionFlags = flags;
        let expected = extF80M_to_f32(&value);
        let expected_flags = softfloat_exceptionFlags;
        softfloat_exceptionFlags = flags;
        let actual = value.to_f32();
        if actual != expected || softfloat_exceptionFlags != expected_flags {
            FAILURE = [11, value.mantissa, value.sign_exponent as u64,
                expected as u32 as u64, actual as u32 as u64,
                expected_flags as u64, softfloat_exceptionFlags as u64, 0, 0, 0];
            return false;
        }
    }
    true
}
#[no_mangle]
pub unsafe fn verify_conversions(precision: u8, rounding: u8, count: u32) -> u32 {
    extF80_roundingPrecision = precision;
    softfloat_roundingMode = rounding;
    let mut index = 0;
    let exponents = [0, 1, 0x3F68, 0x3F69, 0x3F6A, 0x3F7F, 0x3F80, 0x3F81,
        0x3FFF, 0x407D, 0x407E, 0x407F, 0x7FFE, 0x7FFF];
    // Halfway ties of both parities, rounding carry, noncanonical encodings,
    // binary32 normal/subnormal boundaries, NaN payloads and preexisting flags.
    let mantissas = [0, 1, 0x7FFFFFFFFFFFFFFF, 0x8000000000000000,
        0x8000000000000001, 0x8000007FFFFFFFFF, 0x8000008000000000,
        0x8000008000000001, 0x8000018000000000, 0xC000000000000000,
        0xFFFFFF7FFFFFFFFF, 0xFFFFFF8000000000, 0xFFFFFFFFFFFFFFFF];
    for exp in 0..256u32 { for frac in [0, 1, 0x3FFFFF, 0x400000, 0x7FFFFF] {
        for sign in [0, 0x80000000] { for exponent in exponents { for mantissa in mantissas {
            index += 1;
            if !check_conversion(sign | exp << 23 | frac,
                F80 { mantissa, sign_exponent: exponent | ((sign >> 16) as u16) },
                if index & 1 == 0 { 0 } else { 0x1F }) { return index; }
        } } }
    } }
    let mut seed = 0x0123ABCD87654321;
    for i in 0..count {
        let bits = next(&mut seed) as u32;
        let exponent = if i % 2 == 0 { 0x3F81 + (next(&mut seed) % 254) as u16 }
            else { next(&mut seed) as u16 };
        let mantissa = next(&mut seed) | if i % 2 == 0 { 1 << 63 } else { 0 };
        index += 1;
        if !check_conversion(bits, F80 { mantissa, sign_exponent: exponent }, (i & 31) as u8) {
            return index;
        }
    }
    0
}
#[no_mangle]
pub unsafe fn benchmark_conversion(op: u32, fast: bool, count: u32) -> u64 {
    let mut sum = 0u64;
    softfloat_roundingMode = 0;
    for i in 0..count {
        softfloat_exceptionFlags = 0;
        if op == 0 {
            let bits = std::hint::black_box(0x3F800000 | i & 0x7FFFFF);
            let mut value = F80::ZERO;
            if fast { value = F80::of_f32(bits as i32); }
            else { f32_to_extF80M(bits as i32, &mut value); }
            sum = sum.wrapping_add(value.mantissa ^ value.sign_exponent as u64);
        }
        else {
            let value = std::hint::black_box(F80 {
                mantissa: 0x8000000000000000 | (i as u64 & 0x7FFFFF) << 40 |
                    if op == 2 { 0x8000000001 } else { 0 }, sign_exponent: if op == 3 { 0x3F70 } else { 0x3FFF } });
            let bits = if fast { value.to_f32() } else { extF80M_to_f32(&value) };
            sum = sum.wrapping_add(bits as u32 as u64);
        }
        sum = sum.wrapping_add(softfloat_exceptionFlags as u64);
    }
    sum
}

unsafe fn check_wide_conversion(bits: u64, raw: F80, flags: u8) -> bool {
    for value in [raw, F80::of_f64(bits)] {
        softfloat_exceptionFlags = flags;
        let mut expected = F80::ZERO; extF80M_sqrt(&value, &mut expected);
        let expected_flags = softfloat_exceptionFlags;
        softfloat_exceptionFlags = flags;
        let actual = value.sqrt();
        if actual.mantissa != expected.mantissa || actual.sign_exponent != expected.sign_exponent || softfloat_exceptionFlags != expected_flags {
            FAILURE = [28, value.mantissa, value.sign_exponent as u64, expected.mantissa, actual.mantissa,
                expected.sign_exponent as u64, actual.sign_exponent as u64, expected_flags as u64, softfloat_exceptionFlags as u64, 0];
            return false;
        }
    }

    for truncate in [false, true] {
        let rounding = if truncate { 1 } else { softfloat_roundingMode };
        for wide in [false, true] {
            softfloat_exceptionFlags = flags;
            let expected = if wide { extF80M_to_i64(&raw, rounding, false) }
                else { extF80M_to_i32(&raw, rounding, false) as i64 };
            let expected_flags = softfloat_exceptionFlags;
            softfloat_exceptionFlags = flags;
            let actual = match (wide, truncate) { (true,true) => raw.truncate_to_i64(),
                (true,false) => raw.to_i64(), (false,true) => raw.truncate_to_i32() as i64,
                (false,false) => raw.to_i32() as i64 };
            if actual != expected || softfloat_exceptionFlags != expected_flags {
                FAILURE = [24 + wide as u64 + truncate as u64 * 2, raw.mantissa, raw.sign_exponent as u64,
                    expected as u64, actual as u64, expected_flags as u64, softfloat_exceptionFlags as u64, 0, 0, 0];
                return false;
            }
        }
    }

    for op in 0..3 {
        softfloat_exceptionFlags = flags;
        let mut expected = F80::ZERO;
        match op { 0 => f64_to_extF80M(bits, &mut expected),
            1 => i32_to_extF80M(bits as i32, &mut expected),
            _ => i64_to_extF80M(bits as i64, &mut expected) }
        let expected_flags = softfloat_exceptionFlags;
        softfloat_exceptionFlags = flags;
        let actual = match op { 0 => F80::of_f64(bits), 1 => F80::of_i32(bits as i32), _ => F80::of_i64(bits as i64) };
        if actual.mantissa != expected.mantissa || actual.sign_exponent != expected.sign_exponent || softfloat_exceptionFlags != expected_flags {
            FAILURE = [20 + op, bits, expected.mantissa, expected.sign_exponent as u64,
                actual.mantissa, actual.sign_exponent as u64, expected_flags as u64, softfloat_exceptionFlags as u64, 0, 0];
            return false;
        }
        for value in [raw, expected] {
            softfloat_exceptionFlags = flags;
            let expected = extF80M_to_f64(&value);
            let expected_flags = softfloat_exceptionFlags;
            softfloat_exceptionFlags = flags;
            let actual = value.to_f64();
            if actual != expected || softfloat_exceptionFlags != expected_flags {
                FAILURE = [23, value.mantissa, value.sign_exponent as u64, expected, actual,
                    expected_flags as u64, softfloat_exceptionFlags as u64, 0, 0, 0]; return false;
            }
        }
    }
    true
}
#[no_mangle]
pub unsafe fn verify_wide_conversions(precision: u8, rounding: u8, count: u32) -> u32 {
    extF80_roundingPrecision = precision;
    softfloat_roundingMode = rounding;
    let mut index = 0;
    for exponent in [0,1,0x3BFE,0x3BFF,0x3C00,0x3C01,0x3FFD,0x3FFE,0x3FFF,0x401D,0x401E,0x401F,0x403D,0x403E,0x403F,0x43FD,0x43FE,0x43FF,0x7FFE,0x7FFF] {
        for mantissa in [0,1,0x7FFFFFFFFFFFFFFF,0x8000000000000000,0x80000000000003FF,
            0x8000000000000400,0x8000000000000401,0x8000000000000C00,0xFFFFFFFFFFFFFFFF] {
            for sign in [0,0x8000] { for exp in 0..2048u64 { for frac in [0,1,0x8000000000000,0xFFFFFFFFFFFFF] {
                index += 1;
                if !check_wide_conversion((sign as u64) << 48 | exp << 52 | frac,
                    F80 { mantissa, sign_exponent: sign | exponent }, (index & 31) as u8) { return index; }
            } } }
        }
    }
    // Exact normal binary64 stores, including both ends of the exponent
    // range and the largest significand. Vary existing sticky flags too.
    for exponent in 1..0x7FFu64 {
        for fraction in [0, 1, 0x8000000000000, 0xFFFFFFFFFFFFF] {
            for sign in [0, 0x8000u16] {
                let bits = ((sign as u64) << 48) | (exponent << 52) | fraction;
                let raw = F80 { mantissa: (fraction | 0x10000000000000) << 11,
                    sign_exponent: sign | (exponent as u16 + 0x3C00) };
                index += 1;
                if !check_wide_conversion(bits, raw, (index & 31) as u8) { return index; }
            }
        }
    }
    let mut seed = 0x13579BDF02468ACE;
    for _ in 0..count {
        let bits = next(&mut seed);
        let raw = F80 { mantissa: next(&mut seed), sign_exponent: next(&mut seed) as u16 };
        index += 1;
        if !check_wide_conversion(bits, raw, (index & 31) as u8) { return index; }
    }
    0
}

#[no_mangle]
pub unsafe fn benchmark_native_binary(fast: bool, precision: u8, count: u32, op: u32) -> u64 {
    extF80_roundingPrecision = precision; softfloat_roundingMode = 0;
    let mut sum = 0u64;
    for i in 0..count {
        let a = std::hint::black_box(F80 { mantissa: 0x8000000000000000 | (i as u64 & 0x7FFFFF) << if precision == 32 { 40 } else { 11 },
            sign_exponent: 0x4000 });
        let b = std::hint::black_box(F80 { mantissa: 0xC000000000000000 | (i as u64 & 0x7FFFFF) << if precision == 32 { 40 } else { 11 },
            sign_exponent: 0x3FFF });
        softfloat_exceptionFlags = 0;
        let result = if fast { accelerated(op, a, b) } else { reference(op, a, b) };
        sum = sum.wrapping_add(result.mantissa ^ result.sign_exponent as u64 ^ softfloat_exceptionFlags as u64);
    }
    sum
}

#[no_mangle]
pub unsafe fn benchmark_native_sqrt(fast: bool, precision: u8, count: u32) -> u64 {
    extF80_roundingPrecision = precision; softfloat_roundingMode = 0;
    let mut sum = 0u64;
    for i in 0..count {
        let a = std::hint::black_box(F80 { mantissa: 0x8000000000000000 | (i as u64 & 0x7FFFFF) << 40,
            sign_exponent: 0x4000 });
        softfloat_exceptionFlags = 0;
        let result = if fast { a.sqrt() } else { let mut out = F80::ZERO; extF80M_sqrt(&a, &mut out); out };
        sum = sum.wrapping_add(result.mantissa ^ result.sign_exponent as u64 ^ softfloat_exceptionFlags as u64);
    }
    sum
}

#[no_mangle]
pub unsafe fn verify_integral(precision: u8, rounding: u8, count: u32) -> u32 {
    extF80_roundingPrecision = precision;
    softfloat_roundingMode = rounding;
    let mut seed = 0xF21C53123864ABu64;
    for i in 0..count {
        let exponent = if i % 3 == 0 { (next(&mut seed) as u16) & 0x7FFF }
            else { 0x3FBC + (next(&mut seed) % 140) as u16 };
        let mantissa = match i % 8 {
            0 => 0, 1 => 1, 2 => 1 << 63, 3 => u64::MAX, _ => next(&mut seed) | 1 << 63,
        };
        let value = F80 { mantissa, sign_exponent: exponent | ((i & 1) as u16) << 15 };
        for trunc in [false, true] {
            let flags = if i % 2 == 0 { 0 } else { 0x1F };
            softfloat_exceptionFlags = flags;
            let mut expected = F80::ZERO;
            extF80M_roundToInt(&value, if trunc { 1 } else { rounding }, false, &mut expected);
            let expected_flags = softfloat_exceptionFlags;
            softfloat_exceptionFlags = flags;
            let actual = if trunc { value.trunc() } else { value.round() };
            if actual.mantissa != expected.mantissa || actual.sign_exponent != expected.sign_exponent
                || softfloat_exceptionFlags != expected_flags {
                FAILURE = [20, mantissa, value.sign_exponent as u64, rounding as u64, trunc as u64,
                    expected.mantissa, expected.sign_exponent as u64, actual.mantissa,
                    actual.sign_exponent as u64, ((expected_flags as u64) << 8) | softfloat_exceptionFlags as u64];
                return i + 1;
            }
        }
    }
    0
}

#[no_mangle]
pub unsafe fn benchmark_integral(fast: bool, count: u32) -> u64 {
    softfloat_roundingMode = 0;
    extF80_roundingPrecision = 80;
    let mut checksum = 0u64;
    for i in 0..count {
        let value = std::hint::black_box(F80 { mantissa: 0xABCDEF1234567890u64.wrapping_add(i as u64),
            sign_exponent: 0x3FFE + (i & 63) as u16 });
        let result = if fast { value.round() } else {
            let mut result = F80::ZERO;
            extF80M_roundToInt(&value, 0, false, &mut result);
            result
        };
        checksum ^= result.mantissa.wrapping_add(result.sign_exponent as u64);
    }
    checksum
}

#[no_mangle]
pub unsafe fn verify_scale(precision: u8, rounding: u8, count: u32) -> u32 {
    extF80_roundingPrecision = precision;
    softfloat_roundingMode = rounding;
    let mut seed = 0x834256782382A3u64;
    for i in 0..count {
        let a = F80 { mantissa: next(&mut seed), sign_exponent: next(&mut seed) as u16 };
        let b = if i % 8 == 0 {
            F80 { mantissa: next(&mut seed), sign_exponent: next(&mut seed) as u16 }
        } else { F80::of_f64x((i as i32 % 2052 - 1026) as f64 + 0.5) };
        let flags = if i % 2 == 0 { 0 } else { 0x1F };
        softfloat_exceptionFlags = flags;
        let expected = a * b.trunc().two_pow();
        let expected_flags = softfloat_exceptionFlags;
        softfloat_exceptionFlags = flags;
        let actual = a.scale(b);
        if actual.mantissa != expected.mantissa || actual.sign_exponent != expected.sign_exponent
            || softfloat_exceptionFlags != expected_flags {
            FAILURE = [21, a.mantissa, a.sign_exponent as u64, b.mantissa, b.sign_exponent as u64,
                expected.mantissa, expected.sign_exponent as u64, actual.mantissa,
                actual.sign_exponent as u64, ((expected_flags as u64) << 8) | softfloat_exceptionFlags as u64];
            return i + 1;
        }
    }
    0
}
#[no_mangle]
pub unsafe fn benchmark_scale(fast: bool, count: u32) -> u64 {
    softfloat_roundingMode = 0;
    extF80_roundingPrecision = 80;
    let mut checksum = 0u64;
    for i in 0..count {
        let a = std::hint::black_box(F80 { mantissa: 0xABCDEF1234567890u64.wrapping_add(i as u64), sign_exponent: 0x3FFF });
        let b = F80::of_i32((i as i32 & 31) - 16);
        let result = if fast { a.scale(b) } else { a * b.trunc().two_pow() };
        checksum ^= result.mantissa.wrapping_add(result.sign_exponent as u64);
    }
    checksum
}
