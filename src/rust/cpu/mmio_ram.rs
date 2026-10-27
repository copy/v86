//! Device memory in the guest's physical address space: plain wasm memory
//! that a device owns -- the VGA core's frame buffer (every display adapter),
//! VMware SVGA's command FIFO, virtio-gpu's host visible memory, the UEFI
//! firmware's flash -- decoded where the device's PCI memory BAR currently is
//! (the flash: below 4 GiB). The guest reads and writes
//! it at memory speed; each region keeps a bitmap of the 4 KiB pages written
//! since its device last took them, and can convert those pages into an RGBA
//! picture for the screen. A read-only region (the flash in its read mode)
//! leaves writes to the memory map's handlers.
//!
//! Regions are page aligned and a whole number of pages, so an access that
//! does not cross a page boundary is entirely inside one region or outside all
//! of them. The table belongs to the machine instance: with cores in workers,
//! every instance looks regions up (and marks pages) through
//! crate::parallel::machine, and the backing and bitmaps are shared memory.

#![allow(static_mut_refs)]

use crate::cpu::global_pointers;
use crate::parallel;

use std::alloc;
use std::ptr;

pub const MAX_REGIONS: usize = 6;
const PAGE_SIZE: u32 = 4096;

#[derive(Clone, Copy)]
pub struct Region {
    /// Guest physical address of the first byte, while `mapped`
    pub base: u32,
    pub size: u32,
    pub mapped: bool,
    /// The device asked for it at `base` (mmio_ram_map): it is mapped there
    /// whenever that is possible (see mmio_ram_reserve)
    pub requested: bool,
    /// Writes reach the memory; otherwise they go to the memory map
    /// (crate::cpu::memory's ext::mmap_write*)
    pub writable: bool,
    /// The memory itself, in the wasm heap
    pub backing: *mut u8,
    /// One bit per page, written since the device last took them
    pub dirty: *mut u64,
    pub dirty_words: u32,
}

const EMPTY: Region = Region {
    base: 0,
    size: 0,
    mapped: false,
    requested: false,
    writable: true,
    backing: ptr::null_mut(),
    dirty: ptr::null_mut(),
    dirty_words: 0,
};

struct Table {
    regions: [Region; MAX_REGIONS],
    count: usize,
    /// RGBA pictures converted from a region (mmio_ram_fill_pixels)
    pixels: [Vec<u32>; MAX_REGIONS],
    /// Bitmap words taken from a region (mmio_ram_take_dirty)
    taken: [Vec<u64>; MAX_REGIONS],
    /// [start, end) that the chipset decodes before any device (mmio_ram_reserve)
    reserved: (u32, u32),
}

const NEW_TABLE: Table = Table {
    regions: [EMPTY; MAX_REGIONS],
    count: 0,
    pixels: [const { Vec::new() }; MAX_REGIONS],
    taken: [const { Vec::new() }; MAX_REGIONS],
    reserved: (0, 0),
};

#[cfg(not(test))]
static mut TABLE: Table = NEW_TABLE;

#[cfg(test)]
thread_local! {
    /// cargo test: the table of the test thread (the tests run in parallel)
    static TEST_TABLE: std::cell::UnsafeCell<Table> =
        const { std::cell::UnsafeCell::new(NEW_TABLE) };
}

#[inline(always)]
fn table() -> &'static mut Table {
    #[cfg(test)]
    return TEST_TABLE.with(|table| unsafe { &mut *table.get() });
    #[cfg(not(test))]
    unsafe {
        &mut *parallel::machine(&raw mut TABLE)
    }
}

/// The mapped region that contains all of [address, address + bytes)
#[inline]
pub fn find(address: u32, bytes: u32) -> Option<&'static Region> {
    let table = table();
    for region in table.regions[..table.count].iter() {
        let offset = address.wrapping_sub(region.base);
        if region.mapped && offset < region.size && bytes <= region.size - offset {
            return Some(region);
        }
    }
    None
}

/// Whether a mapped region decodes `address`
#[inline]
pub fn contains(address: u32) -> bool { find(address, 1).is_some() }

/// Whether the page at `address` (page aligned) is in a mapped read-only
/// region: its bytes do not change while that holds (mmio_ram_map,
/// mmio_ram_unmap and mmio_ram_set_writable retire code compiled from it)
#[inline]
pub fn read_only_page(address: u32) -> bool {
    find(address, PAGE_SIZE).map_or(false, |r| !r.writable)
}

/// Whether a mapped region decodes `address` and takes writes
#[inline]
pub fn contains_writable(address: u32) -> bool { find(address, 1).map_or(false, |r| r.writable) }

/// The memory behind [address, address + bytes) of a region, for reading
#[inline]
pub unsafe fn read_host(address: u32, bytes: u32) -> Option<*mut u8> {
    let region = find(address, bytes)?;
    Some(region.backing.add((address - region.base) as usize))
}

/// The memory behind [address, address + bytes) of a region, for writing:
/// the pages it touches are marked written. None for a read-only region.
#[inline]
pub unsafe fn write_host(address: u32, bytes: u32) -> Option<*mut u8> {
    let region = find(address, bytes).filter(|r| r.writable)?;
    let offset = address - region.base;
    let last = offset + bytes.max(1) - 1;
    for page in offset / PAGE_SIZE..=last / PAGE_SIZE {
        mark_page(region, page);
    }
    Some(region.backing.add(offset as usize))
}

#[inline]
unsafe fn mark_page(region: &Region, page: u32) {
    dbg_assert!(page >> 6 < region.dirty_words);
    parallel::or64(
        region.dirty.add((page >> 6) as usize).cast(),
        1 << (page & 63),
    )
}

/// Whether `host` is the memory of any region (the x64 page tier's direct
/// translations of written pages must be retired once the pages are taken)
pub fn backs(host: u32) -> bool {
    let table = table();
    table.regions[..table.count]
        .iter()
        .any(|region| host.wrapping_sub(region.backing as u32) < region.size)
}

/// Take a bitmap word: its pages are no longer written as far as the next
/// call knows. Atomic, since cores in workers may be marking pages.
unsafe fn take_word(word: *mut u64) -> u64 {
    #[cfg(feature = "parallel")]
    {
        use std::sync::atomic::{AtomicU64, Ordering::SeqCst};
        (*(word as *const AtomicU64)).swap(0, SeqCst)
    }
    #[cfg(not(feature = "parallel"))]
    {
        let value = *word;
        *word = 0;
        value
    }
}

unsafe fn region(id: u32) -> Option<&'static mut Region> {
    let table = table();
    if (id as usize) < table.count {
        Some(&mut table.regions[id as usize])
    }
    else {
        None
    }
}

/// A new region of `size` bytes (a multiple of 4 KiB), unmapped and zeroed
/// @return its id, or -1
#[no_mangle]
pub unsafe fn mmio_ram_allocate(size: u32) -> i32 {
    let table = table();
    if table.count == MAX_REGIONS || size == 0 || size % PAGE_SIZE != 0 {
        dbg_assert!(false, "mmio_ram_allocate: no region or bad size");
        return -1;
    }
    let pages = size / PAGE_SIZE;
    let dirty_words = (pages + 63) / 64;
    let backing = alloc::alloc_zeroed(alloc::Layout::from_size_align(size as usize, 4096).unwrap());
    let dirty =
        alloc::alloc_zeroed(alloc::Layout::array::<u64>(dirty_words as usize).unwrap()) as *mut u64;
    if backing.is_null() || dirty.is_null() {
        return -1;
    }
    let id = table.count;
    table.regions[id] = Region {
        base: 0,
        size,
        mapped: false,
        requested: false,
        writable: true,
        backing,
        dirty,
        dirty_words,
    };
    table.count += 1;
    id as i32
}

/// The region's memory, relative to the start of the wasm memory
#[no_mangle]
pub unsafe fn mmio_ram_backing(id: u32) -> u32 { region(id).map_or(0, |r| r.backing as u32) }

/// Whether nothing but devices is decoded at [base, base + size): not RAM,
/// not the legacy ranges below 1 MiB. A BAR the guest clears or has not
/// assigned yet must not shadow memory.
#[cfg(not(test))]
unsafe fn free_for_devices(base: u32, size: u32) -> bool {
    let last = base + (size - 1);
    base >= 0x100000
        && crate::cpu::memory::in_mapped_range(base)
        && crate::cpu::memory::in_mapped_range(last)
}
#[cfg(test)]
unsafe fn free_for_devices(base: u32, _size: u32) -> bool { base >= 0x100000 }

/// Whether a region of `size` bytes can be decoded at `base`: in the 32-bit
/// space, page aligned, free for devices and outside the reserved window
unsafe fn decodable(base: u32, size: u32) -> bool {
    let (start, end) = table().reserved;
    base as u64 + size as u64 <= 1 << 32
        && base % PAGE_SIZE == 0
        && free_for_devices(base, size)
        && (base as u64 + size as u64 <= start as u64 || base >= end)
}

/// Decode the region at guest physical `base` (page aligned), for example
/// where the guest has just moved its BAR. Anywhere it cannot be decoded
/// (see decodable), it is not mapped until that changes.
#[no_mangle]
pub unsafe fn mmio_ram_map(id: u32, base: u32) {
    let Some(region) = region(id)
    else {
        return;
    };
    region.base = base;
    region.requested = true;
    region.mapped = decodable(base, region.size);
    if !region.mapped {
        dbg_log!(
            "mmio_ram_map: region {} cannot be decoded at {:x}",
            id,
            base
        );
    }
    // x64 page functions may hold direct translations of the old place, and
    // code compiled from it
    crate::x64::jac::flush_all();
    crate::x64::pages::retire_device_code();
}

/// The chipset decodes [base, base + size) itself, before the PCI bus:
/// Q35's ECAM (PCIEXBAR). No region is decoded there; a region the window
/// moves away from is decoded at its base again. Size 0: no such window.
#[no_mangle]
pub unsafe fn mmio_ram_reserve(base: u32, size: u32) {
    let table = table();
    table.reserved = (
        base,
        if size == 0 { base } else { base.saturating_add(size) },
    );
    for region in table.regions[..table.count].iter_mut() {
        if region.requested {
            region.mapped = decodable(region.base, region.size);
        }
    }
    crate::x64::jac::flush_all();
    crate::x64::pages::retire_device_code();
}

/// Let writes reach the region's memory, or leave them to the memory map
#[no_mangle]
pub unsafe fn mmio_ram_set_writable(id: u32, writable: bool) {
    if let Some(region) = region(id) {
        region.writable = writable;
        // x64 page functions may hold direct write translations, and code
        // compiled from read-only memory
        crate::x64::jac::flush_all();
        crate::x64::pages::retire_device_code();
    }
}

/// Stop decoding the region anywhere (its memory is kept)
#[no_mangle]
pub unsafe fn mmio_ram_unmap(id: u32) {
    if let Some(region) = region(id) {
        region.mapped = false;
        region.requested = false;
        crate::x64::jac::flush_all();
        crate::x64::pages::retire_device_code();
    }
}

/// A byte of the region by its offset, wherever and whether it is mapped
/// (the VGA's banked window at 0xA0000 reaches the frame buffer this way)
#[no_mangle]
pub unsafe fn mmio_ram_read8(id: u32, offset: u32) -> i32 {
    match region(id) {
        Some(region) if offset < region.size => *region.backing.add(offset as usize) as i32,
        _ => 0xFF,
    }
}

#[no_mangle]
pub unsafe fn mmio_ram_write8(id: u32, offset: u32, value: i32) {
    if let Some(region) = region(id) {
        if offset < region.size {
            mark_page(region, offset / PAGE_SIZE);
            *region.backing.add(offset as usize) = value as u8;
        }
    }
}

/// Mark every page of the region written, e.g. to have all of it redrawn
#[no_mangle]
pub unsafe fn mmio_ram_mark_dirty(id: u32) {
    if let Some(region) = region(id) {
        for i in 0..region.dirty_words as usize {
            parallel::or64(region.dirty.add(i).cast(), u64::MAX);
        }
    }
}

/// Take the region's bitmap (the pages written since the last call, a bit a
/// page, 64 pages a word) into a buffer of the table's, for a device that
/// keeps a copy of the region elsewhere (virtio-gpu's host visible memory
/// and the GPU's buffers)
/// @return the buffer's address, relative to the start of the wasm memory
/// (as many words as the region has), or 0
#[no_mangle]
pub unsafe fn mmio_ram_take_dirty(id: u32) -> u32 {
    let Some(region) = region(id)
    else {
        return 0;
    };
    let region = *region;
    let taken = &mut table().taken[id as usize];
    taken.clear();
    taken.resize(region.dirty_words as usize, 0);
    for i in 0..region.dirty_words as usize {
        taken[i] = take_word(region.dirty.add(i));
    }
    // (as mmio_ram_fill_pixels: direct x64 write translations mark again)
    crate::x64::jac::retire_frame_buffer_writes();
    taken.as_mut_ptr() as u32
}

/// An RGBA buffer of `pixels` pixels that mmio_ram_fill_pixels converts the
/// region into, replacing the previous one
/// @return its address, relative to the start of the wasm memory
#[no_mangle]
pub unsafe fn mmio_ram_allocate_pixels(id: u32, pixels: u32) -> u32 {
    if region(id).is_none() {
        return 0;
    }
    let buffer = &mut table().pixels[id as usize];
    buffer.clear();
    buffer.resize(pixels as usize, 0);
    buffer.as_mut_ptr() as u32
}

/// Call `f` with the byte offset of each page written since the last call,
/// and forget them.
/// @return the first and last byte of those pages (u32::MAX and 0xFFF when
/// there were none)
unsafe fn take_dirty_pages(region: &Region, mut f: impl FnMut(u32)) -> (u32, u32) {
    let mut min_offset = u32::MAX;
    let mut max_offset = 0;
    for i in 0..region.dirty_words {
        let mut word = take_word(region.dirty.add(i as usize));
        while word != 0 {
            let bit = word.trailing_zeros();
            word &= word - 1;
            let offset = (i << 6 | bit) * PAGE_SIZE;
            if offset >= region.size {
                continue;
            }
            if min_offset == u32::MAX {
                min_offset = offset;
            }
            max_offset = offset;
            f(offset);
        }
    }
    (min_offset, max_offset + 0xFFF)
}

/// Convert the pages of the region written since the last call into its RGBA
/// buffer (mmio_ram_allocate_pixels), as `bpp`-bit pixels, the first
/// `first_pixel` of the region not shown (panning, page flipping). 8-bit
/// pixels go through a palette the region does not know: not handled here.
/// Reports the byte range of the pages in svga_dirty_bitmap_min_offset and
/// svga_dirty_bitmap_max_offset, for the screen to redraw only those rows.
#[no_mangle]
pub unsafe fn mmio_ram_fill_pixels(id: u32, bpp: u32, first_pixel: u32) {
    let (min_offset, max_offset) = fill_pixels(id, bpp, first_pixel);
    *global_pointers::svga_dirty_bitmap_min_offset = min_offset;
    *global_pointers::svga_dirty_bitmap_max_offset = max_offset;
}

unsafe fn fill_pixels(id: u32, bpp: u32, first_pixel: u32) -> (u32, u32) {
    let Some(region) = region(id)
    else {
        return (u32::MAX, 0xFFF);
    };
    let region = *region;
    let dest = &mut table().pixels[id as usize];
    let bytes_per_pixel = match bpp {
        32 => 4,
        24 => 3,
        16 | 15 => 2,
        _ => {
            dbg_log!("mmio_ram_fill_pixels: unsupported bpp {}", bpp);
            dbg_assert!(false, "Unsupported bpp");
            return (u32::MAX, 0xFFF);
        },
    };
    let source = region.backing;
    let size = region.size as usize;
    let range = take_dirty_pages(&region, |offset| {
        // The pixels that start in this page; a 24-bit pixel may begin in
        // the page before, and its dirty bit covers it too
        let first = (offset as usize + bytes_per_pixel - 1) / bytes_per_pixel;
        let first = if bytes_per_pixel == 3 && first > 0 { first - 1 } else { first };
        let end = ((offset + PAGE_SIZE) as usize).min(size) / bytes_per_pixel;
        for pixel in first..end {
            let Some(index) = pixel.checked_sub(first_pixel as usize)
            else {
                continue;
            };
            if index >= dest.len() {
                break;
            }
            let at = source.add(pixel * bytes_per_pixel);
            dest[index] = match bpp {
                32 => {
                    let dword = ptr::read_unaligned(at as *const u32);
                    dword << 16 | dword >> 16 & 0xFF | dword & 0xFF00 | 0xFF00_0000
                },
                24 => {
                    let dword = *at as u32 | (*at.add(1) as u32) << 8 | (*at.add(2) as u32) << 16;
                    dword << 16 | dword >> 16 & 0xFF | dword & 0xFF00 | 0xFF00_0000
                },
                16 => {
                    let word = ptr::read_unaligned(at as *const u16) as u32;
                    let r = (word & 0x1F) * 0xFF / 0x1F;
                    let g = (word >> 5 & 0x3F) * 0xFF / 0x3F;
                    let b = (word >> 11) * 0xFF / 0x1F;
                    r << 16 | g << 8 | b | 0xFF00_0000
                },
                _ => {
                    let word = ptr::read_unaligned(at as *const u16) as u32;
                    let r = (word & 0x1F) * 0xFF / 0x1F;
                    let g = (word >> 5 & 0x1F) * 0xFF / 0x1F;
                    let b = (word >> 10 & 0x1F) * 0xFF / 0x1F;
                    r << 16 | g << 8 | b | 0xFF00_0000
                },
            };
        }
    });
    // x64 page functions write the frame buffer directly once a write
    // translation marked its page: retire those, so the next write marks again
    crate::x64::jac::retire_frame_buffer_writes();
    range
}

#[cfg(test)]
mod tests {
    use super::*;

    unsafe fn reset() {
        let table = table();
        table.count = 0;
        table.reserved = (0, 0);
    }

    #[test]
    fn read_only_regions_leave_writes_to_the_memory_map() {
        unsafe {
            reset();
            // (the firmware's flash)
            let flash = mmio_ram_allocate(4 * 4096) as u32;
            mmio_ram_map(flash, 0xFFFF_C000);
            mmio_ram_set_writable(flash, false);
            assert!(read_host(0xFFFF_F000, 4).is_some());
            assert!(write_host(0xFFFF_F000, 4).is_none());
            assert!(read_only_page(0xFFFF_F000));
            assert!(contains(0xFFFF_F000) && !contains_writable(0xFFFF_F000));
            mmio_ram_set_writable(flash, true);
            assert!(write_host(0xFFFF_F000, 4).is_some());
            assert!(!read_only_page(0xFFFF_F000));
        }
    }

    #[test]
    fn nothing_is_decoded_in_the_reserved_window() {
        unsafe {
            reset();
            // a frame buffer where the chipset puts its ECAM window: not
            // decoded while the window is there, back once it moved away
            let id = mmio_ram_allocate(64 * 4096) as u32;
            mmio_ram_map(id, 0xE000_0000);
            mmio_ram_reserve(0xE000_0000, 0x1000_0000);
            assert!(!contains(0xE000_0000));
            mmio_ram_reserve(0, 0);
            assert!(contains(0xE000_0000));
            // moved into the window: waits; moved out of it: decoded at once
            mmio_ram_reserve(0xE000_0000, 0x1000_0000);
            mmio_ram_map(id, 0xE800_0000);
            assert!(!contains(0xE800_0000));
            mmio_ram_map(id, 0x8000_0000);
            assert!(contains(0x8000_0000));
            // (a window ending at 4 GiB, and one just below the region)
            mmio_ram_reserve(0xF000_0000, 0x1000_0000);
            assert!(contains(0x8000_0000));
            mmio_ram_reserve(0x7000_0000, 0x1000_0000);
            assert!(contains(0x8000_0000));
            // unmapped by its device: whatever the window does
            mmio_ram_unmap(id);
            mmio_ram_reserve(0, 0);
            assert!(!contains(0x8000_0000));
        }
    }

    #[test]
    fn regions_decode_where_mapped_and_track_written_pages() {
        unsafe {
            reset();
            let id = mmio_ram_allocate(64 * 4096) as u32;
            assert!(!contains(0xE000_0000), "unmapped until placed");
            mmio_ram_map(id, 0xE000_0000);
            assert!(contains(0xE000_0000) && contains(0xE003_FFFF));
            assert!(!contains(0xE004_0000) && !contains(0xDFFF_FFFF));
            // an access has to fit entirely
            assert!(read_host(0xE003_FFFE, 2).is_some());
            assert!(read_host(0xE003_FFFE, 4).is_none());

            let p = write_host(0xE000_1000, 4).unwrap();
            *(p as *mut u32) = 0x11223344;
            assert_eq!(
                *(read_host(0xE000_1000, 4).unwrap() as *const u32),
                0x11223344
            );
            let region = find(0xE000_0000, 1).unwrap();
            assert_eq!(*region.dirty, 0b10, "page 1 written");

            // moved by the guest: decoded at the new place, same memory
            mmio_ram_map(id, 0xF000_0000);
            assert!(!contains(0xE000_1000));
            assert_eq!(
                *(read_host(0xF000_1000, 4).unwrap() as *const u32),
                0x11223344
            );
            mmio_ram_unmap(id);
            assert!(!contains(0xF000_1000));
        }
    }

    #[test]
    fn written_pages_convert_to_rgba_once() {
        unsafe {
            reset();
            let id = mmio_ram_allocate(2 * 4096) as u32;
            mmio_ram_map(id, 0xE000_0000);
            mmio_ram_allocate_pixels(id, 2048);
            // (the export returns a wasm address; natively, take the pointer)
            let pixels = table().pixels[id as usize].as_ptr();
            // 32 bpp, pixel 1030 in page 1: xRGB 0x00112233
            *(write_host(0xE000_0000 + 1030 * 4, 4).unwrap() as *mut u32) = 0x0011_2233;
            // RGBA bytes in memory: 0x11 0x22 0x33 0xFF
            assert_eq!(fill_pixels(id, 32, 0), (4096, 8191));
            assert_eq!(*pixels.add(1030), 0xFF33_2211);
            // taken: a second call converts nothing
            *(find(0xE000_0000, 1).unwrap().backing.add(1030 * 4) as *mut u32) = 0;
            assert_eq!(fill_pixels(id, 32, 0), (u32::MAX, 0xFFF));
            assert_eq!(*pixels.add(1030), 0xFF33_2211);

            // skipping the first pixels (panning)
            *(write_host(0xE000_0000 + 1030 * 4, 4).unwrap() as *mut u32) = 0x00AA_BBCC;
            fill_pixels(id, 32, 1000);
            assert_eq!(*pixels.add(30), 0xFFCC_BBAA);
        }
    }
}
