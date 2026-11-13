/* Local XP setup only. Recognize boot PnP UI, then exit before Wine starts. */
#include <windows.h>
#include <commctrl.h>
#include <prsht.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

typedef struct Body { char text[4096]; unsigned used; } Body;
typedef struct Button { BOOL restart; HWND found; } Button;
typedef struct Boot { HWND restart, wizard; } Boot;

static void flush_log(void)
{
    fflush(stdout);
    FlushFileBuffers(GetStdHandle(STD_OUTPUT_HANDLE));
}

static BOOL CALLBACK body_child(HWND child, LPARAM data)
{
    Body *body = (Body *)data;
    char klass[32], text[1024] = {0};
    DWORD_PTR count = 0;
    GetClassNameA(child, klass, sizeof(klass));
    if (lstrcmpiA(klass, "Static")) return TRUE;
    DWORD kind = (DWORD)GetWindowLongA(child, GWL_STYLE) & SS_TYPEMASK;
    if (kind != SS_LEFT && kind != SS_CENTER && kind != SS_RIGHT &&
            kind != SS_SIMPLE && kind != SS_LEFTNOWORDWRAP)
        return TRUE;
    if (SendMessageTimeoutA(child, WM_GETTEXT, sizeof(text), (LPARAM)text,
            SMTO_ABORTIFHUNG, 1000, &count) && count > 0 &&
            count < sizeof(text) && body->used + count + 2 < sizeof(body->text)) {
        memcpy(body->text + body->used, text, count);
        body->used += count;
        body->text[body->used++] = ' ';
        body->text[body->used] = 0;
    }
    return TRUE;
}

static BOOL button_caption(HWND button, BOOL restart, BOOL log)
{
    WCHAR text[128] = {0}, normalized[128];
    DWORD_PTR count = 0;
    unsigned used = 0;
    if (!SendMessageTimeoutW(button, WM_GETTEXT, 128, (LPARAM)text,
            SMTO_ABORTIFHUNG, 1000, &count) || count >= 128)
        return FALSE;
    for (unsigned i = 0; text[i] && used < 127; ++i)
        if (text[i] != L'&' && text[i] != L' ') normalized[used++] = text[i];
    normalized[used] = 0;
    BOOL match = restart
        ? !lstrcmpiW(normalized, L"No") || !lstrcmpiW(normalized, L"No(N)") ||
            !lstrcmpW(normalized, L"\x5426") || !lstrcmpW(normalized, L"\x5426(N)")
        : !lstrcmpiW(normalized, L"Cancel") || !lstrcmpiW(normalized, L"Cancel(C)") ||
            !lstrcmpW(normalized, L"\x53d6\x6d88") || !lstrcmpW(normalized, L"\x53d6\x6d88(C)");
    if (log) {
        printf("PNP control_id=%d caption_utf16=", GetDlgCtrlID(button));
        for (unsigned i = 0; text[i]; ++i) printf("%04X,", (unsigned)text[i]);
        printf(" match=%u\n", match);
    }
    return match;
}

static BOOL CALLBACK button_child(HWND child, LPARAM data)
{
    Button *choice = (Button *)data;
    char klass[32];
    GetClassNameA(child, klass, sizeof(klass));
    if (lstrcmpiA(klass, "Button") || !IsWindowVisible(child) || !IsWindowEnabled(child))
        return TRUE;
    if (!button_caption(child, choice->restart, FALSE)) return TRUE;
    choice->found = child;
    return FALSE;
}

static BOOL CALLBACK boot_window(HWND window, LPARAM data)
{
    Boot *boot = (Boot *)data;
    char klass[32], title[128];
    if (!IsWindowVisible(window)) return TRUE;
    GetClassNameA(window, klass, sizeof(klass));
    if (lstrcmpA(klass, "#32770")) return TRUE;
    GetWindowTextA(window, title, sizeof(title));
    if (!lstrcmpA(title, "System Settings Change")) boot->restart = window;
    if (!lstrcmpA(title, "Found New Hardware Wizard")) boot->wizard = window;
    return TRUE;
}

static BOOL close_known(HWND window, BOOL restart)
{
    char title[128];
    Body body = {{0}, 0};
    Button choice = {restart, NULL};
    GetWindowTextA(window, title, sizeof(title));
    EnumChildWindows(window, body_child, (LPARAM)&body);
    printf("PNP title=%s enabled=%u body=%s\n", title, IsWindowEnabled(window), body.text);
    if (!IsWindowEnabled(window)) return FALSE;
    EnumChildWindows(window, button_child, (LPARAM)&choice);
    if (!choice.found || GetAncestor(choice.found, GA_ROOT) != window) return FALSE;
    button_caption(choice.found, restart, TRUE);
    if (IsIconic(window)) ShowWindow(window, SW_RESTORE);
    SetForegroundWindow(window);
    if (restart) {
        if (!strstr(body.text, "Windows has finished installing new devices.") ||
                !strstr(body.text, "Do you want to restart your computer now?") ||
                GetDlgCtrlID(choice.found) != IDNO)
            return FALSE;
        DWORD_PTR result;
        if (!SendMessageTimeoutW(choice.found, BM_CLICK, 0, 0,
                SMTO_ABORTIFHUNG, 2000, &result)) return FALSE;
    } else {
        /* Property sheet pages can reuse IDCANCEL for unrelated controls.
         * Resolve the actual Cancel caption, then use the sheet protocol. */
        if (!PostMessageA(window, PSM_PRESSBUTTON, PSBTN_CANCEL, 0)) return FALSE;
    }
    printf("PNP action=%s\n", restart ? "decline_restart" : "cancel_hardware_wizard");
    flush_log();
    return TRUE;
}

typedef DWORD (WINAPI *PendingInstall)(DWORD);
static PendingInstall pending_install(void)
{
    const char *names[] = {"cfgmgr32.dll", "setupapi.dll"};
    for (unsigned i = 0; i < 2; ++i) {
        char path[MAX_PATH];
        UINT n = GetSystemDirectoryA(path, MAX_PATH);
        if (!n || n + lstrlenA(names[i]) + 2 >= MAX_PATH) return NULL;
        lstrcatA(path, "\\");lstrcatA(path, names[i]);
        HMODULE module = LoadLibraryA(path);
        if (!module) continue;
        PendingInstall query = (PendingInstall)GetProcAddress(module, "CMP_WaitNoPendingInstallEvents");
        if (!query) query = (PendingInstall)GetProcAddress(module, "CM_WaitNoPendingInstallEvents");
        if (query) { printf("PNP readiness_api=%s\n", names[i]);return query; }
        FreeLibrary(module);
    }
    return NULL;
}

int main(int argc, char **argv)
{
    DWORD began = GetTickCount(), quiet = began, last_action = 0, last_wait = ~0u;
    HWND pending = NULL;
    unsigned actions = 0, retries = 0, closed = 0;
    setvbuf(stdout, NULL, _IONBF, 0);
    PendingInstall query = pending_install();
    if (!query) { printf("FAIL XP PnP readiness API unavailable\n");flush_log();return 1; }
    if (argc == 2 && !lstrcmpA(argv[1], "--check-only")) {
        Boot boot = {NULL, NULL};EnumWindows(boot_window, (LPARAM)&boot);
        DWORD state = query(0);
        printf("CHECK pending_wait=%08lX restart=%u wizard=%u\n", state, boot.restart != NULL, boot.wizard != NULL);
        if (state == WAIT_OBJECT_0 && !boot.restart && !boot.wizard) {
            printf("COMPLETE desktop_postcheck=1\n");flush_log();return 0;
        }
        printf("UNREADY desktop changed during suite\n");flush_log();return 1;
    }
    printf("PREPARE start=%lu\n", began);
    flush_log();
    while (GetTickCount() - began < 60000) {
        Boot boot = {NULL, NULL};
        EnumWindows(boot_window, (LPARAM)&boot);
        HWND window = boot.restart ? boot.restart : boot.wizard;
        DWORD now = GetTickCount();
        DWORD state = query(0);
        if (state != last_wait) { printf("PNP pending_wait=%08lX\n", state);flush_log();last_wait = state; }
        if (state != WAIT_OBJECT_0 && state != WAIT_TIMEOUT) {
            printf("FAIL PnP readiness query error=%lu\n", GetLastError());flush_log();return 1;
        }
        if (state == WAIT_TIMEOUT) quiet = now;
        if (pending && (!IsWindow(pending) || !IsWindowVisible(pending))) {
            ++closed;
            pending = NULL;
            retries = 0;
        }
        if (window) {
            quiet = now;
            if (window != pending || now - last_action >= 2000) {
                if (window != pending) retries = 0;
                if (++retries > 3 || !close_known(window, boot.restart != NULL)) {
                    printf("FAIL PnP cancellation was not acknowledged\n");
                    flush_log();
                    return 1;
                }
                pending = window;
                last_action = GetTickCount();
                ++actions;
            }
        } else if (state == WAIT_OBJECT_0 && now - quiet >= 10000) {
            printf("COMPLETE desktop_prepare=1 dialogs_closed=%u actions=%u quiet_ms=%lu\n",
                    closed, actions, now - quiet);
            flush_log();
            return 0;
        }
        Sleep(100);
    }
    printf("FAIL PnP desktop did not settle\n");
    flush_log();
    return 1;
}
