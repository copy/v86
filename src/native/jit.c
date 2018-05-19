#include <stdint.h>

#include "const.h"
#include "cpu.h"
#include "global_pointers.h"
#include "jit.h"
#include "log.h"
#include "profiler/profiler.h"

void jit_dirty_index(uint32_t index)
{
    int32_t cache_array_index = page_first_jit_cache_entry[index];

    if(cache_array_index != JIT_CACHE_ARRAY_NO_NEXT_ENTRY)
    {
        page_first_jit_cache_entry[index] = JIT_CACHE_ARRAY_NO_NEXT_ENTRY;
        profiler_stat_increment(S_INVALIDATE_PAGE);

        do
        {
            profiler_stat_increment(S_INVALIDATE_CACHE_ENTRY);
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
    for(int32_t i = 0; i < JIT_CACHE_ARRAY_SIZE; i++)
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

int32_t jit_unused_cache_stat()
{
    int32_t count = 0;

    for(int32_t i = 0; i < JIT_CACHE_ARRAY_SIZE; i++)
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
    assert(i >= 0 && i < JIT_CACHE_ARRAY_SIZE);
#if DEBUG
    return jit_cache_arr[i].len;
#else
    UNUSED(i);
    return 0;
#endif
}

int32_t jit_get_entry_address(int32_t i)
{
    assert(i >= 0 && i < JIT_CACHE_ARRAY_SIZE);
    return jit_cache_arr[i].start_addr;
}

int32_t jit_get_entry_pending(int32_t i)
{
    assert(i >= 0 && i < JIT_CACHE_ARRAY_SIZE);
    return jit_cache_arr[i].pending;
}
