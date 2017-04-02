#include "libcflat.h"
#include "smp.h"
#include "atomic.h"
#include "processor.h"
#include "kvmclock.h"
#include "asm/barrier.h"

#define unlikely(x)	__builtin_expect(!!(x), 0)
#define likely(x)	__builtin_expect(!!(x), 1)


struct pvclock_vcpu_time_info __attribute__((aligned(4))) hv_clock[MAX_CPU];
struct pvclock_wall_clock wall_clock;
static unsigned char valid_flags = 0;
static atomic64_t last_value = ATOMIC64_INIT(0);

/*
 * Scale a 64-bit delta by scaling and multiplying by a 32-bit fraction,
 * yielding a 64-bit result.
 */
static inline u64 scale_delta(u64 delta, u32 mul_frac, int shift)
{
	u64 product;
#ifdef __i386__
	u32 tmp1, tmp2;
#endif

	if (shift < 0)
		delta >>= -shift;
	else
		delta <<= shift;

#ifdef __i386__
	__asm__ (
		"mul  %5       ; "
		"mov  %4,%%eax ; "
		"mov  %%edx,%4 ; "
		"mul  %5       ; "
		"xor  %5,%5    ; "
		"add  %4,%%eax ; "
		"adc  %5,%%edx ; "
		: "=A" (product), "=r" (tmp1), "=r" (tmp2)
		: "a" ((u32)delta), "1" ((u32)(delta >> 32)), "2" (mul_frac) );
#elif defined(__x86_64__)
	__asm__ (
		"mul %%rdx ; shrd $32,%%rdx,%%rax"
		: "=a" (product) : "0" (delta), "d" ((u64)mul_frac) );
#else
#error implement me!
#endif

	return product;
}

#ifdef __i386__
# define do_div(n,base) ({					\
	u32 __base = (base);    				\
	u32 __rem;						\
	__rem = ((u64)(n)) % __base;                            \
	(n) = ((u64)(n)) / __base;				\
	__rem;							\
 })
#else
u32 __attribute__((weak)) __div64_32(u64 *n, u32 base)
{
	u64 rem = *n;
	u64 b = base;
	u64 res, d = 1;
	u32 high = rem >> 32;

	/* Reduce the thing a bit first */
	res = 0;
	if (high >= base) {
		high /= base;
		res = (u64) high << 32;
		rem -= (u64) (high*base) << 32;
	}

	while ((s64)b > 0 && b < rem) {
		b = b+b;
		d = d+d;
	}

	do {
		if (rem >= b) {
			rem -= b;
			res += d;
		}
		b >>= 1;
		d >>= 1;
	} while (d);

	*n = res;
	return rem;
}

# define do_div(n,base) ({				\
	u32 __base = (base);    			\
	u32 __rem;					\
	(void)(((typeof((n)) *)0) == ((u64 *)0));	\
	if (likely(((n) >> 32) == 0)) {			\
		__rem = (u32)(n) % __base;		\
		(n) = (u32)(n) / __base;		\
	} else 						\
		__rem = __div64_32(&(n), __base);	\
	__rem;						\
 })
#endif

/**
 * set_normalized_timespec - set timespec sec and nsec parts and normalize
 *
 * @ts:		pointer to timespec variable to be set
 * @sec:	seconds to set
 * @nsec:	nanoseconds to set
 *
 * Set seconds and nanoseconds field of a timespec variable and
 * normalize to the timespec storage format
 *
 * Note: The tv_nsec part is always in the range of
 *	0 <= tv_nsec < NSEC_PER_SEC
 * For negative values only the tv_sec field is negative !
 */
void set_normalized_timespec(struct timespec *ts, long sec, s64 nsec)
{
	while (nsec >= NSEC_PER_SEC) {
		/*
		 * The following asm() prevents the compiler from
		 * optimising this loop into a modulo operation. See
		 * also __iter_div_u64_rem() in include/linux/time.h
		 */
		asm("" : "+rm"(nsec));
		nsec -= NSEC_PER_SEC;
		++sec;
	}
	while (nsec < 0) {
		asm("" : "+rm"(nsec));
		nsec += NSEC_PER_SEC;
		--sec;
	}
	ts->tv_sec = sec;
	ts->tv_nsec = nsec;
}

static inline
unsigned pvclock_read_begin(const struct pvclock_vcpu_time_info *src)
{
	unsigned version = src->version & ~1;
	/* Make sure that the version is read before the data. */
	smp_rmb();
	return version;
}

static inline
bool pvclock_read_retry(const struct pvclock_vcpu_time_info *src,
			unsigned version)
{
	/* Make sure that the version is re-read after the data. */
	smp_rmb();
	return version != src->version;
}

static inline u64 rdtsc_ordered()
{
	/*
	 * FIXME: on Intel CPUs rmb() aka lfence is sufficient which brings up
	 * to 2x speedup
	 */
	mb();
	return rdtsc();
}

static inline
cycle_t __pvclock_read_cycles(const struct pvclock_vcpu_time_info *src)
{
	u64 delta = rdtsc_ordered() - src->tsc_timestamp;
	cycle_t offset = scale_delta(delta, src->tsc_to_system_mul,
					     src->tsc_shift);
	return src->system_time + offset;
}

cycle_t pvclock_clocksource_read(struct pvclock_vcpu_time_info *src)
{
	unsigned version;
	cycle_t ret;
	u64 last;
	u8 flags;

	do {
		version = pvclock_read_begin(src);
		ret = __pvclock_read_cycles(src);
		flags = src->flags;
	} while (pvclock_read_retry(src, version));

	if ((valid_flags & PVCLOCK_RAW_CYCLE_BIT) ||
            ((valid_flags & PVCLOCK_TSC_STABLE_BIT) &&
             (flags & PVCLOCK_TSC_STABLE_BIT)))
                return ret;

	/*
	 * Assumption here is that last_value, a global accumulator, always goes
	 * forward. If we are less than that, we should not be much smaller.
	 * We assume there is an error marging we're inside, and then the correction
	 * does not sacrifice accuracy.
	 *
	 * For reads: global may have changed between test and return,
	 * but this means someone else updated poked the clock at a later time.
	 * We just need to make sure we are not seeing a backwards event.
	 *
	 * For updates: last_value = ret is not enough, since two vcpus could be
	 * updating at the same time, and one of them could be slightly behind,
	 * making the assumption that last_value always go forward fail to hold.
	 */
	last = atomic64_read(&last_value);
	do {
		if (ret < last)
			return last;
		last = atomic64_cmpxchg(&last_value, last, ret);
	} while (unlikely(last != ret));

	return ret;
}

cycle_t kvm_clock_read()
{
        struct pvclock_vcpu_time_info *src;
        cycle_t ret;
        int index = smp_id();

        src = &hv_clock[index];
        ret = pvclock_clocksource_read(src);
        return ret;
}

void kvm_clock_init(void *data)
{
        int index = smp_id();
        struct pvclock_vcpu_time_info *hvc = &hv_clock[index];

        printf("kvm-clock: cpu %d, msr %p\n", index, hvc);
        wrmsr(MSR_KVM_SYSTEM_TIME_NEW, (unsigned long)hvc | 1);
}

void kvm_clock_clear(void *data)
{
        wrmsr(MSR_KVM_SYSTEM_TIME_NEW, 0LL);
}

void pvclock_read_wallclock(struct pvclock_wall_clock *wall_clock,
			    struct pvclock_vcpu_time_info *vcpu_time,
			    struct timespec *ts)
{
	u32 version;
	u64 delta;
	struct timespec now;

	/* get wallclock at system boot */
	do {
		version = wall_clock->version;
		rmb();		/* fetch version before time */
		now.tv_sec  = wall_clock->sec;
		now.tv_nsec = wall_clock->nsec;
		rmb();		/* fetch time before checking version */
	} while ((wall_clock->version & 1) || (version != wall_clock->version));

	delta = pvclock_clocksource_read(vcpu_time);	/* time since system boot */
	delta += now.tv_sec * (u64)NSEC_PER_SEC + now.tv_nsec;

	now.tv_nsec = do_div(delta, NSEC_PER_SEC);
	now.tv_sec = delta;

	set_normalized_timespec(ts, now.tv_sec, now.tv_nsec);
}

void kvm_get_wallclock(struct timespec *ts)
{
        struct pvclock_vcpu_time_info *vcpu_time;
        int index = smp_id();

        wrmsr(MSR_KVM_WALL_CLOCK_NEW, (unsigned long)&wall_clock);
        vcpu_time = &hv_clock[index];
        pvclock_read_wallclock(&wall_clock, vcpu_time, ts);
}

void pvclock_set_flags(unsigned char flags)
{
        valid_flags = flags;
}
