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
/// Privileged Access Never (FEAT_PAN, profile v2): EL1's data accesses to
/// memory EL0 may access fault, but the unprivileged ones (LDTR, STTR)
pub const PSTATE_PAN: u32 = 1 << 22;
/// The bits of `pstate` an SPSR keeps (M[4:0] as AArch64 EL0t/EL1t/EL1h, DAIF, IL, SS, PAN)
pub const PSTATE_SAVED: u32 = 0x1F | PSTATE_DAIF | PSTATE_IL | PSTATE_SS | PSTATE_PAN;

// AArch32 at EL0 (profile v3, docs/aarch32-plan.md): `pstate` as an
// AArch32 SPSR lays it out, M[4:0] the User mode (0b10000: M[4] is nRW)
pub const PSTATE_NRW: u32 = 1 << 4;
pub const PSTATE_T: u32 = 1 << 5;
/// AArch32's endianness bit (where AArch64 has D)
pub const PSTATE_E: u32 = 1 << 9;
/// ITSTATE: IT[7:2] in bits 15:10, IT[1:0] in bits 26:25
pub const PSTATE_IT: u32 = 0x3F << 10 | 3 << 25;
pub const PSTATE_GE: u32 = 0xF << 16;
pub const PSTATE_Q: u32 = 1 << 27;
/// AArch32 User mode (M[4:0])
pub const MODE_USER: u32 = 0b10000;
/// The bits of an AArch32 `pstate` an SPSR keeps
pub const PSTATE_SAVED_A32: u32 = 0x1F
    | PSTATE_T
    | PSTATE_E
    | PSTATE_A
    | PSTATE_I
    | PSTATE_F
    | PSTATE_IT
    | PSTATE_GE
    | PSTATE_Q
    | PSTATE_IL
    | PSTATE_SS
    | PSTATE_PAN;

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
/// Set Privileged Access Never: when clear, an exception taken to EL1 sets PSTATE.PAN (FEAT_PAN)
pub const SCTLR_SPAN: u64 = 1 << 23;
/// SCTLR_EL1 at reset: the reference's (QEMU 9.2 cortex-a35: SA, SA0,
/// CP15BEN, EOS, nTWI, nTWE, EIS, SPAN)
pub const SCTLR_RESET: u64 = 0x00C5_0838;

// ---- the profile's optional features (a64_set_features)

/// FEAT_PAN (profile v2)
pub const FEATURE_PAN: u32 = 1 << 0;
/// AArch32 at EL0 (profile v3)
pub const FEATURE_AARCH32: u32 = 1 << 1;
/// AArch32 throughout, PL0 and PL1 (cpu_type "arm32", profile arm32-v1:
/// crate::aarch64::a32_system)
pub const FEATURE_A32: u32 = 1 << 2;
static mut FEATURES: u32 = 0;

/// The optional features of the machine's profile: FEATURE_PAN (v2),
/// FEATURE_AARCH32 (v3), FEATURE_A32 (arm32-v1); none in v1 and v1.1
#[no_mangle]
pub fn a64_set_features(mask: u32) {
    unsafe {
        *crate::parallel::machine(&raw mut FEATURES) =
            mask & (FEATURE_PAN | FEATURE_AARCH32 | FEATURE_A32)
    };
    crate::aarch64::tlb::flush(true);
}

/// Whether the profile has FEAT_PAN
#[inline(always)]
pub fn has_pan() -> bool {
    unsafe { *crate::parallel::machine(&raw mut FEATURES) & FEATURE_PAN != 0 }
}

/// Whether the profile has AArch32 at EL0
#[inline(always)]
pub fn has_aarch32() -> bool {
    unsafe { *crate::parallel::machine(&raw mut FEATURES) & FEATURE_AARCH32 != 0 }
}

/// Whether the CPU is AArch32 throughout (cpu_type "arm32")
#[inline(always)]
pub fn a32_only() -> bool {
    unsafe { *crate::parallel::machine(&raw mut FEATURES) & FEATURE_A32 != 0 }
}

/// Whether the core runs AArch32 (EL0's A32 or T32; with a32_only any mode)
#[inline(always)]
pub fn aarch32() -> bool { get_pstate() & PSTATE_NRW != 0 }

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
/// The current exception level (0 or 1; AArch32's User mode PL0, its other modes PL1)
#[inline(always)]
pub fn el() -> u32 {
    let p = get_pstate();
    if p & PSTATE_NRW != 0 {
        (p & 0xF != 0) as u32
    }
    else {
        p >> PSTATE_EL_SHIFT & 3
    }
}
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

/// Change PSTATE (but NZCV), banking the stack pointer when its selection
/// changes (AArch32's modes: their banked registers)
pub fn set_pstate(value: u32) {
    unsafe {
        if value & *pstate & PSTATE_NRW != 0 {
            crate::aarch64::a32_system::switch_registers(*pstate & 0x1F, value & 0x1F);
            *pstate = value;
            return;
        }
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
/// (AArch32's: T, ITSTATE, GE, Q, E as well)
pub fn current_spsr() -> u64 {
    let saved = if aarch32() { PSTATE_SAVED_A32 } else { PSTATE_SAVED };
    (get_nzcv() | get_pstate() & saved) as u64
}

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
    /// a hardware breakpoint (EC 0x30/0x31; FAR 0)
    Breakpoint,
    /// a watchpoint (EC 0x34/0x35): whether the access writes, the first watched byte
    Watchpoint {
        write: bool,
        far: u64,
    },
    /// software step (EC 0x32/0x33): whether the stepped instruction was a load-exclusive
    SoftwareStep(bool),
    /// an AArch32 instruction's trap with its own syndrome (MCR/MRC and
    /// MCRR/MRRC of CP15 and CP14 0x03-0x06/0x0C, WFx 0x01, FP 0x07, BKPT 0x38): EC, ISS
    Trapped32 {
        ec: u32,
        iss: u32,
    },
}

pub const EC_UNKNOWN: u32 = 0x00;
pub const EC_WFX: u32 = 0x01;
pub const EC_FP: u32 = 0x07;
pub const EC_ILLEGAL: u32 = 0x0E;
/// SVC from AArch32
pub const EC_SVC32: u32 = 0x11;
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
pub const EC_BREAKPOINT_LOWER: u32 = 0x30;
pub const EC_STEP_LOWER: u32 = 0x32;
pub const EC_WATCHPOINT_LOWER: u32 = 0x34;
/// The fault status of a debug exception
const FSC_DEBUG: u32 = 0x22;

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
        let a32 = aarch32();
        let (ec, iss) = match self {
            Exception::Undefined => (EC_UNKNOWN, 0),
            Exception::Wfx(ti) => (EC_WFX, 0x1E0_0000 | ti),
            Exception::FpAccess => (EC_FP, 0x1E0_0000),
            Exception::IllegalState => (EC_ILLEGAL, 0),
            Exception::Svc(imm) => (if a32 { EC_SVC32 } else { EC_SVC }, imm as u32),
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
            // (the same-EL classes are one more than the lower-EL ones)
            Exception::Breakpoint => (EC_BREAKPOINT_LOWER + (from != 0) as u32, FSC_DEBUG),
            Exception::Watchpoint { write, .. } => (
                EC_WATCHPOINT_LOWER + (from != 0) as u32,
                FSC_DEBUG | (write as u32) << 6,
            ),
            Exception::SoftwareStep(ex) => (
                EC_STEP_LOWER + (from != 0) as u32,
                1 << 24 | (ex as u32) << 6 | FSC_DEBUG,
            ),
            Exception::Trapped32 { ec, iss } => (ec, iss),
        };
        // (IL: the instruction's length, 0 for a 16-bit T32 one; 1 where
        // there is no instruction to speak of: unknown, aborts on fetch, PC
        // alignment, illegal state, the debug exceptions)
        let il = if a32
            && crate::aarch64::a32::instruction_length() == 2
            && !matches!(
                self,
                Exception::Undefined
                    | Exception::InstructionAbort { .. }
                    | Exception::PcAlignment(_)
                    | Exception::IllegalState
                    | Exception::Breakpoint
                    | Exception::Watchpoint { .. }
                    | Exception::SoftwareStep(_)
            ) {
            0
        }
        else {
            IL
        };
        ec << 26 | il | iss
    }

    /// FAR_EL1, if the exception sets it
    pub fn fault_address(self) -> Option<u64> {
        match self {
            Exception::InstructionAbort { far, .. }
            | Exception::DataAbort { far, .. }
            | Exception::PcAlignment(far)
            | Exception::Watchpoint { far, .. } => Some(far),
            // (FAR is UNKNOWN for a breakpoint: 0, as the reference writes it)
            Exception::Breakpoint => Some(0),
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
    if a32_only() {
        // (an interrupt: AArch32's IRQ or FIQ)
        return crate::aarch64::a32_system::take_interrupt(kind == VECTOR_FIQ);
    }
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
        // (from EL0: AArch64's vectors at 0x400, AArch32's at 0x600)
        let base = if from == 0 {
            if aarch32() {
                0x600
            }
            else {
                0x400
            }
        }
        else if get_pstate() & PSTATE_SP != 0 {
            0x200
        }
        else {
            0x000
        };
        // (PAN: set with SCTLR_EL1.SPAN clear, else kept)
        let pan = if has_pan() && *sctlr_el1 & SCTLR_SPAN == 0 {
            PSTATE_PAN
        }
        else {
            get_pstate() & PSTATE_PAN
        };
        set_pstate(1 << PSTATE_EL_SHIFT | PSTATE_SP | PSTATE_DAIF | pan);
        set_pc(*vbar_el1 + base + kind);
    }
}

/// The current instruction (at the PC) takes a synchronous exception
pub fn take_sync(exception: Exception) {
    if a32_only() {
        crate::core_stats::note_fault();
        return crate::aarch64::a32_system::take_sync(exception);
    }
    let from = el();
    let return_address = match exception {
        // (the preferred return address of SVC, HVC and SMC is the next
        // instruction: in T32 maybe 2 bytes on)
        Exception::Svc(_) | Exception::Hvc(_) | Exception::Smc(_) => {
            get_pc().wrapping_add(if aarch32() {
                crate::aarch64::a32::instruction_length() as u64
            }
            else {
                4
            })
        },
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
        // AArch64 EL0t (0b00000), EL1t (0b00100), EL1h (0b00101); AArch32
        // User (0b10000) with profile v3 (no AArch32 at EL1)
        let a32 = m == MODE_USER && has_aarch32();
        let legal = m == 0 || m == 0b00100 || m == 0b00101 || a32;
        let new = if a32 {
            spsr & PSTATE_SAVED_A32
        }
        else if legal {
            spsr & PSTATE_SAVED
        }
        else {
            // (NZCV, DAIF and PAN still come from SPSR_EL1)
            get_pstate() & !(PSTATE_IL | PSTATE_SS | PSTATE_DAIF | PSTATE_PAN)
                | PSTATE_IL
                | spsr & (PSTATE_DAIF | PSTATE_PAN)
        };
        set_nzcv(spsr & 0xF000_0000);
        set_pstate(new);
        if a32 {
            // (to AArch32: the PC's 32 bits, aligned for its instruction set)
            set_pc((target as u32 & if spsr & PSTATE_T != 0 { !1 } else { !3 }) as u64);
        }
        else {
            // (an AArch64 return: the PC as written, with TBI not applied here; bits 1:0 stay for a PC alignment fault)
            set_pc(target);
        }
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
    if a32_only() {
        crate::aarch64::a32_system::reset(entry, context);
    }
}
