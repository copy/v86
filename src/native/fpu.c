#include <stdint.h>
#include <math.h>
#include <assert.h>
#include <stdbool.h>

#include <stdio.h>

#include "const.h"
#include "global_pointers.h"

void safe_tag_word(int32_t tag_word) {
    *stack_empty = 0;

    for(int i = 0; i < 8; i++)
    {
        *stack_empty |= (tag_word >> i) & (tag_word >> (i + 1)) & 1 << i;
    }

    //dbg_log("safe  tw=" + h(tag_word) + " se=" + h(this.stack_empty[0]), LOG_FPU);
}
