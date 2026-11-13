/* Native GDI acceptance probe. Draw on the real primary surface, read back
 * through the installed display driver, and restore the covered desktop. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
DWORD nv_gdi_probe(void)
{
    DWORD failures=0;
    HDC screen=GetDC(0),saved=CreateCompatibleDC(screen);
    HBITMAP bitmap=CreateCompatibleBitmap(screen,80,40);
    if(!screen || !saved || !bitmap) return 8;
    HGDIOBJ original=SelectObject(saved,bitmap);
    if(!BitBlt(saved,0,0,80,40,screen,16,16,SRCCOPY)) failures|=8;
    HBRUSH brush=CreateSolidBrush(RGB(0x33,0x66,0x99));
    RECT rect={16,16,96,56};
    if(!FillRect(screen,&rect,brush)) failures|=8;
    GdiFlush();
    if(GetPixel(screen,20,20)!=RGB(0x33,0x66,0x99)) failures|=1;
    if(!PatBlt(screen,16,16,16,16,DSTINVERT)) failures|=8;
    GdiFlush();
    if(GetPixel(screen,20,20)!=RGB(0xCC,0x99,0x66)) failures|=2;
    FillRect(screen,&rect,brush);
    HGDIOBJ font=SelectObject(screen,GetStockObject(DEFAULT_GUI_FONT));
    int background=SetBkMode(screen,TRANSPARENT);
    COLORREF color=SetTextColor(screen,RGB(255,255,255));
    if(!TextOutA(screen,18,18,"NV40",4)) failures|=8;
    GdiFlush();
    unsigned int pixels=0;
    for(int y=18;y<40;y++)for(int x=18;x<75;x++)if(GetPixel(screen,x,y)==RGB(255,255,255))pixels++;
    if(pixels<20) failures|=4;
    SetTextColor(screen,color);SetBkMode(screen,background);SelectObject(screen,font);
    BitBlt(screen,16,16,80,40,saved,0,0,SRCCOPY);GdiFlush();
    DeleteObject(brush);SelectObject(saved,original);DeleteObject(bitmap);DeleteDC(saved);ReleaseDC(0,screen);
    return failures;
}
#ifdef NV_DDRAW_TEST
#define COBJMACROS
#define DIRECTDRAW_VERSION 0x0700
#include <ddraw.h>
static void zero_bytes(void *p,unsigned int count) { BYTE *b=p;while(count--)*b++=0; }
DWORD nv_ddraw_probe(void (*mark)(const char*))
{
    DWORD failures=0;
    HMODULE library=LoadLibraryA("ddraw.dll");
    typedef HRESULT (WINAPI *create_t)(GUID*,void**,const IID*,IUnknown*);
    create_t create=library?(create_t)GetProcAddress(library,"DirectDrawCreateEx"):0;
    IDirectDraw7 *dd=0;IDirectDrawSurface7 *source=0,*target=0;
    mark("DDRAW_CREATE");
    if(!create || create(0,(void**)&dd,&IID_IDirectDraw7,0)!=DD_OK) {failures=1;goto done;}
    mark("DDRAW_COOPERATIVE");
    if(IDirectDraw7_SetCooperativeLevel(dd,0,DDSCL_NORMAL)!=DD_OK) {failures=2;goto done;}
    DDCAPS caps;zero_bytes(&caps,sizeof(caps));caps.dwSize=sizeof(caps);
    mark("DDRAW_CAPS");
    if(IDirectDraw7_GetCaps(dd,&caps,0)!=DD_OK || !(caps.dwCaps&DDCAPS_BLT)) {failures=4;goto done;}
    DDSURFACEDESC2 desc;zero_bytes(&desc,sizeof(desc));desc.dwSize=sizeof(desc);
    desc.dwFlags=DDSD_CAPS|DDSD_WIDTH|DDSD_HEIGHT;desc.dwWidth=32;desc.dwHeight=32;
    desc.ddsCaps.dwCaps=DDSCAPS_OFFSCREENPLAIN|DDSCAPS_VIDEOMEMORY;
    mark("DDRAW_SURFACES");
    if(IDirectDraw7_CreateSurface(dd,&desc,&source,0)!=DD_OK || IDirectDraw7_CreateSurface(dd,&desc,&target,0)!=DD_OK) {failures=8;goto done;}
    DDBLTFX fx;zero_bytes(&fx,sizeof(fx));fx.dwSize=sizeof(fx);fx.dwFillColor=0x00336699;
    mark("DDRAW_BLIT");
    if(IDirectDrawSurface7_Blt(source,0,0,0,DDBLT_COLORFILL|DDBLT_WAIT,&fx)!=DD_OK) {failures=16;goto done;}
    if(IDirectDrawSurface7_Blt(target,0,source,0,DDBLT_WAIT,0)!=DD_OK) {failures=32;goto done;}
    zero_bytes(&desc,sizeof(desc));desc.dwSize=sizeof(desc);
    if(IDirectDrawSurface7_Lock(target,0,&desc,DDLOCK_WAIT|DDLOCK_READONLY,0)!=DD_OK) {failures=64;goto done;}
    if(desc.ddpfPixelFormat.dwRGBBitCount!=32 || (*(DWORD*)desc.lpSurface&0xFFFFFF)!=0x00336699) failures|=128;
    IDirectDrawSurface7_Unlock(target,0);
    fx.dwROP=SRCINVERT;
    if(IDirectDrawSurface7_Blt(target,0,source,0,DDBLT_ROP|DDBLT_WAIT,&fx)!=DD_OK) {failures|=256;goto done;}
    zero_bytes(&desc,sizeof(desc));desc.dwSize=sizeof(desc);
    if(IDirectDrawSurface7_Lock(target,0,&desc,DDLOCK_WAIT|DDLOCK_READONLY,0)!=DD_OK) {failures|=512;goto done;}
    if((*(DWORD*)desc.lpSurface&0xFFFFFF)!=0) failures|=1024;
    IDirectDrawSurface7_Unlock(target,0);
    if(IDirectDrawSurface7_GetBltStatus(target,DDGBS_ISBLTDONE)!=DD_OK) failures|=2048;
 done:
    mark("DDRAW_RELEASE");
    if(target)IDirectDrawSurface7_Release(target);if(source)IDirectDrawSurface7_Release(source);if(dd)IDirectDraw7_Release(dd);
    if(library)FreeLibrary(library);
    return failures;
}
#endif
