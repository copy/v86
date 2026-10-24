//! AArch32 at PL1 (cpu_type "arm32", docs/aarch32-plan.md R2): the CPU is
//! AArch32 throughout (cpu::a32_only). The modes and their banked
//! registers (X0-X14 hold the current mode's R0-R14; the others' R13 and
//! R14, and R8-R12 of FIQ or of the rest, wait in the state block's a32
//! fields), CPSR (NZCV in `nzcv`, the rest in `pstate` as an AArch32 SPSR
//! lays it out) and the modes' SPSRs, exception entry (the vectors at VBAR
//! or 0xFFFF0000 with SCTLR.V, the return addresses' offsets, DFSR, IFSR,
//! DFAR, IFAR) and return, the privileged instructions' semantics (CPS,
//! MRS and MSR of CPSR and SPSR, SRS, RFE, LDM and STM of the user
//! registers), and CP15 at PL1, most of it the AArch64 registers' views.

use crate::aarch64::a32::{instruction_length, reg, set_reg, thumb};
use crate::aarch64::cpu::{self, *};
use crate::aarch64::execute::Flow;
use crate::aarch64::state::*;

pub const MODE_USR: u32 = 0x10;
pub const MODE_FIQ: u32 = 0x11;
pub const MODE_IRQ: u32 = 0x12;
pub const MODE_SVC: u32 = 0x13;
pub const MODE_ABT: u32 = 0x17;
pub const MODE_UND: u32 = 0x1B;
pub const MODE_SYS: u32 = 0x1F;

/// SCTLR's bits AArch32 has of its own
const SCTLR_V: u32 = 1 << 13;
const SCTLR_EE: u32 = 1 << 25;
const SCTLR_TE: u32 = 1 << 30;
/// SCTLR at reset (QEMU's cortex-a15)
pub const SCTLR_RESET_A32: u64 = 0x00C5_0078;

/// The modes this CPU has (no Monitor, no Hyp)
#[inline(always)]
pub fn valid_mode(mode: u32) -> bool {
    matches!(
        mode,
        MODE_USR | MODE_FIQ | MODE_IRQ | MODE_SVC | MODE_ABT | MODE_UND | MODE_SYS
    )
}

/// The R13 and R14 bank of a mode: USR and SYS share one
#[inline(always)]
fn bank(mode: u32) -> usize {
    match mode {
        MODE_FIQ => 1,
        MODE_IRQ => 2,
        MODE_SVC => 3,
        MODE_ABT => 4,
        MODE_UND => 5,
        _ => 0,
    }
}

/// A mode's SPSR (none in USR and SYS)
#[inline(always)]
fn spsr_index(mode: u32) -> Option<usize> {
    match mode {
        MODE_FIQ => Some(0),
        MODE_IRQ => Some(1),
        MODE_SVC => Some(2),
        MODE_ABT => Some(3),
        MODE_UND => Some(4),
        _ => None,
    }
}

#[inline(always)]
pub fn mode() -> u32 { get_pstate() & 0x1F }

/// (AArch32 code) whether it runs at PL1: a mode but User (only with cpu::a32_only)
#[inline(always)]
pub fn privileged() -> bool { get_pstate() & 0xF != 0 }

/// The banked registers from mode `old`'s to mode `new`'s (pstate is set after)
pub fn switch_registers(old: u32, new: u32) {
    unsafe {
        let (ob, nb) = (bank(old), bank(new));
        if ob != nb {
            *a32_bank.add(2 * ob) = *x.add(13) as u32;
            *a32_bank.add(2 * ob + 1) = *x.add(14) as u32;
            *x.add(13) = *a32_bank.add(2 * nb) as u64;
            *x.add(14) = *a32_bank.add(2 * nb + 1) as u64;
        }
        // (R8-R12: FIQ's own; a32_bank_r8 0-4 the others' while in FIQ, 5-9 FIQ's while not)
        if (old == MODE_FIQ) != (new == MODE_FIQ) {
            let (save, load) = if new == MODE_FIQ { (0, 5) } else { (5, 0) };
            for i in 0..5 {
                *a32_bank_r8.add(save + i) = *x.add(8 + i) as u32;
                *x.add(8 + i) = *a32_bank_r8.add(load + i) as u64;
            }
        }
    }
}

/// A register of mode `of` (R0-R14), from wherever it is now
pub fn banked_reg(of: u32, n: u32) -> u32 {
    let current = mode();
    unsafe {
        if n >= 13 && bank(of) != bank(current) {
            return *a32_bank.add(2 * bank(of) + n as usize - 13);
        }
        if (8..13).contains(&n) && (of == MODE_FIQ) != (current == MODE_FIQ) {
            return *a32_bank_r8.add(if of == MODE_FIQ { 5 } else { 0 } + n as usize - 8);
        }
    }
    reg(n)
}
pub fn set_banked_reg(of: u32, n: u32, value: u32) {
    let current = mode();
    unsafe {
        if n >= 13 && bank(of) != bank(current) {
            *a32_bank.add(2 * bank(of) + n as usize - 13) = value;
            return;
        }
        if (8..13).contains(&n) && (of == MODE_FIQ) != (current == MODE_FIQ) {
            *a32_bank_r8.add(if of == MODE_FIQ { 5 } else { 0 } + n as usize - 8) = value;
            return;
        }
    }
    set_reg(n, value)
}

/// CPSR as an SPSR keeps it (NZCV, the mode and masks, T, E, ITSTATE, GE, Q)
#[inline(always)]
pub fn cpsr() -> u32 {
    get_nzcv() | get_pstate() & PSTATE_SAVED_A32 & !(PSTATE_IL | PSTATE_SS | PSTATE_PAN)
}

/// The current mode's SPSR (None in USR and SYS: UNPREDICTABLE there)
pub fn spsr() -> Option<u32> { spsr_index(mode()).map(|i| unsafe { *a32_spsr.add(i) }) }
pub fn set_spsr(value: u32) { set_spsr_of(mode(), value) }

/// The SPSR of mode `of` (MRS and MSR of a banked SPSR)
pub fn spsr_of(of: u32) -> u32 { spsr_index(of).map_or(0, |i| unsafe { *a32_spsr.add(i) }) }
pub fn set_spsr_of(of: u32, value: u32) {
    if let Some(i) = spsr_index(of) {
        unsafe { *a32_spsr.add(i) = value };
    }
}

/// CPSR := `value` (the exception return's, an SPSR's): the mode's banks
/// switch; an illegal mode keeps the current one
fn set_cpsr(value: u32) {
    let new_mode = if valid_mode(value & 0x1F) { value & 0x1F } else { mode() };
    set_nzcv(value & 0xF000_0000);
    let keep = PSTATE_IL | PSTATE_SS | PSTATE_PAN;
    let saved = PSTATE_SAVED_A32 & !keep & !0x1F;
    cpu::set_pstate(get_pstate() & keep | value & saved | new_mode);
}

/// MRS of CPSR (the execution state bits, but E, read as 0)
pub fn mrs_cpsr() -> u32 { cpsr() & !(PSTATE_T | PSTATE_IT) }

/// MSR CPSR_<fields> at PL1 (CPSRWriteByInstr): `mask` the byte fields
/// c (bit 0: mode, I, F), x (1: A, E), s (2: GE), f (3: NZCV, Q)
pub fn msr_cpsr(value: u32, mask: u32) {
    let privileged = mode() != MODE_USR;
    let mut pstate_value = get_pstate();
    if mask & 8 != 0 {
        set_nzcv(value & 0xF000_0000);
        pstate_value = pstate_value & !PSTATE_Q | value & PSTATE_Q;
    }
    if mask & 4 != 0 {
        pstate_value = pstate_value & !PSTATE_GE | value & PSTATE_GE;
    }
    if mask & 2 != 0 && privileged {
        pstate_value = pstate_value & !(PSTATE_A | PSTATE_E) | value & (PSTATE_A | PSTATE_E);
    }
    if mask & 1 != 0 && privileged {
        pstate_value = pstate_value & !(PSTATE_I | PSTATE_F) | value & (PSTATE_I | PSTATE_F);
        if valid_mode(value & 0x1F) {
            pstate_value = pstate_value & !0x1F | value & 0x1F;
        }
    }
    cpu::set_pstate(pstate_value);
}

/// The bits of an SPSR that MSR writes (as QEMU's cortex-a15: all but 23:21)
const SPSR_VALID: u32 = 0xFF1F_FFFF;

/// MSR SPSR_<fields>
pub fn msr_spsr(value: u32, mask: u32) {
    let Some(old) = spsr()
    else {
        return;
    };
    let bytes = (0..4)
        .filter(|b| mask & 1 << b != 0)
        .fold(0, |m, b| m | 0xFF << (8 * b))
        & SPSR_VALID;
    set_spsr(old & !bytes | value & bytes);
}

/// CPS: `imod` 2 enable, 3 disable the A, I, F masks `aif` (bits 2:0); a mode when `change_mode`
pub fn cps(imod: u32, aif: u32, change_mode: bool, new_mode: u32) {
    if mode() == MODE_USR {
        return;
    }
    let masks = (aif & 4 != 0) as u32 * PSTATE_A
        | (aif & 2 != 0) as u32 * PSTATE_I
        | (aif & 1 != 0) as u32 * PSTATE_F;
    let mut value = get_pstate();
    match imod {
        2 => value &= !masks,
        3 => value |= masks,
        _ => {},
    }
    if change_mode && valid_mode(new_mode) {
        value = value & !0x1F | new_mode;
    }
    cpu::set_pstate(value);
}

/// An exception return (SUBS PC, LR; LDM with the PC and ^; RFE takes its
/// CPSR from memory): CPSR := `value`, the PC `target` aligned for the
/// instruction set it returns to
pub fn return_to(target: u32, value: u32) -> Flow {
    crate::aarch64::jit::pages::a32_trace(7, target, value);
    set_cpsr(value);
    unsafe { *excl_valid = 0 };
    Flow::Jump((target & if value & PSTATE_T != 0 { !1 } else { !3 }) as u64)
}

/// SUBS PC, LR and the data processing with S into the PC at PL1: CPSR := SPSR
pub fn exception_return(target: u32) -> Result<Flow, Exception> {
    match spsr() {
        Some(value) => Ok(return_to(target, value)),
        None => Err(Exception::Undefined),
    }
}

/// LDM with the PC and ^ (an exception return), LDM and STM of the User
/// mode's registers (`writeback` UNPREDICTABLE there: UNDEFINED), `pc` the
/// value an STM stores for the PC
pub fn block_user(
    load: bool,
    rn: u32,
    list: u32,
    start: u32,
    writeback: Option<u32>,
    stored_pc: u32,
) -> Result<Flow, Exception> {
    use crate::aarch64::a32::{load_aligned, prepare_store};
    let returns = load && list & 1 << 15 != 0;
    if !returns && writeback.is_some() || returns && spsr().is_none() {
        return Err(Exception::Undefined);
    }
    let mut address = start;
    if load {
        let mut values = [0u32; 16];
        for i in 0..16 {
            if list & 1 << i != 0 {
                values[i] = load_aligned(address, 4)?;
                address = address.wrapping_add(4);
            }
        }
        if returns {
            if let Some(base) = writeback {
                set_reg(rn, base);
            }
            for i in 0..15 {
                if list & 1 << i != 0 {
                    set_reg(i as u32, values[i]);
                }
            }
            return Ok(return_to(values[15], spsr().unwrap_or(0)));
        }
        for i in 0..15 {
            if list & 1 << i != 0 {
                set_banked_reg(MODE_USR, i as u32, values[i]);
            }
        }
        return Ok(Flow::Next);
    }
    let mut stores: [Option<(crate::aarch64::memory::Store, u32)>; 16] = Default::default();
    for i in 0..16u32 {
        if list & 1 << i != 0 {
            let value = if i == 15 { stored_pc } else { banked_reg(MODE_USR, i) };
            stores[i as usize] = Some((prepare_store(address, 4, false, true)?, value));
            address = address.wrapping_add(4);
        }
    }
    for store in stores.into_iter().flatten() {
        store.0.commit(store.1 as u64)?;
    }
    Ok(Flow::Next)
}

/// The first of two words an SRS or RFE transfers from `base`: P (before) and U (up)
fn two_words(base: u32, p: bool, u: bool) -> (u32, u32) {
    let start = match (p, u) {
        (false, true) => base,
        (true, true) => base.wrapping_add(4),
        (false, false) => base.wrapping_sub(4),
        (true, false) => base.wrapping_sub(8),
    };
    (
        start,
        if u { base.wrapping_add(8) } else { base.wrapping_sub(8) },
    )
}

/// SRS: the current mode's LR and SPSR to the stack of mode `to`
pub fn srs(p: bool, u: bool, w: bool, to: u32) -> Result<Flow, Exception> {
    use crate::aarch64::a32::prepare_store;
    let Some(saved) = spsr()
    else {
        return Err(Exception::Undefined);
    };
    if !valid_mode(to) || to == MODE_USR {
        return Err(Exception::Undefined);
    }
    let (start, new_base) = two_words(banked_reg(to, 13), p, u);
    let first = prepare_store(start, 4, false, true)?;
    let second = prepare_store(start.wrapping_add(4), 4, false, true)?;
    first.commit(reg(14) as u64)?;
    second.commit(saved as u64)?;
    if w {
        set_banked_reg(to, 13, new_base);
    }
    Ok(Flow::Next)
}

/// RFE: the PC and CPSR from [Rn]
pub fn rfe(p: bool, u: bool, w: bool, rn: u32) -> Result<Flow, Exception> {
    use crate::aarch64::a32::load_aligned;
    if rn == 15 {
        return Err(Exception::Undefined);
    }
    let (start, new_base) = two_words(reg(rn), p, u);
    let target = load_aligned(start, 4)?;
    let value = load_aligned(start.wrapping_add(4), 4)?;
    if w {
        set_reg(rn, new_base);
    }
    Ok(return_to(target, value))
}

/// MRC, MCR of CP14 (debug, the trivial Jazelle and its registers): read as
/// zero, writes ignored at PL1 (DBGDIDR 0: Linux finds no debug
/// architecture it supports); UNDEFINED at PL0
pub fn cp14(read: bool, rt: u32) -> Result<Flow, Exception> {
    if !privileged() {
        return Err(Exception::Undefined);
    }
    if read {
        if rt == 15 {
            set_nzcv(0);
        }
        else {
            set_reg(rt, 0);
        }
    }
    Ok(Flow::Next)
}

/// FPSID (cortex-a15's)
const FPSID: u32 = 0x4104_30F0;
const FPEXC_EN: u32 = 1 << 30;

/// Whether VFP and Advanced SIMD are enabled (FPEXC.EN)
#[inline(always)]
pub fn fp_enabled() -> bool { (unsafe { *a32_fpexc }) & FPEXC_EN != 0 }

/// VMRS, VMSR of FPSID (0), MVFR2 (5), MVFR1 (6), MVFR0 (7), FPEXC (8) at
/// PL1: CPACR's access, whatever FPEXC.EN says
pub fn vfp_system(register: u32, rt: u32, to_core: bool) -> Result<Flow, Exception> {
    let fpen = unsafe { *cpacr_el1 } >> 20 & 3;
    if !privileged() || fpen != 3 && fpen != 1 || rt == 15 {
        return Err(Exception::Undefined);
    }
    let id = |row: usize| crate::aarch64::sysregs::AARCH32_ID[2][row] as u32;
    let value = match register {
        0 => FPSID,
        5 => id(2),
        6 => id(1),
        7 => id(0),
        8 => unsafe { *a32_fpexc },
        _ => return Err(Exception::Undefined),
    };
    if to_core {
        set_reg(rt, value);
    }
    else {
        match register {
            8 => unsafe { *a32_fpexc = reg(rt) & FPEXC_EN },
            0 => {},
            _ => return Err(Exception::Undefined),
        }
    }
    Ok(Flow::Next)
}

// ---- exception entry

/// Take an exception to `new_mode` at vector `offset`: SPSR := CPSR, LR := `lr`,
/// the masks `mask` set, T and E as SCTLR says
fn enter(offset: u32, new_mode: u32, lr: u32, mask: u32) {
    let old = cpsr();
    crate::aarch64::jit::pages::a32_trace(6, cpu::get_pc() as u32, old);
    let sctlr = cpu::sctlr() as u32;
    let mut value = get_pstate()
        & !(0x1F | PSTATE_T | PSTATE_IT | PSTATE_E | PSTATE_IL | PSTATE_SS)
        | new_mode
        | mask;
    if sctlr & SCTLR_TE != 0 {
        value |= PSTATE_T;
    }
    if sctlr & SCTLR_EE != 0 {
        value |= PSTATE_E;
    }
    cpu::set_pstate(value);
    set_spsr(old);
    set_reg(14, lr);
    let base =
        if sctlr & SCTLR_V != 0 { 0xFFFF_0000 } else { (unsafe { *vbar_el1 }) as u32 & !0x1F };
    unsafe { *excl_valid = 0 };
    cpu::set_pc(base.wrapping_add(offset) as u64);
}

/// The fault status (DFSR, IFSR) of an AArch64 DFSC: with the long
/// descriptors LPAE's (bit 9, the DFSC); else the short descriptors' (level
/// 1 sections, levels 2 and 3 pages; 0x3D and 0x3E the domain faults): FS[4]
/// in bit 10, FS[3:0] in bits 3:0
fn fsr(code: u32) -> u32 {
    let dfsc = code & 0x3F;
    if crate::aarch64::mmu_a32::long_descriptors() {
        return 1 << 9 | dfsc;
    }
    // (the domain, mmu_a32::FSC_DOMAIN_SHIFT)
    let domain = code >> crate::aarch64::mmu_a32::FSC_DOMAIN_SHIFT & 15;
    let fs = match dfsc {
        0x21 => 0b00001,
        0x22 => 0b00010,
        0x04..=0x05 => 0b00101,
        0x06..=0x07 => 0b00111,
        0x08..=0x09 => 0b00011,
        0x0A..=0x0B => 0b00110,
        0x0C..=0x0D => 0b01101,
        0x0E..=0x0F => 0b01111,
        0x3D => 0b01001,
        0x3E => 0b01011,
        // (external aborts on the walk: level 1, level 2)
        0x14..=0x15 => 0b01100,
        0x16..=0x17 => 0b01110,
        // (synchronous external aborts)
        _ => 0b01000,
    };
    (fs & 0x10) << 6 | fs & 0xF | domain << 4
}

/// The current instruction (at the PC) takes `exception` (cpu::take_sync's
/// AArch32 counterpart): its vector, mode, LR and fault status
pub fn take_sync(exception: Exception) {
    let here = cpu::get_pc() as u32;
    let a = PSTATE_A | PSTATE_I;
    match exception {
        Exception::Svc(_) => enter(
            0x08,
            MODE_SVC,
            here.wrapping_add(instruction_length()),
            PSTATE_I,
        ),
        Exception::InstructionAbort { fsc, far } => {
            // (a64_page_aarch32_trace: EL0's execute permission faults, which
            // Linux makes SIGSEGV)
            if fsc & 0x3C == 0x0C && cpu::el() == 0 {
                crate::aarch64::jit::pages::a32_trace_dump("an instruction permission fault");
            }
            unsafe {
                *a32_ifsr = fsr(fsc);
                *far_el1 = *far_el1 & 0xFFFF_FFFF | (far as u32 as u64) << 32;
            }
            enter(0x0C, MODE_ABT, here.wrapping_add(4), a);
        },
        Exception::PcAlignment(far) => {
            unsafe {
                *a32_ifsr = fsr(0x21);
                *far_el1 = *far_el1 & 0xFFFF_FFFF | (far as u32 as u64) << 32;
            }
            enter(0x0C, MODE_ABT, here.wrapping_add(4), a);
        },
        // (BKPT: a prefetch abort of a debug event)
        Exception::Breakpoint | Exception::Trapped32 { ec: 0x38, .. } => {
            // (IFAR UNKNOWN: 0, as QEMU writes it)
            unsafe {
                *a32_ifsr = fsr(0x22);
                *far_el1 &= 0xFFFF_FFFF;
            }
            enter(0x0C, MODE_ABT, here.wrapping_add(4), a);
        },
        Exception::DataAbort { iss, far } => {
            unsafe {
                // (WnR in bit 11, CM in bit 13)
                *esr_el1 = (fsr(iss) | (iss >> 6 & 1) << 11 | (iss >> 8 & 1) << 13) as u64;
                *far_el1 = *far_el1 & !0xFFFF_FFFF | far as u32 as u64;
            }
            enter(0x10, MODE_ABT, here.wrapping_add(8), a);
        },
        Exception::Watchpoint { write, far } => {
            unsafe {
                *esr_el1 = (fsr(0x22) | (write as u32) << 11) as u64;
                *far_el1 = *far_el1 & !0xFFFF_FFFF | far as u32 as u64;
            }
            enter(0x10, MODE_ABT, here.wrapping_add(8), a);
        },
        _ => enter(
            0x04,
            MODE_UND,
            here.wrapping_add(if thumb() { 2 } else { 4 }),
            PSTATE_I,
        ),
    }
}

/// An interrupt (cpu::take_exception's): IRQ or FIQ, the PC the next instruction's
pub fn take_interrupt(fiq: bool) {
    let lr = (cpu::get_pc() as u32).wrapping_add(4);
    if fiq {
        enter(0x1C, MODE_FIQ, lr, PSTATE_A | PSTATE_I | PSTATE_F);
    }
    else {
        enter(0x18, MODE_IRQ, lr, PSTATE_A | PSTATE_I);
    }
}

/// The core's state at reset: SVC mode, A, I and F masked, A32 (T32 when
/// bit 0 of `entry`), MMU off; R0 `context`
pub fn reset(entry: u64, context: u64) {
    unsafe {
        *pstate =
            MODE_SVC | PSTATE_A | PSTATE_I | PSTATE_F | if entry & 1 != 0 { PSTATE_T } else { 0 };
        *pc = entry & !1;
        *x = context as u32 as u64;
        *sctlr_el1 = SCTLR_RESET_A32;
        for i in 0..12 {
            *a32_bank.add(i) = 0;
        }
        for i in 0..10 {
            *a32_bank_r8.add(i) = 0;
        }
        for i in 0..5 {
            *a32_spsr.add(i) = 0;
        }
        *a32_ttbcr = 0;
        *a32_dacr = 0;
        *a32_ifsr = 0;
    }
}

/// (the machine) a 32-bit kernel's boot: core 0 from `entry` in SVC mode with
/// R0 0, R1 ~0 (a device tree, not a board number), R2 the device tree
#[no_mangle]
pub fn a32_boot(entry: u32, dtb: u32) {
    crate::aarch64::smp::a64_boot(entry, 0, 0, 0);
    cpu::set_x(1, 0xFFFF_FFFF);
    cpu::set_x(2, dtb as u64);
}

// ---- CP15 at PL1

/// The ID registers of profile arm32-v1: profile v3's AArch32 ones
/// (sysregs::AARCH32_ID, CRm 1-2: ID_PFR0, PFR1, DFR0, AFR0, MMFR0-3;
/// ISAR0-5, MMFR4, ISAR6) with ID_PFR1's programmers' model of the PL1
/// modes; no Security, no Virtualization
fn id_register(crm: u32, op2: u32) -> u32 {
    let value = crate::aarch64::sysregs::AARCH32_ID[crm as usize - 1][op2 as usize] as u32;
    if (crm, op2) == (1, 1) {
        value | 1
    }
    else {
        value
    }
}
/// MIDR: cortex-a15 r4p0 (QEMU's; the Android emulator's 32-bit CPU)
pub const MIDR_A15: u32 = 0x414F_C0F0;
const CTR_A15: u32 = 0x8444_C004;

/// MRC (read, Rt := the value) or MCR (`value`) of CP15 at PL1
pub fn cp15(
    read: bool,
    opc1: u32,
    crn: u32,
    crm: u32,
    opc2: u32,
    rt: u32,
    value: u32,
) -> Result<Flow, Exception> {
    use crate::aarch64::sysregs;
    // (the registers that are AArch64's: op0 3, the same op1, CRn, CRm, op2)
    let aarch64 = |reg: u32, read: bool| -> Result<Flow, Exception> {
        if read {
            let got = sysregs::read(reg, rt)?;
            set_reg(rt, got as u32);
        }
        else {
            // (a 32-bit view: the high half kept)
            let old = sysregs::read(reg, rt).unwrap_or(0);
            sysregs::write(reg, rt, old & !0xFFFF_FFFF | value as u64)?;
        }
        Ok(Flow::Next)
    };
    let field = |p: *mut u32| -> Result<Flow, Exception> {
        unsafe {
            if read {
                set_reg(rt, *p);
            }
            else {
                *p = value;
            }
        }
        Ok(Flow::Next)
    };
    let half = |p: *mut u64, high: bool| -> Result<Flow, Exception> {
        unsafe {
            let shift = if high { 32 } else { 0 };
            if read {
                set_reg(rt, (*p >> shift) as u32);
            }
            else {
                *p = *p & !(0xFFFF_FFFFu64 << shift) | (value as u64) << shift;
            }
        }
        Ok(Flow::Next)
    };
    let constant = |got: u32| -> Result<Flow, Exception> {
        if read {
            set_reg(rt, got);
        }
        Ok(Flow::Next)
    };
    match (opc1, crn, crm, opc2) {
        // MIDR, CTR, TCMTR, TLBTR, MPIDR, REVIDR
        (0, 0, 0, 0) | (0, 0, 0, 4) | (0, 0, 0, 7) => constant(MIDR_A15),
        (0, 0, 0, 1) => constant(CTR_A15),
        (0, 0, 0, 2) | (0, 0, 0, 3) | (0, 0, 0, 6) => constant(0),
        (0, 0, 0, 5) => constant(sysregs::mpidr() as u32),
        (0, 0, 1..=2, _) => constant(id_register(crm, opc2)),
        (0, 0, _, _) => constant(0),
        // CCSIDR, CLIDR, AIDR; CSSELR
        (1, 0, 0, 0) | (1, 0, 0, 1) | (1, 0, 0, 7) => aarch64(sysregs::key(3, 1, 0, 0, opc2), true),
        (2, 0, 0, 0) => aarch64(sysregs::key(3, 2, 0, 0, 0), read),
        // SCTLR (AArch32's bits: V, TE, EE too), ACTLR, CPACR
        (0, 1, 0, 0) => {
            if read {
                set_reg(rt, cpu::sctlr() as u32);
            }
            else {
                unsafe { *sctlr_el1 = value as u64 };
                crate::aarch64::mmu::regime_changed();
            }
            Ok(Flow::Next)
        },
        // (ACTLR: RAZ/WI, as QEMU's cortex-a15)
        (0, 1, 0, 1) => constant(0),
        (0, 1, 0, 2) => {
            let r = half(cpacr_el1, false);
            // (ASEDIS, D32DIS, cp11, cp10, as QEMU's ARMv7 CPUs keep them)
            unsafe { *cpacr_el1 &= 0xC0F0_0000 };
            r
        },
        // TTBR0, TTBR1 (32-bit views), TTBCR
        (0, 2, 0, 0) | (0, 2, 0, 1) => {
            let r = half(if opc2 == 0 { ttbr0_el1 } else { ttbr1_el1 }, false);
            if !read {
                crate::aarch64::mmu::ttbr_changed();
            }
            r
        },
        (0, 2, 0, 2) => {
            let r = field(a32_ttbcr);
            if !read {
                crate::aarch64::mmu::regime_changed();
            }
            r
        },
        // DACR (the TLB's entries keep their domain: mmu_a32::with_domain; the
        // page tier's access cache has the permissions it gave)
        (0, 3, 0, 0) => {
            let old = unsafe { *a32_dacr };
            let r = field(a32_dacr);
            if !read && value != old {
                crate::aarch64::tlb::bump_generation();
                crate::aarch64::jit::pages::tlb_flushed(crate::isa::current_core());
            }
            r
        },
        // DFSR (ESR_EL1's), IFSR, ADFSR, AIFSR
        (0, 5, 0, 0) => half(esr_el1, false),
        (0, 5, 0, 1) => field(a32_ifsr),
        (0, 5, 1, 0) | (0, 5, 1, 1) => constant(0),
        // DFAR, IFAR (FAR_EL1's halves)
        (0, 6, 0, 0) => half(far_el1, false),
        (0, 6, 0, 2) => half(far_el1, true),
        // cache maintenance and the CP15 barriers; the branch predictor
        (0, 7, 5, 4) | (0, 7, 10, 4) | (0, 7, 10, 5) if !read => Ok(Flow::Next),
        (0, 7, 1 | 5 | 6 | 10 | 11 | 14, _) if !read => Ok(Flow::Next),
        // PAR (32-bit) and the address translation operations: not yet (UNDEFINED)
        // TLB maintenance (the IS forms CRm 3; ITLB, DTLB, unified 5, 6, 7):
        // all, by MVA and ASID, by ASID, by MVA all ASIDs (the last level's too)
        (0, 8, 3 | 5 | 6 | 7, 0..=3 | 5 | 7) if !read => {
            use crate::aarch64::tlb;
            let shareable = crm == 3;
            let (page, asid) = ((value >> 12) as u64, (value & 0xFF) as u16);
            match opc2 {
                0 => tlb::flush(shareable),
                2 => tlb::flush_asid(shareable, asid),
                1 | 5 => tlb::flush_page(shareable, page, Some(asid)),
                _ => tlb::flush_page(shareable, page, None),
            }
            Ok(Flow::Next)
        },
        // the performance monitors: read as 0, writes ignored
        (0, 9, 12..=14, _) => constant(0),
        // PRRR, NMRR (MAIR_EL1's halves), AMAIR0/1
        (0, 10, 2, 0) | (0, 10, 2, 1) => {
            let r = half(mair_el1, opc2 == 1);
            if !read {
                crate::aarch64::mmu::regime_changed();
            }
            r
        },
        (0, 10, 3, 0) | (0, 10, 3, 1) => half(amair_el1, opc2 == 1),
        // VBAR
        (0, 12, 0, 0) => half(vbar_el1, false),
        // the GICv3 CPU interface (ICC_*: AArch64's registers by the same encodings)
        (0, 4, 6, 0) | (0, 12, 8 | 9 | 11 | 12, _) => {
            aarch64(sysregs::key(3, 0, crn, crm, opc2), read)
        },
        // CONTEXTIDR, TPIDRURW, TPIDRURO, TPIDRPRW
        (0, 13, 0, 1) => {
            let r = half(contextidr_el1, false);
            if !read {
                crate::aarch64::mmu::ttbr_changed();
            }
            r
        },
        (0, 13, 0, 2) => half(tpidr_el0, false),
        (0, 13, 0, 3) => half(tpidrro_el0, false),
        (0, 13, 0, 4) => half(tpidr_el1, false),
        // the generic timer: CNTFRQ, CNTKCTL, CNTP_TVAL/CTL, CNTV_TVAL/CTL
        (0, 14, 0, 0) | (0, 14, 2, 0) | (0, 14, 2, 1) | (0, 14, 3, 0) | (0, 14, 3, 1) => {
            let key = sysregs::key(3, 3, 14, crm, opc2);
            if read {
                let got = crate::aarch64::timer::read(key, rt)?;
                set_reg(rt, got as u32);
            }
            else {
                crate::aarch64::timer::write(key, rt, value as u64)?;
            }
            Ok(Flow::Next)
        },
        (0, 14, 1, 0) => half(cntkctl_el1, false),
        _ => Err(Exception::Undefined),
    }
}

/// MRRC (read: Rt, Rt2 := the value's halves) or MCRR (`value`) of CP15 at
/// PL1: TTBR0 (opc1 0), TTBR1 (1) and PAR (CRm 7) of 64 bits; the timer's
/// counters and compare values (CRm 14); ICC_SGI1R (CRm 12)
pub fn cp15_64(
    read: bool,
    opc1: u32,
    crm: u32,
    rt: u32,
    rt2: u32,
    value: u64,
) -> Result<Flow, Exception> {
    use crate::aarch64::sysregs;
    let set = |got: u64| {
        set_reg(rt, got as u32);
        set_reg(rt2, (got >> 32) as u32);
    };
    match (opc1, crm) {
        (0 | 1, 2) => unsafe {
            let p = if opc1 == 0 { ttbr0_el1 } else { ttbr1_el1 };
            if read {
                set(*p);
            }
            else {
                *p = value;
                crate::aarch64::mmu::ttbr_changed();
            }
            Ok(Flow::Next)
        },
        (0, 7) => unsafe {
            if read {
                set(*par_el1);
            }
            else {
                *par_el1 = value;
            }
            Ok(Flow::Next)
        },
        (0..=3, 14) => {
            let key = match opc1 {
                0 => sysregs::key(3, 3, 14, 0, 1),
                1 => sysregs::key(3, 3, 14, 0, 2),
                2 => sysregs::key(3, 3, 14, 2, 2),
                _ => sysregs::key(3, 3, 14, 3, 2),
            };
            if read {
                set(crate::aarch64::timer::read(key, rt)?);
            }
            else {
                if opc1 < 2 {
                    return Err(Exception::Undefined);
                }
                crate::aarch64::timer::write(key, rt, value)?;
            }
            Ok(Flow::Next)
        },
        // ICC_SGI1R (MCRR p15, 0, Rt, Rt2, c12)
        (0, 12) if !read => {
            sysregs::write(sysregs::key(3, 0, 12, 11, 5), rt, value)?;
            Ok(Flow::Next)
        },
        _ => Err(Exception::Undefined),
    }
}

/// HVC at PL1: PSCI (the device tree's conduit); a machine powered off or
/// a core suspended waits
pub fn hvc() -> Result<Flow, Exception> {
    Ok(match crate::aarch64::psci::call() {
        crate::aarch64::psci::After::Continue => Flow::Next,
        crate::aarch64::psci::After::Wait => Flow::Wait(1),
        crate::aarch64::psci::After::Off => Flow::Off,
    })
}
