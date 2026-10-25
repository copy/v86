//! AArch32's Advanced SIMD at EL0 (docs/aarch32-plan.md Q4.2, Q4.3): the
//! data processing groups as QEMU's neon-dp.decode divides them (three
//! registers of the same length, of different lengths, two and a scalar,
//! two and a shift amount, one and a modified immediate, VEXT, VTBL and
//! VTBX, VDUP (scalar), two registers miscellaneous), the element and
//! structure loads and stores, and the crypto instructions (AES, SHA-1,
//! SHA-256, VMULL.P64). A D register is a half of V0-V15 (a32_fp.rs), a Q
//! register an even D and the next. Floating point runs on the standard
//! FPSCR value (FZ, DN, round to nearest, FPSCR's AHP) with its flags into
//! FPSCR; saturation sets FPSCR.QC. Half precision arithmetic, RDM, the
//! dot products and BF16 are not in the profile (UNDEFINED); so are the
//! UNPREDICTABLE encodings QEMU's decoder rejects and those it takes in a
//! way of its own (registers past D31, the PC as a base).
//!
//! The decoders take A32's encodings (T32's: a32.rs and t32.rs map them),
//! the instruction's condition (T32's IT block) already passed.

use crate::aarch64::a32::reg;
use crate::aarch64::a32::set_reg;
use crate::aarch64::a32_fp::{dreg, set_dreg};
use crate::aarch64::cpu::*;
use crate::aarch64::crypto;
use crate::aarch64::execute::{self, Flow};
use crate::aarch64::fp::{self, is_inf, is_zero, Arith, Format, Fp, F32};
use crate::aarch64::memory::{self, Syndrome};
use crate::aarch64::simd::{self, elem, ones, sat, set_qc, sext, with_elem};
use crate::aarch64::state::fpcr;

// ---- registers and elements

#[inline(always)]
fn d_of(word: u32) -> u32 { (word >> 22 & 1) << 4 | (word >> 12 & 15) }
#[inline(always)]
fn n_of(word: u32) -> u32 { (word >> 7 & 1) << 4 | (word >> 16 & 15) }
#[inline(always)]
fn m_of(word: u32) -> u32 { (word >> 5 & 1) << 4 | (word & 15) }

/// D[n] (`q` false) or Q[n/2] (n even)
#[inline(always)]
fn read_vec(n: u32, q: bool) -> u128 {
    if q {
        dreg(n) as u128 | (dreg(n + 1) as u128) << 64
    }
    else {
        dreg(n) as u128
    }
}
#[inline(always)]
fn write_vec(n: u32, q: bool, value: u128) {
    set_dreg(n, value as u64);
    if q {
        set_dreg(n + 1, (value >> 64) as u64);
    }
}

/// The elements of a D (`q` false) or Q register
#[inline(always)]
fn count(q: bool, esize: u32) -> u32 { (64 << q as u32) / esize }

#[inline(always)]
fn all(condition: bool, esize: u32) -> u64 {
    if condition {
        ones(esize)
    }
    else {
        0
    }
}

/// The value replicated across 64 bits
fn replicate(value: u64, esize: u32) -> u64 {
    let value = value & ones(esize);
    let mut r = 0;
    let mut at = 0;
    while at < 64 {
        r |= value << at;
        at += esize;
    }
    r
}

/// The standard FPSCR value's environment
fn standard() -> Fp { Fp::with(unsafe { *fpcr } & fp::FPCR_AHP | fp::FPCR_DN | fp::FPCR_FZ) }

const ONE_POINT_FIVE: u64 = 0x3FC0_0000;
const TWO: u64 = 0x4000_0000;
const THREE: u64 = 0x4040_0000;

/// An odd register where a Q register is named
#[inline(always)]
fn odd(q: bool, registers: u32) -> bool { q && registers & 1 != 0 }

// ---- data processing

/// The data processing instructions (A32: 1111 001U)
pub fn data_processing(word: u32) -> Result<Flow, Exception> {
    if word & 1 << 23 == 0 {
        return three_same(word);
    }
    if word & 1 << 4 != 0 {
        if word >> 19 & 7 == 0 && word & 1 << 7 == 0 {
            return one_register_immediate(word);
        }
        return shift_immediate(word);
    }
    if word >> 20 & 3 == 3 {
        if word & 1 << 24 == 0 {
            return extract(word);
        }
        if word & 1 << 11 == 0 {
            return two_misc(word);
        }
        if word >> 10 & 3 == 0b10 {
            return table(word);
        }
        if word >> 7 & 31 == 0b11000 {
            return duplicate_scalar(word);
        }
        return Err(Exception::Undefined);
    }
    if word & 1 << 6 == 0 {
        three_different(word)
    }
    else {
        two_scalar(word)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Int3 {
    Hadd,
    Rhadd,
    Hsub,
    Qadd,
    Qsub,
    Cgt,
    Cge,
    Shl,
    Qshl,
    Rshl,
    Qrshl,
    Max,
    Min,
    Abd,
    Aba,
    Add,
    Sub,
    Tst,
    Ceq,
    Mla,
    Mls,
    Mul,
    Pmul,
    Qdmulh,
    Qrdmulh,
    Pmax,
    Pmin,
    Padd,
}

/// One element of a three-same integer operation: `n`, `m` the operands'
/// (for the shifts by register `n` is the shift), `d` the destination's
fn int3(op: Int3, n: u64, m: u64, d: u64, esize: u32, unsigned: bool, qc: &mut bool) -> u64 {
    let mask = ones(esize);
    let (x, y) = (simd::int(n, esize, unsigned), simd::int(m, esize, unsigned));
    match op {
        Int3::Hadd => ((x + y) >> 1) as u64 & mask,
        Int3::Rhadd => ((x + y + 1) >> 1) as u64 & mask,
        Int3::Hsub => ((x - y) >> 1) as u64 & mask,
        Int3::Qadd => sat(x + y, esize, unsigned, qc),
        Int3::Qsub => sat(x - y, esize, unsigned, qc),
        Int3::Cgt => all(x > y, esize),
        Int3::Cge => all(x >= y, esize),
        Int3::Shl | Int3::Qshl | Int3::Rshl | Int3::Qrshl => simd::shift_by(
            y,
            sext(n & 0xFF, 8),
            esize,
            unsigned,
            op == Int3::Rshl || op == Int3::Qrshl,
            op == Int3::Qshl || op == Int3::Qrshl,
            qc,
        ),
        Int3::Max | Int3::Pmax => x.max(y) as u64 & mask,
        Int3::Min | Int3::Pmin => x.min(y) as u64 & mask,
        Int3::Abd => (x - y).unsigned_abs() as u64 & mask,
        Int3::Aba => d.wrapping_add((x - y).unsigned_abs() as u64) & mask,
        Int3::Add | Int3::Padd => n.wrapping_add(m) & mask,
        Int3::Sub => n.wrapping_sub(m) & mask,
        Int3::Tst => all(n & m != 0, esize),
        Int3::Ceq => all(n & mask == m & mask, esize),
        Int3::Mla => d.wrapping_add(n.wrapping_mul(m)) & mask,
        Int3::Mls => d.wrapping_sub(n.wrapping_mul(m)) & mask,
        Int3::Mul => n.wrapping_mul(m) & mask,
        Int3::Pmul => simd::pmul(n, m, 8) as u64 & 0xFF,
        Int3::Qdmulh | Int3::Qrdmulh => {
            let (x, y) = (sext(n, esize) as i128, sext(m, esize) as i128);
            let round = if op == Int3::Qrdmulh { 1i128 << (esize - 1) } else { 0 };
            sat((2 * x * y + round) >> esize, esize, false, qc)
        },
    }
}

/// Three registers of the same length (bit 23 0)
fn three_same(word: u32) -> Result<Flow, Exception> {
    let (d, n, m) = (d_of(word), n_of(word), m_of(word));
    let q = word & 1 << 6 != 0;
    let u = word & 1 << 24 != 0;
    let size = word >> 20 & 3;
    let o1 = word & 1 << 4 != 0;
    let opc = word >> 8 & 15;
    if opc == 0b1100 && !o1 {
        return sha_three(word, u, size, d, n, m);
    }
    if opc >= 0b1101 || opc == 0b1100 {
        return three_same_float(word, opc, o1, u, d, n, m, q);
    }
    // the bitwise operations: size is the opcode
    if opc == 0b0001 && o1 {
        if odd(q, d | n | m) {
            return Err(Exception::Undefined);
        }
        fp::check_access()?;
        let (a, b, c) = (read_vec(n, q), read_vec(m, q), read_vec(d, q));
        let r = match (u, size) {
            (false, 0) => a & b,
            (false, 1) => a & !b,
            (false, 2) => a | b,
            (false, _) => a | !b,
            (true, 0) => a ^ b,
            (true, 1) => a & c | b & !c,
            (true, 2) => a & b | c & !b,
            (true, _) => c & b | a & !b,
        };
        write_vec(d, q, r);
        return Ok(Flow::Next);
    }
    let op = match (opc, o1, u) {
        (0b0000, false, _) => Int3::Hadd,
        (0b0000, true, _) => Int3::Qadd,
        (0b0001, false, _) => Int3::Rhadd,
        (0b0010, false, _) => Int3::Hsub,
        (0b0010, true, _) => Int3::Qsub,
        (0b0011, false, _) => Int3::Cgt,
        (0b0011, true, _) => Int3::Cge,
        (0b0100, false, _) => Int3::Shl,
        (0b0100, true, _) => Int3::Qshl,
        (0b0101, false, _) => Int3::Rshl,
        (0b0101, true, _) => Int3::Qrshl,
        (0b0110, false, _) => Int3::Max,
        (0b0110, true, _) => Int3::Min,
        (0b0111, false, _) => Int3::Abd,
        (0b0111, true, _) => Int3::Aba,
        (0b1000, false, false) => Int3::Add,
        (0b1000, false, true) => Int3::Sub,
        (0b1000, true, false) => Int3::Tst,
        (0b1000, true, true) => Int3::Ceq,
        (0b1001, false, false) => Int3::Mla,
        (0b1001, false, true) => Int3::Mls,
        (0b1001, true, false) => Int3::Mul,
        (0b1001, true, true) => Int3::Pmul,
        (0b1010, false, _) => Int3::Pmax,
        (0b1010, true, _) => Int3::Pmin,
        (0b1011, false, false) => Int3::Qdmulh,
        (0b1011, false, true) => Int3::Qrdmulh,
        (0b1011, true, false) => Int3::Padd,
        // (VQRDMLAH: RDM is not in the profile)
        _ => return Err(Exception::Undefined),
    };
    let size_ok = match op {
        Int3::Qadd | Int3::Qsub | Int3::Shl | Int3::Qshl | Int3::Rshl | Int3::Qrshl => true,
        Int3::Add | Int3::Sub => true,
        Int3::Pmul => size == 0,
        Int3::Qdmulh | Int3::Qrdmulh => size == 1 || size == 2,
        _ => size != 3,
    };
    let pairwise = matches!(op, Int3::Pmax | Int3::Pmin | Int3::Padd);
    if !size_ok || (pairwise && q) || odd(q, d | n | m) {
        return Err(Exception::Undefined);
    }
    fp::check_access()?;
    let esize = 8 << size;
    // (signed: the doubling multiplies, the U bit their rounding)
    let unsigned = u && !matches!(op, Int3::Qdmulh | Int3::Qrdmulh);
    let (a, b, c) = (read_vec(n, q), read_vec(m, q), read_vec(d, q));
    let mut qc = false;
    let mut r = 0u128;
    if pairwise {
        let half = count(false, esize) / 2;
        for i in 0..half {
            let first = int3(
                op,
                elem(a, 2 * i, esize),
                elem(a, 2 * i + 1, esize),
                0,
                esize,
                unsigned,
                &mut qc,
            );
            let second = int3(
                op,
                elem(b, 2 * i, esize),
                elem(b, 2 * i + 1, esize),
                0,
                esize,
                unsigned,
                &mut qc,
            );
            r = with_elem(r, i, esize, first);
            r = with_elem(r, i + half, esize, second);
        }
    }
    else {
        for i in 0..count(q, esize) {
            let e = int3(
                op,
                elem(a, i, esize),
                elem(b, i, esize),
                elem(c, i, esize),
                esize,
                unsigned,
                &mut qc,
            );
            r = with_elem(r, i, esize, e);
        }
    }
    if qc {
        set_qc();
    }
    write_vec(d, q, r);
    Ok(Flow::Next)
}

/// SHA1C, SHA1P, SHA1M, SHA1SU0 (U 0), SHA256H, SHA256H2, SHA256SU1 (U 1): Q registers
fn sha_three(word: u32, u: bool, size: u32, d: u32, n: u32, m: u32) -> Result<Flow, Exception> {
    if word & 1 << 6 == 0 || (d | n | m) & 1 != 0 || (u && size == 3) {
        return Err(Exception::Undefined);
    }
    fp::check_access()?;
    let (vd, vn, vm) = (read_vec(d, true), read_vec(n, true), read_vec(m, true));
    let r = match (u, size) {
        (false, 0) => crypto::sha1_hash(vd, vn as u32, vm, crypto::choose),
        (false, 1) => crypto::sha1_hash(vd, vn as u32, vm, crypto::parity),
        (false, 2) => crypto::sha1_hash(vd, vn as u32, vm, crypto::majority),
        (false, _) => crypto::sha1su0(vd, vn, vm),
        (true, 0) => crypto::sha256_hash(vd, vn, vm, true),
        (true, 1) => crypto::sha256_hash(vn, vd, vm, false),
        (true, _) => crypto::sha256su1(vd, vn, vm),
    };
    write_vec(d, true, r);
    Ok(Flow::Next)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Float3 {
    Add,
    Sub,
    Abd,
    Mla,
    Mls,
    Mul,
    Fma,
    Fms,
    Ceq,
    Cge,
    Cgt,
    Acge,
    Acgt,
    Max,
    Min,
    Maxnm,
    Minnm,
    Recps,
    Rsqrts,
    Padd,
    Pmax,
    Pmin,
}

/// VRECPS, VRSQRTS as QEMU computes them (not fused): inputs flushed,
/// infinity times zero 2 (1.5), else 2 - n * m ((3 - n * m) / 2)
fn step(fp: &mut Fp, n: u64, m: u64, sqrt: bool) -> u64 {
    let (n, m) = (fp.input::<F32>(n), fp.input::<F32>(m));
    if (is_inf::<F32>(n) && is_zero::<F32>(m)) || (is_inf::<F32>(m) && is_zero::<F32>(n)) {
        return if sqrt { ONE_POINT_FIVE } else { TWO };
    }
    let product = fp.arith::<F32>(Arith::Mul, n, m);
    if sqrt {
        let r = fp.arith::<F32>(Arith::Sub, THREE, product);
        fp.arith::<F32>(Arith::Div, r, TWO)
    }
    else {
        fp.arith::<F32>(Arith::Sub, TWO, product)
    }
}

fn float3(op: Float3, fp: &mut Fp, n: u64, m: u64, d: u64) -> u64 {
    let abs = |v: u64| v & !F32::SIGN;
    match op {
        Float3::Add | Float3::Padd => fp.arith::<F32>(Arith::Add, n, m),
        Float3::Sub => fp.arith::<F32>(Arith::Sub, n, m),
        Float3::Abd => abs(fp.arith::<F32>(Arith::Sub, n, m)),
        Float3::Mla => {
            let product = fp.arith::<F32>(Arith::Mul, n, m);
            fp.arith::<F32>(Arith::Add, d, product)
        },
        Float3::Mls => {
            let product = fp.arith::<F32>(Arith::Mul, n, m);
            fp.arith::<F32>(Arith::Sub, d, product)
        },
        Float3::Mul => fp.arith::<F32>(Arith::Mul, n, m),
        Float3::Fma => fp.mul_add::<F32>(d, n, m),
        Float3::Fms => fp.mul_add::<F32>(d, n ^ F32::SIGN, m),
        Float3::Ceq => all(fp.compare_eq::<F32>(n, m), 32),
        Float3::Cge => all(fp.compare_ge::<F32>(n, m), 32),
        Float3::Cgt => all(fp.compare_gt::<F32>(n, m), 32),
        Float3::Acge => all(fp.compare_ge::<F32>(abs(n), abs(m)), 32),
        Float3::Acgt => all(fp.compare_gt::<F32>(abs(n), abs(m)), 32),
        Float3::Max | Float3::Pmax => fp.max_min::<F32>(n, m, true, false),
        Float3::Min | Float3::Pmin => fp.max_min::<F32>(n, m, false, false),
        Float3::Maxnm => fp.max_min::<F32>(n, m, true, true),
        Float3::Minnm => fp.max_min::<F32>(n, m, false, true),
        Float3::Recps => step(fp, n, m, false),
        Float3::Rsqrts => step(fp, n, m, true),
    }
}

/// The floating-point three-same instructions (single precision; bit 20, half precision, is not in the profile)
fn three_same_float(
    word: u32,
    opc: u32,
    o1: bool,
    u: bool,
    d: u32,
    n: u32,
    m: u32,
    q: bool,
) -> Result<Flow, Exception> {
    let op21 = word & 1 << 21 != 0;
    let op = match (opc, o1, u, op21) {
        (0b1100, true, false, false) => Float3::Fma,
        (0b1100, true, false, true) => Float3::Fms,
        (0b1101, false, false, false) => Float3::Add,
        (0b1101, false, false, true) => Float3::Sub,
        (0b1101, false, true, false) => Float3::Padd,
        (0b1101, false, true, true) => Float3::Abd,
        (0b1101, true, false, false) => Float3::Mla,
        (0b1101, true, false, true) => Float3::Mls,
        (0b1101, true, true, false) => Float3::Mul,
        (0b1110, false, false, false) => Float3::Ceq,
        (0b1110, false, true, false) => Float3::Cge,
        (0b1110, false, true, true) => Float3::Cgt,
        (0b1110, true, true, false) => Float3::Acge,
        (0b1110, true, true, true) => Float3::Acgt,
        (0b1111, false, false, false) => Float3::Max,
        (0b1111, false, false, true) => Float3::Min,
        (0b1111, false, true, false) => Float3::Pmax,
        (0b1111, false, true, true) => Float3::Pmin,
        (0b1111, true, false, false) => Float3::Recps,
        (0b1111, true, false, true) => Float3::Rsqrts,
        (0b1111, true, true, false) => Float3::Maxnm,
        (0b1111, true, true, true) => Float3::Minnm,
        _ => return Err(Exception::Undefined),
    };
    let pairwise = matches!(op, Float3::Padd | Float3::Pmax | Float3::Pmin);
    if word & 1 << 20 != 0 || (pairwise && q) || odd(q, d | n | m) {
        return Err(Exception::Undefined);
    }
    fp::check_access()?;
    let (a, b, c) = (read_vec(n, q), read_vec(m, q), read_vec(d, q));
    let mut fp = standard();
    let mut r = 0u128;
    if pairwise {
        let first = float3(op, &mut fp, elem(a, 0, 32), elem(a, 1, 32), 0);
        let second = float3(op, &mut fp, elem(b, 0, 32), elem(b, 1, 32), 0);
        r = first as u128 | (second as u128) << 32;
    }
    else {
        for i in 0..count(q, 32) {
            let e = float3(op, &mut fp, elem(a, i, 32), elem(b, i, 32), elem(c, i, 32));
            r = with_elem(r, i, 32, e);
        }
    }
    fp.finish();
    write_vec(d, q, r);
    Ok(Flow::Next)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Shift {
    Shr,
    Sra,
    Rshr,
    Rsra,
    Sri,
    Shl,
    Sli,
    Qshlu,
    Qshl,
}

/// Two registers and a shift amount (bit 23 1, bit 4 1): the element size
/// is L:imm6's leading one, a right shift 2 * esize - L:imm6, a left one
/// L:imm6 - esize
fn shift_immediate(word: u32) -> Result<Flow, Exception> {
    let u = word & 1 << 24 != 0;
    let l = word & 1 << 7 != 0;
    let imm6 = word >> 16 & 63;
    let opc = word >> 8 & 15;
    let q = word & 1 << 6 != 0;
    let (d, m) = (d_of(word), m_of(word));
    let esize = if l {
        64
    }
    else if imm6 & 32 != 0 {
        32
    }
    else if imm6 & 16 != 0 {
        16
    }
    else {
        8
    };
    let imm = if l { 64 + imm6 } else { imm6 };
    let right = 2 * esize - imm;
    let left = imm - esize;
    match opc {
        0..=7 => {
            let op = match (opc, u) {
                (0, _) => Shift::Shr,
                (1, _) => Shift::Sra,
                (2, _) => Shift::Rshr,
                (3, _) => Shift::Rsra,
                (4, true) => Shift::Sri,
                (5, false) => Shift::Shl,
                (5, true) => Shift::Sli,
                (6, true) => Shift::Qshlu,
                (7, _) => Shift::Qshl,
                _ => return Err(Exception::Undefined),
            };
            if odd(q, d | m) {
                return Err(Exception::Undefined);
            }
            fp::check_access()?;
            let (a, c) = (read_vec(m, q), read_vec(d, q));
            let mask = ones(esize);
            let mut qc = false;
            let mut r = 0u128;
            for i in 0..count(q, esize) {
                let (x, old) = (elem(a, i, esize), elem(c, i, esize));
                let shr = |round: bool, qc: &mut bool| {
                    simd::shift_by(
                        simd::int(x, esize, u),
                        -(right as i64),
                        esize,
                        u,
                        round,
                        false,
                        qc,
                    )
                };
                let e = match op {
                    Shift::Shr => shr(false, &mut qc),
                    Shift::Sra => old.wrapping_add(shr(false, &mut qc)) & mask,
                    Shift::Rshr => shr(true, &mut qc),
                    Shift::Rsra => old.wrapping_add(shr(true, &mut qc)) & mask,
                    Shift::Sri => {
                        if right == esize {
                            old
                        }
                        else {
                            old & !(mask >> right) | x >> right
                        }
                    },
                    Shift::Shl => x << left & mask,
                    Shift::Sli => old & ones(left) | x << left & mask,
                    Shift::Qshlu => simd::shift_by(
                        sext(x, esize) as i128,
                        left as i64,
                        esize,
                        true,
                        false,
                        true,
                        &mut qc,
                    ),
                    Shift::Qshl => simd::shift_by(
                        simd::int(x, esize, u),
                        left as i64,
                        esize,
                        u,
                        false,
                        true,
                        &mut qc,
                    ),
                };
                r = with_elem(r, i, esize, e);
            }
            if qc {
                set_qc();
            }
            write_vec(d, q, r);
            Ok(Flow::Next)
        },
        8 | 9 => {
            // VSHRN, VRSHRN (U 0), VQSHRUN, VQRSHRUN (U 1); VQSHRN, VQRSHRN:
            // from Qm's 2 * esize elements to Dd's (bit 6: rounding)
            if l || m & 1 != 0 {
                return Err(Exception::Undefined);
            }
            fp::check_access()?;
            let round = q;
            let (source_unsigned, dest_unsigned, saturate) = match (opc, u) {
                (8, false) => (true, true, false),
                (8, true) => (false, true, true),
                (_, unsigned) => (unsigned, unsigned, true),
            };
            let a = read_vec(m, true);
            let mut qc = false;
            let mut r = 0u128;
            for i in 0..64 / esize {
                let x = simd::int(elem(a, i, 2 * esize), 2 * esize, source_unsigned);
                let shifted = (x + if round { 1i128 << (right - 1) } else { 0 }) >> right;
                let e = if saturate {
                    sat(shifted, esize, dest_unsigned, &mut qc)
                }
                else {
                    shifted as u64 & ones(esize)
                };
                r = with_elem(r, i, esize, e);
            }
            if qc {
                set_qc();
            }
            set_dreg(d, r as u64);
            Ok(Flow::Next)
        },
        10 => {
            // VSHLL (VMOVL with 0): Dm's elements widened, shifted left
            if l || q || d & 1 != 0 {
                return Err(Exception::Undefined);
            }
            fp::check_access()?;
            let a = dreg(m) as u128;
            let mut r = 0u128;
            for i in 0..64 / esize {
                let x = simd::int(elem(a, i, esize), esize, u) << left;
                r = with_elem(r, i, 2 * esize, x as u64);
            }
            write_vec(d, true, r);
            Ok(Flow::Next)
        },
        14 | 15 => {
            // VCVT between single precision and 32-bit fixed point (64 - imm6 fraction bits)
            if l || esize != 32 || odd(q, d | m) {
                return Err(Exception::Undefined);
            }
            fp::check_access()?;
            let fbits = 64 - imm6;
            let a = read_vec(m, q);
            let mut fp = standard();
            let mut r = 0u128;
            for i in 0..count(q, 32) {
                let x = elem(a, i, 32);
                let e = if opc == 14 {
                    fp.from_integer::<F32>(x, !u, 32, fbits)
                }
                else {
                    fp.to_integer::<F32>(x, !u, 32, fbits, fp::ROUND_MIN_MAG)
                };
                r = with_elem(r, i, 32, e);
            }
            fp.finish();
            write_vec(d, q, r);
            Ok(Flow::Next)
        },
        // (12, 13: half precision; 11)
        _ => Err(Exception::Undefined),
    }
}

/// AdvSIMDExpandImm as QEMU's asimd_imm_const has it: op 1 inverts the
/// 32-bit forms (VMVN, VBIC), cmode 1110 with op 1 is the byte mask
pub fn expand_imm(imm8: u32, cmode: u32, op: u32) -> u64 {
    let mut imm = imm8;
    match cmode {
        0 | 1 => {},
        2 | 3 => imm <<= 8,
        4 | 5 => imm <<= 16,
        6 | 7 => imm <<= 24,
        8 | 9 => imm |= imm << 16,
        10 | 11 => imm = imm << 8 | imm << 24,
        12 => imm = imm << 8 | 0xFF,
        13 => imm = imm << 16 | 0xFFFF,
        14 => {
            if op == 1 {
                let mut r = 0u64;
                for i in 0..8 {
                    if imm8 >> i & 1 != 0 {
                        r |= 0xFF << (8 * i);
                    }
                }
                return r;
            }
            imm |= imm << 8 | imm << 16 | imm << 24;
        },
        _ => {
            imm = (imm8 & 0x80) << 24
                | (imm8 & 0x3F) << 19
                | if imm8 & 0x40 != 0 { 0x1F << 25 } else { 1 << 30 };
        },
    }
    if op == 1 {
        imm = !imm;
    }
    imm as u64 | (imm as u64) << 32
}

/// One register and a modified immediate: VMOV, VMVN, VORR, VBIC
fn one_register_immediate(word: u32) -> Result<Flow, Exception> {
    let imm8 = (word >> 24 & 1) << 7 | (word >> 16 & 7) << 4 | word & 15;
    let cmode = word >> 8 & 15;
    let op = word >> 5 & 1;
    let q = word & 1 << 6 != 0;
    let d = d_of(word);
    if odd(q, d) || (cmode == 15 && op == 1) {
        return Err(Exception::Undefined);
    }
    fp::check_access()?;
    let imm = expand_imm(imm8, cmode, op);
    let imm = imm as u128 | (imm as u128) << 64;
    let r = if cmode & 1 == 1 && cmode < 12 {
        let current = read_vec(d, q);
        if op == 1 {
            current & imm
        }
        else {
            current | imm
        }
    }
    else {
        imm
    };
    write_vec(d, q, r);
    Ok(Flow::Next)
}

/// Three registers of different lengths (bit 23 1, size not 11, bit 6 0)
fn three_different(word: u32) -> Result<Flow, Exception> {
    let u = word & 1 << 24 != 0;
    let size = word >> 20 & 3;
    let opc = word >> 8 & 15;
    let (d, n, m) = (d_of(word), n_of(word), m_of(word));
    let esize = 8 << size;
    let wide = 2 * esize;
    let lanes = 64 / esize;
    let undefined = match opc {
        0..=3 => d & 1 != 0 || (opc & 1 != 0 && n & 1 != 0),
        4 | 6 => (n | m) & 1 != 0,
        9 | 11 | 13 => u || size == 0 || d & 1 != 0,
        14 => u || size == 1 || d & 1 != 0,
        15 => true,
        _ => d & 1 != 0,
    };
    if undefined {
        return Err(Exception::Undefined);
    }
    fp::check_access()?;
    let mut qc = false;
    match opc {
        4 | 6 => {
            // VADDHN, VSUBHN, VRADDHN, VRSUBHN (U): the high halves of Qn +- Qm
            let (a, b) = (read_vec(n, true), read_vec(m, true));
            let round = if u { 1u64 << (esize - 1) } else { 0 };
            let mut r = 0u128;
            for i in 0..lanes {
                let (x, y) = (elem(a, i, wide), elem(b, i, wide));
                let s = if opc == 4 { x.wrapping_add(y) } else { x.wrapping_sub(y) };
                r = with_elem(r, i, esize, (s.wrapping_add(round) & ones(wide)) >> esize);
            }
            set_dreg(d, r as u64);
        },
        14 => {
            // VMULL.P8, VMULL.P64
            let (a, b) = (dreg(n), dreg(m));
            let r = if size == 0 {
                let mut r = 0u128;
                for i in 0..8 {
                    r = with_elem(
                        r,
                        i,
                        16,
                        simd::pmul(a >> (8 * i) & 0xFF, b >> (8 * i) & 0xFF, 8) as u64,
                    );
                }
                r
            }
            else {
                simd::pmul(a, b, 64)
            };
            write_vec(d, true, r);
        },
        _ => {
            let a = if opc <= 3 && opc & 1 != 0 { read_vec(n, true) } else { dreg(n) as u128 };
            let b = dreg(m) as u128;
            let acc = read_vec(d, true);
            let mut r = 0u128;
            for i in 0..lanes {
                let x = if opc <= 3 && opc & 1 != 0 {
                    simd::int(elem(a, i, wide), wide, u)
                }
                else {
                    simd::int(elem(a, i, esize), esize, u)
                };
                let y = simd::int(elem(b, i, esize), esize, u);
                let z = simd::int(elem(acc, i, wide), wide, false);
                let e = match opc {
                    0 | 1 => (x + y) as u64,
                    2 | 3 => (x - y) as u64,
                    5 => (z + (x - y).abs()) as u64,
                    7 => (x - y).abs() as u64,
                    8 => (z + x * y) as u64,
                    10 => (z - x * y) as u64,
                    12 => (x * y) as u64,
                    // VQDMLAL, VQDMLSL, VQDMULL: the doubled product saturated, then the sum
                    _ => {
                        let product = sat(2 * x * y, wide, false, &mut qc);
                        let product = sext(product, wide) as i128;
                        match opc {
                            9 => sat(z + product, wide, false, &mut qc),
                            11 => sat(z - product, wide, false, &mut qc),
                            _ => product as u64,
                        }
                    },
                };
                r = with_elem(r, i, wide, e & ones(wide));
            }
            write_vec(d, true, r);
        },
    }
    if qc {
        set_qc();
    }
    Ok(Flow::Next)
}

/// Two registers and a scalar (bit 23 1, size not 11, bit 6 1): bit 24 is
/// Q for the forms that are not long, U for the long ones
fn two_scalar(word: u32) -> Result<Flow, Exception> {
    let opc = word >> 8 & 15;
    let size = word >> 20 & 3;
    let bit24 = word & 1 << 24 != 0;
    let long = matches!(opc, 2 | 3 | 6 | 7 | 10 | 11);
    let float = matches!(opc, 1 | 5 | 9);
    let q = !long && bit24;
    let u = long && bit24;
    let (d, n) = (d_of(word), n_of(word));
    let vm = m_of(word);
    let (dm, index) = if size == 1 { (vm & 7, vm >> 3) } else { (vm & 15, vm >> 4) };
    let undefined = (if float { size != 2 } else { size == 0 })
        || opc >= 14
        || (matches!(opc, 3 | 7 | 11) && u)
        || if long { d & 1 != 0 } else { odd(q, d | n) };
    if undefined {
        return Err(Exception::Undefined);
    }
    fp::check_access()?;
    let esize = 8 << size;
    let scalar = elem(dreg(dm) as u128, index, esize);
    let mut qc = false;
    if long {
        let wide = 2 * esize;
        let a = dreg(n) as u128;
        let acc = read_vec(d, true);
        let y = simd::int(scalar, esize, u);
        let mut r = 0u128;
        for i in 0..64 / esize {
            let x = simd::int(elem(a, i, esize), esize, u);
            let z = simd::int(elem(acc, i, wide), wide, false);
            let e = match opc {
                2 => (z + x * y) as u64,
                6 => (z - x * y) as u64,
                10 => (x * y) as u64,
                _ => {
                    let product = sext(sat(2 * x * y, wide, false, &mut qc), wide) as i128;
                    match opc {
                        3 => sat(z + product, wide, false, &mut qc),
                        7 => sat(z - product, wide, false, &mut qc),
                        _ => product as u64,
                    }
                },
            };
            r = with_elem(r, i, wide, e & ones(wide));
        }
        if qc {
            set_qc();
        }
        write_vec(d, true, r);
        return Ok(Flow::Next);
    }
    let (a, acc) = (read_vec(n, q), read_vec(d, q));
    let mut r = 0u128;
    let mut fp = standard();
    for i in 0..count(q, esize) {
        let (x, z) = (elem(a, i, esize), elem(acc, i, esize));
        let e = match opc {
            0 => int3(Int3::Mla, x, scalar, z, esize, false, &mut qc),
            4 => int3(Int3::Mls, x, scalar, z, esize, false, &mut qc),
            8 => int3(Int3::Mul, x, scalar, z, esize, false, &mut qc),
            12 => int3(Int3::Qdmulh, x, scalar, z, esize, false, &mut qc),
            13 => int3(Int3::Qrdmulh, x, scalar, z, esize, false, &mut qc),
            1 => float3(Float3::Mla, &mut fp, x, scalar, z),
            5 => float3(Float3::Mls, &mut fp, x, scalar, z),
            _ => float3(Float3::Mul, &mut fp, x, scalar, z),
        };
        r = with_elem(r, i, esize, e);
    }
    if float {
        fp.finish();
    }
    if qc {
        set_qc();
    }
    write_vec(d, q, r);
    Ok(Flow::Next)
}

/// VEXT: bytes from imm4 of Vm:Vn
fn extract(word: u32) -> Result<Flow, Exception> {
    let imm4 = word >> 8 & 15;
    let q = word & 1 << 6 != 0;
    let (d, n, m) = (d_of(word), n_of(word), m_of(word));
    if odd(q, d | n | m) || (!q && imm4 > 7) {
        return Err(Exception::Undefined);
    }
    fp::check_access()?;
    let shift = 8 * imm4;
    let r = if q {
        let (low, high) = (read_vec(n, true), read_vec(m, true));
        if shift == 0 {
            low
        }
        else {
            low >> shift | high << (128 - shift)
        }
    }
    else {
        ((dreg(m) as u128) << 64 | dreg(n) as u128) >> shift
    };
    write_vec(d, q, r);
    Ok(Flow::Next)
}

/// VTBL, VTBX (bit 6): Dd's bytes looked up in D[n..n+len], out of range 0 (VTBL) or Dd's
fn table(word: u32) -> Result<Flow, Exception> {
    let len = word >> 8 & 3;
    let extension = word & 1 << 6 != 0;
    let (d, n, m) = (d_of(word), n_of(word), m_of(word));
    if n + len + 1 > 32 {
        return Err(Exception::Undefined);
    }
    fp::check_access()?;
    let mut bytes = [0u8; 32];
    for i in 0..=len {
        bytes[8 * i as usize..8 * i as usize + 8].copy_from_slice(&dreg(n + i).to_le_bytes());
    }
    let (indexes, current) = (dreg(m), dreg(d));
    let size = 8 * (len + 1) as u64;
    let mut r = 0u64;
    for i in 0..8 {
        let index = indexes >> (8 * i) & 0xFF;
        let byte = if index < size {
            bytes[index as usize] as u64
        }
        else if extension {
            current >> (8 * i) & 0xFF
        }
        else {
            0
        };
        r |= byte << (8 * i);
    }
    set_dreg(d, r);
    Ok(Flow::Next)
}

/// VDUP (scalar): imm4 xxx1 a byte, xx10 a halfword, x100 a word
fn duplicate_scalar(word: u32) -> Result<Flow, Exception> {
    let imm4 = word >> 16 & 15;
    let q = word & 1 << 6 != 0;
    let (d, m) = (d_of(word), m_of(word));
    let (esize, index) = if imm4 & 1 != 0 {
        (8, imm4 >> 1)
    }
    else if imm4 & 2 != 0 {
        (16, imm4 >> 2)
    }
    else if imm4 & 4 != 0 {
        (32, imm4 >> 3)
    }
    else {
        return Err(Exception::Undefined);
    };
    if odd(q, d) {
        return Err(Exception::Undefined);
    }
    fp::check_access()?;
    let value = replicate(elem(dreg(m) as u128, index, esize), esize);
    write_vec(d, q, value as u128 | (value as u128) << 64);
    Ok(Flow::Next)
}

/// The integer leading sign bits (VCLS) of an element
fn leading_sign(x: u64, esize: u32) -> u64 {
    let v = sext(x, esize);
    let flipped = (v ^ (v >> 63)) as u64 & ones(esize);
    (flipped.leading_zeros() - (64 - esize)) as u64 - 1
}

/// Two registers, miscellaneous (bit 23 1, size 11, bit 24 1, bit 11 0):
/// size in 19:18, opc1 in 17:16, opc2 in 10:7
fn two_misc(word: u32) -> Result<Flow, Exception> {
    let size = word >> 18 & 3;
    let opc1 = word >> 16 & 3;
    let opc2 = word >> 7 & 15;
    let q = word & 1 << 6 != 0;
    let (d, m) = (d_of(word), m_of(word));
    let esize = 8 << size;
    let b6 = q;
    // the crypto and conversion forms that name Q registers or halves: their own checks
    match (opc1, opc2) {
        (0, 0b0110) | (0, 0b0111) => {
            // AESE, AESD (bit 6); AESMC, AESIMC
            if size != 0 || (d | m) & 1 != 0 {
                return Err(Exception::Undefined);
            }
            fp::check_access()?;
            let (vd, vm) = (read_vec(d, true), read_vec(m, true));
            let r = if opc2 == 0b0110 {
                crypto::aes_round(vd, vm, b6)
            }
            else {
                crypto::aes_mix(vm, b6)
            };
            write_vec(d, true, r);
            return Ok(Flow::Next);
        },
        (1, 0b0101) | (2, 0b0111) => {
            // SHA1H (bit 6 1); SHA1SU1, SHA256SU0 (bit 6)
            if size != 2 || (d | m) & 1 != 0 || (opc1 == 1 && !b6) {
                return Err(Exception::Undefined);
            }
            fp::check_access()?;
            let (vd, vm) = (read_vec(d, true), read_vec(m, true));
            let r = match (opc1, b6) {
                (1, _) => (vm as u32).rotate_left(30) as u128,
                (_, false) => crypto::sha1su1(vd, vm),
                _ => crypto::sha256su0(vd, vm),
            };
            write_vec(d, true, r);
            return Ok(Flow::Next);
        },
        (2, 0b0100) | (2, 0b0101) => {
            // VMOVN, VQMOVUN (bit 6); VQMOVN signed, unsigned (bit 6): Qm to Dd
            if size == 3 || m & 1 != 0 {
                return Err(Exception::Undefined);
            }
            fp::check_access()?;
            let a = read_vec(m, true);
            let mut qc = false;
            let mut r = 0u128;
            for i in 0..64 / esize {
                let x = elem(a, i, 2 * esize);
                let e = match (opc2, b6) {
                    (0b0100, false) => x & ones(esize),
                    (0b0100, true) => sat(sext(x, 2 * esize) as i128, esize, true, &mut qc),
                    (_, false) => sat(sext(x, 2 * esize) as i128, esize, false, &mut qc),
                    _ => sat(x as i128, esize, true, &mut qc),
                };
                r = with_elem(r, i, esize, e);
            }
            if qc {
                set_qc();
            }
            set_dreg(d, r as u64);
            return Ok(Flow::Next);
        },
        (2, 0b0110) => {
            // VSHLL (by the element size): Dm to Qd
            if b6 || size == 3 || d & 1 != 0 {
                return Err(Exception::Undefined);
            }
            fp::check_access()?;
            let a = dreg(m) as u128;
            let mut r = 0u128;
            for i in 0..64 / esize {
                r = with_elem(r, i, 2 * esize, elem(a, i, esize) << esize);
            }
            write_vec(d, true, r);
            return Ok(Flow::Next);
        },
        (2, 0b1100) | (2, 0b1110) => {
            // VCVT.F16.F32 (Qm to Dd), VCVT.F32.F16 (Dm to Qd); bit 6: BF16, not in the profile
            if b6 || size != 1 || (opc2 == 0b1100 && m & 1 != 0) || (opc2 == 0b1110 && d & 1 != 0) {
                return Err(Exception::Undefined);
            }
            fp::check_access()?;
            let mut fp = standard();
            if opc2 == 0b1100 {
                let a = read_vec(m, true);
                let mut r = 0u64;
                for i in 0..4 {
                    r |= (fp.to_half(elem(a, i, 32), 32) as u64) << (16 * i);
                }
                fp.finish();
                set_dreg(d, r);
            }
            else {
                let a = dreg(m);
                let mut r = 0u128;
                for i in 0..4 {
                    r = with_elem(r, i, 32, fp.from_half((a >> (16 * i)) as u16, 32));
                }
                fp.finish();
                write_vec(d, true, r);
            }
            return Ok(Flow::Next);
        },
        _ => {},
    }
    // the element-wise and permuting forms on D or Q
    if odd(q, d | m) {
        return Err(Exception::Undefined);
    }
    let (a, c) = (read_vec(m, q), read_vec(d, q));
    let lanes = count(q, esize);
    match (opc1, opc2) {
        (0, 0b0000) | (0, 0b0001) | (0, 0b0010) => {
            // VREV64, VREV32, VREV16: the elements reversed within 64, 32, 16 bits
            let container = [64, 32, 16][opc2 as usize];
            if esize >= container {
                return Err(Exception::Undefined);
            }
            fp::check_access()?;
            let per = container / esize;
            let mut r = 0u128;
            for i in 0..lanes {
                let j = i / per * per + (per - 1 - i % per);
                r = with_elem(r, i, esize, elem(a, j, esize));
            }
            write_vec(d, q, r);
            Ok(Flow::Next)
        },
        (0, 0b0100) | (0, 0b0101) | (0, 0b1100) | (0, 0b1101) => {
            // VPADDL, VPADAL (signed, unsigned): adjacent pairs widened and added
            if size == 3 {
                return Err(Exception::Undefined);
            }
            fp::check_access()?;
            let unsigned = opc2 & 1 != 0;
            let accumulate = opc2 & 8 != 0;
            let wide = 2 * esize;
            let mut r = 0u128;
            for i in 0..lanes / 2 {
                let sum = simd::int(elem(a, 2 * i, esize), esize, unsigned)
                    + simd::int(elem(a, 2 * i + 1, esize), esize, unsigned);
                let e = if accumulate {
                    (sum as u64).wrapping_add(elem(c, i, wide))
                }
                else {
                    sum as u64
                };
                r = with_elem(r, i, wide, e);
            }
            write_vec(d, q, r);
            Ok(Flow::Next)
        },
        (0, 0b1010) | (0, 0b1011) | (2, 0b0000) if size != 0 => Err(Exception::Undefined),
        (0, 0b1000)
        | (0, 0b1001)
        | (0, 0b1010)
        | (0, 0b1011)
        | (0, 0b1110)
        | (0, 0b1111)
        | (1, 0..=4)
        | (1, 6)
        | (1, 7) => {
            // VCLS, VCLZ, VCNT (bytes), VMVN (bytes), VQABS, VQNEG; compares with
            // zero, VABS, VNEG (integer)
            if size == 3 {
                return Err(Exception::Undefined);
            }
            fp::check_access()?;
            let mut qc = false;
            let mut r = 0u128;
            for i in 0..lanes {
                let x = elem(a, i, esize);
                let v = sext(x, esize) as i128;
                let e = match (opc1, opc2) {
                    (0, 0b1000) => leading_sign(x, esize),
                    (0, 0b1001) => (x.leading_zeros() - (64 - esize)) as u64,
                    (0, 0b1010) => x.count_ones() as u64,
                    (0, 0b1011) => !x & 0xFF,
                    (0, 0b1110) => sat(v.abs(), esize, false, &mut qc),
                    (0, _) => sat(-v, esize, false, &mut qc),
                    (1, 0) => all(v > 0, esize),
                    (1, 1) => all(v >= 0, esize),
                    (1, 2) => all(v == 0, esize),
                    (1, 3) => all(v <= 0, esize),
                    (1, 4) => all(v < 0, esize),
                    (1, 6) => v.unsigned_abs() as u64 & ones(esize),
                    _ => (v.wrapping_neg()) as u64 & ones(esize),
                };
                r = with_elem(r, i, esize, e);
            }
            if qc {
                set_qc();
            }
            write_vec(d, q, r);
            Ok(Flow::Next)
        },
        (2, 0b0000) => {
            // VSWP
            fp::check_access()?;
            write_vec(d, q, a);
            write_vec(m, q, c);
            Ok(Flow::Next)
        },
        (2, 0b0001) => {
            // VTRN: Dd's odd elements and Dm's even ones exchanged (d = m: UNPREDICTABLE)
            if size == 3 || d == m {
                return Err(Exception::Undefined);
            }
            fp::check_access()?;
            let (mut rd, mut rm) = (c, a);
            for i in (0..lanes).step_by(2) {
                rd = with_elem(rd, i + 1, esize, elem(a, i, esize));
                rm = with_elem(rm, i, esize, elem(c, i + 1, esize));
            }
            write_vec(d, q, rd);
            write_vec(m, q, rm);
            Ok(Flow::Next)
        },
        (2, 0b0010) | (2, 0b0011) => {
            // VUZP, VZIP: on D, bytes and halfwords; on Q, words too (d = m: UNPREDICTABLE)
            if size == 3 || (!q && size == 2) || d == m {
                return Err(Exception::Undefined);
            }
            fp::check_access()?;
            let (mut rd, mut rm) = (0u128, 0u128);
            for i in 0..lanes {
                // (the pair as one vector: Dd's elements, then Dm's)
                let source =
                    |k: u32| if k < lanes { elem(c, k, esize) } else { elem(a, k - lanes, esize) };
                let e = if opc2 == 0b0010 {
                    source(2 * i)
                }
                else {
                    let k = i / 2;
                    if i % 2 == 0 {
                        elem(c, k, esize)
                    }
                    else {
                        elem(a, k, esize)
                    }
                };
                let f = if opc2 == 0b0010 {
                    source(2 * i + 1)
                }
                else {
                    let k = (i + lanes) / 2;
                    if i % 2 == 0 {
                        elem(c, k, esize)
                    }
                    else {
                        elem(a, k, esize)
                    }
                };
                rd = with_elem(rd, i, esize, e);
                rm = with_elem(rm, i, esize, f);
            }
            write_vec(d, q, rd);
            write_vec(m, q, rm);
            Ok(Flow::Next)
        },
        (1, 0b1000..=0b1100)
        | (1, 0b1110)
        | (1, 0b1111)
        | (2, 0b1000..=0b1011)
        | (2, 0b1101)
        | (2, 0b1111)
        | (3, _) => {
            // single precision: compares with zero, VABS, VNEG; VRINT*; VCVT{A,N,P,M}; the estimates; the conversions
            if size != 2 {
                return Err(Exception::Undefined);
            }
            fp::check_access()?;
            let mut fp = standard();
            let mut r = 0u128;
            for i in 0..lanes {
                let x = elem(a, i, 32);
                let e = match (opc1, opc2) {
                    (1, 0b1000) => all(fp.compare_gt::<F32>(x, 0), 32),
                    (1, 0b1001) => all(fp.compare_ge::<F32>(x, 0), 32),
                    (1, 0b1010) => all(fp.compare_eq::<F32>(x, 0), 32),
                    (1, 0b1011) => all(fp.compare_ge::<F32>(0, x), 32),
                    (1, 0b1100) => all(fp.compare_gt::<F32>(0, x), 32),
                    (1, 0b1110) => x & !F32::SIGN,
                    (1, _) => x ^ F32::SIGN,
                    (2, 0b1001) => fp.round_to_int::<F32>(x, fp::ROUND_NEAR_EVEN, true),
                    (2, _) => {
                        let mode = match opc2 {
                            0b1000 => fp::ROUND_NEAR_EVEN,
                            0b1010 => fp::ROUND_NEAR_MAX_MAG,
                            0b1011 => fp::ROUND_MIN_MAG,
                            0b1101 => fp::ROUND_MIN,
                            _ => fp::ROUND_MAX,
                        };
                        fp.round_to_int::<F32>(x, mode, false)
                    },
                    (_, 0..=7) => {
                        let mode = [
                            fp::ROUND_NEAR_MAX_MAG,
                            fp::ROUND_NEAR_EVEN,
                            fp::ROUND_MAX,
                            fp::ROUND_MIN,
                        ][(opc2 >> 1) as usize];
                        fp.to_integer::<F32>(x, opc2 & 1 == 0, 32, 0, mode)
                    },
                    (_, 0b1000) => {
                        // VRECPE (unsigned)
                        if x >> 31 == 0 {
                            0xFFFF_FFFF
                        }
                        else {
                            (fp::recip_estimate((x >> 23) as u32 & 0x1FF) as u64) << 23
                        }
                    },
                    (_, 0b1001) => {
                        // VRSQRTE (unsigned)
                        if x >> 30 == 0 {
                            0xFFFF_FFFF
                        }
                        else {
                            (fp::recip_sqrt_estimate((x >> 23) as u32 & 0x1FF) as u64) << 23
                        }
                    },
                    (_, 0b1010) => fp.recip_estimate::<F32>(x),
                    (_, 0b1011) => fp.recip_sqrt_estimate::<F32>(x),
                    (_, 0b1100) => fp.from_integer::<F32>(x, true, 32, 0),
                    (_, 0b1101) => fp.from_integer::<F32>(x, false, 32, 0),
                    (_, 0b1110) => fp.to_integer::<F32>(x, true, 32, 0, fp::ROUND_MIN_MAG),
                    _ => fp.to_integer::<F32>(x, false, 32, 0, fp::ROUND_MIN_MAG),
                };
                r = with_elem(r, i, 32, e);
            }
            fp.finish();
            write_vec(d, q, r);
            Ok(Flow::Next)
        },
        _ => Err(Exception::Undefined),
    }
}

// ---- loads and stores

/// One element's access (MemU: SCTLR.A and Device memory check it)
fn load_element(address: u32, bytes: u32) -> Result<u64, Exception> {
    memory::read(address as u64, bytes, false, Syndrome::NONE)
}

/// The alignment the instruction asks for, of its first access
fn check_alignment(address: u32, alignment: u32, write: bool) -> Result<(), Exception> {
    if alignment > 1 && address & (alignment - 1) != 0 {
        return Err(execute::alignment(address as u64, write, Syndrome::NONE));
    }
    Ok(())
}

/// VLDn, VSTn (A32: 1111 0100, bit 20 0): bit 23 multiple structures, else
/// one lane or all lanes; Rm 15 no writeback, 13 the size transferred,
/// else Rn + Rm. Every access translates before anything is written.
pub fn load_store(word: u32) -> Result<Flow, Exception> {
    let rn = word >> 16 & 15;
    let rm = word & 15;
    let d = d_of(word);
    let load = word & 1 << 21 != 0;
    if word & 1 << 20 != 0 || rn == 15 {
        return Err(Exception::Undefined);
    }
    // the elements: (D register, lane, element bytes) in memory order; a
    // load to all lanes replicates into each register
    let mut elements: [(u8, u8); 64] = [(0, 0); 64];
    let mut used = 0;
    let (ebytes, alignment, all_lanes, transferred) = if word & 1 << 23 == 0 {
        let itype = word >> 8 & 15;
        let size = word >> 6 & 3;
        let align = word >> 4 & 3;
        const TYPES: [(u32, u32, u32); 11] = [
            (1, 4, 1),
            (1, 4, 2),
            (4, 1, 1),
            (2, 2, 2),
            (1, 3, 1),
            (1, 3, 2),
            (3, 1, 1),
            (1, 1, 1),
            (1, 2, 1),
            (1, 2, 2),
            (2, 1, 1),
        ];
        if itype > 10 || (itype & 12 == 4 && align >= 2) || (itype & 12 == 8 && align == 3) {
            return Err(Exception::Undefined);
        }
        let (registers, interleave, spacing) = TYPES[itype as usize];
        if (size == 3 && (interleave != 1 || spacing != 1))
            || d + registers - 1 + spacing * (interleave - 1) > 31
        {
            return Err(Exception::Undefined);
        }
        let ebytes = 1 << size;
        for r in 0..registers {
            for lane in 0..8 >> size {
                for x in 0..interleave {
                    elements[used] = ((d + r + spacing * x) as u8, lane as u8);
                    used += 1;
                }
            }
        }
        (
            ebytes,
            if align != 0 { 4 << align } else { 1 },
            false,
            registers * interleave * 8,
        )
    }
    else if word >> 10 & 3 == 3 {
        // to all lanes (loads alone; bit 5 T, bit 4 a)
        let registers = (word >> 8 & 3) + 1;
        let size = word >> 6 & 3;
        let (t, a) = (word & 1 << 5 != 0, word & 1 << 4 != 0);
        if !load {
            return Err(Exception::Undefined);
        }
        let (ebytes, alignment) = if size == 3 {
            if registers != 4 || !a {
                return Err(Exception::Undefined);
            }
            (4, 16)
        }
        else {
            let ebytes = 1 << size;
            let alignment = match (a, registers) {
                (false, _) => 1,
                (true, 1) if size == 0 => return Err(Exception::Undefined),
                (true, 1) => ebytes,
                (true, 2) => 2 * ebytes,
                (true, 3) => return Err(Exception::Undefined),
                (true, _) => {
                    if size == 2 {
                        8
                    }
                    else {
                        4 * ebytes
                    }
                },
            };
            (ebytes, alignment)
        };
        let stride = if t { 2 } else { 1 };
        // (VLD1: T writes two registers)
        let last = if registers == 1 { d + (stride - 1) } else { d + stride * (registers - 1) };
        if last > 31 {
            return Err(Exception::Undefined);
        }
        for r in 0..registers {
            elements[used] = ((d + stride * r) as u8, 0);
            used += 1;
        }
        (ebytes, alignment, true, ebytes * registers)
    }
    else {
        // one lane: the index, the register stride, the alignment by size
        let size = word >> 10 & 3;
        let registers = (word >> 8 & 3) + 1;
        let (lane, stride, align) = match size {
            0 => (word >> 5 & 7, 1, word >> 4 & 1),
            1 => (
                word >> 6 & 3,
                if word & 1 << 5 != 0 { 2 } else { 1 },
                word >> 4 & 1,
            ),
            _ => (
                word >> 7 & 1,
                if word & 1 << 6 != 0 { 2 } else { 1 },
                word >> 4 & 3,
            ),
        };
        let undefined = match registers {
            1 => {
                stride != 1 || align & (1 << size) != 0 || (size == 2 && (align == 1 || align == 2))
            },
            2 => size == 2 && align & 2 != 0,
            3 => align != 0,
            _ => size == 2 && align == 3,
        };
        if undefined || d + stride * (registers - 1) > 31 {
            return Err(Exception::Undefined);
        }
        let ebytes = 1 << size;
        let alignment = match (align, registers) {
            (0, _) => 1,
            (_, 1) => ebytes,
            (_, 2) => 2 * ebytes,
            _ => {
                if size == 2 {
                    ebytes << align
                }
                else {
                    4 * ebytes
                }
            },
        };
        for r in 0..registers {
            elements[used] = ((d + stride * r) as u8, lane as u8);
            used += 1;
        }
        (ebytes, alignment, false, ebytes * registers)
    };
    fp::check_access()?;
    let base = reg(rn);
    let writeback = match rm {
        15 => None,
        13 => Some(base.wrapping_add(transferred)),
        _ => Some(base.wrapping_add(reg(rm))),
    };
    check_alignment(base, alignment, !load)?;
    let esize = 8 * ebytes;
    if load {
        let mut values = [0u64; 64];
        for (i, value) in values.iter_mut().take(used).enumerate() {
            *value = load_element(base.wrapping_add(i as u32 * ebytes), ebytes)?;
        }
        if let Some(new_base) = writeback {
            set_reg(rn, new_base);
        }
        for (&(register, lane), &value) in elements.iter().zip(values.iter()).take(used) {
            let register = register as u32;
            if all_lanes {
                set_dreg(register, replicate(value, esize));
                if used == 1 && word & 1 << 5 != 0 {
                    set_dreg(register + 1, replicate(value, esize));
                }
            }
            else {
                set_dreg(
                    register,
                    with_elem(dreg(register) as u128, lane as u32, esize, value) as u64,
                );
            }
        }
    }
    else {
        let mut stores: [Option<(memory::Store, u64)>; 64] = [None; 64];
        for (i, &(register, lane)) in elements.iter().take(used).enumerate() {
            let address = base.wrapping_add(i as u32 * ebytes);
            let value = elem(dreg(register as u32) as u128, lane as u32, esize);
            stores[i] = Some((
                memory::prepare_write(address as u64, ebytes, false, Syndrome::NONE)?,
                value,
            ));
        }
        for store in stores.into_iter().flatten() {
            store.0.commit(store.1)?;
        }
        if let Some(new_base) = writeback {
            set_reg(rn, new_base);
        }
    }
    Ok(Flow::Next)
}
