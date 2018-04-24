#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

#include "const.h"
#include "global_pointers.h"
#include "js_imports.h"
#include "log.h"
#include "memory.h"

bool in_mapped_range(uint32_t addr)
{
    return (addr >= 0xA0000 && addr < 0xC0000) || addr >= *memory_size;
}

void jit_dirty_index(uint32_t index)
{
    int32_t cache_array_index = page_first_jit_cache_entry[index];

    if(cache_array_index != JIT_CACHE_ARRAY_NO_NEXT_ENTRY)
    {
        page_first_jit_cache_entry[index] = JIT_CACHE_ARRAY_NO_NEXT_ENTRY;

        do
        {
            struct code_cache* entry = &jit_cache_arr[cache_array_index];

            assert(same_page(index << DIRTY_ARR_SHIFT, entry->start_addr));
            entry->start_addr = 0;
            entry->wasm_table_index = 0;

            // TODO: Free wasm table index

            cache_array_index = entry->next_index_same_page;

            entry->next_index_same_page = 0;
        }
        while(cache_array_index != JIT_CACHE_ARRAY_NO_NEXT_ENTRY);
    }
}

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
        uint32_t index = i >> DIRTY_ARR_SHIFT;
        // XXX: Should only call once per index
        jit_dirty_index(index);
    }
#endif
}

void jit_dirty_cache_small(uint32_t start_addr, uint32_t end_addr)
{
#if ENABLE_JIT
    assert(start_addr <= end_addr);

    uint32_t start_index = start_addr >> DIRTY_ARR_SHIFT;
    uint32_t end_index = (end_addr - 1) >> DIRTY_ARR_SHIFT;

    jit_dirty_index(start_index);

    // Note: This can't happen when paging is enabled, as writes across
    //       boundaries are split up on two pages
    if(start_index != end_index)
    {
        assert(end_index == start_index + 1);
        jit_dirty_index(end_index);
    }
#endif
}

void jit_dirty_cache_single(uint32_t addr)
{
#if ENABLE_JIT
    uint32_t index = addr >> DIRTY_ARR_SHIFT;

    jit_dirty_index(index);
#endif
}

void jit_empty_cache()
{
    for(int32_t i = 0; i < WASM_TABLE_SIZE; i++)
    {
        jit_cache_arr[i].start_addr = 0;
        jit_cache_arr[i].next_index_same_page = JIT_CACHE_ARRAY_NO_NEXT_ENTRY;
        jit_cache_arr[i].wasm_table_index = 0;
    }

    for(int32_t i = 0; i < GROUP_DIRTINESS_LENGTH; i++)
    {
        page_first_jit_cache_entry[i] = JIT_CACHE_ARRAY_NO_NEXT_ENTRY;
    }

    for(int32_t i = 0; i < 0xFFFF; i++)
    {
        // don't assign 0 (XXX: Check)
        wasm_table_index_free_list[i] = i + 1;
    }

    wasm_table_index_free_list_count = 0xFFFF;
}

int32_t jit_invalid_cache_stat()
{
    return 0; // XXX: This stat doesn't make sense anymore after immediate cleaning
}

int32_t jit_unused_cache_stat()
{
    int32_t count = 0;

    for(int32_t i = 0; i < WASM_TABLE_SIZE; i++)
    {
        struct code_cache* entry = &jit_cache_arr[i];
        int32_t phys_addr = entry->start_addr;

        if(phys_addr == 0)
        {
            count++;
        }
    }

    return count;
}

int32_t jit_get_entry_length(int32_t i)
{
    assert(i >= 0 && i < WASM_TABLE_SIZE);
#if DEBUG
    return jit_cache_arr[i].len;
#else
    UNUSED(i);
    return 0;
#endif
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
