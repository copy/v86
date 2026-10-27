/* What WIN_USB checks (tests/x64/windows_boot.mjs, tests/devices/
 * usb_windows_xp.mjs, docs/usb.md), 32-bit (XP, and WOW64 on 64-bit
 * Windows), no CRT. USB.TXT beside the program gets the present devices of
 * the UHCI controller (PIIX3's 8086:7020, ICH9's 8086:2934) or the EHCI
 * (ICH9's 8086:293A) and its companions (2934 to 2936) or the xHCI (QEMU's
 * 1B36:000D), the root hubs, and
 * the tablet (0627:0001: the USB device and its HID mouse), "DEVICE id |
 * name | error=n | service=s | started" (n is the device's Device Manager
 * problem code, 0 when it has none), then "SCREEN w h", "READY", the
 * cursor's position every 300 ms ("POS x y ms", ms the guest's tick count)
 * until the cursor stays at (3, 5) (where the harness puts it when it is
 * done) or for 15 minutes, and "END". Each line is appended and flushed to
 * the disk, so that the tools disk has it at once (Windows' cache held it
 * for minutes; PowerShell's WMI took minutes too). With a USB disk (U2):
 * its devices (USB\VID_46F4&PID_0001, USBSTOR\...) too, and the file
 * USBDISK.TXT read from the removable drive, FROMWIN.TXT written to it.
 * With WIN_TPM (docs/tpm.md): the TPM's device (ACPI\MSFT0101) too, and
 * commands through Windows' TPM Base Services (tbs.dll, Windows 8 and later):
 * "TPM version=v interface=i", "TPM GetRandom rc=r bytes=n", "TPM
 * manufacturer m" (or "TPM none rc=r" without a TPM). */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <setupapi.h>
#include <cfgmgr32.h>
static char path[MAX_PATH];
static char line[600];
static int at;
static void put(const char *s) { while(*s && at < (int)sizeof(line) - 3) line[at++] = *s++; }
static void put_number(long n)
{
    char b[12];
    int i = 11;
    b[i] = 0;
    if(n < 0) { put("-"); n = -n; }
    do { b[--i] = '0' + n % 10; n /= 10; } while(n);
    put(b + i);
}
static void flush(void)
{
    line[at++] = '\r';
    line[at++] = '\n';
    HANDLE file = CreateFileA(path, GENERIC_WRITE, FILE_SHARE_READ, 0, OPEN_ALWAYS, 0, 0);
    if(file != INVALID_HANDLE_VALUE)
    {
        DWORD wrote;
        SetFilePointer(file, 0, 0, FILE_END);
        WriteFile(file, line, at, &wrote, 0);
        FlushFileBuffers(file);
        CloseHandle(file);
    }
    at = 0;
}
static int starts(const char *s, const char *prefix)
{
    for(; *prefix; s++, prefix++)
    {
        char c = *s >= 'a' && *s <= 'z' ? *s - 32 : *s;
        if(c != *prefix) return 0;
    }
    return 1;
}
static void devices(void)
{
    static const char *const wanted[] = {"PCI\\VEN_8086&DEV_7020", "PCI\\VEN_8086&DEV_2934", "PCI\\VEN_8086&DEV_2935", "PCI\\VEN_8086&DEV_2936",
        "PCI\\VEN_8086&DEV_293A", "PCI\\VEN_1B36&DEV_000D", "USB\\ROOT_HUB", "USB\\VID_0627&PID_0001", "HID\\VID_0627&PID_0001", "USB\\VID_46F4&PID_0001", "USBSTOR\\",
        "ACPI\\MSFT0101"};
    HDEVINFO set = SetupDiGetClassDevsA(0, 0, 0, DIGCF_ALLCLASSES | DIGCF_PRESENT);
    if(set == INVALID_HANDLE_VALUE) { put("DEVICES error"); flush(); return; }
    SP_DEVINFO_DATA device;
    device.cbSize = sizeof(device);
    for(DWORD i = 0; SetupDiEnumDeviceInfo(set, i, &device); i++)
    {
        char id[200], name[200] = "", service[64] = "";
        if(!SetupDiGetDeviceInstanceIdA(set, &device, id, sizeof(id), 0)) continue;
        int match = 0;
        for(int j = 0; j < (int)(sizeof(wanted) / sizeof(wanted[0])); j++) match |= starts(id, wanted[j]);
        if(!match) continue;
        if(!SetupDiGetDeviceRegistryPropertyA(set, &device, SPDRP_FRIENDLYNAME, 0, (BYTE *)name, sizeof(name), 0))
            SetupDiGetDeviceRegistryPropertyA(set, &device, SPDRP_DEVICEDESC, 0, (BYTE *)name, sizeof(name), 0);
        SetupDiGetDeviceRegistryPropertyA(set, &device, SPDRP_SERVICE, 0, (BYTE *)service, sizeof(service), 0);
        ULONG status = 0, problem = 0;
        CONFIGRET result = CM_Get_DevNode_Status(&status, &problem, device.DevInst, 0);
        put("DEVICE ");
        put(id);
        put(" | ");
        put(name);
        put(" | error=");
        put_number(result != CR_SUCCESS ? -1 : status & DN_HAS_PROBLEM ? (long)problem : 0);
        put(" | service=");
        put(service);
        put(status & DN_STARTED ? " | started" : " | not started");
        flush();
    }
    SetupDiDestroyDeviceInfoList(set);
}
static void put_hex(unsigned long n)
{
    char b[9];
    for(int i = 7; i >= 0; i--, n >>= 4) b[i] = "0123456789abcdef"[n & 15];
    b[8] = 0;
    put(b);
}
static unsigned long be32(const BYTE *b) { return (unsigned long)b[0] << 24 | b[1] << 16 | b[2] << 8 | b[3]; }
/* The TPM through TBS: its device information, then GetRandom and the
 * manufacturer property (GetCapability) as raw TPM 2.0 commands */
static void tpm(void)
{
    HMODULE tbs = LoadLibraryA("tbs.dll");
    if(!tbs) return;
    typedef UINT32 (WINAPI *create_t)(const void *, void **);
    typedef UINT32 (WINAPI *submit_t)(void *, UINT32, UINT32, const BYTE *, UINT32, BYTE *, UINT32 *);
    typedef UINT32 (WINAPI *close_t)(void *);
    typedef UINT32 (WINAPI *info_t)(UINT32, void *);
    create_t create = (create_t)GetProcAddress(tbs, "Tbsi_Context_Create");
    submit_t submit = (submit_t)GetProcAddress(tbs, "Tbsip_Submit_Command");
    close_t close = (close_t)GetProcAddress(tbs, "Tbsip_Context_Close");
    info_t info = (info_t)GetProcAddress(tbs, "Tbsi_GetDeviceInfo");
    if(!create || !submit || !close) return;
    /* TBS_CONTEXT_PARAMS2: version 2, includeTpm20 */
    UINT32 params[2] = {2, 4};
    void *context = 0;
    UINT32 rc = create(params, &context);
    if(rc) { put("TPM none rc=0x"); put_hex(rc); flush(); return; }
    if(info)
    {
        /* TBS_DEVICE_INFO: structVersion, tpmVersion, tpmInterfaceType, tpmImpRevision */
        UINT32 device[4] = {0};
        rc = info(sizeof(device), device);
        put("TPM version=");
        put_number(rc ? -1 : (long)device[1]);
        put(" interface=");
        put_number(rc ? -1 : (long)device[2]);
        flush();
    }
    static const BYTE get_random[] = {0x80, 0x01, 0, 0, 0, 12, 0, 0, 0x01, 0x7B, 0, 16};
    BYTE response[256];
    UINT32 length = sizeof(response);
    rc = submit(context, 0, 200, get_random, sizeof(get_random), response, &length);
    put("TPM GetRandom rc=0x");
    put_hex(rc ? rc : length >= 10 ? be32(response + 6) : 0xFFFFFFFF);
    put(" bytes=");
    put_number(!rc && length >= 12 ? (long)(response[10] << 8 | response[11]) : -1);
    flush();
    /* GetCapability(TPM_CAP_TPM_PROPERTIES, TPM_PT_MANUFACTURER, 1) */
    static const BYTE get_manufacturer[] = {0x80, 0x01, 0, 0, 0, 22, 0, 0, 0x01, 0x7A, 0, 0, 0, 6, 0, 0, 0x01, 0x05, 0, 0, 0, 1};
    length = sizeof(response);
    rc = submit(context, 0, 200, get_manufacturer, sizeof(get_manufacturer), response, &length);
    put("TPM manufacturer ");
    if(!rc && length >= 27 && !be32(response + 6))
    {
        /* tag, size, rc, moreData, capability, count, property, value */
        char name[5] = {0};
        for(int i = 0; i < 4; i++) name[i] = response[23 + i] >= 0x20 && response[23 + i] < 0x7F ? response[23 + i] : '.';
        put(name);
    }
    else { put("rc=0x"); put_hex(rc ? rc : length >= 10 ? be32(response + 6) : 0xFFFFFFFF); }
    flush();
    close(context);
}
/* A USB disk (WIN_USB_DISK): the removable drive with USBDISK.TXT on it,
 * "DISK X: <its first line>", then FROMWIN.TXT written there and flushed,
 * "DISK WRITTEN" */
static void usb_disk(void)
{
    char root[] = "C:\\", file[] = "C:\\USBDISK.TXT";
    for(char letter = 'C'; letter <= 'Z'; letter++)
    {
        root[0] = file[0] = letter;
        if(GetDriveTypeA(root) != DRIVE_REMOVABLE) continue;
        HANDLE in = CreateFileA(file, GENERIC_READ, FILE_SHARE_READ, 0, OPEN_EXISTING, 0, 0);
        if(in == INVALID_HANDLE_VALUE) continue;
        char text[80];
        DWORD length = 0;
        ReadFile(in, text, sizeof(text) - 1, &length, 0);
        CloseHandle(in);
        while(length && (text[length - 1] == '\r' || text[length - 1] == '\n')) length--;
        text[length] = 0;
        put("DISK ");
        put(root);
        put(" ");
        put(text);
        flush();
        char out_name[] = "C:\\FROMWIN.TXT";
        out_name[0] = letter;
        HANDLE out = CreateFileA(out_name, GENERIC_WRITE, 0, 0, CREATE_ALWAYS, 0, 0);
        if(out == INVALID_HANDLE_VALUE) { put("DISK WRITE error"); flush(); return; }
        static const char message[] = "written by Windows through the USB disk\r\n";
        DWORD wrote;
        BOOL ok = WriteFile(out, message, sizeof(message) - 1, &wrote, 0) && FlushFileBuffers(out);
        CloseHandle(out);
        put(ok ? "DISK WRITTEN" : "DISK WRITE error");
        flush();
        return;
    }
}
void WINAPI entry(void)
{
    DWORD n = GetModuleFileNameA(0, path, MAX_PATH - 16);
    while(n && path[n - 1] != '\\') n--;
    const char *name = "USB.TXT";
    for(int i = 0; name[i]; i++) path[n++] = name[i];
    path[n] = 0;
    devices();
    tpm();
    usb_disk();
    put("SCREEN ");
    put_number(GetSystemMetrics(SM_CXSCREEN));
    put(" ");
    put_number(GetSystemMetrics(SM_CYSCREEN));
    flush();
    put("READY");
    flush();
    for(int i = 0, sentinel = 0; i < 3000 && sentinel < 2; i++)
    {
        POINT p;
        if(GetCursorPos(&p))
        {
            sentinel = p.x == 3 && p.y == 5 ? sentinel + 1 : 0;
            put("POS ");
            put_number(p.x);
            put(" ");
            put_number(p.y);
            put(" ");
            put_number(GetTickCount());
            flush();
        }
        Sleep(300);
    }
    put("END");
    flush();
    ExitProcess(0);
}
