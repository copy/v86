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
use cpu2::fpu::fpu_load_m80;

extern "C" {

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
    fn dbg_log(m: *const i8) -> ();
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
    fn get_seg_cs() -> i32;
    #[no_mangle]
    fn get_seg_ss() -> i32;
    #[no_mangle]
    fn trigger_gp_non_raising(code: i32) -> ();
    #[no_mangle]
    fn write_reg8(index: i32, value: i32) -> ();
    #[no_mangle]
    fn write_reg16(index: i32, value: i32) -> ();
    #[no_mangle]
    fn write_reg32(index: i32, value: i32) -> ();
    #[no_mangle]
    fn get_reg_asize(reg: i32) -> i32;
    #[no_mangle]
    fn decr_ecx_asize() -> i32;
    #[no_mangle]
    static M_LOG2E: f64;
    #[no_mangle]
    static M_LN2: f64;
    #[no_mangle]
    static M_LN10: f64;
    #[no_mangle]
    static M_PI: f64;
    #[no_mangle]
    static FPU_C0: i32;
    #[no_mangle]
    static FPU_C1: i32;
    #[no_mangle]
    static FPU_C2: i32;
    #[no_mangle]
    static FPU_C3: i32;
    #[no_mangle]
    static FPU_RESULT_FLAGS: i32;
    #[no_mangle]
    static FPU_STACK_TOP: i32;
    #[no_mangle]
    fn fpu_load_status_word() -> i32;
    #[no_mangle]
    fn fpu_set_status_word(sw: i32) -> ();
    #[no_mangle]
    fn fpu_store_m80(addr: u32, n: f64) -> ();
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
}

#[derive(Copy, Clone)]
#[repr(C)]
pub union unnamed {
    __f: f64,
    __i: u64,
}

#[derive(Copy, Clone)]
#[repr(C)]
pub union unnamed_0 {
    __f: f32,
    __i: u32,
}

unsafe extern "C" fn __FLOAT_BITS(mut __f: f32) -> u32 {
    let mut __u: unnamed_0 = unnamed_0 { __f: 0. };
    __u.__f = __f;
    return __u.__i;
}
unsafe extern "C" fn __DOUBLE_BITS(mut __f: f64) -> u64 {
    let mut __u: unnamed = unnamed { __f: 0. };
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
pub unsafe extern "C" fn getcf() -> bool {
    if 0 != *flags_changed & 1i32 {
        return 0
            != (*last_op1 ^ (*last_op1 ^ *last_op2) & (*last_op2 ^ *last_add_result))
                >> *last_op_size
                & 1i32;
    }
    else {
        return 0 != *flags & 1i32;
    };
}
#[no_mangle]
pub unsafe extern "C" fn getpf() -> bool {
    if 0 != *flags_changed & FLAG_PARITY {
        c_comment!(("inverted lookup table"));
        return 0
            != 38505i32 << 2i32 >> ((*last_result ^ *last_result >> 4i32) & 15i32) & FLAG_PARITY;
    }
    else {
        return 0 != *flags & FLAG_PARITY;
    };
}
#[no_mangle]
pub unsafe extern "C" fn getaf() -> bool {
    if 0 != *flags_changed & FLAG_ADJUST {
        return 0 != (*last_op1 ^ *last_op2 ^ *last_add_result) & FLAG_ADJUST;
    }
    else {
        return 0 != *flags & FLAG_ADJUST;
    };
}
#[no_mangle]
pub unsafe extern "C" fn getzf() -> bool {
    if 0 != *flags_changed & FLAG_ZERO {
        return 0 != (!*last_result & *last_result - 1i32) >> *last_op_size & 1i32;
    }
    else {
        return 0 != *flags & FLAG_ZERO;
    };
}
#[no_mangle]
pub unsafe extern "C" fn getsf() -> bool {
    if 0 != *flags_changed & FLAG_SIGN {
        return 0 != *last_result >> *last_op_size & 1i32;
    }
    else {
        return 0 != *flags & FLAG_SIGN;
    };
}
#[no_mangle]
pub unsafe extern "C" fn getof() -> bool {
    if 0 != *flags_changed & FLAG_OVERFLOW {
        return 0
            != ((*last_op1 ^ *last_add_result) & (*last_op2 ^ *last_add_result)) >> *last_op_size
                & 1i32;
    }
    else {
        return 0 != *flags & FLAG_OVERFLOW;
    };
}
#[no_mangle]
pub unsafe extern "C" fn test_o() -> bool { return getof(); }
#[no_mangle]
pub unsafe extern "C" fn test_b() -> bool { return getcf(); }
#[no_mangle]
pub unsafe extern "C" fn test_z() -> bool { return getzf(); }
#[no_mangle]
pub unsafe extern "C" fn test_s() -> bool { return getsf(); }
#[no_mangle]
pub unsafe extern "C" fn test_p() -> bool { return getpf(); }
#[no_mangle]
pub unsafe extern "C" fn test_be() -> bool { return 0 != getcf() as i32 || 0 != getzf() as i32; }
#[no_mangle]
pub unsafe extern "C" fn test_l() -> bool { return getsf() as i32 != getof() as i32; }
#[no_mangle]
pub unsafe extern "C" fn test_le() -> bool {
    return 0 != getzf() as i32 || getsf() as i32 != getof() as i32;
}
#[no_mangle]
pub unsafe extern "C" fn test_no() -> bool { return !test_o(); }
#[no_mangle]
pub unsafe extern "C" fn test_nb() -> bool { return !test_b(); }
#[no_mangle]
pub unsafe extern "C" fn test_nz() -> bool { return !test_z(); }
#[no_mangle]
pub unsafe extern "C" fn test_ns() -> bool { return !test_s(); }
#[no_mangle]
pub unsafe extern "C" fn test_np() -> bool { return !test_p(); }
#[no_mangle]
pub unsafe extern "C" fn test_nbe() -> bool { return !test_be(); }
#[no_mangle]
pub unsafe extern "C" fn test_nl() -> bool { return !test_l(); }
#[no_mangle]
pub unsafe extern "C" fn test_nle() -> bool { return !test_le(); }
#[no_mangle]
pub unsafe extern "C" fn jmp_rel16(mut rel16: i32) -> () {
    let mut cs_offset: i32 = get_seg_cs();
    c_comment!(("limit ip to 16 bit"));
    *instruction_pointer = cs_offset + (*instruction_pointer - cs_offset + rel16 & 65535i32);
}
#[no_mangle]
pub unsafe extern "C" fn jmpcc16(mut condition: bool, mut imm16: i32) -> () {
    if condition {
        jmp_rel16(imm16);
    };
}
#[no_mangle]
pub unsafe extern "C" fn jmpcc32(mut condition: bool, mut imm32: i32) -> () {
    if condition {
        *instruction_pointer += imm32
    };
}
#[no_mangle]
pub unsafe extern "C" fn loope16(mut imm8s: i32) -> () {
    jmpcc16(0 != decr_ecx_asize() && 0 != getzf() as i32, imm8s);
}
#[no_mangle]
pub unsafe extern "C" fn loopne16(mut imm8s: i32) -> () {
    jmpcc16(0 != decr_ecx_asize() && !getzf(), imm8s);
}
#[no_mangle]
pub unsafe extern "C" fn loop16(mut imm8s: i32) -> () { jmpcc16(0 != decr_ecx_asize(), imm8s); }
#[no_mangle]
pub unsafe extern "C" fn jcxz16(mut imm8s: i32) -> () {
    jmpcc16(get_reg_asize(ECX) == 0i32, imm8s);
}
#[no_mangle]
pub unsafe extern "C" fn loope32(mut imm8s: i32) -> () {
    jmpcc32(0 != decr_ecx_asize() && 0 != getzf() as i32, imm8s);
}
#[no_mangle]
pub unsafe extern "C" fn loopne32(mut imm8s: i32) -> () {
    jmpcc32(0 != decr_ecx_asize() && !getzf(), imm8s);
}
#[no_mangle]
pub unsafe extern "C" fn loop32(mut imm8s: i32) -> () { jmpcc32(0 != decr_ecx_asize(), imm8s); }
#[no_mangle]
pub unsafe extern "C" fn jcxz32(mut imm8s: i32) -> () {
    jmpcc32(get_reg_asize(ECX) == 0i32, imm8s);
}
#[no_mangle]
pub unsafe extern "C" fn cmovcc16(mut condition: bool, mut value: i32, mut r: i32) -> () {
    if condition {
        write_reg16(r, value);
    };
}
#[no_mangle]
pub unsafe extern "C" fn cmovcc32(mut condition: bool, mut value: i32, mut r: i32) -> () {
    if condition {
        write_reg32(r, value);
    };
}
#[no_mangle]
pub unsafe extern "C" fn get_stack_pointer(mut offset: i32) -> i32 {
    if *stack_size_32 {
        return get_seg_ss() + *reg32s.offset(ESP as isize) + offset;
    }
    else {
        return get_seg_ss() + (*reg16.offset(SP as isize) as i32 + offset & 65535i32);
    };
}
#[no_mangle]
pub unsafe extern "C" fn adjust_stack_reg(mut adjustment: i32) -> () {
    if *stack_size_32 {
        let ref mut fresh0 = *reg32s.offset(ESP as isize);
        *fresh0 += adjustment
    }
    else {
        let ref mut fresh1 = *reg16.offset(SP as isize);
        *fresh1 = (*fresh1 as i32 + adjustment) as u16
    };
}

#[no_mangle]
pub unsafe extern "C" fn push16_ss16(mut imm16: i32) -> Result<(), ()> {
    let mut sp: i32 = get_seg_ss() + (*reg16.offset(SP as isize) as i32 - 2i32 & 65535i32);
    safe_write16(sp, imm16)?;
    let ref mut fresh2 = *reg16.offset(SP as isize);
    *fresh2 = (*fresh2 as i32 + -2i32) as u16;
    Ok(())
}
#[no_mangle]
pub unsafe extern "C" fn push16_ss32(mut imm16: i32) -> Result<(), ()> {
    let mut sp: i32 = get_seg_ss() + *reg32s.offset(ESP as isize) - 2i32;
    safe_write16(sp, imm16)?;
    let ref mut fresh3 = *reg32s.offset(ESP as isize);
    *fresh3 += -2i32;
    Ok(())
}

#[no_mangle]
pub unsafe extern "C" fn push16_ss16_jit(mut imm16: i32) {
    return_on_pagefault!(push16_ss16(imm16))
}
#[no_mangle]
pub unsafe extern "C" fn push16_ss32_jit(mut imm16: i32) {
    return_on_pagefault!(push16_ss32(imm16))
}

#[no_mangle]
pub unsafe extern "C" fn push16_ss16_mem(mut addr: i32) -> Result<(), ()> {
    push16_ss16(safe_read16(addr)?)
}
#[no_mangle]
pub unsafe extern "C" fn push16_ss32_mem(mut addr: i32) -> Result<(), ()> {
    push16_ss32(safe_read16(addr)?)
}

#[no_mangle]
pub unsafe extern "C" fn push16_ss16_mem_jit(mut addr: i32) {
    return_on_pagefault!(push16_ss16(addr))
}
#[no_mangle]
pub unsafe extern "C" fn push16_ss32_mem_jit(mut addr: i32) {
    return_on_pagefault!(push16_ss32(addr))
}

#[no_mangle]
pub unsafe extern "C" fn push16(mut imm16: i32) -> Result<(), ()> {
    if *stack_size_32 {
        push16_ss32(imm16)
    }
    else {
        push16_ss16(imm16)
    }
}

#[no_mangle]
pub unsafe extern "C" fn push32_ss16(mut imm32: i32) -> Result<(), ()> {
    let mut new_sp: i32 = *reg16.offset(SP as isize) as i32 - 4i32 & 65535i32;
    safe_write32(get_seg_ss() + new_sp, imm32)?;
    *reg16.offset(SP as isize) = new_sp as u16;
    Ok(())
}
#[no_mangle]
pub unsafe extern "C" fn push32_ss32(mut imm32: i32) -> Result<(), ()> {
    let mut new_esp: i32 = *reg32s.offset(ESP as isize) - 4i32;
    safe_write32(get_seg_ss() + new_esp, imm32)?;
    *reg32s.offset(ESP as isize) = new_esp;
    Ok(())
}

#[no_mangle]
pub unsafe extern "C" fn push32_ss16_jit(mut imm32: i32) {
    return_on_pagefault!(push32_ss16(imm32))
}
#[no_mangle]
pub unsafe extern "C" fn push32_ss32_jit(mut imm32: i32) {
    return_on_pagefault!(push32_ss32(imm32))
}

#[no_mangle]
pub unsafe extern "C" fn push32_ss16_mem(mut addr: i32) -> Result<(), ()> {
    push32_ss16(safe_read32s(addr)?)
}
#[no_mangle]
pub unsafe extern "C" fn push32_ss32_mem(mut addr: i32) -> Result<(), ()> {
    push32_ss32(safe_read32s(addr)?)
}

#[no_mangle]
pub unsafe extern "C" fn push32_ss16_mem_jit(mut addr: i32) {
    return_on_pagefault!(push32_ss16_mem(addr))
}
#[no_mangle]
pub unsafe extern "C" fn push32_ss32_mem_jit(mut addr: i32) {
    return_on_pagefault!(push32_ss32_mem(addr))
}

#[no_mangle]
pub unsafe extern "C" fn push32(mut imm32: i32) -> Result<(), ()> {
    if *stack_size_32 {
        push32_ss32(imm32)
    }
    else {
        push32_ss16(imm32)
    }
}
#[no_mangle]
pub unsafe extern "C" fn pop16() -> Result<i32, ()> {
    if *stack_size_32 {
        pop16_ss32()
    }
    else {
        pop16_ss16()
    }
}
#[no_mangle]
pub unsafe extern "C" fn pop16_ss16() -> Result<i32, ()> {
    let mut sp: i32 = get_seg_ss() + *reg16.offset(SP as isize) as i32;
    let mut result: i32 = safe_read16(sp)?;
    let ref mut fresh4 = *reg16.offset(SP as isize);
    *fresh4 = (*fresh4 as i32 + 2i32) as u16;
    Ok(result)
}
#[no_mangle]
pub unsafe extern "C" fn pop16_ss32() -> Result<i32, ()> {
    let mut esp: i32 = get_seg_ss() + *reg32s.offset(ESP as isize);
    let mut result: i32 = safe_read16(esp)?;
    let ref mut fresh5 = *reg32s.offset(ESP as isize);
    *fresh5 += 2i32;
    Ok(result)
}
#[no_mangle]
pub unsafe extern "C" fn pop32s() -> Result<i32, ()> {
    if *stack_size_32 {
        pop32s_ss32()
    }
    else {
        pop32s_ss16()
    }
}
#[no_mangle]
pub unsafe extern "C" fn pop32s_ss16() -> Result<i32, ()> {
    let mut sp: i32 = *reg16.offset(SP as isize) as i32;
    let mut result: i32 = safe_read32s(get_seg_ss() + sp)?;
    *reg16.offset(SP as isize) = (sp + 4i32) as u16;
    Ok(result)
}
#[no_mangle]
pub unsafe extern "C" fn pop32s_ss32() -> Result<i32, ()> {
    let mut esp: i32 = *reg32s.offset(ESP as isize);
    let mut result: i32 = safe_read32s(get_seg_ss() + esp)?;
    *reg32s.offset(ESP as isize) = esp + 4i32;
    Ok(result)
}
#[no_mangle]
pub unsafe extern "C" fn pusha16() -> () {
    let mut temp: u16 = *reg16.offset(SP as isize);
    c_comment!(("make sure we don\'t get a pagefault after having"));
    c_comment!(("pushed several registers already"));
    return_on_pagefault!(writable_or_pagefault(get_stack_pointer(-16i32), 16i32));
    push16(*reg16.offset(AX as isize) as i32).unwrap();
    push16(*reg16.offset(CX as isize) as i32).unwrap();
    push16(*reg16.offset(DX as isize) as i32).unwrap();
    push16(*reg16.offset(BX as isize) as i32).unwrap();
    push16(temp as i32).unwrap();
    push16(*reg16.offset(BP as isize) as i32).unwrap();
    push16(*reg16.offset(SI as isize) as i32).unwrap();
    push16(*reg16.offset(DI as isize) as i32).unwrap();
}
#[no_mangle]
pub unsafe extern "C" fn pusha32() -> () {
    let mut temp: i32 = *reg32s.offset(ESP as isize);
    return_on_pagefault!(writable_or_pagefault(get_stack_pointer(-32i32), 32i32));
    push32(*reg32s.offset(EAX as isize)).unwrap();
    push32(*reg32s.offset(ECX as isize)).unwrap();
    push32(*reg32s.offset(EDX as isize)).unwrap();
    push32(*reg32s.offset(EBX as isize)).unwrap();
    push32(temp).unwrap();
    push32(*reg32s.offset(EBP as isize)).unwrap();
    push32(*reg32s.offset(ESI as isize)).unwrap();
    push32(*reg32s.offset(EDI as isize)).unwrap();
}
#[no_mangle]
pub unsafe extern "C" fn setcc_reg(mut condition: bool, mut r: i32) -> () {
    write_reg8(r, if 0 != condition as i32 { 1i32 } else { 0i32 });
}
#[no_mangle]
pub unsafe extern "C" fn setcc_mem(mut condition: bool, mut addr: i32) -> () {
    return_on_pagefault!(safe_write8(
        addr,
        if 0 != condition as i32 { 1i32 } else { 0i32 }
    ));
}
#[no_mangle]
pub unsafe extern "C" fn fxsave(mut addr: u32) -> () {
    return_on_pagefault!(writable_or_pagefault(addr as i32, 512i32));
    safe_write16(addr.wrapping_add(0i32 as u32) as i32, *fpu_control_word).unwrap();
    safe_write16(
        addr.wrapping_add(2i32 as u32) as i32,
        fpu_load_status_word(),
    ).unwrap();
    safe_write8(
        addr.wrapping_add(4i32 as u32) as i32,
        !*fpu_stack_empty & 255i32,
    ).unwrap();
    safe_write16(addr.wrapping_add(6i32 as u32) as i32, *fpu_opcode).unwrap();
    safe_write32(addr.wrapping_add(8i32 as u32) as i32, *fpu_ip).unwrap();
    safe_write16(addr.wrapping_add(12i32 as u32) as i32, *fpu_ip_selector).unwrap();
    safe_write32(addr.wrapping_add(16i32 as u32) as i32, *fpu_dp).unwrap();
    safe_write16(addr.wrapping_add(20i32 as u32) as i32, *fpu_dp_selector).unwrap();
    safe_write32(addr.wrapping_add(24i32 as u32) as i32, *mxcsr).unwrap();
    safe_write32(addr.wrapping_add(28i32 as u32) as i32, MXCSR_MASK).unwrap();
    let mut i: i32 = 0i32;
    while i < 8i32 {
        fpu_store_m80(
            addr.wrapping_add(32i32 as u32)
                .wrapping_add((i << 4i32) as u32),
            *fpu_st.offset(((*fpu_stack_ptr).wrapping_add(i as u32) & 7i32 as u32) as isize),
        );
        i += 1
    }
    c_comment!(("If the OSFXSR bit in control register CR4 is not set, the FXSAVE"));
    c_comment!(("instruction may not save these registers. This behavior is"));
    c_comment!(("implementation dependent."));
    let mut i_0: i32 = 0i32;
    while i_0 < 8i32 {
        safe_write128(
            addr.wrapping_add(160i32 as u32)
                .wrapping_add((i_0 << 4i32) as u32) as i32,
            *reg_xmm.offset(i_0 as isize),
        ).unwrap();
        i_0 += 1
    }
}
#[no_mangle]
pub unsafe extern "C" fn fxrstor(mut addr: u32) -> () {
    // TODO: Add readable_or_pagefault
    return_on_pagefault!(translate_address_read(addr as i32));
    return_on_pagefault!(translate_address_read(
        addr.wrapping_add(511i32 as u32) as i32
    ));
    let mut new_mxcsr: i32 = safe_read32s(addr.wrapping_add(24i32 as u32) as i32).unwrap();
    if 0 != new_mxcsr & !MXCSR_MASK {
        dbg_log_c!("#gp Invalid mxcsr bits");
        trigger_gp_non_raising(0i32);
        return;
    }
    else {
        *fpu_control_word = safe_read16(addr.wrapping_add(0i32 as u32) as i32).unwrap();
        fpu_set_status_word(safe_read16(addr.wrapping_add(2i32 as u32) as i32).unwrap());
        *fpu_stack_empty = !safe_read8(addr.wrapping_add(4i32 as u32) as i32).unwrap() & 255i32;
        *fpu_opcode = safe_read16(addr.wrapping_add(6i32 as u32) as i32).unwrap();
        *fpu_ip = safe_read32s(addr.wrapping_add(8i32 as u32) as i32).unwrap();
        *fpu_ip = safe_read16(addr.wrapping_add(12i32 as u32) as i32).unwrap();
        *fpu_dp = safe_read32s(addr.wrapping_add(16i32 as u32) as i32).unwrap();
        *fpu_dp_selector = safe_read16(addr.wrapping_add(20i32 as u32) as i32).unwrap();
        *mxcsr = new_mxcsr;
        let mut i: i32 = 0i32;
        while i < 8i32 {
            *fpu_st.offset(((*fpu_stack_ptr).wrapping_add(i as u32) & 7i32 as u32) as isize) =
                fpu_load_m80(
                    addr.wrapping_add(32i32 as u32)
                        .wrapping_add((i << 4i32) as u32),
                ).unwrap();
            i += 1
        }
        let mut i_0: i32 = 0i32;
        while i_0 < 8i32 {
            (*reg_xmm.offset(i_0 as isize)).u32_0[0usize] = safe_read32s(
                addr.wrapping_add(160i32 as u32)
                    .wrapping_add((i_0 << 4i32) as u32)
                    .wrapping_add(0i32 as u32) as i32,
            ).unwrap() as u32;
            (*reg_xmm.offset(i_0 as isize)).u32_0[1usize] = safe_read32s(
                addr.wrapping_add(160i32 as u32)
                    .wrapping_add((i_0 << 4i32) as u32)
                    .wrapping_add(4i32 as u32) as i32,
            ).unwrap() as u32;
            (*reg_xmm.offset(i_0 as isize)).u32_0[2usize] = safe_read32s(
                addr.wrapping_add(160i32 as u32)
                    .wrapping_add((i_0 << 4i32) as u32)
                    .wrapping_add(8i32 as u32) as i32,
            ).unwrap() as u32;
            (*reg_xmm.offset(i_0 as isize)).u32_0[3usize] = safe_read32s(
                addr.wrapping_add(160i32 as u32)
                    .wrapping_add((i_0 << 4i32) as u32)
                    .wrapping_add(12i32 as u32) as i32,
            ).unwrap() as u32;
            i_0 += 1
        }
        return;
    };
}
#[no_mangle]
pub unsafe extern "C" fn xchg8(mut data: i32, mut r8: i32) -> i32 {
    let mut tmp: i32 = *reg8.offset(r8 as isize) as i32;
    *reg8.offset(r8 as isize) = data as u8;
    return tmp;
}
#[no_mangle]
pub unsafe extern "C" fn xchg16(mut data: i32, mut r16: i32) -> i32 {
    let mut tmp: i32 = *reg16.offset(r16 as isize) as i32;
    *reg16.offset(r16 as isize) = data as u16;
    return tmp;
}
#[no_mangle]
pub unsafe extern "C" fn xchg16r(mut r16: i32) -> () {
    let mut tmp: i32 = *reg16.offset(AX as isize) as i32;
    *reg16.offset(AX as isize) = *reg16.offset(r16 as isize);
    *reg16.offset(r16 as isize) = tmp as u16;
}
#[no_mangle]
pub unsafe extern "C" fn xchg32(mut data: i32, mut r32: i32) -> i32 {
    let mut tmp: i32 = *reg32s.offset(r32 as isize);
    *reg32s.offset(r32 as isize) = data;
    return tmp;
}
#[no_mangle]
pub unsafe extern "C" fn xchg32r(mut r32: i32) -> () {
    let mut tmp: i32 = *reg32s.offset(EAX as isize);
    *reg32s.offset(EAX as isize) = *reg32s.offset(r32 as isize);
    *reg32s.offset(r32 as isize) = tmp;
}
