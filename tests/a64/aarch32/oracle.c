// The AArch32 single-instruction oracle's driver (docs/aarch32-plan.md Q0.3,
// tests/a64/aarch32_oracle.mjs): each case of the generated binary is one
// instruction followed by SVC #0, run at EL0 with registers from its seed
// (those of its pointer mask at the data buffer, of its small mask small),
// its NZCV, Q and GE; what comes back is printed: the registers, NZCV Q GE
// (SPSR), the exception if it was not the SVC, and a hash of the data
// buffer, which is set again before each case. The same output from QEMU
// (cortex-a35) and v86 is the test.
// A case with bit 0 of its PSR word is a floating-point one: D0-D31 from the
// seed too (special values among them), FPSCR's AHP, DN, FZ and RMode from
// the PSR word's bits 26:22; printed after: FPSCR and the D registers that
// changed. A register of the small mask's bits 30:16 has FPSCR's Len and
// Stride clear (a value for VMSR).
#include <a64.h>
#include <stdio.h>

extern const uint32_t oracle_a32[];

struct exit_state
{
    uint64_t x[15], esr, far, elr, spsr, vector;
};
static volatile struct exit_state last;
extern char a32_resume_el1[];
void a32_run(uint64_t entry, uint64_t spsr, const uint32_t regs[15]);
struct fp_state
{
    uint64_t d[32], fpsr, fpcr;
};
void a32_run_fp(uint64_t entry, uint64_t spsr, const uint32_t regs[15], struct fp_state *fp);
static struct fp_state fp_state __attribute__((aligned(16)));
static uint8_t buffer[8192] __attribute__((aligned(4096)));
static uint32_t stack[256] __attribute__((aligned(16)));

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

static uint32_t next(uint32_t *state)
{
    // xorshift32
    uint32_t x = *state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    return *state = x;
}

// Special singles and doubles: zeros, ones, infinities, NaNs (quiet and
// signaling, both signs), denormals, the normal range's ends, the integer
// conversions' limits, half precision's
static const uint32_t singles[] = {
    0x00000000, 0x80000000, 0x3f800000, 0xbf800000, 0x7f800000, 0xff800000, 0x7fc00000, 0xffc12345,
    0x7f800001, 0xff8abcde, 0x00000001, 0x807fffff, 0x00800000, 0x7f7fffff, 0x3f000000, 0x4f000000,
    0x4effffff, 0xcf000000, 0x4f800000, 0x477fe000, 0x477ff000, 0x33800000, 0x387fc000, 0x3fc00000,
    0x40200000, 0xbfc00000, 0x3effffff, 0x46fffe00, 0xc7000100, 0x5f000000, 0x40490fdb, 0x34000000,
};
static const uint64_t doubles[] = {
    0x0000000000000000, 0x8000000000000000, 0x3ff0000000000000, 0xbff0000000000000,
    0x7ff0000000000000, 0xfff0000000000000, 0x7ff8000000000000, 0xfff8123456789abc,
    0x7ff0000000000001, 0xfff4000000000000, 0x0000000000000001, 0x800fffffffffffff,
    0x0010000000000000, 0x7fefffffffffffff, 0x3fe0000000000000, 0x41e0000000000000,
    0x41dfffffffc00000, 0xc1e0000000000000, 0x41efffffffe00000, 0x47efffffe0000000,
    0x47efffffffffffff, 0x36a0000000000000, 0x380fffffe0000000, 0x3810000000000000,
    0x40effc0000000000, 0x3ff8000000000000, 0xc004000000000000, 0x400921fb54442d18,
    0x3e70000000000000, 0x43e0000000000000, 0x4330000000000001, 0x3fdfffffffffffff,
};

static uint32_t random_single(uint32_t *seed)
{
    uint32_t r = next(seed);
    if(r & 1) return singles[r >> 1 & 31];
    // (near one: an exponent 127 +- 15)
    return (r & 0x80000000) | (112 + (r >> 6) % 31) << 23 | (next(seed) & 0x7fffff);
}

static uint64_t random_fp(uint32_t *seed)
{
    uint32_t r = next(seed);
    switch(r % 6)
    {
        case 0:
        case 1:
            return (uint64_t)random_single(seed) << 32 | random_single(seed);
        case 2:
            return doubles[r >> 8 & 31];
        case 3:
        case 4:
            return (uint64_t)(r & 0x80000000) << 32 | (uint64_t)(1008 + (r >> 8) % 31) << 52 |
                (uint64_t)(next(seed) & 0xfffff) << 32 | next(seed);
        default:
            return (uint64_t)next(seed) << 32 | next(seed);
    }
}

int main(int argc, char **argv)
{
    a64_lower_handler = lower;
    // (the thread ID registers the CP15 cases read)
    a64_write(tpidr_el0, 0x1234567890abcdefUL);
    a64_write(tpidrro_el0, 0xfedcba0987654321UL);
    const uint32_t *table = oracle_a32;
    const uint64_t base = (uint64_t)oracle_a32;
    const unsigned n = table[0];
    for(unsigned c = 0; c < n; c++)
    {
        const uint32_t *t = table + 1 + 6 * c;
        const uint32_t offset = t[0], psr = t[1], pointers = t[2], small = t[3], pointer_offset = t[5];
        uint32_t seed = t[4] | 1;
        for(int i = 0; i < 8192; i++) buffer[i] = (uint8_t)(i * 131 + 7);
        uint32_t regs[15];
        for(int i = 0; i < 15; i++)
        {
            uint32_t v = next(&seed);
            if(pointers >> i & 1) v = (uint32_t)(uintptr_t)buffer + 4096 + (pointer_offset & 0xFF) + ((v & 7) << 2) * ((pointer_offset >> 8) & 1);
            else if(small >> i & 1) v &= 0x3C;
            if(small >> (16 + i) & 1) v &= ~0x3F0000u;
            regs[i] = v;
        }
        // (a stack for the cases that use R13 as a pointer: the buffer's)
        if(!(pointers >> 13 & 1) && !(small >> 13 & 1)) regs[13] = (uint32_t)(uintptr_t)(stack + 256);
        a64_write(tpidr_el0, 0x1234567890abcdefUL);
        uint64_t entry = base + (offset & ~1u);
        uint64_t spsr = 0x10 | 0x1C0 | (offset & 1 ? 0x20 : 0) | (psr & 0xF80F0000u);
        last.vector = ~0ul;
        uint64_t initial[32];
        if(psr & 1)
        {
            for(int i = 0; i < 32; i++) initial[i] = fp_state.d[i] = random_fp(&seed);
            fp_state.fpsr = 0;
            fp_state.fpcr = psr & 0x07C00000u;
            a32_run_fp(entry, spsr, regs, &fp_state);
        }
        else a32_run(entry, spsr, regs);
        uint32_t hash = 2166136261u;
        for(int i = 0; i < 8192; i++) hash = (hash ^ buffer[i]) * 16777619u;
        const uint32_t ec = last.esr >> 26;
        printf("%u", c);
        if(last.vector != 12 || last.esr != (offset & 1 ? 0x44000000ul : 0x46000000ul))
        {
            printf(" exception %lu esr %08lx elr %+ld", last.vector, last.esr, (long)(last.elr - base));
            if(ec >= 0x20 && ec <= 0x25) printf(" far %08lx", last.far & 0xFFF);
        }
        else if(last.elr - base != (offset & ~1u) + (t[5] >> 16))
        {
            printf(" elr %+ld", (long)(last.elr - base));
        }
        printf(" psr %08lx", last.spsr & 0xF80F0000u);
        for(int i = 0; i < 15; i++)
        {
            uint64_t v = last.x[i];
            if((uint32_t)v - (uint32_t)(uintptr_t)buffer < 8192u) printf(" b+%lx", v - (uint64_t)(uintptr_t)buffer);
            else printf(" %lx", v);
        }
        printf(" mem %08x", hash);
        if(psr & 1)
        {
            printf(" fpscr %08lx", fp_state.fpsr | fp_state.fpcr);
            for(int i = 0; i < 32; i++)
            {
                if(fp_state.d[i] != initial[i]) printf(" d%d=%lx", i, fp_state.d[i]);
            }
        }
        printf("\n");
    }
    printf("done\n");
    return 0;
}
