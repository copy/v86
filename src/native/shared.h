#pragma once

#include <stdio.h>

#define UNUSED(x) (void)(x)

static inline size_t strlen(const char *str)
{
    const char *s;

    for (s = str; *s; ++s) {}

    return (s - str);
}
