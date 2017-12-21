#include <stdint.h>
#include <math.h>
#include <assert.h>
#include <stdbool.h>
#include <stdio.h>

#include "const.h"
#include "global_pointers.h"
#include "profiler.h"
#include "codegen/codegen.h"

// like memcpy, but only efficient for large (approximately 10k) sizes
// See memcpy in https://github.com/kripken/emscripten/blob/master/src/library.js
void* memcpy_large(void* dest, const void* src, size_t n);

void writable_or_pagefault(int32_t, int32_t);
int32_t translate_address_read(int32_t);
int32_t translate_address_write(int32_t);
int32_t read8(uint32_t);
int32_t read16(uint32_t);
int32_t read32s(uint32_t);
int64_t read64s(uint32_t);
int32_t read_aligned16(uint32_t addr);
int32_t virt_boundary_read16(int32_t, int32_t);
int32_t virt_boundary_read32s(int32_t, int32_t);
void write8(uint32_t, int32_t);
void write16(uint32_t, int32_t);
void write32(uint32_t, int32_t);
void write64(uint32_t, int64_t);
void virt_boundary_write16(int32_t, int32_t, int32_t);
void virt_boundary_write32(int32_t, int32_t, int32_t);

bool cpu_exception_hook(int32_t);

bool in_mapped_range(uint32_t);

void trigger_gp(int32_t);
void trigger_ud();
void trigger_nm();

int32_t safe_read8(int32_t);
int32_t safe_read16(int32_t);
int32_t safe_read32s(int32_t);

void safe_write8(int32_t, int32_t);
void safe_write16(int32_t, int32_t);
void safe_write32(int32_t, int32_t);

void fxsave(uint32_t);
void fxrstor(uint32_t);

int32_t do_page_translation(int32_t, bool, bool);

void after_jump()
{
    jit_jump = 1;
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


int32_t getcf(void);
int32_t getpf(void);
int32_t getaf(void);
int32_t getzf(void);
int32_t getsf(void);
int32_t getof(void);


double_t microtick();


int32_t get_eflags()
{
    return (*flags & ~FLAGS_ALL) | !!getcf() | !!getpf() << 2 | !!getaf() << 4 |
                                  !!getzf() << 6 | !!getsf() << 7 | !!getof() << 11;
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
        return do_page_translation(address, 0, *cpl == 3) | address & 0xFFF;
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
        return do_page_translation(address, 1, *cpl == 3) | address & 0xFFF;
    }
}

bool jit_in_progress = false; // XXX: For debugging

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
    if(jit_in_progress) dbg_log("%x/8/%x", eip, data8);
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
    if(jit_in_progress) dbg_log("%x/16/%x", *instruction_pointer, data16);
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
    if(jit_in_progress) dbg_log("%x/32/%x", *instruction_pointer, data32);
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

void run_instruction(int32_t);
static int32_t resolve_modrm16(int32_t);
static int32_t resolve_modrm32(int32_t);

static int32_t modrm_resolve(int32_t modrm_byte)
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

static void jit_instruction(int32_t);
void codegen_finalize(int32_t, int32_t, int32_t);
void codegen_call_cache(int32_t);

void generate_instruction(int32_t opcode)
{
    gen_set_previous_eip();
    gen_increment_instruction_pointer(0);

    int32_t start_eip = *instruction_pointer - 1;

    jit_instruction(opcode);

    int32_t end_eip = *instruction_pointer;
    int32_t instruction_length = end_eip - start_eip;

    assert(instruction_length >= 0 && instruction_length < 16);
    dbg_log("instruction_length=%d", instruction_length);

    gen_patch_increment_instruction_pointer(instruction_length);
}

void cycle_internal()
{
#if ENABLE_JIT
/* Use JIT mode */
    int32_t eip = *instruction_pointer;
    // Save previous_ip now since translate_address_read might trigger a page-fault
    *previous_ip = *instruction_pointer;

    if((eip & ~0xFFF) ^ *last_virt_eip)
    {
        *eip_phys = translate_address_read(eip) ^ eip;
        *last_virt_eip = eip & ~0xFFF;
    }

    uint32_t phys_addr = *eip_phys ^ eip;
    assert(!in_mapped_range(phys_addr));

    uint16_t addr_index = phys_addr & JIT_PHYS_MASK;
    struct code_cache *entry = &jit_cache_arr[addr_index];
    bool cached = entry->start_addr == phys_addr && entry->is_32 == *is_32;
    bool clean = entry->group_status == group_dirtiness[phys_addr >> DIRTY_ARR_SHIFT];

    const bool JIT_ALWAYS = false;
    const bool JIT_DONT_USE_CACHE = false;

    if(!JIT_DONT_USE_CACHE &&
       entry->group_status == group_dirtiness[phys_addr >> DIRTY_ARR_SHIFT] &&
       entry->start_addr == phys_addr)
    {
        // XXX: With the code-generation, we need to figure out how we
        // would call the function from the other module here; likely
        // through a handler in JS. For now:

        // Confirm that cache is not dirtied (through page-writes,
        // mode switch, or just cache eviction)
        /*
        for(int32_t i = 0; i < entry->len; i++)
        {
            *previous_ip = *instruction_pointer;
            int32_t opcode = read_imm8();
            phys_addr = *eip_phys ^ (*instruction_pointer - 1);
            assert(opcode == entry->opcode[i]);
            run_instruction(entry->opcode[i] | !!*is_32 << 8);
            (*timestamp_counter)++;
        }*/

        codegen_call_cache(phys_addr);

        // XXX: Try to find an assert to detect self-modifying code
        // JIT compiled self-modifying basic blocks may trigger this assert
        // assert(entry->group_status != group_dirtiness[entry->start_addr >> DIRTY_ARR_SHIFT]);
        *cache_hit = *cache_hit + 1;
    }
    // A jump just occured indicating the start of a basic block + the
    // address is hot; let's JIT compile it
    else if(JIT_ALWAYS || jit_jump == 1 && ++hot_code_addresses[jit_hot_hash(phys_addr)] > JIT_THRESHOLD)
    {
        int32_t start_addr = *instruction_pointer;
        jit_in_progress = false;

        // Minimize collision based thrashing
        hot_code_addresses[jit_hot_hash(phys_addr)] = 0;

        jit_jump = 0;
        entry->len = 0;
        entry->start_addr = phys_addr;
        entry->end_addr = phys_addr + 1;
        entry->is_32 = *is_32;
        jit_cache_arr[addr_index] = *entry;

        *cache_compile = *cache_compile + 1;

        gen_reset();

        // XXX: Artificial limit allows jit_dirty_cache to be
        // simplified by only dirtying 2 entries based on a mask
        // (instead of all possible entries)
        while(jit_jump == 0 && entry->len < 100 &&
              (entry->end_addr - entry->start_addr) < MAX_BLOCK_LENGTH)
        {
            *previous_ip = *instruction_pointer;
            int32_t opcode = read_imm8();

            entry->opcode[entry->len] = opcode;
            entry->len++;

            generate_instruction(opcode | !!*is_32 << 8);

            entry->end_addr = *eip_phys ^ *instruction_pointer;
        }

        jit_jump = 0;

        gen_finish();
        jit_in_progress = false;

        codegen_finalize(start_addr, entry->start_addr, entry->end_addr);

        assert(*prefixes == 0);

        // When the hot instruction is a jmp (backwards),
        // leave its group_status unupdated, thereby invalidating it
        //if (entry->end_addr > entry->start_addr)
        //{
        entry->group_status = group_dirtiness[phys_addr >> DIRTY_ARR_SHIFT];
        //}
    }
    // Regular un-hot code execution
    else
    {
        jit_jump = 0;
        int32_t opcode = read_imm8();
        run_instruction(opcode | !!*is_32 << 8);
        (*timestamp_counter)++;
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

static void run_prefix_instruction()
{
    run_instruction(read_imm8() | is_osize_32() << 8);
}

static void jit_prefix_instruction()
{
    dbg_log("jit_prefix_instruction is32=%d", is_osize_32());
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

static int32_t get_reg8_index(int32_t index) { return index << 2 & 0xC | index >> 2 & 1; }

static int32_t read_reg8(int32_t index)
{
    return reg8[get_reg8_index(index)];
}

static void write_reg8(int32_t index, int32_t value)
{
    reg8[get_reg8_index(index)] = value;
}

static int32_t get_reg16_index(int32_t index) { return index << 1; }

static int32_t read_reg16(int32_t index)
{
    return reg16[get_reg16_index(index)];
}

static void write_reg16(int32_t index, int32_t value)
{
    reg16[get_reg16_index(index)] = value;
}


static int32_t read_reg32(int32_t index)
{
    return reg32s[index];
}

static void write_reg32(int32_t index, int32_t value)
{
    reg32s[index] = value;
}

static void write_reg_osize(int32_t index, int32_t value)
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

uint64_t read_tsc()
{
    double_t n = microtick() - tsc_offset[0]; // XXX: float
    n = n * TSC_RATE;
    return n;
}
