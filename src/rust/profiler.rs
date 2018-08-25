#[repr(C)]
#[allow(non_camel_case_types, dead_code)]
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
    S_INVALIDATE_CACHE_ENTRY,

    S_NONFAULTING_OPTIMIZATION,

    S_CLEAR_TLB,
    S_FULL_CLEAR_TLB,
    S_TLB_FULL,
    S_TLB_GLOBAL_FULL,
}

#[cfg(feature = "profiler")]
mod unsafe_extern {
    extern "C" {
        pub fn profiler_stat_increment(stat: ::profiler::stat);
    }
}

#[cfg(feature = "profiler")]
pub fn stat_increment(stat: stat) { unsafe { unsafe_extern::profiler_stat_increment(stat) } }

#[cfg(not(feature = "profiler"))]
pub fn stat_increment(_stat: stat) {}
