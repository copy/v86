/* Test-only mouse input for guests without an absolute-pointer driver.
 * Coordinates are in the named game's client area; no account data is used. */
#include <windows.h>
#include <stdlib.h>
#include <stdio.h>
int main(int argc, char **argv)
{
    HWND window;
    RECT client;
    POINT point;
    if (argc != 4 || !(window = FindWindowA(NULL, argv[1]))) return 1;
    point.x = atoi(argv[2]); point.y = atoi(argv[3]);
    if (!GetClientRect(window, &client) || point.x < 0 || point.y < 0
            || point.x >= client.right || point.y >= client.bottom) return 2;
    if (!ClientToScreen(window, &point)) return 3;
    ShowWindow(window, SW_RESTORE);
    SetForegroundWindow(window);
    Sleep(300);
    SetCursorPos(point.x, point.y);
    mouse_event(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE,
            (DWORD)((double)point.x * 65535 / (GetSystemMetrics(SM_CXSCREEN) - 1)),
            (DWORD)((double)point.y * 65535 / (GetSystemMetrics(SM_CYSCREEN) - 1)), 0, 0);
    Sleep(300);
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
    Sleep(100);
    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
    Sleep(300);
    GetCursorPos(&point);
    printf("click client %s,%s; screen %ld,%ld; foreground=%d\n",
            argv[2], argv[3], point.x, point.y, GetForegroundWindow() == window);
    return 0;
}
