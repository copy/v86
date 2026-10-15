//! The x86 core's composition root of compiled code
//! (docs/jit-unification-plan.md P5.1): whether it runs (jit_set_enabled),
//! the wiring of the ISA-neutral runtime crate::jitrt to the CPU (its host
//! environment, the x64 page tier as the client X86Page that hears of writes
//! and resets), and the hot-path compositions that stay here
//! (page_watched). Writes to a physical page compiled code was made from
//! (self-modifying code, DMA, host writes) retire that code. (The IR region
//! tiers shared it until M11 deleted them.)
use std::collections::HashSet;

use crate::cpu::cpu;
use crate::jitrt::host::Env;
use crate::jitrt::table::{Owner, Signature};
use crate::jitrt::watch::Trigger;
use crate::jitrt::{self, ClientId};
use crate::page::Page;
use crate::profiler;
use crate::profiler::stat;

mod unsafe_jit {
    #[link(wasm_import_module = "env")]
    extern "C" {
        pub fn jit_clear_func(wasm_table_index: u16);
    }
}

// needs to be synced to const.js
pub const WASM_TABLE_SIZE: u32 = 12000;

/// Whether compiled code runs (CPU.configure_jit_backend: not disable_jit;
/// the region tiers' scheduler held it until M11)
static mut ENABLED: bool = false;
#[no_mangle]
pub unsafe fn jit_set_enabled(enabled: u32) -> bool {
    if enabled > 1 {
        return false;
    }
    ENABLED = enabled == 1;
    true
}
#[inline(always)]
pub fn enabled() -> bool { unsafe { ENABLED } }
/// Whether the JIT compiles (get_jit_info's ir.enabled)
#[no_mangle]
pub fn jit_is_enabled() -> bool { enabled() }
/// 32-bit and 16-bit code in the x64 page tier (the JIT switch ir_tier0,
/// set by CPU.configure_jit_backend unless its setting ir_tier0 is false;
/// the region tiers' scheduler set it until M11)
#[no_mangle]
pub unsafe fn jit_set_page32(enabled: u32) -> bool {
    if enabled > 1 {
        return false;
    }
    crate::x64::pages::set_page32_tier0(enabled == 1);
    if enabled == 1 {
        reserve_compiler_heap();
    }
    true
}
/// Grow the Wasm heap once for the compiler's working set: every later
/// memory.grow of the (multi-GiB) guest memory makes the host re-account it as
/// external memory and collect, so many small grows cost far more than one.
/// (The region tiers' scheduler did this for the page tier's 32-bit code
/// until M11; CPU.configure_jit_backend sets ir_tier0 before the guest's RAM
/// is allocated, which takes the freed chunks' place: cpu::memory.)
fn reserve_compiler_heap() {
    static mut RESERVED: bool = false;
    unsafe {
        if RESERVED {
            return;
        }
        RESERVED = true;
    }
    // Freed chunks stay in the allocator's free lists.
    let chunks: Vec<Vec<u8>> = (0..16).map(|_| Vec::with_capacity(2 << 20)).collect();
    drop(chunks);
}

/// Whether this build has Wasm SIMD: the portable one (build/v86-fallback.wasm)
/// has none, and the page tier declines the forms whose templates need it
/// (ir_wasm_simd_supported until M11 of docs/jit-unification-plan.md).
#[no_mangle]
pub extern "C" fn jit_wasm_simd_supported() -> u32 { u32::from(cfg!(target_feature = "simd128")) }

#[no_mangle]
pub fn rust_init() {
    #[cfg(target_arch = "wasm32")]
    unsafe {
        *crate::cpu::global_pointers::ir_tlb_base = std::ptr::addr_of!(cpu::tlb_data) as u32;
    }
    jitrt::init(Env {
        table_size: WASM_TABLE_SIZE,
        table_offset: cpu::WASM_TABLE_OFFSET,
        state_base: crate::cpu::global_pointers::state_base(),
        mem8: || unsafe { crate::cpu::memory::mem8 },
        now: || unsafe { cpu::js::microtick() },
        core: crate::cpu::apic::current_core,
        clear_slot: |slot| unsafe { unsafe_jit::jit_clear_func(slot as u16) },
        page_has_code: cpu::tlb_set_has_code,
        pages_gain_code: |pages| {
            cpu::tlb_set_has_code_multiple(pages, true);
            // x64 page functions store through cached write translations of
            // pages without code; these pages may be among them.
            for page in pages {
                unsafe { crate::x64::jac::retire_writes_to(page.to_address()) };
            }
        },
        claim: |page, on| unsafe {
            if on {
                crate::parallel::code::claim(page)
            }
            else {
                crate::parallel::code::release(page)
            }
        },
        release_all: || unsafe { crate::parallel::code::release_all() },
    });
    {
        let mut rt = jitrt::state();
        // (with cores in workers, the other cores hear of every write: crate::parallel::code)
        rt.watch.on_dirty(Trigger::Always, |page, _| {
            unsafe { crate::parallel::code::written(page) };
            Vec::new()
        });
        rt.watch
            .on_dirty(Trigger::WatchedOnly, |page, bytes| match bytes {
                Some((lo, hi)) => crate::x64::pages::dirty_bytes(page, lo, hi),
                None => {
                    crate::x64::pages::dirty_page(page);
                    Vec::new()
                },
            });
        rt.watch.on_reset(crate::x64::pages::reset);
    }
    jitrt::publish::register(
        ClientId::X86Page,
        jitrt::publish::Client {
            install: crate::x64::pages::x64_page_install,
            ready: crate::x64::pages::x64_page_ready,
            cancel: crate::x64::pages::x64_page_cancel,
        },
    );

    use std::panic;

    panic::set_hook(Box::new(|panic_info| {
        console_log!("{}", panic_info.to_string());
    }));
}

/// A write to the page: retire the code compiled from it, here and
/// (crate::parallel::code) in other cores' workers.
fn dirty_page(page: Page) {
    if !jitrt::state().watch.write(page, None) {
        profiler::stat_increment(stat::DIRTY_PAGE_DID_NOT_HAVE_CODE);
    }
}

/// Another core wrote the page (crate::parallel::code::poll): retire this
/// instance's code from it
pub fn jit_retire_page(page: Page) {
    if !jitrt::state().watch.retire(page, None) {
        profiler::stat_increment(stat::DIRTY_PAGE_DID_NOT_HAVE_CODE);
    }
}

#[no_mangle]
pub fn jit_dirty_cache(start_addr: u32, end_addr: u32) {
    dbg_assert!(start_addr < end_addr);

    let start_page = Page::page_of(start_addr);
    let end_page = Page::page_of(end_addr - 1);

    for page in start_page.to_u32()..end_page.to_u32() + 1 {
        dirty_page(Page::page_of(page << 12));
    }
}

#[no_mangle]
pub fn jit_dirty_page(page: Page) { dirty_page(page) }

/// A write of `len` bytes at physical `addr`, within one page: as
/// jit_dirty_page, where code the write misses may stay (the x64 page
/// tier's dirty_bytes)
pub fn jit_dirty_bytes(addr: u32, len: u32) {
    let page = Page::page_of(addr);
    dbg_assert!(Page::page_of(addr + len - 1) == page);
    let lo = addr & 0xFFF;
    if !jitrt::state().watch.write(page, Some((lo, lo + len))) {
        profiler::stat_increment(stat::DIRTY_PAGE_DID_NOT_HAVE_CODE);
    }
}

/// jit_dirty_bytes for the bytes start..end, which span at most two pages
/// (the RAM writers of crate::cpu::memory, through which compatibility-mode
/// code's writes go: M9)
pub fn jit_dirty_bytes_small(start: u32, end: u32) {
    dbg_assert!(start < end);
    let split = (start & !0xFFF).wrapping_add(0x1000);
    if end <= split || split == 0 {
        jit_dirty_bytes(start, end - start);
    }
    else {
        jit_dirty_bytes(start, split - start);
        jit_dirty_bytes(split, end - split);
    }
}

/// dirty pages in the range of start_addr and end_addr, which must span at most two pages
pub fn jit_dirty_cache_small(start_addr: u32, end_addr: u32) {
    dbg_assert!(start_addr < end_addr);

    let start_page = Page::page_of(start_addr);
    let end_page = Page::page_of(end_addr - 1);

    dirty_page(start_page);

    // Note: This can't happen when paging is enabled, as writes across
    //       boundaries are split up on two pages
    if start_page != end_page {
        dbg_assert!(start_page.to_u32() + 1 == end_page.to_u32());
        dirty_page(end_page);
    }
}

#[no_mangle]
pub fn jit_clear_cache_js() { jitrt::state().watch.reset() }

/// Whether compiled code (a published function's source) lies on the page.
pub fn jit_page_has_code(page: Page) -> bool { jitrt::state().watch.watched(page) }

/// Whether stores to the page must take the slow path: this instance or,
/// with cores in workers, another core compiled code from it. Used for new
/// translations (TLB fills, write translation caches).
pub fn page_needs_notification(page: Page) -> bool {
    jit_page_has_code(page) || unsafe { crate::parallel::code::others_own(page.to_u32()) }
}

/// Whether x64 page-tier code was compiled from this backing page, by this
/// instance or (with cores in workers) another: writes must notify.
#[inline(always)]
pub fn page_watched(page: u32) -> bool {
    jitrt::watch::bit(page) || unsafe { crate::parallel::code::others_own(page) }
}

/// Whether every page this code depends on is published to the other cores
/// (crate::parallel::code), so that it may be installed, waiting up to `ms`
/// for their acknowledgements
pub fn wait_pages_published(pages: impl Iterator<Item = Page> + Clone, ms: f64) -> bool {
    unsafe { crate::parallel::code::wait_published(pages.map(|page| page.to_u32()), ms) }
}

/// The fewest free table slots since the last jit_wasm_table_free_low_reset
/// (docs/jit-unification-plan.md P0.10)
#[no_mangle]
pub fn jit_wasm_table_free_low() -> u32 { jitrt::state().table.free_low() }
#[no_mangle]
pub fn jit_wasm_table_free_low_reset() { jitrt::state().table.reset_free_low() }

/// A slot for an x64 page function (the client X86Page, code `id`) compiled
/// from `pages`, which it watches from now on
pub fn reserve_page_slot(id: u64, pages: HashSet<Page>) -> Option<u32> {
    let mut rt = jitrt::state();
    let slot = rt.table.reserve(Owner {
        client: ClientId::X86Page,
        signature: Signature::Fn1Ret,
        id,
    })?;
    rt.watch.attach(slot, pages);
    Some(slot)
}

/// Called only at a cold/quiescent point. The owner protects a reused slot
/// from old callbacks by `id`.
pub fn release_page_slot(slot: u32, id: u64) -> bool {
    let mut rt = jitrt::state();
    if !rt.table.release(slot, ClientId::X86Page, id) {
        return false;
    }
    rt.watch.detach(slot);
    // It is not strictly necessary to clear the function, but it will fail
    // more predictably if we accidentally use the function and may garbage
    // collect unused modules earlier
    (jitrt::host::env().clear_slot)(slot);
    true
}

#[no_mangle]
pub fn jit_get_wasm_table_index_free_list_count() -> u32 { jitrt::state().table.free_count() }
