#![allow
( dead_code , mutable_transmutes , non_camel_case_types , non_snake_case ,
non_upper_case_globals , unused_mut )]
#![feature ( extern_types , libc )]

extern "C" {

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
}
pub const S_SAFE_WRITE32_SLOW_NOT_VALID: stat_name = 22;
pub const S_SAFE_WRITE32_SLOW_NOT_USER: stat_name = 23;

pub const S_CYCLE_INTERNAL: stat_name = 29;
pub const S_COMPILE: stat_name = 0;

pub const S_RUN_INTERPRETED_PENDING: stat_name = 8;
pub const S_TRIGGER_CPU_EXCEPTION: stat_name = 14;
pub const S_TLB_GLOBAL_FULL: stat_name = 36;
pub const S_SAFE_READ32_FAST: stat_name = 15;
pub const S_SAFE_READ32_SLOW_PAGE_CROSSED: stat_name = 16;
pub const S_INVALIDATE_PAGE: stat_name = 30;
pub const S_SAFE_READ32_SLOW_NOT_VALID: stat_name = 17;
pub const S_COMPILE_SUCCESS: stat_name = 1;
pub const S_COMPILE_ENTRY_POINT: stat_name = 5;
pub const S_SAFE_WRITE32_FAST: stat_name = 20;
pub const S_DO_RUN: stat_name = 27;
pub const S_SAFE_WRITE32_SLOW_HAS_CODE: stat_name = 26;
pub const S_CLEAR_TLB: stat_name = 33;
pub const S_RUN_FROM_CACHE_STEPS: stat_name = 13;
pub const S_CACHE_MISMATCH: stat_name = 6;
pub const S_RUN_INTERPRETED_DIFFERENT_STATE: stat_name = 10;
pub const S_RUN_INTERPRETED_NEAR_END_OF_PAGE: stat_name = 9;
pub const S_COMPILE_WITH_LOOP_SAFETY: stat_name = 3;
pub const S_COMPILE_CUT_OFF_AT_END_OF_PAGE: stat_name = 2;
#[derive(Copy, Clone)]
#[repr(C)]
pub struct profiler_stat {
    pub count: i32,
}
pub const S_COMPILE_BASIC_BLOCK: stat_name = 4;
pub const S_SAFE_WRITE32_SLOW_READ_ONLY: stat_name = 25;
pub const S_INVALIDATE_CACHE_ENTRY: stat_name = 31;

pub const S_RUN_INTERPRETED_STEPS: stat_name = 11;
pub const S_FULL_CLEAR_TLB: stat_name = 34;
pub type stat_name = u32;
pub const S_TLB_FULL: stat_name = 35;
pub const S_DO_MANY_CYCLES: stat_name = 28;
pub const S_SAFE_WRITE32_SLOW_PAGE_CROSSED: stat_name = 21;
pub const S_SAFE_READ32_SLOW_IN_MAPPED_RANGE: stat_name = 19;
pub const S_RUN_INTERPRETED: stat_name = 7;
pub const S_RUN_FROM_CACHE: stat_name = 12;
pub const S_SAFE_READ32_SLOW_NOT_USER: stat_name = 18;
pub const S_SAFE_WRITE32_SLOW_IN_MAPPED_RANGE: stat_name = 24;
pub const S_NONFAULTING_OPTIMIZATION: stat_name = 32;
#[no_mangle]
pub static mut profiler_stat_arr: [profiler_stat; 37] = unsafe {
    [
        profiler_stat { count: 0i32 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
        profiler_stat { count: 0 },
    ]
};
#[no_mangle]
pub unsafe extern "C" fn profiler_init() -> () {
    let mut i: u32 = 0i32 as u32;
    while i < (S_TLB_GLOBAL_FULL as i32 - S_COMPILE as i32 + 1i32) as u32 {
        profiler_stat_arr[i as usize].count = 0i32;
        i = i.wrapping_add(1)
    }
}
#[no_mangle]
pub unsafe extern "C" fn profiler_stat_increment(mut stat: stat_name) -> () {
    profiler_stat_increment_by(stat, 1i32);
}
#[no_mangle]
pub unsafe extern "C" fn profiler_stat_increment_by(mut stat: stat_name, mut by: i32) -> () {
    profiler_stat_arr[stat as usize].count += by;
}
#[no_mangle]
pub unsafe extern "C" fn profiler_stat_get(mut stat: stat_name) -> i32 {
    return profiler_stat_arr[stat as usize].count;
}
#[no_mangle]
pub unsafe extern "C" fn profiler_stat_increment_do_run() -> () {
    profiler_stat_increment(S_DO_RUN);
}
