#include "libcflat.h"
#include "x86/desc.h"
#include "x86/processor.h"
#include "x86/vm.h"
#include "x86/msr.h"

#define X86_FEATURE_PKU  3
#define CR0_WP_MASK      (1UL << 16)
#define PTE_PKEY_BIT     59
#define USER_BASE        (1 << 24)
#define USER_VAR(v)      (*((__typeof__(&(v))) (((unsigned long)&v) + USER_BASE)))

volatile int pf_count = 0;
volatile unsigned save;
volatile unsigned test;

void set_cr0_wp(int wp)
{
    unsigned long cr0 = read_cr0();

    cr0 &= ~CR0_WP_MASK;
    if (wp)
        cr0 |= CR0_WP_MASK;
    write_cr0(cr0);
}

void do_pf_tss(unsigned long error_code)
{
    pf_count++;
    save = test;
    write_pkru(0);
}

extern void pf_tss(void);

asm ("pf_tss: \n\t"
#ifdef __x86_64__
    // no task on x86_64, save/restore caller-save regs
    "push %rax; push %rcx; push %rdx; push %rsi; push %rdi\n"
    "push %r8; push %r9; push %r10; push %r11\n"
#endif
    "call do_pf_tss \n\t"
#ifdef __x86_64__
    "pop %r11; pop %r10; pop %r9; pop %r8\n"
    "pop %rdi; pop %rsi; pop %rdx; pop %rcx; pop %rax\n"
#endif
    "add $"S", %"R "sp\n\t" // discard error code
    "iret"W" \n\t"
    "jmp pf_tss\n\t"
    );

static void init_test()
{
    pf_count = 0;

    invlpg(&test);
    invlpg(&USER_VAR(test));
    write_pkru(0);
    set_cr0_wp(0);
}

int main(int ac, char **av)
{
    unsigned long i;
    unsigned int pkey = 0x2;
    unsigned int pkru_ad = 0x10;
    unsigned int pkru_wd = 0x20;

    if (!(cpuid_indexed(7, 0).c & (1 << X86_FEATURE_PKU))) {
        printf("PKU not enabled\n");
        return report_summary();
    }

    setup_vm();
    setup_alt_stack();
    set_intr_alt_stack(14, pf_tss);
    wrmsr(MSR_EFER, rdmsr(MSR_EFER) | EFER_LMA);

    for (i = 0; i < USER_BASE; i += PAGE_SIZE) {
        *get_pte(phys_to_virt(read_cr3()), phys_to_virt(i)) &= ~PT_USER_MASK;
        *get_pte(phys_to_virt(read_cr3()), phys_to_virt(i)) |= ((unsigned long)pkey << PTE_PKEY_BIT);
        invlpg((void *)i);
    }

    for (i = USER_BASE; i < 2 * USER_BASE; i += PAGE_SIZE) {
        *get_pte(phys_to_virt(read_cr3()), phys_to_virt(i)) &= ~USER_BASE;
        *get_pte(phys_to_virt(read_cr3()), phys_to_virt(i)) |= ((unsigned long)pkey << PTE_PKEY_BIT);
        invlpg((void *)i);
    }

    write_cr4(read_cr4() | X86_CR4_PKE);
    write_cr3(read_cr3());

    init_test();
    set_cr0_wp(1);
    write_pkru(pkru_ad);
    test = 21;
    report("write to supervisor page when pkru is ad and wp == 1", pf_count == 0 && test == 21);

    init_test();
    set_cr0_wp(0);
    write_pkru(pkru_ad);
    test = 22;
    report("write to supervisor page when pkru is ad and wp == 0", pf_count == 0 && test == 22);

    init_test();
    set_cr0_wp(1);
    write_pkru(pkru_wd);
    test = 23;
    report("write to supervisor page when pkru is wd and wp == 1", pf_count == 0 && test == 23);

    init_test();
    set_cr0_wp(0);
    write_pkru(pkru_wd);
    test = 24;
    report("write to supervisor page when pkru is wd and wp == 0", pf_count == 0 && test == 24);

    init_test();
    write_pkru(pkru_wd);
    set_cr0_wp(0);
    USER_VAR(test) = 25;
    report("write to user page when pkru is wd and wp == 0", pf_count == 0 && test == 25);

    init_test();
    write_pkru(pkru_wd);
    set_cr0_wp(1);
    USER_VAR(test) = 26;
    report("write to user page when pkru is wd and wp == 1", pf_count == 1 && test == 26 && save == 25);

    init_test();
    write_pkru(pkru_ad);
    (void)USER_VAR(test);
    report("read from user page when pkru is ad", pf_count == 1 && save == 26);

    // TODO: implicit kernel access from ring 3 (e.g. int)

    return report_summary();
}
