/* Native GDI acceptance probe. Draw on the real primary surface, read back
 * through the installed display driver, and restore the covered desktop. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
static void detail(void (*mark)(const char*),const char *label,DWORD value)
{
    char text[96];unsigned int n=0;while(*label && n<80)text[n++]=*label++;
    text[n++]='=';const char hex[]="0123456789abcdef";
    for(int i=7;i>=0;i--)text[n++]=hex[value>>(i*4)&15];text[n]=0;mark(text);
}
#ifdef NV_GDI_FONT_TEST
static unsigned int font_tones(const BYTE *pixels,unsigned int count,DWORD *tones)
{
    unsigned int used=0;
    for(unsigned int i=0;i<count;i++)
    {
        DWORD color=*(const DWORD*)(pixels+i*4)&0xFFFFFF;unsigned int at=0;
        while(at<used && tones[at]<color)at++;
        if(at<used && tones[at]==color)continue;
        if(used==256)return 0;
        for(unsigned int j=used;j>at;j--)tones[j]=tones[j-1];
        tones[at]=color;used++;
    }
    return used;
}
static void font_bitmap(unsigned int index,char kind,const BITMAPINFOHEADER *info,const BYTE *pixels)
{
    char name[MAX_PATH];GetModuleFileNameA(0,name,MAX_PATH);
    char *tail=name+lstrlenA(name);while(tail>name && tail[-1]!='\\')tail--;
    lstrcpyA(tail,"FONTR0.BMP");tail[4]=kind;tail[5]=(char)('0'+index);
    HANDLE file=CreateFileA(name,GENERIC_WRITE,FILE_SHARE_READ,0,CREATE_ALWAYS,0,0);
    if(file==INVALID_HANDLE_VALUE)return;
    BITMAPFILEHEADER header;header.bfType=0x4D42;header.bfReserved1=0;header.bfReserved2=0;
    header.bfOffBits=sizeof(header)+sizeof(*info);header.bfSize=header.bfOffBits+info->biSizeImage;
    DWORD written;WriteFile(file,&header,sizeof(header),&written,0);WriteFile(file,info,sizeof(*info),&written,0);
    WriteFile(file,pixels,info->biSizeImage,&written,0);FlushFileBuffers(file);CloseHandle(file);
}
static DWORD font_probe(HDC screen,void (*mark)(const char*))
{
    const int width=320,height=64,left=16,top=256;DWORD failures=0;
    HDC reference=CreateCompatibleDC(screen),actual=CreateCompatibleDC(screen),saved=CreateCompatibleDC(screen);
    BITMAPINFO info;for(unsigned int i=0;i<sizeof(info);i++)((BYTE*)&info)[i]=0;
    info.bmiHeader.biSize=sizeof(info.bmiHeader);info.bmiHeader.biWidth=width;info.bmiHeader.biHeight=-height;
    info.bmiHeader.biPlanes=1;info.bmiHeader.biBitCount=32;info.bmiHeader.biCompression=BI_RGB;info.bmiHeader.biSizeImage=width*height*4;
    BYTE *expected=0,*observed=0;
    HBITMAP referenceBitmap=CreateDIBSection(screen,&info,DIB_RGB_COLORS,(void**)&expected,0,0);
    HBITMAP actualBitmap=CreateDIBSection(screen,&info,DIB_RGB_COLORS,(void**)&observed,0,0);
    HBITMAP savedBitmap=CreateCompatibleBitmap(screen,width,height);
    if(!reference || !actual || !saved || !referenceBitmap || !actualBitmap || !savedBitmap){failures=128;goto done;}
    HGDIOBJ oldReference=SelectObject(reference,referenceBitmap),oldActual=SelectObject(actual,actualBitmap),oldSaved=SelectObject(saved,savedBitmap);
    if(!BitBlt(saved,0,0,width,height,screen,left,top,SRCCOPY))failures|=128;
    HBRUSH brush=CreateSolidBrush(RGB(0xD4,0xD0,0xC8));
    const int sizes[]={16,32,48,20,36};const char *faces[]={"Arial","Arial","Arial","Tahoma","Times New Roman"};
    for(unsigned int test=0;test<10;test++)
    {
        const unsigned int kind=test%5;
        HFONT font=CreateFontA(sizes[kind],0,0,0,kind?FW_BOLD:FW_NORMAL,kind?TRUE:FALSE,FALSE,FALSE,DEFAULT_CHARSET,
            OUT_DEFAULT_PRECIS,CLIP_DEFAULT_PRECIS,test<5?NONANTIALIASED_QUALITY:ANTIALIASED_QUALITY,DEFAULT_PITCH,faces[kind]);
        if(!font){failures|=128;continue;}
        HGDIOBJ screenFont=SelectObject(screen,font),referenceFont=SelectObject(reference,font);
        const int screenMode=SetBkMode(screen,TRANSPARENT),referenceMode=SetBkMode(reference,TRANSPARENT);
        const COLORREF screenColor=SetTextColor(screen,RGB(0,0,0)),referenceColor=SetTextColor(reference,RGB(0,0,0));
        RECT sr={left,top,left+width,top+height},rr={0,0,width,height};FillRect(screen,&sr,brush);FillRect(reference,&rr,brush);
        const char *text="12345 3DMarks";
        if(!TextOutA(screen,left+3,top+3,text,lstrlenA(text)) || !TextOutA(reference,3,3,text,lstrlenA(text)))failures|=128;
        GdiFlush();if(!BitBlt(actual,0,0,width,height,screen,left,top,SRCCOPY))failures|=128;GdiFlush();
        DWORD differences=0;
        for(int pixel=0;pixel<width*height;pixel++)
            if(expected[pixel*4]!=observed[pixel*4] || expected[pixel*4+1]!=observed[pixel*4+1] || expected[pixel*4+2]!=observed[pixel*4+2])differences++;
        char label[]="GDI_FONT_0_DIFF";label[9]=(char)('0'+test);detail(mark,label,differences);
        if(test<5 && differences)failures|=64;
        if(test>=5)
        {
            // ANTIALIASED_QUALITY leaves smoothing to each device. Compare
            // glyph coverage independently of its palette's tone curve;
            // still report and save all exact RGB differences above.
            DWORD referenceTones[256],actualTones[256];
            unsigned int referenceCount=font_tones(expected,width*height,referenceTones),actualCount=font_tones(observed,width*height,actualTones);
            DWORD rankDifferences=0;
            if(!referenceCount || referenceCount!=actualCount)rankDifferences=width*height;
            else for(int pixel=0;pixel<width*height;pixel++)
            {
                DWORD a=*(DWORD*)(expected+pixel*4)&0xFFFFFF,b=*(DWORD*)(observed+pixel*4)&0xFFFFFF;
                unsigned int ar=0,br=0;while(ar<referenceCount && referenceTones[ar]!=a)ar++;
                while(br<actualCount && actualTones[br]!=b)br++;
                if(ar!=br)rankDifferences++;
            }
            char rankLabel[]="GDI_FONT_0_RANK_DIFF";rankLabel[9]=(char)('0'+test);detail(mark,rankLabel,rankDifferences);
            if(rankDifferences)failures|=64;
        }
        if(differences){font_bitmap(test,'R',&info.bmiHeader,expected);font_bitmap(test,'G',&info.bmiHeader,observed);}
        SetTextColor(screen,screenColor);SetTextColor(reference,referenceColor);SetBkMode(screen,screenMode);SetBkMode(reference,referenceMode);
        SelectObject(screen,screenFont);SelectObject(reference,referenceFont);DeleteObject(font);
    }
    BitBlt(screen,left,top,width,height,saved,0,0,SRCCOPY);GdiFlush();DeleteObject(brush);
    SelectObject(reference,oldReference);SelectObject(actual,oldActual);SelectObject(saved,oldSaved);
done:
    if(referenceBitmap)DeleteObject(referenceBitmap);if(actualBitmap)DeleteObject(actualBitmap);if(savedBitmap)DeleteObject(savedBitmap);
    if(reference)DeleteDC(reference);if(actual)DeleteDC(actual);if(saved)DeleteDC(saved);return failures;
}
#endif
DWORD nv_gdi_probe(void (*mark)(const char*))
{
    DWORD failures=0;
    HDC screen=GetDC(0),saved=CreateCompatibleDC(screen);
    HBITMAP bitmap=CreateCompatibleBitmap(screen,80,40);
    if(!screen || !saved || !bitmap) return 8;
    COLORREF before=GetPixel(screen,20,20);
    HGDIOBJ original=SelectObject(saved,bitmap);
    if(!BitBlt(saved,0,0,80,40,screen,16,16,SRCCOPY)) failures|=8;
    if(GetPixel(saved,4,4)!=before) failures|=16;
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
    unsigned int pixels=0;char rows[22][58];
    for(int y=18;y<40;y++)
    {
        for(int x=18;x<75;x++)
        {
            COLORREF sample=GetPixel(screen,x,y);
            rows[y-18][x-18]=sample==RGB(255,255,255)?'#':sample==RGB(0x33,0x66,0x99)?'.':sample==CLR_INVALID?'?':'+';
            if(sample==RGB(255,255,255))pixels++;
        }
        rows[y-18][57]=0;
    }
    detail(mark,"GDI_WHITE_PIXELS",pixels);
    if(pixels<20)for(int y=0;y<22;y++)mark(rows[y]);
    if(pixels<20) failures|=4;
    SetTextColor(screen,color);SetBkMode(screen,background);SelectObject(screen,font);
    BitBlt(screen,16,16,80,40,saved,0,0,SRCCOPY);GdiFlush();
    if(GetPixel(screen,20,20)!=before) failures|=32;
#ifdef NV_GDI_FONT_TEST
    failures|=font_probe(screen,mark);
#endif
    DeleteObject(brush);SelectObject(saved,original);DeleteObject(bitmap);DeleteDC(saved);ReleaseDC(0,screen);
    return failures;
}
#ifdef NV_DDRAW_TEST
#define COBJMACROS
#define DIRECTDRAW_VERSION 0x0700
#include <ddraw.h>
static const GUID nv_iid_directdraw7={0x15E65EC0,0x3B9C,0x11D2,{0xB9,0x2F,0,0x60,0x97,0x97,0xEA,0x5B}};
static void zero_bytes(void *p,unsigned int count) { BYTE *b=p;while(count--)*b++=0; }
DWORD nv_ddraw_probe(void (*mark)(const char*))
{
    DWORD failures=0;
    HMODULE library=LoadLibraryA("ddraw.dll");
    typedef HRESULT (WINAPI *create_t)(GUID*,void**,const IID*,IUnknown*);
    create_t create=library?(create_t)GetProcAddress(library,"DirectDrawCreateEx"):0;
    IDirectDraw7 *dd=0;IDirectDrawSurface7 *source=0,*target=0;
    mark("DDRAW_CREATE");
    HRESULT created=create?create(0,(void**)&dd,&nv_iid_directdraw7,0):HRESULT_FROM_WIN32(ERROR_PROC_NOT_FOUND);
    detail(mark,"DDRAW_CREATE_RESULT",created);
    if(created!=DD_OK) {failures=1;goto done;}
    mark("DDRAW_COOPERATIVE");
    if(IDirectDraw7_SetCooperativeLevel(dd,0,DDSCL_NORMAL)!=DD_OK) {failures=2;goto done;}
    DDCAPS caps;zero_bytes(&caps,sizeof(caps));caps.dwSize=sizeof(caps);
    mark("DDRAW_CAPS");
    if(IDirectDraw7_GetCaps(dd,&caps,0)!=DD_OK || !(caps.dwCaps&DDCAPS_BLT)) {failures=4;goto done;}
    detail(mark,"DDRAW_VIDMEM_TOTAL",caps.dwVidMemTotal);detail(mark,"DDRAW_VIDMEM_FREE",caps.dwVidMemFree);
    detail(mark,"DDRAW_CAPS_FLAGS",caps.dwCaps);detail(mark,"DDRAW_CAPS2_FLAGS",caps.dwCaps2);
    DDSCAPS2 memory_caps;zero_bytes(&memory_caps,sizeof(memory_caps));memory_caps.dwCaps=DDSCAPS_VIDEOMEMORY|DDSCAPS_3DDEVICE;
    DWORD memory_total=0,memory_free=0;
    HRESULT available=IDirectDraw7_GetAvailableVidMem(dd,&memory_caps,&memory_total,&memory_free);
    detail(mark,"DDRAW_3D_MEMORY_RESULT",available);detail(mark,"DDRAW_3D_MEMORY_TOTAL",memory_total);detail(mark,"DDRAW_3D_MEMORY_FREE",memory_free);
    DDSURFACEDESC2 desc;zero_bytes(&desc,sizeof(desc));desc.dwSize=sizeof(desc);
    desc.dwFlags=DDSD_CAPS|DDSD_WIDTH|DDSD_HEIGHT;desc.dwWidth=32;desc.dwHeight=32;
    desc.ddsCaps.dwCaps=DDSCAPS_OFFSCREENPLAIN|DDSCAPS_VIDEOMEMORY;
    IDirectDrawSurface7 *render_target=0;desc.ddsCaps.dwCaps|=DDSCAPS_3DDEVICE;
    HRESULT allocated=IDirectDraw7_CreateSurface(dd,&desc,&render_target,0);
    detail(mark,"DDRAW_3D_SURFACE_RESULT",allocated);if(render_target)IDirectDrawSurface7_Release(render_target);
#ifdef NV_D3D_TEXTURE_TEST
    // Exercise the actual DirectDraw HAL allocation path separately from D3D9.
    // Unsupported nonlocal memory is diagnostic, not a rendering failure.
    const DWORD texture_memory[]={DDSCAPS_VIDEOMEMORY,DDSCAPS_VIDEOMEMORY|DDSCAPS_LOCALVIDMEM,
        DDSCAPS_VIDEOMEMORY|DDSCAPS_NONLOCALVIDMEM,DDSCAPS_SYSTEMMEMORY};
    for(unsigned int pool=0;pool<4;pool++)for(unsigned int format=0;format<3;format++)
    {
        DDSURFACEDESC2 texture;zero_bytes(&texture,sizeof(texture));texture.dwSize=sizeof(texture);
        texture.dwFlags=DDSD_CAPS|DDSD_WIDTH|DDSD_HEIGHT|DDSD_PIXELFORMAT;
        texture.dwWidth=32;texture.dwHeight=32;texture.ddsCaps.dwCaps=DDSCAPS_TEXTURE|texture_memory[pool];
        DDPIXELFORMAT *pixel=&texture.ddpfPixelFormat;pixel->dwSize=sizeof(*pixel);pixel->dwFlags=DDPF_RGB;
        pixel->dwRGBBitCount=format==0?32:16;pixel->dwRBitMask=format==0?0xff0000:format==1?0xf800:0x7c00;
        pixel->dwGBitMask=format==0?0xff00:format==1?0x7e0:0x3e0;pixel->dwBBitMask=format==0?0xff:0x1f;
        IDirectDrawSurface7 *surface=0;
        mark("DDRAW_TEXTURE_ATTEMPT");detail(mark,"DDRAW_TEXTURE_CAPS",texture.ddsCaps.dwCaps);
        detail(mark,"DDRAW_TEXTURE_FORMAT",format);
        HRESULT created_texture=IDirectDraw7_CreateSurface(dd,&texture,&surface,0);
        detail(mark,"DDRAW_TEXTURE_CREATE",created_texture);
        if(created_texture==DD_OK && surface)
        {
            DDSURFACEDESC2 locked;zero_bytes(&locked,sizeof(locked));locked.dwSize=sizeof(locked);
            HRESULT locked_texture=IDirectDrawSurface7_Lock(surface,0,&locked,DDLOCK_WAIT,0);
            detail(mark,"DDRAW_TEXTURE_LOCK",locked_texture);
            if(locked_texture==DD_OK) {*(WORD*)locked.lpSurface=0x1234;IDirectDrawSurface7_Unlock(surface,0);}
        }
        if(surface)IDirectDrawSurface7_Release(surface);
    }
#endif
    desc.ddsCaps.dwCaps&=~DDSCAPS_3DDEVICE;
    mark("DDRAW_SURFACES");
    if(IDirectDraw7_CreateSurface(dd,&desc,&source,0)!=DD_OK || IDirectDraw7_CreateSurface(dd,&desc,&target,0)!=DD_OK) {failures=8;goto done;}
    DDBLTFX fx;zero_bytes(&fx,sizeof(fx));fx.dwSize=sizeof(fx);fx.dwFillColor=0x00336699;
    mark("DDRAW_BLIT");
    if(IDirectDrawSurface7_Blt(source,0,0,0,DDBLT_COLORFILL|DDBLT_WAIT,&fx)!=DD_OK) {failures=16;goto done;}
    if(IDirectDrawSurface7_Blt(target,0,source,0,DDBLT_WAIT,0)!=DD_OK) {failures=32;goto done;}
    zero_bytes(&desc,sizeof(desc));desc.dwSize=sizeof(desc);
    if(IDirectDrawSurface7_Lock(target,0,&desc,DDLOCK_WAIT|DDLOCK_READONLY,0)!=DD_OK) {failures=64;goto done;}
    detail(mark,"DDRAW_BITS",desc.ddpfPixelFormat.dwRGBBitCount);detail(mark,"DDRAW_PIXEL",*(DWORD*)desc.lpSurface);detail(mark,"DDRAW_PITCH",desc.lPitch);
    if(desc.ddpfPixelFormat.dwRGBBitCount!=32 || (*(DWORD*)desc.lpSurface&0xFFFFFF)!=0x00336699) failures|=128;
    IDirectDrawSurface7_Unlock(target,0);
    if(!(caps.dwRops[0x66>>5] & (1u<<(0x66&31)))) {mark("DDRAW_XOR_NOT_ADVERTISED");goto done;}
    fx.dwROP=SRCINVERT;
    HRESULT rop_result=IDirectDrawSurface7_Blt(target,0,source,0,DDBLT_ROP|DDBLT_WAIT,&fx);
    detail(mark,"DDRAW_ROP_RESULT",rop_result);
    if(rop_result!=DD_OK) {failures|=256;goto done;}
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
