#pragma once

#include <stdbool.h>
#include <stdint.h>

enum stat_name {
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
    S_RUN_INTERPRETED_NOT_HOT,
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
};
#define PROFILER_STAT_COUNT (S_TLB_GLOBAL_FULL - S_COMPILE + 1)

struct profiler_stat {
    int32_t count;
};

extern struct profiler_stat profiler_stat_arr[PROFILER_STAT_COUNT];

void profiler_init(void);

void profiler_stat_increment(enum stat_name stat);
void profiler_stat_increment_by(enum stat_name stat, int32_t by);
int32_t profiler_stat_get(enum stat_name stat);

// JS import
extern double get_time(void);
