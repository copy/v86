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

    if (shift <= 31)
    {
        result.u32[0] = destination.u32[0] >> shift | destination.u32[1] << (32 - shift);
        result.u32[1] = destination.u32[1] >> shift;

        result.u32[2] = destination.u32[2] >> shift | destination.u32[3] << (32 - shift);
        result.u32[3] = destination.u32[3] >> shift;
    }
    else if (shift <= 63)
    {
        result.u32[0] = destination.u32[1] >> shift;
        result.u32[2] = destination.u32[3] >> shift;
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

    if(shift <= 31) {
        result.u32[0] = destination.u32[0] << shift;
        result.u32[1] = destination.u32[1] << shift | (((uint32_t) destination.u32[0]) >> (32 - shift));
        result.u32[2] = destination.u32[2] << shift;
        result.u32[3] = destination.u32[3] << shift | (((uint32_t) destination.u32[2]) >> (32 - shift));
    }
    else if(shift <= 63) {
        result.u32[0] = 0;
        result.u32[1] = destination.u32[0] << (shift & 0x1F);
        result.u32[2] = 0;
        result.u32[3] = destination.u32[2] << (shift & 0x1F);
    }

    write_xmm_reg128(r, result);
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

    if(shift <= 31) {
        dword0 = destination.i32[0] << shift;
        dword1 = destination.i32[1] << shift;
        dword2 = destination.i32[2] << shift;
        dword3 = destination.i32[3] << shift;
    }

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

    if(shift <= 15) {
        int32_t word0 = ((uint32_t) destination.u16[0]) << shift & 0xFFFF;
        int32_t word1 = ((uint32_t) destination.u16[1]) << shift & 0xFFFF;
        dword0 = word0 | word1 << 16;

        int32_t word2 = ((uint32_t) destination.u16[2]) << shift & 0xFFFF;
        int32_t word3 = ((uint32_t) destination.u16[3]) << shift & 0xFFFF;
        dword1 = word2 | word3 << 16;

        int32_t word4 = ((uint32_t) destination.u16[4]) << shift & 0xFFFF;
        int32_t word5 = ((uint32_t) destination.u16[5]) << shift & 0xFFFF;
        dword2 = word4 | word5 << 16;

        int32_t word6 = ((uint32_t) destination.u16[6]) << shift & 0xFFFF;
        int32_t word7 = ((uint32_t) destination.u16[7]) << shift & 0xFFFF;
        dword3 = word6 | word7 << 16;
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

void psrlw_r128(int32_t r, uint32_t shift)
{
    // psrlw xmm, {shift}
    task_switch_test_mmx();
    union reg128 destination = read_xmm128s(r);

    int32_t dword0 = 0;
    int32_t dword1 = 0;
    int32_t dword2 = 0;
    int32_t dword3 = 0;

    if(shift <= 15) {
        int32_t word0 = ((uint32_t) destination.u16[0]) >> shift;
        int32_t word1 = ((uint32_t) destination.u16[1]) >> shift;
        dword0 = word0 | word1 << 16;

        int32_t word2 = ((uint32_t) destination.u16[2]) >> shift;
        int32_t word3 = ((uint32_t) destination.u16[3]) >> shift;
        dword1 = word2 | word3 << 16;

        int32_t word4 = ((uint32_t) destination.u16[4]) >> shift;
        int32_t word5 = ((uint32_t) destination.u16[5]) >> shift;
        dword2 = word4 | word5 << 16;

        int32_t word6 = ((uint32_t) destination.u16[6]) >> shift;
        int32_t word7 = ((uint32_t) destination.u16[7]) >> shift;
        dword3 = word6 | word7 << 16;
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

    if(shift <= 31) {
        dword0 = (uint32_t) destination.u32[0] >> shift;
        dword1 = (uint32_t) destination.u32[1] >> shift;
        dword2 = (uint32_t) destination.u32[2] >> shift;
        dword3 = (uint32_t) destination.u32[3] >> shift;
    }

    write_xmm128(r, dword0, dword1, dword2, dword3);
}
