//! The ARM core's side of the code both cores share (lib.rs names this
//! module `crate::isa` in the ARM core; cpu::isa_hooks is the x86 core's).
//! Parallel cores are P8.2: until then the hooks that only workers reach
//! are empty.
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

#[inline(always)]
pub unsafe fn machine_set_active() {}
#[inline(always)]
pub unsafe fn attach_worker(_core: u32) {}
#[inline(always)]
pub unsafe fn sync_worker() {}
#[inline(always)]
pub unsafe fn sync_worker_configuration() {}
#[inline(always)]
pub unsafe fn release_locks_held_by(_core: usize) {}
#[inline(always)]
pub unsafe fn lock_for_test_fault() {}

/// Other cores published code from `pages`: (the ARM core's TLB keeps no
/// write translations yet)
#[inline(always)]
pub unsafe fn others_published(_pages: &[u32], _overflow: bool) {}

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
