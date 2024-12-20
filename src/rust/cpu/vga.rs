#![allow(non_upper_case_globals)]
#![allow(static_mut_refs)]

// Safety of allow(static_mut_refs) in this file:
// These following two globals are not passed anywhere, only built-in function are called on them
static mut dirty_bitmap: Vec<u64> = Vec::new();
static mut dest_buffer: Vec<u32> = Vec::new();

use cpu::global_pointers;
use cpu::memory;

use std::ptr;

#[no_mangle]
pub unsafe fn svga_allocate_dest_buffer(size: u32) -> u32 {
    dest_buffer.resize(size as usize, 0);
    dest_buffer.as_mut_ptr() as u32
}

pub unsafe fn set_dirty_bitmap_size(size: u32) { dirty_bitmap.resize(size as usize, 0); }

pub unsafe fn mark_dirty(addr: u32) {
    let page = (addr - memory::VGA_LFB_ADDRESS) >> 12;
    dbg_assert!(((page >> 6) as usize) < dirty_bitmap.len());
    *dirty_bitmap.get_unchecked_mut((page >> 6) as usize) |= 1 << (page & 63)
}

#[no_mangle]
pub unsafe fn svga_mark_dirty() {
    for v in dirty_bitmap.iter_mut() {
        *v = u64::MAX
    }
}

fn iter_dirty_pages(f: &dyn Fn(isize)) {
    let mut min_off = u32::MAX;
    let mut max_off = u32::MIN;

    for (i, &word) in unsafe { dirty_bitmap.iter().enumerate() } {
        if word == 0 {
            continue;
        }
        for j in 0..64 {
            if word & 1 << j == 0 {
                continue;
            }
            let off = ((i << 6 | j) << 12) as isize;
            dbg_assert!(off < unsafe { memory::vga_memory_size as isize });
            if min_off == u32::MAX {
                min_off = off as u32;
            }
            max_off = off as u32;
            f(off);
        }
    }

    unsafe {
        *global_pointers::svga_dirty_bitmap_min_offset = min_off;
        *global_pointers::svga_dirty_bitmap_max_offset = max_off + 0xFFF;
    }
}

#[no_mangle]
pub unsafe fn svga_fill_pixel_buffer(bpp: u32, svga_dest_offset: u32) {
    let debug_bounds = false;

    match bpp {
        32 => iter_dirty_pages(&|off| {
            dbg_assert!(off >= 0);
            let src = memory::vga_mem8.offset(off) as *const u32;
            let dest_offset = off / 4 - svga_dest_offset as isize;
            let dest = dest_buffer.as_mut_ptr().offset(dest_offset) as *mut u32;
            let end = if dest_offset < 0 {
                0
            }
            else {
                isize::min(1024, dest_buffer.len() as isize - dest_offset)
            };

            dbg_assert!(src as u32 % 8 == 0);
            dbg_assert!(dest as u32 % 8 == 0);
            for i in 0..end {
                dbg_assert!(off + i < memory::vga_memory_size as isize);
                let dword = *src.offset(i);
                let dword = if debug_bounds && (i == 0 || i == end - 1) { 0xFFFFFF } else { dword };
                dbg_assert!(dest_offset + i < dest_buffer.len() as isize);
                *dest.offset(i) = dword << 16 | dword >> 16 & 0xFF | dword & 0xFF00 | 0xFF00_0000;
            }
        }),
        24 => iter_dirty_pages(&|off| {
            dbg_assert!(off >= 0 && off < memory::vga_memory_size as isize);
            let off = off - off % 3;
            let src = memory::vga_mem8.offset(off);
            let dest_offset = off / 3 - svga_dest_offset as isize;
            let dest = dest_buffer.as_mut_ptr().offset(dest_offset) as *mut u32;
            let end = if dest_offset < 0 {
                0
            }
            else {
                isize::min(4096 / 3 + 1, dest_buffer.len() as isize - dest_offset)
            };
            for i in 0..end {
                let dword = ptr::read_unaligned(src.offset(3 * i) as *const u32);
                let dword = if debug_bounds && (i == 0 || i == end - 1) { 0xFFFFFF } else { dword };
                dbg_assert!(dest_offset + i < dest_buffer.len() as isize);
                *dest.offset(i) = dword << 16 | dword >> 16 & 0xFF | dword & 0xFF00 | 0xFF00_0000;
            }
        }),
        16 => iter_dirty_pages(&|off| {
            dbg_assert!(off >= 0 && off + 2048 < memory::vga_memory_size as isize);
            let src = memory::vga_mem8.offset(off) as *const u16;
            let dest_offset = off / 2 - svga_dest_offset as isize;
            let dest = dest_buffer.as_mut_ptr().offset(dest_offset) as *mut u32;
            let end = if dest_offset < 0 {
                0
            }
            else {
                isize::min(2048, dest_buffer.len() as isize - dest_offset)
            };
            for i in 0..end {
                dbg_assert!(off + i < memory::vga_memory_size as isize);
                let word = *src.offset(i);
                let word = if debug_bounds && (i == 0 || i == end - 1) { 0xFFFF } else { word };
                let r = (word & 0x1F) * 0xFF / 0x1F;
                let g = (word >> 5 & 0x3F) * 0xFF / 0x3F;
                let b = (word >> 11) * 0xFF / 0x1F;
                dbg_assert!(dest_offset + i < dest_buffer.len() as isize);
                *dest.offset(i) = (r as u32) << 16 | (g as u32) << 8 | b as u32 | 0xFF00_0000;
            }
        }),
        15 => iter_dirty_pages(&|off| {
            dbg_assert!(off >= 0 && off + 2048 < memory::vga_memory_size as isize);
            let src = memory::vga_mem8.offset(off) as *const u16;
            let dest_offset = off / 2 - svga_dest_offset as isize;
            let dest = dest_buffer.as_mut_ptr().offset(dest_offset) as *mut u32;
            let end = if dest_offset < 0 {
                0
            }
            else {
                isize::min(2048, dest_buffer.len() as isize - dest_offset)
            };
            for i in 0..end {
                dbg_assert!(off + i < memory::vga_memory_size as isize);
                let word = *src.offset(i);
                let word = if debug_bounds && (i == 0 || i == end - 1) { 0xFFFF } else { word };
                let r = (word & 0x1F) * 0xFF / 0x1F;
                let g = (word >> 5 & 0x1F) * 0xFF / 0x1F;
                let b = (word >> 10 & 0x1F) * 0xFF / 0x1F;
                dbg_assert!(dest_offset + i < dest_buffer.len() as isize);
                *dest.offset(i) = (r as u32) << 16 | (g as u32) << 8 | b as u32 | 0xFF00_0000;
            }
        }),
        _ => {
            dbg_log!("{}", bpp);
            dbg_assert!(false, "Unsupported bpp");
        },
    }

    //if cfg!(debug_assertions) {
    //    let mut pages = 0;
    //    for &word in dirty_bitmap.iter() {
    //        pages += word.count_ones();
    //    }
    //    dbg_log!(
    //        "fill offset={:x} bpp={} pages={}",
    //        svga_dest_offset,
    //        bpp,
    //        pages,
    //    );
    //}

    for v in dirty_bitmap.iter_mut() {
        *v = 0
    }
}
