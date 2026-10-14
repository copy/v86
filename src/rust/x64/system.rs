//! Long-mode control state and privileged instruction semantics.
use super::state::{EFER_LMA, EFER_LME, EFER_NXE, EFER_SCE};
use super::{
    decode::Decoded,
    memory::{self, Fault},
    state,
};
use crate::cpu::{cpu, global_pointers as gp, xstate};

const PE: u64 = 1;
const PG: u64 = 1 << 31;
const PAE: u64 = 1 << 5;
const CR0_VALID: u64 = 0xE005_003F;
/// The bits of CR0 and CR4 that translations depend on: PE, WP, PG; PSE, PAE, PGE
const TRANSLATION_CR0: u64 = PE | 1 << 16 | PG;
const TRANSLATION_CR4: u64 = 1 << 4 | PAE | 1 << 7;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ControlState {
    pub cr0: u64,
    pub cr3: u64,
    pub cr4: u64,
    pub efer: u64,
    pub cs_long: bool,
}
impl ControlState {
    pub fn write_cr(&mut self, index: usize, value: u64) -> Result<(), Fault> {
        match index {
            0 => {
                if value & !CR0_VALID != 0
                    || value & PG != 0 && value & PE == 0
                    || value & (1 << 29) != 0 && value & (1 << 30) == 0
                    || self.cs_long && value & PG == 0
                {
                    return Err(Fault::gp());
                }
                if self.cr0 & PG == 0 && value & PG != 0 && self.efer & EFER_LME != 0 {
                    if self.cr4 & PAE == 0 || self.cs_long {
                        return Err(Fault::gp());
                    }
                    self.efer |= EFER_LMA;
                }
                if value & PG == 0 {
                    self.efer &= !EFER_LMA;
                }
                self.cr0 = value | 0x10;
            },
            3 => {
                if value >> 36 != 0 {
                    return Err(Fault::gp());
                }
                self.cr3 = value & !0xFE7;
            },
            4 => {
                if value & !(cpu::cr4_valid_bits() as u64) != 0
                    || self.efer & EFER_LMA != 0 && value & PAE == 0
                {
                    return Err(Fault::gp());
                }
                self.cr4 = value;
            },
            _ => return Err(Fault::ud()),
        }
        Ok(())
    }
    pub fn write_efer(&mut self, value: u64) -> Result<(), Fault> {
        if value & !(EFER_SCE | EFER_LME | EFER_LMA | EFER_NXE) != 0
            || self.cr0 & PG != 0 && (value ^ self.efer) & EFER_LME != 0
        {
            return Err(Fault::gp());
        }
        self.efer = value & !EFER_LMA | self.efer & EFER_LMA;
        Ok(())
    }
}
pub unsafe fn controls() -> ControlState {
    ControlState {
        cr0: state::read_cr(0),
        cr3: state::read_cr(3),
        cr4: state::read_cr(4),
        efer: state::efer(),
        cs_long: *gp::x64_cs_long != 0,
    }
}
pub unsafe fn write_cr(index: usize, value: u64) -> Result<(), Fault> {
    if *gp::cpl != 0 {
        return Err(Fault::gp());
    }
    if index == 2 {
        state::write_cr_raw(2, value);
        return Ok(());
    }
    if index == 8 {
        if value & !15 != 0 {
            return Err(Fault::gp());
        }
        state::write_cr_raw(8, value);
        crate::cpu::apic::write32(0x80, (value << 4) as u32);
        return Ok(());
    }
    use crate::x64::pages::{COUNTERS, COUNT_CR0_WRITES, COUNT_CR_WRITES, COUNT_FULL_FLUSHES};
    COUNTERS[COUNT_CR_WRITES] += 1;
    // (CR0, CR3, CR4)
    let counter = match index {
        0 => COUNT_CR0_WRITES,
        3 => COUNT_CR0_WRITES + 1,
        _ => COUNT_CR0_WRITES + 2,
    };
    COUNTERS[counter] += 1;
    let old = controls();
    let mut c = controls();
    c.write_cr(index, value)?;
    if (c.cr0 ^ old.cr0) & 8 != 0 {
        crate::step_profile::note_event(crate::step_profile::event::CR0_TS, 0);
    }
    state::write_cr_raw(0, c.cr0);
    state::write_cr_raw(3, c.cr3);
    state::write_cr_raw(4, c.cr4);
    state::set_efer_raw(c.efer);
    *gp::protected_mode = c.cr0 & PE != 0;
    // MOV CR3 with CR4.PGE (and no PCID) keeps global translations
    if index == 3
        && c.cr0 == old.cr0
        && c.cr4 == old.cr4
        && c.efer == old.efer
        && c.cr4 & 0x80 != 0
        && c.cr4 & 0x20000 == 0
    {
        crate::x64::pages::COUNTERS[crate::x64::pages::COUNT_CR3_KEEP_GLOBAL] += 1;
        cpu::clear_tlb();
        memory::invalidate_core_nonglobal(crate::cpu::apic::current_core());
    }
    // CR0 and CR4 writes that change no bit translations depend on (CR0.TS,
    // for one): nothing to flush, as on hardware
    else if index != 3
        && (c.cr0 ^ old.cr0) & TRANSLATION_CR0 == 0
        && (c.cr4 ^ old.cr4) & TRANSLATION_CR4 == 0
        && c.efer == old.efer
    {
    }
    else {
        COUNTERS[COUNT_FULL_FLUSHES] += 1;
        cpu::full_clear_tlb();
        memory::invalidate_core(crate::cpu::apic::current_core());
    }
    crate::ir::runtime::entry::ir_admission_barrier();
    Ok(())
}
pub unsafe fn write_msr(index: u32, value: u64) -> Result<bool, Fault> {
    if *gp::cpl != 0 {
        return Err(Fault::gp());
    }
    match index {
        0xC0000080 => {
            let mut c = controls();
            c.write_efer(value)?;
            state::set_efer_raw(c.efer);
            memory::invalidate_core(crate::cpu::apic::current_core());
            cpu::full_clear_tlb();
        },
        0xC0000081 => *gp::x64_star = value,
        0xC0000082 | 0xC0000083 => {
            if !state::canonical(value, 48) {
                return Err(Fault::gp());
            }
            if index == 0xC0000082 {
                *gp::x64_lstar = value;
            }
            else {
                *gp::x64_cstar = value;
            } // Intel compat SYSCALL remains #UD
        },
        0xC0000084 => *gp::x64_sfmask = value as u32 as u64,
        0xC0000103 => {
            if value >> 32 != 0 {
                return Err(Fault::gp());
            }
            *gp::x64_tsc_aux = value as u32;
        },
        0xC0000100..=0xC0000102 => {
            if !state::canonical(value, 48) {
                return Err(Fault::gp());
            }
            if index == 0xC0000102 {
                *gp::x64_kernel_gs_base = value;
            }
            else {
                state::write_segment_base(if index == 0xC0000100 { 4 } else { 5 }, value);
            }
        },
        0x174 => *gp::sysenter_cs = value as i32 & 65535,
        0x175 | 0x176 => {
            if !state::canonical(value, 48) {
                return Err(Fault::gp());
            }
            if index == 0x175 {
                *gp::sysenter_esp = value as i32;
                *gp::x64_sysenter_esp_hi = (value >> 32) as u32;
            }
            else {
                *gp::sysenter_eip = value as i32;
                *gp::x64_sysenter_eip_hi = (value >> 32) as u32;
            }
        },
        0x8B => {}, // no microcode revision; CPUID leaves the signature zero
        0x10 => cpu::set_tsc(value as u32, (value >> 32) as u32),
        0x1B => {
            // xAPIC only: the address and BSP bit are fixed by the machine.
            if value & !0x900 != 0xFEE00000 {
                return Err(Fault::gp());
            }
            let enabled = value & 0x800 != 0;
            if *gp::apic_enabled && !enabled {
                crate::cpu::apic::software_disable();
            }
            *gp::apic_enabled = enabled;
            crate::cpu::apic::apic_set_hardware_enabled(
                crate::cpu::apic::current_core() as u32,
                enabled,
            );
        },
        // read-only
        0x10A if crate::cpu::instructions_0f::arch_capabilities().is_some() => {
            return Err(Fault::gp())
        },
        _ => return Ok(false),
    }
    Ok(true)
}
pub unsafe fn read_msr(index: u32) -> Result<Option<u64>, Fault> {
    if *gp::cpl != 0 {
        return Err(Fault::gp());
    }
    Ok(Some(match index {
        0xC0000080 => state::efer(),
        0xC0000081 => *gp::x64_star,
        0xC0000082 => *gp::x64_lstar,
        0xC0000083 => *gp::x64_cstar,
        0xC0000084 => *gp::x64_sfmask,
        0xC0000100 => state::read_segment_base(4),
        0xC0000101 => state::read_segment_base(5),
        0xC0000102 => *gp::x64_kernel_gs_base,
        0xC0000103 => *gp::x64_tsc_aux as u64,
        0x174 => *gp::sysenter_cs as u32 as u64,
        0x175 => *gp::sysenter_esp as u32 as u64 | (*gp::x64_sysenter_esp_hi as u64) << 32,
        0x176 => *gp::sysenter_eip as u32 as u64 | (*gp::x64_sysenter_eip_hi as u64) << 32,
        0x8B => 0,
        0x10 => cpu::read_tsc(),
        0x1B => {
            0xFEE00000
                | if *gp::apic_enabled { 0x800 } else { 0 }
                | if crate::cpu::apic::current_core() == 0 { 0x100 } else { 0 }
        },
        0x10A => match crate::cpu::instructions_0f::arch_capabilities() {
            Some(value) => value,
            None => return Ok(None),
        },
        _ => return Ok(None),
    }))
}

/// System opcodes used by the wide interpreter. Returning false means that
/// the instruction belongs to another executor, never silently succeeds.
pub unsafe fn execute(instruction: &Decoded) -> Result<bool, Fault> {
    let op = instruction.base_opcode();
    match op {
        0x0F00 => descriptor_instruction(instruction)?,
        0x0F02 | 0x0F03 => query_descriptor(instruction)?,
        0x0F21 | 0x0F23 => debug_register(instruction)?,
        0x0FA0 | 0x0FA1 | 0x0FA8 | 0x0FA9 => {
            let segment = if op & 8 == 0 { 4 } else { 5 };
            let width = if instruction.operand_size == 16 { 16 } else { 64 };
            let rsp = state::read_gpr(4);
            if op & 1 == 0 {
                let next = rsp.wrapping_sub((width / 8) as u64);
                memory::write(next, width, *gp::sreg.add(segment) as u64, true)?;
                state::write_gpr(4, next, 64);
            }
            else {
                let selector = memory::read(rsp, width, true)? as u16;
                load_segment(segment, selector)?;
                state::write_gpr(4, rsp.wrapping_add((width / 8) as u64), 64);
            }
        },
        0x0F01 => table_instruction(instruction)?,
        0x0F05 | 0x0F07 | 0x0F34 | 0x0F35 => {
            fast_call(op, instruction.operand_size == 64, instruction.next.0)?;
            return Ok(true);
        },
        0xCA | 0xCB => {
            far_return(
                instruction.operand_size,
                instruction.immediate.map_or(0, |value| value.value as u16),
            )?;
            return Ok(true);
        },
        0xFF if matches!(instruction.modrm.map(|m| m >> 3 & 7), Some(3 | 5)) => {
            far_transfer(instruction, instruction.modrm.unwrap() >> 3 & 7 == 3)?;
            return Ok(true);
        },
        0x0F06 => {
            if *gp::cpl != 0 {
                return Err(Fault::gp());
            }
            crate::step_profile::note_event(crate::step_profile::event::CLTS, 0);
            state::write_cr_raw(0, state::read_cr(0) & !8);
        },
        0x0F08 | 0x0F09 => {
            if *gp::cpl != 0 {
                return Err(Fault::gp());
            }
        },
        0x8C | 0x8E => {
            let segment = (instruction.modrm.ok_or(Fault::ud())? >> 3 & 7) as usize;
            if segment >= 6 || op == 0x8E && segment == 1 {
                return Err(Fault::ud());
            }
            if op == 0x8E {
                load_segment(segment, read_rm(instruction, 16)? as u16)?;
            }
            else {
                write_rm(
                    instruction,
                    if instruction.rm_register.is_some() { instruction.operand_size } else { 16 },
                    *gp::sreg.add(segment) as u64,
                )?;
            }
        },
        0xCC | 0xCD => {
            let vector =
                if op == 0xCC { 3 } else { instruction.immediate.ok_or(Fault::ud())?.value as i32 };
            state::write_rip(instruction.next.0);
            crate::cpu::exceptions::interrupt(vector, true, None);
            return Ok(true);
        },
        0xCF => {
            iret(instruction.operand_size)?;
            return Ok(true);
        },
        0xF1 => {
            // INT1 (ICEBP): #DB as a trap, without the gate DPL check
            state::write_rip(instruction.next.0);
            crate::cpu::exceptions::interrupt(1, false, None);
            return Ok(true);
        },
        0x0FB2 | 0x0FB4 | 0x0FB5 => {
            // LSS/LFS/LGS m16:16/32/64
            let width = instruction.operand_size;
            let (addr, stack) = operand_address(instruction)?;
            let offset = memory::read(addr, width, stack)?;
            let selector = memory::read(addr.wrapping_add((width / 8) as u64), 16, stack)? as u16;
            let segment = match op {
                0x0FB2 => 2,
                0x0FB4 => 4,
                _ => 5,
            };
            load_segment(segment, selector)?;
            state::write_gpr(instruction.reg.ok_or(Fault::ud())? as usize, offset, width);
        },
        0xE4..=0xE7 | 0xEC..=0xEF => port_instruction(instruction)?,
        0xF4 => {
            if *gp::cpl != 0 {
                return Err(Fault::gp());
            }
            *gp::in_hlt = true;
            cpu::core_yield = true;
            crate::cpu::execution::note_halt();
        },
        0xFA | 0xFB => {
            if *gp::cpl as i32 > cpu::getiopl() {
                return Err(Fault::gp());
            }
            if op == 0xFA {
                *gp::flags &= !cpu::FLAG_INTERRUPT;
            }
            else {
                *gp::flags |= cpu::FLAG_INTERRUPT;
                *gp::interrupt_shadow = 2;
            }
        },
        0x0F20 | 0x0F22 => {
            // an undefined control register is #UD before the privilege #GP
            let control = instruction.reg.ok_or(Fault::ud())? as usize;
            let register = instruction.rm_register.ok_or(Fault::ud())? as usize;
            if !matches!(control, 0 | 2 | 3 | 4 | 8) {
                return Err(Fault::ud());
            }
            if *gp::cpl != 0 {
                return Err(Fault::gp());
            }
            if op == 0x0F22 {
                write_cr(control, state::read_gpr(register))?;
            }
            else {
                state::write_gpr(register, state::read_cr(control), 64);
            }
        },
        0x0F30 => {
            let index = state::read_gpr(1) as u32;
            let value = state::read_gpr(0) as u32 as u64 | (state::read_gpr(2) as u32 as u64) << 32;
            // then the model's other MSRs (e.g. IA32_PLATFORM_ID, MISC_ENABLE)
            if !write_msr(index, value)?
                && crate::cpu::instructions_0f::write_msr_table(
                    index as i32,
                    value as i32,
                    (value >> 32) as i32,
                ) != Ok(true)
            {
                return Err(Fault::gp());
            }
        },
        0x0F32 => {
            let index = state::read_gpr(1) as u32;
            let value = match read_msr(index)? {
                Some(value) => value,
                None => crate::cpu::instructions_0f::read_msr_table(index as i32)
                    .map(|(low, high)| low as u32 as u64 | (high as u32 as u64) << 32)
                    .ok_or(Fault::gp())?,
            };
            state::write_gpr(0, value, 32);
            state::write_gpr(2, value >> 32, 32);
        },
        0x0F31 => {
            if *gp::cpl != 0 && state::read_cr(4) & 4 != 0 {
                return Err(Fault::gp());
            }
            let value = cpu::read_tsc();
            state::write_gpr(0, value, 32);
            state::write_gpr(2, value >> 32, 32);
        },
        0x0FAA => {
            // RSM (a 64-bit SMM handler's)
            if !crate::cpu::smm::smm_active() {
                return Err(Fault::ud());
            }
            crate::cpu::smm::rsm();
            return Ok(true);
        },
        0x0FA2 => {
            crate::cpu::instructions_0f::instr_0FA2();
            for r in 0..4 {
                state::write_gpr(r, state::read_gpr(r), 32);
            }
        },
        _ => return Ok(false),
    }
    state::write_rip(instruction.next.0);
    Ok(true)
}

unsafe fn operand_address(d: &Decoded) -> Result<(u64, bool), Fault> {
    let expr = d.address.ok_or(Fault::ud())?;
    let mut regs = [0; 16];
    for (index, value) in regs.iter_mut().enumerate() {
        *value = state::read_gpr(index);
    }
    let base = if expr.segment >= 4 { state::read_segment_base(expr.segment as usize) } else { 0 };
    Ok((
        expr.offset(&regs, d.next).wrapping_add(base),
        expr.segment == 2,
    ))
}
unsafe fn read_rm(d: &Decoded, width: u8) -> Result<u64, Fault> {
    if let Some(reg) = d.rm_register {
        Ok(state::read_gpr(reg as usize))
    }
    else {
        let (addr, stack) = operand_address(d)?;
        memory::read(addr, width, stack)
    }
}
unsafe fn write_rm(d: &Decoded, width: u8, value: u64) -> Result<(), Fault> {
    if let Some(reg) = d.rm_register {
        state::write_gpr(reg as usize, value, width);
        Ok(())
    }
    else {
        let (addr, stack) = operand_address(d)?;
        memory::write(addr, width, value, stack)
    }
}

/// Fast entry/exit instructions install architectural fixed segment caches;
/// they deliberately do not consult the descriptor tables.
unsafe fn flat_segments(cs: u16, ss: u16, privilege: u8, long: bool) {
    *gp::sreg.add(1) = cs & !3 | privilege as u16;
    *gp::sreg.add(2) = ss & !3 | privilege as u16;
    for segment in [1, 2] {
        *gp::segment_is_null.add(segment) = false;
        *gp::segment_limits.add(segment) = u32::MAX;
        *gp::segment_access_bytes.add(segment) =
            (if segment == 1 { 0x9B } else { 0x93 }) | privilege << 5;
        state::write_segment_base(segment, 0);
    }
    *gp::x64_cs_long = long as u8;
    *gp::is_32 = !long;
    *gp::stack_size_32 = true;
    *gp::cpl = privilege;
    cpu::update_state_flags();
    cpu::cpl_changed();
    crate::ir::runtime::entry::ir_admission_barrier();
}
pub unsafe fn fast_call(op: u32, wide: bool, next: u64) -> Result<(), Fault> {
    match op {
        0x0F05 | 0x0F07 => {
            if !state::mode().is_long() || state::efer() & EFER_SCE == 0 {
                return Err(Fault::ud());
            }
            if op == 0x0F05 {
                let target = *gp::x64_lstar;
                if !state::canonical(target, 48) {
                    return Err(Fault::gp());
                }
                state::write_gpr(1, next, 64);
                state::write_gpr(11, state::read_flags64(), 64);
                state::write_flags64(state::read_flags64() & !*gp::x64_sfmask);
                let cs = (*gp::x64_star >> 32) as u16 & !3;
                flat_segments(cs, cs.wrapping_add(8), 0, true);
                state::write_rip(target);
            }
            else {
                if *gp::cpl != 0 {
                    return Err(Fault::gp());
                }
                let target =
                    if wide { state::read_gpr(1) } else { state::read_gpr(1) as u32 as u64 };
                if !state::canonical(target, 48) {
                    return Err(Fault::gp());
                }
                let selectors = (*gp::x64_star >> 48) as u16;
                let flags = state::read_gpr(11) & 0x3C7FD7 | 2;
                flat_segments(
                    selectors.wrapping_add(if wide { 16 } else { 0 }),
                    selectors.wrapping_add(8),
                    3,
                    wide,
                );
                state::write_flags64(flags);
                state::write_rip(target);
            }
        },
        0x0F34 => {
            let cs = *gp::sysenter_cs as u16 & !3;
            if cs == 0 || state::read_cr(0) & PE == 0 {
                return Err(Fault::gp());
            }
            let ip = *gp::sysenter_eip as u32 as u64 | (*gp::x64_sysenter_eip_hi as u64) << 32;
            let sp = *gp::sysenter_esp as u32 as u64 | (*gp::x64_sysenter_esp_hi as u64) << 32;
            if !state::canonical(ip, 48) || !state::canonical(sp, 48) {
                return Err(Fault::gp());
            }
            state::write_flags64(state::read_flags64() & !0x20200);
            flat_segments(cs, cs.wrapping_add(8), 0, true);
            state::write_gpr(4, sp, 64);
            state::write_rip(ip);
        },
        0x0F35 => {
            let cs = *gp::sysenter_cs as u16 & !3;
            if cs == 0 || *gp::cpl != 0 || state::read_cr(0) & PE == 0 {
                return Err(Fault::gp());
            }
            let ip = if wide { state::read_gpr(2) } else { state::read_gpr(2) as u32 as u64 };
            let sp = if wide { state::read_gpr(1) } else { state::read_gpr(1) as u32 as u64 };
            if !state::canonical(ip, 48) || !state::canonical(sp, 48) {
                return Err(Fault::gp());
            }
            let target_cs = cs.wrapping_add(if wide { 32 } else { 16 });
            // The full RSP is cleared for a compatibility return too.
            state::write_gpr(4, sp, 64);
            flat_segments(target_cs, target_cs.wrapping_add(8), 3, wide);
            state::write_rip(ip);
        },
        _ => unreachable!(),
    }
    Ok(())
}

unsafe fn load_segment(segment: usize, selector: u16) -> Result<(), Fault> {
    let privilege = *gp::cpl;
    let stack = segment == 2;
    if selector & !3 == 0 {
        if stack && (privilege == 3 || selector as u8 & 3 != privilege) {
            return Err(Fault::gp());
        }
        *gp::sreg.add(segment) = selector;
        *gp::segment_is_null.add(segment) = !stack;
        state::write_segment_base(segment, 0);
    }
    else {
        let (desc, at) = descriptor(selector)?;
        let error = selector as u32 & !3;
        if desc.is_system()
            || if stack {
                !desc.is_writable() || desc.dpl() != privilege || selector as u8 & 3 != privilege
            }
            else {
                !desc.is_readable()
                    || !desc.is_conforming_executable()
                        && (privilege > desc.dpl() || selector as u8 & 3 > desc.dpl())
            }
        {
            return Err(exception(13, error));
        }
        if !desc.is_present() {
            return Err(exception(if stack { 12 } else { 11 }, error));
        }
        if !desc.accessed() {
            memory::write_system(at.wrapping_add(5), 8, (desc.access_byte() | 1) as u64)?;
        }
        *gp::sreg.add(segment) = selector;
        *gp::segment_is_null.add(segment) = false;
        *gp::segment_access_bytes.add(segment) = desc.access_byte() | 1;
        *gp::segment_limits.add(segment) = desc.effective_limit();
        state::write_segment_base(segment, desc.base() as u32 as u64);
        if stack {
            *gp::stack_size_32 = desc.is_32();
        }
    }
    if stack {
        *gp::interrupt_shadow = 2;
    }
    cpu::update_state_flags();
    Ok(())
}

// MOV DR uses the complete address width in long mode. The GD condition is
// a fault: leave the GPR/RIP unchanged and clear GD before delivering #DB.
unsafe fn debug_register(d: &Decoded) -> Result<(), Fault> {
    let mut index = d.reg.ok_or(Fault::ud())? as usize;
    let register = d.rm_register.ok_or(Fault::ud())? as usize;
    if index >= 8 || matches!(index, 4 | 5) && state::read_cr(4) & 8 != 0 {
        return Err(Fault::ud());
    }
    if *gp::cpl != 0 {
        return Err(Fault::gp());
    }
    if state::read_dr(7) & 0x2000 != 0 {
        state::write_dr(7, state::read_dr(7) & !0x2000);
        state::write_dr(6, state::read_dr(6) | 0x2000);
        return Err(Fault {
            vector: 1,
            error: None,
            address: None,
        });
    }
    if index == 4 || index == 5 {
        index += 2;
    }
    if d.base_opcode() == 0x0F21 {
        state::write_gpr(register, state::read_dr(index), 64);
    }
    else {
        let mut value = state::read_gpr(register);
        if index >= 6 && value >> 32 != 0 {
            return Err(Fault::gp());
        }
        if index == 6 {
            value = value & 0xE00F | 0xFFFF0FF0;
        }
        if index == 7 {
            value = value & !0xD800 | 0x400;
        }
        state::write_dr(index, value);
    }
    Ok(())
}

// LAR/LSL/VERR/VERW reject an inaccessible selector by clearing ZF. Only
// faults while actually reading a descriptor propagate as exceptions.
unsafe fn visible_descriptor(selector: u16) -> Result<Option<cpu::SegmentDescriptor>, Fault> {
    if selector & !3 == 0 {
        return Ok(None);
    }
    let local = selector & 4 != 0;
    if local && *gp::segment_is_null.add(7) {
        return Ok(None);
    }
    let limit = if local { *gp::segment_limits.add(7) } else { *gp::gdtr_size as u32 };
    if (selector as u32 & !7) + 7 > limit {
        return Ok(None);
    }
    let (desc, _) = descriptor(selector)?;
    if !(desc.is_executable() && !desc.is_system() && desc.is_dc())
        && desc.dpl() < (*gp::cpl).max((selector & 3) as u8)
    {
        return Ok(None);
    }
    Ok(Some(desc))
}
unsafe fn query_descriptor(d: &Decoded) -> Result<(), Fault> {
    let selector = read_rm(d, 16)? as u16;
    let desc = visible_descriptor(selector)?;
    let limit = d.base_opcode() == 0x0F03;
    let valid = desc.as_ref().is_some_and(|v| {
        !v.is_system()
            || if limit {
                matches!(v.system_type(), 2 | 9 | 11)
            }
            else {
                matches!(v.system_type(), 2 | 9 | 11 | 12)
            }
    });
    let flags = state::read_flags64() & !0x40;
    if valid {
        let v = desc.unwrap();
        let value = if limit { v.effective_limit() as u64 } else { v.raw >> 32 & 0x00F0FF00 };
        state::write_gpr(d.reg.ok_or(Fault::ud())? as usize, value, d.operand_size);
    }
    state::write_flags64(flags | if valid { 0x40 } else { 0 });
    Ok(())
}

unsafe fn descriptor_instruction(d: &Decoded) -> Result<(), Fault> {
    let group = d.modrm.ok_or(Fault::ud())? >> 3 & 7;
    if group <= 1 {
        return write_rm(
            d,
            if d.rm_register.is_some() { d.operand_size } else { 16 },
            *gp::sreg.add(if group == 0 { 7 } else { 6 }) as u64,
        );
    }
    if matches!(group, 4 | 5) {
        let desc = visible_descriptor(read_rm(d, 16)? as u16)?;
        let valid = desc.is_some_and(|v| {
            !v.is_system()
                && if group == 5 {
                    !v.is_executable() && v.is_writable()
                }
                else {
                    !v.is_executable() || v.is_readable()
                }
        });
        state::write_flags64(state::read_flags64() & !0x40 | if valid { 0x40 } else { 0 });
        return Ok(());
    }
    if !matches!(group, 2 | 3) {
        return Err(Fault::ud());
    }
    if *gp::cpl != 0 {
        return Err(Fault::gp());
    }
    let selector = read_rm(d, 16)? as u16;
    let target = if group == 2 { 7 } else { 6 };
    if selector & !3 == 0 {
        if group == 3 {
            return Err(Fault::gp());
        }
        *gp::sreg.add(target) = selector;
        *gp::segment_is_null.add(target) = true;
        return Ok(());
    }
    let error = selector as u32 & !3;
    if selector & 4 != 0 || (selector as u32 & !7) + 15 > *gp::gdtr_size as u32 {
        return Err(exception(13, error));
    }
    let (desc, at) = descriptor(selector)?;
    let high = memory::read_system(at.wrapping_add(8), 64)?;
    if !desc.is_system()
        || desc.access_byte() & 15 != if group == 2 { 2 } else { 9 }
        || high >> 32 != 0
    {
        return Err(exception(13, error));
    }
    if !desc.is_present() {
        return Err(exception(11, error));
    }
    let base = desc.base() as u32 as u64 | high << 32;
    if !state::canonical(base, 48) {
        return Err(exception(13, error));
    }
    if group == 3 {
        memory::write_system(at.wrapping_add(5), 8, (desc.access_byte() | 2) as u64)?;
    }
    *gp::sreg.add(target) = selector;
    *gp::segment_is_null.add(target) = false;
    *gp::segment_access_bytes.add(target) = desc.access_byte() | if group == 3 { 2 } else { 0 };
    *gp::segment_limits.add(target) = desc.effective_limit();
    state::write_segment_base(target, base);
    Ok(())
}

/// XGETBV and XSETBV (cpu::xstate): #UD without CR4.OSXSAVE, then #GP(0)
unsafe fn xgetbv_xsetbv(set: bool, long: bool) -> Result<(), Fault> {
    if !xstate::enabled() {
        return Err(Fault::ud());
    }
    let index = state::read_gpr(1) as u32;
    if !set {
        let value = xstate::xgetbv(index, long).ok_or(Fault::gp())?;
        state::write_gpr(0, value & 0xFFFF_FFFF, 32);
        state::write_gpr(2, value >> 32, 32);
        return Ok(());
    }
    let value = state::read_gpr(2) << 32 | state::read_gpr(0) & 0xFFFF_FFFF;
    if *gp::cpl != 0 || !xstate::xsetbv(index, value) {
        return Err(Fault::gp());
    }
    Ok(())
}
unsafe fn table_instruction(d: &Decoded) -> Result<(), Fault> {
    let modrm = d.modrm.ok_or(Fault::ud())?;
    // XGETBV, XSETBV: without a mandatory prefix
    if matches!(modrm, 0xD0 | 0xD1) && !d.prefixes.operand && d.prefixes.rep.is_none() {
        return xgetbv_xsetbv(modrm == 0xD1, d.mode.is_long());
    }
    // Register forms outside SMSW/LMSW/SWAPGS/RDTSCP belong to extensions
    // this profile lacks (VMX, SVM, MONITOR, SMAP, ...): #UD before any
    // privilege check. So is /5 on memory (RSTORSSP).
    let group = modrm >> 3 & 7;
    if modrm >= 0xC0 && !matches!(group, 4 | 6) && !matches!(modrm, 0xF8 | 0xF9)
        || modrm < 0xC0 && group == 5
    {
        return Err(Fault::ud());
    }
    if modrm == 0xF8 {
        if *gp::cpl != 0 {
            return Err(Fault::gp());
        }
        let old = state::read_segment_base(5);
        state::write_segment_base(5, *gp::x64_kernel_gs_base);
        *gp::x64_kernel_gs_base = old;
        return Ok(());
    }
    if modrm == 0xF9 {
        if *gp::cpl != 0 && state::read_cr(4) & 4 != 0 {
            return Err(Fault::gp());
        }
        let time = cpu::read_tsc();
        state::write_gpr(0, time, 32);
        state::write_gpr(2, time >> 32, 32);
        state::write_gpr(1, *gp::x64_tsc_aux as u64, 32);
        return Ok(());
    }
    let group = modrm >> 3 & 7;
    if group == 4 {
        return write_rm(
            d,
            if d.rm_register.is_some() { d.operand_size } else { 16 },
            state::read_cr(0) & 65535,
        );
    }
    if group >= 2 && *gp::cpl != 0 {
        return Err(Fault::gp());
    }
    if group == 6 {
        let value = read_rm(d, 16)?;
        return write_cr(0, state::read_cr(0) & !14 | value & 15);
    }
    let (addr, stack) = operand_address(d)?;
    match group {
        0 | 1 => {
            memory::probe_write(addr, 16, stack)?;
            memory::probe_write(addr.wrapping_add(2), 64, stack)?;
            memory::write(
                addr,
                16,
                if group == 0 { *gp::gdtr_size } else { *gp::idtr_size } as u64,
                stack,
            )?;
            memory::write(
                addr.wrapping_add(2),
                64,
                if group == 0 { state::read_gdtr_base() } else { state::read_idtr_base() },
                stack,
            )?;
        },
        2 | 3 => {
            let limit = memory::read(addr, 16, stack)? as i32;
            let base = memory::read(addr.wrapping_add(2), 64, stack)?;
            if !state::canonical(base, 48) {
                return Err(Fault::gp());
            }
            if group == 2 {
                *gp::gdtr_size = limit;
                state::write_gdtr_base(base);
            }
            else {
                *gp::idtr_size = limit;
                state::write_idtr_base(base);
            }
        },
        7 => {
            // Intel defines a noncanonical INVLPG operand as a no-op.
            if state::canonical(addr, 48) {
                memory::invlpg(addr);
                cpu::invlpg(addr as i32);
            }
        },
        _ => return Err(Fault::ud()),
    }
    Ok(())
}

pub unsafe fn check_io_access(port: u16, width: u8) -> Result<(), Fault> {
    if port as i32 == cpu::VMWARE_BACKDOOR_PORT {
        return Ok(());
    }
    if *gp::cpl as i32 > cpu::getiopl() {
        if *gp::segment_is_null.add(6) || *gp::segment_limits.add(6) < 103 {
            return Err(Fault::gp());
        }
        let base = state::read_segment_base(6);
        let bitmap = memory::read_system(base.wrapping_add(102), 16)? as u32;
        for bit in port as u32..port as u32 + (width / 8) as u32 {
            let offset = bitmap + bit / 8;
            if offset > *gp::segment_limits.add(6)
                || memory::read_system(base.wrapping_add(offset as u64), 8)? & (1 << (bit & 7)) != 0
            {
                return Err(Fault::gp());
            }
        }
    }
    Ok(())
}

unsafe fn port_instruction(d: &Decoded) -> Result<(), Fault> {
    let op = d.base_opcode();
    let width = if op & 1 == 0 { 8 } else { d.operand_size.min(32) };
    let port = if op & 8 == 0 {
        d.immediate.ok_or(Fault::ud())?.value as u16
    }
    else {
        state::read_gpr(2) as u16
    };
    check_io_access(port, width)?;
    if op & 2 == 0 {
        let value = match width {
            8 => cpu::io_port_read8(port as i32),
            16 => cpu::io_port_read16(port as i32),
            _ => cpu::io_port_read32(port as i32),
        };
        state::write_gpr(0, value as u32 as u64, width);
    }
    else {
        let value = state::read_gpr(0) as i32;
        match width {
            8 => cpu::io_port_write8(port as i32, value & 255),
            16 => cpu::io_port_write16(port as i32, value & 65535),
            _ => cpu::io_port_write32(port as i32, value),
        }
    }
    super::debug::io(port as u16, (width / 8) as usize);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn initial() -> ControlState {
        ControlState {
            cr0: PE | 16,
            cr3: 0,
            cr4: 0,
            efer: 0,
            cs_long: false,
        }
    }
    #[test]
    fn long_mode_entry_exit_round_trip_and_rejected_transitions_are_atomic() {
        let mut state = initial();
        state.write_efer(EFER_LME | EFER_NXE | EFER_SCE).unwrap();
        let unchanged = state;
        assert_eq!(state.write_cr(0, PE | PG), Err(Fault::gp()));
        assert_eq!(state, unchanged);
        state.write_cr(4, PAE).unwrap();
        state.write_cr(3, 0xA_1234_5000).unwrap();
        state.write_cr(0, PE | PG).unwrap();
        assert_ne!(state.efer & EFER_LMA, 0);
        let unchanged = state;
        assert_eq!(state.write_cr(4, 0), Err(Fault::gp()));
        assert_eq!(state, unchanged);
        assert_eq!(state.write_efer(EFER_NXE), Err(Fault::gp()));
        assert_eq!(state, unchanged);
        state.cs_long = true;
        let unchanged = state;
        assert_eq!(state.write_cr(0, PE), Err(Fault::gp()));
        assert_eq!(state, unchanged);
        state.cs_long = false;
        state.write_cr(0, PE).unwrap();
        assert_eq!(state.efer & EFER_LMA, 0);
        state.write_efer(0).unwrap();
        state.write_cr(4, 0).unwrap();
    }
    #[test]
    fn reserved_control_bits_and_readonly_lma() {
        let mut state = initial();
        state.write_efer(EFER_LMA).unwrap();
        assert_eq!(state.efer, 0);
        for (register, value) in [
            (0, PG),
            (0, 1 << 29 | PE),
            (0, 1 << 32 | PE),
            (3, 1 << 36),
            (4, 1 << 12),
            (4, 1 << 17),
            (4, 1 << 18),
        ] {
            let unchanged = state;
            assert!(state.write_cr(register, value).is_err());
            assert_eq!(state, unchanged);
        }
        for bit in [1, 2, 9, 12, 63] {
            assert!(state.write_efer(1 << bit).is_err());
        }
    }
}

fn exception(vector: u8, code: u32) -> Fault {
    Fault {
        vector,
        error: Some(code),
        address: None,
    }
}
pub unsafe fn descriptor(selector: u16) -> Result<(cpu::SegmentDescriptor, u64), Fault> {
    if selector & !3 == 0 {
        return Err(Fault::gp());
    }
    let local = selector & 4 != 0;
    let base = if local { state::read_segment_base(7) } else { state::read_gdtr_base() };
    let limit = if local { *gp::segment_limits.add(7) } else { *gp::gdtr_size as u32 };
    let offset = selector as u32 & !7;
    if offset + 7 > limit {
        return Err(exception(13, selector as u32 & !3));
    }
    let address = base.wrapping_add(offset as u64);
    Ok((
        cpu::SegmentDescriptor::of_u64(memory::read_system(address, 64)?),
        address,
    ))
}
unsafe fn install_cs(selector: u16, descriptor: &cpu::SegmentDescriptor, privilege: u8) {
    *gp::sreg.add(1) = selector & !3 | privilege as u16;
    *gp::segment_is_null.add(1) = false;
    *gp::segment_access_bytes.add(1) = descriptor.access_byte();
    *gp::segment_limits.add(1) = descriptor.effective_limit();
    *gp::is_32 = descriptor.is_32();
    *gp::x64_cs_long = (descriptor.flags() & 2 != 0) as u8;
    state::write_segment_base(
        1,
        if *gp::x64_cs_long != 0 { 0 } else { descriptor.base() as u32 as u64 },
    );
    *gp::cpl = privilege;
    cpu::update_state_flags();
    *gp::last_virt_eip = -1;
    crate::ir::runtime::entry::ir_admission_barrier();
}
pub unsafe fn interrupt(vector: u8, software: bool, code: Option<u32>) -> Result<(), Fault> {
    let offset = vector as u32 * 16;
    let idt_error = (vector as u32) << 3 | 2;
    if offset + 15 > *gp::idtr_size as u32 {
        return Err(exception(13, idt_error));
    }
    let address = state::read_idtr_base().wrapping_add(offset as u64);
    let low = memory::read_system(address, 64)?;
    let high = memory::read_system(address.wrapping_add(8), 64)?;
    let access = (low >> 40) as u8;
    let kind = access & 15;
    if !matches!(kind, 14 | 15) || access & 16 != 0 || high >> 32 != 0 || low >> 32 & 0xF8 != 0 {
        return Err(exception(13, idt_error));
    }
    if software && *gp::cpl > (access >> 5 & 3) {
        return Err(exception(13, idt_error));
    }
    if access & 128 == 0 {
        return Err(exception(11, idt_error));
    }
    let selector = (low >> 16) as u16;
    let (cs, _) = descriptor(selector)?;
    if cs.is_system()
        || !cs.is_executable()
        || cs.dpl() > *gp::cpl
        || cs.flags() & 2 == 0
        || cs.is_32()
    {
        return Err(exception(13, selector as u32 & !3));
    }
    if !cs.is_present() {
        return Err(exception(11, selector as u32 & !3));
    }
    let target = low & 65535 | (low >> 48) << 16 | (high & 0xFFFF_FFFF) << 32;
    if !state::canonical(target, 48) {
        return Err(Fault::gp());
    }
    // (exceptions only: Windows also sends itself APC interrupts at vector 0x1F)
    if USER_TRACE_ENABLED
        && !software
        && matches!(vector, 0..=8 | 10..=14 | 16..=21)
        && *gp::cpl == 3
        && (*gp::x64_cs_long == 0 || vector != 14)
    {
        USER_TRACE[USER_TRACE_NEXT % USER_TRACE_LEN] = [
            vector as u64,
            code.map_or(u64::MAX, |c| c as u64),
            state::read_rip(),
            if vector == 14 { state::read_cr(2) } else { u64::MAX },
            state::read_gpr(4),
            *gp::sreg.add(1) as u64,
            state::read_cr(3),
        ];
        USER_TRACE_NEXT += 1;
    }
    let old_rsp = state::read_gpr(4);
    let old_ss = *gp::sreg.add(2);
    let old_cs = *gp::sreg.add(1);
    let old_rip = state::read_rip();
    let old_flags = state::read_flags64();
    let new_cpl = if cs.is_dc() { *gp::cpl } else { cs.dpl() };
    let ist = (low >> 32 & 7) as u8;
    let switch_stack = ist != 0 || new_cpl < *gp::cpl;
    let mut rsp = old_rsp;
    if switch_stack {
        let at = if ist != 0 { 36 + (ist as u32 - 1) * 8 } else { 4 + new_cpl as u32 * 8 };
        if at + 7 > *gp::segment_limits.add(6) {
            return Err(exception(10, *gp::sreg.add(6) as u32 & !3));
        }
        rsp = memory::read_system(state::read_segment_base(6).wrapping_add(at as u64), 64)?;
    }
    rsp &= !15;
    let values = [
        old_ss as u64,
        old_rsp,
        old_flags,
        old_cs as u64,
        old_rip,
        code.unwrap_or(0) as u64,
    ];
    let count = if code.is_some() { 6 } else { 5 };
    // Check the entire frame before stores or cached privilege/segment state.
    for i in 0..count {
        memory::probe_system_write(rsp.wrapping_sub((i + 1) as u64 * 8), 64)?;
    }
    for value in &values[..count] {
        rsp = rsp.wrapping_sub(8);
        memory::write_system(rsp, 64, *value)?;
    }
    install_cs(selector, &cs, new_cpl);
    if switch_stack {
        *gp::sreg.add(2) = new_cpl as u16;
        *gp::segment_is_null.add(2) = false;
        *gp::segment_access_bytes.add(2) = 0x93 | new_cpl << 5;
        *gp::segment_limits.add(2) = u32::MAX;
        state::write_segment_base(2, 0);
    }
    state::write_gpr(4, rsp, 64);
    state::write_flags64(
        old_flags
            & !(0x100 | 0x4000 | 0x10000 | 0x20000)
            & if kind == 14 { !0x200 } else { u64::MAX },
    );
    state::write_rip(target);
    Ok(())
}
/// JMP/CALL m16:16/32/64 in 64-bit mode (SDM Vol.2A JMP/CALL, Vol.3A §5.8.3):
/// a code segment at the current privilege, or a 64-bit call gate, which a
/// CALL may use to reach a more privileged 64-bit code segment. Task gates
/// and TSS selectors do not exist in IA-32e mode. Every access and check
/// precedes the first architectural change.
unsafe fn far_transfer(instruction: &Decoded, call: bool) -> Result<(), Fault> {
    if instruction.address.is_none() {
        return Err(Fault::ud());
    }
    let width = instruction.operand_size;
    let (pointer, stack_access) = super::execute::address(instruction);
    let offset = memory::read(pointer, width, stack_access)?;
    let selector = memory::read(pointer.wrapping_add((width / 8) as u64), 16, stack_access)? as u16;
    let next = instruction.next.0;
    let cpl = *gp::cpl;
    let error = selector as u32 & !3;
    let (target, at) = descriptor(selector)?;
    if !target.is_system() {
        let long = target.flags() & 2 != 0;
        if !target.is_executable()
            || long && target.is_32()
            || if target.is_dc() {
                target.dpl() > cpl
            }
            else {
                (selector & 3) as u8 > cpl || target.dpl() != cpl
            }
        {
            return Err(exception(13, error));
        }
        if !target.is_present() {
            return Err(exception(11, error));
        }
        if long && !state::canonical(offset, 48)
            || !long && offset > target.effective_limit() as u64
        {
            return Err(Fault::gp());
        }
        if call {
            let rsp = state::read_gpr(4);
            let unit = (width / 8) as u64;
            memory::probe_write(rsp.wrapping_sub(2 * unit), width, true)?;
            memory::probe_write(rsp.wrapping_sub(unit), width, true)?;
            memory::write(rsp.wrapping_sub(unit), width, *gp::sreg.add(1) as u64, true)?;
            memory::write(rsp.wrapping_sub(2 * unit), width, next, true)?;
            state::write_gpr(4, rsp.wrapping_sub(2 * unit), 64);
        }
        if !target.accessed() {
            memory::write_system(at.wrapping_add(5), 8, (target.access_byte() | 1) as u64)?;
        }
        install_cs(selector, &target, cpl);
        state::write_rip(offset);
        return Ok(());
    }
    // A 64-bit call gate occupies 16 bytes; the upper type field must be 0.
    let limit = if selector & 4 != 0 { *gp::segment_limits.add(7) } else { *gp::gdtr_size as u32 };
    if target.system_type() != 12
        || target.dpl() < cpl
        || target.dpl() < (selector & 3) as u8
        || (selector as u32 & !7) + 15 > limit
    {
        return Err(exception(13, error));
    }
    if !target.is_present() {
        return Err(exception(11, error));
    }
    let high = memory::read_system(at.wrapping_add(8), 64)?;
    if high >> 40 & 0x1F != 0 {
        return Err(exception(13, error));
    }
    let code_selector = (target.raw >> 16) as u16;
    let entry = target.raw & 0xFFFF | (target.raw >> 48) << 16 | (high & 0xFFFF_FFFF) << 32;
    let code_error = code_selector as u32 & !3;
    let (code, code_at) = descriptor(code_selector)?;
    if code.is_system()
        || !code.is_executable()
        || code.flags() & 2 == 0
        || code.is_32()
        || if call {
            code.dpl() > cpl
        }
        else if code.is_dc() {
            code.dpl() > cpl
        }
        else {
            code.dpl() != cpl
        }
    {
        return Err(exception(13, code_error));
    }
    if !code.is_present() {
        return Err(exception(11, code_error));
    }
    if !state::canonical(entry, 48) {
        return Err(Fault::gp());
    }
    let new_cpl = if call && !code.is_dc() { code.dpl() } else { cpl };
    let mut frame: [u64; 4] = [0; 4];
    let mut count = 0;
    let mut rsp = state::read_gpr(4);
    if call {
        if new_cpl < cpl {
            // Inner privilege: RSPn from the 64-bit TSS; SS becomes a null
            // selector with RPL = new CPL. Call gates do not align RSP.
            let tss = 4 + new_cpl as u32 * 8;
            if tss + 7 > *gp::segment_limits.add(6) {
                return Err(exception(10, *gp::sreg.add(6) as u32 & !3));
            }
            let inner =
                memory::read_system(state::read_segment_base(6).wrapping_add(tss as u64), 64)?;
            if !state::canonical(inner, 48) {
                return Err(exception(12, 0));
            }
            frame = [*gp::sreg.add(2) as u64, rsp, *gp::sreg.add(1) as u64, next];
            count = 4;
            rsp = inner;
        }
        else {
            frame[..2].copy_from_slice(&[*gp::sreg.add(1) as u64, next]);
            count = 2;
        }
        for i in 0..count {
            if new_cpl < cpl {
                memory::probe_system_write(rsp.wrapping_sub((i + 1) as u64 * 8), 64)?;
            }
            else {
                memory::probe_write(rsp.wrapping_sub((i + 1) as u64 * 8), 64, true)?;
            }
        }
    }
    if !code.accessed() {
        memory::write_system(code_at.wrapping_add(5), 8, (code.access_byte() | 1) as u64)?;
    }
    for value in &frame[..count] {
        rsp = rsp.wrapping_sub(8);
        if new_cpl < cpl {
            memory::write_system(rsp, 64, *value)?;
        }
        else {
            memory::write(rsp, 64, *value, true)?;
        }
    }
    if new_cpl < cpl {
        *gp::sreg.add(2) = new_cpl as u16;
        *gp::segment_is_null.add(2) = false;
        *gp::segment_access_bytes.add(2) = 0x93 | new_cpl << 5;
        *gp::segment_limits.add(2) = u32::MAX;
        state::write_segment_base(2, 0);
    }
    state::write_gpr(4, rsp, 64);
    install_cs(code_selector, &code, new_cpl);
    state::write_rip(entry);
    Ok(())
}
pub unsafe fn far_return(width: u8, discard: u16) -> Result<(), Fault> {
    let unit = (width / 8) as u64;
    let rsp = state::read_gpr(4);
    let ip = memory::read(rsp, width, true)?;
    let selector = memory::read(rsp.wrapping_add(unit), width, true)? as u16;
    let (cs, at) = descriptor(selector)?;
    let new_cpl = (selector & 3) as u8;
    let long = cs.flags() & 2 != 0;
    if cs.is_system()
        || !cs.is_executable()
        || new_cpl < *gp::cpl
        || long && cs.is_32()
        || if cs.is_dc() { cs.dpl() > new_cpl } else { cs.dpl() != new_cpl }
    {
        return Err(exception(13, selector as u32 & !3));
    }
    if !cs.is_present() {
        return Err(exception(11, selector as u32 & !3));
    }
    if !state::canonical(ip, 48) || !long && ip > cs.effective_limit() as u64 {
        return Err(Fault::gp());
    }
    let mut next_rsp = rsp.wrapping_add(unit * 2).wrapping_add(discard as u64);
    let stack = if new_cpl != *gp::cpl {
        let pointer = memory::read(next_rsp, width, true)?;
        let ss_selector = memory::read(next_rsp.wrapping_add(unit), width, true)? as u16;
        let (ss, _) = descriptor(ss_selector)?;
        if ss.is_system()
            || !ss.is_writable()
            || ss.dpl() != new_cpl
            || (ss_selector & 3) as u8 != new_cpl
        {
            return Err(exception(13, ss_selector as u32 & !3));
        }
        if !ss.is_present() {
            return Err(exception(12, ss_selector as u32 & !3));
        }
        if !state::canonical(pointer, 48) {
            return Err(exception(12, 0));
        }
        next_rsp = pointer.wrapping_add(discard as u64);
        Some((ss_selector, ss))
    }
    else {
        None
    };
    if !cs.accessed() {
        memory::write_system(at.wrapping_add(5), 8, (cs.access_byte() | 1) as u64)?;
    }
    if let Some((selector, ss)) = stack {
        *gp::sreg.add(2) = selector;
        *gp::segment_is_null.add(2) = false;
        *gp::segment_access_bytes.add(2) = ss.access_byte();
        *gp::segment_limits.add(2) = ss.effective_limit();
        *gp::stack_size_32 = ss.is_32();
        state::write_segment_base(2, if long { 0 } else { ss.base() as u32 as u64 });
    }
    state::write_gpr(4, next_rsp, 64);
    install_cs(selector, &cs, new_cpl);
    state::write_rip(ip);
    Ok(())
}

/// IRETQ, or IRETD/IRETW (the same five slots, 4 or 2 bytes each).
pub unsafe fn iret(width: u8) -> Result<(), Fault> {
    crate::parallel::code::poll();
    if state::read_flags64() & 0x4000 != 0 {
        return Err(Fault::gp());
    }
    let rsp = state::read_gpr(4);
    let slot = (width / 8) as u64;
    let ip = memory::read(rsp, width, true)?;
    let selector = memory::read(rsp.wrapping_add(slot), width, true)? as u16;
    let mut flags = memory::read(rsp.wrapping_add(2 * slot), width, true)?;
    if width == 16 {
        flags = flags & 0xFFFF | state::read_flags64() & !0xFFFF;
    }
    let new_rsp = memory::read(rsp.wrapping_add(3 * slot), width, true)?;
    let ss_selector = memory::read(rsp.wrapping_add(4 * slot), width, true)? as u16;
    *gp::nmi_blocked = false;
    *gp::interrupt_shadow = 0;
    let (cs, _) = descriptor(selector)?;
    let new_cpl = (selector & 3) as u8;
    if cs.is_system()
        || !cs.is_executable()
        || new_cpl < *gp::cpl
        || if cs.is_dc() { cs.dpl() > new_cpl } else { cs.dpl() != new_cpl }
    {
        return Err(exception(13, selector as u32 & !3));
    }
    let long = cs.flags() & 2 != 0;
    if long && cs.is_32() {
        return Err(exception(13, selector as u32 & !3));
    }
    if !cs.is_present() {
        return Err(exception(11, selector as u32 & !3));
    }
    if !state::canonical(ip, 48) || !long && ip > cs.effective_limit() as u64 {
        return Err(Fault::gp());
    }
    if !state::canonical(new_rsp, 48) {
        return Err(exception(12, 0));
    }
    let ss = if ss_selector & !3 == 0 {
        if !long || new_cpl == 3 || (ss_selector & 3) as u8 != new_cpl {
            return Err(Fault::gp());
        }
        None
    }
    else {
        let (ss, _) = descriptor(ss_selector)?;
        if ss.is_system()
            || !ss.is_writable()
            || ss.dpl() != new_cpl
            || (ss_selector & 3) as u8 != new_cpl
        {
            return Err(exception(13, ss_selector as u32 & !3));
        }
        if !ss.is_present() {
            return Err(exception(12, ss_selector as u32 & !3));
        }
        Some(ss)
    };
    // Flags privilege checks use the returning CPL, before installing target CS.
    let mut next_flags = flags;
    if *gp::cpl != 0 {
        next_flags = next_flags & !0x3000 | state::read_flags64() & 0x3000;
    }
    if *gp::cpl as i32 > cpu::getiopl() {
        next_flags = next_flags & !0x200 | state::read_flags64() & 0x200;
    }
    state::write_flags64(next_flags & !0x20000);
    install_cs(selector, &cs, new_cpl);
    *gp::sreg.add(2) = ss_selector;
    *gp::segment_is_null.add(2) = false;
    *gp::segment_access_bytes.add(2) = ss.as_ref().map_or(0x93 | new_cpl << 5, |s| s.access_byte());
    *gp::segment_limits.add(2) = ss.as_ref().map_or(u32::MAX, |s| s.effective_limit());
    *gp::stack_size_32 = ss.as_ref().is_none_or(|s| s.is_32());
    state::write_segment_base(
        2,
        if long { 0 } else { ss.as_ref().map_or(0, |s| s.base() as u32 as u64) },
    );
    state::write_gpr(4, new_rsp, 64);
    state::write_rip(ip);
    Ok(())
}
/// Diagnostics: the last faults raised in IA-32e mode, most recent at
/// FAULT_NEXT - 1: vector, error code (or u64::MAX), faulting RIP, fault
/// address (or u64::MAX), RSP, CS.
const FAULT_LOG_LEN: usize = 16;
static mut FAULT_LOG: [[u64; 6]; FAULT_LOG_LEN] = [[0; 6]; FAULT_LOG_LEN];
static mut FAULT_NEXT: usize = 0;
/// `index` 0 is the most recent fault; `field` as in FAULT_LOG, halves by `high`.
#[no_mangle]
pub unsafe fn x64_fault_log(index: u32, field: u32, high: bool) -> u32 {
    if index as usize >= FAULT_LOG_LEN || index as usize >= FAULT_NEXT || field >= 6 {
        return 0;
    }
    let value = FAULT_LOG[(FAULT_NEXT - 1 - index as usize) % FAULT_LOG_LEN][field as usize];
    (if high { value >> 32 } else { value }) as u32
}
/// Diagnostics: exceptions taken from CPL 3, as delivered (compatibility
/// mode: every vector; 64-bit mode: all but #PF), in FAULT_LOG's layout with
/// CR2 as the address, plus CR3. Off unless enabled; enabling clears it.
const USER_TRACE_LEN: usize = 1024;
static mut USER_TRACE: [[u64; 7]; USER_TRACE_LEN] = [[0; 7]; USER_TRACE_LEN];
static mut USER_TRACE_NEXT: usize = 0;
static mut USER_TRACE_ENABLED: bool = false;
#[no_mangle]
pub unsafe fn x64_user_trace_enable(enabled: bool) {
    USER_TRACE_ENABLED = enabled;
    USER_TRACE_NEXT = 0;
}
#[no_mangle]
pub unsafe fn x64_user_trace_count() -> u32 { USER_TRACE_NEXT as u32 }
/// `index` 0 is the oldest entry still held.
#[no_mangle]
pub unsafe fn x64_user_trace(index: u32, field: u32, high: bool) -> u32 {
    let first = USER_TRACE_NEXT.saturating_sub(USER_TRACE_LEN);
    let at = first + index as usize;
    if at >= USER_TRACE_NEXT || field >= 7 {
        return 0;
    }
    let value = USER_TRACE[at % USER_TRACE_LEN][field as usize];
    (if high { value >> 32 } else { value }) as u32
}
pub unsafe fn raise(fault: Fault) {
    FAULT_LOG[FAULT_NEXT % FAULT_LOG_LEN] = [
        fault.vector as u64,
        fault.error.map_or(u64::MAX, |e| e as u64),
        state::read_previous_rip(),
        fault.address.unwrap_or(u64::MAX),
        state::read_gpr(4),
        *gp::sreg.add(1) as u64,
    ];
    FAULT_NEXT += 1;
    crate::cpu::execution::mark_fault();
    state::write_rip(state::read_previous_rip());
    if fault.vector != 1 {
        state::write_flags64(state::read_flags64() | 0x10000);
    }
    if let Some(address) = fault.address {
        state::write_cr_raw(2, address);
    }
    crate::cpu::exceptions::fault(fault.vector as i32, fault.error.map(|e| e as i32));
}
