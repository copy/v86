/* Test-only observation of the actual guest UI. No benchmark results are synthesized. */
#include <windows.h>
#include <stdio.h>
#include <string.h>

static HANDLE serial;
static void line(const char *text)
{
    DWORD written;
    fputs(text, stdout);
    if (serial != INVALID_HANDLE_VALUE) WriteFile(serial, text, (DWORD)strlen(text), &written, NULL);
}
static BOOL CALLBACK describe(HWND window, LPARAM child)
{
    char title[512], klass[128], buffer[1024];
    RECT rect;
    if (!IsWindowVisible(window)) return TRUE;
    GetWindowTextA(window, title, sizeof(title));
    GetClassNameA(window, klass, sizeof(klass));
    GetWindowRect(window, &rect);
    snprintf(buffer, sizeof(buffer), "%s hwnd=%p id=%d rect=%ld,%ld,%ld,%ld enabled=%d class=%s text=%s\r\n",
            child ? "CONTROL" : "WINDOW", (void *)window, GetDlgCtrlID(window),
            rect.left, rect.top, rect.right, rect.bottom, IsWindowEnabled(window), klass, title);
    line(buffer);
    if (!child) EnumChildWindows(window, describe, 1);
    return TRUE;
}
int main(void)
{
    DCB dcb;
    COMMTIMEOUTS timeouts;
    serial = CreateFileA("COM1", GENERIC_WRITE, 0, NULL, OPEN_EXISTING, 0, NULL);
    if (serial == INVALID_HANDLE_VALUE) {
        line("BENCH_UI_BEGIN\r\n"); EnumWindows(describe, 0); line("BENCH_UI_END\r\n");
        return 0;
    }
    memset(&dcb, 0, sizeof(dcb)); dcb.DCBlength = sizeof(dcb);
    if (!GetCommState(serial, &dcb)) goto no_serial;
    dcb.BaudRate = CBR_115200; dcb.ByteSize = 8; dcb.Parity = NOPARITY; dcb.StopBits = ONESTOPBIT;
    dcb.fOutxCtsFlow = FALSE; dcb.fOutxDsrFlow = FALSE; dcb.fOutX = FALSE; dcb.fInX = FALSE;
    if (!SetCommState(serial, &dcb)) goto no_serial;
    memset(&timeouts, 0, sizeof(timeouts)); timeouts.WriteTotalTimeoutConstant = 5000;
    SetCommTimeouts(serial, &timeouts);
    line("BENCH_UI_BEGIN\r\n"); EnumWindows(describe, 0); line("BENCH_UI_END\r\n");
    FlushFileBuffers(serial); CloseHandle(serial); return 0;
no_serial:
    CloseHandle(serial); serial = INVALID_HANDLE_VALUE;
    line("BENCH_UI_BEGIN\r\n"); EnumWindows(describe, 0); line("BENCH_UI_END\r\n");
    return 0;
}
