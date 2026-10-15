//! Self-hosted debug of profile v1 (docs/arm64-virt-android16-plan.md P3.8):
//! 2 breakpoints (the second context-aware: CONTEXTIDR_EL1 matches, and the
//! target of linked address matches), 2 watchpoints, software step, the OS
//! Lock and OS Double Lock, MDSCR_EL1. No external debug, no Halting, no
//! debug communications channel. The registers keep what is written (BAS[3]
//! and BAS[1] of a breakpoint copy BAS[2] and BAS[0]), as the reference's
//! do. Where the Arm ARM leaves a choice this follows QEMU 9.2
//! (target/arm/debug_helper.c): a breakpoint fires when its address is the
//! instruction's; BAS with MASK set is ignored, reserved MASK or LSC values
//! disable a watchpoint, only the first run of BAS ones counts; FAR is 0
//! for a breakpoint and the first watched byte for a watchpoint. Unlike the
//! reference, OSLSR_EL1.OSLK (set at reset) blocks debug exceptions, as the
//! architecture says, and unlinked context ID breakpoints fire.

use crate::aarch64::cpu::{self, Exception, PSTATE_D, PSTATE_SS};
use crate::aarch64::state::{
    contextidr_el1, dbgbcr, dbgbvr, dbgwcr, dbgwvr, mdccint_el1, mdscr_el1, osdlr_el1, oslsr_el1,
};
use crate::aarch64::sysregs::key;

const BREAKPOINTS: usize = 2;
const WATCHPOINTS: usize = 2;
/// The context-aware breakpoint (the last one)
const CONTEXT_BREAKPOINT: usize = 1;

const MDSCR_SS: u64 = 1 << 0;
const MDSCR_KDE: u64 = 1 << 13;
const MDSCR_MDE: u64 = 1 << 15;

/// Whether any breakpoint or watchpoint is enabled (the fast paths check this first)
pub static mut ANY_BREAKPOINT: bool = false;
pub static mut ANY_WATCHPOINT: bool = false;

pub fn refresh() {
    unsafe {
        ANY_BREAKPOINT = (0..BREAKPOINTS).any(|n| *dbgbcr.add(n) & 1 != 0);
        ANY_WATCHPOINT = (0..WATCHPOINTS).any(|n| *dbgwcr.add(n) & 1 != 0);
    }
}

/// AArch64.GenerateDebugExceptions: whether debug exceptions are enabled at
/// the current EL (their target is EL1)
pub fn enabled() -> bool {
    unsafe {
        // (the OS Lock, or the OS Double Lock with no powerdown request)
        if *oslsr_el1 & 2 != 0 || *osdlr_el1 & 1 != 0 {
            return false;
        }
        if cpu::el() == 1 {
            *mdscr_el1 & MDSCR_KDE != 0 && cpu::get_pstate() & PSTATE_D == 0
        }
        else {
            true
        }
    }
}

/// Whether software step is active (MDSCR_EL1.SS with debug exceptions enabled)
#[inline(always)]
pub fn stepping() -> bool { (unsafe { *mdscr_el1 } & MDSCR_SS != 0) && enabled() }

/// PMC (and HMC, SSC: no EL2 or EL3 here) of a control register match the access's EL
fn el_matches(control: u64, el: u32) -> bool {
    let pmc = control >> 1 & 3;
    if el == 0 {
        pmc & 2 != 0
    }
    else {
        pmc & 1 != 0
    }
}

/// Whether the context breakpoint `n` matches now (linked or not)
fn context_matches(n: usize) -> bool {
    if n != CONTEXT_BREAKPOINT {
        return false;
    }
    unsafe { *dbgbcr.add(n) & 1 != 0 && *contextidr_el1 as u32 == *dbgbvr.add(n) as u32 }
}

/// The breakpoint debug exception the instruction at `pc` takes before it runs, if any
pub fn check_breakpoint(address: u64) -> Option<Exception> {
    unsafe {
        if *mdscr_el1 & MDSCR_MDE == 0 || !enabled() {
            return None;
        }
        let el = cpu::el();
        for n in 0..BREAKPOINTS {
            let control = *dbgbcr.add(n);
            if control & 1 == 0 || !el_matches(control, el) {
                continue;
            }
            let value = *dbgbvr.add(n);
            let bas = control >> 5 & 15;
            let hit = match control >> 20 & 15 {
                // address match (unlinked, or linked to a context breakpoint)
                bt @ (0 | 1) => {
                    let target = (value & !3) + if bas == 0xC { 2 } else { 0 };
                    bas != 0
                        && target == address
                        && (bt == 0 || context_matches((control >> 16 & 15) as usize))
                },
                // unlinked context ID match
                2 => context_matches(n),
                _ => false,
            };
            if hit {
                return Some(Exception::Breakpoint);
            }
        }
        None
    }
}

/// The watchpoint debug exception an access of `size` bytes at `va` takes
/// (`el0`: an unprivileged or EL0 access), if any; it takes it before the access
pub fn check_watchpoint(va: u64, size: u32, write: bool, el0: bool) -> Option<Exception> {
    unsafe {
        if *mdscr_el1 & MDSCR_MDE == 0 || !enabled() {
            return None;
        }
        for n in 0..WATCHPOINTS {
            let control = *dbgwcr.add(n);
            if control & 1 == 0 || !el_matches(control, if el0 { 0 } else { 1 }) {
                continue;
            }
            let lsc = control >> 3 & 3;
            if lsc == 0 || write && lsc & 2 == 0 || !write && lsc & 1 == 0 {
                continue;
            }
            let mut start = *dbgwvr.add(n);
            let length;
            let mask = control >> 24 & 31;
            if mask == 1 || mask == 2 {
                continue;
            }
            if mask != 0 {
                length = 1u64 << mask;
                start &= !(length - 1);
            }
            else {
                let mut bas = control >> 5 & 0xFF;
                if start >> 2 & 1 != 0 {
                    bas &= 0xF;
                }
                if bas == 0 {
                    continue;
                }
                let first = bas.trailing_zeros() as u64;
                length = (bas >> first).trailing_ones() as u64;
                start = (start & !7) + first;
            }
            if control >> 20 & 1 != 0 && !context_matches((control >> 16 & 15) as usize) {
                continue;
            }
            let end = va.wrapping_add(size as u64);
            if va < start.wrapping_add(length) && end > start {
                return Some(Exception::Watchpoint {
                    write,
                    far: va.max(start),
                });
            }
        }
        None
    }
}

/// Software step: whether the next instruction is stepped over (active-pending:
/// the step exception comes first)
#[inline(always)]
pub fn step_pending() -> bool { stepping() && cpu::get_pstate() & PSTATE_SS == 0 }

/// After an instruction ran in the active-not-pending state: PSTATE.SS goes to 0
#[inline(always)]
pub fn step_done() { cpu::set_pstate(cpu::get_pstate() & !PSTATE_SS) }

pub fn read(reg: u32, _rt: u32) -> Result<u64, Exception> {
    let crn = reg >> 7 & 15;
    let crm = reg >> 3 & 15;
    let op1 = reg >> 11 & 7;
    let op2 = reg & 7;
    unsafe {
        Ok(match (op1, crn, crm, op2) {
            (0, 0, n, 4) if (n as usize) < BREAKPOINTS => *dbgbvr.add(n as usize),
            (0, 0, n, 5) if (n as usize) < BREAKPOINTS => *dbgbcr.add(n as usize),
            (0, 0, n, 6) if (n as usize) < WATCHPOINTS => *dbgwvr.add(n as usize),
            (0, 0, n, 7) if (n as usize) < WATCHPOINTS => *dbgwcr.add(n as usize),
            _ => match reg {
                r if r == key(2, 0, 0, 2, 2) => *mdscr_el1,
                r if r == key(2, 0, 0, 2, 0) => *mdccint_el1,
                r if r == key(2, 0, 1, 1, 4) => *oslsr_el1,
                r if r == key(2, 0, 1, 3, 4) => *osdlr_el1,
                r if r == key(2, 0, 1, 0, 0) => 0, // MDRAR_EL1: no memory-mapped debug
                r if r == key(2, 0, 1, 4, 4) => 0, // DBGPRCR_EL1
                r if r == key(2, 0, 7, 8, 6) || r == key(2, 0, 7, 9, 6) => 0, // DBGCLAIMSET/CLR
                r if r == key(2, 0, 7, 14, 6) => 0xAA, // DBGAUTHSTATUS_EL1: non-secure debug enabled
                r if r == key(2, 0, 0, 6, 2) => 0,     // OSECCR_EL1
                _ => return Err(Exception::Undefined),
            },
        })
    }
}

pub fn write(reg: u32, _rt: u32, value: u64) -> Result<(), Exception> {
    let crn = reg >> 7 & 15;
    let crm = reg >> 3 & 15;
    let op1 = reg >> 11 & 7;
    let op2 = reg & 7;
    unsafe {
        match (op1, crn, crm, op2) {
            (0, 0, n, 4) if (n as usize) < BREAKPOINTS => *dbgbvr.add(n as usize) = value,
            (0, 0, n, 5) if (n as usize) < BREAKPOINTS => {
                // (BAS[3] reads as BAS[2], BAS[1] as BAS[0])
                let bas2 = value >> 7 & 1;
                let bas0 = value >> 5 & 1;
                *dbgbcr.add(n as usize) = value & !(1 << 8 | 1 << 6) | bas2 << 8 | bas0 << 6;
                refresh();
            },
            (0, 0, n, 6) if (n as usize) < WATCHPOINTS => *dbgwvr.add(n as usize) = value,
            (0, 0, n, 7) if (n as usize) < WATCHPOINTS => {
                *dbgwcr.add(n as usize) = value;
                refresh();
            },
            _ => match reg {
                r if r == key(2, 0, 0, 2, 2) => *mdscr_el1 = value & 0xE000_E03F | value & 0x2_0000,
                r if r == key(2, 0, 0, 2, 0) => *mdccint_el1 = value & 1 << 29,
                r if r == key(2, 0, 1, 0, 4) => {
                    // OSLAR_EL1: the OS Lock (OSLSR_EL1.OSLK, bit 1)
                    *oslsr_el1 = *oslsr_el1 & !2 | (value & 1) << 1
                },
                r if r == key(2, 0, 1, 3, 4) => *osdlr_el1 = value & 1,
                r if r == key(2, 0, 1, 4, 4) => {},
                r if r == key(2, 0, 7, 8, 6) || r == key(2, 0, 7, 9, 6) => {},
                r if r == key(2, 0, 0, 6, 2) => {},
                _ => return Err(Exception::Undefined),
            },
        }
    }
    Ok(())
}

/// Reset: everything disabled, the OS Lock set
pub fn reset() {
    unsafe {
        for n in 0..BREAKPOINTS {
            *dbgbvr.add(n) = 0;
            *dbgbcr.add(n) = 0;
        }
        for n in 0..WATCHPOINTS {
            *dbgwvr.add(n) = 0;
            *dbgwcr.add(n) = 0;
        }
    }
    refresh();
}
