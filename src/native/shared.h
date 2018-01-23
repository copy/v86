#pragma once

#include <stdint.h>
#include <stdbool.h>
#include <math.h>

#include "const.h"

union reg128 {
    int8_t   i8[16];
    int16_t  i16[8];
    int32_t  i32[4];
    int64_t  i64[2];
    uint8_t   u8[16];
    uint16_t  u16[8];
    uint32_t  u32[4];
    uint64_t  u64[2];
};
typedef char assert_size_reg128[(sizeof(union reg128) == 16) * 2 - 1];

union reg64 {
    int8_t   i8[8];
    int16_t  i16[4];
    int32_t  i32[2];
    int64_t  i64[1];
    uint8_t   u8[8];
    uint16_t  u16[4];
    uint32_t  u32[2];
    uint64_t  u64[1];
    double   f64[1];
};
typedef char assertion_size_reg64[(sizeof(union reg64) == 8) * 2 - 1];

struct code_cache {
    // Address of the start of the basic block
    uint32_t start_addr;
    uint32_t end_addr;
    // Address of the instruction immediately after the basic block ends
    int32_t opcode[1]; // TODO: Remove in debug mode
    int32_t len;
    int32_t is_32;
    // Cleanliness status of the entry's "group" (based on
    // DIRTY_ARR_SHIFT). Value only has meaning in relation with the
    // group_dirtiness value.
    uint32_t group_status;
};
struct code_cache jit_cache_arr[WASM_TABLE_SIZE];

// Flag indicating whether the instruction that just ran was a jump of some sort
extern uint32_t jit_jump;

// Count of how many times prime_hash(address) has been called through a jump
extern int32_t hot_code_addresses[HASH_PRIME];
// An array indicating the current "initial group status" for entries that map
// to the same group due to the shift
extern uint32_t group_dirtiness[GROUP_DIRTINESS_LENGTH];

extern void call_indirect(int32_t index);
extern void jit_clear_func(int32_t index);
extern void call_interrupt_vector(int32_t interrupt_nr, bool is_software_int, bool has_error_code, int32_t error_code);
extern void throw_cpu_exception(void);
extern double_t math_pow(double_t, double_t);
extern double_t microtick(void);
