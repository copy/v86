// The AArch32 EL0 cases' driver (docs/aarch32-plan.md Q0.2, Q1): each case
// of an AArch32 binary (its table: the count, then per case its offset with
// bit 0 for T32, how many times to resume it, the NZCV it starts with) runs
// at EL0 until it takes an exception to EL1; what came back is printed (the
// vector, ESR, ELR and FAR as offsets into the binary, SPSR, R0-R14 as X0-X14),
// then the case resumes at ELR with R0 + 0x100, as many times as it says.
// The same output from QEMU (cortex-a35) and v86 is the test. The NZCV word's
// bit 8 runs the case with CPACR_EL1.FPEN from its bits 5:4.
#include <a64.h>
#include <stdio.h>

#ifndef CASES
#define CASES q1_a32
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
    const uint32_t *table = CASES;
    const uint64_t base = (uint64_t)CASES;
    const unsigned n = table[0];
    for(unsigned c = 0; c < n; c++)
    {
        const uint32_t offset = table[1 + 3 * c], resumes = table[2 + 3 * c], nzcv = table[3 + 3 * c];
        uint32_t regs[15];
        for(int i = 0; i < 13; i++) regs[i] = 0x01010101u * (i + 1) + c;
        regs[13] = (uint32_t)(uintptr_t)(stack + 1024);
        regs[14] = 0xE14E14E1u;
        uint64_t entry = base + (offset & ~1u);
        // AArch32 User, A I F masked, T for a T32 case
        uint64_t spsr = 0x10 | 0x1C0 | (offset & 1 ? 0x20 : 0) | (uint64_t)(nzcv & 15) << 28;
        // (EL1's printf uses FP registers: FPEN as the case says only around its run)
        const uint64_t cpacr = a64_read(cpacr_el1);
        for(unsigned r = 0;; r++)
        {
            last.vector = ~0ul;
            if(nzcv & 0x100) a64_write(cpacr_el1, (cpacr & ~(3ul << 20)) | (uint64_t)(nzcv >> 4 & 3) << 20);
            __asm__ volatile("isb");
            a32_run(entry, spsr, regs);
            a64_write(cpacr_el1, cpacr);
            __asm__ volatile("isb");
            const uint32_t ec = last.esr >> 26;
            printf("case %u.%u: vector %lu esr %08lx elr %+ld spsr %08lx", c, r, last.vector, last.esr, (long)(last.elr - base), last.spsr);
            if(ec >= 0x20 && ec <= 0x25) printf(" far %+ld", (long)(last.far - base));
            printf("\n ");
            for(int i = 0; i < 15; i++) printf(" %lx", i == 13 ? last.x[i] - (uint64_t)(uintptr_t)stack : last.x[i]);
            printf("\n");
            if(r == resumes || last.vector != 12) break;
            for(int i = 0; i < 15; i++) regs[i] = (uint32_t)last.x[i];
            regs[0] += 0x100;
            entry = last.elr;
            spsr = last.spsr;
        }
    }
    printf("done\n");
    return 0;
}
