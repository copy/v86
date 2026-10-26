// A freestanding ALSA player for tests/devices/hd_audio_guest.mjs and
// hd_audio_browser.html (x86-64 Linux, no libc): opens /dev/snd/pcmC0D0p,
// asks for interleaved S16_LE stereo at the rate given (argv[1], 48000 by
// default) through the PCM ioctls, plays seconds (argv[2], 1 by default) of a
// pattern the host recognises and drains. With argv[3] "tone" it plays a
// 1 kHz square wave instead, after switching the Master controls on and to
// their top (the driver starts them muted). Prints
// "PCM_DONE rate=<r> frames=<n> ms=<t>" or "PCM_FAIL <step> <errno>".
//   clang --target=x86_64-unknown-linux-gnu -O2 -ffreestanding -fno-stack-protector
//       -fno-pic -fno-builtin -nostdlib -static -fuse-ld=lld hd_audio_play.c

typedef unsigned long word;
typedef unsigned int u32;
typedef short s16;

static long sys(long n, word a, word b, word c)
{
    long r;
    __asm__ volatile("syscall" : "=a"(r) : "a"(n), "D"(a), "S"(b), "d"(c) : "rcx", "r11", "memory", "cc");
    return r;
}
enum { SYS_WRITE = 1, SYS_OPEN = 2, SYS_CLOSE = 3, SYS_IOCTL = 16, SYS_EXIT = 60, SYS_CLOCK_GETTIME = 228 };

static void out(const char *s) { word n = 0; while(s[n]) n++; sys(SYS_WRITE, 1, (word)s, n); }
static void out_num(long v)
{
    char b[24]; int i = 23; b[i] = 0;
    if(v < 0) { out("-"); v = -v; }
    do { b[--i] = '0' + v % 10; v /= 10; } while(v);
    out(b + i);
}
static long now_ms(void)
{
    long ts[2];
    sys(SYS_CLOCK_GETTIME, 1, (word)ts, 0);
    return ts[0] * 1000 + ts[1] / 1000000;
}
static void fail(const char *step, long e)
{
    out("PCM_FAIL "); out(step); out(" "); out_num(-e); out("\n");
    sys(SYS_EXIT, 1, 0, 0);
}

// <sound/asound.h>
struct mask { u32 bits[8]; };
struct interval { u32 min, max; u32 flags; };
#define INTERVAL_INTEGER 4
struct hw_params {
    u32 flags;
    struct mask masks[3];
    struct mask mres[5];
    struct interval intervals[12];
    struct interval ires[9];
    u32 rmask, cmask, info, msbits, rate_num, rate_den;
    word fifo_size;
    unsigned char reserved[64];
};
struct xferi { long result; void *buf; word frames; };
_Static_assert(sizeof(struct hw_params) == 608, "snd_pcm_hw_params");
struct elem_value {
    // (struct snd_ctl_elem_id)
    u32 numid, iface, device, subdevice;
    char name[44];
    u32 index;
    u32 indirect;
    long values[128];
    long tstamp[2];
    unsigned char reserved[112];
};
_Static_assert(sizeof(struct elem_value) == 1224, "snd_ctl_elem_value");
#define ELEM_WRITE ((word)3 << 30 | (word)sizeof(struct elem_value) << 16 | 'U' << 8 | 0x13)
enum { IFACE_MIXER = 2 };

#define IOC(dir, nr, size) ((word)(dir) << 30 | (word)(size) << 16 | 'A' << 8 | (nr))
#define HW_PARAMS IOC(3, 0x11, sizeof(struct hw_params))
#define PREPARE IOC(0, 0x40, 0)
#define DRAIN IOC(0, 0x44, 0)
#define WRITEI_FRAMES IOC(1, 0x50, sizeof(struct xferi))

enum { MASK_ACCESS = 0, MASK_FORMAT = 1, MASK_SUBFORMAT = 2 };
enum { CHANNELS = 10, RATE = 11, PERIOD_SIZE = 13, PERIODS = 15 };
enum { ACCESS_RW_INTERLEAVED = 3, FORMAT_S16_LE = 2 };

static struct hw_params params;
static s16 buffer[2 * 960];

static long number(const char *s, long otherwise)
{
    if(!s) return otherwise;
    long v = 0;
    while(*s >= '0' && *s <= '9') v = v * 10 + *s++ - '0';
    return v;
}

static struct elem_value elem;

/** A mixer control of card 0 to the values given (both channels) */
static void control(const char *name, long value)
{
    long fd = sys(SYS_OPEN, (word)"/dev/snd/controlC0", 2, 0);
    if(fd < 0) fail("control open", fd);
    for(word i = 0; i < sizeof elem; i++) ((char *)&elem)[i] = 0;
    elem.iface = IFACE_MIXER;
    for(int i = 0; name[i]; i++) elem.name[i] = name[i];
    elem.values[0] = elem.values[1] = value;
    long r = sys(SYS_IOCTL, fd, ELEM_WRITE, (word)&elem);
    if(r < 0) fail(name, r);
    sys(SYS_CLOSE, fd, 0, 0);
}

static void set_interval(int param, u32 value)
{
    struct interval *i = &params.intervals[param - 8];
    i->min = i->max = value;
    i->flags = INTERVAL_INTEGER;
}

void entry(word *stack)
{
    long argc = (long)stack[0];
    char **argv = (char **)(stack + 1);
    long rate = number(argc > 1 ? argv[1] : 0, 48000);
    long seconds = number(argc > 2 ? argv[2] : 0, 1);
    int tone = argc > 3 && argv[3][0] == 't';
    if(tone)
    {
        control("Master Playback Switch", 1);
        control("Master Playback Volume", 0x4A);
    }

    long fd = sys(SYS_OPEN, (word)"/dev/snd/pcmC0D0p", 2 /* O_RDWR */, 0);
    if(fd < 0) fail("open", fd);

    // everything allowed, then the format asked for; the kernel chooses the rest
    for(int m = 0; m < 3; m++) for(int w = 0; w < 8; w++) params.masks[m].bits[w] = 0xFFFFFFFF;
    for(int i = 0; i < 12; i++) { params.intervals[i].min = 0; params.intervals[i].max = 0xFFFFFFFF; params.intervals[i].flags = 0; }
    for(int w = 0; w < 8; w++) params.masks[MASK_ACCESS].bits[w] = params.masks[MASK_FORMAT].bits[w] = params.masks[MASK_SUBFORMAT].bits[w] = 0;
    params.masks[MASK_ACCESS].bits[0] = 1 << ACCESS_RW_INTERLEAVED;
    params.masks[MASK_FORMAT].bits[0] = 1 << FORMAT_S16_LE;
    params.masks[MASK_SUBFORMAT].bits[0] = 1;
    set_interval(CHANNELS, 2);
    set_interval(RATE, (u32)rate);
    set_interval(PERIOD_SIZE, 960);
    set_interval(PERIODS, 4);
    params.rmask = 0xFFFFFFFF;
    params.info = 0xFFFFFFFF;
    long r = sys(SYS_IOCTL, fd, HW_PARAMS, (word)&params);
    if(r < 0) fail("hw_params", r);
    r = sys(SYS_IOCTL, fd, PREPARE, 0);
    if(r < 0) fail("prepare", r);

    // the pattern: left = frame * 7 (16 bits), right = its complement
    long total = rate * seconds, frame = 0;
    long start = now_ms();
    while(frame < total)
    {
        long n = total - frame < 960 ? total - frame : 960;
        for(long i = 0; i < n; i++)
        {
            s16 v = (s16)((frame + i) * 7);
            // (the tone: half a period of 1 kHz up, half down)
            if(tone) v = (frame + i) * 2000 / rate % 2 ? -8000 : 8000;
            buffer[2 * i] = v;
            buffer[2 * i + 1] = tone ? v : (s16)~v;
        }
        struct xferi x = { 0, buffer, (word)n };
        r = sys(SYS_IOCTL, fd, WRITEI_FRAMES, (word)&x);
        if(r < 0) fail("writei", r);
        frame += x.result;
    }
    r = sys(SYS_IOCTL, fd, DRAIN, 0);
    if(r < 0) fail("drain", r);
    sys(SYS_CLOSE, fd, 0, 0);
    out("PCM_DONE rate="); out_num(rate); out(" frames="); out_num(frame); out(" ms="); out_num(now_ms() - start); out("\n");
    sys(SYS_EXIT, 0, 0, 0);
}

__asm__(".text\n.global _start\n_start:\nmov %rsp,%rdi\nand $-16,%rsp\ncall entry\nud2\n");
