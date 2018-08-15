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
    fn __fpclassifyl(_: f64) -> i32;
    #[no_mangle]
    fn ceil(_: f64) -> f64;
    #[no_mangle]
    fn floor(_: f64) -> f64;
    #[no_mangle]
    fn fmod(_: f64, _: f64) -> f64;
    #[no_mangle]
    fn pow(_: f64, _: f64) -> f64;
    #[no_mangle]
    fn round(_: f64) -> f64;
    #[no_mangle]
    fn trunc(_: f64) -> f64;
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
    fn dbg_log(m: *const i8) -> ();
    #[no_mangle]
    fn c_comment(m: *const i8) -> ();
    #[no_mangle]
    fn isnan_XXX(f: f64) -> bool;
    #[no_mangle]
    fn isfinite_XXX(f: f64) -> bool;
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
    fn is_osize_32() -> bool;
    #[no_mangle]
    fn trigger_ud() -> ();
    #[no_mangle]
    static fpu_stack_ptr: *mut u32;
    #[no_mangle]
    static fpu_st: *mut f64;
    #[no_mangle]
    static fpu_status_word: *mut i32;
    #[no_mangle]
    static fpu_stack_empty: *mut i32;
    #[no_mangle]
    static fpu_control_word: *mut i32;
    #[no_mangle]
    static flags: *mut i32;
    #[no_mangle]
    static flags_changed: *mut i32;
    #[no_mangle]
    static fpu_opcode: *mut i32;
    #[no_mangle]
    static fpu_dp: *mut i32;
    #[no_mangle]
    static fpu_ip: *mut i32;
    #[no_mangle]
    fn convert_f64_to_i32(_: f64) -> i32;
    #[no_mangle]
    static DEBUG: bool;
    #[no_mangle]
    static fpu_dp_selector: *mut i32;
    #[no_mangle]
    static fpu_ip_selector: *mut i32;
    #[no_mangle]
    static reg16: *mut u16;
    #[no_mangle]
    static fpu_st8: *mut u8;
    #[no_mangle]
    static reg8: *mut u8;
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
    static mxcsr: *mut i32;
    #[no_mangle]
    static reg_xmm: *mut reg128;
    #[no_mangle]
    static current_tsc: *mut u64;
    #[no_mangle]
    static fpu_st32: *mut i32;
    #[no_mangle]
    static reg_mmx: *mut reg64;
    #[no_mangle]
    static opstats_buffer: *mut u32;
    #[no_mangle]
    static opstats_buffer_0f: *mut u32;
    #[no_mangle]
    static tlb_data: *mut i32;
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
pub union f64_int {
    u8_0: [u8; 8],
    i32_0: [i32; 2],
    u64_0: [u64; 1],
    f64_0: f64,
}

#[derive(Copy, Clone)]
#[repr(C)]
pub union f32_int {
    u8_0: [u8; 4],
    i32_0: i32,
    f32_0: f32,
}
#[derive(Copy, Clone)]
#[repr(C)]
pub union unnamed {
    __f: f32,
    __i: u32,
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
pub static mut M_LOG2E: f64 = unsafe { 1.4426950408889634f64 };
#[no_mangle]
pub static mut M_LN2: f64 = unsafe { 0.6931471805599453f64 };
#[no_mangle]
pub static mut M_LN10: f64 = unsafe { 2.302585092994046f64 };
#[no_mangle]
pub static mut M_PI: f64 = unsafe { 3.141592653589793f64 };
#[no_mangle]
pub static mut FPU_C0: i32 = unsafe { 256i32 };
#[no_mangle]
pub static mut FPU_C1: i32 = unsafe { 512i32 };
#[no_mangle]
pub static mut FPU_C2: i32 = unsafe { 1024i32 };
#[no_mangle]
pub static mut FPU_C3: i32 = unsafe { 16384i32 };
#[no_mangle]
pub static mut FPU_RESULT_FLAGS: i32 = unsafe { FPU_C0 | FPU_C1 | FPU_C2 | FPU_C3 };
#[no_mangle]
pub static mut FPU_STACK_TOP: i32 = unsafe { 14336i32 };
#[no_mangle]
pub unsafe extern "C" fn fpu_get_st0() -> f64 {
    if 0 != *fpu_stack_empty >> *fpu_stack_ptr & 1i32 {
        *fpu_status_word &= !FPU_C1;
        fpu_stack_fault();
        return INDEFINITE_NAN;
    }
    else {
        return *fpu_st.offset(*fpu_stack_ptr as isize);
    };
}
#[no_mangle]
pub static mut INDEFINITE_NAN: f64 = unsafe { ::std::f32::NAN as f64 };
#[no_mangle]
pub unsafe extern "C" fn fpu_stack_fault() -> () {
    c_comment!(("TODO: Interrupt"));
    *fpu_status_word |= FPU_EX_SF | FPU_EX_I;
}
#[no_mangle]
pub static mut FPU_EX_I: i32 = unsafe { 1i32 << 0i32 };
#[no_mangle]
pub static mut FPU_EX_SF: i32 = unsafe { 1i32 << 6i32 };
#[no_mangle]
pub unsafe extern "C" fn fpu_get_sti(mut i: i32) -> f64 {
    dbg_assert!(i >= 0i32 && i < 8i32);
    i = ((i as u32).wrapping_add(*fpu_stack_ptr) & 7i32 as u32) as i32;
    if 0 != *fpu_stack_empty >> i & 1i32 {
        *fpu_status_word &= !FPU_C1;
        fpu_stack_fault();
        return INDEFINITE_NAN;
    }
    else {
        return *fpu_st.offset(i as isize);
    };
}
#[no_mangle]
pub unsafe extern "C" fn fpu_integer_round(mut f: f64) -> f64 {
    let mut rc: i32 = *fpu_control_word >> 10i32 & 3i32;
    c_comment!(("XXX: See https://en.wikipedia.org/wiki/C_mathematical_functions"));
    if rc == 0i32 {
        c_comment!(("Round to nearest, or even if equidistant"));
        let mut rounded: f64 = round(f);
        let mut diff: f64 = rounded - f;
        if diff == 0.5f64 || diff == -0.5f64 {
            rounded = 2.0f64 * round(f * 0.5f64)
        }
        return rounded;
    }
    else if rc == 1i32 || rc == 3i32 && f > 0i32 as f64 {
        c_comment!(("rc=3 is truncate -> floor for positive numbers"));
        return floor(f);
    }
    else {
        return ceil(f);
    };
}
#[no_mangle]
pub unsafe extern "C" fn fpu_load_m32(mut addr: i32) -> Result<f64, ()> {
    let mut v: f32_int = f32_int {
        i32_0: safe_read32s(addr)?,
    };
    Ok(v.f32_0 as f64)
}
#[no_mangle]
pub unsafe extern "C" fn fpu_load_m64(mut addr: i32) -> Result<f64, ()> {
    let mut value: u64 = safe_read64s(addr)?.u64_0[0usize];
    let mut v: f64_int = f64_int { u64_0: [value] };
    Ok(v.f64_0)
}
#[no_mangle]
pub unsafe extern "C" fn fpu_load_m80(mut addr: u32) -> Result<f64, ()> {
    let mut value: u64 = safe_read64s(addr as i32)?.u64_0[0usize];
    let mut low: u32 = value as u32;
    let mut high: u32 = (value >> 32i32) as u32;
    let mut exponent: i32 = safe_read16(addr.wrapping_add(8i32 as u32) as i32)?;
    let mut sign: i32 = exponent >> 15i32;
    exponent &= !32768i32;
    if exponent == 0i32 {
        c_comment!(("TODO: denormal numbers"));
        Ok(0i32 as f64)
    }
    else if exponent < 32767i32 {
        exponent -= 16383i32;
        c_comment!(("Note: some bits might be lost at this point"));
        let mut mantissa: f64 = low as f64 + 4294967296i64 as f64 * high as f64;
        if 0 != sign {
            mantissa = -mantissa
        }
        c_comment!(("Simply compute the 64 bit floating point number."));
        c_comment!(("An alternative write the mantissa, sign and exponent in the"));
        c_comment!(("float64_byte and return float64[0]"));
        Ok(mantissa * pow(2i32 as f64, (exponent - 63i32) as f64))
    }
    else {
        c_comment!(("TODO: NaN, Infinity"));
        if 0 != 0i32 * 0i32 {
            dbg_log_c!("Load m80 TODO");
        }
        let mut double_int_view: f64_int = f64_int { u8_0: [0; 8] };
        double_int_view.u8_0[7usize] = (127i32 | sign << 7i32) as u8;
        double_int_view.u8_0[6usize] = (240i32 as u32 | high >> 30i32 << 3i32 & 8i32 as u32) as u8;
        double_int_view.u8_0[5usize] = 0i32 as u8;
        double_int_view.u8_0[4usize] = 0i32 as u8;
        double_int_view.i32_0[0usize] = 0i32;
        Ok(double_int_view.f64_0)
    }
}
#[no_mangle]
pub unsafe extern "C" fn fpu_load_status_word() -> i32 {
    return ((*fpu_status_word & !(7i32 << 11i32)) as u32 | *fpu_stack_ptr << 11i32) as i32;
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fadd(mut target_index: i32, mut val: f64) -> () {
    let mut st0: f64 = fpu_get_st0();
    *fpu_st.offset(((*fpu_stack_ptr).wrapping_add(target_index as u32) & 7i32 as u32) as isize) =
        st0 + val;
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fclex() -> () { *fpu_status_word = 0i32; }
#[no_mangle]
pub unsafe extern "C" fn fpu_fcmovcc(mut condition: bool, mut r: i32) -> () {
    if condition {
        *fpu_st.offset(*fpu_stack_ptr as isize) = fpu_get_sti(r);
        *fpu_stack_empty &= !(1i32 << *fpu_stack_ptr)
    };
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fcom(mut y: f64) -> () {
    let mut x: f64 = fpu_get_st0();
    *fpu_status_word &= !FPU_RESULT_FLAGS;
    if !(x > y) {
        if y > x {
            *fpu_status_word |= FPU_C0
        }
        else if x == y {
            *fpu_status_word |= FPU_C3
        }
        else {
            *fpu_status_word |= FPU_C0 | FPU_C2 | FPU_C3
        }
    };
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fcomi(mut r: i32) -> () {
    let mut y: f64 = fpu_get_sti(r);
    let mut x: f64 = *fpu_st.offset(*fpu_stack_ptr as isize);
    *flags_changed &= !(1i32 | FLAG_PARITY | FLAG_ZERO);
    *flags &= !(1i32 | FLAG_PARITY | FLAG_ZERO);
    if !(x > y) {
        if y > x {
            *flags |= 1i32
        }
        else if x == y {
            *flags |= FLAG_ZERO
        }
        else {
            *flags |= 1i32 | FLAG_PARITY | FLAG_ZERO
        }
    };
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fcomip(mut r: i32) -> () {
    fpu_fcomi(r);
    fpu_pop();
}
#[no_mangle]
pub unsafe extern "C" fn fpu_pop() -> () {
    *fpu_stack_empty |= 1i32 << *fpu_stack_ptr;
    *fpu_stack_ptr = (*fpu_stack_ptr).wrapping_add(1i32 as u32) & 7i32 as u32;
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fcomp(mut val: f64) -> () {
    fpu_fcom(val);
    fpu_pop();
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fdiv(mut target_index: i32, mut val: f64) -> () {
    let mut st0: f64 = fpu_get_st0();
    *fpu_st.offset(((*fpu_stack_ptr).wrapping_add(target_index as u32) & 7i32 as u32) as isize) =
        st0 / val;
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fdivr(mut target_index: i32, mut val: f64) -> () {
    let mut st0: f64 = fpu_get_st0();
    *fpu_st.offset(((*fpu_stack_ptr).wrapping_add(target_index as u32) & 7i32 as u32) as isize) =
        val / st0;
}
#[no_mangle]
pub unsafe extern "C" fn fpu_ffree(mut r: i32) -> () {
    *fpu_stack_empty |= 1i32 << (*fpu_stack_ptr).wrapping_add(r as u32);
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fildm64(mut addr: i32) -> () {
    let mut value: i64 = return_on_pagefault!(safe_read64s(addr)).i64_0[0usize];
    let mut m64: f64 = value as f64;
    fpu_push(m64);
}
#[no_mangle]
pub unsafe extern "C" fn fpu_push(mut x: f64) -> () {
    *fpu_stack_ptr = (*fpu_stack_ptr).wrapping_sub(1i32 as u32) & 7i32 as u32;
    if 0 != *fpu_stack_empty >> *fpu_stack_ptr & 1i32 {
        *fpu_status_word &= !FPU_C1;
        *fpu_stack_empty &= !(1i32 << *fpu_stack_ptr);
        *fpu_st.offset(*fpu_stack_ptr as isize) = x
    }
    else {
        *fpu_status_word |= FPU_C1;
        fpu_stack_fault();
        *fpu_st.offset(*fpu_stack_ptr as isize) = INDEFINITE_NAN
    };
}
#[no_mangle]
pub unsafe extern "C" fn fpu_finit() -> () {
    *fpu_control_word = 895i32;
    *fpu_status_word = 0i32;
    *fpu_ip.offset(0isize) = 0i32;
    *fpu_dp.offset(0isize) = 0i32;
    *fpu_opcode.offset(0isize) = 0i32;
    *fpu_stack_empty = 255i32;
    *fpu_stack_ptr = 0i32 as u32;
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fistm16(mut addr: i32) -> () {
    let mut st0: f64 = fpu_integer_round(fpu_get_st0());
    if st0 <= 32767i32 as f64 && st0 >= -32768i32 as f64 {
        return_on_pagefault!(safe_write16(addr, st0 as i32));
    }
    else {
        fpu_invalid_arithmetic();
        return_on_pagefault!(safe_write16(addr, 32768i32));
    };
}
#[no_mangle]
pub unsafe extern "C" fn fpu_invalid_arithmetic() -> () { *fpu_status_word |= FPU_EX_I; }
#[no_mangle]
pub unsafe extern "C" fn fpu_fistm16p(mut addr: i32) -> () {
    fpu_fistm16(addr);
    fpu_pop();
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fistm32(mut addr: i32) -> () {
    let mut st0: f64 = fpu_integer_round(fpu_get_st0());
    let mut i: i32 = convert_f64_to_i32(st0);
    if i == 2147483648u32 as i32 {
        c_comment!(("XXX: Probably not correct if st0 == 0x80000000"));
        c_comment!(("(input fits, but same value as error value)"));
        fpu_invalid_arithmetic();
    }
    return_on_pagefault!(safe_write32(addr, i));
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fistm32p(mut addr: i32) -> () {
    fpu_fistm32(addr);
    fpu_pop();
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fistm64p(mut addr: i32) -> () {
    let mut st0: f64 = fpu_integer_round(fpu_get_st0());
    let mut value: i64 = 0;
    if st0 < TWO_POW_63 && st0 >= -TWO_POW_63 {
        value = st0 as i64
    }
    else {
        value = 9223372036854775808u64 as i64;
        fpu_invalid_arithmetic();
    }
    return_on_pagefault!(safe_write64(addr, value));
    fpu_pop();
}
#[no_mangle]
pub static mut TWO_POW_63: f64 = unsafe { 9223372036854775808u64 as f64 };
#[no_mangle]
pub unsafe extern "C" fn fpu_fldcw(mut addr: i32) -> () {
    let mut word: i32 = return_on_pagefault!(safe_read16(addr));
    *fpu_control_word = word;
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fldenv(mut addr: i32) -> () {
    if is_osize_32() {
        // TODO: Add readable_or_pagefault
        return_on_pagefault!(translate_address_read(addr));
        return_on_pagefault!(translate_address_read(addr + 28));
        *fpu_control_word = safe_read16(addr).unwrap();
        fpu_set_status_word(safe_read16(addr + 4i32).unwrap());
        fpu_set_tag_word(safe_read16(addr + 8i32).unwrap());
        *fpu_ip.offset(0isize) = safe_read32s(addr + 12i32).unwrap();
        *fpu_ip_selector.offset(0isize) = safe_read16(addr + 16i32).unwrap();
        *fpu_opcode.offset(0isize) = safe_read16(addr + 18i32).unwrap();
        *fpu_dp.offset(0isize) = safe_read32s(addr + 20i32).unwrap();
        *fpu_dp_selector.offset(0isize) = safe_read16(addr + 24i32).unwrap()
    }
    else {
        dbg_log_c!("fldenv16");
        fpu_unimpl();
    };
}
#[no_mangle]
pub unsafe extern "C" fn fpu_unimpl() -> () {
    if DEBUG {
        dbg_assert!(0 != 0i32);
    }
    else {
        trigger_ud();
    };
}
#[no_mangle]
pub unsafe extern "C" fn fpu_set_tag_word(mut tag_word: i32) -> () {
    *fpu_stack_empty = 0i32;
    let mut i: i32 = 0i32;
    while i < 8i32 {
        *fpu_stack_empty |= tag_word >> i & tag_word >> i + 1i32 & 1i32 << i;
        i += 1
    }
}
#[no_mangle]
pub unsafe extern "C" fn fpu_set_status_word(mut sw: i32) -> () {
    *fpu_status_word = sw & !(7i32 << 11i32);
    *fpu_stack_ptr = (sw >> 11i32 & 7i32) as u32;
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fldm32(mut addr: i32) -> () {
    fpu_push(return_on_pagefault!(safe_read32s(addr)) as f64);
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fldm64(mut addr: i32) -> () {
    fpu_push(return_on_pagefault!(fpu_load_m64(addr)));
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fldm80(mut addr: i32) -> () {
    fpu_push(return_on_pagefault!(fpu_load_m80(addr as u32)));
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fmul(mut target_index: i32, mut val: f64) -> () {
    let mut st0: f64 = fpu_get_st0();
    *fpu_st.offset(((*fpu_stack_ptr).wrapping_add(target_index as u32) & 7i32 as u32) as isize) =
        st0 * val;
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fnstsw_mem(mut addr: i32) -> () {
    return_on_pagefault!(safe_write16(addr, fpu_load_status_word()));
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fnstsw_reg() -> () {
    *reg16.offset(AX as isize) = fpu_load_status_word() as u16;
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fprem() -> () {
    c_comment!(("XXX: This implementation differs from the description in Intel\'s manuals"));
    let mut st0: f64 = fpu_get_st0();
    let mut st1: f64 = fpu_get_sti(1i32);
    let mut fprem_quotient: i32 = convert_f64_to_i32(trunc(st0 / st1));
    *fpu_st.offset(*fpu_stack_ptr as isize) = fmod(st0, st1);
    *fpu_status_word &= !(FPU_C0 | FPU_C1 | FPU_C3);
    if 0 != fprem_quotient & 1i32 {
        *fpu_status_word |= FPU_C1
    }
    if 0 != fprem_quotient & 1i32 << 1i32 {
        *fpu_status_word |= FPU_C3
    }
    if 0 != fprem_quotient & 1i32 << 2i32 {
        *fpu_status_word |= FPU_C0
    }
    *fpu_status_word &= !FPU_C2;
}
#[no_mangle]
pub unsafe extern "C" fn fpu_frstor(mut addr: i32) -> () {
    // TODO: Add readable_or_pagefault
    return_on_pagefault!(translate_address_read(addr));
    return_on_pagefault!(translate_address_read(addr + 28 + 8 * 10));
    fpu_fldenv(addr);
    addr += 28i32;
    let mut i: i32 = 0i32;
    while i < 8i32 {
        *fpu_st.offset(((i as u32).wrapping_add(*fpu_stack_ptr) & 7i32 as u32) as isize) =
            fpu_load_m80(addr as u32).unwrap();
        addr += 10i32;
        i += 1
    }
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fsave(mut addr: i32) -> () {
    return_on_pagefault!(writable_or_pagefault(addr, 108i32));
    fpu_fstenv(addr);
    addr += 28i32;
    let mut i: i32 = 0i32;
    while i < 8i32 {
        fpu_store_m80(
            addr as u32,
            *fpu_st.offset(((*fpu_stack_ptr).wrapping_add(i as u32) & 7i32 as u32) as isize),
        );
        addr += 10i32;
        i += 1
    }
    fpu_finit();
}
#[no_mangle]
pub unsafe extern "C" fn fpu_store_m80(mut addr: u32, mut n: f64) -> () {
    let mut double_int_view: f64_int = f64_int { f64_0: n };
    let mut sign: u8 = (double_int_view.u8_0[7usize] as i32 & 128i32) as u8;
    let mut exponent: i32 = (double_int_view.u8_0[7usize] as i32 & 127i32) << 4i32
        | double_int_view.u8_0[6usize] as i32 >> 4i32;
    let mut low: i32 = 0;
    let mut high: i32 = 0;
    if exponent == 2047i32 {
        c_comment!(("all bits set (NaN and infinity)"));
        exponent = 32767i32;
        low = 0i32;
        high =
            (2147483648u32 | ((double_int_view.i32_0[1usize] & 524288i32) << 11i32) as u32) as i32
    }
    else if exponent == 0i32 {
        c_comment!(("zero and denormal numbers"));
        c_comment!(("Just assume zero for now"));
        low = 0i32;
        high = 0i32
    }
    else {
        exponent += 16383i32 - 1023i32;
        c_comment!(("does the mantissa need to be adjusted?"));
        low = double_int_view.i32_0[0usize] << 11i32;
        high = (2147483648u32
            | ((double_int_view.i32_0[1usize] & 1048575i32) << 11i32) as u32
            | double_int_view.i32_0[0usize] as u32 >> 21i32) as i32
    }
    dbg_assert!(exponent >= 0i32 && exponent < 32768i32);
    c_comment!(("writable_or_pagefault must have checked called by the caller!"));
    safe_write64(
        addr as i32,
        (low as u64 & 4294967295u32 as u64 | (high as u64) << 32i32) as i64,
    ).unwrap();
    safe_write16(
        addr.wrapping_add(8i32 as u32) as i32,
        (sign as i32) << 8i32 | exponent,
    ).unwrap();
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fstenv(mut addr: i32) -> () {
    if is_osize_32() {
        return_on_pagefault!(writable_or_pagefault(addr, 26i32));
        safe_write16(addr, *fpu_control_word).unwrap();
        safe_write16(addr + 4i32, fpu_load_status_word()).unwrap();
        safe_write16(addr + 8i32, fpu_load_tag_word()).unwrap();
        safe_write32(addr + 12i32, *fpu_ip.offset(0isize)).unwrap();
        safe_write16(addr + 16i32, *fpu_ip_selector.offset(0isize)).unwrap();
        safe_write16(addr + 18i32, *fpu_opcode.offset(0isize)).unwrap();
        safe_write32(addr + 20i32, *fpu_dp.offset(0isize)).unwrap();
        safe_write16(addr + 24i32, *fpu_dp_selector.offset(0isize)).unwrap();
    }
    else {
        dbg_log_c!("fstenv16");
        fpu_unimpl();
    };
}
#[no_mangle]
pub unsafe extern "C" fn fpu_load_tag_word() -> i32 {
    let mut tag_word: i32 = 0i32;
    let mut i: i32 = 0i32;
    while i < 8i32 {
        let mut value: f64 = *fpu_st.offset(i as isize);
        if 0 != *fpu_stack_empty >> i & 1i32 {
            tag_word |= 3i32 << (i << 1i32)
        }
        else if value == 0i32 as f64 {
            tag_word |= 1i32 << (i << 1i32)
        }
        else if !isfinite_XXX(value) {
            tag_word |= 2i32 << (i << 1i32)
        }
        i += 1
    }
    return tag_word;
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fst(mut r: i32) -> () {
    *fpu_st.offset((*fpu_stack_ptr).wrapping_add(r as u32) as isize) = fpu_get_st0();
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fst80p(mut addr: i32) -> () {
    return_on_pagefault!(writable_or_pagefault(addr, 10i32));
    fpu_store_m80(addr as u32, fpu_get_st0());
    fpu_pop();
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fstcw(mut addr: i32) -> () {
    return_on_pagefault!(safe_write16(addr, *fpu_control_word));
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fstm32(mut addr: i32) -> () {
    return_on_pagefault!(fpu_store_m32(addr, fpu_get_st0()));
}
#[no_mangle]
pub unsafe extern "C" fn fpu_store_m32(mut addr: i32, mut x: f64) -> Result<(), ()> {
    let mut v: f32_int = f32_int { f32_0: x as f32 };
    safe_write32(addr, v.i32_0)
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fstm32p(mut addr: i32) -> () {
    fpu_fstm32(addr);
    fpu_pop();
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fstm64(mut addr: i32) -> () {
    return_on_pagefault!(fpu_store_m64(addr, fpu_get_st0()));
}
#[no_mangle]
pub unsafe extern "C" fn fpu_store_m64(mut addr: i32, mut x: f64) -> Result<(), ()> {
    let mut v: f64_int = f64_int { f64_0: x };
    safe_write64(addr, v.u64_0[0usize] as i64)
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fstm64p(mut addr: i32) -> () {
    fpu_fstm64(addr);
    fpu_pop();
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fstp(mut r: i32) -> () {
    fpu_fst(r);
    fpu_pop();
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fsub(mut target_index: i32, mut val: f64) -> () {
    let mut st0: f64 = fpu_get_st0();
    *fpu_st.offset(((*fpu_stack_ptr).wrapping_add(target_index as u32) & 7i32 as u32) as isize) =
        st0 - val;
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fsubr(mut target_index: i32, mut val: f64) -> () {
    let mut st0: f64 = fpu_get_st0();
    *fpu_st.offset(((*fpu_stack_ptr).wrapping_add(target_index as u32) & 7i32 as u32) as isize) =
        val - st0;
}
#[no_mangle]
pub unsafe extern "C" fn fpu_ftst(mut x: f64) -> () {
    *fpu_status_word &= !FPU_RESULT_FLAGS;
    if isnan_XXX(x) {
        *fpu_status_word |= FPU_C3 | FPU_C2 | FPU_C0
    }
    else if x == 0i32 as f64 {
        *fpu_status_word |= FPU_C3
    }
    else if x < 0i32 as f64 {
        *fpu_status_word |= FPU_C0
    }
    c_comment!(("TODO: unordered (x is nan, etc)"));
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fucom(mut r: i32) -> () {
    c_comment!(("TODO"));
    fpu_fcom(fpu_get_sti(r));
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fucomi(mut r: i32) -> () {
    c_comment!(("TODO"));
    fpu_fcomi(r);
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fucomip(mut r: i32) -> () {
    fpu_fucomi(r);
    fpu_pop();
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fucomp(mut r: i32) -> () {
    fpu_fucom(r);
    fpu_pop();
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fucompp() -> () {
    fpu_fucom(1i32);
    fpu_pop();
    fpu_pop();
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fxam(mut x: f64) -> () {
    *fpu_status_word &= !FPU_RESULT_FLAGS;
    *fpu_status_word |= fpu_sign(0i32) << 9i32;
    if 0 != *fpu_stack_empty >> *fpu_stack_ptr & 1i32 {
        *fpu_status_word |= FPU_C3 | FPU_C0
    }
    else if isnan_XXX(x) {
        *fpu_status_word |= FPU_C0
    }
    else if x == 0i32 as f64 {
        *fpu_status_word |= FPU_C3
    }
    else if x == ::std::f32::INFINITY as f64 || x == -::std::f32::INFINITY as f64 {
        *fpu_status_word |= FPU_C2 | FPU_C0
    }
    else {
        *fpu_status_word |= FPU_C2
    }
    c_comment!(("TODO:"));
    c_comment!(("Unsupported, Denormal"));
}
#[no_mangle]
pub unsafe extern "C" fn fpu_sign(mut i: i32) -> i32 {
    c_comment!(("sign of a number on the stack"));
    return *fpu_st8.offset(
        (((*fpu_stack_ptr).wrapping_add(i as u32) & 7i32 as u32) << 3i32 | 7i32 as u32) as isize,
    ) as i32
        >> 7i32;
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fxch(mut i: i32) -> () {
    let mut sti: f64 = fpu_get_sti(i);
    *fpu_st.offset((*fpu_stack_ptr).wrapping_add(i as u32) as isize) = fpu_get_st0();
    *fpu_st.offset(*fpu_stack_ptr as isize) = sti;
}
#[no_mangle]
pub unsafe extern "C" fn fpu_fxtract() -> () {
    let mut double_int_view: f64_int = f64_int {
        f64_0: fpu_get_st0(),
    };
    let mut exponent: f64 = (((double_int_view.u8_0[7usize] as i32 & 127i32) << 4i32
        | double_int_view.u8_0[6usize] as i32 >> 4i32)
        - 1023i32) as f64;
    double_int_view.u8_0[7usize] = (63i32 | double_int_view.u8_0[7usize] as i32 & 128i32) as u8;
    double_int_view.u8_0[6usize] = (double_int_view.u8_0[6usize] as i32 | 240i32) as u8;
    *fpu_st.offset(*fpu_stack_ptr as isize) = exponent;
    fpu_push(double_int_view.f64_0);
}
#[no_mangle]
pub unsafe extern "C" fn fwait() -> () {
    c_comment!(("NOP unless FPU instructions run in parallel with CPU instructions"));
}
#[no_mangle]
pub static mut FPU_PC: i32 = unsafe { 3i32 << 8i32 };
#[no_mangle]
pub static mut FPU_RC: i32 = unsafe { 3i32 << 10i32 };
#[no_mangle]
pub static mut FPU_IF: i32 = unsafe { 1i32 << 12i32 };
#[no_mangle]
pub static mut FPU_EX_P: i32 = unsafe { 1i32 << 5i32 };
#[no_mangle]
pub static mut FPU_EX_U: i32 = unsafe { 1i32 << 4i32 };
#[no_mangle]
pub static mut FPU_EX_O: i32 = unsafe { 1i32 << 3i32 };
#[no_mangle]
pub static mut FPU_EX_Z: i32 = unsafe { 1i32 << 2i32 };
#[no_mangle]
pub static mut FPU_EX_D: i32 = unsafe { 1i32 << 1i32 };
