/* Simple PAE paging test. See lib/x86/vm.c for similar code which sets up
 * non-PAE paging. */

#include "fwcfg.h"
#include "asm/page.h"
#include "processor.h"

#ifdef __x86_64__
#error This test is 32-bit only.
#endif

#define HUGE_PAGE_SIZE (1UL << 21)

uint64_t pdpt[4] __attribute__((aligned(0x20)));
uint64_t page_dirs[4 * 512] __attribute__((aligned(0x1000)));
uint64_t page_tables[512 * 512] __attribute__((aligned(0x1000)));

static bool is_pae_supported(void) {
    struct cpuid c = cpuid(1);
    return c.d & (1 << 6);
}

/* Fill page directory at `pd` with huge page entries. */
static void setup_pd_huge_pages(uint64_t *pd, uint64_t start, uint64_t end) {
    uint64_t phys = start;
    for (unsigned int i = 0; i < 512; i++) {
        *pd++ = phys | PT_PRESENT_MASK | PT_WRITABLE_MASK | PT_USER_MASK |
            PT_PAGE_SIZE_MASK;

        phys += HUGE_PAGE_SIZE;
        if (phys >= end)
            return;
    }
}

/* Fill page directory at `pd` with page table entries, and use memory at `pt`
 * to create page tables. */
static void setup_pd(uint64_t *pd, uint64_t *pt, uint64_t start, uint64_t end) {
    uint64_t phys = start;
    for (unsigned int i = 0; i < 512; i++) {
        *pd++ = (uint32_t)pt | PT_PRESENT_MASK | PT_WRITABLE_MASK | PT_USER_MASK;
        for (unsigned int j = 0; j < 512; j++) {
            *pt++ = phys | PT_PRESENT_MASK | PT_WRITABLE_MASK | PT_USER_MASK;
            phys += PAGE_SIZE;
            if (phys >= end)
                return;
        }
    }
}

static void setup_mmu(void) {
    uint64_t mem_size = fwcfg_get_u64(FW_CFG_RAM_SIZE);
    if (mem_size > (1ULL << 32))
        mem_size = 1ULL << 32;

    /* Map physical memory at 0000_0000 using huge pages */
    pdpt[0] = (uint32_t)&page_dirs[0 * 512] | PT_PRESENT_MASK;
    setup_pd_huge_pages(&page_dirs[0 * 512], 0, mem_size);

    /* Map physical memory at 4000_0000 using huge pages */
    pdpt[1] = (uint32_t)&page_dirs[1 * 512] | PT_PRESENT_MASK;
    setup_pd_huge_pages(&page_dirs[1 * 512], 0, mem_size);

    /* Map physical memory at 8000_0000 using huge pages */
    pdpt[2] = (uint32_t)&page_dirs[2 * 512] | PT_PRESENT_MASK;
    setup_pd_huge_pages(&page_dirs[2 * 512], 0, mem_size);

    /* Map physical memory at C000_0000 using normal tables */
    pdpt[3] = (uint32_t)&page_dirs[3 * 512] | PT_PRESENT_MASK;
    setup_pd(&page_dirs[3 * 512], &page_tables[0], 0, mem_size);

    write_cr0(0);
    write_cr4(read_cr4() | X86_CR4_PAE);
    write_cr3((uint32_t)pdpt);
    write_cr0(X86_CR0_PG | X86_CR0_PE | X86_CR0_WP);

    printf("paging enabled\n");
}

int main(void)
{
    if (!is_pae_supported()) {
        printf("PAE not supported\n");
        return 1;
    }
    printf("PAE supported\n");
    setup_mmu();

    volatile unsigned int test;
    for (int i = 1; i < 4; i++) {
        volatile unsigned int *ptr = (unsigned int*)((uint32_t)&test + (i << 30));
        printf("writing %u to %p, and reading from %p\n", i, ptr, &test);
        *ptr = i;
        if (test != i) {
            printf("error, got %u\n", i);
            return 1;
        }
    }
    printf("everything OK\n");
    return 0;
}
