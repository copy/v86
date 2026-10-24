/* The AArch32 process probe (docs/aarch32-plan.md Q5.1): a static
 * freestanding ARM EABI program, built for A32 and for T32
 * (tests/a64/linux_boot.mjs with A64_WORKLOAD=aarch32), that a 64-bit
 * kernel runs as a compat task. It prints one A32_PROBE line of what it
 * found, the same on the reference (QEMU's cortex-a35) and on v86's
 * profile v3: the compat syscalls (uname, getpid, clock_gettime64, mmap2,
 * mprotect, the ARM private set_tls and cacheflush), the auxiliary vector's
 * HWCAP and HWCAP2, /proc/cpuinfo's Features as a 32-bit process sees
 * them, signals through the kernel's return trampoline (the VFP registers
 * and FPSCR restored after a handler changed them), SIGILL of an UNDEFINED
 * instruction (its address, the handler stepping over it), threads that
 * count with LDREX/STREX and keep their own D0-D31 and FPSCR across
 * sched_yield, the TLS registers (TPIDRURO from set_tls, TPIDRURW written
 * at EL0), unaligned loads, SDIV and UDIV, a generated function run after
 * cacheflush, and known answers of NEON, AES, SHA-256 and VMULL.P64. */
typedef unsigned int u32;
typedef int s32;
typedef unsigned long long u64;
/* (the mode the compiler's code is in, after the file's own A32 assembly) */
#ifdef __thumb__
#define MODE ".thumb\n"
#else
#define MODE ".arm\n"
#endif

/* (what the compiler may call: it is freestanding) */
void *memset(void *d, int c, unsigned n) { unsigned char *p = d; while(n--) *p++ = (unsigned char)c; return d; }
void *memcpy(void *d, const void *s, unsigned n) { unsigned char *p = d; const unsigned char *q = s; while(n--) *p++ = *q++; return d; }
void __aeabi_memset(void *d, unsigned n, int c) { memset(d, c, n); }
void __aeabi_memclr(void *d, unsigned n) { memset(d, 0, n); }
void __aeabi_memcpy(void *d, const void *s, unsigned n) { memcpy(d, s, n); }
void __aeabi_memset4(void *d, unsigned n, int c) { memset(d, c, n); }
void __aeabi_memclr4(void *d, unsigned n) { memset(d, 0, n); }
void __aeabi_memcpy4(void *d, const void *s, unsigned n) { memcpy(d, s, n); }

enum { NR_exit = 1, NR_read = 3, NR_write = 4, NR_close = 6, NR_getpid = 20, NR_uname = 122,
    NR_mprotect = 125, NR_sched_yield = 158, NR_rt_sigaction = 174, NR_mmap2 = 192, NR_gettid = 224,
    NR_futex = 240, NR_exit_group = 248, NR_tgkill = 268, NR_openat = 322, NR_clock_gettime64 = 403,
    NR_clone = 120, NR_cacheflush = 0xf0002, NR_set_tls = 0xf0005 };

static s32 sc(u32 n, u32 a, u32 b, u32 c, u32 d, u32 e, u32 f)
{
    register u32 r7 __asm__("r7") = n;
    register u32 r0 __asm__("r0") = a;
    register u32 r1 __asm__("r1") = b;
    register u32 r2 __asm__("r2") = c;
    register u32 r3 __asm__("r3") = d;
    register u32 r4 __asm__("r4") = e;
    register u32 r5 __asm__("r5") = f;
    __asm__ volatile("svc #0" : "+r"(r0) : "r"(r7), "r"(r1), "r"(r2), "r"(r3), "r"(r4), "r"(r5) : "memory", "cc");
    return (s32)r0;
}
#define S(n, a, b, c) sc(n, (u32)(a), (u32)(b), (u32)(c), 0, 0, 0)

static u32 length(const char *s) { u32 n = 0; while(s[n]) n++; return n; }
static void out(const char *s) { S(NR_write, 1, s, length(s)); }
static void hex(u32 v) { char b[11] = "0x"; for(int i = 0; i < 8; i++) b[2 + i] = "0123456789abcdef"[v >> (28 - 4 * i) & 15]; b[10] = 0; out(b); }
static void number(u32 v) { char b[12]; int i = 11; b[i] = 0; do b[--i] = '0' + v % 10; while(v /= 10); out(b + i); }
static void die(const char *why) { out("A32_PROBE_FAIL "); out(why); out("\n"); S(NR_exit_group, 1, 0, 0); for(;;); }
static s32 check(s32 r, const char *what) { if(r < 0 && r > -4096) die(what); return r; }
static int same(const char *a, const char *b) { while(*a && *a == *b) a++, b++; return *a == *b; }

static u32 *initial_stack;
static u32 auxv(u32 type)
{
    u32 *p = initial_stack + 1 + initial_stack[0] + 1;
    while(*p) p++;
    for(p++; p[0]; p += 2) if(p[0] == type) return p[1];
    return 0;
}

/* --- signals: the kernel's trampoline (no SA_RESTORER), siginfo, ucontext --- */
struct sigaction32 { void *handler; u32 flags; void *restorer; u32 mask[2]; };
#define SA_SIGINFO 4
#define SIGILL 4
#define SIGUSR1 10
static volatile u32 usr1_seen, ill_seen, ill_address, ill_code;

static void usr1(int sig, void *info, void *context)
{
    (void)info; (void)context;
    usr1_seen = sig;
    /* (D8, D31 and FPSCR changed here: the return restores the interrupted ones) */
    __asm__ volatile("vmov.i32 d8, #0x55\n vmov.i32 d31, #0x66\n vmrs r0, fpscr\n bic r0, r0, #0xC00000\n vmsr fpscr, r0"
        ::: "r0", "d8", "d31", "memory");
}

static void ill(int sig, void *info, void *context)
{
    ill_seen = sig;
    ill_code = ((u32 *)info)[2];
    ill_address = ((u32 *)info)[3];
    /* uc_mcontext at 20: trap_no, error_code, oldmask, r0-r10, fp, ip, sp, lr, pc (92), cpsr (96) */
    u32 *pc = (u32 *)((char *)context + 92), cpsr = *(u32 *)((char *)context + 96);
    *pc += cpsr & 0x20 ? 2 : 4;
}

static void handle(int sig, void (*fn)(int, void *, void *))
{
    struct sigaction32 a = { (void *)fn, SA_SIGINFO, 0, { 0, 0 } };
    check(sc(NR_rt_sigaction, sig, (u32)&a, 0, 8, 0, 0), "rt_sigaction");
}

/* D8 and D31 with known values, FPSCR to round toward zero, SIGUSR1 to
 * itself, then what came back: the handler's changes must be gone */
static u32 signal_vfp(void)
{
    u32 d8[2], d31[2], fpscr;
    u32 pid = S(NR_getpid, 0, 0, 0), tid = S(NR_gettid, 0, 0, 0);
    __asm__ volatile(
        "vmov.i32 d8, #0x11\n vmov.i32 d31, #0x22\n"
        "vmrs r0, fpscr\n orr r0, r0, #0xC00000\n vmsr fpscr, r0\n"
        "mov r0, %[pid]\n mov r1, %[tid]\n mov r2, #10\n mov r7, #0x10C\n svc #0\n"
        "vstr d8, [%[d8]]\n vstr d31, [%[d31]]\n vmrs r0, fpscr\n str r0, [%[fpscr]]\n"
        "vmrs r0, fpscr\n bic r0, r0, #0xC00000\n vmsr fpscr, r0"
        : : [pid] "r"(pid), [tid] "r"(tid), [d8] "r"(d8), [d31] "r"(d31), [fpscr] "r"(&fpscr)
        : "r0", "r1", "r2", "r7", "d8", "d31", "memory");
    return d8[0] == 0x11 && d8[1] == 0x11 && d31[0] == 0x22 && d31[1] == 0x22 && (fpscr >> 22 & 3) == 3;
}

/* --- threads: LDREX/STREX counting, their own VFP state across yields --- */
#define THREADS 4
#define ROUNDS 20000
#define YIELDS 40
static volatile u32 counter, vfp_bad;
static volatile s32 child_tids[THREADS];
static u32 stacks[THREADS][2048] __attribute__((aligned(16)));

static void add_one(volatile u32 *p)
{
    u32 tmp, failed;
    __asm__ volatile("1: ldrex %0, [%2]\n add %0, %0, #1\n strex %1, %0, [%2]\n cmp %1, #0\n bne 1b\n dmb ish"
        : "=&r"(tmp), "=&r"(failed) : "r"(p) : "cc", "memory");
}

static void vfp_rounds(u32 seed)
{
    u32 in[64], back[64];
    for(int i = 0; i < 64; i++) in[i] = seed * 0x9E3779B9u ^ (u32)i * 0x85EBCA6Bu;
    for(int r = 0; r < YIELDS; r++)
    {
        u32 fpscr_in = ((seed + r) & 3) << 22, fpscr_out;
        __asm__ volatile(
            "vldmia %[in], {d0-d15}\n add r0, %[in], #128\n vldmia r0, {d16-d31}\n"
            "vmrs r1, fpscr\n bic r1, r1, #0xC00000\n orr r1, r1, %[mode]\n vmsr fpscr, r1\n"
            "mov r7, #158\n svc #0\n"
            "vstmia %[back], {d0-d15}\n add r0, %[back], #128\n vstmia r0, {d16-d31}\n vmrs r1, fpscr\n str r1, [%[out]]"
            : : [in] "r"(in), [back] "r"(back), [mode] "r"(fpscr_in), [out] "r"(&fpscr_out)
            : "r0", "r1", "r7", "memory", "d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9", "d10", "d11", "d12",
              "d13", "d14", "d15", "d16", "d17", "d18", "d19", "d20", "d21", "d22", "d23", "d24", "d25", "d26", "d27",
              "d28", "d29", "d30", "d31");
        for(int i = 0; i < 64; i++) if(back[i] != in[i]) vfp_bad++;
        if((fpscr_out >> 22 & 3) != ((seed + r) & 3)) vfp_bad++;
    }
}

static void worker(u32 n)
{
    for(int i = 0; i < ROUNDS; i++) add_one(&counter);
    vfp_rounds(n + 1);
}

/* spawn(fn, arg, stack_top, child_tid): a thread (CLONE_VM ... THREAD,
 * CHILD_CLEARTID: its tid word cleared and woken at exit) */
extern s32 spawn(void (*fn)(u32), u32 arg, void *stack_top, volatile s32 *child_tid);
__asm__(".text\n.arm\n.global spawn\n.type spawn, %function\nspawn:\n"
    "push {r4, r7}\n"
    "stmdb r2!, {r0, r1}\n"
    "mov r4, r3\n"
    "ldr r0, =0x350F00\n"        /* VM FS FILES SIGHAND THREAD SYSVSEM CHILD_CLEARTID */
    "mov r1, r2\n mov r2, #0\n mov r3, #0\n mov r7, #120\n svc #0\n"
    "cmp r0, #0\n bne 1f\n"
    "pop {r0, r1}\n mov r2, r0\n mov r0, r1\n blx r2\n"
    "mov r0, #0\n mov r7, #1\n svc #0\n"
    "1: pop {r4, r7}\n bx lr\n.ltorg\n" MODE);

static void join(volatile s32 *tid)
{
    for(;;)
    {
        s32 t = *tid;
        if(t == 0) return;
        sc(NR_futex, (u32)tid, 0 /* FUTEX_WAIT */, (u32)t, 0, 0, 0);
    }
}

/* --- known answers --- */
static void vector(const char *name, const u32 *v, int words)
{
    out(" "); out(name); out("=");
    for(int i = words - 1; i >= 0; i--) { char b[9]; for(int k = 0; k < 8; k++) b[k] = "0123456789abcdef"[v[i] >> (28 - 4 * k) & 15]; b[8] = 0; out(b); }
}

static void known_answers(void)
{
    static const u32 a[4] = { 0x00112233, 0x44556677, 0x8899aabb, 0xccddeeff }, b[4] = { 0x0f0e0d0c, 0x0b0a0908, 0x07060504, 0x03020100 };
    u32 r[4];
    /* NEON: VQADD.S16, VMUL.F32 and VMLA.F32 (unfused), VPADD.I32, VCNT.8 */
    __asm__ volatile("vld1.32 {q0}, [%1]\n vld1.32 {q1}, [%2]\n vqadd.s16 q2, q0, q1\n vmul.f32 q3, q0, q1\n vmla.f32 q2, q3, q1\n"
        "vpadd.i32 d4, d4, d5\n vcnt.8 d5, d6\n vst1.32 {q2}, [%0]" : : "r"(r), "r"(a), "r"(b) : "q0", "q1", "q2", "q3", "memory");
    vector("neon", r, 4);
    /* AES: one round (AESE, AESMC), its inverse (AESD, AESIMC) */
    __asm__ volatile("vld1.32 {q0}, [%1]\n vld1.32 {q1}, [%2]\n aese.8 q0, q1\n aesmc.8 q0, q0\n aesd.8 q0, q1\n aesimc.8 q0, q0\n vst1.32 {q0}, [%0]"
        : : "r"(r), "r"(a), "r"(b) : "q0", "q1", "memory");
    vector("aes", r, 4);
    /* SHA-256: SHA256H, SHA256H2, SHA256SU0, SHA256SU1; SHA-1: SHA1C, SHA1H */
    __asm__ volatile("vld1.32 {q0}, [%1]\n vld1.32 {q1}, [%2]\n vmov q2, q0\n sha256h.32 q0, q1, q2\n sha256h2.32 q1, q2, q0\n"
        "sha256su0.32 q2, q1\n sha256su1.32 q2, q0, q1\n sha1h.32 q3, q2\n sha1c.32 q2, q3, q0\n vst1.32 {q2}, [%0]"
        : : "r"(r), "r"(a), "r"(b) : "q0", "q1", "q2", "q3", "memory");
    vector("sha", r, 4);
    /* VMULL.P64 */
    __asm__ volatile("vld1.32 {d0}, [%1]\n vld1.32 {d1}, [%2]\n vmull.p64 q1, d0, d1\n vst1.32 {q1}, [%0]"
        : : "r"(r), "r"(a), "r"(b) : "q0", "q1", "memory");
    vector("pmull", r, 4);
    /* VFP: VDIV, VSQRT, VFMA.F64, VCVT to and from fixed point */
    u32 v[4];
    __asm__ volatile("vmov.f64 d0, #3.0\n vmov.f64 d1, #7.0\n vdiv.f64 d2, d1, d0\n vsqrt.f64 d3, d2\n vfma.f64 d3, d2, d1\n"
        "vmov.f32 s8, #-2.5\n vcvt.s32.f32 s8, s8, #3\n vmov s9, %1\n vcvt.f32.u32 s9, s9, #8\n vstmia %0, {d3, d4}"
        : : "r"(v), "r"(0x12345u) : "d0", "d1", "d2", "d3", "d4", "memory");
    vector("vfp", v, 4);
}

/* --- the TLS registers, unaligned loads, the divides, generated code --- */
static u32 tls_check(void)
{
    u32 ro, rw;
    check(S(NR_set_tls, 0x12345678, 0, 0), "set_tls");
    __asm__ volatile("mcr p15, 0, %2, c13, c0, 2\n mrc p15, 0, %0, c13, c0, 3\n mrc p15, 0, %1, c13, c0, 2" : "=r"(ro), "=r"(rw) : "r"(0xCAFEF00Du));
    return ro == 0x12345678 && rw == 0xCAFEF00D;
}

static u32 unaligned(void)
{
    static const unsigned char bytes[16] = { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16 };
    u32 word, half;
    __asm__ volatile("ldr %0, [%2, #1]\n ldrh %1, [%2, #3]" : "=r"(word), "=r"(half) : "r"(bytes));
    return word == 0x05040302 && half == 0x0504;
}

static u32 divides(u32 x, u32 y)
{
    s32 q;
    u32 u;
    __asm__ volatile("sdiv %0, %2, %3\n udiv %1, %2, %3" : "=r"(q), "=r"(u) : "r"(x), "r"(y));
    return (u32)q ^ u << 1;
}

static u32 generated(void)
{
    /* an A32 function in a fresh page: mov r0, #0x2A; orr r0, r0, #0x100; bx lr */
    u32 *page = (u32 *)check(sc(NR_mmap2, 0, 4096, 3 /* RW */, 0x22 /* PRIVATE ANONYMOUS */, (u32)-1, 0), "mmap2");
    page[0] = 0xE3A0002A;
    page[1] = 0xE3800C01;
    page[2] = 0xE12FFF1E;
    check(S(NR_cacheflush, page, page + 3, 0), "cacheflush");
    check(S(NR_mprotect, page, 4096, 5 /* RX */), "mprotect");
    u32 (*fn)(void) = (u32 (*)(void))page;
    return fn();
}

static void cpuinfo_features(void)
{
    static char text[4096];
    s32 fd = check(sc(NR_openat, (u32)-100, (u32)"/proc/cpuinfo", 0, 0, 0, 0), "open cpuinfo");
    s32 n = 0, r;
    while(n < (s32)sizeof(text) - 1 && (r = S(NR_read, fd, text + n, sizeof(text) - 1 - n)) > 0) n += r;
    S(NR_close, fd, 0, 0);
    text[n] = 0;
    for(char *p = text; *p; p++)
    {
        if(p[0] == 'F' && p[1] == 'e' && p[2] == 'a' && p[3] == 't')
        {
            char *e = p;
            while(*e && *e != '\n') e++;
            *e = 0;
            while(*p && *p != ':') p++;
            out(" cpuinfo=\""); out(p + 2); out("\"");
            return;
        }
    }
    out(" cpuinfo=none");
}

void entry(u32 *stack)
{
    initial_stack = stack;
    struct { char sysname[65], nodename[65], release[65], version[65], machine[65], domain[65]; } names;
    check(S(NR_uname, &names, 0, 0), "uname");
    out("A32_PROBE isa=");
#ifdef __thumb__
    out("t32");
#else
    out("a32");
#endif
    out(" machine="); out(names.machine);
    out(" hwcap="); hex(auxv(16)); out(" hwcap2="); hex(auxv(26));
    out(" platform="); out(auxv(15) ? (const char *)auxv(15) : "none");
    out(" vdso="); out(auxv(33) ? "yes" : "no");
    cpuinfo_features();
    u32 ts[4] = { 0 };
    check(sc(NR_clock_gettime64, 1 /* CLOCK_MONOTONIC */, (u32)ts, 0, 0, 0, 0), "clock_gettime64");
    out(" clock="); out(ts[0] || ts[2] ? "ok" : "zero");
    out(" tls="); number(tls_check());
    out(" unaligned="); number(unaligned());
    out(" divides="); hex(divides(0xFFFFFF85, 7));
    out(" generated="); hex(generated());

    handle(SIGUSR1, usr1);
    u32 restored = signal_vfp();
    out(" signal="); number(usr1_seen); out(" vfp_restored="); number(restored);
    handle(SIGILL, ill);
    u32 here;
    __asm__ volatile("adr %0, 1f\n 1: udf #7" : "=r"(here));
    out(" sigill="); number(ill_seen); out(" ill_code="); number(ill_code); out(" ill_at_udf="); number(ill_address == here);

    for(u32 i = 0; i < THREADS; i++)
    {
        child_tids[i] = -1;
        check(spawn(worker, i, stacks[i] + 2048, &child_tids[i]), "clone");
    }
    vfp_rounds(0);
    for(u32 i = 0; i < THREADS; i++) join(&child_tids[i]);
    out(" counter="); number(counter); out(" vfp_bad="); number(vfp_bad);
    known_answers();
    out("\n");
    S(NR_exit_group, 0, 0, 0);
}

__asm__(".text\n.arm\n.global _start\n.type _start, %function\n_start:\nmov r0, sp\nbl entry\nmov r7, #248\nmov r0, #1\nsvc #0\n" MODE);
