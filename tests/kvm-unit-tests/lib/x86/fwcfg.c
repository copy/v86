#include "fwcfg.h"
#include "smp.h"

static struct spinlock lock;

uint64_t fwcfg_get_u(uint16_t index, int bytes)
{
    uint64_t r = 0;
    uint8_t b;
    int i;

    spin_lock(&lock);
    asm volatile ("out %0, %1" : : "a"(index), "d"((uint16_t)BIOS_CFG_IOPORT));
    for (i = 0; i < bytes; ++i) {
        asm volatile ("in %1, %0" : "=a"(b) : "d"((uint16_t)(BIOS_CFG_IOPORT + 1)));
        r |= (uint64_t)b << (i * 8);
    }
    spin_unlock(&lock);
    return r;
}

uint8_t fwcfg_get_u8(unsigned index)
{
    return fwcfg_get_u(index, 1);
}

uint16_t fwcfg_get_u16(unsigned index)
{
    return fwcfg_get_u(index, 2);
}

uint32_t fwcfg_get_u32(unsigned index)
{
    return fwcfg_get_u(index, 4);
}

uint64_t fwcfg_get_u64(unsigned index)
{
    return fwcfg_get_u(index, 8);
}

unsigned fwcfg_get_nb_cpus(void)
{
    return fwcfg_get_u16(FW_CFG_NB_CPUS);
}
