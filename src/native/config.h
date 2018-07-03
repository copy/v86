#pragma once

#ifndef DEBUG
#define DEBUG true
#endif

/**
 * How many cycles the CPU does at a time before running hardware timers
 */
#define LOOP_COUNTER 20011

#define TSC_RATE (50 * 1000)

#define CPU_LOG_VERBOSE    false
#define ENABLE_ACPI    false

#define USE_A20 false

#define CHECK_TLB_INVARIANTS 0

#define ENABLE_JIT 1

#define ENABLE_PROFILER 0
#define ENABLE_PROFILER_OPSTATS 0
#define ENABLE_PROFILER_SAFE_READ_WRITE 0

// Note: needs to be enabled here and in config.js
#define DUMP_UNCOMPILED_ASSEMBLY 0

#define LOG_PAGE_FAULTS 0
