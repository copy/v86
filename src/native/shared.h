#ifndef _SHARED_H
#define _SHARED_H

#include <stdint.h>
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
    // Address of the instruction immediately after the basic block ends
    uint32_t end_addr;
    int32_t opcode[100];
    int32_t len;
    // Cleanliness status of the entry's "group" (based on
    // DIRTY_ARR_SHIFT). Value only has meaning in relation with the
    // group_dirtiness value.
    uint32_t group_status;
} jit_cache_arr[CACHE_LEN] = {{0, 0, {0}, 0, 0}};

// Flag indicating whether the instruction that just ran was a jump of some sort
uint32_t jit_jump = 0;

// Count of how many times prime_hash(address) has been called through a jump
int32_t hot_code_addresses[HASH_PRIME] = {0};
// An array indicating the current "initial group status" for entries that map
// to the same group due to the shift
uint32_t group_dirtiness[1 + (0xffffffff >> DIRTY_ARR_SHIFT)] = {0};

void call_indirect(int32_t index);
void jit_store_func(int32_t index);
#endif
