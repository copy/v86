#pragma once

#include <stdint.h>

void free_wasm_table_index(uint16_t wasm_table_index);
void remove_jit_cache_wasm_index(int32_t page, uint16_t wasm_table_index);

void remove_jit_cache_entry(uint32_t page, int32_t addr_index);
void jit_dirty_cache(uint32_t start_addr, uint32_t end_addr);
void jit_dirty_cache_single(uint32_t addr);
void jit_dirty_cache_small(uint32_t start_addr, uint32_t end_addr);
void jit_empty_cache(void);
