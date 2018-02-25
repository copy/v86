#include <stdint.h>

#include "cpu.h"
#include "shared.h"
#include "sse_instr.h"

void mov_r_m64(int32_t addr, int32_t r)
{
    // mov* m64, mm
    task_switch_test_mmx();
    union reg64 data = read_mmx64s(r);
    safe_write64(addr, data.u64[0]);
}

void movl_r128_m64(int32_t addr, int32_t r)
{
    // mov* m64, xmm
    task_switch_test_mmx();
    union reg64 data = read_xmm64s(r);
    safe_write64(addr, data.u64[0]);
}

void mov_r_r128(int32_t r1, int32_t r2)
{
    // mov* xmm, xmm
    task_switch_test_mmx();
    union reg128 data = read_xmm128s(r2);
    write_xmm_reg128(r1, data);
}

void mov_r_m128(int32_t addr, int32_t r)
{
    // mov* m128, xmm
    task_switch_test_mmx();
    union reg128 data = read_xmm128s(r);
    safe_write128(addr, data);
}

void mov_rm_r128(union reg128 source, int32_t r)
{
    // mov* xmm, xmm/m128
    task_switch_test_mmx();
    write_xmm_reg128(r, source);
}

void movh_m64_r128(int32_t addr, int32_t r)
{
    // movhp* xmm, m64
    task_switch_test_mmx();
    union reg64 data = safe_read64s(addr);
    union reg128 orig = read_xmm128s(r);
    write_xmm128(r, orig.u32[0], orig.u32[1], data.u32[0], data.u32[1]);
}

void movh_r128_m64(int32_t addr, int32_t r)
{
    // movhp* m64, xmm
    task_switch_test_mmx();
    union reg128 data = read_xmm128s(r);
    safe_write64(addr, data.u64[1]);
}

void pand_r128(union reg128 source, int32_t r)
{
    // pand xmm, xmm/m128
    // XXX: Aligned access or #gp
    task_switch_test_mmx();

    union reg128 destination = read_xmm128s(r);
    union reg128 result = { { 0 } };

    result.u64[0] = source.u64[0] & destination.u64[0];
    result.u64[1] = source.u64[1] & destination.u64[1];

    write_xmm_reg128(r, result);
}

void pandn_r128(union reg128 source, int32_t r)
{
    // pandn xmm, xmm/m128
    // XXX: Aligned access or #gp
    task_switch_test_mmx();

    union reg128 destination = read_xmm128s(r);
    union reg128 result = { { 0 } };

    result.u64[0] = source.u64[0] & ~destination.u64[0];
    result.u64[1] = source.u64[1] & ~destination.u64[1];

    write_xmm_reg128(r, result);
}

void pxor_r128(union reg128 source, int32_t r)
{
    // pxor xmm, xmm/m128
    // XXX: Aligned access or #gp
    task_switch_test_mmx();

    union reg128 destination = read_xmm128s(r);
    union reg128 result = { { 0 } };

    result.u64[0] = source.u64[0] ^ destination.u64[0];
    result.u64[1] = source.u64[1] ^ destination.u64[1];

    write_xmm_reg128(r, result);
}

void por_r128(union reg128 source, int32_t r)
{
    // por xmm, xmm/m128
    // XXX: Aligned access or #gp
    task_switch_test_mmx();

    union reg128 destination = read_xmm128s(r);
    union reg128 result = { { 0 } };

    result.u64[0] = source.u64[0] | destination.u64[0];
    result.u64[1] = source.u64[1] | destination.u64[1];

    write_xmm_reg128(r, result);
}

void psrlw_r64(int32_t r, uint32_t shift)
{
    // psrlw mm, {shift}
    task_switch_test_mmx();
    union reg64 destination = read_mmx64s(r);
    int32_t dword0 = 0;
    int32_t dword1 = 0;

    if(shift <= 15)
    {
        dword0 = (destination.u16[0] >> shift) | (destination.u16[1] >> shift) << 16;
        dword1 = (destination.u16[2] >> shift) | (destination.u16[3] >> shift) << 16;
    }

    write_mmx64(r, dword0, dword1);
}

void psraw_r64(int32_t r, uint32_t shift)
{
    // psraw mm, {shift}
    task_switch_test_mmx();
    union reg64 destination = read_mmx64s(r);
    int32_t shift_clamped = shift > 15 ? 16 : shift;

    int32_t dword0 = (destination.i16[0] >> shift_clamped) & 0xFFFF |
        (destination.i16[1] >> shift_clamped) << 16;
    int32_t dword1 = (destination.i16[2] >> shift_clamped) & 0xFFFF |
        (destination.i16[3] >> shift_clamped) << 16;
    write_mmx64(r, dword0, dword1);
}

void psllw_r64(int32_t r, uint32_t shift)
{
    // psllw mm, {shift}
    task_switch_test_mmx();
    union reg64 destination = read_mmx64s(r);

    int32_t dword0 = 0;
    int32_t dword1 = 0;

    if(shift <= 15)
    {
        dword0 = (destination.u16[0] << shift & 0xFFFF) |
            (destination.u16[1] << shift) << 16;
        dword1 = (destination.u16[2] << shift & 0xFFFF) |
            (destination.u16[3] << shift) << 16;
    }

    write_mmx64(r, dword0, dword1);
}

void psrld_r64(int32_t r, uint32_t shift)
{
    // psrld mm, {shift}
    task_switch_test_mmx();
    union reg64 destination = read_mmx64s(r);

    int32_t dword0 = 0;
    int32_t dword1 = 0;

    if(shift <= 31)
    {
        dword0 = destination.u32[0] >> shift;
        dword1 = destination.u32[1] >> shift;
    }

    write_mmx64(r, dword0, dword1);
}

void psrad_r64(int32_t r, uint32_t shift)
{
    // psrad mm, {shift}
    task_switch_test_mmx();
    union reg64 destination = read_mmx64s(r);
    int32_t shift_clamped = shift > 31 ? 31 : shift;

    int32_t dword0 = destination.i32[0] >> shift_clamped;
    int32_t dword1 = destination.i32[1] >> shift_clamped;

    write_mmx64(r, dword0, dword1);
}

void pslld_r64(int32_t r, uint32_t shift)
{
    // pslld mm, {shift}
    task_switch_test_mmx();
    union reg64 destination = read_mmx64s(r);

    int32_t dword0 = 0;
    int32_t dword1 = 0;

    if(shift <= 31)
    {
        dword0 = destination.i32[0] << shift;
        dword1 = destination.i32[1] << shift;
    }

    write_mmx64(r, dword0, dword1);
}

void psrlq_r64(int32_t r, uint32_t shift)
{
    // psrlq mm, {shift}
    task_switch_test_mmx();

    if(shift == 0)
    {
        return;
    }

    union reg64 destination = read_mmx64s(r);
    union reg64 result = { { 0 } };

    if(shift <= 63)
    {
        result.u64[0] = destination.u64[0] >> shift;
    }

    write_mmx_reg64(r, result);
}

void psllq_r64(int32_t r, uint32_t shift)
{
    // psllq mm, {shift}
    task_switch_test_mmx();
    union reg64 destination = read_mmx64s(r);

    if(shift == 0)
    {
        return;
    }

    union reg64 result = { { 0 } };

    if(shift <= 63)
    {
        result.u64[0] = destination.u64[0] << shift;
    }

    write_mmx_reg64(r, result);
}

void psrlw_r128(int32_t r, uint32_t shift)
{
    // psrlw xmm, {shift}
    task_switch_test_mmx();
    union reg128 destination = read_xmm128s(r);
    int32_t dword0 = 0;
    int32_t dword1 = 0;
    int32_t dword2 = 0;
    int32_t dword3 = 0;

    if(shift <= 15)
    {
        dword0 = (destination.u16[0] >> shift) | (destination.u16[1] >> shift) << 16;
        dword1 = (destination.u16[2] >> shift) | (destination.u16[3] >> shift) << 16;
        dword2 = (destination.u16[4] >> shift) | (destination.u16[5] >> shift) << 16;
        dword3 = (destination.u16[6] >> shift) | (destination.u16[7] >> shift) << 16;
    }

    write_xmm128(r, dword0, dword1, dword2, dword3);
}

void psraw_r128(int32_t r, uint32_t shift)
{
    // psraw xmm, {shift}
    task_switch_test_mmx();
    union reg128 destination = read_xmm128s(r);
    int32_t shift_clamped = shift > 15 ? 16 : shift;

    int32_t dword0 = (destination.i16[0] >> shift_clamped) & 0xFFFF |
        (destination.i16[1] >> shift_clamped) << 16;
    int32_t dword1 = (destination.i16[2] >> shift_clamped) & 0xFFFF |
        (destination.i16[3] >> shift_clamped) << 16;
    int32_t dword2 = (destination.i16[4] >> shift_clamped) & 0xFFFF |
        (destination.i16[5] >> shift_clamped) << 16;
    int32_t dword3 = (destination.i16[6] >> shift_clamped) & 0xFFFF |
        (destination.i16[7] >> shift_clamped) << 16;
    write_xmm128(r, dword0, dword1, dword2, dword3);
}

void psllw_r128(int32_t r, uint32_t shift)
{
    // psllw xmm, {shift}
    task_switch_test_mmx();
    union reg128 destination = read_xmm128s(r);

    int32_t dword0 = 0;
    int32_t dword1 = 0;
    int32_t dword2 = 0;
    int32_t dword3 = 0;

    if(shift <= 15)
    {
        dword0 = (destination.u16[0] << shift & 0xFFFF) | (destination.u16[1] << shift) << 16;
        dword1 = (destination.u16[2] << shift & 0xFFFF) | (destination.u16[3] << shift) << 16;
        dword2 = (destination.u16[4] << shift & 0xFFFF) | (destination.u16[5] << shift) << 16;
        dword3 = (destination.u16[6] << shift & 0xFFFF) | (destination.u16[7] << shift) << 16;
    }

    write_xmm128(r, dword0, dword1, dword2, dword3);
}

void psrld_r128(int32_t r, uint32_t shift)
{
    // psrld xmm, {shift}
    task_switch_test_mmx();
    union reg128 destination = read_xmm128s(r);

    int32_t dword0 = 0;
    int32_t dword1 = 0;
    int32_t dword2 = 0;
    int32_t dword3 = 0;

    if(shift <= 31)
    {
        dword0 = destination.u32[0] >> shift;
        dword1 = destination.u32[1] >> shift;
        dword2 = destination.u32[2] >> shift;
        dword3 = destination.u32[3] >> shift;
    }

    write_xmm128(r, dword0, dword1, dword2, dword3);
}

void psrad_r128(int32_t r, uint32_t shift)
{
    // psrad xmm, {shift}
    task_switch_test_mmx();
    union reg128 destination = read_xmm128s(r);
    int32_t shift_clamped = shift > 31 ? 31 : shift;

    int32_t dword0 = destination.i32[0] >> shift_clamped;
    int32_t dword1 = destination.i32[1] >> shift_clamped;
    int32_t dword2 = destination.i32[2] >> shift_clamped;
    int32_t dword3 = destination.i32[3] >> shift_clamped;

    write_xmm128(r, dword0, dword1, dword2, dword3);
}

void pslld_r128(int32_t r, uint32_t shift)
{
    // pslld xmm, {shift}
    task_switch_test_mmx();
    union reg128 destination = read_xmm128s(r);

    int32_t dword0 = 0;
    int32_t dword1 = 0;
    int32_t dword2 = 0;
    int32_t dword3 = 0;

    if(shift <= 31)
    {
        dword0 = destination.i32[0] << shift;
        dword1 = destination.i32[1] << shift;
        dword2 = destination.i32[2] << shift;
        dword3 = destination.i32[3] << shift;
    }

    write_xmm128(r, dword0, dword1, dword2, dword3);
}

void psrlq_r128(int32_t r, uint32_t shift)
{
    // psrlq xmm, {shift}
    task_switch_test_mmx();

    if(shift == 0)
    {
        return;
    }

    union reg128 destination = read_xmm128s(r);
    union reg128 result = { { 0 } };

    if(shift <= 63)
    {
        result.u64[0] = destination.u64[0] >> shift;
        result.u64[1] = destination.u64[1] >> shift;
    }

    write_xmm_reg128(r, result);
}

void psllq_r128(int32_t r, uint32_t shift)
{
    // psllq xmm, {shift}
    task_switch_test_mmx();
    union reg128 destination = read_xmm128s(r);

    if(shift == 0)
    {
        return;
    }

    union reg128 result = { { 0 } };

    if(shift <= 63)
    {
        result.u64[0] = destination.u64[0] << shift;
        result.u64[1] = destination.u64[1] << shift;
    }

    write_xmm_reg128(r, result);
}
