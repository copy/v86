#include "libcflat.h"
#include "desc.h"
#include "processor.h"

#ifdef __x86_64__
#define uint64_t unsigned long
#else
#define uint64_t unsigned long long
#endif

int xgetbv_checking(u32 index, u64 *result)
{
    u32 eax, edx;

    asm volatile(ASM_TRY("1f")
            ".byte 0x0f,0x01,0xd0\n\t" /* xgetbv */
            "1:"
            : "=a" (eax), "=d" (edx)
            : "c" (index));
    *result = eax + ((u64)edx << 32);
    return exception_vector();
}

int xsetbv_checking(u32 index, u64 value)
{
    u32 eax = value;
    u32 edx = value >> 32;

    asm volatile(ASM_TRY("1f")
            ".byte 0x0f,0x01,0xd1\n\t" /* xsetbv */
            "1:"
            : : "a" (eax), "d" (edx), "c" (index));
    return exception_vector();
}

int write_cr4_checking(unsigned long val)
{
    asm volatile(ASM_TRY("1f")
            "mov %0,%%cr4\n\t"
            "1:": : "r" (val));
    return exception_vector();
}

#define CPUID_1_ECX_XSAVE	    (1 << 26)
#define CPUID_1_ECX_OSXSAVE	    (1 << 27)
int check_cpuid_1_ecx(unsigned int bit)
{
    return (cpuid(1).c & bit) != 0;
}

uint64_t get_supported_xcr0(void)
{
    struct cpuid r;
    r = cpuid_indexed(0xd, 0);
    printf("eax %x, ebx %x, ecx %x, edx %x\n",
            r.a, r.b, r.c, r.d);
    return r.a + ((u64)r.d << 32);
}

#define X86_CR4_OSXSAVE			0x00040000
#define XCR_XFEATURE_ENABLED_MASK       0x00000000
#define XCR_XFEATURE_ILLEGAL_MASK       0x00000010

#define XSTATE_FP       0x1
#define XSTATE_SSE      0x2
#define XSTATE_YMM      0x4

void test_xsave(void)
{
    unsigned long cr4;
    uint64_t supported_xcr0;
    uint64_t test_bits;
    u64 xcr0;

    printf("Legal instruction testing:\n");

    supported_xcr0 = get_supported_xcr0();
    printf("Supported XCR0 bits: 0x%lx\n", supported_xcr0);

    test_bits = XSTATE_FP | XSTATE_SSE;
    report("Check minimal XSAVE required bits",
		    (supported_xcr0 & test_bits) == test_bits);

    cr4 = read_cr4();
    report("Set CR4 OSXSAVE", write_cr4_checking(cr4 | X86_CR4_OSXSAVE) == 0);
    report("Check CPUID.1.ECX.OSXSAVE - expect 1",
		    check_cpuid_1_ecx(CPUID_1_ECX_OSXSAVE));

    printf("\tLegal tests\n");
    test_bits = XSTATE_FP;
    report("\t\txsetbv(XCR_XFEATURE_ENABLED_MASK, XSTATE_FP)",
	xsetbv_checking(XCR_XFEATURE_ENABLED_MASK, test_bits) == 0);

    test_bits = XSTATE_FP | XSTATE_SSE;
    report("\t\txsetbv(XCR_XFEATURE_ENABLED_MASK, XSTATE_FP | XSTATE_SSE)",
	xsetbv_checking(XCR_XFEATURE_ENABLED_MASK, test_bits) == 0);
    report("        xgetbv(XCR_XFEATURE_ENABLED_MASK)",
	xgetbv_checking(XCR_XFEATURE_ENABLED_MASK, &xcr0) == 0);

    printf("\tIllegal tests\n");
    test_bits = 0;
    report("\t\txsetbv(XCR_XFEATURE_ENABLED_MASK, 0) - expect #GP",
	xsetbv_checking(XCR_XFEATURE_ENABLED_MASK, test_bits) == GP_VECTOR);

    test_bits = XSTATE_SSE;
    report("\t\txsetbv(XCR_XFEATURE_ENABLED_MASK, XSTATE_SSE) - expect #GP",
	xsetbv_checking(XCR_XFEATURE_ENABLED_MASK, test_bits) == GP_VECTOR);

    if (supported_xcr0 & XSTATE_YMM) {
        test_bits = XSTATE_YMM;
        report("\t\txsetbv(XCR_XFEATURE_ENABLED_MASK, XSTATE_YMM) - expect #GP",
		xsetbv_checking(XCR_XFEATURE_ENABLED_MASK, test_bits) == GP_VECTOR);

        test_bits = XSTATE_FP | XSTATE_YMM;
        report("\t\txsetbv(XCR_XFEATURE_ENABLED_MASK, XSTATE_FP | XSTATE_YMM) - expect #GP",
		xsetbv_checking(XCR_XFEATURE_ENABLED_MASK, test_bits) == GP_VECTOR);
    }

    test_bits = XSTATE_SSE;
    report("\t\txsetbv(XCR_XFEATURE_ILLEGAL_MASK, XSTATE_FP) - expect #GP",
	xsetbv_checking(XCR_XFEATURE_ILLEGAL_MASK, test_bits) == GP_VECTOR);

    test_bits = XSTATE_SSE;
    report("\t\txgetbv(XCR_XFEATURE_ILLEGAL_MASK, XSTATE_FP) - expect #GP",
	xsetbv_checking(XCR_XFEATURE_ILLEGAL_MASK, test_bits) == GP_VECTOR);

    cr4 &= ~X86_CR4_OSXSAVE;
    report("Unset CR4 OSXSAVE", write_cr4_checking(cr4) == 0);
    report("Check CPUID.1.ECX.OSXSAVE - expect 0",
	check_cpuid_1_ecx(CPUID_1_ECX_OSXSAVE) == 0);

    printf("\tIllegal tests:\n");
    test_bits = XSTATE_FP;
    report("\t\txsetbv(XCR_XFEATURE_ENABLED_MASK, XSTATE_FP) - expect #UD",
	xsetbv_checking(XCR_XFEATURE_ENABLED_MASK, test_bits) == UD_VECTOR);

    test_bits = XSTATE_FP | XSTATE_SSE;
    report("\t\txsetbv(XCR_XFEATURE_ENABLED_MASK, XSTATE_FP | XSTATE_SSE) - expect #UD",
	xsetbv_checking(XCR_XFEATURE_ENABLED_MASK, test_bits) == UD_VECTOR);

    printf("\tIllegal tests:\n");
    report("\txgetbv(XCR_XFEATURE_ENABLED_MASK) - expect #UD",
	xgetbv_checking(XCR_XFEATURE_ENABLED_MASK, &xcr0) == UD_VECTOR);
}

void test_no_xsave(void)
{
    unsigned long cr4;
    u64 xcr0;

    report("Check CPUID.1.ECX.OSXSAVE - expect 0",
	check_cpuid_1_ecx(CPUID_1_ECX_OSXSAVE) == 0);

    printf("Illegal instruction testing:\n");

    cr4 = read_cr4();
    report("Set OSXSAVE in CR4 - expect #GP",
	write_cr4_checking(cr4 | X86_CR4_OSXSAVE) == GP_VECTOR);

    report("Execute xgetbv - expect #UD",
	xgetbv_checking(XCR_XFEATURE_ENABLED_MASK, &xcr0) == UD_VECTOR);

    report("Execute xsetbv - expect #UD",
	xsetbv_checking(XCR_XFEATURE_ENABLED_MASK, 0x3) == UD_VECTOR);
}

int main(void)
{
    setup_idt();
    if (check_cpuid_1_ecx(CPUID_1_ECX_XSAVE)) {
        printf("CPU has XSAVE feature\n");
        test_xsave();
    } else {
        printf("CPU don't has XSAVE feature\n");
        test_no_xsave();
    }
    return report_summary();
}
