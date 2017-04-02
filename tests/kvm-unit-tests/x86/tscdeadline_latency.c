/*
 * qemu command line | grep latency | cut -f 2 -d ":" > latency
 *
 * In octave:
 * load latency
 * min(latency)
 * max(latency)
 * mean(latency)
 * hist(latency, 50)
 */

/*
 * for host tracing of breakmax option:
 *
 * # cd /sys/kernel/debug/tracing/
 * # echo x86-tsc > trace_clock
 * # echo "kvm_exit kvm_entry kvm_msr" > set_event
 * # echo "sched_switch $extratracepoints" >> set_event
 * # echo apic_timer_fn > set_ftrace_filter
 * # echo "function" > current_tracer
 */

#include "libcflat.h"
#include "apic.h"
#include "vm.h"
#include "smp.h"
#include "desc.h"
#include "isr.h"
#include "msr.h"

static void test_lapic_existence(void)
{
    u32 lvr;

    lvr = apic_read(APIC_LVR);
    printf("apic version: %x\n", lvr);
    report("apic existence", (u16)lvr == 0x14);
}

#define TSC_DEADLINE_TIMER_VECTOR 0xef

static int tdt_count;
u64 exptime;
int delta;
#define TABLE_SIZE 10000
u64 table[TABLE_SIZE];
volatile int table_idx;
volatile int hitmax = 0;
int breakmax = 0;

static void tsc_deadline_timer_isr(isr_regs_t *regs)
{
    u64 now = rdtsc();
    ++tdt_count;

    if (table_idx < TABLE_SIZE && tdt_count > 1)
        table[table_idx++] = now - exptime;

    if (breakmax && tdt_count > 1 && (now - exptime) > breakmax) {
        hitmax = 1;
        apic_write(APIC_EOI, 0);
        return;
    }

    exptime = now+delta;
    wrmsr(MSR_IA32_TSCDEADLINE, now+delta);
    apic_write(APIC_EOI, 0);
}

static void start_tsc_deadline_timer(void)
{
    handle_irq(TSC_DEADLINE_TIMER_VECTOR, tsc_deadline_timer_isr);
    irq_enable();

    wrmsr(MSR_IA32_TSCDEADLINE, rdmsr(MSR_IA32_TSC)+delta);
    asm volatile ("nop");
}

static int enable_tsc_deadline_timer(void)
{
    uint32_t lvtt;

    if (cpuid(1).c & (1 << 24)) {
        lvtt = APIC_LVT_TIMER_TSCDEADLINE | TSC_DEADLINE_TIMER_VECTOR;
        apic_write(APIC_LVTT, lvtt);
        start_tsc_deadline_timer();
        return 1;
    } else {
        return 0;
    }
}

static void test_tsc_deadline_timer(void)
{
    if(enable_tsc_deadline_timer()) {
        printf("tsc deadline timer enabled\n");
    } else {
        printf("tsc deadline timer not detected, aborting\n");
        abort();
    }
}

int main(int argc, char **argv)
{
    int i, size;

    setup_vm();
    smp_init();

    test_lapic_existence();

    mask_pic_interrupts();

    delta = argc <= 1 ? 200000 : atol(argv[1]);
    size = argc <= 2 ? TABLE_SIZE : atol(argv[2]);
    breakmax = argc <= 3 ? 0 : atol(argv[3]);
    printf("breakmax=%d\n", breakmax);
    test_tsc_deadline_timer();
    irq_enable();

    do {
        asm volatile("hlt");
    } while (!hitmax && table_idx < size);

    for (i = 0; i < table_idx; i++) {
        if (hitmax && i == table_idx-1)
            printf("hit max: %d < ", breakmax);
        printf("latency: %" PRId64 "\n", table[i]);
    }

    return report_summary();
}
