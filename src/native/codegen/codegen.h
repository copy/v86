#pragma once

#include <stdint.h>

#include "wasmgen.h"

#define FN0_TYPE_INDEX 0
#define FN1_TYPE_INDEX 1
#define FN2_TYPE_INDEX 2
#define FN3_TYPE_INDEX 3

#define FN0_RET_TYPE_INDEX 4
#define FN1_RET_TYPE_INDEX 5
#define FN2_RET_TYPE_INDEX 6

#define NR_FN_TYPE_INDEXES 7

// We'll need to scale the index on the stack to access arr32[i] correctly, for eg.
// &array32[i]'s byte address is "array32 + i*4"
// This macro simply does the "i*4" part of the address calculation
#define SCALE_INDEX_FOR_ARRAY32(array)                                  \
    _Static_assert(                                                     \
        sizeof((array)[0]) == 4,                                        \
        "codegen: Elements assumed to be 4 bytes."                      \
    );                                                                  \
    /* Shift the index to make it byte-indexed, not array-indexed */    \
    wg_push_i32(instruction_body, 2);                                   \
    wg_shl_i32(instruction_body);

uint8_t* cs;
uint8_t* instruction_body;

static uint16_t const fn_get_seg_idx = 0;

void gen_reset(void);
// uintptr_t gen_finish(int32_t no_of_locals_i32);
void add_get_seg_import(void);

uint16_t get_fn_idx(char const* fn, uint8_t fn_len, uint8_t fn_type);

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

void gen_clear_prefixes(void);
void gen_add_prefix_bits(int32_t);
