/* MinGW C ABI declarations needed to compile the original Wine tests.
 * Mirrors include/d3d9on12.idl at Wine commit
 * 415a275e3844c252ad385b46023095e9401ca234. No runtime implementation or
 * capability override is supplied: XP's missing D3D9On12 remains reported.
 */
#ifndef D3D_WINE_MINGW_D3D9ON12_H
#define D3D_WINE_MINGW_D3D9ON12_H
#include <d3d9.h>
#include <d3d12.h>
#define MAX_D3D9ON12_QUEUES 2
typedef struct D3D9ON12_ARGS {
    BOOL Enable9On12;
    IUnknown *pD3D12Device;
    IUnknown *ppD3D12Queues[MAX_D3D9ON12_QUEUES];
    UINT NumQueues;
    UINT NodeMask;
} D3D9ON12_ARGS;
DEFINE_GUID(IID_IDirect3DDevice9On12,0xe7fda234,0xb589,0x4049,0x94,0x0d,0x88,0x78,0x97,0x75,0x31,0xc8);
#undef INTERFACE
#define INTERFACE IDirect3DDevice9On12
DECLARE_INTERFACE_(IDirect3DDevice9On12,IUnknown) {
    STDMETHOD(QueryInterface)(THIS_ REFIID iid,void **out) PURE;
    STDMETHOD_(ULONG,AddRef)(THIS) PURE;
    STDMETHOD_(ULONG,Release)(THIS) PURE;
    STDMETHOD(GetD3D12Device)(THIS_ REFIID iid,void **out) PURE;
    STDMETHOD(UnwrapUnderlyingResource)(THIS_ IDirect3DResource9 *resource,ID3D12CommandQueue *queue,REFIID iid,void **out) PURE;
    STDMETHOD(ReturnUnderlyingResource)(THIS_ IDirect3DResource9 *resource,UINT fence_count,UINT64 *signal_values,ID3D12Fence **fences) PURE;
};
#undef INTERFACE
#define IDirect3DDevice9On12_QueryInterface(p,i,o) (p)->lpVtbl->QueryInterface(p,i,o)
#define IDirect3DDevice9On12_AddRef(p) (p)->lpVtbl->AddRef(p)
#define IDirect3DDevice9On12_Release(p) (p)->lpVtbl->Release(p)
#define IDirect3DDevice9On12_GetD3D12Device(p,i,o) (p)->lpVtbl->GetD3D12Device(p,i,o)
#define IDirect3DDevice9On12_UnwrapUnderlyingResource(p,r,q,i,o) (p)->lpVtbl->UnwrapUnderlyingResource(p,r,q,i,o)
#define IDirect3DDevice9On12_ReturnUnderlyingResource(p,r,c,v,f) (p)->lpVtbl->ReturnUnderlyingResource(p,r,c,v,f)
_Static_assert(sizeof(void *) == 4 && sizeof(D3D9ON12_ARGS) == 24, "D3D9On12 x86 ABI");
#endif
