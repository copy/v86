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
