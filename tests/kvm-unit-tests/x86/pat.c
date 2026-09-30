#include "libcflat.h"
#include "processor.h"
#include "desc.h"
#include "msr.h"
#include "vm.h"

static void write_pat(void *data)
{
    wrmsr(MSR_IA32_CR_PAT, *(uint64_t *)data);
}

static void flush_cache(void *address)
{
    asm volatile("clflush (%0)" : : "r"(address) : "memory");
}

static volatile unsigned long fault_error = ~0UL, fault_address;

static void page_fault(struct ex_regs *regs)
{
    fault_error = regs->error_code;
    fault_address = read_cr2();
    regs->rip += 3; /* clflush (%eax) */
}

int main(void)
{
    const uint64_t original = rdmsr(MSR_IA32_CR_PAT);
    const uint64_t value = 0x0100070605040100ull;
    uint64_t invalid;
    setup_idt();

    report("CPUID advertises PAT", cpuid(1).d & (1 << 16));
    report("PAT reset value", original == 0x0007040600070406ull);
    wrmsr(MSR_IA32_CR_PAT, value);
    report("PAT retains all eight memory types", rdmsr(MSR_IA32_CR_PAT) == value);

    invalid = (value & ~0xffull) | 2;
    report("Reserved PAT type causes #GP", test_for_exception(GP_VECTOR, write_pat, &invalid));
    report("Faulting PAT write leaves the value intact", rdmsr(MSR_IA32_CR_PAT) == value);
    invalid = value | (8ull << 56);
    report("Reserved PAT bits in the high half cause #GP", test_for_exception(GP_VECTOR, write_pat, &invalid));
    report("Faulting high-half write leaves the value intact", rdmsr(MSR_IA32_CR_PAT) == value);

    report("CPUID advertises CLFLUSH", cpuid(1).d & (1 << 19));
    flush_cache(&invalid);
    report("CLFLUSH preserves memory", invalid == (value | (8ull << 56)));

    setup_vm();
    void *page = alloc_page();
    void *alias = (void *)0x40000000;
    unsigned long *pte = install_page(current_page_table(), virt_to_phys(page), alias);
    *pte &= ~(PT_ACCESSED_MASK | PT_DIRTY_MASK | PT_WRITABLE_MASK);
    invlpg(alias);
    flush_cache(alias);
    report("CLFLUSH accepts a read-only page and sets only accessed",
           (*pte & (PT_ACCESSED_MASK | PT_DIRTY_MASK)) == PT_ACCESSED_MASK);
    *pte &= ~PT_PRESENT_MASK;
    invlpg(alias);
    handler old = handle_exception(14, page_fault);
    asm volatile("clflush (%%eax)" : : "a"(alias) : "memory");
    handle_exception(14, old);
    report("CLFLUSH faults on an absent page", fault_error != ~0UL);
    report("CLFLUSH reports a data-read page fault", fault_error == 0 && fault_address == (unsigned long)alias);

    wrmsr(MSR_IA32_CR_PAT, original);
    return report_summary();
}
