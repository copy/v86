// A hot loop of scalar multiply-adds, divisions and the rest of the FP fast
// path's forms (tests/a64/fma.mjs): FPSR.IXC set first, ordinary values; the
// sums' bits and FPSR at the end
#include <a64.h>
#include <stdio.h>
#include <stdint.h>

static double run_double(int rounds)
{
    // (bounded: every value stays between 0.25 and 2)
    double a = 1.0000001, b = 0.9999997, h = 0.5, s = 0.0;
    for(int i = 0; i < rounds; i++)
    {
        double t, u, v, w;
        __asm__ volatile("fmadd %d0, %d1, %d2, %d3" : "=w"(t) : "w"(s), "w"(h), "w"(a));
        __asm__ volatile("fmsub %d0, %d1, %d2, %d3" : "=w"(u) : "w"(t), "w"(h), "w"(a));
        __asm__ volatile("fnmadd %d0, %d1, %d2, %d3" : "=w"(v) : "w"(u), "w"(h), "w"(b));
        __asm__ volatile("fnmsub %d0, %d1, %d2, %d3" : "=w"(w) : "w"(v), "w"(h), "w"(b));
        s = w / 1.0001 + a * 0.5 - b * 0.25;
        a = a * 1.0000003;
    }
    return s;
}
static float run_single(int rounds)
{
    float a = 1.25f, b = 0.75f, s = 1.0f;
    for(int i = 0; i < rounds; i++)
    {
        float t;
        __asm__ volatile("fmadd %s0, %s1, %s2, %s3" : "=w"(t) : "w"(a), "w"(b), "w"(s));
        s = t / 1.001f - b * 0.125f;
    }
    return s;
}

int main(int argc, char **argv)
{
    __asm__ volatile("msr fpsr, %0" :: "r"(1UL << 4));
    double d = run_double(ROUNDS);
    float f = run_single(ROUNDS);
    uint64_t fpsr, dbits;
    uint32_t fbits;
    __asm__ volatile("mrs %0, fpsr" : "=r"(fpsr));
    __builtin_memcpy(&dbits, &d, 8);
    __builtin_memcpy(&fbits, &f, 4);
    printf("double %016lx single %08x fpsr %lx\n", (unsigned long)dbits, fbits, (unsigned long)fpsr);
    return 0;
}
