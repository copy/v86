/*
 * Copyright (C) 2006 Vitaliy Margolen
 * Copyright (C) 2006 Chris Robinson
 * Copyright (C) 2006 Louis Lenders
 * Copyright 2006-2007 Henri Verbeet
 * Copyright 2006-2007, 2011-2013 Stefan Dösinger for CodeWeavers
 * Copyright 2013 Henri Verbeet for CodeWeavers
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this library; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA 02110-1301, USA
 */

#include <stdlib.h>
#define COBJMACROS
#include <initguid.h>
#include <d3d8.h>
#include "wine/test.h"

struct vec3
{
    float x, y, z;
};

#define CREATE_DEVICE_FULLSCREEN            0x01
#define CREATE_DEVICE_FPU_PRESERVE          0x02
#define CREATE_DEVICE_SWVP_ONLY             0x04
#define CREATE_DEVICE_LOCKABLE_BACKBUFFER   0x08

struct device_desc
{
    unsigned int adapter_ordinal;
    HWND device_window;
    unsigned int width;
    unsigned int height;
    DWORD flags;
};

#define GET_X_LPARAM(lp) ((int)(short)LOWORD(lp))
#define GET_Y_LPARAM(lp) ((int)(short)HIWORD(lp))

static DEVMODEW registry_mode;

static HRESULT (WINAPI *ValidateVertexShader)(const DWORD *, const DWORD *, const D3DCAPS8 *, BOOL, char **);
static HRESULT (WINAPI *ValidatePixelShader)(const DWORD *, const D3DCAPS8 *, BOOL, char **);

static const DWORD simple_vs[] = {0xFFFE0101,       /* vs_1_1               */
    0x00000009, 0xC0010000, 0x90E40000, 0xA0E40000, /* dp4 oPos.x, v0, c0   */
    0x00000009, 0xC0020000, 0x90E40000, 0xA0E40001, /* dp4 oPos.y, v0, c1   */
    0x00000009, 0xC0040000, 0x90E40000, 0xA0E40002, /* dp4 oPos.z, v0, c2   */
    0x00000009, 0xC0080000, 0x90E40000, 0xA0E40003, /* dp4 oPos.w, v0, c3   */
    0x0000FFFF};                                    /* END                  */
static const DWORD simple_ps[] = {0xFFFF0101,                               /* ps_1_1                       */
    0x00000051, 0xA00F0001, 0x3F800000, 0x00000000, 0x00000000, 0x00000000, /* def c1 = 1.0, 0.0, 0.0, 0.0  */
    0x00000042, 0xB00F0000,                                                 /* tex t0                       */
    0x00000008, 0x800F0000, 0xA0E40001, 0xA0E40000,                         /* dp3 r0, c1, c0               */
    0x00000005, 0x800F0000, 0x90E40000, 0x80E40000,                         /* mul r0, v0, r0               */
    0x00000005, 0x800F0000, 0xB0E40000, 0x80E40000,                         /* mul r0, t0, r0               */
    0x0000FFFF};                                                            /* END                          */

static int get_refcount(IUnknown *object)
{
    IUnknown_AddRef( object );
    return IUnknown_Release( object );
}

static void get_virtual_rect(RECT *rect)
{
    rect->left = GetSystemMetrics(SM_XVIRTUALSCREEN);
    rect->top = GetSystemMetrics(SM_YVIRTUALSCREEN);
    rect->right = rect->left + GetSystemMetrics(SM_CXVIRTUALSCREEN);
    rect->bottom = rect->top + GetSystemMetrics(SM_CYVIRTUALSCREEN);
}

static HWND create_window(void)
{
    RECT r = {0, 0, 640, 480};

    AdjustWindowRect(&r, WS_OVERLAPPEDWINDOW | WS_VISIBLE, FALSE);

    return CreateWindowA("static", "d3d8_test", WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            0, 0, r.right - r.left, r.bottom - r.top, NULL, NULL, NULL, NULL);
}

/* try to make sure pending X events have been processed before continuing */
static void flush_events(void)
{
    MSG msg;
    int diff = 200;
    int min_timeout = 100;
    DWORD time = GetTickCount() + diff;

    while (diff > 0)
    {
        if (MsgWaitForMultipleObjects( 0, NULL, FALSE, min_timeout, QS_ALLINPUT ) == WAIT_TIMEOUT) break;
        while (PeekMessageA(&msg, 0, 0, 0, PM_REMOVE)) DispatchMessageA(&msg);
        diff = time - GetTickCount();
    }
}

static BOOL adapter_is_warp(const D3DADAPTER_IDENTIFIER8 *identifier)
{
    return !strcmp(identifier->Driver, "d3d10warp.dll");
}

static BOOL equal_mode_rect(const DEVMODEW *mode1, const DEVMODEW *mode2)
{
    return mode1->dmPosition.x == mode2->dmPosition.x
            && mode1->dmPosition.y == mode2->dmPosition.y
            && mode1->dmPelsWidth == mode2->dmPelsWidth
            && mode1->dmPelsHeight == mode2->dmPelsHeight;
}

/* Free original_modes after finished using it */
static BOOL save_display_modes(DEVMODEW **original_modes, unsigned int *display_count)
{
    unsigned int number, size = 2, count = 0, index = 0;
    DISPLAY_DEVICEW display_device;
    DEVMODEW *modes, *tmp;

    if (!(modes = malloc(size * sizeof(*modes))))
        return FALSE;

    display_device.cb = sizeof(display_device);
    while (EnumDisplayDevicesW(NULL, index++, &display_device, 0))
    {
        /* Skip software devices */
        if (swscanf(display_device.DeviceName, L"\\\\.\\DISPLAY%u", &number) != 1)
            continue;

        if (!(display_device.StateFlags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP))
            continue;

        if (count >= size)
        {
            size *= 2;
            if (!(tmp = realloc(modes, size * sizeof(*modes))))
            {
                free(modes);
                return FALSE;
            }
            modes = tmp;
        }

        memset(&modes[count], 0, sizeof(modes[count]));
        modes[count].dmSize = sizeof(modes[count]);
        if (!EnumDisplaySettingsW(display_device.DeviceName, ENUM_CURRENT_SETTINGS, &modes[count]))
        {
            free(modes);
            return FALSE;
        }

        lstrcpyW(modes[count++].dmDeviceName, display_device.DeviceName);
    }

    *original_modes = modes;
    *display_count = count;
    return TRUE;
}

static BOOL restore_display_modes(DEVMODEW *modes, unsigned int count)
{
    unsigned int index;
    LONG ret;

    for (index = 0; index < count; ++index)
    {
        ret = ChangeDisplaySettingsExW(modes[index].dmDeviceName, &modes[index], NULL,
                CDS_UPDATEREGISTRY | CDS_NORESET, NULL);
        if (ret != DISP_CHANGE_SUCCESSFUL)
            return FALSE;
    }
    ret = ChangeDisplaySettingsExW(NULL, NULL, NULL, 0, NULL);
    return ret == DISP_CHANGE_SUCCESSFUL;
}

static IDirect3DDevice8 *create_device(IDirect3D8 *d3d8, HWND focus_window, const struct device_desc *desc)
{
    D3DPRESENT_PARAMETERS present_parameters = {0};
    unsigned int adapter_ordinal;
    IDirect3DDevice8 *device;
    DWORD behavior_flags = D3DCREATE_HARDWARE_VERTEXPROCESSING;

    adapter_ordinal = D3DADAPTER_DEFAULT;
    present_parameters.BackBufferWidth = 640;
    present_parameters.BackBufferHeight = 480;
    present_parameters.BackBufferFormat = D3DFMT_A8R8G8B8;
    present_parameters.SwapEffect = D3DSWAPEFFECT_DISCARD;
    present_parameters.hDeviceWindow = focus_window;
    present_parameters.Windowed = TRUE;
    present_parameters.EnableAutoDepthStencil = TRUE;
    present_parameters.AutoDepthStencilFormat = D3DFMT_D24S8;

    if (desc)
    {
        adapter_ordinal = desc->adapter_ordinal;
        present_parameters.BackBufferWidth = desc->width;
        present_parameters.BackBufferHeight = desc->height;
        present_parameters.hDeviceWindow = desc->device_window;
        present_parameters.Windowed = !(desc->flags & CREATE_DEVICE_FULLSCREEN);
        if (desc->flags & CREATE_DEVICE_LOCKABLE_BACKBUFFER)
            present_parameters.Flags |= D3DPRESENTFLAG_LOCKABLE_BACKBUFFER;
        if (desc->flags & CREATE_DEVICE_SWVP_ONLY)
            behavior_flags = D3DCREATE_SOFTWARE_VERTEXPROCESSING;
        if (desc->flags & CREATE_DEVICE_FPU_PRESERVE)
            behavior_flags |= D3DCREATE_FPU_PRESERVE;
    }

    if (SUCCEEDED(IDirect3D8_CreateDevice(d3d8, adapter_ordinal, D3DDEVTYPE_HAL, focus_window,
            behavior_flags, &present_parameters, &device)))
        return device;

    present_parameters.AutoDepthStencilFormat = D3DFMT_D16;
    if (SUCCEEDED(IDirect3D8_CreateDevice(d3d8, adapter_ordinal, D3DDEVTYPE_HAL, focus_window,
            behavior_flags, &present_parameters, &device)))
        return device;

    if (desc && desc->flags & CREATE_DEVICE_SWVP_ONLY)
        return NULL;
    behavior_flags ^= (D3DCREATE_HARDWARE_VERTEXPROCESSING | D3DCREATE_SOFTWARE_VERTEXPROCESSING);

    if (SUCCEEDED(IDirect3D8_CreateDevice(d3d8, adapter_ordinal, D3DDEVTYPE_HAL, focus_window,
            behavior_flags, &present_parameters, &device)))
        return device;

    return NULL;
}

static HRESULT reset_device(IDirect3DDevice8 *device, const struct device_desc *desc)
{
    D3DPRESENT_PARAMETERS present_parameters = {0};

    present_parameters.BackBufferWidth = 640;
    present_parameters.BackBufferHeight = 480;
    present_parameters.BackBufferFormat = D3DFMT_A8R8G8B8;
    present_parameters.SwapEffect = D3DSWAPEFFECT_DISCARD;
    present_parameters.hDeviceWindow = NULL;
    present_parameters.Windowed = TRUE;
    present_parameters.EnableAutoDepthStencil = TRUE;
    present_parameters.AutoDepthStencilFormat = D3DFMT_D24S8;

    if (desc)
    {
        present_parameters.BackBufferWidth = desc->width;
        present_parameters.BackBufferHeight = desc->height;
        present_parameters.hDeviceWindow = desc->device_window;
        present_parameters.Windowed = !(desc->flags & CREATE_DEVICE_FULLSCREEN);
    }

    return IDirect3DDevice8_Reset(device, &present_parameters);
}

#define CHECK_CALL(r,c,d,rc) \
    if (SUCCEEDED(r)) {\
        int tmp1 = get_refcount( (IUnknown *)d ); \
        int rc_new = rc; \
        ok(tmp1 == rc_new, "Invalid refcount. Expected %d got %d\n", rc_new, tmp1); \
    } else {\
        trace("%s failed: %#08lx\n", c, r); \
    }

#define CHECK_RELEASE(obj,d,rc) \
    if (obj) { \
        int tmp1, rc_new = rc; \
        IUnknown_Release( (IUnknown*)obj ); \
        tmp1 = get_refcount( (IUnknown *)d ); \
        ok(tmp1 == rc_new, "Invalid refcount. Expected %d got %d\n", rc_new, tmp1); \
    }

#define CHECK_REFCOUNT(obj,rc) \
    { \
        int rc_new = rc; \
        int count = get_refcount( (IUnknown *)obj ); \
        ok(count == rc_new, "Invalid refcount. Expected %d got %d\n", rc_new, count); \
    }

#define CHECK_RELEASE_REFCOUNT(obj,rc) \
    { \
        int rc_new = rc; \
        int count = IUnknown_Release( (IUnknown *)obj ); \
        ok(count == rc_new, "Invalid refcount. Expected %d got %d\n", rc_new, count); \
    }

#define CHECK_ADDREF_REFCOUNT(obj,rc) \
    { \
        int rc_new = rc; \
        int count = IUnknown_AddRef( (IUnknown *)obj ); \
        ok(count == rc_new, "Invalid refcount. Expected %d got %d\n", rc_new, count); \
    }

#define CHECK_SURFACE_CONTAINER(obj,iid,expected) \
    { \
        void *container_ptr = (void *)0x1337c0d3; \
        hr = IDirect3DSurface8_GetContainer(obj, &iid, &container_ptr); \
        ok(SUCCEEDED(hr) && container_ptr == expected, "GetContainer returned: hr %#08lx, container_ptr %p. " \
            "Expected hr %#08lx, container_ptr %p\n", hr, container_ptr, S_OK, expected); \
        if (container_ptr && container_ptr != (void *)0x1337c0d3) IUnknown_Release((IUnknown *)container_ptr); \
    }

static void check_mipmap_levels(IDirect3DDevice8 *device, UINT width, UINT height, UINT count)
{
    IDirect3DBaseTexture8* texture = NULL;
    HRESULT hr = IDirect3DDevice8_CreateTexture( device, width, height, 0, 0,
            D3DFMT_X8R8G8B8, D3DPOOL_DEFAULT, (IDirect3DTexture8**) &texture );

    if (SUCCEEDED(hr)) {
        DWORD levels = IDirect3DBaseTexture8_GetLevelCount(texture);
        ok(levels == count, "Invalid level count. Expected %d got %lu\n", count, levels);
    } else
        trace("CreateTexture failed: %#08lx\n", hr);

    if (texture) IDirect3DBaseTexture8_Release( texture );
}

static void test_mipmap_levels(void)
{
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;

    window = create_window();
    ok(!!window, "Failed to create a window.\n");
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, NULL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        goto cleanup;
    }

    check_mipmap_levels(device, 32, 32, 6);
    check_mipmap_levels(device, 256, 1, 9);
    check_mipmap_levels(device, 1, 256, 9);
    check_mipmap_levels(device, 1, 1, 1);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
cleanup:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_swapchain(void)
{
    IDirect3DSwapChain8 *swapchain1;
    IDirect3DSwapChain8 *swapchain2;
    IDirect3DSwapChain8 *swapchain3;
    IDirect3DSurface8 *backbuffer, *stereo_buffer;
    D3DPRESENT_PARAMETERS d3dpp;
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window, window2;
    HRESULT hr;
    struct device_desc device_desc;

    window = create_window();
    ok(!!window, "Failed to create a window.\n");
    window2 = create_window();
    ok(!!window2, "Failed to create a window.\n");
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, NULL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        goto cleanup;
    }

    backbuffer = (void *)0xdeadbeef;
    /* IDirect3DDevice8::GetBackBuffer crashes if a NULL output pointer is passed. */
    hr = IDirect3DDevice8_GetBackBuffer(device, 1, D3DBACKBUFFER_TYPE_MONO, &backbuffer);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);
    ok(!backbuffer, "The back buffer pointer is %p, expected NULL.\n", backbuffer);

    hr = IDirect3DDevice8_GetBackBuffer(device, 0, D3DBACKBUFFER_TYPE_MONO, &backbuffer);
    ok(SUCCEEDED(hr), "Failed to get back buffer, hr %#lx.\n", hr);
    IDirect3DSurface8_Release(backbuffer);

    /* The back buffer type value is ignored. */
    hr = IDirect3DDevice8_GetBackBuffer(device, 0, D3DBACKBUFFER_TYPE_LEFT, &stereo_buffer);
    ok(SUCCEEDED(hr), "Failed to get the back buffer, hr %#lx.\n", hr);
    ok(stereo_buffer == backbuffer, "Expected left back buffer = %p, got %p.\n", backbuffer, stereo_buffer);
    IDirect3DSurface8_Release(stereo_buffer);
    hr = IDirect3DDevice8_GetBackBuffer(device, 0, D3DBACKBUFFER_TYPE_RIGHT, &stereo_buffer);
    ok(SUCCEEDED(hr), "Failed to get the back buffer, hr %#lx.\n", hr);
    ok(stereo_buffer == backbuffer, "Expected right back buffer = %p, got %p.\n", backbuffer, stereo_buffer);
    IDirect3DSurface8_Release(stereo_buffer);
    hr = IDirect3DDevice8_GetBackBuffer(device, 0, (D3DBACKBUFFER_TYPE)0xdeadbeef, &stereo_buffer);
    ok(SUCCEEDED(hr), "Failed to get the back buffer, hr %#lx.\n", hr);
    ok(stereo_buffer == backbuffer, "Expected unknown buffer = %p, got %p.\n", backbuffer, stereo_buffer);
    IDirect3DSurface8_Release(stereo_buffer);

    memset(&d3dpp, 0, sizeof(d3dpp));
    d3dpp.Windowed = TRUE;
    d3dpp.SwapEffect = D3DSWAPEFFECT_DISCARD;
    d3dpp.BackBufferFormat = D3DFMT_A8R8G8B8;

    /* Create a bunch of swapchains */
    d3dpp.BackBufferCount = 0;
    hr = IDirect3DDevice8_CreateAdditionalSwapChain(device, &d3dpp, &swapchain1);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);
    ok(!d3dpp.BackBufferWidth, "Got unexpected BackBufferWidth %u.\n", d3dpp.BackBufferWidth);
    ok(!d3dpp.BackBufferHeight, "Got unexpected BackBufferHeight %u.\n", d3dpp.BackBufferHeight);
    ok(d3dpp.BackBufferFormat == D3DFMT_A8R8G8B8, "Got unexpected BackBufferFormat %#x.\n", d3dpp.BackBufferFormat);
    ok(d3dpp.BackBufferCount == 1, "Got unexpected BackBufferCount %u.\n", d3dpp.BackBufferCount);
    ok(!d3dpp.hDeviceWindow, "Got unexpected hDeviceWindow %p.\n", d3dpp.hDeviceWindow);

    d3dpp.hDeviceWindow = NULL;
    d3dpp.BackBufferCount  = 1;
    hr = IDirect3DDevice8_CreateAdditionalSwapChain(device, &d3dpp, &swapchain2);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    d3dpp.BackBufferCount  = 2;
    hr = IDirect3DDevice8_CreateAdditionalSwapChain(device, &d3dpp, &swapchain3);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);
    if(SUCCEEDED(hr)) {
        /* Swapchain 3, created with backbuffercount 2 */
        hr = IDirect3DSwapChain8_GetBackBuffer(swapchain3, 0, 0, NULL);
        ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);

        backbuffer = (void *) 0xdeadbeef;
        hr = IDirect3DSwapChain8_GetBackBuffer(swapchain3, 0, 0, &backbuffer);
        ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);
        ok(backbuffer != NULL && backbuffer != (void *) 0xdeadbeef, "The back buffer is %p\n", backbuffer);
        if(backbuffer && backbuffer != (void *) 0xdeadbeef) IDirect3DSurface8_Release(backbuffer);

        /* The back buffer type value is ignored. */
        hr = IDirect3DSwapChain8_GetBackBuffer(swapchain3, 0, D3DBACKBUFFER_TYPE_LEFT, &stereo_buffer);
        ok(SUCCEEDED(hr), "Failed to get the back buffer, hr %#lx.\n", hr);
        ok(stereo_buffer == backbuffer, "Expected left back buffer = %p, got %p.\n", backbuffer, stereo_buffer);
        IDirect3DSurface8_Release(stereo_buffer);
        hr = IDirect3DSwapChain8_GetBackBuffer(swapchain3, 0, D3DBACKBUFFER_TYPE_RIGHT, &stereo_buffer);
        ok(SUCCEEDED(hr), "Failed to get the back buffer, hr %#lx.\n", hr);
        ok(stereo_buffer == backbuffer, "Expected right back buffer = %p, got %p.\n", backbuffer, stereo_buffer);
        IDirect3DSurface8_Release(stereo_buffer);
        hr = IDirect3DSwapChain8_GetBackBuffer(swapchain3, 0, (D3DBACKBUFFER_TYPE)0xdeadbeef, &stereo_buffer);
        ok(SUCCEEDED(hr), "Failed to get the back buffer, hr %#lx.\n", hr);
        ok(stereo_buffer == backbuffer, "Expected unknown buffer = %p, got %p.\n", backbuffer, stereo_buffer);
        IDirect3DSurface8_Release(stereo_buffer);

        backbuffer = (void *) 0xdeadbeef;
        hr = IDirect3DSwapChain8_GetBackBuffer(swapchain3, 1, 0, &backbuffer);
        ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);
        ok(backbuffer != NULL && backbuffer != (void *) 0xdeadbeef, "The back buffer is %p\n", backbuffer);
        if(backbuffer && backbuffer != (void *) 0xdeadbeef) IDirect3DSurface8_Release(backbuffer);

        backbuffer = (void *) 0xdeadbeef;
        hr = IDirect3DSwapChain8_GetBackBuffer(swapchain3, 2, 0, &backbuffer);
        ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);
        ok(backbuffer == (void *) 0xdeadbeef, "The back buffer pointer was modified (%p)\n", backbuffer);
        if(backbuffer && backbuffer != (void *) 0xdeadbeef) IDirect3DSurface8_Release(backbuffer);

        backbuffer = (void *) 0xdeadbeef;
        hr = IDirect3DSwapChain8_GetBackBuffer(swapchain3, 3, 0, &backbuffer);
        ok(FAILED(hr), "Got hr %#lx.\n", hr);
        ok(backbuffer == (void *) 0xdeadbeef, "The back buffer pointer was modified (%p)\n", backbuffer);
        if(backbuffer && backbuffer != (void *) 0xdeadbeef) IDirect3DSurface8_Release(backbuffer);
    }

    /* Check the back buffers of the swapchains */
    /* Swapchain 1, created with backbuffercount 0 */
    hr = IDirect3DSwapChain8_GetBackBuffer(swapchain1, 0, D3DBACKBUFFER_TYPE_MONO, &backbuffer);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);
    ok(!!backbuffer, "Expected a non-NULL backbuffer.\n");
    if(backbuffer) IDirect3DSurface8_Release(backbuffer);

    backbuffer = (void *) 0xdeadbeef;
    hr = IDirect3DSwapChain8_GetBackBuffer(swapchain1, 1, 0, &backbuffer);
    ok(FAILED(hr), "Got hr %#lx.\n", hr);
    ok(backbuffer == (void *) 0xdeadbeef, "The back buffer pointer was modified (%p)\n", backbuffer);
    if(backbuffer && backbuffer != (void *) 0xdeadbeef) IDirect3DSurface8_Release(backbuffer);

    /* Swapchain 2 - created with backbuffercount 1 */
    backbuffer = (void *) 0xdeadbeef;
    hr = IDirect3DSwapChain8_GetBackBuffer(swapchain2, 0, 0, &backbuffer);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);
    ok(backbuffer != NULL && backbuffer != (void *) 0xdeadbeef, "The back buffer is %p\n", backbuffer);
    if(backbuffer && backbuffer != (void *) 0xdeadbeef) IDirect3DSurface8_Release(backbuffer);

    backbuffer = (void *) 0xdeadbeef;
    hr = IDirect3DSwapChain8_GetBackBuffer(swapchain2, 1, 0, &backbuffer);
    ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);
    ok(backbuffer == (void *) 0xdeadbeef, "The back buffer pointer was modified (%p)\n", backbuffer);
    if(backbuffer && backbuffer != (void *) 0xdeadbeef) IDirect3DSurface8_Release(backbuffer);

    backbuffer = (void *) 0xdeadbeef;
    hr = IDirect3DSwapChain8_GetBackBuffer(swapchain2, 2, 0, &backbuffer);
    ok(FAILED(hr), "Got hr %#lx.\n", hr);
    ok(backbuffer == (void *) 0xdeadbeef, "The back buffer pointer was modified (%p)\n", backbuffer);
    if(backbuffer && backbuffer != (void *) 0xdeadbeef) IDirect3DSurface8_Release(backbuffer);

    IDirect3DSwapChain8_Release(swapchain3);
    IDirect3DSwapChain8_Release(swapchain2);
    IDirect3DSwapChain8_Release(swapchain1);

    d3dpp.Windowed = FALSE;
    d3dpp.hDeviceWindow = window;
    d3dpp.BackBufferCount = 1;
    hr = IDirect3DDevice8_CreateAdditionalSwapChain(device, &d3dpp, &swapchain1);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx\n", hr);
    d3dpp.hDeviceWindow = window2;
    hr = IDirect3DDevice8_CreateAdditionalSwapChain(device, &d3dpp, &swapchain1);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx\n", hr);

    device_desc.width = registry_mode.dmPelsWidth;
    device_desc.height = registry_mode.dmPelsHeight;
    device_desc.device_window = window;
    device_desc.flags = CREATE_DEVICE_FULLSCREEN;
    hr = reset_device(device, &device_desc);
    ok(SUCCEEDED(hr), "Failed to reset device, hr %#lx.\n", hr);

    d3dpp.hDeviceWindow = window;
    hr = IDirect3DDevice8_CreateAdditionalSwapChain(device, &d3dpp, &swapchain1);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx\n", hr);
    d3dpp.hDeviceWindow = window2;
    hr = IDirect3DDevice8_CreateAdditionalSwapChain(device, &d3dpp, &swapchain1);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx\n", hr);
    d3dpp.Windowed = TRUE;
    d3dpp.hDeviceWindow = window;
    hr = IDirect3DDevice8_CreateAdditionalSwapChain(device, &d3dpp, &swapchain1);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx\n", hr);
    d3dpp.hDeviceWindow = window2;
    hr = IDirect3DDevice8_CreateAdditionalSwapChain(device, &d3dpp, &swapchain1);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx\n", hr);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
cleanup:
    IDirect3D8_Release(d3d);
    DestroyWindow(window2);
    DestroyWindow(window);
}

static void test_refcount(void)
{
    IDirect3DVertexBuffer8      *pVertexBuffer      = NULL;
    IDirect3DIndexBuffer8       *pIndexBuffer       = NULL;
    DWORD                       dVertexShader       = -1;
    DWORD                       dPixelShader        = -1;
    IDirect3DCubeTexture8       *pCubeTexture       = NULL;
    IDirect3DTexture8           *pTexture           = NULL;
    IDirect3DVolumeTexture8     *pVolumeTexture     = NULL;
    IDirect3DVolume8            *pVolumeLevel       = NULL;
    IDirect3DSurface8           *pStencilSurface    = NULL;
    IDirect3DSurface8           *pImageSurface      = NULL;
    IDirect3DSurface8           *pRenderTarget      = NULL;
    IDirect3DSurface8           *pRenderTarget2     = NULL;
    IDirect3DSurface8           *pRenderTarget3     = NULL;
    IDirect3DSurface8           *pTextureLevel      = NULL;
    IDirect3DSurface8           *pBackBuffer        = NULL;
    DWORD                       dStateBlock         = -1;
    IDirect3DSwapChain8         *pSwapChain         = NULL;
    D3DCAPS8                    caps;
    D3DPRESENT_PARAMETERS        d3dpp;
    IDirect3DDevice8 *device = NULL;
    ULONG refcount = 0, tmp;
    IDirect3D8 *d3d, *d3d2;
    HWND window;
    HRESULT hr;

    DWORD decl[] =
    {
        D3DVSD_STREAM(0),
        D3DVSD_REG(D3DVSDE_POSITION, D3DVSDT_FLOAT3),  /* D3DVSDE_POSITION, Register v0 */
        D3DVSD_REG(D3DVSDE_DIFFUSE, D3DVSDT_D3DCOLOR), /* D3DVSDE_DIFFUSE, Register v5 */
        D3DVSD_END()
    };

    window = create_window();
    ok(!!window, "Failed to create a window.\n");
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");

    CHECK_REFCOUNT(d3d, 1);

    if (!(device = create_device(d3d, window, NULL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        goto cleanup;
    }

    IDirect3DDevice8_GetDeviceCaps(device, &caps);

    refcount = get_refcount((IUnknown *)device);
    ok(refcount == 1, "Got unexpected refcount %lu.\n", refcount);

    CHECK_REFCOUNT(d3d, 2);

    hr = IDirect3DDevice8_GetDirect3D(device, &d3d2);
    CHECK_CALL(hr, "GetDirect3D", device, refcount);

    ok(d3d2 == d3d, "Expected IDirect3D8 pointers to be equal.\n");
    CHECK_REFCOUNT(d3d, 3);
    CHECK_RELEASE_REFCOUNT(d3d, 2);

    /**
     * Check refcount of implicit surfaces. Findings:
     *   - the container is the device
     *   - they hold a reference to the device
     *   - they are created with a refcount of 0 (Get/Release returns original refcount)
     *   - they are not freed if refcount reaches 0.
     *   - the refcount is not forwarded to the container.
     */
    hr = IDirect3DDevice8_GetRenderTarget(device, &pRenderTarget);
    CHECK_CALL(hr, "GetRenderTarget", device, ++refcount);
    if (pRenderTarget)
    {
        CHECK_SURFACE_CONTAINER(pRenderTarget, IID_IDirect3DDevice8, device);
        CHECK_REFCOUNT(pRenderTarget, 1);

        CHECK_ADDREF_REFCOUNT(pRenderTarget, 2);
        CHECK_REFCOUNT(device, refcount);
        CHECK_RELEASE_REFCOUNT(pRenderTarget, 1);
        CHECK_REFCOUNT(device, refcount);

        hr = IDirect3DDevice8_GetRenderTarget(device, &pRenderTarget);
        CHECK_CALL(hr, "GetRenderTarget", device, refcount);
        CHECK_REFCOUNT(pRenderTarget, 2);
        CHECK_RELEASE_REFCOUNT( pRenderTarget, 1);
        CHECK_RELEASE_REFCOUNT( pRenderTarget, 0);
        CHECK_REFCOUNT(device, --refcount);

        /* The render target is released with the device, so AddRef with refcount=0 is fine here. */
        CHECK_ADDREF_REFCOUNT(pRenderTarget, 1);
        CHECK_REFCOUNT(device, ++refcount);
        CHECK_RELEASE_REFCOUNT(pRenderTarget, 0);
        CHECK_REFCOUNT(device, --refcount);
        CHECK_RELEASE_REFCOUNT(pRenderTarget, 0);
        CHECK_RELEASE_REFCOUNT(pRenderTarget, 0);
    }

    /* Render target and back buffer are identical. */
    hr = IDirect3DDevice8_GetBackBuffer(device, 0, 0, &pBackBuffer);
    CHECK_CALL(hr, "GetBackBuffer", device, ++refcount);
    if (pBackBuffer)
    {
        CHECK_RELEASE_REFCOUNT(pBackBuffer, 0);
        ok(pRenderTarget == pBackBuffer, "RenderTarget=%p and BackBuffer=%p should be the same.\n",
                pRenderTarget, pBackBuffer);
        CHECK_RELEASE_REFCOUNT(pBackBuffer, 0);
        CHECK_RELEASE_REFCOUNT(pBackBuffer, 0);
        pBackBuffer = NULL;
    }
    CHECK_REFCOUNT(device, --refcount);

    hr = IDirect3DDevice8_GetDepthStencilSurface(device, &pStencilSurface);
    CHECK_CALL(hr, "GetDepthStencilSurface", device, ++refcount);
    if (pStencilSurface)
    {
        CHECK_SURFACE_CONTAINER(pStencilSurface, IID_IDirect3DDevice8, device);
        CHECK_REFCOUNT(pStencilSurface, 1);

        CHECK_ADDREF_REFCOUNT(pStencilSurface, 2);
        CHECK_REFCOUNT(device, refcount);
        CHECK_RELEASE_REFCOUNT(pStencilSurface, 1);
        CHECK_REFCOUNT(device, refcount);

        CHECK_RELEASE_REFCOUNT( pStencilSurface, 0);
        CHECK_REFCOUNT(device, --refcount);

        /* The stencil surface is released with the device, so AddRef with refcount=0 is fine here. */
        CHECK_ADDREF_REFCOUNT(pStencilSurface, 1);
        CHECK_REFCOUNT(device, ++refcount);
        CHECK_RELEASE_REFCOUNT(pStencilSurface, 0);
        CHECK_REFCOUNT(device, --refcount);
        CHECK_RELEASE_REFCOUNT(pStencilSurface, 0);
        CHECK_RELEASE_REFCOUNT(pStencilSurface, 0);
        pStencilSurface = NULL;
    }

    /* Buffers */
    hr = IDirect3DDevice8_CreateIndexBuffer(device, 16, 0, D3DFMT_INDEX32, D3DPOOL_DEFAULT, &pIndexBuffer);
    CHECK_CALL(hr, "CreateIndexBuffer", device, ++refcount);
    if(pIndexBuffer)
    {
        tmp = get_refcount( (IUnknown *)pIndexBuffer );

        hr = IDirect3DDevice8_SetIndices(device, pIndexBuffer, 0);
        CHECK_CALL( hr, "SetIndices", pIndexBuffer, tmp);
        hr = IDirect3DDevice8_SetIndices(device, NULL, 0);
        CHECK_CALL( hr, "SetIndices", pIndexBuffer, tmp);
    }

    hr = IDirect3DDevice8_CreateVertexBuffer(device, 16, 0, D3DFVF_XYZ, D3DPOOL_DEFAULT, &pVertexBuffer);
    CHECK_CALL(hr, "CreateVertexBuffer", device, ++refcount);
    if(pVertexBuffer)
    {
        IDirect3DVertexBuffer8 *pVBuf = (void*)~0;
        UINT stride = ~0;

        tmp = get_refcount( (IUnknown *)pVertexBuffer );

        hr = IDirect3DDevice8_SetStreamSource(device, 0, pVertexBuffer, 3 * sizeof(float));
        CHECK_CALL( hr, "SetStreamSource", pVertexBuffer, tmp);
        hr = IDirect3DDevice8_SetStreamSource(device, 0, NULL, 0);
        CHECK_CALL( hr, "SetStreamSource", pVertexBuffer, tmp);

        hr = IDirect3DDevice8_GetStreamSource(device, 0, &pVBuf, &stride);
        ok(SUCCEEDED(hr), "GetStreamSource did not succeed with NULL stream!\n");
        ok(pVBuf==NULL, "pVBuf not NULL (%p)!\n", pVBuf);
        ok(stride==3*sizeof(float), "stride not 3 floats (got %u)!\n", stride);
    }

    /* Shaders */
    hr = IDirect3DDevice8_CreateVertexShader(device, decl, simple_vs, &dVertexShader, 0);
    CHECK_CALL(hr, "CreateVertexShader", device, refcount);
    if (caps.PixelShaderVersion >= D3DPS_VERSION(1, 0))
    {
        hr = IDirect3DDevice8_CreatePixelShader(device, simple_ps, &dPixelShader);
        CHECK_CALL(hr, "CreatePixelShader", device, refcount);
    }
    /* Textures */
    hr = IDirect3DDevice8_CreateTexture(device, 32, 32, 3, 0, D3DFMT_X8R8G8B8, D3DPOOL_DEFAULT, &pTexture);
    CHECK_CALL(hr, "CreateTexture", device, ++refcount);
    if (pTexture)
    {
        tmp = get_refcount( (IUnknown *)pTexture );

        /* SetTexture should not increase refcounts */
        hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *) pTexture);
        CHECK_CALL( hr, "SetTexture", pTexture, tmp);
        hr = IDirect3DDevice8_SetTexture(device, 0, NULL);
        CHECK_CALL( hr, "SetTexture", pTexture, tmp);

        /* This should not increment device refcount */
        hr = IDirect3DTexture8_GetSurfaceLevel( pTexture, 1, &pTextureLevel );
        CHECK_CALL(hr, "GetSurfaceLevel", device, refcount);
        /* But should increment texture's refcount */
        CHECK_REFCOUNT( pTexture, tmp+1 );
        /* Because the texture and surface refcount are identical */
        if (pTextureLevel)
        {
            CHECK_REFCOUNT        ( pTextureLevel, tmp+1 );
            CHECK_ADDREF_REFCOUNT ( pTextureLevel, tmp+2 );
            CHECK_REFCOUNT        ( pTexture     , tmp+2 );
            CHECK_RELEASE_REFCOUNT( pTextureLevel, tmp+1 );
            CHECK_REFCOUNT        ( pTexture     , tmp+1 );
            CHECK_RELEASE_REFCOUNT( pTexture     , tmp   );
            CHECK_REFCOUNT        ( pTextureLevel, tmp   );
        }
    }
    if(caps.TextureCaps & D3DPTEXTURECAPS_CUBEMAP)
    {
        hr = IDirect3DDevice8_CreateCubeTexture(device, 32, 0, 0, D3DFMT_X8R8G8B8, D3DPOOL_DEFAULT, &pCubeTexture);
        CHECK_CALL(hr, "CreateCubeTexture", device, ++refcount);
    }
    else
    {
        skip("Cube textures not supported\n");
    }
    if(caps.TextureCaps & D3DPTEXTURECAPS_VOLUMEMAP)
    {
        hr = IDirect3DDevice8_CreateVolumeTexture(device, 32, 32, 2, 0, 0,
                D3DFMT_X8R8G8B8, D3DPOOL_DEFAULT, &pVolumeTexture);
        CHECK_CALL(hr, "CreateVolumeTexture", device, ++refcount);
    }
    else
    {
        skip("Volume textures not supported\n");
    }

    if (pVolumeTexture)
    {
        tmp = get_refcount( (IUnknown *)pVolumeTexture );

        /* This should not increment device refcount */
        hr = IDirect3DVolumeTexture8_GetVolumeLevel(pVolumeTexture, 0, &pVolumeLevel);
        CHECK_CALL(hr, "GetVolumeLevel", device, refcount);
        /* But should increment volume texture's refcount */
        CHECK_REFCOUNT( pVolumeTexture, tmp+1 );
        /* Because the volume texture and volume refcount are identical */
        if (pVolumeLevel)
        {
            CHECK_REFCOUNT        ( pVolumeLevel  , tmp+1 );
            CHECK_ADDREF_REFCOUNT ( pVolumeLevel  , tmp+2 );
            CHECK_REFCOUNT        ( pVolumeTexture, tmp+2 );
            CHECK_RELEASE_REFCOUNT( pVolumeLevel  , tmp+1 );
            CHECK_REFCOUNT        ( pVolumeTexture, tmp+1 );
            CHECK_RELEASE_REFCOUNT( pVolumeTexture, tmp   );
            CHECK_REFCOUNT        ( pVolumeLevel  , tmp   );
        }
    }
    /* Surfaces */
    hr = IDirect3DDevice8_CreateDepthStencilSurface(device, 32, 32,
            D3DFMT_D16, D3DMULTISAMPLE_NONE, &pStencilSurface);
    CHECK_CALL(hr, "CreateDepthStencilSurface", device, ++refcount);
    CHECK_REFCOUNT( pStencilSurface, 1);
    hr = IDirect3DDevice8_CreateImageSurface(device, 32, 32,
            D3DFMT_X8R8G8B8, &pImageSurface);
    CHECK_CALL(hr, "CreateImageSurface", device, ++refcount);
    CHECK_REFCOUNT( pImageSurface, 1);
    hr = IDirect3DDevice8_CreateRenderTarget(device, 32, 32,
            D3DFMT_X8R8G8B8, D3DMULTISAMPLE_NONE, TRUE, &pRenderTarget3);
    CHECK_CALL(hr, "CreateRenderTarget", device, ++refcount);
    CHECK_REFCOUNT( pRenderTarget3, 1);
    /* Misc */
    hr = IDirect3DDevice8_CreateStateBlock(device, D3DSBT_ALL, &dStateBlock);
    CHECK_CALL(hr, "CreateStateBlock", device, refcount);

    memset(&d3dpp, 0, sizeof(d3dpp));
    d3dpp.Windowed = TRUE;
    d3dpp.SwapEffect = D3DSWAPEFFECT_DISCARD;
    d3dpp.BackBufferFormat = D3DFMT_A8R8G8B8;
    d3dpp.EnableAutoDepthStencil = TRUE;
    d3dpp.AutoDepthStencilFormat = D3DFMT_D16;
    hr = IDirect3DDevice8_CreateAdditionalSwapChain(device, &d3dpp, &pSwapChain);
    CHECK_CALL(hr, "CreateAdditionalSwapChain", device, ++refcount);
    if(pSwapChain)
    {
        /* check implicit back buffer */
        hr = IDirect3DSwapChain8_GetBackBuffer(pSwapChain, 0, 0, &pBackBuffer);
        CHECK_CALL(hr, "GetBackBuffer", device, ++refcount);
        CHECK_REFCOUNT( pSwapChain, 1);
        if(pBackBuffer)
        {
            CHECK_SURFACE_CONTAINER(pBackBuffer, IID_IDirect3DDevice8, device);
            CHECK_REFCOUNT( pBackBuffer, 1);
            CHECK_RELEASE_REFCOUNT( pBackBuffer, 0);
            CHECK_REFCOUNT(device, --refcount);

            /* The back buffer is released with the swapchain, so AddRef with refcount=0 is fine here. */
            CHECK_ADDREF_REFCOUNT(pBackBuffer, 1);
            CHECK_REFCOUNT(device, ++refcount);
            CHECK_RELEASE_REFCOUNT(pBackBuffer, 0);
            CHECK_REFCOUNT(device, --refcount);
            CHECK_RELEASE_REFCOUNT(pBackBuffer, 0);
            CHECK_RELEASE_REFCOUNT(pBackBuffer, 0);
            pBackBuffer = NULL;
        }
        CHECK_REFCOUNT( pSwapChain, 1);
    }

    if(pVertexBuffer)
    {
        BYTE *data;
        /* Vertex buffers can be locked multiple times */
        hr = IDirect3DVertexBuffer8_Lock(pVertexBuffer, 0, 0, &data, 0);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
        hr = IDirect3DVertexBuffer8_Lock(pVertexBuffer, 0, 0, &data, 0);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
        hr = IDirect3DVertexBuffer8_Unlock(pVertexBuffer);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
        hr = IDirect3DVertexBuffer8_Unlock(pVertexBuffer);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    }

    /* The implicit render target is not freed if refcount reaches 0.
     * Otherwise GetRenderTarget would re-allocate it and the pointer would change.*/
    hr = IDirect3DDevice8_GetRenderTarget(device, &pRenderTarget2);
    CHECK_CALL(hr, "GetRenderTarget", device, ++refcount);
    if (pRenderTarget2)
    {
        CHECK_RELEASE_REFCOUNT(pRenderTarget2, 0);
        ok(pRenderTarget == pRenderTarget2, "RenderTarget=%p and RenderTarget2=%p should be the same.\n",
                pRenderTarget, pRenderTarget2);
        CHECK_REFCOUNT(device, --refcount);
        CHECK_RELEASE_REFCOUNT(pRenderTarget2, 0);
        CHECK_RELEASE_REFCOUNT(pRenderTarget2, 0);
        pRenderTarget2 = NULL;
    }
    pRenderTarget = NULL;

cleanup:
    CHECK_RELEASE(device,               device, --refcount);

    /* Buffers */
    CHECK_RELEASE(pVertexBuffer,        device, --refcount);
    CHECK_RELEASE(pIndexBuffer,         device, --refcount);
    /* Shaders */
    if (dVertexShader != ~0u)
        IDirect3DDevice8_DeleteVertexShader(device, dVertexShader);
    if (dPixelShader != ~0u)
        IDirect3DDevice8_DeletePixelShader(device, dPixelShader);
    /* Textures */
    CHECK_RELEASE(pTexture,             device, --refcount);
    /* Releasing a texture that has no references left returns 0. */
    if (pTexture)
    {
        CHECK_RELEASE_REFCOUNT(pTexture, 0);
        CHECK_RELEASE_REFCOUNT(pTexture, 0);
    }
    CHECK_RELEASE(pCubeTexture,         device, --refcount);
    CHECK_RELEASE(pVolumeTexture,       device, --refcount);
    /* Surfaces */
    CHECK_RELEASE(pStencilSurface,      device, --refcount);
    CHECK_RELEASE(pImageSurface,        device, --refcount);
    CHECK_RELEASE(pRenderTarget3,       device, --refcount);
    /* Misc */
    if (dStateBlock != ~0u)
        IDirect3DDevice8_DeleteStateBlock(device, dStateBlock);
    /* This will destroy device - cannot check the refcount here */
    if (pSwapChain)
        CHECK_RELEASE_REFCOUNT(pSwapChain, 0);
    CHECK_RELEASE_REFCOUNT(d3d, 0);
    DestroyWindow(window);
}

static void test_checkdevicemultisampletype(void)
{
    IDirect3D8 *d3d;
    HWND window;
    HRESULT hr;

    window = create_window();
    ok(!!window, "Failed to create a window.\n");
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");

    if (IDirect3D8_CheckDeviceMultiSampleType(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            D3DFMT_X8R8G8B8, TRUE, D3DMULTISAMPLE_2_SAMPLES) == D3DERR_NOTAVAILABLE)
    {
        skip("Multisampling not supported for D3DFMT_X8R8G8B8, skipping test.\n");
        goto cleanup;
    }

    hr = IDirect3D8_CheckDeviceMultiSampleType(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            D3DFMT_UNKNOWN, TRUE, D3DMULTISAMPLE_NONE);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3D8_CheckDeviceMultiSampleType(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            65536, TRUE, D3DMULTISAMPLE_NONE);
    todo_wine ok(SUCCEEDED(hr), "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3D8_CheckDeviceMultiSampleType(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            D3DFMT_X8R8G8B8, TRUE, D3DMULTISAMPLE_NONE);
    ok(SUCCEEDED(hr), "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3D8_CheckDeviceMultiSampleType(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            D3DFMT_X8R8G8B8, FALSE, D3DMULTISAMPLE_NONE);
    ok(SUCCEEDED(hr), "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3D8_CheckDeviceMultiSampleType(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            D3DFMT_X8R8G8B8, TRUE, D3DMULTISAMPLE_2_SAMPLES);
    ok(SUCCEEDED(hr), "Got unexpected hr %#lx.\n", hr);

    /* We assume D3DMULTISAMPLE_15_SAMPLES is never supported in practice. */
    hr = IDirect3D8_CheckDeviceMultiSampleType(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            D3DFMT_X8R8G8B8, TRUE, D3DMULTISAMPLE_15_SAMPLES);
    ok(hr == D3DERR_NOTAVAILABLE, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3D8_CheckDeviceMultiSampleType(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            D3DFMT_X8R8G8B8, TRUE, 65536);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3D8_CheckDeviceMultiSampleType(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            D3DFMT_DXT5, TRUE, D3DMULTISAMPLE_2_SAMPLES);
    ok(hr == D3DERR_NOTAVAILABLE, "Got unexpected hr %#lx.\n", hr);

cleanup:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_invalid_multisample(void)
{
    IDirect3DDevice8 *device;
    IDirect3DSurface8 *rt;
    IDirect3D8 *d3d;
    BOOL available;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    window = create_window();
    ok(!!window, "Failed to create a window.\n");
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");

    if (!(device = create_device(d3d, window, NULL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        goto cleanup;
    }

    available = SUCCEEDED(IDirect3D8_CheckDeviceMultiSampleType(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            D3DFMT_X8R8G8B8, TRUE, D3DMULTISAMPLE_2_SAMPLES));

    hr = IDirect3DDevice8_CreateRenderTarget(device, 128, 128,
            D3DFMT_X8R8G8B8, D3DMULTISAMPLE_2_SAMPLES, FALSE, &rt);
    if (available)
    {
        ok(SUCCEEDED(hr), "Got unexpected hr %#lx.\n", hr);
        IDirect3DSurface8_Release(rt);
    }
    else
    {
        ok(hr == D3DERR_NOTAVAILABLE, "Got unexpected hr %#lx.\n", hr);
    }

    /* We assume D3DMULTISAMPLE_15_SAMPLES is never supported in practice. */
    available = SUCCEEDED(IDirect3D8_CheckDeviceMultiSampleType(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            D3DFMT_X8R8G8B8, TRUE, D3DMULTISAMPLE_15_SAMPLES));
    hr = IDirect3DDevice8_CreateRenderTarget(device, 128, 128,
            D3DFMT_X8R8G8B8, D3DMULTISAMPLE_15_SAMPLES, FALSE, &rt);
    if (available)
    {
        ok(SUCCEEDED(hr), "Got unexpected hr %#lx.\n", hr);
        IDirect3DSurface8_Release(rt);
    }
    else
    {
        ok(hr == D3DERR_NOTAVAILABLE, "Got unexpected hr %#lx.\n", hr);
    }

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
cleanup:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_cursor(void)
{
    unsigned int adapter_idx, adapter_count, test_idx;
    IDirect3DSurface8 *cursor = NULL;
    struct device_desc device_desc;
    unsigned int width, height;
    IDirect3DDevice8 *device;
    HRESULT expected_hr, hr;
    D3DDISPLAYMODE mode;
    CURSORINFO info;
    IDirect3D8 *d3d;
    ULONG refcount;
    HCURSOR cur;
    HWND window;
    BOOL ret;

    static const DWORD device_flags[] = {0, CREATE_DEVICE_FULLSCREEN};
    static const SIZE cursor_sizes[] =
    {
        {1, 1},
        {2, 4},
        {3, 2},
        {2, 3},
        {6, 6},
    };

    window = create_window();
    ok(!!window, "Failed to create a window.\n");

    ret = SetCursorPos(50, 50);
    ok(ret, "Failed to set cursor position.\n");
    flush_events();

    memset(&info, 0, sizeof(info));
    info.cbSize = sizeof(info);
    ok(GetCursorInfo(&info), "GetCursorInfo failed\n");
    cur = info.hCursor;

    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, NULL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        goto cleanup;
    }

    hr = IDirect3DDevice8_CreateImageSurface(device, 32, 32, D3DFMT_A8R8G8B8, &cursor);
    ok(SUCCEEDED(hr), "Failed to create cursor surface, hr %#lx.\n", hr);

    /* Initially hidden */
    ret = IDirect3DDevice8_ShowCursor(device, TRUE);
    ok(!ret, "IDirect3DDevice8_ShowCursor returned %d\n", ret);

    /* Not enabled without a surface*/
    ret = IDirect3DDevice8_ShowCursor(device, TRUE);
    ok(!ret, "IDirect3DDevice8_ShowCursor returned %d\n", ret);

    /* Fails */
    hr = IDirect3DDevice8_SetCursorProperties(device, 0, 0, NULL);
    ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetCursorProperties(device, 0, 0, cursor);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    IDirect3DSurface8_Release(cursor);

    /* On the testbot the cursor handle does not behave as expected in rare situations,
     * leading to random test failures. Either the cursor handle changes before we expect
     * it to, or it doesn't change afterwards (or already changed before we read the
     * initial handle?). I was not able to reproduce this on my own machines. Moving the
     * mouse outside the window results in similar behavior. However, I tested various
     * obvious failure causes: Was the mouse moved? Was the window hidden or moved? Is
     * the window in the background? Neither of those applies. Making the window topmost
     * or using a fullscreen device doesn't improve the test's reliability either. */
    memset(&info, 0, sizeof(info));
    info.cbSize = sizeof(info);
    ok(GetCursorInfo(&info), "GetCursorInfo failed\n");
    ok(info.flags & (CURSOR_SHOWING | CURSOR_SUPPRESSED), "Got cursor flags %#lx.\n", info.flags);
    ok(info.hCursor == cur || broken(1), "The cursor handle is %p\n", info.hCursor); /* unchanged */

    /* Still hidden */
    ret = IDirect3DDevice8_ShowCursor(device, TRUE);
    ok(!ret, "IDirect3DDevice8_ShowCursor returned %d\n", ret);

    /* Enabled now*/
    ret = IDirect3DDevice8_ShowCursor(device, TRUE);
    ok(ret, "IDirect3DDevice8_ShowCursor returned %d\n", ret);

    memset(&info, 0, sizeof(info));
    info.cbSize = sizeof(info);
    ok(GetCursorInfo(&info), "GetCursorInfo failed\n");
    ok(info.flags & (CURSOR_SHOWING | CURSOR_SUPPRESSED), "Got cursor flags %#lx.\n", info.flags);
    ok(info.hCursor != cur || broken(1), "The cursor handle is %p\n", info.hCursor);

    /* Cursor dimensions must all be powers of two */
    for (test_idx = 0; test_idx < ARRAY_SIZE(cursor_sizes); ++test_idx)
    {
        width = cursor_sizes[test_idx].cx;
        height = cursor_sizes[test_idx].cy;
        hr = IDirect3DDevice8_CreateImageSurface(device, width, height, D3DFMT_A8R8G8B8, &cursor);
        ok(hr == D3D_OK, "Test %u: CreateImageSurface failed, hr %#lx.\n", test_idx, hr);
        hr = IDirect3DDevice8_SetCursorProperties(device, 0, 0, cursor);
        if (width && !(width & (width - 1)) && height && !(height & (height - 1)))
            expected_hr = D3D_OK;
        else
            expected_hr = D3DERR_INVALIDCALL;
        ok(hr == expected_hr, "Test %u: Expect SetCursorProperties return %#lx, got %#lx.\n",
                test_idx, expected_hr, hr);
        IDirect3DSurface8_Release(cursor);
    }

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);

    /* Cursor dimensions must not exceed adapter display mode */
    device_desc.device_window = window;
    device_desc.width = 640;
    device_desc.height = 480;

    adapter_count = IDirect3D8_GetAdapterCount(d3d);
    for (adapter_idx = 0; adapter_idx < adapter_count; ++adapter_idx)
    {
        for (test_idx = 0; test_idx < ARRAY_SIZE(device_flags); ++test_idx)
        {
            device_desc.adapter_ordinal = adapter_idx;
            device_desc.flags = device_flags[test_idx];
            if (!(device = create_device(d3d, window, &device_desc)))
            {
                skip("Adapter %u test %u: Failed to create a D3D device.\n", adapter_idx, test_idx);
                break;
            }

            hr = IDirect3D8_GetAdapterDisplayMode(d3d, adapter_idx, &mode);
            ok(hr == D3D_OK, "Adapter %u test %u: GetAdapterDisplayMode failed, hr %#lx.\n",
                    adapter_idx, test_idx, hr);

            /* Find the largest width and height that are powers of two and less than the display mode */
            width = 1;
            height = 1;
            while (width * 2 <= mode.Width)
                width *= 2;
            while (height * 2 <= mode.Height)
                height *= 2;

            hr = IDirect3DDevice8_CreateImageSurface(device, width, height, D3DFMT_A8R8G8B8, &cursor);
            ok(hr == D3D_OK, "Adapter %u test %u: CreateImageSurface failed, hr %#lx.\n",
                    adapter_idx, test_idx, hr);
            hr = IDirect3DDevice8_SetCursorProperties(device, 0, 0, cursor);
            ok(hr == D3D_OK, "Adapter %u test %u: SetCursorProperties failed, hr %#lx.\n",
                    adapter_idx, test_idx, hr);
            IDirect3DSurface8_Release(cursor);

            hr = IDirect3DDevice8_CreateImageSurface(device, width * 2, height, D3DFMT_A8R8G8B8,
                    &cursor);
            ok(hr == D3D_OK, "Adapter %u test %u: CreateImageSurface failed, hr %#lx.\n",
                    adapter_idx, test_idx, hr);
            hr = IDirect3DDevice8_SetCursorProperties(device, 0, 0, cursor);
            ok(hr == D3DERR_INVALIDCALL, "Adapter %u test %u: Got hr %#lx.\n", adapter_idx, test_idx, hr);
            IDirect3DSurface8_Release(cursor);

            hr = IDirect3DDevice8_CreateImageSurface(device, width, height * 2, D3DFMT_A8R8G8B8,
                    &cursor);
            ok(hr == D3D_OK, "Adapter %u test %u: CreateImageSurface failed, hr %#lx.\n",
                    adapter_idx, test_idx, hr);
            hr = IDirect3DDevice8_SetCursorProperties(device, 0, 0, cursor);
            ok(hr == D3DERR_INVALIDCALL, "Adapter %u test %u: Got hr %#lx.\n", adapter_idx, test_idx, hr);
            IDirect3DSurface8_Release(cursor);

            refcount = IDirect3DDevice8_Release(device);
            ok(!refcount, "Adapter %u: Device has %lu references left.\n", adapter_idx, refcount);
        }
    }
cleanup:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static const POINT *expect_pos;

static LRESULT CALLBACK test_cursor_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam)
{
    if (message == WM_MOUSEMOVE)
    {
        if (expect_pos && expect_pos->x && expect_pos->y)
        {
            POINT p = {GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};

            ClientToScreen(window, &p);
            if (expect_pos->x == p.x && expect_pos->y == p.y)
                ++expect_pos;
        }
    }

    return DefWindowProcA(window, message, wparam, lparam);
}

static void test_cursor_pos(void)
{
    IDirect3DSurface8 *cursor;
    IDirect3DDevice8 *device;
    WNDCLASSA wc = {0};
    IDirect3D8 *d3d8;
    UINT refcount;
    HWND window;
    HRESULT hr;
    BOOL ret;
    POINT pt;

    /* Note that we don't check for movement we're not supposed to receive.
     * That's because it's hard to distinguish from the user accidentally
     * moving the mouse. */
    static const POINT points[] =
    {
        {50, 50},
        {75, 75},
        {100, 100},
        {125, 125},
        {150, 150},
        {125, 125},
        {150, 150},
        {150, 150},
        {0, 0},
    };

    /* Windows 10 1709 is unreliable. One or more of the cursor movements we
     * expect don't show up. Moving the mouse to a defined position beforehand
     * seems to get it into better shape - only the final 150x150 move we do
     * below is missing - it looks as if this Windows version filters redundant
     * SetCursorPos calls on the user32 level, although I am not entirely sure.
     *
     * The weird thing is that the previous test leaves the cursor position
     * reliably at 512x384 on the testbot. So the 50x50 mouse move shouldn't
     * be stripped away anyway, but it might be a difference between moving the
     * cursor through SetCursorPos vs moving it by changing the display mode. */
    ret = SetCursorPos(99, 99);
    ok(ret, "Failed to set cursor position.\n");
    flush_events();

    /* Check if we can move the cursor. If we're running in a virtual desktop
     * that does not have focus or the mouse is outside the desktop window, some
     * window managers (e.g. kwin) will refuse to let us steal the pointer. That
     * is reasonable, but breaks the test. */
    ret = GetCursorPos(&pt);
    ok(ret, "Failed to get cursor position.\n");
    if (pt.x != 99 || pt.y != 99)
    {
        skip("Could not warp the cursor (cur pos %ld,%ld), skipping test.\n", pt.x, pt.y);
        return;
    }

    wc.lpfnWndProc = test_cursor_proc;
    wc.lpszClassName = "d3d8_test_cursor_wc";
    ok(RegisterClassA(&wc), "Failed to register window class.\n");
    window = CreateWindowA("d3d8_test_cursor_wc", "d3d8_test", WS_POPUP | WS_SYSMENU,
            0, 0, 320, 240, NULL, NULL, NULL, NULL);
    ShowWindow(window, SW_SHOW);
    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");

    if (!(device = create_device(d3d8, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    hr = IDirect3DDevice8_CreateImageSurface(device, 32, 32, D3DFMT_A8R8G8B8, &cursor);
    ok(SUCCEEDED(hr), "Failed to create cursor surface, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetCursorProperties(device, 0, 0, cursor);
    ok(SUCCEEDED(hr), "Failed to set cursor properties, hr %#lx.\n", hr);
    IDirect3DSurface8_Release(cursor);
    ret = IDirect3DDevice8_ShowCursor(device, TRUE);
    ok(!ret, "Failed to show cursor, hr %#x.\n", ret);

    flush_events();
    expect_pos = points;

    ret = SetCursorPos(50, 50);
    ok(ret, "Failed to set cursor position.\n");
    flush_events();

    IDirect3DDevice8_SetCursorPosition(device, 75, 75, 0);
    flush_events();
    /* SetCursorPosition() eats duplicates. FIXME: Since we accept unexpected
     * mouse moves the test doesn't actually demonstrate that. */
    IDirect3DDevice8_SetCursorPosition(device, 75, 75, 0);
    flush_events();

    ret = SetCursorPos(100, 100);
    ok(ret, "Failed to set cursor position.\n");
    flush_events();
    /* Even if the position was set with SetCursorPos(). */
    IDirect3DDevice8_SetCursorPosition(device, 100, 100, 0);
    flush_events();

    IDirect3DDevice8_SetCursorPosition(device, 125, 125, 0);
    flush_events();
    ret = SetCursorPos(150, 150);
    ok(ret, "Failed to set cursor position.\n");
    flush_events();
    IDirect3DDevice8_SetCursorPosition(device, 125, 125, 0);
    flush_events();

    IDirect3DDevice8_SetCursorPosition(device, 150, 150, 0);
    flush_events();
    /* SetCursorPos() doesn't. Except for Win10 1709. */
    ret = SetCursorPos(150, 150);
    ok(ret, "Failed to set cursor position.\n");
    flush_events();

    ok((!expect_pos->x && !expect_pos->y) || broken(expect_pos - points == 7),
        "Didn't receive MOUSEMOVE %u (%ld, %ld).\n",
        (unsigned)(expect_pos - points), expect_pos->x, expect_pos->y);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %u references left.\n", refcount);
done:
    DestroyWindow(window);
    UnregisterClassA("d3d8_test_cursor_wc", GetModuleHandleA(NULL));
    IDirect3D8_Release(d3d8);
}

static void test_states(void)
{
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    window = create_window();
    ok(!!window, "Failed to create a window.\n");
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, NULL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        goto cleanup;
    }

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZVISIBLE, TRUE);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZVISIBLE, FALSE);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
cleanup:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_shader_versions(void)
{
    IDirect3D8 *d3d;
    D3DCAPS8 caps;
    HRESULT hr;

    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");

    hr = IDirect3D8_GetDeviceCaps(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, &caps);
    ok(SUCCEEDED(hr) || hr == D3DERR_NOTAVAILABLE, "Failed to get device caps, hr %#lx.\n", hr);
    IDirect3D8_Release(d3d);
    if (FAILED(hr))
    {
        skip("No Direct3D support, skipping test.\n");
        return;
    }

    ok(caps.VertexShaderVersion <= D3DVS_VERSION(1,1),
            "Got unexpected VertexShaderVersion %#lx.\n", caps.VertexShaderVersion);
    ok(caps.PixelShaderVersion <= D3DPS_VERSION(1,4),
            "Got unexpected PixelShaderVersion %#lx.\n", caps.PixelShaderVersion);
}

static void test_display_formats(void)
{
    D3DDEVTYPE device_type = D3DDEVTYPE_HAL;
    unsigned int backbuffer, display;
    unsigned int windowed, i;
    D3DDISPLAYMODE mode;
    IDirect3D8 *d3d8;
    BOOL should_pass;
    BOOL has_modes;
    HRESULT hr;

    static const struct
    {
        const char *name;
        D3DFORMAT format;
        D3DFORMAT alpha_format;
        BOOL display;
        BOOL windowed;
    }
    formats[] =
    {
        {"D3DFMT_R5G6B5",   D3DFMT_R5G6B5,      0,                  TRUE,   TRUE},
        {"D3DFMT_X1R5G5B5", D3DFMT_X1R5G5B5,    D3DFMT_A1R5G5B5,    TRUE,   TRUE},
        {"D3DFMT_A1R5G5B5", D3DFMT_A1R5G5B5,    D3DFMT_A1R5G5B5,    FALSE,  FALSE},
        {"D3DFMT_X8R8G8B8", D3DFMT_X8R8G8B8,    D3DFMT_A8R8G8B8,    TRUE,   TRUE},
        {"D3DFMT_A8R8G8B8", D3DFMT_A8R8G8B8,    D3DFMT_A8R8G8B8,    FALSE,  FALSE},
        {"D3DFMT_UNKNOWN",  D3DFMT_UNKNOWN,     0,                  FALSE,  FALSE},
    };

    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");

    for (display = 0; display < ARRAY_SIZE(formats); ++display)
    {
        for (i = 0, has_modes = FALSE; SUCCEEDED(IDirect3D8_EnumAdapterModes(d3d8, D3DADAPTER_DEFAULT, i, &mode)); ++i)
        {
            if (mode.Format == formats[display].format)
            {
                has_modes = TRUE;
                break;
            }
        }

        for (windowed = 0; windowed <= 1; ++windowed)
        {
            for (backbuffer = 0; backbuffer < ARRAY_SIZE(formats); ++backbuffer)
            {
                should_pass = FALSE;

                if (formats[display].display && (formats[display].windowed || !windowed) && (has_modes || windowed))
                {
                    D3DFORMAT backbuffer_format;

                    if (windowed && formats[backbuffer].format == D3DFMT_UNKNOWN)
                        backbuffer_format = formats[display].format;
                    else
                        backbuffer_format = formats[backbuffer].format;

                    hr = IDirect3D8_CheckDeviceFormat(d3d8, D3DADAPTER_DEFAULT, device_type, formats[display].format,
                            D3DUSAGE_RENDERTARGET, D3DRTYPE_SURFACE, backbuffer_format);
                    should_pass = (hr == D3D_OK) && (formats[display].format == formats[backbuffer].format
                            || (formats[display].alpha_format
                            && formats[display].alpha_format == formats[backbuffer].alpha_format));
                }

                hr = IDirect3D8_CheckDeviceType(d3d8, D3DADAPTER_DEFAULT, device_type,
                        formats[display].format, formats[backbuffer].format, windowed);
                ok(SUCCEEDED(hr) == should_pass || broken(SUCCEEDED(hr) && !has_modes) /* Win8 64-bit */,
                        "Got unexpected hr %#lx for %s / %s, windowed %#x, should_pass %#x.\n",
                        hr, formats[display].name, formats[backbuffer].name, windowed, should_pass);
            }
        }
    }

    IDirect3D8_Release(d3d8);
}

/* Test adapter display modes */
static void test_display_modes(void)
{
    UINT max_modes, i;
    D3DDISPLAYMODE dmode;
    IDirect3D8 *d3d;
    HRESULT res;

    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");

    max_modes = IDirect3D8_GetAdapterModeCount(d3d, D3DADAPTER_DEFAULT);
    ok(max_modes > 0 ||
       broken(max_modes == 0), /* VMware */
       "GetAdapterModeCount(D3DADAPTER_DEFAULT) returned 0!\n");

    for (i = 0; i < max_modes; ++i)
    {
        res = IDirect3D8_EnumAdapterModes(d3d, D3DADAPTER_DEFAULT, i, &dmode);
        ok(res==D3D_OK, "EnumAdapterModes returned %#08lx for mode %u!\n", res, i);
        if(res != D3D_OK)
            continue;

        ok(dmode.Format==D3DFMT_X8R8G8B8 || dmode.Format==D3DFMT_R5G6B5,
           "Unexpected display mode returned for mode %u: %#x\n", i , dmode.Format);
    }

    IDirect3D8_Release(d3d);
}

struct mode
{
    unsigned int w;
    unsigned int h;
};

static int compare_mode(const void *a, const void *b)
{
    const struct mode *mode_a = a;
    const struct mode *mode_b = b;
    int w = mode_a->w - mode_b->w;
    int h = mode_a->h - mode_b->h;
    return abs(w) >= abs(h) ? -w : -h;
}

static void test_reset(void)
{
    UINT width, orig_width = GetSystemMetrics(SM_CXSCREEN);
    UINT height, orig_height = GetSystemMetrics(SM_CYSCREEN);
    IDirect3DDevice8 *device1 = NULL;
    IDirect3DDevice8 *device2 = NULL;
    struct device_desc device_desc;
    D3DDISPLAYMODE d3ddm, d3ddm2;
    D3DSURFACE_DESC surface_desc;
    D3DPRESENT_PARAMETERS d3dpp;
    IDirect3DSurface8 *surface;
    IDirect3DTexture8 *texture;
    IDirect3DVertexBuffer8 *vb;
    IDirect3DIndexBuffer8 *ib;
    UINT adapter_mode_count;
    D3DLOCKED_RECT lockrect;
    UINT mode_count = 0;
    DEVMODEW devmode;
    IDirect3D8 *d3d8;
    RECT winrect, client_rect;
    D3DVIEWPORT8 vp;
    ULONG refcount;
    D3DCAPS8 caps;
    DWORD shader;
    DWORD value;
    HWND window;
    HRESULT hr;
    LONG ret;
    UINT i;

    static const DWORD decl[] =
    {
        D3DVSD_STREAM(0),
        D3DVSD_REG(D3DVSDE_POSITION,  D3DVSDT_FLOAT4),
        D3DVSD_END(),
    };

    struct mode *modes = NULL;

    window = CreateWindowA("d3d8_test_wc", "d3d8_test", WS_OVERLAPPEDWINDOW,
            100, 100, 160, 160, NULL, NULL, NULL, NULL);
    ok(!!window, "Failed to create a window.\n");
    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");

    hr = IDirect3D8_GetAdapterDisplayMode(d3d8, D3DADAPTER_DEFAULT, &d3ddm);
    ok(SUCCEEDED(hr), "GetAdapterDisplayMode failed, hr %#lx.\n", hr);
    adapter_mode_count = IDirect3D8_GetAdapterModeCount(d3d8, D3DADAPTER_DEFAULT);
    modes = malloc(sizeof(*modes) * adapter_mode_count);
    for (i = 0; i < adapter_mode_count; ++i)
    {
        UINT j;

        memset(&d3ddm2, 0, sizeof(d3ddm2));
        hr = IDirect3D8_EnumAdapterModes(d3d8, D3DADAPTER_DEFAULT, i, &d3ddm2);
        ok(SUCCEEDED(hr), "EnumAdapterModes failed, hr %#lx.\n", hr);

        if (d3ddm2.Format != d3ddm.Format)
            continue;

        for (j = 0; j < mode_count; ++j)
        {
            if (modes[j].w == d3ddm2.Width && modes[j].h == d3ddm2.Height)
                break;
        }
        if (j == mode_count)
        {
            modes[j].w = d3ddm2.Width;
            modes[j].h = d3ddm2.Height;
            ++mode_count;
        }

        /* We use them as invalid modes. */
        if ((d3ddm2.Width == 801 && d3ddm2.Height == 600)
                || (d3ddm2.Width == 32 && d3ddm2.Height == 32))
        {
            skip("This system supports a screen resolution of %dx%d, not running mode tests.\n",
                    d3ddm2.Width, d3ddm2.Height);
            goto cleanup;
        }
    }

    if (mode_count < 2)
    {
        skip("Less than 2 modes supported, skipping mode tests.\n");
        goto cleanup;
    }

    /* Prefer higher resolutions. */
    qsort(modes, mode_count, sizeof(*modes), compare_mode);

    i = 0;
    if (modes[i].w == orig_width && modes[i].h == orig_height) ++i;

    device_desc.adapter_ordinal = D3DADAPTER_DEFAULT;
    device_desc.width = modes[i].w;
    device_desc.height = modes[i].h;
    device_desc.device_window = window;
    device_desc.flags = CREATE_DEVICE_FULLSCREEN | CREATE_DEVICE_SWVP_ONLY;
    if (!(device1 = create_device(d3d8, window, &device_desc)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto cleanup;
    }
    hr = IDirect3DDevice8_TestCooperativeLevel(device1);
    /* This skips the test on testbot Win 8 VMs. */
    if (hr == D3DERR_DEVICELOST)
    {
        skip("Device is lost.\n");
        goto cleanup;
    }
    ok(SUCCEEDED(hr), "TestCooperativeLevel failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetDeviceCaps(device1, &caps);
    ok(SUCCEEDED(hr), "GetDeviceCaps failed, hr %#lx.\n", hr);

    width = GetSystemMetrics(SM_CXSCREEN);
    height = GetSystemMetrics(SM_CYSCREEN);
    ok(width == modes[i].w, "Screen width is %u, expected %u.\n", width, modes[i].w);
    ok(height == modes[i].h, "Screen height is %u, expected %u.\n", height, modes[i].h);

    hr = IDirect3DDevice8_GetViewport(device1, &vp);
    ok(SUCCEEDED(hr), "GetViewport failed, hr %#lx.\n", hr);
    ok(vp.X == 0, "D3DVIEWPORT->X = %lu, expected 0.\n", vp.X);
    ok(vp.Y == 0, "D3DVIEWPORT->Y = %lu, expected 0.\n", vp.Y);
    ok(vp.Width == modes[i].w, "D3DVIEWPORT->Width = %lu, expected %u.\n", vp.Width, modes[i].w);
    ok(vp.Height == modes[i].h, "D3DVIEWPORT->Height = %lu, expected %u.\n", vp.Height, modes[i].h);
    ok(vp.MinZ == 0, "D3DVIEWPORT->MinZ = %.8e, expected 0.\n", vp.MinZ);
    ok(vp.MaxZ == 1, "D3DVIEWPORT->MaxZ = %.8e, expected 1.\n", vp.MaxZ);

    i = 1;
    vp.X = 10;
    vp.Y = 20;
    vp.Width = modes[i].w  / 2;
    vp.Height = modes[i].h / 2;
    vp.MinZ = 0.2f;
    vp.MaxZ = 0.3f;
    hr = IDirect3DDevice8_SetViewport(device1, &vp);
    ok(SUCCEEDED(hr), "SetViewport failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetRenderState(device1, D3DRS_LIGHTING, &value);
    ok(SUCCEEDED(hr), "Failed to get render state, hr %#lx.\n", hr);
    ok(!!value, "Got unexpected value %#lx for D3DRS_LIGHTING.\n", value);
    hr = IDirect3DDevice8_SetRenderState(device1, D3DRS_LIGHTING, FALSE);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);

    memset(&d3dpp, 0, sizeof(d3dpp));
    d3dpp.SwapEffect = D3DSWAPEFFECT_DISCARD;
    d3dpp.Windowed = FALSE;
    d3dpp.BackBufferWidth = modes[i].w;
    d3dpp.BackBufferHeight = modes[i].h;
    d3dpp.BackBufferFormat = d3ddm.Format;
    hr = IDirect3DDevice8_Reset(device1, &d3dpp);
    ok(SUCCEEDED(hr), "Reset failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_TestCooperativeLevel(device1);
    ok(SUCCEEDED(hr), "TestCooperativeLevel failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetRenderState(device1, D3DRS_LIGHTING, &value);
    ok(SUCCEEDED(hr), "Failed to get render state, hr %#lx.\n", hr);
    ok(!!value, "Got unexpected value %#lx for D3DRS_LIGHTING.\n", value);

    memset(&vp, 0, sizeof(vp));
    hr = IDirect3DDevice8_GetViewport(device1, &vp);
    ok(SUCCEEDED(hr), "GetViewport failed, hr %#lx.\n", hr);
    ok(vp.X == 0, "D3DVIEWPORT->X = %lu, expected 0.\n", vp.X);
    ok(vp.Y == 0, "D3DVIEWPORT->Y = %lu, expected 0.\n", vp.Y);
    ok(vp.Width == modes[i].w, "D3DVIEWPORT->Width = %lu, expected %u.\n", vp.Width, modes[i].w);
    ok(vp.Height == modes[i].h, "D3DVIEWPORT->Height = %lu, expected %u.\n", vp.Height, modes[i].h);
    ok(vp.MinZ == 0, "D3DVIEWPORT->MinZ = %.8e, expected 0.\n", vp.MinZ);
    ok(vp.MaxZ == 1, "D3DVIEWPORT->MaxZ = %.8e, expected 1.\n", vp.MaxZ);

    width = GetSystemMetrics(SM_CXSCREEN);
    height = GetSystemMetrics(SM_CYSCREEN);
    ok(width == modes[i].w, "Screen width is %u, expected %u.\n", width, modes[i].w);
    ok(height == modes[i].h, "Screen height is %u, expected %u.\n", height, modes[i].h);

    hr = IDirect3DDevice8_GetRenderTarget(device1, &surface);
    ok(SUCCEEDED(hr), "GetRenderTarget failed, hr %#lx.\n", hr);
    hr = IDirect3DSurface8_GetDesc(surface, &surface_desc);
    ok(hr == D3D_OK, "GetDesc failed, hr %#lx.\n", hr);
    ok(surface_desc.Width == modes[i].w, "Back buffer width is %u, expected %u.\n",
            surface_desc.Width, modes[i].w);
    ok(surface_desc.Height == modes[i].h, "Back buffer height is %u, expected %u.\n",
            surface_desc.Height, modes[i].h);
    IDirect3DSurface8_Release(surface);

    memset(&d3dpp, 0, sizeof(d3dpp));
    d3dpp.SwapEffect = D3DSWAPEFFECT_DISCARD;
    d3dpp.Windowed = TRUE;
    d3dpp.BackBufferWidth = 400;
    d3dpp.BackBufferHeight = 300;
    d3dpp.BackBufferFormat = D3DFMT_A8R8G8B8;
    hr = IDirect3DDevice8_Reset(device1, &d3dpp);
    ok(SUCCEEDED(hr), "Reset failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_TestCooperativeLevel(device1);
    ok(SUCCEEDED(hr), "TestCooperativeLevel failed, hr %#lx.\n", hr);

    memset(&vp, 0, sizeof(vp));
    hr = IDirect3DDevice8_GetViewport(device1, &vp);
    ok(SUCCEEDED(hr), "GetViewport failed, hr %#lx.\n", hr);
    ok(vp.X == 0, "D3DVIEWPORT->X = %lu, expected 0.\n", vp.X);
    ok(vp.Y == 0, "D3DVIEWPORT->Y = %lu, expected 0.\n", vp.Y);
    ok(vp.Width == 400, "D3DVIEWPORT->Width = %lu, expected 400.\n", vp.Width);
    ok(vp.Height == 300, "D3DVIEWPORT->Height = %lu, expected 300.\n", vp.Height);
    ok(vp.MinZ == 0, "D3DVIEWPORT->MinZ = %.8e, expected 0.\n", vp.MinZ);
    ok(vp.MaxZ == 1, "D3DVIEWPORT->MaxZ = %.8e, expected 1.\n", vp.MaxZ);

    width = GetSystemMetrics(SM_CXSCREEN);
    height = GetSystemMetrics(SM_CYSCREEN);
    ok(width == orig_width, "Screen width is %u, expected %u.\n", width, orig_width);
    ok(height == orig_height, "Screen height is %u, expected %u.\n", height, orig_height);

    hr = IDirect3DDevice8_GetRenderTarget(device1, &surface);
    ok(SUCCEEDED(hr), "GetRenderTarget failed, hr %#lx.\n", hr);
    hr = IDirect3DSurface8_GetDesc(surface, &surface_desc);
    ok(hr == D3D_OK, "GetDesc failed, hr %#lx.\n", hr);
    ok(surface_desc.Width == 400, "Back buffer width is %u, expected 400.\n",
            surface_desc.Width);
    ok(surface_desc.Height == 300, "Back buffer height is %u, expected 300.\n",
            surface_desc.Height);
    IDirect3DSurface8_Release(surface);

    memset(&devmode, 0, sizeof(devmode));
    devmode.dmSize = sizeof(devmode);
    devmode.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT;
    devmode.dmPelsWidth = modes[1].w;
    devmode.dmPelsHeight = modes[1].h;
    ret = ChangeDisplaySettingsW(&devmode, CDS_FULLSCREEN);
    ok(ret == DISP_CHANGE_SUCCESSFUL, "Failed to change display mode, ret %#lx.\n", ret);
    width = GetSystemMetrics(SM_CXSCREEN);
    height = GetSystemMetrics(SM_CYSCREEN);
    ok(width == modes[1].w, "Screen width is %u, expected %u.\n", width, modes[1].w);
    ok(height == modes[1].h, "Screen height is %u, expected %u.\n", height, modes[1].h);

    d3dpp.BackBufferWidth  = 500;
    d3dpp.BackBufferHeight = 400;
    d3dpp.BackBufferFormat = D3DFMT_A8R8G8B8;
    hr = IDirect3DDevice8_Reset(device1, &d3dpp);
    ok(SUCCEEDED(hr), "Reset failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_TestCooperativeLevel(device1);
    ok(SUCCEEDED(hr), "TestCooperativeLevel failed, hr %#lx.\n", hr);

    width = GetSystemMetrics(SM_CXSCREEN);
    height = GetSystemMetrics(SM_CYSCREEN);
    ok(width == modes[1].w, "Screen width is %u, expected %u.\n", width, modes[1].w);
    ok(height == modes[1].h, "Screen height is %u, expected %u.\n", height, modes[1].h);

    ZeroMemory(&vp, sizeof(vp));
    hr = IDirect3DDevice8_GetViewport(device1, &vp);
    ok(SUCCEEDED(hr), "GetViewport failed, hr %#lx.\n", hr);
    ok(vp.X == 0, "D3DVIEWPORT->X = %ld.\n", vp.X);
    ok(vp.Y == 0, "D3DVIEWPORT->Y = %ld.\n", vp.Y);
    ok(vp.Width == 500, "D3DVIEWPORT->Width = %ld.\n", vp.Width);
    ok(vp.Height == 400, "D3DVIEWPORT->Height = %ld.\n", vp.Height);
    ok(vp.MinZ == 0, "D3DVIEWPORT->MinZ = %f.\n", vp.MinZ);
    ok(vp.MaxZ == 1, "D3DVIEWPORT->MaxZ = %f.\n", vp.MaxZ);

    hr = IDirect3DDevice8_GetRenderTarget(device1, &surface);
    ok(SUCCEEDED(hr), "GetRenderTarget failed, hr %#lx.\n", hr);
    hr = IDirect3DSurface8_GetDesc(surface, &surface_desc);
    ok(hr == D3D_OK, "GetDesc failed, hr %#lx.\n", hr);
    ok(surface_desc.Width == 500, "Back buffer width is %u, expected 500.\n",
            surface_desc.Width);
    ok(surface_desc.Height == 400, "Back buffer height is %u, expected 400.\n",
            surface_desc.Height);
    IDirect3DSurface8_Release(surface);

    devmode.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT;
    devmode.dmPelsWidth = orig_width;
    devmode.dmPelsHeight = orig_height;
    ret = ChangeDisplaySettingsW(&devmode, CDS_FULLSCREEN);
    ok(ret == DISP_CHANGE_SUCCESSFUL, "Failed to change display mode, ret %#lx.\n", ret);
    width = GetSystemMetrics(SM_CXSCREEN);
    height = GetSystemMetrics(SM_CYSCREEN);
    ok(width == orig_width, "Got screen width %u, expected %u.\n", width, orig_width);
    ok(height == orig_height, "Got screen height %u, expected %u.\n", height, orig_height);

    winrect.left = 0;
    winrect.top = 0;
    winrect.right = 200;
    winrect.bottom = 150;
    ok(AdjustWindowRect(&winrect, WS_OVERLAPPEDWINDOW, FALSE), "AdjustWindowRect failed\n");
    ok(SetWindowPos(window, NULL, 0, 0,
                    winrect.right-winrect.left,
                    winrect.bottom-winrect.top,
                    SWP_NOMOVE|SWP_NOZORDER),
       "SetWindowPos failed\n");

    /* Windows 10 gives us a different size than we requested with some DPI scaling settings (e.g. 172%). */
    GetClientRect(window, &client_rect);

    memset(&d3dpp, 0, sizeof(d3dpp));
    d3dpp.SwapEffect = D3DSWAPEFFECT_DISCARD;
    d3dpp.Windowed = TRUE;
    d3dpp.BackBufferWidth = 0;
    d3dpp.BackBufferHeight = 0;
    d3dpp.BackBufferFormat = d3ddm.Format;
    hr = IDirect3DDevice8_Reset(device1, &d3dpp);
    ok(SUCCEEDED(hr), "Reset failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_TestCooperativeLevel(device1);
    ok(SUCCEEDED(hr), "TestCooperativeLevel failed, hr %#lx.\n", hr);

    ok(!d3dpp.BackBufferWidth, "Got unexpected BackBufferWidth %u.\n", d3dpp.BackBufferWidth);
    ok(!d3dpp.BackBufferHeight, "Got unexpected BackBufferHeight %u.\n", d3dpp.BackBufferHeight);
    ok(d3dpp.BackBufferFormat == d3ddm.Format, "Got unexpected BackBufferFormat %#x, expected %#x.\n",
            d3dpp.BackBufferFormat, d3ddm.Format);
    ok(d3dpp.BackBufferCount == 1, "Got unexpected BackBufferCount %u.\n", d3dpp.BackBufferCount);
    ok(!d3dpp.MultiSampleType, "Got unexpected MultiSampleType %u.\n", d3dpp.MultiSampleType);
    ok(d3dpp.SwapEffect == D3DSWAPEFFECT_DISCARD, "Got unexpected SwapEffect %#x.\n", d3dpp.SwapEffect);
    ok(!d3dpp.hDeviceWindow, "Got unexpected hDeviceWindow %p.\n", d3dpp.hDeviceWindow);
    ok(d3dpp.Windowed, "Got unexpected Windowed %#x.\n", d3dpp.Windowed);
    ok(!d3dpp.EnableAutoDepthStencil, "Got unexpected EnableAutoDepthStencil %#x.\n", d3dpp.EnableAutoDepthStencil);
    ok(!d3dpp.AutoDepthStencilFormat, "Got unexpected AutoDepthStencilFormat %#x.\n", d3dpp.AutoDepthStencilFormat);
    ok(!d3dpp.Flags, "Got unexpected Flags %#lx.\n", d3dpp.Flags);
    ok(!d3dpp.FullScreen_RefreshRateInHz, "Got unexpected FullScreen_RefreshRateInHz %u.\n",
            d3dpp.FullScreen_RefreshRateInHz);
    ok(!d3dpp.FullScreen_PresentationInterval, "Got unexpected FullScreen_PresentationInterval %#x.\n",
            d3dpp.FullScreen_PresentationInterval);

    memset(&vp, 0, sizeof(vp));
    hr = IDirect3DDevice8_GetViewport(device1, &vp);
    ok(SUCCEEDED(hr), "GetViewport failed, hr %#lx.\n", hr);
    if (SUCCEEDED(hr))
    {
        ok(vp.X == 0, "D3DVIEWPORT->X = %lu, expected 0.\n", vp.X);
        ok(vp.Y == 0, "D3DVIEWPORT->Y = %lu, expected 0.\n", vp.Y);
        ok(vp.Width == client_rect.right, "D3DVIEWPORT->Width = %ld, expected %ld.\n",
                vp.Width, client_rect.right);
        ok(vp.Height == client_rect.bottom, "D3DVIEWPORT->Height = %ld, expected %ld.\n",
                vp.Height, client_rect.bottom);
        ok(vp.MinZ == 0, "D3DVIEWPORT->MinZ = %.8e, expected 0.\n", vp.MinZ);
        ok(vp.MaxZ == 1, "D3DVIEWPORT->MaxZ = %.8e, expected 1.\n", vp.MaxZ);
    }

    hr = IDirect3DDevice8_GetRenderTarget(device1, &surface);
    ok(SUCCEEDED(hr), "GetRenderTarget failed, hr %#lx.\n", hr);
    hr = IDirect3DSurface8_GetDesc(surface, &surface_desc);
    ok(hr == D3D_OK, "GetDesc failed, hr %#lx.\n", hr);
    ok(surface_desc.Format == d3ddm.Format, "Got unexpected Format %#x, expected %#x.\n",
            surface_desc.Format, d3ddm.Format);
    ok(!surface_desc.MultiSampleType, "Got unexpected MultiSampleType %u.\n", d3dpp.MultiSampleType);
    ok(surface_desc.Width == client_rect.right,
            "Back buffer width is %u, expected %ld.\n", surface_desc.Width, client_rect.right);
    ok(surface_desc.Height == client_rect.bottom,
            "Back buffer height is %u, expected %ld.\n", surface_desc.Height, client_rect.bottom);
    IDirect3DSurface8_Release(surface);

    memset(&d3dpp, 0, sizeof(d3dpp));
    d3dpp.SwapEffect = D3DSWAPEFFECT_DISCARD;
    d3dpp.Windowed = TRUE;
    d3dpp.BackBufferWidth = 400;
    d3dpp.BackBufferHeight = 300;
    d3dpp.BackBufferFormat = d3ddm.Format;

    /* Reset fails if there is a resource in the default pool. */
    hr = IDirect3DDevice8_CreateTexture(device1, 16, 16, 1, 0, D3DFMT_R5G6B5, D3DPOOL_DEFAULT, &texture);
    ok(SUCCEEDED(hr), "CreateTexture failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Reset(device1, &d3dpp);
    ok(hr == D3DERR_DEVICELOST, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_TestCooperativeLevel(device1);
    ok(hr == D3DERR_DEVICENOTRESET, "Got hr %#lx.\n", hr);
    IDirect3DTexture8_Release(texture);
    /* Reset again to get the device out of the lost state. */
    hr = IDirect3DDevice8_Reset(device1, &d3dpp);
    ok(SUCCEEDED(hr), "Reset failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_TestCooperativeLevel(device1);
    ok(SUCCEEDED(hr), "TestCooperativeLevel failed, hr %#lx.\n", hr);

    if (caps.TextureCaps & D3DPTEXTURECAPS_VOLUMEMAP)
    {
        IDirect3DVolumeTexture8 *volume_texture;

        hr = IDirect3DDevice8_CreateVolumeTexture(device1, 16, 16, 4, 1, 0,
                D3DFMT_R5G6B5, D3DPOOL_DEFAULT, &volume_texture);
        ok(SUCCEEDED(hr), "CreateVolumeTexture failed, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_Reset(device1, &d3dpp);
        ok(hr == D3DERR_DEVICELOST, "Got hr %#lx.\n", hr);
        hr = IDirect3DDevice8_TestCooperativeLevel(device1);
        ok(hr == D3DERR_DEVICENOTRESET, "Got hr %#lx.\n", hr);
        IDirect3DVolumeTexture8_Release(volume_texture);
        hr = IDirect3DDevice8_Reset(device1, &d3dpp);
        ok(SUCCEEDED(hr), "Reset failed, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_TestCooperativeLevel(device1);
        ok(SUCCEEDED(hr), "TestCooperativeLevel failed, hr %#lx.\n", hr);
    }
    else
    {
        skip("Volume textures not supported.\n");
    }

    /* Test with DEFAULT pool resources bound but otherwise not referenced. */
    hr = IDirect3DDevice8_CreateVertexBuffer(device1, 16, 0,
            D3DFVF_XYZ, D3DPOOL_DEFAULT, &vb);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetStreamSource(device1, 0, vb, 16);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    refcount = IDirect3DVertexBuffer8_Release(vb);
    ok(!refcount, "Unexpected refcount %lu.\n", refcount);
    hr = IDirect3DDevice8_CreateIndexBuffer(device1, 16, 0,
            D3DFMT_INDEX16, D3DPOOL_DEFAULT, &ib);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetIndices(device1, ib, 0);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    refcount = IDirect3DIndexBuffer8_Release(ib);
    ok(!refcount, "Unexpected refcount %lu.\n", refcount);
    hr = IDirect3DDevice8_CreateTexture(device1, 16, 16, 0, 0,
            D3DFMT_X8R8G8B8, D3DPOOL_DEFAULT, &texture);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTexture(device1, i, (IDirect3DBaseTexture8 *)texture);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Reset(device1, &d3dpp);
    ok(hr == D3DERR_DEVICELOST, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_TestCooperativeLevel(device1);
    ok(hr == D3DERR_DEVICENOTRESET, "Got unexpected hr %#lx.\n", hr);

    /* Crashes on Windows. */
    if (0)
    {
        hr = IDirect3DDevice8_GetIndices(device1, &ib, &i);
        todo_wine ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);
    }
    refcount = IDirect3DTexture8_Release(texture);
    ok(!refcount, "Unexpected refcount %lu.\n", refcount);

    hr = IDirect3DDevice8_Reset(device1, &d3dpp);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_TestCooperativeLevel(device1);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    /* Scratch, sysmem and managed pool resources are fine. */
    hr = IDirect3DDevice8_CreateTexture(device1, 16, 16, 1, 0, D3DFMT_R5G6B5, D3DPOOL_SCRATCH, &texture);
    ok(SUCCEEDED(hr), "CreateTexture failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Reset(device1, &d3dpp);
    ok(SUCCEEDED(hr), "Reset failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_TestCooperativeLevel(device1);
    ok(SUCCEEDED(hr), "TestCooperativeLevel failed, hr %#lx.\n", hr);
    IDirect3DTexture8_Release(texture);

    hr = IDirect3DDevice8_CreateTexture(device1, 16, 16, 1, 0, D3DFMT_R5G6B5, D3DPOOL_SYSTEMMEM, &texture);
    ok(SUCCEEDED(hr), "CreateTexture failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Reset(device1, &d3dpp);
    ok(SUCCEEDED(hr), "Reset failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_TestCooperativeLevel(device1);
    ok(SUCCEEDED(hr), "TestCooperativeLevel failed, hr %#lx.\n", hr);
    IDirect3DTexture8_Release(texture);

    hr = IDirect3DDevice8_CreateVertexBuffer(device1, 16, 0,
            D3DFVF_XYZ, D3DPOOL_SYSTEMMEM, &vb);
    ok(hr == D3D_OK, "Failed to create vertex buffer, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Reset(device1, &d3dpp);
    ok(hr == D3D_OK, "Failed to reset device, hr %#lx.\n", hr);
    IDirect3DVertexBuffer8_Release(vb);

    hr = IDirect3DDevice8_CreateIndexBuffer(device1, 16, 0,
            D3DFMT_INDEX16, D3DPOOL_SYSTEMMEM, &ib);
    ok(hr == D3D_OK, "Failed to create index buffer, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Reset(device1, &d3dpp);
    ok(hr == D3D_OK, "Failed to reset device, hr %#lx.\n", hr);
    IDirect3DIndexBuffer8_Release(ib);

    /* The depth stencil should get reset to the auto depth stencil when present. */
    hr = IDirect3DDevice8_SetRenderTarget(device1, NULL, NULL);
    ok(SUCCEEDED(hr), "SetRenderTarget failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetDepthStencilSurface(device1, &surface);
    ok(hr == D3DERR_NOTFOUND, "Got hr %#lx.\n", hr);
    ok(!surface, "Depth / stencil buffer should be NULL.\n");

    d3dpp.EnableAutoDepthStencil = TRUE;
    d3dpp.AutoDepthStencilFormat = D3DFMT_D24S8;
    hr = IDirect3DDevice8_Reset(device1, &d3dpp);
    ok(SUCCEEDED(hr), "Reset failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetDepthStencilSurface(device1, &surface);
    ok(SUCCEEDED(hr), "GetDepthStencilSurface failed, hr %#lx.\n", hr);
    ok(!!surface, "Depth / stencil buffer should not be NULL.\n");
    if (surface) IDirect3DSurface8_Release(surface);

    d3dpp.EnableAutoDepthStencil = FALSE;
    hr = IDirect3DDevice8_Reset(device1, &d3dpp);
    ok(SUCCEEDED(hr), "Reset failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetDepthStencilSurface(device1, &surface);
    ok(hr == D3DERR_NOTFOUND, "Got hr %#lx.\n", hr);
    ok(!surface, "Depth / stencil buffer should be NULL.\n");

    /* Will a sysmem or scratch resource survive while locked? */
    hr = IDirect3DDevice8_CreateTexture(device1, 16, 16, 1, 0, D3DFMT_R5G6B5, D3DPOOL_SYSTEMMEM, &texture);
    ok(SUCCEEDED(hr), "CreateTexture failed, hr %#lx.\n", hr);
    hr = IDirect3DTexture8_LockRect(texture, 0, &lockrect, NULL, D3DLOCK_DISCARD);
    ok(SUCCEEDED(hr), "LockRect failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Reset(device1, &d3dpp);
    ok(SUCCEEDED(hr), "Reset failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_TestCooperativeLevel(device1);
    ok(SUCCEEDED(hr), "TestCooperativeLevel failed, hr %#lx.\n", hr);
    IDirect3DTexture8_UnlockRect(texture, 0);
    IDirect3DTexture8_Release(texture);

    hr = IDirect3DDevice8_CreateTexture(device1, 16, 16, 1, 0, D3DFMT_R5G6B5, D3DPOOL_SCRATCH, &texture);
    ok(SUCCEEDED(hr), "CreateTexture failed, hr %#lx.\n", hr);
    hr = IDirect3DTexture8_LockRect(texture, 0, &lockrect, NULL, D3DLOCK_DISCARD);
    ok(SUCCEEDED(hr), "LockRect failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Reset(device1, &d3dpp);
    ok(SUCCEEDED(hr), "Reset failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_TestCooperativeLevel(device1);
    ok(SUCCEEDED(hr), "TestCooperativeLevel failed, hr %#lx.\n", hr);
    IDirect3DTexture8_UnlockRect(texture, 0);
    IDirect3DTexture8_Release(texture);

    hr = IDirect3DDevice8_CreateTexture(device1, 16, 16, 1, 0, D3DFMT_R5G6B5, D3DPOOL_MANAGED, &texture);
    ok(SUCCEEDED(hr), "CreateTexture failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Reset(device1, &d3dpp);
    ok(SUCCEEDED(hr), "Reset failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_TestCooperativeLevel(device1);
    ok(SUCCEEDED(hr), "TestCooperativeLevel failed, hr %#lx.\n", hr);
    IDirect3DTexture8_Release(texture);

    /* A reference held to an implicit surface causes failures as well. */
    hr = IDirect3DDevice8_GetBackBuffer(device1, 0, D3DBACKBUFFER_TYPE_MONO, &surface);
    ok(SUCCEEDED(hr), "GetBackBuffer failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Reset(device1, &d3dpp);
    ok(hr == D3DERR_DEVICELOST, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_TestCooperativeLevel(device1);
    ok(hr == D3DERR_DEVICENOTRESET, "Got hr %#lx.\n", hr);
    IDirect3DSurface8_Release(surface);
    hr = IDirect3DDevice8_Reset(device1, &d3dpp);
    ok(SUCCEEDED(hr), "Reset failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_TestCooperativeLevel(device1);
    ok(SUCCEEDED(hr), "TestCooperativeLevel failed, hr %#lx.\n", hr);

    /* Shaders are fine as well. */
    hr = IDirect3DDevice8_CreateVertexShader(device1, decl, simple_vs, &shader, 0);
    ok(SUCCEEDED(hr), "CreateVertexShader failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Reset(device1, &d3dpp);
    ok(SUCCEEDED(hr), "Reset failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DeleteVertexShader(device1, shader);
    ok(SUCCEEDED(hr), "DeleteVertexShader failed, hr %#lx.\n", hr);

    /* Try setting invalid modes. */
    memset(&d3dpp, 0, sizeof(d3dpp));
    d3dpp.SwapEffect = D3DSWAPEFFECT_DISCARD;
    d3dpp.Windowed = FALSE;
    d3dpp.BackBufferWidth = 32;
    d3dpp.BackBufferHeight = 32;
    d3dpp.BackBufferFormat = d3ddm.Format;
    hr = IDirect3DDevice8_Reset(device1, &d3dpp);
    ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_TestCooperativeLevel(device1);
    ok(hr == D3DERR_DEVICENOTRESET, "Got hr %#lx.\n", hr);

    memset(&d3dpp, 0, sizeof(d3dpp));
    d3dpp.SwapEffect = D3DSWAPEFFECT_DISCARD;
    d3dpp.Windowed = FALSE;
    d3dpp.BackBufferWidth = 801;
    d3dpp.BackBufferHeight = 600;
    d3dpp.BackBufferFormat = d3ddm.Format;
    hr = IDirect3DDevice8_Reset(device1, &d3dpp);
    ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_TestCooperativeLevel(device1);
    ok(hr == D3DERR_DEVICENOTRESET, "Got hr %#lx.\n", hr);

    memset(&d3dpp, 0, sizeof(d3dpp));
    d3dpp.SwapEffect = D3DSWAPEFFECT_DISCARD;
    d3dpp.Windowed = FALSE;
    d3dpp.BackBufferWidth = 0;
    d3dpp.BackBufferHeight = 0;
    d3dpp.BackBufferFormat = d3ddm.Format;
    hr = IDirect3DDevice8_Reset(device1, &d3dpp);
    ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_TestCooperativeLevel(device1);
    ok(hr == D3DERR_DEVICENOTRESET, "Got hr %#lx.\n", hr);

    hr = IDirect3D8_GetAdapterDisplayMode(d3d8, D3DADAPTER_DEFAULT, &d3ddm);
    ok(SUCCEEDED(hr), "GetAdapterDisplayMode failed, hr %#lx.\n", hr);

    memset(&d3dpp, 0, sizeof(d3dpp));
    d3dpp.Windowed = TRUE;
    d3dpp.SwapEffect = D3DSWAPEFFECT_DISCARD;
    d3dpp.BackBufferFormat = d3ddm.Format;
    d3dpp.EnableAutoDepthStencil = FALSE;
    d3dpp.AutoDepthStencilFormat = D3DFMT_D24S8;

    hr = IDirect3D8_CreateDevice(d3d8, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            window, D3DCREATE_SOFTWARE_VERTEXPROCESSING, &d3dpp, &device2);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_TestCooperativeLevel(device2);
    ok(SUCCEEDED(hr), "TestCooperativeLevel failed, hr %#lx.\n", hr);

    d3dpp.Windowed = TRUE;
    d3dpp.SwapEffect = D3DSWAPEFFECT_DISCARD;
    d3dpp.BackBufferWidth = 400;
    d3dpp.BackBufferHeight = 300;
    d3dpp.BackBufferFormat = d3ddm.Format;
    d3dpp.EnableAutoDepthStencil = TRUE;
    d3dpp.AutoDepthStencilFormat = D3DFMT_D24S8;

    hr = IDirect3DDevice8_Reset(device2, &d3dpp);
    ok(SUCCEEDED(hr), "Reset failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetDepthStencilSurface(device2, &surface);
    ok(SUCCEEDED(hr), "GetDepthStencilSurface failed, hr %#lx.\n", hr);
    ok(!!surface, "Depth / stencil buffer should not be NULL.\n");
    IDirect3DSurface8_Release(surface);

cleanup:
    free(modes);
    if (device2)
        IDirect3DDevice8_Release(device2);
    if (device1)
        IDirect3DDevice8_Release(device1);
    IDirect3D8_Release(d3d8);
    DestroyWindow(window);
}

static void test_scene(void)
{
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    window = create_window();
    ok(!!window, "Failed to create a window.\n");
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, NULL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        goto cleanup;
    }

    /* Test an EndScene without BeginScene. Should return an error */
    hr = IDirect3DDevice8_EndScene(device);
    ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);

    /* Test a normal BeginScene / EndScene pair, this should work */
    hr = IDirect3DDevice8_BeginScene(device);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    /* Test another EndScene without having begun a new scene. Should return an error */
    hr = IDirect3DDevice8_EndScene(device);
    ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);

    /* Two nested BeginScene and EndScene calls */
    hr = IDirect3DDevice8_BeginScene(device);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_BeginScene(device);
    ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);

    /* Calling Reset clears scene state. */
    hr = IDirect3DDevice8_BeginScene(device);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    reset_device(device, NULL);
    hr = IDirect3DDevice8_EndScene(device);
    ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    /* StretchRect does not exit in Direct3D8, so no equivalent to the d3d9 stretchrect tests */

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
cleanup:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_shader(void)
{
    DWORD                        hPixelShader = 0, hVertexShader = 0;
    DWORD                        hPixelShader2 = 0, hVertexShader2 = 0;
    DWORD                        hTempHandle;
    D3DCAPS8                     caps;
    DWORD fvf = D3DFVF_XYZ | D3DFVF_DIFFUSE;
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d;
    DWORD data_size;
    ULONG refcount;
    HWND window;
    HRESULT hr;
    void *data;

    static DWORD dwVertexDecl[] =
    {
        D3DVSD_STREAM(0),
        D3DVSD_REG(D3DVSDE_POSITION,  D3DVSDT_FLOAT3),
        D3DVSD_END()
    };
    DWORD decl_normal_float2[] =
    {
        D3DVSD_STREAM(0),
        D3DVSD_REG(D3DVSDE_POSITION, D3DVSDT_FLOAT3),  /* D3DVSDE_POSITION, Register v0 */
        D3DVSD_REG(D3DVSDE_NORMAL,   D3DVSDT_FLOAT2),  /* D3DVSDE_NORMAL,   Register v1 */
        D3DVSD_END()
    };
    DWORD decl_normal_float4[] =
    {
        D3DVSD_STREAM(0),
        D3DVSD_REG(D3DVSDE_POSITION, D3DVSDT_FLOAT3),  /* D3DVSDE_POSITION, Register v0 */
        D3DVSD_REG(D3DVSDE_NORMAL,   D3DVSDT_FLOAT4),  /* D3DVSDE_NORMAL,   Register v1 */
        D3DVSD_END()
    };
    DWORD decl_normal_d3dcolor[] =
    {
        D3DVSD_STREAM(0),
        D3DVSD_REG(D3DVSDE_POSITION, D3DVSDT_FLOAT3),  /* D3DVSDE_POSITION, Register v0 */
        D3DVSD_REG(D3DVSDE_NORMAL,   D3DVSDT_D3DCOLOR),/* D3DVSDE_NORMAL,   Register v1 */
        D3DVSD_END()
    };
    const DWORD vertex_decl_size = sizeof(dwVertexDecl);
    const DWORD simple_vs_size = sizeof(simple_vs);
    const DWORD simple_ps_size = sizeof(simple_ps);

    window = create_window();
    ok(!!window, "Failed to create a window.\n");
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, NULL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        goto cleanup;
    }

    IDirect3DDevice8_GetDeviceCaps(device, &caps);

    /* Test setting and retrieving a FVF */
    hr = IDirect3DDevice8_SetVertexShader(device, fvf);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_GetVertexShader(device, &hTempHandle);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);
    ok(hTempHandle == fvf, "Got vertex shader %#lx, expected %#lx.\n", hTempHandle, fvf);

    /* First create a vertex shader */
    hr = IDirect3DDevice8_SetVertexShader(device, 0);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateVertexShader(device, dwVertexDecl, simple_vs, &hVertexShader, 0);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    /* Msdn says that the new vertex shader is set immediately. This is wrong, apparently */
    hr = IDirect3DDevice8_GetVertexShader(device, &hTempHandle);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    ok(!hTempHandle, "Got vertex shader %#lx.\n", hTempHandle);
    /* Assign the shader, then verify that GetVertexShader works */
    hr = IDirect3DDevice8_SetVertexShader(device, hVertexShader);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_GetVertexShader(device, &hTempHandle);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    ok(hTempHandle == hVertexShader, "Got vertex shader %#lx, expected %#lx.\n", hTempHandle, hVertexShader);
    /* Verify that we can retrieve the declaration */
    hr = IDirect3DDevice8_GetVertexShaderDeclaration(device, hVertexShader, NULL, &data_size);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    ok(data_size == vertex_decl_size, "Got data_size %lu, expected %lu.\n", data_size, vertex_decl_size);
    data = malloc(vertex_decl_size);
    data_size = 1;
    hr = IDirect3DDevice8_GetVertexShaderDeclaration(device, hVertexShader, data, &data_size);
    ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);
    ok(data_size == 1, "Got data_size %lu.\n", data_size);
    data_size = vertex_decl_size;
    hr = IDirect3DDevice8_GetVertexShaderDeclaration(device, hVertexShader, data, &data_size);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    ok(data_size == vertex_decl_size, "Got data_size %lu, expected %lu.\n", data_size, vertex_decl_size);
    ok(!memcmp(data, dwVertexDecl, vertex_decl_size), "data not equal to shader declaration\n");
    free(data);
    /* Verify that we can retrieve the shader function */
    hr = IDirect3DDevice8_GetVertexShaderFunction(device, hVertexShader, NULL, &data_size);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    ok(data_size == simple_vs_size, "Got data_size %lu, expected %lu.\n", data_size, simple_vs_size);
    data = malloc(simple_vs_size);
    data_size = 1;
    hr = IDirect3DDevice8_GetVertexShaderFunction(device, hVertexShader, data, &data_size);
    ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);
    ok(data_size == 1, "Got data_size %lu.\n", data_size);
    data_size = simple_vs_size;
    hr = IDirect3DDevice8_GetVertexShaderFunction(device, hVertexShader, data, &data_size);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    ok(data_size == simple_vs_size, "Got data_size %lu, expected %lu.\n", data_size, simple_vs_size);
    ok(!memcmp(data, simple_vs, simple_vs_size), "data not equal to shader function\n");
    free(data);
    /* Delete the assigned shader. This is supposed to work */
    hr = IDirect3DDevice8_DeleteVertexShader(device, hVertexShader);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    /* The shader should be unset now */
    hr = IDirect3DDevice8_GetVertexShader(device, &hTempHandle);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    ok(!hTempHandle, "Got vertex shader %#lx.\n", hTempHandle);

    /* Test a broken declaration. 3DMark2001 tries to use normals with 2 components
     * First try the fixed function shader function, then a custom one
     */
    hr = IDirect3DDevice8_CreateVertexShader(device, decl_normal_float2, 0, &hVertexShader, 0);
    ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateVertexShader(device, decl_normal_float4, 0, &hVertexShader, 0);
    ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateVertexShader(device, decl_normal_d3dcolor, 0, &hVertexShader, 0);
    ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CreateVertexShader(device, decl_normal_float2, simple_vs, &hVertexShader, 0);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    IDirect3DDevice8_DeleteVertexShader(device, hVertexShader);

    if (caps.PixelShaderVersion >= D3DPS_VERSION(1, 0))
    {
        /* The same with a pixel shader */
        hr = IDirect3DDevice8_CreatePixelShader(device, simple_ps, &hPixelShader);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
        /* Msdn says that the new pixel shader is set immediately. This is wrong, apparently */
        hr = IDirect3DDevice8_GetPixelShader(device, &hTempHandle);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
        ok(!hTempHandle, "Got pixel shader %#lx.\n", hTempHandle);
        /* Assign the shader, then verify that GetPixelShader works */
        hr = IDirect3DDevice8_SetPixelShader(device, hPixelShader);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
        hr = IDirect3DDevice8_GetPixelShader(device, &hTempHandle);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
        ok(hTempHandle == hPixelShader, "Got pixel shader %#lx, expected %#lx.\n", hTempHandle, hPixelShader);
        /* Verify that we can retrieve the shader function */
        hr = IDirect3DDevice8_GetPixelShaderFunction(device, hPixelShader, NULL, &data_size);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
        ok(data_size == simple_ps_size, "Got data_size %lu, expected %lu.\n", data_size, simple_ps_size);
        data = malloc(simple_ps_size);
        data_size = 1;
        hr = IDirect3DDevice8_GetPixelShaderFunction(device, hPixelShader, data, &data_size);
        ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);
        ok(data_size == 1, "Got data_size %lu.\n", data_size);
        data_size = simple_ps_size;
        hr = IDirect3DDevice8_GetPixelShaderFunction(device, hPixelShader, data, &data_size);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
        ok(data_size == simple_ps_size, "Got data_size %lu, expected %lu.\n", data_size, simple_ps_size);
        ok(!memcmp(data, simple_ps, simple_ps_size), "data not equal to shader function\n");
        free(data);
        /* Delete the assigned shader. This is supposed to work */
        hr = IDirect3DDevice8_DeletePixelShader(device, hPixelShader);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
        /* The shader should be unset now */
        hr = IDirect3DDevice8_GetPixelShader(device, &hTempHandle);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
        ok(!hTempHandle, "Got pixel shader %#lx.\n", hTempHandle);

        /* What happens if a non-bound shader is deleted? */
        hr = IDirect3DDevice8_CreatePixelShader(device, simple_ps, &hPixelShader);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
        hr = IDirect3DDevice8_CreatePixelShader(device, simple_ps, &hPixelShader2);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

        hr = IDirect3DDevice8_SetPixelShader(device, hPixelShader);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
        hr = IDirect3DDevice8_DeletePixelShader(device, hPixelShader2);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
        hr = IDirect3DDevice8_GetPixelShader(device, &hTempHandle);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
        ok(hTempHandle == hPixelShader, "Got pixel shader %#lx, expected %#lx.\n", hTempHandle, hPixelShader);
        hr = IDirect3DDevice8_DeletePixelShader(device, hPixelShader);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

        /* Check for double delete. */
        hr = IDirect3DDevice8_DeletePixelShader(device, hPixelShader2);
        ok(hr == D3DERR_INVALIDCALL || broken(hr == D3D_OK), "Got hr %#lx.\n", hr);
        hr = IDirect3DDevice8_DeletePixelShader(device, hPixelShader);
        ok(hr == D3DERR_INVALIDCALL || broken(hr == D3D_OK), "Got hr %#lx.\n", hr);
    }
    else
    {
        skip("Pixel shaders not supported\n");
    }

    /* What happens if a non-bound shader is deleted? */
    hr = IDirect3DDevice8_CreateVertexShader(device, dwVertexDecl, NULL, &hVertexShader, 0);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateVertexShader(device, dwVertexDecl, NULL, &hVertexShader2, 0);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetVertexShader(device, hVertexShader);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DeleteVertexShader(device, hVertexShader2);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_GetVertexShader(device, &hTempHandle);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    ok(hTempHandle == hVertexShader, "Got vertex shader %#lx, expected %#lx.\n", hTempHandle, hVertexShader);
    hr = IDirect3DDevice8_DeleteVertexShader(device, hVertexShader);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    /* Check for double delete. */
    hr = IDirect3DDevice8_DeleteVertexShader(device, hVertexShader2);
    ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DeleteVertexShader(device, hVertexShader);
    ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
cleanup:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_limits(void)
{
    IDirect3DTexture8 *texture;
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d;
    unsigned int i;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    window = create_window();
    ok(!!window, "Failed to create a window.\n");
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, NULL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        goto cleanup;
    }

    hr = IDirect3DDevice8_CreateTexture(device, 16, 16, 1, 0, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED, &texture);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    /* There are 8 texture stages. We should be able to access all of them */
    for (i = 0; i < 8; ++i)
    {
        hr = IDirect3DDevice8_SetTexture(device, i, (IDirect3DBaseTexture8 *)texture);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetTexture(device, i, NULL);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetTextureStageState(device, i, D3DTSS_COLOROP, D3DTOP_ADD);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    }

    /* Investigations show that accessing higher textures stage states does
     * not return an error either. Writing to too high texture stages
     * (approximately texture 40) causes memory corruption in windows, so
     * there is no bounds checking. */
    IDirect3DTexture8_Release(texture);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
cleanup:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_lights(void)
{
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d8;
    ULONG refcount;
    HWND window;
    HRESULT hr;
    unsigned int i;
    BOOL enabled;
    D3DCAPS8 caps;

    window = create_window();
    ok(!!window, "Failed to create a window.\n");
    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d8, window, NULL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        goto cleanup;
    }

    memset(&caps, 0, sizeof(caps));
    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    for(i = 1; i <= caps.MaxActiveLights; i++) {
        hr = IDirect3DDevice8_LightEnable(device, i, TRUE);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
        hr = IDirect3DDevice8_GetLightEnable(device, i, &enabled);
        ok(hr == D3D_OK || broken(hr == D3DERR_INVALIDCALL), "Got hr %#lx.\n", hr);
        ok(enabled, "Light %d is %s\n", i, enabled ? "enabled" : "disabled");
    }

    /* TODO: Test the rendering results in this situation */
    hr = IDirect3DDevice8_LightEnable(device, i + 1, TRUE);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_GetLightEnable(device, i + 1, &enabled);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    ok(enabled, "Light %d is %s\n", i + 1, enabled ? "enabled" : "disabled");
    hr = IDirect3DDevice8_LightEnable(device, i + 1, FALSE);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    for(i = 1; i <= caps.MaxActiveLights; i++) {
        hr = IDirect3DDevice8_LightEnable(device, i, FALSE);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    }

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
cleanup:
    IDirect3D8_Release(d3d8);
    DestroyWindow(window);
}

static void test_set_stream_source(void)
{
    IDirect3DVertexBuffer8 *vb, *current_vb;
    IDirect3DDevice8 *device;
    unsigned int stride;
    IDirect3D8 *d3d8;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    window = create_window();
    ok(!!window, "Failed to create a window.\n");
    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d8, window, NULL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        goto cleanup;
    }

    hr = IDirect3DDevice8_CreateVertexBuffer(device, 512, 0, 0, D3DPOOL_DEFAULT, &vb);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetStreamSource(device, 0, vb, 32);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetStreamSource(device, 0, NULL, 0);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_GetStreamSource(device, 0, &current_vb, &stride);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    ok(!current_vb, "Got unexpected vb %p.\n", current_vb);
    ok(stride == 32, "Got unexpected stride %u.\n", stride);

    hr = IDirect3DDevice8_SetStreamSource(device, 0, vb, 0);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_GetStreamSource(device, 0, &current_vb, &stride);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    ok(current_vb == vb, "Got unexpected vb %p.\n", current_vb);
    IDirect3DVertexBuffer8_Release(current_vb);
    ok(!stride, "Got unexpected stride %u.\n", stride);

    IDirect3DVertexBuffer8_Release(vb);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
cleanup:
    IDirect3D8_Release(d3d8);
    DestroyWindow(window);
}

static void test_render_zero_triangles(void)
{
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d8;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    static const struct
    {
        struct vec3 position;
        struct vec3 normal;
        DWORD diffuse;
    }
    quad[] =
    {
        {{0.0f, -1.0f, 0.1f}, {1.0f, 1.0f, 1.0f}, 0xff0000ff},
        {{0.0f,  0.0f, 0.1f}, {1.0f, 1.0f, 1.0f}, 0xff0000ff},
        {{1.0f,  0.0f, 0.1f}, {1.0f, 1.0f, 1.0f}, 0xff0000ff},
        {{1.0f, -1.0f, 0.1f}, {1.0f, 1.0f, 1.0f}, 0xff0000ff},
    };

    window = create_window();
    ok(!!window, "Failed to create a window.\n");
    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d8, window, NULL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        goto cleanup;
    }

    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_DIFFUSE);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawIndexedPrimitiveUP(device, D3DPT_TRIANGLELIST, 0 /* MinIndex */, 0 /* NumVerts */,
            0 /* PrimCount */, NULL, D3DFMT_INDEX16, quad, sizeof(quad[0]));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

    IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
cleanup:
    IDirect3D8_Release(d3d8);
    DestroyWindow(window);
}

static void test_depth_stencil_reset(void)
{
    D3DPRESENT_PARAMETERS present_parameters;
    D3DDISPLAYMODE display_mode;
    IDirect3DSurface8 *surface, *orig_rt;
    IDirect3DDevice8 *device = NULL;
    IDirect3D8 *d3d8;
    UINT refcount;
    HRESULT hr;
    HWND hwnd;

    hwnd = CreateWindowA("d3d8_test_wc", "d3d8_test", WS_OVERLAPPEDWINDOW,
            100, 100, 160, 160, NULL, NULL, NULL, NULL);
    ok(!!hwnd, "Failed to create a window.\n");
    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");

    IDirect3D8_GetAdapterDisplayMode(d3d8, D3DADAPTER_DEFAULT, &display_mode);
    memset(&present_parameters, 0, sizeof(present_parameters));
    present_parameters.Windowed               = TRUE;
    present_parameters.SwapEffect             = D3DSWAPEFFECT_DISCARD;
    present_parameters.BackBufferFormat       = display_mode.Format;
    present_parameters.EnableAutoDepthStencil = TRUE;
    present_parameters.AutoDepthStencilFormat = D3DFMT_D24S8;

    hr = IDirect3D8_CreateDevice(d3d8, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, hwnd,
            D3DCREATE_SOFTWARE_VERTEXPROCESSING, &present_parameters, &device);
    if(FAILED(hr))
    {
        skip("Failed to create device, hr %#lx.\n", hr);
        goto cleanup;
    }

    hr = IDirect3DDevice8_GetRenderTarget(device, &orig_rt);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_TestCooperativeLevel(device);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderTarget(device, NULL, NULL);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetRenderTarget(device, &surface);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    ok(surface == orig_rt, "Render target is %p, should be %p\n", surface, orig_rt);
    if (surface) IDirect3DSurface8_Release(surface);
    IDirect3DSurface8_Release(orig_rt);

    hr = IDirect3DDevice8_GetDepthStencilSurface(device, &surface);
    ok(hr == D3DERR_NOTFOUND, "Got hr %#lx.\n", hr);
    ok(surface == NULL, "Depth stencil should be NULL\n");

    present_parameters.EnableAutoDepthStencil = TRUE;
    present_parameters.AutoDepthStencilFormat = D3DFMT_D24S8;
    hr = IDirect3DDevice8_Reset(device, &present_parameters);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetDepthStencilSurface(device, &surface);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    ok(surface != NULL, "Depth stencil should not be NULL\n");
    if (surface) IDirect3DSurface8_Release(surface);

    present_parameters.EnableAutoDepthStencil = FALSE;
    hr = IDirect3DDevice8_Reset(device, &present_parameters);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetDepthStencilSurface(device, &surface);
    ok(hr == D3DERR_NOTFOUND, "Got hr %#lx.\n", hr);
    ok(surface == NULL, "Depth stencil should be NULL\n");

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %u references left.\n", refcount);
    device = NULL;

    IDirect3D8_GetAdapterDisplayMode( d3d8, D3DADAPTER_DEFAULT, &display_mode );

    ZeroMemory( &present_parameters, sizeof(present_parameters) );
    present_parameters.Windowed         = TRUE;
    present_parameters.SwapEffect       = D3DSWAPEFFECT_DISCARD;
    present_parameters.BackBufferFormat = display_mode.Format;
    present_parameters.EnableAutoDepthStencil = FALSE;
    present_parameters.AutoDepthStencilFormat = D3DFMT_D24S8;

    hr = IDirect3D8_CreateDevice( d3d8, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, hwnd,
                    D3DCREATE_SOFTWARE_VERTEXPROCESSING, &present_parameters, &device );

    if(FAILED(hr))
    {
        skip("Failed to create device, hr %#lx.\n", hr);
        goto cleanup;
    }

    hr = IDirect3DDevice8_TestCooperativeLevel(device);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    present_parameters.SwapEffect       = D3DSWAPEFFECT_DISCARD;
    present_parameters.Windowed         = TRUE;
    present_parameters.BackBufferWidth  = 400;
    present_parameters.BackBufferHeight = 300;
    present_parameters.EnableAutoDepthStencil = TRUE;
    present_parameters.AutoDepthStencilFormat = D3DFMT_D24S8;

    hr = IDirect3DDevice8_Reset(device, &present_parameters);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    if (FAILED(hr)) goto cleanup;

    hr = IDirect3DDevice8_GetDepthStencilSurface(device, &surface);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    ok(surface != NULL, "Depth stencil should not be NULL\n");
    if (surface) IDirect3DSurface8_Release(surface);

cleanup:
    if (device)
    {
        refcount = IDirect3DDevice8_Release(device);
        ok(!refcount, "Device has %u references left.\n", refcount);
    }
    IDirect3D8_Release(d3d8);
    DestroyWindow(hwnd);
}

static HWND filter_messages;

enum message_window
{
    DEVICE_WINDOW,
    FOCUS_WINDOW,
};

struct message
{
    UINT message;
    enum message_window window;
    BOOL check_wparam;
    WPARAM expect_wparam;
    HRESULT device_state;
    WINDOWPOS *store_wp;
};

static const struct message *expect_messages;
static HWND device_window, focus_window;
static LONG windowposchanged_received, syscommand_received;
static IDirect3DDevice8 *focus_test_device;

struct wndproc_thread_param
{
    HWND dummy_window;
    HANDLE window_created;
    HANDLE test_finished;
};

static LRESULT CALLBACK test_proc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam)
{
    HRESULT hr;

    if (filter_messages && filter_messages == hwnd)
    {
        if (message != WM_DISPLAYCHANGE && message != WM_IME_NOTIFY)
            todo_wine ok(0, "Received unexpected message %#x for window %p.\n", message, hwnd);
    }

    if (expect_messages)
    {
        HWND w;

        switch (expect_messages->window)
        {
            case DEVICE_WINDOW:
                w = device_window;
                break;

            case FOCUS_WINDOW:
                w = focus_window;
                break;

            default:
                w = NULL;
                break;
        };

        if (hwnd == w && expect_messages->message == message)
        {
            if (expect_messages->check_wparam)
                ok(wparam == expect_messages->expect_wparam,
                        "Got unexpected wparam %#Ix for message %#x, expected %#Ix.\n",
                        wparam, message, expect_messages->expect_wparam);

            if (expect_messages->store_wp)
                *expect_messages->store_wp = *(WINDOWPOS *)lparam;

            if (focus_test_device)
            {
                hr = IDirect3DDevice8_TestCooperativeLevel(focus_test_device);
                /* Wined3d marks the device lost earlier than Windows (it follows ddraw
                 * behavior. See test_wndproc before the focus_loss_messages sequence
                 * about the D3DERR_DEVICENOTRESET behavior, */
                todo_wine_if(message != WM_ACTIVATEAPP || hr == D3D_OK)
                        ok(hr == expect_messages->device_state,
                        "Got device state %#lx on message %#x, expected %#lx.\n",
                        hr, message, expect_messages->device_state);
            }

            ++expect_messages;
        }
    }

    /* KDE randomly does something with the hidden window during the
     * mode change that sometimes generates a WM_WINDOWPOSCHANGING
     * message. A WM_WINDOWPOSCHANGED message is not generated, so
     * just flag WM_WINDOWPOSCHANGED as bad. */
    if (message == WM_WINDOWPOSCHANGED)
        InterlockedIncrement(&windowposchanged_received);
    else if (message == WM_SYSCOMMAND)
        InterlockedIncrement(&syscommand_received);

    return DefWindowProcA(hwnd, message, wparam, lparam);
}

static DWORD WINAPI wndproc_thread(void *param)
{
    struct wndproc_thread_param *p = param;
    DWORD res;
    BOOL ret;

    p->dummy_window = CreateWindowA("static", "d3d9_test", WS_VISIBLE | WS_CAPTION,
            100, 100, 200, 200, 0, 0, 0, 0);
    flush_events();

    ret = SetEvent(p->window_created);
    ok(ret, "SetEvent failed, last error %#lx.\n", GetLastError());

    for (;;)
    {
        MSG msg;

        while (PeekMessageA(&msg, 0, 0, 0, PM_REMOVE)) DispatchMessageA(&msg);
        res = WaitForSingleObject(p->test_finished, 100);
        if (res == WAIT_OBJECT_0) break;
        if (res != WAIT_TIMEOUT)
        {
            ok(0, "Wait failed (%#lx), last error %#lx.\n", res, GetLastError());
            break;
        }
    }

    DestroyWindow(p->dummy_window);

    return 0;
}

static void test_wndproc(void)
{
    unsigned int adapter_mode_count, i, d3d_width = 0, d3d_height = 0, user32_width = 0, user32_height = 0;
    struct wndproc_thread_param thread_params;
    struct device_desc device_desc;
    static WINDOWPOS windowpos;
    IDirect3DDevice8 *device;
    WNDCLASSA wc = {0};
    IDirect3D8 *d3d8;
    HANDLE thread;
    LONG_PTR proc;
    ULONG ref;
    DWORD res, tid;
    HWND tmp;
    HRESULT hr;
    D3DDISPLAYMODE d3ddm;
    DEVMODEW devmode;
    LONG change_ret, device_style;
    BOOL ret;

    static const struct message create_messages[] =
    {
        {WM_WINDOWPOSCHANGING,  FOCUS_WINDOW,   FALSE,  0},
        /* Do not test wparam here. If device creation succeeds,
         * wparam is WA_ACTIVE. If device creation fails (testbot)
         * wparam is set to WA_INACTIVE on some Windows versions. */
        {WM_ACTIVATE,           FOCUS_WINDOW,   FALSE,  0},
        {WM_SETFOCUS,           FOCUS_WINDOW,   FALSE,  0},
        {WM_WINDOWPOSCHANGING,  DEVICE_WINDOW,  FALSE,  0},
        {WM_MOVE,               DEVICE_WINDOW,  FALSE,  0},
        {WM_SIZE,               DEVICE_WINDOW,  FALSE,  0},
        {0,                     0,              FALSE,  0},
    };
    static const struct message focus_loss_messages[] =
    {
        /* WM_ACTIVATE (wparam = WA_INACTIVE) is sent on Windows. It is
         * not reliable on X11 WMs. When the window focus follows the
         * mouse pointer the message is not sent.
         * {WM_ACTIVATE,           FOCUS_WINDOW,   TRUE,   WA_INACTIVE}, */
        {WM_DISPLAYCHANGE,      DEVICE_WINDOW,  FALSE,  0,  D3DERR_DEVICENOTRESET},
        /* WM_DISPLAYCHANGE is sent to the focus window too, but the order is
         * not deterministic. */
        {WM_WINDOWPOSCHANGING,  DEVICE_WINDOW,  FALSE,  0,  D3DERR_DEVICENOTRESET},
        /* Windows sends WM_ACTIVATE to the device window, indicating that
         * SW_SHOWMINIMIZED is used instead of SW_MINIMIZE. Yet afterwards
         * the foreground and focus window are NULL. On Wine SW_SHOWMINIMIZED
         * leaves the device window active, breaking re-activation in the
         * lost device test.
         * {WM_ACTIVATE,           DEVICE_WINDOW,  TRUE,   0x200000 | WA_ACTIVE}, */
        {WM_WINDOWPOSCHANGED,   DEVICE_WINDOW,  FALSE,  0,  D3DERR_DEVICENOTRESET},
        {WM_SIZE,               DEVICE_WINDOW,  TRUE,   SIZE_MINIMIZED,
                D3DERR_DEVICENOTRESET},
        {WM_ACTIVATEAPP,        FOCUS_WINDOW,   TRUE,   FALSE,  D3DERR_DEVICELOST},
        /* WM_ACTIVATEAPP is sent to the device window too, but the order is
         * not deterministic. It may be sent after the focus window handling
         * or before. */
        {0,                     0,              FALSE,  0,      0},
    };
    static const struct message reactivate_messages[] =
    {
        {WM_WINDOWPOSCHANGING,  DEVICE_WINDOW,  FALSE,  0},
        {WM_WINDOWPOSCHANGED,   DEVICE_WINDOW,  FALSE,  0},
        {WM_ACTIVATEAPP,        FOCUS_WINDOW,   TRUE,   TRUE},
        {0,                     0,              FALSE,  0},
    };
    static const struct message focus_loss_messages_hidden[] =
    {
        {WM_DISPLAYCHANGE,      DEVICE_WINDOW,  FALSE,  0},
        {WM_ACTIVATEAPP,        FOCUS_WINDOW,   TRUE,   FALSE},
        {0,                     0,              FALSE,  0},
    };
    static const struct message focus_loss_messages_filtered[] =
    {
        /* WM_ACTIVATE is delivered to the window proc because it is
         * generated by SetForegroundWindow before the d3d routine
         * starts it work. Don't check for it due to focus-follows-mouse
         * WMs though. */
        {WM_DISPLAYCHANGE,      FOCUS_WINDOW,   FALSE,  0},
        {WM_ACTIVATEAPP,        FOCUS_WINDOW,   TRUE,   FALSE},
        {0,                     0,              FALSE,  0},
    };
    static const struct message reactivate_messages_filtered[] =
    {
        {WM_ACTIVATEAPP,        FOCUS_WINDOW,   TRUE,   TRUE},
        {0,                     0,              FALSE,  0},
    };
    static const struct message sc_restore_messages[] =
    {
        /* WM_SYSCOMMAND is delivered only once, after d3d has already
         * processed it. Our wndproc has no way to prevent d3d from
         * handling the message. The second DefWindowProc call done by
         * our wndproc doesn't do any changes to the window because it
         * is already restored due to d3d's handling. */
        {WM_WINDOWPOSCHANGING,  FOCUS_WINDOW,   FALSE,  0},
        {WM_WINDOWPOSCHANGED,   FOCUS_WINDOW,   FALSE,  0},
        {WM_SIZE,               FOCUS_WINDOW,   TRUE,   SIZE_RESTORED},
        {WM_SYSCOMMAND,         FOCUS_WINDOW,   TRUE,   SC_RESTORE},
        {0,                     0,              FALSE,  0},
    };
    static const struct message sc_minimize_messages[] =
    {
        {WM_SYSCOMMAND,         FOCUS_WINDOW,   TRUE,   SC_MINIMIZE},
        {WM_WINDOWPOSCHANGING,  FOCUS_WINDOW,   FALSE,  0},
        {WM_WINDOWPOSCHANGED,   FOCUS_WINDOW,   FALSE,  0},
        {WM_MOVE,               FOCUS_WINDOW,   FALSE,  0},
        {WM_SIZE,               FOCUS_WINDOW,   TRUE,   SIZE_MINIMIZED},
        {0,                     0,              FALSE,  0},
    };
    static const struct message sc_maximize_messages[] =
    {
        {WM_SYSCOMMAND,         FOCUS_WINDOW,   TRUE,   SC_MAXIMIZE},
        {WM_WINDOWPOSCHANGING,  FOCUS_WINDOW,   FALSE,  0},
        {WM_WINDOWPOSCHANGED,   FOCUS_WINDOW,   FALSE,  0},
        /* Windows always sends WM_MOVE here.
         *
         * In the first case, we are maximizing from a minimized state, and
         * hence the client rect moves from the minimized position to (0, 0).
         *
         * In the second case, we are maximizing from an on-screen restored
         * state. The window is at (0, 0), but it has a caption, so the client
         * rect is offset, and the *client* will move to (0, 0) when maximized.
         *
         * Wine doesn't send WM_MOVE here because it messes with the window
         * styles when switching to fullscreen, and hence the client rect is
         * already at (0, 0). Obviously Wine shouldn't do this, but it's hard to
         * fix, and the WM_MOVE is not particularly interesting, so just ignore
         * it. */
        {WM_SIZE,               FOCUS_WINDOW,   TRUE,   SIZE_MAXIMIZED},
        {0,                     0,              FALSE,  0},
    };
    static const struct message mode_change_messages[] =
    {
        {WM_WINDOWPOSCHANGING,  DEVICE_WINDOW,  FALSE,  0},
        {WM_WINDOWPOSCHANGED,   DEVICE_WINDOW,  FALSE,  0},
        {WM_SIZE,               DEVICE_WINDOW,  FALSE,  0},
        /* TODO: WM_DISPLAYCHANGE is sent to the focus window too, but the order is
         * differs between Wine and Windows. */
        /* TODO 2: Windows sends a second WM_WINDOWPOSCHANGING(SWP_NOMOVE | SWP_NOSIZE
         * | SWP_NOACTIVATE) in this situation, suggesting a difference in their ShowWindow
         * implementation. This SetWindowPos call could in theory affect the Z order. Wine's
         * ShowWindow does not send such a message because the window is already visible. */
        {0,                     0,              FALSE,  0},
    };
    static const struct message mode_change_messages_hidden[] =
    {
        {WM_WINDOWPOSCHANGING,  DEVICE_WINDOW,  FALSE,  0},
        {WM_WINDOWPOSCHANGED,   DEVICE_WINDOW,  FALSE,  0},
        {WM_SIZE,               DEVICE_WINDOW,  FALSE,  0},
        {WM_SHOWWINDOW,         DEVICE_WINDOW,  FALSE,  0},
        {WM_WINDOWPOSCHANGING,  DEVICE_WINDOW,  FALSE,  0, ~0U, &windowpos},
        {WM_WINDOWPOSCHANGED,   DEVICE_WINDOW,  FALSE,  0},
        /* TODO: WM_DISPLAYCHANGE is sent to the focus window too, but the order is
         * differs between Wine and Windows. */
        {0,                     0,              FALSE,  0},
    };

    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");

    adapter_mode_count = IDirect3D8_GetAdapterModeCount(d3d8, D3DADAPTER_DEFAULT);
    for (i = 0; i < adapter_mode_count; ++i)
    {
        hr = IDirect3D8_EnumAdapterModes(d3d8, D3DADAPTER_DEFAULT, i, &d3ddm);
        ok(SUCCEEDED(hr), "Failed to enumerate display mode, hr %#lx.\n", hr);

        if (d3ddm.Format != D3DFMT_X8R8G8B8)
            continue;
        if (d3ddm.Width == registry_mode.dmPelsWidth && d3ddm.Height == registry_mode.dmPelsHeight)
            continue;
        /* The r200 driver on Windows XP enumerates modes like 320x200 and 320x240 but
         * refuses to create a device at these sizes. */
        if (d3ddm.Width < 640 || d3ddm.Height < 480)
            continue;

        if (!user32_width)
        {
            user32_width = d3ddm.Width;
            user32_height = d3ddm.Height;
            continue;
        }

        /* Make sure the d3d mode is smaller in width or height and at most
         * equal in the other dimension than the mode passed to
         * ChangeDisplaySettings. Otherwise Windows shrinks the window to
         * the ChangeDisplaySettings parameters + 12. */
        if (d3ddm.Width == user32_width && d3ddm.Height == user32_height)
            continue;
        if (d3ddm.Width <= user32_width && d3ddm.Height <= user32_height)
        {
            d3d_width = d3ddm.Width;
            d3d_height = d3ddm.Height;
            break;
        }
        if (user32_width <= d3ddm.Width && user32_height <= d3ddm.Height)
        {
            d3d_width = user32_width;
            d3d_height = user32_height;
            user32_width = d3ddm.Width;
            user32_height = d3ddm.Height;
            break;
        }
    }

    if (!d3d_width)
    {
        skip("Could not find adequate modes, skipping mode tests.\n");
        IDirect3D8_Release(d3d8);
        return;
    }

    filter_messages = NULL;
    expect_messages = NULL;

    wc.lpfnWndProc = test_proc;
    wc.lpszClassName = "d3d8_test_wndproc_wc";
    ok(RegisterClassA(&wc), "Failed to register window class.\n");

    thread_params.window_created = CreateEventA(NULL, FALSE, FALSE, NULL);
    ok(!!thread_params.window_created, "CreateEvent failed, last error %#lx.\n", GetLastError());
    thread_params.test_finished = CreateEventA(NULL, FALSE, FALSE, NULL);
    ok(!!thread_params.test_finished, "CreateEvent failed, last error %#lx.\n", GetLastError());

    memset(&devmode, 0, sizeof(devmode));
    devmode.dmSize = sizeof(devmode);
    devmode.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT;
    devmode.dmPelsWidth = user32_width;
    devmode.dmPelsHeight = user32_height;
    change_ret = ChangeDisplaySettingsW(&devmode, CDS_FULLSCREEN);
    ok(change_ret == DISP_CHANGE_SUCCESSFUL, "Failed to change display mode, ret %#lx.\n", change_ret);

    focus_window = CreateWindowA("d3d8_test_wndproc_wc", "d3d8_test",
            WS_MAXIMIZE | WS_VISIBLE | WS_CAPTION , 0, 0, user32_width, user32_height, 0, 0, 0, 0);
    device_window = CreateWindowA("d3d8_test_wndproc_wc", "d3d8_test",
            WS_MAXIMIZE | WS_VISIBLE | WS_CAPTION , 0, 0, user32_width, user32_height, 0, 0, 0, 0);
    flush_events();

    thread = CreateThread(NULL, 0, wndproc_thread, &thread_params, 0, &tid);
    ok(!!thread, "Failed to create thread, last error %#lx.\n", GetLastError());

    res = WaitForSingleObject(thread_params.window_created, INFINITE);
    ok(res == WAIT_OBJECT_0, "Wait failed (%#lx), last error %#lx.\n", res, GetLastError());
    flush_events();

    proc = GetWindowLongPtrA(device_window, GWLP_WNDPROC);
    ok(proc == (LONG_PTR)test_proc, "Expected wndproc %#Ix, got %#Ix.\n",
            (LONG_PTR)test_proc, proc);
    proc = GetWindowLongPtrA(focus_window, GWLP_WNDPROC);
    ok(proc == (LONG_PTR)test_proc, "Expected wndproc %#Ix, got %#Ix.\n",
            (LONG_PTR)test_proc, proc);

    trace("device_window %p, focus_window %p, dummy_window %p.\n",
            device_window, focus_window, thread_params.dummy_window);

    tmp = GetFocus();
    ok(tmp == NULL, "Expected focus %p, got %p.\n", NULL, tmp);
    tmp = GetForegroundWindow();
    ok(tmp == thread_params.dummy_window, "Expected foreground window %p, got %p.\n",
            thread_params.dummy_window, tmp);

    flush_events();

    expect_messages = create_messages;

    device_desc.adapter_ordinal = D3DADAPTER_DEFAULT;
    device_desc.device_window = device_window;
    device_desc.width = d3d_width;
    device_desc.height = d3d_height;
    device_desc.flags = CREATE_DEVICE_FULLSCREEN;
    if (!(device = create_device(d3d8, focus_window, &device_desc)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    ok(!expect_messages->message, "Expected message %#x for window %#x, but didn't receive it.\n",
            expect_messages->message, expect_messages->window);
    expect_messages = NULL;

    tmp = GetFocus();
    ok(tmp == focus_window, "Expected focus %p, got %p.\n", focus_window, tmp);
    tmp = GetForegroundWindow();
    ok(tmp == focus_window, "Expected foreground window %p, got %p.\n", focus_window, tmp);
    SetForegroundWindow(focus_window);
    flush_events();

    proc = GetWindowLongPtrA(device_window, GWLP_WNDPROC);
    ok(proc == (LONG_PTR)test_proc, "Expected wndproc %#Ix, got %#Ix.\n",
            (LONG_PTR)test_proc, proc);

    proc = GetWindowLongPtrA(focus_window, GWLP_WNDPROC);
    ok(proc != (LONG_PTR)test_proc, "Expected wndproc != %#Ix.\n", (LONG_PTR)test_proc);

    /* Change the mode while the device is in use and then drop focus. */
    devmode.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT;
    devmode.dmPelsWidth = user32_width;
    devmode.dmPelsHeight = user32_height;
    change_ret = ChangeDisplaySettingsW(&devmode, CDS_FULLSCREEN);
    ok(change_ret == DISP_CHANGE_SUCCESSFUL, "Failed to change display mode, ret %#lx, i=%u.\n", change_ret, i);

    /* Wine doesn't (yet) mark the device not reset when the mode is changed, thus the todo_wine.
     * But sometimes focus-follows-mouse WMs also temporarily drop window focus, which makes
     * mark the device lost, then not reset, causing the test to succeed for the wrong reason. */
    hr = IDirect3DDevice8_TestCooperativeLevel(device);
    todo_wine_if (hr != D3DERR_DEVICENOTRESET)
        ok(hr == D3DERR_DEVICENOTRESET, "Got unexpected hr %#lx.\n", hr);

    expect_messages = focus_loss_messages;
    focus_test_device = device;
    /* SetForegroundWindow is a poor replacement for the user pressing alt-tab or
     * manually changing the focus. It generates the same messages, but the task
     * bar still shows the previous foreground window as active, and the window has
     * an inactive titlebar if reactivated with SetForegroundWindow. Reactivating
     * the device is difficult, see below. */
    SetForegroundWindow(GetDesktopWindow());
    ok(!expect_messages->message, "Expected message %#x for window %#x, but didn't receive it.\n",
            expect_messages->message, expect_messages->window);
    expect_messages = NULL;
    tmp = GetFocus();
    ok(tmp != device_window, "The device window is active.\n");
    ok(tmp != focus_window, "The focus window is active.\n");
    focus_test_device = NULL;

    /* The Present call is necessary to make native realize the device is lost. */
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(hr == D3DERR_DEVICELOST, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_TestCooperativeLevel(device);
    /* Focus-follows-mouse WMs prematurely reactivate our window. */
    todo_wine_if (hr == D3DERR_DEVICENOTRESET)
        ok(hr == D3DERR_DEVICELOST, "Got unexpected hr %#lx.\n", hr);

    ret = EnumDisplaySettingsW(NULL, ENUM_CURRENT_SETTINGS, &devmode);
    ok(ret, "Failed to get display mode.\n");
    ok(devmode.dmPelsWidth == registry_mode.dmPelsWidth
            && devmode.dmPelsHeight == registry_mode.dmPelsHeight, "Got unexpected screen size %lux%lu.\n",
            devmode.dmPelsWidth, devmode.dmPelsHeight);

    /* I have to minimize and restore the focus window, otherwise native d3d8 fails
     * device::reset with D3DERR_DEVICELOST. This does not happen when the window
     * restore is triggered by the user.
     *
     * fvwm randomly sends a focus loss notification when we minimize, so do it
     * before checking the incoming messages. It might match WM_ACTIVATEAPP but has
     * a wrong WPARAM. Use SW_SHOWMINNOACTIVE to make sure we don't accidentally
     * activate the window at this point and miss our WM_ACTIVATEAPP(wparam=1). */
    ShowWindow(focus_window, SW_SHOWMINNOACTIVE);
    flush_events();
    expect_messages = reactivate_messages;
    ShowWindow(focus_window, SW_RESTORE);
    /* Set focus twice to make KDE and fvwm in focus-follows-mouse mode happy. */
    SetForegroundWindow(focus_window);
    flush_events();
    SetForegroundWindow(focus_window);
    flush_events(); /* WM_WINDOWPOSCHANGING etc arrive after SetForegroundWindow returns. */
    ok(!expect_messages->message, "Expected message %#x for window %#x, but didn't receive it, i=%u.\n",
            expect_messages->message, expect_messages->window, i);
    expect_messages = NULL;

    hr = IDirect3DDevice8_TestCooperativeLevel(device);
    ok(hr == D3DERR_DEVICENOTRESET, "Got unexpected hr %#lx.\n", hr);

    ret = EnumDisplaySettingsW(NULL, ENUM_CURRENT_SETTINGS, &devmode);
    ok(ret, "Failed to get display mode.\n");
    ok(devmode.dmPelsWidth == registry_mode.dmPelsWidth
            && devmode.dmPelsHeight == registry_mode.dmPelsHeight, "Got unexpected screen size %lux%lu.\n",
            devmode.dmPelsWidth, devmode.dmPelsHeight);

    hr = reset_device(device, &device_desc);
    ok(SUCCEEDED(hr), "Failed to reset device, hr %#lx.\n", hr);

    /* Remove the WS_VISIBLE flag to test hidden windows. This is enough to trigger d3d's hidden
     * window codepath, but does not actually hide the window without a SetWindowPos(SWP_FRAMECHANGED)
     * call. This way we avoid focus changes and random failures on focus follows mouse WMs. */
    device_style = GetWindowLongA(device_window, GWL_STYLE);
    SetWindowLongA(device_window, GWL_STYLE, device_style & ~WS_VISIBLE);
    flush_events();

    expect_messages = focus_loss_messages_hidden;
    windowposchanged_received = 0;
    SetForegroundWindow(GetDesktopWindow());
    ok(!expect_messages->message, "Expected message %#x for window %#x, but didn't receive it.\n",
            expect_messages->message, expect_messages->window);

    /* kwin sometimes resizes hidden windows. The d3d8 version of this test has been reliable on
     * Windows so far, but the d3d9 equivalent rarely fails since Windows 8. */
    flaky
    ok(!windowposchanged_received, "Received WM_WINDOWPOSCHANGED but did not expect it.\n");

    expect_messages = NULL;
    flush_events();

    ret = EnumDisplaySettingsW(NULL, ENUM_CURRENT_SETTINGS, &devmode);
    ok(ret, "Failed to get display mode.\n");
    ok(devmode.dmPelsWidth == registry_mode.dmPelsWidth, "Got unexpected width %lu.\n", devmode.dmPelsWidth);
    ok(devmode.dmPelsHeight == registry_mode.dmPelsHeight, "Got unexpected height %lu.\n", devmode.dmPelsHeight);

    /* SW_SHOWMINNOACTIVE is needed to make FVWM happy. SW_SHOWNOACTIVATE is needed to make windows
     * send SIZE_RESTORED after ShowWindow(SW_SHOWMINNOACTIVE). */
    ShowWindow(focus_window, SW_SHOWNOACTIVATE);
    ShowWindow(focus_window, SW_SHOWMINNOACTIVE);
    flush_events();

    syscommand_received = 0;
    expect_messages = sc_restore_messages;
    SendMessageA(focus_window, WM_SYSCOMMAND, SC_RESTORE, 0);
    ok(!expect_messages->message, "Expected message %#x for window %#x, but didn't receive it.\n",
            expect_messages->message, expect_messages->window);
    ok(syscommand_received == 1, "Got %lu WM_SYSCOMMAND messages.\n", syscommand_received);
    expect_messages = NULL;
    flush_events();

    expect_messages = sc_minimize_messages;
    SendMessageA(focus_window, WM_SYSCOMMAND, SC_MINIMIZE, 0);
    ok(!expect_messages->message, "Expected message %#x for window %#x, but didn't receive it.\n",
            expect_messages->message, expect_messages->window);
    expect_messages = NULL;
    flush_events();

    expect_messages = sc_maximize_messages;
    SendMessageA(focus_window, WM_SYSCOMMAND, SC_MAXIMIZE, 0);
    ok(!expect_messages->message, "Expected message %#x for window %#x, but didn't receive it.\n",
            expect_messages->message, expect_messages->window);
    expect_messages = NULL;
    flush_events();

    SetForegroundWindow(GetDesktopWindow());
    ShowWindow(device_window, SW_MINIMIZE);
    ShowWindow(focus_window, SW_MINIMIZE);
    ShowWindow(focus_window, SW_RESTORE);
    SetForegroundWindow(focus_window);
    flush_events();

    /* Releasing a device in lost state breaks follow-up tests on native. */
    hr = reset_device(device, &device_desc);
    ok(SUCCEEDED(hr), "Failed to reset device, hr %#lx.\n", hr);

    filter_messages = focus_window;
    ref = IDirect3DDevice8_Release(device);
    ok(!ref, "Got unexpected refcount %lu.\n", ref);

    /* Fix up the mode until Wine's device release behavior is fixed. */
    change_ret = ChangeDisplaySettingsW(NULL, CDS_FULLSCREEN);
    ok(change_ret == DISP_CHANGE_SUCCESSFUL, "Failed to change display mode, ret %#lx.\n", change_ret);

    proc = GetWindowLongPtrA(focus_window, GWLP_WNDPROC);
    ok(proc == (LONG_PTR)test_proc, "Expected wndproc %#Ix, got %#Ix.\n",
            (LONG_PTR)test_proc, proc);

    /* Hide the device window. It prevents WM_ACTIVATEAPP messages from being sent
     * on native in the test below. It isn't needed anyways. Creating the third
     * device will show it again. */
    filter_messages = NULL;
    ShowWindow(device_window, SW_HIDE);
    /* Remove the maximized state from the SYSCOMMAND test while we're not
     * interfering with a device. */
    ShowWindow(focus_window, SW_SHOWNORMAL);

    /* On Windows 10 style change messages are delivered on device
     * creation. */
    device_desc.device_window = focus_window;
    if (!(device = create_device(d3d8, focus_window, &device_desc)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }
    SetForegroundWindow(focus_window);  /* make sure that the window has focus */

    filter_messages = NULL;

    expect_messages = focus_loss_messages_filtered;
    windowposchanged_received = 0;
    SetForegroundWindow(GetDesktopWindow());
    ok(!expect_messages->message, "Expected message %#x for window %#x, but didn't receive it.\n",
            expect_messages->message, expect_messages->window);
    expect_messages = NULL;

    /* The window is iconic even though no message was sent. */
    ok(IsIconic(focus_window), "The focus window is not iconic.\n");

    hr = IDirect3DDevice8_TestCooperativeLevel(device);
    ok(hr == D3DERR_DEVICELOST, "Got unexpected hr %#lx.\n", hr);

    syscommand_received = 0;
    expect_messages = sc_restore_messages;
    SendMessageA(focus_window, WM_SYSCOMMAND, SC_RESTORE, 0);
    ok(!expect_messages->message, "Expected message %#x for window %#x, but didn't receive it.\n",
            expect_messages->message, expect_messages->window);
    ok(syscommand_received == 1, "Got %lu WM_SYSCOMMAND messages.\n", syscommand_received);
    expect_messages = NULL;
    flush_events();

    /* For FVWM. */
    ShowWindow(focus_window, SW_RESTORE);
    flush_events();

    expect_messages = sc_minimize_messages;
    SendMessageA(focus_window, WM_SYSCOMMAND, SC_MINIMIZE, 0);
    ok(!expect_messages->message, "Expected message %#x for window %#x, but didn't receive it.\n",
            expect_messages->message, expect_messages->window);
    expect_messages = NULL;
    /* Needed to make the next test reliably send WM_SIZE(SIZE_MAXIMIZED). Without
     * this call it sends WM_SIZE(SIZE_RESTORED). */
    ShowWindow(focus_window, SW_RESTORE);
    flush_events();

    expect_messages = sc_maximize_messages;
    SendMessageA(focus_window, WM_SYSCOMMAND, SC_MAXIMIZE, 0);
    ok(!expect_messages->message, "Expected message %#x for window %#x, but didn't receive it.\n",
            expect_messages->message, expect_messages->window);
    expect_messages = NULL;
    flush_events();
    SetForegroundWindow(GetDesktopWindow());
    flush_events();

    /* ShowWindow(SW_RESTORE); SetForegroundWindow(desktop); SetForegroundWindow(focus);
     * results in the second SetForegroundWindow call failing and the device not being
     * restored on native. Directly using ShowWindow(SW_RESTORE) works, but it means
     * we cannot test for the absence of WM_WINDOWPOSCHANGED messages. */
    expect_messages = reactivate_messages_filtered;
    ShowWindow(focus_window, SW_RESTORE);
    SetForegroundWindow(focus_window);
    flush_events();
    ok(!expect_messages->message, "Expected message %#x for window %#x, but didn't receive it\n",
            expect_messages->message, expect_messages->window);
    expect_messages = NULL;

    filter_messages = focus_window;
    hr = IDirect3DDevice8_TestCooperativeLevel(device);
    ok(hr == D3DERR_DEVICENOTRESET, "Got unexpected hr %#lx.\n", hr);

    filter_messages = NULL;
    hr = reset_device(device, &device_desc);
    ok(SUCCEEDED(hr), "Failed to reset device, hr %#lx.\n", hr);

    ref = IDirect3DDevice8_Release(device);
    ok(!ref, "Got unexpected refcount %lu.\n", ref);
    filter_messages = NULL;

    ShowWindow(device_window, SW_RESTORE);
    SetForegroundWindow(focus_window);
    flush_events();

    filter_messages = focus_window;
    device_desc.device_window = device_window;
    if (!(device = create_device(d3d8, focus_window, &device_desc)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }
    filter_messages = NULL;
    flush_events();

    device_desc.width = user32_width;
    device_desc.height = user32_height;

    expect_messages = mode_change_messages;
    filter_messages = focus_window;
    hr = reset_device(device, &device_desc);
    ok(SUCCEEDED(hr), "Failed to reset device, hr %#lx.\n", hr);
    filter_messages = NULL;

    flush_events();
    ok(!expect_messages->message, "Expected message %#x for window %#x, but didn't receive it, i=%u.\n",
            expect_messages->message, expect_messages->window, i);
    expect_messages = NULL;

    /* World of Warplanes hides the window by removing WS_VISIBLE and expects Reset() to show it again. */
    device_style = GetWindowLongA(device_window, GWL_STYLE);
    SetWindowLongA(device_window, GWL_STYLE, device_style & ~WS_VISIBLE);

    flush_events();
    device_desc.width = d3d_width;
    device_desc.height = d3d_height;
    memset(&windowpos, 0, sizeof(windowpos));

    expect_messages = mode_change_messages_hidden;
    filter_messages = focus_window;
    hr = reset_device(device, &device_desc);
    ok(SUCCEEDED(hr), "Failed to reset device, hr %#lx.\n", hr);
    filter_messages = NULL;

    flush_events();
    ok(!expect_messages->message, "Expected message %#x for window %#x, but didn't receive it.\n",
            expect_messages->message, expect_messages->window);
    expect_messages = NULL;

    ok(windowpos.hwnd == device_window && !windowpos.hwndInsertAfter
            && !windowpos.x && !windowpos.y && !windowpos.cx && !windowpos.cy
            && windowpos.flags == (SWP_SHOWWINDOW | SWP_NOMOVE | SWP_NOSIZE),
            "Got unexpected WINDOWPOS hwnd=%p, insertAfter=%p, x=%d, y=%d, cx=%d, cy=%d, flags=%x\n",
            windowpos.hwnd, windowpos.hwndInsertAfter, windowpos.x, windowpos.y, windowpos.cx,
            windowpos.cy, windowpos.flags);

    device_style = GetWindowLongA(device_window, GWL_STYLE);
    ok(device_style & WS_VISIBLE, "Expected the device window to be visible.\n");

    proc = SetWindowLongPtrA(focus_window, GWLP_WNDPROC, (LONG_PTR)DefWindowProcA);
    ok(proc != (LONG_PTR)test_proc, "Expected wndproc != %#Ix.\n", (LONG_PTR)test_proc);

    ref = IDirect3DDevice8_Release(device);
    ok(!ref, "Got unexpected refcount %lu.\n", ref);

    proc = GetWindowLongPtrA(focus_window, GWLP_WNDPROC);
    ok(proc == (LONG_PTR)DefWindowProcA, "Expected wndproc %#Ix, got %#Ix.\n",
            (LONG_PTR)DefWindowProcA, proc);

done:
    filter_messages = NULL;
    expect_messages = NULL;
    IDirect3D8_Release(d3d8);

    SetEvent(thread_params.test_finished);
    WaitForSingleObject(thread, INFINITE);
    CloseHandle(thread_params.test_finished);
    CloseHandle(thread_params.window_created);
    CloseHandle(thread);

    DestroyWindow(device_window);
    DestroyWindow(focus_window);
    UnregisterClassA("d3d8_test_wndproc_wc", GetModuleHandleA(NULL));
    change_ret = ChangeDisplaySettingsExW(NULL, NULL, NULL, 0, NULL);
    ok(change_ret == DISP_CHANGE_SUCCESSFUL, "ChangeDisplaySettingsExW failed with %ld.\n", change_ret);
}

static void test_wndproc_windowed(void)
{
    struct wndproc_thread_param thread_params;
    struct device_desc device_desc;
    IDirect3DDevice8 *device;
    WNDCLASSA wc = {0};
    IDirect3D8 *d3d8;
    HANDLE thread;
    LONG_PTR proc;
    HRESULT hr;
    ULONG ref;
    DWORD res, tid;
    HWND tmp;

    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");

    filter_messages = NULL;
    expect_messages = NULL;

    wc.lpfnWndProc = test_proc;
    wc.lpszClassName = "d3d8_test_wndproc_wc";
    ok(RegisterClassA(&wc), "Failed to register window class.\n");

    thread_params.window_created = CreateEventA(NULL, FALSE, FALSE, NULL);
    ok(!!thread_params.window_created, "CreateEvent failed, last error %#lx.\n", GetLastError());
    thread_params.test_finished = CreateEventA(NULL, FALSE, FALSE, NULL);
    ok(!!thread_params.test_finished, "CreateEvent failed, last error %#lx.\n", GetLastError());

    focus_window = CreateWindowA("d3d8_test_wndproc_wc", "d3d8_test",
            WS_MAXIMIZE | WS_VISIBLE | WS_CAPTION, 0, 0, registry_mode.dmPelsWidth,
            registry_mode.dmPelsHeight, 0, 0, 0, 0);
    device_window = CreateWindowA("d3d8_test_wndproc_wc", "d3d8_test",
            WS_MAXIMIZE | WS_VISIBLE | WS_CAPTION, 0, 0, registry_mode.dmPelsWidth,
            registry_mode.dmPelsHeight, 0, 0, 0, 0);
    flush_events();

    thread = CreateThread(NULL, 0, wndproc_thread, &thread_params, 0, &tid);
    ok(!!thread, "Failed to create thread, last error %#lx.\n", GetLastError());

    res = WaitForSingleObject(thread_params.window_created, INFINITE);
    ok(res == WAIT_OBJECT_0, "Wait failed (%#lx), last error %#lx.\n", res, GetLastError());
    flush_events();

    proc = GetWindowLongPtrA(device_window, GWLP_WNDPROC);
    ok(proc == (LONG_PTR)test_proc, "Expected wndproc %#Ix, got %#Ix.\n",
            (LONG_PTR)test_proc, proc);
    proc = GetWindowLongPtrA(focus_window, GWLP_WNDPROC);
    ok(proc == (LONG_PTR)test_proc, "Expected wndproc %#Ix, got %#Ix.\n",
            (LONG_PTR)test_proc, proc);

    trace("device_window %p, focus_window %p, dummy_window %p.\n",
            device_window, focus_window, thread_params.dummy_window);

    tmp = GetFocus();
    ok(tmp == NULL, "Expected focus %p, got %p.\n", NULL, tmp);
    tmp = GetForegroundWindow();
    ok(tmp == thread_params.dummy_window, "Expected foreground window %p, got %p.\n",
            thread_params.dummy_window, tmp);

    filter_messages = focus_window;

    device_desc.adapter_ordinal = D3DADAPTER_DEFAULT;
    device_desc.device_window = device_window;
    device_desc.width = registry_mode.dmPelsWidth;
    device_desc.height = registry_mode.dmPelsHeight;
    device_desc.flags = 0;
    if (!(device = create_device(d3d8, focus_window, &device_desc)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    tmp = GetFocus();
    ok(tmp == NULL, "Expected focus %p, got %p.\n", NULL, tmp);
    tmp = GetForegroundWindow();
    ok(tmp == thread_params.dummy_window, "Expected foreground window %p, got %p.\n",
            thread_params.dummy_window, tmp);

    proc = GetWindowLongPtrA(device_window, GWLP_WNDPROC);
    ok(proc == (LONG_PTR)test_proc, "Expected wndproc %#Ix, got %#Ix.\n",
            (LONG_PTR)test_proc, proc);

    proc = GetWindowLongPtrA(focus_window, GWLP_WNDPROC);
    ok(proc == (LONG_PTR)test_proc, "Expected wndproc %#Ix, got %#Ix.\n",
            (LONG_PTR)test_proc, proc);

    filter_messages = NULL;

    device_desc.flags = CREATE_DEVICE_FULLSCREEN;
    hr = reset_device(device, &device_desc);
    ok(SUCCEEDED(hr), "Failed to reset device, hr %#lx.\n", hr);

    proc = GetWindowLongPtrA(device_window, GWLP_WNDPROC);
    ok(proc == (LONG_PTR)test_proc, "Expected wndproc %#Ix, got %#Ix.\n",
            (LONG_PTR)test_proc, proc);

    proc = GetWindowLongPtrA(focus_window, GWLP_WNDPROC);
    ok(proc != (LONG_PTR)test_proc, "Expected wndproc != %#Ix.\n", (LONG_PTR)test_proc);

    device_desc.flags = 0;
    hr = reset_device(device, &device_desc);
    ok(SUCCEEDED(hr), "Failed to reset device, hr %#lx.\n", hr);

    proc = GetWindowLongPtrA(device_window, GWLP_WNDPROC);
    ok(proc == (LONG_PTR)test_proc, "Expected wndproc %#Ix, got %#Ix.\n",
            (LONG_PTR)test_proc, proc);

    proc = GetWindowLongPtrA(focus_window, GWLP_WNDPROC);
    ok(proc == (LONG_PTR)test_proc, "Expected wndproc %#Ix, got %#Ix.\n",
            (LONG_PTR)test_proc, proc);

    filter_messages = focus_window;

    ref = IDirect3DDevice8_Release(device);
    ok(!ref, "Got unexpected refcount %lu.\n", ref);

    filter_messages = device_window;

    device_desc.device_window = focus_window;
    if (!(device = create_device(d3d8, focus_window, &device_desc)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    filter_messages = NULL;

    device_desc.flags = CREATE_DEVICE_FULLSCREEN;
    hr = reset_device(device, &device_desc);
    ok(SUCCEEDED(hr), "Failed to reset device, hr %#lx.\n", hr);

    proc = GetWindowLongPtrA(device_window, GWLP_WNDPROC);
    ok(proc == (LONG_PTR)test_proc, "Expected wndproc %#Ix, got %#Ix.\n",
            (LONG_PTR)test_proc, proc);

    proc = GetWindowLongPtrA(focus_window, GWLP_WNDPROC);
    ok(proc != (LONG_PTR)test_proc, "Expected wndproc != %#Ix.\n", (LONG_PTR)test_proc);

    device_desc.flags = 0;
    hr = reset_device(device, &device_desc);
    ok(SUCCEEDED(hr), "Failed to reset device, hr %#lx.\n", hr);

    proc = GetWindowLongPtrA(device_window, GWLP_WNDPROC);
    ok(proc == (LONG_PTR)test_proc, "Expected wndproc %#Ix, got %#Ix.\n",
            (LONG_PTR)test_proc, proc);

    proc = GetWindowLongPtrA(focus_window, GWLP_WNDPROC);
    ok(proc == (LONG_PTR)test_proc, "Expected wndproc %#Ix, got %#Ix.\n",
            (LONG_PTR)test_proc, proc);

    filter_messages = device_window;

    ref = IDirect3DDevice8_Release(device);
    ok(!ref, "Got unexpected refcount %lu.\n", ref);

    device_desc.device_window = device_window;
    if (!(device = create_device(d3d8, focus_window, &device_desc)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    filter_messages = NULL;

    device_desc.flags = CREATE_DEVICE_FULLSCREEN;
    hr = reset_device(device, &device_desc);
    ok(SUCCEEDED(hr), "Failed to reset device, hr %#lx.\n", hr);

    proc = GetWindowLongPtrA(device_window, GWLP_WNDPROC);
    ok(proc == (LONG_PTR)test_proc, "Expected wndproc %#Ix, got %#Ix.\n",
            (LONG_PTR)test_proc, proc);

    proc = GetWindowLongPtrA(focus_window, GWLP_WNDPROC);
    ok(proc != (LONG_PTR)test_proc, "Expected wndproc != %#Ix.\n", (LONG_PTR)test_proc);

    device_desc.flags = 0;
    hr = reset_device(device, &device_desc);
    ok(SUCCEEDED(hr), "Failed to reset device, hr %#lx.\n", hr);

    proc = GetWindowLongPtrA(device_window, GWLP_WNDPROC);
    ok(proc == (LONG_PTR)test_proc, "Expected wndproc %#Ix, got %#Ix.\n",
            (LONG_PTR)test_proc, proc);

    proc = GetWindowLongPtrA(focus_window, GWLP_WNDPROC);
    ok(proc == (LONG_PTR)test_proc, "Expected wndproc %#Ix, got %#Ix.\n",
            (LONG_PTR)test_proc, proc);

    filter_messages = device_window;

    ref = IDirect3DDevice8_Release(device);
    ok(!ref, "Got unexpected refcount %lu.\n", ref);

done:
    filter_messages = NULL;
    IDirect3D8_Release(d3d8);

    SetEvent(thread_params.test_finished);
    WaitForSingleObject(thread, INFINITE);
    CloseHandle(thread_params.test_finished);
    CloseHandle(thread_params.window_created);
    CloseHandle(thread);

    DestroyWindow(device_window);
    DestroyWindow(focus_window);
    UnregisterClassA("d3d8_test_wndproc_wc", GetModuleHandleA(NULL));
}

static const GUID d3d8_private_data_test_guid =
{
    0xfdb37466,
    0x428f,
    0x4edf,
    {0xa3,0x7f,0x9b,0x1d,0xf4,0x88,0xc5,0xfc}
};

#if defined(__i386__) || (defined(__x86_64__) && !defined(__arm64ec__) && (defined(__GNUC__) || defined(__clang__)))

static inline void set_fpu_cw(WORD cw)
{
#if defined(_MSC_VER) && defined(__i386__)
    __asm fnclex;
    __asm fldcw cw;
#else
    __asm__ volatile ("fnclex");
    __asm__ volatile ("fldcw %0" : : "m" (cw));
#endif
}

static inline WORD get_fpu_cw(void)
{
    WORD cw = 0;
#if defined(_MSC_VER) && defined(__i386__)
    __asm fnstcw cw;
#else
    __asm__ volatile ("fnstcw %0" : "=m" (cw));
#endif
    return cw;
}

static WORD callback_cw, callback_set_cw;
static DWORD callback_tid;

static HRESULT WINAPI dummy_object_QueryInterface(IUnknown *iface, REFIID riid, void **out)
{
    *out = NULL;
    return E_NOINTERFACE;
}

static ULONG WINAPI dummy_object_AddRef(IUnknown *iface)
{
    callback_cw = get_fpu_cw();
    set_fpu_cw(callback_set_cw);
    callback_tid = GetCurrentThreadId();
    return 2;
}

static ULONG WINAPI dummy_object_Release(IUnknown *iface)
{
    callback_cw = get_fpu_cw();
    set_fpu_cw(callback_set_cw);
    callback_tid = GetCurrentThreadId();
    return 1;
}

static const IUnknownVtbl dummy_object_vtbl =
{
    dummy_object_QueryInterface,
    dummy_object_AddRef,
    dummy_object_Release,
};

static void test_fpu_setup(void)
{
    struct device_desc device_desc;
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d8;
    HWND window;
    HRESULT hr;
    WORD cw;
    IDirect3DSurface8 *surface;
    IUnknown dummy_object = {&dummy_object_vtbl};

    window = create_window();
    ok(!!window, "Failed to create a window.\n");
    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");

    device_desc.adapter_ordinal = D3DADAPTER_DEFAULT;
    device_desc.device_window = window;
    device_desc.width = 640;
    device_desc.height = 480;
    device_desc.flags = 0;

    set_fpu_cw(0xf60);
    cw = get_fpu_cw();
    ok(cw == 0xf60, "cw is %#x, expected 0xf60.\n", cw);

    if (!(device = create_device(d3d8, window, &device_desc)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        set_fpu_cw(0x37f);
        goto done;
    }

    cw = get_fpu_cw();
    ok(cw == 0x7f, "cw is %#x, expected 0x7f.\n", cw);

    hr = IDirect3DDevice8_GetRenderTarget(device, &surface);
    ok(SUCCEEDED(hr), "Failed to get render target surface, hr %#lx.\n", hr);

    callback_set_cw = 0xf60;
    hr = IDirect3DSurface8_SetPrivateData(surface, &d3d8_private_data_test_guid,
            &dummy_object, sizeof(IUnknown *), D3DSPD_IUNKNOWN);
    ok(SUCCEEDED(hr), "Failed to set private data, hr %#lx.\n", hr);
    ok(callback_cw == 0x7f, "Callback cw is %#x, expected 0x7f.\n", callback_cw);
    ok(callback_tid == GetCurrentThreadId(), "Got unexpected thread id.\n");
    cw = get_fpu_cw();
    ok(cw == 0xf60, "cw is %#x, expected 0xf60.\n", cw);

    callback_cw = 0;
    hr = IDirect3DSurface8_SetPrivateData(surface, &d3d8_private_data_test_guid,
            &dummy_object, sizeof(IUnknown *), D3DSPD_IUNKNOWN);
    ok(SUCCEEDED(hr), "Failed to set private data, hr %#lx.\n", hr);
    ok(callback_cw == 0xf60, "Callback cw is %#x, expected 0xf60.\n", callback_cw);
    ok(callback_tid == GetCurrentThreadId(), "Got unexpected thread id.\n");

    callback_set_cw = 0x7f;
    set_fpu_cw(0x7f);

    IDirect3DSurface8_Release(surface);

    callback_cw = 0;
    IDirect3DDevice8_Release(device);
    ok(callback_cw == 0x7f, "Callback cw is %#x, expected 0x7f.\n", callback_cw);
    ok(callback_tid == GetCurrentThreadId(), "Got unexpected thread id.\n");

    cw = get_fpu_cw();
    ok(cw == 0x7f, "cw is %#x, expected 0x7f.\n", cw);
    set_fpu_cw(0xf60);
    cw = get_fpu_cw();
    ok(cw == 0xf60, "cw is %#x, expected 0xf60.\n", cw);

    device_desc.flags = CREATE_DEVICE_FPU_PRESERVE;
    device = create_device(d3d8, window, &device_desc);
    ok(!!device, "CreateDevice failed.\n");

    cw = get_fpu_cw();
    ok(cw == 0xf60, "cw is %#x, expected 0xf60.\n", cw);

    hr = IDirect3DDevice8_GetRenderTarget(device, &surface);
    ok(SUCCEEDED(hr), "Failed to get render target surface, hr %#lx.\n", hr);

    callback_cw = 0;
    callback_set_cw = 0x37f;
    hr = IDirect3DSurface8_SetPrivateData(surface, &d3d8_private_data_test_guid,
            &dummy_object, sizeof(IUnknown *), D3DSPD_IUNKNOWN);
    ok(SUCCEEDED(hr), "Failed to set private data, hr %#lx.\n", hr);
    ok(callback_cw == 0xf60, "Callback cw is %#x, expected 0xf60.\n", callback_cw);
    ok(callback_tid == GetCurrentThreadId(), "Got unexpected thread id.\n");
    cw = get_fpu_cw();
    ok(cw == 0x37f, "cw is %#x, expected 0x37f.\n", cw);

    IDirect3DSurface8_Release(surface);

    callback_cw = 0;
    IDirect3DDevice8_Release(device);
    ok(callback_cw == 0x37f, "Callback cw is %#x, expected 0x37f.\n", callback_cw);
    ok(callback_tid == GetCurrentThreadId(), "Got unexpected thread id.\n");

done:
    DestroyWindow(window);
    IDirect3D8_Release(d3d8);
}

#else

static void test_fpu_setup(void)
{
}

#endif

static void test_ApplyStateBlock(void)
{
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d8;
    HWND window;
    HRESULT hr;
    DWORD received, token;

    window = create_window();
    ok(!!window, "Failed to create a window.\n");
    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d8, window, NULL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        goto cleanup;
    }

    IDirect3DDevice8_BeginStateBlock(device);
    IDirect3DDevice8_SetRenderState(device, D3DRS_ZENABLE, TRUE);
    IDirect3DDevice8_EndStateBlock(device, &token);
    ok(token, "Received zero stateblock handle.\n");
    IDirect3DDevice8_SetRenderState(device, D3DRS_ZENABLE, FALSE);

    hr = IDirect3DDevice8_GetRenderState(device, D3DRS_ZENABLE, &received);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    ok(!received, "Expected = FALSE, received TRUE.\n");

    hr = IDirect3DDevice8_ApplyStateBlock(device, 0);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_GetRenderState(device, D3DRS_ZENABLE, &received);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    ok(!received, "Expected FALSE, received TRUE.\n");

    hr = IDirect3DDevice8_ApplyStateBlock(device, token);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_GetRenderState(device, D3DRS_ZENABLE, &received);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    ok(received, "Expected TRUE, received FALSE.\n");

    IDirect3DDevice8_DeleteStateBlock(device, token);
    IDirect3DDevice8_Release(device);
cleanup:
    IDirect3D8_Release(d3d8);
    DestroyWindow(window);
}

static void test_depth_stencil_size(void)
{
    IDirect3DDevice8 *device;
    IDirect3DSurface8 *ds, *rt, *ds_bigger, *ds_bigger2;
    IDirect3DSurface8 *surf;
    IDirect3D8 *d3d8;
    HRESULT hr;
    HWND hwnd;

    hwnd = CreateWindowA("d3d8_test_wc", "d3d8_test", WS_OVERLAPPEDWINDOW,
            100, 100, 160, 160, NULL, NULL, NULL, NULL);
    ok(!!hwnd, "Failed to create a window.\n");
    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");

    if (!(device = create_device(d3d8, hwnd, NULL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        goto cleanup;
    }

    hr = IDirect3DDevice8_CreateRenderTarget(device, 64, 64, D3DFMT_A8R8G8B8, D3DMULTISAMPLE_NONE, FALSE, &rt);
    ok(SUCCEEDED(hr), "IDirect3DDevice8_CreateRenderTarget failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateDepthStencilSurface(device, 32, 32, D3DFMT_D24X8, D3DMULTISAMPLE_NONE, &ds);
    ok(SUCCEEDED(hr), "IDirect3DDevice8_CreateDepthStencilSurface failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateDepthStencilSurface(device, 128, 128, D3DFMT_D24X8, D3DMULTISAMPLE_NONE, &ds_bigger);
    ok(SUCCEEDED(hr), "IDirect3DDevice8_CreateDepthStencilSurface failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateDepthStencilSurface(device, 128, 128, D3DFMT_D24X8, D3DMULTISAMPLE_NONE, &ds_bigger2);
    ok(SUCCEEDED(hr), "IDirect3DDevice8_CreateDepthStencilSurface failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderTarget(device, rt, ds);
    ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderTarget(device, rt, ds_bigger);
    ok(SUCCEEDED(hr), "IDirect3DDevice8_SetRenderTarget failed, hr %#lx.\n", hr);

    /* try to set the small ds without changing the render target at the same time */
    hr = IDirect3DDevice8_SetRenderTarget(device, NULL, ds);
    ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderTarget(device, NULL, ds_bigger2);
    ok(SUCCEEDED(hr), "IDirect3DDevice8_SetRenderTarget failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetRenderTarget(device, &surf);
    ok(hr == D3D_OK, "IDirect3DDevice8_GetRenderTarget failed, hr %#lx.\n", hr);
    ok(surf == rt, "The render target is %p, expected %p\n", surf, rt);
    IDirect3DSurface8_Release(surf);
    hr = IDirect3DDevice8_GetDepthStencilSurface(device, &surf);
    ok(hr == D3D_OK, "IDirect3DDevice8_GetDepthStencilSurface failed, hr %#lx.\n", hr);
    ok(surf == ds_bigger2, "The depth stencil is %p, expected %p\n", surf, ds_bigger2);
    IDirect3DSurface8_Release(surf);

    hr = IDirect3DDevice8_SetRenderTarget(device, NULL, NULL);
    ok(SUCCEEDED(hr), "IDirect3DDevice8_SetRenderTarget failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_GetDepthStencilSurface(device, &surf);
    ok(FAILED(hr), "IDirect3DDevice8_GetDepthStencilSurface should have failed, hr %#lx.\n", hr);
    ok(surf == NULL, "The depth stencil is %p, expected NULL\n", surf);
    if (surf) IDirect3DSurface8_Release(surf);

    IDirect3DSurface8_Release(rt);
    IDirect3DSurface8_Release(ds);
    IDirect3DSurface8_Release(ds_bigger);
    IDirect3DSurface8_Release(ds_bigger2);

cleanup:
    IDirect3D8_Release(d3d8);
    DestroyWindow(hwnd);
}

static void test_window_style(void)
{
    RECT focus_rect, fullscreen_rect, r;
    LONG device_style, device_exstyle;
    LONG focus_style, focus_exstyle;
    struct device_desc device_desc;
    LONG style, expected_style;
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d8;
    HRESULT hr;
    ULONG ref;
    BOOL ret;

    focus_window = CreateWindowA("d3d8_test_wc", "d3d8_test", WS_OVERLAPPEDWINDOW,
            0, 0, registry_mode.dmPelsWidth / 2, registry_mode.dmPelsHeight / 2, 0, 0, 0, 0);
    device_window = CreateWindowA("d3d8_test_wc", "d3d8_test", WS_OVERLAPPEDWINDOW,
            0, 0, registry_mode.dmPelsWidth / 2, registry_mode.dmPelsHeight / 2, 0, 0, 0, 0);
    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");

    device_style = GetWindowLongA(device_window, GWL_STYLE);
    device_exstyle = GetWindowLongA(device_window, GWL_EXSTYLE);
    focus_style = GetWindowLongA(focus_window, GWL_STYLE);
    focus_exstyle = GetWindowLongA(focus_window, GWL_EXSTYLE);

    SetRect(&fullscreen_rect, 0, 0, registry_mode.dmPelsWidth, registry_mode.dmPelsHeight);
    GetWindowRect(focus_window, &focus_rect);

    device_desc.adapter_ordinal = D3DADAPTER_DEFAULT;
    device_desc.device_window = device_window;
    device_desc.width = registry_mode.dmPelsWidth;
    device_desc.height = registry_mode.dmPelsHeight;
    device_desc.flags = CREATE_DEVICE_FULLSCREEN;
    if (!(device = create_device(d3d8, focus_window, &device_desc)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    style = GetWindowLongA(device_window, GWL_STYLE);
    expected_style = device_style | WS_VISIBLE;
    todo_wine ok(style == expected_style || broken(style == (expected_style & ~WS_OVERLAPPEDWINDOW)) /* w1064v1809 */,
            "Expected device window style %#lx, got %#lx.\n",
            expected_style, style);
    style = GetWindowLongA(device_window, GWL_EXSTYLE);
    expected_style = device_exstyle | WS_EX_TOPMOST;
    todo_wine ok(style == expected_style || broken(style == (expected_style & ~WS_EX_OVERLAPPEDWINDOW)) /* w1064v1809 */,
            "Expected device window extended style %#lx, got %#lx.\n",
            expected_style, style);

    style = GetWindowLongA(focus_window, GWL_STYLE);
    ok(style == focus_style, "Expected focus window style %#lx, got %#lx.\n",
            focus_style, style);
    style = GetWindowLongA(focus_window, GWL_EXSTYLE);
    ok(style == focus_exstyle, "Expected focus window extended style %#lx, got %#lx.\n",
            focus_exstyle, style);

    GetWindowRect(device_window, &r);
    ok(EqualRect(&r, &fullscreen_rect), "Expected %s, got %s.\n",
            wine_dbgstr_rect(&fullscreen_rect), wine_dbgstr_rect(&r));
    GetClientRect(device_window, &r);
    todo_wine ok(!EqualRect(&r, &fullscreen_rect) || broken(!(style & WS_THICKFRAME)) /* w1064v1809 */,
        "Client rect and window rect are equal.\n");
    GetWindowRect(focus_window, &r);
    ok(EqualRect(&r, &focus_rect), "Expected %s, got %s.\n", wine_dbgstr_rect(&focus_rect),
            wine_dbgstr_rect(&r));

    device_desc.flags = 0;
    hr = reset_device(device, &device_desc);
    ok(SUCCEEDED(hr), "Failed to reset device, hr %#lx.\n", hr);

    style = GetWindowLongA(device_window, GWL_STYLE);
    expected_style = device_style | WS_VISIBLE;
    ok(style == expected_style, "Expected device window style %#lx, got %#lx.\n",
            expected_style, style);
    style = GetWindowLongA(device_window, GWL_EXSTYLE);
    expected_style = device_exstyle | WS_EX_TOPMOST;
    ok(style == expected_style, "Expected device window extended style %#lx, got %#lx.\n",
            expected_style, style);

    style = GetWindowLongA(focus_window, GWL_STYLE);
    ok(style == focus_style, "Expected focus window style %#lx, got %#lx.\n",
            focus_style, style);
    style = GetWindowLongA(focus_window, GWL_EXSTYLE);
    ok(style == focus_exstyle, "Expected focus window extended style %#lx, got %#lx.\n",
            focus_exstyle, style);

    device_desc.flags = CREATE_DEVICE_FULLSCREEN;
    hr = reset_device(device, &device_desc);
    ok(SUCCEEDED(hr), "Failed to reset device, hr %#lx.\n", hr);
    ret = SetForegroundWindow(GetDesktopWindow());
    ok(ret, "Failed to set foreground window.\n");

    style = GetWindowLongA(device_window, GWL_STYLE);
    expected_style = device_style | WS_MINIMIZE | WS_VISIBLE;
    todo_wine ok(style == expected_style, "Expected device window style %#lx, got %#lx.\n",
            expected_style, style);
    style = GetWindowLongA(device_window, GWL_EXSTYLE);
    expected_style = device_exstyle | WS_EX_TOPMOST;
    todo_wine ok(style == expected_style, "Expected device window extended style %#lx, got %#lx.\n",
            expected_style, style);

    style = GetWindowLongA(focus_window, GWL_STYLE);
    ok(style == focus_style, "Expected focus window style %#lx, got %#lx.\n",
            focus_style, style);
    style = GetWindowLongA(focus_window, GWL_EXSTYLE);
    ok(style == focus_exstyle, "Expected focus window extended style %#lx, got %#lx.\n",
            focus_exstyle, style);

    /* Follow-up tests fail on native if the device is destroyed while lost. */
    ShowWindow(focus_window, SW_MINIMIZE);
    ShowWindow(focus_window, SW_RESTORE);
    ret = SetForegroundWindow(focus_window);
    ok(ret, "Failed to set foreground window.\n");
    flush_events();
    hr = reset_device(device, &device_desc);
    ok(SUCCEEDED(hr), "Failed to reset device, hr %#lx.\n", hr);

    ref = IDirect3DDevice8_Release(device);
    ok(!ref, "Got unexpected refcount %lu.\n", ref);

done:
    IDirect3D8_Release(d3d8);

    DestroyWindow(device_window);
    DestroyWindow(focus_window);
}

static void test_unsupported_shaders(void)
{
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d;
    ULONG refcount;
    DWORD vs, ps;
    HWND window;
    HRESULT hr;
    D3DCAPS8 caps;

    static const DWORD vs_2_0[] =
    {
        0xfffe0200,                                         /* vs_2_0           */
        0x0200001f, 0x80000000, 0x900f0000,                 /* dcl_position v0  */
        0x02000001, 0x800f0001, 0xa0e40001,                 /* mov r1, c1       */
        0x03000002, 0xd00f0000, 0x80e40001, 0xa0e40002,     /* add oD0, r1, c2  */
        0x02000001, 0xc00f0000, 0x90e40000,                 /* mov oPos, v0     */
        0x0000ffff                                          /* end              */
    };
    static const DWORD ps_2_0[] =
    {
        0xffff0200,                                         /* ps_2_0           */
        0x02000001, 0x800f0001, 0xa0e40001,                 /* mov r1, c1       */
        0x03000002, 0x800f0000, 0x80e40001, 0xa0e40002,     /* add r0, r1, c2   */
        0x02000001, 0x800f0800, 0x80e40000,                 /* mov oC0, r0      */
        0x0000ffff                                          /* end              */
    };
#if 0
    vs_1_1
    dcl_position v0
    def c255, 1.0, 1.0, 1.0, 1.0
    add r0, v0, c255
    mov oPos, r0
#endif
    static const DWORD vs_1_255[] =
    {
        0xfffe0101,
        0x0000001f, 0x80000000, 0x900f0000,
        0x00000051, 0xa00f00ff, 0x3f800000, 0x3f800000, 0x3f800000, 0x3f800000,
        0x00000002, 0x800f0000, 0x90e40000, 0xa0e400ff,
        0x00000001, 0xc00f0000, 0x80e40000,
        0x0000ffff
    };
#if 0
    vs_1_1
    dcl_position v0
    def c256, 1.0, 1.0, 1.0, 1.0
    add r0, v0, c256
    mov oPos, r0
#endif
    static const DWORD vs_1_256[] =
    {
        0xfffe0101,
        0x0000001f, 0x80000000, 0x900f0000,
        0x00000051, 0xa00f0100, 0x3f800000, 0x3f800000, 0x3f800000, 0x3f800000,
        0x00000002, 0x800f0000, 0x90e40000, 0xa0e40100,
        0x00000001, 0xc00f0000, 0x80e40000,
        0x0000ffff
    };

    static const DWORD decl[] =
    {
        D3DVSD_STREAM(0),
        D3DVSD_REG(D3DVSDE_POSITION, D3DVSDT_FLOAT3),
        D3DVSD_END()
    };

    window = create_window();
    ok(!!window, "Failed to create a window.\n");
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_CreateVertexShader(device, decl, simple_ps, &vs, 0);
    ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CreatePixelShader(device, simple_vs, &ps);
    ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CreateVertexShader(device, decl, vs_2_0, &vs, 0);
    ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CreatePixelShader(device, ps_2_0, &ps);
    ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get device caps, hr %#lx.\n", hr);
    if (caps.MaxVertexShaderConst < 256)
    {
        hr = IDirect3DDevice8_CreateVertexShader(device, decl, vs_1_255, &vs, 0);
        ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);
    }
    else
    {
        hr = IDirect3DDevice8_CreateVertexShader(device, decl, vs_1_255, &vs, 0);
        ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
        hr = IDirect3DDevice8_DeleteVertexShader(device, vs);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
        hr = IDirect3DDevice8_CreateVertexShader(device, decl, vs_1_256, &vs, 0);
        ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);
    }

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_mode_change(void)
{
    unsigned int display_count = 0, d3d_width = 0, d3d_height = 0, user32_width = 0, user32_height = 0;
    DEVMODEW old_devmode, devmode, devmode2, *original_modes = NULL;
    struct device_desc device_desc, device_desc2;
    WCHAR second_monitor_name[CCHDEVICENAME];
    IDirect3DDevice8 *device, *device2;
    RECT d3d_rect, focus_rect, r;
    IDirect3DSurface8 *backbuffer;
    MONITORINFOEXW monitor_info;
    HMONITOR second_monitor;
    D3DSURFACE_DESC desc;
    IDirect3D8 *d3d8;
    ULONG refcount;
    UINT adapter_mode_count, i;
    HRESULT hr;
    BOOL ret;
    LONG change_ret;
    D3DDISPLAYMODE d3ddm;

    memset(&devmode, 0, sizeof(devmode));
    devmode.dmSize = sizeof(devmode);
    ret = EnumDisplaySettingsW(NULL, ENUM_CURRENT_SETTINGS, &devmode);
    ok(ret, "EnumDisplaySettingsW failed, error %#lx.\n", GetLastError());
    ok(equal_mode_rect(&devmode, &registry_mode), "Got a different mode.\n");
    ret = EnumDisplaySettingsW(NULL, ENUM_REGISTRY_SETTINGS, &devmode);
    ok(ret, "EnumDisplaySettingsW failed, error %#lx.\n", GetLastError());
    ok(equal_mode_rect(&devmode, &registry_mode), "Got a different mode.\n");

    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");

    adapter_mode_count = IDirect3D8_GetAdapterModeCount(d3d8, D3DADAPTER_DEFAULT);
    for (i = 0; i < adapter_mode_count; ++i)
    {
        hr = IDirect3D8_EnumAdapterModes(d3d8, D3DADAPTER_DEFAULT, i, &d3ddm);
        ok(SUCCEEDED(hr), "Failed to enumerate display mode, hr %#lx.\n", hr);

        if (d3ddm.Format != D3DFMT_X8R8G8B8)
            continue;
        if (d3ddm.Width == registry_mode.dmPelsWidth && d3ddm.Height == registry_mode.dmPelsHeight)
            continue;
        /* The r200 driver on Windows XP enumerates modes like 320x200 and 320x240 but
         * refuses to create a device at these sizes. */
        if (d3ddm.Width < 640 || d3ddm.Height < 480)
            continue;

        if (!user32_width)
        {
            user32_width = d3ddm.Width;
            user32_height = d3ddm.Height;
            continue;
        }

        /* Make sure the d3d mode is smaller in width or height and at most
         * equal in the other dimension than the mode passed to
         * ChangeDisplaySettings. Otherwise Windows shrinks the window to
         * the ChangeDisplaySettings parameters + 12. */
        if (d3ddm.Width == user32_width && d3ddm.Height == user32_height)
            continue;
        if (d3ddm.Width <= user32_width && d3ddm.Height <= user32_height)
        {
            d3d_width = d3ddm.Width;
            d3d_height = d3ddm.Height;
            break;
        }
        if (user32_width <= d3ddm.Width && user32_height <= d3ddm.Height)
        {
            d3d_width = user32_width;
            d3d_height = user32_height;
            user32_width = d3ddm.Width;
            user32_height = d3ddm.Height;
            break;
        }
    }

    if (!d3d_width)
    {
        skip("Could not find adequate modes, skipping mode tests.\n");
        IDirect3D8_Release(d3d8);
        return;
    }

    ret = save_display_modes(&original_modes, &display_count);
    ok(ret, "Failed to save original display modes.\n");

    memset(&devmode, 0, sizeof(devmode));
    devmode.dmSize = sizeof(devmode);
    devmode.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT;
    devmode.dmPelsWidth = user32_width;
    devmode.dmPelsHeight = user32_height;
    change_ret = ChangeDisplaySettingsW(&devmode, CDS_FULLSCREEN);
    ok(change_ret == DISP_CHANGE_SUCCESSFUL, "Failed to change display mode, ret %#lx.\n", change_ret);

    /* Make the windows visible, otherwise device::release does not restore the mode if
     * the application is not in foreground like on the testbot. */
    focus_window = CreateWindowA("d3d8_test_wc", "d3d8_test", WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            0, 0, user32_width / 2, user32_height / 2, 0, 0, 0, 0);
    device_window = CreateWindowA("d3d8_test_wc", "d3d8_test", WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            0, 0, user32_width / 2, user32_height / 2, 0, 0, 0, 0);

    SetRect(&d3d_rect, 0, 0, d3d_width, d3d_height);
    GetWindowRect(focus_window, &focus_rect);

    device_desc.adapter_ordinal = D3DADAPTER_DEFAULT;
    device_desc.device_window = device_window;
    device_desc.width = d3d_width;
    device_desc.height = d3d_height;
    device_desc.flags = CREATE_DEVICE_FULLSCREEN;
    if (!(device = create_device(d3d8, focus_window, &device_desc)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    devmode.dmPelsWidth = user32_width;
    devmode.dmPelsHeight = user32_height;
    change_ret = ChangeDisplaySettingsW(&devmode, CDS_FULLSCREEN);
    ok(change_ret == DISP_CHANGE_SUCCESSFUL, "Failed to change display mode, ret %#lx.\n", change_ret);

    ret = EnumDisplaySettingsW(NULL, ENUM_CURRENT_SETTINGS, &devmode);
    ok(ret, "Failed to get display mode.\n");
    ok(devmode.dmPelsWidth == user32_width && devmode.dmPelsHeight == user32_height,
            "Expected resolution %ux%u, got %lux%lu.\n",
            user32_width, user32_height, devmode.dmPelsWidth, devmode.dmPelsHeight);

    GetWindowRect(device_window, &r);
    ok(EqualRect(&r, &d3d_rect), "Expected %s, got %s.\n", wine_dbgstr_rect(&d3d_rect),
            wine_dbgstr_rect(&r));
    GetWindowRect(focus_window, &r);
    ok(EqualRect(&r, &focus_rect), "Expected %s, got %s.\n", wine_dbgstr_rect(&focus_rect),
            wine_dbgstr_rect(&r));

    hr = IDirect3DDevice8_GetBackBuffer(device, 0, D3DBACKBUFFER_TYPE_MONO, &backbuffer);
    ok(SUCCEEDED(hr), "Failed to get backbuffer, hr %#lx.\n", hr);
    hr = IDirect3DSurface8_GetDesc(backbuffer, &desc);
    ok(SUCCEEDED(hr), "Failed to get backbuffer desc, hr %#lx.\n", hr);
    ok(desc.Width == d3d_width, "Got unexpected backbuffer width %u, expected %u.\n",
            desc.Width, d3d_width);
    ok(desc.Height == d3d_height, "Got unexpected backbuffer height %u, expected %u.\n",
            desc.Height, d3d_height);
    IDirect3DSurface8_Release(backbuffer);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);

    ret = EnumDisplaySettingsW(NULL, ENUM_CURRENT_SETTINGS, &devmode);
    ok(ret, "Failed to get display mode.\n");
    ok(devmode.dmPelsWidth == registry_mode.dmPelsWidth
            && devmode.dmPelsHeight == registry_mode.dmPelsHeight,
            "Expected resolution %lux%lu, got %lux%lu.\n",
            registry_mode.dmPelsWidth, registry_mode.dmPelsHeight, devmode.dmPelsWidth, devmode.dmPelsHeight);

    change_ret = ChangeDisplaySettingsW(NULL, CDS_FULLSCREEN);
    ok(change_ret == DISP_CHANGE_SUCCESSFUL, "Failed to change display mode, ret %#lx.\n", change_ret);

    /* The mode restore also happens when the device was created at the original screen size. */

    device_desc.adapter_ordinal = D3DADAPTER_DEFAULT;
    device_desc.device_window = device_window;
    device_desc.width = registry_mode.dmPelsWidth;
    device_desc.height = registry_mode.dmPelsHeight;
    device_desc.flags = CREATE_DEVICE_FULLSCREEN;
    ok(!!(device = create_device(d3d8, focus_window, &device_desc)), "Failed to create a D3D device.\n");

    devmode.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT;
    devmode.dmPelsWidth = user32_width;
    devmode.dmPelsHeight = user32_height;
    change_ret = ChangeDisplaySettingsW(&devmode, CDS_FULLSCREEN);
    ok(change_ret == DISP_CHANGE_SUCCESSFUL, "Failed to change display mode, ret %#lx.\n", change_ret);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);

    memset(&devmode2, 0, sizeof(devmode2));
    devmode2.dmSize = sizeof(devmode2);
    ret = EnumDisplaySettingsW(NULL, ENUM_CURRENT_SETTINGS, &devmode2);
    ok(ret, "Failed to get display mode.\n");
    ok(devmode2.dmPelsWidth == registry_mode.dmPelsWidth
            && devmode2.dmPelsHeight == registry_mode.dmPelsHeight,
            "Expected resolution %lux%lu, got %lux%lu.\n", registry_mode.dmPelsWidth,
            registry_mode.dmPelsHeight, devmode2.dmPelsWidth, devmode2.dmPelsHeight);
    ret = restore_display_modes(original_modes, display_count);
    ok(ret, "Failed to restore display modes.\n");

    /* Test that no mode restorations if no mode changes happened */
    change_ret = ChangeDisplaySettingsW(&devmode, CDS_UPDATEREGISTRY | CDS_NORESET);
    ok(change_ret == DISP_CHANGE_SUCCESSFUL, "ChangeDisplaySettingsW failed with %ld.\n", change_ret);

    device_desc.adapter_ordinal = D3DADAPTER_DEFAULT;
    device_desc.device_window = device_window;
    device_desc.width = d3d_width;
    device_desc.height = d3d_height;
    device_desc.flags = 0;
    device = create_device(d3d8, device_window, &device_desc);
    ok(!!device, "Failed to create a D3D device.\n");
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);

    ret = EnumDisplaySettingsW(NULL, ENUM_CURRENT_SETTINGS, &devmode2);
    ok(ret, "EnumDisplaySettingsW failed, error %#lx.\n", GetLastError());
    ok(equal_mode_rect(&devmode2, &registry_mode), "Got a different mode.\n");
    ret = restore_display_modes(original_modes, display_count);
    ok(ret, "Failed to restore display modes.\n");

    /* Test that mode restorations use display settings in the registry with a fullscreen device */
    change_ret = ChangeDisplaySettingsW(&devmode, CDS_UPDATEREGISTRY | CDS_NORESET);
    ok(change_ret == DISP_CHANGE_SUCCESSFUL, "ChangeDisplaySettingsW failed with %ld.\n", change_ret);

    device_desc.adapter_ordinal = D3DADAPTER_DEFAULT;
    device_desc.device_window = device_window;
    device_desc.width = registry_mode.dmPelsWidth;
    device_desc.height = registry_mode.dmPelsHeight;
    device_desc.flags = CREATE_DEVICE_FULLSCREEN;
    device = create_device(d3d8, device_window, &device_desc);
    ok(!!device, "Failed to create a D3D device.\n");
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);

    ret = EnumDisplaySettingsW(NULL, ENUM_CURRENT_SETTINGS, &devmode2);
    ok(ret, "EnumDisplaySettingsW failed, error %#lx.\n", GetLastError());
    ok(equal_mode_rect(&devmode2, &devmode), "Got a different mode.\n");
    ret = EnumDisplaySettingsW(NULL, ENUM_REGISTRY_SETTINGS, &devmode2);
    ok(ret, "EnumDisplaySettingsW failed, error %#lx.\n", GetLastError());
    ok(equal_mode_rect(&devmode2, &devmode), "Got a different mode.\n");
    ret = restore_display_modes(original_modes, display_count);
    ok(ret, "Failed to restore display modes.\n");

    /* Test that mode restorations use display settings in the registry with a fullscreen device
     * having the same display mode and then reset to a different mode */
    change_ret = ChangeDisplaySettingsW(&devmode, CDS_UPDATEREGISTRY | CDS_NORESET);
    ok(change_ret == DISP_CHANGE_SUCCESSFUL, "ChangeDisplaySettingsW failed with %ld.\n", change_ret);

    device_desc.adapter_ordinal = D3DADAPTER_DEFAULT;
    device_desc.device_window = device_window;
    device_desc.width = registry_mode.dmPelsWidth;
    device_desc.height = registry_mode.dmPelsHeight;
    device_desc.flags = CREATE_DEVICE_FULLSCREEN;
    device = create_device(d3d8, device_window, &device_desc);
    ok(!!device, "Failed to create a D3D device.\n");

    device_desc.width = d3d_width;
    device_desc.height = d3d_height;
    hr = reset_device(device, &device_desc);
    ok(hr == D3D_OK, "Failed to reset device, hr %#lx.\n", hr);
    ret = EnumDisplaySettingsW(NULL, ENUM_CURRENT_SETTINGS, &devmode2);
    ok(ret, "EnumDisplaySettingsW failed, error %#lx.\n", GetLastError());
    ok(devmode2.dmPelsWidth == d3d_width && devmode2.dmPelsHeight == d3d_height,
            "Expected resolution %ux%u, got %lux%lu.\n", d3d_width, d3d_height,
            devmode2.dmPelsWidth, devmode2.dmPelsHeight);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);

    ret = EnumDisplaySettingsW(NULL, ENUM_CURRENT_SETTINGS, &devmode2);
    ok(ret, "EnumDisplaySettingsW failed, error %#lx.\n", GetLastError());
    ok(equal_mode_rect(&devmode2, &devmode), "Got a different mode.\n");
    ret = EnumDisplaySettingsW(NULL, ENUM_REGISTRY_SETTINGS, &devmode2);
    ok(ret, "EnumDisplaySettingsW failed, error %#lx.\n", GetLastError());
    ok(equal_mode_rect(&devmode2, &devmode), "Got a different mode.\n");
    ret = restore_display_modes(original_modes, display_count);
    ok(ret, "Failed to restore display modes.\n");

    if (IDirect3D8_GetAdapterCount(d3d8) < 2)
    {
        skip("Following tests require two adapters.\n");
        goto done;
    }

    second_monitor = IDirect3D8_GetAdapterMonitor(d3d8, 1);
    monitor_info.cbSize = sizeof(monitor_info);
    ret = GetMonitorInfoW(second_monitor, (MONITORINFO *)&monitor_info);
    ok(ret, "GetMonitorInfoW failed, error %#lx.\n", GetLastError());
    lstrcpyW(second_monitor_name, monitor_info.szDevice);

    memset(&old_devmode, 0, sizeof(old_devmode));
    old_devmode.dmSize = sizeof(old_devmode);
    ret = EnumDisplaySettingsW(second_monitor_name, ENUM_CURRENT_SETTINGS, &old_devmode);
    ok(ret, "EnumDisplaySettingsW failed, error %#lx.\n", GetLastError());

    i = 0;
    d3d_width = 0;
    d3d_height = 0;
    user32_width = 0;
    user32_height = 0;
    while (EnumDisplaySettingsW(second_monitor_name, i++, &devmode))
    {
        if (devmode.dmPelsWidth == old_devmode.dmPelsWidth
                && devmode.dmPelsHeight == old_devmode.dmPelsHeight)
            continue;

        if (!d3d_width && !d3d_height)
        {
            d3d_width = devmode.dmPelsWidth;
            d3d_height = devmode.dmPelsHeight;
            continue;
        }

        if (devmode.dmPelsWidth == d3d_width && devmode.dmPelsHeight == d3d_height)
            continue;

        user32_width = devmode.dmPelsWidth;
        user32_height = devmode.dmPelsHeight;
        break;
    }
    if (!user32_width || !user32_height)
    {
        skip("Failed to find three different display modes for the second monitor.\n");
        goto done;
    }

    /* Test that mode restorations also happen for non-primary monitors on device resets */
    device_desc.adapter_ordinal = D3DADAPTER_DEFAULT;
    device_desc.device_window = device_window;
    device_desc.width = registry_mode.dmPelsWidth;
    device_desc.height = registry_mode.dmPelsHeight;
    device_desc.flags = CREATE_DEVICE_FULLSCREEN;
    device = create_device(d3d8, device_window, &device_desc);
    ok(!!device, "Failed to create a D3D device.\n");

    change_ret = ChangeDisplaySettingsExW(second_monitor_name, &devmode, NULL, CDS_RESET, NULL);
    ok(change_ret == DISP_CHANGE_SUCCESSFUL, "ChangeDisplaySettingsExW failed with %ld.\n", change_ret);
    ret = EnumDisplaySettingsW(second_monitor_name, ENUM_CURRENT_SETTINGS, &devmode2);
    ok(ret, "EnumDisplaySettingsW failed, error %#lx.\n", GetLastError());
    if (devmode2.dmPelsWidth == old_devmode.dmPelsWidth
            && devmode2.dmPelsHeight == old_devmode.dmPelsHeight)
    {
        skip("Failed to change display settings of the second monitor.\n");
        refcount = IDirect3DDevice8_Release(device);
        ok(!refcount, "Device has %lu references left.\n", refcount);
        goto done;
    }

    device_desc.flags = 0;
    hr = reset_device(device, &device_desc);
    ok(hr == D3D_OK, "Failed to reset device, hr %#lx.\n", hr);

    ret = EnumDisplaySettingsW(second_monitor_name, ENUM_CURRENT_SETTINGS, &devmode2);
    ok(ret, "EnumDisplaySettingsW failed, error %#lx.\n", GetLastError());
    ok(equal_mode_rect(&devmode2, &old_devmode), "Got a different mode.\n");
    ret = EnumDisplaySettingsW(second_monitor_name, ENUM_REGISTRY_SETTINGS, &devmode2);
    ok(ret, "EnumDisplaySettingsW failed, error %#lx.\n", GetLastError());
    ok(equal_mode_rect(&devmode2, &old_devmode), "Got a different mode.\n");
    hr = IDirect3D8_GetAdapterDisplayMode(d3d8, 1, &d3ddm);
    ok(hr == S_OK, "GetAdapterDisplayMode failed, hr %#lx.\n", hr);
    ok(d3ddm.Width == old_devmode.dmPelsWidth, "Expected width %lu, got %u.\n",
            old_devmode.dmPelsWidth, d3ddm.Width);
    ok(d3ddm.Height == old_devmode.dmPelsHeight, "Expected height %lu, got %u.\n",
            old_devmode.dmPelsHeight, d3ddm.Height);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    ret = restore_display_modes(original_modes, display_count);
    ok(ret, "Failed to restore display modes.\n");

    /* Test that mode restorations happen for non-primary monitors on device releases */
    device_desc.adapter_ordinal = D3DADAPTER_DEFAULT;
    device_desc.device_window = device_window;
    device_desc.width = registry_mode.dmPelsWidth;
    device_desc.height = registry_mode.dmPelsHeight;
    device_desc.flags = CREATE_DEVICE_FULLSCREEN;
    device = create_device(d3d8, device_window, &device_desc);
    ok(!!device, "Failed to create a D3D device.\n");

    change_ret = ChangeDisplaySettingsExW(second_monitor_name, &devmode, NULL, CDS_RESET, NULL);
    ok(change_ret == DISP_CHANGE_SUCCESSFUL, "ChangeDisplaySettingsExW failed with %ld.\n", change_ret);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);

    ret = EnumDisplaySettingsW(second_monitor_name, ENUM_CURRENT_SETTINGS, &devmode2);
    ok(ret, "EnumDisplaySettingsW failed, error %#lx.\n", GetLastError());
    ok(equal_mode_rect(&devmode2, &old_devmode), "Got a different mode.\n");
    ret = EnumDisplaySettingsW(second_monitor_name, ENUM_REGISTRY_SETTINGS, &devmode2);
    ok(ret, "EnumDisplaySettingsW failed, error %#lx.\n", GetLastError());
    ok(equal_mode_rect(&devmode2, &old_devmode), "Got a different mode.\n");
    hr = IDirect3D8_GetAdapterDisplayMode(d3d8, 1, &d3ddm);
    ok(hr == S_OK, "GetAdapterDisplayMode failed, hr %#lx.\n", hr);
    ok(d3ddm.Width == old_devmode.dmPelsWidth, "Expected width %lu, got %u.\n",
            old_devmode.dmPelsWidth, d3ddm.Width);
    ok(d3ddm.Height == old_devmode.dmPelsHeight, "Expected height %lu, got %u.\n",
            old_devmode.dmPelsHeight, d3ddm.Height);
    ret = restore_display_modes(original_modes, display_count);
    ok(ret, "Failed to restore display modes.\n");

    /* Test that mode restorations for non-primary monitors use display settings in the registry */
    device = create_device(d3d8, device_window, &device_desc);
    ok(!!device, "Failed to create a D3D device.\n");

    change_ret = ChangeDisplaySettingsExW(second_monitor_name, &devmode, NULL,
            CDS_UPDATEREGISTRY | CDS_NORESET, NULL);
    ok(change_ret == DISP_CHANGE_SUCCESSFUL, "ChangeDisplaySettingsExW failed with %ld.\n", change_ret);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);

    ret = EnumDisplaySettingsW(second_monitor_name, ENUM_CURRENT_SETTINGS, &devmode2);
    ok(ret, "EnumDisplaySettingsW failed, error %#lx.\n", GetLastError());
    ok(devmode2.dmPelsWidth == devmode.dmPelsWidth && devmode2.dmPelsHeight == devmode.dmPelsHeight,
            "Expected resolution %lux%lu, got %lux%lu.\n", devmode.dmPelsWidth, devmode.dmPelsHeight,
            devmode2.dmPelsWidth, devmode2.dmPelsHeight);
    ret = EnumDisplaySettingsW(second_monitor_name, ENUM_REGISTRY_SETTINGS, &devmode2);
    ok(ret, "EnumDisplaySettingsW failed, error %#lx.\n", GetLastError());
    ok(devmode2.dmPelsWidth == devmode.dmPelsWidth && devmode2.dmPelsHeight == devmode.dmPelsHeight,
            "Expected resolution %lux%lu, got %lux%lu.\n", devmode.dmPelsWidth, devmode.dmPelsHeight,
            devmode2.dmPelsWidth, devmode2.dmPelsHeight);
    hr = IDirect3D8_GetAdapterDisplayMode(d3d8, 1, &d3ddm);
    ok(hr == S_OK, "GetAdapterDisplayMode failed, hr %#lx.\n", hr);
    ok(d3ddm.Width == devmode.dmPelsWidth && d3ddm.Height == devmode.dmPelsHeight,
            "Expected resolution %lux%lu, got %ux%u.\n", devmode.dmPelsWidth, devmode.dmPelsHeight,
            d3ddm.Width, d3ddm.Height);
    ret = restore_display_modes(original_modes, display_count);
    ok(ret, "Failed to restore display modes.\n");

    /* Test mode restorations when there are two fullscreen devices and one of them got reset */
    device = create_device(d3d8, focus_window, &device_desc);
    ok(!!device, "Failed to create a D3D device.\n");

    device_desc2.adapter_ordinal = 1;
    device_desc2.device_window = device_window;
    device_desc2.width = d3d_width;
    device_desc2.height = d3d_height;
    device_desc2.flags = CREATE_DEVICE_FULLSCREEN;
    device2 = create_device(d3d8, focus_window, &device_desc2);
    ok(!!device2, "Failed to create a D3D device.\n");

    change_ret = ChangeDisplaySettingsExW(second_monitor_name, &devmode, NULL, CDS_RESET, NULL);
    ok(change_ret == DISP_CHANGE_SUCCESSFUL, "ChangeDisplaySettingsExW failed with %ld.\n", change_ret);

    device_desc.flags = 0;
    hr = reset_device(device, &device_desc);
    ok(hr == D3D_OK, "Failed to reset device, hr %#lx.\n", hr);

    ret = EnumDisplaySettingsW(second_monitor_name, ENUM_CURRENT_SETTINGS, &devmode2);
    ok(ret, "EnumDisplaySettingsW failed, error %#lx.\n", GetLastError());
    ok(equal_mode_rect(&devmode2, &old_devmode), "Got a different mode.\n");
    ret = EnumDisplaySettingsW(second_monitor_name, ENUM_REGISTRY_SETTINGS, &devmode2);
    ok(ret, "EnumDisplaySettingsW failed, error %#lx.\n", GetLastError());
    ok(equal_mode_rect(&devmode2, &old_devmode), "Got a different mode.\n");
    hr = IDirect3D8_GetAdapterDisplayMode(d3d8, 1, &d3ddm);
    ok(hr == S_OK, "GetAdapterDisplayMode failed, hr %#lx.\n", hr);
    ok(d3ddm.Width == old_devmode.dmPelsWidth && d3ddm.Height == old_devmode.dmPelsHeight,
            "Expected resolution %lux%lu, got %ux%u.\n", old_devmode.dmPelsWidth,
            old_devmode.dmPelsHeight, d3ddm.Width, d3ddm.Height);

    refcount = IDirect3DDevice8_Release(device2);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    ret = restore_display_modes(original_modes, display_count);
    ok(ret, "Failed to restore display modes.\n");

    /* Test mode restoration when there are two fullscreen devices and one of them got released */
    device_desc.flags = CREATE_DEVICE_FULLSCREEN;
    device = create_device(d3d8, focus_window, &device_desc);
    ok(!!device, "Failed to create a D3D device.\n");
    device2 = create_device(d3d8, focus_window, &device_desc2);
    ok(!!device2, "Failed to create a D3D device.\n");

    change_ret = ChangeDisplaySettingsExW(second_monitor_name, &devmode, NULL, CDS_RESET, NULL);
    ok(change_ret == DISP_CHANGE_SUCCESSFUL, "ChangeDisplaySettingsExW failed with %ld.\n", change_ret);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);

    ret = EnumDisplaySettingsW(second_monitor_name, ENUM_CURRENT_SETTINGS, &devmode2);
    ok(ret, "EnumDisplaySettingsW failed, error %#lx.\n", GetLastError());
    ok(equal_mode_rect(&devmode2, &old_devmode), "Got a different mode.\n");
    ret = EnumDisplaySettingsW(second_monitor_name, ENUM_REGISTRY_SETTINGS, &devmode2);
    ok(ret, "EnumDisplaySettingsW failed, error %#lx.\n", GetLastError());
    ok(equal_mode_rect(&devmode2, &old_devmode), "Got a different mode.\n");
    hr = IDirect3D8_GetAdapterDisplayMode(d3d8, 1, &d3ddm);
    ok(hr == S_OK, "GetAdapterDisplayMode failed, hr %#lx.\n", hr);
    ok(d3ddm.Width == old_devmode.dmPelsWidth && d3ddm.Height == old_devmode.dmPelsHeight,
            "Expected resolution %lux%lu, got %ux%u.\n", old_devmode.dmPelsWidth,
            old_devmode.dmPelsHeight, d3ddm.Width, d3ddm.Height);

    refcount = IDirect3DDevice8_Release(device2);
    ok(!refcount, "Device has %lu references left.\n", refcount);

done:
    DestroyWindow(device_window);
    DestroyWindow(focus_window);
    IDirect3D8_Release(d3d8);
    ret = restore_display_modes(original_modes, display_count);
    ok(ret, "Failed to restore display modes.\n");
    free(original_modes);
}

static void test_device_window_reset(void)
{
    RECT fullscreen_rect, device_rect, r;
    struct device_desc device_desc;
    IDirect3DDevice8 *device;
    WNDCLASSA wc = {0};
    IDirect3D8 *d3d8;
    LONG_PTR proc;
    HRESULT hr;
    ULONG ref;

    filter_messages = NULL;
    expect_messages = NULL;

    wc.lpfnWndProc = test_proc;
    wc.lpszClassName = "d3d8_test_wndproc_wc";
    ok(RegisterClassA(&wc), "Failed to register window class.\n");

    focus_window = CreateWindowA("d3d8_test_wndproc_wc", "d3d8_test", WS_OVERLAPPEDWINDOW,
            0, 0, registry_mode.dmPelsWidth / 2, registry_mode.dmPelsHeight / 2, 0, 0, 0, 0);
    device_window = CreateWindowA("d3d8_test_wndproc_wc", "d3d8_test", WS_OVERLAPPEDWINDOW,
            0, 0, registry_mode.dmPelsWidth / 2, registry_mode.dmPelsHeight / 2, 0, 0, 0, 0);
    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");

    SetRect(&fullscreen_rect, 0, 0, registry_mode.dmPelsWidth, registry_mode.dmPelsHeight);
    GetWindowRect(device_window, &device_rect);

    proc = GetWindowLongPtrA(device_window, GWLP_WNDPROC);
    ok(proc == (LONG_PTR)test_proc, "Expected wndproc %#Ix, got %#Ix.\n",
            (LONG_PTR)test_proc, proc);
    proc = GetWindowLongPtrA(focus_window, GWLP_WNDPROC);
    ok(proc == (LONG_PTR)test_proc, "Expected wndproc %#Ix, got %#Ix.\n",
            (LONG_PTR)test_proc, proc);

    device_desc.adapter_ordinal = D3DADAPTER_DEFAULT;
    device_desc.device_window = NULL;
    device_desc.width = registry_mode.dmPelsWidth;
    device_desc.height = registry_mode.dmPelsHeight;
    device_desc.flags = CREATE_DEVICE_FULLSCREEN;
    if (!(device = create_device(d3d8, focus_window, &device_desc)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    GetWindowRect(focus_window, &r);
    ok(EqualRect(&r, &fullscreen_rect), "Expected %s, got %s.\n",
            wine_dbgstr_rect(&fullscreen_rect), wine_dbgstr_rect(&r));
    GetWindowRect(device_window, &r);
    ok(EqualRect(&r, &device_rect), "Expected %s, got %s.\n", wine_dbgstr_rect(&device_rect),
            wine_dbgstr_rect(&r));

    proc = GetWindowLongPtrA(device_window, GWLP_WNDPROC);
    ok(proc == (LONG_PTR)test_proc, "Expected wndproc %#Ix, got %#Ix.\n",
            (LONG_PTR)test_proc, proc);
    proc = GetWindowLongPtrA(focus_window, GWLP_WNDPROC);
    ok(proc != (LONG_PTR)test_proc, "Expected wndproc != %#Ix.\n", (LONG_PTR)test_proc);

    device_desc.device_window = device_window;
    hr = reset_device(device, &device_desc);
    ok(SUCCEEDED(hr), "Failed to reset device.\n");

    GetWindowRect(focus_window, &r);
    ok(EqualRect(&r, &fullscreen_rect), "Expected %s, got %s.\n",
            wine_dbgstr_rect(&fullscreen_rect), wine_dbgstr_rect(&r));
    GetWindowRect(device_window, &r);
    ok(EqualRect(&r, &fullscreen_rect), "Expected %s, got %s.\n",
            wine_dbgstr_rect(&fullscreen_rect), wine_dbgstr_rect(&r));

    proc = GetWindowLongPtrA(device_window, GWLP_WNDPROC);
    ok(proc == (LONG_PTR)test_proc, "Expected wndproc %#Ix, got %#Ix.\n",
            (LONG_PTR)test_proc, proc);
    proc = GetWindowLongPtrA(focus_window, GWLP_WNDPROC);
    ok(proc != (LONG_PTR)test_proc, "Expected wndproc != %#Ix.\n", (LONG_PTR)test_proc);

    ref = IDirect3DDevice8_Release(device);
    ok(!ref, "Got unexpected refcount %lu.\n", ref);

done:
    IDirect3D8_Release(d3d8);
    DestroyWindow(device_window);
    DestroyWindow(focus_window);
    UnregisterClassA("d3d8_test_wndproc_wc", GetModuleHandleA(NULL));
}

static void depth_blit_test(void)
{
    IDirect3DDevice8 *device = NULL;
    IDirect3DSurface8 *backbuffer, *ds1, *ds2, *ds3;
    RECT src_rect;
    const POINT dst_point = {0, 0};
    IDirect3D8 *d3d8;
    HRESULT hr;
    HWND hwnd;

    hwnd = CreateWindowA("d3d8_test_wc", "d3d8_test", WS_OVERLAPPEDWINDOW,
            100, 100, 160, 160, NULL, NULL, NULL, NULL);
    ok(!!hwnd, "Failed to create a window.\n");
    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");

    if (!(device = create_device(d3d8, hwnd, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    hr = IDirect3DDevice8_GetRenderTarget(device, &backbuffer);
    ok(SUCCEEDED(hr), "GetRenderTarget failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_GetDepthStencilSurface(device, &ds1);
    ok(SUCCEEDED(hr), "GetDepthStencilSurface failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateDepthStencilSurface(device, 640, 480, D3DFMT_D24S8, D3DMULTISAMPLE_NONE, &ds2);
    ok(SUCCEEDED(hr), "CreateDepthStencilSurface failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateDepthStencilSurface(device, 640, 480, D3DFMT_D24S8, D3DMULTISAMPLE_NONE, &ds3);
    ok(SUCCEEDED(hr), "CreateDepthStencilSurface failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_ZBUFFER, 0, 0.0f, 0);
    ok(SUCCEEDED(hr), "Clear failed, hr %#lx.\n", hr);

    /* Partial blit. */
    SetRect(&src_rect, 0, 0, 320, 240);
    hr = IDirect3DDevice8_CopyRects(device, ds1, &src_rect, 1, ds2, &dst_point);
    ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);
    /* Flipped. */
    SetRect(&src_rect, 0, 480, 640, 0);
    hr = IDirect3DDevice8_CopyRects(device, ds1, &src_rect, 1, ds2, &dst_point);
    ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);
    /* Full, explicit. */
    SetRect(&src_rect, 0, 0, 640, 480);
    hr = IDirect3DDevice8_CopyRects(device, ds1, &src_rect, 1, ds2, &dst_point);
    ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);
    /* Depth -> color blit.*/
    hr = IDirect3DDevice8_CopyRects(device, ds1, &src_rect, 1, backbuffer, &dst_point);
    ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);
    /* Full, NULL rects, current depth stencil -> unbound depth stencil */
    hr = IDirect3DDevice8_CopyRects(device, ds1, NULL, 0, ds2, NULL);
    ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);
    /* Full, NULL rects, unbound depth stencil -> current depth stencil */
    hr = IDirect3DDevice8_CopyRects(device, ds2, NULL, 0, ds1, NULL);
    ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);
    /* Full, NULL rects, unbound depth stencil -> unbound depth stencil */
    hr = IDirect3DDevice8_CopyRects(device, ds2, NULL, 0, ds3, NULL);
    ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);

    IDirect3DSurface8_Release(backbuffer);
    IDirect3DSurface8_Release(ds3);
    IDirect3DSurface8_Release(ds2);
    IDirect3DSurface8_Release(ds1);

done:
    if (device) IDirect3DDevice8_Release(device);
    IDirect3D8_Release(d3d8);
    DestroyWindow(hwnd);
}

static void test_reset_resources(void)
{
    IDirect3DSurface8 *surface, *rt;
    IDirect3DTexture8 *texture;
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d8;
    HWND window;
    HRESULT hr;
    ULONG ref;

    window = create_window();
    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");

    if (!(device = create_device(d3d8, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    hr = IDirect3DDevice8_CreateDepthStencilSurface(device, 128, 128, D3DFMT_D24S8,
            D3DMULTISAMPLE_NONE, &surface);
    ok(SUCCEEDED(hr), "Failed to create depth/stencil surface, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CreateTexture(device, 128, 128, 1, D3DUSAGE_RENDERTARGET,
            D3DFMT_A8R8G8B8, D3DPOOL_DEFAULT, &texture);
    ok(SUCCEEDED(hr), "Failed to create render target texture, hr %#lx.\n", hr);
    hr = IDirect3DTexture8_GetSurfaceLevel(texture, 0, &rt);
    ok(SUCCEEDED(hr), "Failed to get surface, hr %#lx.\n", hr);
    IDirect3DTexture8_Release(texture);

    hr = IDirect3DDevice8_SetRenderTarget(device, rt, surface);
    ok(SUCCEEDED(hr), "Failed to set render target surface, hr %#lx.\n", hr);
    IDirect3DSurface8_Release(rt);
    IDirect3DSurface8_Release(surface);

    hr = reset_device(device, NULL);
    ok(SUCCEEDED(hr), "Failed to reset device.\n");

    hr = IDirect3DDevice8_GetBackBuffer(device, 0, D3DBACKBUFFER_TYPE_MONO, &rt);
    ok(SUCCEEDED(hr), "Failed to get back buffer, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_GetRenderTarget(device, &surface);
    ok(SUCCEEDED(hr), "Failed to get render target surface, hr %#lx.\n", hr);
    ok(surface == rt, "Got unexpected surface %p for render target.\n", surface);
    IDirect3DSurface8_Release(surface);
    IDirect3DSurface8_Release(rt);

    ref = IDirect3DDevice8_Release(device);
    ok(!ref, "Got unexpected refcount %lu.\n", ref);

done:
    IDirect3D8_Release(d3d8);
    DestroyWindow(window);
}

static void test_set_rt_vp_scissor(void)
{
    IDirect3DDevice8 *device;
    IDirect3DSurface8 *rt;
    IDirect3D8 *d3d8;
    DWORD stateblock;
    D3DVIEWPORT8 vp;
    UINT refcount;
    HWND window;
    HRESULT hr;

    window = create_window();
    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d8, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d8);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_CreateRenderTarget(device, 128, 128, D3DFMT_A8R8G8B8,
            D3DMULTISAMPLE_NONE, FALSE, &rt);
    ok(SUCCEEDED(hr), "Failed to create render target, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetViewport(device, &vp);
    ok(SUCCEEDED(hr), "Failed to get viewport, hr %#lx.\n", hr);
    ok(!vp.X, "Got unexpected vp.X %lu.\n", vp.X);
    ok(!vp.Y, "Got unexpected vp.Y %lu.\n", vp.Y);
    ok(vp.Width == 640, "Got unexpected vp.Width %lu.\n", vp.Width);
    ok(vp.Height == 480, "Got unexpected vp.Height %lu.\n", vp.Height);
    ok(vp.MinZ == 0.0f, "Got unexpected vp.MinZ %.8e.\n", vp.MinZ);
    ok(vp.MaxZ == 1.0f, "Got unexpected vp.MaxZ %.8e.\n", vp.MaxZ);

    hr = IDirect3DDevice8_BeginStateBlock(device);
    ok(SUCCEEDED(hr), "Failed to begin stateblock, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderTarget(device, rt, NULL);
    ok(SUCCEEDED(hr), "Failed to set render target, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_EndStateBlock(device, &stateblock);
    ok(SUCCEEDED(hr), "Failed to end stateblock, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DeleteStateBlock(device, stateblock);
    ok(SUCCEEDED(hr), "Failed to delete stateblock, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetViewport(device, &vp);
    ok(SUCCEEDED(hr), "Failed to get viewport, hr %#lx.\n", hr);
    ok(!vp.X, "Got unexpected vp.X %lu.\n", vp.X);
    ok(!vp.Y, "Got unexpected vp.Y %lu.\n", vp.Y);
    ok(vp.Width == 128, "Got unexpected vp.Width %lu.\n", vp.Width);
    ok(vp.Height == 128, "Got unexpected vp.Height %lu.\n", vp.Height);
    ok(vp.MinZ == 0.0f, "Got unexpected vp.MinZ %.8e.\n", vp.MinZ);
    ok(vp.MaxZ == 1.0f, "Got unexpected vp.MaxZ %.8e.\n", vp.MaxZ);

    hr = IDirect3DDevice8_SetRenderTarget(device, rt, NULL);
    ok(SUCCEEDED(hr), "Failed to set render target, hr %#lx.\n", hr);

    vp.X = 10;
    vp.Y = 20;
    vp.Width = 30;
    vp.Height = 40;
    vp.MinZ = 0.25f;
    vp.MaxZ = 0.75f;
    hr = IDirect3DDevice8_SetViewport(device, &vp);
    ok(SUCCEEDED(hr), "Failed to set viewport, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderTarget(device, rt, NULL);
    ok(SUCCEEDED(hr), "Failed to set render target, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetViewport(device, &vp);
    ok(SUCCEEDED(hr), "Failed to get viewport, hr %#lx.\n", hr);
    ok(!vp.X, "Got unexpected vp.X %lu.\n", vp.X);
    ok(!vp.Y, "Got unexpected vp.Y %lu.\n", vp.Y);
    ok(vp.Width == 128, "Got unexpected vp.Width %lu.\n", vp.Width);
    ok(vp.Height == 128, "Got unexpected vp.Height %lu.\n", vp.Height);
    ok(vp.MinZ == 0.0f, "Got unexpected vp.MinZ %.8e.\n", vp.MinZ);
    ok(vp.MaxZ == 1.0f, "Got unexpected vp.MaxZ %.8e.\n", vp.MaxZ);

    IDirect3DSurface8_Release(rt);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %u references left.\n", refcount);
    IDirect3D8_Release(d3d8);
    DestroyWindow(window);
}

static void test_validate_vs(void)
{
    static DWORD vs_code[] =
    {
        0xfffe0101,                                                             /* vs_1_1                       */
        0x00000009, 0xc0010000, 0x90e40000, 0xa0e40000,                         /* dp4 oPos.x, v0, c0           */
        0x00000009, 0xc0020000, 0x90e40000, 0xa0e40001,                         /* dp4 oPos.y, v0, c1           */
        0x00000009, 0xc0040000, 0x90e40000, 0xa0e40002,                         /* dp4 oPos.z, v0, c2           */
        0x00000009, 0xc0080000, 0x90e40000, 0xa0e40003,                         /* dp4 oPos.w, v0, c3           */
        0x0000ffff,                                                             /* end                          */
    };
    D3DCAPS8 caps;
    char *errors;
    HRESULT hr;

    static DWORD declaration_valid1[] =
    {
        D3DVSD_STREAM(0),
        D3DVSD_REG(D3DVSDE_POSITION, D3DVSDT_FLOAT4),
        D3DVSD_END()
    };
    static DWORD declaration_valid2[] =
    {
        D3DVSD_STREAM(0),
        D3DVSD_REG(D3DVSDE_POSITION, D3DVSDT_FLOAT2),
        D3DVSD_END()
    };
    static DWORD declaration_invalid[] =
    {
        D3DVSD_STREAM(0),
        D3DVSD_REG(D3DVSDE_NORMAL, D3DVSDT_FLOAT4),
        D3DVSD_END()
    };

    hr = ValidateVertexShader(NULL, NULL, NULL, FALSE, NULL);
    ok(hr == E_FAIL, "Got unexpected hr %#lx.\n", hr);
    hr = ValidateVertexShader(NULL, NULL, NULL, TRUE, NULL);
    ok(hr == E_FAIL, "Got unexpected hr %#lx.\n", hr);
    hr = ValidateVertexShader(NULL, NULL, NULL, FALSE, &errors);
    ok(hr == E_FAIL, "Got unexpected hr %#lx.\n", hr);
    ok(!*errors, "Got unexpected string \"%s\".\n", errors);
    HeapFree(GetProcessHeap(), 0, errors);
    hr = ValidateVertexShader(NULL, NULL, NULL, TRUE, &errors);
    ok(hr == E_FAIL, "Got unexpected hr %#lx.\n", hr);
    ok(!!*errors, "Got unexpected empty string.\n");
    HeapFree(GetProcessHeap(), 0, errors);

    hr = ValidateVertexShader(vs_code, NULL, NULL, FALSE, NULL);
    ok(hr == S_OK, "Got unexpected hr %#lx.\n", hr);
    hr = ValidateVertexShader(vs_code, NULL, NULL, TRUE, NULL);
    ok(hr == S_OK, "Got unexpected hr %#lx.\n", hr);
    hr = ValidateVertexShader(vs_code, NULL, NULL, TRUE, &errors);
    ok(hr == S_OK, "Got unexpected hr %#lx.\n", hr);
    ok(!*errors, "Got unexpected string \"%s\".\n", errors);
    HeapFree(GetProcessHeap(), 0, errors);

    hr = ValidateVertexShader(vs_code, declaration_valid1, NULL, FALSE, NULL);
    ok(hr == S_OK, "Got unexpected hr %#lx.\n", hr);
    hr = ValidateVertexShader(vs_code, declaration_valid2, NULL, FALSE, NULL);
    ok(hr == S_OK, "Got unexpected hr %#lx.\n", hr);
    hr = ValidateVertexShader(vs_code, declaration_invalid, NULL, FALSE, NULL);
    todo_wine ok(hr == E_FAIL, "Got unexpected hr %#lx.\n", hr);

    memset(&caps, 0, sizeof(caps));
    caps.VertexShaderVersion = D3DVS_VERSION(1, 1);
    caps.MaxVertexShaderConst = 4;
    hr = ValidateVertexShader(vs_code, NULL, &caps, FALSE, NULL);
    ok(hr == S_OK, "Got unexpected hr %#lx.\n", hr);
    caps.VertexShaderVersion = D3DVS_VERSION(1, 0);
    hr = ValidateVertexShader(vs_code, NULL, &caps, FALSE, NULL);
    ok(hr == E_FAIL, "Got unexpected hr %#lx.\n", hr);
    caps.VertexShaderVersion = D3DVS_VERSION(1, 2);
    hr = ValidateVertexShader(vs_code, NULL, &caps, FALSE, NULL);
    ok(hr == S_OK, "Got unexpected hr %#lx.\n", hr);
    caps.VertexShaderVersion = D3DVS_VERSION(8, 8);
    hr = ValidateVertexShader(vs_code, NULL, &caps, FALSE, NULL);
    ok(hr == S_OK, "Got unexpected hr %#lx.\n", hr);
    caps.VertexShaderVersion = D3DVS_VERSION(1, 1);
    caps.MaxVertexShaderConst = 3;
    hr = ValidateVertexShader(vs_code, NULL, &caps, FALSE, NULL);
    todo_wine ok(hr == E_FAIL, "Got unexpected hr %#lx.\n", hr);

    *vs_code = D3DVS_VERSION(1, 0);
    hr = ValidateVertexShader(vs_code, NULL, NULL, FALSE, NULL);
    ok(hr == S_OK, "Got unexpected hr %#lx.\n", hr);
    *vs_code = D3DVS_VERSION(1, 2);
    hr = ValidateVertexShader(vs_code, NULL, NULL, TRUE, NULL);
    ok(hr == E_FAIL, "Got unexpected hr %#lx.\n", hr);
    hr = ValidateVertexShader(vs_code, NULL, NULL, FALSE, &errors);
    ok(hr == E_FAIL, "Got unexpected hr %#lx.\n", hr);
    ok(!*errors, "Got unexpected string \"%s\".\n", errors);
    HeapFree(GetProcessHeap(), 0, errors);
    hr = ValidateVertexShader(vs_code, NULL, NULL, TRUE, &errors);
    ok(hr == E_FAIL, "Got unexpected hr %#lx.\n", hr);
    ok(!!*errors, "Got unexpected empty string.\n");
    HeapFree(GetProcessHeap(), 0, errors);
}

static void test_validate_ps(void)
{
    static DWORD ps_1_1_code[] =
    {
        0xffff0101,                                                             /* ps_1_1                       */
        0x00000001, 0x800f0001, 0xa0e40001,                                     /* mov r1, c1                   */
        0x00000002, 0x800f0000, 0x80e40001, 0xa0e40002,                         /* add r0, r1, c2               */
        0x0000ffff                                                              /* end                          */
    };
    static const DWORD ps_2_0_code[] =
    {
        0xffff0200,                                                             /* ps_2_0                       */
        0x02000001, 0x800f0001, 0xa0e40001,                                     /* mov r1, c1                   */
        0x03000002, 0x800f0000, 0x80e40001, 0xa0e40002,                         /* add r0, r1, c2               */
        0x02000001, 0x800f0800, 0x80e40000,                                     /* mov oC0, r0                  */
        0x0000ffff                                                              /* end                          */
    };
    D3DCAPS8 caps;
    char *errors;
    HRESULT hr;

    hr = ValidatePixelShader(NULL, NULL, FALSE, NULL);
    ok(hr == E_FAIL, "Got unexpected hr %#lx.\n", hr);
    hr = ValidatePixelShader(NULL, NULL, TRUE, NULL);
    ok(hr == E_FAIL, "Got unexpected hr %#lx.\n", hr);
    errors = (void *)0xcafeface;
    hr = ValidatePixelShader(NULL, NULL, FALSE, &errors);
    ok(hr == E_FAIL, "Got unexpected hr %#lx.\n", hr);
    ok(errors == (void *)0xcafeface, "Got unexpected errors %p.\n", errors);
    errors = (void *)0xcafeface;
    hr = ValidatePixelShader(NULL, NULL, TRUE, &errors);
    ok(hr == E_FAIL, "Got unexpected hr %#lx.\n", hr);
    ok(errors == (void *)0xcafeface, "Got unexpected errors %p.\n", errors);

    hr = ValidatePixelShader(ps_1_1_code, NULL, FALSE, NULL);
    ok(hr == S_OK, "Got unexpected hr %#lx.\n", hr);
    hr = ValidatePixelShader(ps_1_1_code, NULL, TRUE, NULL);
    ok(hr == S_OK, "Got unexpected hr %#lx.\n", hr);
    hr = ValidatePixelShader(ps_1_1_code, NULL, TRUE, &errors);
    ok(hr == S_OK, "Got unexpected hr %#lx.\n", hr);
    ok(!*errors, "Got unexpected string \"%s\".\n", errors);
    HeapFree(GetProcessHeap(), 0, errors);

    memset(&caps, 0, sizeof(caps));
    caps.PixelShaderVersion = D3DPS_VERSION(1, 1);
    hr = ValidatePixelShader(ps_1_1_code, &caps, FALSE, NULL);
    ok(hr == S_OK, "Got unexpected hr %#lx.\n", hr);
    caps.PixelShaderVersion = D3DPS_VERSION(1, 0);
    hr = ValidatePixelShader(ps_1_1_code, &caps, FALSE, NULL);
    ok(hr == E_FAIL, "Got unexpected hr %#lx.\n", hr);
    caps.PixelShaderVersion = D3DPS_VERSION(1, 2);
    hr = ValidatePixelShader(ps_1_1_code, &caps, FALSE, NULL);
    ok(hr == S_OK, "Got unexpected hr %#lx.\n", hr);
    caps.PixelShaderVersion = D3DPS_VERSION(8, 8);
    hr = ValidatePixelShader(ps_1_1_code, &caps, FALSE, NULL);
    ok(hr == S_OK, "Got unexpected hr %#lx.\n", hr);

    *ps_1_1_code = D3DPS_VERSION(1, 0);
    hr = ValidatePixelShader(ps_1_1_code, NULL, FALSE, NULL);
    ok(hr == S_OK, "Got unexpected hr %#lx.\n", hr);
    *ps_1_1_code = D3DPS_VERSION(1, 4);
    hr = ValidatePixelShader(ps_1_1_code, NULL, FALSE, NULL);
    ok(hr == S_OK, "Got unexpected hr %#lx.\n", hr);
    hr = ValidatePixelShader(ps_2_0_code, NULL, FALSE, NULL);
    ok(hr == E_FAIL, "Got unexpected hr %#lx.\n", hr);
    *ps_1_1_code = D3DPS_VERSION(1, 5);
    hr = ValidatePixelShader(ps_1_1_code, NULL, TRUE, NULL);
    ok(hr == E_FAIL, "Got unexpected hr %#lx.\n", hr);
    hr = ValidatePixelShader(ps_1_1_code, NULL, FALSE, &errors);
    ok(hr == E_FAIL, "Got unexpected hr %#lx.\n", hr);
    ok(!*errors, "Got unexpected string \"%s\".\n", errors);
    HeapFree(GetProcessHeap(), 0, errors);
    hr = ValidatePixelShader(ps_1_1_code, NULL, TRUE, &errors);
    ok(hr == E_FAIL, "Got unexpected hr %#lx.\n", hr);
    ok(!!*errors, "Got unexpected empty string.\n");
    HeapFree(GetProcessHeap(), 0, errors);
}

static void test_volume_get_container(void)
{
    IDirect3DVolumeTexture8 *texture = NULL;
    IDirect3DVolume8 *volume = NULL;
    IDirect3DDevice8 *device;
    IUnknown *container;
    IDirect3D8 *d3d8;
    ULONG refcount;
    D3DCAPS8 caps;
    HWND window;
    HRESULT hr;

    window = create_window();
    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d8, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d8);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get device caps, hr %#lx.\n", hr);
    if (!(caps.TextureCaps & D3DPTEXTURECAPS_VOLUMEMAP))
    {
        skip("No volume texture support, skipping tests.\n");
        IDirect3DDevice8_Release(device);
        IDirect3D8_Release(d3d8);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_CreateVolumeTexture(device, 128, 128, 128, 1, 0,
            D3DFMT_A8R8G8B8, D3DPOOL_DEFAULT, &texture);
    ok(SUCCEEDED(hr), "Failed to create volume texture, hr %#lx.\n", hr);
    ok(!!texture, "Got unexpected texture %p.\n", texture);

    hr = IDirect3DVolumeTexture8_GetVolumeLevel(texture, 0, &volume);
    ok(SUCCEEDED(hr), "Failed to get volume level, hr %#lx.\n", hr);
    ok(!!volume, "Got unexpected volume %p.\n", volume);

    /* These should work... */
    container = NULL;
    hr = IDirect3DVolume8_GetContainer(volume, &IID_IUnknown, (void **)&container);
    ok(SUCCEEDED(hr), "Failed to get volume container, hr %#lx.\n", hr);
    ok(container == (IUnknown *)texture, "Got unexpected container %p, expected %p.\n", container, texture);
    IUnknown_Release(container);

    container = NULL;
    hr = IDirect3DVolume8_GetContainer(volume, &IID_IDirect3DResource8, (void **)&container);
    ok(SUCCEEDED(hr), "Failed to get volume container, hr %#lx.\n", hr);
    ok(container == (IUnknown *)texture, "Got unexpected container %p, expected %p.\n", container, texture);
    IUnknown_Release(container);

    container = NULL;
    hr = IDirect3DVolume8_GetContainer(volume, &IID_IDirect3DBaseTexture8, (void **)&container);
    ok(SUCCEEDED(hr), "Failed to get volume container, hr %#lx.\n", hr);
    ok(container == (IUnknown *)texture, "Got unexpected container %p, expected %p.\n", container, texture);
    IUnknown_Release(container);

    container = NULL;
    hr = IDirect3DVolume8_GetContainer(volume, &IID_IDirect3DVolumeTexture8, (void **)&container);
    ok(SUCCEEDED(hr), "Failed to get volume container, hr %#lx.\n", hr);
    ok(container == (IUnknown *)texture, "Got unexpected container %p, expected %p.\n", container, texture);
    IUnknown_Release(container);

    /* ...and this one shouldn't. This should return E_NOINTERFACE and set container to NULL. */
    hr = IDirect3DVolume8_GetContainer(volume, &IID_IDirect3DVolume8, (void **)&container);
    ok(hr == E_NOINTERFACE, "Got unexpected hr %#lx.\n", hr);
    ok(!container, "Got unexpected container %p.\n", container);

    IDirect3DVolume8_Release(volume);
    IDirect3DVolumeTexture8_Release(texture);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d8);
    DestroyWindow(window);
}

static void test_vb_lock_flags(void)
{
    static const struct
    {
        DWORD flags;
        const char *debug_string;
        HRESULT result;
    }
    test_data[] =
    {
        {D3DLOCK_READONLY,                          "D3DLOCK_READONLY",                         D3D_OK            },
        {D3DLOCK_DISCARD,                           "D3DLOCK_DISCARD",                          D3D_OK            },
        {D3DLOCK_NOOVERWRITE,                       "D3DLOCK_NOOVERWRITE",                      D3D_OK            },
        {D3DLOCK_NOOVERWRITE | D3DLOCK_DISCARD,     "D3DLOCK_NOOVERWRITE | D3DLOCK_DISCARD",    D3D_OK            },
        {D3DLOCK_NOOVERWRITE | D3DLOCK_READONLY,    "D3DLOCK_NOOVERWRITE | D3DLOCK_READONLY",   D3D_OK            },
        {D3DLOCK_READONLY    | D3DLOCK_DISCARD,     "D3DLOCK_READONLY | D3DLOCK_DISCARD",       D3D_OK            },
        /* Completely bogus flags aren't an error. */
        {0xdeadbeef,                                "0xdeadbeef",                               D3D_OK            },
    };
    IDirect3DVertexBuffer8 *buffer;
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d8;
    unsigned int i;
    ULONG refcount;
    HWND window;
    HRESULT hr;
    BYTE *data;

    window = create_window();
    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d8, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d8);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_CreateVertexBuffer(device, 1024, D3DUSAGE_DYNAMIC | D3DUSAGE_WRITEONLY,
            0, D3DPOOL_DEFAULT, &buffer);
    ok(SUCCEEDED(hr), "Failed to create vertex buffer, hr %#lx.\n", hr);

    for (i = 0; i < ARRAY_SIZE(test_data); ++i)
    {
        hr = IDirect3DVertexBuffer8_Lock(buffer, 0, 0, &data, test_data[i].flags);
        ok(hr == test_data[i].result, "Got unexpected hr %#lx for %s.\n",
                hr, test_data[i].debug_string);
        if (SUCCEEDED(hr))
        {
            ok(!!data, "Got unexpected data %p.\n", data);
            hr = IDirect3DVertexBuffer8_Unlock(buffer);
            ok(SUCCEEDED(hr), "Failed to unlock vertex buffer, hr %#lx.\n", hr);
        }
    }

    IDirect3DVertexBuffer8_Release(buffer);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d8);
    DestroyWindow(window);
}

/* Test the default texture stage state values */
static void test_texture_stage_states(void)
{
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d8;
    unsigned int i;
    ULONG refcount;
    D3DCAPS8 caps;
    DWORD value;
    HWND window;
    HRESULT hr;

    window = create_window();
    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d8, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d8);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get device caps, hr %#lx.\n", hr);

    for (i = 0; i < caps.MaxTextureBlendStages; ++i)
    {
        hr = IDirect3DDevice8_GetTextureStageState(device, i, D3DTSS_COLOROP, &value);
        ok(SUCCEEDED(hr), "Failed to get texture stage state, hr %#lx.\n", hr);
        ok(value == (i ? D3DTOP_DISABLE : D3DTOP_MODULATE),
                "Got unexpected value %#lx for D3DTSS_COLOROP, stage %u.\n", value, i);
        hr = IDirect3DDevice8_GetTextureStageState(device, i, D3DTSS_COLORARG1, &value);
        ok(SUCCEEDED(hr), "Failed to get texture stage state, hr %#lx.\n", hr);
        ok(value == D3DTA_TEXTURE, "Got unexpected value %#lx for D3DTSS_COLORARG1, stage %u.\n", value, i);
        hr = IDirect3DDevice8_GetTextureStageState(device, i, D3DTSS_COLORARG2, &value);
        ok(SUCCEEDED(hr), "Failed to get texture stage state, hr %#lx.\n", hr);
        ok(value == D3DTA_CURRENT, "Got unexpected value %#lx for D3DTSS_COLORARG2, stage %u.\n", value, i);
        hr = IDirect3DDevice8_GetTextureStageState(device, i, D3DTSS_ALPHAOP, &value);
        ok(SUCCEEDED(hr), "Failed to get texture stage state, hr %#lx.\n", hr);
        ok(value == (i ? D3DTOP_DISABLE : D3DTOP_SELECTARG1),
                "Got unexpected value %#lx for D3DTSS_ALPHAOP, stage %u.\n", value, i);
        hr = IDirect3DDevice8_GetTextureStageState(device, i, D3DTSS_ALPHAARG1, &value);
        ok(SUCCEEDED(hr), "Failed to get texture stage state, hr %#lx.\n", hr);
        ok(value == D3DTA_TEXTURE, "Got unexpected value %#lx for D3DTSS_ALPHAARG1, stage %u.\n", value, i);
        hr = IDirect3DDevice8_GetTextureStageState(device, i, D3DTSS_ALPHAARG2, &value);
        ok(SUCCEEDED(hr), "Failed to get texture stage state, hr %#lx.\n", hr);
        ok(value == D3DTA_CURRENT, "Got unexpected value %#lx for D3DTSS_ALPHAARG2, stage %u.\n", value, i);
        hr = IDirect3DDevice8_GetTextureStageState(device, i, D3DTSS_BUMPENVMAT00, &value);
        ok(SUCCEEDED(hr), "Failed to get texture stage state, hr %#lx.\n", hr);
        ok(!value, "Got unexpected value %#lx for D3DTSS_BUMPENVMAT00, stage %u.\n", value, i);
        hr = IDirect3DDevice8_GetTextureStageState(device, i, D3DTSS_BUMPENVMAT01, &value);
        ok(SUCCEEDED(hr), "Failed to get texture stage state, hr %#lx.\n", hr);
        ok(!value, "Got unexpected value %#lx for D3DTSS_BUMPENVMAT01, stage %u.\n", value, i);
        hr = IDirect3DDevice8_GetTextureStageState(device, i, D3DTSS_BUMPENVMAT10, &value);
        ok(SUCCEEDED(hr), "Failed to get texture stage state, hr %#lx.\n", hr);
        ok(!value, "Got unexpected value %#lx for D3DTSS_BUMPENVMAT10, stage %u.\n", value, i);
        hr = IDirect3DDevice8_GetTextureStageState(device, i, D3DTSS_BUMPENVMAT11, &value);
        ok(SUCCEEDED(hr), "Failed to get texture stage state, hr %#lx.\n", hr);
        ok(!value, "Got unexpected value %#lx for D3DTSS_BUMPENVMAT11, stage %u.\n", value, i);
        hr = IDirect3DDevice8_GetTextureStageState(device, i, D3DTSS_TEXCOORDINDEX, &value);
        ok(SUCCEEDED(hr), "Failed to get texture stage state, hr %#lx.\n", hr);
        ok(value == i, "Got unexpected value %#lx for D3DTSS_TEXCOORDINDEX, stage %u.\n", value, i);
        hr = IDirect3DDevice8_GetTextureStageState(device, i, D3DTSS_BUMPENVLSCALE, &value);
        ok(SUCCEEDED(hr), "Failed to get texture stage state, hr %#lx.\n", hr);
        ok(!value, "Got unexpected value %#lx for D3DTSS_BUMPENVLSCALE, stage %u.\n", value, i);
        hr = IDirect3DDevice8_GetTextureStageState(device, i, D3DTSS_BUMPENVLOFFSET, &value);
        ok(SUCCEEDED(hr), "Failed to get texture stage state, hr %#lx.\n", hr);
        ok(!value, "Got unexpected value %#lx for D3DTSS_BUMPENVLOFFSET, stage %u.\n", value, i);
        hr = IDirect3DDevice8_GetTextureStageState(device, i, D3DTSS_TEXTURETRANSFORMFLAGS, &value);
        ok(SUCCEEDED(hr), "Failed to get texture stage state, hr %#lx.\n", hr);
        ok(value == D3DTTFF_DISABLE,
                "Got unexpected value %#lx for D3DTSS_TEXTURETRANSFORMFLAGS, stage %u.\n", value, i);
        hr = IDirect3DDevice8_GetTextureStageState(device, i, D3DTSS_COLORARG0, &value);
        ok(SUCCEEDED(hr), "Failed to get texture stage state, hr %#lx.\n", hr);
        ok(value == D3DTA_CURRENT, "Got unexpected value %#lx for D3DTSS_COLORARG0, stage %u.\n", value, i);
        hr = IDirect3DDevice8_GetTextureStageState(device, i, D3DTSS_ALPHAARG0, &value);
        ok(SUCCEEDED(hr), "Failed to get texture stage state, hr %#lx.\n", hr);
        ok(value == D3DTA_CURRENT, "Got unexpected value %#lx for D3DTSS_ALPHAARG0, stage %u.\n", value, i);
        hr = IDirect3DDevice8_GetTextureStageState(device, i, D3DTSS_RESULTARG, &value);
        ok(SUCCEEDED(hr), "Failed to get texture stage state, hr %#lx.\n", hr);
        ok(value == D3DTA_CURRENT, "Got unexpected value %#lx for D3DTSS_RESULTARG, stage %u.\n", value, i);
    }

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d8);
    DestroyWindow(window);
}

static void test_cube_textures(void)
{
    IDirect3DCubeTexture8 *texture;
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d8;
    ULONG refcount;
    D3DCAPS8 caps;
    HWND window;
    HRESULT hr;

    window = create_window();
    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d8, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d8);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get device caps, hr %#lx.\n", hr);

    if (caps.TextureCaps & D3DPTEXTURECAPS_CUBEMAP)
    {
        hr = IDirect3DDevice8_CreateCubeTexture(device, 512, 1, 0, D3DFMT_X8R8G8B8, D3DPOOL_DEFAULT, &texture);
        ok(hr == D3D_OK, "Failed to create D3DPOOL_DEFAULT cube texture, hr %#lx.\n", hr);
        IDirect3DCubeTexture8_Release(texture);
        hr = IDirect3DDevice8_CreateCubeTexture(device, 512, 1, 0, D3DFMT_X8R8G8B8, D3DPOOL_MANAGED, &texture);
        ok(hr == D3D_OK, "Failed to create D3DPOOL_MANAGED cube texture, hr %#lx.\n", hr);
        IDirect3DCubeTexture8_Release(texture);
        hr = IDirect3DDevice8_CreateCubeTexture(device, 512, 1, 0, D3DFMT_X8R8G8B8, D3DPOOL_SYSTEMMEM, &texture);
        ok(hr == D3D_OK, "Failed to create D3DPOOL_SYSTEMMEM cube texture, hr %#lx.\n", hr);
        IDirect3DCubeTexture8_Release(texture);
    }
    else
    {
        hr = IDirect3DDevice8_CreateCubeTexture(device, 512, 1, 0, D3DFMT_X8R8G8B8, D3DPOOL_DEFAULT, &texture);
        ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx for D3DPOOL_DEFAULT cube texture.\n", hr);
        hr = IDirect3DDevice8_CreateCubeTexture(device, 512, 1, 0, D3DFMT_X8R8G8B8, D3DPOOL_MANAGED, &texture);
        ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx for D3DPOOL_MANAGED cube texture.\n", hr);
        hr = IDirect3DDevice8_CreateCubeTexture(device, 512, 1, 0, D3DFMT_X8R8G8B8, D3DPOOL_SYSTEMMEM, &texture);
        ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx for D3DPOOL_SYSTEMMEM cube texture.\n", hr);
    }
    hr = IDirect3DDevice8_CreateCubeTexture(device, 512, 1, 0, D3DFMT_X8R8G8B8, D3DPOOL_SCRATCH, &texture);
    ok(hr == D3D_OK, "Failed to create D3DPOOL_SCRATCH cube texture, hr %#lx.\n", hr);
    IDirect3DCubeTexture8_Release(texture);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d8);
    DestroyWindow(window);
}

static void test_get_set_texture(void)
{
    const IDirect3DBaseTexture8Vtbl *texture_vtbl;
    IDirect3DBaseTexture8 *texture;
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    texture = (IDirect3DBaseTexture8 *)0xdeadbeef;
    hr = IDirect3DDevice8_SetTexture(device, 0, NULL);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_GetTexture(device, 0, &texture);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    ok(!texture, "Got unexpected texture %p.\n", texture);

    hr = IDirect3DDevice8_CreateTexture(device, 16, 16, 1, 0, D3DFMT_A8R8G8B8,
            D3DPOOL_MANAGED, (IDirect3DTexture8 **)&texture);
    ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx.\n", hr);
    texture_vtbl = texture->lpVtbl;
    texture->lpVtbl = (IDirect3DBaseTexture8Vtbl *)0xdeadbeef;
    hr = IDirect3DDevice8_SetTexture(device, 0, texture);
    ok(SUCCEEDED(hr), "Failed to set texture, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTexture(device, 0, NULL);
    ok(SUCCEEDED(hr), "Failed to set texture, hr %#lx.\n", hr);
    texture->lpVtbl = NULL;
    hr = IDirect3DDevice8_SetTexture(device, 0, texture);
    ok(SUCCEEDED(hr), "Failed to set texture, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTexture(device, 0, NULL);
    ok(SUCCEEDED(hr), "Failed to set texture, hr %#lx.\n", hr);
    texture->lpVtbl = texture_vtbl;
    IDirect3DBaseTexture8_Release(texture);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

/* Test the behaviour of the IDirect3DDevice8::CreateImageSurface() method.
 *
 * The expected behaviour (as documented in the original DX8 docs) is that the
 * call returns a surface in the SYSTEMMEM pool. Games like Max Payne 1 and 2
 * depend on this behaviour.
 *
 * A short remark in the DX9 docs however states that the pool of the returned
 * surface object is D3DPOOL_SCRATCH. This is misinformation and would result
 * in screenshots not appearing in the savegame loading menu of both games
 * mentioned above (engine tries to display a texture from the scratch pool).
 *
 * This test verifies that the behaviour described in the original d3d8 docs
 * is the correct one. For more information about this issue, see the MSDN:
 *     d3d9 docs: "Converting to Direct3D 9"
 *     d3d9 reference: "IDirect3DDevice9::CreateOffscreenPlainSurface"
 *     d3d8 reference: "IDirect3DDevice8::CreateImageSurface" */
static void test_image_surface_pool(void)
{
    IDirect3DSurface8 *surface;
    IDirect3DDevice8 *device;
    D3DSURFACE_DESC desc;
    IDirect3D8 *d3d8;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    window = create_window();
    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d8, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d8);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_CreateImageSurface(device, 128, 128, D3DFMT_A8R8G8B8, &surface);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);
    hr = IDirect3DSurface8_GetDesc(surface, &desc);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(desc.Pool == D3DPOOL_SYSTEMMEM, "Got unexpected pool %#x.\n", desc.Pool);
    IDirect3DSurface8_Release(surface);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d8);
    DestroyWindow(window);
}

static void test_surface_get_container(void)
{
    IDirect3DTexture8 *texture = NULL;
    IDirect3DSurface8 *surface = NULL;
    IDirect3DDevice8 *device;
    IUnknown *container;
    IDirect3D8 *d3d8;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    window = create_window();
    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d8, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d8);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_CreateTexture(device, 128, 128, 1, 0,
            D3DFMT_A8R8G8B8, D3DPOOL_DEFAULT, &texture);
    ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx.\n", hr);
    ok(!!texture, "Got unexpected texture %p.\n", texture);

    hr = IDirect3DTexture8_GetSurfaceLevel(texture, 0, &surface);
    ok(SUCCEEDED(hr), "Failed to get surface level, hr %#lx.\n", hr);
    ok(!!surface, "Got unexpected surface %p.\n", surface);

    /* These should work... */
    container = NULL;
    hr = IDirect3DSurface8_GetContainer(surface, &IID_IUnknown, (void **)&container);
    ok(SUCCEEDED(hr), "Failed to get surface container, hr %#lx.\n", hr);
    ok(container == (IUnknown *)texture, "Got unexpected container %p, expected %p.\n", container, texture);
    IUnknown_Release(container);

    container = NULL;
    hr = IDirect3DSurface8_GetContainer(surface, &IID_IDirect3DResource8, (void **)&container);
    ok(SUCCEEDED(hr), "Failed to get surface container, hr %#lx.\n", hr);
    ok(container == (IUnknown *)texture, "Got unexpected container %p, expected %p.\n", container, texture);
    IUnknown_Release(container);

    container = NULL;
    hr = IDirect3DSurface8_GetContainer(surface, &IID_IDirect3DBaseTexture8, (void **)&container);
    ok(SUCCEEDED(hr), "Failed to get surface container, hr %#lx.\n", hr);
    ok(container == (IUnknown *)texture, "Got unexpected container %p, expected %p.\n", container, texture);
    IUnknown_Release(container);

    container = NULL;
    hr = IDirect3DSurface8_GetContainer(surface, &IID_IDirect3DTexture8, (void **)&container);
    ok(SUCCEEDED(hr), "Failed to get surface container, hr %#lx.\n", hr);
    ok(container == (IUnknown *)texture, "Got unexpected container %p, expected %p.\n", container, texture);
    IUnknown_Release(container);

    /* ...and this one shouldn't. This should return E_NOINTERFACE and set container to NULL. */
    hr = IDirect3DSurface8_GetContainer(surface, &IID_IDirect3DSurface8, (void **)&container);
    ok(hr == E_NOINTERFACE, "Got unexpected hr %#lx.\n", hr);
    ok(!container, "Got unexpected container %p.\n", container);

    IDirect3DSurface8_Release(surface);
    IDirect3DTexture8_Release(texture);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d8);
    DestroyWindow(window);
}

static void test_lockrect_invalid(void)
{
    static const RECT valid[] =
    {
        {60, 60, 68, 68},
        {120, 60, 128, 68},
        {60, 120, 68, 128},
    };
    static const RECT invalid[] =
    {
        {60, 60, 60, 68},       /* 0 height */
        {60, 60, 68, 60},       /* 0 width */
        {68, 60, 60, 68},       /* left > right */
        {60, 68, 68, 60},       /* top > bottom */
        {-8, 60,  0, 68},       /* left < surface */
        {60, -8, 68,  0},       /* top < surface */
        {-16, 60, -8, 68},      /* right < surface */
        {60, -16, 68, -8},      /* bottom < surface */
        {60, 60, 136, 68},      /* right > surface */
        {60, 60, 68, 136},      /* bottom > surface */
        {136, 60, 144, 68},     /* left > surface */
        {60, 136, 68, 144},     /* top > surface */
    };
    IDirect3DSurface8 *surface;
    IDirect3DTexture8 *texture;
    IDirect3DCubeTexture8 *cube_texture;
    D3DLOCKED_RECT locked_rect;
    IDirect3DDevice8 *device;
    HRESULT hr, expected_hr;
    IDirect3D8 *d3d8;
    unsigned int i, r;
    ULONG refcount;
    HWND window;
    BYTE *base;
    unsigned int offset, expected_offset;
    static const struct
    {
        D3DRESOURCETYPE type;
        D3DPOOL pool;
        const char *name;
        BOOL validate, clear;
    }
    resources[] =
    {
        {D3DRTYPE_SURFACE, D3DPOOL_SCRATCH, "scratch surface", TRUE, TRUE},
        {D3DRTYPE_TEXTURE, D3DPOOL_MANAGED, "managed texture", FALSE, FALSE},
        {D3DRTYPE_TEXTURE, D3DPOOL_SYSTEMMEM, "sysmem texture", FALSE, FALSE},
        {D3DRTYPE_TEXTURE, D3DPOOL_SCRATCH, "scratch texture", FALSE, FALSE},
        {D3DRTYPE_CUBETEXTURE, D3DPOOL_MANAGED, "default cube texture", TRUE, TRUE},
        {D3DRTYPE_CUBETEXTURE, D3DPOOL_SYSTEMMEM, "sysmem cube texture", TRUE, TRUE},
        {D3DRTYPE_CUBETEXTURE, D3DPOOL_SCRATCH, "scratch cube texture", TRUE, TRUE},
    };

    window = create_window();
    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d8, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d8);
        DestroyWindow(window);
        return;
    }

    for (r = 0; r < ARRAY_SIZE(resources); ++r)
    {
        texture = NULL;
        cube_texture = NULL;
        switch (resources[r].type)
        {
            case D3DRTYPE_SURFACE:
                hr = IDirect3DDevice8_CreateImageSurface(device, 128, 128, D3DFMT_A8R8G8B8, &surface);
                ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx, type %s.\n", hr, resources[r].name);
                break;

            case D3DRTYPE_TEXTURE:
                hr = IDirect3DDevice8_CreateTexture(device, 128, 128, 1, 0, D3DFMT_A8R8G8B8,
                        resources[r].pool, &texture);
                ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx, type %s.\n", hr, resources[r].name);
                hr = IDirect3DTexture8_GetSurfaceLevel(texture, 0, &surface);
                ok(SUCCEEDED(hr), "Failed to get surface level, hr %#lx, type %s.\n", hr, resources[r].name);
                break;

            case D3DRTYPE_CUBETEXTURE:
                hr = IDirect3DDevice8_CreateCubeTexture(device, 128, 1, 0, D3DFMT_A8R8G8B8,
                        resources[r].pool, &cube_texture);
                ok(SUCCEEDED(hr), "Failed to create cube texture, hr %#lx, type %s.\n", hr, resources[r].name);
                hr = IDirect3DCubeTexture8_GetCubeMapSurface(cube_texture, D3DCUBEMAP_FACE_NEGATIVE_X, 0, &surface);
                ok(SUCCEEDED(hr), "Failed to get surface level, hr %#lx, type %s.\n", hr, resources[r].name);
                break;

            default:
                break;
        }

        hr = IDirect3DSurface8_LockRect(surface, &locked_rect, NULL, 0);
        ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx, type %s.\n", hr, resources[r].name);
        base = locked_rect.pBits;
        hr = IDirect3DSurface8_UnlockRect(surface);
        ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx, type %s.\n", hr, resources[r].name);
        expected_hr = resources[r].type == D3DRTYPE_TEXTURE ? D3D_OK : D3DERR_INVALIDCALL;
        hr = IDirect3DSurface8_UnlockRect(surface);
        ok(hr == expected_hr, "Got hr %#lx, expected %#lx, type %s.\n", hr, expected_hr, resources[r].name);

        for (i = 0; i < ARRAY_SIZE(valid); ++i)
        {
            const RECT *rect = &valid[i];

            locked_rect.pBits = (BYTE *)0xdeadbeef;
            locked_rect.Pitch = 0xdeadbeef;

            hr = IDirect3DSurface8_LockRect(surface, &locked_rect, rect, 0);
            ok(SUCCEEDED(hr), "Failed to lock surface with rect %s, hr %#lx, type %s.\n",
                    wine_dbgstr_rect(rect), hr, resources[r].name);

            offset = (BYTE *)locked_rect.pBits - base;
            expected_offset = rect->top * locked_rect.Pitch + rect->left * 4;
            ok(offset == expected_offset,
                    "Got unexpected offset %u (expected %u) for rect %s, type %s.\n",
                    offset, expected_offset, wine_dbgstr_rect(rect), resources[r].name);

            hr = IDirect3DSurface8_UnlockRect(surface);
            ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx, type %s\n", hr, resources[r].name);

            if (texture)
            {
                hr = IDirect3DTexture8_LockRect(texture, 0, &locked_rect, rect, 0);
                ok(SUCCEEDED(hr), "Failed to lock surface with rect %s, hr %#lx, type %s.\n",
                        wine_dbgstr_rect(rect), hr, resources[r].name);

                offset = (BYTE *)locked_rect.pBits - base;
                ok(offset == expected_offset,
                        "Got unexpected offset %u (expected %u) for rect %s, type %s.\n",
                        offset, expected_offset, wine_dbgstr_rect(rect), resources[r].name);

                hr = IDirect3DTexture8_UnlockRect(texture, 0);
                ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx, type %s.\n", hr, resources[r].name);
            }
            if (cube_texture)
            {
                hr = IDirect3DCubeTexture8_LockRect(cube_texture, D3DCUBEMAP_FACE_NEGATIVE_X, 0, &locked_rect, rect, 0);
                ok(SUCCEEDED(hr), "Failed to lock surface with rect %s, hr %#lx, type %s.\n",
                        wine_dbgstr_rect(rect), hr, resources[r].name);

                offset = (BYTE *)locked_rect.pBits - base;
                ok(offset == expected_offset,
                        "Got unexpected offset %u (expected %u) for rect %s, type %s.\n",
                        offset, expected_offset, wine_dbgstr_rect(rect), resources[r].name);

                hr = IDirect3DCubeTexture8_UnlockRect(cube_texture, D3DCUBEMAP_FACE_NEGATIVE_X, 0);
                ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx, type %s.\n", hr, resources[r].name);
            }
        }

        for (i = 0; i < ARRAY_SIZE(invalid); ++i)
        {
            const RECT *rect = &invalid[i];

            locked_rect.pBits = (void *)0xdeadbeef;
            locked_rect.Pitch = 1;
            hr = IDirect3DSurface8_LockRect(surface, &locked_rect, rect, 0);
            if (resources[r].validate)
                ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx for rect %s, type %s.\n",
                        hr, wine_dbgstr_rect(rect), resources[r].name);
            else
                ok(SUCCEEDED(hr), "Got unexpected hr %#lx for rect %s, type %s.\n",
                        hr, wine_dbgstr_rect(rect), resources[r].name);

            if (SUCCEEDED(hr))
            {
                offset = (BYTE *)locked_rect.pBits - base;
                expected_offset = rect->top * locked_rect.Pitch + rect->left * 4;
                ok(offset == expected_offset,
                        "Got unexpected offset %u (expected %u) for rect %s, type %s.\n",
                        offset, expected_offset,wine_dbgstr_rect(rect), resources[r].name);

                hr = IDirect3DSurface8_UnlockRect(surface);
                ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx, type %s.\n", hr, resources[r].name);
            }
            else
            {
                ok(!locked_rect.pBits, "Got unexpected pBits %p, type %s.\n",
                        locked_rect.pBits, resources[r].name);
                ok(!locked_rect.Pitch, "Got unexpected Pitch %u, type %s.\n",
                        locked_rect.Pitch, resources[r].name);
            }
        }

        hr = IDirect3DSurface8_LockRect(surface, &locked_rect, NULL, 0);
        ok(SUCCEEDED(hr), "Failed to lock surface with rect NULL, hr %#lx, type %s.\n",
                hr, resources[r].name);
        locked_rect.pBits = (void *)0xdeadbeef;
        locked_rect.Pitch = 1;
        hr = IDirect3DSurface8_LockRect(surface, &locked_rect, NULL, 0);
        ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx, type %s.\n", hr, resources[r].name);
        if (resources[r].clear)
        {
            ok(!locked_rect.pBits, "Got unexpected pBits %p, type %s.\n",
                    locked_rect.pBits, resources[r].name);
            ok(!locked_rect.Pitch, "Got unexpected Pitch %u, type %s.\n",
                    locked_rect.Pitch, resources[r].name);
        }
        else
        {
            ok(locked_rect.pBits == (void *)0xdeadbeef, "Got unexpected pBits %p, type %s.\n",
                    locked_rect.pBits, resources[r].name);
            ok(locked_rect.Pitch == 1, "Got unexpected Pitch %u, type %s.\n",
                    locked_rect.Pitch, resources[r].name);
        }
        hr = IDirect3DSurface8_UnlockRect(surface);
        ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx, type %s.\n", hr, resources[r].name);

        hr = IDirect3DSurface8_LockRect(surface, &locked_rect, &valid[0], 0);
        ok(hr == D3D_OK, "Got unexpected hr %#lx for rect %s, type %s.\n",
                hr, wine_dbgstr_rect(&valid[0]), resources[r].name);
        hr = IDirect3DSurface8_LockRect(surface, &locked_rect, &valid[0], 0);
        ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx for rect %s, type %s.\n",
                hr, wine_dbgstr_rect(&valid[0]), resources[r].name);
        hr = IDirect3DSurface8_LockRect(surface, &locked_rect, &valid[1], 0);
        ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx for rect %s, type %s.\n",
                hr, wine_dbgstr_rect(&valid[1]), resources[r].name);
        hr = IDirect3DSurface8_UnlockRect(surface);
        ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx, type %s.\n", hr, resources[r].name);

        IDirect3DSurface8_Release(surface);
        if (texture)
        {
            hr = IDirect3DTexture8_LockRect(texture, 0, &locked_rect, NULL, 0);
            ok(SUCCEEDED(hr), "Failed to lock texture with rect NULL, hr %#lx, type %s.\n",
                    hr, resources[r].name);
            locked_rect.pBits = (void *)0xdeadbeef;
            locked_rect.Pitch = 1;
            hr = IDirect3DTexture8_LockRect(texture, 0, &locked_rect, NULL, 0);
            ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx, type %s.\n", hr, resources[r].name);
            ok(locked_rect.pBits == (void *)0xdeadbeef, "Got unexpected pBits %p, type %s.\n",
                    locked_rect.pBits, resources[r].name);
            ok(locked_rect.Pitch == 1, "Got unexpected Pitch %u, type %s.\n",
                    locked_rect.Pitch, resources[r].name);
            hr = IDirect3DSurface8_LockRect(surface, &locked_rect, NULL, 0);
            ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx, type %s.\n", hr, resources[r].name);
            hr = IDirect3DTexture8_UnlockRect(texture, 0);
            ok(SUCCEEDED(hr), "Failed to unlock texture, hr %#lx, type %s.\n", hr, resources[r].name);
            hr = IDirect3DTexture8_UnlockRect(texture, 0);
            ok(hr == D3D_OK, "Got unexpected hr %#lx, type %s.\n", hr, resources[r].name);

            hr = IDirect3DTexture8_LockRect(texture, 0, &locked_rect, &valid[0], 0);
            ok(hr == D3D_OK, "Got unexpected hr %#lx for rect %s, type %s.\n",
                    hr, wine_dbgstr_rect(&valid[0]), resources[r].name);
            hr = IDirect3DTexture8_LockRect(texture, 0, &locked_rect, &valid[0], 0);
            ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx for rect %s, type %s.\n",
                    hr, wine_dbgstr_rect(&valid[0]), resources[r].name);
            hr = IDirect3DTexture8_LockRect(texture, 0, &locked_rect, &valid[1], 0);
            ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx for rect %s, type %s.\n",
                    hr, wine_dbgstr_rect(&valid[1]), resources[r].name);
            hr = IDirect3DTexture8_UnlockRect(texture, 0);
            ok(SUCCEEDED(hr), "Failed to unlock texture, hr %#lx, type %s.\n", hr, resources[r].name);

            IDirect3DTexture8_Release(texture);

            hr = IDirect3DDevice8_CreateTexture(device, 128, 128, 1, D3DUSAGE_WRITEONLY,
                    D3DFMT_A8R8G8B8, resources[r].pool, &texture);
            ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx for type %s.\n",
                    hr, resources[r].name);
        }

        if (cube_texture)
        {
            hr = IDirect3DCubeTexture8_LockRect(cube_texture, D3DCUBEMAP_FACE_NEGATIVE_X, 0,
                    &locked_rect, NULL, 0);
            ok(SUCCEEDED(hr), "Failed to lock texture with rect NULL, hr %#lx, type %s.\n",
                    hr, resources[r].name);
            locked_rect.pBits = (void *)0xdeadbeef;
            locked_rect.Pitch = 1;
            hr = IDirect3DCubeTexture8_LockRect(cube_texture, D3DCUBEMAP_FACE_NEGATIVE_X, 0,
                    &locked_rect, NULL, 0);
            ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx, type %s.\n", hr, resources[r].name);
            ok(!locked_rect.pBits, "Got unexpected pBits %p, type %s.\n",
                    locked_rect.pBits, resources[r].name);
            ok(!locked_rect.Pitch, "Got unexpected Pitch %u, type %s.\n",
                    locked_rect.Pitch, resources[r].name);
            hr = IDirect3DSurface8_LockRect(surface, &locked_rect, NULL, 0);
            ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx, type %s.\n", hr, resources[r].name);
            hr = IDirect3DCubeTexture8_UnlockRect(cube_texture, D3DCUBEMAP_FACE_NEGATIVE_X, 0);
            ok(SUCCEEDED(hr), "Failed to unlock texture, hr %#lx, type %s.\n", hr, resources[r].name);
            hr = IDirect3DCubeTexture8_UnlockRect(cube_texture, D3DCUBEMAP_FACE_NEGATIVE_X, 0);
            ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx, type %s.\n", hr, resources[r].name);

            hr = IDirect3DCubeTexture8_LockRect(cube_texture, D3DCUBEMAP_FACE_NEGATIVE_X, 0,
                    &locked_rect, &valid[0], 0);
            ok(hr == D3D_OK, "Got unexpected hr %#lx for rect %s, type %s.\n",
                    hr, wine_dbgstr_rect(&valid[0]), resources[r].name);
            hr = IDirect3DCubeTexture8_LockRect(cube_texture, D3DCUBEMAP_FACE_NEGATIVE_X, 0,
                    &locked_rect, &valid[0], 0);
            ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx for rect %s, type %s.\n",
                    hr, wine_dbgstr_rect(&valid[0]), resources[r].name);
            hr = IDirect3DCubeTexture8_LockRect(cube_texture, D3DCUBEMAP_FACE_NEGATIVE_X, 0,
                    &locked_rect, &valid[1], 0);
            ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx for rect %s, type %s.\n",
                    hr, wine_dbgstr_rect(&valid[1]), resources[r].name);
            hr = IDirect3DCubeTexture8_UnlockRect(cube_texture, D3DCUBEMAP_FACE_NEGATIVE_X, 0);
            ok(SUCCEEDED(hr), "Failed to unlock texture, hr %#lx, type %s.\n", hr, resources[r].name);

            IDirect3DTexture8_Release(cube_texture);

            hr = IDirect3DDevice8_CreateCubeTexture(device, 128, 1, D3DUSAGE_WRITEONLY, D3DFMT_A8R8G8B8,
                    resources[r].pool, &cube_texture);
            ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx for type %s.\n",
                    hr, resources[r].name);
        }
    }

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d8);
    DestroyWindow(window);
}

static void test_private_data(void)
{
    ULONG refcount, expected_refcount;
    IDirect3DTexture8 *texture;
    IDirect3DSurface8 *surface, *surface2;
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d8;
    IUnknown *ptr;
    HWND window;
    HRESULT hr;
    DWORD size;
    DWORD data[4] = {1, 2, 3, 4};
    static const GUID d3d8_private_data_test_guid2 =
    {
        0x2e5afac2,
        0x87b5,
        0x4c10,
        {0x9b,0x4b,0x89,0xd7,0xd1,0x12,0xe7,0x2b}
    };

    window = create_window();
    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d8, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d8);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_CreateImageSurface(device, 4, 4, D3DFMT_A8R8G8B8, &surface);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

    hr = IDirect3DSurface8_SetPrivateData(surface, &d3d8_private_data_test_guid,
            device, 0, D3DSPD_IUNKNOWN);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DSurface8_SetPrivateData(surface, &d3d8_private_data_test_guid,
            device, 5, D3DSPD_IUNKNOWN);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DSurface8_SetPrivateData(surface, &d3d8_private_data_test_guid,
            device, sizeof(IUnknown *) * 2, D3DSPD_IUNKNOWN);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);

    /* A failing SetPrivateData call does not clear the old data with the same tag. */
    hr = IDirect3DSurface8_SetPrivateData(surface, &d3d8_private_data_test_guid, device,
            sizeof(device), D3DSPD_IUNKNOWN);
    ok(SUCCEEDED(hr), "Failed to set private data, hr %#lx.\n", hr);
    hr = IDirect3DSurface8_SetPrivateData(surface, &d3d8_private_data_test_guid, device,
            sizeof(device) * 2, D3DSPD_IUNKNOWN);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);
    size = sizeof(ptr);
    hr = IDirect3DSurface8_GetPrivateData(surface, &d3d8_private_data_test_guid, &ptr, &size);
    ok(SUCCEEDED(hr), "Failed to get private data, hr %#lx.\n", hr);
    IUnknown_Release(ptr);
    hr = IDirect3DSurface8_FreePrivateData(surface, &d3d8_private_data_test_guid);
    ok(SUCCEEDED(hr), "Failed to free private data, hr %#lx.\n", hr);

    refcount = get_refcount((IUnknown *)device);
    hr = IDirect3DSurface8_SetPrivateData(surface, &d3d8_private_data_test_guid,
            device, sizeof(IUnknown *), D3DSPD_IUNKNOWN);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    expected_refcount = refcount + 1;
    refcount = get_refcount((IUnknown *)device);
    ok(refcount == expected_refcount, "Got unexpected refcount %lu, expected %lu.\n", refcount, expected_refcount);
    hr = IDirect3DSurface8_FreePrivateData(surface, &d3d8_private_data_test_guid);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    expected_refcount = refcount - 1;
    refcount = get_refcount((IUnknown *)device);
    ok(refcount == expected_refcount, "Got unexpected refcount %lu, expected %lu.\n", refcount, expected_refcount);

    hr = IDirect3DSurface8_SetPrivateData(surface, &d3d8_private_data_test_guid,
            device, sizeof(IUnknown *), D3DSPD_IUNKNOWN);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DSurface8_SetPrivateData(surface, &d3d8_private_data_test_guid,
            surface, sizeof(IUnknown *), D3DSPD_IUNKNOWN);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    refcount = get_refcount((IUnknown *)device);
    ok(refcount == expected_refcount, "Got unexpected refcount %lu, expected %lu.\n", refcount, expected_refcount);

    hr = IDirect3DSurface8_SetPrivateData(surface, &d3d8_private_data_test_guid,
            device, sizeof(IUnknown *), D3DSPD_IUNKNOWN);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    size = 2 * sizeof(ptr);
    hr = IDirect3DSurface8_GetPrivateData(surface, &d3d8_private_data_test_guid, &ptr, &size);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    ok(size == sizeof(device), "Got unexpected size %lu.\n", size);
    expected_refcount = refcount + 2;
    refcount = get_refcount((IUnknown *)device);
    ok(refcount == expected_refcount, "Got unexpected refcount %lu, expected %lu.\n", refcount, expected_refcount);
    ok(ptr == (IUnknown *)device, "Got unexpected ptr %p, expected %p.\n", ptr, device);
    IUnknown_Release(ptr);
    expected_refcount--;

    ptr = (IUnknown *)0xdeadbeef;
    size = 1;
    hr = IDirect3DSurface8_GetPrivateData(surface, &d3d8_private_data_test_guid, NULL, &size);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    ok(size == sizeof(device), "Got unexpected size %lu.\n", size);
    size = 2 * sizeof(ptr);
    hr = IDirect3DSurface8_GetPrivateData(surface, &d3d8_private_data_test_guid, NULL, &size);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    ok(size == sizeof(device), "Got unexpected size %lu.\n", size);
    refcount = get_refcount((IUnknown *)device);
    ok(refcount == expected_refcount, "Got unexpected refcount %lu, expected %lu.\n", refcount, expected_refcount);
    size = 1;
    hr = IDirect3DSurface8_GetPrivateData(surface, &d3d8_private_data_test_guid, &ptr, &size);
    ok(hr == D3DERR_MOREDATA, "Got unexpected hr %#lx.\n", hr);
    ok(size == sizeof(device), "Got unexpected size %lu.\n", size);
    ok(ptr == (IUnknown *)0xdeadbeef, "Got unexpected pointer %p.\n", ptr);
    hr = IDirect3DSurface8_GetPrivateData(surface, &d3d8_private_data_test_guid2, NULL, NULL);
    ok(hr == D3DERR_NOTFOUND, "Got unexpected hr %#lx.\n", hr);
    size = 0xdeadbabe;
    hr = IDirect3DSurface8_GetPrivateData(surface, &d3d8_private_data_test_guid2, &ptr, &size);
    ok(hr == D3DERR_NOTFOUND, "Got unexpected hr %#lx.\n", hr);
    ok(ptr == (IUnknown *)0xdeadbeef, "Got unexpected pointer %p.\n", ptr);
    ok(size == 0xdeadbabe, "Got unexpected size %lu.\n", size);
    /* GetPrivateData with size = NULL causes an access violation on Windows if the
     * requested data exists. */

    /* Destroying the surface frees the held reference. */
    IDirect3DSurface8_Release(surface);
    expected_refcount = refcount - 2;
    refcount = get_refcount((IUnknown *)device);
    ok(refcount == expected_refcount, "Got unexpected refcount %lu, expected %lu.\n", refcount, expected_refcount);

    hr = IDirect3DDevice8_CreateTexture(device, 4, 4, 2, 0, D3DFMT_A8R8G8B8, D3DPOOL_SCRATCH, &texture);
    ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx.\n", hr);
    hr = IDirect3DTexture8_GetSurfaceLevel(texture, 0, &surface);
    ok(SUCCEEDED(hr), "Failed to get texture level 0, hr %#lx.\n", hr);
    hr = IDirect3DTexture8_GetSurfaceLevel(texture, 1, &surface2);
    ok(SUCCEEDED(hr), "Failed to get texture level 1, hr %#lx.\n", hr);

    hr = IDirect3DTexture8_SetPrivateData(texture, &d3d8_private_data_test_guid, data, sizeof(data), 0);
    ok(SUCCEEDED(hr), "Failed to set private data, hr %#lx.\n", hr);

    memset(data, 0, sizeof(data));
    size = sizeof(data);
    hr = IDirect3DSurface8_GetPrivateData(surface, &d3d8_private_data_test_guid, data, &size);
    ok(hr == D3DERR_NOTFOUND, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DTexture8_GetPrivateData(texture, &d3d8_private_data_test_guid, data, &size);
    ok(SUCCEEDED(hr), "Failed to get private data, hr %#lx.\n", hr);
    ok(data[0] == 1 && data[1] == 2 && data[2] == 3 && data[3] == 4,
            "Got unexpected private data: %lu, %lu, %lu, %lu.\n", data[0], data[1], data[2], data[3]);

    hr = IDirect3DTexture8_FreePrivateData(texture, &d3d8_private_data_test_guid);
    ok(SUCCEEDED(hr), "Failed to free private data, hr %#lx.\n", hr);

    hr = IDirect3DSurface8_SetPrivateData(surface, &d3d8_private_data_test_guid, data, sizeof(data), 0);
    ok(SUCCEEDED(hr), "Failed to set private data, hr %#lx.\n", hr);
    hr = IDirect3DSurface8_GetPrivateData(surface2, &d3d8_private_data_test_guid, data, &size);
    ok(hr == D3DERR_NOTFOUND, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DSurface8_FreePrivateData(surface, &d3d8_private_data_test_guid);
    ok(SUCCEEDED(hr), "Failed to free private data, hr %#lx.\n", hr);

    IDirect3DSurface8_Release(surface2);
    IDirect3DSurface8_Release(surface);
    IDirect3DTexture8_Release(texture);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d8);
    DestroyWindow(window);
}

static void test_surface_dimensions(void)
{
    IDirect3DSurface8 *surface;
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d8;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    window = create_window();
    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d8, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d8);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_CreateImageSurface(device, 0, 1, D3DFMT_A8R8G8B8, &surface);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateImageSurface(device, 1, 0, D3DFMT_A8R8G8B8, &surface);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d8);
    DestroyWindow(window);
}

static void test_surface_format_null(void)
{
    static const D3DFORMAT D3DFMT_NULL = MAKEFOURCC('N','U','L','L');
    IDirect3DTexture8 *texture;
    IDirect3DSurface8 *surface;
    IDirect3DSurface8 *rt, *ds;
    D3DLOCKED_RECT locked_rect;
    IDirect3DDevice8 *device;
    D3DSURFACE_DESC desc;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");

    hr = IDirect3D8_CheckDeviceFormat(d3d, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8,
            D3DUSAGE_RENDERTARGET, D3DRTYPE_SURFACE, D3DFMT_NULL);
    if (hr != D3D_OK)
    {
        skip("No D3DFMT_NULL support, skipping test.\n");
        IDirect3D8_Release(d3d);
        return;
    }

    window = create_window();
    if (!(device = create_device(d3d, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3D8_CheckDeviceFormat(d3d, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8,
            D3DUSAGE_RENDERTARGET, D3DRTYPE_TEXTURE, D3DFMT_NULL);
    ok(hr == D3D_OK, "D3DFMT_NULL should be supported for render target textures, hr %#lx.\n", hr);

    hr = IDirect3D8_CheckDepthStencilMatch(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8,
            D3DFMT_NULL, D3DFMT_D24S8);
    ok(SUCCEEDED(hr), "Depth stencil match failed for D3DFMT_NULL, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CreateRenderTarget(device, 128, 128, D3DFMT_NULL,
            D3DMULTISAMPLE_NONE, TRUE, &surface);
    ok(SUCCEEDED(hr), "Failed to create render target, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetRenderTarget(device, &rt);
    ok(SUCCEEDED(hr), "Failed to get original render target, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetDepthStencilSurface(device, &ds);
    ok(SUCCEEDED(hr), "Failed to get original depth/stencil, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderTarget(device, surface, NULL);
    ok(SUCCEEDED(hr), "Failed to set render target, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0x00000000, 0.0f, 0);
    ok(SUCCEEDED(hr), "Clear failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderTarget(device, rt, ds);
    ok(SUCCEEDED(hr), "Failed to set render target, hr %#lx.\n", hr);

    IDirect3DSurface8_Release(rt);
    IDirect3DSurface8_Release(ds);

    hr = IDirect3DSurface8_GetDesc(surface, &desc);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(desc.Width == 128, "Expected width 128, got %u.\n", desc.Width);
    ok(desc.Height == 128, "Expected height 128, got %u.\n", desc.Height);

    hr = IDirect3DSurface8_LockRect(surface, &locked_rect, NULL, 0);
    ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx.\n", hr);
    ok(locked_rect.Pitch, "Expected non-zero pitch, got %u.\n", locked_rect.Pitch);
    ok(!!locked_rect.pBits, "Expected non-NULL pBits, got %p.\n", locked_rect.pBits);

    hr = IDirect3DSurface8_UnlockRect(surface);
    ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);

    IDirect3DSurface8_Release(surface);

    hr = IDirect3DDevice8_CreateTexture(device, 128, 128, 0, D3DUSAGE_RENDERTARGET,
            D3DFMT_NULL, D3DPOOL_DEFAULT, &texture);
    ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx.\n", hr);
    IDirect3DTexture8_Release(texture);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_surface_double_unlock(void)
{
    static const D3DPOOL pools[] =
    {
        D3DPOOL_DEFAULT,
        D3DPOOL_SYSTEMMEM,
    };
    IDirect3DSurface8 *surface;
    IDirect3DDevice8 *device;
    D3DLOCKED_RECT lr;
    IDirect3D8 *d3d;
    unsigned int i;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    for (i = 0; i < ARRAY_SIZE(pools); ++i)
    {
        switch (pools[i])
        {
            case D3DPOOL_DEFAULT:
                hr = IDirect3D8_CheckDeviceFormat(d3d, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8,
                        D3DUSAGE_RENDERTARGET, D3DRTYPE_SURFACE, D3DFMT_X8R8G8B8);
                if (FAILED(hr))
                {
                    skip("D3DFMT_X8R8G8B8 render targets not supported, skipping double unlock DEFAULT pool test.\n");
                    continue;
                }

                hr = IDirect3DDevice8_CreateRenderTarget(device, 64, 64, D3DFMT_X8R8G8B8,
                        D3DMULTISAMPLE_NONE, TRUE, &surface);
                ok(SUCCEEDED(hr), "Failed to create render target, hr %#lx.\n", hr);
                break;

            case D3DPOOL_SYSTEMMEM:
                hr = IDirect3DDevice8_CreateImageSurface(device, 64, 64, D3DFMT_X8R8G8B8, &surface);
                ok(SUCCEEDED(hr), "Failed to create image surface, hr %#lx.\n", hr);
                break;

            default:
                break;
        }

        hr = IDirect3DSurface8_UnlockRect(surface);
        ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx, for surface in pool %#x.\n", hr, pools[i]);
        hr = IDirect3DSurface8_LockRect(surface, &lr, NULL, 0);
        ok(SUCCEEDED(hr), "Failed to lock surface in pool %#x, hr %#lx.\n", pools[i], hr);
        hr = IDirect3DSurface8_UnlockRect(surface);
        ok(SUCCEEDED(hr), "Failed to unlock surface in pool %#x, hr %#lx.\n", pools[i], hr);
        hr = IDirect3DSurface8_UnlockRect(surface);
        ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx, for surface in pool %#x.\n", hr, pools[i]);

        IDirect3DSurface8_Release(surface);
    }

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_surface_blocks(void)
{
    static const struct
    {
        D3DFORMAT fmt;
        const char *name;
        unsigned int block_width;
        unsigned int block_height;
        BOOL broken;
        BOOL create_size_checked, core_fmt;
    }
    formats[] =
    {
        {D3DFMT_DXT1,                 "D3DFMT_DXT1", 4, 4, FALSE, TRUE,  TRUE },
        {D3DFMT_DXT2,                 "D3DFMT_DXT2", 4, 4, FALSE, TRUE,  TRUE },
        {D3DFMT_DXT3,                 "D3DFMT_DXT3", 4, 4, FALSE, TRUE,  TRUE },
        {D3DFMT_DXT4,                 "D3DFMT_DXT4", 4, 4, FALSE, TRUE,  TRUE },
        {D3DFMT_DXT5,                 "D3DFMT_DXT5", 4, 4, FALSE, TRUE,  TRUE },
        /* ATI1N and ATI2N have 2x2 blocks on all AMD cards and Geforce 7 cards,
         * which doesn't match the format spec. On newer Nvidia cards
         * they have the correct 4x4 block size */
        {MAKEFOURCC('A','T','I','1'), "ATI1N",       4, 4, TRUE,  FALSE, FALSE},
        {MAKEFOURCC('A','T','I','2'), "ATI2N",       4, 4, TRUE,  FALSE, FALSE},
        /* Windows drivers generally enforce block-aligned locks for
         * YUY2 and UYVY. The notable exception is the AMD r500 driver
         * in d3d8. The same driver checks the sizes in d3d9. */
        {D3DFMT_YUY2,                 "D3DFMT_YUY2", 2, 1, TRUE,  FALSE, TRUE },
        {D3DFMT_UYVY,                 "D3DFMT_UYVY", 2, 1, TRUE,  FALSE, TRUE },
    };
    static const struct
    {
        D3DPOOL pool;
        const char *name;
        /* Don't check the return value, Nvidia returns D3DERR_INVALIDCALL for some formats
         * and E_INVALIDARG/DDERR_INVALIDPARAMS for others. */
        BOOL success;
    }
    pools[] =
    {
        {D3DPOOL_DEFAULT,       "D3DPOOL_DEFAULT",  FALSE},
        {D3DPOOL_SCRATCH,       "D3DPOOL_SCRATCH",  TRUE},
        {D3DPOOL_SYSTEMMEM,     "D3DPOOL_SYSTEMMEM",TRUE},
        {D3DPOOL_MANAGED,       "D3DPOOL_MANAGED",  TRUE},
    };
    static struct
    {
        D3DRESOURCETYPE rtype;
        const char *type_name;
        D3DPOOL pool;
        const char *pool_name;
        BOOL need_driver_support, need_runtime_support;
    }
    create_tests[] =
    {
        /* D3d8 only supports sysmem surfaces, which are created via CreateImageSurface. Other tests confirm
         * that they are D3DPOOL_SYSTEMMEM surfaces, but their creation restriction behaves like the scratch
         * pool in d3d9. */
        {D3DRTYPE_SURFACE,     "D3DRTYPE_SURFACE",     D3DPOOL_SYSTEMMEM, "D3DPOOL_SYSTEMMEM", FALSE, TRUE },

        {D3DRTYPE_TEXTURE,     "D3DRTYPE_TEXTURE",     D3DPOOL_DEFAULT,   "D3DPOOL_DEFAULT",   TRUE,  FALSE },
        {D3DRTYPE_TEXTURE,     "D3DRTYPE_TEXTURE",     D3DPOOL_SYSTEMMEM, "D3DPOOL_SYSTEMMEM", TRUE,  FALSE },
        {D3DRTYPE_TEXTURE,     "D3DRTYPE_TEXTURE",     D3DPOOL_MANAGED,   "D3DPOOL_MANAGED",   TRUE,  FALSE },
        {D3DRTYPE_TEXTURE,     "D3DRTYPE_TEXTURE",     D3DPOOL_SCRATCH,   "D3DPOOL_SCRATCH",   FALSE, TRUE  },

        {D3DRTYPE_CUBETEXTURE, "D3DRTYPE_CUBETEXTURE", D3DPOOL_DEFAULT,   "D3DPOOL_DEFAULT",   TRUE,  FALSE },
        {D3DRTYPE_CUBETEXTURE, "D3DRTYPE_CUBETEXTURE", D3DPOOL_SYSTEMMEM, "D3DPOOL_SYSTEMMEM", TRUE,  FALSE },
        {D3DRTYPE_CUBETEXTURE, "D3DRTYPE_CUBETEXTURE", D3DPOOL_MANAGED,   "D3DPOOL_MANAGED",   TRUE,  FALSE },
        {D3DRTYPE_CUBETEXTURE, "D3DRTYPE_CUBETEXTURE", D3DPOOL_SCRATCH,   "D3DPOOL_SCRATCH",   FALSE, TRUE  },
    };
    IDirect3DTexture8 *texture;
    IDirect3DCubeTexture8 *cube_texture;
    IDirect3DSurface8 *surface;
    D3DLOCKED_RECT locked_rect;
    IDirect3DDevice8 *device;
    unsigned int i, j, k, w, h;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;
    RECT rect;
    BOOL tex_pow2, cube_pow2;
    D3DCAPS8 caps;
    static const RECT invalid[] =
    {
        {60, 60, 60, 68},       /* 0 height */
        {60, 60, 68, 60},       /* 0 width */
        {68, 60, 60, 68},       /* left > right */
        {60, 68, 68, 60},       /* top > bottom */
        {-8, 60,  0, 68},       /* left < surface */
        {60, -8, 68,  0},       /* top < surface */
        {-16, 60, -8, 68},      /* right < surface */
        {60, -16, 68, -8},      /* bottom < surface */
        {60, 60, 136, 68},      /* right > surface */
        {60, 60, 68, 136},      /* bottom > surface */
        {136, 60, 144, 68},     /* left > surface */
        {60, 136, 68, 144},     /* top > surface */
    };

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get caps, hr %#lx.\n", hr);
    tex_pow2 = caps.TextureCaps & D3DPTEXTURECAPS_POW2;
    if (tex_pow2)
        tex_pow2 = !(caps.TextureCaps & D3DPTEXTURECAPS_NONPOW2CONDITIONAL);
    cube_pow2 = !!(caps.TextureCaps & D3DPTEXTURECAPS_CUBEMAP_POW2);

    for (i = 0; i < ARRAY_SIZE(formats); ++i)
    {
        BOOL tex_support, cube_support, surface_support, format_known;

        hr = IDirect3D8_CheckDeviceFormat(d3d, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8,
                0, D3DRTYPE_TEXTURE, formats[i].fmt);
        tex_support = SUCCEEDED(hr);
        hr = IDirect3D8_CheckDeviceFormat(d3d, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8,
                0, D3DRTYPE_CUBETEXTURE, formats[i].fmt);
        cube_support = SUCCEEDED(hr);
        hr = IDirect3D8_CheckDeviceFormat(d3d, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8,
                0, D3DRTYPE_SURFACE, formats[i].fmt);
        surface_support = SUCCEEDED(hr);

        /* Scratch pool in general allows texture creation even if the driver does
         * not support the format. If the format is an extension format that is not
         * known to the runtime, like ATI2N, some driver support is required for
         * this to work.
         *
         * It is also possible that Windows Vista and Windows 7 d3d8 runtimes know
         * about ATI2N. I cannot check this because all my Vista+ machines support
         * ATI2N in hardware, but none of my WinXP machines do. */
        format_known = tex_support || cube_support || surface_support;

        for (w = 1; w <= 8; w++)
        {
            for (h = 1; h <= 8; h++)
            {
                BOOL block_aligned = TRUE;
                BOOL size_is_pow2;

                if (w & (formats[i].block_width - 1) || h & (formats[i].block_height - 1))
                    block_aligned = FALSE;

                size_is_pow2 = !(w & (w - 1) || h & (h - 1));

                for (j = 0; j < ARRAY_SIZE(create_tests); j++)
                {
                    BOOL support, pow2;
                    HRESULT expect_hr;
                    BOOL may_succeed = FALSE;
                    IUnknown **check_null;

                    if (!formats[i].core_fmt)
                    {
                        /* AMD warns against creating ATI2N textures smaller than
                         * the block size because the runtime cannot calculate the
                         * correct texture size. Generalize this for all extension
                         * formats. */
                        if (w < formats[i].block_width || h < formats[i].block_height)
                            continue;
                    }

                    texture = (IDirect3DTexture8 *)0xdeadbeef;
                    cube_texture = (IDirect3DCubeTexture8 *)0xdeadbeef;
                    surface = (IDirect3DSurface8 *)0xdeadbeef;

                    switch (create_tests[j].rtype)
                    {
                        case D3DRTYPE_TEXTURE:
                            check_null = (IUnknown **)&texture;
                            hr = IDirect3DDevice8_CreateTexture(device, w, h, 1, 0,
                                    formats[i].fmt, create_tests[j].pool, &texture);
                            support = tex_support;
                            pow2 = tex_pow2;
                            break;

                        case D3DRTYPE_CUBETEXTURE:
                            if (w != h)
                                continue;
                            check_null = (IUnknown **)&cube_texture;
                            hr = IDirect3DDevice8_CreateCubeTexture(device, w, 1, 0,
                                    formats[i].fmt, create_tests[j].pool, &cube_texture);
                            support = cube_support;
                            pow2 = cube_pow2;
                            break;

                        case D3DRTYPE_SURFACE:
                            check_null = (IUnknown **)&surface;
                            hr = IDirect3DDevice8_CreateImageSurface(device, w, h,
                                    formats[i].fmt, &surface);
                            support = surface_support;
                            pow2 = FALSE;
                            break;

                        default:
                            pow2 = FALSE;
                            support = FALSE;
                            check_null = NULL;
                            break;
                    }

                    if (create_tests[j].need_driver_support && !support)
                        expect_hr = D3DERR_INVALIDCALL;
                    else if (create_tests[j].need_runtime_support && !formats[i].core_fmt && !format_known)
                        expect_hr = D3DERR_INVALIDCALL;
                    else if (formats[i].create_size_checked && !block_aligned)
                        expect_hr = D3DERR_INVALIDCALL;
                    else if (pow2 && !size_is_pow2 && create_tests[j].need_driver_support)
                        expect_hr = D3DERR_INVALIDCALL;
                    else
                        expect_hr = D3D_OK;

                    if (!formats[i].core_fmt && !format_known && FAILED(expect_hr))
                        may_succeed = TRUE;

                    /* Wine knows about ATI2N and happily creates a scratch resource even if GL
                     * does not support it. Accept scratch creation of extension formats on
                     * Windows as well if it occurs. We don't really care if e.g. a Windows 7
                     * on an r200 GPU creates scratch ATI2N texture even though the card doesn't
                     * support it. */
                    ok(hr == expect_hr || ((SUCCEEDED(hr) && may_succeed)),
                            "Got unexpected hr %#lx for format %s, pool %s, type %s, size %ux%u.\n",
                            hr, formats[i].name, create_tests[j].pool_name, create_tests[j].type_name, w, h);

                    if (FAILED(hr))
                        ok(*check_null == NULL, "Got object ptr %p, expected NULL.\n", *check_null);
                    else
                        IUnknown_Release(*check_null);
                }
            }
        }

        hr = IDirect3D8_CheckDeviceFormat(d3d, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8,
                D3DUSAGE_DYNAMIC, D3DRTYPE_TEXTURE, formats[i].fmt);
        if (FAILED(hr))
        {
            skip("Format %s not supported, skipping lockrect offset tests.\n", formats[i].name);
            continue;
        }

        for (j = 0; j < ARRAY_SIZE(pools); ++j)
        {
            hr = IDirect3DDevice8_CreateTexture(device, 128, 128, 1,
                    pools[j].pool == D3DPOOL_DEFAULT ? D3DUSAGE_DYNAMIC : 0,
                    formats[i].fmt, pools[j].pool, &texture);
            ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx.\n", hr);
            hr = IDirect3DTexture8_GetSurfaceLevel(texture, 0, &surface);
            ok(SUCCEEDED(hr), "Failed to get surface level, hr %#lx.\n", hr);
            IDirect3DTexture8_Release(texture);

            if (formats[i].block_width > 1)
            {
                SetRect(&rect, formats[i].block_width >> 1, 0, formats[i].block_width, formats[i].block_height);
                hr = IDirect3DSurface8_LockRect(surface, &locked_rect, &rect, 0);
                ok(FAILED(hr) == !pools[j].success || broken(formats[i].broken),
                        "Partial block lock %s, expected %s, format %s, pool %s.\n",
                        SUCCEEDED(hr) ? "succeeded" : "failed",
                        pools[j].success ? "success" : "failure", formats[i].name, pools[j].name);
                if (SUCCEEDED(hr))
                {
                    hr = IDirect3DSurface8_UnlockRect(surface);
                    ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);
                }

                SetRect(&rect, 0, 0, formats[i].block_width >> 1, formats[i].block_height);
                hr = IDirect3DSurface8_LockRect(surface, &locked_rect, &rect, 0);
                ok(FAILED(hr) == !pools[j].success || broken(formats[i].broken),
                        "Partial block lock %s, expected %s, format %s, pool %s.\n",
                        SUCCEEDED(hr) ? "succeeded" : "failed",
                        pools[j].success ? "success" : "failure", formats[i].name, pools[j].name);
                if (SUCCEEDED(hr))
                {
                    hr = IDirect3DSurface8_UnlockRect(surface);
                    ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);
                }
            }

            if (formats[i].block_height > 1)
            {
                SetRect(&rect, 0, formats[i].block_height >> 1, formats[i].block_width, formats[i].block_height);
                hr = IDirect3DSurface8_LockRect(surface, &locked_rect, &rect, 0);
                ok(FAILED(hr) == !pools[j].success || broken(formats[i].broken),
                        "Partial block lock %s, expected %s, format %s, pool %s.\n",
                        SUCCEEDED(hr) ? "succeeded" : "failed",
                        pools[j].success ? "success" : "failure", formats[i].name, pools[j].name);
                if (SUCCEEDED(hr))
                {
                    hr = IDirect3DSurface8_UnlockRect(surface);
                    ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);
                }

                SetRect(&rect, 0, 0, formats[i].block_width, formats[i].block_height >> 1);
                hr = IDirect3DSurface8_LockRect(surface, &locked_rect, &rect, 0);
                ok(FAILED(hr) == !pools[j].success || broken(formats[i].broken),
                        "Partial block lock %s, expected %s, format %s, pool %s.\n",
                        SUCCEEDED(hr) ? "succeeded" : "failed",
                        pools[j].success ? "success" : "failure", formats[i].name, pools[j].name);
                if (SUCCEEDED(hr))
                {
                    hr = IDirect3DSurface8_UnlockRect(surface);
                    ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);
                }
            }

            for (k = 0; k < ARRAY_SIZE(invalid); ++k)
            {
                hr = IDirect3DSurface8_LockRect(surface, &locked_rect, &invalid[k], 0);
                ok(FAILED(hr) == !pools[j].success, "Got hr %#lx, format %s, pool %s, case %u.\n",
                        hr, formats[i].name, pools[j].name, k);
                if (SUCCEEDED(hr))
                {
                    hr = IDirect3DSurface8_UnlockRect(surface);
                    ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);
                }
            }

            SetRect(&rect, 0, 0, formats[i].block_width, formats[i].block_height);
            hr = IDirect3DSurface8_LockRect(surface, &locked_rect, &rect, 0);
            ok(hr == D3D_OK, "Got unexpected hr %#lx for format %s, pool %s.\n", hr, formats[i].name, pools[j].name);
            hr = IDirect3DSurface8_UnlockRect(surface);
            ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);

            IDirect3DSurface8_Release(surface);
        }

        if (formats[i].block_width == 1 && formats[i].block_height == 1)
            continue;
        if (!formats[i].core_fmt)
            continue;

        hr = IDirect3DDevice8_CreateTexture(device, formats[i].block_width, formats[i].block_height, 2,
                D3DUSAGE_DYNAMIC, formats[i].fmt, D3DPOOL_DEFAULT, &texture);
        ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx, format %s.\n", hr, formats[i].name);

        hr = IDirect3DTexture8_LockRect(texture, 1, &locked_rect, NULL, 0);
        ok(SUCCEEDED(hr), "Failed lock texture, hr %#lx.\n", hr);
        hr = IDirect3DTexture8_UnlockRect(texture, 1);
        ok(SUCCEEDED(hr), "Failed lock texture, hr %#lx.\n", hr);

        rect.left = 0;
        rect.top = 0;
        rect.right = formats[i].block_width == 1 ? 1 : formats[i].block_width >> 1;
        rect.bottom = formats[i].block_height == 1 ? 1 : formats[i].block_height >> 1;
        hr = IDirect3DTexture8_LockRect(texture, 1, &locked_rect, &rect, 0);
        ok(SUCCEEDED(hr), "Failed lock texture, hr %#lx.\n", hr);
        hr = IDirect3DTexture8_UnlockRect(texture, 1);
        ok(SUCCEEDED(hr), "Failed lock texture, hr %#lx.\n", hr);

        rect.right = formats[i].block_width;
        rect.bottom = formats[i].block_height;
        hr = IDirect3DTexture8_LockRect(texture, 1, &locked_rect, &rect, 0);
        ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);
        if (SUCCEEDED(hr))
            IDirect3DTexture8_UnlockRect(texture, 1);

        IDirect3DTexture8_Release(texture);
    }

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_set_palette(void)
{
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d8;
    UINT refcount;
    HWND window;
    HRESULT hr;
    PALETTEENTRY pal[256];
    unsigned int i;
    D3DCAPS8 caps;

    window = create_window();
    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d8, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d8);
        DestroyWindow(window);
        return;
    }

    for (i = 0; i < ARRAY_SIZE(pal); i++)
    {
        pal[i].peRed = i;
        pal[i].peGreen = i;
        pal[i].peBlue = i;
        pal[i].peFlags = 0xff;
    }
    hr = IDirect3DDevice8_SetPaletteEntries(device, 0, pal);
    ok(SUCCEEDED(hr), "Failed to set palette entries, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get device caps, hr %#lx.\n", hr);
    for (i = 0; i < ARRAY_SIZE(pal); i++)
    {
        pal[i].peRed = i;
        pal[i].peGreen = i;
        pal[i].peBlue = i;
        pal[i].peFlags = i;
    }
    if (caps.TextureCaps & D3DPTEXTURECAPS_ALPHAPALETTE)
    {
        hr = IDirect3DDevice8_SetPaletteEntries(device, 0, pal);
        ok(SUCCEEDED(hr), "Failed to set palette entries, hr %#lx.\n", hr);
    }
    else
    {
        hr = IDirect3DDevice8_SetPaletteEntries(device, 0, pal);
        ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);
    }

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %u references left.\n", refcount);
    IDirect3D8_Release(d3d8);
    DestroyWindow(window);
}

static void test_pinned_buffers(void)
{
    static const struct
    {
        DWORD device_flags;
        DWORD usage;
        D3DPOOL pool;
    }
    tests[] =
    {
        {CREATE_DEVICE_SWVP_ONLY, D3DUSAGE_DYNAMIC | D3DUSAGE_WRITEONLY, D3DPOOL_DEFAULT},
        {0, 0, D3DPOOL_MANAGED},
        {0, 0, D3DPOOL_SYSTEMMEM},
    };
    static const unsigned int vertex_count = 1024;
    struct device_desc device_desc;
    IDirect3DVertexBuffer8 *buffer;
    D3DVERTEXBUFFER_DESC desc;
    IDirect3DDevice8 *device;
    struct vec3 *ptr, *ptr2;
    unsigned int i, test;
    IDirect3D8 *d3d;
    UINT refcount;
    HWND window;
    HRESULT hr;

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");

    for (test = 0; test < ARRAY_SIZE(tests); ++test)
    {
        device_desc.adapter_ordinal = D3DADAPTER_DEFAULT;
        device_desc.device_window = window;
        device_desc.width = 640;
        device_desc.height = 480;
        device_desc.flags = tests[test].device_flags;
        if (!(device = create_device(d3d, window, &device_desc)))
        {
            skip("Test %u: failed to create a D3D device.\n", test);
            continue;
        }

        hr = IDirect3DDevice8_CreateVertexBuffer(device, vertex_count * sizeof(*ptr),
                tests[test].usage, 0, tests[test].pool, &buffer);
        ok(hr == D3D_OK, "Test %u: got unexpected hr %#lx.\n", test, hr);
        hr = IDirect3DVertexBuffer8_GetDesc(buffer, &desc);
        ok(hr == D3D_OK, "Test %u: got unexpected hr %#lx.\n", test, hr);
        ok(desc.Pool == tests[test].pool, "Test %u: got unexpected pool %#x.\n", test, desc.Pool);
        ok(desc.Usage == tests[test].usage, "Test %u: got unexpected usage %#lx.\n", test, desc.Usage);

        hr = IDirect3DVertexBuffer8_Lock(buffer, 0, vertex_count * sizeof(*ptr), (BYTE **)&ptr, D3DLOCK_DISCARD);
        ok(hr == D3D_OK, "Test %u: got unexpected hr %#lx.\n", test, hr);
        for (i = 0; i < vertex_count; ++i)
        {
            ptr[i].x = i * 1.0f;
            ptr[i].y = i * 2.0f;
            ptr[i].z = i * 3.0f;
        }
        hr = IDirect3DVertexBuffer8_Unlock(buffer);
        ok(hr == D3D_OK, "Test %u: got unexpected hr %#lx.\n", test, hr);

        hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ);
        ok(hr == D3D_OK, "Test %u: got unexpected hr %#lx.\n", test, hr);
        hr = IDirect3DDevice8_SetStreamSource(device, 0, buffer, sizeof(*ptr));
        ok(hr == D3D_OK, "Test %u: got unexpected hr %#lx.\n", test, hr);
        hr = IDirect3DDevice8_BeginScene(device);
        ok(hr == D3D_OK, "Test %u: got unexpected hr %#lx.\n", test, hr);
        hr = IDirect3DDevice8_DrawPrimitive(device, D3DPT_TRIANGLELIST, 0, 2);
        ok(hr == D3D_OK, "Test %u: got unexpected hr %#lx.\n", test, hr);
        hr = IDirect3DDevice8_EndScene(device);
        ok(hr == D3D_OK, "Test %u: got unexpected hr %#lx.\n", test, hr);

        hr = IDirect3DVertexBuffer8_Lock(buffer, 0, vertex_count * sizeof(*ptr2), (BYTE **)&ptr2, D3DLOCK_DISCARD);
        ok(hr == D3D_OK, "Test %u: got unexpected hr %#lx.\n", test, hr);
        ok(ptr2 == ptr, "Test %u: got unexpected ptr2 %p, expected %p.\n", test, ptr2, ptr);
        for (i = 0; i < vertex_count; ++i)
        {
            if (ptr2[i].x != i * 1.0f || ptr2[i].y != i * 2.0f || ptr2[i].z != i * 3.0f)
            {
                ok(FALSE, "Test %u: got unexpected vertex %u {%.8e, %.8e, %.8e}, expected {%.8e, %.8e, %.8e}.\n",
                        test, i, ptr2[i].x, ptr2[i].y, ptr2[i].z, i * 1.0f, i * 2.0f, i * 3.0f);
                break;
            }
        }
        hr = IDirect3DVertexBuffer8_Unlock(buffer);
        ok(hr == D3D_OK, "Test %u: got unexpected hr %#lx.\n", test, hr);

        IDirect3DVertexBuffer8_Release(buffer);
        refcount = IDirect3DDevice8_Release(device);
        ok(!refcount, "Test %u: device has %u references left.\n", test, refcount);
    }
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_npot_textures(void)
{
    IDirect3DDevice8 *device = NULL;
    IDirect3D8 *d3d8;
    ULONG refcount;
    HWND window = NULL;
    HRESULT hr;
    D3DCAPS8 caps;
    IDirect3DTexture8 *texture;
    IDirect3DCubeTexture8 *cube_texture;
    IDirect3DVolumeTexture8 *volume_texture;
    struct
    {
        D3DPOOL pool;
        const char *pool_name;
        HRESULT hr;
    }
    pools[] =
    {
        { D3DPOOL_DEFAULT,    "D3DPOOL_DEFAULT",    D3DERR_INVALIDCALL },
        { D3DPOOL_MANAGED,    "D3DPOOL_MANAGED",    D3DERR_INVALIDCALL },
        { D3DPOOL_SYSTEMMEM,  "D3DPOOL_SYSTEMMEM",  D3DERR_INVALIDCALL },
        { D3DPOOL_SCRATCH,    "D3DPOOL_SCRATCH",    D3D_OK             },
    };
    unsigned int i, levels;
    BOOL tex_pow2, cube_pow2, vol_pow2;

    window = create_window();
    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d8, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get caps, hr %#lx.\n", hr);
    tex_pow2 = !!(caps.TextureCaps & D3DPTEXTURECAPS_POW2);
    cube_pow2 = !!(caps.TextureCaps & D3DPTEXTURECAPS_CUBEMAP_POW2);
    vol_pow2 = !!(caps.TextureCaps & D3DPTEXTURECAPS_VOLUMEMAP_POW2);
    ok(cube_pow2 == tex_pow2, "Cube texture and 2d texture pow2 restrictions mismatch.\n");
    ok(vol_pow2 == tex_pow2, "Volume texture and 2d texture pow2 restrictions mismatch.\n");

    for (i = 0; i < ARRAY_SIZE(pools); i++)
    {
        for (levels = 0; levels <= 2; levels++)
        {
            HRESULT expected;

            hr = IDirect3DDevice8_CreateTexture(device, 10, 10, levels, 0, D3DFMT_X8R8G8B8,
                    pools[i].pool, &texture);
            if (!tex_pow2)
            {
                expected = D3D_OK;
            }
            else if (caps.TextureCaps & D3DPTEXTURECAPS_NONPOW2CONDITIONAL)
            {
                if (levels == 1)
                    expected = D3D_OK;
                else
                    expected = pools[i].hr;
            }
            else
            {
                expected = pools[i].hr;
            }
            ok(hr == expected, "CreateTexture(w=h=10, %s, levels=%u) returned hr %#lx, expected %#lx.\n",
                    pools[i].pool_name, levels, hr, expected);

            if (SUCCEEDED(hr))
                IDirect3DTexture8_Release(texture);
        }

        hr = IDirect3DDevice8_CreateCubeTexture(device, 3, 1, 0, D3DFMT_X8R8G8B8,
                pools[i].pool, &cube_texture);
        if (tex_pow2)
        {
            ok(hr == pools[i].hr, "CreateCubeTexture(EdgeLength=3, %s) returned hr %#lx.\n", pools[i].pool_name, hr);
        }
        else
        {
            ok(SUCCEEDED(hr), "CreateCubeTexture(EdgeLength=3, %s) returned hr %#lx.\n", pools[i].pool_name, hr);
        }

        if (SUCCEEDED(hr))
            IDirect3DCubeTexture8_Release(cube_texture);

        hr = IDirect3DDevice8_CreateVolumeTexture(device, 2, 2, 3, 1, 0, D3DFMT_X8R8G8B8,
                pools[i].pool, &volume_texture);
        if (tex_pow2)
        {
            ok(hr == pools[i].hr, "CreateVolumeTextur(Depth=3, %s) returned hr %#lx.\n", pools[i].pool_name, hr);
        }
        else
        {
            ok(SUCCEEDED(hr), "CreateVolumeTextur(Depth=3, %s) returned hr %#lx.\n", pools[i].pool_name, hr);
        }

        if (SUCCEEDED(hr))
            IDirect3DVolumeTexture8_Release(volume_texture);
    }

done:
    if (device)
    {
        refcount = IDirect3DDevice8_Release(device);
        ok(!refcount, "Device has %lu references left.\n", refcount);
    }
    IDirect3D8_Release(d3d8);
    DestroyWindow(window);

}

static void test_volume_locking(void)
{
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d8;
    HWND window;
    HRESULT hr;
    IDirect3DVolumeTexture8 *texture;
    unsigned int i;
    D3DLOCKED_BOX locked_box;
    ULONG refcount;
    D3DCAPS8 caps;
    static const struct
    {
        D3DPOOL pool;
        DWORD usage;
        HRESULT create_hr, lock_hr;
    }
    tests[] =
    {
        { D3DPOOL_DEFAULT,      0,                  D3D_OK,             D3DERR_INVALIDCALL  },
        { D3DPOOL_DEFAULT,      D3DUSAGE_DYNAMIC,   D3D_OK,             D3D_OK              },
        { D3DPOOL_SYSTEMMEM,    0,                  D3D_OK,             D3D_OK              },
        { D3DPOOL_SYSTEMMEM,    D3DUSAGE_DYNAMIC,   D3D_OK,             D3D_OK              },
        { D3DPOOL_MANAGED,      0,                  D3D_OK,             D3D_OK              },
        { D3DPOOL_MANAGED,      D3DUSAGE_DYNAMIC,   D3DERR_INVALIDCALL, D3D_OK              },
        { D3DPOOL_SCRATCH,      0,                  D3D_OK,             D3D_OK              },
        { D3DPOOL_SCRATCH,      D3DUSAGE_DYNAMIC,   D3DERR_INVALIDCALL, D3D_OK              },
    };

    window = create_window();
    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d8, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d8);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get caps, hr %#lx.\n", hr);
    if (!(caps.TextureCaps & D3DPTEXTURECAPS_VOLUMEMAP))
    {
        skip("Volume textures not supported, skipping test.\n");
        goto out;
    }

    for (i = 0; i < ARRAY_SIZE(tests); i++)
    {
        hr = IDirect3DDevice8_CreateVolumeTexture(device, 4, 4, 4, 1, tests[i].usage,
                D3DFMT_A8R8G8B8, tests[i].pool, &texture);
        ok(hr == tests[i].create_hr, "Creating volume texture pool=%u, usage=%#lx returned %#lx, expected %#lx.\n",
                tests[i].pool, tests[i].usage, hr, tests[i].create_hr);
        if (FAILED(hr))
            continue;

        locked_box.pBits = (void *)0xdeadbeef;
        hr = IDirect3DVolumeTexture8_LockBox(texture, 0, &locked_box, NULL, 0);
        ok(hr == tests[i].lock_hr, "Lock returned %#lx, expected %#lx.\n", hr, tests[i].lock_hr);
        if (SUCCEEDED(hr))
        {
            hr = IDirect3DVolumeTexture8_UnlockBox(texture, 0);
            ok(SUCCEEDED(hr), "Failed to unlock volume texture, hr %#lx.\n", hr);
        }
        else
        {
            ok (locked_box.pBits == NULL, "Failed lock set pBits = %p, expected NULL.\n", locked_box.pBits);
        }
        IDirect3DVolumeTexture8_Release(texture);
    }

out:
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d8);
    DestroyWindow(window);
}

static void test_update_texture_pool(void)
{
    static const struct
    {
        D3DPOOL pool;
        DWORD usage;
    }
    tests[] =
    {
        {D3DPOOL_DEFAULT, D3DUSAGE_DYNAMIC},
        {D3DPOOL_MANAGED, 0},
        {D3DPOOL_SYSTEMMEM, 0},
        {D3DPOOL_SCRATCH, 0},
    };

    unsigned int expect_colour, colour, i, j;
    IDirect3DVolumeTexture8 *src_3d, *dst_3d;
    IDirect3DTexture8 *src_2d, *dst_2d;
    D3DLOCKED_RECT locked_rect;
    IDirect3DDevice8 *device;
    D3DLOCKED_BOX locked_box;
    IDirect3D8 *d3d8;
    ULONG refcount;
    D3DCAPS8 caps;
    HWND window;
    HRESULT hr;

    window = create_window();
    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d8, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d8);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(hr == S_OK, "Failed to get caps, hr %#lx.\n", hr);

    for (i = 0; i < ARRAY_SIZE(tests); ++i)
    {
        for (j = 0; j < ARRAY_SIZE(tests); ++j)
        {
            winetest_push_context("Source test %u, destination test %u", i, j);

            hr = IDirect3DDevice8_CreateTexture(device, 1, 1, 1,
                    tests[i].usage, D3DFMT_A8R8G8B8, tests[i].pool, &src_2d);
            ok(hr == S_OK, "Got hr %#lx.\n", hr);
            hr = IDirect3DDevice8_CreateTexture(device, 1, 1, 1,
                    tests[j].usage, D3DFMT_A8R8G8B8, tests[j].pool, &dst_2d);
            ok(hr == S_OK, "Got hr %#lx.\n", hr);

            hr = IDirect3DTexture8_LockRect(src_2d, 0, &locked_rect, NULL, 0);
            ok(hr == S_OK, "Got hr %#lx.\n", hr);
            *((DWORD *)locked_rect.pBits) = 0x11223344;
            hr = IDirect3DTexture8_UnlockRect(src_2d, 0);
            ok(hr == S_OK, "Got hr %#lx.\n", hr);

            hr = IDirect3DTexture8_LockRect(dst_2d, 0, &locked_rect, NULL, 0);
            ok(hr == S_OK, "Got hr %#lx.\n", hr);
            *((DWORD *)locked_rect.pBits) = 0x44332211;
            hr = IDirect3DTexture8_UnlockRect(dst_2d, 0);
            ok(hr == S_OK, "Got hr %#lx.\n", hr);

            hr = IDirect3DDevice8_UpdateTexture(device, (IDirect3DBaseTexture8 *)src_2d,
                    (IDirect3DBaseTexture8 *)dst_2d);
            if (tests[i].pool == D3DPOOL_SYSTEMMEM && tests[j].pool == D3DPOOL_DEFAULT)
            {
                expect_colour = 0x11223344;
                ok(hr == S_OK, "Got hr %#lx.\n", hr);
            }
            else
            {
                expect_colour = 0x44332211;
                ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);
            }

            hr = IDirect3DTexture8_LockRect(dst_2d, 0, &locked_rect, NULL, 0);
            ok(hr == S_OK, "Got hr %#lx.\n", hr);
            colour = *((DWORD *)locked_rect.pBits);
            ok(colour == expect_colour, "Expected colour %08x, got %08x.\n", expect_colour, colour);
            hr = IDirect3DTexture8_UnlockRect(dst_2d, 0);
            ok(hr == S_OK, "Got hr %#lx.\n", hr);

            IDirect3DTexture8_Release(src_2d);
            IDirect3DTexture8_Release(dst_2d);

            if (!(caps.TextureCaps & D3DPTEXTURECAPS_VOLUMEMAP))
                continue;

            hr = IDirect3DDevice8_CreateVolumeTexture(device, 1, 1, 1, 1,
                    tests[i].usage, D3DFMT_A8R8G8B8, tests[i].pool, &src_3d);
            ok(hr == S_OK, "Got hr %#lx.\n", hr);
            hr = IDirect3DDevice8_CreateVolumeTexture(device, 1, 1, 1, 1,
                    tests[j].usage, D3DFMT_A8R8G8B8, tests[j].pool, &dst_3d);
            ok(hr == S_OK, "Got hr %#lx.\n", hr);

            hr = IDirect3DVolumeTexture8_LockBox(src_3d, 0, &locked_box, NULL, 0);
            ok(hr == S_OK, "Got hr %#lx.\n", hr);
            *((DWORD *)locked_box.pBits) = 0x11223344;
            hr = IDirect3DVolumeTexture8_UnlockBox(src_3d, 0);
            ok(hr == S_OK, "Got hr %#lx.\n", hr);

            hr = IDirect3DVolumeTexture8_LockBox(dst_3d, 0, &locked_box, NULL, 0);
            ok(hr == S_OK, "Got hr %#lx.\n", hr);
            *((DWORD *)locked_box.pBits) = 0x44332211;
            hr = IDirect3DVolumeTexture8_UnlockBox(dst_3d, 0);
            ok(hr == S_OK, "Got hr %#lx.\n", hr);

            hr = IDirect3DDevice8_UpdateTexture(device, (IDirect3DBaseTexture8 *)src_3d,
                    (IDirect3DBaseTexture8 *)dst_3d);
            if (tests[i].pool == D3DPOOL_SYSTEMMEM && tests[j].pool == D3DPOOL_DEFAULT)
            {
                expect_colour = 0x11223344;
                ok(hr == S_OK, "Got hr %#lx.\n", hr);
            }
            else
            {
                expect_colour = 0x44332211;
                ok(hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);
            }

            hr = IDirect3DVolumeTexture8_LockBox(dst_3d, 0, &locked_box, NULL, 0);
            ok(hr == S_OK, "Got hr %#lx.\n", hr);
            colour = *((DWORD *)locked_box.pBits);
            ok(colour == expect_colour, "Expected colour %08x, got %08x.\n", expect_colour, colour);
            hr = IDirect3DVolumeTexture8_UnlockBox(dst_3d, 0);
            ok(hr == S_OK, "Got hr %#lx.\n", hr);

            IDirect3DVolumeTexture8_Release(src_3d);
            IDirect3DVolumeTexture8_Release(dst_3d);

            winetest_pop_context();
        }
    }

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d8);
    DestroyWindow(window);
}

static void test_update_volumetexture(void)
{
    D3DADAPTER_IDENTIFIER8 identifier;
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d8;
    HWND window;
    HRESULT hr;
    IDirect3DVolumeTexture8 *src, *dst;
    unsigned int i;
    ULONG refcount;
    D3DCAPS8 caps;
    BOOL is_warp;

    static const struct
    {
        UINT src_size, dst_size;
        UINT src_lvl, dst_lvl;
        D3DFORMAT src_fmt, dst_fmt;
    }
    tests[] =
    {
        { 8, 8, 0, 0, D3DFMT_A8R8G8B8, D3DFMT_A8R8G8B8 },
        { 8, 8, 4, 4, D3DFMT_A8R8G8B8, D3DFMT_A8R8G8B8 },
        { 8, 8, 2, 2, D3DFMT_A8R8G8B8, D3DFMT_A8R8G8B8 },
        { 8, 8, 1, 1, D3DFMT_A8R8G8B8, D3DFMT_A8R8G8B8 },
        { 8, 8, 4, 0, D3DFMT_A8R8G8B8, D3DFMT_A8R8G8B8 },
        { 8, 8, 1, 4, D3DFMT_A8R8G8B8, D3DFMT_A8R8G8B8 }, /* Different level count */
        { 4, 8, 1, 1, D3DFMT_A8R8G8B8, D3DFMT_A8R8G8B8 }, /* Different size        */
        { 8, 8, 4, 4, D3DFMT_A8R8G8B8, D3DFMT_X8R8G8B8 }, /* Different format      */
    };

    window = create_window();
    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");
    hr = IDirect3D8_GetAdapterIdentifier(d3d8, D3DADAPTER_DEFAULT, 0, &identifier);
    ok(SUCCEEDED(hr), "Failed to get adapter identifier, hr %#lx.\n", hr);
    is_warp = adapter_is_warp(&identifier);
    if (!(device = create_device(d3d8, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d8);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get caps, hr %#lx.\n", hr);
    if (!(caps.TextureCaps & D3DPTEXTURECAPS_VOLUMEMAP) || !(caps.TextureCaps & D3DPTEXTURECAPS_MIPVOLUMEMAP))
    {
        skip("Mipmapped volume maps not supported.\n");
        goto out;
    }

    for (i = 0; i < ARRAY_SIZE(tests); ++i)
    {
        hr = IDirect3DDevice8_CreateVolumeTexture(device,
                tests[i].src_size, tests[i].src_size, tests[i].src_size,
                tests[i].src_lvl, 0, tests[i].src_fmt, D3DPOOL_SYSTEMMEM, &src);
        ok(SUCCEEDED(hr), "Failed to create volume texture, hr %#lx, case %u.\n", hr, i);
        hr = IDirect3DDevice8_CreateVolumeTexture(device,
                tests[i].dst_size, tests[i].dst_size, tests[i].dst_size,
                tests[i].dst_lvl, 0, tests[i].dst_fmt, D3DPOOL_DEFAULT, &dst);
        ok(SUCCEEDED(hr), "Failed to create volume texture, hr %#lx, case %u.\n", hr, i);

        hr = IDirect3DDevice8_UpdateTexture(device, (IDirect3DBaseTexture8 *)src, (IDirect3DBaseTexture8 *)dst);
        todo_wine_if (FAILED(hr))
            ok(SUCCEEDED(hr) || (is_warp && (i == 6 || i == 7)), /* Fails with Win10 WARP driver */
                    "Failed to update texture, hr %#lx, case %u.\n", hr, i);

        IDirect3DVolumeTexture8_Release(src);
        IDirect3DVolumeTexture8_Release(dst);
    }

    /* As far as I can see, UpdateTexture on non-matching texture behaves like a memcpy. The raw data
     * stays the same in a format change, a 2x2x1 texture is copied into the first row of a 4x4x1 texture,
     * etc. I could not get it to segfault, but the nonexistent 5th pixel of a 2x2x1 texture is copied into
     * pixel 1x2x1 of a 4x4x1 texture, demonstrating a read beyond the texture's end. I suspect any bad
     * memory access is silently ignored by the runtime, in the kernel or on the GPU.
     *
     * I'm not adding tests for this behavior until an application needs it. */

out:
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d8);
    DestroyWindow(window);
}

static void test_create_rt_ds_fail(void)
{
    IDirect3DDevice8 *device;
    HWND window;
    HRESULT hr;
    ULONG refcount;
    IDirect3D8 *d3d8;
    IDirect3DSurface8 *surface;

    window = create_window();
    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d8, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d8);
        DestroyWindow(window);
        return;
    }

    /* Output pointer == NULL segfaults on Windows. */

    surface = (IDirect3DSurface8 *)0xdeadbeef;
    hr = IDirect3DDevice8_CreateRenderTarget(device, 4, 4, D3DFMT_D16,
            D3DMULTISAMPLE_NONE, FALSE, &surface);
    ok(hr == D3DERR_INVALIDCALL, "Creating a D16 render target returned hr %#lx.\n", hr);
    ok(surface == NULL, "Got pointer %p, expected NULL.\n", surface);
    if (SUCCEEDED(hr))
        IDirect3DSurface8_Release(surface);

    surface = (IDirect3DSurface8 *)0xdeadbeef;
    hr = IDirect3DDevice8_CreateDepthStencilSurface(device, 4, 4, D3DFMT_A8R8G8B8,
            D3DMULTISAMPLE_NONE, &surface);
    ok(hr == D3DERR_INVALIDCALL, "Creating a A8R8G8B8 depth stencil returned hr %#lx.\n", hr);
    ok(surface == NULL, "Got pointer %p, expected NULL.\n", surface);
    if (SUCCEEDED(hr))
        IDirect3DSurface8_Release(surface);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d8);
    DestroyWindow(window);
}

static void test_volume_blocks(void)
{
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d8;
    UINT refcount;
    HWND window;
    HRESULT hr;
    D3DCAPS8 caps;
    IDirect3DVolumeTexture8 *texture;
    unsigned int w, h, d, i, j;
    static const struct
    {
        D3DFORMAT fmt;
        const char *name;
        unsigned int block_width;
        unsigned int block_height;
        unsigned int block_depth;
        unsigned int block_size;
        unsigned int broken;
        BOOL create_size_checked, core_fmt;
    }
    formats[] =
    {
        /* Scratch volumes enforce DXTn block locks, unlike their surface counterparts.
         * ATI2N and YUV blocks are not enforced on any tested card (r200, gtx 460). */
        {D3DFMT_DXT1,                 "D3DFMT_DXT1", 4, 4, 1, 8,  0, TRUE,  TRUE },
        {D3DFMT_DXT2,                 "D3DFMT_DXT2", 4, 4, 1, 16, 0, TRUE,  TRUE },
        {D3DFMT_DXT3,                 "D3DFMT_DXT3", 4, 4, 1, 16, 0, TRUE,  TRUE },
        {D3DFMT_DXT4,                 "D3DFMT_DXT4", 4, 4, 1, 16, 0, TRUE,  TRUE },
        {D3DFMT_DXT5,                 "D3DFMT_DXT5", 4, 4, 1, 16, 0, TRUE,  TRUE },
        {D3DFMT_DXT5,                 "D3DFMT_DXT5", 4, 4, 1, 16, 0, TRUE,  TRUE },
        /* ATI2N has 2x2 blocks on all AMD cards and Geforce 7 cards,
         * which doesn't match the format spec. On newer Nvidia cards
         * it has the correct 4x4 block size.
         * ATI1N volume textures are only supported by AMD GPUs right
         * now and locking offsets seem just wrong. */
        {MAKEFOURCC('A','T','I','1'), "ATI1N",       4, 4, 1, 8,  2, FALSE, FALSE},
        {MAKEFOURCC('A','T','I','2'), "ATI2N",       4, 4, 1, 16, 1, FALSE, FALSE},
        {D3DFMT_YUY2,                 "D3DFMT_YUY2", 2, 1, 1, 4,  1, FALSE, TRUE },
        {D3DFMT_UYVY,                 "D3DFMT_UYVY", 2, 1, 1, 4,  1, FALSE, TRUE },
    };
    static const struct
    {
        D3DPOOL pool;
        const char *name;
        BOOL need_driver_support, need_runtime_support;
    }
    create_tests[] =
    {
        {D3DPOOL_DEFAULT,       "D3DPOOL_DEFAULT",  TRUE,  FALSE},
        {D3DPOOL_SCRATCH,       "D3DPOOL_SCRATCH",  FALSE, TRUE },
        {D3DPOOL_SYSTEMMEM,     "D3DPOOL_SYSTEMMEM",TRUE,  FALSE},
        {D3DPOOL_MANAGED,       "D3DPOOL_MANAGED",  TRUE,  FALSE},
    };
    static const struct
    {
        unsigned int x, y, z, x2, y2, z2;
    }
    offset_tests[] =
    {
        {0, 0, 0, 8, 8, 8},
        {0, 0, 3, 8, 8, 8},
        {0, 4, 0, 8, 8, 8},
        {0, 4, 3, 8, 8, 8},
        {4, 0, 0, 8, 8, 8},
        {4, 0, 3, 8, 8, 8},
        {4, 4, 0, 8, 8, 8},
        {4, 4, 3, 8, 8, 8},
    };
    D3DBOX box;
    D3DLOCKED_BOX locked_box;
    BYTE *base;
    INT expected_row_pitch, expected_slice_pitch;
    BOOL support;
    BOOL pow2;
    unsigned int offset, expected_offset;

    window = create_window();
    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d8, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d8);
        DestroyWindow(window);
        return;
    }
    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get caps, hr %#lx.\n", hr);
    pow2 = !!(caps.TextureCaps & D3DPTEXTURECAPS_VOLUMEMAP_POW2);

    for (i = 0; i < ARRAY_SIZE(formats); i++)
    {
        hr = IDirect3D8_CheckDeviceFormat(d3d8, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8,
                0, D3DRTYPE_VOLUMETEXTURE, formats[i].fmt);
        support = SUCCEEDED(hr);

        /* Test creation restrictions */
        for (w = 1; w <= 8; w++)
        {
            for (h = 1; h <= 8; h++)
            {
                for (d = 1; d <= 8; d++)
                {
                    HRESULT expect_hr;
                    BOOL size_is_pow2;
                    BOOL block_aligned = TRUE;

                    if (w & (formats[i].block_width - 1) || h & (formats[i].block_height - 1))
                        block_aligned = FALSE;

                    size_is_pow2 = !((w & (w - 1)) || (h & (h - 1)) || (d & (d - 1)));

                    for (j = 0; j < ARRAY_SIZE(create_tests); j++)
                    {
                        BOOL may_succeed = FALSE;

                        if (create_tests[j].need_runtime_support && !formats[i].core_fmt && !support)
                            expect_hr = D3DERR_INVALIDCALL;
                        else if (formats[i].create_size_checked && !block_aligned)
                            expect_hr = D3DERR_INVALIDCALL;
                        else if (pow2 && !size_is_pow2 && create_tests[j].need_driver_support)
                            expect_hr = D3DERR_INVALIDCALL;
                        else if (create_tests[j].need_driver_support && !support)
                            expect_hr = D3DERR_INVALIDCALL;
                        else
                            expect_hr = D3D_OK;

                        texture = (IDirect3DVolumeTexture8 *)0xdeadbeef;
                        hr = IDirect3DDevice8_CreateVolumeTexture(device, w, h, d, 1, 0,
                                formats[i].fmt, create_tests[j].pool, &texture);

                        /* Wine knows about ATI2N and happily creates a scratch resource even if GL
                         * does not support it. Accept scratch creation of extension formats on
                         * Windows as well if it occurs. We don't really care if e.g. a Windows 7
                         * on an r200 GPU creates scratch ATI2N texture even though the card doesn't
                         * support it. */
                        if (!formats[i].core_fmt && !support && FAILED(expect_hr))
                            may_succeed = TRUE;

                        ok(hr == expect_hr || ((SUCCEEDED(hr) && may_succeed)),
                                "Got unexpected hr %#lx for format %s, pool %s, size %ux%ux%u.\n",
                                hr, formats[i].name, create_tests[j].name, w, h, d);

                        if (FAILED(hr))
                            ok(texture == NULL, "Got texture ptr %p, expected NULL.\n", texture);
                        else
                            IDirect3DVolumeTexture8_Release(texture);
                    }
                }
            }
        }

        if (!support && !formats[i].core_fmt)
            continue;

        hr = IDirect3DDevice8_CreateVolumeTexture(device, 24, 8, 8, 1, 0,
                formats[i].fmt, D3DPOOL_SCRATCH, &texture);
        ok(SUCCEEDED(hr), "Failed to create volume texture, hr %#lx.\n", hr);

        /* Test lockrect offset */
        for (j = 0; j < ARRAY_SIZE(offset_tests); j++)
        {
            unsigned int bytes_per_pixel;
            bytes_per_pixel = formats[i].block_size / (formats[i].block_width * formats[i].block_height);

            hr = IDirect3DVolumeTexture8_LockBox(texture, 0, &locked_box, NULL, 0);
            ok(SUCCEEDED(hr), "Failed to unlock volume texture, hr %#lx.\n", hr);

            base = locked_box.pBits;
            if (formats[i].broken == 1)
            {
                expected_row_pitch = bytes_per_pixel * 24;
            }
            else if (formats[i].broken == 2)
            {
                expected_row_pitch = 24;
            }
            else
            {
                expected_row_pitch = (24 /* tex width */ + formats[i].block_height - 1) / formats[i].block_width
                        * formats[i].block_size;
            }
            ok(locked_box.RowPitch == expected_row_pitch, "Got unexpected row pitch %d for format %s, expected %d.\n",
                    locked_box.RowPitch, formats[i].name, expected_row_pitch);

            if (formats[i].broken)
            {
                expected_slice_pitch = expected_row_pitch * 8;
            }
            else
            {
                expected_slice_pitch = (8 /* tex height */ + formats[i].block_depth - 1) / formats[i].block_height
                        * expected_row_pitch;
            }
            ok(locked_box.SlicePitch == expected_slice_pitch,
                    "Got unexpected slice pitch %d for format %s, expected %d.\n",
                    locked_box.SlicePitch, formats[i].name, expected_slice_pitch);

            hr = IDirect3DVolumeTexture8_UnlockBox(texture, 0);
            ok(SUCCEEDED(hr), "Failed to unlock volume texture, hr %#lx, j %u.\n", hr, j);

            box.Left = offset_tests[j].x;
            box.Top = offset_tests[j].y;
            box.Front = offset_tests[j].z;
            box.Right = offset_tests[j].x2;
            box.Bottom = offset_tests[j].y2;
            box.Back = offset_tests[j].z2;
            hr = IDirect3DVolumeTexture8_LockBox(texture, 0, &locked_box, &box, 0);
            ok(SUCCEEDED(hr), "Failed to lock volume texture, hr %#lx, j %u.\n", hr, j);

            offset = (BYTE *)locked_box.pBits - base;
            if (formats[i].broken == 1)
            {
                expected_offset = box.Front * expected_slice_pitch
                        + box.Top * expected_row_pitch
                        + box.Left * bytes_per_pixel;
            }
            else if (formats[i].broken == 2)
            {
                expected_offset = box.Front * expected_slice_pitch
                        + box.Top * expected_row_pitch
                        + box.Left;
            }
            else
            {
                expected_offset = (box.Front / formats[i].block_depth) * expected_slice_pitch
                        + (box.Top / formats[i].block_height) * expected_row_pitch
                        + (box.Left / formats[i].block_width) * formats[i].block_size;
            }
            ok(offset == expected_offset, "Got unexpected offset %u for format %s, expected %u, box start %ux%ux%u.\n",
                    offset, formats[i].name, expected_offset, box.Left, box.Top, box.Front);

            hr = IDirect3DVolumeTexture8_UnlockBox(texture, 0);
            ok(SUCCEEDED(hr), "Failed to unlock volume texture, hr %#lx.\n", hr);
        }

        /* Test partial block locks */
        box.Front = 0;
        box.Back = 1;
        if (formats[i].block_width > 1)
        {
            box.Left = formats[i].block_width >> 1;
            box.Top = 0;
            box.Right = formats[i].block_width;
            box.Bottom = formats[i].block_height;
            hr = IDirect3DVolumeTexture8_LockBox(texture, 0, &locked_box, &box, 0);
            ok(FAILED(hr) || broken(formats[i].broken),
                    "Partial block lock succeeded, expected failure, format %s.\n",
                    formats[i].name);
            if (SUCCEEDED(hr))
            {
                hr = IDirect3DVolumeTexture8_UnlockBox(texture, 0);
                ok(SUCCEEDED(hr), "Failed to unlock volume texture, hr %#lx.\n", hr);
            }

            box.Left = 0;
            box.Top = 0;
            box.Right = formats[i].block_width >> 1;
            box.Bottom = formats[i].block_height;
            hr = IDirect3DVolumeTexture8_LockBox(texture, 0, &locked_box, &box, 0);
            ok(FAILED(hr) || broken(formats[i].broken),
                    "Partial block lock succeeded, expected failure, format %s.\n",
                    formats[i].name);
            if (SUCCEEDED(hr))
            {
                hr = IDirect3DVolumeTexture8_UnlockBox(texture, 0);
                ok(SUCCEEDED(hr), "Failed to unlock volume texture, hr %#lx.\n", hr);
            }
        }

        if (formats[i].block_height > 1)
        {
            box.Left = 0;
            box.Top = formats[i].block_height >> 1;
            box.Right = formats[i].block_width;
            box.Bottom = formats[i].block_height;
            hr = IDirect3DVolumeTexture8_LockBox(texture, 0, &locked_box, &box, 0);
            ok(FAILED(hr) || broken(formats[i].broken),
                    "Partial block lock succeeded, expected failure, format %s.\n",
                    formats[i].name);
            if (SUCCEEDED(hr))
            {
                hr = IDirect3DVolumeTexture8_UnlockBox(texture, 0);
                ok(SUCCEEDED(hr), "Failed to unlock volume texture, hr %#lx.\n", hr);
            }

            box.Left = 0;
            box.Top = 0;
            box.Right = formats[i].block_width;
            box.Bottom = formats[i].block_height >> 1;
            hr = IDirect3DVolumeTexture8_LockBox(texture, 0, &locked_box, &box, 0);
            ok(FAILED(hr) || broken(formats[i].broken),
                    "Partial block lock succeeded, expected failure, format %s.\n",
                    formats[i].name);
            if (SUCCEEDED(hr))
            {
                hr = IDirect3DVolumeTexture8_UnlockBox(texture, 0);
                ok(SUCCEEDED(hr), "Failed to unlock volume texture, hr %#lx.\n", hr);
            }
        }

        /* Test full block lock */
        box.Left = 0;
        box.Top = 0;
        box.Right = formats[i].block_width;
        box.Bottom = formats[i].block_height;
        hr = IDirect3DVolumeTexture8_LockBox(texture, 0, &locked_box, &box, 0);
        ok(SUCCEEDED(hr), "Failed to lock volume texture, hr %#lx.\n", hr);
        hr = IDirect3DVolumeTexture8_UnlockBox(texture, 0);
        ok(SUCCEEDED(hr), "Failed to unlock volume texture, hr %#lx.\n", hr);

        IDirect3DVolumeTexture8_Release(texture);

        /* Test mipmap locks. Don't do this with ATI2N, AMD warns that the runtime
         * does not allocate surfaces smaller than the blocksize properly. */
        if ((formats[i].block_width > 1 || formats[i].block_height > 1) && formats[i].core_fmt)
        {
            hr = IDirect3DDevice8_CreateVolumeTexture(device, formats[i].block_width, formats[i].block_height,
                    2, 2, 0, formats[i].fmt, D3DPOOL_SCRATCH, &texture);

            ok(SUCCEEDED(hr), "CreateVolumeTexture failed, hr %#lx.\n", hr);
            hr = IDirect3DVolumeTexture8_LockBox(texture, 1, &locked_box, NULL, 0);
            ok(SUCCEEDED(hr), "Failed to lock volume texture mipmap, hr %#lx.\n", hr);
            hr = IDirect3DVolumeTexture8_UnlockBox(texture, 1);
            ok(SUCCEEDED(hr), "Failed to unlock volume texture, hr %#lx.\n", hr);

            box.Left = box.Top = box.Front = 0;
            box.Right = formats[i].block_width == 1 ? 1 : formats[i].block_width >> 1;
            box.Bottom = formats[i].block_height == 1 ? 1 : formats[i].block_height >> 1;
            box.Back = 1;
            hr = IDirect3DVolumeTexture8_LockBox(texture, 1, &locked_box, &box, 0);
            ok(SUCCEEDED(hr), "Failed to lock volume texture mipmap, hr %#lx.\n", hr);
            hr = IDirect3DVolumeTexture8_UnlockBox(texture, 1);
            ok(SUCCEEDED(hr), "Failed to unlock volume texture, hr %#lx.\n", hr);

            box.Right = formats[i].block_width;
            box.Bottom = formats[i].block_height;
            hr = IDirect3DVolumeTexture8_LockBox(texture, 1, &locked_box, &box, 0);
            ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);
            if (SUCCEEDED(hr))
                IDirect3DVolumeTexture8_UnlockBox(texture, 1);

            IDirect3DVolumeTexture8_Release(texture);
        }
    }

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %u references left.\n", refcount);
    IDirect3D8_Release(d3d8);
    DestroyWindow(window);
}

static void test_lockbox_invalid(void)
{
    static const struct
    {
        D3DBOX box;
        HRESULT result;
    }
    test_data[] =
    {
        {{0, 0, 2, 2, 0, 1},    D3D_OK},                /* Valid */
        {{0, 0, 4, 4, 0, 1},    D3D_OK},                /* Valid */
        {{0, 0, 0, 4, 0, 1},    D3DERR_INVALIDCALL},    /* 0 height */
        {{0, 0, 4, 0, 0, 1},    D3DERR_INVALIDCALL},    /* 0 width */
        {{0, 0, 4, 4, 1, 1},    D3DERR_INVALIDCALL},    /* 0 depth */
        {{4, 0, 0, 4, 0, 1},    D3DERR_INVALIDCALL},    /* left > right */
        {{0, 4, 4, 0, 0, 1},    D3DERR_INVALIDCALL},    /* top > bottom */
        {{0, 0, 4, 4, 1, 0},    D3DERR_INVALIDCALL},    /* back > front */
        {{0, 0, 8, 4, 0, 1},    D3DERR_INVALIDCALL},    /* right > surface */
        {{0, 0, 4, 8, 0, 1},    D3DERR_INVALIDCALL},    /* bottom > surface */
        {{0, 0, 4, 4, 0, 3},    D3DERR_INVALIDCALL},    /* back > surface */
        {{8, 0, 16, 4, 0, 1},   D3DERR_INVALIDCALL},    /* left > surface */
        {{0, 8, 4, 16, 0, 1},   D3DERR_INVALIDCALL},    /* top > surface */
        {{0, 0, 4, 4, 2, 4},    D3DERR_INVALIDCALL},    /* top > surface */
    };
    static const D3DBOX test_boxt_2 = {2, 2, 4, 4, 0, 1};
    IDirect3DVolumeTexture8 *texture = NULL;
    D3DLOCKED_BOX locked_box;
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d;
    unsigned int i;
    ULONG refcount;
    HWND window;
    BYTE *base;
    HRESULT hr;

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_CreateVolumeTexture(device, 4, 4, 2, 1, 0,
            D3DFMT_A8R8G8B8, D3DPOOL_SCRATCH, &texture);
    ok(SUCCEEDED(hr), "Failed to create volume texture, hr %#lx.\n", hr);
    hr = IDirect3DVolumeTexture8_LockBox(texture, 0, &locked_box, NULL, 0);
    ok(SUCCEEDED(hr), "Failed to lock volume texture, hr %#lx.\n", hr);
    base = locked_box.pBits;
    hr = IDirect3DVolumeTexture8_UnlockBox(texture, 0);
    ok(SUCCEEDED(hr), "Failed to unlock volume texture, hr %#lx.\n", hr);

    for (i = 0; i < ARRAY_SIZE(test_data); ++i)
    {
        unsigned int offset, expected_offset;
        const D3DBOX *box = &test_data[i].box;

        locked_box.pBits = (BYTE *)0xdeadbeef;
        locked_box.RowPitch = 0xdeadbeef;
        locked_box.SlicePitch = 0xdeadbeef;

        hr = IDirect3DVolumeTexture8_LockBox(texture, 0, &locked_box, box, 0);
        /* Unlike surfaces, volumes properly check the box even in Windows XP */
        ok(hr == test_data[i].result,
                "Got unexpected hr %#lx with box [%u, %u, %u]->[%u, %u, %u], expected %#lx.\n",
                hr, box->Left, box->Top, box->Front, box->Right, box->Bottom, box->Back,
                test_data[i].result);
        if (FAILED(hr))
            continue;

        offset = (BYTE *)locked_box.pBits - base;
        expected_offset = box->Front * locked_box.SlicePitch + box->Top * locked_box.RowPitch + box->Left * 4;
        ok(offset == expected_offset,
                "Got unexpected offset %u (expected %u) for rect [%u, %u, %u]->[%u, %u, %u].\n",
                offset, expected_offset, box->Left, box->Top, box->Front, box->Right, box->Bottom, box->Back);

        hr = IDirect3DVolumeTexture8_UnlockBox(texture, 0);
        ok(SUCCEEDED(hr), "Failed to unlock volume texture, hr %#lx.\n", hr);
    }

    /* locked_box = NULL throws an exception on Windows */
    hr = IDirect3DVolumeTexture8_LockBox(texture, 0, &locked_box, NULL, 0);
    ok(SUCCEEDED(hr), "Failed to lock volume texture, hr %#lx.\n", hr);
    hr = IDirect3DVolumeTexture8_LockBox(texture, 0, &locked_box, NULL, 0);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DVolumeTexture8_UnlockBox(texture, 0);
    ok(SUCCEEDED(hr), "Failed to unlock volume texture, hr %#lx.\n", hr);
    hr = IDirect3DVolumeTexture8_UnlockBox(texture, 0);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DVolumeTexture8_LockBox(texture, 0, &locked_box, &test_data[0].box, 0);
    ok(hr == D3D_OK, "Got unexpected hr %#lx for rect [%u, %u, %u]->[%u, %u, %u].\n",
            hr, test_data[0].box.Left, test_data[0].box.Top, test_data[0].box.Front,
            test_data[0].box.Right, test_data[0].box.Bottom, test_data[0].box.Back);
    hr = IDirect3DVolumeTexture8_LockBox(texture, 0, &locked_box, &test_data[0].box, 0);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx for rect [%u, %u, %u]->[%u, %u, %u].\n",
            hr, test_data[0].box.Left, test_data[0].box.Top, test_data[0].box.Front,
            test_data[0].box.Right, test_data[0].box.Bottom, test_data[0].box.Back);
    hr = IDirect3DVolumeTexture8_LockBox(texture, 0, &locked_box, &test_boxt_2, 0);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx for rect [%u, %u, %u]->[%u, %u, %u].\n",
            hr, test_boxt_2.Left, test_boxt_2.Top, test_boxt_2.Front,
            test_boxt_2.Right, test_boxt_2.Bottom, test_boxt_2.Back);
    hr = IDirect3DVolumeTexture8_UnlockBox(texture, 0);
    ok(SUCCEEDED(hr), "Failed to unlock volume texture, hr %#lx.\n", hr);

    IDirect3DVolumeTexture8_Release(texture);

    hr = IDirect3DDevice8_CreateVolumeTexture(device, 4, 4, 2, 1, D3DUSAGE_WRITEONLY,
            D3DFMT_A8R8G8B8, D3DPOOL_SCRATCH, &texture);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_pixel_format(void)
{
    int format, test_format;
    PIXELFORMATDESCRIPTOR pfd;
    IDirect3D8 *d3d8 = NULL;
    IDirect3DDevice8 *device = NULL;
    HWND hwnd, hwnd2, hwnd3;
    HDC hdc, hdc2, hdc3;
    ULONG refcount;
    HMODULE gl;
    HRESULT hr;
    BOOL ret;

    static const float point[] = {0.0f, 0.0f, 0.0f};

    hwnd = create_window();
    ok(!!hwnd, "Failed to create window.\n");
    hwnd2 = create_window();
    ok(!!hwnd2, "Failed to create window.\n");

    hdc = GetDC(hwnd);
    ok(!!hdc, "Failed to get DC.\n");
    hdc2 = GetDC(hwnd2);
    ok(!!hdc2, "Failed to get DC.\n");

    gl = LoadLibraryA("opengl32.dll");
    ok(!!gl, "failed to load opengl32.dll; SetPixelFormat()/GetPixelFormat() may not work right\n");

    format = GetPixelFormat(hdc);
    ok(format == 0, "new window has pixel format %d\n", format);

    ZeroMemory(&pfd, sizeof(pfd));
    pfd.nSize = sizeof(pfd);
    pfd.nVersion = 1;
    pfd.dwFlags = PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL;
    pfd.iPixelType = PFD_TYPE_RGBA;
    pfd.iLayerType = PFD_MAIN_PLANE;
    format = ChoosePixelFormat(hdc, &pfd);
    if (format <= 0)
    {
        skip("no pixel format available\n");
        goto cleanup;
    }

    if (!SetPixelFormat(hdc, format, &pfd) || GetPixelFormat(hdc) != format)
    {
        skip("failed to set pixel format\n");
        goto cleanup;
    }

    if (!SetPixelFormat(hdc2, format, &pfd) || GetPixelFormat(hdc2) != format)
    {
        skip("failed to set pixel format on second window\n");
        goto cleanup;
    }

    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");

    test_format = GetPixelFormat(hdc);
    ok(test_format == format, "window has pixel format %d, expected %d\n", test_format, format);

    if (!(device = create_device(d3d8, hwnd, NULL)))
    {
        skip("Failed to create device\n");
        goto cleanup;
    }

    test_format = GetPixelFormat(hdc);
    ok(test_format == format, "window has pixel format %d, expected %d\n", test_format, format);

    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ);
    ok(SUCCEEDED(hr), "Failed to set FVF, hr %#lx.\n", hr);

    test_format = GetPixelFormat(hdc);
    ok(test_format == format, "window has pixel format %d, expected %d\n", test_format, format);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);

    test_format = GetPixelFormat(hdc);
    ok(test_format == format, "window has pixel format %d, expected %d\n", test_format, format);

    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_POINTLIST, 1, point, 3 * sizeof(float));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    test_format = GetPixelFormat(hdc);
    ok(test_format == format, "window has pixel format %d, expected %d\n", test_format, format);

    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);

    test_format = GetPixelFormat(hdc);
    ok(test_format == format, "window has pixel format %d, expected %d\n", test_format, format);

    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);

    test_format = GetPixelFormat(hdc);
    ok(test_format == format, "window has pixel format %d, expected %d\n", test_format, format);

    hr = IDirect3DDevice8_Present(device, NULL, NULL, hwnd2, NULL);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);

    test_format = GetPixelFormat(hdc);
    ok(test_format == format, "window has pixel format %d, expected %d\n", test_format, format);

    test_format = GetPixelFormat(hdc2);
    ok(test_format == format, "second window has pixel format %d, expected %d\n", test_format, format);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d8);

    test_format = GetPixelFormat(hdc);
    ok(test_format == format, "window has pixel format %d, expected %d\n", test_format, format);

    test_format = GetPixelFormat(hdc2);
    ok(test_format == format, "second window has pixel format %d, expected %d\n", test_format, format);

    /* Test that creating a device doesn't set a pixel format on a window which
     * never had one. */

    hwnd3 = create_window();
    hdc3 = GetDC(hwnd3);

    test_format = GetPixelFormat(hdc3);
    ok(!test_format, "Expected no format, got %d.\n", test_format);

    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d8, hwnd3, NULL)))
    {
        skip("Failed to create device\n");
        goto cleanup;
    }

    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_BeginScene(device);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_POINTLIST, 1, point, 3 * sizeof(float));
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    test_format = GetPixelFormat(hdc3);
    ok(!test_format, "Expected no format, got %d.\n", test_format);

    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    test_format = GetPixelFormat(hdc3);
    ok(!test_format, "Expected no format, got %d.\n", test_format);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d8);

    test_format = GetPixelFormat(hdc3);
    ok(!test_format, "Expected no format, got %d.\n", test_format);

    ret = SetPixelFormat(hdc3, format, &pfd);
    ok(ret, "Failed to set pixel format %d.\n", format);

    test_format = GetPixelFormat(hdc3);
    ok(test_format == format, "Expected pixel format %d, got %d.\n", format, test_format);

    ReleaseDC(hwnd3, hdc3);
    DestroyWindow(hwnd3);

cleanup:
    FreeLibrary(gl);
    ReleaseDC(hwnd2, hdc2);
    ReleaseDC(hwnd, hdc);
    DestroyWindow(hwnd2);
    DestroyWindow(hwnd);
}

static void test_begin_end_state_block(void)
{
    DWORD stateblock, stateblock2;
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d;
    ULONG refcount;
    DWORD value;
    HWND window;
    HRESULT hr;

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_BeginStateBlock(device);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    stateblock = 0xdeadbeef;
    hr = IDirect3DDevice8_EndStateBlock(device, &stateblock);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    ok(!!stateblock && stateblock != 0xdeadbeef, "Got unexpected stateblock %#lx.\n", stateblock);

    stateblock2 = 0xdeadbeef;
    hr = IDirect3DDevice8_EndStateBlock(device, &stateblock2);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);
    ok(stateblock2 == 0xdeadbeef, "Got unexpected stateblock %#lx.\n", stateblock2);

    hr = IDirect3DDevice8_GetRenderState(device, D3DRS_LIGHTING, &value);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    ok(value == TRUE, "Got unexpected value %#lx.\n", value);

    hr = IDirect3DDevice8_BeginStateBlock(device);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginStateBlock(device);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_ApplyStateBlock(device, stateblock);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CaptureStateBlock(device, stateblock);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CreateStateBlock(device, D3DSBT_ALL, &stateblock2);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetRenderState(device, D3DRS_LIGHTING, &value);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    ok(value == TRUE, "Got unexpected value %#lx.\n", value);

    hr = IDirect3DDevice8_EndStateBlock(device, &stateblock2);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_ApplyStateBlock(device, stateblock2);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetRenderState(device, D3DRS_LIGHTING, &value);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    ok(value == TRUE, "Got unexpected value %#lx.\n", value);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_shader_constant_apply(void)
{
    static const float vs_const[] = {1.0f, 2.0f, 3.0f, 4.0f};
    static const float ps_const[] = {5.0f, 6.0f, 7.0f, 8.0f};
    static const float initial[] = {0.0f, 0.0f, 0.0f, 0.0f};
    DWORD vs_version, ps_version;
    IDirect3DDevice8 *device;
    DWORD stateblock;
    IDirect3D8 *d3d;
    ULONG refcount;
    D3DCAPS8 caps;
    float ret[4];
    HWND window;
    HRESULT hr;

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get device caps, hr %#lx.\n", hr);
    vs_version = caps.VertexShaderVersion & 0xffff;
    ps_version = caps.PixelShaderVersion & 0xffff;

    if (vs_version)
    {
        hr = IDirect3DDevice8_SetVertexShaderConstant(device, 0, initial, 1);
        ok(SUCCEEDED(hr), "Failed to set vertex shader constant, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetVertexShaderConstant(device, 1, initial, 1);
        ok(SUCCEEDED(hr), "Failed to set vertex shader constant, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_GetVertexShaderConstant(device, 0, ret, 1);
        ok(SUCCEEDED(hr), "Failed to get vertex shader constant, hr %#lx.\n", hr);
        ok(!memcmp(ret, initial, sizeof(initial)),
                "Got unexpected vertex shader constant {%.8e, %.8e, %.8e, %.8e}, expected {%.8e, %.8e, %.8e, %.8e}.\n",
                ret[0], ret[1], ret[2], ret[3], initial[0], initial[1], initial[2], initial[3]);
        hr = IDirect3DDevice8_GetVertexShaderConstant(device, 1, ret, 1);
        ok(SUCCEEDED(hr), "Failed to get vertex shader constant, hr %#lx.\n", hr);
        ok(!memcmp(ret, initial, sizeof(initial)),
                "Got unexpected vertex shader constant {%.8e, %.8e, %.8e, %.8e}, expected {%.8e, %.8e, %.8e, %.8e}.\n",
                ret[0], ret[1], ret[2], ret[3], initial[0], initial[1], initial[2], initial[3]);

        hr = IDirect3DDevice8_SetVertexShaderConstant(device, 0, vs_const, 1);
        ok(SUCCEEDED(hr), "Failed to set vertex shader constant, hr %#lx.\n", hr);
    }
    if (ps_version)
    {
        hr = IDirect3DDevice8_SetPixelShaderConstant(device, 0, initial, 1);
        ok(SUCCEEDED(hr), "Failed to set pixel shader constant, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetPixelShaderConstant(device, 1, initial, 1);
        ok(SUCCEEDED(hr), "Failed to set pixel shader constant, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_GetPixelShaderConstant(device, 0, ret, 1);
        ok(SUCCEEDED(hr), "Failed to get pixel shader constant, hr %#lx.\n", hr);
        ok(!memcmp(ret, initial, sizeof(initial)),
                "Got unexpected pixel shader constant {%.8e, %.8e, %.8e, %.8e}, expected {%.8e, %.8e, %.8e, %.8e}.\n",
                ret[0], ret[1], ret[2], ret[3], initial[0], initial[1], initial[2], initial[3]);
        hr = IDirect3DDevice8_GetPixelShaderConstant(device, 1, ret, 1);
        ok(SUCCEEDED(hr), "Failed to get pixel shader constant, hr %#lx.\n", hr);
        ok(!memcmp(ret, initial, sizeof(initial)),
                "Got unexpected pixel shader constant {%.8e, %.8e, %.8e, %.8e}, expected {%.8e, %.8e, %.8e, %.8e}.\n",
                ret[0], ret[1], ret[2], ret[3], initial[0], initial[1], initial[2], initial[3]);

        hr = IDirect3DDevice8_SetPixelShaderConstant(device, 0, ps_const, 1);
        ok(SUCCEEDED(hr), "Failed to set pixel shader constant, hr %#lx.\n", hr);
    }

    hr = IDirect3DDevice8_BeginStateBlock(device);
    ok(SUCCEEDED(hr), "Failed to begin stateblock, hr %#lx.\n", hr);

    if (vs_version)
    {
        hr = IDirect3DDevice8_SetVertexShaderConstant(device, 1, vs_const, 1);
        ok(SUCCEEDED(hr), "Failed to set vertex shader constant, hr %#lx.\n", hr);
    }
    if (ps_version)
    {
        hr = IDirect3DDevice8_SetPixelShaderConstant(device, 1, ps_const, 1);
        ok(SUCCEEDED(hr), "Failed to set pixel shader constant, hr %#lx.\n", hr);
    }

    hr = IDirect3DDevice8_EndStateBlock(device, &stateblock);
    ok(SUCCEEDED(hr), "Failed to end stateblock, hr %#lx.\n", hr);

    if (vs_version)
    {
        hr = IDirect3DDevice8_GetVertexShaderConstant(device, 0, ret, 1);
        ok(SUCCEEDED(hr), "Failed to get vertex shader constant, hr %#lx.\n", hr);
        ok(!memcmp(ret, vs_const, sizeof(vs_const)),
                "Got unexpected vertex shader constant {%.8e, %.8e, %.8e, %.8e}, expected {%.8e, %.8e, %.8e, %.8e}.\n",
                ret[0], ret[1], ret[2], ret[3], vs_const[0], vs_const[1], vs_const[2], vs_const[3]);
        hr = IDirect3DDevice8_GetVertexShaderConstant(device, 1, ret, 1);
        ok(SUCCEEDED(hr), "Failed to get vertex shader constant, hr %#lx.\n", hr);
        ok(!memcmp(ret, initial, sizeof(initial)),
                "Got unexpected vertex shader constant {%.8e, %.8e, %.8e, %.8e}, expected {%.8e, %.8e, %.8e, %.8e}.\n",
                ret[0], ret[1], ret[2], ret[3], initial[0], initial[1], initial[2], initial[3]);
    }
    if (ps_version)
    {
        hr = IDirect3DDevice8_GetPixelShaderConstant(device, 0, ret, 1);
        ok(SUCCEEDED(hr), "Failed to get pixel shader constant, hr %#lx.\n", hr);
        ok(!memcmp(ret, ps_const, sizeof(ps_const)),
                "Got unexpected pixel shader constant {%.8e, %.8e, %.8e, %.8e}, expected {%.8e, %.8e, %.8e, %.8e}.\n",
                ret[0], ret[1], ret[2], ret[3], ps_const[0], ps_const[1], ps_const[2], ps_const[3]);
        hr = IDirect3DDevice8_GetPixelShaderConstant(device, 1, ret, 1);
        ok(SUCCEEDED(hr), "Failed to get pixel shader constant, hr %#lx.\n", hr);
        ok(!memcmp(ret, initial, sizeof(initial)),
                "Got unexpected pixel shader constant {%.8e, %.8e, %.8e, %.8e}, expected {%.8e, %.8e, %.8e, %.8e}.\n",
                ret[0], ret[1], ret[2], ret[3], initial[0], initial[1], initial[2], initial[3]);
    }

    /* Apply doesn't overwrite constants that aren't explicitly set on the
     * source stateblock. */
    hr = IDirect3DDevice8_ApplyStateBlock(device, stateblock);
    ok(SUCCEEDED(hr), "Failed to apply stateblock, hr %#lx.\n", hr);

    if (vs_version)
    {
        hr = IDirect3DDevice8_GetVertexShaderConstant(device, 0, ret, 1);
        ok(SUCCEEDED(hr), "Failed to get vertex shader constant, hr %#lx.\n", hr);
        ok(!memcmp(ret, vs_const, sizeof(vs_const)),
                "Got unexpected vertex shader constant {%.8e, %.8e, %.8e, %.8e}, expected {%.8e, %.8e, %.8e, %.8e}.\n",
                ret[0], ret[1], ret[2], ret[3], vs_const[0], vs_const[1], vs_const[2], vs_const[3]);
        hr = IDirect3DDevice8_GetVertexShaderConstant(device, 1, ret, 1);
        ok(SUCCEEDED(hr), "Failed to get vertex shader constant, hr %#lx.\n", hr);
        ok(!memcmp(ret, vs_const, sizeof(vs_const)),
                "Got unexpected vertex shader constant {%.8e, %.8e, %.8e, %.8e}, expected {%.8e, %.8e, %.8e, %.8e}.\n",
                ret[0], ret[1], ret[2], ret[3], vs_const[0], vs_const[1], vs_const[2], vs_const[3]);
    }
    if (ps_version)
    {
        hr = IDirect3DDevice8_GetPixelShaderConstant(device, 0, ret, 1);
        ok(SUCCEEDED(hr), "Failed to get pixel shader constant, hr %#lx.\n", hr);
        ok(!memcmp(ret, ps_const, sizeof(ps_const)),
                "Got unexpected pixel shader constant {%.8e, %.8e, %.8e, %.8e}, expected {%.8e, %.8e, %.8e, %.8e}.\n",
                ret[0], ret[1], ret[2], ret[3], ps_const[0], ps_const[1], ps_const[2], ps_const[3]);
        hr = IDirect3DDevice8_GetPixelShaderConstant(device, 1, ret, 1);
        ok(SUCCEEDED(hr), "Failed to get pixel shader constant, hr %#lx.\n", hr);
        ok(!memcmp(ret, ps_const, sizeof(ps_const)),
                "Got unexpected pixel shader constant {%.8e, %.8e, %.8e, %.8e}, expected {%.8e, %.8e, %.8e, %.8e}.\n",
                ret[0], ret[1], ret[2], ret[3], ps_const[0], ps_const[1], ps_const[2], ps_const[3]);
    }

    IDirect3DDevice8_DeleteStateBlock(device, stateblock);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_resource_type(void)
{
    IDirect3DDevice8 *device;
    IDirect3DSurface8 *surface;
    IDirect3DTexture8 *texture;
    IDirect3DCubeTexture8 *cube_texture;
    IDirect3DVolume8 *volume;
    IDirect3DVolumeTexture8 *volume_texture;
    D3DSURFACE_DESC surface_desc;
    D3DVOLUME_DESC volume_desc;
    D3DRESOURCETYPE type;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;
    D3DCAPS8 caps;

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get device caps, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CreateImageSurface(device, 4, 4, D3DFMT_X8R8G8B8, &surface);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);
    hr = IDirect3DSurface8_GetDesc(surface, &surface_desc);
    ok(SUCCEEDED(hr), "Failed to get surface description, hr %#lx.\n", hr);
    ok(surface_desc.Type == D3DRTYPE_SURFACE, "Expected type D3DRTYPE_SURFACE, got %u.\n",
            surface_desc.Type);
    IDirect3DSurface8_Release(surface);

    hr = IDirect3DDevice8_CreateTexture(device, 2, 8, 4, 0, D3DFMT_X8R8G8B8,
            D3DPOOL_SYSTEMMEM, &texture);
    ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx.\n", hr);
    type = IDirect3DTexture8_GetType(texture);
    ok(type == D3DRTYPE_TEXTURE, "Expected type D3DRTYPE_TEXTURE, got %u.\n", type);

    hr = IDirect3DTexture8_GetSurfaceLevel(texture, 0, &surface);
    ok(SUCCEEDED(hr), "Failed to get surface level, hr %#lx.\n", hr);
    hr = IDirect3DSurface8_GetDesc(surface, &surface_desc);
    ok(SUCCEEDED(hr), "Failed to get surface description, hr %#lx.\n", hr);
    ok(surface_desc.Type == D3DRTYPE_SURFACE, "Expected type D3DRTYPE_SURFACE, got %u.\n",
            surface_desc.Type);
    ok(surface_desc.Width == 2, "Expected width 2, got %u.\n", surface_desc.Width);
    ok(surface_desc.Height == 8, "Expected height 8, got %u.\n", surface_desc.Height);
    hr = IDirect3DTexture8_GetLevelDesc(texture, 0, &surface_desc);
    ok(SUCCEEDED(hr), "Failed to get level description, hr %#lx.\n", hr);
    ok(surface_desc.Type == D3DRTYPE_SURFACE, "Expected type D3DRTYPE_SURFACE, got %u.\n",
            surface_desc.Type);
    ok(surface_desc.Width == 2, "Expected width 2, got %u.\n", surface_desc.Width);
    ok(surface_desc.Height == 8, "Expected height 8, got %u.\n", surface_desc.Height);
    IDirect3DSurface8_Release(surface);

    hr = IDirect3DTexture8_GetSurfaceLevel(texture, 2, &surface);
    ok(SUCCEEDED(hr), "Failed to get surface level, hr %#lx.\n", hr);
    hr = IDirect3DSurface8_GetDesc(surface, &surface_desc);
    ok(SUCCEEDED(hr), "Failed to get surface description, hr %#lx.\n", hr);
    ok(surface_desc.Type == D3DRTYPE_SURFACE, "Expected type D3DRTYPE_SURFACE, got %u.\n",
            surface_desc.Type);
    ok(surface_desc.Width == 1, "Expected width 1, got %u.\n", surface_desc.Width);
    ok(surface_desc.Height == 2, "Expected height 2, got %u.\n", surface_desc.Height);
    hr = IDirect3DTexture8_GetLevelDesc(texture, 2, &surface_desc);
    ok(SUCCEEDED(hr), "Failed to get level description, hr %#lx.\n", hr);
    ok(surface_desc.Type == D3DRTYPE_SURFACE, "Expected type D3DRTYPE_SURFACE, got %u.\n",
            surface_desc.Type);
    ok(surface_desc.Width == 1, "Expected width 1, got %u.\n", surface_desc.Width);
    ok(surface_desc.Height == 2, "Expected height 2, got %u.\n", surface_desc.Height);
    IDirect3DSurface8_Release(surface);
    IDirect3DTexture8_Release(texture);

    if (caps.TextureCaps & D3DPTEXTURECAPS_CUBEMAP)
    {
        hr = IDirect3DDevice8_CreateCubeTexture(device, 1, 1, 0, D3DFMT_X8R8G8B8,
                D3DPOOL_SYSTEMMEM, &cube_texture);
        ok(SUCCEEDED(hr), "Failed to create cube texture, hr %#lx.\n", hr);
        type = IDirect3DCubeTexture8_GetType(cube_texture);
        ok(type == D3DRTYPE_CUBETEXTURE, "Expected type D3DRTYPE_CUBETEXTURE, got %u.\n", type);

        hr = IDirect3DCubeTexture8_GetCubeMapSurface(cube_texture,
                D3DCUBEMAP_FACE_NEGATIVE_X, 0, &surface);
        ok(SUCCEEDED(hr), "Failed to get cube map surface, hr %#lx.\n", hr);
        hr = IDirect3DSurface8_GetDesc(surface, &surface_desc);
        ok(SUCCEEDED(hr), "Failed to get surface description, hr %#lx.\n", hr);
        ok(surface_desc.Type == D3DRTYPE_SURFACE, "Expected type D3DRTYPE_SURFACE, got %u.\n",
                surface_desc.Type);
        hr = IDirect3DCubeTexture8_GetLevelDesc(cube_texture, 0, &surface_desc);
        ok(SUCCEEDED(hr), "Failed to get level description, hr %#lx.\n", hr);
        ok(surface_desc.Type == D3DRTYPE_SURFACE, "Expected type D3DRTYPE_SURFACE, got %u.\n",
                surface_desc.Type);
        IDirect3DSurface8_Release(surface);
        IDirect3DCubeTexture8_Release(cube_texture);
    }
    else
        skip("Cube maps not supported.\n");

    if (caps.TextureCaps & D3DPTEXTURECAPS_MIPVOLUMEMAP)
    {
        hr = IDirect3DDevice8_CreateVolumeTexture(device, 2, 4, 8, 4, 0, D3DFMT_X8R8G8B8,
                D3DPOOL_SYSTEMMEM, &volume_texture);
        ok(SUCCEEDED(hr), "CreateVolumeTexture failed, hr %#lx.\n", hr);
        type = IDirect3DVolumeTexture8_GetType(volume_texture);
        ok(type == D3DRTYPE_VOLUMETEXTURE, "Expected type D3DRTYPE_VOLUMETEXTURE, got %u.\n", type);

        hr = IDirect3DVolumeTexture8_GetVolumeLevel(volume_texture, 0, &volume);
        ok(SUCCEEDED(hr), "Failed to get volume level, hr %#lx.\n", hr);
        /* IDirect3DVolume8 is not an IDirect3DResource8 and has no GetType method. */
        hr = IDirect3DVolume8_GetDesc(volume, &volume_desc);
        ok(SUCCEEDED(hr), "Failed to get volume description, hr %#lx.\n", hr);
        ok(volume_desc.Type == D3DRTYPE_VOLUME, "Expected type D3DRTYPE_VOLUME, got %u.\n",
                volume_desc.Type);
        ok(volume_desc.Width == 2, "Expected width 2, got %u.\n", volume_desc.Width);
        ok(volume_desc.Height == 4, "Expected height 4, got %u.\n", volume_desc.Height);
        ok(volume_desc.Depth == 8, "Expected depth 8, got %u.\n", volume_desc.Depth);
        hr = IDirect3DVolumeTexture8_GetLevelDesc(volume_texture, 0, &volume_desc);
        ok(SUCCEEDED(hr), "Failed to get level description, hr %#lx.\n", hr);
        ok(volume_desc.Type == D3DRTYPE_VOLUME, "Expected type D3DRTYPE_VOLUME, got %u.\n",
                volume_desc.Type);
        ok(volume_desc.Width == 2, "Expected width 2, got %u.\n", volume_desc.Width);
        ok(volume_desc.Height == 4, "Expected height 4, got %u.\n", volume_desc.Height);
        ok(volume_desc.Depth == 8, "Expected depth 8, got %u.\n", volume_desc.Depth);
        IDirect3DVolume8_Release(volume);

        hr = IDirect3DVolumeTexture8_GetVolumeLevel(volume_texture, 2, &volume);
        ok(SUCCEEDED(hr), "Failed to get volume level, hr %#lx.\n", hr);
        hr = IDirect3DVolume8_GetDesc(volume, &volume_desc);
        ok(SUCCEEDED(hr), "Failed to get volume description, hr %#lx.\n", hr);
        ok(volume_desc.Type == D3DRTYPE_VOLUME, "Expected type D3DRTYPE_VOLUME, got %u.\n",
                volume_desc.Type);
        ok(volume_desc.Width == 1, "Expected width 1, got %u.\n", volume_desc.Width);
        ok(volume_desc.Height == 1, "Expected height 1, got %u.\n", volume_desc.Height);
        ok(volume_desc.Depth == 2, "Expected depth 2, got %u.\n", volume_desc.Depth);
        hr = IDirect3DVolumeTexture8_GetLevelDesc(volume_texture, 2, &volume_desc);
        ok(SUCCEEDED(hr), "Failed to get level description, hr %#lx.\n", hr);
        ok(volume_desc.Type == D3DRTYPE_VOLUME, "Expected type D3DRTYPE_VOLUME, got %u.\n",
                volume_desc.Type);
        ok(volume_desc.Width == 1, "Expected width 1, got %u.\n", volume_desc.Width);
        ok(volume_desc.Height == 1, "Expected height 1, got %u.\n", volume_desc.Height);
        ok(volume_desc.Depth == 2, "Expected depth 2, got %u.\n", volume_desc.Depth);
        IDirect3DVolume8_Release(volume);
        IDirect3DVolumeTexture8_Release(volume_texture);
    }
    else
        skip("Mipmapped volume maps not supported.\n");

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_mipmap_lock(void)
{
    IDirect3DDevice8 *device;
    IDirect3DSurface8 *surface, *surface2, *surface_dst, *surface_dst2;
    IDirect3DTexture8 *texture, *texture_dst;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;
    D3DLOCKED_RECT locked_rect;

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_CreateTexture(device, 4, 4, 2, 0, D3DFMT_X8R8G8B8,
            D3DPOOL_DEFAULT, &texture_dst);
    ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx.\n", hr);
    hr = IDirect3DTexture8_GetSurfaceLevel(texture_dst, 0, &surface_dst);
    ok(SUCCEEDED(hr), "Failed to get surface level, hr %#lx.\n", hr);
    hr = IDirect3DTexture8_GetSurfaceLevel(texture_dst, 1, &surface_dst2);
    ok(SUCCEEDED(hr), "Failed to get surface level, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CreateTexture(device, 4, 4, 2, 0, D3DFMT_X8R8G8B8,
            D3DPOOL_SYSTEMMEM, &texture);
    ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx.\n", hr);
    hr = IDirect3DTexture8_GetSurfaceLevel(texture, 0, &surface);
    ok(SUCCEEDED(hr), "Failed to get surface level, hr %#lx.\n", hr);
    hr = IDirect3DTexture8_GetSurfaceLevel(texture, 1, &surface2);
    ok(SUCCEEDED(hr), "Failed to get surface level, hr %#lx.\n", hr);

    hr = IDirect3DSurface8_LockRect(surface, &locked_rect, NULL, 0);
    ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx.\n", hr);
    hr = IDirect3DSurface8_LockRect(surface2, &locked_rect, NULL, 0);
    ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx.\n", hr);
    hr = IDirect3DSurface8_UnlockRect(surface);
    ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CopyRects(device, surface, NULL, 0, surface_dst, NULL);
    ok(SUCCEEDED(hr), "Failed to update surface, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CopyRects(device, surface2, NULL, 0, surface_dst2, NULL);
    todo_wine ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);

    /* Apparently there's no validation on the container. */
    hr = IDirect3DDevice8_UpdateTexture(device, (IDirect3DBaseTexture8 *)texture,
            (IDirect3DBaseTexture8 *)texture_dst);
    ok(SUCCEEDED(hr), "Failed to update texture, hr %#lx.\n", hr);

    hr = IDirect3DSurface8_UnlockRect(surface2);
    ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);

    IDirect3DSurface8_Release(surface_dst2);
    IDirect3DSurface8_Release(surface_dst);
    IDirect3DSurface8_Release(surface2);
    IDirect3DSurface8_Release(surface);
    IDirect3DTexture8_Release(texture_dst);
    IDirect3DTexture8_Release(texture);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_writeonly_resource(void)
{
    IDirect3D8 *d3d;
    IDirect3DDevice8 *device;
    IDirect3DVertexBuffer8 *buffer;
    ULONG refcount;
    HWND window;
    HRESULT hr;
    BYTE *ptr;
    static const struct
    {
        struct vec3 pos;
    }
    quad[] =
    {
        {{-1.0f, -1.0f, 0.0f}},
        {{-1.0f,  1.0f, 0.0f}},
        {{ 1.0f, -1.0f, 0.0f}},
        {{ 1.0f,  1.0f, 0.0f}}
    };

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_CreateVertexBuffer(device, sizeof(quad),
            D3DUSAGE_DYNAMIC | D3DUSAGE_WRITEONLY, 0, D3DPOOL_DEFAULT, &buffer);
    ok(SUCCEEDED(hr), "Failed to create buffer, hr %#lx.\n", hr);

    hr = IDirect3DVertexBuffer8_Lock(buffer, 0, 0, &ptr, D3DLOCK_DISCARD);
    ok(SUCCEEDED(hr), "Failed to lock vertex buffer, hr %#lx.\n", hr);
    memcpy(ptr, quad, sizeof(quad));
    hr = IDirect3DVertexBuffer8_Unlock(buffer);
    ok(SUCCEEDED(hr), "Failed to unlock vertex buffer, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetStreamSource(device, 0, buffer, sizeof(*quad));
    ok(SUCCEEDED(hr), "Failed to set stream source, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ);
    ok(SUCCEEDED(hr), "Failed to set FVF, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, 0, 2);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);

    hr = IDirect3DVertexBuffer8_Lock(buffer, 0, 0, &ptr, 0);
    ok(SUCCEEDED(hr), "Failed to lock vertex buffer, hr %#lx.\n", hr);
    ok (!memcmp(ptr, quad, sizeof(quad)), "Got unexpected vertex buffer data.\n");
    hr = IDirect3DVertexBuffer8_Unlock(buffer);
    ok(SUCCEEDED(hr), "Failed to unlock vertex buffer, hr %#lx.\n", hr);

    hr = IDirect3DVertexBuffer8_Lock(buffer, 0, 0, &ptr, D3DLOCK_READONLY);
    ok(SUCCEEDED(hr), "Failed to lock vertex buffer, hr %#lx.\n", hr);
    ok (!memcmp(ptr, quad, sizeof(quad)), "Got unexpected vertex buffer data.\n");
    hr = IDirect3DVertexBuffer8_Unlock(buffer);
    ok(SUCCEEDED(hr), "Failed to unlock vertex buffer, hr %#lx.\n", hr);

    refcount = IDirect3DVertexBuffer8_Release(buffer);
    ok(!refcount, "Vertex buffer has %lu references left.\n", refcount);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_lost_device(void)
{
    D3DADAPTER_IDENTIFIER8 identifier;
    struct device_desc device_desc;
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;
    BOOL ret;

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    hr = IDirect3D8_GetAdapterIdentifier(d3d, D3DADAPTER_DEFAULT, 0, &identifier);
    ok(SUCCEEDED(hr), "Failed to get adapter identifier, hr %#lx.\n", hr);
    device_desc.adapter_ordinal = D3DADAPTER_DEFAULT;
    device_desc.device_window = window;
    device_desc.width = registry_mode.dmPelsWidth;
    device_desc.height = registry_mode.dmPelsHeight;
    device_desc.flags = CREATE_DEVICE_FULLSCREEN;
    if (!(device = create_device(d3d, window, &device_desc)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    hr = IDirect3DDevice8_TestCooperativeLevel(device);
    if (hr == D3DERR_DEVICELOST)
    {
        win_skip("Broken TestCooperativeLevel(), skipping test.\n");
        IDirect3DDevice8_Release(device);
        goto done;
    }
    if (adapter_is_warp(&identifier))
    {
        win_skip("Windows 10 WARP crashes during this test.\n");
        IDirect3DDevice8_Release(device);
        goto done;
    }

    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    ret = SetForegroundWindow(GetDesktopWindow());
    ok(ret, "Failed to set foreground window.\n");
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    /* The device is not lost on Windows 10. */
    ok(hr == D3DERR_DEVICELOST || broken(hr == D3D_OK), "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_TestCooperativeLevel(device);
    ok(hr == D3DERR_DEVICELOST || broken(hr == D3D_OK), "Got unexpected hr %#lx.\n", hr);

    ret = ShowWindow(window, SW_RESTORE);
    ok(ret, "Failed to restore window.\n");
    ret = SetForegroundWindow(window);
    ok(ret, "Failed to set foreground window.\n");
    hr = IDirect3DDevice8_TestCooperativeLevel(device);
    ok(hr == D3DERR_DEVICENOTRESET || broken(hr == D3D_OK), "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(hr == D3DERR_DEVICELOST || broken(hr == D3D_OK), "Got unexpected hr %#lx.\n", hr);

    hr = reset_device(device, &device_desc);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_TestCooperativeLevel(device);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    device_desc.flags = 0;
    hr = reset_device(device, &device_desc);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_TestCooperativeLevel(device);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    ret = SetForegroundWindow(GetDesktopWindow());
    ok(ret, "Failed to set foreground window.\n");
    hr = IDirect3DDevice8_TestCooperativeLevel(device);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    ret = ShowWindow(window, SW_RESTORE);
    ok(ret, "Failed to restore window.\n");
    hr = IDirect3DDevice8_TestCooperativeLevel(device);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    device_desc.flags = CREATE_DEVICE_FULLSCREEN;
    hr = reset_device(device, &device_desc);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_TestCooperativeLevel(device);
    /* The device is not lost on Windows 10. */
    todo_wine ok(hr == D3DERR_DEVICELOST || broken(hr == D3D_OK), "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    todo_wine ok(hr == D3DERR_DEVICELOST || broken(hr == D3D_OK), "Got unexpected hr %#lx.\n", hr);

    ret = SetForegroundWindow(GetDesktopWindow());
    ok(ret, "Failed to set foreground window.\n");
    hr = reset_device(device, &device_desc);
    ok(hr == D3DERR_DEVICELOST || broken(hr == D3D_OK), "Got unexpected hr %#lx.\n", hr);
    ret = ShowWindow(window, SW_RESTORE);
    ok(ret, "Failed to restore window.\n");
    ret = SetForegroundWindow(window);
    ok(ret, "Failed to set foreground window.\n");
    hr = reset_device(device, &device_desc);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_resource_priority(void)
{
    IDirect3DDevice8 *device;
    IDirect3DTexture8 *texture;
    IDirect3DVertexBuffer8 *buffer;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;
    static const struct
    {
        D3DPOOL pool;
        const char *name;
        BOOL can_set_priority;
    }
    test_data[] =
    {
        {D3DPOOL_DEFAULT, "D3DPOOL_DEFAULT", FALSE},
        {D3DPOOL_SYSTEMMEM, "D3DPOOL_SYSTEMMEM", FALSE},
        {D3DPOOL_MANAGED, "D3DPOOL_MANAGED", TRUE},
        {D3DPOOL_SCRATCH, "D3DPOOL_SCRATCH", FALSE}
    };
    unsigned int i;
    DWORD priority;

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    for (i = 0; i < ARRAY_SIZE(test_data); i++)
    {
        hr = IDirect3DDevice8_CreateTexture(device, 16, 16, 0, 0, D3DFMT_X8R8G8B8,
                test_data[i].pool, &texture);
        ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx, pool %s.\n", hr, test_data[i].name);

        priority = IDirect3DTexture8_GetPriority(texture);
        ok(priority == 0, "Got unexpected priority %lu, pool %s.\n", priority, test_data[i].name);
        priority = IDirect3DTexture8_SetPriority(texture, 1);
        ok(priority == 0, "Got unexpected priority %lu, pool %s.\n", priority, test_data[i].name);
        priority = IDirect3DTexture8_GetPriority(texture);
        if (test_data[i].can_set_priority)
        {
            ok(priority == 1, "Got unexpected priority %lu, pool %s.\n", priority, test_data[i].name);
            priority = IDirect3DTexture8_SetPriority(texture, 0);
            ok(priority == 1, "Got unexpected priority %lu, pool %s.\n", priority, test_data[i].name);
        }
        else
            ok(priority == 0, "Got unexpected priority %lu, pool %s.\n", priority, test_data[i].name);

        IDirect3DTexture8_Release(texture);

        if (test_data[i].pool != D3DPOOL_SCRATCH)
        {
            hr = IDirect3DDevice8_CreateVertexBuffer(device, 256, 0, 0,
                    test_data[i].pool, &buffer);
            ok(SUCCEEDED(hr), "Failed to create buffer, hr %#lx, pool %s.\n", hr, test_data[i].name);

            priority = IDirect3DVertexBuffer8_GetPriority(buffer);
            ok(priority == 0, "Got unexpected priority %lu, pool %s.\n", priority, test_data[i].name);
            priority = IDirect3DVertexBuffer8_SetPriority(buffer, 1);
            ok(priority == 0, "Got unexpected priority %lu, pool %s.\n", priority, test_data[i].name);
            priority = IDirect3DVertexBuffer8_GetPriority(buffer);
            if (test_data[i].can_set_priority)
            {
                ok(priority == 1, "Got unexpected priority %lu, pool %s.\n", priority, test_data[i].name);
                priority = IDirect3DVertexBuffer8_SetPriority(buffer, 0);
                ok(priority == 1, "Got unexpected priority %lu, pool %s.\n", priority, test_data[i].name);
            }
            else
                ok(priority == 0, "Got unexpected priority %lu, pool %s.\n", priority, test_data[i].name);

            IDirect3DVertexBuffer8_Release(buffer);
        }
    }

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_swapchain_parameters(void)
{
    IDirect3DSurface8 *backbuffer;
    IDirect3DDevice8 *device;
    HRESULT hr, expected_hr;
    IDirect3D8 *d3d;
    D3DCAPS8 caps;
    HWND window;
    unsigned int i, j;
    D3DPRESENT_PARAMETERS present_parameters, present_parameters_windowed = {0};
    static const struct
    {
        BOOL windowed;
        UINT backbuffer_count;
        D3DSWAPEFFECT swap_effect;
        HRESULT hr;
    }
    tests[] =
    {
        /* Swap effect 0 is not allowed. */
        {TRUE,  1, 0,                            D3DERR_INVALIDCALL},
        {FALSE, 1, 0,                            D3DERR_INVALIDCALL},

        /* All (non-ex) swap effects are allowed in
         * windowed and fullscreen mode. */
        {TRUE,  1, D3DSWAPEFFECT_DISCARD,        D3D_OK},
        {TRUE,  1, D3DSWAPEFFECT_FLIP,           D3D_OK},
        {FALSE, 1, D3DSWAPEFFECT_DISCARD,        D3D_OK},
        {FALSE, 1, D3DSWAPEFFECT_FLIP,           D3D_OK},
        {FALSE, 1, D3DSWAPEFFECT_COPY,           D3D_OK},

        /* Only one backbuffer in copy mode. Reset allows it for
         * some reason. */
        {TRUE,  0, D3DSWAPEFFECT_COPY,           D3D_OK},
        {TRUE,  1, D3DSWAPEFFECT_COPY,           D3D_OK},
        {TRUE,  2, D3DSWAPEFFECT_COPY,           D3DERR_INVALIDCALL},
        {FALSE, 2, D3DSWAPEFFECT_COPY,           D3DERR_INVALIDCALL},
        {TRUE,  0, D3DSWAPEFFECT_COPY_VSYNC,     D3D_OK},
        {TRUE,  1, D3DSWAPEFFECT_COPY_VSYNC,     D3D_OK},
        {TRUE,  2, D3DSWAPEFFECT_COPY_VSYNC,     D3DERR_INVALIDCALL},
        {FALSE, 2, D3DSWAPEFFECT_COPY_VSYNC,     D3DERR_INVALIDCALL},

        /* Ok with the others, in fullscreen and windowed mode. */
        {TRUE,  2, D3DSWAPEFFECT_DISCARD,        D3D_OK},
        {TRUE,  2, D3DSWAPEFFECT_FLIP,           D3D_OK},
        {FALSE, 2, D3DSWAPEFFECT_DISCARD,        D3D_OK},
        {FALSE, 2, D3DSWAPEFFECT_FLIP,           D3D_OK},

        /* Invalid swapeffects. */
        {TRUE,  1, D3DSWAPEFFECT_COPY_VSYNC + 1, D3DERR_INVALIDCALL},
        {FALSE, 1, D3DSWAPEFFECT_COPY_VSYNC + 1, D3DERR_INVALIDCALL},

        /* 3 is the highest allowed backbuffer count. */
        {TRUE,  3, D3DSWAPEFFECT_DISCARD,        D3D_OK},
        {TRUE,  4, D3DSWAPEFFECT_DISCARD,        D3DERR_INVALIDCALL},
        {TRUE,  4, D3DSWAPEFFECT_FLIP,           D3DERR_INVALIDCALL},
        {FALSE, 4, D3DSWAPEFFECT_DISCARD,        D3DERR_INVALIDCALL},
        {FALSE, 4, D3DSWAPEFFECT_FLIP,           D3DERR_INVALIDCALL},
    };

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }
    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get device caps, hr %#lx.\n", hr);
    IDirect3DDevice8_Release(device);

    present_parameters_windowed.BackBufferWidth = registry_mode.dmPelsWidth;
    present_parameters_windowed.BackBufferHeight = registry_mode.dmPelsHeight;
    present_parameters_windowed.hDeviceWindow = window;
    present_parameters_windowed.BackBufferFormat = D3DFMT_X8R8G8B8;
    present_parameters_windowed.SwapEffect = D3DSWAPEFFECT_COPY;
    present_parameters_windowed.Windowed = TRUE;
    present_parameters_windowed.BackBufferCount = 1;


    for (i = 0; i < ARRAY_SIZE(tests); ++i)
    {
        UINT bb_count = tests[i].backbuffer_count ? tests[i].backbuffer_count : 1;

        memset(&present_parameters, 0, sizeof(present_parameters));
        present_parameters.BackBufferWidth = registry_mode.dmPelsWidth;
        present_parameters.BackBufferHeight = registry_mode.dmPelsHeight;
        present_parameters.hDeviceWindow = NULL;
        present_parameters.BackBufferFormat = D3DFMT_X8R8G8B8;

        present_parameters.SwapEffect = tests[i].swap_effect;
        present_parameters.Windowed = tests[i].windowed;
        present_parameters.BackBufferCount = tests[i].backbuffer_count;

        hr = IDirect3D8_CreateDevice(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, window,
                D3DCREATE_SOFTWARE_VERTEXPROCESSING, &present_parameters, &device);
        ok(hr == tests[i].hr, "Expected hr %#lx, got %#lx, test %u.\n", tests[i].hr, hr, i);
        if (SUCCEEDED(hr))
        {
            for (j = 0; j < bb_count; ++j)
            {
                hr = IDirect3DDevice8_GetBackBuffer(device, j, D3DBACKBUFFER_TYPE_MONO, &backbuffer);
                ok(SUCCEEDED(hr), "Failed to get backbuffer %u, hr %#lx, test %u.\n", j, hr, i);
                IDirect3DSurface8_Release(backbuffer);
            }
            hr = IDirect3DDevice8_GetBackBuffer(device, j, D3DBACKBUFFER_TYPE_MONO, &backbuffer);
            ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx, test %u.\n", hr, i);

            IDirect3DDevice8_Release(device);
        }

        hr = IDirect3D8_CreateDevice(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, window,
                D3DCREATE_SOFTWARE_VERTEXPROCESSING, &present_parameters_windowed, &device);
        ok(SUCCEEDED(hr), "Failed to create device, hr %#lx, test %u.\n", hr, i);

        memset(&present_parameters, 0, sizeof(present_parameters));
        present_parameters.BackBufferWidth = registry_mode.dmPelsWidth;
        present_parameters.BackBufferHeight = registry_mode.dmPelsHeight;
        present_parameters.hDeviceWindow = NULL;
        present_parameters.BackBufferFormat = D3DFMT_X8R8G8B8;

        present_parameters.SwapEffect = tests[i].swap_effect;
        present_parameters.Windowed = tests[i].windowed;
        present_parameters.BackBufferCount = tests[i].backbuffer_count;

        hr = IDirect3DDevice8_Reset(device, &present_parameters);
        ok(hr == tests[i].hr, "Expected hr %#lx, got %#lx, test %u.\n", tests[i].hr, hr, i);

        if (FAILED(hr))
        {
            hr = IDirect3DDevice8_Reset(device, &present_parameters_windowed);
            ok(SUCCEEDED(hr), "Failed to reset device, hr %#lx, test %u.\n", hr, i);
        }
        else
        {
            for (j = 0; j < bb_count; ++j)
            {
                hr = IDirect3DDevice8_GetBackBuffer(device, j, D3DBACKBUFFER_TYPE_MONO, &backbuffer);
                todo_wine_if (j)
                    ok(SUCCEEDED(hr), "Failed to get backbuffer %u, hr %#lx, test %u.\n", j, hr, i);
                if (SUCCEEDED(hr))
                    IDirect3DSurface8_Release(backbuffer);
            }
            hr = IDirect3DDevice8_GetBackBuffer(device, j, D3DBACKBUFFER_TYPE_MONO, &backbuffer);
            ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx, test %u.\n", hr, i);
        }
        IDirect3DDevice8_Release(device);
    }

    for (i = 0; i < 10; ++i)
    {
        memset(&present_parameters, 0, sizeof(present_parameters));
        present_parameters.BackBufferWidth = registry_mode.dmPelsWidth;
        present_parameters.BackBufferHeight = registry_mode.dmPelsHeight;
        present_parameters.hDeviceWindow = window;
        present_parameters.BackBufferFormat = D3DFMT_X8R8G8B8;
        present_parameters.SwapEffect = D3DSWAPEFFECT_DISCARD;
        present_parameters.Windowed = FALSE;
        present_parameters.BackBufferCount = 2;

        present_parameters.FullScreen_PresentationInterval = i;
        switch (present_parameters.FullScreen_PresentationInterval)
        {
            case D3DPRESENT_INTERVAL_ONE:
            case D3DPRESENT_INTERVAL_TWO:
            case D3DPRESENT_INTERVAL_THREE:
            case D3DPRESENT_INTERVAL_FOUR:
                if (!(caps.PresentationIntervals & present_parameters.FullScreen_PresentationInterval))
                    continue;
                /* Fall through */
            case D3DPRESENT_INTERVAL_DEFAULT:
                expected_hr = D3D_OK;
                break;
            default:
                expected_hr = D3DERR_INVALIDCALL;
                break;
        }

        hr = IDirect3D8_CreateDevice(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, window,
                D3DCREATE_SOFTWARE_VERTEXPROCESSING, &present_parameters, &device);
        ok(hr == expected_hr, "Got unexpected hr %#lx, test %u.\n", hr, i);
        if (SUCCEEDED(hr))
            IDirect3DDevice8_Release(device);
    }

    memset(&present_parameters, 0, sizeof(present_parameters));
    present_parameters.SwapEffect = D3DSWAPEFFECT_DISCARD;
    present_parameters.Windowed = TRUE;
    present_parameters.BackBufferWidth  = 0;
    present_parameters.BackBufferHeight = 0;
    present_parameters.BackBufferFormat = D3DFMT_X8R8G8B8;

    hr = IDirect3D8_CreateDevice(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            window, D3DCREATE_SOFTWARE_VERTEXPROCESSING,
            &present_parameters, &device);

    ok(hr == S_OK, "Got unexpected hr %#lx.\n", hr);
    ok(!present_parameters.BackBufferWidth, "Got unexpected BackBufferWidth %u.\n", present_parameters.BackBufferWidth);
    ok(!present_parameters.BackBufferHeight, "Got unexpected BackBufferHeight %u,.\n", present_parameters.BackBufferHeight);
    ok(present_parameters.BackBufferFormat == D3DFMT_X8R8G8B8, "Got unexpected BackBufferFormat %#x.\n", present_parameters.BackBufferFormat);
    ok(present_parameters.BackBufferCount == 1, "Got unexpected BackBufferCount %u.\n", present_parameters.BackBufferCount);
    ok(!present_parameters.MultiSampleType, "Got unexpected MultiSampleType %u.\n", present_parameters.MultiSampleType);
    ok(present_parameters.SwapEffect == D3DSWAPEFFECT_DISCARD, "Got unexpected SwapEffect %#x.\n", present_parameters.SwapEffect);
    ok(!present_parameters.hDeviceWindow, "Got unexpected hDeviceWindow %p.\n", present_parameters.hDeviceWindow);
    ok(present_parameters.Windowed, "Got unexpected Windowed %#x.\n", present_parameters.Windowed);
    ok(!present_parameters.EnableAutoDepthStencil, "Got unexpected EnableAutoDepthStencil %#x.\n", present_parameters.EnableAutoDepthStencil);
    ok(!present_parameters.AutoDepthStencilFormat, "Got unexpected AutoDepthStencilFormat %#x.\n", present_parameters.AutoDepthStencilFormat);
    ok(!present_parameters.Flags, "Got unexpected Flags %#lx.\n", present_parameters.Flags);
    ok(!present_parameters.FullScreen_RefreshRateInHz, "Got unexpected FullScreen_RefreshRateInHz %u.\n", present_parameters.FullScreen_RefreshRateInHz);
    ok(!present_parameters.FullScreen_PresentationInterval, "Got unexpected FullScreen_PresentationInterval %#x.\n", present_parameters.FullScreen_PresentationInterval);

    IDirect3DDevice8_Release(device);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_check_device_format(void)
{
    D3DDEVTYPE device_type;
    IDirect3D8 *d3d;
    HRESULT hr;

    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");

    for (device_type = D3DDEVTYPE_HAL; device_type <= D3DDEVTYPE_SW; ++device_type)
    {
        hr = IDirect3D8_CheckDeviceFormat(d3d, 0, device_type, D3DFMT_UNKNOWN,
                0, D3DRTYPE_SURFACE, D3DFMT_A8R8G8B8);
        ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx, device type %#x.\n", hr, device_type);
        hr = IDirect3D8_CheckDeviceFormat(d3d, 0, device_type, D3DFMT_UNKNOWN,
                0, D3DRTYPE_TEXTURE, D3DFMT_A8R8G8B8);
        ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx, device type %#x.\n", hr, device_type);
        hr = IDirect3D8_CheckDeviceFormat(d3d, 0, device_type, D3DFMT_UNKNOWN,
                0, D3DRTYPE_SURFACE, D3DFMT_X8R8G8B8);
        ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx, device type %#x.\n", hr, device_type);
        hr = IDirect3D8_CheckDeviceFormat(d3d, 0, device_type, D3DFMT_UNKNOWN,
                0, D3DRTYPE_TEXTURE, D3DFMT_X8R8G8B8);
        ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx, device type %#x.\n", hr, device_type);
    }

    hr = IDirect3D8_CheckDeviceFormat(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, D3DFMT_A8R8G8B8,
            0, D3DRTYPE_TEXTURE, D3DFMT_X8R8G8B8);
    ok(hr == D3DERR_NOTAVAILABLE, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3D8_CheckDeviceFormat(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8,
            0, D3DRTYPE_TEXTURE, D3DFMT_X8R8G8B8);
    ok(hr == D3D_OK || hr == D3DERR_NOTAVAILABLE, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3D8_CheckDeviceFormat(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8,
            0, D3DRTYPE_VERTEXBUFFER, D3DFMT_VERTEXDATA);
    todo_wine ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3D8_CheckDeviceFormat(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8,
            0, D3DRTYPE_INDEXBUFFER, D3DFMT_VERTEXDATA);
    todo_wine ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3D8_CheckDeviceFormat(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8,
            0, D3DRTYPE_INDEXBUFFER, D3DFMT_INDEX16);
    todo_wine ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3D8_CheckDeviceFormat(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8,
            D3DUSAGE_SOFTWAREPROCESSING, D3DRTYPE_VERTEXBUFFER, D3DFMT_VERTEXDATA);
    todo_wine ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3D8_CheckDeviceFormat(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8,
            D3DUSAGE_SOFTWAREPROCESSING, D3DRTYPE_INDEXBUFFER, D3DFMT_VERTEXDATA);
    todo_wine ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3D8_CheckDeviceFormat(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8,
            D3DUSAGE_SOFTWAREPROCESSING, D3DRTYPE_INDEXBUFFER, D3DFMT_INDEX16);
    todo_wine ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3D8_CheckDepthStencilMatch(d3d, D3DADAPTER_DEFAULT,
            D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, D3DFMT_A8R8G8B8, D3DFMT_D32);
    ok(hr == D3DERR_NOTAVAILABLE || broken(hr == D3DERR_INVALIDCALL /* Windows 10 */),
            "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3D8_CheckDepthStencilMatch(d3d, D3DADAPTER_DEFAULT,
            D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, D3DFMT_R5G6B5, D3DFMT_D32);
    ok(hr == D3DERR_NOTAVAILABLE || broken(hr == D3DERR_INVALIDCALL /* Windows 10 */),
            "Got unexpected hr %#lx.\n", hr);

    IDirect3D8_Release(d3d);
}

static void test_miptree_layout(void)
{
    unsigned int pool_idx, format_idx, base_dimension, level_count, offset, i, j;
    IDirect3DCubeTexture8 *texture_cube;
    IDirect3DTexture8 *texture_2d;
    IDirect3DDevice8 *device;
    D3DLOCKED_RECT map_desc;
    BYTE *base = NULL;
    IDirect3D8 *d3d;
    D3DCAPS8 caps;
    UINT refcount;
    HWND window;
    HRESULT hr;

    static const struct
    {
        D3DFORMAT format;
        const char *name;
    }
    formats[] =
    {
        {D3DFMT_A8R8G8B8,             "D3DFMT_A8R8G8B8"},
        {D3DFMT_A8,                   "D3DFMT_A8"},
        {D3DFMT_L8,                   "D3DFMT_L8"},
        {MAKEFOURCC('A','T','I','1'), "D3DFMT_ATI1"},
        {MAKEFOURCC('A','T','I','2'), "D3DFMT_ATI2"},
    };
    static const struct
    {
        D3DPOOL pool;
        const char *name;
    }
    pools[] =
    {
        {D3DPOOL_MANAGED,   "D3DPOOL_MANAGED"},
        {D3DPOOL_SYSTEMMEM, "D3DPOOL_SYSTEMMEM"},
        {D3DPOOL_SCRATCH,   "D3DPOOL_SCRATCH"},
    };

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get caps, hr %#lx.\n", hr);

    base_dimension = 257;
    if (caps.TextureCaps & (D3DPTEXTURECAPS_POW2 | D3DPTEXTURECAPS_CUBEMAP_POW2))
    {
        skip("Using power of two base dimension.\n");
        base_dimension = 256;
    }

    for (format_idx = 0; format_idx < ARRAY_SIZE(formats); ++format_idx)
    {
        if (FAILED(hr = IDirect3D8_CheckDeviceFormat(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
                D3DFMT_X8R8G8B8, 0, D3DRTYPE_TEXTURE, formats[format_idx].format)))
        {
            skip("%s textures not supported, skipping tests.\n", formats[format_idx].name);
            continue;
        }

        for (pool_idx = 0; pool_idx < ARRAY_SIZE(pools); ++pool_idx)
        {
            hr = IDirect3DDevice8_CreateTexture(device, base_dimension, base_dimension, 0, 0,
                    formats[format_idx].format, pools[pool_idx].pool, &texture_2d);
            ok(SUCCEEDED(hr), "Failed to create a %s %s texture, hr %#lx.\n",
                    pools[pool_idx].name, formats[format_idx].name, hr);

            level_count = IDirect3DTexture8_GetLevelCount(texture_2d);
            for (i = 0, offset = 0; i < level_count; ++i)
            {
                hr = IDirect3DTexture8_LockRect(texture_2d, i, &map_desc, NULL, 0);
                ok(SUCCEEDED(hr), "%s, %s: Failed to lock level %u, hr %#lx.\n",
                        pools[pool_idx].name, formats[format_idx].name, i, hr);

                if (!i)
                    base = map_desc.pBits;
                else
                    ok(map_desc.pBits == base + offset,
                            "%s, %s, level %u: Got unexpected pBits %p, expected %p.\n",
                            pools[pool_idx].name, formats[format_idx].name, i, map_desc.pBits, base + offset);
                offset += (base_dimension >> i) * map_desc.Pitch;

                hr = IDirect3DTexture8_UnlockRect(texture_2d, i);
                ok(SUCCEEDED(hr), "%s, %s Failed to unlock level %u, hr %#lx.\n",
                        pools[pool_idx].name, formats[format_idx].name, i, hr);
            }

            IDirect3DTexture8_Release(texture_2d);
        }

        if (FAILED(hr = IDirect3D8_CheckDeviceFormat(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
                D3DFMT_X8R8G8B8, 0, D3DRTYPE_CUBETEXTURE, formats[format_idx].format)))
        {
            skip("%s cube textures not supported, skipping tests.\n", formats[format_idx].name);
            continue;
        }

        for (pool_idx = 0; pool_idx < ARRAY_SIZE(pools); ++pool_idx)
        {
            hr = IDirect3DDevice8_CreateCubeTexture(device, base_dimension, 0, 0,
                    formats[format_idx].format, pools[pool_idx].pool, &texture_cube);
            ok(SUCCEEDED(hr), "Failed to create a %s %s cube texture, hr %#lx.\n",
                    pools[pool_idx].name, formats[format_idx].name, hr);

            level_count = IDirect3DCubeTexture8_GetLevelCount(texture_cube);
            for (i = 0, offset = 0; i < 6; ++i)
            {
                for (j = 0; j < level_count; ++j)
                {
                    hr = IDirect3DCubeTexture8_LockRect(texture_cube, i, j, &map_desc, NULL, 0);
                    ok(SUCCEEDED(hr), "%s, %s: Failed to lock face %u, level %u, hr %#lx.\n",
                            pools[pool_idx].name, formats[format_idx].name, i, j, hr);

                    if (!i && !j)
                        base = map_desc.pBits;
                    else
                        ok(map_desc.pBits == base + offset,
                                "%s, %s, face %u, level %u: Got unexpected pBits %p, expected %p.\n",
                                pools[pool_idx].name, formats[format_idx].name, i, j, map_desc.pBits, base + offset);
                    offset += (base_dimension >> j) * map_desc.Pitch;

                    hr = IDirect3DCubeTexture8_UnlockRect(texture_cube, i, j);
                    ok(SUCCEEDED(hr), "%s, %s: Failed to unlock face %u, level %u, hr %#lx.\n",
                            pools[pool_idx].name, formats[format_idx].name, i, j, hr);
                }
                offset = (offset + 15) & ~15;
            }

            IDirect3DCubeTexture8_Release(texture_cube);
        }
    }

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %u references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_render_target_device_mismatch(void)
{
    IDirect3DDevice8 *device, *device2;
    IDirect3DSurface8 *surface, *rt;
    IDirect3D8 *d3d;
    UINT refcount;
    HWND window;
    HRESULT hr;

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, NULL)))
    {
        skip("Failed to create a D3D device.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_GetRenderTarget(device, &rt);
    ok(SUCCEEDED(hr), "Failed to get render target, hr %#lx.\n", hr);

    device2 = create_device(d3d, window, NULL);
    ok(!!device2, "Failed to create a D3D device.\n");

    hr = IDirect3DDevice8_CreateRenderTarget(device2, 640, 480,
            D3DFMT_A8R8G8B8, D3DMULTISAMPLE_NONE, FALSE, &surface);
    ok(SUCCEEDED(hr), "Failed to create render target, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderTarget(device, surface, NULL);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);

    IDirect3DSurface8_Release(surface);

    hr = IDirect3DDevice8_GetRenderTarget(device2, &surface);
    ok(SUCCEEDED(hr), "Failed to get render target, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderTarget(device, surface, NULL);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);

    IDirect3DSurface8_Release(surface);

    hr = IDirect3DDevice8_GetRenderTarget(device, &surface);
    ok(SUCCEEDED(hr), "Failed to get render target, hr %#lx.\n", hr);
    ok(surface == rt, "Got unexpected render target %p, expected %p.\n", surface, rt);
    IDirect3DSurface8_Release(surface);
    IDirect3DSurface8_Release(rt);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %u references left.\n", refcount);
    refcount = IDirect3DDevice8_Release(device2);
    ok(!refcount, "Device has %u references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_format_unknown(void)
{
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d;
    UINT refcount;
    HWND window;
    void *iface;
    HRESULT hr;

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, NULL)))
    {
        skip("Failed to create a D3D device.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    if (SUCCEEDED(IDirect3D8_CheckDeviceFormat(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            D3DFMT_X8R8G8B8, 0, D3DRTYPE_TEXTURE, D3DFMT_P8)))
    {
        skip("P8 textures are supported, skipping some tests.\n");
    }
    else
    {
        iface = (void *)0xdeadbeef;
        hr = IDirect3DDevice8_CreateRenderTarget(device, 64, 64,
                D3DFMT_P8, D3DMULTISAMPLE_NONE, FALSE, (IDirect3DSurface8 **)&iface);
        ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);
        ok(!iface, "Got unexpected iface %p.\n", iface);

        iface = (void *)0xdeadbeef;
        hr = IDirect3DDevice8_CreateDepthStencilSurface(device, 64, 64,
                D3DFMT_P8, D3DMULTISAMPLE_NONE, (IDirect3DSurface8 **)&iface);
        ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);
        ok(!iface, "Got unexpected iface %p.\n", iface);

        iface = (void *)0xdeadbeef;
        hr = IDirect3DDevice8_CreateTexture(device, 64, 64, 1, 0,
                D3DFMT_P8, D3DPOOL_DEFAULT, (IDirect3DTexture8 **)&iface);
        ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);
        ok(!iface, "Got unexpected iface %p.\n", iface);

        iface = (void *)0xdeadbeef;
        hr = IDirect3DDevice8_CreateCubeTexture(device, 64, 1, 0,
                D3DFMT_P8, D3DPOOL_DEFAULT, (IDirect3DCubeTexture8 **)&iface);
        ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);
        ok(!iface, "Got unexpected iface %p.\n", iface);

        iface = (void *)0xdeadbeef;
        hr = IDirect3DDevice8_CreateVolumeTexture(device, 64, 64, 1, 1, 0,
                D3DFMT_P8, D3DPOOL_DEFAULT, (IDirect3DVolumeTexture8 **)&iface);
        ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);
        ok(!iface, "Got unexpected iface %p.\n", iface);
    }

    iface = (void *)0xdeadbeef;
    hr = IDirect3DDevice8_CreateRenderTarget(device, 64, 64,
            D3DFMT_UNKNOWN, D3DMULTISAMPLE_NONE, FALSE, (IDirect3DSurface8 **)&iface);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);
    ok(iface == (void *)0xdeadbeef, "Got unexpected iface %p.\n", iface);

    iface = (void *)0xdeadbeef;
    hr = IDirect3DDevice8_CreateDepthStencilSurface(device, 64, 64,
            D3DFMT_UNKNOWN, D3DMULTISAMPLE_NONE, (IDirect3DSurface8 **)&iface);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);
    ok(iface == (void *)0xdeadbeef, "Got unexpected iface %p.\n", iface);

    iface = (void *)0xdeadbeef;
    hr = IDirect3DDevice8_CreateImageSurface(device, 64, 64,
            D3DFMT_UNKNOWN, (IDirect3DSurface8 **)&iface);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);
    ok(!iface, "Got unexpected iface %p.\n", iface);

    iface = (void *)0xdeadbeef;
    hr = IDirect3DDevice8_CreateTexture(device, 64, 64, 1, 0,
            D3DFMT_UNKNOWN, D3DPOOL_DEFAULT, (IDirect3DTexture8 **)&iface);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);
    ok(iface == (void *)0xdeadbeef, "Got unexpected iface %p.\n", iface);

    iface = (void *)0xdeadbeef;
    hr = IDirect3DDevice8_CreateCubeTexture(device, 64, 1, 0,
            D3DFMT_UNKNOWN, D3DPOOL_DEFAULT, (IDirect3DCubeTexture8 **)&iface);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);
    ok(iface == (void *)0xdeadbeef, "Got unexpected iface %p.\n", iface);

    iface = (void *)0xdeadbeef;
    hr = IDirect3DDevice8_CreateVolumeTexture(device, 64, 64, 1, 1, 0,
            D3DFMT_UNKNOWN, D3DPOOL_DEFAULT, (IDirect3DVolumeTexture8 **)&iface);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);
    ok(iface == (void *)0xdeadbeef, "Got unexpected iface %p.\n", iface);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %u references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_destroyed_window(void)
{
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d8;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    /* No WS_VISIBLE. */
    window = CreateWindowA("static", "d3d8_test", WS_OVERLAPPEDWINDOW,
            0, 0, 640, 480, NULL, NULL, NULL, NULL);
    ok(!!window, "Failed to create a window.\n");

    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");
    device = create_device(d3d8, window, NULL);
    IDirect3D8_Release(d3d8);
    DestroyWindow(window);
    if (!device)
    {
        skip("Failed to create a 3D device, skipping test.\n");
        return;
    }

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0x00000000, 0.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    todo_wine ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
}

static void test_lockable_backbuffer(void)
{
    D3DPRESENT_PARAMETERS present_parameters = {0};
    struct device_desc device_desc;
    IDirect3DSwapChain8 *swapchain;
    IDirect3DSurface8 *surface;
    IDirect3DDevice8 *device;
    D3DLOCKED_RECT lockrect;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");

    if (!(device = create_device(d3d, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_GetBackBuffer(device, 0, D3DBACKBUFFER_TYPE_MONO, &surface);
    ok(SUCCEEDED(hr), "Failed to get backbuffer, hr %#lx.\n", hr);

    hr = IDirect3DSurface8_LockRect(surface, &lockrect, NULL, D3DLOCK_READONLY);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);

    IDirect3DSurface8_Release(surface);

    /* Reset with D3DPRESENTFLAG_LOCKABLE_BACKBUFFER. */
    present_parameters.BackBufferWidth = 640;
    present_parameters.BackBufferHeight = 480;
    present_parameters.BackBufferFormat = D3DFMT_A8R8G8B8;
    present_parameters.SwapEffect = D3DSWAPEFFECT_DISCARD;
    present_parameters.hDeviceWindow = window;
    present_parameters.Windowed = TRUE;
    present_parameters.EnableAutoDepthStencil = TRUE;
    present_parameters.AutoDepthStencilFormat = D3DFMT_D24S8;
    present_parameters.Flags = D3DPRESENTFLAG_LOCKABLE_BACKBUFFER;

    hr = IDirect3DDevice8_Reset(device, &present_parameters);
    ok(SUCCEEDED(hr), "Failed to reset device, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetBackBuffer(device, 0, D3DBACKBUFFER_TYPE_MONO, &surface);
    ok(SUCCEEDED(hr), "Failed to get backbuffer, hr %#lx.\n", hr);

    hr = IDirect3DSurface8_LockRect(surface, &lockrect, NULL, D3DLOCK_READONLY);
    ok(SUCCEEDED(hr), "Failed to lock rect, hr %#lx.\n", hr);
    hr = IDirect3DSurface8_UnlockRect(surface);
    ok(SUCCEEDED(hr), "Failed to unlock rect, hr %#lx.\n", hr);

    IDirect3DSurface8_Release(surface);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);

    device_desc.adapter_ordinal = D3DADAPTER_DEFAULT;
    device_desc.width = 640;
    device_desc.height = 480;
    device_desc.device_window = window;
    device_desc.flags = CREATE_DEVICE_LOCKABLE_BACKBUFFER;

    device = create_device(d3d, window, &device_desc);
    ok(!!device, "Failed to create device.\n");

    hr = IDirect3DDevice8_GetBackBuffer(device, 0, D3DBACKBUFFER_TYPE_MONO, &surface);
    ok(SUCCEEDED(hr), "Failed to get backbuffer, hr %#lx.\n", hr);

    hr = IDirect3DSurface8_LockRect(surface, &lockrect, NULL, D3DLOCK_READONLY);
    ok(SUCCEEDED(hr), "Failed to lock rect, hr %#lx.\n", hr);
    hr = IDirect3DSurface8_UnlockRect(surface);
    ok(SUCCEEDED(hr), "Failed to unlock rect, hr %#lx.\n", hr);

    IDirect3DSurface8_Release(surface);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);

    if (SUCCEEDED(IDirect3D8_CheckDeviceMultiSampleType(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            D3DFMT_A8R8G8B8, TRUE, D3DMULTISAMPLE_4_SAMPLES)))
    {
        /* Multisampling is allowed. */
        present_parameters.MultiSampleType = D3DMULTISAMPLE_4_SAMPLES;
        hr = IDirect3D8_CreateDevice(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, window,
                D3DCREATE_SOFTWARE_VERTEXPROCESSING, &present_parameters, &device);
        ok(hr == D3D_OK, "Failed to create device, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_GetBackBuffer(device, 0, D3DBACKBUFFER_TYPE_MONO, &surface);
        ok(hr == D3D_OK, "Failed to get backbuffer, hr %#lx.\n", hr);

        /* But locking multisampled is not allowed. */
        hr = IDirect3DSurface8_LockRect(surface, &lockrect, NULL, D3DLOCK_READONLY);
        ok(hr == D3DERR_INVALIDCALL, "Unexpected hr %#lx.\n", hr);

        IDirect3DSurface8_Release(surface);

        present_parameters.hDeviceWindow = NULL;
        hr = IDirect3DDevice8_CreateAdditionalSwapChain(device, &present_parameters, &swapchain);
        ok(hr == D3D_OK, "Failed to create swapchain, hr %#lx.\n", hr);

        hr = IDirect3DSwapChain8_GetBackBuffer(swapchain, 0, 0, &surface);
        ok(hr == D3D_OK, "Failed to get backbuffer, hr %#lx.\n", hr);

        hr = IDirect3DSurface8_LockRect(surface, &lockrect, NULL, D3DLOCK_READONLY);
        ok(hr == D3DERR_INVALIDCALL, "Unexpected hr %#lx.\n", hr);

        IDirect3DSurface8_Release(surface);
        IDirect3DSwapChain8_Release(swapchain);

        IDirect3DDevice8_Release(device);
    }
    else
    {
        skip("Multisampling not supported for D3DFMT_A8R8G8B8.\n");
    }

    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_clip_planes_limits(void)
{
    static const DWORD device_flags[] = {0, CREATE_DEVICE_SWVP_ONLY};
    IDirect3DDevice8 *device;
    struct device_desc desc;
    unsigned int i, j;
    IDirect3D8 *d3d;
    ULONG refcount;
    float plane[4];
    D3DCAPS8 caps;
    DWORD state;
    HWND window;
    HRESULT hr;

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");

    for (i = 0; i < ARRAY_SIZE(device_flags); ++i)
    {
        desc.adapter_ordinal = D3DADAPTER_DEFAULT;
        desc.device_window = window;
        desc.width = 640;
        desc.height = 480;
        desc.flags = device_flags[i];
        if (!(device = create_device(d3d, window, &desc)))
        {
            skip("Failed to create D3D device, flags %#lx.\n", desc.flags);
            continue;
        }

        memset(&caps, 0, sizeof(caps));
        hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
        ok(hr == D3D_OK, "Failed to get caps, hr %#lx.\n", hr);

        trace("Max user clip planes: %lu.\n", caps.MaxUserClipPlanes);

        for (j = 0; j < caps.MaxUserClipPlanes; ++j)
        {
            memset(plane, 0xff, sizeof(plane));
            hr = IDirect3DDevice8_GetClipPlane(device, j, plane);
            ok(hr == D3D_OK, "Failed to get clip plane %u, hr %#lx.\n", j, hr);
            ok(!plane[0] && !plane[1] && !plane[2] && !plane[3],
                    "Got unexpected plane %u: %.8e, %.8e, %.8e, %.8e.\n",
                    j, plane[0], plane[1], plane[2], plane[3]);
        }

        plane[0] = 2.0f;
        plane[1] = 8.0f;
        plane[2] = 5.0f;
        for (j = 0; j < caps.MaxUserClipPlanes; ++j)
        {
            plane[3] = j;
            hr = IDirect3DDevice8_SetClipPlane(device, j, plane);
            ok(hr == D3D_OK, "Failed to set clip plane %u, hr %#lx.\n", j, hr);
        }
        for (j = 0; j < caps.MaxUserClipPlanes; ++j)
        {
            memset(plane, 0xff, sizeof(plane));
            hr = IDirect3DDevice8_GetClipPlane(device, j, plane);
            ok(hr == D3D_OK, "Failed to get clip plane %u, hr %#lx.\n", j, hr);
            ok(plane[0] == 2.0f && plane[1] == 8.0f && plane[2] == 5.0f && plane[3] == j,
                    "Got unexpected plane %u: %.8e, %.8e, %.8e, %.8e.\n",
                    j, plane[0], plane[1], plane[2], plane[3]);
        }

        hr = IDirect3DDevice8_SetRenderState(device, D3DRS_CLIPPLANEENABLE, 0xffffffff);
        ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_GetRenderState(device, D3DRS_CLIPPLANEENABLE, &state);
        ok(SUCCEEDED(hr), "Failed to get render state, hr %#lx.\n", hr);
        ok(state == 0xffffffff, "Got unexpected state %#lx.\n", state);
        hr = IDirect3DDevice8_SetRenderState(device, D3DRS_CLIPPLANEENABLE, 0x80000000);
        ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_GetRenderState(device, D3DRS_CLIPPLANEENABLE, &state);
        ok(SUCCEEDED(hr), "Failed to get render state, hr %#lx.\n", hr);
        ok(state == 0x80000000, "Got unexpected state %#lx.\n", state);

        refcount = IDirect3DDevice8_Release(device);
        ok(!refcount, "Device has %lu references left.\n", refcount);
    }

    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_swapchain_multisample_reset(void)
{
    D3DPRESENT_PARAMETERS present_parameters;
    IDirect3DSurface8 *surface;
    IDirect3DDevice8 *device;
    D3DLOCKED_RECT lr;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    window = create_window();
    ok(!!window, "Failed to create a window.\n");
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create D3D object.\n");

    if (IDirect3D8_CheckDeviceMultiSampleType(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            D3DFMT_A8R8G8B8, TRUE, D3DMULTISAMPLE_2_SAMPLES) == D3DERR_NOTAVAILABLE)
    {
        skip("Multisampling not supported for D3DFMT_A8R8G8B8.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    if (!(device = create_device(d3d, window, NULL)))
    {
        skip("Failed to create 3D device.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0xffffffff, 1.0f, 0);
    ok(hr == D3D_OK, "Failed to clear, hr %#lx.\n", hr);

    memset(&present_parameters, 0, sizeof(present_parameters));
    present_parameters.BackBufferWidth = 640;
    present_parameters.BackBufferHeight = 480;
    present_parameters.BackBufferFormat = D3DFMT_A8R8G8B8;
    present_parameters.SwapEffect = D3DSWAPEFFECT_DISCARD;
    present_parameters.hDeviceWindow = NULL;
    present_parameters.Windowed = TRUE;
    present_parameters.MultiSampleType = D3DMULTISAMPLE_2_SAMPLES;
    hr = IDirect3DDevice8_Reset(device, &present_parameters);
    ok(hr == D3D_OK, "Failed to reset device, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xffffffff, 0.0f, 0);
    ok(hr == D3D_OK, "Failed to clear, hr %#lx.\n", hr);

    /* Lockable back buffer flag is allowed. */
    present_parameters.Flags = D3DPRESENTFLAG_LOCKABLE_BACKBUFFER;
    hr = IDirect3DDevice8_Reset(device, &present_parameters);
    ok(hr == D3D_OK, "Failed to reset device, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetBackBuffer(device, 0, D3DBACKBUFFER_TYPE_MONO, &surface);
    ok(hr == D3D_OK, "Failed to get backbuffer, hr %#lx.\n", hr);

    /* But locking is not allowed. */
    hr = IDirect3DSurface8_LockRect(surface, &lr, NULL, 0);
    ok(hr == D3DERR_INVALIDCALL, "Unexpected hr %#lx.\n", hr);

    IDirect3DSurface8_Release(surface);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_device_caps(void)
{
    unsigned int adapter_idx, adapter_count;
    struct device_desc device_desc;
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d;
    ULONG refcount;
    D3DCAPS8 caps;
    HWND window;
    HRESULT hr;

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");

    device_desc.device_window = window;
    device_desc.width = 640;
    device_desc.height = 480;
    device_desc.flags = 0;

    adapter_count = IDirect3D8_GetAdapterCount(d3d);
    for (adapter_idx = 0; adapter_idx < adapter_count; ++adapter_idx)
    {
        /* Test IDirect3D8_GetDeviceCaps */
        hr = IDirect3D8_GetDeviceCaps(d3d, adapter_idx, D3DDEVTYPE_HAL, &caps);
        ok(hr == D3D_OK || hr == D3DERR_NOTAVAILABLE, "Adapter %u: GetDeviceCaps failed, hr %#lx.\n",
                adapter_idx, hr);
        if (hr == D3DERR_NOTAVAILABLE)
        {
            skip("Adapter %u: No Direct3D support, skipping test.\n", adapter_idx);
            break;
        }
        ok(caps.AdapterOrdinal == adapter_idx, "Adapter %u: Got unexpected adapter ordinal %u.\n",
                adapter_idx, caps.AdapterOrdinal);

        /* Test IDirect3DDevice8_GetDeviceCaps */
        device_desc.adapter_ordinal = adapter_idx;
        device = create_device(d3d, window, &device_desc);
        if (!device)
        {
            skip("Adapter %u: Failed to create a D3D device, skipping test.\n", adapter_idx);
            break;
        }
        hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
        ok(SUCCEEDED(hr), "Adapter %u: Failed to get caps, hr %#lx.\n", adapter_idx, hr);

        ok(caps.AdapterOrdinal == adapter_idx, "Adapter %u: Got unexpected adapter ordinal %u.\n",
                adapter_idx, caps.AdapterOrdinal);
        ok(!(caps.Caps & ~D3DCAPS_READ_SCANLINE),
                "Adapter %u: Caps field has unexpected flags %#lx.\n", adapter_idx, caps.Caps);
        ok(!(caps.Caps2 & ~(D3DCAPS2_CANCALIBRATEGAMMA | D3DCAPS2_CANRENDERWINDOWED
                | D3DCAPS2_CANMANAGERESOURCE | D3DCAPS2_DYNAMICTEXTURES | D3DCAPS2_FULLSCREENGAMMA
                | D3DCAPS2_NO2DDURING3DSCENE | D3DCAPS2_RESERVED)),
                "Adapter %u: Caps2 field has unexpected flags %#lx.\n", adapter_idx, caps.Caps2);
        /* Nvidia returns that 0x400 flag, which is probably Vista+
         * D3DCAPS3_DXVAHD from d3d9caps.h */
        /* AMD doesn't filter all the ddraw / d3d9 caps. Consider that behavior
         * broken. */
        ok(!(caps.Caps3 & ~(D3DCAPS3_ALPHA_FULLSCREEN_FLIP_OR_DISCARD | D3DCAPS3_RESERVED | 0x400))
                || broken(!(caps.Caps3 & ~(D3DCAPS3_ALPHA_FULLSCREEN_FLIP_OR_DISCARD | 0x80))),
                "Adapter %u: Caps3 field has unexpected flags %#lx.\n", adapter_idx, caps.Caps3);
        ok(!(caps.PrimitiveMiscCaps & ~(D3DPMISCCAPS_MASKZ | D3DPMISCCAPS_LINEPATTERNREP
                | D3DPMISCCAPS_CULLNONE | D3DPMISCCAPS_CULLCW | D3DPMISCCAPS_CULLCCW
                | D3DPMISCCAPS_COLORWRITEENABLE | D3DPMISCCAPS_CLIPPLANESCALEDPOINTS
                | D3DPMISCCAPS_CLIPTLVERTS | D3DPMISCCAPS_TSSARGTEMP | D3DPMISCCAPS_BLENDOP
                | D3DPMISCCAPS_NULLREFERENCE))
                || broken(!(caps.PrimitiveMiscCaps & ~0x003fdff6)),
                "Adapter %u: PrimitiveMiscCaps field has unexpected flags %#lx.\n", adapter_idx,
                caps.PrimitiveMiscCaps);
        /* AMD includes an unknown 0x2 flag. */
        ok(!(caps.RasterCaps & ~(D3DPRASTERCAPS_DITHER | D3DPRASTERCAPS_PAT | D3DPRASTERCAPS_ZTEST
                | D3DPRASTERCAPS_FOGVERTEX | D3DPRASTERCAPS_FOGTABLE | D3DPRASTERCAPS_ANTIALIASEDGES
                | D3DPRASTERCAPS_MIPMAPLODBIAS | D3DPRASTERCAPS_ZBIAS | D3DPRASTERCAPS_ZBUFFERLESSHSR
                | D3DPRASTERCAPS_FOGRANGE | D3DPRASTERCAPS_ANISOTROPY | D3DPRASTERCAPS_WBUFFER
                | D3DPRASTERCAPS_WFOG | D3DPRASTERCAPS_ZFOG | D3DPRASTERCAPS_COLORPERSPECTIVE
                | D3DPRASTERCAPS_STRETCHBLTMULTISAMPLE))
                || broken(!(caps.RasterCaps & ~0x0ff7f19b)),
                "Adapter %u: RasterCaps field has unexpected flags %#lx.\n", adapter_idx,
                caps.RasterCaps);
        ok(!(caps.SrcBlendCaps & ~(D3DPBLENDCAPS_ZERO | D3DPBLENDCAPS_ONE | D3DPBLENDCAPS_SRCCOLOR
                | D3DPBLENDCAPS_INVSRCCOLOR | D3DPBLENDCAPS_SRCALPHA | D3DPBLENDCAPS_INVSRCALPHA
                | D3DPBLENDCAPS_DESTALPHA | D3DPBLENDCAPS_INVDESTALPHA | D3DPBLENDCAPS_DESTCOLOR
                | D3DPBLENDCAPS_INVDESTCOLOR | D3DPBLENDCAPS_SRCALPHASAT | D3DPBLENDCAPS_BOTHSRCALPHA
                | D3DPBLENDCAPS_BOTHINVSRCALPHA)),
                "Adapter %u: SrcBlendCaps field has unexpected flags %#lx.\n", adapter_idx,
                caps.SrcBlendCaps);
        ok(!(caps.DestBlendCaps & ~(D3DPBLENDCAPS_ZERO | D3DPBLENDCAPS_ONE | D3DPBLENDCAPS_SRCCOLOR
                | D3DPBLENDCAPS_INVSRCCOLOR | D3DPBLENDCAPS_SRCALPHA | D3DPBLENDCAPS_INVSRCALPHA
                | D3DPBLENDCAPS_DESTALPHA | D3DPBLENDCAPS_INVDESTALPHA | D3DPBLENDCAPS_DESTCOLOR
                | D3DPBLENDCAPS_INVDESTCOLOR | D3DPBLENDCAPS_SRCALPHASAT | D3DPBLENDCAPS_BOTHSRCALPHA
                | D3DPBLENDCAPS_BOTHINVSRCALPHA)),
                "Adapter %u: DestBlendCaps field has unexpected flags %#lx.\n", adapter_idx,
                caps.DestBlendCaps);
        ok(!(caps.TextureCaps & ~(D3DPTEXTURECAPS_PERSPECTIVE | D3DPTEXTURECAPS_POW2
                | D3DPTEXTURECAPS_ALPHA | D3DPTEXTURECAPS_SQUAREONLY
                | D3DPTEXTURECAPS_TEXREPEATNOTSCALEDBYSIZE | D3DPTEXTURECAPS_ALPHAPALETTE
                | D3DPTEXTURECAPS_NONPOW2CONDITIONAL | D3DPTEXTURECAPS_PROJECTED
                | D3DPTEXTURECAPS_CUBEMAP | D3DPTEXTURECAPS_VOLUMEMAP | D3DPTEXTURECAPS_MIPMAP
                | D3DPTEXTURECAPS_MIPVOLUMEMAP | D3DPTEXTURECAPS_MIPCUBEMAP
                | D3DPTEXTURECAPS_CUBEMAP_POW2 | D3DPTEXTURECAPS_VOLUMEMAP_POW2)),
                "Adapter %u: TextureCaps field has unexpected flags %#lx.\n", adapter_idx,
                caps.TextureCaps);
        ok(!(caps.TextureFilterCaps & ~(D3DPTFILTERCAPS_MINFPOINT | D3DPTFILTERCAPS_MINFLINEAR
                | D3DPTFILTERCAPS_MINFANISOTROPIC | D3DPTFILTERCAPS_MIPFPOINT
                | D3DPTFILTERCAPS_MIPFLINEAR | D3DPTFILTERCAPS_MAGFPOINT | D3DPTFILTERCAPS_MAGFLINEAR
                | D3DPTFILTERCAPS_MAGFANISOTROPIC | D3DPTFILTERCAPS_MAGFAFLATCUBIC
                | D3DPTFILTERCAPS_MAGFGAUSSIANCUBIC))
                || broken(!(caps.TextureFilterCaps & ~0x0703073f)),
                "Adapter %u: TextureFilterCaps field has unexpected flags %#lx.\n", adapter_idx,
                caps.TextureFilterCaps);
        ok(!(caps.CubeTextureFilterCaps & ~(D3DPTFILTERCAPS_MINFPOINT | D3DPTFILTERCAPS_MINFLINEAR
                | D3DPTFILTERCAPS_MINFANISOTROPIC | D3DPTFILTERCAPS_MIPFPOINT
                | D3DPTFILTERCAPS_MIPFLINEAR | D3DPTFILTERCAPS_MAGFPOINT | D3DPTFILTERCAPS_MAGFLINEAR
                | D3DPTFILTERCAPS_MAGFANISOTROPIC | D3DPTFILTERCAPS_MAGFAFLATCUBIC
                | D3DPTFILTERCAPS_MAGFGAUSSIANCUBIC)),
                "Adapter %u: CubeTextureFilterCaps field has unexpected flags %#lx.\n", adapter_idx,
                caps.CubeTextureFilterCaps);
        ok(!(caps.VolumeTextureFilterCaps & ~(D3DPTFILTERCAPS_MINFPOINT | D3DPTFILTERCAPS_MINFLINEAR
                | D3DPTFILTERCAPS_MINFANISOTROPIC | D3DPTFILTERCAPS_MIPFPOINT
                | D3DPTFILTERCAPS_MIPFLINEAR | D3DPTFILTERCAPS_MAGFPOINT | D3DPTFILTERCAPS_MAGFLINEAR
                | D3DPTFILTERCAPS_MAGFANISOTROPIC | D3DPTFILTERCAPS_MAGFAFLATCUBIC
                | D3DPTFILTERCAPS_MAGFGAUSSIANCUBIC)),
                "Adapter %u: VolumeTextureFilterCaps field has unexpected flags %#lx.\n",
                adapter_idx, caps.VolumeTextureFilterCaps);
        ok(!(caps.LineCaps & ~(D3DLINECAPS_TEXTURE | D3DLINECAPS_ZTEST | D3DLINECAPS_BLEND
                | D3DLINECAPS_ALPHACMP | D3DLINECAPS_FOG)),
                "Adapter %u: LineCaps field has unexpected flags %#lx.\n", adapter_idx,
                caps.LineCaps);
        ok(!(caps.StencilCaps & ~(D3DSTENCILCAPS_KEEP | D3DSTENCILCAPS_ZERO | D3DSTENCILCAPS_REPLACE
                | D3DSTENCILCAPS_INCRSAT | D3DSTENCILCAPS_DECRSAT | D3DSTENCILCAPS_INVERT
                | D3DSTENCILCAPS_INCR | D3DSTENCILCAPS_DECR)),
                "Adapter %u: StencilCaps field has unexpected flags %#lx.\n", adapter_idx,
                caps.StencilCaps);
        ok(!(caps.VertexProcessingCaps & ~(D3DVTXPCAPS_TEXGEN | D3DVTXPCAPS_MATERIALSOURCE7
                | D3DVTXPCAPS_DIRECTIONALLIGHTS | D3DVTXPCAPS_POSITIONALLIGHTS | D3DVTXPCAPS_LOCALVIEWER
                | D3DVTXPCAPS_TWEENING | D3DVTXPCAPS_NO_VSDT_UBYTE4)),
                "Adapter %u: VertexProcessingCaps field has unexpected flags %#lx.\n", adapter_idx,
                caps.VertexProcessingCaps);
        /* Both Nvidia and AMD give 10 here. */
        ok(caps.MaxActiveLights <= 10,
                "Adapter %u: MaxActiveLights field has unexpected value %lu.\n", adapter_idx,
                caps.MaxActiveLights);
        /* AMD gives 6, Nvidia returns 8. */
        ok(caps.MaxUserClipPlanes <= 8,
                "Adapter %u: MaxUserClipPlanes field has unexpected value %lu.\n", adapter_idx,
                caps.MaxUserClipPlanes);
        ok(caps.MaxVertexW == 0.0f || caps.MaxVertexW >= 1e10f,
                "Adapter %u: MaxVertexW field has unexpected value %.8e.\n", adapter_idx,
                caps.MaxVertexW);

        refcount = IDirect3DDevice8_Release(device);
        ok(!refcount, "Adapter %u: Device has %lu references left.\n", adapter_idx, refcount);
    }
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_get_info(void)
{
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d;
    BYTE info[1024];
    ULONG refcount;
    unsigned int i;
    HWND window;
    HRESULT hr;

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, NULL)))
    {
        skip("Failed to create a D3D device.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    /* As called by Chessmaster 9000 (bug 42118). */
    hr = IDirect3DDevice8_GetInfo(device, 4, info, 16);
    ok(hr == S_FALSE, "Unexpected hr %#lx.\n", hr);

    for (i = 0; i < 256; ++i)
    {
        hr = IDirect3DDevice8_GetInfo(device, i, info, sizeof(info));
        if (i <= 4)
            ok(hr == (i < 4 ? E_FAIL : S_FALSE), "info_id %u, unexpected hr %#lx.\n", i, hr);
        else
            ok(hr == E_FAIL || hr == S_FALSE, "info_id %u, unexpected hr %#lx.\n", i, hr);
    }

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_resource_access(void)
{
    IDirect3DSurface8 *backbuffer, *depth_stencil;
    D3DFORMAT colour_format, depth_format, format;
    BOOL depth_2d, depth_cube, depth_plain;
    D3DADAPTER_IDENTIFIER8 identifier;
    struct device_desc device_desc;
    D3DSURFACE_DESC surface_desc;
    BOOL skip_ati2n_once = FALSE;
    IDirect3DDevice8 *device;
    unsigned int i, j;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;
    BOOL warp;

    enum surface_type
    {
        SURFACE_2D,
        SURFACE_CUBE,
        SURFACE_RT,
        SURFACE_DS,
        SURFACE_IMAGE,
    };

    enum resource_format
    {
        FORMAT_COLOUR,
        FORMAT_ATI2,
        FORMAT_DEPTH,
    };

    static const struct
    {
        D3DPOOL pool;
        enum resource_format format;
        DWORD usage;
        BOOL valid;
    }
    tests[] =
    {
        /* 0 */
        {D3DPOOL_DEFAULT,   FORMAT_COLOUR, 0,                                        TRUE},
        {D3DPOOL_DEFAULT,   FORMAT_ATI2,   0,                                        TRUE},
        {D3DPOOL_DEFAULT,   FORMAT_DEPTH,  0,                                        TRUE},
        {D3DPOOL_DEFAULT,   FORMAT_COLOUR, D3DUSAGE_RENDERTARGET,                    TRUE},
        {D3DPOOL_DEFAULT,   FORMAT_DEPTH,  D3DUSAGE_RENDERTARGET,                    FALSE},
        {D3DPOOL_DEFAULT,   FORMAT_COLOUR, D3DUSAGE_DEPTHSTENCIL,                    FALSE},
        {D3DPOOL_DEFAULT,   FORMAT_DEPTH,  D3DUSAGE_DEPTHSTENCIL,                    TRUE},
        /* 7 */
        {D3DPOOL_DEFAULT,   FORMAT_COLOUR, D3DUSAGE_DYNAMIC,                         TRUE},
        {D3DPOOL_DEFAULT,   FORMAT_ATI2,   D3DUSAGE_DYNAMIC,                         TRUE},
        {D3DPOOL_DEFAULT,   FORMAT_DEPTH,  D3DUSAGE_DYNAMIC,                         TRUE},
        {D3DPOOL_DEFAULT,   FORMAT_COLOUR, D3DUSAGE_DYNAMIC | D3DUSAGE_RENDERTARGET, FALSE},
        {D3DPOOL_DEFAULT,   FORMAT_DEPTH,  D3DUSAGE_DYNAMIC | D3DUSAGE_RENDERTARGET, FALSE},
        {D3DPOOL_DEFAULT,   FORMAT_COLOUR, D3DUSAGE_DYNAMIC | D3DUSAGE_DEPTHSTENCIL, FALSE},
        {D3DPOOL_DEFAULT,   FORMAT_DEPTH,  D3DUSAGE_DYNAMIC | D3DUSAGE_DEPTHSTENCIL, FALSE},
        /* 14 */
        {D3DPOOL_MANAGED,   FORMAT_COLOUR, 0,                                        TRUE},
        {D3DPOOL_MANAGED,   FORMAT_ATI2,   0,                                        TRUE},
        {D3DPOOL_MANAGED,   FORMAT_DEPTH,  0,                                        FALSE},
        {D3DPOOL_MANAGED,   FORMAT_COLOUR, D3DUSAGE_RENDERTARGET,                    FALSE},
        {D3DPOOL_MANAGED,   FORMAT_DEPTH,  D3DUSAGE_RENDERTARGET,                    FALSE},
        {D3DPOOL_MANAGED,   FORMAT_COLOUR, D3DUSAGE_DEPTHSTENCIL,                    FALSE},
        {D3DPOOL_MANAGED,   FORMAT_DEPTH,  D3DUSAGE_DEPTHSTENCIL,                    FALSE},
        /* 21 */
        {D3DPOOL_SYSTEMMEM, FORMAT_COLOUR, 0,                                        TRUE},
        {D3DPOOL_SYSTEMMEM, FORMAT_ATI2,   0,                                        TRUE},
        {D3DPOOL_SYSTEMMEM, FORMAT_DEPTH,  0,                                        FALSE},
        {D3DPOOL_SYSTEMMEM, FORMAT_COLOUR, D3DUSAGE_RENDERTARGET,                    FALSE},
        {D3DPOOL_SYSTEMMEM, FORMAT_DEPTH,  D3DUSAGE_RENDERTARGET,                    FALSE},
        {D3DPOOL_SYSTEMMEM, FORMAT_COLOUR, D3DUSAGE_DEPTHSTENCIL,                    FALSE},
        {D3DPOOL_SYSTEMMEM, FORMAT_DEPTH,  D3DUSAGE_DEPTHSTENCIL,                    FALSE},
        /* 28 */
        {D3DPOOL_SCRATCH,   FORMAT_COLOUR, 0,                                        TRUE},
        {D3DPOOL_SCRATCH,   FORMAT_ATI2,   0,                                        TRUE},
        {D3DPOOL_SCRATCH,   FORMAT_DEPTH,  0,                                        FALSE},
        {D3DPOOL_SCRATCH,   FORMAT_COLOUR, D3DUSAGE_RENDERTARGET,                    FALSE},
        {D3DPOOL_SCRATCH,   FORMAT_DEPTH,  D3DUSAGE_RENDERTARGET,                    FALSE},
        {D3DPOOL_SCRATCH,   FORMAT_COLOUR, D3DUSAGE_DEPTHSTENCIL,                    FALSE},
        {D3DPOOL_SCRATCH,   FORMAT_DEPTH,  D3DUSAGE_DEPTHSTENCIL,                    FALSE},
    };
    static const struct
    {
        const char *name;
        enum surface_type type;
    }
    surface_types[] =
    {
        {"2D", SURFACE_2D},
        {"CUBE", SURFACE_CUBE},
        {"RT", SURFACE_RT},
        {"DS", SURFACE_DS},
        {"IMAGE", SURFACE_IMAGE},
    };

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    hr = IDirect3D8_GetAdapterIdentifier(d3d, D3DADAPTER_DEFAULT, 0, &identifier);
    ok(SUCCEEDED(hr), "Failed to get adapter identifier, hr %#lx.\n", hr);
    warp = adapter_is_warp(&identifier);

    device_desc.adapter_ordinal = D3DADAPTER_DEFAULT;
    device_desc.device_window = window;
    device_desc.width = 16;
    device_desc.height = 16;
    device_desc.flags = 0;
    if (!(device = create_device(d3d, window, &device_desc)))
    {
        skip("Failed to create a D3D device.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_GetBackBuffer(device, 0, D3DBACKBUFFER_TYPE_MONO, &backbuffer);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DSurface8_GetDesc(backbuffer, &surface_desc);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    colour_format = surface_desc.Format;

    hr = IDirect3DDevice8_GetDepthStencilSurface(device, &depth_stencil);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DSurface8_GetDesc(depth_stencil, &surface_desc);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    depth_format = surface_desc.Format;

    depth_2d = SUCCEEDED(IDirect3D8_CheckDeviceFormat(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            D3DFMT_X8R8G8B8, 0, D3DRTYPE_TEXTURE, depth_format));
    depth_cube = SUCCEEDED(IDirect3D8_CheckDeviceFormat(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            D3DFMT_X8R8G8B8, 0, D3DRTYPE_CUBETEXTURE, depth_format));
    depth_plain = SUCCEEDED(IDirect3D8_CheckDeviceFormat(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            D3DFMT_X8R8G8B8, 0, D3DRTYPE_SURFACE, depth_format));

    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZRHW);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    for (i = 0; i < ARRAY_SIZE(surface_types); ++i)
    {
        for (j = 0; j < ARRAY_SIZE(tests); ++j)
        {
            IDirect3DCubeTexture8 *texture_cube;
            IDirect3DBaseTexture8 *texture;
            IDirect3DTexture8 *texture_2d;
            IDirect3DSurface8 *surface;
            HRESULT expected_hr;
            D3DLOCKED_RECT lr;

            if (tests[j].format == FORMAT_ATI2)
                format = MAKEFOURCC('A','T','I','2');
            else if (tests[j].format == FORMAT_DEPTH)
                format = depth_format;
            else
                format = colour_format;

            if (tests[j].format == FORMAT_ATI2 && FAILED(IDirect3D8_CheckDeviceFormat(d3d, D3DADAPTER_DEFAULT,
                    D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 0, D3DRTYPE_TEXTURE, format)))
            {
                if (!skip_ati2n_once)
                {
                    skip("ATI2N texture not supported.\n");
                    skip_ati2n_once = TRUE;
                }
                continue;
            }

            switch (surface_types[i].type)
            {
                case SURFACE_2D:
                    hr = IDirect3DDevice8_CreateTexture(device, 16, 16, 1,
                            tests[j].usage, format, tests[j].pool, &texture_2d);
                    todo_wine_if(!tests[j].valid && tests[j].format == FORMAT_DEPTH && !tests[j].usage)
                        ok(hr == (tests[j].valid && (tests[j].format != FORMAT_DEPTH || depth_2d)
                                ? D3D_OK : D3DERR_INVALIDCALL),
                                "Test %s %u: Got unexpected hr %#lx.\n", surface_types[i].name, j, hr);
                    if (FAILED(hr))
                        continue;

                    hr = IDirect3DTexture8_GetSurfaceLevel(texture_2d, 0, &surface);
                    ok(hr == D3D_OK, "Test %s %u: Got unexpected hr %#lx.\n", surface_types[i].name, j, hr);
                    IDirect3DTexture8_Release(texture_2d);
                    break;

                case SURFACE_CUBE:
                    hr = IDirect3DDevice8_CreateCubeTexture(device, 16, 1,
                            tests[j].usage, format, tests[j].pool, &texture_cube);
                    todo_wine_if(!tests[j].valid && tests[j].format == FORMAT_DEPTH && !tests[j].usage)
                        ok(hr == (tests[j].valid && (tests[j].format != FORMAT_DEPTH || depth_cube)
                                ? D3D_OK : D3DERR_INVALIDCALL),
                                "Test %s %u: Got unexpected hr %#lx.\n", surface_types[i].name, j, hr);
                    if (FAILED(hr))
                        continue;

                    hr = IDirect3DCubeTexture8_GetCubeMapSurface(texture_cube,
                            D3DCUBEMAP_FACE_POSITIVE_X, 0, &surface);
                    ok(hr == D3D_OK, "Test %s %u: Got unexpected hr %#lx.\n", surface_types[i].name, j, hr);
                    IDirect3DCubeTexture8_Release(texture_cube);
                    break;

                case SURFACE_RT:
                    hr = IDirect3DDevice8_CreateRenderTarget(device, 16, 16, format,
                            D3DMULTISAMPLE_NONE, tests[j].usage & D3DUSAGE_DYNAMIC, &surface);
                    ok(hr == (tests[j].format == FORMAT_COLOUR ? D3D_OK : D3DERR_INVALIDCALL),
                            "Test %s %u: Got unexpected hr %#lx.\n", surface_types[i].name, j, hr);
                    if (FAILED(hr))
                        continue;
                    break;

                case SURFACE_DS:
                    if (tests[j].format == FORMAT_ATI2 && broken(1))
                    {
                        /* The Nvidia Windows driver crashes when attempting to create a ATI2N
                         * depth stencil surface.
                         *
                         * Interestingly this crash does not happen in the d3d9 version of this
                         * test. */
                        continue;
                    }
                    hr = IDirect3DDevice8_CreateDepthStencilSurface(device,
                            16, 16, format, D3DMULTISAMPLE_NONE, &surface);
                    todo_wine_if(tests[j].format == FORMAT_ATI2)
                        ok(hr == (tests[j].format == FORMAT_DEPTH ? D3D_OK
                                : tests[j].format == FORMAT_COLOUR ? D3DERR_INVALIDCALL : E_INVALIDARG)
                                || (tests[j].format == FORMAT_ATI2 && hr == D3D_OK),
                                "Test %s %u: Got unexpected hr %#lx.\n", surface_types[i].name, j, hr);
                    if (FAILED(hr))
                        continue;
                    break;

                case SURFACE_IMAGE:
                    hr = IDirect3DDevice8_CreateImageSurface(device, 16, 16, format, &surface);
                    ok(hr == ((tests[j].format != FORMAT_DEPTH || depth_plain) ? D3D_OK : D3DERR_INVALIDCALL),
                            "Test %s %u: Got unexpected hr %#lx.\n", surface_types[i].name, j, hr);
                    if (FAILED(hr))
                        continue;
                    break;

                default:
                    ok(0, "Invalid surface type %#x.\n", surface_types[i].type);
                    continue;
            }

            hr = IDirect3DSurface8_GetDesc(surface, &surface_desc);
            ok(hr == D3D_OK, "Test %s %u: Got unexpected hr %#lx.\n", surface_types[i].name, j, hr);
            if (surface_types[i].type == SURFACE_RT)
            {
                ok(surface_desc.Usage == D3DUSAGE_RENDERTARGET, "Test %s %u: Got unexpected usage %#lx.\n",
                        surface_types[i].name, j, surface_desc.Usage);
                ok(surface_desc.Pool == D3DPOOL_DEFAULT, "Test %s %u: Got unexpected pool %#x.\n",
                        surface_types[i].name, j, surface_desc.Pool);
            }
            else if (surface_types[i].type == SURFACE_DS)
            {
                ok(surface_desc.Usage == D3DUSAGE_DEPTHSTENCIL, "Test %s %u: Got unexpected usage %#lx.\n",
                        surface_types[i].name, j, surface_desc.Usage);
                ok(surface_desc.Pool == D3DPOOL_DEFAULT, "Test %s %u: Got unexpected pool %#x.\n",
                        surface_types[i].name, j, surface_desc.Pool);
            }
            else if (surface_types[i].type == SURFACE_IMAGE)
            {
                ok(!surface_desc.Usage, "Test %s %u: Got unexpected usage %#lx.\n",
                        surface_types[i].name, j, surface_desc.Usage);
                ok(surface_desc.Pool == D3DPOOL_SYSTEMMEM, "Test %s %u: Got unexpected pool %#x.\n",
                        surface_types[i].name, j, surface_desc.Pool);
            }
            else
            {
                ok(surface_desc.Usage == tests[j].usage, "Test %s %u: Got unexpected usage %#lx.\n",
                        surface_types[i].name, j, surface_desc.Usage);
                ok(surface_desc.Pool == tests[j].pool, "Test %s %u: Got unexpected pool %#x.\n",
                        surface_types[i].name, j, surface_desc.Pool);
            }

            hr = IDirect3DSurface8_LockRect(surface, &lr, NULL, 0);
            if (surface_desc.Pool != D3DPOOL_DEFAULT || surface_desc.Usage & D3DUSAGE_DYNAMIC
                    || (surface_types[i].type == SURFACE_RT && tests[j].usage & D3DUSAGE_DYNAMIC)
                    || surface_types[i].type == SURFACE_IMAGE
                    || tests[j].format == FORMAT_ATI2)
                expected_hr = D3D_OK;
            else
                expected_hr = D3DERR_INVALIDCALL;
            ok(hr == expected_hr, "Test %s %u: Got unexpected hr %#lx.\n", surface_types[i].name, j, hr);
            hr = IDirect3DSurface8_UnlockRect(surface);
            todo_wine_if(expected_hr != D3D_OK && surface_types[i].type == SURFACE_2D)
                ok(hr == expected_hr, "Test %s %u: Got unexpected hr %#lx.\n", surface_types[i].name, j, hr);

            if (SUCCEEDED(IDirect3DSurface8_GetContainer(surface, &IID_IDirect3DBaseTexture8, (void **)&texture)))
            {
                hr = IDirect3DDevice8_SetTexture(device, 0, texture);
                ok(hr == D3D_OK, "Test %s %u: Got unexpected hr %#lx.\n", surface_types[i].name, j, hr);
                hr = IDirect3DDevice8_SetTexture(device, 0, NULL);
                ok(hr == D3D_OK, "Test %s %u: Got unexpected hr %#lx.\n", surface_types[i].name, j, hr);
                IDirect3DBaseTexture8_Release(texture);
            }

            hr = IDirect3DDevice8_SetRenderTarget(device, surface, depth_stencil);
            ok(hr == (surface_desc.Usage & D3DUSAGE_RENDERTARGET ? D3D_OK : D3DERR_INVALIDCALL),
                    "Test %s %u: Got unexpected hr %#lx.\n", surface_types[i].name, j, hr);
            hr = IDirect3DDevice8_SetRenderTarget(device, backbuffer, depth_stencil);
            ok(hr == D3D_OK, "Test %s %u: Got unexpected hr %#lx.\n", surface_types[i].name, j, hr);

            hr = IDirect3DDevice8_SetRenderTarget(device, backbuffer, surface);
            ok(hr == (surface_desc.Usage & D3DUSAGE_DEPTHSTENCIL ? D3D_OK : D3DERR_INVALIDCALL),
                    "Test %s %u: Got unexpected hr %#lx.\n", surface_types[i].name, j, hr);
            hr = IDirect3DDevice8_SetRenderTarget(device, backbuffer, depth_stencil);
            ok(hr == D3D_OK, "Test %s %u: Got unexpected hr %#lx.\n", surface_types[i].name, j, hr);

            IDirect3DSurface8_Release(surface);
        }
    }

    for (i = 0; i < ARRAY_SIZE(tests); ++i)
    {
        IDirect3DVolumeTexture8 *texture;
        D3DVOLUME_DESC volume_desc;
        IDirect3DVolume8 *volume;
        HRESULT expected_hr;
        D3DLOCKED_BOX lb;

        if (tests[i].format == FORMAT_DEPTH)
            continue;

        if (tests[i].format == FORMAT_ATI2)
            format = MAKEFOURCC('A','T','I','2');
        else
            format = colour_format;

        if (tests[i].format == FORMAT_ATI2 && FAILED(IDirect3D8_CheckDeviceFormat(d3d, D3DADAPTER_DEFAULT,
                D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 0, D3DRTYPE_VOLUMETEXTURE, format)))
        {
            if (!skip_ati2n_once)
            {
                skip("ATI2N volume texture not supported.\n");
                skip_ati2n_once = TRUE;
            }
            continue;
        }

        hr = IDirect3DDevice8_CreateVolumeTexture(device, 16, 16, 1, 1,
                tests[i].usage, format, tests[i].pool, &texture);
        ok((hr == ((!(tests[i].usage & ~D3DUSAGE_DYNAMIC) && tests[i].format != FORMAT_ATI2)
                || (tests[i].pool == D3DPOOL_SCRATCH && !tests[i].usage)
                ? D3D_OK : D3DERR_INVALIDCALL))
                || (tests[i].format == FORMAT_ATI2 && (hr == D3D_OK || warp)),
                "Test %u: Got unexpected hr %#lx.\n", i, hr);
        if (FAILED(hr))
            continue;

        hr = IDirect3DVolumeTexture8_GetVolumeLevel(texture, 0, &volume);
        ok(hr == D3D_OK, "Test %u: Got unexpected hr %#lx.\n", i, hr);

        hr = IDirect3DVolume8_GetDesc(volume, &volume_desc);
        ok(hr == D3D_OK, "Test %u: Got unexpected hr %#lx.\n", i, hr);
        ok(volume_desc.Usage == tests[i].usage, "Test %u: Got unexpected usage %#lx.\n", i, volume_desc.Usage);
        ok(volume_desc.Pool == tests[i].pool, "Test %u: Got unexpected pool %#x.\n", i, volume_desc.Pool);

        hr = IDirect3DVolume8_LockBox(volume, &lb, NULL, 0);
        if (volume_desc.Pool != D3DPOOL_DEFAULT || volume_desc.Usage & D3DUSAGE_DYNAMIC)
            expected_hr = D3D_OK;
        else
            expected_hr = D3DERR_INVALIDCALL;
        ok(hr == expected_hr || (volume_desc.Pool == D3DPOOL_DEFAULT && hr == D3D_OK),
                "Test %u: Got unexpected hr %#lx.\n", i, hr);
        hr = IDirect3DVolume8_UnlockBox(volume);
        ok(hr == expected_hr || (volume_desc.Pool == D3DPOOL_DEFAULT && hr == D3D_OK),
                "Test %u: Got unexpected hr %#lx.\n", i, hr);

        hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *)texture);
        ok(hr == D3D_OK, "Test %u: Got unexpected hr %#lx.\n", i, hr);
        hr = IDirect3DDevice8_SetTexture(device, 0, NULL);
        ok(hr == D3D_OK, "Test %u: Got unexpected hr %#lx.\n", i, hr);

        IDirect3DVolume8_Release(volume);
        IDirect3DVolumeTexture8_Release(texture);
    }

    for (i = 0; i < ARRAY_SIZE(tests); ++i)
    {
        D3DINDEXBUFFER_DESC ib_desc;
        IDirect3DIndexBuffer8 *ib;
        BYTE *data;

        hr = IDirect3DDevice8_CreateIndexBuffer(device, 16, tests[i].usage,
                tests[i].format == FORMAT_COLOUR ? D3DFMT_INDEX32 : D3DFMT_INDEX16, tests[i].pool, &ib);
        ok(hr == (tests[i].pool == D3DPOOL_SCRATCH || (tests[i].usage & ~D3DUSAGE_DYNAMIC)
                ? D3DERR_INVALIDCALL : D3D_OK), "Test %u: Got unexpected hr %#lx.\n", i, hr);
        if (FAILED(hr))
            continue;

        hr = IDirect3DIndexBuffer8_GetDesc(ib, &ib_desc);
        ok(hr == D3D_OK, "Test %u: Got unexpected hr %#lx.\n", i, hr);
        ok(ib_desc.Usage == tests[i].usage, "Test %u: Got unexpected usage %#lx.\n", i, ib_desc.Usage);
        ok(ib_desc.Pool == tests[i].pool, "Test %u: Got unexpected pool %#x.\n", i, ib_desc.Pool);

        hr = IDirect3DIndexBuffer8_Lock(ib, 0, 0, &data, 0);
        ok(hr == D3D_OK, "Test %u: Got unexpected hr %#lx.\n", i, hr);
        hr = IDirect3DIndexBuffer8_Unlock(ib);
        ok(hr == D3D_OK, "Test %u: Got unexpected hr %#lx.\n", i, hr);

        hr = IDirect3DDevice8_SetIndices(device, ib, 0);
        ok(hr == D3D_OK, "Test %u: Got unexpected hr %#lx.\n", i, hr);
        hr = IDirect3DDevice8_SetIndices(device, NULL, 0);
        ok(hr == D3D_OK, "Test %u: Got unexpected hr %#lx.\n", i, hr);

        IDirect3DIndexBuffer8_Release(ib);
    }

    for (i = 0; i < ARRAY_SIZE(tests); ++i)
    {
        D3DVERTEXBUFFER_DESC vb_desc;
        IDirect3DVertexBuffer8 *vb;
        BYTE *data;

        hr = IDirect3DDevice8_CreateVertexBuffer(device, 16, tests[i].usage,
                tests[i].format == FORMAT_COLOUR ? 0 : D3DFVF_XYZRHW, tests[i].pool, &vb);
        ok(hr == (tests[i].pool == D3DPOOL_SCRATCH || (tests[i].usage & ~D3DUSAGE_DYNAMIC)
                ? D3DERR_INVALIDCALL : D3D_OK), "Test %u: Got unexpected hr %#lx.\n", i, hr);
        if (FAILED(hr))
            continue;

        hr = IDirect3DVertexBuffer8_GetDesc(vb, &vb_desc);
        ok(hr == D3D_OK, "Test %u: Got unexpected hr %#lx.\n", i, hr);
        ok(vb_desc.Usage == tests[i].usage, "Test %u: Got unexpected usage %#lx.\n", i, vb_desc.Usage);
        ok(vb_desc.Pool == tests[i].pool, "Test %u: Got unexpected pool %#x.\n", i, vb_desc.Pool);

        hr = IDirect3DVertexBuffer8_Lock(vb, 0, 0, &data, 0);
        ok(hr == D3D_OK, "Test %u: Got unexpected hr %#lx.\n", i, hr);
        hr = IDirect3DVertexBuffer8_Unlock(vb);
        ok(hr == D3D_OK, "Test %u: Got unexpected hr %#lx.\n", i, hr);

        hr = IDirect3DDevice8_SetStreamSource(device, 0, vb, 16);
        ok(hr == D3D_OK, "Test %u: Got unexpected hr %#lx.\n", i, hr);
        hr = IDirect3DDevice8_SetStreamSource(device, 0, NULL, 0);
        ok(hr == D3D_OK, "Test %u: Got unexpected hr %#lx.\n", i, hr);

        IDirect3DVertexBuffer8_Release(vb);
    }

    IDirect3DSurface8_Release(depth_stencil);
    IDirect3DSurface8_Release(backbuffer);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_multiply_transform(void)
{
    IDirect3DDevice8 *device;
    D3DMATRIX ret_mat;
    DWORD stateblock;
    IDirect3D8 *d3d;
    unsigned int i;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    static const D3DTRANSFORMSTATETYPE tests[] =
    {
        D3DTS_VIEW,
        D3DTS_PROJECTION,
        D3DTS_TEXTURE0,
        D3DTS_TEXTURE1,
        D3DTS_TEXTURE2,
        D3DTS_TEXTURE3,
        D3DTS_TEXTURE4,
        D3DTS_TEXTURE5,
        D3DTS_TEXTURE6,
        D3DTS_TEXTURE7,
        D3DTS_WORLDMATRIX(0),
        D3DTS_WORLDMATRIX(1),
        D3DTS_WORLDMATRIX(2),
        D3DTS_WORLDMATRIX(3),
        D3DTS_WORLDMATRIX(255),
    };

    static const D3DMATRIX mat1 =
    {{{
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f,
    }}},
    mat2 =
    {{{
        2.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 2.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 2.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 2.0f,
    }}};

    window = create_window();
    ok(!!window, "Failed to create a window.\n");
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create D3D object.\n");

    if (!(device = create_device(d3d, window, NULL)))
    {
        skip("Failed to create 3D device.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    for (i = 0; i < ARRAY_SIZE(tests); ++i)
    {
        hr = IDirect3DDevice8_GetTransform(device, tests[i], &ret_mat);
        ok(hr == D3D_OK, "Test %u: Got unexpected hr %#lx.\n", i, hr);
        ok(!memcmp(&ret_mat, &mat1, sizeof(mat1)), "Test %u: Got unexpected transform matrix.\n", i);

        hr = IDirect3DDevice8_MultiplyTransform(device, tests[i], &mat2);
        ok(hr == D3D_OK, "Test %u: Got unexpected hr %#lx.\n", i, hr);

        hr = IDirect3DDevice8_GetTransform(device, tests[i], &ret_mat);
        ok(hr == D3D_OK, "Test %u: Got unexpected hr %#lx.\n", i, hr);
        ok(!memcmp(&ret_mat, &mat2, sizeof(mat2)), "Test %u: Got unexpected transform matrix.\n", i);

        /* MultiplyTransform() goes directly into the primary stateblock. */

        hr = IDirect3DDevice8_SetTransform(device, tests[i], &mat1);
        ok(hr == D3D_OK, "Test %u: Got unexpected hr %#lx.\n", i, hr);

        hr = IDirect3DDevice8_BeginStateBlock(device);
        ok(hr == D3D_OK, "Test %u: Got unexpected hr %#lx.\n", i, hr);

        hr = IDirect3DDevice8_MultiplyTransform(device, tests[i], &mat2);
        ok(hr == D3D_OK, "Test %u: Got unexpected hr %#lx.\n", i, hr);

        hr = IDirect3DDevice8_EndStateBlock(device, &stateblock);
        ok(hr == D3D_OK, "Test %u: Got unexpected hr %#lx.\n", i, hr);

        hr = IDirect3DDevice8_GetTransform(device, tests[i], &ret_mat);
        ok(hr == D3D_OK, "Test %u: Got unexpected hr %#lx.\n", i, hr);
        ok(!memcmp(&ret_mat, &mat2, sizeof(mat2)), "Test %u: Got unexpected transform matrix.\n", i);

        hr = IDirect3DDevice8_CaptureStateBlock(device, stateblock);
        ok(hr == D3D_OK, "Test %u: Got unexpected hr %#lx.\n", i, hr);

        hr = IDirect3DDevice8_SetTransform(device, tests[i], &mat1);
        ok(hr == D3D_OK, "Test %u: Got unexpected hr %#lx.\n", i, hr);

        hr = IDirect3DDevice8_ApplyStateBlock(device, stateblock);
        ok(hr == D3D_OK, "Test %u: Got unexpected hr %#lx.\n", i, hr);

        hr = IDirect3DDevice8_GetTransform(device, tests[i], &ret_mat);
        ok(hr == D3D_OK, "Test %u: Got unexpected hr %#lx.\n", i, hr);
        ok(!memcmp(&ret_mat, &mat1, sizeof(mat1)), "Test %u: Got unexpected transform matrix.\n", i);

        IDirect3DDevice8_DeleteStateBlock(device, stateblock);
    }

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_draw_primitive(void)
{
    static const struct
    {
        float position[3];
        DWORD color;
    }
    quad[] =
    {
        {{-1.0f, -1.0f, 0.0f}, 0xffff0000},
        {{-1.0f,  1.0f, 0.0f}, 0xffff0000},
        {{ 1.0f,  1.0f, 0.0f}, 0xffff0000},
        {{ 1.0f, -1.0f, 0.0f}, 0xffff0000},
        {{-1.0f, -1.0f, 0.0f}, 0xffff0000},
        {{-1.0f, -1.0f, 0.0f}, 0xffff0000},
    };
    static const WORD indices[] = {0, 1, 2, 3, 0, 2};

    IDirect3DVertexBuffer8 *vertex_buffer, *current_vb;
    IDirect3DIndexBuffer8 *index_buffer, *current_ib;
    UINT stride, base_vertex_index;
    IDirect3DDevice8 *device;
    DWORD stateblock;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;
    BYTE *ptr;

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, NULL)))
    {
        skip("Failed to create a D3D device.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_CreateVertexBuffer(device, sizeof(quad), 0, 0,
            D3DPOOL_DEFAULT, &vertex_buffer);
    ok(SUCCEEDED(hr), "CreateVertexBuffer failed, hr %#lx.\n", hr);
    hr = IDirect3DVertexBuffer8_Lock(vertex_buffer, 0, 0, &ptr, D3DLOCK_DISCARD);
    ok(SUCCEEDED(hr), "Lock failed, hr %#lx.\n", hr);
    memcpy(ptr, quad, sizeof(quad));
    hr = IDirect3DVertexBuffer8_Unlock(vertex_buffer);
    ok(SUCCEEDED(hr), "Unlock failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetStreamSource(device, 0, vertex_buffer, sizeof(*quad));
    ok(SUCCEEDED(hr), "SetStreamSource failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_DIFFUSE);
    ok(SUCCEEDED(hr), "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CreateIndexBuffer(device, sizeof(indices), 0, D3DFMT_INDEX16,
            D3DPOOL_DEFAULT, &index_buffer);
    ok(SUCCEEDED(hr), "CreateIndexBuffer failed, hr %#lx.\n", hr);
    hr = IDirect3DIndexBuffer8_Lock(index_buffer, 0, 0, &ptr, D3DLOCK_DISCARD);
    ok(SUCCEEDED(hr), "Lock failed, hr %#lx.\n", hr);
    memcpy(ptr, indices, sizeof(indices));
    hr = IDirect3DIndexBuffer8_Unlock(index_buffer);
    ok(SUCCEEDED(hr), "Unlock failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(SUCCEEDED(hr), "SetRenderState D3DRS_LIGHTING failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "BeginScene failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_DrawPrimitive(device, D3DPT_TRIANGLELIST, 0, 2);
    ok(SUCCEEDED(hr), "DrawPrimitive failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetStreamSource(device, 0, &current_vb, &stride);
    ok(SUCCEEDED(hr), "GetStreamSource failed, hr %#lx.\n", hr);
    ok(current_vb == vertex_buffer, "Unexpected vb %p.\n", current_vb);
    ok(stride == sizeof(*quad), "Unexpected stride %u.\n", stride);
    IDirect3DVertexBuffer8_Release(current_vb);

    /* Crashes on r200, Windows XP with STATUS_INTEGER_DIVIDE_BY_ZERO. */
    if (0)
    {
        hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLELIST, 0, quad, 0);
        ok(hr == D3D_OK, "DrawPrimitiveUP failed, hr %#lx.\n", hr);
    }
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLELIST, 0, quad, sizeof(*quad));
    ok(hr == D3D_OK, "DrawPrimitiveUP failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLELIST, 2, quad, sizeof(*quad));
    ok(SUCCEEDED(hr), "DrawPrimitiveUP failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetStreamSource(device, 0, &current_vb, &stride);
    ok(SUCCEEDED(hr), "GetStreamSource failed, hr %#lx.\n", hr);
    ok(!current_vb, "Unexpected vb %p.\n", current_vb);
    ok(!stride, "Unexpected stride %u.\n", stride);

    /* NULL index buffer, NULL stream source. */
    hr = IDirect3DDevice8_SetIndices(device, NULL, 0);
    ok(SUCCEEDED(hr), "SetIndices failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawIndexedPrimitive(device, D3DPT_TRIANGLELIST, 0, 4, 0, 2);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    /* Valid index buffer, NULL stream source. */
    hr = IDirect3DDevice8_SetIndices(device, index_buffer, 1);
    ok(SUCCEEDED(hr), "SetIndices failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawIndexedPrimitive(device, D3DPT_TRIANGLELIST, 0, 4, 0, 2);
    ok(SUCCEEDED(hr), "DrawIndexedPrimitive failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetIndices(device, &current_ib, &base_vertex_index);
    ok(SUCCEEDED(hr), "GetIndices failed, hr %#lx.\n", hr);
    ok(current_ib == index_buffer, "Unexpected index buffer %p.\n", current_ib);
    ok(base_vertex_index == 1, "Unexpected base vertex index %u.\n", base_vertex_index);
    IDirect3DIndexBuffer8_Release(current_ib);

    /* Crashes on r200, Windows XP with STATUS_INTEGER_DIVIDE_BY_ZERO. */
    if (0)
    {
        hr = IDirect3DDevice8_DrawIndexedPrimitiveUP(device, D3DPT_TRIANGLELIST, 0, 4, 0,
                indices, D3DFMT_INDEX16, quad, 0);
        ok(SUCCEEDED(hr), "DrawIndexedPrimitiveUP failed, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_DrawIndexedPrimitiveUP(device, D3DPT_TRIANGLELIST, 0, 4, 2,
                indices, D3DFMT_INDEX16, quad, 0);
        ok(SUCCEEDED(hr), "DrawIndexedPrimitiveUP failed, hr %#lx.\n", hr);
    }

    hr = IDirect3DDevice8_DrawIndexedPrimitiveUP(device, D3DPT_TRIANGLELIST, 0, 4, 2,
            indices, D3DFMT_INDEX16, quad, sizeof(*quad));
    ok(SUCCEEDED(hr), "DrawIndexedPrimitiveUP failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetIndices(device, &current_ib, &base_vertex_index);
    ok(SUCCEEDED(hr), "GetIndices failed, hr %#lx.\n", hr);
    ok(!current_ib, "Unexpected index buffer %p.\n", current_ib);
    ok(!base_vertex_index, "Unexpected base vertex index %u.\n", base_vertex_index);

    /* Resetting of stream source and index buffer is not recorded in stateblocks. */

    hr = IDirect3DDevice8_SetStreamSource(device, 0, vertex_buffer, sizeof(*quad));
    ok(SUCCEEDED(hr), "SetStreamSource failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetIndices(device, index_buffer, 1);
    ok(SUCCEEDED(hr), "SetIndices failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginStateBlock(device);
    ok(SUCCEEDED(hr), "BeginStateBlock failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_DrawIndexedPrimitiveUP(device, D3DPT_TRIANGLELIST, 0, 4, 2,
            indices, D3DFMT_INDEX16, quad, sizeof(*quad));
    ok(SUCCEEDED(hr), "DrawIndexedPrimitiveUP failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_EndStateBlock(device, &stateblock);
    ok(SUCCEEDED(hr), "BeginStateBlock failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetStreamSource(device, 0, &current_vb, &stride);
    ok(SUCCEEDED(hr), "GetStreamSource failed, hr %#lx.\n", hr);
    ok(!current_vb, "Unexpected vb %p.\n", current_vb);
    ok(!stride, "Unexpected stride %u.\n", stride);
    hr = IDirect3DDevice8_GetIndices(device, &current_ib, &base_vertex_index);
    ok(SUCCEEDED(hr), "GetIndices failed, hr %#lx.\n", hr);
    ok(!current_ib, "Unexpected index buffer %p.\n", current_ib);
    ok(!base_vertex_index, "Unexpected base vertex index %u.\n", base_vertex_index);

    hr = IDirect3DDevice8_CaptureStateBlock(device, stateblock);
    ok(SUCCEEDED(hr), "Capture failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetStreamSource(device, 0, vertex_buffer, sizeof(*quad));
    ok(SUCCEEDED(hr), "SetStreamSource failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetIndices(device, index_buffer, 1);
    ok(SUCCEEDED(hr), "SetIndices failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_ApplyStateBlock(device, stateblock);
    ok(SUCCEEDED(hr), "Apply failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetStreamSource(device, 0, &current_vb, &stride);
    ok(SUCCEEDED(hr), "GetStreamSource failed, hr %#lx.\n", hr);
    ok(current_vb == vertex_buffer, "Unexpected vb %p.\n", current_vb);
    ok(stride == sizeof(*quad), "Unexpected stride %u.\n", stride);
    IDirect3DVertexBuffer8_Release(current_vb);
    hr = IDirect3DDevice8_GetIndices(device, &current_ib, &base_vertex_index);
    ok(SUCCEEDED(hr), "GetIndices failed, hr %#lx.\n", hr);
    ok(current_ib == index_buffer, "Unexpected index buffer %p.\n", current_ib);
    ok(base_vertex_index == 1, "Unexpected base vertex index %u.\n", base_vertex_index);
    IDirect3DIndexBuffer8_Release(current_ib);

    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "EndScene failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Present failed, hr %#lx.\n", hr);

    IDirect3DDevice8_DeleteStateBlock(device, stateblock);
    IDirect3DVertexBuffer8_Release(vertex_buffer);
    IDirect3DIndexBuffer8_Release(index_buffer);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_get_display_mode(void)
{
    static const DWORD creation_flags[] = {0, CREATE_DEVICE_FULLSCREEN};
    unsigned int adapter_idx, adapter_count, mode_idx, test_idx;
    RECT previous_monitor_rect;
    unsigned int width, height;
    IDirect3DDevice8 *device;
    MONITORINFO monitor_info;
    struct device_desc desc;
    D3DDISPLAYMODE mode;
    HMONITOR monitor;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;
    BOOL ret;

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");

    if (!(device = create_device(d3d, window, NULL)))
    {
        skip("Failed to create a D3D device.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_GetDisplayMode(device, &mode);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    ok(mode.Format == D3DFMT_X8R8G8B8, "Unexpected format %#x.\n", mode.Format);
    hr = IDirect3D8_GetAdapterDisplayMode(d3d, D3DADAPTER_DEFAULT, &mode);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    ok(mode.Format == D3DFMT_X8R8G8B8, "Unexpected format %#x.\n", mode.Format);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);

    desc.adapter_ordinal = D3DADAPTER_DEFAULT;
    desc.device_window = window;
    desc.width = 640;
    desc.height = 480;
    desc.flags = CREATE_DEVICE_FULLSCREEN;
    if (!(device = create_device(d3d, window, &desc)))
    {
        skip("Failed to create a D3D device.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_GetDisplayMode(device, &mode);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    ok(mode.Width == 640, "Unexpected width %u.\n", mode.Width);
    ok(mode.Height == 480, "Unexpected width %u.\n", mode.Height);
    ok(mode.Format == D3DFMT_X8R8G8B8, "Unexpected format %#x.\n", mode.Format);
    hr = IDirect3D8_GetAdapterDisplayMode(d3d, D3DADAPTER_DEFAULT, &mode);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    ok(mode.Width == 640, "Unexpected width %u.\n", mode.Width);
    ok(mode.Height == 480, "Unexpected width %u.\n", mode.Height);
    ok(mode.Format == D3DFMT_X8R8G8B8, "Unexpected format %#x.\n", mode.Format);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    DestroyWindow(window);

    /* D3D8 uses adapter indices to determine which adapter to use to get the display mode */
    adapter_count = IDirect3D8_GetAdapterCount(d3d);
    for (adapter_idx = 0; adapter_idx < adapter_count; ++adapter_idx)
    {
        if (!adapter_idx)
        {
            desc.width = 640;
            desc.height = 480;
        }
        else
        {
            /* Find a mode different than that of the previous adapter, so that tests can be sure
             * that they are comparing to the current adapter display mode */
            monitor = IDirect3D8_GetAdapterMonitor(d3d, adapter_idx - 1);
            ok(!!monitor, "Adapter %u: GetAdapterMonitor failed.\n", adapter_idx - 1);
            monitor_info.cbSize = sizeof(monitor_info);
            ret = GetMonitorInfoW(monitor, &monitor_info);
            ok(ret, "Adapter %u: GetMonitorInfoW failed, error %#lx.\n", adapter_idx - 1,
                    GetLastError());
            previous_monitor_rect = monitor_info.rcMonitor;

            desc.width = monitor_info.rcMonitor.right - monitor_info.rcMonitor.left;
            desc.height = monitor_info.rcMonitor.bottom - monitor_info.rcMonitor.top;
            for (mode_idx = 0; SUCCEEDED(IDirect3D8_EnumAdapterModes(d3d, adapter_idx, mode_idx,
                    &mode)); ++mode_idx)
            {
                if (mode.Format != D3DFMT_X8R8G8B8)
                    continue;
                if (mode.Width < 640 || mode.Height < 480)
                    continue;
                if (mode.Width != desc.width && mode.Height != desc.height)
                    break;
            }
            ok(mode.Width != desc.width && mode.Height != desc.height,
                    "Adapter %u: Failed to find a different mode than %ux%u.\n", adapter_idx,
                    desc.width, desc.height);
            desc.width = mode.Width;
            desc.height = mode.Height;
        }

        for (test_idx = 0; test_idx < ARRAY_SIZE(creation_flags); ++test_idx)
        {
            window = create_window();
            desc.adapter_ordinal = adapter_idx;
            desc.device_window = window;
            desc.flags = creation_flags[test_idx];
            if (!(device = create_device(d3d, window, &desc)))
            {
                skip("Adapter %u test %u: Failed to create a D3D device.\n", adapter_idx, test_idx);
                DestroyWindow(window);
                continue;
            }

            monitor = IDirect3D8_GetAdapterMonitor(d3d, adapter_idx);
            ok(!!monitor, "Adapter %u test %u: GetAdapterMonitor failed.\n", adapter_idx, test_idx);
            monitor_info.cbSize = sizeof(monitor_info);
            ret = GetMonitorInfoW(monitor, &monitor_info);
            ok(ret, "Adapter %u test %u: GetMonitorInfoW failed, error %#lx.\n", adapter_idx,
                    test_idx, GetLastError());
            width = monitor_info.rcMonitor.right - monitor_info.rcMonitor.left;
            height = monitor_info.rcMonitor.bottom - monitor_info.rcMonitor.top;

            if (adapter_idx)
            {
                /* Move the device window to the previous monitor to test that the device window
                 * position doesn't affect which adapter to use to get the display mode */
                ret = SetWindowPos(window, 0, previous_monitor_rect.left, previous_monitor_rect.top,
                        0, 0, SWP_NOZORDER | SWP_NOSIZE);
                ok(ret, "Adapter %u test %u: SetWindowPos failed, error %#lx.\n", adapter_idx,
                        test_idx, GetLastError());
            }

            hr = IDirect3D8_GetAdapterDisplayMode(d3d, adapter_idx, &mode);
            ok(hr == D3D_OK, "Adapter %u test %u: GetAdapterDisplayMode failed, hr %#lx.\n",
                    adapter_idx, test_idx, hr);
            ok(mode.Width == width, "Adapter %u test %u: Expect width %u, got %u.\n", adapter_idx,
                    test_idx, width, mode.Width);
            ok(mode.Height == height, "Adapter %u test %u: Expect height %u, got %u.\n",
                    adapter_idx, test_idx, height, mode.Height);

            hr = IDirect3DDevice8_GetDisplayMode(device, &mode);
            ok(hr == D3D_OK, "Adapter %u test %u: GetDisplayMode failed, hr %#lx.\n", adapter_idx,
                    test_idx, hr);
            ok(mode.Width == width, "Adapter %u test %u: Expect width %u, got %u.\n", adapter_idx,
                    test_idx, width, mode.Width);
            ok(mode.Height == height, "Adapter %u test %u: Expect height %u, got %u.\n",
                    adapter_idx, test_idx, height, mode.Height);

            refcount = IDirect3DDevice8_Release(device);
            ok(!refcount, "Adapter %u test %u: Device has %lu references left.\n", adapter_idx,
                    test_idx, refcount);
            DestroyWindow(window);
        }
    }

    IDirect3D8_Release(d3d);
}

static void test_multi_adapter(void)
{
    unsigned int i, adapter_count, expected_adapter_count = 0;
    DISPLAY_DEVICEA display_device;
    MONITORINFOEXA monitor_info;
    DEVMODEA old_mode, mode;
    HMONITOR monitor;
    IDirect3D8 *d3d;
    LONG ret;

    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");

    display_device.cb = sizeof(display_device);
    for (i = 0; EnumDisplayDevicesA(NULL, i, &display_device, 0); ++i)
    {
        if (display_device.StateFlags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP)
            ++expected_adapter_count;
    }

    adapter_count = IDirect3D8_GetAdapterCount(d3d);
    ok(adapter_count == expected_adapter_count, "Got unexpected adapter count %u, expected %u.\n",
            adapter_count, expected_adapter_count);

    for (i = 0; i < adapter_count; ++i)
    {
        monitor = IDirect3D8_GetAdapterMonitor(d3d, i);
        ok(!!monitor, "Adapter %u: Failed to get monitor.\n", i);

        monitor_info.cbSize = sizeof(monitor_info);
        ret = GetMonitorInfoA(monitor, (MONITORINFO *)&monitor_info);
        ok(ret, "Adapter %u: Failed to get monitor info, error %#lx.\n", i, GetLastError());

        if (!i)
            ok(monitor_info.dwFlags == MONITORINFOF_PRIMARY,
                    "Adapter %u: Got unexpected monitor flags %#lx.\n", i, monitor_info.dwFlags);
        else
            ok(!monitor_info.dwFlags, "Adapter %u: Got unexpected monitor flags %#lx.\n", i,
                    monitor_info.dwFlags);

        /* Test D3D adapters after they got detached */
        if (monitor_info.dwFlags == MONITORINFOF_PRIMARY)
            continue;

        /* Save current display settings */
        memset(&old_mode, 0, sizeof(old_mode));
        old_mode.dmSize = sizeof(old_mode);
        ret = EnumDisplaySettingsA(monitor_info.szDevice, ENUM_CURRENT_SETTINGS, &old_mode);
        /* Win10 TestBots may return FALSE but it's actually successful */
        ok(ret || broken(!ret), "Adapter %u: EnumDisplaySettingsA failed for %s, error %#lx.\n", i,
                monitor_info.szDevice, GetLastError());

        /* Detach */
        memset(&mode, 0, sizeof(mode));
        mode.dmSize = sizeof(mode);
        mode.dmFields = DM_POSITION | DM_PELSWIDTH | DM_PELSHEIGHT;
        mode.dmPosition = old_mode.dmPosition;
        ret = ChangeDisplaySettingsExA(monitor_info.szDevice, &mode, NULL,
                CDS_UPDATEREGISTRY | CDS_NORESET, NULL);
        ok(ret == DISP_CHANGE_SUCCESSFUL,
                "Adapter %u: ChangeDisplaySettingsExA %s returned unexpected %ld.\n", i,
                monitor_info.szDevice, ret);
        ret = ChangeDisplaySettingsExA(monitor_info.szDevice, NULL, NULL, 0, NULL);
        ok(ret == DISP_CHANGE_SUCCESSFUL,
                "Adapter %u: ChangeDisplaySettingsExA %s returned unexpected %ld.\n", i,
                monitor_info.szDevice, ret);

        /* Check if it is really detached */
        memset(&mode, 0, sizeof(mode));
        mode.dmSize = sizeof(mode);
        ret = EnumDisplaySettingsA(monitor_info.szDevice, ENUM_CURRENT_SETTINGS, &mode);
        /* Win10 TestBots may return FALSE but it's actually successful */
        ok(ret || broken(!ret) , "Adapter %u: EnumDisplaySettingsA failed for %s, error %#lx.\n", i,
                monitor_info.szDevice, GetLastError());
        if (mode.dmPelsWidth && mode.dmPelsHeight)
        {
            skip("Adapter %u: Failed to detach device %s.\n", i, monitor_info.szDevice);
            continue;
        }

        /* Detaching adapter shouldn't reduce the adapter count */
        expected_adapter_count = adapter_count;
        adapter_count = IDirect3D8_GetAdapterCount(d3d);
        ok(adapter_count == expected_adapter_count,
                "Adapter %u: Got unexpected adapter count %u, expected %u.\n", i, adapter_count,
                expected_adapter_count);

        monitor = IDirect3D8_GetAdapterMonitor(d3d, i);
        ok(!monitor, "Adapter %u: Expect monitor to be NULL.\n", i);

        /* Restore settings */
        ret = ChangeDisplaySettingsExA(monitor_info.szDevice, &old_mode, NULL,
                CDS_UPDATEREGISTRY | CDS_NORESET, NULL);
        ok(ret == DISP_CHANGE_SUCCESSFUL,
                "Adapter %u: ChangeDisplaySettingsExA %s returned unexpected %ld.\n", i,
                monitor_info.szDevice, ret);
        ret = ChangeDisplaySettingsExA(monitor_info.szDevice, NULL, NULL, 0, NULL);
        ok(ret == DISP_CHANGE_SUCCESSFUL,
                "Adapter %u: ChangeDisplaySettingsExA %s returned unexpected %ld.\n", i,
                monitor_info.szDevice, ret);
    }

    IDirect3D8_Release(d3d);
}

static void test_creation_parameters(void)
{
    unsigned int adapter_idx, adapter_count;
    D3DDEVICE_CREATION_PARAMETERS params;
    struct device_desc device_desc;
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d;
    HWND window;
    HRESULT hr;

    window = create_window();
    ok(!!window, "Failed to create a window.\n");
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");

    device_desc.device_window = window;
    device_desc.width = 640;
    device_desc.height = 480;
    device_desc.flags = 0;

    adapter_count = IDirect3D8_GetAdapterCount(d3d);
    for (adapter_idx = 0; adapter_idx < adapter_count; ++adapter_idx)
    {
        device_desc.adapter_ordinal = adapter_idx;
        if (!(device = create_device(d3d, window, &device_desc)))
        {
            skip("Adapter %u: Failed to create a D3D device.\n", adapter_idx);
            break;
        }

        memset(&params, 0, sizeof(params));
        hr = IDirect3DDevice8_GetCreationParameters(device, &params);
        ok(hr == D3D_OK, "Adapter %u: GetCreationParameters failed, hr %#lx.\n", adapter_idx, hr);
        ok(params.AdapterOrdinal == adapter_idx, "Adapter %u: Got unexpected adapter ordinal %u.\n",
                adapter_idx, params.AdapterOrdinal);
        ok(params.DeviceType == D3DDEVTYPE_HAL, "Adapter %u: Expect device type %#x, got %#x.\n",
                adapter_idx, D3DDEVTYPE_HAL, params.DeviceType);
        ok(params.hFocusWindow == window, "Adapter %u: Expect focus window %p, got %p.\n",
                adapter_idx, window, params.hFocusWindow);

        IDirect3DDevice8_Release(device);
    }

    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_cursor_clipping(void)
{
    unsigned int adapter_idx, adapter_count, mode_idx;
    D3DDISPLAYMODE mode, current_mode;
    struct device_desc device_desc;
    RECT virtual_rect, clip_rect;
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d;
    HWND window;
    HRESULT hr;
    BOOL ret;

    window = create_window();
    ok(!!window, "Failed to create a window.\n");
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");

    device_desc.device_window = window;
    device_desc.flags = CREATE_DEVICE_FULLSCREEN;

    adapter_count = IDirect3D8_GetAdapterCount(d3d);
    for (adapter_idx = 0; adapter_idx < adapter_count; ++adapter_idx)
    {
        hr = IDirect3D8_GetAdapterDisplayMode(d3d, adapter_idx, &current_mode);
        ok(hr == D3D_OK, "Adapter %u: GetAdapterDisplayMode failed, hr %#lx.\n", adapter_idx, hr);
        for (mode_idx = 0; SUCCEEDED(IDirect3D8_EnumAdapterModes(d3d, adapter_idx, mode_idx, &mode));
                ++mode_idx)
        {
            if (mode.Format != D3DFMT_X8R8G8B8)
                continue;
            if (mode.Width < 640 || mode.Height < 480)
                continue;
            if (mode.Width != current_mode.Width && mode.Height != current_mode.Height)
                break;
        }
        ok(mode.Width != current_mode.Width && mode.Height != current_mode.Height,
                "Adapter %u: Failed to find a different mode than %ux%u.\n", adapter_idx,
                current_mode.Width, current_mode.Height);

        ret = ClipCursor(NULL);
        ok(ret, "Adapter %u: ClipCursor failed, error %#lx.\n", adapter_idx,
                GetLastError());
        get_virtual_rect(&virtual_rect);
        ret = GetClipCursor(&clip_rect);
        ok(ret, "Adapter %u: GetClipCursor failed, error %#lx.\n", adapter_idx,
                GetLastError());
        ok(EqualRect(&clip_rect, &virtual_rect), "Adapter %u: Expect clip rect %s, got %s.\n",
                adapter_idx, wine_dbgstr_rect(&virtual_rect), wine_dbgstr_rect(&clip_rect));

        device_desc.adapter_ordinal = adapter_idx;
        device_desc.width = mode.Width;
        device_desc.height = mode.Height;
        if (!(device = create_device(d3d, window, &device_desc)))
        {
            skip("Adapter %u: Failed to create a D3D device.\n", adapter_idx);
            break;
        }
        flush_events();
        get_virtual_rect(&virtual_rect);
        ret = GetClipCursor(&clip_rect);
        ok(ret, "Adapter %u: GetClipCursor failed, error %#lx.\n", adapter_idx,
                GetLastError());
        ok(EqualRect(&clip_rect, &virtual_rect), "Adapter %u: Expect clip rect %s, got %s.\n",
                adapter_idx, wine_dbgstr_rect(&virtual_rect), wine_dbgstr_rect(&clip_rect));

        IDirect3DDevice8_Release(device);
        flush_events();
        get_virtual_rect(&virtual_rect);
        ret = GetClipCursor(&clip_rect);
        ok(ret, "Adapter %u: GetClipCursor failed, error %#lx.\n", adapter_idx,
                GetLastError());
        ok(EqualRect(&clip_rect, &virtual_rect), "Adapter %u: Expect clip rect %s, got %s.\n",
                adapter_idx, wine_dbgstr_rect(&virtual_rect), wine_dbgstr_rect(&clip_rect));
    }

    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_window_position(void)
{
    unsigned int adapter_idx, adapter_count;
    struct device_desc device_desc;
    IDirect3DDevice8 *device;
    MONITORINFO monitor_info;
    HMONITOR monitor;
    RECT window_rect;
    IDirect3D8 *d3d;
    HWND window;
    HRESULT hr;
    BOOL ret;

    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");

    adapter_count = IDirect3D8_GetAdapterCount(d3d);
    for (adapter_idx = 0; adapter_idx < adapter_count; ++adapter_idx)
    {
        monitor = IDirect3D8_GetAdapterMonitor(d3d, adapter_idx);
        ok(!!monitor, "Adapter %u: GetAdapterMonitor failed.\n", adapter_idx);
        monitor_info.cbSize = sizeof(monitor_info);
        ret = GetMonitorInfoW(monitor, &monitor_info);
        ok(ret, "Adapter %u: GetMonitorInfoW failed, error %#lx.\n", adapter_idx, GetLastError());

        window = create_window();
        device_desc.adapter_ordinal = adapter_idx;
        device_desc.device_window = window;
        device_desc.width = monitor_info.rcMonitor.right - monitor_info.rcMonitor.left;
        device_desc.height = monitor_info.rcMonitor.bottom - monitor_info.rcMonitor.top;
        device_desc.flags = CREATE_DEVICE_FULLSCREEN;
        if (!(device = create_device(d3d, window, &device_desc)))
        {
            skip("Adapter %u: Failed to create a D3D device, skipping tests.\n", adapter_idx);
            DestroyWindow(window);
            continue;
        }
        flush_events();
        ret = GetWindowRect(window, &window_rect);
        ok(ret, "Adapter %u: GetWindowRect failed, error %#lx.\n", adapter_idx, GetLastError());
        ok(EqualRect(&window_rect, &monitor_info.rcMonitor),
                "Adapter %u: Expect window rect %s, got %s.\n", adapter_idx,
                wine_dbgstr_rect(&monitor_info.rcMonitor), wine_dbgstr_rect(&window_rect));

        /* Device resets should restore the window rectangle to fit the whole monitor */
        ret = SetWindowPos(window, 0, 0, 0, 0, 0, SWP_NOZORDER | SWP_NOSIZE);
        ok(ret, "Adapter %u: SetWindowPos failed, error %#lx.\n", adapter_idx, GetLastError());
        hr = reset_device(device, &device_desc);
        ok(hr == D3D_OK, "Adapter %u: Failed to reset device, hr %#lx.\n", adapter_idx, hr);
        flush_events();
        ret = GetWindowRect(window, &window_rect);
        ok(ret, "Adapter %u: GetWindowRect failed, error %#lx.\n", adapter_idx, GetLastError());
        ok(EqualRect(&window_rect, &monitor_info.rcMonitor),
                "Adapter %u: Expect window rect %s, got %s.\n", adapter_idx,
                wine_dbgstr_rect(&monitor_info.rcMonitor), wine_dbgstr_rect(&window_rect));

        /* Window activation should restore the window rectangle to fit the whole monitor */
        ret = SetWindowPos(window, 0, 0, 0, 0, 0, SWP_NOZORDER | SWP_NOSIZE);
        ok(ret, "Adapter %u: SetWindowPos failed, error %#lx.\n", adapter_idx, GetLastError());
        ret = SetForegroundWindow(GetDesktopWindow());
        ok(ret, "Adapter %u: SetForegroundWindow failed, error %#lx.\n", adapter_idx, GetLastError());
        flush_events();
        ret = ShowWindow(window, SW_RESTORE);
        ok(ret, "Adapter %u: Failed to restore window, error %#lx.\n", adapter_idx, GetLastError());
        flush_events();
        ret = SetForegroundWindow(window);
        ok(ret, "Adapter %u: SetForegroundWindow failed, error %#lx.\n", adapter_idx, GetLastError());
        flush_events();
        ret = GetWindowRect(window, &window_rect);
        ok(ret, "Adapter %u: GetWindowRect failed, error %#lx.\n", adapter_idx, GetLastError());
        ok(EqualRect(&window_rect, &monitor_info.rcMonitor),
                "Adapter %u: Expect window rect %s, got %s.\n", adapter_idx,
                wine_dbgstr_rect(&monitor_info.rcMonitor), wine_dbgstr_rect(&window_rect));

        IDirect3DDevice8_Release(device);
        DestroyWindow(window);
    }

    IDirect3D8_Release(d3d);
}

static void test_filter(void)
{
    unsigned int mag, min, mip;
    IDirect3DTexture8 *texture;
    IDirect3DDevice8 *device;
    BOOL has_texture;
    IDirect3D8 *d3d;
    ULONG refcount;
    DWORD passes;
    HWND window;
    HRESULT hr;

    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");

    window = create_window();
    if (!(device = create_device(d3d, window, NULL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_CreateTexture(device, 128, 128, 0, 0, D3DFMT_X8R8G8B8, D3DPOOL_MANAGED, &texture);
    ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx.\n", hr);

    for (has_texture = FALSE; has_texture <= TRUE; ++has_texture)
    for (mag = 0; mag <= D3DTEXF_GAUSSIANCUBIC + 1; ++mag)
    for (min = 0; min <= D3DTEXF_GAUSSIANCUBIC + 1; ++min)
    for (mip = 0; mip <= D3DTEXF_GAUSSIANCUBIC + 1; ++mip)
    {
        if (has_texture)
        {
            hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *)texture);
            ok(SUCCEEDED(hr), "Failed to set texture, hr %#lx.\n", hr);
        }
        else
        {
            hr = IDirect3DDevice8_SetTexture(device, 0, NULL);
            ok(SUCCEEDED(hr), "Failed to set texture, hr %#lx.\n", hr);
        }

        hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_MAGFILTER, mag);
        ok(SUCCEEDED(hr), "Failed to set sampler state, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_MINFILTER, min);
        ok(SUCCEEDED(hr), "Failed to set sampler state, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_MIPFILTER, mip);
        ok(SUCCEEDED(hr), "Failed to set sampler state, hr %#lx.\n", hr);

        passes = 0xdeadbeef;
        hr = IDirect3DDevice8_ValidateDevice(device, &passes);
        ok(SUCCEEDED(hr), "Failed to validate device, hr %#lx.\n", hr);
        ok(passes && passes != 0xdeadbeef, "Got unexpected passes %#lx.\n", passes);
    }

    hr = IDirect3DDevice8_SetTexture(device, 0, NULL);
    ok(SUCCEEDED(hr), "Failed to set texture, hr %#lx.\n", hr);
    IDirect3DTexture8_Release(texture);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

START_TEST(device)
{
    HMODULE d3d8_handle = GetModuleHandleA("d3d8.dll");
    WNDCLASSA wc = {0};
    IDirect3D8 *d3d8;
    DEVMODEW current_mode;

    if (!d3d8_handle)
    {
        skip("Could not load d3d8.dll\n");
        return;
    }

    memset(&current_mode, 0, sizeof(current_mode));
    current_mode.dmSize = sizeof(current_mode);
    ok(EnumDisplaySettingsW(NULL, ENUM_CURRENT_SETTINGS, &current_mode), "Failed to get display mode.\n");
    registry_mode.dmSize = sizeof(registry_mode);
    ok(EnumDisplaySettingsW(NULL, ENUM_REGISTRY_SETTINGS, &registry_mode), "Failed to get display mode.\n");
    if (current_mode.dmPelsWidth != registry_mode.dmPelsWidth
            || current_mode.dmPelsHeight != registry_mode.dmPelsHeight)
    {
        skip("Current mode does not match registry mode, skipping test.\n");
        return;
    }

    wc.lpfnWndProc = DefWindowProcA;
    wc.lpszClassName = "d3d8_test_wc";
    RegisterClassA(&wc);

    ValidateVertexShader = (void *)GetProcAddress(d3d8_handle, "ValidateVertexShader");
    ValidatePixelShader = (void *)GetProcAddress(d3d8_handle, "ValidatePixelShader");

    if (!(d3d8 = Direct3DCreate8(D3D_SDK_VERSION)))
    {
        skip("could not create D3D8\n");
        return;
    }
    IDirect3D8_Release(d3d8);

    test_fpu_setup();
    test_display_formats();
    test_display_modes();
    test_shader_versions();
    test_swapchain();
    test_refcount();
    test_mipmap_levels();
    test_checkdevicemultisampletype();
    test_invalid_multisample();
    test_cursor();
    test_cursor_pos();
    test_states();
    test_reset();
    test_scene();
    test_shader();
    test_limits();
    test_lights();
    test_set_stream_source();
    test_ApplyStateBlock();
    test_render_zero_triangles();
    test_depth_stencil_reset();
    test_wndproc();
    test_wndproc_windowed();
    test_depth_stencil_size();
    test_window_style();
    test_unsupported_shaders();
    test_mode_change();
    test_device_window_reset();
    test_reset_resources();
    depth_blit_test();
    test_set_rt_vp_scissor();
    test_validate_vs();
    test_validate_ps();
    test_volume_get_container();
    test_vb_lock_flags();
    test_texture_stage_states();
    test_cube_textures();
    test_get_set_texture();
    test_image_surface_pool();
    test_surface_get_container();
    test_lockrect_invalid();
    test_private_data();
    test_surface_dimensions();
    test_surface_format_null();
    test_surface_double_unlock();
    test_surface_blocks();
    test_set_palette();
    test_pinned_buffers();
    test_npot_textures();
    test_volume_locking();
    test_update_texture_pool();
    test_update_volumetexture();
    test_create_rt_ds_fail();
    test_volume_blocks();
    test_lockbox_invalid();
    test_pixel_format();
    test_begin_end_state_block();
    test_shader_constant_apply();
    test_resource_type();
    test_mipmap_lock();
    test_writeonly_resource();
    test_lost_device();
    test_resource_priority();
    test_swapchain_parameters();
    test_check_device_format();
    test_miptree_layout();
    test_render_target_device_mismatch();
    test_format_unknown();
    test_destroyed_window();
    test_lockable_backbuffer();
    test_clip_planes_limits();
    test_swapchain_multisample_reset();
    test_device_caps();
    test_get_info();
    test_resource_access();
    test_multiply_transform();
    test_draw_primitive();
    test_get_display_mode();
    test_multi_adapter();
    test_creation_parameters();
    test_cursor_clipping();
    test_window_position();
    test_filter();

    UnregisterClassA("d3d8_test_wc", GetModuleHandleA(NULL));
}
