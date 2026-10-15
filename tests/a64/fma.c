// A hot loop of scalar multiply-adds, divisions and the rest of the FP fast
// path's forms, and one of vector FMLA and FMLS (tests/a64/fma.mjs): FPSR.IXC
// set first, ordinary values; the results' bits and FPSR at the end
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

// FMLA and FMLS on 4S, 2S and 2D vectors (bounded: acc -> 1.2 c)
typedef float f32x4 __attribute__((vector_size(16)));
typedef float f32x2 __attribute__((vector_size(8)));
typedef double f64x2 __attribute__((vector_size(16)));
static f32x4 acc4;
static f32x2 acc2;
static f64x2 accd;
static void run_vector(int rounds)
{
    f32x4 c4 = { 1.1f, 2.2f, 3.3f, 1.7f }, h4 = { 0.5f, 0.5f, 0.5f, 0.5f }, q4 = { 0.25f, 0.25f, 0.25f, 0.25f };
    f32x2 c2 = { 1.9f, 0.7f }, h2 = { 0.5f, 0.5f }, q2 = { 0.25f, 0.25f };
    f64x2 cd = { 1.3, 2.9 }, hd = { 0.5, 0.5 }, qd = { 0.25, 0.25 };
    f32x4 a4 = c4;
    f32x2 a2 = c2;
    f64x2 ad = cd;
    for(int i = 0; i < rounds; i++)
    {
        f32x4 t4 = c4, u4;
        __asm__ volatile("fmla %0.4s, %1.4s, %2.4s" : "+w"(t4) : "w"(a4), "w"(h4));
        u4 = t4;
        __asm__ volatile("fmls %0.4s, %1.4s, %2.4s" : "+w"(u4) : "w"(t4), "w"(q4));
        a4 = u4;
        f32x2 t2 = c2, u2;
        __asm__ volatile("fmla %0.2s, %1.2s, %2.2s" : "+w"(t2) : "w"(a2), "w"(h2));
        u2 = t2;
        __asm__ volatile("fmls %0.2s, %1.2s, %2.2s" : "+w"(u2) : "w"(t2), "w"(q2));
        a2 = u2;
        f64x2 td = cd, ud;
        __asm__ volatile("fmla %0.2d, %1.2d, %2.2d" : "+w"(td) : "w"(ad), "w"(hd));
        ud = td;
        __asm__ volatile("fmls %0.2d, %1.2d, %2.2d" : "+w"(ud) : "w"(td), "w"(qd));
        ad = ud;
    }
    acc4 = a4;
    acc2 = a2;
    accd = ad;
}

int main(int argc, char **argv)
{
    __asm__ volatile("msr fpsr, %0" :: "r"(1UL << 4));
    double d = run_double(ROUNDS);
    float f = run_single(ROUNDS);
    run_vector(ROUNDS);
    uint64_t fpsr, dbits;
    uint32_t fbits;
    __asm__ volatile("mrs %0, fpsr" : "=r"(fpsr));
    __builtin_memcpy(&dbits, &d, 8);
    __builtin_memcpy(&fbits, &f, 4);
    uint32_t v4[4], v2[2];
    uint64_t vd[2];
    __builtin_memcpy(v4, &acc4, 16);
    __builtin_memcpy(v2, &acc2, 8);
    __builtin_memcpy(vd, &accd, 16);
    printf("double %016lx single %08x fpsr %lx\n", (unsigned long)dbits, fbits, (unsigned long)fpsr);
    printf("4s %08x %08x %08x %08x 2s %08x %08x 2d %016lx %016lx\n", v4[0], v4[1], v4[2], v4[3], v2[0], v2[1],
        (unsigned long)vd[0], (unsigned long)vd[1]);
    return 0;
}
