//! The AArch64 core's architectural state and exceptions
//! (docs/arm64-virt-android16-plan.md P2, P3): the registers in the state
//! block (crate::aarch64::state), PSTATE, the banked stack pointers, and
//! synchronous exception entry and return at EL1. An instruction that faults
//! has written no state (P2.9): it computes everything, then commits.

use crate::aarch64::state::*;

// PSTATE bits in `pstate` (as SPSR_EL1 lays them out; NZCV is in `nzcv`)
pub const PSTATE_SP: u32 = 1 << 0;
pub const PSTATE_EL_SHIFT: u32 = 2;
pub const PSTATE_F: u32 = 1 << 6;
pub const PSTATE_I: u32 = 1 << 7;
pub const PSTATE_A: u32 = 1 << 8;
pub const PSTATE_D: u32 = 1 << 9;
pub const PSTATE_DAIF: u32 = 0xF << 6;
pub const PSTATE_IL: u32 = 1 << 20;
pub const PSTATE_SS: u32 = 1 << 21;
/// The bits of `pstate` an SPSR keeps (M[4:0] as AArch64 EL0t/EL1t/EL1h, DAIF, IL, SS)
pub const PSTATE_SAVED: u32 = 0x1F | PSTATE_DAIF | PSTATE_IL | PSTATE_SS;

pub const NZCV_N: u32 = 1 << 31;
pub const NZCV_Z: u32 = 1 << 30;
pub const NZCV_C: u32 = 1 << 29;
pub const NZCV_V: u32 = 1 << 28;

// SCTLR_EL1 bits
pub const SCTLR_M: u64 = 1 << 0;
pub const SCTLR_A: u64 = 1 << 1;
pub const SCTLR_C: u64 = 1 << 2;
pub const SCTLR_SA: u64 = 1 << 3;
pub const SCTLR_SA0: u64 = 1 << 4;
pub const SCTLR_UMA: u64 = 1 << 9;
pub const SCTLR_DZE: u64 = 1 << 14;
pub const SCTLR_UCT: u64 = 1 << 15;
pub const SCTLR_NTWI: u64 = 1 << 16;
pub const SCTLR_NTWE: u64 = 1 << 18;
pub const SCTLR_E0E: u64 = 1 << 24;
pub const SCTLR_EE: u64 = 1 << 25;
pub const SCTLR_UCI: u64 = 1 << 26;
/// SCTLR_EL1 at reset: the reference's (QEMU 9.2 cortex-a35: SA, SA0,
/// CP15BEN, EOS, nTWI, nTWE, EIS, SPAN)
pub const SCTLR_RESET: u64 = 0x00C5_0838;

// ---- registers

/// X[n] with register 31 as the zero register
#[inline(always)]
pub fn xr(n: u32) -> u64 {
    if n == 31 {
        0
    }
    else {
        unsafe { *x.add(n as usize) }
    }
}
/// X[n] with register 31 as the current stack pointer
#[inline(always)]
pub fn xr_sp(n: u32) -> u64 { unsafe { *x.add(n as usize) } }
/// W[n] (register 31: the zero register)
#[inline(always)]
pub fn wr(n: u32) -> u32 { xr(n) as u32 }
/// Write X[n] (register 31: discarded)
#[inline(always)]
pub fn set_x(n: u32, value: u64) {
    if n != 31 {
        unsafe { *x.add(n as usize) = value }
    }
}
/// Write X[n] with register 31 as the stack pointer
#[inline(always)]
pub fn set_x_sp(n: u32, value: u64) { unsafe { *x.add(n as usize) = value } }
/// Write W[n], zero-extended to X[n] (register 31: discarded)
#[inline(always)]
pub fn set_w(n: u32, value: u32) { set_x(n, value as u64) }
/// Write the register of a 64-bit (sf) or 32-bit operation: a 32-bit result is zero-extended
#[inline(always)]
pub fn set_xw(n: u32, sf: bool, value: u64) {
    set_x(n, if sf { value } else { value as u32 as u64 })
}
#[inline(always)]
pub fn set_xw_sp(n: u32, sf: bool, value: u64) {
    set_x_sp(n, if sf { value } else { value as u32 as u64 })
}

#[inline(always)]
pub fn get_pc() -> u64 { unsafe { *pc } }
#[inline(always)]
pub fn set_pc(value: u64) { unsafe { *pc = value } }
#[inline(always)]
pub fn get_nzcv() -> u32 { unsafe { *nzcv } }
#[inline(always)]
pub fn set_nzcv(value: u32) { unsafe { *nzcv = value & 0xF000_0000 } }
#[inline(always)]
pub fn get_pstate() -> u32 { unsafe { *pstate } }
/// The current exception level (0 or 1)
#[inline(always)]
pub fn el() -> u32 { get_pstate() >> PSTATE_EL_SHIFT & 3 }
#[inline(always)]
pub fn sctlr() -> u64 { unsafe { *sctlr_el1 } }

/// Which stack pointer is current: 0 SP_EL0, 1 SP_EL1
#[inline(always)]
fn sp_select(pstate_value: u32) -> usize {
    if pstate_value >> PSTATE_EL_SHIFT & 3 != 0 && pstate_value & PSTATE_SP != 0 {
        1
    }
    else {
        0
    }
}

/// Change PSTATE (but NZCV), banking the stack pointer when its selection changes
pub fn set_pstate(value: u32) {
    unsafe {
        let old = sp_select(*pstate);
        let new = sp_select(value);
        if old != new {
            *sp_el.add(old) = *x.add(31);
            *x.add(31) = *sp_el.add(new);
        }
        *pstate = value;
    }
}

/// SP_EL0 or SP_EL1 as a system register (the banked copy, or the current SP)
pub fn get_sp_el(n: usize) -> u64 {
    unsafe {
        if sp_select(*pstate) == n {
            *x.add(31)
        }
        else {
            *sp_el.add(n)
        }
    }
}
pub fn set_sp_el(n: usize, value: u64) {
    unsafe {
        if sp_select(*pstate) == n {
            *x.add(31) = value
        }
        else {
            *sp_el.add(n) = value
        }
    }
}

/// The value of an SPSR for the current PSTATE: NZCV and the saved bits
pub fn current_spsr() -> u64 { (get_nzcv() | get_pstate() & PSTATE_SAVED) as u64 }

// ---- exceptions

/// A synchronous exception the current instruction takes (P3.2)
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Exception {
    /// unallocated, outside the profile, or not permitted here (EC 0x00)
    Undefined,
    /// trapped WFI or WFE (EC 0x01): the trap's TI bit
    Wfx(u32),
    /// FP or SIMD with CPACR_EL1.FPEN trapping (EC 0x07)
    FpAccess,
    /// an illegal exception return's PSTATE.IL (EC 0x0E)
    IllegalState,
    Svc(u16),
    Hvc(u16),
    Smc(u16),
    /// a trapped MSR, MRS or system instruction (EC 0x18): its ISS
    SystemRegister(u32),
    /// an instruction abort (EC 0x20/0x21): fault status code, address
    InstructionAbort {
        fsc: u32,
        far: u64,
    },
    /// a misaligned PC (EC 0x22)
    PcAlignment(u64),
    /// a data abort (EC 0x24/0x25): its ISS and the address
    DataAbort {
        iss: u32,
        far: u64,
    },
    /// a misaligned SP (EC 0x26)
    SpAlignment,
    /// BRK (EC 0x3C)
    Brk(u16),
}

pub const EC_UNKNOWN: u32 = 0x00;
pub const EC_WFX: u32 = 0x01;
pub const EC_FP: u32 = 0x07;
pub const EC_ILLEGAL: u32 = 0x0E;
pub const EC_SVC: u32 = 0x15;
pub const EC_HVC: u32 = 0x16;
pub const EC_SMC: u32 = 0x17;
pub const EC_SYSREG: u32 = 0x18;
pub const EC_IABT_LOWER: u32 = 0x20;
pub const EC_IABT: u32 = 0x21;
pub const EC_PC_ALIGN: u32 = 0x22;
pub const EC_DABT_LOWER: u32 = 0x24;
pub const EC_DABT: u32 = 0x25;
pub const EC_SP_ALIGN: u32 = 0x26;
pub const EC_BRK: u32 = 0x3C;

/// Fault status codes (DFSC/IFSC)
pub const FSC_ADDRESS_SIZE_L0: u32 = 0x00;
pub const FSC_TRANSLATION_L0: u32 = 0x04;
pub const FSC_ACCESS_FLAG_L0: u32 = 0x08;
pub const FSC_PERMISSION_L0: u32 = 0x0C;
pub const FSC_EXTERNAL: u32 = 0x10;
pub const FSC_ALIGNMENT: u32 = 0x21;

const IL: u32 = 1 << 25;

impl Exception {
    /// ESR_EL1, taken from exception level `from`
    pub fn syndrome(self, from: u32) -> u32 {
        let (ec, iss) = match self {
            Exception::Undefined => (EC_UNKNOWN, 0),
            Exception::Wfx(ti) => (EC_WFX, 0x1E0_0000 | ti),
            Exception::FpAccess => (EC_FP, 0x1E0_0000),
            Exception::IllegalState => (EC_ILLEGAL, 0),
            Exception::Svc(imm) => (EC_SVC, imm as u32),
            Exception::Hvc(imm) => (EC_HVC, imm as u32),
            Exception::Smc(imm) => (EC_SMC, imm as u32),
            Exception::SystemRegister(iss) => (EC_SYSREG, iss),
            Exception::InstructionAbort { fsc, .. } => {
                (if from == 0 { EC_IABT_LOWER } else { EC_IABT }, fsc)
            },
            Exception::PcAlignment(_) => (EC_PC_ALIGN, 0),
            Exception::DataAbort { iss, .. } => {
                (if from == 0 { EC_DABT_LOWER } else { EC_DABT }, iss)
            },
            Exception::SpAlignment => (EC_SP_ALIGN, 0),
            Exception::Brk(imm) => (EC_BRK, imm as u32),
        };
        ec << 26 | IL | iss
    }

    /// FAR_EL1, if the exception sets it
    pub fn fault_address(self) -> Option<u64> {
        match self {
            Exception::InstructionAbort { far, .. }
            | Exception::DataAbort { far, .. }
            | Exception::PcAlignment(far) => Some(far),
            _ => None,
        }
    }
}

/// Vector offsets from VBAR_EL1
pub const VECTOR_SYNC: u64 = 0x000;
pub const VECTOR_IRQ: u64 = 0x080;
pub const VECTOR_FIQ: u64 = 0x100;
pub const VECTOR_SERROR: u64 = 0x180;

/// Take an exception to EL1: ELR_EL1 = `return_address`, SPSR_EL1 the
/// PSTATE before, the vector by where it came from (`kind`: VECTOR_*)
pub fn take_exception(kind: u64, return_address: u64, esr: Option<u32>, far: Option<u64>) {
    unsafe {
        let from = el();
        *spsr_el1 = current_spsr();
        *elr_el1 = return_address;
        if let Some(esr) = esr {
            *esr_el1 = esr as u64;
        }
        if let Some(far) = far {
            *far_el1 = far;
        }
        let base = if from == 0 {
            0x400
        }
        else if get_pstate() & PSTATE_SP != 0 {
            0x200
        }
        else {
            0x000
        };
        set_pstate(1 << PSTATE_EL_SHIFT | PSTATE_SP | PSTATE_DAIF);
        set_pc(*vbar_el1 + base + kind);
    }
}

/// The current instruction (at the PC) takes a synchronous exception
pub fn take_sync(exception: Exception) {
    let from = el();
    let return_address = match exception {
        // (the preferred return address of SVC, HVC and SMC is the next instruction)
        Exception::Svc(_) | Exception::Hvc(_) | Exception::Smc(_) => get_pc().wrapping_add(4),
        _ => get_pc(),
    };
    crate::core_stats::note_fault();
    take_exception(
        VECTOR_SYNC,
        return_address,
        Some(exception.syndrome(from)),
        exception.fault_address(),
    );
}

/// ERET: return to ELR_EL1 with SPSR_EL1's PSTATE (an illegal return keeps
/// the EL and sets PSTATE.IL); clears the local monitor, sets the event register
pub fn exception_return() {
    unsafe {
        let spsr = *spsr_el1 as u32;
        let target = *elr_el1;
        let m = spsr & 0x1F;
        // AArch64 EL0t (0b00000), EL1t (0b00100), EL1h (0b00101)
        let legal = m == 0 || m == 0b00100 || m == 0b00101;
        let new = if legal {
            spsr & PSTATE_SAVED
        }
        else {
            get_pstate() & !(PSTATE_IL | PSTATE_SS) | PSTATE_IL | spsr & PSTATE_DAIF
        };
        set_nzcv(spsr & 0xF000_0000);
        set_pstate(new);
        // (an AArch64 return: the PC as written, with TBI not applied here; bits 1:0 stay for a PC alignment fault)
        set_pc(if new >> PSTATE_EL_SHIFT & 3 == 0 && legal { target } else { target });
        *excl_valid = 0;
        *event_register = 1;
    }
}

/// The reset state of a core: EL1h, every interrupt masked, MMU off
pub fn reset_core(entry: u64, context: u64) {
    unsafe {
        for i in 0..32 {
            *x.add(i) = 0;
        }
        for i in 0..2 {
            *sp_el.add(i) = 0;
        }
        *pstate = 1 << PSTATE_EL_SHIFT | PSTATE_SP | PSTATE_DAIF;
        *nzcv = 0;
        *fpcr = 0;
        *fpsr = 0;
        for i in 0..32 {
            *v.add(i) = 0;
        }
        *sctlr_el1 = SCTLR_RESET;
        *cpacr_el1 = 0;
        *vbar_el1 = 0;
        *tcr_el1 = 0;
        *ttbr0_el1 = 0;
        *ttbr1_el1 = 0;
        *mair_el1 = 0;
        *cntkctl_el1 = 0;
        *cntfrq_el0 = crate::aarch64::sysregs::CNTFRQ_RESET;
        *mdscr_el1 = 0;
        *oslsr_el1 = 0b1010; // OSLK set at reset, OSLM = 0b10 (OS Lock implemented)
        *excl_valid = 0;
        *waiting = 0;
        *event_register = 0;
        *x = context;
        *pc = entry;
    }
}
