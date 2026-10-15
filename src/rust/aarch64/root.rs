//! The ARM core's composition root (the x86 core's is crate::jit): the host
//! environment of the ISA-neutral runtime crate::jitrt, and what happens to
//! compiled code when guest memory is written or the address space changes.
//! Its code client is the A64 page tier (crate::aarch64::jit, the JIT plan's
//! J2).
use std::collections::HashSet;

use crate::aarch64::bus;
use crate::jitrt::table::{Owner, Signature};
use crate::jitrt::watch::Trigger;
use crate::jitrt::{self, host::Env, ClientId};
use crate::page::Page;

#[cfg(target_arch = "wasm32")]
mod js {
    #[link(wasm_import_module = "env")]
    extern "C" {
        pub fn jit_clear_func(wasm_table_index: u16);
    }
}
#[cfg(not(target_arch = "wasm32"))]
mod js {
    pub unsafe fn jit_clear_func(_wasm_table_index: u16) {}
}

/// The table's geometry: as the x86 core's (src/const.js)
pub const WASM_TABLE_SIZE: u32 = 12000;
pub const WASM_TABLE_OFFSET: u32 = 1024;

#[no_mangle]
pub fn rust_init() {
    jitrt::init(Env {
        table_size: WASM_TABLE_SIZE,
        table_offset: WASM_TABLE_OFFSET,
        state_base: crate::state_block::state_base(),
        mem8: || unsafe { bus::MEM8 },
        now: || unsafe { crate::isa::microtick() },
        core: crate::isa::current_core,
        clear_slot: |slot| unsafe { js::jit_clear_func(slot as u16) },
        page_has_code: |_, _| {},
        // (write entries of the access cache to pages that gained code retire)
        pages_gain_code: crate::aarch64::jit::pages::pages_gain_code,
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
    // (a new map invalidates every translation compiled code made)
    bus::on_map_changed(|| jitrt::state().watch.reset());
    // the A64 page tier: publication's answers; a write to a page retires the
    // functions compiled from it (each mode's), a reset all of them
    crate::aarch64::jit::pages::register();
    // (the whole table is the A64 page tier's: jitrt::capacity)
    jitrt::capacity::set_quota(ClientId::A64Page, crate::aarch64::jit::pages::MAX_FUNCTIONS);
    // (its counters through jit_stat(1, field), P5.10)
    jitrt::stat::register(ClientId::A64Page, crate::aarch64::jit::pages::a64_page_stat);
    jitrt::state()
        .watch
        .on_dirty(Trigger::WatchedOnly, |page, _| {
            unsafe { TEST_RETIRED += 1 };
            crate::aarch64::jit::pages::page_written(page);
            Vec::new()
        });
    jitrt::state()
        .watch
        .on_reset(crate::aarch64::jit::pages::retire_all);
    std::panic::set_hook(Box::new(|panic_info| {
        console_log!("{}", panic_info.to_string());
    }));
}

/// The fewest free table slots since the last jit_wasm_table_free_low_reset
/// (as the x86 core's, src/rust/jit.rs)
#[no_mangle]
pub fn jit_wasm_table_free_low() -> u32 { jitrt::state().table.free_low() }
#[no_mangle]
pub fn jit_wasm_table_free_low_reset() { jitrt::state().table.reset_free_low() }

/// Drop all compiled code (a snapshot was restored, guest memory changed under it)
#[no_mangle]
pub fn jit_clear_cache_js() { jitrt::state().watch.reset() }

/// Whether code was compiled from this page of guest memory, by this
/// instance or (with cores in workers) another: writes must notify
#[inline(always)]
pub fn page_watched(page: u32) -> bool {
    jitrt::watch::bit(page) || unsafe { crate::parallel::code::others_own(page) }
}

/// A write of the bytes lo..hi of the page: retire the code compiled from it
pub fn dirty_bytes(page: Page, lo: u32, hi: u32) {
    jitrt::state().watch.write(page, Some((lo, hi)));
}

/// Writes that retired a page a64_test_watch_page watched
static mut TEST_RETIRED: u32 = 0;
/// Tests (tests/a64/address_space.mjs), until the A64 page tier (P6) has
/// code: watch the guest-memory page `page` (a code key) as code compiled
/// from it would be watched
#[no_mangle]
pub fn a64_test_watch_page(page: u32) -> bool {
    let mut rt = jitrt::state();
    let Some(slot) = rt.table.reserve(Owner {
        client: ClientId::A64Page,
        signature: Signature::Fn1,
        id: page as u64,
    })
    else {
        return false;
    };
    rt.watch
        .attach(slot, HashSet::from([Page::page_of(page << 12)]));
    true
}
#[no_mangle]
pub fn a64_test_retired() -> u32 { unsafe { TEST_RETIRED } }
