#include <stdint.h>

#include "const.h"
#include "cpu.h"
#include "global_pointers.h"
#include "jit.h"
#include "js_imports.h"
#include "log.h"
#include "profiler/profiler.h"


void free_wasm_table_index(uint16_t wasm_table_index)
{
#if DEBUG
    for(int32_t i = 0; i < wasm_table_index_free_list_count; i++)
    {
        assert(wasm_table_index_free_list[i] != wasm_table_index);
    }
#endif

    assert(wasm_table_index_free_list_count < WASM_TABLE_SIZE);
    wasm_table_index_free_list[wasm_table_index_free_list_count++] = wasm_table_index;

    // It is not strictly necessary to clear the function, but it will fail
    // more predictably if we accidentally use the function
    // XXX: This fails in Chromium:
    //   RangeError: WebAssembly.Table.set(): Modifying existing entry in table not supported.
    //jit_clear_func(wasm_table_index);
}

// remove the entry with the given index from the jit_cache_arr structure
void remove_jit_cache_entry(uint32_t page, int32_t addr_index)
{
    assert(addr_index != JIT_CACHE_ARRAY_NO_NEXT_ENTRY);
    assert(page == (jit_cache_arr[addr_index].start_addr >> 12));

    int32_t page_index = page_first_jit_cache_entry[page];
    bool did_remove = false;

    if(page_index == addr_index)
    {
        page_first_jit_cache_entry[page] = jit_cache_arr[addr_index].next_index_same_page;
        did_remove = true;
    }
    else
    {
        while(page_index != JIT_CACHE_ARRAY_NO_NEXT_ENTRY)
        {
            int32_t next_index = jit_cache_arr[page_index].next_index_same_page;
            if(next_index == addr_index)
            {
                jit_cache_arr[page_index].next_index_same_page = jit_cache_arr[addr_index].next_index_same_page;
                did_remove = true;
                break;
            }
            page_index = next_index;
        }
    }

    assert(did_remove);
}

// remove all entries with the given wasm_table_index from the jit_cache_arr structure
void remove_jit_cache_wasm_index(int32_t page, uint16_t wasm_table_index)
{
    int32_t cache_array_index = page_first_jit_cache_entry[page];

    assert(cache_array_index != JIT_CACHE_ARRAY_NO_NEXT_ENTRY);

    bool pending = false;

    do
    {
        struct code_cache* entry = &jit_cache_arr[cache_array_index];
        int32_t next_cache_array_index = entry->next_index_same_page;

        if(entry->wasm_table_index == wasm_table_index)
        {
            // if one entry is pending, all must be pending
            dbg_assert(!pending || entry->pending);

            pending = entry->pending;

            remove_jit_cache_entry(page, cache_array_index);

            entry->next_index_same_page = JIT_CACHE_ARRAY_NO_NEXT_ENTRY;
            entry->wasm_table_index = 0;
            entry->start_addr = 0;
            entry->pending = false;
        }

        cache_array_index = next_cache_array_index;
    }
    while(cache_array_index != JIT_CACHE_ARRAY_NO_NEXT_ENTRY);

    if(pending)
    {
        assert(wasm_table_index_pending_free_count < WASM_TABLE_SIZE);
        wasm_table_index_pending_free[wasm_table_index_pending_free_count++] = wasm_table_index;
    }
    else
    {
        free_wasm_table_index(wasm_table_index);
    }
}

bool find_u16(const uint16_t* array, uint16_t value, int32_t length)
{
    for(int32_t i = 0; i < length; i++)
    {
        if(array[i] == value)
        {
            return true;
        }
    }

    return false;
}

__attribute__((noinline))
void jit_clear_page(uint32_t index)
{
    assert(index < MAX_PHYSICAL_PAGES);
    int32_t cache_array_index = page_first_jit_cache_entry[index];

    assert(cache_array_index != JIT_CACHE_ARRAY_NO_NEXT_ENTRY);

    uint16_t index_to_free[100];
    int32_t index_to_free_length = 0;

    uint16_t index_to_pending_free[100];
    int32_t index_to_pending_free_length = 0;

    page_first_jit_cache_entry[index] = JIT_CACHE_ARRAY_NO_NEXT_ENTRY;
    profiler_stat_increment(S_INVALIDATE_PAGE);

    do
    {
        profiler_stat_increment(S_INVALIDATE_CACHE_ENTRY);
        struct code_cache* entry = &jit_cache_arr[cache_array_index];
        uint16_t wasm_table_index = entry->wasm_table_index;

        assert(same_page(index << DIRTY_ARR_SHIFT, entry->start_addr));

        int32_t next_cache_array_index = entry->next_index_same_page;

        entry->next_index_same_page = JIT_CACHE_ARRAY_NO_NEXT_ENTRY;
        entry->start_addr = 0;
        entry->wasm_table_index = 0;

        if(entry->pending)
        {
            entry->pending = false;

            if(!find_u16(index_to_pending_free, wasm_table_index, index_to_pending_free_length))
            {
                assert(index_to_pending_free_length < 100);
                index_to_pending_free[index_to_pending_free_length++] = wasm_table_index;
            }
        }
        else
        {
            if(!find_u16(index_to_free, wasm_table_index, index_to_free_length))
            {
                assert(index_to_free_length < 100);
                index_to_free[index_to_free_length++] = wasm_table_index;
            }
        }

        cache_array_index = next_cache_array_index;
    }
    while(cache_array_index != JIT_CACHE_ARRAY_NO_NEXT_ENTRY);

    for(int32_t i = 0; i < index_to_free_length; i++)
    {
        free_wasm_table_index(index_to_free[i]);
    }

    for(int32_t i = 0; i < index_to_pending_free_length; i++)
    {
        uint16_t wasm_table_index = index_to_pending_free[i];
        assert(wasm_table_index_pending_free_count < WASM_TABLE_SIZE);
        wasm_table_index_pending_free[wasm_table_index_pending_free_count++] = wasm_table_index;
    }

    check_jit_cache_array_invariants();
}

void jit_dirty_index(uint32_t index)
{
    assert(index < MAX_PHYSICAL_PAGES);
    int32_t cache_array_index = page_first_jit_cache_entry[index];

    if(cache_array_index != JIT_CACHE_ARRAY_NO_NEXT_ENTRY)
    {
        jit_clear_page(index);
    }

    uint16_t* entry_points = page_entry_points[index];

    if(entry_points[0] != ENTRY_POINT_END)
    {
        // don't try to compile code in this page anymore until it's hot again
        hot_code_addresses[jit_hot_hash_page(index)] = 0;

        for(int32_t i = 0; i < MAX_ENTRIES_PER_PAGE; i++)
        {
            if(entry_points[i] == ENTRY_POINT_END)
            {
                break;
            }

            entry_points[i] = ENTRY_POINT_END;
        }

#if DEBUG
        for(int32_t i = 0; i < MAX_ENTRIES_PER_PAGE; i++)
        {
            assert(entry_points[i] == ENTRY_POINT_END);
        }
#endif
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
        jit_cache_arr[i].pending = false;
    }

    for(int32_t i = 0; i < GROUP_DIRTINESS_LENGTH; i++)
    {
        page_first_jit_cache_entry[i] = JIT_CACHE_ARRAY_NO_NEXT_ENTRY;
    }

    for(int32_t i = 0; i < MAX_PHYSICAL_PAGES; i++)
    {
        uint16_t* entry_points = page_entry_points[i];

        for(int32_t j = 0; j < MAX_ENTRIES_PER_PAGE; j++)
        {
            entry_points[j] = ENTRY_POINT_END;
        }
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
