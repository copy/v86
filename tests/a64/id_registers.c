// Reads the CPU's identification registers at EL1 (tools/cpu_contract.mjs,
// docs/arm64-virt-android16-plan.md P0.3): every encoding of the ID space
// (op0=3, op1=0, CRn=0, CRm=0-7), the cache geometry (CLIDR_EL1, CCSIDR_EL1
// per CSSELR_EL1), AIDR_EL1, CTR_EL0, DCZID_EL0, CNTFRQ_EL0, and MPIDR_EL1 of
// every core (the secondaries started with PSCI CPU_ON).
//
//   A64_ID <encoding> <value> | UNDEF esr=<ESR_EL1>
//   A64_MPIDR <core> <value>

#include <a64.h>
#include <stdio.h>

#define MRS(name) ({ uint64_t _v; __asm__ volatile("mrs %0, " name : "=r"(_v)); _v; })
#define C(m, o) case m * 8 + o: value = MRS("S3_0_C0_C" #m "_" #o); break;
#define ROW(m) C(m, 0) C(m, 1) C(m, 2) C(m, 3) C(m, 4) C(m, 5) C(m, 6) C(m, 7)

static void show(const char *name, uint64_t value, struct a64_fault *fault)
{
    if(fault && fault->taken) printf("A64_ID %s UNDEF esr=%#010lx\n", name, (unsigned long)fault->esr);
    else printf("A64_ID %s 0x%016lx\n", name, (unsigned long)value);
}

static void id_space(void)
{
    for(int m = 0; m < 8; m++)
    {
        for(int o = 0; o < 8; o++)
        {
            uint64_t value = 0;
            struct a64_fault fault;
            char name[24];
            a64_expect();
            switch(m * 8 + o) { ROW(0) ROW(1) ROW(2) ROW(3) ROW(4) ROW(5) ROW(6) ROW(7) }
            a64_caught(&fault);
            snprintf(name, sizeof name, "S3_0_C0_C%d_%d", m, o);
            show(name, value, &fault);
        }
    }
}

// (op1=1: CCSIDR_EL1 op2=0, CLIDR_EL1 op2=1, CCSIDR2_EL1 op2=2, AIDR_EL1 op2=7)
static void caches(void)
{
    struct a64_fault fault;
    uint64_t value = 0;
    show("CLIDR_EL1", MRS("clidr_el1"), 0);
    show("AIDR_EL1", MRS("aidr_el1"), 0);
    for(int level = 0; level < 3; level++)
    {
        for(int instruction = 0; instruction < 2; instruction++)
        {
            char name[24];
            int csselr = level << 1 | instruction;
            a64_write(csselr_el1, csselr);
            __asm__ volatile("isb");
            snprintf(name, sizeof name, "CCSIDR_EL1.%d", csselr);
            show(name, MRS("ccsidr_el1"), 0);
            snprintf(name, sizeof name, "CSSELR_EL1.%d", csselr);
            show(name, MRS("csselr_el1"), 0);
        }
    }
    a64_write(csselr_el1, 0);
    a64_expect();
    value = MRS("S3_1_C0_C0_2");
    a64_caught(&fault);
    show("CCSIDR2_EL1", value, &fault);
}

static volatile uint64_t mpidr[8];
static volatile int reported[8];

static void secondary(unsigned core)
{
    mpidr[core] = MRS("mpidr_el1");
    __asm__ volatile("dmb ish" ::: "memory");
    reported[core] = 1;
}

int main(int argc, char **argv)
{
    (void)argc, (void)argv;
    id_space();
    caches();
    show("CTR_EL0", MRS("ctr_el0"), 0);
    show("DCZID_EL0", MRS("dczid_el0"), 0);
    show("CNTFRQ_EL0", MRS("cntfrq_el0"), 0);
    show("FPCR", MRS("fpcr"), 0);
    show("FPSR", MRS("fpsr"), 0);
    printf("A64_MPIDR 0 0x%016lx\n", (unsigned long)MRS("mpidr_el1"));
    a64_core_main = secondary;
    for(unsigned core = 1; core < 8; core++)
    {
        int64_t started = a64_cpu_on(core);
        if(started) break; // (PSCI INVALID_PARAMETERS: no such core)
        for(unsigned long spin = 0; !reported[core]; spin++)
        {
            if(spin == 100000000ul) a64_fail("a secondary core did not report");
        }
        printf("A64_MPIDR %u 0x%016lx\n", core, (unsigned long)mpidr[core]);
    }
    printf("A64_ID_DONE\n");
    return 0;
}
