/* Native D3D9 HAL smoke test. No proxy DLL or guest API replacement. */
#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <d3d9.h>
static void zero(void *p,unsigned int count) {BYTE *b=p;while(count--)*b++=0;}
static void report(void (*mark)(const char*),const char *label,DWORD value)
{
    char text[96];unsigned int at=0;while(*label && at<80)text[at++]=*label++;
    text[at++]='=';const char hex[]="0123456789abcdef";
    for(int i=7;i>=0;i--)text[at++]=hex[value>>(i*4)&15];text[at]=0;mark(text);
}
DWORD nv_d3d_probe(void (*mark)(const char*))
{
    DWORD failure=1;HRESULT hr=E_FAIL;
    HMODULE library=LoadLibraryA("d3d9.dll");
    typedef IDirect3D9* (WINAPI *create_t)(UINT);
    create_t create=library?(create_t)GetProcAddress(library,"Direct3DCreate9"):0;
    IDirect3D9 *d3d=0;IDirect3DDevice9 *device=0;IDirect3DSurface9 *target=0,*readback=0;
    HWND window=0;D3DPRESENT_PARAMETERS present;D3DCAPS9 caps;
    mark("D3D9_CREATE");
    if(!create || !(d3d=create(D3D_SDK_VERSION)))goto done;
    hr=IDirect3D9_GetDeviceCaps(d3d,0,D3DDEVTYPE_HAL,&caps);report(mark,"D3D9_CAPS_RESULT",hr);
    if(FAILED(hr))goto done;
    report(mark,"D3D9_VS_VERSION",caps.VertexShaderVersion);report(mark,"D3D9_PS_VERSION",caps.PixelShaderVersion);
    window=CreateWindowExA(0,"STATIC","NV40 native D3D9",WS_OVERLAPPEDWINDOW,32,32,96,96,0,0,GetModuleHandleA(0),0);
    if(!window)goto done;
    ShowWindow(window,SW_SHOW);UpdateWindow(window);
    zero(&present,sizeof(present));present.BackBufferWidth=64;present.BackBufferHeight=64;
    present.BackBufferFormat=D3DFMT_X8R8G8B8;present.BackBufferCount=1;present.SwapEffect=D3DSWAPEFFECT_DISCARD;
    present.hDeviceWindow=window;present.Windowed=TRUE;present.PresentationInterval=D3DPRESENT_INTERVAL_IMMEDIATE;
    mark("D3D9_DEVICE");
    hr=IDirect3D9_CreateDevice(d3d,0,D3DDEVTYPE_HAL,window,D3DCREATE_HARDWARE_VERTEXPROCESSING|D3DCREATE_FPU_PRESERVE,&present,&device);
    report(mark,"D3D9_DEVICE_RESULT",hr);
    if(FAILED(hr))
    {
        hr=IDirect3D9_CreateDevice(d3d,0,D3DDEVTYPE_HAL,window,D3DCREATE_SOFTWARE_VERTEXPROCESSING|D3DCREATE_FPU_PRESERVE,&present,&device);
        report(mark,"D3D9_HAL_SWVP_RESULT",hr);
    }
    if(FAILED(hr)){failure=2;goto done;}
    hr=IDirect3DDevice9_Clear(device,0,0,D3DCLEAR_TARGET,0xFF102030,1,0);
    report(mark,"D3D9_CLEAR_RESULT",hr);if(FAILED(hr)){failure=4;goto done;}
    struct vertex {float x,y,z,w;DWORD color;} vertices[3]={{0,0,0,1,0xFF336699},{0,128,0,1,0xFF336699},{128,0,0,1,0xFF336699}};
    IDirect3DDevice9_SetRenderState(device,D3DRS_LIGHTING,FALSE);
    IDirect3DDevice9_SetRenderState(device,D3DRS_CULLMODE,D3DCULL_NONE);
    IDirect3DDevice9_SetRenderState(device,D3DRS_ZENABLE,FALSE);
    IDirect3DDevice9_SetFVF(device,D3DFVF_XYZRHW|D3DFVF_DIFFUSE);
    mark("D3D9_DRAW");hr=IDirect3DDevice9_BeginScene(device);
    if(SUCCEEDED(hr)) {hr=IDirect3DDevice9_DrawPrimitiveUP(device,D3DPT_TRIANGLELIST,1,vertices,sizeof(vertices[0]));IDirect3DDevice9_EndScene(device);}
    report(mark,"D3D9_DRAW_RESULT",hr);if(FAILED(hr)){failure=8;goto done;}
    hr=IDirect3DDevice9_GetRenderTarget(device,0,&target);if(FAILED(hr)){failure=16;goto done;}
    hr=IDirect3DDevice9_CreateOffscreenPlainSurface(device,64,64,D3DFMT_X8R8G8B8,D3DPOOL_SYSTEMMEM,&readback,0);
    if(FAILED(hr)){failure=16;goto done;}
    mark("D3D9_READBACK");hr=IDirect3DDevice9_GetRenderTargetData(device,target,readback);
    report(mark,"D3D9_READBACK_RESULT",hr);if(FAILED(hr)){failure=32;goto done;}
    D3DLOCKED_RECT locked;hr=IDirect3DSurface9_LockRect(readback,&locked,0,D3DLOCK_READONLY);
    if(FAILED(hr)){failure=64;goto done;}
    DWORD pixel=*(DWORD*)((BYTE*)locked.pBits+16*locked.Pitch+16*4);
    report(mark,"D3D9_PIXEL",pixel);failure=(pixel&0xFFFFFF)==0x336699?0:128;
    IDirect3DSurface9_UnlockRect(readback);
done:
    if(readback)IDirect3DSurface9_Release(readback);if(target)IDirect3DSurface9_Release(target);
    if(device)IDirect3DDevice9_Release(device);if(d3d)IDirect3D9_Release(d3d);
    if(window)DestroyWindow(window);if(library)FreeLibrary(library);
    mark("D3D9_DONE");return failure;
}
