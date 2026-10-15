//! The stage 1 MMU of the AArch64 core (P3.4): VMSAv8-64 translation of the
//! EL1&0 regime with the 4 KiB granule, the TLB, AT and TLBI. Until then a
//! translation with SCTLR_EL1.M set faults (level 0 translation fault).

use crate::aarch64::cpu::{Exception, FSC_TRANSLATION_L0};
use crate::aarch64::memory::{Access, Syndrome};

pub fn translate(
    va: u64,
    access: Access,
    _unprivileged: bool,
    syndrome: Syndrome,
) -> Result<u64, Exception> {
    match access {
        Access::Fetch => Err(Exception::InstructionAbort {
            fsc: FSC_TRANSLATION_L0,
            far: va,
        }),
        _ => {
            let _ = syndrome;
            Err(Exception::DataAbort {
                iss: FSC_TRANSLATION_L0 | ((access == Access::Write) as u32) << 6,
                far: va,
            })
        },
    }
}

/// SCTLR_EL1, TCR_EL1, TTBRn_EL1 or MAIR_EL1 changed
pub fn regime_changed() {}

/// A data or instruction cache maintenance by VA: the translation (as a
/// read) may fault; nothing else happens
pub fn check_cache_maintenance(_va: u64) -> Result<(), Exception> { Ok(()) }

/// AT S1E1R (0), S1E1W (1), S1E0R (2), S1E0W (3): PAR_EL1
pub fn address_translate(_op2: u32, _va: u64) {}

/// TLBI: broadcast to the inner shareable domain (`shareable`), op2 the kind
pub fn tlbi(_shareable: bool, _op2: u32, _value: u64) {}

/// AArch64.BranchAddr: a branch target with TBI (TCR_EL1.TBI0/TBI1 for the
/// half bit 55 selects): bits 63:56 become copies of bit 55
#[inline(always)]
pub fn branch_address(target: u64) -> u64 {
    let tcr = unsafe { *crate::aarch64::state::tcr_el1 };
    let tbi = if target >> 55 & 1 == 0 { tcr >> 37 & 1 } else { tcr >> 38 & 1 };
    if tbi == 0 {
        target
    }
    else {
        ((target << 8) as i64 >> 8) as u64
    }
}

/// The physical address `va` translates to now, if it does (the exclusive
/// monitor's address)
pub fn physical_address_of(va: u64) -> Option<u64> {
    if crate::aarch64::cpu::sctlr() & crate::aarch64::cpu::SCTLR_M == 0 {
        Some(va)
    }
    else {
        translate(va, Access::Read, false, Syndrome::NONE).ok()
    }
}
