//! T32 (Thumb-2) at EL0 (docs/aarch32-plan.md Q3): the decoder of the 16-bit
//! and 32-bit encodings onto a32.rs's operations, and ITSTATE (IT blocks).
//! The PC reads as the instruction's address + 4 (literals: aligned down to
//! a word); a 32-bit instruction is (first halfword) << 16 | second. The
//! 16-bit data processing instructions set the flags outside an IT block.

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

/// Whether the instruction is the last of its IT block (or outside one)
#[inline(always)]
fn last_in_it_block() -> bool { itstate() & 0xF == 0b1000 || !in_it_block() }

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

// ---- operands

/// A T32 register read: the PC as the instruction's address + 4
#[inline(always)]
fn read(n: u32, pc: u32) -> u32 {
    if n == 15 {
        pc.wrapping_add(4)
    }
    else {
        reg(n)
    }
}

/// ThumbExpandImm_C: the value of i:imm3:imm8 and the carry out
fn expand_imm_c(imm12: u32, carry_in: bool) -> (u32, bool) {
    if imm12 >> 10 == 0 {
        let b = imm12 & 0xFF;
        let value = match imm12 >> 8 & 3 {
            0 => b,
            1 => b << 16 | b,
            2 => b << 24 | b << 8,
            _ => b << 24 | b << 16 | b << 8 | b,
        };
        (value, carry_in)
    }
    else {
        let value = (0x80 | imm12 & 0x7F).rotate_right(imm12 >> 7);
        (value, value >> 31 != 0)
    }
}

/// A branch, BranchWritePC: in T32 (bit 0 cleared)
#[inline(always)]
fn jump(target: u32) -> Flow { Flow::Jump((target & !1) as u64) }

/// An UNPREDICTABLE register use (SP or PC where they are not allowed): UNDEFINED
#[inline(always)]
fn bad(r: u32) -> bool { r == 13 || r == 15 }

// ---- one instruction

/// An instruction of T32 at `pc` (`length` 2 or 4)
pub fn execute(word: u32, length: u32, pc: u32) -> Result<Flow, Exception> {
    unsafe { IT_JUST_SET = false };
    let cond = it_condition();
    // (BKPT and HLT run whatever their condition)
    if !condition_passed(cond) && !(length == 2 && (word >> 8 == 0xBE || word >> 6 == 0x2EA)) {
        return Ok(Flow::Next);
    }
    if length == 2 {
        t16(word, pc, cond)
    }
    else {
        t32(word, pc, cond)
    }
}

// ---- 16-bit

fn t16(hw: u32, pc: u32, cond: u32) -> Result<Flow, Exception> {
    let s = !in_it_block();
    match hw >> 10 {
        // shift (immediate), add, subtract, move, compare
        0b000000..=0b001111 => {
            let rd = hw & 7;
            let rn = hw >> 3 & 7;
            match hw >> 11 {
                0b000 | 0b001 | 0b010 => {
                    let op = hw >> 11;
                    let imm5 = hw >> 6 & 31;
                    if op == 0 && imm5 == 0 {
                        // MOVS Rd, Rm (T2): UNPREDICTABLE in an IT block
                        if !s {
                            return Err(Exception::Undefined);
                        }
                        return data_processing(DP_MOV, true, rd, 0, reg(rn), carry());
                    }
                    let (kind, amount) = decode_imm_shift(op, imm5);
                    let (value, c) = shift_c(reg(rn), kind, amount, carry());
                    data_processing(DP_MOV, s, rd, 0, value, c)
                },
                0b011 => {
                    let operand = if hw & 1 << 10 != 0 { hw >> 6 & 7 } else { reg(hw >> 6 & 7) };
                    let op = if hw & 1 << 9 != 0 { DP_SUB } else { DP_ADD };
                    data_processing(op, s, rd, reg(rn), operand, carry())
                },
                op => {
                    let rdn = hw >> 8 & 7;
                    let imm8 = hw & 0xFF;
                    match op {
                        0b100 => data_processing(DP_MOV, s, rdn, 0, imm8, carry()),
                        0b101 => data_processing(DP_CMP, true, 0, reg(rdn), imm8, carry()),
                        0b110 => data_processing(DP_ADD, s, rdn, reg(rdn), imm8, carry()),
                        _ => data_processing(DP_SUB, s, rdn, reg(rdn), imm8, carry()),
                    }
                },
            }
        },
        // data processing (register)
        0b010000 => {
            let rdn = hw & 7;
            let rm = hw >> 3 & 7;
            let (n, m) = (reg(rdn), reg(rm));
            match hw >> 6 & 15 {
                0b0000 => data_processing(DP_AND, s, rdn, n, m, carry()),
                0b0001 => data_processing(DP_EOR, s, rdn, n, m, carry()),
                op @ (0b0010 | 0b0011 | 0b0100 | 0b0111) => {
                    let kind = match op {
                        0b0010 => SHIFT_LSL,
                        0b0011 => SHIFT_LSR,
                        0b0100 => SHIFT_ASR,
                        _ => SHIFT_ROR,
                    };
                    let (value, c) = shift_c(n, kind, m & 0xFF, carry());
                    data_processing(DP_MOV, s, rdn, 0, value, c)
                },
                0b0101 => data_processing(DP_ADC, s, rdn, n, m, carry()),
                0b0110 => data_processing(DP_SBC, s, rdn, n, m, carry()),
                0b1000 => data_processing(DP_TST, true, 0, n, m, carry()),
                0b1001 => data_processing(DP_RSB, s, rdn, m, 0, carry()),
                0b1010 => data_processing(DP_CMP, true, 0, n, m, carry()),
                0b1011 => data_processing(DP_CMN, true, 0, n, m, carry()),
                0b1100 => data_processing(DP_ORR, s, rdn, n, m, carry()),
                0b1101 => multiply(0, s, rdn, m, n, 0),
                0b1110 => data_processing(DP_BIC, s, rdn, n, m, carry()),
                _ => data_processing(DP_MVN, s, rdn, 0, m, carry()),
            }
        },
        // special data processing, branch and exchange
        0b010001 => {
            let rdn = (hw >> 4 & 8) | hw & 7;
            let rm = hw >> 3 & 15;
            match hw >> 8 & 3 {
                0 => {
                    if rdn == 15 && rm == 15 {
                        return Err(Exception::Undefined);
                    }
                    let result = read(rdn, pc).wrapping_add(read(rm, pc));
                    if rdn == 15 {
                        if !last_in_it_block() {
                            return Err(Exception::Undefined);
                        }
                        return Ok(jump(result));
                    }
                    set_reg(rdn, result);
                    Ok(Flow::Next)
                },
                1 => {
                    if rdn < 8 && rm < 8 || rdn == 15 || rm == 15 {
                        return Err(Exception::Undefined);
                    }
                    data_processing(DP_CMP, true, 0, reg(rdn), reg(rm), carry())
                },
                2 => {
                    let value = read(rm, pc);
                    if rdn == 15 {
                        if !last_in_it_block() {
                            return Err(Exception::Undefined);
                        }
                        return Ok(jump(value));
                    }
                    set_reg(rdn, value);
                    Ok(Flow::Next)
                },
                _ => {
                    if hw & 7 != 0 || !last_in_it_block() {
                        return Err(Exception::Undefined);
                    }
                    let target = read(rm, pc);
                    if hw & 1 << 7 != 0 {
                        // BLX (register): the return address in T32
                        if rm == 15 {
                            return Err(Exception::Undefined);
                        }
                        set_reg(14, pc.wrapping_add(2) | 1);
                    }
                    Ok(bx_write_pc(target))
                },
            }
        },
        // LDR (literal)
        0b010010 | 0b010011 => {
            let address = (pc.wrapping_add(4) & !3).wrapping_add((hw & 0xFF) << 2);
            load_register(hw >> 8 & 7, address, 4, false, 0, None, false)
        },
        // loads and stores (register offset)
        0b010100..=0b010111 => {
            let rt = hw & 7;
            let address = reg(hw >> 3 & 7).wrapping_add(reg(hw >> 6 & 7));
            match hw >> 9 & 7 {
                0 => store_register(reg(rt), address, 4, 0, None, false),
                1 => store_register(reg(rt), address, 2, 0, None, false),
                2 => store_register(reg(rt), address, 1, 0, None, false),
                3 => load_register(rt, address, 1, true, 0, None, false),
                4 => load_register(rt, address, 4, false, 0, None, false),
                5 => load_register(rt, address, 2, false, 0, None, false),
                6 => load_register(rt, address, 1, false, 0, None, false),
                _ => load_register(rt, address, 2, true, 0, None, false),
            }
        },
        // loads and stores (immediate): word, byte, halfword, SP-relative
        0b011000..=0b100111 => {
            let rt = hw & 7;
            let imm5 = hw >> 6 & 31;
            let load = hw & 1 << 11 != 0;
            let (size, address, rt) = match hw >> 12 {
                0b0110 => (4, reg(hw >> 3 & 7).wrapping_add(imm5 << 2), rt),
                0b0111 => (1, reg(hw >> 3 & 7).wrapping_add(imm5), rt),
                0b1000 => (2, reg(hw >> 3 & 7).wrapping_add(imm5 << 1), rt),
                _ => (4, reg(13).wrapping_add((hw & 0xFF) << 2), hw >> 8 & 7),
            };
            if load {
                load_register(rt, address, size, false, 0, None, false)
            }
            else {
                store_register(reg(rt), address, size, 0, None, false)
            }
        },
        // ADR, ADD (SP plus immediate)
        0b101000..=0b101011 => {
            let imm = (hw & 0xFF) << 2;
            let base = if hw & 1 << 11 != 0 { reg(13) } else { pc.wrapping_add(4) & !3 };
            set_reg(hw >> 8 & 7, base.wrapping_add(imm));
            Ok(Flow::Next)
        },
        0b101100..=0b101111 => t16_miscellaneous(hw, pc, cond),
        // STM, LDM (IA, writeback; LDM's not with the base in the list)
        0b110000..=0b110011 => {
            let rn = hw >> 8 & 7;
            let list = hw & 0xFF;
            if list == 0 {
                return Err(Exception::Undefined);
            }
            let base = reg(rn);
            let new_base = base.wrapping_add(4 * list.count_ones());
            if hw & 1 << 11 != 0 {
                load_multiple(
                    rn,
                    list,
                    base,
                    if list & 1 << rn == 0 { Some(new_base) } else { None },
                )
            }
            else {
                // (the base in the list but not lowest: UNKNOWN; its value before the writeback here)
                store_multiple(rn, list, base, Some(new_base), 0)
            }
        },
        // B<cond>, UDF, SVC
        0b110100..=0b110111 => {
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
                    Ok(jump(pc.wrapping_add(4).wrapping_add(offset)))
                },
            }
        },
        // B: imm11 << 1 from the PC + 4
        0b111000 | 0b111001 => {
            if !last_in_it_block() {
                return Err(Exception::Undefined);
            }
            let offset = ((hw << 21) as i32 >> 20) as u32;
            Ok(jump(pc.wrapping_add(4).wrapping_add(offset)))
        },
        _ => Err(Exception::Undefined),
    }
}

/// The 16-bit miscellaneous instructions (1011 xxxx)
fn t16_miscellaneous(hw: u32, pc: u32, cond: u32) -> Result<Flow, Exception> {
    match hw >> 8 & 15 {
        // ADD, SUB (SP plus immediate)
        0b0000 => {
            let imm = (hw & 0x7F) << 2;
            let sp = reg(13);
            set_reg(
                13,
                if hw & 0x80 != 0 { sp.wrapping_sub(imm) } else { sp.wrapping_add(imm) },
            );
            Ok(Flow::Next)
        },
        // CBZ, CBNZ: i:imm5:'0' forward
        0b0001 | 0b0011 | 0b1001 | 0b1011 => {
            if in_it_block() {
                return Err(Exception::Undefined);
            }
            let zero = reg(hw & 7) == 0;
            let nonzero = hw & 1 << 11 != 0;
            if zero != nonzero {
                let offset = (hw >> 3 & 0x40) | (hw >> 2 & 0x3E);
                return Ok(jump(pc.wrapping_add(4).wrapping_add(offset)));
            }
            Ok(Flow::Next)
        },
        // SXTH, SXTB, UXTH, UXTB
        0b0010 => {
            let rd = hw & 7;
            let m = reg(hw >> 3 & 7);
            match hw >> 6 & 3 {
                0 => extend(rd, None, m, 0, 16, true, false),
                1 => extend(rd, None, m, 0, 8, true, false),
                2 => extend(rd, None, m, 0, 16, false, false),
                _ => extend(rd, None, m, 0, 8, false, false),
            }
        },
        // PUSH {list, LR}: STMDB SP!
        0b0100 | 0b0101 => {
            let list = (hw & 0xFF) | (hw & 0x100) << 6;
            if list == 0 {
                return Err(Exception::Undefined);
            }
            let sp = reg(13);
            let start = sp.wrapping_sub(4 * list.count_ones());
            store_multiple(13, list, start, Some(start), 0)
        },
        // SETEND, CPS: UNDEFINED (big endian is not here) and a NOP at EL0
        0b0110 => {
            if hw & 0xFFE8 == 0xB660 {
                if in_it_block() {
                    return Err(Exception::Undefined);
                }
                if a32_only() {
                    // (im bit 4: disable)
                    crate::aarch64::a32_system::cps(2 | hw >> 4 & 1, hw & 7, false, 0);
                }
                return Ok(Flow::Next);
            }
            Err(Exception::Undefined)
        },
        // REV, REV16, REVSH
        0b1010 => {
            let rd = hw & 7;
            let m = reg(hw >> 3 & 7);
            match hw >> 6 & 3 {
                0 => bit_op(0, rd, m),
                1 => bit_op(1, rd, m),
                3 => bit_op(2, rd, m),
                // (HLT: no halting debug)
                _ => Err(Exception::Undefined),
            }
        },
        // POP {list, PC}: LDMIA SP!
        0b1100 | 0b1101 => {
            let list = (hw & 0xFF) | (hw & 0x100) << 7;
            if list == 0 || list & 1 << 15 != 0 && !last_in_it_block() {
                return Err(Exception::Undefined);
            }
            let sp = reg(13);
            load_multiple(13, list, sp, Some(sp.wrapping_add(4 * list.count_ones())))
        },
        // BKPT
        0b1110 => Err(Exception::Trapped32 {
            ec: 0x38,
            iss: hw & 0xFF,
        }),
        // IT, hints
        0b1111 => {
            if hw & 15 != 0 {
                // IT: firstcond:mask (UNPREDICTABLE in a block, or with cond 1111, or AL with a mask bit set)
                let first = hw >> 4 & 15;
                if in_it_block() || first == 15 || first == 14 && (hw & 15).count_ones() != 1 {
                    if in_it_block() && crate::aarch64::cpu::el() == 0 {
                        crate::aarch64::jit::pages::a32_trace_dump("IT in an IT block");
                    }
                    return Err(Exception::Undefined);
                }
                set_itstate(hw & 0xFF);
                unsafe { IT_JUST_SET = true };
                return Ok(Flow::Next);
            }
            let _ = pc;
            hint(hw >> 4 & 15, cond)
        },
        _ => Err(Exception::Undefined),
    }
}

// ---- 32-bit

fn t32(word: u32, pc: u32, cond: u32) -> Result<Flow, Exception> {
    let hw1 = word >> 16;
    let hw2 = word & 0xFFFF;
    match hw1 >> 11 {
        0b11101 => {
            if hw1 & 1 << 10 != 0 {
                return t32_coprocessor(hw1, hw2, pc, cond);
            }
            if hw1 & 1 << 9 == 0 {
                if hw1 & 1 << 6 == 0 {
                    t32_block_transfer(hw1, hw2, pc)
                }
                else {
                    t32_dual_exclusive(hw1, hw2, pc)
                }
            }
            else {
                t32_shifted_register(hw1, hw2)
            }
        },
        0b11110 => {
            if hw2 & 1 << 15 == 0 {
                if hw1 & 1 << 9 == 0 {
                    t32_modified_immediate(hw1, hw2)
                }
                else {
                    t32_plain_immediate(hw1, hw2, pc)
                }
            }
            else {
                t32_branch_control(hw1, hw2, pc, cond)
            }
        },
        _ => match hw1 >> 9 & 3 {
            // (1111 1001 xxx0: Advanced SIMD's loads and stores, A32's 1111 0100)
            0 if word & 0xFF10_0000 == 0xF900_0000 => {
                crate::aarch64::a32_simd::load_store(word & 0x00FF_FFFF | 0xF400_0000)
            },
            0 => t32_load_store(hw1, hw2, pc),
            // (1111 1010: data processing (register); 1111 1011: the multiplies)
            1 => {
                if hw1 & 1 << 8 != 0 {
                    t32_multiply(hw1, hw2)
                }
                else {
                    t32_data_register(hw1, hw2)
                }
            },
            // (1111 11xx: coprocessor, Advanced SIMD and floating point)
            _ => t32_coprocessor(hw1, hw2, pc, cond),
        },
    }
}

/// LDM, STM, LDMDB, STMDB (1110 100x x0xx)
fn t32_block_transfer(hw1: u32, hw2: u32, pc: u32) -> Result<Flow, Exception> {
    let op = hw1 >> 7 & 3;
    let w = hw1 & 1 << 5 != 0;
    let l = hw1 & 1 << 4 != 0;
    let rn = hw1 & 15;
    let list = hw2;
    if (op == 0 || op == 3) && crate::aarch64::a32_system::privileged() {
        // SRS (to SP: Rn 13, the mode in the list's bits 4:0), RFE (DB op 0, IA op 3)
        let (p, u) = (op == 0, op == 3);
        if l {
            if list != 0xC000 || !last_in_it_block() {
                return Err(Exception::Undefined);
            }
            return crate::aarch64::a32_system::rfe(p, u, w, rn);
        }
        if rn != 13 || list & 0xFFE0 != 0xC000 {
            return Err(Exception::Undefined);
        }
        return crate::aarch64::a32_system::srs(p, u, w, list & 31);
    }
    if op == 0 || op == 3 || rn == 15 || list == 0 || list & 1 << 13 != 0 {
        // (SRS, RFE: UNDEFINED at EL0; no register, SP in the list: UNPREDICTABLE.
        // One register is CONSTRAINED UNPREDICTABLE: it is transferred, as
        // Cortex-A cores and the Android emulator's QEMU do, where QEMU 9.2
        // takes it as UNDEFINED; Android 7.1's YouTube runs LDM.W R8!, {R0})
        return Err(Exception::Undefined);
    }
    if l && list & 0xC000 == 0xC000 || !l && list & 0x8000 != 0 || w && list & 1 << rn != 0 {
        return Err(Exception::Undefined);
    }
    if l && list & 1 << 15 != 0 && !last_in_it_block() {
        return Err(Exception::Undefined);
    }
    let count = list.count_ones();
    let base = reg(rn);
    let (start, new_base) = if op == 1 {
        (base, base.wrapping_add(4 * count))
    }
    else {
        let start = base.wrapping_sub(4 * count);
        (start, start)
    };
    let writeback = if w { Some(new_base) } else { None };
    let _ = pc;
    if l {
        load_multiple(rn, list, start, writeback)
    }
    else {
        store_multiple(rn, list, start, writeback, 0)
    }
}

/// LDRD, STRD, the exclusives, load-acquire/store-release, TBB/TBH (1110 100x x1xx)
fn t32_dual_exclusive(hw1: u32, hw2: u32, pc: u32) -> Result<Flow, Exception> {
    let rn = hw1 & 15;
    let rt = hw2 >> 12 & 15;
    let l = hw1 & 1 << 4 != 0;
    let p = hw1 & 1 << 8 != 0;
    let w = hw1 & 1 << 5 != 0;
    let u = hw1 & 1 << 7 != 0;
    if p || w {
        // LDRD, STRD (immediate, literal)
        let rt2 = hw2 >> 8 & 15;
        let imm = (hw2 & 0xFF) << 2;
        if bad(rt) || bad(rt2) || l && rt == rt2 || w && (rn == rt || rn == rt2 || rn == 15) {
            return Err(Exception::Undefined);
        }
        let base = if rn == 15 { pc.wrapping_add(4) & !3 } else { reg(rn) };
        let offset_address = if u { base.wrapping_add(imm) } else { base.wrapping_sub(imm) };
        let address = if p { offset_address } else { base };
        let writeback = if w { Some(offset_address) } else { None };
        return if l {
            load_dual(rt, rt2, address, rn, writeback)
        }
        else {
            store_dual(reg(rt), reg(rt2), address, rn, writeback)
        };
    }
    match hw1 >> 4 & 0xF {
        // STREX, LDREX: Rn + imm8 << 2
        0b0100 | 0b0101 => {
            let address = reg(rn).wrapping_add((hw2 & 0xFF) << 2);
            let rd = hw2 >> 8 & 15;
            if rn == 15 || bad(rt) || !l && (bad(rd) || rd == rn || rd == rt) {
                return Err(Exception::Undefined);
            }
            if l && rd != 15 {
                return Err(Exception::Undefined);
            }
            exclusive(l, 2, false, rt, 0, rd, address, pc)
        },
        // TBB, TBH, the byte, halfword and doubleword exclusives, LDA/STL
        0b1100 | 0b1101 => {
            let op = hw2 >> 4 & 15;
            let rt2 = hw2 >> 8 & 15;
            let rd = hw2 & 15;
            match op {
                0b0000 | 0b0001 if l => {
                    // TBB, TBH: a table of forward offsets (halfwords) at Rn + Rm (Rm * 2)
                    let rm = hw2 & 15;
                    if bad(rm) || rn == 13 || !last_in_it_block() {
                        return Err(Exception::Undefined);
                    }
                    let base = read(rn, pc);
                    let halfwords = op == 1;
                    let address = base.wrapping_add(if halfwords { reg(rm) << 1 } else { reg(rm) });
                    let entry = load(address, if halfwords { 2 } else { 1 }, false)?;
                    Ok(jump(pc.wrapping_add(4).wrapping_add(entry * 2)))
                },
                0b0100 | 0b0101 | 0b0111 => {
                    let size = [0, 1, 0, 3][(op & 3) as usize];
                    if rn == 15 || bad(rt) || size == 3 && (bad(rt2) || l && rt == rt2) {
                        return Err(Exception::Undefined);
                    }
                    if l {
                        if rd != 15 || size != 3 && rt2 != 15 {
                            return Err(Exception::Undefined);
                        }
                    }
                    else if bad(rd) || rd == rn || rd == rt || size == 3 && rd == rt2 {
                        return Err(Exception::Undefined);
                    }
                    exclusive(l, size, false, rt, rt2, rd, reg(rn), pc)
                },
                0b1000..=0b1111 => {
                    // LDA*/STL* (8-10), LDAEX*/STLEX* (12-15)
                    let size = op & 3;
                    if rn == 15 || bad(rt) {
                        return Err(Exception::Undefined);
                    }
                    if op & 4 == 0 {
                        if size == 3 || rt2 != 15 || rd != 15 {
                            return Err(Exception::Undefined);
                        }
                        return acquire_release(l, 1 << size, rt, reg(rn));
                    }
                    let size = [0, 1, 2, 3][size as usize];
                    if size == 3 && (bad(rt2) || l && rt == rt2) || size != 3 && rt2 != 15 {
                        return Err(Exception::Undefined);
                    }
                    if l && rd != 15
                        || !l && (bad(rd) || rd == rn || rd == rt || size == 3 && rd == rt2)
                    {
                        return Err(Exception::Undefined);
                    }
                    exclusive(l, size, true, rt, rt2, rd, reg(rn), pc)
                },
                _ => Err(Exception::Undefined),
            }
        },
        _ => Err(Exception::Undefined),
    }
}

/// The data processing operations of T32's 32-bit encodings by their op
/// (bits 8:5 of the first halfword): A32's, None for none
fn t32_op(op: u32) -> Option<u32> {
    match op {
        0b0000 => Some(DP_AND),
        0b0001 => Some(DP_BIC),
        0b0010 => Some(DP_ORR),
        0b0011 => Some(DP_ORN),
        0b0100 => Some(DP_EOR),
        0b1000 => Some(DP_ADD),
        0b1010 => Some(DP_ADC),
        0b1011 => Some(DP_SBC),
        0b1101 => Some(DP_SUB),
        0b1110 => Some(DP_RSB),
        _ => None,
    }
}

/// A data processing operation of T32's: TST, TEQ, CMN, CMP for Rd = PC with
/// S; MOV and MVN for ORR, ORN with Rn = PC
fn t32_data(op: u32, s: bool, rd: u32, rn: u32, operand: u32, c: bool) -> Result<Flow, Exception> {
    let Some(mut dp) = t32_op(op)
    else {
        return Err(Exception::Undefined);
    };
    if rd == 15 && s {
        dp = match dp {
            DP_AND => DP_TST,
            DP_EOR => DP_TEQ,
            DP_ADD => DP_CMN,
            DP_SUB => DP_CMP,
            _ => return Err(Exception::Undefined),
        };
        return data_processing(dp, true, 0, reg(rn), operand, c);
    }
    if rn == 15 {
        dp = match dp {
            DP_ORR => DP_MOV,
            DP_ORN => DP_MVN,
            _ => return Err(Exception::Undefined),
        };
        if bad(rd) {
            return Err(Exception::Undefined);
        }
        return data_processing(dp, s, rd, 0, operand, c);
    }
    // (SP: ADD and SUB only, into SP or not; other operations UNPREDICTABLE)
    if rd == 15
        || rn == 13 && dp != DP_ADD && dp != DP_SUB
        || rd == 13 && !(rn == 13 && (dp == DP_ADD || dp == DP_SUB))
    {
        return Err(Exception::Undefined);
    }
    data_processing(dp, s, rd, reg(rn), operand, c)
}

/// Data processing (shifted register), PKHBT, PKHTB (1110 101x)
fn t32_shifted_register(hw1: u32, hw2: u32) -> Result<Flow, Exception> {
    let op = hw1 >> 5 & 15;
    let s = hw1 & 1 << 4 != 0;
    let rn = hw1 & 15;
    let rd = hw2 >> 8 & 15;
    let rm = hw2 & 15;
    let imm5 = (hw2 >> 10 & 0x1C) | (hw2 >> 6 & 3);
    let kind = hw2 >> 4 & 3;
    if hw2 & 1 << 15 != 0 || bad(rm) {
        return Err(Exception::Undefined);
    }
    if op == 0b0110 {
        // PKHBT, PKHTB (tb: bit 5)
        if s || kind & 1 != 0 || bad(rd) || bad(rn) {
            return Err(Exception::Undefined);
        }
        return pack(rd, reg(rn), reg(rm), kind & 2 != 0, imm5);
    }
    let (kind, amount) = decode_imm_shift(kind, imm5);
    let (operand, c) = shift_c(reg(rm), kind, amount, carry());
    t32_data(op, s, rd, rn, operand, c)
}

/// Data processing (modified immediate) (11110 x0x / 0)
fn t32_modified_immediate(hw1: u32, hw2: u32) -> Result<Flow, Exception> {
    let op = hw1 >> 5 & 15;
    let s = hw1 & 1 << 4 != 0;
    let rn = hw1 & 15;
    let rd = hw2 >> 8 & 15;
    let imm12 = (hw1 >> 10 & 1) << 11 | (hw2 >> 12 & 7) << 8 | hw2 & 0xFF;
    let (operand, c) = expand_imm_c(imm12, carry());
    t32_data(op, s, rd, rn, operand, c)
}

/// Data processing (plain binary immediate) (11110 x1x / 0)
fn t32_plain_immediate(hw1: u32, hw2: u32, pc: u32) -> Result<Flow, Exception> {
    let op = hw1 >> 4 & 31;
    let rn = hw1 & 15;
    let rd = hw2 >> 8 & 15;
    let imm12 = (hw1 >> 10 & 1) << 11 | (hw2 >> 12 & 7) << 8 | hw2 & 0xFF;
    let imm3_imm2 = (hw2 >> 10 & 0x1C) | (hw2 >> 6 & 3);
    let width = hw2 & 31;
    if bad(rd) && !(rd == 13 && (op == 0b00000 || op == 0b01010) && rn == 13) {
        return Err(Exception::Undefined);
    }
    match op {
        // ADDW, SUBW (ADR with Rn = PC: the aligned PC)
        0b00000 | 0b01010 => {
            let base = if rn == 15 { pc.wrapping_add(4) & !3 } else { reg(rn) };
            set_reg(
                rd,
                if op == 0 { base.wrapping_add(imm12) } else { base.wrapping_sub(imm12) },
            );
            Ok(Flow::Next)
        },
        // MOVW, MOVT
        0b00100 | 0b01100 => {
            let imm16 = (hw1 & 15) << 12 | imm12;
            set_reg(
                rd,
                if op == 0b00100 { imm16 } else { reg(rd) & 0xFFFF | imm16 << 16 },
            );
            Ok(Flow::Next)
        },
        // SSAT, USAT (shift: bit 5 of the first halfword, LSL or ASR), SSAT16, USAT16
        0b10000 | 0b10010 | 0b11000 | 0b11010 => {
            if bad(rn) {
                return Err(Exception::Undefined);
            }
            let unsigned = op & 0b01000 != 0;
            let asr = hw1 & 1 << 5 != 0;
            if asr && imm3_imm2 == 0 {
                // SSAT16, USAT16
                if width & 0x10 != 0 && !unsigned || hw2 & 0x30 != 0 {
                    return Err(Exception::Undefined);
                }
                return saturate16(
                    rd,
                    reg(rn),
                    (width & 15) + if unsigned { 0 } else { 1 },
                    unsigned,
                );
            }
            let (kind, amount) =
                decode_imm_shift(if asr { SHIFT_ASR } else { SHIFT_LSL }, imm3_imm2);
            let value = shift_c(reg(rn), kind, amount, false).0;
            saturate(rd, value, width + if unsigned { 0 } else { 1 }, unsigned)
        },
        // SBFX, UBFX
        0b10100 | 0b11100 => {
            if bad(rn) {
                return Err(Exception::Undefined);
            }
            bitfield_extract(rd, reg(rn), imm3_imm2, width + 1, op == 0b10100)
        },
        // BFI, BFC (Rn = PC)
        0b10110 => {
            if rn == 13 {
                return Err(Exception::Undefined);
            }
            bitfield_insert(
                rd,
                if rn == 15 { None } else { Some(reg(rn)) },
                imm3_imm2,
                width,
            )
        },
        _ => Err(Exception::Undefined),
    }
}

/// Branches and miscellaneous control (11110 / 1)
fn t32_branch_control(hw1: u32, hw2: u32, pc: u32, cond: u32) -> Result<Flow, Exception> {
    let op1 = hw2 >> 12 & 7;
    if op1 & 0b101 == 0b000 {
        let op = hw1 >> 4 & 0x3F;
        if op & 0b111000 != 0b111000 {
            // B<cond> (T3): S:J2:J1:imm6:imm11 << 1
            if in_it_block() {
                return Err(Exception::Undefined);
            }
            let c = hw1 >> 6 & 15;
            if !condition_passed(c) {
                return Ok(Flow::Next);
            }
            let s = hw1 >> 10 & 1;
            let imm = s << 20
                | (hw2 >> 11 & 1) << 19
                | (hw2 >> 13 & 1) << 18
                | (hw1 & 0x3F) << 12
                | (hw2 & 0x7FF) << 1;
            let offset = ((imm << 11) as i32 >> 11) as u32;
            return Ok(jump(pc.wrapping_add(4).wrapping_add(offset)));
        }
        // (HVC, SMC, UDF (T2): bit 10 of the first halfword set; UNDEFINED at EL0)
        if hw1 & 1 << 10 != 0 {
            // (HVC 1111 0111 1110, SMC 1111 0111 1111, op1 0: PSCI at PL1)
            if crate::aarch64::a32_system::privileged() && op1 == 0 && hw1 >> 5 & 0x3F == 0x3F {
                return crate::aarch64::a32_system::hvc();
            }
            return Err(Exception::Undefined);
        }
        if a32_only() {
            match op {
                // MSR (register) of CPSR (mask hw2[11:8]), SPSR (R), a banked register (bit 5)
                0b111000 | 0b111001 => {
                    let rn = hw1 & 15;
                    let r = hw1 & 1 << 4 != 0;
                    if bad(rn) {
                        return Err(Exception::Undefined);
                    }
                    if hw2 & 0x20 != 0 {
                        return banked(false, r, (hw2 >> 4 & 1) << 4 | hw2 >> 8 & 15, rn);
                    }
                    let mask = hw2 >> 8 & 15;
                    if mask == 0 {
                        return Err(Exception::Undefined);
                    }
                    return if r { msr_spsr(reg(rn), mask) } else { msr_cpsr(reg(rn), mask) };
                },
                // MRS of CPSR, SPSR (R), a banked register (bit 5)
                0b111110 | 0b111111 => {
                    let rd = hw2 >> 8 & 15;
                    let r = hw1 & 1 << 4 != 0;
                    if bad(rd) {
                        return Err(Exception::Undefined);
                    }
                    if hw2 & 0x20 != 0 {
                        return banked(true, r, (hw2 >> 4 & 1) << 4 | hw1 & 15, rd);
                    }
                    return mrs(rd, r);
                },
                // CPS (imod hw2[10:9], M bit 8)
                0b111010 if hw2 & 0x700 != 0 => {
                    if in_it_block() {
                        return Err(Exception::Undefined);
                    }
                    crate::aarch64::a32_system::cps(
                        hw2 >> 9 & 3,
                        hw2 >> 5 & 7,
                        hw2 & 1 << 8 != 0,
                        hw2 & 31,
                    );
                    return Ok(Flow::Next);
                },
                // SUBS PC, LR, #imm8 (ERET: imm8 0)
                0b111101 if hw1 & 15 == 14 && hw2 & 0xFF00 == 0x8F00 => {
                    if !crate::aarch64::a32_system::privileged() || !last_in_it_block() {
                        return Err(Exception::Undefined);
                    }
                    return crate::aarch64::a32_system::exception_return(
                        reg(14).wrapping_sub(hw2 & 0xFF),
                    );
                },
                _ => {},
            }
        }
        return match op {
            // MSR (register): APSR's nzcvq (bit 11), g (bit 10)
            0b111000 | 0b111001 => {
                let rn = hw1 & 15;
                let mask = hw2 >> 10 & 3;
                if hw1 & 1 << 4 != 0 || hw2 & 0x300 != 0 || mask == 0 || bad(rn) || hw2 & 0x20 != 0
                {
                    return Err(Exception::Undefined);
                }
                msr_apsr(mask, reg(rn))
            },
            // hints, CPS (a NOP at EL0 is not encoded here: UNDEFINED)
            0b111010 => {
                if hw2 & 0x700 != 0 {
                    return Err(Exception::Undefined);
                }
                hint(hw2 & 0xFF, cond)
            },
            // CLREX, DSB, DMB, ISB
            0b111011 => match hw2 >> 4 & 15 {
                2 => clear_exclusive(),
                4 => barrier(true),
                5 | 6 => barrier(false),
                _ => Err(Exception::Undefined),
            },
            // BXJ: BX
            0b111100 => {
                let rm = hw1 & 15;
                if bad(rm) || !last_in_it_block() {
                    return Err(Exception::Undefined);
                }
                Ok(bx_write_pc(reg(rm)))
            },
            // MRS (APSR)
            0b111110 | 0b111111 => {
                let rd = hw2 >> 8 & 15;
                if hw1 & 1 << 4 != 0 || hw2 & 0x20 != 0 || bad(rd) {
                    return Err(Exception::Undefined);
                }
                mrs_apsr(rd)
            },
            // ERET, HVC, SMC: UNDEFINED at EL0; UDF (T2)
            _ => Err(Exception::Undefined),
        };
    }
    // B (T4), BL, BLX (immediate): S:I1:I2:imm10:imm11 << 1, I = NOT(J XOR S)
    if !last_in_it_block() {
        return Err(Exception::Undefined);
    }
    let s = hw1 >> 10 & 1;
    let i1 = !(hw2 >> 13 & 1 ^ s) & 1;
    let i2 = !(hw2 >> 11 & 1 ^ s) & 1;
    let imm = s << 24 | i1 << 23 | i2 << 22 | (hw1 & 0x3FF) << 12 | (hw2 & 0x7FF) << 1;
    let offset = ((imm << 7) as i32 >> 7) as u32;
    match op1 {
        // B
        0b001 | 0b011 => Ok(jump(pc.wrapping_add(4).wrapping_add(offset))),
        // BL
        0b101 | 0b111 => {
            set_reg(14, pc.wrapping_add(4) | 1);
            Ok(jump(pc.wrapping_add(4).wrapping_add(offset)))
        },
        // BLX (immediate): to A32, the target from the aligned PC (H, bit 0, is 0)
        _ => {
            if hw2 & 1 != 0 {
                return Err(Exception::Undefined);
            }
            set_reg(14, pc.wrapping_add(4) | 1);
            set_pstate_bits(PSTATE_T, 0);
            Ok(Flow::Jump(
                (pc.wrapping_add(4) & !3).wrapping_add(offset) as u64
            ))
        },
    }
}

/// Loads and stores (1111 100x): byte, halfword, word; immediate (12 or 8
/// bits with P U W), register (LSL 0-3), literal, unprivileged; the preloads
fn t32_load_store(hw1: u32, hw2: u32, pc: u32) -> Result<Flow, Exception> {
    let signed = hw1 & 1 << 8 != 0;
    let size = 1u32 << (hw1 >> 5 & 3);
    let l = hw1 & 1 << 4 != 0;
    let rn = hw1 & 15;
    let rt = hw2 >> 12 & 15;
    if size == 8 || !l && signed {
        return Err(Exception::Undefined);
    }
    // (the preloads: PLD, PLI as loads to the PC of bytes and halfwords)
    let preload = l && rt == 15 && size < 4;
    let u = hw1 & 1 << 7 != 0;
    let (address, writeback, unprivileged) = if rn == 15 {
        // literal: aligned PC + or - imm12
        if !l {
            return Err(Exception::Undefined);
        }
        let base = pc.wrapping_add(4) & !3;
        let imm = hw2 & 0xFFF;
        (
            if u { base.wrapping_add(imm) } else { base.wrapping_sub(imm) },
            None,
            false,
        )
    }
    else if u {
        (reg(rn).wrapping_add(hw2 & 0xFFF), None, false)
    }
    else if hw2 & 0xFC0 == 0 {
        // register: Rn + Rm << imm2
        let rm = hw2 & 15;
        if bad(rm) {
            return Err(Exception::Undefined);
        }
        (reg(rn).wrapping_add(reg(rm) << (hw2 >> 4 & 3)), None, false)
    }
    else if hw2 & 0xF00 == 0xE00 {
        // LDRT and the other unprivileged forms: Rn + imm8
        (reg(rn).wrapping_add(hw2 & 0xFF), None, true)
    }
    else if hw2 & 0x800 != 0 {
        // imm8 with P, U, W (P = 0 and W = 0 is not one)
        let p = hw2 & 0x400 != 0;
        let up = hw2 & 0x200 != 0;
        let w = hw2 & 0x100 != 0;
        if !p && !w {
            return Err(Exception::Undefined);
        }
        let imm = hw2 & 0xFF;
        let offset_address = if up { reg(rn).wrapping_add(imm) } else { reg(rn).wrapping_sub(imm) };
        if w && (rn == rt || preload) {
            return Err(Exception::Undefined);
        }
        (
            if p { offset_address } else { reg(rn) },
            if w { Some(offset_address) } else { None },
            false,
        )
    }
    else {
        return Err(Exception::Undefined);
    };
    if preload {
        return Ok(Flow::Next);
    }
    if l {
        if rt == 15 && (size != 4 || !last_in_it_block()) || rt == 13 && size != 4 {
            return Err(Exception::Undefined);
        }
        load_register(rt, address, size, signed, rn, writeback, unprivileged)
    }
    else {
        if rt == 15 || rn == 15 {
            return Err(Exception::Undefined);
        }
        store_register(reg(rt), address, size, rn, writeback, unprivileged)
    }
}

/// Data processing (register) (1111 1010): shifts by a register, the
/// extends, the parallel additions and subtractions, the miscellaneous ones
fn t32_data_register(hw1: u32, hw2: u32) -> Result<Flow, Exception> {
    let op1 = hw1 >> 4 & 15;
    let rn = hw1 & 15;
    let rd = hw2 >> 8 & 15;
    let rm = hw2 & 15;
    let op2 = hw2 >> 4 & 15;
    if hw2 >> 12 != 0b1111 || bad(rd) || bad(rm) {
        return Err(Exception::Undefined);
    }
    if op1 < 8 && op2 == 0 {
        // LSL, LSR, ASR, ROR (register), S in bit 4
        if bad(rn) {
            return Err(Exception::Undefined);
        }
        let kind = op1 >> 1;
        let (value, c) = shift_c(reg(rn), kind, reg(rm) & 0xFF, carry());
        return data_processing(DP_MOV, op1 & 1 != 0, rd, 0, value, c);
    }
    if op1 < 8 && op2 & 8 != 0 {
        // SXTAH, UXTAH, SXTAB16, UXTAB16, SXTAB, UXTAB (Rn = PC: no addend)
        let rotation = 8 * (op2 & 3);
        if rn == 13 || op2 & 4 != 0 {
            return Err(Exception::Undefined);
        }
        let addend = if rn == 15 { None } else { Some(reg(rn)) };
        let m = reg(rm);
        return match op1 {
            0 => extend(rd, addend, m, rotation, 16, true, false),
            1 => extend(rd, addend, m, rotation, 16, false, false),
            2 => extend(rd, addend, m, rotation, 8, true, true),
            3 => extend(rd, addend, m, rotation, 8, false, true),
            4 => extend(rd, addend, m, rotation, 8, true, false),
            5 => extend(rd, addend, m, rotation, 8, false, false),
            _ => Err(Exception::Undefined),
        };
    }
    if bad(rn) {
        return Err(Exception::Undefined);
    }
    if op1 & 8 != 0 && op2 < 8 {
        // parallel additions and subtractions: op1 2:0 the operation (A32's
        // op), op2 1:0 the kind (00 signed, 01 saturating, 10 halving),
        // op2 bit 2 unsigned
        let op = match op1 & 7 {
            0b001 => 0, // ADD16
            0b010 => 1, // ASX
            0b110 => 2, // SAX
            0b101 => 3, // SUB16
            0b000 => 4, // ADD8
            0b100 => 7, // SUB8
            _ => return Err(Exception::Undefined),
        };
        let mode = match op2 & 3 {
            0 => 1,
            1 => 2,
            2 => 3,
            _ => return Err(Exception::Undefined),
        };
        let kind = mode | (op2 & 4);
        return parallel(kind, op, rd, reg(rn), reg(rm));
    }
    if op1 & 0b1100 == 0b1000 && op2 & 0b1100 == 0b1000 {
        // the miscellaneous: QADD, QDADD, QSUB, QDSUB; REV, REV16, RBIT, REVSH; SEL; CLZ; CRC32
        let (n, m) = (reg(rn), reg(rm));
        return match (op1 & 3, op2 & 3) {
            // (QADD Rd, Rm, Rn: Rm + Rn, QSUB: Rm - Rn, QDADD: Rm + 2 Rn)
            (0, 0) => saturating_add(0, rd, n, m),
            (0, 1) => saturating_add(2, rd, n, m),
            (0, 2) => saturating_add(1, rd, n, m),
            (0, 3) => saturating_add(3, rd, n, m),
            // (REV and friends: Rn and Rm the same register)
            (1, _) if rn != rm => Err(Exception::Undefined),
            (1, 0) => bit_op(0, rd, m),
            (1, 1) => bit_op(1, rd, m),
            (1, 2) => bit_op(3, rd, m),
            (1, 3) => bit_op(2, rd, m),
            (2, 0) => select(rd, n, m),
            (3, 0) if rn == rm => bit_op(4, rd, m),
            _ => Err(Exception::Undefined),
        };
    }
    if op1 & 0b1100 == 0b1100 && op2 & 0b1100 == 0b1000 {
        // CRC32{C}{B,H,W}: sz in op2 1:0, C in op1 bit 0... (1111 1010 1100 Rn / 1111 Rd 10 sz Rm)
        let castagnoli = op1 & 1 != 0;
        if op1 & 2 != 0 {
            return Err(Exception::Undefined);
        }
        return crc32(rd, reg(rn), reg(rm), op2 & 3, castagnoli);
    }
    Err(Exception::Undefined)
}

/// The multiplies, multiply-accumulates, the long ones and the divides (1111 1011)
fn t32_multiply(hw1: u32, hw2: u32) -> Result<Flow, Exception> {
    let op1 = hw1 >> 4 & 7;
    let rn = hw1 & 15;
    let ra = hw2 >> 12 & 15;
    let rd = hw2 >> 8 & 15;
    let op2 = hw2 >> 4 & 15;
    let rm = hw2 & 15;
    if bad(rn) || bad(rm) || bad(rd) {
        return Err(Exception::Undefined);
    }
    let (n, m) = (reg(rn), reg(rm));
    if hw1 & 1 << 7 == 0 {
        // the 32-bit products: Ra = PC for none
        if ra == 13 {
            return Err(Exception::Undefined);
        }
        return match (op1, op2) {
            (0, 0) => {
                if ra == 15 {
                    multiply(0, false, rd, n, m, 0)
                }
                else {
                    multiply(1, false, rd, n, m, reg(ra))
                }
            },
            (0, 1) if ra != 15 => multiply(2, false, rd, n, m, reg(ra)),
            // SMLA<x><y>, SMUL<x><y>: N bit 5, M bit 4 of the second halfword
            (1, 0..=3) => {
                let n_top = op2 & 2 != 0;
                let m_top = op2 & 1 != 0;
                if ra == 15 {
                    multiply_halfword(3, rd, 0, n, m, n_top, m_top, false)
                }
                else {
                    multiply_halfword(0, rd, ra, n, m, n_top, m_top, true)
                }
            },
            // SMLAD, SMUAD, SMLSD, SMUSD (X: bit 4)
            (2, 0 | 1) => multiply_dual(rd, ra, n, m, false, op2 & 1 != 0, false),
            (4, 0 | 1) => multiply_dual(rd, ra, n, m, true, op2 & 1 != 0, false),
            // SMLAW<y>, SMULW<y>
            (3, 0 | 1) => multiply_halfword(1, rd, ra, n, m, false, op2 & 1 != 0, ra != 15),
            // SMMLA, SMMUL, SMMLS (R: bit 4)
            (5, 0 | 1) => multiply_most(rd, ra, n, m, false, op2 & 1 != 0),
            (6, 0 | 1) if ra != 15 => multiply_most(rd, ra, n, m, true, op2 & 1 != 0),
            // USAD8, USADA8
            (7, 0) => sum_absolute(rd, ra, n, m),
            _ => Err(Exception::Undefined),
        };
    }
    // the 64-bit products, the divides: RdLo in 15:12, RdHi in 11:8
    let (lo, hi) = (ra, rd);
    match (op1, op2) {
        (1, 15) if ra == 15 => divide(rd, n, m, true),
        (3, 15) if ra == 15 => divide(rd, n, m, false),
        _ => {
            if bad(lo) || lo == hi {
                return Err(Exception::Undefined);
            }
            match (op1, op2) {
                (0, 0) => multiply_long(6, false, lo, hi, n, m),
                (2, 0) => multiply_long(4, false, lo, hi, n, m),
                (4, 0) => multiply_long(7, false, lo, hi, n, m),
                (6, 0) => multiply_long(5, false, lo, hi, n, m),
                (6, 6) => multiply_long(2, false, lo, hi, n, m),
                // SMLAL<x><y>
                (4, 8..=11) => multiply_halfword(2, hi, lo, n, m, op2 & 2 != 0, op2 & 1 != 0, true),
                // SMLALD, SMLSLD
                (4, 12 | 13) => multiply_dual(hi, lo, n, m, false, op2 & 1 != 0, true),
                (5, 12 | 13) => multiply_dual(hi, lo, n, m, true, op2 & 1 != 0, true),
                _ => Err(Exception::Undefined),
            }
        },
    }
}

/// The coprocessor space (111x 11xx): VFP (coprocessors 10, 11: A32's
/// encodings with the condition 1110, and ARMv8's unconditional ones),
/// Advanced SIMD's data processing, MCR, MRC, MCRR, MRRC of CP15; the
/// rest UNDEFINED
fn t32_coprocessor(hw1: u32, hw2: u32, pc: u32, cond: u32) -> Result<Flow, Exception> {
    let cp = hw2 >> 8 & 15;
    let word = hw1 << 16 | hw2;
    // (111U 1111: Advanced SIMD data processing, A32's 1111 001U)
    if word & 0xEF00_0000 == 0xEF00_0000 {
        return crate::aarch64::a32_simd::data_processing(
            word & 0xE2FF_FFFF | (word & 1 << 28) >> 4 | 1 << 28,
        );
    }
    if hw1 >> 8 == 0xFE {
        return crate::aarch64::a32_fp::vfp_unconditional(word);
    }
    if (cp == 10 || cp == 11) && hw1 >> 12 == 0xE {
        return crate::aarch64::a32_fp::vfp(
            word & 0x0FFF_FFFF | 0xE000_0000,
            pc.wrapping_add(4),
            true,
        );
    }
    if cp == 14 && hw1 >> 12 & 1 == 0 && hw1 >> 8 & 15 == 0b1110 && hw2 & 1 << 4 != 0 {
        return crate::aarch64::a32_system::cp14(hw1 & 1 << 4 != 0, hw2 >> 12 & 15);
    }
    // (MCR2 and the other 1111 forms: UNDEFINED)
    if cp != 15 || hw1 >> 12 & 1 != 0 {
        return Err(Exception::Undefined);
    }
    let rt = hw2 >> 12 & 15;
    if hw1 >> 8 & 15 == 0b1110 && hw2 & 1 << 4 != 0 {
        if rt == 15 || rt == 13 {
            return Err(Exception::Undefined);
        }
        let read = hw1 & 1 << 4 != 0;
        return cp15(
            read,
            hw1 >> 5 & 7,
            hw1 & 15,
            hw2 & 15,
            hw2 >> 5 & 7,
            rt,
            reg(rt),
            cond,
        );
    }
    if hw1 >> 5 & 0x7F == 0b1100010 || hw1 >> 4 & 0xFE == 0xC4 {
        let rt2 = hw1 & 15;
        if bad(rt) || bad(rt2) {
            return Err(Exception::Undefined);
        }
        let read = hw1 & 1 << 4 != 0;
        let value = (reg(rt2) as u64) << 32 | reg(rt) as u64;
        return cp15_64(read, hw2 >> 4 & 15, hw2 & 15, rt, rt2, value, cond);
    }
    Err(Exception::Undefined)
}
