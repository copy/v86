#ifndef _ASM_X86_PAGE_H_
#define _ASM_X86_PAGE_H_
/*
 * Copyright (C) 2016, Red Hat Inc, Alexander Gordeev <agordeev@redhat.com>
 *
 * This work is licensed under the terms of the GNU LGPL, version 2.
 */


#include <linux/const.h>
#include <bitops.h>

#define PAGE_SHIFT	12
#define PAGE_SIZE	(_AC(1,UL) << PAGE_SHIFT)
#define PAGE_MASK	(~(PAGE_SIZE-1))

#ifndef __ASSEMBLY__

#ifdef __x86_64__
#define LARGE_PAGE_SIZE	(512 * PAGE_SIZE)
#else
#define LARGE_PAGE_SIZE	(1024 * PAGE_SIZE)
#endif

#define PT_PRESENT_MASK		(1ull << 0)
#define PT_WRITABLE_MASK	(1ull << 1)
#define PT_USER_MASK		(1ull << 2)
#define PT_ACCESSED_MASK	(1ull << 5)
#define PT_DIRTY_MASK		(1ull << 6)
#define PT_PAGE_SIZE_MASK	(1ull << 7)
#define PT64_NX_MASK		(1ull << 63)
#define PT_ADDR_MASK		GENMASK_ULL(51, 12)

#ifdef __x86_64__
#define	PAGE_LEVEL	4
#define	PGDIR_WIDTH	9
#define	PGDIR_MASK	511
#else
#define	PAGE_LEVEL	2
#define	PGDIR_WIDTH	10
#define	PGDIR_MASK	1023
#endif

#define PGDIR_BITS(lvl)        (((lvl) - 1) * PGDIR_WIDTH + PAGE_SHIFT)
#define PGDIR_OFFSET(va, lvl)  (((va) >> PGDIR_BITS(lvl)) & PGDIR_MASK)

#endif /* !__ASSEMBLY__ */
#endif
