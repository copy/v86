
#include "x86/msr.h"
#include "x86/processor.h"
#include "x86/apic-defs.h"
#include "x86/apic.h"
#include "x86/desc.h"
#include "x86/isr.h"
#include "x86/vm.h"

#include "libcflat.h"
#include <stdint.h>

#define FIXED_CNT_INDEX 32
#define PC_VECTOR	32

#define EVNSEL_EVENT_SHIFT	0
#define EVNTSEL_UMASK_SHIFT	8
#define EVNTSEL_USR_SHIFT	16
#define EVNTSEL_OS_SHIFT	17
#define EVNTSEL_EDGE_SHIFT	18
#define EVNTSEL_PC_SHIFT	19
#define EVNTSEL_INT_SHIFT	20
#define EVNTSEL_EN_SHIF		22
#define EVNTSEL_INV_SHIF	23
#define EVNTSEL_CMASK_SHIFT	24

#define EVNTSEL_EN	(1 << EVNTSEL_EN_SHIF)
#define EVNTSEL_USR	(1 << EVNTSEL_USR_SHIFT)
#define EVNTSEL_OS	(1 << EVNTSEL_OS_SHIFT)
#define EVNTSEL_PC	(1 << EVNTSEL_PC_SHIFT)
#define EVNTSEL_INT	(1 << EVNTSEL_INT_SHIFT)
#define EVNTSEL_INV	(1 << EVNTSEL_INV_SHIF)

#define N 1000000

typedef struct {
	uint32_t ctr;
	uint32_t config;
	uint64_t count;
	int idx;
} pmu_counter_t;

union cpuid10_eax {
	struct {
		unsigned int version_id:8;
		unsigned int num_counters:8;
		unsigned int bit_width:8;
		unsigned int mask_length:8;
	} split;
	unsigned int full;
} eax;

union cpuid10_ebx {
	struct {
		unsigned int no_unhalted_core_cycles:1;
		unsigned int no_instructions_retired:1;
		unsigned int no_unhalted_reference_cycles:1;
		unsigned int no_llc_reference:1;
		unsigned int no_llc_misses:1;
		unsigned int no_branch_instruction_retired:1;
		unsigned int no_branch_misses_retired:1;
	} split;
	unsigned int full;
} ebx;

union cpuid10_edx {
	struct {
		unsigned int num_counters_fixed:5;
		unsigned int bit_width_fixed:8;
		unsigned int reserved:19;
	} split;
	unsigned int full;
} edx;

struct pmu_event {
	char *name;
	uint32_t unit_sel;
	int min;
	int max;
} gp_events[] = {
	{"core cycles", 0x003c, 1*N, 50*N},
	{"instructions", 0x00c0, 10*N, 10.2*N},
	{"ref cycles", 0x013c, 0.1*N, 30*N},
	{"llc refference", 0x4f2e, 1, 2*N},
	{"llc misses", 0x412e, 1, 1*N},
	{"branches", 0x00c4, 1*N, 1.1*N},
	{"branch misses", 0x00c5, 0, 0.1*N},
}, fixed_events[] = {
	{"fixed 1", MSR_CORE_PERF_FIXED_CTR0, 10*N, 10.2*N},
	{"fixed 2", MSR_CORE_PERF_FIXED_CTR0 + 1, 1*N, 30*N},
	{"fixed 3", MSR_CORE_PERF_FIXED_CTR0 + 2, 0.1*N, 30*N}
};

static int num_counters;

char *buf;

static inline void loop()
{
	unsigned long tmp, tmp2, tmp3;

	asm volatile("1: mov (%1), %2; add $64, %1; nop; nop; nop; nop; nop; nop; nop; loop 1b"
			: "=c"(tmp), "=r"(tmp2), "=r"(tmp3): "0"(N), "1"(buf));

}

volatile uint64_t irq_received;

static void cnt_overflow(isr_regs_t *regs)
{
	irq_received++;
	apic_write(APIC_EOI, 0);
}

static bool check_irq(void)
{
	int i;
	irq_received = 0;
	irq_enable();
	for (i = 0; i < 100000 && !irq_received; i++)
		asm volatile("pause");
	irq_disable();
	return irq_received;
}

static bool is_gp(pmu_counter_t *evt)
{
	return evt->ctr < MSR_CORE_PERF_FIXED_CTR0;
}

static int event_to_global_idx(pmu_counter_t *cnt)
{
	return cnt->ctr - (is_gp(cnt) ? MSR_IA32_PERFCTR0 :
		(MSR_CORE_PERF_FIXED_CTR0 - FIXED_CNT_INDEX));
}

static struct pmu_event* get_counter_event(pmu_counter_t *cnt)
{
	if (is_gp(cnt)) {
		int i;

		for (i = 0; i < sizeof(gp_events)/sizeof(gp_events[0]); i++)
			if (gp_events[i].unit_sel == (cnt->config & 0xffff))
				return &gp_events[i];
	} else
		return &fixed_events[cnt->ctr - MSR_CORE_PERF_FIXED_CTR0];

	return (void*)0;
}

static void global_enable(pmu_counter_t *cnt)
{
	cnt->idx = event_to_global_idx(cnt);

	wrmsr(MSR_CORE_PERF_GLOBAL_CTRL, rdmsr(MSR_CORE_PERF_GLOBAL_CTRL) |
			(1ull << cnt->idx));
}

static void global_disable(pmu_counter_t *cnt)
{
	wrmsr(MSR_CORE_PERF_GLOBAL_CTRL, rdmsr(MSR_CORE_PERF_GLOBAL_CTRL) &
			~(1ull << cnt->idx));
}


static void start_event(pmu_counter_t *evt)
{
    wrmsr(evt->ctr, evt->count);
    if (is_gp(evt))
	    wrmsr(MSR_P6_EVNTSEL0 + event_to_global_idx(evt),
			    evt->config | EVNTSEL_EN);
    else {
	    uint32_t ctrl = rdmsr(MSR_CORE_PERF_FIXED_CTR_CTRL);
	    int shift = (evt->ctr - MSR_CORE_PERF_FIXED_CTR0) * 4;
	    uint32_t usrospmi = 0;

	    if (evt->config & EVNTSEL_OS)
		    usrospmi |= (1 << 0);
	    if (evt->config & EVNTSEL_USR)
		    usrospmi |= (1 << 1);
	    if (evt->config & EVNTSEL_INT)
		    usrospmi |= (1 << 3); // PMI on overflow
	    ctrl = (ctrl & ~(0xf << shift)) | (usrospmi << shift);
	    wrmsr(MSR_CORE_PERF_FIXED_CTR_CTRL, ctrl);
    }
    global_enable(evt);
}

static void stop_event(pmu_counter_t *evt)
{
	global_disable(evt);
	if (is_gp(evt))
		wrmsr(MSR_P6_EVNTSEL0 + event_to_global_idx(evt),
				evt->config & ~EVNTSEL_EN);
	else {
		uint32_t ctrl = rdmsr(MSR_CORE_PERF_FIXED_CTR_CTRL);
		int shift = (evt->ctr - MSR_CORE_PERF_FIXED_CTR0) * 4;
		wrmsr(MSR_CORE_PERF_FIXED_CTR_CTRL, ctrl & ~(0xf << shift));
	}
	evt->count = rdmsr(evt->ctr);
}

static void measure(pmu_counter_t *evt, int count)
{
	int i;
	for (i = 0; i < count; i++)
		start_event(&evt[i]);
	loop();
	for (i = 0; i < count; i++)
		stop_event(&evt[i]);
}

static bool verify_event(uint64_t count, struct pmu_event *e)
{
	// printf("%lld >= %lld <= %lld\n", e->min, count, e->max);
	return count >= e->min  && count <= e->max;

}

static bool verify_counter(pmu_counter_t *cnt)
{
	return verify_event(cnt->count, get_counter_event(cnt));
}

static void check_gp_counter(struct pmu_event *evt)
{
	pmu_counter_t cnt = {
		.ctr = MSR_IA32_PERFCTR0,
		.config = EVNTSEL_OS | EVNTSEL_USR | evt->unit_sel,
	};
	int i;

	for (i = 0; i < num_counters; i++, cnt.ctr++) {
		cnt.count = 0;
		measure(&cnt, 1);
		report("%s-%d", verify_event(cnt.count, evt), evt->name, i);
	}
}

static void check_gp_counters(void)
{
	int i;

	for (i = 0; i < sizeof(gp_events)/sizeof(gp_events[0]); i++)
		if (!(ebx.full & (1 << i)))
			check_gp_counter(&gp_events[i]);
		else
			printf("GP event '%s' is disabled\n",
					gp_events[i].name);
}

static void check_fixed_counters(void)
{
	pmu_counter_t cnt = {
		.config = EVNTSEL_OS | EVNTSEL_USR,
	};
	int i;

	for (i = 0; i < edx.split.num_counters_fixed; i++) {
		cnt.count = 0;
		cnt.ctr = fixed_events[i].unit_sel;
		measure(&cnt, 1);
		report("fixed-%d", verify_event(cnt.count, &fixed_events[i]), i);
	}
}

static void check_counters_many(void)
{
	pmu_counter_t cnt[10];
	int i, n;

	for (i = 0, n = 0; n < num_counters; i++) {
		if (ebx.full & (1 << i))
			continue;

		cnt[n].count = 0;
		cnt[n].ctr = MSR_IA32_PERFCTR0 + n;
		cnt[n].config = EVNTSEL_OS | EVNTSEL_USR | gp_events[i].unit_sel;
		n++;
	}
	for (i = 0; i < edx.split.num_counters_fixed; i++) {
		cnt[n].count = 0;
		cnt[n].ctr = fixed_events[i].unit_sel;
		cnt[n].config = EVNTSEL_OS | EVNTSEL_USR;
		n++;
	}

	measure(cnt, n);

	for (i = 0; i < n; i++)
		if (!verify_counter(&cnt[i]))
			break;

	report("all counters", i == n);
}

static void check_counter_overflow(void)
{
	uint64_t count;
	int i;
	pmu_counter_t cnt = {
		.ctr = MSR_IA32_PERFCTR0,
		.config = EVNTSEL_OS | EVNTSEL_USR | gp_events[1].unit_sel /* instructions */,
		.count = 0,
	};
	measure(&cnt, 1);
	count = cnt.count;

	/* clear status before test */
	wrmsr(MSR_CORE_PERF_GLOBAL_OVF_CTRL, rdmsr(MSR_CORE_PERF_GLOBAL_STATUS));

	report_prefix_push("overflow");

	for (i = 0; i < num_counters + 1; i++, cnt.ctr++) {
		uint64_t status;
		int idx;
		if (i == num_counters)
			cnt.ctr = fixed_events[0].unit_sel;
		if (i % 2)
			cnt.config |= EVNTSEL_INT;
		else
			cnt.config &= ~EVNTSEL_INT;
		idx = event_to_global_idx(&cnt);
		cnt.count = 1 - count;
		measure(&cnt, 1);
		report("cntr-%d", cnt.count == 1, i);
		status = rdmsr(MSR_CORE_PERF_GLOBAL_STATUS);
		report("status-%d", status & (1ull << idx), i);
		wrmsr(MSR_CORE_PERF_GLOBAL_OVF_CTRL, status);
		status = rdmsr(MSR_CORE_PERF_GLOBAL_STATUS);
		report("status clear-%d", !(status & (1ull << idx)), i);
		report("irq-%d", check_irq() == (i % 2), i);
	}

	report_prefix_pop();
}

static void check_gp_counter_cmask(void)
{
	pmu_counter_t cnt = {
		.ctr = MSR_IA32_PERFCTR0,
		.config = EVNTSEL_OS | EVNTSEL_USR | gp_events[1].unit_sel /* instructions */,
		.count = 0,
	};
	cnt.config |= (0x2 << EVNTSEL_CMASK_SHIFT);
	measure(&cnt, 1);
	report("cmask", cnt.count < gp_events[1].min);
}

static void check_rdpmc(void)
{
	uint64_t val = 0x1f3456789ull;
	int i;

	report_prefix_push("rdpmc");

	for (i = 0; i < num_counters; i++) {
		uint64_t x = (val & 0xffffffff) |
			((1ull << (eax.split.bit_width - 32)) - 1) << 32;
		wrmsr(MSR_IA32_PERFCTR0 + i, val);
		report("cntr-%d", rdpmc(i) == x, i);
		report("fast-%d", rdpmc(i | (1<<31)) == (u32)val, i);
	}
	for (i = 0; i < edx.split.num_counters_fixed; i++) {
		uint64_t x = (val & 0xffffffff) |
			((1ull << (edx.split.bit_width_fixed - 32)) - 1) << 32;
		wrmsr(MSR_CORE_PERF_FIXED_CTR0 + i, val);
		report("fixed cntr-%d", rdpmc(i | (1 << 30)) == x, i);
		report("fixed fast-%d", rdpmc(i | (3<<30)) == (u32)val, i);
	}

	report_prefix_pop();
}

int main(int ac, char **av)
{
	struct cpuid id = cpuid(10);

	setup_vm();
	setup_idt();
	handle_irq(PC_VECTOR, cnt_overflow);
	buf = vmalloc(N*64);

	eax.full = id.a;
	ebx.full = id.b;
	edx.full = id.d;

	if (!eax.split.version_id) {
		printf("No pmu is detected!\n");
		return report_summary();
	}
	printf("PMU version:         %d\n", eax.split.version_id);
	printf("GP counters:         %d\n", eax.split.num_counters);
	printf("GP counter width:    %d\n", eax.split.bit_width);
	printf("Mask length:         %d\n", eax.split.mask_length);
	printf("Fixed counters:      %d\n", edx.split.num_counters_fixed);
	printf("Fixed counter width: %d\n", edx.split.bit_width_fixed);

	num_counters = eax.split.num_counters;
	if (num_counters > ARRAY_SIZE(gp_events))
		num_counters = ARRAY_SIZE(gp_events);

	apic_write(APIC_LVTPC, PC_VECTOR);

	check_gp_counters();
	check_fixed_counters();
	check_rdpmc();
	check_counters_many();
	check_counter_overflow();
	check_gp_counter_cmask();

	return report_summary();
}
