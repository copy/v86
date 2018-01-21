#pragma once

#include <stdint.h>

bool in_mapped_range(uint32_t addr);
void jit_dirty_cache(uint32_t start_addr, uint32_t end_addr);
void jit_dirty_cache_small(uint32_t start_addr, uint32_t end_addr);
void jit_empty_cache(void);
int32_t read8(uint32_t addr);
int32_t read16(uint32_t addr);
int32_t read_aligned16(uint32_t addr);
int32_t read32s(uint32_t addr);
int64_t read64s(uint32_t addr);
int32_t read_aligned32(uint32_t addr);
void write8(uint32_t addr, int32_t value);
void write16(uint32_t addr, int32_t value);
void write_aligned16(uint32_t addr, uint32_t value);
void write32(uint32_t addr, int32_t value);
void write_aligned32(int32_t addr, int32_t value);
void write64(uint32_t addr, int64_t value);
