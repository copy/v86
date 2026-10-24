//! Floating point of the AArch64 core (docs/arm64-virt-android16-plan.md
//! P2.6, P2.8): SoftFloat 3e with the ARM-VFPv2 specialization
//! (build/softfloat_arm.c, tools/softfloat_arm.mjs) and the rules the Arm
//! ARM's pseudocode adds around it: FPCR's RMode, FZ (a denormal input reads
//! as zero and sets IDC; a result whose exact value is below the normal
//! range becomes zero and sets UFC alone), DN (every NaN result is the
//! default NaN; a signaling input still sets IOC) and AHP; the sticky
//! FPSR flags; NaN selection for the fused multiply-adds (addend, op1, op2,
//! signaling before quiet, with the operands FNMADD and FNMSUB negate
//! negated first); FMAX/FMIN/FMAXNM/FMINNM; comparisons; conversions that
//! saturate with a NaN converting to 0; the estimates. FPCR's trap enables
//! read as zero, so no FP exception ever traps.

use crate::aarch64::cpu::{self, Exception};
use crate::aarch64::state::{cpacr_el1, fpcr, fpsr};

/// FPCR's bits that take effect: AHP, DN, FZ, RMode (the trap enables are
/// RAZ/WI, FZ16 is not in v1)
pub const FPCR_WRITABLE: u32 = 0x07C0_0000;
pub const FPCR_AHP: u32 = 1 << 26;
pub const FPCR_DN: u32 = 1 << 25;
pub const FPCR_FZ: u32 = 1 << 24;

// FPSR's cumulative bits
pub const FPSR_IOC: u32 = 1 << 0;
pub const FPSR_DZC: u32 = 1 << 1;
pub const FPSR_OFC: u32 = 1 << 2;
pub const FPSR_UFC: u32 = 1 << 3;
pub const FPSR_IXC: u32 = 1 << 4;
pub const FPSR_IDC: u32 = 1 << 7;
pub const FPSR_QC: u32 = 1 << 27;

pub fn fpcr_read() -> u64 { unsafe { *fpcr as u64 } }
pub fn fpcr_write(value: u64) { unsafe { *fpcr = value as u32 & FPCR_WRITABLE } }

/// CPACR_EL1.FPEN: whether FP and AdvSIMD instructions trap at this EL
#[inline]
pub fn check_access() -> Result<(), Exception> {
    // (cpu_type arm32: FPEXC.EN too)
    if cpu::a32_only() && !crate::aarch64::a32_system::fp_enabled() {
        return Err(Exception::Undefined);
    }
    let fpen = unsafe { *cpacr_el1 } >> 20 & 3;
    let allowed = match fpen {
        0b01 => cpu::el() == 1,
        0b11 => true,
        _ => false,
    };
    if allowed {
        Ok(())
    }
    else {
        Err(Exception::FpAccess)
    }
}

// SoftFloat (single-element structs pass as their scalar in Wasm's C ABI)
#[allow(improper_ctypes)]
extern "C" {
    static mut softfloat_roundingMode: u8;
    static mut softfloat_exceptionFlags: u8;
    fn f32_add(a: u32, b: u32) -> u32;
    fn f32_sub(a: u32, b: u32) -> u32;
    fn f32_mul(a: u32, b: u32) -> u32;
    fn f32_div(a: u32, b: u32) -> u32;
    fn f32_sqrt(a: u32) -> u32;
    fn f32_mulAdd(a: u32, b: u32, c: u32) -> u32;
    fn f32_roundToInt(a: u32, mode: u8, exact: bool) -> u32;
    fn f32_to_f64(a: u32) -> u64;
    fn f32_to_f16(a: u32) -> u16;
    fn f32_to_i32(a: u32, mode: u8, exact: bool) -> i32;
    fn f32_to_ui32(a: u32, mode: u8, exact: bool) -> u32;
    fn f32_to_i64(a: u32, mode: u8, exact: bool) -> i64;
    fn f32_to_ui64(a: u32, mode: u8, exact: bool) -> u64;
    fn f64_add(a: u64, b: u64) -> u64;
    fn f64_sub(a: u64, b: u64) -> u64;
    fn f64_mul(a: u64, b: u64) -> u64;
    fn f64_div(a: u64, b: u64) -> u64;
    fn f64_sqrt(a: u64) -> u64;
    fn f64_mulAdd(a: u64, b: u64, c: u64) -> u64;
    fn f64_roundToInt(a: u64, mode: u8, exact: bool) -> u64;
    fn f64_to_f32(a: u64) -> u32;
    fn f64_to_f16(a: u64) -> u16;
    fn f64_to_i32(a: u64, mode: u8, exact: bool) -> i32;
    fn f64_to_ui32(a: u64, mode: u8, exact: bool) -> u32;
    fn f64_to_i64(a: u64, mode: u8, exact: bool) -> i64;
    fn f64_to_ui64(a: u64, mode: u8, exact: bool) -> u64;
    fn f16_to_f32(a: u16) -> u32;
    fn f16_to_f64(a: u16) -> u64;
    fn i32_to_f32(a: i32) -> u32;
    fn i64_to_f32(a: i64) -> u32;
    fn ui32_to_f32(a: u32) -> u32;
    fn ui64_to_f32(a: u64) -> u32;
    fn i32_to_f64(a: i32) -> u64;
    fn i64_to_f64(a: i64) -> u64;
    fn ui32_to_f64(a: u32) -> u64;
    fn ui64_to_f64(a: u64) -> u64;
}

// SoftFloat's rounding modes and flags
pub const ROUND_NEAR_EVEN: u8 = 0;
pub const ROUND_MIN_MAG: u8 = 1;
pub const ROUND_MIN: u8 = 2;
pub const ROUND_MAX: u8 = 3;
pub const ROUND_NEAR_MAX_MAG: u8 = 4;
pub const ROUND_ODD: u8 = 6;
const FLAG_INEXACT: u8 = 1;
const FLAG_UNDERFLOW: u8 = 2;
const FLAG_OVERFLOW: u8 = 4;
const FLAG_INFINITE: u8 = 8;
const FLAG_INVALID: u8 = 16;

/// FPCR.RMode as SoftFloat's rounding mode (RN, RP, RM, RZ)
pub fn rounding_of(rmode: u32) -> u8 {
    [ROUND_NEAR_EVEN, ROUND_MAX, ROUND_MIN, ROUND_MIN_MAG][rmode as usize & 3]
}

/// One instruction's FP environment: FPCR, and the FPSR flags it raises
pub struct Fp {
    pub fpcr: u32,
    flags: u32,
}

/// A floating-point format's constants
pub trait Format: Copy {
    const BITS: u32;
    const EXPONENT: u64;
    const MANTISSA: u64;
    const SIGN: u64;
    const QUIET: u64;
    const DEFAULT_NAN: u64;
    fn to(v: u64) -> u64 { v & (u64::MAX >> (64 - Self::BITS)) }
}
#[derive(Clone, Copy)]
pub struct F32;
#[derive(Clone, Copy)]
pub struct F64;
impl Format for F32 {
    const BITS: u32 = 32;
    const EXPONENT: u64 = 0x7F80_0000;
    const MANTISSA: u64 = 0x007F_FFFF;
    const SIGN: u64 = 0x8000_0000;
    const QUIET: u64 = 0x0040_0000;
    const DEFAULT_NAN: u64 = 0x7FC0_0000;
}
impl Format for F64 {
    const BITS: u32 = 64;
    const EXPONENT: u64 = 0x7FF0_0000_0000_0000;
    const MANTISSA: u64 = 0x000F_FFFF_FFFF_FFFF;
    const SIGN: u64 = 0x8000_0000_0000_0000;
    const QUIET: u64 = 0x0008_0000_0000_0000;
    const DEFAULT_NAN: u64 = 0x7FF8_0000_0000_0000;
}

#[inline(always)]
pub fn is_nan<T: Format>(v: u64) -> bool { v & T::EXPONENT == T::EXPONENT && v & T::MANTISSA != 0 }
#[inline(always)]
pub fn is_snan<T: Format>(v: u64) -> bool { is_nan::<T>(v) && v & T::QUIET == 0 }
#[inline(always)]
pub fn is_inf<T: Format>(v: u64) -> bool { v & !T::SIGN == T::EXPONENT }
#[inline(always)]
pub fn is_zero<T: Format>(v: u64) -> bool { v & !T::SIGN == 0 }
#[inline(always)]
pub fn is_denormal<T: Format>(v: u64) -> bool { v & T::EXPONENT == 0 && v & T::MANTISSA != 0 }

impl Fp {
    /// The current FPCR, SoftFloat set to its rounding mode
    pub fn new() -> Fp { Fp::with(unsafe { *fpcr }) }
    /// An environment of the given FPCR (AArch32's Advanced SIMD runs on
    /// the standard FPSCR value: AHP as FPSCR's, DN, FZ, round to nearest)
    pub fn with(fpcr_value: u32) -> Fp {
        unsafe {
            softfloat_roundingMode = rounding_of(fpcr_value >> 22);
            softfloat_exceptionFlags = 0;
        }
        Fp {
            fpcr: fpcr_value,
            flags: 0,
        }
    }
    #[inline(always)]
    pub fn fz(&self) -> bool { self.fpcr & FPCR_FZ != 0 }
    #[inline(always)]
    pub fn dn(&self) -> bool { self.fpcr & FPCR_DN != 0 }
    #[inline(always)]
    pub fn ahp(&self) -> bool { self.fpcr & FPCR_AHP != 0 }
    #[inline(always)]
    pub fn raise(&mut self, flags: u32) { self.flags |= flags }
    /// FPSR |= the flags raised
    pub fn finish(self) { unsafe { *fpsr |= self.flags } }

    /// SoftFloat's flags since the last take, as FPSR bits
    fn take_softfloat(&mut self) -> u32 {
        let flags = unsafe { softfloat_exceptionFlags };
        unsafe { softfloat_exceptionFlags = 0 };
        let mut fpsr_bits = 0;
        if flags & FLAG_INVALID != 0 {
            fpsr_bits |= FPSR_IOC;
        }
        if flags & FLAG_INFINITE != 0 {
            fpsr_bits |= FPSR_DZC;
        }
        if flags & FLAG_OVERFLOW != 0 {
            fpsr_bits |= FPSR_OFC;
        }
        if flags & FLAG_UNDERFLOW != 0 {
            fpsr_bits |= FPSR_UFC;
        }
        if flags & FLAG_INEXACT != 0 {
            fpsr_bits |= FPSR_IXC;
        }
        fpsr_bits
    }

    /// FPUnpack's flush: a denormal input reads as zero under FZ (IDC)
    #[inline(always)]
    pub fn input<T: Format>(&mut self, v: u64) -> u64 {
        if self.fz() && is_denormal::<T>(v) {
            self.flags |= FPSR_IDC;
            v & T::SIGN
        }
        else {
            v
        }
    }

    /// A SoftFloat result: DN, the FZ flush of a result below the normal
    /// range (UFC only), the flags
    #[inline(always)]
    pub fn output<T: Format>(&mut self, v: u64) -> u64 {
        let flags = self.take_softfloat();
        if is_nan::<T>(v) {
            self.flags |= flags;
            return if self.dn() { T::DEFAULT_NAN } else { v };
        }
        if self.fz() && (is_denormal::<T>(v) || flags & FPSR_UFC != 0) {
            self.flags |= flags & !(FPSR_UFC | FPSR_IXC) | FPSR_UFC;
            return v & T::SIGN;
        }
        self.flags |= flags;
        v
    }

    /// FPProcessNaNs for two operands (signaling before quiet, op1 before op2)
    pub fn process_nans<T: Format>(&mut self, a: u64, b: u64) -> Option<u64> {
        let pick = if is_snan::<T>(a) {
            a
        }
        else if is_snan::<T>(b) {
            b
        }
        else if is_nan::<T>(a) {
            a
        }
        else if is_nan::<T>(b) {
            b
        }
        else {
            return None;
        };
        Some(self.nan_result::<T>(pick))
    }
    /// A NaN operand's result: quieted (IOC if it signaled), or the default NaN with DN
    pub fn nan_result<T: Format>(&mut self, v: u64) -> u64 {
        if is_snan::<T>(v) {
            self.flags |= FPSR_IOC;
        }
        if self.dn() {
            T::DEFAULT_NAN
        }
        else {
            v | T::QUIET
        }
    }
}

// ---- the operations, generic over F32 and F64

macro_rules! dispatch {
    ($t:ty, $f32:ident, $f64:ident, $($arg:expr),*) => {
        if <$t>::BITS == 32 { unsafe { $f32($($arg as u32),*) as u64 } } else { unsafe { $f64($($arg),*) } }
    };
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Arith {
    Add,
    Sub,
    Mul,
    Div,
}

impl Fp {
    pub fn arith<T: Format>(&mut self, op: Arith, a: u64, b: u64) -> u64 {
        let (a, b) = (self.input::<T>(a), self.input::<T>(b));
        let r = match op {
            Arith::Add => dispatch!(T, f32_add, f64_add, a, b),
            Arith::Sub => dispatch!(T, f32_sub, f64_sub, a, b),
            Arith::Mul => dispatch!(T, f32_mul, f64_mul, a, b),
            Arith::Div => dispatch!(T, f32_div, f64_div, a, b),
        };
        self.output::<T>(r)
    }

    pub fn sqrt<T: Format>(&mut self, a: u64) -> u64 {
        let a = self.input::<T>(a);
        let r = if T::BITS == 32 {
            unsafe { f32_sqrt(a as u32) as u64 }
        }
        else {
            unsafe { f64_sqrt(a) }
        };
        self.output::<T>(r)
    }

    /// FPMulAdd: addend + op1 * op2, rounded once
    pub fn mul_add<T: Format>(&mut self, addend: u64, op1: u64, op2: u64) -> u64 {
        let (a, n, m) = (
            self.input::<T>(addend),
            self.input::<T>(op1),
            self.input::<T>(op2),
        );
        let inf_zero = (is_inf::<T>(n) && is_zero::<T>(m)) || (is_zero::<T>(n) && is_inf::<T>(m));
        // (FPProcessNaNs3 in the order addend, op1, op2)
        for v in [a, n, m] {
            if is_snan::<T>(v) {
                return self.nan_result::<T>(v);
            }
        }
        if is_nan::<T>(a) && inf_zero {
            self.flags |= FPSR_IOC;
            return T::DEFAULT_NAN;
        }
        for v in [a, n, m] {
            if is_nan::<T>(v) {
                return self.nan_result::<T>(v);
            }
        }
        let r = if T::BITS == 32 {
            unsafe { f32_mulAdd(n as u32, m as u32, a as u32) as u64 }
        }
        else {
            unsafe { f64_mulAdd(n, m, a) }
        };
        self.output::<T>(r)
    }

    /// FMAX (max) or FMIN, and with `numbers` FMAXNM/FMINNM (a quiet NaN
    /// against a number gives the number)
    pub fn max_min<T: Format>(&mut self, a: u64, b: u64, max: bool, numbers: bool) -> u64 {
        let (a, b) = (self.input::<T>(a), self.input::<T>(b));
        if numbers {
            let (qa, qb) = (
                is_nan::<T>(a) && !is_snan::<T>(a),
                is_nan::<T>(b) && !is_snan::<T>(b),
            );
            if qa && !is_nan::<T>(b) {
                return b;
            }
            if qb && !is_nan::<T>(a) {
                return a;
            }
        }
        if let Some(nan) = self.process_nans::<T>(a, b) {
            return nan;
        }
        if is_zero::<T>(a) && is_zero::<T>(b) {
            // (+0 is the larger zero)
            return if max { a & b } else { a | b };
        }
        let a_greater = compare_values::<T>(a, b) == core::cmp::Ordering::Greater;
        if a_greater == max {
            a
        }
        else {
            b
        }
    }

    /// FMULX: FMUL, except that infinity times zero is 2.0 (signed)
    pub fn mulx<T: Format>(&mut self, a: u64, b: u64) -> u64 {
        let (a, b) = (self.input::<T>(a), self.input::<T>(b));
        if let Some(nan) = self.process_nans::<T>(a, b) {
            return nan;
        }
        if (is_inf::<T>(a) && is_zero::<T>(b)) || (is_zero::<T>(a) && is_inf::<T>(b)) {
            let two = if T::BITS == 32 { 0x4000_0000 } else { 0x4000_0000_0000_0000 };
            return (a ^ b) & T::SIGN | two;
        }
        self.arith::<T>(Arith::Mul, a, b)
    }

    /// FPCompare: N Z C V (unordered 0011); IOC for a signaling NaN, or any NaN with `signal`
    pub fn compare<T: Format>(&mut self, a: u64, b: u64, signal: bool) -> u32 {
        let (a, b) = (self.input::<T>(a), self.input::<T>(b));
        if is_nan::<T>(a) || is_nan::<T>(b) {
            if signal || is_snan::<T>(a) || is_snan::<T>(b) {
                self.flags |= FPSR_IOC;
            }
            return 0b0011 << 28;
        }
        match compare_values::<T>(a, b) {
            core::cmp::Ordering::Equal => 0b0110 << 28,
            core::cmp::Ordering::Less => 0b1000 << 28,
            core::cmp::Ordering::Greater => 0b0010 << 28,
        }
    }
    /// FPCompareEQ (quiet), FPCompareGE and FPCompareGT (signaling)
    pub fn compare_eq<T: Format>(&mut self, a: u64, b: u64) -> bool {
        self.compare::<T>(a, b, false) == 0b0110 << 28
    }
    pub fn compare_ge<T: Format>(&mut self, a: u64, b: u64) -> bool {
        let r = self.compare::<T>(a, b, true);
        r == 0b0110 << 28 || r == 0b0010 << 28
    }
    pub fn compare_gt<T: Format>(&mut self, a: u64, b: u64) -> bool {
        self.compare::<T>(a, b, true) == 0b0010 << 28
    }

    /// FRINT*: to an integral value with `mode` (SoftFloat's), `exact` raises IXC
    pub fn round_to_int<T: Format>(&mut self, a: u64, mode: u8, exact: bool) -> u64 {
        let a = self.input::<T>(a);
        if is_nan::<T>(a) {
            return self.nan_result::<T>(a);
        }
        let r = if T::BITS == 32 {
            unsafe { f32_roundToInt(a as u32, mode, exact) as u64 }
        }
        else {
            unsafe { f64_roundToInt(a, mode, exact) }
        };
        self.output::<T>(r)
    }

    /// FPToFixed: to a signed or unsigned integer of `int_bits` (32, 64) bits
    /// with `fbits` fraction bits, rounding with `mode`; saturating, NaN to 0
    pub fn to_integer<T: Format>(
        &mut self,
        a: u64,
        signed: bool,
        int_bits: u32,
        fbits: u32,
        mode: u8,
    ) -> u64 {
        let mut a = self.input::<T>(a);
        if fbits != 0 && !is_nan::<T>(a) && !is_inf::<T>(a) && !is_zero::<T>(a) {
            // (an exact scaling: in double precision; the flags of the multiply are not the result's)
            let wide = if T::BITS == 32 { unsafe { f32_to_f64(a as u32) } } else { a };
            let scale = (1023 + fbits as u64) << 52;
            let scaled = unsafe { f64_mul(wide, scale) };
            unsafe { softfloat_exceptionFlags = 0 };
            let r = convert_f64(scaled, signed, int_bits, mode);
            self.flags |= self.take_softfloat();
            return r;
        }
        a = T::to(a);
        let r = if T::BITS == 32 {
            let v = a as u32;
            unsafe {
                match (signed, int_bits) {
                    (true, 32) => f32_to_i32(v, mode, true) as u32 as u64,
                    (false, 32) => f32_to_ui32(v, mode, true) as u64,
                    (true, _) => f32_to_i64(v, mode, true) as u64,
                    (false, _) => f32_to_ui64(v, mode, true),
                }
            }
        }
        else {
            convert_f64(a, signed, int_bits, mode)
        };
        self.flags |= self.take_softfloat();
        r
    }

    /// FPToFixed to a 16-bit integer (AArch32's VCVT to fixed point): the
    /// 32-bit conversion saturated again, Invalid Operation alone when it
    /// saturates; the result in the low 16 bits
    pub fn to_integer16<T: Format>(&mut self, a: u64, signed: bool, fbits: u32, mode: u8) -> u64 {
        let before = self.flags;
        let r = self.to_integer::<T>(a, signed, 32, fbits, mode) as u32;
        let (value, low, high) =
            if signed { (r as i32 as i64, -0x8000, 0x7FFF) } else { (r as i64, 0, 0xFFFF) };
        if value < low || value > high {
            self.flags = before | FPSR_IOC;
            return (if value < low { low } else { high }) as u64 & 0xFFFF;
        }
        value as u64 & 0xFFFF
    }

    /// FixedToFP: a signed or unsigned integer (`int_bits` wide) with `fbits` fraction bits
    pub fn from_integer<T: Format>(
        &mut self,
        value: u64,
        signed: bool,
        int_bits: u32,
        fbits: u32,
    ) -> u64 {
        let r = unsafe {
            match (T::BITS, signed, int_bits) {
                (32, true, 32) => i32_to_f32(value as i32) as u64,
                (32, true, _) => i64_to_f32(value as i64) as u64,
                (32, false, 32) => ui32_to_f32(value as u32) as u64,
                (32, false, _) => ui64_to_f32(value) as u64,
                (_, true, 32) => i32_to_f64(value as i32),
                (_, true, _) => i64_to_f64(value as i64),
                (_, false, 32) => ui32_to_f64(value as u32),
                (_, false, _) => ui64_to_f64(value),
            }
        };
        let r = if fbits != 0 && !is_zero::<T>(r) {
            // (exact: dividing by 2^fbits stays in the normal range here)
            let exponent = (r & T::EXPONENT) >> (T::BITS - 1 - if T::BITS == 32 { 8 } else { 11 });
            let shift = T::BITS - 1 - if T::BITS == 32 { 8 } else { 11 };
            (r & !T::EXPONENT) | (exponent - fbits as u64) << shift
        }
        else {
            r
        };
        self.output::<T>(r)
    }
}

fn convert_f64(v: u64, signed: bool, int_bits: u32, mode: u8) -> u64 {
    unsafe {
        match (signed, int_bits) {
            (true, 32) => f64_to_i32(v, mode, true) as u32 as u64,
            (false, 32) => f64_to_ui32(v, mode, true) as u64,
            (true, _) => f64_to_i64(v, mode, true) as u64,
            (false, _) => f64_to_ui64(v, mode, true),
        }
    }
}

/// The order of two non-NaN values
fn compare_values<T: Format>(a: u64, b: u64) -> core::cmp::Ordering {
    use core::cmp::Ordering::*;
    if is_zero::<T>(a) && is_zero::<T>(b) {
        return Equal;
    }
    let (sa, sb) = (a & T::SIGN != 0, b & T::SIGN != 0);
    let (ma, mb) = (a & !T::SIGN, b & !T::SIGN);
    match (sa, sb) {
        (false, true) => Greater,
        (true, false) => Less,
        (false, false) => ma.cmp(&mb),
        (true, true) => mb.cmp(&ma),
    }
}

/// VFPExpandImm: the 8-bit immediate of FMOV as a single (`n` 32) or double
pub fn expand_imm(imm8: u32, n: u32) -> u64 {
    let sign = (imm8 >> 7 & 1) as u64;
    let b6 = (imm8 >> 6 & 1) as u64;
    let low = (imm8 & 0x3F) as u64;
    if n == 32 {
        // sign : NOT(b6) : b6 x5 : imm8<5:0> : zeros(19)
        sign << 31 | (b6 ^ 1) << 30 | (if b6 != 0 { 0x1F } else { 0 }) << 25 | low << 19
    }
    else {
        sign << 63 | (b6 ^ 1) << 62 | (if b6 != 0 { 0xFF } else { 0 }) << 54 | low << 48
    }
}

// ---- conversions between precisions

impl Fp {
    /// FCVT single to double
    pub fn single_to_double(&mut self, a: u32) -> u64 {
        let a = self.input::<F32>(a as u64) as u32;
        if is_nan::<F32>(a as u64) {
            if is_snan::<F32>(a as u64) {
                self.flags |= FPSR_IOC;
            }
            if self.dn() {
                return F64::DEFAULT_NAN;
            }
            let sign = (a as u64 & F32::SIGN) << 32;
            return sign | F64::EXPONENT | F64::QUIET | ((a as u64 & F32::MANTISSA) << 29);
        }
        let r = unsafe { f32_to_f64(a) };
        self.output::<F64>(r)
    }
    /// FCVT double to single (FCVTXN: `odd`, rounding to odd)
    pub fn double_to_single(&mut self, a: u64, odd: bool) -> u32 {
        let a = self.input::<F64>(a);
        if is_nan::<F64>(a) {
            if is_snan::<F64>(a) {
                self.flags |= FPSR_IOC;
            }
            if self.dn() {
                return F32::DEFAULT_NAN as u32;
            }
            let sign = (a >> 32) as u32 & 0x8000_0000;
            return sign | 0x7FC0_0000 | (a >> 29) as u32 & 0x003F_FFFF;
        }
        let saved = unsafe { softfloat_roundingMode };
        if odd {
            unsafe { softfloat_roundingMode = ROUND_ODD };
        }
        let r = unsafe { f64_to_f32(a) };
        unsafe { softfloat_roundingMode = saved };
        self.output::<F32>(r as u64) as u32
    }

    /// FCVT to half precision from single (`bits` 32) or double; AHP gives
    /// the alternative format (no infinity or NaN). FZ16 is not in v1, so a
    /// half-precision result is never flushed.
    pub fn to_half(&mut self, a: u64, bits: u32) -> u16 {
        let a = if bits == 32 { self.input::<F32>(a) } else { self.input::<F64>(a) };
        let (nan, snan, inf) = if bits == 32 {
            (is_nan::<F32>(a), is_snan::<F32>(a), is_inf::<F32>(a))
        }
        else {
            (is_nan::<F64>(a), is_snan::<F64>(a), is_inf::<F64>(a))
        };
        let sign = if bits == 32 { (a >> 16) as u16 & 0x8000 } else { (a >> 48) as u16 & 0x8000 };
        if self.ahp() {
            if nan {
                self.flags |= FPSR_IOC;
                return sign;
            }
            if inf {
                self.flags |= FPSR_IOC;
                return sign | 0x7FFF;
            }
        }
        else if nan {
            if snan {
                self.flags |= FPSR_IOC;
            }
            if self.dn() {
                return 0x7E00;
            }
            let payload =
                if bits == 32 { (a >> 13) as u16 & 0x01FF } else { (a >> 42) as u16 & 0x01FF };
            return sign | 0x7E00 | payload;
        }
        let convert = |v: u64| unsafe {
            if bits == 32 {
                f32_to_f16(v as u32)
            }
            else {
                f64_to_f16(v)
            }
        };
        let r = convert(a);
        let flags = self.take_softfloat();
        if self.ahp() && flags & FPSR_OFC != 0 {
            // (above IEEE half precision's range: the alternative format has
            // one more exponent; half the value, exact here, converts with
            // the same rounding)
            let one = if bits == 32 { 1 << 23 } else { 1 << 52 };
            let r = convert(a - one);
            let flags = self.take_softfloat();
            if flags & FPSR_OFC != 0 {
                // (overflow: the largest value, Invalid Operation only)
                self.flags |= FPSR_IOC;
                return sign | 0x7FFF;
            }
            self.flags |= flags;
            return r + 0x400;
        }
        self.flags |= flags;
        r
    }

    /// FCVT from half precision to single (`bits` 32) or double
    pub fn from_half(&mut self, h: u16, bits: u32) -> u64 {
        let sign = (h & 0x8000) as u64;
        let exponent = (h >> 10) & 0x1F;
        let mantissa = (h & 0x3FF) as u64;
        if exponent == 0x1F && !self.ahp() {
            if mantissa != 0 {
                let snan = mantissa & 0x200 == 0;
                if snan {
                    self.flags |= FPSR_IOC;
                }
                if self.dn() {
                    return if bits == 32 { F32::DEFAULT_NAN } else { F64::DEFAULT_NAN };
                }
                return if bits == 32 {
                    sign << 16 | F32::EXPONENT | F32::QUIET | mantissa << 13
                }
                else {
                    sign << 48 | F64::EXPONENT | F64::QUIET | mantissa << 42
                };
            }
            return if bits == 32 {
                sign << 16 | F32::EXPONENT
            }
            else {
                sign << 48 | F64::EXPONENT
            };
        }
        if exponent == 0x1F {
            // (AHP: an ordinary value, 2^16 * 1.mantissa)
            return if bits == 32 {
                sign << 16 | (127 + 16) << 23 | mantissa << 13
            }
            else {
                sign << 48 | (1023 + 16) << 52 | mantissa << 42
            };
        }
        // (exact; a half denormal is normal in single and double, and FZ16 is not in v1)
        unsafe {
            if bits == 32 {
                f16_to_f32(h) as u64
            }
            else {
                f16_to_f64(h)
            }
        }
    }
}

// ---- the estimates (FRECPE, FRSQRTE, FRECPX) and the steps (FRECPS, FRSQRTS)

/// RecipEstimate (8-bit) of a scaled mantissa a in [256, 511]
pub fn recip_estimate(a: u32) -> u32 {
    let a = a * 2 + 1;
    let b = (1 << 19) / a;
    (b + 1) / 2
}

/// RecipSqrtEstimate of a scaled mantissa a in [128, 511]
pub fn recip_sqrt_estimate(a: u32) -> u32 {
    let a = if a < 256 { a * 2 + 1 } else { (a >> 1 << 1) * 2 + 2 };
    let mut b = 512u32;
    while a * (b + 1) * (b + 1) < 1 << 28 {
        b += 1;
    }
    (b + 1) / 2
}

impl Fp {
    /// FRECPE
    pub fn recip_estimate<T: Format>(&mut self, a: u64) -> u64 {
        let a = self.input::<T>(a);
        let (exp_bits, mant_bits) = if T::BITS == 32 { (8u32, 23u32) } else { (11, 52) };
        let bias = (1i64 << (exp_bits - 1)) - 1;
        let sign = a & T::SIGN;
        if is_nan::<T>(a) {
            return self.nan_result::<T>(a);
        }
        if is_inf::<T>(a) {
            return sign;
        }
        if is_zero::<T>(a) {
            self.flags |= FPSR_DZC;
            return sign | T::EXPONENT;
        }
        let exponent = ((a & T::EXPONENT) >> mant_bits) as i64;
        let fraction = a & T::MANTISSA;
        // (too small: overflow to infinity or the largest value, by rounding mode)
        let too_small = if T::BITS == 32 {
            a & !T::SIGN < 0x0020_0000
        }
        else {
            a & !T::SIGN < 0x0004_0000_0000_0000
        };
        if too_small {
            self.flags |= FPSR_OFC | FPSR_IXC;
            let rmode = self.fpcr >> 22 & 3;
            let to_infinity = match rmode {
                0 => true,
                1 => sign == 0,
                2 => sign != 0,
                _ => false,
            };
            return if to_infinity {
                sign | T::EXPONENT
            }
            else {
                sign | (T::EXPONENT - (1 << mant_bits)) | T::MANTISSA
            };
        }
        // (too large: the result is below the normal range; FZ flushes it)
        if self.fz() && exponent >= 2 * bias - 1 {
            self.flags |= FPSR_UFC;
            return sign;
        }
        // (the scaled mantissa: 9 bits with the leading one)
        let (mut exp, mut frac) = (exponent, fraction);
        if exp == 0 {
            if frac >> (mant_bits - 1) == 0 {
                exp = -1;
                frac = frac << 2 & T::MANTISSA;
            }
            else {
                frac = frac << 1 & T::MANTISSA;
            }
        }
        let scaled = (1 << 8) | (frac >> (mant_bits - 8)) as u32;
        let estimate = recip_estimate(scaled) as u64;
        let result_exp = 2 * bias - 1 - exp;
        let mut result_frac = (estimate & 0xFF) << (mant_bits - 8);
        let mut result_exp = result_exp;
        if result_exp == 0 {
            result_frac = (1 << (mant_bits - 1)) | result_frac >> 1;
        }
        else if result_exp == -1 {
            result_frac = (1 << (mant_bits - 2)) | result_frac >> 2;
            result_exp = 0;
        }
        sign | (result_exp as u64) << mant_bits | result_frac
    }

    /// FRSQRTE
    pub fn recip_sqrt_estimate<T: Format>(&mut self, a: u64) -> u64 {
        let a = self.input::<T>(a);
        let (exp_bits, mant_bits) = if T::BITS == 32 { (8u32, 23u32) } else { (11, 52) };
        let bias = (1i64 << (exp_bits - 1)) - 1;
        let sign = a & T::SIGN;
        if is_nan::<T>(a) {
            return self.nan_result::<T>(a);
        }
        if is_zero::<T>(a) {
            self.flags |= FPSR_DZC;
            return sign | T::EXPONENT;
        }
        if sign != 0 {
            self.flags |= FPSR_IOC;
            return T::DEFAULT_NAN;
        }
        if is_inf::<T>(a) {
            return 0;
        }
        let (mut exp, mut frac) = (((a & T::EXPONENT) >> mant_bits) as i64, a & T::MANTISSA);
        if exp == 0 {
            while frac >> (mant_bits - 1) & 1 == 0 {
                frac <<= 1;
                exp -= 1;
            }
            frac = frac << 1 & T::MANTISSA;
        }
        let scaled = if exp & 1 == 0 {
            (1 << 8) | (frac >> (mant_bits - 8)) as u32
        }
        else {
            (1 << 7) | (frac >> (mant_bits - 7)) as u32
        };
        let estimate = recip_sqrt_estimate(scaled) as u64;
        let result_exp = (3 * bias - 1 - exp) / 2;
        sign | (result_exp as u64) << mant_bits | (estimate & 0xFF) << (mant_bits - 8)
    }

    /// FRECPX: the exponent inverted, the mantissa zero
    pub fn recip_exponent<T: Format>(&mut self, a: u64) -> u64 {
        let a = self.input::<T>(a);
        if is_nan::<T>(a) {
            return self.nan_result::<T>(a);
        }
        let sign = a & T::SIGN;
        let exponent = a & T::EXPONENT;
        if exponent == 0 {
            // (zero and denormals: the largest exponent below infinity)
            return sign | (T::EXPONENT - (T::EXPONENT & T::EXPONENT.wrapping_neg()));
        }
        sign | (!exponent & T::EXPONENT)
    }

    /// FRECPS: 2 - op1 * op2 (inf * 0 gives 2), fused
    pub fn recip_step<T: Format>(&mut self, a: u64, b: u64) -> u64 { self.step::<T>(a, b, false) }
    /// FRSQRTS: (3 - op1 * op2) / 2 (inf * 0 gives 1.5), fused
    pub fn recip_sqrt_step<T: Format>(&mut self, a: u64, b: u64) -> u64 {
        self.step::<T>(a, b, true)
    }

    fn step<T: Format>(&mut self, a: u64, b: u64, sqrt: bool) -> u64 {
        // (op1 is negated first, NaN included)
        let (a, b) = (self.input::<T>(a) ^ T::SIGN, self.input::<T>(b));
        if let Some(nan) = self.process_nans::<T>(a, b) {
            return nan;
        }
        let (one_half, two, three_halves, three) = if T::BITS == 32 {
            (
                0x3F00_0000u64,
                0x4000_0000u64,
                0x3FC0_0000u64,
                0x4040_0000u64,
            )
        }
        else {
            (
                0x3FE0_0000_0000_0000,
                0x4000_0000_0000_0000,
                0x3FF8_0000_0000_0000,
                0x4008_0000_0000_0000,
            )
        };
        if (is_inf::<T>(a) && is_zero::<T>(b)) || (is_zero::<T>(a) && is_inf::<T>(b)) {
            return if sqrt { three_halves } else { two };
        }
        if is_inf::<T>(a) || is_inf::<T>(b) {
            return (a ^ b) & T::SIGN | T::EXPONENT;
        }
        let fma = |n: u64, m: u64, c: u64| {
            if T::BITS == 32 {
                unsafe { f32_mulAdd(n as u32, m as u32, c as u32) as u64 }
            }
            else {
                unsafe { f64_mulAdd(n, m, c) }
            }
        };
        if !sqrt {
            let r = fma(a, b, two);
            return self.output::<T>(r);
        }
        // (3 + op1 * op2) / 2, rounded once: halve the larger operand when
        // that is exact (an exponent above 1), else op1 * op2 is so small
        // that the sum is near 3 and halving it is exact
        let one = T::EXPONENT & T::EXPONENT.wrapping_neg();
        let (larger, other) = if a & !T::SIGN >= b & !T::SIGN { (a, b) } else { (b, a) };
        let r = if larger & T::EXPONENT > one {
            fma(larger - one, other, three_halves)
        }
        else {
            let r = fma(a, b, three);
            if T::BITS == 32 {
                unsafe { f32_mul(r as u32, one_half as u32) as u64 }
            }
            else {
                unsafe { f64_mul(r, one_half) }
            }
        };
        self.output::<T>(r)
    }
}
