#pragma once

#include <stdint.h>

#include "util.h"

#define FN0_TYPE_INDEX 0
#define FN1_TYPE_INDEX 1
#define FN2_TYPE_INDEX 2
#define FN3_TYPE_INDEX 3

#define FN0_RET_TYPE_INDEX 4
#define FN1_RET_TYPE_INDEX 5
#define FN2_RET_TYPE_INDEX 6

#define NR_FN_TYPE_INDEXES 7

// We'll need to scale the index on the stack to access arr32[i] correctly, for eg.
// &arr32[i] == (arr32 + i*4)
// This macro simply does the "i*4" part of the address calculation
#define SCALE_INDEX_FOR_ARR(arr, scale_by)                              \
    _Static_assert(                                                     \
        sizeof(arr[0]) == 1 << scale_by,                                \
        "codegen: Array element size different from expected bytes."    \
    );                                                                  \
    /* Shift the index to make it byte-indexed, not array-indexed */    \
    gen_const_i32(scale_by);                                            \
    shl_i32(&instruction_body);

extern Buffer instruction_body;

static uint8_t const fn_get_seg_idx = 0;

void gen_init(void);
void gen_reset(void);
uintptr_t gen_finish(int32_t no_of_locals_i32);
uintptr_t gen_get_final_offset(void);

int32_t get_fn_index(char const* fn, uint8_t fn_len, uint8_t type_index);

// Generate function call with constant arguments
void gen_fn0_const(char const* fn, uint8_t fn_len);
void gen_fn1_const(char const* fn, uint8_t fn_len, int32_t arg0);
void gen_fn2_const(char const* fn, uint8_t fn_len, int32_t arg0, int32_t arg1);
void gen_fn3_const(char const* fn, uint8_t fn_len, int32_t arg0, int32_t arg1, int32_t arg2);

void gen_fn0_const_ret(char const* fn, uint8_t fn_len);
void gen_fn1_const_ret(char const* fn, uint8_t fn_len, int32_t arg0);

// Generate code to set register value to result of function call
void gen_set_reg16_fn0(char const* fn, uint8_t fn_len, int32_t reg);
void gen_set_reg32s_fn0(char const* fn, uint8_t fn_len, int32_t reg);

// Generate code for "mov reg, reg"
void gen_set_reg16_r(int32_t r_dest, int32_t r_src);
void gen_set_reg32_r(int32_t r_dest, int32_t r_src);

// Generate function call with register value as argument (reg is index of register)
void gen_fn1_reg16(char const* fn, uint8_t fn_len, int32_t reg);
void gen_fn1_reg32s(char const* fn, uint8_t fn_len, int32_t reg);

// Generate a function call with arguments pushed to the stack separately
void gen_call_fn1_ret(char const* fn, uint8_t fn_len);
void gen_call_fn1(char const* fn, uint8_t fn_len);
void gen_call_fn2(char const* fn, uint8_t fn_len);

// Generate code for safe_read32s and safe_write32 inline
void gen_safe_read32(void);
void gen_safe_write32(int32_t local_for_address, int32_t local_for_value);

void gen_add_i32(void);
void gen_eqz_i32(void);
void gen_eq_i32(void);
void gen_ne_i32(void);
void gen_le_i32(void);
void gen_lt_i32(void);
void gen_ge_i32(void);
void gen_gt_i32(void);

void gen_if_void(void);
void gen_if_i32(void);
void gen_else(void);
void gen_loop_void(void);
void gen_block_void(void);
void gen_block_i32(void);
void gen_block_end(void);
void gen_return(void);

void gen_brtable_and_cases(int32_t);

void gen_br(int32_t depth);

void gen_const_i32(int32_t);

void gen_get_local(int32_t);
void gen_set_local(int32_t);
void gen_tee_local(int32_t);

void gen_unreachable(void);

void gen_load_aligned_i32_from_stack(uint32_t offset);
void gen_store_aligned_i32(void);

void gen_modrm_resolve(int32_t modrm_byte);
void gen_modrm_fn0(char const* fn, uint8_t fn_len);
void gen_modrm_fn1(char const* fn, uint8_t fn_len, int32_t arg0);
void gen_modrm_fn2(char const* fn, uint8_t fn_len, int32_t arg0, int32_t arg1);

void gen_increment_mem32(int32_t addr);

void gen_relative_jump(int32_t n);

void gen_set_previous_eip_offset_from_eip(int32_t n);
void gen_set_previous_eip(void);
void gen_increment_instruction_pointer(int32_t);

void gen_increment_timestamp_counter(uint32_t);

void gen_commit_instruction_body_to_cs(void);
void gen_clear_prefixes(void);
void gen_add_prefix_bits(int32_t);
