#ifndef __ATOMIC_H
#define __ATOMIC_H

#include "asm-generic/atomic.h"

typedef struct {
	volatile int counter;
} atomic_t;

#ifdef __i386__

/**
 * atomic_read - read atomic variable
 * @v: pointer of type atomic_t
 *
 * Atomically reads the value of @v.
 */
static inline int atomic_read(const atomic_t *v)
{
	return v->counter;
}

/**
 * atomic_set - set atomic variable
 * @v: pointer of type atomic_t
 * @i: required value
 *
 * Atomically sets the value of @v to @i.
 */
static inline void atomic_set(atomic_t *v, int i)
{
	v->counter = i;
}

/**
 * atomic_inc - increment atomic variable
 * @v: pointer of type atomic_t
 *
 * Atomically increments @v by 1.
 */
static inline void atomic_inc(atomic_t *v)
{
	asm volatile("lock incl %0"
		     : "+m" (v->counter));
}

/**
 * atomic_dec - decrement atomic variable
 * @v: pointer of type atomic_t
 *
 * Atomically decrements @v by 1.
 */
static inline void atomic_dec(atomic_t *v)
{
	asm volatile("lock decl %0"
		     : "+m" (v->counter));
}

typedef struct {
	u64 __attribute__((aligned(8))) counter;
} atomic64_t;

#define ATOMIC64_INIT(val)	{ (val) }

/**
 * atomic64_read - read atomic64 variable
 * @ptr:      pointer to type atomic64_t
 *
 * Atomically reads the value of @ptr and returns it.
 */
static inline u64 atomic64_read(atomic64_t *ptr)
{
	u64 res;

	/*
	 * Note, we inline this atomic64_t primitive because
	 * it only clobbers EAX/EDX and leaves the others
	 * untouched. We also (somewhat subtly) rely on the
	 * fact that cmpxchg8b returns the current 64-bit value
	 * of the memory location we are touching:
	 */
	asm volatile("mov %%ebx, %%eax\n\t"
                     "mov %%ecx, %%edx\n\t"
                     "lock cmpxchg8b %1\n"
                     : "=&A" (res)
                     : "m" (*ptr)
                     );
	return res;
}

u64 atomic64_cmpxchg(atomic64_t *v, u64 old, u64 new);

#elif defined(__x86_64__)

/**
 * atomic_read - read atomic variable
 * @v: pointer of type atomic_t
 *
 * Atomically reads the value of @v.
 */
static inline int atomic_read(const atomic_t *v)
{
	return v->counter;
}

/**
 * atomic_set - set atomic variable
 * @v: pointer of type atomic_t
 * @i: required value
 *
 * Atomically sets the value of @v to @i.
 */
static inline void atomic_set(atomic_t *v, int i)
{
	v->counter = i;
}

/**
 * atomic_inc - increment atomic variable
 * @v: pointer of type atomic_t
 *
 * Atomically increments @v by 1.
 */
static inline void atomic_inc(atomic_t *v)
{
	asm volatile("lock incl %0"
		     : "=m" (v->counter)
		     : "m" (v->counter));
}

/**
 * atomic_dec - decrement atomic variable
 * @v: pointer of type atomic_t
 *
 * Atomically decrements @v by 1.
 */
static inline void atomic_dec(atomic_t *v)
{
	asm volatile("lock decl %0"
		     : "=m" (v->counter)
		     : "m" (v->counter));
}

typedef struct {
	long long counter;
} atomic64_t;

#define ATOMIC64_INIT(i)	{ (i) }

/**
 * atomic64_read - read atomic64 variable
 * @v: pointer of type atomic64_t
 *
 * Atomically reads the value of @v.
 * Doesn't imply a read memory barrier.
 */
static inline long atomic64_read(const atomic64_t *v)
{
	return v->counter;
}

u64 atomic64_cmpxchg(atomic64_t *v, u64 old, u64 new);

#endif

#endif
