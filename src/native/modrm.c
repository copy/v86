#include <assert.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>

#include "const.h"
#include "cpu.h"
#include "global_pointers.h"
#include "modrm.h"

//static int32_t resolve_sib_(bool mod);
//static int32_t resolve_modrm32_(int32_t modrm_byte);
static int32_t resolve_sib(bool mod);

#define ds get_seg_prefix_ds
#define ss get_seg_prefix_ss

#define MODRM_ENTRY(n, offset)\
    case (n) | 0 << 3:\
    case (n) | 1 << 3:\
    case (n) | 2 << 3:\
    case (n) | 3 << 3:\
    case (n) | 4 << 3:\
    case (n) | 5 << 3:\
    case (n) | 6 << 3:\
    case (n) | 7 << 3:\
        return offset;

#define MODRM_ENTRY16(row, seg, value)\
    MODRM_ENTRY(0x00 | (row), seg(((value) & 0xFFFF)))\
    MODRM_ENTRY(0x40 | (row), seg(((value) + read_imm8s() & 0xFFFF)))\
    MODRM_ENTRY(0x80 | (row), seg(((value) + read_imm16() & 0xFFFF)))\

int32_t resolve_modrm16(int32_t modrm_byte)
{
    switch(modrm_byte)
    {
        MODRM_ENTRY16(0, ds, reg16[BX] + reg16[SI])
        MODRM_ENTRY16(1, ds, reg16[BX] + reg16[DI])
        MODRM_ENTRY16(2, ss, reg16[BP] + reg16[SI])
        MODRM_ENTRY16(3, ss, reg16[BP] + reg16[DI])
        MODRM_ENTRY16(4, ds, reg16[SI])
        MODRM_ENTRY16(5, ds, reg16[DI])

        // special case
        MODRM_ENTRY(0x00 | 6, ds(read_imm16()))
        MODRM_ENTRY(0x40 | 6, ss(reg16[BP] + read_imm8s() & 0xFFFF))
        MODRM_ENTRY(0x80 | 6, ss(reg16[BP] + read_imm16() & 0xFFFF))

        MODRM_ENTRY16(7, ds, reg16[BX])

        default:
            assert(false);
    }

    return 0;
}

#undef MODRM_ENTRY16

#define MODRM_ENTRY32(row, seg, value)\
    MODRM_ENTRY(0x00 | (row), seg((value)))\
    MODRM_ENTRY(0x40 | (row), seg((value) + read_imm8s()))\
    MODRM_ENTRY(0x80 | (row), seg((value) + read_imm32s()))\

int32_t resolve_modrm32(int32_t modrm_byte)
{
    switch(modrm_byte)
    {
        MODRM_ENTRY32(0, ds, reg32s[EAX])
        MODRM_ENTRY32(1, ds, reg32s[ECX])
        MODRM_ENTRY32(2, ds, reg32s[EDX])
        MODRM_ENTRY32(3, ds, reg32s[EBX])

        // special cases
        MODRM_ENTRY(0x00 | 4, resolve_sib(false))
        MODRM_ENTRY(0x40 | 4, resolve_sib(true) + read_imm8s())
        MODRM_ENTRY(0x80 | 4, resolve_sib(true) + read_imm32s())
        MODRM_ENTRY(0x00 | 5, ds(read_imm32s()))
        MODRM_ENTRY(0x40 | 5, ss(reg32s[EBP] + read_imm8s()))
        MODRM_ENTRY(0x80 | 5, ss(reg32s[EBP] + read_imm32s()))

        MODRM_ENTRY32(6, ds, reg32s[ESI])
        MODRM_ENTRY32(7, ds, reg32s[EDI])

        default:
            assert(false);
    }

    return 0;
}

#undef MODRM_ENTRY32
#undef MODRM_ENTRY


#define SIB_ENTRY_LEVEL3(n, offset)\
    case n: return offset;

#define SIB_ENTRY_LEVEL2(n, offset)\
    SIB_ENTRY_LEVEL3((n) | 0, ds((offset) + reg32s[EAX]))\
    SIB_ENTRY_LEVEL3((n) | 1, ds((offset) + reg32s[ECX]))\
    SIB_ENTRY_LEVEL3((n) | 2, ds((offset) + reg32s[EDX]))\
    SIB_ENTRY_LEVEL3((n) | 3, ds((offset) + reg32s[EBX]))\
    SIB_ENTRY_LEVEL3((n) | 4, ss((offset) + reg32s[ESP]))\
    SIB_ENTRY_LEVEL3((n) | 5, (mod ? ss((offset) + reg32s[EBP]) : ds((offset) + read_imm32s())))\
    SIB_ENTRY_LEVEL3((n) | 6, ds((offset) + reg32s[ESI]))\
    SIB_ENTRY_LEVEL3((n) | 7, ds((offset) + reg32s[EDI]))

#define SIB_ENTRY_LEVEL1(n, reg1)\
    SIB_ENTRY_LEVEL2(0x00 | (n) << 3, (reg1))\
    SIB_ENTRY_LEVEL2(0x40 | (n) << 3, (reg1) << 1)\
    SIB_ENTRY_LEVEL2(0x80 | (n) << 3, (reg1) << 2)\
    SIB_ENTRY_LEVEL2(0xC0 | (n) << 3, (reg1) << 3)

#if 0
static inline int32_t resolve_sib_(bool mod)
{
    switch(read_imm8())
    {
        SIB_ENTRY_LEVEL1(0, reg32s[EAX]);
        SIB_ENTRY_LEVEL1(1, reg32s[ECX]);
        SIB_ENTRY_LEVEL1(2, reg32s[EDX]);
        SIB_ENTRY_LEVEL1(3, reg32s[EBX]);
        SIB_ENTRY_LEVEL1(4, 0          );
        SIB_ENTRY_LEVEL1(5, reg32s[EBP]);
        SIB_ENTRY_LEVEL1(6, reg32s[ESI]);
        SIB_ENTRY_LEVEL1(7, reg32s[EDI]);

        default:
            assert(false);
    }

    return 0;
}
#endif

#undef SIB_ENTRY_LEVEL3
#undef SIB_ENTRY_LEVEL2
#undef SIB_ENTRY_LEVEL1

#undef ds
#undef ss


static int32_t resolve_sib(bool mod)
{
    uint8_t sib_byte = read_imm8();
    uint8_t r = sib_byte & 7;
    uint8_t m = sib_byte >> 3 & 7;

    int32_t base;
    int32_t seg;

    if(r == 4)
    {
        base = reg32s[ESP];
        seg = SS;
    }
    else if(r == 5)
    {
        if(mod)
        {
            base = reg32s[EBP];
            seg = SS;
        }
        else
        {
            base = read_imm32s();
            seg = DS;
        }
    }
    else
    {
        base = reg32s[r];
        seg = DS;
    }

    int32_t offset;
    if(m == 4)
    {
        offset = 0;
    }
    else
    {
        uint8_t s = sib_byte >> 6 & 3;
        offset = reg32s[m] << s;
    }

    return get_seg_prefix(seg) + base + offset;
}

#if 0
static inline int32_t resolve_modrm32_(int32_t modrm_byte)
{
    uint8_t r = modrm_byte & 7;
    assert(modrm_byte < 0xC0);

    if(r == 4)
    {
        if(modrm_byte < 0x40)
        {
            return resolve_sib(false);
        }
        else
        {
            return resolve_sib(true) + (modrm_byte < 0x80 ? read_imm8s() : read_imm32s());
        }
    }
    else if(r == 5)
    {
        if(modrm_byte < 0x40)
        {
            return get_seg_prefix_ds(read_imm32s());
        }
        else
        {
            return get_seg_prefix_ss(reg32s[EBP] + (modrm_byte < 0x80 ? read_imm8s() : read_imm32s()));
        }
    }
    else
    {
        if(modrm_byte < 0x40)
        {
            return get_seg_prefix_ds(reg32s[r]);
        }
        else
        {
            return get_seg_prefix_ds(reg32s[r] + (modrm_byte < 0x80 ? read_imm8s() : read_imm32s()));
        }
    }
}
#endif
