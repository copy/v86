// EL0's view of RAM for the AArch32 drivers (el0.c, fuzz.c). With the MMU
// off (the default) EL0 reaches everything; with A64_MMU (the page tier's
// runs: tests/a64/aarch32_page.mjs, aarch32_page_fuzz.mjs) the runtime's
// identity map gives EL0 no access, and RAM that EL0 may write cannot be
// EL1's code: RAM (1 GiB at 0x40000000) is mapped a second time at
// 0xC0000000 for EL0 (read, write and execute; EL1 never executes there),
// and EL0's code, stack and data are used through that alias.
#include <a64.h>

#ifdef A64_MMU
#define EL0_ALIAS 0x80000000ul
static void el0_map(void)
{
    uint64_t *table = (uint64_t *)a64_read(ttbr0_el1);
    // a 1 GiB block: normal memory (MAIR index 0), AP 01 (EL1 and EL0 read
    // and write), inner shareable, the access flag, PXN
    table[3] = 0x40000000ul | 1 | 0 << 2 | 1 << 6 | 3 << 8 | 1 << 10 | 1ul << 53;
    __asm__ volatile("dsb ish\n tlbi vmalle1\n dsb ish\n isb" ::: "memory");
}
#else
#define EL0_ALIAS 0ul
static void el0_map(void) {}
#endif

/** The address EL0 uses for `p` */
static inline uint64_t el0_address(const void *p) { return (uint64_t)(uintptr_t)p + EL0_ALIAS; }
