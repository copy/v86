#![allow(non_upper_case_globals)]

extern "C" {
    #[no_mangle]
    fn call_interrupt_vector(interrupt: i32, is_software: bool, has_error: bool, error: i32);
    #[no_mangle]
    fn cpu_exception_hook(interrupt: i32) -> bool;
    #[no_mangle]
    fn dbg_trace();
    //#[no_mangle]
    //fn logop(addr: i32, op: i32);
    #[no_mangle]
    fn microtick() -> f64;
    #[no_mangle]
    fn call_indirect1(f: i32, x: u16);
    #[no_mangle]
    fn pic_acknowledge();
}

use cpu2::fpu::fpu_set_tag_word;
use cpu2::global_pointers::*;
pub use cpu2::imports::{mem16, mem32s, mem8};
use cpu2::memory::{
    in_mapped_range, read128, read16, read32s, read64s, read8, read_aligned16, read_aligned32,
    write128, write16, write32, write64, write8, write_aligned32,
};
use cpu2::misc_instr::{
    adjust_stack_reg, get_stack_pointer, getaf, getcf, getof, getpf, getsf, getzf, pop16, pop32s,
};
use cpu2::modrm::{resolve_modrm16, resolve_modrm32};
use page::Page;
use paging::OrPageFault;
use profiler;
use profiler::stat::*;

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

pub const CHECK_MISSED_ENTRY_POINTS: bool = false;
pub const INTERPRETER_ITERATION_LIMIT: u32 = 1000;

pub const FLAG_CARRY: i32 = 1;
pub const FLAG_PARITY: i32 = 4;
pub const FLAG_ADJUST: i32 = 16;
pub const FLAG_ZERO: i32 = 64;
pub const FLAG_SIGN: i32 = 128;
pub const FLAG_TRAP: i32 = 256;
pub const FLAG_INTERRUPT: i32 = 512;
pub const FLAG_DIRECTION: i32 = 1024;
pub const FLAG_OVERFLOW: i32 = 2048;
pub const FLAG_IOPL: i32 = 1 << 12 | 1 << 13;
pub const FLAG_NT: i32 = 1 << 14;
pub const FLAG_RF: i32 = 1 << 16;
pub const FLAG_VM: i32 = 1 << 17;
pub const FLAG_AC: i32 = 1 << 18;
pub const FLAG_VIF: i32 = 1 << 19;
pub const FLAG_VIP: i32 = 1 << 20;
pub const FLAG_ID: i32 = 1 << 21;
pub const FLAGS_DEFAULT: i32 = 1 << 1;
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
pub const OPSIZE_8: i32 = 7;
pub const OPSIZE_16: i32 = 15;
pub const OPSIZE_32: i32 = 31;
pub const EAX: i32 = 0;
pub const ECX: i32 = 1;
pub const EDX: i32 = 2;
pub const EBX: i32 = 3;
pub const ESP: i32 = 4;
pub const EBP: i32 = 5;
pub const ESI: i32 = 6;
pub const EDI: i32 = 7;
pub const AX: i32 = 0;
pub const CX: i32 = 2;
pub const DX: i32 = 4;
pub const BX: i32 = 6;
pub const SP: i32 = 8;
pub const BP: i32 = 10;
pub const SI: i32 = 12;
pub const DI: i32 = 14;
pub const AL: i32 = 0;
pub const CL: i32 = 4;
pub const DL: i32 = 8;
pub const BL: i32 = 12;
pub const AH: i32 = 1;
pub const CH: i32 = 5;
pub const DH: i32 = 9;
pub const BH: i32 = 13;
pub const ES: i32 = 0;
pub const CS: i32 = 1;
pub const SS: i32 = 2;
pub const DS: i32 = 3;
pub const FS: i32 = 4;
pub const GS: i32 = 5;
pub const TR: i32 = 6;
pub const LDTR: i32 = 7;
pub const PAGE_TABLE_PRESENT_MASK: i32 = 1 << 0;
pub const PAGE_TABLE_RW_MASK: i32 = 1 << 1;
pub const PAGE_TABLE_USER_MASK: i32 = 1 << 2;
pub const PAGE_TABLE_ACCESSED_MASK: i32 = 1 << 5;
pub const PAGE_TABLE_DIRTY_MASK: i32 = 1 << 6;
pub const PAGE_TABLE_PSE_MASK: i32 = 1 << 7;
pub const PAGE_TABLE_GLOBAL_MASK: i32 = 1 << 8;
pub const MMAP_BLOCK_BITS: i32 = 17;
pub const MMAP_BLOCK_SIZE: i32 = 1 << MMAP_BLOCK_BITS;
pub const CR0_PE: i32 = 1;
pub const CR0_MP: i32 = 1 << 1;
pub const CR0_EM: i32 = 1 << 2;
pub const CR0_TS: i32 = 1 << 3;
pub const CR0_ET: i32 = 1 << 4;
pub const CR0_WP: i32 = 1 << 16;
pub const CR0_AM: i32 = 1 << 18;
pub const CR0_NW: i32 = 1 << 29;
pub const CR0_CD: i32 = 1 << 30;
pub const CR0_PG: i32 = 1 << 31;
pub const CR4_VME: i32 = 1;
pub const CR4_PVI: i32 = 1 << 1;
pub const CR4_TSD: i32 = 1 << 2;
pub const CR4_PSE: i32 = 1 << 4;
pub const CR4_DE: i32 = 1 << 3;
pub const CR4_PAE: i32 = 1 << 5;
pub const CR4_PGE: i32 = 1 << 7;
pub const CR4_OSFXSR: i32 = 1 << 9;
pub const CR4_OSXMMEXCPT: i32 = 1 << 10;
pub const IA32_SYSENTER_CS: i32 = 372;
pub const IA32_SYSENTER_ESP: i32 = 373;
pub const IA32_SYSENTER_EIP: i32 = 374;
pub const IA32_TIME_STAMP_COUNTER: i32 = 16;
pub const IA32_PLATFORM_ID: i32 = 23;
pub const IA32_APIC_BASE_MSR: i32 = 27;
pub const IA32_BIOS_SIGN_ID: i32 = 139;
pub const MSR_PLATFORM_INFO: i32 = 206;
pub const MSR_MISC_FEATURE_ENABLES: i32 = 320;
pub const IA32_MISC_ENABLE: i32 = 416;
pub const IA32_RTIT_CTL: i32 = 1392;
pub const MSR_SMI_COUNT: i32 = 52;
pub const IA32_MCG_CAP: i32 = 377;
pub const IA32_KERNEL_GS_BASE: i32 = 0xC0000101u32 as i32;
pub const MSR_PKG_C2_RESIDENCY: i32 = 1549;
pub const IA32_APIC_BASE_BSP: i32 = 1 << 8;
pub const IA32_APIC_BASE_EXTD: i32 = 1 << 10;
pub const IA32_APIC_BASE_EN: i32 = 1 << 11;
pub const APIC_ADDRESS: i32 = 0xFEE00000u32 as i32;
pub const SEG_PREFIX_NONE: i32 = -1;
pub const SEG_PREFIX_ZERO: i32 = 7;
pub const PREFIX_MASK_REP: i32 = 24;
pub const PREFIX_REPZ: i32 = 8;
pub const PREFIX_REPNZ: i32 = 16;
pub const PREFIX_MASK_SEGMENT: i32 = 7;
pub const PREFIX_MASK_OPSIZE: i32 = 32;
pub const PREFIX_MASK_ADDRSIZE: i32 = 64;
pub const PREFIX_F2: i32 = PREFIX_REPNZ;
pub const PREFIX_F3: i32 = PREFIX_REPZ;
pub const PREFIX_66: i32 = PREFIX_MASK_OPSIZE;
pub const LOG_CPU: i32 = 2;
pub const A20_MASK: i32 = !(1 << 20);
pub const A20_MASK16: i32 = !(1 << 20 - 1);
pub const A20_MASK32: i32 = !(1 << 20 - 2);

pub const MXCSR_MASK: i32 = 0xffff;
pub const MXCSR_FZ: i32 = 1 << 15;
pub const MXCSR_DAZ: i32 = 1 << 6;
pub const MXCSR_RC_SHIFT: i32 = 13;

pub const VALID_TLB_ENTRY_MAX: i32 = 10000;
pub const TLB_VALID: i32 = 1 << 0;
pub const TLB_READONLY: i32 = 1 << 1;
pub const TLB_NO_USER: i32 = 1 << 2;
pub const TLB_IN_MAPPED_RANGE: i32 = 1 << 3;
pub const TLB_GLOBAL: i32 = 1 << 4;
pub const TLB_HAS_CODE: i32 = 1 << 5;
pub const CPU_EXCEPTION_DE: i32 = 0;
pub const CPU_EXCEPTION_DB: i32 = 1;
pub const CPU_EXCEPTION_NMI: i32 = 2;
pub const CPU_EXCEPTION_BP: i32 = 3;
pub const CPU_EXCEPTION_OF: i32 = 4;
pub const CPU_EXCEPTION_BR: i32 = 5;
pub const CPU_EXCEPTION_UD: i32 = 6;
pub const CPU_EXCEPTION_NM: i32 = 7;
pub const CPU_EXCEPTION_DF: i32 = 8;
pub const CPU_EXCEPTION_TS: i32 = 10;
pub const CPU_EXCEPTION_NP: i32 = 11;
pub const CPU_EXCEPTION_SS: i32 = 12;
pub const CPU_EXCEPTION_GP: i32 = 13;
pub const CPU_EXCEPTION_PF: i32 = 14;
pub const CPU_EXCEPTION_MF: i32 = 16;
pub const CPU_EXCEPTION_AC: i32 = 17;
pub const CPU_EXCEPTION_MC: i32 = 18;
pub const CPU_EXCEPTION_XM: i32 = 19;
pub const CPU_EXCEPTION_VE: i32 = 20;
pub const CHECK_TLB_INVARIANTS: bool = false;
pub const DEBUG: bool = cfg!(debug_assertions);
pub const LOOP_COUNTER: i32 = 20011;
pub const TSC_RATE: f64 = (50 * 1000) as f64;

pub static mut jit_block_boundary: bool = false;

pub static mut must_not_fault: bool = false;
pub static mut rdtsc_imprecision_offset: u64 = 0;
pub static mut rdtsc_last_value: u64 = 0;
pub static mut tsc_offset: u64 = 0;

pub static mut valid_tlb_entries: [i32; 10000] = [0; 10000];
pub static mut valid_tlb_entries_count: i32 = 0;

pub enum LastJump {
    Interrupt {
        phys_addr: u32,
        int: u8,
        software: bool,
        error: Option<u32>,
    },
    Compiled {
        phys_addr: u32,
    },
    Interpreted {
        phys_addr: u32,
    },
    None,
}
impl LastJump {
    pub fn phys_address(&self) -> Option<u32> {
        match self {
            LastJump::Interrupt { phys_addr, .. } => Some(*phys_addr),
            LastJump::Compiled { phys_addr } => Some(*phys_addr),
            LastJump::Interpreted { phys_addr } => Some(*phys_addr),
            LastJump::None => None,
        }
    }
    pub fn name(&self) -> &'static str {
        match self {
            LastJump::Interrupt { .. } => "interrupt",
            LastJump::Compiled { .. } => "compiled",
            LastJump::Interpreted { .. } => "interpreted",
            LastJump::None => "none",
        }
    }
}
pub static mut debug_last_jump: LastJump = LastJump::None;

pub struct SegmentSelector {
    raw: u16,
}

impl SegmentSelector {
    pub fn rpl(&self) -> u8 { (self.raw & 3) as u8 }
    pub fn is_gdt(&self) -> bool { (self.raw & 4) == 0 }
    pub fn descriptor_offset(&self) -> u16 { (self.raw & !7) as u16 }

    pub fn is_null(&self) -> bool { self.is_gdt() && self.descriptor_offset() == 0 }
}

// Used to indicate early that the selector cannot be used to fetch a descriptor
#[derive(PartialEq)]
pub enum SelectorNullOrInvalid {
    IsNull,
    IsInvalid,
}

pub struct SegmentDescriptor {
    raw: u64,
}

impl SegmentDescriptor {
    pub fn base(&self) -> i32 {
        ((self.raw >> 16) & 0xffff | (self.raw & 0xff_00000000) >> 16 | (self.raw >> 56 << 24))
            as i32
    }
    pub fn limit(&self) -> u32 { (self.raw & 0xffff | ((self.raw >> 48) & 0xf) << 16) as u32 }
    pub fn access_byte(&self) -> u8 { ((self.raw >> 40) & 0xff) as u8 }
    pub fn flags(&self) -> u8 { ((self.raw >> 48 >> 4) & 0xf) as u8 }

    pub fn is_system(&self) -> bool { self.access_byte() & 0x10 == 0 }
    pub fn is_rw(&self) -> bool { self.access_byte() & 2 == 2 }
    pub fn is_dc(&self) -> bool { self.access_byte() & 4 == 4 }
    pub fn is_executable(&self) -> bool { self.access_byte() & 8 == 8 }
    pub fn is_present(&self) -> bool { self.access_byte() & 0x80 == 0x80 }
    pub fn is_writable(&self) -> bool { self.is_rw() && !self.is_executable() }
    pub fn is_readable(&self) -> bool { self.is_rw() || !self.is_executable() }
    pub fn is_conforming_executable(&self) -> bool { self.is_dc() && self.is_executable() }
    pub fn dpl(&self) -> u8 { (self.access_byte() >> 5) & 3 }
    pub fn is_32(&self) -> bool { self.flags() & 4 == 4 }
    pub fn effective_limit(&self) -> u32 {
        if self.flags() & 8 == 8 {
            self.limit() << 12 | 0xFFF
        }
        else {
            self.limit()
        }
    }
}

//pub fn call_indirect1(f: fn(u16), x: u16) { f(x); }

pub unsafe fn after_block_boundary() { jit_block_boundary = true; }

#[no_mangle]
pub fn track_jit_exit(phys_addr: u32) {
    unsafe {
        debug_last_jump = LastJump::Compiled { phys_addr };
    }
}

#[no_mangle]
pub unsafe fn get_eflags() -> i32 {
    return *flags & !FLAGS_ALL
        | getcf() as i32
        | (getpf() as i32) << 2
        | (getaf() as i32) << 4
        | (getzf() as i32) << 6
        | (getsf() as i32) << 7
        | (getof() as i32) << 11;
}

pub unsafe fn translate_address_read(address: i32) -> OrPageFault<u32> {
    let base: i32 = (address as u32 >> 12) as i32;
    let entry: i32 = *tlb_data.offset(base as isize);
    let user: bool = *cpl as i32 == 3;
    if entry & (TLB_VALID | if 0 != user as i32 { TLB_NO_USER } else { 0 }) == TLB_VALID {
        return Ok((entry & !0xFFF ^ address) as u32);
    }
    else {
        return Ok((do_page_translation(address, false, user)? | address & 0xFFF) as u32);
    };
}

pub unsafe fn do_page_translation(addr: i32, for_writing: bool, user: bool) -> OrPageFault<i32> {
    let mut can_write: bool = true;
    let global;
    let mut allow_user: bool = true;
    let page: i32 = (addr as u32 >> 12) as i32;
    let high;
    if *cr & CR0_PG == 0 {
        // paging disabled
        high = (addr as u32 & 0xFFFFF000) as i32;
        global = false
    }
    else {
        let page_dir_addr: i32 =
            (*cr.offset(3) as u32 >> 2).wrapping_add((page >> 10) as u32) as i32;
        let page_dir_entry: i32 = read_aligned32(page_dir_addr as u32);
        // XXX
        let kernel_write_override: bool = !user && 0 == *cr & CR0_WP;
        if 0 == page_dir_entry & PAGE_TABLE_PRESENT_MASK {
            // to do at this place:
            //
            // - set cr2 = addr (which caused the page fault)
            // - call_interrupt_vector  with id 14, error code 0-7 (requires information if read or write)
            // - prevent execution of the function that triggered this call
            *cr.offset(2) = addr;
            trigger_pagefault(for_writing, user, false);
            return Err(());
        }
        if page_dir_entry & PAGE_TABLE_RW_MASK == 0 && !kernel_write_override {
            can_write = false;
            if for_writing {
                *cr.offset(2) = addr;
                trigger_pagefault(for_writing, user, true);
                return Err(());
            }
        }
        if page_dir_entry & PAGE_TABLE_USER_MASK == 0 {
            allow_user = false;
            if user {
                // Page Fault: page table accessed by non-supervisor
                *cr.offset(2) = addr;
                trigger_pagefault(for_writing, user, true);
                return Err(());
            }
        }
        if 0 != page_dir_entry & PAGE_TABLE_PSE_MASK && 0 != *cr.offset(4) & CR4_PSE {
            // size bit is set
            // set the accessed and dirty bits

            let new_page_dir_entry = page_dir_entry | PAGE_TABLE_ACCESSED_MASK | if for_writing {
                PAGE_TABLE_DIRTY_MASK
            }
            else {
                0
            };

            if page_dir_entry != new_page_dir_entry {
                write_aligned32(page_dir_addr as u32, new_page_dir_entry);
            }

            high = (page_dir_entry as u32 & 0xFFC00000 | (addr & 0x3FF000) as u32) as i32;
            global = page_dir_entry & PAGE_TABLE_GLOBAL_MASK == PAGE_TABLE_GLOBAL_MASK
        }
        else {
            let page_table_addr: i32 = ((page_dir_entry as u32 & 0xFFFFF000) >> 2)
                .wrapping_add((page & 1023) as u32) as i32;
            let page_table_entry: i32 = read_aligned32(page_table_addr as u32);
            if page_table_entry & PAGE_TABLE_PRESENT_MASK == 0 {
                *cr.offset(2) = addr;
                trigger_pagefault(for_writing, user, false);
                return Err(());
            }
            if page_table_entry & PAGE_TABLE_RW_MASK == 0 && !kernel_write_override {
                can_write = false;
                if for_writing {
                    *cr.offset(2) = addr;
                    trigger_pagefault(for_writing, user, true);
                    return Err(());
                }
            }
            if page_table_entry & PAGE_TABLE_USER_MASK == 0 {
                allow_user = false;
                if user {
                    *cr.offset(2) = addr;
                    trigger_pagefault(for_writing, user, true);
                    return Err(());
                }
            }

            // Set the accessed and dirty bits
            // Note: dirty bit is only set on the page table entry
            let new_page_dir_entry = page_dir_entry | PAGE_TABLE_ACCESSED_MASK;
            if new_page_dir_entry != page_dir_entry {
                write_aligned32(page_dir_addr as u32, new_page_dir_entry);
            }
            let new_page_table_entry = page_table_entry | PAGE_TABLE_ACCESSED_MASK | if for_writing
            {
                PAGE_TABLE_DIRTY_MASK
            }
            else {
                0
            };
            if page_table_entry != new_page_table_entry {
                write_aligned32(page_table_addr as u32, new_page_table_entry);
            }

            high = (page_table_entry as u32 & 0xFFFFF000) as i32;
            global = page_table_entry & PAGE_TABLE_GLOBAL_MASK == PAGE_TABLE_GLOBAL_MASK
        }
    }
    if *tlb_data.offset(page as isize) == 0 {
        if valid_tlb_entries_count == VALID_TLB_ENTRY_MAX {
            profiler::stat_increment(S_TLB_FULL);
            clear_tlb();
            // also clear global entries if tlb is almost full after clearing non-global pages
            if valid_tlb_entries_count > VALID_TLB_ENTRY_MAX * 3 / 4 {
                profiler::stat_increment(S_TLB_GLOBAL_FULL);
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
        let mut found: bool = false;
        for i in 0..valid_tlb_entries_count {
            if valid_tlb_entries[i as usize] == page {
                found = true;
                break;
            }
        }
        dbg_assert!(found);
    }
    let is_in_mapped_range: bool = in_mapped_range(high as u32);
    let physical_page: i32 = (high as u32 >> 12) as i32;
    let has_code: bool =
        !is_in_mapped_range && 0 != ::c_api::jit_page_has_code(physical_page as u32) as i32;
    let info_bits: i32 = TLB_VALID
        | if 0 != can_write as i32 {
            0
        }
        else {
            TLB_READONLY
        }
        | if 0 != allow_user as i32 {
            0
        }
        else {
            TLB_NO_USER
        }
        | if 0 != is_in_mapped_range as i32 {
            TLB_IN_MAPPED_RANGE
        }
        else {
            0
        }
        | if 0 != global as i32 && 0 != *cr.offset(4) & CR4_PGE {
            TLB_GLOBAL
        }
        else {
            0
        }
        | if 0 != has_code as i32 {
            TLB_HAS_CODE
        }
        else {
            0
        };
    dbg_assert!((high ^ page << 12) & 0xFFF == 0);
    *tlb_data.offset(page as isize) = high ^ page << 12 | info_bits;
    return Ok(high);
}

#[no_mangle]
pub unsafe fn full_clear_tlb() {
    profiler::stat_increment(S_FULL_CLEAR_TLB);
    // clear tlb including global pages
    *last_virt_eip = -1;
    *last_virt_esp = -1;
    for i in 0..valid_tlb_entries_count {
        let page: i32 = valid_tlb_entries[i as usize];
        *tlb_data.offset(page as isize) = 0;
    }
    valid_tlb_entries_count = 0;
    if CHECK_TLB_INVARIANTS {
        for i in 0..0x100000 {
            dbg_assert!(*tlb_data.offset(i as isize) == 0);
        }
    };
}

#[no_mangle]
pub unsafe fn clear_tlb() {
    profiler::stat_increment(S_CLEAR_TLB);
    // clear tlb excluding global pages
    *last_virt_eip = -1;
    *last_virt_esp = -1;
    let mut global_page_offset: i32 = 0;
    for i in 0..valid_tlb_entries_count {
        let page: i32 = valid_tlb_entries[i as usize];
        let entry: i32 = *tlb_data.offset(page as isize);
        if 0 != entry & TLB_GLOBAL {
            // reinsert at the front
            valid_tlb_entries[global_page_offset as usize] = page;
            global_page_offset += 1;
        }
        else {
            *tlb_data.offset(page as isize) = 0
        }
    }
    valid_tlb_entries_count = global_page_offset;
    if CHECK_TLB_INVARIANTS {
        for i in 0..0x100000 {
            dbg_assert!(
                *tlb_data.offset(i as isize) == 0 || 0 != *tlb_data.offset(i as isize) & TLB_GLOBAL
            );
        }
    };
}

pub unsafe fn trigger_pagefault(write: bool, user: bool, present: bool) {
    if false {
        dbg_log!(
            "page fault w={} u={} p={} eip={:x} cr2={:x}",
            write as i32,
            user as i32,
            present as i32,
            *previous_ip,
            *cr.offset(2)
        );
        dbg_trace();
    }
    if DEBUG {
        if must_not_fault {
            dbg_log!("Unexpected page fault");
            dbg_trace();
            dbg_assert!(false);
        }
    }
    //if *page_fault {
    //    dbg_log!(("double fault"));
    //    dbg_trace();
    //    dbg_assert!(false);
    //}
    // invalidate tlb entry
    let page: i32 = (*cr.offset(2) as u32 >> 12) as i32;
    *tlb_data.offset(page as isize) = 0;
    *prefixes = 0;
    *instruction_pointer = *previous_ip;
    //*page_fault = true;
    call_interrupt_vector(
        CPU_EXCEPTION_PF,
        false,
        true,
        (user as i32) << 2 | (write as i32) << 1 | present as i32,
    );
}

pub unsafe fn translate_address_write(address: i32) -> OrPageFault<u32> {
    let base: i32 = (address as u32 >> 12) as i32;
    let entry: i32 = *tlb_data.offset(base as isize);
    let user: bool = *cpl as i32 == 3;
    if entry & (TLB_VALID | if 0 != user as i32 { TLB_NO_USER } else { 0 } | TLB_READONLY)
        == TLB_VALID
    {
        return Ok((entry & !0xFFF ^ address) as u32);
    }
    else {
        return Ok((do_page_translation(address, true, user)? | address & 0xFFF) as u32);
    };
}

#[no_mangle]
pub unsafe fn tlb_set_has_code(physical_page: u32, has_code: bool) {
    dbg_assert!(physical_page < (1 << 20) as u32);
    for i in 0..valid_tlb_entries_count {
        let page: i32 = valid_tlb_entries[i as usize];
        let entry: i32 = *tlb_data.offset(page as isize);
        if 0 != entry {
            let tlb_physical_page: u32 = entry as u32 >> 12 ^ page as u32;
            if physical_page == tlb_physical_page {
                *tlb_data.offset(page as isize) = if 0 != has_code as i32 {
                    entry | TLB_HAS_CODE
                }
                else {
                    entry & !TLB_HAS_CODE
                }
            }
        }
    }
    check_tlb_invariants();
}

#[no_mangle]
pub unsafe fn check_tlb_invariants() {
    if !CHECK_TLB_INVARIANTS {
        return;
    }
    else {
        for i in 0..valid_tlb_entries_count {
            let page: i32 = valid_tlb_entries[i as usize];
            let entry: i32 = *tlb_data.offset(page as isize);
            if 0 == entry || 0 != entry & TLB_IN_MAPPED_RANGE {
                // there's no code in mapped memory
            }
        }
        return;
    };
}

pub unsafe fn writable_or_pagefault(addr: i32, size: i32) -> OrPageFault<()> {
    dbg_assert!(size < 0x1000);
    dbg_assert!(size > 0);
    if *cr & CR0_PG == 0 {
        return Ok(());
    }
    else {
        let user: bool = *cpl as i32 == 3;
        let mask: i32 = TLB_READONLY | TLB_VALID | if 0 != user as i32 { TLB_NO_USER } else { 0 };
        let expect: i32 = TLB_VALID;
        let page: i32 = (addr as u32 >> 12) as i32;
        if *tlb_data.offset(page as isize) & mask != expect {
            do_page_translation(addr, true, user)?;
        }
        let next_page: i32 = ((addr + size - 1) as u32 >> 12) as i32;
        if page != next_page {
            dbg_assert!(next_page == page + 1);
            // XXX: possibly out of bounds
            if *tlb_data.offset(next_page as isize) & mask != expect {
                do_page_translation(next_page << 12, true, user)?;
            }
        }
        return Ok(());
    };
}

pub unsafe fn read_imm8() -> OrPageFault<i32> {
    let eip: i32 = *instruction_pointer;
    if 0 != eip & !0xFFF ^ *last_virt_eip {
        *eip_phys = (translate_address_read(eip)? ^ eip as u32) as i32;
        *last_virt_eip = eip & !0xFFF
    }
    dbg_assert!(!in_mapped_range((*eip_phys ^ eip) as u32));
    let data8: i32 = *mem8.offset((*eip_phys ^ eip) as isize) as i32;
    *instruction_pointer = eip + 1;
    return Ok(data8);
}

pub unsafe fn read_imm8s() -> OrPageFault<i32> { return Ok(read_imm8()? << 24 >> 24); }

pub unsafe fn read_imm16() -> OrPageFault<i32> {
    // Two checks in one comparison:
    // 1. Did the high 20 bits of eip change
    // or 2. Are the low 12 bits of eip 0xFFF (and this read crosses a page boundary)
    if (*instruction_pointer ^ *last_virt_eip) as u32 > 0xFFE {
        return Ok(read_imm8()? | read_imm8()? << 8);
    }
    else {
        let data16: i32 = read16((*eip_phys ^ *instruction_pointer) as u32);
        *instruction_pointer = *instruction_pointer + 2;
        return Ok(data16);
    };
}

pub unsafe fn read_imm32s() -> OrPageFault<i32> {
    // Analogue to the above comment
    if (*instruction_pointer ^ *last_virt_eip) as u32 > 0xFFC {
        return Ok(read_imm16()? | read_imm16()? << 16);
    }
    else {
        let data32: i32 = read32s((*eip_phys ^ *instruction_pointer) as u32);
        *instruction_pointer = *instruction_pointer + 4;
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

pub unsafe fn lookup_segment_selector(
    selector: i32,
) -> OrPageFault<Result<(SegmentDescriptor, SegmentSelector), SelectorNullOrInvalid>> {
    let selector = SegmentSelector {
        raw: selector as u16,
    };

    if selector.is_null() {
        return Ok(Err(SelectorNullOrInvalid::IsNull));
    }

    let (table_offset, table_limit) = if selector.is_gdt() {
        (*gdtr_offset as u32, *gdtr_size as u16)
    }
    else {
        (
            *segment_offsets.offset(LDTR as isize) as u32,
            *segment_limits.offset(LDTR as isize) as u16,
        )
    };

    if selector.descriptor_offset() > table_limit {
        return Ok(Err(SelectorNullOrInvalid::IsInvalid));
    }

    let descriptor_address =
        translate_address_system_read(selector.descriptor_offset() as i32 + table_offset as i32)?;

    let descriptor = SegmentDescriptor {
        raw: read64s(descriptor_address) as u64,
    };

    Ok(Ok((descriptor, selector)))
}

pub unsafe fn switch_seg(reg: i32, selector_raw: i32) -> bool {
    dbg_assert!(reg >= 0 && reg <= 5);
    dbg_assert!(selector_raw >= 0 && selector_raw < 0x10000);

    if !*protected_mode || vm86_mode() {
        *sreg.offset(reg as isize) = selector_raw as u16;
        *segment_is_null.offset(reg as isize) = false;
        *segment_offsets.offset(reg as isize) = selector_raw << 4;

        if reg == SS {
            *stack_size_32 = false;
        }
        return true;
    }

    let (descriptor, selector) =
        match return_on_pagefault!(lookup_segment_selector(selector_raw), false) {
            Ok((desc, sel)) => (desc, sel),
            Err(selector_unusable) => {
                // The selector couldn't be used to fetch a descriptor, so we handle all of those
                // cases
                if selector_unusable == SelectorNullOrInvalid::IsNull {
                    if reg == SS {
                        dbg_log!("#GP for loading 0 in SS sel={:x}", selector_raw);
                        trigger_gp_non_raising(0);
                        return false;
                    }
                    else if reg != CS {
                        // es, ds, fs, gs
                        *sreg.offset(reg as isize) = selector_raw as u16;
                        *segment_is_null.offset(reg as isize) = true;
                        return true;
                    }
                }
                else if selector_unusable == SelectorNullOrInvalid::IsInvalid {
                    dbg_log!(
                        "#GP for loading invalid in seg={} sel={:x}",
                        reg,
                        selector_raw
                    );
                    trigger_gp_non_raising(selector_raw & !3);
                    return false;
                }

                dbg_assert!(false);
                return false;
            },
        };

    if reg == SS {
        if descriptor.is_system()
            || selector.rpl() != *cpl
            || !descriptor.is_writable()
            || descriptor.dpl() != *cpl
        {
            dbg_log!("#GP for loading invalid in SS sel={:x}", selector_raw);
            trigger_gp_non_raising(selector_raw & !3);
            return false;
        }

        if !descriptor.is_present() {
            dbg_log!("#SS for loading non-present in SS sel={:x}", selector_raw);
            trigger_ss(selector_raw & !3);
            return false;
        }

        *stack_size_32 = descriptor.is_32();
    }
    else if reg == CS {
        // handled by switch_cs_real_mode, far_return or far_jump
        dbg_assert!(false);
    }
    else {
        if descriptor.is_system()
            || !descriptor.is_readable()
            || (!descriptor.is_conforming_executable()
                && (selector.rpl() > descriptor.dpl() || *cpl > descriptor.dpl()))
        {
            dbg_log!(
                "#GP for loading invalid in seg {} sel={:x}",
                reg,
                selector_raw,
            );
            trigger_gp_non_raising(selector_raw & !3);
            return false;
        }

        if !descriptor.is_present() {
            dbg_log!(
                "#NP for loading not-present in seg {} sel={:x}",
                reg,
                selector_raw,
            );
            trigger_np(selector_raw & !3);
            return false;
        }
    }

    *segment_is_null.offset(reg as isize) = false;
    *segment_limits.offset(reg as isize) = descriptor.effective_limit();
    *segment_offsets.offset(reg as isize) = descriptor.base();
    *sreg.offset(reg as isize) = selector_raw as u16;

    true
}

#[no_mangle]
pub unsafe fn get_seg(segment: i32) -> i32 {
    dbg_assert!(segment >= 0 && segment < 8);
    // TODO: Remove protected_mode check
    if *protected_mode {
        if *segment_is_null.offset(segment as isize) {
            dbg_assert!(segment != CS && segment != SS);
            dbg_log!("#gp: Access null segment");
            assert!(false);
            //trigger_gp(0); // TODO
        }
    }
    return *segment_offsets.offset(segment as isize);
}

pub unsafe fn set_cr0(cr0: i32) {
    if cr0 & CR0_AM != 0 {
        dbg_log!("Warning: Unimplemented: cr0 alignment mask");
    }
    if (cr0 & (CR0_PE | CR0_PG)) == CR0_PG {
        panic!("cannot load PG without PE");
    }

    let old_cr0 = *cr;
    *cr = cr0;
    *cr |= CR0_ET;

    if old_cr0 & (CR0_PG | CR0_WP) != cr0 & (CR0_PG | CR0_WP) {
        full_clear_tlb();
    }

    *protected_mode = (*cr & CR0_PE) == CR0_PE;
}

pub unsafe fn cpl_changed() {
    *last_virt_eip = -1;
    *last_virt_esp = -1;
}

pub unsafe fn update_cs_size(new_size: bool) {
    if *is_32 != new_size {
        *is_32 = new_size;
    }
}

pub unsafe fn test_privileges_for_io(port: i32, size: i32) -> bool {
    if *protected_mode && (*cpl > getiopl() as u8 || (*flags & FLAG_VM != 0)) {
        if !*tss_size_32 {
            dbg_log!("#GP for port io, 16-bit TSS  port={:x} size={}", port, size);
            trigger_gp_non_raising(0);
            return false;
        }

        let tsr_size = *segment_limits.offset(TR as isize);
        let tsr_offset = *segment_offsets.offset(TR as isize);

        if tsr_size >= 0x67 {
            dbg_assert!(tsr_offset + 0x64 + 2 & 0xFFF < 0xFFF);

            let iomap_base = read16(return_on_pagefault!(
                translate_address_system_read(tsr_offset + 0x64 + 2),
                false
            ));
            let high_port = port + size - 1;

            if tsr_size >= (iomap_base + (high_port >> 3)) as u32 {
                let mask = ((1 << size) - 1) << (port & 7);
                let addr = return_on_pagefault!(
                    translate_address_system_read(tsr_offset + iomap_base + (port >> 3)),
                    false
                );
                let port_info = if mask & 0xFF00 != 0 {
                    read16(addr)
                }
                else {
                    read8(addr)
                };

                dbg_assert!(addr & 0xFFF < 0xFFF);

                if port_info & mask == 0 {
                    return true;
                }
            }
        }

        dbg_log!("#GP for port io  port={:x} size={}", port, size);
        trigger_gp_non_raising(0);
        return false;
    }

    return true;
}

pub unsafe fn popa16() {
    return_on_pagefault!(translate_address_read(get_stack_pointer(0)));
    return_on_pagefault!(translate_address_read(get_stack_pointer(15)));

    *reg16.offset(DI as isize) = pop16().unwrap() as u16;
    *reg16.offset(SI as isize) = pop16().unwrap() as u16;
    *reg16.offset(BP as isize) = pop16().unwrap() as u16;
    adjust_stack_reg(2);
    *reg16.offset(BX as isize) = pop16().unwrap() as u16;
    *reg16.offset(DX as isize) = pop16().unwrap() as u16;
    *reg16.offset(CX as isize) = pop16().unwrap() as u16;
    *reg16.offset(AX as isize) = pop16().unwrap() as u16;
}

pub unsafe fn popa32() {
    return_on_pagefault!(translate_address_read(get_stack_pointer(0)));
    return_on_pagefault!(translate_address_read(get_stack_pointer(31)));

    *reg32s.offset(EDI as isize) = pop32s().unwrap();
    *reg32s.offset(ESI as isize) = pop32s().unwrap();
    *reg32s.offset(EBP as isize) = pop32s().unwrap();
    adjust_stack_reg(4);
    *reg32s.offset(EBX as isize) = pop32s().unwrap();
    *reg32s.offset(EDX as isize) = pop32s().unwrap();
    *reg32s.offset(ECX as isize) = pop32s().unwrap();
    *reg32s.offset(EAX as isize) = pop32s().unwrap();
}

pub unsafe fn get_seg_cs() -> i32 { return *segment_offsets.offset(CS as isize); }

pub unsafe fn get_seg_ss() -> i32 { return *segment_offsets.offset(SS as isize); }

pub unsafe fn get_seg_prefix(default_segment: i32) -> i32 {
    let prefix: i32 = *prefixes as i32 & PREFIX_MASK_SEGMENT;
    if 0 != prefix {
        if prefix == SEG_PREFIX_ZERO {
            return 0;
        }
        else {
            return get_seg(prefix - 1);
        }
    }
    else {
        return get_seg(default_segment);
    };
}

pub unsafe fn get_seg_prefix_ds(offset: i32) -> i32 { return get_seg_prefix(DS) + offset; }

pub unsafe fn get_seg_prefix_ss(offset: i32) -> i32 { return get_seg_prefix(SS) + offset; }

pub unsafe fn get_seg_prefix_cs(offset: i32) -> i32 { return get_seg_prefix(CS) + offset; }

pub unsafe fn modrm_resolve(modrm_byte: i32) -> OrPageFault<i32> {
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
pub unsafe fn cycle_internal() {
    profiler::stat_increment(S_CYCLE_INTERNAL);
    if true {
        *previous_ip = *instruction_pointer;
        let phys_addr: u32 = return_on_pagefault!(get_phys_eip()) as u32;
        let state_flags: CachedStateFlags = pack_current_state_flags();
        let entry: u32 = ::c_api::jit_find_cache_entry(phys_addr, state_flags as u32);

        if 0 != entry {
            profiler::stat_increment(S_RUN_FROM_CACHE);
            let initial_tsc = *timestamp_counter;
            let wasm_table_index = (entry & 0xFFFF) as u16;
            let initial_state = (entry >> 16) as u16;
            dbg_assert!(*prefixes == 0);
            call_indirect1(
                (wasm_table_index as u32).wrapping_add(WASM_TABLE_OFFSET as u32) as i32,
                initial_state,
            );
            dbg_assert!(*prefixes == 0);
            profiler::stat_increment_by(
                S_RUN_FROM_CACHE_STEPS,
                (*timestamp_counter - initial_tsc) as u64,
            );
        }
        else {
            ::jit::record_entry_point(::c_api::get_module(), phys_addr);

            #[cfg(feature = "profiler")]
            {
                if CHECK_MISSED_ENTRY_POINTS {
                    ::jit::check_missed_entry_points(phys_addr, state_flags as u32);
                }
            }

            if DEBUG {
                dbg_assert!(!must_not_fault);
                must_not_fault = true
            }
            if DEBUG {
                dbg_assert!(must_not_fault);
                must_not_fault = false
            }
            let initial_tsc = *timestamp_counter;
            jit_run_interpreted(phys_addr as i32);

            ::c_api::jit_increase_hotness_and_maybe_compile(
                phys_addr,
                get_seg_cs() as u32,
                state_flags as u32,
                *timestamp_counter - initial_tsc,
            );

            profiler::stat_increment_by(
                S_RUN_INTERPRETED_STEPS,
                (*timestamp_counter - initial_tsc) as u64,
            );
        };
    }
    else {
        *previous_ip = *instruction_pointer;

        let opcode = return_on_pagefault!(read_imm8());
        *timestamp_counter += 1;
        dbg_assert!(*prefixes == 0);
        run_instruction(opcode | (*is_32 as i32) << 8);
        dbg_assert!(*prefixes == 0);
    }
}

pub unsafe fn get_phys_eip() -> OrPageFault<u32> {
    let eip: i32 = *instruction_pointer;
    if 0 != eip & !0xFFF ^ *last_virt_eip {
        *eip_phys = (translate_address_read(eip)? ^ eip as u32) as i32;
        *last_virt_eip = eip & !0xFFF
    }
    let phys_addr: u32 = (*eip_phys ^ eip) as u32;
    dbg_assert!(!in_mapped_range(phys_addr));
    return Ok(phys_addr);
}

unsafe fn jit_run_interpreted(phys_addr: i32) {
    profiler::stat_increment(S_RUN_INTERPRETED);
    dbg_assert!(!in_mapped_range(phys_addr as u32));

    if cfg!(debug_assertions) {
        debug_last_jump = LastJump::Interpreted {
            phys_addr: phys_addr as u32,
        };
    }

    jit_block_boundary = false;
    let opcode = *mem8.offset(phys_addr as isize) as i32;
    *instruction_pointer += 1;
    *timestamp_counter += 1;
    dbg_assert!(*prefixes == 0);
    run_instruction(opcode | (*is_32 as i32) << 8);
    dbg_assert!(*prefixes == 0);

    // We need to limit the number of iterations here as jumps within the same page are not counted
    // as block boundaries for the interpreter (as they don't create an entry point and don't need
    // a check if the jump target may have compiled code)
    let mut i = 0;

    while !jit_block_boundary
        && Page::page_of(*previous_ip as u32) == Page::page_of(*instruction_pointer as u32)
        && i < INTERPRETER_ITERATION_LIMIT
    {
        *previous_ip = *instruction_pointer;
        let opcode = return_on_pagefault!(read_imm8());

        if CHECK_MISSED_ENTRY_POINTS {
            let phys_addr = return_on_pagefault!(get_phys_eip()) as u32;
            let state_flags: CachedStateFlags = pack_current_state_flags();
            let entry = ::c_api::jit_find_cache_entry(phys_addr, state_flags as u32);

            if entry != 0 {
                profiler::stat_increment(S_RUN_INTERPRETED_MISSED_COMPILED_ENTRY_RUN_INTERPRETED);
                //dbg_log!(
                //    "missed entry point at {:x} prev_opcode={:x} opcode={:x}",
                //    phys_addr,
                //    prev_opcode,
                //    opcode
                //);
            }
        }

        if cfg!(debug_assertions) {
            debug_last_jump = LastJump::Interpreted {
                phys_addr: phys_addr as u32,
            };
        }

        *timestamp_counter += 1;

        //if DEBUG {
        //    logop(*previous_ip, opcode_0);
        //}

        dbg_assert!(*prefixes == 0);
        run_instruction(opcode | (*is_32 as i32) << 8);
        dbg_assert!(*prefixes == 0);

        i += 1;
    }
}

#[no_mangle]
pub unsafe fn pack_current_state_flags() -> CachedStateFlags {
    return ((*is_32 as i32) << 0
        | (*stack_size_32 as i32) << 1
        | ((*cpl as i32 == 3) as i32) << 2
        | (has_flat_segmentation() as i32) << 3) as CachedStateFlags;
}

#[no_mangle]
pub unsafe fn has_flat_segmentation() -> bool {
    // ss can't be null
    return *segment_offsets.offset(SS as isize) == 0
        && !*segment_is_null.offset(DS as isize)
        && *segment_offsets.offset(DS as isize) == 0;
}

pub unsafe fn run_prefix_instruction() {
    run_instruction(return_on_pagefault!(read_imm8()) | (is_osize_32() as i32) << 8);
}

pub unsafe fn clear_prefixes() { *prefixes = 0 }

pub unsafe fn segment_prefix_op(seg: i32) {
    dbg_assert!(seg <= 5);
    *prefixes = (*prefixes as i32 | seg + 1) as u8;
    run_prefix_instruction();
    *prefixes = 0
}

#[no_mangle]
pub unsafe fn do_many_cycles_native() {
    profiler::stat_increment(S_DO_MANY_CYCLES);
    let initial_timestamp_counter: u32 = *timestamp_counter;
    while (*timestamp_counter).wrapping_sub(initial_timestamp_counter) < LOOP_COUNTER as u32
        && !*in_hlt
    {
        cycle_internal();
    }
}

pub unsafe fn trigger_de() {
    if DEBUG {
        if cpu_exception_hook(CPU_EXCEPTION_DE) {
            return;
        }
    }
    *prefixes = 0;
    *instruction_pointer = *previous_ip;
    call_interrupt_vector(CPU_EXCEPTION_DE, false, false, 0);
}

#[no_mangle]
pub unsafe fn trigger_ud() {
    dbg_log!("#ud");
    dbg_trace();
    if DEBUG {
        if cpu_exception_hook(CPU_EXCEPTION_UD) {
            return;
        }
    }
    *prefixes = 0;
    *instruction_pointer = *previous_ip;
    call_interrupt_vector(CPU_EXCEPTION_UD, false, false, 0);
}

pub unsafe fn trigger_nm() {
    if DEBUG {
        if cpu_exception_hook(CPU_EXCEPTION_NM) {
            return;
        }
    }
    *prefixes = 0;
    *instruction_pointer = *previous_ip;
    call_interrupt_vector(CPU_EXCEPTION_NM, false, false, 0);
}

#[no_mangle]
pub unsafe fn trigger_gp_non_raising(code: i32) {
    if DEBUG {
        if cpu_exception_hook(CPU_EXCEPTION_GP) {
            return;
        }
    }
    *prefixes = 0;
    *instruction_pointer = *previous_ip;
    call_interrupt_vector(CPU_EXCEPTION_GP, false, true, code);
}

pub unsafe fn virt_boundary_read16(low: u32, high: u32) -> i32 {
    dbg_assert!(low & 0xFFF == 0xFFF);
    dbg_assert!(high & 0xFFF == 0);
    return read8(low as u32) | read8(high as u32) << 8;
}

pub unsafe fn virt_boundary_read32s(low: u32, high: u32) -> i32 {
    dbg_assert!(low & 0xFFF >= 0xFFD);
    dbg_assert!(high - 3 & 0xFFF == low & 0xFFF);
    let mid;
    if 0 != low & 1 {
        if 0 != low & 2 {
            // 0xFFF
            mid = read_aligned16((high - 2 >> 1) as u32)
        }
        else {
            // 0xFFD
            mid = read_aligned16((low + 1 >> 1) as u32)
        }
    }
    else {
        // 0xFFE
        mid = virt_boundary_read16(low + 1, high - 1)
    }
    return read8(low as u32) | mid << 8 | read8(high as u32) << 24;
}

pub unsafe fn virt_boundary_write16(low: u32, high: u32, value: i32) {
    dbg_assert!(low & 0xFFF == 0xFFF);
    dbg_assert!(high & 0xFFF == 0);
    write8(low as u32, value);
    write8(high as u32, value >> 8);
}

pub unsafe fn virt_boundary_write32(low: u32, high: u32, value: i32) {
    dbg_assert!(low & 0xFFF >= 0xFFD);
    dbg_assert!(high - 3 & 0xFFF == low & 0xFFF);
    write8(low as u32, value);
    if 0 != low & 1 {
        if 0 != low & 2 {
            // 0xFFF
            write8((high - 2) as u32, value >> 8);
            write8((high - 1) as u32, value >> 16);
        }
        else {
            // 0xFFD
            write8((low + 1) as u32, value >> 8);
            write8((low + 2) as u32, value >> 16);
        }
    }
    else {
        // 0xFFE
        write8((low + 1) as u32, value >> 8);
        write8((high - 1) as u32, value >> 16);
    }
    write8(high as u32, value >> 24);
}

pub unsafe fn safe_read8(addr: i32) -> OrPageFault<i32> {
    return Ok(read8(translate_address_read(addr)?));
}

pub unsafe fn safe_read16(address: i32) -> OrPageFault<i32> {
    let base: i32 = (address as u32 >> 12) as i32;
    let entry: i32 = *tlb_data.offset(base as isize);
    let info_bits: i32 = entry & 0xFFF & !TLB_READONLY & !TLB_GLOBAL & !TLB_HAS_CODE;
    if info_bits == TLB_VALID && address & 0xFFF <= 0x1000 - 2 {
        // - not in memory mapped area
        // - can be accessed from any cpl
        let phys_address: u32 = (entry & !0xFFF ^ address) as u32;
        dbg_assert!(!in_mapped_range(phys_address));
        return Ok(*(mem8.offset(phys_address as isize) as *mut u16) as i32);
    }
    else {
        return Ok(safe_read16_slow(address)?);
    };
}

pub unsafe fn safe_read16_slow(addr: i32) -> OrPageFault<i32> {
    if addr & 0xFFF == 0xFFF {
        return Ok(safe_read8(addr)? | safe_read8(addr + 1)? << 8);
    }
    else {
        return Ok(read16(translate_address_read(addr)?));
    };
}

pub unsafe fn safe_read32s(address: i32) -> OrPageFault<i32> {
    let base: i32 = (address as u32 >> 12) as i32;
    let entry: i32 = *tlb_data.offset(base as isize);
    let info_bits: i32 = entry & 0xFFF & !TLB_READONLY & !TLB_GLOBAL & !TLB_HAS_CODE;
    if info_bits == TLB_VALID && address & 0xFFF <= 0x1000 - 4 {
        if false {
            profiler::stat_increment(S_SAFE_READ_FAST);
        }
        // - not in memory mapped area
        // - can be accessed from any cpl
        let phys_address: u32 = (entry & !0xFFF ^ address) as u32;
        dbg_assert!(!in_mapped_range(phys_address));
        return Ok(*(mem8.offset(phys_address as isize) as *mut i32));
    }
    else {
        if false {
            if address & 0xFFF > 0x1000 - 4 {
                profiler::stat_increment(S_SAFE_READ_SLOW_PAGE_CROSSED);
            }
            else if info_bits & TLB_VALID == 0 {
                profiler::stat_increment(S_SAFE_READ_SLOW_NOT_VALID);
            }
            else if 0 != info_bits & TLB_NO_USER {
                profiler::stat_increment(S_SAFE_READ_SLOW_NOT_USER);
            }
            else if 0 != info_bits & TLB_IN_MAPPED_RANGE {
                profiler::stat_increment(S_SAFE_READ_SLOW_IN_MAPPED_RANGE);
            }
            else {
                dbg_assert!(false);
            }
        }
        return safe_read32s_slow(address);
    };
}

#[no_mangle]
#[cfg(feature = "profiler")]
pub fn report_safe_read_jit_slow(address: u32, entry: i32) {
    if entry & TLB_VALID == 0 {
        profiler::stat_increment(S_SAFE_READ_SLOW_NOT_VALID);
    }
    else if entry & TLB_IN_MAPPED_RANGE != 0 {
        profiler::stat_increment(S_SAFE_READ_SLOW_IN_MAPPED_RANGE);
    }
    else if entry & TLB_NO_USER != 0 {
        profiler::stat_increment(S_SAFE_READ_SLOW_NOT_USER);
    }
    else if address & 0xFFF > 0x1000 - 4 {
        profiler::stat_increment(S_SAFE_READ_SLOW_PAGE_CROSSED);
    }
    else {
        dbg_log!("Unexpected entry bit: {:x} (read at {:x})", entry, address);
        dbg_assert!(false);
    }
}

#[no_mangle]
#[cfg(feature = "profiler")]
pub fn report_safe_write_jit_slow(address: u32, entry: i32) {
    if entry & TLB_VALID == 0 {
        profiler::stat_increment(S_SAFE_WRITE_SLOW_NOT_VALID);
    }
    else if entry & TLB_IN_MAPPED_RANGE != 0 {
        profiler::stat_increment(S_SAFE_WRITE_SLOW_IN_MAPPED_RANGE);
    }
    else if entry & TLB_HAS_CODE != 0 {
        profiler::stat_increment(S_SAFE_WRITE_SLOW_HAS_CODE);
    }
    else if entry & TLB_READONLY != 0 {
        profiler::stat_increment(S_SAFE_WRITE_SLOW_READ_ONLY);
    }
    else if entry & TLB_NO_USER != 0 {
        profiler::stat_increment(S_SAFE_WRITE_SLOW_NOT_USER);
    }
    else if address & 0xFFF > 0x1000 - 4 {
        profiler::stat_increment(S_SAFE_WRITE_SLOW_PAGE_CROSSED);
    }
    else {
        dbg_assert!(false);
    }
}

pub unsafe fn safe_read32s_slow(addr: i32) -> OrPageFault<i32> {
    if addr & 0xFFF >= 0xFFD {
        return Ok(safe_read16(addr)? | safe_read16(addr + 2)? << 16);
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

pub unsafe fn safe_read64s(addr: i32) -> OrPageFault<reg64> {
    let mut x: reg64 = reg64 { i8_0: [0; 8] };
    if addr & 0xFFF > 0x1000 - 8 {
        x.u32_0[0] = safe_read32s(addr)? as u32;
        x.u32_0[1] = safe_read32s(addr + 4)? as u32
    }
    else {
        let addr_phys = translate_address_read(addr)?;
        x.u64_0[0] = read64s(addr_phys) as u64
    }
    Ok(x)
}

pub unsafe fn safe_read128s(addr: i32) -> OrPageFault<reg128> {
    let mut x: reg128 = reg128 { i8_0: [0; 16] };
    if addr & 0xFFF > 0x1000 - 16 {
        x.u64_0[0] = safe_read64s(addr)?.u64_0[0];
        x.u64_0[1] = safe_read64s(addr + 8)?.u64_0[0]
    }
    else {
        let addr_phys = translate_address_read(addr)?;
        x = read128(addr_phys)
    }
    Ok(x)
}

pub unsafe fn safe_write8(addr: i32, value: i32) -> OrPageFault<()> {
    write8(translate_address_write(addr)?, value);
    Ok(())
}

pub unsafe fn safe_write16(address: i32, value: i32) -> OrPageFault<()> {
    let base: i32 = (address as u32 >> 12) as i32;
    let entry: i32 = *tlb_data.offset(base as isize);
    let info_bits: i32 = entry & 0xFFF & !TLB_GLOBAL;
    if info_bits == TLB_VALID && address & 0xFFF <= 0x1000 - 2 {
        // - allowed to write in user-mode
        // - not in memory mapped area
        // - can be accessed from any cpl
        // - does not contain code
        let phys_address: u32 = (entry & !0xFFF ^ address) as u32;
        dbg_assert!(!::c_api::jit_page_has_code(phys_address >> 12));
        dbg_assert!(!in_mapped_range(phys_address));
        *(mem8.offset(phys_address as isize) as *mut u16) = value as u16;
    }
    else {
        safe_write16_slow(address, value)?;
    };
    Ok(())
}

pub unsafe fn safe_write16_slow(addr: i32, value: i32) -> OrPageFault<()> {
    let phys_low = translate_address_write(addr)?;
    if addr & 0xFFF == 0xFFF {
        virt_boundary_write16(phys_low, translate_address_write(addr + 1)?, value);
    }
    else {
        write16(phys_low as u32, value);
    };
    Ok(())
}

pub unsafe fn safe_write32(address: i32, value: i32) -> OrPageFault<()> {
    let base: i32 = (address as u32 >> 12) as i32;
    let entry: i32 = *tlb_data.offset(base as isize);
    let info_bits: i32 =
        entry & 0xFFF & !TLB_GLOBAL & !if *cpl as i32 == 3 { 0 } else { TLB_NO_USER };
    if info_bits == TLB_VALID && address & 0xFFF <= 0x1000 - 4 {
        if false {
            profiler::stat_increment(S_SAFE_WRITE_FAST);
        }
        // - allowed to write in user-mode
        // - not in memory mapped area
        // - does not contain code
        let phys_address: u32 = (entry & !0xFFF ^ address) as u32;
        dbg_assert!(!::c_api::jit_page_has_code(phys_address >> 12));
        dbg_assert!(!in_mapped_range(phys_address));
        *(mem8.offset(phys_address as isize) as *mut i32) = value;
    }
    else {
        if false {
            if address & 0xFFF > 0x1000 - 4 {
                profiler::stat_increment(S_SAFE_WRITE_SLOW_PAGE_CROSSED);
            }
            else if info_bits & TLB_VALID == 0 {
                profiler::stat_increment(S_SAFE_WRITE_SLOW_NOT_VALID);
            }
            else if 0 != info_bits & TLB_NO_USER {
                profiler::stat_increment(S_SAFE_WRITE_SLOW_NOT_USER);
            }
            else if 0 != info_bits & TLB_IN_MAPPED_RANGE {
                profiler::stat_increment(S_SAFE_WRITE_SLOW_IN_MAPPED_RANGE);
            }
            else if 0 != info_bits & TLB_READONLY {
                profiler::stat_increment(S_SAFE_WRITE_SLOW_READ_ONLY);
            }
            else if 0 != info_bits & TLB_HAS_CODE {
                profiler::stat_increment(S_SAFE_WRITE_SLOW_HAS_CODE);
            }
            else {
                dbg_assert!(false);
            }
        }
        safe_write32_slow(address, value)?;
    };
    Ok(())
}

pub unsafe fn safe_write32_slow(addr: i32, value: i32) -> OrPageFault<()> {
    let phys_low = translate_address_write(addr)?;
    if addr & 0xFFF > 0x1000 - 4 {
        virt_boundary_write32(
            phys_low,
            translate_address_write(addr + 3 & !3)? | (addr as u32 + 3 & 3),
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

pub unsafe fn safe_write64(addr: i32, value: i64) -> OrPageFault<()> {
    if addr & 0xFFF > 0x1000 - 8 {
        writable_or_pagefault(addr, 8)?;
        safe_write32(addr, value as i32).unwrap();
        safe_write32(addr + 4, (value >> 32) as i32).unwrap();
    }
    else {
        let phys = translate_address_write(addr)?;
        write64(phys, value);
    };
    Ok(())
}

pub unsafe fn safe_write128(addr: i32, value: reg128) -> OrPageFault<()> {
    if addr & 0xFFF > 0x1000 - 16 {
        writable_or_pagefault(addr, 16)?;
        safe_write64(addr, value.u64_0[0] as i64).unwrap();
        safe_write64(addr + 8, value.u64_0[1] as i64).unwrap();
    }
    else {
        let phys = translate_address_write(addr)?;
        write128(phys, value);
    };
    Ok(())
}

pub unsafe fn get_reg8_index(index: i32) -> i32 { return index << 2 & 12 | index >> 2 & 1; }

pub unsafe fn read_reg8(index: i32) -> i32 {
    return *reg8.offset(get_reg8_index(index) as isize) as i32;
}

pub unsafe fn write_reg8(index: i32, value: i32) {
    *reg8.offset(get_reg8_index(index) as isize) = value as u8;
}

pub unsafe fn get_reg16_index(index: i32) -> i32 { return index << 1; }

pub unsafe fn read_reg16(index: i32) -> i32 {
    return *reg16.offset(get_reg16_index(index) as isize) as i32;
}

pub unsafe fn write_reg16(index: i32, value: i32) {
    *reg16.offset(get_reg16_index(index) as isize) = value as u16;
}

pub unsafe fn read_reg32(index: i32) -> i32 { return *reg32s.offset(index as isize); }

pub unsafe fn write_reg32(index: i32, value: i32) { *reg32s.offset(index as isize) = value; }

pub unsafe fn write_reg_osize(index: i32, value: i32) {
    dbg_assert!(index >= 0 && index < 8);
    if is_osize_32() {
        write_reg32(index, value);
    }
    else {
        write_reg16(index, value & 0xFFFF);
    };
}

pub unsafe fn read_mmx32s(r: i32) -> i32 { return (*reg_mmx.offset(r as isize)).u32_0[0] as i32; }

pub unsafe fn read_mmx64s(r: i32) -> reg64 { return *reg_mmx.offset(r as isize); }

pub unsafe fn write_mmx64(r: i32, low: i32, high: i32) {
    *fxsave_store_fpu_mask &= !(1 << r);
    (*reg_mmx.offset(r as isize)).u32_0[0] = low as u32;
    (*reg_mmx.offset(r as isize)).u32_0[1] = high as u32;
}

pub unsafe fn write_mmx_reg64(r: i32, data: reg64) {
    *fxsave_store_fpu_mask &= !(1 << r);
    (*reg_mmx.offset(r as isize)).u64_0[0] = data.u64_0[0];
}

pub unsafe fn read_xmm_f32(r: i32) -> f32 { return (*reg_xmm.offset(r as isize)).f32_0[0]; }

pub unsafe fn read_xmm32(r: i32) -> i32 { return (*reg_xmm.offset(r as isize)).u32_0[0] as i32; }

pub unsafe fn read_xmm64s(r: i32) -> reg64 {
    let mut x: reg64 = reg64 { i8_0: [0; 8] };
    x.u64_0[0] = (*reg_xmm.offset(r as isize)).u64_0[0];
    return x;
}

pub unsafe fn read_xmm128s(r: i32) -> reg128 { return *reg_xmm.offset(r as isize); }

pub unsafe fn write_xmm_f32(r: i32, data: f32) { (*reg_xmm.offset(r as isize)).f32_0[0] = data; }

pub unsafe fn write_xmm32(r: i32, data: i32) { (*reg_xmm.offset(r as isize)).i32_0[0] = data; }

pub unsafe fn write_xmm64(r: i32, data: reg64) {
    (*reg_xmm.offset(r as isize)).u64_0[0] = data.u64_0[0];
}

pub unsafe fn write_xmm128(r: i32, i0: i32, i1: i32, i2: i32, i3: i32) {
    let x: reg128 = reg128 {
        u32_0: [i0 as u32, i1 as u32, i2 as u32, i3 as u32],
    };
    *reg_xmm.offset(r as isize) = x;
}

pub unsafe fn write_xmm_reg128(r: i32, data: reg128) {
    (*reg_xmm.offset(r as isize)).u64_0[0] = data.u64_0[0];
    (*reg_xmm.offset(r as isize)).u64_0[1] = data.u64_0[1];
}

/// Set the fpu tag word to valid and the top-of-stack to 0 on mmx instructions
pub fn transition_fpu_to_mmx() {
    unsafe {
        fpu_set_tag_word(0);
        *fpu_stack_ptr = 0;
    }
}

pub unsafe fn task_switch_test() -> bool {
    if 0 != *cr & (CR0_EM | CR0_TS) {
        trigger_nm();
        return false;
    }
    else {
        return true;
    };
}

pub unsafe fn set_mxcsr(new_mxcsr: i32) {
    dbg_assert!(new_mxcsr & !MXCSR_MASK == 0); // checked by caller

    if *mxcsr & MXCSR_DAZ == 0 && new_mxcsr & MXCSR_DAZ != 0 {
        dbg_log!("Warning: Unimplemented MXCSR bit: Denormals Are Zero")
    }
    if *mxcsr & MXCSR_FZ == 0 && new_mxcsr & MXCSR_FZ != 0 {
        dbg_log!("Warning: Unimplemented MXCSR bit: Flush To Zero")
    }

    let rounding_mode = new_mxcsr >> MXCSR_RC_SHIFT & 3;
    if *mxcsr >> MXCSR_RC_SHIFT & 3 == 0 && rounding_mode != 0 {
        dbg_log!(
            "Warning: Unimplemented MXCSR rounding mode: {}",
            rounding_mode
        )
    }

    let exception_mask = new_mxcsr >> 7 & 0b111111;
    if exception_mask != 0b111111 {
        dbg_log!(
            "Warning: Unimplemented MXCSR exception mask: 0b{:b}",
            exception_mask
        )
    }

    *mxcsr = new_mxcsr;
}

#[no_mangle]
pub unsafe fn task_switch_test_void() { task_switch_test(); }

pub unsafe fn task_switch_test_mmx() -> bool {
    if *cr.offset(4) & CR4_OSFXSR == 0 {
        dbg_log!("Warning: Unimplemented task switch test with cr4.osfxsr=0");
    }
    if 0 != *cr & CR0_EM {
        trigger_ud();
        return false;
    }
    else if 0 != *cr & CR0_TS {
        trigger_nm();
        return false;
    }
    else {
        return true;
    };
}

#[no_mangle]
pub unsafe fn task_switch_test_mmx_void() { task_switch_test_mmx(); }

pub unsafe fn read_moffs() -> OrPageFault<i32> {
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
pub unsafe fn set_stack_reg(value: i32) {
    if *stack_size_32 {
        *reg32s.offset(ESP as isize) = value
    }
    else {
        *reg16.offset(SP as isize) = value as u16
    };
}

pub unsafe fn get_reg_asize(reg: i32) -> i32 {
    dbg_assert!(reg == ECX || reg == ESI || reg == EDI);
    let r: i32 = *reg32s.offset(reg as isize);
    if is_asize_32() {
        return r;
    }
    else {
        return r & 0xFFFF;
    };
}

pub unsafe fn set_ecx_asize(value: i32) {
    if is_asize_32() {
        *reg32s.offset(ECX as isize) = value
    }
    else {
        *reg16.offset(CX as isize) = value as u16
    };
}

pub unsafe fn add_reg_asize(reg: i32, value: i32) {
    dbg_assert!(reg == ECX || reg == ESI || reg == EDI);
    if is_asize_32() {
        *reg32s.offset(reg as isize) += value;
    }
    else {
        *reg16.offset((reg << 1) as isize) += value as u16;
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
pub unsafe fn set_tsc(low: u32, high: u32) {
    let new_value: u64 = low as u64 | (high as u64) << 32;
    let current_value: u64 = read_tsc();
    tsc_offset = current_value.wrapping_sub(new_value);
}

pub unsafe fn read_tsc() -> u64 {
    let n: f64 = microtick() * TSC_RATE;
    let value: u64 = (n as u64).wrapping_sub(tsc_offset);
    if true {
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
            let previous_value: u64 = rdtsc_last_value.wrapping_add(rdtsc_imprecision_offset);
            if previous_value <= value {
                rdtsc_last_value = value;
                rdtsc_imprecision_offset = 0
            }
            else {
                dbg_log!(
                    "XXX: Overshot tsc prev={:x}:{:x} offset={:x}:{:x} curr={:x}:{:x}",
                    (rdtsc_last_value >> 32) as u32 as i32,
                    rdtsc_last_value as u32 as i32,
                    (rdtsc_imprecision_offset >> 32) as u32 as i32,
                    rdtsc_imprecision_offset as u32 as i32,
                    (value >> 32) as u32 as i32,
                    value as u32 as i32
                );
                dbg_assert!(false);
                // Keep current value until time catches up
            }
        }
        return rdtsc_last_value.wrapping_add(rdtsc_imprecision_offset);
    };
}

#[no_mangle]
pub unsafe fn vm86_mode() -> bool { return *flags & FLAG_VM == FLAG_VM; }

#[no_mangle]
pub unsafe fn getiopl() -> i32 { return *flags >> 12 & 3; }

#[no_mangle]
pub unsafe fn get_opstats_buffer(index: i32) -> i32 {
    dbg_assert!(index >= 0 && index < 0x400);
    if index < 0x100 {
        return *opstats_buffer.offset(index as isize) as i32;
    }
    else if index < 0x200 {
        return *opstats_buffer_0f.offset((index - 0x100) as isize) as i32;
    }
    else if index < 0x300 {
        return *opstats_compiled_buffer.offset((index - 0x200) as isize) as i32;
    }
    else {
        return *opstats_compiled_buffer_0f.offset((index - 0x300) as isize) as i32;
    }
}

pub unsafe fn invlpg(addr: i32) {
    let page: i32 = (addr as u32 >> 12) as i32;
    // Note: Doesn't remove this page from valid_tlb_entries: This isn't
    // necessary, because when valid_tlb_entries grows too large, it will be
    // empties by calling clear_tlb, which removes this entry as it isn't global.
    // This however means that valid_tlb_entries can contain some invalid entries
    *tlb_data.offset(page as isize) = 0;
    *last_virt_eip = -1;
    *last_virt_esp = -1;
}

#[no_mangle]
pub unsafe fn update_eflags(new_flags: i32) {
    let mut dont_update: i32 = FLAG_RF | FLAG_VM | FLAG_VIP | FLAG_VIF;
    let mut clear: i32 = !FLAG_VIP & !FLAG_VIF & FLAGS_MASK;
    if 0 != *flags & FLAG_VM {
        // other case needs to be handled in popf or iret
        dbg_assert!(getiopl() == 3);
        dont_update |= FLAG_IOPL;
        // don't clear vip or vif
        clear |= FLAG_VIP | FLAG_VIF
    }
    else {
        if !*protected_mode {
            dbg_assert!(*cpl as i32 == 0);
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
    *flags_changed = 0;
}

#[no_mangle]
pub unsafe fn get_valid_tlb_entries_count() -> i32 {
    if !cfg!(feature = "profiler") {
        return 0;
    }
    let mut result: i32 = 0;
    for i in 0..valid_tlb_entries_count {
        let page: i32 = valid_tlb_entries[i as usize];
        let entry: i32 = *tlb_data.offset(page as isize);
        if 0 != entry {
            result += 1
        }
    }
    return result;
}

#[no_mangle]
pub unsafe fn get_valid_global_tlb_entries_count() -> i32 {
    if !cfg!(feature = "profiler") {
        return 0;
    }
    let mut result: i32 = 0;
    for i in 0..valid_tlb_entries_count {
        let page: i32 = valid_tlb_entries[i as usize];
        let entry: i32 = *tlb_data.offset(page as isize);
        if 0 != entry & TLB_GLOBAL {
            result += 1
        }
    }
    return result;
}

pub unsafe fn translate_address_system_read(address: i32) -> OrPageFault<u32> {
    let base: i32 = (address as u32 >> 12) as i32;
    let entry: i32 = *tlb_data.offset(base as isize);
    if 0 != entry & TLB_VALID {
        return Ok((entry & !0xFFF ^ address) as u32);
    }
    else {
        return Ok((do_page_translation(address, false, false)? | address & 0xFFF) as u32);
    };
}

pub unsafe fn translate_address_system_write(address: i32) -> OrPageFault<u32> {
    let base: i32 = (address as u32 >> 12) as i32;
    let entry: i32 = *tlb_data.offset(base as isize);
    if entry & (TLB_VALID | TLB_READONLY) == TLB_VALID {
        return Ok((entry & !0xFFF ^ address) as u32);
    }
    else {
        return Ok((do_page_translation(address, true, false)? | address & 0xFFF) as u32);
    };
}

#[no_mangle]
pub unsafe fn trigger_np(code: i32) {
    if DEBUG {
        if cpu_exception_hook(CPU_EXCEPTION_NP) {
            return;
        }
    }
    *prefixes = 0;
    *instruction_pointer = *previous_ip;
    call_interrupt_vector(CPU_EXCEPTION_NP, false, true, code);
}

#[no_mangle]
pub unsafe fn trigger_ss(code: i32) {
    if DEBUG {
        if cpu_exception_hook(CPU_EXCEPTION_SS) {
            return;
        }
    }
    *prefixes = 0;
    *instruction_pointer = *previous_ip;
    call_interrupt_vector(CPU_EXCEPTION_SS, false, true, code);
}

#[no_mangle]
pub unsafe fn store_current_tsc() { *current_tsc = read_tsc(); }

pub unsafe fn handle_irqs() {
    if *flags & FLAG_INTERRUPT != 0 {
        pic_acknowledge()
    }
}
