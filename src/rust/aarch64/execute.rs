//! The A64 interpreter (docs/arm64-virt-android16-plan.md P2.2-P2.4, P2.9):
//! integer data processing, branches, loads and stores, exclusives, CRC32
//! and the system instructions. `interpret_one` executes the instruction at
//! the PC: an instruction that faults has written no state, and the
//! exception is taken instead (P2.9, the JIT plan's StepFrontend). Decoded
//! instructions are cached by their 32-bit word, so a cache entry is valid
//! whenever its word matches (P2.2).

use crate::aarch64::cpu::{self, *};
use crate::aarch64::decode::{
    self, Inst, Op, LS_LOAD, LS_PREFETCH, LS_SIGNED, LS_SIMD, LS_TO_W, LS_UNPRIVILEGED,
};
use crate::aarch64::decode::{MODE_POST, MODE_PRE, MODE_REGISTER};
use crate::aarch64::memory::{self, Syndrome};
use crate::aarch64::psci;
use crate::aarch64::state::{event_register, excl_addr, excl_valid, excl_value};
use crate::aarch64::sysregs;
use crate::aarch64::{crypto, fp, simd, simd_fp};

// ---- the decode cache (by instruction word)

const DECODE_CACHE_BITS: u32 = 12;
static mut DECODE_CACHE: [(u32, Inst); 1 << DECODE_CACHE_BITS] =
    [(0, Inst::UNDEF); 1 << DECODE_CACHE_BITS];

#[inline(always)]
pub fn decode_cached(word: u32) -> Inst {
    let index = (word.wrapping_mul(0x9E37_79B1) >> (32 - DECODE_CACHE_BITS)) as usize;
    let cache = unsafe { &mut *(&raw mut DECODE_CACHE) };
    let entry = &mut cache[index];
    if entry.0 != word {
        *entry = (word, decode::decode(word));
    }
    entry.1
}

// ---- helpers

/// What an instruction does to the PC
pub enum Flow {
    /// the next instruction
    Next,
    /// a branch
    Jump(u64),
    /// the PC was set (an exception return, an exception taken by the instruction)
    Set,
    /// the core waits (WFI, WFE, CPU_SUSPEND) after the instruction
    Wait(u32),
    /// the core stopped (CPU_OFF, SYSTEM_OFF)
    Off,
    /// YIELD: the next instruction, and the other cores may run first
    Yield,
    /// The instruction waits for other cores (a DSB for their TLB maintenance,
    /// P8.3): the PC stays, the core gives up its turn
    Retry,
}

#[inline(always)]
fn mask(sf: bool) -> u64 {
    if sf {
        u64::MAX
    }
    else {
        0xFFFF_FFFF
    }
}

#[inline(always)]
fn nzcv_of(result: u64, sf: bool, carry: bool, overflow: bool) -> u32 {
    let negative = if sf { result >> 63 } else { result >> 31 & 1 } != 0;
    let zero = result & mask(sf) == 0;
    (negative as u32) << 31 | (zero as u32) << 30 | (carry as u32) << 29 | (overflow as u32) << 28
}

/// AddWithCarry: the result and NZCV
#[inline(always)]
pub fn add_with_carry(x: u64, y: u64, carry_in: bool, sf: bool) -> (u64, u32) {
    if sf {
        let (r1, c1) = x.overflowing_add(y);
        let (result, c2) = r1.overflowing_add(carry_in as u64);
        let overflow = ((x ^ result) & (y ^ result)) >> 63 != 0;
        (result, nzcv_of(result, true, c1 || c2, overflow))
    }
    else {
        let (x, y) = (x as u32, y as u32);
        let (r1, c1) = x.overflowing_add(y);
        let (result, c2) = r1.overflowing_add(carry_in as u32);
        let overflow = ((x ^ result) & (y ^ result)) >> 31 != 0;
        (
            result as u64,
            nzcv_of(result as u64, false, c1 || c2, overflow),
        )
    }
}

/// A shifted register operand: LSL, LSR, ASR, ROR
#[inline(always)]
pub fn shift_reg(value: u64, kind: u8, amount: u32, sf: bool) -> u64 {
    if sf {
        match kind {
            0 => value << amount,
            1 => value >> amount,
            2 => ((value as i64) >> amount) as u64,
            _ => value.rotate_right(amount),
        }
    }
    else {
        let v = value as u32;
        (match kind {
            0 => v << amount,
            1 => v >> amount,
            2 => ((v as i32) >> amount) as u32,
            _ => v.rotate_right(amount),
        }) as u64
    }
}

/// An extended register operand: UXTB, UXTH, UXTW, UXTX, SXTB, SXTH, SXTW, SXTX, shifted left
#[inline(always)]
pub fn extend_reg(value: u64, option: u8, amount: u32) -> u64 {
    let extended = match option {
        0 => value as u8 as u64,
        1 => value as u16 as u64,
        2 => value as u32 as u64,
        3 => value,
        4 => value as i8 as i64 as u64,
        5 => value as i16 as i64 as u64,
        6 => value as i32 as i64 as u64,
        _ => value,
    };
    extended << amount
}

/// ConditionHolds for NZCV
#[inline(always)]
pub fn condition_holds(cond: u8, flags: u32) -> bool {
    let n = flags >> 31 & 1 != 0;
    let z = flags >> 30 & 1 != 0;
    let c = flags >> 29 & 1 != 0;
    let v = flags >> 28 & 1 != 0;
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
    if cond & 1 != 0 && cond != 0b1111 {
        !result
    }
    else {
        result
    }
}

/// The masks of a bitfield instruction (DecodeBitMasks without the
/// immediate's restrictions): wmask, tmask
pub(crate) fn bitfield_masks(n: u32, imms: u32, immr: u32, sf: bool) -> (u64, u64) {
    let combined = n << 6 | !imms & 0x3F;
    let len = 31 - combined.leading_zeros();
    let levels = (1u32 << len) - 1;
    let s = imms & levels;
    let r = immr & levels;
    let diff = s.wrapping_sub(r) & levels;
    let esize = 1u32 << len;
    let ones = |count: u32| if count >= 64 { u64::MAX } else { (1u64 << count) - 1 };
    let emask = ones(esize);
    let welem = ones(s + 1);
    let telem = ones(diff + 1);
    let wrot = if r == 0 { welem } else { (welem >> r | welem << (esize - r)) & emask };
    let replicate = |element: u64| {
        let mut result = 0;
        let mut at = 0;
        while at < 64 {
            result |= element << at;
            at += esize;
        }
        result
    };
    let width = mask(sf);
    (replicate(wrot) & width, replicate(telem) & width)
}

/// The SP alignment check of a load or store with the SP as its base
#[inline(always)]
pub(crate) fn check_sp(rn: u32, base: u64) -> Result<(), Exception> {
    if rn == 31 && base & 15 != 0 {
        let sctlr = cpu::sctlr();
        if sctlr & if cpu::el() == 0 { SCTLR_SA0 } else { SCTLR_SA } != 0 {
            return Err(Exception::SpAlignment);
        }
    }
    Ok(())
}

/// A branch target (TBI: AArch64.BranchAddr)
#[inline(always)]
fn branch_target(target: u64) -> u64 { crate::aarch64::mmu::branch_address(target) }

// ---- CRC32

fn crc32(acc: u32, value: u64, bytes: u32, castagnoli: bool) -> u32 {
    let poly: u32 = if castagnoli { 0x82F6_3B78 } else { 0xEDB8_8320 };
    let mut crc = acc;
    for i in 0..bytes {
        crc ^= (value >> (8 * i)) as u8 as u32;
        for _ in 0..8 {
            crc = crc >> 1 ^ poly & (crc & 1).wrapping_neg();
        }
    }
    crc
}

// ---- DC ZVA

/// DC ZVA: zero the 64-byte block holding `va` (DCZID_EL0.BS = 4); an
/// alignment fault on Device memory (the MMU off, or a Device mapping), as
/// the Arm ARM says (QEMU zeroes there: an allowed difference). DC ZVA is no
/// cache maintenance instruction for ESR.CM, which stays 0.
pub fn dc_zva(va: u64, rt: u32) -> Result<(), Exception> {
    let block = va & !63;
    let syndrome = Syndrome {
        register: rt,
        ..Syndrome::NONE
    };
    let device_fault = Exception::DataAbort {
        iss: FSC_ALIGNMENT | 1 << 6,
        far: va,
    };
    if cpu::sctlr() & SCTLR_M == 0 {
        return Err(device_fault);
    }
    // (one 64-byte block lies in one page: checked once, then written as 8 doublewords)
    memory::prepare_write(block, 64, false, syndrome).map_err(|e| with_far(e, va))?;
    if let Ok(translation) =
        crate::aarch64::mmu::translate(block, memory::Access::Write, cpu::el() == 0, 1)
    {
        if translation.device {
            return Err(device_fault);
        }
    }
    for i in 0..8 {
        memory::write(block + 8 * i, 8, 0, false, syndrome).map_err(|e| with_far(e, va))?;
    }
    Ok(())
}

fn with_far(exception: Exception, far: u64) -> Exception {
    match exception {
        Exception::DataAbort { iss, .. } => Exception::DataAbort { iss, far },
        other => other,
    }
}

// ---- execution

/// Execute `inst` (`word`, at `address`)
pub fn execute(inst: &Inst, address: u64) -> Result<Flow, Exception> {
    let i = inst;
    let rd = i.rd as u32;
    let rn = i.rn as u32;
    let rm = i.rm as u32;
    let sf = i.sf;
    match i.op {
        Op::Undef => Err(Exception::Undefined),

        // ---- data processing (immediate)
        Op::Adr => {
            set_x(rd, address.wrapping_add(i.imm));
            Ok(Flow::Next)
        },
        Op::Adrp => {
            set_x(rd, (address & !0xFFF).wrapping_add(i.imm));
            Ok(Flow::Next)
        },
        Op::AddSubImm => {
            let x = xr_sp(rn);
            let (result, flags) = if i.sub == 0 {
                add_with_carry(x, i.imm, false, sf)
            }
            else {
                add_with_carry(x, !i.imm, true, sf)
            };
            if i.s {
                set_nzcv(flags);
                set_xw(rd, sf, result);
            }
            else {
                set_xw_sp(rd, sf, result);
            }
            Ok(Flow::Next)
        },
        Op::LogicalImm => {
            let x = xr(rn);
            let result = match i.sub {
                0 | 3 => x & i.imm,
                1 => x | i.imm,
                _ => x ^ i.imm,
            } & mask(sf);
            if i.sub == 3 {
                set_nzcv(nzcv_of(result, sf, false, false));
                set_xw(rd, sf, result);
            }
            else {
                set_xw_sp(rd, sf, result);
            }
            Ok(Flow::Next)
        },
        Op::MoveWide => {
            let shifted = i.imm << i.amount;
            let result = match i.sub {
                0 => !shifted,
                2 => shifted,
                _ => xr(rd) & !(0xFFFF << i.amount) | shifted,
            };
            set_xw(rd, sf, result);
            Ok(Flow::Next)
        },
        Op::Bitfield => {
            let imms = i.imm as u32;
            let immr = i.amount as u32;
            let (wmask, tmask) = bitfield_masks(sf as u32, imms, immr, sf);
            let src = xr(rn);
            let rotated = shift_reg(src, 3, immr, sf) & mask(sf);
            let result = match i.sub {
                0 => {
                    let bot = rotated & wmask;
                    let sign = src >> imms & 1;
                    let top = if sign != 0 { mask(sf) } else { 0 };
                    top & !tmask | bot & tmask
                },
                1 => {
                    let dst = xr(rd);
                    let bot = dst & !wmask | rotated & wmask;
                    dst & !tmask | bot & tmask
                },
                _ => rotated & wmask & tmask,
            };
            set_xw(rd, sf, result);
            Ok(Flow::Next)
        },
        Op::Extr => {
            let lsb = i.amount as u32;
            let result = if sf {
                if lsb == 0 {
                    xr(rm)
                }
                else {
                    xr(rm) >> lsb | xr(rn) << (64 - lsb)
                }
            }
            else {
                let concatenated = (wr(rn) as u64) << 32 | wr(rm) as u64;
                (concatenated >> lsb) as u32 as u64
            };
            set_xw(rd, sf, result);
            Ok(Flow::Next)
        },

        // ---- branches
        Op::BCond => {
            if condition_holds(i.cond, get_nzcv()) {
                Ok(Flow::Jump(branch_target(address.wrapping_add(i.imm))))
            }
            else {
                Ok(Flow::Next)
            }
        },
        Op::Branch => {
            if i.sub == 1 {
                set_x(30, address.wrapping_add(4));
            }
            Ok(Flow::Jump(branch_target(address.wrapping_add(i.imm))))
        },
        Op::BranchReg => {
            if i.sub == 5 {
                // DRPS: UNDEF outside Debug state
                return Err(Exception::Undefined);
            }
            let target = xr(rn);
            if i.sub == 1 {
                set_x(30, address.wrapping_add(4));
            }
            Ok(Flow::Jump(branch_target(target)))
        },
        Op::CompareBranch => {
            let zero = xr(rd) & mask(sf) == 0;
            if zero == (i.sub == 0) {
                Ok(Flow::Jump(branch_target(address.wrapping_add(i.imm))))
            }
            else {
                Ok(Flow::Next)
            }
        },
        Op::TestBranch => {
            let set = xr(rd) >> i.amount & 1 != 0;
            if set == (i.sub == 1) {
                Ok(Flow::Jump(branch_target(address.wrapping_add(i.imm))))
            }
            else {
                Ok(Flow::Next)
            }
        },
        Op::ExceptionGen => {
            let imm = i.imm as u16;
            match i.sub {
                1 => Err(Exception::Svc(imm)),
                2 => {
                    if cpu::el() == 0 {
                        return Err(Exception::Undefined);
                    }
                    Ok(match psci::call() {
                        psci::After::Continue => Flow::Next,
                        psci::After::Wait => Flow::Wait(1),
                        psci::After::Off => Flow::Off,
                    })
                },
                4 => Err(Exception::Brk(imm)),
                // SMC (no EL3), HLT (halting debug is off)
                _ => Err(Exception::Undefined),
            }
        },
        Op::Eret => {
            if cpu::el() == 0 {
                return Err(Exception::Undefined);
            }
            cpu::exception_return();
            Ok(Flow::Set)
        },
        Op::Hint => match i.imm {
            // WFE: wait unless the event register is set (it traps at EL0 with
            // SCTLR_EL1.nTWE clear only when it would wait)
            2 => unsafe {
                if *event_register != 0 {
                    *event_register = 0;
                    Ok(Flow::Next)
                }
                else if cpu::el() == 0 && cpu::sctlr() & SCTLR_NTWE == 0 {
                    Err(Exception::Wfx(1))
                }
                else {
                    Ok(Flow::Wait(2))
                }
            },
            3 => {
                if cpu::el() == 0 && cpu::sctlr() & SCTLR_NTWI == 0 {
                    return Err(Exception::Wfx(0));
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
            1 => Ok(Flow::Yield),
            // NOP and the unimplemented hints (ESB, PSB, CSDB, PAC, BTI, ...)
            _ => Ok(Flow::Next),
        },
        Op::Clrex => {
            unsafe { *excl_valid = 0 };
            crate::aarch64::smp::release();
            Ok(Flow::Next)
        },
        Op::Barrier => {
            crate::parallel::full_fence();
            // (DSB: with cores in workers, the TLB maintenance and IC this
            // core posted are done on the others first, P8.3)
            if i.sub == 0 && !crate::aarch64::tlb::synced() {
                return Ok(Flow::Retry);
            }
            Ok(Flow::Next)
        },
        Op::MsrImm => {
            sysregs::write_pstate_field(i.sub, i.imm as u32)?;
            Ok(Flow::Next)
        },
        Op::Sys => {
            if i.sub == 1 {
                // SYSL: none in v1
                return Err(Exception::Undefined);
            }
            sysregs::sys(i.imm as u32, rd)?;
            Ok(Flow::Next)
        },
        Op::Mrs => {
            let value = sysregs::read(i.imm as u32, rd)?;
            set_x(rd, value);
            Ok(Flow::Next)
        },
        Op::Msr => {
            sysregs::write(i.imm as u32, rd, xr(rd))?;
            Ok(Flow::Next)
        },

        // ---- loads and stores
        Op::LoadLiteral if i.sub >= 4 => {
            // LDR (literal, SIMD&FP): S, D, Q
            fp::check_access()?;
            let va = address.wrapping_add(i.imm);
            let value = simd::read_vector(va, 4 << (i.sub - 4))?;
            simd::set_vreg(rd, value);
            Ok(Flow::Next)
        },
        Op::LoadLiteral => {
            let va = address.wrapping_add(i.imm);
            let syndrome = Syndrome {
                valid: true,
                size_log: 2,
                register: rd,
                ..Syndrome::NONE
            };
            match i.sub {
                0 => set_x(rd, memory::read(va, 4, false, syndrome)?),
                1 => set_x(
                    rd,
                    memory::read(
                        va,
                        8,
                        false,
                        Syndrome {
                            size_log: 3,
                            sixty_four: true,
                            ..syndrome
                        },
                    )?,
                ),
                2 => set_x(
                    rd,
                    memory::read(
                        va,
                        4,
                        false,
                        Syndrome {
                            signed: true,
                            sixty_four: true,
                            ..syndrome
                        },
                    )? as u32 as i32 as i64 as u64,
                ),
                _ => {},
            }
            Ok(Flow::Next)
        },
        Op::LoadStore => load_store(i),
        Op::LoadStorePair => load_store_pair(i),
        Op::Exclusive => exclusive(i, address),
        Op::LoadAcquireStoreRelease => {
            let size_log = i.cond as u32;
            let size = 1u32 << size_log;
            let base = xr_sp(rn);
            check_sp(rn, base)?;
            // (aligned, or an alignment fault even to Normal memory)
            let syndrome = Syndrome {
                valid: true,
                size_log,
                register: rd,
                sixty_four: size_log == 3,
                acquire_release: true,
                ..Syndrome::NONE
            };
            if base & (size as u64 - 1) != 0 {
                return Err(alignment(base, i.sub == 0, syndrome));
            }
            if i.sub == 1 {
                let value = memory::read(base, size, false, syndrome)?;
                crate::parallel::full_fence();
                set_x(rd, value);
            }
            else {
                crate::parallel::full_fence();
                memory::write(base, size, xr(rd), false, syndrome)?;
            }
            Ok(Flow::Next)
        },

        // ---- data processing (register)
        Op::LogicalShifted => {
            let operand = shift_reg(xr(rm), i.shift, i.amount as u32, sf);
            let operand = if i.sub & 1 != 0 { !operand } else { operand };
            let x = xr(rn);
            let result = match i.sub >> 1 {
                0 | 3 => x & operand,
                1 => x | operand,
                _ => x ^ operand,
            } & mask(sf);
            if i.sub >> 1 == 3 {
                set_nzcv(nzcv_of(result, sf, false, false));
            }
            set_xw(rd, sf, result);
            Ok(Flow::Next)
        },
        Op::AddSubShifted => {
            let operand = shift_reg(xr(rm), i.shift, i.amount as u32, sf);
            let x = xr(rn);
            let (result, flags) = if i.sub == 0 {
                add_with_carry(x, operand, false, sf)
            }
            else {
                add_with_carry(x, !operand, true, sf)
            };
            if i.s {
                set_nzcv(flags);
            }
            set_xw(rd, sf, result);
            Ok(Flow::Next)
        },
        Op::AddSubExtended => {
            let operand = extend_reg(xr(rm), i.shift, i.amount as u32);
            let x = xr_sp(rn);
            let (result, flags) = if i.sub == 0 {
                add_with_carry(x, operand, false, sf)
            }
            else {
                add_with_carry(x, !operand, true, sf)
            };
            if i.s {
                set_nzcv(flags);
                set_xw(rd, sf, result);
            }
            else {
                set_xw_sp(rd, sf, result);
            }
            Ok(Flow::Next)
        },
        Op::AddSubCarry => {
            let carry = get_nzcv() & NZCV_C != 0;
            let operand = if i.sub == 0 { xr(rm) } else { !xr(rm) };
            let (result, flags) = add_with_carry(xr(rn), operand, carry, sf);
            if i.s {
                set_nzcv(flags);
            }
            set_xw(rd, sf, result);
            Ok(Flow::Next)
        },
        Op::CondCompare => {
            if condition_holds(i.cond, get_nzcv()) {
                let operand = if i.amount == 1 { rm as u64 } else { xr(rm) };
                let (_, flags) = if i.sub == 0 {
                    add_with_carry(xr(rn), operand, false, sf)
                }
                else {
                    add_with_carry(xr(rn), !operand, true, sf)
                };
                set_nzcv(flags);
            }
            else {
                set_nzcv((i.imm as u32) << 28);
            }
            Ok(Flow::Next)
        },
        Op::CondSelect => {
            let result = if condition_holds(i.cond, get_nzcv()) {
                xr(rn)
            }
            else {
                let m = xr(rm);
                match i.sub {
                    0 => m,
                    1 => m.wrapping_add(1),
                    2 => !m,
                    _ => m.wrapping_neg(),
                }
            };
            set_xw(rd, sf, result);
            Ok(Flow::Next)
        },
        Op::DataProc3 => {
            let ra = i.ra as u32;
            let (n, m, a) = (xr(rn), xr(rm), xr(ra));
            let result = match i.sub {
                0 => a.wrapping_add(n.wrapping_mul(m)),
                1 => a.wrapping_sub(n.wrapping_mul(m)),
                2 => a.wrapping_add(
                    (n as u32 as i32 as i64).wrapping_mul(m as u32 as i32 as i64) as u64,
                ),
                3 => a.wrapping_sub(
                    (n as u32 as i32 as i64).wrapping_mul(m as u32 as i32 as i64) as u64,
                ),
                4 => ((n as i64 as i128 * m as i64 as i128) >> 64) as u64,
                10 => a.wrapping_add((n as u32 as u64).wrapping_mul(m as u32 as u64)),
                11 => a.wrapping_sub((n as u32 as u64).wrapping_mul(m as u32 as u64)),
                _ => ((n as u128 * m as u128) >> 64) as u64,
            };
            set_xw(rd, sf, result);
            Ok(Flow::Next)
        },
        Op::DataProc2 => {
            let (n, m) = (xr(rn), xr(rm));
            let width = if sf { 64 } else { 32 };
            let result = match i.sub {
                0b000010 => {
                    if sf {
                        if m == 0 {
                            0
                        }
                        else {
                            n / m
                        }
                    }
                    else {
                        let (n, m) = (n as u32, m as u32);
                        if m == 0 {
                            0
                        }
                        else {
                            (n / m) as u64
                        }
                    }
                },
                0b000011 => {
                    if sf {
                        if m == 0 {
                            0
                        }
                        else {
                            (n as i64).wrapping_div(m as i64) as u64
                        }
                    }
                    else {
                        let (n, m) = (n as u32 as i32, m as u32 as i32);
                        if m == 0 {
                            0
                        }
                        else {
                            n.wrapping_div(m) as u32 as u64
                        }
                    }
                },
                0b001000..=0b001011 => shift_reg(n, i.sub - 0b001000, (m % width) as u32, sf),
                op => {
                    let bytes = 1 << (op & 3);
                    crc32(n as u32, m, bytes, op & 0b100 != 0) as u64
                },
            };
            if i.sub >= 0b010000 {
                // (CRC32X takes a 64-bit value; every CRC32 result is a W register)
                set_w(rd, result as u32);
            }
            else {
                set_xw(rd, sf, result);
            }
            Ok(Flow::Next)
        },
        Op::DataProc1 => {
            let n = xr(rn);
            let result = match (i.sub, sf) {
                (0, true) => n.reverse_bits(),
                (0, false) => (n as u32).reverse_bits() as u64,
                (1, _) => {
                    let swapped =
                        (n & 0x00FF_00FF_00FF_00FF) << 8 | (n & 0xFF00_FF00_FF00_FF00) >> 8;
                    swapped & mask(sf)
                },
                (2, true) => {
                    let low = (n as u32).swap_bytes() as u64;
                    let high = ((n >> 32) as u32).swap_bytes() as u64;
                    high << 32 | low
                },
                (2, false) => (n as u32).swap_bytes() as u64,
                (3, _) => n.swap_bytes(),
                (4, true) => n.leading_zeros() as u64,
                (4, false) => (n as u32).leading_zeros() as u64,
                (_, true) => {
                    let sign_bits =
                        if (n as i64) < 0 { (!n).leading_zeros() } else { n.leading_zeros() };
                    (sign_bits - 1) as u64
                },
                (_, false) => {
                    let w = n as u32;
                    let sign_bits =
                        if (w as i32) < 0 { (!w).leading_zeros() } else { w.leading_zeros() };
                    (sign_bits - 1) as u64
                },
            };
            set_xw(rd, sf, result);
            Ok(Flow::Next)
        },
        // ---- scalar FP, AdvSIMD, crypto (P2.5-P2.8, P2.11)
        Op::SimdStructure => simd::structure(i.imm as u32),
        _ => {
            fp::check_access()?;
            let word = i.imm as u32;
            Ok(match i.op {
                Op::FpDp1 => simd_fp::dp1(word),
                Op::FpDp2 => simd_fp::dp2(word),
                Op::FpDp3 => simd_fp::dp3(word),
                Op::FpCompare => simd_fp::compare(word),
                Op::FpCondCompare => simd_fp::cond_compare(word),
                Op::FpCondSelect => simd_fp::cond_select(word),
                Op::FpImm => simd_fp::immediate(word),
                Op::FpFixed => simd_fp::fixed(word),
                Op::FpInt => simd_fp::int(word),
                Op::SimdThreeSame => simd::three_same(word),
                Op::SimdThreeDiff => simd::three_different(word),
                Op::SimdTwoMisc => simd::two_misc(word),
                Op::SimdAcross => simd::across(word),
                Op::SimdPairwise => simd::pairwise(word),
                Op::SimdCopy => simd::copy(word),
                Op::SimdModImm => simd::modified_immediate(word),
                Op::SimdShiftImm => simd::shift_immediate(word),
                Op::SimdIndexed => simd::indexed(word),
                Op::SimdTable => simd::table(word),
                Op::SimdPermute => simd::permute(word),
                Op::SimdExtract => simd::extract(word),
                Op::CryptoAes => crypto::aes(word),
                Op::CryptoSha3 => crypto::sha3(word),
                _ => crypto::sha2(word),
            })
        },
    }
}

pub(crate) fn alignment(va: u64, write: bool, _syndrome: Syndrome) -> Exception {
    // (ISV 0, as for every data abort taken to EL1: memory.rs)
    Exception::DataAbort {
        iss: FSC_ALIGNMENT | (write as u32) << 6,
        far: va,
    }
}

/// LDR/STR and their variants (one register)
fn load_store(i: &Inst) -> Result<Flow, Exception> {
    let rt = i.rd as u32;
    let rn = i.rn as u32;
    let size_log = i.cond as u32;
    let size = 1u32 << size_log;
    if i.sub & LS_SIMD != 0 {
        fp::check_access()?;
    }
    let base = xr_sp(rn);
    check_sp(rn, base)?;
    let address = match i.shift {
        MODE_POST => base,
        MODE_REGISTER => base.wrapping_add(extend_reg(xr(i.rm as u32), i.ra, i.amount as u32)),
        _ => base.wrapping_add(i.imm),
    };
    let writeback = i.shift == MODE_PRE || i.shift == MODE_POST;
    let new_base = if i.shift == MODE_POST { base.wrapping_add(i.imm) } else { address };
    if i.sub & LS_PREFETCH != 0 {
        // (PRFM never faults)
        return Ok(Flow::Next);
    }
    if i.sub & LS_SIMD != 0 {
        // a SIMD&FP register: B, H, S, D, Q
        if i.sub & LS_LOAD != 0 {
            let value = simd::read_vector(address, size)?;
            simd::set_vreg(rt, value);
        }
        else {
            let value = simd::vreg(rt);
            simd::prepare_vector_write(address, size)?.commit(value)?;
        }
        if writeback {
            set_x_sp(rn, new_base);
        }
        return Ok(Flow::Next);
    }
    let unprivileged = i.sub & LS_UNPRIVILEGED != 0 && cpu::el() == 1;
    let load = i.sub & LS_LOAD != 0;
    let signed = i.sub & LS_SIGNED != 0;
    let to_w = i.sub & LS_TO_W != 0;
    let syndrome = Syndrome {
        valid: !writeback,
        size_log,
        signed,
        register: rt,
        sixty_four: if load { signed && !to_w || !signed && size_log == 3 } else { size_log == 3 },
        ..Syndrome::NONE
    };
    if load {
        let raw = memory::read(address, size, unprivileged, syndrome)?;
        let value = if signed {
            let extended = match size_log {
                0 => raw as u8 as i8 as i64 as u64,
                1 => raw as u16 as i16 as i64 as u64,
                _ => raw as u32 as i32 as i64 as u64,
            };
            if to_w {
                extended as u32 as u64
            }
            else {
                extended
            }
        }
        else {
            raw
        };
        set_x(rt, value);
    }
    else {
        memory::write(address, size, xr(rt), unprivileged, syndrome)?;
    }
    if writeback {
        set_x_sp(rn, new_base);
    }
    Ok(Flow::Next)
}

/// LDP/STP/LDNP/STNP/LDPSW
fn load_store_pair(i: &Inst) -> Result<Flow, Exception> {
    let rt = i.rd as u32;
    let rt2 = i.ra as u32;
    let rn = i.rn as u32;
    let size_log = i.cond as u32;
    let size = 1u32 << size_log;
    let base = xr_sp(rn);
    check_sp(rn, base)?;
    let address = if i.shift == MODE_POST { base } else { base.wrapping_add(i.imm) };
    let writeback = i.shift == MODE_PRE || i.shift == MODE_POST;
    let new_base = if i.shift == MODE_POST { base.wrapping_add(i.imm) } else { address };
    if i.sub & LS_SIMD != 0 {
        // SIMD&FP pairs: S, D, Q
        let second_address = address.wrapping_add(size as u64);
        if i.sub & LS_LOAD != 0 {
            let first = simd::read_vector(address, size)?;
            let second = simd::read_vector(second_address, size)?;
            simd::set_vreg(rt, first);
            simd::set_vreg(rt2, second);
        }
        else {
            let (first, second) = (simd::vreg(rt), simd::vreg(rt2));
            let a = simd::prepare_vector_write(address, size)?;
            let b = simd::prepare_vector_write(second_address, size)?;
            a.commit(first)?;
            b.commit(second)?;
        }
        if writeback {
            set_x_sp(rn, new_base);
        }
        return Ok(Flow::Next);
    }
    if i.sub & LS_LOAD != 0 {
        let first = memory::read(address, size, false, Syndrome::NONE)?;
        let second = memory::read(
            address.wrapping_add(size as u64),
            size,
            false,
            Syndrome::NONE,
        )?;
        let extend = |value: u64| {
            if i.sub & LS_SIGNED != 0 {
                value as u32 as i32 as i64 as u64
            }
            else {
                value
            }
        };
        set_x(rt, extend(first));
        set_x(rt2, extend(second));
    }
    else {
        let (first, second) = (xr(rt), xr(rt2));
        // (both translated before either is written)
        let a = memory::prepare_write(address, size, false, Syndrome::NONE)?;
        let b = memory::prepare_write(
            address.wrapping_add(size as u64),
            size,
            false,
            Syndrome::NONE,
        )?;
        a.commit(first)?;
        b.commit(second)?;
    }
    if writeback {
        set_x_sp(rn, new_base);
    }
    Ok(Flow::Next)
}

/// The exclusive monitor's granule (P3.3: 64 bytes)
const GRANULE: u64 = !63;

/// A spin on a load-exclusive (P3.9): the PC and value of each core's last
/// one and how often it repeated with no store-exclusive between. A core
/// that keeps reading the same value at the same load waits for another
/// core (a lock without WFE): its turn ends there, as a YIELD's does
static mut SPIN: [(u64, u128, u32); crate::isa::MAX_CORES] = [(0, 0, 0); crate::isa::MAX_CORES];
const SPIN_YIELD: u32 = 4;

/// LDXR/STXR/LDAXR/STLXR/LDXP/STXP/LDAXP/STLXP
fn exclusive(i: &Inst, address: u64) -> Result<Flow, Exception> {
    let rn = i.rn as u32;
    let base = xr_sp(rn);
    check_sp(rn, base)?;
    exclusive_at(i, address, base)
}

/// An exclusive load or store of `i` (the instruction at `address`) at `base`
/// (AArch32's: its offset added)
pub(crate) fn exclusive_at(i: &Inst, address: u64, base: u64) -> Result<Flow, Exception> {
    let rt = i.rd as u32;
    let rt2 = i.ra as u32;
    let rs = i.rm as u32;
    let load = i.sub & 1 != 0;
    let pair = i.sub & 2 != 0;
    let element_log = i.cond as u32;
    let total = (1u32 << element_log) * if pair { 2 } else { 1 };
    if base & (total as u64 - 1) != 0 {
        return Err(alignment(base, !load, Syndrome::NONE));
    }
    if load {
        let (first, second) = if total <= 8 {
            let value = memory::read(base, total, false, Syndrome::NONE)?;
            if pair {
                let half = 32 * (element_log == 2) as u32 + 64 * (element_log == 3) as u32;
                (
                    value & (1u64 << half).wrapping_sub(1),
                    if half == 64 { 0 } else { value >> half },
                )
            }
            else {
                (value, 0)
            }
        }
        else {
            let low = memory::read(base, 8, false, Syndrome::NONE)?;
            let high = memory::read(base + 8, 8, false, Syndrome::NONE)?;
            (low, high)
        };
        let pa = crate::aarch64::mmu::physical_address_of(base).unwrap_or(base);
        unsafe {
            *excl_valid = 1;
            *excl_addr = pa & GRANULE;
            *excl_value = first as u128 | (second as u128) << 64;
        }
        // (guest RAM: the global monitor marks the granule too, P3.7)
        match monitor_key(pa) {
            Some(backing) => crate::aarch64::smp::reserve(backing),
            None => crate::aarch64::smp::release(),
        }
        if i.sub & 4 != 0 {
            crate::parallel::full_fence();
        }
        set_x(rt, first);
        if pair {
            set_x(rt2, second);
        }
        let value = first as u128 | (second as u128) << 64;
        let spin = unsafe { &mut SPIN[crate::isa::current_core()] };
        if spin.0 == address && spin.1 == value {
            spin.2 += 1;
            if spin.2 >= SPIN_YIELD {
                spin.2 = 0;
                return Ok(Flow::Yield);
            }
        }
        else {
            *spin = (address, value, 0);
        }
        return Ok(Flow::Next);
    }
    // a store-exclusive: translated and checked first (it faults even when it would fail)
    let (first, second) = (xr(rt), if pair { xr(rt2) } else { 0 });
    let stores = if total <= 8 {
        let value = if pair {
            if element_log == 2 {
                first & 0xFFFF_FFFF | second << 32
            }
            else {
                first
            }
        }
        else {
            first
        };
        (
            memory::prepare_write(base, total, false, Syndrome::NONE)?,
            None,
            value,
            0,
        )
    }
    else {
        (
            memory::prepare_write(base, 8, false, Syndrome::NONE)?,
            Some(memory::prepare_write(base + 8, 8, false, Syndrome::NONE)?),
            first,
            second,
        )
    };
    let pa = crate::aarch64::mmu::physical_address_of(base).unwrap_or(base);
    // (the local monitor, and for guest RAM the global one: another core's or
    // a device's write to the granule cleared it)
    let success = unsafe { *excl_valid != 0 && *excl_addr == pa & GRANULE }
        && monitor_key(pa).map_or(true, crate::aarch64::smp::reserved);
    let loaded = unsafe { *excl_value };
    unsafe { *excl_valid = 0 };
    crate::aarch64::smp::release();
    unsafe { SPIN[crate::isa::current_core()].0 = 0 };
    if success && crate::parallel::active() {
        // (cores in workers, P8.3: the store commits only if memory still
        // holds what the load-exclusive read, as QEMU does: another core's
        // compiled store does not clear the reservation, and a value written
        // back passes, the deviation docs/aarch64.md declares)
        if i.sub & 4 != 0 {
            crate::parallel::full_fence();
        }
        let (expected, value) = if total <= 8 {
            let low = loaded as u64;
            let high = (loaded >> 64) as u64;
            let expected =
                if pair && element_log == 2 { low & 0xFFFF_FFFF | high << 32 } else { low };
            (expected as u128, stores.2 as u128)
        }
        else {
            (loaded, stores.2 as u128 | (stores.3 as u128) << 64)
        };
        let stored = store_compared(
            pa, total, expected, value, stores.0, stores.1, stores.2, stores.3,
        )?;
        set_w(rs, if stored { 0 } else { 1 });
        return Ok(Flow::Next);
    }
    if success {
        if i.sub & 4 != 0 {
            crate::parallel::full_fence();
        }
        stores.0.commit(stores.2)?;
        if let Some(high) = stores.1 {
            high.commit(stores.3)?;
        }
    }
    set_w(rs, if success { 0 } else { 1 });
    Ok(Flow::Next)
}

/// (cores in workers) a store-exclusive's `total` bytes at `pa`: `value`
/// if they still hold `expected`, whether they did. RAM and device memory
/// compare and exchange atomically; extended RAM under its lock; anything
/// else (ROM, a device) is written as before
#[allow(clippy::too_many_arguments)]
fn store_compared(
    pa: u64,
    total: u32,
    expected: u128,
    value: u128,
    low: memory::Store,
    high: Option<memory::Store>,
    low_value: u64,
    high_value: u64,
) -> Result<bool, Exception> {
    use crate::aarch64::bus::{self, Lookup};
    match bus::bus().lookup(pa) {
        Lookup::Ram {
            backing,
            writable: true,
            ..
        } => {
            let p = unsafe { bus::MEM8.add(backing as usize) };
            let stored = unsafe {
                if total == 16 {
                    crate::parallel::compare_exchange128(p, expected, value)
                }
                else {
                    crate::parallel::compare_exchange(p, total, expected as u64, value as u64)
                }
            };
            if stored {
                bus::written(backing, total);
            }
            Ok(stored)
        },
        Lookup::Extended { .. } => {
            let _guard = unsafe { crate::extended::Guard::new() };
            let current = if total == 16 {
                unsafe {
                    crate::aarch64::extended::read(pa, 8) as u128
                        | (crate::aarch64::extended::read(pa + 8, 8) as u128) << 64
                }
            }
            else {
                unsafe { crate::aarch64::extended::read(pa, total) as u128 }
            };
            if current != expected {
                return Ok(false);
            }
            low.commit(low_value)?;
            if let Some(high) = high {
                high.commit(high_value)?;
            }
            Ok(true)
        },
        _ => {
            low.commit(low_value)?;
            if let Some(high) = high {
                high.commit(high_value)?;
            }
            Ok(true)
        },
    }
}

/// The global monitor's key of physical address `pa`, if it is RAM: the
/// offset in guest memory's backing, or extended RAM's key
fn monitor_key(pa: u64) -> Option<u32> {
    match crate::aarch64::bus::bus().lookup(pa) {
        crate::aarch64::bus::Lookup::Ram { backing, .. } => Some(backing),
        crate::aarch64::bus::Lookup::Extended { .. } => {
            Some(crate::aarch64::extended::monitor_key(pa))
        },
        _ => None,
    }
}

// ---- UNDEF telemetry (P2.3): counts by EL and encoding class, the last ones

/// UNDEF counts: [EL][bits 28:25 of the word]
static mut UNDEF_COUNTS: [[u32; 16]; 2] = [[0; 16]; 2];
/// The last UNDEFs: (PC, word, EL), a ring
static mut UNDEF_LAST: [(u64, u32, u32); 16] = [(0, 0, 0); 16];
static mut UNDEF_NEXT: usize = 0;

#[cold]
fn note_undefined(address: u64) {
    let word = memory::fetch(address).unwrap_or(0);
    let el = cpu::el() as usize & 1;
    unsafe {
        UNDEF_COUNTS[el][(word >> 25 & 15) as usize] += 1;
        UNDEF_LAST[UNDEF_NEXT % 16] = (address, word, el as u32);
        UNDEF_NEXT += 1;
    }
}

/// (diagnostics) UNDEFs at `el` (0 or 1) in encoding class `class` (bits 28:25); class 16: all
#[no_mangle]
pub fn a64_undef_count(el: u32, class: u32) -> u32 {
    let counts = unsafe { &*(&raw const UNDEF_COUNTS) }[el as usize & 1];
    if class >= 16 {
        counts.iter().sum()
    }
    else {
        counts[class as usize]
    }
}
/// (diagnostics) the i-th most recent UNDEF: its PC (low, high), word and EL by `field` 0-3
#[no_mangle]
pub fn a64_undef_last(i: u32, field: u32) -> u32 {
    unsafe {
        if i as usize >= UNDEF_NEXT.min(16) {
            return 0;
        }
        let (pc, word, el) = UNDEF_LAST[(UNDEF_NEXT - 1 - i as usize) % 16];
        match field {
            0 => pc as u32,
            1 => (pc >> 32) as u32,
            2 => word,
            _ => el,
        }
    }
}

// ---- one instruction

/// Fetch the instruction at the PC
#[inline(always)]
fn fetch_at(address: u64) -> Result<u32, Exception> {
    if address & 3 != 0 {
        return Err(Exception::PcAlignment(address));
    }
    memory::fetch(address)
}

/// The stepped instruction was a load-exclusive (ISS.EX of the step exception), per core
static mut STEPPED_EXCLUSIVE_LOADS: [bool; crate::isa::MAX_CORES] = [false; crate::isa::MAX_CORES];
pub(crate) static mut STEPPED_EXCLUSIVE_LOAD: bool = false;

/// (diagnostics, crate::aarch64::jit::pages::a64_step_stat) the class
/// (step_key) and word of the instruction interpret_one ran last
pub static mut LAST_STEPPED: (u32, u32) = (0, 0);
/// An instruction's class for the diagnostics: its Op and the low bits of its sub
#[inline(always)]
pub fn step_key(inst: &Inst) -> u32 { (inst.op as u32) << 4 | inst.sub as u32 & 15 }
static mut STEPPED_CORE: usize = 0;

/// (crate::aarch64::smp) another core runs now
pub fn core_switched() {
    unsafe {
        STEPPED_EXCLUSIVE_LOADS[STEPPED_CORE] = STEPPED_EXCLUSIVE_LOAD;
        STEPPED_CORE = crate::isa::current_core();
        STEPPED_EXCLUSIVE_LOAD = STEPPED_EXCLUSIVE_LOADS[STEPPED_CORE];
    }
}

/// Execute the instruction at the PC (P2.9): it retires, or takes its
/// exception having written no state. What the core does next. Software
/// step (P3.8): in the active-pending state the step exception comes
/// first; an instruction run in the active-not-pending state clears
/// PSTATE.SS when it completes (an exception return sets it from SPSR_EL1,
/// an exception the instruction generated saves it as 0, a fault as 1).
pub fn interpret_one() -> Flow {
    let address = get_pc();
    // (an illegal exception return left PSTATE.IL set: the next instruction takes EC 0x0E)
    if get_pstate() & PSTATE_IL != 0 {
        take_sync(Exception::IllegalState);
        return Flow::Set;
    }
    let stepping = crate::aarch64::debug::stepping();
    if stepping && get_pstate() & PSTATE_SS == 0 {
        take_sync(Exception::SoftwareStep(unsafe { STEPPED_EXCLUSIVE_LOAD }));
        return Flow::Set;
    }
    // (AArch32 at EL0: its own instructions; docs/aarch32-plan.md)
    if cpu::aarch32() {
        let flow = crate::aarch64::a32::interpret_one(address);
        if stepping && !matches!(flow, Flow::Set | Flow::Retry) {
            crate::aarch64::debug::step_done();
        }
        return flow;
    }
    let result = fetch_at(address).and_then(|word| {
        if unsafe { crate::aarch64::debug::ANY_BREAKPOINT } {
            if let Some(exception) = crate::aarch64::debug::check_breakpoint(address) {
                return Err(exception);
            }
        }
        let inst = decode_cached(word);
        if stepping {
            unsafe { STEPPED_EXCLUSIVE_LOAD = inst.op == Op::Exclusive && inst.sub & 1 != 0 };
        }
        unsafe { LAST_STEPPED = (step_key(&inst), word) };
        execute(&inst, address)
    });
    match result {
        Ok(flow) => {
            crate::core_stats::add_pending(1, 0);
            match flow {
                Flow::Next | Flow::Yield => set_pc(address.wrapping_add(4)),
                Flow::Jump(target) => set_pc(target),
                Flow::Wait(_) | Flow::Off => set_pc(address.wrapping_add(4)),
                Flow::Set | Flow::Retry => {},
            }
            // (Flow::Set is an exception return or an exception: PSTATE.SS is already what it must be)
            if stepping && !matches!(flow, Flow::Set | Flow::Retry) {
                crate::aarch64::debug::step_done();
            }
            flow
        },
        Err(exception @ (Exception::Svc(_) | Exception::Hvc(_) | Exception::Smc(_))) => {
            // (the instruction executed: the exception returns after it)
            crate::core_stats::add_pending(1, 0);
            if stepping {
                crate::aarch64::debug::step_done();
            }
            take_sync(exception);
            Flow::Set
        },
        Err(exception) => {
            if let Exception::Undefined = exception {
                note_undefined(address);
            }
            take_sync(exception);
            Flow::Set
        },
    }
}

/// (tests: the instruction count `interpret_one` retires)
#[no_mangle]
pub fn a64_step() -> u32 {
    match interpret_one() {
        Flow::Wait(kind) => kind,
        Flow::Off => 3,
        _ => 0,
    }
}
