/* G0 real Windows probe. No CRT; XP and Win98 binaries use the same Win32 APIs.
 * The host supplies a RAM FAT16 disk. Every output line is flushed immediately.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <setupapi.h>
#include <cfgmgr32.h>
#include <regstr.h>
static char output[MAX_PATH], inf[MAX_PATH], text[1024], hardware[4096];
static unsigned int used;
typedef CONFIGRET (WINAPI *status_t)(PULONG,PULONG,DEVINST,ULONG);
static status_t node_status;
static BOOL rebooted;
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
#ifdef NV_DDRAW_TEST
static void probe_mark(const char *s) { put(s);line(); }
#endif
static int match(const char *s, const char *prefix)
{
    while(*prefix) { char c=*s++; if(c>='a' && c<='z') c-=32; if(c!=*prefix++) return 0; }
    return 1;
}
static BOOL device_hardware(HDEVINFO set,SP_DEVINFO_DATA *dev)
{
    if(SetupDiGetDeviceRegistryPropertyA(set,dev,SPDRP_HARDWAREID,0,(BYTE*)hardware,sizeof(hardware),0)) return TRUE;
    /* A newly enumerated Win9x PCI node can lack HardwareID until its first
     * install. Its instance ID already contains the vendor/device identity. */
    return SetupDiGetDeviceInstanceIdA(set,dev,hardware,sizeof(hardware),0);
}
static UINT CALLBACK install_message(PVOID context,UINT notification,UINT_PTR p1,UINT_PTR p2)
{
    if(notification==SPFILENOTIFY_COPYERROR)
    {
        const FILEPATHS_A *files=(const FILEPATHS_A*)p1;
        put("COPY_ERROR ");put(files->Source);put(" -> ");put(files->Target);
        put(" error=");number(files->Win32Error);line();
        return FILEOP_ABORT;
    }
    if(notification==SPFILENOTIFY_NEEDMEDIA)
    {
        const SOURCE_MEDIA_A *media=(const SOURCE_MEDIA_A*)p1;
        put("NEED_MEDIA path=");put(media->SourcePath);put(" file=");put(media->SourceFile);line();
        char dir[MAX_PATH];lstrcpyA(dir,inf);
        unsigned int end=lstrlenA(dir);while(end && dir[end-1]!='\\') end--;
        if(end) dir[end-1]=0;
        lstrcpyA((char*)p2,dir);
        return FILEOP_NEWPATH;
    }
    return SetupDefaultQueueCallbackA(context,notification,p1,p2);
}
#ifdef NV_WIN98
static BOOL allocate_driver_key(HDEVINFO set,SP_DEVINFO_DATA *dev,const char *class_name)
{
    GUID display;DWORD count=0;
    if(!SetupDiClassGuidsFromNameA(class_name,&display,1,&count)) return FALSE;
    HKEY parent=SetupDiOpenClassRegKey(&display,KEY_ALL_ACCESS);
    put("DISPLAY_CLASS_KEY opened=");number(parent!=INVALID_HANDLE_VALUE);put(" error=");number(parent!=INVALID_HANDLE_VALUE?0:GetLastError());line();
    if(parent==INVALID_HANDLE_VALUE) return FALSE;
    for(DWORD i=0;i<10000;i++)
    {
        char name[5];DWORD n=i;name[4]=0;for(int j=3;j>=0;j--){name[j]='0'+n%10;n/=10;}
        HKEY key;DWORD disposition;
        LONG rc=RegCreateKeyExA(parent,name,0,0,0,KEY_ALL_ACCESS,0,&key,&disposition);
        if(rc!=ERROR_SUCCESS) break;
        RegCloseKey(key);
        if(disposition==REG_CREATED_NEW_KEY)
        {
            char path[64];lstrcpyA(path,class_name);lstrcatA(path,"\\");lstrcatA(path,name);
            BOOL ok=SetupDiSetDeviceRegistryPropertyA(set,dev,SPDRP_DRIVER,(const BYTE*)path,lstrlenA(path)+1);
            put("DISPLAY_DRIVER_LINK set=");number(ok);put(" path=");put(path);put(" error=");number(ok?0:GetLastError());line();
            RegCloseKey(parent);return ok;
        }
    }
    RegCloseKey(parent);return FALSE;
}
static void disable_legacy_vga(void)
{
    HDEVINFO set=SetupDiGetClassDevsA(0,0,0,DIGCF_ALLCLASSES|DIGCF_PRESENT);
    SP_DEVINFO_DATA dev;dev.cbSize=sizeof(dev);
    for(DWORD i=0;SetupDiEnumDeviceInfo(set,i,&dev);i++)
    {
        if(!device_hardware(set,&dev) || !match(hardware,"*PNP0900")) continue;
        SP_PROPCHANGE_PARAMS change;
        change.ClassInstallHeader.cbSize=sizeof(SP_CLASSINSTALL_HEADER);
        change.ClassInstallHeader.InstallFunction=DIF_PROPERTYCHANGE;
        change.StateChange=DICS_DISABLE;change.Scope=DICS_FLAG_GLOBAL;change.HwProfile=0;
        BOOL ok=SetupDiSetClassInstallParamsA(set,&dev,&change.ClassInstallHeader,sizeof(change));
        if(ok) ok=SetupDiCallClassInstaller(DIF_PROPERTYCHANGE,set,&dev);
        put("LEGACY_VGA disabled=");number(ok);put(" error=");number(ok?0:GetLastError());line();
        DWORD flags=0;
        SetupDiGetDeviceRegistryPropertyA(set,&dev,SPDRP_CONFIGFLAGS,0,(BYTE*)&flags,sizeof(flags),0);
        flags|=CONFIGFLAG_DISABLED;
        ok=SetupDiSetDeviceRegistryPropertyA(set,&dev,SPDRP_CONFIGFLAGS,(const BYTE*)&flags,sizeof(flags));
        put("LEGACY_VGA persistent-disable=");number(ok);put(" error=");number(ok?0:GetLastError());line();
        typedef CONFIGRET (WINAPI *disable_t)(DEVINST,ULONG);
        HMODULE cfg=GetModuleHandleA("cfgmgr32.dll");
        disable_t disable=(disable_t)GetProcAddress(cfg,"CM_Disable_DevNode");
        CONFIGRET rc=disable?disable(dev.DevInst,0):CR_CALL_NOT_IMPLEMENTED;
        put("LEGACY_VGA stop cm=");number(rc);line();
        if(rc==CR_NOT_DISABLEABLE)
        {
            ok=SetupDiRemoveDevice(set,&dev);
            put("LEGACY_VGA remove=");number(ok);put(" error=");number(ok?0:GetLastError());line();
        }
    }
    SetupDiDestroyDeviceInfoList(set);
}
static void resources(DEVINST node)
{
    typedef CONFIGRET (WINAPI *first_t)(LOG_CONF*,DEVINST,ULONG);
    typedef CONFIGRET (WINAPI *next_t)(RES_DES*,RES_DES,RESOURCEID,RESOURCEID*,ULONG);
    typedef CONFIGRET (WINAPI *data_t)(RES_DES,void*,ULONG,ULONG);
    typedef CONFIGRET (WINAPI *size_t_)(ULONG*,RES_DES,ULONG);
    typedef CONFIGRET (WINAPI *free_t)(ULONG);
    typedef CONFIGRET (WINAPI *detect_t)(DEVINST,RESOURCEID,const void*,ULONG,BOOL*,ULONG);
    HMODULE cfg=GetModuleHandleA("cfgmgr32.dll");
    first_t first=(first_t)GetProcAddress(cfg,"CM_Get_First_Log_Conf");
    next_t next=(next_t)GetProcAddress(cfg,"CM_Get_Next_Res_Des");
    data_t data=(data_t)GetProcAddress(cfg,"CM_Get_Res_Des_Data");
    size_t_ size=(size_t_)GetProcAddress(cfg,"CM_Get_Res_Des_Data_Size");
    free_t free_res=(free_t)GetProcAddress(cfg,"CM_Free_Res_Des_Handle"),free_log=(free_t)GetProcAddress(cfg,"CM_Free_Log_Conf_Handle");
    detect_t detect=(detect_t)GetProcAddress(cfg,"CM_Detect_Resource_Conflict");
    if(!first || !next || !data || !size || !free_res || !free_log) return;
    for(ULONG kind=0;kind<=4;kind++)
    {
        if(kind==1) continue;
        LOG_CONF log;CONFIGRET rc=first(&log,node,kind);
        put("RESOURCES kind=");number(kind);put(" cm=");number(rc);line();
        if(rc!=CR_SUCCESS) continue;
        RES_DES cursor=log,resource;RESOURCEID type;
        for(int i=0;i<32 && next(&resource,cursor,ResType_All,&type,0)==CR_SUCCESS;i++)
        {
            if(cursor!=log) free_res(cursor);cursor=resource;
            ULONG length=0;BYTE bytes[256];rc=size(&length,resource,0);
            put("RESOURCE type=");number(type);put(" bytes=");number(length);put(" words=");
            if(rc==CR_SUCCESS && length<=sizeof(bytes) && data(resource,bytes,length,0)==CR_SUCCESS)
            {
                for(ULONG at=0;at+4<=length;at+=4){number(*(DWORD*)(bytes+at));put(",");}
                if(detect && kind==BASIC_LOG_CONF && (type==ResType_Mem || type==ResType_IO || type==ResType_IRQ))
                {
                    BOOL conflict=FALSE;*(DWORD*)bytes=0;
                    CONFIGRET check=detect(node,type,bytes,type==ResType_Mem?32:type==ResType_IO?28:20,&conflict,0);
                    put(" conflict=");number(conflict);put(" check-cm=");number(check);
                }
            }
            line();
        }
        if(cursor!=log) free_res(cursor);free_log(log);
    }
}
static BOOL install_driver_files(void)
{
    UINT line_number=0;
    HINF file=SetupOpenInfFileA(inf,0,INF_STYLE_WIN4,&line_number);
    BOOL ok=file!=INVALID_HANDLE_VALUE;
    put("INF_OPEN ok=");number(ok);put(" error=");number(ok?0:GetLastError());put(" line=");number(line_number);line();
    if(!ok) return FALSE;
    BOOL layout=SetupOpenAppendInfFileA(0,file,&line_number);
    put("INF_LAYOUT ok=");number(layout);put(" error=");number(layout?0:GetLastError());line();
    char source[MAX_PATH];lstrcpyA(source,inf);
    unsigned int end=lstrlenA(source);while(end && source[end-1]!='\\') end--;
    if(end) source[end-1]=0;
    HSPFILEQ queue=SetupOpenFileQueue();
    ok=SetupInstallFilesFromInfSectionA(file,0,queue,"NV30",source,SP_COPY_NEWER);
    put("INF_FILES queued=");number(ok);put(" error=");number(ok?0:GetLastError());line();
    PVOID context=SetupInitDefaultQueueCallback(0);
    if(ok) ok=SetupCommitFileQueueA(0,queue,install_message,context);
    put("INF_FILES copied=");number(ok);put(" error=");number(ok?0:GetLastError());line();
    SetupTermDefaultQueueCallback(context);SetupCloseFileQueue(queue);SetupCloseInfFile(file);
    return ok;
}
static BOOL step(const char *name, BOOL ok)
{
    DWORD error=ok?0:GetLastError();
    put("PCI_BUS ");put(name);put(" ok=");number(ok);put(" error=");number(error);line();
    return ok;
}
static void install_pci_bus(void)
{
    char source[MAX_PATH],dest[MAX_PATH];
    for(int i=0;i<2;i++)
    {
        GetModuleFileNameA(0,source,sizeof(source));
        unsigned int end=lstrlenA(source);while(end && source[end-1]!='\\') end--;
        lstrcpyA(source+end,i?"PCIBUS\\pcimp.pci":"PCIBUS\\pci.vxd");
        GetSystemDirectoryA(dest,sizeof(dest));lstrcatA(dest,i?"\\pcimp.pci":"\\pci.vxd");
        if(!step("copy-file",CopyFileA(source,dest,FALSE))) return;
    }
    HDEVINFO set=SetupDiCreateDeviceInfoList(0,0);
    if(!step("list",set!=INVALID_HANDLE_VALUE)) return;
    SP_DEVINFO_DATA dev;dev.cbSize=sizeof(dev);
    /* Win9x cannot promote SetupAPI's phantom root node: it has no parent.
     * Create a live CM node under the real root before selecting the driver. */
    typedef CONFIGRET (WINAPI *locate_t)(DEVINST*,DEVINSTID_A,ULONG);
    typedef CONFIGRET (WINAPI *create_t)(DEVINST*,DEVINSTID_A,DEVINST,ULONG);
    HMODULE cfg=LoadLibraryA("cfgmgr32.dll");
    locate_t locate=cfg?(locate_t)GetProcAddress(cfg,"CM_Locate_DevNodeA"):0;
    create_t create=cfg?(create_t)GetProcAddress(cfg,"CM_Create_DevNodeA"):0;
    DEVINST root=0,node=0;char instance[]="ROOT\\*PNP0A03\\0000";
    CONFIGRET rc=locate?locate(&root,0,0):CR_CALL_NOT_IMPLEMENTED;
    put("PCI_BUS locate-root cm=");number(rc);line();
    if(rc==CR_SUCCESS) rc=create?create(&node,instance,root,CM_CREATE_DEVNODE_NORMAL):CR_CALL_NOT_IMPLEMENTED;
    put("PCI_BUS create-node cm=");number(rc);line();
    BOOL ok=rc==CR_SUCCESS && step("open",SetupDiOpenDeviceInfoA(set,instance,0,0,&dev));
    static const char id[]="*PNP0A03\0";
    if(ok) ok=step("hardware-id",SetupDiSetDeviceRegistryPropertyA(set,&dev,SPDRP_HARDWAREID,(const BYTE*)id,sizeof(id)));
    SP_DEVINSTALL_PARAMS_A params;params.cbSize=sizeof(params);
    if(ok) ok=step("get-params",SetupDiGetDeviceInstallParamsA(set,&dev,&params));
    if(ok)
    {
        GetWindowsDirectoryA(params.DriverPath,MAX_PATH);lstrcatA(params.DriverPath,"\\INF\\MACHINE.INF");
        params.Flags|=DI_ENUMSINGLEINF|DI_QUIETINSTALL|DI_NOFILECOPY;
        ok=step("set-params",SetupDiSetDeviceInstallParamsA(set,&dev,&params));
    }
    if(ok) ok=step("build-drivers",SetupDiBuildDriverInfoList(set,&dev,SPDIT_COMPATDRIVER));
    if(ok) ok=step("select-driver",SetupDiCallClassInstaller(DIF_SELECTBESTCOMPATDRV,set,&dev));
    if(ok) ok=step("install",SetupDiCallClassInstaller(DIF_INSTALLDEVICE,set,&dev));
    if(ok) { put("PCI_BUS_INSTALLED");line(); }
    SetupDiDestroyDeviceInfoList(set);
}
static void install_system_pci(void)
{
    HDEVINFO set=SetupDiGetClassDevsA(0,0,0,DIGCF_ALLCLASSES|DIGCF_PRESENT);
    SP_DEVINFO_DATA dev;dev.cbSize=sizeof(dev);
    for(DWORD i=0;SetupDiEnumDeviceInfo(set,i,&dev);i++)
    {
        if(!device_hardware(set,&dev)) continue;
        const char *id=match(hardware,"PCI\\VEN_8086&DEV_1237")?"PCI\\VEN_8086&DEV_1237":
            match(hardware,"PCI\\VEN_8086&DEV_7000")?"PCI\\VEN_8086&DEV_7000":
            match(hardware,"PCI\\IRQHOLDER")?"PCI\\IRQHolder":0;
        if(!id) continue;
        char driver[80]={0};
        if(SetupDiGetDeviceRegistryPropertyA(set,&dev,SPDRP_DRIVER,0,(BYTE*)driver,sizeof(driver),0) && driver[0]) continue;
        char ids[64];lstrcpyA(ids,id);ids[lstrlenA(id)+1]=0;
        BOOL ok=SetupDiSetDeviceRegistryPropertyA(set,&dev,SPDRP_HARDWAREID,(const BYTE*)ids,lstrlenA(id)+2);
        SP_DEVINSTALL_PARAMS_A params;params.cbSize=sizeof(params);
        if(ok) ok=SetupDiGetDeviceInstallParamsA(set,&dev,&params);
        if(ok)
        {
            GetWindowsDirectoryA(params.DriverPath,sizeof(params.DriverPath));
            lstrcatA(params.DriverPath,match(id,"PCI\\IRQHOLDER")?"\\INF\\MACHINE.INF":"\\INF\\MACHINE2.INF");
            params.Flags|=DI_ENUMSINGLEINF|DI_QUIETINSTALL|DI_NOFILECOPY;
            ok=SetupDiSetDeviceInstallParamsA(set,&dev,&params);
        }
        if(ok) ok=SetupDiBuildDriverInfoList(set,&dev,SPDIT_COMPATDRIVER);
        if(ok) ok=SetupDiCallClassInstaller(DIF_SELECTBESTCOMPATDRV,set,&dev);
        if(ok) ok=allocate_driver_key(set,&dev,"System");
        if(ok) ok=SetupDiCallClassInstaller(DIF_INSTALLDEVICE,set,&dev);
        put("SYSTEM_PCI ");put(id);put(" installed=");number(ok);put(" error=");number(ok?0:GetLastError());line();
    }
    SetupDiDestroyDeviceInfoList(set);
}
#endif
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
        if(!device_hardware(set,&dev))
        {
#ifdef NV_WIN98
            put("PROPERTY_ERROR ");number(GetLastError());line();
#endif
            continue;
        }
        properties++;
#ifdef NV_WIN98
        put("HARDWARE ");put(hardware);line();
#endif
        if(match(hardware,"PCI\\")) { put("PCI ");put(hardware);line(); }
        if(!match(hardware,"PCI\\VEN_10DE&DEV_0045"))
        {
#ifdef NV_WIN98
            {
                ULONG status=0,problem=0;if(node_status) node_status(&status,&problem,dev.DevInst,0);
                put("RESOURCE_OWNER ");put(hardware);put(" problem=");number(problem);put(" started=");number(!!(status&DN_STARTED));line();
                resources(dev.DevInst);
            }
#endif
            continue;
        }
        ULONG status=0,problem=0; CONFIGRET rc=node_status?node_status(&status,&problem,dev.DevInst,0):CR_CALL_NOT_IMPLEMENTED;
        SetupDiGetDeviceRegistryPropertyA(set,&dev,SPDRP_SERVICE,&type,(BYTE*)service,sizeof(service),0);
        SetupDiGetDeviceRegistryPropertyA(set,&dev,SPDRP_DEVICEDESC,&type,(BYTE*)description,sizeof(description),0);
        SetupDiGetDeviceRegistryPropertyA(set,&dev,SPDRP_DRIVER,&type,(BYTE*)driver,sizeof(driver),0);
        put("DEVICE "); put(hardware); put(" problem="); number(problem); put(" cm="); number(rc);
        put(" started="); number(!!(status&DN_STARTED)); put(" service="); put(service);
        put(" driver=");put(driver);put(" description=");put(description);line();
#ifdef NV_WIN98
        resources(dev.DevInst);
#endif
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
#ifdef NV_REBOOT
    char bootmark[MAX_PATH];lstrcpyA(bootmark,output);lstrcpyA(bootmark+end,"NVBOOT.FLG");
    rebooted=GetFileAttributesA(bootmark)!=INVALID_FILE_ATTRIBUTES;
#endif
#ifndef NV_WIN98
    /* Preserve the bugcheck screen when an incomplete device model fails. This
     * affects only the disposable guest overlay, never the original image. */
    HKEY crash;
    if(RegOpenKeyExA(HKEY_LOCAL_MACHINE,"SYSTEM\\CurrentControlSet\\Control\\CrashControl",0,KEY_SET_VALUE,&crash)==ERROR_SUCCESS)
    {
        DWORD zero=0;
        RegSetValueExA(crash,"AutoReboot",0,REG_DWORD,(const BYTE*)&zero,sizeof(zero));
        RegCloseKey(crash);
    }
#endif
    put("BEGIN"); line();
#ifdef NV_PROBE_ID
    put("PROBE_ID ");number(NV_PROBE_ID);line();
#endif
    devices();
#ifdef NV_WIN98
    HKEY pci;
    LONG registry_result=RegOpenKeyExA(HKEY_LOCAL_MACHINE,"Enum\\PCI",0,KEY_READ,&pci);
    put("PCI_REGISTRY status=");number(registry_result);line();
    if(registry_result==ERROR_SUCCESS)
    {
        char name[256];
        for(DWORD i=0;RegEnumKeyA(pci,i,name,sizeof(name))==ERROR_SUCCESS;i++) { put("PCI_REGISTRY ");put(name);line(); }
        RegCloseKey(pci);
    }
    else if(registry_result==ERROR_FILE_NOT_FOUND)
    {
        char source[MAX_PATH],dest[MAX_PATH];
        GetWindowsDirectoryA(source,sizeof(source));lstrcatA(source,"\\INF\\MACHINE.INF");
        lstrcpyA(dest,output);lstrcpyA(dest+end,"MACHINE.INF");CopyFileA(source,dest,FALSE);
        put("PCI_BUS_MISSING installing Microsoft PCI bus from MACHINE.INF");line();
        install_pci_bus();devices();
    }
    if(!rebooted) install_system_pci();
#endif
#ifndef NV_SKIP_INSTALL
    if(!rebooted)
    {
#ifdef NV_WIN98
    disable_legacy_vga();
#endif
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
            if(!device_hardware(set,&dev) || !match(hardware,"PCI\\VEN_10DE&DEV_0045")) continue;
            if(!SetupDiGetDeviceRegistryPropertyA(set,&dev,SPDRP_HARDWAREID,0,(BYTE*)hardware,sizeof(hardware),0))
            {
                static const char gpu_id[]="PCI\\VEN_10DE&DEV_0045\0";
                BOOL set_id=SetupDiSetDeviceRegistryPropertyA(set,&dev,SPDRP_HARDWAREID,(const BYTE*)gpu_id,sizeof(gpu_id));
                put("INSTALL_HARDWARE_ID ok=");number(set_id);put(" error=");number(set_id?0:GetLastError());line();
                if(!set_id) continue;
            }
            SP_DEVINSTALL_PARAMS_A params;params.cbSize=sizeof(params);
            BOOL ok=SetupDiGetDeviceInstallParamsA(set,&dev,&params);
            if(!ok) { put("INSTALL_PARAMS error=");number(GetLastError());line();continue; }
            params.Flags|=DI_ENUMSINGLEINF|DI_QUIETINSTALL;
            params.InstallMsgHandler=install_message;
            params.InstallMsgHandlerContext=SetupInitDefaultQueueCallback(0);
            lstrcpyA(params.DriverPath,inf);
            if(ok) ok=SetupDiSetDeviceInstallParamsA(set,&dev,&params);
            if(ok) ok=SetupDiBuildDriverInfoList(set,&dev,SPDIT_COMPATDRIVER);
            if(ok) ok=SetupDiCallClassInstaller(DIF_SELECTBESTCOMPATDRV,set,&dev);
            DWORD error=ok?0:GetLastError();
            put("INSTALL_SETUPAPI selected=");number(ok);put(" error=");number(error);line();
#ifdef NV_WIN98
            if(ok)
            {
                ok=install_driver_files();error=ok?0:GetLastError();
                if(ok)
                {
                    SetupDiGetDeviceInstallParamsA(set,&dev,&params);params.Flags|=DI_NOFILECOPY;
                    ok=SetupDiSetDeviceInstallParamsA(set,&dev,&params);error=ok?0:GetLastError();
                }
            }
#endif
            if(ok)
            {
                HKEY key=SetupDiCreateDevRegKeyA(set,&dev,DICS_FLAG_GLOBAL,0,DIREG_DEV,0,0);
                put("DEVICE_KEY created=");number(key!=INVALID_HANDLE_VALUE);put(" error=");number(key!=INVALID_HANDLE_VALUE?0:GetLastError());line();
                if(key!=INVALID_HANDLE_VALUE) RegCloseKey(key);
                key=SetupDiCreateDevRegKeyA(set,&dev,DICS_FLAG_GLOBAL,0,DIREG_DRV,0,0);
                DWORD driver_key_error=key!=INVALID_HANDLE_VALUE?0:GetLastError();
                put("DRIVER_KEY created=");number(key!=INVALID_HANDLE_VALUE);put(" error=");number(driver_key_error);line();
                if(key!=INVALID_HANDLE_VALUE) RegCloseKey(key);
#ifdef NV_WIN98
                if(key==INVALID_HANDLE_VALUE && driver_key_error==ERROR_FILE_NOT_FOUND) allocate_driver_key(set,&dev,"Display");
#endif
                ok=SetupDiCallClassInstaller(DIF_INSTALLDEVICE,set,&dev);error=ok?0:GetLastError();
                if(!ok && error==ERROR_FILE_NOT_FOUND)
                {
                    put("INSTALL_CLASS_ERROR error=");number(error);line();
                    ok=SetupDiInstallDevice(set,&dev);error=ok?0:GetLastError();
                }
            }
            put("INSTALL_RESULT ok=");number(ok);put(" error=");number(error);line();
            SetupDiDestroyDriverInfoList(set,&dev,SPDIT_COMPATDRIVER);
            SetupTermDefaultQueueCallback(params.InstallMsgHandlerContext);
        }
        SetupDiDestroyDeviceInfoList(set);
    }
    }
#endif
#ifdef NV_MODE_TEST
    DEVMODEA mode;DWORD modes=0,preferred=0;
    for(DWORD i=0;i<8192;i++)
    {
        mode.dmSize=sizeof(mode);mode.dmDriverExtra=0;
        if(!EnumDisplaySettingsA(0,i,&mode)) break;
        modes++;
        if(mode.dmPelsWidth==1024 && mode.dmPelsHeight==768 && mode.dmBitsPerPel==32) preferred++;
    }
    put("MODES count=");number(modes);put(" 1024x768x32=");number(preferred);line();
    {
        mode.dmSize=sizeof(mode);mode.dmDriverExtra=0;
        mode.dmFields=DM_PELSWIDTH|DM_PELSHEIGHT|DM_BITSPERPEL;
        mode.dmPelsWidth=1024;mode.dmPelsHeight=768;mode.dmBitsPerPel=32;
        LONG rc=ChangeDisplaySettingsA(&mode,CDS_TEST);
        put("MODE_TEST result=");number(rc);line();
        if(rc==DISP_CHANGE_SUCCESSFUL)
        {
            rc=ChangeDisplaySettingsA(&mode,CDS_UPDATEREGISTRY|CDS_RESET);
            put("MODE_SET result=");number(rc);line();
        }
    }
#endif
    #ifdef NV_GDI_TEST
    extern DWORD nv_gdi_probe(void);
    put("GDI_TEST failures=");number(nv_gdi_probe());line();
    #endif
#ifdef NV_DDRAW_TEST
    extern DWORD nv_ddraw_probe(void (*mark)(const char*));
    put("DDRAW_BEGIN");line();
    put("DDRAW_TEST failures=");number(nv_ddraw_probe(probe_mark));line();
#endif
    devices(); put("SCREEN ");number(GetSystemMetrics(SM_CXSCREEN));put("x");number(GetSystemMetrics(SM_CYSCREEN));line();
    put("REGISTRY_FLUSH status=");number(RegFlushKey(HKEY_LOCAL_MACHINE));line();
#ifdef NV_REBOOT
    if(!rebooted)
    {
        HANDLE marker=CreateFileA(bootmark,GENERIC_WRITE,0,0,CREATE_ALWAYS,0,0);
        if(marker!=INVALID_HANDLE_VALUE){FlushFileBuffers(marker);CloseHandle(marker);}
        put("REBOOT_REQUEST");line();
        ExitWindowsEx(EWX_REBOOT|EWX_FORCE,0);ExitProcess(0);
    }
#endif
    put("END");line();ExitProcess(0);
}
