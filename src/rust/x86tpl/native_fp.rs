//! Native SSE floating point in compiled code (docs/simd-xsave-plan.md 7.4):
//! Wasm's IEEE arithmetic, admitted only where it gives exactly the results
//! and MXCSR effects of cpu::simd_fp (whose interpreter fast path applies the
//! same rule). The page tier emits these checks (the region backend too until M11); a refused
//! instruction runs in the exact interpreter or helper.
//!
//! MXCSR's flags are sticky. When every exception is masked, the rounding is
//! to nearest, DAZ and FZ are clear and PE is set already (`mxcsr_refused`), a
//! native result equals the exact one and an inexact result changes nothing.
//! The other flags must not become set, so each operation refuses the lanes
//! that could set one: a denormal operand (DE), a NaN or infinite result (IE,
//! ZE, OE; and NaN payloads, which Wasm leaves open) and, for MUL, DIV and the
//! conversion to single precision, a result that is tiny after rounding (at
//! most the smallest normal in magnitude) unless it is the exact zero of a
//! zero factor (UE). A denormal sum or difference of normal operands is
//! exact, so it raises nothing (masked, UE needs inexactness). Operations that
//! cannot round and raise nothing for normal operands (MIN, MAX, compares,
//! widening conversions, reciprocal approximations) need only their operand
//! checks; the `*_refused` functions leave MXCSR's condition to the caller
//! (the page tier evaluates it once per block).
//!
//! FMA (`fused`) uses relaxed SIMD's multiply-adds, but only where the host
//! fuses them (cpu.js checks at startup, see x64::helpers::relaxed_fma):
//! then they round once, as IEEE 754's fusedMultiplyAdd and x86's FMA, and
//! the admitted lanes' results are exact and the same on every host.
//!
//! The checks build a mask of the admitted lanes with integer and float
//! comparisons. Their constants have the same value in every 32-bit lane, so
//! that each is one move of an immediate (arbitrary v128 constants cost a
//! general-purpose register and a transfer per use on ARM64):
//! - finite x: x - x is 0 (else NaN);
//! - 2|x| - 1 (`x << 1` plus all ones) is all ones for a zero and below
//!   2 * smallest normal - 1 exactly for denormals;
//! - tiny x: |x| <= smallest normal.
//!
//! In double precision the integer comparisons see only the high half of
//! each lane (lanes 1 and 3; 2|x| - 1 and 2|x| compared to their bound's high
//! half), which also refuses a few normals just above the smallest one. The
//! low halves of such masks are left over: a scalar form reads lane 1 of the
//! result and packed forms copy the high halves down first (`high_half`).

use crate::cpu::global_pointers as gp;
use crate::wasmgen::wasm_builder::{WasmBuilder, WasmLocalV128};

/// Push i32 nonzero unless MXCSR admits native rounding operations: every
/// exception masked, round to nearest, no DAZ or FZ, PE set
pub fn mxcsr_refused(w: &mut WasmBuilder) {
    w.load_fixed_i32(gp::mxcsr as u32);
    w.const_i32(0xFFE0);
    w.and_i32();
    w.const_i32(0x1FA0);
    w.ne_i32();
}

/// mxcsr_refused with PE either way: for an engine that finds inexact
/// results itself and sets PE (inexact_pe; the page tier)
pub fn mxcsr_refused_any_pe(w: &mut WasmBuilder) {
    w.load_fixed_i32(gp::mxcsr as u32);
    w.const_i32(0xFFC0);
    w.and_i32();
    w.const_i32(0x1F80);
    w.ne_i32();
}

/// mxcsr_refused with DAZ either way: for the templates that refuse every
/// denormal operand, which DAZ then cannot change (the page tier's
/// arithmetic and FMA, P4.18; FZ is mxcsr_refused's)
pub fn mxcsr_refused_any_daz(w: &mut WasmBuilder) {
    w.load_fixed_i32(gp::mxcsr as u32);
    w.const_i32(0xFFA0);
    w.and_i32();
    w.const_i32(0x1FA0);
    w.ne_i32();
}
/// Push i32 nonzero unless every exception is masked and MXCSR rounds to
/// nearest (DAZ, FZ and the flags either way)
pub fn masked_nearest_refused(w: &mut WasmBuilder) {
    w.load_fixed_i32(gp::mxcsr as u32);
    w.const_i32(0x7F80);
    w.and_i32();
    w.const_i32(0x1F80);
    w.ne_i32();
}
/// Push i32 1 if MXCSR.FZ is set, else 0
pub fn flush_to_zero(w: &mut WasmBuilder) {
    w.load_fixed_i32(gp::mxcsr as u32);
    w.const_i32(15);
    w.shr_u_i32();
    w.const_i32(1);
    w.and_i32();
}
/// Push i32 nonzero if MXCSR.PE is clear
pub fn precision_clear(w: &mut WasmBuilder) {
    w.load_fixed_i32(gp::mxcsr as u32);
    w.const_i32(0x20);
    w.and_i32();
    w.eqz_i32();
}

/// Push i32 nonzero unless MXCSR rounds to nearest with PE masked: what an
/// inexact result of an operation that raises nothing else needs
pub fn rounding_refused(w: &mut WasmBuilder) {
    w.load_fixed_i32(gp::mxcsr as u32);
    w.const_i32(0x7000);
    w.and_i32();
    w.const_i32(0x1000);
    w.ne_i32();
}

/// Set MXCSR.PE if the i32 on the stack is nonzero: an inexact result, every
/// exception masked (mxcsr_refused_any_pe)
pub fn inexact_pe(w: &mut WasmBuilder) {
    w.if_void();
    w.const_i32(gp::mxcsr as i32);
    w.load_fixed_i32(gp::mxcsr as u32);
    w.const_i32(0x20);
    w.or_i32();
    w.store_aligned_i32(0);
    w.block_end();
}

/// Push i32 nonzero if a lane read of the mask on the stack is set (a
/// scalar form's: lane 0)
fn any_lane(w: &mut WasmBuilder, scalar: bool) {
    if scalar {
        w.simd_lane(0x1B, 0); // i32x4.extract_lane
    }
    else {
        w.simd(0x53); // v128.any_true
    }
}
/// f64x2.splat of `v`
fn splat64(w: &mut WasmBuilder, v: f64) {
    w.const_f64(v);
    w.simd(0x14); // f64x2.splat
}
/// Push the mask of the f64x2 lanes of `x` that Dekker's splitting cannot
/// take: not zero and outside 2^-450..2^451, where the split could overflow
/// or the error terms lose bits to underflow
fn outside_dekker(w: &mut WasmBuilder, x: &WasmLocalV128) {
    w.get_local_v128(x);
    w.simd(0xEC); // f64x2.abs
    splat64(w, f64::from_bits((0x3FF - 450) << 52));
    w.simd(0x49); // f64x2.lt
    w.get_local_v128(x);
    w.simd_zero();
    w.simd(0x48); // f64x2.ne
    w.simd(0x4E); // v128.and
    w.get_local_v128(x);
    w.simd(0xEC);
    splat64(w, f64::from_bits((0x3FF + 451) << 52));
    w.simd(0x4C); // f64x2.ge
    w.simd(0x50); // v128.or
}
/// Dekker's split of the f64x2 lanes of `v`: (hi, lo), hi = c - (c - v)
/// with c = v * (2^27 + 1), lo = v - hi
fn split(w: &mut WasmBuilder, v: &WasmLocalV128) -> (WasmLocalV128, WasmLocalV128) {
    w.get_local_v128(v);
    splat64(w, 134217729.0);
    w.simd(0xF2); // f64x2.mul
    let c = w.set_new_local_v128();
    w.get_local_v128(&c);
    w.get_local_v128(&c);
    w.get_local_v128(v);
    w.simd(0xF1); // f64x2.sub
    w.simd(0xF1);
    let hi = w.set_new_local_v128();
    w.get_local_v128(v);
    w.get_local_v128(&hi);
    w.simd(0xF1);
    let lo = w.set_new_local_v128();
    w.free_local_v128(c);
    (hi, lo)
}
/// Push the mask of the f64x2 lanes where `p` is not exactly `a` * `b`
/// (Dekker's TwoProduct: its error term is not zero)
fn product_error(w: &mut WasmBuilder, a: &WasmLocalV128, b: &WasmLocalV128, p: &WasmLocalV128) {
    let (ah, al) = split(w, a);
    let (bh, bl) = split(w, b);
    // ((ah * bh - p) + ah * bl + al * bh) + al * bl
    for (k, (x, y)) in [(&ah, &bh), (&ah, &bl), (&al, &bh), (&al, &bl)]
        .into_iter()
        .enumerate()
    {
        w.get_local_v128(x);
        w.get_local_v128(y);
        w.simd(0xF2); // f64x2.mul
        if k == 0 {
            w.get_local_v128(p);
            w.simd(0xF1); // f64x2.sub
        }
        else {
            w.simd(0xF0); // f64x2.add
        }
    }
    w.simd_zero();
    w.simd(0x48); // f64x2.ne
    for v in [ah, al, bh, bl] {
        w.free_local_v128(v);
    }
}
/// Push the mask of the f64x2 lanes where `s` is not exactly `x` + `y`
/// (TwoSum: bb = s - x, its error (x - (s - bb)) + (y - bb) is not zero)
fn sum_error(w: &mut WasmBuilder, x: &WasmLocalV128, y: &WasmLocalV128, s: &WasmLocalV128) {
    w.get_local_v128(s);
    w.get_local_v128(x);
    w.simd(0xF1); // f64x2.sub
    let bb = w.set_new_local_v128();
    w.get_local_v128(x);
    w.get_local_v128(s);
    w.get_local_v128(&bb);
    w.simd(0xF1);
    w.simd(0xF1);
    w.get_local_v128(y);
    w.get_local_v128(&bb);
    w.simd(0xF1);
    w.simd(0xF0); // f64x2.add
    w.simd_zero();
    w.simd(0x48); // f64x2.ne
    w.free_local_v128(bb);
}

/// Push i32 nonzero if a lane read of `r` is tiny and not zero: what MXCSR.FZ
/// would flush (the exact sum or difference of normal operands that
/// arithmetic_refused admits without FZ)
pub fn flushed(w: &mut WasmBuilder, double: bool, scalar: bool, r: &WasmLocalV128) {
    tiny(w, r, double);
    zero(w, r, double);
    w.simd(0x4F); // v128.andnot
    high_half(w, double, scalar);
    if scalar {
        w.simd_lane(0x1B, double as u8); // i32x4.extract_lane
    }
    else {
        w.simd(0x53); // v128.any_true
    }
}

/// Whether `inexact` takes the operation (`op` as there) at all: all but
/// double precision SQRT
pub fn inexact_decides(op: u8, double: bool) -> bool { !(double && op == 0x51) }
/// For an engine that sets PE itself (the page tier, P4.18), where
/// inexact_decides: push i32 nonzero where `inexact` cannot decide whether
/// the result `r` of ADD (0x58), MUL (0x59), SUB (0x5C), DIV (0x5E) or
/// single precision SQRT (0x51, of `b`) of `a` and `b` is exact, in a lane
/// read: double precision MUL and DIV of an operand or result
/// outside_dekker. False: nothing pushed (it decides every lane).
pub fn inexact_undecided(
    w: &mut WasmBuilder,
    op: u8,
    double: bool,
    scalar: bool,
    [a, b]: [&WasmLocalV128; 2],
    r: &WasmLocalV128,
) -> bool {
    match (double, op) {
        (true, 0x59 | 0x5E) => {
            for (k, x) in [a, b, r].into_iter().enumerate() {
                outside_dekker(w, x);
                if k > 0 {
                    w.simd(0x50); // v128.or
                }
            }
            any_lane(w, scalar);
        },
        _ => return false,
    }
    true
}

/// For an engine that sets PE itself (the page tier, P4.18): with the lanes
/// admitted (arithmetic_refused), MXCSR to nearest and every exception
/// masked, and inexact_undecided clear, push i32 nonzero if the result `r`
/// of SQRT (0x51, of `b`; inexact_decides: single precision), ADD (0x58),
/// MUL (0x59), SUB (0x5C) or DIV (0x5E) of `a` and `b` is inexact in a lane
/// read. Single precision: each
/// operation is exact in double precision but a sum, whose error TwoSum
/// gives. Double: TwoSum, and Dekker's TwoProduct for MUL (and DIV: the
/// product of quotient and divisor is the dividend).
pub fn inexact(
    w: &mut WasmBuilder,
    op: u8,
    double: bool,
    scalar: bool,
    [a, b]: [&WasmLocalV128; 2],
    r: &WasmLocalV128,
) {
    if double {
        match op {
            0x58 | 0x5C => {
                let negated = (op == 0x5C).then(|| {
                    w.get_local_v128(b);
                    w.simd(0xED); // f64x2.neg
                    w.set_new_local_v128()
                });
                sum_error(w, a, negated.as_ref().unwrap_or(b), r);
                if let Some(local) = negated {
                    w.free_local_v128(local);
                }
            },
            0x59 => product_error(w, a, b, r),
            _ => {
                dbg_assert!(op == 0x5E, "double SQRT: not inexact_decides");
                w.get_local_v128(r);
                w.get_local_v128(b);
                w.simd(0xF2); // f64x2.mul
                let p = w.set_new_local_v128();
                product_error(w, r, b, &p);
                w.get_local_v128(&p);
                w.get_local_v128(a);
                w.simd(0x48); // f64x2.ne
                w.simd(0x50); // v128.or
                w.free_local_v128(p);
            },
        }
        any_lane(w, scalar);
        return;
    }
    // single precision: lanes 0 and 1, then 2 and 3, in double precision
    for half in 0..if scalar { 1 } else { 2 } {
        let promote = |w: &mut WasmBuilder, x: &WasmLocalV128| {
            w.get_local_v128(x);
            if half == 1 {
                w.get_local_v128(x);
                w.simd_shuffle([8, 9, 10, 11, 12, 13, 14, 15, 8, 9, 10, 11, 12, 13, 14, 15]);
            }
            w.simd(0x5F); // f64x2.promote_low_f32x4
            w.set_new_local_v128()
        };
        let (x, y, s) = (promote(w, a), promote(w, b), promote(w, r));
        match op {
            0x58 | 0x5C => {
                if op == 0x5C {
                    w.get_local_v128(&y);
                    w.simd(0xED); // f64x2.neg
                    w.set_local_v128(&y);
                }
                w.get_local_v128(&x);
                w.get_local_v128(&y);
                w.simd(0xF0); // f64x2.add
                let sum = w.set_new_local_v128();
                sum_error(w, &x, &y, &sum);
                w.get_local_v128(&sum);
                w.get_local_v128(&s);
                w.simd(0x48); // f64x2.ne
                w.simd(0x50); // v128.or
                w.free_local_v128(sum);
            },
            // x * y, s * y and s * s are exact (48 significant bits)
            0x59 => {
                w.get_local_v128(&x);
                w.get_local_v128(&y);
                w.simd(0xF2); // f64x2.mul
                w.get_local_v128(&s);
                w.simd(0x48); // f64x2.ne
            },
            0x5E => {
                w.get_local_v128(&s);
                w.get_local_v128(&y);
                w.simd(0xF2);
                w.get_local_v128(&x);
                w.simd(0x48);
            },
            _ => {
                w.get_local_v128(&s);
                w.get_local_v128(&s);
                w.simd(0xF2);
                w.get_local_v128(&y);
                w.simd(0x48);
            },
        }
        if half == 1 {
            w.simd(0x50); // v128.or
        }
        for v in [x, y, s] {
            w.free_local_v128(v);
        }
    }
    any_lane(w, scalar);
}

/// v128.const with `v` in every 32-bit lane
fn splat32(w: &mut WasmBuilder, v: u32) {
    let mut bytes = [0; 16];
    for (i, b) in bytes.iter_mut().enumerate() {
        *b = (v >> (i % 4 * 8)) as u8;
    }
    w.const_v128(bytes);
}

/// The lanes an instruction reads
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Lanes {
    /// lane 0
    Scalar,
    /// all lanes
    Packed,
    /// single-precision lanes 0 and 1 (CVTPS2PD)
    LowPair,
}
/// Pop an admitted-lanes mask, push i32 nonzero if a lane read is refused
fn refused(w: &mut WasmBuilder, double: bool, lanes: Lanes) {
    match lanes {
        // (lane 1: the high half of a double, see above)
        Lanes::Scalar => w.simd_lane(0x1B, double as u8), // i32x4.extract_lane
        Lanes::Packed => w.simd(0xA3),                    // i32x4.all_true
        Lanes::LowPair => {
            w.simd_lane(0x1D, 0); // i64x2.extract_lane
            w.const_i64(-1);
            w.ne_i64();
            return;
        },
    }
    w.eqz_i32();
}
/// Make a mask of double-precision lanes from its high halves (packed forms)
fn high_half(w: &mut WasmBuilder, double: bool, scalar: bool) {
    if double && !scalar {
        w.const_i32(32);
        w.simd(0xCC); // i64x2.shr_s
    }
}

/// Push the mask of finite lanes
fn finite(w: &mut WasmBuilder, x: &WasmLocalV128, double: bool) {
    w.get_local_v128(x);
    w.get_local_v128(x);
    w.simd(if double { 0xF1 } else { 0xE5 }); // sub
    w.simd_zero();
    w.simd(if double { 0x47 } else { 0x41 }); // eq
}
/// Push the mask of ordered (not NaN) lanes
fn ordered(w: &mut WasmBuilder, x: &WasmLocalV128, double: bool) {
    w.get_local_v128(x);
    w.get_local_v128(x);
    w.simd(if double { 0x47 } else { 0x41 }); // eq
}
/// Push the mask of zero lanes
fn zero(w: &mut WasmBuilder, x: &WasmLocalV128, double: bool) {
    w.get_local_v128(x);
    w.simd_zero();
    w.simd(if double { 0x47 } else { 0x41 }); // eq
}
/// Push the mask of tiny lanes: magnitudes at most the smallest normal (a
/// zero too)
fn tiny(w: &mut WasmBuilder, x: &WasmLocalV128, double: bool) {
    w.get_local_v128(x);
    if double {
        w.const_i32(1);
        w.simd(0xCB); // i64x2.shl: 2|x|
        splat32(w, 0x0020_0000);
        w.simd(0x3E); // i32x4.le_u
    }
    else {
        w.simd(0xE0); // f32x4.abs
        splat32(w, 0x0080_0000);
        w.simd(0x45); // f32x4.le
    }
}
/// Push 2|x| - 1 per lane
fn twice_less_one(w: &mut WasmBuilder, x: &WasmLocalV128, double: bool) {
    w.get_local_v128(x);
    w.const_i32(1);
    w.simd(if double { 0xCB } else { 0xAB }); // shl
    w.const_v128([0xFF; 16]);
    w.simd(if double { 0xCE } else { 0xAE }); // add
}
/// Pop 2|x| - 1, push the mask of denormal lanes
fn denormal_of(w: &mut WasmBuilder, double: bool) {
    splat32(w, if double { 0x0020_0000 } else { 0x00FF_FFFF });
    w.simd(0x3A); // i32x4.lt_u
}
/// Push the mask of denormal lanes of `x`
fn denormal(w: &mut WasmBuilder, x: &WasmLocalV128, double: bool) {
    twice_less_one(w, x, double);
    denormal_of(w, double);
}
/// Push the mask of lanes where `x` or `y` is denormal
fn denormal2(w: &mut WasmBuilder, x: &WasmLocalV128, y: &WasmLocalV128, double: bool) {
    twice_less_one(w, x, double);
    twice_less_one(w, y, double);
    w.simd(0xB7); // i32x4.min_u
    denormal_of(w, double);
}

/// Push the mask of lanes where an operand not known to be `clean` has a
/// zero exponent: a zero or a denormal (or nothing when all are clean)
fn exponent_zero_unknown(
    w: &mut WasmBuilder,
    operands: [(&WasmLocalV128, bool); 2],
    double: bool,
) -> bool {
    let mut unknown = operands.iter().filter(|(_, clean)| !clean).map(|(x, _)| x);
    let Some(x) = unknown.next()
    else {
        return false;
    };
    for (k, x) in std::iter::once(x).chain(unknown).enumerate() {
        w.get_local_v128(x);
        w.const_i32(1);
        w.simd(if double { 0xCB } else { 0xAB }); // shl: 2|x|
        if k > 0 {
            w.simd(0xB7); // i32x4.min_u
        }
    }
    splat32(w, if double { 0x0020_0000 } else { 0x0100_0000 });
    w.simd(0x3A); // i32x4.lt_u
    true
}

/// The cheap first test of arithmetic_refused: push i32 zero only if that
/// check would admit the instruction (its operands not known to be clean
/// have no zero exponent, a product or quotient is not tiny), else nonzero:
/// arithmetic_refused decides. None where it would be arithmetic_refused.
pub fn arithmetic_unsure(
    w: &mut WasmBuilder,
    op: u8,
    double: bool,
    scalar: bool,
    [a, b]: [&WasmLocalV128; 2],
    [a_clean, b_clean]: [bool; 2],
    r: &WasmLocalV128,
) -> bool {
    // Where it pays: the zero-exempt tininess test of a scalar product or
    // quotient. (Packed data, vectors and matrices, often holds zeros that
    // would fail the first test every time.)
    let operands = [(a, a_clean), (b, b_clean)];
    if !matches!(op, 0x59 | 0x5E) || !scalar {
        return false;
    }
    if matches!(op, 0x5D | 0x5F) {
        let mut unknown = operands.iter().filter(|(_, clean)| !clean);
        let (x, _) = unknown.next().unwrap();
        ordered(w, x, double);
        if let Some((y, _)) = unknown.next() {
            ordered(w, y, double);
            w.simd(0x4E); // v128.and
        }
        exponent_zero_unknown(w, operands, double);
    }
    else {
        finite(w, r, double);
        let mut suspect = exponent_zero_unknown(w, operands, double);
        if op == 0x59 || op == 0x5E {
            tiny(w, r, double);
            if suspect {
                w.simd(0x50); // v128.or
            }
            suspect = true;
        }
        dbg_assert!(suspect);
    }
    high_half(w, double, scalar);
    w.simd(0x4F); // v128.andnot
    refused(
        w,
        double,
        if scalar { Lanes::Scalar } else { Lanes::Packed },
    );
    true
}

/// Push the mask of lanes where an operand not known to be `clean` is
/// denormal (or nothing when all are clean)
fn denormal_unknown(
    w: &mut WasmBuilder,
    operands: [(&WasmLocalV128, bool); 2],
    double: bool,
) -> bool {
    match operands {
        [(x, false), (y, false)] => denormal2(w, x, y, double),
        [(x, false), _] | [_, (x, false)] => denormal(w, x, double),
        _ => return false,
    }
    true
}

/// Push the mask of lanes where the operands not known to be `clean` are
/// neither NaN nor denormal (false: all are clean, nothing pushed)
fn clean_operands(
    w: &mut WasmBuilder,
    operands: [(&WasmLocalV128, bool); 2],
    double: bool,
    scalar: bool,
) -> bool {
    let mut unknown = operands.iter().filter(|(_, clean)| !clean);
    let Some((x, _)) = unknown.next()
    else {
        return false;
    };
    ordered(w, x, double);
    if let Some((y, _)) = unknown.next() {
        ordered(w, y, double);
        w.simd(0x4E); // v128.and
    }
    denormal_unknown(w, operands, double);
    high_half(w, double, scalar);
    w.simd(0x4F); // v128.andnot
    true
}

/// SQRT (0x51, of `b`), ADD (0x58), MUL (0x59), SUB (0x5C), MIN (0x5D), DIV
/// (0x5E) and MAX (0x5F) of `a` (the destination) and `b` (the source) with
/// the native result `r`: push i32 nonzero to refuse. MIN and MAX of
/// operands that are neither NaN nor denormal raise nothing and do not
/// round: they do not depend on MXCSR; the others need mxcsr_refused too.
///
/// An operand known to be clean (`a_clean`, `b_clean`: neither NaN nor
/// denormal in the lanes read) is not checked again. All operands of an
/// admitted instruction are clean afterwards, and so are its results except
/// those of ADD and SUB (possibly an exact denormal).
pub fn arithmetic_refused(
    w: &mut WasmBuilder,
    op: u8,
    double: bool,
    scalar: bool,
    [a, b]: [&WasmLocalV128; 2],
    [a_clean, b_clean]: [bool; 2],
    r: &WasmLocalV128,
) {
    let operands =
        if op == 0x51 { [(b, b_clean), (b, true)] } else { [(a, a_clean), (b, b_clean)] };
    if matches!(op, 0x5D | 0x5F) {
        if !clean_operands(w, operands, double, scalar) {
            w.const_i32(0);
            return;
        }
    }
    else {
        finite(w, r, double);
        let mut refused_lanes = denormal_unknown(w, operands, double);
        if op == 0x59 || op == 0x5E {
            // a tiny product or quotient is exact only as the zero of a zero
            // factor (dividend)
            tiny(w, r, double);
            zero(w, a, double);
            if op == 0x59 {
                zero(w, b, double);
                w.simd(0x50); // v128.or
            }
            w.simd(0x4F); // v128.andnot
            if refused_lanes {
                w.simd(0x50);
            }
            refused_lanes = true;
        }
        if refused_lanes {
            high_half(w, double, scalar);
            w.simd(0x4F); // finite and not refused
        }
    }
    refused(
        w,
        double,
        if scalar { Lanes::Scalar } else { Lanes::Packed },
    );
}

/// FMA of the factors `x`, `y` and the addend `z` with the native fused
/// result `r` (see fused): push i32 nonzero to refuse a denormal operand
/// (DE), a result that is NaN or infinite (IE, OE; also NaN and infinite
/// operands, whose results are such) and a tiny result (UE) unless it is the
/// exact zero of a zero factor and a zero addend. Rounded once, as
/// cpu::simd_fp::fused; with mxcsr_refused's condition only PE (set) could
/// be raised.
pub fn fused_refused(
    w: &mut WasmBuilder,
    double: bool,
    scalar: bool,
    [x, y, z]: [&WasmLocalV128; 3],
    r: &WasmLocalV128,
) {
    finite(w, r, double);
    twice_less_one(w, x, double);
    twice_less_one(w, y, double);
    w.simd(0xB7); // i32x4.min_u
    twice_less_one(w, z, double);
    w.simd(0xB7);
    denormal_of(w, double);
    tiny(w, r, double);
    zero(w, x, double);
    zero(w, y, double);
    w.simd(0x50); // v128.or
    zero(w, z, double);
    w.simd(0x4E); // v128.and
    w.simd(0x4F); // v128.andnot: tiny, not the zero of zeros
    w.simd(0x50); // or denormal
    high_half(w, double, scalar);
    w.simd(0x4F); // finite and not refused
    refused(
        w,
        double,
        if scalar { Lanes::Scalar } else { Lanes::Packed },
    );
}

/// FMA (the 0F 38 opcode byte `op` of VFMADD/VFMSUB/VFNMADD/VFNMSUB
/// 132/213/231 PS/PD/SS/SD and VFMADDSUB/VFMSUBADD) of the destination `d`,
/// the first source `f` (VEX.vvvv) and the r/m operand `t` with the host's
/// relaxed_madd/relaxed_nmadd, which must fuse (runtime::tier0::relaxed_fma):
/// returns the native result (a scalar form's in its low lane) and pushes
/// fused_refused's i32 (MXCSR's condition is the caller's).
pub fn fused(
    w: &mut WasmBuilder,
    op: u8,
    double: bool,
    scalar: bool,
    [d, f, t]: [&WasmLocalV128; 3],
) -> WasmLocalV128 {
    // the factors and the addend: 132 d * t + f, 213 f * d + t, 231 f * t + d
    let [x, y, z] = match op >> 4 {
        0x9 => [d, t, f],
        0xA => [f, d, t],
        _ => [f, t, d],
    };
    // a subtraction adds the negated addend (exact): VFMSUB and VFNMSUB in
    // every lane, VFMADDSUB in the even ones, VFMSUBADD in the odd ones
    let negated = match op & 0xF {
        0xA | 0xB | 0xE | 0xF => {
            w.get_local_v128(z);
            w.simd(if double { 0xED } else { 0xE1 }); // neg
            Some(w.set_new_local_v128())
        },
        k @ (6 | 7) => {
            let sign: [u32; 4] = match (double, k == 6) {
                (true, true) => [0, 0x8000_0000, 0, 0],
                (true, false) => [0, 0, 0, 0x8000_0000],
                (false, true) => [0x8000_0000, 0, 0x8000_0000, 0],
                (false, false) => [0, 0x8000_0000, 0, 0x8000_0000],
            };
            let mut bytes = [0; 16];
            for (i, b) in bytes.iter_mut().enumerate() {
                *b = (sign[i / 4] >> (i % 4 * 8)) as u8;
            }
            w.get_local_v128(z);
            w.const_v128(bytes);
            w.simd(0x51); // v128.xor
            Some(w.set_new_local_v128())
        },
        _ => None,
    };
    let z = negated.as_ref().unwrap_or(z);
    w.get_local_v128(x);
    w.get_local_v128(y);
    w.get_local_v128(z);
    // relaxed_madd x * y + z, relaxed_nmadd -(x * y) + z (VFNMADD, VFNMSUB)
    let negative = op & 0xF >= 0xC;
    w.simd(match (double, negative) {
        (false, false) => 0x105,
        (false, true) => 0x106,
        (true, false) => 0x107,
        (true, true) => 0x108,
    });
    let r = w.set_new_local_v128();
    fused_refused(w, double, scalar, [x, y, z], &r);
    if let Some(local) = negated {
        w.free_local_v128(local);
    }
    r
}

/// CVTPD2PS/CVTSD2SS of `x` with the native result `r`: push i32 nonzero to
/// refuse a denormal source and a result that is NaN, infinite or tiny
/// unless of a zero source (MXCSR's condition is the caller's)
pub fn narrowing_refused(w: &mut WasmBuilder, scalar: bool, x: &WasmLocalV128, r: &WasmLocalV128) {
    // the single-precision result lanes 0 and 1 at the source's lanes
    w.get_local_v128(r);
    w.get_local_v128(r);
    w.simd_shuffle([0, 1, 2, 3, 0, 1, 2, 3, 4, 5, 6, 7, 4, 5, 6, 7]);
    let s = w.set_new_local_v128();
    finite(w, &s, false);
    tiny(w, &s, false);
    zero(w, x, true);
    w.simd(0x4F); // v128.andnot
    denormal(w, x, true);
    w.simd(0x50); // v128.or
    high_half(w, true, scalar);
    w.simd(0x4F);
    w.free_local_v128(s);
    refused(w, true, if scalar { Lanes::Scalar } else { Lanes::Packed });
}

/// COMISS/UCOMISS/COMISD/UCOMISD of `x` and `y` (Lanes::Scalar) and
/// CVTPS2PD/CVTSS2SD of `x` (pass `y` clean, Lanes::LowPair or Scalar): push
/// i32 nonzero to refuse a NaN or denormal operand not known to be `clean`.
/// Exact, and without those operands nothing is raised.
pub fn operands_refused(
    w: &mut WasmBuilder,
    double: bool,
    lanes: Lanes,
    [x, y]: [&WasmLocalV128; 2],
    [x_clean, y_clean]: [bool; 2],
) {
    if clean_operands(
        w,
        [(x, x_clean), (y, y_clean)],
        double,
        lanes != Lanes::Packed,
    ) {
        refused(w, double, lanes);
    }
    else {
        w.const_i32(0);
    }
}

/// RCPPS/RCPSS (0x53) and RSQRTPS/RSQRTSS (0x52) of `x` with the native
/// result `r` (1 / x, 1 / sqrt(x)): push i32 nonzero to refuse a source that
/// is zero, denormal, NaN or infinite (or negative for 0x52) and a result in
/// the denormal range (which simd_fp::reciprocal makes zero). No exceptions.
pub fn reciprocal_refused(
    w: &mut WasmBuilder,
    op: u8,
    scalar: bool,
    x: &WasmLocalV128,
    r: &WasmLocalV128,
) {
    finite(w, x, false);
    tiny(w, x, false);
    // (a result in the denormal range: below the smallest normal)
    w.get_local_v128(r);
    w.simd(0xE0); // f32x4.abs
    splat32(w, 0x0080_0000);
    w.simd(0x43); // f32x4.lt
    w.simd(0x50); // v128.or
    if op == 0x52 {
        w.get_local_v128(x);
        w.simd_zero();
        w.simd(0x43); // negative
        w.simd(0x50);
    }
    w.simd(0x4F); // v128.andnot
    refused(w, false, if scalar { Lanes::Scalar } else { Lanes::Packed });
}
