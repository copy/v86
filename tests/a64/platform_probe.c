// Directed bare-metal checks of the reference's platform behaviour that the
// v86 virt machine copies (docs/arm64-virt-android16-plan.md P0.2): PSCI over
// HVC (version, features, an unknown function), HVC with a non-zero
// immediate, SMC, and loads from physical addresses with nothing mapped.
//
//   A64_PLATFORM <check> <result>

#include <a64.h>
#include <stdio.h>

static void hvc(const char *name, uint64_t function)
{
    printf("A64_PLATFORM %s %ld\n", name, (long)a64_hvc(function, 0, 0, 0));
}

static void faulting_load(const char *name, uint64_t address)
{
    struct a64_fault fault;
    uint64_t value = 0;
    a64_expect();
    __asm__ volatile("ldr %w0, [%1]" : "=r"(value) : "r"(address) : "memory");
    if(a64_caught(&fault))
    {
        printf("A64_PLATFORM %s fault esr=%#010lx far=%#lx\n", name, (unsigned long)fault.esr, (unsigned long)fault.far);
    }
    else
    {
        printf("A64_PLATFORM %s value=%#lx\n", name, (unsigned long)value);
    }
}

int main(int argc, char **argv)
{
    (void)argc, (void)argv;
    struct a64_fault fault;
    hvc("psci_version", 0x84000000);
    hvc("psci_features.cpu_on64", 0x8400000A); // (PSCI_FEATURES needs an argument; x1 = 0 here)
    printf("A64_PLATFORM psci_features.cpu_on64.arg %ld\n", (long)a64_hvc(0x8400000A, 0xC4000003, 0, 0));
    printf("A64_PLATFORM psci_features.unknown.arg %ld\n", (long)a64_hvc(0x8400000A, 0x840000FF, 0, 0));
    printf("A64_PLATFORM smccc_version %ld\n", (long)a64_hvc(0x80000000, 0, 0, 0));
    printf("A64_PLATFORM smccc_arch_features.workaround_1 %ld\n", (long)a64_hvc(0x80000001, 0x80008000, 0, 0));
    hvc("psci_unknown_function", 0x840000FF);
    hvc("smccc_unknown_function", 0xC2000000);
    a64_expect();
    int64_t imm1 = a64_hvc_imm1(0x84000000);
    if(a64_caught(&fault)) printf("A64_PLATFORM hvc_imm1 fault esr=%#010lx\n", (unsigned long)fault.esr);
    else printf("A64_PLATFORM hvc_imm1 %ld\n", (long)imm1);
    a64_expect();
    __asm__ volatile("mov x0, #0x84000000\n smc #0" ::: "x0", "x1", "x2", "x3", "memory");
    if(a64_caught(&fault)) printf("A64_PLATFORM smc fault esr=%#010lx\n", (unsigned long)fault.esr);
    else printf("A64_PLATFORM smc returned\n");
    // (the virt map: 0x0A00_0000 virtio-mmio, 0x0C00_0000 platform bus,
    // 0x0800_0000 GIC distributor; holes and the space above RAM)
    faulting_load("load_0x0a100000", 0x0A100000);
    faulting_load("load_0x09040000", 0x09040000);
    faulting_load("load_0x40000000_plus_ram", 0x40000000 + 128 * 0x100000ul);
    faulting_load("load_0x100_0000_0000", 0x10000000000ul);
    faulting_load("load_0x80_0000_0000", 0x8000000000ul);
    return 0;
}
