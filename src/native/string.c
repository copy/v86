#include <stdbool.h>
#include <stdint.h>

#include "arith.h"
#include "cpu.h"
#include "global_pointers.h"
#include "js_imports.h"
#include "log.h"
#include "memory.h"
#include "string.h"

#define MAX_COUNT_PER_CYCLE 0x1000
#define MIN(x, y) ((x) < (y) ? (x) : (y))

int32_t string_get_cycle_count(int32_t size, int32_t address)
{
    dbg_assert(size && size <= 4 && size >= -4);

    if(size < 0)
    {
        return (address & 0xFFF) >> (-size >> 1);
    }
    else
    {
        return (~address & 0xFFF) >> size;
    }
}

int32_t string_get_cycle_count2(int32_t size, int32_t addr1, int32_t addr2)
{
    int32_t c1 = string_get_cycle_count(size, addr1);
    int32_t c2 = string_get_cycle_count(size, addr2);

    return MIN(c1, c2);
}

void movsb_rep()
{
    int32_t src = get_seg_prefix(DS) + get_reg_asize(ESI);
    int32_t dest = get_seg(ES) + get_reg_asize(EDI);
    int32_t size = *flags & FLAG_DIRECTION ? -1 : 1;

    int32_t count = get_reg_asize(ECX);
    if(count == 0) return;
    int32_t cont = false;
    int32_t start_count = count;
    int32_t cycle_counter = MAX_COUNT_PER_CYCLE;
    int32_t phys_src = translate_address_read(src);
    int32_t phys_dest = translate_address_write(dest);
    if(*paging)
    {
        cycle_counter = string_get_cycle_count2(size, src, dest);
    }
    do
    {
        write8(phys_dest, read8(phys_src));
        phys_dest += size;
        phys_src += size;
        cont = --count != 0;
    }
    while(cont && cycle_counter--);
    int32_t diff = size * (start_count - count);
    add_reg_asize(EDI, diff);
    add_reg_asize(ESI, diff);
    set_ecx_asize(count);
    *timestamp_counter += start_count - count;
    if(cont)
    {
        *instruction_pointer = *previous_ip;
    }
}

void movsb_no_rep()
{
    int32_t src = get_seg_prefix(DS) + get_reg_asize(ESI);
    int32_t dest = get_seg(ES) + get_reg_asize(EDI);
    int32_t size = *flags & FLAG_DIRECTION ? -1 : 1;

    safe_write8(dest, safe_read8(src));
    add_reg_asize(EDI, size);
    add_reg_asize(ESI, size);
}

void movsb()
{
    if(*prefixes & PREFIX_MASK_REP)
    {
        movsb_rep();
    }
    else
    {
        movsb_no_rep();
    }
}

void movsw_rep()
{
    int32_t src = get_seg_prefix(DS) + get_reg_asize(ESI);
    int32_t dest = get_seg(ES) + get_reg_asize(EDI);
    int32_t size = *flags & FLAG_DIRECTION ? -2 : 2;

    int32_t count = get_reg_asize(ECX);
    if(count == 0) return;
    int32_t cont = false;
    int32_t start_count = count;
    int32_t cycle_counter = MAX_COUNT_PER_CYCLE;
    if(!(dest & 1) && !(src & 1))
    {
        int32_t single_size = size < 0 ? -1 : 1;
        int32_t phys_src = translate_address_read(src) >> 1;
        int32_t phys_dest = translate_address_write(dest) >> 1;
        if(*paging)
        {
            cycle_counter = string_get_cycle_count2(size, src, dest);
        }
        do
        {
            write_aligned16(phys_dest, read_aligned16(phys_src));
            phys_dest += single_size;
            phys_src += single_size;
            cont = --count != 0;
        }
        while(cont && cycle_counter--);
        int32_t diff = size * (start_count - count);
        add_reg_asize(EDI, diff);
        add_reg_asize(ESI, diff);
        set_ecx_asize(count);
        *timestamp_counter += start_count - count;
    }
    else
    {
        do
        {
            safe_write16(dest, safe_read16(src));
            dest += size;
            add_reg_asize(EDI, size);
            src += size;
            add_reg_asize(ESI, size);
            cont = decr_ecx_asize() != 0;
        }
        while(cont && cycle_counter--);
    }
    if(cont)
    {
        *instruction_pointer = *previous_ip;
    }
}

void movsw_no_rep()
{
    int32_t src = get_seg_prefix(DS) + get_reg_asize(ESI);
    int32_t dest = get_seg(ES) + get_reg_asize(EDI);
    int32_t size = *flags & FLAG_DIRECTION ? -2 : 2;

    safe_write16(dest, safe_read16(src));
    add_reg_asize(EDI, size);
    add_reg_asize(ESI, size);
}

void movsw()
{
    if(*prefixes & PREFIX_MASK_REP)
    {
        movsw_rep();
    }
    else
    {
        movsw_no_rep();
    }
}

void movsd_rep()
{
    int32_t src = get_seg_prefix(DS) + get_reg_asize(ESI);
    int32_t dest = get_seg(ES) + get_reg_asize(EDI);
    int32_t size = *flags & FLAG_DIRECTION ? -4 : 4;

    int32_t count = get_reg_asize(ECX);
    if(count == 0) return;
    int32_t cont = false;
    int32_t start_count = count;
    int32_t cycle_counter = MAX_COUNT_PER_CYCLE;
    if(!(dest & 3) && !(src & 3))
    {
        int32_t single_size = size < 0 ? -1 : 1;
        int32_t phys_src = translate_address_read(src) >> 2;
        int32_t phys_dest = translate_address_write(dest) >> 2;
        if(*paging)
        {
            cycle_counter = string_get_cycle_count2(size, src, dest);
        }
        do
        {
            write_aligned32(phys_dest, read_aligned32(phys_src));
            phys_dest += single_size;
            phys_src += single_size;
            cont = --count != 0;
        }
        while(cont && cycle_counter--);
        int32_t diff = size * (start_count - count);
        add_reg_asize(EDI, diff);
        add_reg_asize(ESI, diff);
        set_ecx_asize(count);
        *timestamp_counter += start_count - count;
    }
    else
    {
        do
        {
            safe_write32(dest, safe_read32s(src));
            dest += size;
            add_reg_asize(EDI, size);
            src += size;
            add_reg_asize(ESI, size);
            cont = decr_ecx_asize() != 0;
        }
        while(cont && cycle_counter--);
    }
    if(cont)
    {
        *instruction_pointer = *previous_ip;
    }
}

void movsd_no_rep()
{
    int32_t src = get_seg_prefix(DS) + get_reg_asize(ESI);
    int32_t dest = get_seg(ES) + get_reg_asize(EDI);
    int32_t size = *flags & FLAG_DIRECTION ? -4 : 4;

    safe_write32(dest, safe_read32s(src));
    add_reg_asize(EDI, size);
    add_reg_asize(ESI, size);
}

void movsd()
{
    if(*prefixes & PREFIX_MASK_REP)
    {
        movsd_rep();
    }
    else
    {
        movsd_no_rep();
    }
}

void cmpsb_rep()
{
    int32_t src = get_seg_prefix(DS) + get_reg_asize(ESI);
    int32_t dest = get_seg(ES) + get_reg_asize(EDI);
    int32_t data_src, data_dest;
    int32_t size = *flags & FLAG_DIRECTION ? -1 : 1;

    int32_t count = get_reg_asize(ECX);
    if(count == 0) return;
    int32_t cont = false;
    int32_t start_count = count;
    int32_t is_repz = (*prefixes & PREFIX_MASK_REP) == PREFIX_REPZ;
    int32_t cycle_counter = MAX_COUNT_PER_CYCLE;
    int32_t phys_src = translate_address_read(src);
    int32_t phys_dest = translate_address_read(dest);
    if(*paging)
    {
        cycle_counter = string_get_cycle_count2(size, src, dest);
    }
    do
    {
        data_dest = read8(phys_dest);
        data_src = read8(phys_src);
        phys_dest += size;
        phys_src += size;
        cont = --count != 0 && (data_src == data_dest) == is_repz;
    }
    while(cont && cycle_counter--);
    int32_t diff = size * (start_count - count);
    add_reg_asize(EDI, diff);
    add_reg_asize(ESI, diff);
    set_ecx_asize(count);
    *timestamp_counter += start_count - count;
    if(cont)
    {
        *instruction_pointer = *previous_ip;
    }

    cmp8(data_src, data_dest);
}

void cmpsb_no_rep()
{
    int32_t src = get_seg_prefix(DS) + get_reg_asize(ESI);
    int32_t dest = get_seg(ES) + get_reg_asize(EDI);
    int32_t data_src, data_dest;
    int32_t size = *flags & FLAG_DIRECTION ? -1 : 1;

    data_src = safe_read8(src);
    data_dest = safe_read8(dest);
    add_reg_asize(EDI, size);
    add_reg_asize(ESI, size);

    cmp8(data_src, data_dest);
}

void cmpsb()
{
    if(*prefixes & PREFIX_MASK_REP)
    {
        cmpsb_rep();
    }
    else
    {
        cmpsb_no_rep();
    }
}

void cmpsw_rep()
{
    int32_t src = get_seg_prefix(DS) + get_reg_asize(ESI);
    int32_t dest = get_seg(ES) + get_reg_asize(EDI);
    int32_t data_src, data_dest;
    int32_t size = *flags & FLAG_DIRECTION ? -2 : 2;

    int32_t count = get_reg_asize(ECX);
    if(count == 0) return;
    int32_t cont = false;
    int32_t start_count = count;
    int32_t is_repz = (*prefixes & PREFIX_MASK_REP) == PREFIX_REPZ;
    int32_t cycle_counter = MAX_COUNT_PER_CYCLE;
    if(!(dest & 1) && !(src & 1))
    {
        int32_t single_size = size < 0 ? -1 : 1;
        int32_t phys_src = translate_address_read(src) >> 1;
        int32_t phys_dest = translate_address_read(dest) >> 1;
        if(*paging)
        {
            cycle_counter = string_get_cycle_count2(size, src, dest);
        }
        do
        {
            data_dest = read_aligned16(phys_dest);
            data_src = read_aligned16(phys_src);
            phys_dest += single_size;
            phys_src += single_size;
            cont = --count != 0 && (data_src == data_dest) == is_repz;
        }
        while(cont && cycle_counter--);
        int32_t diff = size * (start_count - count);
        add_reg_asize(EDI, diff);
        add_reg_asize(ESI, diff);
        set_ecx_asize(count);
        *timestamp_counter += start_count - count;
    }
    else
    {
        do
        {
            data_dest = safe_read16(dest);
            data_src = safe_read16(src);
            dest += size;
            add_reg_asize(EDI, size);
            src += size;
            add_reg_asize(ESI, size);
            cont = decr_ecx_asize() != 0 && (data_src == data_dest) == is_repz;
        }
        while(cont && cycle_counter--);
    }
    if(cont)
    {
        *instruction_pointer = *previous_ip;
    }

    cmp16(data_src, data_dest);
}

void cmpsw_no_rep()
{
    int32_t src = get_seg_prefix(DS) + get_reg_asize(ESI);
    int32_t dest = get_seg(ES) + get_reg_asize(EDI);
    int32_t data_src, data_dest;
    int32_t size = *flags & FLAG_DIRECTION ? -2 : 2;

    data_dest = safe_read16(dest);
    data_src = safe_read16(src);
    add_reg_asize(EDI, size);
    add_reg_asize(ESI, size);

    cmp16(data_src, data_dest);
}

void cmpsw()
{
    if(*prefixes & PREFIX_MASK_REP)
    {
        cmpsw_rep();
    }
    else
    {
        cmpsw_no_rep();
    }
}

void cmpsd_rep()
{
    int32_t src = get_seg_prefix(DS) + get_reg_asize(ESI);
    int32_t dest = get_seg(ES) + get_reg_asize(EDI);
    int32_t data_src, data_dest;
    int32_t size = *flags & FLAG_DIRECTION ? -4 : 4;

    int32_t count = get_reg_asize(ECX);
    if(count == 0) return;
    int32_t cont = false;
    int32_t start_count = count;
    int32_t is_repz = (*prefixes & PREFIX_MASK_REP) == PREFIX_REPZ;
    int32_t cycle_counter = MAX_COUNT_PER_CYCLE;
    if(!(dest & 3) && !(src & 3))
    {
        int32_t single_size = size < 0 ? -1 : 1;
        int32_t phys_src = translate_address_read(src) >> 2;
        int32_t phys_dest = translate_address_read(dest) >> 2;
        if(*paging)
        {
            cycle_counter = string_get_cycle_count2(size, src, dest);
        }
        do
        {
            data_dest = read_aligned32(phys_dest);
            data_src = read_aligned32(phys_src);
            phys_dest += single_size;
            phys_src += single_size;
            cont = --count != 0 && (data_src == data_dest) == is_repz;
        }
        while(cont && cycle_counter--);
        int32_t diff = size * (start_count - count);
        add_reg_asize(EDI, diff);
        add_reg_asize(ESI, diff);
        set_ecx_asize(count);
        *timestamp_counter += start_count - count;
    }
    else
    {
        do
        {
            data_dest = safe_read32s(dest);
            data_src = safe_read32s(src);
            dest += size;
            add_reg_asize(EDI, size);
            src += size;
            add_reg_asize(ESI, size);
            cont = decr_ecx_asize() != 0 && (data_src == data_dest) == is_repz;
        }
        while(cont && cycle_counter--);
    }
    if(cont)
    {
        *instruction_pointer = *previous_ip;
    }

    cmp32(data_src, data_dest);
}

void cmpsd_no_rep()
{
    int32_t src = get_seg_prefix(DS) + get_reg_asize(ESI);
    int32_t dest = get_seg(ES) + get_reg_asize(EDI);
    int32_t data_src, data_dest;
    int32_t size = *flags & FLAG_DIRECTION ? -4 : 4;

    data_dest = safe_read32s(dest);
    data_src = safe_read32s(src);
    add_reg_asize(EDI, size);
    add_reg_asize(ESI, size);

    cmp32(data_src, data_dest);
}

void cmpsd()
{
    if(*prefixes & PREFIX_MASK_REP)
    {
        cmpsd_rep();
    }
    else
    {
        cmpsd_no_rep();
    }
}

void stosb_rep()
{
    int32_t data = reg8[AL];
    int32_t dest = get_seg(ES) + get_reg_asize(EDI);
    int32_t size = *flags & FLAG_DIRECTION ? -1 : 1;

    int32_t count = get_reg_asize(ECX);
    if(count == 0) return;
    int32_t cont = false;
    int32_t start_count = count;
    int32_t cycle_counter = MAX_COUNT_PER_CYCLE;
    int32_t phys_dest = translate_address_write(dest);
    if(*paging)
    {
        cycle_counter = string_get_cycle_count(size, dest);
    }
    do
    {
        write8(phys_dest, data);
        phys_dest += size;
        cont = --count != 0;
    }
    while(cont && cycle_counter--);
    int32_t diff = size * (start_count - count);
    add_reg_asize(EDI, diff);
    set_ecx_asize(count);
    *timestamp_counter += start_count - count;
    if(cont)
    {
        *instruction_pointer = *previous_ip;
    }
}

void stosb_no_rep()
{
    int32_t data = reg8[AL];
    int32_t dest = get_seg(ES) + get_reg_asize(EDI);
    int32_t size = *flags & FLAG_DIRECTION ? -1 : 1;

    safe_write8(dest, data);
    add_reg_asize(EDI, size);
}

void stosb()
{
    if(*prefixes & PREFIX_MASK_REP)
    {
        stosb_rep();
    }
    else
    {
        stosb_no_rep();
    }
}

void stosw_rep()
{
    int32_t data = reg16[AX];
    int32_t dest = get_seg(ES) + get_reg_asize(EDI);
    int32_t size = *flags & FLAG_DIRECTION ? -2 : 2;

    int32_t count = get_reg_asize(ECX);
    if(count == 0) return;
    int32_t cont = false;
    int32_t start_count = count;
    int32_t cycle_counter = MAX_COUNT_PER_CYCLE;
    if(!(dest & 1))
    {
        int32_t single_size = size < 0 ? -1 : 1;
        int32_t phys_dest = translate_address_write(dest) >> 1;
        if(*paging)
        {
            cycle_counter = string_get_cycle_count(size, dest);
        }
        do
        {
            write_aligned16(phys_dest, data);
            phys_dest += single_size;
            cont = --count != 0;
        }
        while(cont && cycle_counter--);
        int32_t diff = size * (start_count - count);
        add_reg_asize(EDI, diff);
        set_ecx_asize(count);
        *timestamp_counter += start_count - count;
    }
    else
    {
        do
        {
            safe_write16(dest, data);
            dest += size;
            add_reg_asize(EDI, size);
            cont = decr_ecx_asize() != 0;
        }
        while(cont && cycle_counter--);
    }
    if(cont)
    {
        *instruction_pointer = *previous_ip;
    }
}

void stosw_no_rep()
{
    int32_t data = reg16[AX];
    int32_t dest = get_seg(ES) + get_reg_asize(EDI);
    int32_t size = *flags & FLAG_DIRECTION ? -2 : 2;

    safe_write16(dest, data);
    add_reg_asize(EDI, size);
}

void stosw()
{
    if(*prefixes & PREFIX_MASK_REP)
    {
        stosw_rep();
    }
    else
    {
        stosw_no_rep();
    }
}

void stosd_rep()
{
    int32_t data = reg32s[EAX];
    int32_t dest = get_seg(ES) + get_reg_asize(EDI);
    int32_t size = *flags & FLAG_DIRECTION ? -4 : 4;

    int32_t count = get_reg_asize(ECX);
    if(count == 0) return;
    int32_t cont = false;
    int32_t start_count = count;
    int32_t cycle_counter = MAX_COUNT_PER_CYCLE;
    if(!(dest & 3))
    {
        int32_t single_size = size < 0 ? -1 : 1;
        int32_t phys_dest = translate_address_write(dest) >> 2;
        if(*paging)
        {
            cycle_counter = string_get_cycle_count(size, dest);
        }
        do
        {
            write_aligned32(phys_dest, data);
            phys_dest += single_size;
            cont = --count != 0;
        }
        while(cont && cycle_counter--);
        int32_t diff = size * (start_count - count);
        add_reg_asize(EDI, diff);
        set_ecx_asize(count);
        *timestamp_counter += start_count - count;
    }
    else
    {
        do
        {
            safe_write32(dest, data);
            dest += size;
            add_reg_asize(EDI, size);
            cont = decr_ecx_asize() != 0;
        }
        while(cont && cycle_counter--);
    }
    if(cont)
    {
        *instruction_pointer = *previous_ip;
    }
}

void stosd_no_rep()
{
    int32_t data = reg32s[EAX];
    int32_t dest = get_seg(ES) + get_reg_asize(EDI);
    int32_t size = *flags & FLAG_DIRECTION ? -4 : 4;

    safe_write32(dest, data);
    add_reg_asize(EDI, size);
}

void stosd()
{
    if(*prefixes & PREFIX_MASK_REP)
    {
        stosd_rep();
    }
    else
    {
        stosd_no_rep();
    }
}

void lodsb_rep()
{
    int32_t src = get_seg_prefix(DS) + get_reg_asize(ESI);
    int32_t size = *flags & FLAG_DIRECTION ? -1 : 1;
    int32_t count = get_reg_asize(ECX);
    if(count == 0) return;
    int32_t cont = false;
    int32_t start_count = count;
    int32_t cycle_counter = MAX_COUNT_PER_CYCLE;
    int32_t phys_src = translate_address_read(src);
    if(*paging)
    {
        cycle_counter = string_get_cycle_count(size, src);
    }
    do
    {
        reg8[AL] = read8(phys_src);
        phys_src += size;
        cont = --count != 0;
    }
    while(cont && cycle_counter--);
    int32_t diff = size * (start_count - count);
    add_reg_asize(ESI, diff);
    set_ecx_asize(count);
    *timestamp_counter += start_count - count;
    if(cont)
    {
        *instruction_pointer = *previous_ip;
    }
}

void lodsb_no_rep()
{
    int32_t src = get_seg_prefix(DS) + get_reg_asize(ESI);
    int32_t size = *flags & FLAG_DIRECTION ? -1 : 1;
    reg8[AL] = safe_read8(src);
    add_reg_asize(ESI, size);
}


void lodsb()
{
    if(*prefixes & PREFIX_MASK_REP)
    {
        lodsb_rep();
    }
    else
    {
        lodsb_no_rep();
    }
}

void lodsw_rep()
{
    int32_t src = get_seg_prefix(DS) + get_reg_asize(ESI);
    int32_t size = *flags & FLAG_DIRECTION ? -2 : 2;

    uint32_t count = ((uint32_t) get_reg_asize(ECX));
    if(count == 0) return;
    bool cont = false;
    uint32_t cycle_counter = MAX_COUNT_PER_CYCLE;
    do
    {
        reg16[AX] = safe_read16(src);
        src += size;
        add_reg_asize(ESI, size);
        cont = decr_ecx_asize() != 0;
    }
    while(cont && cycle_counter--);
    if(cont)
    {
        *instruction_pointer = *previous_ip;
    }
}

void lodsw_no_rep()
{
    int32_t src = get_seg_prefix(DS) + get_reg_asize(ESI);
    int32_t size = *flags & FLAG_DIRECTION ? -2 : 2;

    reg16[AX] = safe_read16(src);
    add_reg_asize(ESI, size);

}

void lodsw()
{
    if(*prefixes & PREFIX_MASK_REP)
    {
        lodsw_rep();
    }
    else
    {
        lodsw_no_rep();
    }
}

void lodsd_rep()
{
    int32_t src = get_seg_prefix(DS) + get_reg_asize(ESI);
    int32_t size = *flags & FLAG_DIRECTION ? -4 : 4;

    int32_t count = get_reg_asize(ECX);
    if(count == 0) return;
    int32_t cont = false;
    int32_t cycle_counter = MAX_COUNT_PER_CYCLE;
    do
    {
        reg32s[EAX] = safe_read32s(src);
        src += size;
        add_reg_asize(ESI, size);
        cont = decr_ecx_asize() != 0;
    }
    while(cont && cycle_counter--);
    if(cont)
    {
        *instruction_pointer = *previous_ip;
    }
}

void lodsd_no_rep()
{
    int32_t src = get_seg_prefix(DS) + get_reg_asize(ESI);
    int32_t size = *flags & FLAG_DIRECTION ? -4 : 4;

    reg32s[EAX] = safe_read32s(src);
    add_reg_asize(ESI, size);
}

void lodsd()
{
    if(*prefixes & PREFIX_MASK_REP)
    {
        lodsd_rep();
    }
    else
    {
        lodsd_no_rep();
    }
}

void scasb_rep()
{
    int32_t dest = get_seg(ES) + get_reg_asize(EDI);
    int32_t size = *flags & FLAG_DIRECTION ? -1 : 1;
    int32_t data_dest;
    int32_t data_src = reg8[AL];

    int32_t count = get_reg_asize(ECX);
    if(count == 0) return;
    int32_t cont = false;
    int32_t start_count = count;
    int32_t is_repz = (*prefixes & PREFIX_MASK_REP) == PREFIX_REPZ;
    int32_t cycle_counter = MAX_COUNT_PER_CYCLE;
    int32_t phys_dest = translate_address_read(dest);
    if(*paging)
    {
        cycle_counter = string_get_cycle_count(size, dest);
    }
    do
    {
        data_dest = read8(phys_dest);
        phys_dest += size;
        cont = --count != 0 && (data_src == data_dest) == is_repz;
    }
    while(cont && cycle_counter--);
    int32_t diff = size * (start_count - count);
    add_reg_asize(EDI, diff);
    set_ecx_asize(count);
    *timestamp_counter += start_count - count;
    if(cont)
    {
        *instruction_pointer = *previous_ip;
    }
    cmp8(data_src, data_dest);
}

void scasb_no_rep()
{
    int32_t dest = get_seg(ES) + get_reg_asize(EDI);
    int32_t size = *flags & FLAG_DIRECTION ? -1 : 1;
    int32_t data_dest;
    int32_t data_src = reg8[AL];

    data_dest = safe_read8(dest);
    add_reg_asize(EDI, size);
    cmp8(data_src, data_dest);
}

void scasb()
{
    if(*prefixes & PREFIX_MASK_REP)
    {
        scasb_rep();
    }
    else
    {
        scasb_no_rep();
    }
}

void scasw_rep()
{
    int32_t dest = get_seg(ES) + get_reg_asize(EDI);
    int32_t size = *flags & FLAG_DIRECTION ? -2 : 2;
    int32_t data_dest;
    int32_t data_src = reg16[AL];

    int32_t count = get_reg_asize(ECX);
    if(count == 0) return;
    int32_t cont = false;
    int32_t start_count = count;
    int32_t is_repz = (*prefixes & PREFIX_MASK_REP) == PREFIX_REPZ;
    int32_t cycle_counter = MAX_COUNT_PER_CYCLE;
    if(!(dest & 1))
    {
        int32_t single_size = size < 0 ? -1 : 1;
        int32_t phys_dest = translate_address_read(dest) >> 1;
        if(*paging)
        {
            cycle_counter = string_get_cycle_count(size, dest);
        }
        do
        {
            data_dest = read_aligned16(phys_dest);
            phys_dest += single_size;
            cont = --count != 0 && (data_src == data_dest) == is_repz;
        }
        while(cont && cycle_counter--);
        int32_t diff = size * (start_count - count);
        add_reg_asize(EDI, diff);
        set_ecx_asize(count);
        *timestamp_counter += start_count - count;
    }
    else
    {
        do
        {
            data_dest = safe_read16(dest);
            dest += size;
            add_reg_asize(EDI, size);
            cont = decr_ecx_asize() != 0 && (data_src == data_dest) == is_repz;
        }
        while(cont && cycle_counter--);
    }
    if(cont)
    {
        *instruction_pointer = *previous_ip;
    }
    cmp16(data_src, data_dest);
}

void scasw_no_rep()
{
    int32_t dest = get_seg(ES) + get_reg_asize(EDI);
    int32_t size = *flags & FLAG_DIRECTION ? -2 : 2;
    int32_t data_dest;
    int32_t data_src = reg16[AL];

    data_dest = safe_read16(dest);
    add_reg_asize(EDI, size);
    cmp16(data_src, data_dest);
}

void scasw()
{
    if(*prefixes & PREFIX_MASK_REP)
    {
        scasw_rep();
    }
    else
    {
        scasw_no_rep();
    }
}

void scasd_rep()
{
    int32_t dest = get_seg(ES) + get_reg_asize(EDI);
    int32_t size = *flags & FLAG_DIRECTION ? -4 : 4;
    int32_t data_dest;
    int32_t data_src = reg32s[EAX];

    int32_t count = get_reg_asize(ECX);
    if(count == 0) return;
    int32_t cont = false;
    int32_t start_count = count;
    int32_t is_repz = (*prefixes & PREFIX_MASK_REP) == PREFIX_REPZ;
    int32_t cycle_counter = MAX_COUNT_PER_CYCLE;
    if(!(dest & 3))
    {
        int32_t single_size = size < 0 ? -1 : 1;
        int32_t phys_dest = translate_address_read(dest) >> 2;
        if(*paging)
        {
            cycle_counter = string_get_cycle_count(size, dest);
        }
        do
        {
            data_dest = read_aligned32(phys_dest);
            phys_dest += single_size;
            cont = --count != 0 && (data_src == data_dest) == is_repz;
        }
        while(cont && cycle_counter--);
        int32_t diff = size * (start_count - count);
        add_reg_asize(EDI, diff);
        set_ecx_asize(count);
        *timestamp_counter += start_count - count;
    }
    else
    {
        do
        {
            data_dest = safe_read32s(dest);
            dest += size;
            add_reg_asize(EDI, size);
            cont = decr_ecx_asize() != 0 && (data_src == data_dest) == is_repz;
        }
        while(cont && cycle_counter--);
    }
    if(cont)
    {
        *instruction_pointer = *previous_ip;
    }
    cmp32(data_src, data_dest);
}

void scasd_no_rep()
{
    int32_t dest = get_seg(ES) + get_reg_asize(EDI);
    int32_t size = *flags & FLAG_DIRECTION ? -4 : 4;
    int32_t data_dest;
    int32_t data_src = reg32s[EAX];

    data_dest = safe_read32s(dest);
    add_reg_asize(EDI, size);
    cmp32(data_src, data_dest);
}


void scasd()
{
    if(*prefixes & PREFIX_MASK_REP)
    {
        scasd_rep();
    }
    else
    {
        scasd_no_rep();
    }
}

void insb_rep()
{
    int32_t port = reg16[DX];
    test_privileges_for_io(port, 1);

    int32_t dest = get_seg(ES) + get_reg_asize(EDI);
    int32_t size = *flags & FLAG_DIRECTION ? -1 : 1;

    int32_t count = get_reg_asize(ECX);
    if(count == 0) return;
    int32_t cont = false;
    int32_t start_count = count;
    int32_t cycle_counter = MAX_COUNT_PER_CYCLE;
    int32_t phys_dest = translate_address_write(dest);
    if(*paging)
    {
        cycle_counter = string_get_cycle_count(size, dest);
    }
    do
    {
        write8(phys_dest, io_port_read8(port));
        phys_dest += size;
        cont = --count != 0;
    }
    while(cont && cycle_counter--);
    int32_t diff = size * (start_count - count);
    add_reg_asize(EDI, diff);
    set_ecx_asize(count);
    *timestamp_counter += start_count - count;
    if(cont)
    {
        *instruction_pointer = *previous_ip;
    }
}

void insb_no_rep()
{
    int32_t port = reg16[DX];
    test_privileges_for_io(port, 1);

    int32_t dest = get_seg(ES) + get_reg_asize(EDI);
    int32_t size = *flags & FLAG_DIRECTION ? -1 : 1;

    writable_or_pagefault(dest, 1);
    safe_write8(dest, io_port_read8(port));
    add_reg_asize(EDI, size);
}

void insb()
{
    if(*prefixes & PREFIX_MASK_REP)
    {
        insb_rep();
    }
    else
    {
        insb_no_rep();
    }
}

void insw_rep()
{
    int32_t port = reg16[DX];
    test_privileges_for_io(port, 2);

    int32_t dest = get_seg(ES) + get_reg_asize(EDI);
    int32_t size = *flags & FLAG_DIRECTION ? -2 : 2;

    int32_t count = get_reg_asize(ECX);
    if(count == 0) return;
    int32_t cont = false;
    int32_t start_count = count;
    int32_t cycle_counter = MAX_COUNT_PER_CYCLE;
    if(!(dest & 1))
    {
        int32_t single_size = size < 0 ? -1 : 1;
        int32_t phys_dest = translate_address_write(dest) >> 1;
        if(*paging)
        {
            cycle_counter = string_get_cycle_count(size, dest);
        }
        do
        {
            write_aligned16(phys_dest, io_port_read16(port));
            phys_dest += single_size;
            cont = --count != 0;
        }
        while(cont && cycle_counter--);
        int32_t diff = size * (start_count - count);
        add_reg_asize(EDI, diff);
        set_ecx_asize(count);
        *timestamp_counter += start_count - count;
    }
    else
    {
        do
        {
            safe_write16(dest, io_port_read16(port));
            dest += size;
            add_reg_asize(EDI, size);
            cont = decr_ecx_asize() != 0;
        }
        while(cont && cycle_counter--);
    }
    if(cont)
    {
        *instruction_pointer = *previous_ip;
    }
}

void insw_no_rep()
{
    int32_t port = reg16[DX];
    test_privileges_for_io(port, 2);

    int32_t dest = get_seg(ES) + get_reg_asize(EDI);
    int32_t size = *flags & FLAG_DIRECTION ? -2 : 2;

    writable_or_pagefault(dest, 2);
    safe_write16(dest, io_port_read16(port));
    add_reg_asize(EDI, size);
}

void insw()
{
    if(*prefixes & PREFIX_MASK_REP)
    {
        insw_rep();
    }
    else
    {
        insw_no_rep();
    }
}

void insd_rep()
{
    int32_t port = reg16[DX];
    test_privileges_for_io(port, 4);

    int32_t dest = get_seg(ES) + get_reg_asize(EDI);
    int32_t size = *flags & FLAG_DIRECTION ? -4 : 4;

    int32_t count = get_reg_asize(ECX);
    if(count == 0) return;
    int32_t cont = false;
    int32_t start_count = count;
    int32_t cycle_counter = MAX_COUNT_PER_CYCLE;
    if(!(dest & 3))
    {
        int32_t single_size = size < 0 ? -1 : 1;
        int32_t phys_dest = translate_address_write(dest) >> 2;
        if(*paging)
        {
            cycle_counter = string_get_cycle_count(size, dest);
        }
        do
        {
            write_aligned32(phys_dest, io_port_read32(port));
            phys_dest += single_size;
            cont = --count != 0;
        }
        while(cont && cycle_counter--);
        int32_t diff = size * (start_count - count);
        add_reg_asize(EDI, diff);
        set_ecx_asize(count);
        *timestamp_counter += start_count - count;
    }
    else
    {
        do
        {
            safe_write32(dest, io_port_read32(port));
            dest += size;
            add_reg_asize(EDI, size);
            cont = decr_ecx_asize() != 0;
        }
        while(cont && cycle_counter--);
    }
    if(cont)
    {
        *instruction_pointer = *previous_ip;
    }
}

void insd_no_rep()
{
    int32_t port = reg16[DX];
    test_privileges_for_io(port, 4);

    int32_t dest = get_seg(ES) + get_reg_asize(EDI);
    int32_t size = *flags & FLAG_DIRECTION ? -4 : 4;

    writable_or_pagefault(dest, 4);
    safe_write32(dest, io_port_read32(port));
    add_reg_asize(EDI, size);
}

void insd()
{
    if(*prefixes & PREFIX_MASK_REP)
    {
        insd_rep();
    }
    else
    {
        insd_no_rep();
    }
}

void outsb_rep()
{
    int32_t port = reg16[DX];
    test_privileges_for_io(port, 1);

    int32_t src = get_seg_prefix(DS) + get_reg_asize(ESI);
    int32_t size = *flags & FLAG_DIRECTION ? -1 : 1;

    int32_t count = get_reg_asize(ECX);
    if(count == 0) return;
    int32_t cont = false;
    int32_t start_count = count;
    int32_t cycle_counter = MAX_COUNT_PER_CYCLE;
    int32_t phys_src = translate_address_read(src);
    if(*paging)
    {
        cycle_counter = string_get_cycle_count(size, src);
    }
    do
    {
        io_port_write8(port, read8(phys_src));
        phys_src += size;
        cont = --count != 0;
    }
    while(cont && cycle_counter--);
    int32_t diff = size * (start_count - count);
    add_reg_asize(ESI, diff);
    set_ecx_asize(count);
    *timestamp_counter += start_count - count;
    if(cont)
    {
        *instruction_pointer = *previous_ip;
    }
}

void outsb_no_rep()
{
    int32_t port = reg16[DX];
    test_privileges_for_io(port, 1);

    int32_t src = get_seg_prefix(DS) + get_reg_asize(ESI);
    int32_t size = *flags & FLAG_DIRECTION ? -1 : 1;

    io_port_write8(port, safe_read8(src));
    add_reg_asize(ESI, size);
}

void outsb()
{
    if(*prefixes & PREFIX_MASK_REP)
    {
        outsb_rep();
    }
    else
    {
        outsb_no_rep();
    }
}

void outsw_rep()
{
    int32_t port = reg16[DX];
    test_privileges_for_io(port, 2);

    int32_t src = get_seg_prefix(DS) + get_reg_asize(ESI);
    int32_t size = *flags & FLAG_DIRECTION ? -2 : 2;

    int32_t count = get_reg_asize(ECX);
    if(count == 0) return;
    int32_t cont = false;
    int32_t start_count = count;
    int32_t cycle_counter = MAX_COUNT_PER_CYCLE;
    if(!(src & 1))
    {
        int32_t single_size = size < 0 ? -1 : 1;
        int32_t phys_src = translate_address_read(src) >> 1;
        if(*paging)
        {
            cycle_counter = string_get_cycle_count(size, src);
        }
        do
        {
            io_port_write16(port, read_aligned16(phys_src));
            phys_src += single_size;
            cont = --count != 0;
        }
        while(cont && cycle_counter--);
        int32_t diff = size * (start_count - count);
        add_reg_asize(ESI, diff);
        set_ecx_asize(count);
        *timestamp_counter += start_count - count;
    }
    else
    {
        do
        {
            io_port_write16(port, safe_read16(src));
            src += size;
            add_reg_asize(ESI, size);
            cont = decr_ecx_asize() != 0;
        }
        while(cont && cycle_counter--);
    }
    if(cont)
    {
        *instruction_pointer = *previous_ip;
    }
}

void outsw_no_rep()
{
    int32_t port = reg16[DX];
    test_privileges_for_io(port, 2);

    int32_t src = get_seg_prefix(DS) + get_reg_asize(ESI);
    int32_t size = *flags & FLAG_DIRECTION ? -2 : 2;

    io_port_write16(port, safe_read16(src));
    add_reg_asize(ESI, size);
}

void outsw()
{
    if(*prefixes & PREFIX_MASK_REP)
    {
        outsw_rep();
    }
    else
    {
        outsw_no_rep();
    }
}

void outsd_rep()
{
    int32_t port = reg16[DX];
    test_privileges_for_io(port, 4);

    int32_t src = get_seg_prefix(DS) + get_reg_asize(ESI);
    int32_t size = *flags & FLAG_DIRECTION ? -4 : 4;

    int32_t count = get_reg_asize(ECX);
    if(count == 0) return;
    int32_t cont = false;
    int32_t start_count = count;
    int32_t cycle_counter = MAX_COUNT_PER_CYCLE;
    if(!(src & 3))
    {
        int32_t single_size = size < 0 ? -1 : 1;
        int32_t phys_src = translate_address_read(src) >> 2;
        if(*paging)
        {
            cycle_counter = string_get_cycle_count(size, src);
        }
        do
        {
            io_port_write32(port, read_aligned32(phys_src));
            phys_src += single_size;
            cont = --count != 0;
        }
        while(cont && cycle_counter--);
        int32_t diff = size * (start_count - count);
        add_reg_asize(ESI, diff);
        set_ecx_asize(count);
        *timestamp_counter += start_count - count;
    }
    else
    {
        do
        {
            io_port_write32(port, safe_read32s(src));
            src += size;
            add_reg_asize(ESI, size);
            cont = decr_ecx_asize() != 0;
        }
        while(cont && cycle_counter--);
    }
    if(cont)
    {
        *instruction_pointer = *previous_ip;
    }
}

void outsd_no_rep()
{
    int32_t port = reg16[DX];
    test_privileges_for_io(port, 4);

    int32_t src = get_seg_prefix(DS) + get_reg_asize(ESI);
    int32_t size = *flags & FLAG_DIRECTION ? -4 : 4;

    io_port_write32(port, safe_read32s(src));
    add_reg_asize(ESI, size);
}

void outsd()
{
    if(*prefixes & PREFIX_MASK_REP)
    {
        outsd_rep();
    }
    else
    {
        outsd_no_rep();
    }
}
