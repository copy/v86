/* Test-only observation of the actual guest UI. No benchmark results are synthesized. */
#include <windows.h>
#include <commctrl.h>
#include <stdio.h>
#include <string.h>

static HANDLE serial;
static int list_found, list_failed;
static BOOL CALLBACK read_list(HWND window, LPARAM ignored)
{
    char klass[128];DWORD pid;DWORD_PTR rows, columns, header;
    (void)ignored;
    GetClassNameA(window, klass, sizeof(klass));
    if (strcmp(klass, "SysListView32")) return TRUE;
    ++list_found;
    if (!SendMessageTimeoutA(window, LVM_GETITEMCOUNT, 0, 0, SMTO_ABORTIFHUNG, 1000, &rows) || rows > 10000 ||
        !SendMessageTimeoutA(window, LVM_GETHEADER, 0, 0, SMTO_ABORTIFHUNG, 1000, &header) ||
        !SendMessageTimeoutA((HWND)header, HDM_GETITEMCOUNT, 0, 0, SMTO_ABORTIFHUNG, 1000, &columns) || columns > 16) {
        list_failed = 1;return FALSE;
    }
    GetWindowThreadProcessId(window, &pid);
    HANDLE process = OpenProcess(PROCESS_VM_READ | PROCESS_VM_WRITE | PROCESS_VM_OPERATION, FALSE, pid);
    if (!process) {list_failed = 1;return FALSE;}
    BYTE *remote = VirtualAllocEx(process, NULL, sizeof(LVITEMA) + 4096, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!remote) {CloseHandle(process);list_failed = 1;return FALSE;}
    for (DWORD_PTR row = 0; row < rows && !list_failed; ++row) {
        for (DWORD_PTR column = 0; column < columns; ++column) {
            LVITEMA item;char text[4096];DWORD_PTR copied;SIZE_T count;
            memset(&item, 0, sizeof(item));item.iSubItem = (int)column;
            item.pszText = (LPSTR)(remote + sizeof(item));item.cchTextMax = sizeof(text);
            if (!WriteProcessMemory(process, remote, &item, sizeof(item), &count) || count != sizeof(item) ||
                !SendMessageTimeoutA(window, LVM_GETITEMTEXTA, row, (LPARAM)remote, SMTO_ABORTIFHUNG, 1000, &copied) ||
                copied >= sizeof(text) || !ReadProcessMemory(process, remote + sizeof(item), text, copied, &count) || count != copied) {
                list_failed = 1;break;
            }
            text[copied] = 0;printf("%s%s", column ? "\t" : "", text);
        }
        fputs("\r\n", stdout);
    }
    VirtualFreeEx(process, remote, 0, MEM_RELEASE);CloseHandle(process);
    return !list_failed;
}
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
int main(int argc, char **argv)
{
    DCB dcb;
    COMMTIMEOUTS timeouts;
    if (argc == 3 && !strcmp(argv[1], "--list")) {
        HWND window = FindWindowA(NULL, argv[2]);
        if (!window) return 1;
        EnumChildWindows(window, read_list, 0);
        return !list_found || list_failed;
    }
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
