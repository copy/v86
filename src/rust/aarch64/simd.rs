//! AdvSIMD and the SIMD&FP registers' loads, stores and moves
//! (docs/arm64-virt-android16-plan.md P2.5, P2.7): the integer classes of
//! AdvSIMD, vector and scalar, written element by element on u128 values
//! (so the portable build runs them too), the structure loads and stores,
//! TBL/TBX, the permutes. The FP operations of the same classes are in
//! simd_fp, the crypto instructions in crypto. Each instruction reads its
//! operands from the word (simd_decode checked it), computes, and only then
//! writes registers; a saturating operation sets FPSR.QC.

use crate::aarch64::cpu::{self, xr, xr_sp, Exception};
use crate::aarch64::decode::bits;
use crate::aarch64::execute::Flow;
use crate::aarch64::fp;
use crate::aarch64::memory::{self, Syndrome};
use crate::aarch64::simd_decode;
use crate::aarch64::state::{fpsr, v};

// ---- registers and elements

#[inline(always)]
pub fn vreg(n: u32) -> u128 { unsafe { *v.add(n as usize) } }
#[inline(always)]
pub fn set_vreg(n: u32, value: u128) { unsafe { *v.add(n as usize) = value } }

#[inline(always)]
pub fn ones(bits: u32) -> u64 {
    if bits >= 64 {
        u64::MAX
    }
    else {
        (1u64 << bits) - 1
    }
}
#[inline(always)]
pub fn elem(x: u128, index: u32, esize: u32) -> u64 { (x >> (index * esize)) as u64 & ones(esize) }
#[inline(always)]
pub fn with_elem(x: u128, index: u32, esize: u32, value: u64) -> u128 {
    let at = index * esize;
    x & !((ones(esize) as u128) << at) | ((value & ones(esize)) as u128) << at
}
/// The element as a signed value
#[inline(always)]
pub fn sext(value: u64, esize: u32) -> i64 { ((value << (64 - esize)) as i64) >> (64 - esize) }
#[inline(always)]
pub(crate) fn int(value: u64, esize: u32, unsigned: bool) -> i128 {
    if unsigned {
        value as i128
    }
    else {
        sext(value, esize) as i128
    }
}

/// The registers of a data processing word: Rd, Rn, Rm
#[inline(always)]
fn regs(word: u32) -> (u32, u32, u32) { (word & 31, word >> 5 & 31, word >> 16 & 31) }

#[inline(always)]
pub fn set_qc() { unsafe { *fpsr |= fp::FPSR_QC } }

/// SatQ: the value saturated to `esize` bits (signed or unsigned); whether it saturated
#[inline(always)]
pub fn sat(value: i128, esize: u32, unsigned: bool, qc: &mut bool) -> u64 {
    let (min, max) = if unsigned {
        (0i128, ones(esize) as i128)
    }
    else {
        (-(1i128 << (esize - 1)), (1i128 << (esize - 1)) - 1)
    };
    let clamped = if value > max {
        *qc = true;
        max
    }
    else if value < min {
        *qc = true;
        min
    }
    else {
        value
    };
    clamped as u64 & ones(esize)
}

/// The shift of SSHL and its kin: `value` << `shift` (a right shift for a
/// negative one), rounded, saturated or truncated to `esize` bits
pub(crate) fn shift_by(
    value: i128,
    shift: i64,
    esize: u32,
    unsigned: bool,
    round: bool,
    saturate: bool,
    qc: &mut bool,
) -> u64 {
    let result = if shift >= 0 {
        if value == 0 {
            0
        }
        else if shift as u32 >= esize {
            // (every bit leaves the element; any nonzero value saturates)
            if saturate {
                return sat(
                    if value < 0 { i128::MIN / 2 } else { i128::MAX / 2 },
                    esize,
                    unsigned,
                    qc,
                );
            }
            0
        }
        else {
            value << shift
        }
    }
    else {
        let k = (-shift).min(esize as i64 + 1) as u32;
        let round_const = if round { 1i128 << (k - 1) } else { 0 };
        (value + round_const) >> k
    };
    if saturate {
        sat(result, esize, unsigned, qc)
    }
    else {
        result as u64 & ones(esize)
    }
}

/// Polynomial multiplication of two `esize`-bit values (the 2 * esize-bit product)
pub fn pmul(a: u64, b: u64, esize: u32) -> u128 {
    let mut result = 0u128;
    for i in 0..esize {
        if a >> i & 1 != 0 {
            result ^= (b as u128) << i;
        }
    }
    result
}

/// The width of a vector operation: 64 or 128 bits
#[inline(always)]
fn datasize(word: u32) -> u32 { 64 << (word >> 30 & 1) }

/// The upper or lower half of a register for the "2" forms (Q = 1: the upper)
#[inline(always)]
fn half(value: u128, word: u32) -> u64 {
    if word >> 30 & 1 != 0 {
        (value >> 64) as u64
    }
    else {
        value as u64
    }
}

/// Vpart write of a narrowing instruction: the lower half (Q = 0, the upper
/// half zeroed) or the upper half (Q = 1, the lower half kept)
#[inline(always)]
fn write_narrow(d: u32, word: u32, result: u64) {
    if word >> 30 & 1 != 0 {
        set_vreg(d, vreg(d) & u64::MAX as u128 | (result as u128) << 64);
    }
    else {
        set_vreg(d, result as u128);
    }
}

// ---- the classes

/// AdvSIMD three same (vector and scalar), integer and logical
pub fn three_same(word: u32) -> Flow {
    let opcode = bits(word, 15, 11);
    if opcode >= 0b11000 {
        return crate::aarch64::simd_fp::three_same(word);
    }
    let (d, n, m) = regs(word);
    let scalar = word >> 28 & 1 != 0;
    let u = word >> 29 & 1;
    let unsigned = u == 1;
    let size = bits(word, 23, 22);
    let (a, b, c) = (vreg(n), vreg(m), vreg(d));
    let width = if scalar { 8 << size } else { datasize(word) };
    let keep = if width == 128 { u128::MAX } else { (1u128 << width) - 1 };
    if opcode == 0b00011 {
        let result = match u << 2 | size {
            0 => a & b,
            1 => a & !b,
            2 => a | b,
            3 => a | !b,
            4 => a ^ b,
            5 => a & c | b & !c,
            6 => a & b | c & !b,
            _ => c & b | a & !b,
        };
        set_vreg(d, result & keep);
        return Flow::Next;
    }
    let esize = 8 << size;
    let elements = width / esize;
    let mut qc = false;
    if !scalar && matches!(opcode, 0b10100 | 0b10101 | 0b10111) {
        // pairwise: the elements of m:n, two by two
        let mut result = 0u128;
        for e in 0..elements {
            let (source, i) = if 2 * e < elements { (a, 2 * e) } else { (b, 2 * e - elements) };
            let (x, y) = (elem(source, i, esize), elem(source, i + 1, esize));
            let (sx, sy) = (int(x, esize, unsigned), int(y, esize, unsigned));
            let r = match opcode {
                0b10100 => sx.max(sy) as u64,
                0b10101 => sx.min(sy) as u64,
                _ => x.wrapping_add(y),
            };
            result = with_elem(result, e, esize, r);
        }
        set_vreg(d, result);
        return Flow::Next;
    }
    let mut result = 0u128;
    for e in 0..elements {
        let (x, y, z) = (elem(a, e, esize), elem(b, e, esize), elem(c, e, esize));
        let (sx, sy) = (int(x, esize, unsigned), int(y, esize, unsigned));
        let mask = ones(esize);
        let test = |t: bool| if t { mask } else { 0 };
        let r = match (u, opcode) {
            (_, 0b00000) => ((sx + sy) >> 1) as u64,
            (_, 0b00001) => sat(sx + sy, esize, unsigned, &mut qc),
            (_, 0b00010) => ((sx + sy + 1) >> 1) as u64,
            (_, 0b00100) => ((sx - sy) >> 1) as u64,
            (_, 0b00101) => sat(sx - sy, esize, unsigned, &mut qc),
            (_, 0b00110) => test(sx > sy),
            (_, 0b00111) => test(sx >= sy),
            (_, 0b01000..=0b01011) => {
                let shift = y as u8 as i8 as i64;
                shift_by(
                    sx,
                    shift,
                    esize,
                    unsigned,
                    opcode & 2 != 0,
                    opcode & 1 != 0,
                    &mut qc,
                )
            },
            (_, 0b01100) => sx.max(sy) as u64,
            (_, 0b01101) => sx.min(sy) as u64,
            (_, 0b01110) => (sx - sy).unsigned_abs() as u64,
            (_, 0b01111) => z.wrapping_add((sx - sy).unsigned_abs() as u64),
            (0, 0b10000) => x.wrapping_add(y),
            (1, 0b10000) => x.wrapping_sub(y),
            (0, 0b10001) => test(x & y != 0),
            (1, 0b10001) => test(x == y),
            (0, 0b10010) => z.wrapping_add(x.wrapping_mul(y)),
            (1, 0b10010) => z.wrapping_sub(x.wrapping_mul(y)),
            (0, 0b10011) => x.wrapping_mul(y),
            (1, 0b10011) => pmul(x, y, 8) as u64,
            (_, 0b10110) => {
                // SQDMULH, SQRDMULH
                let (sx, sy) = (sext(x, esize) as i128, sext(y, esize) as i128);
                let round = if u == 1 { 1i128 << (esize - 1) } else { 0 };
                sat((2 * sx * sy + round) >> esize, esize, false, &mut qc)
            },
            _ => 0,
        };
        result = with_elem(result, e, esize, r);
    }
    set_vreg(d, result);
    if qc {
        set_qc();
    }
    Flow::Next
}

/// AdvSIMD three different (vector and scalar): long, wide and narrow
pub fn three_different(word: u32) -> Flow {
    let (d, n, m) = regs(word);
    let scalar = word >> 28 & 1 != 0;
    let u = word >> 29 & 1;
    let unsigned = u == 1;
    let size = bits(word, 23, 22);
    let opcode = bits(word, 15, 12);
    let esize = 8 << size;
    let (a, b, c) = (vreg(n), vreg(m), vreg(d));
    if opcode == 0b1110 {
        // PMULL, PMULL2
        if size == 3 {
            set_vreg(d, pmul(half(a, word), half(b, word), 64));
        }
        else {
            let (x, y) = (half(a, word), half(b, word));
            let mut result = 0u128;
            for e in 0..8 {
                result = with_elem(
                    result,
                    e,
                    16,
                    pmul(elem(x as u128, e, 8), elem(y as u128, e, 8), 8) as u64,
                );
            }
            set_vreg(d, result);
        }
        return Flow::Next;
    }
    let elements = if scalar { 1 } else { 64 / esize };
    let mut qc = false;
    if matches!(opcode, 0b0100 | 0b0110) {
        // ADDHN, RADDHN, SUBHN, RSUBHN: the high halves of wide sums
        let mut result = 0u64;
        for e in 0..elements {
            let (x, y) = (elem(a, e, 2 * esize) as u128, elem(b, e, 2 * esize) as u128);
            let round = if unsigned { 1u128 << (esize - 1) } else { 0 };
            let sum = if opcode == 0b0100 { x.wrapping_add(y) } else { x.wrapping_sub(y) }
                .wrapping_add(round);
            result |= ((sum >> esize) as u64 & ones(esize)) << (e * esize);
        }
        write_narrow(d, word, result);
        return Flow::Next;
    }
    let (x_half, y_half) = if scalar {
        (a as u64 as u128, b as u64 as u128)
    }
    else {
        (half(a, word) as u128, half(b, word) as u128)
    };
    let mut result = 0u128;
    for e in 0..elements {
        let wide_x = if matches!(opcode, 0b0001 | 0b0011) {
            int(elem(a, e, 2 * esize), 2 * esize, unsigned)
        }
        else {
            int(elem(x_half, e, esize), esize, unsigned)
        };
        let y = int(elem(y_half, e, esize), esize, unsigned);
        let acc = int(elem(c, e, 2 * esize), 2 * esize, unsigned);
        let w = 2 * esize;
        let r = match opcode {
            0b0000 | 0b0001 => (wide_x + y) as u64,
            0b0010 | 0b0011 => (wide_x - y) as u64,
            0b0101 => (acc + (wide_x - y).abs()) as u64,
            0b0111 => (wide_x - y).abs() as u64,
            0b1000 => (acc + wide_x * y) as u64,
            0b1010 => (acc - wide_x * y) as u64,
            0b1100 => (wide_x * y) as u64,
            // SQDMLAL, SQDMLSL, SQDMULL
            _ => {
                let product = sat(2 * wide_x * y, w, false, &mut qc);
                let product = sext(product, w) as i128;
                let acc = sext(elem(c, e, w), w) as i128;
                match opcode {
                    0b1001 => sat(acc + product, w, false, &mut qc),
                    0b1011 => sat(acc - product, w, false, &mut qc),
                    _ => product as u64,
                }
            },
        };
        result = with_elem(result, e, w, r);
    }
    set_vreg(d, result);
    if qc {
        set_qc();
    }
    Flow::Next
}

/// AdvSIMD two-register miscellaneous (vector and scalar), integer
pub fn two_misc(word: u32) -> Flow {
    let (d, n, _) = regs(word);
    let scalar = word >> 28 & 1 != 0;
    let u = word >> 29 & 1;
    let unsigned = u == 1;
    let size = bits(word, 23, 22);
    let opcode = bits(word, 16, 12);
    let fp_class = matches!(opcode, 0b01100..=0b01111) && size >= 2 || opcode >= 0b10110;
    if fp_class {
        return crate::aarch64::simd_fp::two_misc(word);
    }
    let esize = 8 << size;
    let width = if scalar { esize } else { datasize(word) };
    let elements = width / esize;
    let (a, c) = (vreg(n), vreg(d));
    let mut qc = false;
    match (u, opcode) {
        (_, 0b00000) | (0, 0b00001) => {
            // REV64, REV32, REV16: the elements reversed within each container
            let container = match (u, opcode) {
                (0, 0b00000) => 64,
                (1, 0b00000) => 32,
                _ => 16,
            };
            let per = container / esize;
            let mut result = 0u128;
            for e in 0..elements {
                let target = e - e % per + (per - 1 - e % per);
                result = with_elem(result, target, esize, elem(a, e, esize));
            }
            set_vreg(d, result);
        },
        (_, 0b00010) | (_, 0b00110) => {
            // SADDLP, UADDLP, SADALP, UADALP
            let mut result = 0u128;
            for e in 0..elements / 2 {
                let sum = int(elem(a, 2 * e, esize), esize, unsigned)
                    + int(elem(a, 2 * e + 1, esize), esize, unsigned);
                let acc = if opcode == 0b00110 { elem(c, e, 2 * esize) as i128 } else { 0 };
                result = with_elem(result, e, 2 * esize, (acc + sum) as u64);
            }
            set_vreg(d, result);
        },
        (_, 0b10010) | (_, 0b10100) => {
            // XTN, SQXTN, UQXTN, SQXTUN: narrow (scalar: one element)
            let mut result = 0u64;
            let count = if scalar { 1 } else { 64 / esize };
            for e in 0..count {
                let x = elem(a, e, 2 * esize);
                let r = match (u, opcode) {
                    (0, 0b10010) => x & ones(esize),
                    (0, 0b10100) => sat(sext(x, 2 * esize) as i128, esize, false, &mut qc),
                    (1, 0b10100) => sat(x as i128, esize, true, &mut qc),
                    _ => sat(sext(x, 2 * esize) as i128, esize, true, &mut qc),
                };
                result |= r << (e * esize);
            }
            if scalar {
                set_vreg(d, result as u128);
            }
            else {
                write_narrow(d, word, result);
            }
        },
        (1, 0b10011) => {
            // SHLL, SHLL2
            let x = half(a, word) as u128;
            let mut result = 0u128;
            for e in 0..64 / esize {
                result = with_elem(result, e, 2 * esize, elem(x, e, esize) << esize);
            }
            set_vreg(d, result);
        },
        (1, 0b00101) => {
            // NOT (size 0), RBIT
            let result = if size == 0 {
                !a
            }
            else {
                let mut r = 0u128;
                for e in 0..16 {
                    r = with_elem(r, e, 8, (elem(a, e, 8) as u8).reverse_bits() as u64);
                }
                r
            };
            let keep = if width == 128 { u128::MAX } else { (1u128 << width) - 1 };
            set_vreg(d, result & keep);
        },
        _ => {
            let mut result = 0u128;
            for e in 0..elements {
                let x = elem(a, e, esize);
                let sx = sext(x, esize) as i128;
                let mask = ones(esize);
                let test = |t: bool| if t { mask } else { 0 };
                let r = match (u, opcode) {
                    (0, 0b00011) => sat(
                        sext(elem(c, e, esize), esize) as i128 + x as i128,
                        esize,
                        false,
                        &mut qc,
                    ),
                    (1, 0b00011) => sat(elem(c, e, esize) as i128 + sx, esize, true, &mut qc),
                    (0, 0b00100) => {
                        // CLS
                        let bits = if sx < 0 { !x & mask } else { x };
                        (bits.leading_zeros() - (64 - esize)).saturating_sub(1) as u64
                    },
                    (1, 0b00100) => (x.leading_zeros() - (64 - esize)) as u64,
                    (0, 0b00101) => x.count_ones() as u64,
                    (0, 0b00111) => sat(sx.abs(), esize, false, &mut qc),
                    (1, 0b00111) => sat(-sx, esize, false, &mut qc),
                    (0, 0b01000) => test(sx > 0),
                    (1, 0b01000) => test(sx >= 0),
                    (0, 0b01001) => test(sx == 0),
                    (1, 0b01001) => test(sx <= 0),
                    (0, 0b01010) => test(sx < 0),
                    (0, 0b01011) => sx.unsigned_abs() as u64,
                    (1, 0b01011) => (-sx) as u64,
                    _ => 0,
                };
                result = with_elem(result, e, esize, r);
            }
            set_vreg(d, result);
        },
    }
    if qc {
        set_qc();
    }
    Flow::Next
}

/// AdvSIMD across lanes
pub fn across(word: u32) -> Flow {
    let (d, n, _) = regs(word);
    let u = word >> 29 & 1;
    let unsigned = u == 1;
    let size = bits(word, 23, 22);
    let opcode = bits(word, 16, 12);
    if matches!(opcode, 0b01100 | 0b01111) {
        return crate::aarch64::simd_fp::across(word);
    }
    let esize = 8 << size;
    let elements = datasize(word) / esize;
    let a = vreg(n);
    let values = (0..elements).map(|e| int(elem(a, e, esize), esize, unsigned));
    let (result, rsize) = match opcode {
        0b00011 => (values.sum::<i128>() as u64, 2 * esize),
        0b01010 => (values.max().unwrap_or(0) as u64, esize),
        0b11010 => (values.min().unwrap_or(0) as u64, esize),
        _ => (values.sum::<i128>() as u64, esize),
    };
    set_vreg(d, (result & ones(rsize)) as u128);
    Flow::Next
}

/// AdvSIMD scalar pairwise
pub fn pairwise(word: u32) -> Flow {
    if word >> 29 & 1 != 0 {
        return crate::aarch64::simd_fp::pairwise(word);
    }
    let (d, n, _) = regs(word);
    let a = vreg(n);
    set_vreg(d, (a as u64).wrapping_add((a >> 64) as u64) as u128);
    Flow::Next
}

/// AdvSIMD copy (DUP, INS, SMOV, UMOV) and scalar DUP
pub fn copy(word: u32) -> Flow {
    let (d, n, _) = regs(word);
    let q = word >> 30 & 1 != 0;
    let imm5 = bits(word, 20, 16);
    let imm4 = bits(word, 14, 11);
    let size = imm5.trailing_zeros();
    let esize = 8 << size;
    let index = imm5 >> (size + 1);
    if word >> 28 & 1 != 0 {
        // DUP (element), scalar
        set_vreg(d, elem(vreg(n), index, esize) as u128);
        return Flow::Next;
    }
    if word >> 29 & 1 != 0 {
        // INS (element)
        let source = imm4 >> size;
        set_vreg(
            d,
            with_elem(vreg(d), index, esize, elem(vreg(n), source, esize)),
        );
        return Flow::Next;
    }
    match imm4 {
        0b0000 | 0b0001 => {
            let value = if imm4 == 0 { elem(vreg(n), index, esize) } else { xr(n) & ones(esize) };
            let mut result = 0u128;
            for e in 0..datasize(word) / esize {
                result = with_elem(result, e, esize, value);
            }
            set_vreg(d, result);
        },
        0b0011 => set_vreg(d, with_elem(vreg(d), index, esize, xr(n))),
        0b0101 => {
            let value = sext(elem(vreg(n), index, esize), esize) as u64;
            cpu::set_x(d, if q { value } else { value & 0xFFFF_FFFF });
        },
        _ => cpu::set_x(d, elem(vreg(n), index, esize)),
    }
    Flow::Next
}

/// AdvSIMDExpandImm
pub fn expand_imm(op: u32, cmode: u32, imm8: u64) -> u64 {
    let replicate = |value: u64, esize: u32| {
        let mut result = 0;
        let mut at = 0;
        while at < 64 {
            result |= value << at;
            at += esize;
        }
        result
    };
    match cmode >> 1 {
        0..=3 => replicate(imm8 << (8 * (cmode >> 1)), 32),
        4 | 5 => replicate(imm8 << (8 * (cmode >> 1 & 1)), 16),
        6 => {
            let value = if cmode & 1 == 0 { imm8 << 8 | 0xFF } else { imm8 << 16 | 0xFFFF };
            replicate(value, 32)
        },
        _ => match (cmode & 1, op) {
            (0, 0) => replicate(imm8, 8),
            (0, _) => {
                let mut result = 0;
                for i in 0..8 {
                    if imm8 >> i & 1 != 0 {
                        result |= 0xFF << (8 * i);
                    }
                }
                result
            },
            (_, 0) => {
                // FMOV (vector, immediate), single precision
                let imm32 = fp::expand_imm(imm8 as u32, 32);
                replicate(imm32, 32)
            },
            _ => fp::expand_imm(imm8 as u32, 64),
        },
    }
}

/// AdvSIMD modified immediate
pub fn modified_immediate(word: u32) -> Flow {
    let d = word & 31;
    let q = word >> 30 & 1 != 0;
    let op = word >> 29 & 1;
    let cmode = bits(word, 15, 12);
    let imm8 = (bits(word, 18, 16) << 5 | bits(word, 9, 5)) as u64;
    let imm64 = expand_imm(op, cmode, imm8);
    let imm = if q { imm64 as u128 | (imm64 as u128) << 64 } else { imm64 as u128 };
    let keep = if q { u128::MAX } else { u64::MAX as u128 };
    // ORR and BIC: cmode 0xx1, 10x1 (not 11xx)
    let orr_bic = cmode < 0b1100 && cmode & 1 == 1;
    let result = match (orr_bic, op) {
        (true, 0) => vreg(d) | imm,
        (true, _) => vreg(d) & !imm,
        // MOVI; MVNI (op 1) except the 64-bit MOVI and FMOV double (cmode 111x)
        (false, 1) if cmode < 0b1110 => !imm,
        _ => imm,
    };
    set_vreg(d, result & keep);
    Flow::Next
}

/// AdvSIMD shift by immediate (vector and scalar), integer
pub fn shift_immediate(word: u32) -> Flow {
    let opcode = bits(word, 15, 11);
    if opcode == 0b11100 || opcode == 0b11111 {
        return crate::aarch64::simd_fp::fixed_point(word);
    }
    let (d, n, _) = regs(word);
    let scalar = word >> 28 & 1 != 0;
    let u = word >> 29 & 1;
    let unsigned = u == 1;
    let immh = bits(word, 22, 19);
    let immhb = bits(word, 22, 16);
    let esize = 8 << (31 - immh.leading_zeros());
    let (a, c) = (vreg(n), vreg(d));
    let mut qc = false;
    let narrow = (0b10000..=0b10011).contains(&opcode);
    if narrow {
        // SHRN, RSHRN, SQ(R)SHRN, UQ(R)SHRN, SQ(R)SHRUN: the source elements are 2 * esize
        let shift = 2 * esize - immhb;
        let round_const = if opcode & 1 != 0 { 1i128 << (shift - 1) } else { 0 };
        let count = if scalar { 1 } else { 64 / esize };
        let mut result = 0u64;
        for e in 0..count {
            let x = elem(a, e, 2 * esize);
            let source_unsigned = u == 1 && opcode >= 0b10010;
            let shifted = (int(x, 2 * esize, source_unsigned) + round_const) >> shift;
            let r = match u {
                // SHRN, RSHRN; SQSHRN, SQRSHRN
                0 if opcode < 0b10010 => shifted as u64 & ones(esize),
                0 => sat(shifted, esize, false, &mut qc),
                // SQSHRUN, SQRSHRUN, UQSHRN, UQRSHRN
                _ => sat(shifted, esize, true, &mut qc),
            };
            result |= r << (e * esize);
        }
        if scalar {
            set_vreg(d, result as u128);
        }
        else {
            write_narrow(d, word, result);
        }
        if qc {
            set_qc();
        }
        return Flow::Next;
    }
    if opcode == 0b10100 {
        // SSHLL, USHLL
        let shift = immhb - esize;
        let x = half(a, word) as u128;
        let mut result = 0u128;
        for e in 0..64 / esize {
            let value = int(elem(x, e, esize), esize, unsigned) << shift;
            result = with_elem(result, e, 2 * esize, value as u64);
        }
        set_vreg(d, result);
        return Flow::Next;
    }
    let width = if scalar { esize } else { datasize(word) };
    let left = immhb - esize;
    let right = 2 * esize - immhb;
    let mut result = 0u128;
    for e in 0..width / esize {
        let x = elem(a, e, esize);
        let z = elem(c, e, esize);
        let value = int(x, esize, unsigned);
        let r = match (u, opcode) {
            (_, 0b00000) | (_, 0b00010) | (_, 0b00100) | (_, 0b00110) => {
                let round = opcode & 0b00100 != 0;
                let shifted = shift_by(
                    value,
                    -(right as i64),
                    esize,
                    unsigned,
                    round,
                    false,
                    &mut qc,
                );
                if opcode & 0b00010 != 0 {
                    z.wrapping_add(shifted)
                }
                else {
                    shifted
                }
            },
            (0, 0b01010) => x << left,
            (1, 0b01000) => {
                // SRI: the top `right` bits of the destination stay
                let mask = if right == esize { 0 } else { ones(esize) >> right };
                (z & !mask) | (if right == esize { 0 } else { x >> right })
            },
            (1, 0b01010) => {
                // SLI
                let mask = ones(esize) << left;
                (z & !mask) | (x << left)
            },
            (0, 0b01110) => shift_by(
                sext(x, esize) as i128,
                left as i64,
                esize,
                false,
                false,
                true,
                &mut qc,
            ),
            (1, 0b01110) => shift_by(x as i128, left as i64, esize, true, false, true, &mut qc),
            // SQSHLU: a signed value, saturated as unsigned
            _ => shift_by(
                sext(x, esize) as i128,
                left as i64,
                esize,
                true,
                false,
                true,
                &mut qc,
            ),
        };
        result = with_elem(result, e, esize, r);
    }
    set_vreg(d, result);
    if qc {
        set_qc();
    }
    Flow::Next
}

/// The element operand of a by-element instruction: (Rm, index) for an esize
pub fn indexed_operand(word: u32, esize: u32) -> (u32, u32) {
    let h = word >> 11 & 1;
    let l = word >> 21 & 1;
    let m = word >> 20 & 1;
    let rm = bits(word, 19, 16);
    match esize {
        16 => (rm, h << 2 | l << 1 | m),
        32 => (m << 4 | rm, h << 1 | l),
        _ => (m << 4 | rm, h),
    }
}

/// AdvSIMD (vector and scalar) x indexed element, integer
pub fn indexed(word: u32) -> Flow {
    let opcode = bits(word, 15, 12);
    if matches!(opcode, 0b0001 | 0b0101 | 0b1001) {
        return crate::aarch64::simd_fp::indexed(word);
    }
    let (d, n, _) = regs(word);
    let scalar = word >> 28 & 1 != 0;
    let u = word >> 29 & 1;
    let unsigned = u == 1;
    let size = bits(word, 23, 22);
    let esize = 8 << size;
    let (m, index) = indexed_operand(word, esize);
    let y = elem(vreg(m), index, esize);
    let (a, c) = (vreg(n), vreg(d));
    let mut qc = false;
    let long = matches!(opcode, 0b0010 | 0b0011 | 0b0110 | 0b0111 | 0b1010 | 0b1011);
    let mut result = 0u128;
    if long {
        let x_half = if scalar { a & ones(esize) as u128 } else { half(a, word) as u128 };
        let count = if scalar { 1 } else { 64 / esize };
        let w = 2 * esize;
        for e in 0..count {
            let x = int(elem(x_half, e, esize), esize, unsigned);
            let yv = int(y, esize, unsigned);
            let acc = int(elem(c, e, w), w, unsigned);
            let r = match (u, opcode) {
                (_, 0b0010) => (acc + x * yv) as u64,
                (_, 0b0110) => (acc - x * yv) as u64,
                (_, 0b1010) => (x * yv) as u64,
                _ => {
                    let product = sext(sat(2 * x * yv, w, false, &mut qc), w) as i128;
                    match opcode {
                        0b0011 => sat(acc + product, w, false, &mut qc),
                        0b0111 => sat(acc - product, w, false, &mut qc),
                        _ => product as u64,
                    }
                },
            };
            result = with_elem(result, e, w, r);
        }
    }
    else {
        let width = if scalar { esize } else { datasize(word) };
        for e in 0..width / esize {
            let x = elem(a, e, esize);
            let z = elem(c, e, esize);
            let r = match (u, opcode) {
                (0, 0b1000) => x.wrapping_mul(y),
                (1, 0b0000) => z.wrapping_add(x.wrapping_mul(y)),
                (1, 0b0100) => z.wrapping_sub(x.wrapping_mul(y)),
                _ => {
                    // SQDMULH, SQRDMULH
                    let (sx, sy) = (sext(x, esize) as i128, sext(y, esize) as i128);
                    let round = if opcode == 0b1101 { 1i128 << (esize - 1) } else { 0 };
                    sat((2 * sx * sy + round) >> esize, esize, false, &mut qc)
                },
            };
            result = with_elem(result, e, esize, r);
        }
    }
    set_vreg(d, result);
    if qc {
        set_qc();
    }
    Flow::Next
}

/// TBL, TBX
pub fn table(word: u32) -> Flow {
    let (d, n, m) = regs(word);
    let len = bits(word, 14, 13) + 1;
    let tbx = word >> 12 & 1 != 0;
    let bytes = datasize(word) / 8;
    let indices = vreg(m);
    let original = vreg(d);
    let mut result = 0u128;
    for i in 0..bytes {
        let index = elem(indices, i, 8) as u32;
        let byte = if index < 16 * len {
            elem(vreg((n + index / 16) % 32), index % 16, 8)
        }
        else if tbx {
            elem(original, i, 8)
        }
        else {
            0
        };
        result = with_elem(result, i, 8, byte);
    }
    set_vreg(d, result);
    Flow::Next
}

/// UZP1/2, TRN1/2, ZIP1/2
pub fn permute(word: u32) -> Flow {
    let (d, n, m) = regs(word);
    let esize = 8 << bits(word, 23, 22);
    let elements = datasize(word) / esize;
    let part = word >> 14 & 1;
    let (a, b) = (vreg(n), vreg(m));
    let mut result = 0u128;
    let pairs = elements / 2;
    match bits(word, 13, 12) {
        0b01 => {
            // UZP: the even (or odd) elements of m:n
            for e in 0..elements {
                let i = 2 * e + part;
                let value =
                    if i < elements { elem(a, i, esize) } else { elem(b, i - elements, esize) };
                result = with_elem(result, e, esize, value);
            }
        },
        0b10 => {
            for p in 0..pairs {
                result = with_elem(result, 2 * p, esize, elem(a, 2 * p + part, esize));
                result = with_elem(result, 2 * p + 1, esize, elem(b, 2 * p + part, esize));
            }
        },
        _ => {
            let base = part * pairs;
            for p in 0..pairs {
                result = with_elem(result, 2 * p, esize, elem(a, base + p, esize));
                result = with_elem(result, 2 * p + 1, esize, elem(b, base + p, esize));
            }
        },
    }
    set_vreg(d, result);
    Flow::Next
}

/// EXT
pub fn extract(word: u32) -> Flow {
    let (d, n, m) = regs(word);
    let position = bits(word, 14, 11) * 8;
    let width = datasize(word);
    let (a, b) = (vreg(n), vreg(m));
    let (low, high) = if width == 128 { (a, b) } else { (a & u64::MAX as u128 | b << 64, 0) };
    // (the 256-bit m:n, shifted right by position bits)
    let result = if position == 0 { low } else { low >> position | high << (128 - position) };
    let keep = if width == 128 { u128::MAX } else { u64::MAX as u128 };
    set_vreg(d, result & keep);
    Flow::Next
}

// ---- loads and stores

fn alignment_fault(va: u64, write: bool) -> Exception {
    Exception::DataAbort {
        iss: cpu::FSC_ALIGNMENT | (write as u32) << 6,
        far: va,
    }
}

/// Whether a 16-byte access must be aligned to 16 bytes: SCTLR_EL1.A (on
/// Device memory the two 8-byte halves need 8, as QEMU checks the pair)
#[inline(always)]
fn strict_alignment() -> bool { cpu::sctlr() & cpu::SCTLR_A != 0 }

/// Read `size` bytes (1-16) of a SIMD&FP register's load
pub fn read_vector(va: u64, size: u32) -> Result<u128, Exception> {
    if size <= 8 {
        return memory::read(va, size, false, Syndrome::NONE).map(|value| value as u128);
    }
    if strict_alignment() && va & 15 != 0 {
        return Err(alignment_fault(va, false));
    }
    let low = memory::read(va, 8, false, Syndrome::NONE)?;
    let high = memory::read(va.wrapping_add(8), 8, false, Syndrome::NONE)?;
    Ok(low as u128 | (high as u128) << 64)
}

/// A SIMD&FP store of 1-16 bytes, translated and checked (written by `commit`)
pub struct VectorStore {
    low: memory::Store,
    high: Option<memory::Store>,
}

pub fn prepare_vector_write(va: u64, size: u32) -> Result<VectorStore, Exception> {
    if size <= 8 {
        return Ok(VectorStore {
            low: memory::prepare_write(va, size, false, Syndrome::NONE)?,
            high: None,
        });
    }
    if strict_alignment() && va & 15 != 0 {
        return Err(alignment_fault(va, true));
    }
    Ok(VectorStore {
        low: memory::prepare_write(va, 8, false, Syndrome::NONE)?,
        high: Some(memory::prepare_write(
            va.wrapping_add(8),
            8,
            false,
            Syndrome::NONE,
        )?),
    })
}

impl VectorStore {
    pub fn commit(self, value: u128) -> Result<(), Exception> {
        self.low.commit(value as u64)?;
        if let Some(high) = self.high {
            high.commit((value >> 64) as u64)?;
        }
        Ok(())
    }
}

/// LD1-LD4, ST1-ST4, LD1R-LD4R
pub fn structure(word: u32) -> Result<Flow, Exception> {
    fp::check_access()?;
    let s = match simd_decode::structure(word) {
        Some(s) => s,
        None => return Err(Exception::Undefined),
    };
    let t = word & 31;
    let rn = word >> 5 & 31;
    let rm = word >> 16 & 31;
    let post = word >> 23 & 1 != 0;
    let q = word >> 30 & 1;
    let base = xr_sp(rn);
    crate::aarch64::execute::check_sp(rn, base)?;
    let esize = 8 << s.size_log;
    let ebytes = 1u64 << s.size_log;
    let (registers, mut values) = (s.registers, [0u128; 4]);
    for r in 0..registers {
        values[r as usize] = vreg((t + r) % 32);
    }
    let total;
    if let Some(index) = s.index {
        // a single structure: one element of each register
        total = ebytes * registers as u64;
        if s.load {
            let mut loaded = [0u64; 4];
            for r in 0..registers as usize {
                loaded[r] = memory::read(
                    base.wrapping_add(r as u64 * ebytes),
                    ebytes as u32,
                    false,
                    Syndrome::NONE,
                )?;
            }
            for r in 0..registers as usize {
                values[r] = with_elem(values[r], index, esize, loaded[r]);
            }
        }
        else {
            let mut stores = [None; 4];
            for r in 0..registers as usize {
                stores[r] = Some(memory::prepare_write(
                    base.wrapping_add(r as u64 * ebytes),
                    ebytes as u32,
                    false,
                    Syndrome::NONE,
                )?);
            }
            for r in 0..registers as usize {
                stores[r].unwrap().commit(elem(values[r], index, esize))?;
            }
        }
    }
    else if s.replicate {
        total = ebytes * registers as u64;
        let mut loaded = [0u64; 4];
        for r in 0..registers as usize {
            loaded[r] = memory::read(
                base.wrapping_add(r as u64 * ebytes),
                ebytes as u32,
                false,
                Syndrome::NONE,
            )?;
        }
        let elements = (64 << q) / esize;
        for r in 0..registers as usize {
            let mut value = 0u128;
            for e in 0..elements {
                value = with_elem(value, e, esize, loaded[r]);
            }
            values[r] = value;
        }
    }
    else {
        // multiple structures: element e of register r at (e * selem + r) (interleaved) or r * elements + e
        let elements = (64 << q) / esize;
        let selem = s.interleave;
        let rpt = registers / selem;
        total = ebytes * (elements * registers) as u64;
        let mut stores: [Option<memory::Store>; 64] = [None; 64];
        let mut count = 0;
        let mut loaded = [[0u64; 16]; 4];
        let mut address = base;
        for rep in 0..rpt {
            for e in 0..elements {
                for sr in 0..selem {
                    let r = (rep * selem + sr) as usize;
                    if s.load {
                        loaded[r][e as usize] =
                            memory::read(address, ebytes as u32, false, Syndrome::NONE)?;
                    }
                    else {
                        stores[count] = Some(memory::prepare_write(
                            address,
                            ebytes as u32,
                            false,
                            Syndrome::NONE,
                        )?);
                        count += 1;
                    }
                    address = address.wrapping_add(ebytes);
                }
            }
        }
        if s.load {
            for r in 0..registers as usize {
                let mut value = 0u128;
                for e in 0..elements {
                    value = with_elem(value, e, esize, loaded[r][e as usize]);
                }
                values[r] = value;
            }
        }
        else {
            let mut i = 0;
            for rep in 0..rpt {
                for e in 0..elements {
                    for sr in 0..selem {
                        let r = (rep * selem + sr) as usize;
                        stores[i].unwrap().commit(elem(values[r], e, esize))?;
                        i += 1;
                    }
                }
            }
        }
    }
    if s.load {
        let keep = if q == 1 || s.index.is_some() { u128::MAX } else { u64::MAX as u128 };
        for r in 0..registers {
            set_vreg((t + r) % 32, values[r as usize] & keep);
        }
    }
    if post {
        let offset = if rm == 31 { total } else { xr(rm) };
        cpu::set_x_sp(rn, base.wrapping_add(offset));
    }
    Ok(Flow::Next)
}
