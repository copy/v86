#pragma once

#include <stdint.h>
#include <math.h>

void fpu_set_tag_word(int32_t tag_word);
void fpu_fcomi(double_t y);
int32_t fpu_load_status_word(void);
void fpu_set_status_word(int32_t sw);
void fpu_store_m80(uint32_t addr, double_t n);
double_t fpu_load_m80(uint32_t addr);
void fwait();

void fpu_op_D8_mem(int32_t, int32_t);
void fpu_op_D8_reg(int32_t);
void fpu_op_D9_mem(int32_t, int32_t);
void fpu_op_D9_reg(int32_t);
void fpu_op_DA_mem(int32_t, int32_t);
void fpu_op_DA_reg(int32_t);
void fpu_op_DB_mem(int32_t, int32_t);
void fpu_op_DB_reg(int32_t);
void fpu_op_DC_mem(int32_t, int32_t);
void fpu_op_DC_reg(int32_t);
void fpu_op_DD_mem(int32_t, int32_t);
void fpu_op_DD_reg(int32_t);
void fpu_op_DE_mem(int32_t, int32_t);
void fpu_op_DE_reg(int32_t);
void fpu_op_DF_mem(int32_t, int32_t);
void fpu_op_DF_reg(int32_t);
