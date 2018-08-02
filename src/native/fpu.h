#pragma once

#include <math.h>
#include <stdbool.h>
#include <stdint.h>

//#ifndef M_LOG2E
extern const double_t M_LOG2E;
//#endif

//#ifndef M_LN2
extern const double_t M_LN2;
//#endif

//#ifndef M_LN10
extern const double_t M_LN10;
//#endif

//#ifndef M_PI
extern const double_t M_PI;
//#endif

extern const int32_t FPU_C0;
extern const int32_t FPU_C1;
extern const int32_t FPU_C2;
extern const int32_t FPU_C3;
extern const int32_t FPU_RESULT_FLAGS;
extern const int32_t FPU_STACK_TOP;

double_t fpu_get_st0(void);
double_t fpu_get_sti(int32_t i);
double_t fpu_integer_round(double_t f);
double_t fpu_load_m32(int32_t addr);
double_t fpu_load_m64(int32_t addr);
double_t fpu_load_m80(uint32_t addr);
double_t fpu_truncate(double_t x);
int32_t fpu_load_status_word(void);
void fpu_fadd(int32_t target_index, double_t val);
void fpu_fclex(void);
void fpu_fcmovcc(bool condition, int32_t r);
void fpu_fcom(double_t y);
void fpu_fcomi(int32_t r);
void fpu_fcomip(int32_t r);
void fpu_fcomp(double_t val);
void fpu_fdiv(int32_t target_index, double_t val);
void fpu_fdivr(int32_t target_index, double_t val);
void fpu_ffree(int32_t r);
void fpu_fildm64(int32_t addr);
void fpu_finit(void);
void fpu_fistm16(int32_t addr);
void fpu_fistm16p(int32_t addr);
void fpu_fistm32(int32_t addr);
void fpu_fistm32p(int32_t addr);
void fpu_fistm64p(int32_t addr);
void fpu_fldcw(int32_t addr);
void fpu_fldenv(int32_t addr);
void fpu_fldm32(int32_t addr);
void fpu_fldm64(int32_t addr);
void fpu_fldm80(int32_t addr);
void fpu_fmul(int32_t target_index, double_t val);
void fpu_fnstsw_mem(int32_t addr);
void fpu_fnstsw_reg(void);
void fpu_fprem(void);
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
void fpu_fsub(int32_t target_index, double_t val);
void fpu_fsubr(int32_t target_index, double_t val);
void fpu_ftst(double_t x);
void fpu_fucom(int32_t r);
void fpu_fucomi(int32_t r);
void fpu_fucomip(int32_t r);
void fpu_fucomp(int32_t r);
void fpu_fucompp(void);
void fpu_fxam(double_t x);
void fpu_fxch(int32_t i);
void fpu_fxtract(void);
void fpu_pop(void);
void fpu_push(double_t x);
void fpu_set_status_word(int32_t sw);
void fpu_set_tag_word(int32_t tag_word);
void fpu_store_m80(uint32_t addr, double_t n);
void fwait(void);
