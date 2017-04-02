#include "libcflat.h"
#include "processor.h"
#include "msr.h"
#include "isr.h"
#include "vm.h"
#include "apic.h"
#include "desc.h"
#include "smp.h"
#include "atomic.h"
#include "hyperv.h"

#define MAX_CPUS 4

static atomic_t isr_enter_count[MAX_CPUS];
static atomic_t cpus_comp_count;

static void synic_sint_auto_eoi_isr(isr_regs_t *regs)
{
    atomic_inc(&isr_enter_count[smp_id()]);
}

static void synic_sint_isr(isr_regs_t *regs)
{
    atomic_inc(&isr_enter_count[smp_id()]);
    eoi();
}

struct sint_vec_entry {
    int vec;
    bool auto_eoi;
};

struct sint_vec_entry sint_vecs[HV_SYNIC_SINT_COUNT] = {
    {0xB0, false},
    {0xB1, false},
    {0xB2, false},
    {0xB3, true},
    {0xB4, false},
    {0xB5, false},
    {0xB6, false},
    {0xB7, false},
    {0xB8, true},
    {0xB9, false},
    {0xBA, true},
    {0xBB, false},
    {0xBC, false},
    {0xBD, false},
    {0xBE, true},
    {0xBF, false},
};

static void synic_prepare_sint_vecs(void)
{
    bool auto_eoi;
    int i, vec;

    for (i = 0; i < HV_SYNIC_SINT_COUNT; i++) {
        vec = sint_vecs[i].vec;
        auto_eoi = sint_vecs[i].auto_eoi;
        handle_irq(vec, (auto_eoi) ? synic_sint_auto_eoi_isr : synic_sint_isr);
    }
}

static void synic_sints_prepare(int vcpu)
{
    bool auto_eoi;
    int i, vec;

    for (i = 0; i < HV_SYNIC_SINT_COUNT; i++) {
        vec = sint_vecs[i].vec;
        auto_eoi = sint_vecs[i].auto_eoi;
        synic_sint_create(vcpu, i, vec, auto_eoi);
    }
}

static void synic_test_prepare(void *ctx)
{
    u64 r;
    int i = 0;

    write_cr3((ulong)ctx);
    irq_enable();

    rdmsr(HV_X64_MSR_SVERSION);
    rdmsr(HV_X64_MSR_SIMP);
    rdmsr(HV_X64_MSR_SIEFP);
    rdmsr(HV_X64_MSR_SCONTROL);
    for (i = 0; i < HV_SYNIC_SINT_COUNT; i++) {
        rdmsr(HV_X64_MSR_SINT0 + i);
    }
    r = rdmsr(HV_X64_MSR_EOM);
    if (r != 0) {
        report("Hyper-V SynIC test, EOM read 0x%llx", false, r);
        goto ret;
    }

    wrmsr(HV_X64_MSR_SIMP, (u64)virt_to_phys(alloc_page()) |
            HV_SYNIC_SIMP_ENABLE);
    wrmsr(HV_X64_MSR_SIEFP, (u64)virt_to_phys(alloc_page())|
            HV_SYNIC_SIEFP_ENABLE);
    wrmsr(HV_X64_MSR_SCONTROL, HV_SYNIC_CONTROL_ENABLE);

    synic_sints_prepare(smp_id());
ret:
    atomic_inc(&cpus_comp_count);
}

static void synic_sints_test(int dst_vcpu)
{
    int i;

    atomic_set(&isr_enter_count[dst_vcpu], 0);
    for (i = 0; i < HV_SYNIC_SINT_COUNT; i++) {
        synic_sint_set(dst_vcpu, i);
    }

    while (atomic_read(&isr_enter_count[dst_vcpu]) != HV_SYNIC_SINT_COUNT) {
        pause();
    }
}

static void synic_test(void *ctx)
{
    int dst_vcpu = (ulong)ctx;

    irq_enable();
    synic_sints_test(dst_vcpu);
    atomic_inc(&cpus_comp_count);
}

static void synic_test_cleanup(void *ctx)
{
    int vcpu = smp_id();
    int i;

    irq_enable();
    for (i = 0; i < HV_SYNIC_SINT_COUNT; i++) {
        synic_sint_destroy(vcpu, i);
        wrmsr(HV_X64_MSR_SINT0 + i, 0xFF|HV_SYNIC_SINT_MASKED);
    }

    wrmsr(HV_X64_MSR_SCONTROL, 0);
    wrmsr(HV_X64_MSR_SIMP, 0);
    wrmsr(HV_X64_MSR_SIEFP, 0);
    atomic_inc(&cpus_comp_count);
}

int main(int ac, char **av)
{

    if (synic_supported()) {
        int ncpus, i;
        bool ok;

        setup_vm();
        smp_init();
        enable_apic();

        synic_prepare_sint_vecs();

        ncpus = cpu_count();
        if (ncpus > MAX_CPUS) {
            ncpus = MAX_CPUS;
        }
        printf("ncpus = %d\n", ncpus);

        atomic_set(&cpus_comp_count, 0);
        for (i = 0; i < ncpus; i++) {
            on_cpu_async(i, synic_test_prepare, (void *)read_cr3());
        }
        printf("prepare\n");
        while (atomic_read(&cpus_comp_count) != ncpus) {
            pause();
        }

        atomic_set(&cpus_comp_count, 0);
        for (i = 0; i < ncpus; i++) {
            printf("test %d -> %d\n", i, ncpus - 1 - i);
            on_cpu_async(i, synic_test, (void *)(ulong)(ncpus - 1 - i));
        }
        while (atomic_read(&cpus_comp_count) != ncpus) {
            pause();
        }

        atomic_set(&cpus_comp_count, 0);
        for (i = 0; i < ncpus; i++) {
            on_cpu_async(i, synic_test_cleanup, NULL);
        }
        printf("cleanup\n");
        while (atomic_read(&cpus_comp_count) != ncpus) {
            pause();
        }

        ok = true;
        for (i = 0; i < ncpus; ++i) {
            printf("isr_enter_count[%d] = %d\n",
                   i, atomic_read(&isr_enter_count[i]));
            ok &= atomic_read(&isr_enter_count[i]) == 16;
        }

        report("Hyper-V SynIC test", ok);
    } else {
        printf("Hyper-V SynIC is not supported");
    }

    return report_summary();
}
