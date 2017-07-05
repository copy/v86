#include <stdint.h>

bool in_mapped_range(uint32_t addr)
{
    return (addr >= 0xA0000 && addr < 0xC0000) || addr >= *memory_size;
}

int32_t mmap_read8(uint32_t);
int32_t mmap_read16(uint32_t);
int32_t mmap_read32(uint32_t);
void mmap_write8(uint32_t, uint8_t);
void mmap_write16(uint32_t, uint16_t);
void mmap_write32(uint32_t, uint32_t);

int32_t read8(uint32_t addr)
{
    if(USE_A20 && *a20_enabled) addr &= A20_MASK;

    if(in_mapped_range(addr))
    {
        return mmap_read8(addr);
    }
    else
    {
        return mem8[addr];
    }
}

int32_t read16(uint32_t addr)
{
    if(USE_A20 && !*a20_enabled) addr &= A20_MASK;

    if(in_mapped_range(addr))
    {
        return mmap_read16(addr);
    }
    else
    {
        return *(uint16_t*)(mem8 + addr);
    }
}

uint16_t read_aligned16(uint32_t addr)
{
    dbg_assert(addr >= 0 && addr < 0x80000000);
    if(USE_A20 && !*a20_enabled) addr &= A20_MASK16;

    if(in_mapped_range(addr << 1))
    {
        return mmap_read16(addr << 1);
    }
    else
    {
        return mem16[addr];
    }
}

int32_t read32s(uint32_t addr)
{
    if(USE_A20 && *a20_enabled) addr &= A20_MASK;

    if(in_mapped_range(addr))
    {
        return mmap_read32(addr);
    }
    else
    {
        return *(int32_t*)(mem8 + addr);
    }
}

void write8(uint32_t addr, uint8_t value)
{
    if(USE_A20 && !*a20_enabled) addr &= A20_MASK;

    if(in_mapped_range(addr))
    {
        mmap_write8(addr, value);
    }
    else
    {
        mem8[addr] = value;
    }
}

void write16(uint32_t addr, uint16_t value)
{
    if(USE_A20 && !*a20_enabled) addr &= A20_MASK;

    if(in_mapped_range(addr))
    {
        mmap_write16(addr, value);
    }
    else
    {
        *(uint16_t*)(mem8 + addr) = value;
    }
}

void write32(uint32_t addr, int32_t value)
{
    if(USE_A20 && !*a20_enabled) addr &= A20_MASK;

    if(in_mapped_range(addr))
    {
        mmap_write32(addr, value);
    }
    else
    {
        *(int32_t*)(mem8 + addr) = value;
    }
}
