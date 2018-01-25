#include <stdio.h>
#include <stdbool.h>
#include <stdint.h>

#include "profiler.h"
#include "../shared.h"

#if ENABLE_PROFILER

struct profiler_data profiler_arr[PROFILER_NAME_COUNT] = {{0, 0, false}};
struct profiler_stat profiler_stat_arr[PROFILER_NAME_COUNT] = {{0}};
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

    for(uint32_t i = 0; i < PROFILER_STAT_COUNT; i++)
    {
        profiler_stat_arr[i].count = 0;
    }
}

void profiler_start(enum profile_name name)
{
#if ENABLE_PROFILER_TIMES
    struct profiler_data *entry = &profiler_arr[name];
    assert(!entry->capturing);

    entry->current_start = get_time();
    entry->capturing = true;
#endif
}

void profiler_end(enum profile_name name)
{
#if ENABLE_PROFILER_TIMES
    struct profiler_data *entry = &profiler_arr[name];
    if(entry->capturing)
    {
        entry->total += get_time() - entry->current_start;
        entry->current_start = 0;
        entry->capturing = false;
    }
#endif
}

void profiler_print()
{
#if ENABLE_PROFILER_TIMES
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
#endif
}

int32_t profiler_get_time(enum profile_name name)
{
    return profiler_arr[name].total;
}

int32_t profiler_get_total(void)
{
    return get_time() - profiler_init_time;
}

void profiler_stat_increment(enum stat_name stat)
{
    profiler_stat_arr[stat].count++;
}

int32_t profiler_stat_get(enum stat_name stat)
{
    return profiler_stat_arr[stat].count;
}

#else
// Disable profiler

void profiler_init(void) {}
void profiler_start(enum profile_name name) { UNUSED(name); }
void profiler_end(enum profile_name name) { UNUSED(name); }
void profiler_print(void) {}
int32_t profiler_get_time(enum profile_name name) { UNUSED(name); return 0; }
int32_t profiler_get_total(void) { return 0; }
void profiler_stat_increment(enum stat_name stat) { UNUSED(stat); }
int32_t profiler_stat_get(enum stat_name stat) { UNUSED(stat); return 0; }


#endif
