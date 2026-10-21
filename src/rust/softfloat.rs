extern "C" {
    fn extF80M_add(x: *const F80, y: *const F80, ptr: *mut F80);
    fn extF80M_sub(x: *const F80, y: *const F80, ptr: *mut F80);
    fn extF80M_mul(x: *const F80, y: *const F80, ptr: *mut F80);
    fn extF80M_div(x: *const F80, y: *const F80, ptr: *mut F80);
    //fn extF80M_rem(x: *const F80, y: *const F80, ptr: *mut F80);
    fn extF80M_sqrt(x: *const F80, ptr: *mut F80);

    fn extF80M_roundToInt(x: *const F80, rounding_mode: u8, raise_inexact: bool, dst: *mut F80);

    fn extF80M_eq(x: *const F80, y: *const F80) -> bool;
    //fn extF80M_eq_signaling(x: *const F80, y: *const F80) -> bool;

    //fn extF80M_le(x: *const F80, y: *const F80) -> bool;
    //fn extF80M_le_quiet(x: *const F80, y: *const F80) -> bool;
    fn extF80M_lt(x: *const F80, y: *const F80) -> bool;
    fn extF80M_lt_quiet(x: *const F80, y: *const F80) -> bool;

    fn extF80M_to_i32(src: *const F80, rounding_mode: u8, raise_inexact: bool) -> i32;
    fn extF80M_to_i64(src: *const F80, rounding_mode: u8, raise_inexact: bool) -> i64;
    #[allow(dead_code)] // Reference entry point used by differential tests.
    fn i32_to_extF80M(src: i32, dst: *mut F80);
    #[allow(dead_code)] // Reference entry point used by differential tests.
    fn i64_to_extF80M(src: i64, dst: *mut F80);

    fn f32_to_extF80M(src: i32, dst: *mut F80);
    fn f64_to_extF80M(src: u64, dst: *mut F80);
    fn extF80M_to_f32(src: *const F80) -> i32;
    fn extF80M_to_f64(src: *const F80) -> u64;

    static mut softfloat_roundingMode: u8;
    static mut extF80_roundingPrecision: u8;
    static mut softfloat_exceptionFlags: u8;
}

pub enum RoundingMode {
    NearEven,
    Trunc,
    Floor,
    Ceil,
}

// Host execution policy, deliberately outside the serialized guest FPU state.
// CPU.init selects the browser/API option; standalone arithmetic tests start
// in compatible mode. Changing this helper policy does not invalidate JIT code.
static mut X87_FAST_MATH: bool = false;
// The CPU derives its generated-code x87 policy from this flag (see cpu::fpu).
static mut X87_POLICY_OBSERVER: Option<unsafe fn()> = None;

#[no_mangle]
pub unsafe fn set_x87_fast_math(enabled: bool) {
    X87_FAST_MATH = enabled;
    if let Some(observer) = X87_POLICY_OBSERVER {
        observer();
    }
}
pub unsafe fn set_x87_policy_observer(observer: unsafe fn()) {
    X87_POLICY_OBSERVER = Some(observer);
}

/// The host arithmetic policy: native f64 (set_x87_fast_math) or compatible
#[inline(always)]
pub fn x87_fast_math() -> bool { unsafe { X87_FAST_MATH } }

#[no_mangle]
pub fn get_x87_fast_math() -> bool { x87_fast_math() }

/// The path an F80 operation took, in the profiler's statistics (the
/// profiler feature only; tests/rust/x87_fast_path.mjs)
#[inline(always)]
pub fn count_x87_path(path: crate::profiler::stat) { crate::profiler::stat_increment(path); }

pub enum Precision {
    P80,
    P64,
    P32,
}

#[repr(C)]
#[derive(Copy, Clone)]
pub struct F80 {
    pub mantissa: u64,
    pub sign_exponent: u16,
}
impl F80 {
    pub const ZERO: F80 = F80 {
        mantissa: 0,
        sign_exponent: 0,
    };
    pub const ONE: F80 = F80 {
        mantissa: 0x8000000000000000,
        sign_exponent: 0x3FFF,
    };
    pub const LN_10: F80 = F80 {
        mantissa: 0x935D8DDDAAA8B000,
        sign_exponent: 0x4000,
    };
    pub const LN_2: F80 = F80 {
        mantissa: 0xB17217F7D1CF7800,
        sign_exponent: 0x3FFE,
    };
    pub const PI: F80 = F80 {
        mantissa: 0xC90FDAA22168C000,
        sign_exponent: 0x4000,
    };
    pub const LOG2_E: F80 = F80 {
        mantissa: 0xB8AA3B295C17F000,
        sign_exponent: 0x3FFF,
    };
    pub const INDEFINITE_NAN: F80 = F80 {
        mantissa: 0xC000000000000000,
        sign_exponent: 0x7FFF,
    };
    pub const POS_INFINITY: F80 = F80 {
        mantissa: 0x8000000000000000,
        sign_exponent: 0x7FFF,
    };
    pub const NEG_INFINITY: F80 = F80 {
        mantissa: 0x8000000000000000,
        sign_exponent: 0xFFFF,
    };

    pub fn sign(&self) -> bool { (self.sign_exponent >> 15) == 1 }
    pub fn exponent(&self) -> i16 { (self.sign_exponent as i16 & 0x7FFF) - 0x3FFF }

    #[inline]
    pub fn of_i32(src: i32) -> F80 { Self::of_i64(src as i64) }
    #[inline]
    pub fn of_i64(src: i64) -> F80 {
        if src == 0 {
            return Self::ZERO;
        }
        let magnitude = src.unsigned_abs();
        let shift = magnitude.leading_zeros();
        F80 {
            mantissa: magnitude << shift,
            sign_exponent: (if src < 0 { 0x8000 } else { 0 }) | (0x403E - shift as u16),
        }
    }

    #[inline]
    pub fn of_f32(src: i32) -> F80 {
        let bits = src as u32;
        let exponent = (bits >> 23) & 0xFF;
        let fraction = bits & 0x7FFFFF;
        let sign = ((bits >> 16) & 0x8000) as u16;
        // Widening finite binary32 is exact in F80, including subnormals.
        // Do not clear sticky flags here: the x87 wrapper owns that operation.
        if exponent != 0 && exponent != 0xFF {
            return F80 {
                mantissa: ((fraction | 0x800000) as u64) << 40,
                sign_exponent: sign | (exponent as u16 + 0x3F80),
            };
        }
        if exponent == 0 {
            if fraction == 0 {
                return F80 {
                    mantissa: 0,
                    sign_exponent: sign,
                };
            }
            let shift = fraction.leading_zeros() - 8;
            return F80 {
                mantissa: ((fraction << shift) as u64) << 40,
                sign_exponent: sign | (0x3F81 - shift as u16),
            };
        }
        // Preserve SoftFloat's signaling-NaN flags and payload conversion.
        let mut x = F80::ZERO;
        unsafe { f32_to_extF80M(src, &mut x) };
        x
    }

    #[inline]
    pub fn of_f64(src: u64) -> F80 {
        let exponent = (src >> 52) & 0x7FF;
        let fraction = src & 0xFFFFFFFFFFFFF;
        let sign = ((src >> 48) & 0x8000) as u16;
        if exponent != 0 && exponent != 0x7FF {
            return F80 {
                mantissa: (fraction | 0x10000000000000) << 11,
                sign_exponent: sign | (exponent as u16 + 0x3C00),
            };
        }
        if exponent == 0 {
            if fraction == 0 {
                return F80 {
                    mantissa: 0,
                    sign_exponent: sign,
                };
            }
            let shift = fraction.leading_zeros() - 11;
            return F80 {
                mantissa: fraction << (shift + 11),
                sign_exponent: sign | (0x3C01 - shift as u16),
            };
        }
        let mut x = F80::ZERO;
        unsafe { f64_to_extF80M(src, &mut x) };
        x
    }
    fn of_f64x(src: f64) -> F80 { F80::of_f64(f64::to_bits(src)) }

    #[inline]
    pub fn to_f32(&self) -> i32 {
        let exponent = self.sign_exponent & 0x7FFF;
        let sign = ((self.sign_exponent as u32) & 0x8000) << 16;
        if exponent == 0 && self.mantissa == 0 {
            return sign as i32;
        }
        // Common normal-to-normal conversion. Round the original 64-bit
        // significand once; a host f64 intermediate could double-round.
        if (0x3F81..=0x407E).contains(&exponent) && self.mantissa >> 63 != 0 {
            let mut significand = (self.mantissa >> 40) as u32;
            let remainder = self.mantissa & 0xFFFFFFFFFF;
            let increment = match unsafe { softfloat_roundingMode } {
                0 => remainder > 0x8000000000 || remainder == 0x8000000000 && significand & 1 != 0,
                1 => false,
                2 => sign != 0 && remainder != 0,
                3 => sign == 0 && remainder != 0,
                _ => return unsafe { extF80M_to_f32(self) },
            };
            significand += increment as u32;
            // Adding the explicit integer bit to exponent - 1 also handles
            // a rounded significand carry. Overflow must use the reference.
            let magnitude = ((exponent as u32 - 0x3F81) << 23) + significand;
            if magnitude < 0x7F800000 {
                if remainder != 0 {
                    unsafe {
                        softfloat_exceptionFlags |= 1;
                    }
                }
                return (sign | magnitude) as i32;
            }
        }
        // Subnormal results, overflow, NaNs and noncanonical F80 encodings.
        unsafe { extF80M_to_f32(self) }
    }
    #[inline]
    pub fn to_f64(&self) -> u64 {
        let exponent = self.sign_exponent & 0x7FFF;
        let sign = ((self.sign_exponent as u64) & 0x8000) << 48;
        if exponent == 0 && self.mantissa == 0 {
            return sign;
        }
        if (0x3C01..=0x43FE).contains(&exponent) && self.mantissa >> 63 != 0 {
            let mut significand = self.mantissa >> 11;
            let remainder = self.mantissa & 0x7FF;
            // Exact normal stores cannot round, overflow or raise an exception.
            // In particular, FLD m64 followed by FST(P) m64 reaches this case:
            // avoid reading and dispatching on the rounding mode for it.
            if remainder == 0 {
                return sign | ((exponent as u64 - 0x3C01) << 52) + significand;
            }
            let increment = match unsafe { softfloat_roundingMode } {
                0 => remainder > 0x400 || remainder == 0x400 && significand & 1 != 0,
                1 => false,
                2 => sign != 0 && remainder != 0,
                3 => sign == 0 && remainder != 0,
                _ => return unsafe { extF80M_to_f64(self) },
            };
            significand += increment as u64;
            let magnitude = ((exponent as u64 - 0x3C01) << 52) + significand;
            if magnitude < 0x7FF0000000000000 {
                if remainder != 0 {
                    unsafe {
                        softfloat_exceptionFlags |= 1;
                    }
                }
                return sign | magnitude;
            }
        }
        unsafe { extF80M_to_f64(self) }
    }
    fn to_f64x(&self) -> f64 { f64::from_bits(self.to_f64()) }

    #[inline]
    fn normal_to_integer(&self, rounding: u8) -> Option<i64> {
        let exponent = self.sign_exponent & 0x7FFF;
        if exponent == 0 && self.mantissa == 0 {
            return Some(0);
        }
        if exponent == 0 || exponent >= 0x403F || self.mantissa >> 63 == 0 {
            return None;
        }
        let power = exponent as i32 - 0x3FFF;
        let (mut magnitude, nonzero, above_half, tie) = if power >= 0 {
            let shift = 63 - power as u32;
            if shift == 0 {
                (self.mantissa, false, false, false)
            }
            else {
                let remainder = self.mantissa & ((1u64 << shift) - 1);
                let half = 1u64 << (shift - 1);
                (
                    self.mantissa >> shift,
                    remainder != 0,
                    remainder > half,
                    remainder == half,
                )
            }
        }
        else {
            (
                0,
                true,
                power == -1 && self.mantissa > 1 << 63,
                power == -1 && self.mantissa == 1 << 63,
            )
        };
        let increment = match rounding {
            0 => above_half || tie && magnitude & 1 != 0,
            1 => false,
            2 => self.sign() && nonzero,
            3 => !self.sign() && nonzero,
            _ => return None,
        };
        magnitude = magnitude.checked_add(increment as u64)?;
        if self.sign() {
            if magnitude > 1 << 63 {
                return None;
            }
            Some((magnitude as i64).wrapping_neg())
        }
        else {
            i64::try_from(magnitude).ok()
        }
    }
    pub fn to_i32(&self) -> i32 {
        let rounding = unsafe { softfloat_roundingMode };
        if let Some(value) = self
            .normal_to_integer(rounding)
            .and_then(|x| i32::try_from(x).ok())
        {
            return value;
        }
        unsafe { extF80M_to_i32(self, rounding, false) }
    }
    pub fn to_i64(&self) -> i64 {
        let rounding = unsafe { softfloat_roundingMode };
        if let Some(value) = self.normal_to_integer(rounding) {
            return value;
        }
        unsafe { extF80M_to_i64(self, rounding, false) }
    }
    pub fn truncate_to_i32(&self) -> i32 {
        if let Some(value) = self
            .normal_to_integer(1)
            .and_then(|x| i32::try_from(x).ok())
        {
            return value;
        }
        unsafe { extF80M_to_i32(self, 1, false) }
    }
    pub fn truncate_to_i64(&self) -> i64 {
        if let Some(value) = self.normal_to_integer(1) {
            return value;
        }
        unsafe { extF80M_to_i64(self, 1, false) }
    }

    pub fn cos(self) -> F80 { F80::of_f64x(self.to_f64x().cos()) }
    pub fn sin(self) -> F80 { F80::of_f64x(self.to_f64x().sin()) }
    pub fn tan(self) -> F80 { F80::of_f64x(self.to_f64x().tan()) }
    pub fn atan(self) -> F80 { F80::of_f64x(self.to_f64x().atan()) }
    pub fn atan2(self, other: F80) -> F80 { F80::of_f64x(self.to_f64x().atan2(other.to_f64x())) }

    pub fn log2(self) -> F80 { F80::of_f64x(self.to_f64x().log2()) }
    pub fn ln(self) -> F80 {
        // Transcendentals currently round through binary64. Keep that conversion
        // (and its SoftFloat exception flags), but never pass a NaN to the host
        // logarithm: Wasm arithmetic may change its sign/payload between tiers.
        let bits = self.to_f64();
        let magnitude = bits & 0x7FFFFFFFFFFFFFFF;
        if magnitude > 0x7FF0000000000000 {
            return F80::of_f64(bits);
        }
        if magnitude == 0 {
            return F80::NEG_INFINITY;
        }
        if bits >> 63 != 0 {
            // Same default indefinite encoding as the bundled SoftFloat. The
            // old host logarithm did not set SoftFloat's invalid-operation flag.
            return F80 {
                mantissa: 0xC000000000000000,
                sign_exponent: 0xFFFF,
            };
        }
        if magnitude == 0x7FF0000000000000 {
            return F80::POS_INFINITY;
        }
        F80::of_f64x(f64::from_bits(bits).ln())
    }

    pub fn abs(self) -> F80 {
        F80 {
            mantissa: self.mantissa,
            sign_exponent: self.sign_exponent & !0x8000,
        }
    }
    pub fn two_pow(self) -> F80 { F80::of_f64x(2.0f64.powf(self.to_f64x())) }
    pub fn round(self) -> F80 {
        let mut result = F80::ZERO;
        unsafe { extF80M_roundToInt(&self, softfloat_roundingMode, false, &mut result) };
        result
    }
    pub fn trunc(self) -> F80 {
        let mut result = F80::ZERO;
        unsafe { extF80M_roundToInt(&self, 1, false, &mut result) };
        result
    }

    /// Common FSCALE exponents have an exact normal binary64 power of two.
    /// Construct that F80 operand directly, preserving the original multiply
    /// (including precision control, rounding and exception handling).
    pub fn scale(self, exponent: F80) -> F80 {
        if let Some(shift) = exponent.normal_to_integer(1) {
            if (-1022..=1023).contains(&shift) {
                return self
                    * F80 {
                        mantissa: 1 << 63,
                        sign_exponent: (0x3FFF + shift) as u16,
                    };
            }
        }
        self * exponent.trunc().two_pow()
    }

    pub fn sqrt(self) -> F80 {
        if unsafe { extF80_roundingPrecision } != 80 {
            if let Some(result) = self.native_sqrt() {
                return result;
            }
        }
        let mut result = F80::ZERO;
        unsafe { extF80M_sqrt(&self, &mut result) };
        result
    }

    pub fn is_finite(self) -> bool {
        // TODO: Can probably be done more efficiently
        self != F80::POS_INFINITY && self != F80::NEG_INFINITY
    }
    pub fn is_nan(self) -> bool {
        // TODO: Can probably be done more efficiently
        self != self
    }

    pub fn set_rounding_mode(mode: RoundingMode) {
        unsafe {
            softfloat_roundingMode = match mode {
                RoundingMode::NearEven => 0,
                RoundingMode::Trunc => 1,
                RoundingMode::Floor => 2,
                RoundingMode::Ceil => 3,
            }
        };
    }
    pub fn set_precision(precision: Precision) {
        unsafe {
            extF80_roundingPrecision = match precision {
                Precision::P80 => 80,
                Precision::P64 => 64,
                Precision::P32 => 32,
            }
        };
    }

    pub fn get_exception_flags() -> u8 {
        let f = unsafe { softfloat_exceptionFlags };
        // translate softfloat's flags to x87 status flags
        f >> 4 & 1 | f >> 1 & 4 | f << 3 & 16
    }
    pub fn clear_exception_flags() { unsafe { softfloat_exceptionFlags = 0 } }

    // These paths do integer significand arithmetic, not a conversion to f64.
    // Accept only canonical normal inputs and exact normal results at the
    // current precision. No rounding or exception-flag updates are then needed.
    #[inline]
    fn normal_exponent(self) -> Option<i32> {
        let exponent = (self.sign_exponent & 0x7FFF) as i32;
        if exponent > 0 && exponent < 0x7FFF && self.mantissa >> 63 != 0 {
            Some(exponent)
        }
        else {
            None
        }
    }

    #[inline]
    fn exact_normal(mantissa: u64, exponent: i32, sign: u16) -> Option<F80> {
        if exponent <= 0 || exponent >= 0x7FFF {
            return None;
        }
        let discarded = match unsafe { extF80_roundingPrecision } {
            80 => 0,
            64 => 0x7FF,
            32 => 0xFFFFFFFFFF,
            _ => return None,
        };
        if mantissa & discarded != 0 {
            return None;
        }
        Some(F80 {
            mantissa,
            sign_exponent: sign | exponent as u16,
        })
    }

    #[inline(always)]
    fn exact_mul(self, other: F80) -> Option<F80> {
        // Two at-most-32-bit significands have an exact 64-bit product. This
        // includes values loaded from binary32, across the full x87 exponent range.
        if (self.mantissa | other.mantissa) & 0xFFFFFFFF != 0 {
            return None;
        }
        let exponent = self.normal_exponent()? + other.normal_exponent()? - 0x3FFF;
        let product = (self.mantissa >> 32) * (other.mantissa >> 32);
        let shift = product.leading_zeros(); // 0 or 1 for canonical normal inputs
        F80::exact_normal(
            product << shift,
            exponent + 1 - shift as i32,
            (self.sign_exponent ^ other.sign_exponent) & 0x8000,
        )
    }

    #[inline(always)]
    fn exact_add(self, other: F80) -> Option<F80> {
        // A cheap rejection for extended-precision intermediates. Binary32
        // inputs (and other short significands) can be aligned exactly here.
        if (self.mantissa | other.mantissa) & 0xFFFFFFFF != 0 {
            return None;
        }
        let ae = self.normal_exponent()?;
        let be = other.normal_exponent()?;
        let (big, small, exponent, distance) = if (ae, self.mantissa) >= (be, other.mantissa) {
            (self, other, ae, ae - be)
        }
        else {
            (other, self, be, be - ae)
        };
        if distance > 32 {
            return None;
        }
        // The low 32 bits are zero, so alignment loses no bits for this range.
        let aligned = small.mantissa >> distance;
        let sign = big.sign_exponent & 0x8000;
        if (big.sign_exponent ^ small.sign_exponent) & 0x8000 == 0 {
            let (sum, carry) = big.mantissa.overflowing_add(aligned);
            if carry {
                if sum & 1 != 0 {
                    return None;
                }
                F80::exact_normal((sum >> 1) | (1 << 63), exponent + 1, sign)
            }
            else {
                F80::exact_normal(sum, exponent, sign)
            }
        }
        else {
            let difference = big.mantissa - aligned;
            if difference == 0 {
                return Some(F80 {
                    mantissa: 0,
                    sign_exponent: if unsafe { softfloat_roundingMode } == 2 { 0x8000 } else { 0 },
                });
            }
            let shift = difference.leading_zeros();
            F80::exact_normal(difference << shift, exponent - shift as i32, sign)
        }
    }

    #[inline]
    fn finite_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        use std::cmp::Ordering;
        let ae = self.sign_exponent & 0x7FFF;
        let be = other.sign_exponent & 0x7FFF;
        // The bundled SoftFloat extF80[_M]_lt/eq order finite encodings by
        // sign/exponent/significand, without normalizing even noncanonical
        // inputs. Preserve that behavior; special exponents still go through
        // SoftFloat for quiet/signaling NaN flags.
        if ae == 0x7FFF || be == 0x7FFF {
            return None;
        }
        if self.sign() != other.sign() {
            if (ae | be) == 0 && (self.mantissa | other.mantissa) == 0 {
                return Some(Ordering::Equal);
            }
            return Some(if self.sign() { Ordering::Less } else { Ordering::Greater });
        }
        let order = (ae, self.mantissa).cmp(&(be, other.mantissa));
        Some(if self.sign() { order.reverse() } else { order })
    }

    #[inline(always)]
    fn exact_div(self, other: F80) -> Option<F80> {
        if other.mantissa != 0x8000000000000000 {
            return None;
        }
        let exponent = self.normal_exponent()? - other.normal_exponent()? + 0x3FFF;
        F80::exact_normal(
            self.mantissa,
            exponent,
            (self.sign_exponent ^ other.sign_exponent) & 0x8000,
        )
    }

    #[inline(never)]
    fn native_sqrt(self) -> Option<F80> {
        if self.sign() || unsafe { softfloat_roundingMode } != 0 {
            return None;
        }
        let exponent = self.normal_exponent()? as u32;
        let result = match unsafe { extF80_roundingPrecision } {
            64 => {
                if self.mantissa & 0x7FF != 0 || !(0x3C01..=0x43FE).contains(&exponent) {
                    return None;
                }
                let bits =
                    ((exponent as u64 - 0x3C00) << 52) | ((self.mantissa >> 11) & 0xFFFFFFFFFFFFF);
                Self::of_f64(f64::from_bits(bits).sqrt().to_bits())
            },
            32 => {
                if self.mantissa & 0xFFFFFFFFFF != 0 || !(0x3F81..=0x407E).contains(&exponent) {
                    return None;
                }
                let bits = ((exponent - 0x3F80) << 23) | ((self.mantissa >> 40) as u32 & 0x7FFFFF);
                Self::of_f32(f32::from_bits(bits).sqrt().to_bits() as i32)
            },
            _ => return None,
        };
        // An exact square root of a <=53-bit binary significand has <=27
        // significant bits. The existing exact integer multiplication can
        // therefore prove exactness without a rounded host multiplication.
        if !result.exact_mul(result).is_some_and(|square| {
            square.mantissa == self.mantissa && square.sign_exponent == self.sign_exponent
        }) {
            unsafe {
                softfloat_exceptionFlags |= 1;
            }
        }
        Some(result)
    }

    // Native division rounds directly to the requested reduced precision.
    // Both inputs must be exact in that format and the result must remain
    // normal. Full extended precision and other rounding modes use SoftFloat.
    #[inline(never)]
    fn native_div(self, other: F80) -> Option<F80> {
        if unsafe { softfloat_roundingMode } != 0 {
            return None;
        }
        let ae = self.normal_exponent()? as u32;
        let be = other.normal_exponent()? as u32;
        let result = match unsafe { extF80_roundingPrecision } {
            64 => {
                if (self.mantissa | other.mantissa) & 0x7FF != 0
                    || !(0x3C01..=0x43FE).contains(&ae)
                    || !(0x3C01..=0x43FE).contains(&be)
                {
                    return None;
                }
                let a = ((self.sign_exponent as u64 & 0x8000) << 48)
                    | ((ae as u64 - 0x3C00) << 52)
                    | ((self.mantissa >> 11) & 0xFFFFFFFFFFFFF);
                let b = ((other.sign_exponent as u64 & 0x8000) << 48)
                    | ((be as u64 - 0x3C00) << 52)
                    | ((other.mantissa >> 11) & 0xFFFFFFFFFFFFF);
                let bits = (f64::from_bits(a) / f64::from_bits(b)).to_bits();
                let exponent = bits >> 52 & 0x7FF;
                if exponent == 0 || exponent == 0x7FF {
                    return None;
                }
                Self::of_f64(bits)
            },
            32 => {
                if (self.mantissa | other.mantissa) & 0xFFFFFFFFFF != 0
                    || !(0x3F81..=0x407E).contains(&ae)
                    || !(0x3F81..=0x407E).contains(&be)
                {
                    return None;
                }
                let a = ((self.sign_exponent as u32 & 0x8000) << 16)
                    | ((ae - 0x3F80) << 23)
                    | ((self.mantissa >> 40) as u32 & 0x7FFFFF);
                let b = ((other.sign_exponent as u32 & 0x8000) << 16)
                    | ((be - 0x3F80) << 23)
                    | ((other.mantissa >> 40) as u32 & 0x7FFFFF);
                let bits = (f32::from_bits(a) / f32::from_bits(b)).to_bits();
                let exponent = bits >> 23 & 0xFF;
                if exponent == 0 || exponent == 0xFF {
                    return None;
                }
                Self::of_f32(bits as i32)
            },
            _ => return None,
        };
        let odd_divisor = other.mantissa >> other.mantissa.trailing_zeros();
        if self.mantissa % odd_divisor != 0 {
            unsafe {
                softfloat_exceptionFlags |= 1;
            }
        }
        Some(result)
    }

    #[inline]
    pub fn partial_cmp_quiet(&self, other: &Self) -> Option<std::cmp::Ordering> {
        if let Some(order) = self.finite_cmp(other) {
            return Some(order);
        }
        if unsafe { extF80M_lt_quiet(self, other) } {
            Some(std::cmp::Ordering::Less)
        }
        else if unsafe { extF80M_lt_quiet(other, self) } {
            Some(std::cmp::Ordering::Greater)
        }
        else if self == other {
            Some(std::cmp::Ordering::Equal)
        }
        else {
            None
        }
    }
}

impl std::ops::Add for F80 {
    type Output = F80;
    #[inline(always)]
    fn add(self, other: Self) -> Self {
        if unsafe { X87_FAST_MATH } {
            count_x87_path(crate::profiler::stat::X87_NATIVE_F64);
            return F80::of_f64x(self.to_f64x() + other.to_f64x());
        }
        if let Some(result) = self.exact_add(other) {
            count_x87_path(crate::profiler::stat::X87_EXACT);
            return result;
        }
        count_x87_path(crate::profiler::stat::X87_SOFTFLOAT);
        let mut result = F80::ZERO;
        unsafe { extF80M_add(&self, &other, &mut result) };
        result
    }
}
impl std::ops::Sub for F80 {
    type Output = F80;
    #[inline(always)]
    fn sub(self, other: Self) -> Self {
        if unsafe { X87_FAST_MATH } {
            count_x87_path(crate::profiler::stat::X87_NATIVE_F64);
            return F80::of_f64x(self.to_f64x() - other.to_f64x());
        }
        if let Some(result) = self.exact_add(-other) {
            count_x87_path(crate::profiler::stat::X87_EXACT);
            return result;
        }
        count_x87_path(crate::profiler::stat::X87_SOFTFLOAT);
        let mut result = F80::ZERO;
        unsafe { extF80M_sub(&self, &other, &mut result) };
        result
    }
}
impl std::ops::Neg for F80 {
    type Output = F80;
    fn neg(self) -> Self {
        let mut result = self;
        result.sign_exponent ^= 1 << 15;
        result
    }
}
impl std::ops::Mul for F80 {
    type Output = F80;
    #[inline(always)]
    fn mul(self, other: Self) -> Self {
        if unsafe { X87_FAST_MATH } {
            count_x87_path(crate::profiler::stat::X87_NATIVE_F64);
            return F80::of_f64x(self.to_f64x() * other.to_f64x());
        }
        if let Some(result) = self.exact_mul(other) {
            count_x87_path(crate::profiler::stat::X87_EXACT);
            return result;
        }
        count_x87_path(crate::profiler::stat::X87_SOFTFLOAT);
        let mut result = F80::ZERO;
        unsafe { extF80M_mul(&self, &other, &mut result) };
        result
    }
}
impl std::ops::Div for F80 {
    type Output = F80;
    #[inline(always)]
    fn div(self, other: Self) -> Self {
        if unsafe { X87_FAST_MATH } {
            count_x87_path(crate::profiler::stat::X87_NATIVE_F64);
            return F80::of_f64x(self.to_f64x() / other.to_f64x());
        }
        if let Some(result) = self.exact_div(other) {
            count_x87_path(crate::profiler::stat::X87_EXACT);
            return result;
        }
        let mut result = F80::ZERO;
        if unsafe { extF80_roundingPrecision } != 80 {
            if let Some(value) = self.native_div(other) {
                count_x87_path(crate::profiler::stat::X87_EXACT);
                return value;
            }
        }
        count_x87_path(crate::profiler::stat::X87_SOFTFLOAT);
        unsafe { extF80M_div(&self, &other, &mut result) };
        result
    }
}
impl std::ops::Rem for F80 {
    type Output = F80;
    fn rem(self, other: Self) -> Self {
        let quot = (self / other).trunc();
        self - quot * other
        // Uses round-to-nearest instead of truncation
        //let mut result = F80::ZERO;
        //unsafe {
        //    extF80M_rem(&self, &other, &mut result)
        //};
        //result
    }
}

impl PartialEq for F80 {
    fn eq(&self, other: &Self) -> bool { unsafe { extF80M_eq(self, other) } }
}
impl PartialOrd for F80 {
    #[inline]
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        if let Some(order) = self.finite_cmp(other) {
            return Some(order);
        }
        if unsafe { extF80M_lt(self, other) } {
            Some(std::cmp::Ordering::Less)
        }
        else if unsafe { extF80M_lt(other, self) } {
            Some(std::cmp::Ordering::Greater)
        }
        else if self == other {
            Some(std::cmp::Ordering::Equal)
        }
        else {
            None
        }
    }
}
