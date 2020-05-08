#include <stdbool.h>
#ifndef _PROFILER_H
#define _PROFILER_H

struct profiler_data {
    double total;
    double current_start;
    bool capturing;
} profiler_arr[4] = {{0, 0, false}};

enum profile_name {
    P_IDLE,
    P_GEN_INSTR,
    P_DO_MANY_CYCLES,
    P_RUN_FROM_CACHE
};

#define PROFILER_NAME_COUNT 4


void profiler_init();
void profiler_start(enum profile_name name);
void profiler_end(enum profile_name name);
void profiler_print();

// JS import
double get_time();

#endif
