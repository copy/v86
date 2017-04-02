#include "libcflat.h"
#include "smp.h"
#include "atomic.h"
#include "processor.h"
#include "hyperv.h"
#include "vm.h"

#define MAX_CPU 4
#define TICKS_PER_SEC (1000000000 / 100)

struct hv_reference_tsc_page *hv_clock;

/*
 * Scale a 64-bit delta by scaling and multiplying by a 32-bit fraction,
 * yielding a 64-bit result.
 */
static inline u64 scale_delta(u64 delta, u64 mul_frac)
{
	u64 product, unused;

	__asm__ (
		"mul %3"
		: "=d" (product), "=a" (unused) : "1" (delta), "rm" ((u64)mul_frac) );

	return product;
}

static u64 hvclock_tsc_to_ticks(struct hv_reference_tsc_page *shadow, uint64_t tsc)
{
	u64 delta = tsc;
	return scale_delta(delta, shadow->tsc_scale) + shadow->tsc_offset;
}

/*
 * Reads a consistent set of time-base values from hypervisor,
 * into a shadow data area.
 */
static void hvclock_get_time_values(struct hv_reference_tsc_page *shadow,
				    struct hv_reference_tsc_page *page)
{
	int seq;
	do {
		seq = page->tsc_sequence;
		rmb();		/* fetch version before data */
		*shadow = *page;
		rmb();		/* test version after fetching data */
	} while (shadow->tsc_sequence != seq);
}

uint64_t hv_clock_read(void)
{
	struct hv_reference_tsc_page shadow;

	hvclock_get_time_values(&shadow, hv_clock);
	return hvclock_tsc_to_ticks(&shadow, rdtsc());
}

atomic_t cpus_left;
bool ok[MAX_CPU];
uint64_t loops[MAX_CPU];

#define iabs(x)   ((x) < 0 ? -(x) : (x))

static void hv_clock_test(void *data)
{
	int i = smp_id();
	uint64_t t = rdmsr(HV_X64_MSR_TIME_REF_COUNT);
	uint64_t end = t + 3 * TICKS_PER_SEC;
	uint64_t msr_sample = t + TICKS_PER_SEC;
	int min_delta = 123456, max_delta = -123456;
	bool got_drift = false;
	bool got_warp = false;

	ok[i] = true;
	do {
		uint64_t now = hv_clock_read();
		int delta = rdmsr(HV_X64_MSR_TIME_REF_COUNT) - now;

		min_delta = delta < min_delta ? delta : min_delta;
		if (t < msr_sample) {
			max_delta = delta > max_delta ? delta: max_delta;
		} else if (delta < 0 || delta > max_delta * 3 / 2) {
			printf("suspecting drift on CPU %d? delta = %d, acceptable [0, %d)\n", smp_id(),
			       delta, max_delta);
			ok[i] = false;
			got_drift = true;
			max_delta *= 2;
		}

		if (now < t && !got_warp) {
			printf("warp on CPU %d!\n", smp_id());
			ok[i] = false;
			got_warp = true;
			break;
		}
		t = now;
	} while(t < end);

	if (!got_drift)
		printf("delta on CPU %d was %d...%d\n", smp_id(), min_delta, max_delta);
	barrier();
	atomic_dec(&cpus_left);
}

static void check_test(int ncpus)
{
	int i;
	bool pass;

	atomic_set(&cpus_left, ncpus);
	for (i = ncpus - 1; i >= 0; i--)
		on_cpu_async(i, hv_clock_test, NULL);

	/* Wait for the end of other vcpu */
	while(atomic_read(&cpus_left))
		;

	pass = true;
	for (i = ncpus - 1; i >= 0; i--)
		pass &= ok[i];

	report("TSC reference precision test", pass);
}

static void hv_perf_test(void *data)
{
	uint64_t t = hv_clock_read();
	uint64_t end = t + 1000000000 / 100;
	uint64_t local_loops = 0;

	do {
		t = hv_clock_read();
		local_loops++;
	} while(t < end);

	loops[smp_id()] = local_loops;
	atomic_dec(&cpus_left);
}

static void perf_test(int ncpus)
{
	int i;
	uint64_t total_loops;

	atomic_set(&cpus_left, ncpus);
	for (i = ncpus - 1; i >= 0; i--)
		on_cpu_async(i, hv_perf_test, NULL);

	/* Wait for the end of other vcpu */
	while(atomic_read(&cpus_left))
		;

	total_loops = 0;
	for (i = ncpus - 1; i >= 0; i--)
		total_loops += loops[i];
	printf("iterations/sec:  %" PRId64"\n", total_loops / ncpus);
}

int main(int ac, char **av)
{
	int nerr = 0;
	int ncpus;
	struct hv_reference_tsc_page shadow;
	uint64_t tsc1, t1, tsc2, t2;
	uint64_t ref1, ref2;

	setup_vm();
	smp_init();

	hv_clock = alloc_page();
	wrmsr(HV_X64_MSR_REFERENCE_TSC, (u64)(uintptr_t)hv_clock | 1);
	report("MSR value after enabling",
	       rdmsr(HV_X64_MSR_REFERENCE_TSC) == ((u64)(uintptr_t)hv_clock | 1));

	hvclock_get_time_values(&shadow, hv_clock);
	if (shadow.tsc_sequence == 0 || shadow.tsc_sequence == 0xFFFFFFFF) {
		printf("Reference TSC page not available\n");
		exit(1);
	}

	printf("scale: %" PRIx64" offset: %" PRId64"\n", shadow.tsc_scale, shadow.tsc_offset);
	ref1 = rdmsr(HV_X64_MSR_TIME_REF_COUNT);
	tsc1 = rdtsc();
	t1 = hvclock_tsc_to_ticks(&shadow, tsc1);
	printf("refcnt %" PRId64", TSC %" PRIx64", TSC reference %" PRId64"\n",
	       ref1, tsc1, t1);

	do
		ref2 = rdmsr(HV_X64_MSR_TIME_REF_COUNT);
	while (ref2 < ref1 + 2 * TICKS_PER_SEC);

	tsc2 = rdtsc();
	t2 = hvclock_tsc_to_ticks(&shadow, tsc2);
	printf("refcnt %" PRId64" (delta %" PRId64"), TSC %" PRIx64", "
	       "TSC reference %" PRId64" (delta %" PRId64")\n",
	       ref2, ref2 - ref1, tsc2, t2, t2 - t1);

	ncpus = cpu_count();
	if (ncpus > MAX_CPU)
		ncpus = MAX_CPU;

	check_test(ncpus);
	perf_test(ncpus);

	wrmsr(HV_X64_MSR_REFERENCE_TSC, 0LL);
	report("MSR value after disabling", rdmsr(HV_X64_MSR_REFERENCE_TSC) == 0);

	return nerr > 0 ? 1 : 0;
}
