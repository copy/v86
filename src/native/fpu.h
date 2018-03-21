#pragma once

#include <math.h>
#include <stdint.h>

void fpu_set_tag_word(int32_t tag_word);
void fpu_fcom(double_t y);
int32_t fpu_load_status_word(void);
void fpu_set_status_word(int32_t sw);
void fpu_store_m80(uint32_t addr, double_t n);
double_t fpu_load_m80(uint32_t addr);
void fwait();

double_t fpu_get_sti(int32_t i);
double_t fpu_load_m32(int32_t addr);
double_t fpu_load_m64(int32_t addr);
void fpu_fadd(double_t val);
void fpu_fcmovcc(bool condition, int32_t r);
void fpu_fcomi(int32_t r);
void fpu_fcomp(double_t val);
void fpu_fdiv(double_t val);
void fpu_fdivr(double_t val);
void fpu_finit(void);
void fpu_fldcw(int32_t addr);
void fpu_fldenv(int32_t addr);
void fpu_fmul(double_t val);
void fpu_fst(int32_t addr);
void fpu_fstcw(int32_t addr);
void fpu_fstenv(int32_t addr);
void fpu_fstp(int32_t addr);
void fpu_fsub(double_t val);
void fpu_fsubr(double_t val);
void fpu_fucomi(int32_t r);
void fpu_fucompp(void);
void fpu_fxch(int32_t i);
void fpu_op_D9_4_reg(int32_t r);
void fpu_op_D9_5_reg(int32_t r);
void fpu_op_D9_6_reg(int32_t r);
void fpu_op_D9_7_reg(int32_t r);
void fpu_push(double_t x);

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
