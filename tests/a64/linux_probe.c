/* Freestanding Linux user probe for aarch64 (docs/arm64-virt-android16-plan.md
 * "aarch64 probe", P0.4): the multicore OS contract of tests/x64/linux_probe.c
 * on arm64's system call ABI (svc #0, asm-generic numbers), with arm64's own
 * checks. No libc; the page size comes from AT_PAGESZ.
 *
 * A64_PROBE_OK: uname, mmap/mprotect with a SIGSEGV round trip (the fault
 * address from siginfo and from sigcontext, the ESR from esr_context),
 * fork/wait4, a thread bound to each online CPU incrementing a counter 20000
 * times with LDXR/STXR, a cross-CPU TLB shootdown after MAP_FIXED (arm64
 * Linux uses TLBI broadcasts, no IPI), tmpfs file I/O, the frames of 16 MiB
 * of touched pages at or above a PFN (pagemap; the argument "high=<pfn>"),
 * AT_HWCAP and /proc/cpuinfo's Features against the profile, MRS of
 * ID_AA64ISAR0_EL1 at EL0 (the kernel's sanitized value), DC ZVA.
 *
 * A64_PROBE_XC: /sys topology, migrations, signals to threads on other CPUs,
 * code rewritten on one CPU and executed on another (DC CVAU, DSB, IC IVAU,
 * DSB, ISB, the steps CTR_EL0 makes unnecessary skipped), a memfd mapped RW
 * and RX (an ART JIT code page's stand-in), exclusive ABA (another CPU writes
 * the same value back: the STXR must fail), futex ping-pong across CPUs,
 * CNTVCT and the vDSO's clock never going back across CPUs, FPCR, FPSR and
 * V0-V31 across system calls, migration and signals, an AArch32 ELF
 * (ENOEXEC: v1 has no AArch32), and an O_DIRECT read of the probe disk found
 * by its virtio-blk serial "a64probe" (direct_io=1; "nodisk": direct_io=0).
 *
 * A64_PROBE_NET (argument "net"): raw frames of EtherType 88B5 through eth0
 * come back unchanged from the host's echo, the socket with a cBPF filter
 * (the kernel's BPF JIT makes A64 code for it).
 *
 * A64_MEMTEST (arguments "memtest=<MiB>" and "high=<pfn>", P8.5): first,
 * that much memory mapped, written and checked in 64 MiB pieces, its frames
 * counted at or above the PFN (extended RAM); in a page there, code run
 * until it is compiled, rewritten and run again, an exclusive counter and
 * DC ZVA. Then the probe goes on.
 *
 * "ref=qemu": the reference run on QEMU's cortex-a35 (which has AArch32 and
 * whose STXR compares values): excl_aba and aarch32 are only reported. */
typedef long word;
typedef unsigned long uword;
enum { SYS_getcwd = 17, SYS_ioctl = 29, SYS_unlinkat = 35, SYS_ftruncate = 46, SYS_openat = 56, SYS_close = 57,
    SYS_pipe2 = 59, SYS_getdents64 = 61, SYS_lseek = 62, SYS_read = 63, SYS_write = 64, SYS_exit = 93,
    SYS_exit_group = 94, SYS_futex = 98, SYS_clock_gettime = 113, SYS_sched_setaffinity = 122,
    SYS_sched_getaffinity = 123, SYS_sched_yield = 124, SYS_tgkill = 131, SYS_rt_sigaction = 134,
    SYS_rt_sigreturn = 139, SYS_uname = 160, SYS_getcpu = 168, SYS_getpid = 172, SYS_gettid = 178,
    SYS_socket = 198, SYS_bind = 200, SYS_sendto = 206, SYS_recvfrom = 207, SYS_setsockopt = 208,
    SYS_munmap = 215, SYS_clone = 220, SYS_execve = 221, SYS_mmap = 222, SYS_mprotect = 226, SYS_wait4 = 260,
    SYS_memfd_create = 279 };
#define AT_FDCWD (-100)
static word sc(word n, word a, word b, word c, word d, word e, word f)
{
    register word x8 __asm__("x8") = n;
    register word x0 __asm__("x0") = a;
    register word x1 __asm__("x1") = b;
    register word x2 __asm__("x2") = c;
    register word x3 __asm__("x3") = d;
    register word x4 __asm__("x4") = e;
    register word x5 __asm__("x5") = f;
    __asm__ volatile("svc #0" : "+r"(x0) : "r"(x8), "r"(x1), "r"(x2), "r"(x3), "r"(x4), "r"(x5) : "memory", "cc");
    return x0;
}
__asm__(".text\n.global signal_return\nsignal_return:\nmov x8, #139\nsvc #0\nbrk #0\n"
    /* spawn(fn, arg, stack_top, flags): the child takes fn and arg from its stack */
    ".global spawn\nspawn:\nsub x2, x2, #16\nstp x0, x1, [x2]\nmov x0, x3\nmov x1, x2\n"
    "mov x2, xzr\nmov x3, xzr\nmov x4, xzr\nmov x8, #220\nsvc #0\ncbnz x0, 1f\n"
    "ldp x9, x0, [sp], #16\nblr x9\nmov x0, xzr\nmov x8, #93\nsvc #0\nbrk #0\n1:\nret\n"
    ".global _start\n_start:\nmov x0, sp\nbl entry\nbrk #0\n");
#define S(n, a, b, c) sc(n, (word)(a), (word)(b), (word)(c), 0, 0, 0)

void *memset(void *d, int v, unsigned long n) { unsigned char *p = d; while(n--) *p++ = (unsigned char)v; return d; }
void *memcpy(void *d, const void *s, unsigned long n) { unsigned char *p = d; const unsigned char *q = s; while(n--) *p++ = *q++; return d; }
extern void signal_return(void);
extern word spawn(void (*fn)(word), word arg, void *stack_top, word flags);

static int length(const char *s) { int n = 0; while(s[n]) n++; return n; }
static void out(const char *s) { S(SYS_write, 1, s, length(s)); }
static void number(unsigned long n) { char b[24]; int i = 23; b[i] = 0; do { b[--i] = '0' + n % 10; n /= 10; } while(n); out(b + i); }
static void hex(unsigned long n) { char b[20]; int i = 19; b[i] = 0; do { b[--i] = "0123456789abcdef"[n & 15]; n >>= 4; } while(n); b[--i] = 'x'; b[--i] = '0'; out(b + i); }
static void die(const char *s) { out("A64_PROBE_FAIL arch=aarch64 "); out(s); out("\n"); S(SYS_exit_group, 1, 0, 0); for(;;); }
static word check(word n, const char *s) { if(n < 0 && n > -4096) die(s); return n; }
static int same(const char *a, const char *b) { while(*a && *a == *b) { a++; b++; } return *a == *b; }
static int starts(const char *a, const char *prefix) { while(*prefix) if(*a++ != *prefix++) return 0; return 1; }
static unsigned long parse(const char *s) { unsigned long n = 0; while(*s >= '0' && *s <= '9') n = n * 10 + (unsigned long)(*s++ - '0'); return n; }

/* atomics: LDAXR/STLXR loops (Alpine's musl builds them the same way) */
static void add(volatile unsigned *p, unsigned v)
{
    unsigned value, failed;
    __asm__ volatile("1: ldaxr %w0, [%2]\nadd %w0, %w0, %w3\nstlxr %w1, %w0, [%2]\ncbnz %w1, 1b"
        : "=&r"(value), "=&r"(failed) : "r"(p), "r"(v) : "memory");
}
static void barrier(void) { __asm__ volatile("dmb ish" ::: "memory"); }

static word *mapping(word size, int prot) { return (word *)sc(SYS_mmap, 0, size, prot, 0x22, -1, 0); }
static int failed_mapping(void *p) { return (uword)p >= (uword)-4096; }
static uword page_size;

struct sigaction_arm64 { void *handler; uword flags; void *restorer; uword mask; };
static void on_signal(int sig, void (*handler)(int, void *, void *))
{
    /* SA_SIGINFO | SA_RESTORER */
    struct sigaction_arm64 action = {(void *)handler, 0x04000004, (void *)signal_return, 0};
    check(sc(SYS_rt_sigaction, sig, (word)&action, 0, 8, 0, 0), "sigaction");
}

/* The signal frame: siginfo's si_addr at 16; the ucontext's mcontext at
 * 176 (uc_flags, uc_link, uc_stack, uc_sigmask and arm64's padding of the
 * mask to 1024 bits, aligned to 16): fault_address, x0-x30, sp, pc, pstate,
 * then the 16-aligned __reserved records ({magic, size}: fpsimd 0x46508001,
 * esr 0x45535201, end 0). */
#define MCONTEXT 176
static uword record(void *context, unsigned magic)
{
    unsigned char *r = (unsigned char *)context + MCONTEXT + 8 + 31 * 8 + 3 * 8;
    r = (unsigned char *)(((uword)r + 15) & ~(uword)15);
    for(int n = 0; n < 64; n++)
    {
        unsigned m = *(unsigned *)r, size = *(unsigned *)(r + 4);
        if(m == magic) return (uword)r;
        if(m == 0 || size == 0) return 0;
        r += size;
    }
    return 0;
}
static volatile uword fault_address, fault_far, fault_esr;
static volatile word *protected_page;
static void segv(int sig, void *info, void *context)
{
    (void)sig;
    fault_address = *(uword *)((char *)info + 16);
    fault_far = *(uword *)((char *)context + MCONTEXT);
    uword esr = record(context, 0x45535201);
    fault_esr = esr ? *(uword *)(esr + 8) : ~0ul;
    check(S(SYS_mprotect, protected_page, page_size, 3), "mprotect restore");
}

#define THREADS 8
#define ITERATIONS 20000
static unsigned cpus;
static volatile unsigned counter, finished, bound[THREADS];
static volatile word *watched;
static volatile unsigned readers, remapped, stale;
static char stacks[THREADS][32768] __attribute__((aligned(16)));
static void set_cpu(unsigned cpu)
{
    uword mask = 1ul << cpu;
    check(S(SYS_sched_setaffinity, 0, sizeof(mask), &mask), "affinity");
}
static unsigned current_cpu(void) { unsigned cpu = ~0u; check(S(SYS_getcpu, &cpu, 0, 0), "getcpu"); return cpu; }
static void worker(word id)
{
    set_cpu((unsigned)id % cpus);
    if(current_cpu() != (unsigned)id % cpus) die("thread migration");
    bound[id] = current_cpu() + 1;
    for(int i = 0; i < ITERATIONS; i++)
    {
        add(&counter, 1);
        if((i & 1023) == 0) S(SYS_sched_yield, 0, 0, 0);
    }
    word seen = 0;
    add(&readers, 1);
    while(!remapped) seen += *watched;
    barrier();
    if(*watched != 2) add(&stale, 1);
    (void)seen;
    add(&finished, 1);
}

static word read_file(const char *path, char *buffer, word size)
{
    word fd = check(sc(SYS_openat, AT_FDCWD, (word)path, 0, 0, 0, 0), path);
    word n = 0, k;
    while(n < size - 1 && (k = check(S(SYS_read, fd, buffer + n, size - 1 - n), path)) > 0) n += k;
    S(SYS_close, fd, 0, 0);
    buffer[n] = 0;
    return n;
}

/* The auxiliary vector follows argv and envp on the initial stack */
static word *initial_stack;
static uword auxv(uword type)
{
    word *p = initial_stack + 1 + initial_stack[0] + 1;
    while(*p) p++;
    for(p++; p[0]; p += 2) if((uword)p[0] == type) return (uword)p[1];
    return 0;
}
static const char *argument(const char *prefix)
{
    for(word i = 1; i < initial_stack[0]; i++)
        if(starts((const char *)initial_stack[1 + i], prefix)) return (const char *)initial_stack[1 + i] + length(prefix);
    return 0;
}
static int reference;

/* --- the multicore matrix (A64_PROBE_XC) --- */
#define MIGRATIONS 24
#define SIGNALS 16
#define SMC_ROUNDS 64
static volatile word tids[THREADS];
static volatile unsigned signalled[THREADS], moved[THREADS], xc_done, xc_ready;
static volatile unsigned smc_sequence, smc_ack, smc_bad;
static char xc_stacks[THREADS][32768] __attribute__((aligned(16)));
static unsigned *smc_code;
static uword ctr;
static void rt_signal(int sig, void *info, void *context)
{
    (void)sig; (void)info; (void)context;
    word tid = S(SYS_gettid, 0, 0, 0);
    for(unsigned id = 0; id < THREADS; id++) if(tids[id] == tid) add(&signalled[id], 1);
}
/* Make `count` instruction words at `code` (written through `data`, the same
 * memory) visible to instruction fetch on every CPU */
static void sync_code(void *data, void *code, uword count)
{
    uword dline = 4u << (ctr >> 16 & 15), iline = 4u << (ctr & 15);
    if(!(ctr >> 28 & 1)) /* IDC */
        for(uword a = (uword)data & ~(dline - 1); a < (uword)data + count * 4; a += dline) __asm__ volatile("dc cvau, %0" :: "r"(a) : "memory");
    __asm__ volatile("dsb ish" ::: "memory");
    if(!(ctr >> 29 & 1)) /* DIC */
        for(uword a = (uword)code & ~(iline - 1); a < (uword)code + count * 4; a += iline) __asm__ volatile("ic ivau, %0" :: "r"(a) : "memory");
    __asm__ volatile("dsb ish" ::: "memory");
}
/* movz w0, #value; mov w1, #100; 1: subs w1, w1, #1; b.ne 1b; ret */
static void write_function(unsigned *at, unsigned value)
{
    at[0] = 0x52800000u | (value & 0xFFFF) << 5;
    at[1] = 0x52800C81u;
    at[2] = 0x71000421u;
    at[3] = 0x54FFFFE1u;
    at[4] = 0xD65F03C0u;
}
static unsigned call(void *code) { __asm__ volatile("isb" ::: "memory"); return ((unsigned (*)(void))code)(); }

/* --- A64_MEMTEST: extended RAM (P8.5) --- */
#define MEMTEST_PIECE (64ul << 20)
static unsigned long long memtest_frames[512];
/* The frames of `pages` pages from `at` (pagemap), each present */
static void frames_of(word map, unsigned char *at, uword pages)
{
    check(S(SYS_lseek, map, (uword)at / page_size * 8, 0), "pagemap seek");
    for(word done = 0, n; done < (word)(pages * 8); done += n)
        if((n = check(S(SYS_read, map, (char *)memtest_frames + done, pages * 8 - done), "pagemap read")) == 0) die("pagemap eof");
    for(uword i = 0; i < pages; i++) if(!(memtest_frames[i] >> 63)) die("memtest page not present");
}
static void memtest(uword mib, uword threshold)
{
    static unsigned char *pieces[1024];
    uword count = mib / 64, errors = 0, above = 0, pages = 0, last = page_size / 8 - 1;
    if(count == 0 || count > 1024) die("memtest size");
    for(uword p = 0; p < count; p++)
    {
        pieces[p] = (unsigned char *)mapping(MEMTEST_PIECE, 3);
        if(failed_mapping(pieces[p])) die("memtest mmap");
        for(uword offset = 0; offset < MEMTEST_PIECE; offset += page_size)
        {
            uword *w = (uword *)(pieces[p] + offset);
            w[0] = (uword)(pieces[p] + offset) ^ 0x5A5A5A5A5A5A5A5Aul;
            w[last] = p * MEMTEST_PIECE + offset;
        }
    }
    word map = check(sc(SYS_openat, AT_FDCWD, (word)"/proc/self/pagemap", 0, 0, 0, 0), "open pagemap");
    unsigned char *high = 0;
    for(uword p = 0; p < count; p++)
    {
        for(uword offset = 0; offset < MEMTEST_PIECE; offset += page_size)
        {
            uword *w = (uword *)(pieces[p] + offset);
            if(w[0] != ((uword)(pieces[p] + offset) ^ 0x5A5A5A5A5A5A5A5Aul) || w[last] != p * MEMTEST_PIECE + offset) errors++;
        }
        for(uword first = 0; first < MEMTEST_PIECE / page_size; first += 512)
        {
            uword n = MEMTEST_PIECE / page_size - first < 512 ? MEMTEST_PIECE / page_size - first : 512;
            frames_of(map, pieces[p] + first * page_size, n);
            for(uword i = 0; i < n; i++)
            {
                if((memtest_frames[i] & ((1ull << 55) - 1)) >= threshold)
                {
                    above++;
                    if(!high) high = pieces[p] + (first + i) * page_size;
                }
                pages++;
            }
        }
    }
    /* code, an exclusive counter and DC ZVA in a page of extended RAM: the
     * function runs until the page tier has compiled it (its 2000th call),
     * then each rewrite (the store retires the compiled code) must show */
    unsigned code = 0, exclusive = 0, zva = 0;
    if(high)
    {
        __asm__ volatile("mrs %0, ctr_el0" : "=r"(ctr));
        check(S(SYS_mprotect, high, page_size, 7), "mprotect exec");
        unsigned *function = (unsigned *)(high + 1024);
        code = 1;
        for(unsigned round = 1; round <= 16; round++)
        {
            write_function(function, round * 7 + 1);
            sync_code(function, function, 5);
            for(unsigned n = 0; n < 2000; n++) if(call(function) != round * 7 + 1) { code = 0; break; }
        }
        volatile unsigned *counter_there = (volatile unsigned *)(high + 64);
        *counter_there = 0;
        for(unsigned n = 0; n < 10000; n++) add(counter_there, 1);
        exclusive = *counter_there == 10000;
        memset(high + 2048, 0xFF, 256);
        __asm__ volatile("dc zva, %0" :: "r"(high + 2048 + 64) : "memory");
        zva = 1;
        for(int i = 0; i < 256; i++) if(high[2048 + i] != (i >= 64 && i < 128 ? 0 : 0xFF)) zva = 0;
        /* (still in extended RAM after all that) */
        frames_of(map, high, 1);
        if((memtest_frames[0] & ((1ull << 55) - 1)) < threshold) die("memtest page moved");
    }
    S(SYS_close, map, 0, 0);
    for(uword p = 0; p < count; p++) check(S(SYS_munmap, pieces[p], MEMTEST_PIECE, 0), "memtest munmap");
    out("A64_MEMTEST mib="); number(mib); out(" pages="); number(pages); out(" errors="); number(errors);
    out(" extended_pages="); number(above); out(" code="); number(code); out(" exclusive="); number(exclusive);
    out(" zva="); number(zva); out("\n");
    if(errors) die("memtest contents");
}

static void xc_worker(word id)
{
    tids[id] = S(SYS_gettid, 0, 0, 0);
    for(unsigned k = 0; k < MIGRATIONS; k++)
    {
        unsigned target = ((unsigned)id + k) % cpus;
        set_cpu(target);
        if(current_cpu() != target) die("migration");
        add(&moved[id], 1);
    }
    set_cpu((unsigned)id % cpus);
    add(&xc_ready, 1);
    while(signalled[id] < SIGNALS) S(SYS_sched_yield, 0, 0, 0);
    /* the last worker executes the code the main thread (on CPU 0) rewrites */
    if((unsigned)id == cpus - 1)
    {
        for(unsigned round = 1; round <= SMC_ROUNDS; round++)
        {
            while(smc_sequence != round) S(SYS_sched_yield, 0, 0, 0);
            barrier();
            if(call(smc_code) != round * 3 + 1) add(&smc_bad, 1);
            barrier();
            smc_ack = round;
        }
    }
    add(&xc_done, 1);
}

/* exclusive ABA: CPU A loads a word exclusively, CPU B writes the same value
 * back, A's store-exclusive must fail (QEMU compares values: reported only) */
static volatile unsigned aba_word __attribute__((aligned(64)));
static volatile unsigned aba_phase __attribute__((aligned(64)));
static volatile unsigned aba_failures;
#define ABA_ROUNDS 32
static char aba_stack[32768] __attribute__((aligned(16)));
static void aba_writer(word unused)
{
    (void)unused;
    set_cpu(cpus > 1 ? 1 : 0);
    for(unsigned round = 1; round <= ABA_ROUNDS; round++)
    {
        while(aba_phase != round * 2 - 1) __asm__ volatile("yield");
        barrier();
        unsigned v = aba_word;
        aba_word = v;
        barrier();
        aba_phase = round * 2;
    }
}
static void exclusive_aba(void)
{
    set_cpu(0);
    check(spawn(aba_writer, 0, aba_stack + sizeof(aba_stack), 0x00050F00), "clone aba");
    for(unsigned round = 1; round <= ABA_ROUNDS; round++)
    {
        unsigned value, status;
        __asm__ volatile("ldxr %w0, [%1]" : "=&r"(value) : "r"(&aba_word) : "memory");
        __asm__ volatile("stlr %w1, [%0]" :: "r"(&aba_phase), "r"(round * 2 - 1) : "memory");
        while(aba_phase != round * 2) __asm__ volatile("yield");
        __asm__ volatile("stxr %w0, %w2, [%1]" : "=&r"(status) : "r"(&aba_word), "r"(value + 1) : "memory");
        if(status) aba_failures++;
    }
}

/* futex ping-pong across two CPUs */
#define FUTEX_ROUNDS 200
static volatile int futex_word;
static char futex_stack[32768] __attribute__((aligned(16)));
static volatile unsigned futex_done;
static void futex_partner(word unused)
{
    (void)unused;
    set_cpu(cpus > 1 ? 1 : 0);
    for(int round = 0; round < FUTEX_ROUNDS; round++)
    {
        while(futex_word != 1) sc(SYS_futex, (word)&futex_word, 0 /* WAIT */, 0, 0, 0, 0);
        futex_word = 0;
        sc(SYS_futex, (word)&futex_word, 1 /* WAKE */, 1, 0, 0, 0);
    }
    add(&futex_done, 1);
}
static void futex_pingpong(void)
{
    set_cpu(0);
    check(spawn(futex_partner, 0, futex_stack + sizeof(futex_stack), 0x00050F00), "clone futex");
    for(int round = 0; round < FUTEX_ROUNDS; round++)
    {
        futex_word = 1;
        sc(SYS_futex, (word)&futex_word, 1, 1, 0, 0, 0);
        while(futex_word != 0) sc(SYS_futex, (word)&futex_word, 0, 1, 0, 0, 0);
    }
    while(!futex_done) S(SYS_sched_yield, 0, 0, 0);
}

/* The vDSO's __kernel_clock_gettime, from its section headers */
static word (*vdso_clock_gettime)(int, void *);
static void find_vdso(void)
{
    unsigned char *base = (unsigned char *)auxv(33 /* AT_SYSINFO_EHDR */);
    if(!base) die("AT_SYSINFO_EHDR");
    uword shoff = *(uword *)(base + 40);
    unsigned shentsize = *(unsigned short *)(base + 58), shnum = *(unsigned short *)(base + 60);
    uword phoff = *(uword *)(base + 32);
    unsigned phnum = *(unsigned short *)(base + 56), phentsize = *(unsigned short *)(base + 54);
    uword load = 0;
    for(unsigned i = 0; i < phnum; i++)
    {
        unsigned char *ph = base + phoff + i * phentsize;
        if(*(unsigned *)ph == 1) { load = *(uword *)(ph + 16); break; }
    }
    for(unsigned i = 0; i < shnum; i++)
    {
        unsigned char *sh = base + shoff + i * shentsize;
        if(*(unsigned *)(sh + 4) != 11 /* SHT_DYNSYM */) continue;
        unsigned char *strtab = base + *(uword *)(base + shoff + *(unsigned *)(sh + 40) * shentsize + 24);
        unsigned char *symbols = base + *(uword *)(sh + 24);
        uword count = *(uword *)(sh + 32) / 24;
        for(uword k = 0; k < count; k++)
        {
            unsigned char *sym = symbols + k * 24;
            if(same((const char *)strtab + *(unsigned *)sym, "__kernel_clock_gettime"))
                vdso_clock_gettime = (word (*)(int, void *))(base + *(uword *)(sym + 8) - load);
        }
    }
    if(!vdso_clock_gettime) die("vDSO __kernel_clock_gettime");
}
/* CNTVCT and the vDSO's monotonic clock read on every CPU in turn: neither
 * may go back */
#define CLOCK_ROUNDS 64
static int clocks_monotonic(void)
{
    uword last_counter = 0;
    word last_ns = 0;
    for(unsigned round = 0; round < CLOCK_ROUNDS; round++)
    {
        set_cpu(round % cpus);
        uword value;
        __asm__ volatile("isb\nmrs %0, cntvct_el0" : "=r"(value) :: "memory");
        if(value < last_counter) return 0;
        last_counter = value;
        struct { word seconds, nanoseconds; } now;
        if(vdso_clock_gettime(1 /* CLOCK_MONOTONIC */, &now)) return 0;
        word ns = now.seconds * 1000000000 + now.nanoseconds;
        if(ns < last_ns) return 0;
        last_ns = ns;
    }
    return 1;
}

/* FPCR, FPSR and V0-V31 across a system call, sched_yield, a migration, a
 * signal whose handler changes them all, and a spin during which other
 * threads run; twice as many threads as CPUs */
#define FP_THREADS (2 * THREADS)
#define FP_ROUNDS 4
#define FP_SPIN 100000
static unsigned char fp_in[FP_THREADS][32 * 16 + 16] __attribute__((aligned(16)));
static unsigned char fp_out[FP_THREADS][32 * 16 + 16] __attribute__((aligned(16)));
static volatile unsigned fp_bad, fp_steps, fp_done, fp_handled;
static volatile word fp_tids[FP_THREADS];
static char fp_stacks[FP_THREADS][32768] __attribute__((aligned(16)));
static unsigned fp_threads;
#define Q_LOAD(a, b) "ldp q" #a ", q" #b ", [%[in], #" #a "*16]\n"
#define Q_STORE(a, b) "stp q" #a ", q" #b ", [%[out], #" #a "*16]\n"
#define Q_ALL(m) m(0, 1) m(2, 3) m(4, 5) m(6, 7) m(8, 9) m(10, 11) m(12, 13) m(14, 15) \
    m(16, 17) m(18, 19) m(20, 21) m(22, 23) m(24, 25) m(26, 27) m(28, 29) m(30, 31)
static word fp_step(const unsigned char *in, unsigned char *out, word n, word a, word b, word c, word spin)
{
    register word x8 __asm__("x8") = n;
    register word x0 __asm__("x0") = a;
    register word x1 __asm__("x1") = b;
    register word x2 __asm__("x2") = c;
    __asm__ volatile(Q_ALL(Q_LOAD)
        "ldr x9, [%[in], #512]\nmsr fpcr, x9\nldr x9, [%[in], #520]\nmsr fpsr, x9\n"
        "svc #0\n1: subs %[spin], %[spin], #1\nb.ne 1b\n"
        Q_ALL(Q_STORE)
        "mrs x9, fpcr\nstr x9, [%[out], #512]\nmrs x9, fpsr\nstr x9, [%[out], #520]\n"
        : "+r"(x0), [spin] "+r"(spin) : "r"(x8), "r"(x1), "r"(x2), [in] "r"(in), [out] "r"(out)
        : "x9", "memory", "cc", "v0", "v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9", "v10", "v11", "v12",
          "v13", "v14", "v15", "v16", "v17", "v18", "v19", "v20", "v21", "v22", "v23", "v24", "v25", "v26", "v27",
          "v28", "v29", "v30", "v31");
    return x0;
}
static void fp_signal(int sig, void *info, void *context)
{
    (void)sig; (void)info; (void)context;
    __asm__ volatile("movi v0.16b, #0xff\nmovi v15.16b, #0x5a\nmovi v31.16b, #0\nmsr fpsr, xzr\nmov x9, #0x00c00000\nmsr fpcr, x9"
        ::: "x9", "v0", "v15", "v31", "memory");
    add(&fp_handled, 1);
}
static void fp_worker(word id)
{
    fp_tids[id] = S(SYS_gettid, 0, 0, 0);
    word tgid = S(SYS_getpid, 0, 0, 0);
    for(unsigned round = 0; round < FP_ROUNDS; round++)
    {
        for(unsigned kind = 0; kind < 5; kind++)
        {
            unsigned char *in = fp_in[id], *o = fp_out[id];
            for(int i = 0; i < 512; i++) { in[i] = (unsigned char)(id * 37 + round * 11 + kind * 5 + i * 3 + (i >> 4)); o[i] = 0; }
            /* FPCR: a rounding mode and FZ/DN by round; FPSR: some cumulative flags and QC */
            *(uword *)(in + 512) = (uword)(round & 3) << 22 | (uword)(kind & 1) << 24 | (uword)(id & 1) << 25;
            *(uword *)(in + 520) = 0x0800001Fu & (0x08000000u | (unsigned)(id + round + kind));
            uword mask = 1ul << (((unsigned)id + round + kind) % cpus);
            switch(kind)
            {
            case 0: fp_step(in, o, SYS_getpid, 0, 0, 0, 1); break;
            case 1: fp_step(in, o, SYS_sched_yield, 0, 0, 0, 1); break;
            case 2: check(fp_step(in, o, SYS_sched_setaffinity, 0, sizeof(mask), (word)&mask, 1), "fp migration"); break;
            case 3: check(fp_step(in, o, SYS_tgkill, tgid, fp_tids[id], 42, 1), "fp tgkill"); break;
            default: fp_step(in, o, SYS_getpid, 0, 0, 0, FP_SPIN); break;
            }
            for(int i = 0; i < 528; i++) if(o[i] != in[i]) { add(&fp_bad, 1); break; }
            add(&fp_steps, 1);
        }
    }
    add(&fp_done, 1);
}
static void fp_matrix(void)
{
    on_signal(42, fp_signal);
    fp_threads = 2 * cpus;
    for(unsigned id = 0; id < fp_threads; id++)
        check(spawn(fp_worker, id, fp_stacks[id] + sizeof(fp_stacks[id]), 0x00050F00), "clone fp");
    while(fp_done != fp_threads) S(SYS_sched_yield, 0, 0, 0);
}

/* An AArch32 ELF (mov r0, #42; mov r7, #1; svc #0): ENOEXEC without AArch32 */
static const char *aarch32(void)
{
    static const unsigned char elf[] = {
        0x7F, 'E', 'L', 'F', 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        2, 0, 40, 0, 1, 0, 0, 0, 0x54, 0x80, 0, 0, 0x34, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 5, 0x34, 0, 0x20, 0, 1, 0,
        0, 0, 0, 0, 0, 0,
        1, 0, 0, 0, 0, 0, 0, 0, 0, 0x80, 0, 0, 0, 0x80, 0, 0, 0x60, 0, 0, 0, 0x60, 0, 0, 0, 5, 0, 0, 0, 0, 0x10, 0, 0,
        0x2A, 0x00, 0xA0, 0xE3, 0x01, 0x70, 0xA0, 0xE3, 0x00, 0x00, 0x00, 0xEF };
    word fd = check(sc(SYS_openat, AT_FDCWD, (word)"/tmp/a64-arm32", 01101, 0755, 0, 0), "open arm32");
    check(S(SYS_write, fd, elf, sizeof(elf)), "write arm32");
    S(SYS_close, fd, 0, 0);
    word child = check(sc(SYS_clone, 17 /* SIGCHLD */, 0, 0, 0, 0, 0), "fork arm32");
    if(child == 0)
    {
        const char *argv[] = {"/tmp/a64-arm32", 0}, *envp[] = {0};
        word r = sc(SYS_execve, (word)argv[0], (word)argv, (word)envp, 0, 0, 0);
        S(SYS_exit, r == -8 ? 8 : 1, 0, 0);
    }
    int status = 0;
    check(sc(SYS_wait4, child, (word)&status, 0, 0, 0, 0), "wait arm32");
    sc(SYS_unlinkat, AT_FDCWD, (word)"/tmp/a64-arm32", 0, 0, 0, 0);
    int code = status >> 8 & 255;
    return code == 8 ? "enoexec" : code == 42 ? "ran" : "other";
}

/* The probe disk: the virtio-blk device whose serial is a64probe */
static int direct_read(void)
{
    static char names[4096] __attribute__((aligned(8)));
    static char direct[8192] __attribute__((aligned(4096)));
    /* (arm64's own O_DIRECTORY and O_DIRECT: 040000 and 0200000) */
    word dir = check(sc(SYS_openat, AT_FDCWD, (word)"/sys/block", 040000 /* O_DIRECTORY */, 0, 0, 0), "/sys/block");
    word n = check(S(SYS_getdents64, dir, names, sizeof(names)), "getdents");
    S(SYS_close, dir, 0, 0);
    for(word at = 0; at < n; at += *(unsigned short *)(names + at + 16))
    {
        const char *name = names + at + 19;
        if(!starts(name, "vd")) continue;
        char path[64], serial[64], device[32];
        int k = 0;
        for(const char *q = "/sys/block/"; *q; q++) path[k++] = *q;
        for(const char *q = name; *q; q++) path[k++] = *q;
        for(const char *q = "/serial"; *q; q++) path[k++] = *q;
        path[k] = 0;
        word probe = sc(SYS_openat, AT_FDCWD, (word)path, 0, 0, 0, 0);
        if(probe < 0) continue;
        S(SYS_close, probe, 0, 0);
        read_file(path, serial, sizeof(serial));
        if(!starts(serial, "a64probe")) continue;
        k = 0;
        for(const char *q = "/dev/"; *q; q++) device[k++] = *q;
        for(const char *q = name; *q; q++) device[k++] = *q;
        device[k] = 0;
        word disk = check(sc(SYS_openat, AT_FDCWD, (word)device, 0200000 /* O_DIRECT */, 0, 0, 0), "open O_DIRECT");
        if(check(S(SYS_read, disk, direct, 4096), "direct read") != 4096) die("direct read length");
        S(SYS_close, disk, 0, 0);
        if(!(direct[257] == 'u' && direct[258] == 's' && direct[259] == 't' && direct[260] == 'a' && direct[261] == 'r')) die("direct read contents");
        return 1;
    }
    die("no virtio-blk disk with serial a64probe");
    return 0;
}

static void matrix(int disk)
{
    char path[80], text[64];
    unsigned cores_seen = 0;
    for(unsigned cpu = 0; cpu < cpus; cpu++)
    {
        const char *parts[3] = {"physical_package_id", "core_id", "thread_siblings_list"};
        unsigned long values[3];
        for(int k = 0; k < 3; k++)
        {
            int n = 0;
            for(const char *q = "/sys/devices/system/cpu/cpu"; *q; q++) path[n++] = *q;
            char digits[8]; int d = 0; unsigned v = cpu; do { digits[d++] = '0' + v % 10; v /= 10; } while(v);
            while(d) path[n++] = digits[--d];
            for(const char *q = "/topology/"; *q; q++) path[n++] = *q;
            for(const char *q = parts[k]; *q; q++) path[n++] = *q;
            path[n] = 0;
            read_file(path, text, sizeof(text));
            values[k] = parse(text);
        }
        if(values[0] != 0) die("package id");
        if(values[2] != cpu) die("thread siblings");
        if(cores_seen >> values[1] & 1) die("core id");
        cores_seen |= 1u << values[1];
    }
    int direct = disk ? direct_read() : 0;

    __asm__ volatile("mrs %0, ctr_el0" : "=r"(ctr));
    smc_code = (unsigned *)mapping(page_size, 7);
    if(failed_mapping(smc_code)) die("mmap exec");
    write_function(smc_code, 0);
    sync_code(smc_code, smc_code, 5);
    on_signal(40, rt_signal);
    set_cpu(0);
    for(unsigned id = 0; id < cpus; id++)
        check(spawn(xc_worker, id, xc_stacks[id] + sizeof(xc_stacks[id]), 0x00050F00), "clone xc");
    while(xc_ready != cpus) S(SYS_sched_yield, 0, 0, 0);
    word tgid = S(SYS_getpid, 0, 0, 0);
    for(unsigned n = 0; n < SIGNALS; n++)
        for(unsigned id = 0; id < cpus; id++)
            check(sc(SYS_tgkill, tgid, tids[id], 40, 0, 0, 0), "tgkill");
    for(unsigned round = 1; round <= SMC_ROUNDS; round++)
    {
        write_function(smc_code, round * 3 + 1);
        sync_code(smc_code, smc_code, 5);
        barrier();
        smc_sequence = round;
        while(smc_ack != round) S(SYS_sched_yield, 0, 0, 0);
    }
    while(xc_done != cpus) S(SYS_sched_yield, 0, 0, 0);
    unsigned migrated = 0, signals = 0;
    for(unsigned id = 0; id < cpus; id++) { migrated += moved[id]; signals += signalled[id]; }
    if(migrated != cpus * MIGRATIONS) die("migration count");
    if(signals != cpus * SIGNALS) die("signal count");
    if(smc_bad) die("cross-modified code");

    /* a memfd mapped writable and executable at two addresses */
    word memfd = check(sc(SYS_memfd_create, (word)"a64-jit", 0, 0, 0, 0, 0), "memfd_create");
    check(S(SYS_ftruncate, memfd, page_size, 0), "memfd size");
    unsigned *rw = (unsigned *)sc(SYS_mmap, 0, page_size, 3, 1 /* MAP_SHARED */, memfd, 0);
    unsigned *rx = (unsigned *)sc(SYS_mmap, 0, page_size, 5, 1, memfd, 0);
    if(failed_mapping(rw) || failed_mapping(rx)) die("memfd mappings");
    unsigned dual = 0;
    for(unsigned round = 1; round <= SMC_ROUNDS; round++)
    {
        write_function(rw + (round & 7) * 8, round * 5 + 2);
        sync_code(rw + (round & 7) * 8, rx + (round & 7) * 8, 5);
        if(call(rx + (round & 7) * 8) == round * 5 + 2) dual++;
    }
    if(dual != SMC_ROUNDS) die("dual-mapped code");

    exclusive_aba();
    if(!reference && aba_failures != ABA_ROUNDS) die("exclusive ABA: a store-exclusive succeeded after another CPU's write");
    futex_pingpong();
    find_vdso();
    if(!clocks_monotonic()) die("clock went back across CPUs");
    fp_matrix();
    if(fp_handled != fp_threads * FP_ROUNDS) die("fp signals");
    if(fp_bad) die("FPCR, FPSR or V registers across a context switch");
    const char *arm32 = aarch32();
    if(!reference && !same(arm32, "enoexec")) die("AArch32 ELF executed");

    out("A64_PROBE_XC arch=aarch64 packages=1 cores="); number(cpus); out(" threads_per_core=1 migrations="); number(migrated);
    out(" signals="); number(signals); out(" smc_rounds="); number(SMC_ROUNDS); out(" dual_map="); number(dual);
    out(" excl_aba="); number(aba_failures == ABA_ROUNDS); out(" futex="); number(FUTEX_ROUNDS);
    out(" clocks=1 fp_threads="); number(fp_threads); out(" fp_steps="); number(fp_steps); out(" fp_bad="); number(fp_bad);
    out(" aarch32="); out(arm32); out(" direct_io="); number(direct); out("\n");
}

/* AF_PACKET socket on eth0 with a cBPF filter for EtherType 88B5: send
 * frames, receive the host's echoes */
#define NET_FRAMES 16
static void network(void)
{
    struct { unsigned short family, protocol; int ifindex; unsigned short hatype; unsigned char pkttype, halen, addr[8]; } address = {0};
    word fd = check(sc(SYS_socket, 17 /* AF_PACKET */, 3 /* SOCK_RAW */, 0xB588 /* htons(0x88B5) */, 0, 0, 0), "packet socket");
    /* ldh [12]; jeq #0x88b5, accept; ret #0; accept: ret #0xffff */
    static const struct { unsigned short code; unsigned char jt, jf; unsigned k; } filter[] = {
        {0x28, 0, 0, 12}, {0x15, 0, 1, 0x88B5}, {0x06, 0, 0, 0xFFFF}, {0x06, 0, 0, 0} };
    struct { unsigned short count; const void *code; } program = {4, filter};
    check(sc(SYS_setsockopt, fd, 1 /* SOL_SOCKET */, 26 /* SO_ATTACH_FILTER */, (word)&program, sizeof(program), 0), "socket filter");
    char request[40] = {'e', 't', 'h', '0', 0};
    check(S(SYS_ioctl, fd, 0x8933 /* SIOCGIFINDEX */, request), "eth0 index");
    address.family = 17; address.protocol = 0xB588; address.ifindex = *(int *)(request + 16); address.halen = 6;
    for(int i = 0; i < 6; i++) address.addr[i] = 255;
    check(sc(SYS_bind, fd, (word)&address, sizeof(address), 0, 0, 0), "bind packet socket");
    struct { long seconds, microseconds; } timeout = {10, 0};
    check(sc(SYS_setsockopt, fd, 1, 20 /* SO_RCVTIMEO */, (word)&timeout, sizeof(timeout), 0), "receive timeout");
    for(unsigned round = 0; round < NET_FRAMES; round++)
    {
        unsigned char frame[96] = {0}, received[160];
        for(int i = 0; i < 6; i++) frame[i] = 255;
        frame[6] = 2; frame[11] = 1; frame[12] = 0x88; frame[13] = 0xB5;
        for(unsigned i = 14; i < sizeof(frame); i++) frame[i] = (unsigned char)(i * 7 + round * 13 + 'a');
        if(check(sc(SYS_sendto, fd, (word)frame, sizeof(frame), 0, 0, 0), "send frame") != sizeof(frame)) die("short frame");
        for(;;)
        {
            word n = sc(SYS_recvfrom, fd, (word)received, sizeof(received), 0, 0, 0);
            if(n == -4) continue; /* EINTR */
            if(check(n, "receive frame") < (word)sizeof(frame)) die("short echo");
            if(received[11] != 2) continue; /* our own transmitted frame */
            for(unsigned i = 14; i < sizeof(frame); i++) if(received[i] != frame[i]) die("echo payload");
            break;
        }
    }
    S(SYS_close, fd, 0, 0);
    out("A64_PROBE_NET arch=aarch64 frames="); number(NET_FRAMES); out("\n");
}

/* AT_HWCAP of the profile v86-aarch64-v1 (tests/platform/a64-profile.json):
 * fp asimd evtstrm aes pmull sha1 sha2 crc32 cpuid */
#define HWCAP_PROFILE 0x8FFul
static const char *const FEATURES = "fp asimd evtstrm aes pmull sha1 sha2 crc32 cpuid";

void entry(word *stack)
{
    initial_stack = stack;
    reference = argument("ref=qemu") != 0;
    int disk = !argument("nodisk");
    out("A64_PROBE_START arch=aarch64\n");
    page_size = auxv(6 /* AT_PAGESZ */);
    if(page_size != 4096 && page_size != 16384 && page_size != 65536) die("AT_PAGESZ");
    struct { char sysname[65], nodename[65], release[65], version[65], machine[65], domain[65]; } names;
    check(S(SYS_uname, &names, 0, 0), "uname");
    if(!same(names.machine, "aarch64")) die("uname machine");

    uword affinity[16] = {0};
    word bytes = check(S(SYS_sched_getaffinity, 0, sizeof(affinity), affinity), "getaffinity");
    for(word i = 0; i < bytes / (word)sizeof(affinity[0]); i++)
        for(uword m = affinity[i]; m; m &= m - 1) cpus++;
    if(cpus == 0 || cpus > THREADS) die("cpu count");

    /* HWCAP, /proc/cpuinfo, the ID register as EL0 sees it */
    uword hwcap = auxv(16), hwcap2 = auxv(26);
    if(!reference && (hwcap != HWCAP_PROFILE || hwcap2 != 0)) die("AT_HWCAP");
    static char cpuinfo[16384];
    read_file("/proc/cpuinfo", cpuinfo, sizeof(cpuinfo));
    const char *features = 0;
    for(const char *p = cpuinfo; *p; p++) if(starts(p, "Features\t: ")) { features = p + 11; break; }
    if(!features) die("/proc/cpuinfo Features");
    int features_match = 1;
    for(int i = 0; FEATURES[i]; i++) if(features[i] != FEATURES[i]) features_match = 0;
    if(features[length(FEATURES)] != '\n') features_match = 0;
    if(!reference && !features_match) die("/proc/cpuinfo Features");
    uword isar0, midr;
    __asm__ volatile("mrs %0, id_aa64isar0_el1\nmrs %1, midr_el1" : "=r"(isar0), "=r"(midr));
    if(isar0 != 0x11120) die("ID_AA64ISAR0_EL1 at EL0");

    /* DC ZVA: DCZID_EL0 says 64-byte blocks, allowed */
    uword dczid;
    __asm__ volatile("mrs %0, dczid_el0" : "=r"(dczid));
    static unsigned char zva[256] __attribute__((aligned(64)));
    memset(zva, 0xFF, sizeof(zva));
    int dczva = 0;
    if((dczid & 31) == 4)
    {
        __asm__ volatile("dc zva, %0" :: "r"(zva + 64) : "memory");
        dczva = 1;
        for(int i = 0; i < 256; i++) if(zva[i] != (i >= 64 && i < 128 ? 0 : 0xFF)) dczva = 0;
    }
    if(!reference && !dczva) die("DC ZVA");

    const char *memtest_size = argument("memtest=");
    if(memtest_size) memtest(parse(memtest_size), argument("high=") ? parse(argument("high=")) : ~0ul);

    /* mmap, then write to a read-only page: the handler sees the exact
     * address (siginfo, sigcontext's FAR) and the ESR (a data abort from
     * EL0, a write, a permission fault), restores write access, and the
     * faulting store is retried */
    word *pages = mapping(2 * page_size, 3);
    if(failed_mapping(pages)) die("mmap");
    for(uword i = 0; i < page_size / sizeof(word); i++) pages[i] = (word)i * 0x01010101;
    protected_page = (word *)((char *)pages + page_size);
    /* (present before mprotect: the write is a permission fault, not a
     * translation fault) */
    protected_page[0] = 1;
    on_signal(11, segv);
    check(S(SYS_mprotect, protected_page, page_size, 1), "mprotect");
    protected_page[3] = 0x5A5A;
    uword target = (uword)protected_page + 3 * sizeof(word);
    if(fault_address != target || fault_far != target || protected_page[3] != 0x5A5A) die("SIGSEGV round trip");
    /* EC 0x24 (data abort from a lower EL), WnR, a level-3 permission fault */
    if((fault_esr >> 26) != 0x24 || !(fault_esr >> 6 & 1) || (fault_esr & 0x3C) != 0xC) { out("A64_PROBE_ESR "); hex(fault_esr); out("\n"); die("ESR of the fault"); }
    if(pages[5] != 5 * 0x01010101) die("mapping contents");

    int fds[2];
    check(S(SYS_pipe2, fds, 0, 0), "pipe2");
    word child = check(sc(SYS_clone, 17 /* SIGCHLD */, 0, 0, 0, 0, 0), "fork");
    if(child == 0)
    {
        word pid = S(SYS_getpid, 0, 0, 0);
        S(SYS_write, fds[1], &pid, sizeof(pid));
        S(SYS_exit, 7, 0, 0);
    }
    word reported = 0;
    if(check(S(SYS_read, fds[0], &reported, sizeof(reported)), "pipe read") != sizeof(reported) || reported != child) die("pipe pid");
    int status = 0;
    if(check(sc(SYS_wait4, child, (word)&status, 0, 0, 0, 0), "wait4") != child || status != 7 << 8) die("child status");

    watched = mapping(page_size, 3);
    if(failed_mapping((void *)watched)) die("mmap watched");
    *watched = 1;
    /* CLONE_VM|FS|FILES|SIGHAND|THREAD|SYSVSEM */
    for(unsigned id = 0; id < cpus; id++)
        check(spawn(worker, id, stacks[id] + sizeof(stacks[id]), 0x00050F00), "clone");
    while(readers != cpus) S(SYS_sched_yield, 0, 0, 0);
    /* MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED over the page */
    if(sc(SYS_mmap, (word)watched, page_size, 3, 0x32, -1, 0) != (word)watched) die("mmap fixed");
    *watched = 2;
    barrier();
    remapped = 1;
    while(finished != cpus) S(SYS_sched_yield, 0, 0, 0);
    if(stale) die("stale TLB entry after remap");
    if(counter != cpus * ITERATIONS) die("exclusive counter");
    for(unsigned id = 0; id < cpus; id++) if(bound[id] != id + 1) die("thread binding");

    static char data[4096], back[4096];
    for(int i = 0; i < 4096; i++) data[i] = (char)(i * 7 + 3);
    word fd = check(sc(SYS_openat, AT_FDCWD, (word)"/tmp/a64-probe-file", 0102, 0644, 0, 0), "open");
    if(check(S(SYS_write, fd, data, sizeof(data)), "file write") != sizeof(data)) die("short write");
    check(S(SYS_lseek, fd, 0, 0), "lseek");
    if(check(S(SYS_read, fd, back, sizeof(back)), "file read") != sizeof(back)) die("short read");
    for(int i = 0; i < 4096; i++) if(back[i] != data[i]) die("file contents");
    S(SYS_close, fd, 0, 0);
    check(sc(SYS_unlinkat, AT_FDCWD, (word)"/tmp/a64-probe-file", 0, 0, 0, 0), "unlink");

    /* Physical placement: touched pages whose frame is at or above the PFN
     * of "high=<pfn>" (extended RAM; none without it), contents verified */
    const char *high = argument("high=");
    uword threshold = high ? parse(high) : ~0ul;
    enum { BLOCK = 16 << 20 };
    uword count = BLOCK / page_size;
    static unsigned long long frames[4096];
    unsigned char *block = (unsigned char *)mapping(BLOCK, 3);
    if(failed_mapping(block)) die("mmap block");
    for(uword i = 0; i < count; i++) block[i * page_size + (i & 4095)] = (unsigned char)(i * 13 + 1);
    word map = check(sc(SYS_openat, AT_FDCWD, (word)"/proc/self/pagemap", 0, 0, 0, 0), "open pagemap");
    check(S(SYS_lseek, map, (uword)block / page_size * 8, 0), "pagemap seek");
    for(word done = 0, n; done < (word)(count * 8); done += n)
        if((n = check(S(SYS_read, map, (char *)frames + done, count * 8 - done), "pagemap read")) == 0) die("pagemap eof");
    S(SYS_close, map, 0, 0);
    unsigned high_pages = 0;
    for(uword i = 0; i < count; i++)
    {
        if(!(frames[i] >> 63)) die("page not present");
        if((frames[i] & ((1ull << 55) - 1)) >= threshold) high_pages++;
        if(block[i * page_size + (i & 4095)] != (unsigned char)(i * 13 + 1)) die("block contents");
    }

    out("A64_PROBE_OK arch=aarch64 cpus="); number(cpus);
    out(" threads="); number(cpus); out(" counter="); number(counter);
    out(" cpu_checks="); for(unsigned id = 0; id < cpus; id++) { if(id) out(","); number(bound[id] - 1); }
    out(" fault=page esr="); hex(fault_esr); out(" child=7 tlb_stale="); number(stale);
    out(" page_size="); number(page_size); out(" hwcap="); hex(hwcap); out(" hwcap2="); hex(hwcap2);
    out(" features="); number(features_match); out(" isar0="); hex(isar0); out(" midr="); hex(midr);
    out(" dczva="); number(dczva); out(" high_pages="); number(high_pages); out("\n");
    matrix(disk);
    if(argument("net")) network();
    S(SYS_exit_group, 0, 0, 0);
    for(;;);
}
