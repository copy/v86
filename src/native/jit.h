#pragma once

#include <stdint.h>

void jit_dirty_cache(uint32_t start_addr, uint32_t end_addr);
void jit_dirty_cache_single(uint32_t addr);
void jit_dirty_cache_small(uint32_t start_addr, uint32_t end_addr);
void jit_empty_cache(void);
