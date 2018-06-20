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

// Mask used to map physical address to index in cache array
#define JIT_CACHE_ARRAY_SIZE 0x40000
#define JIT_CACHE_ARRAY_MASK (JIT_CACHE_ARRAY_SIZE - 1)

#define HASH_PRIME 6151

#define JIT_THRESHOLD 2500

#define CHECK_JIT_CACHE_ARRAY_INVARIANTS 0
#define CHECK_TLB_INVARIANTS 0

#define JIT_MAX_ITERATIONS_PER_FUNCTION 10000

#define ENABLE_JIT 1
#define ENABLE_JIT_NONFAULTING_OPTIMZATION 1
#define JIT_ALWAYS_USE_LOOP_SAFETY 0

#ifndef ENABLE_JIT_ALWAYS
#define ENABLE_JIT_ALWAYS 0
#endif

#define ENABLE_PROFILER 0
#define ENABLE_PROFILER_OPSTATS 0

// Note: needs to be enabled here and in config.js
#define DUMP_UNCOMPILED_ASSEMBLY 0

#define LOG_PAGE_FAULTS 0
