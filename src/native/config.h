#pragma once

/**
 * How many cycles the CPU does at a time before running hardware timers
 */
//#define LOOP_COUNTER 20011

//#define TSC_RATE (50 * 1000)


#define ENABLE_PROFILER 1
#define ENABLE_PROFILER_OPSTATS 1
#define ENABLE_PROFILER_SAFE_READ_WRITE 1

// Note: needs to be enabled here and in config.js
#define DUMP_UNCOMPILED_ASSEMBLY 0

//#define LOG_PAGE_FAULTS 0
