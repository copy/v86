// The bare-metal AArch32 guests' runtime (tests/a32/runner.mjs, cpu_type
// "arm32" and QEMU's cortex-a15): a raw image at RAM + 0x10000 (where QEMU's
// -kernel and the v86 virt loader put a 32-bit kernel), entered in SVC mode
// with the MMU off, r2 the DTB's address. Memory and the result block are
// the AArch64 guests' (a64.h, whose libc this runtime shares).
#ifndef A32_H
#define A32_H

#include <a64.h>

// the exception kinds (the vectors' offsets / 4)
enum { A32_UND = 1, A32_SVC = 2, A32_PABT = 3, A32_DABT = 4, A32_IRQ = 6, A32_FIQ = 7 };

// the modes
enum { A32_USR = 0x10, A32_FIQ_MODE = 0x11, A32_IRQ_MODE = 0x12, A32_SVC_MODE = 0x13, A32_ABT = 0x17,
    A32_UND_MODE = 0x1B, A32_SYS = 0x1F };

// An exception's frame (start.S): the interrupted R0-R12, the address to
// return to (the preferred return address: the instruction for UND, PABT
// and DABT, the next one for SVC, IRQ and FIQ) and its CPSR
struct a32_frame
{
    uint32_t r[13], pc, cpsr;
};

// An exception the test expects (a32_expect arms it; the next UND, SVC,
// PABT or DABT is recorded and returns past the instruction: `skip` bytes,
// 4 by default, 2 for a 16-bit T32 one), a32_caught disarms and reports it.
struct a32_fault
{
    int taken, kind;
    uint32_t fsr, far, pc, spsr, lr;
};
void a32_expect(int skip);
int a32_caught(struct a32_fault *fault);
// (instead of the skip: an expected exception returns here, and with this CPSR, when set)
extern volatile uint32_t a32_return_pc, a32_return_cpsr;

// Interrupts (IRQ, FIQ) go to this handler when it is set
extern void (*volatile a32_interrupt_handler)(struct a32_frame *frame, int kind);
// Every exception goes here first when it is set; it returns whether it took it
extern int (*volatile a32_exception_hook)(struct a32_frame *frame, int kind);

// PSCI over HVC (SMC32 function numbers): r0 returned
int32_t a32_hvc(uint32_t function, uint32_t a1, uint32_t a2, uint32_t a3);
// starts core `core` (MPIDR Aff0) at a32_secondary, calling a64_core_main(core)
int32_t a32_cpu_on(unsigned core);

#define a32_mrc(opc1, crn, crm, opc2) ({ uint32_t _v; \
    __asm__ volatile("mrc p15, " #opc1 ", %0, " #crn ", " #crm ", " #opc2 : "=r"(_v)); _v; })
#define a32_mcr(opc1, crn, crm, opc2, v) \
    __asm__ volatile("mcr p15, " #opc1 ", %0, " #crn ", " #crm ", " #opc2 :: "r"((uint32_t)(v)) : "memory")
#define a32_mrrc(opc1, crm) ({ uint32_t _l, _h; \
    __asm__ volatile("mrrc p15, " #opc1 ", %0, %1, " #crm : "=r"(_l), "=r"(_h)); (uint64_t)_h << 32 | _l; })
#define a32_mcrr(opc1, crm, v) ({ uint64_t _v = (v); \
    __asm__ volatile("mcrr p15, " #opc1 ", %0, %1, " #crm :: "r"((uint32_t)_v), "r"((uint32_t)(_v >> 32)) : "memory"); })
#define a32_cpsr() ({ uint32_t _v; __asm__ volatile("mrs %0, cpsr" : "=r"(_v)); _v; })
#define a32_isb() __asm__ volatile("isb" ::: "memory")
#define a32_dsb() __asm__ volatile("dsb sy" ::: "memory")

#endif
