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


#define PROFILER_STAT_COUNT 13

enum stat_name {
    S_COMPILE,
    S_COMPILE_SUCCESS,
    S_RUN_INTERPRETED,
    S_RUN_FROM_CACHE,
    S_CACHE_MISMATCH,
    S_CACHE_DROP,
    S_CACHE_SKIPPED,
    S_COMPILE_WITH_LINK,
    S_NONFAULTING_OPTIMIZATION,

    S_CLEAR_TLB,
    S_FULL_CLEAR_TLB,
    S_TLB_FULL,
    S_TLB_GLOBAL_FULL,
};

struct profiler_stat {
    int32_t count;
};

extern struct profiler_stat profiler_stat_arr[PROFILER_STAT_COUNT];

void profiler_init(void);
void profiler_start(enum profile_name name);
void profiler_end(enum profile_name name);
void profiler_print(void);

void profiler_stat_increment(enum stat_name stat);
int32_t profiler_stat_get(enum stat_name stat);

// JS import
extern double get_time(void);
