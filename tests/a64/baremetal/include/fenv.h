#ifndef A64_FENV_H
#define A64_FENV_H
// FPSR's cumulative flags and FPCR.RMode, with glibc's aarch64 values
#define FE_INVALID 1
#define FE_DIVBYZERO 2
#define FE_OVERFLOW 4
#define FE_UNDERFLOW 8
#define FE_INEXACT 16
#define FE_ALL_EXCEPT 31
#define FE_TONEAREST 0
#define FE_UPWARD 0x400000
#define FE_DOWNWARD 0x800000
#define FE_TOWARDZERO 0xc00000

static inline unsigned long a64_fpsr(void) { unsigned long v; __asm__ volatile("mrs %0, fpsr" : "=r"(v)); return v; }
static inline unsigned long a64_fpcr(void) { unsigned long v; __asm__ volatile("mrs %0, fpcr" : "=r"(v)); return v; }

static inline int feclearexcept(int excepts)
{
    __asm__ volatile("msr fpsr, %0" :: "r"(a64_fpsr() & ~(unsigned long)(excepts & FE_ALL_EXCEPT)));
    return 0;
}
static inline int fetestexcept(int excepts) { return a64_fpsr() & excepts & FE_ALL_EXCEPT; }
static inline int fegetround(void) { return a64_fpcr() & 0xc00000; }
static inline int fesetround(int round)
{
    if(round & ~0xc00000) return 1;
    __asm__ volatile("msr fpcr, %0" :: "r"((a64_fpcr() & ~0xc00000ul) | round));
    return 0;
}
#endif
