extern "C" {
    fn mmap_read8(addr: u32) -> i32;
    fn mmap_read16(addr: u32) -> i32;
    fn mmap_read32(addr: u32) -> i32;

    pub fn mmap_write8(addr: u32, value: i32);
    pub fn mmap_write16(addr: u32, value: i32);
    pub fn mmap_write32(addr: u32, value: i32);
    pub fn mmap_write64(addr: u32, v0: i32, v1: i32);
    pub fn mmap_write128(addr: u32, v0: i32, v1: i32, v2: i32, v3: i32);
}

use cpu::cpu::reg128;
use cpu::global_pointers::memory_size;
use page::Page;
use std::alloc;
use std::ptr;

#[allow(non_upper_case_globals)]
pub static mut mem8: *mut u8 = ptr::null_mut();

#[no_mangle]
pub fn allocate_memory(size: u32) -> u32 {
    unsafe {
        dbg_assert!(mem8.is_null())
    };
    dbg_log!("Allocate memory size={}m", size >> 20);
    let layout = alloc::Layout::from_size_align(size as usize, 0x1000).unwrap();
    let ptr = unsafe { alloc::alloc(layout) as u32 };
    unsafe {
        mem8 = ptr as *mut u8;
    };
    ptr
}

#[no_mangle]
pub unsafe fn zero_memory(size: u32) { ptr::write_bytes(mem8, 0, size as usize); }

#[no_mangle]
pub fn in_mapped_range(addr: u32) -> bool {
    return addr >= 0xA0000 && addr < 0xC0000 || addr >= unsafe { *memory_size };
}

#[no_mangle]
pub fn read8(addr: u32) -> i32 {
    if in_mapped_range(addr) {
        return unsafe { mmap_read8(addr) };
    }
    else {
        return read8_no_mmap_check(addr);
    };
}
pub fn read8_no_mmap_check(addr: u32) -> i32 { unsafe { *mem8.offset(addr as isize) as i32 } }

#[no_mangle]
pub fn read16(addr: u32) -> i32 {
    if in_mapped_range(addr) {
        return unsafe { mmap_read16(addr) };
    }
    else {
        return read16_no_mmap_check(addr);
    };
}
pub fn read16_no_mmap_check(addr: u32) -> i32 {
    unsafe { *(mem8.offset(addr as isize) as *mut u16) as i32 }
}

#[no_mangle]
pub fn read32s(addr: u32) -> i32 {
    if in_mapped_range(addr) {
        return unsafe { mmap_read32(addr) };
    }
    else {
        return read32_no_mmap_check(addr);
    };
}
pub fn read32_no_mmap_check(addr: u32) -> i32 {
    unsafe { *(mem8.offset(addr as isize) as *mut i32) }
}

pub unsafe fn read64s(addr: u32) -> i64 {
    if in_mapped_range(addr) {
        return mmap_read32(addr) as i64 | (mmap_read32(addr.wrapping_add(4 as u32)) as i64) << 32;
    }
    else {
        return *(mem8.offset(addr as isize) as *mut i64);
    };
}

pub unsafe fn read_aligned32(addr: u32) -> i32 {
    dbg_assert!(addr < 0x40000000 as u32);
    if in_mapped_range(addr << 2) {
        return mmap_read32(addr << 2);
    }
    else {
        return *(mem8 as *mut i32).offset(addr as isize);
    };
}

pub unsafe fn read128(addr: u32) -> reg128 {
    let mut value: reg128 = reg128 {
        i8_0: [0 as i8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    };
    if in_mapped_range(addr) {
        value.i32_0[0] = mmap_read32(addr);
        value.i32_0[1] = mmap_read32(addr.wrapping_add(4 as u32));
        value.i32_0[2] = mmap_read32(addr.wrapping_add(8 as u32));
        value.i32_0[3] = mmap_read32(addr.wrapping_add(12 as u32))
    }
    else {
        value.i64_0[0] = *(mem8.offset(addr as isize) as *mut i64);
        value.i64_0[1] = *(mem8.offset(addr as isize).offset(8) as *mut i64)
    }
    return value;
}

pub unsafe fn write8(addr: u32, value: i32) {
    if in_mapped_range(addr) {
        mmap_write8(addr, value);
    }
    else {
        ::jit::jit_dirty_page(::jit::get_jit_state(), Page::page_of(addr));
        write8_no_mmap_or_dirty_check(addr, value);
    };
}

pub unsafe fn write8_no_mmap_or_dirty_check(addr: u32, value: i32) {
    *mem8.offset(addr as isize) = value as u8
}

#[no_mangle]
pub unsafe fn write16(addr: u32, value: i32) {
    if in_mapped_range(addr) {
        mmap_write16(addr, value);
    }
    else {
        ::jit::jit_dirty_cache_small(addr, addr.wrapping_add(2 as u32));
        write16_no_mmap_or_dirty_check(addr, value);
    };
}
pub unsafe fn write16_no_mmap_or_dirty_check(addr: u32, value: i32) {
    *(mem8.offset(addr as isize) as *mut u16) = value as u16
}

#[no_mangle]
pub unsafe fn write32(addr: u32, value: i32) {
    if in_mapped_range(addr) {
        mmap_write32(addr, value);
    }
    else {
        ::jit::jit_dirty_cache_small(addr, addr.wrapping_add(4 as u32));
        write32_no_mmap_or_dirty_check(addr, value);
    };
}

pub unsafe fn write32_no_mmap_or_dirty_check(addr: u32, value: i32) {
    *(mem8.offset(addr as isize) as *mut i32) = value
}

pub unsafe fn write_aligned32_no_mmap_or_dirty_check(addr: u32, value: i32) {
    *(mem8 as *mut i32).offset(addr as isize) = value
}

pub unsafe fn write_aligned32(addr: u32, value: i32) {
    dbg_assert!(addr < 0x40000000 as u32);
    let phys_addr = addr << 2;
    if in_mapped_range(phys_addr) {
        mmap_write32(phys_addr, value);
    }
    else {
        ::jit::jit_dirty_cache_small(phys_addr, phys_addr.wrapping_add(4 as u32));
        write_aligned32_no_mmap_or_dirty_check(addr, value);
    };
}

pub unsafe fn write64_no_mmap_or_dirty_check(addr: u32, value: u64) {
    *(mem8.offset(addr as isize) as *mut u64) = value
}

pub unsafe fn write128_no_mmap_or_dirty_check(addr: u32, value: reg128) {
    *(mem8.offset(addr as isize) as *mut reg128) = value
}

pub unsafe fn memset_no_mmap_or_dirty_check(addr: u32, value: u8, count: u32) {
    ptr::write_bytes(mem8.offset(addr as isize), value, count as usize);
}

pub unsafe fn memcpy_no_mmap_or_dirty_check(src_addr: u32, dst_addr: u32, count: u32) {
    dbg_assert!(u32::max(src_addr, dst_addr) - u32::min(src_addr, dst_addr) >= count);
    ptr::copy_nonoverlapping(
        mem8.offset(src_addr as isize),
        mem8.offset(dst_addr as isize),
        count as usize,
    )
}
