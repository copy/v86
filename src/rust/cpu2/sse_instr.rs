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
    fn isnan_XXX(f: f64) -> bool;
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
    fn read_mmx64s(r: i32) -> reg64;
    #[no_mangle]
    fn write_mmx64(r: i32, low: i32, high: i32) -> ();
    #[no_mangle]
    fn write_mmx_reg64(r: i32, data: reg64) -> ();
    #[no_mangle]
    fn read_xmm64s(r: i32) -> reg64;
    #[no_mangle]
    fn read_xmm128s(r: i32) -> reg128;
    #[no_mangle]
    fn write_xmm128(r: i32, i0: i32, i1: i32, i2: i32, i3: i32) -> ();
    #[no_mangle]
    fn write_xmm_reg128(r: i32, data: reg128) -> ();
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
pub unsafe extern "C" fn mov_r_m64(mut addr: i32, mut r: i32) -> () {
    c_comment!(("mov* m64, mm"));
    let mut data: reg64 = read_mmx64s(r);
    return_on_pagefault!(safe_write64(addr, data.u64_0[0usize] as i64));
}
#[no_mangle]
pub unsafe extern "C" fn movl_r128_m64(mut addr: i32, mut r: i32) -> () {
    c_comment!(("mov* m64, xmm"));
    let mut data: reg64 = read_xmm64s(r);
    return_on_pagefault!(safe_write64(addr, data.u64_0[0usize] as i64));
}
#[no_mangle]
pub unsafe extern "C" fn mov_r_r128(mut r1: i32, mut r2: i32) -> () {
    c_comment!(("mov* xmm, xmm"));
    let mut data: reg128 = read_xmm128s(r2);
    write_xmm_reg128(r1, data);
}
#[no_mangle]
pub unsafe extern "C" fn mov_r_m128(mut addr: i32, mut r: i32) -> () {
    c_comment!(("mov* m128, xmm"));
    let mut data: reg128 = read_xmm128s(r);
    return_on_pagefault!(safe_write128(addr, data));
}
#[no_mangle]
pub unsafe extern "C" fn mov_rm_r128(mut source: reg128, mut r: i32) -> () {
    c_comment!(("mov* xmm, xmm/m128"));
    write_xmm_reg128(r, source);
}
#[no_mangle]
pub unsafe extern "C" fn movh_m64_r128(mut addr: i32, mut r: i32) -> () {
    c_comment!(("movhp* xmm, m64"));
    let mut data: reg64 = return_on_pagefault!(safe_read64s(addr));
    let mut orig: reg128 = read_xmm128s(r);
    write_xmm128(
        r,
        orig.u32_0[0usize] as i32,
        orig.u32_0[1usize] as i32,
        data.u32_0[0usize] as i32,
        data.u32_0[1usize] as i32,
    );
}
#[no_mangle]
pub unsafe extern "C" fn movh_r128_m64(mut addr: i32, mut r: i32) -> () {
    c_comment!(("movhp* m64, xmm"));
    let mut data: reg128 = read_xmm128s(r);
    return_on_pagefault!(safe_write64(addr, data.u64_0[1usize] as i64));
}
#[no_mangle]
pub unsafe extern "C" fn pand_r128(mut source: reg128, mut r: i32) -> () {
    c_comment!(("pand xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 {
        i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    };
    result.u64_0[0usize] = source.u64_0[0usize] & destination.u64_0[0usize];
    result.u64_0[1usize] = source.u64_0[1usize] & destination.u64_0[1usize];
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe extern "C" fn pandn_r128(mut source: reg128, mut r: i32) -> () {
    c_comment!(("pandn xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 {
        i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    };
    result.u64_0[0usize] = source.u64_0[0usize] & !destination.u64_0[0usize];
    result.u64_0[1usize] = source.u64_0[1usize] & !destination.u64_0[1usize];
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe extern "C" fn pxor_r128(mut source: reg128, mut r: i32) -> () {
    c_comment!(("pxor xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 {
        i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    };
    result.u64_0[0usize] = source.u64_0[0usize] ^ destination.u64_0[0usize];
    result.u64_0[1usize] = source.u64_0[1usize] ^ destination.u64_0[1usize];
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe extern "C" fn por_r128(mut source: reg128, mut r: i32) -> () {
    c_comment!(("por xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 {
        i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    };
    result.u64_0[0usize] = source.u64_0[0usize] | destination.u64_0[0usize];
    result.u64_0[1usize] = source.u64_0[1usize] | destination.u64_0[1usize];
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe extern "C" fn psrlw_r64(mut r: i32, mut shift: u32) -> () {
    c_comment!(("psrlw mm, {shift}"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut dword0: i32 = 0i32;
    let mut dword1: i32 = 0i32;
    if shift <= 15i32 as u32 {
        dword0 = destination.u16_0[0usize] as i32 >> shift
            | destination.u16_0[1usize] as i32 >> shift << 16i32;
        dword1 = destination.u16_0[2usize] as i32 >> shift
            | destination.u16_0[3usize] as i32 >> shift << 16i32
    }
    write_mmx64(r, dword0, dword1);
}
#[no_mangle]
pub unsafe extern "C" fn psraw_r64(mut r: i32, mut shift: u32) -> () {
    c_comment!(("psraw mm, {shift}"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut shift_clamped: i32 = (if shift > 15i32 as u32 {
        16i32 as u32
    }
    else {
        shift
    }) as i32;
    let mut dword0: i32 = destination.i16_0[0usize] as i32 >> shift_clamped & 65535i32
        | destination.i16_0[1usize] as i32 >> shift_clamped << 16i32;
    let mut dword1: i32 = destination.i16_0[2usize] as i32 >> shift_clamped & 65535i32
        | destination.i16_0[3usize] as i32 >> shift_clamped << 16i32;
    write_mmx64(r, dword0, dword1);
}
#[no_mangle]
pub unsafe extern "C" fn psllw_r64(mut r: i32, mut shift: u32) -> () {
    c_comment!(("psllw mm, {shift}"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut dword0: i32 = 0i32;
    let mut dword1: i32 = 0i32;
    if shift <= 15i32 as u32 {
        dword0 = (destination.u16_0[0usize] as i32) << shift & 65535i32
            | (destination.u16_0[1usize] as i32) << shift << 16i32;
        dword1 = (destination.u16_0[2usize] as i32) << shift & 65535i32
            | (destination.u16_0[3usize] as i32) << shift << 16i32
    }
    write_mmx64(r, dword0, dword1);
}
#[no_mangle]
pub unsafe extern "C" fn psrld_r64(mut r: i32, mut shift: u32) -> () {
    c_comment!(("psrld mm, {shift}"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut dword0: i32 = 0i32;
    let mut dword1: i32 = 0i32;
    if shift <= 31i32 as u32 {
        dword0 = (destination.u32_0[0usize] >> shift) as i32;
        dword1 = (destination.u32_0[1usize] >> shift) as i32
    }
    write_mmx64(r, dword0, dword1);
}
#[no_mangle]
pub unsafe extern "C" fn psrad_r64(mut r: i32, mut shift: u32) -> () {
    c_comment!(("psrad mm, {shift}"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut shift_clamped: i32 = (if shift > 31i32 as u32 {
        31i32 as u32
    }
    else {
        shift
    }) as i32;
    let mut dword0: i32 = destination.i32_0[0usize] >> shift_clamped;
    let mut dword1: i32 = destination.i32_0[1usize] >> shift_clamped;
    write_mmx64(r, dword0, dword1);
}
#[no_mangle]
pub unsafe extern "C" fn pslld_r64(mut r: i32, mut shift: u32) -> () {
    c_comment!(("pslld mm, {shift}"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut dword0: i32 = 0i32;
    let mut dword1: i32 = 0i32;
    if shift <= 31i32 as u32 {
        dword0 = destination.i32_0[0usize] << shift;
        dword1 = destination.i32_0[1usize] << shift
    }
    write_mmx64(r, dword0, dword1);
}
#[no_mangle]
pub unsafe extern "C" fn psrlq_r64(mut r: i32, mut shift: u32) -> () {
    c_comment!(("psrlq mm, {shift}"));
    if shift == 0i32 as u32 {
        return;
    }
    else {
        let mut destination: reg64 = read_mmx64s(r);
        let mut result: reg64 = reg64 {
            i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0],
        };
        if shift <= 63i32 as u32 {
            result.u64_0[0usize] = destination.u64_0[0usize] >> shift
        }
        write_mmx_reg64(r, result);
        return;
    };
}
#[no_mangle]
pub unsafe extern "C" fn psllq_r64(mut r: i32, mut shift: u32) -> () {
    c_comment!(("psllq mm, {shift}"));
    let mut destination: reg64 = read_mmx64s(r);
    if shift == 0i32 as u32 {
        return;
    }
    else {
        let mut result: reg64 = reg64 {
            i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0],
        };
        if shift <= 63i32 as u32 {
            result.u64_0[0usize] = destination.u64_0[0usize] << shift
        }
        write_mmx_reg64(r, result);
        return;
    };
}
#[no_mangle]
pub unsafe extern "C" fn psrlw_r128(mut r: i32, mut shift: u32) -> () {
    c_comment!(("psrlw xmm, {shift}"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut dword0: i32 = 0i32;
    let mut dword1: i32 = 0i32;
    let mut dword2: i32 = 0i32;
    let mut dword3: i32 = 0i32;
    if shift <= 15i32 as u32 {
        dword0 = destination.u16_0[0usize] as i32 >> shift
            | destination.u16_0[1usize] as i32 >> shift << 16i32;
        dword1 = destination.u16_0[2usize] as i32 >> shift
            | destination.u16_0[3usize] as i32 >> shift << 16i32;
        dword2 = destination.u16_0[4usize] as i32 >> shift
            | destination.u16_0[5usize] as i32 >> shift << 16i32;
        dword3 = destination.u16_0[6usize] as i32 >> shift
            | destination.u16_0[7usize] as i32 >> shift << 16i32
    }
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
#[no_mangle]
pub unsafe extern "C" fn psraw_r128(mut r: i32, mut shift: u32) -> () {
    c_comment!(("psraw xmm, {shift}"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut shift_clamped: i32 = (if shift > 15i32 as u32 {
        16i32 as u32
    }
    else {
        shift
    }) as i32;
    let mut dword0: i32 = destination.i16_0[0usize] as i32 >> shift_clamped & 65535i32
        | destination.i16_0[1usize] as i32 >> shift_clamped << 16i32;
    let mut dword1: i32 = destination.i16_0[2usize] as i32 >> shift_clamped & 65535i32
        | destination.i16_0[3usize] as i32 >> shift_clamped << 16i32;
    let mut dword2: i32 = destination.i16_0[4usize] as i32 >> shift_clamped & 65535i32
        | destination.i16_0[5usize] as i32 >> shift_clamped << 16i32;
    let mut dword3: i32 = destination.i16_0[6usize] as i32 >> shift_clamped & 65535i32
        | destination.i16_0[7usize] as i32 >> shift_clamped << 16i32;
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
#[no_mangle]
pub unsafe extern "C" fn psllw_r128(mut r: i32, mut shift: u32) -> () {
    c_comment!(("psllw xmm, {shift}"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut dword0: i32 = 0i32;
    let mut dword1: i32 = 0i32;
    let mut dword2: i32 = 0i32;
    let mut dword3: i32 = 0i32;
    if shift <= 15i32 as u32 {
        dword0 = (destination.u16_0[0usize] as i32) << shift & 65535i32
            | (destination.u16_0[1usize] as i32) << shift << 16i32;
        dword1 = (destination.u16_0[2usize] as i32) << shift & 65535i32
            | (destination.u16_0[3usize] as i32) << shift << 16i32;
        dword2 = (destination.u16_0[4usize] as i32) << shift & 65535i32
            | (destination.u16_0[5usize] as i32) << shift << 16i32;
        dword3 = (destination.u16_0[6usize] as i32) << shift & 65535i32
            | (destination.u16_0[7usize] as i32) << shift << 16i32
    }
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
#[no_mangle]
pub unsafe extern "C" fn psrld_r128(mut r: i32, mut shift: u32) -> () {
    c_comment!(("psrld xmm, {shift}"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut dword0: i32 = 0i32;
    let mut dword1: i32 = 0i32;
    let mut dword2: i32 = 0i32;
    let mut dword3: i32 = 0i32;
    if shift <= 31i32 as u32 {
        dword0 = (destination.u32_0[0usize] >> shift) as i32;
        dword1 = (destination.u32_0[1usize] >> shift) as i32;
        dword2 = (destination.u32_0[2usize] >> shift) as i32;
        dword3 = (destination.u32_0[3usize] >> shift) as i32
    }
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
#[no_mangle]
pub unsafe extern "C" fn psrad_r128(mut r: i32, mut shift: u32) -> () {
    c_comment!(("psrad xmm, {shift}"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut shift_clamped: i32 = (if shift > 31i32 as u32 {
        31i32 as u32
    }
    else {
        shift
    }) as i32;
    let mut dword0: i32 = destination.i32_0[0usize] >> shift_clamped;
    let mut dword1: i32 = destination.i32_0[1usize] >> shift_clamped;
    let mut dword2: i32 = destination.i32_0[2usize] >> shift_clamped;
    let mut dword3: i32 = destination.i32_0[3usize] >> shift_clamped;
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
#[no_mangle]
pub unsafe extern "C" fn pslld_r128(mut r: i32, mut shift: u32) -> () {
    c_comment!(("pslld xmm, {shift}"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut dword0: i32 = 0i32;
    let mut dword1: i32 = 0i32;
    let mut dword2: i32 = 0i32;
    let mut dword3: i32 = 0i32;
    if shift <= 31i32 as u32 {
        dword0 = destination.i32_0[0usize] << shift;
        dword1 = destination.i32_0[1usize] << shift;
        dword2 = destination.i32_0[2usize] << shift;
        dword3 = destination.i32_0[3usize] << shift
    }
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
#[no_mangle]
pub unsafe extern "C" fn psrlq_r128(mut r: i32, mut shift: u32) -> () {
    c_comment!(("psrlq xmm, {shift}"));
    if shift == 0i32 as u32 {
        return;
    }
    else {
        let mut destination: reg128 = read_xmm128s(r);
        let mut result: reg128 = reg128 {
            i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        };
        if shift <= 63i32 as u32 {
            result.u64_0[0usize] = destination.u64_0[0usize] >> shift;
            result.u64_0[1usize] = destination.u64_0[1usize] >> shift
        }
        write_xmm_reg128(r, result);
        return;
    };
}
#[no_mangle]
pub unsafe extern "C" fn psllq_r128(mut r: i32, mut shift: u32) -> () {
    c_comment!(("psllq xmm, {shift}"));
    let mut destination: reg128 = read_xmm128s(r);
    if shift == 0i32 as u32 {
        return;
    }
    else {
        let mut result: reg128 = reg128 {
            i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        };
        if shift <= 63i32 as u32 {
            result.u64_0[0usize] = destination.u64_0[0usize] << shift;
            result.u64_0[1usize] = destination.u64_0[1usize] << shift
        }
        write_xmm_reg128(r, result);
        return;
    };
}
#[no_mangle]
pub unsafe extern "C" fn sse_comparison(mut op: i32, mut x: f64, mut y: f64) -> bool {
    c_comment!(("TODO: Signaling"));
    match op & 7i32 {
        0 => return x == y,
        1 => return x < y,
        2 => return x <= y,
        3 => return 0 != isnan_XXX(x) as i32 || 0 != isnan_XXX(y) as i32,
        4 => return x != y || 0 != isnan_XXX(x) as i32 || 0 != isnan_XXX(y) as i32,
        5 => return x >= y || 0 != isnan_XXX(x) as i32 || 0 != isnan_XXX(y) as i32,
        6 => return x > y || 0 != isnan_XXX(x) as i32 || 0 != isnan_XXX(y) as i32,
        7 => return !isnan_XXX(x) && !isnan_XXX(y),
        _ => {
            dbg_assert!(0 != 0i32);
            return 0 != 0i32;
        },
    };
}
#[no_mangle]
pub unsafe extern "C" fn sse_min(mut x: f64, mut y: f64) -> f64 {
    c_comment!(("if both x and y are 0 or x is nan, y is returned"));
    return if x < y { x } else { y };
}
#[no_mangle]
pub unsafe extern "C" fn sse_max(mut x: f64, mut y: f64) -> f64 {
    c_comment!(("if both x and y are 0 or x is nan, y is returned"));
    return if x > y { x } else { y };
}
#[no_mangle]
pub unsafe extern "C" fn sse_convert_f64_to_i32(mut x: f64) -> i32 {
    c_comment!(("TODO: Rounding modes"));
    if x >= 2147483648u32.wrapping_neg() as f64 && x < 2147483648u32 as f64 {
        return x as i64 as i32;
    }
    else {
        c_comment!(("TODO: Signal"));
        return 2147483648u32.wrapping_neg() as i32;
    };
}
