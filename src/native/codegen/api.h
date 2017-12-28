#pragma once

#include <stdint.h>

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

