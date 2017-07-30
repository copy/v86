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

