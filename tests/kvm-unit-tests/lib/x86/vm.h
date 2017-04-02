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

unsigned long *get_pte(unsigned long *cr3, void *virt);
unsigned long *install_pte(unsigned long *cr3,
                           int pte_level,
                           void *virt,
                           unsigned long pte,
                           unsigned long *pt_page);

void *alloc_page();
void free_page(void *page);

unsigned long *install_large_page(unsigned long *cr3,unsigned long phys,
                                  void *virt);
unsigned long *install_page(unsigned long *cr3, unsigned long phys, void *virt);

#endif
