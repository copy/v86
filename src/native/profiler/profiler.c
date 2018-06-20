#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

#include "../const.h"
#include "../log.h"
#include "../shared.h"
#include "profiler.h"

#if ENABLE_PROFILER

struct profiler_stat profiler_stat_arr[PROFILER_STAT_COUNT] = {{0}};

void profiler_init(void)
{
    for(uint32_t i = 0; i < PROFILER_STAT_COUNT; i++)
    {
        profiler_stat_arr[i].count = 0;
    }
}

void profiler_stat_increment(enum stat_name stat)
{
    profiler_stat_increment_by(stat, 1);
}

void profiler_stat_increment_by(enum stat_name stat, int32_t by)
{
    profiler_stat_arr[stat].count += by;
}

// to be called from JS
void profiler_stat_increment_do_run()
{
    profiler_stat_increment(S_DO_RUN);
}

int32_t profiler_stat_get(enum stat_name stat)
{
    return profiler_stat_arr[stat].count;
}

#else
// Disable profiler

void profiler_init(void) {}
void profiler_stat_increment(enum stat_name stat) { UNUSED(stat); }
void profiler_stat_increment_by(enum stat_name stat, int32_t by) { UNUSED(stat); UNUSED(by); }
void profiler_stat_increment_do_run() {}
int32_t profiler_stat_get(enum stat_name stat) { UNUSED(stat); return 0; }


#endif
