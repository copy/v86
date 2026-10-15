//! Access cache for compiled page functions: x86's caches (one per core) of
//! jitrt::access (docs/jit-unification-plan.md P5.8), whose structure,
//! tags, fills and invalidations are ISA-neutral. Per core, per privilege
//! and per access kind, a direct-mapped table of linear 4 KiB pages whose
//! current translation is plain RAM (and, for writes, holds no compiled
//! code). Page functions look entries up inline; a miss goes to
//! `pages::x64_page_access`.
//!
//! Entries are only ever derived from a successful runtime translation, so a
//! hit is as valid as the x64 TLB entry it came from: every invalidation of a
//! core's x64 TLB (CR writes, INVLPG, EFER, mapping changes, restore) retires
//! that core's entries, and a page that gains compiled code retires the write
//! entries of all cores. Retiring is an epoch step, part of each entry's tag.
use super::physical;
use crate::cpu::memory;
use crate::jitrt::access::{self, AccessCache, Bus, TagLayout};

/// Entries per table: the JIT switch x64_jac_entries (P4.15), 1024, 2048
/// or 4096. The four tables (read supervisor, read user, write supervisor,
/// write user) lie one after another, entries() apart, in room for
/// MAX_ENTRIES each.
pub const MAX_ENTRIES: usize = access::MAX_ENTRIES;
static mut ENTRIES: usize = 2048;
pub fn entries() -> usize { unsafe { ENTRIES } }
pub const ENTRY_BYTES: u32 = access::ENTRY_BYTES;
/// Write tables follow the two read tables (supervisor, user).
pub fn write_offset() -> u32 { 2 * entries() as u32 * ENTRY_BYTES }
/// Tag bits above the largest linear page number of a canonical address.
pub const EPOCH_SHIFT: u32 = 52;
/// x86's tags: the epoch above the linear page number; large pages mark
/// 2 MiB regions
pub const LAYOUT: TagLayout = TagLayout {
    epoch_shift: EPOCH_SHIFT,
    region_shift: 21,
};

static mut JAC: [AccessCache; 8] = [const { AccessCache::NEW }; 8];
fn cache(core: usize) -> &'static mut AccessCache { unsafe { &mut (*(&raw mut JAC))[core] } }

/// x64_jac_entries: every table emptied (the page tier recompiles with the
/// new mask: pages::reset)
pub unsafe fn set_entries(n: usize) -> bool {
    if !matches!(n, 1024 | 2048 | 4096) {
        return false;
    }
    ENTRIES = n;
    for core in 0..8 {
        cache(core).clear();
        flush(core);
    }
    true
}
/// Some write entry maps the VGA frame buffer (see retire_frame_buffer_writes).
static mut FRAME_BUFFER_WRITES: bool = false;

/// Read table base of `core` for the given privilege (host address).
pub unsafe fn base(core: usize, user: bool) -> u32 { cache(core).base(entries(), user as usize) }
/// Tag bits for entries of `core` in its current epoch.
pub unsafe fn epoch_bits(core: usize) -> u64 { cache(core).epoch_bits(LAYOUT) }

pub unsafe fn flush(core: usize) {
    if cache(core).flush(LAYOUT) {
        // (the page tier's code translations carry the epoch too: an old
        // one would match again)
        super::pages::forget_code(core);
    }
}
/// MOV CR3 on `core`: only the entries of global translations stay.
pub unsafe fn flush_nonglobal(core: usize) { cache(core).flush_nonglobal(entries()) }
/// INVLPG `address` on `core`: its x64 TLB entries were invalidated. Entries
/// of 4 KiB translations live only in the page's own slot of each table; an
/// entry from a large page could be in any slot of the large page's range.
pub unsafe fn invlpg(core: usize, address: u64) {
    match cache(core).invalidate_page(LAYOUT, entries(), address) {
        None => {},
        Some(wrapped) => {
            super::pages::COUNTERS[super::pages::COUNT_JAC_LARGE_FLUSH] += 1;
            if wrapped {
                super::pages::forget_code(core);
            }
        },
    }
}
/// The RAM backing page `backing` gained compiled code: page functions must
/// no longer store to it directly (on any core of this instance).
pub unsafe fn retire_writes_to(backing: u32) {
    retire_writes_to_host((memory::mem8 as u32).wrapping_add(backing));
}
/// The same for a page at host address `host` (an extended RAM frame)
pub unsafe fn retire_writes_to_host(host: u32) { retire_writes(|entry| entry.host == host); }
unsafe fn retire_writes(retire: impl Fn(&access::Entry) -> bool) {
    let n = entries();
    for core in 0..crate::cpu::apic::core_count().clamp(1, 8) {
        cache(core).retire_writes(n, &retire);
    }
}
/// With cores in workers: another core published code from the RAM backing
/// page `backing` (crate::parallel::code::poll). Only `core` (this
/// instance's) has entries; its read entries and chaining stay valid.
pub unsafe fn retire_writes_on(core: usize, backing: u32) {
    let host = (memory::mem8 as u32).wrapping_add(backing);
    cache(core).retire_writes(entries(), |entry| entry.host == host);
}
/// Write entries of device memory (a frame buffer) mark their page dirty
/// when they are filled. Once the device has taken its written pages, the
/// next write must mark them again.
pub unsafe fn retire_frame_buffer_writes() {
    if !FRAME_BUFFER_WRITES {
        return;
    }
    FRAME_BUFFER_WRITES = false;
    retire_writes(|entry| crate::cpu::mmio_ram::backs(entry.host));
}
pub unsafe fn flush_all() {
    for core in 0..8 {
        flush(core);
    }
}

/// Record that the linear page of `address` translates to the RAM backing
/// page `backing` (page aligned) for this access kind and privilege; `large`:
/// the translation is part of a 2 MiB or 1 GiB page.
pub unsafe fn fill(
    core: usize,
    user: bool,
    write: bool,
    address: u64,
    backing: u32,
    large: bool,
    global: bool,
) {
    // (P4.15: a live entry of another page in this epoch is a conflict)
    use super::pages::{COUNTERS, COUNT_JAC_CONFLICTS, COUNT_JAC_FILLS};
    COUNTERS[COUNT_JAC_FILLS] += 1;
    let host = (memory::mem8 as u32).wrapping_add(backing);
    if cache(core).fill(LAYOUT, entries(), user, write, address, host, large, global) {
        COUNTERS[COUNT_JAC_CONFLICTS] += 1;
    }
}

/// The backing (relative to mem8) of the device memory page (a frame buffer,
/// crate::cpu::mmio_ram) at physical `address`, which page functions may
/// access directly: it is plain memory in the wasm heap. A write translation
/// marks the page dirty now (retire_frame_buffer_writes undoes it after the
/// device took the page). Not with cores in workers, whose caches the device
/// cannot reach.
pub unsafe fn frame_buffer_backing(address: u64, write: bool) -> Option<u32> {
    let page = address & !4095;
    // (with cores in workers, only the machine instance: it draws the screen)
    if crate::parallel::active() && !crate::parallel::machine_instance() || page >= 1 << 32 {
        return None;
    }
    // decoded by the legacy bus: no relocated RAM or aperture there
    if physical::resolve_backing(page).ok()? != page as u32 {
        return None;
    }
    let host = if write {
        let host = crate::cpu::mmio_ram::write_host(page as u32, 4096)?;
        FRAME_BUFFER_WRITES = true;
        host
    }
    else {
        crate::cpu::mmio_ram::read_host(page as u32, 4096)?
    };
    Some((host as u32).wrapping_sub(memory::mem8 as u32))
}

/// x86's physical bus behind the access cache (jitrt::access::Bus, P5.8)
pub struct X86Bus;
impl Bus for X86Bus {
    /// RAM through the physical bus, never a device or the VGA hole
    #[inline]
    fn ram_backing(&self, physical: u64) -> Option<u32> {
        // ram_page refuses device windows. Not in_mapped_range: the backing of
        // RAM relocated above 4 GiB is a hole of the low bus, yet plain RAM here.
        let page = unsafe { physical::ram_page(physical & !4095) }.ok()?;
        if (0xA0000..0xC0000).contains(&page.backing) {
            return None;
        }
        Some(page.backing)
    }
}
/// The backing page of a guest physical page that page functions may access
/// directly (X86Bus)
pub unsafe fn ram_backing(physical: u64) -> Option<u32> { X86Bus.ram_backing(physical) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tags_retire_by_epoch_and_never_match_zeroed_entries() {
        unsafe {
            let before = epoch_bits(3);
            assert_ne!(before, 0);
            fill(3, true, true, 0xFFFF_8000_1234_5678, 0x5000, false, false);
            let page = 0xFFFF_8000_1234_5678u64 >> 12;
            let e = cache(3).entry(entries(), 3, page);
            assert_eq!(e.tag, page | before);
            // the largest canonical page number stays below the epoch bits
            assert_eq!((u64::MAX >> 12) >> EPOCH_SHIFT, 0);
            flush(3);
            assert_ne!(epoch_bits(3), before);
            assert_ne!(e.tag, page | epoch_bits(3));
            for _ in 0..LAYOUT.epoch_limit() {
                flush(3);
            }
            assert_ne!(cache(3).epoch(), 0);
            assert_eq!(LAYOUT.page(cache(3).entry(entries(), 3, page).tag), 0);
        }
    }
}
