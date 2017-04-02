#ifndef _ASM_BARRIER_H_
#define _ASM_BARRIER_H_
/*
 * asm-generic/barrier.h
 *
 * Copyright (C) 2016, Red Hat Inc, Alexander Gordeev <agordeev@redhat.com>
 *
 * This work is licensed under the terms of the GNU LGPL, version 2.
 */

#ifndef mb
#define mb()	asm volatile("":::"memory")
#endif
#ifndef rmb
#define rmb()	asm volatile("":::"memory")
#endif
#ifndef wmb
#define wmb()	asm volatile("":::"memory")
#endif

#ifndef smp_mb
#define smp_mb()	mb()
#endif
#ifndef smp_rmb
#define smp_rmb()	rmb()
#endif
#ifndef smp_wmb
#define smp_wmb()	wmb()
#endif

#ifndef cpu_relax
#define cpu_relax()	asm volatile ("":::"memory")
#endif

#endif /* _ASM_BARRIER_H_ */
