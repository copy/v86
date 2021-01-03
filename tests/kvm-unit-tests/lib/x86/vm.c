#include "fwcfg.h"
#include "vm.h"
#include "libcflat.h"

static void *free = 0;
static void *vfree_top = 0;

static void free_memory(void *mem, unsigned long size)
{
	void *end;

	assert_msg((unsigned long) mem % PAGE_SIZE == 0,
		   "mem not page aligned: %p", mem);

	assert_msg(size % PAGE_SIZE == 0, "size not page aligned: %#lx", size);

	assert_msg(size == 0 || mem + size > mem,
		   "mem + size overflow: %p + %#lx", mem, size);

	if (size == 0) {
		free = NULL;
		return;
	}

	free = mem;
	end = mem + size;
	while (mem + PAGE_SIZE != end) {
		*(void **)mem = (mem + PAGE_SIZE);
		mem += PAGE_SIZE;
	}

	*(void **)mem = NULL;
}

void *alloc_page()
{
    void *p;

    if (!free)
	return 0;

    p = free;
    free = *(void **)free;

    return p;
}

/*
 * Allocates (1 << order) physically contiguous and naturally aligned pages.
 * Returns NULL if there's no memory left.
 */
void *alloc_pages(unsigned long order)
{
	/* Generic list traversal. */
	void *prev;
	void *curr = NULL;
	void *next = free;

	/* Looking for a run of length (1 << order). */
	unsigned long run = 0;
	const unsigned long n = 1ul << order;
	const unsigned long align_mask = (n << PAGE_SHIFT) - 1;
	void *run_start = NULL;
	void *run_prev = NULL;
	unsigned long run_next_pa = 0;
	unsigned long pa;

	assert(order < sizeof(unsigned long) * 8);

	for (;;) {
		prev = curr;
		curr = next;
		next = curr ? *((void **) curr) : NULL;

		if (!curr)
			return 0;

		pa = virt_to_phys(curr);

		if (run == 0) {
			if (!(pa & align_mask)) {
				run_start = curr;
				run_prev = prev;
				run_next_pa = pa + PAGE_SIZE;
				run = 1;
			}
		} else if (pa == run_next_pa) {
			run_next_pa += PAGE_SIZE;
			run += 1;
		} else {
			run = 0;
		}

		if (run == n) {
			if (run_prev)
				*((void **) run_prev) = next;
			else
				free = next;
			return run_start;
		}
	}
}


void free_page(void *page)
{
    *(void **)page = free;
    free = page;
}

extern char edata;
static unsigned long end_of_memory;

unsigned long *install_pte(unsigned long *cr3,
			   int pte_level,
			   void *virt,
			   unsigned long pte,
			   unsigned long *pt_page)
{
    int level;
    unsigned long *pt = cr3;
    unsigned offset;

    for (level = PAGE_LEVEL; level > pte_level; --level) {
	offset = PGDIR_OFFSET((unsigned long)virt, level);
	if (!(pt[offset] & PT_PRESENT_MASK)) {
	    unsigned long *new_pt = pt_page;
            if (!new_pt)
                new_pt = alloc_page();
            else
                pt_page = 0;
	    memset(new_pt, 0, PAGE_SIZE);
	    pt[offset] = virt_to_phys(new_pt) | PT_PRESENT_MASK | PT_WRITABLE_MASK | PT_USER_MASK;
	}
	pt = phys_to_virt(pt[offset] & PT_ADDR_MASK);
    }
    offset = PGDIR_OFFSET((unsigned long)virt, level);
    pt[offset] = pte;
    return &pt[offset];
}

/*
 * Finds last PTE in the mapping of @virt that's at or above @lowest_level. The
 * returned PTE isn't necessarily present, but its parent is.
 */
struct pte_search find_pte_level(unsigned long *cr3, void *virt,
				 int lowest_level)
{
	unsigned long *pt = cr3, pte;
	unsigned offset;
	unsigned long shift;
	struct pte_search r;

	assert(lowest_level >= 1 && lowest_level <= PAGE_LEVEL);

	for (r.level = PAGE_LEVEL;; --r.level) {
		shift = (r.level - 1) * PGDIR_WIDTH + 12;
		offset = ((unsigned long)virt >> shift) & PGDIR_MASK;
		r.pte = &pt[offset];
		pte = *r.pte;

		if (!(pte & PT_PRESENT_MASK))
			return r;

		if ((r.level == 2 || r.level == 3) && (pte & PT_PAGE_SIZE_MASK))
			return r;

		if (r.level == lowest_level)
			return r;

		pt = phys_to_virt(pte & 0xffffffffff000ull);
	}
}

/*
 * Returns the leaf PTE in the mapping of @virt (i.e., 4K PTE or a present huge
 * PTE). Returns NULL if no leaf PTE exists.
 */
unsigned long *get_pte(unsigned long *cr3, void *virt)
{
	struct pte_search search;

	search = find_pte_level(cr3, virt, 1);
	return found_leaf_pte(search) ? search.pte : NULL;
}

/*
 * Returns the PTE in the mapping of @virt at the given level @pte_level.
 * Returns NULL if the PT at @pte_level isn't present (i.e., the mapping at
 * @pte_level - 1 isn't present).
 */
unsigned long *get_pte_level(unsigned long *cr3, void *virt, int pte_level)
{
	struct pte_search search;

	search = find_pte_level(cr3, virt, pte_level);
	return search.level == pte_level ? search.pte : NULL;
}

unsigned long *install_large_page(unsigned long *cr3,
				  unsigned long phys,
				  void *virt)
{
    return install_pte(cr3, 2, virt,
		       phys | PT_PRESENT_MASK | PT_WRITABLE_MASK | PT_USER_MASK | PT_PAGE_SIZE_MASK, 0);
}

unsigned long *install_page(unsigned long *cr3,
			    unsigned long phys,
			    void *virt)
{
    return install_pte(cr3, 1, virt, phys | PT_PRESENT_MASK | PT_WRITABLE_MASK | PT_USER_MASK, 0);
}

void install_pages(unsigned long *cr3, unsigned long phys, unsigned long len,
		   void *virt)
{
	unsigned long max = (u64)len + (u64)phys;
	assert(phys % PAGE_SIZE == 0);
	assert((unsigned long) virt % PAGE_SIZE == 0);
	assert(len % PAGE_SIZE == 0);

	while (phys + PAGE_SIZE <= max) {
		install_page(cr3, phys, virt);
		phys += PAGE_SIZE;
		virt = (char *) virt + PAGE_SIZE;
	}
}

bool any_present_pages(unsigned long *cr3, void *virt, unsigned long len)
{
	unsigned long max = (unsigned long) virt + len;
	unsigned long curr;

	for (curr = (unsigned long) virt; curr < max; curr += PAGE_SIZE) {
		unsigned long *ptep = get_pte(cr3, (void *) curr);
		if (ptep && (*ptep & PT_PRESENT_MASK))
			return true;
	}
	return false;
}

static void setup_mmu_range(unsigned long *cr3, unsigned long start,
			    unsigned long len)
{
	u64 max = (u64)len + (u64)start;
	u64 phys = start;

	while (phys + LARGE_PAGE_SIZE <= max) {
		install_large_page(cr3, phys, (void *)(ulong)phys);
		phys += LARGE_PAGE_SIZE;
	}
	install_pages(cr3, phys, max - phys, (void *)(ulong)phys);
}

static void setup_mmu(unsigned long len)
{
    unsigned long *cr3 = alloc_page();

    memset(cr3, 0, PAGE_SIZE);

#ifdef __x86_64__
    if (len < (1ul << 32))
        len = (1ul << 32);  /* map mmio 1:1 */

    setup_mmu_range(cr3, 0, len);
#else
    if (len > (1ul << 31))
	    len = (1ul << 31);

    /* 0 - 2G memory, 2G-3G valloc area, 3G-4G mmio */
    setup_mmu_range(cr3, 0, len);
    setup_mmu_range(cr3, 3ul << 30, (1ul << 30));
    vfree_top = (void*)(3ul << 30);
#endif

    write_cr3(virt_to_phys(cr3));
#ifndef __x86_64__
    write_cr4(X86_CR4_PSE);
#endif
    write_cr0(X86_CR0_PG |X86_CR0_PE | X86_CR0_WP);

    printf("paging enabled\n");
    printf("cr0 = %lx\n", read_cr0());
    printf("cr3 = %lx\n", read_cr3());
    printf("cr4 = %lx\n", read_cr4());
}

void setup_vm()
{
    assert(!end_of_memory);
    end_of_memory = fwcfg_get_u64(FW_CFG_RAM_SIZE);
    free_memory(&edata, end_of_memory - (unsigned long)&edata);
    setup_mmu(end_of_memory);
}

void *vmalloc(unsigned long size)
{
    void *mem, *p;
    unsigned pages;

    size += sizeof(unsigned long);

    size = (size + PAGE_SIZE - 1) & ~(PAGE_SIZE - 1);
    vfree_top -= size;
    mem = p = vfree_top;
    pages = size / PAGE_SIZE;
    while (pages--) {
	install_page(phys_to_virt(read_cr3()), virt_to_phys(alloc_page()), p);
	p += PAGE_SIZE;
    }
    *(unsigned long *)mem = size;
    mem += sizeof(unsigned long);
    return mem;
}

uint64_t virt_to_phys_cr3(void *mem)
{
    return (*get_pte(phys_to_virt(read_cr3()), mem) & PT_ADDR_MASK) + ((ulong)mem & (PAGE_SIZE - 1));
}

void vfree(void *mem)
{
    unsigned long size = ((unsigned long *)mem)[-1];

    while (size) {
	free_page(phys_to_virt(*get_pte(phys_to_virt(read_cr3()), mem) & PT_ADDR_MASK));
	mem += PAGE_SIZE;
	size -= PAGE_SIZE;
    }
}

void *vmap(unsigned long long phys, unsigned long size)
{
    void *mem, *p;
    unsigned pages;

    size = (size + PAGE_SIZE - 1) & ~(PAGE_SIZE - 1);
    vfree_top -= size;
    phys &= ~(unsigned long long)(PAGE_SIZE - 1);

    mem = p = vfree_top;
    pages = size / PAGE_SIZE;
    while (pages--) {
	install_page(phys_to_virt(read_cr3()), phys, p);
	phys += PAGE_SIZE;
	p += PAGE_SIZE;
    }
    return mem;
}

void *alloc_vpages(ulong nr)
{
	vfree_top -= PAGE_SIZE * nr;
	return vfree_top;
}

void *alloc_vpage(void)
{
    return alloc_vpages(1);
}
