// The GICv2 (the ranchu board's, docs/aarch32-plan.md R4.2) against QEMU's
// virt with gic-version=2: the distributor's banked and shared registers,
// ITARGETSR, the CPU interface, the virtual timer's PPI, SGIs by GICD_SGIR
// (to this core, and from core 1 with its source in GICC_IAR), the
// priority mask and EOI (run with 2 cores).
#include <a32.h>
#include <stdio.h>

#define GICD 0x08000000u
#define GICC 0x08010000u
#define MMIO32(a) (*(volatile uint32_t *)(a))
#define MMIO8(a) (*(volatile uint8_t *)(a))

static volatile uint32_t iars[8], interrupts;

static void irq(struct a32_frame *frame, int kind)
{
    uint32_t iar = MMIO32(GICC + 0x0C);
    if(interrupts < 8) iars[interrupts] = iar;
    interrupts++;
    if((iar & 0x3FF) == 27) a32_mcr(0, c14, c3, 1, 3);
    MMIO32(GICC + 0x10) = iar;
    (void)frame;
    (void)kind;
}

static void wait_interrupts(uint32_t count)
{
    __asm__ volatile("cpsie i" ::: "memory");
    for(uint32_t spins = 0; interrupts < count && spins < 20000000; spins++) __asm__ volatile("" ::: "memory");
    __asm__ volatile("cpsid i" ::: "memory");
}

static void cpu_interface_on(void)
{
    MMIO32(GICD + 0x100) = 1 << 3 | 1 << 5 | 1 << 27;   // SGIs 3, 5, PPI 27
    for(int i = 0; i < 8; i++) MMIO32(GICD + 0x400 + 4 * i) = 0xA0A0A0A0;
    MMIO32(GICC + 0x04) = 0xF0;
    MMIO32(GICC) = 1;
}

static volatile uint32_t core1_done;
static void core_main(unsigned core)
{
    cpu_interface_on();
    printf("core %u: itargetsr0 %#x isenabler0 %#x\n", core, (unsigned)MMIO32(GICD + 0x800), (unsigned)MMIO32(GICD + 0x100));
    // (SGI 5 to core 0)
    MMIO32(GICD + 0xF00) = 1 << 16 | 5;
    a32_dsb();
    core1_done = 1;
}

int main(int argc, char **argv)
{
    printf("typer %#x iidr %#x ctlr %#x\n", (unsigned)MMIO32(GICD + 0x4) & 0xFF, (unsigned)MMIO32(GICD + 0x8), (unsigned)MMIO32(GICD));
    printf("itargetsr0 %#x itargetsr8 %#x icfgr0 %#x icfgr1 %#x\n", (unsigned)MMIO32(GICD + 0x800), (unsigned)MMIO32(GICD + 0x820),
        (unsigned)MMIO32(GICD + 0xC00), (unsigned)MMIO32(GICD + 0xC04));
    MMIO32(GICD + 0x820) = 0x01020301;
    MMIO32(GICD + 0xC08) = 0xAAAA0000;
    printf("itargetsr8 written %#x icfgr2 %#x priority32 %#x\n", (unsigned)MMIO32(GICD + 0x820), (unsigned)MMIO32(GICD + 0xC08),
        (unsigned)(MMIO8(GICD + 0x420) = 0xFF, MMIO8(GICD + 0x420)));
    MMIO32(GICD) = 1;
    a32_interrupt_handler = irq;
    cpu_interface_on();
    printf("gicc ctlr %#x pmr %#x bpr %#x rpr %#x hppir %#x\n", (unsigned)MMIO32(GICC), (unsigned)MMIO32(GICC + 4), (unsigned)MMIO32(GICC + 8),
        (unsigned)MMIO32(GICC + 0x14), (unsigned)MMIO32(GICC + 0x18));

    // the virtual timer
    a32_mcr(0, c14, c3, 0, 10000);
    a32_mcr(0, c14, c3, 1, 1);
    a32_isb();
    wait_interrupts(1);
    a32_mcr(0, c14, c3, 1, 0);
    // SGI 3 to this core (TargetListFilter 2)
    MMIO32(GICD + 0xF00) = 2 << 24 | 3;
    wait_interrupts(2);
    // SGI 5 from core 1
    a64_core_main = core_main;
    a32_dsb();
    printf("cpu_on: %d\n", (int)a32_cpu_on(1));
    for(int spins = 0; !core1_done && spins < 10000000; spins++) __asm__ volatile("" ::: "memory");
    wait_interrupts(3);
    for(uint32_t i = 0; i < interrupts && i < 8; i++) printf("iar %u: intid %u cpu %u\n", (unsigned)i, (unsigned)(iars[i] & 0x3FF), (unsigned)(iars[i] >> 10 & 7));
    // the priority mask: pending SGI 3 with PMR below its priority stays pending
    MMIO32(GICC + 4) = 0x80;
    MMIO32(GICD + 0xF00) = 2 << 24 | 3;
    a32_dsb();
    printf("masked: ispendr0 %#x hppir %#x iar %#x\n", (unsigned)(MMIO32(GICD + 0x200) & 0xFFFF), (unsigned)MMIO32(GICC + 0x18),
        (unsigned)MMIO32(GICC + 0x0C));
    MMIO32(GICC + 4) = 0xF0;
    wait_interrupts(4);
    printf("interrupts %u, last intid %u, ispendr0 %#x\n", (unsigned)interrupts, (unsigned)(iars[3] & 0x3FF), (unsigned)(MMIO32(GICD + 0x200) & 0xFFFF));
    return 0;
}
