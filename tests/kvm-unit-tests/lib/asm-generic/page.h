#ifndef _ASM_GENERIC_PAGE_H_
#define _ASM_GENERIC_PAGE_H_
/*
 * asm-generic/page.h
 *  adapted from the Linux kernel's include/asm-generic/page.h
 *
 * Copyright (C) 2014, Red Hat Inc, Andrew Jones <drjones@redhat.com>
 *
 * This work is licensed under the terms of the GNU LGPL, version 2.
 */

#include <linux/const.h>

#define PAGE_SHIFT		12
#define PAGE_SIZE		(_AC(1,UL) << PAGE_SHIFT)
#define PAGE_MASK		(~(PAGE_SIZE-1))

#ifndef __ASSEMBLY__

#define PAGE_ALIGN(addr)	ALIGN(addr, PAGE_SIZE)

#define __va(x)			((void *)((unsigned long) (x)))
#define __pa(x)			((unsigned long) (x))
#define virt_to_pfn(kaddr)	(__pa(kaddr) >> PAGE_SHIFT)
#define pfn_to_virt(pfn)	__va((pfn) << PAGE_SHIFT)

#endif /* !__ASSEMBLY__ */

#endif /* _ASM_GENERIC_PAGE_H_ */
