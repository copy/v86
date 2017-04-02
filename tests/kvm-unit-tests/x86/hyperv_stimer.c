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
#include "asm/barrier.h"

#define MAX_CPUS 4

#define SINT1_VEC 0xF1
#define SINT2_VEC 0xF2

#define SINT1_NUM 2
#define SINT2_NUM 3
#define ONE_MS_IN_100NS 10000

static atomic_t g_cpus_comp_count;
static int g_cpus_count;
static struct spinlock g_synic_alloc_lock;

struct stimer {
    int sint;
    int index;
    atomic_t fire_count;
};

struct svcpu {
    int vcpu;
    void *msg_page;
    void *evt_page;
    struct stimer timer[HV_SYNIC_STIMER_COUNT];
};

static struct svcpu g_synic_vcpu[MAX_CPUS];

static void *synic_alloc_page(void)
{
    void *page;

    spin_lock(&g_synic_alloc_lock);
    page = alloc_page();
    spin_unlock(&g_synic_alloc_lock);
    return page;
}

static void synic_free_page(void *page)
{
    spin_lock(&g_synic_alloc_lock);
    free_page(page);
    spin_unlock(&g_synic_alloc_lock);
}

static void stimer_init(struct stimer *timer, int index)
{
    memset(timer, 0, sizeof(*timer));
    timer->index = index;
}

static void synic_enable(void)
{
    int vcpu = smp_id(), i;
    struct svcpu *svcpu = &g_synic_vcpu[vcpu];

    memset(svcpu, 0, sizeof(*svcpu));
    svcpu->vcpu = vcpu;
    svcpu->msg_page = synic_alloc_page();
    for (i = 0; i < ARRAY_SIZE(svcpu->timer); i++) {
        stimer_init(&svcpu->timer[i], i);
    }
    wrmsr(HV_X64_MSR_SIMP, (u64)virt_to_phys(svcpu->msg_page) |
            HV_SYNIC_SIMP_ENABLE);
    wrmsr(HV_X64_MSR_SCONTROL, HV_SYNIC_CONTROL_ENABLE);
}

static void stimer_shutdown(struct stimer *timer)
{
    wrmsr(HV_X64_MSR_STIMER0_CONFIG + 2*timer->index, 0);
}

static void process_stimer_expired(struct svcpu *svcpu, struct stimer *timer,
                                   u64 expiration_time, u64 delivery_time)
{
    atomic_inc(&timer->fire_count);
}

static void process_stimer_msg(struct svcpu *svcpu,
                              struct hv_message *msg, int sint)
{
    struct hv_timer_message_payload *payload =
                        (struct hv_timer_message_payload *)msg->u.payload;
    struct stimer *timer;

    if (msg->header.message_type != HVMSG_TIMER_EXPIRED &&
        msg->header.message_type != HVMSG_NONE) {
        report("invalid Hyper-V SynIC msg type", false);
        report_summary();
        abort();
    }

    if (msg->header.message_type == HVMSG_NONE) {
        return;
    }

    if (msg->header.payload_size < sizeof(*payload)) {
        report("invalid Hyper-V SynIC msg payload size", false);
        report_summary();
        abort();
    }

    /* Now process timer expiration message */

    if (payload->timer_index >= ARRAY_SIZE(svcpu->timer)) {
        report("invalid Hyper-V SynIC timer index", false);
        report_summary();
        abort();
    }
    timer = &svcpu->timer[payload->timer_index];
    process_stimer_expired(svcpu, timer, payload->expiration_time,
                          payload->delivery_time);

    msg->header.message_type = HVMSG_NONE;
    mb();
    if (msg->header.message_flags.msg_pending) {
        wrmsr(HV_X64_MSR_EOM, 0);
    }
}

static void __stimer_isr(int vcpu)
{
    struct svcpu *svcpu = &g_synic_vcpu[vcpu];
    struct hv_message_page *msg_page;
    struct hv_message *msg;
    int i;


    msg_page = (struct hv_message_page *)svcpu->msg_page;
    for (i = 0; i < ARRAY_SIZE(msg_page->sint_message); i++) {
        msg = &msg_page->sint_message[i];
        process_stimer_msg(svcpu, msg, i);
    }
}

static void stimer_isr(isr_regs_t *regs)
{
    int vcpu = smp_id();

    __stimer_isr(vcpu);
    eoi();
}

static void stimer_isr_auto_eoi(isr_regs_t *regs)
{
    int vcpu = smp_id();

    __stimer_isr(vcpu);
}

static void stimer_start(struct stimer *timer,
                         bool auto_enable, bool periodic,
                         u64 tick_100ns, int sint)
{
    u64 config, count;

    timer->sint = sint;
    atomic_set(&timer->fire_count, 0);

    config = 0;
    if (periodic) {
        config |= HV_STIMER_PERIODIC;
    }

    config |= ((u8)(sint & 0xFF)) << 16;
    config |= HV_STIMER_ENABLE;
    if (auto_enable) {
        config |= HV_STIMER_AUTOENABLE;
    }

    if (periodic) {
        count = tick_100ns;
    } else {
        count = rdmsr(HV_X64_MSR_TIME_REF_COUNT) + tick_100ns;
    }

    if (!auto_enable) {
        wrmsr(HV_X64_MSR_STIMER0_COUNT + timer->index*2, count);
        wrmsr(HV_X64_MSR_STIMER0_CONFIG + timer->index*2, config);
    } else {
        wrmsr(HV_X64_MSR_STIMER0_CONFIG + timer->index*2, config);
        wrmsr(HV_X64_MSR_STIMER0_COUNT + timer->index*2, count);
    }
}

static void stimers_shutdown(void)
{
    int vcpu = smp_id(), i;
    struct svcpu *svcpu = &g_synic_vcpu[vcpu];

    for (i = 0; i < ARRAY_SIZE(svcpu->timer); i++) {
        stimer_shutdown(&svcpu->timer[i]);
    }
}

static void synic_disable(void)
{
    int vcpu = smp_id();
    struct svcpu *svcpu = &g_synic_vcpu[vcpu];

    wrmsr(HV_X64_MSR_SCONTROL, 0);
    wrmsr(HV_X64_MSR_SIMP, 0);
    wrmsr(HV_X64_MSR_SIEFP, 0);
    synic_free_page(svcpu->msg_page);
}

static void cpu_comp(void)
{
    atomic_inc(&g_cpus_comp_count);
}

static void stimer_test_prepare(void *ctx)
{
    int vcpu = smp_id();

    write_cr3((ulong)ctx);
    synic_enable();
    synic_sint_create(vcpu, SINT1_NUM, SINT1_VEC, false);
    synic_sint_create(vcpu, SINT2_NUM, SINT2_VEC, true);
    cpu_comp();
}

static void stimer_test_periodic(int vcpu, struct stimer *timer1,
                                 struct stimer *timer2)
{
    /* Check periodic timers */
    stimer_start(timer1, false, true, ONE_MS_IN_100NS, SINT1_NUM);
    stimer_start(timer2, false, true, ONE_MS_IN_100NS, SINT2_NUM);
    while ((atomic_read(&timer1->fire_count) < 1000) ||
           (atomic_read(&timer2->fire_count) < 1000)) {
        pause();
    }
    report("Hyper-V SynIC periodic timers test vcpu %d", true, vcpu);
    stimer_shutdown(timer1);
    stimer_shutdown(timer2);
}

static void stimer_test_one_shot(int vcpu, struct stimer *timer)
{
    /* Check one-shot timer */
    stimer_start(timer, false, false, ONE_MS_IN_100NS, SINT1_NUM);
    while (atomic_read(&timer->fire_count) < 1) {
        pause();
    }
    report("Hyper-V SynIC one-shot test vcpu %d", true, vcpu);
    stimer_shutdown(timer);
}

static void stimer_test_auto_enable_one_shot(int vcpu, struct stimer *timer)
{
    /* Check auto-enable one-shot timer */
    stimer_start(timer, true, false, ONE_MS_IN_100NS, SINT1_NUM);
    while (atomic_read(&timer->fire_count) < 1) {
        pause();
    }
    report("Hyper-V SynIC auto-enable one-shot timer test vcpu %d", true, vcpu);
    stimer_shutdown(timer);
}

static void stimer_test_auto_enable_periodic(int vcpu, struct stimer *timer)
{
    /* Check auto-enable periodic timer */
    stimer_start(timer, true, true, ONE_MS_IN_100NS, SINT1_NUM);
    while (atomic_read(&timer->fire_count) < 1000) {
        pause();
    }
    report("Hyper-V SynIC auto-enable periodic timer test vcpu %d", true, vcpu);
    stimer_shutdown(timer);
}

static void stimer_test(void *ctx)
{
    int vcpu = smp_id();
    struct svcpu *svcpu = &g_synic_vcpu[vcpu];
    struct stimer *timer1, *timer2;

    irq_enable();

    timer1 = &svcpu->timer[0];
    timer2 = &svcpu->timer[1];

    stimer_test_periodic(vcpu, timer1, timer2);
    stimer_test_one_shot(vcpu, timer1);
    stimer_test_auto_enable_one_shot(vcpu, timer2);
    stimer_test_auto_enable_periodic(vcpu, timer1);

    irq_disable();
    cpu_comp();
}

static void stimer_test_cleanup(void *ctx)
{
    int vcpu = smp_id();

    stimers_shutdown();
    synic_sint_destroy(vcpu, SINT1_NUM);
    synic_sint_destroy(vcpu, SINT2_NUM);
    synic_disable();
    cpu_comp();
}

static void on_each_cpu_async_wait(void (*func)(void *ctx), void *ctx)
{
    int i;

    atomic_set(&g_cpus_comp_count, 0);
    for (i = 0; i < g_cpus_count; i++) {
        on_cpu_async(i, func, ctx);
    }
    while (atomic_read(&g_cpus_comp_count) != g_cpus_count) {
        pause();
    }
}

static void stimer_test_all(void)
{
    int ncpus;

    setup_vm();
    smp_init();
    enable_apic();

    handle_irq(SINT1_VEC, stimer_isr);
    handle_irq(SINT2_VEC, stimer_isr_auto_eoi);

    ncpus = cpu_count();
    if (ncpus > MAX_CPUS) {
        ncpus = MAX_CPUS;
    }

    printf("cpus = %d\n", ncpus);
    g_cpus_count = ncpus;

    on_each_cpu_async_wait(stimer_test_prepare, (void *)read_cr3());
    on_each_cpu_async_wait(stimer_test, NULL);
    on_each_cpu_async_wait(stimer_test_cleanup, NULL);
}

int main(int ac, char **av)
{

    if (!synic_supported()) {
        report("Hyper-V SynIC is not supported", true);
        goto done;
    }

    if (!stimer_supported()) {
        report("Hyper-V SynIC timers are not supported", true);
        goto done;
    }

    if (!hv_time_ref_counter_supported()) {
        report("Hyper-V time reference counter is not supported", true);
        goto done;
    }

    stimer_test_all();
done:
    return report_summary();
}
