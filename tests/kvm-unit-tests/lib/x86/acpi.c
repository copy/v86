#include "libcflat.h"
#include "acpi.h"

void* find_acpi_table_addr(u32 sig)
{
    unsigned long addr;
    struct rsdp_descriptor *rsdp;
    struct rsdt_descriptor_rev1 *rsdt;
    void *end;
    int i;

    /* FACS is special... */
    if (sig == FACS_SIGNATURE) {
        struct fadt_descriptor_rev1 *fadt;
        fadt = find_acpi_table_addr(FACP_SIGNATURE);
        if (!fadt) {
            return NULL;
        }
        return (void*)(ulong)fadt->firmware_ctrl;
    }

    for(addr = 0xf0000; addr < 0x100000; addr += 16) {
	rsdp = (void*)addr;
	if (rsdp->signature == 0x2052545020445352LL)
          break;
    }
    if (addr == 0x100000) {
        printf("Can't find RSDP\n");
        return 0;
    }

    if (sig == RSDP_SIGNATURE) {
        return rsdp;
    }

    rsdt = (void*)(ulong)rsdp->rsdt_physical_address;
    if (!rsdt || rsdt->signature != RSDT_SIGNATURE)
        return 0;

    if (sig == RSDT_SIGNATURE) {
        return rsdt;
    }

    end = (void*)rsdt + rsdt->length;
    for (i=0; (void*)&rsdt->table_offset_entry[i] < end; i++) {
        struct acpi_table *t = (void*)(ulong)rsdt->table_offset_entry[i];
        if (t && t->signature == sig) {
            return t;
        }
    }
   return NULL;
}
