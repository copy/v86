//! The ARM core's extended RAM (docs/arm64-virt-android16-plan.md P8.5):
//! guest RAM beyond the one allocation of guest memory in the wasm32 heap,
//! at guest physical 4 GiB on (the device tree's second memory range),
//! through the engine both cores share (crate::extended: a host store and
//! a pool of frames).
//!
//! The bus maps the range as `Kind::Extended` (crate::aarch64::bus): the
//! interpreter's accesses, the table walks and instruction fetches come
//! here a page at a time. The page tier's access cache maps a page to its
//! frame (`cache_frame`, with the cores in one instance, as x86's), which is
//! then CACHED and not reused before the run loop's next safe point
//! (crate::extended::safe_point in crate::aarch64::smp::run_core) retires
//! every access cache entry. The page tier compiles code from it under the code
//! keys from bus::EXTENDED_CODE_KEY on, which its next write retires
//! (crate::extended's code watch); with the cores in workers that code is
//! interpreted. The exclusive monitors know its granules by keys above
//! every backing offset of guest memory (`monitor_key`).

use crate::extended::{self, PAGE};

/// The monitors' keys of extended RAM (smp::reserve takes a guest memory
/// offset, below 2 GiB): from 2 GiB on, the offset modulo 2 GiB - 64 KiB
/// (so that a page's keys do not wrap; an alias only clears a reservation,
/// which the guest retries)
pub const KEY_BASE: u32 = 0x8000_0000;
const KEY_SPAN: u64 = 0x7FFF_0000;

#[inline(always)]
pub fn monitor_key(address: u64) -> u32 {
    let base = extended::ext().base;
    KEY_BASE + (address.wrapping_sub(base) % KEY_SPAN) as u32
}

/// The host address of the frame of the extended page at `address` for the
/// page tier's access cache (crate::aarch64::jit::pages::a64_page_access),
/// or None: with the cores in workers (their access caches cannot be retired
/// at one safe point), when no frame is reusable before the next safe point,
/// or for a write to a page with compiled code (the interpreter's write
/// retires that code). A write entry's frame is dirty from here on: stores
/// through it do not come here.
pub unsafe fn cache_frame(address: u64, write: bool) -> Option<u32> {
    if crate::parallel::active() || !extended::contains(address) {
        return None;
    }
    let e = extended::ext();
    let page = ((address - e.base) / PAGE) as u32;
    if write && extended::has_code(e, page) {
        return None;
    }
    let frame = extended::resident(e, page, write)?;
    extended::mark_cached(e, frame);
    Some(e.pool.add(frame as usize * PAGE as usize) as u32)
}

/// The frames' host addresses, [start, end)
pub unsafe fn frame_range() -> (u32, u32) {
    let e = extended::ext();
    let start = e.pool as u32;
    (start, start.wrapping_add(e.frames * PAGE as u32))
}

/// Instructions from extended RAM: [0] interpreted (fetched), [1] retired by compiled code
pub static mut RETIRED: [u64; 2] = [0; 2];

/// The instruction at `address` (an interpreted fetch)
#[inline(never)]
pub unsafe fn fetch(address: u64) -> u32 {
    RETIRED[0] += 1;
    extended::read(address, 4) as u32
}

/// `width` (1, 2, 4 or 8) bytes at `address` (accesses across pages byte by byte)
pub unsafe fn read(address: u64, width: u32) -> u64 {
    if address % PAGE + width as u64 > PAGE {
        let mut value = 0;
        for i in 0..width as u64 {
            value |= extended::read(address + i, 1) << (8 * i);
        }
        return value;
    }
    extended::read(address, width as usize)
}

/// A core's write: other cores' reservations of the granules clear
pub unsafe fn write(address: u64, width: u32, value: u64) {
    if address % PAGE + width as u64 > PAGE {
        for i in 0..width as u64 {
            extended::write(address + i, 1, value >> (8 * i) & 0xFF);
        }
    }
    else {
        extended::write(address, width as usize, value);
    }
    crate::aarch64::smp::monitors_written(monitor_key(address), width, false);
}

/// Configure extended RAM (before the cores run): `pages` pages at guest
/// physical `base` (at or above 4 GiB, not over another region), cached in
/// `frames` frames; mapped into the address space
#[no_mangle]
pub unsafe fn a64_ext_configure(base_low: u32, base_high: u32, pages: u32, frames: u32) -> bool {
    let base = (base_high as u64) << 32 | base_low as u64;
    if pages == 0 || base < 1 << 32 {
        return false;
    }
    extended::configure(base, pages, frames)
        && crate::aarch64::bus::map_extended(base, pages as u64 * PAGE)
}

/// Write back every dirty frame (the store is then complete: snapshots)
#[no_mangle]
pub unsafe fn a64_ext_flush() { extended::flush() }

/// Forget every frame without writing it back (the store was replaced:
/// snapshot restore, power-on). Every core is stopped.
#[no_mangle]
pub unsafe fn a64_ext_discard() { extended::discard() }

/// The frame of extended page `page` for a host copy (a device's DMA, the
/// loader, debugging), resident until a64_ext_unpin: its address in wasm
/// memory. For a write, every core's reservation in the page clears.
#[no_mangle]
pub unsafe fn a64_ext_pin(page: u32, write: bool) -> u32 {
    let pointer = extended::pin(page, write);
    if write && pointer != 0 {
        let base = extended::ext().base;
        crate::aarch64::smp::monitors_written(
            monitor_key(base + page as u64 * PAGE),
            PAGE as u32,
            true,
        );
    }
    pointer
}
#[no_mangle]
pub unsafe fn a64_ext_unpin(page: u32) { extended::unpin(page) }

/// (crate::extended::stat); 16 instructions interpreted from extended RAM,
/// 17 retired there by compiled code
#[no_mangle]
pub unsafe fn a64_ext_stat(field: u32) -> f64 {
    match field {
        16 | 17 => RETIRED[field as usize - 16] as f64,
        _ => extended::stat(field),
    }
}
