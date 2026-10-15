// The A64 page tier's access cache across ASIDs (tests/a64/asid.mjs;
// docs/jit-unification-plan.md P6.4, a64_asid_tag): one VA mapped non-global
// to a different page under each of 20 ASIDs (16-bit), switched with TTBR0
// writes and no TLBI; remaps of a non-running ASID's page with TLBI VAE1 and
// ASIDE1; a global page in the lower half invalidated through another ASID;
// more ASIDs than the tier keeps epochs for. A hot loop reads and writes the
// page each time; the sums and the pages' contents are printed.
#include <a64.h>
#include <stdio.h>
#include <stdint.h>

#define TEST_VA 0x1000000000UL // (L1 index 64, L2 index 0, L3 index 0)
#define GLOBAL_VA (TEST_VA + 0x1000)
#define ROOTS 20
#define PAGES 24

static uint64_t l1[ROOTS][512] __attribute__((aligned(4096)));
static uint64_t l2[ROOTS][512] __attribute__((aligned(4096)));
static uint64_t l3[ROOTS][512] __attribute__((aligned(4096)));
static uint64_t data[PAGES][512] __attribute__((aligned(4096)));

static uint64_t page(int k, int global)
{
    return (uint64_t)data[k] | 3 | 1UL << 10 | 3UL << 8 | (global ? 0 : 1UL << 11);
}
static void barrier(void) { __asm__ volatile("dsb ish\n isb" ::: "memory"); }
static void use_root(int r, unsigned asid)
{
    a64_write(ttbr0_el1, (uint64_t)l1[r] | (uint64_t)asid << 48);
    __asm__ volatile("isb" ::: "memory");
}
static void tlbi_va(uint64_t va, unsigned asid)
{
    __asm__ volatile("dsb ishst\n tlbi vae1, %0\n dsb ish\n isb" :: "r"(va >> 12 | (uint64_t)asid << 48) : "memory");
}
static void tlbi_asid(unsigned asid)
{
    __asm__ volatile("dsb ishst\n tlbi aside1, %0\n dsb ish\n isb" :: "r"((uint64_t)asid << 48) : "memory");
}
static uint64_t __attribute__((noinline)) hot(uint64_t va, int rounds)
{
    volatile uint64_t *p = (volatile uint64_t *)va;
    uint64_t sum = 0;
    for(int i = 0; i < rounds; i++)
    {
        sum += p[i & 63] * (i | 1);
        p[(i * 7) & 63] += i;
    }
    return sum;
}

int main(int argc, char **argv)
{
    for(int k = 0; k < PAGES; k++) for(int i = 0; i < 512; i++) data[k][i] = k * 1000 + i;
    for(int r = 0; r < ROOTS; r++)
    {
        l1[r][0] = 0x00000000UL | 1 | 1 << 2 | 1 << 10;
        l1[r][1] = 0x40000000UL | 1 | 3 << 8 | 1 << 10;
        l1[r][2] = 0x80000000UL | 1 | 3 << 8 | 1 << 10;
        l1[r][64] = (uint64_t)l2[r] | 3;
        l2[r][0] = (uint64_t)l3[r] | 3;
        l3[r][0] = page(r, 0);
        l3[r][1] = page(22, 1);
    }
    barrier();
    a64_write(mair_el1, 0x00FF);
    // (T0SZ 25, write-back inner shareable walks, 4 KiB, no TTBR1 walks, 40-bit PA, 16-bit ASIDs)
    a64_write(tcr_el1, 25 | 1 << 8 | 1 << 10 | 3 << 12 | 1 << 23 | 2UL << 32 | 1UL << 36);
    use_root(0, 1);
    __asm__ volatile("dsb ish\n tlbi vmalle1\n dsb ish\n isb" ::: "memory");
    a64_write(sctlr_el1, a64_read(sctlr_el1) | 1 | 1 << 2 | 1 << 12);
    __asm__ volatile("isb" ::: "memory");

    const int N = 3000;
    // ASIDs switched back and forth, no TLBI
    use_root(0, 1); printf("1: %lx\n", hot(TEST_VA, N));
    use_root(1, 2); printf("2: %lx\n", hot(TEST_VA, N));
    use_root(0, 1); printf("1 again: %lx\n", hot(TEST_VA, N));
    use_root(1, 2); printf("2 again: %lx\n", hot(TEST_VA, N));
    // ASID 1's page remapped while ASID 2 runs, which does not touch it (so
    // that ASID 1's entry is still in its slot): TLBI VAE1 for ASID 1
    use_root(0, 1); printf("1 before: %lx\n", hot(TEST_VA, N));
    use_root(1, 2);
    l3[0][0] = page(20, 0);
    tlbi_va(TEST_VA, 1);
    use_root(0, 1); printf("1 remapped: %lx\n", hot(TEST_VA, N));
    // ASID 2's page remapped while ASID 1 runs, untouched: TLBI ASIDE1 for ASID 2
    use_root(1, 2); printf("2 before: %lx\n", hot(TEST_VA, N));
    use_root(0, 1);
    l3[1][0] = page(21, 0);
    tlbi_asid(2);
    use_root(1, 2); printf("2 remapped: %lx\n", hot(TEST_VA, N));
    // a global page in the lower half, read under ASID 1; remapped in every
    // table while ASID 2 runs, untouched, and invalidated by VA for ASID 2
    // (which a global translation matches too)
    use_root(0, 1); printf("global 1: %lx\n", hot(GLOBAL_VA, N));
    use_root(1, 2);
    for(int r = 0; r < ROOTS; r++) l3[r][1] = page(23, 1);
    tlbi_va(GLOBAL_VA, 2);
    use_root(0, 1); printf("global 1 remapped: %lx\n", hot(GLOBAL_VA, N));
    use_root(1, 2); printf("global 2: %lx\n", hot(GLOBAL_VA, N));
    // more ASIDs than the page tier keeps epochs for, three times around
    for(int round = 0; round < 3; round++)
    {
        uint64_t sum = 0;
        for(int r = 0; r < ROOTS; r++)
        {
            use_root(r, 0x100 + r * 0x111);
            sum = sum * 31 + hot(TEST_VA, N / 10);
        }
        printf("round %d: %lx\n", round, sum);
    }
    uint64_t check = 0;
    for(int k = 0; k < PAGES; k++) for(int i = 0; i < 512; i++) check = check * 131 + data[k][i];
    printf("pages: %lx\n", check);
    return 0;
}
