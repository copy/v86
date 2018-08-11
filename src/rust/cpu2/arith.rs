#![allow(
    dead_code,
    mutable_transmutes,
    non_camel_case_types,
    non_snake_case,
    non_upper_case_globals,
    unused_mut
)]
#![feature(extern_types, libc)]

extern "C" {

    #[no_mangle]
    fn __fpclassifyl(_: f64) -> i32;
    #[no_mangle]
    static FLAGS_ALL: i32;
    #[no_mangle]
    static flags_changed: *mut i32;
    #[no_mangle]
    static last_op_size: *mut i32;
    #[no_mangle]
    static last_result: *mut i32;
    #[no_mangle]
    static last_add_result: *mut i32;
    #[no_mangle]
    static last_op2: *mut i32;
    #[no_mangle]
    static last_op1: *mut i32;
    #[no_mangle]
    fn getcf() -> bool;
    #[no_mangle]
    static OPSIZE_8: i32;
    #[no_mangle]
    static OPSIZE_16: i32;
    #[no_mangle]
    static OPSIZE_32: i32;
    #[no_mangle]
    static flags: *mut i32;
    #[no_mangle]
    static FLAG_OVERFLOW: i32;
    #[no_mangle]
    static AL: i32;
    #[no_mangle]
    static reg8: *mut u8;
    #[no_mangle]
    static AX: i32;
    #[no_mangle]
    static reg16: *mut u16;
    #[no_mangle]
    static reg8s: *mut i8;
    #[no_mangle]
    static DX: i32;
    #[no_mangle]
    static reg16s: *mut i16;

    #[no_mangle]
    static EAX: i32;
    #[no_mangle]
    static reg32s: *mut i32;
    #[no_mangle]
    static EDX: i32;
    #[no_mangle]
    static FLAG_ADJUST: i32;
    #[no_mangle]
    fn getaf() -> bool;
    #[no_mangle]
    static AH: i32;
    #[no_mangle]
    fn trigger_de() -> ();
    #[no_mangle]
    fn c_comment(m: *const i8) -> ();
    #[no_mangle]
    fn safe_read8(addr: i32) -> i32;
    #[no_mangle]
    fn translate_address_write(address: i32) -> u32;
    #[no_mangle]
    fn read8(addr: u32) -> i32;
    #[no_mangle]
    fn write8(addr: u32, value: i32) -> ();
    #[no_mangle]
    fn int_log2(_: i32) -> i32;
    #[no_mangle]
    static FLAG_ZERO: i32;

    #[no_mangle]
    static FLAG_CARRY: i32;
    #[no_mangle]
    static FLAG_PARITY: i32;
    #[no_mangle]
    static FLAG_SIGN: i32;
    #[no_mangle]
    static FLAG_TRAP: i32;
    #[no_mangle]
    static FLAG_INTERRUPT: i32;
    #[no_mangle]
    static FLAG_DIRECTION: i32;
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
    static ECX: i32;
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
    static CX: i32;
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
    static CL: i32;
    #[no_mangle]
    static DL: i32;
    #[no_mangle]
    static BL: i32;
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
pub unsafe extern "C" fn add(
    mut dest_operand: i32,
    mut source_operand: i32,
    mut op_size: i32,
) -> i32 {
    *last_op1 = dest_operand;
    *last_op2 = source_operand;
    let mut res: i32 = dest_operand + source_operand;
    *last_result = res;
    *last_add_result = *last_result;
    *last_op_size = op_size;
    *flags_changed = FLAGS_ALL;
    return res;
}
#[no_mangle]
pub unsafe extern "C" fn adc(
    mut dest_operand: i32,
    mut source_operand: i32,
    mut op_size: i32,
) -> i32 {
    let mut cf: i32 = getcf() as i32;
    *last_op1 = dest_operand;
    *last_op2 = source_operand;
    let mut res: i32 = dest_operand + source_operand + cf;
    *last_result = res;
    *last_add_result = *last_result;
    *last_op_size = op_size;
    *flags_changed = FLAGS_ALL;
    return res;
}
#[no_mangle]
pub unsafe extern "C" fn sub(
    mut dest_operand: i32,
    mut source_operand: i32,
    mut op_size: i32,
) -> i32 {
    *last_add_result = dest_operand;
    *last_op2 = source_operand;
    let mut res: i32 = dest_operand - source_operand;
    *last_result = res;
    *last_op1 = *last_result;
    *last_op_size = op_size;
    *flags_changed = FLAGS_ALL;
    return res;
}
#[no_mangle]
pub unsafe extern "C" fn sbb(
    mut dest_operand: i32,
    mut source_operand: i32,
    mut op_size: i32,
) -> i32 {
    let mut cf: i32 = getcf() as i32;
    *last_add_result = dest_operand;
    *last_op2 = source_operand;
    let mut res: i32 = dest_operand - source_operand - cf;
    *last_result = res;
    *last_op1 = *last_result;
    *last_op_size = op_size;
    *flags_changed = FLAGS_ALL;
    return res;
}
#[no_mangle]
pub unsafe extern "C" fn add8(mut x: i32, mut y: i32) -> i32 { return add(x, y, OPSIZE_8); }
#[no_mangle]
pub unsafe extern "C" fn add16(mut x: i32, mut y: i32) -> i32 { return add(x, y, OPSIZE_16); }
#[no_mangle]
pub unsafe extern "C" fn add32(mut x: i32, mut y: i32) -> i32 { return add(x, y, OPSIZE_32); }
#[no_mangle]
pub unsafe extern "C" fn sub8(mut x: i32, mut y: i32) -> i32 { return sub(x, y, OPSIZE_8); }
#[no_mangle]
pub unsafe extern "C" fn sub16(mut x: i32, mut y: i32) -> i32 { return sub(x, y, OPSIZE_16); }
#[no_mangle]
pub unsafe extern "C" fn sub32(mut x: i32, mut y: i32) -> i32 { return sub(x, y, OPSIZE_32); }
#[no_mangle]
pub unsafe extern "C" fn adc8(mut x: i32, mut y: i32) -> i32 { return adc(x, y, OPSIZE_8); }
#[no_mangle]
pub unsafe extern "C" fn adc16(mut x: i32, mut y: i32) -> i32 { return adc(x, y, OPSIZE_16); }
#[no_mangle]
pub unsafe extern "C" fn adc32(mut x: i32, mut y: i32) -> i32 { return adc(x, y, OPSIZE_32); }
#[no_mangle]
pub unsafe extern "C" fn sbb8(mut x: i32, mut y: i32) -> i32 { return sbb(x, y, OPSIZE_8); }
#[no_mangle]
pub unsafe extern "C" fn sbb16(mut x: i32, mut y: i32) -> i32 { return sbb(x, y, OPSIZE_16); }
#[no_mangle]
pub unsafe extern "C" fn sbb32(mut x: i32, mut y: i32) -> i32 { return sbb(x, y, OPSIZE_32); }
#[no_mangle]
pub unsafe extern "C" fn cmp8(mut x: i32, mut y: i32) -> () { sub(x, y, OPSIZE_8); }
#[no_mangle]
pub unsafe extern "C" fn cmp16(mut x: i32, mut y: i32) -> () { sub(x, y, OPSIZE_16); }
#[no_mangle]
pub unsafe extern "C" fn cmp32(mut x: i32, mut y: i32) -> () { sub(x, y, OPSIZE_32); }
#[no_mangle]
pub unsafe extern "C" fn inc(mut dest_operand: i32, mut op_size: i32) -> i32 {
    *flags = *flags & !1i32 | getcf() as i32;
    *last_op1 = dest_operand;
    *last_op2 = 1i32;
    let mut res: i32 = dest_operand + 1i32;
    *last_result = res;
    *last_add_result = *last_result;
    *last_op_size = op_size;
    *flags_changed = FLAGS_ALL & !1i32;
    return res;
}
#[no_mangle]
pub unsafe extern "C" fn dec(mut dest_operand: i32, mut op_size: i32) -> i32 {
    *flags = *flags & !1i32 | getcf() as i32;
    *last_add_result = dest_operand;
    *last_op2 = 1i32;
    let mut res: i32 = dest_operand - 1i32;
    *last_result = res;
    *last_op1 = *last_result;
    *last_op_size = op_size;
    *flags_changed = FLAGS_ALL & !1i32;
    return res;
}
#[no_mangle]
pub unsafe extern "C" fn inc8(mut x: i32) -> i32 { return inc(x, OPSIZE_8); }
#[no_mangle]
pub unsafe extern "C" fn inc16(mut x: i32) -> i32 { return inc(x, OPSIZE_16); }
#[no_mangle]
pub unsafe extern "C" fn inc32(mut x: i32) -> i32 { return inc(x, OPSIZE_32); }
#[no_mangle]
pub unsafe extern "C" fn dec8(mut x: i32) -> i32 { return dec(x, OPSIZE_8); }
#[no_mangle]
pub unsafe extern "C" fn dec16(mut x: i32) -> i32 { return dec(x, OPSIZE_16); }
#[no_mangle]
pub unsafe extern "C" fn dec32(mut x: i32) -> i32 { return dec(x, OPSIZE_32); }
#[no_mangle]
pub unsafe extern "C" fn neg(mut dest_operand: i32, mut op_size: i32) -> i32 {
    let mut res: i32 = -dest_operand;
    *last_result = res;
    *last_op1 = *last_result;
    *flags_changed = FLAGS_ALL;
    *last_add_result = 0i32;
    *last_op2 = dest_operand;
    *last_op_size = op_size;
    return res;
}
#[no_mangle]
pub unsafe extern "C" fn neg8(mut x: i32) -> i32 { return neg(x, OPSIZE_8); }
#[no_mangle]
pub unsafe extern "C" fn neg16(mut x: i32) -> i32 { return neg(x, OPSIZE_16); }
#[no_mangle]
pub unsafe extern "C" fn neg32(mut x: i32) -> i32 { return neg(x, OPSIZE_32); }
#[no_mangle]
pub unsafe extern "C" fn mul8(mut source_operand: i32) -> () {
    let mut result: i32 = source_operand * *reg8.offset(AL as isize) as i32;
    *reg16.offset(AX as isize) = result as u16;
    *last_result = result & 255i32;
    *last_op_size = OPSIZE_8;
    if result < 256i32 {
        *flags = *flags & !1i32 & !FLAG_OVERFLOW
    }
    else {
        *flags = *flags | 1i32 | FLAG_OVERFLOW
    }
    *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
}
#[no_mangle]
pub unsafe extern "C" fn imul8(mut source_operand: i32) -> () {
    let mut result: i32 = source_operand * *reg8s.offset(AL as isize) as i32;
    *reg16.offset(AX as isize) = result as u16;
    *last_result = result & 255i32;
    *last_op_size = OPSIZE_8;
    if result > 127i32 || result < -128i32 {
        *flags = *flags | 1i32 | FLAG_OVERFLOW
    }
    else {
        *flags = *flags & !1i32 & !FLAG_OVERFLOW
    }
    *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
}
#[no_mangle]
pub unsafe extern "C" fn mul16(mut source_operand: u32) -> () {
    let mut result: u32 = source_operand.wrapping_mul(*reg16.offset(AX as isize) as u32);
    let mut high_result: u32 = result >> 16i32;
    *reg16.offset(AX as isize) = result as u16;
    *reg16.offset(DX as isize) = high_result as u16;
    *last_result = (result & 65535i32 as u32) as i32;
    *last_op_size = OPSIZE_16;
    if high_result == 0i32 as u32 {
        *flags &= !1i32 & !FLAG_OVERFLOW
    }
    else {
        *flags |= *flags | 1i32 | FLAG_OVERFLOW
    }
    *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
}
#[no_mangle]
pub unsafe extern "C" fn imul16(mut source_operand: i32) -> () {
    let mut result: i32 = source_operand * *reg16s.offset(AX as isize) as i32;
    *reg16.offset(AX as isize) = result as u16;
    *reg16.offset(DX as isize) = (result >> 16i32) as u16;
    *last_result = result & 65535i32;
    *last_op_size = OPSIZE_16;
    if result > 32767i32 || result < -32768i32 {
        *flags |= 1i32 | FLAG_OVERFLOW
    }
    else {
        *flags &= !1i32 & !FLAG_OVERFLOW
    }
    *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
}
#[no_mangle]
pub unsafe extern "C" fn imul_reg16(mut operand1: i32, mut operand2: i32) -> i32 {
    dbg_assert!(operand1 < 32768i32 && operand1 >= -32768i32);
    dbg_assert!(operand2 < 32768i32 && operand2 >= -32768i32);
    let mut result: i32 = operand1 * operand2;
    *last_result = result & 65535i32;
    *last_op_size = OPSIZE_16;
    if result > 32767i32 || result < -32768i32 {
        *flags |= 1i32 | FLAG_OVERFLOW
    }
    else {
        *flags &= !1i32 & !FLAG_OVERFLOW
    }
    *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
    return result;
}
#[no_mangle]
pub unsafe extern "C" fn mul32(mut source_operand: i32) -> () {
    let mut dest_operand: i32 = *reg32s.offset(EAX as isize);
    let mut result: u64 = (dest_operand as u32 as u64).wrapping_mul(source_operand as u32 as u64);
    let mut result_low: i32 = result as i32;
    let mut result_high: i32 = (result >> 32i32) as i32;
    *reg32s.offset(EAX as isize) = result_low;
    *reg32s.offset(EDX as isize) = result_high;
    *last_result = result_low;
    *last_op_size = OPSIZE_32;
    if result_high == 0i32 {
        *flags &= !1i32 & !FLAG_OVERFLOW
    }
    else {
        *flags |= 1i32 | FLAG_OVERFLOW
    }
    *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
}
#[no_mangle]
pub unsafe extern "C" fn imul32(mut source_operand: i32) -> () {
    let mut dest_operand: i32 = *reg32s.offset(EAX as isize);
    let mut result: i64 = dest_operand as i64 * source_operand as i64;
    let mut result_low: i32 = result as i32;
    let mut result_high: i32 = (result >> 32i32) as i32;
    *reg32s.offset(EAX as isize) = result_low;
    *reg32s.offset(EDX as isize) = result_high;
    *last_result = result_low;
    *last_op_size = OPSIZE_32;
    if result_high == result_low >> 31i32 {
        *flags &= !1i32 & !FLAG_OVERFLOW
    }
    else {
        *flags |= 1i32 | FLAG_OVERFLOW
    }
    *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
}
#[no_mangle]
pub unsafe extern "C" fn imul_reg32(mut operand1: i32, mut operand2: i32) -> i32 {
    let mut result: i64 = operand1 as i64 * operand2 as i64;
    let mut result_low: i32 = result as i32;
    let mut result_high: i32 = (result >> 32i32) as i32;
    *last_result = result_low;
    *last_op_size = OPSIZE_32;
    if result_high == result_low >> 31i32 {
        *flags &= !1i32 & !FLAG_OVERFLOW
    }
    else {
        *flags |= 1i32 | FLAG_OVERFLOW
    }
    *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
    return result_low;
}
#[no_mangle]
pub unsafe extern "C" fn xadd8(mut source_operand: i32, mut reg: i32) -> i32 {
    let mut tmp: i32 = *reg8.offset(reg as isize) as i32;
    *reg8.offset(reg as isize) = source_operand as u8;
    return add(source_operand, tmp, OPSIZE_8);
}
#[no_mangle]
pub unsafe extern "C" fn xadd16(mut source_operand: i32, mut reg: i32) -> i32 {
    let mut tmp: i32 = *reg16.offset(reg as isize) as i32;
    *reg16.offset(reg as isize) = source_operand as u16;
    return add(source_operand, tmp, OPSIZE_16);
}
#[no_mangle]
pub unsafe extern "C" fn xadd32(mut source_operand: i32, mut reg: i32) -> i32 {
    let mut tmp: i32 = *reg32s.offset(reg as isize);
    *reg32s.offset(reg as isize) = source_operand;
    return add(source_operand, tmp, OPSIZE_32);
}
#[no_mangle]
pub unsafe extern "C" fn bcd_daa() -> () {
    let mut old_al: i32 = *reg8.offset(AL as isize) as i32;
    let mut old_cf: i32 = getcf() as i32;
    let mut old_af: i32 = getaf() as i32;
    *flags &= !1i32 & !FLAG_ADJUST;
    if old_al & 15i32 > 9i32 || 0 != old_af {
        let ref mut fresh0 = *reg8.offset(AL as isize);
        *fresh0 = (*fresh0 as i32 + 6i32) as u8;
        *flags |= FLAG_ADJUST
    }
    if old_al > 153i32 || 0 != old_cf {
        let ref mut fresh1 = *reg8.offset(AL as isize);
        *fresh1 = (*fresh1 as i32 + 96i32) as u8;
        *flags |= 1i32
    }
    *last_result = *reg8.offset(AL as isize) as i32;
    *last_op_size = OPSIZE_8;
    *last_op2 = 0i32;
    *last_op1 = *last_op2;
    *flags_changed = FLAGS_ALL & !1i32 & !FLAG_ADJUST & !FLAG_OVERFLOW;
}
#[no_mangle]
pub unsafe extern "C" fn bcd_das() -> () {
    let mut old_al: i32 = *reg8.offset(AL as isize) as i32;
    let mut old_cf: i32 = getcf() as i32;
    *flags &= !1i32;
    if old_al & 15i32 > 9i32 || 0 != getaf() as i32 {
        let ref mut fresh2 = *reg8.offset(AL as isize);
        *fresh2 = (*fresh2 as i32 - 6i32) as u8;
        *flags |= FLAG_ADJUST;
        *flags = *flags & !1i32 | old_cf | (old_al < 6i32) as i32
    }
    else {
        *flags &= !FLAG_ADJUST
    }
    if old_al > 153i32 || 0 != old_cf {
        let ref mut fresh3 = *reg8.offset(AL as isize);
        *fresh3 = (*fresh3 as i32 - 96i32) as u8;
        *flags |= 1i32
    }
    *last_result = *reg8.offset(AL as isize) as i32;
    *last_op_size = OPSIZE_8;
    *last_op2 = 0i32;
    *last_op1 = *last_op2;
    *flags_changed = FLAGS_ALL & !1i32 & !FLAG_ADJUST & !FLAG_OVERFLOW;
}
#[no_mangle]
pub unsafe extern "C" fn bcd_aad(mut imm8: i32) -> () {
    let mut result: i32 =
        *reg8.offset(AL as isize) as i32 + *reg8.offset(AH as isize) as i32 * imm8;
    *last_result = result & 255i32;
    *reg16.offset(AX as isize) = *last_result as u16;
    *last_op_size = OPSIZE_8;
    *flags_changed = FLAGS_ALL & !1i32 & !FLAG_ADJUST & !FLAG_OVERFLOW;
    *flags &= !1i32 & !FLAG_ADJUST & !FLAG_OVERFLOW;
    if result > 65535i32 {
        *flags |= 1i32
    };
}
#[no_mangle]
pub unsafe extern "C" fn bcd_aam(mut imm8: i32) -> () {
    c_comment!(("ascii adjust after multiplication"));
    if imm8 == 0i32 {
        trigger_de();
    }
    else {
        let mut temp: u8 = *reg8.offset(AL as isize);
        *reg8.offset(AH as isize) = (temp as i32 / imm8) as u8;
        *reg8.offset(AL as isize) = (temp as i32 % imm8) as u8;
        *last_result = *reg8.offset(AL as isize) as i32;
        *flags_changed = FLAGS_ALL & !1i32 & !FLAG_ADJUST & !FLAG_OVERFLOW;
        *flags &= !1i32 & !FLAG_ADJUST & !FLAG_OVERFLOW
    };
}
#[no_mangle]
pub unsafe extern "C" fn bcd_aaa() -> () {
    if *reg8.offset(AL as isize) as i32 & 15i32 > 9i32 || 0 != getaf() as i32 {
        let ref mut fresh4 = *reg16.offset(AX as isize);
        *fresh4 = (*fresh4 as i32 + 6i32) as u16;
        let ref mut fresh5 = *reg8.offset(AH as isize);
        *fresh5 = (*fresh5 as i32 + 1i32) as u8;
        *flags |= FLAG_ADJUST | 1i32
    }
    else {
        *flags &= !FLAG_ADJUST & !1i32
    }
    let ref mut fresh6 = *reg8.offset(AL as isize);
    *fresh6 = (*fresh6 as i32 & 15i32) as u8;
    *flags_changed &= !FLAG_ADJUST & !1i32;
}
#[no_mangle]
pub unsafe extern "C" fn bcd_aas() -> () {
    if *reg8.offset(AL as isize) as i32 & 15i32 > 9i32 || 0 != getaf() as i32 {
        let ref mut fresh7 = *reg16.offset(AX as isize);
        *fresh7 = (*fresh7 as i32 - 6i32) as u16;
        let ref mut fresh8 = *reg8.offset(AH as isize);
        *fresh8 = (*fresh8 as i32 - 1i32) as u8;
        *flags |= FLAG_ADJUST | 1i32
    }
    else {
        *flags &= !FLAG_ADJUST & !1i32
    }
    let ref mut fresh9 = *reg8.offset(AL as isize);
    *fresh9 = (*fresh9 as i32 & 15i32) as u8;
    *flags_changed &= !FLAG_ADJUST & !1i32;
}
#[no_mangle]
pub unsafe extern "C" fn and(
    mut dest_operand: i32,
    mut source_operand: i32,
    mut op_size: i32,
) -> i32 {
    *last_result = dest_operand & source_operand;
    *last_op_size = op_size;
    *flags &= !1i32 & !FLAG_OVERFLOW & !FLAG_ADJUST;
    *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW & !FLAG_ADJUST;
    return *last_result;
}
#[no_mangle]
pub unsafe extern "C" fn or(
    mut dest_operand: i32,
    mut source_operand: i32,
    mut op_size: i32,
) -> i32 {
    *last_result = dest_operand | source_operand;
    *last_op_size = op_size;
    *flags &= !1i32 & !FLAG_OVERFLOW & !FLAG_ADJUST;
    *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW & !FLAG_ADJUST;
    return *last_result;
}
#[no_mangle]
pub unsafe extern "C" fn xor(
    mut dest_operand: i32,
    mut source_operand: i32,
    mut op_size: i32,
) -> i32 {
    *last_result = dest_operand ^ source_operand;
    *last_op_size = op_size;
    *flags &= !1i32 & !FLAG_OVERFLOW & !FLAG_ADJUST;
    *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW & !FLAG_ADJUST;
    return *last_result;
}
#[no_mangle]
pub unsafe extern "C" fn and8(mut x: i32, mut y: i32) -> i32 { return and(x, y, OPSIZE_8); }
#[no_mangle]
pub unsafe extern "C" fn and16(mut x: i32, mut y: i32) -> i32 { return and(x, y, OPSIZE_16); }
#[no_mangle]
pub unsafe extern "C" fn and32(mut x: i32, mut y: i32) -> i32 { return and(x, y, OPSIZE_32); }
#[no_mangle]
pub unsafe extern "C" fn test8(mut x: i32, mut y: i32) -> () { and(x, y, OPSIZE_8); }
#[no_mangle]
pub unsafe extern "C" fn test16(mut x: i32, mut y: i32) -> () { and(x, y, OPSIZE_16); }
#[no_mangle]
pub unsafe extern "C" fn test32(mut x: i32, mut y: i32) -> () { and(x, y, OPSIZE_32); }
#[no_mangle]
pub unsafe extern "C" fn or8(mut x: i32, mut y: i32) -> i32 { return or(x, y, OPSIZE_8); }
#[no_mangle]
pub unsafe extern "C" fn or16(mut x: i32, mut y: i32) -> i32 { return or(x, y, OPSIZE_16); }
#[no_mangle]
pub unsafe extern "C" fn or32(mut x: i32, mut y: i32) -> i32 { return or(x, y, OPSIZE_32); }
#[no_mangle]
pub unsafe extern "C" fn xor8(mut x: i32, mut y: i32) -> i32 { return xor(x, y, OPSIZE_8); }
#[no_mangle]
pub unsafe extern "C" fn xor16(mut x: i32, mut y: i32) -> i32 { return xor(x, y, OPSIZE_16); }
#[no_mangle]
pub unsafe extern "C" fn xor32(mut x: i32, mut y: i32) -> i32 { return xor(x, y, OPSIZE_32); }
#[no_mangle]
pub unsafe extern "C" fn rol8(mut dest_operand: i32, mut count: i32) -> i32 {
    if 0 == count {
        return dest_operand;
    }
    else {
        count &= 7i32;
        let mut result: i32 = dest_operand << count | dest_operand >> 8i32 - count;
        *flags_changed &= !1i32 & !FLAG_OVERFLOW;
        *flags = *flags & !1i32 & !FLAG_OVERFLOW
            | result & 1i32
            | (result << 11i32 ^ result << 4i32) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn rol16(mut dest_operand: i32, mut count: i32) -> i32 {
    if 0 == count {
        return dest_operand;
    }
    else {
        count &= 15i32;
        let mut result: i32 = dest_operand << count | dest_operand >> 16i32 - count;
        *flags_changed &= !1i32 & !FLAG_OVERFLOW;
        *flags = *flags & !1i32 & !FLAG_OVERFLOW
            | result & 1i32
            | (result << 11i32 ^ result >> 4i32) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn rol32(mut dest_operand: i32, mut count: i32) -> i32 {
    if 0 == count {
        return dest_operand;
    }
    else {
        let mut result: i32 =
            ((dest_operand << count) as u32 | dest_operand as u32 >> 32i32 - count) as i32;
        *flags_changed &= !1i32 & !FLAG_OVERFLOW;
        *flags = *flags & !1i32 & !FLAG_OVERFLOW
            | result & 1i32
            | (result << 11i32 ^ result >> 20i32) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn rcl8(mut dest_operand: i32, mut count: i32) -> i32 {
    count %= 9i32;
    if 0 == count {
        return dest_operand;
    }
    else {
        let mut result: i32 =
            dest_operand << count | (getcf() as i32) << count - 1i32 | dest_operand >> 9i32 - count;
        *flags_changed &= !1i32 & !FLAG_OVERFLOW;
        *flags = *flags & !1i32 & !FLAG_OVERFLOW
            | result >> 8i32 & 1i32
            | (result << 3i32 ^ result << 4i32) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn rcl16(mut dest_operand: i32, mut count: i32) -> i32 {
    count %= 17i32;
    if 0 == count {
        return dest_operand;
    }
    else {
        let mut result: i32 = dest_operand << count
            | (getcf() as i32) << count - 1i32
            | dest_operand >> 17i32 - count;
        *flags_changed &= !1i32 & !FLAG_OVERFLOW;
        *flags = *flags & !1i32 & !FLAG_OVERFLOW
            | result >> 16i32 & 1i32
            | (result >> 5i32 ^ result >> 4i32) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn rcl32(mut dest_operand: i32, mut count: i32) -> i32 {
    if 0 == count {
        return dest_operand;
    }
    else {
        let mut result: i32 = dest_operand << count | (getcf() as i32) << count - 1i32;
        if count > 1i32 {
            result = (result as u32 | dest_operand as u32 >> 33i32 - count) as i32
        }
        *flags_changed &= !1i32 & !FLAG_OVERFLOW;
        *flags = ((*flags & !1i32 & !FLAG_OVERFLOW) as u32
            | dest_operand as u32 >> 32i32 - count & 1i32 as u32) as i32;
        *flags |= (*flags << 11i32 ^ result >> 20i32) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn ror8(mut dest_operand: i32, mut count: i32) -> i32 {
    if 0 == count {
        return dest_operand;
    }
    else {
        count &= 7i32;
        let mut result: i32 = dest_operand >> count | dest_operand << 8i32 - count;
        *flags_changed &= !1i32 & !FLAG_OVERFLOW;
        *flags = *flags & !1i32 & !FLAG_OVERFLOW
            | result >> 7i32 & 1i32
            | (result << 4i32 ^ result << 5i32) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn ror16(mut dest_operand: i32, mut count: i32) -> i32 {
    if 0 == count {
        return dest_operand;
    }
    else {
        count &= 15i32;
        let mut result: i32 = dest_operand >> count | dest_operand << 16i32 - count;
        *flags_changed &= !1i32 & !FLAG_OVERFLOW;
        *flags = *flags & !1i32 & !FLAG_OVERFLOW
            | result >> 15i32 & 1i32
            | (result >> 4i32 ^ result >> 3i32) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn ror32(mut dest_operand: i32, mut count: i32) -> i32 {
    if 0 == count {
        return dest_operand;
    }
    else {
        let mut result: i32 =
            (dest_operand as u32 >> count | (dest_operand << 32i32 - count) as u32) as i32;
        *flags_changed &= !1i32 & !FLAG_OVERFLOW;
        *flags = *flags & !1i32 & !FLAG_OVERFLOW
            | result >> 31i32 & 1i32
            | (result >> 20i32 ^ result >> 19i32) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn rcr8(mut dest_operand: i32, mut count: i32) -> i32 {
    count %= 9i32;
    if 0 == count {
        return dest_operand;
    }
    else {
        let mut result: i32 =
            dest_operand >> count | (getcf() as i32) << 8i32 - count | dest_operand << 9i32 - count;
        *flags_changed &= !1i32 & !FLAG_OVERFLOW;
        *flags = *flags & !1i32 & !FLAG_OVERFLOW
            | result >> 8i32 & 1i32
            | (result << 4i32 ^ result << 5i32) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn rcr16(mut dest_operand: i32, mut count: i32) -> i32 {
    count %= 17i32;
    if 0 == count {
        return dest_operand;
    }
    else {
        let mut result: i32 = dest_operand >> count
            | (getcf() as i32) << 16i32 - count
            | dest_operand << 17i32 - count;
        *flags_changed &= !1i32 & !FLAG_OVERFLOW;
        *flags = *flags & !1i32 & !FLAG_OVERFLOW
            | result >> 16i32 & 1i32
            | (result >> 4i32 ^ result >> 3i32) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn rcr32(mut dest_operand: i32, mut count: i32) -> i32 {
    if 0 == count {
        return dest_operand;
    }
    else {
        let mut result: i32 =
            (dest_operand as u32 >> count | ((getcf() as i32) << 32i32 - count) as u32) as i32;
        if count > 1i32 {
            result |= dest_operand << 33i32 - count
        }
        *flags_changed &= !1i32 & !FLAG_OVERFLOW;
        *flags = *flags & !1i32 & !FLAG_OVERFLOW
            | dest_operand >> count - 1i32 & 1i32
            | (result >> 20i32 ^ result >> 19i32) & FLAG_OVERFLOW;
        return result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn div8(mut source_operand: u32) -> () {
    if source_operand == 0i32 as u32 {
        trigger_de();
        return;
    }
    else {
        let mut target_operand: u16 = *reg16.offset(AX as isize);
        let mut result: u16 = (target_operand as u32).wrapping_div(source_operand) as u16;
        if result as i32 >= 256i32 {
            trigger_de();
        }
        else {
            *reg8.offset(AL as isize) = result as u8;
            *reg8.offset(AH as isize) = (target_operand as u32).wrapping_rem(source_operand) as u8
        }
        return;
    };
}
#[no_mangle]
pub unsafe extern "C" fn idiv8(mut source_operand: i32) -> () {
    if source_operand == 0i32 {
        trigger_de();
        return;
    }
    else {
        let mut target_operand: i32 = *reg16s.offset(AX as isize) as i32;
        let mut result: i32 = target_operand / source_operand;
        if result >= 128i32 || result <= -129i32 {
            trigger_de();
        }
        else {
            *reg8.offset(AL as isize) = result as u8;
            *reg8.offset(AH as isize) = (target_operand % source_operand) as u8
        }
        return;
    };
}
#[no_mangle]
pub unsafe extern "C" fn div16(mut source_operand: u32) -> () {
    if source_operand == 0i32 as u32 {
        trigger_de();
        return;
    }
    else {
        let mut target_operand: u32 = (*reg16.offset(AX as isize) as i32
            | (*reg16.offset(DX as isize) as i32) << 16i32)
            as u32;
        let mut result: u32 = target_operand.wrapping_div(source_operand);
        if result >= 65536i32 as u32 {
            trigger_de();
        }
        else {
            *reg16.offset(AX as isize) = result as u16;
            *reg16.offset(DX as isize) = target_operand.wrapping_rem(source_operand) as u16
        }
        return;
    };
}
#[no_mangle]
pub unsafe extern "C" fn idiv16(mut source_operand: i32) -> () {
    if source_operand == 0i32 {
        trigger_de();
        return;
    }
    else {
        let mut target_operand: i32 =
            *reg16.offset(AX as isize) as i32 | (*reg16.offset(DX as isize) as i32) << 16i32;
        let mut result: i32 = target_operand / source_operand;
        if result >= 32768i32 || result <= -32769i32 {
            trigger_de();
        }
        else {
            *reg16.offset(AX as isize) = result as u16;
            *reg16.offset(DX as isize) = (target_operand % source_operand) as u16
        }
        return;
    };
}
#[no_mangle]
pub unsafe extern "C" fn div32(mut source_operand: u32) -> () {
    if source_operand == 0i32 as u32 {
        trigger_de();
        return;
    }
    else {
        let mut target_low: u32 = *reg32s.offset(EAX as isize) as u32;
        let mut target_high: u32 = *reg32s.offset(EDX as isize) as u32;
        let mut target_operand: u64 = (target_high as u64) << 32i32 | target_low as u64;
        let mut result: u64 = target_operand.wrapping_div(source_operand as u64);
        if result > 4294967295u32 as u64 {
            trigger_de();
            return;
        }
        else {
            let mut mod_0: i32 = target_operand.wrapping_rem(source_operand as u64) as i32;
            *reg32s.offset(EAX as isize) = result as i32;
            *reg32s.offset(EDX as isize) = mod_0;
            return;
        }
    };
}
#[no_mangle]
pub unsafe extern "C" fn idiv32(mut source_operand: i32) -> () {
    if source_operand == 0i32 {
        trigger_de();
        return;
    }
    else {
        let mut target_low: u32 = *reg32s.offset(EAX as isize) as u32;
        let mut target_high: u32 = *reg32s.offset(EDX as isize) as u32;
        let mut target_operand: i64 = ((target_high as u64) << 32i32 | target_low as u64) as i64;
        if source_operand == -1i32
            && target_operand == (-1i32 as i64 - 9223372036854775807i64) as i64
        {
            trigger_de();
            return;
        }
        else {
            let mut result: i64 = target_operand / source_operand as i64;
            if result < (-1i32 - 2147483647i32) as i64 || result > 2147483647i32 as i64 {
                trigger_de();
                return;
            }
            else {
                let mut mod_0: i32 = (target_operand % source_operand as i64) as i32;
                *reg32s.offset(EAX as isize) = result as i32;
                *reg32s.offset(EDX as isize) = mod_0;
                return;
            }
        }
    };
}
#[no_mangle]
pub unsafe extern "C" fn shl8(mut dest_operand: i32, mut count: i32) -> i32 {
    if count == 0i32 {
        return dest_operand;
    }
    else {
        *last_result = dest_operand << count;
        *last_op_size = OPSIZE_8;
        *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
        *flags = *flags & !1i32 & !FLAG_OVERFLOW
            | *last_result >> 8i32 & 1i32
            | (*last_result << 3i32 ^ *last_result << 4i32) & FLAG_OVERFLOW;
        return *last_result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn shl16(mut dest_operand: i32, mut count: i32) -> i32 {
    if count == 0i32 {
        return dest_operand;
    }
    else {
        *last_result = dest_operand << count;
        *last_op_size = OPSIZE_16;
        *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
        *flags = *flags & !1i32 & !FLAG_OVERFLOW
            | *last_result >> 16i32 & 1i32
            | (*last_result >> 5i32 ^ *last_result >> 4i32) & FLAG_OVERFLOW;
        return *last_result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn shl32(mut dest_operand: i32, mut count: i32) -> i32 {
    if count == 0i32 {
        return dest_operand;
    }
    else {
        *last_result = dest_operand << count;
        *last_op_size = OPSIZE_32;
        *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
        c_comment!(("test this"));
        *flags = *flags & !1i32 & !FLAG_OVERFLOW | dest_operand >> 32i32 - count & 1i32;
        *flags |= (*flags & 1i32 ^ *last_result >> 31i32 & 1i32) << 11i32 & FLAG_OVERFLOW;
        return *last_result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn shr8(mut dest_operand: i32, mut count: i32) -> i32 {
    if count == 0i32 {
        return dest_operand;
    }
    else {
        *last_result = dest_operand >> count;
        *last_op_size = OPSIZE_8;
        *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
        *flags = *flags & !1i32 & !FLAG_OVERFLOW
            | dest_operand >> count - 1i32 & 1i32
            | (dest_operand >> 7i32 & 1i32) << 11i32 & FLAG_OVERFLOW;
        return *last_result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn shr16(mut dest_operand: i32, mut count: i32) -> i32 {
    if count == 0i32 {
        return dest_operand;
    }
    else {
        *last_result = dest_operand >> count;
        *last_op_size = OPSIZE_16;
        *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
        *flags = *flags & !1i32 & !FLAG_OVERFLOW
            | dest_operand >> count - 1i32 & 1i32
            | dest_operand >> 4i32 & FLAG_OVERFLOW;
        return *last_result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn shr32(mut dest_operand: i32, mut count: i32) -> i32 {
    if count == 0i32 {
        return dest_operand;
    }
    else {
        *last_result = (dest_operand as u32 >> count) as i32;
        *last_op_size = OPSIZE_32;
        *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
        *flags = ((*flags & !1i32 & !FLAG_OVERFLOW) as u32
            | dest_operand as u32 >> count - 1i32 & 1i32 as u32
            | (dest_operand >> 20i32 & FLAG_OVERFLOW) as u32) as i32;
        return *last_result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn sar8(mut dest_operand: i32, mut count: i32) -> i32 {
    if count == 0i32 {
        return dest_operand;
    }
    else {
        if count < 8i32 {
            *last_result = dest_operand << 24i32 >> count + 24i32;
            c_comment!(("of is zero"));
            *flags = *flags & !1i32 & !FLAG_OVERFLOW | dest_operand >> count - 1i32 & 1i32
        }
        else {
            *last_result = dest_operand << 24i32 >> 31i32;
            *flags = *flags & !1i32 & !FLAG_OVERFLOW | *last_result & 1i32
        }
        *last_op_size = OPSIZE_8;
        *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
        return *last_result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn sar16(mut dest_operand: i32, mut count: i32) -> i32 {
    if count == 0i32 {
        return dest_operand;
    }
    else {
        if count < 16i32 {
            *last_result = dest_operand << 16i32 >> count + 16i32;
            *flags = *flags & !1i32 & !FLAG_OVERFLOW | dest_operand >> count - 1i32 & 1i32
        }
        else {
            *last_result = dest_operand << 16i32 >> 31i32;
            *flags = *flags & !1i32 & !FLAG_OVERFLOW | *last_result & 1i32
        }
        *last_op_size = OPSIZE_16;
        *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
        return *last_result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn sar32(mut dest_operand: i32, mut count: i32) -> i32 {
    if count == 0i32 {
        return dest_operand;
    }
    else {
        *last_result = dest_operand >> count;
        *last_op_size = OPSIZE_32;
        *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
        *flags = ((*flags & !1i32 & !FLAG_OVERFLOW) as u32
            | dest_operand as u32 >> count - 1i32 & 1i32 as u32) as i32;
        return *last_result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn shrd16(
    mut dest_operand: i32,
    mut source_operand: i32,
    mut count: i32,
) -> i32 {
    if count == 0i32 {
        return dest_operand;
    }
    else {
        if count <= 16i32 {
            *last_result = dest_operand >> count | source_operand << 16i32 - count;
            *flags = *flags & !1i32 | dest_operand >> count - 1i32 & 1i32
        }
        else {
            *last_result = dest_operand << 32i32 - count | source_operand >> count - 16i32;
            *flags = *flags & !1i32 | source_operand >> count - 17i32 & 1i32
        }
        *last_op_size = OPSIZE_16;
        *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
        *flags = *flags & !FLAG_OVERFLOW | (*last_result ^ dest_operand) >> 4i32 & FLAG_OVERFLOW;
        return *last_result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn shrd32(
    mut dest_operand: i32,
    mut source_operand: i32,
    mut count: i32,
) -> i32 {
    if count == 0i32 {
        return dest_operand;
    }
    else {
        *last_result =
            (dest_operand as u32 >> count | (source_operand << 32i32 - count) as u32) as i32;
        *last_op_size = OPSIZE_32;
        *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
        *flags =
            ((*flags & !1i32) as u32 | dest_operand as u32 >> count - 1i32 & 1i32 as u32) as i32;
        *flags = *flags & !FLAG_OVERFLOW | (*last_result ^ dest_operand) >> 20i32 & FLAG_OVERFLOW;
        return *last_result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn shld16(
    mut dest_operand: i32,
    mut source_operand: i32,
    mut count: i32,
) -> i32 {
    if count == 0i32 {
        return dest_operand;
    }
    else {
        if count <= 16i32 {
            *last_result =
                ((dest_operand << count) as u32 | source_operand as u32 >> 16i32 - count) as i32;
            *flags = ((*flags & !1i32) as u32 | dest_operand as u32 >> 16i32 - count & 1i32 as u32)
                as i32
        }
        else {
            *last_result = dest_operand >> 32i32 - count | source_operand << count - 16i32;
            *flags = ((*flags & !1i32) as u32
                | source_operand as u32 >> 32i32 - count & 1i32 as u32) as i32
        }
        *last_op_size = OPSIZE_16;
        *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
        *flags = *flags & !FLAG_OVERFLOW | (*flags & 1i32 ^ *last_result >> 15i32 & 1i32) << 11i32;
        return *last_result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn shld32(
    mut dest_operand: i32,
    mut source_operand: i32,
    mut count: i32,
) -> i32 {
    if count == 0i32 {
        return dest_operand;
    }
    else {
        *last_result =
            ((dest_operand << count) as u32 | source_operand as u32 >> 32i32 - count) as i32;
        *last_op_size = OPSIZE_32;
        *flags_changed = FLAGS_ALL & !1i32 & !FLAG_OVERFLOW;
        *flags =
            ((*flags & !1i32) as u32 | dest_operand as u32 >> 32i32 - count & 1i32 as u32) as i32;
        if count == 1i32 {
            *flags =
                *flags & !FLAG_OVERFLOW | (*flags & 1i32 ^ *last_result >> 31i32 & 1i32) << 11i32
        }
        else {
            *flags &= !FLAG_OVERFLOW
        }
        return *last_result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn bt_reg(mut bit_base: i32, mut bit_offset: i32) -> () {
    *flags = *flags & !1i32 | bit_base >> bit_offset & 1i32;
    *flags_changed &= !1i32;
}
#[no_mangle]
pub unsafe extern "C" fn btc_reg(mut bit_base: i32, mut bit_offset: i32) -> i32 {
    *flags = *flags & !1i32 | bit_base >> bit_offset & 1i32;
    *flags_changed &= !1i32;
    return bit_base ^ 1i32 << bit_offset;
}
#[no_mangle]
pub unsafe extern "C" fn bts_reg(mut bit_base: i32, mut bit_offset: i32) -> i32 {
    *flags = *flags & !1i32 | bit_base >> bit_offset & 1i32;
    *flags_changed &= !1i32;
    return bit_base | 1i32 << bit_offset;
}
#[no_mangle]
pub unsafe extern "C" fn btr_reg(mut bit_base: i32, mut bit_offset: i32) -> i32 {
    *flags = *flags & !1i32 | bit_base >> bit_offset & 1i32;
    *flags_changed &= !1i32;
    return bit_base & !(1i32 << bit_offset);
}
#[no_mangle]
pub unsafe extern "C" fn bt_mem(mut virt_addr: i32, mut bit_offset: i32) -> () {
    let mut bit_base: i32 = safe_read8(virt_addr + (bit_offset >> 3i32));
    bit_offset &= 7i32;
    *flags = *flags & !1i32 | bit_base >> bit_offset & 1i32;
    *flags_changed &= !1i32;
}
#[no_mangle]
pub unsafe extern "C" fn btc_mem(mut virt_addr: i32, mut bit_offset: i32) -> () {
    let mut phys_addr: i32 = translate_address_write(virt_addr + (bit_offset >> 3i32)) as i32;
    let mut bit_base: i32 = read8(phys_addr as u32);
    bit_offset &= 7i32;
    *flags = *flags & !1i32 | bit_base >> bit_offset & 1i32;
    *flags_changed &= !1i32;
    write8(phys_addr as u32, bit_base ^ 1i32 << bit_offset);
}
#[no_mangle]
pub unsafe extern "C" fn btr_mem(mut virt_addr: i32, mut bit_offset: i32) -> () {
    let mut phys_addr: i32 = translate_address_write(virt_addr + (bit_offset >> 3i32)) as i32;
    let mut bit_base: i32 = read8(phys_addr as u32);
    bit_offset &= 7i32;
    *flags = *flags & !1i32 | bit_base >> bit_offset & 1i32;
    *flags_changed &= !1i32;
    write8(phys_addr as u32, bit_base & !(1i32 << bit_offset));
}
#[no_mangle]
pub unsafe extern "C" fn bts_mem(mut virt_addr: i32, mut bit_offset: i32) -> () {
    let mut phys_addr: i32 = translate_address_write(virt_addr + (bit_offset >> 3i32)) as i32;
    let mut bit_base: i32 = read8(phys_addr as u32);
    bit_offset &= 7i32;
    *flags = *flags & !1i32 | bit_base >> bit_offset & 1i32;
    *flags_changed &= !1i32;
    write8(phys_addr as u32, bit_base | 1i32 << bit_offset);
}
#[no_mangle]
pub unsafe extern "C" fn bsf16(mut old: i32, mut bit_base: i32) -> i32 {
    *flags_changed = FLAGS_ALL & !FLAG_ZERO;
    *last_op_size = OPSIZE_16;
    if bit_base == 0i32 {
        *flags |= FLAG_ZERO;
        *last_result = bit_base;
        c_comment!(("not defined in the docs, but value doesn\'t change on my intel machine"));
        return old;
    }
    else {
        *flags &= !FLAG_ZERO;
        *last_result = int_log2(-bit_base & bit_base);
        return *last_result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn bsf32(mut old: i32, mut bit_base: i32) -> i32 {
    *flags_changed = FLAGS_ALL & !FLAG_ZERO;
    *last_op_size = OPSIZE_32;
    if bit_base == 0i32 {
        *flags |= FLAG_ZERO;
        *last_result = bit_base;
        return old;
    }
    else {
        *flags &= !FLAG_ZERO;
        *last_result = int_log2((-bit_base & bit_base) as u32 as i32);
        return *last_result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn bsr16(mut old: i32, mut bit_base: i32) -> i32 {
    *flags_changed = FLAGS_ALL & !FLAG_ZERO;
    *last_op_size = OPSIZE_16;
    if bit_base == 0i32 {
        *flags |= FLAG_ZERO;
        *last_result = bit_base;
        return old;
    }
    else {
        *flags &= !FLAG_ZERO;
        *last_result = int_log2(bit_base);
        return *last_result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn bsr32(mut old: i32, mut bit_base: i32) -> i32 {
    *flags_changed = FLAGS_ALL & !FLAG_ZERO;
    *last_op_size = OPSIZE_32;
    if bit_base == 0i32 {
        *flags |= FLAG_ZERO;
        *last_result = bit_base;
        return old;
    }
    else {
        *flags &= !FLAG_ZERO;
        *last_result = int_log2(bit_base as u32 as i32);
        return *last_result;
    };
}
#[no_mangle]
pub unsafe extern "C" fn popcnt(mut v: i32) -> i32 {
    *flags_changed = 0i32;
    *flags &= !FLAGS_ALL;
    if 0 != v {
        c_comment!(("http://graphics.stanford.edu/~seander/bithacks.html#CountBitsSetParallel"));
        v = v - (v >> 1i32 & 1431655765i32);
        v = (v & 858993459i32) + (v >> 2i32 & 858993459i32);
        return (v + (v >> 4i32) & 252645135i32) * 16843009i32 >> 24i32;
    }
    else {
        *flags |= FLAG_ZERO;
        return 0i32;
    };
}
#[no_mangle]
pub unsafe extern "C" fn saturate_sw_to_ub(mut v: u32) -> u32 {
    dbg_assert!(v & 4294901760u32 == 0i32 as u32);
    let mut ret: u32 = v;
    if ret >= 32768i32 as u32 {
        ret = 0i32 as u32
    }
    else if ret > 255i32 as u32 {
        ret = 255i32 as u32
    }
    dbg_assert!(ret & 4294967040u32 == 0i32 as u32);
    return ret;
}
#[no_mangle]
pub unsafe extern "C" fn saturate_sw_to_sb(mut v: i32) -> i32 {
    dbg_assert!(v as u32 & 4294901760u32 == 0i32 as u32);
    let mut ret: i32 = v;
    if ret > 65408i32 {
        ret = ret & 255i32
    }
    else if ret > 32767i32 {
        ret = 128i32
    }
    else if ret > 127i32 {
        ret = 127i32
    }
    dbg_assert!(ret as u32 & 4294967040u32 == 0i32 as u32);
    return ret;
}
#[no_mangle]
pub unsafe extern "C" fn saturate_sd_to_sw(mut v: u32) -> u32 {
    let mut ret: u32 = v;
    if ret > 4294934528u32 {
        ret = ret & 65535i32 as u32
    }
    else if ret > 2147483647i32 as u32 {
        ret = 32768i32 as u32
    }
    else if ret > 32767i32 as u32 {
        ret = 32767i32 as u32
    }
    dbg_assert!(ret & 4294901760u32 == 0i32 as u32);
    return ret;
}
#[no_mangle]
pub unsafe extern "C" fn saturate_sd_to_sb(mut v: u32) -> u32 {
    let mut ret: u32 = v;
    if ret > 4294967168u32 {
        ret = ret & 255i32 as u32
    }
    else if ret > 2147483647i32 as u32 {
        ret = 128i32 as u32
    }
    else if ret > 127i32 as u32 {
        ret = 127i32 as u32
    }
    dbg_assert!(ret & 4294967040u32 == 0i32 as u32);
    return ret;
}
#[no_mangle]
pub unsafe extern "C" fn saturate_sd_to_ub(mut v: i32) -> i32 {
    let mut ret: i32 = v;
    if ret < 0i32 {
        ret = 0i32
    }
    dbg_assert!(ret as u32 & 4294967040u32 == 0i32 as u32);
    return ret;
}
#[no_mangle]
pub unsafe extern "C" fn saturate_ud_to_ub(mut v: u32) -> u32 {
    let mut ret: u32 = v;
    if ret > 255i32 as u32 {
        ret = 255i32 as u32
    }
    dbg_assert!(ret & 4294967040u32 == 0i32 as u32);
    return ret;
}
#[no_mangle]
pub unsafe extern "C" fn saturate_uw(mut v: u32) -> i32 {
    let mut ret: u32 = v;
    if ret > 2147483647i32 as u32 {
        ret = 0i32 as u32
    }
    else if ret > 65535i32 as u32 {
        ret = 65535i32 as u32
    }
    dbg_assert!(ret & 4294901760u32 == 0i32 as u32);
    return ret as i32;
}
