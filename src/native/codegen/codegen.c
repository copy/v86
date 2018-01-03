#include <stdint.h>
#include <stdlib.h>
#include <assert.h>

#include "cstring.h"
#include "const.h"
#include "wasm_opcodes.h"
#include "codegen.h"
#include "util.h"
#include "wasm_util.h"
#include "module_init.h"

static Buffer op = { .start = (uint8_t* const) 2048, .ptr = (uint8_t*) 2048, .len = 1024 };
static Buffer cs = { .start = (uint8_t* const) 3072, .ptr = (uint8_t*) 3072, .len = 1024 };

// location in memory where we store the result of the computation for testing
#define RESULT_LOC 1600

extern bool is_asize_32(void);
extern int32_t read_imm8();
extern int32_t read_imm8s();
extern int32_t read_imm16();
extern int32_t read_imm32s();
extern int32_t get_fn_index(char* fn, uint8_t fn_len, uint8_t type_index);

extern int32_t* const instruction_pointer;
extern int32_t* const previous_ip;
extern uint8_t* const reg8;
extern uint16_t* const reg16;
extern int8_t* const reg8s;
extern int16_t* const reg16s;
extern int32_t* const reg32s;

static uint8_t* op_ptr_reset_location;
static uint32_t import_table_size_reset_value;
static uint32_t initial_import_count;
static void jit_resolve_modrm32_(int32_t);
static void jit_resolve_modrm16_(int32_t);

void gen_init()
{
    // wasm magic header
    write_raw_u8(&op, 0); write_raw_u8(&op, 'a'); write_raw_u8(&op, 's'); write_raw_u8(&op, 'm');

    // wasm version in leb128, 4 bytes
    write_raw_u8(&op, WASM_VERSION); write_raw_u8(&op, 0); write_raw_u8(&op, 0); write_raw_u8(&op, 0);

    write_type_section();
    write_import_section_preamble();

    // add initial imports
    uint8_t _fn_get_seg_prefix_ds_idx = write_import_entry(
            "get_seg_prefix_ds", 17, FN1_RET_TYPE_INDEX);
    assert(_fn_get_seg_prefix_ds_idx == fn_get_seg_prefix_ds_idx);

    uint8_t _fn_get_seg_prefix_ss_idx = write_import_entry(
            "get_seg_prefix_ss", 17, FN1_RET_TYPE_INDEX);
    assert(_fn_get_seg_prefix_ss_idx == fn_get_seg_prefix_ss_idx);

    uint8_t _fn_get_seg_prefix_idx = write_import_entry(
            "get_seg_prefix", 14, FN1_RET_TYPE_INDEX);
    assert(_fn_get_seg_prefix_idx == fn_get_seg_prefix_idx);

    // store state of current pointers etc. so we can reset them later
    op_ptr_reset_location = op.ptr;
    initial_import_count = *ptr_import_count;
    import_table_size_reset_value = import_table_size;
}

void gen_reset()
{
    op.ptr = op_ptr_reset_location;
    cs.ptr = cs.start;
    *ptr_import_count = initial_import_count;
    import_table_size = import_table_size_reset_value;
}

uintptr_t gen_finish()
{
    write_memory_import();
    write_function_section();
    write_export_section();

    uint8_t* ptr_code_section_size = (uint8_t*) 0; // initialized below
    uint8_t* ptr_fn_body_size = (uint8_t*) 0; // this as well

    // write code section preamble
    write_raw_u8(&op, SC_CODE);
    ptr_code_section_size = op.ptr; // we will write to this location later
    write_raw_u8(&op, 0); write_raw_u8(&op, 0); // write temp val for now using 2 bytes

    write_raw_u8(&op, 1); // number of function bodies: just 1

    // same as above but for body size of the function
    ptr_fn_body_size = op.ptr;
    write_raw_u8(&op, 0); write_raw_u8(&op, 0);

    write_raw_u8(&op, 0); // count of locals, none

    copy_code_section();

    // write code section epilogue
    write_raw_u8(&op, OP_END);

    // write the actual sizes to the pointer locations stored above. We subtract 1 from the actual
    // value because the ptr itself points to two bytes
    write_fixed_leb16_to_ptr(ptr_fn_body_size, ((op.ptr - 1) - ptr_fn_body_size) - 1);
    write_fixed_leb16_to_ptr(ptr_code_section_size, ((op.ptr - 1) - ptr_code_section_size) - 1);

    return (uintptr_t) op.ptr;
}

uintptr_t gen_get_final_offset()
{
    return (uintptr_t) op.ptr;
}

void gen_increment_instruction_pointer(int32_t n)
{
    push_i32(&cs, (int32_t)instruction_pointer); // store address of ip

    load_i32(&cs, (int32_t)instruction_pointer); // load ip
    push_i32(&cs, n); // load value to add to it
    add_i32(&cs);

    store_i32(&cs); // store it back in
}

void gen_set_previous_eip()
{
    push_i32(&cs, (int32_t)previous_ip); // store address of previous ip
    load_i32(&cs, (int32_t)instruction_pointer); // load ip
    store_i32(&cs); // store it as previous ip
}

void gen_fn0(char* fn, uint8_t fn_len)
{
    int32_t fn_idx = get_fn_index(fn, fn_len, FN0_TYPE_INDEX);
    call_fn(&cs, fn_idx);
}

void gen_fn1(char* fn, uint8_t fn_len, int32_t arg0)
{
    int32_t fn_idx = get_fn_index(fn, fn_len, FN1_TYPE_INDEX);
    push_i32(&cs, arg0);
    call_fn(&cs, fn_idx);
}

void gen_fn2(char* fn, uint8_t fn_len, int32_t arg0, int32_t arg1)
{
    int32_t fn_idx = get_fn_index(fn, fn_len, FN2_TYPE_INDEX);
    push_i32(&cs, arg0);
    push_i32(&cs, arg1);
    call_fn(&cs, fn_idx);
}

void gen_drop()
{
    write_raw_u8(&cs, OP_DROP);
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
        work; break;

#define MODRM_ENTRY16_0(row, seg, reg1, reg2)\
    MODRM_ENTRY(0x00 | row, gen_modrm_entry_0(seg, reg1, reg2, 0))\
    MODRM_ENTRY(0x40 | row, gen_modrm_entry_0(seg, reg1, reg2, read_imm8s()))\
    MODRM_ENTRY(0x80 | row, gen_modrm_entry_0(seg, reg1, reg2, read_imm16()))

#define MODRM_ENTRY16_1(row, seg, reg)\
    MODRM_ENTRY(0x00 | row, gen_modrm_entry_1(seg, reg, 0))\
    MODRM_ENTRY(0x40 | row, gen_modrm_entry_1(seg, reg, read_imm8s()))\
    MODRM_ENTRY(0x80 | row, gen_modrm_entry_1(seg, reg, read_imm16()))

static void inline gen_modrm_entry_0(int32_t fn_idx, int32_t reg16_idx_1, int32_t reg16_idx_2, int32_t imm)
{
    // generates: fn( ( reg1 + reg2 + imm ) & 0xFFFF )
    load_u16(&cs, reg16_idx_1);
    load_u16(&cs, reg16_idx_2);
    add_i32(&cs);

    push_i32(&cs, imm);
    add_i32(&cs);

    push_i32(&cs, 0xFFFF);
    and_i32(&cs);

    call_fn(&cs, fn_idx);
}

static void gen_modrm_entry_1(int32_t fn_idx, int32_t reg16_idx, int32_t imm)
{
    // generates: fn ( ( reg + imm ) & 0xFFFF )
    load_u16(&cs, reg16_idx);
    push_i32(&cs, imm);
    add_i32(&cs);

    push_i32(&cs, 0xFFFF);
    and_i32(&cs);

    call_fn(&cs, fn_idx);
}

static void jit_resolve_modrm16_(int32_t modrm_byte)
{
    int32_t const ds = fn_get_seg_prefix_ds_idx;
    int32_t const ss = fn_get_seg_prefix_ss_idx;

    switch(modrm_byte)
    {
        // The following casts cause some weird issue with emscripten and cause
        // a performance hit. XXX: look into this later.
        MODRM_ENTRY16_0(0, ds, (int32_t)(reg16 + BX), (int32_t)(reg16 + SI))
        MODRM_ENTRY16_0(1, ds, (int32_t)(reg16 + BX), (int32_t)(reg16 + DI))
        MODRM_ENTRY16_0(2, ss, (int32_t)(reg16 + BP), (int32_t)(reg16 + SI))
        MODRM_ENTRY16_0(3, ss, (int32_t)(reg16 + BP), (int32_t)(reg16 + DI))
        MODRM_ENTRY16_1(4, ds, (int32_t)(reg16 + SI))
        MODRM_ENTRY16_1(5, ds, (int32_t)(reg16 + DI))

        // special case
        MODRM_ENTRY(0x00 | 6, call_fn_with_arg(&cs, ds, read_imm16()))
        MODRM_ENTRY(0x40 | 6, gen_modrm_entry_1(ss, (int32_t)(reg16 + BP), read_imm8s()))
        MODRM_ENTRY(0x80 | 6, gen_modrm_entry_1(ss, (int32_t)(reg16 + BP), read_imm16()))

        MODRM_ENTRY16_1(7, ds, (int32_t)(reg16 + BX))

        default:
            assert(false);
    }
}

void gen_resolve_modrm16(int32_t modrm_byte)
{
    push_u32(&cs, RESULT_LOC);
    jit_resolve_modrm16_(modrm_byte);
    store_i32(&cs);
}

#define MODRM_ENTRY32_0(row, seg, reg)\
    MODRM_ENTRY(0x00 | row, gen_modrm32_entry(seg, reg, 0))\
    MODRM_ENTRY(0x40 | row, gen_modrm32_entry(seg, reg, read_imm8s()))\
    MODRM_ENTRY(0x80 | row, gen_modrm32_entry(seg, reg, read_imm32s()))

static void gen_modrm32_entry(int32_t fn_idx, int32_t reg32s_idx, int32_t imm)
{
    // generates: fn ( reg + imm )
    load_i32(&cs, reg32s_idx);
    push_i32(&cs, imm);
    add_i32(&cs);

    call_fn(&cs, fn_idx);
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

    dbg_assert(seg < 16);
    write_raw_u8(&cs, OP_I32CONST);
    write_raw_u8(&cs, seg);

    call_fn(&cs, fn_get_seg_prefix_idx);

    if(base_is_mem_access)
    {
        load_i32(&cs, base_addr);
    }
    else
    {
        push_i32(&cs, base);
    }

    add_i32(&cs);

    // We now have to generate an offset value to add

    if(m == 4)
    {
        // offset is 0, we don't need to add anything
        return;
    }

    // Offset is reg32s[m] << s, where s is:

    uint8_t s = sib_byte >> 6 & 3;

    load_i32(&cs, (int32_t)(reg32s + m));
    // We don't use push_u32 here either since s will fit in 1 byte
    write_raw_u8(&cs, OP_I32CONST);
    write_raw_u8(&cs, s);
    shl_i32(&cs);

    add_i32(&cs);
}

static void modrm32_special_case_1()
{
    jit_resolve_sib(true);
    push_i32(&cs, read_imm8s());
    add_i32(&cs);
}

static void modrm32_special_case_2()
{
    jit_resolve_sib(true);
    push_i32(&cs, read_imm32s());
    add_i32(&cs);
}

static void jit_resolve_modrm32_(int32_t modrm_byte)
{
    int32_t const ds = fn_get_seg_prefix_ds_idx;
    int32_t const ss = fn_get_seg_prefix_ss_idx;

    switch(modrm_byte)
    {
        MODRM_ENTRY32_0(0, ds, (int32_t)(reg32s + EAX))
        MODRM_ENTRY32_0(1, ds, (int32_t)(reg32s + ECX))
        MODRM_ENTRY32_0(2, ds, (int32_t)(reg32s + EDX))
        MODRM_ENTRY32_0(3, ds, (int32_t)(reg32s + EBX))

        // special cases
        MODRM_ENTRY(0x00 | 4, jit_resolve_sib(false))
        MODRM_ENTRY(0x40 | 4, modrm32_special_case_1())
        MODRM_ENTRY(0x80 | 4, modrm32_special_case_2())
        MODRM_ENTRY(0x00 | 5, call_fn_with_arg(&cs, ds, read_imm32s()))
        MODRM_ENTRY(0x40 | 5, gen_modrm32_entry(ss, (int32_t)(reg32s + EBP), read_imm8s()))
        MODRM_ENTRY(0x80 | 5, gen_modrm32_entry(ss, (int32_t)(reg32s + EBP), read_imm32s()))

        MODRM_ENTRY32_0(6, ds, (int32_t)(reg32s + ESI))
        MODRM_ENTRY32_0(7, ds, (int32_t)(reg32s + EDI))

        default:
            assert(false);
    }
}

void gen_resolve_modrm32(int32_t modrm_byte)
{
    push_i32(&cs, RESULT_LOC);
    jit_resolve_modrm32_(modrm_byte);
    store_i32(&cs);
}

#undef MODRM_ENTRY

void gen_modrm_fn1(char* fn, uint8_t fn_len, int32_t modrm_byte, int32_t arg0)
{
    // generates: fn( modrm_resolve( modrm_byte ), arg0 )
    if(is_asize_32())
    {
        jit_resolve_modrm32_(modrm_byte);
    }
    else
    {
        jit_resolve_modrm16_(modrm_byte);
    }

    push_i32(&cs, arg0);

    int32_t fn_idx = get_fn_index(fn, fn_len, FN2_RET_TYPE_INDEX);
    call_fn(&cs, fn_idx);
}

void gen_modrm_fn0(char* fn, uint8_t fn_len, int32_t modrm_byte)
{
    // generates: fn( modrm_resolve( modrm_byte ) )
    if(is_asize_32())
    {
        jit_resolve_modrm32_(modrm_byte);
    }
    else
    {
        jit_resolve_modrm16_(modrm_byte);
    }

    int32_t fn_idx = get_fn_index(fn, fn_len, FN1_RET_TYPE_INDEX);
    call_fn(&cs, fn_idx);
}

