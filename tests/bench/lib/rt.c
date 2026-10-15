// Freestanding C runtime: string primitives in the REP form used by the
// MSVC runtime of the era, so they exercise v86's string instruction paths.
#include "bench.h"

void *memcpy(void *dst, const void *src, size_t n)
{
    void *d = dst;
    size_t words = n >> 2;
    __asm__ volatile("rep movsl" : "+D"(d), "+S"(src), "+c"(words) : : "memory");
    n &= 3;
    __asm__ volatile("rep movsb" : "+D"(d), "+S"(src), "+c"(n) : : "memory");
    return dst;
}
void *memset(void *dst, int value, size_t n)
{
    void *d = dst;
    u32 fill = (u8)value * 0x01010101u;
    size_t words = n >> 2;
    __asm__ volatile("rep stosl" : "+D"(d), "+c"(words) : "a"(fill) : "memory");
    n &= 3;
    __asm__ volatile("rep stosb" : "+D"(d), "+c"(n) : "a"(fill) : "memory");
    return dst;
}
void *memmove(void *dst, const void *src, size_t n)
{
    if(dst <= src || (const u8 *)dst >= (const u8 *)src + n) return memcpy(dst, src, n);
    const u8 *s = (const u8 *)src + n - 1;
    u8 *d = (u8 *)dst + n - 1;
    __asm__ volatile("std; rep movsb; cld" : "+D"(d), "+S"(s), "+c"(n) : : "memory");
    return dst;
}
int memcmp(const void *a, const void *b, size_t n)
{
    const u8 *x = a, *y = b;
    for(size_t i = 0; i < n; i++)
        if(x[i] != y[i]) return x[i] - y[i];
    return 0;
}
