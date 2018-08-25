#![allow(
    dead_code,
    mutable_transmutes,
    non_camel_case_types,
    non_snake_case,
    non_upper_case_globals,
    unused_mut
)]

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
pub unsafe fn profiler_init() -> () {
    let mut i: u32 = 0i32 as u32;
    while i < (S_TLB_GLOBAL_FULL as i32 - S_COMPILE as i32 + 1i32) as u32 {
        profiler_stat_arr[i as usize].count = 0i32;
        i = i.wrapping_add(1)
    }
}
#[no_mangle]
pub unsafe fn profiler_stat_increment(mut stat: stat_name) -> () {
    profiler_stat_increment_by(stat, 1i32);
}
#[no_mangle]
pub unsafe fn profiler_stat_increment_by(mut stat: stat_name, mut by: i32) -> () {
    if cfg!(feature = "profiler") {
        profiler_stat_arr[stat as usize].count += by;
    }
}
#[no_mangle]
pub unsafe fn profiler_stat_get(mut stat: stat_name) -> i32 {
    if cfg!(feature = "profiler") {
        profiler_stat_arr[stat as usize].count
    }
    else {
        0
    }
}
#[no_mangle]
pub unsafe fn profiler_stat_increment_do_run() -> () { profiler_stat_increment(S_DO_RUN); }
