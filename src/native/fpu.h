#pragma once

#include <stdint.h>
#include <math.h>

void fpu_set_tag_word(int32_t tag_word);
void fpu_fcomi(double_t y);
int32_t fpu_load_status_word(void);
void fpu_set_status_word(int32_t sw);
void fpu_store_m80(uint32_t addr, double_t n);
double_t fpu_load_m80(uint32_t addr);
