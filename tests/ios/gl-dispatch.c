// The functions declared here are the owner's 10B329 OpenGLES entry points.
// The test supplies the driver-side table and checks its additional argument.
#include <stdint.h>
#include <stdio.h>

extern void glClear(unsigned);
extern void glDrawArrays(unsigned, int, int);
extern void glDrawElements(unsigned, int, unsigned, const void *);
extern unsigned glGetError(void);
extern void glViewport(int, int, int, int);

static uintptr_t tls[32], table[0x554 / 4];
static unsigned calls;
static char context, indices;

static void clear(void *ctx, unsigned mask)
{
    if(ctx == &context && mask == 0x4100) calls |= 1;
}
static void arrays(void *ctx, unsigned mode, int first, int count)
{
    if(ctx == &context && mode == 4 && first == 2 && count == 3) calls |= 2;
}
static void elements(void *ctx, unsigned mode, int count, unsigned type, const void *p)
{
    if(ctx == &context && mode == 4 && count == 6 && type == 0x1403 && p == &indices) calls |= 4;
}
static unsigned error(void *ctx)
{
    return ctx == &context ? 0x0502 : 0;
}
static void viewport(void *ctx, int x, int y, int width, int height)
{
    if(ctx == &context && x == 5 && y == 6 && width == 640 && height == 960) calls |= 8;
}

int main(void)
{
    uintptr_t thread = (uintptr_t)tls | 1;
    __asm__ volatile("mcr p15, 0, %0, c13, c0, 3\n\tisb" :: "r"(thread) : "memory");
    if(glGetError() != 0) return 1;
    tls[0x78 / 4] = (uintptr_t)table;
    table[0x10 / 4] = (uintptr_t)&context;
    table[0x3c / 4] = (uintptr_t)clear;
    table[0x118 / 4] = (uintptr_t)arrays;
    table[0x120 / 4] = (uintptr_t)elements;
    table[0x1ac / 4] = (uintptr_t)error;
    table[0x550 / 4] = (uintptr_t)viewport;
    glClear(0x4100);
    glDrawArrays(4, 2, 3);
    glDrawElements(4, 6, 0x1403, &indices);
    glViewport(5, 6, 640, 960);
    if(calls != 15 || glGetError() != 0x0502) return 1;
    puts("N90 OpenGLES dispatch passed");
    return 0;
}
