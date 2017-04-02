/*
 * Copyright (C) 2014, Red Hat Inc, Andrew Jones <drjones@redhat.com>
 *
 * This work is licensed under the terms of the GNU LGPL, version 2.
 */
#include "alloc.h"
#include "asm/spinlock.h"
#include "asm/io.h"

#define PHYS_ALLOC_NR_REGIONS	256

struct phys_alloc_region {
	phys_addr_t base;
	phys_addr_t size;
};

static struct phys_alloc_region regions[PHYS_ALLOC_NR_REGIONS];
static int nr_regions;

static struct spinlock lock;
static phys_addr_t base, top, align_min;

void phys_alloc_show(void)
{
	int i;

	spin_lock(&lock);
	printf("phys_alloc minimum alignment: 0x%" PRIx64 "\n",
		(u64)align_min);
	for (i = 0; i < nr_regions; ++i)
		printf("%016" PRIx64 "-%016" PRIx64 " [%s]\n",
			(u64)regions[i].base,
			(u64)(regions[i].base + regions[i].size - 1),
			"USED");
	printf("%016" PRIx64 "-%016" PRIx64 " [%s]\n",
		(u64)base, (u64)(top - 1), "FREE");
	spin_unlock(&lock);
}

void phys_alloc_init(phys_addr_t base_addr, phys_addr_t size)
{
	spin_lock(&lock);
	base = base_addr;
	top = base + size;
	align_min = DEFAULT_MINIMUM_ALIGNMENT;
	nr_regions = 0;
	spin_unlock(&lock);
}

void phys_alloc_set_minimum_alignment(phys_addr_t align)
{
	assert(align && !(align & (align - 1)));
	spin_lock(&lock);
	align_min = align;
	spin_unlock(&lock);
}

static phys_addr_t phys_alloc_aligned_safe(phys_addr_t size,
					   phys_addr_t align, bool safe)
{
	static bool warned = false;
	phys_addr_t addr, size_orig = size;
	u64 top_safe;

	spin_lock(&lock);

	top_safe = top;

	if (safe && sizeof(long) == 4)
		top_safe = MIN(top_safe, 1ULL << 32);

	align = MAX(align, align_min);

	addr = ALIGN(base, align);
	size += addr - base;

	if ((top_safe - base) < size) {
		printf("phys_alloc: requested=0x%" PRIx64
		       " (align=0x%" PRIx64 "), "
		       "need=0x%" PRIx64 ", but free=0x%" PRIx64 ". "
		       "top=0x%" PRIx64 ", top_safe=0x%" PRIx64 "\n",
		       (u64)size_orig, (u64)align, (u64)size, top_safe - base,
		       (u64)top, top_safe);
		spin_unlock(&lock);
		return INVALID_PHYS_ADDR;
	}

	base += size;

	if (nr_regions < PHYS_ALLOC_NR_REGIONS) {
		regions[nr_regions].base = addr;
		regions[nr_regions].size = size_orig;
		++nr_regions;
	} else if (!warned) {
		printf("WARNING: phys_alloc: No free log entries, "
		       "can no longer log allocations...\n");
		warned = true;
	}

	spin_unlock(&lock);

	return addr;
}

static phys_addr_t phys_zalloc_aligned_safe(phys_addr_t size,
					    phys_addr_t align, bool safe)
{
	phys_addr_t addr = phys_alloc_aligned_safe(size, align, safe);
	if (addr == INVALID_PHYS_ADDR)
		return addr;

	memset(phys_to_virt(addr), 0, size);
	return addr;
}

phys_addr_t phys_alloc_aligned(phys_addr_t size, phys_addr_t align)
{
	return phys_alloc_aligned_safe(size, align, false);
}

phys_addr_t phys_zalloc_aligned(phys_addr_t size, phys_addr_t align)
{
	return phys_zalloc_aligned_safe(size, align, false);
}

phys_addr_t phys_alloc(phys_addr_t size)
{
	return phys_alloc_aligned(size, align_min);
}

phys_addr_t phys_zalloc(phys_addr_t size)
{
	return phys_zalloc_aligned(size, align_min);
}

static void *early_malloc(size_t size)
{
	phys_addr_t addr = phys_alloc_aligned_safe(size, align_min, true);
	if (addr == INVALID_PHYS_ADDR)
		return NULL;

	return phys_to_virt(addr);
}

static void *early_calloc(size_t nmemb, size_t size)
{
	phys_addr_t addr = phys_zalloc_aligned_safe(nmemb * size,
						    align_min, true);
	if (addr == INVALID_PHYS_ADDR)
		return NULL;

	return phys_to_virt(addr);
}

static void early_free(void *ptr __unused)
{
}

static void *early_memalign(size_t alignment, size_t size)
{
	phys_addr_t addr;

	assert(alignment && !(alignment & (alignment - 1)));

	addr = phys_alloc_aligned_safe(size, alignment, true);
	if (addr == INVALID_PHYS_ADDR)
		return NULL;

	return phys_to_virt(addr);
}

static struct alloc_ops early_alloc_ops = {
	.malloc = early_malloc,
	.calloc = early_calloc,
	.free = early_free,
	.memalign = early_memalign,
};

struct alloc_ops *alloc_ops = &early_alloc_ops;
