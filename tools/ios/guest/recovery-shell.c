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
    __asm__ volatile("svc #0x80\n\trsbcs r0, r0, #0"
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

__attribute__((noreturn)) void start(void)
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
        else if(n) put("commands: uname -a, sysctl hw\n");
    }
}
