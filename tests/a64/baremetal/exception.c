// The exception entry's C half (start.S vector_common), built with
// -mgeneral-regs-only: an expected fault returns to the interrupted code,
// whose FP and SIMD registers the vectors do not save.

#include <a64.h>

static volatile struct a64_fault expected;
static volatile int armed;
uint64_t (*volatile a64_fault_probe)(void);
void (*volatile a64_lower_handler)(struct a64_frame *frame, uint64_t vector);

void a64_unexpected(struct a64_frame *frame, uint64_t vector);

void a64_expect(void)
{
    expected.taken = 0;
    __asm__ volatile("" ::: "memory");
    armed = 1;
}

int a64_caught(struct a64_fault *fault)
{
    armed = 0;
    __asm__ volatile("" ::: "memory");
    fault->taken = expected.taken;
    fault->esr = expected.esr;
    fault->far = expected.far;
    fault->elr = expected.elr;
    fault->spsr = expected.spsr;
    fault->probe = expected.probe;
    return fault->taken;
}

// (vector 4 is a synchronous exception from EL1 with SP_EL1; 8-15 come from
// EL0, AArch64's then AArch32's)
void a64_exception(struct a64_frame *frame, uint64_t vector)
{
    if(vector >= 8 && a64_lower_handler)
    {
        a64_lower_handler(frame, vector);
        return;
    }
    if(vector == 4 && armed && !expected.taken)
    {
        expected.taken = 1;
        expected.esr = a64_read(esr_el1);
        expected.far = a64_read(far_el1);
        expected.elr = frame->elr;
        expected.spsr = frame->spsr;
        expected.probe = a64_fault_probe ? a64_fault_probe() : 0;
        frame->elr += 4;
        return;
    }
    a64_unexpected(frame, vector);
}
