// The bare-metal guests' C runtime: output into the result block's text,
// the startup and finish of a run (include/a64.h); printf with glibc's
// formatting and a bump allocator are libc.c's.

#include <a64.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static volatile unsigned text_length;
void (*volatile a64_core_main)(unsigned core);

static void finish(uint32_t status)
{
    a64_result->length = text_length;
    a64_result->status = status;
    __asm__ volatile("dsb sy" ::: "memory");
    a64_result->magic = A64_DONE;
    __asm__ volatile("dsb sy" ::: "memory");
    for(;;) __asm__ volatile("wfi");
}

void a64_putc(char c)
{
    if(text_length >= A64_TEXT_SIZE) finish(A64_TEXT_OVERFLOW);
    ((volatile char *)A64_TEXT)[text_length++] = c;
}

void a64_fail(const char *why)
{
    printf("A64_FAIL %s\n", why);
    finish(A64_FAILED);
}

#ifdef A64_MMU
// (A64_MMU=1, tests/a64/guest_runner.mjs: the MMU on from the start, an
// identity map of 1 GiB blocks, devices below RAM and normal write-back
// RAM, so that the A64 page tier, which needs it, runs the guest's code)
static uint64_t identity[512] __attribute__((aligned(4096)));
static void mmu_on(void)
{
    if(!identity[1])
    {
        identity[0] = 0x00000000UL | 1 | 1 << 2 | 1 << 10;
        identity[1] = 0x40000000UL | 1 | 0 << 2 | 3 << 8 | 1 << 10;
        identity[2] = 0x80000000UL | 1 | 0 << 2 | 3 << 8 | 1 << 10;
        __asm__ volatile("dsb ish" ::: "memory");
    }
    a64_write(mair_el1, 0x00FF);
    a64_write(tcr_el1, 25 | 1 << 8 | 1 << 10 | 3 << 12 | 1 << 23 | 2UL << 32);
    a64_write(ttbr0_el1, (uint64_t)identity);
    __asm__ volatile("dsb ish\n tlbi vmalle1\n dsb ish\n isb" ::: "memory");
    a64_write(sctlr_el1, a64_read(sctlr_el1) | 1 | 1 << 2 | 1 << 12);
    __asm__ volatile("isb" ::: "memory");
}
#endif

void a64_start(uint64_t dtb)
{
#ifdef A64_MMU
    mmu_on();
#endif
    a64_result->magic = 0;
    a64_result->status = 0;
    a64_result->length = 0;
    a64_result->cores = 1;
    a64_result->dtb = dtb;
    char *argv[] = { "a64", 0 };
    int status = main(1, argv);
    finish(status ? A64_FAILED : A64_OK);
}

void a64_secondary_start(unsigned core)
{
#ifdef A64_MMU
    mmu_on();
#endif
    __atomic_fetch_add((uint32_t *)&a64_result->cores, 1, __ATOMIC_SEQ_CST);
    if(a64_core_main) a64_core_main(core);
}

void exit(int status) { finish(status ? A64_FAILED : A64_OK); }
void abort(void) { a64_fail("abort"); for(;;); }

// (unexpected exceptions, called from a64_exception in exception.c)
void a64_unexpected(struct a64_frame *frame, uint64_t vector)
{
    a64_result->vector = vector;
    a64_result->esr = a64_read(esr_el1);
    a64_result->far = a64_read(far_el1);
    a64_result->elr = frame->elr;
    a64_result->spsr = frame->spsr;
    printf("A64_EXCEPTION vector=%lu esr=%#lx elr=%#lx far=%#lx\n", (unsigned long)vector,
        (unsigned long)a64_result->esr, (unsigned long)frame->elr, (unsigned long)a64_result->far);
    finish(A64_UNEXPECTED_EXCEPTION);
}

int64_t a64_hvc(uint64_t function, uint64_t a1, uint64_t a2, uint64_t a3)
{
    register uint64_t x0 __asm__("x0") = function, x1 __asm__("x1") = a1, x2 __asm__("x2") = a2, x3 __asm__("x3") = a3;
    __asm__ volatile("hvc #0" : "+r"(x0), "+r"(x1), "+r"(x2), "+r"(x3) :: "memory");
    return x0;
}

int64_t a64_hvc_imm1(uint64_t function)
{
    register uint64_t x0 __asm__("x0") = function;
    __asm__ volatile("hvc #1" : "+r"(x0) :: "x1", "x2", "x3", "memory");
    return x0;
}

extern char a64_secondary[];
int64_t a64_cpu_on(unsigned core)
{
    return a64_hvc(0xC4000003, core, (uint64_t)a64_secondary, core); // PSCI CPU_ON (SMC64)
}

#ifndef A64_GENERAL_REGS_ONLY
// -------- math (the instructions themselves)

float fmaf(float a, float b, float c)
{
    float r;
    __asm__ volatile("fmadd %s0, %s1, %s2, %s3" : "=w"(r) : "w"(a), "w"(b), "w"(c));
    return r;
}

double fma(double a, double b, double c)
{
    double r;
    __asm__ volatile("fmadd %d0, %d1, %d2, %d3" : "=w"(r) : "w"(a), "w"(b), "w"(c));
    return r;
}
#endif
