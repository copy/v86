#include "libcflat.h"
#include "smp.h"

unsigned nipis;

static void ipi_test(void *data)
{
    int n = (long)data;

    printf("ipi called, cpu %d\n", n);
    if (n != smp_id())
	printf("but wrong cpu %d\n", smp_id());
    else
        nipis++;
}

int main()
{
    int ncpus;
    int i;

    smp_init();

    ncpus = cpu_count();
    printf("found %d cpus\n", ncpus);
    for (i = 0; i < ncpus; ++i)
	on_cpu(i, ipi_test, (void *)(long)i);

    report("IPI to each CPU", nipis == ncpus);
    return report_summary();
}
