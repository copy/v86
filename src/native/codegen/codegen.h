#pragma once

#include <stdint.h>

#define FN0_TYPE_INDEX 0
#define FN1_TYPE_INDEX 1
#define FN2_TYPE_INDEX 2
#define FN0_RET_TYPE_INDEX 3
#define FN1_RET_TYPE_INDEX 4
#define FN2_RET_TYPE_INDEX 5

static uint8_t const fn_get_seg_prefix_ds_idx = 0;
static uint8_t const fn_get_seg_prefix_ss_idx = 1;
static uint8_t const fn_get_seg_prefix_idx = 2;

void gen_init(void);
void gen_reset(void);
uintptr_t gen_finish(void);
uintptr_t gen_get_final_offset(void);

int32_t get_fn_index(char* fn, uint8_t fn_len, uint8_t type_index);

void gen_fn0(char* fn, uint8_t fn_len);
void gen_fn1(char* fn, uint8_t fn_len, int32_t arg0);
void gen_fn2(char* fn, uint8_t fn_len, int32_t arg0, int32_t arg1);
void gen_modrm_fn0(char* fn, uint8_t fn_len, int32_t modrm_byte);
void gen_modrm_fn1(char* fn, uint8_t fn_len, int32_t modrm_byte, int32_t arg0);
void gen_resolve_modrm16(int32_t modrm_byte);
void gen_resolve_modrm32(int32_t modrm_byte);
void gen_increment_instruction_pointer(int32_t n);
void gen_set_previous_eip();
void gen_drop();

