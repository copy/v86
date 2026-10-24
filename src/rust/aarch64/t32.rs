//! T32 (Thumb-2) at EL0 (docs/aarch32-plan.md Q3): the decoder of the 16-bit
//! and 32-bit encodings onto a32.rs's operations, and ITSTATE (IT blocks).
//! The PC reads as the instruction's address + 4; a 32-bit instruction is
//! (first halfword) << 16 | second.

use crate::aarch64::a32::*;
use crate::aarch64::cpu::*;
use crate::aarch64::execute::Flow;

// ---- ITSTATE

/// ITSTATE (IT[7:0]: the base condition in 7:5, the mask in 4:0)
#[inline(always)]
pub fn itstate() -> u32 {
    let p = get_pstate();
    (p >> 25 & 3) | (p >> 10 & 0x3F) << 2
}

#[inline(always)]
fn set_itstate(it: u32) { set_pstate_bits(PSTATE_IT, (it & 3) << 25 | (it >> 2 & 0x3F) << 10) }

/// Whether an instruction runs in an IT block
#[inline(always)]
pub fn in_it_block() -> bool { itstate() & 0xF != 0 }

/// The condition of the instruction in the IT block (AL outside)
#[inline(always)]
fn it_condition() -> u32 {
    if in_it_block() {
        itstate() >> 4
    }
    else {
        0b1110
    }
}

/// The IT instruction set ITSTATE: the instruction after it is the block's first
static mut IT_JUST_SET: bool = false;

/// ITAdvance, after each T32 instruction that executed (or was skipped by
/// its condition), but the IT instruction itself
pub fn it_advance() {
    if unsafe { IT_JUST_SET } {
        unsafe { IT_JUST_SET = false };
        return;
    }
    let it = itstate();
    if it == 0 {
        return;
    }
    if it & 7 == 0 {
        set_itstate(0);
    }
    else {
        set_itstate(it & 0xE0 | it << 1 & 0x1F);
    }
}

// ---- one instruction

/// An instruction of T32 at `pc` (`length` 2 or 4)
pub fn execute(word: u32, length: u32, pc: u32) -> Result<Flow, Exception> {
    unsafe { IT_JUST_SET = false };
    let cond = it_condition();
    if length == 2 {
        // (BKPT runs whatever its condition; the IT instruction is never in a block)
        if !condition_passed(cond) && word >> 8 != 0xBE {
            return Ok(Flow::Next);
        }
        t16(word, pc, cond)
    }
    else {
        if !condition_passed(cond) {
            return Ok(Flow::Next);
        }
        t32(word, pc)
    }
}

/// T32, a 16-bit instruction
fn t16(hw: u32, pc: u32, cond: u32) -> Result<Flow, Exception> {
    match hw >> 12 {
        0b1011 if hw >> 8 & 15 == 0b1111 => {
            if hw & 15 != 0 {
                // IT: firstcond:mask (UNPREDICTABLE in a block, or with cond 1111)
                if in_it_block() || hw >> 4 & 15 == 15 {
                    return Err(Exception::Undefined);
                }
                set_itstate(hw & 0xFF);
                unsafe { IT_JUST_SET = true };
                return Ok(Flow::Next);
            }
            hint(hw >> 4 & 15, cond)
        },
        // B<cond>, UDF, SVC
        0b1101 => {
            let c = hw >> 8 & 15;
            match c {
                0b1110 => Err(Exception::Undefined),
                0b1111 => Err(Exception::Svc((hw & 0xFF) as u16)),
                _ => {
                    if in_it_block() {
                        return Err(Exception::Undefined);
                    }
                    if !condition_passed(c) {
                        return Ok(Flow::Next);
                    }
                    let offset = ((hw << 24) as i32 >> 23) as u32;
                    Ok(branch_to(pc.wrapping_add(4).wrapping_add(offset)))
                },
            }
        },
        // B: imm11 << 1 from the PC + 4
        0b1110 if hw & 0x0800 == 0 => {
            let offset = ((hw << 21) as i32 >> 20) as u32;
            Ok(branch_to(pc.wrapping_add(4).wrapping_add(offset)))
        },
        _ => Err(Exception::Undefined),
    }
}

/// T32, a 32-bit instruction (the first halfword in bits 31:16)
fn t32(word: u32, pc: u32) -> Result<Flow, Exception> {
    let hw1 = word >> 16;
    let hw2 = word & 0xFFFF;
    // B.W (T4) and BL: S:I1:I2:imm10:imm11 << 1, I = NOT(J XOR S)
    if hw1 >> 11 == 0b11110 && (hw2 & 0x5000 == 0x5000 || hw2 & 0xD000 == 0x9000) {
        let s = hw1 >> 10 & 1;
        let i1 = !(hw2 >> 13 & 1 ^ s) & 1;
        let i2 = !(hw2 >> 11 & 1 ^ s) & 1;
        let imm = s << 24 | i1 << 23 | i2 << 22 | (hw1 & 0x3FF) << 12 | (hw2 & 0x7FF) << 1;
        let offset = ((imm << 7) as i32 >> 7) as u32;
        if hw2 & 0x4000 != 0 {
            // (BL: LR is the next instruction, in T32)
            set_reg(14, pc.wrapping_add(4) | 1);
        }
        return Ok(branch_to(pc.wrapping_add(4).wrapping_add(offset)));
    }
    Err(Exception::Undefined)
}
