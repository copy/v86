/* The upstream file and all test functions remain byte-for-byte intact.
 * Select a named compatibility group, or run the complete original entry.
 * A group's success is never reported as full-suite conformance. */
#define COBJMACROS
#include <initguid.h>
#include <d3d8.h>
#include "wine/test.h"
#undef START_TEST
#define START_TEST(name) static void full_device_suite(void)
#include "wine/d3d8_device.c"

/* Supplemental regression for the GPU-invalid descriptors found by the full
 * suite. This function is project-owned; the upstream functions are above. */
static void compressed_creation_group(void)
{
    static const D3DFORMAT formats[] = {
        D3DFMT_DXT1, D3DFMT_DXT2, D3DFMT_DXT3, D3DFMT_DXT4, D3DFMT_DXT5
    };
    HWND window = create_window();
    IDirect3D8 *root = Direct3DCreate8(D3D_SDK_VERSION);
    IDirect3DDevice8 *device = root ? create_device(root, window, NULL) : NULL;
    ok(!!device, "Failed to create compressed resource test device.\n");
    if (device) {
        for (unsigned int f = 0; f < ARRAY_SIZE(formats); ++f)
        for (unsigned int pool = 0; pool < 4; ++pool)
        for (unsigned int w = 1; w <= 8; ++w)
        for (unsigned int h = 1; h <= 8; ++h) {
            IDirect3DTexture8 *texture = (void *)0xdeadbeef;
            HRESULT expected = w % 4 || h % 4 ? D3DERR_INVALIDCALL : D3D_OK;
            HRESULT hr = IDirect3DDevice8_CreateTexture(device, w, h, 1, 0,
                    formats[f], pool, &texture);
            ok(hr == expected, "DXT texture %u/%u %ux%u: hr %#lx, expected %#lx.\n",
                    f, pool, w, h, hr, expected);
            if (SUCCEEDED(hr)) IDirect3DTexture8_Release(texture);
            else ok(!texture, "Failed texture output was not cleared.\n");
            if (w == h) {
                IDirect3DCubeTexture8 *cube = (void *)0xdeadbeef;
                hr = IDirect3DDevice8_CreateCubeTexture(device, w, 1, 0,
                        formats[f], pool, &cube);
                ok(hr == expected, "DXT cube %u/%u %u: hr %#lx.\n", f, pool, w, hr);
                if (SUCCEEDED(hr)) IDirect3DCubeTexture8_Release(cube);
                else ok(!cube, "Failed cube output was not cleared.\n");
            }
        }
        for (unsigned int f = 0; f < ARRAY_SIZE(formats); ++f) {
            IDirect3DTexture8 *texture = NULL;
            HRESULT hr = IDirect3DDevice8_CreateTexture(device, 4, 4, 0, 0,
                    formats[f], D3DPOOL_MANAGED, &texture);
            ok(hr == D3D_OK && !!texture, "Failed complete DXT mip tree, hr %#lx.\n", hr);
            if (texture) {
                ok(IDirect3DTexture8_GetLevelCount(texture) == 3, "Missing tiny DXT mip levels.\n");
                for (unsigned int level = 1; level <= 2; ++level) {
                    D3DSURFACE_DESC desc;
                    hr = IDirect3DTexture8_GetLevelDesc(texture, level, &desc);
                    ok(hr == D3D_OK && desc.Width == (4u >> level)
                            && desc.Height == (4u >> level), "Wrong tiny DXT mip dimensions.\n");
                    D3DLOCKED_RECT locked;
                    hr = IDirect3DTexture8_LockRect(texture, level, &locked, NULL, 0);
                    ok(hr == D3D_OK && locked.pBits && locked.Pitch == (f ? 16 : 8),
                            "Failed tiny DXT mip lock, hr %#lx.\n", hr);
                    if (SUCCEEDED(hr)) {
                        memset(locked.pBits, 0, f ? 16 : 8);
                        hr = IDirect3DTexture8_UnlockRect(texture, level);
                        ok(hr == D3D_OK, "Failed tiny DXT mip upload, hr %#lx.\n", hr);
                    }
                }
                IDirect3DTexture8_Release(texture);
            }
        }
        ULONG refs = IDirect3DDevice8_Release(device);
        ok(!refs, "Compressed test device has %lu references left.\n", refs);
    }
    if (root) IDirect3D8_Release(root);
    DestroyWindow(window);
}

static void compatibility_group(void)
{
    HMODULE module = GetModuleHandleA("d3d8.dll");
    WNDCLASSA wc = {0};
    wc.lpfnWndProc = DefWindowProcA;
    wc.lpszClassName = "d3d8_test_wc";
    RegisterClassA(&wc);
    ValidateVertexShader = (void *)GetProcAddress(module, "ValidateVertexShader");
    ValidatePixelShader = (void *)GetProcAddress(module, "ValidatePixelShader");
    ok(!!ValidateVertexShader && !!ValidatePixelShader, "Missing validation exports.\n");
    if (ValidateVertexShader && ValidatePixelShader) {
        test_validate_vs();
        test_validate_ps();
    }
    test_display_formats();
    test_display_modes();
    compressed_creation_group();
    UnregisterClassA(wc.lpszClassName, GetModuleHandleA(NULL));
}

static void locking_group(void)
{
    WNDCLASSA wc = {0};
    wc.lpfnWndProc = DefWindowProcA;
    wc.lpszClassName = "d3d8_test_wc";
    RegisterClassA(&wc);
    test_lockrect_invalid();
    test_surface_double_unlock();
    UnregisterClassA(wc.lpszClassName, GetModuleHandleA(NULL));
}

static void storage_audit_group(void)
{
    WNDCLASSA wc = {0};
    wc.lpfnWndProc = DefWindowProcA;
    wc.lpszClassName = "d3d8_test_wc";
    RegisterClassA(&wc);
    test_surface_blocks();
    test_volume_blocks();
    test_volume_locking();
    test_lockbox_invalid();
    UnregisterClassA(wc.lpszClassName, GetModuleHandleA(NULL));
}

/* Project-owned image matrix for the formats our runtime declares. The
 * unmodified surface_blocks audit remains available and reports its two
 * unsupported ATI extension skips; it is never relabelled a full pass. */
static void storage_group(void)
{
    WNDCLASSA wc = {0};
    wc.lpfnWndProc = DefWindowProcA; wc.lpszClassName = "d3d8_test_wc";
    RegisterClassA(&wc);
    HWND window = create_window();
    IDirect3D8 *root = Direct3DCreate8(D3D_SDK_VERSION);
    IDirect3DDevice8 *device = root ? create_device(root, window, NULL) : NULL;
    ok(!!device, "Missing image-storage test device.\n");
    if (device) {
        const D3DFORMAT formats[] = {D3DFMT_DXT1,D3DFMT_DXT2,D3DFMT_DXT3,D3DFMT_DXT4,D3DFMT_DXT5,D3DFMT_YUY2,D3DFMT_UYVY};
        for (unsigned int f=0; f<ARRAY_SIZE(formats); ++f)
            for (unsigned int w=1; w<=8; ++w) for (unsigned int h=1; h<=8; ++h) {
                IDirect3DSurface8 *surface=(void *)0xdeadbeef;
                HRESULT expected=f<5 && ((w%4)||(h%4)) ? D3DERR_INVALIDCALL : D3D_OK;
                HRESULT hr=IDirect3DDevice8_CreateImageSurface(device,w,h,formats[f],&surface);
                ok(hr==expected,"Image %u %ux%u hr %#lx expected %#lx.\n",f,w,h,hr,expected);
                if (FAILED(hr)) {ok(!surface,"Failed image output not cleared.\n");continue;}
                D3DLOCKED_RECT lock;
                hr=IDirect3DSurface8_LockRect(surface,&lock,NULL,0);
                const unsigned int pitch=f<5 ? ((w+3)/4)*(f?16:8) : ((w+1)/2)*4;
                ok(hr==D3D_OK&&lock.Pitch==(INT)pitch&&lock.pBits,"Image layout mismatch.\n");
                if (SUCCEEDED(hr)) {
                    memset(lock.pBits,0,pitch*(f<5?(h+3)/4:h));
                    hr=IDirect3DSurface8_UnlockRect(surface);
                    ok(hr==D3D_OK,"Image unlock failed.\n");
                }
                IDirect3DSurface8_Release(surface);
            }
        IDirect3DVolumeTexture8 *scratch=NULL;
        HRESULT hr=IDirect3DDevice8_CreateVolumeTexture(device,4,4,2,0,0,D3DFMT_DXT1,D3DPOOL_SCRATCH,&scratch);
        ok(hr==D3D_OK&&scratch,"Missing scratch compressed volume.\n");
        if(scratch) {
            hr=IDirect3DDevice8_SetTexture(device,0,(IDirect3DBaseTexture8 *)scratch);
            ok(hr==D3DERR_INVALIDCALL,"Scratch volume must not bind to GPU.\n");
            IDirect3DVolumeTexture8_Release(scratch);
        }
        ULONG refs=IDirect3DDevice8_Release(device);ok(!refs,"Image device references %lu.\n",refs);
    }
    if(root)IDirect3D8_Release(root);DestroyWindow(window);
    test_volume_blocks();test_volume_locking();test_lockbox_invalid();
    UnregisterClassA(wc.lpszClassName,GetModuleHandleA(NULL));
}

static void resource_contract_group(void)
{
    WNDCLASSA wc = {0};
    wc.lpfnWndProc = DefWindowProcA;
    wc.lpszClassName = "d3d8_test_wc";
    RegisterClassA(&wc);
    test_get_set_texture();
    test_create_rt_ds_fail();
    test_update_texture_pool();
    test_update_volumetexture();
    test_mipmap_lock();
    test_writeonly_resource();
    test_resource_priority();
    UnregisterClassA(wc.lpszClassName, GetModuleHandleA(NULL));
}

#include "d3d8_swapchain_pixels.h"

static void swapchain_group(void)
{
    WNDCLASSA wc = {0};
    wc.lpfnWndProc = DefWindowProcA;
    wc.lpszClassName = "d3d8_test_wc";
    RegisterClassA(&wc);
    registry_mode.dmSize = sizeof(registry_mode);
    ok(EnumDisplaySettingsW(NULL, ENUM_REGISTRY_SETTINGS, &registry_mode), "Missing registry display mode.\n");
    test_swapchain();
    test_swapchain_parameters();
    swapchain_pixels();
    UnregisterClassA(wc.lpszClassName, GetModuleHandleA(NULL));
}

const struct test winetest_testlist[] = {
    { "device", full_device_suite },
    { "compatibility", compatibility_group },
    { "locking", locking_group },
    { "storage", storage_group },
    { "resources", resource_contract_group },
    { "swapchains", swapchain_group },
    { "storage-audit", storage_audit_group },
    { 0, 0 }
};
