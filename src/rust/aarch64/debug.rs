//! The debug registers of profile v1 (P3.8): 2 breakpoints (1 context
//! aware), 2 watchpoints, the OS Lock and OS Double Lock, MDSCR_EL1. No
//! external debugger, no debug communications channel.

use crate::aarch64::cpu::Exception;
use crate::aarch64::state::*;
use crate::aarch64::sysregs::key;

pub fn read(reg: u32, _rt: u32) -> Result<u64, Exception> {
    let crn = reg >> 7 & 15;
    let crm = reg >> 3 & 15;
    let op1 = reg >> 11 & 7;
    let op2 = reg & 7;
    unsafe {
        Ok(match (op1, crn, crm, op2) {
            (0, 0, n, 4) if n < 2 => *dbgbvr.add(n as usize),
            (0, 0, n, 5) if n < 2 => *dbgbcr.add(n as usize),
            (0, 0, n, 6) if n < 2 => *dbgwvr.add(n as usize),
            (0, 0, n, 7) if n < 2 => *dbgwcr.add(n as usize),
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
            (0, 0, n, 4) if n < 2 => *dbgbvr.add(n as usize) = value,
            (0, 0, n, 5) if n < 2 => *dbgbcr.add(n as usize) = value & 0x00FF_E1E7,
            (0, 0, n, 6) if n < 2 => *dbgwvr.add(n as usize) = value & !3,
            (0, 0, n, 7) if n < 2 => *dbgwcr.add(n as usize) = value & 0x1F1F_FFFF,
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
