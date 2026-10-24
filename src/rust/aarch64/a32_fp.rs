//! AArch32's floating point at EL0 (docs/aarch32-plan.md Q4.1, Q4.4):
//! VFPv4 as ARMv8 has it (no short vectors, no half-precision arithmetic),
//! on fp.rs's SoftFloat environment. S0-S31, D0-D31 and Q0-Q15 are views
//! of V0-V15 (S n: bits 32(n%4) of V n/4; D n: half n%2 of V n/2), and an
//! AArch32 write leaves the rest of the V register as it was. FPSCR is
//! FPSR's NZCV, QC and cumulative flags with FPCR's AHP, DN, FZ and RMode;
//! Len and Stride read as zero and are ignored (as FPCR's), the trap
//! enables are RAZ/WI. At EL0 VMRS and VMSR reach FPSCR alone, the ID
//! registers and FPEXC are UNDEFINED. CPACR_EL1.FPEN traps (EC 0x07, CV 1
//! and COND 0xE, as A64's FP trap); FPEXC.EN is FPEXC32_EL2's, which needs
//! an EL2, so it never applies.
//!
//! The decoders take the instruction as A32 encodes it (T32's VFP space is
//! A32's with the condition 0b1110), the condition already passed.

use crate::aarch64::a32::{condition_passed, reg, set_reg};
use crate::aarch64::cpu::*;
use crate::aarch64::execute::{self, Flow};
use crate::aarch64::fp::{self, Arith, Format, Fp, F32, F64};
use crate::aarch64::memory::{self, Syndrome};
use crate::aarch64::simd::{set_vreg, vreg};
use crate::aarch64::state::{fpcr, fpsr};

// ---- the registers

/// S[n]: bits 32(n%4) of V[n/4]
#[inline(always)]
pub fn sreg(n: u32) -> u32 { (vreg(n >> 2) >> (32 * (n & 3))) as u32 }

#[inline(always)]
pub fn set_sreg(n: u32, value: u32) {
    let shift = 32 * (n & 3);
    let v = vreg(n >> 2) & !(0xFFFF_FFFFu128 << shift);
    set_vreg(n >> 2, v | (value as u128) << shift)
}

/// D[n]: half n%2 of V[n/2]
#[inline(always)]
pub fn dreg(n: u32) -> u64 { (vreg(n >> 1) >> (64 * (n & 1))) as u64 }

#[inline(always)]
pub fn set_dreg(n: u32, value: u64) {
    let shift = 64 * (n & 1);
    let v = vreg(n >> 1) & !((u64::MAX as u128) << shift);
    set_vreg(n >> 1, v | (value as u128) << shift)
}

/// FPSR's bits FPSCR has: NZCV, QC, the cumulative flags
const FPSR_KEPT: u32 = 0xF800_009F;

pub fn fpscr() -> u32 { unsafe { *fpsr & FPSR_KEPT | *fpcr & fp::FPCR_WRITABLE } }

pub fn set_fpscr(value: u32) {
    unsafe {
        *fpsr = value & FPSR_KEPT;
        *fpcr = value & fp::FPCR_WRITABLE;
    }
}

/// A single-precision register number (Vx:bit), or a double's (bit:Vx)
#[inline(always)]
fn number(v: u32, bit: u32, double: bool) -> u32 {
    if double {
        bit << 4 | v
    }
    else {
        v << 1 | bit
    }
}
#[inline(always)]
fn vd(word: u32, double: bool) -> u32 { number(word >> 12 & 15, word >> 22 & 1, double) }
#[inline(always)]
fn vn(word: u32, double: bool) -> u32 { number(word >> 16 & 15, word >> 7 & 1, double) }
#[inline(always)]
fn vm(word: u32, double: bool) -> u32 { number(word & 15, word >> 5 & 1, double) }

/// Read an S (`double` false) or D register
#[inline(always)]
fn read(n: u32, double: bool) -> u64 {
    if double {
        dreg(n)
    }
    else {
        sreg(n) as u64
    }
}
#[inline(always)]
fn write(n: u32, double: bool, value: u64) {
    if double {
        set_dreg(n, value)
    }
    else {
        set_sreg(n, value as u32)
    }
}

/// The SoftFloat rounding mode of FPSCR.RMode
#[inline(always)]
fn fpscr_rounding() -> u8 { fp::rounding_of(unsafe { *fpcr } >> 22) }

/// FPDecodeRM: VRINT{A,N,P,M} and VCVT{A,N,P,M}'s rounding modes
const DECODE_RM: [u8; 4] = [
    fp::ROUND_NEAR_MAX_MAG,
    fp::ROUND_NEAR_EVEN,
    fp::ROUND_MAX,
    fp::ROUND_MIN,
];

// ---- the coprocessor space of coprocessors 10 and 11

/// A VFP instruction (bits 27:25 110 or 111, bits 11:9 101): `pc` the PC
/// as the instruction set reads it (A32's + 8, T32's + 4)
pub fn vfp(word: u32, pc: u32, thumb: bool) -> Result<Flow, Exception> {
    match word >> 24 & 15 {
        0b1110 => {
            if word & 1 << 4 == 0 {
                data_processing(word)
            }
            else {
                transfer(word, thumb)
            }
        },
        0b1100 | 0b1101 => {
            if word >> 21 & 0x7F == 0b1100010 {
                transfer_64(word, thumb)
            }
            else {
                load_store(word, pc, thumb)
            }
        },
        _ => Err(Exception::Undefined),
    }
}

#[derive(Clone, Copy)]
enum Three {
    Mla,
    Mls,
    Nmla,
    Nmls,
    Mul,
    Nmul,
    Add,
    Sub,
    Div,
    Fma,
    Fms,
    Fnma,
    Fnms,
    MaxNm,
    MinNm,
}

/// The data processing instructions (bits 27:24 1110, bit 4 0)
fn data_processing(word: u32) -> Result<Flow, Exception> {
    let op = word >> 6 & 1 != 0;
    let three = match word >> 20 & 0b1011 {
        0b0000 => [Three::Mla, Three::Mls][op as usize],
        0b0001 => [Three::Nmls, Three::Nmla][op as usize],
        0b0010 => [Three::Mul, Three::Nmul][op as usize],
        0b0011 => [Three::Add, Three::Sub][op as usize],
        0b1000 if !op => Three::Div,
        0b1001 => [Three::Fnms, Three::Fnma][op as usize],
        0b1010 => [Three::Fma, Three::Fms][op as usize],
        0b1011 => return other(word),
        _ => return Err(Exception::Undefined),
    };
    three_operands(word, three)
}

fn three_operands(word: u32, op: Three) -> Result<Flow, Exception> {
    fp::check_access()?;
    let double = word & 1 << 8 != 0;
    let (d, n, m) = (vd(word, double), vn(word, double), vm(word, double));
    let (a, b, c) = (read(d, double), read(n, double), read(m, double));
    let r = if double { three_op::<F64>(op, a, b, c) } else { three_op::<F32>(op, a, b, c) };
    write(d, double, r);
    Ok(Flow::Next)
}

/// The operation on D, N, M (FPNeg flips the sign, a NaN's too)
fn three_op<T: Format>(op: Three, d: u64, n: u64, m: u64) -> u64 {
    let mut fp = Fp::new();
    let neg = |v: u64| v ^ T::SIGN;
    let r = match op {
        Three::Mla => {
            let product = fp.arith::<T>(Arith::Mul, n, m);
            fp.arith::<T>(Arith::Add, d, product)
        },
        Three::Mls => {
            let product = fp.arith::<T>(Arith::Mul, n, m);
            fp.arith::<T>(Arith::Add, d, neg(product))
        },
        Three::Nmla => {
            let product = fp.arith::<T>(Arith::Mul, n, m);
            fp.arith::<T>(Arith::Add, neg(d), neg(product))
        },
        Three::Nmls => {
            let product = fp.arith::<T>(Arith::Mul, n, m);
            fp.arith::<T>(Arith::Add, neg(d), product)
        },
        Three::Mul => fp.arith::<T>(Arith::Mul, n, m),
        Three::Nmul => neg(fp.arith::<T>(Arith::Mul, n, m)),
        Three::Add => fp.arith::<T>(Arith::Add, n, m),
        Three::Sub => fp.arith::<T>(Arith::Sub, n, m),
        Three::Div => fp.arith::<T>(Arith::Div, n, m),
        Three::Fma => fp.mul_add::<T>(d, n, m),
        Three::Fms => fp.mul_add::<T>(d, neg(n), m),
        Three::Fnma => fp.mul_add::<T>(neg(d), neg(n), m),
        Three::Fnms => fp.mul_add::<T>(neg(d), n, m),
        Three::MaxNm => fp.max_min::<T>(n, m, true, true),
        Three::MinNm => fp.max_min::<T>(n, m, false, true),
    };
    fp.finish();
    r
}

/// The two-register and immediate forms (opc1 1x11): VMOV, VABS, VNEG,
/// VSQRT, VCVTB/VCVTT, VCMP(E), VRINTR/Z/X, the conversions
fn other(word: u32) -> Result<Flow, Exception> {
    let double = word & 1 << 8 != 0;
    let opc2 = word >> 16 & 15;
    let bit7 = word >> 7 & 1 != 0;
    if word & 1 << 6 == 0 {
        // VMOV (immediate): bits 7:4 0000
        if word >> 4 & 15 != 0 {
            return Err(Exception::Undefined);
        }
        fp::check_access()?;
        let imm8 = opc2 << 4 | word & 15;
        write(
            vd(word, double),
            double,
            fp::expand_imm(imm8, if double { 64 } else { 32 }),
        );
        return Ok(Flow::Next);
    }
    match opc2 {
        0b0000 | 0b0001 => {
            fp::check_access()?;
            let (d, m) = (vd(word, double), vm(word, double));
            let x = read(m, double);
            let sign = if double { F64::SIGN } else { F32::SIGN };
            let r = match (opc2, bit7) {
                (0, false) => x,
                (0, true) => x & !sign,
                (_, false) => x ^ sign,
                (_, true) => {
                    let mut fp = Fp::new();
                    let r = if double { fp.sqrt::<F64>(x) } else { fp.sqrt::<F32>(x) };
                    fp.finish();
                    r
                },
            };
            write(d, double, r);
            Ok(Flow::Next)
        },
        0b0010 => {
            // VCVTB, VCVTT from half precision (to single, or double)
            fp::check_access()?;
            let h = (sreg(vm(word, false)) >> (16 * bit7 as u32)) as u16;
            let mut fp = Fp::new();
            let r = fp.from_half(h, if double { 64 } else { 32 });
            fp.finish();
            write(vd(word, double), double, r);
            Ok(Flow::Next)
        },
        0b0011 => {
            // VCVTB, VCVTT to half precision, into a half of Sd
            fp::check_access()?;
            let x = read(vm(word, double), double);
            let mut fp = Fp::new();
            let h = fp.to_half(x, if double { 64 } else { 32 });
            fp.finish();
            let d = vd(word, false);
            let shift = 16 * bit7 as u32;
            set_sreg(d, sreg(d) & !(0xFFFF << shift) | (h as u32) << shift);
            Ok(Flow::Next)
        },
        0b0100 | 0b0101 => {
            // VCMP, VCMPE (bit 16: with zero, Vm and M zero)
            let (d, m) = (vd(word, double), vm(word, double));
            let zero = opc2 & 1 != 0;
            if zero && m != 0 {
                return Err(Exception::Undefined);
            }
            fp::check_access()?;
            let a = read(d, double);
            let b = if zero { 0 } else { read(m, double) };
            let mut fp = Fp::new();
            let nzcv =
                if double { fp.compare::<F64>(a, b, bit7) } else { fp.compare::<F32>(a, b, bit7) };
            fp.finish();
            unsafe { *fpsr = *fpsr & 0x0FFF_FFFF | nzcv };
            Ok(Flow::Next)
        },
        0b0110 | 0b0111 if !(opc2 == 0b0111 && bit7) => {
            // VRINTR (FPSCR's mode), VRINTZ (to zero), VRINTX (FPSCR's, exact)
            fp::check_access()?;
            let (d, m) = (vd(word, double), vm(word, double));
            let (mode, exact) = match (opc2, bit7) {
                (0b0110, false) => (fpscr_rounding(), false),
                (0b0110, true) => (fp::ROUND_MIN_MAG, false),
                _ => (fpscr_rounding(), true),
            };
            let x = read(m, double);
            let mut fp = Fp::new();
            let r = if double {
                fp.round_to_int::<F64>(x, mode, exact)
            }
            else {
                fp.round_to_int::<F32>(x, mode, exact)
            };
            fp.finish();
            write(d, double, r);
            Ok(Flow::Next)
        },
        0b0111 => {
            // VCVT between single and double (cp10: single to double)
            fp::check_access()?;
            let mut fp = Fp::new();
            if double {
                let r = fp.double_to_single(dreg(vm(word, true)), false);
                set_sreg(vd(word, false), r);
            }
            else {
                let r = fp.single_to_double(sreg(vm(word, false)));
                set_dreg(vd(word, true), r);
            }
            fp.finish();
            Ok(Flow::Next)
        },
        0b1000 => {
            // VCVT from a 32-bit integer in Sm (bit 7: signed)
            fp::check_access()?;
            let x = sreg(vm(word, false)) as u64;
            let mut fp = Fp::new();
            let r = if double {
                fp.from_integer::<F64>(x, bit7, 32, 0)
            }
            else {
                fp.from_integer::<F32>(x, bit7, 32, 0)
            };
            fp.finish();
            write(vd(word, double), double, r);
            Ok(Flow::Next)
        },
        0b1010 | 0b1011 | 0b1110 | 0b1111 => convert_fixed(word, double),
        0b1100 | 0b1101 => {
            // VCVT, VCVTR to a 32-bit integer in Sd (bit 16: signed; bit 7: toward zero)
            fp::check_access()?;
            let x = read(vm(word, double), double);
            let signed = opc2 & 1 != 0;
            let mode = if bit7 { fp::ROUND_MIN_MAG } else { fpscr_rounding() };
            let mut fp = Fp::new();
            let r = if double {
                fp.to_integer::<F64>(x, signed, 32, 0, mode)
            }
            else {
                fp.to_integer::<F32>(x, signed, 32, 0, mode)
            };
            fp.finish();
            set_sreg(vd(word, false), r as u32);
            Ok(Flow::Next)
        },
        // (VJCVT: not in the profile)
        _ => Err(Exception::Undefined),
    }
}

/// VCVT between floating point and fixed point, in place: bit 18 to fixed
/// (rounding toward zero; from fixed: to nearest), bit 16 unsigned, bit 7
/// a 32-bit integer (else 16), the fraction bits size - imm4:i
fn convert_fixed(word: u32, double: bool) -> Result<Flow, Exception> {
    let to_fixed = word & 1 << 18 != 0;
    let unsigned = word & 1 << 16 != 0;
    let size = if word & 1 << 7 != 0 { 32 } else { 16 };
    let imm = (word & 15) << 1 | word >> 5 & 1;
    if imm > size {
        // (fewer than zero fraction bits: UNPREDICTABLE)
        return Err(Exception::Undefined);
    }
    let fbits = size - imm;
    fp::check_access()?;
    let d = vd(word, double);
    let x = read(d, double);
    let r = if to_fixed {
        let mut fp = Fp::new();
        let r = match (double, size) {
            (false, 32) => fp.to_integer::<F32>(x, !unsigned, 32, fbits, fp::ROUND_MIN_MAG),
            (true, 32) => fp.to_integer::<F64>(x, !unsigned, 32, fbits, fp::ROUND_MIN_MAG),
            (false, _) => fp.to_integer16::<F32>(x, !unsigned, fbits, fp::ROUND_MIN_MAG),
            (true, _) => fp.to_integer16::<F64>(x, !unsigned, fbits, fp::ROUND_MIN_MAG),
        };
        fp.finish();
        // (extended to the register by the signedness)
        let r = r & (u64::MAX >> (64 - size));
        if unsigned {
            r
        }
        else {
            ((r << (64 - size)) as i64 >> (64 - size)) as u64
        }
    }
    else {
        let low = x & (u64::MAX >> (64 - size));
        let value =
            if unsigned { low } else { ((low << (64 - size)) as i64 >> (64 - size)) as u64 };
        let mut fp = Fp::with(unsafe { *fpcr } & !(3 << 22));
        let r = if double {
            fp.from_integer::<F64>(value, !unsigned, 32, fbits)
        }
        else {
            fp.from_integer::<F32>(value, !unsigned, 32, fbits)
        };
        fp.finish();
        r
    };
    let r = if double { r } else { r & 0xFFFF_FFFF };
    write(d, double, r);
    Ok(Flow::Next)
}

/// The transfers between core and extension registers (bits 27:24 1110,
/// bit 4 1): VMOV (core, single), VMRS, VMSR; VMOV (scalar), VDUP (core)
fn transfer(word: u32, thumb: bool) -> Result<Flow, Exception> {
    let rt = word >> 12 & 15;
    let bad_rt = rt == 15 || (thumb && rt == 13);
    let to_core = word & 1 << 20 != 0;
    if word & 1 << 8 == 0 {
        if word >> 21 & 7 == 0 && word & 0x7F == 0x10 {
            // VMOV between a core register and S
            if bad_rt {
                return Err(Exception::Undefined);
            }
            fp::check_access()?;
            let n = vn(word, false);
            if to_core {
                set_reg(rt, sreg(n));
            }
            else {
                set_sreg(n, reg(rt));
            }
            return Ok(Flow::Next);
        }
        if word >> 21 & 7 == 7 && word & 0xFF == 0x10 {
            return special_register(word >> 16 & 15, rt, to_core, thumb);
        }
        return Err(Exception::Undefined);
    }
    if word & 15 != 0 || bad_rt {
        return Err(Exception::Undefined);
    }
    let n = vn(word, true);
    let unsigned = word & 1 << 23 != 0;
    if !to_core && unsigned {
        // VDUP (core): bit 22 bytes, bit 5 halfwords, else words; bit 21 Q
        let (b, q, e) = (word >> 22 & 1, word >> 21 & 1, word >> 5 & 1);
        if word & 1 << 6 != 0 || (b == 1 && e == 1) || (q == 1 && n & 1 != 0) {
            return Err(Exception::Undefined);
        }
        fp::check_access()?;
        let value = reg(rt);
        let d = if b == 1 {
            (value & 0xFF) as u64 * 0x0101_0101_0101_0101
        }
        else if e == 1 {
            (value & 0xFFFF) as u64 * 0x0001_0001_0001_0001
        }
        else {
            value as u64 * 0x0000_0001_0000_0001
        };
        set_dreg(n, d);
        if q == 1 {
            set_dreg(n + 1, d);
        }
        return Ok(Flow::Next);
    }
    // VMOV (scalar to core: bit 23 unsigned; core to scalar)
    let (esize, index) = if word & 1 << 22 != 0 {
        (8, (word >> 21 & 1) << 2 | (word >> 5 & 3))
    }
    else if word & 1 << 5 != 0 {
        (16, (word >> 21 & 1) << 1 | (word >> 6 & 1))
    }
    else if word & 1 << 6 == 0 && !unsigned {
        (32, word >> 21 & 1)
    }
    else {
        return Err(Exception::Undefined);
    };
    fp::check_access()?;
    let shift = esize * index;
    let mask = u64::MAX >> (64 - esize);
    if to_core {
        let element = dreg(n) >> shift & mask;
        let value = if unsigned || esize == 32 {
            element
        }
        else {
            ((element << (64 - esize)) as i64 >> (64 - esize)) as u64
        };
        set_reg(rt, value as u32);
    }
    else {
        let element = reg(rt) as u64 & mask;
        set_dreg(n, dreg(n) & !(mask << shift) | element << shift);
    }
    Ok(Flow::Next)
}

/// VMRS, VMSR at EL0: FPSCR (VMRS to the PC: APSR_nzcv from FPSCR's)
fn special_register(register: u32, rt: u32, to_core: bool, thumb: bool) -> Result<Flow, Exception> {
    if register != 1 && crate::aarch64::a32_system::privileged() && !(thumb && rt == 13) {
        // (PL1's: FPSID, MVFR0-2, FPEXC)
        return crate::aarch64::a32_system::vfp_system(register, rt, to_core);
    }
    if register != 1 || (thumb && rt == 13) || (!to_core && rt == 15) {
        return Err(Exception::Undefined);
    }
    fp::check_access()?;
    if !to_core {
        set_fpscr(reg(rt));
    }
    else if rt == 15 {
        set_nzcv(unsafe { *fpsr } & 0xF000_0000);
    }
    else {
        set_reg(rt, fpscr());
    }
    Ok(Flow::Next)
}

/// VMOV between two core registers and two S registers (Sm, Sm+1) or a D register
fn transfer_64(word: u32, thumb: bool) -> Result<Flow, Exception> {
    let (rt, rt2) = (word >> 12 & 15, word >> 16 & 15);
    let to_core = word & 1 << 20 != 0;
    let double = word & 1 << 8 != 0;
    let m = vm(word, double);
    let bad = |r: u32| r == 15 || (thumb && r == 13);
    if word >> 6 & 3 != 0
        || word & 1 << 4 == 0
        || bad(rt)
        || bad(rt2)
        || (to_core && rt == rt2)
        || (!double && m == 31)
    {
        return Err(Exception::Undefined);
    }
    fp::check_access()?;
    match (double, to_core) {
        (true, true) => {
            let value = dreg(m);
            set_reg(rt, value as u32);
            set_reg(rt2, (value >> 32) as u32);
        },
        (true, false) => set_dreg(m, (reg(rt2) as u64) << 32 | reg(rt) as u64),
        (false, true) => {
            let (low, high) = (sreg(m), sreg(m + 1));
            set_reg(rt, low);
            set_reg(rt2, high);
        },
        (false, false) => {
            set_sreg(m, reg(rt));
            set_sreg(m + 1, reg(rt2));
        },
    }
    Ok(Flow::Next)
}

/// An aligned word of a VFP load (MemA; no ISS)
fn load_word(address: u32) -> Result<u32, Exception> {
    if address & 3 != 0 {
        return Err(execute::alignment(address as u64, false, Syndrome::NONE));
    }
    Ok(memory::read(address as u64, 4, false, Syndrome::NONE)? as u32)
}

fn prepare_word(address: u32) -> Result<memory::Store, Exception> {
    if address & 3 != 0 {
        return Err(execute::alignment(address as u64, true, Syndrome::NONE));
    }
    memory::prepare_write(address as u64, 4, false, Syndrome::NONE)
}

/// VLDR, VSTR, VLDM, VSTM (VPUSH, VPOP; FLDMX, FSTMX: an odd imm8 of
/// doubles); the base the PC aligned (literal). Words, each aligned: a
/// double is two, low first. Nothing is written if any access faults.
fn load_store(word: u32, pc: u32, thumb: bool) -> Result<Flow, Exception> {
    let double = word & 1 << 8 != 0;
    let (p, u, w) = (
        word >> 24 & 1 != 0,
        word >> 23 & 1 != 0,
        word >> 21 & 1 != 0,
    );
    let load = word & 1 << 20 != 0;
    let rn = word >> 16 & 15;
    let imm8 = word & 0xFF;
    let d = vd(word, double);
    let base = if rn == 15 { pc & !3 } else { reg(rn) };
    let words_per = if double { 2 } else { 1 };
    let (first, count, writeback) = if p && !w {
        // VLDR, VSTR (T32's VSTR of the PC: UNPREDICTABLE)
        if rn == 15 && thumb && !load {
            return Err(Exception::Undefined);
        }
        let offset = imm8 << 2;
        let address = if u { base.wrapping_add(offset) } else { base.wrapping_sub(offset) };
        (address, 1, None)
    }
    else if p != u && (u || w) {
        // VLDM, VSTM: increment after, or decrement before with writeback
        let regs = if double { imm8 >> 1 } else { imm8 };
        if regs == 0 || d + regs > 32 || (double && regs > 16) || (rn == 15 && (w || thumb)) {
            return Err(Exception::Undefined);
        }
        let size = imm8 << 2;
        let first = if p { base.wrapping_sub(size) } else { base };
        let new_base = if u { base.wrapping_add(size) } else { base.wrapping_sub(size) };
        (first, regs, if w { Some(new_base) } else { None })
    }
    else {
        return Err(Exception::Undefined);
    };
    fp::check_access()?;
    if load {
        let mut values = [0u64; 32];
        let mut address = first;
        for value in values.iter_mut().take(count as usize) {
            let low = load_word(address)? as u64;
            *value =
                if double { low | (load_word(address.wrapping_add(4))? as u64) << 32 } else { low };
            address = address.wrapping_add(4 * words_per);
        }
        if let Some(new_base) = writeback {
            set_reg(rn, new_base);
        }
        for (i, value) in values.iter().take(count as usize).enumerate() {
            write(d + i as u32, double, *value);
        }
    }
    else {
        let mut stores: [Option<(memory::Store, u32)>; 64] = [None; 64];
        let mut address = first;
        for i in 0..count {
            let value = read(d + i, double);
            for half in 0..words_per {
                let slot = (i * words_per + half) as usize;
                stores[slot] = Some((prepare_word(address)?, (value >> (32 * half)) as u32));
                address = address.wrapping_add(4);
            }
        }
        for store in stores.into_iter().flatten() {
            store.0.commit(store.1 as u64)?;
        }
        if let Some(new_base) = writeback {
            set_reg(rn, new_base);
        }
    }
    Ok(Flow::Next)
}

// ---- the unconditional space: ARMv8's additions

/// VSEL, VMAXNM, VMINNM, VRINT{A,N,P,M}, VCVT{A,N,P,M} (A32 and T32: 1111
/// 1110, bits 11:9 101, bit 4 0)
pub fn vfp_unconditional(word: u32) -> Result<Flow, Exception> {
    if word >> 24 != 0xFE || word >> 9 & 7 != 0b101 || word & 1 << 4 != 0 {
        return Err(Exception::Undefined);
    }
    let double = word & 1 << 8 != 0;
    if word & 1 << 23 == 0 {
        // VSEL: EQ, VS, GE, GT on APSR
        if word & 1 << 6 != 0 {
            return Err(Exception::Undefined);
        }
        fp::check_access()?;
        let cond = [0b0000, 0b0110, 0b1010, 0b1100][(word >> 20 & 3) as usize];
        let (d, n, m) = (vd(word, double), vn(word, double), vm(word, double));
        let source = if condition_passed(cond) { n } else { m };
        write(d, double, read(source, double));
        return Ok(Flow::Next);
    }
    match word >> 20 & 0b1011 {
        0b1000 => three_operands(
            word,
            if word & 1 << 6 != 0 { Three::MinNm } else { Three::MaxNm },
        ),
        0b1011 => {
            let mode = DECODE_RM[(word >> 16 & 3) as usize];
            match word >> 18 & 3 {
                0b10 if word >> 6 & 3 == 0b01 => {
                    // VRINT{A,N,P,M}
                    fp::check_access()?;
                    let x = read(vm(word, double), double);
                    let mut fp = Fp::new();
                    let r = if double {
                        fp.round_to_int::<F64>(x, mode, false)
                    }
                    else {
                        fp.round_to_int::<F32>(x, mode, false)
                    };
                    fp.finish();
                    write(vd(word, double), double, r);
                    Ok(Flow::Next)
                },
                0b11 if word & 1 << 6 != 0 => {
                    // VCVT{A,N,P,M} to a 32-bit integer in Sd (bit 7 signed)
                    fp::check_access()?;
                    let x = read(vm(word, double), double);
                    let signed = word & 1 << 7 != 0;
                    let mut fp = Fp::new();
                    let r = if double {
                        fp.to_integer::<F64>(x, signed, 32, 0, mode)
                    }
                    else {
                        fp.to_integer::<F32>(x, signed, 32, 0, mode)
                    };
                    fp.finish();
                    set_sreg(vd(word, false), r as u32);
                    Ok(Flow::Next)
                },
                // (VMOVX, VINS: half precision, not in the profile)
                _ => Err(Exception::Undefined),
            }
        },
        _ => Err(Exception::Undefined),
    }
}
