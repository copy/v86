// The EL1 driver of tests/a64/aarch32_bench.mjs (docs/aarch32-plan.md
// Q6.4): one kernel of tests/bench (bench_main(iterations)), built for A64
// and run here at EL1, or built for A32 or T32 (BENCH32: its flat binary,
// linked at EL0's alias of BENCH32_PHYSICAL, el0_map.h) and run at EL0;
// the checksum and the counter's ticks it took are printed.
#include <a64.h>
#include <stdio.h>
#include <string.h>
#include "el0_map.h"

#ifdef BENCH32
extern const unsigned char bench32[], bench32_end[];
void a32_run(uint64_t entry, uint64_t spsr, const uint32_t regs[15]);
extern char a32_resume_el1[];
static volatile uint64_t result, esr;
static void lower(struct a64_frame *frame, uint64_t vector)
{
    result = frame->x[0];
    esr = a64_read(esr_el1);
    frame->elr = (uint64_t)a32_resume_el1;
    frame->spsr = 0x3C5;
}
#else
unsigned bench_main(unsigned iterations);
#endif

int main(int argc, char **argv)
{
    uint64_t start, end, value;
#ifdef BENCH32
    a64_lower_handler = lower;
    el0_map();
    // the program where it was linked (its BSS zeroed), entered at its start
    unsigned char *at = (unsigned char *)BENCH32_PHYSICAL;
    memcpy(at, bench32, bench32_end - bench32);
    memset(at + (BENCH32_BSS_START - BENCH32_BASE), 0, BENCH32_BSS_END - BENCH32_BSS_START);
    __asm__ volatile("dsb ish\n ic iallu\n dsb ish\n isb" ::: "memory");
    uint32_t regs[15] = { ITERATIONS };
    start = a64_read(cntvct_el0);
    a32_run(BENCH32_ENTRY, 0x10 | 0x1C0 | (BENCH32_THUMB ? 0x20 : 0), regs);
    end = a64_read(cntvct_el0);
    value = result;
    if(esr >> 26 != 0x11) printf("bench: an exception: esr %08lx\n", (unsigned long)esr);
#else
    start = a64_read(cntvct_el0);
    value = bench_main(ITERATIONS);
    end = a64_read(cntvct_el0);
#endif
    printf("bench %s checksum %08lx ticks %lu frequency %lu\n", NAME, (unsigned long)(uint32_t)value, (unsigned long)(end - start),
        (unsigned long)a64_read(cntfrq_el0));
    return 0;
}
