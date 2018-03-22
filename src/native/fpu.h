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
void fpu_fadd(double_t val, int32_t target_index);
void fpu_fclex(void);
void fpu_fcmovcc(bool condition, int32_t r);
void fpu_fcomi(int32_t r);
void fpu_fcomp(double_t val);
void fpu_fdiv(double_t val, int32_t target_index);
void fpu_fdivr(double_t val, int32_t target_index);
void fpu_ffree(int32_t r);
void fpu_finit(void);
void fpu_fistm32(int32_t addr);
void fpu_fistm32p(int32_t addr);
void fpu_fldcw(int32_t addr);
void fpu_fldenv(int32_t addr);
void fpu_fldm32(int32_t addr);
void fpu_fldm64(int32_t addr);
void fpu_fldm80(int32_t addr);
void fpu_fmul(double_t val, int32_t target_index);
void fpu_fnstsw(int32_t addr);
void fpu_frstor(int32_t addr);
void fpu_fsave(int32_t addr);
void fpu_fst(int32_t r);
void fpu_fst80p(int32_t addr);
void fpu_fstcw(int32_t addr);
void fpu_fstenv(int32_t addr);
void fpu_fstm32(int32_t addr);
void fpu_fstm32p(int32_t addr);
void fpu_fstm64(int32_t addr);
void fpu_fstm64p(int32_t addr);
void fpu_fstp(int32_t r);
void fpu_fsub(double_t val, int32_t target_index);
void fpu_fsubr(double_t val, int32_t target_index);
void fpu_fucom(int32_t r);
void fpu_fucomi(int32_t r);
void fpu_fucomp(int32_t r);
void fpu_fucompp(void);
void fpu_fxch(int32_t i);
void fpu_op_D9_4_reg(int32_t r);
void fpu_op_D9_5_reg(int32_t r);
void fpu_op_D9_6_reg(int32_t r);
void fpu_op_D9_7_reg(int32_t r);
void fpu_pop(void);
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
