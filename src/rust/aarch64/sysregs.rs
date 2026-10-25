//! System registers and system instructions of profile v86-aarch64-v1
//! (docs/arm64-virt-android16-plan.md P3.1; the values are those of
//! tests/platform/a64-profile.json, which tools/cpu_contract.mjs checks):
//! access rights at EL0 and EL1, reset values, RES0/RES1, and the traps
//! SCTLR_EL1 controls (UCT, UCI, DZE, UMA: EC 0x18). The ID space follows the
//! profile: op0=3, op1=0, CRn=0, CRm=1-7 encodings that are not registers
//! read 0 at EL1; CRm=0 has MIDR, MPIDR, REVIDR only.

use crate::aarch64::cpu::{self, *};
use crate::aarch64::state::*;

/// CNTFRQ_EL0 at reset: the system counter's 1 GHz
pub const CNTFRQ_RESET: u64 = 1_000_000_000;

/// A system register's encoding op0:op1:CRn:CRm:op2 (16 bits, as in MRS/MSR)
pub const fn key(op0: u32, op1: u32, crn: u32, crm: u32, op2: u32) -> u32 {
    op0 << 14 | op1 << 11 | crn << 7 | crm << 3 | op2
}

// the ID registers (the profile's values)
pub const MIDR: u64 = 0x000F_0860;
pub const ID_AA64PFR0: u64 = 0x1100_0000_0100_0011;
pub const ID_AA64DFR0: u64 = 0x0010_1006;
pub const ID_AA64ISAR0: u64 = 0x0001_1120;
pub const ID_AA64MMFR0: u64 = 0x0F00_0022;
pub const CTR: u64 = 0x8444_C004;
pub const CLIDR: u64 = 0x0A20_0023;
pub const CCSIDR: [u64; 3] = [0x700F_E01A, 0x200F_E01A, 0x703F_E07A];

/// Profile v3's AArch32 ID registers (CRm 1-3, op2 0-7: ID_PFR0, PFR1,
/// DFR0, AFR0, MMFR0-3; ISAR0-5, MMFR4, ISAR6; MVFR0-2, -, PFR2, DFR1,
/// MMFR5): the reference's (cortex-a35) for an AArch32 at EL0 only, as
/// Cortex-A76's: no AArch32 EL1 modes (ID_PFR1.ProgMod 0), no SETEND
/// (ID_ISAR1.Endian 0, no mixed endianness), no SMC (ID_ISAR4.SMC 0, no EL3)
pub const AARCH32_ID: [[u64; 8]; 3] = [
    [
        0x0000_0131,
        0x1001_0000,
        0x0000_0006,
        0,
        0x1020_1105,
        0x4000_0000,
        0x0126_0000,
        0x0210_2211,
    ],
    [
        0x0210_1110,
        0x1311_2110,
        0x2123_2042,
        0x0111_2131,
        0x0001_0142,
        0x0001_1121,
        0,
        0,
    ],
    [0x1011_0222, 0x1211_1111, 0x0000_0043, 0, 0, 0, 0, 0],
];

/// SCTLR_EL1 keeps what is written but the MTE controls (ITFSB, TCF0, TCF,
/// ATA0, ATA: FEAT_MTE is not in v1), as the reference does; v86 acts on the
/// bits profile v1 defines
const SCTLR_MTE: u64 = 1 << 37 | 3 << 38 | 3 << 40 | 1 << 42 | 1 << 43;

/// The ISS of a trapped system register access or instruction (EC 0x18)
fn trap_iss(reg: u32, rt: u32, read: bool) -> u32 {
    let op0 = reg >> 14 & 3;
    let op1 = reg >> 11 & 7;
    let crn = reg >> 7 & 15;
    let crm = reg >> 3 & 15;
    let op2 = reg & 7;
    op0 << 20 | op2 << 17 | op1 << 14 | crn << 10 | rt << 5 | crm << 1 | read as u32
}

/// The core's MPIDR_EL1 (bit 31 RES1, Aff0 the core)
pub fn mpidr() -> u64 { 0x8000_0000 | crate::isa::current_core() as u64 }

/// The system counter (P3.6: one for the machine, from the machine clock)
pub fn counter() -> u64 { crate::aarch64::timer::counter() }

/// MRS: the value of the register `reg` read by instruction register `rt`
pub fn read(reg: u32, rt: u32) -> Result<u64, Exception> {
    let el = cpu::el();
    let op0 = reg >> 14;
    let op1 = reg >> 11 & 7;
    let crn = reg >> 7 & 15;
    let crm = reg >> 3 & 15;
    let op2 = reg & 7;
    if op0 == 3 && op1 == 0 && crn == 0 {
        // the ID space
        if el == 0 {
            return Err(Exception::Undefined);
        }
        return match (crm, op2) {
            (0, 0) => Ok(MIDR),
            (0, 5) => Ok(mpidr()),
            (0, 6) => Ok(0),
            (0, _) => Err(Exception::Undefined),
            // (EL0: AArch64 and AArch32 in profile v3)
            (4, 0) => Ok(if cpu::has_aarch32() { ID_AA64PFR0 & !0xF | 2 } else { ID_AA64PFR0 }),
            (1..=3, _) if cpu::has_aarch32() => Ok(AARCH32_ID[crm as usize - 1][op2 as usize]),
            (5, 0) => Ok(ID_AA64DFR0),
            (6, 0) => Ok(ID_AA64ISAR0),
            (7, 0) => Ok(ID_AA64MMFR0 & !(0xFF << 20) | crate::aarch64::mmu::mmfr0_granules()),
            // ID_AA64MMFR1_EL1: PAN 0b0001 (FEAT_PAN) in v2
            (7, 1) => Ok(if cpu::has_pan() { 1 << 20 } else { 0 }),
            _ => Ok(0),
        };
    }
    let el0_ok =
        |allowed: bool| if el == 0 && !allowed { Err(Exception::Undefined) } else { Ok(()) };
    let trap = |enabled: bool| {
        if el == 0 && !enabled {
            Err(Exception::SystemRegister(trap_iss(reg, rt, true)))
        }
        else {
            Ok(())
        }
    };
    unsafe {
        Ok(match reg {
            // EL0-accessible
            r if r == key(3, 3, 4, 2, 0) => get_nzcv() as u64,
            r if r == key(3, 3, 4, 2, 1) => {
                trap(cpu::sctlr() & SCTLR_UMA != 0)?;
                (get_pstate() & PSTATE_DAIF) as u64
            },
            // (FPCR and FPSR trap as FP instructions do: CPACR_EL1.FPEN)
            r if r == key(3, 3, 4, 4, 0) => {
                crate::aarch64::fp::check_access()?;
                crate::aarch64::fp::fpcr_read()
            },
            r if r == key(3, 3, 4, 4, 1) => {
                crate::aarch64::fp::check_access()?;
                *fpsr as u64
            },
            r if r == key(3, 3, 13, 0, 2) => *tpidr_el0,
            r if r == key(3, 3, 13, 0, 3) => *tpidrro_el0,
            r if r == key(3, 3, 0, 0, 1) => {
                trap(cpu::sctlr() & SCTLR_UCT != 0)?;
                CTR
            },
            r if r == key(3, 3, 0, 0, 7) => {
                // DZP: prohibited at EL0 with SCTLR_EL1.DZE clear
                4 | if el == 0 && cpu::sctlr() & SCTLR_DZE == 0 { 1 << 4 } else { 0 }
            },
            r if (r >> 7) == key(3, 3, 14, 0, 0) >> 7 => {
                return crate::aarch64::timer::read(reg, rt)
            },
            r if r == key(2, 3, 0, 1, 0) => {
                // MDCCSR_EL0 (the debug communications channel: not implemented)
                el0_ok(*mdscr_el1 & 1 << 12 == 0)?;
                0
            },
            _ => {
                el0_ok(false)?;
                read_el1(reg, rt)?
            },
        })
    }
}

unsafe fn read_el1(reg: u32, rt: u32) -> Result<u64, Exception> {
    Ok(match reg {
        // CCSIDR_EL1 of the level and kind CSSELR_EL1 selects (0 for none)
        r if r == key(3, 1, 0, 0, 0) => CCSIDR.get(*csselr_el1 as usize).copied().unwrap_or(0),
        r if r == key(3, 1, 0, 0, 1) => CLIDR,
        r if r == key(3, 1, 0, 0, 7) => 0, // AIDR_EL1
        r if r == key(3, 2, 0, 0, 0) => *csselr_el1,
        r if r == key(3, 0, 1, 0, 0) => *sctlr_el1,
        // PAN (FEAT_PAN)
        r if r == key(3, 0, 4, 2, 3) && cpu::has_pan() => (get_pstate() & PSTATE_PAN) as u64,
        r if r == key(3, 0, 1, 0, 1) => *actlr_el1,
        r if r == key(3, 0, 1, 0, 2) => *cpacr_el1,
        r if r == key(3, 0, 2, 0, 0) => *ttbr0_el1,
        r if r == key(3, 0, 2, 0, 1) => *ttbr1_el1,
        r if r == key(3, 0, 2, 0, 2) => *tcr_el1,
        r if r == key(3, 0, 4, 0, 0) => *spsr_el1,
        r if r == key(3, 0, 4, 0, 1) => *elr_el1,
        r if r == key(3, 0, 4, 1, 0) => {
            // SP_EL0 is not accessible while it is the current SP
            if get_pstate() & PSTATE_SP == 0 {
                return Err(Exception::Undefined);
            }
            cpu::get_sp_el(0)
        },
        r if r == key(3, 0, 4, 2, 0) => (get_pstate() & PSTATE_SP) as u64,
        r if r == key(3, 0, 4, 2, 2) => (get_pstate() & 0xC) as u64, // CurrentEL
        r if r == key(3, 0, 5, 1, 0) => *afsr0_el1,
        r if r == key(3, 0, 5, 1, 1) => *afsr1_el1,
        r if r == key(3, 0, 5, 2, 0) => *esr_el1,
        r if r == key(3, 0, 6, 0, 0) => *far_el1,
        r if r == key(3, 0, 7, 4, 0) => *par_el1,
        r if r == key(3, 0, 10, 2, 0) => *mair_el1,
        r if r == key(3, 0, 10, 3, 0) => *amair_el1,
        r if r == key(3, 0, 12, 0, 0) => *vbar_el1,
        r if r == key(3, 0, 12, 0, 1) => 0, // RVBAR_EL1
        r if r == key(3, 0, 12, 1, 0) => crate::aarch64::gic::isr_el1(),
        r if r == key(3, 0, 13, 0, 1) => *contextidr_el1,
        r if r == key(3, 0, 13, 0, 4) => *tpidr_el1,
        r if r == key(3, 0, 14, 1, 0) => *cntkctl_el1,
        // the GIC CPU interface (P3.5)
        r if crate::aarch64::gic::is_icc(r) => return crate::aarch64::gic::icc_read(r),
        // debug (P3.8)
        r if r >> 14 == 2 => return crate::aarch64::debug::read(r, rt),
        _ => return Err(Exception::Undefined),
    })
}

/// MSR (register): write `value` to the register `reg`
pub fn write(reg: u32, rt: u32, value: u64) -> Result<(), Exception> {
    let el = cpu::el();
    let op0 = reg >> 14;
    if op0 == 3 && reg >> 7 & 0x7F == 0 && reg >> 11 & 7 == 0 {
        // the ID space (op1 = 0, CRn = 0): read-only
        return Err(Exception::Undefined);
    }
    let trap = |enabled: bool| {
        if el == 0 && !enabled {
            Err(Exception::SystemRegister(trap_iss(reg, rt, false)))
        }
        else {
            Ok(())
        }
    };
    unsafe {
        match reg {
            r if r == key(3, 3, 4, 2, 0) => set_nzcv(value as u32),
            r if r == key(3, 3, 4, 2, 1) => {
                trap(cpu::sctlr() & SCTLR_UMA != 0)?;
                set_pstate(get_pstate() & !PSTATE_DAIF | value as u32 & PSTATE_DAIF);
            },
            r if r == key(3, 3, 4, 4, 0) => {
                crate::aarch64::fp::check_access()?;
                crate::aarch64::fp::fpcr_write(value)
            },
            r if r == key(3, 3, 4, 4, 1) => {
                crate::aarch64::fp::check_access()?;
                *fpsr = value as u32 & 0xF800_009F
            },
            r if r == key(3, 3, 13, 0, 2) => *tpidr_el0 = value,
            r if (r >> 7) == key(3, 3, 14, 0, 0) >> 7 => {
                return crate::aarch64::timer::write(reg, rt, value)
            },
            _ if el == 0 => return Err(Exception::Undefined),
            r if r == key(3, 3, 13, 0, 3) => *tpidrro_el0 = value,
            r if r == key(3, 2, 0, 0, 0) => *csselr_el1 = value & 0x1F,
            r if r == key(3, 0, 1, 0, 0) => {
                *sctlr_el1 = value & !SCTLR_MTE;
                crate::aarch64::mmu::regime_changed();
            },
            r if r == key(3, 0, 1, 0, 1) => *actlr_el1 = value,
            r if r == key(3, 0, 1, 0, 2) => *cpacr_el1 = value & 3 << 20,
            r if r == key(3, 0, 2, 0, 0) => {
                *ttbr0_el1 = value;
                crate::aarch64::mmu::ttbr_changed();
            },
            r if r == key(3, 0, 2, 0, 1) => {
                *ttbr1_el1 = value;
                crate::aarch64::mmu::ttbr_changed();
            },
            r if r == key(3, 0, 2, 0, 2) => {
                *tcr_el1 = value;
                crate::aarch64::mmu::regime_changed();
            },
            // NZCV, SS, DAIF, M; PAN with FEAT_PAN; in profile v3 AArch32's
            // Q, IT and GE too, and IL (which v1 and v2 drop, as they always did)
            r if r == key(3, 0, 4, 0, 0) => {
                let a32 = if cpu::has_aarch32() {
                    (PSTATE_Q | PSTATE_IT | PSTATE_GE | PSTATE_IL) as u64
                }
                else {
                    0
                };
                *spsr_el1 =
                    value & (0xF060_03FF | a32 | if cpu::has_pan() { PSTATE_PAN as u64 } else { 0 })
            },
            r if r == key(3, 0, 4, 2, 3) && cpu::has_pan() => {
                set_pstate(get_pstate() & !PSTATE_PAN | value as u32 & PSTATE_PAN)
            },
            r if r == key(3, 0, 4, 0, 1) => *elr_el1 = value,
            r if r == key(3, 0, 4, 1, 0) => {
                if get_pstate() & PSTATE_SP == 0 {
                    return Err(Exception::Undefined);
                }
                cpu::set_sp_el(0, value)
            },
            r if r == key(3, 0, 4, 2, 0) => {
                set_pstate(get_pstate() & !PSTATE_SP | value as u32 & PSTATE_SP)
            },
            r if r == key(3, 0, 5, 1, 0) => *afsr0_el1 = value,
            r if r == key(3, 0, 5, 1, 1) => *afsr1_el1 = value,
            r if r == key(3, 0, 5, 2, 0) => *esr_el1 = value & 0xFFFF_FFFF,
            r if r == key(3, 0, 6, 0, 0) => *far_el1 = value,
            r if r == key(3, 0, 7, 4, 0) => *par_el1 = value,
            r if r == key(3, 0, 10, 2, 0) => {
                *mair_el1 = value;
                crate::aarch64::mmu::regime_changed();
            },
            r if r == key(3, 0, 10, 3, 0) => *amair_el1 = value,
            r if r == key(3, 0, 12, 0, 0) => *vbar_el1 = value & !0x7FF,
            r if r == key(3, 0, 13, 0, 1) => {
                *contextidr_el1 = value & 0xFFFF_FFFF;
            },
            r if r == key(3, 0, 13, 0, 4) => *tpidr_el1 = value,
            r if r == key(3, 0, 14, 1, 0) => *cntkctl_el1 = value & 0x3FF,
            r if crate::aarch64::gic::is_icc(r) => return crate::aarch64::gic::icc_write(r, value),
            r if r >> 14 == 2 => return crate::aarch64::debug::write(r, rt, value),
            _ => return Err(Exception::Undefined),
        }
    }
    Ok(())
}

/// MSR (immediate): SPSel (0), DAIFSet (1), DAIFClr (2), PAN (3, FEAT_PAN)
pub fn write_pstate_field(field: u8, imm: u32) -> Result<(), Exception> {
    let el = cpu::el();
    match field {
        0 => {
            if el == 0 {
                return Err(Exception::Undefined);
            }
            set_pstate(get_pstate() & !PSTATE_SP | imm & 1);
        },
        3 => {
            if el == 0 || !cpu::has_pan() {
                return Err(Exception::Undefined);
            }
            set_pstate(get_pstate() & !PSTATE_PAN | if imm & 1 != 0 { PSTATE_PAN } else { 0 });
        },
        _ => {
            if el == 0 && cpu::sctlr() & SCTLR_UMA == 0 {
                // (the trap reports the instruction's own encoding: op0 0, op1 3, CRn 4, CRm the
                // immediate, op2 6 for DAIFSet and 7 for DAIFClr, Rt 31; the reference swaps op1 and op2)
                let op2 = if field == 1 { 6 } else { 7 };
                let reg = key(0, 3, 4, imm & 15, op2);
                return Err(Exception::SystemRegister(trap_iss(reg, 31, false)));
            }
            let bits = (imm & 0xF) << 6;
            if field == 1 {
                set_pstate(get_pstate() | bits);
            }
            else {
                set_pstate(get_pstate() & !bits);
            }
        },
    }
    Ok(())
}

/// SYS: a cache, TLB or address translation operation (`op` = op1:CRn:CRm:op2)
pub fn sys(op: u32, rt: u32) -> Result<(), Exception> {
    let el = cpu::el();
    let op1 = op >> 11 & 7;
    let crn = op >> 7 & 15;
    let crm = op >> 3 & 15;
    let op2 = op & 7;
    let reg = 1 << 14 | op;
    let trap = |enabled: bool| {
        if el == 0 && !enabled {
            Err(Exception::SystemRegister(trap_iss(reg, rt, false)))
        }
        else {
            Ok(())
        }
    };
    let value = cpu::xr(rt);
    match (op1, crn, crm, op2) {
        // instruction cache: v86 needs none of it (code retires on writes);
        // with cores in workers the inner shareable ones make the next DSB
        // wait until the others took the code invalidations (P8.3)
        (0, 7, 1, 0) | (0, 7, 5, 0) => {
            if el == 0 {
                return Err(Exception::Undefined);
            }
            if crm == 1 {
                crate::aarch64::tlb::post_code();
            }
        },
        (3, 7, 5, 1) => {
            trap(cpu::sctlr() & SCTLR_UCI != 0)?;
            crate::aarch64::mmu::check_cache_maintenance(value)?;
            crate::aarch64::tlb::post_code();
        },
        // data cache by VA: checked as a read (a translation or permission fault), no effect
        (0, 7, 6, 1) => {
            if el == 0 {
                return Err(Exception::Undefined);
            }
            crate::aarch64::mmu::check_cache_maintenance(value)?;
        },
        (3, 7, 10, 1) | (3, 7, 11, 1) | (3, 7, 14, 1) => {
            trap(cpu::sctlr() & SCTLR_UCI != 0)?;
            crate::aarch64::mmu::check_cache_maintenance(value)?;
        },
        // by set/way
        (0, 7, 6, 2) | (0, 7, 10, 2) | (0, 7, 14, 2) => {
            if el == 0 {
                return Err(Exception::Undefined);
            }
        },
        (3, 7, 4, 1) => {
            trap(cpu::sctlr() & SCTLR_DZE != 0)?;
            crate::aarch64::execute::dc_zva(value, rt)?;
        },
        // address translation (P3.4)
        (0, 7, 8, 0..=3) => {
            if el == 0 {
                return Err(Exception::Undefined);
            }
            crate::aarch64::mmu::address_translate(op2, value)?;
        },
        // TLB maintenance (P3.4)
        (0, 8, 3, 0..=3)
        | (0, 8, 3, 5)
        | (0, 8, 3, 7)
        | (0, 8, 7, 0..=3)
        | (0, 8, 7, 5)
        | (0, 8, 7, 7) => {
            if el == 0 {
                return Err(Exception::Undefined);
            }
            crate::aarch64::mmu::tlbi(crm == 3, op2, value);
        },
        _ => return Err(Exception::Undefined),
    }
    Ok(())
}
