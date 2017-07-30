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

