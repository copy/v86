//! AArch32 at EL0 (docs/aarch32-plan.md, profile v3): the A32 and T32
//! instructions of a process the AArch64 kernel runs in AArch32, interpreted.
//! R0-R14 are the low halves of X0-X14 (a write zero-extends), R15 the PC;
//! `pstate` is laid out as an AArch32 SPSR (T, ITSTATE, GE, Q, E) and NZCV
//! is in `nzcv`. An instruction that faults has written no state, as A64's.
//!
//! Q1: the execution state, the exceptions to EL1 and the returns to EL0,
//! with NOP, B, BL, SVC and UDF; the rest of A32 and T32 comes in Q2 and Q3.

use crate::aarch64::cpu::*;
use crate::aarch64::execute::Flow;
use crate::aarch64::memory;

/// The length of the instruction being executed (2 for a 16-bit T32 one):
/// its exception's return address and ESR.IL
static mut INSTRUCTION_LENGTH: u32 = 4;

#[inline(always)]
pub fn instruction_length() -> u32 { unsafe { INSTRUCTION_LENGTH } }

// ---- registers

/// R[n], n < 15 (R15 is read as the instruction's PC + 8 in A32, + 4 in T32)
#[inline(always)]
pub fn reg(n: u32) -> u32 { xr(n) as u32 }

/// Write R[n], n < 15: X[n] zero-extended
#[inline(always)]
pub fn set_reg(n: u32, value: u32) { set_x(n, value as u64) }

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
    // (cond 0b1111 is "always" here: the unconditional space is decoded before)
    if cond & 1 != 0 && cond != 0b1111 {
        !result
    }
    else {
        result
    }
}

// ---- fetch

/// Whether a T32 halfword starts a 32-bit instruction
#[inline(always)]
fn t32_wide(halfword: u32) -> bool { halfword >> 11 >= 0b11101 }

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

/// Execute the AArch32 instruction at `address` (the PC): it retires, or
/// takes its exception having written no state (execute::interpret_one's
/// contract)
pub fn interpret_one(address: u64) -> Flow {
    let thumb = get_pstate() & PSTATE_T != 0;
    unsafe { INSTRUCTION_LENGTH = if thumb { 2 } else { 4 } };
    let result = fetch(address, thumb).and_then(|(word, length)| {
        unsafe { INSTRUCTION_LENGTH = length };
        if thumb {
            if length == 2 {
                t16(word, address)
            }
            else {
                t32(word, address)
            }
        }
        else {
            a32(word, address)
        }
    });
    let length = instruction_length() as u64;
    match result {
        Ok(flow) => {
            crate::core_stats::add_pending(1, 0);
            match flow {
                Flow::Next | Flow::Yield | Flow::Wait(_) | Flow::Off => {
                    set_pc((address as u32).wrapping_add(length as u32) as u64)
                },
                Flow::Jump(target) => set_pc(target),
                Flow::Set | Flow::Retry => {},
            }
            flow
        },
        Err(exception @ Exception::Svc(_)) => {
            // (the instruction executed: the exception returns after it)
            crate::core_stats::add_pending(1, 0);
            take_sync(exception);
            Flow::Set
        },
        Err(exception) => {
            take_sync(exception);
            Flow::Set
        },
    }
}

/// A branch's target in the instruction set it stays in
#[inline(always)]
fn branch(target: u32) -> Flow { Flow::Jump(target as u64) }

/// A32: the instruction `word` at `address`
fn a32(word: u32, address: u64) -> Result<Flow, Exception> {
    let pc = address as u32;
    let cond = word >> 28;
    if cond == 0b1111 {
        // (the unconditional space: Q2)
        return Err(Exception::Undefined);
    }
    // UDF (cond 0b1110 only, else UNDEFINED anyway)
    if word & 0x0FF0_00F0 == 0x07F0_00F0 {
        return Err(Exception::Undefined);
    }
    if !condition_passed(cond) {
        return Ok(Flow::Next);
    }
    match word >> 25 & 7 {
        // B, BL: imm24 << 2 from the PC + 8
        0b101 => {
            let offset = ((word << 8) as i32 >> 6) as u32;
            if word & 1 << 24 != 0 {
                set_reg(14, pc.wrapping_add(4));
            }
            Ok(branch(pc.wrapping_add(8).wrapping_add(offset)))
        },
        // SVC: the immediate's low 16 bits are the ISS
        0b111 if word & 1 << 24 != 0 => Err(Exception::Svc(word as u16)),
        _ => {
            // hints: NOP, YIELD (WFE, WFI, SEV, SEVL: Q2.4)
            if word & 0x0FFF_FF00 == 0x0320_F000 && word & 0xFF <= 1 {
                return Ok(if word & 0xFF == 1 { Flow::Yield } else { Flow::Next });
            }
            Err(Exception::Undefined)
        },
    }
}

/// T32, a 16-bit instruction
fn t16(hw: u32, address: u64) -> Result<Flow, Exception> {
    let pc = address as u32;
    match hw >> 12 {
        // hints (and IT: Q3)
        0b1011 if hw & 0xFF0F == 0xBF00 => {
            let hint = hw >> 4 & 15;
            if hint <= 1 {
                Ok(if hint == 1 { Flow::Yield } else { Flow::Next })
            }
            else {
                Err(Exception::Undefined)
            }
        },
        // B<cond>, UDF, SVC
        0b1101 => {
            let cond = hw >> 8 & 15;
            match cond {
                0b1110 => Err(Exception::Undefined),
                0b1111 => Err(Exception::Svc((hw & 0xFF) as u16)),
                _ => {
                    if !condition_passed(cond) {
                        return Ok(Flow::Next);
                    }
                    let offset = ((hw << 24) as i32 >> 23) as u32;
                    Ok(branch(pc.wrapping_add(4).wrapping_add(offset)))
                },
            }
        },
        // B: imm11 << 1 from the PC + 4
        0b1110 if hw & 0x0800 == 0 => {
            let offset = ((hw << 21) as i32 >> 20) as u32;
            Ok(branch(pc.wrapping_add(4).wrapping_add(offset)))
        },
        _ => Err(Exception::Undefined),
    }
}

/// T32, a 32-bit instruction (the first halfword in bits 31:16)
fn t32(word: u32, address: u64) -> Result<Flow, Exception> {
    let pc = address as u32;
    let hw1 = word >> 16;
    let hw2 = word & 0xFFFF;
    // B.W (T4) and BL: S:I1:I2:imm10:imm11 << 1, I = NOT(J XOR S)
    if hw1 >> 11 == 0b11110 && hw2 & 0x5000 == 0x5000
        || hw1 >> 11 == 0b11110 && hw2 & 0xD000 == 0x9000
    {
        let s = hw1 >> 10 & 1;
        let j1 = hw2 >> 13 & 1;
        let j2 = hw2 >> 11 & 1;
        let i1 = !(j1 ^ s) & 1;
        let i2 = !(j2 ^ s) & 1;
        let imm = s << 24 | i1 << 23 | i2 << 22 | (hw1 & 0x3FF) << 12 | (hw2 & 0x7FF) << 1;
        let offset = ((imm << 7) as i32 >> 7) as u32;
        if hw2 & 0x4000 != 0 {
            // (BL: LR is the next instruction, in T32)
            set_reg(14, pc.wrapping_add(4) | 1);
        }
        return Ok(branch(pc.wrapping_add(4).wrapping_add(offset)));
    }
    // UDF.W
    if hw1 & 0xFFF0 == 0xF7F0 && hw2 & 0xF000 == 0xA000 {
        return Err(Exception::Undefined);
    }
    Err(Exception::Undefined)
}
