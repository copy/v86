//! System management mode, for the Q35 machine: the ICH9 raises SMIs from
//! the APM control port and the TCO watchdog (src/acpi.js), the local APICs
//! deliver SMI messages (IPIs, MSIs, IOAPIC entries). crate::cpu::apic
//! latches an SMI per core; handle_irqs takes it while the core is not in
//! SMM, so one that comes in SMM waits for RSM.
//!
//! An SMI saves the CPU state at SMBASE + 0xFE00 in a layout of QEMU's
//! target/i386/tcg/system/smm_helper.c: the 32-bit one (revision 0x20000)
//! with the legacy CPU profile, the 64-bit one (revision 0x20064) with the
//! x86-64 profile, in every mode, as AMD64 and Intel 64 processors do.
//! SeaBIOS's SMI handler reads and edits both (src/fw/smm.c: the SMBASE
//! relocation and call32_smm). The handler starts at SMBASE + 0x8000 in real
//! mode with 4 GiB segment limits, without paging (and long mode: EFER is
//! cleared). RSM restores the state, and a new SMBASE from the save area.
//!
//! SMRAM, as the Q35 MCH decodes it (src/q35.js passes its controls):
//! - compatible SMRAM, the RAM behind the VGA window (0xA0000-0xBFFFF): in SMM
//!   with G_SMRAME (D_CLS keeps data accesses on the VGA window then, but not
//!   instruction fetches), and for everyone while software opened it (D_OPEN);
//! - high SMRAM (ESMRAMC.H_SMRAME): instead of that, the same RAM at
//!   0xFEDA0000-0xFEDBFFFF, under the same conditions (SMBASE may point there);
//! - TSEG, the top of the RAM below 4 GiB (ESMRAMC.T_EN with G_SMRAME): RAM in
//!   SMM; elsewhere it reads as all ones and ignores writes.
//! Those addresses stay mapped (crate::cpu::memory's out-of-line paths
//! decide; TSEG lowers the fast RAM limit, and the x64 bus decodes it,
//! crate::x64::physical), so nothing in them is cached or compiled.
//!
//! An SMI that interrupts HLT sets the auto HALT restart field of the save
//! area; RSM returns to the halt state if the handler left it set. Not
//! supported: the I/O instruction restart field (cleared at the SMI, ignored
//! by RSM), and ESMRAMC.E_SMERR, as in QEMU.

use crate::cpu::apic;
use crate::cpu::cpu::*;
use crate::cpu::global_pointers::*;
use crate::cpu::memory;
use crate::x64::state as x64;

/// SMM revision identifiers: SMBASE relocation (bit 17), and the save map
pub const SMM_REVISION_32: u32 = 0x0002_0000;
pub const SMM_REVISION_64: u32 = 0x0002_0064;
const SMM_REVISION_RELOCATION: u32 = 0x0002_0000;
pub const SMBASE_DEFAULT: u32 = 0x30000;

const SMM_ACTIVE: u32 = 1 << 0;
const SMM_NMI_BLOCKED: u32 = 1 << 1;
/// The state is in the 64-bit save map (RSM reads the map the SMI wrote)
const SMM_MAP_64: u32 = 1 << 2;
/// The SMI interrupted HLT (the auto HALT restart field may return to it)
const SMM_HALTED: u32 = 1 << 3;

/// The chipset's SMRAM control, the same for every core
pub static mut SMRAM_CONTROL: u8 = 0;
pub const SMRAM_G_SMRAME: u8 = 1 << 0;
pub const SMRAM_D_OPEN: u8 = 1 << 1;
pub const SMRAM_H_SMRAME: u8 = 1 << 2;
pub const SMRAM_D_CLS: u8 = 1 << 3;

/// High SMRAM: compatible SMRAM's RAM at this address, with H_SMRAME
const HIGH_SMRAM: u32 = 0xFEDA_0000;
const COMPATIBLE_SMRAM: u32 = 0xA0000;
const SMRAM_SIZE: u32 = 0x20000;

/// TSEG: [base, end), empty without it. `generation` counts changes, so that
/// cores in workers take them over (sync_worker).
#[repr(C)]
pub struct Tseg {
    base: u32,
    end: u32,
    generation: u32,
}
pub static mut TSEG: Tseg = Tseg {
    base: 0,
    end: 0,
    generation: 0,
};
/// The TSEG generation this instance's fast RAM limit and caches reflect
static mut TSEG_SEEN: u32 = 0;

/// The chipset's SMRAM control changed (src/q35.js): G_SMRAME (bit 0),
/// D_OPEN (bit 1), H_SMRAME (bit 2), D_CLS (bit 3)
#[no_mangle]
pub unsafe fn smram_set_control(value: u8) {
    *crate::parallel::machine(&raw mut SMRAM_CONTROL) = value;
}

/// The chipset's TSEG changed (src/q35.js): [base, end), or empty
#[no_mangle]
pub unsafe fn smram_set_tseg(base: u32, end: u32) {
    let (base, end) = if base < end { (base, end) } else { (0, 0) };
    let tseg = &mut *crate::parallel::machine(&raw mut TSEG);
    if tseg.base == base && tseg.end == end {
        return;
    }
    dbg_log!("TSEG: {:x}-{:x}", base, end);
    tseg.base = base;
    tseg.end = end;
    tseg.generation = tseg.generation.wrapping_add(1);
    TSEG_SEEN = tseg.generation;
    crate::x64::physical::memory_map_changed();
}

/// The first byte of TSEG, or u32::MAX without one: the fast RAM limit is
/// below it (crate::x64::physical)
pub unsafe fn tseg_floor() -> u32 {
    let tseg = &*crate::parallel::machine(&raw mut TSEG);
    if tseg.base < tseg.end {
        tseg.base
    }
    else {
        u32::MAX
    }
}

#[inline(always)]
pub unsafe fn in_tseg(addr: u32) -> bool {
    let tseg = &*crate::parallel::machine(&raw mut TSEG);
    addr >= tseg.base && addr < tseg.end
}

/// TSEG outside SMM: all ones, writes dropped (as the low RAM hole)
#[inline(always)]
pub unsafe fn tseg_blackhole(addr: u32) -> bool { in_tseg(addr) && !smm_active() }

/// A core in a worker (crate::parallel), at the start of its slice: the
/// machine changed TSEG, so the fast RAM limit and the cached translations
/// of this instance change with it
pub unsafe fn sync_worker() {
    let generation = (*crate::parallel::machine(&raw mut TSEG)).generation;
    if generation != TSEG_SEEN {
        TSEG_SEEN = generation;
        memory::ram_fast_limit = *crate::parallel::machine(&raw mut memory::ram_fast_limit);
        crate::x64::physical::copy_from_machine();
        crate::cpu::context::invalidate_all_tlbs();
    }
}

#[no_mangle]
pub unsafe fn smm_active() -> bool { *smm_state & SMM_ACTIVE != 0 }

/// An SMI is waiting that this core can take
pub unsafe fn smi_deliverable() -> bool { !smm_active() && apic::smi_pending() }

/// Where an access to `addr` (`bytes` long) reaches the RAM of SMRAM:
/// compatible SMRAM behind the VGA window, its alias at 0xFEDA0000 (high
/// SMRAM), TSEG in SMM; None elsewhere. `fetch`: an instruction fetch (D_CLS
/// does not keep those from compatible SMRAM).
#[inline(always)]
pub unsafe fn smram_ram(addr: u32, bytes: u32, fetch: bool) -> Option<u32> {
    let last = addr.wrapping_add(bytes - 1);
    if addr >= COMPATIBLE_SMRAM && last < COMPATIBLE_SMRAM + SMRAM_SIZE {
        let control = *crate::parallel::machine(&raw mut SMRAM_CONTROL);
        (control & SMRAM_H_SMRAME == 0
            && (control & SMRAM_D_OPEN != 0
                || control & SMRAM_G_SMRAME != 0
                    && smm_active()
                    && (fetch || control & SMRAM_D_CLS == 0)))
            .then_some(addr)
    }
    else if addr >= HIGH_SMRAM && last < HIGH_SMRAM + SMRAM_SIZE {
        let control = *crate::parallel::machine(&raw mut SMRAM_CONTROL);
        (control & SMRAM_H_SMRAME != 0
            && (control & SMRAM_D_OPEN != 0 || control & SMRAM_G_SMRAME != 0 && smm_active()))
        .then_some(addr - HIGH_SMRAM + COMPATIBLE_SMRAM)
    }
    else {
        (in_tseg(addr) && in_tseg(last) && smm_active()).then_some(addr)
    }
}

/// Whether an SMI saves the state in the 64-bit map: with the x86-64
/// profile, and in long mode (which the legacy profile does not report, but
/// does not keep from a guest either)
unsafe fn layout_64() -> bool {
    crate::cpu::instructions_0f::long_mode_capable() || x64::efer() & x64::EFER_LMA != 0
}

/// QEMU's segment attributes: the access byte, and AVL, L, D/B, G in bits
/// 12-15. (TR and LDTR have no access byte here: a busy TSS of the size of
/// the task (a 64-bit one in long mode), an LDT.)
unsafe fn attributes(segment: i32) -> u32 {
    let access = match segment {
        TR => 0x80 | if x64::efer() & x64::EFER_LMA != 0 || *tss_size_32 { 0x0B } else { 0x03 },
        LDTR => {
            if *sreg.offset(LDTR as isize) & !3 == 0 {
                0
            }
            else {
                0x82
            }
        },
        _ => *segment_access_bytes.offset(segment as isize) as u32,
    };
    let long = segment == CS && *x64_cs_long != 0;
    let big = match segment {
        CS => *is_32,
        SS => *stack_size_32,
        _ => false,
    };
    let granular = *segment_limits.offset(segment as isize) > 0xFFFFF;
    access | (long as u32) << 13 | (big as u32) << 14 | (granular as u32) << 15
}

unsafe fn load_segment(segment: i32, selector: u32, base: u64, limit: u32, attributes: u32) {
    *sreg.offset(segment as isize) = selector as u16;
    x64::write_segment_base(segment as usize, base);
    *segment_limits.offset(segment as isize) = limit;
    *segment_access_bytes.offset(segment as isize) = attributes as u8;
    *segment_is_null.offset(segment as isize) = false;
}

/// The save area: the RAM of SMBASE + 0x8000 (offsets 0x7E00-0x7FFF)
#[derive(Clone, Copy)]
struct SaveArea(u32);

/// The save area of SMBASE `base`: in RAM, or in compatible SMRAM where high
/// SMRAM shows it (with `checked`, only if the chipset enables high SMRAM for
/// SMM). None: SMBASE + 0xFE00-0xFFFF is neither.
unsafe fn save_area(base: u32, checked: bool) -> Option<SaveArea> {
    let first = base.checked_add(0xFE00)?;
    let last = base.checked_add(0xFFFF)?;
    if (last as u64) < *memory_size as u64 {
        Some(SaveArea(base + 0x8000))
    }
    else if first >= HIGH_SMRAM && last < HIGH_SMRAM + SMRAM_SIZE {
        let control = *crate::parallel::machine(&raw mut SMRAM_CONTROL);
        let enabled =
            control & (SMRAM_G_SMRAME | SMRAM_H_SMRAME) == SMRAM_G_SMRAME | SMRAM_H_SMRAME;
        (enabled || !checked).then_some(SaveArea(base + 0x8000 - HIGH_SMRAM + COMPATIBLE_SMRAM))
    }
    else {
        None
    }
}
impl SaveArea {
    unsafe fn read32(self, offset: u32) -> u32 {
        memory::read32_no_mmap_check(self.0 + offset) as u32
    }
    unsafe fn read16(self, offset: u32) -> u32 { self.read32(offset) & 0xFFFF }
    unsafe fn read64(self, offset: u32) -> u64 {
        self.read32(offset) as u64 | (self.read32(offset + 4) as u64) << 32
    }
    unsafe fn write32(self, offset: u32, value: u32) {
        memory::write32_ram(self.0 + offset, value as i32)
    }
    unsafe fn write64(self, offset: u32, value: u64) {
        self.write32(offset, value as u32);
        self.write32(offset + 4, (value >> 32) as u32);
    }
}

/// (offset in the 32-bit save area) of ES, CS, SS, DS, FS, GS: their
/// selectors, and their attributes, limit and base
fn segment_slots_32(segment: i32) -> (u32, u32) {
    let selector = 0x7FA8 + segment as u32 * 4;
    let cache =
        if segment < 3 { 0x7F84 + segment as u32 * 12 } else { 0x7F2C + (segment as u32 - 3) * 12 };
    (selector, cache)
}

/// The 32-bit save area (revision 0x20000); `halted`: the SMI interrupted
/// HLT (the auto HALT restart field at 0x7F02, next to the I/O instruction
/// restart field at 0x7F00)
unsafe fn save_32(area: SaveArea, halted: bool) {
    area.write32(0x7FFC, *cr as u32);
    area.write32(0x7FF8, *cr.offset(3) as u32);
    area.write32(0x7FF4, get_eflags() as u32);
    area.write32(0x7FF0, get_real_eip() as u32);
    for (index, register) in [EDI, ESI, EBP, ESP, EBX, EDX, ECX, EAX].iter().enumerate() {
        area.write32(
            0x7FEC - index as u32 * 4,
            *reg32.offset(*register as isize) as u32,
        );
    }
    area.write32(0x7FCC, *dreg.offset(6) as u32);
    area.write32(0x7FC8, *dreg.offset(7) as u32);

    area.write32(0x7FC4, *sreg.offset(TR as isize) as u32);
    area.write32(0x7F64, *segment_offsets.offset(TR as isize) as u32);
    area.write32(0x7F60, *segment_limits.offset(TR as isize));
    area.write32(0x7F5C, attributes(TR));
    area.write32(0x7FC0, *sreg.offset(LDTR as isize) as u32);
    area.write32(0x7F80, *segment_offsets.offset(LDTR as isize) as u32);
    area.write32(0x7F7C, *segment_limits.offset(LDTR as isize));
    area.write32(0x7F78, attributes(LDTR));
    area.write32(0x7F74, *gdtr_offset as u32);
    area.write32(0x7F70, *gdtr_size as u32);
    area.write32(0x7F58, *idtr_offset as u32);
    area.write32(0x7F54, *idtr_size as u32);
    for segment in [ES, CS, SS, DS, FS, GS] {
        let (selector, cache) = segment_slots_32(segment);
        area.write32(selector, *sreg.offset(segment as isize) as u32);
        area.write32(cache + 8, *segment_offsets.offset(segment as isize) as u32);
        area.write32(cache + 4, *segment_limits.offset(segment as isize));
        area.write32(cache, attributes(segment));
    }
    area.write32(0x7F14, *cr.offset(4) as u32);
    area.write32(0x7F00, (halted as u32) << 16);
    area.write32(0x7EFC, SMM_REVISION_32);
    area.write32(0x7EF8, *smbase);
}

/// The 64-bit save area (revision 0x20064): ES-GS at 0x7E00 + 16 * n
/// (selector, attributes, limit, base), the descriptor tables and TR, the I/O
/// instruction and auto HALT restart bytes (0x7EC8, 0x7EC9, as AMD64 has
/// them), EFER, RIP, RFLAGS, the debug and control registers, the 16 GPRs
unsafe fn save_64(area: SaveArea, halted: bool) {
    let descriptor = |offset: u32, segment: i32| {
        area.write32(
            offset,
            *sreg.offset(segment as isize) as u32 | attributes(segment) << 16,
        );
        area.write32(offset + 4, *segment_limits.offset(segment as isize));
        area.write64(offset + 8, x64::read_segment_base(segment as usize));
    };
    for segment in [ES, CS, SS, DS, FS, GS] {
        descriptor(0x7E00 + segment as u32 * 16, segment);
    }
    area.write32(0x7E64, *gdtr_size as u32);
    area.write64(0x7E68, x64::read_gdtr_base());
    descriptor(0x7E70, LDTR);
    area.write32(0x7E84, *idtr_size as u32);
    area.write64(0x7E88, x64::read_idtr_base());
    descriptor(0x7E90, TR);
    area.write32(0x7EC8, (halted as u32) << 8);
    area.write64(0x7ED0, x64::efer());

    for register in 0..16 {
        area.write64(0x7FF8 - register as u32 * 8, x64::read_gpr(register));
    }
    area.write64(0x7F78, x64::read_rip());
    area.write32(0x7F70, get_eflags() as u32);
    area.write32(0x7F68, *dreg.offset(6) as u32);
    area.write32(0x7F60, *dreg.offset(7) as u32);
    area.write32(0x7F48, *cr.offset(4) as u32);
    area.write64(0x7F50, x64::read_cr(3));
    area.write32(0x7F58, *cr as u32);

    area.write32(0x7EFC, SMM_REVISION_64);
    area.write32(0x7F00, *smbase);
}

/// An SMI on this core (crate::cpu::apic::take_smi): save the state, run
/// the handler. False if the core is in SMM already (an SMI is not nested)
/// or the save area is not in RAM or enabled high SMRAM (the SMI is dropped).
#[no_mangle]
pub unsafe fn smm_enter() -> bool {
    if smm_active() {
        return false;
    }
    let base = *smbase;
    let Some(area) = save_area(base, true)
    else {
        dbg_log!("SMI: SMBASE {:x} is not in RAM or SMRAM, dropped", base);
        return false;
    };
    dbg_log!("SMI: enter SMM, SMBASE {:x}", base);
    let long = layout_64();
    let halted = *in_hlt;
    if long {
        save_64(area, halted);
    }
    else {
        save_32(area, halted);
    }

    // SMM: NMIs blocked until RSM, interrupts off, real mode with 4 GiB
    // limits, no paging; with the 64-bit map, EFER cleared
    *smm_state = SMM_ACTIVE
        | if *nmi_blocked { SMM_NMI_BLOCKED } else { 0 }
        | if long { SMM_MAP_64 } else { 0 }
        | if halted { SMM_HALTED } else { 0 };
    *nmi_blocked = true;
    if *in_hlt {
        js::stop_idling();
        *in_hlt = false;
    }
    *flags = FLAGS_DEFAULT;
    *flags_changed = 0;
    x64::write_cr_raw(
        0,
        (*cr & !(CR0_PE | CR0_EM | CR0_TS | CR0_PG) | CR0_ET) as u32 as u64,
    );
    x64::write_cr_raw(4, 0);
    if long {
        x64::set_efer_raw(0);
    }
    x64::write_dr(7, 0x400);
    *protected_mode = false;
    *cpl = 0;
    *x64_cs_long = 0;
    // (P, S, writable, accessed)
    load_segment(CS, base >> 4 & 0xFFFF, base as u64, 0xFFFF_FFFF, 0x93);
    for segment in [ES, SS, DS, FS, GS] {
        load_segment(segment, 0, 0, 0xFFFF_FFFF, 0x93);
    }
    *is_32 = false;
    *stack_size_32 = false;
    x64::write_rip(0x8000);
    x64::write_previous_rip(0x8000);
    entered_mode();
    true
}

/// After SMM entry or RSM: the translations, compiled code admission and
/// cached state of the old mode go
unsafe fn entered_mode() {
    // (cross-modifying code: other cores' code writes are seen from here on)
    crate::parallel::code::poll();
    full_clear_tlb();
    crate::x64::memory::invalidate_core(apic::current_core());
    update_state_flags();
    cpl_changed();
}

/// What RSM restored that the derived state depends on: EIP or RIP, and the
/// attributes of CS and SS (their D/B bits)
struct Restored {
    ip: u64,
    cs: u32,
    ss: u32,
}

/// The 32-bit save area (revision 0x20000)
unsafe fn restore_32(area: SaveArea) -> Restored {
    let new_cr0 = area.read32(0x7FFC) as i32;
    *cr = new_cr0 | CR0_ET;
    *cr.offset(3) = area.read32(0x7FF8) as i32;
    *cr.offset(4) = area.read32(0x7F14) as i32;

    *flags = area.read32(0x7FF4) as i32 & FLAGS_MASK | FLAGS_DEFAULT;
    *flags_changed = 0;
    for (index, register) in [EDI, ESI, EBP, ESP, EBX, EDX, ECX, EAX].iter().enumerate() {
        *reg32.offset(*register as isize) = area.read32(0x7FEC - index as u32 * 4) as i32;
    }
    *dreg.offset(6) = area.read32(0x7FCC) as i32;
    *dreg.offset(7) = area.read32(0x7FC8) as i32;

    load_segment(
        TR,
        area.read16(0x7FC4),
        area.read32(0x7F64) as u64,
        area.read32(0x7F60),
        area.read32(0x7F5C),
    );
    load_segment(
        LDTR,
        area.read16(0x7FC0),
        area.read32(0x7F80) as u64,
        area.read32(0x7F7C),
        area.read32(0x7F78),
    );
    *gdtr_offset = area.read32(0x7F74) as i32;
    *gdtr_size = area.read32(0x7F70) as i32;
    *idtr_offset = area.read32(0x7F58) as i32;
    *idtr_size = area.read32(0x7F54) as i32;

    for segment in [ES, CS, SS, DS, FS, GS] {
        let (selector, cache) = segment_slots_32(segment);
        load_segment(
            segment,
            area.read16(selector),
            area.read32(cache + 8) as u64,
            area.read32(cache + 4),
            area.read32(cache),
        );
    }
    if area.read32(0x7EFC) & SMM_REVISION_RELOCATION != 0 {
        *smbase = area.read32(0x7EF8);
    }
    Restored {
        ip: area.read32(0x7FF0) as u64,
        cs: area.read32(segment_slots_32(CS).1),
        ss: area.read32(segment_slots_32(SS).1),
    }
}

/// The 64-bit save area (revision 0x20064). EFER.LMA follows from LME,
/// CR0.PG and CR4.PAE, as when software enables paging.
unsafe fn restore_64(area: SaveArea) -> Restored {
    let mut cr0 = area.read32(0x7F58) as i32 | CR0_ET;
    if cr0 & CR0_PE == 0 {
        // (paging without protection is not a state)
        cr0 &= !CR0_PG;
    }
    let cr4 = area.read32(0x7F48) as i32;
    let efer = area.read64(0x7ED0) & (x64::EFER_SCE | x64::EFER_LME | x64::EFER_NXE);
    let long = efer & x64::EFER_LME != 0 && cr0 & CR0_PG != 0 && cr4 & CR4_PAE != 0;
    x64::set_efer_raw(efer | if long { x64::EFER_LMA } else { 0 });
    x64::write_cr_raw(0, cr0 as u32 as u64);
    x64::write_cr_raw(3, area.read64(0x7F50));
    x64::write_cr_raw(4, cr4 as u32 as u64);

    *flags = area.read32(0x7F70) as i32 & FLAGS_MASK | FLAGS_DEFAULT;
    *flags_changed = 0;
    for register in 0..16 {
        let value = area.read64(0x7FF8 - register as u32 * 8);
        *(x64::gpr_low_offset(register) as *mut u32) = value as u32;
        *(x64::gpr_high_offset(register) as *mut u32) = (value >> 32) as u32;
    }
    x64::write_dr(6, area.read32(0x7F68) as u64);
    x64::write_dr(7, area.read32(0x7F60) as u64);

    let descriptor = |offset: u32, segment: i32| {
        let attributes = area.read16(offset + 2);
        load_segment(
            segment,
            area.read16(offset),
            area.read64(offset + 8),
            area.read32(offset + 4),
            attributes,
        );
        attributes
    };
    descriptor(0x7E90, TR);
    descriptor(0x7E70, LDTR);
    *gdtr_size = area.read32(0x7E64) as i32;
    x64::write_gdtr_base(area.read64(0x7E68));
    *idtr_size = area.read32(0x7E84) as i32;
    x64::write_idtr_base(area.read64(0x7E88));
    let mut attributes = [0; 6];
    for segment in [ES, CS, SS, DS, FS, GS] {
        attributes[segment as usize] = descriptor(0x7E00 + segment as u32 * 16, segment);
    }
    // 64-bit code: CS.L, its base is 0
    *x64_cs_long = (long && attributes[CS as usize] & 1 << 13 != 0) as u8;
    if *x64_cs_long != 0 {
        x64::write_segment_base(CS as usize, 0);
    }
    if area.read32(0x7EFC) & SMM_REVISION_RELOCATION != 0 {
        *smbase = area.read32(0x7F00);
    }
    Restored {
        ip: area.read64(0x7F78),
        cs: attributes[CS as usize],
        ss: attributes[SS as usize],
    }
}

/// RSM: the state from the save area, out of SMM
pub unsafe fn rsm() {
    // (the area the SMI saved to: SMBASE changes only here)
    let area = save_area(*smbase, false).unwrap();
    dbg_log!("RSM: leave SMM, SMBASE {:x}", *smbase);
    let map_64 = *smm_state & SMM_MAP_64 != 0;
    // invalid state in the save area: shutdown (SDM Vol. 3C 32.13 "RSM")
    let cr4 = area.read32(if map_64 { 0x7F48 } else { 0x7F14 });
    if cr4 & !cr4_valid_bits() != 0 {
        dbg_log!("RSM: invalid CR4 {:x}: shutdown", cr4);
        crate::cpu::exceptions::shutdown();
        return;
    }
    // auto HALT restart: back to HLT, if the SMI came there and the handler
    // left the field set
    let halt = *smm_state & SMM_HALTED != 0
        && if map_64 { area.read32(0x7EC8) >> 8 & 1 } else { area.read32(0x7F00) >> 16 & 1 } != 0;
    let restored = if map_64 { restore_64(area) } else { restore_32(area) };

    // derived state: the mode, the sizes of CS and SS, null data segments,
    // the TSS type, CPL (CS.RPL)
    *protected_mode = *cr & CR0_PE != 0;
    let vm86 = *flags & FLAG_VM != 0;
    let protected = *protected_mode && !vm86;
    *is_32 = protected && *x64_cs_long == 0 && restored.cs & 1 << 14 != 0;
    *stack_size_32 = protected && restored.ss & 1 << 14 != 0;
    for segment in [ES, DS, FS, GS] {
        *segment_is_null.offset(segment as isize) =
            protected && *sreg.offset(segment as isize) & !3 == 0;
    }
    *segment_is_null.offset(LDTR as isize) = *sreg.offset(LDTR as isize) & !3 == 0;
    let tss_type = *segment_access_bytes.offset(TR as isize) & 0xF;
    *tss_size_32 = tss_type == 0x9 || tss_type == 0xB;
    *cpl = if vm86 {
        3
    }
    else if *protected_mode {
        (*sreg.offset(CS as isize) & 3) as u8
    }
    else {
        0
    };

    *nmi_blocked = *smm_state & SMM_NMI_BLOCKED != 0;
    *smm_state = 0;
    x64::write_rip(restored.ip);
    x64::write_previous_rip(restored.ip);
    entered_mode();
    if x64::efer() & x64::EFER_LMA == 0 && *cr.offset(4) & CR4_PAE != 0 && *cr & CR0_PG != 0 {
        load_pdpte(*cr.offset(3) & !0b1111);
    }
    if halt {
        *in_hlt = true;
        crate::cpu::execution::note_halt();
        request_core_yield();
    }
    // an SMI or NMI that waited for RSM: taken at the start of the next slice
    if apic::smi_pending() || apic::nmi_pending() && !*nmi_blocked {
        request_core_yield();
    }
}

/// At reset: SMBASE back to its default, not in SMM (INIT keeps SMBASE)
pub unsafe fn reset() {
    *smm_state = 0;
    *smbase = SMBASE_DEFAULT;
}
