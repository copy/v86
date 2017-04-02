/* test long rmap chains */

#include "libcflat.h"
#include "fwcfg.h"
#include "vm.h"
#include "smp.h"

int main (void)
{
    int i;
    int nr_pages;
    void *target_page, *virt_addr;

    setup_vm();

    nr_pages = fwcfg_get_u64(FW_CFG_RAM_SIZE) / PAGE_SIZE;
    nr_pages -= 1000;
    target_page = alloc_page();

    virt_addr = (void *) 0xfffffa000;
    for (i = 0; i < nr_pages; i++) {
        install_page(phys_to_virt(read_cr3()), virt_to_phys(target_page),
                     virt_addr);
        virt_addr += PAGE_SIZE;
    }
    printf("created %d mappings\n", nr_pages);

    virt_addr = (void *) 0xfffffa000;
    for (i = 0; i < nr_pages; i++) {
        unsigned long *touch = virt_addr;

        *touch = 0;
        virt_addr += PAGE_SIZE;
    }
    printf("instantiated mappings\n");

    virt_addr += PAGE_SIZE;
    install_pte(phys_to_virt(read_cr3()), 1, virt_addr,
                0 | PT_PRESENT_MASK | PT_WRITABLE_MASK, target_page);

    *(unsigned long *)virt_addr = 0;
    printf("PASS\n");

    return 0;
}
