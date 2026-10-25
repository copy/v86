// The EL1 driver of tests/a64/aarch32_page_fuzz.mjs (docs/aarch32-plan.md
// Q6.2): the generated AArch32 program (fuzz.a32.S: its entry at offset 0,
// bit 0 of the first word saying T32) runs at EL0 on a buffer whose address
// it gets in R8, ROUNDS times over, and ends with an SVC; the buffer (its
// registers and NZCV in the last words) and the registers are printed.
#include <a64.h>
#include <stdio.h>
#include "el0_map.h"

extern const uint32_t fuzz_a32[];
void a32_run(uint64_t entry, uint64_t spsr, const uint32_t regs[15]);

struct exit_state
{
    uint64_t x[15], esr, elr, spsr;
};
static volatile struct exit_state last;
extern char a32_resume_el1[];
static uint32_t stack[2048] __attribute__((aligned(16)));
static uint32_t buffer[1024] __attribute__((aligned(64)));

static void lower(struct a64_frame *frame, uint64_t vector)
{
    for(int i = 0; i < 15; i++) last.x[i] = frame->x[i];
    last.esr = a64_read(esr_el1);
    last.elr = frame->elr;
    last.spsr = frame->spsr;
    frame->elr = (uint64_t)a32_resume_el1;
    frame->spsr = 0x3C5;
}

int main(int argc, char **argv)
{
    a64_lower_handler = lower;
    el0_map();
    uint64_t s = SEED;
    for(unsigned i = 0; i < 1024; i++)
    {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        buffer[i] = (uint32_t)s;
    }
    const uint32_t header = fuzz_a32[0];
    uint32_t regs[15];
    for(int i = 0; i < 15; i++) regs[i] = 0;
    regs[8] = (uint32_t)el0_address(buffer);
    regs[13] = (uint32_t)el0_address(stack + 2048);
    // AArch32 User, A I F masked, T for a T32 program; its code after the header word
    const uint64_t base = el0_address(fuzz_a32), entry = base + 4;
    const uint64_t spsr = 0x10 | 0x1C0 | (header & 1 ? 0x20 : 0);
    a32_run(entry, spsr, regs);
    printf("exit esr %08lx elr %lx\n", last.esr, (unsigned long)(last.elr - base));
    for(unsigned i = 0; i < 1024; i++) printf("%08x%c", buffer[i], i % 8 == 7 ? '\n' : ' ');
    for(int i = 0; i < 15; i++) printf(" %lx", i == 13 ? last.x[i] - el0_address(stack) : last.x[i]);
    printf("\n");
    return 0;
}
