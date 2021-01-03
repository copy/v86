#ifndef VM_H
#define VM_H

#include "processor.h"
#include "asm/page.h"
#include "asm/io.h"

void setup_vm();

void *vmalloc(unsigned long size);
void vfree(void *mem);
void *vmap(unsigned long long phys, unsigned long size);
void *alloc_vpage(void);
void *alloc_vpages(ulong nr);
uint64_t virt_to_phys_cr3(void *mem);

struct pte_search {
	int level;
	unsigned long *pte;
};

static inline bool found_huge_pte(struct pte_search search)
{
	return (search.level == 2 || search.level == 3) &&
	       (*search.pte & PT_PRESENT_MASK) &&
	       (*search.pte & PT_PAGE_SIZE_MASK);
}

static inline bool found_leaf_pte(struct pte_search search)
{
	return search.level == 1 || found_huge_pte(search);
}

struct pte_search find_pte_level(unsigned long *cr3, void *virt,
				 int lowest_level);
unsigned long *get_pte(unsigned long *cr3, void *virt);
unsigned long *get_pte_level(unsigned long *cr3, void *virt, int pte_level);
unsigned long *install_pte(unsigned long *cr3,
                           int pte_level,
                           void *virt,
                           unsigned long pte,
                           unsigned long *pt_page);

void *alloc_page();
void *alloc_pages(unsigned long order);
void free_page(void *page);

unsigned long *install_large_page(unsigned long *cr3,unsigned long phys,
                                  void *virt);
unsigned long *install_page(unsigned long *cr3, unsigned long phys, void *virt);
void install_pages(unsigned long *cr3, unsigned long phys, unsigned long len,
		   void *virt);
bool any_present_pages(unsigned long *cr3, void *virt, unsigned long len);

static inline void *current_page_table(void)
{
	return phys_to_virt(read_cr3());
}
#endif
