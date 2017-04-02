/* Basic PCID & INVPCID functionality test */

#include "libcflat.h"
#include "processor.h"
#include "desc.h"

#define X86_FEATURE_PCID       (1 << 17)
#define X86_FEATURE_INVPCID    (1 << 10)

struct invpcid_desc {
    unsigned long pcid : 12;
    unsigned long rsv  : 52;
    unsigned long addr : 64;
};

int write_cr0_checking(unsigned long val)
{
    asm volatile(ASM_TRY("1f")
                 "mov %0, %%cr0\n\t"
                 "1:": : "r" (val));
    return exception_vector();
}

int write_cr4_checking(unsigned long val)
{
    asm volatile(ASM_TRY("1f")
                 "mov %0, %%cr4\n\t"
                 "1:": : "r" (val));
    return exception_vector();
}

int invpcid_checking(unsigned long type, void *desc)
{
    asm volatile (ASM_TRY("1f")
                  ".byte 0x66,0x0f,0x38,0x82,0x18 \n\t" /* invpcid (%rax), %rbx */
                  "1:" : : "a" (desc), "b" (type));
    return exception_vector();
}

void test_cpuid_consistency(int pcid_enabled, int invpcid_enabled)
{
    int passed = !(!pcid_enabled && invpcid_enabled);
    report("CPUID consistency", passed);
}

void test_pcid_enabled(void)
{
    int passed = 0;
    ulong cr0 = read_cr0(), cr3 = read_cr3(), cr4 = read_cr4();

    /* try setting CR4.PCIDE, no exception expected */
    if (write_cr4_checking(cr4 | X86_CR4_PCIDE) != 0)
        goto report;

    /* try clearing CR0.PG when CR4.PCIDE=1, #GP expected */
    if (write_cr0_checking(cr0 & ~X86_CR0_PG) != GP_VECTOR)
        goto report;

    write_cr4(cr4);

    /* try setting CR4.PCIDE when CR3[11:0] != 0 , #GP expected */
    write_cr3(cr3 | 0x001);
    if (write_cr4_checking(cr4 | X86_CR4_PCIDE) != GP_VECTOR)
        goto report;
    write_cr3(cr3);

    passed = 1;

report:
    report("Test on PCID when enabled", passed);
}

void test_pcid_disabled(void)
{
    int passed = 0;
    ulong cr4 = read_cr4();

    /* try setting CR4.PCIDE, #GP expected */
    if (write_cr4_checking(cr4 | X86_CR4_PCIDE) != GP_VECTOR)
        goto report;

    passed = 1;

report:
    report("Test on PCID when disabled", passed);
}

void test_invpcid_enabled(void)
{
    int passed = 0;
    ulong cr4 = read_cr4();
    struct invpcid_desc desc;
    desc.rsv = 0;

    /* try executing invpcid when CR4.PCIDE=0, desc.pcid=0 and type=1
     * no exception expected
     */
    desc.pcid = 0;
    if (invpcid_checking(1, &desc) != 0)
        goto report;

    /* try executing invpcid when CR4.PCIDE=0, desc.pcid=1 and type=1
     * #GP expected
     */
    desc.pcid = 1;
    if (invpcid_checking(1, &desc) != GP_VECTOR)
        goto report;

    if (write_cr4_checking(cr4 | X86_CR4_PCIDE) != 0)
        goto report;

    /* try executing invpcid when CR4.PCIDE=1
     * no exception expected
     */
    desc.pcid = 10;
    if (invpcid_checking(2, &desc) != 0)
        goto report;

    passed = 1;

report:
    report("Test on INVPCID when enabled", passed);
}

void test_invpcid_disabled(void)
{
    int passed = 0;
    struct invpcid_desc desc;

    /* try executing invpcid, #UD expected */
    if (invpcid_checking(2, &desc) != UD_VECTOR)
        goto report;

    passed = 1;

report:
    report("Test on INVPCID when disabled", passed);
}

int main(int ac, char **av)
{
    struct cpuid _cpuid;
    int pcid_enabled = 0, invpcid_enabled = 0;

    setup_idt();

    _cpuid = cpuid(1);
    if (_cpuid.c & X86_FEATURE_PCID)
        pcid_enabled = 1;
    _cpuid = cpuid_indexed(7, 0);
    if (_cpuid.b & X86_FEATURE_INVPCID)
        invpcid_enabled = 1;

    test_cpuid_consistency(pcid_enabled, invpcid_enabled);

    if (pcid_enabled)
        test_pcid_enabled();
    else
        test_pcid_disabled();

    if (invpcid_enabled)
        test_invpcid_enabled();
    else
        test_invpcid_disabled();

    return report_summary();
}
