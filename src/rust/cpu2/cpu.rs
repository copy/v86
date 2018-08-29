#![allow(mutable_transmutes, non_upper_case_globals, unused_mut)]

extern "C" {
    #[no_mangle]
    fn call_interrupt_vector(interrupt: i32, is_software: bool, has_error: bool, error: i32);
    #[no_mangle]
    fn cpu_exception_hook(interrupt: i32) -> bool;
    #[no_mangle]
    fn dbg_trace();
    #[no_mangle]
    fn logop(addr: i32, op: i32);
    #[no_mangle]
    fn microtick() -> f64;
    #[no_mangle]
    fn call_indirect1(f: i32, x: u16);
}

use cpu2::global_pointers::*;
pub use cpu2::imports::{mem16, mem32s, mem8};
use cpu2::memory::{
    in_mapped_range, read128, read16, read32s, read64s, read8, read_aligned16, read_aligned32,
    write128, write16, write32, write64, write8, write_aligned32,
};
use cpu2::misc_instr::{getaf, getcf, getof, getpf, getsf, getzf};
use cpu2::modrm::{resolve_modrm16, resolve_modrm32};
use cpu2::profiler::*;
use cpu2::profiler::{profiler_stat_increment, profiler_stat_increment_by};

/// The offset for our generated functions in the wasm table. Every index less than this is
/// reserved for rustc's indirect functions
pub const WASM_TABLE_OFFSET: u32 = 1024;

#[derive(Copy, Clone)]
#[repr(C)]
pub union reg64 {
    pub i8_0: [i8; 8],
    pub i16_0: [i16; 4],
    pub i32_0: [i32; 2],
    pub i64_0: [i64; 1],
    pub u8_0: [u8; 8],
    pub u16_0: [u16; 4],
    pub u32_0: [u32; 2],
    pub u64_0: [u64; 1],
    pub f32_0: [f32; 2],
    pub f64_0: [f64; 1],
}
pub type CachedStateFlags = u8;

#[derive(Copy, Clone)]
#[repr(C)]
pub union reg128 {
    pub i8_0: [i8; 16],
    pub i16_0: [i16; 8],
    pub i32_0: [i32; 4],
    pub i64_0: [i64; 2],
    pub u8_0: [u8; 16],
    pub u16_0: [u16; 8],
    pub u32_0: [u32; 4],
    pub u64_0: [u64; 2],
    pub f32_0: [f32; 4],
    pub f64_0: [f64; 2],
}

pub const FLAG_CARRY: i32 = 1i32;
pub const FLAG_PARITY: i32 = 4i32;
pub const FLAG_ADJUST: i32 = 16i32;
pub const FLAG_ZERO: i32 = 64i32;
pub const FLAG_SIGN: i32 = 128i32;
pub const FLAG_TRAP: i32 = 256i32;
pub const FLAG_INTERRUPT: i32 = 512i32;
pub const FLAG_DIRECTION: i32 = 1024i32;
pub const FLAG_OVERFLOW: i32 = 2048i32;
pub const FLAG_IOPL: i32 = 1i32 << 12i32 | 1i32 << 13i32;
pub const FLAG_NT: i32 = 1i32 << 14i32;
pub const FLAG_RF: i32 = 1i32 << 16i32;
pub const FLAG_VM: i32 = 1i32 << 17i32;
pub const FLAG_AC: i32 = 1i32 << 18i32;
pub const FLAG_VIF: i32 = 1i32 << 19i32;
pub const FLAG_VIP: i32 = 1i32 << 20i32;
pub const FLAG_ID: i32 = 1i32 << 21i32;
pub const FLAGS_DEFAULT: i32 = 1i32 << 1i32;
pub const FLAGS_MASK: i32 = FLAG_CARRY
    | FLAG_PARITY
    | FLAG_ADJUST
    | FLAG_ZERO
    | FLAG_SIGN
    | FLAG_TRAP
    | FLAG_INTERRUPT
    | FLAG_DIRECTION
    | FLAG_OVERFLOW
    | FLAG_IOPL
    | FLAG_NT
    | FLAG_RF
    | FLAG_VM
    | FLAG_AC
    | FLAG_VIF
    | FLAG_VIP
    | FLAG_ID;
pub const FLAGS_ALL: i32 =
    FLAG_CARRY | FLAG_PARITY | FLAG_ADJUST | FLAG_ZERO | FLAG_SIGN | FLAG_OVERFLOW;
pub const OPSIZE_8: i32 = 7i32;
pub const OPSIZE_16: i32 = 15i32;
pub const OPSIZE_32: i32 = 31i32;
pub const EAX: i32 = 0i32;
pub const ECX: i32 = 1i32;
pub const EDX: i32 = 2i32;
pub const EBX: i32 = 3i32;
pub const ESP: i32 = 4i32;
pub const EBP: i32 = 5i32;
pub const ESI: i32 = 6i32;
pub const EDI: i32 = 7i32;
pub const AX: i32 = 0i32;
pub const CX: i32 = 2i32;
pub const DX: i32 = 4i32;
pub const BX: i32 = 6i32;
pub const SP: i32 = 8i32;
pub const BP: i32 = 10i32;
pub const SI: i32 = 12i32;
pub const DI: i32 = 14i32;
pub const AL: i32 = 0i32;
pub const CL: i32 = 4i32;
pub const DL: i32 = 8i32;
pub const BL: i32 = 12i32;
pub const AH: i32 = 1i32;
pub const CH: i32 = 5i32;
pub const DH: i32 = 9i32;
pub const BH: i32 = 13i32;
pub const ES: i32 = 0i32;
pub const CS: i32 = 1i32;
pub const SS: i32 = 2i32;
pub const DS: i32 = 3i32;
pub const FS: i32 = 4i32;
pub const GS: i32 = 5i32;
pub const TR: i32 = 6i32;
pub const LDTR: i32 = 7i32;
pub const PAGE_TABLE_PRESENT_MASK: i32 = 1i32 << 0i32;
pub const PAGE_TABLE_RW_MASK: i32 = 1i32 << 1i32;
pub const PAGE_TABLE_USER_MASK: i32 = 1i32 << 2i32;
pub const PAGE_TABLE_ACCESSED_MASK: i32 = 1i32 << 5i32;
pub const PAGE_TABLE_DIRTY_MASK: i32 = 1i32 << 6i32;
pub const PAGE_TABLE_PSE_MASK: i32 = 1i32 << 7i32;
pub const PAGE_TABLE_GLOBAL_MASK: i32 = 1i32 << 8i32;
pub const MMAP_BLOCK_BITS: i32 = 17i32;
pub const MMAP_BLOCK_SIZE: i32 = 1i32 << MMAP_BLOCK_BITS;
pub const CR0_PE: i32 = 1i32;
pub const CR0_MP: i32 = 1i32 << 1i32;
pub const CR0_EM: i32 = 1i32 << 2i32;
pub const CR0_TS: i32 = 1i32 << 3i32;
pub const CR0_ET: i32 = 1i32 << 4i32;
pub const CR0_WP: i32 = 1i32 << 16i32;
pub const CR0_NW: i32 = 1i32 << 29i32;
pub const CR0_CD: i32 = 1i32 << 30i32;
pub const CR0_PG: i32 = 1i32 << 31i32;
pub const CR4_VME: i32 = 1i32;
pub const CR4_PVI: i32 = 1i32 << 1i32;
pub const CR4_TSD: i32 = 1i32 << 2i32;
pub const CR4_PSE: i32 = 1i32 << 4i32;
pub const CR4_DE: i32 = 1i32 << 3i32;
pub const CR4_PAE: i32 = 1i32 << 5i32;
pub const CR4_PGE: i32 = 1i32 << 7i32;
pub const IA32_SYSENTER_CS: i32 = 372i32;
pub const IA32_SYSENTER_ESP: i32 = 373i32;
pub const IA32_SYSENTER_EIP: i32 = 374i32;
pub const IA32_TIME_STAMP_COUNTER: i32 = 16i32;
pub const IA32_PLATFORM_ID: i32 = 23i32;
pub const IA32_APIC_BASE_MSR: i32 = 27i32;
pub const IA32_BIOS_SIGN_ID: i32 = 139i32;
pub const MSR_PLATFORM_INFO: i32 = 206i32;
pub const MSR_MISC_FEATURE_ENABLES: i32 = 320i32;
pub const IA32_MISC_ENABLE: i32 = 416i32;
pub const IA32_RTIT_CTL: i32 = 1392i32;
pub const MSR_SMI_COUNT: i32 = 52i32;
pub const IA32_MCG_CAP: i32 = 377i32;
pub const IA32_KERNEL_GS_BASE: i32 = 3221225729u32 as i32;
pub const MSR_PKG_C2_RESIDENCY: i32 = 1549i32;
pub const IA32_APIC_BASE_BSP: i32 = 1i32 << 8i32;
pub const IA32_APIC_BASE_EXTD: i32 = 1i32 << 10i32;
pub const IA32_APIC_BASE_EN: i32 = 1i32 << 11i32;
pub const APIC_ADDRESS: i32 = 4276092928u32 as i32;
pub const SEG_PREFIX_NONE: i32 = -1i32;
pub const SEG_PREFIX_ZERO: i32 = 7i32;
pub const PREFIX_MASK_REP: i32 = 24i32;
pub const PREFIX_REPZ: i32 = 8i32;
pub const PREFIX_REPNZ: i32 = 16i32;
pub const PREFIX_MASK_SEGMENT: i32 = 7i32;
pub const PREFIX_MASK_OPSIZE: i32 = 32i32;
pub const PREFIX_MASK_ADDRSIZE: i32 = 64i32;
pub const PREFIX_F2: i32 = PREFIX_REPNZ;
pub const PREFIX_F3: i32 = PREFIX_REPZ;
pub const PREFIX_66: i32 = PREFIX_MASK_OPSIZE;
pub const LOG_CPU: i32 = 2i32;
pub const A20_MASK: i32 = !(1i32 << 20i32);
pub const A20_MASK16: i32 = !(1i32 << 20i32 - 1i32);
pub const A20_MASK32: i32 = !(1i32 << 20i32 - 2i32);
pub const MXCSR_MASK: i32 = 0xffff;
pub const VALID_TLB_ENTRY_MAX: i32 = 10000i32;
pub const TLB_VALID: i32 = 1i32 << 0i32;
pub const TLB_READONLY: i32 = 1i32 << 1i32;
pub const TLB_NO_USER: i32 = 1i32 << 2i32;
pub const TLB_IN_MAPPED_RANGE: i32 = 1i32 << 3i32;
pub const TLB_GLOBAL: i32 = 1i32 << 4i32;
pub const TLB_HAS_CODE: i32 = 1i32 << 5i32;
pub const CPU_EXCEPTION_DE: i32 = 0i32;
pub const CPU_EXCEPTION_DB: i32 = 1i32;
pub const CPU_EXCEPTION_NMI: i32 = 2i32;
pub const CPU_EXCEPTION_BP: i32 = 3i32;
pub const CPU_EXCEPTION_OF: i32 = 4i32;
pub const CPU_EXCEPTION_BR: i32 = 5i32;
pub const CPU_EXCEPTION_UD: i32 = 6i32;
pub const CPU_EXCEPTION_NM: i32 = 7i32;
pub const CPU_EXCEPTION_DF: i32 = 8i32;
pub const CPU_EXCEPTION_TS: i32 = 10i32;
pub const CPU_EXCEPTION_NP: i32 = 11i32;
pub const CPU_EXCEPTION_SS: i32 = 12i32;
pub const CPU_EXCEPTION_GP: i32 = 13i32;
pub const CPU_EXCEPTION_PF: i32 = 14i32;
pub const CPU_EXCEPTION_MF: i32 = 16i32;
pub const CPU_EXCEPTION_AC: i32 = 17i32;
pub const CPU_EXCEPTION_MC: i32 = 18i32;
pub const CPU_EXCEPTION_XM: i32 = 19i32;
pub const CPU_EXCEPTION_VE: i32 = 20i32;
pub const CHECK_TLB_INVARIANTS: bool = false;
pub const DEBUG: bool = cfg!(debug_assertions);
pub const LOOP_COUNTER: i32 = 20011i32;
pub const TSC_RATE: f64 = (50i32 * 1000i32) as f64;

pub static mut jit_block_boundary: bool = 0 != 0i32;

pub static mut must_not_fault: bool = 0 != 0i32;
pub static mut rdtsc_imprecision_offset: u64 = 0i32 as u64;
pub static mut rdtsc_last_value: u64 = 0i32 as u64;
pub static mut tsc_offset: u64 = 0i32 as u64;

pub static mut valid_tlb_entries: [i32; 10000] = [0; 10000];
pub static mut valid_tlb_entries_count: i32 = 0i32;

//pub fn call_indirect1(f: fn(u16), x: u16) { f(x); }

pub unsafe fn after_block_boundary() -> () { jit_block_boundary = 0 != 1i32; }

pub unsafe fn same_page(mut addr1: i32, mut addr2: i32) -> bool {
    return addr1 & !4095i32 == addr2 & !4095i32;
}

#[no_mangle]
pub unsafe fn get_eflags() -> i32 {
    return *flags & !FLAGS_ALL
        | getcf() as i32
        | (getpf() as i32) << 2i32
        | (getaf() as i32) << 4i32
        | (getzf() as i32) << 6i32
        | (getsf() as i32) << 7i32
        | (getof() as i32) << 11i32;
}

pub unsafe fn translate_address_read(mut address: i32) -> Result<u32, ()> {
    let mut base: i32 = (address as u32 >> 12i32) as i32;
    let mut entry: i32 = *tlb_data.offset(base as isize);
    let mut user: bool = *cpl as i32 == 3i32;
    if entry & (TLB_VALID | if 0 != user as i32 { TLB_NO_USER } else { 0i32 }) == TLB_VALID {
        return Ok((entry & !4095i32 ^ address) as u32);
    }
    else {
        return Ok((do_page_translation(address, 0 != 0i32, user)? | address & 4095i32) as u32);
    };
}

pub unsafe fn do_page_translation(
    mut addr: i32,
    mut for_writing: bool,
    mut user: bool,
) -> Result<i32, ()> {
    let mut can_write: bool = 0 != 1i32;
    let mut global;
    let mut allow_user: bool = 0 != 1i32;
    let mut page: i32 = (addr as u32 >> 12i32) as i32;
    let mut high;
    if *cr & CR0_PG == 0i32 {
        // paging disabled
        high = (addr as u32 & 4294963200u32) as i32;
        global = 0 != 0i32
    }
    else {
        let mut page_dir_addr: i32 =
            (*cr.offset(3isize) as u32 >> 2i32).wrapping_add((page >> 10i32) as u32) as i32;
        let mut page_dir_entry: i32 = read_aligned32(page_dir_addr as u32);
        // XXX
        let kernel_write_override: bool = !user && 0 == *cr & CR0_WP;
        if 0 == page_dir_entry & PAGE_TABLE_PRESENT_MASK {
            // to do at this place:
            //
            // - set cr2 = addr (which caused the page fault)
            // - call_interrupt_vector  with id 14, error code 0-7 (requires information if read or write)
            // - prevent execution of the function that triggered this call
            *cr.offset(2isize) = addr;
            trigger_pagefault(for_writing, user, 0 != 0i32);
            return Err(());
        }
        if page_dir_entry & PAGE_TABLE_RW_MASK == 0i32 && !kernel_write_override {
            can_write = 0 != 0i32;
            if for_writing {
                *cr.offset(2isize) = addr;
                trigger_pagefault(for_writing, user, 0 != 1i32);
                return Err(());
            }
        }
        if page_dir_entry & PAGE_TABLE_USER_MASK == 0i32 {
            allow_user = 0 != 0i32;
            if user {
                // Page Fault: page table accessed by non-supervisor
                *cr.offset(2isize) = addr;
                trigger_pagefault(for_writing, user, 0 != 1i32);
                return Err(());
            }
        }
        if 0 != page_dir_entry & PAGE_TABLE_PSE_MASK && 0 != *cr.offset(4isize) & CR4_PSE {
            // size bit is set
            // set the accessed and dirty bits
            write_aligned32(
                page_dir_addr as u32,
                page_dir_entry | PAGE_TABLE_ACCESSED_MASK | if 0 != for_writing as i32 {
                    PAGE_TABLE_DIRTY_MASK
                }
                else {
                    0i32
                },
            );
            high = (page_dir_entry as u32 & 4290772992u32 | (addr & 4190208i32) as u32) as i32;
            global = page_dir_entry & PAGE_TABLE_GLOBAL_MASK == PAGE_TABLE_GLOBAL_MASK
        }
        else {
            let mut page_table_addr: i32 = ((page_dir_entry as u32 & 4294963200u32) >> 2i32)
                .wrapping_add((page & 1023i32) as u32)
                as i32;
            let mut page_table_entry: i32 = read_aligned32(page_table_addr as u32);
            if page_table_entry & PAGE_TABLE_PRESENT_MASK == 0i32 {
                *cr.offset(2isize) = addr;
                trigger_pagefault(for_writing, user, 0 != 0i32);
                return Err(());
            }
            if page_table_entry & PAGE_TABLE_RW_MASK == 0i32 && !kernel_write_override {
                can_write = 0 != 0i32;
                if for_writing {
                    *cr.offset(2isize) = addr;
                    trigger_pagefault(for_writing, user, 0 != 1i32);
                    return Err(());
                }
            }
            if page_table_entry & PAGE_TABLE_USER_MASK == 0i32 {
                allow_user = 0 != 0i32;
                if user {
                    *cr.offset(2isize) = addr;
                    trigger_pagefault(for_writing, user, 0 != 1i32);
                    return Err(());
                }
            }
            // set the accessed and dirty bits
            write_aligned32(
                page_dir_addr as u32,
                page_dir_entry | PAGE_TABLE_ACCESSED_MASK,
            );
            write_aligned32(
                page_table_addr as u32,
                page_table_entry | PAGE_TABLE_ACCESSED_MASK | if 0 != for_writing as i32 {
                    PAGE_TABLE_DIRTY_MASK
                }
                else {
                    0i32
                },
            );
            high = (page_table_entry as u32 & 4294963200u32) as i32;
            global = page_table_entry & PAGE_TABLE_GLOBAL_MASK == PAGE_TABLE_GLOBAL_MASK
        }
    }
    if *tlb_data.offset(page as isize) == 0i32 {
        if valid_tlb_entries_count == VALID_TLB_ENTRY_MAX {
            profiler_stat_increment(S_TLB_FULL);
            clear_tlb();
            // also clear global entries if tlb is almost full after clearing non-global pages
            if valid_tlb_entries_count > VALID_TLB_ENTRY_MAX * 3i32 / 4i32 {
                profiler_stat_increment(S_TLB_GLOBAL_FULL);
                full_clear_tlb();
            }
        }
        dbg_assert!(valid_tlb_entries_count < VALID_TLB_ENTRY_MAX);
        valid_tlb_entries[valid_tlb_entries_count as usize] = page;
        valid_tlb_entries_count += 1;
    // TODO: Check that there are no duplicates in valid_tlb_entries
    // XXX: There will probably be duplicates due to invlpg deleting
    // entries from tlb_data but not from valid_tlb_entries
    }
    else if CHECK_TLB_INVARIANTS {
        let mut found: bool = 0 != 0i32;
        let mut i: i32 = 0i32;
        while i < valid_tlb_entries_count {
            if valid_tlb_entries[i as usize] == page {
                found = 0 != 1i32;
                break;
            }
            else {
                i += 1
            }
        }
        dbg_assert!(found);
    }
    let mut is_in_mapped_range: bool = in_mapped_range(high as u32);
    let mut physical_page: i32 = (high as u32 >> 12i32) as i32;
    let mut has_code: bool =
        !is_in_mapped_range && 0 != ::c_api::jit_page_has_code(physical_page as u32) as i32;
    let mut info_bits: i32 = TLB_VALID
        | if 0 != can_write as i32 {
            0i32
        }
        else {
            TLB_READONLY
        }
        | if 0 != allow_user as i32 {
            0i32
        }
        else {
            TLB_NO_USER
        }
        | if 0 != is_in_mapped_range as i32 {
            TLB_IN_MAPPED_RANGE
        }
        else {
            0i32
        }
        | if 0 != global as i32 && 0 != *cr.offset(4isize) & CR4_PGE {
            TLB_GLOBAL
        }
        else {
            0i32
        }
        | if 0 != has_code as i32 {
            TLB_HAS_CODE
        }
        else {
            0i32
        };
    dbg_assert!((high ^ page << 12i32) & 4095i32 == 0i32);
    *tlb_data.offset(page as isize) = high ^ page << 12i32 | info_bits;
    return Ok(high);
}

#[no_mangle]
pub unsafe fn full_clear_tlb() -> () {
    profiler_stat_increment(S_FULL_CLEAR_TLB);
    // clear tlb including global pages
    *last_virt_eip = -1i32;
    *last_virt_esp = -1i32;
    let mut i: i32 = 0i32;
    while i < valid_tlb_entries_count {
        let mut page: i32 = valid_tlb_entries[i as usize];
        *tlb_data.offset(page as isize) = 0i32;
        i += 1
    }
    valid_tlb_entries_count = 0i32;
    if CHECK_TLB_INVARIANTS {
        let mut i_0: i32 = 0i32;
        while i_0 < 1048576i32 {
            dbg_assert!(*tlb_data.offset(i_0 as isize) == 0i32);
            i_0 += 1
        }
    };
}

#[no_mangle]
pub unsafe fn clear_tlb() -> () {
    profiler_stat_increment(S_CLEAR_TLB);
    // clear tlb excluding global pages
    *last_virt_eip = -1i32;
    *last_virt_esp = -1i32;
    let mut global_page_offset: i32 = 0i32;
    let mut i: i32 = 0i32;
    while i < valid_tlb_entries_count {
        let mut page: i32 = valid_tlb_entries[i as usize];
        let mut entry: i32 = *tlb_data.offset(page as isize);
        if 0 != entry & TLB_GLOBAL {
            // reinsert at the front
            valid_tlb_entries[global_page_offset as usize] = page;
            global_page_offset += 1;
        }
        else {
            *tlb_data.offset(page as isize) = 0i32
        }
        i += 1
    }
    valid_tlb_entries_count = global_page_offset;
    if CHECK_TLB_INVARIANTS {
        let mut i_0: i32 = 0i32;
        while i_0 < 1048576i32 {
            dbg_assert!(
                *tlb_data.offset(i_0 as isize) == 0i32
                    || 0 != *tlb_data.offset(i_0 as isize) & TLB_GLOBAL
            );
            i_0 += 1
        }
    };
}

pub unsafe fn trigger_pagefault(mut write: bool, mut user: bool, mut present: bool) -> () {
    if 0 != 0i32 * 0i32 {
        dbg_log!(
            "page fault w={} u={} p={} eip={:x} cr2={:x}",
            write as i32,
            user as i32,
            present as i32,
            *previous_ip,
            *cr.offset(2isize)
        );
        dbg_trace();
    }
    if DEBUG {
        if must_not_fault {
            dbg_log!("Unexpected page fault");
            dbg_trace();
            dbg_assert!(0 != 0i32);
        }
    }
    //if *page_fault {
    //    dbg_log!(("double fault"));
    //    dbg_trace();
    //    dbg_assert!(0 != 0i32);
    //}
    // invalidate tlb entry
    let mut page: i32 = (*cr.offset(2isize) as u32 >> 12i32) as i32;
    *tlb_data.offset(page as isize) = 0i32;
    *instruction_pointer = *previous_ip;
    //*page_fault = 0 != 1i32;
    call_interrupt_vector(
        CPU_EXCEPTION_PF,
        0 != 0i32,
        0 != 1i32,
        (user as i32) << 2i32 | (write as i32) << 1i32 | present as i32,
    );
    //profiler_stat_increment(S_TRIGGER_CPU_EXCEPTION);
}

pub unsafe fn translate_address_write(mut address: i32) -> Result<u32, ()> {
    let mut base: i32 = (address as u32 >> 12i32) as i32;
    let mut entry: i32 = *tlb_data.offset(base as isize);
    let mut user: bool = *cpl as i32 == 3i32;
    if entry & (TLB_VALID | if 0 != user as i32 { TLB_NO_USER } else { 0i32 } | TLB_READONLY)
        == TLB_VALID
    {
        return Ok((entry & !4095i32 ^ address) as u32);
    }
    else {
        return Ok((do_page_translation(address, 0 != 1i32, user)? | address & 4095i32) as u32);
    };
}

#[no_mangle]
pub unsafe fn tlb_set_has_code(mut physical_page: u32, mut has_code: bool) -> () {
    dbg_assert!(physical_page < (1i32 << 20i32) as u32);
    let mut i: i32 = 0i32;
    while i < valid_tlb_entries_count {
        let mut page: i32 = valid_tlb_entries[i as usize];
        let mut entry: i32 = *tlb_data.offset(page as isize);
        if 0 != entry {
            let mut tlb_physical_page: u32 = entry as u32 >> 12i32 ^ page as u32;
            if physical_page == tlb_physical_page {
                *tlb_data.offset(page as isize) = if 0 != has_code as i32 {
                    entry | TLB_HAS_CODE
                }
                else {
                    entry & !TLB_HAS_CODE
                }
            }
        }
        i += 1
    }
    check_tlb_invariants();
}

#[no_mangle]
pub unsafe fn check_tlb_invariants() -> () {
    if !CHECK_TLB_INVARIANTS {
        return;
    }
    else {
        let mut i: i32 = 0i32;
        while i < valid_tlb_entries_count {
            let mut page: i32 = valid_tlb_entries[i as usize];
            let mut entry: i32 = *tlb_data.offset(page as isize);
            if 0 == entry || 0 != entry & TLB_IN_MAPPED_RANGE {
                // there's no code in mapped memory
            }
            i += 1
        }
        return;
    };
}

pub unsafe fn writable_or_pagefault(mut addr: i32, mut size: i32) -> Result<(), ()> {
    dbg_assert!(size < 4096i32);
    dbg_assert!(size > 0i32);
    if *cr & CR0_PG == 0i32 {
        return Ok(());
    }
    else {
        let mut user: bool = *cpl as i32 == 3i32;
        let mut mask: i32 =
            TLB_READONLY | TLB_VALID | if 0 != user as i32 { TLB_NO_USER } else { 0i32 };
        let mut expect: i32 = TLB_VALID;
        let mut page: i32 = (addr as u32 >> 12i32) as i32;
        if *tlb_data.offset(page as isize) & mask != expect {
            do_page_translation(addr, 0 != 1i32, user)?;
        }
        let mut next_page: i32 = ((addr + size - 1i32) as u32 >> 12i32) as i32;
        if page != next_page {
            dbg_assert!(next_page == page + 1i32);
            // XXX: possibly out of bounds
            if *tlb_data.offset(next_page as isize) & mask != expect {
                do_page_translation(next_page << 12i32, 0 != 1i32, user)?;
            }
        }
        return Ok(());
    };
}

pub unsafe fn read_imm8() -> Result<i32, ()> {
    let mut eip: i32 = *instruction_pointer;
    if 0 != eip & !4095i32 ^ *last_virt_eip {
        *eip_phys = (translate_address_read(eip)? ^ eip as u32) as i32;
        *last_virt_eip = eip & !4095i32
    }
    dbg_assert!(!in_mapped_range((*eip_phys ^ eip) as u32));
    let mut data8: i32 = *mem8.offset((*eip_phys ^ eip) as isize) as i32;
    *instruction_pointer = eip + 1i32;
    return Ok(data8);
}

pub unsafe fn read_imm8s() -> Result<i32, ()> { return Ok(read_imm8()? << 24i32 >> 24i32); }

pub unsafe fn read_imm16() -> Result<i32, ()> {
    // Two checks in one comparison:
    // 1. Did the high 20 bits of eip change
    // or 2. Are the low 12 bits of eip 0xFFF (and this read crosses a page boundary)
    if (*instruction_pointer ^ *last_virt_eip) as u32 > 4094i32 as u32 {
        return Ok(read_imm8()? | read_imm8()? << 8i32);
    }
    else {
        let mut data16: i32 = read16((*eip_phys ^ *instruction_pointer) as u32);
        *instruction_pointer = *instruction_pointer + 2i32;
        return Ok(data16);
    };
}

pub unsafe fn read_imm32s() -> Result<i32, ()> {
    // Analogue to the above comment
    if (*instruction_pointer ^ *last_virt_eip) as u32 > 4092i32 as u32 {
        return Ok(read_imm16()? | read_imm16()? << 16i32);
    }
    else {
        let mut data32: i32 = read32s((*eip_phys ^ *instruction_pointer) as u32);
        *instruction_pointer = *instruction_pointer + 4i32;
        return Ok(data32);
    };
}

pub unsafe fn is_osize_32() -> bool {
    return *is_32 as i32 != (*prefixes as i32 & PREFIX_MASK_OPSIZE == PREFIX_MASK_OPSIZE) as i32;
}

pub unsafe fn is_asize_32() -> bool {
    return *is_32 as i32
        != (*prefixes as i32 & PREFIX_MASK_ADDRSIZE == PREFIX_MASK_ADDRSIZE) as i32;
}

#[no_mangle]
pub unsafe fn get_seg(mut segment: i32) -> i32 {
    dbg_assert!(segment >= 0i32 && segment < 8i32);
    // TODO: Remove protected_mode check
    if *protected_mode {
        if *segment_is_null.offset(segment as isize) {
            dbg_assert!(segment != CS && segment != SS);
            dbg_log!("#gp: Access null segment");
            assert!(false);
            trigger_gp(0i32);
        }
    }
    return *segment_offsets.offset(segment as isize);
}

pub unsafe fn trigger_gp(mut code: i32) -> () {
    *instruction_pointer = *previous_ip;
    raise_exception_with_code(CPU_EXCEPTION_GP, code);
}

pub unsafe fn raise_exception_with_code(mut interrupt_nr: i32, mut error_code: i32) -> () {
    if DEBUG {
        if must_not_fault {
            dbg_log!(
                "Unexpected fault: 0x{:x} with code 0x{:x}",
                interrupt_nr,
                error_code
            );
            dbg_trace();
            dbg_assert!(0 != 0i32);
        }
        if cpu_exception_hook(interrupt_nr) {
            assert!(false);
            return;
        }
    }
    profiler_stat_increment(S_TRIGGER_CPU_EXCEPTION);
    call_interrupt_vector(interrupt_nr, 0 != 0i32, 0 != 1i32, error_code);
    assert!(false);
}

pub unsafe fn get_seg_cs() -> i32 { return *segment_offsets.offset(CS as isize); }

pub unsafe fn get_seg_ss() -> i32 { return *segment_offsets.offset(SS as isize); }

pub unsafe fn get_seg_prefix(mut default_segment: i32) -> i32 {
    let mut prefix: i32 = *prefixes as i32 & PREFIX_MASK_SEGMENT;
    if 0 != prefix {
        if prefix == SEG_PREFIX_ZERO {
            return 0i32;
        }
        else {
            return get_seg(prefix - 1i32);
        }
    }
    else {
        return get_seg(default_segment);
    };
}

pub unsafe fn get_seg_prefix_ds(mut offset: i32) -> i32 { return get_seg_prefix(DS) + offset; }

pub unsafe fn get_seg_prefix_ss(mut offset: i32) -> i32 { return get_seg_prefix(SS) + offset; }

pub unsafe fn get_seg_prefix_cs(mut offset: i32) -> i32 { return get_seg_prefix(CS) + offset; }

pub unsafe fn modrm_resolve(mut modrm_byte: i32) -> Result<i32, ()> {
    if is_asize_32() {
        resolve_modrm32(modrm_byte)
    }
    else {
        resolve_modrm16(modrm_byte)
    }
}

pub unsafe fn run_instruction(opcode: i32) { ::gen::interpreter::run(opcode as u32) }
pub unsafe fn run_instruction0f_16(opcode: i32) { ::gen::interpreter0f_16::run(opcode as u8) }
pub unsafe fn run_instruction0f_32(opcode: i32) { ::gen::interpreter0f_32::run(opcode as u8) }

#[no_mangle]
pub unsafe fn cycle_internal() -> () {
    profiler_stat_increment(S_CYCLE_INTERNAL);
    if true {
        *previous_ip = *instruction_pointer;
        let mut phys_addr: u32 = return_on_pagefault!(get_phys_eip()) as u32;
        let mut state_flags: CachedStateFlags = pack_current_state_flags();
        let mut entry: u32 = ::c_api::jit_find_cache_entry(phys_addr, state_flags as u32);
        if 0 != entry {
            profiler_stat_increment(S_RUN_FROM_CACHE);
            let initial_tsc = *timestamp_counter as i32;
            let wasm_table_index = (entry & 65535i32 as u32) as u16;
            let initial_state = (entry >> 16i32) as u16;
            call_indirect1(
                (wasm_table_index as u32).wrapping_add(WASM_TABLE_OFFSET as u32) as i32,
                initial_state,
            );
            profiler_stat_increment_by(
                S_RUN_FROM_CACHE_STEPS,
                (*timestamp_counter).wrapping_sub(initial_tsc as u32) as i32,
            );
        }
        else {
            if DEBUG {
                dbg_assert!(!must_not_fault);
                must_not_fault = 0 != 1i32
            }
            ::c_api::jit_increase_hotness_and_maybe_compile(
                phys_addr,
                get_seg_cs() as u32,
                state_flags as u32,
            );
            if DEBUG {
                dbg_assert!(must_not_fault);
                must_not_fault = 0 != 0i32
            }
            let mut initial_tsc_0: i32 = *timestamp_counter as i32;
            jit_run_interpreted(phys_addr as i32);
            profiler_stat_increment_by(
                S_RUN_INTERPRETED_STEPS,
                (*timestamp_counter).wrapping_sub(initial_tsc_0 as u32) as i32,
            );
        };
    }
    else {
        *previous_ip = *instruction_pointer;
        *timestamp_counter += 1;
        let opcode = return_on_pagefault!(read_imm8());
        run_instruction(opcode | (*is_32 as i32) << 8);
    }
}

pub unsafe fn get_phys_eip() -> Result<i32, ()> {
    let mut eip: i32 = *instruction_pointer;
    if 0 != eip & !4095i32 ^ *last_virt_eip {
        *eip_phys = (translate_address_read(eip)? ^ eip as u32) as i32;
        *last_virt_eip = eip & !4095i32
    }
    let mut phys_addr: u32 = (*eip_phys ^ eip) as u32;
    dbg_assert!(!in_mapped_range(phys_addr));
    return Ok(phys_addr as i32);
}
unsafe fn jit_run_interpreted(mut phys_addr: i32) -> () {
    profiler_stat_increment(S_RUN_INTERPRETED);
    jit_block_boundary = 0 != 0i32;
    dbg_assert!(!in_mapped_range(phys_addr as u32));
    let mut opcode: i32 = *mem8.offset(phys_addr as isize) as i32;
    *instruction_pointer += 1;
    *timestamp_counter = (*timestamp_counter).wrapping_add(1);
    run_instruction(opcode | (*is_32 as i32) << 8i32);
    while !jit_block_boundary && 0 != same_page(*previous_ip, *instruction_pointer) as i32 {
        *previous_ip = *instruction_pointer;
        *timestamp_counter = (*timestamp_counter).wrapping_add(1);
        let mut opcode_0: i32 = return_on_pagefault!(read_imm8());
        if DEBUG {
            logop(*previous_ip, opcode_0);
        }
        run_instruction(opcode_0 | (*is_32 as i32) << 8i32);
    }
}

#[no_mangle]
pub unsafe fn pack_current_state_flags() -> CachedStateFlags {
    return ((*is_32 as i32) << 0i32
        | (*stack_size_32 as i32) << 1i32
        | ((*cpl as i32 == 3i32) as i32) << 2i32
        | (has_flat_segmentation() as i32) << 3i32) as CachedStateFlags;
}

pub unsafe fn has_flat_segmentation() -> bool {
    // ss can't be null
    return *segment_offsets.offset(SS as isize) == 0i32
        && !*segment_is_null.offset(DS as isize)
        && *segment_offsets.offset(DS as isize) == 0i32;
}

pub unsafe fn run_prefix_instruction() -> () {
    run_instruction(return_on_pagefault!(read_imm8()) | (is_osize_32() as i32) << 8i32);
}

pub unsafe fn clear_prefixes() -> () { *prefixes = 0i32 as u8; }

pub unsafe fn segment_prefix_op(mut seg: i32) -> () {
    dbg_assert!(seg <= 5i32);
    *prefixes = (*prefixes as i32 | seg + 1i32) as u8;
    run_prefix_instruction();
    *prefixes = 0i32 as u8;
}

#[no_mangle]
pub unsafe fn do_many_cycles_native() -> () {
    profiler_stat_increment(S_DO_MANY_CYCLES);
    let mut initial_timestamp_counter: u32 = *timestamp_counter;
    while (*timestamp_counter).wrapping_sub(initial_timestamp_counter) < LOOP_COUNTER as u32
        && !*in_hlt
    {
        cycle_internal();
    }
}
//#[no_mangle]
//pub unsafe fn raise_exception(mut interrupt_nr: i32) -> () {
//    if DEBUG {
//        if must_not_fault {
//            dbg_log!("Unexpected fault: 0x{:x}", interrupt_nr);
//            dbg_trace();
//            dbg_assert!(0 != 0i32);
//        }
//        if cpu_exception_hook(interrupt_nr) {
//            throw_cpu_exception();
//            return;
//        }
//    }
//    profiler_stat_increment(S_TRIGGER_CPU_EXCEPTION);
//    call_interrupt_vector(interrupt_nr, 0 != 0i32, 0 != 0i32, 0i32);
//    throw_cpu_exception();
//}

pub unsafe fn trigger_de() -> () {
    if DEBUG {
        if cpu_exception_hook(CPU_EXCEPTION_DE) {
            return;
        }
    }
    *instruction_pointer = *previous_ip;
    call_interrupt_vector(CPU_EXCEPTION_DE, 0 != 0i32, 0 != 0i32, 0i32);
}

#[no_mangle]
pub unsafe fn trigger_ud() -> () {
    dbg_log!("#ud");
    dbg_trace();
    if DEBUG {
        if cpu_exception_hook(CPU_EXCEPTION_UD) {
            return;
        }
    }
    *instruction_pointer = *previous_ip;
    call_interrupt_vector(CPU_EXCEPTION_UD, 0 != 0i32, 0 != 0i32, 0i32);
}

pub unsafe fn trigger_nm() -> () {
    if DEBUG {
        if cpu_exception_hook(CPU_EXCEPTION_NM) {
            return;
        }
    }
    *instruction_pointer = *previous_ip;
    call_interrupt_vector(CPU_EXCEPTION_NM, 0 != 0i32, 0 != 0i32, 0i32);
}

#[no_mangle]
pub unsafe fn trigger_gp_non_raising(mut code: i32) -> () {
    if DEBUG {
        if cpu_exception_hook(CPU_EXCEPTION_GP) {
            return;
        }
    }
    *instruction_pointer = *previous_ip;
    call_interrupt_vector(CPU_EXCEPTION_GP, 0 != 0i32, 0 != 1i32, code);
}

pub unsafe fn virt_boundary_read16(mut low: i32, mut high: i32) -> i32 {
    dbg_assert!(low & 4095i32 == 4095i32);
    dbg_assert!(high & 4095i32 == 0i32);
    return read8(low as u32) | read8(high as u32) << 8i32;
}

pub unsafe fn virt_boundary_read32s(mut low: i32, mut high: i32) -> i32 {
    dbg_assert!(low & 4095i32 >= 4093i32);
    dbg_assert!(high - 3i32 & 4095i32 == low & 4095i32);
    let mut mid;
    if 0 != low & 1i32 {
        if 0 != low & 2i32 {
            // 0xFFF
            mid = read_aligned16((high - 2i32 >> 1i32) as u32)
        }
        else {
            // 0xFFD
            mid = read_aligned16((low + 1i32 >> 1i32) as u32)
        }
    }
    else {
        // 0xFFE
        mid = virt_boundary_read16(low + 1i32, high - 1i32)
    }
    return read8(low as u32) | mid << 8i32 | read8(high as u32) << 24i32;
}

pub unsafe fn virt_boundary_write16(mut low: i32, mut high: i32, mut value: i32) -> () {
    dbg_assert!(low & 4095i32 == 4095i32);
    dbg_assert!(high & 4095i32 == 0i32);
    write8(low as u32, value);
    write8(high as u32, value >> 8i32);
}

pub unsafe fn virt_boundary_write32(mut low: i32, mut high: i32, mut value: i32) -> () {
    dbg_assert!(low & 4095i32 >= 4093i32);
    dbg_assert!(high - 3i32 & 4095i32 == low & 4095i32);
    write8(low as u32, value);
    if 0 != low & 1i32 {
        if 0 != low & 2i32 {
            // 0xFFF
            write8((high - 2i32) as u32, value >> 8i32);
            write8((high - 1i32) as u32, value >> 16i32);
        }
        else {
            // 0xFFD
            write8((low + 1i32) as u32, value >> 8i32);
            write8((low + 2i32) as u32, value >> 16i32);
        }
    }
    else {
        // 0xFFE
        write8((low + 1i32) as u32, value >> 8i32);
        write8((high - 1i32) as u32, value >> 16i32);
    }
    write8(high as u32, value >> 24i32);
}

pub unsafe fn safe_read8(mut addr: i32) -> Result<i32, ()> {
    return Ok(read8(translate_address_read(addr)?));
}

pub unsafe fn safe_read16(mut address: i32) -> Result<i32, ()> {
    let mut base: i32 = (address as u32 >> 12i32) as i32;
    let mut entry: i32 = *tlb_data.offset(base as isize);
    let mut info_bits: i32 = entry & 4095i32 & !TLB_READONLY & !TLB_GLOBAL & !TLB_HAS_CODE;
    if info_bits == TLB_VALID && address & 4095i32 <= 4096i32 - 2i32 {
        // - not in memory mapped area
        // - can be accessed from any cpl
        let mut phys_address: u32 = (entry & !4095i32 ^ address) as u32;
        dbg_assert!(!in_mapped_range(phys_address));
        return Ok(*(mem8.offset(phys_address as isize) as *mut u16) as i32);
    }
    else {
        return Ok(safe_read16_slow(address)?);
    };
}

pub unsafe fn safe_read16_slow(mut addr: i32) -> Result<i32, ()> {
    if addr & 4095i32 == 4095i32 {
        return Ok(safe_read8(addr)? | safe_read8(addr + 1i32)? << 8i32);
    }
    else {
        return Ok(read16(translate_address_read(addr)?));
    };
}

pub unsafe fn safe_read32s(mut address: i32) -> Result<i32, ()> {
    let mut base: i32 = (address as u32 >> 12i32) as i32;
    let mut entry: i32 = *tlb_data.offset(base as isize);
    let mut info_bits: i32 = entry & 4095i32 & !TLB_READONLY & !TLB_GLOBAL & !TLB_HAS_CODE;
    if info_bits == TLB_VALID && address & 4095i32 <= 4096i32 - 4i32 {
        if false {
            profiler_stat_increment(S_SAFE_READ32_FAST);
        }
        // - not in memory mapped area
        // - can be accessed from any cpl
        let mut phys_address: u32 = (entry & !4095i32 ^ address) as u32;
        dbg_assert!(!in_mapped_range(phys_address));
        return Ok(*(mem8.offset(phys_address as isize) as *mut i32));
    }
    else {
        if false {
            if address & 4095i32 > 4096i32 - 4i32 {
                profiler_stat_increment(S_SAFE_READ32_SLOW_PAGE_CROSSED);
            }
            else if info_bits & TLB_VALID == 0i32 {
                profiler_stat_increment(S_SAFE_READ32_SLOW_NOT_VALID);
            }
            else if 0 != info_bits & TLB_NO_USER {
                profiler_stat_increment(S_SAFE_READ32_SLOW_NOT_USER);
            }
            else if 0 != info_bits & TLB_IN_MAPPED_RANGE {
                profiler_stat_increment(S_SAFE_READ32_SLOW_IN_MAPPED_RANGE);
            }
            else {
                dbg_assert!(0 != 0i32);
            }
        }
        return safe_read32s_slow(address);
    };
}

pub unsafe fn safe_read32s_slow(mut addr: i32) -> Result<i32, ()> {
    if addr & 4095i32 >= 4093i32 {
        return Ok(safe_read16(addr)? | safe_read16(addr + 2i32)? << 16i32);
    }
    else {
        return Ok(read32s(translate_address_read(addr)?));
    };
}

#[no_mangle]
pub unsafe fn safe_read8_slow_jit(addr: i32) -> i32 {
    match safe_read8(addr) {
        Ok(v) => {
            *page_fault = false;
            v
        },
        Err(()) => {
            *page_fault = true;
            -1
        },
    }
}

#[no_mangle]
pub unsafe fn safe_read16_slow_jit(addr: i32) -> i32 {
    match safe_read16_slow(addr) {
        Ok(v) => {
            *page_fault = false;
            v
        },
        Err(()) => {
            *page_fault = true;
            -1
        },
    }
}

#[no_mangle]
pub unsafe fn safe_read32s_slow_jit(addr: i32) -> i32 {
    match safe_read32s_slow(addr) {
        Ok(v) => {
            *page_fault = false;
            v
        },
        Err(()) => {
            *page_fault = true;
            -1
        },
    }
}

pub unsafe fn safe_read64s(mut addr: i32) -> Result<reg64, ()> {
    let mut x: reg64 = reg64 { i8_0: [0; 8] };
    if addr & 4095i32 > 4096i32 - 8i32 {
        x.u32_0[0usize] = safe_read32s(addr)? as u32;
        x.u32_0[1usize] = safe_read32s(addr + 4i32)? as u32
    }
    else {
        let addr_phys = translate_address_read(addr)? as i32;
        x.u64_0[0usize] = read64s(addr_phys as u32) as u64
    }
    Ok(x)
}

pub unsafe fn safe_read128s(mut addr: i32) -> Result<reg128, ()> {
    let mut x: reg128 = reg128 { i8_0: [0; 16] };
    if addr & 4095i32 > 4096i32 - 16i32 {
        x.u64_0[0usize] = safe_read64s(addr)?.u64_0[0usize];
        x.u64_0[1usize] = safe_read64s(addr + 8i32)?.u64_0[0usize]
    }
    else {
        let addr_phys = translate_address_read(addr)? as i32;
        x = read128(addr_phys as u32)
    }
    Ok(x)
}

pub unsafe fn safe_write8(mut addr: i32, mut value: i32) -> Result<(), ()> {
    write8(translate_address_write(addr)?, value);
    Ok(())
}

pub unsafe fn safe_write16(mut address: i32, mut value: i32) -> Result<(), ()> {
    let mut base: i32 = (address as u32 >> 12i32) as i32;
    let mut entry: i32 = *tlb_data.offset(base as isize);
    let mut info_bits: i32 = entry & 4095i32 & !TLB_GLOBAL;
    if info_bits == TLB_VALID && address & 4095i32 <= 4096i32 - 2i32 {
        // - allowed to write in user-mode
        // - not in memory mapped area
        // - can be accessed from any cpl
        // - does not contain code
        let mut phys_address: u32 = (entry & !4095i32 ^ address) as u32;
        dbg_assert!(!::c_api::jit_page_has_code(phys_address >> 12i32));
        dbg_assert!(!in_mapped_range(phys_address));
        *(mem8.offset(phys_address as isize) as *mut u16) = value as u16;
    }
    else {
        safe_write16_slow(address, value)?;
    };
    Ok(())
}

pub unsafe fn safe_write16_slow(mut addr: i32, mut value: i32) -> Result<(), ()> {
    let mut phys_low: i32 = translate_address_write(addr)? as i32;
    if addr & 4095i32 == 4095i32 {
        virt_boundary_write16(
            phys_low,
            translate_address_write(addr + 1i32)? as i32,
            value,
        );
    }
    else {
        write16(phys_low as u32, value);
    };
    Ok(())
}

pub unsafe fn safe_write32(mut address: i32, mut value: i32) -> Result<(), ()> {
    let mut base: i32 = (address as u32 >> 12i32) as i32;
    let mut entry: i32 = *tlb_data.offset(base as isize);
    let mut info_bits: i32 = entry & 4095i32 & !TLB_GLOBAL & !if *cpl as i32 == 3i32 {
        0i32
    }
    else {
        TLB_NO_USER
    };
    if info_bits == TLB_VALID && address & 4095i32 <= 4096i32 - 4i32 {
        if false {
            profiler_stat_increment(S_SAFE_WRITE32_FAST);
        }
        // - allowed to write in user-mode
        // - not in memory mapped area
        // - does not contain code
        let mut phys_address: u32 = (entry & !4095i32 ^ address) as u32;
        dbg_assert!(!::c_api::jit_page_has_code(phys_address >> 12i32));
        dbg_assert!(!in_mapped_range(phys_address));
        *(mem8.offset(phys_address as isize) as *mut i32) = value;
    }
    else {
        if false {
            if address & 4095i32 > 4096i32 - 4i32 {
                profiler_stat_increment(S_SAFE_WRITE32_SLOW_PAGE_CROSSED);
            }
            else if info_bits & TLB_VALID == 0i32 {
                profiler_stat_increment(S_SAFE_WRITE32_SLOW_NOT_VALID);
            }
            else if 0 != info_bits & TLB_NO_USER {
                profiler_stat_increment(S_SAFE_WRITE32_SLOW_NOT_USER);
            }
            else if 0 != info_bits & TLB_IN_MAPPED_RANGE {
                profiler_stat_increment(S_SAFE_WRITE32_SLOW_IN_MAPPED_RANGE);
            }
            else if 0 != info_bits & TLB_READONLY {
                profiler_stat_increment(S_SAFE_WRITE32_SLOW_READ_ONLY);
            }
            else if 0 != info_bits & TLB_HAS_CODE {
                profiler_stat_increment(S_SAFE_WRITE32_SLOW_HAS_CODE);
            }
            else {
                dbg_assert!(0 != 0i32);
            }
        }
        safe_write32_slow(address, value)?;
    };
    Ok(())
}

pub unsafe fn safe_write32_slow(mut addr: i32, mut value: i32) -> Result<(), ()> {
    let mut phys_low: i32 = translate_address_write(addr)? as i32;
    if addr & 4095i32 > 4096i32 - 4i32 {
        virt_boundary_write32(
            phys_low,
            (translate_address_write(addr + 3i32 & !3i32)? | (addr + 3i32 & 3i32) as u32) as i32,
            value,
        );
    }
    else {
        write32(phys_low as u32, value);
    };
    Ok(())
}

#[no_mangle]
pub unsafe fn safe_write8_slow_jit(addr: i32, value: i32) {
    match safe_write8(addr, value) {
        Ok(()) => *page_fault = false,
        Err(()) => *page_fault = true,
    }
}

#[no_mangle]
pub unsafe fn safe_write16_slow_jit(addr: i32, value: i32) {
    match safe_write16_slow(addr, value) {
        Ok(()) => *page_fault = false,
        Err(()) => *page_fault = true,
    }
}

#[no_mangle]
pub unsafe fn safe_write32_slow_jit(addr: i32, value: i32) {
    match safe_write32_slow(addr, value) {
        Ok(()) => *page_fault = false,
        Err(()) => *page_fault = true,
    }
}

pub unsafe fn safe_write64(mut addr: i32, mut value: i64) -> Result<(), ()> {
    if addr & 4095i32 > 4096i32 - 8i32 {
        writable_or_pagefault(addr, 8i32)?;
        safe_write32(addr, value as i32).unwrap();
        safe_write32(addr + 4i32, (value >> 32i32) as i32).unwrap();
    }
    else {
        let mut phys: i32 = translate_address_write(addr)? as i32;
        write64(phys as u32, value);
    };
    Ok(())
}

pub unsafe fn safe_write128(mut addr: i32, mut value: reg128) -> Result<(), ()> {
    if addr & 4095i32 > 4096i32 - 16i32 {
        writable_or_pagefault(addr, 16i32)?;
        safe_write64(addr, value.u64_0[0usize] as i64).unwrap();
        safe_write64(addr + 8i32, value.u64_0[1usize] as i64).unwrap();
    }
    else {
        let mut phys: i32 = translate_address_write(addr)? as i32;
        write128(phys as u32, value);
    };
    Ok(())
}

pub unsafe fn get_reg8_index(mut index: i32) -> i32 {
    return index << 2i32 & 12i32 | index >> 2i32 & 1i32;
}

pub unsafe fn read_reg8(mut index: i32) -> i32 {
    return *reg8.offset(get_reg8_index(index) as isize) as i32;
}

pub unsafe fn write_reg8(mut index: i32, mut value: i32) -> () {
    *reg8.offset(get_reg8_index(index) as isize) = value as u8;
}

pub unsafe fn get_reg16_index(mut index: i32) -> i32 { return index << 1i32; }

pub unsafe fn read_reg16(mut index: i32) -> i32 {
    return *reg16.offset(get_reg16_index(index) as isize) as i32;
}

pub unsafe fn write_reg16(mut index: i32, mut value: i32) -> () {
    *reg16.offset(get_reg16_index(index) as isize) = value as u16;
}

pub unsafe fn read_reg32(mut index: i32) -> i32 { return *reg32s.offset(index as isize); }

pub unsafe fn write_reg32(mut index: i32, mut value: i32) -> () {
    *reg32s.offset(index as isize) = value;
}

pub unsafe fn write_reg_osize(mut index: i32, mut value: i32) -> () {
    dbg_assert!(index >= 0i32 && index < 8i32);
    if is_osize_32() {
        write_reg32(index, value);
    }
    else {
        write_reg16(index, value & 65535i32);
    };
}

pub unsafe fn read_mmx32s(mut r: i32) -> i32 {
    return (*reg_mmx.offset(r as isize)).u32_0[0usize] as i32;
}

pub unsafe fn read_mmx64s(mut r: i32) -> reg64 { return *reg_mmx.offset(r as isize); }

pub unsafe fn write_mmx64(mut r: i32, mut low: i32, mut high: i32) -> () {
    (*reg_mmx.offset(r as isize)).u32_0[0usize] = low as u32;
    (*reg_mmx.offset(r as isize)).u32_0[1usize] = high as u32;
}

pub unsafe fn write_mmx_reg64(mut r: i32, mut data: reg64) -> () {
    (*reg_mmx.offset(r as isize)).u64_0[0usize] = data.u64_0[0usize];
}

pub unsafe fn read_xmm_f32(mut r: i32) -> f32 {
    return (*reg_xmm.offset(r as isize)).f32_0[0usize];
}

pub unsafe fn read_xmm32(mut r: i32) -> i32 {
    return (*reg_xmm.offset(r as isize)).u32_0[0usize] as i32;
}

pub unsafe fn read_xmm64s(mut r: i32) -> reg64 {
    let mut x: reg64 = reg64 { i8_0: [0; 8] };
    x.u64_0[0usize] = (*reg_xmm.offset(r as isize)).u64_0[0usize];
    return x;
}

pub unsafe fn read_xmm128s(mut r: i32) -> reg128 { return *reg_xmm.offset(r as isize); }

pub unsafe fn write_xmm_f32(mut r: i32, mut data: f32) -> () {
    (*reg_xmm.offset(r as isize)).f32_0[0usize] = data;
}

pub unsafe fn write_xmm32(mut r: i32, mut data: i32) -> () {
    (*reg_xmm.offset(r as isize)).i32_0[0usize] = data;
}

pub unsafe fn write_xmm64(mut r: i32, mut data: reg64) -> () {
    (*reg_xmm.offset(r as isize)).u64_0[0usize] = data.u64_0[0usize];
}

pub unsafe fn write_xmm128(mut r: i32, mut i0: i32, mut i1: i32, mut i2: i32, mut i3: i32) -> () {
    let mut x: reg128 = reg128 {
        u32_0: [i0 as u32, i1 as u32, i2 as u32, i3 as u32],
    };
    *reg_xmm.offset(r as isize) = x;
}

pub unsafe fn write_xmm_reg128(mut r: i32, mut data: reg128) -> () {
    (*reg_xmm.offset(r as isize)).u64_0[0usize] = data.u64_0[0usize];
    (*reg_xmm.offset(r as isize)).u64_0[1usize] = data.u64_0[1usize];
}

pub unsafe fn task_switch_test() -> bool {
    if 0 != *cr & (CR0_EM | CR0_TS) {
        trigger_nm();
        return 0 != 0i32;
    }
    else {
        return 0 != 1i32;
    };
}

pub unsafe fn set_mxcsr(new_mxcsr: i32) {
    dbg_assert!(new_mxcsr & !MXCSR_MASK == 0); // checked by caller

    if new_mxcsr & 1 << 6 != 0 {
        dbg_log!("Warning: Unimplemented MXCSR bit: Denormals Are Zero")
    }
    if new_mxcsr & 1 << 15 != 0 {
        dbg_log!("Warning: Unimplemented MXCSR bit: Flush To Zero")
    }

    let rounding_mode = new_mxcsr >> 13 & 3;
    if rounding_mode != 0 {
        dbg_log!(
            "Warning: Unimplemented MXCSR rounding mode: {}",
            rounding_mode
        )
    }

    let exception_mask = new_mxcsr >> 7 & 0b111111;
    if exception_mask != 0x111111 {
        dbg_log!(
            "Warning: Unimplemented MXCSR exception mask: {:b}",
            exception_mask
        )
    }

    *mxcsr = new_mxcsr;
}

#[no_mangle]
pub unsafe fn task_switch_test_void() -> () { task_switch_test(); }

pub unsafe fn task_switch_test_mmx() -> bool {
    if 0 != *cr & CR0_TS {
        trigger_nm();
        return 0 != 0i32;
    }
    else if 0 != *cr & CR0_EM {
        trigger_ud();
        return 0 != 0i32;
    }
    else {
        return 0 != 1i32;
    };
}

#[no_mangle]
pub unsafe fn task_switch_test_mmx_void() -> () { task_switch_test_mmx(); }

pub unsafe fn read_moffs() -> Result<i32, ()> {
    // read 2 or 4 byte from ip, depending on address size attribute
    if is_asize_32() {
        read_imm32s()
    }
    else {
        read_imm16()
    }
}

#[no_mangle]
pub unsafe fn get_real_eip() -> i32 {
    // Returns the 'real' instruction pointer, without segment offset
    return *instruction_pointer - get_seg_cs();
}

pub unsafe fn get_stack_reg() -> i32 {
    if *stack_size_32 {
        return *reg32s.offset(ESP as isize);
    }
    else {
        return *reg16.offset(SP as isize) as i32;
    };
}

#[no_mangle]
pub unsafe fn set_stack_reg(mut value: i32) -> () {
    if *stack_size_32 {
        *reg32s.offset(ESP as isize) = value
    }
    else {
        *reg16.offset(SP as isize) = value as u16
    };
}

pub unsafe fn get_reg_asize(mut reg: i32) -> i32 {
    dbg_assert!(reg == ECX || reg == ESI || reg == EDI);
    let mut r: i32 = *reg32s.offset(reg as isize);
    if is_asize_32() {
        return r;
    }
    else {
        return r & 65535i32;
    };
}

pub unsafe fn set_ecx_asize(mut value: i32) -> () {
    if is_asize_32() {
        *reg32s.offset(ECX as isize) = value
    }
    else {
        *reg16.offset(CX as isize) = value as u16
    };
}

pub unsafe fn add_reg_asize(mut reg: i32, mut value: i32) -> () {
    dbg_assert!(reg == ECX || reg == ESI || reg == EDI);
    if is_asize_32() {
        *reg32s.offset(reg as isize) += value;
    }
    else {
        *reg16.offset((reg << 1i32) as isize) += value as u16;
    };
}

pub unsafe fn decr_ecx_asize() -> i32 {
    return if 0 != is_asize_32() as i32 {
        *reg32s.offset(ECX as isize) -= 1;
        *reg32s.offset(ECX as isize)
    }
    else {
        *reg16.offset(CX as isize) -= 1;
        *reg16.offset(CX as isize) as i32
    };
}

#[no_mangle]
pub unsafe fn set_tsc(mut low: u32, mut high: u32) -> () {
    let mut new_value: u64 = low as u64 | (high as u64) << 32i32;
    let mut current_value: u64 = read_tsc();
    tsc_offset = current_value.wrapping_sub(new_value);
}

pub unsafe fn read_tsc() -> u64 {
    let mut n: f64 = microtick() * TSC_RATE;
    let mut value: u64 = (n as u64).wrapping_sub(tsc_offset);
    if 0 != 1i32 + 1i32 {
        return value;
    }
    else {
        if value == rdtsc_last_value {
            // don't go past 1ms
            if (rdtsc_imprecision_offset as f64) < TSC_RATE {
                rdtsc_imprecision_offset = rdtsc_imprecision_offset.wrapping_add(1)
            }
        }
        else {
            let mut previous_value: u64 = rdtsc_last_value.wrapping_add(rdtsc_imprecision_offset);
            if previous_value <= value {
                rdtsc_last_value = value;
                rdtsc_imprecision_offset = 0i32 as u64
            }
            else {
                dbg_log!(
                    "XXX: Overshot tsc prev={:x}:{:x} offset={:x}:{:x} curr={:x}:{:x}",
                    (rdtsc_last_value >> 32i32) as u32 as i32,
                    rdtsc_last_value as u32 as i32,
                    (rdtsc_imprecision_offset >> 32i32) as u32 as i32,
                    rdtsc_imprecision_offset as u32 as i32,
                    (value >> 32i32) as u32 as i32,
                    value as u32 as i32
                );
                dbg_assert!(0 != 0i32);
                // Keep current value until time catches up
            }
        }
        return rdtsc_last_value.wrapping_add(rdtsc_imprecision_offset);
    };
}

#[no_mangle]
pub unsafe fn vm86_mode() -> bool { return *flags & FLAG_VM == FLAG_VM; }

#[no_mangle]
pub unsafe fn getiopl() -> i32 { return *flags >> 12i32 & 3i32; }

#[no_mangle]
pub unsafe fn get_opstats_buffer(mut index: i32) -> i32 {
    dbg_assert!(index >= 0i32 && index < 512i32);
    if index < 256i32 {
        return *opstats_buffer.offset(index as isize) as i32;
    }
    else {
        return *opstats_buffer_0f.offset((index - 256i32) as isize) as i32;
    };
}

pub unsafe fn invlpg(mut addr: i32) -> () {
    let mut page: i32 = (addr as u32 >> 12i32) as i32;
    // Note: Doesn't remove this page from valid_tlb_entries: This isn't
    // necessary, because when valid_tlb_entries grows too large, it will be
    // empties by calling clear_tlb, which removes this entry as it isn't global.
    // This however means that valid_tlb_entries can contain some invalid entries
    *tlb_data.offset(page as isize) = 0i32;
    *last_virt_eip = -1i32;
    *last_virt_esp = -1i32;
}

#[no_mangle]
pub unsafe fn update_eflags(mut new_flags: i32) -> () {
    let mut dont_update: i32 = FLAG_RF | FLAG_VM | FLAG_VIP | FLAG_VIF;
    let mut clear: i32 = !FLAG_VIP & !FLAG_VIF & FLAGS_MASK;
    if 0 != *flags & FLAG_VM {
        // other case needs to be handled in popf or iret
        dbg_assert!(getiopl() == 3i32);
        dont_update |= FLAG_IOPL;
        // don't clear vip or vif
        clear |= FLAG_VIP | FLAG_VIF
    }
    else {
        if !*protected_mode {
            dbg_assert!(*cpl as i32 == 0i32);
        }
        if 0 != *cpl {
            // cpl > 0
            // cannot update iopl
            dont_update |= FLAG_IOPL;
            if *cpl as i32 > getiopl() {
                // cpl > iopl
                // cannot update interrupt flag
                dont_update |= FLAG_INTERRUPT
            }
        }
    }
    *flags = (new_flags ^ (*flags ^ new_flags) & dont_update) & clear | FLAGS_DEFAULT;
    *flags_changed = 0i32;
}

#[no_mangle]
pub unsafe fn get_valid_tlb_entries_count() -> i32 {
    let mut result: i32 = 0i32;
    let mut i: i32 = 0i32;
    while i < valid_tlb_entries_count {
        let mut page: i32 = valid_tlb_entries[i as usize];
        let mut entry: i32 = *tlb_data.offset(page as isize);
        if 0 != entry {
            result += 1
        }
        i += 1
    }
    return result;
}

#[no_mangle]
pub unsafe fn get_valid_global_tlb_entries_count() -> i32 {
    let mut result: i32 = 0i32;
    let mut i: i32 = 0i32;
    while i < valid_tlb_entries_count {
        let mut page: i32 = valid_tlb_entries[i as usize];
        let mut entry: i32 = *tlb_data.offset(page as isize);
        if 0 != entry & TLB_GLOBAL {
            result += 1
        }
        i += 1
    }
    return result;
}

pub unsafe fn translate_address_system_read(mut address: i32) -> Result<u32, ()> {
    let mut base: i32 = (address as u32 >> 12i32) as i32;
    let mut entry: i32 = *tlb_data.offset(base as isize);
    if 0 != entry & TLB_VALID {
        return Ok((entry & !4095i32 ^ address) as u32);
    }
    else {
        return Ok((do_page_translation(address, 0 != 0i32, 0 != 0i32)? | address & 4095i32) as u32);
    };
}

pub unsafe fn translate_address_system_write(mut address: i32) -> Result<u32, ()> {
    let mut base: i32 = (address as u32 >> 12i32) as i32;
    let mut entry: i32 = *tlb_data.offset(base as isize);
    if entry & (TLB_VALID | TLB_READONLY) == TLB_VALID {
        return Ok((entry & !4095i32 ^ address) as u32);
    }
    else {
        return Ok((do_page_translation(address, 0 != 1i32, 0 != 0i32)? | address & 4095i32) as u32);
    };
}

#[no_mangle]
pub unsafe fn trigger_np(mut code: i32) -> () {
    if DEBUG {
        if cpu_exception_hook(CPU_EXCEPTION_NP) {
            return;
        }
    }
    *instruction_pointer = *previous_ip;
    call_interrupt_vector(CPU_EXCEPTION_NP, 0 != 0i32, 0 != 1i32, code);
}

#[no_mangle]
pub unsafe fn trigger_ss(mut code: i32) -> () {
    if DEBUG {
        if cpu_exception_hook(CPU_EXCEPTION_SS) {
            return;
        }
    }
    *instruction_pointer = *previous_ip;
    call_interrupt_vector(CPU_EXCEPTION_SS, 0 != 0i32, 0 != 1i32, code);
}

#[no_mangle]
pub unsafe fn store_current_tsc() -> () { *current_tsc = read_tsc(); }
