#ifndef __ASM_GENERIC_ATOMIC_H__
#define __ASM_GENERIC_ATOMIC_H__

/* From QEMU include/qemu/atomic.h */
#define atomic_fetch_inc(ptr)  __sync_fetch_and_add(ptr, 1)
#define atomic_fetch_dec(ptr)  __sync_fetch_and_add(ptr, -1)
#define atomic_fetch_add(ptr, n) __sync_fetch_and_add(ptr, n)
#define atomic_fetch_sub(ptr, n) __sync_fetch_and_sub(ptr, n)
#define atomic_fetch_and(ptr, n) __sync_fetch_and_and(ptr, n)
#define atomic_fetch_or(ptr, n) __sync_fetch_and_or(ptr, n)
#define atomic_fetch_xor(ptr, n) __sync_fetch_and_xor(ptr, n)

#define atomic_inc_fetch(ptr)  __sync_add_and_fetch(ptr, 1)
#define atomic_dec_fetch(ptr)  __sync_add_and_fetch(ptr, -1)
#define atomic_add_fetch(ptr, n) __sync_add_and_fetch(ptr, n)
#define atomic_sub_fetch(ptr, n) __sync_sub_and_fetch(ptr, n)
#define atomic_and_fetch(ptr, n) __sync_and_and_fetch(ptr, n)
#define atomic_or_fetch(ptr, n) __sync_or_and_fetch(ptr, n)
#define atomic_xor_fetch(ptr, n) __sync_xor_and_fetch(ptr, n)

#endif
