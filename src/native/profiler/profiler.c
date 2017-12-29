#include <stdio.h>
#include <stdbool.h>
#include "profiler.h"

#if ENABLE_PROFILER

double profiler_init_time = 0;

void profiler_init()
{
    profiler_init_time = get_time();
    for(uint32_t i = 0; i < PROFILER_NAME_COUNT; i++)
    {
        struct profiler_data *entry = &profiler_arr[i];
        entry->total = 0;
        entry->current_start = 0;
        entry->capturing = false;
    }
}

void profiler_start(enum profile_name name)
{
    struct profiler_data *entry = &profiler_arr[name];
    assert(!entry->capturing);

    entry->current_start = get_time();
    entry->capturing = true;
}

void profiler_end(enum profile_name name)
{
    struct profiler_data *entry = &profiler_arr[name];
    if(entry->capturing)
    {
        entry->total += get_time() - entry->current_start;
        entry->current_start = 0;
        entry->capturing = false;
    }
}

void profiler_print()
{
    double init_elapsed = get_time() - profiler_init_time;
    printf("\nElapsed: %d\n", (int32_t) init_elapsed);
    for(int32_t i = 0; i < PROFILER_NAME_COUNT; i++)
    {
        double cur_total = profiler_arr[i].total;
        printf(profiler_names[i]);
        printf(
            "\nIndex:\t%d"
            "\nTotal:\t%d"
            "\nPercentage:\t%d%%\n",
            i,
            (int32_t) cur_total,
            (int32_t) (100 * cur_total / init_elapsed)
        );
    }
}

#else
// Disable profiler

void profiler_init() {}
void profiler_start(enum profile_name name) {}
void profiler_end(enum profile_name name) {}
void profiler_print() {}

#endif
