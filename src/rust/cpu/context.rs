//! State kept outside the fixed register block. Switching cores preserves
//! translations: only the guest's CR3/INVLPG/shootdown changes their lifetime.
use crate::cpu::cpu::TLB_HAS_CODE;
use crate::cpu::{apic, cpu, global_pointers::*, memory};
use crate::page::Page;

static mut CONTEXTS: [Context; 8] = [const {
    Context {
        tlb: Vec::new(),
        tsc_offset: 0,
    }
}; 8];
struct Context {
    // Portable guest physical address + flags, never a host RAM pointer.
    tlb: Vec<(u32, u32)>,
    tsc_offset: u64,
}

unsafe fn capture(core: usize) {
    let context = &mut CONTEXTS[core];
    context.tlb.clear();
    context.tsc_offset = cpu::tsc_offset;
    for i in 0..cpu::valid_tlb_entries_count as usize {
        let page = cpu::valid_tlb_entries[i] as u32;
        let entry = cpu::tlb_data[page as usize] as u32;
        if entry != 0 {
            let physical = ((entry & !0xFFF) ^ (page << 12)).wrapping_sub(memory::mem8 as u32);
            // (TLB_HAS_CODE is derived from the code caches: install recomputes it)
            context.tlb.push((
                page,
                physical | (entry as u32 & 0xFFF & !(TLB_HAS_CODE as u32)),
            ));
            // Deduplicate the valid list (INVLPG can leave an old index).
            cpu::tlb_data[page as usize] = 0;
        }
    }
    cpu::valid_tlb_entries_count = 0;
    *last_virt_eip = -1;
}
unsafe fn install(core: usize) {
    // (no new code epoch: the core's own translations come back, P7.1)
    cpu::clear_all_tlb_entries();
    cpu::tsc_offset = CONTEXTS[core].tsc_offset;
    cpu::tsc_last_value = 0;
    cpu::tsc_resolution = u64::MAX;
    cpu::tsc_number_of_same_readings = 0;
    for &(page, portable) in &CONTEXTS[core].tlb {
        let physical = portable & !0xFFF;
        let mut info = portable & 0xFFF & !(TLB_HAS_CODE as u32);
        if !memory::in_mapped_range(physical)
            && crate::jit::page_needs_notification(Page::page_of(physical))
        {
            info |= TLB_HAS_CODE as u32;
        }
        cpu::tlb_data[page as usize] =
            ((physical.wrapping_add(memory::mem8 as u32) ^ (page << 12)) | info) as i32;
        cpu::valid_tlb_entries[cpu::valid_tlb_entries_count as usize] = page as i32;
        cpu::valid_tlb_entries_count += 1;
    }
}
#[no_mangle]
pub unsafe fn context_switch(old: u32, new: u32) {
    assert!(old < apic::core_count() as u32 && new < apic::core_count() as u32);
    capture(old as usize);
    install(new as usize);
}
#[no_mangle]
pub unsafe fn context_reset(core: u32) {
    assert!(core < 8);
    crate::cpu::exceptions::init(core);
    crate::x64::memory::invalidate_core(core as usize);
    CONTEXTS[core as usize].tlb.clear();
    if core == apic::current_core() as u32 {
        cpu::full_clear_tlb();
    }
}
#[no_mangle]
pub unsafe fn context_reset_all() {
    crate::cpu::exceptions::reset();
    let offset = (cpu::js::microtick() * cpu::TSC_RATE) as u64;
    for core in 0..8 {
        context_reset(core);
        CONTEXTS[core as usize].tsc_offset = offset;
    }
    cpu::tsc_offset = offset;
}
#[no_mangle]
pub unsafe fn context_capture() {
    let core = apic::current_core();
    capture(core);
    install(core);
}
#[no_mangle]
pub unsafe fn context_install(core: u32) {
    assert!(core < 8);
    install(core as usize);
}
#[no_mangle]
pub unsafe fn context_tlb_len(core: u32) -> u32 {
    assert!(core < 8);
    CONTEXTS[core as usize].tlb.len() as u32
}
#[no_mangle]
pub unsafe fn context_tlb_get(core: u32, index: u32, field: u32) -> u32 {
    assert!(core < 8);
    let (page, entry) = CONTEXTS[core as usize].tlb[index as usize];
    if field == 0 {
        page
    }
    else {
        entry
    }
}
#[no_mangle]
pub unsafe fn context_tlb_push(core: u32, page: u32, entry: u32) {
    assert!(core < 8 && page < 0x100000 && entry & 1 != 0);
    let entries = &mut CONTEXTS[core as usize].tlb;
    assert!(entries.len() < 10000);
    entries.push((page, entry));
}
#[no_mangle]
pub unsafe fn context_tsc_get(core: u32, high: bool) -> u32 {
    assert!(core < 8);
    (CONTEXTS[core as usize].tsc_offset >> if high { 32 } else { 0 }) as u32
}
#[no_mangle]
pub unsafe fn context_tsc_set(core: u32, low: u32, high: u32) {
    assert!(core < 8);
    CONTEXTS[core as usize].tsc_offset = low as u64 | (high as u64) << 32;
}

/// A physical mapping change invalidates address translations, not vCPU state.
pub unsafe fn invalidate_all_tlbs() {
    crate::x64::memory::invalidate_all_tlbs();
    invalidate_legacy_tlbs();
}
/// Only the 32-bit TLBs of every core (host addresses of RAM and of
/// extended RAM frames); the x64 TLBs keep their physical translations
pub unsafe fn invalidate_legacy_tlbs() {
    for core in 0..8 {
        CONTEXTS[core].tlb.clear();
    }
    cpu::full_clear_tlb();
}
