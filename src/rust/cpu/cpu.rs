#![allow(non_upper_case_globals)]

extern "C" {
    fn cpu_exception_hook(interrupt: i32) -> bool;
    //fn logop(addr: i32, op: i32);
    fn microtick() -> f64;
    fn call_indirect1(f: i32, x: u16);
    fn pic_acknowledge();

    pub fn io_port_read8(port: i32) -> i32;
    pub fn io_port_read16(port: i32) -> i32;
    pub fn io_port_read32(port: i32) -> i32;

    pub fn io_port_write8(port: i32, value: i32);
    pub fn io_port_write16(port: i32, value: i32);
    pub fn io_port_write32(port: i32, value: i32);
}

use cpu::fpu::fpu_set_tag_word;
use cpu::global_pointers::*;
use cpu::memory;
use cpu::memory::mem8;
use cpu::memory::{
    in_mapped_range, read8, read16, read32s, read64s, read128, read_aligned32, write8,
    write_aligned32,
};
use cpu::misc_instr::{
    adjust_stack_reg, get_stack_pointer, getaf, getcf, getof, getpf, getsf, getzf, pop16, pop32s,
    push16, push32,
};
use cpu::modrm::{resolve_modrm16, resolve_modrm32};
use jit;
use jit::is_near_end_of_page;
use page::Page;
use paging::OrPageFault;
use profiler;
use profiler::stat::*;
use state_flags::CachedStateFlags;
pub use util::dbg_trace;

/// The offset for our generated functions in the wasm table. Every index less than this is
/// reserved for rustc's indirect functions
pub const WASM_TABLE_OFFSET: u32 = 1024;

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

/// Setting this to true will make execution extremely slow
pub const CHECK_MISSED_ENTRY_POINTS: bool = false;

pub const INTERPRETER_ITERATION_LIMIT: u32 = 100_001;

pub const FLAG_SUB: i32 = -0x8000_0000;
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
pub const CX: i32 = 1;
pub const DX: i32 = 2;
pub const BX: i32 = 3;
pub const SP: i32 = 4;
pub const BP: i32 = 5;
pub const SI: i32 = 6;
pub const DI: i32 = 7;

pub const AL: i32 = 0;
pub const CL: i32 = 1;
pub const DL: i32 = 2;
pub const BL: i32 = 3;
pub const AH: i32 = 4;
pub const CH: i32 = 5;
pub const DH: i32 = 6;
pub const BH: i32 = 7;

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

pub const TSR_BACKLINK: i32 = 0x00;
pub const TSR_CR3: i32 = 0x1C;
pub const TSR_EIP: i32 = 0x20;
pub const TSR_EFLAGS: i32 = 0x24;

pub const TSR_EAX: i32 = 0x28;
pub const TSR_ECX: i32 = 0x2c;
pub const TSR_EDX: i32 = 0x30;
pub const TSR_EBX: i32 = 0x34;
pub const TSR_ESP: i32 = 0x38;
pub const TSR_EBP: i32 = 0x3c;
pub const TSR_ESI: i32 = 0x40;
pub const TSR_EDI: i32 = 0x44;

pub const TSR_ES: i32 = 0x48;
pub const TSR_CS: i32 = 0x4c;
pub const TSR_SS: i32 = 0x50;
pub const TSR_DS: i32 = 0x54;
pub const TSR_FS: i32 = 0x58;
pub const TSR_GS: i32 = 0x5c;
pub const TSR_LDT: i32 = 0x60;

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
pub const MSR_TEST_CTRL: i32 = 0x33;
pub const MSR_IA32_FEAT_CTL: i32 = 0x3a;
pub const IA32_PAT: i32 = 0x277;
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
pub const IVT_SIZE: u32 = 0x400;
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

pub const LOOP_COUNTER: i32 = 100_003;
pub const TSC_RATE: f64 = 1_000_000.0;

pub static mut jit_block_boundary: bool = false;

pub static mut must_not_fault: bool = false;
pub static mut rdtsc_imprecision_offset: u64 = 0;
pub static mut rdtsc_last_value: u64 = 0;
pub static mut tsc_offset: u64 = 0;

pub static mut tlb_data: [i32; 0x400000] = [0; 0x400000];
pub static mut valid_tlb_entries: [i32; 10000] = [0; 10000];
pub static mut valid_tlb_entries_count: i32 = 0;

pub static mut in_jit: bool = false;

pub static mut jit_fault: Option<(i32, Option<i32>)> = None;

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

#[derive(Copy, Clone)]
pub struct SegmentSelector {
    raw: u16,
}

impl SegmentSelector {
    pub fn of_u16(raw: u16) -> SegmentSelector { SegmentSelector { raw } }
    pub fn rpl(&self) -> u8 { (self.raw & 3) as u8 }
    pub fn is_gdt(&self) -> bool { (self.raw & 4) == 0 }
    pub fn descriptor_offset(&self) -> u16 { (self.raw & !7) as u16 }

    pub fn is_null(&self) -> bool { self.is_gdt() && self.descriptor_offset() == 0 }
}

// Used to indicate early that the selector cannot be used to fetch a descriptor
#[derive(PartialEq)]
pub enum SelectorNullOrInvalid {
    IsNull,
    OutsideOfTableLimit,
}

pub struct SegmentDescriptor {
    pub raw: u64,
}

impl SegmentDescriptor {
    pub fn of_u64(raw: u64) -> SegmentDescriptor { SegmentDescriptor { raw } }
    pub fn base(&self) -> i32 {
        ((self.raw >> 16) & 0xffff | (self.raw & 0xff_00000000) >> 16 | (self.raw >> 56 << 24))
            as i32
    }
    pub fn limit(&self) -> u32 { (self.raw & 0xffff | ((self.raw >> 48) & 0xf) << 16) as u32 }
    pub fn access_byte(&self) -> u8 { ((self.raw >> 40) & 0xff) as u8 }
    pub fn flags(&self) -> u8 { ((self.raw >> 48 >> 4) & 0xf) as u8 }

    pub fn is_system(&self) -> bool { self.access_byte() & 0x10 == 0 }
    pub fn system_type(&self) -> u8 { self.access_byte() & 0xF }

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
        if self.flags() & 8 == 8 { self.limit() << 12 | 0xFFF } else { self.limit() }
    }
    pub fn set_busy(&self) -> SegmentDescriptor {
        SegmentDescriptor {
            raw: self.raw | 2 << 40,
        }
    }
}

pub struct InterruptDescriptor {
    raw: u64,
}

impl InterruptDescriptor {
    pub fn of_u64(raw: u64) -> InterruptDescriptor { InterruptDescriptor { raw } }
    pub fn offset(&self) -> i32 { (self.raw & 0xffff | self.raw >> 32 & 0xffff0000) as i32 }
    pub fn selector(&self) -> u16 { (self.raw >> 16 & 0xffff) as u16 }
    pub fn access_byte(&self) -> u8 { (self.raw >> 40 & 0xff) as u8 }
    pub fn dpl(&self) -> u8 { (self.access_byte() >> 5 & 3) as u8 }
    pub fn gate_type(&self) -> u8 { self.access_byte() & 7 }
    pub fn is_32(&self) -> bool { self.access_byte() & 8 == 8 }
    pub fn is_present(&self) -> bool { self.access_byte() & 0x80 == 0x80 }
    pub fn reserved_zeros_are_valid(&self) -> bool { self.access_byte() & 16 == 0 }

    const TASK_GATE: u8 = 0b101;
    const INTERRUPT_GATE: u8 = 0b110;
    const TRAP_GATE: u8 = 0b111;
}

pub unsafe fn switch_cs_real_mode(selector: i32) {
    dbg_assert!(!*protected_mode || vm86_mode());

    *sreg.offset(CS as isize) = selector as u16;
    *segment_is_null.offset(CS as isize) = false;
    *segment_offsets.offset(CS as isize) = selector << 4;
    update_cs_size(false);
}

pub unsafe fn get_tss_stack_addr(dpl: u8) -> OrPageFault<u32> {
    let (tss_stack_offset, page_boundary) = if *tss_size_32 {
        (((dpl << 3) + 4) as u32, 0x1000 - 6)
    }
    else {
        (((dpl << 2) + 2) as u32, 0x1000 - 4)
    };

    if tss_stack_offset + 5 > *segment_limits.offset(TR as isize) {
        panic!("#TS handler");
    }

    let tss_stack_addr = *segment_offsets.offset(TR as isize) as u32 + tss_stack_offset;

    dbg_assert!(tss_stack_addr & 0xFFF <= page_boundary);

    Ok(translate_address_system_read(tss_stack_addr as i32)?)
}

pub unsafe fn iret16() { iret(true); }
pub unsafe fn iret32() { iret(false); }

pub unsafe fn iret(is_16: bool) {
    if vm86_mode() && getiopl() < 3 {
        // vm86 mode, iopl != 3
        dbg_log!("#gp iret vm86 mode, iopl != 3");
        trigger_gp(0);
        return;
    }

    let (new_eip, new_cs, mut new_flags) = if is_16 {
        (
            return_on_pagefault!(safe_read16(get_stack_pointer(0))),
            return_on_pagefault!(safe_read16(get_stack_pointer(2))),
            return_on_pagefault!(safe_read16(get_stack_pointer(4))),
        )
    }
    else {
        (
            return_on_pagefault!(safe_read32s(get_stack_pointer(0))),
            return_on_pagefault!(safe_read16(get_stack_pointer(4))),
            return_on_pagefault!(safe_read32s(get_stack_pointer(8))),
        )
    };

    if !*protected_mode || (vm86_mode() && getiopl() == 3) {
        if new_eip as u32 & 0xFFFF0000 != 0 {
            panic!("#GP handler");
        }

        switch_cs_real_mode(new_cs);
        *instruction_pointer = get_seg_cs() + new_eip;

        if is_16 {
            update_eflags(new_flags | *flags & !0xFFFF);
            adjust_stack_reg(3 * 2);
        }
        else {
            if !*protected_mode {
                update_eflags((new_flags & 0x257FD5) | (*flags & 0x1A0000));
            }
            else {
                update_eflags(new_flags);
            }
            adjust_stack_reg(3 * 4);
        }

        handle_irqs();
        return;
    }

    dbg_assert!(!vm86_mode());

    if *flags & FLAG_NT != 0 {
        if DEBUG {
            panic!("NT");
        }
        trigger_gp(0);
        return;
    }

    if new_flags & FLAG_VM != 0 {
        if *cpl == 0 {
            // return to virtual 8086 mode

            // vm86 cannot be set in 16 bit flag
            dbg_assert!(!is_16);

            let temp_esp = return_on_pagefault!(safe_read32s(get_stack_pointer(12)));
            let temp_ss = return_on_pagefault!(safe_read16(get_stack_pointer(16)));

            let new_es = return_on_pagefault!(safe_read16(get_stack_pointer(20)));
            let new_ds = return_on_pagefault!(safe_read16(get_stack_pointer(24)));
            let new_fs = return_on_pagefault!(safe_read16(get_stack_pointer(28)));
            let new_gs = return_on_pagefault!(safe_read16(get_stack_pointer(32)));

            // no exceptions below

            update_eflags(new_flags);
            *flags |= FLAG_VM;

            switch_cs_real_mode(new_cs);
            *instruction_pointer = get_seg_cs() + (new_eip & 0xFFFF);

            if !switch_seg(ES, new_es)
                || !switch_seg(DS, new_ds)
                || !switch_seg(FS, new_fs)
                || !switch_seg(GS, new_gs)
            {
                // XXX: Should be checked before side effects
                dbg_assert!(false);
            }

            adjust_stack_reg(9 * 4); // 9 dwords: eip, cs, flags, esp, ss, es, ds, fs, gs

            write_reg32(ESP, temp_esp);
            if !switch_seg(SS, temp_ss) {
                // XXX
                dbg_assert!(false);
            }

            *cpl = 3;
            cpl_changed();

            update_cs_size(false);

            // iret end
            return;
        }
        else {
            dbg_log!("vm86 flag ignored because cpl != 0");
            new_flags &= !FLAG_VM;
        }
    }

    // protected mode return

    let cs_selector = SegmentSelector::of_u16(new_cs as u16);
    let cs_descriptor = match return_on_pagefault!(lookup_segment_selector(cs_selector)) {
        Ok((desc, _)) => desc,
        Err(selector_unusable) => match selector_unusable {
            SelectorNullOrInvalid::IsNull => {
                panic!("Unimplemented: CS selector is null");
            },
            SelectorNullOrInvalid::OutsideOfTableLimit => {
                panic!("Unimplemented: CS selector is invalid");
            },
        },
    };

    dbg_assert!(new_eip as u32 <= cs_descriptor.effective_limit());

    if !cs_descriptor.is_present() {
        panic!("not present");
    }
    if !cs_descriptor.is_executable() {
        panic!("not exec");
    }
    if cs_selector.rpl() < *cpl {
        panic!("rpl < cpl");
    }
    if cs_descriptor.is_dc() && cs_descriptor.dpl() > cs_selector.rpl() {
        panic!("conforming and dpl > rpl");
    }

    if !cs_descriptor.is_dc() && cs_selector.rpl() != cs_descriptor.dpl() {
        dbg_log!(
            "#gp iret: non-conforming cs and rpl != dpl, dpl={} rpl={}",
            cs_descriptor.dpl(),
            cs_selector.rpl()
        );
        trigger_gp(new_cs & !3);
        return;
    }

    if cs_selector.rpl() > *cpl {
        // outer privilege return
        let (temp_esp, temp_ss) = if is_16 {
            (
                return_on_pagefault!(safe_read16(get_stack_pointer(6))),
                return_on_pagefault!(safe_read16(get_stack_pointer(8))),
            )
        }
        else {
            (
                return_on_pagefault!(safe_read32s(get_stack_pointer(12))),
                return_on_pagefault!(safe_read16(get_stack_pointer(16))),
            )
        };

        let ss_selector = SegmentSelector::of_u16(temp_ss as u16);
        let ss_descriptor = match return_on_pagefault!(lookup_segment_selector(ss_selector)) {
            Ok((desc, _)) => desc,
            Err(selector_unusable) => match selector_unusable {
                SelectorNullOrInvalid::IsNull => {
                    dbg_log!("#GP for loading 0 in SS sel={:x}", temp_ss);
                    dbg_trace();
                    trigger_gp(0);
                    return;
                },
                SelectorNullOrInvalid::OutsideOfTableLimit => {
                    dbg_log!("#GP for loading invalid in SS sel={:x}", temp_ss);
                    trigger_gp(temp_ss & !3);
                    return;
                },
            },
        };
        let new_cpl = cs_selector.rpl();

        if ss_descriptor.is_system()
            || ss_selector.rpl() != new_cpl
            || !ss_descriptor.is_writable()
            || ss_descriptor.dpl() != new_cpl
        {
            dbg_log!("#GP for loading invalid in SS sel={:x}", temp_ss);
            dbg_trace();
            trigger_gp(temp_ss & !3);
            return;
        }

        if !ss_descriptor.is_present() {
            dbg_log!("#SS for loading non-present in SS sel={:x}", temp_ss);
            dbg_trace();
            trigger_ss(temp_ss & !3);
            return;
        }

        // no exceptions below

        if is_16 {
            update_eflags(new_flags | *flags & !0xFFFF);
        }
        else {
            update_eflags(new_flags);
        }

        *cpl = cs_selector.rpl();
        cpl_changed();

        if !switch_seg(SS, temp_ss) {
            // XXX
            dbg_assert!(false);
        }

        set_stack_reg(temp_esp);

        if *cpl == 0 && !is_16 {
            *flags = *flags & !FLAG_VIF & !FLAG_VIP | (new_flags & (FLAG_VIF | FLAG_VIP));
        }

    // XXX: Set segment to 0 if it's not usable in the new cpl
    // XXX: Use cached segment information
    // ...
    }
    else if cs_selector.rpl() == *cpl {
        // same privilege return
        // no exceptions below
        if is_16 {
            adjust_stack_reg(3 * 2);
            update_eflags(new_flags | *flags & !0xFFFF);
        }
        else {
            adjust_stack_reg(3 * 4);
            update_eflags(new_flags);
        }

        // update vip and vif, which are not changed by update_eflags
        if *cpl == 0 && !is_16 {
            *flags = *flags & !FLAG_VIF & !FLAG_VIP | (new_flags & (FLAG_VIF | FLAG_VIP));
        }
    }
    else {
        dbg_assert!(false);
    }

    *sreg.offset(CS as isize) = new_cs as u16;
    dbg_assert!((new_cs & 3) == *cpl as i32);

    update_cs_size(cs_descriptor.is_32());

    *segment_limits.offset(CS as isize) = cs_descriptor.effective_limit();
    *segment_offsets.offset(CS as isize) = cs_descriptor.base();

    *instruction_pointer = new_eip + get_seg_cs();

    // iret end

    handle_irqs();
}

pub unsafe fn call_interrupt_vector(
    interrupt_nr: i32,
    is_software_int: bool,
    error_code: Option<i32>,
) {
    // we have to leave hlt_loop at some point, this is a
    // good place to do it
    *in_hlt = false;

    if *protected_mode {
        if vm86_mode() && *cr.offset(4) & CR4_VME != 0 {
            panic!("Unimplemented: VME");
        }

        if vm86_mode() && is_software_int && getiopl() < 3 {
            dbg_log!("call_interrupt_vector #GP. vm86 && software int && iopl < 3");
            dbg_trace();
            trigger_gp(0);
            return;
        }

        if interrupt_nr << 3 | 7 > *idtr_size {
            dbg_log!("interrupt_nr={:x} idtr_size={:x}", interrupt_nr, *idtr_size);
            dbg_trace();
            panic!("Unimplemented: #GP handler");
        }

        let descriptor_address = return_on_pagefault!(translate_address_system_read(
            *idtr_offset + (interrupt_nr << 3)
        ));

        let descriptor = InterruptDescriptor::of_u64(read64s(descriptor_address) as u64);

        let mut offset = descriptor.offset();
        let selector = descriptor.selector() as i32;
        let dpl = descriptor.dpl();
        let gate_type = descriptor.gate_type();

        if !descriptor.is_present() {
            // present bit not set
            panic!("Unimplemented: #NP handler");
        }

        if is_software_int && dpl < *cpl {
            dbg_log!("#gp software interrupt ({:x}) and dpl < cpl", interrupt_nr);
            dbg_trace();
            trigger_gp(interrupt_nr << 3 | 2);
            return;
        }

        if gate_type == InterruptDescriptor::TASK_GATE {
            // task gate
            dbg_log!(
                "interrupt to task gate: int={:x} sel={:x} dpl={}",
                interrupt_nr,
                selector,
                dpl
            );
            dbg_trace();

            do_task_switch(selector, error_code);
            return;
        }

        let is_valid_type = gate_type == InterruptDescriptor::TRAP_GATE
            || gate_type == InterruptDescriptor::INTERRUPT_GATE;

        if !is_valid_type || !descriptor.reserved_zeros_are_valid() {
            // invalid gate_type
            dbg_log!(
                "gate type invalid or reserved 0s violated. gate_type=0b{:b} raw={:b}",
                gate_type,
                descriptor.raw
            );
            dbg_log!(
                "addr={:x} offset={:x} selector={:x}",
                descriptor_address,
                offset,
                selector
            );
            dbg_trace();
            panic!("Unimplemented: #GP handler");
        }

        let cs_segment_descriptor = match return_on_pagefault!(lookup_segment_selector(
            SegmentSelector::of_u16(selector as u16)
        )) {
            Ok((desc, _)) => desc,
            Err(selector_unusable) => match selector_unusable {
                SelectorNullOrInvalid::IsNull => {
                    dbg_log!("is null");
                    panic!("Unimplemented: #GP handler");
                },
                SelectorNullOrInvalid::OutsideOfTableLimit => {
                    dbg_log!("is invalid");
                    panic!("Unimplemented: #GP handler (error code)");
                },
            },
        };

        dbg_assert!(offset as u32 <= cs_segment_descriptor.effective_limit());

        if !cs_segment_descriptor.is_executable() || cs_segment_descriptor.dpl() > *cpl {
            dbg_log!("not exec");
            panic!("Unimplemented: #GP handler");
        }
        if !cs_segment_descriptor.is_present() {
            // kvm-unit-test
            dbg_log!("not present");
            trigger_np(interrupt_nr << 3 | 2);
            return;
        }

        let old_flags = get_eflags();

        if !cs_segment_descriptor.is_dc() && cs_segment_descriptor.dpl() < *cpl {
            // inter privilege level interrupt
            // interrupt from vm86 mode

            if old_flags & FLAG_VM != 0 && cs_segment_descriptor.dpl() != 0 {
                panic!("Unimplemented: #GP handler for non-0 cs segment dpl when in vm86 mode");
            }

            let tss_stack_addr =
                return_on_pagefault!(get_tss_stack_addr(cs_segment_descriptor.dpl()));

            let new_esp = read32s(tss_stack_addr);
            let new_ss = read16(tss_stack_addr + if *tss_size_32 { 4 } else { 2 });
            let ss_segment_selector = SegmentSelector::of_u16(new_ss as u16);
            let ss_segment_descriptor =
                match return_on_pagefault!(lookup_segment_selector(ss_segment_selector)) {
                    Ok((desc, _)) => desc,
                    Err(_) => {
                        panic!("Unimplemented: #TS handler");
                    },
                };

            // Disabled: Incorrect handling of direction bit
            // See http://css.csail.mit.edu/6.858/2014/readings/i386/s06_03.htm
            //if !((new_esp >>> 0) <= ss_segment_descriptor.effective_limit())
            //    debugger;
            //dbg_assert!((new_esp >>> 0) <= ss_segment_descriptor.effective_limit());
            dbg_assert!(!ss_segment_descriptor.is_system() && ss_segment_descriptor.is_writable());

            if ss_segment_selector.rpl() != cs_segment_descriptor.dpl() {
                panic!("Unimplemented: #TS handler");
            }
            if ss_segment_descriptor.dpl() != cs_segment_descriptor.dpl()
                || !ss_segment_descriptor.is_rw()
            {
                panic!("Unimplemented: #TS handler");
            }
            if !ss_segment_descriptor.is_present() {
                panic!("Unimplemented: #TS handler");
            }

            let old_esp = read_reg32(ESP);
            let old_ss = *sreg.offset(SS as isize) as i32;

            let error_code_space = if error_code.is_some() { 1 } else { 0 };
            let vm86_space = if (old_flags & FLAG_VM) == FLAG_VM { 4 } else { 0 };
            let bytes_per_arg = if descriptor.is_32() { 4 } else { 2 };

            let stack_space = bytes_per_arg * (5 + error_code_space + vm86_space);
            let new_stack_pointer = ss_segment_descriptor.base()
                + if ss_segment_descriptor.is_32() {
                    new_esp - stack_space
                }
                else {
                    new_esp - stack_space & 0xFFFF
                };

            return_on_pagefault!(translate_address_system_write(new_stack_pointer));
            return_on_pagefault!(translate_address_system_write(
                ss_segment_descriptor.base() + new_esp - 1
            ));

            // no exceptions below
            *cpl = cs_segment_descriptor.dpl();
            cpl_changed();

            update_cs_size(cs_segment_descriptor.is_32());

            *flags &= !FLAG_VM & !FLAG_RF;

            if !switch_seg(SS, new_ss) {
                // XXX
                dbg_assert!(false);
            }
            set_stack_reg(new_esp);

            // XXX: #SS if stack would cross stack limit

            if old_flags & FLAG_VM != 0 {
                if !descriptor.is_32() {
                    dbg_assert!(false);
                }
                else {
                    push32(*sreg.offset(GS as isize) as i32).unwrap();
                    push32(*sreg.offset(FS as isize) as i32).unwrap();
                    push32(*sreg.offset(DS as isize) as i32).unwrap();
                    push32(*sreg.offset(ES as isize) as i32).unwrap();
                }
            }

            if descriptor.is_32() {
                push32(old_ss).unwrap();
                push32(old_esp).unwrap();
            }
            else {
                push16(old_ss).unwrap();
                push16(old_esp).unwrap();
            }
        }
        else if cs_segment_descriptor.is_dc() || cs_segment_descriptor.dpl() == *cpl {
            // intra privilege level interrupt

            //dbg_log!("Intra privilege interrupt gate=" + h(selector, 4) + ":" + h(offset >>> 0, 8) +
            //        " gate_type=" + gate_type + " 16bit=" + descriptor.is_32() +
            //        " cpl=" + *cpl + " dpl=" + segment_descriptor.dpl() + " conforming=" + +segment_descriptor.is_dc(), );
            //debug.dump_regs_short();

            if *flags & FLAG_VM != 0 {
                dbg_assert!(false, "check error code");
                trigger_gp(selector & !3);
                return;
            }

            let bytes_per_arg = if descriptor.is_32() { 4 } else { 2 };
            let error_code_space = if error_code.is_some() { 1 } else { 0 };

            let stack_space = bytes_per_arg * (3 + error_code_space);

            // XXX: with current cpl or with cpl 0?
            return_on_pagefault!(writable_or_pagefault(
                get_stack_pointer(-stack_space),
                stack_space
            ));

        // no exceptions below
        }
        else {
            panic!("Unimplemented: #GP handler");
        }

        // XXX: #SS if stack would cross stack limit
        if descriptor.is_32() {
            push32(old_flags).unwrap();
            push32(*sreg.offset(CS as isize) as i32).unwrap();
            push32(get_real_eip()).unwrap();

            if let Some(ec) = error_code {
                push32(ec).unwrap();
            }
        }
        else {
            push16(old_flags).unwrap();
            push16(*sreg.offset(CS as isize) as i32).unwrap();
            push16(get_real_eip()).unwrap();

            if let Some(ec) = error_code {
                push16(ec).unwrap();
            }

            offset &= 0xFFFF;
        }

        if old_flags & FLAG_VM != 0 {
            if !switch_seg(GS, 0) || !switch_seg(FS, 0) || !switch_seg(DS, 0) || !switch_seg(ES, 0)
            {
                // can't fail
                dbg_assert!(false);
            }
        }

        *sreg.offset(CS as isize) = (selector as u16) & !3 | *cpl as u16;
        dbg_assert!((*sreg.offset(CS as isize) & 3) == *cpl as u16);

        update_cs_size(cs_segment_descriptor.is_32());

        *segment_limits.offset(CS as isize) = cs_segment_descriptor.effective_limit();
        *segment_offsets.offset(CS as isize) = cs_segment_descriptor.base();

        *instruction_pointer = get_seg_cs() + offset;

        *flags &= !FLAG_NT & !FLAG_VM & !FLAG_RF & !FLAG_TRAP;

        if gate_type == InterruptDescriptor::INTERRUPT_GATE {
            // clear int flag for interrupt gates
            *flags &= !FLAG_INTERRUPT;
        }
        else {
            if *flags & FLAG_INTERRUPT != 0 && old_flags & FLAG_INTERRUPT == 0 {
                handle_irqs();
            }
        }
    }
    else {
        // call 4 byte cs:ip interrupt vector from ivt at cpu.memory 0

        let index = (interrupt_nr << 2) as u32;
        let new_ip = read16(index);
        let new_cs = read16(index + 2);

        dbg_assert!(
            index | 3 <= IVT_SIZE,
            "Unimplemented: #GP for interrupt number out of IVT bounds"
        );

        // XXX: #SS if stack would cross stack limit

        // push flags, cs:ip
        push16(get_eflags()).unwrap();
        push16(*sreg.offset(CS as isize) as i32).unwrap();
        push16(get_real_eip()).unwrap();

        *flags &= !FLAG_INTERRUPT & !FLAG_AC & !FLAG_TRAP;

        switch_cs_real_mode(new_cs);
        *instruction_pointer = get_seg_cs() + new_ip;
    }
}

pub unsafe fn far_jump(eip: i32, selector: i32, is_call: bool, is_osize_32: bool) {
    dbg_assert!(selector < 0x10000 && selector >= 0);

    //dbg_log("far " + ["jump", "call"][+is_call] + " eip=" + h(eip >>> 0, 8) + " cs=" + h(selector, 4), LOG_CPU);
    //CPU_LOG_VERBOSE && this.debug.dump_state("far " + ["jump", "call"][+is_call]);

    if !*protected_mode || vm86_mode() {
        if is_call {
            if is_osize_32 {
                return_on_pagefault!(writable_or_pagefault(get_stack_pointer(-8), 8));

                push32(*sreg.offset(CS as isize) as i32).unwrap();
                push32(get_real_eip()).unwrap();
            }
            else {
                return_on_pagefault!(writable_or_pagefault(get_stack_pointer(-4), 4));

                push16(*sreg.offset(CS as isize) as i32).unwrap();
                push16(get_real_eip()).unwrap();
            }
        }
        switch_cs_real_mode(selector);
        *instruction_pointer = get_seg_cs() + eip;
        return;
    }

    let cs_selector = SegmentSelector::of_u16(selector as u16);
    let info = match return_on_pagefault!(lookup_segment_selector(cs_selector)) {
        Ok((desc, _)) => desc,
        Err(selector_unusable) => match selector_unusable {
            SelectorNullOrInvalid::IsNull => {
                dbg_log!("#gp null cs");
                trigger_gp(0);
                return;
            },
            SelectorNullOrInvalid::OutsideOfTableLimit => {
                dbg_log!("#gp invalid cs: {:x}", selector);
                trigger_gp(selector & !3);
                return;
            },
        },
    };

    if info.is_system() {
        dbg_assert!(is_call, "TODO: Jump");

        dbg_log!("system type cs: {:x}", selector);

        if info.system_type() == 0xC || info.system_type() == 4 {
            // call gate
            let is_16 = info.system_type() == 4;

            if info.dpl() < *cpl || info.dpl() < cs_selector.rpl() {
                dbg_log!("#gp cs gate dpl < cpl or dpl < rpl: {:x}", selector);
                trigger_gp(selector & !3);
                return;
            }

            if !info.is_present() {
                dbg_log!("#NP for loading not-present in gate cs sel={:x}", selector);
                trigger_np(selector & !3);
                return;
            }

            let cs_selector = (info.raw >> 16) as i32;

            let cs_info = match return_on_pagefault!(lookup_segment_selector(
                SegmentSelector::of_u16(cs_selector as u16)
            )) {
                Ok((desc, _)) => desc,
                Err(selector_unusable) => match selector_unusable {
                    SelectorNullOrInvalid::IsNull => {
                        dbg_log!("#gp null cs");
                        trigger_gp(0);
                        return;
                    },
                    SelectorNullOrInvalid::OutsideOfTableLimit => {
                        dbg_log!("#gp invalid cs: {:x}", selector);
                        trigger_gp(selector & !3);
                        return;
                    },
                },
            };

            if !cs_info.is_executable() {
                dbg_log!("#gp non-executable cs: {:x}", cs_selector);
                trigger_gp(cs_selector & !3);
                return;
            }

            if cs_info.dpl() > *cpl {
                dbg_log!("#gp dpl > cpl: {:x}", cs_selector);
                trigger_gp(cs_selector & !3);
                return;
            }

            if !cs_info.is_present() {
                dbg_log!("#NP for loading not-present in cs sel={:x}", cs_selector);
                trigger_np(cs_selector & !3);
                return;
            }

            if !cs_info.is_dc() && cs_info.dpl() < *cpl {
                dbg_log!(
                    "more privilege call gate is_16={} from={} to={}",
                    is_16,
                    *cpl,
                    cs_info.dpl()
                );
                let tss_stack_addr = return_on_pagefault!(get_tss_stack_addr(cs_info.dpl()));

                let new_esp;
                let new_ss;
                if *tss_size_32 {
                    new_esp = read32s(tss_stack_addr);
                    new_ss = read16(tss_stack_addr + 4);
                }
                else {
                    new_esp = read16(tss_stack_addr);
                    new_ss = read16(tss_stack_addr + 2);
                }

                let ss_selector = SegmentSelector::of_u16(new_ss as u16);
                let ss_info = match return_on_pagefault!(lookup_segment_selector(ss_selector)) {
                    Ok((desc, _)) => desc,
                    Err(selector_unusable) => match selector_unusable {
                        SelectorNullOrInvalid::IsNull => {
                            panic!("null ss: {}", new_ss);
                        },
                        SelectorNullOrInvalid::OutsideOfTableLimit => {
                            panic!("invalid ss: {}", new_ss);
                        },
                    },
                };

                // Disabled: Incorrect handling of direction bit
                // See http://css.csail.mit.edu/6.858/2014/readings/i386/s06_03.htm
                //if(!((new_esp >>> 0) <= ss_info.effective_limit))
                //    debugger;
                //dbg_assert!((new_esp >>> 0) <= ss_info.effective_limit);
                dbg_assert!(!ss_info.is_system() && ss_info.is_writable());

                if ss_selector.rpl() != cs_info.dpl()
                // xxx: 0 in v86 mode
                {
                    panic!("#TS handler");
                }
                if ss_info.dpl() != cs_info.dpl() || !ss_info.is_writable() {
                    panic!("#TS handler");
                }
                if !ss_info.is_present() {
                    panic!("#SS handler");
                }

                let parameter_count = (info.raw >> 32 & 0x1F) as i32;
                let mut stack_space = if is_16 { 4 } else { 8 };
                if is_call {
                    stack_space +=
                        if is_16 { 4 + 2 * parameter_count } else { 8 + 4 * parameter_count };
                }
                if ss_info.is_32() {
                    return_on_pagefault!(writable_or_pagefault(
                        ss_info.base() + new_esp - stack_space,
                        stack_space
                    )); // , cs_info.dpl
                }
                else {
                    return_on_pagefault!(writable_or_pagefault(
                        ss_info.base() + (new_esp - stack_space & 0xFFFF),
                        stack_space
                    )); // , cs_info.dpl
                }

                let old_esp = read_reg32(ESP);
                let old_ss = *sreg.offset(SS as isize);
                let old_stack_pointer = get_stack_pointer(0);

                //dbg_log!("old_esp=" + h(old_esp));

                *cpl = cs_info.dpl();
                cpl_changed();

                update_cs_size(cs_info.is_32());

                // XXX: Should be checked before side effects
                if !switch_seg(SS, new_ss) {
                    dbg_assert!(false)
                };
                set_stack_reg(new_esp);

                //dbg_log!("parameter_count=" + parameter_count);
                //dbg_assert!(parameter_count == 0, "TODO");

                if is_16 {
                    push16(old_ss as i32).unwrap();
                    push16(old_esp).unwrap();
                }
                else {
                    push32(old_ss as i32).unwrap();
                    push32(old_esp).unwrap();
                }

                if is_call {
                    if is_16 {
                        for i in (0..parameter_count).rev() {
                            //for(let i = parameter_count - 1; i >= 0; i--)
                            let parameter = safe_read16(old_stack_pointer + 2 * i).unwrap();
                            push16(parameter).unwrap();
                        }

                        //writable_or_pagefault(get_stack_pointer(-4), 4);
                        push16(*sreg.offset(CS as isize) as i32).unwrap();
                        push16(get_real_eip()).unwrap();
                    }
                    else {
                        for i in (0..parameter_count).rev() {
                            //for(let i = parameter_count - 1; i >= 0; i--)
                            let parameter = safe_read32s(old_stack_pointer + 4 * i).unwrap();
                            push32(parameter).unwrap();
                        }

                        //writable_or_pagefault(get_stack_pointer(-8), 8);
                        push32(*sreg.offset(CS as isize) as i32).unwrap();
                        push32(get_real_eip()).unwrap();
                    }
                }
            }
            else {
                dbg_log!(
                    "same privilege call gate is_16={} from={} to={} conforming={}",
                    is_16,
                    *cpl,
                    cs_info.dpl(),
                    cs_info.is_dc()
                );
                // ok

                if is_call {
                    if is_16 {
                        return_on_pagefault!(writable_or_pagefault(get_stack_pointer(-4), 4));

                        push16(*sreg.offset(CS as isize) as i32).unwrap();
                        push16(get_real_eip()).unwrap();
                    }
                    else {
                        return_on_pagefault!(writable_or_pagefault(get_stack_pointer(-8), 8));

                        push32(*sreg.offset(CS as isize) as i32).unwrap();
                        push32(get_real_eip()).unwrap();
                    }
                }
            }

            // Note: eip from call is ignored
            let mut new_eip = (info.raw & 0xFFFF) as i32;
            if !is_16 {
                new_eip |= ((info.raw >> 32) & 0xFFFF0000) as i32;
            }

            dbg_log!(
                "call gate eip={:x} cs={:x} conforming={}",
                new_eip as u32,
                cs_selector,
                cs_info.is_dc()
            );
            dbg_assert!((new_eip as u32) <= cs_info.effective_limit(), "todo: #gp");

            update_cs_size(cs_info.is_32());

            *segment_is_null.offset(CS as isize) = false;
            *segment_limits.offset(CS as isize) = cs_info.effective_limit();
            *segment_offsets.offset(CS as isize) = cs_info.base();
            *sreg.offset(CS as isize) = cs_selector as u16 & !3 | *cpl as u16;
            dbg_assert!(*sreg.offset(CS as isize) & 3 == *cpl as u16);

            *instruction_pointer = get_seg_cs() + new_eip;
        }
        else {
            dbg_assert!(false);
            //let types = { 9: "Available 386 TSS", 0xb: "Busy 386 TSS", 4: "286 Call Gate", 0xc: "386 Call Gate" };
            //throw debug.unimpl("load system segment descriptor, type = " + (info.access & 15) + " (" + types[info.access & 15] + ")");
        }
    }
    else {
        if !info.is_executable() {
            dbg_log!("#gp non-executable cs: {:x}", selector);
            trigger_gp(selector & !3);
            return;
        }

        if info.is_dc() {
            // conforming code segment
            if info.dpl() > *cpl {
                dbg_log!("#gp cs dpl > cpl: {:x}", selector);
                trigger_gp(selector & !3);
                return;
            }
        }
        else {
            // non-conforming code segment

            if cs_selector.rpl() > *cpl || info.dpl() != *cpl {
                dbg_log!("#gp cs rpl > cpl or dpl != cpl: {:x}", selector);
                trigger_gp(selector & !3);
                return;
            }
        }

        if !info.is_present() {
            dbg_log!("#NP for loading not-present in cs sel={:x}", selector);
            dbg_trace();
            trigger_np(selector & !3);
            return;
        }

        if is_call {
            if is_osize_32 {
                return_on_pagefault!(writable_or_pagefault(get_stack_pointer(-8), 8));

                push32(*sreg.offset(CS as isize) as i32).unwrap();
                push32(get_real_eip()).unwrap();
            }
            else {
                return_on_pagefault!(writable_or_pagefault(get_stack_pointer(-4), 4));

                push16(*sreg.offset(CS as isize) as i32).unwrap();
                push16(get_real_eip()).unwrap();
            }
        }

        dbg_assert!((eip as u32) <= info.effective_limit(), "todo: #gp");

        update_cs_size(info.is_32());

        *segment_is_null.offset(CS as isize) = false;
        *segment_limits.offset(CS as isize) = info.effective_limit();

        *segment_offsets.offset(CS as isize) = info.base();
        *sreg.offset(CS as isize) = selector as u16 & !3 | *cpl as u16;

        *instruction_pointer = get_seg_cs() + eip;
    }

    //dbg_log!("far " + ["jump", "call"][+is_call] + " to:", LOG_CPU)
    //CPU_LOG_VERBOSE && debug.dump_state("far " + ["jump", "call"][+is_call] + " end");
}

pub unsafe fn far_return(eip: i32, selector: i32, stack_adjust: i32, is_osize_32: bool) {
    dbg_assert!(selector < 0x10000 && selector >= 0);

    //dbg_log("far return eip=" + h(eip >>> 0, 8) + " cs=" + h(selector, 4) + " stack_adjust=" + h(stack_adjust), LOG_CPU);
    //CPU_LOG_VERBOSE && this.debug.dump_state("far ret start");

    if !*protected_mode {
        dbg_assert!(!*is_32);
        //dbg_assert(!this.stack_size_32[0]);
    }

    if !*protected_mode || vm86_mode() {
        switch_cs_real_mode(selector);
        *instruction_pointer = get_seg_cs() + eip;
        adjust_stack_reg(2 * (if is_osize_32 { 4 } else { 2 }) + stack_adjust);
        return;
    }

    let cs_selector = SegmentSelector::of_u16(selector as u16);
    let info = match return_on_pagefault!(lookup_segment_selector(cs_selector)) {
        Ok((desc, _)) => desc,
        Err(selector_unusable) => match selector_unusable {
            SelectorNullOrInvalid::IsNull => {
                dbg_log!("far return: #gp null cs");
                trigger_gp(0);
                return;
            },
            SelectorNullOrInvalid::OutsideOfTableLimit => {
                dbg_log!("far return: #gp invalid cs: {:x}", selector);
                trigger_gp(selector & !3);
                return;
            },
        },
    };

    if info.is_system() {
        dbg_assert!(false, "is system in far return");
        trigger_gp(selector & !3);
        return;
    }

    if !info.is_executable() {
        dbg_log!("non-executable cs: {:x}", selector);
        trigger_gp(selector & !3);
        return;
    }

    if cs_selector.rpl() < *cpl {
        dbg_log!("cs rpl < cpl: {:x}", selector);
        trigger_gp(selector & !3);
        return;
    }

    if info.is_dc() && info.dpl() > cs_selector.rpl() {
        dbg_log!("cs conforming and dpl > rpl: {:x}", selector);
        trigger_gp(selector & !3);
        return;
    }

    if !info.is_dc() && info.dpl() != cs_selector.rpl() {
        dbg_log!("cs non-conforming and dpl != rpl: {:x}", selector);
        trigger_gp(selector & !3);
        return;
    }

    if !info.is_present() {
        dbg_log!("#NP for loading not-present in cs sel={:x}", selector);
        dbg_trace();
        trigger_np(selector & !3);
        return;
    }

    if cs_selector.rpl() > *cpl {
        dbg_log!(
            "far return privilege change cs: {:x} from={} to={} is_16={}",
            selector,
            *cpl,
            cs_selector.rpl(),
            is_osize_32
        );

        let temp_esp;
        let temp_ss;
        if is_osize_32 {
            //dbg_log!("esp read from " + h(translate_address_system_read(get_stack_pointer(stack_adjust + 8))))
            temp_esp = safe_read32s(get_stack_pointer(stack_adjust + 8)).unwrap();
            //dbg_log!("esp=" + h(temp_esp));
            temp_ss = safe_read16(get_stack_pointer(stack_adjust + 12)).unwrap();
        }
        else {
            //dbg_log!("esp read from " + h(translate_address_system_read(get_stack_pointer(stack_adjust + 4))));
            temp_esp = safe_read16(get_stack_pointer(stack_adjust + 4)).unwrap();
            //dbg_log!("esp=" + h(temp_esp));
            temp_ss = safe_read16(get_stack_pointer(stack_adjust + 6)).unwrap();
        }

        *cpl = cs_selector.rpl();
        cpl_changed();

        // XXX: This failure should be checked before side effects
        if !switch_seg(SS, temp_ss) {
            dbg_assert!(false);
        }
        set_stack_reg(temp_esp + stack_adjust);

    //if(is_osize_32)
    //{
    //    adjust_stack_reg(2 * 4);
    //}
    //else
    //{
    //    adjust_stack_reg(2 * 2);
    //}

    //throw debug.unimpl("privilege change");

    //adjust_stack_reg(stack_adjust);
    }
    else {
        if is_osize_32 {
            adjust_stack_reg(2 * 4 + stack_adjust);
        }
        else {
            adjust_stack_reg(2 * 2 + stack_adjust);
        }
    }

    //dbg_assert(*cpl == info.dpl);

    update_cs_size(info.is_32());

    *segment_is_null.offset(CS as isize) = false;
    *segment_limits.offset(CS as isize) = info.effective_limit();

    *segment_offsets.offset(CS as isize) = info.base();
    *sreg.offset(CS as isize) = selector as u16;
    dbg_assert!(selector & 3 == *cpl as i32);

    *instruction_pointer = get_seg_cs() + eip;

    //dbg_log("far return to:", LOG_CPU)
    //CPU_LOG_VERBOSE && debug.dump_state("far ret end");
}

pub unsafe fn do_task_switch(selector: i32, error_code: Option<i32>) {
    dbg_log!("do_task_switch sel={:x}", selector);

    dbg_assert!(*tss_size_32, "TODO: 16-bit TSS in task switch");

    let selector = SegmentSelector::of_u16(selector as u16);
    let (descriptor, descriptor_address) =
        match lookup_segment_selector(selector).expect("TODO: handle pagefault") {
            Ok(desc) => desc,
            Err(_) => {
                panic!("#GP handler");
            },
        };

    dbg_assert!(selector.is_gdt());
    dbg_assert!((descriptor.system_type() & !2) == 1 || (descriptor.system_type() & !2) == 9);
    let tss_is_16 = descriptor.system_type() <= 3;
    let tss_is_busy = (descriptor.system_type() & 2) == 2;

    if (descriptor.system_type() & 2) == 2 {
        // is busy
        panic!("#GP handler");
    }

    if !descriptor.is_present() {
        panic!("#NP handler");
    }

    if descriptor.effective_limit() < 103 {
        panic!("#NP handler");
    }

    let _tsr_size = *segment_limits.offset(TR as isize);
    let tsr_offset = *segment_offsets.offset(TR as isize);

    let mut old_eflags = get_eflags();

    if tss_is_busy {
        old_eflags &= !FLAG_NT;
    }

    writable_or_pagefault(tsr_offset, 0x66).unwrap();

    //safe_write32(tsr_offset + TSR_CR3, *cr.offset(3));

    // TODO: Write 16 bit values if old tss is 16 bit
    safe_write32(tsr_offset + TSR_EIP, get_real_eip()).unwrap();
    safe_write32(tsr_offset + TSR_EFLAGS, old_eflags).unwrap();

    safe_write32(tsr_offset + TSR_EAX, read_reg32(EAX)).unwrap();
    safe_write32(tsr_offset + TSR_ECX, read_reg32(ECX)).unwrap();
    safe_write32(tsr_offset + TSR_EDX, read_reg32(EDX)).unwrap();
    safe_write32(tsr_offset + TSR_EBX, read_reg32(EBX)).unwrap();

    safe_write32(tsr_offset + TSR_ESP, read_reg32(ESP)).unwrap();
    safe_write32(tsr_offset + TSR_EBP, read_reg32(EBP)).unwrap();
    safe_write32(tsr_offset + TSR_ESI, read_reg32(ESI)).unwrap();
    safe_write32(tsr_offset + TSR_EDI, read_reg32(EDI)).unwrap();

    safe_write32(tsr_offset + TSR_ES, *sreg.offset(ES as isize) as i32).unwrap();
    safe_write32(tsr_offset + TSR_CS, *sreg.offset(CS as isize) as i32).unwrap();
    safe_write32(tsr_offset + TSR_SS, *sreg.offset(SS as isize) as i32).unwrap();
    safe_write32(tsr_offset + TSR_DS, *sreg.offset(DS as isize) as i32).unwrap();
    safe_write32(tsr_offset + TSR_FS, *sreg.offset(FS as isize) as i32).unwrap();
    safe_write32(tsr_offset + TSR_GS, *sreg.offset(GS as isize) as i32).unwrap();

    //safe_write32(tsr_offset + TSR_LDT, *sreg.offset(reg_ldtr));

    if true
    /* is jump or call or int */
    {
        safe_write64(descriptor_address, descriptor.set_busy().raw).unwrap();
    }

    //let new_tsr_size = descriptor.effective_limit;
    let new_tsr_offset = descriptor.base();

    dbg_assert!(!tss_is_16, "unimplemented");

    if true
    /* is call or int */
    {
        safe_write16(
            new_tsr_offset + TSR_BACKLINK,
            *sreg.offset(TR as isize) as i32,
        )
        .unwrap();
    }

    let new_cr3 = safe_read32s(new_tsr_offset + TSR_CR3).unwrap();

    *flags &= !FLAG_VM;

    let new_eip = safe_read32s(new_tsr_offset + TSR_EIP).unwrap();
    let new_cs = safe_read16(new_tsr_offset + TSR_CS).unwrap();
    let new_cs_selector = SegmentSelector::of_u16(new_cs as u16);
    let new_cs_descriptor =
        match lookup_segment_selector(new_cs_selector).expect("TODO: handle pagefault") {
            Ok((desc, _)) => desc,
            Err(SelectorNullOrInvalid::IsNull) => {
                dbg_log!("null cs");
                panic!("#TS handler");
            },
            Err(SelectorNullOrInvalid::OutsideOfTableLimit) => {
                dbg_log!("invalid cs: {:x}", new_cs);
                panic!("#TS handler");
            },
        };

    if new_cs_descriptor.is_system() {
        panic!("#TS handler");
    }

    if !new_cs_descriptor.is_executable() {
        panic!("#TS handler");
    }

    if new_cs_descriptor.is_dc() && new_cs_descriptor.dpl() > new_cs_selector.rpl() {
        dbg_log!("cs conforming and dpl > rpl: {:x}", selector.raw);
        panic!("#TS handler");
    }

    if !new_cs_descriptor.is_dc() && new_cs_descriptor.dpl() != new_cs_selector.rpl() {
        dbg_log!("cs non-conforming and dpl != rpl: {:x}", selector.raw);
        panic!("#TS handler");
    }

    if !new_cs_descriptor.is_present() {
        dbg_log!("#NP for loading not-present in cs sel={:x}", selector.raw);
        panic!("#TS handler");
    }

    *segment_is_null.offset(CS as isize) = false;
    *segment_limits.offset(CS as isize) = new_cs_descriptor.effective_limit();
    *segment_offsets.offset(CS as isize) = new_cs_descriptor.base();
    *sreg.offset(CS as isize) = new_cs as u16;

    *cpl = new_cs_descriptor.dpl();
    cpl_changed();

    dbg_assert!((*sreg.offset(CS as isize) & 3) as u8 == *cpl);

    dbg_assert!(
        new_eip as u32 <= new_cs_descriptor.effective_limit(),
        "todo: #gp"
    );
    update_cs_size(new_cs_descriptor.is_32());

    let mut new_eflags = safe_read32s(new_tsr_offset + TSR_EFLAGS).unwrap();

    if true
    /* is call or int */
    {
        safe_write32(tsr_offset + TSR_BACKLINK, selector.raw as i32).unwrap();
        new_eflags |= FLAG_NT;
    }

    if new_eflags & FLAG_VM != 0 {
        panic!("task switch to VM mode");
    }

    update_eflags(new_eflags);

    if true
    /* call or int */
    {
        *flags |= FLAG_NT;
    }

    let new_ldt = safe_read16(new_tsr_offset + TSR_LDT).unwrap();
    load_ldt(new_ldt).unwrap();

    write_reg32(EAX, safe_read32s(new_tsr_offset + TSR_EAX).unwrap());
    write_reg32(ECX, safe_read32s(new_tsr_offset + TSR_ECX).unwrap());
    write_reg32(EDX, safe_read32s(new_tsr_offset + TSR_EDX).unwrap());
    write_reg32(EBX, safe_read32s(new_tsr_offset + TSR_EBX).unwrap());

    write_reg32(ESP, safe_read32s(new_tsr_offset + TSR_ESP).unwrap());
    write_reg32(EBP, safe_read32s(new_tsr_offset + TSR_EBP).unwrap());
    write_reg32(ESI, safe_read32s(new_tsr_offset + TSR_ESI).unwrap());
    write_reg32(EDI, safe_read32s(new_tsr_offset + TSR_EDI).unwrap());

    if !switch_seg(ES, safe_read16(new_tsr_offset + TSR_ES).unwrap())
        || !switch_seg(SS, safe_read16(new_tsr_offset + TSR_SS).unwrap())
        || !switch_seg(DS, safe_read16(new_tsr_offset + TSR_DS).unwrap())
        || !switch_seg(FS, safe_read16(new_tsr_offset + TSR_FS).unwrap())
        || !switch_seg(GS, safe_read16(new_tsr_offset + TSR_GS).unwrap())
    {
        // XXX: Should be checked before side effects
        dbg_assert!(false);
    }

    *instruction_pointer = get_seg_cs() + new_eip;

    *segment_offsets.offset(TR as isize) = descriptor.base();
    *segment_limits.offset(TR as isize) = descriptor.effective_limit();
    *sreg.offset(TR as isize) = selector.raw;

    *cr.offset(3) = new_cr3;
    dbg_assert!((*cr.offset(3) & 0xFFF) == 0);
    clear_tlb();

    *cr.offset(0) |= CR0_TS;

    if let Some(error_code) = error_code {
        if tss_is_16 {
            push16(error_code & 0xFFFF).unwrap();
        }
        else {
            push32(error_code).unwrap();
        }
    }
}

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

#[no_mangle]
pub unsafe fn get_eflags_no_arith() -> i32 { return *flags; }

pub fn translate_address_read_no_side_effects(address: i32) -> Option<u32> {
    let entry = unsafe { tlb_data[(address as u32 >> 12) as usize] };
    let user = unsafe { *cpl } == 3;
    if entry & (TLB_VALID | if user { TLB_NO_USER } else { 0 }) == TLB_VALID {
        Some((entry & !0xFFF ^ address) as u32)
    }
    else {
        match unsafe { do_page_walk(address, false, user, false) } {
            Ok(phys_addr_high) => Some((phys_addr_high | address & 0xFFF) as u32),
            Err(_pagefault) => None,
        }
    }
}

pub fn translate_address_read(address: i32) -> OrPageFault<u32> {
    let entry = unsafe { tlb_data[(address as u32 >> 12) as usize] };
    let user = unsafe { *cpl == 3 };
    if entry & (TLB_VALID | if user { TLB_NO_USER } else { 0 }) == TLB_VALID {
        Ok((entry & !0xFFF ^ address) as u32)
    }
    else {
        Ok((unsafe { do_page_translation(address, false, user) }? | address & 0xFFF) as u32)
    }
}

pub unsafe fn translate_address_read_jit(address: i32) -> OrPageFault<u32> {
    let entry = tlb_data[(address as u32 >> 12) as usize];
    let user = *cpl == 3;
    if entry & (TLB_VALID | if user { TLB_NO_USER } else { 0 }) == TLB_VALID {
        Ok((entry & !0xFFF ^ address) as u32)
    }
    else {
        match do_page_walk(address, false, user, true) {
            Ok(phys_addr_high) => Ok((phys_addr_high | address & 0xFFF) as u32),
            Err(pagefault) => {
                trigger_pagefault_jit(pagefault);
                Err(())
            },
        }
    }
}

pub struct PageFault {
    addr: i32,
    for_writing: bool,
    user: bool,
    present: bool,
}

#[inline(never)]
pub unsafe fn do_page_translation(addr: i32, for_writing: bool, user: bool) -> OrPageFault<i32> {
    match do_page_walk(addr, for_writing, user, true) {
        Ok(phys_addr) => Ok(phys_addr),
        Err(pagefault) => {
            trigger_pagefault(pagefault);
            Err(())
        },
    }
}

pub unsafe fn do_page_walk(
    addr: i32,
    for_writing: bool,
    user: bool,
    side_effects: bool,
) -> Result<i32, PageFault> {
    let mut can_write: bool = true;
    let global;
    let mut allow_user: bool = true;
    let page = (addr as u32 >> 12) as i32;
    let high;
    if *cr & CR0_PG == 0 {
        // paging disabled
        high = (addr as u32 & 0xFFFFF000) as i32;
        global = false
    }
    else {
        profiler::stat_increment(TLB_MISS);

        let page_dir_addr = (*cr.offset(3) as u32 >> 2).wrapping_add((page >> 10) as u32) as i32;
        let page_dir_entry = read_aligned32(page_dir_addr as u32);
        // XXX
        let kernel_write_override = !user && 0 == *cr & CR0_WP;
        if 0 == page_dir_entry & PAGE_TABLE_PRESENT_MASK {
            // to do at this place:
            //
            // - set cr2 = addr (which caused the page fault)
            // - call_interrupt_vector  with id 14, error code 0-7 (requires information if read or write)
            // - prevent execution of the function that triggered this call
            return Err(PageFault {
                addr,
                for_writing,
                user,
                present: false,
            });
        }
        if page_dir_entry & PAGE_TABLE_RW_MASK == 0 && !kernel_write_override {
            can_write = false;
            if for_writing {
                return Err(PageFault {
                    addr,
                    for_writing,
                    user,
                    present: true,
                });
            }
        }
        if page_dir_entry & PAGE_TABLE_USER_MASK == 0 {
            allow_user = false;
            if user {
                // Page Fault: page table accessed by non-supervisor
                return Err(PageFault {
                    addr,
                    for_writing,
                    user,
                    present: true,
                });
            }
        }
        if 0 != page_dir_entry & PAGE_TABLE_PSE_MASK && 0 != *cr.offset(4) & CR4_PSE {
            // size bit is set
            // set the accessed and dirty bits

            let new_page_dir_entry = page_dir_entry
                | PAGE_TABLE_ACCESSED_MASK
                | if for_writing { PAGE_TABLE_DIRTY_MASK } else { 0 };

            if side_effects && page_dir_entry != new_page_dir_entry {
                write_aligned32(page_dir_addr as u32, new_page_dir_entry);
            }

            high = (page_dir_entry as u32 & 0xFFC00000 | (addr & 0x3FF000) as u32) as i32;
            global = page_dir_entry & PAGE_TABLE_GLOBAL_MASK == PAGE_TABLE_GLOBAL_MASK
        }
        else {
            let page_table_addr = ((page_dir_entry as u32 & 0xFFFFF000) >> 2)
                .wrapping_add((page & 1023) as u32) as i32;
            let page_table_entry = read_aligned32(page_table_addr as u32);
            if page_table_entry & PAGE_TABLE_PRESENT_MASK == 0 {
                return Err(PageFault {
                    addr,
                    for_writing,
                    user,
                    present: false,
                });
            }
            if page_table_entry & PAGE_TABLE_RW_MASK == 0 && !kernel_write_override {
                can_write = false;
                if for_writing {
                    return Err(PageFault {
                        addr,
                        for_writing,
                        user,
                        present: true,
                    });
                }
            }
            if page_table_entry & PAGE_TABLE_USER_MASK == 0 {
                allow_user = false;
                if user {
                    return Err(PageFault {
                        addr,
                        for_writing,
                        user,
                        present: true,
                    });
                }
            }

            // Set the accessed and dirty bits
            // Note: dirty bit is only set on the page table entry
            let new_page_dir_entry = page_dir_entry | PAGE_TABLE_ACCESSED_MASK;
            if side_effects && new_page_dir_entry != page_dir_entry {
                write_aligned32(page_dir_addr as u32, new_page_dir_entry);
            }
            let new_page_table_entry = page_table_entry
                | PAGE_TABLE_ACCESSED_MASK
                | if for_writing { PAGE_TABLE_DIRTY_MASK } else { 0 };
            if side_effects && page_table_entry != new_page_table_entry {
                write_aligned32(page_table_addr as u32, new_page_table_entry);
            }

            high = (page_table_entry as u32 & 0xFFFFF000) as i32;
            global = page_table_entry & PAGE_TABLE_GLOBAL_MASK == PAGE_TABLE_GLOBAL_MASK
        }
    }
    if side_effects && tlb_data[page as usize] == 0 {
        if valid_tlb_entries_count == VALID_TLB_ENTRY_MAX {
            profiler::stat_increment(TLB_FULL);
            clear_tlb();
            // also clear global entries if tlb is almost full after clearing non-global pages
            if valid_tlb_entries_count > VALID_TLB_ENTRY_MAX * 3 / 4 {
                profiler::stat_increment(TLB_GLOBAL_FULL);
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
    let is_in_mapped_range = in_mapped_range(high as u32);
    let has_code = !is_in_mapped_range && jit::jit_page_has_code(Page::page_of(high as u32));
    let info_bits = TLB_VALID
        | if can_write { 0 } else { TLB_READONLY }
        | if allow_user { 0 } else { TLB_NO_USER }
        | if is_in_mapped_range { TLB_IN_MAPPED_RANGE } else { 0 }
        | if global && 0 != *cr.offset(4) & CR4_PGE { TLB_GLOBAL } else { 0 }
        | if has_code { TLB_HAS_CODE } else { 0 };
    dbg_assert!((high ^ page << 12) & 0xFFF == 0);
    if side_effects {
        tlb_data[page as usize] = high ^ page << 12 | info_bits
    }
    return Ok(high);
}

#[no_mangle]
pub unsafe fn full_clear_tlb() {
    profiler::stat_increment(FULL_CLEAR_TLB);
    // clear tlb including global pages
    *last_virt_eip = -1;
    for i in 0..valid_tlb_entries_count {
        let page = valid_tlb_entries[i as usize];
        tlb_data[page as usize] = 0;
    }
    valid_tlb_entries_count = 0;

    if CHECK_TLB_INVARIANTS {
        for &entry in tlb_data.iter() {
            dbg_assert!(entry == 0);
        }
    };
}

#[no_mangle]
pub unsafe fn clear_tlb() {
    profiler::stat_increment(CLEAR_TLB);
    // clear tlb excluding global pages
    *last_virt_eip = -1;
    let mut global_page_offset: i32 = 0;
    for i in 0..valid_tlb_entries_count {
        let page = valid_tlb_entries[i as usize];
        let entry = tlb_data[page as usize];
        if 0 != entry & TLB_GLOBAL {
            // reinsert at the front
            valid_tlb_entries[global_page_offset as usize] = page;
            global_page_offset += 1;
        }
        else {
            tlb_data[page as usize] = 0
        }
    }
    valid_tlb_entries_count = global_page_offset;

    if CHECK_TLB_INVARIANTS {
        for &entry in tlb_data.iter() {
            dbg_assert!(entry == 0 || 0 != entry & TLB_GLOBAL);
        }
    };
}

/// Pagefault handling with the jit works as follows:
/// - If the slow path is taken, it calls safe_{read,write}*_jit
/// - safe_{read,write}*_jit call translate_address_{read,write}_jit
/// - translate_address_{read,write}_jit do the normal page walk and call this method instead of
///   trigger_pagefault when a page fault happens
/// - this method prepares a page fault by setting cr2, and writes the error code
///   into jit_fault. This method *doesn't* trigger the interrupt, as registers are
///   still stored in the wasm module
/// - back in the wasm module, the generated code detects the page fault, restores the registers
///   and finally calls trigger_fault_end_jit, which does the interrupt
pub unsafe fn trigger_pagefault_jit(fault: PageFault) {
    let write = fault.for_writing;
    let addr = fault.addr;
    let present = fault.present;
    let user = fault.user;

    if ::config::LOG_PAGE_FAULTS {
        dbg_log!(
            "page fault jit w={} u={} p={} eip={:x} cr2={:x}",
            write as i32,
            user as i32,
            present as i32,
            *previous_ip,
            addr
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
    profiler::stat_increment(PAGE_FAULT);
    *cr.offset(2) = addr;
    // invalidate tlb entry
    let page = ((addr as u32) >> 12) as i32;
    tlb_data[page as usize] = 0;
    if DEBUG {
        if cpu_exception_hook(CPU_EXCEPTION_PF) {
            return;
        }
    }
    let error_code = (user as i32) << 2 | (write as i32) << 1 | present as i32;
    jit_fault = Some((CPU_EXCEPTION_PF, Some(error_code)));
}

#[no_mangle]
pub unsafe fn trigger_de_jit(start_eip: i32) {
    dbg_log!("#de in jit mode");
    *instruction_pointer = *instruction_pointer & !0xFFF | start_eip & 0xFFF;
    jit_fault = Some((CPU_EXCEPTION_DE, None))
}

#[no_mangle]
pub unsafe fn trigger_ud_jit(start_eip: i32) {
    dbg_log!("#ud in jit mode");
    *instruction_pointer = *instruction_pointer & !0xFFF | start_eip & 0xFFF;
    jit_fault = Some((CPU_EXCEPTION_UD, None))
}

#[no_mangle]
pub unsafe fn trigger_nm_jit(start_eip: i32) {
    dbg_log!("#nm in jit mode");
    *instruction_pointer = *instruction_pointer & !0xFFF | start_eip & 0xFFF;
    jit_fault = Some((CPU_EXCEPTION_NM, None))
}

#[no_mangle]
pub unsafe fn trigger_gp_jit(code: i32, start_eip: i32) {
    dbg_log!("#gp in jit mode");
    *instruction_pointer = *instruction_pointer & !0xFFF | start_eip & 0xFFF;
    jit_fault = Some((CPU_EXCEPTION_GP, Some(code)))
}

#[no_mangle]
pub unsafe fn trigger_fault_end_jit() {
    let (code, error_code) = jit_fault.unwrap();
    jit_fault = None;
    if DEBUG {
        if cpu_exception_hook(code) {
            return;
        }
    }
    call_interrupt_vector(code, false, error_code);
}

pub unsafe fn trigger_pagefault(fault: PageFault) {
    let write = fault.for_writing;
    let addr = fault.addr;
    let present = fault.present;
    let user = fault.user;

    if ::config::LOG_PAGE_FAULTS {
        dbg_log!(
            "page fault w={} u={} p={} eip={:x} cr2={:x}",
            write as i32,
            user as i32,
            present as i32,
            *previous_ip,
            addr
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
    profiler::stat_increment(PAGE_FAULT);
    *cr.offset(2) = addr;
    // invalidate tlb entry
    let page = ((addr as u32) >> 12) as i32;
    tlb_data[page as usize] = 0;
    *instruction_pointer = *previous_ip;
    call_interrupt_vector(
        CPU_EXCEPTION_PF,
        false,
        Some((user as i32) << 2 | (write as i32) << 1 | present as i32),
    );
}

pub unsafe fn translate_address_write_and_can_skip_dirty(address: i32) -> OrPageFault<(u32, bool)> {
    let entry = tlb_data[(address as u32 >> 12) as usize];
    let user = *cpl == 3;
    if entry & (TLB_VALID | if user { TLB_NO_USER } else { 0 } | TLB_READONLY) == TLB_VALID {
        return Ok(((entry & !0xFFF ^ address) as u32, entry & TLB_HAS_CODE == 0));
    }
    else {
        return Ok((
            (do_page_translation(address, true, user)? | address & 0xFFF) as u32,
            false,
        ));
    };
}

pub unsafe fn translate_address_write(address: i32) -> OrPageFault<u32> {
    let entry = tlb_data[(address as u32 >> 12) as usize];
    let user = *cpl == 3;
    if entry & (TLB_VALID | if user { TLB_NO_USER } else { 0 } | TLB_READONLY) == TLB_VALID {
        return Ok((entry & !0xFFF ^ address) as u32);
    }
    else {
        return Ok((do_page_translation(address, true, user)? | address & 0xFFF) as u32);
    };
}

pub unsafe fn translate_address_write_jit(address: i32) -> OrPageFault<u32> {
    let entry = tlb_data[(address as u32 >> 12) as usize];
    let user = *cpl == 3;
    if entry & (TLB_VALID | if user { TLB_NO_USER } else { 0 } | TLB_READONLY) == TLB_VALID {
        Ok((entry & !0xFFF ^ address) as u32)
    }
    else {
        match do_page_walk(address, true, user, true) {
            Ok(phys_addr_high) => Ok((phys_addr_high | address & 0xFFF) as u32),
            Err(pagefault) => {
                trigger_pagefault_jit(pagefault);
                Err(())
            },
        }
    }
}

pub fn tlb_set_has_code(physical_page: Page, has_code: bool) {
    let physical_page = physical_page.to_u32();
    for i in 0..unsafe { valid_tlb_entries_count } {
        let page = unsafe { valid_tlb_entries[i as usize] };
        let entry = unsafe { tlb_data[page as usize] };
        if 0 != entry {
            let tlb_physical_page = entry as u32 >> 12 ^ page as u32;
            if physical_page == tlb_physical_page {
                unsafe {
                    tlb_data[page as usize] =
                        if has_code { entry | TLB_HAS_CODE } else { entry & !TLB_HAS_CODE }
                }
            }
        }
    }

    check_tlb_invariants();
}

pub fn check_tlb_invariants() {
    if !CHECK_TLB_INVARIANTS {
        return;
    }

    for i in 0..unsafe { valid_tlb_entries_count } {
        let page = unsafe { valid_tlb_entries[i as usize] };
        let entry = unsafe { tlb_data[page as usize] };

        if 0 == entry || 0 != entry & TLB_IN_MAPPED_RANGE {
            // there's no code in mapped memory
            continue;
        }

        let target = (entry ^ page << 12) as u32;
        dbg_assert!(!in_mapped_range(target));

        let entry_has_code = entry & TLB_HAS_CODE != 0;
        let has_code = jit::jit_page_has_code(Page::page_of(target));

        // If some code has been created in a page, the corresponding tlb entries must be marked
        dbg_assert!(!has_code || entry_has_code);
    }
}

pub unsafe fn readable_or_pagefault(addr: i32, size: i32) -> OrPageFault<()> {
    dbg_assert!(size < 0x1000);
    dbg_assert!(size > 0);
    if *cr & CR0_PG == 0 {
        return Ok(());
    }

    let user = *cpl == 3;
    let mask = TLB_VALID | if user { TLB_NO_USER } else { 0 };
    let expect = TLB_VALID;
    let page = (addr as u32 >> 12) as i32;
    if tlb_data[page as usize] & mask != expect {
        do_page_translation(addr, false, user)?;
    }
    let next_page = ((addr + size - 1) as u32 >> 12) as i32;
    if page != next_page {
        dbg_assert!(next_page == page + 1);
        if tlb_data[next_page as usize] & mask != expect {
            do_page_translation(next_page << 12, false, user)?;
        }
    }
    return Ok(());
}

pub unsafe fn writable_or_pagefault(addr: i32, size: i32) -> OrPageFault<()> {
    dbg_assert!(size < 0x1000);
    dbg_assert!(size > 0);
    if *cr & CR0_PG == 0 {
        return Ok(());
    }

    let user = *cpl == 3;
    let mask = TLB_READONLY | TLB_VALID | if user { TLB_NO_USER } else { 0 };
    let expect = TLB_VALID;
    let page = (addr as u32 >> 12) as i32;
    if tlb_data[page as usize] & mask != expect {
        do_page_translation(addr, true, user)?;
    }
    let next_page = ((addr + size - 1) as u32 >> 12) as i32;
    if page != next_page {
        dbg_assert!(next_page == page + 1);
        if tlb_data[next_page as usize] & mask != expect {
            do_page_translation(next_page << 12, true, user)?;
        }
    }
    return Ok(());
}

pub const DISABLE_EIP_TRANSLATION_OPTIMISATION: bool = false;

pub unsafe fn read_imm8() -> OrPageFault<i32> {
    let eip = *instruction_pointer;
    if DISABLE_EIP_TRANSLATION_OPTIMISATION || 0 != eip & !0xFFF ^ *last_virt_eip {
        *eip_phys = (translate_address_read(eip)? ^ eip as u32) as i32;
        *last_virt_eip = eip & !0xFFF
    }
    dbg_assert!(!in_mapped_range((*eip_phys ^ eip) as u32));
    let data8 = *mem8.offset((*eip_phys ^ eip) as isize) as i32;
    *instruction_pointer = eip + 1;
    return Ok(data8);
}

pub unsafe fn read_imm8s() -> OrPageFault<i32> { return Ok(read_imm8()? << 24 >> 24); }

pub unsafe fn read_imm16() -> OrPageFault<i32> {
    // Two checks in one comparison:
    // 1. Did the high 20 bits of eip change
    // or 2. Are the low 12 bits of eip 0xFFF (and this read crosses a page boundary)
    if DISABLE_EIP_TRANSLATION_OPTIMISATION
        || (*instruction_pointer ^ *last_virt_eip) as u32 > 0xFFE
    {
        return Ok(read_imm8()? | read_imm8()? << 8);
    }
    else {
        let data16 = read16((*eip_phys ^ *instruction_pointer) as u32);
        *instruction_pointer = *instruction_pointer + 2;
        return Ok(data16);
    };
}

pub unsafe fn read_imm32s() -> OrPageFault<i32> {
    // Analogue to the above comment
    if DISABLE_EIP_TRANSLATION_OPTIMISATION
        || (*instruction_pointer ^ *last_virt_eip) as u32 > 0xFFC
    {
        return Ok(read_imm16()? | read_imm16()? << 16);
    }
    else {
        let data32 = read32s((*eip_phys ^ *instruction_pointer) as u32);
        *instruction_pointer = *instruction_pointer + 4;
        return Ok(data32);
    };
}

pub unsafe fn is_osize_32() -> bool {
    dbg_assert!(!in_jit);
    return *is_32 != (*prefixes as i32 & PREFIX_MASK_OPSIZE == PREFIX_MASK_OPSIZE);
}

pub unsafe fn is_asize_32() -> bool {
    dbg_assert!(!in_jit);
    return *is_32 != (*prefixes as i32 & PREFIX_MASK_ADDRSIZE == PREFIX_MASK_ADDRSIZE);
}

pub unsafe fn lookup_segment_selector(
    selector: SegmentSelector,
) -> OrPageFault<Result<(SegmentDescriptor, i32), SelectorNullOrInvalid>> {
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
        return Ok(Err(SelectorNullOrInvalid::OutsideOfTableLimit));
    }

    let descriptor_address = selector.descriptor_offset() as i32 + table_offset as i32;

    let descriptor = SegmentDescriptor::of_u64(read64s(translate_address_system_read(
        descriptor_address,
    )?) as u64);

    Ok(Ok((descriptor, descriptor_address)))
}

#[no_mangle]
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

    let selector = SegmentSelector::of_u16(selector_raw as u16);
    let descriptor = match return_on_pagefault!(lookup_segment_selector(selector), false) {
        Ok((desc, _)) => desc,
        Err(selector_unusable) => {
            // The selector couldn't be used to fetch a descriptor, so we handle all of those
            // cases
            if selector_unusable == SelectorNullOrInvalid::IsNull {
                if reg == SS {
                    dbg_log!("#GP for loading 0 in SS sel={:x}", selector_raw);
                    trigger_gp(0);
                    return false;
                }
                else if reg != CS {
                    // es, ds, fs, gs
                    *sreg.offset(reg as isize) = selector_raw as u16;
                    *segment_is_null.offset(reg as isize) = true;
                    return true;
                }
            }
            else if selector_unusable == SelectorNullOrInvalid::OutsideOfTableLimit {
                dbg_log!(
                    "#GP for loading invalid in seg={} sel={:x}",
                    reg,
                    selector_raw
                );
                trigger_gp(selector_raw & !3);
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
            trigger_gp(selector_raw & !3);
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
            trigger_gp(selector_raw & !3);
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

pub unsafe fn load_tr(selector: i32) {
    let selector = SegmentSelector::of_u16(selector as u16);
    dbg_assert!(selector.is_gdt(), "TODO: TR can only be loaded from GDT");

    let (descriptor, descriptor_address) =
        match return_on_pagefault!(lookup_segment_selector(selector)) {
            Ok((desc, addr)) => (desc, addr),
            Err(SelectorNullOrInvalid::IsNull) => {
                panic!("TODO: null TR");
            },
            Err(SelectorNullOrInvalid::OutsideOfTableLimit) => {
                panic!("TODO: TR selector outside of table limit");
            },
        };

    //dbg_log!(
    //    "load tr: {:x} offset={:x} limit={:x} is32={}",
    //    selector.raw,
    //    descriptor.base(),
    //    descriptor.effective_limit(),
    //    descriptor.system_type() == 9,
    //);

    if !descriptor.is_system() {
        panic!("#GP | ltr: not a system entry (happens when running kvm-unit-test without ACPI)");
    }

    if descriptor.system_type() != 9 && descriptor.system_type() != 1 {
        // 0xB: busy 386 TSS (GP)
        // 0x9: 386 TSS
        // 0x3: busy 286 TSS (GP)
        // 0x1: 286 TSS (??)
        panic!(
            "#GP | ltr: invalid type (type = 0x{:x})",
            descriptor.system_type()
        );
    }

    if !descriptor.is_present() {
        panic!("#NT | present bit not set (ltr)");
    }

    *tss_size_32 = descriptor.system_type() == 9;
    *segment_limits.offset(TR as isize) = descriptor.effective_limit();
    *segment_offsets.offset(TR as isize) = descriptor.base();
    *sreg.offset(TR as isize) = selector.raw;

    // Mark task as busy
    safe_write64(descriptor_address, descriptor.set_busy().raw).unwrap();
}

pub unsafe fn load_ldt(selector: i32) -> OrPageFault<()> {
    let selector = SegmentSelector::of_u16(selector as u16);

    if selector.is_null() {
        *segment_limits.offset(LDTR as isize) = 0;
        *segment_offsets.offset(LDTR as isize) = 0;
        *sreg.offset(LDTR as isize) = selector.raw;
        return Ok(());
    }

    dbg_assert!(selector.is_gdt(), "TODO: LDT can only be loaded from GDT");

    let (descriptor, _) = match lookup_segment_selector(selector)? {
        Ok((desc, addr)) => (desc, addr),
        Err(SelectorNullOrInvalid::IsNull) => {
            panic!("TODO: null TR");
        },
        Err(SelectorNullOrInvalid::OutsideOfTableLimit) => {
            panic!("TODO: TR selector outside of table limit");
        },
    };

    if !descriptor.is_present() {
        panic!("#NT | present bit not set (lldt)");
    }

    if !descriptor.is_system() {
        panic!("#GP | lldt: not a system entry");
    }

    if descriptor.system_type() != 2 {
        panic!(
            "#GP | lldt: invalid type (type = 0x{:x})",
            descriptor.system_type()
        );
    }

    *segment_limits.offset(LDTR as isize) = descriptor.effective_limit();
    *segment_offsets.offset(LDTR as isize) = descriptor.base();
    *sreg.offset(LDTR as isize) = selector.raw;

    Ok(())
}

#[no_mangle]
pub unsafe fn log_segment_null(segment: i32) {
    dbg_assert!(segment >= 0 && segment < 8);
    if *segment_is_null.offset(segment as isize) {
        dbg_assert!(segment != CS && segment != SS);
        dbg_log!("#gp: Access null segment in jit");
    }
}

pub unsafe fn get_seg(segment: i32) -> OrPageFault<i32> {
    dbg_assert!(segment >= 0 && segment < 8);
    if *segment_is_null.offset(segment as isize) {
        dbg_assert!(segment != CS && segment != SS);
        dbg_log!("#gp: Access null segment");
        dbg_trace();
        dbg_assert!(!in_jit);
        trigger_gp(0);
        return Err(());
    }
    return Ok(*segment_offsets.offset(segment as isize));
}

pub unsafe fn set_cr0(cr0: i32) {
    let old_cr0 = *cr;

    if old_cr0 & CR0_AM == 0 && cr0 & CR0_AM != 0 {
        dbg_log!("Warning: Unimplemented: cr0 alignment mask");
    }
    if (cr0 & (CR0_PE | CR0_PG)) == CR0_PG {
        panic!("cannot load PG without PE");
    }

    *cr = cr0;
    *cr |= CR0_ET;

    if old_cr0 & (CR0_PG | CR0_WP) != cr0 & (CR0_PG | CR0_WP) {
        full_clear_tlb();
    }

    *protected_mode = (*cr & CR0_PE) == CR0_PE;
}

pub unsafe fn cpl_changed() { *last_virt_eip = -1; }

pub unsafe fn update_cs_size(new_size: bool) {
    if *is_32 != new_size {
        *is_32 = new_size;
    }
}

pub unsafe fn test_privileges_for_io(port: i32, size: i32) -> bool {
    if *protected_mode && (*cpl > getiopl() as u8 || (*flags & FLAG_VM != 0)) {
        if !*tss_size_32 {
            dbg_log!("#GP for port io, 16-bit TSS  port={:x} size={}", port, size);
            trigger_gp(0);
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
                let port_info = if mask & 0xFF00 != 0 { read16(addr) } else { read8(addr) };

                dbg_assert!(addr & 0xFFF < 0xFFF);

                if port_info & mask == 0 {
                    return true;
                }
            }
        }

        dbg_log!("#GP for port io  port={:x} size={}", port, size);
        trigger_gp(0);
        return false;
    }

    return true;
}

pub unsafe fn popa16() {
    return_on_pagefault!(readable_or_pagefault(get_stack_pointer(0), 16));

    write_reg16(DI, pop16().unwrap());
    write_reg16(SI, pop16().unwrap());
    write_reg16(BP, pop16().unwrap());
    adjust_stack_reg(2);
    write_reg16(BX, pop16().unwrap());
    write_reg16(DX, pop16().unwrap());
    write_reg16(CX, pop16().unwrap());
    write_reg16(AX, pop16().unwrap());
}

pub unsafe fn popa32() {
    return_on_pagefault!(readable_or_pagefault(get_stack_pointer(0), 32));

    write_reg32(EDI, pop32s().unwrap());
    write_reg32(ESI, pop32s().unwrap());
    write_reg32(EBP, pop32s().unwrap());
    adjust_stack_reg(4);
    write_reg32(EBX, pop32s().unwrap());
    write_reg32(EDX, pop32s().unwrap());
    write_reg32(ECX, pop32s().unwrap());
    write_reg32(EAX, pop32s().unwrap());
}

#[no_mangle]
pub fn get_seg_cs() -> i32 { unsafe { *segment_offsets.offset(CS as isize) } }

pub unsafe fn get_seg_ss() -> i32 { return *segment_offsets.offset(SS as isize); }

pub unsafe fn get_seg_prefix(default_segment: i32) -> OrPageFault<i32> {
    dbg_assert!(!in_jit);
    let prefix = *prefixes as i32 & PREFIX_MASK_SEGMENT;
    if 0 != prefix {
        if prefix == SEG_PREFIX_ZERO {
            return Ok(0);
        }
        else {
            return get_seg(prefix - 1);
        }
    }
    else {
        return get_seg(default_segment);
    };
}

pub unsafe fn get_seg_prefix_ds(offset: i32) -> OrPageFault<i32> {
    Ok(get_seg_prefix(DS)? + offset)
}

pub unsafe fn get_seg_prefix_ss(offset: i32) -> OrPageFault<i32> {
    Ok(get_seg_prefix(SS)? + offset)
}

pub unsafe fn modrm_resolve(modrm_byte: i32) -> OrPageFault<i32> {
    if is_asize_32() { resolve_modrm32(modrm_byte) } else { resolve_modrm16(modrm_byte) }
}

pub unsafe fn run_instruction(opcode: i32) { ::gen::interpreter::run(opcode as u32) }
pub unsafe fn run_instruction0f_16(opcode: i32) { ::gen::interpreter0f::run(opcode as u32) }
pub unsafe fn run_instruction0f_32(opcode: i32) { ::gen::interpreter0f::run(opcode as u32 | 0x100) }

#[no_mangle]
pub unsafe fn cycle_internal() {
    profiler::stat_increment(CYCLE_INTERNAL);
    if !::config::FORCE_DISABLE_JIT {
        *previous_ip = *instruction_pointer;
        let phys_addr = return_on_pagefault!(get_phys_eip()) as u32;
        let state_flags = pack_current_state_flags();
        let entry = jit::jit_find_cache_entry(phys_addr, state_flags);

        if entry != jit::CachedCode::NONE {
            profiler::stat_increment(RUN_FROM_CACHE);
            let initial_instruction_counter = *instruction_counter;
            let wasm_table_index = entry.wasm_table_index;
            let initial_state = entry.initial_state;
            #[cfg(debug_assertions)]
            {
                in_jit = true;
            }
            let initial_eip = *instruction_pointer;
            call_indirect1(
                wasm_table_index.to_u16() as i32 + WASM_TABLE_OFFSET as i32,
                initial_state,
            );
            #[cfg(debug_assertions)]
            {
                in_jit = false;
            }
            profiler::stat_increment_by(
                RUN_FROM_CACHE_STEPS,
                (*instruction_counter - initial_instruction_counter) as u64,
            );
            dbg_assert!(
                *instruction_counter != initial_instruction_counter,
                "Instruction counter didn't change"
            );

            if cfg!(feature = "profiler") {
                dbg_assert!(match ::cpu::cpu::debug_last_jump {
                    LastJump::Compiled { .. } => true,
                    _ => false,
                });
                let last_jump_addr = ::cpu::cpu::debug_last_jump.phys_address().unwrap();
                let last_jump_opcode = if last_jump_addr != 0 {
                    read32s(last_jump_addr)
                }
                else {
                    // Happens during exit due to loop iteration limit
                    0
                };

                ::opstats::record_opstat_jit_exit(last_jump_opcode as u32);
            }

            if is_near_end_of_page(*instruction_pointer as u32) {
                profiler::stat_increment(RUN_FROM_CACHE_EXIT_NEAR_END_OF_PAGE);
            }
            else if Page::page_of(initial_eip as u32)
                == Page::page_of(*instruction_pointer as u32)
            {
                profiler::stat_increment(RUN_FROM_CACHE_EXIT_SAME_PAGE);
            }
            else {
                profiler::stat_increment(RUN_FROM_CACHE_EXIT_DIFFERENT_PAGE);
            }
        }
        else {
            let initial_eip = *instruction_pointer;
            jit::record_entry_point(phys_addr);

            #[cfg(feature = "profiler")]
            {
                if CHECK_MISSED_ENTRY_POINTS {
                    jit::check_missed_entry_points(phys_addr, state_flags);
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
            let initial_instruction_counter = *instruction_counter;
            jit_run_interpreted(phys_addr as i32);

            jit::jit_increase_hotness_and_maybe_compile(
                initial_eip,
                phys_addr,
                get_seg_cs() as u32,
                state_flags,
                *instruction_counter - initial_instruction_counter,
            );

            profiler::stat_increment_by(
                RUN_INTERPRETED_STEPS,
                (*instruction_counter - initial_instruction_counter) as u64,
            );
            dbg_assert!(
                *instruction_counter != initial_instruction_counter,
                "Instruction counter didn't change"
            );
        };
    }
    else {
        *previous_ip = *instruction_pointer;

        let opcode = return_on_pagefault!(read_imm8());
        *instruction_counter += 1;
        dbg_assert!(*prefixes == 0);
        run_instruction(opcode | (*is_32 as i32) << 8);
        dbg_assert!(*prefixes == 0);
    }
}

pub unsafe fn get_phys_eip() -> OrPageFault<u32> {
    let eip = *instruction_pointer;
    if 0 != eip & !0xFFF ^ *last_virt_eip {
        *eip_phys = (translate_address_read(eip)? ^ eip as u32) as i32;
        *last_virt_eip = eip & !0xFFF
    }
    let phys_addr = (*eip_phys ^ eip) as u32;
    dbg_assert!(!in_mapped_range(phys_addr));
    return Ok(phys_addr);
}

unsafe fn jit_run_interpreted(phys_addr: i32) {
    profiler::stat_increment(RUN_INTERPRETED);
    dbg_assert!(!in_mapped_range(phys_addr as u32));

    if cfg!(debug_assertions) {
        debug_last_jump = LastJump::Interpreted {
            phys_addr: phys_addr as u32,
        };
    }

    jit_block_boundary = false;
    let opcode = *mem8.offset(phys_addr as isize) as i32;
    *instruction_pointer += 1;
    *instruction_counter += 1;
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
            let state_flags = pack_current_state_flags();
            let entry = jit::jit_find_cache_entry(phys_addr, state_flags);

            if entry != jit::CachedCode::NONE {
                profiler::stat_increment(RUN_INTERPRETED_MISSED_COMPILED_ENTRY_RUN_INTERPRETED);
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

        *instruction_counter += 1;

        //if DEBUG {
        //    logop(*previous_ip, opcode_0);
        //}

        dbg_assert!(*prefixes == 0);
        run_instruction(opcode | (*is_32 as i32) << 8);
        dbg_assert!(*prefixes == 0);

        i += 1;
    }
}

pub fn pack_current_state_flags() -> CachedStateFlags {
    unsafe {
        CachedStateFlags::of_u32(
            (*is_32 as u32) << 0
                | (*stack_size_32 as u32) << 1
                | ((*cpl == 3) as u32) << 2
                | (has_flat_segmentation() as u32) << 3,
        )
    }
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

pub unsafe fn segment_prefix_op(seg: i32) {
    dbg_assert!(seg <= 5);
    *prefixes = (*prefixes as i32 | seg + 1) as u8;
    run_prefix_instruction();
    *prefixes = 0
}

#[no_mangle]
pub unsafe fn do_many_cycles_native() {
    profiler::stat_increment(DO_MANY_CYCLES);
    let initial_instruction_counter = *instruction_counter;
    while (*instruction_counter).wrapping_sub(initial_instruction_counter) < LOOP_COUNTER as u32
        && !*in_hlt
    {
        cycle_internal();
    }
}

pub unsafe fn trigger_de() {
    dbg_log!("#de");
    *instruction_pointer = *previous_ip;
    if DEBUG {
        if cpu_exception_hook(CPU_EXCEPTION_DE) {
            return;
        }
    }
    call_interrupt_vector(CPU_EXCEPTION_DE, false, None);
}

pub unsafe fn trigger_ud() {
    dbg_log!("#ud");
    dbg_trace();
    *instruction_pointer = *previous_ip;
    if DEBUG {
        if cpu_exception_hook(CPU_EXCEPTION_UD) {
            return;
        }
    }
    call_interrupt_vector(CPU_EXCEPTION_UD, false, None);
}

pub unsafe fn trigger_nm() {
    dbg_log!("#nm eip={:x}", *previous_ip);
    dbg_trace();
    *instruction_pointer = *previous_ip;
    if DEBUG {
        if cpu_exception_hook(CPU_EXCEPTION_NM) {
            return;
        }
    }
    call_interrupt_vector(CPU_EXCEPTION_NM, false, None);
}

pub unsafe fn trigger_gp(code: i32) {
    dbg_log!("#gp");
    *instruction_pointer = *previous_ip;
    if DEBUG {
        if cpu_exception_hook(CPU_EXCEPTION_GP) {
            return;
        }
    }
    call_interrupt_vector(CPU_EXCEPTION_GP, false, Some(code));
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
            mid = read16(high - 2)
        }
        else {
            // 0xFFD
            mid = read16(low + 1)
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

pub unsafe fn safe_read8(addr: i32) -> OrPageFault<i32> { Ok(read8(translate_address_read(addr)?)) }

pub unsafe fn safe_read16(addr: i32) -> OrPageFault<i32> {
    if addr & 0xFFF == 0xFFF {
        Ok(safe_read8(addr)? | safe_read8(addr + 1)? << 8)
    }
    else {
        Ok(read16(translate_address_read(addr)?))
    }
}

pub unsafe fn safe_read32s(addr: i32) -> OrPageFault<i32> {
    if addr & 0xFFF >= 0xFFD {
        Ok(safe_read16(addr)? | safe_read16(addr + 2)? << 16)
    }
    else {
        Ok(read32s(translate_address_read(addr)?))
    }
}

pub unsafe fn safe_read_f32(addr: i32) -> OrPageFault<f32> {
    Ok(std::mem::transmute(safe_read32s(addr)?))
}

pub unsafe fn safe_read64s(addr: i32) -> OrPageFault<u64> {
    if addr & 0xFFF > 0x1000 - 8 {
        Ok(safe_read32s(addr)? as u32 as u64 | (safe_read32s(addr + 4)? as u32 as u64) << 32)
    }
    else {
        Ok(read64s(translate_address_read(addr)?) as u64)
    }
}

pub unsafe fn safe_read128s(addr: i32) -> OrPageFault<reg128> {
    if addr & 0xFFF > 0x1000 - 16 {
        Ok(reg128 {
            u64_0: [safe_read64s(addr)?, safe_read64s(addr + 8)?],
        })
    }
    else {
        Ok(read128(translate_address_read(addr)?))
    }
}

#[no_mangle]
#[cfg(feature = "profiler")]
pub fn report_safe_read_jit_slow(address: u32, entry: i32) {
    if entry & TLB_VALID == 0 {
        profiler::stat_increment(SAFE_READ_SLOW_NOT_VALID);
    }
    else if entry & TLB_IN_MAPPED_RANGE != 0 {
        profiler::stat_increment(SAFE_READ_SLOW_IN_MAPPED_RANGE);
    }
    else if entry & TLB_NO_USER != 0 {
        profiler::stat_increment(SAFE_READ_SLOW_NOT_USER);
    }
    else if address & 0xFFF > 0x1000 - 16 {
        profiler::stat_increment(SAFE_READ_SLOW_PAGE_CROSSED);
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
        profiler::stat_increment(SAFE_WRITE_SLOW_NOT_VALID);
    }
    else if entry & TLB_IN_MAPPED_RANGE != 0 {
        profiler::stat_increment(SAFE_WRITE_SLOW_IN_MAPPED_RANGE);
    }
    else if entry & TLB_HAS_CODE != 0 {
        profiler::stat_increment(SAFE_WRITE_SLOW_HAS_CODE);
    }
    else if entry & TLB_READONLY != 0 {
        profiler::stat_increment(SAFE_WRITE_SLOW_READ_ONLY);
    }
    else if entry & TLB_NO_USER != 0 {
        profiler::stat_increment(SAFE_WRITE_SLOW_NOT_USER);
    }
    else if address & 0xFFF > 0x1000 - 16 {
        profiler::stat_increment(SAFE_WRITE_SLOW_PAGE_CROSSED);
    }
    else {
        dbg_assert!(false);
    }
}

#[no_mangle]
#[cfg(feature = "profiler")]
pub fn report_safe_read_write_jit_slow(address: u32, entry: i32) {
    if entry & TLB_VALID == 0 {
        profiler::stat_increment(SAFE_READ_WRITE_SLOW_NOT_VALID);
    }
    else if entry & TLB_IN_MAPPED_RANGE != 0 {
        profiler::stat_increment(SAFE_READ_WRITE_SLOW_IN_MAPPED_RANGE);
    }
    else if entry & TLB_HAS_CODE != 0 {
        profiler::stat_increment(SAFE_READ_WRITE_SLOW_HAS_CODE);
    }
    else if entry & TLB_READONLY != 0 {
        profiler::stat_increment(SAFE_READ_WRITE_SLOW_READ_ONLY);
    }
    else if entry & TLB_NO_USER != 0 {
        profiler::stat_increment(SAFE_READ_WRITE_SLOW_NOT_USER);
    }
    else if address & 0xFFF > 0x1000 - 16 {
        profiler::stat_increment(SAFE_READ_WRITE_SLOW_PAGE_CROSSED);
    }
    else {
        dbg_assert!(false);
    }
}

#[repr(align(0x1000))]
struct ScratchBuffer([u8; 0x1000 * 2]);
static mut jit_paging_scratch_buffer: ScratchBuffer = ScratchBuffer([0; 2 * 0x1000]);

pub unsafe fn safe_read_slow_jit(addr: i32, bitsize: i32, start_eip: i32, is_write: bool) -> i32 {
    if is_write && Page::page_of(*instruction_pointer as u32) == Page::page_of(addr as u32) {
        // XXX: Check based on virtual address
        dbg_log!(
            "SMC (rmw): bits={} eip={:x} writeaddr={:x}",
            bitsize,
            start_eip as u32,
            addr as u32
        );
    }
    let crosses_page = (addr & 0xFFF) + bitsize / 8 > 0x1000;
    let addr_low = match if is_write {
        translate_address_write_jit(addr)
    }
    else {
        translate_address_read_jit(addr)
    } {
        Err(()) => {
            *instruction_pointer = *instruction_pointer & !0xFFF | start_eip & 0xFFF;
            return 1;
        },
        Ok(addr) => addr,
    };
    if crosses_page {
        let boundary_addr = (addr | 0xFFF) + 1;
        let addr_high = match if is_write {
            translate_address_write_jit(boundary_addr)
        }
        else {
            translate_address_read_jit(boundary_addr)
        } {
            Err(()) => {
                *instruction_pointer = *instruction_pointer & !0xFFF | start_eip & 0xFFF;
                return 1;
            },
            Ok(addr) => addr,
        };
        // TODO: Could check if virtual pages point to consecutive physical and go to fast path
        // do read, write into scratch buffer

        let scratch = jit_paging_scratch_buffer.0.as_mut_ptr() as u32;
        dbg_assert!(scratch & 0xFFF == 0);

        for s in addr_low..((addr_low | 0xFFF) + 1) {
            *(scratch as *mut u8).offset((s & 0xFFF) as isize) = read8(s) as u8
        }
        for s in addr_high..(addr_high + (addr + bitsize / 8 & 0xFFF) as u32) {
            *(scratch as *mut u8).offset((0x1000 | s & 0xFFF) as isize) = read8(s) as u8
        }

        (((scratch - mem8 as u32) as i32) ^ addr) & !0xFFF
    }
    else if in_mapped_range(addr_low) {
        let scratch = jit_paging_scratch_buffer.0.as_mut_ptr() as u32;
        dbg_assert!(scratch & 0xFFF == 0);

        for s in addr_low..(addr_low + bitsize as u32 / 8) {
            *(scratch as *mut u8).offset((s & 0xFFF) as isize) = read8(s) as u8
        }

        (((scratch - mem8 as u32) as i32) ^ addr) & !0xFFF
    }
    else {
        (addr_low as i32 ^ addr) & !0xFFF
    }
}

#[no_mangle]
pub unsafe fn safe_read8_slow_jit(addr: i32, eip: i32) -> i32 {
    safe_read_slow_jit(addr, 8, eip, false)
}
#[no_mangle]
pub unsafe fn safe_read16_slow_jit(addr: i32, eip: i32) -> i32 {
    safe_read_slow_jit(addr, 16, eip, false)
}
#[no_mangle]
pub unsafe fn safe_read32s_slow_jit(addr: i32, eip: i32) -> i32 {
    safe_read_slow_jit(addr, 32, eip, false)
}
#[no_mangle]
pub unsafe fn safe_read64s_slow_jit(addr: i32, eip: i32) -> i32 {
    safe_read_slow_jit(addr, 64, eip, false)
}
#[no_mangle]
pub unsafe fn safe_read128s_slow_jit(addr: i32, eip: i32) -> i32 {
    safe_read_slow_jit(addr, 128, eip, false)
}

#[no_mangle]
pub unsafe fn get_phys_eip_slow_jit(addr: i32) -> i32 {
    match translate_address_read_jit(addr) {
        Err(()) => 1,
        Ok(addr_low) => {
            dbg_assert!(!in_mapped_range(addr_low as u32)); // same assumption as in read_imm8
            (addr_low as i32 ^ addr) & !0xFFF
        },
    }
}

#[no_mangle]
pub unsafe fn safe_read_write8_slow_jit(addr: i32, eip: i32) -> i32 {
    safe_read_slow_jit(addr, 8, eip, true)
}
#[no_mangle]
pub unsafe fn safe_read_write16_slow_jit(addr: i32, eip: i32) -> i32 {
    safe_read_slow_jit(addr, 16, eip, true)
}
#[no_mangle]
pub unsafe fn safe_read_write32s_slow_jit(addr: i32, eip: i32) -> i32 {
    safe_read_slow_jit(addr, 32, eip, true)
}
#[no_mangle]
pub unsafe fn safe_read_write64_slow_jit(addr: i32, eip: i32) -> i32 {
    safe_read_slow_jit(addr, 64, eip, true)
}

pub unsafe fn safe_write_slow_jit(
    addr: i32,
    bitsize: i32,
    value_low: u64,
    value_high: u64,
    start_eip: i32,
) -> i32 {
    if Page::page_of(*instruction_pointer as u32) == Page::page_of(addr as u32) {
        // XXX: Check based on virtual address
        dbg_log!(
            "SMC: bits={} eip={:x} writeaddr={:x}",
            bitsize,
            start_eip as u32,
            addr as u32
        );
    }
    let crosses_page = (addr & 0xFFF) + bitsize / 8 > 0x1000;
    let addr_low = match translate_address_write_jit(addr) {
        Err(()) => {
            *instruction_pointer = *instruction_pointer & !0xFFF | start_eip & 0xFFF;
            return 1;
        },
        Ok(addr) => addr,
    };
    if crosses_page {
        let addr_high = match translate_address_write_jit((addr | 0xFFF) + 1) {
            Err(()) => {
                *instruction_pointer = *instruction_pointer & !0xFFF | start_eip & 0xFFF;
                return 1;
            },
            Ok(addr) => addr,
        };
        // TODO: Could check if virtual pages point to consecutive physical and go to fast path

        // do write, return dummy pointer for fast path to write into

        match bitsize {
            128 => safe_write128(
                addr,
                reg128 {
                    u64_0: [value_low, value_high],
                },
            )
            .unwrap(),
            64 => safe_write64(addr, value_low).unwrap(),
            32 => virt_boundary_write32(
                addr_low,
                addr_high | (addr as u32 + 3 & 3),
                value_low as i32,
            ),
            16 => virt_boundary_write16(addr_low, addr_high, value_low as i32),
            8 => dbg_assert!(false),
            _ => dbg_assert!(false),
        }

        let scratch = jit_paging_scratch_buffer.0.as_mut_ptr() as u32;
        dbg_assert!(scratch & 0xFFF == 0);
        ((scratch as i32 - mem8 as i32) ^ addr) & !0xFFF
    }
    else if in_mapped_range(addr_low) {
        match bitsize {
            128 => memory::mmap_write128(
                addr_low,
                value_low as i32,
                (value_low >> 32) as i32,
                value_high as i32,
                (value_high >> 32) as i32,
            ),
            64 => memory::mmap_write64(addr_low, value_low as i32, (value_low >> 32) as i32),
            32 => memory::mmap_write32(addr_low, value_low as i32),
            16 => memory::mmap_write16(addr_low, value_low as i32),
            8 => memory::mmap_write8(addr_low, value_low as i32),
            _ => dbg_assert!(false),
        }

        let scratch = jit_paging_scratch_buffer.0.as_mut_ptr() as u32;
        dbg_assert!(scratch & 0xFFF == 0);
        ((scratch as i32 - mem8 as i32) ^ addr) & !0xFFF
    }
    else {
        jit::jit_dirty_page(jit::get_jit_state(), Page::page_of(addr_low));
        (addr_low as i32 ^ addr) & !0xFFF
    }
}

#[no_mangle]
pub unsafe fn safe_write8_slow_jit(addr: i32, value: u32, start_eip: i32) -> i32 {
    safe_write_slow_jit(addr, 8, value as u64, 0, start_eip)
}
#[no_mangle]
pub unsafe fn safe_write16_slow_jit(addr: i32, value: u32, start_eip: i32) -> i32 {
    safe_write_slow_jit(addr, 16, value as u64, 0, start_eip)
}
#[no_mangle]
pub unsafe fn safe_write32_slow_jit(addr: i32, value: u32, start_eip: i32) -> i32 {
    safe_write_slow_jit(addr, 32, value as u64, 0, start_eip)
}
#[no_mangle]
pub unsafe fn safe_write64_slow_jit(addr: i32, value: u64, start_eip: i32) -> i32 {
    safe_write_slow_jit(addr, 64, value, 0, start_eip)
}
#[no_mangle]
pub unsafe fn safe_write128_slow_jit(addr: i32, low: u64, high: u64, start_eip: i32) -> i32 {
    safe_write_slow_jit(addr, 128, low, high, start_eip)
}

pub unsafe fn safe_write8(addr: i32, value: i32) -> OrPageFault<()> {
    let (phys_addr, can_skip_dirty_page) = translate_address_write_and_can_skip_dirty(addr)?;
    if in_mapped_range(phys_addr) {
        memory::mmap_write8(phys_addr, value);
    }
    else {
        if !can_skip_dirty_page {
            jit::jit_dirty_page(jit::get_jit_state(), Page::page_of(phys_addr));
        }
        else {
            dbg_assert!(!jit::jit_page_has_code(Page::page_of(phys_addr as u32)));
        }
        memory::write8_no_mmap_or_dirty_check(phys_addr, value);
    };
    Ok(())
}

pub unsafe fn safe_write16(addr: i32, value: i32) -> OrPageFault<()> {
    let (phys_addr, can_skip_dirty_page) = translate_address_write_and_can_skip_dirty(addr)?;
    if addr & 0xFFF == 0xFFF {
        virt_boundary_write16(phys_addr, translate_address_write(addr + 1)?, value);
    }
    else if in_mapped_range(phys_addr) {
        memory::mmap_write16(phys_addr, value);
    }
    else {
        if !can_skip_dirty_page {
            jit::jit_dirty_page(jit::get_jit_state(), Page::page_of(phys_addr));
        }
        else {
            dbg_assert!(!jit::jit_page_has_code(Page::page_of(phys_addr as u32)));
        }
        memory::write16_no_mmap_or_dirty_check(phys_addr, value);
    };
    Ok(())
}

pub unsafe fn safe_write32(addr: i32, value: i32) -> OrPageFault<()> {
    let (phys_addr, can_skip_dirty_page) = translate_address_write_and_can_skip_dirty(addr)?;
    if addr & 0xFFF > 0x1000 - 4 {
        virt_boundary_write32(
            phys_addr,
            translate_address_write(addr + 3 & !3)? | (addr as u32 + 3 & 3),
            value,
        );
    }
    else if in_mapped_range(phys_addr) {
        memory::mmap_write32(phys_addr, value);
    }
    else {
        if !can_skip_dirty_page {
            jit::jit_dirty_page(jit::get_jit_state(), Page::page_of(phys_addr));
        }
        else {
            dbg_assert!(!jit::jit_page_has_code(Page::page_of(phys_addr as u32)));
        }
        memory::write32_no_mmap_or_dirty_check(phys_addr, value);
    };
    Ok(())
}

pub unsafe fn safe_write64(addr: i32, value: u64) -> OrPageFault<()> {
    if addr & 0xFFF > 0x1000 - 8 {
        writable_or_pagefault(addr, 8)?;
        safe_write32(addr, value as i32).unwrap();
        safe_write32(addr + 4, (value >> 32) as i32).unwrap();
    }
    else {
        let (phys_addr, can_skip_dirty_page) = translate_address_write_and_can_skip_dirty(addr)?;
        if in_mapped_range(phys_addr) {
            memory::mmap_write64(phys_addr, value as i32, (value >> 32) as i32);
        }
        else {
            if !can_skip_dirty_page {
                jit::jit_dirty_page(jit::get_jit_state(), Page::page_of(phys_addr));
            }
            else {
                dbg_assert!(!jit::jit_page_has_code(Page::page_of(phys_addr as u32)));
            }
            memory::write64_no_mmap_or_dirty_check(phys_addr, value);
        }
    };
    Ok(())
}

pub unsafe fn safe_write128(addr: i32, value: reg128) -> OrPageFault<()> {
    if addr & 0xFFF > 0x1000 - 16 {
        writable_or_pagefault(addr, 16)?;
        safe_write64(addr, value.u64_0[0]).unwrap();
        safe_write64(addr + 8, value.u64_0[1]).unwrap();
    }
    else {
        let (phys_addr, can_skip_dirty_page) = translate_address_write_and_can_skip_dirty(addr)?;
        if in_mapped_range(phys_addr) {
            memory::mmap_write128(
                phys_addr,
                value.i32_0[0],
                value.i32_0[1],
                value.i32_0[2],
                value.i32_0[3],
            );
        }
        else {
            if !can_skip_dirty_page {
                jit::jit_dirty_page(jit::get_jit_state(), Page::page_of(phys_addr));
            }
            else {
                dbg_assert!(!jit::jit_page_has_code(Page::page_of(phys_addr as u32)));
            }
            memory::write128_no_mmap_or_dirty_check(phys_addr, value);
        }
    };
    Ok(())
}

fn get_reg8_index(index: i32) -> i32 { return index << 2 & 12 | index >> 2 & 1; }

pub unsafe fn read_reg8(index: i32) -> i32 {
    dbg_assert!(index >= 0 && index < 8);
    return *reg8.offset(get_reg8_index(index) as isize) as i32;
}

pub unsafe fn write_reg8(index: i32, value: i32) {
    dbg_assert!(index >= 0 && index < 8);
    *reg8.offset(get_reg8_index(index) as isize) = value as u8;
}

fn get_reg16_index(index: i32) -> i32 { return index << 1; }

pub unsafe fn read_reg16(index: i32) -> i32 {
    dbg_assert!(index >= 0 && index < 8);
    return *reg16.offset(get_reg16_index(index) as isize) as i32;
}

pub unsafe fn write_reg16(index: i32, value: i32) {
    dbg_assert!(index >= 0 && index < 8);
    *reg16.offset(get_reg16_index(index) as isize) = value as u16;
}

pub unsafe fn read_reg32(index: i32) -> i32 {
    dbg_assert!(index >= 0 && index < 8);
    *reg32.offset(index as isize)
}

pub unsafe fn write_reg32(index: i32, value: i32) {
    dbg_assert!(index >= 0 && index < 8);
    *reg32.offset(index as isize) = value;
}

pub unsafe fn read_mmx32s(r: i32) -> i32 { (*fpu_st.offset(r as isize)).mantissa as i32 }

pub unsafe fn read_mmx64s(r: i32) -> u64 { (*fpu_st.offset(r as isize)).mantissa }

pub unsafe fn write_mmx_reg64(r: i32, data: u64) { (*fpu_st.offset(r as isize)).mantissa = data; }

pub unsafe fn read_xmm_f32(r: i32) -> f32 { return (*reg_xmm.offset(r as isize)).f32_0[0]; }

pub unsafe fn read_xmm32(r: i32) -> i32 { return (*reg_xmm.offset(r as isize)).u32_0[0] as i32; }

pub unsafe fn read_xmm64s(r: i32) -> u64 { (*reg_xmm.offset(r as isize)).u64_0[0] }

pub unsafe fn read_xmm128s(r: i32) -> reg128 { return *reg_xmm.offset(r as isize); }

pub unsafe fn write_xmm_f32(r: i32, data: f32) { (*reg_xmm.offset(r as isize)).f32_0[0] = data; }

pub unsafe fn write_xmm32(r: i32, data: i32) { (*reg_xmm.offset(r as isize)).i32_0[0] = data; }

pub unsafe fn write_xmm64(r: i32, data: u64) { (*reg_xmm.offset(r as isize)).u64_0[0] = data }
pub unsafe fn write_xmm_f64(r: i32, data: f64) { (*reg_xmm.offset(r as isize)).f64_0[0] = data }

pub unsafe fn write_xmm128(r: i32, i0: i32, i1: i32, i2: i32, i3: i32) {
    let x = reg128 {
        u32_0: [i0 as u32, i1 as u32, i2 as u32, i3 as u32],
    };
    *reg_xmm.offset(r as isize) = x;
}

pub unsafe fn write_xmm128_2(r: i32, i0: u64, i1: u64) {
    *reg_xmm.offset(r as isize) = reg128 { u64_0: [i0, i1] };
}

pub unsafe fn write_xmm_reg128(r: i32, data: reg128) { *reg_xmm.offset(r as isize) = data; }

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
pub unsafe fn task_switch_test_jit(start_eip: i32) {
    dbg_assert!(0 != *cr & (CR0_EM | CR0_TS));
    trigger_nm_jit(start_eip);
}

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
pub unsafe fn task_switch_test_mmx_jit(start_eip: i32) {
    if *cr.offset(4) & CR4_OSFXSR == 0 {
        dbg_log!("Warning: Unimplemented task switch test with cr4.osfxsr=0");
    }
    if 0 != *cr & CR0_EM {
        trigger_ud_jit(start_eip);
    }
    else if 0 != *cr & CR0_TS {
        trigger_nm_jit(start_eip);
    }
    else {
        dbg_assert!(false);
    }
}

pub unsafe fn read_moffs() -> OrPageFault<i32> {
    // read 2 or 4 byte from ip, depending on address size attribute
    if is_asize_32() { read_imm32s() } else { read_imm16() }
}

#[no_mangle]
pub unsafe fn get_real_eip() -> i32 {
    // Returns the 'real' instruction pointer, without segment offset
    return *instruction_pointer - get_seg_cs();
}

pub unsafe fn get_stack_reg() -> i32 {
    if *stack_size_32 {
        return read_reg32(ESP);
    }
    else {
        return read_reg16(SP);
    };
}

pub unsafe fn set_stack_reg(value: i32) {
    if *stack_size_32 {
        write_reg32(ESP, value)
    }
    else {
        write_reg16(SP, value)
    };
}

pub unsafe fn get_reg_asize(reg: i32) -> i32 {
    dbg_assert!(reg == ECX || reg == ESI || reg == EDI);
    let r = read_reg32(reg);
    if is_asize_32() {
        return r;
    }
    else {
        return r & 0xFFFF;
    };
}

pub unsafe fn set_reg_asize(is_asize_32: bool, reg: i32, value: i32) {
    dbg_assert!(reg == ECX || reg == ESI || reg == EDI);
    if is_asize_32 {
        write_reg32(reg, value)
    }
    else {
        write_reg16(reg, value)
    };
}

pub unsafe fn decr_ecx_asize(is_asize_32: bool) -> i32 {
    return if is_asize_32 {
        write_reg32(ECX, read_reg32(ECX) - 1);
        read_reg32(ECX)
    }
    else {
        write_reg16(CX, read_reg16(CX) - 1);
        read_reg16(CX)
    };
}

#[no_mangle]
pub unsafe fn set_tsc(low: u32, high: u32) {
    let new_value = low as u64 | (high as u64) << 32;
    let current_value = read_tsc();
    tsc_offset = current_value.wrapping_sub(new_value);
}

#[no_mangle]
pub unsafe fn read_tsc() -> u64 {
    let n = microtick() * TSC_RATE;
    let value = (n as u64).wrapping_sub(tsc_offset);
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
            let previous_value = rdtsc_last_value.wrapping_add(rdtsc_imprecision_offset);
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

pub unsafe fn vm86_mode() -> bool { return *flags & FLAG_VM == FLAG_VM; }

#[no_mangle]
pub unsafe fn getiopl() -> i32 { return *flags >> 12 & 3; }

#[no_mangle]
pub unsafe fn get_opstats_buffer(
    compiled: bool,
    jit_exit: bool,
    unguarded_register: bool,
    wasm_size: bool,
    opcode: u8,
    is_0f: bool,
    is_mem: bool,
    fixed_g: u8,
) -> u32 {
    let index = (is_0f as u32) << 12 | (opcode as u32) << 4 | (is_mem as u32) << 3 | fixed_g as u32;
    if compiled {
        *opstats_compiled_buffer.offset(index as isize)
    }
    else if jit_exit {
        *opstats_jit_exit_buffer.offset(index as isize)
    }
    else if unguarded_register {
        *opstats_unguarded_register_buffer.offset(index as isize)
    }
    else if wasm_size {
        *opstats_wasm_size.offset(index as isize)
    }
    else {
        *opstats_buffer.offset(index as isize)
    }
}

pub unsafe fn invlpg(addr: i32) {
    let page = (addr as u32 >> 12) as i32;
    // Note: Doesn't remove this page from valid_tlb_entries: This isn't
    // necessary, because when valid_tlb_entries grows too large, it will be
    // empties by calling clear_tlb, which removes this entry as it isn't global.
    // This however means that valid_tlb_entries can contain some invalid entries
    tlb_data[page as usize] = 0;
    *last_virt_eip = -1;
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
            dbg_assert!(*cpl == 0);
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

    if *flags & FLAG_TRAP != 0 {
        dbg_log!("Not supported: trap flag");
    }
    *flags &= !FLAG_TRAP;
}

#[no_mangle]
pub unsafe fn get_valid_tlb_entries_count() -> i32 {
    if !cfg!(feature = "profiler") {
        return 0;
    }
    let mut result: i32 = 0;
    for i in 0..valid_tlb_entries_count {
        let page = valid_tlb_entries[i as usize];
        let entry = tlb_data[page as usize];
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
        let page = valid_tlb_entries[i as usize];
        let entry = tlb_data[page as usize];
        if 0 != entry & TLB_GLOBAL {
            result += 1
        }
    }
    return result;
}

pub unsafe fn translate_address_system_read(address: i32) -> OrPageFault<u32> {
    let entry = tlb_data[(address as u32 >> 12) as usize];
    if 0 != entry & TLB_VALID {
        return Ok((entry & !0xFFF ^ address) as u32);
    }
    else {
        return Ok((do_page_translation(address, false, false)? | address & 0xFFF) as u32);
    };
}

pub unsafe fn translate_address_system_write(address: i32) -> OrPageFault<u32> {
    let entry = tlb_data[(address as u32 >> 12) as usize];
    if entry & (TLB_VALID | TLB_READONLY) == TLB_VALID {
        return Ok((entry & !0xFFF ^ address) as u32);
    }
    else {
        return Ok((do_page_translation(address, true, false)? | address & 0xFFF) as u32);
    };
}

pub unsafe fn trigger_np(code: i32) {
    dbg_log!("#np");
    *instruction_pointer = *previous_ip;
    if DEBUG {
        if cpu_exception_hook(CPU_EXCEPTION_NP) {
            return;
        }
    }
    call_interrupt_vector(CPU_EXCEPTION_NP, false, Some(code));
}

pub unsafe fn trigger_ss(code: i32) {
    dbg_log!("#ss");
    *instruction_pointer = *previous_ip;
    if DEBUG {
        if cpu_exception_hook(CPU_EXCEPTION_SS) {
            return;
        }
    }
    call_interrupt_vector(CPU_EXCEPTION_SS, false, Some(code));
}

#[no_mangle]
pub unsafe fn store_current_tsc() { *current_tsc = read_tsc(); }

#[no_mangle]
pub unsafe fn handle_irqs() {
    if *flags & FLAG_INTERRUPT != 0 {
        pic_acknowledge()
    }
}

#[no_mangle]
pub unsafe fn pic_call_irq(interrupt_nr: i32) {
    *previous_ip = *instruction_pointer; // XXX: What if called after instruction (port IO)
    call_interrupt_vector(interrupt_nr, false, None);
}

#[no_mangle]
pub unsafe fn check_page_switch(block_addr: u32, next_block_addr: u32) {
    let x = translate_address_read_jit(*instruction_pointer);
    if x != Ok(next_block_addr) {
        dbg_log!(
            "page switch from={:x} to={:x} prev_eip={:x} eip={:x} phys_eip={:x}",
            block_addr,
            next_block_addr,
            *previous_ip,
            *instruction_pointer,
            x.unwrap_or(0),
        );
    }
    dbg_assert!(next_block_addr & 0xFFF == *instruction_pointer as u32 & 0xFFF);
    dbg_assert!(x.is_ok());
    dbg_assert!(x == Ok(next_block_addr));
}

#[no_mangle]
pub unsafe fn reset_cpu() {
    for i in 0..8 {
        *segment_is_null.offset(i) = false;
        *segment_limits.offset(i) = 0;
        *segment_offsets.offset(i) = 0;

        *reg32.offset(i) = 0;

        *sreg.offset(i) = 0;
        *dreg.offset(i) = 0;

        write_xmm128_2(i as i32, 0, 0);

        *fpu_st.offset(i) = ::softfloat::F80::ZERO;
    }

    *fpu_stack_empty = 0xFF;
    *fpu_stack_ptr = 0;
    *fpu_control_word = 0x37F;
    *fpu_status_word = 0;
    *fpu_ip = 0;
    *fpu_ip_selector = 0;
    *fpu_opcode = 0;
    *fpu_dp = 0;
    *fpu_dp_selector = 0;

    *mxcsr = 0x1F80;

    full_clear_tlb();

    *protected_mode = false;

    // http://www.sandpile.org/x86/initial.htm
    *idtr_size = 0;
    *idtr_offset = 0;

    *gdtr_size = 0;
    *gdtr_offset = 0;

    *page_fault = false;
    *cr = 1 << 30 | 1 << 29 | 1 << 4;
    *cr.offset(2) = 0;
    *cr.offset(3) = 0;
    *cr.offset(4) = 0;
    *dreg.offset(6) = 0xFFFF0FF0u32 as i32;
    *dreg.offset(7) = 0x400;
    *cpl = 0;

    *is_32 = false;
    *stack_size_32 = false;
    *prefixes = 0;

    *last_virt_eip = -1;

    *instruction_counter = 0;
    *previous_ip = 0;
    *in_hlt = false;

    *sysenter_cs = 0;
    *sysenter_esp = 0;
    *sysenter_eip = 0;

    *flags = FLAGS_DEFAULT;
    *flags_changed = 0;
    *last_result = 0;
    *last_op1 = 0;
    *last_op_size = 0;

    set_tsc(0, 0);

    *instruction_pointer = 0xFFFF0;
    switch_cs_real_mode(0xF000);

    switch_seg(SS, 0x30);
    write_reg32(ESP, 0x100);

    jit::jit_clear_cache(jit::get_jit_state());
}
