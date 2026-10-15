//! The GICv3 of the virt machine (P3.5): the distributor, redistributors and
//! each core's CPU interface (ICC_* system registers). Until then no
//! interrupt is pending and the CPU interface registers are UNDEF.

use crate::aarch64::cpu::Exception;

/// ISR_EL1: the pending IRQ (bit 7), FIQ (6) and SError (8)
pub fn isr_el1() -> u64 { 0 }

/// Whether `reg` is an ICC_* register (op0 3, op1 0, CRn 12 with CRm 8, 9,
/// 11 or 12, or ICC_PMR_EL1)
pub fn is_icc(reg: u32) -> bool {
    let op0 = reg >> 14;
    let op1 = reg >> 11 & 7;
    let crn = reg >> 7 & 15;
    let crm = reg >> 3 & 15;
    let op2 = reg & 7;
    op0 == 3
        && op1 == 0
        && (crn == 12 && matches!(crm, 8 | 9 | 11 | 12) || crn == 4 && crm == 6 && op2 == 0)
}

pub fn icc_read(_reg: u32) -> Result<u64, Exception> { Err(Exception::Undefined) }
pub fn icc_write(_reg: u32, _value: u64) -> Result<(), Exception> { Err(Exception::Undefined) }
