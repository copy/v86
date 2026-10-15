//! The generic timer of the AArch64 core (P3.6): one system counter for the
//! machine at CNTFRQ's 1 GHz, the EL1 virtual and physical timers of each
//! core, and their registers; CNTVOFF is 0 (no EL2).

use crate::aarch64::cpu::{self, Exception};
use crate::aarch64::state::*;
use crate::aarch64::sysregs::key;

/// The system counter: nanoseconds of the machine's clock
pub fn counter() -> u64 {
    let now = unsafe { crate::isa::microtick() };
    (now * 1_000_000.0) as u64
}

const CTL_ENABLE: u64 = 1;
const CTL_IMASK: u64 = 2;
const CTL_ISTATUS: u64 = 4;

/// CNTx_CTL with ISTATUS: whether the timer's condition is met
fn ctl(control: u64, compare: u64) -> u64 {
    let status = control & CTL_ENABLE != 0 && counter() >= compare;
    control & (CTL_ENABLE | CTL_IMASK) | if status { CTL_ISTATUS } else { 0 }
}

fn trap(reg: u32, rt: u32, read: bool) -> Exception {
    let op0 = reg >> 14 & 3;
    let op1 = reg >> 11 & 7;
    let crn = reg >> 7 & 15;
    let crm = reg >> 3 & 15;
    let op2 = reg & 7;
    Exception::SystemRegister(
        op0 << 20 | op2 << 17 | op1 << 14 | crn << 10 | rt << 5 | crm << 1 | read as u32,
    )
}

/// Whether EL0 may access the register (CNTKCTL_EL1)
fn el0_allowed(reg: u32) -> bool {
    let kctl = unsafe { *cntkctl_el1 };
    let pcten = kctl & 1 != 0;
    let vcten = kctl & 2 != 0;
    match reg {
        r if r == key(3, 3, 14, 0, 0) => pcten || vcten,
        r if r == key(3, 3, 14, 0, 1) => pcten,
        r if r == key(3, 3, 14, 0, 2) => vcten,
        r if r >> 3 == key(3, 3, 14, 2, 0) >> 3 => kctl & 1 << 9 != 0,
        r if r >> 3 == key(3, 3, 14, 3, 0) >> 3 => kctl & 1 << 8 != 0,
        _ => false,
    }
}

pub fn read(reg: u32, rt: u32) -> Result<u64, Exception> {
    if cpu::el() == 0 && !el0_allowed(reg) {
        return Err(trap(reg, rt, true));
    }
    unsafe {
        Ok(match reg {
            r if r == key(3, 3, 14, 0, 0) => *cntfrq_el0,
            r if r == key(3, 3, 14, 0, 1) || r == key(3, 3, 14, 0, 2) => counter(),
            r if r == key(3, 3, 14, 2, 0) => {
                (*cntp_cval).wrapping_sub(counter()) as u32 as i32 as u64 & 0xFFFF_FFFF
            },
            r if r == key(3, 3, 14, 2, 1) => ctl(*cntp_ctl, *cntp_cval),
            r if r == key(3, 3, 14, 2, 2) => *cntp_cval,
            r if r == key(3, 3, 14, 3, 0) => {
                (*cntv_cval).wrapping_sub(counter()) as u32 as i32 as u64 & 0xFFFF_FFFF
            },
            r if r == key(3, 3, 14, 3, 1) => ctl(*cntv_ctl, *cntv_cval),
            r if r == key(3, 3, 14, 3, 2) => *cntv_cval,
            _ => return Err(Exception::Undefined),
        })
    }
}

pub fn write(reg: u32, rt: u32, value: u64) -> Result<(), Exception> {
    let el = cpu::el();
    if el == 0 && !el0_allowed(reg) {
        return Err(trap(reg, rt, false));
    }
    unsafe {
        match reg {
            // (CNTFRQ_EL0: writable at EL1, the highest EL here)
            r if r == key(3, 3, 14, 0, 0) => {
                if el == 0 {
                    return Err(Exception::Undefined);
                }
                *cntfrq_el0 = value & 0xFFFF_FFFF
            },
            r if r == key(3, 3, 14, 0, 1) || r == key(3, 3, 14, 0, 2) => {
                return Err(Exception::Undefined)
            },
            r if r == key(3, 3, 14, 2, 0) => {
                *cntp_cval = counter().wrapping_add(value as u32 as i32 as i64 as u64)
            },
            r if r == key(3, 3, 14, 2, 1) => *cntp_ctl = value & (CTL_ENABLE | CTL_IMASK),
            r if r == key(3, 3, 14, 2, 2) => *cntp_cval = value,
            r if r == key(3, 3, 14, 3, 0) => {
                *cntv_cval = counter().wrapping_add(value as u32 as i32 as i64 as u64)
            },
            r if r == key(3, 3, 14, 3, 1) => *cntv_ctl = value & (CTL_ENABLE | CTL_IMASK),
            r if r == key(3, 3, 14, 3, 2) => *cntv_cval = value,
            _ => return Err(Exception::Undefined),
        }
    }
    Ok(())
}
