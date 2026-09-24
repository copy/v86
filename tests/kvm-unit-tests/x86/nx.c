/* NX permissions, page-fault priority, and cached executable aliases in PAE mode. */
#include "libcflat.h"
#include "asm/page.h"
#include "processor.h"
#include "desc.h"
#include "msr.h"

#define ALIAS 0x40000000UL
#define PRESENT (PT_PRESENT_MASK | PT_WRITABLE_MASK)
#define RESERVED (1ull << 62)
#define NO_FAULT (~0UL)

static uint64_t pdpt[4] __attribute__((aligned(32)));
static uint64_t identity_pd[512] __attribute__((aligned(PAGE_SIZE)));
static uint64_t alias_pd[512] __attribute__((aligned(PAGE_SIZE)));
static uint64_t alias_pt[512] __attribute__((aligned(PAGE_SIZE)));
static uint32_t legacy_pd[1024] __attribute__((aligned(PAGE_SIZE)));
static unsigned char target[2 * PAGE_SIZE] __attribute__((aligned(PAGE_SIZE)));
static jmp_buf fault_env;
static volatile unsigned long fault_error, fault_address;

static void finish_fault(void)
{
    longjmp(fault_env, 1);
}

static void page_fault(struct ex_regs *regs)
{
    fault_error = regs->error_code;
    fault_address = read_cr2();
    /* Return from the interrupt before restoring the test's stack. */
    regs->rip = (unsigned long)finish_fault;
}

static void fetch(void *address)
{
    ((void (*)(void))address)();
}

static void read_data(void *address)
{
    (void)*(volatile unsigned char *)address;
}

static void write_data(void *address)
{
    *(volatile unsigned char *)address = 0;
}

static void read_float80(void *address)
{
    for (unsigned i = 0; i < 250000; i++)
        asm volatile("fldt (%0); fstp %%st(0)" : : "r"(address) : "memory");
}

static void access_data_loop(void *address)
{
    volatile unsigned *value = address;
    for (unsigned i = 0; i < 250000; i++) {
        *value = i;
        asm volatile("incl %0" : "+m"(*value));
    }
    report("JIT data reads, writes and read-modify-writes preserve values", *value == 250000);
}

static void check_access(const char *name, void (*access)(void *),
                         unsigned long address, unsigned long expected)
{
    fault_error = NO_FAULT;
    fault_address = 0;
    if (!setjmp(fault_env))
        access((void *)address);
    report("%s (error=%lx, cr2=%lx)",
           fault_error == expected && (expected == NO_FAULT || fault_address == address),
           name, fault_error, fault_address);
}

static void map_alias(uint64_t pde_flags, uint64_t pte_flags)
{
    alias_pd[0] = (uint32_t)alias_pt | pde_flags;
    alias_pt[0] = (uint32_t)target | pte_flags;
    alias_pt[1] = (uint32_t)(target + PAGE_SIZE) | pte_flags;
    write_cr3((uint32_t)pdpt);
}

static void setup_pae(void)
{
    for (unsigned i = 0; i < 512; i++)
        identity_pd[i] = (uint64_t)i << 21 | PRESENT | PT_PAGE_SIZE_MASK;
    pdpt[0] = (uint32_t)identity_pd | PT_PRESENT_MASK;
    pdpt[1] = (uint32_t)alias_pd | PT_PRESENT_MASK;
    write_cr0(read_cr0() & ~X86_CR0_PG);
    write_cr4(read_cr4() | X86_CR4_PAE);
    write_cr3((uint32_t)pdpt);
    wrmsr(MSR_EFER, EFER_NX);
    write_cr0(read_cr0() | X86_CR0_PE | X86_CR0_PG | X86_CR0_WP);
}

static void test_nx(void)
{
    map_alias(PRESENT, PRESENT | PT64_NX_MASK);
    check_access("NX PTE allows data reads", read_data, ALIAS, NO_FAULT);
    check_access("NX PTE allows data writes", write_data, ALIAS + 32, NO_FAULT);
    check_access("NX PTE allows repeated data accesses", access_data_loop, ALIAS + 32, NO_FAULT);
    check_access("NX PTE allows 80-bit reads across pages", read_float80,
                 ALIAS + PAGE_SIZE - 4, NO_FAULT);

    /* Keep the NX alias in the TLB while the executable alias is compiled. */
    for (unsigned i = 0; i < 1000000; i++)
        fetch(target);
    check_access("compiled executable alias does not bypass NX", fetch, ALIAS, 0x11);
    check_access("NX PTE blocks instruction fetch", fetch, ALIAS, 0x11);

    map_alias(PRESENT | PT64_NX_MASK, PRESENT);
    check_access("NX PDE allows data reads", read_data, ALIAS, NO_FAULT);
    check_access("NX PDE blocks instruction fetch", fetch, ALIAS, 0x11);

    map_alias(PRESENT | PT64_NX_MASK, 0);
    check_access("absent PTE takes priority over NX PDE", fetch, ALIAS, 0x10);
    map_alias(PRESENT | PT64_NX_MASK, RESERVED | PT64_NX_MASK);
    check_access("reserved bits in absent PTE are ignored", fetch, ALIAS, 0x10);
    map_alias(PRESENT | PT64_NX_MASK, PRESENT | RESERVED);
    check_access("reserved PTE takes priority over NX PDE", fetch, ALIAS, 0x19);
    map_alias(PRESENT | RESERVED, 0);
    check_access("reserved PDE is checked before absent PTE", fetch, ALIAS, 0x19);
    map_alias(RESERVED | PT64_NX_MASK, PRESENT);
    check_access("reserved bits in absent PDE are ignored", fetch, ALIAS, 0x10);

    alias_pd[0] = ((uint32_t)target & ~(SZ_2M - 1)) |
        PRESENT | PT_PAGE_SIZE_MASK | PT64_NX_MASK;
    write_cr3((uint32_t)pdpt);
    unsigned long huge_alias = ALIAS + ((uint32_t)target & (SZ_2M - 1));
    check_access("NX huge page allows data reads", read_data, huge_alias, NO_FAULT);
    check_access("NX huge page blocks instruction fetch", fetch, huge_alias, 0x11);

    map_alias(PRESENT, PRESENT);
    check_access("clearing NX allows execution again", fetch, ALIAS, NO_FAULT);

    wrmsr(MSR_EFER, 0);
    report("EFER.NXE can be cleared", rdmsr(MSR_EFER) == 0);
    map_alias(PRESENT, PRESENT | PT64_NX_MASK);
    check_access("NX PTE is reserved without NXE on reads", read_data, ALIAS, 9);
    check_access("NX PTE is reserved without NXE on writes", write_data, ALIAS, 11);
    check_access("NX PTE is reserved without NXE on fetches", fetch, ALIAS, 9);
    map_alias(PRESENT | PT64_NX_MASK, 0);
    check_access("reserved NX PDE precedes absent PTE without NXE", fetch, ALIAS, 9);
    map_alias(PRESENT, PT64_NX_MASK);
    check_access("absent PTE without NXE clears the fetch error bit", fetch, ALIAS, 0);
    wrmsr(MSR_EFER, EFER_NX);
}

static void test_pdpte_reload(void)
{
    const unsigned flags[] = { 1 << 7 /* PGE */, X86_CR4_PSE };
    for (unsigned i = 0; i < ARRAY_SIZE(flags); i++) {
        map_alias(PRESENT, PRESENT);
        read_data((void *)ALIAS);
        pdpt[1] = 0;
        write_cr4(read_cr4() ^ flags[i]);
        check_access("CR4 change reloads PDPTEs", read_data, ALIAS, 0);
        pdpt[1] = (uint32_t)alias_pd | PT_PRESENT_MASK;
        write_cr4(read_cr4() ^ flags[i]);
        check_access("CR4 change restores PDPTE mapping", read_data, ALIAS, NO_FAULT);
    }
}

static void test_legacy_paging(void)
{
    for (unsigned i = 0; i < 16; i++)
        legacy_pd[i] = i << 22 | PRESENT | PT_PAGE_SIZE_MASK;
    write_cr0(read_cr0() & ~X86_CR0_PG);
    write_cr4((read_cr4() & ~X86_CR4_PAE) | X86_CR4_PSE);
    write_cr3((uint32_t)legacy_pd);
    write_cr0(read_cr0() | X86_CR0_PG);
    check_access("non-PAE fetch clears the fetch error bit even with NXE", fetch, ALIAS, 0);
    wrmsr(MSR_EFER, 0);
    check_access("non-PAE fetch clears the fetch error bit without NXE", fetch, ALIAS, 0);
}

int main(void)
{
    report("CPUID exposes extended address widths", cpuid(0x80000000).a >= 0x80000008);
    report("CPUID advertises NX", cpuid(0x80000001).d & (1 << 20));
    unsigned widths = cpuid(0x80000008).a;
    report("CPUID reports physical and 32-bit linear address widths",
           (widths & 0xFF) >= 32 && (widths >> 8 & 0xFF) == 32);
    setup_idt();
    handle_exception(14, page_fault);
    target[0] = 0xC3; /* ret */
    setup_pae();
    report("EFER.NXE can be set", rdmsr(MSR_EFER) == EFER_NX);
    test_nx();
    test_pdpte_reload();
    test_legacy_paging();
    return report_summary();
}
