#![allow(
    dead_code,
    mutable_transmutes,
    non_camel_case_types,
    non_snake_case,
    non_upper_case_globals,
    unused_mut
)]
#![feature(extern_types, libc)]

use cpu2::cpu::*;

extern "C" {

    #[no_mangle]
    fn cmp8(x: i32, y: i32) -> ();
    #[no_mangle]
    fn cmp16(x: i32, y: i32) -> ();
    #[no_mangle]
    fn cmp32(x: i32, y: i32) -> ();
    #[no_mangle]
    fn __fpclassifyl(_: f64) -> i32;
    #[no_mangle]
    static FLAG_CARRY: i32;
    #[no_mangle]
    static FLAG_PARITY: i32;
    #[no_mangle]
    static FLAG_ADJUST: i32;
    #[no_mangle]
    static FLAG_ZERO: i32;
    #[no_mangle]
    static FLAG_SIGN: i32;
    #[no_mangle]
    static FLAG_TRAP: i32;
    #[no_mangle]
    static FLAG_INTERRUPT: i32;
    #[no_mangle]
    static FLAG_DIRECTION: i32;
    #[no_mangle]
    static FLAG_OVERFLOW: i32;
    #[no_mangle]
    static FLAG_IOPL: i32;
    #[no_mangle]
    static FLAG_NT: i32;
    #[no_mangle]
    static FLAG_RF: i32;
    #[no_mangle]
    static FLAG_VM: i32;
    #[no_mangle]
    static FLAG_AC: i32;
    #[no_mangle]
    static FLAG_VIF: i32;
    #[no_mangle]
    static FLAG_VIP: i32;
    #[no_mangle]
    static FLAG_ID: i32;
    #[no_mangle]
    static FLAGS_DEFAULT: i32;
    #[no_mangle]
    static FLAGS_MASK: i32;
    #[no_mangle]
    static FLAGS_ALL: i32;
    #[no_mangle]
    static OPSIZE_8: i32;
    #[no_mangle]
    static OPSIZE_16: i32;
    #[no_mangle]
    static OPSIZE_32: i32;
    #[no_mangle]
    static EAX: i32;
    #[no_mangle]
    static ECX: i32;
    #[no_mangle]
    static EDX: i32;
    #[no_mangle]
    static EBX: i32;
    #[no_mangle]
    static ESP: i32;
    #[no_mangle]
    static EBP: i32;
    #[no_mangle]
    static ESI: i32;
    #[no_mangle]
    static EDI: i32;
    #[no_mangle]
    static AX: i32;
    #[no_mangle]
    static CX: i32;
    #[no_mangle]
    static DX: i32;
    #[no_mangle]
    static BX: i32;
    #[no_mangle]
    static SP: i32;
    #[no_mangle]
    static BP: i32;
    #[no_mangle]
    static SI: i32;
    #[no_mangle]
    static DI: i32;
    #[no_mangle]
    static AL: i32;
    #[no_mangle]
    static CL: i32;
    #[no_mangle]
    static DL: i32;
    #[no_mangle]
    static BL: i32;
    #[no_mangle]
    static AH: i32;
    #[no_mangle]
    static CH: i32;
    #[no_mangle]
    static DH: i32;
    #[no_mangle]
    static BH: i32;
    #[no_mangle]
    static ES: i32;
    #[no_mangle]
    static CS: i32;
    #[no_mangle]
    static SS: i32;
    #[no_mangle]
    static DS: i32;
    #[no_mangle]
    static FS: i32;
    #[no_mangle]
    static GS: i32;
    #[no_mangle]
    static TR: i32;
    #[no_mangle]
    static LDTR: i32;
    #[no_mangle]
    static PAGE_TABLE_PRESENT_MASK: i32;
    #[no_mangle]
    static PAGE_TABLE_RW_MASK: i32;
    #[no_mangle]
    static PAGE_TABLE_USER_MASK: i32;
    #[no_mangle]
    static PAGE_TABLE_ACCESSED_MASK: i32;
    #[no_mangle]
    static PAGE_TABLE_DIRTY_MASK: i32;
    #[no_mangle]
    static PAGE_TABLE_PSE_MASK: i32;
    #[no_mangle]
    static PAGE_TABLE_GLOBAL_MASK: i32;
    #[no_mangle]
    static MMAP_BLOCK_BITS: i32;
    #[no_mangle]
    static MMAP_BLOCK_SIZE: i32;
    #[no_mangle]
    static CR0_PE: i32;
    #[no_mangle]
    static CR0_MP: i32;
    #[no_mangle]
    static CR0_EM: i32;
    #[no_mangle]
    static CR0_TS: i32;
    #[no_mangle]
    static CR0_ET: i32;
    #[no_mangle]
    static CR0_WP: i32;
    #[no_mangle]
    static CR0_NW: i32;
    #[no_mangle]
    static CR0_CD: i32;
    #[no_mangle]
    static CR0_PG: i32;
    #[no_mangle]
    static CR4_VME: i32;
    #[no_mangle]
    static CR4_PVI: i32;
    #[no_mangle]
    static CR4_TSD: i32;
    #[no_mangle]
    static CR4_PSE: i32;
    #[no_mangle]
    static CR4_DE: i32;
    #[no_mangle]
    static CR4_PAE: i32;
    #[no_mangle]
    static CR4_PGE: i32;
    #[no_mangle]
    static IA32_SYSENTER_CS: i32;
    #[no_mangle]
    static IA32_SYSENTER_ESP: i32;
    #[no_mangle]
    static IA32_SYSENTER_EIP: i32;
    #[no_mangle]
    static IA32_TIME_STAMP_COUNTER: i32;
    #[no_mangle]
    static IA32_PLATFORM_ID: i32;
    #[no_mangle]
    static IA32_APIC_BASE_MSR: i32;
    #[no_mangle]
    static IA32_BIOS_SIGN_ID: i32;
    #[no_mangle]
    static MSR_PLATFORM_INFO: i32;
    #[no_mangle]
    static MSR_MISC_FEATURE_ENABLES: i32;
    #[no_mangle]
    static IA32_MISC_ENABLE: i32;
    #[no_mangle]
    static IA32_RTIT_CTL: i32;
    #[no_mangle]
    static MSR_SMI_COUNT: i32;
    #[no_mangle]
    static IA32_MCG_CAP: i32;
    #[no_mangle]
    static IA32_KERNEL_GS_BASE: i32;
    #[no_mangle]
    static MSR_PKG_C2_RESIDENCY: i32;
    #[no_mangle]
    static IA32_APIC_BASE_BSP: i32;
    #[no_mangle]
    static IA32_APIC_BASE_EXTD: i32;
    #[no_mangle]
    static IA32_APIC_BASE_EN: i32;
    #[no_mangle]
    static APIC_ADDRESS: i32;
    #[no_mangle]
    static SEG_PREFIX_NONE: i32;
    #[no_mangle]
    static SEG_PREFIX_ZERO: i32;
    #[no_mangle]
    static PREFIX_MASK_REP: i32;
    #[no_mangle]
    static PREFIX_REPZ: i32;
    #[no_mangle]
    static PREFIX_REPNZ: i32;
    #[no_mangle]
    static PREFIX_MASK_SEGMENT: i32;
    #[no_mangle]
    static PREFIX_MASK_OPSIZE: i32;
    #[no_mangle]
    static PREFIX_MASK_ADDRSIZE: i32;
    #[no_mangle]
    static PREFIX_F2: i32;
    #[no_mangle]
    static PREFIX_F3: i32;
    #[no_mangle]
    static PREFIX_66: i32;
    #[no_mangle]
    static LOG_CPU: i32;
    #[no_mangle]
    static A20_MASK: i32;
    #[no_mangle]
    static A20_MASK16: i32;
    #[no_mangle]
    static A20_MASK32: i32;
    #[no_mangle]
    static MXCSR_MASK: i32;

    #[no_mangle]
    fn c_comment(m: *const i8) -> ();
    #[no_mangle]
    static mut mem8: *mut u8;
    #[no_mangle]
    static mut mem16: *mut u16;
    #[no_mangle]
    static mut mem32s: *mut i32;
    #[no_mangle]
    static mut jit_block_boundary: bool;
    #[no_mangle]
    static VALID_TLB_ENTRY_MAX: i32;
    #[no_mangle]
    static mut valid_tlb_entries: [i32; 10000];
    #[no_mangle]
    static mut valid_tlb_entries_count: i32;
    #[no_mangle]
    static TLB_VALID: i32;
    #[no_mangle]
    static TLB_READONLY: i32;
    #[no_mangle]
    static TLB_NO_USER: i32;
    #[no_mangle]
    static TLB_IN_MAPPED_RANGE: i32;
    #[no_mangle]
    static TLB_GLOBAL: i32;
    #[no_mangle]
    static TLB_HAS_CODE: i32;
    #[no_mangle]
    static CPU_EXCEPTION_DE: i32;
    #[no_mangle]
    static CPU_EXCEPTION_DB: i32;
    #[no_mangle]
    static CPU_EXCEPTION_NMI: i32;
    #[no_mangle]
    static CPU_EXCEPTION_BP: i32;
    #[no_mangle]
    static CPU_EXCEPTION_OF: i32;
    #[no_mangle]
    static CPU_EXCEPTION_BR: i32;
    #[no_mangle]
    static CPU_EXCEPTION_UD: i32;
    #[no_mangle]
    static CPU_EXCEPTION_NM: i32;
    #[no_mangle]
    static CPU_EXCEPTION_DF: i32;
    #[no_mangle]
    static CPU_EXCEPTION_TS: i32;
    #[no_mangle]
    static CPU_EXCEPTION_NP: i32;
    #[no_mangle]
    static CPU_EXCEPTION_SS: i32;
    #[no_mangle]
    static CPU_EXCEPTION_GP: i32;
    #[no_mangle]
    static CPU_EXCEPTION_PF: i32;
    #[no_mangle]
    static CPU_EXCEPTION_MF: i32;
    #[no_mangle]
    static CPU_EXCEPTION_AC: i32;
    #[no_mangle]
    static CPU_EXCEPTION_MC: i32;
    #[no_mangle]
    static CPU_EXCEPTION_XM: i32;
    #[no_mangle]
    static CPU_EXCEPTION_VE: i32;
    #[no_mangle]
    fn get_seg(segment: i32) -> i32;
    #[no_mangle]
    fn get_seg_prefix(default_segment: i32) -> i32;
    #[no_mangle]
    fn get_reg_asize(reg: i32) -> i32;
    #[no_mangle]
    fn set_ecx_asize(value: i32) -> ();
    #[no_mangle]
    fn add_reg_asize(reg: i32, value: i32) -> ();
    #[no_mangle]
    fn decr_ecx_asize() -> i32;
    #[no_mangle]
    static reg8: *mut u8;
    #[no_mangle]
    static reg16: *mut u16;
    #[no_mangle]
    static reg8s: *mut i8;
    #[no_mangle]
    static reg16s: *mut i16;
    #[no_mangle]
    static reg32s: *mut i32;
    #[no_mangle]
    static last_op1: *mut i32;
    #[no_mangle]
    static last_op2: *mut i32;
    #[no_mangle]
    static last_op_size: *mut i32;
    #[no_mangle]
    static last_add_result: *mut i32;
    #[no_mangle]
    static last_result: *mut i32;
    #[no_mangle]
    static flags_changed: *mut i32;
    #[no_mangle]
    static flags: *mut i32;
    #[no_mangle]
    static page_fault: *mut bool;
    #[no_mangle]
    static a20_enabled: *mut bool;
    #[no_mangle]
    static instruction_pointer: *mut i32;
    #[no_mangle]
    static previous_ip: *mut i32;
    #[no_mangle]
    static idtr_size: *mut i32;
    #[no_mangle]
    static idtr_offset: *mut i32;
    #[no_mangle]
    static gdtr_size: *mut i32;
    #[no_mangle]
    static gdtr_offset: *mut i32;
    #[no_mangle]
    static cr: *mut i32;
    #[no_mangle]
    static cpl: *mut u8;
    #[no_mangle]
    static in_hlt: *mut bool;
    #[no_mangle]
    static last_virt_eip: *mut i32;
    #[no_mangle]
    static eip_phys: *mut i32;
    #[no_mangle]
    static last_virt_esp: *mut i32;
    #[no_mangle]
    static esp_phys: *mut i32;
    #[no_mangle]
    static sysenter_cs: *mut i32;
    #[no_mangle]
    static sysenter_esp: *mut i32;
    #[no_mangle]
    static sysenter_eip: *mut i32;
    #[no_mangle]
    static prefixes: *mut u8;
    #[no_mangle]
    static timestamp_counter: *mut u32;
    #[no_mangle]
    static sreg: *mut u16;
    #[no_mangle]
    static dreg: *mut i32;
    #[no_mangle]
    static fw_value: *mut i32;
    #[no_mangle]
    static segment_is_null: *mut bool;
    #[no_mangle]
    static segment_offsets: *mut i32;
    #[no_mangle]
    static segment_limits: *mut u32;
    #[no_mangle]
    static protected_mode: *mut bool;
    #[no_mangle]
    static is_32: *mut bool;
    #[no_mangle]
    static stack_size_32: *mut bool;
    #[no_mangle]
    static memory_size: *mut u32;
    #[no_mangle]
    static fpu_stack_empty: *mut i32;
    #[no_mangle]
    static mxcsr: *mut i32;
    #[no_mangle]
    static reg_xmm: *mut reg128;
    #[no_mangle]
    static current_tsc: *mut u64;
    #[no_mangle]
    static fpu_st: *mut f64;
    #[no_mangle]
    static fpu_st8: *mut u8;
    #[no_mangle]
    static fpu_st32: *mut i32;
    #[no_mangle]
    static fpu_stack_ptr: *mut u32;
    #[no_mangle]
    static fpu_control_word: *mut i32;
    #[no_mangle]
    static fpu_status_word: *mut i32;
    #[no_mangle]
    static fpu_opcode: *mut i32;
    #[no_mangle]
    static fpu_ip: *mut i32;
    #[no_mangle]
    static fpu_ip_selector: *mut i32;
    #[no_mangle]
    static fpu_dp: *mut i32;
    #[no_mangle]
    static fpu_dp_selector: *mut i32;
    #[no_mangle]
    static reg_mmx: *mut reg64;
    #[no_mangle]
    static opstats_buffer: *mut u32;
    #[no_mangle]
    static opstats_buffer_0f: *mut u32;
    #[no_mangle]
    static tlb_data: *mut i32;
    #[no_mangle]
    fn test_privileges_for_io(_: i32, _: i32) -> bool;
    #[no_mangle]
    fn io_port_read8(_: i32) -> i32;
    #[no_mangle]
    fn io_port_read16(_: i32) -> i32;
    #[no_mangle]
    fn io_port_read32(_: i32) -> i32;
    #[no_mangle]
    fn io_port_write8(_: i32, _: i32) -> ();
    #[no_mangle]
    fn io_port_write16(_: i32, _: i32) -> ();
    #[no_mangle]
    fn io_port_write32(_: i32, _: i32) -> ();
    #[no_mangle]
    fn read8(addr: u32) -> i32;
    #[no_mangle]
    fn read_aligned16(addr: u32) -> i32;
    #[no_mangle]
    fn read_aligned32(addr: u32) -> i32;
    #[no_mangle]
    fn write8(addr: u32, value: i32) -> ();
    #[no_mangle]
    fn write_aligned16(addr: u32, value: u32) -> ();
    #[no_mangle]
    fn write_aligned32(addr: u32, value: i32) -> ();
}

#[derive(Copy, Clone)]
#[repr(C)]
pub union reg128 {
    i8_0: [i8; 16],
    i16_0: [i16; 8],
    i32_0: [i32; 4],
    i64_0: [i64; 2],
    u8_0: [u8; 16],
    u16_0: [u16; 8],
    u32_0: [u32; 4],
    u64_0: [u64; 2],
    f32_0: [f32; 4],
    f64_0: [f64; 2],
}

#[derive(Copy, Clone)]
#[repr(C)]
pub union reg64 {
    i8_0: [i8; 8],
    i16_0: [i16; 4],
    i32_0: [i32; 2],
    i64_0: [i64; 1],
    u8_0: [u8; 8],
    u16_0: [u16; 4],
    u32_0: [u32; 2],
    u64_0: [u64; 1],
    f32_0: [f32; 2],
    f64_0: [f64; 1],
}
#[derive(Copy, Clone)]
#[repr(C)]
pub union unnamed {
    __f: f32,
    __i: u32,
}
#[derive(Copy, Clone)]
#[repr(C)]
pub union unnamed_0 {
    __f: f64,
    __i: u64,
}

unsafe extern "C" fn __FLOAT_BITS(mut __f: f32) -> u32 {
    let mut __u: unnamed = unnamed { __f: 0. };
    __u.__f = __f;
    return __u.__i;
}
unsafe extern "C" fn __DOUBLE_BITS(mut __f: f64) -> u64 {
    let mut __u: unnamed_0 = unnamed_0 { __f: 0. };
    __u.__f = __f;
    return __u.__i;
}
unsafe extern "C" fn __islessf(mut __x: f32, mut __y: f32) -> i32 {
    return (0 == if 0 != if ::std::mem::size_of::<f32>() as u64
        == ::std::mem::size_of::<f32>() as u64
    {
        (__FLOAT_BITS(__x) & 2147483647i32 as u32 > 2139095040i32 as u32) as i32
    }
    else if ::std::mem::size_of::<f32>() as u64 == ::std::mem::size_of::<f64>() as u64 {
        (__DOUBLE_BITS(__x as f64) & 1u64.wrapping_neg() >> 1i32 > 2047u64 << 52i32) as i32
    }
    else {
        (__fpclassifyl(__x as f64) == 0i32) as i32
    } {
        1i32
    }
    else if ::std::mem::size_of::<f32>() as u64 == ::std::mem::size_of::<f32>() as u64 {
        (__FLOAT_BITS(__y) & 2147483647i32 as u32 > 2139095040i32 as u32) as i32
    }
    else if ::std::mem::size_of::<f32>() as u64 == ::std::mem::size_of::<f64>() as u64 {
        (__DOUBLE_BITS(__y as f64) & 1u64.wrapping_neg() >> 1i32 > 2047u64 << 52i32) as i32
    }
    else {
        (__fpclassifyl(__y as f64) == 0i32) as i32
    } && __x < __y) as i32;
}
unsafe extern "C" fn __isless(mut __x: f64, mut __y: f64) -> i32 {
    return (0 == if 0 != if ::std::mem::size_of::<f64>() as u64
        == ::std::mem::size_of::<f32>() as u64
    {
        (__FLOAT_BITS(__x as f32) & 2147483647i32 as u32 > 2139095040i32 as u32) as i32
    }
    else if ::std::mem::size_of::<f64>() as u64 == ::std::mem::size_of::<f64>() as u64 {
        (__DOUBLE_BITS(__x) & 1u64.wrapping_neg() >> 1i32 > 2047u64 << 52i32) as i32
    }
    else {
        (__fpclassifyl(__x as f64) == 0i32) as i32
    } {
        1i32
    }
    else if ::std::mem::size_of::<f64>() as u64 == ::std::mem::size_of::<f32>() as u64 {
        (__FLOAT_BITS(__y as f32) & 2147483647i32 as u32 > 2139095040i32 as u32) as i32
    }
    else if ::std::mem::size_of::<f64>() as u64 == ::std::mem::size_of::<f64>() as u64 {
        (__DOUBLE_BITS(__y) & 1u64.wrapping_neg() >> 1i32 > 2047u64 << 52i32) as i32
    }
    else {
        (__fpclassifyl(__y as f64) == 0i32) as i32
    } && __x < __y) as i32;
}
unsafe extern "C" fn __islessl(mut __x: f64, mut __y: f64) -> i32 {
    return (0 == if 0 != if ::std::mem::size_of::<f64>() as u64
        == ::std::mem::size_of::<f32>() as u64
    {
        (__FLOAT_BITS(__x as f32) & 2147483647i32 as u32 > 2139095040i32 as u32) as i32
    }
    else if ::std::mem::size_of::<f64>() as u64 == ::std::mem::size_of::<f64>() as u64 {
        (__DOUBLE_BITS(__x as f64) & 1u64.wrapping_neg() >> 1i32 > 2047u64 << 52i32) as i32
    }
    else {
        (__fpclassifyl(__x) == 0i32) as i32
    } {
        1i32
    }
    else if ::std::mem::size_of::<f64>() as u64 == ::std::mem::size_of::<f32>() as u64 {
        (__FLOAT_BITS(__y as f32) & 2147483647i32 as u32 > 2139095040i32 as u32) as i32
    }
    else if ::std::mem::size_of::<f64>() as u64 == ::std::mem::size_of::<f64>() as u64 {
        (__DOUBLE_BITS(__y as f64) & 1u64.wrapping_neg() >> 1i32 > 2047u64 << 52i32) as i32
    }
    else {
        (__fpclassifyl(__y) == 0i32) as i32
    } && __x < __y) as i32;
}
unsafe extern "C" fn __islessequalf(mut __x: f32, mut __y: f32) -> i32 {
    return (0 == if 0 != if ::std::mem::size_of::<f32>() as u64
        == ::std::mem::size_of::<f32>() as u64
    {
        (__FLOAT_BITS(__x) & 2147483647i32 as u32 > 2139095040i32 as u32) as i32
    }
    else if ::std::mem::size_of::<f32>() as u64 == ::std::mem::size_of::<f64>() as u64 {
        (__DOUBLE_BITS(__x as f64) & 1u64.wrapping_neg() >> 1i32 > 2047u64 << 52i32) as i32
    }
    else {
        (__fpclassifyl(__x as f64) == 0i32) as i32
    } {
        1i32
    }
    else if ::std::mem::size_of::<f32>() as u64 == ::std::mem::size_of::<f32>() as u64 {
        (__FLOAT_BITS(__y) & 2147483647i32 as u32 > 2139095040i32 as u32) as i32
    }
    else if ::std::mem::size_of::<f32>() as u64 == ::std::mem::size_of::<f64>() as u64 {
        (__DOUBLE_BITS(__y as f64) & 1u64.wrapping_neg() >> 1i32 > 2047u64 << 52i32) as i32
    }
    else {
        (__fpclassifyl(__y as f64) == 0i32) as i32
    } && __x <= __y) as i32;
}
unsafe extern "C" fn __islessequal(mut __x: f64, mut __y: f64) -> i32 {
    return (0 == if 0 != if ::std::mem::size_of::<f64>() as u64
        == ::std::mem::size_of::<f32>() as u64
    {
        (__FLOAT_BITS(__x as f32) & 2147483647i32 as u32 > 2139095040i32 as u32) as i32
    }
    else if ::std::mem::size_of::<f64>() as u64 == ::std::mem::size_of::<f64>() as u64 {
        (__DOUBLE_BITS(__x) & 1u64.wrapping_neg() >> 1i32 > 2047u64 << 52i32) as i32
    }
    else {
        (__fpclassifyl(__x as f64) == 0i32) as i32
    } {
        1i32
    }
    else if ::std::mem::size_of::<f64>() as u64 == ::std::mem::size_of::<f32>() as u64 {
        (__FLOAT_BITS(__y as f32) & 2147483647i32 as u32 > 2139095040i32 as u32) as i32
    }
    else if ::std::mem::size_of::<f64>() as u64 == ::std::mem::size_of::<f64>() as u64 {
        (__DOUBLE_BITS(__y) & 1u64.wrapping_neg() >> 1i32 > 2047u64 << 52i32) as i32
    }
    else {
        (__fpclassifyl(__y as f64) == 0i32) as i32
    } && __x <= __y) as i32;
}
unsafe extern "C" fn __islessequall(mut __x: f64, mut __y: f64) -> i32 {
    return (0 == if 0 != if ::std::mem::size_of::<f64>() as u64
        == ::std::mem::size_of::<f32>() as u64
    {
        (__FLOAT_BITS(__x as f32) & 2147483647i32 as u32 > 2139095040i32 as u32) as i32
    }
    else if ::std::mem::size_of::<f64>() as u64 == ::std::mem::size_of::<f64>() as u64 {
        (__DOUBLE_BITS(__x as f64) & 1u64.wrapping_neg() >> 1i32 > 2047u64 << 52i32) as i32
    }
    else {
        (__fpclassifyl(__x) == 0i32) as i32
    } {
        1i32
    }
    else if ::std::mem::size_of::<f64>() as u64 == ::std::mem::size_of::<f32>() as u64 {
        (__FLOAT_BITS(__y as f32) & 2147483647i32 as u32 > 2139095040i32 as u32) as i32
    }
    else if ::std::mem::size_of::<f64>() as u64 == ::std::mem::size_of::<f64>() as u64 {
        (__DOUBLE_BITS(__y as f64) & 1u64.wrapping_neg() >> 1i32 > 2047u64 << 52i32) as i32
    }
    else {
        (__fpclassifyl(__y) == 0i32) as i32
    } && __x <= __y) as i32;
}
unsafe extern "C" fn __islessgreaterf(mut __x: f32, mut __y: f32) -> i32 {
    return (0 == if 0 != if ::std::mem::size_of::<f32>() as u64
        == ::std::mem::size_of::<f32>() as u64
    {
        (__FLOAT_BITS(__x) & 2147483647i32 as u32 > 2139095040i32 as u32) as i32
    }
    else if ::std::mem::size_of::<f32>() as u64 == ::std::mem::size_of::<f64>() as u64 {
        (__DOUBLE_BITS(__x as f64) & 1u64.wrapping_neg() >> 1i32 > 2047u64 << 52i32) as i32
    }
    else {
        (__fpclassifyl(__x as f64) == 0i32) as i32
    } {
        1i32
    }
    else if ::std::mem::size_of::<f32>() as u64 == ::std::mem::size_of::<f32>() as u64 {
        (__FLOAT_BITS(__y) & 2147483647i32 as u32 > 2139095040i32 as u32) as i32
    }
    else if ::std::mem::size_of::<f32>() as u64 == ::std::mem::size_of::<f64>() as u64 {
        (__DOUBLE_BITS(__y as f64) & 1u64.wrapping_neg() >> 1i32 > 2047u64 << 52i32) as i32
    }
    else {
        (__fpclassifyl(__y as f64) == 0i32) as i32
    } && __x != __y) as i32;
}
unsafe extern "C" fn __islessgreater(mut __x: f64, mut __y: f64) -> i32 {
    return (0 == if 0 != if ::std::mem::size_of::<f64>() as u64
        == ::std::mem::size_of::<f32>() as u64
    {
        (__FLOAT_BITS(__x as f32) & 2147483647i32 as u32 > 2139095040i32 as u32) as i32
    }
    else if ::std::mem::size_of::<f64>() as u64 == ::std::mem::size_of::<f64>() as u64 {
        (__DOUBLE_BITS(__x) & 1u64.wrapping_neg() >> 1i32 > 2047u64 << 52i32) as i32
    }
    else {
        (__fpclassifyl(__x as f64) == 0i32) as i32
    } {
        1i32
    }
    else if ::std::mem::size_of::<f64>() as u64 == ::std::mem::size_of::<f32>() as u64 {
        (__FLOAT_BITS(__y as f32) & 2147483647i32 as u32 > 2139095040i32 as u32) as i32
    }
    else if ::std::mem::size_of::<f64>() as u64 == ::std::mem::size_of::<f64>() as u64 {
        (__DOUBLE_BITS(__y) & 1u64.wrapping_neg() >> 1i32 > 2047u64 << 52i32) as i32
    }
    else {
        (__fpclassifyl(__y as f64) == 0i32) as i32
    } && __x != __y) as i32;
}
unsafe extern "C" fn __islessgreaterl(mut __x: f64, mut __y: f64) -> i32 {
    return (0 == if 0 != if ::std::mem::size_of::<f64>() as u64
        == ::std::mem::size_of::<f32>() as u64
    {
        (__FLOAT_BITS(__x as f32) & 2147483647i32 as u32 > 2139095040i32 as u32) as i32
    }
    else if ::std::mem::size_of::<f64>() as u64 == ::std::mem::size_of::<f64>() as u64 {
        (__DOUBLE_BITS(__x as f64) & 1u64.wrapping_neg() >> 1i32 > 2047u64 << 52i32) as i32
    }
    else {
        (__fpclassifyl(__x) == 0i32) as i32
    } {
        1i32
    }
    else if ::std::mem::size_of::<f64>() as u64 == ::std::mem::size_of::<f32>() as u64 {
        (__FLOAT_BITS(__y as f32) & 2147483647i32 as u32 > 2139095040i32 as u32) as i32
    }
    else if ::std::mem::size_of::<f64>() as u64 == ::std::mem::size_of::<f64>() as u64 {
        (__DOUBLE_BITS(__y as f64) & 1u64.wrapping_neg() >> 1i32 > 2047u64 << 52i32) as i32
    }
    else {
        (__fpclassifyl(__y) == 0i32) as i32
    } && __x != __y) as i32;
}
unsafe extern "C" fn __isgreaterf(mut __x: f32, mut __y: f32) -> i32 {
    return (0 == if 0 != if ::std::mem::size_of::<f32>() as u64
        == ::std::mem::size_of::<f32>() as u64
    {
        (__FLOAT_BITS(__x) & 2147483647i32 as u32 > 2139095040i32 as u32) as i32
    }
    else if ::std::mem::size_of::<f32>() as u64 == ::std::mem::size_of::<f64>() as u64 {
        (__DOUBLE_BITS(__x as f64) & 1u64.wrapping_neg() >> 1i32 > 2047u64 << 52i32) as i32
    }
    else {
        (__fpclassifyl(__x as f64) == 0i32) as i32
    } {
        1i32
    }
    else if ::std::mem::size_of::<f32>() as u64 == ::std::mem::size_of::<f32>() as u64 {
        (__FLOAT_BITS(__y) & 2147483647i32 as u32 > 2139095040i32 as u32) as i32
    }
    else if ::std::mem::size_of::<f32>() as u64 == ::std::mem::size_of::<f64>() as u64 {
        (__DOUBLE_BITS(__y as f64) & 1u64.wrapping_neg() >> 1i32 > 2047u64 << 52i32) as i32
    }
    else {
        (__fpclassifyl(__y as f64) == 0i32) as i32
    } && __x > __y) as i32;
}
unsafe extern "C" fn __isgreater(mut __x: f64, mut __y: f64) -> i32 {
    return (0 == if 0 != if ::std::mem::size_of::<f64>() as u64
        == ::std::mem::size_of::<f32>() as u64
    {
        (__FLOAT_BITS(__x as f32) & 2147483647i32 as u32 > 2139095040i32 as u32) as i32
    }
    else if ::std::mem::size_of::<f64>() as u64 == ::std::mem::size_of::<f64>() as u64 {
        (__DOUBLE_BITS(__x) & 1u64.wrapping_neg() >> 1i32 > 2047u64 << 52i32) as i32
    }
    else {
        (__fpclassifyl(__x as f64) == 0i32) as i32
    } {
        1i32
    }
    else if ::std::mem::size_of::<f64>() as u64 == ::std::mem::size_of::<f32>() as u64 {
        (__FLOAT_BITS(__y as f32) & 2147483647i32 as u32 > 2139095040i32 as u32) as i32
    }
    else if ::std::mem::size_of::<f64>() as u64 == ::std::mem::size_of::<f64>() as u64 {
        (__DOUBLE_BITS(__y) & 1u64.wrapping_neg() >> 1i32 > 2047u64 << 52i32) as i32
    }
    else {
        (__fpclassifyl(__y as f64) == 0i32) as i32
    } && __x > __y) as i32;
}
unsafe extern "C" fn __isgreaterl(mut __x: f64, mut __y: f64) -> i32 {
    return (0 == if 0 != if ::std::mem::size_of::<f64>() as u64
        == ::std::mem::size_of::<f32>() as u64
    {
        (__FLOAT_BITS(__x as f32) & 2147483647i32 as u32 > 2139095040i32 as u32) as i32
    }
    else if ::std::mem::size_of::<f64>() as u64 == ::std::mem::size_of::<f64>() as u64 {
        (__DOUBLE_BITS(__x as f64) & 1u64.wrapping_neg() >> 1i32 > 2047u64 << 52i32) as i32
    }
    else {
        (__fpclassifyl(__x) == 0i32) as i32
    } {
        1i32
    }
    else if ::std::mem::size_of::<f64>() as u64 == ::std::mem::size_of::<f32>() as u64 {
        (__FLOAT_BITS(__y as f32) & 2147483647i32 as u32 > 2139095040i32 as u32) as i32
    }
    else if ::std::mem::size_of::<f64>() as u64 == ::std::mem::size_of::<f64>() as u64 {
        (__DOUBLE_BITS(__y as f64) & 1u64.wrapping_neg() >> 1i32 > 2047u64 << 52i32) as i32
    }
    else {
        (__fpclassifyl(__y) == 0i32) as i32
    } && __x > __y) as i32;
}
unsafe extern "C" fn __isgreaterequalf(mut __x: f32, mut __y: f32) -> i32 {
    return (0 == if 0 != if ::std::mem::size_of::<f32>() as u64
        == ::std::mem::size_of::<f32>() as u64
    {
        (__FLOAT_BITS(__x) & 2147483647i32 as u32 > 2139095040i32 as u32) as i32
    }
    else if ::std::mem::size_of::<f32>() as u64 == ::std::mem::size_of::<f64>() as u64 {
        (__DOUBLE_BITS(__x as f64) & 1u64.wrapping_neg() >> 1i32 > 2047u64 << 52i32) as i32
    }
    else {
        (__fpclassifyl(__x as f64) == 0i32) as i32
    } {
        1i32
    }
    else if ::std::mem::size_of::<f32>() as u64 == ::std::mem::size_of::<f32>() as u64 {
        (__FLOAT_BITS(__y) & 2147483647i32 as u32 > 2139095040i32 as u32) as i32
    }
    else if ::std::mem::size_of::<f32>() as u64 == ::std::mem::size_of::<f64>() as u64 {
        (__DOUBLE_BITS(__y as f64) & 1u64.wrapping_neg() >> 1i32 > 2047u64 << 52i32) as i32
    }
    else {
        (__fpclassifyl(__y as f64) == 0i32) as i32
    } && __x >= __y) as i32;
}
unsafe extern "C" fn __isgreaterequal(mut __x: f64, mut __y: f64) -> i32 {
    return (0 == if 0 != if ::std::mem::size_of::<f64>() as u64
        == ::std::mem::size_of::<f32>() as u64
    {
        (__FLOAT_BITS(__x as f32) & 2147483647i32 as u32 > 2139095040i32 as u32) as i32
    }
    else if ::std::mem::size_of::<f64>() as u64 == ::std::mem::size_of::<f64>() as u64 {
        (__DOUBLE_BITS(__x) & 1u64.wrapping_neg() >> 1i32 > 2047u64 << 52i32) as i32
    }
    else {
        (__fpclassifyl(__x as f64) == 0i32) as i32
    } {
        1i32
    }
    else if ::std::mem::size_of::<f64>() as u64 == ::std::mem::size_of::<f32>() as u64 {
        (__FLOAT_BITS(__y as f32) & 2147483647i32 as u32 > 2139095040i32 as u32) as i32
    }
    else if ::std::mem::size_of::<f64>() as u64 == ::std::mem::size_of::<f64>() as u64 {
        (__DOUBLE_BITS(__y) & 1u64.wrapping_neg() >> 1i32 > 2047u64 << 52i32) as i32
    }
    else {
        (__fpclassifyl(__y as f64) == 0i32) as i32
    } && __x >= __y) as i32;
}
unsafe extern "C" fn __isgreaterequall(mut __x: f64, mut __y: f64) -> i32 {
    return (0 == if 0 != if ::std::mem::size_of::<f64>() as u64
        == ::std::mem::size_of::<f32>() as u64
    {
        (__FLOAT_BITS(__x as f32) & 2147483647i32 as u32 > 2139095040i32 as u32) as i32
    }
    else if ::std::mem::size_of::<f64>() as u64 == ::std::mem::size_of::<f64>() as u64 {
        (__DOUBLE_BITS(__x as f64) & 1u64.wrapping_neg() >> 1i32 > 2047u64 << 52i32) as i32
    }
    else {
        (__fpclassifyl(__x) == 0i32) as i32
    } {
        1i32
    }
    else if ::std::mem::size_of::<f64>() as u64 == ::std::mem::size_of::<f32>() as u64 {
        (__FLOAT_BITS(__y as f32) & 2147483647i32 as u32 > 2139095040i32 as u32) as i32
    }
    else if ::std::mem::size_of::<f64>() as u64 == ::std::mem::size_of::<f64>() as u64 {
        (__DOUBLE_BITS(__y as f64) & 1u64.wrapping_neg() >> 1i32 > 2047u64 << 52i32) as i32
    }
    else {
        (__fpclassifyl(__y) == 0i32) as i32
    } && __x >= __y) as i32;
}
#[no_mangle]
pub unsafe extern "C" fn string_get_cycle_count(mut size: i32, mut address: i32) -> i32 {
    dbg_assert!(0 != size && size <= 4i32 && size >= -4i32);
    if size < 0i32 {
        size = -size;
        address = 4096i32 - address - size
    }
    dbg_assert!(address & size - 1i32 == 0i32);
    c_comment!(("1 -> 0; 2 -> 1; 4 -> 2"));
    let mut shift: i32 = size >> 1i32;
    return 4096i32 - (address & 4095i32) >> shift;
}
#[no_mangle]
pub unsafe extern "C" fn string_get_cycle_count2(
    mut size: i32,
    mut addr1: i32,
    mut addr2: i32,
) -> i32 {
    let mut c1: i32 = string_get_cycle_count(size, addr1);
    let mut c2: i32 = string_get_cycle_count(size, addr2);
    return if c1 < c2 { c1 } else { c2 };
}
#[no_mangle]
pub unsafe extern "C" fn movsb_rep() -> () {
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
pub unsafe extern "C" fn movsb_no_rep() -> () {
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
pub unsafe extern "C" fn movsw_rep() -> () {
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
pub static mut MAX_COUNT_PER_CYCLE: i32 = unsafe { 4096i32 };
#[no_mangle]
pub unsafe extern "C" fn movsw_no_rep() -> () {
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
pub unsafe extern "C" fn movsd_rep() -> () {
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
pub unsafe extern "C" fn movsd_no_rep() -> () {
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
pub unsafe extern "C" fn cmpsb_rep(mut prefix_flag: i32) -> () {
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
pub unsafe extern "C" fn cmpsb_no_rep() -> () {
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
pub unsafe extern "C" fn cmpsw_rep(mut prefix_flag: i32) -> () {
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
pub unsafe extern "C" fn cmpsw_no_rep() -> () {
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
pub unsafe extern "C" fn cmpsd_rep(mut prefix_flag: i32) -> () {
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
pub unsafe extern "C" fn cmpsd_no_rep() -> () {
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
pub unsafe extern "C" fn stosb_rep() -> () {
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
pub unsafe extern "C" fn stosb_no_rep() -> () {
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
pub unsafe extern "C" fn stosw_rep() -> () {
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
pub unsafe extern "C" fn stosw_no_rep() -> () {
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
pub unsafe extern "C" fn stosd_rep() -> () {
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
pub unsafe extern "C" fn stosd_no_rep() -> () {
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
pub unsafe extern "C" fn lodsb_rep() -> () {
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
pub unsafe extern "C" fn lodsb_no_rep() -> () {
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
pub unsafe extern "C" fn lodsw_rep() -> () {
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
pub unsafe extern "C" fn lodsw_no_rep() -> () {
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
pub unsafe extern "C" fn lodsd_rep() -> () {
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
pub unsafe extern "C" fn lodsd_no_rep() -> () {
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
pub unsafe extern "C" fn scasb_rep(mut prefix_flag: i32) -> () {
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
pub unsafe extern "C" fn scasb_no_rep() -> () {
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
pub unsafe extern "C" fn scasw_rep(mut prefix_flag: i32) -> () {
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
pub unsafe extern "C" fn scasw_no_rep() -> () {
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
pub unsafe extern "C" fn scasd_rep(mut prefix_flag: i32) -> () {
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
pub unsafe extern "C" fn scasd_no_rep() -> () {
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
pub unsafe extern "C" fn insb_rep() -> () {
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
pub unsafe extern "C" fn insb_no_rep() -> () {
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
pub unsafe extern "C" fn insw_rep() -> () {
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
pub unsafe extern "C" fn insw_no_rep() -> () {
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
pub unsafe extern "C" fn insd_rep() -> () {
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
pub unsafe extern "C" fn insd_no_rep() -> () {
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
pub unsafe extern "C" fn outsb_rep() -> () {
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
pub unsafe extern "C" fn outsb_no_rep() -> () {
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
pub unsafe extern "C" fn outsw_rep() -> () {
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
pub unsafe extern "C" fn outsw_no_rep() -> () {
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
pub unsafe extern "C" fn outsd_rep() -> () {
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
pub unsafe extern "C" fn outsd_no_rep() -> () {
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
