#pragma once

#include <stdint.h>

#include "wasm_opcodes.h"
#include "util.h"

static void inline push_i32(Buffer* buf, int32_t v)
{
    write_raw_u8(buf, OP_I32CONST);
    write_leb_i32(buf, v);
}

static void inline push_u32(Buffer* buf, uint32_t v)
{
    write_raw_u8(buf, OP_I32CONST);
    write_leb_u32(buf, v);
}

static void inline load_aligned_u16(Buffer* buf, uint32_t addr)
{
    // doesn't cause a failure in the generated code, but it will be much slower
    assert((addr & 1) == 0);

    write_raw_u8(buf, OP_I32CONST);
    write_leb_i32(buf, addr);
    write_raw_u8(buf, OP_I32LOAD16U);
    write_raw_u8(buf, MEM_ALIGN16);
    write_raw_u8(buf, MEM_IMM_OFFSET);
}

static void inline load_aligned_i32(Buffer* buf, uint32_t addr)
{
    // doesn't cause a failure in the generated code, but it will be much slower
    assert((addr & 3) == 0);

    write_raw_u8(buf, OP_I32CONST);
    write_leb_i32(buf, addr);
    write_raw_u8(buf, OP_I32LOAD);
    write_raw_u8(buf, MEM_ALIGN32);
    write_raw_u8(buf, MEM_IMM_OFFSET);
}

static void inline store_aligned_u16(Buffer* buf)
{
    write_raw_u8(buf, OP_I32STORE16);
    write_raw_u8(buf, MEM_ALIGN16);
    write_raw_u8(buf, MEM_IMM_OFFSET);
}

static void inline store_aligned_i32(Buffer* buf)
{
    write_raw_u8(buf, OP_I32STORE);
    write_raw_u8(buf, MEM_ALIGN32);
    write_raw_u8(buf, MEM_IMM_OFFSET);
}

static void inline add_i32(Buffer* buf)
{
    write_raw_u8(buf, OP_I32ADD);
}

static void inline and_i32(Buffer* buf)
{
    write_raw_u8(buf, OP_I32AND);
}

static void inline or_i32(Buffer* buf)
{
    write_raw_u8(buf, OP_I32OR);
}

static void inline shl_i32(Buffer* buf)
{
    write_raw_u8(buf, OP_I32SHL);
}

static void inline call_fn(Buffer* buf, uint8_t fn_idx)
{
    write_raw_u8(buf, OP_CALL);
    write_raw_u8(buf, fn_idx);
}

static void inline call_fn_with_arg(Buffer* buf, uint8_t fn_idx, int32_t arg0)
{
    push_i32(buf, arg0);
    call_fn(buf, fn_idx);
}

