#include <stdint.h>
#include <stdbool.h>
#include <assert.h>
#include "const.h"
#include "global_pointers.h"

bool in_mapped_range(uint32_t addr)
{
    return (addr >= 0xA0000 && addr < 0xC0000) || addr >= *memory_size;
}

int32_t mmap_read8(uint32_t);
int32_t mmap_read16(uint32_t);
int32_t mmap_read32(uint32_t);
void mmap_write8(uint32_t, int32_t);
void mmap_write16(uint32_t, int32_t);
void mmap_write32(uint32_t, int32_t);

/*
 * There are 3 primary ways a cached basic block will be dirtied:
 * 1. A write dirties basic block A independently (A is clean and
 * write came from outside A)
 * 2. A write from within basic block A dirties itself
 * 3. A run_instruction during compilation dirties itself

 * #3 won't happen with generate_instruction so we don't
 * account for it
 */
void jit_dirty_cache(uint32_t start_addr, uint32_t end_addr)
{
#if ENABLE_JIT
    assert(start_addr <= end_addr);
    for(uint32_t i = start_addr; i < end_addr; i++)
    {
        uint32_t idx = i >> DIRTY_ARR_SHIFT;
        // XXX: Overflow _can_ cause a stale cache (with
        // group_status=0) to be mistakenly run, but the odds are low
        // since it depends on a compiled block never being
        // re-compiled or evicted for 2^32 times that
        // another block in its group is dirtied
        group_dirtiness[idx]++;

        // We currently limit basic blocks to a length of
        // MAX_BLOCK_LENGTH, which may still cause an overlap of 1
        // page. The ongoing write may write to a block with a
        // starting address lower than the start_addr of the write,
        // i.e. in the previous page.
        // XXX: Consider not generating blocks across boundaries

        if(idx != 0)
        {
            group_dirtiness[idx - 1]++;
        }
    }
#endif
}

void jit_dirty_cache_small(uint32_t start_addr, uint32_t end_addr)
{
#if ENABLE_JIT
    assert(start_addr <= end_addr);

    uint32_t start_index = start_addr >> DIRTY_ARR_SHIFT;
    uint32_t end_index = end_addr >> DIRTY_ARR_SHIFT;

    group_dirtiness[start_index]++;

    if(start_index != 0)
    {
        group_dirtiness[start_index - 1]++;
    }

    if(start_index != end_index)
    {
        assert(end_index == start_index + 1);
        group_dirtiness[end_index]++;
    }
#endif
}

void jit_empty_cache()
{
    assert(false); // XXX: is WASM_TABLE_SIZE correct?
    for(uint32_t i = 0; i < WASM_TABLE_SIZE; i++)
    {
        group_dirtiness[i]++;
    }
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
    dbg_assert(addr >= 0 && addr < 0x80000000);
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

void write8(uint32_t addr, int32_t value)
{
    if(USE_A20 && !*a20_enabled) addr &= A20_MASK;

    jit_dirty_cache_small(addr, addr + 1);

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
    dbg_assert(addr >= 0 && addr < 0x80000000);
    if(USE_A20 && !*a20_enabled) addr &= A20_MASK16;

    uint32_t phys_addr = addr << 1;
    jit_dirty_cache_small(phys_addr, phys_addr + 2);

    if(in_mapped_range(phys_addr))
    {
        mmap_write16(phys_addr, value);
    }
    else
    {
        *(uint16_t*)(mem16 + addr) = value;
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

void write_aligned32(int32_t addr, int32_t value)
{
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
