// The AArch32 EL0 debug cases' driver (docs/aarch32-plan.md Q1.5,
// tests/a64/aarch32_el0.mjs with A64_AARCH32_DRIVER=debug): each case of an
// AArch32 binary (its table: the count, then per case its offset with bit 0
// for T32, how many times to resume it, a control word, a breakpoint's
// offset) runs at EL0 with the debug registers the control word asks for;
// every exception that comes back is printed (vector, ESR, ELR and FAR as
// offsets, SPSR, R0-R14) and the case resumes at ELR, as many times as it
// says. The control word: bits 3:0 the NZCV it starts with; bit 4 software
// step (MDSCR_EL1.SS, SPSR.SS set on each entry); bit 5 breakpoint 0 at the
// breakpoint's offset, BAS 1111, or with bits 7:6 1 0011, 2 1100; bit 8
// watchpoint 0 on the first 8 bytes of the data buffer (R1 points at it),
// bits 10:9 LSC. A breakpoint or watchpoint is disabled once it fired.
// The same output from QEMU (cortex-a35) and v86 is the test.
#include <a64.h>
#include <stdio.h>

#ifndef CASES
#define CASES qdebug_a32
#endif
extern const uint32_t CASES[];

struct exit_state
{
    uint64_t x[15], esr, far, elr, spsr, vector;
};
static volatile struct exit_state last;
extern char a32_resume_el1[];
void a32_run(uint64_t entry, uint64_t spsr, const uint32_t regs[15]);
static uint32_t stack[1024] __attribute__((aligned(16)));
static uint8_t data[64] __attribute__((aligned(16)));

static void lower(struct a64_frame *frame, uint64_t vector)
{
    for(int i = 0; i < 15; i++) last.x[i] = frame->x[i];
    last.esr = a64_read(esr_el1);
    last.far = a64_read(far_el1);
    last.elr = frame->elr;
    last.spsr = frame->spsr;
    last.vector = vector;
    frame->elr = (uint64_t)a32_resume_el1;
    frame->spsr = 0x3C5;
}

int main(int argc, char **argv)
{
    a64_lower_handler = lower;
    // (the OS Lock off: debug exceptions on)
    a64_write(oslar_el1, 0);
    __asm__ volatile("isb");
    const uint32_t *table = CASES;
    const uint64_t base = (uint64_t)CASES;
    const unsigned n = table[0];
    for(unsigned c = 0; c < n; c++)
    {
        const uint32_t *t = table + 1 + 4 * c;
        const uint32_t offset = t[0], resumes = t[1], control = t[2], breakpoint = t[3];
        uint32_t regs[15];
        for(int i = 0; i < 13; i++) regs[i] = 0x01010101u * (i + 1) + c;
        regs[1] = (uint32_t)(uintptr_t)data;
        regs[13] = (uint32_t)(uintptr_t)(stack + 1024);
        regs[14] = 0xE14E14E1u;
        for(int i = 0; i < 64; i++) data[i] = (uint8_t)(i * 7 + c);
        uint64_t entry = base + (offset & ~1u);
        const uint64_t ss = control & 0x10 ? 1ul << 21 : 0;
        uint64_t spsr = 0x10 | 0x1C0 | (offset & 1 ? 0x20 : 0) | (uint64_t)(control & 15) << 28;
        a64_write(mdscr_el1, 1ul << 15 | (control & 0x10 ? 1 : 0));
        if(control & 0x20)
        {
            const uint64_t bas = (uint64_t[]){ 15, 3, 12, 15 }[control >> 6 & 3];
            a64_write(dbgbvr0_el1, (base + breakpoint) & ~3ul);
            a64_write(dbgbcr0_el1, 1 | 2 << 1 | bas << 5);
        }
        if(control & 0x100)
        {
            a64_write(dbgwvr0_el1, (uint64_t)(uintptr_t)data);
            a64_write(dbgwcr0_el1, 1 | 2 << 1 | (uint64_t)(control >> 9 & 3) << 3 | 0xFF << 5);
        }
        __asm__ volatile("isb");
        for(unsigned r = 0;; r++)
        {
            last.vector = ~0ul;
            a32_run(entry, spsr | ss, regs);
            const uint32_t ec = last.esr >> 26;
            printf("case %u.%u: vector %lu esr %08lx elr %+ld spsr %08lx", c, r, last.vector, last.esr, (long)(last.elr - base), last.spsr);
            if(ec >= 0x20 && ec <= 0x25) printf(" far %+ld", (long)(last.far - base));
            if(ec == 0x34 || ec == 0x35) printf(" far data%+ld", (long)(last.far - (uint64_t)(uintptr_t)data));
            printf("\n ");
            for(int i = 0; i < 15; i++)
            {
                const uint64_t v = last.x[i];
                if(i == 13) printf(" sp%+ld", (long)(v - (uint64_t)(uintptr_t)(stack + 1024)));
                else if(v - (uint64_t)(uintptr_t)data < 64) printf(" data%+ld", (long)(v - (uint64_t)(uintptr_t)data));
                else printf(" %lx", v);
            }
            printf("\n");
            if(r == resumes || last.vector != 12) break;
            // (a breakpoint or watchpoint that fired: off, so that the case goes on)
            if(ec == 0x30) a64_write(dbgbcr0_el1, 0);
            if(ec == 0x34) a64_write(dbgwcr0_el1, 0);
            __asm__ volatile("isb");
            for(int i = 0; i < 15; i++) regs[i] = (uint32_t)last.x[i];
            entry = last.elr;
            spsr = last.spsr;
        }
        a64_write(mdscr_el1, 0);
        a64_write(dbgbcr0_el1, 0);
        a64_write(dbgwcr0_el1, 0);
        __asm__ volatile("isb");
    }
    printf("done\n");
    return 0;
}
