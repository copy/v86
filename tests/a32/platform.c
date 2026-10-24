// The 32-bit virt platform against QEMU's (docs/aarch32-plan.md R4): PSCI
// over HVC with the SMC32 function numbers, the generic timer's CP15
// registers and its interrupts through the GICv3 CPU interface's CP15
// registers, an SGI to itself, a second core started with CPU_ON in SVC
// mode (run with 2 cores).
#include <a32.h>
#include <stdio.h>

#define GICD 0x08000000u
#define GICR(core) (0x080A0000u + (core) * 0x20000u)
#define MMIO32(a) (*(volatile uint32_t *)(a))

static volatile uint32_t last_intid = 1023, interrupts;

static void irq(struct a32_frame *frame, int kind)
{
    uint32_t intid = a32_mrc(0, c12, c12, 0); // ICC_IAR1
    last_intid = intid;
    interrupts++;
    // (the timers' interrupts are levels: masked before the EOI)
    if(intid == 27) a32_mcr(0, c14, c3, 1, 3);
    if(intid == 30) a32_mcr(0, c14, c2, 1, 3);
    a32_mcr(0, c12, c12, 1, intid); // ICC_EOIR1
    a32_isb();
    (void)frame;
    (void)kind;
}

static void gic_init(unsigned core)
{
    if(core == 0) MMIO32(GICD) = 1 << 4 | 1 << 1 | 1;
    MMIO32(GICR(core) + 0x14) &= ~2u;
    while(MMIO32(GICR(core) + 0x14) & 4) {}
    MMIO32(GICR(core) + 0x10000 + 0x80) = ~0u;      // GICR_IGROUPR0: group 1
    for(int i = 0; i < 8; i++) MMIO32(GICR(core) + 0x10000 + 0x400 + 4 * i) = 0x80808080;
    MMIO32(GICR(core) + 0x10000 + 0x100) = 1 << 5 | 1 << 27 | 1 << 30; // SGI 5, PPI 27, 30
    a32_mcr(0, c12, c12, 5, 7);  // ICC_SRE
    a32_isb();
    a32_mcr(0, c4, c6, 0, 0xFF); // ICC_PMR
    a32_mcr(0, c12, c12, 7, 1);  // ICC_IGRPEN1
    a32_isb();
}

static void wait_interrupt(uint32_t count)
{
    // (interrupts on, spinning: a lost interrupt shows as the count it reached)
    __asm__ volatile("cpsie i" ::: "memory");
    for(uint32_t spins = 0; interrupts < count && spins < 20000000; spins++) __asm__ volatile("" ::: "memory");
    __asm__ volatile("cpsid i" ::: "memory");
}

static volatile uint32_t core1_mpidr, core1_cpsr, core1_context, core1_up;
static void core_main(unsigned core)
{
    core1_mpidr = a32_mrc(0, c0, c0, 5);
    core1_cpsr = a32_cpsr();
    core1_context = core;
    a32_dsb();
    core1_up = 1;
    a32_dsb();
    __asm__ volatile("sev");
}

int main(int argc, char **argv)
{
    printf("psci version %#x migrate_info_type %d\n", (unsigned)a32_hvc(0x84000000, 0, 0, 0), (int)a32_hvc(0x84000006, 0, 0, 0));
    printf("psci affinity_info core 0: %d core 1: %d\n", (int)a32_hvc(0x84000004, 0, 0, 0), (int)a32_hvc(0x84000004, 1, 0, 0));
    printf("cntfrq %u cntkctl %#x\n", (unsigned)a32_mrc(0, c14, c0, 0), (unsigned)a32_mrc(0, c14, c1, 0));
    uint64_t a = a32_mrrc(1, c14);
    for(volatile int i = 0; i < 10000; i++) {}
    uint64_t b = a32_mrrc(1, c14), p = a32_mrrc(0, c14);
    printf("cntvct increases %d, cntpct %d\n", b > a, p >= a);
    printf("icc_sre %#x\n", (unsigned)a32_mrc(0, c12, c12, 5));

    a32_interrupt_handler = irq;
    gic_init(0);
    printf("icc_sre %#x icc_pmr %#x icc_igrpen1 %#x\n", (unsigned)a32_mrc(0, c12, c12, 5), (unsigned)a32_mrc(0, c4, c6, 0),
        (unsigned)a32_mrc(0, c12, c12, 7));

    // the virtual timer: TVAL 10 us on
    a32_mcr(0, c14, c3, 0, 10000);
    a32_mcr(0, c14, c3, 1, 1);
    a32_isb();
    wait_interrupt(1);
    printf("virtual timer: interrupts %u intid %u ctl %#x\n", (unsigned)interrupts, (unsigned)last_intid, (unsigned)a32_mrc(0, c14, c3, 1));
    a32_mcr(0, c14, c3, 1, 0);

    // the physical timer: CVAL 10 us on
    a32_mcrr(2, c14, a32_mrrc(0, c14) + 10000);
    a32_mcr(0, c14, c2, 1, 1);
    a32_isb();
    wait_interrupt(2);
    printf("physical timer: interrupts %u intid %u ctl %#x\n", (unsigned)interrupts, (unsigned)last_intid, (unsigned)a32_mrc(0, c14, c2, 1));
    a32_mcr(0, c14, c2, 1, 0);

    // SGI 5 to this core (ICC_SGI1R: INTID 5, target list core 0)
    a32_dsb();
    a32_mcrr(0, c12, (uint64_t)5 << 24 | 1);
    a32_isb();
    wait_interrupt(3);
    printf("sgi: interrupts %u intid %u\n", (unsigned)interrupts, (unsigned)last_intid);

    // the second core
    a64_core_main = core_main;
    a32_dsb();
    printf("cpu_on core 1: %d\n", (int)a32_cpu_on(1));
    for(int spins = 0; !core1_up && spins < 10000000; spins++) __asm__ volatile("wfe");
    printf("core 1: up %u mpidr %#x mode %#x context %u\n", (unsigned)core1_up, (unsigned)core1_mpidr, (unsigned)(core1_cpsr & 0x1F),
        (unsigned)core1_context);
    printf("cpu_on core 1 again: %d\n", (int)a32_cpu_on(1));
    printf("psci affinity_info core 1: %d\n", (int)a32_hvc(0x84000004, 1, 0, 0));
    return 0;
}
