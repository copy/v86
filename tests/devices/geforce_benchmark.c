/* Native XP benchmark launcher. Prime the catalog/thread-pool APIs before an
 * old engine DLL calls DirectDrawEnumerate from DllMain while holding the loader
 * lock. The original EXE, DLLs and graphics APIs are never replaced or patched
 * on disk. A temporary entry breakpoint is restored before running the EXE. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
static HANDLE log_file;
static BYTE stub[4096];static unsigned int used;
static void zero(void *p,unsigned int n) {BYTE *b=p;while(n--)*b++=0;}
static void log_text(const char *s) {DWORD n;WriteFile(log_file,s,lstrlenA(s),&n,0);FlushFileBuffers(log_file);}
static void value(const char *label,DWORD n)
{
    char b[11];const char hex[]="0123456789abcdef";b[0]='0';b[1]='x';
    for(int i=0;i<8;i++)b[i+2]=hex[n>>(28-4*i)&15];
    b[10]=0;
    log_text(label);log_text(b);log_text("\r\n");
}
static void byte(BYTE b) {stub[used++]=b;}
static void word(DWORD n) {for(int i=0;i<4;i++)byte((BYTE)(n>>(i*8)));}
static void push(DWORD n) {byte(0x68);word(n);}
static void call(FARPROC proc) {byte(0xB8);word((DWORD)(ULONG_PTR)proc);byte(0xFF);byte(0xD0);}
static unsigned int unless(void) {byte(0x85);byte(0xC0);byte(0x74);byte(0);return used-1;}
static BOOL prefix(const char *s,const char *p) {while(*p)if(*s++!=*p++)return FALSE;return TRUE;}
static unsigned int build_stub(DWORD base)
{
    HMODULE kernel=GetModuleHandleA("kernel32.dll");unsigned int jump[4];
    lstrcpyA((char*)stub+256,"wintrust.dll");lstrcpyA((char*)stub+280,"CryptCATAdminAcquireContext");
    lstrcpyA((char*)stub+320,"CryptCATAdminReleaseContext");used=0;
    push(base+256);call(GetProcAddress(kernel,"LoadLibraryA"));jump[0]=unless();
    byte(0x89);byte(0xC3); /* EBX = module, preserved by stdcall */
    push(base+280);byte(0x53);call(GetProcAddress(kernel,"GetProcAddress"));jump[1]=unless();
    push(0);push(0);push(base+384);byte(0xFF);byte(0xD0);
    byte(0xA3);word(base+388);jump[2]=unless();
    push(base+320);byte(0x53);call(GetProcAddress(kernel,"GetProcAddress"));jump[3]=unless();
    push(0);byte(0xFF);byte(0x35);word(base+384);byte(0xFF);byte(0xD0);
    for(int i=0;i<4;i++)stub[jump[i]]=(BYTE)(used-jump[i]-1);
    byte(0xCC);return used-1;
}
void WINAPI entry(void)
{
    char exe[MAX_PATH],cwd[MAX_PATH],command[MAX_PATH*2],output[MAX_PATH];
    char *args=GetCommandLineA();BOOL quote=*args=='"';if(quote)args++;
    while(*args && (quote?*args!='"':*args!=' '))args++;
    if(quote && *args)args++;
    while(*args==' ')args++;
    if(prefix(args,"/win98 ")) {SetEnvironmentVariableA("__COMPAT_LAYER","WIN98");args+=7;}
    quote=*args=='"';if(quote)args++;unsigned int n=0;
    while(*args && (quote?*args!='"':*args!=' ') && n<MAX_PATH-1)exe[n++]=*args++;
    exe[n]=0;
    GetModuleFileNameA(0,output,MAX_PATH);char *tail=output+lstrlenA(output);while(tail>output && tail[-1]!='\\')tail--;lstrcpyA(tail,"NVLAUNCH.TXT");
    log_file=CreateFileA(output,GENERIC_WRITE,FILE_SHARE_READ,0,CREATE_ALWAYS,0,0);
    log_text("NV40_NATIVE_LAUNCH\r\n");log_text(exe);log_text("\r\n");
    if(!n || n>=MAX_PATH-1)goto fail;
    lstrcpyA(cwd,exe);tail=cwd+lstrlenA(cwd);while(tail>cwd && tail[-1]!='\\')tail--;if(tail>cwd)tail[-1]=0;else goto fail;
    command[0]='"';lstrcpyA(command+1,exe);lstrcatA(command,"\"");
    STARTUPINFOA startup;PROCESS_INFORMATION process;zero(&startup,sizeof(startup));startup.cb=sizeof(startup);zero(&process,sizeof(process));
    if(!CreateProcessA(exe,command,0,0,FALSE,DEBUG_ONLY_THIS_PROCESS,0,cwd,&startup,&process))goto fail;
    value("PID=",process.dwProcessId);DebugSetProcessKillOnExit(FALSE);
    BYTE original=0;LPVOID entry_address=0,remote=0;DWORD protection=0;BOOL at_entry=FALSE,primed=FALSE;
    unsigned int final_break=0;CONTEXT saved;DEBUG_EVENT event;DWORD started=GetTickCount();
    while(primed || GetTickCount()-started<120000)
    {
        if(!WaitForDebugEvent(&event,1000))continue;
        DWORD action=DBG_CONTINUE;
        if(event.dwDebugEventCode==CREATE_PROCESS_DEBUG_EVENT)
        {
            if(event.u.CreateProcessInfo.hFile)CloseHandle(event.u.CreateProcessInfo.hFile);
            entry_address=event.u.CreateProcessInfo.lpStartAddress;
            SIZE_T count;BYTE trap=0xCC;
            if(!ReadProcessMemory(process.hProcess,entry_address,&original,1,&count) || count!=1 ||
                !VirtualProtectEx(process.hProcess,entry_address,1,PAGE_EXECUTE_READWRITE,&protection) ||
                !WriteProcessMemory(process.hProcess,entry_address,&trap,1,&count) || count!=1)goto child_fail;
            FlushInstructionCache(process.hProcess,entry_address,1);
        }
        else if(event.dwDebugEventCode==LOAD_DLL_DEBUG_EVENT) {if(event.u.LoadDll.hFile)CloseHandle(event.u.LoadDll.hFile);}
        else if(event.dwDebugEventCode==CREATE_THREAD_DEBUG_EVENT)CloseHandle(event.u.CreateThread.hThread);
        else if(event.dwDebugEventCode==EXCEPTION_DEBUG_EVENT)
        {
            const EXCEPTION_RECORD *record=&event.u.Exception.ExceptionRecord;
            if(record->ExceptionCode==EXCEPTION_BREAKPOINT && record->ExceptionAddress==entry_address && !at_entry)
            {
                SIZE_T count;DWORD ignored;zero(&saved,sizeof(saved));saved.ContextFlags=CONTEXT_FULL|CONTEXT_FLOATING_POINT|CONTEXT_EXTENDED_REGISTERS;
                if(!GetThreadContext(process.hThread,&saved) ||
                    !WriteProcessMemory(process.hProcess,entry_address,&original,1,&count) || count!=1 ||
                    !VirtualProtectEx(process.hProcess,entry_address,1,protection,&ignored))goto child_fail;
                FlushInstructionCache(process.hProcess,entry_address,1);saved.Eip=(DWORD)(ULONG_PTR)entry_address;
                remote=VirtualAllocEx(process.hProcess,0,sizeof(stub),MEM_COMMIT|MEM_RESERVE,PAGE_EXECUTE_READWRITE);
                if(!remote)goto child_fail;
                final_break=build_stub((DWORD)(ULONG_PTR)remote);
                if(!WriteProcessMemory(process.hProcess,remote,stub,sizeof(stub),&count) || count!=sizeof(stub))goto child_fail;
                FlushInstructionCache(process.hProcess,remote,sizeof(stub));
                CONTEXT context=saved;context.Eip=(DWORD)(ULONG_PTR)remote;
                if(!SetThreadContext(process.hThread,&context))goto child_fail;
                at_entry=TRUE;
            }
            else if(record->ExceptionCode==EXCEPTION_BREAKPOINT && at_entry && record->ExceptionAddress==(BYTE*)remote+final_break)
            {
                DWORD acquired=0;SIZE_T count;
                if(!ReadProcessMemory(process.hProcess,(BYTE*)remote+388,&acquired,4,&count) || count!=4 ||
                    !SetThreadContext(process.hThread,&saved))goto child_fail;
                value("CATALOG_ACQUIRED=",acquired);
                if(!acquired)goto child_fail;
                VirtualFreeEx(process.hProcess,remote,0,MEM_RELEASE);
                ContinueDebugEvent(event.dwProcessId,event.dwThreadId,DBG_CONTINUE);
                log_text("READY original entry resumed; native graphics APIs unchanged\r\n");
                primed=TRUE;continue;
            }
            else if(record->ExceptionCode!=EXCEPTION_BREAKPOINT)action=DBG_EXCEPTION_NOT_HANDLED;
        }
        else if(event.dwDebugEventCode==EXIT_PROCESS_DEBUG_EVENT)
        {
            value(primed?"EXIT_CODE=":"EARLY_EXIT=",event.u.ExitProcess.dwExitCode);
            ContinueDebugEvent(event.dwProcessId,event.dwThreadId,DBG_CONTINUE);break;
        }
        ContinueDebugEvent(event.dwProcessId,event.dwThreadId,action);
    }
    if(!primed)goto child_fail;
    CloseHandle(process.hThread);CloseHandle(process.hProcess);CloseHandle(log_file);ExitProcess(0);
child_fail:
    value("LAUNCH_ERROR=",GetLastError());TerminateProcess(process.hProcess,1);DebugActiveProcessStop(process.dwProcessId);
    CloseHandle(process.hThread);CloseHandle(process.hProcess);
fail:
    value("ERROR=",GetLastError());CloseHandle(log_file);ExitProcess(1);
}
