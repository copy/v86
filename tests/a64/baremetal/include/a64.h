// The bare-metal AArch64 guests' runtime (tests/a64/guest_runner.mjs).
//
// Memory (RAM at 0x4000_0000, at least 128 MiB): the image at 0x4008_0000,
// the heap from its end to 0x4070_0000, 64 KiB of stack per core below
// 0x4080_0000, then the result block (struct a64_result) at 0x4080_0000 and
// the output text at 0x4080_1000. The guest is done when the result block's
// magic is A64_DONE; the runner then reads the block and the text.
#ifndef A64_H
#define A64_H

#include <stdint.h>
#include <stddef.h>

#define A64_RESULT 0x40800000UL
#define A64_TEXT (A64_RESULT + 0x1000)
#define A64_TEXT_SIZE (0x100000 - 0x1000)
#define A64_HEAP_END 0x40700000UL
#define A64_DONE 0xA64D0E00u

enum a64_status { A64_OK = 0, A64_FAILED = 1, A64_UNEXPECTED_EXCEPTION = 2, A64_TEXT_OVERFLOW = 3 };

struct a64_result
{
    uint32_t magic, status, length, cores;
    // the unexpected exception, if any
    uint64_t vector, esr, elr, far, spsr;
    uint64_t dtb;
};

struct a64_frame
{
    uint64_t x[31], elr, spsr, pad;
};

#define a64_result ((volatile struct a64_result *)A64_RESULT)

// An exception the test expects: a64_expect() arms it, the next synchronous
// exception at EL1 is recorded instead of failing the run and returns past
// the faulting instruction (ELR + 4), a64_caught() disarms and reports it.
struct a64_fault
{
    int taken;
    uint64_t esr, far, elr;
};
void a64_expect(void);
int a64_caught(struct a64_fault *fault);

void a64_putc(char c);
void a64_fail(const char *why);

// PSCI over HVC (SMCCC): function id and up to 3 arguments, x0 returned
int64_t a64_hvc(uint64_t function, uint64_t a1, uint64_t a2, uint64_t a3);
int64_t a64_hvc_imm1(uint64_t function); // HVC #1
// starts core `core` (MPIDR Aff0) at a64_secondary, calling a64_core_main(core)
int64_t a64_cpu_on(unsigned core);
extern void (*volatile a64_core_main)(unsigned core);

#define a64_read(reg) ({ uint64_t _v; __asm__ volatile("mrs %0, " #reg : "=r"(_v)); _v; })
#define a64_write(reg, v) __asm__ volatile("msr " #reg ", %0" :: "r"((uint64_t)(v)))

int main(int argc, char **argv);

#endif
