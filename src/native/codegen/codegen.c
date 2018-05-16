#include <assert.h>
#include <stdint.h>
#include <stdlib.h>

#include "../const.h"
#include "../cpu.h"
#include "../global_pointers.h"
#include "codegen.h"
#include "cstring.h"
#include "module_init.h"
#include "util.h"
#include "wasm_opcodes.h"
#include "wasm_util.h"

static Buffer op = { .start = codegen_buffer_op, .ptr = codegen_buffer_op, .len = 0x10000 };
static Buffer cs = { .start = codegen_buffer_cs, .ptr = codegen_buffer_cs, .len = 0x10000 };
Buffer instruction_body = {
    .start = codegen_buffer_instruction_body,
    .ptr = codegen_buffer_instruction_body,
    .len = 0x10000,
};

static uint8_t* op_ptr_reset_location;
static uint32_t import_table_size_reset_value;
static uint32_t initial_import_count;

static void jit_add_seg_offset(int32_t default_segment);
static void jit_resolve_modrm32_(int32_t modrm_byte);
static void jit_resolve_modrm16_(int32_t modrm_byte);

void gen_init(void)
{
    // wasm magic header
    write_raw_u8(&op, 0); write_raw_u8(&op, 'a'); write_raw_u8(&op, 's'); write_raw_u8(&op, 'm');

    // wasm version in leb128, 4 bytes
    write_raw_u8(&op, WASM_VERSION); write_raw_u8(&op, 0); write_raw_u8(&op, 0); write_raw_u8(&op, 0);

    write_type_section();
    write_import_section_preamble();

    // add initial imports
    uint8_t _fn_get_seg_idx = write_import_entry("get_seg", 7, FN1_RET_TYPE_INDEX);
    assert(_fn_get_seg_idx == fn_get_seg_idx);
    UNUSED(_fn_get_seg_idx);

    // store state of current pointers etc. so we can reset them later
    op_ptr_reset_location = op.ptr;
    initial_import_count = *ptr_import_count;
    import_table_size_reset_value = import_table_size;
}

void gen_reset(void)
{
    op.ptr = op_ptr_reset_location;
    cs.ptr = cs.start;
    *ptr_import_count = initial_import_count;
    import_table_size = import_table_size_reset_value;
}

uintptr_t gen_finish(int32_t no_of_locals_i32)
{
    write_memory_import();
    write_function_section(1);
    write_export_section();

    uint8_t* ptr_code_section_size = (uint8_t*) 0; // initialized below
    uint8_t* ptr_fn_body_size = (uint8_t*) 0; // this as well

    // write code section preamble
    write_raw_u8(&op, SC_CODE);

    ptr_code_section_size = op.ptr; // we will write to this location later
    write_raw_u8(&op, 0); write_raw_u8(&op, 0); // write temp val for now using 4 bytes
    write_raw_u8(&op, 0); write_raw_u8(&op, 0);

    write_raw_u8(&op, 1); // number of function bodies: just 1

    // same as above but for body size of the function
    ptr_fn_body_size = op.ptr;
    write_raw_u8(&op, 0); write_raw_u8(&op, 0);
    write_raw_u8(&op, 0); write_raw_u8(&op, 0);

    write_raw_u8(&op, 1); // count of local blocks
    write_raw_u8(&op, no_of_locals_i32); write_raw_u8(&op, TYPE_I32); // locals of type i32

    copy_code_section();

    // write code section epilogue
    write_raw_u8(&op, OP_END);

    // write the actual sizes to the pointer locations stored above. We subtract 4 from the actual
    // value because the ptr itself points to four bytes
    write_fixed_leb32_to_ptr(ptr_fn_body_size, op.ptr - ptr_fn_body_size - 4);
    write_fixed_leb32_to_ptr(ptr_code_section_size, op.ptr - ptr_code_section_size - 4);

    return (uintptr_t) op.ptr;
}

uintptr_t gen_get_final_offset(void)
{
    return (uintptr_t) op.ptr;
}

void gen_increment_mem32(int32_t addr)
{
    push_i32(&cs, addr);

    load_aligned_i32(&cs, addr);
    push_i32(&cs, 1);
    add_i32(&cs);

    store_aligned_i32(&cs);
}

void gen_increment_variable(int32_t variable_address, int32_t n)
{
    push_i32(&cs, variable_address);

    load_aligned_i32(&cs, variable_address);
    push_i32(&cs, n);
    add_i32(&cs);

    store_aligned_i32(&cs);
}

void gen_increment_instruction_pointer(int32_t n)
{
    push_i32(&cs, (int32_t)instruction_pointer); // store address of ip

    load_aligned_i32(&cs, (int32_t)instruction_pointer); // load ip

    push_i32(&cs, n);

    add_i32(&cs);
    store_aligned_i32(&cs); // store it back in
}

void gen_relative_jump(int32_t n)
{
    // add n to instruction_pointer (without setting the offset as above)
    push_i32(&instruction_body, (int32_t)instruction_pointer);
    load_aligned_i32(&instruction_body, (int32_t)instruction_pointer);
    push_i32(&instruction_body, n);
    add_i32(&instruction_body);
    store_aligned_i32(&instruction_body);
}

void gen_increment_timestamp_counter(uint32_t n)
{
    gen_increment_variable((int32_t)timestamp_counter, n);
}

void gen_set_previous_eip_offset_from_eip(int32_t n)
{
    push_i32(&cs, (int32_t)previous_ip); // store address of previous ip
    load_aligned_i32(&cs, (int32_t)instruction_pointer); // load ip
    if(n != 0)
    {
        push_i32(&cs, n);
        add_i32(&cs); // add constant to ip value
    }
    store_aligned_i32(&cs); // store it as previous ip
}

void gen_set_previous_eip(void)
{
    push_i32(&cs, (int32_t)previous_ip); // store address of previous ip
    load_aligned_i32(&cs, (int32_t)instruction_pointer); // load ip
    store_aligned_i32(&cs); // store it as previous ip
}

void gen_clear_prefixes(void)
{
    push_i32(&instruction_body, (int32_t)prefixes); // load address of prefixes
    push_i32(&instruction_body, 0);
    store_aligned_i32(&instruction_body);
}

void gen_add_prefix_bits(int32_t mask)
{
    assert(mask >= 0 && mask < 0x100);

    push_i32(&instruction_body, (int32_t)prefixes); // load address of prefixes

    load_aligned_i32(&instruction_body, (int32_t)prefixes); // load old value
    push_i32(&instruction_body, mask);
    or_i32(&instruction_body);

    store_aligned_i32(&instruction_body);
}

void gen_fn0_const_ret(char const* fn, uint8_t fn_len)
{
    int32_t fn_idx = get_fn_index(fn, fn_len, FN0_RET_TYPE_INDEX);
    call_fn(&instruction_body, fn_idx);
}

void gen_fn0_const(char const* fn, uint8_t fn_len)
{
    int32_t fn_idx = get_fn_index(fn, fn_len, FN0_TYPE_INDEX);
    call_fn(&instruction_body, fn_idx);
}

void gen_set_reg16_fn0(char const* fn, uint8_t fn_len, int32_t reg)
{
    // generates: reg16[reg] = fn()
    int32_t fn_idx = get_fn_index(fn, fn_len, FN0_RET_TYPE_INDEX);
    push_i32(&instruction_body, (int32_t) &reg16[reg]);
    call_fn(&instruction_body, fn_idx);
    store_aligned_u16(&instruction_body);
}

void gen_set_reg32s_fn0(char const* fn, uint8_t fn_len, int32_t reg)
{
    // generates: reg32s[reg] = fn()
    int32_t fn_idx = get_fn_index(fn, fn_len, FN0_RET_TYPE_INDEX);
    push_i32(&instruction_body, (int32_t) &reg32s[reg]);
    call_fn(&instruction_body, fn_idx);
    store_aligned_i32(&instruction_body);
}

void gen_fn1_const_ret(char const* fn, uint8_t fn_len, int32_t arg0)
{
    int32_t fn_idx = get_fn_index(fn, fn_len, FN1_RET_TYPE_INDEX);
    push_i32(&instruction_body, arg0);
    call_fn(&instruction_body, fn_idx);
}

void gen_call_fn1_ret(char const* fn, uint8_t fn_len)
{
    // generates: fn( _ ) where _ must be left on the stack before calling this, and fn returns a value
    int32_t fn_idx = get_fn_index(fn, fn_len, FN1_RET_TYPE_INDEX);
    call_fn(&instruction_body, fn_idx);
}

void gen_call_fn1(char const* fn, uint8_t fn_len)
{
    // generates: fn( _ ) where _ must be left on the stack before calling this
    int32_t fn_idx = get_fn_index(fn, fn_len, FN1_TYPE_INDEX);
    call_fn(&instruction_body, fn_idx);
}

void gen_fn1_const(char const* fn, uint8_t fn_len, int32_t arg0)
{
    int32_t fn_idx = get_fn_index(fn, fn_len, FN1_TYPE_INDEX);
    push_i32(&instruction_body, arg0);
    call_fn(&instruction_body, fn_idx);
}

void gen_set_reg16_r(int32_t r_dest, int32_t r_src)
{
    // generates: reg16[r_dest] = reg16[r_src]
    push_i32(&instruction_body, (int32_t) &reg16[r_dest]);
    load_aligned_u16(&instruction_body, (int32_t) &reg16[r_src]);
    store_aligned_u16(&instruction_body);
}

void gen_set_reg32_r(int32_t r_dest, int32_t r_src)
{
    // generates: reg32s[r_dest] = reg32s[r_src]
    push_i32(&instruction_body, (int32_t) &reg32s[r_dest]);
    load_aligned_i32(&instruction_body, (int32_t) &reg32s[r_src]);
    store_aligned_i32(&instruction_body);
}

void gen_fn1_reg16(char const* fn, uint8_t fn_len, int32_t reg)
{
    // generates: fn(reg16[reg])
    int32_t fn_idx = get_fn_index(fn, fn_len, FN1_TYPE_INDEX);
    load_aligned_u16(&instruction_body, (int32_t) &reg16[reg]);
    call_fn(&instruction_body, fn_idx);
}

void gen_fn1_reg32s(char const* fn, uint8_t fn_len, int32_t reg)
{
    // generates: fn(reg32s[reg])
    int32_t fn_idx = get_fn_index(fn, fn_len, FN1_TYPE_INDEX);
    load_aligned_i32(&instruction_body, (int32_t) &reg32s[reg]);
    call_fn(&instruction_body, fn_idx);
}


void gen_call_fn2(char const* fn, uint8_t fn_len)
{
    // generates: fn( _, _ ) where _ must be left on the stack before calling this
    int32_t fn_idx = get_fn_index(fn, fn_len, FN2_TYPE_INDEX);
    call_fn(&instruction_body, fn_idx);
}

void gen_fn2_const(char const* fn, uint8_t fn_len, int32_t arg0, int32_t arg1)
{
    int32_t fn_idx = get_fn_index(fn, fn_len, FN2_TYPE_INDEX);
    push_i32(&instruction_body, arg0);
    push_i32(&instruction_body, arg1);
    call_fn(&instruction_body, fn_idx);
}

void gen_fn3_const(char const* fn, uint8_t fn_len, int32_t arg0, int32_t arg1, int32_t arg2)
{
    int32_t fn_idx = get_fn_index(fn, fn_len, FN3_TYPE_INDEX);
    push_i32(&instruction_body, arg0);
    push_i32(&instruction_body, arg1);
    push_i32(&instruction_body, arg2);
    call_fn(&instruction_body, fn_idx);
}

void gen_safe_read32(void)
{
    // Assumes virtual address has been pushed to the stack, and generates safe_read32s' fast-path
    // inline, bailing to safe_read32s_slow if necessary

    const int32_t address_local = GEN_LOCAL_SCRATCH0;
    gen_tee_local(address_local);

    // Pseudo: base_on_stack = (uint32_t)address >> 12;
    gen_const_i32(12);
    shr_u32(&instruction_body);
    SCALE_INDEX_FOR_ARRAY32(tlb_data);

    // Pseudo: entry = tlb_data[base_on_stack];
    const int32_t entry_local = GEN_LOCAL_SCRATCH1;
    load_aligned_i32_from_stack(&instruction_body, (uint32_t) tlb_data);
    gen_tee_local(entry_local);

    // Pseudo: bool can_use_fast_path = (entry & 0xFFF & ~TLB_READONLY & ~TLB_GLOBAL == TLB_VALID &&
    //                                   (address & 0xFFF) <= (0x1000 - 4));
    gen_const_i32(0xFFF & ~TLB_READONLY & ~TLB_GLOBAL);
    and_i32(&instruction_body);

    gen_const_i32(TLB_VALID);
    gen_eq_i32();

    gen_get_local(address_local);
    gen_const_i32(0xFFF);
    and_i32(&instruction_body);
    gen_const_i32(0x1000 - 4);
    gen_le_i32();

    and_i32(&instruction_body);

    // Pseudo:
    // if(can_use_fast_path) leave_on_stack(mem8[entry & ~0xFFF ^ address]);
    gen_if_i32();
    gen_get_local(entry_local);
    gen_const_i32(~0xFFF);
    and_i32(&instruction_body);
    gen_get_local(address_local);
    xor_i32(&instruction_body);

    load_unaligned_i32_from_stack(&instruction_body, (uint32_t) mem8);

    // Pseudo:
    // else { leave_on_stack(safe_read32s_slow(address)); }
    gen_else();
    gen_get_local(address_local);
    gen_call_fn1_ret("safe_read32s_slow", 17);
    gen_block_end();
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

    gen_get_local(local_for_address);

    // Pseudo: base_on_stack = (uint32_t)address >> 12;
    gen_const_i32(12);
    shr_u32(&instruction_body);
    SCALE_INDEX_FOR_ARRAY32(tlb_data);

    // entry_local is only used in the following block, so the scratch variable can be reused later
    {
        // Pseudo: entry = tlb_data[base_on_stack];
        const int32_t entry_local = GEN_LOCAL_SCRATCH2;
        load_aligned_i32_from_stack(&instruction_body, (uint32_t) tlb_data);
        gen_tee_local(entry_local);

        // Pseudo: bool can_use_fast_path = (entry & 0xFFF & ~TLB_GLOBAL == TLB_VALID &&
        //                                   (address & 0xFFF) <= (0x1000 - 4));
        gen_const_i32(0xFFF & ~TLB_GLOBAL);
        and_i32(&instruction_body);

        gen_const_i32(TLB_VALID);
        gen_eq_i32();

        gen_get_local(local_for_address);
        gen_const_i32(0xFFF);
        and_i32(&instruction_body);
        gen_const_i32(0x1000 - 4);
        gen_le_i32();

        and_i32(&instruction_body);

        // Pseudo:
        // if(can_use_fast_path)
        // {
        //     phys_addr = entry & ~0xFFF ^ address;
        gen_if_void();

        gen_get_local(entry_local);
        gen_const_i32(~0xFFF);
        and_i32(&instruction_body);
        gen_get_local(local_for_address);
        xor_i32(&instruction_body);
    }

    // entry_local isn't needed anymore, so we overwrite it
    const int32_t phys_addr_local = GEN_LOCAL_SCRATCH2;
    // Pseudo:
    //     /* continued within can_use_fast_path branch */
    //     mem8[phys_addr] = value;

    gen_tee_local(phys_addr_local);
    gen_get_local(local_for_value);
    store_unaligned_i32_with_offset(&instruction_body, (uint32_t) mem8);

    // Only call jit_dirty_cache_single if absolutely necessary
    // Pseudo:
    //     /* continued within can_use_fast_path branch */
    //     if(page_first_jit_cache_entry[phys_address >> 12] != JIT_CACHE_ARRAY_NO_NEXT_ENTRY)
    //     {
    //         jit_dirty_cache_single(phys_address);
    //     }
    // }

    gen_get_local(phys_addr_local);
    gen_const_i32(12);
    shr_u32(&instruction_body);

    SCALE_INDEX_FOR_ARRAY32(page_first_jit_cache_entry);
    load_aligned_i32_from_stack(&instruction_body, (uint32_t) page_first_jit_cache_entry);

    gen_const_i32(JIT_CACHE_ARRAY_NO_NEXT_ENTRY);
    gen_ne_i32();
    gen_if_void();
    gen_get_local(phys_addr_local);
    gen_call_fn1("jit_dirty_cache_single", 22);
    gen_block_end();

    // Pseudo:
    // else { safe_read32_slow(address, value); }
    gen_else();
    gen_get_local(local_for_address);
    gen_get_local(local_for_value);
    gen_call_fn2("safe_write32_slow", 17);
    gen_block_end();
}

void gen_add_i32(void)
{
    add_i32(&instruction_body);
}

void gen_eqz_i32(void)
{
    write_raw_u8(&instruction_body, OP_I32EQZ);
}

void gen_eq_i32(void)
{
    write_raw_u8(&instruction_body, OP_I32EQ);
}

void gen_ne_i32(void)
{
    write_raw_u8(&instruction_body, OP_I32NE);
}

void gen_le_i32(void)
{
    write_raw_u8(&instruction_body, OP_I32LES);
}

void gen_lt_i32(void)
{
    write_raw_u8(&instruction_body, OP_I32LTS);
}

void gen_ge_i32(void)
{
    write_raw_u8(&instruction_body, OP_I32GES);
}

void gen_gt_i32(void)
{
    write_raw_u8(&instruction_body, OP_I32GTS);
}

void gen_if_void(void)
{
    write_raw_u8(&instruction_body, OP_IF);
    write_raw_u8(&instruction_body, TYPE_VOID_BLOCK);
}

void gen_if_i32(void)
{
    write_raw_u8(&instruction_body, OP_IF);
    write_raw_u8(&instruction_body, TYPE_I32);
}

void gen_else(void)
{
    write_raw_u8(&instruction_body, OP_ELSE);
}

void gen_loop_void(void)
{
    write_raw_u8(&instruction_body, OP_LOOP);
    write_raw_u8(&instruction_body, TYPE_VOID_BLOCK);
}

void gen_block_void(void)
{
    write_raw_u8(&instruction_body, OP_BLOCK);
    write_raw_u8(&instruction_body, TYPE_VOID_BLOCK);
}

void gen_block_i32(void)
{
    write_raw_u8(&instruction_body, OP_BLOCK);
    write_raw_u8(&instruction_body, TYPE_I32);
}

void gen_block_end(void)
{
    write_raw_u8(&instruction_body, OP_END);
}

void gen_return(void)
{
    write_raw_u8(&instruction_body, OP_RETURN);
}

// Generate a br_table where an input of [i] will branch [i]th outer block,
// where [i] is passed on the wasm stack
void gen_brtable_and_cases(int32_t cases_count)
{
    assert(cases_count >= 0);

    write_raw_u8(&instruction_body, OP_BRTABLE);
    write_leb_u32(&instruction_body, cases_count);

    for(int32_t i = 0; i < cases_count + 1; i++)
    {
        write_leb_u32(&instruction_body, i);
    }
}

void gen_br(int32_t depth)
{
    write_raw_u8(&instruction_body, OP_BR);
    write_leb_i32(&instruction_body, depth);
}

void gen_get_local(int32_t idx)
{
    write_raw_u8(&instruction_body, OP_GETLOCAL);
    write_leb_i32(&instruction_body, idx);
}

void gen_set_local(int32_t idx)
{
    write_raw_u8(&instruction_body, OP_SETLOCAL);
    write_leb_i32(&instruction_body, idx);
}

void gen_tee_local(int32_t idx)
{
    write_raw_u8(&instruction_body, OP_TEELOCAL);
    write_leb_i32(&instruction_body, idx);
}

void gen_const_i32(int32_t v)
{
    push_i32(&instruction_body, v);
}

void gen_unreachable(void)
{
    write_raw_u8(&instruction_body, OP_UNREACHABLE);
}

void gen_load_aligned_i32_from_stack(uint32_t byte_offset)
{
    load_aligned_i32_from_stack(&instruction_body, byte_offset);
}

void gen_store_aligned_i32(void)
{
    store_aligned_i32(&instruction_body);
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
    load_aligned_u16(&instruction_body, reg16_idx_1);
    load_aligned_u16(&instruction_body, reg16_idx_2);
    add_i32(&instruction_body);

    if(imm)
    {
        push_i32(&instruction_body, imm);
        add_i32(&instruction_body);
    }

    push_i32(&instruction_body, 0xFFFF);
    and_i32(&instruction_body);

    jit_add_seg_offset(segment);
}

static void gen_modrm_entry_1(int32_t segment, int32_t reg16_idx, int32_t imm)
{
    // generates: fn ( ( reg + imm ) & 0xFFFF )
    load_aligned_u16(&instruction_body, reg16_idx);

    if(imm)
    {
        push_i32(&instruction_body, imm);
        add_i32(&instruction_body);
    }

    push_i32(&instruction_body, 0xFFFF);
    and_i32(&instruction_body);

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

    push_i32(&instruction_body, seg);
    call_fn(&instruction_body, fn_get_seg_idx);
    add_i32(&instruction_body);
}

static void gen_modrm_entry_2()
{
    push_i32(&instruction_body, read_imm16());
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
    load_aligned_i32(&instruction_body, reg32s_idx);

    if(imm)
    {
        push_i32(&instruction_body, imm);
        add_i32(&instruction_body);
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
        load_aligned_i32(&instruction_body, base_addr);
    }
    else
    {
        push_i32(&instruction_body, base);
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

    load_aligned_i32(&instruction_body, (int32_t)(reg32s + m));
    // We don't use push_u32 here either since s will fit in 1 byte
    write_raw_u8(&instruction_body, OP_I32CONST);
    write_raw_u8(&instruction_body, s);
    shl_i32(&instruction_body);

    add_i32(&instruction_body);
}

static void modrm32_special_case_1(void)
{
    jit_resolve_sib(true);

    int32_t imm = read_imm8s();

    if(imm)
    {
        push_i32(&instruction_body, imm);
        add_i32(&instruction_body);
    }
}

static void modrm32_special_case_2(void)
{
    jit_resolve_sib(true);

    int32_t imm = read_imm32s();

    if(imm)
    {
        push_i32(&instruction_body, imm);
        add_i32(&instruction_body);
    }
}

static void gen_modrm32_entry_1()
{
    int32_t imm = read_imm32s();

    push_i32(&instruction_body, imm);
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

    push_i32(&instruction_body, arg0);
    push_i32(&instruction_body, arg1);

    int32_t fn_idx = get_fn_index(fn, fn_len, FN3_TYPE_INDEX);
    call_fn(&instruction_body, fn_idx);
}

void gen_modrm_fn1(char const* fn, uint8_t fn_len, int32_t arg0)
{
    // generates: fn( _, arg0 )

    push_i32(&instruction_body, arg0);

    int32_t fn_idx = get_fn_index(fn, fn_len, FN2_TYPE_INDEX);
    call_fn(&instruction_body, fn_idx);
}

void gen_modrm_fn0(char const* fn, uint8_t fn_len)
{
    // generates: fn( _ )

    int32_t fn_idx = get_fn_index(fn, fn_len, FN1_TYPE_INDEX);
    call_fn(&instruction_body, fn_idx);
}

void gen_commit_instruction_body_to_cs(void)
{
    append_buffer(&cs, &instruction_body);
    instruction_body.ptr = instruction_body.start;
}
