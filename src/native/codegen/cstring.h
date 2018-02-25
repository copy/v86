#pragma once

// everything here is copied from musl

#include <stddef.h>
#include <stdint.h>

// from strncmp.c

static int strncmp(const char *_l, const char *_r, size_t n)
{
    const unsigned char *l=(void *)_l, *r=(void *)_r;
    if (!n--) return 0;
    for (; *l && *r && n && *l == *r ; l++, r++, n--);
    return *l - *r;
}
