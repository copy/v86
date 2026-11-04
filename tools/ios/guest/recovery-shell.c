// Minimal PID 1 for the private N90 restore ramdisk. Darwin ARM EABI system
// calls only: the executable starts before dyld or libSystem is available.
typedef unsigned int u32;
typedef __UINTPTR_TYPE__ word;

static int call(int number, word a, word b, word c, word d, word e, word f)
{
    register word r0 __asm__("r0") = a;
    register word r1 __asm__("r1") = b;
    register word r2 __asm__("r2") = c;
    register word r3 __asm__("r3") = d;
    register word r4 __asm__("r4") = e;
    register word r5 __asm__("r5") = f;
    register int r12 __asm__("r12") = number;
    __asm__ volatile("svc #0x80\n\t"
#ifdef __thumb__
        "it cs\n\t"
#endif
        "rsbcs r0, r0, #0"
        : "+r"(r0), "+r"(r1)
        : "r"(r2), "r"(r3), "r"(r4), "r"(r5), "r"(r12) : "cc", "memory");
    return (int)r0;
}

static int console;
static void put(const char *s)
{
    unsigned n = 0;
    while(s[n]) ++n;
    while(n)
    {
        int written = call(4, console, (word)s, n, 0, 0, 0);
        if(written <= 0) return;
        n -= written;
        s += written;
    }
}

static int equal(const char *a, const char *b)
{
    while(*a && *a == *b) { ++a; ++b; }
    return *a == *b;
}

static int query(int group, int field, void *out, u32 size)
{
    int mib[2] = { group, field };
    return call(202, (word)mib, 2, (word)out, (word)&size, 0, 0);
}

static void string_field(int group, int field)
{
    char buf[512];
    if(query(group, field, buf, sizeof(buf)) < 0) put("unavailable");
    else { buf[sizeof(buf) - 1] = 0; put(buf); }
}

static void number_field(int group, int field)
{
    u32 value;
    if(query(group, field, &value, sizeof(value)) < 0) { put("unavailable"); return; }
    char buf[11];
    int i = 10;
    buf[i] = 0;
    do { buf[--i] = '0' + value % 10; value /= 10; } while(value);
    put(buf + i);
}

#ifdef N90_TEST_NAND
// Raw I/O issues multi-page reads to both FMI buses without mounting or
// writing the system volume. Print a cumulative CRC every 4 MiB.
static unsigned char nand_block[256 * 1024] __attribute__((aligned(4096)));
static void put_hex(unsigned value)
{
    char text[9];
    for(int i = 7; i >= 0; i--) { text[i] = "0123456789abcdef"[value & 15]; value >>= 4; }
    text[8] = 0;
    put(text);
}

static void nand_crc(void)
{
    int fd = -1;
    for(unsigned i = 0; i < 300 && fd < 0; i++)
    {
        fd = call(5, (word)"/dev/rdisk0s1s1", 0, 0, 0, 0, 0);
        if(fd < 0)
        {
            int timeout[2] = { 0, 100000 };
            call(93, 0, 0, 0, 0, (word)timeout, 0);
        }
    }
    if(fd < 0) { put("NAND system device unavailable\n"); return; }
    unsigned table[256], crc = ~0u;
    for(unsigned i = 0; i < 256; i++)
    {
        unsigned v = i;
        for(unsigned bit = 0; bit < 8; bit++) v = (v >> 1) ^ (0xedb88320u & -(v & 1));
        table[i] = v;
    }
    for(unsigned n = 1; n <= 128; n++)
    {
        int size = call(3, fd, (word)nand_block, sizeof(nand_block), 0, 0, 0);
        if(size != sizeof(nand_block)) { put("NAND short read\n"); break; }
        for(unsigned i = 0; i < sizeof(nand_block); i++) crc = table[(crc ^ nand_block[i]) & 255] ^ (crc >> 8);
        if(n % 16 == 0) { put("NAND CRC "); put_hex(~crc); put("\n"); }
    }
    call(6, fd, 0, 0, 0, 0, 0);
}

// The test runner builds a dedicated, unmounted partition with this marker.
// Consume its first page on both opens so the volume header stays intact.
static int scratch_device(int flags, unsigned char *block)
{
    const char marker[] = "v86-N90-disposable-IO-test";
    int fd = call(5, (word)"/dev/rdisk0s1s2", flags, 0, 0, 0, 0);
    if(fd < 0) return -1;
    if(call(3, fd, (word)block, 8192, 0, 0, 0) == 8192)
    {
        unsigned i = 0;
        while(i < sizeof(marker) && block[i] == marker[i]) i++;
        if(i == sizeof(marker)) return fd;
    }
    call(6, fd, 0, 0, 0, 0, 0);
    return -1;
}

static unsigned char scratch_block[1024 * 1024] __attribute__((aligned(4096)));
static unsigned char pattern(unsigned i, unsigned pass)
{
    return (i * 17u + (i >> 12) * 7u + pass * 97u) & 255;
}

static void nand_roundtrip(void)
{
    for(unsigned reading = 0; reading <= 1; reading++)
    {
        int fd = scratch_device(reading ? 0 : 2, scratch_block);
        if(fd < 0) { put("NAND scratch device unavailable\n"); return; }
        int ok = 1;
        for(unsigned pass = 0; ok && pass < 4; pass++)
        {
            for(unsigned i = 0; i < sizeof(scratch_block); i++)
                scratch_block[i] = pattern(i, pass) ^ (reading ? 255 : 0);
            ok = call(reading ? 3 : 4, fd, (word)scratch_block, sizeof(scratch_block), 0, 0, 0) == sizeof(scratch_block);
            if(reading)
                for(unsigned i = 0; ok && i < sizeof(scratch_block); i++) ok = scratch_block[i] == pattern(i, pass);
        }
        call(6, fd, 0, 0, 0, 0, 0);
        if(!ok) { put("NAND scratch transfer failed\n"); return; }
    }
    put("NAND scratch 4 MiB roundtrip passed\n");
}
#endif

#ifdef N90_TEST_GLES
#include "gles-transport.h"

static int gles_display(void)
{
    int conn = gles_open();
    if(conn < 0) return 0;
    unsigned reply[3];
    int ok = 1;
    for(unsigned i = 0; ok && i < 3; i++)
        ok = SEND(conn, rc_rcGetFBParam, i + 1) && gles_read(conn, &reply[i], 4);
    return gles_call(5, 0, 0, conn) == 0 && ok && reply[0] == 640 && reply[1] == 960 && reply[2] == 326;
}

#ifdef N90_NATIVE_GL
#include "gles-driver.h"
extern void glClear(unsigned), glClearColor(float, float, float, float);
extern void glEnable(unsigned), glScissor(int, int, int, int);

static driver_word shell_tls[64] __attribute__((aligned(16)));
static driver_word frame_table[N90_GL_TABLE_WORDS];

static driver_word *thread_slots(void)
{
    driver_word tls;
    __asm__ volatile("mrc p15, 0, %0, c13, c0, 3" : "=r"(tls));
    return (driver_word *)(tls & ~(driver_word)3);
}

static void set_shell_tls(driver_word *slots)
{
    // Darwin ARM's machine-dependent thread-pointer call, as used by
    // libSystem before pthreads are available in a newly started process.
    register driver_word r0 __asm__("r0") = (driver_word)slots;
    register unsigned r3 __asm__("r3") = 2;
    register unsigned r12 __asm__("r12") = 0x80000000;
    __asm__ volatile("svc #0x80" : "+r"(r0) : "r"(r3), "r"(r12) : "memory", "cc");
}
#endif

static int draw_pattern(unsigned conn)
{
#ifdef N90_NATIVE_GL
    struct n90_driver driver = { conn, 1 };
    driver_word *original = thread_slots();
    if(!original) set_shell_tls(shell_tls);
    driver_word *slots = thread_slots();
    if(!slots) return 0;
    driver_word saved = slots[30];
    install_frame_slots(frame_table, &driver);
    slots[30] = (driver_word)frame_table;
    glClearColor(0, 1, 0, 1); glClear(0x4000);
    glEnable(0x0c11); glScissor(0, 0, 2, 2);
    glClearColor(1, 0, 0, 1); glClear(0x4000);
    slots[30] = saved;
    if(!original) set_shell_tls(0);
    return driver.ok;
#else
    const unsigned one = 0x3f800000;
    return SEND(conn, gles2_glClearColor, 0, one, 0, one) && SEND(conn, gles2_glClear, 0x4000) &&
        SEND(conn, gles2_glEnable, 0x0c11) && SEND(conn, gles2_glScissor, 0, 0, 2, 2) &&
        SEND(conn, gles2_glClearColor, one, 0, 0, one) && SEND(conn, gles2_glClear, 0x4000);
#endif
}

static int gles_pattern(int conn)
{
    unsigned ctx, surface, buffer, result;
    if(!SEND(conn, rc_rcCreateContext, 3, 0, 2) || !gles_read(conn, &ctx, 4) || !ctx ||
        !SEND(conn, rc_rcCreateWindowSurface, 3, 640, 960) || !gles_read(conn, &surface, 4) || !surface ||
        !SEND(conn, rc_rcCreateColorBuffer, 640, 960, 0x1908) || !gles_read(conn, &buffer, 4) || !buffer ||
        !SEND(conn, rc_rcSetWindowColorBuffer, surface, buffer) ||
        !SEND(conn, rc_rcMakeCurrent, ctx, surface, surface) || !gles_read(conn, &result, 4) || result != 1)
        return 0;
    unsigned char pixels[8 * 8 * 4];
    if(!draw_pattern(conn) || !SEND(conn, rc_rcFlushWindowColorBuffer, surface) || !gles_read(conn, &result, 4) || result != 0 ||
        !SEND(conn, rc_rcFBPost, buffer) ||
        !SEND(conn, rc_rcReadColorBuffer, buffer, 0, 952, 8, 8, 0x1908, 0x1401, sizeof(pixels)) ||
        !gles_read(conn, pixels, sizeof(pixels)))
        return 0;
    for(unsigned i = 0; i < 64; i++)
    {
        const int red = i / 8 >= 6 && i % 8 < 2;
        if(pixels[4 * i] != (red ? 255 : 0) || pixels[4 * i + 1] != (red ? 0 : 255) ||
            pixels[4 * i + 2] != 0 || pixels[4 * i + 3] != 255) return 0;
    }
    return 1;
}
#endif

#ifdef __thumb__
// LC_UNIXTHREAD starts this SDK-free executable in ARM state on iOS 6.
__attribute__((target("arm"), naked, noreturn)) void start(void)
{
    __asm__ volatile("ldr r12, =_recovery_main\n\tbx r12");
}
__attribute__((used, noreturn)) static void recovery_main(void)
#else
__attribute__((noreturn)) void start(void)
#endif
{
    console = call(5, (word)"/dev/console", 2, 0, 0, 0, 0);
    if(console < 0) console = 1;
    put("\nN90 recovery shell\n");
    for(;;)
    {
        char line[80];
        unsigned n = 0;
        put("# ");
        for(;;)
        {
            char ch;
            if(call(3, console, (word)&ch, 1, 0, 0, 0) != 1) continue;
            if(ch == '\r' || ch == '\n') break;
            if(ch == 8 || ch == 127) { if(n) --n; }
            else if(n < sizeof(line) - 1) line[n++] = ch;
        }
        line[n] = 0;
        if(equal(line, "uname -a"))
        {
            string_field(1, 1); put(" "); string_field(1, 2); put(" ");
            string_field(1, 4); put(" "); string_field(6, 1); put("\n");
        }
        else if(equal(line, "sysctl hw"))
        {
            put("hw.machine = "); string_field(6, 1);
            put("\nhw.ncpu = "); number_field(6, 3);
            put("\nhw.physmem = "); number_field(6, 5); put("\n");
        }
#ifdef N90_TEST_GLES
        else if(equal(line, "gles display"))
            put(gles_display() ? "GLES display 640x960 326 dpi\n" : "GLES display query failed\n");
        else if(equal(line, "gles frame"))
        {
            int conn = gles_open();
            int ok = conn > 0 && gles_pattern(conn);
            if(conn > 0) gles_call(5, 0, 0, conn);
#ifdef N90_NATIVE_GL
            if(ok) put("Native OpenGLES driver callbacks completed\n");
#endif
            put(ok ? "GLES frame matched 64 pixels\n" : "GLES frame failed\n");
        }
#endif
#ifdef N90_TEST_NAND
        else if(equal(line, "nand crc")) nand_crc();
        else if(equal(line, "nand roundtrip")) nand_roundtrip();
#endif
        else if(n) put("commands: uname -a, sysctl hw\n");
    }
}
