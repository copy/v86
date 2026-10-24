// The smallest AArch32 guest (tests/a32/runner.mjs): the runtime's start,
// printf, the mode it runs in and the DTB's address
#include <a32.h>
#include <stdio.h>

int main(int argc, char **argv)
{
    printf("hello from AArch32, cpsr mode %#x\n", (unsigned)(a32_cpsr() & 0x1F));
    printf("sctlr %#x midr %#x\n", (unsigned)a32_mrc(0, c1, c0, 0), (unsigned)a32_mrc(0, c0, c0, 0));
    return 0;
}
