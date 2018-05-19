#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

#include "const.h"
#include "global_pointers.h"
#include "jit.h"
#include "js_imports.h"
#include "log.h"
#include "memory.h"
#include "profiler/profiler.h"

bool in_mapped_range(uint32_t addr)
{
    return (addr >= 0xA0000 && addr < 0xC0000) || addr >= *memory_size;
}

int32_t read8(uint32_t addr)
{
    if(USE_A20 && *a20_enabled) addr &= A20_MASK;

    if(in_mapped_range(addr))
    {
        return mmap_read8(addr);
    }
    else
    {
        return mem8[addr];
    }
}

int32_t read16(uint32_t addr)
{
    if(USE_A20 && !*a20_enabled) addr &= A20_MASK;

    if(in_mapped_range(addr))
    {
        return mmap_read16(addr);
    }
    else
    {
        return *(uint16_t*)(mem8 + addr);
    }
}

int32_t read_aligned16(uint32_t addr)
{
    dbg_assert(addr < 0x80000000);
    if(USE_A20 && !*a20_enabled) addr &= A20_MASK16;

    if(in_mapped_range(addr << 1))
    {
        return mmap_read16(addr << 1);
    }
    else
    {
        return mem16[addr];
    }
}

int32_t read32s(uint32_t addr)
{
    if(USE_A20 && *a20_enabled) addr &= A20_MASK;

    if(in_mapped_range(addr))
    {
        return mmap_read32(addr);
    }
    else
    {
        return *(int32_t*)(mem8 + addr);
    }
}

int64_t read64s(uint32_t addr)
{
    if(USE_A20 && *a20_enabled) addr &= A20_MASK;

    if(in_mapped_range(addr))
    {
        return (int64_t)mmap_read32(addr) | (int64_t)mmap_read32(addr + 4) << 32;
    }
    else
    {
        return *(int64_t*)(mem8 + addr);
    }
}

int32_t read_aligned32(uint32_t addr)
{
    dbg_assert(addr < 0x40000000);
    if(USE_A20 && !*a20_enabled) addr &= A20_MASK32;

    if(in_mapped_range(addr << 2))
    {
        return mmap_read32(addr << 2);
    }
    else
    {
        return mem32s[addr];
    }
}

union reg128 read128(uint32_t addr)
{
    if(USE_A20 && *a20_enabled) addr &= A20_MASK;
    union reg128 value = { { 0 } };

    if(in_mapped_range(addr))
    {
        value.i32[0] = mmap_read32(addr);
        value.i32[1] = mmap_read32(addr + 4);
        value.i32[2] = mmap_read32(addr + 8);
        value.i32[3] = mmap_read32(addr + 12);
    }
    else
    {
        value.i64[0] = *(int64_t*)(mem8 + addr);
        value.i64[1] = *(int64_t*)(mem8 + addr + 8);
    }
    return value;
}

void write8(uint32_t addr, int32_t value)
{
    if(USE_A20 && !*a20_enabled) addr &= A20_MASK;

    jit_dirty_cache_single(addr);

    if(in_mapped_range(addr))
    {
        mmap_write8(addr, value);
    }
    else
    {
        mem8[addr] = value;
    }
}

void write16(uint32_t addr, int32_t value)
{
    if(USE_A20 && !*a20_enabled) addr &= A20_MASK;

    jit_dirty_cache_small(addr, addr + 2);

    if(in_mapped_range(addr))
    {
        mmap_write16(addr, value);
    }
    else
    {
        *(uint16_t*)(mem8 + addr) = value;
    }
}

void write_aligned16(uint32_t addr, uint32_t value)
{
    dbg_assert(addr < 0x80000000);
    if(USE_A20 && !*a20_enabled) addr &= A20_MASK16;

    uint32_t phys_addr = addr << 1;
    jit_dirty_cache_small(phys_addr, phys_addr + 2);

    if(in_mapped_range(phys_addr))
    {
        mmap_write16(phys_addr, value);
    }
    else
    {
        mem16[addr] = value;
    }
}

void write32(uint32_t addr, int32_t value)
{
    if(USE_A20 && !*a20_enabled) addr &= A20_MASK;

    jit_dirty_cache_small(addr, addr + 4);

    if(in_mapped_range(addr))
    {
        mmap_write32(addr, value);
    }
    else
    {
        *(int32_t*)(mem8 + addr) = value;
    }
}

void write_aligned32(uint32_t addr, int32_t value)
{
    dbg_assert(addr < 0x40000000);
    if(USE_A20 && !*a20_enabled) addr &= A20_MASK32;

    uint32_t phys_addr = addr << 2;
    jit_dirty_cache_small(phys_addr, phys_addr + 4);

    if(in_mapped_range(phys_addr))
    {
        mmap_write32(phys_addr, value);
    }
    else
    {
        mem32s[addr] = value;
    }
}

void write64(uint32_t addr, int64_t value)
{
    if(USE_A20 && !*a20_enabled) addr &= A20_MASK;

    jit_dirty_cache_small(addr, addr + 8);

    if(in_mapped_range(addr))
    {
        mmap_write32(addr + 0, value & 0xFFFFFFFF);
        mmap_write32(addr + 4, value >> 32);
    }
    else
    {
        *(int64_t*)(mem8 + addr) = value;
    }
}

void write128(uint32_t addr, union reg128 value)
{
    if(USE_A20 && !*a20_enabled) addr &= A20_MASK;

    jit_dirty_cache_small(addr, addr + 16);

    if(in_mapped_range(addr))
    {
        mmap_write128(addr, value.i32[0], value.i32[1], value.i32[2], value.i32[3]);
    }
    else
    {
        *(int64_t*)(mem8 + addr) = value.i64[0];
        *(int64_t*)(mem8 + addr + 8) = value.i64[1];
    }
}
