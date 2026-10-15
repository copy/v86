/* Windows x64 qualification probe, built twice: x86_64 (native) and i686
 * (runs under WOW64, i.e. compatibility-mode code). No CRT. Results go
 * beside the executable on the disposable FAT16 test disk.
 *
 * Checks: the processor count and topology reported by the Windows
 * topology API (one package, N cores, one thread per core), threads pinned
 * to every processor run there (APIC ID from CPUID), interlocked work adds
 * up exactly, and (x64) memory placed above 4 GiB of virtual address space
 * is usable.
 *
 * AVX (docs/simd-xsave-plan.md 11.3, P12), when CPUID reports OSXSAVE and AVX
 * and XGETBV(0) has the SSE and AVX state: twice as many threads as
 * processors each hold a fingerprint in every YMM register (16 in the x64
 * probe, 8 under WOW64) while they spin, migrate to every processor in turn,
 * and fault on UD2, which a vectored exception handler skips; the registers
 * must be unchanged after each step. The x64 probe also suspends a thread
 * spinning with its fingerprint and reads its YMM state with GetThreadContext
 * (CONTEXT_XSTATE). With AVX2 and FMA, arithmetic on ymm registers is
 * compared with the same done in scalar code. One more line: X64_WIN_AVX. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#ifdef _WIN64
#define ARCH "64"
#else
#define ARCH "32"
#endif
#define ROUNDS 64
static HANDLE result;
static volatile LONG shared_total, failed;
static DWORD system_cpus, checks[8], apic_seen[8];
static HANDLE threads[8];
static void text(const char *s) { DWORD n = 0, wrote; while(s[n]) n++; WriteFile(result, s, n, &wrote, 0); }
static void number(DWORD n) { char b[12]; int i = 11; b[i] = 0; do { b[--i] = '0' + n % 10; n /= 10; } while(n); text(b + i); }
static void hex(unsigned long long n) { char b[20]; int i = 19; b[i] = 0; do { b[--i] = "0123456789abcdef"[n & 15]; n >>= 4; } while(n); text(b + i); }
static DWORD apic_id(void) { DWORD a = 1, b, c = 0, d; __asm__ volatile("cpuid" : "+a"(a), "=b"(b), "+c"(c), "=d"(d)); return b >> 24; }
static DWORD WINAPI worker(void *argument)
{
    DWORD id = (DWORD)(DWORD_PTR)argument;
    for(DWORD round = 0; round < ROUNDS; round++)
    {
        DWORD target = (id + round) % system_cpus;
        if(!SetThreadAffinityMask(GetCurrentThread(), (DWORD_PTR)1 << target)) InterlockedIncrement(&failed);
        Sleep(0);
        DWORD seen = apic_id();
        if(seen >= 8) InterlockedIncrement(&failed);
        else InterlockedOr((LONG *)&apic_seen[target], 1 << seen);
        DWORD sum = 0, expected = 0;
        for(DWORD i = 1; i <= 1000; i++) sum += i ^ round;
        for(DWORD i = 1000; i; i--) expected += i ^ round;
        if(sum != expected || apic_id() != seen) InterlockedIncrement(&failed);
        InterlockedIncrement(&shared_total);
        checks[id]++;
    }
    return 0;
}
static void finish(DWORD code) { FlushFileBuffers(result); CloseHandle(result); ExitProcess(code); }

/* AVX: the steps load every YMM register from `in`, fault on UD2 when
 * `fault` (the handler skips it), spin, and store them to `out` */
#ifdef _WIN64
#define YMM_REGS 16
#define LOADS(n) "vmovdqu " #n "*32(%[in]),%%ymm" #n "\n"
#define STORES(n) "vmovdqu %%ymm" #n "," #n "*32(%[out])\n"
#define ALL(f) f(0) f(1) f(2) f(3) f(4) f(5) f(6) f(7) f(8) f(9) f(10) f(11) f(12) f(13) f(14) f(15)
#define YMM_CLOBBERS "xmm0", "xmm1", "xmm2", "xmm3", "xmm4", "xmm5", "xmm6", "xmm7", "xmm8", "xmm9", "xmm10", "xmm11", "xmm12", "xmm13", "xmm14", "xmm15"
#else
#define YMM_REGS 8
#define LOADS(n) "vmovdqu " #n "*32(%[in]),%%ymm" #n "\n"
#define STORES(n) "vmovdqu %%ymm" #n "," #n "*32(%[out])\n"
#define ALL(f) f(0) f(1) f(2) f(3) f(4) f(5) f(6) f(7)
/* (the i686 build has no SSE: the compiler keeps nothing in XMM registers) */
#define YMM_CLOBBERS "memory"
#endif
#ifdef _WIN64
#define XMM0_3 , "xmm0", "xmm1", "xmm2", "xmm3"
#else
#define XMM0_3
#endif
static void ymm_step(const unsigned char *in, unsigned char *out, DWORD fault, DWORD spin)
{
    __asm__ volatile(ALL(LOADS)
        "test %[fault],%[fault]\n" "jz 1f\n" "ud2\n" "1:\n"
        "2: dec %[spin]\n" "jnz 2b\n"
        ALL(STORES)
        : [spin] "+r"(spin) : [in] "r"(in), [out] "r"(out), [fault] "r"(fault) : "memory", "cc", YMM_CLOBBERS);
}
#define AVX_ROUNDS 8
#define AVX_SPIN 2000000
static volatile LONG avx_steps, avx_faults, avx_bad;
static DWORD avx_threads;
static unsigned char ymm_in[16][YMM_REGS * 32] __attribute__((aligned(32))), ymm_out[16][YMM_REGS * 32] __attribute__((aligned(32)));
static LONG CALLBACK on_fault(EXCEPTION_POINTERS *e)
{
    if(e->ExceptionRecord->ExceptionCode != EXCEPTION_ILLEGAL_INSTRUCTION) return EXCEPTION_CONTINUE_SEARCH;
#ifdef _WIN64
    e->ContextRecord->Rip += 2;
#else
    e->ContextRecord->Eip += 2;
#endif
    InterlockedIncrement(&avx_faults);
    return EXCEPTION_CONTINUE_EXECUTION;
}
static DWORD WINAPI ymm_worker(void *argument)
{
    DWORD id = (DWORD)(DWORD_PTR)argument;
    for(DWORD round = 0; round < AVX_ROUNDS; round++)
    {
        for(DWORD kind = 0; kind < 3; kind++)
        {
            unsigned char *in = ymm_in[id], *out = ymm_out[id];
            for(DWORD i = 0; i < YMM_REGS * 32; i++) { in[i] = (unsigned char)(id * 37 + round * 11 + kind * 5 + i * 3 + (i >> 5)); out[i] = 0; }
            /* (a migration first, then a step that the scheduler preempts) */
            if(kind == 1 && !SetThreadAffinityMask(GetCurrentThread(), (DWORD_PTR)1 << ((id + round) % system_cpus))) InterlockedIncrement(&avx_bad);
            ymm_step(in, out, kind == 2, kind == 0 ? 1 : AVX_SPIN);
            for(DWORD i = 0; i < YMM_REGS * 32; i++) if(out[i] != in[i]) { InterlockedIncrement(&avx_bad); break; }
            InterlockedIncrement(&avx_steps);
        }
    }
    return 0;
}
#ifdef _WIN64
/* a thread suspended while it spins with its fingerprint: GetThreadContext
 * with CONTEXT_XSTATE gives its XMM registers and YMM upper halves */
static volatile LONG victim_ready, victim_stop;
static DWORD WINAPI victim(void *argument)
{
    (void)argument;
    const unsigned char *in = ymm_in[15];
    __asm__ volatile(ALL(LOADS) "movl $1,(%[ready])\n" "1: pause\n" "cmpl $0,(%[stop])\n" "je 1b\n"
        :: [in] "r"(in), [ready] "r"(&victim_ready), [stop] "r"(&victim_stop) : "memory", "cc", YMM_CLOBBERS);
    return 0;
}
typedef BOOL (WINAPI *initialize_context_fn)(void *, DWORD, CONTEXT **, DWORD *);
typedef BOOL (WINAPI *set_mask_fn)(CONTEXT *, DWORD64);
typedef void *(WINAPI *locate_fn)(CONTEXT *, DWORD, DWORD *);
static DWORD xstate_check(void)
{
    HMODULE k = GetModuleHandleA("kernel32.dll");
    initialize_context_fn initialize = (initialize_context_fn)GetProcAddress(k, "InitializeContext");
    set_mask_fn set_mask = (set_mask_fn)GetProcAddress(k, "SetXStateFeaturesMask");
    locate_fn locate = (locate_fn)GetProcAddress(k, "LocateXStateFeature");
    if(!initialize || !set_mask || !locate) return 2;
    for(DWORD i = 0; i < 16 * 32; i++) ymm_in[15][i] = (unsigned char)(i * 13 + 7);
    HANDLE thread = CreateThread(0, 0, victim, 0, 0, 0);
    if(!thread) return 3;
    while(!victim_ready) Sleep(1);
    DWORD verdict = 0;
    if(SuspendThread(thread) == (DWORD)-1) verdict = 4;
    static unsigned char buffer[8192] __attribute__((aligned(64)));
    CONTEXT *context = 0;
    DWORD length = sizeof(buffer);
    if(!verdict && !initialize(buffer, CONTEXT_ALL | CONTEXT_XSTATE, &context, &length)) verdict = 5;
    if(!verdict && !set_mask(context, XSTATE_MASK_AVX)) verdict = 6;
    if(!verdict && !GetThreadContext(thread, context)) verdict = 7;
    if(!verdict)
    {
        DWORD size = 0;
        unsigned char *upper = locate(context, XSTATE_AVX, &size);
        const unsigned char *low = (const unsigned char *)&context->Xmm0;
        if(!upper || size < 256) verdict = 8;
        for(DWORD r = 0; !verdict && r < 16; r++)
            for(DWORD b = 0; b < 16; b++)
                if(low[r * 16 + b] != ymm_in[15][r * 32 + b] || upper[r * 16 + b] != ymm_in[15][r * 32 + 16 + b]) { verdict = 9; break; }
    }
    victim_stop = 1;
    ResumeThread(thread);
    WaitForSingleObject(thread, 60000);
    CloseHandle(thread);
    return verdict ? verdict : 1;
}
#endif
/* AVX2 and FMA on ymm registers against scalar code (exact operands) */
static DWORD compute_check(DWORD avx2, DWORD fma)
{
    static int a[8] __attribute__((aligned(32))) = {1, -2, 3, -4, 5, 6, -7, 8}, b[8] __attribute__((aligned(32))) = {9, 10, -11, 12, 13, -14, 15, 16};
    static int sum[8] __attribute__((aligned(32))), product[8] __attribute__((aligned(32)));
    static double x[4] __attribute__((aligned(32))) = {1.5, -2.25, 3.0, 0.5}, y[4] __attribute__((aligned(32))) = {4.0, 0.5, -1.25, 6.0};
    static double z[4] __attribute__((aligned(32))) = {0.25, 1.0, -2.0, 3.5}, fused[4] __attribute__((aligned(32)));
    DWORD bad = 0;
    if(avx2)
    {
        __asm__ volatile("vmovdqa (%[a]),%%ymm0\n" "vmovdqa (%[b]),%%ymm1\n" "vpaddd %%ymm1,%%ymm0,%%ymm2\n" "vpmulld %%ymm1,%%ymm0,%%ymm3\n"
            "vmovdqa %%ymm2,(%[sum])\n" "vmovdqa %%ymm3,(%[product])\n" "vzeroupper\n"
            :: [a] "r"(a), [b] "r"(b), [sum] "r"(sum), [product] "r"(product) : "memory" XMM0_3);
        for(int i = 0; i < 8; i++) if(sum[i] != a[i] + b[i] || product[i] != a[i] * b[i]) bad++;
    }
    if(fma)
    {
        __asm__ volatile("vmovapd (%[x]),%%ymm0\n" "vmovapd (%[y]),%%ymm1\n" "vmovapd (%[z]),%%ymm2\n" "vfmadd231pd %%ymm1,%%ymm0,%%ymm2\n"
            "vmovapd %%ymm2,(%[out])\n" "vzeroupper\n"
            :: [x] "r"(x), [y] "r"(y), [z] "r"(z), [out] "r"(fused) : "memory" XMM0_3);
        /* (exact: the operands have few bits) */
        for(int i = 0; i < 4; i++) if(fused[i] != x[i] * y[i] + z[i]) bad++;
    }
    return bad;
}
static void avx(void)
{
    DWORD a = 1, b, c = 0, d;
    __asm__ volatile("cpuid" : "+a"(a), "=b"(b), "+c"(c), "=d"(d));
    DWORD has_fma = c >> 12 & 1, usable = c >> 27 & 1 && c >> 28 & 1;
    if(usable)
    {
        DWORD lo, hi;
        __asm__ volatile("xgetbv" : "=a"(lo), "=d"(hi) : "c"(0));
        usable = (lo & 6) == 6;
    }
    if(!usable) { text("X64_WIN_AVX arch=" ARCH " avx=0\r\n"); return; }
    a = 7; c = 0;
    __asm__ volatile("cpuid" : "+a"(a), "=b"(b), "+c"(c), "=d"(d));
    DWORD has_avx2 = b >> 5 & 1;
    text("X64_WIN_AVX_START arch=" ARCH "\r\n");
    FlushFileBuffers(result);
    AddVectoredExceptionHandler(1, on_fault);
    avx_threads = 2 * system_cpus;
    HANDLE workers[16];
    for(DWORD id = 0; id < avx_threads; id++)
    {
        workers[id] = CreateThread(0, 0, ymm_worker, (void *)(DWORD_PTR)id, 0, 0);
        if(!workers[id]) finish(17);
    }
    if(WaitForMultipleObjects(avx_threads, workers, TRUE, 1800000) != WAIT_OBJECT_0) finish(18);
    DWORD xstate = 0;
#ifdef _WIN64
    xstate = xstate_check();
#endif
    DWORD compute = compute_check(has_avx2, has_fma);
    text("X64_WIN_AVX arch=" ARCH " avx=1 avx2="); number(has_avx2); text(" fma="); number(has_fma);
    text(" threads="); number(avx_threads); text(" steps="); number((DWORD)avx_steps); text(" faults="); number((DWORD)avx_faults);
    text(" xstate="); number(xstate); text(" compute_bad="); number(compute); text(" bad="); number((DWORD)avx_bad); text("\r\n");
    if(avx_bad || compute || (xstate && xstate != 1)) InterlockedIncrement(&failed);
}
#ifdef _WIN64
void entry(void)
#else
void __attribute__((stdcall)) entry(void)
#endif
{
    char path[MAX_PATH];
    GetModuleFileNameA(0, path, sizeof(path));
    DWORD at = 0, last = 0;
    while(path[at]) { if(path[at] == '\\') last = at + 1; at++; }
    const char name[] = "RESULT" ARCH ".TXT";
    for(at = 0; at < sizeof(name); at++) path[last + at] = name[at];
    result = CreateFileA(path, GENERIC_WRITE, FILE_SHARE_READ, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if(result == INVALID_HANDLE_VALUE) ExitProcess(10);
    SYSTEM_INFO info;
    GetNativeSystemInfo(&info);
    system_cpus = info.dwNumberOfProcessors;
    text("X64_WIN_BEGIN arch=" ARCH " processors="); number(system_cpus);
    text(" architecture="); number(info.wProcessorArchitecture);
    /* QueryPerformanceCounter's source (docs/jit-unification-plan.md open
       question 4): 14318180 Hz the HPET, 3579545 Hz the ACPI PM timer, other
       values the TSC */
    LARGE_INTEGER qpf;
    text(" qpf="); hex(QueryPerformanceFrequency(&qpf) ? (unsigned long long)qpf.QuadPart : 0);
    text("\r\n");
    FlushFileBuffers(result);
    if(system_cpus < 1 || system_cpus > 8) finish(12);
    /* topology API */
    SYSTEM_LOGICAL_PROCESSOR_INFORMATION topology[64];
    DWORD bytes = sizeof(topology), packages = 0, cores = 0, smt = 0;
    if(!GetLogicalProcessorInformation(topology, &bytes)) finish(13);
    for(DWORD i = 0; i < bytes / sizeof(topology[0]); i++)
    {
        if(topology[i].Relationship == RelationProcessorPackage) packages++;
        if(topology[i].Relationship == RelationProcessorCore)
        {
            cores++;
            if(topology[i].ProcessorCore.Flags) smt++;
            DWORD_PTR mask = topology[i].ProcessorMask;
            if(mask == 0 || (mask & (mask - 1))) InterlockedIncrement(&failed); /* one logical processor per core */
        }
    }
    /* memory: x64 allocates top-down, far above 4 GiB */
    unsigned long long high = 0;
#ifdef _WIN64
    volatile unsigned long long *block = VirtualAlloc(0, 1 << 20, MEM_RESERVE | MEM_COMMIT | MEM_TOP_DOWN, PAGE_READWRITE);
    if(!block) finish(15);
    high = (unsigned long long)block;
    for(DWORD i = 0; i < (1 << 20) / 8; i += 512) block[i] = high ^ i;
    for(DWORD i = 0; i < (1 << 20) / 8; i += 512) if(block[i] != (high ^ i)) InterlockedIncrement(&failed);
    if(high >> 32 == 0) InterlockedIncrement(&failed);
    VirtualFree((void *)block, 0, MEM_RELEASE);
#endif
    for(DWORD id = 0; id < system_cpus; id++)
    {
        threads[id] = CreateThread(0, 0, worker, (void *)(DWORD_PTR)id, 0, 0);
        if(!threads[id]) finish(14);
    }
    if(WaitForMultipleObjects(system_cpus, threads, TRUE, 600000) != WAIT_OBJECT_0) finish(16);
    avx();
    /* each processor ran on exactly one APIC ID, all distinct */
    DWORD all = 0;
    for(DWORD cpu = 0; cpu < system_cpus; cpu++)
    {
        DWORD mask = apic_seen[cpu];
        if(mask == 0 || (mask & (mask - 1)) || (all & mask)) InterlockedIncrement(&failed);
        all |= mask;
    }
    text("X64_WIN_DONE arch=" ARCH " processors="); number(system_cpus);
    text(" packages="); number(packages); text(" cores="); number(cores); text(" smt_cores="); number(smt);
    text(" progress="); number((DWORD)shared_total); text(" failures="); number((DWORD)failed);
    text(" apic_ids="); hex(all); text(" high_block="); hex(high); text(" checks=");
    for(DWORD id = 0; id < system_cpus; id++) { if(id) text(","); number(checks[id]); }
    text("\r\n");
    finish(failed ? 1 : 0);
}
