//! Floating point of the AArch64 core (P2.6: the ARM-specialised SoftFloat;
//! here, FPCR and the FP/SIMD access trap)

use crate::aarch64::cpu::{self, Exception};
use crate::aarch64::state::*;

/// FPCR's bits that take effect: AHP, DN, FZ, RMode (the trap enables are
/// RAZ/WI, FZ16 is not in v1)
pub const FPCR_WRITABLE: u32 = 0x07C0_0000;

pub fn fpcr_read() -> u64 { unsafe { *fpcr as u64 } }
pub fn fpcr_write(value: u64) { unsafe { *fpcr = value as u32 & FPCR_WRITABLE } }

/// CPACR_EL1.FPEN: whether FP and AdvSIMD instructions trap at this EL
#[inline]
pub fn check_access() -> Result<(), Exception> {
    let fpen = unsafe { *cpacr_el1 } >> 20 & 3;
    let allowed = match fpen {
        0b01 => cpu::el() == 1,
        0b11 => true,
        _ => false,
    };
    if allowed {
        Ok(())
    }
    else {
        Err(Exception::FpAccess)
    }
}
