#include <stdbool.h>
#include <stdint.h>

#ifndef _PROFILER_H
#define _PROFILER_H


#define PROFILER_NAME_COUNT 5

struct profiler_data {
    double total;
    double current_start;
    bool capturing;
} profiler_arr[PROFILER_NAME_COUNT] = {{0, 0, false}};

const char *profiler_names[] = {
    "IDLE",
    "DO_MANY_CYCLES",
    "GEN_INSTR",
    "RUN_FROM_CACHE",
    "RUN_INTERPRETED",
};

enum profile_name {
    P_IDLE,
    P_DO_MANY_CYCLES,
    P_GEN_INSTR,
    P_RUN_FROM_CACHE,
    P_RUN_INTERPRETED,
};


#define PROFILER_STAT_COUNT 5

enum stat_name {
    S_COMPILE,
    S_COMPILE_SUCCESS,
    S_RUN_INTERPRETED,
    S_RUN_FROM_CACHE,
    S_CACHE_MISMATCH,
};

struct profiler_stat {
    int32_t count;
} profiler_stat_arr[PROFILER_NAME_COUNT] = {{0}};

void profiler_init();
void profiler_start(enum profile_name name);
void profiler_end(enum profile_name name);
void profiler_print();

void profiler_stat_increment(enum stat_name stat);
int32_t profiler_stat_get(enum stat_name stat);

// JS import
double get_time();

#endif
