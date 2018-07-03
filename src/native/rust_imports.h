#pragma once

#include "cpu.h"
#include <stdint.h>

uint32_t jit_find_cache_entry(uint32_t phys_addr, cached_state_flags flags);
void jit_increase_hotness_and_maybe_compile(uint32_t phys_addr, uint32_t cs_offset, cached_state_flags flags);

void jit_dirty_cache_single(uint32_t phys_addr);
void jit_dirty_cache_small(uint32_t phys_start_addr, uint32_t phys_end_addr);

bool jit_page_has_code(uint32_t physical_page);

uint32_t jit_unused_cache_stat(void);
uint32_t jit_get_entry_length(int32_t i);
uint32_t jit_get_entry_address(int32_t i);
bool jit_get_entry_pending(int32_t i);
