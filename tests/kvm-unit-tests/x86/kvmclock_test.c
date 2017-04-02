#include "libcflat.h"
#include "smp.h"
#include "atomic.h"
#include "processor.h"
#include "kvmclock.h"

#define DEFAULT_TEST_LOOPS 100000000L
#define DEFAULT_THRESHOLD  5L

long loops = DEFAULT_TEST_LOOPS;
long sec = 0;
long threshold = DEFAULT_THRESHOLD;

struct test_info {
        struct spinlock lock;
        u64 warps;                /* warp count */
        u64 stalls;               /* stall count */
        long long worst;          /* worst warp */
        volatile cycle_t last;    /* last cycle seen by test */
        atomic_t ncpus;           /* number of cpu in the test*/
        int check;                /* check cycle ? */
};

struct test_info ti[4];

static void wallclock_test(void *data)
{
        int *p_err = data;
        long ksec, offset;
        struct timespec ts;

        kvm_get_wallclock(&ts);
        ksec = ts.tv_sec;

        offset = ksec - sec;
        printf("Raw nanoseconds value from kvmclock: %" PRIu64 " (cpu %d)\n", kvm_clock_read(), smp_id());
        printf("Seconds get from kvmclock: %ld (cpu %d, offset: %ld)\n", ksec, smp_id(), offset);

        if (offset > threshold || offset < -threshold) {
                printf("offset too large!\n");
                (*p_err)++;
        }
}

static void kvm_clock_test(void *data)
{
        struct test_info *hv_test_info = (struct test_info *)data;
        long i, check = hv_test_info->check;

        for (i = 0; i < loops; i++){
                cycle_t t0, t1;
                long long delta;

                if (check == 0) {
                        kvm_clock_read();
                        continue;
                }

                spin_lock(&hv_test_info->lock);
                t1 = kvm_clock_read();
                t0 = hv_test_info->last;
                hv_test_info->last = kvm_clock_read();
                spin_unlock(&hv_test_info->lock);

                delta = t1 - t0;
                if (delta < 0) {
                        spin_lock(&hv_test_info->lock);
                        ++hv_test_info->warps;
                        if (delta < hv_test_info->worst){
                                hv_test_info->worst = delta;
                                printf("Worst warp %lld\n", hv_test_info->worst);
                        }
                        spin_unlock(&hv_test_info->lock);
                }
                if (delta == 0)
                        ++hv_test_info->stalls;

                if (!((unsigned long)i & 31))
                        asm volatile("rep; nop");
        }

        atomic_dec(&hv_test_info->ncpus);
}

static int cycle_test(int ncpus, int check, struct test_info *ti)
{
        int i;
        unsigned long long begin, end;

        begin = rdtsc();

        atomic_set(&ti->ncpus, ncpus);
        ti->check = check;
        for (i = ncpus - 1; i >= 0; i--)
                on_cpu_async(i, kvm_clock_test, (void *)ti);

        /* Wait for the end of other vcpu */
        while(atomic_read(&ti->ncpus))
                ;

        end = rdtsc();

        printf("Total vcpus: %d\n", ncpus);
        printf("Test  loops: %ld\n", loops);
        if (check == 1) {
                printf("Total warps:  %" PRId64 "\n", ti->warps);
                printf("Total stalls: %" PRId64 "\n", ti->stalls);
                printf("Worst warp:   %lld\n", ti->worst);
        } else
                printf("TSC cycles:  %lld\n", end - begin);

        return ti->warps ? 1 : 0;
}

int main(int ac, char **av)
{
        int nerr = 0;
        int ncpus;
        int i;

        if (ac > 1)
                loops = atol(av[1]);
        if (ac > 2)
                sec = atol(av[2]);
        if (ac > 3)
                threshold = atol(av[3]);

        smp_init();

        ncpus = cpu_count();
        if (ncpus > MAX_CPU)
                ncpus = MAX_CPU;
        for (i = 0; i < ncpus; ++i)
                on_cpu(i, kvm_clock_init, (void *)0);

        if (ac > 2) {
                printf("Wallclock test, threshold %ld\n", threshold);
                printf("Seconds get from host:     %ld\n", sec);
                for (i = 0; i < ncpus; ++i)
                        on_cpu(i, wallclock_test, &nerr);
        }

        printf("Check the stability of raw cycle ...\n");
        pvclock_set_flags(PVCLOCK_TSC_STABLE_BIT
                          | PVCLOCK_RAW_CYCLE_BIT);
        if (cycle_test(ncpus, 1, &ti[0]))
                printf("Raw cycle is not stable\n");
        else
                printf("Raw cycle is stable\n");

        pvclock_set_flags(PVCLOCK_TSC_STABLE_BIT);
        printf("Monotonic cycle test:\n");
        nerr += cycle_test(ncpus, 1, &ti[1]);

        printf("Measure the performance of raw cycle ...\n");
        pvclock_set_flags(PVCLOCK_TSC_STABLE_BIT
                          | PVCLOCK_RAW_CYCLE_BIT);
        cycle_test(ncpus, 0, &ti[2]);

        printf("Measure the performance of adjusted cycle ...\n");
        pvclock_set_flags(PVCLOCK_TSC_STABLE_BIT);
        cycle_test(ncpus, 0, &ti[3]);

        for (i = 0; i < ncpus; ++i)
                on_cpu(i, kvm_clock_clear, (void *)0);

        return nerr > 0 ? 1 : 0;
}
