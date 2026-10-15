//! Scalar FP and the FP operations of AdvSIMD (docs/arm64-virt-android16-plan.md
//! P2.6, P2.8): the instructions, on top of fp.rs's arithmetic with the
//! ARM rules. One `Fp` per instruction collects the FPSR flags of all its
//! elements; they are written with the result.

use crate::aarch64::cpu::{self, xr};
use crate::aarch64::decode::bits;
use crate::aarch64::execute::{condition_holds, Flow};
use crate::aarch64::fp::{
    self, Arith, Format, Fp, F32, F64, ROUND_MAX, ROUND_MIN, ROUND_MIN_MAG, ROUND_NEAR_EVEN,
    ROUND_NEAR_MAX_MAG,
};
use crate::aarch64::simd::{elem, ones, set_vreg, vreg, with_elem};

#[inline(always)]
fn regs(word: u32) -> (u32, u32, u32) { (word & 31, word >> 5 & 31, word >> 16 & 31) }
#[inline(always)]
fn datasize(word: u32) -> u32 { 64 << (word >> 30 & 1) }
#[inline(always)]
fn all<T: Format>(test: bool) -> u64 {
    if test {
        ones(T::BITS)
    }
    else {
        0
    }
}

/// Run an element operation on each element of `elements`, as single or double precision
macro_rules! per_type {
    ($esize:expr, $f:ident, $($arg:expr),*) => {
        if $esize == 32 { $f::<F32>($($arg),*) } else { $f::<F64>($($arg),*) }
    };
}

// ---- AdvSIMD three same

fn same_op<T: Format>(fp: &mut Fp, u: u32, a: u32, opcode: u32, x: u64, y: u64, z: u64) -> u64 {
    match (u, a, opcode) {
        (_, 0, 0b11000) => fp.max_min::<T>(x, y, true, true),
        (_, 1, 0b11000) => fp.max_min::<T>(x, y, false, true),
        (0, 0, 0b11001) => fp.mul_add::<T>(z, x, y),
        (0, 1, 0b11001) => fp.mul_add::<T>(z, x ^ T::SIGN, y),
        (_, 0, 0b11010) => fp.arith::<T>(Arith::Add, x, y),
        (0, 1, 0b11010) => fp.arith::<T>(Arith::Sub, x, y),
        (1, 1, 0b11010) => fp.arith::<T>(Arith::Sub, x, y) & !T::SIGN,
        (0, 0, 0b11011) => fp.mulx::<T>(x, y),
        (1, 0, 0b11011) => fp.arith::<T>(Arith::Mul, x, y),
        (0, 0, 0b11100) => all::<T>(fp.compare_eq::<T>(x, y)),
        (1, 0, 0b11100) => all::<T>(fp.compare_ge::<T>(x, y)),
        (1, 1, 0b11100) => all::<T>(fp.compare_gt::<T>(x, y)),
        (1, 0, 0b11101) => all::<T>(fp.compare_ge::<T>(x & !T::SIGN, y & !T::SIGN)),
        (1, 1, 0b11101) => all::<T>(fp.compare_gt::<T>(x & !T::SIGN, y & !T::SIGN)),
        (_, 0, 0b11110) => fp.max_min::<T>(x, y, true, false),
        (_, 1, 0b11110) => fp.max_min::<T>(x, y, false, false),
        (0, 0, 0b11111) => fp.recip_step::<T>(x, y),
        (0, 1, 0b11111) => fp.recip_sqrt_step::<T>(x, y),
        (1, 0, 0b11111) => fp.arith::<T>(Arith::Div, x, y),
        _ => 0,
    }
}

pub fn three_same(word: u32) -> Flow {
    let (d, n, m) = regs(word);
    let scalar = word >> 28 & 1 != 0;
    let u = word >> 29 & 1;
    let size = bits(word, 23, 22);
    let opcode = bits(word, 15, 11);
    let (a, esize) = (size >> 1, 32 << (size & 1));
    let width = if scalar { esize } else { datasize(word) };
    let elements = width / esize;
    let pairwise =
        !scalar && u == 1 && matches!((a, opcode), (_, 0b11000) | (0, 0b11010) | (_, 0b11110));
    let (va, vb, vc) = (vreg(n), vreg(m), vreg(d));
    let mut fp = Fp::new();
    let mut result = 0u128;
    for e in 0..elements {
        let (x, y) = if pairwise {
            let (source, i) = if 2 * e < elements { (va, 2 * e) } else { (vb, 2 * e - elements) };
            (elem(source, i, esize), elem(source, i + 1, esize))
        }
        else {
            (elem(va, e, esize), elem(vb, e, esize))
        };
        let r = per_type!(
            esize,
            same_op,
            &mut fp,
            u,
            a,
            opcode,
            x,
            y,
            elem(vc, e, esize)
        );
        result = with_elem(result, e, esize, r);
    }
    fp.finish();
    set_vreg(d, result);
    Flow::Next
}

// ---- AdvSIMD two-register miscellaneous

fn misc_op<T: Format>(fp: &mut Fp, u: u32, a: u32, opcode: u32, x: u64) -> u64 {
    let fpcr_mode = fp::rounding_of(fp.fpcr >> 22);
    let zero = 0;
    match (u, a, opcode) {
        (0, 0, 0b11000) => fp.round_to_int::<T>(x, ROUND_NEAR_EVEN, false),
        (0, 0, 0b11001) => fp.round_to_int::<T>(x, ROUND_MIN, false),
        (0, 1, 0b11000) => fp.round_to_int::<T>(x, ROUND_MAX, false),
        (0, 1, 0b11001) => fp.round_to_int::<T>(x, ROUND_MIN_MAG, false),
        (1, 0, 0b11000) => fp.round_to_int::<T>(x, ROUND_NEAR_MAX_MAG, false),
        (1, 0, 0b11001) => fp.round_to_int::<T>(x, fpcr_mode, true),
        (1, 1, 0b11001) => fp.round_to_int::<T>(x, fpcr_mode, false),
        // FCVT[NMAPZ][SU] (vector and scalar: the element size)
        (_, _, 0b11010) | (_, _, 0b11011) | (_, 0, 0b11100) => {
            let mode = match (a, opcode) {
                (0, 0b11010) => ROUND_NEAR_EVEN,
                (0, 0b11011) => ROUND_MIN,
                (0, _) => ROUND_NEAR_MAX_MAG,
                (_, 0b11010) => ROUND_MAX,
                _ => ROUND_MIN_MAG,
            };
            fp.to_integer::<T>(x, u == 0, T::BITS, 0, mode)
        },
        (_, 0, 0b11101) => fp.from_integer::<T>(x, u == 0, T::BITS, 0),
        (0, 1, 0b01100) => all::<T>(fp.compare_gt::<T>(x, zero)),
        (0, 1, 0b01101) => all::<T>(fp.compare_eq::<T>(x, zero)),
        (0, 1, 0b01110) => all::<T>(fp.compare_gt::<T>(zero, x)),
        (1, 1, 0b01100) => all::<T>(fp.compare_ge::<T>(x, zero)),
        (1, 1, 0b01101) => all::<T>(fp.compare_ge::<T>(zero, x)),
        (0, 1, 0b01111) => x & !T::SIGN,
        (1, 1, 0b01111) => x ^ T::SIGN,
        (0, 1, 0b11100) => {
            // URECPE
            if x >> 31 == 0 {
                0xFFFF_FFFF
            }
            else {
                (fp::recip_estimate((x >> 23) as u32 & 0x1FF) as u64) << 23
            }
        },
        (1, 1, 0b11100) => {
            // URSQRTE
            if x >> 30 == 0 {
                0xFFFF_FFFF
            }
            else {
                (fp::recip_sqrt_estimate((x >> 23) as u32 & 0x1FF) as u64) << 23
            }
        },
        (0, 1, 0b11101) => fp.recip_estimate::<T>(x),
        (1, 1, 0b11101) => fp.recip_sqrt_estimate::<T>(x),
        (0, 1, 0b11111) => fp.recip_exponent::<T>(x),
        (1, 1, 0b11111) => fp.sqrt::<T>(x),
        _ => 0,
    }
}

pub fn two_misc(word: u32) -> Flow {
    let (d, n, _) = regs(word);
    let scalar = word >> 28 & 1 != 0;
    let q = word >> 30 & 1 != 0;
    let u = word >> 29 & 1;
    let size = bits(word, 23, 22);
    let opcode = bits(word, 16, 12);
    let (a, sz) = (size >> 1, size & 1);
    let va = vreg(n);
    let mut fp = Fp::new();
    match (u, a, opcode) {
        (_, 0, 0b10110) => {
            // FCVTN (single to half, double to single), FCVTXN (double to single, rounding to odd)
            let odd = u == 1;
            let (from, to) = if sz == 0 { (32, 16) } else { (64, 32) };
            let count = if scalar { 1 } else { 64 / to };
            let mut result = 0u64;
            for e in 0..count {
                let x = elem(va, e, from);
                let r = if to == 16 {
                    fp.to_half(x, 32) as u64
                }
                else {
                    fp.double_to_single(x, odd) as u64
                };
                result |= r << (e * to);
            }
            fp.finish();
            if scalar || !q {
                set_vreg(d, result as u128);
            }
            else {
                set_vreg(d, vreg(d) & u64::MAX as u128 | (result as u128) << 64);
            }
        },
        (0, 0, 0b10111) => {
            // FCVTL: half to single, single to double (the lower or upper half)
            let (from, to) = if sz == 0 { (16, 32) } else { (32, 64) };
            let source = if q { va >> 64 } else { va };
            let mut result = 0u128;
            for e in 0..128 / to {
                let x = elem(source, e, from);
                let r = if from == 16 {
                    fp.from_half(x as u16, 32)
                }
                else {
                    fp.single_to_double(x as u32)
                };
                result = with_elem(result, e, to, r);
            }
            fp.finish();
            set_vreg(d, result);
        },
        _ => {
            let esize = 32 << sz;
            let width = if scalar { esize } else { datasize(word) };
            let mut result = 0u128;
            for e in 0..width / esize {
                let r = per_type!(esize, misc_op, &mut fp, u, a, opcode, elem(va, e, esize));
                result = with_elem(result, e, esize, r);
            }
            fp.finish();
            set_vreg(d, result);
        },
    }
    Flow::Next
}

// ---- across lanes, pairwise

pub fn across(word: u32) -> Flow {
    let (d, n, _) = regs(word);
    let a = bits(word, 23, 23);
    let opcode = bits(word, 16, 12);
    let va = vreg(n);
    let numbers = opcode == 0b01100;
    let max = a == 0;
    let mut fp = Fp::new();
    // (a tree: op(op(e0, e1), op(e2, e3)))
    let e = |i| elem(va, i, 32);
    let low = fp.max_min::<F32>(e(0), e(1), max, numbers);
    let high = fp.max_min::<F32>(e(2), e(3), max, numbers);
    let result = fp.max_min::<F32>(low, high, max, numbers);
    fp.finish();
    set_vreg(d, result as u128);
    Flow::Next
}

fn pair_op<T: Format>(fp: &mut Fp, a: u32, opcode: u32, x: u64, y: u64) -> u64 {
    match opcode {
        0b01100 => fp.max_min::<T>(x, y, a == 0, true),
        0b01101 => fp.arith::<T>(Arith::Add, x, y),
        _ => fp.max_min::<T>(x, y, a == 0, false),
    }
}

pub fn pairwise(word: u32) -> Flow {
    let (d, n, _) = regs(word);
    let size = bits(word, 23, 22);
    let esize = 32 << (size & 1);
    let va = vreg(n);
    let mut fp = Fp::new();
    let r = per_type!(
        esize,
        pair_op,
        &mut fp,
        size >> 1,
        bits(word, 16, 12),
        elem(va, 0, esize),
        elem(va, 1, esize)
    );
    fp.finish();
    set_vreg(d, r as u128);
    Flow::Next
}

// ---- shift by immediate: the fixed-point conversions

fn fixed_op<T: Format>(fp: &mut Fp, u: u32, opcode: u32, fbits: u32, x: u64) -> u64 {
    if opcode == 0b11100 {
        fp.from_integer::<T>(x, u == 0, T::BITS, fbits)
    }
    else {
        fp.to_integer::<T>(x, u == 0, T::BITS, fbits, ROUND_MIN_MAG)
    }
}

pub fn fixed_point(word: u32) -> Flow {
    let (d, n, _) = regs(word);
    let scalar = word >> 28 & 1 != 0;
    let u = word >> 29 & 1;
    let immh = bits(word, 22, 19);
    let esize = if immh >> 3 != 0 { 64 } else { 32 };
    let fbits = 2 * esize - bits(word, 22, 16);
    let opcode = bits(word, 15, 11);
    let width = if scalar { esize } else { datasize(word) };
    let va = vreg(n);
    let mut fp = Fp::new();
    let mut result = 0u128;
    for e in 0..width / esize {
        let r = per_type!(
            esize,
            fixed_op,
            &mut fp,
            u,
            opcode,
            fbits,
            elem(va, e, esize)
        );
        result = with_elem(result, e, esize, r);
    }
    fp.finish();
    set_vreg(d, result);
    Flow::Next
}

// ---- by element

fn indexed_op<T: Format>(fp: &mut Fp, u: u32, opcode: u32, x: u64, y: u64, z: u64) -> u64 {
    match (u, opcode) {
        (0, 0b0001) => fp.mul_add::<T>(z, x, y),
        (0, 0b0101) => fp.mul_add::<T>(z, x ^ T::SIGN, y),
        (0, _) => fp.arith::<T>(Arith::Mul, x, y),
        _ => fp.mulx::<T>(x, y),
    }
}

pub fn indexed(word: u32) -> Flow {
    let d = word & 31;
    let n = word >> 5 & 31;
    let scalar = word >> 28 & 1 != 0;
    let u = word >> 29 & 1;
    let esize = 32 << (bits(word, 23, 22) & 1);
    let opcode = bits(word, 15, 12);
    let (m, index) = crate::aarch64::simd::indexed_operand(word, esize);
    let y = elem(vreg(m), index, esize);
    let (va, vc) = (vreg(n), vreg(d));
    let width = if scalar { esize } else { datasize(word) };
    let mut fp = Fp::new();
    let mut result = 0u128;
    for e in 0..width / esize {
        let r = per_type!(
            esize,
            indexed_op,
            &mut fp,
            u,
            opcode,
            elem(va, e, esize),
            y,
            elem(vc, e, esize)
        );
        result = with_elem(result, e, esize, r);
    }
    fp.finish();
    set_vreg(d, result);
    Flow::Next
}

// ---- scalar FP

/// The scalar FP type of a word: 32 (single), 64 (double), 16 (half)
#[inline(always)]
fn ftype(word: u32) -> u32 {
    match bits(word, 23, 22) {
        0 => 32,
        1 => 64,
        _ => 16,
    }
}

fn dp1_op<T: Format>(fp: &mut Fp, opcode: u32, x: u64) -> u64 {
    let fpcr_mode = fp::rounding_of(fp.fpcr >> 22);
    match opcode {
        0b000000 => x,
        0b000001 => x & !T::SIGN,
        0b000010 => x ^ T::SIGN,
        0b000011 => fp.sqrt::<T>(x),
        0b001000 => fp.round_to_int::<T>(x, ROUND_NEAR_EVEN, false),
        0b001001 => fp.round_to_int::<T>(x, ROUND_MAX, false),
        0b001010 => fp.round_to_int::<T>(x, ROUND_MIN, false),
        0b001011 => fp.round_to_int::<T>(x, ROUND_MIN_MAG, false),
        0b001100 => fp.round_to_int::<T>(x, ROUND_NEAR_MAX_MAG, false),
        0b001110 => fp.round_to_int::<T>(x, fpcr_mode, true),
        _ => fp.round_to_int::<T>(x, fpcr_mode, false),
    }
}

pub fn dp1(word: u32) -> Flow {
    let (d, n, _) = regs(word);
    let opcode = bits(word, 20, 15);
    let from = ftype(word);
    let x = vreg(n) as u64 & ones(from);
    let mut fp = Fp::new();
    let result = if opcode >> 2 == 1 {
        // FCVT: the destination type in opcode<1:0>
        let to = match opcode & 3 {
            0 => 32,
            1 => 64,
            _ => 16,
        };
        match (from, to) {
            (32, 64) => fp.single_to_double(x as u32),
            (64, 32) => fp.double_to_single(x, false) as u64,
            (16, _) => fp.from_half(x as u16, to),
            (_, _) => fp.to_half(x, from) as u64,
        }
    }
    else {
        per_type!(from, dp1_op, &mut fp, opcode, x)
    };
    fp.finish();
    set_vreg(d, result as u128);
    Flow::Next
}

fn dp2_op<T: Format>(fp: &mut Fp, opcode: u32, x: u64, y: u64) -> u64 {
    match opcode {
        0b0000 => fp.arith::<T>(Arith::Mul, x, y),
        0b0001 => fp.arith::<T>(Arith::Div, x, y),
        0b0010 => fp.arith::<T>(Arith::Add, x, y),
        0b0011 => fp.arith::<T>(Arith::Sub, x, y),
        0b0100 => fp.max_min::<T>(x, y, true, false),
        0b0101 => fp.max_min::<T>(x, y, false, false),
        0b0110 => fp.max_min::<T>(x, y, true, true),
        0b0111 => fp.max_min::<T>(x, y, false, true),
        _ => fp.arith::<T>(Arith::Mul, x, y) ^ T::SIGN,
    }
}

pub fn dp2(word: u32) -> Flow {
    let (d, n, m) = regs(word);
    let size = ftype(word);
    let (x, y) = (vreg(n) as u64 & ones(size), vreg(m) as u64 & ones(size));
    let mut fp = Fp::new();
    let result = per_type!(size, dp2_op, &mut fp, bits(word, 15, 12), x, y);
    fp.finish();
    set_vreg(d, result as u128);
    Flow::Next
}

fn dp3_op<T: Format>(fp: &mut Fp, o1: u32, o0: u32, x: u64, y: u64, z: u64) -> u64 {
    // FMADD: a + n*m; FMSUB: a - n*m; FNMADD: -a - n*m; FNMSUB: -a + n*m
    let addend = if o1 == 1 { z ^ T::SIGN } else { z };
    let op1 = if o0 != o1 { x ^ T::SIGN } else { x };
    fp.mul_add::<T>(addend, op1, y)
}

pub fn dp3(word: u32) -> Flow {
    let (d, n, m) = regs(word);
    let a = word >> 10 & 31;
    let size = ftype(word);
    let mask = ones(size);
    let (x, y, z) = (
        vreg(n) as u64 & mask,
        vreg(m) as u64 & mask,
        vreg(a) as u64 & mask,
    );
    let mut fp = Fp::new();
    let result = per_type!(
        size,
        dp3_op,
        &mut fp,
        word >> 21 & 1,
        word >> 15 & 1,
        x,
        y,
        z
    );
    fp.finish();
    set_vreg(d, result as u128);
    Flow::Next
}

fn compare_op<T: Format>(fp: &mut Fp, x: u64, y: u64, signal: bool) -> u32 {
    fp.compare::<T>(x, y, signal)
}

pub fn compare(word: u32) -> Flow {
    let (_, n, m) = regs(word);
    let size = ftype(word);
    let opcode2 = bits(word, 4, 0);
    let x = vreg(n) as u64 & ones(size);
    let y = if opcode2 & 0b01000 != 0 { 0 } else { vreg(m) as u64 & ones(size) };
    let mut fp = Fp::new();
    let flags = per_type!(size, compare_op, &mut fp, x, y, opcode2 & 0b10000 != 0);
    fp.finish();
    cpu::set_nzcv(flags);
    Flow::Next
}

pub fn cond_compare(word: u32) -> Flow {
    let (_, n, m) = regs(word);
    let size = ftype(word);
    let cond = bits(word, 15, 12) as u8;
    if condition_holds(cond, cpu::get_nzcv()) {
        let (x, y) = (vreg(n) as u64 & ones(size), vreg(m) as u64 & ones(size));
        let mut fp = Fp::new();
        let flags = per_type!(size, compare_op, &mut fp, x, y, word >> 4 & 1 != 0);
        fp.finish();
        cpu::set_nzcv(flags);
    }
    else {
        cpu::set_nzcv((word & 15) << 28);
    }
    Flow::Next
}

pub fn cond_select(word: u32) -> Flow {
    let (d, n, m) = regs(word);
    let size = ftype(word);
    let cond = bits(word, 15, 12) as u8;
    let source = if condition_holds(cond, cpu::get_nzcv()) { n } else { m };
    set_vreg(d, (vreg(source) as u64 & ones(size)) as u128);
    Flow::Next
}

pub fn immediate(word: u32) -> Flow {
    let d = word & 31;
    set_vreg(d, fp::expand_imm(bits(word, 20, 13), ftype(word)) as u128);
    Flow::Next
}

/// SCVTF, UCVTF, FCVTZS, FCVTZU (fixed-point: fbits = 64 - scale)
pub fn fixed(word: u32) -> Flow {
    let (d, n, _) = regs(word);
    let sf = word >> 31 != 0;
    let size = ftype(word);
    let fbits = 64 - bits(word, 15, 10);
    let int_bits = if sf { 64 } else { 32 };
    let opcode = bits(word, 18, 16);
    let mut fp = Fp::new();
    if opcode >> 1 == 1 {
        let value = xr(n);
        let value = if sf { value } else { value & 0xFFFF_FFFF };
        let signed = opcode == 0b010;
        let r = if size == 32 {
            fp.from_integer::<F32>(value, signed, int_bits, fbits)
        }
        else {
            fp.from_integer::<F64>(value, signed, int_bits, fbits)
        };
        fp.finish();
        set_vreg(d, r as u128);
    }
    else {
        let x = vreg(n) as u64 & ones(size);
        let signed = opcode == 0b000;
        let r = if size == 32 {
            fp.to_integer::<F32>(x, signed, int_bits, fbits, ROUND_MIN_MAG)
        }
        else {
            fp.to_integer::<F64>(x, signed, int_bits, fbits, ROUND_MIN_MAG)
        };
        fp.finish();
        cpu::set_x(d, if sf { r } else { r & 0xFFFF_FFFF });
    }
    Flow::Next
}

/// The conversions between FP and integer registers, and FMOV (general)
pub fn int(word: u32) -> Flow {
    let (d, n, _) = regs(word);
    let sf = word >> 31 != 0;
    let ty = bits(word, 23, 22);
    let rmode = bits(word, 20, 19);
    let opcode = bits(word, 18, 16);
    let int_bits = if sf { 64 } else { 32 };
    match opcode {
        0b110 => {
            // FMOV to a general register (type 2: the upper doubleword)
            let value = vreg(n);
            let r = match (ty, sf) {
                (2, _) => (value >> 64) as u64,
                (_, true) => value as u64,
                _ => value as u32 as u64,
            };
            cpu::set_x(d, r);
            return Flow::Next;
        },
        0b111 => {
            let value = xr(n);
            match (ty, sf) {
                (2, _) => set_vreg(d, vreg(d) & u64::MAX as u128 | (value as u128) << 64),
                (_, true) => set_vreg(d, value as u128),
                _ => set_vreg(d, value as u32 as u128),
            }
            return Flow::Next;
        },
        _ => {},
    }
    let size = if ty == 0 { 32 } else { 64 };
    let mut fp = Fp::new();
    if opcode == 0b010 || opcode == 0b011 {
        let value = xr(n);
        let value = if sf { value } else { value & 0xFFFF_FFFF };
        let r = if size == 32 {
            fp.from_integer::<F32>(value, opcode == 0b010, int_bits, 0)
        }
        else {
            fp.from_integer::<F64>(value, opcode == 0b010, int_bits, 0)
        };
        fp.finish();
        set_vreg(d, r as u128);
        return Flow::Next;
    }
    let mode = match (rmode, opcode >> 2) {
        (0, 0) => ROUND_NEAR_EVEN,
        (0, _) => ROUND_NEAR_MAX_MAG,
        (1, _) => ROUND_MAX,
        (2, _) => ROUND_MIN,
        _ => ROUND_MIN_MAG,
    };
    let signed = opcode & 1 == 0;
    let x = vreg(n) as u64 & ones(size);
    let r = if size == 32 {
        fp.to_integer::<F32>(x, signed, int_bits, 0, mode)
    }
    else {
        fp.to_integer::<F64>(x, signed, int_bits, 0, mode)
    };
    fp.finish();
    cpu::set_x(d, if sf { r } else { r & 0xFFFF_FFFF });
    Flow::Next
}
