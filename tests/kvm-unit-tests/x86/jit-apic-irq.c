#include "libcflat.h"
#include "apic.h"
#include "vm.h"
#include "smp.h"
#include "desc.h"
#include "isr.h"

const int VECTOR = 0xE0;
const int ROUNDS = 300000;

static volatile int ipi_count = 0;

static void ipi_isr(isr_regs_t *regs)
{
    ipi_count++;
    eoi();
}

int main(void)
{
    setup_vm();
    mask_pic_interrupts();

    apic_write(APIC_SPIV, APIC_SPIV_APIC_ENABLED | 0xFF);
    handle_irq(VECTOR, ipi_isr);
    irq_enable();

    unsigned acc = 0;
    for(int i = 0; i < ROUNDS; i++)
    {
        // self-IPI delivered synchronously
        apic_icr_write(APIC_DEST_SELF | APIC_DEST_PHYSICAL | APIC_DM_FIXED | VECTOR, 0);
        // trailing work in the same block, so the store is not the block's last instruction
        acc += i * 2654435761u;
    }

    printf("delivered %d of %d self-IPIs (acc=%u)\n", ipi_count, ROUNDS, acc);
    report("every self-IPI from a jit block was delivered", ipi_count == ROUNDS);

    // same, but with a rmw instruction (gen_safe_read_write)
    ipi_count = 0;
    for(int i = 0; i < ROUNDS; i++)
    {
        u32 icr = APIC_DEST_SELF | APIC_DEST_PHYSICAL | APIC_DM_FIXED | VECTOR;
        asm volatile("xchgl %0, %1"
                     : "+r"(icr), "+m"(*(volatile u32 *)(APIC_DEFAULT_PHYS_BASE + APIC_ICR)));
        acc += i * 2654435761u;
    }

    printf("delivered %d of %d xchg self-IPIs (acc=%u)\n", ipi_count, ROUNDS, acc);
    report("every xchg self-IPI from a jit block was delivered", ipi_count == ROUNDS);
    return report_summary();
}
