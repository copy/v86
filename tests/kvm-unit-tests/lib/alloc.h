#ifndef _ALLOC_H_
#define _ALLOC_H_
/*
 * alloc supplies three ingredients to the test framework that are all
 * related to the support of dynamic memory allocation.
 *
 * The first is a set of alloc function wrappers for malloc and its
 * friends. Using wrappers allows test code and common code to use the
 * same interface for memory allocation at all stages, even though the
 * implementations may change with the stage, e.g. pre/post paging.
 *
 * The second is a set of implementations for the alloc function
 * interfaces. These implementations are named early_*, as they can be
 * used almost immediately by the test framework.
 *
 * The third is a very simple physical memory allocator, which the
 * early_* alloc functions build on.
 *
 * Copyright (C) 2014, Red Hat Inc, Andrew Jones <drjones@redhat.com>
 *
 * This work is licensed under the terms of the GNU LGPL, version 2.
 */
#include "libcflat.h"

struct alloc_ops {
	void *(*malloc)(size_t size);
	void *(*calloc)(size_t nmemb, size_t size);
	void (*free)(void *ptr);
	void *(*memalign)(size_t alignment, size_t size);
};

/*
 * alloc_ops is initialized to early_alloc_ops
 */
extern struct alloc_ops *alloc_ops;

static inline void *malloc(size_t size)
{
	assert(alloc_ops && alloc_ops->malloc);
	return alloc_ops->malloc(size);
}

static inline void *calloc(size_t nmemb, size_t size)
{
	assert(alloc_ops && alloc_ops->calloc);
	return alloc_ops->calloc(nmemb, size);
}

static inline void free(void *ptr)
{
	assert(alloc_ops && alloc_ops->free);
	alloc_ops->free(ptr);
}

static inline void *memalign(size_t alignment, size_t size)
{
	assert(alloc_ops && alloc_ops->memalign);
	return alloc_ops->memalign(alignment, size);
}

/*
 * phys_alloc is a very simple allocator which allows physical memory
 * to be partitioned into regions until all memory is allocated.
 *
 * Note: This is such a simple allocator that there is no way to free
 * a region. For more complicated memory management a single region
 * can be allocated, but then have its memory managed by a more
 * sophisticated allocator, e.g. a page allocator.
 */
#define DEFAULT_MINIMUM_ALIGNMENT 32

/*
 * phys_alloc_init creates the initial free memory region of size @size
 * at @base. The minimum alignment is set to DEFAULT_MINIMUM_ALIGNMENT.
 */
extern void phys_alloc_init(phys_addr_t base, phys_addr_t size);

/*
 * phys_alloc_set_minimum_alignment sets the minimum alignment to
 * @align.
 */
extern void phys_alloc_set_minimum_alignment(phys_addr_t align);

/*
 * phys_alloc_aligned returns the base address of a region of size @size,
 * where the address is aligned to @align, or INVALID_PHYS_ADDR if there
 * isn't enough free memory to satisfy the request.
 */
extern phys_addr_t phys_alloc_aligned(phys_addr_t size, phys_addr_t align);

/*
 * phys_zalloc_aligned is like phys_alloc_aligned, but zeros the memory
 * before returning the address.
 */
extern phys_addr_t phys_zalloc_aligned(phys_addr_t size, phys_addr_t align);

/*
 * phys_alloc returns the base address of a region of size @size, or
 * INVALID_PHYS_ADDR if there isn't enough free memory to satisfy the
 * request.
 */
extern phys_addr_t phys_alloc(phys_addr_t size);

/*
 * phys_zalloc is like phys_alloc, but zeros the memory before returning.
 */
extern phys_addr_t phys_zalloc(phys_addr_t size);

/*
 * phys_alloc_show outputs all currently allocated regions with the
 * following format
 *   <start_addr>-<end_addr> [<USED|FREE>]
 */
extern void phys_alloc_show(void);

#endif /* _ALLOC_H_ */
