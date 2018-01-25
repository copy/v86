#pragma once

#include <stdint.h>
#include <stdbool.h>

int32_t resolve_modrm16(int32_t modrm_byte);
int32_t resolve_modrm32(int32_t modrm_byte);
