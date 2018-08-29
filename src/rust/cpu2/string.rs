#![allow(mutable_transmutes, non_upper_case_globals, unused_mut)]

extern "C" {
    #[no_mangle]
    pub fn test_privileges_for_io(port: i32, size: i32) -> bool;

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

use cpu2::arith::{cmp16, cmp32, cmp8};
use cpu2::cpu::*;
use cpu2::global_pointers::*;
use cpu2::memory::{
    read8, read_aligned16, read_aligned32, write8, write_aligned16, write_aligned32,
};

const MAX_COUNT_PER_CYCLE: i32 = 4096i32;

#[no_mangle]
pub unsafe fn string_get_cycle_count(mut size: i32, mut address: i32) -> i32 {
    dbg_assert!(0 != size && size <= 4i32 && size >= -4i32);
    if size < 0i32 {
        size = -size;
        address = 4096i32 - address - size
    }
    dbg_assert!(address & size - 1i32 == 0i32);
    // 1 -> 0; 2 -> 1; 4 -> 2
    let mut shift: i32 = size >> 1i32;
    return 4096i32 - (address & 4095i32) >> shift;
}
#[no_mangle]
pub unsafe fn string_get_cycle_count2(mut size: i32, mut addr1: i32, mut addr2: i32) -> i32 {
    let mut c1: i32 = string_get_cycle_count(size, addr1);
    let mut c2: i32 = string_get_cycle_count(size, addr2);
    return if c1 < c2 { c1 } else { c2 };
}
#[no_mangle]
pub unsafe fn movsb_rep() -> () {
    let mut src: i32 = get_seg_prefix(DS) + get_reg_asize(ESI);
    let mut dest: i32 = get_seg(ES) + get_reg_asize(EDI);
    let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
        -1i32
    }
    else {
        1i32
    };
    let mut count: i32 = get_reg_asize(ECX);
    if count == 0i32 {
        return;
    }
    else {
        let mut cont: i32 = 0i32;
        let mut start_count: i32 = count;
        let mut cycle_counter: i32 = string_get_cycle_count2(size, src, dest);
        let mut phys_src: i32 = return_on_pagefault!(translate_address_read(src)) as i32;
        let mut phys_dest: i32 = return_on_pagefault!(translate_address_write(dest)) as i32;
        loop {
            write8(phys_dest as u32, read8(phys_src as u32));
            phys_dest += size;
            phys_src += size;
            count -= 1;
            cont = (count != 0i32) as i32;
            if !(0 != cont && {
                cycle_counter -= 1;
                0 != cycle_counter
            }) {
                break;
            }
        }
        let mut diff: i32 = size * (start_count - count);
        add_reg_asize(EDI, diff);
        add_reg_asize(ESI, diff);
        set_ecx_asize(count);
        *timestamp_counter =
            (*timestamp_counter as u32).wrapping_add((start_count - count) as u32) as u32 as u32;
        if 0 != cont {
            *instruction_pointer = *previous_ip
        }
        return;
    };
}
#[no_mangle]
pub unsafe fn movsb_no_rep() -> () {
    let mut src: i32 = get_seg_prefix(DS) + get_reg_asize(ESI);
    let mut dest: i32 = get_seg(ES) + get_reg_asize(EDI);
    let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
        -1i32
    }
    else {
        1i32
    };
    return_on_pagefault!(safe_write8(dest, return_on_pagefault!(safe_read8(src))));
    add_reg_asize(EDI, size);
    add_reg_asize(ESI, size);
}
#[no_mangle]
pub unsafe fn movsw_rep() -> () {
    let mut diff: i32 = 0;
    let mut src: i32 = get_seg_prefix(DS) + get_reg_asize(ESI);
    let mut dest: i32 = get_seg(ES) + get_reg_asize(EDI);
    let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
        -2i32
    }
    else {
        2i32
    };
    let mut count: i32 = get_reg_asize(ECX);
    if count == 0i32 {
        return;
    }
    else {
        let mut cont: i32 = 0i32;
        let mut start_count: i32 = count;
        let mut cycle_counter: i32 = MAX_COUNT_PER_CYCLE;
        if 0 == dest & 1i32 && 0 == src & 1i32 {
            let mut single_size: i32 = if size < 0i32 { -1i32 } else { 1i32 };
            let mut phys_src: i32 =
                (return_on_pagefault!(translate_address_read(src)) >> 1i32) as i32;
            let mut phys_dest: i32 =
                (return_on_pagefault!(translate_address_write(dest)) >> 1i32) as i32;
            cycle_counter = string_get_cycle_count2(size, src, dest);
            loop {
                write_aligned16(phys_dest as u32, read_aligned16(phys_src as u32) as u32);
                phys_dest += single_size;
                phys_src += single_size;
                count -= 1;
                cont = (count != 0i32) as i32;
                if !(0 != cont && {
                    cycle_counter -= 1;
                    0 != cycle_counter
                }) {
                    break;
                }
            }
            diff = size * (start_count - count);
            add_reg_asize(EDI, diff);
            add_reg_asize(ESI, diff);
            set_ecx_asize(count);
            *timestamp_counter =
                (*timestamp_counter as u32).wrapping_add((start_count - count) as u32) as u32 as u32
        }
        else {
            loop {
                return_on_pagefault!(safe_write16(dest, return_on_pagefault!(safe_read16(src))));
                dest += size;
                add_reg_asize(EDI, size);
                src += size;
                add_reg_asize(ESI, size);
                cont = (decr_ecx_asize() != 0i32) as i32;
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
pub unsafe fn movsw_no_rep() -> () {
    let mut src: i32 = get_seg_prefix(DS) + get_reg_asize(ESI);
    let mut dest: i32 = get_seg(ES) + get_reg_asize(EDI);
    let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
        -2i32
    }
    else {
        2i32
    };
    return_on_pagefault!(safe_write16(dest, return_on_pagefault!(safe_read16(src))));
    add_reg_asize(EDI, size);
    add_reg_asize(ESI, size);
}
#[no_mangle]
pub unsafe fn movsd_rep() -> () {
    let mut diff: i32 = 0;
    let mut src: i32 = get_seg_prefix(DS) + get_reg_asize(ESI);
    let mut dest: i32 = get_seg(ES) + get_reg_asize(EDI);
    let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
        -4i32
    }
    else {
        4i32
    };
    let mut count: i32 = get_reg_asize(ECX);
    if count == 0i32 {
        return;
    }
    else {
        let mut cont: i32 = 0i32;
        let mut start_count: i32 = count;
        let mut cycle_counter: i32 = MAX_COUNT_PER_CYCLE;
        if 0 == dest & 3i32 && 0 == src & 3i32 {
            let mut single_size: i32 = if size < 0i32 { -1i32 } else { 1i32 };
            let mut phys_src: i32 =
                (return_on_pagefault!(translate_address_read(src)) >> 2i32) as i32;
            let mut phys_dest: i32 =
                (return_on_pagefault!(translate_address_write(dest)) >> 2i32) as i32;
            cycle_counter = string_get_cycle_count2(size, src, dest);
            loop {
                write_aligned32(phys_dest as u32, read_aligned32(phys_src as u32));
                phys_dest += single_size;
                phys_src += single_size;
                count -= 1;
                cont = (count != 0i32) as i32;
                if !(0 != cont && {
                    cycle_counter -= 1;
                    0 != cycle_counter
                }) {
                    break;
                }
            }
            diff = size * (start_count - count);
            add_reg_asize(EDI, diff);
            add_reg_asize(ESI, diff);
            set_ecx_asize(count);
            *timestamp_counter =
                (*timestamp_counter as u32).wrapping_add((start_count - count) as u32) as u32 as u32
        }
        else {
            loop {
                return_on_pagefault!(safe_write32(dest, return_on_pagefault!(safe_read32s(src))));
                dest += size;
                add_reg_asize(EDI, size);
                src += size;
                add_reg_asize(ESI, size);
                cont = (decr_ecx_asize() != 0i32) as i32;
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
pub unsafe fn movsd_no_rep() -> () {
    let mut src: i32 = get_seg_prefix(DS) + get_reg_asize(ESI);
    let mut dest: i32 = get_seg(ES) + get_reg_asize(EDI);
    let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
        -4i32
    }
    else {
        4i32
    };
    return_on_pagefault!(safe_write32(dest, return_on_pagefault!(safe_read32s(src))));
    add_reg_asize(EDI, size);
    add_reg_asize(ESI, size);
}
#[no_mangle]
pub unsafe fn cmpsb_rep(mut prefix_flag: i32) -> () {
    let mut src: i32 = get_seg_prefix(DS) + get_reg_asize(ESI);
    let mut dest: i32 = get_seg(ES) + get_reg_asize(EDI);
    let mut data_src: i32 = 0;
    let mut data_dest: i32 = 0;
    let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
        -1i32
    }
    else {
        1i32
    };
    let mut count: i32 = get_reg_asize(ECX);
    if count == 0i32 {
        return;
    }
    else {
        let mut cont: i32 = 0i32;
        let mut start_count: i32 = count;
        let mut is_repz: i32 = (prefix_flag == PREFIX_REPZ) as i32;
        let mut cycle_counter: i32 = string_get_cycle_count2(size, src, dest);
        let mut phys_src: i32 = return_on_pagefault!(translate_address_read(src)) as i32;
        let mut phys_dest: i32 = return_on_pagefault!(translate_address_read(dest)) as i32;
        loop {
            data_dest = read8(phys_dest as u32);
            data_src = read8(phys_src as u32);
            phys_dest += size;
            phys_src += size;
            count -= 1;
            cont = (count != 0i32 && (data_src == data_dest) as i32 == is_repz) as i32;
            if !(0 != cont && {
                cycle_counter -= 1;
                0 != cycle_counter
            }) {
                break;
            }
        }
        let mut diff: i32 = size * (start_count - count);
        add_reg_asize(EDI, diff);
        add_reg_asize(ESI, diff);
        set_ecx_asize(count);
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
pub unsafe fn cmpsb_no_rep() -> () {
    let mut src: i32 = get_seg_prefix(DS) + get_reg_asize(ESI);
    let mut dest: i32 = get_seg(ES) + get_reg_asize(EDI);
    let mut data_src: i32 = 0;
    let mut data_dest: i32 = 0;
    let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
        -1i32
    }
    else {
        1i32
    };
    data_src = return_on_pagefault!(safe_read8(src));
    data_dest = return_on_pagefault!(safe_read8(dest));
    add_reg_asize(EDI, size);
    add_reg_asize(ESI, size);
    cmp8(data_src, data_dest);
}
#[no_mangle]
pub unsafe fn cmpsw_rep(mut prefix_flag: i32) -> () {
    let mut diff: i32 = 0;
    let mut src: i32 = get_seg_prefix(DS) + get_reg_asize(ESI);
    let mut dest: i32 = get_seg(ES) + get_reg_asize(EDI);
    let mut data_src: i32 = 0;
    let mut data_dest: i32 = 0;
    let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
        -2i32
    }
    else {
        2i32
    };
    let mut count: i32 = get_reg_asize(ECX);
    if count == 0i32 {
        return;
    }
    else {
        let mut cont: i32 = 0i32;
        let mut start_count: i32 = count;
        let mut is_repz: i32 = (prefix_flag == PREFIX_REPZ) as i32;
        let mut cycle_counter: i32 = MAX_COUNT_PER_CYCLE;
        if 0 == dest & 1i32 && 0 == src & 1i32 {
            let mut single_size: i32 = if size < 0i32 { -1i32 } else { 1i32 };
            let mut phys_src: i32 =
                (return_on_pagefault!(translate_address_read(src)) >> 1i32) as i32;
            let mut phys_dest: i32 =
                (return_on_pagefault!(translate_address_read(dest)) >> 1i32) as i32;
            cycle_counter = string_get_cycle_count2(size, src, dest);
            loop {
                data_dest = read_aligned16(phys_dest as u32);
                data_src = read_aligned16(phys_src as u32);
                phys_dest += single_size;
                phys_src += single_size;
                count -= 1;
                cont = (count != 0i32 && (data_src == data_dest) as i32 == is_repz) as i32;
                if !(0 != cont && {
                    cycle_counter -= 1;
                    0 != cycle_counter
                }) {
                    break;
                }
            }
            diff = size * (start_count - count);
            add_reg_asize(EDI, diff);
            add_reg_asize(ESI, diff);
            set_ecx_asize(count);
            *timestamp_counter =
                (*timestamp_counter as u32).wrapping_add((start_count - count) as u32) as u32 as u32
        }
        else {
            loop {
                data_dest = return_on_pagefault!(safe_read16(dest));
                data_src = return_on_pagefault!(safe_read16(src));
                dest += size;
                add_reg_asize(EDI, size);
                src += size;
                add_reg_asize(ESI, size);
                cont =
                    (decr_ecx_asize() != 0i32 && (data_src == data_dest) as i32 == is_repz) as i32;
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
pub unsafe fn cmpsw_no_rep() -> () {
    let mut src: i32 = get_seg_prefix(DS) + get_reg_asize(ESI);
    let mut dest: i32 = get_seg(ES) + get_reg_asize(EDI);
    let mut data_src: i32 = 0;
    let mut data_dest: i32 = 0;
    let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
        -2i32
    }
    else {
        2i32
    };
    data_dest = return_on_pagefault!(safe_read16(dest));
    data_src = return_on_pagefault!(safe_read16(src));
    add_reg_asize(EDI, size);
    add_reg_asize(ESI, size);
    cmp16(data_src, data_dest);
}
#[no_mangle]
pub unsafe fn cmpsd_rep(mut prefix_flag: i32) -> () {
    let mut diff: i32 = 0;
    let mut src: i32 = get_seg_prefix(DS) + get_reg_asize(ESI);
    let mut dest: i32 = get_seg(ES) + get_reg_asize(EDI);
    let mut data_src: i32 = 0;
    let mut data_dest: i32 = 0;
    let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
        -4i32
    }
    else {
        4i32
    };
    let mut count: i32 = get_reg_asize(ECX);
    if count == 0i32 {
        return;
    }
    else {
        let mut cont: i32 = 0i32;
        let mut start_count: i32 = count;
        let mut is_repz: i32 = (prefix_flag == PREFIX_REPZ) as i32;
        let mut cycle_counter: i32 = MAX_COUNT_PER_CYCLE;
        if 0 == dest & 3i32 && 0 == src & 3i32 {
            let mut single_size: i32 = if size < 0i32 { -1i32 } else { 1i32 };
            let mut phys_src: i32 =
                (return_on_pagefault!(translate_address_read(src)) >> 2i32) as i32;
            let mut phys_dest: i32 =
                (return_on_pagefault!(translate_address_read(dest)) >> 2i32) as i32;
            cycle_counter = string_get_cycle_count2(size, src, dest);
            loop {
                data_dest = read_aligned32(phys_dest as u32);
                data_src = read_aligned32(phys_src as u32);
                phys_dest += single_size;
                phys_src += single_size;
                count -= 1;
                cont = (count != 0i32 && (data_src == data_dest) as i32 == is_repz) as i32;
                if !(0 != cont && {
                    cycle_counter -= 1;
                    0 != cycle_counter
                }) {
                    break;
                }
            }
            diff = size * (start_count - count);
            add_reg_asize(EDI, diff);
            add_reg_asize(ESI, diff);
            set_ecx_asize(count);
            *timestamp_counter =
                (*timestamp_counter as u32).wrapping_add((start_count - count) as u32) as u32 as u32
        }
        else {
            loop {
                data_dest = return_on_pagefault!(safe_read32s(dest));
                data_src = return_on_pagefault!(safe_read32s(src));
                dest += size;
                add_reg_asize(EDI, size);
                src += size;
                add_reg_asize(ESI, size);
                cont =
                    (decr_ecx_asize() != 0i32 && (data_src == data_dest) as i32 == is_repz) as i32;
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
pub unsafe fn cmpsd_no_rep() -> () {
    let mut src: i32 = get_seg_prefix(DS) + get_reg_asize(ESI);
    let mut dest: i32 = get_seg(ES) + get_reg_asize(EDI);
    let mut data_src: i32 = 0;
    let mut data_dest: i32 = 0;
    let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
        -4i32
    }
    else {
        4i32
    };
    data_dest = return_on_pagefault!(safe_read32s(dest));
    data_src = return_on_pagefault!(safe_read32s(src));
    add_reg_asize(EDI, size);
    add_reg_asize(ESI, size);
    cmp32(data_src, data_dest);
}
#[no_mangle]
pub unsafe fn stosb_rep() -> () {
    let mut data: i32 = *reg8.offset(AL as isize) as i32;
    let mut dest: i32 = get_seg(ES) + get_reg_asize(EDI);
    let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
        -1i32
    }
    else {
        1i32
    };
    let mut count: i32 = get_reg_asize(ECX);
    if count == 0i32 {
        return;
    }
    else {
        let mut cont: i32 = 0i32;
        let mut start_count: i32 = count;
        let mut cycle_counter: i32 = string_get_cycle_count(size, dest);
        let mut phys_dest: i32 = return_on_pagefault!(translate_address_write(dest)) as i32;
        loop {
            write8(phys_dest as u32, data);
            phys_dest += size;
            count -= 1;
            cont = (count != 0i32) as i32;
            if !(0 != cont && {
                cycle_counter -= 1;
                0 != cycle_counter
            }) {
                break;
            }
        }
        let mut diff: i32 = size * (start_count - count);
        add_reg_asize(EDI, diff);
        set_ecx_asize(count);
        *timestamp_counter =
            (*timestamp_counter as u32).wrapping_add((start_count - count) as u32) as u32 as u32;
        if 0 != cont {
            *instruction_pointer = *previous_ip
        }
        return;
    };
}
#[no_mangle]
pub unsafe fn stosb_no_rep() -> () {
    let mut data: i32 = *reg8.offset(AL as isize) as i32;
    let mut dest: i32 = get_seg(ES) + get_reg_asize(EDI);
    let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
        -1i32
    }
    else {
        1i32
    };
    return_on_pagefault!(safe_write8(dest, data));
    add_reg_asize(EDI, size);
}
#[no_mangle]
pub unsafe fn stosw_rep() -> () {
    let mut diff: i32 = 0;
    let mut data: i32 = *reg16.offset(AX as isize) as i32;
    let mut dest: i32 = get_seg(ES) + get_reg_asize(EDI);
    let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
        -2i32
    }
    else {
        2i32
    };
    let mut count: i32 = get_reg_asize(ECX);
    if count == 0i32 {
        return;
    }
    else {
        let mut cont: i32 = 0i32;
        let mut start_count: i32 = count;
        let mut cycle_counter: i32 = MAX_COUNT_PER_CYCLE;
        if 0 == dest & 1i32 {
            let mut single_size: i32 = if size < 0i32 { -1i32 } else { 1i32 };
            let mut phys_dest: i32 =
                (return_on_pagefault!(translate_address_write(dest)) >> 1i32) as i32;
            cycle_counter = string_get_cycle_count(size, dest);
            loop {
                write_aligned16(phys_dest as u32, data as u32);
                phys_dest += single_size;
                count -= 1;
                cont = (count != 0i32) as i32;
                if !(0 != cont && {
                    cycle_counter -= 1;
                    0 != cycle_counter
                }) {
                    break;
                }
            }
            diff = size * (start_count - count);
            add_reg_asize(EDI, diff);
            set_ecx_asize(count);
            *timestamp_counter =
                (*timestamp_counter as u32).wrapping_add((start_count - count) as u32) as u32 as u32
        }
        else {
            loop {
                return_on_pagefault!(safe_write16(dest, data));
                dest += size;
                add_reg_asize(EDI, size);
                cont = (decr_ecx_asize() != 0i32) as i32;
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
pub unsafe fn stosw_no_rep() -> () {
    let mut data: i32 = *reg16.offset(AX as isize) as i32;
    let mut dest: i32 = get_seg(ES) + get_reg_asize(EDI);
    let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
        -2i32
    }
    else {
        2i32
    };
    return_on_pagefault!(safe_write16(dest, data));
    add_reg_asize(EDI, size);
}
#[no_mangle]
pub unsafe fn stosd_rep() -> () {
    let mut diff: i32 = 0;
    let mut data: i32 = *reg32s.offset(EAX as isize);
    let mut dest: i32 = get_seg(ES) + get_reg_asize(EDI);
    let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
        -4i32
    }
    else {
        4i32
    };
    let mut count: i32 = get_reg_asize(ECX);
    if count == 0i32 {
        return;
    }
    else {
        let mut cont: i32 = 0i32;
        let mut start_count: i32 = count;
        let mut cycle_counter: i32 = MAX_COUNT_PER_CYCLE;
        if 0 == dest & 3i32 {
            let mut single_size: i32 = if size < 0i32 { -1i32 } else { 1i32 };
            let mut phys_dest: i32 =
                (return_on_pagefault!(translate_address_write(dest)) >> 2i32) as i32;
            cycle_counter = string_get_cycle_count(size, dest);
            loop {
                write_aligned32(phys_dest as u32, data);
                phys_dest += single_size;
                count -= 1;
                cont = (count != 0i32) as i32;
                if !(0 != cont && {
                    cycle_counter -= 1;
                    0 != cycle_counter
                }) {
                    break;
                }
            }
            diff = size * (start_count - count);
            add_reg_asize(EDI, diff);
            set_ecx_asize(count);
            *timestamp_counter =
                (*timestamp_counter as u32).wrapping_add((start_count - count) as u32) as u32 as u32
        }
        else {
            loop {
                return_on_pagefault!(safe_write32(dest, data));
                dest += size;
                add_reg_asize(EDI, size);
                cont = (decr_ecx_asize() != 0i32) as i32;
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
pub unsafe fn stosd_no_rep() -> () {
    let mut data: i32 = *reg32s.offset(EAX as isize);
    let mut dest: i32 = get_seg(ES) + get_reg_asize(EDI);
    let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
        -4i32
    }
    else {
        4i32
    };
    return_on_pagefault!(safe_write32(dest, data));
    add_reg_asize(EDI, size);
}
#[no_mangle]
pub unsafe fn lodsb_rep() -> () {
    let mut src: i32 = get_seg_prefix(DS) + get_reg_asize(ESI);
    let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
        -1i32
    }
    else {
        1i32
    };
    let mut count: i32 = get_reg_asize(ECX);
    if count == 0i32 {
        return;
    }
    else {
        let mut cont: i32 = 0i32;
        let mut start_count: i32 = count;
        let mut cycle_counter: i32 = string_get_cycle_count(size, src);
        let mut phys_src: i32 = return_on_pagefault!(translate_address_read(src)) as i32;
        loop {
            *reg8.offset(AL as isize) = read8(phys_src as u32) as u8;
            phys_src += size;
            count -= 1;
            cont = (count != 0i32) as i32;
            if !(0 != cont && {
                cycle_counter -= 1;
                0 != cycle_counter
            }) {
                break;
            }
        }
        let mut diff: i32 = size * (start_count - count);
        add_reg_asize(ESI, diff);
        set_ecx_asize(count);
        *timestamp_counter =
            (*timestamp_counter as u32).wrapping_add((start_count - count) as u32) as u32 as u32;
        if 0 != cont {
            *instruction_pointer = *previous_ip
        }
        return;
    };
}
#[no_mangle]
pub unsafe fn lodsb_no_rep() -> () {
    let mut src: i32 = get_seg_prefix(DS) + get_reg_asize(ESI);
    let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
        -1i32
    }
    else {
        1i32
    };
    *reg8.offset(AL as isize) = return_on_pagefault!(safe_read8(src)) as u8;
    add_reg_asize(ESI, size);
}
#[no_mangle]
pub unsafe fn lodsw_rep() -> () {
    let mut src: i32 = get_seg_prefix(DS) + get_reg_asize(ESI);
    let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
        -2i32
    }
    else {
        2i32
    };
    let mut count: u32 = get_reg_asize(ECX) as u32;
    if count == 0i32 as u32 {
        return;
    }
    else {
        let mut cont: bool = 0 != 0i32;
        let mut cycle_counter: u32 = MAX_COUNT_PER_CYCLE as u32;
        loop {
            *reg16.offset(AX as isize) = return_on_pagefault!(safe_read16(src)) as u16;
            src += size;
            add_reg_asize(ESI, size);
            cont = decr_ecx_asize() != 0i32;
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
pub unsafe fn lodsw_no_rep() -> () {
    let mut src: i32 = get_seg_prefix(DS) + get_reg_asize(ESI);
    let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
        -2i32
    }
    else {
        2i32
    };
    *reg16.offset(AX as isize) = return_on_pagefault!(safe_read16(src)) as u16;
    add_reg_asize(ESI, size);
}
#[no_mangle]
pub unsafe fn lodsd_rep() -> () {
    let mut src: i32 = get_seg_prefix(DS) + get_reg_asize(ESI);
    let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
        -4i32
    }
    else {
        4i32
    };
    let mut count: i32 = get_reg_asize(ECX);
    if count == 0i32 {
        return;
    }
    else {
        let mut cont: i32 = 0i32;
        let mut cycle_counter: i32 = MAX_COUNT_PER_CYCLE;
        loop {
            *reg32s.offset(EAX as isize) = return_on_pagefault!(safe_read32s(src));
            src += size;
            add_reg_asize(ESI, size);
            cont = (decr_ecx_asize() != 0i32) as i32;
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
pub unsafe fn lodsd_no_rep() -> () {
    let mut src: i32 = get_seg_prefix(DS) + get_reg_asize(ESI);
    let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
        -4i32
    }
    else {
        4i32
    };
    *reg32s.offset(EAX as isize) = return_on_pagefault!(safe_read32s(src));
    add_reg_asize(ESI, size);
}
#[no_mangle]
pub unsafe fn scasb_rep(mut prefix_flag: i32) -> () {
    let mut dest: i32 = get_seg(ES) + get_reg_asize(EDI);
    let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
        -1i32
    }
    else {
        1i32
    };
    let mut data_dest: i32 = 0;
    let mut data_src: i32 = *reg8.offset(AL as isize) as i32;
    let mut count: i32 = get_reg_asize(ECX);
    if count == 0i32 {
        return;
    }
    else {
        let mut cont: i32 = 0i32;
        let mut start_count: i32 = count;
        let mut is_repz: i32 = (prefix_flag == PREFIX_REPZ) as i32;
        let mut cycle_counter: i32 = string_get_cycle_count(size, dest);
        let mut phys_dest: i32 = return_on_pagefault!(translate_address_read(dest)) as i32;
        loop {
            data_dest = read8(phys_dest as u32);
            phys_dest += size;
            count -= 1;
            cont = (count != 0i32 && (data_src == data_dest) as i32 == is_repz) as i32;
            if !(0 != cont && {
                cycle_counter -= 1;
                0 != cycle_counter
            }) {
                break;
            }
        }
        let mut diff: i32 = size * (start_count - count);
        add_reg_asize(EDI, diff);
        set_ecx_asize(count);
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
pub unsafe fn scasb_no_rep() -> () {
    let mut dest: i32 = get_seg(ES) + get_reg_asize(EDI);
    let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
        -1i32
    }
    else {
        1i32
    };
    let mut data_dest: i32 = 0;
    let mut data_src: i32 = *reg8.offset(AL as isize) as i32;
    data_dest = return_on_pagefault!(safe_read8(dest));
    add_reg_asize(EDI, size);
    cmp8(data_src, data_dest);
}
#[no_mangle]
pub unsafe fn scasw_rep(mut prefix_flag: i32) -> () {
    let mut diff: i32 = 0;
    let mut dest: i32 = get_seg(ES) + get_reg_asize(EDI);
    let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
        -2i32
    }
    else {
        2i32
    };
    let mut data_dest: i32 = 0;
    let mut data_src: i32 = *reg16.offset(AL as isize) as i32;
    let mut count: i32 = get_reg_asize(ECX);
    if count == 0i32 {
        return;
    }
    else {
        let mut cont: i32 = 0i32;
        let mut start_count: i32 = count;
        let mut is_repz: i32 = (prefix_flag == PREFIX_REPZ) as i32;
        let mut cycle_counter: i32 = MAX_COUNT_PER_CYCLE;
        if 0 == dest & 1i32 {
            let mut single_size: i32 = if size < 0i32 { -1i32 } else { 1i32 };
            let mut phys_dest: i32 =
                (return_on_pagefault!(translate_address_read(dest)) >> 1i32) as i32;
            cycle_counter = string_get_cycle_count(size, dest);
            loop {
                data_dest = read_aligned16(phys_dest as u32);
                phys_dest += single_size;
                count -= 1;
                cont = (count != 0i32 && (data_src == data_dest) as i32 == is_repz) as i32;
                if !(0 != cont && {
                    cycle_counter -= 1;
                    0 != cycle_counter
                }) {
                    break;
                }
            }
            diff = size * (start_count - count);
            add_reg_asize(EDI, diff);
            set_ecx_asize(count);
            *timestamp_counter =
                (*timestamp_counter as u32).wrapping_add((start_count - count) as u32) as u32 as u32
        }
        else {
            loop {
                data_dest = return_on_pagefault!(safe_read16(dest));
                dest += size;
                add_reg_asize(EDI, size);
                cont =
                    (decr_ecx_asize() != 0i32 && (data_src == data_dest) as i32 == is_repz) as i32;
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
pub unsafe fn scasw_no_rep() -> () {
    let mut dest: i32 = get_seg(ES) + get_reg_asize(EDI);
    let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
        -2i32
    }
    else {
        2i32
    };
    let mut data_dest: i32 = 0;
    let mut data_src: i32 = *reg16.offset(AL as isize) as i32;
    data_dest = return_on_pagefault!(safe_read16(dest));
    add_reg_asize(EDI, size);
    cmp16(data_src, data_dest);
}
#[no_mangle]
pub unsafe fn scasd_rep(mut prefix_flag: i32) -> () {
    let mut diff: i32 = 0;
    let mut dest: i32 = get_seg(ES) + get_reg_asize(EDI);
    let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
        -4i32
    }
    else {
        4i32
    };
    let mut data_dest: i32 = 0;
    let mut data_src: i32 = *reg32s.offset(EAX as isize);
    let mut count: i32 = get_reg_asize(ECX);
    if count == 0i32 {
        return;
    }
    else {
        let mut cont: i32 = 0i32;
        let mut start_count: i32 = count;
        let mut is_repz: i32 = (prefix_flag == PREFIX_REPZ) as i32;
        let mut cycle_counter: i32 = MAX_COUNT_PER_CYCLE;
        if 0 == dest & 3i32 {
            let mut single_size: i32 = if size < 0i32 { -1i32 } else { 1i32 };
            let mut phys_dest: i32 =
                (return_on_pagefault!(translate_address_read(dest)) >> 2i32) as i32;
            cycle_counter = string_get_cycle_count(size, dest);
            loop {
                data_dest = read_aligned32(phys_dest as u32);
                phys_dest += single_size;
                count -= 1;
                cont = (count != 0i32 && (data_src == data_dest) as i32 == is_repz) as i32;
                if !(0 != cont && {
                    cycle_counter -= 1;
                    0 != cycle_counter
                }) {
                    break;
                }
            }
            diff = size * (start_count - count);
            add_reg_asize(EDI, diff);
            set_ecx_asize(count);
            *timestamp_counter =
                (*timestamp_counter as u32).wrapping_add((start_count - count) as u32) as u32 as u32
        }
        else {
            loop {
                data_dest = return_on_pagefault!(safe_read32s(dest));
                dest += size;
                add_reg_asize(EDI, size);
                cont =
                    (decr_ecx_asize() != 0i32 && (data_src == data_dest) as i32 == is_repz) as i32;
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
pub unsafe fn scasd_no_rep() -> () {
    let mut dest: i32 = get_seg(ES) + get_reg_asize(EDI);
    let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
        -4i32
    }
    else {
        4i32
    };
    let mut data_dest: i32 = 0;
    let mut data_src: i32 = *reg32s.offset(EAX as isize);
    data_dest = return_on_pagefault!(safe_read32s(dest));
    add_reg_asize(EDI, size);
    cmp32(data_src, data_dest);
}
#[no_mangle]
pub unsafe fn insb_rep() -> () {
    let mut port: i32 = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 1i32) {
        return;
    }
    else {
        let mut dest: i32 = get_seg(ES) + get_reg_asize(EDI);
        let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
            -1i32
        }
        else {
            1i32
        };
        let mut count: i32 = get_reg_asize(ECX);
        if count == 0i32 {
            return;
        }
        else {
            let mut cont: i32 = 0i32;
            let mut start_count: i32 = count;
            let mut cycle_counter: i32 = string_get_cycle_count(size, dest);
            let mut phys_dest: i32 = return_on_pagefault!(translate_address_write(dest)) as i32;
            loop {
                write8(phys_dest as u32, io_port_read8(port));
                phys_dest += size;
                count -= 1;
                cont = (count != 0i32) as i32;
                if !(0 != cont && {
                    cycle_counter -= 1;
                    0 != cycle_counter
                }) {
                    break;
                }
            }
            let mut diff: i32 = size * (start_count - count);
            add_reg_asize(EDI, diff);
            set_ecx_asize(count);
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
pub unsafe fn insb_no_rep() -> () {
    let mut port: i32 = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 1i32) {
        return;
    }
    else {
        let mut dest: i32 = get_seg(ES) + get_reg_asize(EDI);
        let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
            -1i32
        }
        else {
            1i32
        };
        return_on_pagefault!(writable_or_pagefault(dest, 1i32));
        return_on_pagefault!(safe_write8(dest, io_port_read8(port)));
        add_reg_asize(EDI, size);
        return;
    };
}
#[no_mangle]
pub unsafe fn insw_rep() -> () {
    let mut diff: i32 = 0;
    let mut port: i32 = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 2i32) {
        return;
    }
    else {
        let mut dest: i32 = get_seg(ES) + get_reg_asize(EDI);
        let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
            -2i32
        }
        else {
            2i32
        };
        let mut count: i32 = get_reg_asize(ECX);
        if count == 0i32 {
            return;
        }
        else {
            let mut cont: i32 = 0i32;
            let mut start_count: i32 = count;
            let mut cycle_counter: i32 = MAX_COUNT_PER_CYCLE;
            if 0 == dest & 1i32 {
                let mut single_size: i32 = if size < 0i32 { -1i32 } else { 1i32 };
                let mut phys_dest: i32 =
                    (return_on_pagefault!(translate_address_write(dest)) >> 1i32) as i32;
                cycle_counter = string_get_cycle_count(size, dest);
                loop {
                    write_aligned16(phys_dest as u32, io_port_read16(port) as u32);
                    phys_dest += single_size;
                    count -= 1;
                    cont = (count != 0i32) as i32;
                    if !(0 != cont && {
                        cycle_counter -= 1;
                        0 != cycle_counter
                    }) {
                        break;
                    }
                }
                diff = size * (start_count - count);
                add_reg_asize(EDI, diff);
                set_ecx_asize(count);
                *timestamp_counter = (*timestamp_counter as u32)
                    .wrapping_add((start_count - count) as u32)
                    as u32 as u32
            }
            else {
                loop {
                    return_on_pagefault!(writable_or_pagefault(dest, 2i32));
                    return_on_pagefault!(safe_write16(dest, io_port_read16(port)));
                    dest += size;
                    add_reg_asize(EDI, size);
                    cont = (decr_ecx_asize() != 0i32) as i32;
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
pub unsafe fn insw_no_rep() -> () {
    let mut port: i32 = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 2i32) {
        return;
    }
    else {
        let mut dest: i32 = get_seg(ES) + get_reg_asize(EDI);
        let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
            -2i32
        }
        else {
            2i32
        };
        return_on_pagefault!(writable_or_pagefault(dest, 2i32));
        return_on_pagefault!(safe_write16(dest, io_port_read16(port)));
        add_reg_asize(EDI, size);
        return;
    };
}
#[no_mangle]
pub unsafe fn insd_rep() -> () {
    let mut diff: i32 = 0;
    let mut port: i32 = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 4i32) {
        return;
    }
    else {
        let mut dest: i32 = get_seg(ES) + get_reg_asize(EDI);
        let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
            -4i32
        }
        else {
            4i32
        };
        let mut count: i32 = get_reg_asize(ECX);
        if count == 0i32 {
            return;
        }
        else {
            let mut cont: i32 = 0i32;
            let mut start_count: i32 = count;
            let mut cycle_counter: i32 = MAX_COUNT_PER_CYCLE;
            if 0 == dest & 3i32 {
                let mut single_size: i32 = if size < 0i32 { -1i32 } else { 1i32 };
                let mut phys_dest: i32 =
                    (return_on_pagefault!(translate_address_write(dest)) >> 2i32) as i32;
                cycle_counter = string_get_cycle_count(size, dest);
                loop {
                    write_aligned32(phys_dest as u32, io_port_read32(port));
                    phys_dest += single_size;
                    count -= 1;
                    cont = (count != 0i32) as i32;
                    if !(0 != cont && {
                        cycle_counter -= 1;
                        0 != cycle_counter
                    }) {
                        break;
                    }
                }
                diff = size * (start_count - count);
                add_reg_asize(EDI, diff);
                set_ecx_asize(count);
                *timestamp_counter = (*timestamp_counter as u32)
                    .wrapping_add((start_count - count) as u32)
                    as u32 as u32
            }
            else {
                loop {
                    return_on_pagefault!(writable_or_pagefault(dest, 4i32));
                    return_on_pagefault!(safe_write32(dest, io_port_read32(port)));
                    dest += size;
                    add_reg_asize(EDI, size);
                    cont = (decr_ecx_asize() != 0i32) as i32;
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
pub unsafe fn insd_no_rep() -> () {
    let mut port: i32 = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 4i32) {
        return;
    }
    else {
        let mut dest: i32 = get_seg(ES) + get_reg_asize(EDI);
        let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
            -4i32
        }
        else {
            4i32
        };
        return_on_pagefault!(writable_or_pagefault(dest, 4i32));
        return_on_pagefault!(safe_write32(dest, io_port_read32(port)));
        add_reg_asize(EDI, size);
        return;
    };
}
#[no_mangle]
pub unsafe fn outsb_rep() -> () {
    let mut port: i32 = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 1i32) {
        return;
    }
    else {
        let mut src: i32 = get_seg_prefix(DS) + get_reg_asize(ESI);
        let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
            -1i32
        }
        else {
            1i32
        };
        let mut count: i32 = get_reg_asize(ECX);
        if count == 0i32 {
            return;
        }
        else {
            let mut cont: i32 = 0i32;
            let mut start_count: i32 = count;
            let mut cycle_counter: i32 = string_get_cycle_count(size, src);
            let mut phys_src: i32 = return_on_pagefault!(translate_address_read(src)) as i32;
            loop {
                io_port_write8(port, read8(phys_src as u32));
                phys_src += size;
                count -= 1;
                cont = (count != 0i32) as i32;
                if !(0 != cont && {
                    cycle_counter -= 1;
                    0 != cycle_counter
                }) {
                    break;
                }
            }
            let mut diff: i32 = size * (start_count - count);
            add_reg_asize(ESI, diff);
            set_ecx_asize(count);
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
pub unsafe fn outsb_no_rep() -> () {
    let mut port: i32 = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 1i32) {
        return;
    }
    else {
        let mut src: i32 = get_seg_prefix(DS) + get_reg_asize(ESI);
        let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
            -1i32
        }
        else {
            1i32
        };
        io_port_write8(port, return_on_pagefault!(safe_read8(src)));
        add_reg_asize(ESI, size);
        return;
    };
}
#[no_mangle]
pub unsafe fn outsw_rep() -> () {
    let mut diff: i32 = 0;
    let mut port: i32 = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 2i32) {
        return;
    }
    else {
        let mut src: i32 = get_seg_prefix(DS) + get_reg_asize(ESI);
        let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
            -2i32
        }
        else {
            2i32
        };
        let mut count: i32 = get_reg_asize(ECX);
        if count == 0i32 {
            return;
        }
        else {
            let mut cont: i32 = 0i32;
            let mut start_count: i32 = count;
            let mut cycle_counter: i32 = MAX_COUNT_PER_CYCLE;
            if 0 == src & 1i32 {
                let mut single_size: i32 = if size < 0i32 { -1i32 } else { 1i32 };
                let mut phys_src: i32 =
                    (return_on_pagefault!(translate_address_read(src)) >> 1i32) as i32;
                cycle_counter = string_get_cycle_count(size, src);
                loop {
                    io_port_write16(port, read_aligned16(phys_src as u32));
                    phys_src += single_size;
                    count -= 1;
                    cont = (count != 0i32) as i32;
                    if !(0 != cont && {
                        cycle_counter -= 1;
                        0 != cycle_counter
                    }) {
                        break;
                    }
                }
                diff = size * (start_count - count);
                add_reg_asize(ESI, diff);
                set_ecx_asize(count);
                *timestamp_counter = (*timestamp_counter as u32)
                    .wrapping_add((start_count - count) as u32)
                    as u32 as u32
            }
            else {
                loop {
                    io_port_write16(port, return_on_pagefault!(safe_read16(src)));
                    src += size;
                    add_reg_asize(ESI, size);
                    cont = (decr_ecx_asize() != 0i32) as i32;
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
pub unsafe fn outsw_no_rep() -> () {
    let mut port: i32 = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 2i32) {
        return;
    }
    else {
        let mut src: i32 = get_seg_prefix(DS) + get_reg_asize(ESI);
        let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
            -2i32
        }
        else {
            2i32
        };
        io_port_write16(port, return_on_pagefault!(safe_read16(src)));
        add_reg_asize(ESI, size);
        return;
    };
}
#[no_mangle]
pub unsafe fn outsd_rep() -> () {
    let mut diff: i32 = 0;
    let mut port: i32 = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 4i32) {
        return;
    }
    else {
        let mut src: i32 = get_seg_prefix(DS) + get_reg_asize(ESI);
        let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
            -4i32
        }
        else {
            4i32
        };
        let mut count: i32 = get_reg_asize(ECX);
        if count == 0i32 {
            return;
        }
        else {
            let mut cont: i32 = 0i32;
            let mut start_count: i32 = count;
            let mut cycle_counter: i32 = MAX_COUNT_PER_CYCLE;
            if 0 == src & 3i32 {
                let mut single_size: i32 = if size < 0i32 { -1i32 } else { 1i32 };
                let mut phys_src: i32 =
                    (return_on_pagefault!(translate_address_read(src)) >> 2i32) as i32;
                cycle_counter = string_get_cycle_count(size, src);
                loop {
                    io_port_write32(port, read_aligned32(phys_src as u32));
                    phys_src += single_size;
                    count -= 1;
                    cont = (count != 0i32) as i32;
                    if !(0 != cont && {
                        cycle_counter -= 1;
                        0 != cycle_counter
                    }) {
                        break;
                    }
                }
                diff = size * (start_count - count);
                add_reg_asize(ESI, diff);
                set_ecx_asize(count);
                *timestamp_counter = (*timestamp_counter as u32)
                    .wrapping_add((start_count - count) as u32)
                    as u32 as u32
            }
            else {
                loop {
                    io_port_write32(port, return_on_pagefault!(safe_read32s(src)));
                    src += size;
                    add_reg_asize(ESI, size);
                    cont = (decr_ecx_asize() != 0i32) as i32;
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
pub unsafe fn outsd_no_rep() -> () {
    let mut port: i32 = *reg16.offset(DX as isize) as i32;
    if !test_privileges_for_io(port, 4i32) {
        return;
    }
    else {
        let mut src: i32 = get_seg_prefix(DS) + get_reg_asize(ESI);
        let mut size: i32 = if 0 != *flags & FLAG_DIRECTION {
            -4i32
        }
        else {
            4i32
        };
        io_port_write32(port, return_on_pagefault!(safe_read32s(src)));
        add_reg_asize(ESI, size);
        return;
    };
}
