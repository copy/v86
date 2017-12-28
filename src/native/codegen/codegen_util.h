#pragma once

#include <stdint.h>

#include "util.h"

static uint8_t* const output = (uint8_t* const) 2048;

// pointer to next free byte slot in output buffer, incremented as we write along in the buffer
static uint8_t* op_ptr = output;

static uint8_t* const code_section = output + 1024;
static uint8_t* cs_ptr = code_section;

// JS can keep strings at this location for passing them to wasm
//XXX: figure out a better location for this
static uint8_t* const str_input = code_section - 32;

static void inline write_u8(uint8_t x)
{
    *op_ptr++ = x;
}

static void inline cs_write_u8(uint8_t x)
{
    *cs_ptr++ = x;
}

static void inline write_i32(int32_t x)
{
    op_ptr = _write_leb_i32(op_ptr, x);
}

static void inline cs_write_i32(int32_t x)
{
    cs_ptr = _write_leb_i32(cs_ptr, x);
}

static void inline write_u32(uint32_t x)
{
    op_ptr = _write_leb_u32(op_ptr, x);
}

static void inline cs_write_u32(uint32_t x)
{
    cs_ptr = _write_leb_u32(cs_ptr, x);
}

