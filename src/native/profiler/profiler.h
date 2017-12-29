#include <stdbool.h>
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


void profiler_init();
void profiler_start(enum profile_name name);
void profiler_end(enum profile_name name);
void profiler_print();

// JS import
double get_time();

#endif
