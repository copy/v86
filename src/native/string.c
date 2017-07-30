#define MAX_COUNT_PER_CYCLE 0x1000
#define MIN(x, y) (x < y ? x : y)

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

    int32_t count = get_reg_asize(ECX) >> 0;
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
    int32_t diff = size * (start_count - count) | 0;
    add_reg_asize(EDI, diff);
    add_reg_asize(ESI, diff);
    set_ecx_asize(count);
    *timestamp_counter += start_count - count;
    if(cont)
    {
        *instruction_pointer = *previous_ip;
    }
    diverged();
}

void movsb_no_rep()
{
    int32_t src = get_seg_prefix(DS) + get_reg_asize(ESI);
    int32_t dest = get_seg(ES) + get_reg_asize(EDI);
    int32_t size = *flags & FLAG_DIRECTION ? -1 : 1;

    safe_write8(dest, safe_read8(src));
    add_reg_asize(EDI, size);
    add_reg_asize(ESI, size);
    diverged();
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

    int32_t count = get_reg_asize(ECX) >> 0;
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
        int32_t diff = size * (start_count - count) | 0;
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
    diverged();
}

void movsw_no_rep()
{
    int32_t src = get_seg_prefix(DS) + get_reg_asize(ESI);
    int32_t dest = get_seg(ES) + get_reg_asize(EDI);
    int32_t size = *flags & FLAG_DIRECTION ? -2 : 2;

    safe_write16(dest, safe_read16(src));
    add_reg_asize(EDI, size);
    add_reg_asize(ESI, size);
    diverged();
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

    int32_t count = get_reg_asize(ECX) >> 0;
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
        int32_t diff = size * (start_count - count) | 0;
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
    diverged();
}

void movsd_no_rep()
{
    int32_t src = get_seg_prefix(DS) + get_reg_asize(ESI);
    int32_t dest = get_seg(ES) + get_reg_asize(EDI);
    int32_t size = *flags & FLAG_DIRECTION ? -4 : 4;

    safe_write32(dest, safe_read32s(src));
    add_reg_asize(EDI, size);
    add_reg_asize(ESI, size);
    diverged();
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

    int32_t count = get_reg_asize(ECX) >> 0;
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
    diverged();
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
    diverged();
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

    int32_t count = get_reg_asize(ECX) >> 0;
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
        int32_t diff = size * (start_count - count) | 0;
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
    diverged();
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
    diverged();
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

    int32_t count = get_reg_asize(ECX) >> 0;
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
        int32_t diff = size * (start_count - count) | 0;
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
    diverged();
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
    diverged();
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

