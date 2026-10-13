#![allow(non_upper_case_globals)]

use crate::config;
use crate::cpu::fpu::fpu_set_tag_word;
use crate::cpu::global_pointers::*;
use crate::cpu::memory;
use crate::cpu::misc_instr::{
    adjust_stack_reg, get_stack_pointer, getaf, getcf, getof, getpf, getsf, getzf, pop16, pop32s,
    push16, push32,
};
use crate::cpu::modrm::{resolve_modrm16, resolve_modrm32};
use crate::cpu::{apic, ioapic, pic};
use crate::dbg::dbg_trace;
use crate::gen;
use crate::jit;
use crate::page::Page;
use crate::paging::OrPageFault;
use crate::prefix;
use crate::profiler;
use crate::profiler::stat;
use crate::softfloat;
use crate::state_flags::CachedStateFlags;

use std::collections::HashSet;

pub mod js {
    #[link(wasm_import_module = "env")]
    extern "C" {
        pub fn cpu_exception_hook(interrupt: i32) -> bool;
        pub fn microtick() -> f64;
        pub fn run_hardware_timers(acpi_enabled: bool, t: f64) -> f64;
        pub fn cpu_event_halt();
        pub fn stop_idling();

        pub fn io_port_read8(port: i32) -> i32;
        pub fn io_port_read16(port: i32) -> i32;
        pub fn io_port_read32(port: i32) -> i32;

        pub fn io_port_write8(port: i32, value: i32);
        pub fn io_port_write16(port: i32, value: i32);
        pub fn io_port_write32(port: i32, value: i32);

        pub fn get_rand_int() -> i32;
    }
}

/// The offset for our generated functions in the wasm table. Every index less than this is
/// reserved for rustc's indirect functions
pub const WASM_TABLE_OFFSET: u32 = 1024;

#[derive(Copy, Clone)]
#[repr(C)]
#[repr(align(16))]
pub union reg128 {
    pub i8: [i8; 16],
    pub i16: [i16; 8],
    pub i32: [i32; 4],
    pub i64: [i64; 2],
    pub u8: [u8; 16],
    pub u16: [u16; 8],
    pub u32: [u32; 4],
    pub u64: [u64; 2],
    pub f32: [f32; 4],
    pub f64: [f64; 2],
}

impl reg128 {
    /// The register's 128 bits (lane 0 in the low bits)
    pub fn bits(self) -> u128 { unsafe { std::mem::transmute(self) } }
    pub fn of_bits(bits: u128) -> reg128 { unsafe { std::mem::transmute(bits) } }
}

pub const INTERPRETER_ITERATION_LIMIT: u32 = 100_001;

// How often, in milliseconds, to yield to the browser for rendering and running events
pub const TIME_PER_FRAME: f64 = 1.0;

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
pub const CR4_OSXSAVE: i32 = 1 << 18;
pub const CR4_SMEP: i32 = 1 << 20;
/// The CR4 bits MOV to CR4 (legacy and x64) and RSM accept, those of the
/// features this CPU has: VME through OSXMMEXCPT, OSXSAVE with XSAVE
pub fn cr4_valid_bits() -> u32 {
    0x7FF
        | if crate::cpu::features::has(crate::cpu::features::XSAVE) {
            CR4_OSXSAVE as u32
        }
        else {
            0
        }
}

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

pub const IA32_TIME_STAMP_COUNTER: i32 = 0x10;
pub const IA32_PLATFORM_ID: i32 = 0x17;
pub const IA32_APIC_BASE: i32 = 0x1B;
pub const MSR_TEST_CTRL: i32 = 0x33;
pub const MSR_SMI_COUNT: i32 = 0x34;
pub const IA32_FEAT_CTL: i32 = 0x3A;
pub const IA32_SPEC_CTRL: i32 = 0x48;
pub const IA32_BIOS_UPDT_TRIG: i32 = 0x79;
pub const IA32_BIOS_SIGN_ID: i32 = 0x8B;
pub const IA32_PMC0: i32 = 0xC1;
pub const IA32_PMC1: i32 = 0xC2;
pub const MSR_PLATFORM_INFO: i32 = 0xCE;
pub const MSR_TSX_FORCE_ABORT: i32 = 0x10F;
pub const IA32_TSX_CTRL: i32 = 0x122;
pub const IA32_MCU_OPT_CTRL: i32 = 0x123;
pub const MISC_FEATURE_ENABLES: i32 = 0x140;
pub const IA32_SYSENTER_CS: i32 = 0x174;
pub const IA32_SYSENTER_ESP: i32 = 0x175;
pub const IA32_SYSENTER_EIP: i32 = 0x176;
pub const IA32_MCG_CAP: i32 = 0x179;
pub const IA32_PERFEVTSEL0: i32 = 0x186;
pub const IA32_PERFEVTSEL1: i32 = 0x187;
pub const IA32_MISC_ENABLE: i32 = 0x1A0;
pub const IA32_PAT: i32 = 0x277;
pub const IA32_RTIT_CTL: i32 = 0x570;
pub const MSR_PKG_C2_RESIDENCY: i32 = 0x60D;
pub const IA32_FS_BASE: i32 = 0xC0000100u32 as i32;
pub const IA32_GS_BASE: i32 = 0xC0000101u32 as i32;
pub const MSR_AMD64_LS_CFG: i32 = 0xC0011020u32 as i32;
pub const MSR_AMD64_DE_CFG: i32 = 0xC0011029u32 as i32;

pub const IA32_APIC_BASE_BSP: i32 = 1 << 8;
pub const IA32_APIC_BASE_EXTD: i32 = 1 << 10;
pub const IA32_APIC_BASE_EN: i32 = 1 << 11;

pub const IOAPIC_MEM_ADDRESS: u32 = 0xFEC00000;
pub const IOAPIC_MEM_SIZE: u32 = 32;
pub const APIC_MEM_ADDRESS: u32 = 0xFEE00000;
pub const APIC_MEM_SIZE: u32 = 0x1000;

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
/// Filled by an IA-32e data access (fill_ia32e_tlb): the entry serves data
/// accesses of compiled 32-bit code but does not show that the page is
/// executable (NX was not checked), so code validation treats it as a miss.
pub const TLB_IA32E_DATA: i32 = 1 << 6;
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

// should probably be kept in sync with APIC_TIMER_FREQ in apic.js
pub const TSC_RATE: f64 = 1_000_000.0;

pub static mut cpuid_level: u32 = 0x16;

pub static mut jit_block_boundary: bool = false;

#[cfg(debug_assertions)]
pub static mut tsc_last_extra: u64 = 0;

// the last value returned by rdtsc
pub static mut tsc_last_value: u64 = 0;
// the smallest difference between two rdtsc readings (depends on the browser's performance.now resolution)
pub static mut tsc_resolution: u64 = u64::MAX;
// how many times rdtsc was called and had to return the same value (due to browser's performance.now resolution)
pub static mut tsc_number_of_same_readings: u64 = 0;
// how often rdtsc was previously called without its value changing, used for interpolating quick
// consecutive calls between rdtsc (when it's called faster than the browser's performance.now
// changes)
pub static mut tsc_speed: u64 = 1;

// used for restoring the state
pub static mut tsc_offset: u64 = 0;

/// Set by PAUSE when the machine has more than one core: the active core ends
/// its slice so that another one can run, e.g. to release a spinlock the
/// spinning core waits for (see CPU.prototype.run_cores)
pub static mut core_yield: bool = false;

/// Compiled 32-bit code in IA-32e compatibility mode (tests may turn it off
/// to compare with the interpreter). The IR's system-instruction helpers
/// (SYSENTER/SYSEXIT, far transfers, IRET, LAR/LSL, segment loads) call the
/// same CPU functions the interpreter uses in compatibility mode.
static mut X64_COMPAT_JIT: bool = true;
pub unsafe fn compat_jit() -> bool { X64_COMPAT_JIT }
#[no_mangle]
pub unsafe fn x64_set_compat_jit(enabled: bool) { X64_COMPAT_JIT = enabled; }

#[no_mangle]
pub unsafe fn request_core_yield() {
    core_yield = true;
    jit_block_boundary = true;
}

/// A spin-wait hint (PAUSE) or a bounded REP step with several cores: when
/// they share this thread (cooperative scheduling), let another one run. A
/// core with a thread of its own (crate::parallel) only leaves the current
/// compiled block: ending its slice would not let anyone else run sooner,
/// and on the machine's thread it would return to the event loop each time.
pub unsafe fn yield_to_other_cores() {
    if !crate::parallel::active() {
        core_yield = true;
    }
    jit_block_boundary = true;
}

/// A worker instance takes the machine instance's CPU profile (CPUID level
/// and features) and compiler policy: when it attaches and at the start of
/// each slice (crate::parallel::sync_worker_configuration), so that every
/// core reports the same CPU even when the embedder changes the profile after
/// the workers started. JavaScript applies the other settings to it the same
/// way as to the machine instance.
pub unsafe fn copy_machine_configuration() {
    use crate::parallel::machine;
    cpuid_level = *machine(&raw mut cpuid_level);
    X64_COMPAT_JIT = *machine(&raw mut X64_COMPAT_JIT);
    crate::cpu::instructions_0f::copy_cpu_profile();
    crate::jit_switches::copy_from_machine();
}

pub static mut tlb_data: [i32; 0x100000] = [0; 0x100000];

pub static mut valid_tlb_entries: [i32; 10000] = [0; 10000];
pub static mut valid_tlb_entries_count: i32 = 0;

pub enum LastJump {
    Interrupt {
        phys_addr: u32,
        int: u8,
        software: bool,
        error: Option<u32>,
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
            LastJump::Interpreted { phys_addr } => Some(*phys_addr),
            LastJump::None => None,
        }
    }
    pub fn name(&self) -> &'static str {
        match self {
            LastJump::Interrupt { .. } => "interrupt",
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

    pub fn accessed(&self) -> bool { self.access_byte() & 1 == 1 }
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
    pub fn set_busy(&self) -> SegmentDescriptor {
        SegmentDescriptor {
            raw: self.raw | 2 << 40,
        }
    }
    pub fn clear_busy(&self) -> SegmentDescriptor {
        SegmentDescriptor {
            raw: self.raw & !(2 << 40),
        }
    }
    pub fn set_accessed(&self) -> SegmentDescriptor {
        SegmentDescriptor {
            raw: self.raw | 1 << 40,
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

// Descriptor/TSS reads are supervisor accesses and can straddle guest pages.
unsafe fn read_system(addr: i32, size: u32) -> OrPageFault<u64> {
    if crate::x64::state::efer() & crate::x64::state::EFER_LMA != 0 {
        return crate::x64::memory::read_system(addr as u32 as u64, (size * 8) as u8)
            .map_err(|fault| crate::x64::system::raise(fault));
    }
    let first = translate_address_system_read(addr)?;
    if (addr as u32 & 0xFFF) + size <= 4096 {
        return Ok(match size {
            8 => memory::read64s(first) as u64,
            4 => memory::read32s(first) as u32 as u64,
            2 => memory::read16(first) as u64,
            _ => unreachable!(),
        });
    }
    let mut physical = [0u32; 8];
    for i in 0..size {
        physical[i as usize] = translate_address_system_read(addr.wrapping_add(i as i32))?;
    }
    let mut value = 0;
    for i in 0..size {
        value |= (memory::read8(physical[i as usize]) as u64) << (i * 8);
    }
    Ok(value)
}

unsafe fn get_tss_ss_esp(dpl: u8) -> OrPageFault<(i32, i32)> {
    let offset = if *tss_size_32 { ((dpl as u32) << 3) + 4 } else { ((dpl as u32) << 2) + 2 };
    let size = if *tss_size_32 { 4 } else { 2 };
    if offset + size + 1 > *segment_limits.offset(TR as isize) {
        trigger_ts(*sreg.offset(TR as isize) as i32 & !3);
        return Err(());
    }
    let addr = (*segment_offsets.offset(TR as isize)).wrapping_add(offset as i32);
    let esp = read_system(addr, size)? as i32;
    let ss = read_system(addr.wrapping_add(size as i32), 2)? as i32;
    Ok((ss, esp))
}

pub unsafe fn iret16() { iret(true); }
pub unsafe fn iret32() { iret(false); }

pub unsafe fn iret(is_16: bool) {
    crate::parallel::code::poll();
    iret_checked(is_16);
}

/// Reports whether the semantic body completed; delivered faults remain CPU-owned.
pub unsafe fn iret_checked(is_16: bool) -> bool {
    // IRET ends NMI blocking (also when it faults)
    *nmi_blocked = false;
    *interrupt_shadow = 0;
    let mut completed = true;
    if vm86_mode() && getiopl() < 3 {
        // vm86 mode, iopl != 3
        dbg_log!("#gp iret vm86 mode, iopl != 3");
        trigger_gp(0);
        return false;
    }

    let (new_eip, new_cs, mut new_flags) = if is_16 {
        (
            return_on_pagefault!(safe_read16(get_stack_pointer(0)), false),
            return_on_pagefault!(safe_read16(get_stack_pointer(2)), false),
            return_on_pagefault!(safe_read16(get_stack_pointer(4)), false),
        )
    }
    else {
        (
            return_on_pagefault!(safe_read32s(get_stack_pointer(0)), false),
            return_on_pagefault!(safe_read16(get_stack_pointer(4)), false),
            return_on_pagefault!(safe_read32s(get_stack_pointer(8)), false),
        )
    };

    if !*protected_mode || (vm86_mode() && getiopl() == 3) {
        if new_eip as u32 & 0xFFFF0000 != 0 {
            trigger_gp(0);
            return false;
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

        update_state_flags();
        handle_irqs();
        return completed;
    }

    dbg_assert!(!vm86_mode());

    if *flags & FLAG_NT != 0 {
        // nested task: return to the task linked through the back-link field of the current tss
        let tss_offset = *segment_offsets.offset(TR as isize);
        let backlink = return_on_pagefault!(safe_read16(tss_offset + TSR_BACKLINK), false);
        return do_task_switch_checked(backlink, None, TaskSwitchSource::Iret);
    }

    if new_flags & FLAG_VM != 0 {
        if *cpl == 0 {
            // return to virtual 8086 mode

            // vm86 cannot be set in 16 bit flag
            dbg_assert!(!is_16);

            let temp_esp = return_on_pagefault!(safe_read32s(get_stack_pointer(12)), false);
            let temp_ss = return_on_pagefault!(safe_read16(get_stack_pointer(16)), false);

            let new_es = return_on_pagefault!(safe_read16(get_stack_pointer(20)), false);
            let new_ds = return_on_pagefault!(safe_read16(get_stack_pointer(24)), false);
            let new_fs = return_on_pagefault!(safe_read16(get_stack_pointer(28)), false);
            let new_gs = return_on_pagefault!(safe_read16(get_stack_pointer(32)), false);

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
                completed = false;
            }

            adjust_stack_reg(9 * 4); // 9 dwords: eip, cs, flags, esp, ss, es, ds, fs, gs

            write_reg32(ESP, temp_esp);
            if !switch_seg(SS, temp_ss) {
                // XXX
                dbg_assert!(false);
                completed = false;
            }

            *cpl = 3;
            cpl_changed();

            update_cs_size(false);
            update_state_flags();

            // iret end
            return completed;
        }
        else {
            dbg_log!("vm86 flag ignored because cpl != 0");
            new_flags &= !FLAG_VM;
        }
    }

    // protected mode return

    let cs_selector = SegmentSelector::of_u16(new_cs as u16);
    let cs_descriptor = match return_on_pagefault!(lookup_segment_selector(cs_selector), false) {
        Ok((desc, _)) => desc,
        Err(SelectorNullOrInvalid::IsNull) => {
            trigger_gp(0);
            return false;
        },
        Err(SelectorNullOrInvalid::OutsideOfTableLimit) => {
            trigger_gp(new_cs & !3);
            return false;
        },
    };

    if cs_descriptor.is_system() || !cs_descriptor.is_executable() {
        trigger_gp(new_cs & !3);
        return false;
    }
    if cs_selector.rpl() < *cpl {
        trigger_gp(new_cs & !3);
        return false;
    }
    if cs_descriptor.is_dc() && cs_descriptor.dpl() > cs_selector.rpl() {
        trigger_gp(new_cs & !3);
        return false;
    }

    if !cs_descriptor.is_dc() && cs_selector.rpl() != cs_descriptor.dpl() {
        dbg_log!(
            "#gp iret: non-conforming cs and rpl != dpl, dpl={} rpl={}",
            cs_descriptor.dpl(),
            cs_selector.rpl()
        );
        trigger_gp(new_cs & !3);
        return false;
    }

    if !cs_descriptor.is_present() {
        trigger_np(new_cs & !3);
        return false;
    }
    if new_eip as u32 > cs_descriptor.effective_limit() {
        trigger_gp(0);
        return false;
    }

    if cs_selector.rpl() > *cpl {
        // outer privilege return
        let (temp_esp, temp_ss) = if is_16 {
            (
                return_on_pagefault!(safe_read16(get_stack_pointer(6)), false),
                return_on_pagefault!(safe_read16(get_stack_pointer(8)), false),
            )
        }
        else {
            (
                return_on_pagefault!(safe_read32s(get_stack_pointer(12)), false),
                return_on_pagefault!(safe_read16(get_stack_pointer(16)), false),
            )
        };

        let ss_selector = SegmentSelector::of_u16(temp_ss as u16);
        let ss_descriptor = match return_on_pagefault!(lookup_segment_selector(ss_selector), false)
        {
            Ok((desc, _)) => desc,
            Err(SelectorNullOrInvalid::IsNull) => {
                dbg_log!("#GP for loading 0 in SS sel={:x}", temp_ss);
                dbg_trace();
                trigger_gp(0);
                return false;
            },
            Err(SelectorNullOrInvalid::OutsideOfTableLimit) => {
                dbg_log!("#GP for loading invalid in SS sel={:x}", temp_ss);
                trigger_gp(temp_ss & !3);
                return false;
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
            return false;
        }

        if !ss_descriptor.is_present() {
            dbg_log!("#SS for loading non-present in SS sel={:x}", temp_ss);
            dbg_trace();
            trigger_ss(temp_ss & !3);
            return false;
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
            completed = false;
        }

        set_stack_reg(temp_esp);

        if *cpl == 0 && !is_16 {
            *flags = *flags & !FLAG_VIF & !FLAG_VIP | (new_flags & (FLAG_VIF | FLAG_VIP));
        }

        for reg in [ES, DS, FS, GS] {
            let access = *segment_access_bytes.offset(reg as isize);
            let dpl = access >> 5 & 3;
            let executable = access & 8 == 8;
            let conforming = access & 4 == 4;
            if dpl < *cpl && !(executable && conforming) {
                //dbg_log!(
                //    "set segment to null sreg={} dpl={} executable={} conforming={}",
                //    reg,
                //    dpl,
                //    executable,
                //    conforming
                //);
                *segment_is_null.offset(reg as isize) = true;
                *sreg.offset(reg as isize) = 0;
            }
        }
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
    *segment_access_bytes.offset(CS as isize) = cs_descriptor.access_byte();

    *instruction_pointer = new_eip + get_seg_cs();

    update_state_flags();

    // iret end

    handle_irqs();
    completed
}

pub unsafe fn call_interrupt_vector(
    interrupt_nr: i32,
    is_software_int: bool,
    error_code: Option<i32>,
) {
    call_interrupt_vector_checked(interrupt_nr, is_software_int, error_code);
}

/// Reports whether the semantic body completed; delivered faults remain CPU-owned.
pub unsafe fn call_interrupt_vector_checked(
    interrupt_nr: i32,
    is_software_int: bool,
    error_code: Option<i32>,
) -> bool {
    crate::cpu::exceptions::interrupt(interrupt_nr, is_software_int, error_code)
}

fn stack_range_valid(
    start: u32,
    size: u32,
    limit: u32,
    expand_down: bool,
    wide_stack: bool,
) -> bool {
    let Some(last) = start.checked_add(size - 1)
    else {
        return false;
    };
    if expand_down {
        start > limit && last <= if wide_stack { u32::MAX } else { 0xFFFF }
    }
    else {
        last <= limit
    }
}

pub unsafe fn deliver_interrupt(
    interrupt_nr: i32,
    is_software_int: bool,
    error_code: Option<i32>,
) -> bool {
    if crate::x64::state::efer() & crate::x64::state::EFER_LMA != 0 {
        return match crate::x64::system::interrupt(
            interrupt_nr as u8,
            is_software_int,
            error_code.map(|c| c as u32),
        ) {
            Ok(()) => true,
            Err(fault) => {
                crate::x64::system::raise(fault);
                false
            },
        };
    }
    let mut completed = true;
    if *protected_mode {
        if vm86_mode() && *cr.offset(4) & CR4_VME != 0 {
            panic!("Unimplemented: VME");
        }

        if vm86_mode() && is_software_int && getiopl() < 3 {
            dbg_log!("call_interrupt_vector #GP. vm86 && software int && iopl < 3");
            dbg_trace();
            trigger_gp(0);
            return false;
        }

        if interrupt_nr << 3 | 7 > *idtr_size {
            dbg_log!("interrupt_nr={:x} idtr_size={:x}", interrupt_nr, *idtr_size);
            dbg_trace();
            trigger_gp(interrupt_nr << 3 | 2);
            return false;
        }

        let descriptor = InterruptDescriptor::of_u64(return_on_pagefault!(
            read_system((*idtr_offset).wrapping_add(interrupt_nr << 3), 8),
            false
        ));

        let mut offset = descriptor.offset();
        let selector = descriptor.selector() as i32;
        let dpl = descriptor.dpl();
        let gate_type = descriptor.gate_type();

        if is_software_int && dpl < *cpl {
            dbg_log!("#gp software interrupt ({:x}) and dpl < cpl", interrupt_nr);
            dbg_trace();
            trigger_gp(interrupt_nr << 3 | 2);
            return false;
        }

        if gate_type != InterruptDescriptor::TRAP_GATE
            && gate_type != InterruptDescriptor::INTERRUPT_GATE
            && gate_type != InterruptDescriptor::TASK_GATE
        {
            // invalid gate_type
            dbg_log!(
                "gate type invalid. gate_type=0b{:b} raw={:b}",
                gate_type,
                descriptor.raw
            );
            dbg_trace();
            trigger_gp(interrupt_nr << 3 | 2);
            return false;
        }

        if !descriptor.reserved_zeros_are_valid() {
            dbg_log!(
                "reserved 0s violated. gate_type=0b{:b} raw={:b}",
                gate_type,
                descriptor.raw
            );
            dbg_trace();
            trigger_gp(interrupt_nr << 3 | 2);
            return false;
        }

        if !descriptor.is_present() {
            // present bit not set
            dbg_log!("#np int descriptor not present, int={}", interrupt_nr);
            trigger_np(interrupt_nr << 3 | 2);
            return false;
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
            return do_task_switch_checked(selector, error_code, TaskSwitchSource::CallOrInt);
        }

        let cs_segment_descriptor = match return_on_pagefault!(
            lookup_segment_selector(SegmentSelector::of_u16(selector as u16)),
            false
        ) {
            Ok((desc, _)) => desc,
            Err(SelectorNullOrInvalid::IsNull) => {
                dbg_log!("is null");
                trigger_gp(selector & !3);
                return false;
            },
            Err(SelectorNullOrInvalid::OutsideOfTableLimit) => {
                dbg_log!("is invalid");
                trigger_gp(selector & !3);
                return false;
            },
        };

        if cs_segment_descriptor.is_system()
            || !cs_segment_descriptor.is_executable()
            || cs_segment_descriptor.dpl() > *cpl
        {
            dbg_log!("not exec");
            trigger_gp(selector & !3);
            return false;
        }
        if !cs_segment_descriptor.is_present() {
            trigger_np(selector & !3);
            return false;
        }

        if offset as u32 > cs_segment_descriptor.effective_limit() {
            trigger_gp(0);
            return false;
        }

        let old_flags = get_eflags();

        if !cs_segment_descriptor.is_dc() && cs_segment_descriptor.dpl() < *cpl {
            // inter privilege level interrupt
            // interrupt from vm86 mode

            if old_flags & FLAG_VM != 0 && cs_segment_descriptor.dpl() != 0 {
                trigger_gp(selector & !3);
                return false;
            }

            let (new_ss, new_esp) =
                return_on_pagefault!(get_tss_ss_esp(cs_segment_descriptor.dpl()), false);

            let ss_segment_selector = SegmentSelector::of_u16(new_ss as u16);
            let ss_segment_descriptor =
                match return_on_pagefault!(lookup_segment_selector(ss_segment_selector), false) {
                    Ok((desc, _)) => desc,
                    Err(
                        SelectorNullOrInvalid::IsNull | SelectorNullOrInvalid::OutsideOfTableLimit,
                    ) => {
                        trigger_ts(new_ss & !3);
                        return false;
                    },
                };

            if ss_segment_descriptor.is_system() || !ss_segment_descriptor.is_writable() {
                trigger_ts(new_ss & !3);
                return false;
            }

            if ss_segment_selector.rpl() != cs_segment_descriptor.dpl() {
                trigger_ts(new_ss & !3);
                return false;
            }
            if ss_segment_descriptor.dpl() != cs_segment_descriptor.dpl()
                || !ss_segment_descriptor.is_rw()
            {
                trigger_ts(new_ss & !3);
                return false;
            }
            if !ss_segment_descriptor.is_present() {
                trigger_ss(new_ss & !3);
                return false;
            }

            let old_esp = read_reg32(ESP);
            let old_ss = *sreg.offset(SS as isize) as i32;

            let error_code_space = if error_code.is_some() { 1 } else { 0 };
            let vm86_space = if (old_flags & FLAG_VM) == FLAG_VM { 4 } else { 0 };
            let bytes_per_arg = if descriptor.is_32() { 4 } else { 2 };

            let stack_space = bytes_per_arg * (5 + error_code_space + vm86_space);
            let stack_offset = (new_esp as u32).wrapping_sub(stack_space as u32)
                & if ss_segment_descriptor.is_32() { u32::MAX } else { 0xFFFF };
            if !stack_range_valid(
                stack_offset,
                stack_space as u32,
                ss_segment_descriptor.effective_limit(),
                ss_segment_descriptor.is_dc(),
                ss_segment_descriptor.is_32(),
            ) {
                trigger_ss(new_ss & !3);
                return false;
            }
            let new_stack_pointer = ss_segment_descriptor.base()
                + if ss_segment_descriptor.is_32() {
                    new_esp - stack_space
                }
                else {
                    new_esp - stack_space & 0xFFFF
                };

            return_on_pagefault!(translate_address_system_write(new_stack_pointer), false);
            return_on_pagefault!(
                translate_address_system_write(ss_segment_descriptor.base() + new_esp - 1),
                false
            );

            // no exceptions below
            *cpl = cs_segment_descriptor.dpl();
            cpl_changed();

            update_cs_size(cs_segment_descriptor.is_32());

            *flags &= !FLAG_VM & !FLAG_RF;

            if !switch_seg(SS, new_ss) {
                // XXX
                dbg_assert!(false);
                completed = false;
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
                push16(old_esp & 0xFFFF).unwrap();
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
                return false;
            }

            let bytes_per_arg = if descriptor.is_32() { 4 } else { 2 };
            let error_code_space = if error_code.is_some() { 1 } else { 0 };

            let stack_space = bytes_per_arg * (3 + error_code_space);

            let stack_offset = (get_stack_pointer(-stack_space) as u32)
                .wrapping_sub(*segment_offsets.offset(SS as isize) as u32);
            if !stack_range_valid(
                stack_offset,
                stack_space as u32,
                *segment_limits.offset(SS as isize),
                *segment_access_bytes.offset(SS as isize) & 4 != 0,
                *stack_size_32,
            ) {
                trigger_ss(0);
                return false;
            }
            return_on_pagefault!(
                writable_or_pagefault(get_stack_pointer(-stack_space), stack_space),
                false
            );

        // no exceptions below
        }
        else {
            trigger_gp(selector & !3);
            return false;
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
            push16(old_flags & 0xFFFF).unwrap();
            push16(*sreg.offset(CS as isize) as i32).unwrap();
            push16(get_real_eip() & 0xFFFF).unwrap();

            if let Some(ec) = error_code {
                dbg_assert!(ec >= 0 && ec < 0x10000);
                push16(ec).unwrap();
            }

            offset &= 0xFFFF;
        }

        if old_flags & FLAG_VM != 0 {
            if !switch_seg(GS, 0) || !switch_seg(FS, 0) || !switch_seg(DS, 0) || !switch_seg(ES, 0)
            {
                // can't fail
                dbg_assert!(false);
                completed = false;
            }
        }

        *sreg.offset(CS as isize) = (selector as u16) & !3 | *cpl as u16;
        dbg_assert!((*sreg.offset(CS as isize) & 3) == *cpl as u16);

        update_cs_size(cs_segment_descriptor.is_32());

        *segment_limits.offset(CS as isize) = cs_segment_descriptor.effective_limit();
        *segment_offsets.offset(CS as isize) = cs_segment_descriptor.base();
        *segment_access_bytes.offset(CS as isize) = cs_segment_descriptor.access_byte();

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

        update_state_flags();
    }
    else {
        // call 4 byte cs:ip interrupt vector from ivt at cpu.memory 0

        let index = (interrupt_nr << 2) as u32;
        let new_ip = memory::read16(index);
        let new_cs = memory::read16(index + 2);

        dbg_assert!(
            index | 3 <= IVT_SIZE,
            "Unimplemented: #GP for interrupt number out of IVT bounds"
        );

        // XXX: #SS if stack would cross stack limit

        // push flags, cs:ip
        push16(get_eflags() & 0xFFFF).unwrap();
        push16(*sreg.offset(CS as isize) as i32).unwrap();
        push16(get_real_eip() & 0xFFFF).unwrap();

        *flags &= !FLAG_INTERRUPT & !FLAG_AC & !FLAG_TRAP;

        switch_cs_real_mode(new_cs);
        *instruction_pointer = get_seg_cs() + new_ip;
        update_state_flags();
    }
    completed
}

pub unsafe fn far_jump(eip: i32, selector: i32, is_call: bool, is_osize_32: bool) {
    far_jump_checked(eip, selector, is_call, is_osize_32);
}

/// Reports whether the semantic body completed; delivered faults remain CPU-owned.
pub unsafe fn far_jump_checked(eip: i32, selector: i32, is_call: bool, is_osize_32: bool) -> bool {
    let mut completed = true;
    dbg_assert!(selector < 0x10000 && selector >= 0);

    if !*protected_mode || vm86_mode() {
        if is_call {
            if is_osize_32 {
                return_on_pagefault!(writable_or_pagefault(get_stack_pointer(-8), 8), false);

                push32(*sreg.offset(CS as isize) as i32).unwrap();
                push32(get_real_eip()).unwrap();
            }
            else {
                return_on_pagefault!(writable_or_pagefault(get_stack_pointer(-4), 4), false);

                push16(*sreg.offset(CS as isize) as i32).unwrap();
                push16(get_real_eip()).unwrap();
            }
        }
        switch_cs_real_mode(selector);
        *instruction_pointer = get_seg_cs() + eip;
        update_state_flags();
        return completed;
    }

    let cs_selector = SegmentSelector::of_u16(selector as u16);
    let info = match return_on_pagefault!(lookup_segment_selector(cs_selector), false) {
        Ok((desc, _)) => desc,
        Err(SelectorNullOrInvalid::IsNull) => {
            dbg_log!("#gp null cs");
            trigger_gp(0);
            return false;
        },
        Err(SelectorNullOrInvalid::OutsideOfTableLimit) => {
            dbg_log!("#gp invalid cs: {:x}", selector);
            trigger_gp(selector & !3);
            return false;
        },
    };

    if info.is_system() {
        dbg_log!("system type cs: {:x}", selector);

        if info.system_type() == 0xC || info.system_type() == 4 {
            // call gate
            dbg_assert!(is_call, "TODO: Jump through call gate");

            let is_16 = info.system_type() == 4;

            if info.dpl() < *cpl || info.dpl() < cs_selector.rpl() {
                dbg_log!("#gp cs gate dpl < cpl or dpl < rpl: {:x}", selector);
                trigger_gp(selector & !3);
                return false;
            }

            if !info.is_present() {
                dbg_log!("#NP for loading not-present in gate cs sel={:x}", selector);
                trigger_np(selector & !3);
                return false;
            }

            let cs_selector = (info.raw >> 16) as i32;

            let cs_info = match return_on_pagefault!(
                lookup_segment_selector(SegmentSelector::of_u16(cs_selector as u16)),
                false
            ) {
                Ok((desc, _)) => desc,
                Err(SelectorNullOrInvalid::IsNull) => {
                    dbg_log!("#gp null cs");
                    trigger_gp(0);
                    return false;
                },
                Err(SelectorNullOrInvalid::OutsideOfTableLimit) => {
                    dbg_log!("#gp invalid cs: {:x}", cs_selector);
                    trigger_gp(cs_selector & !3);
                    return false;
                },
            };

            if cs_info.is_system() {
                dbg_log!("#gp non-code cs: {:x}", cs_selector);
                trigger_gp(cs_selector & !3);
                return false;
            }

            if !cs_info.is_executable() {
                dbg_log!("#gp non-executable cs: {:x}", cs_selector);
                trigger_gp(cs_selector & !3);
                return false;
            }

            if cs_info.dpl() > *cpl {
                dbg_log!("#gp dpl > cpl: {:x}", cs_selector);
                trigger_gp(cs_selector & !3);
                return false;
            }

            if !cs_info.is_present() {
                dbg_log!("#NP for loading not-present in cs sel={:x}", cs_selector);
                trigger_np(cs_selector & !3);
                return false;
            }

            if !cs_info.is_dc() && cs_info.dpl() < *cpl {
                dbg_log!(
                    "more privilege call gate is_16={} from={} to={}",
                    is_16,
                    *cpl,
                    cs_info.dpl()
                );
                let (new_ss, new_esp) = return_on_pagefault!(get_tss_ss_esp(cs_info.dpl()), false);

                let ss_selector = SegmentSelector::of_u16(new_ss as u16);
                let ss_info =
                    match return_on_pagefault!(lookup_segment_selector(ss_selector), false) {
                        Ok((desc, _)) => desc,
                        Err(SelectorNullOrInvalid::IsNull) => {
                            panic!("null ss: {}", new_ss);
                        },
                        Err(SelectorNullOrInvalid::OutsideOfTableLimit) => {
                            panic!("invalid ss: {}", new_ss);
                        },
                    };

                if ss_info.is_dc() {
                    dbg_assert!(new_esp as u32 > ss_info.effective_limit());
                }
                else {
                    dbg_assert!(new_esp as u32 - 1 <= ss_info.effective_limit());
                }
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
                    return_on_pagefault!(
                        writable_or_pagefault_cpl(
                            cs_info.dpl(),
                            ss_info.base() + new_esp - stack_space,
                            stack_space
                        ),
                        false
                    );
                }
                else {
                    return_on_pagefault!(
                        writable_or_pagefault_cpl(
                            cs_info.dpl(),
                            ss_info.base() + (new_esp - stack_space & 0xFFFF),
                            stack_space
                        ),
                        false
                    );
                }

                let old_esp = read_reg32(ESP);
                let old_ss = *sreg.offset(SS as isize);
                let old_stack_pointer = get_stack_pointer(0);

                //dbg_log!("old_esp=" + h(old_esp));

                *cpl = cs_info.dpl();
                cpl_changed();

                update_cs_size(cs_info.is_32());

                dbg_assert!(new_ss & 3 == cs_info.dpl() as i32);
                // XXX: Should be checked before side effects
                if !switch_seg(SS, new_ss) {
                    dbg_assert!(false);
                    completed = false;
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
                            let parameter = safe_read16(old_stack_pointer + 2 * i).unwrap();
                            push16(parameter).unwrap();
                        }

                        //writable_or_pagefault(get_stack_pointer(-4), 4);
                        push16(*sreg.offset(CS as isize) as i32).unwrap();
                        push16(get_real_eip()).unwrap();
                    }
                    else {
                        for i in (0..parameter_count).rev() {
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

                if is_call {
                    if is_16 {
                        return_on_pagefault!(
                            writable_or_pagefault(get_stack_pointer(-4), 4),
                            false
                        );

                        push16(*sreg.offset(CS as isize) as i32).unwrap();
                        push16(get_real_eip()).unwrap();
                    }
                    else {
                        return_on_pagefault!(
                            writable_or_pagefault(get_stack_pointer(-8), 8),
                            false
                        );

                        push32(*sreg.offset(CS as isize) as i32).unwrap();
                        push32(get_real_eip()).unwrap();
                    }
                }

                dbg_assert!(*cpl == cs_info.dpl());
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
            *segment_access_bytes.offset(CS as isize) = cs_info.access_byte();
            *sreg.offset(CS as isize) = cs_selector as u16 & !3 | *cpl as u16;
            dbg_assert!(*sreg.offset(CS as isize) & 3 == *cpl as u16);

            *instruction_pointer = get_seg_cs() + new_eip;

            update_state_flags();
        }
        else if info.system_type() == 1 || info.system_type() == 9 {
            // available tss
            if info.dpl() < *cpl || info.dpl() < cs_selector.rpl() {
                dbg_log!("#gp tss dpl < cpl or dpl < rpl: {:x}", selector);
                trigger_gp(selector & !3);
                return false;
            }

            if !info.is_present() {
                dbg_log!("#NP for loading not-present tss sel={:x}", selector);
                trigger_np(selector & !3);
                return false;
            }

            completed &= do_task_switch_checked(
                selector,
                None,
                if is_call { TaskSwitchSource::CallOrInt } else { TaskSwitchSource::Jump },
            );
        }
        else if info.system_type() == 5 {
            // task gate
            if info.dpl() < *cpl || info.dpl() < cs_selector.rpl() {
                dbg_log!("#gp task gate dpl < cpl or dpl < rpl: {:x}", selector);
                trigger_gp(selector & !3);
                return false;
            }

            if !info.is_present() {
                dbg_log!("#NP for loading not-present task gate sel={:x}", selector);
                trigger_np(selector & !3);
                return false;
            }

            let tss_selector = (info.raw >> 16) as i32 & 0xFFFF;
            completed &= do_task_switch_checked(
                tss_selector,
                None,
                if is_call { TaskSwitchSource::CallOrInt } else { TaskSwitchSource::Jump },
            );
        }
        else {
            // busy TSS, LDT, interrupt/trap gates, reserved types
            dbg_log!(
                "#gp far transfer to system type {:x}: {:x}",
                info.system_type(),
                selector
            );
            trigger_gp(selector & !3);
            return false;
        }
    }
    else {
        if !info.is_executable() {
            dbg_log!("#gp non-executable cs: {:x}", selector);
            trigger_gp(selector & !3);
            return false;
        }

        if info.is_dc() {
            // conforming code segment
            if info.dpl() > *cpl {
                dbg_log!("#gp cs dpl > cpl: {:x}", selector);
                trigger_gp(selector & !3);
                return false;
            }
        }
        else {
            // non-conforming code segment

            if cs_selector.rpl() > *cpl || info.dpl() != *cpl {
                dbg_log!("#gp cs rpl > cpl or dpl != cpl: {:x}", selector);
                trigger_gp(selector & !3);
                return false;
            }
        }

        if !info.is_present() {
            dbg_log!("#NP for loading not-present in cs sel={:x}", selector);
            dbg_trace();
            trigger_np(selector & !3);
            return false;
        }

        if is_call {
            if is_osize_32 {
                return_on_pagefault!(writable_or_pagefault(get_stack_pointer(-8), 8), false);

                push32(*sreg.offset(CS as isize) as i32).unwrap();
                push32(get_real_eip()).unwrap();
            }
            else {
                return_on_pagefault!(writable_or_pagefault(get_stack_pointer(-4), 4), false);

                push16(*sreg.offset(CS as isize) as i32).unwrap();
                push16(get_real_eip()).unwrap();
            }
        }

        let long =
            crate::x64::state::efer() & crate::x64::state::EFER_LMA != 0 && info.flags() & 2 != 0;
        if long && info.is_32() || !long && eip as u32 > info.effective_limit() {
            trigger_gp(0);
            return false;
        }
        *x64_cs_long = long as u8;
        *x64_rip_hi = 0;
        update_cs_size(info.is_32());

        *segment_is_null.offset(CS as isize) = false;
        *segment_limits.offset(CS as isize) = info.effective_limit();
        *segment_access_bytes.offset(CS as isize) = info.access_byte();

        *segment_offsets.offset(CS as isize) = if long { 0 } else { info.base() };
        *sreg.offset(CS as isize) = selector as u16 & !3 | *cpl as u16;

        *instruction_pointer = get_seg_cs() + eip;

        update_state_flags();
    }
    completed
}

pub unsafe fn far_return(eip: i32, selector: i32, stack_adjust: i32, is_osize_32: bool) {
    far_return_checked(eip, selector, stack_adjust, is_osize_32);
}

/// Reports whether the semantic body completed; delivered faults remain CPU-owned.
pub unsafe fn far_return_checked(
    eip: i32,
    selector: i32,
    stack_adjust: i32,
    is_osize_32: bool,
) -> bool {
    let mut completed = true;
    dbg_assert!(selector < 0x10000 && selector >= 0);

    if !*protected_mode {
        dbg_assert!(!*is_32);
    }

    if !*protected_mode || vm86_mode() {
        switch_cs_real_mode(selector);
        *instruction_pointer = get_seg_cs() + eip;
        adjust_stack_reg(2 * (if is_osize_32 { 4 } else { 2 }) + stack_adjust);
        update_state_flags();
        return completed;
    }

    let cs_selector = SegmentSelector::of_u16(selector as u16);
    let info = match return_on_pagefault!(lookup_segment_selector(cs_selector), false) {
        Ok((desc, _)) => desc,
        Err(SelectorNullOrInvalid::IsNull) => {
            dbg_log!("far return: #gp null cs");
            trigger_gp(0);
            return false;
        },
        Err(SelectorNullOrInvalid::OutsideOfTableLimit) => {
            dbg_log!("far return: #gp invalid cs: {:x}", selector);
            trigger_gp(selector & !3);
            return false;
        },
    };

    if info.is_system() {
        trigger_gp(selector & !3);
        return false;
    }

    if !info.is_executable() {
        dbg_log!("non-executable cs: {:x}", selector);
        trigger_gp(selector & !3);
        return false;
    }

    if cs_selector.rpl() < *cpl {
        dbg_log!("cs rpl < cpl: {:x}", selector);
        trigger_gp(selector & !3);
        return false;
    }

    if info.is_dc() && info.dpl() > cs_selector.rpl() {
        dbg_log!("cs conforming and dpl > rpl: {:x}", selector);
        trigger_gp(selector & !3);
        return false;
    }

    if !info.is_dc() && info.dpl() != cs_selector.rpl() {
        dbg_log!("cs non-conforming and dpl != rpl: {:x}", selector);
        trigger_gp(selector & !3);
        return false;
    }

    if !info.is_present() {
        dbg_log!("#NP for loading not-present in cs sel={:x}", selector);
        dbg_trace();
        trigger_np(selector & !3);
        return false;
    }

    let long =
        crate::x64::state::efer() & crate::x64::state::EFER_LMA != 0 && info.flags() & 2 != 0;
    if long && info.is_32() || !long && eip as u32 > info.effective_limit() {
        trigger_gp(0);
        return false;
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
            completed = false;
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

        for reg in [ES, DS, FS, GS] {
            let access = *segment_access_bytes.offset(reg as isize);
            let dpl = access >> 5 & 3;
            let executable = access & 8 == 8;
            let conforming = access & 4 == 4;
            if dpl < *cpl && !(executable && conforming) {
                *segment_is_null.offset(reg as isize) = true;
                *sreg.offset(reg as isize) = 0;
            }
        }
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

    *x64_cs_long = long as u8;
    *x64_rip_hi = 0;
    update_cs_size(info.is_32());

    *segment_is_null.offset(CS as isize) = false;
    *segment_limits.offset(CS as isize) = info.effective_limit();
    *segment_access_bytes.offset(CS as isize) = info.access_byte();

    *segment_offsets.offset(CS as isize) = if long { 0 } else { info.base() };
    *sreg.offset(CS as isize) = selector as u16;
    dbg_assert!(selector & 3 == *cpl as i32);

    *instruction_pointer = get_seg_cs() + eip;

    update_state_flags();
    completed
}

#[derive(Copy, Clone, PartialEq)]
pub enum TaskSwitchSource {
    Jump,
    CallOrInt,
    Iret,
}

pub unsafe fn do_task_switch(selector: i32, error_code: Option<i32>, source: TaskSwitchSource) {
    do_task_switch_checked(selector, error_code, source);
}

/// Reports whether the semantic body completed; delivered faults remain CPU-owned.
///
/// SDM Vol.3A §7.3: every check, and every read of the new TSS, happens
/// before the first state change, so a failure there faults in the old task
/// (#TS/#NP/#GP with the TSS selector, or #PF) with nothing modified. After
/// the commit point (old state saved, TR and CR3 switched) a bad LDT or CS
/// selector faults in the context of the new task.
pub unsafe fn do_task_switch_checked(
    selector: i32,
    error_code: Option<i32>,
    source: TaskSwitchSource,
) -> bool {
    dbg_log!("do_task_switch sel={:x}", selector);

    let selector = SegmentSelector::of_u16(selector as u16);
    let error = selector.raw as i32 & !3;
    let (descriptor, descriptor_address) =
        match return_on_pagefault!(lookup_segment_selector(selector), false) {
            Ok(desc) => desc,
            Err(_) => {
                if source == TaskSwitchSource::Iret {
                    trigger_ts(error);
                }
                else {
                    trigger_gp(error);
                }
                return false;
            },
        };

    let tss_type = descriptor.system_type();
    if !selector.is_gdt() || !descriptor.is_system() || !matches!(tss_type, 1 | 3 | 9 | 11) {
        if source == TaskSwitchSource::Iret {
            trigger_ts(error);
        }
        else {
            trigger_gp(error);
        }
        return false;
    }
    let tss_is_16 = tss_type <= 3;
    let tss_is_busy = (tss_type & 2) == 2;

    if source == TaskSwitchSource::Iret {
        if !tss_is_busy {
            // a task return must target a busy task
            trigger_ts(error);
            return false;
        }
    }
    else if tss_is_busy {
        // jump, call or int to a busy task
        trigger_gp(error);
        return false;
    }

    if !descriptor.is_present() {
        trigger_np(error);
        return false;
    }

    if descriptor.effective_limit() < if tss_is_16 { 43 } else { 103 } {
        trigger_ts(error);
        return false;
    }
    if tss_is_16 {
        // 16-bit TSSs (80286 tasks) are not implemented; fail the guest, not the host
        dbg_log!("task switch to a 16-bit TSS: #TS");
        trigger_ts(error);
        return false;
    }

    let tsr_offset = *segment_offsets.offset(TR as isize);
    let new_tsr_offset = descriptor.base();

    let mut old_eflags = get_eflags();
    if tss_is_busy {
        old_eflags &= !FLAG_NT;
    }

    // Everything that can fault before the commit point
    return_on_pagefault!(writable_or_pagefault(tsr_offset, 0x66), false);
    if source == TaskSwitchSource::CallOrInt {
        return_on_pagefault!(
            writable_or_pagefault(new_tsr_offset + TSR_BACKLINK, 2),
            false
        );
    }
    let read32 = |offset| safe_read32s(new_tsr_offset + offset);
    let read16 = |offset| safe_read16(new_tsr_offset + offset);
    let new_cr3 = return_on_pagefault!(read32(TSR_CR3), false);
    let new_eip = return_on_pagefault!(read32(TSR_EIP), false);
    let mut new_eflags = return_on_pagefault!(read32(TSR_EFLAGS), false);
    let mut new_gpr = [0; 8];
    for (i, offset) in [
        TSR_EAX, TSR_ECX, TSR_EDX, TSR_EBX, TSR_ESP, TSR_EBP, TSR_ESI, TSR_EDI,
    ]
    .iter()
    .enumerate()
    {
        new_gpr[i] = return_on_pagefault!(read32(*offset), false);
    }
    let new_cs = return_on_pagefault!(read16(TSR_CS), false);
    let mut new_segments = [0; 4];
    for (i, offset) in [TSR_ES, TSR_SS, TSR_DS, TSR_FS].iter().enumerate() {
        new_segments[i] = return_on_pagefault!(read16(*offset), false);
    }
    let new_gs = return_on_pagefault!(read16(TSR_GS), false);
    let new_ldt = return_on_pagefault!(read16(TSR_LDT), false);

    // Commit: save the old task
    let saved = [
        (TSR_EIP, get_real_eip()),
        (TSR_EFLAGS, old_eflags),
        (TSR_EAX, read_reg32(EAX)),
        (TSR_ECX, read_reg32(ECX)),
        (TSR_EDX, read_reg32(EDX)),
        (TSR_EBX, read_reg32(EBX)),
        (TSR_ESP, read_reg32(ESP)),
        (TSR_EBP, read_reg32(EBP)),
        (TSR_ESI, read_reg32(ESI)),
        (TSR_EDI, read_reg32(EDI)),
        (TSR_ES, *sreg.offset(ES as isize) as i32),
        (TSR_CS, *sreg.offset(CS as isize) as i32),
        (TSR_SS, *sreg.offset(SS as isize) as i32),
        (TSR_DS, *sreg.offset(DS as isize) as i32),
        (TSR_FS, *sreg.offset(FS as isize) as i32),
        (TSR_GS, *sreg.offset(GS as isize) as i32),
    ];
    for (offset, value) in saved {
        return_on_pagefault!(safe_write32(tsr_offset + offset, value), false);
    }

    if source == TaskSwitchSource::Jump || source == TaskSwitchSource::Iret {
        // mark the old task as not busy
        let tr_selector = SegmentSelector::of_u16(*sreg.offset(TR as isize));
        if let Ok((tr_descriptor, tr_descriptor_address)) =
            return_on_pagefault!(lookup_segment_selector(tr_selector), false)
        {
            return_on_pagefault!(
                safe_write64(tr_descriptor_address as i32, tr_descriptor.clear_busy().raw),
                false
            );
        }
    }

    if source != TaskSwitchSource::Iret {
        // jump, call and int mark the new task as busy (iret would not)
        return_on_pagefault!(
            safe_write64(descriptor_address as i32, descriptor.set_busy().raw),
            false
        );
    }

    if source == TaskSwitchSource::CallOrInt {
        return_on_pagefault!(
            safe_write16(
                new_tsr_offset + TSR_BACKLINK,
                *sreg.offset(TR as isize) as i32
            ),
            false
        );
        new_eflags |= FLAG_NT;
    }

    // The new task: TR, CR3 and the general registers
    *segment_offsets.offset(TR as isize) = descriptor.base();
    *segment_limits.offset(TR as isize) = descriptor.effective_limit();
    *sreg.offset(TR as isize) = selector.raw;
    set_cr3(new_cr3);
    *cr.offset(0) |= CR0_TS;
    for (i, reg) in [EAX, ECX, EDX, EBX, ESP, EBP, ESI, EDI].iter().enumerate() {
        write_reg32(*reg, new_gpr[i]);
    }
    *flags &= !FLAG_VM;

    // Faults from here on are taken in the context of the new task
    if !return_on_pagefault!(load_ldt_checked(new_ldt, true), false) {
        return false;
    }

    let new_cpl;
    if new_eflags & FLAG_VM != 0 {
        *segment_is_null.offset(CS as isize) = false;
        *segment_offsets.offset(CS as isize) = new_cs << 4;
        *sreg.offset(CS as isize) = new_cs as u16;
        update_cs_size(false);
        new_cpl = 3;
    }
    else {
        let new_cs_selector = SegmentSelector::of_u16(new_cs as u16);
        let cs_error = new_cs & !3;
        let new_cs_descriptor =
            match return_on_pagefault!(lookup_segment_selector(new_cs_selector), false) {
                Ok((desc, _)) => desc,
                Err(_) => {
                    dbg_log!("task switch: invalid cs {:x}", new_cs);
                    trigger_ts(cs_error);
                    return false;
                },
            };
        if new_cs_descriptor.is_system()
            || !new_cs_descriptor.is_executable()
            || new_cs_descriptor.is_dc() && new_cs_descriptor.dpl() > new_cs_selector.rpl()
            || !new_cs_descriptor.is_dc() && new_cs_descriptor.dpl() != new_cs_selector.rpl()
        {
            trigger_ts(cs_error);
            return false;
        }
        if !new_cs_descriptor.is_present() {
            trigger_np(cs_error);
            return false;
        }

        *segment_is_null.offset(CS as isize) = false;
        *segment_limits.offset(CS as isize) = new_cs_descriptor.effective_limit();
        *segment_offsets.offset(CS as isize) = new_cs_descriptor.base();
        *segment_access_bytes.offset(CS as isize) = new_cs_descriptor.access_byte();
        *sreg.offset(CS as isize) = new_cs as u16;
        update_cs_size(new_cs_descriptor.is_32());

        new_cpl = new_cs_selector.rpl();
    }

    *cpl = 0; // run update_eflags at cpl 0
    update_eflags(new_eflags);
    if new_eflags & FLAG_VM != 0 {
        *flags |= FLAG_VM;
    }
    *cpl = new_cpl;
    cpl_changed();

    *instruction_pointer =
        get_seg_cs() + if new_eflags & FLAG_VM != 0 { new_eip & 0xFFFF } else { new_eip };

    if !switch_seg(ES, new_segments[0])
        || !switch_seg(SS, new_segments[1])
        || !switch_seg(DS, new_segments[2])
        || !switch_seg(FS, new_segments[3])
        || !switch_seg(GS, new_gs)
    {
        // (the fault was delivered in the new task)
        return false;
    }

    if !(new_cs_limit_ok(new_eip) || new_eflags & FLAG_VM != 0) {
        trigger_gp(0);
        return false;
    }

    if let Some(error_code) = error_code {
        return_on_pagefault!(push32(error_code), false);
    }

    update_state_flags();
    true
}

unsafe fn new_cs_limit_ok(eip: i32) -> bool { eip as u32 <= *segment_limits.offset(CS as isize) }

pub unsafe fn after_block_boundary() { jit_block_boundary = true; }

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

pub unsafe fn readable_or_pagefault(addr: i32, size: i32) -> OrPageFault<()> {
    dbg_assert!(size < 0x1000);
    dbg_assert!(size > 0);

    let user = *cpl == 3;
    translate_address(addr, false, user, true)?;

    let end = addr + size - 1 & !0xFFF;
    if addr & !0xFFF != end & !0xFFF {
        translate_address(end, false, user, true)?;
    }

    return Ok(());
}

pub unsafe fn writable_or_pagefault(addr: i32, size: i32) -> OrPageFault<()> {
    writable_or_pagefault_cpl(*cpl, addr, size)
}

pub unsafe fn writable_or_pagefault_cpl(other_cpl: u8, addr: i32, size: i32) -> OrPageFault<()> {
    dbg_assert!(size < 0x1000);
    dbg_assert!(size > 0);

    let user = other_cpl == 3;
    translate_address(addr, true, user, true)?;

    let end = addr + size - 1 & !0xFFF;
    if addr & !0xFFF != end & !0xFFF {
        translate_address(end, true, user, true)?;
    }

    return Ok(());
}

pub fn translate_address_read_no_side_effects(address: i32) -> OrPageFault<u32> {
    unsafe { translate_address(address, false, *cpl == 3, false) }
}
pub fn translate_address_read(address: i32) -> OrPageFault<u32> {
    unsafe { translate_address(address, false, *cpl == 3, true) }
}

pub unsafe fn translate_address_write(address: i32) -> OrPageFault<u32> {
    translate_address(address, true, *cpl == 3, true)
}
pub unsafe fn translate_address_system_read(address: i32) -> OrPageFault<u32> {
    translate_address(address, false, false, true)
}
pub unsafe fn translate_address_system_write(address: i32) -> OrPageFault<u32> {
    translate_address(address, true, false, true)
}

#[inline(always)]
pub unsafe fn translate_address(
    address: i32,
    for_writing: bool,
    user: bool,
    side_effects: bool,
) -> OrPageFault<u32> {
    let mut entry = tlb_data[(address as u32 >> 12) as usize];
    let refused = entry
        & (TLB_VALID
            | if user { TLB_NO_USER } else { 0 }
            | if for_writing { TLB_READONLY } else { 0 })
        != TLB_VALID;
    if crate::x64::state::efer() & crate::x64::state::EFER_LMA != 0 {
        // compatibility mode: the 32-bit TLB holds x64 translations of 32-bit
        // linear addresses (fill_ia32e_tlb; data-only entries are good for
        // data); 64-bit code never uses it
        if refused || *x64_cs_long != 0 {
            return ia32e_translate(address, for_writing, user, side_effects);
        }
        return Ok(((entry & !0xFFF ^ address) as u32).wrapping_sub(memory::mem8 as u32));
    }
    if refused {
        entry = do_page_walk(address, for_writing, user, side_effects)?.get();
    }
    Ok((entry & !0xFFF ^ address) as u32 - memory::mem8 as u32)
}

pub unsafe fn translate_address_write_and_can_skip_dirty(address: i32) -> OrPageFault<(u32, bool)> {
    let mut entry = tlb_data[(address as u32 >> 12) as usize];
    let user = *cpl == 3;
    let refused =
        entry & (TLB_VALID | if user { TLB_NO_USER } else { 0 } | TLB_READONLY) != TLB_VALID;
    if crate::x64::state::efer() & crate::x64::state::EFER_LMA != 0 {
        // (compatibility mode: as translate_address)
        if refused || *x64_cs_long != 0 {
            return ia32e_translate(address, true, user, true).map(|address| (address, false));
        }
    }
    else if refused {
        entry = do_page_walk(address, true, user, true)?.get();
    }
    Ok((
        (entry & !0xFFF ^ address) as u32 - memory::mem8 as u32,
        entry & TLB_HAS_CODE == 0,
    ))
}

// 32-bit paging:
// - 10 bits PD | 10 bits PT | 12 bits offset
// - 10 bits PD | 22 bits offset (4MB huge page)
//
// PAE paging:
// - 2 bits PDPT | 9 bits PD | 9 bits PT | 12 bits offset
// - 2 bits PDPT | 9 bits PD | 21 bits offset (2MB huge page)
//
// Note that PAE entries are 64-bit, and can describe physical addresses over 32
// bits. However, since we support only 32-bit physical addresses, we require
// the high half of the entry to be 0.
#[cold]
pub unsafe fn do_page_walk(
    addr: i32,
    for_writing: bool,
    user: bool,
    side_effects: bool,
) -> OrPageFault<std::num::NonZeroI32> {
    let global;
    let mut allow_user = true;
    let page = (addr as u32 >> 12) as i32;
    let high;

    let cr0 = *cr;
    let cr4 = *cr.offset(4);

    if cr0 & CR0_PG == 0 {
        // paging disabled
        high = addr as u32 & 0xFFFFF000;
        global = false
    }
    else {
        profiler::stat_increment(stat::TLB_MISS);

        let pae = cr4 & CR4_PAE != 0;

        let (page_dir_addr, page_dir_entry) = if pae {
            let pdpt_entry = *reg_pdpte.offset(((addr as u32) >> 30) as isize);
            if pdpt_entry as i32 & PAGE_TABLE_PRESENT_MASK == 0 {
                if side_effects {
                    trigger_pagefault(addr, false, for_writing, user);
                }
                return Err(());
            }

            let page_dir_addr =
                (pdpt_entry as u32 & 0xFFFFF000) + ((((addr as u32) >> 21) & 0x1FF) << 3);
            let page_dir_entry = memory::read64s(page_dir_addr);
            dbg_assert!(
                page_dir_entry as u64 & 0x7FFF_FFFF_0000_0000 == 0,
                "Unsupported: Page directory entry larger than 32 bits"
            );
            dbg_assert!(
                page_dir_entry & 0x8000_0000_0000_0000u64 as i64 == 0,
                "Unsupported: NX bit"
            );

            (page_dir_addr, page_dir_entry as i32)
        }
        else {
            let page_dir_addr = *cr.offset(3) as u32 + (((addr as u32) >> 22) << 2);
            let page_dir_entry = memory::read32s(page_dir_addr);
            (page_dir_addr, page_dir_entry)
        };

        if page_dir_entry & PAGE_TABLE_PRESENT_MASK == 0 {
            if side_effects {
                trigger_pagefault(addr, false, for_writing, user);
            }
            return Err(());
        }

        let kernel_write_override = !user && 0 == cr0 & CR0_WP;
        let mut allow_write = page_dir_entry & PAGE_TABLE_RW_MASK != 0;
        allow_user &= page_dir_entry & PAGE_TABLE_USER_MASK != 0;

        if 0 != page_dir_entry & PAGE_TABLE_PSE_MASK && 0 != cr4 & CR4_PSE {
            // size bit is set

            if for_writing && !allow_write && !kernel_write_override || user && !allow_user {
                if side_effects {
                    trigger_pagefault(addr, true, for_writing, user);
                }
                return Err(());
            }

            // set the accessed and dirty bits

            let new_page_dir_entry = page_dir_entry
                | PAGE_TABLE_ACCESSED_MASK
                | if for_writing { PAGE_TABLE_DIRTY_MASK } else { 0 };

            if side_effects && page_dir_entry != new_page_dir_entry {
                memory::set_page_entry_bits(
                    page_dir_addr,
                    (new_page_dir_entry ^ page_dir_entry) as u8,
                );
            }

            high = if pae {
                page_dir_entry as u32 & 0xFFE00000 | (addr & 0x1FF000) as u32
            }
            else {
                page_dir_entry as u32 & 0xFFC00000 | (addr & 0x3FF000) as u32
            };
            global = page_dir_entry & PAGE_TABLE_GLOBAL_MASK == PAGE_TABLE_GLOBAL_MASK
        }
        else {
            let (page_table_addr, page_table_entry) = if pae {
                let page_table_addr =
                    (page_dir_entry as u32 & 0xFFFFF000) + (((addr as u32 >> 12) & 0x1FF) << 3);
                let page_table_entry = memory::read64s(page_table_addr);
                dbg_assert!(
                    page_table_entry as u64 & 0x7FFF_FFFF_0000_0000 == 0,
                    "Unsupported: Page table entry larger than 32 bits"
                );
                dbg_assert!(
                    page_table_entry & 0x8000_0000_0000_0000u64 as i64 == 0,
                    "Unsupported: NX bit"
                );

                (page_table_addr, page_table_entry as i32)
            }
            else {
                let page_table_addr =
                    (page_dir_entry as u32 & 0xFFFFF000) + (((addr as u32 >> 12) & 0x3FF) << 2);
                let page_table_entry = memory::read32s(page_table_addr);
                (page_table_addr, page_table_entry)
            };

            let present = page_table_entry & PAGE_TABLE_PRESENT_MASK != 0;
            allow_write &= page_table_entry & PAGE_TABLE_RW_MASK != 0;
            allow_user &= page_table_entry & PAGE_TABLE_USER_MASK != 0;

            if !present
                || for_writing && !allow_write && !kernel_write_override
                || user && !allow_user
            {
                if side_effects {
                    trigger_pagefault(addr, present, for_writing, user);
                }
                return Err(());
            }

            // Set the accessed and dirty bits
            // Note: dirty bit is only set on the page table entry
            let new_page_dir_entry = page_dir_entry | PAGE_TABLE_ACCESSED_MASK;
            if side_effects && new_page_dir_entry != page_dir_entry {
                memory::set_page_entry_bits(
                    page_dir_addr,
                    (new_page_dir_entry ^ page_dir_entry) as u8,
                );
            }
            let new_page_table_entry = page_table_entry
                | PAGE_TABLE_ACCESSED_MASK
                | if for_writing { PAGE_TABLE_DIRTY_MASK } else { 0 };
            if side_effects && page_table_entry != new_page_table_entry {
                memory::set_page_entry_bits(
                    page_table_addr,
                    (new_page_table_entry ^ page_table_entry) as u8,
                );
            }

            high = page_table_entry as u32 & 0xFFFFF000;
            global = page_table_entry & PAGE_TABLE_GLOBAL_MASK == PAGE_TABLE_GLOBAL_MASK
        }
    }

    if side_effects && tlb_data[page as usize] == 0 {
        if valid_tlb_entries_count == VALID_TLB_ENTRY_MAX {
            profiler::stat_increment(stat::TLB_FULL);
            clear_tlb();
            // also clear global entries if tlb is almost full after clearing non-global pages
            if valid_tlb_entries_count > VALID_TLB_ENTRY_MAX * 3 / 4 {
                profiler::stat_increment(stat::TLB_GLOBAL_FULL);
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
    else if side_effects && CHECK_TLB_INVARIANTS {
        let mut found = false;
        for i in 0..valid_tlb_entries_count {
            if valid_tlb_entries[i as usize] == page {
                found = true;
                break;
            }
        }
        dbg_assert!(found);
    }

    let is_in_mapped_range = memory::in_mapped_range(high);
    let has_code = if side_effects {
        !is_in_mapped_range && jit::page_needs_notification(Page::page_of(high))
    }
    else {
        // If side_effects is false, don't call into jit::jit_page_has_code. This value is not used
        // anyway (we only get here by translate_address_read_no_side_effects, which only uses the
        // address part)
        true
    };
    let info_bits = TLB_VALID
        | if for_writing { 0 } else { TLB_READONLY }
        | if allow_user { 0 } else { TLB_NO_USER }
        | if is_in_mapped_range { TLB_IN_MAPPED_RANGE } else { 0 }
        | if global && 0 != cr4 & CR4_PGE { TLB_GLOBAL } else { 0 }
        | if has_code { TLB_HAS_CODE } else { 0 };

    let tlb_entry = (high + memory::mem8 as u32) as i32 ^ page << 12 | info_bits as i32;

    dbg_assert!((high ^ (page as u32) << 12) & 0xFFF == 0);
    if side_effects {
        // bake in the addition with memory::mem8 to save an instruction from the fast path
        // of memory accesses
        tlb_data[page as usize] = tlb_entry;
    }

    Ok(if DEBUG {
        std::num::NonZeroI32::new(tlb_entry).unwrap()
    }
    else {
        std::num::NonZeroI32::new_unchecked(tlb_entry)
    })
}

/// In compatibility mode, x64 translations of 32-bit linear addresses also
/// fill the 32-bit TLB, which compiled 32-bit code reads inline. Only plain
/// RAM is cached; every x64 TLB invalidation (CR3/CR0/CR4/EFER writes, INVLPG)
/// also clears this TLB.
pub unsafe fn fill_ia32e_tlb(
    address: u32,
    physical: u64,
    access: crate::x64::paging::Access,
    user: bool,
) {
    use crate::x64::paging::Access;
    crate::x64::pages::COUNTERS[crate::x64::pages::COUNT_COMPAT_FILLS] += 1;
    // (extended RAM: its frame while cores share this thread; never 32-bit
    // code, and never a write entry for a page with page-tier code, so no
    // code-write notification; see crate::x64::extended::cache_frame)
    let (backing, extended) = match crate::x64::jac::ram_backing(physical) {
        Some(backing) => (backing, false),
        None if access == Access::Execute => return,
        None => {
            match crate::x64::extended::cache_frame(physical & !4095, access == Access::Write) {
                Some(host) => {
                    crate::x64::extended::note_legacy_tlb();
                    (host.wrapping_sub(memory::mem8 as u32), true)
                },
                None => return,
            }
        },
    };
    let page = address >> 12;
    if tlb_data[page as usize] != 0 {
        crate::x64::pages::COUNTERS[crate::x64::pages::COUNT_COMPAT_REFILLS] += 1;
    }
    if tlb_data[page as usize] == 0 {
        if valid_tlb_entries_count == VALID_TLB_ENTRY_MAX {
            clear_tlb();
            if valid_tlb_entries_count > VALID_TLB_ENTRY_MAX * 3 / 4 {
                full_clear_tlb();
            }
        }
        valid_tlb_entries[valid_tlb_entries_count as usize] = page as i32;
        valid_tlb_entries_count += 1;
    }
    let has_code = !extended && jit::page_needs_notification(Page::page_of(backing));
    let info = TLB_VALID
        | if access == Access::Write { 0 } else { TLB_READONLY }
        | if user { 0 } else { TLB_NO_USER }
        | if access == Access::Execute { 0 } else { TLB_IA32E_DATA }
        | if has_code { TLB_HAS_CODE } else { 0 };
    tlb_data[page as usize] =
        backing.wrapping_add(memory::mem8 as u32) as i32 ^ (page << 12) as i32 | info;
}

#[no_mangle]
pub unsafe fn full_clear_tlb() {
    clear_all_tlb_entries();
    legacy_code_epoch();
}
/// The page tier's code translations of this core (code TLB, chaining
/// entries) carry its access cache epoch (x64 jac): a legacy-mode flush
/// starts a new one, as x64 invalidations do (docs/jit-unification-plan.md
/// P7.1; in long and compatibility mode the x64 paths flush it themselves)
unsafe fn legacy_code_epoch() {
    if crate::x64::state::efer() & crate::x64::state::EFER_LMA == 0 {
        crate::x64::jac::flush(crate::cpu::apic::current_core());
    }
}
/// full_clear_tlb without a new code epoch: the cooperative cores'
/// context switch reinstalls a core's own entries (P7.1)
pub unsafe fn clear_all_tlb_entries() {
    profiler::stat_increment(stat::FULL_CLEAR_TLB);
    // clear tlb including global pages
    *last_virt_eip = -1;
    for i in 0..valid_tlb_entries_count {
        let page = valid_tlb_entries[i as usize];
        tlb_data[page as usize] = 0;
    }
    valid_tlb_entries_count = 0;

    if CHECK_TLB_INVARIANTS {
        #[allow(static_mut_refs)]
        for &entry in tlb_data.iter() {
            dbg_assert!(entry == 0);
        }
    };
}

#[no_mangle]
pub unsafe fn clear_tlb() {
    profiler::stat_increment(stat::CLEAR_TLB);
    // clear tlb excluding global pages
    *last_virt_eip = -1;
    let mut global_page_offset = 0;
    for i in 0..valid_tlb_entries_count {
        let page = valid_tlb_entries[i as usize];
        let entry = tlb_data[page as usize];
        if 0 != entry & TLB_GLOBAL {
            // reinsert at the front
            valid_tlb_entries[global_page_offset as usize] = page;
            global_page_offset += 1;
        }
        else {
            tlb_data[page as usize] = 0;
        }
    }
    valid_tlb_entries_count = global_page_offset;

    if CHECK_TLB_INVARIANTS {
        #[allow(static_mut_refs)]
        for &entry in tlb_data.iter() {
            dbg_assert!(entry == 0 || 0 != entry & TLB_GLOBAL);
        }
    };
    legacy_code_epoch();
}

pub unsafe fn trigger_pagefault(addr: i32, present: bool, write: bool, user: bool) {
    crate::cpu::execution::mark_fault();
    if config::LOG_PAGE_FAULTS {
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
    profiler::stat_increment(stat::PAGE_FAULT);
    *cr.offset(2) = addr;
    // invalidate tlb entry
    let page = ((addr as u32) >> 12) as i32;
    tlb_data[page as usize] = 0;
    let error_code = (user as i32) << 2 | (write as i32) << 1 | present as i32;
    *instruction_pointer = *previous_ip;
    crate::cpu::exceptions::fault(CPU_EXCEPTION_PF, Some(error_code));
}

pub fn tlb_set_has_code(physical_page: Page, has_code: bool) {
    for i in 0..unsafe { valid_tlb_entries_count } {
        let page = unsafe { valid_tlb_entries[i as usize] };
        let entry = unsafe { tlb_data[page as usize] };
        if 0 != entry {
            let tlb_physical_page = Page::of_u32(
                (entry as u32 >> 12 ^ page as u32) - (unsafe { memory::mem8 } as u32 >> 12),
            );
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
pub fn tlb_set_has_code_multiple(physical_pages: &HashSet<Page>, has_code: bool) {
    let physical_pages: Vec<Page> = physical_pages.into_iter().copied().collect();
    for i in 0..unsafe { valid_tlb_entries_count } {
        let page = unsafe { valid_tlb_entries[i as usize] };
        let entry = unsafe { tlb_data[page as usize] };
        if 0 != entry {
            let tlb_physical_page = Page::of_u32(
                (entry as u32 >> 12 ^ page as u32) - (unsafe { memory::mem8 } as u32 >> 12),
            );
            if physical_pages.contains(&tlb_physical_page) {
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

        let target = (entry ^ page << 12) as u32 - unsafe { memory::mem8 } as u32;
        dbg_assert!(!memory::in_mapped_range(target));

        let entry_has_code = entry & TLB_HAS_CODE != 0;
        let has_code = jit::jit_page_has_code(Page::page_of(target));

        // If some code has been created in a page, the corresponding tlb entries must be marked
        dbg_assert!(!has_code || entry_has_code);
    }
}

pub const DISABLE_EIP_TRANSLATION_OPTIMISATION: bool = false;

pub unsafe fn read_imm8() -> OrPageFault<i32> {
    let eip = *instruction_pointer;
    if crate::x64::state::efer() & crate::x64::state::EFER_LMA != 0 {
        // (compatibility mode with the fetch page cached: as below)
        if *x64_cs_long != 0 || 0 != eip & !0xFFF ^ *last_virt_eip {
            return ia32e_fetch8();
        }
    }
    else if DISABLE_EIP_TRANSLATION_OPTIMISATION || 0 != eip & !0xFFF ^ *last_virt_eip {
        return read_imm8_uncached(eip);
    }
    // cached pages are plain RAM (see cache_fetch_page; in compatibility
    // mode also relocated RAM, ia32e_phys_eip)
    dbg_assert!(memory::is_ram_backing((*eip_phys ^ eip) as u32));
    let data8 = *memory::mem8.offset((*eip_phys ^ eip) as isize) as i32;
    *instruction_pointer = eip + 1;
    return Ok(data8);
}

#[inline(never)]
unsafe fn read_imm8_uncached(eip: i32) -> OrPageFault<i32> {
    let phys = translate_address_read(eip)?;
    cache_fetch_page(eip, phys);
    // A remapped low RAM page is an open bus, never the high RAM backing
    let data8 = memory::fetch8(phys);
    *instruction_pointer = eip + 1;
    Ok(data8)
}

/// Remember the physical page of instruction fetches from `eip`'s page, but
/// only for plain RAM: fetches from mapped ranges (VGA, MMIO, the low hole
/// left by RAM relocated above 4 GiB) go through the bus every time.
#[inline(always)]
unsafe fn cache_fetch_page(eip: i32, phys: u32) {
    if memory::in_mapped_range(phys & !0xFFF) || memory::in_mapped_range(phys | 0xFFF) {
        *last_virt_eip = -1;
    }
    else {
        *eip_phys = (phys ^ eip as u32) as i32;
        *last_virt_eip = eip & !0xFFF;
    }
}

pub unsafe fn read_imm8s() -> OrPageFault<i32> { return Ok(read_imm8()? << 24 >> 24); }

pub unsafe fn read_imm16() -> OrPageFault<i32> {
    // Two checks in one comparison:
    // 1. Did the high 20 bits of eip change
    // or 2. Are the low 12 bits of eip 0xFFF (and this read crosses a page boundary)
    // (IA-32e mode: compatibility mode with the fetch page cached only)
    if DISABLE_EIP_TRANSLATION_OPTIMISATION
        || (*instruction_pointer ^ *last_virt_eip) as u32 > 0xFFE
        || crate::x64::state::efer() & crate::x64::state::EFER_LMA != 0 && *x64_cs_long != 0
    {
        return Ok(read_imm8()? | read_imm8()? << 8);
    }
    else {
        let data16 = memory::read16_no_mmap_check((*eip_phys ^ *instruction_pointer) as u32);
        *instruction_pointer = *instruction_pointer + 2;
        return Ok(data16);
    };
}

pub unsafe fn read_imm32s() -> OrPageFault<i32> {
    // Analogue to the above comment
    if DISABLE_EIP_TRANSLATION_OPTIMISATION
        || (*instruction_pointer ^ *last_virt_eip) as u32 > 0xFFC
        || crate::x64::state::efer() & crate::x64::state::EFER_LMA != 0 && *x64_cs_long != 0
    {
        return Ok(read_imm16()? | read_imm16()? << 16);
    }
    else {
        let data32 = memory::read32_no_mmap_check((*eip_phys ^ *instruction_pointer) as u32);
        *instruction_pointer = *instruction_pointer + 4;
        return Ok(data32);
    };
}

pub unsafe fn is_osize_32() -> bool {
    return *is_32 != (*prefixes & prefix::PREFIX_MASK_OPSIZE == prefix::PREFIX_MASK_OPSIZE);
}

pub unsafe fn is_asize_32() -> bool {
    return *is_32 != (*prefixes & prefix::PREFIX_MASK_ADDRSIZE == prefix::PREFIX_MASK_ADDRSIZE);
}

pub unsafe fn lookup_segment_selector(
    selector: SegmentSelector,
) -> OrPageFault<Result<(SegmentDescriptor, u64), SelectorNullOrInvalid>> {
    if selector.is_null() {
        return Ok(Err(SelectorNullOrInvalid::IsNull));
    }

    // IA-32e mode (compatibility mode included): GDTR and LDTR hold 64-bit
    // bases; Windows keeps its GDT above 4 GiB.
    let long_mode = crate::x64::state::efer() & crate::x64::state::EFER_LMA != 0;
    let (table_offset, table_limit) = if selector.is_gdt() {
        (
            if long_mode {
                crate::x64::state::read_gdtr_base()
            }
            else {
                *gdtr_offset as u32 as u64
            },
            *gdtr_size as u32,
        )
    }
    else {
        (
            if long_mode {
                crate::x64::state::read_segment_base(LDTR as usize)
            }
            else {
                *segment_offsets.offset(LDTR as isize) as u32 as u64
            },
            *segment_limits.offset(LDTR as isize) as u32,
        )
    };

    if selector.descriptor_offset() as u32 + 7 > table_limit {
        dbg_log!(
            "segment outside of table limit: selector={:x} offset={:x} isgdt={} table_limit={:x}",
            selector.raw,
            selector.descriptor_offset(),
            selector.is_gdt(),
            table_limit
        );
        return Ok(Err(SelectorNullOrInvalid::OutsideOfTableLimit));
    }

    let descriptor_address = if long_mode {
        table_offset.wrapping_add(selector.descriptor_offset() as u64)
    }
    else {
        (table_offset as u32).wrapping_add(selector.descriptor_offset() as u32) as u64
    };

    let descriptor = SegmentDescriptor::of_u64(if long_mode {
        crate::x64::memory::read_system(descriptor_address, 64)
            .map_err(|fault| crate::x64::system::raise(fault))?
    }
    else {
        read_system(descriptor_address as i32, 8)?
    });

    Ok(Ok((descriptor, descriptor_address)))
}

/// Stores a descriptor's access byte (accessed or busy bit) at the linear
/// address from lookup_segment_selector.
unsafe fn write_descriptor_access_byte(
    descriptor_address: u64,
    access_byte: u8,
) -> OrPageFault<()> {
    if crate::x64::state::efer() & crate::x64::state::EFER_LMA != 0 {
        return crate::x64::memory::write_system(
            descriptor_address.wrapping_add(5),
            8,
            access_byte as u64,
        )
        .map_err(|fault| crate::x64::system::raise(fault));
    }
    memory::write8(
        translate_address_system_write(descriptor_address as i32 + 5)?,
        access_byte as i32,
    );
    Ok(())
}

#[inline(never)]
pub unsafe fn switch_seg(reg: i32, selector_raw: i32) -> bool {
    dbg_assert!(reg >= 0 && reg <= 5);
    dbg_assert!(reg != CS);
    dbg_assert!(selector_raw >= 0 && selector_raw < 0x10000);

    if vm86_mode() {
        // TODO: Should set segment_limits and segment_access_bytes if ever implemented in get_seg
        //       (only vm86, not in real mode)
    }

    if !*protected_mode || vm86_mode() {
        *sreg.offset(reg as isize) = selector_raw as u16;
        *segment_is_null.offset(reg as isize) = false;
        *segment_offsets.offset(reg as isize) = selector_raw << 4;

        if reg == SS {
            *stack_size_32 = false;
        }
        update_state_flags();
        return true;
    }

    let selector = SegmentSelector::of_u16(selector_raw as u16);
    let (mut descriptor, descriptor_address) =
        match return_on_pagefault!(lookup_segment_selector(selector), false) {
            Ok(desc) => desc,
            Err(SelectorNullOrInvalid::IsNull) => {
                if reg == SS {
                    dbg_log!("#GP for loading 0 in SS sel={:x}", selector_raw);
                    trigger_gp(0);
                    return false;
                }
                else {
                    // es, ds, fs, gs
                    *sreg.offset(reg as isize) = selector_raw as u16;
                    *segment_is_null.offset(reg as isize) = true;
                    update_state_flags();
                    return true;
                }
            },
            Err(SelectorNullOrInvalid::OutsideOfTableLimit) => {
                dbg_log!(
                    "#GP for loading invalid in seg={} sel={:x}",
                    reg,
                    selector_raw,
                );
                dbg_trace();
                trigger_gp(selector_raw & !3);
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
    else {
        if descriptor.is_system()
            || !descriptor.is_readable()
            || (!descriptor.is_conforming_executable()
                && (selector.rpl() > descriptor.dpl() || *cpl > descriptor.dpl()))
        {
            dbg_log!(
                "#GP for loading invalid in seg {} sel={:x} sys={} readable={} dc={} exec={} rpl={} dpl={} cpl={} present={} paging={}",
                reg,
                selector_raw,
                descriptor.is_system(),
                descriptor.is_readable(),
                descriptor.is_dc(),
                descriptor.is_executable(),
                selector.rpl(),
                descriptor.dpl(),
                *cpl,
                descriptor.is_present(),
                *cr & CR0_PG != 0,
            );
            dbg_trace();
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

    if !descriptor.accessed() {
        descriptor = descriptor.set_accessed();
        return_on_pagefault!(
            write_descriptor_access_byte(descriptor_address, descriptor.access_byte()),
            false
        );
    }

    *segment_is_null.offset(reg as isize) = false;
    *segment_limits.offset(reg as isize) = descriptor.effective_limit();
    // (compatibility mode: the 32-bit base, zero-extended)
    crate::x64::state::write_segment_base(reg as usize, descriptor.base() as u32 as u64);
    *segment_access_bytes.offset(reg as isize) = descriptor.access_byte();
    *sreg.offset(reg as isize) = selector_raw as u16;

    update_state_flags();

    true
}

/// switch_seg for ES, DS, FS or GS in legacy protected mode when it raises
/// nothing and leaves the state flags as they are (Tier-0's MOV Sreg
/// template, docs/jit-unification-plan.md P3.7(b)). false, with nothing
/// changed: a fault, a descriptor that does not translate without one, an
/// accessed bit to set on a page with compiled code or a device, or a DS
/// whose load changes flat segmentation (then the interpreter runs the
/// instruction, as switch_seg)
pub unsafe fn switch_seg_without_fault(reg: i32, selector_raw: i32) -> bool {
    dbg_assert!(reg == ES || reg == DS || reg == FS || reg == GS);
    if !*protected_mode
        || vm86_mode()
        || crate::x64::state::efer() & crate::x64::state::EFER_LMA != 0
    {
        return false;
    }
    let selector = SegmentSelector::of_u16(selector_raw as u16);
    let flat = has_flat_segmentation();
    if selector.is_null() {
        // (a null DS is not flat segmentation)
        if reg == DS && flat {
            return false;
        }
        *sreg.offset(reg as isize) = selector_raw as u16;
        *segment_is_null.offset(reg as isize) = true;
        update_state_flags();
        return true;
    }
    // lookup_segment_selector's read, a system access, must not fault
    let (table, limit) = if selector.is_gdt() {
        (*gdtr_offset as u32, *gdtr_size as u32)
    }
    else {
        (
            *segment_offsets.offset(LDTR as isize) as u32,
            *segment_limits.offset(LDTR as isize) as u32,
        )
    };
    if selector.descriptor_offset() as u32 + 7 > limit {
        return false;
    }
    let address = table.wrapping_add(selector.descriptor_offset() as u32);
    for byte in [address, address.wrapping_add(7)] {
        if translate_address(byte as i32, false, false, false).is_err() {
            return false;
        }
    }
    let Ok(Ok((mut descriptor, descriptor_address))) = lookup_segment_selector(selector)
    else {
        return false;
    };
    if descriptor.is_system()
        || !descriptor.is_readable()
        || (!descriptor.is_conforming_executable()
            && (selector.rpl() > descriptor.dpl() || *cpl > descriptor.dpl()))
        || !descriptor.is_present()
    {
        return false;
    }
    if reg == DS
        && flat
            != (*segment_offsets.offset(SS as isize) == 0
                && descriptor.base() as u32 == 0
                && *segment_offsets.offset(CS as isize) == 0)
    {
        return false;
    }
    if !descriptor.accessed() {
        let Ok(physical) = translate_address(descriptor_address as i32 + 5, true, false, false)
        else {
            return false;
        };
        if crate::jit::jit_page_has_code(crate::page::Page::page_of(physical))
            || memory::may_interrupt(physical)
        {
            return false;
        }
        descriptor = descriptor.set_accessed();
        if write_descriptor_access_byte(descriptor_address, descriptor.access_byte()).is_err() {
            dbg_assert!(false, "a translated accessed-bit write faulted");
            return false;
        }
    }
    *segment_is_null.offset(reg as isize) = false;
    *segment_limits.offset(reg as isize) = descriptor.effective_limit();
    crate::x64::state::write_segment_base(reg as usize, descriptor.base() as u32 as u64);
    *segment_access_bytes.offset(reg as isize) = descriptor.access_byte();
    *sreg.offset(reg as isize) = selector_raw as u16;
    update_state_flags();
    true
}

pub unsafe fn load_tr(selector: i32) { let _ = load_tr_checked(selector); }

// Explicit read-fault status for terminal IR callers. load_tr keeps
// its original void ABI and all panic/partial-commit behavior is unchanged.
pub unsafe fn load_tr_checked(selector: i32) -> OrPageFault<()> {
    let selector = SegmentSelector::of_u16(selector as u16);
    let error = selector.raw as i32 & !3;

    // (SDM LTR: #GP(0) for a null selector; #GP(selector) for one outside
    // the GDT, not a TSS or a busy TSS; #NP(selector) if not present.
    // Err: the fault was delivered)
    if selector.is_null() {
        trigger_gp(0);
        return Err(());
    }
    if !selector.is_gdt() {
        trigger_gp(error);
        return Err(());
    }
    let (descriptor, descriptor_address) = match lookup_segment_selector(selector)? {
        Ok((desc, addr)) => (desc, addr),
        Err(_) => {
            trigger_gp(error);
            return Err(());
        },
    };

    // 0x9: available 386 TSS, 0x1: available 286 TSS (0xB/0x3: busy, #GP)
    if !descriptor.is_system() || descriptor.system_type() != 9 && descriptor.system_type() != 1 {
        dbg_log!(
            "ltr: {:x} is not an available TSS (type 0x{:x})",
            selector.raw,
            descriptor.system_type()
        );
        trigger_gp(error);
        return Err(());
    }

    if !descriptor.is_present() {
        trigger_np(error);
        return Err(());
    }

    *tss_size_32 = descriptor.system_type() == 9;
    *segment_limits.offset(TR as isize) = descriptor.effective_limit();
    *segment_offsets.offset(TR as isize) = descriptor.base();
    *sreg.offset(TR as isize) = selector.raw;

    // Mark task as busy
    write_descriptor_access_byte(descriptor_address, descriptor.set_busy().access_byte())
}

pub unsafe fn load_ldt(selector: i32) -> OrPageFault<()> {
    // Err: a page fault or the #GP/#NP was delivered
    if load_ldt_checked(selector, false)? {
        Ok(())
    }
    else {
        Err(())
    }
}

/// LLDT, or the LDT selector of a task switch (then every failure is #TS).
/// Ok(false): a #GP/#NP/#TS with the selector was delivered.
pub unsafe fn load_ldt_checked(selector: i32, task_switch: bool) -> OrPageFault<bool> {
    let selector = SegmentSelector::of_u16(selector as u16);
    let error = selector.raw as i32 & !3;

    if selector.is_null() {
        dbg_log!("lldt: null loaded");
        *segment_limits.offset(LDTR as isize) = 0;
        *segment_offsets.offset(LDTR as isize) = 0;
        *sreg.offset(LDTR as isize) = selector.raw;
        return Ok(true);
    }

    let fault = |not_present: bool| {
        if task_switch {
            trigger_ts(error)
        }
        else if not_present {
            trigger_np(error)
        }
        else {
            trigger_gp(error)
        }
        Ok(false)
    };

    // the LDT descriptor must be in the GDT
    if !selector.is_gdt() {
        return fault(false);
    }
    let descriptor = match lookup_segment_selector(selector)? {
        Ok((desc, _)) => desc,
        Err(_) => return fault(false),
    };
    if !descriptor.is_system() || descriptor.system_type() != 2 {
        dbg_log!("lldt: {:x} is not an LDT descriptor", selector.raw);
        return fault(false);
    }
    if !descriptor.is_present() {
        return fault(true);
    }

    dbg_log!(
        "lldt: {:x} offset={:x} limit={:x}",
        selector.raw,
        descriptor.base(),
        descriptor.effective_limit()
    );
    *segment_limits.offset(LDTR as isize) = descriptor.effective_limit();
    *segment_offsets.offset(LDTR as isize) = descriptor.base();
    *sreg.offset(LDTR as isize) = selector.raw;

    Ok(true)
}

pub unsafe fn get_seg(segment: i32) -> OrPageFault<i32> {
    dbg_assert!(segment >= 0 && segment < 8);
    if *segment_is_null.offset(segment as isize) {
        dbg_assert!(segment != CS && segment != SS);
        dbg_log!("#gp: Access null segment {}", segment);
        dbg_trace();
        trigger_gp(0);
        return Err(());
    }
    return Ok(*segment_offsets.offset(segment as isize));
}

/// false: a fault was delivered
pub unsafe fn set_cr0(cr0: i32) -> bool {
    if crate::x64::state::efer() & (crate::x64::state::EFER_LME | crate::x64::state::EFER_LMA) != 0
    {
        if let Err(fault) = crate::x64::system::write_cr(0, cr0 as u32 as u64) {
            crate::x64::system::raise(fault);
            return false;
        }
        return true;
    }
    let old_cr0 = *cr;

    if old_cr0 & CR0_AM == 0 && cr0 & CR0_AM != 0 {
        dbg_log!("Warning: Unimplemented: cr0 alignment mask");
    }
    if (cr0 & (CR0_PE | CR0_PG)) == CR0_PG {
        trigger_gp(0);
        return false;
    }
    if (old_cr0 ^ cr0) & CR0_TS != 0 {
        crate::step_profile::note_event(crate::step_profile::event::CR0_TS, 0);
    }

    *cr = cr0;
    *cr |= CR0_ET;

    if old_cr0 & (CR0_PG | CR0_WP) != cr0 & (CR0_PG | CR0_WP) {
        full_clear_tlb();
    }

    if *cr.offset(4) & CR4_PAE != 0
        && *cr & CR0_PG != 0
        && old_cr0 & (CR0_CD | CR0_NW | CR0_PG) != cr0 & (CR0_CD | CR0_NW | CR0_PG)
    {
        load_pdpte(*cr.offset(3))
    }

    *protected_mode = (*cr & CR0_PE) == CR0_PE;
    *segment_access_bytes.offset(CS as isize) = 0x80 | 0x10 | 0x08 | 0x02; // P dpl0 S E RW
    true
}

/// false: a fault was delivered
pub unsafe fn set_cr3(mut cr3: i32) -> bool {
    if crate::x64::state::efer() & crate::x64::state::EFER_LMA != 0 {
        if let Err(fault) = crate::x64::system::write_cr(3, cr3 as u32 as u64) {
            crate::x64::system::raise(fault);
            return false;
        }
        return true;
    }
    if false {
        dbg_log!("cr3 <- {:x}", cr3);
    }
    if *cr.offset(4) & CR4_PAE != 0 {
        cr3 &= !0b1111;
        if *cr & CR0_PG != 0 {
            load_pdpte(cr3);
        }
    }
    else {
        cr3 &= !0b111111100111;
        dbg_assert!(cr3 & 0xFFF == 0, "TODO");
    }
    *cr.offset(3) = cr3;
    clear_tlb();
    true
}

pub unsafe fn load_pdpte(cr3: i32) {
    dbg_assert!(cr3 & 0b1111 == 0);
    for i in 0..4 {
        let mut pdpt_entry = memory::read64s(cr3 as u32 + 8 * i as u32) as u64;
        pdpt_entry &= !0b1110_0000_0000;
        dbg_assert!(pdpt_entry & 0b11000 == 0, "TODO");
        dbg_assert!(
            pdpt_entry as u64 & 0xFFFF_FFFF_0000_0000 == 0,
            "Unsupported: PDPT entry larger than 32 bits"
        );
        if pdpt_entry as i32 & PAGE_TABLE_PRESENT_MASK != 0 {
            dbg_assert!(
                pdpt_entry & 0b1_1110_0110 == 0,
                "TODO: #gp reserved bit in pdpte"
            );
        }
        *reg_pdpte.offset(i) = pdpt_entry;
    }
}

pub unsafe fn cpl_changed() { *last_virt_eip = -1 }

pub unsafe fn update_cs_size(new_size: bool) {
    if *is_32 != new_size {
        *is_32 = new_size;
    }
}

/// VMware's backdoor port: VMware lets every privilege level use it (its
/// tools and its user-mode 3D driver do), and so does v86 (src/vmware.js)
pub const VMWARE_BACKDOOR_PORT: i32 = 0x5658;

#[inline(never)]
pub unsafe fn test_privileges_for_io(port: i32, size: i32) -> bool {
    if port == VMWARE_BACKDOOR_PORT {
        return true;
    }
    // compatibility mode: the 64-bit TSS base
    if crate::x64::state::efer() & crate::x64::state::EFER_LMA != 0 {
        return match crate::x64::system::check_io_access(port as u16, (size * 8) as u8) {
            Ok(()) => true,
            Err(fault) => {
                crate::x64::system::raise(fault);
                false
            },
        };
    }
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

            let iomap_base = memory::read16(return_on_pagefault!(
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
                let port_info =
                    if mask & 0xFF00 != 0 { memory::read16(addr) } else { memory::read8(addr) };

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

pub fn get_state_flags() -> CachedStateFlags { unsafe { *state_flags } }

#[no_mangle]
pub fn get_seg_cs() -> i32 { unsafe { *segment_offsets.offset(CS as isize) } }

pub unsafe fn get_seg_ss() -> i32 { return *segment_offsets.offset(SS as isize); }

pub unsafe fn segment_prefix(default_segment: i32) -> i32 {
    let prefix = *prefixes & prefix::PREFIX_MASK_SEGMENT;
    if 0 != prefix {
        dbg_assert!(prefix != prefix::SEG_PREFIX_ZERO);
        prefix as i32 - 1
    }
    else {
        default_segment
    }
}

pub unsafe fn get_seg_prefix(default_segment: i32) -> OrPageFault<i32> {
    let prefix = *prefixes & prefix::PREFIX_MASK_SEGMENT;
    if 0 != prefix {
        if prefix == prefix::SEG_PREFIX_ZERO {
            return Ok(0);
        }
        else {
            return get_seg(prefix as i32 - 1);
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
    if is_asize_32() {
        resolve_modrm32(modrm_byte)
    }
    else {
        resolve_modrm16(modrm_byte)
    }
}

pub unsafe fn run_instruction(opcode: i32) {
    // (debug builds only: no cost in the release interpreter)
    if cfg!(debug_assertions) && INSTRUCTION_TRACE_ENABLED {
        instruction_trace_note(*instruction_pointer - 1);
    }
    gen::interpreter::run(opcode as u32)
}
pub unsafe fn run_instruction0f_16(opcode: i32) { gen::interpreter0f::run(opcode as u32) }
pub unsafe fn run_instruction0f_32(opcode: i32) { gen::interpreter0f::run(opcode as u32 | 0x100) }

/// Instructions run by the interpreter loop (not Tier-0 steps), in total and
/// by linear page in a small direct-mapped table: where compiled code is
/// missing (diagnostics; see ir_interpreted_stat).
static mut INTERPRETED: u32 = 0;
static mut INTERPRETED_PAGES: [(u32, u32); 1024] = [(0, 0); 1024];
/// Interpreted instructions of one chosen page by 16-byte chunk of the EIP
/// the interpreter started at (ir_interpreted_stat fields 4 and 5).
static mut INTERPRETED_WATCH: u32 = u32::MAX;
static mut INTERPRETED_OFFSETS: [u32; 256] = [0; 256];
/// VEX instructions the interpreter ran (cpu::vex::run; ir_interpreted_stat
/// field 6)
pub static mut INTERPRETED_VEX: u32 = 0;
#[inline(always)]
unsafe fn note_interpreted_page(eip: u32, steps: u32) {
    INTERPRETED = INTERPRETED.wrapping_add(steps);
    let page = eip >> 12;
    if page == INTERPRETED_WATCH {
        INTERPRETED_OFFSETS[(eip as usize & 4095) >> 4] += steps;
    }
    let slot = &mut INTERPRETED_PAGES[(page.wrapping_mul(0x9E3779B1) >> 22) as usize];
    if slot.0 != page {
        if slot.1 > steps {
            slot.1 -= steps;
            return;
        }
        *slot = (page, 0);
    }
    slot.1 = slot.1.wrapping_add(steps);
}
/// field 0: total interpreted instructions; 1/2: page and count of table
/// slot `index`; 3: reset; 4: watch page `index` (a page number); 5: its
/// interpreted instructions started in 16-byte chunk `index`; 6: VEX
/// instructions interpreted.
#[no_mangle]
pub unsafe fn ir_interpreted_stat(field: u32, index: u32) -> u32 {
    match field {
        0 => INTERPRETED,
        1 | 2 if index < 1024 => {
            let slot = INTERPRETED_PAGES[index as usize];
            if field == 1 {
                slot.0
            }
            else {
                slot.1
            }
        },
        3 => {
            INTERPRETED = 0;
            INTERPRETED_PAGES = [(0, 0); 1024];
            INTERPRETED_VEX = 0;
            0
        },
        4 => {
            INTERPRETED_WATCH = index;
            INTERPRETED_OFFSETS = [0; 256];
            0
        },
        5 if index < 256 => {
            let offsets = INTERPRETED_OFFSETS;
            offsets[index as usize]
        },
        6 => INTERPRETED_VEX,
        _ => 0,
    }
}

pub unsafe fn cycle_internal() -> bool {
    if crate::x64::state::mode().is_long() {
        if !crate::ir::runtime::schedule::enabled() {
            let span = crate::cpu::execution::ledger_begin();
            run_long_instruction();
            crate::cpu::execution::ledger_end(span, crate::cpu::execution::Way::Interpreted);
            return false;
        }
        let attempt = crate::x64::pages::run(4096);
        if attempt.retired == 0 {
            let span = crate::cpu::execution::ledger_begin();
            run_long_instruction();
            crate::cpu::execution::ledger_end(span, crate::cpu::execution::Way::Interpreted);
        }
        return attempt.submitted;
    }
    // 32-bit compatibility-mode code in the x64 page tier (x64_page_compat32,
    // docs/jit-unification-plan.md P7.2), not Tier-0; legacy protected-mode
    // code too (x64_page_legacy32, P7.3)
    if crate::x64::pages::page32()
        && crate::ir::runtime::schedule::enabled()
        && !crate::cpu::execution::is_deterministic()
        && crate::x64::pages::runnable32()
    {
        let attempt = crate::x64::pages::run(4096);
        if attempt.retired == 0 {
            let span = crate::cpu::execution::ledger_begin();
            run_compat_instruction();
            crate::cpu::execution::ledger_end(span, crate::cpu::execution::Way::Interpreted);
        }
        return attempt.submitted;
    }
    profiler::stat_increment(stat::CYCLE_INTERNAL);
    // Compatibility mode compiles like legacy protected mode (see run_cpu_slice)
    let wide = crate::x64::state::efer() & crate::x64::state::EFER_LMA != 0 && !X64_COMPAT_JIT;
    let submitted = if wide {
        false
    }
    else {
        if crate::ir::runtime::diagnostics::enabled() {
            let _scope = crate::ir::runtime::diagnostics::Scope::new(
                crate::ir::runtime::diagnostics::Stage::Scheduler,
            );
            crate::ir::runtime::schedule::visit()
        }
        else {
            crate::ir::runtime::schedule::visit()
        }
    };
    // Installation runs in a host Promise continuation, never on this CPU
    // stack. Avoid interpreting a full batch before that continuation can
    // run. This is an edge (new submission), not the level "pending != 0".
    if submitted {
        return true;
    }
    let native_before = *instruction_counter;
    let interpreted_before = crate::cpu::execution::jit_dispatches();
    if !wide && crate::ir::runtime::cache::execute() {
        crate::cpu::execution::note_native_retired(
            (*instruction_counter).wrapping_sub(native_before),
            interpreted_before,
        );
        return false;
    }
    // The interpreter can call devices and mutate raw RAM.
    crate::ir::runtime::entry::ir_admission_barrier();
    let initial_eip = *instruction_pointer;
    let ir_entry = crate::ir::runtime::live::entry();
    let ir_heat = *prefixes == 0 && !*in_hlt;

    *previous_ip = initial_eip;
    let phys_addr = return_on_pagefault!(get_phys_eip(), false);

    let initial_instruction_counter = *instruction_counter;
    let performance_sample =
        profiler::performance_chunk_start(false, initial_eip as u32, *cr.offset(3) as u32, *cpl);
    let span = crate::cpu::execution::ledger_begin();
    if crate::ir::runtime::diagnostics::enabled() {
        jit_run_interpreted_diagnostic(phys_addr);
    }
    else {
        jit_run_interpreted(phys_addr, u32::MAX);
    }
    crate::cpu::execution::ledger_end(span, crate::cpu::execution::Way::Interpreted);
    if ir_heat {
        crate::ir::runtime::schedule::note_interpreted(
            ir_entry,
            (*instruction_counter).wrapping_sub(initial_instruction_counter),
        );
    }
    note_interpreted_page(
        initial_eip as u32,
        (*instruction_counter).wrapping_sub(initial_instruction_counter),
    );
    profiler::performance_chunk_finish(
        performance_sample,
        (*instruction_counter).wrapping_sub(initial_instruction_counter),
    );

    profiler::stat_increment_by(
        stat::RUN_INTERPRETED_STEPS,
        (*instruction_counter - initial_instruction_counter) as u64,
    );
    profiler::performance_recording_add(
        0,
        (*instruction_counter).wrapping_sub(initial_instruction_counter) as u64,
    );
    dbg_assert!(
        *instruction_counter != initial_instruction_counter,
        "Instruction counter didn't change"
    );
    false
}

// IA-32e mode (compatibility-mode code) paths of the legacy memory and
// fetch helpers. Out of line and cold, so the 32-bit fast paths stay small
// enough to be inlined into the interpreter.
#[cold]
#[inline(never)]
unsafe fn ia32e_phys_eip() -> OrPageFault<u32> {
    let address = crate::x64::memory::translate(
        *instruction_pointer as u32 as u64,
        crate::x64::paging::Access::Execute,
        false,
        false,
    )
    .map_err(|fault| crate::x64::system::raise(fault))?;
    match crate::x64::physical::ram_page(address & !4095) {
        Ok(page) => {
            let phys = page.backing | (address & 4095) as u32;
            // compatibility mode: remember the page (get_phys_eip, read_imm*)
            if *x64_cs_long == 0 {
                *eip_phys = (phys ^ *instruction_pointer as u32) as i32;
                *last_virt_eip = *instruction_pointer & !0xFFF;
            }
            Ok(phys)
        },
        // code in extended RAM runs from its aperture address (interpreted:
        // nothing compiles from the mapped range)
        Err(_) if crate::x64::extended::contains(address) => {
            Ok(crate::x64::extended::aperture::map(address))
        },
        Err(_) => Err(crate::x64::system::raise(crate::x64::memory::Fault::gp())),
    }
}
#[cold]
#[inline(never)]
unsafe fn ia32e_fetch8() -> OrPageFault<i32> {
    let value = crate::x64::memory::fetch(*instruction_pointer as u32 as u64)
        .map_err(|fault| crate::x64::system::raise(fault))?;
    *instruction_pointer = (*instruction_pointer).wrapping_add(1);
    Ok(value as i32)
}
#[cold]
#[inline(never)]
unsafe fn ia32e_translate(
    address: i32,
    for_writing: bool,
    user: bool,
    side_effects: bool,
) -> OrPageFault<u32> {
    crate::x64::memory::legacy_translate(
        address as u32,
        if for_writing {
            crate::x64::paging::Access::Write
        }
        else {
            crate::x64::paging::Access::Read
        },
        user,
        side_effects,
    )
}
#[cold]
#[inline(never)]
unsafe fn ia32e_read(addr: i32, bits: u8) -> OrPageFault<u64> {
    crate::x64::memory::read(addr as u32 as u64, bits, false)
        .map_err(|fault| crate::x64::system::raise(fault))
}
#[cold]
#[inline(never)]
unsafe fn ia32e_read128(addr: i32) -> OrPageFault<reg128> {
    crate::x64::memory::read128(addr as u32 as u64, false)
        .map(|value| reg128 {
            u64: [value as u64, (value >> 64) as u64],
        })
        .map_err(|fault| crate::x64::system::raise(fault))
}
#[cold]
#[inline(never)]
unsafe fn ia32e_write(addr: i32, bits: u8, value: u64) -> OrPageFault<()> {
    crate::x64::memory::write(addr as u32 as u64, bits, value, false)
        .map_err(|fault| crate::x64::system::raise(fault))
}
#[cold]
#[inline(never)]
unsafe fn ia32e_write128(addr: i32, value: reg128) -> OrPageFault<()> {
    crate::x64::memory::write128(
        addr as u32 as u64,
        value.u64[0] as u128 | (value.u64[1] as u128) << 64,
        false,
    )
    .map_err(|fault| crate::x64::system::raise(fault))
}

pub unsafe fn get_phys_eip() -> OrPageFault<u32> {
    if crate::x64::state::efer() & crate::x64::state::EFER_LMA != 0 {
        // compatibility mode: the last fetch page too (ia32e_phys_eip fills
        // it; whatever may change its translation resets last_virt_eip)
        let eip = *instruction_pointer;
        if *x64_cs_long == 0 {
            if 0 == eip & !0xFFF ^ *last_virt_eip {
                return Ok((*eip_phys ^ eip) as u32);
            }
            // an entry a fetch made (not data-only: NX was checked), which
            // is RAM (fill_ia32e_tlb makes none of another kind for fetches)
            let entry = tlb_data[(eip as u32 >> 12) as usize];
            let mask = TLB_VALID | TLB_IA32E_DATA | if *cpl == 3 { TLB_NO_USER } else { 0 };
            if entry & mask == TLB_VALID {
                let phys = ((entry & !0xFFF ^ eip) as u32).wrapping_sub(memory::mem8 as u32);
                *eip_phys = (phys ^ eip as u32) as i32;
                *last_virt_eip = eip & !0xFFF;
                return Ok(phys);
            }
        }
        return ia32e_phys_eip();
    }
    let eip = *instruction_pointer;
    if 0 != eip & !0xFFF ^ *last_virt_eip {
        let phys = translate_address_read(eip)?;
        cache_fetch_page(eip, phys);
        return Ok(phys);
    }
    let phys_addr = (*eip_phys ^ eip) as u32;
    return Ok(phys_addr);
}

#[inline(never)]
unsafe fn jit_run_interpreted_diagnostic(phys_addr: u32) {
    let before = *instruction_counter;
    let pc = *instruction_pointer as u32;
    let cr3 = *cr.offset(3) as u32;
    let scope = crate::ir::runtime::diagnostics::Scope::new(
        crate::ir::runtime::diagnostics::Stage::Interpreter,
    );
    jit_run_interpreted(phys_addr, u32::MAX);
    let count = (*instruction_counter).wrapping_sub(before);
    crate::ir::runtime::diagnostics::interpreter_steps(count);
    crate::ir::runtime::diagnostics::interpreter(pc, cr3, phys_addr, count, scope.finish());
}

/// Diagnostics (off by default): the last interpreted instructions as
/// (EIP, ESP, CR3, EAX, EBX, EDX), for debugging guests that jump into
/// garbage. Debug builds only; compiled code is not traced (use disable_jit).
/// EIP is the opcode byte (after any prefixes).
const INSTRUCTION_TRACE_LEN: usize = 4096;
static mut INSTRUCTION_TRACE: [[u32; 6]; INSTRUCTION_TRACE_LEN] = [[0; 6]; INSTRUCTION_TRACE_LEN];
static mut INSTRUCTION_TRACE_NEXT: usize = 0;
static mut INSTRUCTION_TRACE_ENABLED: bool = false;
#[cold]
#[inline(never)]
unsafe fn instruction_trace_note(eip: i32) {
    INSTRUCTION_TRACE[INSTRUCTION_TRACE_NEXT % INSTRUCTION_TRACE_LEN] = [
        eip as u32,
        *reg32.offset(ESP as isize) as u32,
        *cr.offset(3) as u32,
        *reg32.offset(EAX as isize) as u32,
        *reg32.offset(EBX as isize) as u32,
        *reg32.offset(EDX as isize) as u32,
    ];
    INSTRUCTION_TRACE_NEXT += 1;
}
#[no_mangle]
pub unsafe fn instruction_trace_enable(enabled: bool) {
    INSTRUCTION_TRACE_ENABLED = enabled;
    INSTRUCTION_TRACE_NEXT = 0;
}
#[no_mangle]
pub unsafe fn instruction_trace_count() -> u32 {
    INSTRUCTION_TRACE_NEXT.min(INSTRUCTION_TRACE_LEN) as u32
}
/// `index` 0 is the most recent instruction
#[no_mangle]
pub unsafe fn instruction_trace_get(index: u32, field: u32) -> u32 {
    if index as usize >= INSTRUCTION_TRACE_LEN.min(INSTRUCTION_TRACE_NEXT) || field >= 6 {
        return 0;
    }
    INSTRUCTION_TRACE[(INSTRUCTION_TRACE_NEXT - 1 - index as usize) % INSTRUCTION_TRACE_LEN]
        [field as usize]
}

unsafe fn jit_run_interpreted(mut phys_addr: u32, budget: u32) {
    profiler::stat_increment(stat::RUN_INTERPRETED);

    jit_block_boundary = false;
    // IR hotness is collected at outer dispatch. A same-page interpreted loop
    // must expose its backedge before the 100,001-instruction limit, or an
    // already hot/published side entry can remain invisible to IR selection.
    let ir_dispatch = crate::ir::runtime::schedule::enabled();
    let before = *instruction_counter;
    let mut i = 0;

    loop {
        i += 1;
        let start_eip = *instruction_pointer;
        // A remapped low RAM page is an open bus, never the high RAM backing.
        // Compatibility mode has already resolved a full physical RAM
        // address, or one of the extended RAM aperture.
        let opcode = if memory::in_mapped_range(phys_addr)
            && (crate::x64::state::efer() & crate::x64::state::EFER_LMA == 0
                || crate::x64::extended::aperture::contains(phys_addr))
        {
            memory::fetch8(phys_addr)
        }
        else {
            *memory::mem8.offset(phys_addr as isize) as i32
        };
        *instruction_pointer += 1;
        dbg_assert!(*prefixes == 0);
        let tracked = crate::cpu::execution::is_deterministic();
        crate::cpu::execution::begin_instruction();
        run_instruction(opcode | (*is_32 as i32) << 8);
        crate::cpu::execution::finish_instruction();
        if tracked {
            if *interrupt_shadow != 0 {
                *interrupt_shadow -= 1;
            }
            handle_irqs();
        }
        dbg_assert!(*prefixes == 0);

        if ir_dispatch && (i >= 64 || (*instruction_pointer as u32) <= start_eip as u32) {
            break;
        }

        // STI may execute its one shadow instruction recursively. Account
        // for that work too; at most that one instruction exceeds a slice.
        if (budget != u32::MAX && i + (*instruction_counter).wrapping_sub(before) >= budget)
            || jit_block_boundary
            // (64-bit mode: CS.L is only ever set with EFER.LMA)
            || *x64_cs_long != 0
            || Page::page_of(start_eip as u32) != Page::page_of(*instruction_pointer as u32)
                // Limit the number of iterations, as jumps within the same page are not counted as
                // block boundaries for the interpreter, but only on the next backwards jump
            || (i >= INTERPRETER_ITERATION_LIMIT
                && (start_eip as u32) >= (*instruction_pointer as u32))
        {
            break;
        }

        *previous_ip = *instruction_pointer;
        phys_addr = return_on_pagefault!(get_phys_eip()) as u32;
    }

    if cfg!(debug_assertions) {
        debug_last_jump = LastJump::Interpreted { phys_addr };
    }

    *instruction_counter += i;
}

/// The wide interpreter is the authoritative fallback until wide native IR
/// has passed its own admission/differential gates.
pub unsafe fn run_long_instruction() {
    let trap = *flags & FLAG_TRAP != 0;
    let resume = *flags & FLAG_RF != 0;
    crate::cpu::execution::begin_instruction();
    crate::cpu::execution::set_irq_deferral(true);
    let result = crate::x64::debug::begin().and_then(|()| crate::x64::execute::step());
    crate::cpu::execution::set_irq_deferral(false);
    let completed = match result {
        Ok(()) => true,
        Err(fault) => {
            crate::x64::system::raise(fault);
            false
        },
    };
    crate::cpu::execution::finish_instruction();
    *instruction_counter = (*instruction_counter).wrapping_add(1);
    if *interrupt_shadow != 0 {
        *interrupt_shadow -= 1;
    }
    if completed {
        if resume {
            *flags &= !FLAG_RF;
        }
    }
    if crate::x64::debug::finish(completed, trap) {
        crate::cpu::exceptions::trap(1);
    }
    handle_irqs();
}

/// One instruction of 32-bit compatibility-mode code in the 32-bit
/// interpreter, with run_long_instruction's bookkeeping: the x64 page tier's
/// steps, retries and misses in compatibility mode (x64_page_compat32,
/// docs/jit-unification-plan.md P7.2, and in legacy mode, P7.3). A fetch
/// fault is delivered and, as in the 32-bit interpreter loop
/// (cycle_internal), not counted (cross-phase rule 3).
pub unsafe fn run_compat_instruction() {
    *previous_ip = *instruction_pointer;
    crate::cpu::execution::begin_instruction();
    crate::cpu::execution::set_irq_deferral(true);
    let fetched = get_phys_eip();
    if let Ok(phys_addr) = fetched {
        // (as jit_run_interpreted fetches with EFER.LMA)
        let opcode = if memory::in_mapped_range(phys_addr)
            && crate::x64::extended::aperture::contains(phys_addr)
        {
            memory::fetch8(phys_addr)
        }
        else {
            *memory::mem8.offset(phys_addr as isize) as i32
        };
        *instruction_pointer += 1;
        run_instruction(opcode | (*is_32 as i32) << 8);
    }
    crate::cpu::execution::set_irq_deferral(false);
    crate::cpu::execution::finish_instruction();
    *instruction_counter = (*instruction_counter).wrapping_add(fetched.is_ok() as u32);
    if *interrupt_shadow != 0 {
        *interrupt_shadow -= 1;
    }
    handle_irqs();
}

/// Shared compilation budget, replenished once per machine scheduling round.
#[no_mangle]
pub fn begin_cpu_frame(now: f64) { crate::ir::runtime::schedule::begin_frame(now); }

/// The cooperative scheduler's interpreter slice. Device clocks are serviced once by
/// the machine scheduler, outside this entry. Yield only after a complete
/// instruction or the string engine's resumable REP element batch; a LOCK
/// transaction cannot be split by switching cores.
#[no_mangle]
pub unsafe fn run_cpu_slice(budget: u32) -> u32 {
    core_yield = false;
    crate::parallel::sync_worker_configuration();
    crate::ir::runtime::entry::ir_admission_barrier();
    handle_irqs();
    let before = *instruction_counter;
    let mut remaining = budget;
    jit_link_batch_start = before;
    jit_link_batch_limit = budget;
    jit_link_batch = true;
    let native = crate::ir::runtime::schedule::enabled();
    // (P7.2, P7.3: a switch hands 32-bit code to the page tier)
    let page32 = native && crate::x64::pages::page32();
    // (P4.6, as in do_many_cycles_native)
    if crate::x64::state::mode().is_long() && crate::ir::runtime::schedule::long_visit() {
        jit_link_batch = false;
        return (*instruction_counter).wrapping_sub(before);
    }
    while remaining != 0 && !*in_hlt && !core_yield {
        // (as in do_many_cycles_native: extended RAM frames held by access
        // caches are released between entries)
        crate::x64::extended::safe_point();
        *previous_ip = *instruction_pointer;
        // A fault can change CS:EIP without retiring an instruction. Charge
        // that dispatch as well, so a fault loop cannot monopolize the host.
        let count = *instruction_counter;
        *slice_budget = remaining;
        if crate::x64::state::mode().is_long() {
            let attempt = if native {
                crate::x64::pages::run(remaining)
            }
            else {
                crate::x64::pages::Attempt {
                    retired: 0,
                    submitted: false,
                }
            };
            if attempt.retired == 0 {
                let span = crate::cpu::execution::ledger_begin();
                run_long_instruction();
                crate::cpu::execution::ledger_end(span, crate::cpu::execution::Way::Interpreted);
            }
            remaining = remaining.saturating_sub(attempt.retired.max(1));
            if attempt.submitted {
                break;
            }
            continue;
        }
        // 32-bit compatibility-mode code in the x64 page tier
        // (x64_page_compat32, docs/jit-unification-plan.md P7.2), and legacy
        // protected-mode code (x64_page_legacy32, P7.3)
        if page32 && !crate::cpu::execution::is_deterministic() && crate::x64::pages::runnable32() {
            let attempt = crate::x64::pages::run(remaining);
            if attempt.retired == 0 {
                let span = crate::cpu::execution::ledger_begin();
                run_compat_instruction();
                crate::cpu::execution::ledger_end(span, crate::cpu::execution::Way::Interpreted);
            }
            remaining = remaining.saturating_sub(attempt.retired.max(1));
            if attempt.submitted {
                break;
            }
            continue;
        }
        // Legacy modes and IA-32e compatibility mode (32-bit code under a
        // 64-bit OS): the IR reads 4-level translations through the 32-bit
        // TLB that fill_ia32e_tlb keeps (x64 memory::translate_user)
        if !crate::cpu::execution::is_deterministic()
            && (crate::x64::state::efer() & crate::x64::state::EFER_LMA == 0 || X64_COMPAT_JIT)
            && crate::ir::runtime::schedule::enabled()
        {
            if crate::ir::runtime::schedule::visit() {
                break;
            }
            let interpreted_before = crate::cpu::execution::jit_dispatches();
            if crate::ir::runtime::cache::execute() {
                crate::cpu::execution::note_native_retired(
                    (*instruction_counter).wrapping_sub(count),
                    interpreted_before,
                );
                remaining =
                    remaining.saturating_sub((*instruction_counter).wrapping_sub(count).max(1));
                continue;
            }
        }
        let entry = crate::ir::runtime::live::entry();
        if let Ok(phys_addr) = get_phys_eip() {
            let span = crate::cpu::execution::ledger_begin();
            jit_run_interpreted(phys_addr, remaining);
            crate::cpu::execution::ledger_end(span, crate::cpu::execution::Way::Interpreted);
            crate::ir::runtime::schedule::note_interpreted(
                entry,
                (*instruction_counter).wrapping_sub(count),
            );
        }
        remaining = remaining.saturating_sub((*instruction_counter).wrapping_sub(count).max(1));
        if apic::has_core_events() {
            break;
        }
    }
    jit_link_batch = false;
    core_yield = false;
    (*instruction_counter).wrapping_sub(before)
}

#[no_mangle]
pub fn update_state_flags() {
    unsafe {
        *state_flags = CachedStateFlags::of_u32(
            (*is_32 as u32) << 0
                | (*stack_size_32 as u32) << 1
                | ((*cpl == 3) as u32) << 2
                | (has_flat_segmentation() as u32) << 3,
        )
    }
}

#[no_mangle]
pub unsafe fn has_flat_segmentation() -> bool {
    // cs/ss can't be null
    return *segment_offsets.offset(SS as isize) == 0
        && !*segment_is_null.offset(DS as isize)
        && *segment_offsets.offset(DS as isize) == 0
        && *segment_offsets.offset(CS as isize) == 0;
}

pub unsafe fn run_prefix_instruction() {
    run_instruction(return_on_pagefault!(read_imm8()) | (is_osize_32() as i32) << 8);
}

pub unsafe fn segment_prefix_op(seg: i32) {
    dbg_assert!(seg <= 5 && seg >= 0);
    *prefixes = crate::decode_rules::apply_prefix(
        *prefixes,
        [0x26, 0x2E, 0x36, 0x3E, 0x64, 0x65][seg as usize],
    )
    .unwrap();
    run_prefix_instruction();
    *prefixes = 0
}

#[no_mangle]
pub unsafe fn main_loop() -> f64 {
    profiler::stat_increment(stat::MAIN_LOOP);

    let start = js::microtick();
    crate::ir::runtime::schedule::begin_frame(start);

    if *in_hlt {
        profiler::performance_execution_add(4, 1.0);
        if *flags & FLAG_INTERRUPT != 0
            || *acpi_enabled && !*nmi_blocked && apic::nmi_pending()
            || crate::cpu::smm::smi_deliverable()
        {
            let performance_start = profiler::performance_timer_start();
            let t = js::run_hardware_timers(*acpi_enabled, start);
            handle_irqs();
            profiler::performance_timer_finish(performance_start, 1);
            if *in_hlt {
                profiler::stat_increment(stat::MAIN_LOOP_IDLE);
                let t = t - crate::ir::runtime::schedule::idle((t - 0.25).min(8.0));
                return profiler::performance_main_loop_exit(t.max(0.0), true);
            }
        }
        else {
            // dead
            return profiler::performance_main_loop_exit(100.0, true);
        }
    }

    let mut batches = 0;
    loop {
        batches += 1;
        let performance_start = profiler::performance_batch_start();
        let publication_yield = do_many_cycles_native();
        profiler::performance_timer_finish(performance_start, 0);

        let now = js::microtick();
        let performance_start = profiler::performance_timer_start();
        let t = js::run_hardware_timers(*acpi_enabled, now);
        handle_irqs();
        profiler::performance_timer_finish(performance_start, 1);
        if *in_hlt {
            let t = t - crate::ir::runtime::schedule::idle((t - 0.25).min(8.0));
            return profiler::performance_main_loop_exit(t.max(0.0), true);
        }
        if core_yield {
            core_yield = false;
            return profiler::performance_main_loop_exit(0.0, false);
        }

        // Give the host a chance to install a newly submitted IR module. All
        // guest state is committed and the normal timer/IRQ work above is kept.
        // Only a new submission requests this; a held Promise cannot spin here.
        if publication_yield || now - start > TIME_PER_FRAME || batches >= 16 {
            break;
        }
    }

    return profiler::performance_main_loop_exit(0.0, false);
}

// The CPU batch in progress: IR chaining stops at the batch's instruction
// budget, as the outer loop would.
static mut jit_link_batch: bool = false;
static mut jit_link_batch_start: u32 = 0;
static mut jit_link_batch_limit: u32 = LOOP_COUNTER as u32;
pub unsafe fn ir_link_budget_available() -> bool {
    jit_link_batch
        && !core_yield
        && !crate::cpu::execution::irq_exit_requested()
        && !apic::has_core_events()
        && (*instruction_counter).wrapping_sub(jit_link_batch_start) < jit_link_batch_limit
}

pub unsafe fn do_many_cycles_native() -> bool {
    let mut publication_yield = false;
    let diagnostic_start = crate::ir::runtime::diagnostics::batch_start();
    profiler::stat_increment(stat::DO_MANY_CYCLES);
    crate::ir::runtime::entry::ir_admission_barrier();
    let initial_instruction_counter = *instruction_counter;
    jit_link_batch_start = initial_instruction_counter;
    jit_link_batch_limit = LOOP_COUNTER as u32;
    *slice_budget = LOOP_COUNTER as u32;
    // (P4.6: a batch running 64-bit code compiles WOW64's waiting pages)
    if crate::x64::state::mode().is_long() && crate::ir::runtime::schedule::long_visit() {
        return true;
    }
    jit_link_batch = true;
    while (*instruction_counter).wrapping_sub(initial_instruction_counter) < LOOP_COUNTER as u32
        && !*in_hlt
        && !core_yield
    {
        // With cores in workers: acknowledge other cores' code publications
        // and take their code writes between entries, so that a core
        // installing code rarely waits for this one (crate::parallel::code;
        // two loads when nothing is new, nothing in the normal build)
        crate::parallel::code::poll();
        crate::x64::extended::safe_point();
        // (P4.6: an address space switch in 64-bit code)
        if crate::ir::runtime::schedule::LONG_VISIT_AGAIN
            && crate::x64::state::mode().is_long()
            && crate::ir::runtime::schedule::long_visit()
        {
            publication_yield = true;
            break;
        }
        if cycle_internal() {
            publication_yield = true;
            break;
        }
    }
    jit_link_batch = false;
    crate::ir::runtime::diagnostics::batch_end(diagnostic_start);
    publication_yield
}

#[cold]
pub unsafe fn trigger_de() {
    crate::cpu::execution::mark_fault();
    dbg_log!("#de");
    *instruction_pointer = *previous_ip;
    if DEBUG {
        if js::cpu_exception_hook(CPU_EXCEPTION_DE) {
            return;
        }
    }
    crate::cpu::exceptions::fault(CPU_EXCEPTION_DE, None);
}

#[inline(never)]
pub unsafe fn trigger_ud() {
    crate::cpu::execution::mark_fault();
    dbg_log!("#ud");
    dbg_trace();
    *instruction_pointer = *previous_ip;
    if DEBUG {
        if js::cpu_exception_hook(CPU_EXCEPTION_UD) {
            return;
        }
    }
    crate::cpu::exceptions::fault(CPU_EXCEPTION_UD, None);
}

#[inline(never)]
pub unsafe fn trigger_nm() {
    crate::cpu::execution::mark_fault();
    dbg_log!("#nm eip={:x}", *previous_ip);
    dbg_trace();
    *instruction_pointer = *previous_ip;
    if DEBUG {
        if js::cpu_exception_hook(CPU_EXCEPTION_NM) {
            return;
        }
    }
    crate::cpu::exceptions::fault(CPU_EXCEPTION_NM, None);
}

#[inline(never)]
pub unsafe fn trigger_gp(code: i32) {
    crate::cpu::execution::mark_fault();
    dbg_log!("#gp");
    *instruction_pointer = *previous_ip;
    if DEBUG {
        if js::cpu_exception_hook(CPU_EXCEPTION_GP) {
            return;
        }
    }
    crate::cpu::exceptions::fault(CPU_EXCEPTION_GP, Some(code));
}

/// An unmasked SIMD floating-point exception (cpu/simd_fp.rs): #XM, or #UD
/// without CR4.OSXMMEXCPT
#[inline(never)]
pub unsafe fn trigger_simd_fp() {
    if *cr.offset(4) & CR4_OSXMMEXCPT == 0 {
        trigger_ud();
        return;
    }
    crate::cpu::execution::mark_fault();
    dbg_log!("#xm");
    *instruction_pointer = *previous_ip;
    if DEBUG {
        if js::cpu_exception_hook(CPU_EXCEPTION_XM) {
            return;
        }
    }
    crate::cpu::exceptions::fault(CPU_EXCEPTION_XM, None);
}

#[cold]
pub unsafe fn virt_boundary_read16(low: u32, high: u32) -> i32 {
    dbg_assert!(low & 0xFFF == 0xFFF);
    dbg_assert!(high & 0xFFF == 0);
    return memory::read8(low as u32) | memory::read8(high as u32) << 8;
}

#[cold]
pub unsafe fn virt_boundary_read32s(low: u32, high: u32) -> i32 {
    dbg_assert!(low & 0xFFF >= 0xFFD);
    dbg_assert!(high - 3 & 0xFFF == low & 0xFFF);
    let mid;
    if 0 != low & 1 {
        if 0 != low & 2 {
            // 0xFFF
            mid = memory::read16(high - 2)
        }
        else {
            // 0xFFD
            mid = memory::read16(low + 1)
        }
    }
    else {
        // 0xFFE
        mid = virt_boundary_read16(low + 1, high - 1)
    }
    return memory::read8(low as u32) | mid << 8 | memory::read8(high as u32) << 24;
}

#[cold]
pub unsafe fn virt_boundary_write16(low: u32, high: u32, value: i32) {
    dbg_assert!(low & 0xFFF == 0xFFF);
    dbg_assert!(high & 0xFFF == 0);
    memory::write8(low as u32, value);
    memory::write8(high as u32, value >> 8);
}

#[cold]
pub unsafe fn virt_boundary_write32(low: u32, high: u32, value: i32) {
    dbg_assert!(low & 0xFFF >= 0xFFD);
    dbg_assert!(high - 3 & 0xFFF == low & 0xFFF);
    memory::write8(low as u32, value);
    if 0 != low & 1 {
        if 0 != low & 2 {
            // 0xFFF
            memory::write8((high - 2) as u32, value >> 8);
            memory::write8((high - 1) as u32, value >> 16);
        }
        else {
            // 0xFFD
            memory::write8((low + 1) as u32, value >> 8);
            memory::write8((low + 2) as u32, value >> 16);
        }
    }
    else {
        // 0xFFE
        memory::write8((low + 1) as u32, value >> 8);
        memory::write8((high - 1) as u32, value >> 16);
    }
    memory::write8(high as u32, value >> 24);
}

/// Compatibility mode: the backing of `bytes` bytes at `addr` (not crossing a
/// page) when the 32-bit TLB has the page for this access (writes: neither
/// read-only nor with compiled code), else None. Entries are x64
/// translations of 32-bit linear addresses (fill_ia32e_tlb), of RAM or an
/// extended RAM frame: plain memory, possibly outside the guest's RAM range,
/// so callers read and write the wasm memory directly.
#[inline(always)]
unsafe fn ia32e_compat_backing(addr: i32, bytes: u32, write: bool) -> Option<u32> {
    if *x64_cs_long != 0 || (addr as u32 & 0xFFF) > 0x1000 - bytes {
        return None;
    }
    let entry = tlb_data[(addr as u32 >> 12) as usize];
    let mask = TLB_VALID
        | if *cpl == 3 { TLB_NO_USER } else { 0 }
        | if write { TLB_READONLY | TLB_HAS_CODE } else { 0 };
    if entry & mask != TLB_VALID {
        return None;
    }
    Some(((entry & !0xFFF ^ addr) as u32).wrapping_sub(memory::mem8 as u32))
}
#[inline(always)]
unsafe fn compat_host(backing: u32) -> *mut u8 { memory::mem8.wrapping_add(backing as usize) }

pub unsafe fn safe_read8(addr: i32) -> OrPageFault<i32> {
    if crate::x64::state::efer() & crate::x64::state::EFER_LMA != 0 {
        if let Some(backing) = ia32e_compat_backing(addr, 1, false) {
            return Ok(*compat_host(backing) as i32);
        }
        return ia32e_read(addr, 8).map(|value| value as i32);
    }
    Ok(memory::read8(translate_address_read(addr)?))
}

pub unsafe fn safe_read16(addr: i32) -> OrPageFault<i32> {
    if crate::x64::state::efer() & crate::x64::state::EFER_LMA != 0 {
        if let Some(backing) = ia32e_compat_backing(addr, 2, false) {
            return Ok(memory::read16_no_mmap_check(backing));
        }
        return ia32e_read(addr, 16).map(|value| value as i32);
    }
    if addr & 0xFFF == 0xFFF {
        Ok(safe_read8(addr)? | safe_read8(addr + 1)? << 8)
    }
    else {
        Ok(memory::read16(translate_address_read(addr)?))
    }
}

pub unsafe fn safe_read32s(addr: i32) -> OrPageFault<i32> {
    if crate::x64::state::efer() & crate::x64::state::EFER_LMA != 0 {
        if let Some(backing) = ia32e_compat_backing(addr, 4, false) {
            return Ok(memory::read32_no_mmap_check(backing));
        }
        return ia32e_read(addr, 32).map(|value| value as i32);
    }
    if addr & 0xFFF >= 0xFFD {
        Ok(safe_read16(addr)? | safe_read16(addr + 2)? << 16)
    }
    else {
        Ok(memory::read32s(translate_address_read(addr)?))
    }
}

pub unsafe fn safe_read_f32(addr: i32) -> OrPageFault<f32> {
    Ok(f32::from_bits(i32::cast_unsigned(safe_read32s(addr)?)))
}

pub unsafe fn safe_read64s(addr: i32) -> OrPageFault<u64> {
    if crate::x64::state::efer() & crate::x64::state::EFER_LMA != 0 {
        if let Some(backing) = ia32e_compat_backing(addr, 8, false) {
            return Ok(std::ptr::read_unaligned(compat_host(backing) as *const u64));
        }
        return ia32e_read(addr, 64);
    }
    if addr & 0xFFF > 0x1000 - 8 {
        Ok(safe_read32s(addr)? as u32 as u64 | (safe_read32s(addr + 4)? as u32 as u64) << 32)
    }
    else {
        Ok(memory::read64s(translate_address_read(addr)?) as u64)
    }
}

/// The m128 operand of a legacy SSE form other than MOVUPS, MOVUPD, MOVDQU
/// and LDDQU (exception type 4, SDM vol. 2 table 2-21): #GP(0) unless
/// 16-byte aligned, whatever the segment, before any page fault
pub unsafe fn aligned16(addr: i32) -> OrPageFault<()> {
    if addr & 15 != 0 {
        trigger_gp(0);
        return Err(());
    }
    Ok(())
}
pub unsafe fn safe_read128s_aligned(addr: i32) -> OrPageFault<reg128> {
    aligned16(addr)?;
    safe_read128s(addr)
}

pub unsafe fn safe_read128s(addr: i32) -> OrPageFault<reg128> {
    if crate::x64::state::efer() & crate::x64::state::EFER_LMA != 0 {
        return ia32e_read128(addr);
    }
    if addr & 0xFFF > 0x1000 - 16 {
        Ok(reg128 {
            u64: [safe_read64s(addr)?, safe_read64s(addr + 8)?],
        })
    }
    else {
        Ok(memory::read128(translate_address_read(addr)?))
    }
}

pub unsafe fn safe_write8(addr: i32, value: i32) -> OrPageFault<()> {
    if crate::x64::state::efer() & crate::x64::state::EFER_LMA != 0 {
        if let Some(backing) = ia32e_compat_backing(addr, 1, true) {
            memory::write8_no_mmap_or_dirty_check(backing, value);
            return Ok(());
        }
        return ia32e_write(addr, 8, value as u32 as u64);
    }
    let (phys_addr, can_skip_dirty_page) = translate_address_write_and_can_skip_dirty(addr)?;
    if memory::in_mapped_range(phys_addr) {
        memory::mmap_write8(phys_addr, value);
    }
    else {
        if !can_skip_dirty_page {
            jit::jit_dirty_page(Page::page_of(phys_addr));
        }
        else {
            dbg_assert!(!jit::jit_page_has_code(Page::page_of(phys_addr as u32)));
        }
        memory::write8_no_mmap_or_dirty_check(phys_addr, value);
    };
    Ok(())
}

pub unsafe fn safe_write16(addr: i32, value: i32) -> OrPageFault<()> {
    if crate::x64::state::efer() & crate::x64::state::EFER_LMA != 0 {
        if let Some(backing) = ia32e_compat_backing(addr, 2, true) {
            memory::write16_no_mmap_or_dirty_check(backing, value);
            return Ok(());
        }
        return ia32e_write(addr, 16, value as u32 as u64);
    }
    let (phys_addr, can_skip_dirty_page) = translate_address_write_and_can_skip_dirty(addr)?;
    dbg_assert!(value >= 0 && value < 0x10000);
    if addr & 0xFFF == 0xFFF {
        virt_boundary_write16(phys_addr, translate_address_write(addr + 1)?, value);
    }
    else if memory::in_mapped_range(phys_addr) {
        memory::mmap_write16(phys_addr, value);
    }
    else {
        if !can_skip_dirty_page {
            jit::jit_dirty_page(Page::page_of(phys_addr));
        }
        else {
            dbg_assert!(!jit::jit_page_has_code(Page::page_of(phys_addr as u32)));
        }
        memory::write16_no_mmap_or_dirty_check(phys_addr, value);
    };
    Ok(())
}

pub unsafe fn safe_write32(addr: i32, value: i32) -> OrPageFault<()> {
    if crate::x64::state::efer() & crate::x64::state::EFER_LMA != 0 {
        if let Some(backing) = ia32e_compat_backing(addr, 4, true) {
            memory::write32_no_mmap_or_dirty_check(backing, value);
            return Ok(());
        }
        return ia32e_write(addr, 32, value as u32 as u64);
    }
    let (phys_addr, can_skip_dirty_page) = translate_address_write_and_can_skip_dirty(addr)?;
    if addr & 0xFFF > 0x1000 - 4 {
        virt_boundary_write32(
            phys_addr,
            translate_address_write(addr + 3 & !3)? | (addr as u32 + 3 & 3),
            value,
        );
    }
    else if memory::in_mapped_range(phys_addr) {
        memory::mmap_write32(phys_addr, value);
    }
    else {
        if !can_skip_dirty_page {
            jit::jit_dirty_page(Page::page_of(phys_addr));
        }
        else {
            dbg_assert!(!jit::jit_page_has_code(Page::page_of(phys_addr as u32)));
        }
        memory::write32_no_mmap_or_dirty_check(phys_addr, value);
    };
    Ok(())
}

pub unsafe fn safe_write64(addr: i32, value: u64) -> OrPageFault<()> {
    if crate::x64::state::efer() & crate::x64::state::EFER_LMA != 0 {
        if let Some(backing) = ia32e_compat_backing(addr, 8, true) {
            memory::write64_no_mmap_or_dirty_check(backing, value);
            return Ok(());
        }
        return ia32e_write(addr, 64, value);
    }
    if addr & 0xFFF > 0x1000 - 8 {
        writable_or_pagefault(addr, 8)?;
        safe_write32(addr, value as i32).unwrap();
        safe_write32(addr + 4, (value >> 32) as i32).unwrap();
    }
    else {
        let (phys_addr, can_skip_dirty_page) = translate_address_write_and_can_skip_dirty(addr)?;
        if memory::in_mapped_range(phys_addr) {
            memory::mmap_write64(phys_addr, value);
        }
        else {
            if !can_skip_dirty_page {
                jit::jit_dirty_page(Page::page_of(phys_addr));
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
    if crate::x64::state::efer() & crate::x64::state::EFER_LMA != 0 {
        return ia32e_write128(addr, value);
    }
    if addr & 0xFFF > 0x1000 - 16 {
        writable_or_pagefault(addr, 16)?;
        safe_write64(addr, value.u64[0]).unwrap();
        safe_write64(addr + 8, value.u64[1]).unwrap();
    }
    else {
        let (phys_addr, can_skip_dirty_page) = translate_address_write_and_can_skip_dirty(addr)?;
        if memory::in_mapped_range(phys_addr) {
            memory::mmap_write128(phys_addr, value.u64[0], value.u64[1]);
        }
        else {
            if !can_skip_dirty_page {
                jit::jit_dirty_page(Page::page_of(phys_addr));
            }
            else {
                dbg_assert!(!jit::jit_page_has_code(Page::page_of(phys_addr as u32)));
            }
            memory::write128_no_mmap_or_dirty_check(phys_addr, value);
        }
    };
    Ok(())
}

#[cold]
#[inline(never)]
unsafe fn wide_read_write(
    addr: i32,
    width: u8,
    instruction: &dyn Fn(i32) -> i32,
) -> OrPageFault<()> {
    let linear = addr as u32 as u64;
    // (a locked commit when other cores run in workers, see x64::memory::run_locked)
    crate::x64::memory::run_locked(|| {
        crate::x64::memory::probe_write(linear, width, false)?;
        let value = crate::x64::memory::read(linear, width, false)?;
        let result = instruction(value as i32);
        crate::x64::memory::write(linear, width, result as u32 as u64, false)
    })
    .map_err(|fault| crate::x64::system::raise(fault))
}

/// Commit `instruction` applied to the RAM operand at `phys_addr` (naturally
/// sized access within one page): read, compute, then store only if the
/// operand is unchanged, else start over. With one core, a plain store.
#[inline(always)]
unsafe fn read_write_ram(phys_addr: u32, bytes: u32, instruction: &dyn Fn(i32) -> i32) {
    #[cfg(feature = "parallel")]
    let saved = crate::parallel::Registers::save();
    loop {
        let x = match bytes {
            1 => memory::read8_no_mmap_check(phys_addr),
            2 => memory::read16_no_mmap_check(phys_addr),
            _ => memory::read32_no_mmap_check(phys_addr),
        };
        let value = instruction(x);
        dbg_assert!(bytes == 4 || value >= 0 && value < 1 << (8 * bytes));
        let mask = if bytes == 4 { u32::MAX as u64 } else { (1 << 8 * bytes) - 1 };
        if memory::compare_exchange_no_mmap_or_dirty_check(
            phys_addr,
            bytes,
            x as u32 as u64 & mask,
            value as u32 as u64 & mask,
        ) {
            return;
        }
        #[cfg(feature = "parallel")]
        saved.restore();
    }
}

#[inline(always)]
pub unsafe fn safe_read_write8(addr: i32, instruction: &dyn Fn(i32) -> i32) {
    if crate::x64::state::efer() & crate::x64::state::EFER_LMA != 0 {
        // (compatibility mode, the page in the 32-bit TLB: as below)
        if let Some(backing) = ia32e_compat_backing(addr, 1, true) {
            read_write_ram(backing, 1, instruction);
            return;
        }
        let _ = wide_read_write(addr, 8, instruction);
        return;
    }
    let (phys_addr, can_skip_dirty_page) =
        return_on_pagefault!(translate_address_write_and_can_skip_dirty(addr));
    if memory::in_mapped_range(phys_addr) {
        let x = memory::read8(phys_addr);
        let value = instruction(x);
        dbg_assert!(value >= 0 && value < 0x100);
        memory::mmap_write8(phys_addr, value);
    }
    else {
        if !can_skip_dirty_page {
            jit::jit_dirty_page(Page::page_of(phys_addr));
        }
        else {
            dbg_assert!(!jit::jit_page_has_code(Page::page_of(phys_addr as u32)));
        }
        read_write_ram(phys_addr, 1, instruction);
    }
}

#[inline(always)]
pub unsafe fn safe_read_write16(addr: i32, instruction: &dyn Fn(i32) -> i32) {
    let _ = safe_read_write16_checked(addr, instruction);
}

pub unsafe fn safe_read_write16_checked(
    addr: i32,
    instruction: &dyn Fn(i32) -> i32,
) -> OrPageFault<()> {
    if crate::x64::state::efer() & crate::x64::state::EFER_LMA != 0 {
        // (compatibility mode, the page in the 32-bit TLB: as below)
        if let Some(backing) = ia32e_compat_backing(addr, 2, true) {
            read_write_ram(backing, 2, instruction);
            return Ok(());
        }
        return wide_read_write(addr, 16, instruction);
    }
    let (phys_addr, can_skip_dirty_page) = translate_address_write_and_can_skip_dirty(addr)?;
    if phys_addr & 0xFFF == 0xFFF {
        let phys_addr_high = translate_address_write(addr + 1)?;
        // (a split operand: locked only against other split locked operations)
        crate::parallel::split_lock().lock();
        let x = virt_boundary_read16(phys_addr, phys_addr_high);
        virt_boundary_write16(phys_addr, phys_addr_high, instruction(x));
        crate::parallel::split_lock().unlock();
    }
    else if memory::in_mapped_range(phys_addr) {
        let x = memory::read16(phys_addr);
        let value = instruction(x);
        dbg_assert!(value >= 0 && value < 0x10000);
        memory::mmap_write16(phys_addr, value);
    }
    else {
        if !can_skip_dirty_page {
            jit::jit_dirty_page(Page::page_of(phys_addr));
        }
        else {
            dbg_assert!(!jit::jit_page_has_code(Page::page_of(phys_addr as u32)));
        }
        read_write_ram(phys_addr, 2, instruction);
    }
    Ok(())
}

#[inline(always)]
pub unsafe fn safe_read_write32(addr: i32, instruction: &dyn Fn(i32) -> i32) {
    if crate::x64::state::efer() & crate::x64::state::EFER_LMA != 0 {
        // (compatibility mode, the page in the 32-bit TLB: as below)
        if let Some(backing) = ia32e_compat_backing(addr, 4, true) {
            read_write_ram(backing, 4, instruction);
            return;
        }
        let _ = wide_read_write(addr, 32, instruction);
        return;
    }
    let (phys_addr, can_skip_dirty_page) =
        return_on_pagefault!(translate_address_write_and_can_skip_dirty(addr));
    if phys_addr & 0xFFF >= 0xFFD {
        let phys_addr_high = return_on_pagefault!(translate_address_write(addr + 3 & !3));
        let phys_addr_high = phys_addr_high | (addr as u32) + 3 & 3;
        crate::parallel::split_lock().lock();
        let x = virt_boundary_read32s(phys_addr, phys_addr_high);
        virt_boundary_write32(phys_addr, phys_addr_high, instruction(x));
        crate::parallel::split_lock().unlock();
    }
    else if memory::in_mapped_range(phys_addr) {
        let x = memory::read32s(phys_addr);
        let value = instruction(x);
        memory::mmap_write32(phys_addr, value);
    }
    else {
        if !can_skip_dirty_page {
            jit::jit_dirty_page(Page::page_of(phys_addr));
        }
        else {
            dbg_assert!(!jit::jit_page_has_code(Page::page_of(phys_addr as u32)));
        }
        read_write_ram(phys_addr, 4, instruction);
    }
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

pub unsafe fn read_mmx32s(r: i32) -> i32 {
    crate::cpu::fpu::fpu_sync_slot(r as u32);
    (*fpu_st.offset(r as isize)).mantissa as i32
}

pub unsafe fn read_mmx64s(r: i32) -> u64 {
    crate::cpu::fpu::fpu_sync_slot(r as u32);
    (*fpu_st.offset(r as isize)).mantissa
}

pub unsafe fn write_mmx_reg64(r: i32, data: u64) {
    crate::cpu::fpu::fpu_invalidate_slot(r as u32);
    *fpu_st.offset(r as isize) = softfloat::F80 {
        mantissa: data,
        sign_exponent: 0xFFFF,
    };
}

// XMM0..7 retain the legacy ABI; XMM8..15 use the per-core wide bank.
#[inline]
unsafe fn xmm_register_pointer(r: i32) -> *mut reg128 {
    crate::x64::state::xmm_offset(r as usize) as *mut reg128
}

pub unsafe fn read_xmm_f32(r: i32) -> f32 { return (*xmm_register_pointer(r)).f32[0]; }

pub unsafe fn read_xmm32(r: i32) -> i32 { return (*xmm_register_pointer(r)).u32[0] as i32; }

pub unsafe fn read_xmm64s(r: i32) -> u64 { (*xmm_register_pointer(r)).u64[0] }

pub unsafe fn read_xmm128s(r: i32) -> reg128 { return *xmm_register_pointer(r); }

pub unsafe fn write_xmm_f32(r: i32, data: f32) { (*xmm_register_pointer(r)).f32[0] = data; }

pub unsafe fn write_xmm32(r: i32, data: i32) { (*xmm_register_pointer(r)).i32[0] = data; }

pub unsafe fn write_xmm64(r: i32, data: u64) { (*xmm_register_pointer(r)).u64[0] = data }
pub unsafe fn write_xmm_f64(r: i32, data: f64) { (*xmm_register_pointer(r)).f64[0] = data }

pub unsafe fn write_xmm128(r: i32, i0: i32, i1: i32, i2: i32, i3: i32) {
    let x = reg128 {
        u32: [i0 as u32, i1 as u32, i2 as u32, i3 as u32],
    };
    *xmm_register_pointer(r) = x;
}

pub unsafe fn write_xmm128_2(r: i32, i0: u64, i1: u64) {
    *xmm_register_pointer(r) = reg128 { u64: [i0, i1] };
}

pub unsafe fn write_xmm_reg128(r: i32, data: reg128) { *xmm_register_pointer(r) = data; }

/// Set the fpu tag word to valid and the top-of-stack to 0 on mmx instructions
#[no_mangle]
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

/// RC, DAZ, FZ and the exception masks apply through cpu::simd_fp
pub unsafe fn set_mxcsr(new_mxcsr: i32) {
    dbg_assert!(new_mxcsr & !MXCSR_MASK == 0); // checked by caller
    *mxcsr = new_mxcsr;
}

/// The checks of an MMX form (gen/x86_table.js mmx_form): #UD with CR0.EM,
/// then #NM with CR0.TS
pub unsafe fn task_switch_test_mmx() -> bool {
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

/// The checks of a legacy SSE XMM form: #UD with CR0.EM or without
/// CR4.OSFXSR, then #NM with CR0.TS
pub unsafe fn task_switch_test_xmm() -> bool {
    if 0 != *cr & CR0_EM || 0 == *cr.offset(4) & CR4_OSFXSR {
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
    let current_value = (js::microtick() * TSC_RATE) as u64;
    tsc_offset = current_value.wrapping_sub(new_value);
}

#[no_mangle]
pub unsafe fn read_tsc() -> u64 { ((js::microtick() * TSC_RATE) as u64).wrapping_sub(tsc_offset) }

pub unsafe fn vm86_mode() -> bool { return *flags & FLAG_VM == FLAG_VM; }

#[no_mangle]
pub unsafe fn getiopl() -> i32 { return *flags >> 12 & 3; }

pub unsafe fn invlpg(addr: i32) {
    let page = (addr as u32 >> 12) as i32;
    // Note: Doesn't remove this page from valid_tlb_entries: This isn't
    // necessary, because when valid_tlb_entries grows too large, it will be
    // empties by calling clear_tlb, which removes this entry as it isn't global.
    // This however means that valid_tlb_entries can contain some invalid entries
    tlb_data[page as usize] = 0;
    *last_virt_eip = -1;
    // (P7.1: the page tier's code translation of the page, if any)
    if crate::x64::state::efer() & crate::x64::state::EFER_LMA == 0 {
        crate::x64::pages::forget_code_page(crate::cpu::apic::current_core(), addr as u32 as u64);
    }
}

#[no_mangle]
pub unsafe fn update_eflags(new_flags: i32) {
    let mut dont_update = FLAG_RF | FLAG_VM | FLAG_VIP | FLAG_VIF;
    let mut clear = !FLAG_VIP & !FLAG_VIF & FLAGS_MASK;
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
    let mut result = 0;
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
    let mut result = 0;
    for i in 0..valid_tlb_entries_count {
        let page = valid_tlb_entries[i as usize];
        let entry = tlb_data[page as usize];
        if 0 != entry & TLB_GLOBAL {
            result += 1
        }
    }
    return result;
}

#[cold]
pub unsafe fn trigger_ts(code: i32) {
    crate::cpu::execution::mark_fault();
    *instruction_pointer = *previous_ip;
    crate::cpu::exceptions::fault(10, Some(code));
}

#[inline(never)]
pub unsafe fn trigger_np(code: i32) {
    crate::cpu::execution::mark_fault();
    dbg_log!("#np");
    *instruction_pointer = *previous_ip;
    if DEBUG {
        if js::cpu_exception_hook(CPU_EXCEPTION_NP) {
            return;
        }
    }
    crate::cpu::exceptions::fault(CPU_EXCEPTION_NP, Some(code));
}

#[inline(never)]
pub unsafe fn trigger_ss(code: i32) {
    crate::cpu::execution::mark_fault();
    dbg_log!("#ss");
    *instruction_pointer = *previous_ip;
    if DEBUG {
        if js::cpu_exception_hook(CPU_EXCEPTION_SS) {
            return;
        }
    }
    crate::cpu::exceptions::fault(CPU_EXCEPTION_SS, Some(code));
}

#[no_mangle]
pub unsafe fn store_current_tsc() { *current_tsc = read_tsc(); }

#[no_mangle]
pub unsafe fn handle_irqs() {
    if crate::cpu::execution::irqs_deferred() {
        crate::cpu::execution::note_held_irq();
        return;
    }
    if crate::cpu::exceptions::delivering() {
        return;
    }
    crate::cpu::execution::held_irqs_served();
    let core = apic::current_core() as u32;
    let shutdown = crate::cpu::exceptions::exception_shutdown(core);
    if shutdown == 2 {
        return;
    }
    // SMI: before NMI, regardless of IF; latched while in SMM (until RSM)
    if !crate::cpu::smm::smm_active() && apic::take_smi() && crate::cpu::smm::smm_enter() {
        crate::cpu::exceptions::exception_restore(core, 0);
        return;
    }
    // NMI: regardless of IF, not while an NMI handler runs (until IRET)
    if *acpi_enabled && !*nmi_blocked && apic::take_nmi() {
        crate::cpu::exceptions::exception_restore(core, 0);
        *nmi_blocked = true;
        pic_call_irq(CPU_EXCEPTION_NMI as u8);
        return;
    }
    if shutdown != 0 {
        return;
    }
    if *flags & FLAG_INTERRUPT != 0 && *interrupt_shadow == 0 {
        // the 8259 PIC is wired to the bootstrap processor (LINT0 of core 0)
        let pic_irq = apic::acknowledge_pic_irq();
        if let Some(irq) = pic_irq {
            pic_call_irq(irq)
        }
        else if *acpi_enabled {
            if let Some(irq) = apic::acknowledge_irq() {
                pic_call_irq(irq)
            }
        }
    }
}

/// Whether handle_irqs would deliver an interrupt now, without its effects
/// (nothing is acknowledged)
pub unsafe fn irq_deliverable() -> bool {
    if crate::cpu::smm::smi_deliverable() || *acpi_enabled && !*nmi_blocked && apic::nmi_pending() {
        return true;
    }
    *flags & FLAG_INTERRUPT != 0
        && *interrupt_shadow == 0
        && (apic::routed_pic_pending(apic::current_core() as u32)
            || *acpi_enabled && apic::has_pending_irq())
}

unsafe fn pic_call_irq(interrupt_nr: u8) {
    // (cross-modifying code: other cores' code writes are seen from here on)
    crate::parallel::code::poll();
    *previous_ip = *instruction_pointer; // XXX: What if called after instruction (port IO)
    if *in_hlt {
        js::stop_idling();
        *in_hlt = false;
    }
    call_interrupt_vector(interrupt_nr as i32, false, None);
}

#[no_mangle]
unsafe fn device_raise_irq(i: u8) {
    pic::set_irq(i);
    if *acpi_enabled {
        ioapic::set_irq(i);
    }
    handle_irqs()
}

#[no_mangle]
unsafe fn device_lower_irq(i: u8) {
    pic::clear_irq(i);
    if *acpi_enabled {
        ioapic::clear_irq(i);
    }
    handle_irqs()
}

/// An IOAPIC input without a PIC counterpart: GSI 16-23, where Q35 connects
/// the PIRQs (the PIC sees them only through the PIRQ routing registers)
#[no_mangle]
unsafe fn ioapic_raise_irq(i: u8) {
    if *acpi_enabled {
        ioapic::set_irq(i);
    }
    handle_irqs()
}

#[no_mangle]
unsafe fn ioapic_lower_irq(i: u8) {
    if *acpi_enabled {
        ioapic::clear_irq(i);
    }
    handle_irqs()
}

/// A message signalled interrupt (PCI MSI): a device's write of `data` to
/// `address` in the local APICs' range. Address bits 19:12 are the
/// destination, bit 2 the destination mode; data bits 7:0 the vector, 10:8
/// the delivery mode. Edge triggered. Returns whether a local APIC took it.
#[no_mangle]
unsafe fn apic_msi(address: u32, data: u32) -> bool {
    if !*acpi_enabled || address >> 20 != 0xFEE {
        return false;
    }
    let mode = (data >> 8 & 7) as u8;
    // fixed, lowest priority, SMI, NMI, INIT, ExtINT
    if !matches!(mode, 0 | 1 | 2 | 4 | 5 | 7) {
        return false;
    }
    let accepted = apic::route(
        data as u8,
        mode,
        false,
        (address >> 12) as u8,
        (address >> 2 & 1) as u8,
    );
    handle_irqs();
    accepted
}

pub fn io_port_read8(port: i32) -> i32 {
    unsafe {
        // (a worker's core reaches the machine's PIC through the devices' thread)
        if crate::parallel::is_worker() {
            return js::io_port_read8(port);
        }
        match port {
            0x20 => pic::port20_read() as i32,
            0x21 => pic::port21_read() as i32,
            0xA0 => pic::portA0_read() as i32,
            0xA1 => pic::portA1_read() as i32,
            0x4D0 => pic::port4D0_read() as i32,
            0x4D1 => pic::port4D1_read() as i32,
            _ => js::io_port_read8(port),
        }
    }
}
pub fn io_port_read16(port: i32) -> i32 { unsafe { js::io_port_read16(port) } }
pub fn io_port_read32(port: i32) -> i32 { unsafe { js::io_port_read32(port) } }

pub fn io_port_write8(port: i32, value: i32) {
    unsafe {
        if crate::parallel::is_worker() {
            return js::io_port_write8(port, value);
        }
        match port {
            0x20 | 0x21 | 0xA0 | 0xA1 | 0x4D0 | 0x4D1 => {
                match port {
                    0x20 => pic::port20_write(value as u8),
                    0x21 => pic::port21_write(value as u8),
                    0xA0 => pic::portA0_write(value as u8),
                    0xA1 => pic::portA1_write(value as u8),
                    0x4D0 => pic::port4D0_write(value as u8),
                    0x4D1 => pic::port4D1_write(value as u8),
                    _ => dbg_assert!(false),
                };
                handle_irqs()
            },
            _ => js::io_port_write8(port, value),
        }
    }
}
pub fn io_port_write16(port: i32, value: i32) { unsafe { js::io_port_write16(port, value) } }
pub fn io_port_write32(port: i32, value: i32) { unsafe { js::io_port_write32(port, value) } }

// Port accesses of cores in workers, performed by the machine instance on
// the devices' thread (src/parallel): the same decoding as its own accesses
#[no_mangle]
pub fn machine_io_read8(port: i32) -> i32 { io_port_read8(port) }
#[no_mangle]
pub fn machine_io_write8(port: i32, value: i32) { io_port_write8(port, value) }

/// Reset shared interrupt routing at a board reset, never on a per-core INIT.
#[no_mangle]
pub fn reset_interrupt_controllers() {
    pic::reset();
    ioapic::reset();
}

#[no_mangle]
pub unsafe fn reset_cpu() {
    crate::x64::state::reset_extension();
    crate::cpu::xstate::reset();
    crate::cpu::fpu::fpu_discard_cache();
    for i in 0..8 {
        *segment_is_null.offset(i) = false;
        *segment_limits.offset(i) = 0;
        *segment_offsets.offset(i) = 0;
        *segment_access_bytes.offset(i) = 0x80 | (0 << 5) | 0x10 | 0x02; // P dpl0 S RW

        *reg32.offset(i) = 0;

        *sreg.offset(i) = 0;
        *dreg.offset(i) = 0;

        write_xmm128_2(i as i32, 0, 0);

        *fpu_st.offset(i) = softfloat::F80::ZERO;
    }
    *segment_access_bytes.offset(CS as isize) = 0x80 | (0 << 5) | 0x10 | 0x08 | 0x02; // P dpl0 S E RW

    for i in 0..4 {
        *reg_pdpte.offset(i) = 0
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
    *nmi_blocked = false;
    *interrupt_shadow = 0;
    crate::cpu::smm::reset();
    *slice_budget = LOOP_COUNTER as u32;
    crate::cpu::execution::reset();
    // the local APIC (present with ACPI) is enabled at reset
    *apic_enabled = *acpi_enabled;

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

    update_state_flags();

    jit::jit_clear_cache_js();
}

#[no_mangle]
pub unsafe fn set_cpuid_level(level: u32) { cpuid_level = level }
