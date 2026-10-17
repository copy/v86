//! The ARM core's side of the code both cores share (lib.rs names this
//! module `crate::isa` in the ARM core; cpu::isa_hooks is the x86 core's),
//! and how its cores run in vCPU workers (P8.2): a worker attaches with a
//! copy of the machine's map and guest memory, and takes other cores' code
//! writes, publications and TLB maintenance at its safe points (`poll`).
use crate::page::Page;

pub const MAX_CORES: usize = 8;

/// The core this instance runs now (the cooperative scheduler sets it, P3.7)
pub(crate) static mut CURRENT_CORE: usize = 0;
/// The machine's cores
pub(crate) static mut CORE_COUNT: usize = 1;
/// Set by parallel::kick: leave the current slice
pub(crate) static mut CORE_YIELD: u8 = 0;

#[cfg(target_arch = "wasm32")]
mod js {
    #[link(wasm_import_module = "env")]
    extern "C" {
        pub fn microtick() -> f64;
    }
}
#[cfg(not(target_arch = "wasm32"))]
mod js {
    pub unsafe fn microtick() -> f64 { 0.0 }
}

#[inline(always)]
pub fn current_core() -> usize { unsafe { CURRENT_CORE } }
#[inline(always)]
pub fn core_count() -> usize { unsafe { *crate::parallel::machine(&raw mut CORE_COUNT) } }
/// The host's clock in milliseconds (env.microtick)
#[inline(always)]
pub unsafe fn microtick() -> f64 { js::microtick() }

#[inline(always)]
pub unsafe fn core_yield_address() -> u32 { &raw mut CORE_YIELD as u32 }

/// The machine instance starts running cores in workers: the RAM pages
/// whose compiled code the cores track (crate::parallel::code)
pub unsafe fn machine_set_active() {
    crate::parallel::code::allocate(crate::aarch64::bus::bus().ram_size() as u32 / 4096);
    crate::aarch64::tlb::ring_synced_now();
}
/// parallel_attach: this instance runs core `core`, with the machine's map and guest memory
pub unsafe fn attach_worker(core: u32) {
    CURRENT_CORE = core as usize;
    crate::aarch64::bus::sync_worker();
    crate::aarch64::tlb::ring_synced_now();
    crate::aarch64::tlb::flush(false);
}
/// After a stop: the machine may have changed its map
pub unsafe fn sync_worker() {
    crate::aarch64::bus::sync_worker();
    crate::aarch64::tlb::ring_synced_now();
}
#[inline(always)]
pub unsafe fn sync_worker_configuration() { crate::aarch64::bus::sync_worker_if_stale() }
/// A failed core's locks: the GIC's, extended RAM's
pub unsafe fn release_locks_held_by(core: usize) {
    crate::aarch64::gic::release_held_by(core);
    crate::extended::release_held_by(core);
}
pub unsafe fn lock_for_test_fault() { crate::aarch64::gic::lock_for_test_fault() }

/// At a safe point (no compiled code runs): the other cores' code writes
/// and publications (crate::parallel::code), then their TLB maintenance,
/// acknowledged (crate::aarch64::tlb)
#[inline]
pub fn poll() {
    if crate::parallel::active() {
        unsafe { crate::parallel::code::poll() };
        crate::aarch64::tlb::poll();
    }
}

// ---- crate::extended (extended RAM, P8.5): the page tier's access cache
// may hold its frames (crate::aarch64::extended::cache_frame); code compiled
// from a page retires at its write

/// Every core's access cache entries retire (no compiled code is active)
pub unsafe fn extended_release_caches() {
    for core in 0..MAX_CORES {
        crate::aarch64::jit::pages::tlb_flushed(core);
    }
}
pub unsafe fn extended_retire_cached_writes(host: u32) {
    crate::aarch64::jit::pages::retire_writes_to(host)
}
pub unsafe fn extended_code_written(page: u32) {
    crate::aarch64::root::dirty_bytes(
        crate::page::Page::of_u32(crate::aarch64::bus::EXTENDED_CODE_KEY + page),
        0,
        4096,
    );
}
#[inline(always)]
pub unsafe fn extended_discarded() {}

/// Other cores published code from `pages`: this core's access cache
/// serves no more stores to them (they must reach crate::parallel::code)
pub unsafe fn others_published(pages: &[u32], overflow: bool) {
    let core = current_core();
    if overflow {
        crate::aarch64::jit::pages::tlb_flushed(core);
        return;
    }
    let set: std::collections::HashSet<Page> = pages.iter().map(|&p| Page::of_u32(p)).collect();
    crate::aarch64::jit::pages::pages_gain_code(&set);
}

/// Other cores wrote `pages`: retire this core's code from them
#[inline(always)]
pub unsafe fn others_wrote(pages: Vec<u32>, overflow: bool) {
    let mut rt = crate::jitrt::state();
    if overflow {
        rt.watch.reset();
    }
    else {
        for page in pages {
            rt.watch.retire(Page::page_of(page << 12), None);
        }
    }
}
