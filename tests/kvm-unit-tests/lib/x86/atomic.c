#include <libcflat.h>
#include "atomic.h"

#ifdef __i386__

u64 atomic64_cmpxchg(atomic64_t *v, u64 old, u64 new)
{
        u32 low = new;
        u32 high = new >> 32;

        asm volatile("lock cmpxchg8b %1\n"
                     : "+A" (old),
                       "+m" (*(volatile long long *)&v->counter)
                     : "b" (low), "c" (high)
                     : "memory"
                     );

        return old;
}

#else

u64 atomic64_cmpxchg(atomic64_t *v, u64 old, u64 new)
{
        u64 ret;
        u64 _old = old;
        u64 _new = new;

        asm volatile("lock cmpxchgq %2,%1"
                     : "=a" (ret), "+m" (*(volatile long *)&v->counter)
                     : "r" (_new), "0" (_old)
                     : "memory"
                     );
        return ret;
}

#endif
