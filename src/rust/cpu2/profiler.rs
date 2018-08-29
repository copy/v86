#![allow(unused_mut)]

pub const S_SAFE_WRITE32_SLOW_NOT_VALID: StatName = 22;
pub const S_SAFE_WRITE32_SLOW_NOT_USER: StatName = 23;

pub const S_CYCLE_INTERNAL: StatName = 29;
pub const S_COMPILE: StatName = 0;

pub const S_RUN_INTERPRETED_PENDING: StatName = 8;
pub const S_TRIGGER_CPU_EXCEPTION: StatName = 14;
pub const S_TLB_GLOBAL_FULL: StatName = 36;
pub const S_SAFE_READ32_FAST: StatName = 15;
pub const S_SAFE_READ32_SLOW_PAGE_CROSSED: StatName = 16;
pub const S_INVALIDATE_PAGE: StatName = 30;
pub const S_SAFE_READ32_SLOW_NOT_VALID: StatName = 17;
pub const S_COMPILE_SUCCESS: StatName = 1;
pub const S_COMPILE_ENTRY_POINT: StatName = 5;
pub const S_SAFE_WRITE32_FAST: StatName = 20;
pub const S_DO_RUN: StatName = 27;
pub const S_SAFE_WRITE32_SLOW_HAS_CODE: StatName = 26;
pub const S_CLEAR_TLB: StatName = 33;
pub const S_RUN_FROM_CACHE_STEPS: StatName = 13;
pub const S_CACHE_MISMATCH: StatName = 6;
pub const S_RUN_INTERPRETED_DIFFERENT_STATE: StatName = 10;
pub const S_RUN_INTERPRETED_NEAR_END_OF_PAGE: StatName = 9;
pub const S_COMPILE_WITH_LOOP_SAFETY: StatName = 3;
pub const S_COMPILE_CUT_OFF_AT_END_OF_PAGE: StatName = 2;
#[derive(Copy, Clone)]
#[repr(C)]
pub struct profiler_stat {
    pub count: i32,
}
pub const S_COMPILE_BASIC_BLOCK: StatName = 4;
pub const S_SAFE_WRITE32_SLOW_READ_ONLY: StatName = 25;
pub const S_INVALIDATE_CACHE_ENTRY: StatName = 31;

pub const S_RUN_INTERPRETED_STEPS: StatName = 11;
pub const S_FULL_CLEAR_TLB: StatName = 34;
pub type StatName = u32;
pub const S_TLB_FULL: StatName = 35;
pub const S_DO_MANY_CYCLES: StatName = 28;
pub const S_SAFE_WRITE32_SLOW_PAGE_CROSSED: StatName = 21;
pub const S_SAFE_READ32_SLOW_IN_MAPPED_RANGE: StatName = 19;
pub const S_RUN_INTERPRETED: StatName = 7;
pub const S_RUN_FROM_CACHE: StatName = 12;
pub const S_SAFE_READ32_SLOW_NOT_USER: StatName = 18;
pub const S_SAFE_WRITE32_SLOW_IN_MAPPED_RANGE: StatName = 24;
pub const S_NONFAULTING_OPTIMIZATION: StatName = 32;
#[no_mangle]
pub static mut profiler_stat_arr: [profiler_stat; 37] = [
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
];
#[no_mangle]
pub unsafe fn profiler_init() -> () {
    let mut i: u32 = 0i32 as u32;
    while i < (S_TLB_GLOBAL_FULL as i32 - S_COMPILE as i32 + 1i32) as u32 {
        profiler_stat_arr[i as usize].count = 0i32;
        i = i.wrapping_add(1)
    }
}
#[no_mangle]
pub unsafe fn profiler_stat_increment(mut stat: StatName) -> () {
    profiler_stat_increment_by(stat, 1i32);
}
#[no_mangle]
pub unsafe fn profiler_stat_increment_by(mut stat: StatName, mut by: i32) -> () {
    if cfg!(feature = "profiler") {
        profiler_stat_arr[stat as usize].count += by;
    }
}
#[no_mangle]
pub unsafe fn profiler_stat_get(mut stat: StatName) -> i32 {
    if cfg!(feature = "profiler") {
        profiler_stat_arr[stat as usize].count
    }
    else {
        0
    }
}
#[no_mangle]
pub unsafe fn profiler_stat_increment_do_run() -> () { profiler_stat_increment(S_DO_RUN); }
