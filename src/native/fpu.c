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

