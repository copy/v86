#pragma once

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#define UNUSED(x) (void)(x)

//void *memset(void *dest, int c, size_t n);

void assert(bool x);
void dbg_assert(bool x);
void dbg_assert_message(bool x, const char* msg);
void dbg_log(const char* m);
void dbg_log1(const char* m, int32_t x);
void dbg_log2(const char* m, int32_t x, int32_t y);
void dbg_log3(const char* m, int32_t x, int32_t y, int32_t z);
void dbg_log5(const char* m, int32_t x, int32_t y, int32_t z, int32_t i, int32_t j);
void dbg_trace();
bool isnan_XXX(double f);
bool isfinite_XXX(double f);
