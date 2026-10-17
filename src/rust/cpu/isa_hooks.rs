//! The x86 core's side of the code both cores share
//! (docs/arm64-virt-android16-plan.md P1.0): lib.rs names this module
//! `crate::isa` in the x86 core (aarch64::isa_hooks in the ARM core), and the
//! shared modules reach the ISA only through it. The hooks of crate::parallel
//! (set_active, attach, sync, poll) hold what was x86 in its bodies, inlined
//! so that the x86 core's code does not change.
use crate::cpu::{apic, cpu, global_pointers as gp, ioapic, memory};
use crate::page::Page;
use crate::parallel::{self, machine, machine_state};

pub const MAX_CORES: usize = apic::MAX_CORES;

/// The core this instance runs now
#[inline(always)]
pub fn current_core() -> usize { apic::current_core() }
/// The machine's cores
#[inline(always)]
pub fn core_count() -> usize { apic::core_count() }
/// The host's clock in milliseconds (env.microtick)
#[inline(always)]
pub unsafe fn microtick() -> f64 { cpu::js::microtick() }

// ---- crate::extended (extended RAM, the engine both cores share)

/// Every access cache entry, so that no frame of extended RAM is cached any more
#[inline(always)]
pub unsafe fn extended_release_caches() { crate::x64::extended::release_caches() }
/// The write entries to a frame of extended RAM whose page now has code
#[inline(always)]
pub unsafe fn extended_retire_cached_writes(host: u32) {
    crate::x64::extended::retire_cached_writes(host)
}
/// An extended page with page-tier code was written: retire its function
#[inline(always)]
pub unsafe fn extended_code_written(page: u32) {
    crate::x64::pages::dirty_page(crate::x64::extended::CODE_KEY_BASE + page)
}
/// The frames of extended RAM were discarded: the aperture's slots go too
#[inline(always)]
pub unsafe fn extended_discarded() { crate::x64::extended::aperture::clear() }

/// The address of this instance's yield flag (parallel::kick sets it)
#[inline(always)]
pub unsafe fn core_yield_address() -> u32 { &raw mut cpu::core_yield as u32 }

/// parallel_set_active in the machine instance: track RAM's code pages
#[inline(always)]
pub unsafe fn machine_set_active() {
    parallel::code::allocate(*gp::memory_size / 4096);
    // (writes of other cores to extended RAM do not retire code)
    crate::x64::pages::retire_extended();
}

/// parallel_attach: RAM, the machine configuration and the machine-shared
/// state of the machine instance
#[inline(always)]
pub unsafe fn attach_worker(core: u32) {
    memory::mem8 = *machine(&raw mut memory::mem8);
    memory::ram_fast_limit = *machine(&raw mut memory::ram_fast_limit);
    *gp::memory_size = *machine_state(gp::memory_size);
    *gp::acpi_enabled = *machine_state(gp::acpi_enabled);
    *gp::x87_native_policy = *machine_state(gp::x87_native_policy);
    cpu::copy_machine_configuration();
    crate::x64::physical::copy_from_machine();
    apic::attach_worker(core);
}

/// The TSC offset of this instance's core, published while it is parked
#[no_mangle]
pub unsafe fn parallel_tsc_offset(high: bool) -> u32 {
    let offset = cpu::tsc_offset;
    (if high { offset >> 32 } else { offset }) as u32
}
#[no_mangle]
pub unsafe fn parallel_set_tsc_offset(low: u32, high: u32) {
    cpu::tsc_offset = low as u64 | (high as u64) << 32;
    cpu::tsc_last_value = 0;
    cpu::tsc_resolution = u64::MAX;
    cpu::tsc_number_of_same_readings = 0;
}

/// parallel_sync in a worker: the machine's physical bus windows
#[inline(always)]
pub unsafe fn sync_worker() { crate::x64::physical::copy_from_machine(); }

/// Machine configuration that may change while the cores run (ACPI enable,
/// the CPU profile, TSEG), copied into a worker
#[inline(always)]
pub unsafe fn sync_worker_configuration() {
    *gp::acpi_enabled = *machine_state(gp::acpi_enabled);
    cpu::copy_machine_configuration();
    // (the chipset's TSEG)
    crate::cpu::smm::sync_worker();
}

/// A failed core's locks besides the split lock
#[inline(always)]
pub unsafe fn release_locks_held_by(core: usize) {
    ioapic::lock().release_held_by(core);
    crate::x64::extended::release_held_by(core);
}

/// parallel_test_fault: a machine lock to trap inside
#[inline(always)]
pub unsafe fn lock_for_test_fault() { ioapic::lock().lock(); }

/// parallel::code::poll: other cores published code from `pages` (or more
/// than the ring held): this core's stores to them take the slow path
#[inline(always)]
pub unsafe fn others_published(pages: &[u32], overflow: bool) {
    // (the x64 interpreter checks every store: only the access cache's
    // write entries of those pages must go)
    if overflow || pages.len() > 32 {
        cpu::full_clear_tlb();
        crate::x64::jac::flush_all();
    }
    else {
        for &page in pages {
            cpu::tlb_set_has_code(Page::page_of(page << 12), true);
            crate::x64::jac::retire_writes_on(current_core(), page << 12);
        }
    }
}

/// parallel::code::poll: other cores wrote `pages` (or more than the ring
/// held): retire this core's code from them
#[inline(always)]
pub unsafe fn others_wrote(pages: Vec<u32>, overflow: bool) {
    if overflow {
        crate::jit::jit_clear_cache_js();
    }
    else {
        for page in pages {
            crate::jit::jit_retire_page(Page::page_of(page << 12));
        }
    }
}

/// Registers and lazy flags an instruction may change before it commits a
/// locked read-modify-write: restored when another core changed the operand
/// in between and the instruction runs again
#[cfg(feature = "parallel")]
pub struct Registers([u8; 60], [u8; 96]);
#[cfg(feature = "parallel")]
impl Registers {
    pub unsafe fn save() -> Self {
        use crate::cpu::global_pointers::{reg32, x64_gpr_hi};
        let mut saved = Registers([0; 60], [0; 96]);
        // reg32 .. flags, and the upper and extra 64-bit GPR halves
        std::ptr::copy_nonoverlapping(reg32 as *const u8, saved.0.as_mut_ptr(), 60);
        std::ptr::copy_nonoverlapping(x64_gpr_hi as *const u8, saved.1.as_mut_ptr(), 96);
        saved
    }
    pub unsafe fn restore(&self) {
        use crate::cpu::global_pointers::{reg32, x64_gpr_hi};
        std::ptr::copy_nonoverlapping(self.0.as_ptr(), reg32 as *mut u8, 60);
        std::ptr::copy_nonoverlapping(self.1.as_ptr(), x64_gpr_hi as *mut u8, 96);
    }
}
