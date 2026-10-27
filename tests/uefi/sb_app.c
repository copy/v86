/* What tests/uefi/secure_boot.mjs runs as \EFI\BOOT\BOOTX64.EFI (signed with
 * its test db key): Secure Boot seen from inside, line by line on the console
 * ("V86SB ..."). x86_64-w64-mingw32-gcc with the tables of efi_min.h.
 *
 * First boot (its counter variable V86SbBoot absent): LoadImage of each probe
 * in \PROBE (signed by a db key, unsigned, changed after signing, signed by a
 * key not enrolled, revoked by its hash in dbx, signed by a second key that
 * is not in db yet); SetVariable with each update in \UPDATE (the file name
 * is the variable, its data an EFI_VARIABLE_AUTHENTICATION_2 update, or raw
 * for UNSIGNED); a direct write to the variable store's flash; then the
 * second key's probe again; then a cold reset.
 * Second boot: the probes again; then Linux (\LINUX\VMLINUZ.EFI, signed, with
 * the command line of \LINUX\CMDLINE.TXT). With -DPROBE=n: a probe that only
 * returns. */
#include "efi_min.h"

#ifdef PROBE
API status_t efi_main(handle_t image, void *system)
{
    (void)image;
    (void)system;
    /* (a different constant per probe: a different image, a different hash) */
    static volatile u32 variant = PROBE;
    return variant ? 0 : 1;
}
#else

static const guid_t GLOBAL = {0x8BE4DF61, 0x93CA, 0x11d2, {0xAA, 0x0D, 0x00, 0xE0, 0x98, 0x03, 0x2B, 0x8C}};
static const guid_t SECURITY_DATABASE = {0xD719B2CB, 0x3D3A, 0x4596, {0xA3, 0xBC, 0xDA, 0xD0, 0x0E, 0x67, 0x65, 0x6F}};
static const guid_t TEST = {0x86B00F5E, 0x5B57, 0x4C1A, {0x9E, 0x2D, 0x76, 0x38, 0x36, 0x53, 0x42, 0x01}};
#define NV 1
#define BS 2
#define RT 4
#define TIME_AUTH 0x20
#define APPEND 0x40
/* the variable store: 4 GiB - the code (3.5 MiB) - the store (528 KiB), its first variable */
#define STORE_FLASH ((volatile u8 *)0xFFC00064ULL)

static system_table *st;
static handle_t self;
static file *root;
static u16 line[400];
static int at;

static void put(const char *s) { while(*s && at < 398) line[at++] = (u8)*s++; }
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
static void ascii_to_wide(const char *s, u16 *out) { while((*out++ = (u8)*s++)); }

static u64 variable_byte(const u16 *name, const guid_t *vendor)
{
    u8 value = 0xFF;
    u64 size = 1;
    u32 attributes;
    return st->rt->get_variable(name, vendor, &attributes, &size, &value) ? 0xFF : value;
}

/* a file of the volume, in pool memory */
static status_t read_file(const char *name, u8 **data, u64 *size)
{
    u16 wide[80];
    file *f;
    ascii_to_wide(name, wide);
    status_t s = root->open(root, &f, wide, 1, 0);
    if(s) return s;
    f->set_position(f, ~0ULL);
    f->get_position(f, size);
    f->set_position(f, 0);
    s = st->bs->allocate_pool(2, *size + 2, (void **)data);
    if(!s) s = f->read(f, size, *data);
    f->close(f);
    return s;
}

/* the file's device path: this volume's, then the file's node */
static void *file_path(const char *name)
{
    u8 *device;
    loaded_image *image;
    st->bs->handle_protocol(self, &LOADED_IMAGE, (void **)&image);
    if(st->bs->handle_protocol(image->device, &DEVICE_PATH, (void **)&device)) return 0;
    u64 length = 0;
    while(!(device[length] == 0x7F && device[length + 1] == 0xFF)) length += device[length + 2] | device[length + 3] << 8;
    u64 name_length = 0;
    while(name[name_length]) name_length++;
    u64 node = 4 + (name_length + 1) * 2;
    u8 *path;
    if(st->bs->allocate_pool(2, length + node + 4, (void **)&path)) return 0;
    for(u64 i = 0; i < length; i++) path[i] = device[i];
    u8 *n = path + length;
    n[0] = 4;
    n[1] = 4;
    n[2] = node & 0xFF;
    n[3] = node >> 8;
    ascii_to_wide(name, (u16 *)(n + 4));
    n += node;
    n[0] = 0x7F;
    n[1] = 0xFF;
    n[2] = 4;
    n[3] = 0;
    return path;
}

/* LoadImage from the file (the firmware verifies it), unloaded again */
static status_t probe(const char *name)
{
    handle_t h;
    status_t s = st->bs->load_image(0, self, file_path(name), 0, 0, &h);
    if(!s) st->bs->unload_image(h);
    put("V86SB load ");
    put(name);
    put(" ");
    put_hex(s);
    flush();
    return s;
}

static void probes(void)
{
    probe("\\PROBE\\DB.EFI");
    probe("\\PROBE\\UNSIGNED.EFI");
    probe("\\PROBE\\CHANGED.EFI");
    probe("\\PROBE\\OTHER.EFI");
    probe("\\PROBE\\REVOKED.EFI");
    probe("\\PROBE\\DB2.EFI");
}

/* SetVariable with an update file: name, its GUID, attributes */
static void update(const char *file_name, const char *label, const u16 *variable, const guid_t *vendor, u32 attributes)
{
    u8 *data;
    u64 size;
    status_t s = read_file(file_name, &data, &size);
    if(!s) s = st->rt->set_variable(variable, vendor, attributes, size, data);
    put("V86SB set ");
    put(label);
    put(" ");
    put_hex(s);
    flush();
}

static void flash_write(void)
{
    u8 before = STORE_FLASH[0];
    /* CFI: program (0x40), its byte; then read array */
    STORE_FLASH[0] = 0x40;
    STORE_FLASH[0] = 0x00;
    STORE_FLASH[0] = 0xFF;
    u8 after = STORE_FLASH[0];
    put("V86SB flash ");
    put_hex(before);
    put(" ");
    put_hex(after);
    flush();
}

static void boot_linux(void)
{
    u8 *cmdline;
    u64 size;
    handle_t h;
    loaded_image *image;
    if(read_file("\\LINUX\\CMDLINE.TXT", &cmdline, &size)) return;
    u16 *options;
    st->bs->allocate_pool(2, (size + 1) * 2, (void **)&options);
    for(u64 i = 0; i < size; i++) options[i] = cmdline[i] == '\n' ? 0 : cmdline[i];
    options[size] = 0;
    status_t s = st->bs->load_image(0, self, file_path("\\LINUX\\VMLINUZ.EFI"), 0, 0, &h);
    put("V86SB linux ");
    put_hex(s);
    flush();
    if(s) return;
    st->bs->handle_protocol(h, &LOADED_IMAGE, (void **)&image);
    image->options = options;
    image->options_size = (u32)(size + 1) * 2;
    st->bs->start_image(h, 0, 0);
}

API status_t efi_main(handle_t image, system_table *system)
{
    st = system;
    self = image;
    /* (the boot manager's five minutes are not enough for a slow machine) */
    st->bs->set_watchdog(0, 0, 0, 0);
    loaded_image *loaded;
    file_system *volume;
    st->bs->handle_protocol(image, &LOADED_IMAGE, (void **)&loaded);
    st->bs->handle_protocol(loaded->device, &FILE_SYSTEM, (void **)&volume);
    volume->open_volume(volume, &root);

    u8 boot = 0;
    u64 size = 1;
    u32 attributes;
    if(st->rt->get_variable(u"V86SbBoot", &TEST, &attributes, &size, &boot)) boot = 0;
    u8 next = boot + 1;
    st->rt->set_variable(u"V86SbBoot", &TEST, NV | BS | RT, 1, &next);
    put("V86SB boot ");
    put_hex(boot);
    put(" SecureBoot ");
    put_hex(variable_byte(u"SecureBoot", &GLOBAL));
    put(" SetupMode ");
    put_hex(variable_byte(u"SetupMode", &GLOBAL));
    flush();

    if(boot == 0)
    {
        probes();
        update("\\UPDATE\\UNSIGNED.BIN", "db-unsigned", u"db", &SECURITY_DATABASE, NV | BS | RT | TIME_AUTH | APPEND);
        update("\\UPDATE\\PKBYKEK.BIN", "PK-signed-by-KEK", u"PK", &GLOBAL, NV | BS | RT | TIME_AUTH);
        update("\\UPDATE\\DBXOTHER.BIN", "dbx-signed-by-other", u"dbx", &SECURITY_DATABASE, NV | BS | RT | TIME_AUTH | APPEND);
        flash_write();
        update("\\UPDATE\\DBADD.BIN", "db-append-db2", u"db", &SECURITY_DATABASE, NV | BS | RT | TIME_AUTH | APPEND);
        probe("\\PROBE\\DB2.EFI");
        update("\\UPDATE\\DBSET2.BIN", "db-set-t2", u"db", &SECURITY_DATABASE, NV | BS | RT | TIME_AUTH);
        update("\\UPDATE\\DBSET2.BIN", "db-set-t2-replayed", u"db", &SECURITY_DATABASE, NV | BS | RT | TIME_AUTH);
        update("\\UPDATE\\DBSET1.BIN", "db-set-t1-older", u"db", &SECURITY_DATABASE, NV | BS | RT | TIME_AUTH);
        put("V86SB reset");
        flush();
        st->rt->reset(0, 0, 0, 0);
    }
    probes();
    put("V86SB linux next");
    flush();
    boot_linux();
    put("V86SB end");
    flush();
    return 0;
}
#endif
