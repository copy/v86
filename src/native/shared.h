#pragma once

#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>

#define UNUSED(x) (void)(x)

static inline size_t strlen(const char *str)
{
    const char *s;

    for (s = str; *s; ++s) {}

    return (s - str);
}

void *memset(void *dest, int c, size_t n);
