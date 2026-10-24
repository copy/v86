//! AArch32 at EL0 (docs/aarch32-plan.md, profile v3): the A32 and T32
//! instructions of a process the AArch64 kernel runs in AArch32, interpreted.
//! R0-R14 are the low halves of X0-X14 (a write zero-extends), R15 the PC;
//! `pstate` is laid out as an AArch32 SPSR (T, ITSTATE, GE, Q, E) and NZCV
//! is in `nzcv`. An instruction that faults has written no state, as A64's:
//! loads read everything before they write a register, stores translate
//! every access before they write memory.
//!
//! The decoders (A32 here, T32 in t32.rs) call the operations below, which
//! take their operands already read (the PC as the instruction set reads it).

use crate::aarch64::cpu::*;
use crate::aarch64::decode::Inst;
use crate::aarch64::execute::{self, Flow};
use crate::aarch64::memory::{self, Syndrome};
use crate::aarch64::state::{event_register, excl_valid, tpidr_el0, tpidrro_el0};

/// The length of the instruction being executed (2 for a 16-bit T32 one):
/// its exception's return address and ESR.IL
static mut INSTRUCTION_LENGTH: u32 = 4;

#[inline(always)]
pub fn instruction_length() -> u32 { unsafe { INSTRUCTION_LENGTH } }

// ---- registers and flags

/// R[n], n < 15 (R15 is read as the instruction's address + 8 in A32, + 4 in T32: the decoders pass it)
#[inline(always)]
pub fn reg(n: u32) -> u32 { xr(n) as u32 }

/// Write R[n], n < 15: X[n] zero-extended
#[inline(always)]
pub fn set_reg(n: u32, value: u32) { set_x(n, value as u64) }

#[inline(always)]
pub fn carry() -> bool { get_nzcv() & NZCV_C != 0 }

/// N and Z of a result, C and V as given
#[inline(always)]
pub fn flags(result: u32, c: bool, v: bool) -> u32 {
    (result & 0x8000_0000) | ((result == 0) as u32) << 30 | (c as u32) << 29 | (v as u32) << 28
}

/// N and Z of a result, C as given, V kept (the logical operations)
#[inline(always)]
pub fn logical_flags(result: u32, c: bool) -> u32 { flags(result, c, get_nzcv() & NZCV_V != 0) }

/// AddWithCarry: the result, C and V
#[inline(always)]
pub fn add_with_carry(x: u32, y: u32, carry_in: bool) -> (u32, bool, bool) {
    let unsigned = x as u64 + y as u64 + carry_in as u64;
    let signed = x as i32 as i64 + y as i32 as i64 + carry_in as i64;
    let result = unsigned as u32;
    (result, unsigned >> 32 != 0, result as i32 as i64 != signed)
}

#[inline(always)]
fn set_q() { set_pstate_bits(PSTATE_Q, PSTATE_Q) }

#[inline(always)]
pub fn set_pstate_bits(mask: u32, value: u32) { set_pstate(get_pstate() & !mask | value & mask) }

#[inline(always)]
fn ge() -> u32 { get_pstate() >> 16 & 15 }

#[inline(always)]
fn set_ge(value: u32) { set_pstate_bits(PSTATE_GE, value << 16) }

#[inline(always)]
pub fn thumb() -> bool { get_pstate() & PSTATE_T != 0 }

/// ConditionPassed for `cond` with the current NZCV
#[inline(always)]
pub fn condition_passed(cond: u32) -> bool {
    let flags = get_nzcv();
    let n = flags & NZCV_N != 0;
    let z = flags & NZCV_Z != 0;
    let c = flags & NZCV_C != 0;
    let v = flags & NZCV_V != 0;
    let result = match cond >> 1 {
        0 => z,
        1 => c,
        2 => n,
        3 => v,
        4 => c && !z,
        5 => n == v,
        6 => n == v && !z,
        _ => true,
    };
    // (cond 0b1111 is "always" here: the unconditional spaces are decoded before)
    if cond & 1 != 0 && cond != 0b1111 {
        !result
    }
    else {
        result
    }
}

// ---- the shifter

pub const SHIFT_LSL: u32 = 0;
pub const SHIFT_LSR: u32 = 1;
pub const SHIFT_ASR: u32 = 2;
pub const SHIFT_ROR: u32 = 3;
pub const SHIFT_RRX: u32 = 4;

/// DecodeImmShift: an immediate shift's kind and amount (LSR and ASR #0 are
/// #32, ROR #0 is RRX)
#[inline(always)]
pub fn decode_imm_shift(kind: u32, imm5: u32) -> (u32, u32) {
    match kind {
        SHIFT_LSL => (SHIFT_LSL, imm5),
        SHIFT_LSR | SHIFT_ASR => (kind, if imm5 == 0 { 32 } else { imm5 }),
        _ => {
            if imm5 == 0 {
                (SHIFT_RRX, 1)
            }
            else {
                (SHIFT_ROR, imm5)
            }
        },
    }
}

/// Shift_C: the shifted value and the carry out
#[inline(always)]
pub fn shift_c(value: u32, kind: u32, amount: u32, carry_in: bool) -> (u32, bool) {
    if amount == 0 && kind != SHIFT_RRX {
        return (value, carry_in);
    }
    match kind {
        SHIFT_LSL => {
            if amount < 32 {
                (value << amount, value >> (32 - amount) & 1 != 0)
            }
            else if amount == 32 {
                (0, value & 1 != 0)
            }
            else {
                (0, false)
            }
        },
        SHIFT_LSR => {
            if amount < 32 {
                (value >> amount, value >> (amount - 1) & 1 != 0)
            }
            else if amount == 32 {
                (0, value >> 31 != 0)
            }
            else {
                (0, false)
            }
        },
        SHIFT_ASR => {
            if amount < 32 {
                (
                    ((value as i32) >> amount) as u32,
                    value >> (amount - 1) & 1 != 0,
                )
            }
            else {
                (((value as i32) >> 31) as u32, value >> 31 != 0)
            }
        },
        SHIFT_ROR => {
            let result = value.rotate_right(amount & 31);
            (result, result >> 31 != 0)
        },
        _ => ((carry_in as u32) << 31 | value >> 1, value & 1 != 0),
    }
}

/// ARMExpandImm_C (A32's modified immediate): the value and the carry out
#[inline(always)]
pub fn expand_imm_c(imm12: u32, carry_in: bool) -> (u32, bool) {
    let value = imm12 & 0xFF;
    let amount = 2 * (imm12 >> 8);
    if amount == 0 {
        (value, carry_in)
    }
    else {
        let result = value.rotate_right(amount);
        (result, result >> 31 != 0)
    }
}

// ---- writing the PC

/// BranchWritePC: a branch within the instruction set
#[inline(always)]
pub fn branch_to(target: u32) -> Flow {
    Flow::Jump((target & if thumb() { !1 } else { !3 }) as u64)
}

/// BXWritePC (and LoadWritePC, A32's ALUWritePC): bit 0 selects T32
#[inline(always)]
pub fn bx_write_pc(target: u32) -> Flow {
    if target & 1 != 0 {
        set_pstate_bits(PSTATE_T, PSTATE_T);
        Flow::Jump((target & !1) as u64)
    }
    else {
        set_pstate_bits(PSTATE_T, 0);
        // (A32 at an address with bit 1 set: CONSTRAINED UNPREDICTABLE, the
        // PC alignment fault QEMU takes)
        Flow::Jump(target as u64)
    }
}

/// The ALU's write of the PC: BXWritePC in A32, BranchWritePC in T32
#[inline(always)]
fn alu_write_pc(target: u32) -> Flow {
    if thumb() {
        branch_to(target)
    }
    else {
        bx_write_pc(target)
    }
}

// ---- data processing

/// The data processing operations by A32's opcode (bits 24:21; T32 maps its own)
pub const DP_AND: u32 = 0;
pub const DP_EOR: u32 = 1;
pub const DP_SUB: u32 = 2;
pub const DP_RSB: u32 = 3;
pub const DP_ADD: u32 = 4;
pub const DP_ADC: u32 = 5;
pub const DP_SBC: u32 = 6;
pub const DP_RSC: u32 = 7;
pub const DP_TST: u32 = 8;
pub const DP_TEQ: u32 = 9;
pub const DP_CMP: u32 = 10;
pub const DP_CMN: u32 = 11;
pub const DP_ORR: u32 = 12;
pub const DP_MOV: u32 = 13;
pub const DP_BIC: u32 = 14;
pub const DP_MVN: u32 = 15;
/// (T32's ORN)
pub const DP_ORN: u32 = 16;

/// A data processing operation: Rd (15: the PC) = Rn op operand, the flags
/// when `s` (the shifter's carry for the logical ones)
pub fn data_processing(
    op: u32,
    s: bool,
    rd: u32,
    n: u32,
    operand: u32,
    shifter_carry: bool,
) -> Result<Flow, Exception> {
    let c = carry();
    let (result, arithmetic) = match op {
        DP_AND | DP_TST => (n & operand, None),
        DP_EOR | DP_TEQ => (n ^ operand, None),
        DP_ORR => (n | operand, None),
        DP_ORN => (n | !operand, None),
        DP_MOV => (operand, None),
        DP_BIC => (n & !operand, None),
        DP_MVN => (!operand, None),
        DP_SUB | DP_CMP => {
            let (r, c, v) = add_with_carry(n, !operand, true);
            (r, Some((c, v)))
        },
        DP_RSB => {
            let (r, c, v) = add_with_carry(!n, operand, true);
            (r, Some((c, v)))
        },
        DP_ADD | DP_CMN => {
            let (r, c, v) = add_with_carry(n, operand, false);
            (r, Some((c, v)))
        },
        DP_ADC => {
            let (r, c, v) = add_with_carry(n, operand, c);
            (r, Some((c, v)))
        },
        DP_SBC => {
            let (r, c, v) = add_with_carry(n, !operand, c);
            (r, Some((c, v)))
        },
        _ => {
            let (r, c, v) = add_with_carry(!n, operand, c);
            (r, Some((c, v)))
        },
    };
    let compare = (DP_TST..=DP_CMN).contains(&op);
    if s || compare {
        if rd == 15 && !compare {
            // (SUBS PC, LR and the like: an exception return at PL1, UNPREDICTABLE at EL0)
            if crate::aarch64::a32_system::privileged() {
                return crate::aarch64::a32_system::exception_return(result);
            }
            return Err(Exception::Undefined);
        }
        set_nzcv(match arithmetic {
            Some((c, v)) => flags(result, c, v),
            None => logical_flags(result, shifter_carry),
        });
    }
    if compare {
        return Ok(Flow::Next);
    }
    if rd == 15 {
        return Ok(alu_write_pc(result));
    }
    set_reg(rd, result);
    Ok(Flow::Next)
}

// ---- multiplies

/// MUL, MLA, MLS (op 0, 1, 2): Rd = Rn * Rm (+ Ra, Ra -)
pub fn multiply(op: u32, s: bool, rd: u32, n: u32, m: u32, a: u32) -> Result<Flow, Exception> {
    let product = n.wrapping_mul(m);
    let result = match op {
        0 => product,
        1 => product.wrapping_add(a),
        _ => a.wrapping_sub(product),
    };
    if s {
        set_nzcv(logical_flags(result, carry()));
    }
    set_reg(rd, result);
    Ok(Flow::Next)
}

/// UMULL, UMLAL, SMULL, SMLAL, UMAAL (op 4, 5, 6, 7, 2): RdHi:RdLo
pub fn multiply_long(
    op: u32,
    s: bool,
    lo: u32,
    hi: u32,
    n: u32,
    m: u32,
) -> Result<Flow, Exception> {
    let acc = (reg(hi) as u64) << 32 | reg(lo) as u64;
    let result = match op {
        4 => n as u64 * m as u64,
        5 => (n as u64 * m as u64).wrapping_add(acc),
        6 => (n as i32 as i64 * m as i32 as i64) as u64,
        7 => ((n as i32 as i64 * m as i32 as i64) as u64).wrapping_add(acc),
        // UMAAL: Rn * Rm + RdHi + RdLo
        _ => n as u64 * m as u64 + reg(hi) as u64 + reg(lo) as u64,
    };
    if s {
        set_nzcv(
            (result >> 32) as u32 & 0x8000_0000
                | ((result == 0) as u32) << 30
                | get_nzcv() & (NZCV_C | NZCV_V),
        );
    }
    set_reg(lo, result as u32);
    set_reg(hi, (result >> 32) as u32);
    Ok(Flow::Next)
}

/// The halfword of `value` that `top` names, sign-extended
#[inline(always)]
fn half(value: u32, top: bool) -> i32 {
    if top {
        (value as i32) >> 16
    }
    else {
        value as u16 as i16 as i32
    }
}

/// SMLA<x><y>, SMUL<x><y> (op 0, 3), SMLAW<y>, SMULW<y> (op 1 with or
/// without `accumulate`), SMLAL<x><y> (op 2: RdHi rd, RdLo ra): the signed
/// halfword multiplies
pub fn multiply_halfword(
    op: u32,
    rd: u32,
    ra: u32,
    n: u32,
    m: u32,
    n_top: bool,
    m_top: bool,
    accumulate: bool,
) -> Result<Flow, Exception> {
    match op {
        0 | 3 => {
            let product = half(n, n_top) as i64 * half(m, m_top) as i64;
            let result = if op == 0 { product + reg(ra) as i32 as i64 } else { product };
            if op == 0 && result != result as i32 as i64 {
                set_q();
            }
            set_reg(rd, result as u32);
        },
        1 => {
            let product = (n as i32 as i64 * half(m, m_top) as i64) >> 16;
            let result = if accumulate { product + reg(ra) as i32 as i64 } else { product };
            if accumulate && result != result as i32 as i64 {
                set_q();
            }
            set_reg(rd, result as u32);
        },
        _ => {
            let product = half(n, n_top) as i64 * half(m, m_top) as i64;
            let acc = ((reg(rd) as u64) << 32 | reg(ra) as u64) as i64;
            let result = acc.wrapping_add(product) as u64;
            set_reg(ra, result as u32);
            set_reg(rd, (result >> 32) as u32);
        },
    }
    Ok(Flow::Next)
}

/// SMLAD, SMLSD, SMUAD, SMUSD (`ra` 15: no accumulator), SMLALD, SMLSLD
/// (`long`: RdHi rd, RdLo ra): the dual 16-bit multiplies, `swap` exchanging
/// Rm's halves
pub fn multiply_dual(
    rd: u32,
    ra: u32,
    n: u32,
    m: u32,
    subtract: bool,
    swap: bool,
    long: bool,
) -> Result<Flow, Exception> {
    let m = if swap { m.rotate_right(16) } else { m };
    let p1 = half(n, false) as i64 * half(m, false) as i64;
    let p2 = half(n, true) as i64 * half(m, true) as i64;
    let sum = if subtract { p1 - p2 } else { p1 + p2 };
    if long {
        let acc = ((reg(rd) as u64) << 32 | reg(ra) as u64) as i64;
        let result = acc.wrapping_add(sum) as u64;
        set_reg(ra, result as u32);
        set_reg(rd, (result >> 32) as u32);
    }
    else {
        let result = if ra == 15 { sum } else { sum + reg(ra) as i32 as i64 };
        if result != result as i32 as i64 {
            set_q();
        }
        set_reg(rd, result as u32);
    }
    Ok(Flow::Next)
}

/// SMMLA, SMMLS, SMMUL (`ra` 15): the most significant word, rounded with `round`
pub fn multiply_most(
    rd: u32,
    ra: u32,
    n: u32,
    m: u32,
    subtract: bool,
    round: bool,
) -> Result<Flow, Exception> {
    let product = n as i32 as i64 * m as i32 as i64;
    let acc = if ra == 15 { 0 } else { (reg(ra) as i32 as i64) << 32 };
    let mut result = if subtract { acc.wrapping_sub(product) } else { acc.wrapping_add(product) };
    if round {
        result = result.wrapping_add(0x8000_0000);
    }
    set_reg(rd, (result >> 32) as u32);
    Ok(Flow::Next)
}

/// SDIV, UDIV: division by 0 is 0 (no trap in this profile)
pub fn divide(rd: u32, n: u32, m: u32, signed: bool) -> Result<Flow, Exception> {
    let result = if m == 0 {
        0
    }
    else if signed {
        (n as i32).wrapping_div(m as i32) as u32
    }
    else {
        n / m
    };
    set_reg(rd, result);
    Ok(Flow::Next)
}

// ---- saturation

/// SignedSatQ to `bits` bits: the value and whether it saturated
#[inline(always)]
fn signed_sat(value: i64, bits: u32) -> (u32, bool) {
    let max = (1i64 << (bits - 1)) - 1;
    let min = -(1i64 << (bits - 1));
    if value > max {
        (max as u32, true)
    }
    else if value < min {
        (min as u32, true)
    }
    else {
        (value as u32, false)
    }
}

/// UnsignedSatQ to `bits` bits
#[inline(always)]
fn unsigned_sat(value: i64, bits: u32) -> (u32, bool) {
    let max = if bits >= 32 { u32::MAX as i64 } else { (1i64 << bits) - 1 };
    if value > max {
        (max as u32, true)
    }
    else if value < 0 {
        (0, true)
    }
    else {
        (value as u32, false)
    }
}

/// QADD, QSUB, QDADD, QDSUB (op 0-3): `m` + or - (`n`, or `n` doubled and saturated)
pub fn saturating_add(op: u32, rd: u32, n: u32, m: u32) -> Result<Flow, Exception> {
    let (doubled, sat1) =
        if op & 2 != 0 { signed_sat(2 * n as i32 as i64, 32) } else { (n, false) };
    let (result, sat2) = if op & 1 != 0 {
        signed_sat(m as i32 as i64 - doubled as i32 as i64, 32)
    }
    else {
        signed_sat(m as i32 as i64 + doubled as i32 as i64, 32)
    };
    if sat1 || sat2 {
        set_q();
    }
    set_reg(rd, result);
    Ok(Flow::Next)
}

/// SSAT, USAT: (Rn shifted) saturated to `bits`
pub fn saturate(rd: u32, value: u32, bits: u32, unsigned: bool) -> Result<Flow, Exception> {
    let (result, sat) = if unsigned {
        unsigned_sat(value as i32 as i64, bits)
    }
    else {
        signed_sat(value as i32 as i64, bits)
    };
    if sat {
        set_q();
    }
    set_reg(rd, result);
    Ok(Flow::Next)
}

/// SSAT16, USAT16
pub fn saturate16(rd: u32, value: u32, bits: u32, unsigned: bool) -> Result<Flow, Exception> {
    let sat =
        |h: i32| if unsigned { unsigned_sat(h as i64, bits) } else { signed_sat(h as i64, bits) };
    let (lo, s1) = sat(half(value, false));
    let (hi, s2) = sat(half(value, true));
    if s1 || s2 {
        set_q();
    }
    set_reg(rd, lo & 0xFFFF | hi << 16);
    Ok(Flow::Next)
}

// ---- parallel addition and subtraction

/// The parallel operations: `kind` 1 signed (GE), 2 signed saturating, 3
/// signed halving, 5 unsigned (GE), 6 unsigned saturating, 7 unsigned
/// halving; `op` 0 ADD16, 1 ASX, 2 SAX, 3 SUB16, 4 ADD8, 7 SUB8
pub fn parallel(kind: u32, op: u32, rd: u32, n: u32, m: u32) -> Result<Flow, Exception> {
    let unsigned = kind & 4 != 0;
    let mode = kind & 3;
    let lanes8 = op >= 4;
    let width = if lanes8 { 8 } else { 16 };
    let count = 32 / width;
    let lane = |v: u32, i: u32| -> i64 {
        let raw = v >> (i * width) & ((1 << width) - 1);
        if unsigned {
            raw as i64
        }
        else {
            ((raw << (32 - width)) as i32 >> (32 - width)) as i64
        }
    };
    let mut result = 0u32;
    let mut ge_bits = 0u32;
    for i in 0..count {
        // (ASX adds in the top lane and subtracts in the bottom, Rm's halves crossed; SAX the other way)
        let (a, b, add) = match op {
            0 | 4 => (lane(n, i), lane(m, i), true),
            3 | 7 => (lane(n, i), lane(m, i), false),
            1 => (lane(n, i), lane(m, 1 - i), i == 1),
            _ => (lane(n, i), lane(m, 1 - i), i == 0),
        };
        let sum = if add { a + b } else { a - b };
        let value = match mode {
            1 => {
                // GE: an unsigned addition's carry, an unsigned subtraction's no borrow, a signed result >= 0
                let set = if unsigned && add { sum >= 1 << width } else { sum >= 0 };
                if set {
                    ge_bits |= if lanes8 { 1 << i } else { 3 << (2 * i) };
                }
                sum as u32
            },
            2 => {
                if unsigned {
                    unsigned_sat(sum, width).0
                }
                else {
                    signed_sat(sum, width).0
                }
            },
            _ => (sum >> 1) as u32,
        };
        result |= (value & ((1 << width) - 1)) << (i * width);
    }
    if mode == 1 {
        set_ge(ge_bits);
    }
    set_reg(rd, result);
    Ok(Flow::Next)
}

/// SEL: each byte from Rn where its GE bit is set, else from Rm
pub fn select(rd: u32, n: u32, m: u32) -> Result<Flow, Exception> {
    let g = ge();
    let mut result = 0;
    for i in 0..4 {
        let byte = if g >> i & 1 != 0 { n } else { m } >> (8 * i) & 0xFF;
        result |= byte << (8 * i);
    }
    set_reg(rd, result);
    Ok(Flow::Next)
}

/// USAD8, USADA8 (`ra` 15: none)
pub fn sum_absolute(rd: u32, ra: u32, n: u32, m: u32) -> Result<Flow, Exception> {
    let mut sum = if ra == 15 { 0u32 } else { reg(ra) };
    for i in 0..4 {
        let a = (n >> (8 * i) & 0xFF) as i32;
        let b = (m >> (8 * i) & 0xFF) as i32;
        sum = sum.wrapping_add((a - b).unsigned_abs());
    }
    set_reg(rd, sum);
    Ok(Flow::Next)
}

// ---- extension, packing, bit operations

/// SXTB, SXTH, SXTB16, UXTB, UXTH, UXTB16 and their accumulating forms
/// (`n` None: no addend), Rm rotated right by `rotation`
pub fn extend(
    rd: u32,
    n: Option<u32>,
    m: u32,
    rotation: u32,
    size: u32,
    signed: bool,
    dual: bool,
) -> Result<Flow, Exception> {
    let rotated = m.rotate_right(rotation);
    let result = if dual {
        let lo = rotated & 0xFF;
        let hi = rotated >> 16 & 0xFF;
        let (lo, hi) = if signed {
            (
                lo as u8 as i8 as u32 & 0xFFFF,
                hi as u8 as i8 as u32 & 0xFFFF,
            )
        }
        else {
            (lo, hi)
        };
        match n {
            Some(n) => {
                (n as u16).wrapping_add(lo as u16) as u32
                    | (((n >> 16) as u16).wrapping_add(hi as u16) as u32) << 16
            },
            None => lo | hi << 16,
        }
    }
    else {
        let value = match (size, signed) {
            (8, true) => rotated as u8 as i8 as i32 as u32,
            (8, false) => rotated & 0xFF,
            (_, true) => rotated as u16 as i16 as i32 as u32,
            _ => rotated & 0xFFFF,
        };
        n.map_or(value, |n| n.wrapping_add(value))
    };
    set_reg(rd, result);
    Ok(Flow::Next)
}

/// PKHBT (`tb` false: Rn's bottom, Rm's top after LSL), PKHTB (Rn's top, Rm's bottom after ASR)
pub fn pack(rd: u32, n: u32, m: u32, tb: bool, shift: u32) -> Result<Flow, Exception> {
    let result = if tb {
        let (shifted, _) = shift_c(m, SHIFT_ASR, if shift == 0 { 32 } else { shift }, false);
        n & 0xFFFF_0000 | shifted & 0xFFFF
    }
    else {
        n & 0xFFFF | (m << shift) & 0xFFFF_0000
    };
    set_reg(rd, result);
    Ok(Flow::Next)
}

/// REV, REV16, REVSH, RBIT, CLZ (op 0-4)
pub fn bit_op(op: u32, rd: u32, m: u32) -> Result<Flow, Exception> {
    let result = match op {
        0 => m.swap_bytes(),
        1 => (m & 0x00FF_00FF) << 8 | (m & 0xFF00_FF00) >> 8,
        2 => (m as u16).swap_bytes() as i16 as i32 as u32,
        3 => m.reverse_bits(),
        _ => m.leading_zeros(),
    };
    set_reg(rd, result);
    Ok(Flow::Next)
}

/// SBFX, UBFX: `width` bits of Rn from `lsb`
pub fn bitfield_extract(
    rd: u32,
    n: u32,
    lsb: u32,
    width: u32,
    signed: bool,
) -> Result<Flow, Exception> {
    if lsb + width > 32 {
        // (UNPREDICTABLE: UNDEFINED, as QEMU)
        return Err(Exception::Undefined);
    }
    let shifted = n << (32 - lsb - width);
    let result =
        if signed { ((shifted as i32) >> (32 - width)) as u32 } else { shifted >> (32 - width) };
    set_reg(rd, result);
    Ok(Flow::Next)
}

/// BFI (`n` Some: Rn's low bits), BFC (None): bits lsb..=msb of Rd
pub fn bitfield_insert(rd: u32, n: Option<u32>, lsb: u32, msb: u32) -> Result<Flow, Exception> {
    if msb < lsb {
        return Err(Exception::Undefined);
    }
    let width = msb - lsb + 1;
    let mask = if width == 32 { u32::MAX } else { ((1u32 << width) - 1) << lsb };
    let value = n.map_or(0, |n| n << lsb);
    set_reg(rd, reg(rd) & !mask | value & mask);
    Ok(Flow::Next)
}

/// CRC32{B,H,W}, CRC32C{B,H,W} (size 0-2)
pub fn crc32(rd: u32, n: u32, m: u32, size: u32, castagnoli: bool) -> Result<Flow, Exception> {
    if size > 2 {
        return Err(Exception::Undefined);
    }
    let bytes = 1u32 << size;
    let poly: u32 = if castagnoli { 0x82F6_3B78 } else { 0xEDB8_8320 };
    let mut crc = n;
    for i in 0..bytes {
        crc ^= m >> (8 * i) & 0xFF;
        for _ in 0..8 {
            crc = if crc & 1 != 0 { crc >> 1 ^ poly } else { crc >> 1 };
        }
    }
    set_reg(rd, crc);
    Ok(Flow::Next)
}

// ---- status registers

/// MRS Rd, APSR: NZCVQ, GE, and as QEMU reads it at EL0 the mode, E, A, I,
/// F (not the execution state's T and IT)
pub fn mrs_apsr(rd: u32) -> Result<Flow, Exception> {
    let shown = PSTATE_Q | PSTATE_GE | PSTATE_E | PSTATE_A | PSTATE_I | PSTATE_F | 0x1F;
    set_reg(rd, get_nzcv() | get_pstate() & shown);
    Ok(Flow::Next)
}

/// MSR CPSR_<fields> (`fields` c 0, x 1, s 2, f 3): APSR's at EL0 (s and
/// f), CPSRWriteByInstr's with cpu_type arm32
pub fn msr_cpsr(value: u32, fields: u32) -> Result<Flow, Exception> {
    if a32_only() {
        crate::aarch64::a32_system::msr_cpsr(value, fields);
        return Ok(Flow::Next);
    }
    msr_apsr(fields >> 2, value)
}

/// MSR SPSR_<fields> (at PL1; UNPREDICTABLE in User and System modes, and at EL0)
pub fn msr_spsr(value: u32, fields: u32) -> Result<Flow, Exception> {
    if !crate::aarch64::a32_system::privileged() || crate::aarch64::a32_system::spsr().is_none() {
        return Err(Exception::Undefined);
    }
    crate::aarch64::a32_system::msr_spsr(value, fields);
    Ok(Flow::Next)
}

/// MRS Rd, CPSR (APSR's view at EL0) or SPSR (`spsr`, at PL1)
pub fn mrs(rd: u32, spsr: bool) -> Result<Flow, Exception> {
    use crate::aarch64::a32_system as system;
    if spsr {
        match system::spsr() {
            Some(value) if system::privileged() => set_reg(rd, value),
            _ => return Err(Exception::Undefined),
        }
        return Ok(Flow::Next);
    }
    if a32_only() {
        set_reg(rd, system::mrs_cpsr());
        return Ok(Flow::Next);
    }
    mrs_apsr(rd)
}

/// MRS Rd, <banked register> and MSR <banked register>, Rn (SYSm `sysm`,
/// `r` the SPSRs) at PL1
pub fn banked(read: bool, r: bool, sysm: u32, rd: u32) -> Result<Flow, Exception> {
    use crate::aarch64::a32_system::{self as system, *};
    if !system::privileged() {
        return Err(Exception::Undefined);
    }
    if r {
        // (SPSR_fiq, _irq, _svc, _abt, _und)
        let mode = match sysm {
            0b01110 => MODE_FIQ,
            0b10000 => MODE_IRQ,
            0b10010 => MODE_SVC,
            0b10100 => MODE_ABT,
            0b10110 => MODE_UND,
            _ => return Err(Exception::Undefined),
        };
        if read {
            set_reg(rd, system::spsr_of(mode));
        }
        else {
            system::set_spsr_of(mode, reg(rd));
        }
        return Ok(Flow::Next);
    }
    // (R8_usr-R14_usr, R8_fiq-R14_fiq, then LR and SP of IRQ, SVC, ABT, UND)
    let (mode, n) = match sysm {
        0b00000..=0b00110 => (MODE_USR, 8 + sysm),
        0b01000..=0b01110 => (MODE_FIQ, sysm),
        0b10000..=0b10111 => {
            let mode = [MODE_IRQ, MODE_SVC, MODE_ABT, MODE_UND][(sysm >> 1 & 3) as usize];
            (mode, if sysm & 1 == 0 { 14 } else { 13 })
        },
        _ => return Err(Exception::Undefined),
    };
    if read {
        set_reg(rd, system::banked_reg(mode, n));
    }
    else {
        system::set_banked_reg(mode, n, reg(rd));
    }
    Ok(Flow::Next)
}

/// MSR APSR_<mask>, value: bit 1 of `mask` NZCVQ, bit 0 GE
pub fn msr_apsr(mask: u32, value: u32) -> Result<Flow, Exception> {
    if mask & 2 != 0 {
        set_nzcv(value & 0xF000_0000);
        set_pstate_bits(PSTATE_Q, value);
    }
    if mask & 1 != 0 {
        set_pstate_bits(PSTATE_GE, value);
    }
    Ok(Flow::Next)
}

// ---- loads and stores

/// A data access's syndrome (ISV 0 for EL1: memory.rs)
#[inline(always)]
fn syndrome(size: u32) -> Syndrome {
    Syndrome {
        valid: true,
        size_log: size.trailing_zeros(),
        ..Syndrome::NONE
    }
}

/// A load of `size` bytes (1, 2, 4), zero-extended, from an address that
/// need not be aligned (MemU: unaligned to Normal memory unless SCTLR.A)
#[inline(always)]
pub fn load(address: u32, size: u32, unprivileged: bool) -> Result<u32, Exception> {
    Ok(memory::read(address as u64, size, unprivileged, syndrome(size))? as u32)
}

/// A load that must be aligned (MemA: LDRD, LDM, LDREX, LDA)
#[inline(always)]
pub(crate) fn load_aligned(address: u32, size: u32) -> Result<u32, Exception> {
    if address & (size - 1) != 0 {
        return Err(execute::alignment(address as u64, false, Syndrome::NONE));
    }
    load(address, size, false)
}

/// A store's translation, written later (nothing is written if any of an
/// instruction's accesses faults)
#[inline(always)]
pub(crate) fn prepare_store(
    address: u32,
    size: u32,
    unprivileged: bool,
    aligned: bool,
) -> Result<memory::Store, Exception> {
    if aligned && address & (size - 1) != 0 {
        return Err(execute::alignment(address as u64, true, Syndrome::NONE));
    }
    memory::prepare_write(address as u64, size, unprivileged, syndrome(size))
}

/// LDR, LDRB, LDRH, LDRSB, LDRSH and the unprivileged forms: `address` the
/// access's, `writeback` the base's new value (None: none); a load of the
/// PC branches (LoadWritePC)
pub fn load_register(
    rt: u32,
    address: u32,
    size: u32,
    signed: bool,
    rn: u32,
    writeback: Option<u32>,
    unprivileged: bool,
) -> Result<Flow, Exception> {
    let raw = load(address, size, unprivileged)?;
    let value = match (size, signed) {
        (1, true) => raw as u8 as i8 as i32 as u32,
        (2, true) => raw as u16 as i16 as i32 as u32,
        _ => raw,
    };
    if let Some(base) = writeback {
        set_reg(rn, base);
    }
    if rt == 15 {
        return Ok(bx_write_pc(value));
    }
    set_reg(rt, value);
    Ok(Flow::Next)
}

/// STR, STRB, STRH and the unprivileged forms (`value` read before the writeback)
pub fn store_register(
    value: u32,
    address: u32,
    size: u32,
    rn: u32,
    writeback: Option<u32>,
    unprivileged: bool,
) -> Result<Flow, Exception> {
    let store = prepare_store(address, size, unprivileged, false)?;
    store.commit(value as u64)?;
    if let Some(base) = writeback {
        set_reg(rn, base);
    }
    Ok(Flow::Next)
}

/// LDRD: Rt, Rt2 from two aligned words
pub fn load_dual(
    rt: u32,
    rt2: u32,
    address: u32,
    rn: u32,
    writeback: Option<u32>,
) -> Result<Flow, Exception> {
    let first = load_aligned(address, 4)?;
    let second = load_aligned(address.wrapping_add(4), 4)?;
    if let Some(base) = writeback {
        set_reg(rn, base);
    }
    set_reg(rt, first);
    set_reg(rt2, second);
    Ok(Flow::Next)
}

/// STRD
pub fn store_dual(
    first: u32,
    second: u32,
    address: u32,
    rn: u32,
    writeback: Option<u32>,
) -> Result<Flow, Exception> {
    let s1 = prepare_store(address, 4, false, true)?;
    let s2 = prepare_store(address.wrapping_add(4), 4, false, true)?;
    s1.commit(first as u64)?;
    s2.commit(second as u64)?;
    if let Some(base) = writeback {
        set_reg(rn, base);
    }
    Ok(Flow::Next)
}

/// LDM (every form): the registers of `list` from `start` up, the base's
/// writeback; the PC in the list branches
pub fn load_multiple(
    rn: u32,
    list: u32,
    start: u32,
    writeback: Option<u32>,
) -> Result<Flow, Exception> {
    let mut values = [0u32; 16];
    let mut address = start;
    for i in 0..16 {
        if list & 1 << i != 0 {
            values[i] = load_aligned(address, 4)?;
            address = address.wrapping_add(4);
        }
    }
    if let Some(base) = writeback {
        set_reg(rn, base);
    }
    for i in 0..15 {
        if list & 1 << i != 0 {
            set_reg(i as u32, values[i]);
        }
    }
    if list & 1 << 15 != 0 {
        return Ok(bx_write_pc(values[15]));
    }
    Ok(Flow::Next)
}

/// STM (every form): `pc` the value stored for the PC
pub fn store_multiple(
    rn: u32,
    list: u32,
    start: u32,
    writeback: Option<u32>,
    pc: u32,
) -> Result<Flow, Exception> {
    let mut stores: [Option<(memory::Store, u32)>; 16] = Default::default();
    let mut address = start;
    for i in 0..16u32 {
        if list & 1 << i != 0 {
            // (the base in the list: its value before the writeback)
            let value = if i == 15 { pc } else { reg(i) };
            stores[i as usize] = Some((prepare_store(address, 4, false, true)?, value));
            address = address.wrapping_add(4);
        }
    }
    for store in stores.into_iter().flatten() {
        store.0.commit(store.1 as u64)?;
    }
    if let Some(base) = writeback {
        set_reg(rn, base);
    }
    Ok(Flow::Next)
}

/// LDREX*, STREX*, LDAEX*, STLEX* (A64's exclusives: size 0 byte, 1
/// halfword, 2 word, 3 the doubleword pair), `status` the STREX result
/// register
pub fn exclusive(
    load: bool,
    size: u32,
    acquire_release: bool,
    rt: u32,
    rt2: u32,
    status: u32,
    address: u32,
    pc: u32,
) -> Result<Flow, Exception> {
    let pair = size == 3;
    unsafe { execute::STEPPED_EXCLUSIVE_LOAD = load };
    let i = Inst {
        op: crate::aarch64::decode::Op::Exclusive,
        rd: rt as u8,
        rn: 0,
        rm: status as u8,
        ra: rt2 as u8,
        sf: false,
        s: false,
        sub: load as u8 | (pair as u8) << 1 | (acquire_release as u8) << 2,
        cond: if pair { 2 } else { size as u8 },
        shift: 0,
        amount: 0,
        imm: 0,
    };
    execute::exclusive_at(&i, pc as u64, address as u64)
}

/// LDA*, STL* (size 1, 2, 4): aligned, ordered
pub fn acquire_release(load: bool, size: u32, rt: u32, address: u32) -> Result<Flow, Exception> {
    if load {
        let value = load_aligned(address, size)?;
        crate::parallel::full_fence();
        set_reg(rt, value);
    }
    else {
        let store = prepare_store(address, size, false, true)?;
        crate::parallel::full_fence();
        store.commit(reg(rt) as u64)?;
    }
    Ok(Flow::Next)
}

// ---- hints, barriers, system registers

/// The hints of A32 and T32 (NOP 0, YIELD 1, WFE 2, WFI 3, SEV 4, SEVL 5;
/// the rest are NOPs here), `cond` for a trapped WFx's syndrome
pub fn hint(hint: u32, cond: u32) -> Result<Flow, Exception> {
    // (WFx's syndrome from AArch32: CV, COND, TI)
    let wfx = |ti: u32| Exception::Trapped32 {
        ec: EC_WFX,
        iss: 1 << 24 | cond << 20 | ti,
    };
    match hint {
        1 => Ok(Flow::Yield),
        2 => unsafe {
            if *event_register != 0 {
                *event_register = 0;
                Ok(Flow::Next)
            }
            else if sctlr() & SCTLR_NTWE == 0 && el() == 0 {
                Err(wfx(1))
            }
            else {
                Ok(Flow::Wait(2))
            }
        },
        3 => {
            if sctlr() & SCTLR_NTWI == 0 && el() == 0 {
                return Err(wfx(0));
            }
            Ok(Flow::Wait(1))
        },
        4 => {
            crate::aarch64::smp::send_event();
            Ok(Flow::Next)
        },
        5 => {
            unsafe { *event_register = 1 };
            Ok(Flow::Next)
        },
        _ => Ok(Flow::Next),
    }
}

/// CLREX
pub fn clear_exclusive() -> Result<Flow, Exception> {
    unsafe { *excl_valid = 0 };
    crate::aarch64::smp::release();
    Ok(Flow::Next)
}

/// DMB, DSB, ISB (`dsb`: waits for the other cores' maintenance, as A64's)
pub fn barrier(dsb: bool) -> Result<Flow, Exception> {
    crate::parallel::full_fence();
    if dsb && !crate::aarch64::tlb::synced() {
        return Ok(Flow::Retry);
    }
    Ok(Flow::Next)
}

/// SCTLR_EL1.CP15BEN: CP15's barrier operations at EL0
const SCTLR_CP15BEN: u64 = 1 << 5;

/// The syndrome of a trapped MCR/MRC (EC 0x03, 0x05) or MCRR/MRRC (0x04, 0x0C)
fn cp_trap(
    ec: u32,
    cond: u32,
    opc1: u32,
    crn: u32,
    crm: u32,
    opc2: u32,
    rt: u32,
    rt2: u32,
    read: bool,
) -> Exception {
    let common = 1 << 24 | cond << 20 | rt << 5 | crm << 1 | read as u32;
    let iss = if ec == 0x04 || ec == 0x0C {
        common | opc1 << 16 | rt2 << 10
    }
    else {
        common | opc2 << 17 | opc1 << 14 | crn << 10
    };
    Exception::Trapped32 { ec, iss }
}

/// A trap of the AArch64 register an AArch32 one is (EC 0x18 from the
/// timer) as the AArch32 trap
fn as_cp_trap(e: Exception, trap: Exception) -> Exception {
    match e {
        Exception::SystemRegister(_) => trap,
        other => other,
    }
}

/// MRC, MCR of CP15 at EL0 (`value` what MCR writes): the thread ID
/// registers, the generic timer's, CP15's barriers; the rest UNDEFINED
pub fn cp15(
    read: bool,
    opc1: u32,
    crn: u32,
    crm: u32,
    opc2: u32,
    rt: u32,
    value: u32,
    cond: u32,
) -> Result<Flow, Exception> {
    if crate::aarch64::a32_system::privileged() {
        return crate::aarch64::a32_system::cp15(read, opc1, crn, crm, opc2, rt, value);
    }
    let trap = cp_trap(0x03, cond, opc1, crn, crm, opc2, rt, 0, read);
    match (opc1, crn, crm, opc2) {
        // TPIDRURW (TPIDR_EL0's low half), TPIDRURO (TPIDRRO_EL0's, read-only at EL0)
        (0, 13, 0, 2) => unsafe {
            if read {
                set_reg(rt, *tpidr_el0 as u32);
            }
            else {
                *tpidr_el0 = value as u64;
            }
            Ok(Flow::Next)
        },
        (0, 13, 0, 3) if read => {
            unsafe { set_reg(rt, *tpidrro_el0 as u32) };
            Ok(Flow::Next)
        },
        // CP15DMB, CP15DSB, CP15ISB (writes, with SCTLR_EL1.CP15BEN)
        (0, 7, 10, 5) | (0, 7, 10, 4) | (0, 7, 5, 4) if !read => {
            if sctlr() & SCTLR_CP15BEN == 0 {
                return Err(Exception::Undefined);
            }
            barrier(crm == 10 && opc2 == 4)
        },
        // CNTFRQ, CNTP_TVAL, CNTP_CTL, CNTV_TVAL, CNTV_CTL
        (0, 14, 0, 0) | (0, 14, 2, 0) | (0, 14, 2, 1) | (0, 14, 3, 0) | (0, 14, 3, 1) => {
            let key = crate::aarch64::sysregs::key(3, 3, 14, crm, opc2);
            if read {
                let v = crate::aarch64::timer::read(key, rt).map_err(|e| as_cp_trap(e, trap))?;
                set_reg(rt, v as u32);
            }
            else {
                crate::aarch64::timer::write(key, rt, value as u64)
                    .map_err(|e| as_cp_trap(e, trap))?;
            }
            Ok(Flow::Next)
        },
        _ => Err(Exception::Undefined),
    }
}

/// MRRC, MCRR of CP15 at EL0: the timer's 64-bit registers (CRm 14: CNTPCT
/// opc1 0, CNTVCT 1, CNTP_CVAL 2, CNTV_CVAL 3)
pub fn cp15_64(
    read: bool,
    opc1: u32,
    crm: u32,
    rt: u32,
    rt2: u32,
    value: u64,
    cond: u32,
) -> Result<Flow, Exception> {
    if crate::aarch64::a32_system::privileged() {
        return crate::aarch64::a32_system::cp15_64(read, opc1, crm, rt, rt2, value);
    }
    let trap = cp_trap(0x04, cond, opc1, 0, crm, 0, rt, rt2, read);
    if crm != 14 || opc1 > 3 {
        return Err(Exception::Undefined);
    }
    let key = match opc1 {
        0 => crate::aarch64::sysregs::key(3, 3, 14, 0, 1),
        1 => crate::aarch64::sysregs::key(3, 3, 14, 0, 2),
        2 => crate::aarch64::sysregs::key(3, 3, 14, 2, 2),
        _ => crate::aarch64::sysregs::key(3, 3, 14, 3, 2),
    };
    if read {
        let v = crate::aarch64::timer::read(key, rt).map_err(|e| as_cp_trap(e, trap))?;
        set_reg(rt, v as u32);
        set_reg(rt2, (v >> 32) as u32);
    }
    else {
        if opc1 < 2 {
            return Err(Exception::Undefined);
        }
        crate::aarch64::timer::write(key, rt, value).map_err(|e| as_cp_trap(e, trap))?;
    }
    Ok(Flow::Next)
}

// ---- fetch

/// Whether a T32 halfword starts a 32-bit instruction
#[inline(always)]
pub fn t32_wide(halfword: u32) -> bool { halfword >> 11 >= 0b11101 }

/// The T32 halfword at `address` (2-aligned)
fn fetch_halfword(address: u64) -> Result<u32, Exception> {
    let word = memory::fetch(address & !3)?;
    Ok(if address & 2 != 0 { word >> 16 } else { word & 0xFFFF })
}

/// The instruction at the PC and its length: A32's word (4-aligned), or T32's
/// halfword or two (the first in bits 31:16, as the ARM ARM writes them)
fn fetch(address: u64, thumb: bool) -> Result<(u32, u32), Exception> {
    if thumb {
        let first = fetch_halfword(address)?;
        if !t32_wide(first) {
            return Ok((first, 2));
        }
        // (the second halfword may be on the next page)
        let second = fetch_halfword((address as u32).wrapping_add(2) as u64)?;
        Ok((first << 16 | second, 4))
    }
    else {
        if address & 3 != 0 {
            return Err(Exception::PcAlignment(address));
        }
        Ok((memory::fetch(address)?, 4))
    }
}

// ---- one instruction

/// (diagnostics: crate::aarch64::jit::pages' step and helper counts) an
/// AArch32 instruction's class: A32's bits 27:20 (768 up), T32's first
/// halfword's top bits (16-bit 512 up, 32-bit 640 up)
pub fn step_key(word: u32, length: u32, thumb: bool) -> u32 {
    if !thumb {
        768 | word >> 20 & 0xFF
    }
    else if length == 2 {
        512 | word >> 9 & 0x7F
    }
    else {
        640 | word >> 20 & 0x7F
    }
}

/// An instruction fetched (`length` 4, or T32's 2 or 4) executed at `pc`
/// (the page tier's helpers too: crate::aarch64::jit::pages::a32_page_helper)
#[inline(always)]
pub fn execute_fetched(word: u32, length: u32, pc: u32, thumb: bool) -> Result<Flow, Exception> {
    unsafe { INSTRUCTION_LENGTH = length };
    if thumb {
        crate::aarch64::t32::execute(word, length, pc)
    }
    else {
        a32(word, pc)
    }
}

/// Execute the AArch32 instruction at `address` (the PC): it retires, or
/// takes its exception having written no state (execute::interpret_one's
/// contract)
pub fn interpret_one(address: u64) -> Flow {
    let thumb = thumb();
    unsafe { INSTRUCTION_LENGTH = if thumb { 2 } else { 4 } };
    let result = fetch(address, thumb).and_then(|(word, length)| {
        unsafe { INSTRUCTION_LENGTH = length };
        if unsafe { crate::aarch64::jit::pages::A32_TRACE } && crate::aarch64::cpu::el() == 0 {
            crate::aarch64::jit::pages::a32_trace(1, address as u32, word);
        }
        // (a breakpoint: BAS 1111 or 0011 the word, 1100 its second halfword)
        if unsafe { crate::aarch64::debug::ANY_BREAKPOINT } {
            if let Some(exception) = crate::aarch64::debug::check_breakpoint(address) {
                return Err(exception);
            }
        }
        // (software step's EX: whether the stepped instruction is a load exclusive)
        unsafe { execute::STEPPED_EXCLUSIVE_LOAD = false };
        unsafe { execute::LAST_STEPPED = (step_key(word, length, thumb), word) };
        execute_fetched(word, length, address as u32, thumb)
    });
    let length = instruction_length();
    match result {
        Ok(flow) => {
            crate::core_stats::add_pending(1, 0);
            match flow {
                Flow::Next | Flow::Yield | Flow::Wait(_) | Flow::Off => {
                    set_pc((address as u32).wrapping_add(length) as u64)
                },
                Flow::Jump(target) => set_pc(target),
                Flow::Set | Flow::Retry => {},
            }
            // (the IT block goes on: T32's instructions, executed or not)
            if thumb && !matches!(flow, Flow::Set | Flow::Retry) {
                crate::aarch64::t32::it_advance();
            }
            flow
        },
        Err(exception @ Exception::Svc(_)) => {
            // (the instruction executed: the exception returns after it, the
            // IT block a step on; a software step is done, SPSR.SS 0)
            crate::core_stats::add_pending(1, 0);
            if thumb {
                crate::aarch64::t32::it_advance();
            }
            if crate::aarch64::debug::stepping() {
                crate::aarch64::debug::step_done();
            }
            take_sync(exception);
            Flow::Set
        },
        Err(exception) => {
            take_sync(exception);
            Flow::Set
        },
    }
}

// ---- A32

/// An A32 register read: the PC as the instruction's address + 8
#[inline(always)]
fn a32_read(n: u32, pc: u32) -> u32 {
    if n == 15 {
        pc.wrapping_add(8)
    }
    else {
        reg(n)
    }
}

/// A32's operand 2 of a data processing instruction with an immediate
/// shift (bit 4 0) or a register shift (bit 4 1): the value, the carry
fn a32_shifted_operand(word: u32, pc: u32) -> Result<(u32, bool), Exception> {
    let rm = word & 15;
    let kind = word >> 5 & 3;
    if word & 1 << 4 == 0 {
        let (kind, amount) = decode_imm_shift(kind, word >> 7 & 31);
        Ok(shift_c(a32_read(rm, pc), kind, amount, carry()))
    }
    else {
        let rs = word >> 8 & 15;
        if rm == 15 || rs == 15 || word >> 12 & 15 == 15 || word >> 16 & 15 == 15 {
            // (a register-shifted register with the PC: UNPREDICTABLE)
            return Err(Exception::Undefined);
        }
        Ok(shift_c(reg(rm), kind, reg(rs) & 0xFF, carry()))
    }
}

/// A32: the instruction `word` at `pc`
fn a32(word: u32, pc: u32) -> Result<Flow, Exception> {
    let cond = word >> 28;
    if cond == 0b1111 {
        return a32_unconditional(word, pc);
    }
    // (UDF: cond 0b1110 only; the permanently undefined space regardless of the condition)
    if word & 0x0FF0_00F0 == 0x07F0_00F0 {
        return Err(Exception::Undefined);
    }
    if !condition_passed(cond) {
        return Ok(Flow::Next);
    }
    let rn = word >> 16 & 15;
    let rd = word >> 12 & 15;
    match word >> 25 & 7 {
        0b000 => {
            let op1 = word >> 20 & 31;
            if word & 0x90 == 0x90 {
                if word >> 5 & 3 == 0 {
                    return if word & 1 << 24 == 0 {
                        a32_multiply(word)
                    }
                    else {
                        a32_synchronization(word, pc)
                    };
                }
                return a32_extra_load_store(word, pc);
            }
            if op1 & 0b11001 == 0b10000 {
                return if word & 0x80 == 0 {
                    a32_miscellaneous(word, pc)
                }
                else {
                    a32_halfword_multiply(word)
                };
            }
            let (operand, shifter_carry) = a32_shifted_operand(word, pc)?;
            let n = if word & 1 << 4 != 0 { reg(rn) } else { a32_read(rn, pc) };
            data_processing(
                word >> 21 & 15,
                word & 1 << 20 != 0,
                rd,
                n,
                operand,
                shifter_carry,
            )
        },
        0b001 => {
            let op1 = word >> 20 & 31;
            match op1 {
                // MOVW, MOVT
                0b10000 | 0b10100 => {
                    if rd == 15 {
                        return Err(Exception::Undefined);
                    }
                    let imm16 = (word >> 4 & 0xF000) | word & 0xFFF;
                    let value = if op1 == 0b10000 { imm16 } else { reg(rd) & 0xFFFF | imm16 << 16 };
                    set_reg(rd, value);
                    Ok(Flow::Next)
                },
                // MSR (immediate) and the hints
                0b10010 | 0b10110 => {
                    if op1 == 0b10010 && rn == 0 {
                        return hint(word & 0xFF, cond);
                    }
                    let (value, _) = expand_imm_c(word & 0xFFF, carry());
                    if op1 == 0b10110 {
                        // (MSR SPSR: UNPREDICTABLE at EL0)
                        return msr_spsr(value, rn);
                    }
                    msr_cpsr(value, rn)
                },
                _ => {
                    let (operand, shifter_carry) = expand_imm_c(word & 0xFFF, carry());
                    data_processing(
                        word >> 21 & 15,
                        word & 1 << 20 != 0,
                        rd,
                        a32_read(rn, pc),
                        operand,
                        shifter_carry,
                    )
                },
            }
        },
        0b010 | 0b011 => {
            if word >> 25 & 1 != 0 && word & 1 << 4 != 0 {
                return a32_media(word);
            }
            a32_load_store(word, pc)
        },
        0b100 => a32_block_transfer(word, pc),
        0b101 => {
            let offset = ((word << 8) as i32 >> 6) as u32;
            if word & 1 << 24 != 0 {
                set_reg(14, pc.wrapping_add(4));
            }
            Ok(Flow::Jump(pc.wrapping_add(8).wrapping_add(offset) as u64))
        },
        _ => {
            // SVC: the immediate's low 16 bits are the ISS
            if word >> 24 & 15 == 15 {
                return Err(Exception::Svc(word as u16));
            }
            a32_coprocessor(word, pc, word >> 8 & 15, cond)
        },
    }
}

/// The multiplies (bits 27:24 0000, 7:4 1001)
fn a32_multiply(word: u32) -> Result<Flow, Exception> {
    let s = word & 1 << 20 != 0;
    let rd = word >> 16 & 15;
    let ra = word >> 12 & 15;
    let rm = word >> 8 & 15;
    let rn = word & 15;
    if rd == 15 || rn == 15 || rm == 15 {
        return Err(Exception::Undefined);
    }
    match word >> 21 & 7 {
        0 => multiply(0, s, rd, reg(rn), reg(rm), 0),
        1 if ra != 15 => multiply(1, s, rd, reg(rn), reg(rm), reg(ra)),
        2 if !s && ra != 15 && ra != rd => multiply_long(2, false, ra, rd, reg(rn), reg(rm)),
        3 if !s && ra != 15 => multiply(2, false, rd, reg(rn), reg(rm), reg(ra)),
        op @ 4..=7 => {
            if ra == 15 || ra == rd {
                return Err(Exception::Undefined);
            }
            multiply_long(op, s, ra, rd, reg(rn), reg(rm))
        },
        _ => Err(Exception::Undefined),
    }
}

/// The synchronization primitives (bits 27:23 00011, 7:4 1001): the
/// exclusives and load-acquire/store-release
fn a32_synchronization(word: u32, pc: u32) -> Result<Flow, Exception> {
    let size = [2, 3, 0, 1][(word >> 21 & 3) as usize];
    let load = word & 1 << 20 != 0;
    let rn = word >> 16 & 15;
    let ex_ord = word >> 8 & 3;
    if word >> 10 & 3 != 3 || rn == 15 {
        return Err(Exception::Undefined);
    }
    let address = reg(rn) as u64;
    let rt = if load { word >> 12 & 15 } else { word & 15 };
    let status = word >> 12 & 15;
    if rt == 15 || size == 3 && (rt & 1 != 0 || rt == 14) {
        return Err(Exception::Undefined);
    }
    match ex_ord {
        // LDREX, STREX and LDAEX, STLEX
        3 | 2 => {
            if !load
                && (status == 15 || status == rn || status == rt || size == 3 && status == rt + 1)
            {
                return Err(Exception::Undefined);
            }
            exclusive(
                load,
                size,
                ex_ord == 2,
                rt,
                rt + 1,
                status,
                address as u32,
                pc,
            )
        },
        // LDA, STL (no doubleword)
        0 => {
            if size == 3 || !load && status != 15 {
                return Err(Exception::Undefined);
            }
            acquire_release(load, 1 << size, rt, address as u32)
        },
        _ => Err(Exception::Undefined),
    }
}

/// The extra loads and stores (bits 27:25 000, 7 1, 4 1, 6:5 not 00):
/// LDRH, STRH, LDRSB, LDRSH, LDRD, STRD and their unprivileged forms
fn a32_extra_load_store(word: u32, pc: u32) -> Result<Flow, Exception> {
    let p = word & 1 << 24 != 0;
    let u = word & 1 << 23 != 0;
    let immediate = word & 1 << 22 != 0;
    let w = word & 1 << 21 != 0;
    let l = word & 1 << 20 != 0;
    let rn = word >> 16 & 15;
    let rt = word >> 12 & 15;
    let op2 = word >> 5 & 3;
    if !immediate && word & 15 == 15 {
        return Err(Exception::Undefined);
    }
    let offset = if immediate { (word >> 4 & 0xF0) | word & 15 } else { reg(word & 15) };
    let unprivileged = !p && w;
    let base = a32_read(rn, pc);
    let offset_address = if u { base.wrapping_add(offset) } else { base.wrapping_sub(offset) };
    let address = if p { offset_address } else { base };
    let wback = !p || w;
    if wback && (rn == 15 || rn == rt) {
        return Err(Exception::Undefined);
    }
    let writeback = if wback { Some(offset_address) } else { None };
    match (op2, l) {
        (1, false) => store_register(a32_read(rt, pc), address, 2, rn, writeback, unprivileged),
        (1, true) => load_register(rt, address, 2, false, rn, writeback, unprivileged),
        (2, true) => load_register(rt, address, 1, true, rn, writeback, unprivileged),
        (3, true) => load_register(rt, address, 2, true, rn, writeback, unprivileged),
        // LDRD, STRD (no unprivileged form)
        (2, false) | (3, false) => {
            if unprivileged || rt & 1 != 0 || rt == 14 || wback && rn == rt + 1 {
                return Err(Exception::Undefined);
            }
            if op2 == 2 {
                load_dual(rt, rt + 1, address, rn, writeback)
            }
            else {
                store_dual(reg(rt), reg(rt + 1), address, rn, writeback)
            }
        },
        _ => Err(Exception::Undefined),
    }
}

/// The miscellaneous instructions (bits 27:23 00010, 20 0, 7 0)
fn a32_miscellaneous(word: u32, pc: u32) -> Result<Flow, Exception> {
    let op0 = word >> 21 & 3;
    let rd = word >> 12 & 15;
    let rn = word >> 16 & 15;
    let rm = word & 15;
    match word >> 4 & 7 {
        0 => {
            let spsr = word & 1 << 22 != 0;
            if word & 1 << 9 != 0 {
                // (banked registers: PL1's; SYSm M:M1)
                let sysm = (word >> 8 & 1) << 4 | rn;
                return if op0 & 1 == 0 {
                    banked(true, spsr, sysm, rd)
                }
                else {
                    banked(false, spsr, sysm, rm)
                };
            }
            match (op0 & 1 != 0, spsr) {
                (false, _) => mrs(rd, spsr),
                (true, false) => msr_cpsr(reg(rm), rn),
                (true, true) => msr_spsr(reg(rm), rn),
            }
        },
        // BX, BXJ (as BX)
        1 | 2 if op0 == 1 => Ok(bx_write_pc(a32_read(rm, pc))),
        1 if op0 == 3 => bit_op(4, rd, reg(rm)),
        3 if op0 == 1 => {
            let target = reg(rm);
            set_reg(14, pc.wrapping_add(4));
            Ok(bx_write_pc(target))
        },
        4 => crc32(rd, reg(rn), reg(rm), op0, word & 1 << 9 != 0),
        5 => saturating_add(op0, rd, reg(rn), reg(rm)),
        // BKPT (EC 0x38, its immediate); HVC, SMC and ERET are UNDEFINED at EL0
        7 if op0 == 1 => Err(Exception::Trapped32 {
            ec: 0x38,
            iss: (word >> 4 & 0xFFF0) | word & 15,
        }),
        // HVC, SMC (PSCI at PL1, the device tree's conduit is HVC); ERET (as SUBS PC, LR, #0)
        7 if op0 == 2 && crate::aarch64::a32_system::privileged() => {
            crate::aarch64::a32_system::hvc()
        },
        7 if op0 == 3 && crate::aarch64::a32_system::privileged() => {
            crate::aarch64::a32_system::hvc()
        },
        6 if op0 == 3 && rm == 14 && crate::aarch64::a32_system::privileged() => {
            crate::aarch64::a32_system::exception_return(reg(14))
        },
        _ => Err(Exception::Undefined),
    }
}

/// The halfword multiplies (bits 27:23 00010, 20 0, 7 1, 4 0)
fn a32_halfword_multiply(word: u32) -> Result<Flow, Exception> {
    let rd = word >> 16 & 15;
    let ra = word >> 12 & 15;
    let rm = word >> 8 & 15;
    let rn = word & 15;
    let m_top = word & 1 << 6 != 0;
    let n_top = word & 1 << 5 != 0;
    match word >> 21 & 3 {
        0 => multiply_halfword(0, rd, ra, reg(rn), reg(rm), n_top, m_top, true),
        1 => multiply_halfword(1, rd, ra, reg(rn), reg(rm), false, m_top, !n_top),
        2 => {
            if ra == rd {
                return Err(Exception::Undefined);
            }
            multiply_halfword(2, rd, ra, reg(rn), reg(rm), n_top, m_top, true)
        },
        _ => multiply_halfword(3, rd, ra, reg(rn), reg(rm), n_top, m_top, false),
    }
}

/// LDR, STR, LDRB, STRB (bits 27:26 01): immediate (bit 25 0) or register offsets
fn a32_load_store(word: u32, pc: u32) -> Result<Flow, Exception> {
    let register = word & 1 << 25 != 0;
    let p = word & 1 << 24 != 0;
    let u = word & 1 << 23 != 0;
    let byte = word & 1 << 22 != 0;
    let w = word & 1 << 21 != 0;
    let l = word & 1 << 20 != 0;
    let rn = word >> 16 & 15;
    let rt = word >> 12 & 15;
    let offset = if register {
        let rm = word & 15;
        if rm == 15 {
            return Err(Exception::Undefined);
        }
        let (kind, amount) = decode_imm_shift(word >> 5 & 3, word >> 7 & 31);
        shift_c(reg(rm), kind, amount, carry()).0
    }
    else {
        word & 0xFFF
    };
    let unprivileged = !p && w;
    let base = a32_read(rn, pc);
    let offset_address = if u { base.wrapping_add(offset) } else { base.wrapping_sub(offset) };
    let address = if p { offset_address } else { base };
    let wback = !p || w;
    if wback && (rn == 15 || rn == rt) || byte && rt == 15 {
        return Err(Exception::Undefined);
    }
    let writeback = if wback { Some(offset_address) } else { None };
    let size = if byte { 1 } else { 4 };
    if l {
        load_register(rt, address, size, false, rn, writeback, unprivileged)
    }
    else {
        store_register(a32_read(rt, pc), address, size, rn, writeback, unprivileged)
    }
}

/// LDM, STM (bits 27:25 100)
fn a32_block_transfer(word: u32, pc: u32) -> Result<Flow, Exception> {
    let p = word & 1 << 24 != 0;
    let u = word & 1 << 23 != 0;
    let user = word & 1 << 22 != 0;
    let w = word & 1 << 21 != 0;
    let l = word & 1 << 20 != 0;
    let rn = word >> 16 & 15;
    let list = word & 0xFFFF;
    if rn == 15 || list == 0 || user && !crate::aarch64::a32_system::privileged() {
        // (the user registers and exception returns: UNPREDICTABLE at EL0)
        return Err(Exception::Undefined);
    }
    let count = list.count_ones();
    let base = reg(rn);
    let start = match (p, u) {
        (false, true) => base,
        (true, true) => base.wrapping_add(4),
        (false, false) => base.wrapping_sub(4 * count).wrapping_add(4),
        (true, false) => base.wrapping_sub(4 * count),
    };
    let new_base = if u { base.wrapping_add(4 * count) } else { base.wrapping_sub(4 * count) };
    if user {
        // LDM (exception return), LDM and STM of the User mode's registers (no writeback)
        return crate::aarch64::a32_system::block_user(
            l,
            rn,
            list,
            start,
            if w { Some(new_base) } else { None },
            pc.wrapping_add(8),
        );
    }
    if l {
        // (the base in the list with writeback: UNPREDICTABLE, the loaded value here)
        let writeback = if w && list & 1 << rn == 0 { Some(new_base) } else { None };
        load_multiple(rn, list, start, writeback)
    }
    else {
        store_multiple(
            rn,
            list,
            start,
            if w { Some(new_base) } else { None },
            pc.wrapping_add(8),
        )
    }
}

/// The media instructions (bits 27:25 011, 4 1)
fn a32_media(word: u32) -> Result<Flow, Exception> {
    let op1 = word >> 20 & 31;
    let op2 = word >> 5 & 7;
    let rn = word >> 16 & 15;
    let rd = word >> 12 & 15;
    let rs = word >> 8 & 15;
    let rm = word & 15;
    match op1 >> 3 {
        0 => {
            // parallel addition and subtraction: op1 bits 2:0 the kind, op2 the operation
            let kind = op1 & 7;
            if kind & 3 == 0 || op2 == 5 || op2 == 6 || rd == 15 || rn == 15 || rm == 15 {
                return Err(Exception::Undefined);
            }
            parallel(kind, op2, rd, reg(rn), reg(rm))
        },
        1 => {
            // packing, unpacking, saturation, reversal
            let rotation = 8 * (word >> 10 & 3);
            let addend = if rn == 15 { None } else { Some(reg(rn)) };
            match (op1 & 7, op2) {
                (0, 0) | (0, 2) | (0, 4) | (0, 6) => {
                    pack(rd, reg(rn), reg(rm), word & 1 << 6 != 0, word >> 7 & 31)
                },
                (0, 3) => extend(rd, addend, reg(rm), rotation, 8, true, true),
                (0, 5) => select(rd, reg(rn), reg(rm)),
                (2, 1) => saturate16(rd, reg(rm), rn + 1, false),
                (2, 3) => extend(rd, addend, reg(rm), rotation, 8, true, false),
                (3, 1) => bit_op(0, rd, reg(rm)),
                (3, 3) => extend(rd, addend, reg(rm), rotation, 16, true, false),
                (3, 5) => bit_op(1, rd, reg(rm)),
                (4, 3) => extend(rd, addend, reg(rm), rotation, 8, false, true),
                (6, 1) => saturate16(rd, reg(rm), rn, true),
                (6, 3) => extend(rd, addend, reg(rm), rotation, 8, false, false),
                (7, 1) => bit_op(3, rd, reg(rm)),
                (7, 3) => extend(rd, addend, reg(rm), rotation, 16, false, false),
                (7, 5) => bit_op(2, rd, reg(rm)),
                // SSAT, USAT (bit 5 0): Rn shifted by LSL or ASR (bit 6)
                (2 | 3 | 6 | 7, 0 | 2 | 4 | 6) => {
                    let (kind, amount) = decode_imm_shift(word >> 5 & 2, word >> 7 & 31);
                    let value = shift_c(reg(rm), kind, amount, false).0;
                    let unsigned = op1 & 4 != 0;
                    let bits = (word >> 16 & 31) + if unsigned { 0 } else { 1 };
                    saturate(rd, value, bits, unsigned)
                },
                _ => Err(Exception::Undefined),
            }
        },
        2 => {
            // signed multiplies and divides: Rd bits 19:16, Ra 15:12, Rm 11:8, Rn 3:0
            let (rd, ra, rm, rn) = (word >> 16 & 15, word >> 12 & 15, word >> 8 & 15, word & 15);
            let swap = word & 1 << 5 != 0;
            match (op1 & 7, op2 >> 1) {
                (0, 0) => multiply_dual(rd, ra, reg(rn), reg(rm), false, swap, false),
                (0, 1) => multiply_dual(rd, ra, reg(rn), reg(rm), true, swap, false),
                (1, 0) if op2 == 0 && ra == 15 => divide(rd, reg(rn), reg(rm), true),
                (3, 0) if op2 == 0 && ra == 15 => divide(rd, reg(rn), reg(rm), false),
                (4, 0) => multiply_dual(rd, ra, reg(rn), reg(rm), false, swap, true),
                (4, 1) => multiply_dual(rd, ra, reg(rn), reg(rm), true, swap, true),
                (5, 0) => multiply_most(rd, ra, reg(rn), reg(rm), false, swap),
                (5, 3) if ra != 15 => multiply_most(rd, ra, reg(rn), reg(rm), true, swap),
                _ => Err(Exception::Undefined),
            }
        },
        _ => {
            let lsb = word >> 7 & 31;
            let width_bits = word >> 16 & 31;
            if op1 == 0b11000 && op2 == 0 {
                // USAD8, USADA8: Rd 19:16, Ra 15:12, Rm 11:8, Rn 3:0
                return sum_absolute(word >> 16 & 15, rd, reg(rm), reg(rs));
            }
            match (op1 & 6, op2 & 3) {
                (2, 2) => bitfield_extract(rd, reg(rm), lsb, width_bits + 1, true),
                (4, 0) => bitfield_insert(
                    rd,
                    if rm == 15 { None } else { Some(reg(rm)) },
                    lsb,
                    width_bits,
                ),
                (6, 2) => bitfield_extract(rd, reg(rm), lsb, width_bits + 1, false),
                _ => Err(Exception::Undefined),
            }
        },
    }
}

/// The coprocessor space (bits 27:25 110, 111 but SVC): VFP (coprocessors
/// 10, 11), MCR, MRC, MCRR, MRRC of CP15; CP14 and the rest UNDEFINED
fn a32_coprocessor(word: u32, pc: u32, cp: u32, cond: u32) -> Result<Flow, Exception> {
    if cp == 10 || cp == 11 {
        return crate::aarch64::a32_fp::vfp(word, pc.wrapping_add(8), false);
    }
    if cp == 14 && word >> 24 & 15 == 0b1110 && word & 1 << 4 != 0 {
        return crate::aarch64::a32_system::cp14(word & 1 << 20 != 0, word >> 12 & 15);
    }
    if cp != 15 {
        return Err(Exception::Undefined);
    }
    let rt = word >> 12 & 15;
    if word >> 24 & 15 == 0b1110 && word & 1 << 4 != 0 {
        if rt == 15 {
            return Err(Exception::Undefined);
        }
        let read = word & 1 << 20 != 0;
        return cp15(
            read,
            word >> 21 & 7,
            word >> 16 & 15,
            word & 15,
            word >> 5 & 7,
            rt,
            reg(rt),
            cond,
        );
    }
    if word >> 21 & 0x7F == 0b1100010 {
        let rt2 = word >> 16 & 15;
        if rt == 15 || rt2 == 15 {
            return Err(Exception::Undefined);
        }
        let read = word & 1 << 20 != 0;
        let value = (reg(rt2) as u64) << 32 | reg(rt) as u64;
        return cp15_64(read, word >> 4 & 15, word & 15, rt, rt2, value, cond);
    }
    Err(Exception::Undefined)
}

/// A32's unconditional space (cond 0b1111): barriers, CLREX, preloads,
/// BLX (immediate), Advanced SIMD, ARMv8's VFP additions; the rest
/// UNDEFINED (SETEND, CPS, SRS, RFE at EL0)
fn a32_unconditional(word: u32, pc: u32) -> Result<Flow, Exception> {
    if word >> 25 == 0b1111001 {
        return crate::aarch64::a32_simd::data_processing(word);
    }
    if word & 0xFF10_0000 == 0xF400_0000 {
        return crate::aarch64::a32_simd::load_store(word);
    }
    if word >> 24 == 0xFE {
        return crate::aarch64::a32_fp::vfp_unconditional(word);
    }
    // BLX (immediate): to T32, imm24:H:0 from the PC + 8
    if word >> 25 & 7 == 0b101 {
        let offset = ((word << 8) as i32 >> 6) as u32 | (word >> 23 & 2);
        set_reg(14, pc.wrapping_add(4));
        set_pstate_bits(PSTATE_T, PSTATE_T);
        return Ok(Flow::Jump(pc.wrapping_add(8).wrapping_add(offset) as u64));
    }
    if word == 0xF57F_F01F {
        return clear_exclusive();
    }
    // CPS (a NOP in User mode), SRS, RFE: PL1's (cpu_type arm32)
    if word & 0xFFF1_FE20 == 0xF100_0000 && a32_only() {
        crate::aarch64::a32_system::cps(
            word >> 18 & 3,
            word >> 6 & 7,
            word & 1 << 17 != 0,
            word & 31,
        );
        return Ok(Flow::Next);
    }
    if crate::aarch64::a32_system::privileged() {
        // (P bit 24, U 23, W 21)
        if word & 0xFE5F_FFE0 == 0xF84D_0500 {
            return crate::aarch64::a32_system::srs(
                word >> 24 & 1 != 0,
                word >> 23 & 1 != 0,
                word >> 21 & 1 != 0,
                word & 31,
            );
        }
        if word & 0xFE50_FFFF == 0xF810_0A00 {
            return crate::aarch64::a32_system::rfe(
                word >> 24 & 1 != 0,
                word >> 23 & 1 != 0,
                word >> 21 & 1 != 0,
                word >> 16 & 15,
            );
        }
    }
    if word & 0xFFFF_FF00 == 0xF57F_F000 {
        return match word >> 4 & 15 {
            4 => barrier(true),
            5 | 6 => barrier(false),
            // (SB: not in the profile)
            _ => Err(Exception::Undefined),
        };
    }
    // PLD, PLDW, PLI (immediate, register): hints
    if word & 0xFF30_F000 == 0xF510_F000
        || word & 0xFF30_F010 == 0xF710_F000
        || word & 0xFF70_F000 == 0xF450_F000
        || word & 0xFF70_F010 == 0xF650_F000
    {
        return Ok(Flow::Next);
    }
    Err(Exception::Undefined)
}

/// (tests) the instruction set the core runs: 0 A64, 1 A32, 2 T32
#[no_mangle]
pub fn a64_instruction_set() -> u32 {
    if !aarch32() {
        0
    }
    else if thumb() {
        2
    }
    else {
        1
    }
}
