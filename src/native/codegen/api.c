#include <stdint.h>
#include <stdlib.h>
#include <stdbool.h>
#include <assert.h>

#include "const.h"
#include "wasm_opcodes.h"
#include "util.h"
#include "codegen.h"
#include "wasm_util.h"

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

static void jit_resolve_modrm32_(int32_t);
static void jit_resolve_modrm16_(int32_t);

void gen_increment_instruction_pointer(int32_t n)
{
    push_i32((int32_t)instruction_pointer); // store address of ip

    load_i32((int32_t)instruction_pointer); // load ip
    push_i32(n); // load value to add to it
    add_i32();

    store_i32(); // store it back in
}

void gen_set_previous_eip()
{
    push_i32((int32_t)previous_ip); // store address of previous ip
    load_i32((int32_t)instruction_pointer); // load ip
    store_i32(); // store it as previous ip
}

void gen_fn0(char* fn, uint8_t fn_len)
{
    int32_t fn_idx = get_fn_index(fn, fn_len, FN0_TYPE_INDEX);
    call_fn(fn_idx);
}

void gen_fn1(char* fn, uint8_t fn_len, int32_t arg0)
{
    int32_t fn_idx = get_fn_index(fn, fn_len, FN1_TYPE_INDEX);
    push_i32(arg0);
    call_fn(fn_idx);
}

void gen_fn2(char* fn, uint8_t fn_len, int32_t arg0, int32_t arg1)
{
    int32_t fn_idx = get_fn_index(fn, fn_len, FN2_TYPE_INDEX);
    push_i32(arg0);
    push_i32(arg1);
    call_fn(fn_idx);
}

void gen_drop()
{
    cs_write_u8(OP_DROP);
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
    load_u16(reg16_idx_1);
    load_u16(reg16_idx_2);
    add_i32();

    push_i32(imm);
    add_i32();

    push_i32(0xFFFF);
    and_i32();

    call_fn(fn_idx);
}

static void gen_modrm_entry_1(int32_t fn_idx, int32_t reg16_idx, int32_t imm)
{
    // generates: fn ( ( reg + imm ) & 0xFFFF )
    load_u16(reg16_idx);
    push_i32(imm);
    add_i32();

    push_i32(0xFFFF);
    and_i32();

    call_fn(fn_idx);
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
        MODRM_ENTRY(0x00 | 6, call_fn_with_arg(ds, read_imm16()))
        MODRM_ENTRY(0x40 | 6, gen_modrm_entry_1(ss, (int32_t)(reg16 + BP), read_imm8s()))
        MODRM_ENTRY(0x80 | 6, gen_modrm_entry_1(ss, (int32_t)(reg16 + BP), read_imm16()))

        MODRM_ENTRY16_1(7, ds, (int32_t)(reg16 + BX))

        default:
            assert(false);
    }
}

void gen_resolve_modrm16(int32_t modrm_byte)
{
    push_u32(RESULT_LOC);
    jit_resolve_modrm16_(modrm_byte);
    store_i32();
}

#define MODRM_ENTRY32_0(row, seg, reg)\
    MODRM_ENTRY(0x00 | row, gen_modrm32_entry(seg, reg, 0))\
    MODRM_ENTRY(0x40 | row, gen_modrm32_entry(seg, reg, read_imm8s()))\
    MODRM_ENTRY(0x80 | row, gen_modrm32_entry(seg, reg, read_imm32s()))

static void gen_modrm32_entry(int32_t fn_idx, int32_t reg32s_idx, int32_t imm)
{
    // generates: fn ( reg + imm )
    load_i32(reg32s_idx);
    push_i32(imm);
    add_i32();

    call_fn(fn_idx);
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
    cs_write_u8(OP_I32CONST);
    cs_write_u8(seg);

    call_fn(fn_get_seg_prefix_idx);

    if(base_is_mem_access)
    {
        load_i32(base_addr);
    }
    else
    {
        push_i32(base);
    }

    add_i32();

    // We now have to generate an offset value to add

    if(m == 4)
    {
        // offset is 0, we don't need to add anything
        return;
    }

    // Offset is reg32s[m] << s, where s is:

    uint8_t s = sib_byte >> 6 & 3;

    load_i32((int32_t)(reg32s + m));
    // We don't use push_u32 here either since s will fit in 1 byte
    cs_write_u8(OP_I32CONST);
    cs_write_u8(s);
    shl_i32();

    add_i32();
}

static void modrm32_special_case_1()
{
    jit_resolve_sib(true);
    push_i32(read_imm8s());
    add_i32();
}

static void modrm32_special_case_2()
{
    jit_resolve_sib(true);
    push_i32(read_imm32s());
    add_i32();
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
        MODRM_ENTRY(0x00 | 5, call_fn_with_arg(ds, read_imm32s()))
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
    push_i32(RESULT_LOC);
    jit_resolve_modrm32_(modrm_byte);
    store_i32();
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

    push_i32(arg0);

    int32_t fn_idx = get_fn_index(fn, fn_len, FN2_RET_TYPE_INDEX);
    call_fn(fn_idx);
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
    call_fn(fn_idx);
}

