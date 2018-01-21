#pragma once

#include <stdint.h>
#include <stdbool.h>

int32_t resolve_modrm16(int32_t modrm_byte);
int32_t resolve_modrm32(int32_t modrm_byte);
static int32_t resolve_sib_(bool mod);
static int32_t resolve_sib(bool mod);
static int32_t resolve_modrm32_(int32_t modrm_byte);
