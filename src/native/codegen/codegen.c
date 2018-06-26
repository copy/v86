#include <assert.h>
#include <stdint.h>
#include <stdlib.h>

#include "../const.h"
#include "../cpu.h"
#include "../global_pointers.h"
#include "../log.h"
#include "codegen.h"
#include "wasmgen.h"

static void jit_add_seg_offset(int32_t default_segment);
static void jit_resolve_modrm32_(int32_t modrm_byte);
static void jit_resolve_modrm16_(int32_t modrm_byte);
PackedStr pack_str(char const* fn_name, uint8_t fn_len);

void gen_reset(void)
{
    wg_reset();
    cs = wg_get_code_section();
    instruction_body = wg_get_instruction_body();
    add_get_seg_import();
}

void add_get_seg_import(void)
{
    uint16_t _fn_get_seg_idx = get_fn_idx("get_seg", 7, FN1_RET_TYPE_INDEX);
    assert(_fn_get_seg_idx == fn_get_seg_idx);
    UNUSED(_fn_get_seg_idx);
}

PackedStr pack_str(char const* fn_name, uint8_t fn_len)
{
    assert(fn_len <= 24);

    union {
        PackedStr pstr;
        uint8_t u8s[24];
    } ret = { { 0, 0, 0 } };
    
    for(int i = 0; i < fn_len; i++)
    {
        ret.u8s[i] = fn_name[i];
    }
    return ret.pstr;
}

uint16_t get_fn_idx(char const* fn, uint8_t fn_len, uint8_t fn_type)
{
    PackedStr pstr = pack_str(fn, fn_len);
    return wg_get_fn_idx(pstr.a, pstr.b, pstr.c, fn_type);
}

void gen_increment_mem32(int32_t addr)
{
    wg_increment_mem32(cs, addr);
}

void gen_increment_variable(int32_t variable_address, int32_t n)
{
    wg_increment_variable(cs, variable_address, n);
}

void gen_increment_instruction_pointer(int32_t n)
{
    wg_push_i32(cs, (int32_t)instruction_pointer); // store address of ip

    wg_load_aligned_i32(cs, (int32_t)instruction_pointer); // load ip

    wg_push_i32(cs, n);

    wg_add_i32(cs);
    wg_store_aligned_i32(cs); // store it back in
}

void gen_relative_jump(int32_t n)
{
    // add n to instruction_pointer (without setting the offset as above)
    wg_push_i32(instruction_body, (int32_t)instruction_pointer);
    wg_load_aligned_i32(instruction_body, (int32_t)instruction_pointer);
    wg_push_i32(instruction_body, n);
    wg_add_i32(instruction_body);
    wg_store_aligned_i32(instruction_body);
}

void gen_increment_timestamp_counter(uint32_t n)
{
    gen_increment_variable((int32_t)timestamp_counter, n);
}

void gen_set_previous_eip_offset_from_eip(int32_t n)
{
    wg_push_i32(cs, (int32_t)previous_ip); // store address of previous ip
    wg_load_aligned_i32(cs, (int32_t)instruction_pointer); // load ip
    if(n != 0)
    {
        wg_push_i32(cs, n);
        wg_add_i32(cs); // add constant to ip value
    }
    wg_store_aligned_i32(cs); // store it as previous ip
}

void gen_set_previous_eip(void)
{
    wg_push_i32(cs, (int32_t)previous_ip); // store address of previous ip
    wg_load_aligned_i32(cs, (int32_t)instruction_pointer); // load ip
    wg_store_aligned_i32(cs); // store it as previous ip
}

void gen_clear_prefixes(void)
{
    wg_push_i32(instruction_body, (int32_t)prefixes); // load address of prefixes
    wg_push_i32(instruction_body, 0);
    wg_store_aligned_i32(instruction_body);
}

void gen_add_prefix_bits(int32_t mask)
{
    assert(mask >= 0 && mask < 0x100);

    wg_push_i32(instruction_body, (int32_t)prefixes); // load address of prefixes

    wg_load_aligned_i32(instruction_body, (int32_t)prefixes); // load old value
    wg_push_i32(instruction_body, mask);
    wg_or_i32(instruction_body);

    wg_store_aligned_i32(instruction_body);
}

void gen_fn0_const_ret(char const* fn, uint8_t fn_len)
{
    int32_t fn_idx = get_fn_idx(fn, fn_len, FN0_RET_TYPE_INDEX);
    wg_call_fn(instruction_body, fn_idx);
}

void gen_fn0_const(char const* fn, uint8_t fn_len)
{
    int32_t fn_idx = get_fn_idx(fn, fn_len, FN0_TYPE_INDEX);
    wg_call_fn(instruction_body, fn_idx);
}

void gen_set_reg16_fn0(char const* fn, uint8_t fn_len, int32_t reg)
{
    // generates: reg16[reg] = fn()
    int32_t fn_idx = get_fn_idx(fn, fn_len, FN0_RET_TYPE_INDEX);
    wg_push_i32(instruction_body, (int32_t) &reg16[reg]);
    wg_call_fn(instruction_body, fn_idx);
    wg_store_aligned_u16(instruction_body);
}

void gen_set_reg32s_fn0(char const* fn, uint8_t fn_len, int32_t reg)
{
    // generates: reg32s[reg] = fn()
    int32_t fn_idx = get_fn_idx(fn, fn_len, FN0_RET_TYPE_INDEX);
    wg_push_i32(instruction_body, (int32_t) &reg32s[reg]);
    wg_call_fn(instruction_body, fn_idx);
    wg_store_aligned_i32(instruction_body);
}

void gen_fn1_const_ret(char const* fn, uint8_t fn_len, int32_t arg0)
{
    int32_t fn_idx = get_fn_idx(fn, fn_len, FN1_RET_TYPE_INDEX);
    wg_push_i32(instruction_body, arg0);
    wg_call_fn(instruction_body, fn_idx);
}

void gen_call_fn1_ret(char const* fn, uint8_t fn_len)
{
    // generates: fn( _ ) where _ must be left on the stack before calling this, and fn returns a value
    int32_t fn_idx = get_fn_idx(fn, fn_len, FN1_RET_TYPE_INDEX);
    wg_call_fn(instruction_body, fn_idx);
}

void gen_call_fn1(char const* fn, uint8_t fn_len)
{
    // generates: fn( _ ) where _ must be left on the stack before calling this
    int32_t fn_idx = get_fn_idx(fn, fn_len, FN1_TYPE_INDEX);
    wg_call_fn(instruction_body, fn_idx);
}

void gen_fn1_const(char const* fn, uint8_t fn_len, int32_t arg0)
{
    int32_t fn_idx = get_fn_idx(fn, fn_len, FN1_TYPE_INDEX);
    wg_push_i32(instruction_body, arg0);
    wg_call_fn(instruction_body, fn_idx);
}

void gen_set_reg16_r(int32_t r_dest, int32_t r_src)
{
    // generates: reg16[r_dest] = reg16[r_src]
    wg_push_i32(instruction_body, (int32_t) &reg16[r_dest]);
    wg_load_aligned_u16(instruction_body, (int32_t) &reg16[r_src]);
    wg_store_aligned_u16(instruction_body);
}

void gen_set_reg32_r(int32_t r_dest, int32_t r_src)
{
    // generates: reg32s[r_dest] = reg32s[r_src]
    wg_push_i32(instruction_body, (int32_t) &reg32s[r_dest]);
    wg_load_aligned_i32(instruction_body, (int32_t) &reg32s[r_src]);
    wg_store_aligned_i32(instruction_body);
}

void gen_fn1_reg16(char const* fn, uint8_t fn_len, int32_t reg)
{
    // generates: fn(reg16[reg])
    int32_t fn_idx = get_fn_idx(fn, fn_len, FN1_TYPE_INDEX);
    wg_load_aligned_u16(instruction_body, (int32_t) &reg16[reg]);
    wg_call_fn(instruction_body, fn_idx);
}

void gen_fn1_reg32s(char const* fn, uint8_t fn_len, int32_t reg)
{
    // generates: fn(reg32s[reg])
    int32_t fn_idx = get_fn_idx(fn, fn_len, FN1_TYPE_INDEX);
    wg_load_aligned_i32(instruction_body, (int32_t) &reg32s[reg]);
    wg_call_fn(instruction_body, fn_idx);
}


void gen_call_fn2(char const* fn, uint8_t fn_len)
{
    // generates: fn( _, _ ) where _ must be left on the stack before calling this
    int32_t fn_idx = get_fn_idx(fn, fn_len, FN2_TYPE_INDEX);
    wg_call_fn(instruction_body, fn_idx);
}

void gen_fn2_const(char const* fn, uint8_t fn_len, int32_t arg0, int32_t arg1)
{
    int32_t fn_idx = get_fn_idx(fn, fn_len, FN2_TYPE_INDEX);
    wg_push_i32(instruction_body, arg0);
    wg_push_i32(instruction_body, arg1);
    wg_call_fn(instruction_body, fn_idx);
}

void gen_fn3_const(char const* fn, uint8_t fn_len, int32_t arg0, int32_t arg1, int32_t arg2)
{
    int32_t fn_idx = get_fn_idx(fn, fn_len, FN3_TYPE_INDEX);
    wg_push_i32(instruction_body, arg0);
    wg_push_i32(instruction_body, arg1);
    wg_push_i32(instruction_body, arg2);
    wg_call_fn(instruction_body, fn_idx);
}

void gen_safe_read32(void)
{
    // Assumes virtual address has been pushed to the stack, and generates safe_read32s' fast-path
    // inline, bailing to safe_read32s_slow if necessary

    const int32_t address_local = GEN_LOCAL_SCRATCH0;
    wg_tee_local(instruction_body, address_local);

    // Pseudo: base_on_stack = (uint32_t)address >> 12;
    wg_push_i32(instruction_body, 12);
    wg_shr_u32(instruction_body);
    SCALE_INDEX_FOR_ARRAY32(tlb_data);

    // Pseudo: entry = tlb_data[base_on_stack];
    const int32_t entry_local = GEN_LOCAL_SCRATCH1;
    wg_load_aligned_i32_from_stack(instruction_body, (uint32_t) tlb_data);
    wg_tee_local(instruction_body, entry_local);

    // Pseudo: bool can_use_fast_path = (entry & 0xFFF & ~TLB_READONLY & ~TLB_GLOBAL & ~(cpl == 3 ? 0 : TLB_NO_USER) == TLB_VALID &&
    //                                   (address & 0xFFF) <= (0x1000 - 4));
    wg_push_i32(instruction_body, 0xFFF & ~TLB_READONLY & ~TLB_GLOBAL & ~(*cpl == 3 ? 0 : TLB_NO_USER));
    wg_and_i32(instruction_body);

    wg_push_i32(instruction_body, TLB_VALID);
    wg_eq_i32(instruction_body);

    wg_get_local(instruction_body, address_local);
    wg_push_i32(instruction_body, 0xFFF);
    wg_and_i32(instruction_body);
    wg_push_i32(instruction_body, 0x1000 - 4);
    wg_le_i32(instruction_body);

    wg_and_i32(instruction_body);

    // Pseudo:
    // if(can_use_fast_path) leave_on_stack(mem8[entry & ~0xFFF ^ address]);
    wg_if_i32(instruction_body);
    wg_get_local(instruction_body, entry_local);
    wg_push_i32(instruction_body, ~0xFFF);
    wg_and_i32(instruction_body);
    wg_get_local(instruction_body, address_local);
    wg_xor_i32(instruction_body);

    wg_load_unaligned_i32_from_stack(instruction_body, (uint32_t) mem8);

    // Pseudo:
    // else { leave_on_stack(safe_read32s_slow(address)); }
    wg_else(instruction_body);
    wg_get_local(instruction_body, address_local);
    gen_call_fn1_ret("safe_read32s_slow", 17);
    wg_block_end(instruction_body);
}

void gen_safe_write32(int32_t local_for_address, int32_t local_for_value)
{
    // Generates safe_write32' fast-path inline, bailing to safe_write32_slow if necessary.

    // local_for_{address,value} are the numbers of the local variables which contain the virtual
    // address and value for safe_write32
    // Usage:
    // set_local(0, value);
    // set_local(1, v_addr);
    // gen_safe_write32();

    // Since this function clobbers other variables, we confirm that the caller uses the local
    // variables we expect them to
    assert(local_for_address == GEN_LOCAL_SCRATCH0);
    assert(local_for_value == GEN_LOCAL_SCRATCH1);

    wg_get_local(instruction_body, local_for_address);

    // Pseudo: base_on_stack = (uint32_t)address >> 12;
    wg_push_i32(instruction_body, 12);
    wg_shr_u32(instruction_body);
    SCALE_INDEX_FOR_ARRAY32(tlb_data);

    // entry_local is only used in the following block, so the scratch variable can be reused later
    {
        // Pseudo: entry = tlb_data[base_on_stack];
        const int32_t entry_local = GEN_LOCAL_SCRATCH2;
        wg_load_aligned_i32_from_stack(instruction_body, (uint32_t) tlb_data);
        wg_tee_local(instruction_body, entry_local);

        // Pseudo: bool can_use_fast_path = (entry & 0xFFF & ~TLB_GLOBAL & ~(cpl == 3 ? 0 : TLB_NO_USER) == TLB_VALID &&
        //                                   (address & 0xFFF) <= (0x1000 - 4));
        wg_push_i32(instruction_body, 0xFFF & ~TLB_GLOBAL & ~(*cpl == 3 ? 0 : TLB_NO_USER));
        wg_and_i32(instruction_body);

        wg_push_i32(instruction_body, TLB_VALID);
        wg_eq_i32(instruction_body);

        wg_get_local(instruction_body, local_for_address);
        wg_push_i32(instruction_body, 0xFFF);
        wg_and_i32(instruction_body);
        wg_push_i32(instruction_body, 0x1000 - 4);
        wg_le_i32(instruction_body);

        wg_and_i32(instruction_body);

        // Pseudo:
        // if(can_use_fast_path)
        // {
        //     phys_addr = entry & ~0xFFF ^ address;
        wg_if_void(instruction_body);

        wg_get_local(instruction_body, entry_local);
        wg_push_i32(instruction_body, ~0xFFF);
        wg_and_i32(instruction_body);
        wg_get_local(instruction_body, local_for_address);
        wg_xor_i32(instruction_body);
    }

    // entry_local isn't needed anymore, so we overwrite it
    const int32_t phys_addr_local = GEN_LOCAL_SCRATCH2;
    // Pseudo:
    //     /* continued within can_use_fast_path branch */
    //     mem8[phys_addr] = value;

    wg_tee_local(instruction_body, phys_addr_local);
    wg_get_local(instruction_body, local_for_value);
    wg_store_unaligned_i32(instruction_body, (uint32_t) mem8);

    // Only call jit_dirty_cache_single if absolutely necessary
    // Pseudo:
    //     /* continued within can_use_fast_path branch */
    //     if(page_first_jit_cache_entry[phys_address >> 12] != JIT_CACHE_ARRAY_NO_NEXT_ENTRY ||
    //        page_entry_points[phys_address >> 12] != ENTRY_POINT_END)
    //     {
    //         jit_dirty_cache_single(phys_address);
    //     }
    // }

    wg_get_local(instruction_body, phys_addr_local);
    wg_push_i32(instruction_body, 12);
    wg_shr_u32(instruction_body);

    SCALE_INDEX_FOR_ARRAY32(page_first_jit_cache_entry);
    wg_load_aligned_i32_from_stack(instruction_body, (uint32_t) page_first_jit_cache_entry);

    wg_push_i32(instruction_body, JIT_CACHE_ARRAY_NO_NEXT_ENTRY);
    wg_ne_i32(instruction_body);

    wg_get_local(instruction_body, phys_addr_local);
    wg_push_i32(instruction_body, 12);
    wg_shr_u32(instruction_body);
    wg_push_i32(instruction_body, 1);
    wg_shl_i32(instruction_body);
    wg_load_aligned_u16_from_stack(instruction_body, (uint32_t) page_entry_points);

    wg_push_i32(instruction_body, ENTRY_POINT_END);
    wg_ne_i32(instruction_body);

    wg_or_i32(instruction_body);

    wg_if_void(instruction_body);
    wg_get_local(instruction_body, phys_addr_local);
    gen_call_fn1("jit_dirty_cache_single", 22);
    wg_block_end(instruction_body);

    // Pseudo:
    // else { safe_read32_slow(address, value); }
    wg_else(instruction_body);
    wg_get_local(instruction_body, local_for_address);
    wg_get_local(instruction_body, local_for_value);
    gen_call_fn2("safe_write32_slow", 17);
    wg_block_end(instruction_body);
}

#define MODRM_ENTRY(n, work)\
    case (n) | 0 << 3:\
    case (n) | 1 << 3:\
    case (n) | 2 << 3:\
    case (n) | 3 << 3:\
    case (n) | 4 << 3:\
    case (n) | 5 << 3:\
    case (n) | 6 << 3:\
    case (n) | 7 << 3:\
        (work); break;

#define MODRM_ENTRY16_0(row, seg, reg1, reg2)\
    MODRM_ENTRY(0x00 | (row), gen_modrm_entry_0((seg), (reg1), (reg2), 0))\
    MODRM_ENTRY(0x40 | (row), gen_modrm_entry_0((seg), (reg1), (reg2), read_imm8s()))\
    MODRM_ENTRY(0x80 | (row), gen_modrm_entry_0((seg), (reg1), (reg2), read_imm16()))

#define MODRM_ENTRY16_1(row, seg, reg)\
    MODRM_ENTRY(0x00 | (row), gen_modrm_entry_1(seg, reg, 0))\
    MODRM_ENTRY(0x40 | (row), gen_modrm_entry_1(seg, reg, read_imm8s()))\
    MODRM_ENTRY(0x80 | (row), gen_modrm_entry_1(seg, reg, read_imm16()))

static void inline gen_modrm_entry_0(int32_t segment, int32_t reg16_idx_1, int32_t reg16_idx_2, int32_t imm)
{
    // generates: fn( ( reg1 + reg2 + imm ) & 0xFFFF )
    wg_load_aligned_u16(instruction_body, reg16_idx_1);
    wg_load_aligned_u16(instruction_body, reg16_idx_2);
    wg_add_i32(instruction_body);

    if(imm)
    {
        wg_push_i32(instruction_body, imm);
        wg_add_i32(instruction_body);
    }

    wg_push_i32(instruction_body, 0xFFFF);
    wg_and_i32(instruction_body);

    jit_add_seg_offset(segment);
}

static void gen_modrm_entry_1(int32_t segment, int32_t reg16_idx, int32_t imm)
{
    // generates: fn ( ( reg + imm ) & 0xFFFF )
    wg_load_aligned_u16(instruction_body, reg16_idx);

    if(imm)
    {
        wg_push_i32(instruction_body, imm);
        wg_add_i32(instruction_body);
    }

    wg_push_i32(instruction_body, 0xFFFF);
    wg_and_i32(instruction_body);

    jit_add_seg_offset(segment);
}

static bool can_optimize_get_seg(int32_t segment)
{
    return (segment == DS || segment == SS) && has_flat_segmentation();
}

/*
 * Note: Requires an existing value to be on the WASM stack! Based on optimization possibilities,
 * the value will be consumed and added to get_seg(segment), or it'll be left as-is
 */
static void jit_add_seg_offset(int32_t default_segment)
{
    int32_t prefix = *prefixes & PREFIX_MASK_SEGMENT;
    int32_t seg = prefix ? prefix - 1 : default_segment;

    if(can_optimize_get_seg(seg) || prefix == SEG_PREFIX_ZERO)
    {
        return;
    }

    wg_push_i32(instruction_body, seg);
    wg_call_fn(instruction_body, fn_get_seg_idx);
    wg_add_i32(instruction_body);
}

static void gen_modrm_entry_2()
{
    wg_push_i32(instruction_body, read_imm16());
    jit_add_seg_offset(DS);
}

static void jit_resolve_modrm16_(int32_t modrm_byte)
{
    switch(modrm_byte)
    {
        // The following casts cause some weird issue with emscripten and cause
        // a performance hit. XXX: look into this later.
        MODRM_ENTRY16_0(0, DS, (int32_t)(reg16 + BX), (int32_t)(reg16 + SI))
        MODRM_ENTRY16_0(1, DS, (int32_t)(reg16 + BX), (int32_t)(reg16 + DI))
        MODRM_ENTRY16_0(2, SS, (int32_t)(reg16 + BP), (int32_t)(reg16 + SI))
        MODRM_ENTRY16_0(3, SS, (int32_t)(reg16 + BP), (int32_t)(reg16 + DI))
        MODRM_ENTRY16_1(4, DS, (int32_t)(reg16 + SI))
        MODRM_ENTRY16_1(5, DS, (int32_t)(reg16 + DI))

        // special case
        MODRM_ENTRY(0x00 | 6, gen_modrm_entry_2())
        MODRM_ENTRY(0x40 | 6, gen_modrm_entry_1(SS, (int32_t)(reg16 + BP), read_imm8s()))
        MODRM_ENTRY(0x80 | 6, gen_modrm_entry_1(SS, (int32_t)(reg16 + BP), read_imm16()))

        MODRM_ENTRY16_1(7, DS, (int32_t)(reg16 + BX))

        default:
            assert(false);
    }
}

#define MODRM_ENTRY32_0(row, seg, reg)\
    MODRM_ENTRY(0x00 | (row), gen_modrm32_entry(seg, reg, 0))\
    MODRM_ENTRY(0x40 | (row), gen_modrm32_entry(seg, reg, read_imm8s()))\
    MODRM_ENTRY(0x80 | (row), gen_modrm32_entry(seg, reg, read_imm32s()))

static void gen_modrm32_entry(int32_t segment, int32_t reg32s_idx, int32_t imm)
{
    // generates: fn ( reg + imm )
    wg_load_aligned_i32(instruction_body, reg32s_idx);

    if(imm)
    {
        wg_push_i32(instruction_body, imm);
        wg_add_i32(instruction_body);
    }

    jit_add_seg_offset(segment);
}

static void jit_resolve_sib(bool mod)
{
    uint8_t sib_byte = read_imm8();
    uint8_t r = sib_byte & 7;
    uint8_t m = sib_byte >> 3 & 7;

    int32_t base_addr;
    int32_t base;
    uint8_t seg;
    bool base_is_mem_access = true;

    if(r == 4)
    {
        base_addr = (int32_t)(reg32s + ESP);
        seg = SS;
    }
    else if(r == 5)
    {
        if(mod)
        {
            base_addr = (int32_t)(reg32s + EBP);
            seg = SS;
        }
        else
        {
            base = read_imm32s();
            seg = DS;
            base_is_mem_access = false;
        }
    }
    else
    {
        base_addr = (int32_t)(reg32s + r);
        seg = DS;
    }

    // generate: get_seg_prefix(seg) + base
    // Where base is accessed from memory if base_is_mem_access or written as a constant otherwise
    if(base_is_mem_access)
    {
        wg_load_aligned_i32(instruction_body, base_addr);
    }
    else
    {
        wg_push_i32(instruction_body, base);
    }

    jit_add_seg_offset(seg);

    // We now have to generate an offset value to add

    if(m == 4)
    {
        // offset is 0, we don't need to add anything
        return;
    }

    // Offset is reg32s[m] << s, where s is:

    uint8_t s = sib_byte >> 6 & 3;

    wg_load_aligned_i32(instruction_body, (int32_t)(reg32s + m));
    wg_push_i32(instruction_body, s);
    wg_shl_i32(instruction_body);

    wg_add_i32(instruction_body);
}

static void modrm32_special_case_1(void)
{
    jit_resolve_sib(true);

    int32_t imm = read_imm8s();

    if(imm)
    {
        wg_push_i32(instruction_body, imm);
        wg_add_i32(instruction_body);
    }
}

static void modrm32_special_case_2(void)
{
    jit_resolve_sib(true);

    int32_t imm = read_imm32s();

    if(imm)
    {
        wg_push_i32(instruction_body, imm);
        wg_add_i32(instruction_body);
    }
}

static void gen_modrm32_entry_1()
{
    int32_t imm = read_imm32s();

    wg_push_i32(instruction_body, imm);
    jit_add_seg_offset(DS);
}

static void jit_resolve_modrm32_(int32_t modrm_byte)
{
    switch(modrm_byte)
    {
        MODRM_ENTRY32_0(0, DS, (int32_t)(reg32s + EAX))
        MODRM_ENTRY32_0(1, DS, (int32_t)(reg32s + ECX))
        MODRM_ENTRY32_0(2, DS, (int32_t)(reg32s + EDX))
        MODRM_ENTRY32_0(3, DS, (int32_t)(reg32s + EBX))

        // special cases
        MODRM_ENTRY(0x00 | 4, jit_resolve_sib(false))
        MODRM_ENTRY(0x40 | 4, modrm32_special_case_1())
        MODRM_ENTRY(0x80 | 4, modrm32_special_case_2())
        MODRM_ENTRY(0x00 | 5, gen_modrm32_entry_1())
        MODRM_ENTRY(0x40 | 5, gen_modrm32_entry(SS, (int32_t)(reg32s + EBP), read_imm8s()))
        MODRM_ENTRY(0x80 | 5, gen_modrm32_entry(SS, (int32_t)(reg32s + EBP), read_imm32s()))

        MODRM_ENTRY32_0(6, DS, (int32_t)(reg32s + ESI))
        MODRM_ENTRY32_0(7, DS, (int32_t)(reg32s + EDI))

        default:
            assert(false);
    }
}

#undef MODRM_ENTRY

// This function leaves a value on the wasm stack, to be consumed by one of the
// gen_modrm_fn* functions below
void gen_modrm_resolve(int32_t modrm_byte)
{
    if(is_asize_32())
    {
        jit_resolve_modrm32_(modrm_byte);
    }
    else
    {
        jit_resolve_modrm16_(modrm_byte);
    }
}

void gen_modrm_fn2(char const* fn, uint8_t fn_len, int32_t arg0, int32_t arg1)
{
    // generates: fn( _, arg0, arg1 )

    wg_push_i32(instruction_body, arg0);
    wg_push_i32(instruction_body, arg1);

    int32_t fn_idx = get_fn_idx(fn, fn_len, FN3_TYPE_INDEX);
    wg_call_fn(instruction_body, fn_idx);
}

void gen_modrm_fn1(char const* fn, uint8_t fn_len, int32_t arg0)
{
    // generates: fn( _, arg0 )

    wg_push_i32(instruction_body, arg0);

    int32_t fn_idx = get_fn_idx(fn, fn_len, FN2_TYPE_INDEX);
    wg_call_fn(instruction_body, fn_idx);
}

void gen_modrm_fn0(char const* fn, uint8_t fn_len)
{
    // generates: fn( _ )

    int32_t fn_idx = get_fn_idx(fn, fn_len, FN1_TYPE_INDEX);
    wg_call_fn(instruction_body, fn_idx);
}

