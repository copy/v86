// Litmus tests of the A64 cores (docs/arm64-virt-android16-plan.md P3.9),
// bare metal on 2 or 4 cores (tests/a64/litmus.mjs): every core turns the
// MMU on (RAM normal write-back, devices nGnRnE), then for ROUNDS rounds
// each of
//
// - MP with DMB, and with STLR/LDAR: flag=1 && data=0 is forbidden
// - SB with DMB: r0=0 && r1=0 is forbidden
// - LB with DMB: r0=1 && r1=1 is forbidden
// - IRIW with DMB (4 cores): the readers seeing the writes in opposite orders is forbidden
// - 2+2W with DMB: x=1 && y=1 at the end is forbidden
//
// and the checks that have no allowed failure: a LDXR/STXR counter on every
// core, a store-exclusive failing after another core's plain store of the
// same value to the granule, a TLBI VAE1IS shootdown that other cores
// observe without an IPI, a ring of SGIs between cores waiting in WFI, and
// a ring of WFE/SEV. Spin waits use YIELD (the cooperative cores' turns
// end there). Each line of output is "name key=count ...", "forbidden=N"
// last on the lines of the litmus tests.

#include <a64.h>
#include <stdio.h>

#ifndef ROUNDS
#define ROUNDS 1000
#endif
#define RING_ROUNDS 100
#define MAX_CORES 8

static unsigned cores;

// ---- synchronization

static volatile unsigned barrier_count, barrier_sense;

static inline void spin(void) { __asm__ volatile("yield" ::: "memory"); }

static void barrier(void)
{
    unsigned sense = !__atomic_load_n(&barrier_sense, __ATOMIC_ACQUIRE);
    if(__atomic_add_fetch(&barrier_count, 1, __ATOMIC_ACQ_REL) == cores)
    {
        barrier_count = 0;
        __atomic_store_n(&barrier_sense, sense, __ATOMIC_RELEASE);
    }
    else
    {
        while(__atomic_load_n(&barrier_sense, __ATOMIC_ACQUIRE) != sense) spin();
    }
}

#define DMB() __asm__ volatile("dmb ish" ::: "memory")

// ---- the MMU: 39-bit VAs, 4 KiB granule, level 1 blocks but for the test page at TEST_VA

#define TEST_VA 0x80000000UL
static uint64_t l1[512] __attribute__((aligned(4096)));
static uint64_t l2[512] __attribute__((aligned(4096)));
static uint64_t l3[512] __attribute__((aligned(4096)));
static volatile uint64_t pages[2][512] __attribute__((aligned(4096)));

#define ATTR_NORMAL (0 << 2)
#define ATTR_DEVICE (1 << 2)
#define SH_INNER (3 << 8)
#define AF (1 << 10)

static void build_tables(void)
{
    l1[0] = 0x00000000UL | 1 | ATTR_DEVICE | AF;          // devices (GIC, PL011)
    l1[1] = 0x40000000UL | 1 | ATTR_NORMAL | SH_INNER | AF; // RAM
    l1[2] = (uint64_t)l2 | 3;
    l2[0] = (uint64_t)l3 | 3;
    pages[0][0] = 0xA0A0;
    pages[1][0] = 0xB1B1;
    l3[0] = (uint64_t)pages[0] | 3 | ATTR_NORMAL | SH_INNER | AF;
    __asm__ volatile("dsb ish" ::: "memory");
}

static void mmu_on(void)
{
    a64_write(mair_el1, 0x00FF);  // attr0 normal write-back, attr1 device nGnRnE
    a64_write(tcr_el1, 25 | 1 << 8 | 1 << 10 | 3 << 12 | 1 << 23 | 2UL << 32);
    a64_write(ttbr0_el1, (uint64_t)l1);
    __asm__ volatile("dsb ish\n tlbi vmalle1\n dsb ish\n isb" ::: "memory");
    a64_write(sctlr_el1, a64_read(sctlr_el1) | 1 | 1 << 2 | 1 << 12);
    __asm__ volatile("isb" ::: "memory");
}

// ---- the litmus tests

static volatile unsigned x, y, data, flag, r[4];
static unsigned histogram[5][16];
static unsigned forbidden[5];
enum { MP_DMB, MP_ACQ_REL, SB, LB, IRIW };
static unsigned final_x1_y1;

static void litmus_round(unsigned core)
{
    // MP with DMB: core 0 writes data then flag, core 1 reads flag then data
    if(core == 0) { data = 1; DMB(); flag = 1; }
    else if(core == 1) { unsigned f = flag; DMB(); unsigned d = data; r[0] = f; r[1] = d; }
    barrier();
    if(core == 0)
    {
        histogram[MP_DMB][r[0] << 1 | r[1]]++;
        forbidden[MP_DMB] += r[0] == 1 && r[1] == 0;
        data = flag = 0;
    }
    barrier();
    // MP with STLR/LDAR
    if(core == 1)
    {
        data = 1;
        __atomic_store_n(&flag, 1, __ATOMIC_RELEASE);
    }
    else if(core == 0)
    {
        unsigned f = __atomic_load_n(&flag, __ATOMIC_ACQUIRE);
        unsigned d = data;
        r[0] = f;
        r[1] = d;
    }
    barrier();
    if(core == 0)
    {
        histogram[MP_ACQ_REL][r[0] << 1 | r[1]]++;
        forbidden[MP_ACQ_REL] += r[0] == 1 && r[1] == 0;
        data = flag = 0;
    }
    barrier();
    // SB: each writes its variable and reads the other's
    if(core == 0) { x = 1; DMB(); r[0] = y; }
    else if(core == 1) { y = 1; DMB(); r[1] = x; }
    barrier();
    if(core == 0)
    {
        histogram[SB][r[0] << 1 | r[1]]++;
        forbidden[SB] += r[0] == 0 && r[1] == 0;
        x = y = 0;
    }
    barrier();
    // LB: each reads the other's variable, then writes its own
    if(core == 0) { r[0] = x; DMB(); y = 1; }
    else if(core == 1) { r[1] = y; DMB(); x = 1; }
    barrier();
    if(core == 0)
    {
        histogram[LB][r[0] << 1 | r[1]]++;
        forbidden[LB] += r[0] == 1 && r[1] == 1;
        x = y = 0;
    }
    barrier();
    // 2+2W: x=1, y=2 against y=1, x=2
    if(core == 0) { x = 1; DMB(); y = 2; }
    else if(core == 1) { y = 1; DMB(); x = 2; }
    barrier();
    if(core == 0)
    {
        final_x1_y1 += x == 1 && y == 1;
        x = y = 0;
    }
    barrier();
    // IRIW: two writers, two readers in opposite orders
    if(cores >= 4)
    {
        if(core == 0) x = 1;
        else if(core == 1) y = 1;
        else if(core == 2) { r[0] = x; DMB(); r[1] = y; }
        else if(core == 3) { r[2] = y; DMB(); r[3] = x; }
        barrier();
        if(core == 0)
        {
            histogram[IRIW][r[0] << 3 | r[1] << 2 | r[2] << 1 | r[3]]++;
            forbidden[IRIW] += r[0] == 1 && r[1] == 0 && r[2] == 1 && r[3] == 0;
            x = y = 0;
        }
        barrier();
    }
}

// ---- exclusives

static volatile uint64_t counter;
static volatile unsigned aba_word __attribute__((aligned(64))), aba_phase;
static unsigned aba_failures;

static void exclusive_counter(void)
{
    for(int i = 0; i < ROUNDS; i++)
    {
        uint64_t value;
        unsigned failed;
        do
        {
            __asm__ volatile("ldxr %0, [%2]\n add %0, %0, #1\n stxr %w1, %0, [%2]" : "=&r"(value), "=&r"(failed) : "r"(&counter) : "memory");
        } while(failed);
    }
}

// core 0 holds a reservation while core 1 stores the same value: the store-exclusive must fail
static void exclusive_cleared(unsigned core)
{
    for(unsigned round = 1; round <= ROUNDS / 10; round++)
    {
        if(core == 0)
        {
            unsigned value, failed;
            __asm__ volatile("ldxr %w0, [%1]" : "=&r"(value) : "r"(&aba_word) : "memory");
            __atomic_store_n(&aba_phase, round * 2 - 1, __ATOMIC_RELEASE);
            while(__atomic_load_n(&aba_phase, __ATOMIC_ACQUIRE) != round * 2) spin();
            __asm__ volatile("stxr %w0, %w2, [%1]" : "=&r"(failed) : "r"(&aba_word), "r"(value + 1) : "memory");
            aba_failures += failed != 0;
        }
        else if(core == 1)
        {
            while(__atomic_load_n(&aba_phase, __ATOMIC_ACQUIRE) != round * 2 - 1) spin();
            aba_word = aba_word;
            __atomic_store_n(&aba_phase, round * 2, __ATOMIC_RELEASE);
        }
        barrier();
    }
}

// ---- TLBI VAE1IS: core 0 remaps TEST_VA, the others see the new page with no IPI

static volatile unsigned remap_round;
static unsigned stale[MAX_CORES];

static void shootdown(unsigned core)
{
    for(unsigned round = 1; round <= ROUNDS / 10; round++)
    {
        unsigned page = round & 1;
        // (every core has the old translation cached: it reads the page first)
        (void)*(volatile uint64_t *)TEST_VA;
        barrier();
        if(core == 0)
        {
            l3[0] = (uint64_t)pages[page] | 3 | ATTR_NORMAL | SH_INNER | AF;
            __asm__ volatile("dsb ishst\n tlbi vae1is, %0\n dsb ish\n isb" :: "r"(TEST_VA >> 12) : "memory");
            __atomic_store_n(&remap_round, round, __ATOMIC_RELEASE);
        }
        else
        {
            while(__atomic_load_n(&remap_round, __ATOMIC_ACQUIRE) != round) spin();
        }
        __asm__ volatile("isb" ::: "memory");
        stale[core] += *(volatile uint64_t *)TEST_VA != pages[page][0];
        barrier();
    }
}

// ---- the GIC: SGI 0 around a ring of cores waiting in WFI (IRQs masked: WFI wakes all the same)

#define GICD 0x08000000UL
#define GICR(core) (0x080A0000UL + (core) * 0x20000UL)
#define MMIO32(a) (*(volatile uint32_t *)(a))
static volatile unsigned sgi_seen[MAX_CORES];

static void gic_setup(unsigned core)
{
    if(core == 0) MMIO32(GICD) = 1 << 4 | 1 << 1 | 1;
    MMIO32(GICR(core) + 0x14) &= ~2u;                 // GICR_WAKER.ProcessorSleep
    while(MMIO32(GICR(core) + 0x14) & 4) spin();      // ChildrenAsleep
    MMIO32(GICR(core) + 0x10000 + 0x80) = ~0u;        // GICR_IGROUPR0: group 1
    MMIO32(GICR(core) + 0x10000 + 0x400) = 0x80;      // SGI 0's priority
    MMIO32(GICR(core) + 0x10000 + 0x100) = 1;         // GICR_ISENABLER0: SGI 0
    __asm__ volatile("msr S3_0_C12_C12_5, %0" :: "r"(7UL));   // ICC_SRE_EL1
    __asm__ volatile("msr S3_0_C4_C6_0, %0" :: "r"(0xFFUL));  // ICC_PMR_EL1
    __asm__ volatile("msr S3_0_C12_C12_7, %0\n isb" :: "r"(1UL)); // ICC_IGRPEN1_EL1
}

static void sgi_to(unsigned core)
{
    __asm__ volatile("dsb ish\n msr S3_0_C12_C11_5, %0\n isb" :: "r"((uint64_t)1 << core) : "memory"); // ICC_SGI1R_EL1, INTID 0
}

static void wait_sgi(void)
{
    for(;;)
    {
        uint64_t intid;
        __asm__ volatile("wfi\n mrs %0, S3_0_C12_C12_0" : "=r"(intid) :: "memory"); // ICC_IAR1_EL1
        if(intid == 1023) continue;
        __asm__ volatile("msr S3_0_C12_C12_1, %0\n isb" :: "r"(intid)); // ICC_EOIR1_EL1
        if(intid == 0) return;
    }
}

static void sgi_ring(unsigned core)
{
    for(unsigned round = 0; round < RING_ROUNDS; round++)
    {
        if(core == 0)
        {
            sgi_to(1);
            wait_sgi();
            sgi_seen[0]++;
        }
        else
        {
            wait_sgi();
            sgi_seen[core]++;
            sgi_to((core + 1) % cores);
        }
    }
    barrier();
}

// ---- WFE and SEV: a token around the cores

static volatile unsigned token, wfe_passes[MAX_CORES];

static void wfe_ring(unsigned core)
{
    for(unsigned round = 0; round < RING_ROUNDS; round++)
    {
        while(__atomic_load_n(&token, __ATOMIC_ACQUIRE) != round * cores + core) __asm__ volatile("wfe" ::: "memory");
        wfe_passes[core]++;
        __atomic_store_n(&token, round * cores + core + 1, __ATOMIC_RELEASE);
        __asm__ volatile("dsb ish\n sev" ::: "memory");
    }
    barrier();
}

// ---- running

static volatile unsigned started;

static void run(unsigned core)
{
    mmu_on();
    gic_setup(core);
    barrier();
    for(int i = 0; i < ROUNDS; i++) litmus_round(core);
    exclusive_counter();
    barrier();
    exclusive_cleared(core);
    shootdown(core);
    sgi_ring(core);
    wfe_ring(core);
}

static void secondary(unsigned core)
{
    __atomic_add_fetch(&started, 1, __ATOMIC_ACQ_REL);
    while(!__atomic_load_n(&cores, __ATOMIC_ACQUIRE)) spin();
    run(core);
    for(;;) __asm__ volatile("wfi");
}

int main(int argc, char **argv)
{
    build_tables();
    a64_core_main = secondary;
    unsigned n = 1;
    while(n < MAX_CORES && a64_cpu_on(n) == 0) n++;
    while(__atomic_load_n(&started, __ATOMIC_ACQUIRE) != n - 1) spin();
    __atomic_store_n(&cores, n, __ATOMIC_RELEASE);
    run(0);

    printf("cores=%u rounds=%u\n", cores, ROUNDS);
    static const char *names[] = { "MP+dmb", "MP+stlr+ldar", "SB+dmb", "LB+dmb", "IRIW+dmb" };
    for(int t = 0; t < 5; t++)
    {
        if(t == IRIW && cores < 4) continue;
        printf("%s", names[t]);
        for(int k = 0; k < (t == IRIW ? 16 : 4); k++) if(histogram[t][k]) printf(" %x=%u", k, histogram[t][k]);
        printf(" forbidden=%u\n", forbidden[t]);
    }
    printf("2+2W+dmb x1y1=%u forbidden=%u\n", final_x1_y1, final_x1_y1);
    printf("exclusive-counter count=%lu expected=%u\n", (unsigned long)counter, cores * ROUNDS);
    printf("exclusive-cleared failures=%u expected=%u\n", aba_failures, ROUNDS / 10);
    unsigned stale_total = 0;
    for(unsigned c = 0; c < cores; c++) stale_total += stale[c];
    printf("tlbi-vae1is-shootdown stale=%u rounds=%u\n", stale_total, ROUNDS / 10);
    unsigned sgi_total = 0, wfe_total = 0;
    for(unsigned c = 0; c < cores; c++) { sgi_total += sgi_seen[c]; wfe_total += wfe_passes[c]; }
    printf("wfi-sgi-ring received=%u expected=%u\n", sgi_total, cores * RING_ROUNDS);
    printf("wfe-sev-ring passes=%u expected=%u\n", wfe_total, cores * RING_ROUNDS);
    return 0;
}
