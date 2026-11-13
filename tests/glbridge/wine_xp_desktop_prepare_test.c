/* Exercise actual XP property-sheet and MessageBox controls in another process.
 * The page deliberately reuses IDCANCEL for a privacy button. */
#include <windows.h>
#include <commctrl.h>
#include <prsht.h>
#include <stdio.h>
static unsigned privacy_clicks, cancelled;
static volatile LONG restart_answer;
static INT_PTR CALLBACK page_proc(HWND page, UINT message, WPARAM wp, LPARAM lp)
{
    if (message == WM_INITDIALOG) {
        CreateWindowA("Button", "Read our privacy policy", WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
                10, 10, 200, 24, page, (HMENU)(INT_PTR)IDCANCEL, GetModuleHandleA(NULL), NULL);
        return TRUE;
    }
    if (message == WM_COMMAND && LOWORD(wp) == IDCANCEL && (HWND)lp == GetDlgItem(page, IDCANCEL)) {
        ++privacy_clicks;
        return TRUE;
    }
    if (message == WM_NOTIFY && ((NMHDR *)lp)->code == PSN_SETACTIVE) {
        PropSheet_SetWizButtons(GetParent(page), PSWIZB_NEXT);
        return TRUE;
    }
    if (message == WM_NOTIFY && ((NMHDR *)lp)->code == PSN_QUERYCANCEL) {
        ++cancelled;
        SetWindowLongPtrA(page, DWLP_MSGRESULT, FALSE);
        return TRUE;
    }
    return FALSE;
}
static BOOL launch_prepare(PROCESS_INFORMATION *process)
{
    char path[MAX_PATH];
    STARTUPINFOA start;
    GetModuleFileNameA(NULL, path, MAX_PATH);
    unsigned at = lstrlenA(path);
    while (at && path[at - 1] != 92) --at;
    path[at] = 0;
    lstrcatA(path, "PREPARE.EXE");
    ZeroMemory(&start, sizeof(start));start.cb = sizeof(start);
    ZeroMemory(process, sizeof(*process));
    return CreateProcessA(path, NULL, NULL, NULL, TRUE, 0, NULL, NULL, &start, process);
}
static BOOL wait_prepare(PROCESS_INFORMATION *process, HWND *sheet)
{
    DWORD began = GetTickCount(), code = STILL_ACTIVE;
    while (GetTickCount() - began < 75000) {
        MSG message;
        while (PeekMessageA(&message, NULL, 0, 0, PM_REMOVE)) {
            if (!sheet || !*sheet || !PropSheet_IsDialogMessage(*sheet, &message)) {
                TranslateMessage(&message);DispatchMessageA(&message);
            }
        }
        if (sheet && *sheet && !PropSheet_GetCurrentPageHwnd(*sheet)) {
            DestroyWindow(*sheet);*sheet = NULL;
        }
        GetExitCodeProcess(process->hProcess, &code);
        if (code != STILL_ACTIVE) break;
        Sleep(10);
    }
    CloseHandle(process->hThread);CloseHandle(process->hProcess);
    return code == 0;
}
static DWORD WINAPI restart_dialog(void *unused)
{
    (void)unused;
    restart_answer = MessageBoxA(NULL,
            "Windows has finished installing new devices.\nDo you want to restart your computer now?",
            "System Settings Change", MB_YESNO | MB_ICONQUESTION);
    return 0;
}
int main(void)
{
    union { DWORD align; BYTE bytes[128]; } resource;
    PROPSHEETPAGEA page;
    PROPSHEETHEADERA header;
    PROCESS_INFORMATION child;
    setvbuf(stdout, NULL, _IONBF, 0);
    InitCommonControls();
    ZeroMemory(&resource, sizeof(resource));
    DLGTEMPLATE *dialog = (DLGTEMPLATE *)resource.bytes;
    dialog->style = WS_CHILD | DS_CONTROL;dialog->cx = 240;dialog->cy = 100;
    ZeroMemory(&page, sizeof(page));page.dwSize = sizeof(page);page.dwFlags = PSP_DLGINDIRECT;
    page.hInstance = GetModuleHandleA(NULL);page.pResource = dialog;page.pfnDlgProc = page_proc;
    ZeroMemory(&header, sizeof(header));header.dwSize = sizeof(header);
    header.dwFlags = PSH_PROPSHEETPAGE | PSH_WIZARD | PSH_MODELESS;
    header.hInstance = GetModuleHandleA(NULL);header.pszCaption = "Found New Hardware Wizard";
    header.nPages = 1;header.ppsp = &page;
    HWND sheet = (HWND)PropertySheetA(&header);
    if (!sheet || sheet == (HWND)-1) goto failed;
    SetWindowTextA(sheet, "Found New Hardware Wizard");
    ShowWindow(sheet, SW_SHOW);
    UpdateWindow(sheet);
    char klass[32], title[128];
    GetClassNameA(sheet, klass, sizeof(klass));GetWindowTextA(sheet, title, sizeof(title));
    printf("TEST wizard_class=%s title=%s visible=%u\n", klass, title, IsWindowVisible(sheet));
    if (!IsWindowVisible(sheet) || lstrcmpA(klass, "#32770") || !launch_prepare(&child)) goto failed;
    if (!wait_prepare(&child, &sheet) || sheet || cancelled != 1 || privacy_clicks) goto failed;
    printf("PASS wizard_cancel=1 privacy_clicks=%u cancellation_notifications=%u\n", privacy_clicks, cancelled);
    HANDLE thread = CreateThread(NULL, 0, restart_dialog, NULL, 0, NULL);
    if (!thread || !launch_prepare(&child)) goto failed;
    BOOL prepared = wait_prepare(&child, NULL);
    BOOL answered = WaitForSingleObject(thread, 1000) == WAIT_OBJECT_0;
    CloseHandle(thread);
    if (!prepared || !answered || restart_answer != IDNO) goto failed;
    printf("PASS restart_answer=IDNO\nCOMPLETE desktop_prepare_test=1\n");
    return 0;
failed:
    printf("FAIL desktop preparation controls privacy_clicks=%u cancellation_notifications=%u restart_answer=%ld\n",
            privacy_clicks, cancelled, restart_answer);
    return 1;
}
