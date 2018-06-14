#pragma once

#include <stdbool.h>
#include <stdint.h>

#define PROFILER_NAME_COUNT 5

struct profiler_data {
    double total;
    double current_start;
    bool capturing;
};

extern struct profiler_data profiler_arr[PROFILER_NAME_COUNT];

enum profile_name {
    P_IDLE,
    P_DO_MANY_CYCLES,
    P_GEN_INSTR,
    P_RUN_FROM_CACHE,
    P_RUN_INTERPRETED,
};


enum stat_name {
    S_COMPILE,
    S_COMPILE_SUCCESS,
    S_COMPILE_CUT_OFF_AT_END_OF_PAGE,
    S_COMPILE_WITH_LOOP_SAFETY,
    S_COMPILE_BASIC_BLOCK,
    S_COMPILE_ENTRY_POINT,

    S_RUN_INTERPRETED,
    S_RUN_INTERPRETED_PENDING,
    S_RUN_INTERPRETED_NEAR_END_OF_PAGE,
    S_RUN_INTERPRETED_NO_BLOCK_BOUNDARY,
    S_RUN_INTERPRETED_NOT_HOT,

    S_RUN_INTERPRETED_STEPS,

    S_RUN_FROM_CACHE,
    S_RUN_FROM_CACHE_STEPS,
    S_CACHE_MISMATCH,

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
void profiler_start(enum profile_name name);
void profiler_end(enum profile_name name);
void profiler_print(void);

void profiler_stat_increment(enum stat_name stat);
void profiler_stat_increment_by(enum stat_name stat, int32_t by);
int32_t profiler_stat_get(enum stat_name stat);

// JS import
extern double get_time(void);
