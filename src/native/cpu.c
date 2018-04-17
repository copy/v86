#include <assert.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

#include "codegen/codegen.h"
#include "const.h"
#include "cpu.h"
#include "global_pointers.h"
#include "instructions.h"
#include "js_imports.h"
#include "log.h"
#include "memory.h"
#include "misc_instr.h"
#include "modrm.h"
#include "profiler/profiler.h"
#include "shared.h"

#if DEBUG
struct code_cache jit_cache_arr[WASM_TABLE_SIZE] = {{0, 0, {0}, 0, 0, 0, 0, false}};
#else
struct code_cache jit_cache_arr[WASM_TABLE_SIZE] = {{0, 0, 0, 0, false}};
#endif

uint64_t tsc_offset = 0;

uint32_t jit_block_boundary = 0;
int32_t hot_code_addresses[HASH_PRIME] = {0};
uint32_t group_dirtiness[GROUP_DIRTINESS_LENGTH] = {0};

int32_t tlb_data[0x100000] = {0};
int32_t valid_tlb_entries[VALID_TLB_ENTRY_MAX] = {0};
int32_t valid_tlb_entries_count = 0;

void after_block_boundary()
{
    jit_block_boundary = true;
}

int32_t get_eflags()
{
    return (*flags & ~FLAGS_ALL) | !!getcf() | !!getpf() << 2 | !!getaf() << 4 |
                                  !!getzf() << 6 | !!getsf() << 7 | !!getof() << 11;
}

int32_t getiopl(void)
{
    return *flags >> 12 & 3;
}

bool vm86_mode(void)
{
    return (*flags & FLAG_VM) == FLAG_VM;
}

/*
 * Update the flags register depending on iopl and cpl
 */
void update_eflags(int32_t new_flags)
{
    int32_t dont_update = FLAG_RF | FLAG_VM | FLAG_VIP | FLAG_VIF;
    int32_t clear = ~FLAG_VIP & ~FLAG_VIF & FLAGS_MASK;

    if(*flags & FLAG_VM)
    {
        // other case needs to be handled in popf or iret
        dbg_assert(getiopl() == 3);

        dont_update |= FLAG_IOPL;

        // don't clear vip or vif
        clear |= FLAG_VIP | FLAG_VIF;
    }
    else
    {
        if(!*protected_mode) dbg_assert(*cpl == 0);

        if(*cpl)
        {
            // cpl > 0
            // cannot update iopl
            dont_update |= FLAG_IOPL;

            if(*cpl > getiopl())
            {
                // cpl > iopl
                // cannot update interrupt flag
                dont_update |= FLAG_INTERRUPT;
            }
        }
    }

    *flags = (new_flags ^ ((*flags ^ new_flags) & dont_update)) & clear | FLAGS_DEFAULT;

    *flags_changed = 0;
}

void trigger_pagefault(bool write, bool user, bool present)
{
    if(LOG_PAGE_FAULTS)
    {
        dbg_log("page fault w=%d u=%d p=%d eip=%x cr2=%x",
                write, user, present, *previous_ip, cr[2]);
        dbg_trace();
    }

    if(*page_fault)
    {
        dbg_log("double fault");
        dbg_trace();
        assert(false);
    }

    // invalidate tlb entry
    int32_t page = (uint32_t)cr[2] >> 12;
    tlb_data[page] = 0;

    *instruction_pointer = *previous_ip;
    *page_fault = true;
    call_interrupt_vector(14, false, true, user << 2 | write << 1 | present);

    throw_cpu_exception();
}

int32_t do_page_translation(int32_t addr, bool for_writing, bool user)
{
    int32_t page = (uint32_t)addr >> 12;
    int32_t page_dir_addr = ((uint32_t)cr[3] >> 2) + (page >> 10);
    int32_t page_dir_entry = read_aligned32(page_dir_addr);
    int32_t high;
    bool can_write = true;
    bool global;
    bool allow_user = true;

    const bool kernel_write_override = !user && !(cr[0] & CR0_WP);

    if(!(page_dir_entry & PAGE_TABLE_PRESENT_MASK))
    {
        // to do at this place:
        //
        // - set cr2 = addr (which caused the page fault)
        // - call_interrupt_vector  with id 14, error code 0-7 (requires information if read or write)
        // - prevent execution of the function that triggered this call
        //dbg_log("#PF not present", LOG_CPU);

        cr[2] = addr;
        trigger_pagefault(for_writing, user, 0);

        // never reached as trigger_pagefault throws
        dbg_assert(false);
    }

    if((page_dir_entry & PAGE_TABLE_RW_MASK) == 0 && !kernel_write_override)
    {
        can_write = false;

        if(for_writing)
        {
            cr[2] = addr;
            trigger_pagefault(for_writing, user, 1);
            dbg_assert(false);
        }
    }

    if((page_dir_entry & PAGE_TABLE_USER_MASK) == 0)
    {
        allow_user = false;

        if(user)
        {
            // "Page Fault: page table accessed by non-supervisor";
            //dbg_log("#PF supervisor", LOG_CPU);
            cr[2] = addr;
            trigger_pagefault(for_writing, user, 1);
            dbg_assert(false);
        }
    }

    if(page_dir_entry & *page_size_extensions)
    {
        // size bit is set

        // set the accessed and dirty bits
        write_aligned32(page_dir_addr, page_dir_entry | PAGE_TABLE_ACCESSED_MASK |
            (for_writing ? PAGE_TABLE_DIRTY_MASK : 0));

        high = (page_dir_entry & 0xFFC00000) | (addr & 0x3FF000);
        global = (page_dir_entry & PAGE_TABLE_GLOBAL_MASK) == PAGE_TABLE_GLOBAL_MASK;
    }
    else
    {
        int32_t page_table_addr = ((uint32_t)(page_dir_entry & 0xFFFFF000) >> 2) + (page & 0x3FF);
        int32_t page_table_entry = read_aligned32(page_table_addr);

        if((page_table_entry & PAGE_TABLE_PRESENT_MASK) == 0)
        {
            //dbg_log("#PF not present table", LOG_CPU);
            cr[2] = addr;
            trigger_pagefault(for_writing, user, 0);
            dbg_assert(false);
        }

        if((page_table_entry & PAGE_TABLE_RW_MASK) == 0 && !kernel_write_override)
        {
            can_write = false;

            if(for_writing)
            {
                //dbg_log("#PF not writable page", LOG_CPU);
                cr[2] = addr;
                trigger_pagefault(for_writing, user, 1);
                dbg_assert(false);
            }
        }

        if((page_table_entry & PAGE_TABLE_USER_MASK) == 0)
        {
            allow_user = false;

            if(user)
            {
                //dbg_log("#PF not supervisor page", LOG_CPU);
                cr[2] = addr;
                trigger_pagefault(for_writing, user, 1);
                dbg_assert(false);
            }
        }

        // set the accessed and dirty bits
        write_aligned32(page_dir_addr, page_dir_entry | PAGE_TABLE_ACCESSED_MASK);
        write_aligned32(page_table_addr,
                page_table_entry | PAGE_TABLE_ACCESSED_MASK |
                (for_writing ? PAGE_TABLE_DIRTY_MASK : 0));

        high = page_table_entry & 0xFFFFF000;
        global = (page_table_entry & PAGE_TABLE_GLOBAL_MASK) == PAGE_TABLE_GLOBAL_MASK;
    }

    if(tlb_data[page] == 0)
    {
        if(valid_tlb_entries_count == VALID_TLB_ENTRY_MAX)
        {
            profiler_stat_increment(S_TLB_FULL);
            clear_tlb();

            // also clear global entries if tlb is almost full after clearing non-global pages
            if(valid_tlb_entries_count > VALID_TLB_ENTRY_MAX * 3 / 4)
            {
                profiler_stat_increment(S_TLB_GLOBAL_FULL);
                full_clear_tlb();
            }
        }

        assert(valid_tlb_entries_count < VALID_TLB_ENTRY_MAX);
        valid_tlb_entries[valid_tlb_entries_count++] = page;
    }
    else
    {
#if CHECK_TLB_INVARIANTS
        bool found = false;

        for(int32_t i = 0; i < valid_tlb_entries_count; i++)
        {
            if(valid_tlb_entries[i] == page)
            {
                found = true;
                break;
            }
        }

        assert(found);
#endif
    }

    int32_t info_bits =
        TLB_VALID |
        (can_write ? 0 : TLB_READONLY) |
        (allow_user ? 0 : TLB_NO_USER) |
        (in_mapped_range(high) ? TLB_IN_MAPPED_RANGE : 0) |
        (global && (cr[4] & CR4_PGE) ? TLB_GLOBAL : 0);

    assert(((high ^ page << 12) & 0xFFF) == 0);
    tlb_data[page] = high ^ page << 12 | info_bits;

    return high;
}

void writable_or_pagefault(int32_t addr, int32_t size)
{
    dbg_assert(size < 0x1000);
    dbg_assert(size > 0);

    if(!*paging)
    {
        return;
    }

    bool user = cpl[0] == 3;
    int32_t mask = TLB_READONLY | TLB_VALID | (user ? TLB_NO_USER : 0);
    int32_t expect = TLB_VALID;
    int32_t page = (uint32_t)addr >> 12;

    if((tlb_data[page] & mask) == expect)
    {
        do_page_translation(addr, true, user);
    }

    if((addr & 0xFFF) + size - 1 >= 0x1000)
    {
        // XXX: possibly out of bounds
        if((tlb_data[page + 1] & mask) == expect)
        {
            do_page_translation(addr + size - 1, true, user);
        }
    }
}

uint32_t translate_address_read(int32_t address)
{
    if(!*paging) return address;

    int32_t base = (uint32_t)address >> 12;
    int32_t entry = tlb_data[base];
    bool user = cpl[0] == 3;
    if((entry & (TLB_VALID | (user ? TLB_NO_USER : 0))) == TLB_VALID)
    {
        return entry & ~0xFFF ^ address;
    }
    else
    {
        return do_page_translation(address, false, user) | address & 0xFFF;
    }
}

uint32_t translate_address_write(int32_t address)
{
    if(!*paging) return address;

    int32_t base = (uint32_t)address >> 12;
    int32_t entry = tlb_data[base];
    bool user = cpl[0] == 3;
    if((entry & (TLB_VALID | (user ? TLB_NO_USER : 0) | TLB_READONLY)) == TLB_VALID)
    {
        return entry & ~0xFFF ^ address;
    }
    else
    {
        return do_page_translation(address, true, user) | address & 0xFFF;
    }
}

uint32_t translate_address_system_read(int32_t address)
{
    if(!*paging) return address;

    int32_t base = (uint32_t)address >> 12;
    int32_t entry = tlb_data[base];
    if(entry & TLB_VALID)
    {
        return entry & ~0xFFF ^ address;
    }
    else
    {
        return do_page_translation(address, false, false) | address & 0xFFF;
    }
}

uint32_t translate_address_system_write(int32_t address)
{
    if(!*paging) return address;

    int32_t base = (uint32_t)address >> 12;
    int32_t entry = tlb_data[base];
    if((entry & (TLB_VALID | TLB_READONLY)) == TLB_VALID)
    {
        return entry & ~0xFFF ^ address;
    }
    else
    {
        return do_page_translation(address, true, false) | address & 0xFFF;
    }
}

int32_t get_phys_eip()
{
    int32_t eip = *instruction_pointer;

    if((eip & ~0xFFF) ^ *last_virt_eip)
    {
        *eip_phys = translate_address_read(eip) ^ eip;
        *last_virt_eip = eip & ~0xFFF;
    }

    uint32_t phys_addr = *eip_phys ^ eip;
    assert(!in_mapped_range(phys_addr));
    return phys_addr;
}

int32_t read_imm8()
{
    int32_t eip = *instruction_pointer;

    if((eip & ~0xFFF) ^ *last_virt_eip)
    {
        *eip_phys = translate_address_read(eip) ^ eip;
        *last_virt_eip = eip & ~0xFFF;
    }

    assert(!in_mapped_range(*eip_phys ^ eip));
    int32_t data8 = mem8[*eip_phys ^ eip];
    *instruction_pointer = eip + 1;

    return data8;
}

int32_t read_imm8s()
{
    return read_imm8() << 24 >> 24;
}

int32_t read_imm16()
{
    // Two checks in one comparison:
    //    1. Did the high 20 bits of eip change
    // or 2. Are the low 12 bits of eip 0xFFF (and this read crosses a page boundary)
    if((uint32_t)(*instruction_pointer ^ *last_virt_eip) > 0xFFE)
    {
        return read_imm8() | read_imm8() << 8;
    }

    int32_t data16 = read16(*eip_phys ^ *instruction_pointer);
    *instruction_pointer = *instruction_pointer + 2;

    return data16;
}

int32_t read_imm32s()
{
    // Analogue to the above comment
    if((uint32_t)(*instruction_pointer ^ *last_virt_eip) > 0xFFC)
    {
        return read_imm16() | read_imm16() << 16;
    }

    int32_t data32 = read32s(*eip_phys ^ *instruction_pointer);
    *instruction_pointer = *instruction_pointer + 4;

    return data32;
}

bool is_osize_32()
{
    return *is_32 != ((*prefixes & PREFIX_MASK_OPSIZE) == PREFIX_MASK_OPSIZE);
}

bool is_asize_32()
{
    return *is_32 != ((*prefixes & PREFIX_MASK_ADDRSIZE) == PREFIX_MASK_ADDRSIZE);
}

int32_t get_seg(int32_t segment)
{
    assert(segment >= 0 && segment < 8);

    // TODO: Remove protected_mode check
    if(*protected_mode)
    {
        if(segment_is_null[segment])
        {
            assert(segment != CS && segment != SS);
            dbg_log("#gp: Access null segment");
            trigger_gp(0);
        }
    }

    return segment_offsets[segment];
}

int32_t get_seg_cs(void)
{
    return segment_offsets[CS];
}

int32_t get_seg_ss(void)
{
    return segment_offsets[SS];
}

int32_t get_seg_prefix(int32_t default_segment)
{
    int32_t prefix = *prefixes & PREFIX_MASK_SEGMENT;

    if(prefix)
    {
        if(prefix == SEG_PREFIX_ZERO)
        {
            return 0; // TODO: Remove this special case
        }
        else
        {
            return get_seg(prefix - 1);
        }
    }
    else
    {
        return get_seg(default_segment);
    }
}

int32_t get_seg_prefix_ds(int32_t offset) { return get_seg_prefix(DS) + offset; }
int32_t get_seg_prefix_ss(int32_t offset) { return get_seg_prefix(SS) + offset; }
int32_t get_seg_prefix_cs(int32_t offset) { return get_seg_prefix(CS) + offset; }

int32_t modrm_resolve(int32_t modrm_byte)
{
    if(is_asize_32())
    {
        return resolve_modrm32(modrm_byte);
    }
    else
    {
        return resolve_modrm16(modrm_byte);
    }
}

void modrm_skip(int32_t modrm_byte)
{
    // TODO: More efficient implementation is possible
    modrm_resolve(modrm_byte);
}

uint32_t jit_hot_hash(uint32_t addr)
{
    return addr % HASH_PRIME;
}

static void jit_run_interpreted(int32_t phys_addr)
{
    profiler_start(P_RUN_INTERPRETED);
    profiler_stat_increment(S_RUN_INTERPRETED);

    jit_block_boundary = false;

#if DUMP_UNCOMPILED_ASSEMBLY
    int32_t start_eip = phys_addr;
    int32_t end_eip = start_eip;
#endif

    assert(!in_mapped_range(phys_addr));
    int32_t opcode = mem8[phys_addr];
    (*instruction_pointer)++;
    (*timestamp_counter)++;

#if DEBUG
    logop(previous_ip[0], opcode);
#endif

    run_instruction(opcode | !!*is_32 << 8);

#if DUMP_UNCOMPILED_ASSEMBLY
    if(!jit_block_boundary)
    {
        *previous_ip = *instruction_pointer;
        end_eip = get_phys_eip();
    }
#endif

    while(!jit_block_boundary)
    {
        previous_ip[0] = instruction_pointer[0];
        (*timestamp_counter)++;

        int32_t opcode = read_imm8();

#if DEBUG
    logop(previous_ip[0], opcode);
#endif
        run_instruction(opcode | !!*is_32 << 8);

#if DUMP_UNCOMPILED_ASSEMBLY
        if(!jit_block_boundary)
        {
            *previous_ip = *instruction_pointer;
            end_eip = get_phys_eip();
        }
#endif
    }

#if DUMP_UNCOMPILED_ASSEMBLY
    log_uncompiled_code(start_eip, end_eip);
#endif
    profiler_end(P_RUN_INTERPRETED);
}

bool has_flat_segmentation(void)
{
    return !segment_is_null[SS] && segment_offsets[SS] == 0 &&
        !segment_is_null[DS] && segment_offsets[DS] == 0;
}

static cached_state_flags pack_current_state_flags()
{
    return *is_32 << 0 | *stack_size_32 << 1 | has_flat_segmentation() << 2;
}

static struct code_cache* create_cache_entry(uint32_t phys_addr)
{
    for(int32_t i = 0; i < CODE_CACHE_SEARCH_SIZE; i++)
    {
        uint16_t addr_index = (phys_addr + i) & JIT_PHYS_MASK;
        struct code_cache* entry = &jit_cache_arr[addr_index];

        uint32_t page_dirtiness = group_dirtiness[entry->start_addr >> DIRTY_ARR_SHIFT];

        if(!entry->start_addr || entry->group_status != page_dirtiness)
        {
            if(i > 0)
            {
                dbg_log("Inserted cache entry at %d for addr %x | 0=%x", i,
                        phys_addr, jit_cache_arr[addr_index - 1].start_addr);
            }

            entry->wasm_table_index = addr_index;
            return entry;
        }
    }

    // no free slots, overwrite the first one
    uint16_t addr_index = phys_addr & JIT_PHYS_MASK;
    struct code_cache* entry = &jit_cache_arr[addr_index];
    entry->wasm_table_index = addr_index;

    profiler_stat_increment(S_CACHE_MISMATCH);
    return entry;
}

static bool is_near_end_of_page(uint32_t addr)
{
    return (addr & 0xFFF) >= (0x1000 - 16);
}

static bool same_page(int32_t addr1, int32_t addr2)
{
    return (addr1 & ~0xFFF) == (addr2 & ~0xFFF);
}

static void jit_generate_basic_block(int32_t start_addr, int32_t stop_addr)
{
    uint32_t len = 0;
    jit_block_boundary = false;

    int32_t end_addr;
    bool was_block_boundary = false;
    int32_t eip_delta = 0;

    *instruction_pointer = start_addr;

    // First iteration of do-while assumes the caller confirms this condition
    assert(!is_near_end_of_page(start_addr));

    do
    {
        *previous_ip = *instruction_pointer;
        int32_t opcode = read_imm8();

        int32_t start_eip = *instruction_pointer - 1;
        jit_instr_flags jit_ret = jit_instruction(opcode | !!*is_32 << 8);
        int32_t end_eip = *instruction_pointer;

        int32_t instruction_length = end_eip - start_eip;
        // XXX: There may be more instructions that form a block boundary than just jumps, but the
        // granularity isn't very important since jumps are the majority
        was_block_boundary = (jit_ret & JIT_INSTR_BLOCK_BOUNDARY_FLAG) != 0;

        assert(instruction_length >= 0 && instruction_length < 16);

#if ENABLE_JIT_NONFAULTING_OPTIMZATION
        /*
         * There are a few conditions to keep in mind to optimize the update of previous_ip and
         * instruction_pointer:
         * - previous_ip MUST be updated just before a faulting instruction
         * - instruction_pointer MUST be updated before jump instructions (since they use the EIP
         * value for instruction logic)
         * - Nonfaulting instructions don't need either to be updated
         */
        if(was_block_boundary)
        {
            // prev_ip = eip + eip_delta, so that previous_ip points to the start of this instruction
            gen_set_previous_eip_offset_from_eip(eip_delta);

            // eip += eip_delta + len(jump) so instruction logic uses the correct eip
            gen_increment_instruction_pointer(eip_delta + instruction_length);
            gen_commit_instruction_body_to_cs();

            eip_delta = 0;
        }
        else if((jit_ret & JIT_INSTR_NONFAULTING_FLAG) == 0)
        {
            // Faulting instruction

            // prev_ip = eip + eip_delta, so that previous_ip points to the start of this instruction
            gen_set_previous_eip_offset_from_eip(eip_delta);
            gen_commit_instruction_body_to_cs();

            // Leave this instruction's length to be updated in the next batch, whatever it may be
            eip_delta += instruction_length;
        }
        else
        {
            // Non-faulting, so we skip setting previous_ip and simply queue the instruction length
            // for whenever eip is updated next
            profiler_stat_increment(S_NONFAULTING_OPTIMIZATION);
            eip_delta += instruction_length;
        }
#else
        UNUSED(eip_delta);
        gen_set_previous_eip();
        gen_increment_instruction_pointer(instruction_length);
        gen_commit_instruction_body_to_cs();
#endif
        end_addr = *instruction_pointer;
        len++;
    }
    while(!was_block_boundary &&
            !is_near_end_of_page(*instruction_pointer) &&
            *instruction_pointer != stop_addr);

#if ENABLE_JIT_NONFAULTING_OPTIMZATION
    // When the block ends in a non-jump instruction, we may have uncommitted updates still
    if(eip_delta > 0)
    {
        gen_commit_instruction_body_to_cs();
        gen_increment_instruction_pointer(eip_delta);
    }
#endif

    gen_increment_timestamp_counter(len);

    // no page was crossed
    assert(same_page(end_addr, start_addr));

    jit_block_boundary = false;
    assert(*prefixes == 0);
}

void codegen_finalize_finished(
        int32_t wasm_table_index, uint32_t phys_addr, uint32_t end_addr,
        int32_t first_opcode, cached_state_flags state_flags, uint32_t page_dirtiness)
{
    if(page_dirtiness == group_dirtiness[phys_addr >> DIRTY_ARR_SHIFT])
    {
        struct code_cache* entry = &jit_cache_arr[wasm_table_index];

        // XXX: May end up in this branch when entry is overwritten due to full
        //      cache, causing the assertions below to fail

        // sanity check that we're looking at the right entry
        assert(entry->pending);
        assert(entry->group_status == page_dirtiness);
        assert(entry->start_addr == phys_addr);
        assert(entry->state_flags == state_flags);
        UNUSED(page_dirtiness);
        UNUSED(phys_addr);
        UNUSED(state_flags);
        UNUSED(end_addr);
        UNUSED(first_opcode);

        entry->pending = false;
    }
    else
    {
        // the page has been written, drop this entry
    }
}

static struct code_cache* find_cache_entry(uint32_t phys_addr)
{
    cached_state_flags state_flags = pack_current_state_flags();

#pragma clang loop unroll_count(CODE_CACHE_SEARCH_SIZE)
    for(int32_t i = 0; i < CODE_CACHE_SEARCH_SIZE; i++)
    {
        uint16_t addr_index = (phys_addr + i) & JIT_PHYS_MASK;
        struct code_cache* entry = &jit_cache_arr[addr_index];

        if(entry->start_addr == phys_addr && entry->state_flags == state_flags)
        {
            return entry;
        }
    }

    return NULL;
}

struct code_cache* find_link_block_target(int32_t target)
{
    int32_t eip = *previous_ip;

    if(same_page(eip, target))
    {
        assert((eip & ~0xFFF) == *last_virt_eip);
        assert((target & ~0xFFF) == *last_virt_eip);

        uint32_t phys_target = *eip_phys ^ target;
        struct code_cache* entry = find_cache_entry(phys_target);

        if(entry &&
                !entry->pending &&
                entry->group_status == group_dirtiness[entry->start_addr >> DIRTY_ARR_SHIFT])
        {
            return entry;
        }
    }

    return NULL;
}

void jit_link_block_conditional(int32_t offset, const char* condition)
{
    // Note: block linking cannot rely on the absolute value of eip, as blocks
    // are stored at their *physical* address, which can be executed from
    // multiple *virtual* addresses. Due to this, we cannot insert the value of
    // eip into generated code

    // This is currently unused, the jump is generated in after analysis
    UNUSED(offset);
    UNUSED(condition);
}

struct analysis analyze_prefix_instruction()
{
    return analyze_step(read_imm8() | is_osize_32() << 8);
}

struct analysis instr_26_analyze() { return analyze_prefix_instruction(); }
struct analysis instr_2E_analyze() { return analyze_prefix_instruction(); }
struct analysis instr_36_analyze() { return analyze_prefix_instruction(); }
struct analysis instr_3E_analyze() { return analyze_prefix_instruction(); }
struct analysis instr_64_analyze() { return analyze_prefix_instruction(); }
struct analysis instr_65_analyze() { return analyze_prefix_instruction(); }
struct analysis instr_66_analyze() {
    *prefixes |= PREFIX_MASK_OPSIZE;
    struct analysis result = analyze_prefix_instruction();
    *prefixes = 0;
    return result;
}
struct analysis instr_67_analyze() {
    *prefixes |= PREFIX_MASK_ADDRSIZE;
    struct analysis result = analyze_prefix_instruction();
    *prefixes = 0;
    return result;
}
struct analysis instr_F0_analyze() { return analyze_prefix_instruction(); }
struct analysis instr_F2_analyze() {
    *prefixes |= PREFIX_F2;
    struct analysis result = analyze_prefix_instruction();
    *prefixes = 0;
    return result;
}
struct analysis instr_F3_analyze() {
    *prefixes |= PREFIX_F3;
    struct analysis result = analyze_prefix_instruction();
    *prefixes = 0;
    return result;
}

struct analysis instr16_0F_analyze()
{
    int32_t opcode = read_imm8();
    struct analysis analysis = { .flags = 0, .jump_offset = 0, .condition_index = -1 };
#include "../../build/analyzer0f_16.c"
    return analysis;
}
struct analysis instr32_0F_analyze()
{
    int32_t opcode = read_imm8();
    struct analysis analysis = { .flags = 0, .jump_offset = 0, .condition_index = -1 };
#include "../../build/analyzer0f_32.c"
    return analysis;
}

struct analysis analyze_step(int32_t opcode)
{
    struct analysis analysis = { .flags = 0, .jump_offset = 0, .condition_index = -1 };
#include "../../build/analyzer.c"
    return analysis;
}

int32_t find_basic_block_index(const struct basic_block_list* basic_blocks, int32_t addr)
{
    for(int32_t i = 0; i < basic_blocks->length; i++)
    {
        if(basic_blocks->blocks[i].addr == addr)
        {
            return i;
        }
    }

    return -1;
}

bool is_sorted_and_unique(const struct basic_block_list* basic_blocks)
{
    for(int32_t i = 0; i < basic_blocks->length - 1; i++)
    {
        if(basic_blocks->blocks[i].addr >= basic_blocks->blocks[i + 1].addr)
        {
            return false;
        }
    }

    return true;
}

struct basic_block* add_basic_block_start(struct basic_block_list* basic_blocks, int32_t addr)
{
    assert(basic_blocks->length < BASIC_BLOCK_LIST_MAX);
    assert(find_basic_block_index(basic_blocks, addr) == -1);

    // sorted insert
    int32_t index_to_insert = -1;

    for(int32_t i = 0; i < basic_blocks->length; i++)
    {
        assert(basic_blocks->blocks[i].addr != addr);

        if(basic_blocks->blocks[i].addr > addr)
        {
            // make space
            for(int32_t j = basic_blocks->length - 1; j >= i; j--)
            {
                basic_blocks->blocks[j + 1] = basic_blocks->blocks[j];
            }

            assert(basic_blocks->blocks[i].addr == basic_blocks->blocks[i + 1].addr);

            index_to_insert = i;
            break;
        }
    }

    if(index_to_insert == -1)
    {
        // if we're here addr is larger than all existing basic blocks or basic blocks is empty
        assert(basic_blocks->length == 0 ||
                basic_blocks->blocks[basic_blocks->length - 1].addr < addr);

        index_to_insert = basic_blocks->length;
    }

    basic_blocks->blocks[index_to_insert].addr = addr;
    basic_blocks->length++;

    assert(is_sorted_and_unique(basic_blocks));

    if(index_to_insert != 0)
    {
        struct basic_block* previous_block = &basic_blocks->blocks[index_to_insert - 1];

        if(previous_block->end_addr > addr)
        {
            // Split the previous block as it would overlap otherwise; change
            // it to continue at this block

            previous_block->end_addr = addr;
            previous_block->next_block_addr = addr;
            previous_block->condition_index = -1;
            previous_block->next_block_branch_taken_addr = 0;
        }
    }

    return &basic_blocks->blocks[index_to_insert];
}

static const char* condition_functions[] = {
    "test_o",
    "test_no",
    "test_b",
    "test_nb",
    "test_z",
    "test_nz",
    "test_be",
    "test_nbe",
    "test_s",
    "test_ns",
    "test_p",
    "test_np",
    "test_l",
    "test_nl",
    "test_le",
    "test_nle",
};

struct basic_block_list basic_blocks = {
    .length = 0,
    .blocks = {
        {
            .addr = 0,
            .end_addr = 0,
            .next_block_addr = 0,
            .next_block_branch_taken_addr = 0,
            .condition_index = 0,
        }
    }
};
int32_t to_visit_stack[1000];

// populates the basic_blocks global variable
static void jit_find_basic_blocks()
{
    int32_t start = *instruction_pointer;

    basic_blocks.length = 0;

    // keep a stack of locations to visit that are part of the current control flow

    int32_t to_visit_stack_count = 0;
    to_visit_stack[to_visit_stack_count++] = *instruction_pointer;

    while(to_visit_stack_count)
    {
        int32_t to_visit = to_visit_stack[--to_visit_stack_count];

        assert(same_page(*instruction_pointer, to_visit));
        *instruction_pointer = *instruction_pointer & ~0xFFF | to_visit & 0xFFF;

        if(find_basic_block_index(&basic_blocks, *instruction_pointer) != -1)
        {
            // been here already, next
            continue;
        }

        struct basic_block* current_block = add_basic_block_start(&basic_blocks, *instruction_pointer);

        current_block->next_block_branch_taken_addr = 0;

        while(true)
        {
            int32_t phys_eip = translate_address_read(*instruction_pointer);

            if(is_near_end_of_page(phys_eip))
            {
                current_block->next_block_branch_taken_addr = 0;
                current_block->next_block_addr = 0;
                current_block->end_addr = *instruction_pointer;
                current_block->condition_index = -1;
                break;
            }

            assert(!in_mapped_range(phys_eip));
            int32_t opcode = mem8[phys_eip];
            (*instruction_pointer)++;
            struct analysis analysis = analyze_step(opcode | is_osize_32() << 8);

            assert(*prefixes == 0);

            bool has_jump_target = analysis.flags & (JIT_INSTR_IMM_JUMP16_FLAG | JIT_INSTR_IMM_JUMP32_FLAG);

            int32_t instruction_end = *instruction_pointer;

            if((analysis.flags & JIT_INSTR_BLOCK_BOUNDARY_FLAG) == 0)
            {
                // ordinary instruction, continue at next

                if(find_basic_block_index(&basic_blocks, *instruction_pointer) != -1)
                {
                    current_block->next_block_branch_taken_addr = 0;
                    assert(*instruction_pointer);
                    current_block->next_block_addr = *instruction_pointer;
                    current_block->end_addr = *instruction_pointer;
                    current_block->condition_index = -1;
                    break;
                }
            }
            else if(has_jump_target)
            {
                int32_t jump_target = analysis.flags & JIT_INSTR_IMM_JUMP32_FLAG ?
                    instruction_end + analysis.jump_offset :
                    get_seg_cs() + ((instruction_end - get_seg_cs() + analysis.jump_offset) & 0xFFFF);

                if(analysis.condition_index == -1)
                {
                    // non-conditional jump: continue at jump target

                    if(same_page(jump_target, *instruction_pointer))
                    {
                        assert(jump_target);
                        current_block->next_block_addr = jump_target;

                        assert(to_visit_stack_count != 1000);
                        to_visit_stack[to_visit_stack_count++] = jump_target;
                    }
                    else
                    {
                        current_block->next_block_addr = 0;
                    }

                    current_block->next_block_branch_taken_addr = 0;
                    current_block->condition_index = -1;
                    current_block->end_addr = *instruction_pointer;

                    break;
                }
                else
                {
                    // conditional jump: continue at next and continue at jump target

                    assert(to_visit_stack_count != 1000);
                    to_visit_stack[to_visit_stack_count++] = *instruction_pointer;

                    if(same_page(jump_target, *instruction_pointer))
                    {
                        assert(to_visit_stack_count != 1000);
                        to_visit_stack[to_visit_stack_count++] = jump_target;

                        assert(jump_target);
                        current_block->next_block_branch_taken_addr = jump_target;
                    }
                    else
                    {
                        current_block->next_block_branch_taken_addr = 0;
                    }

                    current_block->jump_offset = analysis.jump_offset;
                    current_block->jump_offset_is_32 = analysis.flags & JIT_INSTR_IMM_JUMP32_FLAG;

                    assert(*instruction_pointer);
                    current_block->next_block_addr = *instruction_pointer;
                    current_block->end_addr = *instruction_pointer;

                    assert(analysis.condition_index >= 0 && analysis.condition_index < 0x10);
                    current_block->condition_index = analysis.condition_index;

                    break;
                }
            }
            else
            {
                // a block boundary but not a jump, get out

                assert((analysis.flags & JIT_INSTR_BLOCK_BOUNDARY_FLAG) && !has_jump_target);

                current_block->next_block_branch_taken_addr = 0;
                current_block->next_block_addr = 0;
                current_block->condition_index = -1;
                current_block->end_addr = *instruction_pointer;
                break;
            }
        }
    }

    if(DEBUG)
    {
        int32_t end = basic_blocks.blocks[basic_blocks.length - 1].end_addr;

        dbg_log("Function with %d basic blocks, start at %x end at %x",
                basic_blocks.length, start, end);

        //for(int32_t i = 0; i < basic_blocks.length; i++)
        //{
        //    dbg_log("%x", basic_blocks.blocks[i].addr);
        //}

        dump_function_code(basic_blocks.blocks, basic_blocks.length, end);
    }
}

static void jit_generate(uint32_t phys_addr, uint32_t page_dirtiness)
{
    profiler_stat_increment(S_COMPILE);
    profiler_start(P_GEN_INSTR);

    int32_t start = *instruction_pointer;

    int32_t first_opcode = read8(get_phys_eip());

    // populate basic_blocks
    jit_find_basic_blocks();

    // Code generation starts here

    // local variables used by the generated wasm module
    const int32_t STATE = 0;
    const int32_t ITERATION_COUNTER = 1;

    const int32_t NO_OF_LOCALS = 2;

    gen_reset();

    {
        int32_t first_basic_block_index = find_basic_block_index(&basic_blocks, start);
        assert(first_basic_block_index != -1);

        // Set state variable to first basic block; in most cases the first
        // basic block, but a jump may lead to before the function start, which
        // is currently accepted as long as it is in the same page
        gen_const_i32(first_basic_block_index);
        gen_set_local(STATE);
    }

    // initialise max_iterations
    gen_const_i32(JIT_MAX_ITERATIONS_PER_FUNCTION);
    gen_set_local(ITERATION_COUNTER);

    // main state machine loop
    gen_loop_void();

    // decrement max_iterations
    gen_get_local(ITERATION_COUNTER);
    gen_const_i32(-1);
    gen_add_i32();
    gen_set_local(ITERATION_COUNTER);


    // if max_iterations == 0: return
    gen_get_local(ITERATION_COUNTER);
    gen_eqz_i32();
    gen_if_void();
    gen_return();
    gen_block_end();

    gen_block_void(); // for the default case

    // generate the opening blocks for the cases

    for(int32_t i = 0; i < basic_blocks.length; i++)
    {
        gen_block_void();
    }

    gen_get_local(STATE);
    gen_brtable_and_cases(basic_blocks.length);

    for(int32_t i = 0; i < basic_blocks.length; i++)
    {
        // Case [i] will jump after the [i]th block, so we first generate the
        // block end opcode and then the code for that block

        gen_block_end();

        struct basic_block block = basic_blocks.blocks[i];

        int32_t next_block_start = block.end_addr;

        if(block.addr == next_block_start)
        {
            // Empty basic block, generate no code (for example, jump to block
            // that is near end of page)
            assert(!block.next_block_addr);
        }
        else
        {
            gen_commit_instruction_body_to_cs();
            jit_generate_basic_block(block.addr, next_block_start);
            gen_commit_instruction_body_to_cs();
        }

        if(block.next_block_addr)
        {
            if(block.condition_index == -1)
            {
                assert(!block.next_block_branch_taken_addr);

                // Unconditional jump to next basic block
                // - All instructions that don't change eip
                // - Unconditional jump

                int32_t next_bb_index = find_basic_block_index(&basic_blocks, block.next_block_addr);
                assert(next_bb_index != -1);

                // set state variable to next basic block
                gen_const_i32(next_bb_index);
                gen_set_local(STATE);

                gen_br(basic_blocks.length - i); // to the loop
            }
            else
            {
                // Conditional jump to next basic block
                // - jnz, jc, etc.

                assert(block.condition_index >= 0 && block.condition_index < 16);
                const char* condition = condition_functions[block.condition_index];
                gen_fn0_ret(condition, strlen(condition));

                gen_if_void();

                // Branch taken

                if(block.jump_offset_is_32)
                {
                    gen_relative_jump(block.jump_offset);
                }
                else
                {
                    gen_fn1("jmp_rel16", strlen("jmp_rel16"), block.jump_offset);
                }

                if(block.next_block_branch_taken_addr)
                {
                    int32_t next_basic_block_branch_taken_index = find_basic_block_index(
                            &basic_blocks, block.next_block_branch_taken_addr);
                    assert(next_basic_block_branch_taken_index != -1);

                    gen_const_i32(next_basic_block_branch_taken_index);
                    gen_set_local(STATE);
                }
                else
                {
                    // Jump to different page
                    gen_return();
                }

                gen_else();

                {
                    // Branch not taken
                    // TODO: Could use fall-through here
                    int32_t next_basic_block_index = find_basic_block_index(
                            &basic_blocks, block.next_block_addr);
                    assert(next_basic_block_index != -1);

                    gen_const_i32(next_basic_block_index);
                    gen_set_local(STATE);
                }

                gen_block_end();

                gen_br(basic_blocks.length - i); // to the loop
            }
        }
        else
        {
            assert(!block.next_block_branch_taken_addr);
            assert(block.condition_index == -1);

            // Exit this function
            gen_return();
        }
    }

    gen_block_end(); // default case
    gen_unreachable();

    gen_block_end(); // loop

    gen_commit_instruction_body_to_cs();
    gen_finish(NO_OF_LOCALS);

    struct code_cache* entry = create_cache_entry(phys_addr);

    entry->start_addr = phys_addr;
    entry->state_flags = pack_current_state_flags();
    entry->group_status = page_dirtiness;
    entry->pending = true;

#if DEBUG
    entry->opcode[0] = first_opcode;
    //entry->end_addr = end_addr;
    //entry->len = len;
#endif
    UNUSED(first_opcode);

    int32_t end_addr = 0;

    // will call codegen_finalize_finished asynchronously when finished
    codegen_finalize(
            entry->wasm_table_index, phys_addr, end_addr,
            first_opcode, entry->state_flags, page_dirtiness);

    profiler_stat_increment(S_COMPILE_SUCCESS);
    profiler_end(P_GEN_INSTR);

    *instruction_pointer = start;
}

// for testing
void jit_force_generate_unsafe(uint32_t phys_addr)
{
    *instruction_pointer = phys_addr;
    jit_generate(phys_addr, 0);
}

void cycle_internal()
{
#if ENABLE_JIT

    *previous_ip = *instruction_pointer;
    uint32_t phys_addr = get_phys_eip();

    struct code_cache* entry = find_cache_entry(phys_addr);

    uint32_t page_dirtiness = group_dirtiness[phys_addr >> DIRTY_ARR_SHIFT];

    const bool JIT_COMPILE_ONLY_AFTER_BLOCK_BOUNDARY = true;

    if(entry && entry->group_status == page_dirtiness && !entry->pending)
    {
        profiler_start(P_RUN_FROM_CACHE);
        profiler_stat_increment(S_RUN_FROM_CACHE);

        assert(entry->opcode[0] == read8(phys_addr));

        uint32_t old_group_status = entry->group_status;
        uint32_t old_start_address = entry->start_addr;
        uint32_t old_group_dirtiness = group_dirtiness[entry->start_addr >> DIRTY_ARR_SHIFT];
        assert(old_group_status == old_group_dirtiness);

        uint16_t wasm_table_index = entry->wasm_table_index;
        call_indirect(wasm_table_index);

        // These shouldn't fail
        assert(entry->group_status == old_group_status);
        assert(entry->start_addr == old_start_address);

        // JIT compiled self-modifying code may trigger this assert
        //assert(old_group_dirtiness == group_dirtiness[entry->start_addr >> DIRTY_ARR_SHIFT]);

        UNUSED(old_group_status);
        UNUSED(old_start_address);
        UNUSED(old_group_dirtiness);

        profiler_end(P_RUN_FROM_CACHE);
    }
    else
    {
        bool did_block_boundary = !JIT_COMPILE_ONLY_AFTER_BLOCK_BOUNDARY || jit_block_boundary;
        const int32_t address_hash = jit_hot_hash(phys_addr);

        // exists | pending | written -> should generate
        // -------+---------+---------++---------------------
        // 0      | x       | x       -> yes
        // 1      | 0       | 0       -> impossible (handled above)
        // 1      | 1       | 0       -> no
        // 1      | 0       | 1       -> yes
        // 1      | 1       | 1       -> yes

        if(
            (!entry || entry->group_status != page_dirtiness) &&
            !is_near_end_of_page(phys_addr) && (
                ENABLE_JIT_ALWAYS ||
                (did_block_boundary && ++hot_code_addresses[address_hash] > JIT_THRESHOLD)
            )
          )
        {
            // don't immediately retry to compile
            hot_code_addresses[address_hash] = 0;

            jit_generate(phys_addr, page_dirtiness);
        }
        else
        {
            jit_run_interpreted(phys_addr);
        }
    }

#else
/* Use non-JIT mode */
    previous_ip[0] = instruction_pointer[0];

    (*timestamp_counter)++;

    int32_t opcode = read_imm8();

#if DEBUG
    logop(previous_ip[0], opcode);
#endif

    run_instruction(opcode | !!*is_32 << 8);
#endif
}

void run_prefix_instruction()
{
    run_instruction(read_imm8() | is_osize_32() << 8);
}

jit_instr_flags jit_prefix_instruction()
{
    //dbg_log("jit_prefix_instruction is32=%d", is_osize_32());
    return jit_instruction(read_imm8() | is_osize_32() << 8);
}

void clear_prefixes()
{
    *prefixes = 0;
}

void segment_prefix_op(int32_t seg)
{
    assert(seg <= 5);
    *prefixes |= seg + 1;
    run_prefix_instruction();
    *prefixes = 0;
}

jit_instr_flags segment_prefix_op_jit(int32_t seg)
{
    assert(seg <= 5);
    *prefixes |= seg + 1;
    gen_add_prefix_bits(seg + 1);
    jit_instr_flags instr_flags = jit_prefix_instruction();
    gen_clear_prefixes();
    *prefixes = 0;
    return instr_flags;
}

void do_many_cycles_unsafe()
{
#if 0
    for(int32_t k = 0; k < LOOP_COUNTER; k++)
#else
    uint32_t initial_timestamp_counter = *timestamp_counter;

    for(; *timestamp_counter - initial_timestamp_counter < LOOP_COUNTER; )
#endif
    {
        cycle_internal();
    }
}

void raise_exception(int32_t interrupt_nr)
{
#if DEBUG
    if(cpu_exception_hook(interrupt_nr))
    {
        throw_cpu_exception();
        return;
    }
#endif
    call_interrupt_vector(interrupt_nr, false, false, 0);
    throw_cpu_exception();
}

void raise_exception_with_code(int32_t interrupt_nr, int32_t error_code)
{
#if DEBUG
    if(cpu_exception_hook(interrupt_nr))
    {
        throw_cpu_exception();
        return;
    }
#endif
    call_interrupt_vector(interrupt_nr, false, true, error_code);
    throw_cpu_exception();
}

__attribute__((noinline))
void trigger_de()
{
    *instruction_pointer = *previous_ip;
    raise_exception(0);
}

__attribute__((noinline))
void trigger_ud()
{
    dbg_log("#ud");
    dbg_trace();
    *instruction_pointer = *previous_ip;
    raise_exception(6);
}

__attribute__((noinline))
void trigger_nm()
{
    *instruction_pointer = *previous_ip;
    raise_exception(7);
}

__attribute__((noinline))
void trigger_np(int32_t code)
{
    *instruction_pointer = *previous_ip;
    raise_exception_with_code(11, code);
}

__attribute__((noinline))
void trigger_ss(int32_t code)
{
    *instruction_pointer = *previous_ip;
    raise_exception_with_code(12, code);
}

__attribute__((noinline))
void trigger_gp(int32_t code)
{
    *instruction_pointer = *previous_ip;
    raise_exception_with_code(13, code);
}

int32_t virt_boundary_read16(int32_t low, int32_t high)
{
    dbg_assert((low & 0xFFF) == 0xFFF);
    dbg_assert((high & 0xFFF) == 0);

    return read8(low) | read8(high) << 8;
}

int32_t virt_boundary_read32s(int32_t low, int32_t high)
{
    dbg_assert((low & 0xFFF) >= 0xFFD);
    dbg_assert((high - 3 & 0xFFF) == (low & 0xFFF));

    int32_t mid = 0;

    if(low & 1)
    {
        if(low & 2)
        {
            // 0xFFF
            mid = read_aligned16((high - 2) >> 1);
        }
        else
        {
            // 0xFFD
            mid = read_aligned16((low + 1) >> 1);
        }
    }
    else
    {
        // 0xFFE
        mid = virt_boundary_read16(low + 1, high - 1);
    }

    return read8(low) | mid << 8 | read8(high) << 24;
}

void virt_boundary_write16(int32_t low, int32_t high, int32_t value)
{
    dbg_assert((low & 0xFFF) == 0xFFF);
    dbg_assert((high & 0xFFF) == 0);

    write8(low, value);
    write8(high, value >> 8);
}

void virt_boundary_write32(int32_t low, int32_t high, int32_t value)
{
    dbg_assert((low & 0xFFF) >= 0xFFD);
    dbg_assert((high - 3 & 0xFFF) == (low & 0xFFF));

    write8(low, value);

    if(low & 1)
    {
        if(low & 2)
        {
            // 0xFFF
            write8(high - 2, value >> 8);
            write8(high - 1, value >> 16);
        }
        else
        {
            // 0xFFD
            write8(low + 1, value >> 8);
            write8(low + 2, value >> 16);
        }
    }
    else
    {
        // 0xFFE
        write8(low + 1, value >> 8);
        write8(high - 1, value >> 16);
    }

    write8(high, value >> 24);
}

int32_t safe_read8(int32_t addr)
{
    return read8(translate_address_read(addr));
}

int32_t safe_read16(int32_t addr)
{
    if((addr & 0xFFF) == 0xFFF)
    {
        return safe_read8(addr) | safe_read8(addr + 1) << 8;
    }
    else
    {
        return read16(translate_address_read(addr));
    }
}

__attribute__((noinline))
int32_t safe_read32s_slow(int32_t addr)
{
    if((addr & 0xFFF) >= 0xFFD)
    {
        return safe_read16(addr) | safe_read16(addr + 2) << 16;
    }
    else
    {
        return read32s(translate_address_read(addr));
    }
}

__attribute__((always_inline))
int32_t safe_read32s(int32_t address)
{
#if 1
    int32_t base = (uint32_t)address >> 12;
    int32_t entry = tlb_data[base];
    int32_t info_bits = entry & 0xFFF & ~TLB_READONLY & ~TLB_GLOBAL;

    // XXX: Paging check

    if(info_bits == TLB_VALID && (address & 0xFFF) <= (0x1000 - 4))
    {
        // - not in memory mapped area
        // - can be accessed from any cpl

        uint32_t phys_address = entry & ~0xFFF ^ address;
        assert(!in_mapped_range(phys_address));
        return *(int32_t*)(mem8 + phys_address);
    }
#endif

    return safe_read32s_slow(address);
}

union reg64 safe_read64s(int32_t addr)
{
    union reg64 x;
    if((addr & 0xFFF) > (0x1000 - 8))
    {
        x.u32[0] = safe_read32s(addr);
        x.u32[1] = safe_read32s(addr + 4);
    }
    else
    {
        int32_t addr_phys = translate_address_read(addr);
        x.u64[0] = read64s(addr_phys);
    }
    return x;
}

__attribute__((always_inline))
union reg128 safe_read128s(int32_t addr)
{
    union reg128 x;
    if((addr & 0xFFF) > (0x1000 - 16))
    {
        x.u64[0] = safe_read64s(addr).u64[0];
        x.u64[1] = safe_read64s(addr + 8).u64[0];
    }
    else
    {
        int32_t addr_phys = translate_address_read(addr);
        x = read128(addr_phys);
    }
    return x;
}

void safe_write8(int32_t addr, int32_t value)
{
    write8(translate_address_write(addr), value);
}

void safe_write16(int32_t addr, int32_t value)
{
    int32_t phys_low = translate_address_write(addr);

    if((addr & 0xFFF) == 0xFFF)
    {
        virt_boundary_write16(phys_low, translate_address_write(addr + 1), value);
    }
    else
    {
        write16(phys_low, value);
    }
}

__attribute__((noinline))
void safe_write32_slow(int32_t addr, int32_t value)
{
    int32_t phys_low = translate_address_write(addr);

    if((addr & 0xFFF) > (0x1000 - 4))
    {
        virt_boundary_write32(phys_low, translate_address_write(addr + 3 & ~3) | (addr + 3) & 3, value);
    }
    else
    {
        write32(phys_low, value);
    }
}

__attribute__((always_inline))
void safe_write32(int32_t address, int32_t value)
{
#if 1
    int32_t base = (uint32_t)address >> 12;
    int32_t entry = tlb_data[base];
    int32_t info_bits = entry & 0xFFF & ~TLB_GLOBAL;

    // XXX: Paging check

    if(info_bits == TLB_VALID && (address & 0xFFF) <= (0x1000 - 4))
    {
        // - allowed to write in user-mode
        // - not in memory mapped area
        // - can be accessed from any cpl

        uint32_t phys_address = entry & ~0xFFF ^ address;
        jit_dirty_cache_single(phys_address);
        assert(!in_mapped_range(phys_address));
        *(int32_t*)(mem8 + phys_address) = value;
        return;
    }
#endif

    safe_write32_slow(address, value);
}

void safe_write64(int32_t addr, int64_t value)
{
    if((addr & 0xFFF) > (0x1000 - 8))
    {
        safe_write32(addr, value);
        safe_write32(addr + 4, value >> 32);
    }
    else
    {
        int32_t phys = translate_address_write(addr);
        write64(phys, value);
    }
}

__attribute__((always_inline))
void safe_write128(int32_t addr, union reg128 value)
{
    if((addr & 0xFFF) > (0x1000 - 16))
    {
        safe_write64(addr, value.u64[0]);
        safe_write64(addr + 8, value.u64[1]);
    }
    else
    {
        int32_t phys = translate_address_write(addr);
        write128(phys, value);
    }
}

int32_t get_reg8_index(int32_t index) { return index << 2 & 0xC | index >> 2 & 1; }

int32_t read_reg8(int32_t index)
{
    return reg8[get_reg8_index(index)];
}

void write_reg8(int32_t index, int32_t value)
{
    reg8[get_reg8_index(index)] = value;
}

int32_t get_reg16_index(int32_t index) { return index << 1; }

int32_t read_reg16(int32_t index)
{
    return reg16[get_reg16_index(index)];
}

void write_reg16(int32_t index, int32_t value)
{
    reg16[get_reg16_index(index)] = value;
}


int32_t read_reg32(int32_t index)
{
    return reg32s[index];
}

void write_reg32(int32_t index, int32_t value)
{
    reg32s[index] = value;
}

void write_reg_osize(int32_t index, int32_t value)
{
    assert(index >= 0 && index < 8);

    if(is_osize_32())
    {
        write_reg32(index, value);
    }
    else
    {
        write_reg16(index, value & 0xFFFF);
    }
}

int32_t read_mmx32s(int32_t r)
{
    return reg_mmx[r].u32[0];
}

union reg64 read_mmx64s(int32_t r)
{
    return reg_mmx[r];
}

void write_mmx64(int32_t r, int32_t low, int32_t high)
{
    reg_mmx[r].u32[0] = low;
    reg_mmx[r].u32[1] = high;
}

void write_mmx_reg64(int32_t r, union reg64 data)
{
    reg_mmx[r].u64[0] = data.u64[0];
}

union reg64 read_xmm64s(int32_t r)
{
    union reg64 x;
    x.u64[0] = reg_xmm[r].u64[0];
    return x;
}

union reg128 read_xmm128s(int32_t r)
{
    return reg_xmm[r];
}

void write_xmm64(int32_t r, union reg64 data)
{
    reg_xmm[r].u64[0] = data.u64[0];
}

void write_xmm128(int32_t r, int32_t i0, int32_t i1, int32_t i2, int32_t i3)
{
    union reg128 x = { .u32 = { i0, i1, i2, i3 } };
    reg_xmm[r] = x;
}

void write_xmm_reg128(int32_t r, union reg128 data)
{
    reg_xmm[r].u64[0] = data.u64[0];
    reg_xmm[r].u64[1] = data.u64[1];
}

void clear_tlb()
{
    profiler_stat_increment(S_CLEAR_TLB);
    // clear tlb excluding global pages

    *last_virt_eip = -1;
    *last_virt_esp = -1;

    int32_t global_page_offset = 0;

    for(int32_t i = 0; i < valid_tlb_entries_count; i++)
    {
        int32_t page = valid_tlb_entries[i];
        int32_t entry = tlb_data[page];

        if(entry & TLB_GLOBAL)
        {
            // reinsert at the front
            valid_tlb_entries[global_page_offset++] = page;
        }
        else
        {
            tlb_data[page] = 0;
        }
    }

    valid_tlb_entries_count = global_page_offset;

#if CHECK_TLB_INVARIANTS
    for(int32_t i = 0; i < 0x100000; i++)
    {
        assert(tlb_data[i] == 0 || (tlb_data[i] & TLB_GLOBAL));
    }
#endif
}

void full_clear_tlb()
{
    profiler_stat_increment(S_FULL_CLEAR_TLB);
    // clear tlb including global pages

    *last_virt_eip = -1;
    *last_virt_esp = -1;

    for(int32_t i = 0; i < valid_tlb_entries_count; i++)
    {
        int32_t page = valid_tlb_entries[i];
        tlb_data[page] = 0;
    }

    valid_tlb_entries_count = 0;

#if CHECK_TLB_INVARIANTS
    for(int32_t i = 0; i < 0x100000; i++)
    {
        assert(tlb_data[i] == 0);
    }
#endif
}

void invlpg(int32_t addr)
{
    //dbg_log("invlpg: addr=" + h(addr >>> 0), LOG_CPU);
    int32_t page = (uint32_t)addr >> 12;

    tlb_data[page] = 0;

    *last_virt_eip = -1;
    *last_virt_esp = -1;
}

void task_switch_test()
{
    if(cr[0] & (CR0_EM | CR0_TS))
    {
        trigger_nm();
    }
}

void task_switch_test_mmx()
{
    if(*cr & (CR0_EM | CR0_TS))
    {
        if(*cr & CR0_TS)
        {
            trigger_nm();
        }
        else
        {
            trigger_ud();
        }
    }
}

// read 2 or 4 byte from ip, depending on address size attribute
int32_t read_moffs()
{
    if(is_asize_32())
    {
        return read_imm32s();
    }
    else
    {
        return read_imm16();
    }
}

// Returns the "real" instruction pointer, without segment offset
int32_t get_real_eip()
{
    return *instruction_pointer - get_seg_cs();
}

int32_t get_stack_reg()
{
    if(*stack_size_32)
    {
        return reg32s[ESP];
    }
    else
    {
        return reg16[SP];
    }
}

void set_stack_reg(int32_t value)
{
    if(*stack_size_32)
    {
        reg32s[ESP] = value;
    }
    else
    {
        reg16[SP] = value;
    }
}

int32_t get_reg_asize(int32_t reg)
{
    dbg_assert(reg == ECX || reg == ESI || reg == EDI);
    int32_t r = reg32s[reg];

    if(is_asize_32())
    {
        return r;
    }
    else
    {
        return r & 0xFFFF;
    }
}

void set_ecx_asize(int32_t value)
{
    if(is_asize_32())
    {
        reg32s[ECX] = value;
    }
    else
    {
        reg16[CX] = value;
    }
}

void add_reg_asize(int32_t reg, int32_t value)
{
    dbg_assert(reg == ECX || reg == ESI || reg == EDI);
    if(is_asize_32())
    {
        reg32s[reg] += value;
    }
    else
    {
        reg16[reg << 1] += value;
    }
}

int32_t decr_ecx_asize()
{
    return is_asize_32() ? --reg32s[ECX] : --reg16[CX];
}

void set_tsc(uint32_t low, uint32_t high)
{
    uint64_t new_value = low | (uint64_t)high << 32;
    uint64_t current_value = read_tsc();
    tsc_offset = current_value - new_value;
}


uint64_t rdtsc_last_value = 0;
uint64_t rdtsc_imprecision_offset = 0;

uint64_t read_tsc()
{
    double_t n = microtick() * TSC_RATE;
    uint64_t value = (uint64_t)n - tsc_offset;

#if 1
    return value;
#else

    if(value == rdtsc_last_value)
    {
        // don't go past 1ms

        if(rdtsc_imprecision_offset < TSC_RATE)
        {
            rdtsc_imprecision_offset++;
        }
    }
    else
    {
        uint64_t previous_value = rdtsc_last_value + rdtsc_imprecision_offset;

        if(previous_value <= value)
        {
            rdtsc_last_value = value;
            rdtsc_imprecision_offset = 0;
        }
        else
        {
            dbg_log("XXX: Overshot tsc prev=%x:%x offset=%x:%x curr=%x:%x",
                    (uint32_t)(rdtsc_last_value >> 32), (uint32_t)rdtsc_last_value,
                    (uint32_t)(rdtsc_imprecision_offset >> 32), (uint32_t)rdtsc_imprecision_offset,
                    (uint32_t)(value >> 32), (uint32_t)value
                    );
            dbg_assert(false);

            // Keep current value until time catches up
        }
    }

    return rdtsc_last_value + rdtsc_imprecision_offset;
#endif
}

void store_current_tsc()
{
    *current_tsc = read_tsc();
}
