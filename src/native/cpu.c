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
struct code_cache jit_cache_arr[WASM_TABLE_SIZE] = {{0, 0, {0}, 0, 0, 0, false}};
#else
struct code_cache jit_cache_arr[WASM_TABLE_SIZE] = {{0, 0, 0, false}};
#endif

uint32_t jit_jump = 0;
int32_t hot_code_addresses[HASH_PRIME] = {0};
uint32_t group_dirtiness[GROUP_DIRTINESS_LENGTH] = {0};

int32_t valid_tlb_entries[VALID_TLB_ENTRY_MAX] = {0};
int32_t valid_tlb_entries_count = 0;

void after_jump()
{
    jit_jump = true;
}

void diverged()
{
    after_jump();
}

void branch_taken()
{
    after_jump();
}

void branch_not_taken()
{
    after_jump();
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

int32_t get_seg_cs()
{
    return segment_offsets[CS];
}

int32_t get_seg_ss()
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

uint32_t jit_hot_hash(uint32_t addr)
{
    return addr % HASH_PRIME;
}

static void jit_run_interpreted(int32_t phys_addr)
{
    profiler_start(P_RUN_INTERPRETED);
    profiler_stat_increment(S_RUN_INTERPRETED);

    jit_jump = false;

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
    if(!jit_jump)
    {
        *previous_ip = *instruction_pointer;
        end_eip = get_phys_eip();
    }
#endif

    while(!jit_jump)
    {
        previous_ip[0] = instruction_pointer[0];
        (*timestamp_counter)++;

        int32_t opcode = read_imm8();

#if DEBUG
    logop(previous_ip[0], opcode);
#endif
        run_instruction(opcode | !!*is_32 << 8);

#if DUMP_UNCOMPILED_ASSEMBLY
        if(!jit_jump)
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

static cached_state_flags pack_current_state_flags()
{
    return *is_32 << 0 | *stack_size_32 << 1;
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

static void jit_generate(int32_t address_hash, uint32_t phys_addr, uint32_t page_dirtiness)
{
    profiler_start(P_GEN_INSTR);
    profiler_stat_increment(S_COMPILE);

    int32_t start_addr = *instruction_pointer;

    // don't immediately retry to compile
    hot_code_addresses[address_hash] = 0;

    int32_t len = 0;
    jit_jump = false;

    int32_t end_addr;
    int32_t first_opcode = -1;
    bool was_jump = false;
    int32_t eip_delta = 0;

    gen_reset();

    // First iteration of do-while assumes the caller confirms this condition
    assert(!is_near_end_of_page(phys_addr));
    do
    {
        *previous_ip = *instruction_pointer;
        int32_t opcode = read_imm8();

        if(len == 0)
        {
            first_opcode = opcode;
        }

        int32_t start_eip = *instruction_pointer - 1;
        jit_instr_flags jit_ret = jit_instruction(opcode | !!*is_32 << 8);
        int32_t end_eip = *instruction_pointer;

        int32_t instruction_length = end_eip - start_eip;
        was_jump = (jit_ret & JIT_INSTR_JUMP_FLAG) != 0;

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
        if(was_jump)
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
        end_addr = *eip_phys ^ *instruction_pointer;
        len++;
    }
    while(!was_jump && len < 50 && !is_near_end_of_page(*instruction_pointer));

#if ENABLE_JIT_NONFAULTING_OPTIMZATION
    // When the block ends in a non-jump instruction, we may have uncommitted updates still
    if(eip_delta > 0)
    {
        gen_commit_instruction_body_to_cs();
        gen_increment_instruction_pointer(eip_delta);
    }
#endif

    // no page was crossed
    assert(((end_addr ^ phys_addr) & ~0xFFF) == 0);

    // at this point no exceptions can be raised

    if(!ENABLE_JIT_ALWAYS && JIT_MIN_BLOCK_LENGTH != 0 && len < JIT_MIN_BLOCK_LENGTH)
    {
        // abort, block is too short to be considered useful for compilation
        profiler_stat_increment(S_CACHE_SKIPPED);
        profiler_end(P_GEN_INSTR);
        *instruction_pointer = start_addr;
        return;
    }

    gen_increment_timestamp_counter(len);

    struct code_cache* entry = create_cache_entry(phys_addr);

    jit_jump = false;
    gen_finish();
    codegen_finalize(entry->wasm_table_index, entry->start_addr, end_addr);
    assert(*prefixes == 0);

    entry->start_addr = phys_addr;
    entry->state_flags = pack_current_state_flags();
    entry->group_status = page_dirtiness;

#if DEBUG
    assert(first_opcode != -1);
    entry->opcode[0] = first_opcode;
    entry->end_addr = end_addr;
    entry->len = len;
#endif

    // start execution at the newly generated code
    *instruction_pointer = start_addr;

    profiler_stat_increment(S_COMPILE_SUCCESS);
    profiler_end(P_GEN_INSTR);
}

static struct code_cache* find_cache_entry(uint32_t phys_addr)
{
#pragma clang loop unroll_count(CODE_CACHE_SEARCH_SIZE)
    for(int32_t i = 0; i < CODE_CACHE_SEARCH_SIZE; i++)
    {
        uint16_t addr_index = (phys_addr + i) & JIT_PHYS_MASK;
        struct code_cache* entry = &jit_cache_arr[addr_index];

        if(entry->start_addr == phys_addr && entry->state_flags == pack_current_state_flags())
        {
            return entry;
        }
    }

    return NULL;
}

struct code_cache* find_link_block_target(int32_t target)
{
    int32_t eip = *previous_ip;

    if(ENABLE_JIT_BLOCK_LINKING && ((eip ^ target) & ~0xFFF) == 0) // same page
    {
        assert((eip & ~0xFFF) == *last_virt_eip);
        assert((target & ~0xFFF) == *last_virt_eip);

        uint32_t phys_target = *eip_phys ^ target;
        struct code_cache* entry = find_cache_entry(phys_target);

        if(entry && entry->group_status == group_dirtiness[entry->start_addr >> DIRTY_ARR_SHIFT])
        {
            return entry;
        }
    }

    return NULL;
}

void jit_link_block(int32_t target)
{
    struct code_cache* entry = find_link_block_target(target);

    if(entry)
    {
        profiler_stat_increment(S_COMPILE_WITH_LINK);
        set_jit_import(JIT_NEXT_BLOCK_BRANCHED_IDX, entry->wasm_table_index);
        gen_fn0(JIT_NEXT_BLOCK_BRANCHED, sizeof(JIT_NEXT_BLOCK_BRANCHED) - 1);
    }
}

void jit_link_block_conditional(int32_t offset, const char* condition)
{
    // > Generate the following code:
    // if(test_XX()) { *instruction_pointer += offset; JIT_NEXT_BLOCK_BRANCHED() }
    // else { JIT_NEXT_BLOCK_NOT_BRANCHED() }

    // Note: block linking cannot rely on the absolute value of eip, as blocks
    // are stored at their *physical* address, which can be executed from
    // multiple *virtual* addresses. Due to this, we cannot insert the value of
    // eip into generated code

    struct code_cache* entry_branch_taken = find_link_block_target(*instruction_pointer + offset);
    struct code_cache* entry_branch_not_taken = find_link_block_target(*instruction_pointer);

    gen_fn0_ret(condition, strlen(condition));

    gen_if_void();
    gen_relative_jump(offset);

    if(entry_branch_taken)
    {
        profiler_stat_increment(S_COMPILE_WITH_LINK);
        set_jit_import(JIT_NEXT_BLOCK_BRANCHED_IDX, entry_branch_taken->wasm_table_index);
        gen_fn0(JIT_NEXT_BLOCK_BRANCHED, sizeof(JIT_NEXT_BLOCK_BRANCHED) - 1);
    }

    if(entry_branch_not_taken)
    {
        gen_else();

        profiler_stat_increment(S_COMPILE_WITH_LINK);
        set_jit_import(JIT_NEXT_BLOCK_NOT_BRANCHED_IDX, entry_branch_not_taken->wasm_table_index);
        gen_fn0(JIT_NEXT_BLOCK_NOT_BRANCHED, sizeof(JIT_NEXT_BLOCK_NOT_BRANCHED) - 1);
    }

    gen_block_end();
}

void cycle_internal()
{
#if ENABLE_JIT

    *previous_ip = *instruction_pointer;
    uint32_t phys_addr = get_phys_eip();

    struct code_cache* entry = find_cache_entry(phys_addr);

    uint32_t page_dirtiness = group_dirtiness[phys_addr >> DIRTY_ARR_SHIFT];

    const bool JIT_DONT_USE_CACHE = false;
    const bool JIT_COMPILE_ONLY_AFTER_JUMP = true;

    if(!JIT_DONT_USE_CACHE && entry && entry->group_status == page_dirtiness)
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
        bool did_jump = !JIT_COMPILE_ONLY_AFTER_JUMP || jit_jump;
        const int32_t address_hash = jit_hot_hash(phys_addr);

        if(
            !is_near_end_of_page(phys_addr) && (
                ENABLE_JIT_ALWAYS ||
                (did_jump && ++hot_code_addresses[address_hash] > JIT_THRESHOLD)
            )
          )
        {
            jit_generate(address_hash, phys_addr, page_dirtiness);
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
    gen_add_prefix_bits(seg + 1);
    jit_instr_flags instr_flags = jit_prefix_instruction();
    gen_clear_prefixes();
    return instr_flags;
}

void do_many_cycles_unsafe()
{
    for(int32_t k = 0; k < LOOP_COUNTER; k++)
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

void trigger_de()
{
    *instruction_pointer = *previous_ip;
    raise_exception(0);
}

void trigger_ud()
{
    dbg_log("#ud");
    dbg_trace();
    *instruction_pointer = *previous_ip;
    raise_exception(6);
}

void trigger_nm()
{
    *instruction_pointer = *previous_ip;
    raise_exception(7);
}

void trigger_np(int32_t code)
{
    *instruction_pointer = *previous_ip;
    raise_exception_with_code(11, code);
}

void trigger_ss(int32_t code)
{
    *instruction_pointer = *previous_ip;
    raise_exception_with_code(12, code);
}

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

__attribute__((always_inline))
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

union reg128 safe_read128s(int32_t addr)
{
    union reg128 x;
    if((addr & 0xFFF) > (0x1000 - 16))
    {
        x.u32[0] = safe_read32s(addr);
        x.u32[1] = safe_read32s(addr + 4);
        x.u32[2] = safe_read32s(addr + 8);
        x.u32[3] = safe_read32s(addr + 12);
    }
    else
    {
        int32_t addr_phys = translate_address_read(addr);
        x.u64[0] = read64s(addr_phys);
        x.u64[1] = read64s(addr_phys + 8);
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

__attribute__((always_inline))
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
        write64(phys, value.u64[0]);
        write64(phys + 8, value.u64[1]);
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
    *tsc_offset = current_value - new_value;
}

uint64_t read_tsc()
{
    double_t n = microtick() * TSC_RATE;
    return (uint64_t)n - *tsc_offset;
}

void store_current_tsc()
{
    *current_tsc = read_tsc();
}
