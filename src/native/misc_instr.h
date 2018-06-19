#pragma once

#include <stdbool.h>
#include <stdint.h>

bool getcf(void);
bool getpf(void);
bool getaf(void);
bool getzf(void);
bool getsf(void);
bool getof(void);

bool test_o(void);
bool test_b(void);
bool test_z(void);
bool test_s(void);
bool test_p(void);
bool test_be(void);
bool test_l(void);
bool test_le(void);

bool test_no(void);
bool test_nb(void);
bool test_nz(void);
bool test_ns(void);
bool test_np(void);
bool test_nbe(void);
bool test_nl(void);
bool test_nle(void);

void jmp_rel16(int32_t rel16);
void jmpcc16(bool condition, int32_t imm16);
void jmpcc32(bool condition, int32_t imm32);

void loope16(int32_t imm8s);
void loopne16(int32_t imm8s);
void loop16(int32_t imm8s);
void jcxz16(int32_t imm8s);
void loope32(int32_t imm8s);
void loopne32(int32_t imm8s);
void loop32(int32_t imm8s);
void jcxz32(int32_t imm8s);

void cmovcc16(bool condition, int32_t value, int32_t r);
void cmovcc32(bool condition, int32_t value, int32_t r);
int32_t get_stack_pointer(int32_t offset);
void adjust_stack_reg(int32_t adjustment);
void push16_ss16(int32_t imm16);
void push16_ss32(int32_t imm16);
void push16_ss16_mem(int32_t addr);
void push16_ss32_mem(int32_t addr);
void push16(int32_t imm16);
void push16_reg_jit(int32_t reg);
void push16_imm_jit(int32_t imm);
void push16_mem_jit(int32_t modrm_byte);
void push32_ss16(int32_t imm32);
void push32_ss32(int32_t imm32);
void push32_ss16_mem(int32_t addr);
void push32_ss32_mem(int32_t addr);
void push32(int32_t imm32);
void push32_reg_jit(int32_t reg);
void push32_imm_jit(int32_t imm);
void push32_mem_jit(int32_t modrm_byte);
int32_t pop16(void);
void pop16_reg_jit(int32_t reg);
int32_t pop32_ss16(void);
int32_t pop32_ss32(void);
int32_t pop32s(void);
void pop32s_reg_jit(int32_t reg);
void pusha16(void);
void pusha32(void);
void setcc_reg(bool condition, int32_t r);
void setcc_mem(bool condition, int32_t addr);
void fxsave(uint32_t addr);
void fxrstor(uint32_t addr);
int32_t xchg8(int32_t data, int32_t r8);
int32_t xchg16(int32_t data, int32_t r16);
void xchg16r(int32_t r16);
int32_t xchg32(int32_t data, int32_t r32);
void xchg32r(int32_t r32);
