/* Local XP test setup only. Close known boot-time PnP UI before Wine starts.
 * No helper thread, registry changes, or input runs during the test suite. */
#include <windows.h>
#include <stdio.h>
#include <string.h>

static BOOL read_body(HWND dialog, char *body, unsigned capacity)
{
    HWND child = GetWindow(dialog, GW_CHILD);
    unsigned used = 0;
    body[0] = 0;
    while (child) {
        char klass[32], text[1024];
        GetClassNameA(child, klass, sizeof(klass));
        if (!lstrcmpiA(klass, "Static")) {
            int count = GetWindowTextA(child, text, sizeof(text));
            if (count > 0 && used + (unsigned)count + 2 < capacity) {
                memcpy(body + used, text, count);
                used += count;
                body[used++] = ' ';
                body[used] = 0;
            }
        }
        child = GetWindow(child, GW_HWNDNEXT);
    }
    return used != 0;
}

static int close_known(HWND window, BOOL restart)
{
    char klass[64], body[4096], button_class[32], title[128];
    int id = restart ? IDNO : IDCANCEL;
    HWND button;
    GetClassNameA(window, klass, sizeof(klass));
    GetWindowTextA(window, title, sizeof(title));
    read_body(window, body, sizeof(body));
    button = GetDlgItem(window, id);
    button_class[0] = 0;
    if (button) GetClassNameA(button, button_class, sizeof(button_class));
    printf("PNP title=%s class=%s button=%d button_class=%s body=%s\n",
            title, klass, id, button_class, body);
    if (lstrcmpA(klass, "#32770") || !button ||
            lstrcmpiA(button_class, "Button") || !IsWindowEnabled(button))
        return 0;
    if (restart && (!strstr(body, "Windows has finished installing new devices.") ||
            !strstr(body, "Do you want to restart your computer now?")))
        return 0;
    SendMessageA(window, WM_COMMAND, MAKEWPARAM(id, BN_CLICKED), (LPARAM)button);
    printf("PNP action=%s\n", restart ? "decline_restart" : "cancel_hardware_wizard");
    return 1;
}

int main(void)
{
    DWORD began = GetTickCount(), quiet = began;
    unsigned closed = 0;
    setvbuf(stdout, NULL, _IONBF, 0);
    printf("PREPARE start=%lu\n", began);
    while (GetTickCount() - began < 30000) {
        HWND restart = FindWindowA(NULL, "System Settings Change");
        HWND wizard = FindWindowA(NULL, "Found New Hardware Wizard");
        if (restart || wizard) {
            if (!close_known(restart ? restart : wizard, restart != NULL)) {
                printf("FAIL unrecognized PnP dialog\n");
                return 1;
            }
            ++closed;
            quiet = GetTickCount();
        } else if (GetTickCount() - quiet >= 10000) {
            printf("COMPLETE desktop_prepare=1 dialogs_closed=%u quiet_ms=%lu\n",
                    closed, GetTickCount() - quiet);
            return 0;
        }
        Sleep(100);
    }
    printf("FAIL PnP desktop did not settle\n");
    return 1;
}
