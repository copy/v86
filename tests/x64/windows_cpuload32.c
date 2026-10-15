/* CPULOAD32 (docs/jit-unification-plan.md P0.12): a timed 32-bit workload
 * for WOW64. Fixed work per round (about 250M instructions, 1.5-2 s at the
 * emulator's speed in 2026-10; the first round also compiles): integer mixing, a pointer chase over
 * 1 MiB, sorting through a comparison function, indirect calls, string
 * copies, and system calls (NtQueryPerformanceCounter through WOW64's
 * thunks, about one per 1000 instructions of the round). Each round's time
 * (QueryPerformanceCounter, ms) and the checksum go beside the executable
 * (LOAD32.TXT: the tools disk is FAT16 with 8.3 names, as is the program's,
 * LOAD32.EXE), one flushed line per round, then CPULOAD32_DONE; the
 * guest's clock runs with the emulator, so a round's time measures how fast
 * the emulator runs WOW64 code. No CRT; i686 (i686-w64-mingw32-gcc). Rounds:
 * 5, or the number given on the command line. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
typedef unsigned int u32;
static HANDLE result;
static void text(const char *s) { DWORD n = 0, wrote; while(s[n]) n++; WriteFile(result, s, n, &wrote, 0); }
/* (32-bit arithmetic only: no libgcc for 64-bit division) */
static void number(u32 n) { char b[12]; int i = 11; b[i] = 0; do { b[--i] = '0' + n % 10; n /= 10; } while(n); text(b + i); }
static void hex(u32 n) { char b[12]; int i = 11; b[i] = 0; do { b[--i] = "0123456789abcdef"[n & 15]; n >>= 4; } while(n); text(b + i); }
static void finish(DWORD code) { FlushFileBuffers(result); CloseHandle(result); ExitProcess(code); }
static u32 seed = 1;
static u32 lcg(void) { return seed = seed * 1664525u + 1013904223u; }
static u32 mix(u32 h, u32 v) { return (h ^ v) * 0x01000193u; }

#define CHASE (1 << 18)
static u32 next[CHASE];
static u32 values[4096];
static char text_a[4096], text_b[4096];
static int compare(const void *a, const void *b) { u32 x = *(const u32 *)a, y = *(const u32 *)b; return x < y ? -1 : x > y; }
/* (an insertion sort below 16, quicksort above: calls through the pointer) */
static void sort(u32 *v, int n, int (*less)(const void *, const void *))
{
    while(n > 16)
    {
        u32 pivot = v[n / 2];
        int i = 0, j = n - 1;
        for(;;)
        {
            while(less(&v[i], &pivot) < 0) i++;
            while(less(&pivot, &v[j]) < 0) j--;
            if(i >= j) break;
            u32 t = v[i]; v[i] = v[j]; v[j] = t;
            i++; j--;
        }
        sort(v, j + 1, less);
        v += j + 1; n -= j + 1;
    }
    for(int i = 1; i < n; i++)
    {
        u32 x = v[i]; int j = i;
        for(; j > 0 && less(&x, &v[j - 1]) < 0; j--) v[j] = v[j - 1];
        v[j] = x;
    }
}
static u32 op_add(u32 a, u32 b) { return a + b * 3; }
static u32 op_xor(u32 a, u32 b) { return (a ^ b) >> 1 | a << 31; }
static u32 op_mul(u32 a, u32 b) { return a * (b | 1); }
static u32 op_sub(u32 a, u32 b) { return a - (b >> 3); }
static u32 (*const ops[4])(u32, u32) = { op_add, op_xor, op_mul, op_sub };

static u32 round_work(u32 h)
{
    LARGE_INTEGER t;
    for(int pass = 0; pass < 128; pass++)
    {
        /* integer mixing */
        for(u32 i = 0; i < 200000; i++) h = mix(h, i * 2654435761u + (h >> 7));
        /* a pointer chase over a random cycle */
        u32 p = h & (CHASE - 1);
        for(u32 i = 0; i < 200000; i++) { p = next[p]; h += p; }
        /* sorting through a comparison function */
        for(int i = 0; i < 4096; i++) values[i] = lcg();
        sort(values, 4096, compare);
        h = mix(h, values[h & 4095]);
        /* indirect calls */
        for(u32 i = 0; i < 100000; i++) h = ops[(h ^ i) & 3](h, i);
        /* string copies (REP MOVS) */
        for(int i = 0; i < 64; i++)
        {
            u32 n = 1024 + (lcg() & 2047), d = lcg() & 1023, s = lcg() & 1023, count = n;
            char *to = text_b + d;
            const char *from = text_a + s;
            __asm__ volatile("rep movsb" : "+D"(to), "+S"(from), "+c"(count) : : "memory");
            h = mix(h, (u32)text_b[(d + n / 2) & 4095]);
        }
        /* system calls through WOW64 (the checksum does not see the time) */
        for(int i = 0; i < 400; i++) { QueryPerformanceCounter(&t); h += t.QuadPart != 0; }
    }
    return h;
}

void __attribute__((stdcall)) entry(void)
{
    char path[MAX_PATH];
    GetModuleFileNameA(0, path, sizeof(path));
    DWORD at = 0, last = 0;
    while(path[at]) { if(path[at] == '\\') last = at + 1; at++; }
    const char name[] = "LOAD32.TXT";
    for(at = 0; at < sizeof(name); at++) path[last + at] = name[at];
    result = CreateFileA(path, GENERIC_WRITE, FILE_SHARE_READ, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if(result == INVALID_HANDLE_VALUE) ExitProcess(10);
    int rounds = 0;
    for(const char *c = GetCommandLineA(); *c; c++) rounds = *c >= '0' && *c <= '9' ? rounds * 10 + (*c - '0') : 0;
    if(rounds <= 0) rounds = 5;
    /* a random cycle through CHASE slots */
    for(u32 i = 0; i < CHASE; i++) next[i] = i;
    for(u32 i = CHASE - 1; i > 0; i--) { u32 j = lcg() % i, t = next[i]; next[i] = next[j]; next[j] = t; }
    for(int i = 0; i < 4096; i++) text_a[i] = (char)lcg();
    BOOL wow64 = FALSE;
    IsWow64Process(GetCurrentProcess(), &wow64);
    LARGE_INTEGER frequency;
    QueryPerformanceFrequency(&frequency);
    text("CPULOAD32 wow64="); number(wow64); text(" frequency="); number(frequency.LowPart); text("\r\n");
    /* (QPC frequencies are below 2^32 and a round lasts less than 2^32 ticks) */
    u32 per_ms = frequency.LowPart / 1000;
    u32 h = 0;
    for(int r = 0; r < rounds; r++)
    {
        LARGE_INTEGER start, end;
        seed = 1;
        QueryPerformanceCounter(&start);
        h = round_work(h);
        QueryPerformanceCounter(&end);
        text("round "); number(r); text(" ms="); number((u32)(end.QuadPart - start.QuadPart) / per_ms);
        text(" checksum="); hex(h); text("\r\n");
        FlushFileBuffers(result);
    }
    text("CPULOAD32_DONE\r\n");
    finish(0);
}
