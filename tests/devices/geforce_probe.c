/* G0 real Windows probe. No CRT; XP and Win98 binaries use the same Win32 APIs.
 * The host supplies a RAM FAT16 disk. Every output line is flushed immediately.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <setupapi.h>
#include <cfgmgr32.h>
static char output[MAX_PATH], inf[MAX_PATH], text[1024], hardware[4096];
static unsigned int used;
typedef CONFIGRET (WINAPI *status_t)(PULONG,PULONG,DEVINST,ULONG);
static status_t node_status;
static void put(const char *s) { while(*s && used < sizeof(text)-3) text[used++] = *s++; }
static void number(DWORD n) { char b[12]; int i=11; b[i]=0; do { b[--i]='0'+n%10; n/=10; } while(n); put(b+i); }
static void line(void)
{
    DWORD wrote;
    text[used++]='\r'; text[used++]='\n';
    HANDLE f=CreateFileA(output, GENERIC_WRITE, FILE_SHARE_READ, 0, OPEN_ALWAYS, 0, 0);
    if(f!=INVALID_HANDLE_VALUE) { SetFilePointer(f,0,0,FILE_END); WriteFile(f,text,used,&wrote,0); FlushFileBuffers(f); CloseHandle(f); }
    used=0;
}
static int match(const char *s, const char *prefix)
{
    while(*prefix) { char c=*s++; if(c>='a' && c<='z') c-=32; if(c!=*prefix++) return 0; }
    return 1;
}
static void devices(void)
{
    HDEVINFO set=SetupDiGetClassDevsA(0,0,0,DIGCF_ALLCLASSES|DIGCF_PRESENT);
    if(set==INVALID_HANDLE_VALUE) { put("ENUM_ERROR ");number(GetLastError());line();return; }
    SP_DEVINFO_DATA dev; dev.cbSize=sizeof(dev);
    DWORD count=0,properties=0;
    for(DWORD i=0;SetupDiEnumDeviceInfo(set,i,&dev);i++)
    {
        count++;
        char service[64]={0},description[160]={0},driver[80]={0}; DWORD type;
        if(!SetupDiGetDeviceRegistryPropertyA(set,&dev,SPDRP_HARDWAREID,&type,(BYTE*)hardware,sizeof(hardware),0))
        {
#ifdef NV_WIN98
            put("PROPERTY_ERROR ");number(GetLastError());line();
#endif
            continue;
        }
        properties++;
        if(match(hardware,"PCI\\")) { put("PCI ");put(hardware);line(); }
        if(!match(hardware,"PCI\\VEN_10DE&DEV_0045")) continue;
        ULONG status=0,problem=0; CONFIGRET rc=node_status?node_status(&status,&problem,dev.DevInst,0):CR_CALL_NOT_IMPLEMENTED;
        SetupDiGetDeviceRegistryPropertyA(set,&dev,SPDRP_SERVICE,&type,(BYTE*)service,sizeof(service),0);
        SetupDiGetDeviceRegistryPropertyA(set,&dev,SPDRP_DEVICEDESC,&type,(BYTE*)description,sizeof(description),0);
        SetupDiGetDeviceRegistryPropertyA(set,&dev,SPDRP_DRIVER,&type,(BYTE*)driver,sizeof(driver),0);
        put("DEVICE "); put(hardware); put(" problem="); number(problem); put(" cm="); number(rc);
        put(" started="); number(!!(status&DN_STARTED)); put(" service="); put(service);
        put(" driver=");put(driver);put(" description=");put(description);line();
    }
    put("ENUM_END error=");number(GetLastError());put(" count=");number(count);put(" properties=");number(properties);line();
    SetupDiDestroyDeviceInfoList(set);
}
void WINAPI entry(void)
{
    SetErrorMode(SEM_FAILCRITICALERRORS|SEM_NOGPFAULTERRORBOX);
    HMODULE cfg=LoadLibraryA("cfgmgr32.dll");
    node_status=cfg?(status_t)GetProcAddress(cfg,"CM_Get_DevNode_Status"):0;
    GetModuleFileNameA(0,output,sizeof(output));
    unsigned int end=lstrlenA(output); while(end && output[end-1]!='\\') end--;
    output[end]=0; lstrcpyA(inf,output);
#ifdef NV_WIN98
    lstrcatA(inf,"DRIVER\\NVAGP.INF");
#else
    lstrcatA(inf,"DRIVER\\nv4_disp.inf");
#endif
    lstrcatA(output,"NV.TXT"); DeleteFileA(output);
    put("BEGIN"); line(); devices();
    HMODULE dll=LoadLibraryA("newdev.dll");
    typedef BOOL (WINAPI *update_t)(HWND,LPCSTR,LPCSTR,DWORD,PBOOL);
    update_t update=dll?(update_t)GetProcAddress(dll,"UpdateDriverForPlugAndPlayDevicesA"):0;
    if(update)
    {
        BOOL reboot=FALSE;
        put("INSTALL ");put(inf);line();
        BOOL ok=update(0,"PCI\\VEN_10DE&DEV_0045",inf,1,&reboot); DWORD error=ok?0:GetLastError();
        put("INSTALL_RESULT ok=");number(ok);put(" error=");number(error);put(" reboot=");number(reboot);line();
    }
    else
    {
        /* Win9x's installer path: enumerate a single INF and let SetupAPI install
         * its selected compatible driver, without an interactive selection UI. */
        HDEVINFO set=SetupDiGetClassDevsA(0,0,0,DIGCF_ALLCLASSES|DIGCF_PRESENT);
        SP_DEVINFO_DATA dev;dev.cbSize=sizeof(dev);
        for(DWORD i=0;SetupDiEnumDeviceInfo(set,i,&dev);i++)
        {
            if(!SetupDiGetDeviceRegistryPropertyA(set,&dev,SPDRP_HARDWAREID,0,(BYTE*)hardware,sizeof(hardware),0) || !match(hardware,"PCI\\VEN_10DE&DEV_0045")) continue;
            SP_DEVINSTALL_PARAMS_A params;params.cbSize=sizeof(params);
            BOOL ok=SetupDiGetDeviceInstallParamsA(set,&dev,&params);
            if(!ok) { put("INSTALL_PARAMS error=");number(GetLastError());line();continue; }
            params.Flags|=DI_ENUMSINGLEINF|DI_QUIETINSTALL;
            lstrcpyA(params.DriverPath,inf);
            if(ok) ok=SetupDiSetDeviceInstallParamsA(set,&dev,&params);
            if(ok) ok=SetupDiBuildDriverInfoList(set,&dev,SPDIT_COMPATDRIVER);
            if(ok) ok=SetupDiCallClassInstaller(DIF_SELECTBESTCOMPATDRV,set,&dev);
            put("INSTALL_SETUPAPI selected=");number(ok);put(" error=");number(ok?0:GetLastError());line();
            if(ok) ok=SetupDiCallClassInstaller(DIF_INSTALLDEVICE,set,&dev);
            put("INSTALL_RESULT ok=");number(ok);put(" error=");number(ok?0:GetLastError());line();
            SetupDiDestroyDriverInfoList(set,&dev,SPDIT_COMPATDRIVER);
        }
        SetupDiDestroyDeviceInfoList(set);
    }
    devices(); put("SCREEN ");number(GetSystemMetrics(SM_CXSCREEN));put("x");number(GetSystemMetrics(SM_CYSCREEN));line();
    put("END");line();ExitProcess(0);
}
