#[allow(dead_code, non_camel_case_types)]
pub enum stat {
    S_COMPILE,
    S_COMPILE_SUCCESS,
    S_COMPILE_CUT_OFF_AT_END_OF_PAGE,
    S_COMPILE_WITH_LOOP_SAFETY,
    S_COMPILE_BASIC_BLOCK,
    S_COMPILE_ENTRY_POINT,
    S_CACHE_MISMATCH,

    S_RUN_INTERPRETED,
    S_RUN_INTERPRETED_PENDING,
    S_RUN_INTERPRETED_NEAR_END_OF_PAGE,
    S_RUN_INTERPRETED_DIFFERENT_STATE,
    S_RUN_INTERPRETED_MISSED_COMPILED_ENTRY,
    S_RUN_INTERPRETED_STEPS,

    S_RUN_FROM_CACHE,
    S_RUN_FROM_CACHE_STEPS,

    S_TRIGGER_CPU_EXCEPTION,

    S_SAFE_READ32_FAST,
    S_SAFE_READ32_SLOW_PAGE_CROSSED,
    S_SAFE_READ32_SLOW_NOT_VALID,
    S_SAFE_READ32_SLOW_NOT_USER,
    S_SAFE_READ32_SLOW_IN_MAPPED_RANGE,

    S_SAFE_WRITE32_FAST,
    S_SAFE_WRITE32_SLOW_PAGE_CROSSED,
    S_SAFE_WRITE32_SLOW_NOT_VALID,
    S_SAFE_WRITE32_SLOW_NOT_USER,
    S_SAFE_WRITE32_SLOW_IN_MAPPED_RANGE,
    S_SAFE_WRITE32_SLOW_READ_ONLY,
    S_SAFE_WRITE32_SLOW_HAS_CODE,

    S_DO_RUN,
    S_DO_MANY_CYCLES,
    S_CYCLE_INTERNAL,

    S_INVALIDATE_PAGE,
    S_INVALIDATE_MODULE,
    S_INVALIDATE_CACHE_ENTRY,

    S_INVALIDATE_MODULE_CACHE_FULL,
    S_INVALIDATE_SINGLE_ENTRY_CACHE_FULL,

    S_NONFAULTING_OPTIMIZATION,

    S_CLEAR_TLB,
    S_FULL_CLEAR_TLB,
    S_TLB_FULL,
    S_TLB_GLOBAL_FULL,
}

#[no_mangle]
pub static mut stat_array: [u32; 100] = [0; 100];

pub fn stat_increment(stat: stat) { stat_increment_by(stat, 1); }

pub fn stat_increment_by(stat: stat, by: u32) {
    if cfg!(feature = "profiler") {
        unsafe { stat_array[stat as usize] += by }
    }
}

#[no_mangle]
pub fn profiler_init() {
    unsafe {
        for x in stat_array.iter_mut() {
            *x = 0
        }
    }
}

#[no_mangle]
pub fn profiler_stat_get(stat: stat) -> u32 {
    if cfg!(feature = "profiler") {
        unsafe { stat_array[stat as usize] }
    }
    else {
        0
    }
}

#[no_mangle]
pub fn profiler_stat_increment_do_run() { stat_increment(stat::S_DO_RUN); }
