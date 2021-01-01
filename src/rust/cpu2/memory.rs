extern "C" {
    #[no_mangle]
    fn mmap_read8(addr: u32) -> i32;
    #[no_mangle]
    fn mmap_read16(addr: u32) -> i32;
    #[no_mangle]
    fn mmap_read32(addr: u32) -> i32;

    #[no_mangle]
    fn mmap_write8(addr: u32, value: i32);
    #[no_mangle]
    fn mmap_write16(addr: u32, value: i32);
    #[no_mangle]
    fn mmap_write32(addr: u32, value: i32);
    #[no_mangle]
    fn mmap_write128(addr: u32, v0: i32, v1: i32, v2: i32, v3: i32);
}

use cpu2::cpu::*;
use cpu2::global_pointers::*;
use page::Page;

#[no_mangle]
pub unsafe fn in_mapped_range(addr: u32) -> bool {
    return addr >= 0xA0000 && addr < 0xC0000 || addr >= *memory_size;
}

#[no_mangle]
pub unsafe fn read8(addr: u32) -> i32 {
    if in_mapped_range(addr) {
        return mmap_read8(addr);
    }
    else {
        return *mem8.offset(addr as isize) as i32;
    };
}
#[no_mangle]
pub unsafe fn read16(addr: u32) -> i32 {
    if in_mapped_range(addr) {
        return mmap_read16(addr);
    }
    else {
        return *(mem8.offset(addr as isize) as *mut u16) as i32;
    };
}
#[no_mangle]
pub unsafe fn read_aligned16(addr: u32) -> i32 {
    dbg_assert!(addr < 0x80000000);
    if in_mapped_range(addr << 1) {
        return mmap_read16(addr << 1);
    }
    else {
        return *mem16.offset(addr as isize) as i32;
    };
}
#[no_mangle]
pub unsafe fn read32s(addr: u32) -> i32 {
    if in_mapped_range(addr) {
        return mmap_read32(addr);
    }
    else {
        return *(mem8.offset(addr as isize) as *mut i32);
    };
}
#[no_mangle]
pub unsafe fn read64s(addr: u32) -> i64 {
    if in_mapped_range(addr) {
        return mmap_read32(addr) as i64 | (mmap_read32(addr.wrapping_add(4 as u32)) as i64) << 32;
    }
    else {
        return *(mem8.offset(addr as isize) as *mut i64);
    };
}
#[no_mangle]
pub unsafe fn read_aligned32(addr: u32) -> i32 {
    dbg_assert!(addr < 0x40000000 as u32);
    if in_mapped_range(addr << 2) {
        return mmap_read32(addr << 2);
    }
    else {
        return *mem32s.offset(addr as isize);
    };
}
#[no_mangle]
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

#[no_mangle]
pub unsafe fn write8(addr: u32, value: i32) {
    if in_mapped_range(addr) {
        mmap_write8(addr, value);
    }
    else {
        ::c_api::jit_dirty_page(Page::page_of(addr));
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
        ::c_api::jit_dirty_cache_small(addr, addr.wrapping_add(2 as u32));
        *(mem8.offset(addr as isize) as *mut u16) = value as u16
    };
}
#[no_mangle]
pub unsafe fn write_aligned16(addr: u32, value: u32) {
    dbg_assert!(addr < 0x80000000);
    let phys_addr: u32 = addr << 1;
    if in_mapped_range(phys_addr) {
        mmap_write16(phys_addr, value as i32);
    }
    else {
        ::c_api::jit_dirty_cache_small(phys_addr, phys_addr.wrapping_add(2 as u32));
        *mem16.offset(addr as isize) = value as u16
    };
}
#[no_mangle]
pub unsafe fn write32(addr: u32, value: i32) {
    if in_mapped_range(addr) {
        mmap_write32(addr, value);
    }
    else {
        ::c_api::jit_dirty_cache_small(addr, addr.wrapping_add(4 as u32));
        *(mem8.offset(addr as isize) as *mut i32) = value
    };
}

pub unsafe fn write_aligned32_no_mmap_or_dirty_check(addr: u32, value: i32) {
    *mem32s.offset(addr as isize) = value
}

#[no_mangle]
pub unsafe fn write_aligned32(addr: u32, value: i32) {
    dbg_assert!(addr < 0x40000000 as u32);
    let phys_addr: u32 = addr << 2;
    if in_mapped_range(phys_addr) {
        mmap_write32(phys_addr, value);
    }
    else {
        ::c_api::jit_dirty_cache_small(phys_addr, phys_addr.wrapping_add(4 as u32));
        write_aligned32_no_mmap_or_dirty_check(addr, value);
    };
}
#[no_mangle]
pub unsafe fn write64(addr: u32, value: i64) {
    if in_mapped_range(addr) {
        mmap_write32(
            addr.wrapping_add(0 as u32),
            (value & 0xFFFFFFFF as i64) as i32,
        );
        mmap_write32(addr.wrapping_add(4 as u32), (value >> 32) as i32);
    }
    else {
        ::c_api::jit_dirty_cache_small(addr, addr.wrapping_add(8 as u32));
        *(mem8.offset(addr as isize) as *mut i64) = value
    };
}
#[no_mangle]
pub unsafe fn write128(addr: u32, value: reg128) {
    if in_mapped_range(addr) {
        mmap_write128(
            addr,
            value.i32_0[0],
            value.i32_0[1],
            value.i32_0[2],
            value.i32_0[3],
        );
    }
    else {
        ::c_api::jit_dirty_cache_small(addr, addr.wrapping_add(16 as u32));
        *(mem8.offset(addr as isize) as *mut i64) = value.i64_0[0];
        *(mem8.offset(addr as isize).offset(8) as *mut i64) = value.i64_0[1]
    };
}
