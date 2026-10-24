// The bare-metal AArch32 guests' C runtime (include/a32.h): output into the
// result block's text, the startup and finish of a run, the exceptions;
// printf and the allocator are the AArch64 guests' libc.c.

#include <a32.h>
#include <stdio.h>

static volatile unsigned text_length;
void (*volatile a64_core_main)(unsigned core);
void (*volatile a32_interrupt_handler)(struct a32_frame *frame, int kind);
int (*volatile a32_exception_hook)(struct a32_frame *frame, int kind);

static void finish(uint32_t status)
{
    a64_result->length = text_length;
    a64_result->status = status;
    a32_dsb();
    a64_result->magic = A64_DONE;
    a32_dsb();
    for(;;) __asm__ volatile("wfi");
}

void a64_putc(char c)
{
    if(text_length >= A64_TEXT_SIZE) finish(A64_TEXT_OVERFLOW);
    ((volatile char *)A64_TEXT)[text_length++] = c;
}

void a64_fail(const char *why)
{
    printf("A32_FAIL %s\n", why);
    finish(A64_FAILED);
}

void a32_start(uint32_t dtb)
{
    a64_result->magic = 0;
    a64_result->status = 0;
    a64_result->length = 0;
    a64_result->cores = 1;
    a64_result->dtb = dtb;
    char *argv[] = { "a32", 0 };
    int status = main(1, argv);
    finish(status ? A64_FAILED : A64_OK);
}

void a64_secondary_start(unsigned core)
{
    if(a64_core_main) a64_core_main(core);
    for(;;) __asm__ volatile("wfi");
}

void exit(int status) { finish(status ? A64_FAILED : A64_OK); }
void abort(void) { a64_fail("abort"); for(;;); }

int32_t a32_hvc(uint32_t function, uint32_t a1, uint32_t a2, uint32_t a3)
{
    register uint32_t r0 __asm__("r0") = function, r1 __asm__("r1") = a1, r2 __asm__("r2") = a2, r3 __asm__("r3") = a3;
    __asm__ volatile(".arch_extension virt\n hvc #0" : "+r"(r0), "+r"(r1), "+r"(r2), "+r"(r3) :: "memory");
    return r0;
}

extern char a32_secondary[];
int32_t a32_cpu_on(unsigned core)
{
    return a32_hvc(0x84000003, core, (uint32_t)a32_secondary, core); // PSCI CPU_ON (SMC32)
}

// -------- exceptions

static volatile struct a32_fault expected;
static volatile int armed, skip_bytes;
volatile uint32_t a32_return_pc, a32_return_cpsr;

void a32_expect(int skip)
{
    expected.taken = 0;
    skip_bytes = skip ? skip : 4;
    __asm__ volatile("" ::: "memory");
    armed = 1;
}

int a32_caught(struct a32_fault *fault)
{
    armed = 0;
    __asm__ volatile("" ::: "memory");
    fault->taken = expected.taken;
    fault->kind = expected.kind;
    fault->fsr = expected.fsr;
    fault->far = expected.far;
    fault->pc = expected.pc;
    fault->spsr = expected.spsr;
    fault->lr = expected.lr;
    return fault->taken;
}

// (the fault status and address: DFSR and DFAR for a data abort, IFSR and IFAR for a prefetch abort)
static uint32_t fsr_of(int kind) { return kind == A32_DABT ? a32_mrc(0, c5, c0, 0) : kind == A32_PABT ? a32_mrc(0, c5, c0, 1) : 0; }
static uint32_t far_of(int kind) { return kind == A32_DABT ? a32_mrc(0, c6, c0, 0) : kind == A32_PABT ? a32_mrc(0, c6, c0, 2) : 0; }

void a32_exception(struct a32_frame *frame, int kind)
{
    // (UND's return address: the instruction, LR - 4 in A32, LR - 2 in T32)
    uint32_t lr = frame->pc;
    if(kind == A32_UND) frame->pc -= frame->cpsr & 1 << 5 ? 2 : 4;
    if(a32_exception_hook && a32_exception_hook(frame, kind)) return;
    if((kind == A32_IRQ || kind == A32_FIQ) && a32_interrupt_handler)
    {
        a32_interrupt_handler(frame, kind);
        return;
    }
    if(kind != A32_IRQ && kind != A32_FIQ && armed && !expected.taken)
    {
        expected.taken = 1;
        expected.kind = kind;
        expected.fsr = fsr_of(kind);
        expected.far = far_of(kind);
        expected.pc = frame->pc;
        expected.spsr = frame->cpsr;
        expected.lr = lr;
        // (SVC returns to the next instruction already)
        if(a32_return_pc)
        {
            frame->pc = a32_return_pc;
            if(a32_return_cpsr) frame->cpsr = a32_return_cpsr;
        }
        else if(kind != A32_SVC) frame->pc += skip_bytes;
        return;
    }
    a64_result->vector = kind;
    a64_result->esr = fsr_of(kind);
    a64_result->far = far_of(kind);
    a64_result->elr = frame->pc;
    a64_result->spsr = frame->cpsr;
    printf("A32_EXCEPTION kind=%d fsr=%#x pc=%#x far=%#x cpsr=%#x\n", kind, (unsigned)fsr_of(kind),
        (unsigned)frame->pc, (unsigned)far_of(kind), (unsigned)frame->cpsr);
    finish(A64_UNEXPECTED_EXCEPTION);
}

// -------- the AEABI's 64-bit division (aeabi.S): shift and subtract
uint64_t a32_divmod64(uint64_t n, uint64_t d, uint64_t *remainder, int is_signed)
{
    int negative_q = 0, negative_r = 0;
    if(is_signed)
    {
        if((int64_t)n < 0) { n = -n; negative_q ^= 1; negative_r = 1; }
        if((int64_t)d < 0) { d = -d; negative_q ^= 1; }
    }
    uint64_t q = 0, r = 0;
    if(d == 0) { *remainder = n; return ~(uint64_t)0; }
    for(int i = 63; i >= 0; i--)
    {
        r = r << 1 | (n >> i & 1);
        if(r >= d) { r -= d; q |= (uint64_t)1 << i; }
    }
    *remainder = negative_r ? -r : r;
    return negative_q ? -q : q;
}
