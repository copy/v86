// Drive the real application's own tab/buttons, without modifying its EXE.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <commctrl.h>
static HWND tab, windowed, render;
static void report(const char *text) {
    DWORD written;HANDLE file=CreateFileA("C:\\GLTEST\\glview-ui.log",FILE_APPEND_DATA,FILE_SHARE_READ,NULL,OPEN_ALWAYS,0,NULL);
    if(file!=INVALID_HANDLE_VALUE){WriteFile(file,text,(DWORD)lstrlenA(text),&written,NULL);WriteFile(file,"\r\n",2,&written,NULL);CloseHandle(file);}
}
static BOOL CALLBACK find_control(HWND window, LPARAM unused) {
    char name[128], text[128];(void)unused;
    GetClassNameA(window,name,sizeof(name));GetWindowTextA(window,text,sizeof(text));
    char *out=text;for(char *at=text;*at;at++)if(*at!='&')*out++=*at;*out=0;
    report(name);report(text);
    if(!lstrcmpA(name,"SysTabControl32"))tab=window;
    if(!lstrcmpiA(text,"Windowed"))windowed=window;
    if(!lstrcmpiA(text,"Rendering test")&&(GetWindowLongA(window,GWL_STYLE)&BS_TYPEMASK)!=BS_GROUPBOX)render=window;
    return TRUE;
}
void WINAPI entry(void) {
    HWND main_window=NULL;DWORD start=GetTickCount();
    while(!main_window&&GetTickCount()-start<60000){main_window=FindWindowA(NULL,"OpenGL Extensions Viewer");Sleep(200);}
    if(!main_window)ExitProcess(10);
    Sleep(3000);EnumChildWindows(main_window,find_control,0);if(!tab)ExitProcess(11);
    // WM_USER control messages do not marshal pointers across processes.
    // Use pointer-free keyboard input on the real tab instead.
    MSG message;PeekMessageA(&message,NULL,0,0,PM_NOREMOVE);
    DWORD thread=GetWindowThreadProcessId(tab,NULL);AttachThreadInput(GetCurrentThreadId(),thread,TRUE);
    SetForegroundWindow(main_window);SetFocus(tab);
    SendMessageA(tab,WM_KEYDOWN,VK_HOME,0);SendMessageA(tab,WM_KEYUP,VK_HOME,0);
    for(int i=0;i<5;i++){SendMessageA(tab,WM_KEYDOWN,VK_RIGHT,0);SendMessageA(tab,WM_KEYUP,VK_RIGHT,0);}
    AttachThreadInput(GetCurrentThreadId(),thread,FALSE);Sleep(1000);
    EnumChildWindows(main_window,find_control,0);if(!windowed||!render)ExitProcess(12);
    SendMessageA(windowed,BM_SETCHECK,BST_CHECKED,0);
    SendMessageA(GetParent(windowed),WM_COMMAND,MAKEWPARAM(GetDlgCtrlID(windowed),BN_CLICKED),(LPARAM)windowed);
    report("RENDER_BUTTON_FOUND");SendMessageA(render,BM_CLICK,0,0);ExitProcess(0);
}
