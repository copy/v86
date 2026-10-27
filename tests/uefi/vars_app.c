/* What tests/uefi/vars_resilience.mjs runs as \EFI\BOOT\BOOTX64.EFI: the
 * variable store under writes, line by line on the console ("V86VARS ...").
 * \MODE.TXT says what to do:
 *   setup G    eight marks (V86Mark0..7, 64 bytes each) and V86Big (4 KiB,
 *              generation G's pattern)
 *   write G    V86Big with generation G's pattern
 *   fill       V86Fxxxx variables of 1 KiB until the store is full
 *   delete     every other V86Fxxxx variable (the even ones)
 *   check      V86Big: which generation it holds (or "bad"); the marks
 *              intact; the V86Fxxxx variables present
 * then "V86VARS done". x86_64-w64-mingw32-gcc with the tables of efi_min.h. */
#include "efi_min.h"

static const guid_t TEST = {0x86B00F5E, 0x5B57, 0x4C1A, {0x9E, 0x2D, 0x76, 0x38, 0x36, 0x53, 0x42, 0x02}};
#define ATTRIBUTES 7 /* non-volatile, boot services, runtime */
#define BIG 4096
#define MARK 64
#define FILL 1024
#define MAX_FILL 512

static system_table *st;
static u16 line[200];
static int at;
static u8 buffer[BIG];

static void put(const char *s) { while(*s && at < 198) line[at++] = (u8)*s++; }
static void put_hex(u64 n)
{
    for(int i = 60; i >= 0; i -= 4)
    {
        if(i > 0 && !(n >> i)) continue;
        line[at++] = "0123456789abcdef"[n >> i & 15];
    }
}
static void flush(void)
{
    line[at++] = '\r';
    line[at++] = '\n';
    line[at] = 0;
    st->out->output(st->out, line);
    at = 0;
}

static u8 pattern(u32 seed, u32 i) { return (u8)(i * 7 + seed * 31); }
static void fill_pattern(u8 *data, u32 size, u32 seed) { for(u32 i = 0; i < size; i++) data[i] = pattern(seed, i); }
static int matches(const u8 *data, u32 size, u32 seed)
{
    for(u32 i = 0; i < size; i++) if(data[i] != pattern(seed, i)) return 0;
    return 1;
}

/* "V86Mark3", "V86F002a" */
static void name(u16 *out, const char *prefix, u32 n, int digits)
{
    while(*prefix) *out++ = (u8)*prefix++;
    for(int i = digits - 1; i >= 0; i--) *out++ = "0123456789abcdef"[n >> (4 * i) & 15];
    *out = 0;
}

static status_t set(const u16 *variable, u32 size, const u8 *data) { return st->rt->set_variable(variable, &TEST, ATTRIBUTES, size, data); }
static status_t get(const u16 *variable, u64 *size)
{
    u32 attributes;
    *size = BIG;
    return st->rt->get_variable(variable, &TEST, &attributes, size, buffer);
}

static void write_big(u32 generation, const char *label)
{
    fill_pattern(buffer, BIG, 1000 + generation);
    put("V86VARS ");
    put(label);
    put(" ");
    put_hex(set(u"V86Big", BIG, buffer));
    flush();
}

static void check(void)
{
    u64 size;
    status_t s = get(u"V86Big", &size);
    put("V86VARS big ");
    put_hex(s);
    put(" ");
    put_hex(size);
    put(" ");
    u32 generation = 0;
    for(u32 g = 1; g < 16 && !s && size == BIG; g++) if(matches(buffer, BIG, 1000 + g)) generation = g;
    if(generation) put_hex(generation);
    else put("bad");
    flush();
    int marks = 0;
    for(u32 i = 0; i < 8; i++)
    {
        u16 n[16];
        name(n, "V86Mark", i, 1);
        marks += !get(n, &size) && size == MARK && matches(buffer, MARK, i);
    }
    put("V86VARS marks ");
    put_hex(marks);
    flush();
    u32 present = 0, bad = 0;
    for(u32 i = 0; i < MAX_FILL; i++)
    {
        u16 n[16];
        name(n, "V86F", i, 4);
        if(get(n, &size)) continue;
        present++;
        bad += size != FILL || !matches(buffer, FILL, 2000 + i);
    }
    put("V86VARS fills ");
    put_hex(present);
    put(" bad ");
    put_hex(bad);
    flush();
}

static u32 read_number(const char *s)
{
    u32 n = 0;
    while(*s == ' ') s++;
    while(*s >= '0' && *s <= '9') n = n * 10 + (u32)(*s++ - '0');
    return n;
}

API status_t efi_main(handle_t image, system_table *system)
{
    st = system;
    st->bs->set_watchdog(0, 0, 0, 0);
    loaded_image *loaded;
    file_system *volume;
    file *root, *f;
    st->bs->handle_protocol(image, &LOADED_IMAGE, (void **)&loaded);
    st->bs->handle_protocol(loaded->device, &FILE_SYSTEM, (void **)&volume);
    volume->open_volume(volume, &root);
    char mode[32] = {0};
    u64 size = sizeof(mode) - 1;
    if(root->open(root, &f, u"\\MODE.TXT", 1, 0) || f->read(f, &size, mode))
    {
        put("V86VARS no mode");
        flush();
        return 0;
    }
    f->close(f);

    if(mode[0] == 's')
    {
        for(u32 i = 0; i < 8; i++)
        {
            u16 n[16];
            u8 data[MARK];
            name(n, "V86Mark", i, 1);
            fill_pattern(data, MARK, i);
            set(n, MARK, data);
        }
        write_big(read_number(mode + 5), "setup");
    }
    else if(mode[0] == 'w')
    {
        write_big(read_number(mode + 5), "write");
    }
    else if(mode[0] == 'f')
    {
        u32 count = 0;
        status_t s = 0;
        for(; count < MAX_FILL; count++)
        {
            u16 n[16];
            name(n, "V86F", count, 4);
            fill_pattern(buffer, FILL, 2000 + count);
            if((s = set(n, FILL, buffer))) break;
        }
        put("V86VARS fill ");
        put_hex(count);
        put(" ");
        put_hex(s);
        flush();
    }
    else if(mode[0] == 'd')
    {
        u32 deleted = 0;
        for(u32 i = 0; i < MAX_FILL; i += 2)
        {
            u16 n[16];
            name(n, "V86F", i, 4);
            if(!get(n, &size)) deleted += !set(n, 0, 0);
        }
        put("V86VARS deleted ");
        put_hex(deleted);
        flush();
    }
    check();
    put("V86VARS done");
    flush();
    return 0;
}
