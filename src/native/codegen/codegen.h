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

int32_t get_fn_index(char* fn, uint8_t fn_len, uint8_t type_index);

void gen_init(void);
void gen_reset(void);
uintptr_t gen_finish(void);
uintptr_t gen_get_final_offset(void);

