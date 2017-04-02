#include "libcflat.h"
#include "processor.h"

#define CPUID_80000001_EDX_RDTSCP	    (1 << 27)
int check_cpuid_80000001_edx(unsigned int bit)
{
    return (cpuid(0x80000001).d & bit) != 0;
}


void test_wrtsc(u64 t1)
{
	u64 t2;

	wrtsc(t1);
	t2 = rdtsc();
	printf("rdtsc after wrtsc(%" PRId64 "): %" PRId64 "\n", t1, t2);
}

void test_rdtscp(u64 aux)
{
       u32 ecx;

       wrmsr(MSR_TSC_AUX, aux);
       rdtscp(&ecx);
       report("Test RDTSCP %d", ecx == aux, aux);
}

int main()
{
	u64 t1, t2;

	t1 = rdtsc();
	t2 = rdtsc();
	printf("rdtsc latency %u\n", (unsigned)(t2 - t1));

	test_wrtsc(0);
	test_wrtsc(100000000000ull);

	if (check_cpuid_80000001_edx(CPUID_80000001_EDX_RDTSCP)) {
		test_rdtscp(0);
		test_rdtscp(10);
		test_rdtscp(0x100);
	} else
		printf("rdtscp not supported\n");
	return report_summary();
}
