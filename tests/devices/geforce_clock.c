/* Native timing diagnostic; no graphics API hooks. Compile with the same
 * freestanding MinGW options as geforce_probe.c, linking kernel32/user32.
 * NV_CLOCK_FULLSCREEN waits for an 800x600 benchmark before sampling. Use
 * the windows subsystem so the probe does not take exclusive-mode focus.
 * NV.TXT is written beside this executable (including on a RAM floppy). */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

static HANDLE output;

static void text(const char *value)
{
    DWORD written;
    WriteFile(output, value, lstrlenA(value), &written, 0);
    FlushFileBuffers(output);
}

static void number(const char *label, DWORD value)
{
    char line[96];
    unsigned length = 0;
    while(*label) line[length++] = *label++;
    line[length++] = '=';
    for(int i = 7; i >= 0; i--) line[length++] = "0123456789abcdef"[(value >> (i * 4)) & 15];
    line[length++] = '\r'; line[length++] = '\n'; line[length] = 0;
    text(line);
}

static ULONGLONG tsc(void)
{
    DWORD low, high;
    __asm__ volatile("rdtsc" : "=a"(low), "=d"(high));
    return ((ULONGLONG)high << 32) | low;
}

void WINAPI entry(void)
{
    char path[MAX_PATH];
    GetModuleFileNameA(0, path, MAX_PATH);
    char *end = path + lstrlenA(path);
    while(end > path && end[-1] != '\\') end--;
    lstrcpyA(end, "NV.TXT");
    output = CreateFileA(path, GENERIC_WRITE, FILE_SHARE_READ, 0, CREATE_ALWAYS, 0, 0);
    if(output == INVALID_HANDLE_VALUE) ExitProcess(1);
    text("NATIVE_CLOCK_DIAGNOSTIC\r\n");
#ifdef NV_CLOCK_FULLSCREEN
    text("WAIT_FOR_800x600\r\n");
    DWORD wait_start = GetTickCount();
    while(GetSystemMetrics(SM_CXSCREEN) != 800 || GetSystemMetrics(SM_CYSCREEN) != 600)
    {
        if(GetTickCount() - wait_start >= 300000)
        {
            text("FULLSCREEN_TIMEOUT\r\n"); CloseHandle(output); ExitProcess(2);
        }
        Sleep(100);
    }
    text("FULLSCREEN_STARTED\r\n");
    Sleep(10000);
#endif
    LARGE_INTEGER frequency;
    BOOL ok = QueryPerformanceFrequency(&frequency);
    number("QPF_OK", ok);
    if(ok) { number("QPF_LO", frequency.LowPart); number("QPF_HI", frequency.HighPart); }
    for(unsigned sample = 0; sample < 3; sample++)
    {
        LARGE_INTEGER before, after;
        DWORD start = GetTickCount();
        QueryPerformanceCounter(&before);
        ULONGLONG cycles = tsc();
        Sleep(5000);
        cycles = tsc() - cycles;
        QueryPerformanceCounter(&after);
        DWORD elapsed = GetTickCount() - start;
        ULONGLONG ticks = after.QuadPart - before.QuadPart;
        number("SAMPLE", sample); number("TICK_MS", elapsed);
        number("QPC_DELTA_LO", (DWORD)ticks); number("QPC_DELTA_HI", (DWORD)(ticks >> 32));
        number("TSC_DELTA_LO", (DWORD)cycles); number("TSC_DELTA_HI", (DWORD)(cycles >> 32));
    }
    text("END\r\n"); CloseHandle(output); ExitProcess(0);
}
