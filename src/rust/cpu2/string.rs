extern "C" {
    #[no_mangle]
    pub fn io_port_read8(port: i32) -> i32;
    #[no_mangle]
    pub fn io_port_read16(port: i32) -> i32;
    #[no_mangle]
    pub fn io_port_read32(port: i32) -> i32;

    #[no_mangle]
    pub fn io_port_write8(port: i32, value: i32);
    #[no_mangle]
    pub fn io_port_write16(port: i32, value: i32);
    #[no_mangle]
    pub fn io_port_write32(port: i32, value: i32);
}

use cpu2::arith::{cmp8, cmp16, cmp32};
use cpu2::cpu::*;
use cpu2::global_pointers::*;
use cpu2::memory::{
    in_mapped_range, read8, read_aligned16, read_aligned32, write8, write8_no_mmap_or_dirty_check,
    write_aligned16, write_aligned32, write_aligned32_no_mmap_or_dirty_check,
};
use page::Page;

const CX: i32 = ::regs::CX as i32;
const SI: i32 = ::regs::SI as i32;
const DI: i32 = ::regs::DI as i32;

const MAX_COUNT_PER_CYCLE: i32 = 4096;

#[no_mangle]
pub unsafe fn string_get_cycle_count(mut size: i32, mut address: i32) -> i32 {
    dbg_assert!(0 != size && size <= 4 && size >= -4);
    if size < 0 {
        size = -size;
        address = 0x1000 - address - size
    }
    dbg_assert!(address & size - 1 == 0);
    // 1 -> 0; 2 -> 1; 4 -> 2
    let shift = size >> 1;
    return 0x1000 - (address & 0xFFF) >> shift;
}
#[no_mangle]
pub unsafe fn string_get_cycle_count2(size: i32, addr1: i32, addr2: i32) -> i32 {
    let c1 = string_get_cycle_count(size, addr1);
    let c2 = string_get_cycle_count(size, addr2);
    return if c1 < c2 { c1 } else { c2 };
}
#[no_mangle]
pub unsafe fn movsb_rep(is_asize_32: bool, ds: i32) {
    let src = ds + if is_asize_32 { read_reg32(ESI) } else { read_reg16(SI) };
    let dest = return_on_pagefault!(get_seg(ES))
        + if is_asize_32 { read_reg32(EDI) } else { read_reg16(DI) };
    let size = if 0 != *flags & FLAG_DIRECTION { -1 } else { 1 };
    let mut count: i32 = if is_asize_32 { read_reg32(ECX) } else { read_reg16(CX) };
    if count == 0 {
        return;
    }
    else {
        let mut cont;
        let start_count = count;
        let mut cycle_counter: i32 = string_get_cycle_count2(size, src, dest);
        let mut phys_src: i32 = return_on_pagefault!(translate_address_read(src)) as i32;
        let mut phys_dest: i32 = return_on_pagefault!(translate_address_write(dest)) as i32;
        if !in_mapped_range(phys_dest as u32) {
            ::jit::jit_dirty_page(::jit::get_jit_state(), Page::page_of(phys_dest as u32));
            loop {
                write8_no_mmap_or_dirty_check(phys_dest as u32, read8(phys_src as u32));
                phys_dest += size;
                phys_src += size;
                count -= 1;
                cont = (count != 0) as i32;
                if !(0 != cont && {
                    cycle_counter -= 1;
                    0 != cycle_counter
                }) {
                    break;
                }
            }
        }
        else {
            loop {
                write8(phys_dest as u32, read8(phys_src as u32));
                phys_dest += size;
                phys_src += size;
                count -= 1;
                cont = (count != 0) as i32;
                if !(0 != cont && {
                    cycle_counter -= 1;
                    0 != cycle_counter
                }) {
                    break;
                }
            }
        }
        let diff = size * (start_count - count);
        add_reg_asize(is_asize_32, EDI, diff);
        add_reg_asize(is_asize_32, ESI, diff);
        set_ecx_asize(is_asize_32, count);
        *timestamp_counter =
            (*timestamp_counter as u32).wrapping_add((start_count - count) as u32) as u32 as u32;
        if 0 != cont {
            *instruction_pointer = *previous_ip
        }
        return;
    };
}
#[no_mangle]
pub unsafe fn movsb_no_rep(is_asize_32: bool, ds: i32) {
    let src = ds + if is_asize_32 { read_reg32(ESI) } else { read_reg16(SI) };
    let dest = return_on_pagefault!(get_seg(ES))
        + if is_asize_32 { read_reg32(EDI) } else { read_reg16(DI) };
    let size = if 0 != *flags & FLAG_DIRECTION { -1 } else { 1 };
    return_on_pagefault!(safe_write8(dest, return_on_pagefault!(safe_read8(src))));
    add_reg_asize(is_asize_32, EDI, size);
    add_reg_asize(is_asize_32, ESI, size);
}
#[no_mangle]
pub unsafe fn movsw_rep(is_asize_32: bool, ds: i32) {
    let diff;
    let mut src: i32 = ds + if is_asize_32 { read_reg32(ESI) } else { read_reg16(SI) };
    let mut dest: i32 = return_on_pagefault!(get_seg(ES))
        + if is_asize_32 { read_reg32(EDI) } else { read_reg16(DI) };
    let size = if 0 != *flags & FLAG_DIRECTION { -2 } else { 2 };
    let mut count: i32 = if is_asize_32 { read_reg32(ECX) } else { read_reg16(CX) };
    if count == 0 {
        return;
    }
    else {
        let mut cont;
        let start_count = count;
        let mut cycle_counter: i32 = MAX_COUNT_PER_CYCLE;
        if 0 == dest & 1 && 0 == src & 1 {
            let single_size = if size < 0 { -1 } else { 1 };
            let mut phys_src: i32 = (return_on_pagefault!(translate_address_read(src)) >> 1) as i32;
            let mut phys_dest: i32 =
                (return_on_pagefault!(translate_address_write(dest)) >> 1) as i32;
            cycle_counter = string_get_cycle_count2(size, src, dest);
            loop {
                write_aligned16(phys_dest as u32, read_aligned16(phys_src as u32) as u32);
                phys_dest += single_size;
                phys_src += single_size;
                count -= 1;
                cont = (count != 0) as i32;
                if !(0 != cont && {
                    cycle_counter -= 1;
                    0 != cycle_counter
                }) {
                    break;
                }
            }
            diff = size * (start_count - count);
            add_reg_asize(is_asize_32, EDI, diff);
            add_reg_asize(is_asize_32, ESI, diff);
            set_ecx_asize(is_asize_32, count);
            *timestamp_counter =
                (*timestamp_counter as u32).wrapping_add((start_count - count) as u32) as u32 as u32
        }
        else {
            loop {
                return_on_pagefault!(safe_write16(dest, return_on_pagefault!(safe_read16(src))));
                dest += size;
                add_reg_asize(is_asize_32, EDI, size);
                src += size;
                add_reg_asize(is_asize_32, ESI, size);
                cont = (decr_ecx_asize(is_asize_32) != 0) as i32;
                if !(0 != cont && {
                    cycle_counter -= 1;
                    0 != cycle_counter
                }) {
                    break;
                }
            }
        }
        if 0 != cont {
            *instruction_pointer = *previous_ip
        }
        return;
    };
}
#[no_mangle]
pub unsafe fn movsw_no_rep(is_asize_32: bool, ds: i32) {
    let src = ds + if is_asize_32 { read_reg32(ESI) } else { read_reg16(SI) };
    let dest = return_on_pagefault!(get_seg(ES))
        + if is_asize_32 { read_reg32(EDI) } else { read_reg16(DI) };
    let size = if 0 != *flags & FLAG_DIRECTION { -2 } else { 2 };
    return_on_pagefault!(safe_write16(dest, return_on_pagefault!(safe_read16(src))));
    add_reg_asize(is_asize_32, EDI, size);
    add_reg_asize(is_asize_32, ESI, size);
}
#[no_mangle]
pub unsafe fn movsd_rep(is_asize_32: bool, ds: i32) {
    let diff;
    let mut src: i32 = ds + if is_asize_32 { read_reg32(ESI) } else { read_reg16(SI) };
    let mut dest: i32 = return_on_pagefault!(get_seg(ES))
        + if is_asize_32 { read_reg32(EDI) } else { read_reg16(DI) };
    let size = if 0 != *flags & FLAG_DIRECTION { -4 } else { 4 };
    let mut count: i32 = if is_asize_32 { read_reg32(ECX) } else { read_reg16(CX) };
    if count == 0 {
        return;
    }
    else {
        let mut cont;
        let start_count = count;
        let mut cycle_counter: i32 = MAX_COUNT_PER_CYCLE;
        if 0 == dest & 3 && 0 == src & 3 {
            let single_size = if size < 0 { -1 } else { 1 };
            let mut phys_src: i32 = (return_on_pagefault!(translate_address_read(src)) >> 2) as i32;
            let mut phys_dest: i32 =
                (return_on_pagefault!(translate_address_write(dest)) >> 2) as i32;
            cycle_counter = string_get_cycle_count2(size, src, dest);
            if !in_mapped_range((phys_dest << 2) as u32) {
                ::jit::jit_dirty_page(
                    ::jit::get_jit_state(),
                    Page::page_of((phys_dest << 2) as u32),
                );
                loop {
                    write_aligned32_no_mmap_or_dirty_check(
                        phys_dest as u32,
                        read_aligned32(phys_src as u32),
                    );
                    phys_dest += single_size;
                    phys_src += single_size;
                    count -= 1;
                    cont = (count != 0) as i32;
                    if !(0 != cont && {
                        cycle_counter -= 1;
                        0 != cycle_counter
                    }) {
                        break;
                    }
                }
            }
            else {
                loop {
                    write_aligned32(phys_dest as u32, read_aligned32(phys_src as u32));
                    phys_dest += single_size;
                    phys_src += single_size;
                    count -= 1;
                    cont = (count != 0) as i32;
                    if !(0 != cont && {
                        cycle_counter -= 1;
                        0 != cycle_counter
                    }) {
                        break;
                    }
                }
            }
            diff = size * (start_count - count);
            add_reg_asize(is_asize_32, EDI, diff);
            add_reg_asize(is_asize_32, ESI, diff);
            set_ecx_asize(is_asize_32, count);
            *timestamp_counter =
                (*timestamp_counter as u32).wrapping_add((start_count - count) as u32) as u32 as u32
        }
        else {
            loop {
                return_on_pagefault!(safe_write32(dest, return_on_pagefault!(safe_read32s(src))));
                dest += size;
                add_reg_asize(is_asize_32, EDI, size);
                src += size;
                add_reg_asize(is_asize_32, ESI, size);
                cont = (decr_ecx_asize(is_asize_32) != 0) as i32;
                if !(0 != cont && {
                    cycle_counter -= 1;
                    0 != cycle_counter
                }) {
                    break;
                }
            }
        }
        if 0 != cont {
            *instruction_pointer = *previous_ip
        }
        return;
    };
}
#[no_mangle]
pub unsafe fn movsd_no_rep(is_asize_32: bool, ds: i32) {
    let src = ds + if is_asize_32 { read_reg32(ESI) } else { read_reg16(SI) };
    let dest = return_on_pagefault!(get_seg(ES))
        + if is_asize_32 { read_reg32(EDI) } else { read_reg16(DI) };
    let size = if 0 != *flags & FLAG_DIRECTION { -4 } else { 4 };
    return_on_pagefault!(safe_write32(dest, return_on_pagefault!(safe_read32s(src))));
    add_reg_asize(is_asize_32, EDI, size);
    add_reg_asize(is_asize_32, ESI, size);
}
#[no_mangle]
pub unsafe fn cmpsb_rep(prefix_flag: i32, is_asize_32: bool, ds: i32) {
    let src = ds + if is_asize_32 { read_reg32(ESI) } else { read_reg16(SI) };
    let dest = return_on_pagefault!(get_seg(ES))
        + if is_asize_32 { read_reg32(EDI) } else { read_reg16(DI) };
    let mut data_src;
    let mut data_dest;
    let size = if 0 != *flags & FLAG_DIRECTION { -1 } else { 1 };
    let mut count: i32 = if is_asize_32 { read_reg32(ECX) } else { read_reg16(CX) };
    if count == 0 {
        return;
    }
    else {
        let mut cont;
        let start_count = count;
        let is_repz = (prefix_flag == PREFIX_REPZ) as i32;
        let mut cycle_counter: i32 = string_get_cycle_count2(size, src, dest);
        let mut phys_src: i32 = return_on_pagefault!(translate_address_read(src)) as i32;
        let mut phys_dest: i32 = return_on_pagefault!(translate_address_read(dest)) as i32;
        loop {
            data_dest = read8(phys_dest as u32);
            data_src = read8(phys_src as u32);
            phys_dest += size;
            phys_src += size;
            count -= 1;
            cont = (count != 0 && (data_src == data_dest) as i32 == is_repz) as i32;
            if !(0 != cont && {
                cycle_counter -= 1;
                0 != cycle_counter
            }) {
                break;
            }
        }
        let diff = size * (start_count - count);
        add_reg_asize(is_asize_32, EDI, diff);
        add_reg_asize(is_asize_32, ESI, diff);
        set_ecx_asize(is_asize_32, count);
        *timestamp_counter =
            (*timestamp_counter as u32).wrapping_add((start_count - count) as u32) as u32 as u32;
        if 0 != cont {
            *instruction_pointer = *previous_ip
        }
        cmp8(data_src, data_dest);
        return;
    };
}
#[no_mangle]
pub unsafe fn cmpsb_no_rep(is_asize_32: bool, ds: i32) {
    let src = ds + if is_asize_32 { read_reg32(ESI) } else { read_reg16(SI) };
    let dest = return_on_pagefault!(get_seg(ES))
        + if is_asize_32 { read_reg32(EDI) } else { read_reg16(DI) };
    let data_src;
    let data_dest;
    let size = if 0 != *flags & FLAG_DIRECTION { -1 } else { 1 };
    data_src = return_on_pagefault!(safe_read8(src));
    data_dest = return_on_pagefault!(safe_read8(dest));
    add_reg_asize(is_asize_32, EDI, size);
    add_reg_asize(is_asize_32, ESI, size);
    cmp8(data_src, data_dest);
}
#[no_mangle]
pub unsafe fn cmpsw_rep(prefix_flag: i32, is_asize_32: bool, ds: i32) {
    let diff;
    let mut src: i32 = ds + if is_asize_32 { read_reg32(ESI) } else { read_reg16(SI) };
    let mut dest: i32 = return_on_pagefault!(get_seg(ES))
        + if is_asize_32 { read_reg32(EDI) } else { read_reg16(DI) };
    let mut data_src;
    let mut data_dest;
    let size = if 0 != *flags & FLAG_DIRECTION { -2 } else { 2 };
    let mut count: i32 = if is_asize_32 { read_reg32(ECX) } else { read_reg16(CX) };
    if count == 0 {
        return;
    }
    else {
        let mut cont;
        let start_count = count;
        let is_repz = (prefix_flag == PREFIX_REPZ) as i32;
        let mut cycle_counter: i32 = MAX_COUNT_PER_CYCLE;
        if 0 == dest & 1 && 0 == src & 1 {
            let single_size = if size < 0 { -1 } else { 1 };
            let mut phys_src: i32 = (return_on_pagefault!(translate_address_read(src)) >> 1) as i32;
            let mut phys_dest: i32 =
                (return_on_pagefault!(translate_address_read(dest)) >> 1) as i32;
            cycle_counter = string_get_cycle_count2(size, src, dest);
            loop {
                data_dest = read_aligned16(phys_dest as u32);
                data_src = read_aligned16(phys_src as u32);
                phys_dest += single_size;
                phys_src += single_size;
                count -= 1;
                cont = (count != 0 && (data_src == data_dest) as i32 == is_repz) as i32;
                if !(0 != cont && {
                    cycle_counter -= 1;
                    0 != cycle_counter
                }) {
                    break;
                }
            }
            diff = size * (start_count - count);
            add_reg_asize(is_asize_32, EDI, diff);
            add_reg_asize(is_asize_32, ESI, diff);
            set_ecx_asize(is_asize_32, count);
            *timestamp_counter =
                (*timestamp_counter as u32).wrapping_add((start_count - count) as u32) as u32 as u32
        }
        else {
            loop {
                data_dest = return_on_pagefault!(safe_read16(dest));
                data_src = return_on_pagefault!(safe_read16(src));
                dest += size;
                add_reg_asize(is_asize_32, EDI, size);
                src += size;
                add_reg_asize(is_asize_32, ESI, size);
                cont = (decr_ecx_asize(is_asize_32) != 0
                    && (data_src == data_dest) as i32 == is_repz) as i32;
                if !(0 != cont && {
                    cycle_counter -= 1;
                    0 != cycle_counter
                }) {
                    break;
                }
            }
        }
        if 0 != cont {
            *instruction_pointer = *previous_ip
        }
        cmp16(data_src, data_dest);
        return;
    };
}
#[no_mangle]
pub unsafe fn cmpsw_no_rep(is_asize_32: bool, ds: i32) {
    let src = ds + if is_asize_32 { read_reg32(ESI) } else { read_reg16(SI) };
    let dest = return_on_pagefault!(get_seg(ES))
        + if is_asize_32 { read_reg32(EDI) } else { read_reg16(DI) };
    let data_src;
    let data_dest;
    let size = if 0 != *flags & FLAG_DIRECTION { -2 } else { 2 };
    data_dest = return_on_pagefault!(safe_read16(dest));
    data_src = return_on_pagefault!(safe_read16(src));
    add_reg_asize(is_asize_32, EDI, size);
    add_reg_asize(is_asize_32, ESI, size);
    cmp16(data_src, data_dest);
}
#[no_mangle]
pub unsafe fn cmpsd_rep(prefix_flag: i32, is_asize_32: bool, ds: i32) {
    let diff;
    let mut src: i32 = ds + if is_asize_32 { read_reg32(ESI) } else { read_reg16(SI) };
    let mut dest: i32 = return_on_pagefault!(get_seg(ES))
        + if is_asize_32 { read_reg32(EDI) } else { read_reg16(DI) };
    let mut data_src;
    let mut data_dest;
    let size = if 0 != *flags & FLAG_DIRECTION { -4 } else { 4 };
    let mut count: i32 = if is_asize_32 { read_reg32(ECX) } else { read_reg16(CX) };
    if count == 0 {
        return;
    }
    else {
        let mut cont;
        let start_count = count;
        let is_repz = (prefix_flag == PREFIX_REPZ) as i32;
        let mut cycle_counter: i32 = MAX_COUNT_PER_CYCLE;
        if 0 == dest & 3 && 0 == src & 3 {
            let single_size = if size < 0 { -1 } else { 1 };
            let mut phys_src: i32 = (return_on_pagefault!(translate_address_read(src)) >> 2) as i32;
            let mut phys_dest: i32 =
                (return_on_pagefault!(translate_address_read(dest)) >> 2) as i32;
            cycle_counter = string_get_cycle_count2(size, src, dest);
            loop {
                data_dest = read_aligned32(phys_dest as u32);
                data_src = read_aligned32(phys_src as u32);
                phys_dest += single_size;
                phys_src += single_size;
                count -= 1;
                cont = (count != 0 && (data_src == data_dest) as i32 == is_repz) as i32;
                if !(0 != cont && {
                    cycle_counter -= 1;
                    0 != cycle_counter
                }) {
                    break;
                }
            }
            diff = size * (start_count - count);
            add_reg_asize(is_asize_32, EDI, diff);
            add_reg_asize(is_asize_32, ESI, diff);
            set_ecx_asize(is_asize_32, count);
            *timestamp_counter =
                (*timestamp_counter as u32).wrapping_add((start_count - count) as u32) as u32 as u32
        }
        else {
            loop {
                data_dest = return_on_pagefault!(safe_read32s(dest));
                data_src = return_on_pagefault!(safe_read32s(src));
                dest += size;
                add_reg_asize(is_asize_32, EDI, size);
                src += size;
                add_reg_asize(is_asize_32, ESI, size);
                cont = (decr_ecx_asize(is_asize_32) != 0
                    && (data_src == data_dest) as i32 == is_repz) as i32;
                if !(0 != cont && {
                    cycle_counter -= 1;
                    0 != cycle_counter
                }) {
                    break;
                }
            }
        }
        if 0 != cont {
            *instruction_pointer = *previous_ip
        }
        cmp32(data_src, data_dest);
        return;
    };
}
#[no_mangle]
pub unsafe fn cmpsd_no_rep(is_asize_32: bool, ds: i32) {
    let src = ds + if is_asize_32 { read_reg32(ESI) } else { read_reg16(SI) };
    let dest = return_on_pagefault!(get_seg(ES))
        + if is_asize_32 { read_reg32(EDI) } else { read_reg16(DI) };
    let data_src;
    let data_dest;
    let size = if 0 != *flags & FLAG_DIRECTION { -4 } else { 4 };
    data_dest = return_on_pagefault!(safe_read32s(dest));
    data_src = return_on_pagefault!(safe_read32s(src));
    add_reg_asize(is_asize_32, EDI, size);
    add_reg_asize(is_asize_32, ESI, size);
    cmp32(data_src, data_dest);
}
#[no_mangle]
pub unsafe fn stosb_rep(is_asize_32: bool) {
    let data = *reg8.offset(AL as isize) as i32;
    let dest = return_on_pagefault!(get_seg(ES))
        + if is_asize_32 { read_reg32(EDI) } else { read_reg16(DI) };
    let size = if 0 != *flags & FLAG_DIRECTION { -1 } else { 1 };
    let mut count: i32 = if is_asize_32 { read_reg32(ECX) } else { read_reg16(CX) };
    if count == 0 {
        return;
    }
    else {
        let mut cont;
        let start_count = count;
        let mut cycle_counter: i32 = string_get_cycle_count(size, dest);
        let mut phys_dest: i32 = return_on_pagefault!(translate_address_write(dest)) as i32;
        if !in_mapped_range(phys_dest as u32) {
            ::jit::jit_dirty_page(::jit::get_jit_state(), Page::page_of(phys_dest as u32));
            loop {
                write8_no_mmap_or_dirty_check(phys_dest as u32, data);
                phys_dest += size;
                count -= 1;
                cont = (count != 0) as i32;
                if !(0 != cont && {
                    cycle_counter -= 1;
                    0 != cycle_counter
                }) {
                    break;
                }
            }
        }
        else {
            loop {
                write8(phys_dest as u32, data);
                phys_dest += size;
                count -= 1;
                cont = (count != 0) as i32;
                if !(0 != cont && {
                    cycle_counter -= 1;
                    0 != cycle_counter
                }) {
                    break;
                }
            }
        }
        let diff = size * (start_count - count);
        add_reg_asize(is_asize_32, EDI, diff);
        set_ecx_asize(is_asize_32, count);
        *timestamp_counter =
            (*timestamp_counter as u32).wrapping_add((start_count - count) as u32) as u32 as u32;
        if 0 != cont {
            *instruction_pointer = *previous_ip
        }
        return;
    };
}
#[no_mangle]
pub unsafe fn stosb_no_rep(is_asize_32: bool) {
    let data = *reg8.offset(AL as isize) as i32;
    let dest = return_on_pagefault!(get_seg(ES))
        + if is_asize_32 { read_reg32(EDI) } else { read_reg16(DI) };
    let size = if 0 != *flags & FLAG_DIRECTION { -1 } else { 1 };
    return_on_pagefault!(safe_write8(dest, data));
    add_reg_asize(is_asize_32, EDI, size);
}
#[no_mangle]
pub unsafe fn stosw_rep(is_asize_32: bool) {
    let diff;
    let data = *reg16.offset(AX as isize) as i32;
    let mut dest: i32 = return_on_pagefault!(get_seg(ES))
        + if is_asize_32 { read_reg32(EDI) } else { read_reg16(DI) };
    let size = if 0 != *flags & FLAG_DIRECTION { -2 } else { 2 };
    let mut count: i32 = if is_asize_32 { read_reg32(ECX) } else { read_reg16(CX) };
    if count == 0 {
        return;
    }
    else {
        let mut cont;
        let start_count = count;
        let mut cycle_counter: i32 = MAX_COUNT_PER_CYCLE;
        if 0 == dest & 1 {
            let single_size = if size < 0 { -1 } else { 1 };
            let mut phys_dest: i32 =
                (return_on_pagefault!(translate_address_write(dest)) >> 1) as i32;
            cycle_counter = string_get_cycle_count(size, dest);
            loop {
                write_aligned16(phys_dest as u32, data as u32);
                phys_dest += single_size;
                count -= 1;
                cont = (count != 0) as i32;
                if !(0 != cont && {
                    cycle_counter -= 1;
                    0 != cycle_counter
                }) {
                    break;
                }
            }
            diff = size * (start_count - count);
            add_reg_asize(is_asize_32, EDI, diff);
            set_ecx_asize(is_asize_32, count);
            *timestamp_counter =
                (*timestamp_counter as u32).wrapping_add((start_count - count) as u32) as u32 as u32
        }
        else {
            loop {
                return_on_pagefault!(safe_write16(dest, data));
                dest += size;
                add_reg_asize(is_asize_32, EDI, size);
                cont = (decr_ecx_asize(is_asize_32) != 0) as i32;
                if !(0 != cont && {
                    cycle_counter -= 1;
                    0 != cycle_counter
                }) {
                    break;
                }
            }
        }
        if 0 != cont {
            *instruction_pointer = *previous_ip
        }
        return;
    };
}
#[no_mangle]
pub unsafe fn stosw_no_rep(is_asize_32: bool) {
    let data = *reg16.offset(AX as isize) as i32;
    let dest = return_on_pagefault!(get_seg(ES))
        + if is_asize_32 { read_reg32(EDI) } else { read_reg16(DI) };
    let size = if 0 != *flags & FLAG_DIRECTION { -2 } else { 2 };
    return_on_pagefault!(safe_write16(dest, data));
    add_reg_asize(is_asize_32, EDI, size);
}
#[no_mangle]
pub unsafe fn stosd_rep(is_asize_32: bool) {
    let diff;
    let data = *reg32.offset(EAX as isize);
    let mut dest: i32 = return_on_pagefault!(get_seg(ES))
        + if is_asize_32 { read_reg32(EDI) } else { read_reg16(DI) };
    let size = if 0 != *flags & FLAG_DIRECTION { -4 } else { 4 };
    let mut count: i32 = if is_asize_32 { read_reg32(ECX) } else { read_reg16(CX) };
    if count == 0 {
        return;
    }
    else {
        let mut cont;
        let start_count = count;
        let mut cycle_counter: i32 = MAX_COUNT_PER_CYCLE;
        if 0 == dest & 3 {
            let single_size = if size < 0 { -1 } else { 1 };
            let mut phys_dest: i32 =
                (return_on_pagefault!(translate_address_write(dest)) >> 2) as i32;
            cycle_counter = string_get_cycle_count(size, dest);
            if !in_mapped_range(phys_dest as u32) {
                ::jit::jit_dirty_page(
                    ::jit::get_jit_state(),
                    Page::page_of((phys_dest << 2) as u32),
                );
                loop {
                    write_aligned32_no_mmap_or_dirty_check(phys_dest as u32, data);
                    phys_dest += single_size;
                    count -= 1;
                    cont = (count != 0) as i32;
                    if !(0 != cont && {
                        cycle_counter -= 1;
                        0 != cycle_counter
                    }) {
                        break;
                    }
                }
            }
            else {
                loop {
                    write_aligned32(phys_dest as u32, data);
                    phys_dest += single_size;
                    count -= 1;
                    cont = (count != 0) as i32;
                    if !(0 != cont && {
                        cycle_counter -= 1;
                        0 != cycle_counter
                    }) {
                        break;
                    }
                }
            }
            diff = size * (start_count - count);
            add_reg_asize(is_asize_32, EDI, diff);
            set_ecx_asize(is_asize_32, count);
            *timestamp_counter =
                (*timestamp_counter as u32).wrapping_add((start_count - count) as u32) as u32 as u32
        }
        else {
            loop {
                return_on_pagefault!(safe_write32(dest, data));
                dest += size;
                add_reg_asize(is_asize_32, EDI, size);
                cont = (decr_ecx_asize(is_asize_32) != 0) as i32;
                if !(0 != cont && {
                    cycle_counter -= 1;
                    0 != cycle_counter
                }) {
                    break;
                }
            }
        }
        if 0 != cont {
            *instruction_pointer = *previous_ip
        }
        return;
    };
}
#[no_mangle]
pub unsafe fn stosd_no_rep(is_asize_32: bool) {
    let data = *reg32.offset(EAX as isize);
    let dest = return_on_pagefault!(get_seg(ES))
        + if is_asize_32 { read_reg32(EDI) } else { read_reg16(DI) };
    let size = if 0 != *flags & FLAG_DIRECTION { -4 } else { 4 };
    return_on_pagefault!(safe_write32(dest, data));
    add_reg_asize(is_asize_32, EDI, size);
}
#[no_mangle]
pub unsafe fn lodsb_rep(is_asize_32: bool, ds: i32) {
    let src = ds + if is_asize_32 { read_reg32(ESI) } else { read_reg16(SI) };
    let size = if 0 != *flags & FLAG_DIRECTION { -1 } else { 1 };
    let mut count: i32 = if is_asize_32 { read_reg32(ECX) } else { read_reg16(CX) };
    if count == 0 {
        return;
    }
    else {
        let mut cont;
        let start_count = count;
        let mut cycle_counter: i32 = string_get_cycle_count(size, src);
        let mut phys_src: i32 = return_on_pagefault!(translate_address_read(src)) as i32;
        loop {
            *reg8.offset(AL as isize) = read8(phys_src as u32) as u8;
            phys_src += size;
            count -= 1;
            cont = (count != 0) as i32;
            if !(0 != cont && {
                cycle_counter -= 1;
                0 != cycle_counter
            }) {
                break;
            }
        }
        let diff = size * (start_count - count);
        add_reg_asize(is_asize_32, ESI, diff);
        set_ecx_asize(is_asize_32, count);
        *timestamp_counter =
            (*timestamp_counter as u32).wrapping_add((start_count - count) as u32) as u32 as u32;
        if 0 != cont {
            *instruction_pointer = *previous_ip
        }
        return;
    };
}
#[no_mangle]
pub unsafe fn lodsb_no_rep(is_asize_32: bool, ds: i32) {
    let src = ds + if is_asize_32 { read_reg32(ESI) } else { read_reg16(SI) };
    let size = if 0 != *flags & FLAG_DIRECTION { -1 } else { 1 };
    *reg8.offset(AL as isize) = return_on_pagefault!(safe_read8(src)) as u8;
    add_reg_asize(is_asize_32, ESI, size);
}
#[no_mangle]
pub unsafe fn lodsw_rep(is_asize_32: bool, ds: i32) {
    let mut src: i32 = ds + if is_asize_32 { read_reg32(ESI) } else { read_reg16(SI) };
    let size = if 0 != *flags & FLAG_DIRECTION { -2 } else { 2 };
    let count = if is_asize_32 { read_reg32(ECX) } else { read_reg16(CX) } as u32;
    if count == 0 {
        return;
    }
    else {
        let mut cont;
        let mut cycle_counter: u32 = MAX_COUNT_PER_CYCLE as u32;
        loop {
            *reg16.offset(AX as isize) = return_on_pagefault!(safe_read16(src)) as u16;
            src += size;
            add_reg_asize(is_asize_32, ESI, size);
            cont = decr_ecx_asize(is_asize_32) != 0;
            if !(0 != cont as i32 && {
                cycle_counter = cycle_counter.wrapping_sub(1);
                0 != cycle_counter
            }) {
                break;
            }
        }
        if cont {
            *instruction_pointer = *previous_ip
        }
        return;
    };
}
#[no_mangle]
pub unsafe fn lodsw_no_rep(is_asize_32: bool, ds: i32) {
    let src = ds + if is_asize_32 { read_reg32(ESI) } else { read_reg16(SI) };
    let size = if 0 != *flags & FLAG_DIRECTION { -2 } else { 2 };
    *reg16.offset(AX as isize) = return_on_pagefault!(safe_read16(src)) as u16;
    add_reg_asize(is_asize_32, ESI, size);
}
#[no_mangle]
pub unsafe fn lodsd_rep(is_asize_32: bool, ds: i32) {
    let mut src: i32 = ds + if is_asize_32 { read_reg32(ESI) } else { read_reg16(SI) };
    let size = if 0 != *flags & FLAG_DIRECTION { -4 } else { 4 };
    let count = if is_asize_32 { read_reg32(ECX) } else { read_reg16(CX) };
    if count == 0 {
        return;
    }
    else {
        let mut cont;
        let mut cycle_counter: i32 = MAX_COUNT_PER_CYCLE;
        loop {
            *reg32.offset(EAX as isize) = return_on_pagefault!(safe_read32s(src));
            src += size;
            add_reg_asize(is_asize_32, ESI, size);
            cont = (decr_ecx_asize(is_asize_32) != 0) as i32;
            if !(0 != cont && {
                cycle_counter -= 1;
                0 != cycle_counter
            }) {
                break;
            }
        }
        if 0 != cont {
            *instruction_pointer = *previous_ip
        }
        return;
    };
}
#[no_mangle]
pub unsafe fn lodsd_no_rep(is_asize_32: bool, ds: i32) {
    let src = ds + if is_asize_32 { read_reg32(ESI) } else { read_reg16(SI) };
    let size = if 0 != *flags & FLAG_DIRECTION { -4 } else { 4 };
    *reg32.offset(EAX as isize) = return_on_pagefault!(safe_read32s(src));
    add_reg_asize(is_asize_32, ESI, size);
}
#[no_mangle]
pub unsafe fn scasb_rep(prefix_flag: i32, is_asize_32: bool) {
    let dest = return_on_pagefault!(get_seg(ES))
        + if is_asize_32 { read_reg32(EDI) } else { read_reg16(DI) };
    let size = if 0 != *flags & FLAG_DIRECTION { -1 } else { 1 };
    let mut data_dest;
    let data_src = *reg8.offset(AL as isize) as i32;
    let mut count: i32 = if is_asize_32 { read_reg32(ECX) } else { read_reg16(CX) };
    if count == 0 {
        return;
    }
    else {
        let mut cont;
        let start_count = count;
        let is_repz = (prefix_flag == PREFIX_REPZ) as i32;
        let mut cycle_counter: i32 = string_get_cycle_count(size, dest);
        let mut phys_dest: i32 = return_on_pagefault!(translate_address_read(dest)) as i32;
        loop {
            data_dest = read8(phys_dest as u32);
            phys_dest += size;
            count -= 1;
            cont = (count != 0 && (data_src == data_dest) as i32 == is_repz) as i32;
            if !(0 != cont && {
                cycle_counter -= 1;
                0 != cycle_counter
            }) {
                break;
            }
        }
        let diff = size * (start_count - count);
        add_reg_asize(is_asize_32, EDI, diff);
        set_ecx_asize(is_asize_32, count);
        *timestamp_counter =
            (*timestamp_counter as u32).wrapping_add((start_count - count) as u32) as u32 as u32;
        if 0 != cont {
            *instruction_pointer = *previous_ip
        }
        cmp8(data_src, data_dest);
        return;
    };
}
#[no_mangle]
pub unsafe fn scasb_no_rep(is_asize_32: bool) {
    let dest = return_on_pagefault!(get_seg(ES))
        + if is_asize_32 { read_reg32(EDI) } else { read_reg16(DI) };
    let size = if 0 != *flags & FLAG_DIRECTION { -1 } else { 1 };
    let data_dest;
    let data_src = *reg8.offset(AL as isize) as i32;
    data_dest = return_on_pagefault!(safe_read8(dest));
    add_reg_asize(is_asize_32, EDI, size);
    cmp8(data_src, data_dest);
}
#[no_mangle]
pub unsafe fn scasw_rep(prefix_flag: i32, is_asize_32: bool) {
    let diff;
    let mut dest: i32 = return_on_pagefault!(get_seg(ES))
        + if is_asize_32 { read_reg32(EDI) } else { read_reg16(DI) };
    let size = if 0 != *flags & FLAG_DIRECTION { -2 } else { 2 };
    let mut data_dest;
    let data_src = *reg16.offset(AL as isize) as i32;
    let mut count: i32 = if is_asize_32 { read_reg32(ECX) } else { read_reg16(CX) };
    if count == 0 {
        return;
    }
    else {
        let mut cont;
        let start_count = count;
        let is_repz = (prefix_flag == PREFIX_REPZ) as i32;
        let mut cycle_counter: i32 = MAX_COUNT_PER_CYCLE;
        if 0 == dest & 1 {
            let single_size = if size < 0 { -1 } else { 1 };
            let mut phys_dest: i32 =
                (return_on_pagefault!(translate_address_read(dest)) >> 1) as i32;
            cycle_counter = string_get_cycle_count(size, dest);
            loop {
                data_dest = read_aligned16(phys_dest as u32);
                phys_dest += single_size;
                count -= 1;
                cont = (count != 0 && (data_src == data_dest) as i32 == is_repz) as i32;
                if !(0 != cont && {
                    cycle_counter -= 1;
                    0 != cycle_counter
                }) {
                    break;
                }
            }
            diff = size * (start_count - count);
            add_reg_asize(is_asize_32, EDI, diff);
            set_ecx_asize(is_asize_32, count);
            *timestamp_counter =
                (*timestamp_counter as u32).wrapping_add((start_count - count) as u32) as u32 as u32
        }
        else {
            loop {
                data_dest = return_on_pagefault!(safe_read16(dest));
                dest += size;
                add_reg_asize(is_asize_32, EDI, size);
                cont = (decr_ecx_asize(is_asize_32) != 0
                    && (data_src == data_dest) as i32 == is_repz) as i32;
                if !(0 != cont && {
                    cycle_counter -= 1;
                    0 != cycle_counter
                }) {
                    break;
                }
            }
        }
        if 0 != cont {
            *instruction_pointer = *previous_ip
        }
        cmp16(data_src, data_dest);
        return;
    };
}
#[no_mangle]
pub unsafe fn scasw_no_rep(is_asize_32: bool) {
    let dest = return_on_pagefault!(get_seg(ES))
        + if is_asize_32 { read_reg32(EDI) } else { read_reg16(DI) };
    let size = if 0 != *flags & FLAG_DIRECTION { -2 } else { 2 };
    let data_dest;
    let data_src = *reg16.offset(AL as isize) as i32;
    data_dest = return_on_pagefault!(safe_read16(dest));
    add_reg_asize(is_asize_32, EDI, size);
    cmp16(data_src, data_dest);
}
#[no_mangle]
pub unsafe fn scasd_rep(prefix_flag: i32, is_asize_32: bool) {
    let diff;
    let mut dest: i32 = return_on_pagefault!(get_seg(ES))
        + if is_asize_32 { read_reg32(EDI) } else { read_reg16(DI) };
    let size = if 0 != *flags & FLAG_DIRECTION { -4 } else { 4 };
    let mut data_dest;
    let data_src = *reg32.offset(EAX as isize);
    let mut count: i32 = if is_asize_32 { read_reg32(ECX) } else { read_reg16(CX) };
    if count == 0 {
        return;
    }
    else {
        let mut cont;
        let start_count = count;
        let is_repz = (prefix_flag == PREFIX_REPZ) as i32;
        let mut cycle_counter: i32 = MAX_COUNT_PER_CYCLE;
        if 0 == dest & 3 {
            let single_size = if size < 0 { -1 } else { 1 };
            let mut phys_dest: i32 =
                (return_on_pagefault!(translate_address_read(dest)) >> 2) as i32;
            cycle_counter = string_get_cycle_count(size, dest);
            loop {
                data_dest = read_aligned32(phys_dest as u32);
                phys_dest += single_size;
                count -= 1;
                cont = (count != 0 && (data_src == data_dest) as i32 == is_repz) as i32;
                if !(0 != cont && {
                    cycle_counter -= 1;
                    0 != cycle_counter
                }) {
                    break;
                }
            }
            diff = size * (start_count - count);
            add_reg_asize(is_asize_32, EDI, diff);
            set_ecx_asize(is_asize_32, count);
            *timestamp_counter =
                (*timestamp_counter as u32).wrapping_add((start_count - count) as u32) as u32 as u32
        }
        else {
            loop {
                data_dest = return_on_pagefault!(safe_read32s(dest));
                dest += size;
                add_reg_asize(is_asize_32, EDI, size);
                cont = (decr_ecx_asize(is_asize_32) != 0
                    && (data_src == data_dest) as i32 == is_repz) as i32;
                if !(0 != cont && {
                    cycle_counter -= 1;
                    0 != cycle_counter
                }) {
                    break;
                }
            }
        }
        if 0 != cont {
            *instruction_pointer = *previous_ip
        }
        cmp32(data_src, data_dest);
        return;
    };
}
#[no_mangle]
pub unsafe fn scasd_no_rep(is_asize_32: bool) {
    let dest = return_on_pagefault!(get_seg(ES))
        + if is_asize_32 { read_reg32(EDI) } else { read_reg16(DI) };
    let size = if 0 != *flags & FLAG_DIRECTION { -4 } else { 4 };
    let data_dest;
    let data_src = *reg32.offset(EAX as isize);
    data_dest = return_on_pagefault!(safe_read32s(dest));
    add_reg_asize(is_asize_32, EDI, size);
    cmp32(data_src, data_dest);
}
#[no_mangle]
pub unsafe fn insb_rep(is_asize_32: bool) {
    let port = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 1) {
        return;
    }
    else {
        let dest = return_on_pagefault!(get_seg(ES))
            + if is_asize_32 { read_reg32(EDI) } else { read_reg16(DI) };
        let size = if 0 != *flags & FLAG_DIRECTION { -1 } else { 1 };
        let mut count: i32 = if is_asize_32 { read_reg32(ECX) } else { read_reg16(CX) };
        if count == 0 {
            return;
        }
        else {
            let mut cont;
            let start_count = count;
            let mut cycle_counter: i32 = string_get_cycle_count(size, dest);
            let mut phys_dest: i32 = return_on_pagefault!(translate_address_write(dest)) as i32;
            loop {
                write8(phys_dest as u32, io_port_read8(port));
                phys_dest += size;
                count -= 1;
                cont = (count != 0) as i32;
                if !(0 != cont && {
                    cycle_counter -= 1;
                    0 != cycle_counter
                }) {
                    break;
                }
            }
            let diff = size * (start_count - count);
            add_reg_asize(is_asize_32, EDI, diff);
            set_ecx_asize(is_asize_32, count);
            *timestamp_counter = (*timestamp_counter as u32)
                .wrapping_add((start_count - count) as u32) as u32
                as u32;
            if 0 != cont {
                *instruction_pointer = *previous_ip
            }
            return;
        }
    };
}
#[no_mangle]
pub unsafe fn insb_no_rep(is_asize_32: bool) {
    let port = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 1) {
        return;
    }
    else {
        let dest = return_on_pagefault!(get_seg(ES))
            + if is_asize_32 { read_reg32(EDI) } else { read_reg16(DI) };
        let size = if 0 != *flags & FLAG_DIRECTION { -1 } else { 1 };
        return_on_pagefault!(writable_or_pagefault(dest, 1));
        return_on_pagefault!(safe_write8(dest, io_port_read8(port)));
        add_reg_asize(is_asize_32, EDI, size);
        return;
    };
}
#[no_mangle]
pub unsafe fn insw_rep(is_asize_32: bool) {
    let diff;
    let port = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 2) {
        return;
    }
    else {
        let mut dest: i32 = return_on_pagefault!(get_seg(ES))
            + if is_asize_32 { read_reg32(EDI) } else { read_reg16(DI) };
        let size = if 0 != *flags & FLAG_DIRECTION { -2 } else { 2 };
        let mut count: i32 = if is_asize_32 { read_reg32(ECX) } else { read_reg16(CX) };
        if count == 0 {
            return;
        }
        else {
            let mut cont;
            let start_count = count;
            let mut cycle_counter: i32 = MAX_COUNT_PER_CYCLE;
            if 0 == dest & 1 {
                let single_size = if size < 0 { -1 } else { 1 };
                let mut phys_dest: i32 =
                    (return_on_pagefault!(translate_address_write(dest)) >> 1) as i32;
                cycle_counter = string_get_cycle_count(size, dest);
                loop {
                    write_aligned16(phys_dest as u32, io_port_read16(port) as u32);
                    phys_dest += single_size;
                    count -= 1;
                    cont = (count != 0) as i32;
                    if !(0 != cont && {
                        cycle_counter -= 1;
                        0 != cycle_counter
                    }) {
                        break;
                    }
                }
                diff = size * (start_count - count);
                add_reg_asize(is_asize_32, EDI, diff);
                set_ecx_asize(is_asize_32, count);
                *timestamp_counter = (*timestamp_counter as u32)
                    .wrapping_add((start_count - count) as u32)
                    as u32 as u32
            }
            else {
                loop {
                    return_on_pagefault!(writable_or_pagefault(dest, 2));
                    return_on_pagefault!(safe_write16(dest, io_port_read16(port)));
                    dest += size;
                    add_reg_asize(is_asize_32, EDI, size);
                    cont = (decr_ecx_asize(is_asize_32) != 0) as i32;
                    if !(0 != cont && {
                        cycle_counter -= 1;
                        0 != cycle_counter
                    }) {
                        break;
                    }
                }
            }
            if 0 != cont {
                *instruction_pointer = *previous_ip
            }
            return;
        }
    };
}
#[no_mangle]
pub unsafe fn insw_no_rep(is_asize_32: bool) {
    let port = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 2) {
        return;
    }
    else {
        let dest = return_on_pagefault!(get_seg(ES))
            + if is_asize_32 { read_reg32(EDI) } else { read_reg16(DI) };
        let size = if 0 != *flags & FLAG_DIRECTION { -2 } else { 2 };
        return_on_pagefault!(writable_or_pagefault(dest, 2));
        return_on_pagefault!(safe_write16(dest, io_port_read16(port)));
        add_reg_asize(is_asize_32, EDI, size);
        return;
    };
}
#[no_mangle]
pub unsafe fn insd_rep(is_asize_32: bool) {
    let diff;
    let port = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 4) {
        return;
    }
    else {
        let mut dest: i32 = return_on_pagefault!(get_seg(ES))
            + if is_asize_32 { read_reg32(EDI) } else { read_reg16(DI) };
        let size = if 0 != *flags & FLAG_DIRECTION { -4 } else { 4 };
        let mut count: i32 = if is_asize_32 { read_reg32(ECX) } else { read_reg16(CX) };
        if count == 0 {
            return;
        }
        else {
            let mut cont;
            let start_count = count;
            let mut cycle_counter: i32 = MAX_COUNT_PER_CYCLE;
            if 0 == dest & 3 {
                let single_size = if size < 0 { -1 } else { 1 };
                let mut phys_dest: i32 =
                    (return_on_pagefault!(translate_address_write(dest)) >> 2) as i32;
                cycle_counter = string_get_cycle_count(size, dest);
                loop {
                    write_aligned32(phys_dest as u32, io_port_read32(port));
                    phys_dest += single_size;
                    count -= 1;
                    cont = (count != 0) as i32;
                    if !(0 != cont && {
                        cycle_counter -= 1;
                        0 != cycle_counter
                    }) {
                        break;
                    }
                }
                diff = size * (start_count - count);
                add_reg_asize(is_asize_32, EDI, diff);
                set_ecx_asize(is_asize_32, count);
                *timestamp_counter = (*timestamp_counter as u32)
                    .wrapping_add((start_count - count) as u32)
                    as u32 as u32
            }
            else {
                loop {
                    return_on_pagefault!(writable_or_pagefault(dest, 4));
                    return_on_pagefault!(safe_write32(dest, io_port_read32(port)));
                    dest += size;
                    add_reg_asize(is_asize_32, EDI, size);
                    cont = (decr_ecx_asize(is_asize_32) != 0) as i32;
                    if !(0 != cont && {
                        cycle_counter -= 1;
                        0 != cycle_counter
                    }) {
                        break;
                    }
                }
            }
            if 0 != cont {
                *instruction_pointer = *previous_ip
            }
            return;
        }
    };
}
#[no_mangle]
pub unsafe fn insd_no_rep(is_asize_32: bool) {
    let port = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 4) {
        return;
    }
    else {
        let dest = return_on_pagefault!(get_seg(ES))
            + if is_asize_32 { read_reg32(EDI) } else { read_reg16(DI) };
        let size = if 0 != *flags & FLAG_DIRECTION { -4 } else { 4 };
        return_on_pagefault!(writable_or_pagefault(dest, 4));
        return_on_pagefault!(safe_write32(dest, io_port_read32(port)));
        add_reg_asize(is_asize_32, EDI, size);
        return;
    };
}
#[no_mangle]
pub unsafe fn outsb_rep(is_asize_32: bool, ds: i32) {
    let port = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 1) {
        return;
    }
    else {
        let src = ds + if is_asize_32 { read_reg32(ESI) } else { read_reg16(SI) };
        let size = if 0 != *flags & FLAG_DIRECTION { -1 } else { 1 };
        let mut count: i32 = if is_asize_32 { read_reg32(ECX) } else { read_reg16(CX) };
        if count == 0 {
            return;
        }
        else {
            let mut cont;
            let start_count = count;
            let mut cycle_counter: i32 = string_get_cycle_count(size, src);
            let mut phys_src: i32 = return_on_pagefault!(translate_address_read(src)) as i32;
            loop {
                io_port_write8(port, read8(phys_src as u32));
                phys_src += size;
                count -= 1;
                cont = (count != 0) as i32;
                if !(0 != cont && {
                    cycle_counter -= 1;
                    0 != cycle_counter
                }) {
                    break;
                }
            }
            let diff = size * (start_count - count);
            add_reg_asize(is_asize_32, ESI, diff);
            set_ecx_asize(is_asize_32, count);
            *timestamp_counter = (*timestamp_counter as u32)
                .wrapping_add((start_count - count) as u32) as u32
                as u32;
            if 0 != cont {
                *instruction_pointer = *previous_ip
            }
            return;
        }
    };
}
#[no_mangle]
pub unsafe fn outsb_no_rep(is_asize_32: bool, ds: i32) {
    let port = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 1) {
        return;
    }
    else {
        let src = ds + if is_asize_32 { read_reg32(ESI) } else { read_reg16(SI) };
        let size = if 0 != *flags & FLAG_DIRECTION { -1 } else { 1 };
        io_port_write8(port, return_on_pagefault!(safe_read8(src)));
        add_reg_asize(is_asize_32, ESI, size);
        return;
    };
}
#[no_mangle]
pub unsafe fn outsw_rep(is_asize_32: bool, ds: i32) {
    let diff;
    let port = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 2) {
        return;
    }
    else {
        let mut src: i32 = ds + if is_asize_32 { read_reg32(ESI) } else { read_reg16(SI) };
        let size = if 0 != *flags & FLAG_DIRECTION { -2 } else { 2 };
        let mut count: i32 = if is_asize_32 { read_reg32(ECX) } else { read_reg16(CX) };
        if count == 0 {
            return;
        }
        else {
            let mut cont;
            let start_count = count;
            let mut cycle_counter: i32 = MAX_COUNT_PER_CYCLE;
            if 0 == src & 1 {
                let single_size = if size < 0 { -1 } else { 1 };
                let mut phys_src: i32 =
                    (return_on_pagefault!(translate_address_read(src)) >> 1) as i32;
                cycle_counter = string_get_cycle_count(size, src);
                loop {
                    io_port_write16(port, read_aligned16(phys_src as u32));
                    phys_src += single_size;
                    count -= 1;
                    cont = (count != 0) as i32;
                    if !(0 != cont && {
                        cycle_counter -= 1;
                        0 != cycle_counter
                    }) {
                        break;
                    }
                }
                diff = size * (start_count - count);
                add_reg_asize(is_asize_32, ESI, diff);
                set_ecx_asize(is_asize_32, count);
                *timestamp_counter = (*timestamp_counter as u32)
                    .wrapping_add((start_count - count) as u32)
                    as u32 as u32
            }
            else {
                loop {
                    io_port_write16(port, return_on_pagefault!(safe_read16(src)));
                    src += size;
                    add_reg_asize(is_asize_32, ESI, size);
                    cont = (decr_ecx_asize(is_asize_32) != 0) as i32;
                    if !(0 != cont && {
                        cycle_counter -= 1;
                        0 != cycle_counter
                    }) {
                        break;
                    }
                }
            }
            if 0 != cont {
                *instruction_pointer = *previous_ip
            }
            return;
        }
    };
}
#[no_mangle]
pub unsafe fn outsw_no_rep(is_asize_32: bool, ds: i32) {
    let port = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 2) {
        return;
    }
    else {
        let src = ds + if is_asize_32 { read_reg32(ESI) } else { read_reg16(SI) };
        let size = if 0 != *flags & FLAG_DIRECTION { -2 } else { 2 };
        io_port_write16(port, return_on_pagefault!(safe_read16(src)));
        add_reg_asize(is_asize_32, ESI, size);
        return;
    };
}
#[no_mangle]
pub unsafe fn outsd_rep(is_asize_32: bool, ds: i32) {
    let diff;
    let port = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 4) {
        return;
    }
    else {
        let mut src: i32 = ds + if is_asize_32 { read_reg32(ESI) } else { read_reg16(SI) };
        let size = if 0 != *flags & FLAG_DIRECTION { -4 } else { 4 };
        let mut count: i32 = if is_asize_32 { read_reg32(ECX) } else { read_reg16(CX) };
        if count == 0 {
            return;
        }
        else {
            let mut cont;
            let start_count = count;
            let mut cycle_counter: i32 = MAX_COUNT_PER_CYCLE;
            if 0 == src & 3 {
                let single_size = if size < 0 { -1 } else { 1 };
                let mut phys_src: i32 =
                    (return_on_pagefault!(translate_address_read(src)) >> 2) as i32;
                cycle_counter = string_get_cycle_count(size, src);
                loop {
                    io_port_write32(port, read_aligned32(phys_src as u32));
                    phys_src += single_size;
                    count -= 1;
                    cont = (count != 0) as i32;
                    if !(0 != cont && {
                        cycle_counter -= 1;
                        0 != cycle_counter
                    }) {
                        break;
                    }
                }
                diff = size * (start_count - count);
                add_reg_asize(is_asize_32, ESI, diff);
                set_ecx_asize(is_asize_32, count);
                *timestamp_counter = (*timestamp_counter as u32)
                    .wrapping_add((start_count - count) as u32)
                    as u32 as u32
            }
            else {
                loop {
                    io_port_write32(port, return_on_pagefault!(safe_read32s(src)));
                    src += size;
                    add_reg_asize(is_asize_32, ESI, size);
                    cont = (decr_ecx_asize(is_asize_32) != 0) as i32;
                    if !(0 != cont && {
                        cycle_counter -= 1;
                        0 != cycle_counter
                    }) {
                        break;
                    }
                }
            }
            if 0 != cont {
                *instruction_pointer = *previous_ip
            }
            return;
        }
    };
}
#[no_mangle]
pub unsafe fn outsd_no_rep(is_asize_32: bool, ds: i32) {
    let port = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 4) {
        return;
    }
    else {
        let src = ds + if is_asize_32 { read_reg32(ESI) } else { read_reg16(SI) };
        let size = if 0 != *flags & FLAG_DIRECTION { -4 } else { 4 };
        io_port_write32(port, return_on_pagefault!(safe_read32s(src)));
        add_reg_asize(is_asize_32, ESI, size);
        return;
    };
}
