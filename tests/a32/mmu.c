// The AArch32 MMU against QEMU's cortex-a15 (docs/aarch32-plan.md R3): the
// short descriptors (sections and supersections, small and large pages,
// AP[2:0], XN and PXN, the domains, TTBCR.N and TTBR1, SCTLR.AFE's access
// flag, TEX remap and Device memory's alignment, ASIDs and TLB maintenance)
// and the long ones (LPAE: blocks and pages, AP, XN, PXN, AF, the levels'
// faults). Each probe is a privileged and an unprivileged read, write and
// execution; a fault prints its FSR and whether FAR is the address.
#include <a32.h>
#include <stdio.h>

uint32_t probe_ldr(uint32_t va), probe_ldrt(uint32_t va), probe_exec(uint32_t va);
void probe_str(uint32_t va, uint32_t value), probe_strt(uint32_t va, uint32_t value);
uint32_t run_user(void (*function)(void), uint32_t argument);
extern char probe_return[], user_returned[];

static uint32_t l1[4096] __attribute__((aligned(16384)));
static uint32_t l1b[4096] __attribute__((aligned(16384)));
static uint32_t l2[4][256] __attribute__((aligned(1024)));
static uint64_t lpae1[4] __attribute__((aligned(32)));
static uint64_t lpae2[2][512] __attribute__((aligned(4096)));
static uint64_t lpae3[512] __attribute__((aligned(4096)));

// the test memory: physical 0x41000000 up, 4 MiB
#define TEST_PA 0x41000000u

#define XN (1 << 4)
#define PXN 1
#define NG (1 << 17)
#define SECTION(pa, ap, domain, flags) \
    (((pa) & 0xFFF00000) | ((ap) & 3) << 10 | ((ap) >> 2 & 1) << 15 | (domain) << 5 | 2 | (flags))
#define TABLE(pa, domain, pxn) (((uint32_t)(pa) & 0xFFFFFC00) | (domain) << 5 | (pxn) << 2 | 1)
#define SMALL(pa, ap, flags) (((pa) & 0xFFFFF000) | ((ap) & 3) << 4 | ((ap) >> 2 & 1) << 9 | 2 | (flags))
#define LARGE(pa, ap, flags) (((pa) & 0xFFFF0000) | ((ap) & 3) << 4 | ((ap) >> 2 & 1) << 9 | 1 | (flags))

static int hook(struct a32_frame *frame, int kind)
{
    // (SVC #0xFF from User mode: back to run_user's caller)
    if(kind == A32_SVC && !(frame->cpsr & 1 << 5) && (*(volatile uint32_t *)(frame->pc - 4) & 0xFFFFFF) == 0xFF)
    {
        frame->pc = (uint32_t)user_returned;
        frame->cpsr = 0x1D3;
        return 1;
    }
    return 0;
}

static void tlb_flush(void)
{
    a32_dsb();
    a32_mcr(0, c8, c7, 0, 0);
    a32_mcr(0, c7, c5, 0, 0);
    a32_dsb();
    a32_isb();
}

static void sctlr_set(uint32_t set, uint32_t clear)
{
    a32_mcr(0, c1, c0, 0, (a32_mrc(0, c1, c0, 0) | set) & ~clear);
    a32_isb();
}

// one access's outcome: its value or "-" for a write that went through, else
// "f" and the FSR, "!" when FAR is not the address
static void outcome(char kind, uint32_t va, int faulted, uint32_t value)
{
    struct a32_fault f;
    a32_caught(&f);
    if(f.taken)
        printf(" %c:f%x%s", kind, (unsigned)f.fsr, f.far == va ? "" : "!");
    else if(faulted < 0)
        printf(" %c:-", kind);
    else
        printf(" %c:%x", kind, (unsigned)value);
}

// (code at a probe's page: offset 0x800 privileged, 0x810 User's)
static void plant_code(uint32_t pa)
{
    volatile uint32_t *code = (volatile uint32_t *)(pa + 0x800);
    code[0] = 0xE3A00077; // mov r0, #0x77
    code[1] = 0xE12FFF1E; // bx lr
    code[4] = 0xE3A00078; // mov r0, #0x78
    code[5] = 0xEF0000FF; // svc #0xff
    a32_dsb();
    a32_mcr(0, c7, c5, 0, 0);
    a32_isb();
}

static void probe(const char *name, uint32_t va)
{
    printf("%s:", name);
    a32_expect(4);
    uint32_t v = probe_ldr(va);
    outcome('r', va, 0, v);
    a32_expect(4);
    probe_str(va + 4, 0x5A5A0000 | (va >> 20));
    outcome('w', va + 4, -1, 0);
    a32_expect(4);
    v = probe_ldrt(va + 8);
    outcome('R', va + 8, 0, v);
    a32_expect(4);
    probe_strt(va + 12, 0xA5A50000 | (va >> 20));
    outcome('W', va + 12, -1, 0);
    // (execution: a prefetch abort returns to probe_exec's caller, or to run_user's)
    a32_return_pc = (uint32_t)probe_return;
    a32_expect(4);
    v = probe_exec(va + 0x800);
    outcome('x', va + 0x800, 0, v);
    a32_return_pc = (uint32_t)user_returned;
    a32_return_cpsr = 0x1D3;
    a32_expect(4);
    v = run_user((void (*)(void))(va + 0x810), 0);
    outcome('X', va + 0x810, 0, v);
    a32_return_pc = a32_return_cpsr = 0;
    printf("\n");
}

static void short_descriptors(void)
{
    // identity sections of RAM, normal write-back (TEX 001, C, B), full access, domain 0
    for(uint32_t mb = 0x400; mb < 0x480; mb++) l1[mb] = SECTION(mb << 20, 3, 0, 1 << 12 | 1 << 3 | 1 << 2);
    for(uint32_t i = 0; i < 4; i++)
    {
        uint32_t pa = TEST_PA + (i << 20);
        for(uint32_t w = 0; w < 4; w++) *(volatile uint32_t *)(pa + 4 * w) = 0x1000 * (i + 1) + w;
        plant_code(pa);
        for(uint32_t page = 1; page < 32; page++)
        {
            *(volatile uint32_t *)(pa + (page << 12)) = 0x2000 * (i + 1) + page;
            *(volatile uint32_t *)(pa + (page << 12) + 8) = 0x3000 * (i + 1) + page;
            plant_code(pa + (page << 12));
        }
    }
    // sections at 0x80000000 up (domain 1): AP 001, 010, 011 XN, 101, 110, 000, 011 PXN, 111
    const uint32_t aps[] = { 1, 2, 3, 5, 6, 0, 3, 7 };
    const uint32_t flags[] = { 0, 0, XN, 0, 0, 0, PXN, 0 };
    for(int i = 0; i < 8; i++) l1[0x800 + i] = SECTION(TEST_PA, aps[i], 1, flags[i]);
    // pages at 0x80800000 (domain 2): small AP 011, 010 XN, none, 001; large AP 011 at + 64 KiB;
    // a table with PXN at 0x80900000 (domain 2, small AP 011)
    l1[0x808] = TABLE(l2[0], 2, 0);
    l2[0][0] = SMALL(TEST_PA + 0x1000, 3, 0);
    l2[0][1] = SMALL(TEST_PA + 0x2000, 2, 1);
    l2[0][2] = 0;
    l2[0][3] = SMALL(TEST_PA + 0x4000, 1, 0);
    for(int i = 16; i < 32; i++) l2[0][i] = LARGE(TEST_PA + 0x10000, 3, 0);
    l1[0x809] = TABLE(l2[1], 2, 1);
    l2[1][0] = SMALL(TEST_PA + 0x5000, 3, 0);
    // a supersection at 0x81000000 (TEST_PA's 16 MiB: 0x41000000), domain 0
    for(int i = 0; i < 16; i++) l1[0x810 + i] = SECTION(TEST_PA, 3, 0, 1 << 18);
    tlb_flush();
    a32_mcr(0, c2, c0, 2, 0);
    a32_mcr(0, c2, c0, 0, (uint32_t)l1);
    a32_mcr(0, c3, c0, 0, 0x5); // domains 0 and 1 client, 2 none
    a32_mcr(0, c3, c0, 0, 0x15); // and 2 client
    a32_isb();
    sctlr_set(1 | 1 << 2 | 1 << 12, 0);
    printf("mmu on: sctlr %#x\n", (unsigned)a32_mrc(0, c1, c0, 0));

    probe("section ap1", 0x80000000);
    probe("section ap2", 0x80100000);
    probe("section ap3 xn", 0x80200000);
    probe("section ap5", 0x80300000);
    probe("section ap6", 0x80400000);
    probe("section ap0", 0x80500000);
    probe("section ap3 pxn", 0x80600000);
    probe("section ap7", 0x80700000);
    probe("page ap3", 0x80800000);
    probe("page ap2 xn", 0x80801000);
    probe("page none", 0x80802000);
    probe("page ap1", 0x80803000);
    probe("large page", 0x80810000);
    probe("large page + 4k", 0x80811000);
    probe("table pxn", 0x80900000);
    probe("no section", 0x80A00000);
    probe("supersection", 0x81000000);
    probe("supersection + 3m", 0x81300000);

    // the domains: 1 none, 2 manager; then 1 manager, 2 none (no TLB maintenance)
    a32_mcr(0, c3, c0, 0, 0x31);
    a32_isb();
    probe("domain 1 none", 0x80000000);
    probe("domain 2 manager, page none", 0x80802000);
    probe("domain 2 manager, page ap1", 0x80803000);
    probe("domain 2 manager, table pxn", 0x80900000);
    a32_mcr(0, c3, c0, 0, 0x0D);
    a32_isb();
    probe("domain 1 manager, ap0", 0x80500000);
    probe("domain 1 manager, xn", 0x80200000);
    probe("domain 2 none", 0x80800000);
    a32_mcr(0, c3, c0, 0, 0x15);
    a32_isb();

    // TTBCR.N 1: 0x80000000 up from TTBR1 (its own sections), then PD1
    for(uint32_t mb = 0x800; mb < 0x1000; mb++) l1b[mb] = SECTION(TEST_PA + 0x100000, 3, 0, 0);
    a32_mcr(0, c2, c0, 1, (uint32_t)l1b);
    a32_mcr(0, c2, c0, 2, 1);
    tlb_flush();
    probe("ttbr1", 0x80000000);
    probe("ttbr0 below", 0x40900000);
    a32_mcr(0, c2, c0, 2, 0);
    tlb_flush();

    // SCTLR.AFE: AP[0] the access flag (AP[2:1] the permissions)
    l1[0x80B] = SECTION(TEST_PA, 2, 1, 0);
    l1[0x80C] = SECTION(TEST_PA, 3, 1, 0);
    l2[2][0] = SMALL(TEST_PA + 0x1000, 2, 0);
    l2[2][1] = SMALL(TEST_PA + 0x2000, 3, 0);
    l2[2][2] = SMALL(TEST_PA + 0x3000, 7, 0);
    l1[0x80D] = TABLE(l2[2], 1, 0);
    tlb_flush();
    sctlr_set(1 << 29, 0);
    probe("afe section af 0", 0x80B00000);
    probe("afe section ap 01", 0x80C00000);
    probe("afe page af 0", 0x80D00000);
    probe("afe page ap 01", 0x80D01000);
    probe("afe page ap 11", 0x80D02000);
    sctlr_set(0, 1 << 29);
    tlb_flush();

    // Normal memory: unaligned loads without SCTLR.A, and with TEX remap
    // (index 7, TEX[0]:C:B, Normal). (Device memory's alignment faults: QEMU
    // has none with the short descriptors, v86 takes them, docs/arm32.md)
    l1[0x80F] = SECTION(TEST_PA, 3, 0, 1 << 12 | 1 << 3 | 1 << 2);
    tlb_flush();
    struct a32_fault f;
    uint32_t v;
    const uint32_t unaligned[] = { 0x80F00001, 0x80F00003 };
    for(int i = 0; i < 2; i++)
    {
        a32_expect(4);
        v = probe_ldr(unaligned[i]);
        a32_caught(&f);
        printf("unaligned %#x: %s %#x\n", (unsigned)unaligned[i], f.taken ? "fault" : "value", (unsigned)(f.taken ? f.fsr : v));
    }
    a32_mcr(0, c10, c2, 0, 0x000A0004 | 0xAAA8);
    a32_mcr(0, c10, c2, 1, 0x44E048E0);
    sctlr_set(1 << 28, 0);
    tlb_flush();
    for(int i = 0; i < 2; i++)
    {
        a32_expect(4);
        v = probe_ldr(unaligned[i]);
        a32_caught(&f);
        printf("tre unaligned %#x: %s %#x\n", (unsigned)unaligned[i], f.taken ? "fault" : "value", (unsigned)(f.taken ? f.fsr : v));
    }
    sctlr_set(0, 1 << 28);
    tlb_flush();

    // ASIDs: a non-global section under ASID 1 in l1, under ASID 2 in l1b
    l1[0x811] = SECTION(TEST_PA, 3, 0, NG);
    for(uint32_t mb = 0x400; mb < 0x480; mb++) l1b[mb] = l1[mb];
    l1b[0x811] = SECTION(TEST_PA + 0x200000, 3, 0, NG);
    tlb_flush();
    a32_mcr(0, c13, c0, 1, 1);
    a32_isb();
    printf("asid 1: %#x\n", (unsigned)probe_ldr(0x81100000));
    a32_mcr(0, c13, c0, 1, 2);
    a32_mcr(0, c2, c0, 0, (uint32_t)l1b);
    a32_isb();
    printf("asid 2: %#x\n", (unsigned)probe_ldr(0x81100000));
    a32_mcr(0, c13, c0, 1, 1);
    a32_mcr(0, c2, c0, 0, (uint32_t)l1);
    a32_isb();
    printf("asid 1 again: %#x\n", (unsigned)probe_ldr(0x81100000));
    // TLBIMVA: a changed descriptor after its maintenance; TLBIASID
    l1[0x811] = SECTION(TEST_PA + 0x300000, 3, 0, NG);
    a32_dsb();
    a32_mcr(0, c8, c7, 1, 0x81100000 | 1);
    a32_dsb();
    a32_isb();
    printf("after tlbimva: %#x\n", (unsigned)probe_ldr(0x81100000));
    l1[0x811] = SECTION(TEST_PA + 0x100000, 3, 0, NG);
    a32_dsb();
    a32_mcr(0, c8, c7, 2, 1);
    a32_dsb();
    a32_isb();
    printf("after tlbiasid: %#x\n", (unsigned)probe_ldr(0x81100000));
    a32_mcr(0, c13, c0, 1, 0);
    a32_isb();

    sctlr_set(0, 1 | 1 << 2 | 1 << 12);
    tlb_flush();
    printf("mmu off\n");
}

// LPAE: TTBCR.EAE, MAIR0 (attribute 0 Normal write-back, 1 Device)
#define BLOCK(pa, ap, flags) ((uint64_t)(pa) | 1 | 0 << 2 | (uint64_t)(ap) << 6 | 3 << 8 | 1 << 10 | (flags))
#define PAGE3(pa, ap, flags) ((uint64_t)(pa) | 3 | 0 << 2 | (uint64_t)(ap) << 6 | 3 << 8 | 1 << 10 | (flags))
#define LXN ((uint64_t)1 << 54)
#define LPXN ((uint64_t)1 << 53)
#define LNOAF ((uint64_t)1 << 10)

static void long_descriptors(void)
{
    // level 1: 0x40000000 (RAM) and 0x80000000 (the probes) through level 2 tables
    lpae1[0] = 0;
    lpae1[1] = (uint32_t)lpae2[0] | 3;
    lpae1[2] = (uint32_t)lpae2[1] | 3;
    lpae1[3] = 0;
    for(int i = 0; i < 512; i++) lpae2[0][i] = BLOCK(0x40000000u + (i << 21), 0, 0);
    for(int i = 0; i < 512; i++) lpae2[1][i] = 0;
    // 2 MiB blocks at 0x80000000 up: AP 00 (PL1 RW), 01 (all RW), 10 (PL1 RO), 11 (all RO), 01 XN, 01 PXN, AF 0
    const uint64_t ap[] = { 0, 1, 2, 3, 1, 1, 1 };
    const uint64_t flags[] = { 0, 0, 0, 0, LXN, LPXN, 0 };
    for(int i = 0; i < 7; i++) lpae2[1][i] = BLOCK(TEST_PA, ap[i], flags[i]);
    lpae2[1][6] &= ~LNOAF;
    // 4 KiB pages at 0x80E00000: AP 01, invalid, AP 01 AF 0
    lpae2[1][7] = (uint32_t)lpae3 | 3;
    for(int i = 0; i < 512; i++) lpae3[i] = 0;
    lpae3[0] = PAGE3(TEST_PA + 0x1000, 1, 0);
    lpae3[2] = PAGE3(TEST_PA + 0x3000, 1, 0) & ~LNOAF;
    a32_dsb();
    // MAIR0 (PRRR's register): attribute 0 0xFF, 1 0x04
    a32_mcr(0, c10, c2, 0, 0x04FF);
    a32_mcrr(0, c2, (uint64_t)(uint32_t)lpae1);
    a32_mcr(0, c2, c0, 2, 1u << 31);
    tlb_flush();
    sctlr_set(1 | 1 << 2 | 1 << 12, 0);
    printf("lpae on: ttbcr %#x\n", (unsigned)a32_mrc(0, c2, c0, 2));
    probe("lpae block ap0", 0x80000000);
    probe("lpae block ap1", 0x80200000);
    probe("lpae block ap2", 0x80400000);
    probe("lpae block ap3", 0x80600000);
    probe("lpae block xn", 0x80800000);
    probe("lpae block pxn", 0x80A00000);
    probe("lpae block af 0", 0x80C00000);
    probe("lpae page", 0x80E00000);
    probe("lpae page invalid", 0x80E01000);
    probe("lpae page af 0", 0x80E02000);
    probe("lpae level 2 invalid", 0x81000000);
    probe("lpae level 1 invalid", 0xC0000000);
    sctlr_set(0, 1 | 1 << 2 | 1 << 12);
    a32_mcr(0, c2, c0, 2, 0);
    tlb_flush();
    printf("lpae off\n");
}

int main(int argc, char **argv)
{
    a32_exception_hook = hook;
    short_descriptors();
    long_descriptors();
    return 0;
}
