#include <assert.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

#include "const.h"
#include "global_pointers.h"
#include "profiler/profiler.h"
#include "codegen/codegen.h"
#include "log.h"
#include "instructions.h"
#include "memory.h"
#include "shared.h"
#include "modrm.h"
#include "misc_instr.h"
#include "js_imports.h"
#include "cpu.h"

struct code_cache jit_cache_arr[WASM_TABLE_SIZE] = {{0, 0, {0}, 0, 0, 0, 0}};

uint32_t jit_jump = 0;
int32_t hot_code_addresses[HASH_PRIME] = {0};
uint32_t group_dirtiness[GROUP_DIRTINESS_LENGTH] = {0};

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
    tlb_info[page] = 0;
    tlb_info_global[page] = 0;

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

    if((page_dir_entry & PAGE_TABLE_RW_MASK) == 0)
    {
        can_write = false;

        if(for_writing && (user || (cr[0] & CR0_WP)))
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

        if((page_table_entry & PAGE_TABLE_RW_MASK) == 0)
        {
            can_write = false;

            if(for_writing && (user || (cr[0] & CR0_WP)))
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

    tlb_data[page] = high ^ page << 12;

    int32_t allowed_flag;

    if(allow_user)
    {
        if(can_write)
        {
            allowed_flag = TLB_SYSTEM_READ | TLB_SYSTEM_WRITE | TLB_USER_READ | TLB_USER_WRITE;
        }
        else
        {
            // TODO: Consider if cr0.wp is not set
            allowed_flag = TLB_SYSTEM_READ | TLB_USER_READ;
        }
    }
    else
    {
        if(can_write)
        {
            allowed_flag = TLB_SYSTEM_READ | TLB_SYSTEM_WRITE;
        }
        else
        {
            allowed_flag = TLB_SYSTEM_READ;
        }
    }

    tlb_info[page] = allowed_flag;

    if(global && (cr[4] & CR4_PGE))
    {
        tlb_info_global[page] = allowed_flag;
    }

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

    bool user = cpl[0] == 3 ? true : false;
    int32_t mask = user ? TLB_USER_WRITE : TLB_SYSTEM_WRITE;
    int32_t page = (uint32_t)addr >> 12;

    if((tlb_info[page] & mask) == 0)
    {
        do_page_translation(addr, true, user);
    }

    if((addr & 0xFFF) + size - 1 >= 0x1000)
    {
        if((tlb_info[page + 1] & mask) == 0)
        {
            do_page_translation(addr + size - 1, true, user);
        }
    }
}

int32_t translate_address_read(int32_t address)
{
    if(!*paging) return address;

    int32_t base = (uint32_t)address >> 12;
    if(tlb_info[base] & (*cpl == 3 ? TLB_USER_READ : TLB_SYSTEM_READ))
    {
        return tlb_data[base] ^ address;
    }
    else
    {
        return do_page_translation(address, false, *cpl == 3) | address & 0xFFF;
    }
}

int32_t translate_address_write(int32_t address)
{
    if(!*paging) return address;

    int32_t base = (uint32_t)address >> 12;
    if(tlb_info[base] & (*cpl == 3 ? TLB_USER_WRITE : TLB_SYSTEM_WRITE))
    {
        return tlb_data[base] ^ address;
    }
    else
    {
        return do_page_translation(address, true, *cpl == 3) | address & 0xFFF;
    }
}

int32_t translate_address_system_read(int32_t address)
{
    if(!*paging) return address;

    int32_t base = (uint32_t)address >> 12;
    if(tlb_info[base] & TLB_SYSTEM_READ)
    {
        return tlb_data[base] ^ address;
    }
    else
    {
        return do_page_translation(address, false, false) | address & 0xFFF;
    }
}

int32_t translate_address_system_write(int32_t address)
{
    if(!*paging) return address;

    int32_t base = (uint32_t)address >> 12;
    if(tlb_info[base] & TLB_SYSTEM_WRITE)
    {
        return tlb_data[base] ^ address;
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

static void generate_instruction(int32_t opcode)
{
    gen_set_previous_eip();
    gen_increment_instruction_pointer(0);

    int32_t start_eip = *instruction_pointer - 1;

    jit_instruction(opcode);

    int32_t end_eip = *instruction_pointer;
    int32_t instruction_length = end_eip - start_eip;

    assert(instruction_length >= 0 && instruction_length < 16);
    //dbg_log("instruction_length=%d", instruction_length);

    gen_patch_increment_instruction_pointer(instruction_length);
}

static void jit_run_interpreted(int32_t phys_addr)
{
    profiler_start(P_RUN_INTERPRETED);
    profiler_stat_increment(S_RUN_INTERPRETED);

    jit_jump = false;

    assert(!in_mapped_range(phys_addr));
    int32_t opcode = mem8[phys_addr];
    (*instruction_pointer)++;
    (*timestamp_counter)++;
    run_instruction(opcode | !!*is_32 << 8);

    profiler_end(P_RUN_INTERPRETED);
}

static struct code_cache* create_cache_entry(uint32_t phys_addr, bool is_32)
{
    for(int32_t i = 0; i < CODE_CACHE_SEARCH_SIZE; i++)
    {
        uint16_t addr_index = (phys_addr + i) & JIT_PHYS_MASK;
        struct code_cache* entry = &jit_cache_arr[addr_index];

        // there shouldn't be an already valid entry
        assert(entry->start_addr != phys_addr || entry->is_32 != is_32);

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

static void jit_generate(int32_t address_hash, uint32_t phys_addr, struct code_cache* entry, uint32_t page_dirtiness)
{
    profiler_start(P_GEN_INSTR);
    profiler_stat_increment(S_COMPILE);

    int32_t start_addr = *instruction_pointer;

    // don't immediately retry to compile
    hot_code_addresses[address_hash] = 0;

    int32_t len = 0;
    jit_jump = false;

    int32_t end_addr = phys_addr + 1;
    int32_t first_opcode = -1;

    gen_reset();

    while(!jit_jump && len < 50 && (*instruction_pointer & 0xFFF) < (0x1000 - 16))
    {
        *previous_ip = *instruction_pointer;
        int32_t opcode = read_imm8();

        if(len == 0)
        {
            first_opcode = opcode;
        }
        len++;

        generate_instruction(opcode | !!*is_32 << 8);

        end_addr = *eip_phys ^ *instruction_pointer;
    }

    // at this point no exceptions can be raised

    if(len < JIT_MIN_BLOCK_LENGTH)
    {
        // abort, block is too short to be considered useful for compilation
        profiler_stat_increment(S_CACHE_SKIPPED);
        profiler_end(P_GEN_INSTR);
        *instruction_pointer = start_addr;
        return;
    }

    if(entry && entry->group_status != page_dirtiness)
    {
        assert(entry->start_addr == phys_addr);
        profiler_stat_increment(S_CACHE_DROP);
    }

    // no page was crossed
    assert(((end_addr ^ phys_addr) & ~0xFFF) == 0);

    gen_increment_timestamp_counter(len);

    assert(first_opcode != -1);

    if(!entry)
    {
        entry = create_cache_entry(phys_addr, *is_32);

        entry->start_addr = phys_addr;
        entry->is_32 = *is_32;
    }
    else
    {
        assert(entry->group_status != page_dirtiness);
        assert(entry->start_addr == phys_addr);
        assert(entry->is_32 == *is_32);
    }

    entry->opcode[0] = first_opcode;
    entry->end_addr = end_addr;
    entry->len = len;

    jit_jump = false;

    gen_finish();

    codegen_finalize(entry->wasm_table_index, start_addr, entry->start_addr, end_addr);

    assert(*prefixes == 0);

    entry->group_status = page_dirtiness;

    profiler_stat_increment(S_COMPILE_SUCCESS);
    profiler_end(P_GEN_INSTR);
}

static struct code_cache* find_cache_entry(uint32_t phys_addr, bool is_32)
{
#pragma clang loop unroll_count(CODE_CACHE_SEARCH_SIZE)
    for(int32_t i = 0; i < CODE_CACHE_SEARCH_SIZE; i++)
    {
        uint16_t addr_index = (phys_addr + i) & JIT_PHYS_MASK;
        struct code_cache* entry = &jit_cache_arr[addr_index];

        if(entry->start_addr == phys_addr && entry->is_32 == is_32)
        {
            return entry;
        }
    }

    return NULL;
}

void cycle_internal()
{
#if ENABLE_JIT

    *previous_ip = *instruction_pointer;
    uint32_t phys_addr = get_phys_eip();

    struct code_cache* entry = find_cache_entry(phys_addr, *is_32);

    uint32_t page_dirtiness = group_dirtiness[phys_addr >> DIRTY_ARR_SHIFT];

    const bool JIT_ALWAYS = false;
    const bool JIT_DONT_USE_CACHE = false;
    const bool JIT_COMPILE_ONLY_AFTER_JUMP = true;

    if(!JIT_DONT_USE_CACHE && entry && entry->group_status == page_dirtiness)
    {
        profiler_start(P_RUN_FROM_CACHE);
        profiler_stat_increment(S_RUN_FROM_CACHE);

        assert(entry->opcode[0] == read8(phys_addr));

        uint16_t wasm_table_index = entry->wasm_table_index;
        call_indirect(wasm_table_index);

        // XXX: Try to find an assert to detect self-modifying code
        // JIT compiled self-modifying basic blocks may trigger this assert
        // assert(entry->group_status != group_dirtiness[entry->start_addr >> DIRTY_ARR_SHIFT]);

        profiler_end(P_RUN_FROM_CACHE);
    }
    else
    {
        bool near_the_end_of_page = (phys_addr & 0xFFF) >= (0x1000 - 16);
        bool did_jump = !JIT_COMPILE_ONLY_AFTER_JUMP || jit_jump;
        const int32_t address_hash = jit_hot_hash(phys_addr);

        if(
            !near_the_end_of_page && (
                JIT_ALWAYS ||
                (did_jump && ++hot_code_addresses[address_hash] > JIT_THRESHOLD)
            )
          )
        {
            jit_generate(address_hash, phys_addr, entry, page_dirtiness);
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

void jit_prefix_instruction()
{
    //dbg_log("jit_prefix_instruction is32=%d", is_osize_32());
    jit_instruction(read_imm8() | is_osize_32() << 8);
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

void segment_prefix_op_jit(int32_t seg)
{
    assert(seg <= 5);
    gen_add_prefix_bits(seg + 1);
    jit_prefix_instruction();
    gen_clear_prefixes();
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
int32_t safe_read32s(int32_t addr)
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
void safe_write32(int32_t addr, int32_t value)
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
    memcpy_large(tlb_info, tlb_info_global, 0x100000);
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
    return *instruction_pointer - get_seg(CS);
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
