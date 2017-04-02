#include "libcflat.h"
#include "desc.h"

int test_ud2(bool *rflags_rf)
{
    asm volatile(ASM_TRY("1f")
                 "ud2 \n\t"
                 "1:" :);
    *rflags_rf = exception_rflags_rf();
    return exception_vector();
}

int test_gp(bool *rflags_rf)
{
    unsigned long tmp;

    asm volatile("mov $0xffffffff, %0 \n\t"
                 ASM_TRY("1f")
		 "mov %0, %%cr4\n\t"
                 "1:"
                 : "=a"(tmp));
    *rflags_rf = exception_rflags_rf();
    return exception_vector();
}

int main(void)
{
    int r;
    bool rflags_rf;

    printf("Starting IDT test\n");
    setup_idt();
    r = test_gp(&rflags_rf);
    report("Testing #GP", r == GP_VECTOR);
    report("Testing #GP rflags.rf", rflags_rf);
    r = test_ud2(&rflags_rf);
    report("Testing #UD", r == UD_VECTOR);
    report("Testing #UD rflags.rf", rflags_rf);

    return report_summary();
}
