#include <stdint.h>
#include <math.h>
#include <assert.h>
#include <stdbool.h>

#include <stdio.h>

#include "const.h"
#include "global_pointers.h"

void fpu_set_tag_word(int32_t tag_word)
{
    *fpu_stack_empty = 0;

    for(int i = 0; i < 8; i++)
    {
        *fpu_stack_empty |= (tag_word >> i) & (tag_word >> (i + 1)) & 1 << i;
    }
}

void fpu_fcomi(double_t y)
{
    double_t x = fpu_st[*fpu_stack_ptr];
    *flags_changed &= ~(1 | FLAG_PARITY | FLAG_ZERO);
    *flags &= ~(1 | FLAG_PARITY | FLAG_ZERO);

    if(x > y)
    {
    }
    else if(y > x)
    {
        *flags |= 1;
    }
    else if(x == y)
    {
        *flags |= FLAG_ZERO;
    }
    else
    {
        *flags |= 1 | FLAG_PARITY | FLAG_ZERO;
    }
}

int32_t fpu_load_status_word()
{
    return *fpu_status_word & ~(7 << 11) | *fpu_stack_ptr << 11;
}

void fpu_store_m80(uint32_t addr, double_t n)
{
    *fpu_float64 = n;

    uint8_t sign = fpu_float64_byte[7] & 0x80;
    int32_t exponent = (fpu_float64_byte[7] & 0x7f) << 4 | fpu_float64_byte[6] >> 4;
    int32_t low, high;

    if(exponent == 0x7FF)
    {
        // all bits set (NaN and infinity)
        exponent = 0x7FFF;
        low = 0;
        high = 0x80000000 | (fpu_float64_int[1] & 0x80000) << 11;
    }
    else if(exponent == 0)
    {
        // zero and denormal numbers
        // Just assume zero for now
        low = 0;
        high = 0;
    }
    else
    {
        exponent += 0x3FFF - 0x3FF;

        // does the mantissa need to be adjusted?
        low = fpu_float64_int[0] << 11;
        high = 0x80000000 | (fpu_float64_int[1] & 0xFFFFF) << 11 | (((uint32_t)(fpu_float64_int[0])) >> 21);
    }

    dbg_assert(exponent >= 0 && exponent < 0x8000);

    safe_write32(addr, low);
    safe_write32(addr + 4, high);

    safe_write16(addr + 8, sign << 8 | exponent);
}

