#pragma once

#include <stdint.h>

#include "wasm_opcodes.h"
#include "codegen_util.h"

static void inline push_i32(int32_t v)
{
    cs_write_u8(OP_I32CONST);
    cs_write_i32(v);
}

static void inline push_u32(uint32_t v)
{
    cs_write_u8(OP_I32CONST);
    cs_write_u32(v);
}

static void inline load_u16(uint32_t addr)
{
    cs_write_u8(OP_I32CONST);
    cs_write_u32(addr);
    cs_write_u8(OP_I32LOAD16U);
    cs_write_u8(MEM_IMM_ALIGNMENT);
    cs_write_u8(MEM_IMM_OFFSET);
}

static void inline load_i32(uint32_t addr)
{
    cs_write_u8(OP_I32CONST);
    cs_write_u32(addr);
    cs_write_u8(OP_I32LOAD);
    cs_write_u8(MEM_IMM_ALIGNMENT);
    cs_write_u8(MEM_IMM_OFFSET);
}

static void inline store_i32()
{
    cs_write_u8(OP_I32STORE);
    cs_write_u8(MEM_IMM_ALIGNMENT);
    cs_write_u8(MEM_IMM_OFFSET);
}

static void inline add_i32()
{
    cs_write_u8(OP_I32ADD);
}

static void inline and_i32()
{
    cs_write_u8(OP_I32AND);
}

static void inline shl_i32()
{
    cs_write_u8(OP_I32SHL);
}

static void inline call_fn(uint8_t fn_idx)
{
    cs_write_u8(OP_CALL);
    cs_write_u8(fn_idx);
}

static void inline call_fn_with_arg(uint8_t fn_idx, int32_t arg0)
{
    push_i32(arg0);
    call_fn(fn_idx);
}

