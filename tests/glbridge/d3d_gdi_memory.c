#define COBJMACROS
#include <windows.h>
#include <d3d9.h>
#include <ddraw.h>
#include <stdio.h>
#include "d3d9_gdi_memory.inc"
static unsigned checks;
#define CHECK(c) do {checks++;if(!(c)){printf("FAIL line %u: %s\n",__LINE__,#c);return 1;}}while(0)
int main(void)
{
    const D3DFORMAT formats[]={D3DFMT_R8G8B8,D3DFMT_A8R8G8B8,D3DFMT_X8R8G8B8,D3DFMT_R5G6B5,D3DFMT_X1R5G5B5,D3DFMT_A1R5G5B5};
    for (UINT f=0;f<6;f++) for (UINT w=5;w<=64;w+=59) {
        UINT bytes=f<3?(f?4:3):2,pitch=w*bytes+8;BYTE pixels[1024];
        memset(pixels,0x65,sizeof(pixels));
        for(UINT y=0;y<3;y++)for(UINT x=0;x<w;x++){
            DWORD green=bytes==2?(f==3?0x07e0:0x03e0):0x0000ff00;
            memcpy(pixels+y*pitch+x*bytes,&green,bytes);
        }
        D9GdiMemory *memory=NULL;
        HRESULT hr=gdi_memory_open(w,3,formats[f],pixels,pitch,GetModuleHandleA(NULL),&memory);
        printf("format=%u width=%u create=%lx\n",formats[f],w,hr);
        CHECK(SUCCEEDED(hr)&&memory&&memory->dc);
        DIBSECTION dib;ZeroMemory(&dib,sizeof(dib));
        CHECK(GetObjectA(GetCurrentObject(memory->dc,OBJ_BITMAP),sizeof(dib),&dib)==sizeof(dib));
        CHECK(dib.dsBmih.biSizeImage==0&&dib.dsBmih.biWidth==(LONG)w&&dib.dsBmih.biHeight==3);
        CHECK(GetPixel(memory->dc,0,0)==RGB(0,255,0));
        CHECK(SetPixel(memory->dc,1,0,RGB(255,0,0))==RGB(255,0,0));
        CHECK(SetPixel(memory->dc,1,2,RGB(0,0,255))==RGB(0,0,255));
        CHECK(SUCCEEDED(gdi_memory_close(memory,pixels,pitch)));
        for(UINT y=0;y<3;y++)for(UINT x=0;x<w;x++){
            DWORD value=0;memcpy(&value,pixels+y*pitch+x*bytes,bytes);
            DWORD expected=bytes==2?(f==3?0x07e0:0x03e0):0x0000ff00;
            if(x==1&&y==0)expected=bytes==2?(f==3?0xf800:0x7c00):0xff0000;
            if(x==1&&y==2)expected=bytes==2?0x001f:0x0000ff;
            CHECK((value&(bytes==2?(f==3?0xffff:0x7fff):0xffffff))==expected);
        }
        for(UINT y=0;y<3;y++)for(UINT x=w*bytes;x<pitch;x++)CHECK(pixels[y*pitch+x]==0x65);
    }
    printf("PASS GDI memory: %u checks; native metadata, six formats, odd widths, row direction, pixels and padding\n",checks);
    return 0;
}
