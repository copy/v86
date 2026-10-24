// The PL1 driver of tests/a64/aarch32_bench.mjs --arm32 (docs/aarch32-plan.md
// R5.3's E level): one kernel of tests/bench (bench_main(iterations)) built
// for A32 or T32 and run at PL1 on cpu_type "arm32" with the MMU on (short
// descriptors: RAM's sections normal memory, write-back, the rest device
// memory; the page tier compiles code with the MMU on), as a 32-bit kernel
// runs; the checksum and the counter's ticks it took are printed.
#include <a32.h>
#include <stdio.h>

unsigned bench_main(unsigned iterations);
static uint32_t l1[4096] __attribute__((aligned(16384)));

int main(int argc, char **argv)
{
    // 1 MiB sections, identity: AP 11, domain 0; RAM (1 GiB at 0x40000000)
    // TEX 001 C B (write-back, write-allocate), the rest B (shareable device)
    for(uint32_t mb = 0; mb < 4096; mb++)
    {
        const int ram = mb >= 0x400 && mb < 0x800;
        l1[mb] = mb << 20 | 2 | 3 << 10 | (ram ? 1 << 12 | 1 << 3 | 1 << 2 : 1 << 2);
    }
    a32_dsb();
    a32_mcr(0, c2, c0, 2, 0);
    a32_mcr(0, c2, c0, 0, (uint32_t)l1);
    a32_mcr(0, c3, c0, 0, 0x55555555);
    a32_mcr(0, c8, c7, 0, 0);
    a32_dsb();
    a32_mcr(0, c1, c0, 0, a32_mrc(0, c1, c0, 0) | 1 | 1 << 2 | 1 << 12);
    a32_isb();
    const uint64_t start = a32_mrrc(1, c14);
    const unsigned value = bench_main(ITERATIONS);
    const uint64_t end = a32_mrrc(1, c14);
    // (the runtime's printf takes %x and %u as 32 bits here: the ticks in microseconds)
    const uint32_t frequency = a32_mrc(0, c14, c0, 0);
    printf("bench %s checksum %08x ticks %u us frequency %u\n", NAME, value, (unsigned)((end - start) / (frequency / 1000000)), (unsigned)frequency);
    return 0;
}
