//! Guest RAM beyond the wasm32 backing store
//! (docs/x86-64.md): "extended RAM" at guest
//! physical [base, base + pages * 4 KiB), above the RAM windows of
//! crate::x64::physical. Its pages live in a host store (JavaScript
//! ArrayBuffers, shared with vCPU workers: `js::extended_load` and
//! `js::extended_store` copy one page) and are cached in a pool of 4 KiB
//! frames in the wasm heap.
//!
//! The bus reports the range as neither RAM nor MMIO (`WindowKind::Extended`):
//! TLBs never treat it as RAM, and the interpreter's
//! accesses come here, so a frame can be written back and reused at any of
//! them. One exception makes extended RAM fast enough for an OS to keep its
//! own data there: the access cache of compiled page functions
//! (crate::x64::jac) and the 32-bit TLB of compatibility mode may map a page
//! to its frame (`cache_frame`, with cores on one thread only). Such a frame is marked CACHED and is never reused
//! while marked; when too many are, the dispatch loop's next safe point
//! (`safe_point`, no compiled code active) retires every access cache entry
//! and unmarks them all. A write entry marks the frame dirty up front, as
//! stores through it bypass this module. (Host copies outside the CPU pin
//! their frame, `x64_ext_pin`; with no reusable frame left, an access goes
//! through a separate bounce frame.)
//!
//! Page functions (crate::x64::pages) are compiled from extended pages too,
//! with cores on one thread only. Such a function is keyed by the page, not
//! its frame, so it survives the frame's eviction. The page is marked in
//! `code`; every write reaches it through `resident` (the interpreter, DMA,
//! the bounce frame), which retires the function, and the access cache gets
//! no write entry for it (`cache_frame`).
//! Compatibility-mode helpers, which work with 32-bit bus addresses, reach
//! extended pages through a small aperture in that bus (`aperture`).
//!
//! With cores in workers, one lock serializes the module. It is re-entrant
//! for its owner: a locked read-modify-write instruction holds it from the
//! operand's read to its write (crate::x64::memory::run_locked), which makes
//! the instruction atomic with respect to every other core's accesses here.
//!
//! The frames, the lock and the store are the engine both cores share
//! (crate::extended, docs/arm64-virt-android16-plan.md P8.5); this module is
//! the x86 core's part: the access caches' frames, the page-tier keys, the
//! aperture and the 32-bit TLBs of compatibility mode (crate::isa's
//! extended_* hooks), the exports.

use crate::extended::{self, ext, CACHED, DIRTY, PAGE};
use crate::parallel::machine;

pub use crate::extended::{
    contains, copy_page, lock, or64, range, read, release_held_by, safe_point, unlock,
    unwatch_code, watch_code, write,
};

/// a 32-bit TLB of compatibility mode holds a frame (crate::cpu::cpu::fill_ia32e_tlb)
static mut LEGACY_TLB_CACHED: bool = false;
pub unsafe fn note_legacy_tlb() { LEGACY_TLB_CACHED = true; }

/// (crate::isa::extended_release_caches) every access cache entry and, if
/// they hold frames, the 32-bit TLBs of compatibility mode
pub unsafe fn release_caches() {
    super::jac::flush_all();
    if LEGACY_TLB_CACHED {
        LEGACY_TLB_CACHED = false;
        crate::cpu::context::invalidate_legacy_tlbs();
    }
}
/// (crate::isa::extended_retire_cached_writes) the write entries to a frame
/// whose page now has code
pub unsafe fn retire_cached_writes(host: u32) {
    super::jac::retire_writes_to_host(host);
    if LEGACY_TLB_CACHED {
        LEGACY_TLB_CACHED = false;
        crate::cpu::context::invalidate_legacy_tlbs();
    }
}

/// The host address of the frame of the extended page at `address` for the
/// access cache of compiled page functions (crate::x64::pages), or None:
/// with cores in workers (their access caches cannot be retired at one
/// safe point), when no frame is reusable before the next safe point, or
/// for a write to a page with page-tier code (the interpreter's write
/// retires that code)
pub unsafe fn cache_frame(address: u64, write: bool) -> Option<u32> {
    if crate::parallel::active() || !contains(address) {
        return None;
    }
    let e = ext();
    let page = ((address - e.base) / PAGE) as u32;
    if write && extended::has_code(e, page) {
        return None;
    }
    let frame = extended::resident(e, page, write)?;
    extended::mark_cached(e, frame);
    // (stores through the entry are not seen here)
    if write {
        e.frame_state[frame as usize] |= DIRTY;
    }
    debug_assert!(e.frame_state[frame as usize] & CACHED != 0);
    Some(e.pool.add(frame as usize * PAGE as usize) as u32)
}

/// Page functions of extended pages have keys from here on
/// (crate::x64::pages): above every RAM backing page number
pub const CODE_KEY_BASE: u32 = 1 << 20;

/// The page-tier key of the extended page at `address`, or None: not
/// extended RAM, or cores run in workers (their writes are not tracked in
/// `code`; see crate::x64::pages::retire_extended)
pub unsafe fn code_key(address: u64) -> Option<u32> {
    if crate::parallel::active() || !contains(address) {
        return None;
    }
    Some(CODE_KEY_BASE + ((address - ext().base) / PAGE) as u32)
}

/// A locked instruction's operand is here: keep the lock until it ends
pub unsafe fn begin_locked_operand() {
    lock();
    ext().stats[extended::STAT_LOCKED] += 1;
}

pub mod aperture {
    //! Compatibility-mode (32-bit) memory helpers take 32-bit bus
    //! addresses (crate::x64::memory::legacy_translate). An extended page
    //! gets a slot of this aperture, a range of the 32-bit bus the platform
    //! leaves unused (above the local APIC, below the BIOS; not between the
    //! IOAPIC and the local APIC, where Q35 has its HPET at 0xFED00000 and
    //! its root complex registers at 0xFED1C000): an address in it reaches
    //! the page through crate::cpu::memory's mapped (MMIO) path, never
    //! cached, never compiled from. Each core reuses its own slots in order,
    //! so the few pages one instruction touches keep theirs.
    use super::*;

    pub const BASE: u32 = 0xFEF0_0000;
    const SLOTS_PER_CORE: u32 = 32;
    pub const SIZE: u32 = crate::parallel::MAX_CORES as u32 * SLOTS_PER_CORE * PAGE as u32;

    static mut SLOT_PAGE: [u64; crate::parallel::MAX_CORES * SLOTS_PER_CORE as usize] =
        [u64::MAX; crate::parallel::MAX_CORES * SLOTS_PER_CORE as usize];
    static mut NEXT: [u32; crate::parallel::MAX_CORES] = [0; crate::parallel::MAX_CORES];

    #[inline]
    pub fn contains(address: u32) -> bool { address.wrapping_sub(BASE) < SIZE }

    /// The bus address of the extended RAM byte at `address`
    pub unsafe fn map(address: u64) -> u32 {
        let core = crate::cpu::apic::current_core();
        let page = address & !(PAGE - 1);
        let slots = machine(&raw mut SLOT_PAGE)
            .cast::<u64>()
            .add(core * SLOTS_PER_CORE as usize);
        let mut slot = SLOTS_PER_CORE;
        for i in 0..SLOTS_PER_CORE {
            if *slots.add(i as usize) == page {
                slot = i;
                break;
            }
        }
        if slot == SLOTS_PER_CORE {
            let next = machine(&raw mut NEXT).cast::<u32>().add(core);
            slot = *next;
            *next = (slot + 1) % SLOTS_PER_CORE;
            *slots.add(slot as usize) = page;
            ext().stats[extended::STAT_APERTURE] += 1;
        }
        BASE + (core as u32 * SLOTS_PER_CORE + slot) * PAGE as u32 + (address % PAGE) as u32
    }

    /// The guest physical address behind an aperture address, if it has one
    pub unsafe fn guest(address: u32) -> Option<u64> {
        if !contains(address) {
            return None;
        }
        let index = ((address - BASE) / PAGE as u32) as usize;
        let page = *machine(&raw mut SLOT_PAGE).cast::<u64>().add(index);
        (page != u64::MAX && super::contains(page)).then_some(page + (address as u64 % PAGE))
    }

    pub unsafe fn clear() {
        let slots = machine(&raw mut SLOT_PAGE).cast::<u64>();
        for i in 0..crate::parallel::MAX_CORES * SLOTS_PER_CORE as usize {
            *slots.add(i) = u64::MAX;
        }
    }

    /// An aperture byte (for the mapped path of crate::cpu::memory)
    pub unsafe fn read8(address: u32) -> Option<u8> {
        guest(address).map(|at| super::read(at, 1) as u8)
    }
    pub unsafe fn write8(address: u32, value: u8) -> bool {
        guest(address)
            .map(|at| super::write(at, 1, value as u64))
            .is_some()
    }
    /// An aligned dword within one aperture page
    pub unsafe fn read32(address: u32) -> Option<u32> {
        guest(address).map(|at| super::read(at, 4) as u32)
    }
    pub unsafe fn write32(address: u32, value: u32) -> bool {
        guest(address)
            .map(|at| super::write(at, 4, value as u64))
            .is_some()
    }
}

/// Configure extended RAM (machine instance, before the cores run): `pages`
/// pages at guest physical `base`, cached in `frames` frames. 0 pages removes it.
#[no_mangle]
pub unsafe fn x64_ext_configure(base_low: u32, base_high: u32, pages: u32, frames: u32) -> bool {
    let base = (base_high as u64) << 32 | base_low as u64;
    if pages != 0 && base < 1 << 32 {
        return false;
    }
    extended::configure(base, pages, frames)
}

/// Write back every dirty frame (the store is then complete: snapshots)
#[no_mangle]
pub unsafe fn x64_ext_flush() { extended::flush() }

/// Forget every frame without writing it back (the store was replaced:
/// snapshot restore, power-on). Every core is stopped.
#[no_mangle]
pub unsafe fn x64_ext_discard() { extended::discard() }

/// The frame of extended page `page` for a host copy (DMA, debugging),
/// resident until x64_ext_unpin: its address in wasm memory
#[no_mangle]
pub unsafe fn x64_ext_pin(page: u32, write: bool) -> u32 { extended::pin(page, write) }
#[no_mangle]
pub unsafe fn x64_ext_unpin(page: u32) { extended::unpin(page) }

/// (crate::extended::stat)
#[no_mangle]
pub unsafe fn x64_ext_stat(field: u32) -> f64 { extended::stat(field) }
