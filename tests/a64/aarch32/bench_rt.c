// The string primitives of tests/a64/aarch32_bench.mjs's builds, as the
// bare-metal runtime has them (tests/a64/baremetal/libc.c: byte loops),
// so that A64 and the 32-bit builds run the same code; memmove both lack.
typedef __SIZE_TYPE__ size_t;
#ifdef BENCH32
void *memcpy(void *to, const void *from, size_t n)
{
    char *t = to;
    const char *f = from;
    while(n--) *t++ = *f++;
    return to;
}
void *memset(void *to, int c, size_t n)
{
    char *t = to;
    while(n--) *t++ = c;
    return to;
}
int memcmp(const void *a, const void *b, size_t n)
{
    const unsigned char *x = a, *y = b;
    for(; n; n--, x++, y++) if(*x != *y) return *x - *y;
    return 0;
}
#endif
void *memmove(void *to, const void *from, size_t n)
{
    char *t = to;
    const char *f = from;
    if(t <= f || t >= f + n)
    {
        while(n--) *t++ = *f++;
    }
    else
    {
        t += n;
        f += n;
        while(n--) *--t = *--f;
    }
    return to;
}
