/*
 * Copyright 2005 Antoine Chavasse (a.chavasse@gmail.com)
 * Copyright 2008, 2011, 2012-2014 Stefan Dösinger for CodeWeavers
 * Copyright 2011-2014 Henri Verbeet for CodeWeavers
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

#include <math.h>

#define COBJMACROS
#include <stdbool.h>
#include <stdint.h>
#include "wine/test.h"
#include <limits.h>
#include <math.h>
#include "ddrawi.h"
#include "d3dhal.h"

static BOOL is_ddraw64 = sizeof(DWORD) != sizeof(DWORD *);
static DEVMODEA registry_mode;
static HWND foreground;

static HRESULT (WINAPI *pDwmIsCompositionEnabled)(BOOL *);

struct vec2
{
    float x, y;
};

struct vec4
{
    float x, y, z, w;
};

struct create_window_thread_param
{
    HWND window;
    HANDLE window_created;
    HANDLE destroy_window;
    HANDLE thread;
};

static BOOL compare_uint(unsigned int x, unsigned int y, unsigned int max_diff)
{
    unsigned int diff = x > y ? x - y : y - x;

    return diff <= max_diff;
}

static BOOL compare_float(float f, float g, unsigned int ulps)
{
    int x = *(int *)&f;
    int y = *(int *)&g;

    if (x < 0)
        x = INT_MIN - x;
    if (y < 0)
        y = INT_MIN - y;

    return compare_uint(x, y, ulps);
}

static BOOL compare_vec4(const struct vec4 *vec, float x, float y, float z, float w, unsigned int ulps)
{
    return compare_float(vec->x, x, ulps)
            && compare_float(vec->y, y, ulps)
            && compare_float(vec->z, z, ulps)
            && compare_float(vec->w, w, ulps);
}

static BOOL compare_color(D3DCOLOR c1, D3DCOLOR c2, BYTE max_diff)
{
    return compare_uint(c1 & 0xff, c2 & 0xff, max_diff)
            && compare_uint((c1 >> 8) & 0xff, (c2 >> 8) & 0xff, max_diff)
            && compare_uint((c1 >> 16) & 0xff, (c2 >> 16) & 0xff, max_diff)
            && compare_uint((c1 >> 24) & 0xff, (c2 >> 24) & 0xff, max_diff);
}

static void get_virtual_rect(RECT *rect)
{
    rect->left = GetSystemMetrics(SM_XVIRTUALSCREEN);
    rect->top = GetSystemMetrics(SM_YVIRTUALSCREEN);
    rect->right = rect->left + GetSystemMetrics(SM_CXVIRTUALSCREEN);
    rect->bottom = rect->top + GetSystemMetrics(SM_CYVIRTUALSCREEN);
}

/* Try to make sure pending X events have been processed before continuing */
static void flush_events(void)
{
    int diff = 200;
    DWORD time;
    MSG msg;

    time = GetTickCount() + diff;
    while (diff > 0)
    {
        if (MsgWaitForMultipleObjects(0, NULL, FALSE, 100, QS_ALLINPUT) == WAIT_TIMEOUT)
            break;
        while (PeekMessageA(&msg, 0, 0, 0, PM_REMOVE))
            DispatchMessageA(&msg);
        diff = time - GetTickCount();
    }
}

static void pump_messages(void)
{
    MSG msg;

    while (PeekMessageA(&msg, 0, 0, 0, PM_REMOVE))
        DispatchMessageA(&msg);
}

static HWND create_foreground_window(void)
{
    for (UINT retries = 5; retries; retries--)
    {
        HWND hwnd;
        BOOL ret;

        hwnd = CreateWindowW(L"static", NULL, WS_POPUP | WS_VISIBLE, 0, 0, 5, 5, NULL, NULL, NULL, NULL);
        ok(hwnd != NULL, "CreateWindowW failed, error %lu\n", GetLastError());
        flush_events();

        if (GetForegroundWindow() == hwnd)
            return hwnd;
        ret = DestroyWindow(hwnd);
        ok(ret, "DestroyWindow failed, error %lu\n", GetLastError());
        flush_events();
    }

    ok(0, "Failed to create foreground window\n");
    return NULL;
}

static LRESULT CALLBACK foreground_window_wndproc(HWND hwnd, UINT msg, WPARAM wparam, LPARAM lparam)
{
    if (msg == WM_USER)
        SetForegroundWindow((HWND)wparam);
    if (msg == WM_CLOSE)
        PostQuitMessage(0);
    return DefWindowProcW(hwnd, msg, wparam, lparam);
}

static DWORD WINAPI foreground_window_thread(void *arg)
{
    HANDLE event = arg;
    MSG msg;

    foreground = create_foreground_window();
    SetWindowLongPtrW(foreground, GWLP_WNDPROC, (LONG_PTR)foreground_window_wndproc);
    SetEvent(event);

    while (GetMessageW(&msg, NULL, 0, 0))
    {
        if (msg.message == WM_QUIT) break;
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    return 0;
}

static void start_foreground_window_thread(void)
{
    HANDLE event = CreateEventA(NULL, FALSE, FALSE, NULL);
    CloseHandle(CreateThread(NULL, 0, foreground_window_thread, event, 0, NULL));
    WaitForSingleObject(event, 10000);
    CloseHandle(event);
}

static BOOL ddraw_get_identifier(IDirectDraw2 *ddraw, DDDEVICEIDENTIFIER *identifier)
{
    IDirectDraw4 *ddraw4;
    HRESULT hr;

    hr = IDirectDraw2_QueryInterface(ddraw, &IID_IDirectDraw4, (void **)&ddraw4);
    ok(SUCCEEDED(hr), "Failed to get IDirectDraw4 interface, hr %#lx.\n", hr);
    hr = IDirectDraw4_GetDeviceIdentifier(ddraw4, identifier, 0);
    ok(SUCCEEDED(hr), "Failed to get device identifier, hr %#lx.\n", hr);
    IDirectDraw4_Release(ddraw4);

    return SUCCEEDED(hr);
}

static BOOL ddraw_is_warp(IDirectDraw2 *ddraw)
{
    DDDEVICEIDENTIFIER identifier;

    return strcmp(winetest_platform, "wine")
            && ddraw_get_identifier(ddraw, &identifier)
            && strstr(identifier.szDriver, "warp");
}

static BOOL ddraw_is_vendor(IDirectDraw2 *ddraw, DWORD vendor)
{
    DDDEVICEIDENTIFIER identifier;

    return strcmp(winetest_platform, "wine")
            && ddraw_get_identifier(ddraw, &identifier)
            && identifier.dwVendorId == vendor;
}

static BOOL ddraw_is_amd(IDirectDraw2 *ddraw)
{
    return ddraw_is_vendor(ddraw, 0x1002);
}

static BOOL ddraw_is_intel(IDirectDraw2 *ddraw)
{
    return ddraw_is_vendor(ddraw, 0x8086);
}

static BOOL ddraw_is_nvidia(IDirectDraw2 *ddraw)
{
    return ddraw_is_vendor(ddraw, 0x10de);
}

static BOOL ddraw_is_vmware(IDirectDraw2 *ddraw)
{
    return ddraw_is_vendor(ddraw, 0x15ad);
}

static BOOL is_software_device_type(const GUID *device_guid)
{
    return device_guid != &IID_IDirect3DHALDevice;
}

static IDirectDrawSurface *create_overlay(IDirectDraw2 *ddraw,
        unsigned int width, unsigned int height, DWORD format)
{
    IDirectDrawSurface *surface;
    DDSURFACEDESC desc;

    memset(&desc, 0, sizeof(desc));
    desc.dwSize = sizeof(desc);
    desc.dwFlags = DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PIXELFORMAT;
    desc.dwWidth = width;
    desc.dwHeight = height;
    desc.ddsCaps.dwCaps = DDSCAPS_OVERLAY;
    desc.ddpfPixelFormat.dwSize = sizeof(desc.ddpfPixelFormat);
    desc.ddpfPixelFormat.dwFlags = DDPF_FOURCC;
    desc.ddpfPixelFormat.dwFourCC = format;

    if (FAILED(IDirectDraw2_CreateSurface(ddraw, &desc, &surface, NULL)))
        return NULL;
    return surface;
}

static HWND create_window(void)
{
    RECT r = {0, 0, 640, 480};

    AdjustWindowRect(&r, WS_OVERLAPPEDWINDOW | WS_VISIBLE, FALSE);

    return CreateWindowA("static", "ddraw_test", WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            CW_USEDEFAULT, CW_USEDEFAULT, r.right - r.left, r.bottom - r.top, NULL, NULL, NULL, NULL);
}

static DWORD WINAPI create_window_thread_proc(void *param)
{
    struct create_window_thread_param *p = param;
    DWORD res;
    BOOL ret;

    p->window = create_window();
    ret = SetEvent(p->window_created);
    ok(ret, "SetEvent failed, last error %lu.\n", GetLastError());

    for (;;)
    {
        MSG msg;

        while (PeekMessageA(&msg, 0, 0, 0, PM_REMOVE))
            DispatchMessageA(&msg);
        res = WaitForSingleObject(p->destroy_window, 100);
        if (res == WAIT_OBJECT_0)
            break;
        if (res != WAIT_TIMEOUT)
        {
            ok(0, "Wait failed (%#lx), last error %lu.\n", res, GetLastError());
            break;
        }
    }

    DestroyWindow(p->window);

    return 0;
}

static void create_window_thread(struct create_window_thread_param *p)
{
    DWORD res, tid;

    p->window_created = CreateEventA(NULL, FALSE, FALSE, NULL);
    ok(!!p->window_created, "CreateEvent failed, last error %lu.\n", GetLastError());
    p->destroy_window = CreateEventA(NULL, FALSE, FALSE, NULL);
    ok(!!p->destroy_window, "CreateEvent failed, last error %lu.\n", GetLastError());
    p->thread = CreateThread(NULL, 0, create_window_thread_proc, p, 0, &tid);
    ok(!!p->thread, "Failed to create thread, last error %lu.\n", GetLastError());
    res = WaitForSingleObject(p->window_created, INFINITE);
    ok(res == WAIT_OBJECT_0, "Wait failed (%#lx), last error %lu.\n", res, GetLastError());
}

static void destroy_window_thread(struct create_window_thread_param *p)
{
    SetEvent(p->destroy_window);
    WaitForSingleObject(p->thread, INFINITE);
    CloseHandle(p->destroy_window);
    CloseHandle(p->window_created);
    CloseHandle(p->thread);
}

static IDirectDrawSurface *get_depth_stencil(IDirect3DDevice2 *device)
{
    IDirectDrawSurface *rt, *ret;
    DDSCAPS caps = {DDSCAPS_ZBUFFER};
    HRESULT hr;

    hr = IDirect3DDevice2_GetRenderTarget(device, &rt);
    ok(SUCCEEDED(hr), "Failed to get render target, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_GetAttachedSurface(rt, &caps, &ret);
    ok(SUCCEEDED(hr) || hr == DDERR_NOTFOUND, "Failed to get the z buffer, hr %#lx.\n", hr);
    IDirectDrawSurface_Release(rt);
    return ret;
}

/* Free original_modes after finished using it */
static BOOL save_display_modes(DEVMODEA **original_modes, unsigned int *display_count)
{
    unsigned int number, size = 2, count = 0, index = 0;
    DISPLAY_DEVICEA display_device;
    DEVMODEA *modes, *tmp;

    if (!(modes = malloc(size * sizeof(*modes))))
        return FALSE;

    display_device.cb = sizeof(display_device);
    while (EnumDisplayDevicesA(NULL, index++, &display_device, 0))
    {
        /* Skip software devices */
        if (sscanf(display_device.DeviceName, "\\\\.\\DISPLAY%u", &number) != 1)
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
        if (!EnumDisplaySettingsA(display_device.DeviceName, ENUM_CURRENT_SETTINGS, &modes[count]))
        {
            free(modes);
            return FALSE;
        }

        strcpy((char *)modes[count++].dmDeviceName, display_device.DeviceName);
    }

    *original_modes = modes;
    *display_count = count;
    return TRUE;
}

static BOOL restore_display_modes(DEVMODEA *modes, unsigned int count)
{
    unsigned int index;
    LONG ret;

    for (index = 0; index < count; ++index)
    {
        ret = ChangeDisplaySettingsExA((char *)modes[index].dmDeviceName, &modes[index], NULL,
                CDS_UPDATEREGISTRY | CDS_NORESET, NULL);
        if (ret != DISP_CHANGE_SUCCESSFUL)
            return FALSE;
    }
    ret = ChangeDisplaySettingsExA(NULL, NULL, NULL, 0, NULL);
    return ret == DISP_CHANGE_SUCCESSFUL;
}

static HRESULT set_display_mode(IDirectDraw2 *ddraw, DWORD width, DWORD height)
{
    if (SUCCEEDED(IDirectDraw2_SetDisplayMode(ddraw, width, height, 32, 0, 0)))
        return DD_OK;
    return IDirectDraw2_SetDisplayMode(ddraw, width, height, 24, 0, 0);
}

static D3DCOLOR get_surface_color(IDirectDrawSurface *surface, UINT x, UINT y)
{
    RECT rect = {x, y, x + 1, y + 1};
    DDSURFACEDESC surface_desc;
    D3DCOLOR color;
    HRESULT hr;

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);

    hr = IDirectDrawSurface_Lock(surface, &rect, &surface_desc, DDLOCK_READONLY | DDLOCK_WAIT, NULL);
    ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx.\n", hr);
    if (FAILED(hr))
        return 0xdeadbeef;

    color = *((DWORD *)surface_desc.lpSurface) & 0x00ffffff;

    hr = IDirectDrawSurface_Unlock(surface, NULL);
    ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);

    return color;
}

static void fill_surface(IDirectDrawSurface *surface, D3DCOLOR color)
{
    DDSURFACEDESC surface_desc = {sizeof(surface_desc)};
    HRESULT hr;
    unsigned int x, y;
    DWORD *ptr;

    hr = IDirectDrawSurface_Lock(surface, NULL, &surface_desc, DDLOCK_WAIT, NULL);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

    for (y = 0; y < surface_desc.dwHeight; ++y)
    {
        ptr = (DWORD *)((BYTE *)surface_desc.lpSurface + y * surface_desc.lPitch);
        for (x = 0; x < surface_desc.dwWidth; ++x)
        {
            ptr[x] = color;
        }
    }

    hr = IDirectDrawSurface_Unlock(surface, NULL);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
}

static void check_rect(IDirectDrawSurface *surface, RECT r)
{
    LONG x_coords[2][2] =
    {
        {r.left - 1, r.left + 1},
        {r.right + 1, r.right - 1},
    };
    LONG y_coords[2][2] =
    {
        {r.top - 1, r.top + 1},
        {r.bottom + 1, r.bottom - 1}
    };
    unsigned int i, j, x_side, y_side, color;
    LONG x, y;

    for (i = 0; i < 2; ++i)
    {
        for (j = 0; j < 2; ++j)
        {
            for (x_side = 0; x_side < 2; ++x_side)
            {
                for (y_side = 0; y_side < 2; ++y_side)
                {
                    unsigned int expected = (x_side == 1 && y_side == 1) ? 0x00ffffff : 0x00000000;

                    x = x_coords[i][x_side];
                    y = y_coords[j][y_side];
                    if (x < 0 || x >= 640 || y < 0 || y >= 480)
                        continue;
                    color = get_surface_color(surface, x, y);
                    ok(color == expected, "Pixel (%ld, %ld) has color %08x, expected %08x.\n", x, y, color, expected);
                }
            }
        }
    }
}

static DWORD get_device_z_depth(IDirect3DDevice2 *device)
{
    DDSCAPS caps = {DDSCAPS_ZBUFFER};
    IDirectDrawSurface *ds, *rt;
    DDSURFACEDESC desc;
    HRESULT hr;

    if (FAILED(IDirect3DDevice2_GetRenderTarget(device, &rt)))
        return 0;

    hr = IDirectDrawSurface_GetAttachedSurface(rt, &caps, &ds);
    IDirectDrawSurface_Release(rt);
    if (FAILED(hr))
        return 0;

    desc.dwSize = sizeof(desc);
    hr = IDirectDrawSurface_GetSurfaceDesc(ds, &desc);
    IDirectDrawSurface_Release(ds);
    if (FAILED(hr))
        return 0;

    return desc.dwZBufferBitDepth;
}

static IDirectDraw2 *create_ddraw(void)
{
    IDirectDraw2 *ddraw2;
    IDirectDraw *ddraw1;
    HRESULT hr;

    if (FAILED(DirectDrawCreate(NULL, &ddraw1, NULL)))
        return NULL;

    hr = IDirectDraw_QueryInterface(ddraw1, &IID_IDirectDraw2, (void **)&ddraw2);
    IDirectDraw_Release(ddraw1);
    if (FAILED(hr))
        return NULL;

    return ddraw2;
}

static IDirect3DDevice2 *create_device_ex(IDirectDraw2 *ddraw, HWND window, DWORD coop_level, const GUID *device_guid,
        IDirectDrawSurface **ret_surface)
{
    /* Prefer 16 bit depth buffers because Nvidia gives us an unpadded D24 buffer if we ask
     * for 24 bit and handles such buffers incorrectly in DDBLT_DEPTHFILL. AMD only supports
     * 16 bit buffers in ddraw1/2. Stencil was added in ddraw4, so we cannot create a D24S8
     * buffer here. */
    static const DWORD z_depths[] = {16, 32, 24};
    IDirectDrawSurface *surface, *ds;
    IDirect3DDevice2 *device = NULL;
    DDSURFACEDESC surface_desc;
    IDirect3D2 *d3d;
    unsigned int i;
    HRESULT hr;

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, coop_level);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN | DDSCAPS_3DDEVICE;
    if (is_software_device_type(device_guid))
        surface_desc.ddsCaps.dwCaps |= DDSCAPS_SYSTEMMEMORY;
    surface_desc.dwWidth = 640;
    surface_desc.dwHeight = 480;

    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

    if (coop_level & DDSCL_NORMAL)
    {
        IDirectDrawClipper *clipper;

        hr = IDirectDraw2_CreateClipper(ddraw, 0, &clipper, NULL);
        ok(SUCCEEDED(hr), "Failed to create clipper, hr %#lx.\n", hr);
        hr = IDirectDrawClipper_SetHWnd(clipper, 0, window);
        ok(SUCCEEDED(hr), "Failed to set clipper window, hr %#lx.\n", hr);
        hr = IDirectDrawSurface_SetClipper(surface, clipper);
        ok(SUCCEEDED(hr), "Failed to set surface clipper, hr %#lx.\n", hr);
        IDirectDrawClipper_Release(clipper);
    }

    hr = IDirectDraw2_QueryInterface(ddraw, &IID_IDirect3D2, (void **)&d3d);
    if (FAILED(hr))
    {
        IDirectDrawSurface_Release(surface);
        return NULL;
    }

    /* We used to use EnumDevices() for this, but it seems
     * D3DDEVICEDESC.dwDeviceZBufferBitDepth only has a very casual
     * relationship with reality. */
    for (i = 0; i < ARRAY_SIZE(z_depths); ++i)
    {
        memset(&surface_desc, 0, sizeof(surface_desc));
        surface_desc.dwSize = sizeof(surface_desc);
        surface_desc.dwFlags = DDSD_CAPS | DDSD_ZBUFFERBITDEPTH | DDSD_WIDTH | DDSD_HEIGHT;
        surface_desc.ddsCaps.dwCaps = DDSCAPS_ZBUFFER;
        if (is_software_device_type(device_guid))
            surface_desc.ddsCaps.dwCaps |= DDSCAPS_SYSTEMMEMORY;
        surface_desc.dwZBufferBitDepth = z_depths[i];
        surface_desc.dwWidth = 640;
        surface_desc.dwHeight = 480;
        if (FAILED(IDirectDraw2_CreateSurface(ddraw, &surface_desc, &ds, NULL)))
            continue;

        hr = IDirectDrawSurface_AddAttachedSurface(surface, ds);
        ok(SUCCEEDED(hr), "Failed to attach depth buffer, hr %#lx.\n", hr);
        IDirectDrawSurface_Release(ds);
        if (FAILED(hr))
            continue;

        if (SUCCEEDED(IDirect3D2_CreateDevice(d3d, device_guid, surface, &device)))
            break;

        IDirectDrawSurface_DeleteAttachedSurface(surface, 0, ds);
    }

    IDirect3D2_Release(d3d);
    if (ret_surface)
        *ret_surface = surface;
    else
        IDirectDrawSurface_Release(surface);

    return device;
}

static IDirect3DDevice2 *create_device(IDirectDraw2 *ddraw, HWND window, DWORD coop_level)
{
    return create_device_ex(ddraw, window, coop_level, &IID_IDirect3DHALDevice, NULL);
}

static IDirect3DViewport2 *create_viewport(IDirect3DDevice2 *device, UINT x, UINT y, UINT w, UINT h)
{
    IDirect3DViewport2 *viewport;
    D3DVIEWPORT2 vp;
    IDirect3D2 *d3d;
    HRESULT hr;

    hr = IDirect3DDevice2_GetDirect3D(device, &d3d);
    ok(SUCCEEDED(hr), "Failed to get d3d interface, hr %#lx.\n", hr);
    hr = IDirect3D2_CreateViewport(d3d, &viewport, NULL);
    ok(SUCCEEDED(hr), "Failed to create viewport, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_AddViewport(device, viewport);
    ok(SUCCEEDED(hr), "Failed to add viewport, hr %#lx.\n", hr);
    memset(&vp, 0, sizeof(vp));
    vp.dwSize = sizeof(vp);
    vp.dwX = x;
    vp.dwY = y;
    vp.dwWidth = w;
    vp.dwHeight = h;
    vp.dvClipX = -1.0f;
    vp.dvClipY =  1.0f;
    vp.dvClipWidth = 2.0f;
    vp.dvClipHeight = 2.0f;
    vp.dvMinZ = 0.0f;
    vp.dvMaxZ = 1.0f;
    hr = IDirect3DViewport2_SetViewport2(viewport, &vp);
    ok(SUCCEEDED(hr), "Failed to set viewport data, hr %#lx.\n", hr);
    IDirect3D2_Release(d3d);

    return viewport;
}

static void viewport_set_background(IDirect3DDevice2 *device, IDirect3DViewport2 *viewport,
        IDirect3DMaterial2 *material)
{
    D3DMATERIALHANDLE material_handle;
    HRESULT hr;

    hr = IDirect3DMaterial2_GetHandle(material, device, &material_handle);
    ok(SUCCEEDED(hr), "Failed to get material handle, hr %#lx.\n", hr);
    hr = IDirect3DViewport2_SetBackground(viewport, material_handle);
    ok(SUCCEEDED(hr), "Failed to set viewport background, hr %#lx.\n", hr);
}

static void destroy_viewport(IDirect3DDevice2 *device, IDirect3DViewport2 *viewport)
{
    HRESULT hr;

    hr = IDirect3DDevice2_DeleteViewport(device, viewport);
    ok(SUCCEEDED(hr), "Failed to delete viewport, hr %#lx.\n", hr);
    IDirect3DViewport2_Release(viewport);
}

static IDirect3DMaterial2 *create_material(IDirect3DDevice2 *device, D3DMATERIAL *mat)
{
    IDirect3DMaterial2 *material;
    IDirect3D2 *d3d;
    HRESULT hr;

    hr = IDirect3DDevice2_GetDirect3D(device, &d3d);
    ok(SUCCEEDED(hr), "Failed to get d3d interface, hr %#lx.\n", hr);
    hr = IDirect3D2_CreateMaterial(d3d, &material, NULL);
    ok(SUCCEEDED(hr), "Failed to create material, hr %#lx.\n", hr);
    hr = IDirect3DMaterial2_SetMaterial(material, mat);
    ok(SUCCEEDED(hr), "Failed to set material data, hr %#lx.\n", hr);
    IDirect3D2_Release(d3d);

    return material;
}

static IDirect3DMaterial2 *create_diffuse_material(IDirect3DDevice2 *device, float r, float g, float b, float a)
{
    D3DMATERIAL mat;

    memset(&mat, 0, sizeof(mat));
    mat.dwSize = sizeof(mat);
    mat.diffuse.r = r;
    mat.diffuse.g = g;
    mat.diffuse.b = b;
    mat.diffuse.a = a;

    return create_material(device, &mat);
}

static IDirect3DMaterial2 *create_diffuse_and_ambient_material(IDirect3DDevice2 *device,
        float r, float g, float b, float a)
{
    D3DMATERIAL mat;

    memset(&mat, 0, sizeof(mat));
    mat.dwSize = sizeof(mat);
    mat.diffuse.r = r;
    mat.diffuse.g = g;
    mat.diffuse.b = b;
    mat.diffuse.a = a;

    mat.ambient.r = r;
    mat.ambient.g = g;
    mat.ambient.b = b;
    mat.ambient.a = a;

    return create_material(device, &mat);
}

static IDirect3DMaterial2 *create_specular_material(IDirect3DDevice2 *device,
        float r, float g, float b, float a, float power)
{
    D3DMATERIAL mat;

    memset(&mat, 0, sizeof(mat));
    mat.dwSize = sizeof(mat);
    mat.specular.r = r;
    mat.specular.g = g;
    mat.specular.b = b;
    mat.specular.a = a;
    mat.power = power;

    return create_material(device, &mat);
}

static IDirect3DMaterial2 *create_emissive_material(IDirect3DDevice2 *device, float r, float g, float b, float a)
{
    D3DMATERIAL mat;

    memset(&mat, 0, sizeof(mat));
    mat.dwSize = sizeof(mat);
    mat.emissive.r = r;
    mat.emissive.g = g;
    mat.emissive.b = b;
    mat.emissive.a = a;

    return create_material(device, &mat);
}

static void destroy_material(IDirect3DMaterial2 *material)
{
    IDirect3DMaterial2_Release(material);
}

struct message
{
    UINT message;
    BOOL check_wparam;
    WPARAM expect_wparam;
};

static const struct message *expect_messages;

static LRESULT CALLBACK test_proc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam)
{
    if (expect_messages && message == expect_messages->message)
    {
        if (expect_messages->check_wparam)
            ok (wparam == expect_messages->expect_wparam,
                    "Got unexpected wparam %#Ix for message %#x, expected %#Ix.\n",
                    wparam, message, expect_messages->expect_wparam);

        ++expect_messages;
    }

    return DefWindowProcA(hwnd, message, wparam, lparam);
}

/* Set the wndproc back to what ddraw expects it to be, and release the ddraw
 * interface. This prevents subsequent SetCooperativeLevel() calls on a
 * different window from failing with DDERR_HWNDALREADYSET. */
static void fix_wndproc(HWND window, LONG_PTR proc)
{
    IDirectDraw2 *ddraw;
    HRESULT hr;

    if (!(ddraw = create_ddraw()))
        return;

    SetWindowLongPtrA(window, GWLP_WNDPROC, proc);
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);

    IDirectDraw2_Release(ddraw);
}

static HRESULT CALLBACK restore_callback(IDirectDrawSurface *surface, DDSURFACEDESC *desc, void *context)
{
    HRESULT hr = IDirectDrawSurface_Restore(surface);
    ok(SUCCEEDED(hr) || hr == DDERR_IMPLICITLYCREATED, "Failed to restore surface, hr %#lx.\n", hr);
    IDirectDrawSurface_Release(surface);

    return DDENUMRET_OK;
}

static HRESULT restore_surfaces(IDirectDraw2 *ddraw)
{
    return IDirectDraw2_EnumSurfaces(ddraw, DDENUMSURFACES_ALL | DDENUMSURFACES_DOESEXIST,
            NULL, NULL, restore_callback);
}

static void test_coop_level_create_device_window(void)
{
    HWND focus_window, device_window;
    IDirectDraw2 *ddraw;
    HRESULT hr;

    focus_window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, NULL, DDSCL_NORMAL);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    device_window = FindWindowA("DirectDrawDeviceWnd", "DirectDrawDeviceWnd");
    ok(!device_window, "Unexpected device window found.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, NULL, DDSCL_CREATEDEVICEWINDOW);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);
    device_window = FindWindowA("DirectDrawDeviceWnd", "DirectDrawDeviceWnd");
    ok(!device_window, "Unexpected device window found.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, NULL, DDSCL_CREATEDEVICEWINDOW | DDSCL_NORMAL);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);
    device_window = FindWindowA("DirectDrawDeviceWnd", "DirectDrawDeviceWnd");
    ok(!device_window, "Unexpected device window found.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, NULL, DDSCL_CREATEDEVICEWINDOW | DDSCL_NORMAL | DDSCL_FULLSCREEN);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);
    device_window = FindWindowA("DirectDrawDeviceWnd", "DirectDrawDeviceWnd");
    ok(!device_window, "Unexpected device window found.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, NULL, DDSCL_CREATEDEVICEWINDOW | DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(hr == DDERR_NOFOCUSWINDOW || broken(hr == DDERR_INVALIDPARAMS), "Got unexpected hr %#lx.\n", hr);
    device_window = FindWindowA("DirectDrawDeviceWnd", "DirectDrawDeviceWnd");
    ok(!device_window, "Unexpected device window found.\n");

    /* Windows versions before 98 / NT5 don't support DDSCL_CREATEDEVICEWINDOW. */
    if (broken(hr == DDERR_INVALIDPARAMS))
    {
        win_skip("DDSCL_CREATEDEVICEWINDOW not supported, skipping test.\n");
        IDirectDraw2_Release(ddraw);
        DestroyWindow(focus_window);
        return;
    }

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, NULL, DDSCL_NORMAL);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    device_window = FindWindowA("DirectDrawDeviceWnd", "DirectDrawDeviceWnd");
    ok(!device_window, "Unexpected device window found.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, focus_window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    device_window = FindWindowA("DirectDrawDeviceWnd", "DirectDrawDeviceWnd");
    ok(!device_window, "Unexpected device window found.\n");

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, NULL, DDSCL_NORMAL);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    device_window = FindWindowA("DirectDrawDeviceWnd", "DirectDrawDeviceWnd");
    ok(!device_window, "Unexpected device window found.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, NULL, DDSCL_SETFOCUSWINDOW
            | DDSCL_CREATEDEVICEWINDOW | DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(hr == DDERR_NOHWND, "Got unexpected hr %#lx.\n", hr);
    device_window = FindWindowA("DirectDrawDeviceWnd", "DirectDrawDeviceWnd");
    ok(!!device_window, "Device window not found.\n");

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, NULL, DDSCL_NORMAL);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    device_window = FindWindowA("DirectDrawDeviceWnd", "DirectDrawDeviceWnd");
    ok(!device_window, "Unexpected device window found.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, focus_window, DDSCL_SETFOCUSWINDOW
            | DDSCL_CREATEDEVICEWINDOW | DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    device_window = FindWindowA("DirectDrawDeviceWnd", "DirectDrawDeviceWnd");
    ok(!!device_window, "Device window not found.\n");

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, NULL, DDSCL_NORMAL);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    device_window = FindWindowA("DirectDrawDeviceWnd", "DirectDrawDeviceWnd");
    ok(!device_window, "Unexpected device window found.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, NULL, DDSCL_CREATEDEVICEWINDOW | DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(hr == DDERR_NOFOCUSWINDOW, "Got unexpected hr %#lx.\n", hr);
    device_window = FindWindowA("DirectDrawDeviceWnd", "DirectDrawDeviceWnd");
    ok(!device_window, "Unexpected device window found.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, focus_window, DDSCL_SETFOCUSWINDOW);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    device_window = FindWindowA("DirectDrawDeviceWnd", "DirectDrawDeviceWnd");
    ok(!device_window, "Unexpected device window found.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, NULL, DDSCL_CREATEDEVICEWINDOW | DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    device_window = FindWindowA("DirectDrawDeviceWnd", "DirectDrawDeviceWnd");
    ok(!!device_window, "Device window not found.\n");

    IDirectDraw2_Release(ddraw);
    DestroyWindow(focus_window);
}

static void test_clipper_blt(void)
{
    IDirectDrawSurface *src_surface, *dst_surface;
    unsigned int color, i, j, x, y;
    RECT client_rect, src_rect;
    IDirectDrawClipper *clipper;
    DDSURFACEDESC surface_desc;
    IDirectDraw2 *ddraw;
    RGNDATA *rgn_data;
    ULONG refcount;
    HRGN r1, r2;
    HWND window;
    DDBLTFX fx;
    HRESULT hr;
    DWORD *ptr;
    DWORD ret;

    static const DWORD src_data[] =
    {
        0xff0000ff, 0xff0000ff, 0xff00ff00, 0xffff0000, 0xffffffff, 0xffffffff,
        0xff0000ff, 0xff0000ff, 0xff00ff00, 0xffff0000, 0xffffffff, 0xffffffff,
        0xff0000ff, 0xff0000ff, 0xff00ff00, 0xffff0000, 0xffffffff, 0xffffffff,
    };
    static const unsigned int expected1[] =
    {
        0x000000ff, 0x0000ff00, 0x00000000, 0x00000000,
        0x000000ff, 0x0000ff00, 0x00000000, 0x00000000,
        0x00000000, 0x00000000, 0x00ff0000, 0x00ffffff,
        0x00000000, 0x00000000, 0x00ff0000, 0x00ffffff,
    };
    /* Nvidia on Windows seems to have an off-by-one error
     * when processing source rectangles. Our left = 1 and
     * right = 5 input reads from x = {1, 2, 3}. x = 4 is
     * read as well, but only for the edge pixels on the
     * output image. The bug happens on the y axis as well,
     * but we only read one row there, and all source rows
     * contain the same data. This bug is not dependent on
     * the presence of a clipper. */
    static const D3DCOLOR expected1_broken[] =
    {
        0x000000ff, 0x000000ff, 0x00000000, 0x00000000,
        0x000000ff, 0x000000ff, 0x00000000, 0x00000000,
        0x00000000, 0x00000000, 0x00ff0000, 0x00ff0000,
        0x00000000, 0x00000000, 0x0000ff00, 0x00ff0000,
    };
    static const unsigned int expected2[] =
    {
        0x000000ff, 0x000000ff, 0x00000000, 0x00000000,
        0x000000ff, 0x000000ff, 0x00000000, 0x00000000,
        0x00000000, 0x00000000, 0x000000ff, 0x000000ff,
        0x00000000, 0x00000000, 0x000000ff, 0x000000ff,
    };

    window = CreateWindowA("static", "ddraw_test", WS_OVERLAPPEDWINDOW,
            10, 10, 640, 480, 0, 0, 0, 0);
    ShowWindow(window, SW_SHOW);
    flush_events();

    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");

    ret = GetClientRect(window, &client_rect);
    ok(ret, "Failed to get client rect.\n");
    ret = MapWindowPoints(window, NULL, (POINT *)&client_rect, 2);
    ok(ret, "Failed to map client rect.\n");

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    hr = IDirectDraw2_CreateClipper(ddraw, 0, &clipper, NULL);
    ok(SUCCEEDED(hr), "Failed to create clipper, hr %#lx.\n", hr);
    hr = IDirectDrawClipper_GetClipList(clipper, NULL, NULL, &ret);
    ok(hr == DDERR_NOCLIPLIST, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawClipper_SetHWnd(clipper, 0, window);
    ok(SUCCEEDED(hr), "Failed to set clipper window, hr %#lx.\n", hr);
    hr = IDirectDrawClipper_GetClipList(clipper, NULL, NULL, &ret);
    ok(SUCCEEDED(hr), "Failed to get clip list size, hr %#lx.\n", hr);
    rgn_data = malloc(ret);
    hr = IDirectDrawClipper_GetClipList(clipper, NULL, rgn_data, &ret);
    ok(SUCCEEDED(hr), "Failed to get clip list, hr %#lx.\n", hr);
    ok(rgn_data->rdh.dwSize == sizeof(rgn_data->rdh), "Got unexpected structure size %#lx.\n", rgn_data->rdh.dwSize);
    ok(rgn_data->rdh.iType == RDH_RECTANGLES, "Got unexpected type %#lx.\n", rgn_data->rdh.iType);
    ok(rgn_data->rdh.nCount >= 1, "Got unexpected count %lu.\n", rgn_data->rdh.nCount);
    ok(EqualRect(&rgn_data->rdh.rcBound, &client_rect),
            "Got unexpected bounding rect %s, expected %s.\n",
            wine_dbgstr_rect(&rgn_data->rdh.rcBound), wine_dbgstr_rect(&client_rect));
    free(rgn_data);

    r1 = CreateRectRgn(0, 0, 320, 240);
    ok(!!r1, "Failed to create region.\n");
    r2 = CreateRectRgn(320, 240, 640, 480);
    ok(!!r2, "Failed to create region.\n");
    CombineRgn(r1, r1, r2, RGN_OR);
    ret = GetRegionData(r1, 0, NULL);
    rgn_data = malloc(ret);
    ret = GetRegionData(r1, ret, rgn_data);
    ok(!!ret, "Failed to get region data.\n");

    DeleteObject(r2);
    DeleteObject(r1);

    hr = IDirectDrawClipper_SetClipList(clipper, rgn_data, 0);
    ok(hr == DDERR_CLIPPERISUSINGHWND, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawClipper_SetHWnd(clipper, 0, NULL);
    ok(SUCCEEDED(hr), "Failed to set clipper window, hr %#lx.\n", hr);
    hr = IDirectDrawClipper_SetClipList(clipper, rgn_data, 0);
    ok(SUCCEEDED(hr), "Failed to set clip list, hr %#lx.\n", hr);

    free(rgn_data);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN;
    surface_desc.dwWidth = 640;
    surface_desc.dwHeight = 480;
    surface_desc.ddpfPixelFormat.dwSize = sizeof(surface_desc.ddpfPixelFormat);
    surface_desc.ddpfPixelFormat.dwFlags = DDPF_RGB;
    surface_desc.ddpfPixelFormat.dwRGBBitCount = 32;
    surface_desc.ddpfPixelFormat.dwRBitMask = 0x00ff0000;
    surface_desc.ddpfPixelFormat.dwGBitMask = 0x0000ff00;
    surface_desc.ddpfPixelFormat.dwBBitMask = 0x000000ff;

    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &src_surface, NULL);
    ok(SUCCEEDED(hr), "Failed to create source surface, hr %#lx.\n", hr);
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &dst_surface, NULL);
    ok(SUCCEEDED(hr), "Failed to create destination surface, hr %#lx.\n", hr);

    memset(&fx, 0, sizeof(fx));
    fx.dwSize = sizeof(fx);
    hr = IDirectDrawSurface_Blt(src_surface, NULL, NULL, NULL, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
    ok(SUCCEEDED(hr), "Failed to clear source surface, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Blt(dst_surface, NULL, NULL, NULL, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
    ok(SUCCEEDED(hr), "Failed to clear destination surface, hr %#lx.\n", hr);

    hr = IDirectDrawSurface_Lock(src_surface, NULL, &surface_desc, DDLOCK_WAIT, NULL);
    ok(SUCCEEDED(hr), "Failed to lock source surface, hr %#lx.\n", hr);
    ok(surface_desc.lPitch == 2560, "Got unexpected surface pitch %lu.\n", surface_desc.lPitch);
    ptr = surface_desc.lpSurface;
    memcpy(&ptr[   0], &src_data[ 0], 6 * sizeof(DWORD));
    memcpy(&ptr[ 640], &src_data[ 6], 6 * sizeof(DWORD));
    memcpy(&ptr[1280], &src_data[12], 6 * sizeof(DWORD));
    hr = IDirectDrawSurface_Unlock(src_surface, NULL);
    ok(SUCCEEDED(hr), "Failed to unlock source surface, hr %#lx.\n", hr);

    hr = IDirectDrawSurface_SetClipper(dst_surface, clipper);
    ok(SUCCEEDED(hr), "Failed to set clipper, hr %#lx.\n", hr);

    SetRect(&src_rect, 1, 1, 5, 2);
    hr = IDirectDrawSurface_Blt(dst_surface, NULL, src_surface, &src_rect, DDBLT_WAIT, NULL);
    ok(SUCCEEDED(hr), "Failed to blit, hr %#lx.\n", hr);
    for (i = 0; i < 4; ++i)
    {
        for (j = 0; j < 4; ++j)
        {
            x = 80 * ((2 * j) + 1);
            y = 60 * ((2 * i) + 1);
            color = get_surface_color(dst_surface, x, y);
            ok(compare_color(color, expected1[i * 4 + j], 1)
                    || broken(compare_color(color, expected1_broken[i * 4 + j], 1)),
                    "Expected color 0x%08x at %u,%u, got 0x%08x.\n", expected1[i * 4 + j], x, y, color);
        }
    }

    fx.dwFillColor = 0xff0000ff;
    hr = IDirectDrawSurface_Blt(dst_surface, NULL, NULL, NULL, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
    ok(SUCCEEDED(hr), "Failed to clear destination surface, hr %#lx.\n", hr);
    for (i = 0; i < 4; ++i)
    {
        for (j = 0; j < 4; ++j)
        {
            x = 80 * ((2 * j) + 1);
            y = 60 * ((2 * i) + 1);
            color = get_surface_color(dst_surface, x, y);
            ok(compare_color(color, expected2[i * 4 + j], 1),
                    "Expected color 0x%08x at %u,%u, got 0x%08x.\n", expected2[i * 4 + j], x, y, color);
        }
    }

    hr = IDirectDrawSurface_BltFast(dst_surface, 0, 0, src_surface, NULL, DDBLTFAST_WAIT);
    ok(hr == DDERR_BLTFASTCANTCLIP || broken(hr == E_NOTIMPL /* NT4 */), "Got unexpected hr %#lx.\n", hr);

    hr = IDirectDrawClipper_SetHWnd(clipper, 0, window);
    ok(SUCCEEDED(hr), "Failed to set clipper window, hr %#lx.\n", hr);
    hr = IDirectDrawClipper_GetClipList(clipper, NULL, NULL, &ret);
    ok(SUCCEEDED(hr), "Failed to get clip list size, hr %#lx.\n", hr);
    DestroyWindow(window);
    hr = IDirectDrawClipper_GetClipList(clipper, NULL, NULL, &ret);
    ok(hr == E_FAIL, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawClipper_SetHWnd(clipper, 0, NULL);
    ok(SUCCEEDED(hr), "Failed to set clipper window, hr %#lx.\n", hr);
    hr = IDirectDrawClipper_GetClipList(clipper, NULL, NULL, &ret);
    ok(SUCCEEDED(hr), "Failed to get clip list size, hr %#lx.\n", hr);
    hr = IDirectDrawClipper_SetClipList(clipper, NULL, 0);
    ok(SUCCEEDED(hr), "Failed to set clip list, hr %#lx.\n", hr);
    hr = IDirectDrawClipper_GetClipList(clipper, NULL, NULL, &ret);
    ok(hr == DDERR_NOCLIPLIST, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Blt(dst_surface, NULL, NULL, NULL, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
    ok(hr == DDERR_NOCLIPLIST, "Got unexpected hr %#lx.\n", hr);

    IDirectDrawSurface_Release(dst_surface);
    IDirectDrawSurface_Release(src_surface);
    refcount = IDirectDrawClipper_Release(clipper);
    ok(!refcount, "Clipper has %lu references left.\n", refcount);
    IDirectDraw2_Release(ddraw);
}

static void test_coop_level_d3d_state(void)
{
    D3DRECT clear_rect = {{0}, {0}, {640}, {480}};
    IDirectDrawSurface *rt, *surface;
    IDirect3DMaterial2 *background;
    IDirect3DViewport2 *viewport;
    IDirect3DDevice2 *device;
    D3DMATERIAL material;
    IDirectDraw2 *ddraw;
    DDSURFACEDESC lock;
    unsigned int color;
    DWORD value;
    HWND window;
    HRESULT hr;

    static D3DLVERTEX quad[] =
    {
        {{-1.0f}, {-1.0f}, {0.0f}, 0, {0x800000ff}},
        {{-1.0f}, { 1.0f}, {0.0f}, 0, {0x800000ff}},
        {{ 1.0f}, {-1.0f}, {0.0f}, 0, {0x800000ff}},
        {{ 1.0f}, { 1.0f}, {0.0f}, 0, {0x800000ff}},
    };

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");

    if (ddraw_is_warp(ddraw))
    {
        /* ddraw2 crashes in EndScene, and if it doesn't crash it fails with
         * DDERR_SURFACELOST on WARP. */
        win_skip("Skipping test that crashes WARP occasionally.\n");
        IDirectDraw2_Release(ddraw);
        DestroyWindow(window);
        return;
    }

    if (!(device = create_device(ddraw, window, DDSCL_NORMAL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        IDirectDraw2_Release(ddraw);
        DestroyWindow(window);
        return;
    }

    background = create_diffuse_material(device, 1.0f, 0.0f, 0.0f, 1.0f);
    viewport = create_viewport(device, 0, 0, 640, 480);
    viewport_set_background(device, viewport, background);

    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_SRCBLEND, D3DBLEND_SRCALPHA);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_DESTBLEND, D3DBLEND_DESTALPHA);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice2_GetRenderTarget(device, &rt);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_GetRenderState(device, D3DRENDERSTATE_ZENABLE, &value);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    ok(!!value, "Got unexpected z-enable state %#lx.\n", value);
    hr = IDirect3DDevice2_GetRenderState(device, D3DRENDERSTATE_ALPHABLENDENABLE, &value);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    ok(!value, "Got unexpected alpha blend enable state %#lx.\n", value);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_ALPHABLENDENABLE, TRUE);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    color = get_surface_color(rt, 320, 240);
    ok(compare_color(color, 0x00ff0000, 1), "Got unexpected color 0x%08x.\n", color);

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(rt);
    ok(hr == DDERR_SURFACELOST, "Got unexpected hr %#lx.\n", hr);

    memset(&lock, 0, sizeof(lock));
    lock.dwSize = sizeof(lock);
    lock.lpSurface = (void *)0xdeadbeef;
    hr = IDirectDrawSurface2_Lock(rt, NULL, &lock, DDLOCK_READONLY, NULL);
    ok(hr == DDERR_SURFACELOST, "Got unexpected hr %#lx.\n", hr);
    ok(lock.lpSurface == (void *)0xdeadbeef, "Got unexpected lock.lpSurface %p.\n", lock.lpSurface);

    hr = restore_surfaces(ddraw);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirectDrawSurface2_Lock(rt, NULL, &lock, DDLOCK_READONLY, NULL);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface2_Unlock(rt, NULL);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

    memset(&material, 0, sizeof(material));
    material.dwSize = sizeof(material);
    material.diffuse.r = 0.0f;
    material.diffuse.g = 1.0f;
    material.diffuse.b = 0.0f;
    material.diffuse.a = 1.0f;
    hr = IDirect3DMaterial2_SetMaterial(background, &material);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice2_GetRenderTarget(device, &surface);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    ok(surface == rt, "Got unexpected surface %p.\n", surface);
    hr = IDirect3DDevice2_GetRenderState(device, D3DRENDERSTATE_ZENABLE, &value);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    ok(!!value, "Got unexpected z-enable state %#lx.\n", value);
    hr = IDirect3DDevice2_GetRenderState(device, D3DRENDERSTATE_ALPHABLENDENABLE, &value);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    ok(!!value, "Got unexpected alpha blend enable state %#lx.\n", value);
    hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    color = get_surface_color(rt, 320, 240);
    ok(compare_color(color, 0x0000ff00, 1) || broken(compare_color(color, 0x00000000, 1)),
            "Got unexpected color 0x%08x.\n", color);

    hr = IDirect3DDevice2_SetCurrentViewport(device, viewport);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_BeginScene(device);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, D3DVT_LVERTEX, quad, ARRAY_SIZE(quad), 0);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_EndScene(device);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    color = get_surface_color(rt, 320, 240);
    ok(compare_color(color, 0x0000ff80, 1), "Got unexpected color 0x%08x.\n", color);

    destroy_viewport(device, viewport);
    destroy_material(background);
    IDirectDrawSurface_Release(surface);
    IDirectDrawSurface_Release(rt);
    IDirect3DDevice2_Release(device);
    IDirectDraw2_Release(ddraw);
    DestroyWindow(window);
}

static void test_surface_interface_mismatch(void)
{
    IDirectDraw2 *ddraw = NULL;
    IDirect3D2 *d3d = NULL;
    IDirectDrawSurface *surface = NULL, *ds;
    IDirectDrawSurface3 *surface3 = NULL;
    IDirect3DDevice2 *device = NULL;
    IDirect3DViewport2 *viewport = NULL;
    IDirect3DMaterial2 *background = NULL;
    DDSURFACEDESC surface_desc;
    unsigned int color;
    DWORD z_depth = 0;
    ULONG refcount;
    HRESULT hr;
    HWND window;
    D3DRECT clear_rect = {{0}, {0}, {640}, {480}};

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    if (!(device = create_device(ddraw, window, DDSCL_NORMAL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        IDirectDraw2_Release(ddraw);
        DestroyWindow(window);
        return;
    }
    z_depth = get_device_z_depth(device);
    ok(!!z_depth, "Failed to get device z depth.\n");
    IDirect3DDevice2_Release(device);
    device = NULL;

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN | DDSCAPS_3DDEVICE;
    surface_desc.dwWidth = 640;
    surface_desc.dwHeight = 480;

    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

    hr = IDirectDrawSurface2_QueryInterface(surface, &IID_IDirectDrawSurface3, (void **)&surface3);
    if (FAILED(hr))
    {
        skip("Failed to get the IDirectDrawSurface3 interface, skipping test.\n");
        goto cleanup;
    }

    if (FAILED(IDirectDraw2_QueryInterface(ddraw, &IID_IDirect3D2, (void **)&d3d)))
    {
        skip("D3D interface is not available, skipping test.\n");
        goto cleanup;
    }

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_ZBUFFERBITDEPTH | DDSD_WIDTH | DDSD_HEIGHT;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_ZBUFFER;
    surface_desc.dwZBufferBitDepth = z_depth;
    surface_desc.dwWidth = 640;
    surface_desc.dwHeight = 480;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &ds, NULL);
    ok(SUCCEEDED(hr), "Failed to create depth buffer, hr %#lx.\n", hr);
    if (FAILED(hr))
        goto cleanup;

    /* Using a different surface interface version still works */
    hr = IDirectDrawSurface3_AddAttachedSurface(surface3, (IDirectDrawSurface3 *)ds);
    ok(SUCCEEDED(hr), "Failed to attach depth buffer, hr %#lx.\n", hr);
    refcount = IDirectDrawSurface_Release(ds);
    ok(refcount == 1, "Got unexpected refcount %lu.\n", refcount);
    if (FAILED(hr))
        goto cleanup;

    /* Here too */
    hr = IDirect3D2_CreateDevice(d3d, &IID_IDirect3DHALDevice, (IDirectDrawSurface *)surface3, &device);
    ok(SUCCEEDED(hr), "Failed to create d3d device.\n");
    if (FAILED(hr))
        goto cleanup;

    background = create_diffuse_material(device, 1.0f, 0.0f, 0.0f, 1.0f);
    viewport = create_viewport(device, 0, 0, 640, 480);
    viewport_set_background(device, viewport, background);

    hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET);
    ok(SUCCEEDED(hr), "Failed to clear render target, hr %#lx.\n", hr);
    color = get_surface_color(surface, 320, 240);
    ok(compare_color(color, 0x00ff0000, 1), "Got unexpected color 0x%08x.\n", color);

cleanup:
    if (viewport)
        destroy_viewport(device, viewport);
    if (background)
        destroy_material(background);
    if (surface3) IDirectDrawSurface3_Release(surface3);
    if (surface) IDirectDrawSurface_Release(surface);
    if (device) IDirect3DDevice2_Release(device);
    if (d3d) IDirect3D2_Release(d3d);
    if (ddraw) IDirectDraw2_Release(ddraw);
    DestroyWindow(window);
}

static void test_coop_level_threaded(void)
{
    struct create_window_thread_param p;
    IDirectDraw2 *ddraw;
    HRESULT hr;

    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    create_window_thread(&p);

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, p.window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    destroy_window_thread(&p);
    IDirectDraw2_Release(ddraw);
}

static void test_depth_blit(const GUID *device_guid)
{
    static D3DLVERTEX quad1[] =
    {
        {{-1.0}, { 1.0}, {0.50f}, 0, {0xff00ff00}},
        {{ 1.0}, { 1.0}, {0.50f}, 0, {0xff00ff00}},
        {{-1.0}, {-1.0}, {0.50f}, 0, {0xff00ff00}},
        {{ 1.0}, {-1.0}, {0.50f}, 0, {0xff00ff00}},
    };
    static const unsigned int expected_colors[4][4] =
    {
        {0x00ff0000, 0x00ff0000, 0x0000ff00, 0x0000ff00},
        {0x00ff0000, 0x00ff0000, 0x0000ff00, 0x0000ff00},
        {0x0000ff00, 0x0000ff00, 0x0000ff00, 0x0000ff00},
        {0x0000ff00, 0x0000ff00, 0x0000ff00, 0x0000ff00},
    };
    DDSURFACEDESC ddsd_new, ddsd_existing;

    IDirect3DDevice2 *device;
    IDirectDrawSurface *ds1, *ds2, *ds3, *rt;
    BOOL depth_fill_broken = FALSE;
    IDirect3DViewport2 *viewport;
    RECT src_rect, dst_rect;
    unsigned int color, i, j;
    HRESULT hr;
    IDirectDraw2 *ddraw;
    DDBLTFX fx;
    HWND window;
    D3DRECT d3drect;
    IDirect3DMaterial2 *background;

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    if (!(device = create_device_ex(ddraw, window, DDSCL_NORMAL, device_guid, NULL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        IDirectDraw2_Release(ddraw);
        DestroyWindow(window);
        return;
    }

    ds1 = get_depth_stencil(device);

    memset(&ddsd_new, 0, sizeof(ddsd_new));
    ddsd_new.dwSize = sizeof(ddsd_new);
    memset(&ddsd_existing, 0, sizeof(ddsd_existing));
    ddsd_existing.dwSize = sizeof(ddsd_existing);
    hr = IDirectDrawSurface_GetSurfaceDesc(ds1, &ddsd_existing);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    ddsd_new.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT;
    ddsd_new.ddsCaps.dwCaps = DDSCAPS_ZBUFFER;
    if (is_software_device_type(device_guid))
        ddsd_new.ddsCaps.dwCaps |= DDSCAPS_SYSTEMMEMORY;
    ddsd_new.dwWidth = ddsd_existing.dwWidth;
    ddsd_new.dwHeight = ddsd_existing.dwHeight;
    ddsd_new.ddpfPixelFormat = ddsd_existing.ddpfPixelFormat;
    hr = IDirectDraw2_CreateSurface(ddraw, &ddsd_new, &ds2, NULL);
    ok(SUCCEEDED(hr), "Failed to create a surface, hr %#lx.\n", hr);
    hr = IDirectDraw2_CreateSurface(ddraw, &ddsd_new, &ds3, NULL);
    ok(SUCCEEDED(hr), "Failed to create a surface, hr %#lx.\n", hr);

    background = create_diffuse_material(device, 1.0f, 0.0f, 0.0f, 1.0f);
    viewport = create_viewport(device, 0, 0, ddsd_existing.dwWidth, ddsd_existing.dwHeight);
    viewport_set_background(device, viewport, background);
    hr = IDirect3DDevice2_SetCurrentViewport(device, viewport);
    ok(SUCCEEDED(hr), "Failed to activate the viewport, hr %#lx.\n", hr);

    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_ZENABLE, D3DZB_TRUE);
    ok(SUCCEEDED(hr), "Failed to enable z testing, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_ZFUNC, D3DCMP_LESSEQUAL);
    ok(SUCCEEDED(hr), "Failed to set the z function, hr %#lx.\n", hr);

    d3drect.x1 = d3drect.y1 = 0;
    d3drect.x2 = ddsd_existing.dwWidth; d3drect.y2 = ddsd_existing.dwHeight;
    hr = IDirect3DViewport2_Clear(viewport, 1, &d3drect, D3DCLEAR_ZBUFFER);
    ok(SUCCEEDED(hr), "Failed to clear the z buffer, hr %#lx.\n", hr);

    /* Partial blit. */
    SetRect(&src_rect, 0, 0, 320, 240);
    SetRect(&dst_rect, 0, 0, 320, 240);
    hr = IDirectDrawSurface_Blt(ds2, &dst_rect, ds1, &src_rect, DDBLT_WAIT, NULL);
    ok(SUCCEEDED(hr), "Got unexpected hr %#lx.\n", hr);
    /* Different locations. */
    SetRect(&src_rect, 0, 0, 320, 240);
    SetRect(&dst_rect, 320, 240, 640, 480);
    hr = IDirectDrawSurface_Blt(ds2, &dst_rect, ds1, &src_rect, DDBLT_WAIT, NULL);
    ok(SUCCEEDED(hr), "Got unexpected hr %#lx.\n", hr);
    /* Stretched. */
    SetRect(&src_rect, 0, 0, 320, 240);
    SetRect(&dst_rect, 0, 0, 640, 480);
    hr = IDirectDrawSurface_Blt(ds2, &dst_rect, ds1, &src_rect, DDBLT_WAIT, NULL);
    ok(SUCCEEDED(hr), "Got unexpected hr %#lx.\n", hr);
    /* Flipped. */
    SetRect(&src_rect, 0, 480, 640, 0);
    SetRect(&dst_rect, 0, 0, 640, 480);
    hr = IDirectDrawSurface_Blt(ds2, &dst_rect, ds1, &src_rect, DDBLT_WAIT, NULL);
    ok(hr == DDERR_INVALIDRECT, "Got unexpected hr %#lx.\n", hr);
    SetRect(&src_rect, 0, 0, 640, 480);
    SetRect(&dst_rect, 0, 480, 640, 0);
    hr = IDirectDrawSurface_Blt(ds2, &dst_rect, ds1, &src_rect, DDBLT_WAIT, NULL);
    ok(hr == DDERR_INVALIDRECT, "Got unexpected hr %#lx.\n", hr);
    /* Full, explicit. */
    SetRect(&src_rect, 0, 0, 640, 480);
    SetRect(&dst_rect, 0, 0, 640, 480);
    hr = IDirectDrawSurface_Blt(ds2, &dst_rect, ds1, &src_rect, DDBLT_WAIT, NULL);
    ok(SUCCEEDED(hr), "Got unexpected hr %#lx.\n", hr);
    /* Depth -> color blit: Succeeds on Win7 + Radeon HD 5700, fails on WinXP + Radeon X1600 */

    /* Depth blit inside a BeginScene / EndScene pair */
    hr = IDirect3DDevice2_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to start a scene, hr %#lx.\n", hr);
    /* From the current depth stencil */
    hr = IDirectDrawSurface_Blt(ds2, NULL, ds1, NULL, DDBLT_WAIT, NULL);
    ok(SUCCEEDED(hr), "Got unexpected hr %#lx.\n", hr);
    /* To the current depth stencil */
    hr = IDirectDrawSurface_Blt(ds1, NULL, ds2, NULL, DDBLT_WAIT, NULL);
    ok(SUCCEEDED(hr), "Got unexpected hr %#lx.\n", hr);
    /* Between unbound surfaces */
    hr = IDirectDrawSurface_Blt(ds3, NULL, ds2, NULL, DDBLT_WAIT, NULL);
    ok(SUCCEEDED(hr), "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end a scene, hr %#lx.\n", hr);

    /* Avoid changing the depth stencil, it doesn't work properly on Windows.
     * Instead use DDBLT_DEPTHFILL to clear the depth stencil. Unfortunately
     * drivers disagree on the meaning of dwFillDepth. Only 0 seems to produce
     * a reliable result(z = 0.0) */
    memset(&fx, 0, sizeof(fx));
    fx.dwSize = sizeof(fx);
    fx.dwFillDepth = 0;
    hr = IDirectDrawSurface_Blt(ds2, NULL, NULL, NULL, DDBLT_DEPTHFILL | DDBLT_WAIT, &fx);
    ok(hr == D3D_OK || broken(is_software_device_type(device_guid)
            && hr == 0x8876086c /* D3DERR_INVALIDCALL */), "Got unexpected hr %#lx.\n", hr);
    if (hr != D3D_OK)
        depth_fill_broken = TRUE;

    /* This clears the Z buffer with 1.0 */
    hr = IDirect3DViewport2_Clear(viewport, 1, &d3drect, D3DCLEAR_ZBUFFER | D3DCLEAR_TARGET);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice2_GetRenderTarget(device, &rt);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    color = get_surface_color(rt, 80, 60);
    /* For some reason clears and colour fill blits randomly fail with software render target. */
    ok(color == 0x00ff0000 || broken(is_software_device_type(device_guid) && !color),
            "Got unexpected colour 0x%08x.\n", color);
    if (!color)
    {
        fill_surface(rt, 0xffff0000);

        color = get_surface_color(rt, 80, 60);
        ok(color == 0x00ff0000, "Got unexpected colour 0x%08x.\n", color);
    }

    SetRect(&dst_rect, 0, 0, 320, 240);
    hr = IDirectDrawSurface_Blt(ds1, &dst_rect, ds2, NULL, DDBLT_WAIT, NULL);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    IDirectDrawSurface_Release(ds3);
    IDirectDrawSurface_Release(ds2);
    IDirectDrawSurface_Release(ds1);

    hr = IDirect3DDevice2_BeginScene(device);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, D3DVT_LVERTEX, quad1, 4, 0);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_EndScene(device);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    for (i = 0; i < 4; ++i)
    {
        for (j = 0; j < 4; ++j)
        {
            unsigned int x = 80 * ((2 * j) + 1);
            unsigned int y = 60 * ((2 * i) + 1);
            color = get_surface_color(rt, x, y);
            ok(compare_color(color, expected_colors[i][j], 1) || broken(depth_fill_broken && color == 0x0000ff00),
                    "Expected color 0x%08x at %u,%u, got 0x%08x.\n", expected_colors[i][j], x, y, color);
        }
    }
    IDirectDrawSurface_Release(rt);

    destroy_viewport(device, viewport);
    destroy_material(background);
    IDirect3DDevice2_Release(device);
    IDirectDraw2_Release(ddraw);
    DestroyWindow(window);
}

static void test_texture_load_ckey(void)
{
    IDirectDraw2 *ddraw = NULL;
    IDirectDrawSurface *src = NULL;
    IDirectDrawSurface *dst = NULL;
    IDirect3DTexture *src_tex = NULL;
    IDirect3DTexture *dst_tex = NULL;
    DDSURFACEDESC ddsd;
    HRESULT hr;
    DDCOLORKEY ckey;

    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, NULL, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    memset(&ddsd, 0, sizeof(ddsd));
    ddsd.dwSize = sizeof(ddsd);
    ddsd.dwFlags = DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH;
    ddsd.dwHeight = 128;
    ddsd.dwWidth = 128;
    ddsd.ddsCaps.dwCaps = DDSCAPS_TEXTURE | DDSCAPS_SYSTEMMEMORY;
    hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &src, NULL);
    ok(SUCCEEDED(hr), "Failed to create source texture, hr %#lx.\n", hr);
    ddsd.ddsCaps.dwCaps = DDSCAPS_TEXTURE;
    hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &dst, NULL);
    ok(SUCCEEDED(hr), "Failed to create destination texture, hr %#lx.\n", hr);

    hr = IDirectDrawSurface_QueryInterface(src, &IID_IDirect3DTexture, (void **)&src_tex);
    ok(SUCCEEDED(hr) || hr == E_NOINTERFACE, "Failed to get Direct3DTexture interface, hr %#lx.\n", hr);
    if (FAILED(hr))
    {
        /* 64 bit ddraw does not support d3d */
        skip("Could not get Direct3DTexture interface, skipping texture::Load color keying tests.\n");
        goto done;
    }
    hr = IDirectDrawSurface_QueryInterface(dst, &IID_IDirect3DTexture, (void **)&dst_tex);
    ok(SUCCEEDED(hr), "Failed to get Direct3DTexture interface, hr %#lx.\n", hr);

    /* No surface has a color key */
    hr = IDirect3DTexture_Load(dst_tex, src_tex);
    ok(SUCCEEDED(hr) || broken(hr == DDERR_INVALIDCAPS), "Got unexpected hr %#lx.\n", hr);
    if (FAILED(hr))
    {
        /* Testbot Windows NT VMs */
        skip("IDirect3DTexture::Load does not work, skipping color keying tests.\n");
        goto done;
    }

    ckey.dwColorSpaceLowValue = ckey.dwColorSpaceHighValue = 0xdeadbeef;
    hr = IDirectDrawSurface_GetColorKey(dst, DDCKEY_SRCBLT, &ckey);
    ok(hr == DDERR_NOCOLORKEY, "Got unexpected hr %#lx.\n", hr);
    ok(ckey.dwColorSpaceLowValue == 0xdeadbeef, "Got unexpected value 0x%08lx.\n", ckey.dwColorSpaceLowValue);
    ok(ckey.dwColorSpaceHighValue == 0xdeadbeef, "Got unexpected value 0x%08lx.\n", ckey.dwColorSpaceHighValue);

    /* Source surface has a color key */
    ckey.dwColorSpaceLowValue = ckey.dwColorSpaceHighValue = 0x0000ff00;
    hr = IDirectDrawSurface_SetColorKey(src, DDCKEY_SRCBLT, &ckey);
    ok(SUCCEEDED(hr), "Failed to set color key, hr %#lx.\n", hr);
    hr = IDirect3DTexture_Load(dst_tex, src_tex);
    ok(SUCCEEDED(hr), "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_GetColorKey(dst, DDCKEY_SRCBLT, &ckey);
    ok(SUCCEEDED(hr), "Got unexpected hr %#lx.\n", hr);
    ok(ckey.dwColorSpaceLowValue == 0x0000ff00, "Got unexpected value 0x%08lx.\n", ckey.dwColorSpaceLowValue);
    ok(ckey.dwColorSpaceHighValue == 0x0000ff00, "Got unexpected value 0x%08lx.\n", ckey.dwColorSpaceHighValue);

    /* Both surfaces have a color key: Dest ckey is overwritten */
    ckey.dwColorSpaceLowValue = ckey.dwColorSpaceHighValue = 0x000000ff;
    hr = IDirectDrawSurface_SetColorKey(dst, DDCKEY_SRCBLT, &ckey);
    ok(SUCCEEDED(hr), "Failed to set color key, hr %#lx.\n", hr);
    hr = IDirect3DTexture_Load(dst_tex, src_tex);
    ok(SUCCEEDED(hr), "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_GetColorKey(dst, DDCKEY_SRCBLT, &ckey);
    ok(SUCCEEDED(hr), "Got unexpected hr %#lx.\n", hr);
    ok(ckey.dwColorSpaceLowValue == 0x0000ff00, "Got unexpected value 0x%08lx.\n", ckey.dwColorSpaceLowValue);
    ok(ckey.dwColorSpaceHighValue == 0x0000ff00, "Got unexpected value 0x%08lx.\n", ckey.dwColorSpaceHighValue);

    /* Only the destination has a color key: It is not deleted */
    hr = IDirectDrawSurface_SetColorKey(src, DDCKEY_SRCBLT, NULL);
    ok(SUCCEEDED(hr), "Failed to set color key, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_GetColorKey(src, DDCKEY_SRCBLT, &ckey);
    ok(hr == DDERR_NOCOLORKEY, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DTexture_Load(dst_tex, src_tex);
    ok(SUCCEEDED(hr), "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_GetColorKey(dst, DDCKEY_SRCBLT, &ckey);
    ok(SUCCEEDED(hr), "Got unexpected hr %#lx.\n", hr);
    ok(ckey.dwColorSpaceLowValue == 0x0000ff00, "Got unexpected value 0x%08lx.\n", ckey.dwColorSpaceLowValue);
    ok(ckey.dwColorSpaceHighValue == 0x0000ff00, "Got unexpected value 0x%08lx.\n", ckey.dwColorSpaceHighValue);

done:
    if (dst_tex) IDirect3DTexture_Release(dst_tex);
    if (src_tex) IDirect3DTexture_Release(src_tex);
    if (dst) IDirectDrawSurface_Release(dst);
    if (src) IDirectDrawSurface_Release(src);
    if (ddraw) IDirectDraw2_Release(ddraw);
}

static BOOL compare_mode_rect(const DEVMODEA *mode1, const DEVMODEA *mode2)
{
    return mode1->dmPosition.x == mode2->dmPosition.x
            && mode1->dmPosition.y == mode2->dmPosition.y
            && mode1->dmPelsWidth == mode2->dmPelsWidth
            && mode1->dmPelsHeight == mode2->dmPelsHeight;
}

static void init_format_b8g8r8x8(DDPIXELFORMAT *format)
{
    format->dwSize = sizeof(*format);
    format->dwFlags = DDPF_RGB;
    format->dwRGBBitCount = 32;
    format->dwRBitMask = 0x00ff0000;
    format->dwGBitMask = 0x0000ff00;
    format->dwBBitMask = 0x000000ff;
}

static ULONG get_refcount(IUnknown *test_iface)
{
    IUnknown_AddRef(test_iface);
    return IUnknown_Release(test_iface);
}

static void test_viewport_object(void)
{
    IDirectDraw2 *ddraw;
    IDirect3D2 *d3d;
    HRESULT hr;
    ULONG ref, old_d3d_ref;
    D3DVIEWPORT vp;
    D3DVIEWPORT2 vp2;
    IDirect3DViewport *viewport;
    IDirect3DViewport2 *viewport2, *another_vp, *test_vp;
    IDirect3DViewport3 *viewport3;
    IDirectDrawGammaControl *gamma;
    IUnknown *unknown;
    IDirect3DDevice2 *device;
    HWND window;
    union
    {
        D3DVIEWPORT2 vp2;
        D3DVIEWPORT vp1;
        BYTE blob[1024];
    } desc;

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    if (!(device = create_device(ddraw, window, DDSCL_NORMAL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        IDirectDraw2_Release(ddraw);
        DestroyWindow(window);
        return;
    }

    hr = IDirectDraw2_QueryInterface(ddraw, &IID_IDirect3D2, (void **)&d3d);
    ok(SUCCEEDED(hr) || hr == E_NOINTERFACE, "Failed to get d3d interface, hr %#lx.\n", hr);
    if (FAILED(hr))
    {
        skip("D3D interface is not available, skipping test.\n");
        IDirectDraw2_Release(ddraw);
        return;
    }
    old_d3d_ref = get_refcount((IUnknown *)d3d);

    hr = IDirect3D2_CreateViewport(d3d, &viewport2, NULL);
    ok(SUCCEEDED(hr), "Failed to create viewport, hr %#lx.\n", hr);
    ref = get_refcount((IUnknown *)viewport2);
    ok(ref == 1, "Got unexpected refcount %lu.\n", ref);
    ref = get_refcount((IUnknown *)d3d);
    ok(ref == old_d3d_ref, "Got unexpected refcount %lu.\n", ref);

    memset(&desc, 0, sizeof(desc));
    hr = IDirect3DViewport2_GetViewport(viewport2, &desc.vp1);
    todo_wine ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);
    desc.vp1.dwSize = sizeof(desc.vp1) + 1;
    hr = IDirect3DViewport2_GetViewport(viewport2, &desc.vp1);
    todo_wine ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);
    desc.vp1.dwSize = sizeof(desc.vp1) - 1;
    hr = IDirect3DViewport2_GetViewport(viewport2, &desc.vp1);
    todo_wine ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);
    desc.vp1.dwSize = sizeof(desc.vp1);
    hr = IDirect3DViewport2_GetViewport(viewport2, &desc.vp1);
    ok(hr == D3DERR_VIEWPORTDATANOTSET, "Got unexpected hr %#lx.\n", hr);
    ok(desc.vp1.dwSize == sizeof(desc.vp1), "Got unexpected dwSize %lu.\n", desc.vp1.dwSize);
    hr = IDirect3DViewport2_GetViewport2(viewport2, &desc.vp2);
    ok(hr == D3DERR_VIEWPORTDATANOTSET, "Got unexpected hr %#lx.\n", hr);
    ok(desc.vp2.dwSize == sizeof(desc.vp2), "Got unexpected dwSize %lu.\n", desc.vp2.dwSize);
    desc.vp2.dwSize = sizeof(desc.vp2) + 1;
    hr = IDirect3DViewport2_GetViewport2(viewport2, &desc.vp2);
    todo_wine ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);

    gamma = (IDirectDrawGammaControl *)0xdeadbeef;
    hr = IDirect3DViewport2_QueryInterface(viewport2, &IID_IDirectDrawGammaControl, (void **)&gamma);
    ok(hr == E_NOINTERFACE, "Got unexpected hr %#lx.\n", hr);
    ok(!gamma, "Interface not set to NULL by failed QI call: %p\n", gamma);
    /* NULL iid: Segfaults */

    hr = IDirect3DViewport2_QueryInterface(viewport2, &IID_IDirect3DViewport, (void **)&viewport);
    ok(SUCCEEDED(hr), "Failed to QI IDirect3DViewport, hr %#lx.\n", hr);
    ref = get_refcount((IUnknown *)viewport);
    ok(ref == 2, "Got unexpected refcount %lu.\n", ref);
    ref = get_refcount((IUnknown *)viewport2);
    ok(ref == 2, "Got unexpected refcount %lu.\n", ref);
    IDirect3DViewport_Release(viewport);
    viewport = NULL;

    hr = IDirect3DViewport2_QueryInterface(viewport2, &IID_IDirect3DViewport3, (void **)&viewport3);
    ok(SUCCEEDED(hr) || hr == E_NOINTERFACE, "Failed to QI IDirect3DViewport3, hr %#lx.\n", hr);
    if (viewport3)
    {
        ref = get_refcount((IUnknown *)viewport2);
        ok(ref == 2, "Got unexpected refcount %lu.\n", ref);
        ref = get_refcount((IUnknown *)viewport3);
        ok(ref == 2, "Got unexpected refcount %lu.\n", ref);
        IDirect3DViewport3_Release(viewport3);
    }

    hr = IDirect3DViewport2_QueryInterface(viewport2, &IID_IUnknown, (void **)&unknown);
    ok(SUCCEEDED(hr), "Failed to QI IUnknown, hr %#lx.\n", hr);
    ref = get_refcount((IUnknown *)viewport2);
    ok(ref == 2, "Got unexpected refcount %lu.\n", ref);
    ref = get_refcount(unknown);
    ok(ref == 2, "Got unexpected refcount %lu.\n", ref);
    IUnknown_Release(unknown);

    hr = IDirect3DDevice2_DeleteViewport(device, NULL);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_GetCurrentViewport(device, NULL);
    ok(hr == D3DERR_NOCURRENTVIEWPORT, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3D2_CreateViewport(d3d, &another_vp, NULL);
    ok(SUCCEEDED(hr), "Failed to create viewport, hr %#lx.\n", hr);

    /* Setting a viewport not in the viewport list fails */
    hr = IDirect3DDevice2_SetCurrentViewport(device, another_vp);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);

    /* AddViewport(NULL): Segfault */
    hr = IDirect3DDevice2_AddViewport(device, viewport2);
    ok(SUCCEEDED(hr), "Failed to add viewport to device, hr %#lx.\n", hr);
    ref = get_refcount((IUnknown *) viewport2);
    ok(ref == 2, "viewport2 refcount is %lu.\n", ref);
    hr = IDirect3DDevice2_AddViewport(device, another_vp);
    ok(SUCCEEDED(hr), "Failed to add viewport to device, hr %#lx.\n", hr);
    ref = get_refcount((IUnknown *) another_vp);
    ok(ref == 2, "another_vp refcount is %lu.\n", ref);

    test_vp = (IDirect3DViewport2 *) 0xbaadc0de;
    hr = IDirect3DDevice2_GetCurrentViewport(device, &test_vp);
    ok(hr == D3DERR_NOCURRENTVIEWPORT, "Got unexpected hr %#lx.\n", hr);
    ok(test_vp == (IDirect3DViewport2 *) 0xbaadc0de, "Got unexpected pointer %p\n", test_vp);

    hr = IDirect3DDevice2_SetCurrentViewport(device, viewport2);
    ok(SUCCEEDED(hr), "Failed to set current viewport, hr %#lx.\n", hr);
    ref = get_refcount((IUnknown *) viewport2);
    ok(ref == 3, "Got unexpected refcount %lu.\n", ref);
    ref = get_refcount((IUnknown *) device);
    ok(ref == 1, "Got unexpected refcount %lu.\n", ref);

    test_vp = NULL;
    hr = IDirect3DDevice2_GetCurrentViewport(device, &test_vp);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    ok(test_vp == viewport2, "Got unexpected viewport %p\n", test_vp);
    ref = get_refcount((IUnknown *) viewport2);
    ok(ref == 4, "Got unexpected refcount %lu.\n", ref);
    if (test_vp)
        IDirect3DViewport2_Release(test_vp);

    /* GetCurrentViewport with a viewport set and NULL input param: Segfault */

    /* Cannot set the viewport to NULL */
    hr = IDirect3DDevice2_SetCurrentViewport(device, NULL);
    ok(hr == DDERR_INVALIDPARAMS, "Failed to set viewport to NULL, hr %#lx.\n", hr);
    test_vp = NULL;
    hr = IDirect3DDevice2_GetCurrentViewport(device, &test_vp);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    ok(test_vp == viewport2, "Got unexpected viewport %p\n", test_vp);
    if (test_vp)
        IDirect3DViewport2_Release(test_vp);

    /* SetCurrentViewport properly releases the old viewport's reference */
    hr = IDirect3DDevice2_SetCurrentViewport(device, another_vp);
    ok(SUCCEEDED(hr), "Failed to set current viewport, hr %#lx.\n", hr);
    ref = get_refcount((IUnknown *) viewport2);
    ok(ref == 2, "Got unexpected refcount %lu.\n", ref);
    ref = get_refcount((IUnknown *) another_vp);
    ok(ref == 3, "Got unexpected refcount %lu.\n", ref);

    /* Deleting the viewport removes the reference added by AddViewport, but not
     * the one added by SetCurrentViewport. */
    hr = IDirect3DDevice2_DeleteViewport(device, another_vp);
    ok(SUCCEEDED(hr), "Failed to delete viewport from device, hr %#lx.\n", hr);
    ref = get_refcount((IUnknown *) another_vp);
    todo_wine ok(ref == 2, "Got unexpected refcount %lu.\n", ref);

    /* GetCurrentViewport fails though */
    test_vp = NULL;
    hr = IDirect3DDevice2_GetCurrentViewport(device, &test_vp);
    ok(hr == D3DERR_NOCURRENTVIEWPORT, "Got unexpected hr %#lx.\n", hr);
    ok(!test_vp, "Got unexpected viewport %p\n", test_vp);

    /* Setting a different viewport does not free the leaked reference. How
     * do I get rid of it? Leak the viewport for now. */
    hr = IDirect3DDevice2_SetCurrentViewport(device, viewport2);
    ok(SUCCEEDED(hr), "Failed to set current viewport, hr %#lx.\n", hr);
    ref = get_refcount((IUnknown *) viewport2);
    ok(ref == 3, "Got unexpected refcount %lu.\n", ref);
    ref = get_refcount((IUnknown *) another_vp);
    todo_wine ok(ref == 2, "Got unexpected refcount %lu.\n", ref);

    memset(&vp, 0, sizeof(vp));
    memset(&vp, 0, sizeof(vp2));
    vp.dwX = vp2.dwX = 0;
    vp.dwY = vp2.dwY = 0;
    vp.dwWidth = vp2.dwWidth = 640;
    vp.dwHeight = vp2.dwHeight = 480;
    vp.dvMinZ = vp2.dvMinZ = 0.0f;
    vp.dvMaxZ = vp2.dvMaxZ = 1.0f;
    vp.dvScaleX = vp.dwWidth / 2.0f;
    vp.dvScaleY = vp.dwHeight / 2.0f;
    vp.dvMaxX = 1.0f;
    vp.dvMaxY = 1.0f;
    vp2.dvClipX = -1.0f;
    vp2.dvClipY =  1.0f;
    vp2.dvClipWidth = 2.0f;
    vp2.dvClipHeight = 2.0f;
    hr = IDirect3DViewport2_SetViewport(viewport2, &vp);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DViewport2_SetViewport2(viewport2, &vp2);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);

    vp.dwSize = sizeof(vp);
    hr = IDirect3DViewport2_SetViewport(viewport2, &vp);
    ok(SUCCEEDED(hr), "Failed to set viewport data, hr %#lx.\n", hr);
    vp2.dwSize = sizeof(vp2);
    hr = IDirect3DViewport2_SetViewport2(viewport2, &vp2);
    ok(SUCCEEDED(hr), "Failed to set viewport data, hr %#lx.\n", hr);

    /* Destroying the device removes the viewport, but does not free the reference
     * added by SetCurrentViewport. */
    IDirect3DDevice2_Release(device);
    ref = get_refcount((IUnknown *) viewport2);
    todo_wine ok(ref == 2, "Got unexpected refcount %lu.\n", ref);

    vp.dwSize = sizeof(vp);
    hr = IDirect3DViewport2_SetViewport(viewport2, &vp);
    ok(hr == D3DERR_VIEWPORTHASNODEVICE, "Got unexpected hr %#lx.\n", hr);
    vp2.dwSize = sizeof(vp2);
    hr = IDirect3DViewport2_SetViewport2(viewport2, &vp2);
    ok(hr == D3DERR_VIEWPORTHASNODEVICE, "Got unexpected hr %#lx.\n", hr);

    IDirect3DViewport2_Release(another_vp);
    IDirect3DViewport2_Release(viewport2);
    IDirect3D2_Release(d3d);
    DestroyWindow(window);
    IDirectDraw2_Release(ddraw);
}

static void test_zenable(const GUID *device_guid)
{
    static D3DRECT clear_rect = {{0}, {0}, {640}, {480}};
    static D3DTLVERTEX tquad[] =
    {
        {{  0.0f}, {480.0f}, {-0.5f}, {1.0f}, {0xff00ff00}, {0x00000000}, {0.0f}, {0.0f}},
        {{  0.0f}, {  0.0f}, {-0.5f}, {1.0f}, {0xff00ff00}, {0x00000000}, {0.0f}, {0.0f}},
        {{640.0f}, {480.0f}, { 1.5f}, {1.0f}, {0xff00ff00}, {0x00000000}, {0.0f}, {0.0f}},
        {{640.0f}, {  0.0f}, { 1.5f}, {1.0f}, {0xff00ff00}, {0x00000000}, {0.0f}, {0.0f}},
    };
    IDirect3DMaterial2 *background;
    unsigned int color, x, y, i, j;
    IDirect3DViewport2 *viewport;
    IDirect3DDevice2 *device;
    IDirectDrawSurface *rt;
    IDirectDraw2 *ddraw;
    HWND window;
    HRESULT hr;

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    if (!(device = create_device_ex(ddraw, window, DDSCL_NORMAL, device_guid, NULL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        IDirectDraw2_Release(ddraw);
        DestroyWindow(window);
        return;
    }

    background = create_diffuse_material(device, 1.0f, 0.0f, 0.0f, 1.0f);
    viewport = create_viewport(device, 0, 0, 640, 480);
    viewport_set_background(device, viewport, background);
    hr = IDirect3DDevice2_SetCurrentViewport(device, viewport);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_ZENABLE, D3DZB_FALSE);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice2_GetRenderTarget(device, &rt);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    color = get_surface_color(rt, 80, 60);
    /* For some reason clears and colour fill blits randomly fail with software render target. */
    ok(color == 0x00ff0000 || broken(is_software_device_type(device_guid) && !color),
            "Got unexpected colour 0x%08x.\n", color);
    if (!color)
    {
        fill_surface(rt, 0xffff0000);

        color = get_surface_color(rt, 80, 60);
        ok(color == 0x00ff0000, "Got unexpected colour 0x%08x.\n", color);
    }

    hr = IDirect3DDevice2_BeginScene(device);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, D3DVT_TLVERTEX, tquad, 4, 0);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_EndScene(device);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    for (i = 0; i < 4; ++i)
    {
        for (j = 0; j < 4; ++j)
        {
            x = 80 * ((2 * j) + 1);
            y = 60 * ((2 * i) + 1);
            color = get_surface_color(rt, x, y);
            ok(compare_color(color, 0x0000ff00, 1),
                    "Expected color 0x0000ff00 at %u, %u, got 0x%08x.\n", x, y, color);
        }
    }
    IDirectDrawSurface_Release(rt);

    destroy_viewport(device, viewport);
    destroy_material(background);
    IDirect3DDevice2_Release(device);
    IDirectDraw2_Release(ddraw);
    DestroyWindow(window);
}

static void test_ck_rgba(const GUID *device_guid)
{
    static D3DRECT clear_rect = {{0}, {0}, {640}, {480}};
    static D3DTLVERTEX tquad[] =
    {
        {{  0.0f}, {480.0f}, {0.25f}, {1.0f}, {0xffffffff}, {0x00000000}, {0.0f}, {0.0f}},
        {{  0.0f}, {  0.0f}, {0.25f}, {1.0f}, {0xffffffff}, {0x00000000}, {0.0f}, {1.0f}},
        {{640.0f}, {480.0f}, {0.25f}, {1.0f}, {0xffffffff}, {0x00000000}, {1.0f}, {0.0f}},
        {{640.0f}, {  0.0f}, {0.25f}, {1.0f}, {0xffffffff}, {0x00000000}, {1.0f}, {1.0f}},
        {{  0.0f}, {480.0f}, {0.75f}, {1.0f}, {0xffffffff}, {0x00000000}, {0.0f}, {0.0f}},
        {{  0.0f}, {  0.0f}, {0.75f}, {1.0f}, {0xffffffff}, {0x00000000}, {0.0f}, {1.0f}},
        {{640.0f}, {480.0f}, {0.75f}, {1.0f}, {0xffffffff}, {0x00000000}, {1.0f}, {0.0f}},
        {{640.0f}, {  0.0f}, {0.75f}, {1.0f}, {0xffffffff}, {0x00000000}, {1.0f}, {1.0f}},
    };
    static const struct
    {
        D3DCOLOR fill_color;
        BOOL color_key;
        BOOL blend;
        unsigned int result1, result1_broken;
        unsigned int result2, result2_broken;
    }
    tests[] =
    {
        /* r200 on Windows doesn't check the alpha component when applying the color
         * key, so the key matches on every texel. */
        {0xff00ff00, TRUE,  TRUE,  0x00ff0000, 0x00ff0000, 0x000000ff, 0x000000ff},
        {0xff00ff00, TRUE,  FALSE, 0x00ff0000, 0x00ff0000, 0x000000ff, 0x000000ff},
        {0xff00ff00, FALSE, TRUE,  0x0000ff00, 0x0000ff00, 0x0000ff00, 0x0000ff00},
        {0xff00ff00, FALSE, FALSE, 0x0000ff00, 0x0000ff00, 0x0000ff00, 0x0000ff00},
        {0x7f00ff00, TRUE,  TRUE,  0x00807f00, 0x00ff0000, 0x00807f00, 0x000000ff},
        {0x7f00ff00, TRUE,  FALSE, 0x0000ff00, 0x00ff0000, 0x0000ff00, 0x000000ff},
        {0x7f00ff00, FALSE, TRUE,  0x00807f00, 0x00807f00, 0x00807f00, 0x00807f00},
        {0x7f00ff00, FALSE, FALSE, 0x0000ff00, 0x0000ff00, 0x0000ff00, 0x0000ff00},
    };

    D3DTEXTUREHANDLE texture_handle;
    IDirect3DMaterial2 *background;
    IDirectDrawSurface *surface;
    IDirect3DViewport2 *viewport;
    IDirect3DTexture2 *texture;
    DDSURFACEDESC surface_desc;
    IDirect3DDevice2 *device;
    IDirectDrawSurface *rt;
    unsigned int color, i;
    IDirectDraw2 *ddraw;
    HWND window;
    DDBLTFX fx;
    HRESULT hr;

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    if (!(device = create_device_ex(ddraw, window, DDSCL_NORMAL, device_guid, NULL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        IDirectDraw2_Release(ddraw);
        DestroyWindow(window);
        return;
    }

    background = create_diffuse_material(device, 1.0f, 0.0f, 0.0f, 1.0f);
    viewport = create_viewport(device, 0, 0, 640, 480);
    viewport_set_background(device, viewport, background);
    hr = IDirect3DDevice2_SetCurrentViewport(device, viewport);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT | DDSD_CKSRCBLT;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_TEXTURE;
    if (is_software_device_type(device_guid))
        surface_desc.ddsCaps.dwCaps |= DDSCAPS_SYSTEMMEMORY;
    surface_desc.dwWidth = 256;
    surface_desc.dwHeight = 256;
    surface_desc.ddpfPixelFormat.dwSize = sizeof(surface_desc.ddpfPixelFormat);
    surface_desc.ddpfPixelFormat.dwFlags = DDPF_RGB | DDPF_ALPHAPIXELS;
    surface_desc.ddpfPixelFormat.dwRGBBitCount = 32;
    surface_desc.ddpfPixelFormat.dwRBitMask = 0x00ff0000;
    surface_desc.ddpfPixelFormat.dwGBitMask = 0x0000ff00;
    surface_desc.ddpfPixelFormat.dwBBitMask = 0x000000ff;
    surface_desc.ddpfPixelFormat.dwRGBAlphaBitMask = 0xff000000;
    surface_desc.ddckCKSrcBlt.dwColorSpaceLowValue = 0xff00ff00;
    surface_desc.ddckCKSrcBlt.dwColorSpaceHighValue = 0xff00ff00;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_QueryInterface(surface, &IID_IDirect3DTexture2, (void **)&texture);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DTexture2_GetHandle(texture, device, &texture_handle);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    IDirect3DTexture2_Release(texture);

    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_TEXTUREHANDLE, texture_handle);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_SRCBLEND, D3DBLEND_SRCALPHA);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_DESTBLEND, D3DBLEND_INVSRCALPHA);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice2_GetRenderTarget(device, &rt);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    for (i = 0; i < ARRAY_SIZE(tests); ++i)
    {
        hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_COLORKEYENABLE, tests[i].color_key);
        ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
        hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_ALPHABLENDENABLE, tests[i].blend);
        ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

        memset(&fx, 0, sizeof(fx));
        fx.dwSize = sizeof(fx);
        fx.dwFillColor = tests[i].fill_color;
        hr = IDirectDrawSurface_Blt(surface, NULL, NULL, NULL, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
        ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

        hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER);
        ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
        /* RT clears are broken on Windows for software render target. */
        if (is_software_device_type(device_guid))
            fill_surface(rt, 0xffff0000);

        hr = IDirect3DDevice2_BeginScene(device);
        ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
        hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, D3DVT_TLVERTEX, &tquad[0], 4, 0);
        ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
        hr = IDirect3DDevice2_EndScene(device);
        ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

        color = get_surface_color(rt, 320, 240);
        ok(compare_color(color, tests[i].result1, 2) || compare_color(color, tests[i].result1_broken, 1),
                "Expected color 0x%08x for test %u, got 0x%08x.\n",
                tests[i].result1, i, color);

        fx.dwFillColor = 0xff0000ff;
        hr = IDirectDrawSurface_Blt(surface, NULL, NULL, NULL, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
        ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

        hr = IDirect3DDevice2_BeginScene(device);
        ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
        hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, D3DVT_TLVERTEX, &tquad[4], 4, 0);
        ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
        hr = IDirect3DDevice2_EndScene(device);
        ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

        /* This tests that fragments that are masked out by the color key are
         * discarded, instead of just fully transparent. */
        color = get_surface_color(rt, 320, 240);
        ok(compare_color(color, tests[i].result2, 2) || compare_color(color, tests[i].result2_broken, 1),
                "Expected color 0x%08x for test %u, got 0x%08x.\n",
                tests[i].result2, i, color);
    }

    IDirectDrawSurface_Release(rt);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_TEXTUREHANDLE, 0);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    IDirectDrawSurface_Release(surface);
    destroy_viewport(device, viewport);
    destroy_material(background);
    IDirect3DDevice2_Release(device);
    IDirectDraw2_Release(ddraw);
    DestroyWindow(window);
}

static void test_ck_default(void)
{
    static D3DRECT clear_rect = {{0}, {0}, {640}, {480}};
    static D3DTLVERTEX tquad[] =
    {
        {{  0.0f}, {480.0f}, {0.0f}, {1.0f}, {0xffffffff}, {0x00000000}, {0.0f}, {0.0f}},
        {{  0.0f}, {  0.0f}, {0.0f}, {1.0f}, {0xffffffff}, {0x00000000}, {0.0f}, {1.0f}},
        {{640.0f}, {480.0f}, {0.0f}, {1.0f}, {0xffffffff}, {0x00000000}, {1.0f}, {0.0f}},
        {{640.0f}, {  0.0f}, {0.0f}, {1.0f}, {0xffffffff}, {0x00000000}, {1.0f}, {1.0f}},
    };
    IDirectDrawSurface *surface, *rt;
    D3DTEXTUREHANDLE texture_handle;
    IDirect3DMaterial2 *background;
    IDirect3DViewport2 *viewport;
    DDSURFACEDESC surface_desc;
    IDirect3DTexture2 *texture;
    IDirect3DDevice2 *device;
    IDirectDraw2 *ddraw;
    unsigned int color;
    DWORD value;
    HWND window;
    DDBLTFX fx;
    HRESULT hr;

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    if (!(device = create_device(ddraw, window, DDSCL_NORMAL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        IDirectDraw2_Release(ddraw);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice2_GetRenderTarget(device, &rt);
    ok(SUCCEEDED(hr), "Failed to get render target, hr %#lx.\n", hr);

    background = create_diffuse_material(device, 0.0, 1.0f, 0.0f, 1.0f);
    viewport = create_viewport(device, 0, 0, 640, 480);
    viewport_set_background(device, viewport, background);
    hr = IDirect3DDevice2_SetCurrentViewport(device, viewport);
    ok(SUCCEEDED(hr), "Failed to set current viewport, hr %#lx.\n", hr);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT | DDSD_CKSRCBLT;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_TEXTURE;
    surface_desc.dwWidth = 256;
    surface_desc.dwHeight = 256;
    surface_desc.ddpfPixelFormat.dwSize = sizeof(surface_desc.ddpfPixelFormat);
    surface_desc.ddpfPixelFormat.dwFlags = DDPF_RGB;
    surface_desc.ddpfPixelFormat.dwRGBBitCount = 32;
    surface_desc.ddpfPixelFormat.dwRBitMask = 0x00ff0000;
    surface_desc.ddpfPixelFormat.dwGBitMask = 0x0000ff00;
    surface_desc.ddpfPixelFormat.dwBBitMask = 0x000000ff;
    surface_desc.ddckCKSrcBlt.dwColorSpaceLowValue = 0x000000ff;
    surface_desc.ddckCKSrcBlt.dwColorSpaceHighValue = 0x000000ff;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_QueryInterface(surface, &IID_IDirect3DTexture2, (void **)&texture);
    ok(SUCCEEDED(hr), "Failed to get texture interface, hr %#lx.\n", hr);
    hr = IDirect3DTexture2_GetHandle(texture, device, &texture_handle);
    ok(SUCCEEDED(hr), "Failed to get texture handle, hr %#lx.\n", hr);
    IDirect3DTexture_Release(texture);

    memset(&fx, 0, sizeof(fx));
    fx.dwSize = sizeof(fx);
    fx.dwFillColor = 0x000000ff;
    hr = IDirectDrawSurface_Blt(surface, NULL, NULL, NULL, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
    ok(SUCCEEDED(hr), "Failed to fill surface, hr %#lx.\n", hr);

    hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET);
    ok(SUCCEEDED(hr), "Failed to clear viewport, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_TEXTUREHANDLE, texture_handle);
    ok(SUCCEEDED(hr), "Failed to set texture handle, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_GetRenderState(device, D3DRENDERSTATE_COLORKEYENABLE, &value);
    ok(SUCCEEDED(hr), "Failed to get render state, hr %#lx.\n", hr);
    ok(!value, "Got unexpected color keying state %#lx.\n", value);
    hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, D3DVT_TLVERTEX, &tquad[0], 4, 0);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);
    color = get_surface_color(rt, 320, 240);
    ok(compare_color(color, 0x000000ff, 1), "Got unexpected color 0x%08x.\n", color);

    hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET);
    ok(SUCCEEDED(hr), "Failed to clear viewport, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_COLORKEYENABLE, TRUE);
    ok(SUCCEEDED(hr), "Failed to enable color keying, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, D3DVT_TLVERTEX, &tquad[0], 4, 0);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_GetRenderState(device, D3DRENDERSTATE_COLORKEYENABLE, &value);
    ok(SUCCEEDED(hr), "Failed to get render state, hr %#lx.\n", hr);
    ok(!!value, "Got unexpected color keying state %#lx.\n", value);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_TEXTUREHANDLE, 0);
    ok(SUCCEEDED(hr), "Failed to set texture handle, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);
    color = get_surface_color(rt, 320, 240);
    ok(compare_color(color, 0x0000ff00, 1), "Got unexpected color 0x%08x.\n", color);

    IDirectDrawSurface_Release(surface);
    destroy_viewport(device, viewport);
    destroy_material(background);
    IDirectDrawSurface_Release(rt);
    IDirect3DDevice2_Release(device);
    IDirectDraw2_Release(ddraw);
    DestroyWindow(window);
}

static void test_ck_complex(void)
{
    IDirectDrawSurface *surface, *mipmap, *tmp;
    DDSCAPS caps = {DDSCAPS_COMPLEX};
    DDSURFACEDESC surface_desc;
    IDirect3DDevice2 *device;
    DDCOLORKEY color_key;
    IDirectDraw2 *ddraw;
    unsigned int i;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    if (!(device = create_device(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        DestroyWindow(window);
        IDirectDraw2_Release(ddraw);
        return;
    }
    IDirect3DDevice2_Release(device);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_TEXTURE | DDSCAPS_COMPLEX | DDSCAPS_MIPMAP;
    surface_desc.dwWidth = 128;
    surface_desc.dwHeight = 128;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

    hr = IDirectDrawSurface_GetColorKey(surface, DDCKEY_SRCBLT, &color_key);
    ok(hr == DDERR_NOCOLORKEY, "Got unexpected hr %#lx.\n", hr);
    color_key.dwColorSpaceLowValue = 0x0000ff00;
    color_key.dwColorSpaceHighValue = 0x0000ff00;
    hr = IDirectDrawSurface_SetColorKey(surface, DDCKEY_SRCBLT, &color_key);
    ok(SUCCEEDED(hr), "Failed to set color key, hr %#lx.\n", hr);
    memset(&color_key, 0, sizeof(color_key));
    hr = IDirectDrawSurface_GetColorKey(surface, DDCKEY_SRCBLT, &color_key);
    ok(SUCCEEDED(hr), "Failed to get color key, hr %#lx.\n", hr);
    ok(color_key.dwColorSpaceLowValue == 0x0000ff00, "Got unexpected value 0x%08lx.\n",
            color_key.dwColorSpaceLowValue);
    ok(color_key.dwColorSpaceHighValue == 0x0000ff00, "Got unexpected value 0x%08lx.\n",
            color_key.dwColorSpaceHighValue);

    mipmap = surface;
    IDirectDrawSurface_AddRef(mipmap);
    for (i = 0; i < 7; ++i)
    {
        hr = IDirectDrawSurface_GetAttachedSurface(mipmap, &caps, &tmp);
        ok(SUCCEEDED(hr), "Failed to get attached surface, i %u, hr %#lx.\n", i, hr);

        hr = IDirectDrawSurface_GetColorKey(tmp, DDCKEY_SRCBLT, &color_key);
        ok(hr == DDERR_NOCOLORKEY, "Got unexpected hr %#lx, i %u.\n", hr, i);
        color_key.dwColorSpaceLowValue = 0x000000ff;
        color_key.dwColorSpaceHighValue = 0x000000ff;
        hr = IDirectDrawSurface_SetColorKey(tmp, DDCKEY_SRCBLT, &color_key);
        ok(SUCCEEDED(hr), "Failed to set color key, hr %#lx, i %u.\n", hr, i);
        memset(&color_key, 0, sizeof(color_key));
        hr = IDirectDrawSurface_GetColorKey(tmp, DDCKEY_SRCBLT, &color_key);
        ok(SUCCEEDED(hr), "Failed to get color key, hr %#lx, i %u.\n", hr, i);
        ok(color_key.dwColorSpaceLowValue == 0x000000ff, "Got unexpected value 0x%08lx, i %u.\n",
                color_key.dwColorSpaceLowValue, i);
        ok(color_key.dwColorSpaceHighValue == 0x000000ff, "Got unexpected value 0x%08lx, i %u.\n",
                color_key.dwColorSpaceHighValue, i);

        IDirectDrawSurface_Release(mipmap);
        mipmap = tmp;
    }

    memset(&color_key, 0, sizeof(color_key));
    hr = IDirectDrawSurface_GetColorKey(surface, DDCKEY_SRCBLT, &color_key);
    ok(SUCCEEDED(hr), "Failed to get color key, hr %#lx.\n", hr);
    ok(color_key.dwColorSpaceLowValue == 0x0000ff00, "Got unexpected value 0x%08lx.\n",
            color_key.dwColorSpaceLowValue);
    ok(color_key.dwColorSpaceHighValue == 0x0000ff00, "Got unexpected value 0x%08lx.\n",
            color_key.dwColorSpaceHighValue);

    hr = IDirectDrawSurface_GetAttachedSurface(mipmap, &caps, &tmp);
    ok(hr == DDERR_NOTFOUND, "Got unexpected hr %#lx.\n", hr);
    IDirectDrawSurface_Release(mipmap);
    refcount = IDirectDrawSurface_Release(surface);
    ok(!refcount, "Got unexpected refcount %lu.\n", refcount);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_BACKBUFFERCOUNT;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE | DDSCAPS_COMPLEX | DDSCAPS_FLIP;
    surface_desc.dwBackBufferCount = 1;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

    hr = IDirectDrawSurface_GetColorKey(surface, DDCKEY_SRCBLT, &color_key);
    ok(hr == DDERR_NOCOLORKEY, "Got unexpected hr %#lx.\n", hr);
    color_key.dwColorSpaceLowValue = 0x0000ff00;
    color_key.dwColorSpaceHighValue = 0x0000ff00;
    hr = IDirectDrawSurface_SetColorKey(surface, DDCKEY_SRCBLT, &color_key);
    ok(SUCCEEDED(hr), "Failed to set color key, hr %#lx.\n", hr);
    memset(&color_key, 0, sizeof(color_key));
    hr = IDirectDrawSurface_GetColorKey(surface, DDCKEY_SRCBLT, &color_key);
    ok(SUCCEEDED(hr), "Failed to get color key, hr %#lx.\n", hr);
    ok(color_key.dwColorSpaceLowValue == 0x0000ff00, "Got unexpected value 0x%08lx.\n",
            color_key.dwColorSpaceLowValue);
    ok(color_key.dwColorSpaceHighValue == 0x0000ff00, "Got unexpected value 0x%08lx.\n",
            color_key.dwColorSpaceHighValue);

    hr = IDirectDrawSurface_GetAttachedSurface(surface, &caps, &tmp);
    ok(SUCCEEDED(hr), "Failed to get attached surface, hr %#lx.\n", hr);

    hr = IDirectDrawSurface_GetColorKey(tmp, DDCKEY_SRCBLT, &color_key);
    ok(hr == DDERR_NOCOLORKEY, "Got unexpected hr %#lx, i %u.\n", hr, i);
    color_key.dwColorSpaceLowValue = 0x0000ff00;
    color_key.dwColorSpaceHighValue = 0x0000ff00;
    hr = IDirectDrawSurface_SetColorKey(tmp, DDCKEY_SRCBLT, &color_key);
    ok(SUCCEEDED(hr), "Failed to set color key, hr %#lx.\n", hr);
    memset(&color_key, 0, sizeof(color_key));
    hr = IDirectDrawSurface_GetColorKey(tmp, DDCKEY_SRCBLT, &color_key);
    ok(SUCCEEDED(hr), "Failed to get color key, hr %#lx.\n", hr);
    ok(color_key.dwColorSpaceLowValue == 0x0000ff00, "Got unexpected value 0x%08lx.\n",
            color_key.dwColorSpaceLowValue);
    ok(color_key.dwColorSpaceHighValue == 0x0000ff00, "Got unexpected value 0x%08lx.\n",
            color_key.dwColorSpaceHighValue);

    IDirectDrawSurface_Release(tmp);

    refcount = IDirectDrawSurface_Release(surface);
    ok(!refcount, "Got unexpected refcount %lu.\n", refcount);
    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "Got unexpected refcount %lu.\n", refcount);
    DestroyWindow(window);
}

struct qi_test
{
    REFIID iid;
    REFIID refcount_iid;
    HRESULT hr;
};

static void test_qi(const char *test_name, IUnknown *base_iface,
        REFIID refcount_iid, const struct qi_test *tests, UINT entry_count)
{
    ULONG refcount, expected_refcount;
    IUnknown *iface1, *iface2;
    HRESULT hr;
    UINT i, j;

    for (i = 0; i < entry_count; ++i)
    {
        hr = IUnknown_QueryInterface(base_iface, tests[i].iid, (void **)&iface1);
        ok(hr == tests[i].hr, "Got hr %#lx for test \"%s\" %u.\n", hr, test_name, i);
        if (SUCCEEDED(hr))
        {
            for (j = 0; j < entry_count; ++j)
            {
                hr = IUnknown_QueryInterface(iface1, tests[j].iid, (void **)&iface2);
                ok(hr == tests[j].hr, "Got hr %#lx for test \"%s\" %u, %u.\n", hr, test_name, i, j);
                if (SUCCEEDED(hr))
                {
                    expected_refcount = 0;
                    if (IsEqualGUID(refcount_iid, tests[j].refcount_iid))
                        ++expected_refcount;
                    if (IsEqualGUID(tests[i].refcount_iid, tests[j].refcount_iid))
                        ++expected_refcount;
                    refcount = IUnknown_Release(iface2);
                    ok(refcount == expected_refcount, "Got refcount %lu for test \"%s\" %u, %u, expected %lu.\n",
                            refcount, test_name, i, j, expected_refcount);
                }
            }

            expected_refcount = 0;
            if (IsEqualGUID(refcount_iid, tests[i].refcount_iid))
                ++expected_refcount;
            refcount = IUnknown_Release(iface1);
            ok(refcount == expected_refcount, "Got refcount %lu for test \"%s\" %u, expected %lu.\n",
                    refcount, test_name, i, expected_refcount);
        }
    }
}

static void test_surface_qi(void)
{
    static const struct qi_test tests[] =
    {
        {&IID_IDirect3DTexture2,        &IID_IDirectDrawSurface,        S_OK         },
        {&IID_IDirect3DTexture,         &IID_IDirectDrawSurface,        S_OK         },
        {&IID_IDirectDrawGammaControl,  &IID_IDirectDrawGammaControl,   S_OK         },
        {&IID_IDirectDrawColorControl,  NULL,                           E_NOINTERFACE},
        {&IID_IDirectDrawSurface7,      &IID_IDirectDrawSurface7,       S_OK         },
        {&IID_IDirectDrawSurface4,      &IID_IDirectDrawSurface4,       S_OK         },
        {&IID_IDirectDrawSurface3,      &IID_IDirectDrawSurface3,       S_OK         },
        {&IID_IDirectDrawSurface2,      &IID_IDirectDrawSurface2,       S_OK         },
        {&IID_IDirectDrawSurface,       &IID_IDirectDrawSurface,        S_OK         },
        {&IID_IDirect3DDevice7,         NULL,                           E_INVALIDARG },
        {&IID_IDirect3DDevice3,         NULL,                           E_INVALIDARG },
        {&IID_IDirect3DDevice2,         NULL,                           E_INVALIDARG },
        {&IID_IDirect3DDevice,          NULL,                           E_INVALIDARG },
        {&IID_IDirect3D7,               NULL,                           E_INVALIDARG },
        {&IID_IDirect3D3,               NULL,                           E_INVALIDARG },
        {&IID_IDirect3D2,               NULL,                           E_INVALIDARG },
        {&IID_IDirect3D,                NULL,                           E_INVALIDARG },
        {&IID_IDirectDraw7,             NULL,                           E_INVALIDARG },
        {&IID_IDirectDraw4,             NULL,                           E_INVALIDARG },
        {&IID_IDirectDraw3,             NULL,                           E_INVALIDARG },
        {&IID_IDirectDraw2,             NULL,                           E_INVALIDARG },
        {&IID_IDirectDraw,              NULL,                           E_INVALIDARG },
        {&IID_IDirect3DLight,           NULL,                           E_INVALIDARG },
        {&IID_IDirect3DMaterial,        NULL,                           E_INVALIDARG },
        {&IID_IDirect3DMaterial2,       NULL,                           E_INVALIDARG },
        {&IID_IDirect3DMaterial3,       NULL,                           E_INVALIDARG },
        {&IID_IDirect3DExecuteBuffer,   NULL,                           E_INVALIDARG },
        {&IID_IDirect3DViewport,        NULL,                           E_INVALIDARG },
        {&IID_IDirect3DViewport2,       NULL,                           E_INVALIDARG },
        {&IID_IDirect3DViewport3,       NULL,                           E_INVALIDARG },
        {&IID_IDirect3DVertexBuffer,    NULL,                           E_INVALIDARG },
        {&IID_IDirect3DVertexBuffer7,   NULL,                           E_INVALIDARG },
        {&IID_IDirectDrawPalette,       NULL,                           E_INVALIDARG },
        {&IID_IDirectDrawClipper,       NULL,                           E_INVALIDARG },
        {&IID_IUnknown,                 &IID_IDirectDrawSurface,        S_OK         },
        {NULL,                          NULL,                           E_INVALIDARG },
    };

    IDirectDrawSurface *surface;
    DDSURFACEDESC surface_desc;
    IDirect3DDevice2 *device;
    IDirectDraw2 *ddraw;
    HWND window;
    HRESULT hr;

    if (!GetProcAddress(GetModuleHandleA("ddraw.dll"), "DirectDrawCreateEx"))
    {
        win_skip("DirectDrawCreateEx not available, skipping test.\n");
        return;
    }

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    /* Try to create a D3D device to see if the ddraw implementation supports
     * D3D. 64-bit ddraw in particular doesn't seem to support D3D, and
     * doesn't support e.g. the IDirect3DTexture interfaces. */
    if (!(device = create_device(ddraw, window, DDSCL_NORMAL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        IDirectDraw2_Release(ddraw);
        DestroyWindow(window);
        return;
    }
    IDirect3DDevice_Release(device);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_TEXTURE;
    surface_desc.dwWidth = 512;
    surface_desc.dwHeight = 512;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, (IDirectDrawSurface **)0xdeadbeef, NULL);
    ok(hr == E_INVALIDARG, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

    test_qi("surface_qi", (IUnknown *)surface, &IID_IDirectDrawSurface, tests, ARRAY_SIZE(tests));

    IDirectDrawSurface_Release(surface);
    IDirectDraw2_Release(ddraw);
    DestroyWindow(window);
}

static void test_device_qi(void)
{
    static const struct qi_test tests[] =
    {
        {&IID_IDirect3DTexture2,        NULL,                           E_NOINTERFACE},
        {&IID_IDirect3DTexture,         NULL,                           E_NOINTERFACE},
        {&IID_IDirectDrawGammaControl,  NULL,                           E_NOINTERFACE},
        {&IID_IDirectDrawColorControl,  NULL,                           E_NOINTERFACE},
        {&IID_IDirectDrawSurface7,      NULL,                           E_NOINTERFACE},
        {&IID_IDirectDrawSurface4,      NULL,                           E_NOINTERFACE},
        {&IID_IDirectDrawSurface3,      NULL,                           E_NOINTERFACE},
        {&IID_IDirectDrawSurface2,      NULL,                           E_NOINTERFACE},
        {&IID_IDirectDrawSurface,       NULL,                           E_NOINTERFACE},
        {&IID_IDirect3DDevice7,         NULL,                           E_NOINTERFACE},
        {&IID_IDirect3DDevice3,         NULL,                           E_NOINTERFACE},
        {&IID_IDirect3DDevice2,         &IID_IDirect3DDevice2,          S_OK         },
        {&IID_IDirect3DDevice,          &IID_IDirect3DDevice2,          S_OK         },
        {&IID_IDirect3DRampDevice,      NULL,                           E_NOINTERFACE},
        {&IID_IDirect3DRGBDevice,       NULL,                           E_NOINTERFACE},
        {&IID_IDirect3DHALDevice,       NULL,                           E_NOINTERFACE},
        {&IID_IDirect3DMMXDevice,       NULL,                           E_NOINTERFACE},
        {&IID_IDirect3DRefDevice,       NULL,                           E_NOINTERFACE},
        {&IID_IDirect3DTnLHalDevice,    NULL,                           E_NOINTERFACE},
        {&IID_IDirect3DNullDevice,      NULL,                           E_NOINTERFACE},
        {&IID_IDirect3D7,               NULL,                           E_NOINTERFACE},
        {&IID_IDirect3D3,               NULL,                           E_NOINTERFACE},
        {&IID_IDirect3D2,               NULL,                           E_NOINTERFACE},
        {&IID_IDirect3D,                NULL,                           E_NOINTERFACE},
        {&IID_IDirectDraw7,             NULL,                           E_NOINTERFACE},
        {&IID_IDirectDraw4,             NULL,                           E_NOINTERFACE},
        {&IID_IDirectDraw3,             NULL,                           E_NOINTERFACE},
        {&IID_IDirectDraw2,             NULL,                           E_NOINTERFACE},
        {&IID_IDirectDraw,              NULL,                           E_NOINTERFACE},
        {&IID_IDirect3DLight,           NULL,                           E_NOINTERFACE},
        {&IID_IDirect3DMaterial,        NULL,                           E_NOINTERFACE},
        {&IID_IDirect3DMaterial2,       NULL,                           E_NOINTERFACE},
        {&IID_IDirect3DMaterial3,       NULL,                           E_NOINTERFACE},
        {&IID_IDirect3DExecuteBuffer,   NULL,                           E_NOINTERFACE},
        {&IID_IDirect3DViewport,        NULL,                           E_NOINTERFACE},
        {&IID_IDirect3DViewport2,       NULL,                           E_NOINTERFACE},
        {&IID_IDirect3DViewport3,       NULL,                           E_NOINTERFACE},
        {&IID_IDirect3DVertexBuffer,    NULL,                           E_NOINTERFACE},
        {&IID_IDirect3DVertexBuffer7,   NULL,                           E_NOINTERFACE},
        {&IID_IDirectDrawPalette,       NULL,                           E_NOINTERFACE},
        {&IID_IDirectDrawClipper,       NULL,                           E_NOINTERFACE},
        {&IID_IUnknown,                 &IID_IDirect3DDevice2,          S_OK         },
    };

    IDirect3DDevice2 *device;
    IDirectDraw2 *ddraw;
    HWND window;

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    if (!(device = create_device(ddraw, window, DDSCL_NORMAL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        IDirectDraw2_Release(ddraw);
        DestroyWindow(window);
        return;
    }

    test_qi("device_qi", (IUnknown *)device, &IID_IDirect3DDevice2, tests, ARRAY_SIZE(tests));

    IDirect3DDevice2_Release(device);
    IDirectDraw2_Release(ddraw);
    DestroyWindow(window);
}

static void test_wndproc(void)
{
    LONG_PTR proc, ddraw_proc;
    IDirectDraw2 *ddraw;
    WNDCLASSA wc = {0};
    HWND window;
    HRESULT hr;
    ULONG ref;

    static struct message messages[] =
    {
        {WM_WINDOWPOSCHANGING,  FALSE,  0},
        {WM_MOVE,               FALSE,  0},
        {WM_SIZE,               FALSE,  0},
        {WM_WINDOWPOSCHANGING,  FALSE,  0},
        {WM_ACTIVATE,           FALSE,  0},
        {WM_SETFOCUS,           FALSE,  0},
        {0,                     FALSE,  0},
    };

    /* DDSCL_EXCLUSIVE replaces the window's window proc. */
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");

    wc.lpfnWndProc = test_proc;
    wc.lpszClassName = "ddraw_test_wndproc_wc";
    ok(RegisterClassA(&wc), "Failed to register window class.\n");

    window = CreateWindowA("ddraw_test_wndproc_wc", "ddraw_test",
            WS_MAXIMIZE | WS_CAPTION , 0, 0, 640, 480, 0, 0, 0, 0);

    proc = GetWindowLongPtrA(window, GWLP_WNDPROC);
    ok(proc == (LONG_PTR)test_proc, "Expected wndproc %#Ix, got %#Ix.\n",
            (LONG_PTR)test_proc, proc);
    expect_messages = messages;
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);
    ok(!expect_messages->message, "Expected message %#x, but didn't receive it.\n", expect_messages->message);
    expect_messages = NULL;
    proc = GetWindowLongPtrA(window, GWLP_WNDPROC);
    ok(proc != (LONG_PTR)test_proc, "Expected wndproc != %#Ix, got %#Ix.\n",
            (LONG_PTR)test_proc, proc);
    ref = IDirectDraw2_Release(ddraw);
    ok(!ref, "Unexpected refcount %lu.\n", ref);
    proc = GetWindowLongPtrA(window, GWLP_WNDPROC);
    ok(proc == (LONG_PTR)test_proc, "Expected wndproc %#Ix, got %#Ix.\n",
            (LONG_PTR)test_proc, proc);

    /* DDSCL_NORMAL doesn't. */
    ddraw = create_ddraw();
    proc = GetWindowLongPtrA(window, GWLP_WNDPROC);
    ok(proc == (LONG_PTR)test_proc, "Expected wndproc %#Ix, got %#Ix.\n",
            (LONG_PTR)test_proc, proc);
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);
    proc = GetWindowLongPtrA(window, GWLP_WNDPROC);
    ok(proc == (LONG_PTR)test_proc, "Expected wndproc %#Ix, got %#Ix.\n",
            (LONG_PTR)test_proc, proc);
    ref = IDirectDraw2_Release(ddraw);
    ok(!ref, "Unexpected refcount %lu.\n", ref);
    proc = GetWindowLongPtrA(window, GWLP_WNDPROC);
    ok(proc == (LONG_PTR)test_proc, "Expected wndproc %#Ix, got %#Ix.\n",
            (LONG_PTR)test_proc, proc);

    /* The original window proc is only restored by ddraw if the current
     * window proc matches the one ddraw set. This also affects switching
     * from DDSCL_NORMAL to DDSCL_EXCLUSIVE. */
    ddraw = create_ddraw();
    proc = GetWindowLongPtrA(window, GWLP_WNDPROC);
    ok(proc == (LONG_PTR)test_proc, "Expected wndproc %#Ix, got %#Ix.\n",
            (LONG_PTR)test_proc, proc);
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);
    proc = GetWindowLongPtrA(window, GWLP_WNDPROC);
    ok(proc != (LONG_PTR)test_proc, "Expected wndproc != %#Ix, got %#Ix.\n",
            (LONG_PTR)test_proc, proc);
    ddraw_proc = proc;
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);
    proc = GetWindowLongPtrA(window, GWLP_WNDPROC);
    ok(proc == (LONG_PTR)test_proc, "Expected wndproc %#Ix, got %#Ix.\n",
            (LONG_PTR)test_proc, proc);
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);
    proc = SetWindowLongPtrA(window, GWLP_WNDPROC, (LONG_PTR)DefWindowProcA);
    ok(proc != (LONG_PTR)test_proc, "Expected wndproc != %#Ix, got %#Ix.\n",
            (LONG_PTR)test_proc, proc);
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);
    proc = GetWindowLongPtrA(window, GWLP_WNDPROC);
    ok(proc == (LONG_PTR)DefWindowProcA, "Expected wndproc %#Ix, got %#Ix.\n",
            (LONG_PTR)DefWindowProcA, proc);
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);
    proc = SetWindowLongPtrA(window, GWLP_WNDPROC, ddraw_proc);
    ok(proc == (LONG_PTR)DefWindowProcA, "Expected wndproc %#Ix, got %#Ix.\n",
            (LONG_PTR)DefWindowProcA, proc);
    ref = IDirectDraw2_Release(ddraw);
    ok(!ref, "Unexpected refcount %lu.\n", ref);
    proc = GetWindowLongPtrA(window, GWLP_WNDPROC);
    ok(proc == (LONG_PTR)test_proc, "Expected wndproc %#Ix, got %#Ix.\n",
            (LONG_PTR)test_proc, proc);

    ddraw = create_ddraw();
    proc = GetWindowLongPtrA(window, GWLP_WNDPROC);
    ok(proc == (LONG_PTR)test_proc, "Expected wndproc %#Ix, got %#Ix.\n",
            (LONG_PTR)test_proc, proc);
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);
    proc = SetWindowLongPtrA(window, GWLP_WNDPROC, (LONG_PTR)DefWindowProcA);
    ok(proc != (LONG_PTR)test_proc, "Expected wndproc != %#Ix, got %#Ix.\n",
            (LONG_PTR)test_proc, proc);
    ref = IDirectDraw2_Release(ddraw);
    ok(!ref, "Unexpected refcount %lu.\n", ref);
    proc = GetWindowLongPtrA(window, GWLP_WNDPROC);
    ok(proc == (LONG_PTR)DefWindowProcA, "Expected wndproc %#Ix, got %#Ix.\n",
            (LONG_PTR)DefWindowProcA, proc);

    fix_wndproc(window, (LONG_PTR)test_proc);
    expect_messages = NULL;
    DestroyWindow(window);
    UnregisterClassA("ddraw_test_wndproc_wc", GetModuleHandleA(NULL));
}

static void test_window_style(void)
{
    LONG style, exstyle, tmp, expected_style;
    RECT fullscreen_rect, r;
    HWND window, window2;
    IDirectDraw2 *ddraw;
    unsigned int i;
    HRESULT hr;
    ULONG ref;
    BOOL ret;

    window = CreateWindowA("static", "ddraw_test", WS_OVERLAPPEDWINDOW,
            0, 0, 100, 100, 0, 0, 0, 0);
    window2 = CreateWindowA("static", "ddraw_test", WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            0, 0, 50, 50, 0, 0, 0, 0);
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");

    style = GetWindowLongA(window, GWL_STYLE);
    exstyle = GetWindowLongA(window, GWL_EXSTYLE);
    SetRect(&fullscreen_rect, 0, 0, registry_mode.dmPelsWidth, registry_mode.dmPelsHeight);

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);

    tmp = GetWindowLongA(window, GWL_STYLE);
    todo_wine ok(tmp == style, "Expected window style %#lx, got %#lx.\n", style, tmp);
    tmp = GetWindowLongA(window, GWL_EXSTYLE);
    todo_wine ok(tmp == exstyle, "Expected window extended style %#lx, got %#lx.\n", exstyle, tmp);

    GetWindowRect(window, &r);
    ok(EqualRect(&r, &fullscreen_rect), "Expected %s, got %s.\n",
            wine_dbgstr_rect(&fullscreen_rect), wine_dbgstr_rect(&r));
    GetClientRect(window, &r);
    todo_wine ok(!EqualRect(&r, &fullscreen_rect), "Client rect and window rect are equal.\n");

    ret = SetForegroundWindow(foreground);
    ok(ret, "Failed to set foreground window.\n");

    tmp = GetWindowLongA(window, GWL_STYLE);
    todo_wine ok(tmp == style, "Expected window style %#lx, got %#lx.\n", style, tmp);
    tmp = GetWindowLongA(window, GWL_EXSTYLE);
    todo_wine ok(tmp == exstyle, "Expected window extended style %#lx, got %#lx.\n", exstyle, tmp);

    ret = SetForegroundWindow(window);
    ok(ret, "Failed to set foreground window.\n");
    /* Windows 7 (but not Vista and XP) shows the window when it receives focus. Hide it again,
     * the next tests expect this. */
    ShowWindow(window, SW_HIDE);

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);

    tmp = GetWindowLongA(window, GWL_STYLE);
    ok(tmp == style, "Expected window style %#lx, got %#lx.\n", style, tmp);
    tmp = GetWindowLongA(window, GWL_EXSTYLE);
    ok(tmp == exstyle, "Expected window extended style %#lx, got %#lx.\n", exstyle, tmp);

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN | DDSCL_NOWINDOWCHANGES);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);

    tmp = GetWindowLongA(window, GWL_STYLE);
    todo_wine ok(tmp == style, "Expected window style %#lx, got %#lx.\n", style, tmp);
    tmp = GetWindowLongA(window, GWL_EXSTYLE);
    todo_wine ok(tmp == exstyle, "Expected window extended style %#lx, got %#lx.\n", exstyle, tmp);

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);

    tmp = GetWindowLongA(window, GWL_STYLE);
    expected_style = style | WS_VISIBLE;
    todo_wine ok(tmp == expected_style, "Expected window style %#lx, got %#lx.\n", expected_style, tmp);
    tmp = GetWindowLongA(window, GWL_EXSTYLE);
    expected_style = exstyle | WS_EX_TOPMOST;
    todo_wine ok(tmp == expected_style, "Expected window extended style %#lx, got %#lx.\n", expected_style, tmp);

    ShowWindow(window, SW_HIDE);
    tmp = GetWindowLongA(window, GWL_STYLE);
    todo_wine ok(tmp == style, "Expected window style %#lx, got %#lx.\n", style, tmp);
    tmp = GetWindowLongA(window, GWL_EXSTYLE);
    expected_style = exstyle | WS_EX_TOPMOST;
    todo_wine ok(tmp == expected_style, "Expected window extended style %#lx, got %#lx.\n", expected_style, tmp);

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL | DDSCL_NOWINDOWCHANGES);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);

    tmp = GetWindowLongA(window, GWL_STYLE);
    ok(tmp == style, "Expected window style %#lx, got %#lx.\n", style, tmp);
    tmp = GetWindowLongA(window, GWL_EXSTYLE);
    expected_style = exstyle | WS_EX_TOPMOST;
    ok(tmp == expected_style, "Expected window extended style %#lx, got %#lx.\n", expected_style, tmp);

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);

    tmp = GetWindowLongA(window, GWL_STYLE);
    ok(tmp == style, "Expected window style %#lx, got %#lx.\n", style, tmp);
    tmp = GetWindowLongA(window, GWL_EXSTYLE);
    expected_style = exstyle | WS_EX_TOPMOST;
    ok(tmp == expected_style, "Expected window extended style %#lx, got %#lx.\n", expected_style, tmp);

    ret = SetForegroundWindow(window);
    ok(ret, "Failed to set foreground window.\n");

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);

    tmp = GetWindowLongA(window, GWL_STYLE);
    expected_style = style | WS_VISIBLE;
    todo_wine ok(tmp == expected_style, "Expected window style %#lx, got %#lx.\n", expected_style, tmp);
    tmp = GetWindowLongA(window, GWL_EXSTYLE);
    expected_style = exstyle | WS_EX_TOPMOST;
    todo_wine ok(tmp == expected_style, "Expected window extended style %#lx, got %#lx.\n", expected_style, tmp);

    ShowWindow(window, SW_HIDE);
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);

    tmp = GetWindowLongA(window, GWL_STYLE);
    ok(tmp == style, "Expected window style %#lx, got %#lx.\n", style, tmp);
    tmp = GetWindowLongA(window, GWL_EXSTYLE);
    ok(tmp == exstyle, "Expected window extended style %#lx, got %#lx.\n", exstyle, tmp);

    ShowWindow(window, SW_SHOW);
    ret = SetForegroundWindow(foreground);
    ok(ret, "Failed to set foreground window.\n");
    SetActiveWindow(window);
    ok(GetActiveWindow() == window, "Unexpected active window.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);

    tmp = GetWindowLongA(window, GWL_STYLE);
    expected_style = style | WS_VISIBLE;
    todo_wine ok(tmp == expected_style, "Expected window style %#lx, got %#lx.\n", expected_style, tmp);
    tmp = GetWindowLongA(window, GWL_EXSTYLE);
    todo_wine ok(tmp == exstyle, "Expected window extended style %#lx, got %#lx.\n", exstyle, tmp);

    GetWindowRect(window, &r);
    ok(EqualRect(&r, &fullscreen_rect), "Expected %s, got %s.\n",
            wine_dbgstr_rect(&fullscreen_rect), wine_dbgstr_rect(&r));

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);

    SetWindowPos(window, NULL, 0, 0, 100, 100, SWP_NOZORDER | SWP_NOACTIVATE);
    GetWindowRect(window, &r);
    ok(!EqualRect(&r, &fullscreen_rect), "Window resize failed? got %s.\n",
            wine_dbgstr_rect(&r));

    ret = SetForegroundWindow(window2);
    ok(ret, "Failed to set foreground window.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);

    tmp = GetWindowLongA(window, GWL_STYLE);
    expected_style = style | WS_VISIBLE;
    todo_wine ok(tmp == expected_style, "Expected window style %#lx, got %#lx.\n", expected_style, tmp);
    tmp = GetWindowLongA(window, GWL_EXSTYLE);
    todo_wine ok(tmp == exstyle, "Expected window extended style %#lx, got %#lx.\n", exstyle, tmp);

    GetWindowRect(window, &r);
    ok(EqualRect(&r, &fullscreen_rect), "Expected %s, got %s.\n",
            wine_dbgstr_rect(&fullscreen_rect), wine_dbgstr_rect(&r));

    ret = SetForegroundWindow(window);
    ok(ret, "Failed to set foreground window.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);

    tmp = GetWindowLongA(window, GWL_STYLE);
    expected_style = style | WS_VISIBLE;
    todo_wine ok(tmp == expected_style, "Expected window style %#lx, got %#lx.\n", expected_style, tmp);
    tmp = GetWindowLongA(window, GWL_EXSTYLE);
    expected_style = exstyle | WS_EX_TOPMOST;
    todo_wine ok(tmp == expected_style, "Expected window extended style %#lx, got %#lx.\n", expected_style, tmp);

    ShowWindow(window, SW_HIDE);
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);

    tmp = GetWindowLongA(window, GWL_STYLE);
    ok(tmp == style, "Expected window style %#lx, got %#lx.\n", style, tmp);
    tmp = GetWindowLongA(window, GWL_EXSTYLE);
    ok(tmp == exstyle, "Expected window extended style %#lx, got %#lx.\n", exstyle, tmp);

    ShowWindow(window, SW_SHOW);
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);

    tmp = GetWindowLongA(window, GWL_STYLE);
    expected_style = style | WS_VISIBLE;
    todo_wine ok(tmp == expected_style, "Expected window style %#lx, got %#lx.\n", expected_style, tmp);
    tmp = GetWindowLongA(window, GWL_EXSTYLE);
    expected_style = exstyle | WS_EX_TOPMOST;
    todo_wine ok(tmp == expected_style, "Expected window extended style %#lx, got %#lx.\n", expected_style, tmp);

    ret = SetForegroundWindow(foreground);
    ok(ret, "Failed to set foreground window.\n");
    tmp = GetWindowLongA(window, GWL_STYLE);
    expected_style = style | WS_VISIBLE | WS_MINIMIZE;
    todo_wine ok(tmp == expected_style, "Expected window style %#lx, got %#lx.\n", expected_style, tmp);
    tmp = GetWindowLongA(window, GWL_EXSTYLE);
    expected_style = exstyle | WS_EX_TOPMOST;
    todo_wine ok(tmp == expected_style, "Expected window extended style %#lx, got %#lx.\n", expected_style, tmp);

    /* Test that there is a ~1.5s timer that checks and restores WS_EX_TOPMOST if it's missing */
    ret = ShowWindow(window, SW_RESTORE);
    ok(ret, "ShowWindow failed, error %#lx.\n", GetLastError());
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);
    flush_events();

    /* Remove WS_VISIBLE and WS_EX_TOPMOST */
    tmp = GetWindowLongA(window, GWL_STYLE);
    ok(tmp & WS_VISIBLE, "Expected WS_VISIBLE.\n");
    tmp = GetWindowLongA(window, GWL_EXSTYLE);
    ok(tmp & WS_EX_TOPMOST, "Expected WS_EX_TOPMOST.\n");
    for (i = 0; i < 5; ++i)
    {
        /* Try a few times to hide the window. Something in Win11 26H1 shows it again and makes it
         * topmost. This is in addition to the ddraw periodic check below, which only makes it
         * topmost but not visible */
        ret = SetWindowPos(window, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_HIDEWINDOW);
        ok(ret, "SetWindowPos failed, error %#lx.\n", GetLastError());
        tmp = GetWindowLongA(window, GWL_STYLE);
        if (!(tmp & WS_VISIBLE))
            break;
        Sleep(100);
    }
    ok(i < 5, "Failed to hide the window.\n");
    tmp = GetWindowLongA(window, GWL_STYLE);
    ok(!(tmp & WS_VISIBLE), "Got unexpected WS_VISIBLE.\n");
    tmp = GetWindowLongA(window, GWL_EXSTYLE);
    ok(!(tmp & WS_EX_TOPMOST), "Got unexpected WS_EX_TOPMOST.\n");

    Sleep(2000);
    flush_events();

    /* WS_VISIBLE is not restored but WS_EX_TOPMOST is */
    tmp = GetWindowLongA(window, GWL_STYLE);
    ok(!(tmp & WS_VISIBLE), "Got unexpected WS_VISIBLE.\n");
    tmp = GetWindowLongA(window, GWL_EXSTYLE);
    ok(tmp & WS_EX_TOPMOST, "Expected WS_EX_TOPMOST.\n");

    ref = IDirectDraw2_Release(ddraw);
    ok(!ref, "Unexpected refcount %lu.\n", ref);

    DestroyWindow(window2);
    DestroyWindow(window);
}

static void test_redundant_mode_set(void)
{
    DDSURFACEDESC surface_desc = {0};
    IDirectDraw2 *ddraw;
    RECT q, r, s;
    HWND window;
    HRESULT hr;
    ULONG ref;

    window = CreateWindowA("static", "ddraw_test", WS_OVERLAPPEDWINDOW,
            0, 0, 100, 100, 0, 0, 0, 0);
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);

    surface_desc.dwSize = sizeof(surface_desc);
    hr = IDirectDraw2_GetDisplayMode(ddraw, &surface_desc);
    ok(SUCCEEDED(hr), "GetDisplayMode failed, hr %#lx.\n", hr);

    hr = IDirectDraw2_SetDisplayMode(ddraw, surface_desc.dwWidth, surface_desc.dwHeight,
            surface_desc.ddpfPixelFormat.dwRGBBitCount, 0, 0);
    ok(SUCCEEDED(hr), "SetDisplayMode failed, hr %#lx.\n", hr);

    GetWindowRect(window, &q);
    r = q;
    r.right /= 2;
    r.bottom /= 2;
    SetWindowPos(window, HWND_TOP, r.left, r.top, r.right, r.bottom, 0);
    GetWindowRect(window, &s);
    ok(EqualRect(&r, &s), "Expected %s, got %s.\n", wine_dbgstr_rect(&r), wine_dbgstr_rect(&s));

    hr = IDirectDraw2_SetDisplayMode(ddraw, surface_desc.dwWidth, surface_desc.dwHeight,
            surface_desc.ddpfPixelFormat.dwRGBBitCount, 0, 0);
    ok(SUCCEEDED(hr), "SetDisplayMode failed, hr %#lx.\n", hr);

    GetWindowRect(window, &s);
    ok(EqualRect(&r, &s) || broken(EqualRect(&q, &s) /* Windows 10 */),
            "Expected %s, got %s.\n", wine_dbgstr_rect(&r), wine_dbgstr_rect(&s));

    ref = IDirectDraw2_Release(ddraw);
    ok(!ref, "Unexpected refcount %lu.\n", ref);

    DestroyWindow(window);
}

static SIZE screen_size, screen_size2;

static LRESULT CALLBACK mode_set_proc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam)
{
    if (message == WM_SIZE)
    {
        screen_size.cx = GetSystemMetrics(SM_CXSCREEN);
        screen_size.cy = GetSystemMetrics(SM_CYSCREEN);
    }

    return test_proc(hwnd, message, wparam, lparam);
}

static LRESULT CALLBACK mode_set_proc2(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam)
{
    if (message == WM_SIZE)
    {
        screen_size2.cx = GetSystemMetrics(SM_CXSCREEN);
        screen_size2.cy = GetSystemMetrics(SM_CYSCREEN);
    }

    return test_proc(hwnd, message, wparam, lparam);
}

struct test_coop_level_mode_set_enum_param
{
    DWORD ddraw_width, ddraw_height, user32_width, user32_height;
};

static HRESULT CALLBACK test_coop_level_mode_set_enum_cb(DDSURFACEDESC *surface_desc, void *context)
{
    struct test_coop_level_mode_set_enum_param *param = context;

    if (surface_desc->ddpfPixelFormat.dwRGBBitCount != registry_mode.dmBitsPerPel)
        return DDENUMRET_OK;
    if (surface_desc->dwWidth == registry_mode.dmPelsWidth
            && surface_desc->dwHeight == registry_mode.dmPelsHeight)
        return DDENUMRET_OK;

    if (!param->ddraw_width)
    {
        param->ddraw_width = surface_desc->dwWidth;
        param->ddraw_height = surface_desc->dwHeight;
        return DDENUMRET_OK;
    }
    if (surface_desc->dwWidth == param->ddraw_width && surface_desc->dwHeight == param->ddraw_height)
        return DDENUMRET_OK;

    /* The docs say the DDENUMRET_CANCEL below cancels the enumeration, so the check should be
     * redundant. However, since Windows 10 this no longer works and the enumeration continues
     * until all supported modes are enumerated. Win8 and earlier do cancel.
     *
     * Unrelatedly, some testbot machines report high res modes like 1920x1080, but suffer from
     * some problems when we actually try to set them (w10pro64 and its localization siblings).
     * Try to stay below the registry mode if possible. */
    if (!param->user32_width || (surface_desc->dwWidth < registry_mode.dmPelsWidth
            && surface_desc->dwHeight < registry_mode.dmPelsHeight))
    {
        param->user32_width = surface_desc->dwWidth;
        param->user32_height = surface_desc->dwHeight;
    }
    return DDENUMRET_CANCEL;
}

static void test_coop_level_mode_set(void)
{
    DEVMODEA *original_modes = NULL, devmode, devmode2;
    unsigned int display_count = 0;
    IDirectDrawSurface *primary;
    RECT registry_rect, ddraw_rect, user32_rect, r;
    IDirectDraw2 *ddraw;
    DDSURFACEDESC ddsd;
    WNDCLASSA wc = {0};
    HWND window, window2;
    HRESULT hr;
    ULONG ref;
    MSG msg;
    struct test_coop_level_mode_set_enum_param param;
    BOOL ret;
    LONG change_ret;

    static const struct message exclusive_messages[] =
    {
        {WM_WINDOWPOSCHANGING,  FALSE,  0},
        {WM_WINDOWPOSCHANGED,   FALSE,  0},
        {WM_SIZE,               FALSE,  0},
        {WM_DISPLAYCHANGE,      FALSE,  0},
        {0,                     FALSE,  0},
    };
    static const struct message exclusive_focus_loss_messages[] =
    {
        {WM_ACTIVATE,           TRUE,   WA_INACTIVE},
        {WM_WINDOWPOSCHANGING,  FALSE,  0}, /* Window resize due to mode change. */
        {WM_WINDOWPOSCHANGED,   FALSE,  0},
        {WM_SIZE,               TRUE,   SIZE_RESTORED}, /* Generated by DefWindowProc. */
        {WM_DISPLAYCHANGE,      FALSE,  0},
        {WM_KILLFOCUS,          FALSE,  0},
        {WM_WINDOWPOSCHANGING,  FALSE,  0}, /* Window minimized. */
        /* Like d3d8 and d3d9 ddraw seems to use SW_SHOWMINIMIZED instead of
         * SW_MINIMIZED, causing a recursive window activation that does not
         * produce the same result in Wine yet. Ignore the difference for now.
         * {WM_ACTIVATE,           TRUE,   0x200000 | WA_ACTIVE}, */
        {WM_WINDOWPOSCHANGED,   FALSE,  0},
        {WM_MOVE,               FALSE,  0},
        {WM_SIZE,               TRUE,   SIZE_MINIMIZED},
        {WM_ACTIVATEAPP,        TRUE,   FALSE},
        {0,                     FALSE,  0},
    };
    static const struct message exclusive_focus_restore_messages[] =
    {
        {WM_WINDOWPOSCHANGING,  FALSE,  0}, /* From the ShowWindow(SW_RESTORE). */
        {WM_WINDOWPOSCHANGING,  FALSE,  0}, /* Generated by ddraw, matches d3d9 behavior. */
        {WM_WINDOWPOSCHANGED,   FALSE,  0}, /* Matching previous message. */
        {WM_SIZE,               FALSE,  0}, /* DefWindowProc. */
        {WM_DISPLAYCHANGE,      FALSE,  0}, /* Ddraw restores mode. */
        /* Native redundantly sets the window size here. */
        {WM_ACTIVATEAPP,        TRUE,   TRUE}, /* End of ddraw's hooks. */
        {WM_WINDOWPOSCHANGED,   FALSE,  0}, /* Matching the one from ShowWindow. */
        {WM_MOVE,               FALSE,  0}, /* DefWindowProc. */
        {WM_SIZE,               TRUE,   SIZE_RESTORED}, /* DefWindowProc. */
        {0,                     FALSE,  0},
    };
    static const struct message sc_restore_messages[] =
    {
        {WM_SYSCOMMAND,         TRUE,   SC_RESTORE},
        {WM_WINDOWPOSCHANGING,  FALSE,  0},
        {WM_WINDOWPOSCHANGED,   FALSE,  0},
        {WM_SIZE,               TRUE,   SIZE_RESTORED},
        {0,                     FALSE,  0},
    };
    static const struct message sc_minimize_messages[] =
    {
        {WM_SYSCOMMAND,         TRUE,   SC_MINIMIZE},
        {WM_WINDOWPOSCHANGING,  FALSE,  0},
        {WM_WINDOWPOSCHANGED,   FALSE,  0},
        {WM_SIZE,               TRUE,   SIZE_MINIMIZED},
        {0,                     FALSE,  0},
    };
    static const struct message sc_maximize_messages[] =
    {
        {WM_SYSCOMMAND,         TRUE,   SC_MAXIMIZE},
        {WM_WINDOWPOSCHANGING,  FALSE,  0},
        {WM_WINDOWPOSCHANGED,   FALSE,  0},
        {WM_SIZE,               TRUE,   SIZE_MAXIMIZED},
        {0,                     FALSE,  0},
    };

    static const struct message normal_messages[] =
    {
        {WM_DISPLAYCHANGE,      FALSE,  0},
        {0,                     FALSE,  0},
    };

    static const struct message release_messages[] =
    {
        {WM_PAINT,              FALSE,  0},
        {0,                     FALSE,  0},
    };

    memset(&devmode, 0, sizeof(devmode));
    devmode.dmSize = sizeof(devmode);
    ret = EnumDisplaySettingsA(NULL, ENUM_CURRENT_SETTINGS, &devmode);
    ok(ret, "EnumDisplaySettingsA failed, error %lu.\n", GetLastError());
    ok(compare_mode_rect(&devmode, &registry_mode), "Got a different mode.\n");
    ret = EnumDisplaySettingsA(NULL, ENUM_REGISTRY_SETTINGS, &devmode);
    ok(ret, "EnumDisplaySettingsA failed, error %lu.\n", GetLastError());
    ok(compare_mode_rect(&devmode, &registry_mode), "Got a different mode.\n");

    ret = save_display_modes(&original_modes, &display_count);
    ok(ret, "Failed to save original display modes.\n");

    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");

    memset(&param, 0, sizeof(param));
    hr = IDirectDraw2_EnumDisplayModes(ddraw, 0, NULL, &param, test_coop_level_mode_set_enum_cb);
    ok(SUCCEEDED(hr), "Failed to enumerate display mode, hr %#lx.\n", hr);
    ref = IDirectDraw2_Release(ddraw);
    ok(!ref, "Unexpected refcount %lu.\n", ref);

    if (!param.user32_height)
    {
        skip("Fewer than 3 different modes supported, skipping mode restore test.\n");
        free(original_modes);
        return;
    }

    SetRect(&registry_rect, 0, 0, registry_mode.dmPelsWidth, registry_mode.dmPelsHeight);
    SetRect(&ddraw_rect, 0, 0, param.ddraw_width, param.ddraw_height);
    SetRect(&user32_rect, 0, 0, param.user32_width, param.user32_height);

    memset(&devmode, 0, sizeof(devmode));
    devmode.dmSize = sizeof(devmode);
    devmode.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT;
    devmode.dmPelsWidth = param.user32_width;
    devmode.dmPelsHeight = param.user32_height;
    change_ret = ChangeDisplaySettingsA(&devmode, CDS_FULLSCREEN);
    ok(change_ret == DISP_CHANGE_SUCCESSFUL, "Failed to change display mode, ret %#lx.\n", change_ret);

    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");

    wc.lpfnWndProc = mode_set_proc;
    wc.lpszClassName = "ddraw_test_wndproc_wc";
    ok(RegisterClassA(&wc), "Failed to register window class.\n");
    wc.lpfnWndProc = mode_set_proc2;
    wc.lpszClassName = "ddraw_test_wndproc_wc2";
    ok(RegisterClassA(&wc), "Failed to register window class.\n");

    window = CreateWindowA("ddraw_test_wndproc_wc", "ddraw_test", WS_OVERLAPPEDWINDOW,
            0, 0, 100, 100, 0, 0, 0, 0);
    window2 = CreateWindowA("ddraw_test_wndproc_wc2", "ddraw_test", WS_OVERLAPPEDWINDOW,
            0, 0, 100, 100, 0, 0, 0, 0);

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);

    GetWindowRect(window, &r);
    ok(EqualRect(&r, &user32_rect), "Expected %s, got %s.\n", wine_dbgstr_rect(&user32_rect),
            wine_dbgstr_rect(&r));

    memset(&ddsd, 0, sizeof(ddsd));
    ddsd.dwSize = sizeof(ddsd);
    ddsd.dwFlags = DDSD_CAPS;
    ddsd.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE;

    hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &primary, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n",hr);
    hr = IDirectDrawSurface_GetSurfaceDesc(primary, &ddsd);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(ddsd.dwWidth == param.user32_width, "Expected surface width %lu, got %lu.\n",
            param.user32_width, ddsd.dwWidth);
    ok(ddsd.dwHeight == param.user32_height, "Expected surface height %lu, got %lu.\n",
            param.user32_height, ddsd.dwHeight);

    GetWindowRect(window, &r);
    ok(EqualRect(&r, &user32_rect), "Expected %s, got %s.\n", wine_dbgstr_rect(&user32_rect),
            wine_dbgstr_rect(&r));

    PeekMessageA(&msg, 0, 0, 0, PM_NOREMOVE);
    expect_messages = exclusive_messages;
    screen_size.cx = 0;
    screen_size.cy = 0;

    hr = IDirectDrawSurface_IsLost(primary);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = set_display_mode(ddraw, param.ddraw_width, param.ddraw_height);
    ok(SUCCEEDED(hr), "Failed to set display mode, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(primary);
    ok(hr == DDERR_SURFACELOST, "Got unexpected hr %#lx.\n", hr);

    ok(!expect_messages->message, "Expected message %#x, but didn't receive it.\n", expect_messages->message);
    expect_messages = NULL;
    ok(screen_size.cx == param.ddraw_width && screen_size.cy == param.ddraw_height,
            "Expected screen size %lux%lu, got %lux%lu.\n",
            param.ddraw_width, param.ddraw_height, screen_size.cx, screen_size.cy);

    GetWindowRect(window, &r);
    ok(EqualRect(&r, &ddraw_rect), "Expected %s, got %s.\n", wine_dbgstr_rect(&ddraw_rect),
            wine_dbgstr_rect(&r));

    hr = IDirectDrawSurface_GetSurfaceDesc(primary, &ddsd);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(ddsd.dwWidth == param.user32_width, "Expected surface width %lu, got %lu.\n",
            param.user32_width, ddsd.dwWidth);
    ok(ddsd.dwHeight == param.user32_height, "Expected surface height %lu, got %lu.\n",
            param.user32_height, ddsd.dwHeight);

    flush_events();
    expect_messages = release_messages;
    IDirectDrawSurface_Release(primary);
    flush_events();
    ok(!expect_messages->message, "Expected message %#x, but didn't receive it.\n", expect_messages->message);
    expect_messages = NULL;

    memset(&ddsd, 0, sizeof(ddsd));
    ddsd.dwSize = sizeof(ddsd);
    ddsd.dwFlags = DDSD_CAPS;
    ddsd.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE;

    hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &primary, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n",hr);
    hr = IDirectDrawSurface_GetSurfaceDesc(primary, &ddsd);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(ddsd.dwWidth == param.ddraw_width, "Expected surface width %lu, got %lu.\n",
            param.ddraw_width, ddsd.dwWidth);
    ok(ddsd.dwHeight == param.ddraw_height, "Expected surface height %lu, got %lu.\n",
            param.ddraw_height, ddsd.dwHeight);

    GetWindowRect(window, &r);
    flaky /* win10 21H2 with QXL driver */
    ok(EqualRect(&r, &ddraw_rect), "Expected %s, got %s.\n", wine_dbgstr_rect(&ddraw_rect),
            wine_dbgstr_rect(&r));

    PeekMessageA(&msg, 0, 0, 0, PM_NOREMOVE);
    expect_messages = exclusive_messages;
    screen_size.cx = 0;
    screen_size.cy = 0;

    hr = IDirectDrawSurface_IsLost(primary);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    change_ret = ChangeDisplaySettingsA(&devmode, CDS_FULLSCREEN);
    ok(change_ret == DISP_CHANGE_SUCCESSFUL, "Failed to change display mode, ret %#lx.\n", change_ret);
    hr = IDirectDrawSurface_IsLost(primary);
    ok(hr == DDERR_SURFACELOST, "Got unexpected hr %#lx.\n", hr);

    ok(!expect_messages->message, "Expected message %#x, but didn't receive it.\n", expect_messages->message);
    expect_messages = NULL;
    ok(screen_size.cx == param.user32_width && screen_size.cy == param.user32_height,
            "Expected screen size %lux%lu, got %lux%lu.\n",
            param.user32_width, param.user32_height, screen_size.cx, screen_size.cy);

    GetWindowRect(window, &r);
    ok(EqualRect(&r, &user32_rect), "Expected %s, got %s.\n", wine_dbgstr_rect(&user32_rect),
            wine_dbgstr_rect(&r));

    expect_messages = exclusive_focus_loss_messages;
    ret = SetForegroundWindow(foreground);
    ok(ret, "Failed to set foreground window.\n");
    ok(!expect_messages->message, "Expected message %#x, but didn't receive it.\n", expect_messages->message);
    memset(&devmode, 0, sizeof(devmode));
    devmode.dmSize = sizeof(devmode);
    ret = EnumDisplaySettingsA(NULL, ENUM_CURRENT_SETTINGS, &devmode);
    ok(ret, "Failed to get display mode.\n");
    ok(devmode.dmPelsWidth == registry_mode.dmPelsWidth
            && devmode.dmPelsHeight == registry_mode.dmPelsHeight, "Got unexpected screen size %lux%lu.\n",
            devmode.dmPelsWidth, devmode.dmPelsHeight);

    expect_messages = exclusive_focus_restore_messages;
    ShowWindow(window, SW_RESTORE);
    ok(!expect_messages->message, "Expected message %#x, but didn't receive it.\n", expect_messages->message);

    GetWindowRect(window, &r);
    ok(EqualRect(&r, &ddraw_rect), "Expected %s, got %s.\n", wine_dbgstr_rect(&ddraw_rect),
            wine_dbgstr_rect(&r));
    ret = EnumDisplaySettingsA(NULL, ENUM_CURRENT_SETTINGS, &devmode);
    ok(ret, "Failed to get display mode.\n");
    ok(devmode.dmPelsWidth == param.ddraw_width
            && devmode.dmPelsHeight == param.ddraw_height, "Got unexpected screen size %lux%lu.\n",
            devmode.dmPelsWidth, devmode.dmPelsHeight);

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);
    /* Normally the primary should be restored here. Unfortunately this causes the
     * GetSurfaceDesc call after the next display mode change to crash on the Windows 8
     * testbot. Another Restore call would presumably avoid the crash, but it also moots
     * the point of the GetSurfaceDesc call. */

    expect_messages = sc_minimize_messages;
    SendMessageA(window, WM_SYSCOMMAND, SC_MINIMIZE, 0);
    ok(!expect_messages->message, "Expected message %#x, but didn't receive it.\n", expect_messages->message);
    expect_messages = NULL;

    expect_messages = sc_restore_messages;
    SendMessageA(window, WM_SYSCOMMAND, SC_RESTORE, 0);
    ok(!expect_messages->message, "Expected message %#x, but didn't receive it.\n", expect_messages->message);
    expect_messages = NULL;

    expect_messages = sc_maximize_messages;
    SendMessageA(window, WM_SYSCOMMAND, SC_MAXIMIZE, 0);
    ok(!expect_messages->message, "Expected message %#x, but didn't receive it.\n", expect_messages->message);
    expect_messages = NULL;

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);

    PeekMessageA(&msg, 0, 0, 0, PM_NOREMOVE);
    expect_messages = exclusive_messages;
    screen_size.cx = 0;
    screen_size.cy = 0;

    hr = IDirectDrawSurface_IsLost(primary);
    ok(hr == DDERR_SURFACELOST, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDraw2_RestoreDisplayMode(ddraw);
    ok(SUCCEEDED(hr), "RestoreDisplayMode failed, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(primary);
    ok(hr == DDERR_SURFACELOST, "Got unexpected hr %#lx.\n", hr);

    flaky /* win8 */
    ok(!expect_messages->message, "Expected message %#x, but didn't receive it.\n", expect_messages->message);
    expect_messages = NULL;
    flaky /* win8 */
    ok(screen_size.cx == registry_mode.dmPelsWidth
            && screen_size.cy == registry_mode.dmPelsHeight,
            "Expected screen size %lux%lu, got %lux%lu.\n",
            registry_mode.dmPelsWidth, registry_mode.dmPelsHeight, screen_size.cx, screen_size.cy);

    GetWindowRect(window, &r);
    flaky /* win8 */
    ok(EqualRect(&r, &registry_rect), "Expected %s, got %s.\n", wine_dbgstr_rect(&registry_rect),
            wine_dbgstr_rect(&r));

    hr = IDirectDrawSurface_GetSurfaceDesc(primary, &ddsd);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(ddsd.dwWidth == param.ddraw_width, "Expected surface width %lu, got %lu.\n",
            param.ddraw_width, ddsd.dwWidth);
    ok(ddsd.dwHeight == param.ddraw_height, "Expected surface height %lu, got %lu.\n",
            param.ddraw_height, ddsd.dwHeight);

    flush_events();
    expect_messages = release_messages;
    IDirectDrawSurface_Release(primary);
    flush_events();
    flaky /* win10 21H2 with QXL driver */
    ok(expect_messages->message == WM_PAINT, "Unexpected WM_PAINT.\n");
    expect_messages = NULL;

    /* For Wine. */
    change_ret = ChangeDisplaySettingsA(NULL, CDS_FULLSCREEN);
    ok(change_ret == DISP_CHANGE_SUCCESSFUL, "Failed to change display mode, ret %#lx.\n", change_ret);
    flush_events();

    if (IsIconic(window)) /* make sure the window is restored, working around some Wine/X11 race condition */
    {
        ShowWindow(window, SW_RESTORE);
        flush_events();
    }

    memset(&ddsd, 0, sizeof(ddsd));
    ddsd.dwSize = sizeof(ddsd);
    ddsd.dwFlags = DDSD_CAPS;
    ddsd.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE;

    hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &primary, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n",hr);
    hr = IDirectDrawSurface_GetSurfaceDesc(primary, &ddsd);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(ddsd.dwWidth == registry_mode.dmPelsWidth, "Expected surface width %lu, got %lu.\n",
            registry_mode.dmPelsWidth, ddsd.dwWidth);
    ok(ddsd.dwHeight == registry_mode.dmPelsHeight, "Expected surface height %lu, got %lu.\n",
            registry_mode.dmPelsHeight, ddsd.dwHeight);

    GetWindowRect(window, &r);
    flaky /* win8 */
    ok(EqualRect(&r, &registry_rect), "Expected %s, got %s.\n", wine_dbgstr_rect(&registry_rect),
            wine_dbgstr_rect(&r));

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);

    GetWindowRect(window, &r);
    flaky /* win8 */
    ok(EqualRect(&r, &registry_rect), "Expected %s, got %s.\n", wine_dbgstr_rect(&registry_rect),
            wine_dbgstr_rect(&r));

    hr = IDirectDrawSurface_GetSurfaceDesc(primary, &ddsd);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(ddsd.dwWidth == registry_mode.dmPelsWidth, "Expected surface width %lu, got %lu.\n",
            registry_mode.dmPelsWidth, ddsd.dwWidth);
    ok(ddsd.dwHeight == registry_mode.dmPelsHeight, "Expected surface height %lu, got %lu.\n",
            registry_mode.dmPelsHeight, ddsd.dwHeight);

    flush_events();
    expect_messages = release_messages;
    IDirectDrawSurface_Release(primary);
    flush_events();
    flaky /* win10 21H2 with QXL driver */
    ok(expect_messages->message == WM_PAINT, "Unexpected WM_PAINT.\n");
    expect_messages = NULL;

    memset(&ddsd, 0, sizeof(ddsd));
    ddsd.dwSize = sizeof(ddsd);
    ddsd.dwFlags = DDSD_CAPS;
    ddsd.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE;

    hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &primary, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n",hr);
    hr = IDirectDrawSurface_GetSurfaceDesc(primary, &ddsd);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(ddsd.dwWidth == registry_mode.dmPelsWidth, "Expected surface width %lu, got %lu.\n",
            registry_mode.dmPelsWidth, ddsd.dwWidth);
    ok(ddsd.dwHeight == registry_mode.dmPelsHeight, "Expected surface height %lu, got %lu.\n",
            registry_mode.dmPelsHeight, ddsd.dwHeight);

    GetWindowRect(window, &r);
    flaky /* win8 */
    ok(EqualRect(&r, &registry_rect), "Expected %s, got %s.\n", wine_dbgstr_rect(&registry_rect),
            wine_dbgstr_rect(&r));

    PeekMessageA(&msg, 0, 0, 0, PM_NOREMOVE);
    expect_messages = normal_messages;
    screen_size.cx = 0;
    screen_size.cy = 0;

    hr = IDirectDrawSurface_IsLost(primary);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    devmode.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT;
    devmode.dmPelsWidth = param.user32_width;
    devmode.dmPelsHeight = param.user32_height;
    change_ret = ChangeDisplaySettingsA(&devmode, CDS_FULLSCREEN);
    ok(change_ret == DISP_CHANGE_SUCCESSFUL, "Failed to change display mode, ret %#lx.\n", change_ret);
    hr = IDirectDrawSurface_IsLost(primary);
    todo_wine ok(hr == DDERR_SURFACELOST, "Got unexpected hr %#lx.\n", hr);

    ok(!expect_messages->message, "Expected message %#x, but didn't receive it.\n", expect_messages->message);
    expect_messages = NULL;
    ok(!screen_size.cx && !screen_size.cy, "Got unexpected screen size %lux%lu.\n", screen_size.cx, screen_size.cy);

    GetWindowRect(window, &r);
    flaky /* win8 */
    ok(EqualRect(&r, &registry_rect), "Expected %s, got %s.\n", wine_dbgstr_rect(&registry_rect),
            wine_dbgstr_rect(&r));

    PeekMessageA(&msg, 0, 0, 0, PM_NOREMOVE);
    expect_messages = normal_messages;
    screen_size.cx = 0;
    screen_size.cy = 0;

    hr = IDirectDrawSurface_Restore(primary);
    ok(hr == DDERR_WRONGMODE, "Got unexpected hr %#lx.\n", hr);
    hr = set_display_mode(ddraw, param.ddraw_width, param.ddraw_height);
    if (hr == DDERR_NOEXCLUSIVEMODE /* NT4 testbot */)
    {
        win_skip("Broken SetDisplayMode(), skipping remaining tests.\n");
        IDirectDrawSurface_Release(primary);
        IDirectDraw2_Release(ddraw);
        goto done;
    }
    ok(SUCCEEDED(hr), "Failed to set display mode, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Restore(primary);
    ok(hr == DDERR_WRONGMODE, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(primary);
    ok(hr == DDERR_SURFACELOST, "Got unexpected hr %#lx.\n", hr);

    ok(!expect_messages->message, "Expected message %#x, but didn't receive it.\n", expect_messages->message);
    expect_messages = NULL;
    ok(!screen_size.cx && !screen_size.cy, "Got unexpected screen size %lux%lu.\n", screen_size.cx, screen_size.cy);

    GetWindowRect(window, &r);
    flaky /* win8 */
    ok(EqualRect(&r, &registry_rect), "Expected %s, got %s.\n", wine_dbgstr_rect(&registry_rect),
            wine_dbgstr_rect(&r));

    hr = IDirectDrawSurface_GetSurfaceDesc(primary, &ddsd);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(ddsd.dwWidth == registry_mode.dmPelsWidth, "Expected surface width %lu, got %lu.\n",
            registry_mode.dmPelsWidth, ddsd.dwWidth);
    ok(ddsd.dwHeight == registry_mode.dmPelsHeight, "Expected surface height %lu, got %lu.\n",
            registry_mode.dmPelsHeight, ddsd.dwHeight);

    flush_events();
    expect_messages = release_messages;
    IDirectDrawSurface_Release(primary);
    flush_events();
    ok(!expect_messages->message, "Expected message %#x, but didn't receive it.\n", expect_messages->message);
    expect_messages = NULL;

    memset(&ddsd, 0, sizeof(ddsd));
    ddsd.dwSize = sizeof(ddsd);
    ddsd.dwFlags = DDSD_CAPS;
    ddsd.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE;

    hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &primary, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n",hr);
    hr = IDirectDrawSurface_GetSurfaceDesc(primary, &ddsd);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(ddsd.dwWidth == param.ddraw_width, "Expected surface width %lu, got %lu.\n",
            param.ddraw_width, ddsd.dwWidth);
    ok(ddsd.dwHeight == param.ddraw_height, "Expected surface height %lu, got %lu.\n",
            param.ddraw_height, ddsd.dwHeight);

    GetWindowRect(window, &r);
    flaky /* win8 */
    ok(EqualRect(&r, &registry_rect), "Expected %s, got %s.\n", wine_dbgstr_rect(&registry_rect),
            wine_dbgstr_rect(&r));

    PeekMessageA(&msg, 0, 0, 0, PM_NOREMOVE);
    expect_messages = normal_messages;
    screen_size.cx = 0;
    screen_size.cy = 0;

    hr = IDirectDrawSurface_IsLost(primary);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDraw2_RestoreDisplayMode(ddraw);
    ok(SUCCEEDED(hr), "RestoreDisplayMode failed, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(primary);
    ok(hr == DDERR_SURFACELOST, "Got unexpected hr %#lx.\n", hr);

    ok(!expect_messages->message, "Expected message %#x, but didn't receive it.\n", expect_messages->message);
    expect_messages = NULL;
    ok(!screen_size.cx && !screen_size.cy, "Got unexpected screen size %lux%lu.\n", screen_size.cx, screen_size.cy);

    GetWindowRect(window, &r);
    flaky /* win8 */
    ok(EqualRect(&r, &registry_rect), "Expected %s, got %s.\n", wine_dbgstr_rect(&registry_rect),
            wine_dbgstr_rect(&r));

    hr = IDirectDrawSurface_GetSurfaceDesc(primary, &ddsd);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(ddsd.dwWidth == param.ddraw_width, "Expected surface width %lu, got %lu.\n",
            param.ddraw_width, ddsd.dwWidth);
    ok(ddsd.dwHeight == param.ddraw_height, "Expected surface height %lu, got %lu.\n",
            param.ddraw_height, ddsd.dwHeight);

    flush_events();
    expect_messages = release_messages;
    IDirectDrawSurface_Release(primary);
    flush_events();
    flaky /* win10 21H2 with QXL driver */
    ok(expect_messages->message == WM_PAINT, "Unexpected WM_PAINT.\n");
    expect_messages = NULL;

    ret = EnumDisplaySettingsA(NULL, ENUM_CURRENT_SETTINGS, &devmode);
    ok(ret, "Failed to get display mode.\n");
    ok(devmode.dmPelsWidth == registry_mode.dmPelsWidth
            && devmode.dmPelsHeight == registry_mode.dmPelsHeight,
            "Expected resolution %lux%lu, got %lux%lu.\n",
            registry_mode.dmPelsWidth, registry_mode.dmPelsHeight,
            devmode.dmPelsWidth, devmode.dmPelsHeight);
    change_ret = ChangeDisplaySettingsA(NULL, CDS_FULLSCREEN);
    ok(change_ret == DISP_CHANGE_SUCCESSFUL, "Failed to change display mode, ret %#lx.\n", change_ret);

    memset(&ddsd, 0, sizeof(ddsd));
    ddsd.dwSize = sizeof(ddsd);
    ddsd.dwFlags = DDSD_CAPS;
    ddsd.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE;

    hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &primary, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n",hr);
    hr = IDirectDrawSurface_GetSurfaceDesc(primary, &ddsd);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(ddsd.dwWidth == registry_mode.dmPelsWidth, "Expected surface width %lu, got %lu.\n",
            registry_mode.dmPelsWidth, ddsd.dwWidth);
    ok(ddsd.dwHeight == registry_mode.dmPelsHeight, "Expected surface height %lu, got %lu.\n",
            registry_mode.dmPelsHeight, ddsd.dwHeight);

    GetWindowRect(window, &r);
    flaky /* win8 */
    ok(EqualRect(&r, &registry_rect), "Expected %s, got %s.\n", wine_dbgstr_rect(&registry_rect),
            wine_dbgstr_rect(&r));

    /* DDSCL_NORMAL | DDSCL_FULLSCREEN behaves the same as just DDSCL_NORMAL.
     * Resizing the window on mode changes is a property of DDSCL_EXCLUSIVE,
     * not DDSCL_FULLSCREEN. */
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);

    GetWindowRect(window, &r);
    flaky /* win8 */
    ok(EqualRect(&r, &registry_rect), "Expected %s, got %s.\n", wine_dbgstr_rect(&registry_rect),
            wine_dbgstr_rect(&r));

    hr = IDirectDrawSurface_GetSurfaceDesc(primary, &ddsd);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(ddsd.dwWidth == registry_mode.dmPelsWidth, "Expected surface width %lu, got %lu.\n",
            registry_mode.dmPelsWidth, ddsd.dwWidth);
    ok(ddsd.dwHeight == registry_mode.dmPelsHeight, "Expected surface height %lu, got %lu.\n",
            registry_mode.dmPelsHeight, ddsd.dwHeight);

    flush_events();
    expect_messages = release_messages;
    IDirectDrawSurface_Release(primary);
    flush_events();
    flaky /* win10 21H2 with QXL driver */
    ok(expect_messages->message == WM_PAINT, "Unexpected WM_PAINT.\n");
    expect_messages = NULL;

    memset(&ddsd, 0, sizeof(ddsd));
    ddsd.dwSize = sizeof(ddsd);
    ddsd.dwFlags = DDSD_CAPS;
    ddsd.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE;

    hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &primary, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n",hr);
    hr = IDirectDrawSurface_GetSurfaceDesc(primary, &ddsd);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(ddsd.dwWidth == registry_mode.dmPelsWidth, "Expected surface width %lu, got %lu.\n",
            registry_mode.dmPelsWidth, ddsd.dwWidth);
    ok(ddsd.dwHeight == registry_mode.dmPelsHeight, "Expected surface height %lu, got %lu.\n",
            registry_mode.dmPelsHeight, ddsd.dwHeight);

    GetWindowRect(window, &r);
    flaky /* win8 */
    ok(EqualRect(&r, &registry_rect), "Expected %s, got %s.\n", wine_dbgstr_rect(&registry_rect),
            wine_dbgstr_rect(&r));

    PeekMessageA(&msg, 0, 0, 0, PM_NOREMOVE);
    expect_messages = normal_messages;
    screen_size.cx = 0;
    screen_size.cy = 0;

    hr = IDirectDrawSurface_IsLost(primary);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    devmode.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT;
    devmode.dmPelsWidth = param.user32_width;
    devmode.dmPelsHeight = param.user32_height;
    change_ret = ChangeDisplaySettingsA(&devmode, CDS_FULLSCREEN);
    ok(change_ret == DISP_CHANGE_SUCCESSFUL, "Failed to change display mode, ret %#lx.\n", change_ret);
    hr = IDirectDrawSurface_IsLost(primary);
    todo_wine ok(hr == DDERR_SURFACELOST, "Got unexpected hr %#lx.\n", hr);

    ok(!expect_messages->message, "Expected message %#x, but didn't receive it.\n", expect_messages->message);
    expect_messages = NULL;
    ok(!screen_size.cx && !screen_size.cy, "Got unexpected screen size %lux%lu.\n", screen_size.cx, screen_size.cy);

    GetWindowRect(window, &r);
    flaky /* win8 */
    ok(EqualRect(&r, &registry_rect), "Expected %s, got %s.\n", wine_dbgstr_rect(&registry_rect),
            wine_dbgstr_rect(&r));

    PeekMessageA(&msg, 0, 0, 0, PM_NOREMOVE);
    expect_messages = normal_messages;
    screen_size.cx = 0;
    screen_size.cy = 0;

    hr = IDirectDrawSurface_Restore(primary);
    ok(hr == DDERR_WRONGMODE, "Got unexpected hr %#lx.\n", hr);
    hr = set_display_mode(ddraw, param.ddraw_width, param.ddraw_height);
    ok(SUCCEEDED(hr), "Failed to set display mode, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Restore(primary);
    ok(hr == DDERR_WRONGMODE, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(primary);
    ok(hr == DDERR_SURFACELOST, "Got unexpected hr %#lx.\n", hr);

    ok(!expect_messages->message, "Expected message %#x, but didn't receive it.\n", expect_messages->message);
    expect_messages = NULL;
    ok(!screen_size.cx && !screen_size.cy, "Got unexpected screen size %lux%lu.\n", screen_size.cx, screen_size.cy);

    GetWindowRect(window, &r);
    flaky /* win8 */
    ok(EqualRect(&r, &registry_rect), "Expected %s, got %s.\n", wine_dbgstr_rect(&registry_rect),
            wine_dbgstr_rect(&r));

    hr = IDirectDrawSurface_GetSurfaceDesc(primary, &ddsd);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(ddsd.dwWidth == registry_mode.dmPelsWidth, "Expected surface width %lu, got %lu.\n",
            registry_mode.dmPelsWidth, ddsd.dwWidth);
    ok(ddsd.dwHeight == registry_mode.dmPelsHeight, "Expected surface height %lu, got %lu.\n",
            registry_mode.dmPelsHeight, ddsd.dwHeight);

    flush_events();
    expect_messages = release_messages;
    IDirectDrawSurface_Release(primary);
    flush_events();
    ok(!expect_messages->message, "Expected message %#x, but didn't receive it.\n", expect_messages->message);
    expect_messages = NULL;

    memset(&ddsd, 0, sizeof(ddsd));
    ddsd.dwSize = sizeof(ddsd);
    ddsd.dwFlags = DDSD_CAPS;
    ddsd.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE;

    hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &primary, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n",hr);
    hr = IDirectDrawSurface_GetSurfaceDesc(primary, &ddsd);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(ddsd.dwWidth == param.ddraw_width, "Expected surface width %lu, got %lu.\n",
            param.ddraw_width, ddsd.dwWidth);
    ok(ddsd.dwHeight == param.ddraw_height, "Expected surface height %lu, got %lu.\n",
            param.ddraw_height, ddsd.dwHeight);

    GetWindowRect(window, &r);
    flaky /* win8 */
    ok(EqualRect(&r, &registry_rect), "Expected %s, got %s.\n", wine_dbgstr_rect(&registry_rect),
            wine_dbgstr_rect(&r));

    PeekMessageA(&msg, 0, 0, 0, PM_NOREMOVE);
    expect_messages = normal_messages;
    screen_size.cx = 0;
    screen_size.cy = 0;

    hr = IDirectDrawSurface_IsLost(primary);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDraw2_RestoreDisplayMode(ddraw);
    ok(SUCCEEDED(hr), "RestoreDisplayMode failed, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(primary);
    ok(hr == DDERR_SURFACELOST, "Got unexpected hr %#lx.\n", hr);

    ok(!expect_messages->message, "Expected message %#x, but didn't receive it.\n", expect_messages->message);
    expect_messages = NULL;
    ok(!screen_size.cx && !screen_size.cy, "Got unexpected screen size %lux%lu.\n", screen_size.cx, screen_size.cy);

    GetWindowRect(window, &r);
    flaky /* win8 */
    ok(EqualRect(&r, &registry_rect), "Expected %s, got %s.\n", wine_dbgstr_rect(&registry_rect),
            wine_dbgstr_rect(&r));

    hr = IDirectDrawSurface_GetSurfaceDesc(primary, &ddsd);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(ddsd.dwWidth == param.ddraw_width, "Expected surface width %lu, got %lu.\n",
            param.ddraw_width, ddsd.dwWidth);
    ok(ddsd.dwHeight == param.ddraw_height, "Expected surface height %lu, got %lu.\n",
            param.ddraw_height, ddsd.dwHeight);

    flush_events();
    expect_messages = release_messages;
    IDirectDrawSurface_Release(primary);
    flush_events();
    flaky /* win10 21H2 with QXL driver */
    ok(expect_messages->message == WM_PAINT, "Unexpected WM_PAINT.\n");
    expect_messages = NULL;

    ret = EnumDisplaySettingsA(NULL, ENUM_CURRENT_SETTINGS, &devmode);
    ok(ret, "Failed to get display mode.\n");
    ok(devmode.dmPelsWidth == registry_mode.dmPelsWidth
            && devmode.dmPelsHeight == registry_mode.dmPelsHeight,
            "Expected resolution %lux%lu, got %lux%lu.\n",
            registry_mode.dmPelsWidth, registry_mode.dmPelsHeight,
            devmode.dmPelsWidth, devmode.dmPelsHeight);
    change_ret = ChangeDisplaySettingsA(NULL, CDS_FULLSCREEN);
    ok(change_ret == DISP_CHANGE_SUCCESSFUL, "Failed to change display mode, ret %#lx.\n", change_ret);

    memset(&ddsd, 0, sizeof(ddsd));
    ddsd.dwSize = sizeof(ddsd);
    ddsd.dwFlags = DDSD_CAPS;
    ddsd.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE;

    hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &primary, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n",hr);
    hr = IDirectDrawSurface_GetSurfaceDesc(primary, &ddsd);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(ddsd.dwWidth == registry_mode.dmPelsWidth, "Expected surface width %lu, got %lu.\n",
            registry_mode.dmPelsWidth, ddsd.dwWidth);
    ok(ddsd.dwHeight == registry_mode.dmPelsHeight, "Expected surface height %lu, got %lu.\n",
            registry_mode.dmPelsHeight, ddsd.dwHeight);

    flush_events();
    expect_messages = release_messages;
    IDirectDrawSurface_Release(primary);
    flush_events();
    flaky /* win10 21H2 with QXL driver */
    ok(expect_messages->message == WM_PAINT, "Unexpected WM_PAINT.\n");
    expect_messages = NULL;

    GetWindowRect(window, &r);
    flaky /* win8 */
    ok(EqualRect(&r, &registry_rect), "Expected %s, got %s.\n", wine_dbgstr_rect(&registry_rect),
            wine_dbgstr_rect(&r));

    /* Changing the coop level from EXCLUSIVE to NORMAL restores the screen resolution */
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);
    hr = set_display_mode(ddraw, param.ddraw_width, param.ddraw_height);
    ok(SUCCEEDED(hr), "Failed to set display mode, hr %#lx.\n", hr);

    PeekMessageA(&msg, 0, 0, 0, PM_NOREMOVE);
    expect_messages = exclusive_messages;
    screen_size.cx = 0;
    screen_size.cy = 0;

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);

    ok(!expect_messages->message, "Expected message %#x, but didn't receive it.\n", expect_messages->message);
    expect_messages = NULL;
    ok(screen_size.cx == registry_mode.dmPelsWidth
            && screen_size.cy == registry_mode.dmPelsHeight,
            "Expected screen size %lux%lu, got %lux%lu.\n",
            registry_mode.dmPelsWidth, registry_mode.dmPelsHeight,
            screen_size.cx, screen_size.cy);

    GetWindowRect(window, &r);
    ok(EqualRect(&r, &registry_rect), "Expected %s, got %s.\n", wine_dbgstr_rect(&registry_rect),
            wine_dbgstr_rect(&r));

    memset(&ddsd, 0, sizeof(ddsd));
    ddsd.dwSize = sizeof(ddsd);
    ddsd.dwFlags = DDSD_CAPS;
    ddsd.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE;

    hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &primary, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n",hr);
    hr = IDirectDrawSurface_GetSurfaceDesc(primary, &ddsd);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(ddsd.dwWidth == registry_mode.dmPelsWidth, "Expected surface width %lu, got %lu.\n",
            registry_mode.dmPelsWidth, ddsd.dwWidth);
    ok(ddsd.dwHeight == registry_mode.dmPelsHeight, "Expected surface height %lu, got %lu.\n",
            registry_mode.dmPelsHeight, ddsd.dwHeight);

    flush_events();
    expect_messages = release_messages;
    IDirectDrawSurface_Release(primary);
    flush_events();
    flaky /* win10 21H2 with QXL driver */
    ok(expect_messages->message == WM_PAINT, "Unexpected WM_PAINT.\n");
    expect_messages = NULL;

    /* The screen restore is a property of DDSCL_EXCLUSIVE  */
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);
    hr = set_display_mode(ddraw, param.ddraw_width, param.ddraw_height);
    ok(SUCCEEDED(hr), "Failed to set display mode, hr %#lx.\n", hr);

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);

    memset(&ddsd, 0, sizeof(ddsd));
    ddsd.dwSize = sizeof(ddsd);
    ddsd.dwFlags = DDSD_CAPS;
    ddsd.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE;

    hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &primary, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n",hr);
    hr = IDirectDrawSurface_GetSurfaceDesc(primary, &ddsd);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(ddsd.dwWidth == param.ddraw_width, "Expected surface width %lu, got %lu.\n",
            param.ddraw_width, ddsd.dwWidth);
    ok(ddsd.dwHeight == param.ddraw_height, "Expected surface height %lu, got %lu.\n",
            param.ddraw_height, ddsd.dwHeight);

    flush_events();
    expect_messages = release_messages;
    IDirectDrawSurface_Release(primary);
    flush_events();
    ok(!expect_messages->message, "Expected message %#x, but didn't receive it.\n", expect_messages->message);
    expect_messages = NULL;

    hr = IDirectDraw2_RestoreDisplayMode(ddraw);
    ok(SUCCEEDED(hr), "RestoreDisplayMode failed, hr %#lx.\n", hr);

    flush_events(); /* flush any pending window resize X11 event */

    /* If the window is changed at the same time, messages are sent to the new window. */
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);
    hr = set_display_mode(ddraw, param.ddraw_width, param.ddraw_height);
    ok(SUCCEEDED(hr), "Failed to set display mode, hr %#lx.\n", hr);

    PeekMessageA(&msg, 0, 0, 0, PM_NOREMOVE);
    expect_messages = exclusive_messages;
    screen_size.cx = 0;
    screen_size.cy = 0;
    screen_size2.cx = 0;
    screen_size2.cy = 0;

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window2, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);

    ok(!expect_messages->message, "Expected message %#x, but didn't receive it.\n", expect_messages->message);
    expect_messages = NULL;
    ok(!screen_size.cx && !screen_size.cy, "Got unexpected screen size %lux%lu.\n",
            screen_size.cx, screen_size.cy);
    ok(screen_size2.cx == registry_mode.dmPelsWidth && screen_size2.cy == registry_mode.dmPelsHeight,
            "Expected screen size 2 %lux%lu, got %lux%lu.\n",
            registry_mode.dmPelsWidth, registry_mode.dmPelsHeight, screen_size2.cx, screen_size2.cy);

    GetWindowRect(window, &r);
    flaky /* win10 21H2 with QXL driver */
    ok(EqualRect(&r, &ddraw_rect), "Expected %s, got %s.\n", wine_dbgstr_rect(&ddraw_rect),
            wine_dbgstr_rect(&r));
    GetWindowRect(window2, &r);
    ok(EqualRect(&r, &registry_rect), "Expected %s, got %s.\n", wine_dbgstr_rect(&registry_rect),
            wine_dbgstr_rect(&r));

    memset(&ddsd, 0, sizeof(ddsd));
    ddsd.dwSize = sizeof(ddsd);
    ddsd.dwFlags = DDSD_CAPS;
    ddsd.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE;

    hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &primary, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n",hr);
    hr = IDirectDrawSurface_GetSurfaceDesc(primary, &ddsd);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(ddsd.dwWidth == registry_mode.dmPelsWidth, "Expected surface width %lu, got %lu.\n",
            registry_mode.dmPelsWidth, ddsd.dwWidth);
    ok(ddsd.dwHeight == registry_mode.dmPelsHeight, "Expected surface height %lu, got %lu.\n",
            registry_mode.dmPelsHeight, ddsd.dwHeight);

    flush_events();
    expect_messages = release_messages;
    IDirectDrawSurface_Release(primary);
    flush_events();
    flaky /* win10 21H2 with QXL driver */
    ok(expect_messages->message == WM_PAINT, "Unexpected WM_PAINT.\n");
    expect_messages = NULL;

    ref = IDirectDraw2_Release(ddraw);
    ok(!ref, "Unexpected refcount %lu.\n", ref);

    GetWindowRect(window, &r);
    flaky /* win10 21H2 with QXL driver */
    ok(EqualRect(&r, &ddraw_rect), "Expected %s, got %s.\n", wine_dbgstr_rect(&ddraw_rect),
            wine_dbgstr_rect(&r));

    ret = restore_display_modes(original_modes, display_count);
    ok(ret, "Failed to restore display modes.\n");

    /* Test that no mode restorations if no mode changes happened */
    devmode.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT;
    devmode.dmPelsWidth = param.user32_width;
    devmode.dmPelsHeight = param.user32_height;
    change_ret = ChangeDisplaySettingsA(&devmode, CDS_UPDATEREGISTRY | CDS_NORESET);
    ok(change_ret == DISP_CHANGE_SUCCESSFUL, "ChangeDisplaySettingsA failed with %ld.\n", change_ret);

    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    ref = IDirectDraw2_Release(ddraw);
    ok(!ref, "Unexpected refcount %lu.\n", ref);

    memset(&devmode2, 0, sizeof(devmode2));
    devmode2.dmSize = sizeof(devmode2);
    ret = EnumDisplaySettingsA(NULL, ENUM_CURRENT_SETTINGS, &devmode2);
    ok(ret, "EnumDisplaySettingsA failed, error %lu.\n", GetLastError());
    ok(compare_mode_rect(&devmode2, &registry_mode), "Got a different mode.\n");
    ret = restore_display_modes(original_modes, display_count);
    ok(ret, "Failed to restore display modes.\n");

    /* Test that no mode restorations if no mode changes happened with fullscreen ddraw objects */
    change_ret = ChangeDisplaySettingsA(&devmode, CDS_UPDATEREGISTRY | CDS_NORESET);
    ok(change_ret == DISP_CHANGE_SUCCESSFUL, "ChangeDisplaySettingsA failed with %ld.\n", change_ret);

    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(hr == DD_OK, "SetCooperativeLevel failed, hr %#lx.\n", hr);
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(hr == DD_OK, "SetCooperativeLevel failed, hr %#lx.\n", hr);
    ref = IDirectDraw2_Release(ddraw);
    ok(!ref, "Unexpected refcount %lu.\n", ref);

    ret = EnumDisplaySettingsA(NULL, ENUM_CURRENT_SETTINGS, &devmode2);
    ok(ret, "EnumDisplaySettingsA failed, error %lu.\n", GetLastError());
    ok(compare_mode_rect(&devmode2, &registry_mode), "Got a different mode.\n");
    ret = restore_display_modes(original_modes, display_count);
    ok(ret, "Failed to restore display modes.\n");

    /* Test that mode restorations use display settings in the registry after ddraw object releases
     * if SetDisplayMode() was called */
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    hr = set_display_mode(ddraw, registry_mode.dmPelsWidth, registry_mode.dmPelsHeight);
    ok(hr == DD_OK, "Failed to set display mode, hr %#lx.\n", hr);

    change_ret = ChangeDisplaySettingsA(&devmode, CDS_UPDATEREGISTRY | CDS_NORESET);
    ok(change_ret == DISP_CHANGE_SUCCESSFUL, "ChangeDisplaySettingsA failed with %ld.\n", change_ret);

    ref = IDirectDraw2_Release(ddraw);
    ok(!ref, "Unexpected refcount %lu.\n", ref);

    ret = EnumDisplaySettingsA(NULL, ENUM_CURRENT_SETTINGS, &devmode2);
    ok(ret, "EnumDisplaySettingsA failed, error %lu.\n", GetLastError());
    ok(compare_mode_rect(&devmode2, &devmode), "Got a different mode.\n");
    ret = EnumDisplaySettingsA(NULL, ENUM_REGISTRY_SETTINGS, &devmode2);
    ok(ret, "EnumDisplaySettingsA failed, error %lu.\n", GetLastError());
    ok(compare_mode_rect(&devmode2, &devmode), "Got a different mode.\n");
    ret = restore_display_modes(original_modes, display_count);
    ok(ret, "Failed to restore display modes.\n");

    /* Test that mode restorations use display settings in the registry after RestoreDisplayMode() */
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    hr = set_display_mode(ddraw, param.ddraw_width, param.ddraw_height);
    ok(hr == DD_OK, "Failed to set display mode, hr %#lx.\n", hr);

    change_ret = ChangeDisplaySettingsA(&devmode, CDS_UPDATEREGISTRY | CDS_NORESET);
    ok(change_ret == DISP_CHANGE_SUCCESSFUL, "ChangeDisplaySettingsA failed with %ld.\n", change_ret);

    hr = IDirectDraw2_RestoreDisplayMode(ddraw);
    ok(hr == DD_OK, "RestoreDisplayMode failed, hr %#lx.\n", hr);

    ret = EnumDisplaySettingsA(NULL, ENUM_CURRENT_SETTINGS, &devmode2);
    ok(ret, "EnumDisplaySettingsA failed, error %lu.\n", GetLastError());
    ok(compare_mode_rect(&devmode2, &devmode), "Got a different mode.\n");
    ret = EnumDisplaySettingsA(NULL, ENUM_REGISTRY_SETTINGS, &devmode2);
    ok(ret, "EnumDisplaySettingsA failed, error %lu.\n", GetLastError());
    ok(compare_mode_rect(&devmode2, &devmode), "Got a different mode.\n");

    ref = IDirectDraw2_Release(ddraw);
    ok(!ref, "Unexpected refcount %lu.\n", ref);

done:
    expect_messages = NULL;
    DestroyWindow(window);
    DestroyWindow(window2);
    UnregisterClassA("ddraw_test_wndproc_wc", GetModuleHandleA(NULL));
    UnregisterClassA("ddraw_test_wndproc_wc2", GetModuleHandleA(NULL));
    ret = restore_display_modes(original_modes, display_count);
    ok(ret, "Failed to restore display modes.\n");
    free(original_modes);
}

static void test_coop_level_mode_set_multi(void)
{
    DEVMODEA old_devmode, devmode, devmode2, devmode3, *original_modes = NULL;
    unsigned int mode_idx = 0, display_idx, display_count = 0;
    char second_monitor_name[CCHDEVICENAME];
    IDirectDraw2 *ddraw1, *ddraw2;
    LONG change_ret;
    UINT w, h;
    HWND window;
    HRESULT hr;
    ULONG ref;
    BOOL ret;

    memset(&devmode, 0, sizeof(devmode));
    devmode.dmSize = sizeof(devmode);
    ret = EnumDisplaySettingsA(NULL, ENUM_CURRENT_SETTINGS, &devmode);
    ok(ret, "EnumDisplaySettingsA failed, error %lu.\n", GetLastError());
    ok(compare_mode_rect(&devmode, &registry_mode), "Got a different mode.\n");
    ret = EnumDisplaySettingsA(NULL, ENUM_REGISTRY_SETTINGS, &devmode);
    ok(ret, "EnumDisplaySettingsA failed, error %lu.\n", GetLastError());
    ok(compare_mode_rect(&devmode, &registry_mode), "Got a different mode.\n");

    ret = save_display_modes(&original_modes, &display_count);
    ok(ret, "Failed to save original display modes.\n");

    window = CreateWindowA("static", "ddraw_test", WS_OVERLAPPEDWINDOW,
            0, 0, 100, 100, 0, 0, 0, 0);
    ddraw1 = create_ddraw();
    ok(!!ddraw1, "Failed to create a ddraw object.\n");

    /* With just a single ddraw object, the display mode is restored on
     * release. */
    hr = set_display_mode(ddraw1, 800, 600);
    if (hr == DDERR_NOEXCLUSIVEMODE /* NT4 testbot */)
    {
        win_skip("Broken SetDisplayMode(), skipping test.\n");
        IDirectDraw2_Release(ddraw1);
        DestroyWindow(window);
        return;
    }
    ok(SUCCEEDED(hr), "Failed to set display mode, hr %#lx.\n", hr);
    w = GetSystemMetrics(SM_CXSCREEN);
    ok(w == 800, "Got unexpected screen width %u.\n", w);
    h = GetSystemMetrics(SM_CYSCREEN);
    ok(h == 600, "Got unexpected screen height %u.\n", h);

    ref = IDirectDraw2_Release(ddraw1);
    ok(!ref, "Unexpected refcount %lu.\n", ref);
    w = GetSystemMetrics(SM_CXSCREEN);
    ok(w == registry_mode.dmPelsWidth, "Got unexpected screen width %u.\n", w);
    h = GetSystemMetrics(SM_CYSCREEN);
    ok(h == registry_mode.dmPelsHeight, "Got unexpected screen height %u.\n", h);

    /* When there are multiple ddraw objects, the display mode is restored to
     * the initial mode, before the first SetDisplayMode() call. */
    ddraw1 = create_ddraw();
    hr = set_display_mode(ddraw1, 800, 600);
    ok(SUCCEEDED(hr), "Failed to set display mode, hr %#lx.\n", hr);
    w = GetSystemMetrics(SM_CXSCREEN);
    ok(w == 800, "Got unexpected screen width %u.\n", w);
    h = GetSystemMetrics(SM_CYSCREEN);
    ok(h == 600, "Got unexpected screen height %u.\n", h);

    ddraw2 = create_ddraw();
    hr = set_display_mode(ddraw2, 640, 480);
    ok(SUCCEEDED(hr), "Failed to set display mode, hr %#lx.\n", hr);
    w = GetSystemMetrics(SM_CXSCREEN);
    ok(w == 640, "Got unexpected screen width %u.\n", w);
    h = GetSystemMetrics(SM_CYSCREEN);
    ok(h == 480, "Got unexpected screen height %u.\n", h);

    ref = IDirectDraw2_Release(ddraw2);
    ok(!ref, "Unexpected refcount %lu.\n", ref);
    w = GetSystemMetrics(SM_CXSCREEN);
    ok(w == registry_mode.dmPelsWidth, "Got unexpected screen width %u.\n", w);
    h = GetSystemMetrics(SM_CYSCREEN);
    ok(h == registry_mode.dmPelsHeight, "Got unexpected screen height %u.\n", h);

    ref = IDirectDraw2_Release(ddraw1);
    ok(!ref, "Unexpected refcount %lu.\n", ref);
    w = GetSystemMetrics(SM_CXSCREEN);
    ok(w == registry_mode.dmPelsWidth, "Got unexpected screen width %u.\n", w);
    h = GetSystemMetrics(SM_CYSCREEN);
    ok(h == registry_mode.dmPelsHeight, "Got unexpected screen height %u.\n", h);

    /* Regardless of release ordering. */
    ddraw1 = create_ddraw();
    hr = set_display_mode(ddraw1, 800, 600);
    ok(SUCCEEDED(hr), "Failed to set display mode, hr %#lx.\n", hr);
    w = GetSystemMetrics(SM_CXSCREEN);
    ok(w == 800, "Got unexpected screen width %u.\n", w);
    h = GetSystemMetrics(SM_CYSCREEN);
    ok(h == 600, "Got unexpected screen height %u.\n", h);

    ddraw2 = create_ddraw();
    hr = set_display_mode(ddraw2, 640, 480);
    ok(SUCCEEDED(hr), "Failed to set display mode, hr %#lx.\n", hr);
    w = GetSystemMetrics(SM_CXSCREEN);
    ok(w == 640, "Got unexpected screen width %u.\n", w);
    h = GetSystemMetrics(SM_CYSCREEN);
    ok(h == 480, "Got unexpected screen height %u.\n", h);

    ref = IDirectDraw2_Release(ddraw1);
    ok(!ref, "Unexpected refcount %lu.\n", ref);
    w = GetSystemMetrics(SM_CXSCREEN);
    ok(w == registry_mode.dmPelsWidth, "Got unexpected screen width %u.\n", w);
    h = GetSystemMetrics(SM_CYSCREEN);
    ok(h == registry_mode.dmPelsHeight, "Got unexpected screen height %u.\n", h);

    ref = IDirectDraw2_Release(ddraw2);
    ok(!ref, "Unexpected refcount %lu.\n", ref);
    w = GetSystemMetrics(SM_CXSCREEN);
    ok(w == registry_mode.dmPelsWidth, "Got unexpected screen width %u.\n", w);
    h = GetSystemMetrics(SM_CYSCREEN);
    ok(h == registry_mode.dmPelsHeight, "Got unexpected screen height %u.\n", h);

    /* But only for ddraw objects that called SetDisplayMode(). */
    ddraw1 = create_ddraw();
    ddraw2 = create_ddraw();
    hr = set_display_mode(ddraw2, 640, 480);
    ok(SUCCEEDED(hr), "Failed to set display mode, hr %#lx.\n", hr);
    w = GetSystemMetrics(SM_CXSCREEN);
    ok(w == 640, "Got unexpected screen width %u.\n", w);
    h = GetSystemMetrics(SM_CYSCREEN);
    ok(h == 480, "Got unexpected screen height %u.\n", h);

    ref = IDirectDraw2_Release(ddraw1);
    ok(!ref, "Unexpected refcount %lu.\n", ref);
    w = GetSystemMetrics(SM_CXSCREEN);
    ok(w == 640, "Got unexpected screen width %u.\n", w);
    h = GetSystemMetrics(SM_CYSCREEN);
    ok(h == 480, "Got unexpected screen height %u.\n", h);

    ref = IDirectDraw2_Release(ddraw2);
    ok(!ref, "Unexpected refcount %lu.\n", ref);
    w = GetSystemMetrics(SM_CXSCREEN);
    ok(w == registry_mode.dmPelsWidth, "Got unexpected screen width %u.\n", w);
    h = GetSystemMetrics(SM_CYSCREEN);
    ok(h == registry_mode.dmPelsHeight, "Got unexpected screen height %u.\n", h);

    /* If there's a ddraw object that's currently in exclusive mode, it blocks
     * restoring the display mode. */
    ddraw1 = create_ddraw();
    hr = set_display_mode(ddraw1, 800, 600);
    ok(SUCCEEDED(hr), "Failed to set display mode, hr %#lx.\n", hr);
    w = GetSystemMetrics(SM_CXSCREEN);
    ok(w == 800, "Got unexpected screen width %u.\n", w);
    h = GetSystemMetrics(SM_CYSCREEN);
    ok(h == 600, "Got unexpected screen height %u.\n", h);

    ddraw2 = create_ddraw();
    hr = set_display_mode(ddraw2, 640, 480);
    ok(SUCCEEDED(hr), "Failed to set display mode, hr %#lx.\n", hr);
    w = GetSystemMetrics(SM_CXSCREEN);
    ok(w == 640, "Got unexpected screen width %u.\n", w);
    h = GetSystemMetrics(SM_CYSCREEN);
    ok(h == 480, "Got unexpected screen height %u.\n", h);

    hr = IDirectDraw2_SetCooperativeLevel(ddraw2, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);

    ref = IDirectDraw2_Release(ddraw1);
    ok(!ref, "Unexpected refcount %lu.\n", ref);
    w = GetSystemMetrics(SM_CXSCREEN);
    ok(w == 640, "Got unexpected screen width %u.\n", w);
    h = GetSystemMetrics(SM_CYSCREEN);
    ok(h == 480, "Got unexpected screen height %u.\n", h);

    ref = IDirectDraw2_Release(ddraw2);
    ok(!ref, "Unexpected refcount %lu.\n", ref);
    w = GetSystemMetrics(SM_CXSCREEN);
    ok(w == registry_mode.dmPelsWidth, "Got unexpected screen width %u.\n", w);
    h = GetSystemMetrics(SM_CYSCREEN);
    ok(h == registry_mode.dmPelsHeight, "Got unexpected screen height %u.\n", h);

    /* Exclusive mode blocks mode setting on other ddraw objects in general. */
    ddraw1 = create_ddraw();
    hr = set_display_mode(ddraw1, 800, 600);
    ok(SUCCEEDED(hr), "Failed to set display mode, hr %#lx.\n", hr);
    w = GetSystemMetrics(SM_CXSCREEN);
    ok(w == 800, "Got unexpected screen width %u.\n", w);
    h = GetSystemMetrics(SM_CYSCREEN);
    ok(h == 600, "Got unexpected screen height %u.\n", h);

    hr = IDirectDraw2_SetCooperativeLevel(ddraw1, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);

    ddraw2 = create_ddraw();
    hr = set_display_mode(ddraw2, 640, 480);
    ok(hr == DDERR_NOEXCLUSIVEMODE, "Got unexpected hr %#lx.\n", hr);

    ref = IDirectDraw2_Release(ddraw1);
    ok(!ref, "Unexpected refcount %lu.\n", ref);
    w = GetSystemMetrics(SM_CXSCREEN);
    ok(w == registry_mode.dmPelsWidth, "Got unexpected screen width %u.\n", w);
    h = GetSystemMetrics(SM_CYSCREEN);
    ok(h == registry_mode.dmPelsHeight, "Got unexpected screen height %u.\n", h);

    ref = IDirectDraw2_Release(ddraw2);
    ok(!ref, "Unexpected refcount %lu.\n", ref);
    w = GetSystemMetrics(SM_CXSCREEN);
    ok(w == registry_mode.dmPelsWidth, "Got unexpected screen width %u.\n", w);
    h = GetSystemMetrics(SM_CYSCREEN);
    ok(h == registry_mode.dmPelsHeight, "Got unexpected screen height %u.\n", h);

    if (display_count < 2)
    {
        skip("Following tests require two monitors.\n");
        goto done;
    }

    ret = restore_display_modes(original_modes, display_count);
    ok(ret, "Failed to restore display modes.\n");

    second_monitor_name[0] = '\0';
    for (display_idx = 0; display_idx < display_count; ++display_idx)
    {
        if (original_modes[display_idx].dmPosition.x || original_modes[display_idx].dmPosition.y)
        {
            strcpy(second_monitor_name, (char *)original_modes[display_idx].dmDeviceName);
            break;
        }
    }
    ok(strlen(second_monitor_name), "Got an empty second monitor name.\n");
    memset(&old_devmode, 0, sizeof(old_devmode));
    old_devmode.dmSize = sizeof(old_devmode);
    ret = EnumDisplaySettingsA(second_monitor_name, ENUM_CURRENT_SETTINGS, &old_devmode);
    ok(ret, "EnumDisplaySettingsA failed, error %lu.\n", GetLastError());

    devmode = old_devmode;
    while (EnumDisplaySettingsA(second_monitor_name, mode_idx++, &devmode))
    {
        if (devmode.dmPelsWidth != old_devmode.dmPelsWidth
                || devmode.dmPelsHeight != old_devmode.dmPelsHeight)
            break;
    }
    ok(devmode.dmPelsWidth != old_devmode.dmPelsWidth
            || devmode.dmPelsHeight != old_devmode.dmPelsHeight,
            "Failed to find a different mode for the second monitor.\n");

    /* Test that no mode restorations for non-primary monitors if SetDisplayMode() was not called */
    ddraw1 = create_ddraw();
    ok(!!ddraw1, "Failed to create a ddraw object.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw1, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(hr == DD_OK, "SetCooperativeLevel failed, hr %#lx.\n", hr);

    change_ret = ChangeDisplaySettingsExA(second_monitor_name, &devmode, NULL, CDS_RESET, NULL);
    ok(change_ret == DISP_CHANGE_SUCCESSFUL, "ChangeDisplaySettingsExA failed with %ld.\n", change_ret);

    memset(&devmode2, 0, sizeof(devmode2));
    devmode2.dmSize = sizeof(devmode2);
    ret = EnumDisplaySettingsA(second_monitor_name, ENUM_CURRENT_SETTINGS, &devmode2);
    ok(ret, "EnumDisplaySettingsA failed, error %lu.\n", GetLastError());
    if (compare_mode_rect(&devmode2, &old_devmode))
    {
        skip("Failed to change display settings of the second monitor.\n");
        ref = IDirectDraw2_Release(ddraw1);
        ok(!ref, "Unexpected refcount %lu.\n", ref);
        goto done;
    }

    hr = IDirectDraw2_SetCooperativeLevel(ddraw1, window, DDSCL_NORMAL);
    ok(hr == DD_OK, "SetCooperativeLevel failed, hr %#lx.\n", hr);
    ref = IDirectDraw2_Release(ddraw1);
    ok(!ref, "Unexpected refcount %lu.\n", ref);

    memset(&devmode3, 0, sizeof(devmode3));
    devmode3.dmSize = sizeof(devmode3);
    ret = EnumDisplaySettingsA(second_monitor_name, ENUM_CURRENT_SETTINGS, &devmode3);
    ok(ret, "EnumDisplaySettingsA failed, error %lu.\n", GetLastError());
    ok(compare_mode_rect(&devmode3, &devmode2), "Got a different mode.\n");
    ret = restore_display_modes(original_modes, display_count);
    ok(ret, "Failed to restore display modes.\n");

    /* Test that mode restorations happen for non-primary monitors on ddraw releases if
     * SetDisplayMode() was called */
    ddraw1 = create_ddraw();
    ok(!!ddraw1, "Failed to create a ddraw object.\n");
    hr = set_display_mode(ddraw1, 800, 600);
    ok(hr == DD_OK, "Failed to set display mode, hr %#lx.\n", hr);

    change_ret = ChangeDisplaySettingsExA(second_monitor_name, &devmode, NULL, CDS_RESET, NULL);
    ok(change_ret == DISP_CHANGE_SUCCESSFUL, "ChangeDisplaySettingsExA failed with %ld.\n", change_ret);

    ref = IDirectDraw2_Release(ddraw1);
    ok(!ref, "Unexpected refcount %lu.\n", ref);

    ret = EnumDisplaySettingsA(second_monitor_name, ENUM_CURRENT_SETTINGS, &devmode2);
    ok(ret, "EnumDisplaySettingsA failed, error %lu.\n", GetLastError());
    ok(compare_mode_rect(&devmode2, &old_devmode), "Got a different mode.\n");
    ret = EnumDisplaySettingsA(second_monitor_name, ENUM_REGISTRY_SETTINGS, &devmode2);
    ok(ret, "EnumDisplaySettingsA failed, error %lu.\n", GetLastError());
    ok(compare_mode_rect(&devmode2, &old_devmode), "Got a different mode.\n");
    ret = restore_display_modes(original_modes, display_count);
    ok(ret, "Failed to restore display modes.\n");

    /* Test that mode restorations happen for non-primary monitors as well */
    ddraw1 = create_ddraw();
    ok(!!ddraw1, "Failed to create a ddraw object.\n");
    hr = set_display_mode(ddraw1, 800, 600);
    ok(hr == DD_OK, "Failed to set display mode, hr %#lx.\n", hr);

    change_ret = ChangeDisplaySettingsExA(second_monitor_name, &devmode, NULL, CDS_RESET, NULL);
    ok(change_ret == DISP_CHANGE_SUCCESSFUL, "ChangeDisplaySettingsExA failed with %ld.\n", change_ret);

    hr = IDirectDraw2_RestoreDisplayMode(ddraw1);
    ok(hr == DD_OK, "RestoreDisplayMode failed, hr %#lx.\n", hr);

    ret = EnumDisplaySettingsA(second_monitor_name, ENUM_CURRENT_SETTINGS, &devmode2);
    ok(ret, "EnumDisplaySettingsA failed, error %lu.\n", GetLastError());
    ok(compare_mode_rect(&devmode2, &old_devmode), "Got a different mode.\n");
    ret = EnumDisplaySettingsA(second_monitor_name, ENUM_REGISTRY_SETTINGS, &devmode2);
    ok(ret, "EnumDisplaySettingsA failed, error %lu.\n", GetLastError());
    ok(compare_mode_rect(&devmode2, &old_devmode), "Got a different mode.\n");

    ref = IDirectDraw2_Release(ddraw1);
    ok(!ref, "Unexpected refcount %lu.\n", ref);
    ret = restore_display_modes(original_modes, display_count);
    ok(ret, "Failed to restore display modes.\n");

    /* Test that mode restorations for non-primary monitors use display settings in the registry */
    ddraw1 = create_ddraw();
    ok(!!ddraw1, "Failed to create a ddraw object.\n");
    hr = set_display_mode(ddraw1, 800, 600);
    ok(hr == DD_OK, "Failed to set display mode, hr %#lx.\n", hr);

    change_ret = ChangeDisplaySettingsExA(second_monitor_name, &devmode, NULL,
            CDS_UPDATEREGISTRY | CDS_NORESET, NULL);
    ok(change_ret == DISP_CHANGE_SUCCESSFUL, "ChangeDisplaySettingsExA failed with %ld.\n", change_ret);

    ref = IDirectDraw2_Release(ddraw1);
    ok(!ref, "Unexpected refcount %lu.\n", ref);

    ret = EnumDisplaySettingsA(second_monitor_name, ENUM_CURRENT_SETTINGS, &devmode2);
    ok(ret, "EnumDisplaySettingsA failed, error %lu.\n", GetLastError());
    ok(devmode2.dmPelsWidth == devmode.dmPelsWidth && devmode2.dmPelsHeight == devmode.dmPelsHeight,
            "Expected resolution %lux%lu, got %lux%lu.\n", devmode.dmPelsWidth, devmode.dmPelsHeight,
            devmode2.dmPelsWidth, devmode2.dmPelsHeight);
    ret = EnumDisplaySettingsA(second_monitor_name, ENUM_REGISTRY_SETTINGS, &devmode2);
    ok(ret, "EnumDisplaySettingsA failed, error %lu.\n", GetLastError());
    ok(devmode2.dmPelsWidth == devmode.dmPelsWidth && devmode2.dmPelsHeight == devmode.dmPelsHeight,
            "Expected resolution %lux%lu, got %lux%lu.\n", devmode.dmPelsWidth, devmode.dmPelsHeight,
            devmode2.dmPelsWidth, devmode2.dmPelsHeight);
    ret = restore_display_modes(original_modes, display_count);
    ok(ret, "Failed to restore display modes.\n");

    /* Test mode restorations for non-primary monitors when there are multiple fullscreen ddraw
     * objects and one of them restores display mode */
    ddraw1 = create_ddraw();
    ok(!!ddraw1, "Failed to create a ddraw object.\n");
    ddraw2 = create_ddraw();
    ok(!!ddraw2, "Failed to create a ddraw object.\n");
    hr = set_display_mode(ddraw1, 800, 600);
    ok(hr == DD_OK, "Failed to set display mode, hr %#lx.\n", hr);
    hr = set_display_mode(ddraw2, 640, 480);
    ok(hr == DD_OK, "Failed to set display mode, hr %#lx.\n", hr);

    change_ret = ChangeDisplaySettingsExA(second_monitor_name, &devmode, NULL, CDS_RESET, NULL);
    ok(change_ret == DISP_CHANGE_SUCCESSFUL, "ChangeDisplaySettingsExA failed with %ld.\n", change_ret);

    hr = IDirectDraw2_RestoreDisplayMode(ddraw2);
    ok(hr == DD_OK, "RestoreDisplayMode failed, hr %#lx.\n", hr);

    ret = EnumDisplaySettingsA(second_monitor_name, ENUM_CURRENT_SETTINGS, &devmode2);
    ok(ret, "EnumDisplaySettingsA failed, error %lu.\n", GetLastError());
    ok(compare_mode_rect(&devmode2, &old_devmode), "Got a different mode.\n");
    ret = EnumDisplaySettingsA(second_monitor_name, ENUM_REGISTRY_SETTINGS, &devmode2);
    ok(ret, "EnumDisplaySettingsA failed, error %lu.\n", GetLastError());
    ok(compare_mode_rect(&devmode2, &old_devmode), "Got a different mode.\n");

    ref = IDirectDraw2_Release(ddraw2);
    ok(!ref, "Unexpected refcount %lu.\n", ref);
    ref = IDirectDraw2_Release(ddraw1);
    ok(!ref, "Unexpected refcount %lu.\n", ref);
    ret = restore_display_modes(original_modes, display_count);
    ok(ret, "Failed to restore display modes.\n");

    /* Test mode restorations for non-primary monitors when there are multiple fullscreen ddraw
     * objects and one of them got released */
    ddraw1 = create_ddraw();
    ok(!!ddraw1, "Failed to create a ddraw object.\n");
    ddraw2 = create_ddraw();
    ok(!!ddraw2, "Failed to create a ddraw object.\n");
    hr = set_display_mode(ddraw1, 800, 600);
    ok(hr == DD_OK, "Failed to set display mode, hr %#lx.\n", hr);
    hr = set_display_mode(ddraw2, 640, 480);
    ok(hr == DD_OK, "Failed to set display mode, hr %#lx.\n", hr);

    change_ret = ChangeDisplaySettingsExA(second_monitor_name, &devmode, NULL, CDS_RESET, NULL);
    ok(change_ret == DISP_CHANGE_SUCCESSFUL, "ChangeDisplaySettingsExA failed with %ld.\n", change_ret);

    ref = IDirectDraw2_Release(ddraw2);
    ok(!ref, "Unexpected refcount %lu.\n", ref);

    ret = EnumDisplaySettingsA(second_monitor_name, ENUM_CURRENT_SETTINGS, &devmode2);
    ok(ret, "EnumDisplaySettingsA failed, error %lu.\n", GetLastError());
    ok(compare_mode_rect(&devmode2, &old_devmode), "Got a different mode.\n");
    ret = EnumDisplaySettingsA(second_monitor_name, ENUM_REGISTRY_SETTINGS, &devmode2);
    ok(ret, "EnumDisplaySettingsA failed, error %lu.\n", GetLastError());
    ok(compare_mode_rect(&devmode2, &old_devmode), "Got a different mode.\n");

    ref = IDirectDraw2_Release(ddraw1);
    ok(!ref, "Unexpected refcount %lu.\n", ref);

done:
    DestroyWindow(window);
    ret = restore_display_modes(original_modes, display_count);
    ok(ret, "Failed to restore display modes.\n");
    free(original_modes);
}

static void test_initialize(void)
{
    IDirectDraw2 *ddraw;
    HRESULT hr;

    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");

    hr = IDirectDraw2_Initialize(ddraw, NULL);
    ok(hr == DDERR_ALREADYINITIALIZED, "Initialize returned hr %#lx.\n", hr);
    IDirectDraw2_Release(ddraw);

    CoInitialize(NULL);
    hr = CoCreateInstance(&CLSID_DirectDraw, NULL, CLSCTX_INPROC_SERVER, &IID_IDirectDraw2, (void **)&ddraw);
    ok(SUCCEEDED(hr), "Failed to create IDirectDraw2 instance, hr %#lx.\n", hr);
    hr = IDirectDraw2_Initialize(ddraw, NULL);
    ok(hr == DD_OK, "Initialize returned hr %#lx, expected DD_OK.\n", hr);
    hr = IDirectDraw2_Initialize(ddraw, NULL);
    ok(hr == DDERR_ALREADYINITIALIZED, "Initialize returned hr %#lx, expected DDERR_ALREADYINITIALIZED.\n", hr);
    IDirectDraw2_Release(ddraw);
    CoUninitialize();
}

static void test_coop_level_surf_create(void)
{
    IDirectDrawSurface *surface;
    IDirectDraw2 *ddraw;
    DDSURFACEDESC ddsd;
    HRESULT hr;

    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");

    memset(&ddsd, 0, sizeof(ddsd));
    ddsd.dwSize = sizeof(ddsd);
    ddsd.dwFlags = DDSD_CAPS;
    ddsd.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE;
    surface = (void *)0xdeadbeef;
    hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &surface, NULL);
    ok(hr == DDERR_NOCOOPERATIVELEVELSET, "Surface creation returned hr %#lx.\n", hr);
    ok(surface == (void *)0xdeadbeef, "Got unexpected surface %p.\n", surface);

    surface = (void *)0xdeadbeef;
    hr = IDirectDraw2_CreateSurface(ddraw, NULL, &surface, NULL);
    ok(hr == DDERR_NOCOOPERATIVELEVELSET, "Surface creation returned hr %#lx.\n", hr);
    ok(surface == (void *)0xdeadbeef, "Got unexpected surface %p.\n", surface);

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, NULL, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    surface = (void *)0xdeadbeef;
    hr = IDirectDraw2_CreateSurface(ddraw, NULL, &surface, NULL);
    ok(hr == DDERR_INVALIDPARAMS, "Unexpected hr %#lx.\n", hr);
    ok(surface == (void *)0xdeadbeef, "Got unexpected surface %p.\n", surface);

    IDirectDraw2_Release(ddraw);
}

static void test_coop_level_multi_window(void)
{
    HWND window1, window2;
    IDirectDraw2 *ddraw;
    HRESULT hr;

    window1 = create_window();
    window2 = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window1, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window2, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);
    ok(IsWindow(window1), "Window 1 was destroyed.\n");
    ok(IsWindow(window2), "Window 2 was destroyed.\n");

    IDirectDraw2_Release(ddraw);
    DestroyWindow(window2);
    DestroyWindow(window1);
}

static void test_clear_rect_count(void)
{
    static D3DRECT clear_rect = {{0}, {0}, {640}, {480}};
    IDirect3DMaterial2 *white, *red, *green, *blue;
    IDirect3DViewport2 *viewport;
    IDirect3DDevice2 *device;
    IDirectDrawSurface *rt;
    IDirectDraw2 *ddraw;
    unsigned int color;
    HWND window;
    HRESULT hr;

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    if (!(device = create_device(ddraw, window, DDSCL_NORMAL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        IDirectDraw2_Release(ddraw);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice2_GetRenderTarget(device, &rt);
    ok(SUCCEEDED(hr), "Failed to get render target, hr %#lx.\n", hr);

    white = create_diffuse_material(device, 1.0f, 1.0f, 1.0f, 1.0f);
    red   = create_diffuse_material(device, 1.0f, 0.0f, 0.0f, 1.0f);
    green = create_diffuse_material(device, 0.0f, 1.0f, 0.0f, 1.0f);
    blue  = create_diffuse_material(device, 0.0f, 0.0f, 1.0f, 1.0f);

    viewport = create_viewport(device, 0, 0, 640, 480);
    hr = IDirect3DDevice2_SetCurrentViewport(device, viewport);
    ok(SUCCEEDED(hr), "Failed to set current viewport, hr %#lx.\n", hr);

    viewport_set_background(device, viewport, white);
    hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET);
    ok(SUCCEEDED(hr), "Failed to clear viewport, hr %#lx.\n", hr);
    viewport_set_background(device, viewport, red);
    hr = IDirect3DViewport2_Clear(viewport, 0, &clear_rect, D3DCLEAR_TARGET);
    ok(SUCCEEDED(hr), "Failed to clear viewport, hr %#lx.\n", hr);
    viewport_set_background(device, viewport, green);
    hr = IDirect3DViewport2_Clear(viewport, 0, NULL, D3DCLEAR_TARGET);
    ok(SUCCEEDED(hr), "Failed to clear viewport, hr %#lx.\n", hr);
    viewport_set_background(device, viewport, blue);
    hr = IDirect3DViewport2_Clear(viewport, 0, &clear_rect, D3DCLEAR_TARGET);
    ok(SUCCEEDED(hr), "Failed to clear viewport, hr %#lx.\n", hr);

    color = get_surface_color(rt, 320, 240);
    ok(compare_color(color, 0x00ffffff, 1) || broken(compare_color(color, 0x000000ff, 1)),
            "Got unexpected color 0x%08x.\n", color);

    IDirectDrawSurface_Release(rt);
    destroy_viewport(device, viewport);
    destroy_material(white);
    destroy_material(red);
    destroy_material(green);
    destroy_material(blue);
    IDirect3DDevice2_Release(device);
    IDirectDraw2_Release(ddraw);
    DestroyWindow(window);
}

static BOOL test_mode_restored(IDirectDraw2 *ddraw, HWND window)
{
    DDSURFACEDESC ddsd1, ddsd2;
    HRESULT hr;

    memset(&ddsd1, 0, sizeof(ddsd1));
    ddsd1.dwSize = sizeof(ddsd1);
    hr = IDirectDraw2_GetDisplayMode(ddraw, &ddsd1);
    ok(SUCCEEDED(hr), "GetDisplayMode failed, hr %#lx.\n", hr);

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);
    hr = set_display_mode(ddraw, 640, 480);
    ok(SUCCEEDED(hr), "Failed to set display mode, hr %#lx.\n", hr);
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);

    memset(&ddsd2, 0, sizeof(ddsd2));
    ddsd2.dwSize = sizeof(ddsd2);
    hr = IDirectDraw2_GetDisplayMode(ddraw, &ddsd2);
    ok(SUCCEEDED(hr), "GetDisplayMode failed, hr %#lx.\n", hr);
    hr = IDirectDraw2_RestoreDisplayMode(ddraw);
    ok(SUCCEEDED(hr), "RestoreDisplayMode failed, hr %#lx.\n", hr);

    return ddsd1.dwWidth == ddsd2.dwWidth && ddsd1.dwHeight == ddsd2.dwHeight;
}

static void test_coop_level_versions(void)
{
    HWND window;
    IDirectDraw *ddraw;
    HRESULT hr;
    BOOL restored;
    IDirectDrawSurface *surface;
    IDirectDraw2 *ddraw2;
    DDSURFACEDESC ddsd;

    window = create_window();
    ddraw2 = create_ddraw();
    ok(!!ddraw2, "Failed to create a ddraw object.\n");
    /* Newly created ddraw objects restore the mode on ddraw2+::SetCooperativeLevel(NORMAL) */
    restored = test_mode_restored(ddraw2, window);
    ok(restored, "Display mode not restored in new ddraw object\n");

    /* A failing ddraw1::SetCooperativeLevel call does not have an effect */
    hr = IDirectDraw2_QueryInterface(ddraw2, &IID_IDirectDraw, (void **)&ddraw);
    ok(SUCCEEDED(hr), "QueryInterface failed, hr %#lx.\n", hr);

    hr = IDirectDraw_SetCooperativeLevel(ddraw, NULL, DDSCL_FULLSCREEN | DDSCL_EXCLUSIVE);
    ok(FAILED(hr), "SetCooperativeLevel returned %#lx, expected failure.\n", hr);
    restored = test_mode_restored(ddraw2, window);
    ok(restored, "Display mode not restored after bad ddraw1::SetCooperativeLevel call\n");

    /* A successful one does */
    hr = IDirectDraw_SetCooperativeLevel(ddraw, NULL, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);
    restored = test_mode_restored(ddraw2, window);
    ok(!restored, "Display mode restored after good ddraw1::SetCooperativeLevel call\n");

    IDirectDraw_Release(ddraw);
    IDirectDraw2_Release(ddraw2);

    ddraw2 = create_ddraw();
    ok(!!ddraw2, "Failed to create a ddraw object.\n");
    hr = IDirectDraw2_QueryInterface(ddraw2, &IID_IDirectDraw, (void **)&ddraw);
    ok(SUCCEEDED(hr), "QueryInterface failed, hr %#lx.\n", hr);

    hr = IDirectDraw_SetCooperativeLevel(ddraw, window, DDSCL_SETFOCUSWINDOW);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);
    restored = test_mode_restored(ddraw2, window);
    ok(!restored, "Display mode restored after ddraw1::SetCooperativeLevel(SETFOCUSWINDOW) call\n");

    IDirectDraw_Release(ddraw);
    IDirectDraw2_Release(ddraw2);

    /* A failing call does not restore the ddraw2+ behavior */
    ddraw2 = create_ddraw();
    ok(!!ddraw2, "Failed to create a ddraw object.\n");
    hr = IDirectDraw2_QueryInterface(ddraw2, &IID_IDirectDraw, (void **)&ddraw);
    ok(SUCCEEDED(hr), "QueryInterface failed, hr %#lx.\n", hr);

    hr = IDirectDraw_SetCooperativeLevel(ddraw, NULL, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);
    hr = IDirectDraw_SetCooperativeLevel(ddraw, NULL, DDSCL_FULLSCREEN | DDSCL_EXCLUSIVE);
    ok(FAILED(hr), "SetCooperativeLevel returned %#lx, expected failure.\n", hr);
    restored = test_mode_restored(ddraw2, window);
    ok(!restored, "Display mode restored after good-bad ddraw1::SetCooperativeLevel() call sequence\n");

    IDirectDraw_Release(ddraw);
    IDirectDraw2_Release(ddraw2);

    /* Neither does a sequence of successful calls with the new interface */
    ddraw2 = create_ddraw();
    ok(!!ddraw2, "Failed to create a ddraw object.\n");
    hr = IDirectDraw2_QueryInterface(ddraw2, &IID_IDirectDraw, (void **)&ddraw);
    ok(SUCCEEDED(hr), "QueryInterface failed, hr %#lx.\n", hr);

    hr = IDirectDraw_SetCooperativeLevel(ddraw, NULL, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);
    hr = IDirectDraw2_SetCooperativeLevel(ddraw2, window, DDSCL_FULLSCREEN | DDSCL_EXCLUSIVE);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);
    hr = IDirectDraw2_SetCooperativeLevel(ddraw2, window, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);

    restored = test_mode_restored(ddraw2, window);
    ok(!restored, "Display mode restored after ddraw1-ddraw2 SetCooperativeLevel() call sequence\n");
    IDirectDraw_Release(ddraw);
    IDirectDraw2_Release(ddraw2);

    /* ddraw1::CreateSurface does not triger the ddraw1 behavior */
    ddraw2 = create_ddraw();
    ok(!!ddraw2, "Failed to create a ddraw object.\n");
    hr = IDirectDraw2_QueryInterface(ddraw2, &IID_IDirectDraw, (void **)&ddraw);
    ok(SUCCEEDED(hr), "QueryInterface failed, hr %#lx.\n", hr);

    hr = IDirectDraw2_SetCooperativeLevel(ddraw2, window, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "SetCooperativeLevel failed, hr %#lx.\n", hr);

    memset(&ddsd, 0, sizeof(ddsd));
    ddsd.dwSize = sizeof(ddsd);
    ddsd.dwFlags = DDSD_WIDTH | DDSD_HEIGHT | DDSD_CAPS;
    ddsd.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN;
    ddsd.dwWidth = ddsd.dwHeight = 8;
    hr = IDirectDraw_CreateSurface(ddraw, &ddsd, &surface, NULL);
    ok(SUCCEEDED(hr), "CreateSurface failed, hr %#lx.\n", hr);
    IDirectDrawSurface_Release(surface);
    restored = test_mode_restored(ddraw2, window);
    ok(restored, "Display mode not restored after ddraw1::CreateSurface() call\n");

    IDirectDraw_Release(ddraw);
    IDirectDraw2_Release(ddraw2);
    DestroyWindow(window);
}

static void test_lighting_interface_versions(void)
{
    static D3DRECT clear_rect = {{0}, {0}, {640}, {480}};
    IDirect3DMaterial2 *emissive, *background;
    IDirect3DViewport2 *viewport;
    IDirect3DDevice2 *device;
    IDirectDrawSurface *rt;
    unsigned int color, i;
    IDirectDraw2 *ddraw;
    HWND window;
    HRESULT hr;
    D3DMATERIALHANDLE mat_handle;
    DWORD rs;
    ULONG ref;
    static D3DVERTEX quad[] =
    {
        {{-1.0f}, { 1.0f}, {0.0f}, {1.0f}, {0.0f}, {0.0f}},
        {{ 1.0f}, { 1.0f}, {0.0f}, {1.0f}, {0.0f}, {0.0f}},
        {{-1.0f}, {-1.0f}, {0.0f}, {1.0f}, {0.0f}, {0.0f}},
        {{ 1.0f}, {-1.0f}, {0.0f}, {1.0f}, {0.0f}, {0.0f}},
    };
    static D3DLVERTEX lquad[] =
    {
        {{-1.0f}, { 1.0f}, {0.0f}, 0, {0xffff0000}, {0xff808080}},
        {{ 1.0f}, { 1.0f}, {0.0f}, 0, {0xffff0000}, {0xff808080}},
        {{-1.0f}, {-1.0f}, {0.0f}, 0, {0xffff0000}, {0xff808080}},
        {{ 1.0f}, {-1.0f}, {0.0f}, 0, {0xffff0000}, {0xff808080}},
    };
    static D3DTLVERTEX tlquad[] =
    {
        {{   0.0f}, { 480.0f}, {0.0f}, {1.0f}, {0xff0000ff}, {0xff808080}},
        {{   0.0f}, {   0.0f}, {0.0f}, {1.0f}, {0xff0000ff}, {0xff808080}},
        {{ 640.0f}, { 480.0f}, {0.0f}, {1.0f}, {0xff0000ff}, {0xff808080}},
        {{ 640.0f}, {   0.0f}, {0.0f}, {1.0f}, {0xff0000ff}, {0xff808080}},
    };
    static const struct
    {
        D3DVERTEXTYPE vertextype;
        void *data;
        DWORD d3drs_lighting, d3drs_specular;
        DWORD draw_flags;
        unsigned int color;
    }
    tests[] =
    {
        /* Lighting is enabled when D3DVT_VERTEX is used and D3DDP_DONOTLIGHT is not
         * set. D3DVT_VERTEX has diffuse = 0xffffffff and specular = 0x00000000, as
         * in later d3d versions */
        { D3DVT_VERTEX,     quad,   FALSE,  FALSE,  0,                  0x0000ff00},
        { D3DVT_VERTEX,     quad,   TRUE,   FALSE,  0,                  0x0000ff00},
        { D3DVT_VERTEX,     quad,   FALSE,  FALSE,  D3DDP_DONOTLIGHT,   0x00ffffff},
        { D3DVT_VERTEX,     quad,   TRUE,   FALSE,  D3DDP_DONOTLIGHT,   0x00ffffff},
        { D3DVT_VERTEX,     quad,   FALSE,  TRUE,   0,                  0x0000ff00},
        { D3DVT_VERTEX,     quad,   TRUE,   TRUE,   0,                  0x0000ff00},
        { D3DVT_VERTEX,     quad,   FALSE,  TRUE,   D3DDP_DONOTLIGHT,   0x00ffffff},
        { D3DVT_VERTEX,     quad,   TRUE,   TRUE,   D3DDP_DONOTLIGHT,   0x00ffffff},

        { D3DVT_LVERTEX,    lquad,  FALSE,  FALSE,  0,                  0x00ff0000},
        { D3DVT_LVERTEX,    lquad,  TRUE,   FALSE,  0,                  0x00ff0000},
        { D3DVT_LVERTEX,    lquad,  FALSE,  FALSE,  D3DDP_DONOTLIGHT,   0x00ff0000},
        { D3DVT_LVERTEX,    lquad,  TRUE,   FALSE,  D3DDP_DONOTLIGHT,   0x00ff0000},
        { D3DVT_LVERTEX,    lquad,  FALSE,  TRUE,   0,                  0x00ff8080},
        { D3DVT_LVERTEX,    lquad,  TRUE,   TRUE,   0,                  0x00ff8080},
        { D3DVT_LVERTEX,    lquad,  FALSE,  TRUE,   D3DDP_DONOTLIGHT,   0x00ff8080},
        { D3DVT_LVERTEX,    lquad,  TRUE,   TRUE,   D3DDP_DONOTLIGHT,   0x00ff8080},

        { D3DVT_TLVERTEX,   tlquad, FALSE,  FALSE,  0,                  0x000000ff},
        { D3DVT_TLVERTEX,   tlquad, TRUE,   FALSE,  0,                  0x000000ff},
        { D3DVT_TLVERTEX,   tlquad, FALSE,  FALSE,  D3DDP_DONOTLIGHT,   0x000000ff},
        { D3DVT_TLVERTEX,   tlquad, TRUE,   FALSE,  D3DDP_DONOTLIGHT,   0x000000ff},
        { D3DVT_TLVERTEX,   tlquad, FALSE,  TRUE,   0,                  0x008080ff},
        { D3DVT_TLVERTEX,   tlquad, TRUE,   TRUE,   0,                  0x008080ff},
        { D3DVT_TLVERTEX,   tlquad, FALSE,  TRUE,   D3DDP_DONOTLIGHT,   0x008080ff},
        { D3DVT_TLVERTEX,   tlquad, TRUE,   TRUE,   D3DDP_DONOTLIGHT,   0x008080ff},
    };

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    if (!(device = create_device(ddraw, window, DDSCL_NORMAL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        IDirectDraw2_Release(ddraw);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice2_GetRenderTarget(device, &rt);
    ok(SUCCEEDED(hr), "Failed to get render target, hr %#lx.\n", hr);

    viewport = create_viewport(device, 0, 0, 640, 480);
    hr = IDirect3DDevice2_SetCurrentViewport(device, viewport);
    ok(SUCCEEDED(hr), "Failed to set current viewport, hr %#lx.\n", hr);

    emissive = create_emissive_material(device, 0.0f, 1.0f, 0.0f, 0.0f);
    hr = IDirect3DMaterial2_GetHandle(emissive, device, &mat_handle);
    ok(SUCCEEDED(hr), "Failed to get material handle, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetLightState(device, D3DLIGHTSTATE_MATERIAL, mat_handle);
    ok(SUCCEEDED(hr), "Failed to set material state, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_ZENABLE, D3DZB_FALSE);
    ok(SUCCEEDED(hr), "Failed to disable z test, hr %#lx.\n", hr);

    background = create_diffuse_material(device, 0.1f, 0.1f, 0.1f, 0.1f);
    viewport_set_background(device, viewport, background);

    hr = IDirect3DDevice2_GetRenderState(device, D3DRENDERSTATE_SPECULARENABLE, &rs);
    ok(SUCCEEDED(hr), "Failed to get specularenable render state, hr %#lx.\n", hr);
    ok(rs == TRUE, "Initial D3DRENDERSTATE_SPECULARENABLE is %#lx, expected TRUE.\n", rs);

    for (i = 0; i < ARRAY_SIZE(tests); i++)
    {
        hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET);
        ok(SUCCEEDED(hr), "Failed to clear viewport, hr %#lx.\n", hr);

        hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_LIGHTING, tests[i].d3drs_lighting);
        ok(SUCCEEDED(hr), "Failed to set lighting render state, hr %#lx.\n", hr);
        hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_SPECULARENABLE,
                tests[i].d3drs_specular);
        ok(SUCCEEDED(hr), "Failed to set specularenable render state, hr %#lx.\n", hr);

        hr = IDirect3DDevice2_BeginScene(device);
        ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
        hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP,
                tests[i].vertextype, tests[i].data, 4, tests[i].draw_flags | D3DDP_WAIT);
        ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
        hr = IDirect3DDevice2_EndScene(device);
        ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

        color = get_surface_color(rt, 320, 240);
        ok(compare_color(color, tests[i].color, 1),
                "Got unexpected color 0x%08x, expected 0x%08x, test %u.\n",
                color, tests[i].color, i);
    }

    destroy_material(background);
    destroy_material(emissive);
    destroy_viewport(device, viewport);
    IDirectDrawSurface_Release(rt);
    IDirect3DDevice2_Release(device);
    ref = IDirectDraw2_Release(ddraw);
    ok(!ref, "Unexpected refcount %lu.\n", ref);
    DestroyWindow(window);
}

static struct
{
    BOOL received;
    IDirectDraw2 *ddraw;
    HWND window;
    DWORD coop_level;
} activateapp_testdata;

static LRESULT CALLBACK activateapp_test_proc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam)
{
    if (message == WM_ACTIVATEAPP)
    {
        if (activateapp_testdata.ddraw)
        {
            HRESULT hr;
            activateapp_testdata.received = FALSE;
            hr = IDirectDraw2_SetCooperativeLevel(activateapp_testdata.ddraw,
                    activateapp_testdata.window, activateapp_testdata.coop_level);
            ok(SUCCEEDED(hr), "Recursive SetCooperativeLevel call failed, hr %#lx.\n", hr);
            ok(!activateapp_testdata.received, "Received WM_ACTIVATEAPP during recursive SetCooperativeLevel call.\n");
        }
        activateapp_testdata.received = TRUE;
    }

    return DefWindowProcA(hwnd, message, wparam, lparam);
}

static void test_coop_level_activateapp(void)
{
    IDirectDraw2 *ddraw;
    HRESULT hr;
    HWND window;
    WNDCLASSA wc = {0};
    DDSURFACEDESC ddsd;
    IDirectDrawSurface *surface;

    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");

    wc.lpfnWndProc = activateapp_test_proc;
    wc.lpszClassName = "ddraw_test_wndproc_wc";
    ok(RegisterClassA(&wc), "Failed to register window class.\n");

    window = CreateWindowA("ddraw_test_wndproc_wc", "ddraw_test",
            WS_MAXIMIZE | WS_CAPTION , 0, 0, 640, 480, 0, 0, 0, 0);

    /* Exclusive with window already active. */
    SetForegroundWindow(window);
    activateapp_testdata.received = FALSE;
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);
    ok(!activateapp_testdata.received, "Received WM_ACTIVATEAPP although window was already active.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, NULL, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    /* Exclusive with window not active. */
    SetForegroundWindow(foreground);
    activateapp_testdata.received = FALSE;
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);
    ok(activateapp_testdata.received, "Expected WM_ACTIVATEAPP, but did not receive it.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, NULL, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    /* Normal with window not active, then exclusive with the same window. */
    SetForegroundWindow(foreground);
    activateapp_testdata.received = FALSE;
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);
    ok(!activateapp_testdata.received, "Received WM_ACTIVATEAPP when setting DDSCL_NORMAL.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);
    ok(activateapp_testdata.received, "Expected WM_ACTIVATEAPP, but did not receive it.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, NULL, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    /* Recursive set of DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN. */
    SetForegroundWindow(foreground);
    activateapp_testdata.received = FALSE;
    activateapp_testdata.ddraw = ddraw;
    activateapp_testdata.window = window;
    activateapp_testdata.coop_level = DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN;
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);
    ok(activateapp_testdata.received, "Expected WM_ACTIVATEAPP, but did not receive it.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, NULL, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    /* The recursive call seems to have some bad effect on native ddraw, despite (apparently)
     * succeeding. Another switch to exclusive and back to normal is needed to release the
     * window properly. Without doing this, SetCooperativeLevel(EXCLUSIVE) will not send
     * WM_ACTIVATEAPP messages. */
    activateapp_testdata.ddraw = NULL;
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, NULL, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    /* Setting DDSCL_NORMAL with recursive invocation. */
    SetForegroundWindow(foreground);
    activateapp_testdata.received = FALSE;
    activateapp_testdata.ddraw = ddraw;
    activateapp_testdata.window = window;
    activateapp_testdata.coop_level = DDSCL_NORMAL;
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);
    ok(activateapp_testdata.received, "Expected WM_ACTIVATEAPP, but did not receive it.\n");

    /* DDraw is in exclusive mode now. */
    memset(&ddsd, 0, sizeof(ddsd));
    ddsd.dwSize = sizeof(ddsd);
    ddsd.dwFlags = DDSD_CAPS | DDSD_BACKBUFFERCOUNT;
    ddsd.dwBackBufferCount = 1;
    ddsd.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE | DDSCAPS_COMPLEX | DDSCAPS_FLIP;
    hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &surface, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);
    IDirectDrawSurface_Release(surface);

    /* Recover again, just to be sure. */
    activateapp_testdata.ddraw = NULL;
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, NULL, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    DestroyWindow(window);
    UnregisterClassA("ddraw_test_wndproc_wc", GetModuleHandleA(NULL));
    IDirectDraw2_Release(ddraw);
}

struct format_support_check
{
    const DDPIXELFORMAT *format;
    BOOL supported;
};

static HRESULT WINAPI test_unsupported_formats_cb(DDSURFACEDESC *desc, void *ctx)
{
    struct format_support_check *format = ctx;

    if (!memcmp(format->format, &desc->ddpfPixelFormat, sizeof(*format->format)))
    {
        format->supported = TRUE;
        return DDENUMRET_CANCEL;
    }

    return DDENUMRET_OK;
}

static void test_unsupported_formats(void)
{
    HRESULT hr;
    BOOL expect_success;
    HWND window;
    IDirectDraw2 *ddraw;
    IDirect3DDevice2 *device;
    IDirectDrawSurface *surface;
    DDSURFACEDESC ddsd;
    unsigned int i, j;
    DWORD expected_caps;
    static const struct
    {
        const char *name;
        DDPIXELFORMAT fmt;
    }
    formats[] =
    {
        {
            "D3DFMT_A8R8G8B8",
            {
                sizeof(DDPIXELFORMAT), DDPF_RGB | DDPF_ALPHAPIXELS, 0,
                {32}, {0x00ff0000}, {0x0000ff00}, {0x000000ff}, {0xff000000}
            }
        },
        {
            "D3DFMT_P8",
            {
                sizeof(DDPIXELFORMAT), DDPF_PALETTEINDEXED8 | DDPF_RGB, 0,
                {8 }, {0x00000000}, {0x00000000}, {0x00000000}, {0x00000000}
            }
        },
    };
    static const DWORD caps[] = {0, DDSCAPS_SYSTEMMEMORY, DDSCAPS_VIDEOMEMORY};

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    if (!(device = create_device(ddraw, window, DDSCL_NORMAL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        IDirectDraw2_Release(ddraw);
        DestroyWindow(window);
        return;
    }

    for (i = 0; i < ARRAY_SIZE(formats); i++)
    {
        struct format_support_check check = {&formats[i].fmt, FALSE};
        hr = IDirect3DDevice2_EnumTextureFormats(device, test_unsupported_formats_cb, &check);
        ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);

        for (j = 0; j < ARRAY_SIZE(caps); j++)
        {
            memset(&ddsd, 0, sizeof(ddsd));
            ddsd.dwSize = sizeof(ddsd);
            ddsd.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT;
            ddsd.ddpfPixelFormat = formats[i].fmt;
            ddsd.dwWidth = 4;
            ddsd.dwHeight = 4;
            ddsd.ddsCaps.dwCaps = DDSCAPS_TEXTURE | caps[j];

            if (caps[j] & DDSCAPS_VIDEOMEMORY && !check.supported)
                expect_success = FALSE;
            else
                expect_success = TRUE;

            hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &surface, NULL);
            ok(SUCCEEDED(hr) == expect_success,
                    "Got unexpected hr %#lx for format %s, caps %#lx, expected %s.\n",
                    hr, formats[i].name, caps[j], expect_success ? "success" : "failure");
            if (FAILED(hr))
                continue;

            memset(&ddsd, 0, sizeof(ddsd));
            ddsd.dwSize = sizeof(ddsd);
            hr = IDirectDrawSurface_GetSurfaceDesc(surface, &ddsd);
            ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);

            if (caps[j] & DDSCAPS_VIDEOMEMORY)
                expected_caps = DDSCAPS_VIDEOMEMORY;
            else if (caps[j] & DDSCAPS_SYSTEMMEMORY)
                expected_caps = DDSCAPS_SYSTEMMEMORY;
            else if (check.supported)
                expected_caps = DDSCAPS_VIDEOMEMORY;
            else
                expected_caps = DDSCAPS_SYSTEMMEMORY;

            ok(ddsd.ddsCaps.dwCaps & expected_caps,
                    "Expected caps %#lx, format %s, input caps %#lx.\n",
                    expected_caps, formats[i].name, caps[j]);

            IDirectDrawSurface_Release(surface);
        }
    }

    IDirect3DDevice2_Release(device);
    IDirectDraw2_Release(ddraw);
    DestroyWindow(window);
}

static void test_rt_caps(const GUID *device_guid)
{
    DWORD fourcc_codes[64], fourcc_code_count;
    PALETTEENTRY palette_entries[256];
    IDirectDrawPalette *palette;
    IDirect3DDevice2 *device;
    BOOL software_device;
    IDirectDraw2 *ddraw;
    DWORD z_depth = 0;
    IDirect3D2 *d3d;
    DDCAPS hal_caps;
    unsigned int i;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    static const DDPIXELFORMAT p8_fmt =
    {
        sizeof(DDPIXELFORMAT), DDPF_PALETTEINDEXED8 | DDPF_RGB, 0,
        {8}, {0x00000000}, {0x00000000}, {0x00000000}, {0x00000000},
    };
    static const DDPIXELFORMAT fourcc_fmt =
    {
        .dwSize = sizeof(DDPIXELFORMAT),
        .dwFlags = DDPF_FOURCC,
        .dwFourCC = MAKEFOURCC('Y','U','Y','2'),
    };

    static const struct
    {
        const DDPIXELFORMAT *pf;
        DWORD caps_in;
        HRESULT create_device_hr;
        HRESULT set_rt_hr;
        HRESULT alternative_set_rt_hr;
        BOOL create_may_fail;
    }
    test_data[] =
    {
        {
            NULL,
            DDSCAPS_OFFSCREENPLAIN | DDSCAPS_3DDEVICE | DDSCAPS_VIDEOMEMORY,
            D3D_OK,
            D3D_OK,
            D3D_OK,
            FALSE,
        },
        {
            NULL,
            DDSCAPS_OFFSCREENPLAIN | DDSCAPS_3DDEVICE,
            D3D_OK,
            D3D_OK,
            D3D_OK,
            FALSE,
        },
        {
            NULL,
            DDSCAPS_OFFSCREENPLAIN,
            DDERR_INVALIDCAPS,
            DDERR_INVALIDCAPS,
            DDERR_INVALIDCAPS,
            FALSE,
        },
        {
            NULL,
            DDSCAPS_OFFSCREENPLAIN | DDSCAPS_SYSTEMMEMORY | DDSCAPS_3DDEVICE,
            D3DERR_SURFACENOTINVIDMEM,
            D3D_OK,
            D3D_OK,
            FALSE,
        },
        {
            NULL,
            DDSCAPS_OFFSCREENPLAIN | DDSCAPS_SYSTEMMEMORY,
            DDERR_INVALIDCAPS,
            DDERR_INVALIDCAPS,
            DDERR_INVALIDCAPS,
            FALSE,
        },
        {
            NULL,
            DDSCAPS_3DDEVICE | DDSCAPS_VIDEOMEMORY,
            D3D_OK,
            D3D_OK,
            D3D_OK,
            FALSE,
        },
        {
            NULL,
            DDSCAPS_3DDEVICE,
            D3D_OK,
            D3D_OK,
            D3D_OK,
            FALSE,
        },
        {
            NULL,
            0,
            DDERR_INVALIDCAPS,
            DDERR_INVALIDCAPS,
            DDERR_INVALIDCAPS,
            FALSE,
        },
        {
            NULL,
            DDSCAPS_SYSTEMMEMORY | DDSCAPS_3DDEVICE,
            D3DERR_SURFACENOTINVIDMEM,
            D3D_OK,
            D3D_OK,
            FALSE,
        },
        {
            NULL,
            DDSCAPS_SYSTEMMEMORY,
            DDERR_INVALIDCAPS,
            DDERR_INVALIDCAPS,
            DDERR_INVALIDCAPS,
            FALSE,
        },
        {
            &p8_fmt,
            0,
            DDERR_INVALIDCAPS,
            DDERR_INVALIDCAPS,
            DDERR_INVALIDCAPS,
            FALSE,
        },
        {
            &p8_fmt,
            DDSCAPS_OFFSCREENPLAIN | DDSCAPS_3DDEVICE,
            DDERR_NOPALETTEATTACHED,
            DDERR_INVALIDCAPS,
            DDERR_INVALIDCAPS,
            FALSE,
        },
        {
            &p8_fmt,
            DDSCAPS_OFFSCREENPLAIN,
            DDERR_INVALIDCAPS,
            DDERR_INVALIDCAPS,
            DDERR_INVALIDCAPS,
            FALSE,
        },
        {
            &p8_fmt,
            DDSCAPS_OFFSCREENPLAIN | DDSCAPS_SYSTEMMEMORY | DDSCAPS_3DDEVICE,
            DDERR_NOPALETTEATTACHED,
            DDERR_INVALIDCAPS,
            DDERR_INVALIDCAPS,
            FALSE,
        },
        {
            &p8_fmt,
            DDSCAPS_OFFSCREENPLAIN | DDSCAPS_SYSTEMMEMORY,
            DDERR_INVALIDCAPS,
            DDERR_INVALIDCAPS,
            DDERR_INVALIDCAPS,
            FALSE,
        },
        {
            NULL,
            DDSCAPS_3DDEVICE | DDSCAPS_VIDEOMEMORY | DDSCAPS_ZBUFFER,
            DDERR_INVALIDCAPS,
            DDERR_INVALIDPIXELFORMAT,
            DDERR_INVALIDCAPS,
            TRUE /* AMD Evergreen */,
        },
        {
            NULL,
            DDSCAPS_3DDEVICE | DDSCAPS_ZBUFFER,
            DDERR_INVALIDCAPS,
            DDERR_INVALIDPIXELFORMAT,
            DDERR_INVALIDCAPS,
            FALSE,
        },
        {
            NULL,
            DDSCAPS_ZBUFFER,
            DDERR_INVALIDCAPS,
            DDERR_INVALIDCAPS,
            DDERR_INVALIDCAPS,
            FALSE,
        },
        {
            NULL,
            DDSCAPS_SYSTEMMEMORY | DDSCAPS_3DDEVICE | DDSCAPS_ZBUFFER,
            DDERR_INVALIDCAPS,
            DDERR_INVALIDPIXELFORMAT,
            DDERR_INVALIDPIXELFORMAT,
            TRUE /* Nvidia Kepler */,
        },
        {
            NULL,
            DDSCAPS_SYSTEMMEMORY | DDSCAPS_ZBUFFER,
            DDERR_INVALIDCAPS,
            DDERR_INVALIDCAPS,
            DDERR_INVALIDCAPS,
            TRUE /* Nvidia Kepler */,
        },
        {
            &fourcc_fmt,
            DDSCAPS_FLIP | DDSCAPS_COMPLEX | DDSCAPS_OFFSCREENPLAIN,
            DDERR_INVALIDCAPS,
            DDERR_INVALIDCAPS,
            DDERR_INVALIDCAPS,
        },
    };

    software_device = is_software_device_type(device_guid);

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    if (!(device = create_device_ex(ddraw, window, DDSCL_NORMAL, device_guid, NULL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        IDirectDraw2_Release(ddraw);
        DestroyWindow(window);
        return;
    }
    z_depth = get_device_z_depth(device);
    ok(!!z_depth, "Failed to get device z depth.\n");
    IDirect3DDevice2_Release(device);

    if (FAILED(IDirectDraw2_QueryInterface(ddraw, &IID_IDirect3D2, (void **)&d3d)))
    {
        skip("D3D interface is not available, skipping test.\n");
        goto done;
    }

    memset(palette_entries, 0, sizeof(palette_entries));
    hr = IDirectDraw2_CreatePalette(ddraw, DDPCAPS_ALLOW256 | DDPCAPS_8BIT, palette_entries, &palette, NULL);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

    memset(&hal_caps, 0, sizeof(hal_caps));
    hal_caps.dwSize = sizeof(hal_caps);
    hr = IDirectDraw2_GetCaps(ddraw, &hal_caps, NULL);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

    fourcc_code_count = ARRAY_SIZE(fourcc_codes);
    hr = IDirectDraw4_GetFourCCCodes(ddraw, &fourcc_code_count, fourcc_codes);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

    for (i = 0; i < ARRAY_SIZE(test_data); ++i)
    {
        IDirectDrawSurface *surface, *rt, *expected_rt, *tmp;
        DWORD caps_in, expected_caps;
        DDSURFACEDESC surface_desc;
        IDirect3DDevice2 *device;
        HRESULT expected_hr;

        caps_in = test_data[i].caps_in;

        memset(&surface_desc, 0, sizeof(surface_desc));
        surface_desc.dwSize = sizeof(surface_desc);
        surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT;
        surface_desc.ddsCaps.dwCaps = caps_in;
        if (test_data[i].pf)
        {
            if (test_data[i].pf->dwFlags & DDPF_FOURCC)
            {
                unsigned int j;

                for (j = 0; j < fourcc_code_count; ++j)
                {
                    if (test_data[i].pf->dwFourCC == fourcc_codes[j])
                        break;
                }
                if (j == fourcc_code_count)
                {
                    skip("Fourcc format %#lx is not supported, skipping test.\n", test_data[i].pf->dwFourCC);
                    continue;
                }
            }
            surface_desc.dwFlags |= DDSD_PIXELFORMAT;
            surface_desc.ddpfPixelFormat = *test_data[i].pf;
        }
        if (caps_in & DDSCAPS_ZBUFFER)
        {
            surface_desc.dwFlags |= DDSD_ZBUFFERBITDEPTH;
            surface_desc.dwZBufferBitDepth = z_depth;
        }
        if (caps_in & DDSCAPS_FLIP)
        {
            surface_desc.dwFlags |= DDSD_BACKBUFFERCOUNT;
            surface_desc.dwBackBufferCount = 1;
        }
        surface_desc.dwWidth = 640;
        surface_desc.dwHeight = 480;
        if ((caps_in & DDSCAPS_VIDEOMEMORY) && !(hal_caps.ddsCaps.dwCaps & DDSCAPS_VIDEOMEMORY))
            expected_hr = DDERR_NODIRECTDRAWHW;
        else
            expected_hr = DD_OK;
        hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
        ok(hr == expected_hr || broken(test_data[i].create_may_fail
                || (software_device && test_data[i].pf == &p8_fmt && hr == DDERR_INVALIDPIXELFORMAT)),
                "Got unexpected hr %#lx, test %u, software_device %u.\n", hr, i, software_device);
        if (FAILED(hr))
            continue;

        memset(&surface_desc, 0, sizeof(surface_desc));
        surface_desc.dwSize = sizeof(surface_desc);
        hr = IDirectDrawSurface_GetSurfaceDesc(surface, &surface_desc);

        if ((caps_in & DDSCAPS_SYSTEMMEMORY) || !(hal_caps.ddsCaps.dwCaps & DDSCAPS_VIDEOMEMORY))
            expected_caps = caps_in | DDSCAPS_SYSTEMMEMORY;
        else
            expected_caps = caps_in | DDSCAPS_VIDEOMEMORY | DDSCAPS_LOCALVIDMEM;

        if (caps_in & DDSCAPS_FLIP)
            expected_caps |= DDSCAPS_FRONTBUFFER;

        ok(surface_desc.ddsCaps.dwCaps == expected_caps || (test_data[i].pf == &p8_fmt
                && surface_desc.ddsCaps.dwCaps == (caps_in | DDSCAPS_SYSTEMMEMORY))
                || (software_device && caps_in & DDSCAPS_ZBUFFER
                && surface_desc.ddsCaps.dwCaps == (caps_in | DDSCAPS_SYSTEMMEMORY)),
                "Got unexpected caps %#lx, expected %#lx, test %u, software_device %u.\n",
                surface_desc.ddsCaps.dwCaps, expected_caps, i, software_device);

        hr = IDirect3D2_CreateDevice(d3d, device_guid, surface, &device);

        ok((!software_device && hr == test_data[i].create_device_hr)
                || (software_device && (hr == (test_data[i].create_device_hr == D3DERR_SURFACENOTINVIDMEM
                ? DD_OK : test_data[i].create_device_hr))),
                "Got unexpected hr %#lx, test %u, software_device %u.\n", hr, i, software_device);

        if (FAILED(hr))
        {
            if (hr == DDERR_NOPALETTEATTACHED)
            {
                hr = IDirectDrawSurface_SetPalette(surface, palette);
                ok(hr == DD_OK, "Got unexpected hr %#lx, test %u, software_device %u.\n", hr, i, software_device);
                hr = IDirect3D2_CreateDevice(d3d, device_guid, surface, &device);
                if (software_device)
                    todo_wine
                    ok(hr == DD_OK, "Got unexpected hr %#lx, test %u, software_device %u.\n",
                            hr, i, software_device);
                else if (surface_desc.ddsCaps.dwCaps & DDSCAPS_VIDEOMEMORY)
                    ok(hr == DDERR_INVALIDPIXELFORMAT, "Got unexpected hr %#lx, test %u, software_device %u.\n",
                            hr, i, software_device);
                else
                    ok(hr == D3DERR_SURFACENOTINVIDMEM, "Got unexpected hr %#lx, test %u, software_device %u.\n",
                            hr, i, software_device);

                if (hr == DD_OK)
                {
                    refcount = IDirect3DDevice2_Release(device);
                    ok(!refcount, "Test %u: The device was not properly freed, refcount %lu.\n", i, refcount);
                }
            }
            IDirectDrawSurface_Release(surface);

            memset(&surface_desc, 0, sizeof(surface_desc));
            surface_desc.dwSize = sizeof(surface_desc);
            surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT;
            surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN | DDSCAPS_3DDEVICE;
            surface_desc.dwWidth = 640;
            surface_desc.dwHeight = 480;
            hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
            ok(hr == DD_OK, "Got unexpected hr %#lx, test %u, software_device %u.\n", hr, i, software_device);

            hr = IDirect3D2_CreateDevice(d3d, device_guid, surface, &device);
            ok(hr == DD_OK, "Got unexpected hr %#lx, test %u, software_device %u.\n", hr, i, software_device);
        }

        memset(&surface_desc, 0, sizeof(surface_desc));
        surface_desc.dwSize = sizeof(surface_desc);
        surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT;
        surface_desc.ddsCaps.dwCaps = test_data[i].caps_in;
        if (test_data[i].pf)
        {
            surface_desc.dwFlags |= DDSD_PIXELFORMAT;
            surface_desc.ddpfPixelFormat = *test_data[i].pf;
        }
        if (test_data[i].caps_in & DDSCAPS_ZBUFFER)
        {
            surface_desc.dwFlags |= DDSD_ZBUFFERBITDEPTH;
            surface_desc.dwZBufferBitDepth = z_depth;
        }
        if (caps_in & DDSCAPS_FLIP)
        {
            surface_desc.dwFlags |= DDSD_BACKBUFFERCOUNT;
            surface_desc.dwBackBufferCount = 1;
        }
        surface_desc.dwWidth = 640;
        surface_desc.dwHeight = 480;
        hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &rt, NULL);
        ok(hr == DD_OK, "Got unexpected hr %#lx, test %u, software_device %u.\n", hr, i, software_device);

        hr = IDirect3DDevice2_SetRenderTarget(device, rt, 0);
        ok(hr == test_data[i].set_rt_hr  || (software_device && hr == DDERR_NOPALETTEATTACHED)
                || broken(hr == test_data[i].alternative_set_rt_hr),
                "Got unexpected hr %#lx, test %u, software_device %u.\n",
                hr, i, software_device);

        if (SUCCEEDED(hr) || hr == DDERR_INVALIDPIXELFORMAT)
            expected_rt = rt;
        else
            expected_rt = surface;

        /* It appears the surface is set as render target in this case, but no
         * reference is taken. */
        if (hr == DDERR_INVALIDPIXELFORMAT)
        {
            refcount = IDirectDrawSurface_AddRef(rt);
            ok(refcount == 2, "Test %u: Got unexpected refcount %lu.\n", i, refcount);
        }

        hr = IDirect3DDevice2_GetRenderTarget(device, &tmp);
        ok(hr == DD_OK, "Got unexpected hr %#lx, test %u, software_device %u.\n", hr, i, software_device);
        ok(tmp == expected_rt, "Got unexpected rt %p, test %u, software_device %u.\n", tmp, i, software_device);

        IDirectDrawSurface_Release(tmp);
        IDirectDrawSurface_Release(rt);
        refcount = IDirect3DDevice2_Release(device);
        ok(!refcount, "Unexpected refcount %lu.\n", refcount);
        refcount = IDirectDrawSurface_Release(surface);
        ok(!refcount, "Unexpected refcount %lu.\n", refcount);
    }

    IDirectDrawPalette_Release(palette);
    IDirect3D2_Release(d3d);

done:
    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "Unexpected refcount %lu.\n", refcount);
    DestroyWindow(window);
}

static void test_primary_caps(void)
{
    const DWORD placement = DDSCAPS_LOCALVIDMEM | DDSCAPS_VIDEOMEMORY | DDSCAPS_SYSTEMMEMORY;
    IDirectDrawSurface *surface;
    DDSURFACEDESC surface_desc;
    IDirectDraw2 *ddraw;
    unsigned int i;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    static const struct
    {
        DWORD coop_level;
        DWORD caps_in;
        DWORD back_buffer_count;
        HRESULT hr;
        DWORD caps_out;
    }
    test_data[] =
    {
        {
            DDSCL_NORMAL,
            DDSCAPS_PRIMARYSURFACE,
            ~0u,
            DD_OK,
            DDSCAPS_VISIBLE | DDSCAPS_PRIMARYSURFACE,
        },
        {
            DDSCL_NORMAL,
            DDSCAPS_PRIMARYSURFACE | DDSCAPS_TEXTURE,
            ~0u,
            DDERR_INVALIDCAPS,
            ~0u,
        },
        {
            DDSCL_NORMAL,
            DDSCAPS_PRIMARYSURFACE | DDSCAPS_FRONTBUFFER,
            ~0u,
            DDERR_INVALIDCAPS,
            ~0u,
        },
        {
            DDSCL_NORMAL,
            DDSCAPS_PRIMARYSURFACE | DDSCAPS_BACKBUFFER,
            ~0u,
            DDERR_INVALIDCAPS,
            ~0u,
        },
        {
            DDSCL_NORMAL,
            DDSCAPS_PRIMARYSURFACE | DDSCAPS_FLIP,
            ~0u,
            DDERR_INVALIDCAPS,
            ~0u,
        },
        {
            DDSCL_NORMAL,
            DDSCAPS_PRIMARYSURFACE | DDSCAPS_COMPLEX,
            ~0u,
            DDERR_INVALIDCAPS,
            ~0u,
        },
        {
            DDSCL_NORMAL,
            DDSCAPS_PRIMARYSURFACE | DDSCAPS_COMPLEX | DDSCAPS_FLIP,
            ~0u,
            DDERR_INVALIDCAPS,
            ~0u,
        },
        {
            DDSCL_NORMAL,
            DDSCAPS_PRIMARYSURFACE | DDSCAPS_COMPLEX | DDSCAPS_FLIP,
            0,
            DDERR_INVALIDCAPS,
            ~0u,
        },
        {
            DDSCL_NORMAL,
            DDSCAPS_PRIMARYSURFACE | DDSCAPS_COMPLEX | DDSCAPS_FLIP,
            1,
            DDERR_NOEXCLUSIVEMODE,
            ~0u,
        },
        {
            DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN,
            DDSCAPS_PRIMARYSURFACE | DDSCAPS_COMPLEX | DDSCAPS_FLIP,
            0,
            DDERR_INVALIDCAPS,
            ~0u,
        },
        {
            DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN,
            DDSCAPS_PRIMARYSURFACE | DDSCAPS_COMPLEX | DDSCAPS_FLIP,
            1,
            DD_OK,
            DDSCAPS_VISIBLE | DDSCAPS_PRIMARYSURFACE | DDSCAPS_FRONTBUFFER | DDSCAPS_FLIP | DDSCAPS_COMPLEX,
        },
        {
            DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN,
            DDSCAPS_PRIMARYSURFACE | DDSCAPS_COMPLEX | DDSCAPS_FLIP | DDSCAPS_FRONTBUFFER,
            1,
            DDERR_INVALIDCAPS,
            ~0u,
        },
        {
            DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN,
            DDSCAPS_PRIMARYSURFACE | DDSCAPS_COMPLEX | DDSCAPS_FLIP | DDSCAPS_BACKBUFFER,
            1,
            DDERR_INVALIDCAPS,
            ~0u,
        },
    };

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");

    for (i = 0; i < ARRAY_SIZE(test_data); ++i)
    {
        hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, test_data[i].coop_level);
        ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

        memset(&surface_desc, 0, sizeof(surface_desc));
        surface_desc.dwSize = sizeof(surface_desc);
        surface_desc.dwFlags = DDSD_CAPS;
        if (test_data[i].back_buffer_count != ~0u)
            surface_desc.dwFlags |= DDSD_BACKBUFFERCOUNT;
        surface_desc.ddsCaps.dwCaps = test_data[i].caps_in;
        surface_desc.dwBackBufferCount = test_data[i].back_buffer_count;
        hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
        ok(hr == test_data[i].hr, "Test %u: Got unexpected hr %#lx, expected %#lx.\n", i, hr, test_data[i].hr);
        if (FAILED(hr))
            continue;

        memset(&surface_desc, 0, sizeof(surface_desc));
        surface_desc.dwSize = sizeof(surface_desc);
        hr = IDirectDrawSurface_GetSurfaceDesc(surface, &surface_desc);
        ok(SUCCEEDED(hr), "Test %u: Failed to get surface desc, hr %#lx.\n", i, hr);
        ok((surface_desc.ddsCaps.dwCaps & ~placement) == test_data[i].caps_out,
                "Test %u: Got unexpected caps %#lx, expected %#lx.\n",
                i, surface_desc.ddsCaps.dwCaps, test_data[i].caps_out);

        IDirectDrawSurface_Release(surface);
    }

    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "Unexpected refcount %lu.\n", refcount);
    DestroyWindow(window);
}

static void test_surface_lock(void)
{
    IDirectDraw2 *ddraw;
    IDirectDrawSurface *surface;
    IDirect3DDevice2 *device;
    HRESULT hr;
    HWND window;
    unsigned int i;
    DDSURFACEDESC ddsd;
    ULONG refcount;
    DWORD z_depth = 0;
    static const struct
    {
        DWORD caps;
        const char *name;
    }
    tests[] =
    {
        {
            DDSCAPS_OFFSCREENPLAIN | DDSCAPS_VIDEOMEMORY,
            "videomemory offscreenplain"
        },
        {
            DDSCAPS_OFFSCREENPLAIN | DDSCAPS_SYSTEMMEMORY,
            "systemmemory offscreenplain"
        },
        {
            DDSCAPS_PRIMARYSURFACE,
            "primary"
        },
        {
            DDSCAPS_TEXTURE | DDSCAPS_VIDEOMEMORY,
            "videomemory texture"
        },
        {
            DDSCAPS_TEXTURE | DDSCAPS_SYSTEMMEMORY,
            "systemmemory texture"
        },
        {
            DDSCAPS_OFFSCREENPLAIN | DDSCAPS_3DDEVICE,
            "render target"
        },
        {
            DDSCAPS_ZBUFFER,
            "Z buffer"
        },
    };

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    if (!(device = create_device(ddraw, window, DDSCL_NORMAL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        IDirectDraw2_Release(ddraw);
        DestroyWindow(window);
        return;
    }
    z_depth = get_device_z_depth(device);
    ok(!!z_depth, "Failed to get device z depth.\n");
    IDirect3DDevice2_Release(device);

    for (i = 0; i < ARRAY_SIZE(tests); i++)
    {
        memset(&ddsd, 0, sizeof(ddsd));
        ddsd.dwSize = sizeof(ddsd);
        ddsd.dwFlags = DDSD_CAPS;
        if (!(tests[i].caps & DDSCAPS_PRIMARYSURFACE))
        {
            ddsd.dwFlags |= DDSD_WIDTH | DDSD_HEIGHT;
            ddsd.dwWidth = 64;
            ddsd.dwHeight = 64;
        }
        if (tests[i].caps & DDSCAPS_ZBUFFER)
        {
            ddsd.dwFlags |= DDSD_ZBUFFERBITDEPTH;
            ddsd.dwZBufferBitDepth = z_depth;
        }
        ddsd.ddsCaps.dwCaps = tests[i].caps;

        hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &surface, NULL);
        ok(SUCCEEDED(hr), "Failed to create surface, type %s, hr %#lx.\n", tests[i].name, hr);

        memset(&ddsd, 0, sizeof(ddsd));
        ddsd.dwSize = sizeof(ddsd);
        hr = IDirectDrawSurface_Lock(surface, NULL, &ddsd, DDLOCK_WAIT, NULL);
        ok(SUCCEEDED(hr), "Failed to lock surface, type %s, hr %#lx.\n", tests[i].name, hr);
        if (SUCCEEDED(hr))
        {
            hr = IDirectDrawSurface_Unlock(surface, NULL);
            ok(SUCCEEDED(hr), "Failed to unlock surface, type %s, hr %#lx.\n", tests[i].name, hr);
        }

        memset(&ddsd, 0, sizeof(ddsd));
        hr = IDirectDrawSurface_Lock(surface, NULL, &ddsd, DDLOCK_WAIT, NULL);
        ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx, type %s.\n", hr, tests[i].name);

        IDirectDrawSurface_Release(surface);
    }

    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "Unexpected refcount %lu.\n", refcount);
    DestroyWindow(window);
}

static void test_surface_discard(void)
{
    IDirectDraw2 *ddraw;
    IDirect3DDevice2 *device;
    HRESULT hr;
    HWND window;
    DDSURFACEDESC ddsd;
    IDirectDrawSurface *surface, *target;
    void *addr;
    static const struct
    {
        DWORD caps;
        BOOL discard;
    }
    tests[] =
    {
        {DDSCAPS_OFFSCREENPLAIN | DDSCAPS_VIDEOMEMORY, TRUE},
        {DDSCAPS_OFFSCREENPLAIN | DDSCAPS_SYSTEMMEMORY, FALSE},
        {DDSCAPS_TEXTURE | DDSCAPS_VIDEOMEMORY, TRUE},
        {DDSCAPS_TEXTURE | DDSCAPS_SYSTEMMEMORY, FALSE},
    };
    unsigned int i;

    window = create_window();

    for (i = 0; i < ARRAY_SIZE(tests); i++)
    {
        BOOL discarded;

        /* Sigh. Anything other than the first run of the loop randomly fails with
         * DDERR_SURFACELOST on my Radeon Pro 560 on Win10 19.09. Most of the time
         * the blit fails, but with sleeps added between surface creation and lock
         * the lock can fail too. Interestingly ddraw claims the render target has
         * been lost, not the test surface.
         *
         * Recreating ddraw every iteration seems to fix this. */
        ddraw = create_ddraw();
        ok(!!ddraw, "Failed to create a ddraw object.\n");
        if (!(device = create_device(ddraw, window, DDSCL_NORMAL)))
        {
            skip("Failed to create a 3D device, skipping test.\n");
            DestroyWindow(window);
            IDirectDraw2_Release(ddraw);
            return;
        }

        hr = IDirect3DDevice2_GetRenderTarget(device, &target);
        ok(SUCCEEDED(hr), "Failed to get render target, hr %#lx.\n", hr);

        memset(&ddsd, 0, sizeof(ddsd));
        ddsd.dwSize = sizeof(ddsd);
        ddsd.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT;
        ddsd.ddsCaps.dwCaps = tests[i].caps;
        ddsd.dwWidth = 64;
        ddsd.dwHeight = 64;
        hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &surface, NULL);
        if (FAILED(hr))
        {
            skip("Failed to create surface, skipping.\n");
            continue;
        }

        memset(&ddsd, 0, sizeof(ddsd));
        ddsd.dwSize = sizeof(ddsd);
        hr = IDirectDrawSurface_Lock(surface, NULL, &ddsd, DDLOCK_WAIT, NULL);
        ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx.\n", hr);
        addr = ddsd.lpSurface;
        hr = IDirectDrawSurface_Unlock(surface, NULL);
        ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);

        memset(&ddsd, 0, sizeof(ddsd));
        ddsd.dwSize = sizeof(ddsd);
        hr = IDirectDrawSurface_Lock(surface, NULL, &ddsd, DDLOCK_DISCARDCONTENTS | DDLOCK_WAIT, NULL);
        ok(SUCCEEDED(hr) , "Failed to lock surface, hr %#lx.\n", hr);
        discarded = ddsd.lpSurface != addr;
        hr = IDirectDrawSurface_Unlock(surface, NULL);
        ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);

        hr = IDirectDrawSurface_Blt(target, NULL, surface, NULL, DDBLT_WAIT, NULL);
        ok(SUCCEEDED(hr), "Failed to blit, hr %#lx.\n", hr);

        memset(&ddsd, 0, sizeof(ddsd));
        ddsd.dwSize = sizeof(ddsd);
        hr = IDirectDrawSurface_Lock(surface, NULL, &ddsd, DDLOCK_DISCARDCONTENTS | DDLOCK_WAIT, NULL);
        ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx.\n", hr);
        discarded |= ddsd.lpSurface != addr;
        hr = IDirectDrawSurface_Unlock(surface, NULL);
        ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);

        IDirectDrawSurface_Release(surface);

        /* Windows 7 reliably changes the address of surfaces that are discardable (Nvidia Kepler,
         * AMD r500, evergreen). Windows XP, at least on AMD r200, never changes the pointer. */
        ok(!discarded || tests[i].discard, "Expected surface not to be discarded, case %u\n", i);

        IDirectDrawSurface_Release(target);
        IDirect3DDevice2_Release(device);
        IDirectDraw2_Release(ddraw);
    }

    DestroyWindow(window);
}

static void test_flip(void)
{
    const DWORD placement = DDSCAPS_LOCALVIDMEM | DDSCAPS_VIDEOMEMORY | DDSCAPS_SYSTEMMEMORY;
    IDirectDrawSurface *frontbuffer, *backbuffer1, *backbuffer2, *backbuffer3, *surface;
    DDSCAPS caps = {DDSCAPS_FLIP};
    DDSURFACEDESC surface_desc;
    unsigned int color, i;
    BOOL sysmem_primary;
    IDirectDraw2 *ddraw;
    DWORD expected_caps;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    static const struct
    {
        const char *name;
        DWORD caps;
    }
    test_data[] =
    {
        {"PRIMARYSURFACE", DDSCAPS_PRIMARYSURFACE},
        {"OFFSCREENPLAIN", DDSCAPS_OFFSCREENPLAIN},
        {"TEXTURE",        DDSCAPS_TEXTURE},
    };

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    for (i = 0; i < ARRAY_SIZE(test_data); ++i)
    {
        /* Creating a flippable texture induces a BSoD on some versions of the
         * Intel graphics driver. At least Intel GMA 950 with driver version
         * 6.14.10.4926 on Windows XP SP3 is affected. */
        if ((test_data[i].caps & DDSCAPS_TEXTURE) && ddraw_is_intel(ddraw))
        {
            win_skip("Skipping flippable texture test.\n");
            continue;
        }

        memset(&surface_desc, 0, sizeof(surface_desc));
        surface_desc.dwSize = sizeof(surface_desc);
        surface_desc.dwFlags = DDSD_CAPS;
        if (!(test_data[i].caps & DDSCAPS_PRIMARYSURFACE))
            surface_desc.dwFlags |= DDSD_WIDTH | DDSD_HEIGHT;
        surface_desc.ddsCaps.dwCaps = DDSCAPS_COMPLEX | DDSCAPS_FLIP | test_data[i].caps;
        surface_desc.dwWidth = 512;
        surface_desc.dwHeight = 512;
        surface_desc.dwBackBufferCount = 3;
        hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &frontbuffer, NULL);
        ok(hr == DDERR_INVALIDCAPS, "%s: Got unexpected hr %#lx.\n", test_data[i].name, hr);

        surface_desc.ddsCaps.dwCaps &= ~DDSCAPS_FLIP;
        surface_desc.dwFlags |= DDSD_BACKBUFFERCOUNT;
        hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &frontbuffer, NULL);
        ok(hr == DDERR_INVALIDCAPS, "%s: Got unexpected hr %#lx.\n", test_data[i].name, hr);

        surface_desc.ddsCaps.dwCaps &= ~DDSCAPS_COMPLEX;
        surface_desc.ddsCaps.dwCaps |= DDSCAPS_FLIP;
        hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &frontbuffer, NULL);
        ok(hr == DDERR_INVALIDCAPS, "%s: Got unexpected hr %#lx.\n", test_data[i].name, hr);

        surface_desc.ddsCaps.dwCaps |= DDSCAPS_COMPLEX;
        hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &frontbuffer, NULL);
        todo_wine_if(test_data[i].caps & DDSCAPS_TEXTURE)
            ok(SUCCEEDED(hr), "%s: Failed to create surface, hr %#lx.\n", test_data[i].name, hr);
        if (FAILED(hr))
            continue;

        hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL | DDSCL_FULLSCREEN);
        ok(SUCCEEDED(hr), "%s: Failed to set cooperative level, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_IsLost(frontbuffer);
        ok(hr == DD_OK, "%s: Got unexpected hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_Flip(frontbuffer, NULL, DDFLIP_WAIT);
        if (test_data[i].caps & DDSCAPS_PRIMARYSURFACE)
            ok(hr == DDERR_NOEXCLUSIVEMODE, "%s: Got unexpected hr %#lx.\n", test_data[i].name, hr);
        else
            ok(SUCCEEDED(hr), "%s: Failed to flip, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
        ok(SUCCEEDED(hr), "%s: Failed to set cooperative level, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_IsLost(frontbuffer);
        todo_wine ok(hr == DDERR_SURFACELOST, "%s: Got unexpected hr %#lx.\n", test_data[i].name, hr);
        hr = restore_surfaces(ddraw);
        ok(SUCCEEDED(hr), "%s: Failed to restore surfaces, hr %#lx.\n", test_data[i].name, hr);

        memset(&surface_desc, 0, sizeof(surface_desc));
        surface_desc.dwSize = sizeof(surface_desc);
        hr = IDirectDrawSurface_GetSurfaceDesc(frontbuffer, &surface_desc);
        ok(SUCCEEDED(hr), "%s: Failed to get surface desc, hr %#lx.\n", test_data[i].name, hr);
        expected_caps = DDSCAPS_FRONTBUFFER | DDSCAPS_COMPLEX | DDSCAPS_FLIP | test_data[i].caps;
        if (test_data[i].caps & DDSCAPS_PRIMARYSURFACE)
            expected_caps |= DDSCAPS_VISIBLE;
        ok((surface_desc.ddsCaps.dwCaps & ~placement) == expected_caps,
                "%s: Got unexpected caps %#lx.\n", test_data[i].name, surface_desc.ddsCaps.dwCaps);
        sysmem_primary = surface_desc.ddsCaps.dwCaps & DDSCAPS_SYSTEMMEMORY;

        hr = IDirectDrawSurface_GetAttachedSurface(frontbuffer, &caps, &backbuffer1);
        ok(SUCCEEDED(hr), "%s: Failed to get attached surface, hr %#lx.\n", test_data[i].name, hr);
        memset(&surface_desc, 0, sizeof(surface_desc));
        surface_desc.dwSize = sizeof(surface_desc);
        hr = IDirectDrawSurface_GetSurfaceDesc(backbuffer1, &surface_desc);
        ok(SUCCEEDED(hr), "%s: Failed to get surface desc, hr %#lx.\n", test_data[i].name, hr);
        ok(!surface_desc.dwBackBufferCount, "%s: Got unexpected back buffer count %lu.\n",
                test_data[i].name, surface_desc.dwBackBufferCount);
        expected_caps &= ~(DDSCAPS_VISIBLE | DDSCAPS_PRIMARYSURFACE | DDSCAPS_FRONTBUFFER);
        expected_caps |= DDSCAPS_BACKBUFFER;
        ok((surface_desc.ddsCaps.dwCaps & ~placement) == expected_caps,
                "%s: Got unexpected caps %#lx.\n", test_data[i].name, surface_desc.ddsCaps.dwCaps);

        hr = IDirectDrawSurface_GetAttachedSurface(backbuffer1, &caps, &backbuffer2);
        ok(SUCCEEDED(hr), "%s: Failed to get attached surface, hr %#lx.\n", test_data[i].name, hr);
        memset(&surface_desc, 0, sizeof(surface_desc));
        surface_desc.dwSize = sizeof(surface_desc);
        hr = IDirectDrawSurface_GetSurfaceDesc(backbuffer2, &surface_desc);
        ok(SUCCEEDED(hr), "%s: Failed to get surface desc, hr %#lx.\n", test_data[i].name, hr);
        ok(!surface_desc.dwBackBufferCount, "%s: Got unexpected back buffer count %lu.\n",
                test_data[i].name, surface_desc.dwBackBufferCount);
        expected_caps &= ~DDSCAPS_BACKBUFFER;
        ok((surface_desc.ddsCaps.dwCaps & ~placement) == expected_caps,
                "%s: Got unexpected caps %#lx.\n", test_data[i].name, surface_desc.ddsCaps.dwCaps);

        hr = IDirectDrawSurface_GetAttachedSurface(backbuffer2, &caps, &backbuffer3);
        ok(SUCCEEDED(hr), "%s: Failed to get attached surface, hr %#lx.\n", test_data[i].name, hr);
        memset(&surface_desc, 0, sizeof(surface_desc));
        surface_desc.dwSize = sizeof(surface_desc);
        hr = IDirectDrawSurface_GetSurfaceDesc(backbuffer3, &surface_desc);
        ok(SUCCEEDED(hr), "%s: Failed to get surface desc, hr %#lx.\n", test_data[i].name, hr);
        ok(!surface_desc.dwBackBufferCount, "%s: Got unexpected back buffer count %lu.\n",
                test_data[i].name, surface_desc.dwBackBufferCount);
        ok((surface_desc.ddsCaps.dwCaps & ~placement) == expected_caps,
                "%s: Got unexpected caps %#lx.\n", test_data[i].name, surface_desc.ddsCaps.dwCaps);

        hr = IDirectDrawSurface_GetAttachedSurface(backbuffer3, &caps, &surface);
        ok(SUCCEEDED(hr), "%s: Failed to get attached surface, hr %#lx.\n", test_data[i].name, hr);
        ok(surface == frontbuffer, "%s: Got unexpected surface %p, expected %p.\n",
                test_data[i].name, surface, frontbuffer);
        IDirectDrawSurface_Release(surface);

        memset(&surface_desc, 0, sizeof(surface_desc));
        surface_desc.dwSize = sizeof(surface_desc);
        surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT;
        surface_desc.ddsCaps.dwCaps = 0;
        surface_desc.dwWidth = 640;
        surface_desc.dwHeight = 480;
        hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
        ok(SUCCEEDED(hr), "%s: Failed to create surface, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_Flip(frontbuffer, surface, DDFLIP_WAIT);
        ok(hr == DDERR_NOTFLIPPABLE, "%s: Got unexpected hr %#lx.\n", test_data[i].name, hr);
        IDirectDrawSurface_Release(surface);

        hr = IDirectDrawSurface_Flip(frontbuffer, frontbuffer, DDFLIP_WAIT);
        ok(hr == DDERR_NOTFLIPPABLE, "%s: Got unexpected hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_Flip(backbuffer1, NULL, DDFLIP_WAIT);
        ok(hr == DDERR_NOTFLIPPABLE, "%s: Got unexpected hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_Flip(backbuffer2, NULL, DDFLIP_WAIT);
        ok(hr == DDERR_NOTFLIPPABLE, "%s: Got unexpected hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_Flip(backbuffer3, NULL, DDFLIP_WAIT);
        ok(hr == DDERR_NOTFLIPPABLE, "%s: Got unexpected hr %#lx.\n", test_data[i].name, hr);

        /* The Nvidia Geforce 7 driver cannot do a color fill on a texture backbuffer after
         * the backbuffer has been locked or GetSurfaceDesc has been called. Do it ourselves
         * as a workaround. */
        fill_surface(backbuffer1, 0xffff0000);
        fill_surface(backbuffer2, 0xff00ff00);
        fill_surface(backbuffer3, 0xff0000ff);

        hr = IDirectDrawSurface_Flip(frontbuffer, NULL, DDFLIP_WAIT);
        ok(SUCCEEDED(hr), "%s: Failed to flip, hr %#lx.\n", test_data[i].name, hr);
        color = get_surface_color(backbuffer1, 320, 240);
        /* The testbot seems to just copy the contents of one surface to all the
         * others, instead of properly flipping. */
        ok(compare_color(color, 0x0000ff00, 1) || broken(sysmem_primary && compare_color(color, 0x000000ff, 1)),
                "%s: Got unexpected color 0x%08x.\n", test_data[i].name, color);
        color = get_surface_color(backbuffer2, 320, 240);
        ok(compare_color(color, 0x000000ff, 1), "%s: Got unexpected color 0x%08x.\n", test_data[i].name, color);
        fill_surface(backbuffer3, 0xffff0000);

        hr = IDirectDrawSurface_Flip(frontbuffer, NULL, DDFLIP_WAIT);
        ok(SUCCEEDED(hr), "%s: Failed to flip, hr %#lx.\n", test_data[i].name, hr);
        color = get_surface_color(backbuffer1, 320, 240);
        ok(compare_color(color, 0x000000ff, 1) || broken(sysmem_primary && compare_color(color, 0x00ff0000, 1)),
                "%s: Got unexpected color 0x%08x.\n", test_data[i].name, color);
        color = get_surface_color(backbuffer2, 320, 240);
        ok(compare_color(color, 0x00ff0000, 1), "%s: Got unexpected color 0x%08x.\n", test_data[i].name, color);
        fill_surface(backbuffer3, 0xff00ff00);

        hr = IDirectDrawSurface_Flip(frontbuffer, NULL, DDFLIP_WAIT);
        ok(SUCCEEDED(hr), "%s: Failed to flip, hr %#lx.\n", test_data[i].name, hr);
        color = get_surface_color(backbuffer1, 320, 240);
        ok(compare_color(color, 0x00ff0000, 1) || broken(sysmem_primary && compare_color(color, 0x0000ff00, 1)),
                "%s: Got unexpected color 0x%08x.\n", test_data[i].name, color);
        color = get_surface_color(backbuffer2, 320, 240);
        ok(compare_color(color, 0x0000ff00, 1), "%s: Got unexpected color 0x%08x.\n", test_data[i].name, color);
        fill_surface(backbuffer3, 0xff0000ff);

        hr = IDirectDrawSurface_Flip(frontbuffer, backbuffer1, DDFLIP_WAIT);
        ok(SUCCEEDED(hr), "%s: Failed to flip, hr %#lx.\n", test_data[i].name, hr);
        color = get_surface_color(backbuffer2, 320, 240);
        ok(compare_color(color, 0x0000ff00, 1) || broken(sysmem_primary && compare_color(color, 0x000000ff, 1)),
                "%s: Got unexpected color 0x%08x.\n", test_data[i].name, color);
        color = get_surface_color(backbuffer3, 320, 240);
        ok(compare_color(color, 0x000000ff, 1), "%s: Got unexpected color 0x%08x.\n", test_data[i].name, color);
        fill_surface(backbuffer1, 0xffff0000);

        hr = IDirectDrawSurface_Flip(frontbuffer, backbuffer2, DDFLIP_WAIT);
        ok(SUCCEEDED(hr), "%s: Failed to flip, hr %#lx.\n", test_data[i].name, hr);
        color = get_surface_color(backbuffer1, 320, 240);
        ok(compare_color(color, 0x00ff0000, 1), "%s: Got unexpected color 0x%08x.\n", test_data[i].name, color);
        color = get_surface_color(backbuffer3, 320, 240);
        ok(compare_color(color, 0x000000ff, 1) || broken(sysmem_primary && compare_color(color, 0x00ff0000, 1)),
                "%s: Got unexpected color 0x%08x.\n", test_data[i].name, color);
        fill_surface(backbuffer2, 0xff00ff00);

        hr = IDirectDrawSurface_Flip(frontbuffer, backbuffer3, DDFLIP_WAIT);
        ok(SUCCEEDED(hr), "%s: Failed to flip, hr %#lx.\n", test_data[i].name, hr);
        color = get_surface_color(backbuffer1, 320, 240);
        ok(compare_color(color, 0x00ff0000, 1) || broken(sysmem_primary && compare_color(color, 0x0000ff00, 1)),
                "%s: Got unexpected color 0x%08x.\n", test_data[i].name, color);
        color = get_surface_color(backbuffer2, 320, 240);
        ok(compare_color(color, 0x0000ff00, 1), "%s: Got unexpected color 0x%08x.\n", test_data[i].name, color);

        IDirectDrawSurface_Release(backbuffer3);
        IDirectDrawSurface_Release(backbuffer2);
        IDirectDrawSurface_Release(backbuffer1);
        IDirectDrawSurface_Release(frontbuffer);
    }

    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "Unexpected refcount %lu.\n", refcount);
    DestroyWindow(window);
}

static void reset_ddsd(DDSURFACEDESC *ddsd)
{
    memset(ddsd, 0, sizeof(*ddsd));
    ddsd->dwSize = sizeof(*ddsd);
}

static void test_set_surface_desc(void)
{
    IDirectDraw2 *ddraw;
    HWND window;
    HRESULT hr;
    DDSURFACEDESC ddsd;
    IDirectDrawSurface *surface;
    IDirectDrawSurface3 *surface3;
    BYTE data[16*16*4];
    ULONG ref;
    unsigned int i;
    static const struct
    {
        DWORD caps;
        BOOL supported;
        const char *name;
    }
    invalid_caps_tests[] =
    {
        {DDSCAPS_VIDEOMEMORY, FALSE, "videomemory plain"},
        {DDSCAPS_TEXTURE | DDSCAPS_SYSTEMMEMORY, TRUE, "systemmemory texture"},
        {DDSCAPS_PRIMARYSURFACE | DDSCAPS_SYSTEMMEMORY, FALSE, "systemmemory primary"},
    };

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    reset_ddsd(&ddsd);
    ddsd.dwFlags = DDSD_WIDTH | DDSD_HEIGHT | DDSD_CAPS | DDSD_PIXELFORMAT;
    ddsd.dwWidth = 8;
    ddsd.dwHeight = 8;
    ddsd.ddpfPixelFormat.dwSize = sizeof(ddsd.ddpfPixelFormat);
    ddsd.ddpfPixelFormat.dwFlags = DDPF_RGB;
    ddsd.ddpfPixelFormat.dwRGBBitCount = 32;
    ddsd.ddpfPixelFormat.dwRBitMask = 0x00ff0000;
    ddsd.ddpfPixelFormat.dwGBitMask = 0x0000ff00;
    ddsd.ddpfPixelFormat.dwBBitMask = 0x000000ff;
    ddsd.ddsCaps.dwCaps = DDSCAPS_SYSTEMMEMORY | DDSCAPS_OFFSCREENPLAIN;

    hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &surface, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

    hr = IDirectDrawSurface_QueryInterface(surface, &IID_IDirectDrawSurface3, (void **)&surface3);
    ok(SUCCEEDED(hr), "Failed to get IDirectDrawSurface3 interface, hr %#lx.\n", hr);
    IDirectDrawSurface_Release(surface);

    reset_ddsd(&ddsd);
    ddsd.dwFlags = DDSD_LPSURFACE;
    ddsd.lpSurface = data;
    hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
    ok(SUCCEEDED(hr), "Failed to set surface desc, hr %#lx.\n", hr);

    /* Redundantly setting the same lpSurface is not an error. */
    hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
    ok(SUCCEEDED(hr), "Failed to set surface desc, hr %#lx.\n", hr);
    hr = IDirectDrawSurface3_GetSurfaceDesc(surface3, &ddsd);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(!(ddsd.dwFlags & DDSD_LPSURFACE), "DDSD_LPSURFACE is set.\n");
    ok(ddsd.lpSurface == NULL, "lpSurface is %p, expected NULL.\n", ddsd.lpSurface);

    hr = IDirectDrawSurface3_Lock(surface3, NULL, &ddsd, 0, NULL);
    ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx.\n", hr);
    ok(!(ddsd.dwFlags & DDSD_LPSURFACE), "DDSD_LPSURFACE is set.\n");
    ok(ddsd.lpSurface == data, "lpSurface is %p, expected %p.\n", data, data);
    hr = IDirectDrawSurface3_Unlock(surface3, NULL);
    ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);

    reset_ddsd(&ddsd);
    ddsd.dwFlags = DDSD_LPSURFACE;
    ddsd.lpSurface = data;
    hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 1);
    ok(hr == DDERR_INVALIDPARAMS, "Got hr %#lx.\n", hr);

    ddsd.lpSurface = NULL;
    hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
    ok(hr == DDERR_INVALIDPARAMS, "Got hr %#lx.\n", hr);

    hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, NULL, 0);
    ok(hr == DDERR_INVALIDPARAMS, "Got hr %#lx.\n", hr);

    hr = IDirectDrawSurface3_GetSurfaceDesc(surface3, &ddsd);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(ddsd.ddsCaps.dwCaps == (DDSCAPS_SYSTEMMEMORY | DDSCAPS_OFFSCREENPLAIN),
            "Got unexpected caps %#lx.\n", ddsd.ddsCaps.dwCaps);

    /* Setting the caps is an error. This also means the original description cannot be reapplied. */
    hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
    ok(hr == DDERR_INVALIDPARAMS, "Got hr %#lx.\n", hr);

    ddsd.dwFlags = DDSD_CAPS;
    hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
    ok(hr == DDERR_INVALIDPARAMS, "Got hr %#lx.\n", hr);

    /* dwCaps = 0 is allowed, but ignored. */
    ddsd.dwFlags = DDSD_CAPS | DDSD_LPSURFACE;
    ddsd.lpSurface = data;
    hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
    ok(hr == DDERR_INVALIDCAPS, "Got hr %#lx.\n", hr);
    ddsd.ddsCaps.dwCaps = DDSCAPS_SYSTEMMEMORY | DDSCAPS_OFFSCREENPLAIN;
    hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
    ok(hr == DDERR_INVALIDCAPS, "Got hr %#lx.\n", hr);
    ddsd.ddsCaps.dwCaps = 0;
    hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
    ok(SUCCEEDED(hr), "Failed to set surface desc, hr %#lx.\n", hr);

    hr = IDirectDrawSurface3_GetSurfaceDesc(surface3, &ddsd);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(ddsd.ddsCaps.dwCaps == (DDSCAPS_SYSTEMMEMORY | DDSCAPS_OFFSCREENPLAIN),
            "Got unexpected caps %#lx.\n", ddsd.ddsCaps.dwCaps);

    /* Setting the height is allowed, but it cannot be set to 0, and only if LPSURFACE is set too. */
    reset_ddsd(&ddsd);
    ddsd.dwFlags = DDSD_HEIGHT;
    ddsd.dwHeight = 16;
    hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
    ok(hr == DDERR_INVALIDPARAMS, "Got hr %#lx.\n", hr);

    ddsd.lpSurface = data;
    ddsd.dwFlags = DDSD_HEIGHT | DDSD_LPSURFACE;
    hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
    ok(SUCCEEDED(hr), "Failed to set surface desc, hr %#lx.\n", hr);

    ddsd.dwHeight = 0;
    hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
    ok(hr == DDERR_INVALIDPARAMS, "Got hr %#lx.\n", hr);

    reset_ddsd(&ddsd);
    hr = IDirectDrawSurface3_GetSurfaceDesc(surface3, &ddsd);
    ok(SUCCEEDED(hr), "GetSurfaceDesc failed, hr %#lx.\n", hr);
    ok(ddsd.dwWidth == 8, "SetSurfaceDesc: Expected width 8, got %lu.\n", ddsd.dwWidth);
    ok(ddsd.dwHeight == 16, "SetSurfaceDesc: Expected height 16, got %lu.\n", ddsd.dwHeight);

    /* Pitch and width can be set, but only together, and only with LPSURFACE. They must not be 0. */
    reset_ddsd(&ddsd);
    ddsd.dwFlags = DDSD_PITCH;
    ddsd.lPitch = 8 * 4;
    hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
    ok(hr == DDERR_INVALIDPARAMS, "Got hr %#lx.\n", hr);

    ddsd.dwFlags = DDSD_WIDTH;
    ddsd.dwWidth = 16;
    hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
    ok(hr == DDERR_INVALIDPARAMS, "Got hr %#lx.\n", hr);

    ddsd.dwFlags = DDSD_PITCH | DDSD_LPSURFACE;
    ddsd.lpSurface = data;
    hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
    ok(hr == DDERR_INVALIDPARAMS, "Got hr %#lx.\n", hr);

    ddsd.dwFlags = DDSD_WIDTH | DDSD_LPSURFACE;
    hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
    ok(hr == DDERR_INVALIDPARAMS, "Got hr %#lx.\n", hr);

    ddsd.dwFlags = DDSD_WIDTH | DDSD_PITCH | DDSD_LPSURFACE;
    ddsd.lPitch = 16 * 4;
    ddsd.dwWidth = 16;
    hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
    ok(SUCCEEDED(hr), "Failed to set surface desc, hr %#lx.\n", hr);

    reset_ddsd(&ddsd);
    hr = IDirectDrawSurface3_GetSurfaceDesc(surface3, &ddsd);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(ddsd.dwWidth == 16, "SetSurfaceDesc: Expected width 8, got %lu.\n", ddsd.dwWidth);
    ok(ddsd.dwHeight == 16, "SetSurfaceDesc: Expected height 16, got %lu.\n", ddsd.dwHeight);
    ok(ddsd.lPitch == 16 * 4, "SetSurfaceDesc: Expected pitch 64, got %lu.\n", ddsd.lPitch);

    /* The pitch must be 32 bit aligned and > 0, but is not verified for sanity otherwise.
     *
     * VMware rejects those calls, but all real drivers accept it. Mark the VMware behavior broken. */
    ddsd.dwFlags = DDSD_WIDTH | DDSD_PITCH | DDSD_LPSURFACE;
    ddsd.lPitch = 4 * 4;
    ddsd.lpSurface = data;
    hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
    ok(SUCCEEDED(hr) || broken(hr == DDERR_INVALIDPARAMS), "Failed to set surface desc, hr %#lx.\n", hr);

    ddsd.lPitch = 4;
    hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
    ok(SUCCEEDED(hr) || broken(hr == DDERR_INVALIDPARAMS), "Failed to set surface desc, hr %#lx.\n", hr);

    ddsd.lPitch = 16 * 4 + 1;
    hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
    ok(hr == DDERR_INVALIDPARAMS, "Got hr %#lx.\n", hr);

    ddsd.lPitch = 16 * 4 + 3;
    hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
    ok(hr == DDERR_INVALIDPARAMS, "Got hr %#lx.\n", hr);

    ddsd.lPitch = -4;
    hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
    ok(hr == DDERR_INVALIDPARAMS, "Got hr %#lx.\n", hr);

    ddsd.lPitch = 16 * 4;
    hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
    ok(SUCCEEDED(hr), "Failed to set surface desc, hr %#lx.\n", hr);

    reset_ddsd(&ddsd);
    ddsd.dwFlags = DDSD_WIDTH | DDSD_PITCH | DDSD_LPSURFACE;
    ddsd.lPitch = 0;
    ddsd.dwWidth = 16;
    ddsd.lpSurface = data;
    hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
    ok(hr == DDERR_INVALIDPARAMS, "Got hr %#lx.\n", hr);

    ddsd.dwFlags = DDSD_WIDTH | DDSD_PITCH | DDSD_LPSURFACE;
    ddsd.lPitch = 16 * 4;
    ddsd.dwWidth = 0;
    hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
    ok(hr == DDERR_INVALIDPARAMS, "Got hr %#lx.\n", hr);

    /* Setting the pixelformat without LPSURFACE is an error, but with LPSURFACE it works. */
    ddsd.dwFlags = DDSD_PIXELFORMAT;
    ddsd.ddpfPixelFormat.dwSize = sizeof(ddsd.ddpfPixelFormat);
    ddsd.ddpfPixelFormat.dwFlags = DDPF_RGB;
    ddsd.ddpfPixelFormat.dwRGBBitCount = 32;
    ddsd.ddpfPixelFormat.dwRBitMask = 0x00ff0000;
    ddsd.ddpfPixelFormat.dwGBitMask = 0x0000ff00;
    ddsd.ddpfPixelFormat.dwBBitMask = 0x000000ff;
    hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
    ok(hr == DDERR_INVALIDPARAMS, "Got hr %#lx.\n", hr);

    ddsd.dwFlags = DDSD_PIXELFORMAT | DDSD_LPSURFACE;
    hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
    ok(SUCCEEDED(hr), "Failed to set surface desc, hr %#lx.\n", hr);

    /* Can't set color keys. */
    reset_ddsd(&ddsd);
    ddsd.dwFlags = DDSD_CKSRCBLT;
    ddsd.ddckCKSrcBlt.dwColorSpaceLowValue = 0x00ff0000;
    ddsd.ddckCKSrcBlt.dwColorSpaceHighValue = 0x00ff0000;
    hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
    ok(hr == DDERR_INVALIDPARAMS, "Got hr %#lx.\n", hr);

    ddsd.dwFlags = DDSD_CKSRCBLT | DDSD_LPSURFACE;
    ddsd.lpSurface = data;
    hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
    ok(hr == DDERR_INVALIDPARAMS, "Got hr %#lx.\n", hr);

    /* Check that other surface properties are retained. */

    ddsd.ddckCKSrcBlt.dwColorSpaceLowValue = 0x00ff00ff;
    ddsd.ddckCKSrcBlt.dwColorSpaceHighValue = 0x0000ff00;
    hr = IDirectDrawSurface3_SetColorKey(surface3, DDCKEY_SRCBLT, &ddsd.ddckCKSrcBlt);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    reset_ddsd(&ddsd);
    ddsd.dwFlags = DDSD_WIDTH | DDSD_PITCH | DDSD_HEIGHT | DDSD_PIXELFORMAT | DDSD_LPSURFACE;
    ddsd.dwWidth = 8;
    ddsd.lPitch = 8 * 2;
    ddsd.dwHeight = 8;
    ddsd.lpSurface = data;
    ddsd.ddpfPixelFormat.dwSize = sizeof(ddsd.ddpfPixelFormat);
    ddsd.ddpfPixelFormat.dwFlags = DDPF_RGB; /* D3DFMT_R5G6B5 */
    ddsd.ddpfPixelFormat.dwRGBBitCount = 16;
    ddsd.ddpfPixelFormat.dwRBitMask = 0xf800;
    ddsd.ddpfPixelFormat.dwGBitMask = 0x07e0;
    ddsd.ddpfPixelFormat.dwBBitMask = 0x001f;
    hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    memset(&ddsd.ddckCKSrcBlt, 0xcc, sizeof(ddsd.ddckCKSrcBlt));
    hr = IDirectDrawSurface3_GetColorKey(surface3, DDCKEY_SRCBLT, &ddsd.ddckCKSrcBlt);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    ok(ddsd.ddckCKSrcBlt.dwColorSpaceLowValue == 0x00ff00ff,
            "Got low color key value %#lx.\n", ddsd.ddckCKSrcBlt.dwColorSpaceLowValue);

    IDirectDrawSurface3_Release(surface3);

    /* Test mipmap texture. */
    reset_ddsd(&ddsd);
    ddsd.dwFlags = DDSD_WIDTH | DDSD_HEIGHT | DDSD_CAPS | DDSD_MIPMAPCOUNT;
    ddsd.dwWidth = 8;
    ddsd.dwHeight = 8;
    ddsd.dwMipMapCount = 3;
    ddsd.ddsCaps.dwCaps = DDSCAPS_TEXTURE | DDSCAPS_VIDEOMEMORY | DDSCAPS_COMPLEX | DDSCAPS_MIPMAP;
    hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &surface, NULL);
    ok(hr == DD_OK || hr == DDERR_NODIRECTDRAWHW || hr == E_NOINTERFACE, "Got unexpected hr %#lx.\n", hr);

    if (FAILED(hr))
    {
        skip("Mipmaps are not supported.\n");
    }
    else
    {
        hr = IDirectDrawSurface_QueryInterface(surface, &IID_IDirectDrawSurface3, (void **)&surface3);
        ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
        IDirectDrawSurface_Release(surface);

        /* Changing surface desc for mipmap fails even without changing any
         * parameters. */
        hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
        ok(hr == DDERR_INVALIDSURFACETYPE, "Got unexpected hr %#lx.\n", hr);

        reset_ddsd(&ddsd);
        ddsd.dwFlags = DDSD_LPSURFACE;
        ddsd.lpSurface = data;
        hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
        ok(hr == DDERR_INVALIDSURFACETYPE, "Got unexpected hr %#lx.\n", hr);
        IDirectDrawSurface3_Release(surface3);
    }

    reset_ddsd(&ddsd);
    ddsd.dwFlags = DDSD_WIDTH | DDSD_HEIGHT | DDSD_CAPS | DDSD_MIPMAPCOUNT;
    ddsd.dwWidth = 8;
    ddsd.dwHeight = 8;
    ddsd.dwMipMapCount = 3;
    ddsd.lpSurface = data;
    ddsd.ddsCaps.dwCaps = DDSCAPS_TEXTURE | DDSCAPS_SYSTEMMEMORY | DDSCAPS_COMPLEX | DDSCAPS_MIPMAP;

    hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &surface, NULL);
    ok(hr == DD_OK || hr == DDERR_NODIRECTDRAWHW || hr == E_NOINTERFACE, "Got unexpected hr %#lx.\n", hr);

    if (hr == DD_OK)
    {
        static DDSCAPS caps = {DDSCAPS_TEXTURE};
        IDirectDrawSurface3 *surface2;

        hr = IDirectDrawSurface_QueryInterface(surface, &IID_IDirectDrawSurface3, (void **)&surface3);
        ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
        IDirectDrawSurface_Release(surface);

        hr = IDirectDrawSurface3_GetAttachedSurface(surface3, &caps, &surface2);
        ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
        reset_ddsd(&ddsd);
        hr = IDirectDrawSurface3_GetSurfaceDesc(surface2, &ddsd);
        ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
        ok(ddsd.dwWidth == 4, "Got unexpected dwWidth %lu.\n", ddsd.dwWidth);

        reset_ddsd(&ddsd);
        ddsd.dwFlags = DDSD_WIDTH | DDSD_HEIGHT | DDSD_PITCH | DDSD_LPSURFACE;
        ddsd.dwWidth = 16;
        ddsd.dwHeight = 16;
        ddsd.lPitch = 16 * 4;
        ddsd.lpSurface = data;
        hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
        todo_wine ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

        reset_ddsd(&ddsd);
        ddsd.dwFlags = DDSD_WIDTH | DDSD_HEIGHT | DDSD_PITCH | DDSD_LPSURFACE;
        ddsd.dwWidth = 8;
        ddsd.dwHeight = 8;
        ddsd.lPitch = 8 * 4;
        ddsd.lpSurface = data;
        hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
        ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
        if (0)
        {
            /* _Lock causes access violation on Windows. */
            reset_ddsd(&ddsd);
            hr = IDirectDrawSurface3_Lock(surface2, NULL, &ddsd, DDLOCK_WAIT, NULL);
            ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
            IDirectDrawSurface3_Unlock(surface2, NULL);
        }

        if (0)
        {
            /* Causes access violation on Windows. */
            reset_ddsd(&ddsd);
            ddsd.dwFlags = DDSD_WIDTH | DDSD_HEIGHT | DDSD_PITCH | DDSD_LPSURFACE;
            ddsd.dwWidth = 4;
            ddsd.dwHeight = 4;
            ddsd.lPitch = 4 * 4;
            ddsd.lpSurface = data;
            hr = IDirectDrawSurface3_SetSurfaceDesc(surface2, &ddsd, 0);
            ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
        }
        IDirectDrawSurface3_Release(surface2);
        IDirectDrawSurface3_Release(surface3);
    }

    /* Test surface created with DDSD_LPSURFACE. */
    reset_ddsd(&ddsd);
    ddsd.dwFlags = DDSD_WIDTH | DDSD_HEIGHT | DDSD_CAPS | DDSD_LPSURFACE | DDSD_PITCH;
    ddsd.dwWidth = 8;
    ddsd.dwHeight = 8;
    ddsd.lpSurface = data;
    ddsd.lPitch = 8 * 4;
    ddsd.ddsCaps.dwCaps = DDSCAPS_SYSTEMMEMORY | DDSCAPS_OFFSCREENPLAIN;
    hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &surface, NULL);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);

    /* SetSurfaceDesc needs systemmemory surfaces.
     *
     * As a sidenote, fourcc surfaces aren't allowed in sysmem, thus testing DDSD_LINEARSIZE is moot. */
    for (i = 0; i < ARRAY_SIZE(invalid_caps_tests); i++)
    {
        reset_ddsd(&ddsd);
        ddsd.dwFlags = DDSD_CAPS;
        ddsd.ddsCaps.dwCaps = invalid_caps_tests[i].caps;
        if (!(invalid_caps_tests[i].caps & DDSCAPS_PRIMARYSURFACE))
        {
            ddsd.dwFlags |= DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT;
            ddsd.dwWidth = 8;
            ddsd.dwHeight = 8;
            ddsd.ddpfPixelFormat.dwSize = sizeof(ddsd.ddpfPixelFormat);
            ddsd.ddpfPixelFormat.dwFlags = DDPF_RGB;
            ddsd.ddpfPixelFormat.dwRGBBitCount = 32;
            ddsd.ddpfPixelFormat.dwRBitMask = 0x00ff0000;
            ddsd.ddpfPixelFormat.dwGBitMask = 0x0000ff00;
            ddsd.ddpfPixelFormat.dwBBitMask = 0x000000ff;
        }

        hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &surface, NULL);
        ok(hr == DD_OK || hr == DDERR_NODIRECTDRAWHW, "Got unexpected hr %#lx.\n", hr);
        if (FAILED(hr))
        {
            skip("Cannot create a %s surface, skipping vidmem SetSurfaceDesc test.\n",
                    invalid_caps_tests[i].name);
            goto done;
        }
        hr = IDirectDrawSurface_QueryInterface(surface, &IID_IDirectDrawSurface3, (void **)&surface3);
        ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
        IDirectDrawSurface_Release(surface);

        reset_ddsd(&ddsd);
        ddsd.dwFlags = DDSD_LPSURFACE;
        ddsd.lpSurface = data;
        hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
        if (invalid_caps_tests[i].supported)
        {
            ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
        }
        else
        {
            ok(hr == DDERR_INVALIDSURFACETYPE, "SetSurfaceDesc on a %s surface returned %#lx.\n",
                    invalid_caps_tests[i].name, hr);

            /* Check priority of error conditions. */
            ddsd.dwFlags = DDSD_WIDTH;
            hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
            ok(hr == DDERR_INVALIDSURFACETYPE, "SetSurfaceDesc on a %s surface returned %#lx.\n",
                    invalid_caps_tests[i].name, hr);
        }

        IDirectDrawSurface3_Release(surface3);
    }

done:
    ref = IDirectDraw2_Release(ddraw);
    ok(!ref, "Unexpected refcount %lu.\n", ref);
    DestroyWindow(window);
}

static void test_user_memory_getdc(void)
{
    unsigned int data[16][16], x, y;
    IDirectDraw2 *ddraw;
    HWND window;
    HRESULT hr;
    DDSURFACEDESC ddsd;
    IDirectDrawSurface *surface;
    IDirectDrawSurface3 *surface3;
    HBITMAP bitmap;
    DIBSECTION dib;
    ULONG ref;
    int size;
    HDC dc;

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    reset_ddsd(&ddsd);
    ddsd.dwFlags = DDSD_WIDTH | DDSD_HEIGHT | DDSD_CAPS | DDSD_PIXELFORMAT;
    ddsd.dwWidth = 16;
    ddsd.dwHeight = 16;
    ddsd.ddpfPixelFormat.dwSize = sizeof(ddsd.ddpfPixelFormat);
    ddsd.ddpfPixelFormat.dwFlags = DDPF_RGB;
    ddsd.ddpfPixelFormat.dwRGBBitCount = 32;
    ddsd.ddpfPixelFormat.dwRBitMask = 0x00ff0000;
    ddsd.ddpfPixelFormat.dwGBitMask = 0x0000ff00;
    ddsd.ddpfPixelFormat.dwBBitMask = 0x000000ff;
    ddsd.ddsCaps.dwCaps = DDSCAPS_SYSTEMMEMORY | DDSCAPS_OFFSCREENPLAIN;
    hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &surface, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

    hr = IDirectDrawSurface_QueryInterface(surface, &IID_IDirectDrawSurface3, (void **)&surface3);
    ok(SUCCEEDED(hr), "Failed to get IDirectDrawSurface3 interface, hr %#lx.\n", hr);
    IDirectDrawSurface_Release(surface);

    memset(data, 0xaa, sizeof(data));
    reset_ddsd(&ddsd);
    ddsd.dwFlags = DDSD_LPSURFACE;
    ddsd.lpSurface = data;
    hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
    ok(SUCCEEDED(hr), "Failed to set surface desc, hr %#lx.\n", hr);

    hr = IDirectDrawSurface3_GetDC(surface3, &dc);
    ok(SUCCEEDED(hr), "Failed to get DC, hr %#lx.\n", hr);
    bitmap = GetCurrentObject(dc, OBJ_BITMAP);
    ok(!!bitmap, "Failed to get bitmap.\n");
    size = GetObjectA(bitmap, sizeof(dib), &dib);
    ok(size == sizeof(dib), "Got unexpected size %d.\n", size);
    ok(dib.dsBm.bmBits == data, "Got unexpected bits %p, expected %p.\n", dib.dsBm.bmBits, data);
    BitBlt(dc, 0, 0, 16, 8, NULL, 0, 0, WHITENESS);
    BitBlt(dc, 0, 8, 16, 8, NULL, 0, 0, BLACKNESS);
    hr = IDirectDrawSurface3_ReleaseDC(surface3, dc);
    ok(SUCCEEDED(hr), "Failed to release DC, hr %#lx.\n", hr);

    ok(data[0][0] == 0xffffffff, "Expected color 0xffffffff, got %#x.\n", data[0][0]);
    ok(data[15][15] == 0x00000000, "Expected color 0x00000000, got %#x.\n", data[15][15]);

    ddsd.dwFlags = DDSD_LPSURFACE | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PITCH;
    ddsd.lpSurface = data;
    ddsd.dwWidth = 4;
    ddsd.dwHeight = 8;
    ddsd.lPitch = sizeof(*data);
    hr = IDirectDrawSurface3_SetSurfaceDesc(surface3, &ddsd, 0);
    ok(SUCCEEDED(hr), "Failed to set surface desc, hr %#lx.\n", hr);

    memset(data, 0xaa, sizeof(data));
    hr = IDirectDrawSurface3_GetDC(surface3, &dc);
    ok(SUCCEEDED(hr), "Failed to get DC, hr %#lx.\n", hr);
    BitBlt(dc, 0, 0, 4, 8, NULL, 0, 0, BLACKNESS);
    BitBlt(dc, 1, 1, 2, 2, NULL, 0, 0, WHITENESS);
    hr = IDirectDrawSurface3_ReleaseDC(surface3, dc);
    ok(SUCCEEDED(hr), "Failed to release DC, hr %#lx.\n", hr);

    for (y = 0; y < 4; y++)
    {
        for (x = 0; x < 4; x++)
        {
            if ((x == 1 || x == 2) && (y == 1 || y == 2))
                ok(data[y][x] == 0xffffffff, "Expected color 0xffffffff on position %ux%u, got %#x.\n",
                        x, y, data[y][x]);
            else
                ok(data[y][x] == 0x00000000, "Expected color 0xaaaaaaaa on position %ux%u, got %#x.\n",
                        x, y, data[y][x]);
        }
    }
    ok(data[0][5] == 0xaaaaaaaa, "Expected color 0xaaaaaaaa on position 5x0, got %#x.\n",
            data[0][5]);
    ok(data[7][3] == 0x00000000, "Expected color 0x00000000 on position 3x7, got %#x.\n",
            data[7][3]);
    ok(data[7][4] == 0xaaaaaaaa, "Expected color 0xaaaaaaaa on position 4x7, got %#x.\n",
            data[7][4]);
    ok(data[8][0] == 0xaaaaaaaa, "Expected color 0xaaaaaaaa on position 0x8, got %#x.\n",
            data[8][0]);

    IDirectDrawSurface3_Release(surface3);
    ref = IDirectDraw2_Release(ddraw);
    ok(!ref, "Unexpected refcount %lu.\n", ref);
    DestroyWindow(window);
}

static void test_sysmem_overlay(void)
{
    IDirectDraw2 *ddraw;
    HWND window;
    HRESULT hr;
    DDSURFACEDESC ddsd;
    IDirectDrawSurface *surface;
    ULONG ref;

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    reset_ddsd(&ddsd);
    ddsd.dwFlags = DDSD_CAPS | DDSD_PIXELFORMAT | DDSD_WIDTH | DDSD_HEIGHT;
    ddsd.dwWidth = 16;
    ddsd.dwHeight = 16;
    ddsd.ddsCaps.dwCaps = DDSCAPS_SYSTEMMEMORY | DDSCAPS_OVERLAY;
    ddsd.ddpfPixelFormat.dwSize = sizeof(ddsd.ddpfPixelFormat);
    ddsd.ddpfPixelFormat.dwFlags = DDPF_RGB;
    ddsd.ddpfPixelFormat.dwRGBBitCount = 32;
    ddsd.ddpfPixelFormat.dwRBitMask = 0x00ff0000;
    ddsd.ddpfPixelFormat.dwGBitMask = 0x0000ff00;
    ddsd.ddpfPixelFormat.dwBBitMask = 0x000000ff;
    hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &surface, NULL);
    ok(hr == DDERR_NOOVERLAYHW, "Got unexpected hr %#lx.\n", hr);

    ref = IDirectDraw2_Release(ddraw);
    ok(!ref, "Unexpected refcount %lu.\n", ref);
    DestroyWindow(window);
}

static void test_primary_palette(void)
{
    DDSCAPS surface_caps = {DDSCAPS_FLIP};
    IDirectDrawSurface *primary, *backbuffer;
    PALETTEENTRY palette_entries[256];
    IDirectDrawPalette *palette, *tmp;
    DDSURFACEDESC surface_desc;
    IDirectDraw2 *ddraw;
    DWORD palette_caps;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    if (FAILED(IDirectDraw2_SetDisplayMode(ddraw, 640, 480, 8, 0, 0)))
    {
        win_skip("Failed to set 8 bpp display mode, skipping test.\n");
        IDirectDraw2_Release(ddraw);
        DestroyWindow(window);
        return;
    }
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_BACKBUFFERCOUNT;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE | DDSCAPS_COMPLEX | DDSCAPS_FLIP;
    surface_desc.dwBackBufferCount = 1;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &primary, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_GetAttachedSurface(primary, &surface_caps, &backbuffer);
    ok(SUCCEEDED(hr), "Failed to get attached surface, hr %#lx.\n", hr);

    memset(palette_entries, 0, sizeof(palette_entries));
    hr = IDirectDraw2_CreatePalette(ddraw, DDPCAPS_8BIT | DDPCAPS_ALLOW256, palette_entries, &palette, NULL);
    ok(SUCCEEDED(hr), "Failed to create palette, hr %#lx.\n", hr);
    refcount = get_refcount((IUnknown *)palette);
    ok(refcount == 1, "Got unexpected refcount %lu.\n", refcount);

    hr = IDirectDrawPalette_GetCaps(palette, &palette_caps);
    ok(SUCCEEDED(hr), "Failed to get palette caps, hr %#lx.\n", hr);
    ok(palette_caps == (DDPCAPS_8BIT | DDPCAPS_ALLOW256), "Got unexpected palette caps %#lx.\n", palette_caps);

    hr = IDirectDrawSurface_SetPalette(primary, palette);
    ok(SUCCEEDED(hr), "Failed to set palette, hr %#lx.\n", hr);

    /* The Windows 8 testbot attaches the palette to the backbuffer as well,
     * and is generally somewhat broken with respect to 8 bpp / palette
     * handling. */
    if (SUCCEEDED(IDirectDrawSurface_GetPalette(backbuffer, &tmp)))
    {
        win_skip("Broken palette handling detected, skipping tests.\n");
        IDirectDrawPalette_Release(tmp);
        IDirectDrawPalette_Release(palette);
        /* The Windows 8 testbot keeps extra references to the primary and
         * backbuffer while in 8 bpp mode. */
        hr = IDirectDraw2_RestoreDisplayMode(ddraw);
        ok(SUCCEEDED(hr), "Failed to restore display mode, hr %#lx.\n", hr);
        goto done;
    }

    refcount = get_refcount((IUnknown *)palette);
    ok(refcount == 2, "Got unexpected refcount %lu.\n", refcount);

    hr = IDirectDrawPalette_GetCaps(palette, &palette_caps);
    ok(SUCCEEDED(hr), "Failed to get palette caps, hr %#lx.\n", hr);
    ok(palette_caps == (DDPCAPS_8BIT | DDPCAPS_PRIMARYSURFACE | DDPCAPS_ALLOW256),
            "Got unexpected palette caps %#lx.\n", palette_caps);

    hr = IDirectDrawSurface_SetPalette(primary, NULL);
    ok(SUCCEEDED(hr), "Failed to set palette, hr %#lx.\n", hr);
    refcount = get_refcount((IUnknown *)palette);
    ok(refcount == 1, "Got unexpected refcount %lu.\n", refcount);

    hr = IDirectDrawPalette_GetCaps(palette, &palette_caps);
    ok(SUCCEEDED(hr), "Failed to get palette caps, hr %#lx.\n", hr);
    ok(palette_caps == (DDPCAPS_8BIT | DDPCAPS_ALLOW256), "Got unexpected palette caps %#lx.\n", palette_caps);

    hr = IDirectDrawSurface_SetPalette(primary, palette);
    ok(SUCCEEDED(hr), "Failed to set palette, hr %#lx.\n", hr);
    refcount = get_refcount((IUnknown *)palette);
    ok(refcount == 2, "Got unexpected refcount %lu.\n", refcount);

    hr = IDirectDrawSurface_GetPalette(primary, &tmp);
    ok(SUCCEEDED(hr), "Failed to get palette, hr %#lx.\n", hr);
    ok(tmp == palette, "Got unexpected palette %p, expected %p.\n", tmp, palette);
    IDirectDrawPalette_Release(tmp);
    hr = IDirectDrawSurface_GetPalette(backbuffer, &tmp);
    ok(hr == DDERR_NOPALETTEATTACHED, "Got unexpected hr %#lx.\n", hr);

    refcount = IDirectDrawPalette_Release(palette);
    ok(refcount == 1, "Got unexpected refcount %lu.\n", refcount);
    refcount = IDirectDrawPalette_Release(palette);
    ok(!refcount, "Got unexpected refcount %lu.\n", refcount);

    /* Note that this only seems to work when the palette is attached to the
     * primary surface. When attached to a regular surface, attempting to get
     * the palette here will cause an access violation. */
    hr = IDirectDrawSurface_GetPalette(primary, &tmp);
    ok(hr == DDERR_NOPALETTEATTACHED, "Got unexpected hr %#lx.\n", hr);

    hr = IDirectDrawSurface_IsLost(primary);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    hr = IDirectDrawSurface_GetSurfaceDesc(primary, &surface_desc);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(surface_desc.dwWidth == 640, "Got unexpected surface width %lu.\n", surface_desc.dwWidth);
    ok(surface_desc.dwHeight == 480, "Got unexpected surface height %lu.\n", surface_desc.dwHeight);
    ok(surface_desc.ddpfPixelFormat.dwRGBBitCount == 8, "Got unexpected bit count %lu.\n",
            surface_desc.ddpfPixelFormat.dwRGBBitCount);

    hr = set_display_mode(ddraw, 640, 480);
    ok(SUCCEEDED(hr), "Failed to set display mode, hr %#lx.\n", hr);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    hr = IDirectDrawSurface_GetSurfaceDesc(primary, &surface_desc);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(surface_desc.dwWidth == 640, "Got unexpected surface width %lu.\n", surface_desc.dwWidth);
    ok(surface_desc.dwHeight == 480, "Got unexpected surface height %lu.\n", surface_desc.dwHeight);
    ok(surface_desc.ddpfPixelFormat.dwRGBBitCount == 32
            || surface_desc.ddpfPixelFormat.dwRGBBitCount == 24,
            "Got unexpected bit count %lu.\n", surface_desc.ddpfPixelFormat.dwRGBBitCount);

    hr = IDirectDrawSurface_IsLost(primary);
    ok(hr == DDERR_SURFACELOST, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Restore(primary);
    ok(hr == DDERR_WRONGMODE, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(primary);
    ok(hr == DDERR_SURFACELOST, "Got unexpected hr %#lx.\n", hr);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    hr = IDirectDrawSurface_GetSurfaceDesc(primary, &surface_desc);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(surface_desc.dwWidth == 640, "Got unexpected surface width %lu.\n", surface_desc.dwWidth);
    ok(surface_desc.dwHeight == 480, "Got unexpected surface height %lu.\n", surface_desc.dwHeight);
    ok(surface_desc.ddpfPixelFormat.dwRGBBitCount == 32
            || surface_desc.ddpfPixelFormat.dwRGBBitCount == 24,
            "Got unexpected bit count %lu.\n", surface_desc.ddpfPixelFormat.dwRGBBitCount);

done:
    refcount = IDirectDrawSurface_Release(backbuffer);
    ok(refcount == 1, "Got unexpected refcount %lu.\n", refcount);
    refcount = IDirectDrawSurface_Release(primary);
    ok(!refcount, "Got unexpected refcount %lu.\n", refcount);
    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "Got unexpected refcount %lu.\n", refcount);
    DestroyWindow(window);
}

static HRESULT WINAPI surface_counter(IDirectDrawSurface *surface, DDSURFACEDESC *desc, void *context)
{
    UINT *surface_count = context;

    ++(*surface_count);
    IDirectDrawSurface_Release(surface);

    return DDENUMRET_OK;
}

static void test_surface_attachment(void)
{
    IDirectDrawSurface *surface1, *surface2, *surface3, *surface4;
    DDSCAPS caps = {DDSCAPS_TEXTURE};
    DDSURFACEDESC surface_desc;
    IDirectDraw2 *ddraw;
    UINT surface_count;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_MIPMAPCOUNT;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_TEXTURE | DDSCAPS_COMPLEX | DDSCAPS_MIPMAP;
    surface_desc.dwMipMapCount = 3;
    surface_desc.dwWidth = 128;
    surface_desc.dwHeight = 128;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface1, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

    hr = IDirectDrawSurface_GetAttachedSurface(surface1, &caps, &surface2);
    ok(SUCCEEDED(hr), "Failed to get mip level, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_GetAttachedSurface(surface2, &caps, &surface3);
    ok(SUCCEEDED(hr), "Failed to get mip level, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_GetAttachedSurface(surface3, &caps, &surface4);
    ok(hr == DDERR_NOTFOUND, "Got unexpected hr %#lx.\n", hr);

    surface_count = 0;
    IDirectDrawSurface_EnumAttachedSurfaces(surface1, &surface_count, surface_counter);
    ok(surface_count == 1, "Got unexpected surface_count %u.\n", surface_count);
    surface_count = 0;
    IDirectDrawSurface_EnumAttachedSurfaces(surface2, &surface_count, surface_counter);
    ok(surface_count == 1, "Got unexpected surface_count %u.\n", surface_count);
    surface_count = 0;
    IDirectDrawSurface_EnumAttachedSurfaces(surface3, &surface_count, surface_counter);
    ok(!surface_count, "Got unexpected surface_count %u.\n", surface_count);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_TEXTURE;
    surface_desc.dwWidth = 16;
    surface_desc.dwHeight = 16;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface4, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

    hr = IDirectDrawSurface_AddAttachedSurface(surface1, surface4);
    ok(hr == DDERR_CANNOTATTACHSURFACE, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_AddAttachedSurface(surface4, surface1);
    ok(hr == DDERR_CANNOTATTACHSURFACE, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_AddAttachedSurface(surface3, surface4);
    ok(hr == DDERR_CANNOTATTACHSURFACE, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_AddAttachedSurface(surface4, surface3);
    ok(hr == DDERR_CANNOTATTACHSURFACE, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_AddAttachedSurface(surface2, surface4);
    ok(hr == DDERR_CANNOTATTACHSURFACE, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_AddAttachedSurface(surface4, surface2);
    ok(hr == DDERR_CANNOTATTACHSURFACE, "Got unexpected hr %#lx.\n", hr);

    IDirectDrawSurface_Release(surface4);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_SYSTEMMEMORY | DDSCAPS_OFFSCREENPLAIN;
    surface_desc.dwWidth = 16;
    surface_desc.dwHeight = 16;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface4, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

    if (SUCCEEDED(hr = IDirectDrawSurface_AddAttachedSurface(surface1, surface4)))
    {
        skip("Running on refrast, skipping some tests.\n");
        hr = IDirectDrawSurface_DeleteAttachedSurface(surface1, 0, surface4);
        ok(SUCCEEDED(hr), "Failed to detach surface, hr %#lx.\n", hr);
    }
    else
    {
        ok(hr == DDERR_CANNOTATTACHSURFACE, "Got unexpected hr %#lx.\n", hr);
        hr = IDirectDrawSurface_AddAttachedSurface(surface4, surface1);
        ok(hr == DDERR_CANNOTATTACHSURFACE, "Got unexpected hr %#lx.\n", hr);
        hr = IDirectDrawSurface_AddAttachedSurface(surface3, surface4);
        ok(hr == DDERR_CANNOTATTACHSURFACE, "Got unexpected hr %#lx.\n", hr);
        hr = IDirectDrawSurface_AddAttachedSurface(surface4, surface3);
        ok(hr == DDERR_CANNOTATTACHSURFACE, "Got unexpected hr %#lx.\n", hr);
        hr = IDirectDrawSurface_AddAttachedSurface(surface2, surface4);
        ok(hr == DDERR_CANNOTATTACHSURFACE, "Got unexpected hr %#lx.\n", hr);
        hr = IDirectDrawSurface_AddAttachedSurface(surface4, surface2);
        ok(hr == DDERR_CANNOTATTACHSURFACE, "Got unexpected hr %#lx.\n", hr);
    }

    IDirectDrawSurface_Release(surface4);
    IDirectDrawSurface_Release(surface3);
    IDirectDrawSurface_Release(surface2);
    IDirectDrawSurface_Release(surface1);

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    /* Try a single primary and two offscreen plain surfaces. */
    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface1, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN;
    surface_desc.dwWidth = registry_mode.dmPelsWidth;
    surface_desc.dwHeight = registry_mode.dmPelsHeight;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface2, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN;
    surface_desc.dwWidth = registry_mode.dmPelsWidth;
    surface_desc.dwHeight = registry_mode.dmPelsHeight;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface3, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

    /* This one has a different size. */
    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN;
    surface_desc.dwWidth = 128;
    surface_desc.dwHeight = 128;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface4, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

    hr = IDirectDrawSurface_AddAttachedSurface(surface1, surface2);
    ok(SUCCEEDED(hr), "Failed to attach surface, hr %#lx.\n", hr);
    /* Try the reverse without detaching first. */
    hr = IDirectDrawSurface_AddAttachedSurface(surface2, surface1);
    ok(hr == DDERR_SURFACEALREADYATTACHED, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_DeleteAttachedSurface(surface1, 0, surface2);
    ok(SUCCEEDED(hr), "Failed to detach surface, hr %#lx.\n", hr);

    hr = IDirectDrawSurface_AddAttachedSurface(surface2, surface1);
    ok(SUCCEEDED(hr), "Failed to attach surface, hr %#lx.\n", hr);
    /* Try to detach reversed. */
    hr = IDirectDrawSurface_DeleteAttachedSurface(surface1, 0, surface2);
    ok(hr == DDERR_CANNOTDETACHSURFACE, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_DeleteAttachedSurface(surface2, 0, surface1);
    ok(SUCCEEDED(hr), "Failed to detach surface, hr %#lx.\n", hr);

    hr = IDirectDrawSurface_AddAttachedSurface(surface2, surface3);
    ok(SUCCEEDED(hr), "Failed to attach surface, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_DeleteAttachedSurface(surface2, 0, surface3);
    ok(SUCCEEDED(hr), "Failed to detach surface, hr %#lx.\n", hr);

    hr = IDirectDrawSurface_AddAttachedSurface(surface1, surface4);
    ok(hr == DDERR_CANNOTATTACHSURFACE, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_AddAttachedSurface(surface4, surface1);
    ok(hr == DDERR_CANNOTATTACHSURFACE, "Got unexpected hr %#lx.\n", hr);

    IDirectDrawSurface_Release(surface4);
    IDirectDrawSurface_Release(surface3);
    IDirectDrawSurface_Release(surface2);
    IDirectDrawSurface_Release(surface1);

    /* Test depth surfaces of different sizes. */
    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN | DDSCAPS_3DDEVICE;
    surface_desc.dwWidth = 64;
    surface_desc.dwHeight = 64;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface1, NULL);
    ok(hr == D3D_OK, "Failed to create surface, hr %#lx.\n", hr);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_PIXELFORMAT | DDSD_WIDTH | DDSD_HEIGHT;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_ZBUFFER;
    surface_desc.ddpfPixelFormat.dwSize = sizeof(surface_desc.ddpfPixelFormat);
    surface_desc.ddpfPixelFormat.dwFlags = DDPF_ZBUFFER;
    surface_desc.ddpfPixelFormat.dwZBufferBitDepth = 16;
    surface_desc.ddpfPixelFormat.dwZBitMask = 0x0000ffff;
    surface_desc.dwWidth = 32;
    surface_desc.dwHeight = 32;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface2, NULL);
    ok(hr == D3D_OK, "Failed to create surface, hr %#lx.\n", hr);
    surface_desc.dwWidth = 64;
    surface_desc.dwHeight = 64;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface3, NULL);
    ok(hr == D3D_OK, "Failed to create surface, hr %#lx.\n", hr);
    surface_desc.dwWidth = 128;
    surface_desc.dwHeight = 128;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface4, NULL);
    ok(hr == D3D_OK, "Failed to create surface, hr %#lx.\n", hr);

    hr = IDirectDrawSurface_AddAttachedSurface(surface1, surface2);
    todo_wine ok(hr == DDERR_CANNOTATTACHSURFACE, "Got unexpected hr %#lx.\n", hr);
    if (SUCCEEDED(hr))
        IDirectDrawSurface2_DeleteAttachedSurface(surface1, 0, surface2);
    hr = IDirectDrawSurface_AddAttachedSurface(surface1, surface3);
    ok(hr == D3D_OK, "Failed to attach depth buffer, hr %#lx.\n", hr);
    hr = IDirectDrawSurface2_DeleteAttachedSurface(surface1, 0, surface3);
    ok(hr == D3D_OK, "Failed to detach depth buffer, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_AddAttachedSurface(surface1, surface4);
    todo_wine ok(hr == DDERR_CANNOTATTACHSURFACE, "Got unexpected hr %#lx.\n", hr);

    IDirectDrawSurface2_Release(surface4);
    IDirectDrawSurface2_Release(surface3);
    IDirectDrawSurface2_Release(surface2);
    IDirectDrawSurface2_Release(surface1);

    /* Test DeleteAttachedSurface() and automatic detachment of attached surfaces on release. */
    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT;
    surface_desc.dwWidth = 64;
    surface_desc.dwHeight = 64;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN | DDSCAPS_3DDEVICE;
    surface_desc.ddpfPixelFormat.dwSize = sizeof(surface_desc.ddpfPixelFormat);
    surface_desc.ddpfPixelFormat.dwFlags = DDPF_RGB; /* D3DFMT_R5G6B5 */
    surface_desc.ddpfPixelFormat.dwRGBBitCount = 16;
    surface_desc.ddpfPixelFormat.dwRBitMask = 0xf800;
    surface_desc.ddpfPixelFormat.dwGBitMask = 0x07e0;
    surface_desc.ddpfPixelFormat.dwBBitMask = 0x001f;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface1, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface3, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

    surface_desc.ddsCaps.dwCaps = DDSCAPS_ZBUFFER;
    surface_desc.ddpfPixelFormat.dwFlags = DDPF_ZBUFFER;
    surface_desc.ddpfPixelFormat.dwZBufferBitDepth = 16;
    surface_desc.ddpfPixelFormat.dwZBitMask = 0x0000ffff;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface2, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

    hr = IDirectDrawSurface_AddAttachedSurface(surface1, surface2);
    ok(SUCCEEDED(hr), "Failed to attach surface, hr %#lx.\n", hr);
    refcount = get_refcount((IUnknown *)surface2);
    ok(refcount == 2, "Got unexpected refcount %lu.\n", refcount);
    hr = IDirectDrawSurface_AddAttachedSurface(surface1, surface2);
    ok(hr == DDERR_SURFACEALREADYATTACHED, "Got unexpected hr %#lx.\n", hr);

    /* Attaching while already attached to other surface. */
    hr = IDirectDrawSurface_AddAttachedSurface(surface3, surface2);
    todo_wine ok(SUCCEEDED(hr), "Failed to attach surface, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_DeleteAttachedSurface(surface3, 0, surface2);
    todo_wine ok(SUCCEEDED(hr), "Failed to detach surface, hr %#lx.\n", hr);
    IDirectDrawSurface_Release(surface3);

    hr = IDirectDrawSurface_DeleteAttachedSurface(surface1, 0, surface2);
    ok(SUCCEEDED(hr), "Failed to detach surface, hr %#lx.\n", hr);
    refcount = get_refcount((IUnknown *)surface2);
    ok(refcount == 1, "Got unexpected refcount %lu.\n", refcount);

    /* Automatic detachment on release. */
    hr = IDirectDrawSurface_AddAttachedSurface(surface1, surface2);
    ok(SUCCEEDED(hr), "Failed to attach surface, hr %#lx.\n", hr);
    refcount = get_refcount((IUnknown *)surface2);
    ok(refcount == 2, "Got unexpected refcount %lu.\n", refcount);
    refcount = IDirectDrawSurface_Release(surface1);
    ok(!refcount, "Got unexpected refcount %lu.\n", refcount);
    refcount = IDirectDrawSurface_Release(surface2);
    ok(!refcount, "Got unexpected refcount %lu.\n", refcount);
    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "Got unexpected refcount %lu.\n", refcount);
    DestroyWindow(window);
}

static void test_pixel_format(void)
{
    HWND window, window2, window3;
    HMODULE gl = NULL;
    int format, test_format;
    PIXELFORMATDESCRIPTOR pfd;
    IDirectDraw2 *ddraw = NULL;
    IDirectDrawClipper *clipper = NULL;
    HDC hdc, hdc2, hdc3;
    DDSURFACEDESC ddsd;
    IDirectDrawSurface *primary = NULL, *offscreen;
    ULONG refcount;
    DDBLTFX fx;
    HRESULT hr;
    BOOL ret;

    window = create_window();
    ok(!!window, "Failed to create window.\n");
    window2 = create_window();
    ok(!!window2, "Failed to create window.\n");

    hdc = GetDC(window);
    ok(!!hdc, "Failed to get DC.\n");
    hdc2 = GetDC(window2);
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

    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");

    test_format = GetPixelFormat(hdc);
    ok(test_format == format, "window has pixel format %d, expected %d\n", test_format, format);

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    test_format = GetPixelFormat(hdc);
    ok(test_format == format, "window has pixel format %d, expected %d\n", test_format, format);

    hr = IDirectDraw2_CreateClipper(ddraw, 0, &clipper, NULL);
    ok(SUCCEEDED(hr), "Failed to create clipper, hr %#lx.\n", hr);
    hr = IDirectDrawClipper_SetHWnd(clipper, 0, window2);
    ok(SUCCEEDED(hr), "Failed to set clipper window, hr %#lx.\n", hr);

    test_format = GetPixelFormat(hdc);
    ok(test_format == format, "window has pixel format %d, expected %d\n", test_format, format);
    test_format = GetPixelFormat(hdc2);
    ok(test_format == format, "second window has pixel format %d, expected %d\n", test_format, format);

    memset(&ddsd, 0, sizeof(ddsd));
    ddsd.dwSize = sizeof(ddsd);
    ddsd.dwFlags = DDSD_CAPS;
    ddsd.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE;

    hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &primary, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n",hr);

    test_format = GetPixelFormat(hdc);
    ok(test_format == format, "window has pixel format %d, expected %d\n", test_format, format);
    test_format = GetPixelFormat(hdc2);
    ok(test_format == format, "second window has pixel format %d, expected %d\n", test_format, format);

    hr = IDirectDrawSurface_SetClipper(primary, clipper);
    ok(SUCCEEDED(hr), "Failed to set clipper, hr %#lx.\n", hr);

    test_format = GetPixelFormat(hdc);
    ok(test_format == format, "window has pixel format %d, expected %d\n", test_format, format);
    test_format = GetPixelFormat(hdc2);
    ok(test_format == format, "second window has pixel format %d, expected %d\n", test_format, format);

    memset(&ddsd, 0, sizeof(ddsd));
    ddsd.dwSize = sizeof(ddsd);
    ddsd.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT;
    ddsd.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN;
    ddsd.dwWidth = ddsd.dwHeight = 64;
    hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &offscreen, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n",hr);

    memset(&fx, 0, sizeof(fx));
    fx.dwSize = sizeof(fx);
    hr = IDirectDrawSurface_Blt(offscreen, NULL, NULL, NULL, DDBLT_WAIT | DDBLT_COLORFILL, &fx);
    ok(SUCCEEDED(hr), "Failed to clear source surface, hr %#lx.\n", hr);

    test_format = GetPixelFormat(hdc);
    ok(test_format == format, "window has pixel format %d, expected %d\n", test_format, format);

    hr = IDirectDrawSurface_Blt(primary, NULL, offscreen, NULL, DDBLT_WAIT, NULL);
    ok(SUCCEEDED(hr), "Failed to blit to primary surface, hr %#lx.\n", hr);

    test_format = GetPixelFormat(hdc);
    ok(test_format == format, "window has pixel format %d, expected %d\n", test_format, format);
    test_format = GetPixelFormat(hdc2);
    ok(test_format == format, "second window has pixel format %d, expected %d\n", test_format, format);

    IDirectDrawSurface_Release(offscreen);
    IDirectDrawSurface_Release(primary);
    refcount = IDirectDrawClipper_Release(clipper);
    ok(!refcount, "Got unexpected refcount %lu.\n", refcount);
    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "Got unexpected refcount %lu.\n", refcount);

    /* Test that creating a device doesn't set a pixel format on a window which
     * never had one. */

    window3 = create_window();
    hdc3 = GetDC(window3);

    test_format = GetPixelFormat(hdc3);
    ok(!test_format, "Expected no format, got %d.\n", test_format);

    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window3, DDSCL_NORMAL);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    test_format = GetPixelFormat(hdc3);
    ok(!test_format, "Expected no format, got %d.\n", test_format);

    memset(&ddsd, 0, sizeof(ddsd));
    ddsd.dwSize = sizeof(ddsd);
    ddsd.dwFlags = DDSD_CAPS;
    ddsd.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE;
    hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &primary, NULL);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    memset(&ddsd, 0, sizeof(ddsd));
    ddsd.dwSize = sizeof(ddsd);
    ddsd.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT;
    ddsd.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN;
    ddsd.dwWidth = ddsd.dwHeight = 64;
    hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &offscreen, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n",hr);

    memset(&fx, 0, sizeof(fx));
    fx.dwSize = sizeof(fx);
    hr = IDirectDrawSurface_Blt(offscreen, NULL, NULL, NULL, DDBLT_WAIT | DDBLT_COLORFILL, &fx);
    ok(SUCCEEDED(hr), "Failed to clear source surface, hr %#lx.\n", hr);

    hr = IDirectDrawSurface_Blt(primary, NULL, offscreen, NULL, DDBLT_WAIT, NULL);
    ok(SUCCEEDED(hr), "Failed to blit to primary surface, hr %#lx.\n", hr);

    test_format = GetPixelFormat(hdc3);
    ok(!test_format, "Expected no format, got %d.\n", test_format);

    IDirectDrawSurface_Release(offscreen);
    IDirectDrawSurface_Release(primary);
    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "Got unexpected refcount %lu.\n", refcount);

    test_format = GetPixelFormat(hdc3);
    ok(!test_format, "Expected no format, got %d.\n", test_format);

    ret = SetPixelFormat(hdc3, format, &pfd);
    ok(ret, "Failed to set pixel format %d.\n", format);

    test_format = GetPixelFormat(hdc3);
    ok(test_format == format, "Expected pixel format %d, got %d.\n", format, test_format);

    ReleaseDC(window3, hdc3);
    DestroyWindow(window3);

cleanup:
    FreeLibrary(gl);
    ReleaseDC(window2, hdc2);
    ReleaseDC(window, hdc);
    DestroyWindow(window2);
    DestroyWindow(window);
}

static void test_create_surface_pitch(void)
{
    DWORD vidmem_total = 0, vidmem_free = 0, vidmem_free2 = 0;
    DDSCAPS vidmem_caps = {DDSCAPS_TEXTURE};
    IDirectDrawSurface * surface, *primary;
    DDSURFACEDESC surface_desc;
    IDirectDraw2 *ddraw;
    unsigned int i;
    ULONG refcount;
    HWND window;
    HRESULT hr;
    void *mem;

    static const struct
    {
        DWORD caps;
        DWORD flags_in;
        DWORD pitch_in;
        HRESULT hr;
        DWORD flags_out;
        DWORD pitch_out32;
        DWORD pitch_out64;
    }
    test_data[] =
    {
        /* 0 */
        {DDSCAPS_VIDEOMEMORY | DDSCAPS_OFFSCREENPLAIN,
                0,                              0,      DD_OK,
                DDSD_PITCH,                     0x100,  0x100},
        {DDSCAPS_VIDEOMEMORY | DDSCAPS_OFFSCREENPLAIN,
                DDSD_PITCH,                     0x104,  DD_OK,
                DDSD_PITCH,                     0x100,  0x100},
        {DDSCAPS_VIDEOMEMORY | DDSCAPS_OFFSCREENPLAIN,
                DDSD_PITCH,                     0x0f8,  DD_OK,
                DDSD_PITCH,                     0x100,  0x100},
        {DDSCAPS_VIDEOMEMORY | DDSCAPS_OFFSCREENPLAIN,
                DDSD_LPSURFACE | DDSD_PITCH,    0x100,  DDERR_INVALIDCAPS,
                0,                              0,      0    },
        {DDSCAPS_SYSTEMMEMORY | DDSCAPS_OFFSCREENPLAIN,
                0,                              0,      DD_OK,
                DDSD_PITCH,                     0x100,  0x0fc},
        /* 5 */
        {DDSCAPS_SYSTEMMEMORY | DDSCAPS_OFFSCREENPLAIN,
                DDSD_PITCH,                     0x104,  DD_OK,
                DDSD_PITCH,                     0x100,  0x0fc},
        {DDSCAPS_SYSTEMMEMORY | DDSCAPS_OFFSCREENPLAIN,
                DDSD_PITCH,                     0x0f8,  DD_OK,
                DDSD_PITCH,                     0x100,  0x0fc},
        {DDSCAPS_SYSTEMMEMORY | DDSCAPS_OFFSCREENPLAIN,
                DDSD_PITCH | DDSD_LINEARSIZE,   0,      DD_OK,
                DDSD_PITCH,                     0x100,  0x0fc},
        {DDSCAPS_SYSTEMMEMORY | DDSCAPS_OFFSCREENPLAIN,
                DDSD_LPSURFACE,                 0,      DDERR_INVALIDPARAMS,
                0,                              0,      0    },
        {DDSCAPS_SYSTEMMEMORY | DDSCAPS_OFFSCREENPLAIN,
                DDSD_LPSURFACE | DDSD_PITCH,    0x100,  DDERR_INVALIDPARAMS,
                0,                              0,      0    },
        /* 10 */
        {DDSCAPS_VIDEOMEMORY | DDSCAPS_OFFSCREENPLAIN | DDSCAPS_ALLOCONLOAD,
                0,                              0,      DDERR_INVALIDCAPS,
                0,                              0,      0    },
        {DDSCAPS_VIDEOMEMORY | DDSCAPS_TEXTURE | DDSCAPS_ALLOCONLOAD,
                0,                              0,      DD_OK,
                DDSD_PITCH,                     0x100,  0    },
        {DDSCAPS_VIDEOMEMORY | DDSCAPS_TEXTURE,
                0,                              0,      DD_OK,
                DDSD_PITCH,                     0x100,  0    },
        {DDSCAPS_VIDEOMEMORY | DDSCAPS_TEXTURE | DDSCAPS_ALLOCONLOAD,
                DDSD_LPSURFACE | DDSD_PITCH,    0x100,  DDERR_INVALIDCAPS,
                0,                              0,      0    },
        {DDSCAPS_SYSTEMMEMORY | DDSCAPS_OFFSCREENPLAIN | DDSCAPS_ALLOCONLOAD,
                0,                              0,      DDERR_INVALIDCAPS,
                0,                              0,      0    },
        /* 15 */
        {DDSCAPS_SYSTEMMEMORY | DDSCAPS_TEXTURE | DDSCAPS_ALLOCONLOAD,
                0,                              0,      DD_OK,
                DDSD_PITCH,                     0x100,  0    },
        {DDSCAPS_SYSTEMMEMORY | DDSCAPS_TEXTURE | DDSCAPS_ALLOCONLOAD,
                DDSD_LPSURFACE | DDSD_PITCH,    0x100,  DDERR_INVALIDPARAMS,
                0,                              0,      0    },
        {DDSCAPS_SYSTEMMEMORY | DDSCAPS_OFFSCREENPLAIN | DDSCAPS_3DDEVICE,
                0,                              0,      DD_OK,
                DDSD_PITCH,                     0x100,  0x0fc},
        {DDSCAPS_VIDEOMEMORY | DDSCAPS_OFFSCREENPLAIN | DDSCAPS_3DDEVICE,
                0,                              0,      DD_OK,
                DDSD_PITCH,                     0x100,  0x100},
    };
    DWORD flags_mask = DDSD_PITCH | DDSD_LPSURFACE | DDSD_LINEARSIZE;

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_FULLSCREEN | DDSCL_EXCLUSIVE);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    mem = calloc((63 * 4) + 8, 63);

    /* We need a primary surface and exclusive mode for video memory accounting to work
     * right on Windows. Otherwise it gives us junk data, like creating a video memory
     * surface freeing up memory. */
    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &primary, NULL);
    ok(SUCCEEDED(hr), "Failed to create a primary surface, hr %#lx.\n", hr);

    hr = IDirectDraw2_GetAvailableVidMem(ddraw, &vidmem_caps, &vidmem_total, &vidmem_free);
    ok(SUCCEEDED(hr) || hr == DDERR_NODIRECTDRAWHW,
            "Failed to get available video memory, hr %#lx.\n", hr);

    for (i = 0; i < ARRAY_SIZE(test_data); ++i)
    {
        memset(&surface_desc, 0, sizeof(surface_desc));
        surface_desc.dwSize = sizeof(surface_desc);
        surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT | test_data[i].flags_in;
        surface_desc.ddsCaps.dwCaps = test_data[i].caps;
        surface_desc.dwWidth = 63;
        surface_desc.dwHeight = 63;
        surface_desc.lPitch = test_data[i].pitch_in;
        surface_desc.ddpfPixelFormat.dwSize = sizeof(surface_desc.ddpfPixelFormat);
        surface_desc.ddpfPixelFormat.dwFlags = DDPF_RGB;
        surface_desc.ddpfPixelFormat.dwRGBBitCount = 32;
        surface_desc.ddpfPixelFormat.dwRBitMask = 0x00ff0000;
        surface_desc.ddpfPixelFormat.dwGBitMask = 0x0000ff00;
        surface_desc.ddpfPixelFormat.dwBBitMask = 0x000000ff;
        hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
        if (test_data[i].flags_in & DDSD_LPSURFACE)
        {
            HRESULT expected_hr = SUCCEEDED(test_data[i].hr) ? DDERR_INVALIDPARAMS : test_data[i].hr;
            ok(hr == expected_hr, "Test %u: Got unexpected hr %#lx, expected %#lx.\n", i, hr, expected_hr);
            surface_desc.lpSurface = mem;
            hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
        }
        if ((test_data[i].caps & DDSCAPS_VIDEOMEMORY) && hr == DDERR_NODIRECTDRAWHW)
            continue;
        ok(hr == test_data[i].hr, "Test %u: Got unexpected hr %#lx, expected %#lx.\n", i, hr, test_data[i].hr);
        if (FAILED(hr))
            continue;

        memset(&surface_desc, 0, sizeof(surface_desc));
        surface_desc.dwSize = sizeof(surface_desc);
        hr = IDirectDrawSurface_GetSurfaceDesc(surface, &surface_desc);
        ok(SUCCEEDED(hr), "Test %u: Failed to get surface desc, hr %#lx.\n", i, hr);
        ok((surface_desc.dwFlags & flags_mask) == test_data[i].flags_out,
                "Test %u: Got unexpected flags %#lx, expected %#lx.\n",
                i, surface_desc.dwFlags & flags_mask, test_data[i].flags_out);
        /* The pitch for textures seems to be implementation specific. */
        if (!(test_data[i].caps & DDSCAPS_TEXTURE))
        {
            if (is_ddraw64 && test_data[i].pitch_out32 != test_data[i].pitch_out64)
                todo_wine ok(surface_desc.lPitch == test_data[i].pitch_out64,
                        "Test %u: Got unexpected pitch %#lx, expected %#lx.\n",
                        i, surface_desc.lPitch, test_data[i].pitch_out64);
            else
                ok(surface_desc.lPitch == test_data[i].pitch_out32,
                        "Test %u: Got unexpected pitch %#lx, expected %#lx.\n",
                        i, surface_desc.lPitch, test_data[i].pitch_out32);
        }
        ok(!surface_desc.lpSurface, "Test %u: Got unexpected lpSurface %p.\n", i, surface_desc.lpSurface);

        hr = IDirectDraw2_GetAvailableVidMem(ddraw, &vidmem_caps, &vidmem_total, &vidmem_free2);
        ok(SUCCEEDED(hr) || hr == DDERR_NODIRECTDRAWHW,
                "Failed to get available video memory, hr %#lx.\n", hr);
        if (SUCCEEDED(hr) && surface_desc.ddsCaps.dwCaps & DDSCAPS_SYSTEMMEMORY)
        {
            /* Star Trek Starfleet Academy cares about this bit here: That creating a system memory
             * resource does not influence available video memory. */
            ok(vidmem_free2 == vidmem_free, "Free video memory changed from %#lx to %#lx, test %u.\n",
                    vidmem_free, vidmem_free2, i);
        }
        else if (SUCCEEDED(hr) && surface_desc.ddsCaps.dwCaps & DDSCAPS_VIDEOMEMORY)
        {
            /* DDSCAPS_ALLOCONLOAD does not seem to delay video memory allocation, at least not on
             * modern Windows.
             *
             * The amount of video memory consumed is different from what dwHeight * lPitch would
             * suggest, although not by much. */
            ok(vidmem_free2 < vidmem_free,
                    "Expected free video memory to change, but it did not, test %u.\n", i);
        }

        IDirectDrawSurface_Release(surface);

        hr = IDirectDraw2_GetAvailableVidMem(ddraw, &vidmem_caps, &vidmem_total, &vidmem_free2);
        ok(SUCCEEDED(hr) || hr == DDERR_NODIRECTDRAWHW,
                "Failed to get available video memory, hr %#lx.\n", hr);
        ok(hr == DDERR_NODIRECTDRAWHW || vidmem_free2 == vidmem_free,
                "Free video memory changed from %#lx to %#lx, test %u.\n",
                vidmem_free, vidmem_free2, i);
    }

    IDirectDrawSurface_Release(primary);
    free(mem);
    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "Got unexpected refcount %lu.\n", refcount);
    DestroyWindow(window);
}

static void test_mipmap(void)
{
    IDirectDrawSurface *surface1;
    IDirectDrawSurface2 *surface, *surface_base, *surface_mip;
    unsigned int i, mipmap_count;
    DDSURFACEDESC surface_desc;
    IDirectDraw2 *ddraw;
    ULONG refcount;
    HWND window;
    HRESULT hr;
    DDSCAPS caps = {DDSCAPS_COMPLEX};
    DDCAPS hal_caps;

    static const struct
    {
        DWORD flags;
        DWORD caps;
        DWORD width;
        DWORD height;
        DWORD mipmap_count_in;
        HRESULT hr;
        DWORD mipmap_count_out;
    }
    tests[] =
    {
        {0,                DDSCAPS_MIPMAP,                                     128, 32, 0, DDERR_INVALIDCAPS},
        {0,                DDSCAPS_COMPLEX,                                    128, 32, 0, DDERR_INVALIDCAPS},
        {0,                DDSCAPS_MIPMAP | DDSCAPS_COMPLEX,                   128, 32, 0, DDERR_INVALIDCAPS},
        {0,                DDSCAPS_TEXTURE | DDSCAPS_MIPMAP,                   128, 32, 0, DD_OK,               1},
        {0,                DDSCAPS_TEXTURE | DDSCAPS_COMPLEX,                  128, 32, 0, DDERR_INVALIDCAPS},
        {0,                DDSCAPS_TEXTURE | DDSCAPS_COMPLEX | DDSCAPS_MIPMAP, 128, 32, 0, DD_OK,               6},
        {0,                DDSCAPS_TEXTURE | DDSCAPS_COMPLEX | DDSCAPS_MIPMAP, 32,  64, 0, DD_OK,               6},

        {DDSD_MIPMAPCOUNT, DDSCAPS_TEXTURE | DDSCAPS_MIPMAP,                   128, 32, 1, DDERR_INVALIDCAPS},
        {DDSD_MIPMAPCOUNT, DDSCAPS_TEXTURE | DDSCAPS_MIPMAP,                   128, 32, 3, DDERR_INVALIDCAPS},
        {DDSD_MIPMAPCOUNT, DDSCAPS_TEXTURE | DDSCAPS_COMPLEX | DDSCAPS_MIPMAP, 128, 32, 3, DD_OK,               3},
        {DDSD_MIPMAPCOUNT, DDSCAPS_TEXTURE | DDSCAPS_COMPLEX | DDSCAPS_MIPMAP, 128, 32, 0, DDERR_INVALIDPARAMS},
    };

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    memset(&hal_caps, 0, sizeof(hal_caps));
    hal_caps.dwSize = sizeof(hal_caps);
    hr = IDirectDraw2_GetCaps(ddraw, &hal_caps, NULL);
    ok(SUCCEEDED(hr), "Failed to get caps, hr %#lx.\n", hr);
    if ((hal_caps.ddsCaps.dwCaps & (DDSCAPS_TEXTURE | DDSCAPS_MIPMAP)) != (DDSCAPS_TEXTURE | DDSCAPS_MIPMAP))
    {
        skip("Mipmapped textures not supported, skipping tests.\n");
        IDirectDraw2_Release(ddraw);
        DestroyWindow(window);
        return;
    }

    for (i = 0; i < ARRAY_SIZE(tests); ++i)
    {
        memset(&surface_desc, 0, sizeof(surface_desc));
        surface_desc.dwSize = sizeof(surface_desc);
        surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | tests[i].flags;
        surface_desc.ddsCaps.dwCaps = tests[i].caps;
        surface_desc.dwWidth = tests[i].width;
        surface_desc.dwHeight = tests[i].height;
        if (tests[i].flags & DDSD_MIPMAPCOUNT)
            surface_desc.dwMipMapCount = tests[i].mipmap_count_in;
        hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface1, NULL);
        ok(hr == tests[i].hr, "Test %u: Got unexpected hr %#lx.\n", i, hr);
        if (FAILED(hr))
            continue;

        hr = IDirectDrawSurface_QueryInterface(surface1, &IID_IDirectDrawSurface2, (void **)&surface);
        ok(SUCCEEDED(hr), "Test %u: Failed to get IDirectDrawSurface2 interface, hr %#lx.\n", i, hr);
        IDirectDrawSurface_Release(surface1);

        memset(&surface_desc, 0, sizeof(surface_desc));
        surface_desc.dwSize = sizeof(surface_desc);
        hr = IDirectDrawSurface2_GetSurfaceDesc(surface, &surface_desc);
        ok(SUCCEEDED(hr), "Test %u: Failed to get surface desc, hr %#lx.\n", i, hr);
        ok(surface_desc.dwFlags & DDSD_MIPMAPCOUNT,
                "Test %u: Got unexpected flags %#lx.\n", i, surface_desc.dwFlags);
        ok(surface_desc.dwMipMapCount == tests[i].mipmap_count_out,
                "Test %u: Got unexpected mipmap count %lu.\n", i, surface_desc.dwMipMapCount);

        surface_base = surface;
        IDirectDrawSurface2_AddRef(surface_base);
        mipmap_count = surface_desc.dwMipMapCount;
        while (mipmap_count > 1)
        {
            hr = IDirectDrawSurface2_GetAttachedSurface(surface_base, &caps, &surface_mip);
            ok(SUCCEEDED(hr), "Test %u, %u: Failed to get attached surface, hr %#lx.\n", i, mipmap_count, hr);

            memset(&surface_desc, 0, sizeof(surface_desc));
            surface_desc.dwSize = sizeof(surface_desc);
            hr = IDirectDrawSurface2_GetSurfaceDesc(surface_base, &surface_desc);
            ok(SUCCEEDED(hr), "Test %u, %u: Failed to get surface desc, hr %#lx.\n", i, mipmap_count, hr);
            ok(surface_desc.dwFlags & DDSD_MIPMAPCOUNT,
                    "Test %u, %u: Got unexpected flags %#lx.\n", i, mipmap_count, surface_desc.dwFlags);
            ok(surface_desc.dwMipMapCount == mipmap_count,
                    "Test %u, %u: Got unexpected mipmap count %lu.\n",
                    i, mipmap_count, surface_desc.dwMipMapCount);

            memset(&surface_desc, 0, sizeof(surface_desc));
            surface_desc.dwSize = sizeof(surface_desc);
            hr = IDirectDrawSurface2_Lock(surface_base, NULL, &surface_desc, 0, NULL);
            ok(SUCCEEDED(hr), "Test %u, %u: Failed to lock surface, hr %#lx.\n", i, mipmap_count, hr);
            ok(surface_desc.dwMipMapCount == mipmap_count,
                    "Test %u, %u: unexpected change of mipmap count %lu.\n",
                    i, mipmap_count, surface_desc.dwMipMapCount);
            memset(&surface_desc, 0, sizeof(surface_desc));
            surface_desc.dwSize = sizeof(surface_desc);
            hr = IDirectDrawSurface2_Lock(surface_mip, NULL, &surface_desc, 0, NULL);
            ok(SUCCEEDED(hr), "Test %u, %u: Failed to lock surface, hr %#lx.\n", i, mipmap_count, hr);
            ok(surface_desc.dwMipMapCount == mipmap_count - 1,
                    "Test %u, %u: Got unexpected child mipmap count %lu.\n", i, mipmap_count, surface_desc.dwMipMapCount);
            IDirectDrawSurface2_Unlock(surface_mip, NULL);
            IDirectDrawSurface2_Unlock(surface_base, NULL);

            IDirectDrawSurface2_Release(surface_base);
            surface_base = surface_mip;
            --mipmap_count;
        }
        IDirectDrawSurface2_Release(surface_base);

        IDirectDrawSurface2_Release(surface);
    }

    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "Got unexpected refcount %lu.\n", refcount);
    DestroyWindow(window);
}

static void test_palette_complex(void)
{
    IDirectDrawSurface *surface1;
    IDirectDrawSurface2 *surface, *mipmap, *tmp;
    DDSURFACEDESC surface_desc;
    IDirectDraw2 *ddraw;
    IDirectDrawPalette *palette, *palette2, *palette_mipmap;
    ULONG refcount;
    HWND window;
    HRESULT hr;
    DDSCAPS caps = {DDSCAPS_COMPLEX};
    DDCAPS hal_caps;
    PALETTEENTRY palette_entries[256];
    unsigned int i;
    HDC dc;
    RGBQUAD rgbquad;
    UINT count;

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    memset(&hal_caps, 0, sizeof(hal_caps));
    hal_caps.dwSize = sizeof(hal_caps);
    hr = IDirectDraw2_GetCaps(ddraw, &hal_caps, NULL);
    ok(SUCCEEDED(hr), "Failed to get caps, hr %#lx.\n", hr);
    if ((hal_caps.ddsCaps.dwCaps & (DDSCAPS_TEXTURE | DDSCAPS_MIPMAP)) != (DDSCAPS_TEXTURE | DDSCAPS_MIPMAP))
    {
        skip("Mipmapped textures not supported, skipping mipmap palette test.\n");
        IDirectDraw2_Release(ddraw);
        DestroyWindow(window);
        return;
    }

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT;
    surface_desc.dwWidth = 128;
    surface_desc.dwHeight = 128;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_TEXTURE | DDSCAPS_COMPLEX | DDSCAPS_MIPMAP;
    surface_desc.ddpfPixelFormat.dwSize = sizeof(surface_desc.ddpfPixelFormat);
    surface_desc.ddpfPixelFormat.dwFlags = DDPF_PALETTEINDEXED8 | DDPF_RGB;
    surface_desc.ddpfPixelFormat.dwRGBBitCount = 8;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface1, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_QueryInterface(surface1, &IID_IDirectDrawSurface2, (void **)&surface);
    ok(SUCCEEDED(hr), "Failed to get IDirectDrawSurface2 interface, hr %#lx.\n", hr);
    IDirectDrawSurface_Release(surface1);

    memset(palette_entries, 0, sizeof(palette_entries));
    hr = IDirectDraw2_CreatePalette(ddraw, DDPCAPS_8BIT | DDPCAPS_ALLOW256,
            palette_entries, &palette, NULL);
    ok(SUCCEEDED(hr), "Failed to create palette, hr %#lx.\n", hr);

    memset(palette_entries, 0, sizeof(palette_entries));
    palette_entries[1].peRed = 0xff;
    palette_entries[1].peGreen = 0x80;
    hr = IDirectDraw2_CreatePalette(ddraw, DDPCAPS_8BIT | DDPCAPS_ALLOW256,
            palette_entries, &palette_mipmap, NULL);
    ok(SUCCEEDED(hr), "Failed to create palette, hr %#lx.\n", hr);

    palette2 = (void *)0xdeadbeef;
    hr = IDirectDrawSurface2_GetPalette(surface, &palette2);
    ok(hr == DDERR_NOPALETTEATTACHED, "Got unexpected hr %#lx.\n", hr);
    ok(!palette2, "Got unexpected palette %p.\n", palette2);
    hr = IDirectDrawSurface2_SetPalette(surface, palette);
    ok(SUCCEEDED(hr), "Failed to set palette, hr %#lx.\n", hr);
    hr = IDirectDrawSurface2_GetPalette(surface, &palette2);
    ok(SUCCEEDED(hr), "Failed to get palette, hr %#lx.\n", hr);
    ok(palette == palette2, "Got unexpected palette %p.\n", palette2);
    IDirectDrawPalette_Release(palette2);

    mipmap = surface;
    IDirectDrawSurface2_AddRef(mipmap);
    for (i = 0; i < 7; ++i)
    {
        hr = IDirectDrawSurface2_GetAttachedSurface(mipmap, &caps, &tmp);
        ok(SUCCEEDED(hr), "Failed to get attached surface, i %u, hr %#lx.\n", i, hr);
        palette2 = (void *)0xdeadbeef;
        hr = IDirectDrawSurface2_GetPalette(tmp, &palette2);
        ok(hr == DDERR_NOPALETTEATTACHED, "Got unexpected hr %#lx, i %u.\n", hr, i);
        ok(!palette2, "Got unexpected palette %p, i %u.\n", palette2, i);

        hr = IDirectDrawSurface2_SetPalette(tmp, palette_mipmap);
        ok(SUCCEEDED(hr), "Failed to set palette, i %u, hr %#lx.\n", i, hr);

        hr = IDirectDrawSurface2_GetPalette(tmp, &palette2);
        ok(SUCCEEDED(hr), "Failed to get palette, i %u, hr %#lx.\n", i, hr);
        ok(palette_mipmap == palette2, "Got unexpected palette %p.\n", palette2);
        IDirectDrawPalette_Release(palette2);

        hr = IDirectDrawSurface2_GetDC(tmp, &dc);
        ok(SUCCEEDED(hr), "Failed to get DC, i %u, hr %#lx.\n", i, hr);
        count = GetDIBColorTable(dc, 1, 1, &rgbquad);
        ok(count == 1, "Expected count 1, got %u.\n", count);
        ok(rgbquad.rgbRed == 0xff, "Expected rgbRed = 0xff, got %#x.\n", rgbquad.rgbRed);
        ok(rgbquad.rgbGreen == 0x80, "Expected rgbGreen = 0x80, got %#x.\n", rgbquad.rgbGreen);
        ok(rgbquad.rgbBlue == 0x0, "Expected rgbBlue = 0x0, got %#x.\n", rgbquad.rgbBlue);
        hr = IDirectDrawSurface2_ReleaseDC(tmp, dc);
        ok(SUCCEEDED(hr), "Failed to release DC, i %u, hr %#lx.\n", i, hr);

        IDirectDrawSurface2_Release(mipmap);
        mipmap = tmp;
    }

    hr = IDirectDrawSurface2_GetAttachedSurface(mipmap, &caps, &tmp);
    ok(hr == DDERR_NOTFOUND, "Got unexpected hr %#lx.\n", hr);
    IDirectDrawSurface2_Release(mipmap);
    refcount = IDirectDrawSurface2_Release(surface);
    ok(!refcount, "Got unexpected refcount %lu.\n", refcount);
    refcount = IDirectDrawPalette_Release(palette_mipmap);
    ok(!refcount, "Got unexpected refcount %lu.\n", refcount);
    refcount = IDirectDrawPalette_Release(palette);
    ok(!refcount, "Got unexpected refcount %lu.\n", refcount);

    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "Got unexpected refcount %lu.\n", refcount);
    DestroyWindow(window);
}

static void test_p8_blit(void)
{
    IDirectDrawSurface *src, *dst, *dst_p8;
    DDSURFACEDESC surface_desc;
    unsigned int color, x;
    IDirectDraw2 *ddraw;
    IDirectDrawPalette *palette, *palette2;
    ULONG refcount;
    HWND window;
    HRESULT hr;
    PALETTEENTRY palette_entries[256];
    DDBLTFX fx;
    BOOL is_warp;
    static const BYTE src_data[] = {0x10, 0x1, 0x2, 0x3, 0x4, 0x5, 0xff, 0x80};
    static const BYTE src_data2[] = {0x10, 0x5, 0x4, 0x3, 0x2, 0x1, 0xff, 0x80};
    static const BYTE expected_p8[] = {0x10, 0x1, 0x4, 0x3, 0x4, 0x5, 0xff, 0x80};
    static const unsigned int expected[] =
    {
        0x00101010, 0x00010101, 0x00020202, 0x00030303,
        0x00040404, 0x00050505, 0x00ffffff, 0x00808080,
    };

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);
    is_warp = ddraw_is_warp(ddraw);

    memset(palette_entries, 0, sizeof(palette_entries));
    palette_entries[1].peGreen = 0xff;
    palette_entries[2].peBlue = 0xff;
    palette_entries[3].peFlags = 0xff;
    palette_entries[4].peRed = 0xff;
    hr = IDirectDraw2_CreatePalette(ddraw, DDPCAPS_8BIT | DDPCAPS_ALLOW256,
            palette_entries, &palette, NULL);
    ok(SUCCEEDED(hr), "Failed to create palette, hr %#lx.\n", hr);
    palette_entries[1].peBlue = 0xff;
    palette_entries[2].peGreen = 0xff;
    palette_entries[3].peRed = 0xff;
    palette_entries[4].peFlags = 0x0;
    hr = IDirectDraw2_CreatePalette(ddraw, DDPCAPS_8BIT | DDPCAPS_ALLOW256,
            palette_entries, &palette2, NULL);
    ok(SUCCEEDED(hr), "Failed to create palette, hr %#lx.\n", hr);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT;
    surface_desc.dwWidth = 8;
    surface_desc.dwHeight = 1;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN;
    surface_desc.ddpfPixelFormat.dwSize = sizeof(surface_desc.ddpfPixelFormat);
    surface_desc.ddpfPixelFormat.dwFlags = DDPF_PALETTEINDEXED8 | DDPF_RGB;
    surface_desc.ddpfPixelFormat.dwRGBBitCount = 8;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &src, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &dst_p8, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_SetPalette(dst_p8, palette2);
    ok(SUCCEEDED(hr), "Failed to set palette, hr %#lx.\n", hr);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT;
    surface_desc.dwWidth = 8;
    surface_desc.dwHeight = 1;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN;
    surface_desc.ddpfPixelFormat.dwSize = sizeof(surface_desc.ddpfPixelFormat);
    surface_desc.ddpfPixelFormat.dwFlags = DDPF_RGB | DDPF_ALPHAPIXELS;
    surface_desc.ddpfPixelFormat.dwRGBBitCount = 32;
    surface_desc.ddpfPixelFormat.dwRBitMask = 0x00ff0000;
    surface_desc.ddpfPixelFormat.dwGBitMask = 0x0000ff00;
    surface_desc.ddpfPixelFormat.dwBBitMask = 0x000000ff;
    surface_desc.ddpfPixelFormat.dwRGBAlphaBitMask = 0xff000000;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &dst, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    hr = IDirectDrawSurface_Lock(src, NULL, &surface_desc, DDLOCK_WAIT, NULL);
    ok(SUCCEEDED(hr), "Failed to lock source surface, hr %#lx.\n", hr);
    memcpy(surface_desc.lpSurface, src_data, sizeof(src_data));
    hr = IDirectDrawSurface_Unlock(src, NULL);
    ok(SUCCEEDED(hr), "Failed to unlock source surface, hr %#lx.\n", hr);

    hr = IDirectDrawSurface_Lock(dst_p8, NULL, &surface_desc, DDLOCK_WAIT, NULL);
    ok(SUCCEEDED(hr), "Failed to lock destination surface, hr %#lx.\n", hr);
    memcpy(surface_desc.lpSurface, src_data2, sizeof(src_data2));
    hr = IDirectDrawSurface_Unlock(dst_p8, NULL);
    ok(SUCCEEDED(hr), "Failed to unlock destination surface, hr %#lx.\n", hr);

    fx.dwSize = sizeof(fx);
    fx.dwFillColor = 0xdeadbeef;
    hr = IDirectDrawSurface_Blt(dst, NULL, NULL, NULL, DDBLT_WAIT | DDBLT_COLORFILL, &fx);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);

    hr = IDirectDrawSurface_SetPalette(src, palette);
    ok(SUCCEEDED(hr), "Failed to set palette, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Blt(dst, NULL, src, NULL, DDBLT_WAIT, NULL);
    /* The r500 Windows 7 driver returns E_NOTIMPL. r200 on Windows XP works.
     * The Geforce 7 driver on Windows Vista returns E_FAIL. Newer Nvidia GPUs work. */
    ok(SUCCEEDED(hr) || broken(hr == E_NOTIMPL) || broken(hr == E_FAIL),
            "Failed to blit, hr %#lx.\n", hr);

    if (SUCCEEDED(hr))
    {
        for (x = 0; x < ARRAY_SIZE(expected); x++)
        {
            color = get_surface_color(dst, x, 0);
            /* WARP on 1709 and newer write zeroes on non-colorkeyed P8 -> RGB blits. For ckey
             * blits see below. */
            todo_wine ok(compare_color(color, expected[x], 0)
                    || broken(is_warp && compare_color(color, 0x00000000, 0)),
                    "Pixel %u: Got color %#x, expected %#x.\n",
                    x, color, expected[x]);
        }
    }

    fx.ddckSrcColorkey.dwColorSpaceHighValue = 0x2;
    fx.ddckSrcColorkey.dwColorSpaceLowValue = 0x2;
    hr = IDirectDrawSurface7_Blt(dst_p8, NULL, src, NULL, DDBLT_WAIT | DDBLT_KEYSRCOVERRIDE, &fx);
    ok(SUCCEEDED(hr), "Failed to blit, hr %#lx.\n", hr);

    hr = IDirectDrawSurface_Lock(dst_p8, NULL, &surface_desc, DDLOCK_READONLY | DDLOCK_WAIT, NULL);
    ok(SUCCEEDED(hr), "Failed to lock destination surface, hr %#lx.\n", hr);
    /* A color keyed P8 blit doesn't do anything on WARP - it just leaves the data in the destination
     * surface untouched. Error checking (DDBLT_KEYSRC without a key
     * for example) also works as expected.
     *
     * Using DDBLT_KEYSRC instead of DDBLT_KEYSRCOVERRIDE doesn't change this. Doing this blit with
     * the display mode set to P8 doesn't help either. */
    ok(!memcmp(surface_desc.lpSurface, expected_p8, sizeof(expected_p8))
            || broken(is_warp && !memcmp(surface_desc.lpSurface, src_data2, sizeof(src_data2))),
            "Got unexpected P8 color key blit result.\n");
    hr = IDirectDrawSurface_Unlock(dst_p8, NULL);
    ok(SUCCEEDED(hr), "Failed to unlock destination surface, hr %#lx.\n", hr);

    IDirectDrawSurface_Release(src);
    IDirectDrawSurface_Release(dst);
    IDirectDrawSurface_Release(dst_p8);
    IDirectDrawPalette_Release(palette);
    IDirectDrawPalette_Release(palette2);

    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "Got unexpected refcount %lu.\n", refcount);
    DestroyWindow(window);
}

static void test_material(void)
{
    IDirect3DMaterial2 *background, *material;
    D3DMATERIALHANDLE mat_handle, tmp;
    IDirect3DViewport2 *viewport;
    IDirect3DDevice2 *device;
    IDirectDrawSurface *rt;
    unsigned int color, i;
    IDirectDraw2 *ddraw;
    ULONG refcount;
    HWND window;
    HRESULT hr;
    BOOL valid;

    static D3DVERTEX quad[] =
    {
        {{-1.0f}, {-1.0f}, {0.0f}, {1.0f}, {0.0f}, {0.0f}},
        {{-1.0f}, { 1.0f}, {0.0f}, {1.0f}, {0.0f}, {0.0f}},
        {{ 1.0f}, {-1.0f}, {0.0f}, {1.0f}, {0.0f}, {0.0f}},
        {{ 1.0f}, { 1.0f}, {0.0f}, {1.0f}, {0.0f}, {0.0f}},
    };
    static const struct
    {
        BOOL material;
        D3DCOLOR expected_color;
    }
    test_data[] =
    {
        {TRUE,  0x0000ff00},
        {FALSE, 0x00ffffff},
    };
    static D3DRECT clear_rect = {{0}, {0}, {640}, {480}};

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    if (!(device = create_device(ddraw, window, DDSCL_NORMAL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice2_GetRenderTarget(device, &rt);
    ok(SUCCEEDED(hr), "Failed to get render target, hr %#lx.\n", hr);

    background = create_diffuse_material(device, 0.0f, 0.0f, 1.0f, 1.0f);
    viewport = create_viewport(device, 0, 0, 640, 480);
    viewport_set_background(device, viewport, background);
    hr = IDirect3DDevice2_SetCurrentViewport(device, viewport);
    ok(SUCCEEDED(hr), "Failed to set current viewport, hr %#lx.\n", hr);

    material = create_emissive_material(device, 0.0f, 1.0f, 0.0f, 0.0f);
    hr = IDirect3DMaterial2_GetHandle(material, device, &mat_handle);
    ok(SUCCEEDED(hr), "Failed to get material handle, hr %#lx.\n", hr);

    hr = IDirect3DDevice2_GetLightState(device, D3DLIGHTSTATE_MATERIAL, &tmp);
    ok(SUCCEEDED(hr), "Failed to get light state, hr %#lx.\n", hr);
    ok(!tmp, "Got unexpected material handle %#lx.\n", tmp);
    hr = IDirect3DDevice2_SetLightState(device, D3DLIGHTSTATE_MATERIAL, mat_handle);
    ok(SUCCEEDED(hr), "Failed to set material state, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_GetLightState(device, D3DLIGHTSTATE_MATERIAL, &tmp);
    ok(SUCCEEDED(hr), "Failed to get light state, hr %#lx.\n", hr);
    ok(tmp == mat_handle, "Got unexpected material handle %#lx, expected %#lx.\n", tmp, mat_handle);
    hr = IDirect3DDevice2_SetLightState(device, D3DLIGHTSTATE_MATERIAL, 0);
    ok(SUCCEEDED(hr), "Failed to set material state, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_GetLightState(device, D3DLIGHTSTATE_MATERIAL, &tmp);
    ok(SUCCEEDED(hr), "Failed to get light state, hr %#lx.\n", hr);
    ok(!tmp, "Got unexpected material handle %#lx.\n", tmp);

    for (i = 0; i < ARRAY_SIZE(test_data); ++i)
    {
        hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER);
        ok(SUCCEEDED(hr), "Failed to clear viewport, hr %#lx.\n", hr);

        hr = IDirect3DDevice2_SetLightState(device, D3DLIGHTSTATE_MATERIAL, test_data[i].material ? mat_handle : 0);
        ok(SUCCEEDED(hr), "Failed to set material state, hr %#lx.\n", hr);

        hr = IDirect3DDevice2_BeginScene(device);
        ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
        hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, D3DVT_VERTEX, quad, 4, 0);
        ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
        hr = IDirect3DDevice2_EndScene(device);
        ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);
        color = get_surface_color(rt, 320, 240);
        ok(compare_color(color, test_data[i].expected_color, 1),
                "Got unexpected color 0x%08x, test %u.\n", color, i);
    }

    destroy_material(material);
    material = create_diffuse_material(device, 1.0f, 0.0f, 0.0f, 1.0f);
    hr = IDirect3DMaterial2_GetHandle(material, device, &mat_handle);
    ok(SUCCEEDED(hr), "Failed to get material handle, hr %#lx.\n", hr);

    hr = IDirect3DViewport2_SetBackground(viewport, mat_handle);
    ok(SUCCEEDED(hr), "Failed to set viewport background, hr %#lx.\n", hr);
    hr = IDirect3DViewport2_GetBackground(viewport, &tmp, &valid);
    ok(SUCCEEDED(hr), "Failed to get viewport background, hr %#lx.\n", hr);
    ok(tmp == mat_handle, "Got unexpected material handle %#lx, expected %#lx.\n", tmp, mat_handle);
    ok(valid, "Got unexpected valid %#x.\n", valid);
    hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET);
    ok(SUCCEEDED(hr), "Failed to clear viewport, hr %#lx.\n", hr);
    color = get_surface_color(rt, 320, 240);
    ok(compare_color(color, 0x00ff0000, 1), "Got unexpected color 0x%08x.\n", color);

    hr = IDirect3DViewport2_SetBackground(viewport, 0);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DViewport2_GetBackground(viewport, &tmp, &valid);
    ok(SUCCEEDED(hr), "Failed to get viewport background, hr %#lx.\n", hr);
    ok(tmp == mat_handle, "Got unexpected material handle %#lx, expected %#lx.\n", tmp, mat_handle);
    ok(valid, "Got unexpected valid %#x.\n", valid);
    hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET);
    ok(SUCCEEDED(hr), "Failed to clear viewport, hr %#lx.\n", hr);
    color = get_surface_color(rt, 320, 240);
    ok(compare_color(color, 0x00ff0000, 1), "Got unexpected color 0x%08x.\n", color);

    destroy_viewport(device, viewport);
    viewport = create_viewport(device, 0, 0, 640, 480);

    hr = IDirect3DViewport2_GetBackground(viewport, &tmp, &valid);
    ok(SUCCEEDED(hr), "Failed to get viewport background, hr %#lx.\n", hr);
    ok(!tmp, "Got unexpected material handle %#lx.\n", tmp);
    ok(!valid, "Got unexpected valid %#x.\n", valid);
    hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET);
    ok(SUCCEEDED(hr), "Failed to clear viewport, hr %#lx.\n", hr);
    color = get_surface_color(rt, 320, 240);
    ok(compare_color(color, 0x00000000, 1), "Got unexpected color 0x%08x.\n", color);

    destroy_viewport(device, viewport);
    destroy_material(background);
    destroy_material(material);
    IDirectDrawSurface_Release(rt);
    refcount = IDirect3DDevice2_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "Ddraw object has %lu references left.\n", refcount);
    DestroyWindow(window);
}

static void test_lighting(void)
{
    static D3DRECT clear_rect = {{0}, {0}, {640}, {480}};
    static D3DMATRIX mat =
    {
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f,
    },
    mat_singular =
    {
        1.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        1.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.5f, 1.0f,
    },
    mat_transf =
    {
         0.0f,  0.0f,  1.0f, 0.0f,
         0.0f,  1.0f,  0.0f, 0.0f,
        -1.0f,  0.0f,  0.0f, 0.0f,
         10.f, 10.0f, 10.0f, 1.0f,
    },
    mat_nonaffine =
    {
        1.0f,  0.0f,  0.0f,  0.0f,
        0.0f,  1.0f,  0.0f,  0.0f,
        0.0f,  0.0f,  1.0f, -1.0f,
        10.f, 10.0f, 10.0f,  0.0f,
    };
    static D3DLVERTEX unlitquad[] =
    {
        {{-1.0f}, {-1.0f}, {0.1f}, 0, {0xffff0000}, {0}, {0.0f}, {0.0f}},
        {{-1.0f}, { 0.0f}, {0.1f}, 0, {0xffff0000}, {0}, {0.0f}, {0.0f}},
        {{ 0.0f}, { 0.0f}, {0.1f}, 0, {0xffff0000}, {0}, {0.0f}, {0.0f}},
        {{ 0.0f}, {-1.0f}, {0.1f}, 0, {0xffff0000}, {0}, {0.0f}, {0.0f}},
    },
    litquad[] =
    {
        {{-1.0f}, { 0.0f}, {0.1f}, 0, {0xff00ff00}, {0}, {0.0f}, {0.0f}},
        {{-1.0f}, { 1.0f}, {0.1f}, 0, {0xff00ff00}, {0}, {0.0f}, {0.0f}},
        {{ 0.0f}, { 1.0f}, {0.1f}, 0, {0xff00ff00}, {0}, {0.0f}, {0.0f}},
        {{ 0.0f}, { 0.0f}, {0.1f}, 0, {0xff00ff00}, {0}, {0.0f}, {0.0f}},
    };
    static D3DVERTEX unlitnquad[] =
    {
        {{0.0f}, {-1.0f}, {0.1f}, {1.0f}, {1.0f}, {1.0f}, {0.0f}, {0.0f}},
        {{0.0f}, { 0.0f}, {0.1f}, {1.0f}, {1.0f}, {1.0f}, {0.0f}, {0.0f}},
        {{1.0f}, { 0.0f}, {0.1f}, {1.0f}, {1.0f}, {1.0f}, {0.0f}, {0.0f}},
        {{1.0f}, {-1.0f}, {0.1f}, {1.0f}, {1.0f}, {1.0f}, {0.0f}, {0.0f}},
    },
    litnquad[] =
    {
        {{0.0f}, { 0.0f}, {0.1f}, {1.0f}, {1.0f}, {1.0f}, {0.0f}, {0.0f}},
        {{0.0f}, { 1.0f}, {0.1f}, {1.0f}, {1.0f}, {1.0f}, {0.0f}, {0.0f}},
        {{1.0f}, { 1.0f}, {0.1f}, {1.0f}, {1.0f}, {1.0f}, {0.0f}, {0.0f}},
        {{1.0f}, { 0.0f}, {0.1f}, {1.0f}, {1.0f}, {1.0f}, {0.0f}, {0.0f}},
    },
    nquad[] =
    {
        {{-1.0f}, {-1.0f}, {0.0f}, {0.0f}, {0.0f}, {-1.0f}, {0.0f}, {0.0f}},
        {{-1.0f}, { 1.0f}, {0.0f}, {0.0f}, {0.0f}, {-1.0f}, {0.0f}, {0.0f}},
        {{ 1.0f}, { 1.0f}, {0.0f}, {0.0f}, {0.0f}, {-1.0f}, {0.0f}, {0.0f}},
        {{ 1.0f}, {-1.0f}, {0.0f}, {0.0f}, {0.0f}, {-1.0f}, {0.0f}, {0.0f}},
    },
    rotatedquad[] =
    {
        {{-10.0f}, {-11.0f}, {11.0f}, {-1.0f}, {0.0f}, {0.0f}, {0.0f}, {0.0f}},
        {{-10.0f}, { -9.0f}, {11.0f}, {-1.0f}, {0.0f}, {0.0f}, {0.0f}, {0.0f}},
        {{-10.0f}, { -9.0f}, { 9.0f}, {-1.0f}, {0.0f}, {0.0f}, {0.0f}, {0.0f}},
        {{-10.0f}, {-11.0f}, { 9.0f}, {-1.0f}, {0.0f}, {0.0f}, {0.0f}, {0.0f}},
    },
    translatedquad[] =
    {
        {{-11.0f}, {-11.0f}, {-10.0f}, {0.0f}, {0.0f}, {-1.0f}, {0.0f}, {0.0f}},
        {{-11.0f}, { -9.0f}, {-10.0f}, {0.0f}, {0.0f}, {-1.0f}, {0.0f}, {0.0f}},
        {{ -9.0f}, { -9.0f}, {-10.0f}, {0.0f}, {0.0f}, {-1.0f}, {0.0f}, {0.0f}},
        {{ -9.0f}, {-11.0f}, {-10.0f}, {0.0f}, {0.0f}, {-1.0f}, {0.0f}, {0.0f}},
    };
    static WORD indices[] = {0, 1, 2, 2, 3, 0};
    static const struct
    {
        D3DMATRIX *world_matrix;
        void *quad;
        DWORD expected;
        const char *message;
    }
    tests[] =
    {
        {&mat, nquad, 0x000060ff, "Lit quad with light"},
        {&mat_singular, nquad, 0x00004db4, "Lit quad with singular world matrix"},
        {&mat_transf, rotatedquad, 0x000060ff, "Lit quad with transformation matrix"},
        {&mat_nonaffine, translatedquad, 0x000060ff, "Lit quad with non-affine matrix"},
    };

    IDirect3DViewport2 *viewport, *viewport2;
    D3DMATERIALHANDLE mat_handle;
    IDirect3DMaterial2 *material;
    IDirect3DDevice2 *device;
    IDirectDrawSurface *rt;
    IDirect3DLight *light;
    unsigned int color, i;
    D3DLIGHT2 light_desc;
    IDirectDraw2 *ddraw;
    IDirect3D2 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    if (!(device = create_device(ddraw, window, DDSCL_NORMAL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice2_GetDirect3D(device, &d3d);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice2_GetRenderTarget(device, &rt);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    viewport = create_viewport(device, 0, 0, 640, 480);
    hr = IDirect3DDevice2_SetCurrentViewport(device, viewport);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    material = create_diffuse_and_ambient_material(device, 1.0f, 1.0f, 1.0f, 1.0f);
    viewport_set_background(device, viewport, material);

    hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET);
    ok(SUCCEEDED(hr), "Failed to clear viewport, hr %#lx.\n", hr);

    hr = IDirect3DDevice2_SetTransform(device, D3DTRANSFORMSTATE_WORLD, &mat);
    ok(SUCCEEDED(hr), "Failed to set world transform, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetTransform(device, D3DTRANSFORMSTATE_VIEW, &mat);
    ok(SUCCEEDED(hr), "Failed to set view transform, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetTransform(device, D3DTRANSFORMSTATE_PROJECTION, &mat);
    ok(SUCCEEDED(hr), "Failed to set projection transform, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_ZENABLE, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable zbuffer, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_FOGENABLE, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable fog, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_CULLMODE, D3DCULL_NONE);
    ok(SUCCEEDED(hr), "Failed to disable culling, hr %#lx.\n", hr);

    hr = IDirect3DDevice2_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);

    /* There is no D3DRENDERSTATE_LIGHTING on ddraw < 7. */
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_LIGHTING, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable lighting, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_DrawIndexedPrimitive(device, D3DPT_TRIANGLELIST, D3DVT_LVERTEX, unlitquad,
            4, indices, 6, 0);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_LIGHTING, TRUE);
    ok(SUCCEEDED(hr), "Failed to enable lighting, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_DrawIndexedPrimitive(device, D3DPT_TRIANGLELIST, D3DVT_LVERTEX, litquad,
            4, indices, 6, 0);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_LIGHTING, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable lighting, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_DrawIndexedPrimitive(device, D3DPT_TRIANGLELIST, D3DVT_VERTEX, unlitnquad,
            4, indices, 6, 0);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_LIGHTING, TRUE);
    ok(SUCCEEDED(hr), "Failed to disable lighting, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_DrawIndexedPrimitive(device, D3DPT_TRIANGLELIST, D3DVT_VERTEX, litnquad,
            4, indices, 6, 0);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice2_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

    color = get_surface_color(rt, 160, 360);
    ok(color == 0x00ff0000, "Unlit quad without normals has color 0x%08x.\n", color);
    color = get_surface_color(rt, 160, 120);
    ok(color == 0x0000ff00, "Lit quad without normals has color 0x%08x.\n", color);
    color = get_surface_color(rt, 480, 360);
    ok(color == 0x00ffffff, "Unlit quad with normals has color 0x%08x.\n", color);
    color = get_surface_color(rt, 480, 120);
    ok(color == 0x00ffffff, "Lit quad with normals has color 0x%08x.\n", color);

    hr = IDirect3DMaterial2_GetHandle(material, device, &mat_handle);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetLightState(device, D3DLIGHTSTATE_MATERIAL, mat_handle);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetLightState(device, D3DLIGHTSTATE_AMBIENT, 0xff002000);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3D2_CreateLight(d3d, &light, NULL);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    memset(&light_desc, 0, sizeof(light_desc));
    light_desc.dwSize = sizeof(light_desc);
    light_desc.dltType = D3DLIGHT_DIRECTIONAL;
    light_desc.dcvColor.r = 0.0f;
    light_desc.dcvColor.g = 0.25f;
    light_desc.dcvColor.b = 1.0f;
    light_desc.dcvColor.a = 1.0f;
    light_desc.dvDirection.z = 1.0f;
    hr = IDirect3DLight_SetLight(light, (D3DLIGHT *)&light_desc);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DViewport2_AddLight(viewport, light);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DViewport2_AddLight(viewport, light);
    ok(hr == D3DERR_LIGHTHASVIEWPORT, "Got unexpected hr %#lx.\n", hr);

    viewport2 = create_viewport(device, 0, 0, 640, 480);
    hr = IDirect3DViewport2_AddLight(viewport2, light);
    ok(hr == D3DERR_LIGHTHASVIEWPORT, "Got unexpected hr %#lx.\n", hr);
    destroy_viewport(device, viewport2);

    hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice2_BeginScene(device);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice2_DrawIndexedPrimitive(device, D3DPT_TRIANGLELIST, D3DVT_VERTEX, nquad,
            4, indices, 6, 0);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice2_EndScene(device);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    color = get_surface_color(rt, 320, 240);
    ok(color == 0x00002000, "Lit quad with no light has color 0x%08x.\n", color);

    light_desc.dwFlags = D3DLIGHT_ACTIVE;
    hr = IDirect3DLight_SetLight(light, (D3DLIGHT *)&light_desc);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DViewport2_DeleteLight(viewport, light);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    light_desc.dwFlags = 0;
    hr = IDirect3DLight_GetLight(light, (D3DLIGHT *)&light_desc);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    ok(light_desc.dwFlags == D3DLIGHT_ACTIVE, "Got unexpected flags %#lx.\n", light_desc.dwFlags);

    hr = IDirect3DViewport2_AddLight(viewport, light);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    for (i = 0; i < ARRAY_SIZE(tests); ++i)
    {
        hr = IDirect3DDevice2_SetTransform(device, D3DTRANSFORMSTATE_WORLD, tests[i].world_matrix);
        ok(SUCCEEDED(hr), "Failed to set world transform, hr %#lx.\n", hr);

        hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET);
        ok(SUCCEEDED(hr), "Failed to clear viewport, hr %#lx.\n", hr);

        hr = IDirect3DDevice2_BeginScene(device);
        ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);

        hr = IDirect3DDevice2_DrawIndexedPrimitive(device, D3DPT_TRIANGLELIST, D3DVT_VERTEX,
                tests[i].quad, 4, indices, 6, 0);
        ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

        hr = IDirect3DDevice2_EndScene(device);
        ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

        color = get_surface_color(rt, 320, 240);
        ok(color == tests[i].expected, "%s has color 0x%08x.\n", tests[i].message, color);
    }

    hr = IDirect3DViewport2_DeleteLight(viewport, light);
    ok(SUCCEEDED(hr), "Failed to remove a light from the viewport, hr %#lx.\n", hr);
    IDirect3DLight_Release(light);
    destroy_material(material);
    destroy_viewport(device, viewport);
    IDirectDrawSurface2_Release(rt);
    refcount = IDirect3DDevice2_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D2_Release(d3d);
    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "Ddraw object has %lu references left.\n", refcount);
    DestroyWindow(window);
}

static void test_specular_lighting(void)
{
    static const unsigned int vertices_side = 5;
    const unsigned int indices_count = (vertices_side - 1) * (vertices_side - 1) * 2 * 3;
    static D3DRECT clear_rect = {{0}, {0}, {640}, {480}};
    static D3DMATRIX mat =
    {
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f,
    };
    static D3DLIGHT2 directional =
    {
        sizeof(D3DLIGHT2),
        D3DLIGHT_DIRECTIONAL,
        {{1.0f}, {1.0f}, {1.0f}, {0.0f}},
        {{0.0f}, {0.0f}, {0.0f}},
        {{0.0f}, {0.0f}, {1.0f}},
    },
    point =
    {
        sizeof(D3DLIGHT2),
        D3DLIGHT_POINT,
        {{1.0f}, {1.0f}, {1.0f}, {0.0f}},
        {{0.0f}, {0.0f}, {0.0f}},
        {{0.0f}, {0.0f}, {0.0f}},
        100.0f,
        0.0f,
        0.0f, 0.0f, 1.0f,
    },
    spot =
    {
        sizeof(D3DLIGHT2),
        D3DLIGHT_SPOT,
        {{1.0f}, {1.0f}, {1.0f}, {0.0f}},
        {{0.0f}, {0.0f}, {0.0f}},
        {{0.0f}, {0.0f}, {1.0f}},
        100.0f,
        1.0f,
        0.0f, 0.0f, 1.0f,
        M_PI / 12.0f, M_PI / 3.0f
    },
    parallelpoint =
    {
        sizeof(D3DLIGHT2),
        D3DLIGHT_PARALLELPOINT,
        {{1.0f}, {1.0f}, {1.0f}, {0.0f}},
        {{0.5f}, {0.0f}, {-1.0f}},
        {{0.0f}, {0.0f}, {0.0f}},
    },
    point_side =
    {
        sizeof(D3DLIGHT2),
        D3DLIGHT_POINT,
        {{1.0f}, {1.0f}, {1.0f}, {0.0f}},
        {{-1.1f}, {0.0f}, {1.1f}},
        {{0.0f}, {0.0f}, {0.0f}},
        100.0f,
        0.0f,
        1.0f, 0.0f, 0.0f,
    },
    point_far =
    {
        sizeof(D3DLIGHT2),
        D3DLIGHT_POINT,
        {{1.0f}, {1.0f}, {1.0f}, {0.0f}},
        {{0.0f}, {0.0f}, {0.1f}},
        {{0.0f}, {0.0f}, {0.0f}},
        1.0f,
        0.0f,
        1.0f, 0.0f, 0.0f,
    };
    static const struct expected_color
    {
        unsigned int x, y, color;
    }
    expected_directional_local[] =
    {
        {160, 120, 0x003c3c3c},
        {320, 120, 0x00717171},
        {480, 120, 0x003c3c3c},
        {160, 240, 0x00717171},
        {320, 240, 0x00ffffff},
        {480, 240, 0x00717171},
        {160, 360, 0x003c3c3c},
        {320, 360, 0x00717171},
        {480, 360, 0x003c3c3c},
    },
    expected_point_local[] =
    {
        {160, 120, 0x00000000},
        {320, 120, 0x00090909},
        {480, 120, 0x00000000},
        {160, 240, 0x00090909},
        {320, 240, 0x00fafafa},
        {480, 240, 0x00090909},
        {160, 360, 0x00000000},
        {320, 360, 0x00090909},
        {480, 360, 0x00000000},
    },
    expected_spot_local[] =
    {
        {160, 120, 0x00000000},
        {320, 120, 0x00020202},
        {480, 120, 0x00000000},
        {160, 240, 0x00020202},
        {320, 240, 0x00fafafa},
        {480, 240, 0x00020202},
        {160, 360, 0x00000000},
        {320, 360, 0x00020202},
        {480, 360, 0x00000000},
    },
    expected_parallelpoint[] =
    {
        {160, 120, 0x00050505},
        {320, 120, 0x002c2c2c},
        {480, 120, 0x006e6e6e},
        {160, 240, 0x00090909},
        {320, 240, 0x00717171},
        {480, 240, 0x00ffffff},
        {160, 360, 0x00050505},
        {320, 360, 0x002c2c2c},
        {480, 360, 0x006e6e6e},
    },
    expected_point_far[] =
    {
        {160, 120, 0x00000000},
        {320, 120, 0x00000000},
        {480, 120, 0x00000000},
        {160, 240, 0x00000000},
        {320, 240, 0x00ffffff},
        {480, 240, 0x00000000},
        {160, 360, 0x00000000},
        {320, 360, 0x00000000},
        {480, 360, 0x00000000},
    },
    expected_zero[] =
    {
        {160, 120, 0x00000000},
        {320, 120, 0x00000000},
        {480, 120, 0x00000000},
        {160, 240, 0x00000000},
        {320, 240, 0x00000000},
        {480, 240, 0x00000000},
        {160, 360, 0x00000000},
        {320, 360, 0x00000000},
        {480, 360, 0x00000000},
    };
    static const struct
    {
        D3DLIGHT2 *light;
        float specular_power;
        const struct expected_color *expected;
        unsigned int expected_count;
    }
    tests[] =
    {
        {&directional, 30.0f, expected_directional_local, ARRAY_SIZE(expected_directional_local)},
        {&point, 30.0f, expected_point_local, ARRAY_SIZE(expected_point_local)},
        {&spot, 30.0f, expected_spot_local, ARRAY_SIZE(expected_spot_local)},
        {&parallelpoint, 30.0f, expected_parallelpoint, ARRAY_SIZE(expected_parallelpoint)},
        {&point_side, 0.0f, expected_zero, ARRAY_SIZE(expected_zero)},
        {&point_far, 1.0f, expected_point_far, ARRAY_SIZE(expected_point_far)},
        {&directional, 0.0f, expected_zero, ARRAY_SIZE(expected_zero)},
        {&point, 0.0f, expected_zero, ARRAY_SIZE(expected_zero)},
        {&spot, 0.0f, expected_zero, ARRAY_SIZE(expected_zero)},
        {&parallelpoint, 0.0f, expected_zero, ARRAY_SIZE(expected_zero)},
        {&point_far, 0.0f, expected_zero, ARRAY_SIZE(expected_zero)},
    };
    IDirect3D2 *d3d;
    IDirect3DDevice2 *device;
    IDirectDraw2 *ddraw;
    IDirectDrawSurface *rt;
    IDirect3DViewport2 *viewport;
    IDirect3DMaterial2 *material, *background_material;
    unsigned int color, i, j, x, y;
    IDirect3DLight *light;
    D3DMATERIALHANDLE mat_handle;
    ULONG refcount;
    HWND window;
    HRESULT hr;
    D3DVERTEX *quad;
    WORD *indices;

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    if (!(device = create_device(ddraw, window, DDSCL_NORMAL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        DestroyWindow(window);
        return;
    }

    quad = malloc(vertices_side * vertices_side * sizeof(*quad));
    indices = malloc(indices_count * sizeof(*indices));
    for (i = 0, y = 0; y < vertices_side; ++y)
    {
        for (x = 0; x < vertices_side; ++x)
        {
            quad[i].x = x * 2.0f / (vertices_side - 1) - 1.0f;
            quad[i].y = y * 2.0f / (vertices_side - 1) - 1.0f;
            quad[i].z = 1.0f;
            quad[i].nx = 0.0f;
            quad[i].ny = 0.0f;
            quad[i].nz = -1.0f;
            quad[i].tu = 0.0f;
            quad[i++].tv = 0.0f;
        }
    }
    for (i = 0, y = 0; y < (vertices_side - 1); ++y)
    {
        for (x = 0; x < (vertices_side - 1); ++x)
        {
            indices[i++] = y * vertices_side + x + 1;
            indices[i++] = y * vertices_side + x;
            indices[i++] = (y + 1) * vertices_side + x;
            indices[i++] = y * vertices_side + x + 1;
            indices[i++] = (y + 1) * vertices_side + x;
            indices[i++] = (y + 1) * vertices_side + x + 1;
        }
    }

    hr = IDirect3DDevice2_GetDirect3D(device, &d3d);
    ok(SUCCEEDED(hr), "Failed to get D3D interface, hr %#lx.\n", hr);

    hr = IDirect3DDevice2_GetRenderTarget(device, &rt);
    ok(SUCCEEDED(hr), "Failed to get render target, hr %#lx.\n", hr);

    viewport = create_viewport(device, 0, 0, 640, 480);
    hr = IDirect3DDevice2_SetCurrentViewport(device, viewport);
    ok(SUCCEEDED(hr), "Failed to set current viewport, hr %#lx.\n", hr);

    hr = IDirect3DDevice2_SetTransform(device, D3DTRANSFORMSTATE_WORLD, &mat);
    ok(SUCCEEDED(hr), "Failed to set world transform, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetTransform(device, D3DTRANSFORMSTATE_VIEW, &mat);
    ok(SUCCEEDED(hr), "Failed to set view transform, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetTransform(device, D3DTRANSFORMSTATE_PROJECTION, &mat);
    ok(SUCCEEDED(hr), "Failed to set projection transform, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_ZENABLE, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable z-buffering, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_FOGENABLE, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable fog, hr %#lx.\n", hr);

    background_material = create_diffuse_material(device, 1.0f, 1.0f, 1.0f, 1.0f);
    viewport_set_background(device, viewport, background_material);

    hr = IDirect3D2_CreateLight(d3d, &light, NULL);
    ok(SUCCEEDED(hr), "Failed to create a light object, hr %#lx.\n", hr);
    hr = IDirect3DViewport2_AddLight(viewport, light);
    ok(SUCCEEDED(hr), "Failed to add a light to the viewport, hr %#lx.\n", hr);

    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_SPECULARENABLE, TRUE);
    ok(SUCCEEDED(hr), "Failed to enable specular lighting, hr %#lx.\n", hr);

    for (i = 0; i < ARRAY_SIZE(tests); ++i)
    {
        tests[i].light->dwFlags = D3DLIGHT_ACTIVE;
        hr = IDirect3DLight_SetLight(light, (D3DLIGHT *)tests[i].light);
        ok(SUCCEEDED(hr), "Failed to set light, hr %#lx.\n", hr);

        material = create_specular_material(device, 1.0f, 1.0f, 1.0f, 1.0f, tests[i].specular_power);
        hr = IDirect3DMaterial2_GetHandle(material, device, &mat_handle);
        ok(SUCCEEDED(hr), "Failed to get material handle, hr %#lx.\n", hr);
        hr = IDirect3DDevice2_SetLightState(device, D3DLIGHTSTATE_MATERIAL, mat_handle);
        ok(SUCCEEDED(hr), "Failed to set material state, hr %#lx.\n", hr);

        hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET);
        ok(SUCCEEDED(hr), "Failed to clear viewport, hr %#lx.\n", hr);

        hr = IDirect3DDevice2_BeginScene(device);
        ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);

        hr = IDirect3DDevice2_DrawIndexedPrimitive(device, D3DPT_TRIANGLELIST, D3DVT_VERTEX,
                quad, vertices_side * vertices_side, indices, indices_count, 0);
        ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

        hr = IDirect3DDevice2_EndScene(device);
        ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

        for (j = 0; j < tests[i].expected_count; ++j)
        {
            color = get_surface_color(rt, tests[i].expected[j].x, tests[i].expected[j].y);
            ok(compare_color(color, tests[i].expected[j].color, 1),
                    "Expected color 0x%08x at location (%u, %u), got 0x%08x, case %u.\n",
                    tests[i].expected[j].color, tests[i].expected[j].x,
                    tests[i].expected[j].y, color, i);
        }

        destroy_material(material);
    }

    hr = IDirect3DViewport2_DeleteLight(viewport, light);
    ok(SUCCEEDED(hr), "Failed to remove a light from the viewport, hr %#lx.\n", hr);
    IDirect3DLight_Release(light);
    destroy_material(background_material);
    destroy_viewport(device, viewport);
    IDirectDrawSurface2_Release(rt);
    refcount = IDirect3DDevice2_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D2_Release(d3d);
    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "Ddraw object has %lu references left.\n", refcount);
    DestroyWindow(window);
    free(indices);
    free(quad);
}

static void test_palette_gdi(void)
{
    IDirectDrawSurface *surface, *primary;
    DDSURFACEDESC surface_desc;
    unsigned int color, i;
    IDirectDraw2 *ddraw;
    IDirectDrawPalette *palette, *palette2;
    ULONG refcount;
    HWND window;
    HRESULT hr;
    PALETTEENTRY palette_entries[256];
    HDC dc;
    DDBLTFX fx;
    RECT r;

    /* On the Windows 8 testbot palette index 0 of the onscreen palette is forced to
     * r = 0, g = 0, b = 0. Do not attempt to set it to something else as this is
     * not the point of this test. */
    static const RGBQUAD expected1[] =
    {
        {0x00, 0x00, 0x00, 0x00}, {0x00, 0x00, 0x01, 0x00}, {0x00, 0x02, 0x00, 0x00},
        {0x03, 0x00, 0x00, 0x00}, {0x15, 0x14, 0x13, 0x00},
    };
    static const RGBQUAD expected2[] =
    {
        {0x00, 0x00, 0x00, 0x00}, {0x00, 0x00, 0x01, 0x00}, {0x00, 0x02, 0x00, 0x00},
        {0x03, 0x00, 0x00, 0x00}, {0x25, 0x24, 0x23, 0x00},
    };
    static const RGBQUAD expected3[] =
    {
        {0x00, 0x00, 0x00, 0x00}, {0x40, 0x00, 0x00, 0x00}, {0x00, 0x00, 0x40, 0x00},
        {0x00, 0x40, 0x00, 0x00}, {0x56, 0x34, 0x12, 0x00},
    };
    HPALETTE ddraw_palette_handle;
    /* Similar to index 0, index 255 is r = 0xff, g = 0xff, b = 0xff on the Win8 VMs. */
    RGBQUAD rgbquad[255];
    static const RGBQUAD rgb_zero = {0, 0, 0, 0};

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT;
    surface_desc.dwWidth = 16;
    surface_desc.dwHeight = 16;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN;
    surface_desc.ddpfPixelFormat.dwSize = sizeof(surface_desc.ddpfPixelFormat);
    surface_desc.ddpfPixelFormat.dwFlags = DDPF_PALETTEINDEXED8 | DDPF_RGB;
    surface_desc.ddpfPixelFormat.dwRGBBitCount = 8;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

    /* Avoid colors from the Windows default palette. */
    memset(palette_entries, 0, sizeof(palette_entries));
    palette_entries[1].peRed = 0x01;
    palette_entries[2].peGreen = 0x02;
    palette_entries[3].peBlue = 0x03;
    palette_entries[4].peRed = 0x13;
    palette_entries[4].peGreen = 0x14;
    palette_entries[4].peBlue = 0x15;
    hr = IDirectDraw2_CreatePalette(ddraw, DDPCAPS_8BIT | DDPCAPS_ALLOW256,
            palette_entries, &palette, NULL);
    ok(SUCCEEDED(hr), "Failed to create palette, hr %#lx.\n", hr);

    /* If there is no palette assigned and the display mode is not 8 bpp, some
     * drivers refuse to create a DC while others allow it. If a DC is created,
     * the DIB color table is uninitialized and contains random colors. No error
     * is generated when trying to read pixels and random garbage is returned.
     *
     * The most likely explanation is that if the driver creates a DC, it (or
     * the higher-level runtime) uses GetSystemPaletteEntries to find the
     * palette, but GetSystemPaletteEntries fails when bpp > 8 and the palette
     * contains uninitialized garbage. See comments below for the P8 case. */

    hr = IDirectDrawSurface_SetPalette(surface, palette);
    ok(SUCCEEDED(hr), "Failed to set palette, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_GetDC(surface, &dc);
    ok(SUCCEEDED(hr), "Failed to get DC, hr %#lx.\n", hr);
    ddraw_palette_handle = SelectPalette(dc, GetStockObject(DEFAULT_PALETTE), FALSE);
    ok(ddraw_palette_handle == GetStockObject(DEFAULT_PALETTE),
            "Got unexpected palette %p, expected %p.\n",
            ddraw_palette_handle, GetStockObject(DEFAULT_PALETTE));

    i = GetDIBColorTable(dc, 0, ARRAY_SIZE(rgbquad), rgbquad);
    ok(i == ARRAY_SIZE(rgbquad), "Expected count 255, got %u.\n", i);
    for (i = 0; i < ARRAY_SIZE(expected1); i++)
    {
        ok(!memcmp(&rgbquad[i], &expected1[i], sizeof(rgbquad[i])),
                "Got color table entry %u r=%#x g=%#x b=%#x, expected r=%#x g=%#x b=%#x.\n",
                i, rgbquad[i].rgbRed, rgbquad[i].rgbGreen, rgbquad[i].rgbBlue,
                expected1[i].rgbRed, expected1[i].rgbGreen, expected1[i].rgbBlue);
    }
    for (; i < ARRAY_SIZE(rgbquad); i++)
    {
        ok(!memcmp(&rgbquad[i], &rgb_zero, sizeof(rgbquad[i])),
                "Got color table entry %u r=%#x g=%#x b=%#x, expected r=0 g=0 b=0.\n",
                i, rgbquad[i].rgbRed, rgbquad[i].rgbGreen, rgbquad[i].rgbBlue);
    }

    /* Update the palette while the DC is in use. This does not modify the DC. */
    palette_entries[4].peRed = 0x23;
    palette_entries[4].peGreen = 0x24;
    palette_entries[4].peBlue = 0x25;
    hr = IDirectDrawPalette_SetEntries(palette, 0, 4, 1, &palette_entries[4]);
    ok(SUCCEEDED(hr), "Failed to set palette entries, hr %#lx.\n", hr);

    i = GetDIBColorTable(dc, 4, 1, &rgbquad[4]);
    ok(i == 1, "Expected count 1, got %u.\n", i);
    ok(!memcmp(&rgbquad[4], &expected1[4], sizeof(rgbquad[4])),
            "Got color table entry %u r=%#x g=%#x b=%#x, expected r=%#x g=%#x b=%#x.\n",
            i, rgbquad[4].rgbRed, rgbquad[4].rgbGreen, rgbquad[4].rgbBlue,
            expected1[4].rgbRed, expected1[4].rgbGreen, expected1[4].rgbBlue);

    /* Neither does re-setting the palette. */
    hr = IDirectDrawSurface_SetPalette(surface, NULL);
    ok(SUCCEEDED(hr), "Failed to set palette, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_SetPalette(surface, palette);
    ok(SUCCEEDED(hr), "Failed to set palette, hr %#lx.\n", hr);

    i = GetDIBColorTable(dc, 4, 1, &rgbquad[4]);
    ok(i == 1, "Expected count 1, got %u.\n", i);
    ok(!memcmp(&rgbquad[4], &expected1[4], sizeof(rgbquad[4])),
            "Got color table entry %u r=%#x g=%#x b=%#x, expected r=%#x g=%#x b=%#x.\n",
            i, rgbquad[4].rgbRed, rgbquad[4].rgbGreen, rgbquad[4].rgbBlue,
            expected1[4].rgbRed, expected1[4].rgbGreen, expected1[4].rgbBlue);

    hr = IDirectDrawSurface_ReleaseDC(surface, dc);
    ok(SUCCEEDED(hr), "Failed to release DC, hr %#lx.\n", hr);

    /* Refresh the DC. This updates the palette. */
    hr = IDirectDrawSurface_GetDC(surface, &dc);
    ok(SUCCEEDED(hr), "Failed to get DC, hr %#lx.\n", hr);
    i = GetDIBColorTable(dc, 0, ARRAY_SIZE(rgbquad), rgbquad);
    ok(i == ARRAY_SIZE(rgbquad), "Expected count 255, got %u.\n", i);
    for (i = 0; i < ARRAY_SIZE(expected2); i++)
    {
        ok(!memcmp(&rgbquad[i], &expected2[i], sizeof(rgbquad[i])),
                "Got color table entry %u r=%#x g=%#x b=%#x, expected r=%#x g=%#x b=%#x.\n",
                i, rgbquad[i].rgbRed, rgbquad[i].rgbGreen, rgbquad[i].rgbBlue,
                expected2[i].rgbRed, expected2[i].rgbGreen, expected2[i].rgbBlue);
    }
    for (; i < ARRAY_SIZE(rgbquad); i++)
    {
        ok(!memcmp(&rgbquad[i], &rgb_zero, sizeof(rgbquad[i])),
                "Got color table entry %u r=%#x g=%#x b=%#x, expected r=0 g=0 b=0.\n",
                i, rgbquad[i].rgbRed, rgbquad[i].rgbGreen, rgbquad[i].rgbBlue);
    }
    hr = IDirectDrawSurface_ReleaseDC(surface, dc);
    ok(SUCCEEDED(hr), "Failed to release DC, hr %#lx.\n", hr);

    refcount = IDirectDrawSurface_Release(surface);
    ok(!refcount, "Got unexpected refcount %lu.\n", refcount);

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_FULLSCREEN | DDSCL_EXCLUSIVE);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);
    if (FAILED(IDirectDraw2_SetDisplayMode(ddraw, 640, 480, 8, 0, 0)))
    {
        win_skip("Failed to set 8 bpp display mode, skipping test.\n");
        IDirectDrawPalette_Release(palette);
        IDirectDraw2_Release(ddraw);
        DestroyWindow(window);
        return;
    }
    ok(SUCCEEDED(hr), "Failed to set display mode, hr %#lx.\n", hr);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &primary, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

    memset(&fx, 0, sizeof(fx));
    fx.dwSize = sizeof(fx);
    fx.dwFillColor = 3;
    SetRect(&r, 0, 0, 319, 479);
    hr = IDirectDrawSurface_Blt(primary, &r, NULL, NULL, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
    ok(SUCCEEDED(hr), "Failed to clear surface, hr %#lx.\n", hr);
    SetRect(&r, 320, 0, 639, 479);
    fx.dwFillColor = 4;
    hr = IDirectDrawSurface_Blt(primary, &r, NULL, NULL, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
    ok(SUCCEEDED(hr), "Failed to clear surface, hr %#lx.\n", hr);

    hr = IDirectDrawSurface_SetPalette(primary, palette);
    ok(SUCCEEDED(hr), "Failed to set palette, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_GetDC(primary, &dc);
    ok(SUCCEEDED(hr), "Failed to get DC, hr %#lx.\n", hr);

    color = GetPixel(dc, 160, 240);
    ok(color == 0x00030000, "Clear index 3: Got unexpected color 0x%08x.\n", color);
    color = GetPixel(dc, 480, 240);
    ok(color == 0x00252423, "Clear index 4: Got unexpected color 0x%08x.\n", color);

    ddraw_palette_handle = SelectPalette(dc, GetStockObject(DEFAULT_PALETTE), FALSE);
    ok(ddraw_palette_handle == GetStockObject(DEFAULT_PALETTE),
            "Got unexpected palette %p, expected %p.\n",
            ddraw_palette_handle, GetStockObject(DEFAULT_PALETTE));
    SelectPalette(dc, ddraw_palette_handle, FALSE);

    /* The primary uses the system palette. In exclusive mode, the system palette matches
     * the ddraw palette attached to the primary, so the result is what you would expect
     * from a regular surface. Tests for the interaction between the ddraw palette and
     * the system palette are not included pending an application that depends on this.
     * The relation between those causes problems on Windows Vista and newer for games
     * like Age of Empires or StarCraft. Don't emulate it without a real need. */
    i = GetDIBColorTable(dc, 0, ARRAY_SIZE(rgbquad), rgbquad);
    ok(i == ARRAY_SIZE(rgbquad), "Expected count 255, got %u.\n", i);
    for (i = 0; i < ARRAY_SIZE(expected2); i++)
    {
        ok(!memcmp(&rgbquad[i], &expected2[i], sizeof(rgbquad[i])),
                "Got color table entry %u r=%#x g=%#x b=%#x, expected r=%#x g=%#x b=%#x.\n",
                i, rgbquad[i].rgbRed, rgbquad[i].rgbGreen, rgbquad[i].rgbBlue,
                expected2[i].rgbRed, expected2[i].rgbGreen, expected2[i].rgbBlue);
    }
    for (; i < ARRAY_SIZE(rgbquad); i++)
    {
        ok(!memcmp(&rgbquad[i], &rgb_zero, sizeof(rgbquad[i])),
                "Got color table entry %u r=%#x g=%#x b=%#x, expected r=0 g=0 b=0.\n",
                i, rgbquad[i].rgbRed, rgbquad[i].rgbGreen, rgbquad[i].rgbBlue);
    }
    hr = IDirectDrawSurface_ReleaseDC(primary, dc);
    ok(SUCCEEDED(hr), "Failed to release DC, hr %#lx.\n", hr);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT;
    surface_desc.dwWidth = 16;
    surface_desc.dwHeight = 16;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

    /* Here the offscreen surface appears to use the primary's palette,
     * but in all likelihood it is actually the system palette. */
    hr = IDirectDrawSurface_GetDC(surface, &dc);
    ok(SUCCEEDED(hr), "Failed to get DC, hr %#lx.\n", hr);
    i = GetDIBColorTable(dc, 0, ARRAY_SIZE(rgbquad), rgbquad);
    ok(i == ARRAY_SIZE(rgbquad), "Expected count 255, got %u.\n", i);
    for (i = 0; i < ARRAY_SIZE(expected2); i++)
    {
        ok(!memcmp(&rgbquad[i], &expected2[i], sizeof(rgbquad[i])),
                "Got color table entry %u r=%#x g=%#x b=%#x, expected r=%#x g=%#x b=%#x.\n",
                i, rgbquad[i].rgbRed, rgbquad[i].rgbGreen, rgbquad[i].rgbBlue,
                expected2[i].rgbRed, expected2[i].rgbGreen, expected2[i].rgbBlue);
    }
    for (; i < ARRAY_SIZE(rgbquad); i++)
    {
        ok(!memcmp(&rgbquad[i], &rgb_zero, sizeof(rgbquad[i])),
                "Got color table entry %u r=%#x g=%#x b=%#x, expected r=0 g=0 b=0.\n",
                i, rgbquad[i].rgbRed, rgbquad[i].rgbGreen, rgbquad[i].rgbBlue);
    }
    hr = IDirectDrawSurface_ReleaseDC(surface, dc);
    ok(SUCCEEDED(hr), "Failed to release DC, hr %#lx.\n", hr);

    /* On real hardware a change to the primary surface's palette applies immediately,
     * even on device contexts from offscreen surfaces that do not have their own
     * palette. On the testbot VMs this is not the case. Don't test this until we
     * know of an application that depends on this. */

    memset(palette_entries, 0, sizeof(palette_entries));
    palette_entries[1].peBlue = 0x40;
    palette_entries[2].peRed = 0x40;
    palette_entries[3].peGreen = 0x40;
    palette_entries[4].peRed = 0x12;
    palette_entries[4].peGreen = 0x34;
    palette_entries[4].peBlue = 0x56;
    hr = IDirectDraw2_CreatePalette(ddraw, DDPCAPS_8BIT | DDPCAPS_ALLOW256,
            palette_entries, &palette2, NULL);
    ok(SUCCEEDED(hr), "Failed to create palette, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_SetPalette(surface, palette2);
    ok(SUCCEEDED(hr), "Failed to set palette, hr %#lx.\n", hr);

    /* A palette assigned to the offscreen surface overrides the primary / system
     * palette. */
    hr = IDirectDrawSurface_GetDC(surface, &dc);
    ok(SUCCEEDED(hr), "Failed to get DC, hr %#lx.\n", hr);
    i = GetDIBColorTable(dc, 0, ARRAY_SIZE(rgbquad), rgbquad);
    ok(i == ARRAY_SIZE(rgbquad), "Expected count 255, got %u.\n", i);
    for (i = 0; i < ARRAY_SIZE(expected3); i++)
    {
        ok(!memcmp(&rgbquad[i], &expected3[i], sizeof(rgbquad[i])),
                "Got color table entry %u r=%#x g=%#x b=%#x, expected r=%#x g=%#x b=%#x.\n",
                i, rgbquad[i].rgbRed, rgbquad[i].rgbGreen, rgbquad[i].rgbBlue,
                expected3[i].rgbRed, expected3[i].rgbGreen, expected3[i].rgbBlue);
    }
    for (; i < ARRAY_SIZE(rgbquad); i++)
    {
        ok(!memcmp(&rgbquad[i], &rgb_zero, sizeof(rgbquad[i])),
                "Got color table entry %u r=%#x g=%#x b=%#x, expected r=0 g=0 b=0.\n",
                i, rgbquad[i].rgbRed, rgbquad[i].rgbGreen, rgbquad[i].rgbBlue);
    }
    hr = IDirectDrawSurface_ReleaseDC(surface, dc);
    ok(SUCCEEDED(hr), "Failed to release DC, hr %#lx.\n", hr);

    refcount = IDirectDrawSurface_Release(surface);
    ok(!refcount, "Got unexpected refcount %lu.\n", refcount);

    /* The Windows 8 testbot keeps extra references to the primary and
     * backbuffer while in 8 bpp mode. */
    hr = IDirectDraw2_RestoreDisplayMode(ddraw);
    ok(SUCCEEDED(hr), "Failed to restore display mode, hr %#lx.\n", hr);

    refcount =  IDirectDrawSurface_Release(primary);
    ok(!refcount, "Got unexpected refcount %lu.\n", refcount);
    refcount = IDirectDrawPalette_Release(palette2);
    ok(!refcount, "Got unexpected refcount %lu.\n", refcount);
    refcount = IDirectDrawPalette_Release(palette);
    ok(!refcount, "Got unexpected refcount %lu.\n", refcount);
    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "Got unexpected refcount %lu.\n", refcount);
    DestroyWindow(window);
}

static void test_palette_alpha(void)
{
    IDirectDrawSurface *surface1;
    IDirectDrawSurface2 *surface;
    DDSURFACEDESC surface_desc;
    IDirectDraw2 *ddraw;
    IDirectDrawPalette *palette;
    ULONG refcount;
    HWND window;
    HRESULT hr;
    PALETTEENTRY palette_entries[256];
    unsigned int i;
    static const struct
    {
        DWORD caps, flags;
        BOOL attach_allowed;
        const char *name;
    }
    test_data[] =
    {
        {DDSCAPS_OFFSCREENPLAIN, DDSD_WIDTH | DDSD_HEIGHT, FALSE, "offscreenplain"},
        {DDSCAPS_TEXTURE, DDSD_WIDTH | DDSD_HEIGHT, TRUE, "texture"},
        {DDSCAPS_PRIMARYSURFACE, 0, FALSE, "primary"}
    };

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    if (FAILED(IDirectDraw2_SetDisplayMode(ddraw, 640, 480, 8, 0, 0)))
    {
        win_skip("Failed to set 8 bpp display mode, skipping test.\n");
        IDirectDraw2_Release(ddraw);
        DestroyWindow(window);
        return;
    }
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    memset(palette_entries, 0, sizeof(palette_entries));
    palette_entries[1].peFlags = 0x42;
    palette_entries[2].peFlags = 0xff;
    palette_entries[3].peFlags = 0x80;
    hr = IDirectDraw2_CreatePalette(ddraw, DDPCAPS_ALLOW256 | DDPCAPS_8BIT, palette_entries, &palette, NULL);
    ok(SUCCEEDED(hr), "Failed to create palette, hr %#lx.\n", hr);

    memset(palette_entries, 0x66, sizeof(palette_entries));
    hr = IDirectDrawPalette_GetEntries(palette, 0, 1, 4, palette_entries);
    ok(SUCCEEDED(hr), "Failed to get palette entries, hr %#lx.\n", hr);
    ok(palette_entries[0].peFlags == 0x42, "Got unexpected peFlags 0x%02x, expected 0xff.\n",
            palette_entries[0].peFlags);
    ok(palette_entries[1].peFlags == 0xff, "Got unexpected peFlags 0x%02x, expected 0xff.\n",
            palette_entries[1].peFlags);
    ok(palette_entries[2].peFlags == 0x80, "Got unexpected peFlags 0x%02x, expected 0x80.\n",
            palette_entries[2].peFlags);
    ok(palette_entries[3].peFlags == 0x00, "Got unexpected peFlags 0x%02x, expected 0x00.\n",
            palette_entries[3].peFlags);

    IDirectDrawPalette_Release(palette);

    memset(palette_entries, 0, sizeof(palette_entries));
    palette_entries[1].peFlags = 0x42;
    palette_entries[1].peRed   = 0xff;
    palette_entries[2].peFlags = 0xff;
    palette_entries[3].peFlags = 0x80;
    hr = IDirectDraw2_CreatePalette(ddraw, DDPCAPS_ALLOW256 | DDPCAPS_8BIT | DDPCAPS_ALPHA,
            palette_entries, &palette, NULL);
    ok(SUCCEEDED(hr), "Failed to create palette, hr %#lx.\n", hr);

    memset(palette_entries, 0x66, sizeof(palette_entries));
    hr = IDirectDrawPalette_GetEntries(palette, 0, 1, 4, palette_entries);
    ok(SUCCEEDED(hr), "Failed to get palette entries, hr %#lx.\n", hr);
    ok(palette_entries[0].peFlags == 0x42, "Got unexpected peFlags 0x%02x, expected 0xff.\n",
            palette_entries[0].peFlags);
    ok(palette_entries[1].peFlags == 0xff, "Got unexpected peFlags 0x%02x, expected 0xff.\n",
            palette_entries[1].peFlags);
    ok(palette_entries[2].peFlags == 0x80, "Got unexpected peFlags 0x%02x, expected 0x80.\n",
            palette_entries[2].peFlags);
    ok(palette_entries[3].peFlags == 0x00, "Got unexpected peFlags 0x%02x, expected 0x00.\n",
            palette_entries[3].peFlags);

    for (i = 0; i < ARRAY_SIZE(test_data); i++)
    {
        memset(&surface_desc, 0, sizeof(surface_desc));
        surface_desc.dwSize = sizeof(surface_desc);
        surface_desc.dwFlags = DDSD_CAPS | test_data[i].flags;
        surface_desc.dwWidth = 128;
        surface_desc.dwHeight = 128;
        surface_desc.ddsCaps.dwCaps = test_data[i].caps;
        hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface1, NULL);
        ok(SUCCEEDED(hr), "Failed to create %s surface, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_QueryInterface(surface1, &IID_IDirectDrawSurface2, (void **)&surface);
        ok(SUCCEEDED(hr), "Failed to get IDirectDrawSurface2 interface, hr %#lx.\n", hr);
        IDirectDrawSurface_Release(surface1);

        hr = IDirectDrawSurface2_SetPalette(surface, palette);
        if (test_data[i].attach_allowed)
            ok(SUCCEEDED(hr), "Failed to attach palette to %s surface, hr %#lx.\n", test_data[i].name, hr);
        else
            ok(hr == DDERR_INVALIDSURFACETYPE, "Got unexpected hr %#lx, %s surface.\n", hr, test_data[i].name);

        if (SUCCEEDED(hr))
        {
            HDC dc;
            RGBQUAD rgbquad;
            UINT retval;

            hr = IDirectDrawSurface2_GetDC(surface, &dc);
            ok(SUCCEEDED(hr) || broken(hr == DDERR_CANTCREATEDC) /* Win2k testbot */,
                    "Failed to get DC, hr %#lx, %s surface.\n", hr, test_data[i].name);
            if (SUCCEEDED(hr))
            {
                retval = GetDIBColorTable(dc, 1, 1, &rgbquad);
                ok(retval == 1, "GetDIBColorTable returned unexpected result %u.\n", retval);
                ok(rgbquad.rgbRed == 0xff, "Expected rgbRed = 0xff, got %#x, %s surface.\n",
                        rgbquad.rgbRed, test_data[i].name);
                ok(rgbquad.rgbGreen == 0, "Expected rgbGreen = 0, got %#x, %s surface.\n",
                        rgbquad.rgbGreen, test_data[i].name);
                ok(rgbquad.rgbBlue == 0, "Expected rgbBlue = 0, got %#x, %s surface.\n",
                        rgbquad.rgbBlue, test_data[i].name);
                ok(rgbquad.rgbReserved == 0, "Expected rgbReserved = 0, got %u, %s surface.\n",
                        rgbquad.rgbReserved, test_data[i].name);
                hr = IDirectDrawSurface2_ReleaseDC(surface, dc);
                ok(SUCCEEDED(hr), "Failed to release DC, hr %#lx.\n", hr);
            }
        }
        IDirectDrawSurface2_Release(surface);
    }

    /* Test INVALIDSURFACETYPE vs INVALIDPIXELFORMAT. */
    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT;
    surface_desc.dwWidth = 128;
    surface_desc.dwHeight = 128;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN;
    surface_desc.ddpfPixelFormat.dwSize = sizeof(surface_desc.ddpfPixelFormat);
    surface_desc.ddpfPixelFormat.dwFlags = DDPF_RGB;
    surface_desc.ddpfPixelFormat.dwRGBBitCount = 32;
    surface_desc.ddpfPixelFormat.dwRBitMask = 0x00ff0000;
    surface_desc.ddpfPixelFormat.dwGBitMask = 0x0000ff00;
    surface_desc.ddpfPixelFormat.dwBBitMask = 0x000000ff;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface1, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_QueryInterface(surface1, &IID_IDirectDrawSurface2, (void **)&surface);
    ok(SUCCEEDED(hr), "Failed to get IDirectDrawSurface2 interface, hr %#lx.\n", hr);
    IDirectDrawSurface_Release(surface1);

    hr = IDirectDrawSurface2_SetPalette(surface, palette);
    ok(hr == DDERR_INVALIDSURFACETYPE, "Got unexpected hr %#lx.\n", hr);
    IDirectDrawSurface2_Release(surface);

    /* The Windows 8 testbot keeps extra references to the primary
     * while in 8 bpp mode. */
    hr = IDirectDraw2_RestoreDisplayMode(ddraw);
    ok(SUCCEEDED(hr), "Failed to restore display mode, hr %#lx.\n", hr);

    refcount = IDirectDrawPalette_Release(palette);
    ok(!refcount, "Got unexpected refcount %lu.\n", refcount);
    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "Got unexpected refcount %lu.\n", refcount);
    DestroyWindow(window);
}

static void test_lost_device(void)
{
    IDirectDrawSurface *surface, *back_buffer, *back_buffer2, *ds;
    IDirectDrawSurface *sysmem_surface, *vidmem_surface;
    DDSURFACEDESC surface_desc;
    HWND window1, window2;
    IDirectDraw2 *ddraw;
    ULONG refcount;
    DDSCAPS caps;
    HRESULT hr;
    BOOL ret;

    window1 = CreateWindowA("static", "ddraw_test", WS_OVERLAPPEDWINDOW,
            0, 0, 640, 480, 0, 0, 0, 0);
    window2 = CreateWindowA("static", "ddraw_test", WS_OVERLAPPEDWINDOW,
            0, 0, 640, 480, 0, 0, 0, 0);
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window1, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_BACKBUFFERCOUNT;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE | DDSCAPS_COMPLEX | DDSCAPS_FLIP;
    surface_desc.dwBackBufferCount = 1;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN | DDSCAPS_SYSTEMMEMORY;
    surface_desc.dwWidth = 100;
    surface_desc.dwHeight = 100;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &sysmem_surface, NULL);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN | DDSCAPS_VIDEOMEMORY;
    surface_desc.dwWidth = 64;
    surface_desc.dwHeight = 64;
    surface_desc.ddpfPixelFormat.dwSize = sizeof(surface_desc.ddpfPixelFormat);
    surface_desc.ddpfPixelFormat.dwFlags = DDPF_RGB;
    surface_desc.ddpfPixelFormat.dwRGBBitCount = 32;
    surface_desc.ddpfPixelFormat.dwRBitMask = 0x00ff0000;
    surface_desc.ddpfPixelFormat.dwGBitMask = 0x0000ff00;
    surface_desc.ddpfPixelFormat.dwBBitMask = 0x000000ff;
    if (FAILED(IDirectDraw2_CreateSurface(ddraw, &surface_desc, &vidmem_surface, NULL)))
    {
        skip("Failed to create video memory surface, skipping related tests.\n");
        vidmem_surface = NULL;
    }

    hr = IDirectDrawSurface_IsLost(surface);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Flip(surface, NULL, DDFLIP_WAIT);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(sysmem_surface);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    if (vidmem_surface)
    {
        hr = IDirectDrawSurface_IsLost(vidmem_surface);
        ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    }

    ret = SetForegroundWindow(foreground);
    ok(ret, "Failed to set foreground window.\n");
    hr = IDirectDrawSurface_IsLost(surface);
    ok(hr == DDERR_SURFACELOST, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Flip(surface, NULL, DDFLIP_WAIT);
    ok(hr == DDERR_SURFACELOST, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Restore(surface);
    ok(hr == DDERR_WRONGMODE, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(surface);
    ok(hr == DDERR_SURFACELOST, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(sysmem_surface);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Restore(sysmem_surface);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(sysmem_surface);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    if (vidmem_surface)
    {
        hr = IDirectDrawSurface_IsLost(vidmem_surface);
        ok(hr == DDERR_SURFACELOST, "Got unexpected hr %#lx.\n", hr);
        hr = IDirectDrawSurface_Restore(vidmem_surface);
        ok(hr == DDERR_WRONGMODE, "Got unexpected hr %#lx.\n", hr);
        hr = IDirectDrawSurface_IsLost(vidmem_surface);
        ok(hr == DDERR_SURFACELOST, "Got unexpected hr %#lx.\n", hr);
    }

    ret = SetForegroundWindow(window1);
    ok(ret, "Failed to set foreground window.\n");
    hr = IDirectDrawSurface_IsLost(surface);
    ok(hr == DDERR_SURFACELOST, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Flip(surface, NULL, DDFLIP_WAIT);
    ok(hr == DDERR_SURFACELOST, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(sysmem_surface);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    if (vidmem_surface)
    {
        hr = IDirectDrawSurface_IsLost(vidmem_surface);
        ok(hr == DDERR_SURFACELOST, "Got unexpected hr %#lx.\n", hr);
    }

    hr = restore_surfaces(ddraw);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(surface);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Flip(surface, NULL, DDFLIP_WAIT);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(sysmem_surface);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    if (vidmem_surface)
    {
        hr = IDirectDrawSurface_IsLost(vidmem_surface);
        ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    }

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window1, DDSCL_NORMAL);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(surface);
    todo_wine ok(hr == DDERR_SURFACELOST, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Flip(surface, NULL, DDFLIP_WAIT);
    todo_wine ok(hr == DDERR_SURFACELOST, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(sysmem_surface);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    if (vidmem_surface)
    {
        hr = IDirectDrawSurface_IsLost(vidmem_surface);
        todo_wine ok(hr == DDERR_SURFACELOST, "Got unexpected hr %#lx.\n", hr);
    }

    /* Trying to restore the primary will crash, probably because flippable
     * surfaces can't exist in DDSCL_NORMAL. */
    IDirectDrawSurface_Release(surface);
    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = restore_surfaces(ddraw);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirectDrawSurface_IsLost(surface);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

    ret = SetForegroundWindow(foreground);
    ok(ret, "Failed to set foreground window.\n");
    hr = IDirectDrawSurface_IsLost(surface);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(sysmem_surface);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    if (vidmem_surface)
    {
        hr = IDirectDrawSurface_IsLost(vidmem_surface);
        ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    }

    ret = SetForegroundWindow(window1);
    ok(ret, "Failed to set foreground window.\n");
    hr = IDirectDrawSurface_IsLost(surface);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(sysmem_surface);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    if (vidmem_surface)
    {
        hr = IDirectDrawSurface_IsLost(vidmem_surface);
        ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    }

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window1, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(surface);
    ok(hr == DDERR_SURFACELOST, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(sysmem_surface);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    if (vidmem_surface)
    {
        hr = IDirectDrawSurface_IsLost(vidmem_surface);
        ok(hr == DDERR_SURFACELOST, "Got unexpected hr %#lx.\n", hr);
    }

    hr = restore_surfaces(ddraw);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(surface);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(sysmem_surface);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    if (vidmem_surface)
    {
        hr = IDirectDrawSurface_IsLost(vidmem_surface);
        ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    }

    IDirectDrawSurface_Release(surface);
    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_BACKBUFFERCOUNT;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE | DDSCAPS_COMPLEX | DDSCAPS_FLIP;
    surface_desc.dwBackBufferCount = 2;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

    ds = NULL;
    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    hr = IDirectDrawSurface2_GetSurfaceDesc(surface, &surface_desc);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    surface_desc.dwFlags = DDSD_CAPS | DDSD_ZBUFFERBITDEPTH | DDSD_WIDTH | DDSD_HEIGHT;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_ZBUFFER;
    surface_desc.dwZBufferBitDepth = 16;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &ds, NULL);
    if (FAILED(hr))
    {
        skip("Could not create Z buffer, skipping Z buffer restore test.\n");
    }
    else
    {
        hr = IDirectDrawSurface_AddAttachedSurface(surface, ds);
        ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    }

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window1, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(surface);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Flip(surface, NULL, DDFLIP_WAIT);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(sysmem_surface);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    if (vidmem_surface)
    {
        hr = IDirectDrawSurface_IsLost(vidmem_surface);
        ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    }

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window1, DDSCL_NORMAL | DDSCL_FULLSCREEN);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(surface);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Flip(surface, NULL, DDFLIP_WAIT);
    ok(hr == DDERR_NOEXCLUSIVEMODE, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(sysmem_surface);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    if (vidmem_surface)
    {
        hr = IDirectDrawSurface_IsLost(vidmem_surface);
        ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    }

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window1, DDSCL_NORMAL);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(surface);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Flip(surface, NULL, DDFLIP_WAIT);
    ok(hr == DDERR_NOEXCLUSIVEMODE, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(sysmem_surface);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    if (vidmem_surface)
    {
        hr = IDirectDrawSurface_IsLost(vidmem_surface);
        ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    }

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window2, DDSCL_NORMAL);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(surface);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Flip(surface, NULL, DDFLIP_WAIT);
    ok(hr == DDERR_NOEXCLUSIVEMODE, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(sysmem_surface);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    if (vidmem_surface)
    {
        hr = IDirectDrawSurface_IsLost(vidmem_surface);
        ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    }

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window2, DDSCL_NORMAL | DDSCL_FULLSCREEN);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(surface);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Flip(surface, NULL, DDFLIP_WAIT);
    ok(hr == DDERR_NOEXCLUSIVEMODE, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(sysmem_surface);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    if (vidmem_surface)
    {
        hr = IDirectDrawSurface_IsLost(vidmem_surface);
        ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    }

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window2, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(surface);
    ok(hr == DDERR_SURFACELOST, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Flip(surface, NULL, DDFLIP_WAIT);
    ok(hr == DDERR_SURFACELOST, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(sysmem_surface);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    if (vidmem_surface)
    {
        hr = IDirectDrawSurface_IsLost(vidmem_surface);
        ok(hr == DDERR_SURFACELOST, "Got unexpected hr %#lx.\n", hr);
    }

    memset(&caps, 0, sizeof(caps));
    caps.dwCaps = DDSCAPS_FLIP;

    hr = IDirectDrawSurface_GetAttachedSurface(surface, &caps, &back_buffer);
    ok(hr == DDERR_SURFACELOST, "Got unexpected hr %#lx.\n", hr);
    ok(back_buffer != surface, "Got the same surface.\n");
    hr = IDirectDrawSurface_Restore(surface);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_GetAttachedSurface(surface, &caps, &back_buffer);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(back_buffer);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    IDirectDrawSurface_Release(back_buffer);

    hr = IDirectDrawSurface_GetAttachedSurface(back_buffer, &caps, &back_buffer2);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    ok(back_buffer2 != back_buffer, "Got the same surface.\n");
    ok(back_buffer2 != surface, "Got the same surface.\n");
    hr = IDirectDrawSurface_IsLost(back_buffer2);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    IDirectDrawSurface_Release(back_buffer2);

    if (ds)
    {
        hr = IDirectDrawSurface_IsLost(ds);
        ok(hr == DDERR_SURFACELOST, "Got unexpected hr %#lx.\n", hr);
        hr = IDirectDrawSurface_Restore(ds);
        ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
        hr = IDirectDrawSurface_IsLost(ds);
        ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
        IDirectDrawSurface_Release(ds);
    }

    if (vidmem_surface)
        IDirectDrawSurface_Release(vidmem_surface);
    IDirectDrawSurface_Release(sysmem_surface);
    IDirectDrawSurface_Release(surface);
    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "Got unexpected refcount %lu.\n", refcount);
    DestroyWindow(window2);
    DestroyWindow(window1);
}

static void test_surface_desc_lock(void)
{
    IDirectDrawSurface *surface;
    DDSURFACEDESC surface_desc;
    IDirectDraw2 *ddraw;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT;
    surface_desc.dwWidth = 16;
    surface_desc.dwHeight = 16;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

    memset(&surface_desc, 0xaa, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    hr = IDirectDrawSurface_GetSurfaceDesc(surface, &surface_desc);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(!surface_desc.lpSurface, "Got unexpected lpSurface %p.\n", surface_desc.lpSurface);

    memset(&surface_desc, 0xaa, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    hr = IDirectDrawSurface_Lock(surface, NULL, &surface_desc, 0, NULL);
    ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx.\n", hr);
    ok(surface_desc.lpSurface != NULL, "Got unexpected lpSurface %p.\n", surface_desc.lpSurface);
    memset(&surface_desc, 0xaa, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    hr = IDirectDrawSurface_GetSurfaceDesc(surface, &surface_desc);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(!surface_desc.lpSurface, "Got unexpected lpSurface %p.\n", surface_desc.lpSurface);
    hr = IDirectDrawSurface_Unlock(surface, NULL);
    ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);

    memset(&surface_desc, 0xaa, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    hr = IDirectDrawSurface_GetSurfaceDesc(surface, &surface_desc);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(!surface_desc.lpSurface, "Got unexpected lpSurface %p.\n", surface_desc.lpSurface);

    IDirectDrawSurface_Release(surface);
    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "Got unexpected refcount %lu.\n", refcount);
    DestroyWindow(window);
}

static void test_texturemapblend(void)
{
    HRESULT hr;
    DDSURFACEDESC ddsd;
    DDBLTFX fx;
    static RECT rect = {0, 0, 64, 128};
    static D3DRECT clear_rect = {{0}, {0}, {640}, {480}};
    DDCOLORKEY ckey;
    IDirectDrawSurface *surface, *rt;
    IDirect3DTexture2 *texture;
    D3DTEXTUREHANDLE texture_handle;
    unsigned int color;
    HWND window;
    IDirectDraw2 *ddraw;
    IDirect3DDevice2 *device;
    IDirect3DMaterial2 *material;
    IDirect3DViewport2 *viewport;
    ULONG ref;

    static D3DTLVERTEX test1_quads[] =
    {
        {{0.0f},   {0.0f},   {0.0f}, {1.0f}, {0xffffffff}, {0}, {0.0f}, {0.0f}},
        {{0.0f},   {240.0f}, {0.0f}, {1.0f}, {0xffffffff}, {0}, {0.0f}, {1.0f}},
        {{640.0f}, {0.0f},   {0.0f}, {1.0f}, {0xffffffff}, {0}, {1.0f}, {0.0f}},
        {{640.0f}, {240.0f}, {0.0f}, {1.0f}, {0xffffffff}, {0}, {1.0f}, {1.0f}},
        {{0.0f},   {240.0f}, {0.0f}, {1.0f}, {0x80ffffff}, {0}, {0.0f}, {0.0f}},
        {{0.0f},   {480.0f}, {0.0f}, {1.0f}, {0x80ffffff}, {0}, {0.0f}, {1.0f}},
        {{640.0f}, {240.0f}, {0.0f}, {1.0f}, {0x80ffffff}, {0}, {1.0f}, {0.0f}},
        {{640.0f}, {480.0f}, {0.0f}, {1.0f}, {0x80ffffff}, {0}, {1.0f}, {1.0f}},
    },
    test2_quads[] =
    {
        {{0.0f},   {0.0f},   {0.0f}, {1.0f}, {0x00ff0080}, {0}, {0.0f}, {0.0f}},
        {{0.0f},   {240.0f}, {0.0f}, {1.0f}, {0x00ff0080}, {0}, {0.0f}, {1.0f}},
        {{640.0f}, {0.0f},   {0.0f}, {1.0f}, {0x00ff0080}, {0}, {1.0f}, {0.0f}},
        {{640.0f}, {240.0f}, {0.0f}, {1.0f}, {0x00ff0080}, {0}, {1.0f}, {1.0f}},
        {{0.0f},   {240.0f}, {0.0f}, {1.0f}, {0x008000ff}, {0}, {0.0f}, {0.0f}},
        {{0.0f},   {480.0f}, {0.0f}, {1.0f}, {0x008000ff}, {0}, {0.0f}, {1.0f}},
        {{640.0f}, {240.0f}, {0.0f}, {1.0f}, {0x008000ff}, {0}, {1.0f}, {0.0f}},
        {{640.0f}, {480.0f}, {0.0f}, {1.0f}, {0x008000ff}, {0}, {1.0f}, {1.0f}},
    };

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    if (!(device = create_device(ddraw, window, DDSCL_NORMAL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        DestroyWindow(window);
        IDirectDraw2_Release(ddraw);
        return;
    }

    hr = IDirect3DDevice2_GetRenderTarget(device, &rt);
    ok(SUCCEEDED(hr), "Failed to get render target, hr %#lx.\n", hr);

    material = create_diffuse_material(device, 0.0f, 0.0f, 0.0f, 1.0f);
    viewport = create_viewport(device, 0, 0, 640, 480);
    viewport_set_background(device, viewport, material);
    hr = IDirect3DDevice2_SetCurrentViewport(device, viewport);
    ok(SUCCEEDED(hr), "Failed to set current viewport, hr %#lx.\n", hr);

    /* Test alpha with DDPF_ALPHAPIXELS texture - should be taken from texture alpha channel.
     *
     * The vertex alpha is completely ignored in this case, so case 1 and 2 combined are not
     * a D3DTOP_MODULATE with texture alpha = 0xff in case 2 (no alpha in texture). */
    memset(&ddsd, 0, sizeof(ddsd));
    ddsd.dwSize = sizeof(ddsd);
    ddsd.dwFlags = DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PIXELFORMAT;
    ddsd.dwHeight = 128;
    ddsd.dwWidth = 128;
    ddsd.ddsCaps.dwCaps = DDSCAPS_TEXTURE;
    ddsd.ddpfPixelFormat.dwSize = sizeof(ddsd.ddpfPixelFormat);
    ddsd.ddpfPixelFormat.dwFlags = DDPF_RGB | DDPF_ALPHAPIXELS;
    ddsd.ddpfPixelFormat.dwRGBBitCount = 32;
    ddsd.ddpfPixelFormat.dwRBitMask = 0x00ff0000;
    ddsd.ddpfPixelFormat.dwGBitMask = 0x0000ff00;
    ddsd.ddpfPixelFormat.dwBBitMask = 0x000000ff;
    ddsd.ddpfPixelFormat.dwRGBAlphaBitMask = 0xff000000;
    hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &surface, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

    hr = IDirectDrawSurface_QueryInterface(surface, &IID_IDirect3DTexture2, (void **)&texture);
    ok(SUCCEEDED(hr), "Failed to get texture interface, hr %#lx.\n", hr);
    hr = IDirect3DTexture2_GetHandle(texture, device, &texture_handle);
    ok(SUCCEEDED(hr), "Failed to get texture handle, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_TEXTUREHANDLE, texture_handle);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);

    hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET);
    ok(SUCCEEDED(hr), "Failed to clear render target, hr %#lx.\n", hr);

    memset(&fx, 0, sizeof(fx));
    fx.dwSize = sizeof(fx);
    fx.dwFillColor = 0xff0000ff;
    hr = IDirectDrawSurface_Blt(surface, NULL, NULL, NULL, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
    ok(SUCCEEDED(hr), "Failed to clear texture, hr %#lx.\n", hr);
    fx.dwFillColor = 0x800000ff;
    hr = IDirectDrawSurface_Blt(surface, &rect, NULL, NULL, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
    ok(SUCCEEDED(hr), "Failed to clear texture, hr %#lx.\n", hr);

    /* Note that the ddraw1 version of this test runs tests 1-3 with D3DRENDERSTATE_COLORKEYENABLE
     * enabled, whereas this version only runs test 4 with color keying on. Because no color key
     * is set on the texture this should not result in different behavior. */
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_CULLMODE, D3DCULL_NONE);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_ZENABLE, D3DZB_FALSE);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_SRCBLEND, D3DBLEND_SRCALPHA);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_DESTBLEND, D3DBLEND_INVSRCALPHA);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_ALPHABLENDENABLE, TRUE);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_TEXTUREMAPBLEND, D3DTBLEND_MODULATE);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);

    hr = IDirect3DDevice2_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, D3DVT_TLVERTEX, &test1_quads[0], 4, 0);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, D3DVT_TLVERTEX, &test1_quads[4], 4, 0);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

    color = get_surface_color(rt, 5, 5);
    ok(compare_color(color, 0x00000080, 2), "Got unexpected color 0x%08x.\n", color);
    color = get_surface_color(rt, 400, 5);
    ok(compare_color(color, 0x000000ff, 2), "Got unexpected color 0x%08x.\n", color);
    color = get_surface_color(rt, 5, 245);
    ok(compare_color(color, 0x00000080, 2), "Got unexpected color 0x%08x.\n", color);
    color = get_surface_color(rt, 400, 245);
    ok(compare_color(color, 0x000000ff, 2), "Got unexpected color 0x%08x.\n", color);

    IDirect3DTexture2_Release(texture);
    ref = IDirectDrawSurface_Release(surface);
    ok(!ref, "Unexpected refcount %lu.\n", ref);

    /* Test alpha with texture that has no alpha channel - alpha should be taken from diffuse vertex color. */
    memset(&ddsd, 0, sizeof(ddsd));
    ddsd.dwSize = sizeof(ddsd);
    ddsd.dwFlags = DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PIXELFORMAT;
    ddsd.dwHeight = 128;
    ddsd.dwWidth = 128;
    ddsd.ddsCaps.dwCaps = DDSCAPS_TEXTURE;
    ddsd.ddpfPixelFormat.dwSize = sizeof(ddsd.ddpfPixelFormat);
    ddsd.ddpfPixelFormat.dwFlags = DDPF_RGB;
    ddsd.ddpfPixelFormat.dwRGBBitCount = 32;
    ddsd.ddpfPixelFormat.dwRBitMask = 0x00ff0000;
    ddsd.ddpfPixelFormat.dwGBitMask = 0x0000ff00;
    ddsd.ddpfPixelFormat.dwBBitMask = 0x000000ff;

    hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &surface, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

    hr = IDirectDrawSurface_QueryInterface(surface, &IID_IDirect3DTexture2, (void **)&texture);
    ok(SUCCEEDED(hr), "Failed to get texture interface, hr %#lx.\n", hr);
    hr = IDirect3DTexture2_GetHandle(texture, device, &texture_handle);
    ok(SUCCEEDED(hr), "Failed to get texture handle, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_TEXTUREHANDLE, texture_handle);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);

    hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET);
    ok(SUCCEEDED(hr), "Failed to clear render target, hr %#lx.\n", hr);

    fx.dwFillColor = 0xff0000ff;
    hr = IDirectDrawSurface_Blt(surface, NULL, NULL, NULL, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
    ok(SUCCEEDED(hr), "Failed to clear texture, hr %#lx.\n", hr);
    fx.dwFillColor = 0x800000ff;
    hr = IDirectDrawSurface_Blt(surface, &rect, NULL, NULL, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
    ok(SUCCEEDED(hr), "Failed to clear texture, hr %#lx.\n", hr);

    hr = IDirect3DDevice2_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, D3DVT_TLVERTEX, &test1_quads[0], 4, 0);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, D3DVT_TLVERTEX, &test1_quads[4], 4, 0);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

    color = get_surface_color(rt, 5, 5);
    ok(compare_color(color, 0x000000ff, 2), "Got unexpected color 0x%08x.\n", color);
    color = get_surface_color(rt, 400, 5);
    ok(compare_color(color, 0x000000ff, 2), "Got unexpected color 0x%08x.\n", color);
    color = get_surface_color(rt, 5, 245);
    ok(compare_color(color, 0x00000080, 2), "Got unexpected color 0x%08x.\n", color);
    color = get_surface_color(rt, 400, 245);
    ok(compare_color(color, 0x00000080, 2), "Got unexpected color 0x%08x.\n", color);

    IDirect3DTexture2_Release(texture);
    ref = IDirectDrawSurface_Release(surface);
    ok(!ref, "Unexpected refcount %lu.\n", ref);

    /* Test RGB - should multiply color components from diffuse vertex color and texture. */
    memset(&ddsd, 0, sizeof(ddsd));
    ddsd.dwSize = sizeof(ddsd);
    ddsd.dwFlags = DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PIXELFORMAT;
    ddsd.dwHeight = 128;
    ddsd.dwWidth = 128;
    ddsd.ddsCaps.dwCaps = DDSCAPS_TEXTURE;
    ddsd.ddpfPixelFormat.dwSize = sizeof(ddsd.ddpfPixelFormat);
    ddsd.ddpfPixelFormat.dwFlags = DDPF_RGB | DDPF_ALPHAPIXELS;
    ddsd.ddpfPixelFormat.dwRGBBitCount = 32;
    ddsd.ddpfPixelFormat.dwRBitMask = 0x00ff0000;
    ddsd.ddpfPixelFormat.dwGBitMask = 0x0000ff00;
    ddsd.ddpfPixelFormat.dwBBitMask = 0x000000ff;
    ddsd.ddpfPixelFormat.dwRGBAlphaBitMask = 0xff000000;
    hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &surface, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

    hr = IDirectDrawSurface_QueryInterface(surface, &IID_IDirect3DTexture2, (void **)&texture);
    ok(SUCCEEDED(hr), "Failed to get texture interface, hr %#lx.\n", hr);
    hr = IDirect3DTexture2_GetHandle(texture, device, &texture_handle);
    ok(SUCCEEDED(hr), "Failed to get texture handle, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_TEXTUREHANDLE, texture_handle);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);

    hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET);
    ok(SUCCEEDED(hr), "Failed to clear render target, hr %#lx.\n", hr);

    fx.dwFillColor = 0x00ffffff;
    hr = IDirectDrawSurface_Blt(surface, NULL, NULL, NULL, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
    ok(SUCCEEDED(hr), "Failed to clear texture, hr %#lx.\n", hr);
    fx.dwFillColor = 0x00ffff80;
    hr = IDirectDrawSurface_Blt(surface, &rect, NULL, NULL, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
    ok(SUCCEEDED(hr), "Failed to clear texture, hr %#lx.\n", hr);

    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_ALPHABLENDENABLE, FALSE);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);

    hr = IDirect3DDevice2_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, D3DVT_TLVERTEX, &test2_quads[0], 4, 0);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, D3DVT_TLVERTEX, &test2_quads[4], 4, 0);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

    color = get_surface_color(rt, 5, 5);
    ok(compare_color(color, 0x00ff0040, 2), "Got unexpected color 0x%08x.\n", color);
    color = get_surface_color(rt, 400, 5);
    ok(compare_color(color, 0x00ff0080, 2), "Got unexpected color 0x%08x.\n", color);
    color = get_surface_color(rt, 5, 245);
    ok(compare_color(color, 0x00800080, 2), "Got unexpected color 0x%08x.\n", color);
    color = get_surface_color(rt, 400, 245);
    ok(compare_color(color, 0x008000ff, 2), "Got unexpected color 0x%08x.\n", color);

    IDirect3DTexture2_Release(texture);
    ref = IDirectDrawSurface_Release(surface);
    ok(!ref, "Unexpected refcount %lu.\n", ref);

    /* Test alpha again, now with color keyed texture (colorkey emulation in wine can interfere). */
    memset(&ddsd, 0, sizeof(ddsd));
    ddsd.dwSize = sizeof(ddsd);
    ddsd.dwFlags = DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PIXELFORMAT;
    ddsd.dwHeight = 128;
    ddsd.dwWidth = 128;
    ddsd.ddsCaps.dwCaps = DDSCAPS_TEXTURE;
    ddsd.ddpfPixelFormat.dwSize = sizeof(ddsd.ddpfPixelFormat);
    ddsd.ddpfPixelFormat.dwFlags = DDPF_RGB;
    ddsd.ddpfPixelFormat.dwRGBBitCount = 16;
    ddsd.ddpfPixelFormat.dwRBitMask = 0xf800;
    ddsd.ddpfPixelFormat.dwGBitMask = 0x07e0;
    ddsd.ddpfPixelFormat.dwBBitMask = 0x001f;

    hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &surface, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

    hr = IDirectDrawSurface_QueryInterface(surface, &IID_IDirect3DTexture2, (void **)&texture);
    ok(SUCCEEDED(hr), "Failed to get texture interface, hr %#lx.\n", hr);
    hr = IDirect3DTexture2_GetHandle(texture, device, &texture_handle);
    ok(SUCCEEDED(hr), "Failed to get texture handle, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_TEXTUREHANDLE, texture_handle);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);

    hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET);
    ok(SUCCEEDED(hr), "Failed to clear render target, hr %#lx.\n", hr);

    fx.dwFillColor = 0xf800;
    hr = IDirectDrawSurface_Blt(surface, NULL, NULL, NULL, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
    ok(SUCCEEDED(hr), "Failed to clear texture, hr %#lx.\n", hr);
    fx.dwFillColor = 0x001f;
    hr = IDirectDrawSurface_Blt(surface, &rect, NULL, NULL, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
    ok(SUCCEEDED(hr), "Failed to clear texture, hr %#lx.\n", hr);

    ckey.dwColorSpaceLowValue = 0x001f;
    ckey.dwColorSpaceHighValue = 0x001f;
    hr = IDirectDrawSurface_SetColorKey(surface, DDCKEY_SRCBLT, &ckey);
    ok(SUCCEEDED(hr), "Failed to set color key, hr %#lx.\n", hr);

    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_ALPHABLENDENABLE, TRUE);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_COLORKEYENABLE, TRUE);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);

    hr = IDirect3DDevice2_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, D3DVT_TLVERTEX, &test1_quads[0], 4, 0);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, D3DVT_TLVERTEX, &test1_quads[4], 4, 0);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

    color = get_surface_color(rt, 5, 5);
    ok(compare_color(color, 0x00000000, 2), "Got unexpected color 0x%08x.\n", color);
    color = get_surface_color(rt, 400, 5);
    ok(compare_color(color, 0x00ff0000, 2), "Got unexpected color 0x%08x.\n", color);
    color = get_surface_color(rt, 5, 245);
    ok(compare_color(color, 0x00000000, 2), "Got unexpected color 0x%08x.\n", color);
    color = get_surface_color(rt, 400, 245);
    ok(compare_color(color, 0x00800000, 2), "Got unexpected color 0x%08x.\n", color);

    IDirect3DTexture2_Release(texture);
    ref = IDirectDrawSurface_Release(surface);
    ok(!ref, "Unexpected refcount %lu.\n", ref);

    destroy_viewport(device, viewport);
    ref = IDirect3DMaterial2_Release(material);
    ok(!ref, "Unexpected refcount %lu.\n", ref);
    IDirectDrawSurface_Release(rt);
    IDirect3DDevice2_Release(device);
    ref = IDirectDraw2_Release(ddraw);
    ok(!ref, "Unexpected refcount %lu.\n", ref);
    DestroyWindow(window);
}

static void test_viewport_clear_rect(void)
{
    HRESULT hr;
    static D3DRECT clear_rect = {{0}, {0}, {640}, {480}};
    static D3DRECT clear_rect2 = {{90}, {90}, {110}, {110}};
    IDirectDrawSurface *rt;
    unsigned int color;
    HWND window;
    IDirectDraw2 *ddraw;
    IDirect3DDevice2 *device;
    IDirect3DMaterial2 *red, *green;
    IDirect3DViewport2 *viewport, *viewport2;
    ULONG ref;

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    if (!(device = create_device(ddraw, window, DDSCL_NORMAL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        DestroyWindow(window);
        IDirectDraw2_Release(ddraw);
        return;
    }

    hr = IDirect3DDevice2_GetRenderTarget(device, &rt);
    ok(SUCCEEDED(hr), "Failed to get render target, hr %#lx.\n", hr);

    red = create_diffuse_material(device, 1.0f, 0.0f, 0.0f, 1.0f);
    viewport = create_viewport(device, 0, 0, 640, 480);
    viewport_set_background(device, viewport, red);
    hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET);
    ok(SUCCEEDED(hr), "Failed to clear viewport, hr %#lx.\n", hr);

    green = create_diffuse_material(device, 0.0f, 1.0f, 0.0f, 1.0f);
    viewport2 = create_viewport(device, 100, 100, 20, 20);
    viewport_set_background(device, viewport2, green);
    hr = IDirect3DViewport2_Clear(viewport2, 1, &clear_rect2, D3DCLEAR_TARGET);
    ok(SUCCEEDED(hr), "Failed to clear viewport, hr %#lx.\n", hr);

    color = get_surface_color(rt, 85, 85);  /* Outside both. */
    ok(compare_color(color, 0x00ff0000, 1), "Got unexpected color 0x%08x.\n", color);
    color = get_surface_color(rt, 95, 95); /* Outside vp, inside rect. */
    /* AMD GPUs ignore the viewport dimensions and only care about the rectangle. */
    ok(compare_color(color, 0x00ff0000, 1) || broken(compare_color(color, 0x0000ff00, 1)),
            "Got unexpected color 0x%08x.\n", color);
    color = get_surface_color(rt, 105, 105); /* Inside both. */
    ok(compare_color(color, 0x0000ff00, 1), "Got unexpected color 0x%08x.\n", color);
    color = get_surface_color(rt, 115, 115); /* Inside vp, outside rect. */
    ok(compare_color(color, 0x00ff0000, 1), "Got unexpected color 0x%08x.\n", color);
    color = get_surface_color(rt, 125, 125); /* Outside both. */
    ok(compare_color(color, 0x00ff0000, 1), "Got unexpected color 0x%08x.\n", color);

    destroy_viewport(device, viewport2);
    destroy_material(green);
    destroy_viewport(device, viewport);
    destroy_material(red);
    IDirectDrawSurface_Release(rt);
    IDirect3DDevice2_Release(device);
    ref = IDirectDraw2_Release(ddraw);
    ok(!ref, "Unexpected refcount %lu.\n", ref);
    DestroyWindow(window);
}

static void test_color_fill(void)
{
    HRESULT hr;
    IDirect3DDevice2 *device;
    IDirectDraw2 *ddraw;
    IDirectDrawSurface *surface, *surface2;
    DDSURFACEDESC surface_desc;
    unsigned int i, *color;
    ULONG refcount;
    BOOL is_warp;
    HWND window;
    DDBLTFX fx;
    RECT rect = {5, 5, 7, 7};
    DWORD num_fourcc_codes, *fourcc_codes;
    DDCAPS hal_caps;
    BOOL support_uyvy = FALSE, support_yuy2 = FALSE;
    static const struct
    {
        DWORD caps;
        HRESULT colorfill_hr, depthfill_hr;
        BOOL rop_success;
        const char *name;
        unsigned int result;
        BOOL check_result;
        DDPIXELFORMAT format;
    }
    tests[] =
    {
        {
            DDSCAPS_OFFSCREENPLAIN | DDSCAPS_VIDEOMEMORY,
            DD_OK, DDERR_INVALIDPARAMS, TRUE, "vidmem offscreenplain RGB", 0xdeadbeef, TRUE,
            {
                sizeof(DDPIXELFORMAT), DDPF_RGB | DDPF_ALPHAPIXELS, 0,
                {32}, {0x00ff0000}, {0x0000ff00}, {0x000000ff}, {0xff000000}
            }
        },
        {
            DDSCAPS_OFFSCREENPLAIN | DDSCAPS_SYSTEMMEMORY,
            DD_OK, DDERR_INVALIDPARAMS, TRUE, "sysmem offscreenplain RGB", 0xdeadbeef, TRUE,
            {
                sizeof(DDPIXELFORMAT), DDPF_RGB | DDPF_ALPHAPIXELS, 0,
                {32}, {0x00ff0000}, {0x0000ff00}, {0x000000ff}, {0xff000000}
            }
        },
        {
            DDSCAPS_TEXTURE | DDSCAPS_VIDEOMEMORY,
            DD_OK, DDERR_INVALIDPARAMS, TRUE, "vidmem texture RGB", 0xdeadbeef, TRUE,
            {
                sizeof(DDPIXELFORMAT), DDPF_RGB | DDPF_ALPHAPIXELS, 0,
                {32}, {0x00ff0000}, {0x0000ff00}, {0x000000ff}, {0xff000000}
            }
        },
        {
            DDSCAPS_TEXTURE | DDSCAPS_SYSTEMMEMORY,
            DD_OK, DDERR_INVALIDPARAMS, TRUE, "sysmem texture RGB", 0xdeadbeef, TRUE,
            {
                sizeof(DDPIXELFORMAT), DDPF_RGB | DDPF_ALPHAPIXELS, 0,
                {32}, {0x00ff0000}, {0x0000ff00}, {0x000000ff}, {0xff000000}
            }
        },
        {
            DDSCAPS_ZBUFFER | DDSCAPS_VIDEOMEMORY,
            DDERR_INVALIDPARAMS, DD_OK, TRUE, "vidmem zbuffer", 0xdeadbeef, TRUE,
            {0, 0, 0, {0}, {0}, {0}, {0}, {0}}
        },
        {
            /* Colorfill on YUV surfaces always returns DD_OK, but the content is
             * different afterwards. DX9+ GPUs set one of the two luminance values
             * in each block, but AMD and Nvidia GPUs disagree on which luminance
             * value they set. r200 (dx8) just sets the entire block to the clear
             * value. */
            DDSCAPS_OFFSCREENPLAIN | DDSCAPS_VIDEOMEMORY,
            DD_OK, DDERR_INVALIDPARAMS, FALSE, "vidmem offscreenplain YUY2", 0, FALSE,
            {
                sizeof(DDPIXELFORMAT), DDPF_FOURCC, MAKEFOURCC('Y', 'U', 'Y', '2'),
                {0}, {0}, {0}, {0}, {0}
            }
        },
        {
            DDSCAPS_OFFSCREENPLAIN | DDSCAPS_VIDEOMEMORY,
            DD_OK, DDERR_INVALIDPARAMS, FALSE, "vidmem offscreenplain UYVY", 0, FALSE,
            {
                sizeof(DDPIXELFORMAT), DDPF_FOURCC, MAKEFOURCC('U', 'Y', 'V', 'Y'),
                {0}, {0}, {0}, {0}, {0}
            }
        },
        {
            DDSCAPS_OVERLAY | DDSCAPS_VIDEOMEMORY,
            DD_OK, DDERR_INVALIDPARAMS, FALSE, "vidmem overlay YUY2", 0, FALSE,
            {
                sizeof(DDPIXELFORMAT), DDPF_FOURCC, MAKEFOURCC('Y', 'U', 'Y', '2'),
                {0}, {0}, {0}, {0}, {0}
            }
        },
        {
            DDSCAPS_OVERLAY | DDSCAPS_VIDEOMEMORY,
            DD_OK, DDERR_INVALIDPARAMS, FALSE, "vidmem overlay UYVY", 0, FALSE,
            {
                sizeof(DDPIXELFORMAT), DDPF_FOURCC, MAKEFOURCC('U', 'Y', 'V', 'Y'),
                {0}, {0}, {0}, {0}, {0}
            }
        },
        {
            DDSCAPS_TEXTURE | DDSCAPS_VIDEOMEMORY,
            E_NOTIMPL, DDERR_INVALIDPARAMS, FALSE, "vidmem texture DXT1", 0, FALSE,
            {
                sizeof(DDPIXELFORMAT), DDPF_FOURCC, MAKEFOURCC('D', 'X', 'T', '1'),
                {0}, {0}, {0}, {0}, {0}
            }
        },
        {
            DDSCAPS_TEXTURE | DDSCAPS_SYSTEMMEMORY,
            E_NOTIMPL, DDERR_INVALIDPARAMS, FALSE, "sysmem texture DXT1", 0, FALSE,
            {
                sizeof(DDPIXELFORMAT), DDPF_FOURCC, MAKEFOURCC('D', 'X', 'T', '1'),
                {0}, {0}, {0}, {0}, {0}
            }
        },
        {
            /* The testbot fills this with 0x00 instead of the blue channel. The sysmem
             * surface works, presumably because it is handled by the runtime instead of
             * the driver. */
            DDSCAPS_OFFSCREENPLAIN | DDSCAPS_VIDEOMEMORY,
            DD_OK, DDERR_INVALIDPARAMS, TRUE, "vidmem offscreenplain P8", 0xefefefef, FALSE,
            {
                sizeof(DDPIXELFORMAT), DDPF_RGB | DDPF_PALETTEINDEXED8, 0,
                {8}, {0}, {0}, {0}, {0}
            }
        },
        {
            DDSCAPS_OFFSCREENPLAIN | DDSCAPS_SYSTEMMEMORY,
            DD_OK, DDERR_INVALIDPARAMS, TRUE, "sysmem offscreenplain P8", 0xefefefef, TRUE,
            {
                sizeof(DDPIXELFORMAT), DDPF_RGB | DDPF_PALETTEINDEXED8, 0,
                {8}, {0}, {0}, {0}, {0}
            }
        },
    };
    static const struct
    {
        DWORD rop;
        const char *name;
        HRESULT hr;
    }
    rops[] =
    {
        {SRCCOPY,       "SRCCOPY",      DD_OK},
        {SRCPAINT,      "SRCPAINT",     DDERR_NORASTEROPHW},
        {SRCAND,        "SRCAND",       DDERR_NORASTEROPHW},
        {SRCINVERT,     "SRCINVERT",    DDERR_NORASTEROPHW},
        {SRCERASE,      "SRCERASE",     DDERR_NORASTEROPHW},
        {NOTSRCCOPY,    "NOTSRCCOPY",   DDERR_NORASTEROPHW},
        {NOTSRCERASE,   "NOTSRCERASE",  DDERR_NORASTEROPHW},
        {MERGECOPY,     "MERGECOPY",    DDERR_NORASTEROPHW},
        {MERGEPAINT,    "MERGEPAINT",   DDERR_NORASTEROPHW},
        {PATCOPY,       "PATCOPY",      DDERR_NORASTEROPHW},
        {PATPAINT,      "PATPAINT",     DDERR_NORASTEROPHW},
        {PATINVERT,     "PATINVERT",    DDERR_NORASTEROPHW},
        {DSTINVERT,     "DSTINVERT",    DDERR_NORASTEROPHW},
        {BLACKNESS,     "BLACKNESS",    DD_OK},
        {WHITENESS,     "WHITENESS",    DD_OK},
        {0xaa0029,      "0xaa0029",     DDERR_NORASTEROPHW} /* noop */
    };

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    is_warp = ddraw_is_warp(ddraw);
    if (!(device = create_device(ddraw, window, DDSCL_NORMAL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        DestroyWindow(window);
        IDirectDraw2_Release(ddraw);
        return;
    }

    hr = IDirectDraw2_GetFourCCCodes(ddraw, &num_fourcc_codes, NULL);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);
    fourcc_codes = calloc(num_fourcc_codes, sizeof(*fourcc_codes));
    if (!fourcc_codes)
        goto done;
    hr = IDirectDraw2_GetFourCCCodes(ddraw, &num_fourcc_codes, fourcc_codes);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);
    for (i = 0; i < num_fourcc_codes; i++)
    {
        if (fourcc_codes[i] == MAKEFOURCC('Y', 'U', 'Y', '2'))
            support_yuy2 = TRUE;
        else if (fourcc_codes[i] == MAKEFOURCC('U', 'Y', 'V', 'Y'))
            support_uyvy = TRUE;
    }
    free(fourcc_codes);

    memset(&hal_caps, 0, sizeof(hal_caps));
    hal_caps.dwSize = sizeof(hal_caps);
    hr = IDirectDraw2_GetCaps(ddraw, &hal_caps, NULL);
    ok(SUCCEEDED(hr), "Failed to get caps, hr %#lx.\n", hr);

    if ((!support_yuy2 && !support_uyvy) || !(hal_caps.dwCaps & DDCAPS_OVERLAY))
        skip("Overlays or some YUV formats not supported, skipping YUV colorfill tests.\n");

    for (i = 0; i < ARRAY_SIZE(tests); i++)
    {
        DWORD expected_broken = tests[i].result;
        unsigned int mask = 0xffffffffu;

        /* Some Windows drivers modify dwFillColor when it is used on P8 or FourCC formats. */
        memset(&fx, 0, sizeof(fx));
        fx.dwSize = sizeof(fx);
        fx.dwFillColor = 0xdeadbeef;

        memset(&surface_desc, 0, sizeof(surface_desc));
        surface_desc.dwSize = sizeof(surface_desc);
        surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT;
        surface_desc.dwWidth = 64;
        surface_desc.dwHeight = 64;
        surface_desc.ddpfPixelFormat = tests[i].format;
        surface_desc.ddsCaps.dwCaps = tests[i].caps;

        if (tests[i].caps & DDSCAPS_TEXTURE)
        {
            struct format_support_check check = {&tests[i].format, FALSE};
            hr = IDirect3DDevice2_EnumTextureFormats(device, test_unsupported_formats_cb, &check);
            ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);
            if (!check.supported)
                continue;
        }

        if (tests[i].format.dwFourCC == MAKEFOURCC('Y','U','Y','2') && !support_yuy2)
            continue;
        if (tests[i].format.dwFourCC == MAKEFOURCC('U','Y','V','Y') && !support_uyvy)
            continue;
        if (tests[i].caps & DDSCAPS_OVERLAY && !(hal_caps.dwCaps & DDCAPS_OVERLAY))
            continue;

        if (tests[i].caps & DDSCAPS_ZBUFFER)
        {
            surface_desc.dwFlags &= ~DDSD_PIXELFORMAT;
            surface_desc.dwFlags |= DDSD_ZBUFFERBITDEPTH;
            surface_desc.dwZBufferBitDepth = get_device_z_depth(device);
            mask >>= (32 - surface_desc.dwZBufferBitDepth);
            /* Some drivers seem to convert depth values incorrectly or not at
             * all. Affects at least AMD PALM, 8.17.10.1247. */
            if (tests[i].caps & DDSCAPS_VIDEOMEMORY)
            {
                DWORD expected;
                float f, g;

                expected = tests[i].result & mask;
                f = ceilf(logf(expected + 1.0f) / logf(2.0f));
                g = (f + 1.0f) / 2.0f;
                g -= (int)g;
                expected_broken = (expected / exp2f(f) - g) * 256;
                expected_broken *= 0x01010101;
            }
        }

        hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
        ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx, surface %s.\n", hr, tests[i].name);

        hr = IDirectDrawSurface_Blt(surface, NULL, NULL, NULL, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
        todo_wine_if (tests[i].format.dwFourCC)
            ok(hr == tests[i].colorfill_hr, "Blt returned %#lx, expected %#lx, surface %s.\n",
                    hr, tests[i].colorfill_hr, tests[i].name);

        hr = IDirectDrawSurface_Blt(surface, &rect, NULL, NULL, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
        todo_wine_if (tests[i].format.dwFourCC)
            ok(hr == tests[i].colorfill_hr, "Blt returned %#lx, expected %#lx, surface %s.\n",
                    hr, tests[i].colorfill_hr, tests[i].name);

        if (SUCCEEDED(hr) && tests[i].check_result)
        {
            memset(&surface_desc, 0, sizeof(surface_desc));
            surface_desc.dwSize = sizeof(surface_desc);
            hr = IDirectDrawSurface_Lock(surface, NULL, &surface_desc, DDLOCK_READONLY, 0);
            ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx, surface %s.\n", hr, tests[i].name);
            color = surface_desc.lpSurface;
            ok(*color == tests[i].result, "Got clear result 0x%08x, expected 0x%08x, surface %s.\n",
                    *color, tests[i].result, tests[i].name);
            hr = IDirectDrawSurface_Unlock(surface, NULL);
            ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx, surface %s.\n", hr, tests[i].name);
        }

        hr = IDirectDrawSurface_Blt(surface, NULL, NULL, NULL, DDBLT_DEPTHFILL | DDBLT_WAIT, &fx);
        ok(hr == tests[i].depthfill_hr, "Blt returned %#lx, expected %#lx, surface %s.\n",
                hr, tests[i].depthfill_hr, tests[i].name);
        hr = IDirectDrawSurface_Blt(surface, &rect, NULL, NULL, DDBLT_DEPTHFILL | DDBLT_WAIT, &fx);
        ok(hr == tests[i].depthfill_hr, "Blt returned %#lx, expected %#lx, surface %s.\n",
                hr, tests[i].depthfill_hr, tests[i].name);

        if (SUCCEEDED(hr) && tests[i].check_result)
        {
            memset(&surface_desc, 0, sizeof(surface_desc));
            surface_desc.dwSize = sizeof(surface_desc);
            hr = IDirectDrawSurface_Lock(surface, NULL, &surface_desc, DDLOCK_READONLY, 0);
            ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx, surface %s.\n", hr, tests[i].name);
            color = surface_desc.lpSurface;
            todo_wine_if(tests[i].caps & DDSCAPS_VIDEOMEMORY && surface_desc.dwZBufferBitDepth != 16)
                ok((*color & mask) == (tests[i].result & mask) || broken((*color & mask) == (expected_broken & mask))
                        || broken(is_warp && (*color & mask) == (~0u & mask)) /* Windows 8+ testbot. */,
                        "Got clear result 0x%08x, expected 0x%08x, surface %s.\n",
                        *color & mask, tests[i].result & mask, tests[i].name);
            hr = IDirectDrawSurface_Unlock(surface, NULL);
            ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx, surface %s.\n", hr, tests[i].name);
        }

        fx.dwFillColor = 0xdeadbeef;
        fx.dwROP = BLACKNESS;
        hr = IDirectDrawSurface_Blt(surface, NULL, NULL, NULL, DDBLT_ROP | DDBLT_WAIT, &fx);
        ok(FAILED(hr) == !tests[i].rop_success, "Blt returned %#lx, expected %s, surface %s.\n",
                hr, tests[i].rop_success ? "success" : "failure", tests[i].name);
        ok(fx.dwFillColor == 0xdeadbeef, "dwFillColor was set to 0x%08lx, surface %s\n",
                fx.dwFillColor, tests[i].name);

        if (SUCCEEDED(hr) && tests[i].check_result)
        {
            memset(&surface_desc, 0, sizeof(surface_desc));
            surface_desc.dwSize = sizeof(surface_desc);
            hr = IDirectDrawSurface_Lock(surface, NULL, &surface_desc, DDLOCK_READONLY, 0);
            ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx, surface %s.\n", hr, tests[i].name);
            color = surface_desc.lpSurface;
            ok(*color == 0, "Got clear result 0x%08x, expected 0x00000000, surface %s.\n",
                    *color, tests[i].name);
            hr = IDirectDrawSurface_Unlock(surface, NULL);
            ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx, surface %s.\n", hr, tests[i].name);
        }

        fx.dwROP = WHITENESS;
        hr = IDirectDrawSurface_Blt(surface, NULL, NULL, NULL, DDBLT_ROP | DDBLT_WAIT, &fx);
        ok(FAILED(hr) == !tests[i].rop_success, "Blt returned %#lx, expected %s, surface %s.\n",
                hr, tests[i].rop_success ? "success" : "failure", tests[i].name);
        ok(fx.dwFillColor == 0xdeadbeef, "dwFillColor was set to 0x%08lx, surface %s\n",
                fx.dwFillColor, tests[i].name);

        if (SUCCEEDED(hr) && tests[i].check_result)
        {
            memset(&surface_desc, 0, sizeof(surface_desc));
            surface_desc.dwSize = sizeof(surface_desc);
            hr = IDirectDrawSurface_Lock(surface, NULL, &surface_desc, DDLOCK_READONLY, 0);
            ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx, surface %s.\n", hr, tests[i].name);
            color = surface_desc.lpSurface;
            /* WHITENESS sets the alpha channel to 0x00. Ignore this for now. */
            ok((*color & 0x00ffffff) == 0x00ffffff, "Got clear result 0x%08x, expected 0xffffffff, surface %s.\n",
                    *color, tests[i].name);
            hr = IDirectDrawSurface_Unlock(surface, NULL);
            ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx, surface %s.\n", hr, tests[i].name);
        }

        IDirectDrawSurface_Release(surface);
    }

    memset(&fx, 0, sizeof(fx));
    fx.dwSize = sizeof(fx);
    fx.dwFillColor = 0xdeadbeef;
    fx.dwROP = WHITENESS;

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT;
    surface_desc.dwWidth = 64;
    surface_desc.dwHeight = 64;
    surface_desc.ddpfPixelFormat.dwSize = sizeof(surface_desc.ddpfPixelFormat);
    surface_desc.ddpfPixelFormat.dwFlags = DDPF_RGB;
    surface_desc.ddpfPixelFormat.dwRGBBitCount = 32;
    surface_desc.ddpfPixelFormat.dwRBitMask = 0x00ff0000;
    surface_desc.ddpfPixelFormat.dwGBitMask = 0x0000ff00;
    surface_desc.ddpfPixelFormat.dwBBitMask = 0x000000ff;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN | DDSCAPS_SYSTEMMEMORY;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface2, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

    /* No DDBLTFX. */
    hr = IDirectDrawSurface_Blt(surface, NULL, NULL, &rect, DDBLT_COLORFILL | DDBLT_WAIT, NULL);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Blt(surface, NULL, NULL, &rect, DDBLT_ROP | DDBLT_WAIT, NULL);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);

    /* Unused source rectangle. */
    hr = IDirectDrawSurface_Blt(surface, NULL, NULL, &rect, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
    ok(SUCCEEDED(hr), "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Blt(surface, NULL, NULL, &rect, DDBLT_ROP | DDBLT_WAIT, &fx);
    ok(SUCCEEDED(hr), "Got unexpected hr %#lx.\n", hr);

    /* Unused source surface. */
    hr = IDirectDrawSurface_Blt(surface, NULL, surface2, NULL, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Blt(surface, NULL, surface2, NULL, DDBLT_ROP | DDBLT_WAIT, &fx);
    ok(SUCCEEDED(hr), "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Blt(surface, NULL, surface2, &rect, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Blt(surface, NULL, surface2, &rect, DDBLT_ROP | DDBLT_WAIT, &fx);
    ok(SUCCEEDED(hr), "Got unexpected hr %#lx.\n", hr);

    /* Inverted destination or source rectangle. */
    SetRect(&rect, 5, 7, 7, 5);
    hr = IDirectDrawSurface_Blt(surface, &rect, NULL, NULL, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
    ok(hr == DDERR_INVALIDRECT, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Blt(surface, NULL, NULL, &rect, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
    ok(SUCCEEDED(hr), "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Blt(surface, &rect, surface2, NULL, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Blt(surface, NULL, surface2, &rect, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Blt(surface, NULL, surface2, &rect, DDBLT_ROP | DDBLT_WAIT, &fx);
    ok(hr == DDERR_INVALIDRECT, "Got unexpected hr %#lx.\n", hr);

    /* Negative rectangle. */
    SetRect(&rect, -1, -1, 5, 5);
    hr = IDirectDrawSurface_Blt(surface, &rect, NULL, NULL, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
    ok(hr == DDERR_INVALIDRECT, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Blt(surface, NULL, NULL, &rect, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
    ok(SUCCEEDED(hr), "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Blt(surface, &rect, surface2, NULL, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Blt(surface, &rect, surface2, &rect, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Blt(surface, NULL, surface2, &rect, DDBLT_ROP | DDBLT_WAIT, &fx);
    ok(hr == DDERR_INVALIDRECT, "Got unexpected hr %#lx.\n", hr);

    /* Out of bounds rectangle. */
    SetRect(&rect, 0, 0, 65, 65);
    hr = IDirectDrawSurface_Blt(surface, &rect, NULL, NULL, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
    ok(hr == DDERR_INVALIDRECT, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Blt(surface, NULL, surface2, &rect, DDBLT_ROP | DDBLT_WAIT, &fx);
    ok(hr == DDERR_INVALIDRECT, "Got unexpected hr %#lx.\n", hr);

    /* Combine multiple flags. */
    hr = IDirectDrawSurface_Blt(surface, NULL, NULL, NULL, DDBLT_COLORFILL | DDBLT_DEPTHFILL | DDBLT_WAIT, &fx);
    ok(SUCCEEDED(hr), "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Blt(surface, NULL, NULL, NULL, DDBLT_COLORFILL | DDBLT_ROP | DDBLT_WAIT, &fx);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Blt(surface, &rect, NULL, NULL, DDBLT_COLORFILL | DDBLT_ROP | DDBLT_WAIT, &fx);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);

    for (i = 0; i < ARRAY_SIZE(rops); i++)
    {
        fx.dwROP = rops[i].rop;
        hr = IDirectDrawSurface_Blt(surface, NULL, surface2, NULL, DDBLT_ROP | DDBLT_WAIT, &fx);
        ok(hr == rops[i].hr, "Got unexpected hr %#lx for rop %s.\n", hr, rops[i].name);
    }

    IDirectDrawSurface_Release(surface2);
    IDirectDrawSurface_Release(surface);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_ZBUFFERBITDEPTH;
    surface_desc.dwWidth = 64;
    surface_desc.dwHeight = 64;
    surface_desc.dwZBufferBitDepth = get_device_z_depth(device);
    surface_desc.ddsCaps.dwCaps = DDSCAPS_ZBUFFER;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface2, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

    /* No DDBLTFX. */
    hr = IDirectDrawSurface_Blt(surface, NULL, NULL, &rect, DDBLT_DEPTHFILL | DDBLT_WAIT, NULL);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);

    /* Unused source rectangle. */
    hr = IDirectDrawSurface_Blt(surface, NULL, NULL, &rect, DDBLT_DEPTHFILL | DDBLT_WAIT, &fx);
    ok(SUCCEEDED(hr), "Got unexpected hr %#lx.\n", hr);

    /* Unused source surface. */
    hr = IDirectDrawSurface_Blt(surface, NULL, surface2, NULL, DDBLT_DEPTHFILL | DDBLT_WAIT, &fx);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Blt(surface, NULL, surface2, &rect, DDBLT_DEPTHFILL | DDBLT_WAIT, &fx);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);

    /* Inverted destination or source rectangle. */
    SetRect(&rect, 5, 7, 7, 5);
    hr = IDirectDrawSurface_Blt(surface, &rect, NULL, NULL, DDBLT_DEPTHFILL | DDBLT_WAIT, &fx);
    ok(hr == DDERR_INVALIDRECT, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Blt(surface, NULL, NULL, &rect, DDBLT_DEPTHFILL | DDBLT_WAIT, &fx);
    ok(SUCCEEDED(hr), "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Blt(surface, &rect, surface2, NULL, DDBLT_DEPTHFILL | DDBLT_WAIT, &fx);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Blt(surface, NULL, surface2, &rect, DDBLT_DEPTHFILL | DDBLT_WAIT, &fx);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);

    /* Negative rectangle. */
    SetRect(&rect, -1, -1, 5, 5);
    hr = IDirectDrawSurface_Blt(surface, &rect, NULL, NULL, DDBLT_DEPTHFILL | DDBLT_WAIT, &fx);
    ok(hr == DDERR_INVALIDRECT, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Blt(surface, NULL, NULL, &rect, DDBLT_DEPTHFILL | DDBLT_WAIT, &fx);
    ok(SUCCEEDED(hr), "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Blt(surface, &rect, surface2, NULL, DDBLT_DEPTHFILL | DDBLT_WAIT, &fx);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Blt(surface, &rect, surface2, &rect, DDBLT_DEPTHFILL | DDBLT_WAIT, &fx);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);

    /* Out of bounds rectangle. */
    SetRect(&rect, 0, 0, 65, 65);
    hr = IDirectDrawSurface_Blt(surface, &rect, NULL, NULL, DDBLT_DEPTHFILL | DDBLT_WAIT, &fx);
    ok(hr == DDERR_INVALIDRECT, "Got unexpected hr %#lx.\n", hr);

    /* Combine multiple flags. */
    hr = IDirectDrawSurface_Blt(surface, NULL, NULL, NULL, DDBLT_COLORFILL | DDBLT_DEPTHFILL | DDBLT_WAIT, &fx);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);

    IDirectDrawSurface_Release(surface2);
    IDirectDrawSurface_Release(surface);

done:
    IDirect3DDevice2_Release(device);
    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "Unexpected refcount %lu.\n", refcount);
    DestroyWindow(window);
}

static void test_colorkey_precision(void)
{
    static D3DLVERTEX quad[] =
    {
        {{-1.0f}, {-1.0f}, {0.0f}, 0, {0xff000000}, {0}, {0.0f}, {0.0f}},
        {{-1.0f}, { 1.0f}, {0.0f}, 0, {0xff000000}, {0}, {0.0f}, {1.0f}},
        {{ 1.0f}, {-1.0f}, {0.0f}, 0, {0xff000000}, {0}, {1.0f}, {0.0f}},
        {{ 1.0f}, { 1.0f}, {0.0f}, 0, {0xff000000}, {0}, {1.0f}, {1.0f}},
    };
    static D3DRECT clear_rect = {{0}, {0}, {640}, {480}};
    unsigned int data[4] = {0}, color_mask, color, t, c;
    IDirect3DDevice2 *device;
    IDirectDraw2 *ddraw;
    IDirectDrawSurface *rt;
    IDirect3DViewport2 *viewport;
    HWND window;
    HRESULT hr;
    IDirectDrawSurface *src, *dst, *texture;
    D3DTEXTUREHANDLE handle;
    IDirect3DTexture2 *d3d_texture;
    IDirect3DMaterial2 *green;
    DDSURFACEDESC surface_desc, lock_desc;
    ULONG refcount;
    DDCOLORKEY ckey;
    DDBLTFX fx;
    BOOL is_nvidia, is_warp;
    static const struct
    {
        unsigned int max, shift, bpp, clear;
        const char *name;
        BOOL skip_nv;
        DDPIXELFORMAT fmt;
    }
    tests[] =
    {
        {
            255, 0, 4, 0x00345678, "D3DFMT_X8R8G8B8", FALSE,
            {
                sizeof(DDPIXELFORMAT), DDPF_RGB, 0,
                {32}, {0x00ff0000}, {0x0000ff00}, {0x000000ff}, {0x00000000}
            }

        },
        {
            63, 5, 2, 0x5678, "D3DFMT_R5G6B5, G channel", FALSE,
            {
                sizeof(DDPIXELFORMAT), DDPF_RGB, 0,
                {16}, {0xf800}, {0x07e0}, {0x001f}, {0x0000}
            }

        },
        {
            31, 0, 2, 0x5678, "D3DFMT_R5G6B5, B channel", FALSE,
            {
                sizeof(DDPIXELFORMAT), DDPF_RGB, 0,
                {16}, {0xf800}, {0x07e0}, {0x001f}, {0x0000}
            }

        },
        {
            15, 0, 2, 0x0678, "D3DFMT_A4R4G4B4", TRUE,
            {
                sizeof(DDPIXELFORMAT), DDPF_RGB | DDPF_ALPHAPIXELS, 0,
                {16}, {0x0f00}, {0x00f0}, {0x000f}, {0xf000}
            }
        },
    };

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    if (!(device = create_device(ddraw, window, DDSCL_NORMAL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        DestroyWindow(window);
        IDirectDraw2_Release(ddraw);
        return;
    }
    hr = IDirect3DDevice2_GetRenderTarget(device, &rt);
    ok(SUCCEEDED(hr), "Failed to get render target, hr %#lx.\n", hr);

    is_nvidia = ddraw_is_nvidia(ddraw);
    /* The Windows 8 WARP driver has plenty of false negatives in X8R8G8B8
     * (color key doesn't match although the values are equal), and a false
     * positive when the color key is 0 and the texture contains the value 1.
     * I don't want to mark this broken unconditionally since this would
     * essentially disable the test on Windows. Also on random occasions
     * 254 == 255 and 255 != 255.*/
    is_warp = ddraw_is_warp(ddraw);

    green = create_diffuse_material(device, 0.0f, 1.0f, 0.0f, 0.0f);
    viewport = create_viewport(device, 0, 0, 640, 480);
    viewport_set_background(device, viewport, green);
    hr = IDirect3DDevice2_SetCurrentViewport(device, viewport);
    ok(SUCCEEDED(hr), "Failed to activate the viewport, hr %#lx.\n", hr);

    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_ZENABLE, D3DZB_FALSE);
    ok(SUCCEEDED(hr), "Failed to disable z-buffering, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_COLORKEYENABLE, TRUE);
    ok(SUCCEEDED(hr), "Failed to enable color keying, hr %#lx.\n", hr);
    /* There's no way to ignore the texture color in d3d2, so multiply the texture color
     * with a black vertex color. */
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_TEXTUREMAPBLEND, D3DTBLEND_MODULATEALPHA);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);

    memset(&fx, 0, sizeof(fx));
    fx.dwSize = sizeof(fx);
    memset(&lock_desc, 0, sizeof(lock_desc));
    lock_desc.dwSize = sizeof(lock_desc);

    for (t = 0; t < ARRAY_SIZE(tests); ++t)
    {
        if (is_nvidia && tests[t].skip_nv)
        {
            win_skip("Skipping test %s on Nvidia Windows drivers.\n", tests[t].name);
            continue;
        }

        memset(&surface_desc, 0, sizeof(surface_desc));
        surface_desc.dwSize = sizeof(surface_desc);
        surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT;
        surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN;
        surface_desc.dwWidth = 4;
        surface_desc.dwHeight = 1;
        surface_desc.ddpfPixelFormat = tests[t].fmt;
        /* Windows XP (at least with the r200 driver, other drivers untested) produces
         * garbage when doing color keyed texture->texture blits. */
        hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &src, NULL);
        ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);
        hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &dst, NULL);
        ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

        fx.dwFillColor = tests[t].clear;
        /* On the w8 testbot (WARP driver) the blit result has different values in the
         * X channel. */
        color_mask = tests[t].fmt.dwRBitMask
                | tests[t].fmt.dwGBitMask
                | tests[t].fmt.dwBBitMask;

        for (c = 0; c <= tests[t].max; ++c)
        {
            /* The idiotic Nvidia Windows driver can't change the color key on a d3d
             * texture after it has been set once... */
            surface_desc.dwFlags |= DDSD_CKSRCBLT;
            surface_desc.ddsCaps.dwCaps = DDSCAPS_TEXTURE;
            surface_desc.ddckCKSrcBlt.dwColorSpaceLowValue = c << tests[t].shift;
            surface_desc.ddckCKSrcBlt.dwColorSpaceHighValue = c << tests[t].shift;
            hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &texture, NULL);
            ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

            hr = IDirectDrawSurface4_QueryInterface(texture, &IID_IDirect3DTexture2, (void **)&d3d_texture);
            ok(SUCCEEDED(hr), "Failed to get texture interface, hr %#lx.\n", hr);
            hr = IDirect3DTexture2_GetHandle(d3d_texture, device, &handle);
            ok(SUCCEEDED(hr), "Failed to get texture handle, hr %#lx.\n", hr);
            hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_TEXTUREHANDLE, handle);
            ok(SUCCEEDED(hr), "Failed to set texture handle, hr %#lx.\n", hr);
            IDirect3DTexture2_Release(d3d_texture);

            hr = IDirectDrawSurface_Blt(dst, NULL, NULL, NULL, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
            ok(SUCCEEDED(hr), "Failed to clear destination surface, hr %#lx.\n", hr);

            hr = IDirectDrawSurface_Lock(src, NULL, &lock_desc, DDLOCK_WAIT, NULL);
            ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx.\n", hr);
            switch (tests[t].bpp)
            {
                case 4:
                    ((DWORD *)lock_desc.lpSurface)[0] = (c ? c - 1 : 0) << tests[t].shift;
                    ((DWORD *)lock_desc.lpSurface)[1] = c << tests[t].shift;
                    ((DWORD *)lock_desc.lpSurface)[2] = min(c + 1, tests[t].max) << tests[t].shift;
                    ((DWORD *)lock_desc.lpSurface)[3] = 0xffffffff;
                    break;

                case 2:
                    ((WORD *)lock_desc.lpSurface)[0] = (c ? c - 1 : 0) << tests[t].shift;
                    ((WORD *)lock_desc.lpSurface)[1] = c << tests[t].shift;
                    ((WORD *)lock_desc.lpSurface)[2] = min(c + 1, tests[t].max) << tests[t].shift;
                    ((WORD *)lock_desc.lpSurface)[3] = 0xffff;
                    break;
            }
            hr = IDirectDrawSurface_Unlock(src, 0);
            ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);
            hr = IDirectDrawSurface_Blt(texture, NULL, src, NULL, DDBLT_WAIT, NULL);
            ok(SUCCEEDED(hr), "Failed to blit, hr %#lx.\n", hr);

            ckey.dwColorSpaceLowValue = c << tests[t].shift;
            ckey.dwColorSpaceHighValue = c << tests[t].shift;
            hr = IDirectDrawSurface_SetColorKey(src, DDCKEY_SRCBLT, &ckey);
            ok(SUCCEEDED(hr), "Failed to set color key, hr %#lx.\n", hr);

            hr = IDirectDrawSurface_Blt(dst, NULL, src, NULL, DDBLT_KEYSRC | DDBLT_WAIT, NULL);
            ok(SUCCEEDED(hr), "Failed to blit, hr %#lx.\n", hr);

            /* Don't make this read only, it somehow breaks the detection of the Nvidia bug below. */
            hr = IDirectDrawSurface_Lock(dst, NULL, &lock_desc, DDLOCK_WAIT, NULL);
            ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx.\n", hr);
            switch (tests[t].bpp)
            {
                case 4:
                    data[0] = ((DWORD *)lock_desc.lpSurface)[0] & color_mask;
                    data[1] = ((DWORD *)lock_desc.lpSurface)[1] & color_mask;
                    data[2] = ((DWORD *)lock_desc.lpSurface)[2] & color_mask;
                    data[3] = ((DWORD *)lock_desc.lpSurface)[3] & color_mask;
                    break;

                case 2:
                    data[0] = ((WORD *)lock_desc.lpSurface)[0] & color_mask;
                    data[1] = ((WORD *)lock_desc.lpSurface)[1] & color_mask;
                    data[2] = ((WORD *)lock_desc.lpSurface)[2] & color_mask;
                    data[3] = ((WORD *)lock_desc.lpSurface)[3] & color_mask;
                    break;
            }
            hr = IDirectDrawSurface_Unlock(dst, 0);
            ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);

            if (!c)
            {
                ok(data[0] == tests[t].clear, "Expected surface content %#x, got %#x, format %s, c=%u.\n",
                        tests[t].clear, data[0], tests[t].name, c);

                if (data[3] == tests[t].clear)
                {
                    /* My Geforce GTX 460 on Windows 7 misbehaves when A4R4G4B4 is blitted with color
                     * keying: The blit takes ~0.5 seconds, and subsequent color keying draws are broken,
                     * even when a different surface is used. The blit itself doesn't draw anything,
                     * so we can detect the bug by looking at the otherwise unused 4th texel. It should
                     * never be masked out by the key.
                     *
                     * On Windows 10 the problem is worse, Blt just hangs. For this reason the ARGB4444
                     * test is disabled entirely.
                     *
                     * Also appears to affect the testbot in some way with R5G6B5. Color keying is
                     * terrible on WARP. */
                    skip("Nvidia A4R4G4B4 color keying blit bug detected, skipping.\n");
                    IDirectDrawSurface_Release(texture);
                    IDirectDrawSurface_Release(src);
                    IDirectDrawSurface_Release(dst);
                    goto done;
                }
            }
            else
                ok(data[0] == (c - 1) << tests[t].shift, "Expected surface content %#x, got %#x, format %s, c=%u.\n",
                        (c - 1) << tests[t].shift, data[0], tests[t].name, c);

            ok(data[1] == tests[t].clear, "Expected surface content %#x, got %#x, format %s, c=%u.\n",
                    tests[t].clear, data[1], tests[t].name, c);

            if (c == tests[t].max)
                ok(data[2] == tests[t].clear, "Expected surface content %#x, got %#x, format %s, c=%u.\n",
                        tests[t].clear, data[2], tests[t].name, c);
            else
                ok(data[2] == (c + 1) << tests[t].shift, "Expected surface content %#x, got %#x, format %s, c=%u.\n",
                        (c + 1) << tests[t].shift, data[2], tests[t].name, c);

            hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET);
            ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);

            hr = IDirect3DDevice2_BeginScene(device);
            ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
            hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, D3DVT_LVERTEX, quad, 4, 0);
            ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
            hr = IDirect3DDevice2_EndScene(device);
            ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

            color = get_surface_color(rt, 80, 240);
            if (!c)
                ok(compare_color(color, 0x0000ff00, 1) || broken(is_warp && compare_color(color, 0x00000000, 1)),
                        "Got unexpected color 0x%08x, format %s, c=%u.\n",
                        color, tests[t].name, c);
            else
                ok(compare_color(color, 0x00000000, 1) || broken(is_warp && compare_color(color, 0x0000ff00, 1)),
                        "Got unexpected color 0x%08x, format %s, c=%u.\n",
                        color, tests[t].name, c);

            color = get_surface_color(rt, 240, 240);
            ok(compare_color(color, 0x0000ff00, 1) || broken(is_warp && compare_color(color, 0x00000000, 1)),
                    "Got unexpected color 0x%08x, format %s, c=%u.\n",
                    color, tests[t].name, c);

            color = get_surface_color(rt, 400, 240);
            if (c == tests[t].max)
                ok(compare_color(color, 0x0000ff00, 1) || broken(is_warp && compare_color(color, 0x00000000, 1)),
                        "Got unexpected color 0x%08x, format %s, c=%u.\n",
                        color, tests[t].name, c);
            else
                ok(compare_color(color, 0x00000000, 1) || broken(is_warp && compare_color(color, 0x0000ff00, 1)),
                        "Got unexpected color 0x%08x, format %s, c=%u.\n",
                        color, tests[t].name, c);

            hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_TEXTUREHANDLE, 0);
            ok(SUCCEEDED(hr), "Failed to set texture handle, hr %#lx.\n", hr);
            IDirectDrawSurface_Release(texture);
        }
        IDirectDrawSurface_Release(src);
        IDirectDrawSurface_Release(dst);
    }
done:

    destroy_viewport(device, viewport);
    destroy_material(green);
    IDirectDrawSurface_Release(rt);
    IDirect3DDevice2_Release(device);
    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "Unexpected refcount %lu.\n", refcount);
    DestroyWindow(window);
}

static void test_range_colorkey(void)
{
    IDirectDraw2 *ddraw;
    HWND window;
    HRESULT hr;
    IDirectDrawSurface *surface;
    DDSURFACEDESC surface_desc;
    ULONG refcount;
    DDCOLORKEY ckey;

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT | DDSD_CKSRCBLT;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_TEXTURE;
    surface_desc.dwWidth = 1;
    surface_desc.dwHeight = 1;
    surface_desc.ddpfPixelFormat.dwFlags = DDPF_RGB;
    surface_desc.ddpfPixelFormat.dwRGBBitCount = 32;
    surface_desc.ddpfPixelFormat.dwRBitMask = 0x00ff0000;
    surface_desc.ddpfPixelFormat.dwGBitMask = 0x0000ff00;
    surface_desc.ddpfPixelFormat.dwBBitMask = 0x000000ff;
    surface_desc.ddpfPixelFormat.dwRGBAlphaBitMask = 0x00000000;

    /* Creating a surface with a range color key fails with DDERR_NOCOLORKEY. */
    surface_desc.ddckCKSrcBlt.dwColorSpaceLowValue = 0x00000000;
    surface_desc.ddckCKSrcBlt.dwColorSpaceHighValue = 0x00000001;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
    ok(hr == DDERR_NOCOLORKEYHW, "Got unexpected hr %#lx.\n", hr);

    surface_desc.ddckCKSrcBlt.dwColorSpaceLowValue = 0x00000001;
    surface_desc.ddckCKSrcBlt.dwColorSpaceHighValue = 0x00000000;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
    ok(hr == DDERR_NOCOLORKEYHW, "Got unexpected hr %#lx.\n", hr);

    /* Same for DDSCAPS_OFFSCREENPLAIN. */
    surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN;
    surface_desc.ddckCKSrcBlt.dwColorSpaceLowValue = 0x00000000;
    surface_desc.ddckCKSrcBlt.dwColorSpaceHighValue = 0x00000001;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
    ok(hr == DDERR_NOCOLORKEYHW, "Got unexpected hr %#lx.\n", hr);

    surface_desc.ddckCKSrcBlt.dwColorSpaceLowValue = 0x00000001;
    surface_desc.ddckCKSrcBlt.dwColorSpaceHighValue = 0x00000000;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
    ok(hr == DDERR_NOCOLORKEYHW, "Got unexpected hr %#lx.\n", hr);

    surface_desc.ddckCKSrcBlt.dwColorSpaceLowValue = 0x00000000;
    surface_desc.ddckCKSrcBlt.dwColorSpaceHighValue = 0x00000000;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

    /* Setting a range color key without DDCKEY_COLORSPACE collapses the key. */
    ckey.dwColorSpaceLowValue = 0x00000000;
    ckey.dwColorSpaceHighValue = 0x00000001;
    hr = IDirectDrawSurface_SetColorKey(surface, DDCKEY_SRCBLT, &ckey);
    ok(SUCCEEDED(hr), "Failed to set color key, hr %#lx.\n", hr);

    hr = IDirectDrawSurface_GetColorKey(surface, DDCKEY_SRCBLT, &ckey);
    ok(SUCCEEDED(hr), "Failed to get color key, hr %#lx.\n", hr);
    ok(!ckey.dwColorSpaceLowValue, "Got unexpected value 0x%08lx.\n", ckey.dwColorSpaceLowValue);
    ok(!ckey.dwColorSpaceHighValue, "Got unexpected value 0x%08lx.\n", ckey.dwColorSpaceHighValue);

    ckey.dwColorSpaceLowValue = 0x00000001;
    ckey.dwColorSpaceHighValue = 0x00000000;
    hr = IDirectDrawSurface_SetColorKey(surface, DDCKEY_SRCBLT, &ckey);
    ok(SUCCEEDED(hr), "Failed to set color key, hr %#lx.\n", hr);

    hr = IDirectDrawSurface_GetColorKey(surface, DDCKEY_SRCBLT, &ckey);
    ok(SUCCEEDED(hr), "Failed to get color key, hr %#lx.\n", hr);
    ok(ckey.dwColorSpaceLowValue == 0x00000001, "Got unexpected value 0x%08lx.\n", ckey.dwColorSpaceLowValue);
    ok(ckey.dwColorSpaceHighValue == 0x00000001, "Got unexpected value 0x%08lx.\n", ckey.dwColorSpaceHighValue);

    /* DDCKEY_COLORSPACE is ignored if the key is a single value. */
    ckey.dwColorSpaceLowValue = 0x00000000;
    ckey.dwColorSpaceHighValue = 0x00000000;
    hr = IDirectDrawSurface_SetColorKey(surface, DDCKEY_SRCBLT | DDCKEY_COLORSPACE, &ckey);
    ok(SUCCEEDED(hr), "Failed to set color key, hr %#lx.\n", hr);

    /* Using it with a range key results in DDERR_NOCOLORKEYHW. */
    ckey.dwColorSpaceLowValue = 0x00000001;
    ckey.dwColorSpaceHighValue = 0x00000000;
    hr = IDirectDrawSurface_SetColorKey(surface, DDCKEY_SRCBLT | DDCKEY_COLORSPACE, &ckey);
    ok(hr == DDERR_NOCOLORKEYHW, "Got unexpected hr %#lx.\n", hr);
    ckey.dwColorSpaceLowValue = 0x00000000;
    ckey.dwColorSpaceHighValue = 0x00000001;
    hr = IDirectDrawSurface_SetColorKey(surface, DDCKEY_SRCBLT | DDCKEY_COLORSPACE, &ckey);
    ok(hr == DDERR_NOCOLORKEYHW, "Got unexpected hr %#lx.\n", hr);
    /* Range destination keys don't work either. */
    hr = IDirectDrawSurface_SetColorKey(surface, DDCKEY_DESTBLT | DDCKEY_COLORSPACE, &ckey);
    ok(hr == DDERR_NOCOLORKEYHW, "Got unexpected hr %#lx.\n", hr);

    /* Just to show it's not because of A, R, and G having equal values. */
    ckey.dwColorSpaceLowValue = 0x00000000;
    ckey.dwColorSpaceHighValue = 0x01010101;
    hr = IDirectDrawSurface_SetColorKey(surface, DDCKEY_SRCBLT | DDCKEY_COLORSPACE, &ckey);
    ok(hr == DDERR_NOCOLORKEYHW, "Got unexpected hr %#lx.\n", hr);

    /* None of these operations modified the key. */
    hr = IDirectDrawSurface_GetColorKey(surface, DDCKEY_SRCBLT, &ckey);
    ok(SUCCEEDED(hr), "Failed to get color key, hr %#lx.\n", hr);
    ok(!ckey.dwColorSpaceLowValue, "Got unexpected value 0x%08lx.\n", ckey.dwColorSpaceLowValue);
    ok(!ckey.dwColorSpaceHighValue, "Got unexpected value 0x%08lx.\n", ckey.dwColorSpaceHighValue);

    IDirectDrawSurface_Release(surface);
    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "Got unexpected refcount %lu.\n", refcount);
    DestroyWindow(window);
}

static void test_shademode(void)
{
    static D3DRECT clear_rect = {{0}, {0}, {640}, {480}};
    unsigned int color0, color1, i, count;
    IDirect3DMaterial2 *background;
    IDirect3DViewport2 *viewport;
    IDirect3DDevice2 *device;
    IDirectDrawSurface *rt;
    IDirectDraw2 *ddraw;
    D3DLVERTEX *quad;
    ULONG refcount;
    HWND window;
    HRESULT hr;
    static D3DLVERTEX quad_strip[] =
    {
        {{-1.0f}, {-1.0f}, {0.0f}, 0, {0xffff0000}},
        {{-1.0f}, { 1.0f}, {0.0f}, 0, {0xff00ff00}},
        {{ 1.0f}, {-1.0f}, {0.0f}, 0, {0xff0000ff}},
        {{ 1.0f}, { 1.0f}, {0.0f}, 0, {0xffffffff}},
    },
    quad_list[] =
    {
        {{-1.0f}, {-1.0f}, {0.0f}, 0, {0xffff0000}},
        {{-1.0f}, { 1.0f}, {0.0f}, 0, {0xff00ff00}},
        {{ 1.0f}, {-1.0f}, {0.0f}, 0, {0xff0000ff}},

        {{ 1.0f}, {-1.0f}, {0.0f}, 0, {0xff0000ff}},
        {{-1.0f}, { 1.0f}, {0.0f}, 0, {0xff00ff00}},
        {{ 1.0f}, { 1.0f}, {0.0f}, 0, {0xffffffff}},
    };
    static const struct
    {
        DWORD primtype;
        DWORD shademode;
        unsigned int color0, color1;
    }
    tests[] =
    {
        {D3DPT_TRIANGLESTRIP, D3DSHADE_FLAT,    0x00ff0000, 0x0000ff00},
        {D3DPT_TRIANGLESTRIP, D3DSHADE_PHONG,   0x000dca28, 0x000d45c7},
        {D3DPT_TRIANGLESTRIP, D3DSHADE_GOURAUD, 0x000dca28, 0x000d45c7},
        {D3DPT_TRIANGLESTRIP, D3DSHADE_PHONG,   0x000dca28, 0x000d45c7},
        {D3DPT_TRIANGLELIST,  D3DSHADE_FLAT,    0x00ff0000, 0x000000ff},
        {D3DPT_TRIANGLELIST,  D3DSHADE_GOURAUD, 0x000dca28, 0x000d45c7},
    };

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    if (!(device = create_device(ddraw, window, DDSCL_NORMAL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        IDirectDraw2_Release(ddraw);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice2_GetRenderTarget(device, &rt);
    ok(SUCCEEDED(hr), "Failed to get render target, hr %#lx.\n", hr);

    background = create_diffuse_material(device, 1.0f, 1.0f, 1.0f, 1.0f);
    viewport = create_viewport(device, 0, 0, 640, 480);
    viewport_set_background(device, viewport, background);
    hr = IDirect3DDevice2_SetCurrentViewport(device, viewport);
    ok(SUCCEEDED(hr), "Failed to activate the viewport, hr %#lx.\n", hr);

    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_FOGENABLE, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable fog, hr %#lx.\n", hr);

    /* Try it first with a TRIANGLESTRIP.  Do it with different geometry because
     * the color fixups we have to do for FLAT shading will be dependent on that. */

    for (i = 0; i < ARRAY_SIZE(tests); ++i)
    {
        hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET);
        ok(SUCCEEDED(hr), "Failed to clear viewport, hr %#lx.\n", hr);

        hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_SHADEMODE, tests[i].shademode);
        ok(hr == D3D_OK, "Failed to set shade mode, hr %#lx.\n", hr);

        hr = IDirect3DDevice2_BeginScene(device);
        ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
        quad = tests[i].primtype == D3DPT_TRIANGLESTRIP ? quad_strip : quad_list;
        count = tests[i].primtype == D3DPT_TRIANGLESTRIP ? 4 : 6;
        hr = IDirect3DDevice2_DrawPrimitive(device, tests[i].primtype, D3DVT_LVERTEX, quad, count, 0);
        ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
        hr = IDirect3DDevice2_EndScene(device);
        ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

        color0 = get_surface_color(rt, 100, 100); /* Inside first triangle */
        color1 = get_surface_color(rt, 500, 350); /* Inside second triangle */

        /* For D3DSHADE_FLAT it should take the color of the first vertex of
         * each triangle. This requires EXT_provoking_vertex or similar
         * functionality being available. */
        /* PHONG should be the same as GOURAUD, since no hardware implements
         * this. */
        ok(compare_color(color0, tests[i].color0, 1), "Test %u shading has color0 %08x, expected %08x.\n",
                i, color0, tests[i].color0);
        ok(compare_color(color1, tests[i].color1, 1), "Test %u shading has color1 %08x, expected %08x.\n",
                i, color1, tests[i].color1);
    }

    destroy_viewport(device, viewport);
    destroy_material(background);
    IDirectDrawSurface_Release(rt);
    refcount = IDirect3DDevice2_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirectDraw2_Release(ddraw);
    DestroyWindow(window);
}

static void test_lockrect_invalid(void)
{
    unsigned int i, r;
    IDirectDraw2 *ddraw;
    IDirectDrawSurface *surface1;
    IDirectDrawSurface2 *surface;
    HWND window;
    HRESULT hr;
    DDSURFACEDESC surface_desc;
    DDCAPS hal_caps;
    DWORD needed_caps = DDSCAPS_TEXTURE | DDSCAPS_VIDEOMEMORY;
    static RECT valid[] =
    {
        {60, 60, 68, 68},
        {60, 60, 60, 68},
        {60, 60, 68, 60},
        {120, 60, 128, 68},
        {60, 120, 68, 128},
    };
    static RECT invalid[] =
    {
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
    static const struct
    {
        DWORD caps;
        const char *name;
        HRESULT hr;
    }
    resources[] =
    {
        {DDSCAPS_OFFSCREENPLAIN | DDSCAPS_SYSTEMMEMORY, "sysmem offscreenplain", DDERR_INVALIDPARAMS},
        {DDSCAPS_OFFSCREENPLAIN | DDSCAPS_VIDEOMEMORY, "vidmem offscreenplain", DDERR_INVALIDPARAMS},
        {DDSCAPS_TEXTURE | DDSCAPS_SYSTEMMEMORY, "sysmem texture", DDERR_INVALIDPARAMS},
        {DDSCAPS_TEXTURE | DDSCAPS_VIDEOMEMORY, "vidmem texture", DDERR_INVALIDPARAMS},
    };

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    memset(&hal_caps, 0, sizeof(hal_caps));
    hal_caps.dwSize = sizeof(hal_caps);
    hr = IDirectDraw2_GetCaps(ddraw, &hal_caps, NULL);
    ok(SUCCEEDED(hr), "Failed to get caps, hr %#lx.\n", hr);
    if ((hal_caps.ddsCaps.dwCaps & needed_caps) != needed_caps)
    {
        skip("Required surface types not supported, skipping test.\n");
        goto done;
    }

    for (r = 0; r < ARRAY_SIZE(resources); ++r)
    {
        memset(&surface_desc, 0, sizeof(surface_desc));
        surface_desc.dwSize = sizeof(surface_desc);
        surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT;
        surface_desc.ddsCaps.dwCaps = resources[r].caps;
        surface_desc.dwWidth = 128;
        surface_desc.dwHeight = 128;
        surface_desc.ddpfPixelFormat.dwSize = sizeof(surface_desc.ddpfPixelFormat);
        surface_desc.ddpfPixelFormat.dwFlags = DDPF_RGB;
        surface_desc.ddpfPixelFormat.dwRGBBitCount = 32;
        surface_desc.ddpfPixelFormat.dwRBitMask = 0xff0000;
        surface_desc.ddpfPixelFormat.dwGBitMask = 0x00ff00;
        surface_desc.ddpfPixelFormat.dwBBitMask = 0x0000ff;

        hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface1, NULL);
        ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx, type %s.\n", hr, resources[r].name);
        hr = IDirectDrawSurface_QueryInterface(surface1, &IID_IDirectDrawSurface2, (void **)&surface);
        ok(SUCCEEDED(hr), "Failed to QI IDirectDrawSurface2 interface, hr %#lx.\n", hr);
        IDirectDrawSurface_Release(surface1);

        hr = IDirectDrawSurface2_Lock(surface, NULL, NULL, DDLOCK_WAIT, NULL);
        ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx, type %s.\n", hr, resources[r].name);

        for (i = 0; i < ARRAY_SIZE(valid); ++i)
        {
            RECT *rect = &valid[i];

            memset(&surface_desc, 0, sizeof(surface_desc));
            surface_desc.dwSize = sizeof(surface_desc);

            hr = IDirectDrawSurface2_Lock(surface, rect, &surface_desc, DDLOCK_WAIT, NULL);
            ok(SUCCEEDED(hr), "Lock failed (%#lx) for rect %s, type %s.\n",
                    hr, wine_dbgstr_rect(rect), resources[r].name);

            hr = IDirectDrawSurface2_Unlock(surface, NULL);
            ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx, type %s.\n", hr, resources[r].name);
        }

        for (i = 0; i < ARRAY_SIZE(invalid); ++i)
        {
            RECT *rect = &invalid[i];

            memset(&surface_desc, 1, sizeof(surface_desc));
            surface_desc.dwSize = sizeof(surface_desc);

            hr = IDirectDrawSurface2_Lock(surface, rect, &surface_desc, DDLOCK_WAIT, NULL);
            ok(hr == resources[r].hr, "Lock returned %#lx for rect %s, type %s.\n",
                    hr, wine_dbgstr_rect(rect), resources[r].name);
            if (SUCCEEDED(hr))
            {
                hr = IDirectDrawSurface2_Unlock(surface, NULL);
                ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx, type %s.\n", hr, resources[r].name);
            }
            else
                ok(!surface_desc.lpSurface, "Got unexpected lpSurface %p.\n", surface_desc.lpSurface);
        }

        hr = IDirectDrawSurface2_Lock(surface, NULL, &surface_desc, DDLOCK_WAIT, NULL);
        ok(SUCCEEDED(hr), "Lock(rect = NULL) failed, hr %#lx, type %s.\n",
                hr, resources[r].name);
        hr = IDirectDrawSurface2_Lock(surface, NULL, &surface_desc, DDLOCK_WAIT, NULL);
        ok(hr == DDERR_SURFACEBUSY, "Double lock(rect = NULL) returned %#lx, type %s.\n",
                hr, resources[r].name);
        hr = IDirectDrawSurface2_Unlock(surface, NULL);
        ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx, type %s.\n", hr, resources[r].name);

        hr = IDirectDrawSurface2_Lock(surface, &valid[0], &surface_desc, DDLOCK_WAIT, NULL);
        ok(SUCCEEDED(hr), "Lock(rect = %s) failed (%#lx).\n", wine_dbgstr_rect(&valid[0]), hr);
        hr = IDirectDrawSurface2_Lock(surface, &valid[0], &surface_desc, DDLOCK_WAIT, NULL);
        ok(hr == DDERR_SURFACEBUSY, "Double lock(rect = %s) failed (%#lx).\n",
                wine_dbgstr_rect(&valid[0]), hr);

        /* Locking a different rectangle returns DD_OK, but it seems to break the surface.
         * Afterwards unlocking the surface fails(NULL rectangle or both locked rectangles) */

        hr = IDirectDrawSurface2_Unlock(surface, NULL);
        ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx, type %s.\n", hr, resources[r].name);

        IDirectDrawSurface2_Release(surface);
    }

done:
    IDirectDraw2_Release(ddraw);
    DestroyWindow(window);
}

static void test_yv12_overlay(void)
{
    IDirectDrawSurface *src_surface, *dst_surface;
    RECT rect = {13, 17, 14, 18};
    unsigned int offset, y;
    unsigned char *base;
    IDirectDraw2 *ddraw;
    DDSURFACEDESC desc;
    HWND window;
    HRESULT hr;

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    if (!(src_surface = create_overlay(ddraw, 256, 256, MAKEFOURCC('Y','V','1','2'))))
    {
        skip("Failed to create a YV12 overlay, skipping test.\n");
        goto done;
    }

    memset(&desc, 0, sizeof(desc));
    desc.dwSize = sizeof(desc);
    hr = IDirectDrawSurface_Lock(src_surface, NULL, &desc, DDLOCK_WAIT, NULL);
    ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx.\n", hr);

    ok(desc.dwFlags == (DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT | DDSD_CAPS | DDSD_PITCH),
            "Got unexpected flags %#lx.\n", desc.dwFlags);
    ok(desc.ddsCaps.dwCaps == (DDSCAPS_OVERLAY | DDSCAPS_VIDEOMEMORY | DDSCAPS_LOCALVIDMEM | DDSCAPS_HWCODEC)
            || desc.ddsCaps.dwCaps == (DDSCAPS_OVERLAY | DDSCAPS_VIDEOMEMORY | DDSCAPS_LOCALVIDMEM),
            "Got unexpected caps %#lx.\n", desc.ddsCaps.dwCaps);
    ok(desc.dwWidth == 256, "Got unexpected width %lu.\n", desc.dwWidth);
    ok(desc.dwHeight == 256, "Got unexpected height %lu.\n", desc.dwHeight);
    /* The overlay pitch seems to have 256 byte alignment. */
    ok(!(desc.lPitch & 0xff), "Got unexpected pitch %lu.\n", desc.lPitch);

    /* Fill the surface with some data for the blit test. */
    base = desc.lpSurface;
    /* Luminance */
    for (y = 0; y < desc.dwHeight; ++y)
    {
        memset(base + desc.lPitch * y, 0x10, desc.dwWidth);
    }
    /* V */
    for (; y < desc.dwHeight + desc.dwHeight / 4; ++y)
    {
        memset(base + desc.lPitch * y, 0x20, desc.dwWidth);
    }
    /* U */
    for (; y < desc.dwHeight + desc.dwHeight / 2; ++y)
    {
        memset(base + desc.lPitch * y, 0x30, desc.dwWidth);
    }

    hr = IDirectDrawSurface_Unlock(src_surface, NULL);
    ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);

    /* YV12 uses 2x2 blocks with 6 bytes per block (4*Y, 1*U, 1*V). Unlike
     * other block-based formats like DXT the entire Y channel is stored in
     * one big chunk of memory, followed by the chroma channels. So partial
     * locks do not really make sense. Show that they are allowed nevertheless
     * and the offset points into the luminance data. */
    hr = IDirectDrawSurface_Lock(src_surface, &rect, &desc, DDLOCK_WAIT, NULL);
    ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx.\n", hr);
    offset = ((const unsigned char *)desc.lpSurface - base);
    ok(offset == rect.top * desc.lPitch + rect.left, "Got unexpected offset %u, expected %lu.\n",
            offset, rect.top * desc.lPitch + rect.left);
    hr = IDirectDrawSurface_Unlock(src_surface, NULL);
    ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);

    if (!(dst_surface = create_overlay(ddraw, 256, 256, MAKEFOURCC('Y','V','1','2'))))
    {
        /* Windows XP with a Radeon X1600 GPU refuses to create a second
         * overlay surface, DDERR_NOOVERLAYHW, making the blit tests moot. */
        skip("Failed to create a second YV12 surface, skipping blit test.\n");
        IDirectDrawSurface_Release(src_surface);
        goto done;
    }

    hr = IDirectDrawSurface_Blt(dst_surface, NULL, src_surface, NULL, DDBLT_WAIT, NULL);
    /* VMware rejects YV12 blits. This behavior has not been seen on real
     * hardware yet, so mark it broken. */
    ok(SUCCEEDED(hr) || broken(hr == E_NOTIMPL), "Failed to blit, hr %#lx.\n", hr);

    if (SUCCEEDED(hr))
    {
        memset(&desc, 0, sizeof(desc));
        desc.dwSize = sizeof(desc);
        hr = IDirectDrawSurface_Lock(dst_surface, NULL, &desc, DDLOCK_WAIT, NULL);
        ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx.\n", hr);

        base = desc.lpSurface;
        ok(base[0] == 0x10, "Got unexpected Y data 0x%02x.\n", base[0]);
        base += desc.dwHeight * desc.lPitch;
        ok(base[0] == 0x20, "Got unexpected V data 0x%02x.\n", base[0]);
        base += desc.dwHeight / 4 * desc.lPitch;
        ok(base[0] == 0x30, "Got unexpected U data 0x%02x.\n", base[0]);

        hr = IDirectDrawSurface_Unlock(dst_surface, NULL);
        ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);
    }

    IDirectDrawSurface_Release(dst_surface);
    IDirectDrawSurface_Release(src_surface);
done:
    IDirectDraw2_Release(ddraw);
    DestroyWindow(window);
}

static BOOL dwm_enabled(void)
{
    BOOL ret = FALSE;

    if (!strcmp(winetest_platform, "wine"))
        return FALSE;
    if (!pDwmIsCompositionEnabled)
        return FALSE;
    if (FAILED(pDwmIsCompositionEnabled(&ret)))
        return FALSE;
    return ret;
}

static void test_offscreen_overlay(void)
{
    IDirectDrawSurface *overlay, *offscreen, *primary;
    DDSURFACEDESC surface_desc;
    IDirectDraw2 *ddraw;
    HWND window;
    HRESULT hr;
    HDC dc;

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    if (!(overlay = create_overlay(ddraw, 64, 64, MAKEFOURCC('U','Y','V','Y'))))
    {
        skip("Failed to create a UYVY overlay, skipping test.\n");
        goto done;
    }

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &primary, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n",hr);

    /* On Windows 7, and probably Vista, UpdateOverlay() will return
     * DDERR_OUTOFCAPS if the dwm is active. Calling GetDC() on the primary
     * surface prevents this by disabling the dwm. */
    hr = IDirectDrawSurface_GetDC(primary, &dc);
    ok(SUCCEEDED(hr), "Failed to get DC, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_ReleaseDC(primary, dc);
    ok(SUCCEEDED(hr), "Failed to release DC, hr %#lx.\n", hr);

    /* Try to overlay a NULL surface. */
    hr = IDirectDrawSurface_UpdateOverlay(overlay, NULL, NULL, NULL, DDOVER_SHOW, NULL);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_UpdateOverlay(overlay, NULL, NULL, NULL, DDOVER_HIDE, NULL);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);

    /* Try to overlay an offscreen surface. */
    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PIXELFORMAT;
    surface_desc.dwWidth = 64;
    surface_desc.dwHeight = 64;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN;
    surface_desc.ddpfPixelFormat.dwSize = sizeof(surface_desc.ddpfPixelFormat);
    surface_desc.ddpfPixelFormat.dwFlags = DDPF_RGB;
    surface_desc.ddpfPixelFormat.dwFourCC = 0;
    surface_desc.ddpfPixelFormat.dwRGBBitCount = 16;
    surface_desc.ddpfPixelFormat.dwRBitMask = 0xf800;
    surface_desc.ddpfPixelFormat.dwGBitMask = 0x07e0;
    surface_desc.ddpfPixelFormat.dwBBitMask = 0x001f;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &offscreen, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n",hr);

    hr = IDirectDrawSurface_UpdateOverlay(overlay, NULL, offscreen, NULL, DDOVER_SHOW, NULL);
    ok(SUCCEEDED(hr) || broken(hr == DDERR_OUTOFCAPS && dwm_enabled())
            || broken(hr == E_NOTIMPL && ddraw_is_vmware(ddraw)),
            "Failed to update overlay, hr %#lx.\n", hr);

    /* Try to overlay the primary with a non-overlay surface. */
    hr = IDirectDrawSurface_UpdateOverlay(offscreen, NULL, primary, NULL, DDOVER_SHOW, NULL);
    ok(hr == DDERR_NOTAOVERLAYSURFACE, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_UpdateOverlay(offscreen, NULL, primary, NULL, DDOVER_HIDE, NULL);
    ok(hr == DDERR_NOTAOVERLAYSURFACE, "Got unexpected hr %#lx.\n", hr);

    IDirectDrawSurface_Release(offscreen);
    IDirectDrawSurface_Release(primary);
    IDirectDrawSurface_Release(overlay);
done:
    IDirectDraw2_Release(ddraw);
    DestroyWindow(window);
}

static void test_overlay_rect(void)
{
    IDirectDrawSurface *overlay, *primary = NULL;
    DDSURFACEDESC surface_desc;
    RECT rect = {0, 0, 64, 64};
    IDirectDraw2 *ddraw;
    LONG pos_x, pos_y;
    HRESULT hr, hr2;
    HWND window;
    HDC dc;

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    if (!(overlay = create_overlay(ddraw, 64, 64, MAKEFOURCC('U','Y','V','Y'))))
    {
        skip("Failed to create a UYVY overlay, skipping test.\n");
        goto done;
    }

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &primary, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n",hr);

    /* On Windows 7, and probably Vista, UpdateOverlay() will return
     * DDERR_OUTOFCAPS if the dwm is active. Calling GetDC() on the primary
     * surface prevents this by disabling the dwm. */
    hr = IDirectDrawSurface_GetDC(primary, &dc);
    ok(SUCCEEDED(hr), "Failed to get DC, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_ReleaseDC(primary, dc);
    ok(SUCCEEDED(hr), "Failed to release DC, hr %#lx.\n", hr);

    /* On Windows 8 and newer DWM can't be turned off, making overlays unusable. */
    if (dwm_enabled())
    {
        win_skip("Cannot disable DWM, skipping overlay test.\n");
        goto done;
    }

    /* The dx sdk sort of implies that rect must be set when DDOVER_SHOW is
     * used. This is not true in Windows Vista and earlier, but changed in
     * Windows 7. */
    hr = IDirectDrawSurface_UpdateOverlay(overlay, NULL, primary, &rect, DDOVER_SHOW, NULL);
    ok(SUCCEEDED(hr), "Failed to update overlay, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_UpdateOverlay(overlay, NULL, primary, NULL, DDOVER_HIDE, NULL);
    ok(SUCCEEDED(hr), "Failed to update overlay, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_UpdateOverlay(overlay, NULL, primary, NULL, DDOVER_SHOW, NULL);
    ok(hr == DD_OK || hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);

    /* Show that the overlay position is the (top, left) coordinate of the
     * destination rectangle. */
    OffsetRect(&rect, 32, 16);
    hr = IDirectDrawSurface_UpdateOverlay(overlay, NULL, primary, &rect, DDOVER_SHOW, NULL);
    ok(SUCCEEDED(hr), "Failed to update overlay, hr %#lx.\n", hr);
    pos_x = -1; pos_y = -1;
    hr = IDirectDrawSurface_GetOverlayPosition(overlay, &pos_x, &pos_y);
    ok(SUCCEEDED(hr), "Failed to get overlay position, hr %#lx.\n", hr);
    ok(pos_x == rect.left, "Got unexpected pos_x %ld, expected %ld.\n", pos_x, rect.left);
    ok(pos_y == rect.top, "Got unexpected pos_y %ld, expected %ld.\n", pos_y, rect.top);

    /* Passing a NULL dest rect sets the position to 0/0. Visually it can be
     * seen that the overlay overlays the whole primary(==screen). */
    hr2 = IDirectDrawSurface_UpdateOverlay(overlay, NULL, primary, NULL, 0, NULL);
    ok(hr2 == DD_OK || hr2 == DDERR_INVALIDPARAMS || hr2 == DDERR_OUTOFCAPS, "Got unexpected hr %#lx.\n", hr2);
    hr = IDirectDrawSurface_GetOverlayPosition(overlay, &pos_x, &pos_y);
    ok(SUCCEEDED(hr), "Failed to get overlay position, hr %#lx.\n", hr);
    if (SUCCEEDED(hr2))
    {
        ok(!pos_x, "Got unexpected pos_x %ld.\n", pos_x);
        ok(!pos_y, "Got unexpected pos_y %ld.\n", pos_y);
    }
    else
    {
        ok(pos_x == 32, "Got unexpected pos_x %ld.\n", pos_x);
        ok(pos_y == 16, "Got unexpected pos_y %ld.\n", pos_y);
    }

    /* The position cannot be retrieved when the overlay is not shown. */
    hr = IDirectDrawSurface_UpdateOverlay(overlay, NULL, primary, &rect, DDOVER_HIDE, NULL);
    ok(SUCCEEDED(hr), "Failed to update overlay, hr %#lx.\n", hr);
    pos_x = -1; pos_y = -1;
    hr = IDirectDrawSurface_GetOverlayPosition(overlay, &pos_x, &pos_y);
    ok(hr == DDERR_OVERLAYNOTVISIBLE, "Got unexpected hr %#lx.\n", hr);
    ok(!pos_x, "Got unexpected pos_x %ld.\n", pos_x);
    ok(!pos_y, "Got unexpected pos_y %ld.\n", pos_y);

done:
    if (primary)
        IDirectDrawSurface_Release(primary);
    if (overlay)
        IDirectDrawSurface_Release(overlay);
    IDirectDraw2_Release(ddraw);
    DestroyWindow(window);
}

static void test_blt(void)
{
    IDirectDrawSurface *surface, *rt;
    DDSURFACEDESC surface_desc;
    IDirect3DDevice2 *device;
    IDirectDraw2 *ddraw;
    unsigned int i;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    static struct
    {
        RECT src_rect;
        RECT dst_rect;
        HRESULT hr;
    }
    test_data[] =
    {
        {{160,   0, 640, 480}, {  0,   0, 480, 480}, DD_OK},             /* Overlapped blit. */
        {{160, 480, 640,   0}, {  0,   0, 480, 480}, DDERR_INVALIDRECT}, /* Overlapped blit, flipped source. */
        {{640,   0, 160, 480}, {  0,   0, 480, 480}, DDERR_INVALIDRECT}, /* Overlapped blit, mirrored source. */
        {{160,   0, 480, 480}, {  0,   0, 480, 480}, DD_OK},             /* Overlapped blit, stretched x. */
        {{160, 160, 640, 480}, {  0,   0, 480, 480}, DD_OK},             /* Overlapped blit, stretched y. */
        {{  0,   0, 640, 480}, {  0,   0, 640, 480}, DD_OK},             /* Full surface blit. */
        {{  0,   0, 640, 480}, {  0, 480, 640,   0}, DDERR_INVALIDRECT}, /* Full surface, flipped destination. */
        {{  0,   0, 640, 480}, {640,   0,   0, 480}, DDERR_INVALIDRECT}, /* Full surface, mirrored destination. */
        {{  0, 480, 640,   0}, {  0,   0, 640, 480}, DDERR_INVALIDRECT}, /* Full surface, flipped source. */
        {{640,   0,   0, 480}, {  0,   0, 640, 480}, DDERR_INVALIDRECT}, /* Full surface, mirrored source. */
    };

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    if (!(device = create_device(ddraw, window, DDSCL_NORMAL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        IDirectDraw2_Release(ddraw);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice2_GetRenderTarget(device, &rt);
    ok(SUCCEEDED(hr), "Failed to get render target, hr %#lx.\n", hr);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_WIDTH | DDSD_HEIGHT | DDSD_CAPS;
    surface_desc.dwWidth = 640;
    surface_desc.dwHeight = 480;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

    hr = IDirectDrawSurface_Blt(surface, NULL, surface, NULL, 0, NULL);
    ok(SUCCEEDED(hr), "Failed to blit, hr %#lx.\n", hr);

    hr = IDirectDrawSurface_Blt(surface, NULL, rt, NULL, 0, NULL);
    ok(SUCCEEDED(hr), "Failed to blit, hr %#lx.\n", hr);

    for (i = 0; i < ARRAY_SIZE(test_data); ++i)
    {
        hr = IDirectDrawSurface_Blt(surface, &test_data[i].dst_rect,
                surface, &test_data[i].src_rect, DDBLT_WAIT, NULL);
        ok(hr == test_data[i].hr, "Test %u: Got unexpected hr %#lx, expected %#lx.\n", i, hr, test_data[i].hr);

        hr = IDirectDrawSurface_Blt(surface, &test_data[i].dst_rect,
                rt, &test_data[i].src_rect, DDBLT_WAIT, NULL);
        ok(hr == test_data[i].hr, "Test %u: Got unexpected hr %#lx, expected %#lx.\n", i, hr, test_data[i].hr);

        hr = IDirectDrawSurface_Blt(surface, &test_data[i].dst_rect,
                NULL, &test_data[i].src_rect, DDBLT_WAIT, NULL);
        ok(hr == DDERR_INVALIDPARAMS, "Test %u: Got unexpected hr %#lx.\n", i, hr);

        hr = IDirectDrawSurface_Blt(surface, &test_data[i].dst_rect, NULL, NULL, DDBLT_WAIT, NULL);
        ok(hr == DDERR_INVALIDPARAMS, "Test %u: Got unexpected hr %#lx.\n", i, hr);
    }

    IDirectDrawSurface_Release(surface);
    IDirectDrawSurface_Release(rt);
    refcount = IDirect3DDevice2_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirectDraw2_Release(ddraw);
    DestroyWindow(window);
}

static void test_blt_z_alpha(void)
{
    DWORD blt_flags[] =
    {
        /* 0 */
        DDBLT_ALPHADEST,
        DDBLT_ALPHADESTCONSTOVERRIDE,
        DDBLT_ALPHADESTNEG,
        DDBLT_ALPHADESTSURFACEOVERRIDE,
        DDBLT_ALPHAEDGEBLEND,
        /* 5 */
        DDBLT_ALPHASRC,
        DDBLT_ALPHASRCCONSTOVERRIDE,
        DDBLT_ALPHASRCNEG,
        DDBLT_ALPHASRCSURFACEOVERRIDE,
        DDBLT_ZBUFFER,
        /* 10 */
        DDBLT_ZBUFFERDESTCONSTOVERRIDE,
        DDBLT_ZBUFFERDESTOVERRIDE,
        DDBLT_ZBUFFERSRCCONSTOVERRIDE,
        DDBLT_ZBUFFERSRCOVERRIDE,
    };
    IDirectDrawSurface *src_surface, *dst_surface;
    DDSURFACEDESC surface_desc;
    unsigned int color, i;
    IDirectDraw2 *ddraw;
    DDPIXELFORMAT pf;
    ULONG refcount;
    HWND window;
    HRESULT hr;
    DDBLTFX fx;

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    memset(&pf, 0, sizeof(pf));
    pf.dwSize = sizeof(pf);
    pf.dwFlags = DDPF_RGB | DDPF_ALPHAPIXELS;
    pf.dwRGBBitCount = 32;
    pf.dwRBitMask = 0x00ff0000;
    pf.dwGBitMask = 0x0000ff00;
    pf.dwBBitMask = 0x000000ff;
    pf.dwRGBAlphaBitMask = 0xff000000;

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_WIDTH | DDSD_HEIGHT | DDSD_CAPS | DDSD_PIXELFORMAT;
    surface_desc.dwWidth = 64;
    surface_desc.dwHeight = 64;
    surface_desc.ddpfPixelFormat = pf;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN;

    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &src_surface, NULL);
    ok(SUCCEEDED(hr), "Failed to create source surface, hr %#lx.\n", hr);
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &dst_surface, NULL);
    ok(SUCCEEDED(hr), "Failed to create destination surface, hr %#lx.\n", hr);

    memset(&fx, 0, sizeof(fx));
    fx.dwSize = sizeof(fx);
    fx.dwZBufferOpCode = D3DCMP_NEVER;
    fx.dwZDestConstBitDepth = 32;
    fx.dwZDestConst = 0x11111111;
    fx.dwZSrcConstBitDepth = 32;
    fx.dwZSrcConst = 0xeeeeeeee;
    fx.dwAlphaEdgeBlendBitDepth = 8;
    fx.dwAlphaEdgeBlend = 0x7f;
    fx.dwAlphaDestConstBitDepth = 8;
    fx.dwAlphaDestConst = 0xdd;
    fx.dwAlphaSrcConstBitDepth = 8;
    fx.dwAlphaSrcConst = 0x22;

    for (i = 0; i < ARRAY_SIZE(blt_flags); ++i)
    {
        fx.dwFillColor = 0x3300ff00;
        hr = IDirectDrawSurface_Blt(src_surface, NULL, NULL, NULL, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
        ok(SUCCEEDED(hr), "Test %u: Got unexpected hr %#lx.\n", i, hr);

        fx.dwFillColor = 0xccff0000;
        hr = IDirectDrawSurface_Blt(dst_surface, NULL, NULL, NULL, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
        ok(SUCCEEDED(hr), "Test %u: Got unexpected hr %#lx.\n", i, hr);

        hr = IDirectDrawSurface_Blt(dst_surface, NULL, src_surface, NULL, blt_flags[i] | DDBLT_WAIT, &fx);
        ok(SUCCEEDED(hr), "Test %u: Got unexpected hr %#lx.\n", i, hr);

        color = get_surface_color(dst_surface, 32, 32);
        ok(compare_color(color, 0x0000ff00, 0), "Test %u: Got unexpected color 0x%08x.\n", i, color);
    }

    IDirectDrawSurface_Release(dst_surface);
    IDirectDrawSurface_Release(src_surface);
    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "DirectDraw has %lu references left.\n", refcount);
    DestroyWindow(window);
}

static void test_cross_device_blt(void)
{
    IDirectDrawSurface *surface, *surface2, *sysmem_surface;
    IDirect3DDevice2 *device, *device2;
    IDirectDraw2 *ddraw, *ddraw2;
    DDSURFACEDESC surface_desc;
    HWND window, window2;
    unsigned int color;
    ULONG refcount;
    DDBLTFX fx;
    HRESULT hr;

    window = create_window();
    ddraw = create_ddraw();
    if (!(device = create_device(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN)))
    {
        skip("Failed to create a 3D device.\n");
        IDirectDraw2_Release(ddraw);
        DestroyWindow(window);
        return;
    }

    window2 = create_window();
    ddraw2 = create_ddraw();
    if (!(device2 = create_device(ddraw2, window2, DDSCL_NORMAL)))
    {
        skip("Failed to create a 3D device.\n");
        IDirectDraw2_Release(ddraw2);
        IDirect3DDevice2_Release(device);
        IDirectDraw2_Release(ddraw);
        DestroyWindow(window);
        DestroyWindow(window2);
        return;
    }

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_WIDTH | DDSD_HEIGHT | DDSD_CAPS;
    surface_desc.dwWidth = 640;
    surface_desc.dwHeight = 480;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN | DDSCAPS_SYSTEMMEMORY;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &sysmem_surface, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_BACKBUFFERCOUNT;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE | DDSCAPS_COMPLEX | DDSCAPS_FLIP | DDSCAPS_VIDEOMEMORY;
    surface_desc.dwBackBufferCount = 2;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_WIDTH | DDSD_HEIGHT | DDSD_CAPS | DDSD_PIXELFORMAT;
    surface_desc.dwWidth = 640;
    surface_desc.dwHeight = 480;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN | DDSCAPS_SYSTEMMEMORY;
    surface_desc.ddpfPixelFormat.dwSize = sizeof(surface_desc.ddpfPixelFormat);
    surface_desc.ddpfPixelFormat.dwFlags = DDPF_RGB;
    surface_desc.ddpfPixelFormat.dwRGBBitCount = 16;
    surface_desc.ddpfPixelFormat.dwRBitMask = 0x00007c00;
    surface_desc.ddpfPixelFormat.dwGBitMask = 0x000003e0;
    surface_desc.ddpfPixelFormat.dwBBitMask = 0x0000001f;
    hr = IDirectDraw2_CreateSurface(ddraw2, &surface_desc, &surface2, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

    memset(&fx, 0, sizeof(fx));
    fx.dwSize = sizeof(fx);
    fx.dwFillColor = 0xff0000ff;
    hr = IDirectDrawSurface_Blt(surface2, NULL, NULL, NULL, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
    ok(SUCCEEDED(hr), "Failed to fill surface, hr %#lx.\n", hr);

    hr = IDirectDrawSurface_Blt(surface, NULL, surface2, NULL, DDBLT_WAIT, NULL);
    ok(hr == E_NOTIMPL, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Flip(surface, NULL, DDFLIP_WAIT);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Blt(surface, NULL, surface2, NULL, DDBLT_WAIT, NULL);
    ok(hr == E_NOTIMPL, "Got unexpected hr %#lx.\n", hr);
    color = get_surface_color(surface, 320, 240);
    ok(color == 0x00000000, "Got unexpected color 0x%08x.\n", color);

    hr = IDirectDrawSurface_Blt(sysmem_surface, NULL, surface2, NULL, DDBLT_WAIT, NULL);
    ok(hr == E_NOTIMPL, "Got unexpected hr %#lx.\n", hr);
    color = get_surface_color(sysmem_surface, 320, 240);
    ok(color == 0x00000000, "Got unexpected color 0x%08x.\n", color);

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_IsLost(sysmem_surface);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirectDrawSurface_Blt(sysmem_surface, NULL, surface2, NULL, DDBLT_WAIT, NULL);
    ok(hr == E_NOTIMPL, "Got unexpected hr %#lx.\n", hr);
    color = get_surface_color(sysmem_surface, 320, 240);
    ok(color == 0x00000000, "Got unexpected color 0x%08x.\n", color);

    IDirectDrawSurface_Release(surface2);
    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_WIDTH | DDSD_HEIGHT | DDSD_CAPS;
    surface_desc.dwWidth = 640;
    surface_desc.dwHeight = 480;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN | DDSCAPS_SYSTEMMEMORY;
    hr = IDirectDraw2_CreateSurface(ddraw2, &surface_desc, &surface2, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_Blt(surface2, NULL, NULL, NULL, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
    ok(SUCCEEDED(hr), "Failed to fill surface, hr %#lx.\n", hr);

    hr = IDirectDrawSurface_Blt(sysmem_surface, NULL, surface2, NULL, DDBLT_WAIT, NULL);
    todo_wine ok(hr == D3D_OK, "Failed to blit, hr %#lx.\n", hr);
    color = get_surface_color(sysmem_surface, 320, 240);
    todo_wine ok(compare_color(color, 0x000000ff, 1), "Got unexpected color 0x%08x.\n", color);

    IDirectDrawSurface_Release(surface);
    IDirectDrawSurface_Release(surface2);
    IDirectDrawSurface_Release(sysmem_surface);
    refcount = IDirect3DDevice2_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    refcount = IDirect3DDevice2_Release(device2);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirectDraw2_Release(ddraw);
    IDirectDraw2_Release(ddraw2);
    DestroyWindow(window);
    DestroyWindow(window2);
}

static void test_getdc(void)
{
    IDirectDrawSurface *surface, *surface2, *tmp;
    DDSURFACEDESC surface_desc, map_desc;
    DDSCAPS caps = {DDSCAPS_COMPLEX};
    IDirectDraw2 *ddraw;
    unsigned int i, screen_bpp;
    HWND window;
    HDC dc, dc2;
    HRESULT hr;

    static const struct
    {
        const char *name;
        DDPIXELFORMAT format;
        BOOL getdc_supported;
        HRESULT alt_result;
    }
    test_data[] =
    {
        {"D3DFMT_A8R8G8B8",    {sizeof(test_data->format), DDPF_RGB | DDPF_ALPHAPIXELS, 0, {32},
                {0x00ff0000}, {0x0000ff00}, {0x000000ff}, {0xff000000}}, TRUE},
        {"D3DFMT_X8R8G8B8",    {sizeof(test_data->format), DDPF_RGB, 0, {32},
                {0x00ff0000}, {0x0000ff00}, {0x000000ff}, {0x00000000}}, TRUE},
        {"D3DFMT_R5G6B5",      {sizeof(test_data->format), DDPF_RGB, 0, {16},
                {0x0000f800}, {0x000007e0}, {0x0000001f}, {0x00000000}}, TRUE},
        {"D3DFMT_X1R5G5B5",    {sizeof(test_data->format), DDPF_RGB, 0, {16},
                {0x00007c00}, {0x000003e0}, {0x0000001f}, {0x00000000}}, TRUE},
        {"D3DFMT_A1R5G5B5",    {sizeof(test_data->format), DDPF_RGB | DDPF_ALPHAPIXELS, 0, {16},
                {0x00007c00}, {0x000003e0}, {0x0000001f}, {0x00008000}}, TRUE},
        {"D3DFMT_A4R4G4B4",    {sizeof(test_data->format), DDPF_RGB | DDPF_ALPHAPIXELS, 0, {16},
                {0x00000f00}, {0x000000f0}, {0x0000000f}, {0x0000f000}}, TRUE, DDERR_CANTCREATEDC /* Vista+ */},
        {"D3DFMT_X4R4G4B4",    {sizeof(test_data->format), DDPF_RGB, 0, {16},
                {0x00000f00}, {0x000000f0}, {0x0000000f}, {0x00000000}}, TRUE, DDERR_CANTCREATEDC /* Vista+ */},
        {"D3DFMT_A2R10G10B10", {sizeof(test_data->format), DDPF_RGB | DDPF_ALPHAPIXELS, 0, {32},
                {0xc0000000}, {0x3ff00000}, {0x000ffc00}, {0x000003ff}}, TRUE},
        {"D3DFMT_A8B8G8R8",    {sizeof(test_data->format), DDPF_RGB | DDPF_ALPHAPIXELS, 0, {32},
                {0x000000ff}, {0x0000ff00}, {0x00ff0000}, {0xff000000}}, TRUE, DDERR_CANTCREATEDC /* Vista+ */},
        {"D3DFMT_X8B8G8R8",    {sizeof(test_data->format), DDPF_RGB, 0, {32},
                {0x000000ff}, {0x0000ff00}, {0x00ff0000}, {0x00000000}}, TRUE, DDERR_CANTCREATEDC /* Vista+ */},
        {"D3DFMT_R3G3B2",      {sizeof(test_data->format), DDPF_RGB, 0, {8},
                {0x000000e0}, {0x0000001c}, {0x00000003}, {0x00000000}}, FALSE},
        /* GetDC() on a P8 surface fails unless the display mode is 8 bpp.
         * This is not implemented in wine yet, so disable the test for now.
         * Succeeding P8 GetDC() calls are tested in the ddraw:visual test.
        {"D3DFMT_P8", {sizeof(test_data->format), DDPF_PALETTEINDEXED8 | DDPF_RGB, 0, {8 },
                {0x00000000}, {0x00000000}, {0x00000000}, {0x00000000}}, FALSE},
         */
        {"D3DFMT_L8",          {sizeof(test_data->format), DDPF_LUMINANCE, 0, {8},
                {0x000000ff}, {0x00000000}, {0x00000000}, {0x00000000}}, FALSE},
        {"D3DFMT_A8L8",        {sizeof(test_data->format), DDPF_ALPHAPIXELS | DDPF_LUMINANCE, 0, {16},
                {0x000000ff}, {0x00000000}, {0x00000000}, {0x0000ff00}}, FALSE},
        {"D3DFMT_DXT1",        {sizeof(test_data->format), DDPF_FOURCC, MAKEFOURCC('D','X','T','1'), {0},
                {0x00000000}, {0x00000000}, {0x00000000}, {0x00000000}}, FALSE},
        {"D3DFMT_DXT2",        {sizeof(test_data->format), DDPF_FOURCC, MAKEFOURCC('D','X','T','2'), {0},
                {0x00000000}, {0x00000000}, {0x00000000}, {0x00000000}}, FALSE},
        {"D3DFMT_DXT3",        {sizeof(test_data->format), DDPF_FOURCC, MAKEFOURCC('D','X','T','3'), {0},
                {0x00000000}, {0x00000000}, {0x00000000}, {0x00000000}}, FALSE},
        {"D3DFMT_DXT4",        {sizeof(test_data->format), DDPF_FOURCC, MAKEFOURCC('D','X','T','4'), {0},
                {0x00000000}, {0x00000000}, {0x00000000}, {0x00000000}}, FALSE},
        {"D3DFMT_DXT5",        {sizeof(test_data->format), DDPF_FOURCC, MAKEFOURCC('D','X','T','5'), {0},
                {0x00000000}, {0x00000000}, {0x00000000}, {0x00000000}}, FALSE},
    };

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    surface_desc.dwSize = sizeof(surface_desc);
    hr = IDirectDraw2_GetDisplayMode(ddraw, &surface_desc);
    ok(SUCCEEDED(hr), "Failed to get display mode, hr %#lx.\n", hr);
    screen_bpp = surface_desc.ddpfPixelFormat.dwRGBBitCount;

    for (i = 0; i < ARRAY_SIZE(test_data); ++i)
    {
        memset(&surface_desc, 0, sizeof(surface_desc));
        surface_desc.dwSize = sizeof(surface_desc);
        surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT;
        surface_desc.dwWidth = 64;
        surface_desc.dwHeight = 64;
        surface_desc.ddpfPixelFormat = test_data[i].format;
        surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN;

        if (FAILED(IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL)))
        {
            surface_desc.ddsCaps.dwCaps = DDSCAPS_TEXTURE;
            if (FAILED(hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL)))
            {
                skip("Failed to create surface for format %s (hr %#lx), skipping tests.\n", test_data[i].name, hr);
                continue;
            }
        }

        dc = (void *)0x1234;
        hr = IDirectDrawSurface_GetDC(surface, &dc);
        if (test_data[i].getdc_supported)
            ok(SUCCEEDED(hr) || broken(hr == test_data[i].alt_result || ddraw_is_vmware(ddraw)),
                    "Got unexpected hr %#lx for format %s.\n", hr, test_data[i].name);
        else
            ok(FAILED(hr), "Got unexpected hr %#lx for format %s.\n", hr, test_data[i].name);

        if (SUCCEEDED(hr))
        {
            unsigned int width_bytes;
            DIBSECTION dib;
            HBITMAP bitmap;
            DWORD type;
            int size;

            type = GetObjectType(dc);
            ok(type == OBJ_MEMDC, "Got unexpected object type %#lx for format %s.\n", type, test_data[i].name);
            bitmap = GetCurrentObject(dc, OBJ_BITMAP);
            type = GetObjectType(bitmap);
            ok(type == OBJ_BITMAP, "Got unexpected object type %#lx for format %s.\n", type, test_data[i].name);

            size = GetObjectA(bitmap, sizeof(dib), &dib);
            ok(size == sizeof(dib), "Got unexpected size %d for format %s.\n", size, test_data[i].name);
            ok(!dib.dsBm.bmType, "Got unexpected type %#x for format %s.\n",
                    dib.dsBm.bmType, test_data[i].name);
            ok(dib.dsBm.bmWidth == surface_desc.dwWidth, "Got unexpected width %d for format %s.\n",
                    dib.dsBm.bmWidth, test_data[i].name);
            ok(dib.dsBm.bmHeight == surface_desc.dwHeight, "Got unexpected height %d for format %s.\n",
                    dib.dsBm.bmHeight, test_data[i].name);
            width_bytes = ((dib.dsBm.bmWidth * test_data[i].format.dwRGBBitCount + 31) >> 3) & ~3;
            ok(dib.dsBm.bmWidthBytes == width_bytes, "Got unexpected width bytes %d for format %s.\n",
                    dib.dsBm.bmWidthBytes, test_data[i].name);
            ok(dib.dsBm.bmPlanes == 1, "Got unexpected plane count %d for format %s.\n",
                    dib.dsBm.bmPlanes, test_data[i].name);
            ok(dib.dsBm.bmBitsPixel == test_data[i].format.dwRGBBitCount,
                    "Got unexpected bit count %d for format %s.\n",
                    dib.dsBm.bmBitsPixel, test_data[i].name);
            /* Windows XP sets bmBits == NULL for formats that match the screen at least on my r200 GPU. I
             * suspect this applies to all HW accelerated pre-WDDM drivers because they can handle gdi access
             * to ddraw surfaces themselves instead of going through a sysmem DIB section. */
            ok(!!dib.dsBm.bmBits || broken(!pDwmIsCompositionEnabled && dib.dsBm.bmBitsPixel == screen_bpp),
                    "Got unexpected bits %p for format %s.\n", dib.dsBm.bmBits, test_data[i].name);

            ok(dib.dsBmih.biSize == sizeof(dib.dsBmih), "Got unexpected size %lu for format %s.\n",
                    dib.dsBmih.biSize, test_data[i].name);
            ok(dib.dsBmih.biWidth == surface_desc.dwWidth, "Got unexpected width %ld for format %s.\n",
                    dib.dsBmih.biHeight, test_data[i].name);
            ok(dib.dsBmih.biHeight == surface_desc.dwHeight, "Got unexpected height %ld for format %s.\n",
                    dib.dsBmih.biHeight, test_data[i].name);
            ok(dib.dsBmih.biPlanes == 1, "Got unexpected plane count %u for format %s.\n",
                    dib.dsBmih.biPlanes, test_data[i].name);
            ok(dib.dsBmih.biBitCount == test_data[i].format.dwRGBBitCount,
                    "Got unexpected bit count %u for format %s.\n",
                    dib.dsBmih.biBitCount, test_data[i].name);
            ok(dib.dsBmih.biCompression == (test_data[i].format.dwRGBBitCount == 16 ? BI_BITFIELDS : BI_RGB)
                    || broken(test_data[i].format.dwRGBBitCount == 32 && dib.dsBmih.biCompression == BI_BITFIELDS),
                    "Got unexpected compression %#lx for format %s.\n",
                    dib.dsBmih.biCompression, test_data[i].name);
            ok(!dib.dsBmih.biSizeImage, "Got unexpected image size %lu for format %s.\n",
                    dib.dsBmih.biSizeImage, test_data[i].name);
            ok(!dib.dsBmih.biXPelsPerMeter, "Got unexpected horizontal resolution %ld for format %s.\n",
                    dib.dsBmih.biXPelsPerMeter, test_data[i].name);
            ok(!dib.dsBmih.biYPelsPerMeter, "Got unexpected vertical resolution %ld for format %s.\n",
                    dib.dsBmih.biYPelsPerMeter, test_data[i].name);
            ok(!dib.dsBmih.biClrUsed, "Got unexpected used colour count %lu for format %s.\n",
                    dib.dsBmih.biClrUsed, test_data[i].name);
            ok(!dib.dsBmih.biClrImportant, "Got unexpected important colour count %lu for format %s.\n",
                    dib.dsBmih.biClrImportant, test_data[i].name);

            if (dib.dsBmih.biCompression == BI_BITFIELDS)
            {
                ok((dib.dsBitfields[0] == test_data[i].format.dwRBitMask
                        && dib.dsBitfields[1] == test_data[i].format.dwGBitMask
                        && dib.dsBitfields[2] == test_data[i].format.dwBBitMask)
                        || broken(!dib.dsBitfields[0] && !dib.dsBitfields[1] && !dib.dsBitfields[2]),
                        "Got unexpected colour masks 0x%08lx 0x%08lx 0x%08lx for format %s.\n",
                        dib.dsBitfields[0], dib.dsBitfields[1], dib.dsBitfields[2], test_data[i].name);
            }
            else
            {
                ok(!dib.dsBitfields[0] && !dib.dsBitfields[1] && !dib.dsBitfields[2],
                        "Got unexpected colour masks 0x%08lx 0x%08lx 0x%08lx for format %s.\n",
                        dib.dsBitfields[0], dib.dsBitfields[1], dib.dsBitfields[2], test_data[i].name);
            }
            ok(!dib.dshSection, "Got unexpected section %p for format %s.\n", dib.dshSection, test_data[i].name);
            ok(!dib.dsOffset, "Got unexpected offset %lu for format %s.\n", dib.dsOffset, test_data[i].name);

            hr = IDirectDrawSurface_ReleaseDC(surface, dc);
            ok(hr == DD_OK, "Failed to release DC for format %s, hr %#lx.\n", test_data[i].name, hr);
        }
        else
        {
            ok(!dc, "Got unexpected dc %p for format %s.\n", dc, test_data[i].name);
        }

        IDirectDrawSurface_Release(surface);

        if (FAILED(hr))
            continue;

        surface_desc.ddsCaps.dwCaps = DDSCAPS_TEXTURE | DDSCAPS_COMPLEX | DDSCAPS_MIPMAP;
        if (FAILED(hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL)))
        {
            skip("Failed to create mip-mapped texture for format %s (hr %#lx), skipping tests.\n",
                    test_data[i].name, hr);
            continue;
        }

        hr = IDirectDrawSurface_GetAttachedSurface(surface, &caps, &tmp);
        ok(SUCCEEDED(hr), "Failed to get attached surface for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_GetAttachedSurface(tmp, &caps, &surface2);
        ok(SUCCEEDED(hr), "Failed to get attached surface for format %s, hr %#lx.\n", test_data[i].name, hr);
        IDirectDrawSurface_Release(tmp);

        hr = IDirectDrawSurface_GetDC(surface, &dc);
        ok(SUCCEEDED(hr), "Failed to get DC for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_ReleaseDC(surface, dc);
        ok(SUCCEEDED(hr), "Failed to release DC for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_GetDC(surface2, &dc);
        ok(SUCCEEDED(hr), "Failed to get DC for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_ReleaseDC(surface2, dc);
        ok(SUCCEEDED(hr), "Failed to release DC for format %s, hr %#lx.\n", test_data[i].name, hr);

        hr = IDirectDrawSurface_GetDC(surface, &dc);
        ok(SUCCEEDED(hr), "Failed to get DC for format %s, hr %#lx.\n", test_data[i].name, hr);
        dc2 = (void *)0x1234;
        hr = IDirectDrawSurface_GetDC(surface, &dc2);
        ok(hr == DDERR_DCALREADYCREATED, "Got unexpected hr %#lx for format %s.\n", hr, test_data[i].name);
        ok(dc2 == (void *)0x1234, "Got unexpected dc %p for format %s.\n", dc, test_data[i].name);
        hr = IDirectDrawSurface_ReleaseDC(surface, dc);
        ok(SUCCEEDED(hr), "Failed to release DC for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_ReleaseDC(surface, dc);
        ok(hr == DDERR_NODC, "Got unexpected hr %#lx for format %s.\n", hr, test_data[i].name);

        map_desc.dwSize = sizeof(map_desc);
        hr = IDirectDrawSurface_Lock(surface, NULL, &map_desc, DDLOCK_READONLY | DDLOCK_WAIT, NULL);
        ok(SUCCEEDED(hr), "Failed to map surface for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_Lock(surface, NULL, &map_desc, DDLOCK_READONLY | DDLOCK_WAIT, NULL);
        ok(hr == DDERR_SURFACEBUSY, "Got unexpected hr %#lx for format %s.\n", hr, test_data[i].name);
        hr = IDirectDrawSurface_Unlock(surface, NULL);
        ok(SUCCEEDED(hr), "Failed to unmap surface for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_Unlock(surface, NULL);
        ok(hr == DDERR_NOTLOCKED, "Got unexpected hr %#lx for format %s.\n", hr, test_data[i].name);

        hr = IDirectDrawSurface_GetDC(surface, &dc);
        ok(SUCCEEDED(hr), "Failed to get DC for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_Lock(surface, NULL, &map_desc, DDLOCK_READONLY | DDLOCK_WAIT, NULL);
        ok(hr == DDERR_SURFACEBUSY, "Got unexpected hr %#lx for format %s.\n", hr, test_data[i].name);
        hr = IDirectDrawSurface_ReleaseDC(surface, dc);
        ok(SUCCEEDED(hr), "Failed to release DC for format %s, hr %#lx.\n", test_data[i].name, hr);

        hr = IDirectDrawSurface_Lock(surface, NULL, &map_desc, DDLOCK_READONLY | DDLOCK_WAIT, NULL);
        ok(SUCCEEDED(hr), "Failed to map surface for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_GetDC(surface, &dc);
        ok(SUCCEEDED(hr), "Failed to get DC for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_ReleaseDC(surface, dc);
        ok(SUCCEEDED(hr), "Failed to release DC for format %s, hr %#lx.\n", test_data[i].name, hr);
        /* Geforce 9600, Windows 7 returns E_FAIL. The unlock still seems to work as intended, after-
         * wards the surface can be locked again. ReleaseDC() does not unlock the surface, trying to
         * Lock it after ReleaseDC returns DDERR_SURFACEBUSY. ddraw4 and 7 are unaffected. */
        hr = IDirectDrawSurface_Unlock(surface, NULL);
        ok(SUCCEEDED(hr) || broken(ddraw_is_nvidia(ddraw) && hr == E_FAIL),
                "Failed to unmap surface for format %s, hr %#lx.\n", test_data[i].name, hr);

        hr = IDirectDrawSurface_GetDC(surface, &dc);
        ok(SUCCEEDED(hr), "Failed to get DC for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_GetDC(surface2, &dc2);
        ok(SUCCEEDED(hr), "Failed to get DC for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_ReleaseDC(surface2, dc2);
        ok(SUCCEEDED(hr), "Failed to release DC for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_ReleaseDC(surface, dc);
        ok(SUCCEEDED(hr), "Failed to release DC for format %s, hr %#lx.\n", test_data[i].name, hr);

        hr = IDirectDrawSurface_GetDC(surface2, &dc);
        ok(SUCCEEDED(hr), "Failed to get DC for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_GetDC(surface, &dc2);
        ok(SUCCEEDED(hr), "Failed to get DC for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_ReleaseDC(surface, dc2);
        ok(SUCCEEDED(hr), "Failed to release DC for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_ReleaseDC(surface2, dc);
        ok(SUCCEEDED(hr), "Failed to release DC for format %s, hr %#lx.\n", test_data[i].name, hr);

        hr = IDirectDrawSurface_Lock(surface, NULL, &map_desc, DDLOCK_READONLY | DDLOCK_WAIT, NULL);
        ok(SUCCEEDED(hr), "Failed to map surface for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_Lock(surface2, NULL, &map_desc, DDLOCK_READONLY | DDLOCK_WAIT, NULL);
        ok(SUCCEEDED(hr), "Failed to map surface for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_Unlock(surface2, NULL);
        ok(SUCCEEDED(hr), "Failed to unmap surface for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_Unlock(surface, NULL);
        ok(SUCCEEDED(hr), "Failed to unmap surface for format %s, hr %#lx.\n", test_data[i].name, hr);

        hr = IDirectDrawSurface_Lock(surface, NULL, &map_desc, DDLOCK_READONLY | DDLOCK_WAIT, NULL);
        ok(SUCCEEDED(hr), "Failed to map surface for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_GetDC(surface, &dc);
        ok(SUCCEEDED(hr), "Failed to get DC for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_ReleaseDC(surface, dc);
        ok(SUCCEEDED(hr), "Failed to release DC for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_Unlock(surface, NULL);
        ok(SUCCEEDED(hr) || broken(ddraw_is_nvidia(ddraw) && hr == E_FAIL),
                "Failed to unmap surface for format %s, hr %#lx.\n", test_data[i].name, hr);

        hr = IDirectDrawSurface_Lock(surface2, NULL, &map_desc, DDLOCK_READONLY | DDLOCK_WAIT, NULL);
        ok(SUCCEEDED(hr), "Failed to map surface for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_GetDC(surface, &dc);
        ok(SUCCEEDED(hr), "Failed to get DC for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_ReleaseDC(surface, dc);
        ok(SUCCEEDED(hr), "Failed to release DC for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_Unlock(surface2, NULL);
        ok(SUCCEEDED(hr), "Failed to unmap surface for format %s, hr %#lx.\n", test_data[i].name, hr);

        hr = IDirectDrawSurface_GetDC(surface, &dc);
        ok(SUCCEEDED(hr), "Failed to get DC for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_Lock(surface2, NULL, &map_desc, DDLOCK_READONLY | DDLOCK_WAIT, NULL);
        ok(SUCCEEDED(hr), "Failed to map surface for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_Unlock(surface2, NULL);
        ok(SUCCEEDED(hr), "Failed to unmap surface for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_ReleaseDC(surface, dc);
        ok(SUCCEEDED(hr), "Failed to release DC for format %s, hr %#lx.\n", test_data[i].name, hr);

        hr = IDirectDrawSurface_GetDC(surface2, &dc);
        ok(SUCCEEDED(hr), "Failed to get DC for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_Lock(surface, NULL, &map_desc, DDLOCK_READONLY | DDLOCK_WAIT, NULL);
        ok(SUCCEEDED(hr), "Failed to map surface for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_Unlock(surface, NULL);
        ok(SUCCEEDED(hr), "Failed to unmap surface for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_ReleaseDC(surface2, dc);
        ok(SUCCEEDED(hr), "Failed to release DC for format %s, hr %#lx.\n", test_data[i].name, hr);

        hr = IDirectDrawSurface_Unlock(surface, NULL);
        ok(hr == DDERR_NOTLOCKED, "Got unexpected hr %#lx for format %s.\n", hr, test_data[i].name);
        hr = IDirectDrawSurface_GetDC(surface2, &dc);
        ok(SUCCEEDED(hr), "Failed to get DC for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_Unlock(surface, NULL);
        ok(hr == DDERR_NOTLOCKED, "Got unexpected hr %#lx for format %s.\n", hr, test_data[i].name);
        hr = IDirectDrawSurface_ReleaseDC(surface2, dc);
        ok(SUCCEEDED(hr), "Failed to release DC for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_Unlock(surface, NULL);
        ok(hr == DDERR_NOTLOCKED, "Got unexpected hr %#lx for format %s.\n", hr, test_data[i].name);

        hr = IDirectDrawSurface_Unlock(surface2, NULL);
        ok(hr == DDERR_NOTLOCKED, "Got unexpected hr %#lx for format %s.\n", hr, test_data[i].name);
        hr = IDirectDrawSurface_GetDC(surface, &dc);
        ok(SUCCEEDED(hr), "Failed to get DC for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_Unlock(surface2, NULL);
        ok(hr == DDERR_NOTLOCKED, "Got unexpected hr %#lx for format %s.\n", hr, test_data[i].name);
        hr = IDirectDrawSurface_ReleaseDC(surface, dc);
        ok(SUCCEEDED(hr), "Failed to release DC for format %s, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirectDrawSurface_Unlock(surface2, NULL);
        ok(hr == DDERR_NOTLOCKED, "Got unexpected hr %#lx for format %s.\n", hr, test_data[i].name);

        IDirectDrawSurface_Release(surface2);
        IDirectDrawSurface_Release(surface);
    }

    IDirectDraw2_Release(ddraw);
    DestroyWindow(window);
}

static void test_draw_primitive(void)
{
    static WORD indices[] = {0, 1, 2, 3};
    static D3DVERTEX quad[] =
    {
        {{-1.0f}, {-1.0f}, {0.0f}},
        {{-1.0f}, { 1.0f}, {0.0f}},
        {{ 1.0f}, {-1.0f}, {0.0f}},
        {{ 1.0f}, { 1.0f}, {0.0f}},
    };
    IDirect3DViewport2 *viewport;
    IDirect3DDevice2 *device;
    IDirectDraw2 *ddraw;
    IDirect3D2 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    if (!(device = create_device(ddraw, window, DDSCL_NORMAL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        IDirectDraw2_Release(ddraw);
        DestroyWindow(window);
        return;
    }

    viewport = create_viewport(device, 0, 0, 640, 480);
    hr = IDirect3DDevice2_SetCurrentViewport(device, viewport);
    ok(SUCCEEDED(hr), "Failed to activate the viewport, hr %#lx.\n", hr);

    hr = IDirect3DDevice2_GetDirect3D(device, &d3d);
    ok(SUCCEEDED(hr), "Failed to get D3D interface, hr %#lx.\n", hr);

    IDirect3D2_Release(d3d);

    hr = IDirect3DDevice2_DrawIndexedPrimitive(device, D3DPT_TRIANGLESTRIP, D3DFVF_XYZ, NULL, 0, NULL, 0, 0);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, D3DFVF_XYZ, NULL, 0, 0);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice2_DrawIndexedPrimitive(device, D3DPT_TRIANGLESTRIP, D3DFVF_XYZ, NULL, 0, indices, 4, 0);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice2_DrawIndexedPrimitive(device, D3DPT_TRIANGLESTRIP, D3DFVF_XYZ, quad, 4, NULL, 0, 0);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, D3DFVF_XYZ, quad, 4, 0);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_DrawIndexedPrimitive(device, D3DPT_TRIANGLESTRIP, D3DFVF_XYZ, quad, 4, indices, 4, 0);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    destroy_viewport(device, viewport);
    refcount = IDirect3DDevice2_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirectDraw2_Release(ddraw);
    DestroyWindow(window);
}

static void test_edge_antialiasing_blending(void)
{
    D3DRECT clear_rect = {{0}, {0}, {640}, {480}};
    IDirect3DMaterial2 *green_background;
    IDirect3DMaterial2 *red_background;
    IDirectDrawSurface *offscreen, *ds;
    D3DDEVICEDESC hal_desc, hel_desc;
    IDirect3DViewport2 *viewport;
    DDSURFACEDESC surface_desc;
    IDirect3DDevice2 *device;
    IDirectDraw2 *ddraw;
    unsigned int color;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    static D3DMATRIX mat =
    {
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f,
    };
    static D3DLVERTEX green_quad[] =
    {
        {{-1.0f}, {-1.0f}, {0.1f}, 0, {0x7f00ff00}},
        {{-1.0f}, { 1.0f}, {0.1f}, 0, {0x7f00ff00}},
        {{ 1.0f}, {-1.0f}, {0.1f}, 0, {0x7f00ff00}},
        {{ 1.0f}, { 1.0f}, {0.1f}, 0, {0x7f00ff00}},
    };
    static D3DLVERTEX red_quad[] =
    {
        {{-1.0f}, {-1.0f}, {0.1f}, 0, {0xccff0000}},
        {{-1.0f}, { 1.0f}, {0.1f}, 0, {0xccff0000}},
        {{ 1.0f}, {-1.0f}, {0.1f}, 0, {0xccff0000}},
        {{ 1.0f}, { 1.0f}, {0.1f}, 0, {0xccff0000}},
    };

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    if (!(device = create_device(ddraw, window, DDSCL_NORMAL)))
    {
        skip("Failed to create a 3D device.\n");
        DestroyWindow(window);
        return;
    }

    memset(&hal_desc, 0, sizeof(hal_desc));
    hal_desc.dwSize = sizeof(hal_desc);
    memset(&hel_desc, 0, sizeof(hel_desc));
    hel_desc.dwSize = sizeof(hel_desc);
    hr = IDirect3DDevice2_GetCaps(device, &hal_desc, &hel_desc);
    ok(SUCCEEDED(hr), "Failed to get device caps, hr %#lx.\n", hr);
    trace("HAL line edge antialiasing support: %#lx.\n",
            hal_desc.dpcLineCaps.dwRasterCaps & D3DPRASTERCAPS_ANTIALIASEDGES);
    trace("HAL triangle edge antialiasing support: %#lx.\n",
            hal_desc.dpcTriCaps.dwRasterCaps & D3DPRASTERCAPS_ANTIALIASEDGES);
    trace("HEL line edge antialiasing support: %#lx.\n",
            hel_desc.dpcLineCaps.dwRasterCaps & D3DPRASTERCAPS_ANTIALIASEDGES);
    trace("HEL triangle edge antialiasing support: %#lx.\n",
            hel_desc.dpcTriCaps.dwRasterCaps & D3DPRASTERCAPS_ANTIALIASEDGES);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_WIDTH | DDSD_HEIGHT | DDSD_CAPS | DDSD_PIXELFORMAT;
    surface_desc.dwWidth = 640;
    surface_desc.dwHeight = 480;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN | DDSCAPS_3DDEVICE;
    surface_desc.ddpfPixelFormat.dwSize = sizeof(surface_desc.ddpfPixelFormat);
    surface_desc.ddpfPixelFormat.dwFlags = DDPF_RGB | DDPF_ALPHAPIXELS;
    surface_desc.ddpfPixelFormat.dwRGBBitCount = 32;
    surface_desc.ddpfPixelFormat.dwRBitMask = 0x00ff0000;
    surface_desc.ddpfPixelFormat.dwGBitMask = 0x0000ff00;
    surface_desc.ddpfPixelFormat.dwBBitMask = 0x000000ff;
    surface_desc.ddpfPixelFormat.dwRGBAlphaBitMask = 0xff000000;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &offscreen, NULL);
    ok(hr == D3D_OK, "Creating the offscreen render target failed, hr %#lx.\n", hr);

    ds = get_depth_stencil(device);
    hr = IDirectDrawSurface_AddAttachedSurface(offscreen, ds);
    todo_wine ok(SUCCEEDED(hr), "Failed to attach depth buffer, hr %#lx.\n", hr);
    IDirectDrawSurface_Release(ds);

    hr = IDirect3DDevice2_SetRenderTarget(device, offscreen, 0);
    ok(SUCCEEDED(hr), "Failed to set render target, hr %#lx.\n", hr);

    red_background = create_diffuse_material(device, 1.0f, 0.0f, 0.0f, 0.8f);
    green_background = create_diffuse_material(device, 0.0f, 1.0f, 0.0f, 0.5f);

    viewport = create_viewport(device, 0, 0, 640, 480);
    hr = IDirect3DDevice2_SetCurrentViewport(device, viewport);
    ok(SUCCEEDED(hr), "Failed to activate the viewport, hr %#lx.\n", hr);

    hr = IDirect3DDevice2_SetTransform(device, D3DTRANSFORMSTATE_WORLD, &mat);
    ok(SUCCEEDED(hr), "Failed to set world transform, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetTransform(device, D3DTRANSFORMSTATE_VIEW, &mat);
    ok(SUCCEEDED(hr), "Failed to set view transform, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetTransform(device, D3DTRANSFORMSTATE_PROJECTION, &mat);
    ok(SUCCEEDED(hr), "Failed to set projection transform, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_ZENABLE, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable Z test, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_FOGENABLE, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable fog, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_CULLMODE, D3DCULL_NONE);
    ok(SUCCEEDED(hr), "Failed to disable culling, hr %#lx.\n", hr);

    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_ALPHABLENDENABLE, TRUE);
    ok(SUCCEEDED(hr), "Failed to enable blending, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_SRCBLEND, D3DBLEND_SRCALPHA);
    ok(SUCCEEDED(hr), "Failed to set src blend, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_DESTBLEND, D3DBLEND_DESTALPHA);
    ok(SUCCEEDED(hr), "Failed to set dest blend, hr %#lx.\n", hr);

    viewport_set_background(device, viewport, red_background);
    hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET);
    ok(SUCCEEDED(hr), "Failed to clear render target, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, D3DVT_LVERTEX, green_quad, 4, 0);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);
    color = get_surface_color(offscreen, 320, 240);
    ok(compare_color(color, 0x00cc7f00, 1), "Got unexpected color 0x%08x.\n", color);

    viewport_set_background(device, viewport, green_background);
    hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET);
    ok(SUCCEEDED(hr), "Failed to clear render target, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, D3DVT_LVERTEX, red_quad, 4, 0);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);
    color = get_surface_color(offscreen, 320, 240);
    ok(compare_color(color, 0x00cc7f00, 1), "Got unexpected color 0x%08x.\n", color);

    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_ALPHABLENDENABLE, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable blending, hr %#lx.\n", hr);

    viewport_set_background(device, viewport, red_background);
    hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET);
    ok(SUCCEEDED(hr), "Failed to clear render target, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, D3DVT_LVERTEX, green_quad, 4, 0);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);
    color = get_surface_color(offscreen, 320, 240);
    ok(compare_color(color, 0x0000ff00, 1), "Got unexpected color 0x%08x.\n", color);

    viewport_set_background(device, viewport, green_background);
    hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET);
    ok(SUCCEEDED(hr), "Failed to clear render target, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, D3DVT_LVERTEX, red_quad, 4, 0);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);
    color = get_surface_color(offscreen, 320, 240);
    ok(compare_color(color, 0x00ff0000, 1), "Got unexpected color 0x%08x.\n", color);

    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_EDGEANTIALIAS, TRUE);
    ok(SUCCEEDED(hr), "Failed to enable edge antialiasing, hr %#lx.\n", hr);

    viewport_set_background(device, viewport, red_background);
    hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET);
    ok(SUCCEEDED(hr), "Failed to clear render target, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, D3DVT_LVERTEX, green_quad, 4, 0);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);
    color = get_surface_color(offscreen, 320, 240);
    ok(compare_color(color, 0x0000ff00, 1), "Got unexpected color 0x%08x.\n", color);

    viewport_set_background(device, viewport, green_background);
    hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET);
    ok(SUCCEEDED(hr), "Failed to clear render target, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, D3DVT_LVERTEX, red_quad, 4, 0);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);
    color = get_surface_color(offscreen, 320, 240);
    ok(compare_color(color, 0x00ff0000, 1), "Got unexpected color 0x%08x.\n", color);

    IDirectDrawSurface_Release(offscreen);
    destroy_viewport(device, viewport);
    destroy_material(red_background);
    destroy_material(green_background);
    refcount = IDirect3DDevice2_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirectDraw2_Release(ddraw);
    DestroyWindow(window);
}

/* TransformVertices always writes 32 bytes regardless of the input / output stride.
 * The stride is honored for navigating to the next vertex. 3 floats input position
 * are read, and 16 bytes extra vertex data are copied around. */
struct transform_input
{
    float x, y, z, unused1; /* Position data, transformed. */
    DWORD v1, v2, v3, v4; /* Extra data, e.g. color and texture coords, copied. */
    DWORD unused2;
};

struct transform_output
{
    float x, y, z, w;
    unsigned int v1, v2, v3, v4;
    unsigned int unused3, unused4;
};

static void test_transform_vertices(void)
{
    IDirect3DDevice2 *device;
    IDirectDrawSurface *rt;
    unsigned int color, i;
    IDirectDraw2 *ddraw;
    ULONG refcount;
    HWND window;
    HRESULT hr;
    IDirect3DViewport2 *viewport;
    IDirect3DMaterial2 *background;
    D3DMATERIAL mat;
    static struct transform_input position_tests[] =
    {
        { 0.0f,  0.0f,  0.0f, 0.0f,   1,   2,   3,   4,   5},
        { 1.0f,  1.0f,  1.0f, 8.0f,   6,   7,   8,   9,  10},
        {-1.0f, -1.0f, -1.0f, 4.0f,  11,  12,  13,  14,  15},
        { 0.5f,  0.5f,  0.5f, 2.0f,  16,  17,  18,  19,  20},
        {-0.5f, -0.5f, -0.5f, 1.0f, ~1U, ~2U, ~3U, ~4U, ~5U},
        {-0.5f, -0.5f,  0.0f, 0.0f, ~6U, ~7U, ~8U, ~9U, ~0U},
    };
    static struct transform_input cliptest[] =
    {
        { 25.59f,  25.59f,  1.0f,  0.0f, 1, 2, 3, 4, 5},
        { 25.61f,  25.61f,  1.01f, 0.0f, 1, 2, 3, 4, 5},
        {-25.59f, -25.59f,  0.0f,  0.0f, 1, 2, 3, 4, 5},
        {-25.61f, -25.61f, -0.01f, 0.0f, 1, 2, 3, 4, 5},
    };
    static struct transform_input offscreentest[] =
    {
        {128.1f, 0.0f, 0.0f, 0.0f, 1, 2, 3, 4, 5},
    };
    struct transform_output out[ARRAY_SIZE(position_tests)];
    D3DHVERTEX out_h[ARRAY_SIZE(position_tests)];
    D3DTRANSFORMDATA transformdata;
    static const D3DVIEWPORT vp_template =
    {
        sizeof(vp_template), 0, 0, 256, 256, 5.0f, 5.0f, 256.0f, 256.0f, -25.0f, 60.0f
    };
    D3DVIEWPORT vp_data =
    {
        sizeof(vp_data), 0, 0, 256, 256, 1.0f, 1.0f, 256.0f, 256.0f, 0.0f, 1.0f
    };
    D3DVIEWPORT2 vp2_data;
    DWORD offscreen;
    static D3DMATRIX mat_scale =
    {
        2.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 2.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 2.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f,
    },
    mat_translate1 =
    {
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        1.0f, 0.0f, 0.0f, 1.0f,
    },
    mat_translate2 =
    {
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 1.0f,
    },
    mat_transform3 =
    {
        1.0f,  0.0f, 0.0f, 0.0f,
        0.0f,  1.0f, 0.0f, 0.0f,
        0.0f,  0.0f, 1.0f, 0.0f,
        0.0f, 19.2f, 0.0f, 2.0f,
    },
    mat_identity =
    {
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f,
    };
    static D3DLVERTEX quad[] =
    {
        {{-0.75f},{-0.5f }, {0.0f}, 0, {0xffff0000}},
        {{-0.75f},{ 0.25f}, {0.0f}, 0, {0xffff0000}},
        {{ 0.5f}, {-0.5f }, {0.0f}, 0, {0xffff0000}},
        {{ 0.5f}, { 0.25f}, {0.0f}, 0, {0xffff0000}},
    };
    static D3DRECT clear_rect = {{0}, {0}, {640}, {480}};


    for (i = 0; i < ARRAY_SIZE(out); ++i)
    {
        out[i].unused3 = 0xdeadbeef;
        out[i].unused4 = 0xcafecafe;
    }

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    if (!(device = create_device(ddraw, window, DDSCL_NORMAL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        IDirectDraw2_Release(ddraw);
        DestroyWindow(window);
        return;
    }
    hr = IDirect3DDevice2_GetRenderTarget(device, &rt);
    ok(SUCCEEDED(hr), "Failed to get render target, hr %#lx.\n", hr);

    viewport = create_viewport(device, 0, 0, 256, 256);
    hr = IDirect3DViewport2_SetViewport(viewport, &vp_data);
    ok(SUCCEEDED(hr), "Failed to set viewport, hr %#lx.\n", hr);

    memset(&transformdata, 0, sizeof(transformdata));
    transformdata.dwSize = sizeof(transformdata);
    transformdata.lpIn = position_tests;
    transformdata.dwInSize = sizeof(position_tests[0]);
    transformdata.lpOut = out;
    transformdata.dwOutSize = sizeof(out[0]);
    transformdata.lpHOut = NULL;

    hr = IDirect3DViewport2_TransformVertices(viewport, ARRAY_SIZE(position_tests),
            &transformdata, D3DTRANSFORM_UNCLIPPED, &offscreen);
    ok(SUCCEEDED(hr), "Failed to transform vertices, hr %#lx.\n", hr);
    ok(!offscreen, "Offscreen is %#lx.\n", offscreen);

    for (i = 0; i < ARRAY_SIZE(position_tests); ++i)
    {
        static const struct vec4 cmp[] =
        {
            {128.0f, 128.0f, 0.0f, 1.0f}, {129.0f, 127.0f,  1.0f, 1.0f}, {127.0f, 129.0f, -1.0f, 1.0f},
            {128.5f, 127.5f, 0.5f, 1.0f}, {127.5f, 128.5f, -0.5f, 1.0f}, {127.5f, 128.5f,  0.0f, 1.0f}
        };

        ok(compare_vec4(&cmp[i], out[i].x, out[i].y, out[i].z, out[i].w, 4096),
                "Vertex %u differs. Got %.8e %.8e %.8e %.8e.\n", i,
                out[i].x, out[i].y, out[i].z, out[i].w);
        ok(out[i].v1 == position_tests[i].v1 && out[i].v2 == position_tests[i].v2
                && out[i].v3 == position_tests[i].v3 && out[i].v4 == position_tests[i].v4,
                "Vertex %u payload is %u %u %u %u.\n", i, out[i].v1, out[i].v2, out[i].v3, out[i].v4);
        ok(out[i].unused3 == 0xdeadbeef && out[i].unused4 == 0xcafecafe,
                "Vertex %u unused data is %#x, %#x.\n", i, out[i].unused3, out[i].unused4);
    }

    vp_data = vp_template;
    hr = IDirect3DViewport2_SetViewport(viewport, &vp_data);
    ok(SUCCEEDED(hr), "Failed to set viewport, hr %#lx.\n", hr);
    offscreen = 0xdeadbeef;
    hr = IDirect3DViewport2_TransformVertices(viewport, ARRAY_SIZE(position_tests),
            &transformdata, D3DTRANSFORM_UNCLIPPED, &offscreen);
    ok(SUCCEEDED(hr), "Failed to transform vertices, hr %#lx.\n", hr);
    ok(!offscreen, "Offscreen is %#lx.\n", offscreen);

    for (i = 0; i < ARRAY_SIZE(position_tests); ++i)
    {
        static const struct vec4 cmp[] =
        {
            {128.0f, 128.0f, 0.0f, 1.0f}, {133.0f, 123.0f,  1.0f, 1.0f}, {123.0f, 133.0f, -1.0f, 1.0f},
            {130.5f, 125.5f, 0.5f, 1.0f}, {125.5f, 130.5f, -0.5f, 1.0f}, {125.5f, 130.5f,  0.0f, 1.0f}
        };
        ok(compare_vec4(&cmp[i], out[i].x, out[i].y, out[i].z, out[i].w, 4096),
                "Vertex %u differs. Got %.8e %.8e %.8e %.8e.\n", i,
                out[i].x, out[i].y, out[i].z, out[i].w);
    }

    vp_data.dwX = 10;
    vp_data.dwY = 20;
    hr = IDirect3DViewport2_SetViewport(viewport, &vp_data);
    ok(SUCCEEDED(hr), "Failed to set viewport, hr %#lx.\n", hr);
    offscreen = 0xdeadbeef;
    hr = IDirect3DViewport2_TransformVertices(viewport, ARRAY_SIZE(position_tests),
            &transformdata, D3DTRANSFORM_UNCLIPPED, &offscreen);
    ok(SUCCEEDED(hr), "Failed to transform vertices, hr %#lx.\n", hr);
    ok(!offscreen, "Offscreen is %#lx.\n", offscreen);
    for (i = 0; i < ARRAY_SIZE(position_tests); ++i)
    {
        static const struct vec4 cmp[] =
        {
            {138.0f, 148.0f, 0.0f, 1.0f}, {143.0f, 143.0f,  1.0f, 1.0f}, {133.0f, 153.0f, -1.0f, 1.0f},
            {140.5f, 145.5f, 0.5f, 1.0f}, {135.5f, 150.5f, -0.5f, 1.0f}, {135.5f, 150.5f,  0.0f, 1.0f}
        };
        ok(compare_vec4(&cmp[i], out[i].x, out[i].y, out[i].z, out[i].w, 4096),
                "Vertex %u differs. Got %.8e %.8e %.8e %.8e.\n", i,
                out[i].x, out[i].y, out[i].z, out[i].w);
    }

    transformdata.lpHOut = out_h;
    offscreen = 0xdeadbeef;
    hr = IDirect3DViewport2_TransformVertices(viewport, ARRAY_SIZE(position_tests),
            &transformdata, D3DTRANSFORM_CLIPPED, &offscreen);
    ok(SUCCEEDED(hr), "Failed to transform vertices, hr %#lx.\n", hr);
    ok(!offscreen, "Offscreen is %#lx.\n", offscreen);
    for (i = 0; i < ARRAY_SIZE(position_tests); ++i)
    {
        static const D3DHVERTEX cmp_h[] =
        {
            {0,             { 0.0f}, { 0.0f}, { 0.0f}}, {0, { 1.0f}, { 1.0f}, {1.0f}},
            {D3DCLIP_FRONT, {-1.0f}, {-1.0f}, {-1.0f}}, {0, { 0.5f}, { 0.5f}, {0.5f}},
            {D3DCLIP_FRONT, {-0.5f}, {-0.5f}, {-0.5f}}, {0, {-0.5f}, {-0.5f}, {0.0f}}
        };
        ok(compare_float(cmp_h[i].hx, out_h[i].hx, 4096)
                && compare_float(cmp_h[i].hy, out_h[i].hy, 4096)
                && compare_float(cmp_h[i].hz, out_h[i].hz, 4096)
                && cmp_h[i].dwFlags == out_h[i].dwFlags,
                "HVertex %u differs. Got %#lx %.8e %.8e %.8e.\n", i,
                out_h[i].dwFlags, out_h[i].hx, out_h[i].hy, out_h[i].hz);

        /* No scheme has been found behind those return values. It seems to be
         * whatever data windows has when throwing the vertex away. Modify the
         * input test vertices to test this more. Depending on the input data
         * it can happen that the z coord gets written into y, or similar things. */
        if (0)
        {
            static const struct vec4 cmp[] =
            {
                {138.0f, 148.0f, 0.0f, 1.0f}, {143.0f, 143.0f,  1.0f, 1.0f}, { -1.0f,  -1.0f, 0.5f, 1.0f},
                {140.5f, 145.5f, 0.5f, 1.0f}, { -0.5f,  -0.5f, -0.5f, 1.0f}, {135.5f, 150.5f, 0.0f, 1.0f}
            };
            ok(compare_vec4(&cmp[i], out[i].x, out[i].y, out[i].z, out[i].w, 4096),
                    "Vertex %u differs. Got %.8e %.8e %.8e %.8e.\n", i,
                    out[i].x, out[i].y, out[i].z, out[i].w);
        }
    }

    transformdata.lpIn = cliptest;
    transformdata.dwInSize = sizeof(cliptest[0]);
    offscreen = 0xdeadbeef;
    hr = IDirect3DViewport2_TransformVertices(viewport, ARRAY_SIZE(cliptest),
            &transformdata, D3DTRANSFORM_CLIPPED, &offscreen);
    ok(SUCCEEDED(hr), "Failed to transform vertices, hr %#lx.\n", hr);
    ok(!offscreen, "Offscreen is %#lx.\n", offscreen);
    for (i = 0; i < ARRAY_SIZE(cliptest); ++i)
    {
        static const DWORD flags[] =
        {
            0,
            D3DCLIP_RIGHT | D3DCLIP_BACK   | D3DCLIP_TOP,
            0,
            D3DCLIP_LEFT  | D3DCLIP_BOTTOM | D3DCLIP_FRONT,
        };
        ok(flags[i] == out_h[i].dwFlags, "Cliptest %u returned %#lx.\n", i, out_h[i].dwFlags);
    }

    vp_data = vp_template;
    vp_data.dwWidth = 10;
    vp_data.dwHeight = 480;
    hr = IDirect3DViewport2_SetViewport(viewport, &vp_data);
    ok(SUCCEEDED(hr), "Failed to set viewport, hr %#lx.\n", hr);
    offscreen = 0xdeadbeef;
    hr = IDirect3DViewport2_TransformVertices(viewport, ARRAY_SIZE(cliptest),
            &transformdata, D3DTRANSFORM_CLIPPED, &offscreen);
    ok(SUCCEEDED(hr), "Failed to transform vertices, hr %#lx.\n", hr);
    ok(!offscreen, "Offscreen is %#lx.\n", offscreen);
    for (i = 0; i < ARRAY_SIZE(cliptest); ++i)
    {
        static const DWORD flags[] =
        {
            D3DCLIP_RIGHT,
            D3DCLIP_RIGHT | D3DCLIP_BACK,
            D3DCLIP_LEFT,
            D3DCLIP_LEFT  | D3DCLIP_FRONT,
        };
        ok(flags[i] == out_h[i].dwFlags, "Cliptest %u returned %#lx.\n", i, out_h[i].dwFlags);
    }

    vp_data = vp_template;
    vp_data.dwWidth = 256;
    vp_data.dwHeight = 256;
    vp_data.dvScaleX = 1;
    vp_data.dvScaleY = 1;
    hr = IDirect3DViewport2_SetViewport(viewport, &vp_data);
    ok(SUCCEEDED(hr), "Failed to set viewport, hr %#lx.\n", hr);
    hr = IDirect3DViewport2_TransformVertices(viewport, ARRAY_SIZE(cliptest),
            &transformdata, D3DTRANSFORM_CLIPPED, &offscreen);
    ok(SUCCEEDED(hr), "Failed to transform vertices, hr %#lx.\n", hr);
    ok(!offscreen, "Offscreen is %#lx.\n", offscreen);
    for (i = 0; i < ARRAY_SIZE(cliptest); ++i)
    {
        static const DWORD flags[] =
        {
            0,
            D3DCLIP_BACK,
            0,
            D3DCLIP_FRONT,
        };
        ok(flags[i] == out_h[i].dwFlags, "Cliptest %u returned %#lx.\n", i, out_h[i].dwFlags);
    }

    /* Finally try to figure out how the DWORD dwOffscreen works.
     * It is a logical AND of the vertices' dwFlags members. */
    vp_data = vp_template;
    vp_data.dwWidth = 5;
    vp_data.dwHeight = 5;
    vp_data.dvScaleX = 10000.0f;
    vp_data.dvScaleY = 10000.0f;
    hr = IDirect3DViewport2_SetViewport(viewport, &vp_data);
    ok(SUCCEEDED(hr), "Failed to set viewport, hr %#lx.\n", hr);
    transformdata.lpIn = cliptest;
    offscreen = 0xdeadbeef;
    hr = IDirect3DViewport2_TransformVertices(viewport, 1,
            &transformdata, D3DTRANSFORM_UNCLIPPED, &offscreen);
    ok(SUCCEEDED(hr), "Failed to transform vertices, hr %#lx.\n", hr);
    ok(!offscreen, "Offscreen is %#lx.\n", offscreen);

    offscreen = 0xdeadbeef;
    hr = IDirect3DViewport2_TransformVertices(viewport, 1,
            &transformdata, D3DTRANSFORM_CLIPPED, &offscreen);
    ok(SUCCEEDED(hr), "Failed to transform vertices, hr %#lx.\n", hr);
    ok(offscreen == (D3DCLIP_RIGHT | D3DCLIP_TOP), "Offscreen is %#lx.\n", offscreen);
    offscreen = 0xdeadbeef;
    hr = IDirect3DViewport2_TransformVertices(viewport, 2,
            &transformdata, D3DTRANSFORM_CLIPPED, &offscreen);
    ok(SUCCEEDED(hr), "Failed to transform vertices, hr %#lx.\n", hr);
    ok(offscreen == (D3DCLIP_RIGHT | D3DCLIP_TOP), "Offscreen is %#lx.\n", offscreen);
    hr = IDirect3DViewport2_TransformVertices(viewport, 3,
            &transformdata, D3DTRANSFORM_CLIPPED, &offscreen);
    ok(SUCCEEDED(hr), "Failed to transform vertices, hr %#lx.\n", hr);
    ok(!offscreen, "Offscreen is %#lx.\n", offscreen);

    transformdata.lpIn = cliptest + 1;
    hr = IDirect3DViewport2_TransformVertices(viewport, 1,
            &transformdata, D3DTRANSFORM_CLIPPED, &offscreen);
    ok(SUCCEEDED(hr), "Failed to transform vertices, hr %#lx.\n", hr);
    ok(offscreen == (D3DCLIP_BACK | D3DCLIP_RIGHT | D3DCLIP_TOP), "Offscreen is %#lx.\n", offscreen);

    transformdata.lpIn = cliptest + 2;
    hr = IDirect3DViewport2_TransformVertices(viewport, 1,
            &transformdata, D3DTRANSFORM_CLIPPED, &offscreen);
    ok(SUCCEEDED(hr), "Failed to transform vertices, hr %#lx.\n", hr);
    ok(offscreen == (D3DCLIP_BOTTOM | D3DCLIP_LEFT), "Offscreen is %#lx.\n", offscreen);
    offscreen = 0xdeadbeef;
    hr = IDirect3DViewport2_TransformVertices(viewport, 2,
            &transformdata, D3DTRANSFORM_CLIPPED, &offscreen);
    ok(SUCCEEDED(hr), "Failed to transform vertices, hr %#lx.\n", hr);
    ok(offscreen == (D3DCLIP_BOTTOM | D3DCLIP_LEFT), "Offscreen is %#lx.\n", offscreen);

    transformdata.lpIn = cliptest + 3;
    hr = IDirect3DViewport2_TransformVertices(viewport, 1,
            &transformdata, D3DTRANSFORM_CLIPPED, &offscreen);
    ok(SUCCEEDED(hr), "Failed to transform vertices, hr %#lx.\n", hr);
    ok(offscreen == (D3DCLIP_FRONT | D3DCLIP_BOTTOM | D3DCLIP_LEFT), "Offscreen is %#lx.\n", offscreen);

    transformdata.lpIn = offscreentest;
    transformdata.dwInSize = sizeof(offscreentest[0]);
    vp_data = vp_template;
    vp_data.dwWidth = 257;
    vp_data.dwHeight = 257;
    vp_data.dvScaleX = 1.0f;
    vp_data.dvScaleY = 1.0f;
    hr = IDirect3DViewport2_SetViewport(viewport, &vp_data);
    ok(SUCCEEDED(hr), "Failed to set viewport, hr %#lx.\n", hr);
    offscreen = 0xdeadbeef;
    hr = IDirect3DViewport2_TransformVertices(viewport, 1,
            &transformdata, D3DTRANSFORM_CLIPPED, &offscreen);
    ok(SUCCEEDED(hr), "Failed to transform vertices, hr %#lx.\n", hr);
    ok(!offscreen, "Offscreen is %#lx.\n", offscreen);

    vp_data.dwWidth = 256;
    vp_data.dwHeight = 256;
    hr = IDirect3DViewport2_SetViewport(viewport, &vp_data);
    ok(SUCCEEDED(hr), "Failed to set viewport, hr %#lx.\n", hr);
    hr = IDirect3DViewport2_TransformVertices(viewport, 1,
            &transformdata, D3DTRANSFORM_CLIPPED, &offscreen);
    ok(SUCCEEDED(hr), "Failed to transform vertices, hr %#lx.\n", hr);
    ok(offscreen == D3DCLIP_RIGHT, "Offscreen is %#lx.\n", offscreen);

    /* Test the effect of Matrices.
     *
     * Basically the x coordinate ends up as ((x + 1) * 2 + 0) * 5 and
     * y as ((y + 0) * 2 + 1) * 5. The 5 comes from dvScaleX/Y, 2 from
     * the view matrix and the +1's from the world and projection matrix. */
    vp_data.dwX = 0;
    vp_data.dwY = 0;
    vp_data.dwWidth = 256;
    vp_data.dwHeight = 256;
    vp_data.dvScaleX = 5.0f;
    vp_data.dvScaleY = 5.0f;
    vp_data.dvMinZ = 0.0f;
    vp_data.dvMaxZ = 1.0f;
    hr = IDirect3DViewport2_SetViewport(viewport, &vp_data);
    ok(SUCCEEDED(hr), "Failed to set viewport, hr %#lx.\n", hr);

    hr = IDirect3DDevice2_SetTransform(device, D3DTRANSFORMSTATE_WORLD, &mat_translate1);
    ok(SUCCEEDED(hr), "Failed to set world transform, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetTransform(device, D3DTRANSFORMSTATE_VIEW, &mat_scale);
    ok(SUCCEEDED(hr), "Failed to set world transform, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetTransform(device, D3DTRANSFORMSTATE_PROJECTION, &mat_translate2);
    ok(SUCCEEDED(hr), "Failed to set world transform, hr %#lx.\n", hr);

    transformdata.lpIn = position_tests;
    transformdata.dwInSize = sizeof(position_tests[0]);
    hr = IDirect3DViewport2_TransformVertices(viewport, ARRAY_SIZE(position_tests),
            &transformdata, D3DTRANSFORM_UNCLIPPED, &offscreen);
    ok(SUCCEEDED(hr), "Failed to transform vertices, hr %#lx.\n", hr);

    for (i = 0; i < ARRAY_SIZE(position_tests); ++i)
    {
        static const struct vec4 cmp[] =
        {
            {138.0f, 123.0f, 0.0f, 1.0f}, {148.0f, 113.0f,  2.0f, 1.0f}, {128.0f, 133.0f, -2.0f, 1.0f},
            {143.0f, 118.0f, 1.0f, 1.0f}, {133.0f, 128.0f, -1.0f, 1.0f}, {133.0f, 128.0f,  0.0f, 1.0f}
        };

        ok(compare_vec4(&cmp[i], out[i].x, out[i].y, out[i].z, out[i].w, 4096),
                "Vertex %u differs. Got %.8e %.8e %.8e %.8e.\n", i,
                out[i].x, out[i].y, out[i].z, out[i].w);
    }

    /* Invalid flags. */
    offscreen = 0xdeadbeef;
    hr = IDirect3DViewport2_TransformVertices(viewport, ARRAY_SIZE(position_tests),
            &transformdata, 0, &offscreen);
    ok(hr == DDERR_INVALIDPARAMS, "Got hr %#lx.\n", hr);
    ok(offscreen == 0xdeadbeef, "Offscreen is %#lx.\n", offscreen);

    /* NULL transform data. */
    hr = IDirect3DViewport2_TransformVertices(viewport, 1,
            NULL, D3DTRANSFORM_UNCLIPPED, &offscreen);
    ok(hr == DDERR_INVALIDPARAMS, "Got hr %#lx.\n", hr);
    ok(offscreen == 0xdeadbeef, "Offscreen is %#lx.\n", offscreen);
    hr = IDirect3DViewport2_TransformVertices(viewport, 0,
            NULL, D3DTRANSFORM_UNCLIPPED, &offscreen);
    ok(hr == DDERR_INVALIDPARAMS, "Got hr %#lx.\n", hr);
    ok(offscreen == 0xdeadbeef, "Offscreen is %#lx.\n", offscreen);

    /* NULL transform data and NULL dwOffscreen.
     *
     * Valid transform data + NULL dwOffscreen -> crash. */
    hr = IDirect3DViewport2_TransformVertices(viewport, 1,
            NULL, D3DTRANSFORM_UNCLIPPED, NULL);
    ok(hr == DDERR_INVALIDPARAMS, "Got hr %#lx.\n", hr);

    /* No vertices. */
    hr = IDirect3DViewport2_TransformVertices(viewport, 0,
            &transformdata, D3DTRANSFORM_UNCLIPPED, &offscreen);
    ok(SUCCEEDED(hr), "Failed to transform vertices, hr %#lx.\n", hr);
    ok(!offscreen, "Offscreen is %#lx.\n", offscreen);
    hr = IDirect3DViewport2_TransformVertices(viewport, 0,
            &transformdata, D3DTRANSFORM_CLIPPED, &offscreen);
    ok(SUCCEEDED(hr), "Failed to transform vertices, hr %#lx.\n", hr);
    ok(offscreen == ~0u, "Offscreen is %#lx.\n", offscreen);

    /* Invalid sizes. */
    offscreen = 0xdeadbeef;
    transformdata.dwSize = sizeof(transformdata) - 1;
    hr = IDirect3DViewport2_TransformVertices(viewport, 1,
            &transformdata, D3DTRANSFORM_UNCLIPPED, &offscreen);
    ok(hr == DDERR_INVALIDPARAMS, "Got hr %#lx.\n", hr);
    ok(offscreen == 0xdeadbeef, "Offscreen is %#lx.\n", offscreen);
    transformdata.dwSize = sizeof(transformdata) + 1;
    hr = IDirect3DViewport2_TransformVertices(viewport, 1,
            &transformdata, D3DTRANSFORM_UNCLIPPED, &offscreen);
    ok(hr == DDERR_INVALIDPARAMS, "Got hr %#lx.\n", hr);
    ok(offscreen == 0xdeadbeef, "Offscreen is %#lx.\n", offscreen);

    /* NULL lpIn or lpOut -> crash, except when transforming 0 vertices. */
    transformdata.dwSize = sizeof(transformdata);
    transformdata.lpIn = NULL;
    transformdata.lpOut = NULL;
    offscreen = 0xdeadbeef;
    hr = IDirect3DViewport2_TransformVertices(viewport, 0,
            &transformdata, D3DTRANSFORM_CLIPPED, &offscreen);
    ok(SUCCEEDED(hr), "Failed to transform vertices, hr %#lx.\n", hr);
    ok(offscreen == ~0u, "Offscreen is %#lx.\n", offscreen);

    /* Test how vertices are transformed during draws. */
    vp_data.dwX = 20;
    vp_data.dwY = 20;
    vp_data.dwWidth = 200;
    vp_data.dwHeight = 400;
    vp_data.dvScaleX = 20.0f;
    vp_data.dvScaleY = 50.0f;
    vp_data.dvMinZ = 0.0f;
    vp_data.dvMaxZ = 1.0f;
    hr = IDirect3DViewport2_SetViewport(viewport, &vp_data);
    ok(SUCCEEDED(hr), "Failed to set viewport, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetCurrentViewport(device, viewport);
    ok(SUCCEEDED(hr), "Failed to activate the viewport, hr %#lx.\n", hr);

    ok(SUCCEEDED(hr), "Failed to clear the render target, hr %#lx.\n", hr);
    background = create_diffuse_material(device, 0.0f, 0.0f, 1.0f, 0.0f);
    viewport_set_background(device, viewport, background);
    hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET);
    ok(SUCCEEDED(hr), "Failed to clear viewport, hr %#lx.\n", hr);

    hr = IDirect3DDevice2_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, D3DVT_LVERTEX, quad, 4, 0);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

    color = get_surface_color(rt, 128, 143);
    ok(compare_color(color, 0x000000ff, 1), "Got unexpected color 0x%08x.\n", color);
    color = get_surface_color(rt, 132, 143);
    ok(compare_color(color, 0x000000ff, 1), "Got unexpected color 0x%08x.\n", color);
    color = get_surface_color(rt, 128, 147);
    ok(compare_color(color, 0x000000ff, 1), "Got unexpected color 0x%08x.\n", color);
    color = get_surface_color(rt, 132, 147);
    ok(compare_color(color, 0x00ff0000, 1), "Got unexpected color 0x%08x.\n", color);

    color = get_surface_color(rt, 177, 217);
    ok(compare_color(color, 0x00ff0000, 1), "Got unexpected color 0x%08x.\n", color);
    color = get_surface_color(rt, 181, 217);
    ok(compare_color(color, 0x000000ff, 1), "Got unexpected color 0x%08x.\n", color);
    color = get_surface_color(rt, 177, 221);
    ok(compare_color(color, 0x000000ff, 1), "Got unexpected color 0x%08x.\n", color);
    color = get_surface_color(rt, 181, 221);
    ok(compare_color(color, 0x000000ff, 1), "Got unexpected color 0x%08x.\n", color);

    /* Test D3DVIEWPORT2 behavior. */
    vp2_data.dwSize = sizeof(vp2_data);
    vp2_data.dwX = 20;
    vp2_data.dwY = 20;
    vp2_data.dwWidth = 200;
    vp2_data.dwHeight = 400;
    vp2_data.dvClipX = -0.5f;
    vp2_data.dvClipY = 4.0f;
    vp2_data.dvClipWidth = 5.0f;
    vp2_data.dvClipHeight = 10.0f;
    vp2_data.dvMinZ = 0.0f;
    vp2_data.dvMaxZ = 2.0f;
    hr = IDirect3DViewport2_SetViewport2(viewport, &vp2_data);
    ok(SUCCEEDED(hr), "Failed to set viewport data, hr %#lx.\n", hr);
    transformdata.lpIn = position_tests;
    transformdata.lpOut = out;
    hr = IDirect3DViewport2_TransformVertices(viewport, ARRAY_SIZE(position_tests),
            &transformdata, D3DTRANSFORM_UNCLIPPED, &offscreen);
    ok(SUCCEEDED(hr), "Failed to transform vertices, hr %#lx.\n", hr);
    for (i = 0; i < ARRAY_SIZE(position_tests); ++i)
    {
        static const struct vec4 cmp[] =
        {
            {120.0f, 140.0f, 0.0f, 1.0f}, {200.0f,  60.0f,  1.0f, 1.0f}, {40.0f, 220.0f, -1.0f, 1.0f},
            {160.0f, 100.0f, 0.5f, 1.0f}, { 80.0f, 180.0f, -0.5f, 1.0f}, {80.0f, 180.0f,  0.0f, 1.0f}
        };

        ok(compare_vec4(&cmp[i], out[i].x, out[i].y, out[i].z, out[i].w, 4096),
                "Vertex %u differs. Got %.8e %.8e %.8e %.8e.\n", i,
                out[i].x, out[i].y, out[i].z, out[i].w);
    }

    memset(&mat, 0, sizeof(mat));
    mat.dwSize = sizeof(mat);
    mat.diffuse.r = 0.0f;
    mat.diffuse.g = 1.0f;
    mat.diffuse.b = 0.0f;
    mat.diffuse.a = 0.0f;
    hr = IDirect3DMaterial2_SetMaterial(background, &mat);
    ok(SUCCEEDED(hr), "Failed to set material data, hr %#lx.\n", hr);
    hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET);
    ok(SUCCEEDED(hr), "Failed to clear viewport, hr %#lx.\n", hr);

    hr = IDirect3DDevice2_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, D3DVT_LVERTEX, quad, 4, 0);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

    color = get_surface_color(rt, 58, 118);
    ok(compare_color(color, 0x0000ff00, 1), "Got unexpected color 0x%08x.\n", color);
    color = get_surface_color(rt, 62, 118);
    ok(compare_color(color, 0x0000ff00, 1), "Got unexpected color 0x%08x.\n", color);
    color = get_surface_color(rt, 58, 122);
    ok(compare_color(color, 0x0000ff00, 1), "Got unexpected color 0x%08x.\n", color);
    color = get_surface_color(rt, 62, 122);
    ok(compare_color(color, 0x00ff0000, 1), "Got unexpected color 0x%08x.\n", color);

    color = get_surface_color(rt, 157, 177);
    ok(compare_color(color, 0x00ff0000, 1), "Got unexpected color 0x%08x.\n", color);
    color = get_surface_color(rt, 161, 177);
    ok(compare_color(color, 0x0000ff00, 1), "Got unexpected color 0x%08x.\n", color);
    color = get_surface_color(rt, 157, 181);
    ok(compare_color(color, 0x0000ff00, 1), "Got unexpected color 0x%08x.\n", color);
    color = get_surface_color(rt, 161, 181);
    ok(compare_color(color, 0x0000ff00, 1), "Got unexpected color 0x%08x.\n", color);

    hr = IDirect3DDevice2_SetTransform(device, D3DTRANSFORMSTATE_WORLD, &mat_identity);
    ok(SUCCEEDED(hr), "Failed to set world transform, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetTransform(device, D3DTRANSFORMSTATE_VIEW, &mat_identity);
    ok(SUCCEEDED(hr), "Failed to set world transform, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetTransform(device, D3DTRANSFORMSTATE_PROJECTION, &mat_transform3);
    ok(SUCCEEDED(hr), "Failed to set world transform, hr %#lx.\n", hr);

    vp2_data.dwX = 0.0;
    vp2_data.dwY = 0.0;
    vp2_data.dwWidth = 1;
    vp2_data.dwHeight = 1;
    vp2_data.dvClipX = -12.8f;
    vp2_data.dvClipY = 12.8f + mat_transform3._42 / mat_transform3._44;
    vp2_data.dvClipWidth = 25.6f;
    vp2_data.dvClipHeight = 25.6f;
    vp2_data.dvMinZ = 0.0f;
    vp2_data.dvMaxZ = 0.5f;
    hr = IDirect3DViewport2_SetViewport2(viewport, &vp2_data);
    ok(SUCCEEDED(hr), "Failed to set viewport data, hr %#lx.\n", hr);
    transformdata.lpIn = cliptest;
    transformdata.dwInSize = sizeof(cliptest[0]);
    offscreen = 0xdeadbeef;
    hr = IDirect3DViewport2_TransformVertices(viewport, ARRAY_SIZE(cliptest),
            &transformdata, D3DTRANSFORM_CLIPPED, &offscreen);
    ok(SUCCEEDED(hr), "Failed to transform vertices, hr %#lx.\n", hr);
    ok(!offscreen, "Offscreen is %#lx.\n", offscreen);
    for (i = 0; i < ARRAY_SIZE(cliptest); ++i)
    {
        static const D3DHVERTEX cmp_h[] =
        {
            {0,                                            { 25.59f}, { 44.79f}, { 1.0f }},
            {D3DCLIP_RIGHT | D3DCLIP_TOP | D3DCLIP_BACK,   { 25.61f}, { 44.81f}, { 1.01f}},
            {0,                                            {-25.59f}, {-6.39f }, { 0.0f }},
            {D3DCLIP_LEFT | D3DCLIP_BOTTOM | D3DCLIP_FRONT,{-25.61f}, {-6.41f }, {-0.01f}},
        };
        ok(compare_float(cmp_h[i].hx, out_h[i].hx, 4096)
                && compare_float(cmp_h[i].hy, out_h[i].hy, 4096)
                && compare_float(cmp_h[i].hz, out_h[i].hz, 4096)
                && cmp_h[i].dwFlags == out_h[i].dwFlags,
                "HVertex %u differs. Got %#lx %.8e %.8e %.8e.\n", i,
                out_h[i].dwFlags, out_h[i].hx, out_h[i].hy, out_h[i].hz);
    }

    IDirectDrawSurface_Release(rt);
    destroy_viewport(device, viewport);
    IDirect3DMaterial2_Release(background);
    refcount = IDirect3DDevice_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirectDraw2_Release(ddraw);
    DestroyWindow(window);
}

static void test_display_mode_surface_pixel_format(void)
{
    unsigned int width, height, bpp;
    IDirectDrawSurface *surface;
    DDSURFACEDESC surface_desc;
    IDirectDraw2 *ddraw;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    if (!(ddraw = create_ddraw()))
    {
        skip("Failed to create ddraw.\n");
        return;
    }

    surface_desc.dwSize = sizeof(surface_desc);
    hr = IDirectDraw2_GetDisplayMode(ddraw, &surface_desc);
    ok(SUCCEEDED(hr), "Failed to get display mode, hr %#lx.\n", hr);
    width = surface_desc.dwWidth;
    height = surface_desc.dwHeight;

    window = CreateWindowA("static", "ddraw_test", WS_OVERLAPPEDWINDOW,
            0, 0, width, height, NULL, NULL, NULL, NULL);
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    bpp = 0;
    if (SUCCEEDED(IDirectDraw2_SetDisplayMode(ddraw, width, height, 16, 0, 0)))
        bpp = 16;
    if (SUCCEEDED(IDirectDraw2_SetDisplayMode(ddraw, width, height, 24, 0, 0)))
        bpp = 24;
    if (SUCCEEDED(IDirectDraw2_SetDisplayMode(ddraw, width, height, 32, 0, 0)))
        bpp = 32;
    ok(bpp, "Set display mode failed.\n");

    surface_desc.dwSize = sizeof(surface_desc);
    hr = IDirectDraw2_GetDisplayMode(ddraw, &surface_desc);
    ok(SUCCEEDED(hr), "Failed to get display mode, hr %#lx.\n", hr);
    ok(surface_desc.dwWidth == width, "Got width %lu, expected %u.\n", surface_desc.dwWidth, width);
    ok(surface_desc.dwHeight == height, "Got height %lu, expected %u.\n", surface_desc.dwHeight, height);
    ok(surface_desc.ddpfPixelFormat.dwRGBBitCount == bpp, "Got bpp %lu, expected %u.\n",
            surface_desc.ddpfPixelFormat.dwRGBBitCount, bpp);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_BACKBUFFERCOUNT;
    surface_desc.dwBackBufferCount = 1;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_COMPLEX | DDSCAPS_FLIP | DDSCAPS_PRIMARYSURFACE;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
    ok(hr == D3D_OK, "Failed to create surface, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_GetSurfaceDesc(surface, &surface_desc);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(surface_desc.dwWidth == width, "Got width %lu, expected %u.\n", surface_desc.dwWidth, width);
    ok(surface_desc.dwHeight == height, "Got height %lu, expected %u.\n", surface_desc.dwHeight, height);
    ok(surface_desc.ddpfPixelFormat.dwFlags == DDPF_RGB, "Got unexpected pixel format flags %#lx.\n",
            surface_desc.ddpfPixelFormat.dwFlags);
    ok(surface_desc.ddpfPixelFormat.dwRGBBitCount == bpp, "Got bpp %lu, expected %u.\n",
            surface_desc.ddpfPixelFormat.dwRGBBitCount, bpp);
    IDirectDrawSurface_Release(surface);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH;
    surface_desc.dwWidth = width;
    surface_desc.dwHeight = height;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
    ok(hr == D3D_OK, "Failed to create surface, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_GetSurfaceDesc(surface, &surface_desc);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(surface_desc.ddpfPixelFormat.dwFlags == DDPF_RGB, "Got unexpected pixel format flags %#lx.\n",
            surface_desc.ddpfPixelFormat.dwFlags);
    ok(surface_desc.ddpfPixelFormat.dwRGBBitCount == bpp, "Got bpp %lu, expected %u.\n",
            surface_desc.ddpfPixelFormat.dwRGBBitCount, bpp);
    IDirectDrawSurface_Release(surface);

    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "DirectDraw has %lu references left.\n", refcount);
    DestroyWindow(window);
}

static void test_surface_desc_size(void)
{
    union
    {
        DWORD dwSize;
        DDSURFACEDESC desc1;
        DDSURFACEDESC2 desc2;
        BYTE blob[1024];
    } desc;
    IDirectDrawSurface7 *surface7;
    IDirectDrawSurface2 *surface2;
    IDirectDrawSurface *surface;
    DDSURFACEDESC surface_desc;
    HRESULT expected_hr, hr;
    IDirectDraw2 *ddraw;
    unsigned int i, j;
    ULONG refcount;

    static const struct
    {
        unsigned int caps;
        const char *name;
    }
    surface_caps[] =
    {
        {DDSCAPS_OFFSCREENPLAIN, "offscreenplain"},
        {DDSCAPS_TEXTURE | DDSCAPS_SYSTEMMEMORY, "systemmemory texture"},
        {DDSCAPS_TEXTURE | DDSCAPS_VIDEOMEMORY, "videomemory texture"},
    };
    static const unsigned int desc_sizes[] =
    {
        sizeof(DDSURFACEDESC),
        sizeof(DDSURFACEDESC2),
        sizeof(DDSURFACEDESC) + 1,
        sizeof(DDSURFACEDESC2) + 1,
        2 * sizeof(DDSURFACEDESC),
        2 * sizeof(DDSURFACEDESC2),
        sizeof(DDSURFACEDESC) - 1,
        sizeof(DDSURFACEDESC2) - 1,
        sizeof(DDSURFACEDESC) / 2,
        sizeof(DDSURFACEDESC2) / 2,
        0,
        1,
        12,
        sizeof(desc) / 2,
        sizeof(desc) - 100,
    };

    if (!(ddraw = create_ddraw()))
    {
        skip("Failed to create ddraw.\n");
        return;
    }
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, NULL, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    for (i = 0; i < ARRAY_SIZE(surface_caps); ++i)
    {
        memset(&surface_desc, 0, sizeof(surface_desc));
        surface_desc.dwSize = sizeof(surface_desc);
        surface_desc.dwFlags = DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH;
        surface_desc.ddsCaps.dwCaps = surface_caps[i].caps;
        surface_desc.dwHeight = 128;
        surface_desc.dwWidth = 128;
        if (FAILED(IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL)))
        {
            skip("Failed to create surface, type %s.\n", surface_caps[i].name);
            continue;
        }
        hr = IDirectDrawSurface_QueryInterface(surface, &IID_IDirectDrawSurface2, (void **)&surface2);
        ok(hr == DD_OK, "Failed to query IDirectDrawSurface2, hr %#lx, type %s.\n", hr, surface_caps[i].name);
        hr = IDirectDrawSurface_QueryInterface(surface, &IID_IDirectDrawSurface7, (void **)&surface7);
        ok(hr == DD_OK, "Failed to query IDirectDrawSurface7, hr %#lx, type %s.\n", hr, surface_caps[i].name);

        /* GetSurfaceDesc() */
        for (j = 0; j < ARRAY_SIZE(desc_sizes); ++j)
        {
            memset(&desc, 0, sizeof(desc));
            desc.dwSize = desc_sizes[j];
            expected_hr = desc.dwSize == sizeof(DDSURFACEDESC) ? DD_OK : DDERR_INVALIDPARAMS;
            hr = IDirectDrawSurface_GetSurfaceDesc(surface, &desc.desc1);
            ok(hr == expected_hr, "Got hr %#lx, expected %#lx, size %u, type %s.\n",
                    hr, expected_hr, desc_sizes[j], surface_caps[i].name);

            memset(&desc, 0, sizeof(desc));
            desc.dwSize = desc_sizes[j];
            expected_hr = desc.dwSize == sizeof(DDSURFACEDESC) ? DD_OK : DDERR_INVALIDPARAMS;
            hr = IDirectDrawSurface2_GetSurfaceDesc(surface2, &desc.desc1);
            ok(hr == expected_hr, "Got hr %#lx, expected %#lx, size %u, type %s.\n",
                    hr, expected_hr, desc_sizes[j], surface_caps[i].name);

            memset(&desc, 0, sizeof(desc));
            desc.dwSize = desc_sizes[j];
            expected_hr = desc.dwSize == sizeof(DDSURFACEDESC2) ? DD_OK : DDERR_INVALIDPARAMS;
            hr = IDirectDrawSurface7_GetSurfaceDesc(surface7, &desc.desc2);
            ok(hr == expected_hr, "Got hr %#lx, expected %#lx, size %u, type %s.\n",
                    hr, expected_hr, desc_sizes[j], surface_caps[i].name);
        }

        /* Lock() */
        for (j = 0; j < ARRAY_SIZE(desc_sizes); ++j)
        {
            const BOOL valid_size = desc_sizes[j] == sizeof(DDSURFACEDESC)
                    || desc_sizes[j] == sizeof(DDSURFACEDESC2);
            DWORD expected_texture_stage;

            memset(&desc, 0, sizeof(desc));
            desc.dwSize = desc_sizes[j];
            desc.desc2.dwTextureStage = 0xdeadbeef;
            desc.blob[sizeof(DDSURFACEDESC2)] = 0xef;
            hr = IDirectDrawSurface_Lock(surface, NULL, &desc.desc1, 0, 0);
            expected_hr = valid_size ? DD_OK : DDERR_INVALIDPARAMS;
            ok(hr == expected_hr, "Got hr %#lx, expected %#lx, size %u, type %s.\n",
                    hr, expected_hr, desc_sizes[j], surface_caps[i].name);
            ok(desc.dwSize == desc_sizes[j], "dwSize was changed from %u to %lu, type %s.\n",
                    desc_sizes[j], desc.dwSize, surface_caps[i].name);
            ok(desc.blob[sizeof(DDSURFACEDESC2)] == 0xef, "Got unexpected byte %02x, size %u, type %s.\n",
                    desc.blob[sizeof(DDSURFACEDESC2)], desc_sizes[j], surface_caps[i].name);
            if (SUCCEEDED(hr))
            {
                ok(desc.desc1.dwWidth == 128, "Got unexpected width %lu, size %u, type %s.\n",
                        desc.desc1.dwWidth, desc_sizes[j], surface_caps[i].name);
                ok(desc.desc1.dwHeight == 128, "Got unexpected height %lu, size %u, type %s.\n",
                        desc.desc1.dwHeight, desc_sizes[j], surface_caps[i].name);
                expected_texture_stage = desc_sizes[j] >= sizeof(DDSURFACEDESC2) ? 0 : 0xdeadbeef;
                todo_wine_if(!expected_texture_stage)
                ok(desc.desc2.dwTextureStage == expected_texture_stage,
                        "Got unexpected texture stage %#lx, size %u, type %s.\n",
                        desc.desc2.dwTextureStage, desc_sizes[j], surface_caps[i].name);
                IDirectDrawSurface_Unlock(surface, NULL);
            }

            memset(&desc, 0, sizeof(desc));
            desc.dwSize = desc_sizes[j];
            desc.desc2.dwTextureStage = 0xdeadbeef;
            desc.blob[sizeof(DDSURFACEDESC2)] = 0xef;
            hr = IDirectDrawSurface2_Lock(surface2, NULL, &desc.desc1, 0, 0);
            expected_hr = valid_size ? DD_OK : DDERR_INVALIDPARAMS;
            ok(hr == expected_hr, "Got hr %#lx, expected %#lx, size %u, type %s.\n",
                    hr, expected_hr, desc_sizes[j], surface_caps[i].name);
            ok(desc.dwSize == desc_sizes[j], "dwSize was changed from %u to %lu, type %s.\n",
                    desc_sizes[j], desc.dwSize, surface_caps[i].name);
            ok(desc.blob[sizeof(DDSURFACEDESC2)] == 0xef, "Got unexpected byte %02x, size %u, type %s.\n",
                    desc.blob[sizeof(DDSURFACEDESC2)], desc_sizes[j], surface_caps[i].name);
            if (SUCCEEDED(hr))
            {
                ok(desc.desc2.dwWidth == 128, "Got unexpected width %lu, size %u, type %s.\n",
                        desc.desc2.dwWidth, desc_sizes[j], surface_caps[i].name);
                ok(desc.desc2.dwHeight == 128, "Got unexpected height %lu, size %u, type %s.\n",
                        desc.desc2.dwHeight, desc_sizes[j], surface_caps[i].name);
                expected_texture_stage = desc_sizes[j] >= sizeof(DDSURFACEDESC2) ? 0 : 0xdeadbeef;
                todo_wine_if(!expected_texture_stage)
                ok(desc.desc2.dwTextureStage == expected_texture_stage,
                        "Got unexpected texture stage %#lx, size %u, type %s.\n",
                        desc.desc2.dwTextureStage, desc_sizes[j], surface_caps[i].name);
                IDirectDrawSurface2_Unlock(surface2, NULL);
            }

            memset(&desc, 0, sizeof(desc));
            desc.dwSize = desc_sizes[j];
            desc.desc2.dwTextureStage = 0xdeadbeef;
            desc.blob[sizeof(DDSURFACEDESC2)] = 0xef;
            hr = IDirectDrawSurface7_Lock(surface7, NULL, &desc.desc2, 0, 0);
            expected_hr = valid_size ? DD_OK : DDERR_INVALIDPARAMS;
            ok(hr == expected_hr, "Got hr %#lx, expected %#lx, size %u, type %s.\n",
                    hr, expected_hr, desc_sizes[j], surface_caps[i].name);
            ok(desc.dwSize == desc_sizes[j], "dwSize was changed from %u to %lu, type %s.\n",
                    desc_sizes[j], desc.dwSize, surface_caps[i].name);
            ok(desc.blob[sizeof(DDSURFACEDESC2)] == 0xef, "Got unexpected byte %02x, size %u, type %s.\n",
                    desc.blob[sizeof(DDSURFACEDESC2)], desc_sizes[j], surface_caps[i].name);
            if (SUCCEEDED(hr))
            {
                ok(desc.desc2.dwWidth == 128, "Got unexpected width %lu, size %u, type %s.\n",
                        desc.desc2.dwWidth, desc_sizes[j], surface_caps[i].name);
                ok(desc.desc2.dwHeight == 128, "Got unexpected height %lu, size %u, type %s.\n",
                        desc.desc2.dwHeight, desc_sizes[j], surface_caps[i].name);
                expected_texture_stage = desc_sizes[j] >= sizeof(DDSURFACEDESC2) ? 0 : 0xdeadbeef;
                ok(desc.desc2.dwTextureStage == expected_texture_stage,
                        "Got unexpected texture stage %#lx, size %u, type %s.\n",
                        desc.desc2.dwTextureStage, desc_sizes[j], surface_caps[i].name);
                IDirectDrawSurface7_Unlock(surface7, NULL);
            }
        }

        IDirectDrawSurface7_Release(surface7);
        IDirectDrawSurface2_Release(surface2);
        IDirectDrawSurface_Release(surface);
    }

    /* GetDisplayMode() */
    for (j = 0; j < ARRAY_SIZE(desc_sizes); ++j)
    {
        memset(&desc, 0xcc, sizeof(desc));
        desc.dwSize = desc_sizes[j];
        expected_hr = (desc.dwSize == sizeof(DDSURFACEDESC) || desc.dwSize == sizeof(DDSURFACEDESC2))
                ? DD_OK : DDERR_INVALIDPARAMS;
        hr = IDirectDraw2_GetDisplayMode(ddraw, &desc.desc1);
        ok(hr == expected_hr, "Got hr %#lx, expected %#lx, size %u.\n", hr, expected_hr, desc_sizes[j]);
        if (SUCCEEDED(hr))
        {
            ok(desc.dwSize == sizeof(DDSURFACEDESC), "Wrong size %lu for %u.\n", desc.dwSize, desc_sizes[j]);
            ok(desc.blob[desc_sizes[j]] == 0xcc, "Overflow for size %u.\n", desc_sizes[j]);
            ok(desc.blob[desc_sizes[j] - 1] != 0xcc, "Struct not cleared for size %u.\n", desc_sizes[j]);
        }
    }

    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "DirectDraw has %lu references left.\n", refcount);
}

static void test_ck_operation(void)
{
    IDirectDrawSurface2 *src, *dst;
    IDirectDrawSurface7 *src7, *dst7;
    IDirectDrawSurface *surface1;
    DDSURFACEDESC surface_desc;
    unsigned int i, *color;
    IDirectDraw2 *ddraw;
    ULONG refcount;
    HWND window;
    HRESULT hr;
    DDCOLORKEY ckey;
    DDBLTFX fx;

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT;
    surface_desc.dwWidth = 4;
    surface_desc.dwHeight = 1;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN;
    surface_desc.ddpfPixelFormat.dwFlags = DDPF_RGB;
    surface_desc.ddpfPixelFormat.dwRGBBitCount = 32;
    surface_desc.ddpfPixelFormat.dwRBitMask = 0x00ff0000;
    surface_desc.ddpfPixelFormat.dwGBitMask = 0x0000ff00;
    surface_desc.ddpfPixelFormat.dwBBitMask = 0x000000ff;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface1, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_QueryInterface(surface1, &IID_IDirectDrawSurface2, (void **)&dst);
    ok(SUCCEEDED(hr), "Failed to query IDirectDrawSurface2, hr %#lx.\n", hr);
    IDirectDrawSurface_Release(surface1);

    surface_desc.dwFlags |= DDSD_CKSRCBLT;
    surface_desc.ddckCKSrcBlt.dwColorSpaceLowValue = 0x00ff00ff;
    surface_desc.ddckCKSrcBlt.dwColorSpaceHighValue = 0x00ff00ff;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface1, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_QueryInterface(surface1, &IID_IDirectDrawSurface2, (void **)&src);
    ok(SUCCEEDED(hr), "Failed to query IDirectDrawSurface2, hr %#lx.\n", hr);
    IDirectDrawSurface_Release(surface1);

    hr = IDirectDrawSurface2_Lock(src, NULL, &surface_desc, DDLOCK_WAIT, NULL);
    ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx.\n", hr);
    ok(!(surface_desc.dwFlags & DDSD_LPSURFACE), "Surface desc has LPSURFACE Flags set.\n");
    color = surface_desc.lpSurface;
    color[0] = 0x77010203;
    color[1] = 0x00010203;
    color[2] = 0x77ff00ff;
    color[3] = 0x00ff00ff;
    hr = IDirectDrawSurface2_Unlock(src, NULL);
    ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);

    for (i = 0; i < 2; ++i)
    {
        hr = IDirectDrawSurface2_Lock(dst, NULL, &surface_desc, DDLOCK_WAIT, NULL);
        ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx.\n", hr);
        color = surface_desc.lpSurface;
        color[0] = 0xcccccccc;
        color[1] = 0xcccccccc;
        color[2] = 0xcccccccc;
        color[3] = 0xcccccccc;
        hr = IDirectDrawSurface2_Unlock(dst, NULL);
        ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);

        if (i)
        {
            hr = IDirectDrawSurface2_BltFast(dst, 0, 0, src, NULL, DDBLTFAST_SRCCOLORKEY);
            ok(SUCCEEDED(hr), "Failed to blit, hr %#lx.\n", hr);
        }
        else
        {
            hr = IDirectDrawSurface2_Blt(dst, NULL, src, NULL, DDBLT_KEYSRC, NULL);
            ok(SUCCEEDED(hr), "Failed to blit, hr %#lx.\n", hr);
        }

        hr = IDirectDrawSurface2_Lock(dst, NULL, &surface_desc, DDLOCK_WAIT | DDLOCK_READONLY, NULL);
        ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx.\n", hr);
        ok(!(surface_desc.dwFlags & DDSD_LPSURFACE), "Surface desc has LPSURFACE Flags set.\n");
        color = surface_desc.lpSurface;
        /* Different behavior on some drivers / windows versions. Some versions ignore the X channel when
         * color keying, but copy it to the destination surface. Others (sysmem surfaces) apply it for
         * color keying, but do not copy it into the destination surface. Nvidia neither uses it for
         * color keying nor copies it. */
        ok((color[0] == 0x77010203 && color[1] == 0x00010203
                && color[2] == 0xcccccccc && color[3] == 0xcccccccc) /* AMD, Wine */
                || broken(color[0] == 0x00010203 && color[1] == 0x00010203
                && color[2] == 0x00ff00ff && color[3] == 0xcccccccc) /* Sysmem surfaces? */
                || broken(color[0] == 0x00010203 && color[1] == 0x00010203
                && color[2] == 0xcccccccc && color[3] == 0xcccccccc) /* Nvidia */
                || broken(color[0] == 0xff010203 && color[1] == 0xff010203
                && color[2] == 0xcccccccc && color[3] == 0xcccccccc) /* Testbot */,
                "Destination data after blitting is %08x %08x %08x %08x, i=%u.\n",
                color[0], color[1], color[2], color[3], i);
        hr = IDirectDrawSurface2_Unlock(dst, NULL);
        ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);
    }

    hr = IDirectDrawSurface2_GetColorKey(src, DDCKEY_SRCBLT, &ckey);
    ok(SUCCEEDED(hr), "Failed to get color key, hr %#lx.\n", hr);
    ok(ckey.dwColorSpaceLowValue == 0x00ff00ff && ckey.dwColorSpaceHighValue == 0x00ff00ff,
            "Got unexpected color key low=%08lx high=%08lx.\n", ckey.dwColorSpaceLowValue, ckey.dwColorSpaceHighValue);

    ckey.dwColorSpaceLowValue = ckey.dwColorSpaceHighValue = 0x0000ff00;
    hr = IDirectDrawSurface2_SetColorKey(src, DDCKEY_SRCBLT, &ckey);
    ok(SUCCEEDED(hr), "Failed to set color key, hr %#lx.\n", hr);

    ckey.dwColorSpaceLowValue = ckey.dwColorSpaceHighValue = 0;
    hr = IDirectDrawSurface2_GetColorKey(src, DDCKEY_SRCBLT, &ckey);
    ok(SUCCEEDED(hr), "Failed to get color key, hr %#lx.\n", hr);
    ok(ckey.dwColorSpaceLowValue == 0x0000ff00 && ckey.dwColorSpaceHighValue == 0x0000ff00,
            "Got unexpected color key low=%08lx high=%08lx.\n", ckey.dwColorSpaceLowValue, ckey.dwColorSpaceHighValue);

    surface_desc.ddckCKSrcBlt.dwColorSpaceLowValue = 0;
    surface_desc.ddckCKSrcBlt.dwColorSpaceHighValue = 0;
    hr = IDirectDrawSurface2_GetSurfaceDesc(src, &surface_desc);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(surface_desc.ddckCKSrcBlt.dwColorSpaceLowValue == 0x0000ff00
            && surface_desc.ddckCKSrcBlt.dwColorSpaceHighValue == 0x0000ff00,
            "Got unexpected color key low=%08lx high=%08lx.\n", surface_desc.ddckCKSrcBlt.dwColorSpaceLowValue,
            surface_desc.ddckCKSrcBlt.dwColorSpaceHighValue);

    /* Test SetColorKey with dwColorSpaceHighValue < dwColorSpaceLowValue */
    ckey.dwColorSpaceLowValue = 0x000000ff;
    ckey.dwColorSpaceHighValue = 0x00000000;
    hr = IDirectDrawSurface2_SetColorKey(src, DDCKEY_SRCBLT, &ckey);
    ok(SUCCEEDED(hr), "Failed to set color key, hr %#lx.\n", hr);

    ckey.dwColorSpaceLowValue = ckey.dwColorSpaceHighValue = 0;
    hr = IDirectDrawSurface2_GetColorKey(src, DDCKEY_SRCBLT, &ckey);
    ok(SUCCEEDED(hr), "Failed to get color key, hr %#lx.\n", hr);
    ok(ckey.dwColorSpaceLowValue == 0x000000ff && ckey.dwColorSpaceHighValue == 0x000000ff,
            "Got unexpected color key low=%08lx high=%08lx.\n", ckey.dwColorSpaceLowValue, ckey.dwColorSpaceHighValue);

    ckey.dwColorSpaceLowValue = 0x000000ff;
    ckey.dwColorSpaceHighValue = 0x00000001;
    hr = IDirectDrawSurface2_SetColorKey(src, DDCKEY_SRCBLT, &ckey);
    ok(SUCCEEDED(hr), "Failed to set color key, hr %#lx.\n", hr);

    ckey.dwColorSpaceLowValue = ckey.dwColorSpaceHighValue = 0;
    hr = IDirectDrawSurface2_GetColorKey(src, DDCKEY_SRCBLT, &ckey);
    ok(SUCCEEDED(hr), "Failed to get color key, hr %#lx.\n", hr);
    ok(ckey.dwColorSpaceLowValue == 0x000000ff && ckey.dwColorSpaceHighValue == 0x000000ff,
            "Got unexpected color key low=%08lx high=%08lx.\n", ckey.dwColorSpaceLowValue, ckey.dwColorSpaceHighValue);

    ckey.dwColorSpaceLowValue = 0x000000fe;
    ckey.dwColorSpaceHighValue = 0x000000fd;
    hr = IDirectDrawSurface2_SetColorKey(src, DDCKEY_SRCBLT, &ckey);
    ok(SUCCEEDED(hr), "Failed to set color key, hr %#lx.\n", hr);

    ckey.dwColorSpaceLowValue = ckey.dwColorSpaceHighValue = 0;
    hr = IDirectDrawSurface2_GetColorKey(src, DDCKEY_SRCBLT, &ckey);
    ok(SUCCEEDED(hr), "Failed to get color key, hr %#lx.\n", hr);
    ok(ckey.dwColorSpaceLowValue == 0x000000fe && ckey.dwColorSpaceHighValue == 0x000000fe,
            "Got unexpected color key low=%08lx high=%08lx.\n", ckey.dwColorSpaceLowValue, ckey.dwColorSpaceHighValue);

    IDirectDrawSurface2_Release(src);
    IDirectDrawSurface2_Release(dst);

    /* Test source and destination keys and where they are read from. Use a surface with alpha
     * to avoid driver-dependent content in the X channel. */
    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT;
    surface_desc.dwWidth = 6;
    surface_desc.dwHeight = 1;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN;
    surface_desc.ddpfPixelFormat.dwFlags = DDPF_RGB | DDPF_ALPHAPIXELS;
    surface_desc.ddpfPixelFormat.dwRGBBitCount = 32;
    surface_desc.ddpfPixelFormat.dwRBitMask = 0x00ff0000;
    surface_desc.ddpfPixelFormat.dwGBitMask = 0x0000ff00;
    surface_desc.ddpfPixelFormat.dwBBitMask = 0x000000ff;
    surface_desc.ddpfPixelFormat.dwRGBAlphaBitMask = 0xff000000;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface1, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_QueryInterface(surface1, &IID_IDirectDrawSurface2, (void **)&dst);
    ok(SUCCEEDED(hr), "Failed to query IDirectDrawSurface2, hr %#lx.\n", hr);
    IDirectDrawSurface_Release(surface1);

    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface1, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_QueryInterface(surface1, &IID_IDirectDrawSurface2, (void **)&src);
    ok(SUCCEEDED(hr), "Failed to query IDirectDrawSurface2, hr %#lx.\n", hr);
    IDirectDrawSurface_Release(surface1);

    ckey.dwColorSpaceLowValue = 0x0000ff00;
    ckey.dwColorSpaceHighValue = 0x0000ff00;
    hr = IDirectDrawSurface2_SetColorKey(dst, DDCKEY_SRCBLT, &ckey);
    ok(SUCCEEDED(hr), "Failed to set color key, hr %#lx.\n", hr);
    ckey.dwColorSpaceLowValue = 0x00ff0000;
    ckey.dwColorSpaceHighValue = 0x00ff0000;
    hr = IDirectDrawSurface2_SetColorKey(dst, DDCKEY_DESTBLT, &ckey);
    ok(SUCCEEDED(hr) || hr == DDERR_NOCOLORKEYHW, "Failed to set color key, hr %#lx.\n", hr);
    if (FAILED(hr))
    {
        /* Nvidia reject dest keys, AMD allows them. This applies to vidmem and sysmem surfaces. */
        skip("Failed to set destination color key, skipping related tests.\n");
        goto done;
    }

    ckey.dwColorSpaceLowValue = 0x000000ff;
    ckey.dwColorSpaceHighValue = 0x000000ff;
    hr = IDirectDrawSurface2_SetColorKey(src, DDCKEY_SRCBLT, &ckey);
    ok(SUCCEEDED(hr), "Failed to set color key, hr %#lx.\n", hr);
    ckey.dwColorSpaceLowValue = 0x000000aa;
    ckey.dwColorSpaceHighValue = 0x000000aa;
    hr = IDirectDrawSurface2_SetColorKey(src, DDCKEY_DESTBLT, &ckey);
    ok(SUCCEEDED(hr), "Failed to set color key, hr %#lx.\n", hr);

    memset(&fx, 0, sizeof(fx));
    fx.dwSize = sizeof(fx);
    fx.ddckSrcColorkey.dwColorSpaceHighValue = 0x00110000;
    fx.ddckSrcColorkey.dwColorSpaceLowValue = 0x00110000;
    fx.ddckDestColorkey.dwColorSpaceHighValue = 0x00001100;
    fx.ddckDestColorkey.dwColorSpaceLowValue = 0x00001100;

    hr = IDirectDrawSurface2_Lock(src, NULL, &surface_desc, DDLOCK_WAIT, NULL);
    ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx.\n", hr);
    color = surface_desc.lpSurface;
    color[0] = 0x000000ff; /* Applies to src blt key in src surface. */
    color[1] = 0x000000aa; /* Applies to dst blt key in src surface. */
    color[2] = 0x00ff0000; /* Dst color key in dst surface. */
    color[3] = 0x0000ff00; /* Src color key in dst surface. */
    color[4] = 0x00001100; /* Src color key in ddbltfx. */
    color[5] = 0x00110000; /* Dst color key in ddbltfx. */
    hr = IDirectDrawSurface2_Unlock(src, NULL);
    ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);

    hr = IDirectDrawSurface2_Lock(dst, NULL, &surface_desc, DDLOCK_WAIT, NULL);
    ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx.\n", hr);
    color = surface_desc.lpSurface;
    color[0] = color[1] = color[2] = color[3] = color[4] = color[5] = 0x55555555;
    hr = IDirectDrawSurface2_Unlock(dst, NULL);
    ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);

    /* Test a blit without keying. */
    hr = IDirectDrawSurface2_Blt(dst, NULL, src, NULL, 0, &fx);
    ok(SUCCEEDED(hr), "Failed to blit, hr %#lx.\n", hr);

    hr = IDirectDrawSurface2_Lock(dst, NULL, &surface_desc, DDLOCK_WAIT, NULL);
    ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx.\n", hr);
    color = surface_desc.lpSurface;
    /* Should have copied src data unmodified to dst. */
    ok(color[0] == 0x000000ff && color[1] == 0x000000aa && color[2] == 0x00ff0000 &&
            color[3] == 0x0000ff00 && color[4] == 0x00001100 && color[5] == 0x00110000,
            "Got unexpected content %08x %08x %08x %08x %08x %08x.\n",
            color[0], color[1], color[2], color[3], color[4], color[5]);

    color[0] = color[1] = color[2] = color[3] = color[4] = color[5] = 0x55555555;
    hr = IDirectDrawSurface2_Unlock(dst, NULL);
    ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);

    /* Src key. */
    hr = IDirectDrawSurface2_Blt(dst, NULL, src, NULL, DDBLT_KEYSRC, &fx);
    ok(SUCCEEDED(hr), "Failed to blit, hr %#lx.\n", hr);

    hr = IDirectDrawSurface2_Lock(dst, NULL, &surface_desc, DDLOCK_WAIT, NULL);
    ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx.\n", hr);
    color = surface_desc.lpSurface;
    /* Src key applied to color[0]. It is unmodified, the others are copied. */
    ok(color[0] == 0x55555555 && color[1] == 0x000000aa && color[2] == 0x00ff0000 &&
            color[3] == 0x0000ff00 && color[4] == 0x00001100 && color[5] == 0x00110000,
            "Got unexpected content %08x %08x %08x %08x %08x %08x.\n",
            color[0], color[1], color[2], color[3], color[4], color[5]);

    color[0] = color[1] = color[2] = color[3] = color[4] = color[5] = 0x55555555;
    hr = IDirectDrawSurface2_Unlock(dst, NULL);
    ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);

    /* Src override. */
    hr = IDirectDrawSurface2_Blt(dst, NULL, src, NULL, DDBLT_KEYSRCOVERRIDE, &fx);
    ok(SUCCEEDED(hr), "Failed to blit, hr %#lx.\n", hr);

    hr = IDirectDrawSurface2_Lock(dst, NULL, &surface_desc, DDLOCK_WAIT, NULL);
    ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx.\n", hr);
    color = surface_desc.lpSurface;
    /* Override key applied to color[5]. It is unmodified, the others are copied. */
    ok(color[0] == 0x000000ff && color[1] == 0x000000aa && color[2] == 0x00ff0000 &&
            color[3] == 0x0000ff00 && color[4] == 0x00001100 && color[5] == 0x55555555,
            "Got unexpected content %08x %08x %08x %08x %08x %08x.\n",
            color[0], color[1], color[2], color[3], color[4], color[5]);

    color[0] = color[1] = color[2] = color[3] = color[4] = color[5] = 0x55555555;
    hr = IDirectDrawSurface2_Unlock(dst, NULL);
    ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);

    /* Src override AND src key. That is not supposed to work. */
    hr = IDirectDrawSurface2_Blt(dst, NULL, src, NULL, DDBLT_KEYSRC | DDBLT_KEYSRCOVERRIDE, &fx);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);

    hr = IDirectDrawSurface2_Lock(dst, NULL, &surface_desc, DDLOCK_WAIT, NULL);
    ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx.\n", hr);
    color = surface_desc.lpSurface;
    /* Ensure the destination was not changed. */
    ok(color[0] == 0x55555555 && color[1] == 0x55555555 && color[2] == 0x55555555 &&
            color[3] == 0x55555555 && color[4] == 0x55555555 && color[5] == 0x55555555,
            "Got unexpected content %08x %08x %08x %08x %08x %08x.\n",
            color[0], color[1], color[2], color[3], color[4], color[5]);

    /* Use different dst colors for the dst key test. */
    color[0] = 0x00ff0000; /* Dest key in dst surface. */
    color[1] = 0x00ff0000; /* Dest key in dst surface. */
    color[2] = 0x00001100; /* Dest key in override. */
    color[3] = 0x00001100; /* Dest key in override. */
    color[4] = 0x000000aa; /* Dest key in src surface. */
    color[5] = 0x000000aa; /* Dest key in src surface. */
    hr = IDirectDrawSurface2_Unlock(dst, NULL);
    ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);

    /* Dest key blit. The key is taken from the SOURCE surface in v2! */
    hr = IDirectDrawSurface2_Blt(dst, NULL, src, NULL, DDBLT_KEYDEST, &fx);
    ok(SUCCEEDED(hr), "Failed to blit, hr %#lx.\n", hr);

    hr = IDirectDrawSurface2_Lock(dst, NULL, &surface_desc, DDLOCK_WAIT, NULL);
    ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx.\n", hr);
    color = surface_desc.lpSurface;
    /* Dst key applied to color[4,5], they are the only changed pixels. */
    ok(color[0] == 0x00ff0000 && color[1] == 0x00ff0000 && color[2] == 0x00001100 &&
            color[3] == 0x00001100 && color[4] == 0x00001100 && color[5] == 0x00110000,
            "Got unexpected content %08x %08x %08x %08x %08x %08x.\n",
            color[0], color[1], color[2], color[3], color[4], color[5]);

    color[0] = 0x00ff0000; /* Dest key in dst surface. */
    color[1] = 0x00ff0000; /* Dest key in dst surface. */
    color[2] = 0x00001100; /* Dest key in override. */
    color[3] = 0x00001100; /* Dest key in override. */
    color[4] = 0x000000aa; /* Dest key in src surface. */
    color[5] = 0x000000aa; /* Dest key in src surface. */
    hr = IDirectDrawSurface2_Unlock(dst, NULL);
    ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);

    /* What happens with a QI'd newer version of the interface? It takes the key
     * from the destination surface. */
    hr = IDirectDrawSurface2_QueryInterface(src, &IID_IDirectDrawSurface7, (void **)&src7);
    ok(SUCCEEDED(hr), "Failed to query IDirectDrawSurface interface, hr %#lx.\n", hr);
    hr = IDirectDrawSurface2_QueryInterface(dst, &IID_IDirectDrawSurface7, (void **)&dst7);
    ok(SUCCEEDED(hr), "Failed to query IDirectDrawSurface interface, hr %#lx.\n", hr);

    hr = IDirectDrawSurface7_Blt(dst7, NULL, src7, NULL, DDBLT_KEYDEST, &fx);
    ok(SUCCEEDED(hr), "Failed to blit, hr %#lx.\n", hr);

    IDirectDrawSurface7_Release(dst7);
    IDirectDrawSurface7_Release(src7);

    hr = IDirectDrawSurface2_Lock(dst, NULL, &surface_desc, DDLOCK_WAIT, NULL);
    ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx.\n", hr);
    color = surface_desc.lpSurface;
    /* Dst key applied to color[0,1], they are the only changed pixels. */
    todo_wine ok(color[0] == 0x000000ff && color[1] == 0x000000aa && color[2] == 0x00001100 &&
            color[3] == 0x00001100 && color[4] == 0x000000aa && color[5] == 0x000000aa,
            "Got unexpected content %08x %08x %08x %08x %08x %08x.\n",
            color[0], color[1], color[2], color[3], color[4], color[5]);

    color[0] = 0x00ff0000; /* Dest key in dst surface. */
    color[1] = 0x00ff0000; /* Dest key in dst surface. */
    color[2] = 0x00001100; /* Dest key in override. */
    color[3] = 0x00001100; /* Dest key in override. */
    color[4] = 0x000000aa; /* Dest key in src surface. */
    color[5] = 0x000000aa; /* Dest key in src surface. */
    hr = IDirectDrawSurface2_Unlock(dst, NULL);
    ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);

    /* Dest override key blit. */
    hr = IDirectDrawSurface2_Blt(dst, NULL, src, NULL, DDBLT_KEYDESTOVERRIDE, &fx);
    ok(SUCCEEDED(hr), "Failed to blit, hr %#lx.\n", hr);

    hr = IDirectDrawSurface2_Lock(dst, NULL, &surface_desc, DDLOCK_WAIT, NULL);
    ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx.\n", hr);
    color = surface_desc.lpSurface;
    /* Dst key applied to color[2,3], they are the only changed pixels. */
    ok(color[0] == 0x00ff0000 && color[1] == 0x00ff0000 && color[2] == 0x00ff0000 &&
            color[3] == 0x0000ff00 && color[4] == 0x000000aa && color[5] == 0x000000aa,
            "Got unexpected content %08x %08x %08x %08x %08x %08x.\n",
            color[0], color[1], color[2], color[3], color[4], color[5]);

    color[0] = 0x00ff0000; /* Dest key in dst surface. */
    color[1] = 0x00ff0000; /* Dest key in dst surface. */
    color[2] = 0x00001100; /* Dest key in override. */
    color[3] = 0x00001100; /* Dest key in override. */
    color[4] = 0x000000aa; /* Dest key in src surface. */
    color[5] = 0x000000aa; /* Dest key in src surface. */
    hr = IDirectDrawSurface2_Unlock(dst, NULL);
    ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);

    /* Dest override together with surface key. Supposed to fail. */
    hr = IDirectDrawSurface2_Blt(dst, NULL, src, NULL, DDBLT_KEYDEST | DDBLT_KEYDESTOVERRIDE, &fx);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);

    hr = IDirectDrawSurface2_Lock(dst, NULL, &surface_desc, DDLOCK_WAIT, NULL);
    ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx.\n", hr);
    color = surface_desc.lpSurface;
    /* Destination is unchanged. */
    ok(color[0] == 0x00ff0000 && color[1] == 0x00ff0000 && color[2] == 0x00001100 &&
            color[3] == 0x00001100 && color[4] == 0x000000aa && color[5] == 0x000000aa,
            "Got unexpected content %08x %08x %08x %08x %08x %08x.\n",
            color[0], color[1], color[2], color[3], color[4], color[5]);
    hr = IDirectDrawSurface2_Unlock(dst, NULL);
    ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);

    /* Source and destination key. This is driver dependent. New HW treats it like
     * DDBLT_KEYSRC. Older HW and some software renderers apply both keys. */
    if (0)
    {
        hr = IDirectDrawSurface2_Blt(dst, NULL, src, NULL, DDBLT_KEYDEST | DDBLT_KEYSRC, &fx);
        ok(SUCCEEDED(hr), "Failed to blit, hr %#lx.\n", hr);

        hr = IDirectDrawSurface2_Lock(dst, NULL, &surface_desc, DDLOCK_WAIT, NULL);
        ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx.\n", hr);
        color = surface_desc.lpSurface;
        /* Color[0] is filtered by the src key, 2-5 are filtered by the dst key, if
         * the driver applies it. */
        ok(color[0] == 0x00ff0000 && color[1] == 0x000000aa && color[2] == 0x00ff0000 &&
                color[3] == 0x0000ff00 && color[4] == 0x00001100 && color[5] == 0x00110000,
                "Got unexpected content %08x %08x %08x %08x %08x %08x.\n",
                color[0], color[1], color[2], color[3], color[4], color[5]);

        color[0] = 0x00ff0000; /* Dest key in dst surface. */
        color[1] = 0x00ff0000; /* Dest key in dst surface. */
        color[2] = 0x00001100; /* Dest key in override. */
        color[3] = 0x00001100; /* Dest key in override. */
        color[4] = 0x000000aa; /* Dest key in src surface. */
        color[5] = 0x000000aa; /* Dest key in src surface. */
        hr = IDirectDrawSurface2_Unlock(dst, NULL);
        ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);
    }

    /* Override keys without ddbltfx parameter fail */
    hr = IDirectDrawSurface2_Blt(dst, NULL, src, NULL, DDBLT_KEYDESTOVERRIDE, NULL);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface2_Blt(dst, NULL, src, NULL, DDBLT_KEYSRCOVERRIDE, NULL);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);

    /* Try blitting without keys in the source surface. */
    hr = IDirectDrawSurface2_SetColorKey(src, DDCKEY_SRCBLT, NULL);
    ok(SUCCEEDED(hr), "Failed to set color key, hr %#lx.\n", hr);
    hr = IDirectDrawSurface2_SetColorKey(src, DDCKEY_DESTBLT, NULL);
    ok(SUCCEEDED(hr), "Failed to set color key, hr %#lx.\n", hr);

    /* That fails now. Do not bother to check that the data is unmodified. */
    hr = IDirectDrawSurface2_Blt(dst, NULL, src, NULL, DDBLT_KEYSRC, &fx);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);

    /* Surprisingly this still works. It uses the old key from the src surface. */
    hr = IDirectDrawSurface2_Blt(dst, NULL, src, NULL, DDBLT_KEYDEST, &fx);
    ok(SUCCEEDED(hr), "Failed to blit, hr %#lx.\n", hr);

    hr = IDirectDrawSurface2_Lock(dst, NULL, &surface_desc, DDLOCK_WAIT, NULL);
    ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx.\n", hr);
    color = surface_desc.lpSurface;
    /* Dst key applied to color[4,5], they are the only changed pixels. */
    ok(color[0] == 0x00ff0000 && color[1] == 0x00ff0000 && color[2] == 0x00001100 &&
            color[3] == 0x00001100 && color[4] == 0x00001100 && color[5] == 0x00110000,
            "Got unexpected content %08x %08x %08x %08x %08x %08x.\n",
            color[0], color[1], color[2], color[3], color[4], color[5]);
    hr = IDirectDrawSurface2_Unlock(dst, NULL);
    ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);

    /* This returns DDERR_NOCOLORKEY as expected. */
    hr = IDirectDrawSurface2_GetColorKey(src, DDCKEY_DESTBLT, &ckey);
    ok(hr == DDERR_NOCOLORKEY, "Got unexpected hr %#lx.\n", hr);

    /* GetSurfaceDesc returns a zeroed key as expected. */
    surface_desc.ddckCKSrcBlt.dwColorSpaceLowValue = 0x12345678;
    surface_desc.ddckCKSrcBlt.dwColorSpaceHighValue = 0x12345678;
    hr = IDirectDrawSurface2_GetSurfaceDesc(src, &surface_desc);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    ok(!surface_desc.ddckCKSrcBlt.dwColorSpaceLowValue
            && !surface_desc.ddckCKSrcBlt.dwColorSpaceHighValue,
            "Got unexpected color key low=%08lx high=%08lx.\n", surface_desc.ddckCKSrcBlt.dwColorSpaceLowValue,
            surface_desc.ddckCKSrcBlt.dwColorSpaceHighValue);

    /* Try blitting without keys in the destination surface. */
    hr = IDirectDrawSurface2_SetColorKey(dst, DDCKEY_SRCBLT, NULL);
    ok(SUCCEEDED(hr), "Failed to set color key, hr %#lx.\n", hr);
    hr = IDirectDrawSurface2_SetColorKey(dst, DDCKEY_DESTBLT, NULL);
    ok(SUCCEEDED(hr), "Failed to set color key, hr %#lx.\n", hr);

    /* This fails, as sanity would dictate. */
    hr = IDirectDrawSurface2_Blt(dst, NULL, src, NULL, DDBLT_KEYDEST, &fx);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);

done:
    IDirectDrawSurface2_Release(src);
    IDirectDrawSurface2_Release(dst);
    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "DirectDraw has %lu references left.\n", refcount);
    DestroyWindow(window);
}

static void test_set_render_state(void)
{
    IDirect3DDevice2 *device;
    IDirectDraw2 *ddraw;
    ULONG refcount;
    HWND window;
    DWORD state;
    HRESULT hr;

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    if (!(device = create_device(ddraw, window, DDSCL_NORMAL)))
    {
        skip("Failed to create 3D device.\n");
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_ZVISIBLE, TRUE);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_ZVISIBLE, FALSE);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_TEXTUREHANDLE, 0);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    state = 0xdeadbeef;
    hr = IDirect3DDevice2_GetRenderState(device, D3DRENDERSTATE_TEXTUREHANDLE, &state);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    ok(!state, "Got unexpected render state %#lx.\n", state);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_TEXTUREMAPBLEND, D3DTBLEND_MODULATE);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_GetRenderState(device, D3DRENDERSTATE_TEXTUREMAPBLEND, &state);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    ok(state == D3DTBLEND_MODULATE, "Got unexpected render state %#lx.\n", state);

    refcount = IDirect3DDevice2_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "DirectDraw has %lu references left.\n", refcount);
    DestroyWindow(window);
}

static void test_depth_readback(void)
{
    unsigned int depth, expected_depth, i, x, y, max_diff, passed_fmts = 0;
    IDirect3DMaterial2 *blue_background;
    IDirectDrawSurface *rt, *ds;
    IDirect3DViewport2 *viewport;
    DDSURFACEDESC surface_desc;
    IDirect3DDevice2 *device;
    IDirectDraw2 *ddraw;
    ULONG refcount;
    HWND window;
    HRESULT hr;
    void *ptr;
    BOOL all_pass;

    static D3DRECT clear_rect = {{0}, {0}, {640}, {480}};
    static D3DLVERTEX quad[] =
    {
        {{-1.0f}, {-1.0f}, {0.1f}, 0, {0xff00ff00}},
        {{-1.0f}, { 1.0f}, {0.0f}, 0, {0xff00ff00}},
        {{ 1.0f}, {-1.0f}, {1.0f}, 0, {0xff00ff00}},
        {{ 1.0f}, { 1.0f}, {0.9f}, 0, {0xff00ff00}},
    };

    static const struct
    {
        unsigned int z_depth, z_mask;
    }
    tests[] =
    {
        {16, 0x0000ffff},
        {24, 0x00ffffff},
        {32, 0xffffffff},
    };

    window = create_window();
    ok(!!window, "Failed to create a window.\n");
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    if (!(device = create_device(ddraw, window, DDSCL_NORMAL)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirectDraw2_Release(ddraw);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice2_GetRenderTarget(device, &rt);
    ok(SUCCEEDED(hr), "Failed to get render target, hr %#lx.\n", hr);
    blue_background = create_diffuse_material(device, 0.0f, 0.0f, 1.0f, 1.0f);
    viewport = create_viewport(device, 0, 0, 640, 480);
    viewport_set_background(device, viewport, blue_background);
    hr = IDirect3DDevice2_SetCurrentViewport(device, viewport);
    ok(SUCCEEDED(hr), "Failed to set current viewport, hr %#lx.\n", hr);

    ds = get_depth_stencil(device);
    hr = IDirectDrawSurface_DeleteAttachedSurface(rt, 0, ds);
    ok(SUCCEEDED(hr), "Failed to detach depth buffer, hr %#lx.\n", hr);
    IDirectDrawSurface_Release(ds);

    for (i = 0; i < ARRAY_SIZE(tests); ++i)
    {
        memset(&surface_desc, 0, sizeof(surface_desc));
        surface_desc.dwSize = sizeof(surface_desc);
        surface_desc.dwFlags = DDSD_CAPS | DDSD_ZBUFFERBITDEPTH | DDSD_WIDTH | DDSD_HEIGHT;
        surface_desc.ddsCaps.dwCaps = DDSCAPS_ZBUFFER | DDSCAPS_VIDEOMEMORY;
        surface_desc.dwZBufferBitDepth = tests[i].z_depth;
        surface_desc.dwWidth = 640;
        surface_desc.dwHeight = 480;
        hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &ds, NULL);
        if (FAILED(hr))
        {
            skip("Format %u not supported, skipping test.\n", i);
            continue;
        }

        hr = IDirectDrawSurface_AddAttachedSurface(rt, ds);
        ok(SUCCEEDED(hr), "Failed to attach depth buffer, hr %#lx.\n", hr);
        hr = IDirect3DDevice2_SetRenderTarget(device, rt, 0);
        ok(SUCCEEDED(hr), "Failed to set render target, hr %#lx.\n", hr);

        hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER);
        ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);
        hr = IDirect3DDevice2_BeginScene(device);
        ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
        hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, D3DVT_LVERTEX, quad, 4, 0);
        ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
        hr = IDirect3DDevice2_EndScene(device);
        ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

        memset(&surface_desc, 0, sizeof(surface_desc));
        surface_desc.dwSize = sizeof(surface_desc);
        hr = IDirectDrawSurface_Lock(ds, NULL, &surface_desc, DDLOCK_READONLY | DDLOCK_WAIT, NULL);
        ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx.\n", hr);

        all_pass = TRUE;
        for (y = 60; y < 480; y += 120)
        {
            for (x = 80; x < 640; x += 160)
            {
                ptr = (BYTE *)surface_desc.lpSurface
                        + y * surface_desc.lPitch
                        + x * (tests[i].z_depth == 16 ? 2 : 4);
                depth = *((DWORD *)ptr) & tests[i].z_mask;
                expected_depth = (x * (0.9 / 640.0) + y * (0.1 / 480.0)) * tests[i].z_mask;
                max_diff = ((0.5f * 0.9f) / 640.0f) * tests[i].z_mask;
                /* The ddraw2 version of this test behaves similarly to the ddraw7 version on Nvidia GPUs,
                 * except that we only have D16 (broken on geforce 9) and D24X8 (broken on geforce 7) available.
                 * Accept all nvidia GPUs as broken here, but still expect one of the formats to pass. */
                ok(compare_uint(expected_depth, depth, max_diff) || ddraw_is_nvidia(ddraw)
                        || (ddraw_is_amd(ddraw) && tests[i].z_depth == 24),
                        "Test %u: Got depth 0x%08x (diff %d), expected 0x%08x+/-%u, at %u, %u.\n",
                        i, depth, expected_depth - depth, expected_depth, max_diff, x, y);
                if (!compare_uint(expected_depth, depth, max_diff))
                    all_pass = FALSE;
            }
        }

        hr = IDirectDrawSurface_Unlock(ds, NULL);
        ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);

        if (all_pass)
            passed_fmts++;

        hr = IDirectDrawSurface_DeleteAttachedSurface(rt, 0, ds);
        ok(SUCCEEDED(hr), "Failed to detach depth buffer, hr %#lx.\n", hr);
        IDirectDrawSurface_Release(ds);
    }

    ok(passed_fmts, "Not a single format passed the tests, this is bad even by Nvidia's standards.\n");

    destroy_viewport(device, viewport);
    destroy_material(blue_background);
    IDirectDrawSurface_Release(rt);
    refcount = IDirect3DDevice2_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirectDraw2_Release(ddraw);
    DestroyWindow(window);
}

static void test_clear(void)
{
    D3DRECT rect_negneg, rect_full = {{0}, {0}, {640}, {480}};
    IDirect3DViewport2 *viewport, *viewport2, *viewport3;
    IDirect3DMaterial2 *white, *red, *green, *blue;
    IDirect3DDevice2 *device;
    IDirectDrawSurface *rt;
    IDirectDraw2 *ddraw;
    unsigned int color;
    D3DRECT rect[2];
    ULONG refcount;
    HWND window;
    HRESULT hr;

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    if (!(device = create_device(ddraw, window, DDSCL_NORMAL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        IDirectDraw2_Release(ddraw);
        DestroyWindow(window);
        return;
    }
    hr = IDirect3DDevice2_GetRenderTarget(device, &rt);
    ok(SUCCEEDED(hr), "Failed to get render target, hr %#lx.\n", hr);

    viewport = create_viewport(device, 0, 0, 640, 480);
    hr = IDirect3DDevice2_SetCurrentViewport(device, viewport);
    ok(SUCCEEDED(hr), "Failed to set current viewport, hr %#lx.\n", hr);

    white = create_diffuse_material(device, 1.0f, 1.0f, 1.0f, 1.0f);
    red = create_diffuse_material(device, 1.0f, 0.0f, 0.0f, 1.0f);
    green = create_diffuse_material(device, 0.0f, 1.0f, 0.0f, 1.0f);
    blue = create_diffuse_material(device, 0.0f, 0.0f, 1.0f, 1.0f);

    viewport_set_background(device, viewport, white);
    hr = IDirect3DViewport2_Clear(viewport, 1, &rect_full, D3DCLEAR_TARGET);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);

    /* Positive x, negative y. */
    rect[0].x1 = 0;
    rect[0].y1 = 480;
    rect[0].x2 = 320;
    rect[0].y2 = 240;

    /* Positive x, positive y. */
    rect[1].x1 = 0;
    rect[1].y1 = 0;
    rect[1].x2 = 320;
    rect[1].y2 = 240;

    /* Clear 2 rectangles with one call. Unlike d3d8/9, the refrast does not
     * refuse negative rectangles, but it will not clear them either. */
    viewport_set_background(device, viewport, red);
    hr = IDirect3DViewport2_Clear(viewport, 2, rect, D3DCLEAR_TARGET);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);

    color = get_surface_color(rt, 160, 360);
    ok(compare_color(color, 0x00ffffff, 0), "Clear rectangle 3 (pos, neg) has color 0x%08x.\n", color);
    color = get_surface_color(rt, 160, 120);
    ok(compare_color(color, 0x00ff0000, 0), "Clear rectangle 1 (pos, pos) has color 0x%08x.\n", color);
    color = get_surface_color(rt, 480, 360);
    ok(compare_color(color, 0x00ffffff, 0), "Clear rectangle 4 (NULL) has color 0x%08x.\n", color);
    color = get_surface_color(rt, 480, 120);
    ok(compare_color(color, 0x00ffffff, 0), "Clear rectangle 4 (neg, neg) has color 0x%08x.\n", color);

    viewport_set_background(device, viewport, white);
    hr = IDirect3DViewport2_Clear(viewport, 1, &rect_full, D3DCLEAR_TARGET);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);

    /* negative x, negative y.
     * Also ignored, except on WARP, which clears the entire screen. */
    rect_negneg.x1 = 640;
    rect_negneg.y1 = 240;
    rect_negneg.x2 = 320;
    rect_negneg.y2 = 0;
    viewport_set_background(device, viewport, green);
    hr = IDirect3DViewport2_Clear(viewport, 1, &rect_negneg, D3DCLEAR_TARGET);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);

    color = get_surface_color(rt, 160, 360);
    ok(compare_color(color, 0x00ffffff, 0)
            || broken(ddraw_is_warp(ddraw) && compare_color(color, 0x0000ff00, 0)),
            "Got unexpected color 0x%08x.\n", color);
    color = get_surface_color(rt, 160, 120);
    ok(compare_color(color, 0x00ffffff, 0)
            || broken(ddraw_is_warp(ddraw) && compare_color(color, 0x0000ff00, 0)),
            "Got unexpected color 0x%08x.\n", color);
    color = get_surface_color(rt, 480, 360);
    ok(compare_color(color, 0x00ffffff, 0)
            || broken(ddraw_is_warp(ddraw) && compare_color(color, 0x0000ff00, 0)),
            "Got unexpected color 0x%08x.\n", color);
    color = get_surface_color(rt, 480, 120);
    ok(compare_color(color, 0x00ffffff, 0)
            || broken(ddraw_is_warp(ddraw) && compare_color(color, 0x0000ff00, 0)),
            "Got unexpected color 0x%08x.\n", color);

    /* Test how the viewport affects clears. */
    viewport_set_background(device, viewport, white);
    hr = IDirect3DViewport2_Clear(viewport, 1, &rect_full, D3DCLEAR_TARGET);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);

    viewport2 = create_viewport(device, 160, 120, 160, 120);
    hr = IDirect3DDevice2_SetCurrentViewport(device, viewport2);
    ok(SUCCEEDED(hr), "Failed to set current viewport, hr %#lx.\n", hr);

    viewport_set_background(device, viewport2, blue);
    hr = IDirect3DViewport2_Clear(viewport2, 1, &rect_full, D3DCLEAR_TARGET);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);

    viewport3 = create_viewport(device, 320, 240, 320, 240);
    hr = IDirect3DDevice2_SetCurrentViewport(device, viewport3);
    ok(SUCCEEDED(hr), "Failed to set current viewport, hr %#lx.\n", hr);

    rect[0].x1 = 160;
    rect[0].y1 = 120;
    rect[0].x2 = 480;
    rect[0].y2 = 360;
    viewport_set_background(device, viewport3, green);
    hr = IDirect3DViewport2_Clear(viewport3, 1, &rect[0], D3DCLEAR_TARGET);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);

    hr = IDirect3DDevice2_SetCurrentViewport(device, viewport);
    ok(SUCCEEDED(hr), "Failed to set current viewport, hr %#lx.\n", hr);

    color = get_surface_color(rt, 158, 118);
    ok(compare_color(color, 0x00ffffff, 0), "(158, 118) has color 0x%08x.\n", color);
    color = get_surface_color(rt, 162, 118);
    ok(compare_color(color, 0x00ffffff, 0), "(162, 118) has color 0x%08x.\n", color);
    color = get_surface_color(rt, 158, 122);
    ok(compare_color(color, 0x00ffffff, 0), "(158, 122) has color 0x%08x.\n", color);
    color = get_surface_color(rt, 162, 122);
    ok(compare_color(color, 0x000000ff, 0), "(162, 122) has color 0x%08x.\n", color);

    color = get_surface_color(rt, 318, 238);
    ok(compare_color(color, 0x000000ff, 0), "(318, 238) has color 0x%08x.\n", color);
    color = get_surface_color(rt, 322, 238);
    ok(compare_color(color, 0x00ffffff, 0), "(322, 238) has color 0x%08x.\n", color);
    color = get_surface_color(rt, 318, 242);
    ok(compare_color(color, 0x00ffffff, 0), "(318, 242) has color 0x%08x.\n", color);
    color = get_surface_color(rt, 322, 242);
    ok(compare_color(color, 0x0000ff00, 0), "(322, 242) has color 0x%08x.\n", color);

    color = get_surface_color(rt, 478, 358);
    ok(compare_color(color, 0x0000ff00, 0), "(478, 358) has color 0x%08x.\n", color);
    color = get_surface_color(rt, 482, 358);
    ok(compare_color(color, 0x00ffffff, 0), "(482, 358) has color 0x%08x.\n", color);
    color = get_surface_color(rt, 478, 362);
    ok(compare_color(color, 0x00ffffff, 0), "(478, 362) has color 0x%08x.\n", color);
    color = get_surface_color(rt, 482, 362);
    ok(compare_color(color, 0x00ffffff, 0), "(482, 362) has color 0x%08x.\n", color);

    /* The clear rectangle is rendertarget absolute, not relative to the
     * viewport. */
    hr = IDirect3DViewport2_Clear(viewport, 1, &rect_full, D3DCLEAR_TARGET);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);
    rect[0].x1 = 330;
    rect[0].y1 = 250;
    rect[0].x2 = 340;
    rect[0].y2 = 260;
    hr = IDirect3DViewport2_Clear(viewport3, 1, &rect[0], D3DCLEAR_TARGET);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);

    color = get_surface_color(rt, 328, 248);
    ok(compare_color(color, 0x00ffffff, 0), "(328, 248) has color 0x%08x.\n", color);
    color = get_surface_color(rt, 332, 248);
    ok(compare_color(color, 0x00ffffff, 0), "(332, 248) has color 0x%08x.\n", color);
    color = get_surface_color(rt, 328, 252);
    ok(compare_color(color, 0x00ffffff, 0), "(328, 252) has color 0x%08x.\n", color);
    color = get_surface_color(rt, 332, 252);
    ok(compare_color(color, 0x0000ff00, 0), "(332, 252) has color 0x%08x.\n", color);

    color = get_surface_color(rt, 338, 248);
    ok(compare_color(color, 0x00ffffff, 0), "(338, 248) has color 0x%08x.\n", color);
    color = get_surface_color(rt, 342, 248);
    ok(compare_color(color, 0x00ffffff, 0), "(342, 248) has color 0x%08x.\n", color);
    color = get_surface_color(rt, 338, 252);
    ok(compare_color(color, 0x0000ff00, 0), "(338, 252) has color 0x%08x.\n", color);
    color = get_surface_color(rt, 342, 252);
    ok(compare_color(color, 0x00ffffff, 0), "(342, 252) has color 0x%08x.\n", color);

    color = get_surface_color(rt, 328, 258);
    ok(compare_color(color, 0x00ffffff, 0), "(328, 258) has color 0x%08x.\n", color);
    color = get_surface_color(rt, 332, 258);
    ok(compare_color(color, 0x0000ff00, 0), "(332, 258) has color 0x%08x.\n", color);
    color = get_surface_color(rt, 328, 262);
    ok(compare_color(color, 0x00ffffff, 0), "(328, 262) has color 0x%08x.\n", color);
    color = get_surface_color(rt, 332, 262);
    ok(compare_color(color, 0x00ffffff, 0), "(332, 262) has color 0x%08x.\n", color);

    color = get_surface_color(rt, 338, 258);
    ok(compare_color(color, 0x0000ff00, 0), "(338, 258) has color 0x%08x.\n", color);
    color = get_surface_color(rt, 342, 258);
    ok(compare_color(color, 0x00ffffff, 0), "(342, 258) has color 0x%08x.\n", color);
    color = get_surface_color(rt, 338, 262);
    ok(compare_color(color, 0x00ffffff, 0), "(338, 262) has color 0x%08x.\n", color);
    color = get_surface_color(rt, 342, 262);
    ok(compare_color(color, 0x00ffffff, 0), "(342, 262) has color 0x%08x.\n", color);

    /* COLORWRITEENABLE, SRGBWRITEENABLE and scissor rectangles do not exist
     * in d3d2. */

    IDirect3DViewport2_Release(viewport3);
    IDirect3DViewport2_Release(viewport2);
    IDirect3DViewport2_Release(viewport);
    IDirect3DMaterial2_Release(white);
    IDirect3DMaterial2_Release(red);
    IDirect3DMaterial2_Release(green);
    IDirect3DMaterial2_Release(blue);
    IDirectDrawSurface_Release(rt);
    refcount = IDirect3DDevice2_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "Ddraw object has %lu references left.\n", refcount);
    DestroyWindow(window);
}

struct enum_surfaces_param
{
    IDirectDraw2 *ddraw;
    DDSURFACEDESC modes[20];
    unsigned int mode_count;

    IDirectDrawSurface *surfaces[8];
    unsigned int count;
};

static HRESULT CALLBACK build_mode_list_cb(DDSURFACEDESC *desc, void *context)
{
    struct enum_surfaces_param *param = context;
    IDirectDrawSurface *surface;

    if (SUCCEEDED(IDirectDraw2_CreateSurface(param->ddraw, desc, &surface, NULL)))
    {
        if (param->mode_count < ARRAY_SIZE(param->modes))
            param->modes[param->mode_count] = *desc;
        ++param->mode_count;
        IDirectDrawSurface_Release(surface);
    }

    return DDENUMRET_OK;
}

static HRESULT WINAPI enum_surfaces_cb(IDirectDrawSurface *surface, DDSURFACEDESC *desc, void *context)
{
    struct enum_surfaces_param *param = context;
    BOOL found = FALSE;
    unsigned int i;

    for (i = 0; i < ARRAY_SIZE(param->surfaces); ++i)
    {
        if (param->surfaces[i] == surface)
        {
            found = TRUE;
            break;
        }
    }

    ok(found, "Unexpected surface %p enumerated.\n", surface);
    IDirectDrawSurface_Release(surface);
    ++param->count;

    return DDENUMRET_OK;
}

static HRESULT WINAPI enum_surfaces_create_cb(IDirectDrawSurface *surface, DDSURFACEDESC *desc, void *context)
{
    static const DWORD expect_flags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PITCH | DDSD_PIXELFORMAT;
    struct enum_surfaces_param *param = context;

    ok(!surface, "Unexpected surface %p.\n", surface);
    ok((desc->dwFlags & expect_flags) == expect_flags, "Got unexpected flags %#lx.\n", desc->dwFlags);
    if (param->count < ARRAY_SIZE(param->modes))
    {
        const DDSURFACEDESC *expect = &param->modes[param->count];
        ok(desc->dwWidth == expect->dwWidth, "Expected width %lu, got %lu.\n", expect->dwWidth, desc->dwWidth);
        ok(desc->dwHeight == expect->dwHeight, "Expected height %lu, got %lu.\n", expect->dwHeight, desc->dwHeight);
        ok(!memcmp(&desc->ddpfPixelFormat, &expect->ddpfPixelFormat, sizeof(desc->ddpfPixelFormat)),
                "Pixel formats didn't match.\n");
    }

    ++param->count;

    return DDENUMRET_OK;
}

static void test_enum_surfaces(void)
{
    struct enum_surfaces_param param = {0};
    DDPIXELFORMAT current_format;
    IDirectDraw2 *ddraw;
    DDSURFACEDESC desc;
    HRESULT hr;

    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    param.ddraw = ddraw;

    memset(&desc, 0, sizeof(desc));
    desc.dwSize = sizeof(desc);
    hr = IDirectDraw2_GetDisplayMode(ddraw, &desc);
    ok(hr == DD_OK, "Failed to get display mode, hr %#lx.\n", hr);
    current_format = desc.ddpfPixelFormat;

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, NULL, DDSCL_NORMAL);
    ok(hr == DD_OK, "Failed to set cooperative level, hr %#lx.\n", hr);

    hr = IDirectDraw2_EnumSurfaces(ddraw, DDENUMSURFACES_ALL, NULL, NULL, enum_surfaces_cb);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);

    hr = IDirectDraw2_EnumSurfaces(ddraw, DDENUMSURFACES_CANBECREATED | DDENUMSURFACES_ALL,
            NULL, NULL, enum_surfaces_cb);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);

    memset(&desc, 0, sizeof(desc));
    desc.dwSize = sizeof(desc);
    desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_MIPMAPCOUNT;
    desc.ddsCaps.dwCaps = DDSCAPS_TEXTURE | DDSCAPS_COMPLEX | DDSCAPS_MIPMAP;
    desc.dwMipMapCount = 3;
    desc.dwWidth = 32;
    desc.dwHeight = 32;
    hr = IDirectDraw2_CreateSurface(ddraw, &desc, &param.surfaces[0], NULL);
    ok(SUCCEEDED(hr), "Failed to create a surface, hr %#lx.\n", hr);

    hr = IDirectDrawSurface_GetAttachedSurface(param.surfaces[0], &desc.ddsCaps, &param.surfaces[1]);
    ok(SUCCEEDED(hr), "Failed to get attached surface, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_GetAttachedSurface(param.surfaces[1], &desc.ddsCaps, &param.surfaces[2]);
    ok(SUCCEEDED(hr), "Failed to get attached surface, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_GetAttachedSurface(param.surfaces[2], &desc.ddsCaps, &param.surfaces[3]);
    ok(hr == DDERR_NOTFOUND, "Got unexpected hr %#lx.\n", hr);
    ok(!param.surfaces[3], "Got unexpected pointer %p.\n", param.surfaces[3]);

    param.count = 0;
    hr = IDirectDraw2_EnumSurfaces(ddraw, DDENUMSURFACES_DOESEXIST | DDENUMSURFACES_ALL,
            &desc, &param, enum_surfaces_cb);
    ok(SUCCEEDED(hr), "Failed to enumerate surfaces, hr %#lx.\n", hr);
    ok(param.count == 3, "Got unexpected number of enumerated surfaces %u.\n", param.count);

    param.count = 0;
    hr = IDirectDraw2_EnumSurfaces(ddraw, DDENUMSURFACES_DOESEXIST | DDENUMSURFACES_ALL,
            NULL, &param, enum_surfaces_cb);
    ok(SUCCEEDED(hr), "Failed to enumerate surfaces, hr %#lx.\n", hr);
    ok(param.count == 3, "Got unexpected number of enumerated surfaces %u.\n", param.count);

    desc.dwFlags = DDSD_WIDTH | DDSD_HEIGHT;
    param.count = 0;
    hr = IDirectDraw2_EnumSurfaces(ddraw, DDENUMSURFACES_DOESEXIST | DDENUMSURFACES_MATCH,
            &desc, &param, enum_surfaces_cb);
    ok(hr == DD_OK, "Failed to enumerate surfaces, hr %#lx.\n", hr);
    ok(param.count == 1, "Got unexpected number of enumerated surfaces %u.\n", param.count);

    param.count = 0;
    hr = IDirectDraw2_EnumSurfaces(ddraw, DDENUMSURFACES_DOESEXIST | DDENUMSURFACES_NOMATCH,
            &desc, &param, enum_surfaces_cb);
    ok(hr == DD_OK, "Failed to enumerate surfaces, hr %#lx.\n", hr);
    ok(param.count == 2, "Got unexpected number of enumerated surfaces %u.\n", param.count);

    desc.dwFlags = 0;
    param.count = 0;
    hr = IDirectDraw2_EnumSurfaces(ddraw, DDENUMSURFACES_DOESEXIST | DDENUMSURFACES_MATCH,
            &desc, &param, enum_surfaces_cb);
    ok(hr == DD_OK, "Failed to enumerate surfaces, hr %#lx.\n", hr);
    ok(param.count == 3, "Got unexpected number of enumerated surfaces %u.\n", param.count);

    desc.dwFlags = 0;
    param.count = 0;
    hr = IDirectDraw2_EnumSurfaces(ddraw, DDENUMSURFACES_DOESEXIST, &desc, &param, enum_surfaces_cb);
    ok(hr == DD_OK, "Failed to enumerate surfaces, hr %#lx.\n", hr);
    ok(param.count == 3, "Got unexpected number of enumerated surfaces %u.\n", param.count);

    IDirectDrawSurface_Release(param.surfaces[2]);
    IDirectDrawSurface_Release(param.surfaces[1]);
    IDirectDrawSurface_Release(param.surfaces[0]);

    param.count = 0;
    hr = IDirectDraw2_EnumSurfaces(ddraw, DDENUMSURFACES_DOESEXIST | DDENUMSURFACES_ALL,
            NULL, &param, enum_surfaces_cb);
    ok(hr == DD_OK, "Failed to enumerate surfaces, hr %#lx.\n", hr);
    ok(!param.count, "Got unexpected number of enumerated surfaces %u.\n", param.count);

    memset(&desc, 0, sizeof(desc));
    desc.dwSize = sizeof(desc);
    desc.dwFlags = DDSD_CAPS;
    desc.ddsCaps.dwCaps = DDSCAPS_TEXTURE;

    hr = IDirectDraw2_EnumSurfaces(ddraw, DDENUMSURFACES_CANBECREATED | DDENUMSURFACES_ALL,
            &desc, &param, enum_surfaces_create_cb);
    ok(hr == DDERR_INVALIDPARAMS, "Failed to enumerate surfaces, hr %#lx.\n", hr);

    hr = IDirectDraw2_EnumSurfaces(ddraw, DDENUMSURFACES_CANBECREATED | DDENUMSURFACES_NOMATCH,
            &desc, &param, enum_surfaces_create_cb);
    ok(hr == DDERR_INVALIDPARAMS, "Failed to enumerate surfaces, hr %#lx.\n", hr);

    hr = IDirectDraw2_EnumSurfaces(ddraw, DDENUMSURFACES_CANBECREATED,
            &desc, &param, enum_surfaces_create_cb);
    ok(hr == DDERR_INVALIDPARAMS, "Failed to enumerate surfaces, hr %#lx.\n", hr);

    /* When not passed width and height, the callback is called with every
     * available display resolution. */

    param.mode_count = 0;
    desc.dwFlags |= DDSD_PIXELFORMAT;
    desc.ddpfPixelFormat = current_format;
    hr = IDirectDraw2_EnumDisplayModes(ddraw, 0, &desc, &param, build_mode_list_cb);
    ok(hr == DD_OK, "Failed to build mode list, hr %#lx.\n", hr);

    param.count = 0;
    desc.dwFlags &= ~DDSD_PIXELFORMAT;
    hr = IDirectDraw2_EnumSurfaces(ddraw, DDENUMSURFACES_CANBECREATED | DDENUMSURFACES_MATCH,
            &desc, &param, enum_surfaces_create_cb);
    ok(hr == DD_OK, "Failed to enumerate surfaces, hr %#lx.\n", hr);
    ok(param.count == param.mode_count, "Expected %u surfaces, got %u.\n", param.mode_count, param.count);

    desc.dwFlags |= DDSD_WIDTH | DDSD_HEIGHT;
    desc.dwWidth = desc.dwHeight = 32;

    param.modes[0].dwWidth = param.modes[0].dwHeight = 32;

    param.count = 0;
    hr = IDirectDraw2_EnumSurfaces(ddraw, DDENUMSURFACES_CANBECREATED | DDENUMSURFACES_MATCH,
            &desc, &param, enum_surfaces_create_cb);
    ok(hr == DD_OK, "Failed to enumerate surfaces, hr %#lx.\n", hr);
    ok(param.count == 1, "Got unexpected number of enumerated surfaces %u.\n", param.count);

    hr = IDirectDraw2_CreateSurface(ddraw, &desc, &param.surfaces[0], NULL);
    ok(hr == DD_OK, "Failed to create surface, hr %#lx.\n", hr);
    param.count = 0;
    hr = IDirectDraw2_EnumSurfaces(ddraw, DDENUMSURFACES_CANBECREATED | DDENUMSURFACES_DOESEXIST | DDENUMSURFACES_MATCH,
            &desc, &param, enum_surfaces_create_cb);
    ok(hr == DD_OK, "Failed to enumerate surfaces, hr %#lx.\n", hr);
    ok(param.count == 1, "Got unexpected number of enumerated surfaces %u.\n", param.count);
    IDirectDrawSurface2_Release(param.surfaces[0]);

    desc.dwFlags |= DDSD_PIXELFORMAT;
    desc.ddpfPixelFormat.dwSize = sizeof(desc.ddpfPixelFormat);
    desc.ddpfPixelFormat.dwFlags = DDPF_FOURCC;
    desc.ddpfPixelFormat.dwFourCC = 0xdeadbeef;

    param.count = 0;
    hr = IDirectDraw2_EnumSurfaces(ddraw, DDENUMSURFACES_CANBECREATED | DDENUMSURFACES_MATCH,
            &desc, &param, enum_surfaces_create_cb);
    ok(hr == DD_OK, "Failed to enumerate surfaces, hr %#lx.\n", hr);
    ok(!param.count, "Got unexpected number of enumerated surfaces %u.\n", param.count);

    IDirectDraw2_Release(ddraw);
}

static void test_viewport(void)
{
    static struct
    {
        D3DVIEWPORT7 vp;
        RECT expected_rect;
        const char *message;
    }
    tests[] =
    {
        {{  0,   0,  640,  480}, {  0, 120, 479, 359}, "Viewport (0, 0) - (640, 480)"},
        {{  0,   0,  320,  240}, {  0,  60, 239, 179}, "Viewport (0, 0) - (320, 240)"},
        {{  0,   0, 1280,  960}, {  0, 240, 639, 479}, "Viewport (0, 0) - (1280, 960)"},
        {{  0,   0, 2000, 1600}, {  0, 400, 639, 479}, "Viewport (0, 0) - (2000, 1600)"},
        {{100, 100,  640,  480}, {100, 220, 579, 459}, "Viewport (100, 100) - (640, 480)"},
        {{  0,   0, 8192, 8192}, {-10, -10, -10, -10}, "Viewport (0, 0) - (8192, 8192)"},
    };
    static const struct
    {
        unsigned int x, y;
    }
    rt_sizes[] =
    {
        {640, 480}, {1280, 960}, {320, 240}, {800, 600},
    };
    static D3DMATRIX mat =
    {
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f,
    };
    static D3DLVERTEX quad[] =
    {
        {{-1.5f}, {-0.5f}, {0.1f}, 0, {0xffffffff}},
        {{-1.5f}, { 0.5f}, {0.1f}, 0, {0xffffffff}},
        {{ 0.5f}, {-0.5f}, {0.1f}, 0, {0xffffffff}},
        {{ 0.5f}, { 0.5f}, {0.1f}, 0, {0xffffffff}},
    };
    IDirect3DViewport2 *viewport, *full_viewport;
    IDirect3DMaterial2 *black_background;
    IDirectDrawSurface *rt, *ds;
    DDSURFACEDESC surface_desc;
    IDirect3DDevice2 *device;
    BOOL expected_failure;
    IDirectDraw2 *ddraw;
    DDPIXELFORMAT z_fmt;
    D3DRECT clear_rect;
    unsigned int i, j;
    IDirect3D2 *d3d;
    D3DVIEWPORT vp;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    window = CreateWindowA("static", "ddraw_test", WS_OVERLAPPEDWINDOW,
            0, 0, 640, 480, NULL, NULL, NULL, NULL);
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    if (!(device = create_device(ddraw, window, DDSCL_NORMAL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        IDirectDraw2_Release(ddraw);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice2_GetDirect3D(device, &d3d);
    ok(SUCCEEDED(hr), "Failed to get Direct3D2 interface, hr %#lx.\n", hr);

    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_ZENABLE, D3DZB_FALSE);
    ok(SUCCEEDED(hr), "Failed to disable depth test, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_CULLMODE, D3DCULL_NONE);
    ok(SUCCEEDED(hr), "Failed to disable culling, hr %#lx.\n", hr);

    hr = IDirect3DDevice2_SetTransform(device, D3DTRANSFORMSTATE_WORLD, &mat);
    ok(SUCCEEDED(hr), "Failed to set world transform, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetTransform(device, D3DTRANSFORMSTATE_VIEW, &mat);
    ok(SUCCEEDED(hr), "Failed to set view transform, hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetTransform(device, D3DTRANSFORMSTATE_PROJECTION, &mat);
    ok(SUCCEEDED(hr), "Failed to set projection transform, hr %#lx.\n", hr);

    black_background = create_diffuse_material(device, 0.0f, 0.0f, 0.0f, 0.0f);

    ds = get_depth_stencil(device);
    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    hr = IDirectDrawSurface_GetSurfaceDesc(ds, &surface_desc);
    z_fmt = surface_desc.ddpfPixelFormat;

    for (i = 0; i < ARRAY_SIZE(rt_sizes); ++i)
    {
        winetest_push_context("Size %ux%u", rt_sizes[i].x, rt_sizes[i].y);

        if (i)
        {
            memset(&surface_desc, 0, sizeof(surface_desc));
            surface_desc.dwSize = sizeof(surface_desc);
            surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT;
            surface_desc.dwWidth = rt_sizes[i].x;
            surface_desc.dwHeight = rt_sizes[i].y;
            surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN | DDSCAPS_3DDEVICE;
            hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &rt, NULL);
            ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

            surface_desc.dwFlags = DDSD_CAPS | DDSD_PIXELFORMAT | DDSD_WIDTH | DDSD_HEIGHT;
            surface_desc.ddsCaps.dwCaps = DDSCAPS_ZBUFFER;
            surface_desc.ddpfPixelFormat = z_fmt;
            hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &ds, NULL);
            ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
            hr = IDirectDrawSurface_AddAttachedSurface(rt, ds);
            ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

            hr = IDirect3DDevice2_SetRenderTarget(device, rt, 0);
            ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
        }
        else
        {
            hr = IDirect3DDevice2_GetRenderTarget(device, &rt);
            ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
        }

        full_viewport = create_viewport(device, 0, 0, rt_sizes[i].x, rt_sizes[i].y);
        viewport_set_background(device, full_viewport, black_background);

        clear_rect.x1 = clear_rect.y1 = 0;
        clear_rect.x2 = rt_sizes[i].x;
        clear_rect.y2 = rt_sizes[i].y;

        for (j = 0; j < ARRAY_SIZE(tests); ++j)
        {
            winetest_push_context("%s", tests[j].message);

            expected_failure = tests[j].vp.dwX + tests[j].vp.dwWidth > rt_sizes[i].x
                    || tests[j].vp.dwY + tests[j].vp.dwHeight > rt_sizes[i].y;

            hr = IDirect3DViewport2_Clear(full_viewport, 1, &clear_rect, D3DCLEAR_TARGET);
            ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

            hr = IDirect3D2_CreateViewport(d3d, &viewport, NULL);
            ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
            hr = IDirect3DViewport2_SetViewport2(viewport, NULL);
            ok(hr == E_INVALIDARG, "Got unexpected hr %#lx.\n", hr);
            memset(&vp, 0, sizeof(vp));
            vp.dwSize = sizeof(vp);
            vp.dwX = tests[j].vp.dwX;
            vp.dwY = tests[j].vp.dwY;
            vp.dwWidth = tests[j].vp.dwWidth;
            vp.dwHeight = tests[j].vp.dwHeight;
            vp.dvScaleX = tests[j].vp.dwWidth / 2.0f;
            vp.dvScaleY = tests[j].vp.dwHeight / 2.0f;
            vp.dvMinZ = 0.0f;
            vp.dvMaxZ = 1.0f;
            hr = IDirect3DViewport2_SetViewport(viewport, &vp);
            ok(hr == D3DERR_VIEWPORTHASNODEVICE, "Got unexpected hr %#lx.\n", hr);
            hr = IDirect3DDevice2_AddViewport(device, viewport);
            ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
            hr = IDirect3DViewport2_SetViewport(viewport, &vp);
            ok(hr == (expected_failure ? E_INVALIDARG : DD_OK), "Got unexpected hr %#lx.\n", hr);

            hr = IDirect3DDevice2_SetCurrentViewport(device, viewport);
            ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
            if (expected_failure)
            {
                destroy_viewport(device, viewport);
                winetest_pop_context();
                continue;
            }

            hr = IDirect3DDevice2_BeginScene(device);
            ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
            hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, D3DVT_LVERTEX, quad, 4, 0);
            ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
            hr = IDirect3DDevice2_EndScene(device);
            ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

            check_rect(rt, tests[j].expected_rect);

            destroy_viewport(device, viewport);
            winetest_pop_context();
        }

        destroy_viewport(device, full_viewport);

        hr = IDirectDrawSurface_DeleteAttachedSurface(rt, 0, ds);
        ok(SUCCEEDED(hr), "Failed to detach surface, hr %#lx (i %u).\n", hr, i);
        IDirectDrawSurface_Release(ds);

        IDirectDrawSurface_Release(rt);

        winetest_pop_context();
    }

    destroy_material(black_background);
    refcount = IDirect3DDevice2_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D2_Release(d3d);
    IDirectDraw2_Release(ddraw);
    DestroyWindow(window);
}

static void test_find_device(void)
{
    D3DFINDDEVICESEARCH search = {0};
    D3DFINDDEVICERESULT result = {0};
    IDirect3DDevice2 *device;
    IDirectDraw2 *ddraw;
    IDirect3D2 *d3d;
    unsigned int i;
    HWND window;
    HRESULT hr;

    struct
    {
        DWORD size;
        GUID guid;
        D3DDEVICEDESC_V1 hw_desc;
        D3DDEVICEDESC_V1 sw_desc;
    } result_v1;

    struct
    {
        DWORD size;
        GUID guid;
        D3DDEVICEDESC_V2 hw_desc;
        D3DDEVICEDESC_V2 sw_desc;
    } result_v2;

    static const struct
    {
        const GUID *guid;
        HRESULT hr;
    }
    tests[] =
    {
        {&IID_IDirect3D,             DDERR_NOTFOUND},
        {&IID_IDirect3DRampDevice,   D3D_OK},
        {&IID_IDirect3DRGBDevice,    D3D_OK},
        {&IID_IDirect3DMMXDevice,    D3D_OK},
        {&IID_IDirect3DRefDevice,    DDERR_NOTFOUND},
        {&IID_IDirect3DTnLHalDevice, DDERR_NOTFOUND},
        {&IID_IDirect3DNullDevice,   DDERR_NOTFOUND},
    };

    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");

    if (FAILED(IDirectDraw2_QueryInterface(ddraw, &IID_IDirect3D2, (void **)&d3d)))
    {
        skip("D3D interface is not available, skipping test.\n");
        IDirectDraw2_Release(ddraw);
        return;
    }

    result.dwSize = sizeof(result);
    search.dwSize = sizeof(search);
    hr = IDirect3D2_FindDevice(d3d, NULL, NULL);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3D2_FindDevice(d3d, NULL, &result);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3D2_FindDevice(d3d, &search, NULL);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3D2_FindDevice(d3d, &search, &result);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    ok(result.dwSize == sizeof(result), "Got unexpected result size %lu.\n", result.dwSize);
    ok(result.ddHwDesc.dwSize == sizeof(result_v2.hw_desc),
            "Got unexpected HW desc size %lu.\n", result.ddHwDesc.dwSize);
    ok(result.ddSwDesc.dwSize == sizeof(result_v2.sw_desc),
            "Got unexpected SW desc size %lu.\n", result.ddSwDesc.dwSize);

    memset(&search, 0, sizeof(search));
    memset(&result, 0, sizeof(result));
    hr = IDirect3D2_FindDevice(d3d, &search, &result);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);

    search.dwSize = sizeof(search) + 1;
    result.dwSize = sizeof(result) + 1;
    hr = IDirect3D2_FindDevice(d3d, &search, &result);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);

    search.dwSize = sizeof(search);

    memset(&result_v1, 0, sizeof(result_v1));
    result_v1.size = sizeof(result_v1);
    hr = IDirect3D2_FindDevice(d3d, &search, (D3DFINDDEVICERESULT *)&result_v1);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    ok(result_v1.hw_desc.dwSize == sizeof(result_v2.hw_desc),
            "Got unexpected HW desc size %lu.\n", result_v1.hw_desc.dwSize);
    ok(result_v1.sw_desc.dwSize == sizeof(result_v2.sw_desc),
            "Got unexpected SW desc size %lu.\n", result_v1.sw_desc.dwSize);

    memset(&result_v2, 0, sizeof(result_v2));
    result_v2.size = sizeof(result_v2);
    hr = IDirect3D2_FindDevice(d3d, &search, (D3DFINDDEVICERESULT *)&result_v2);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    ok(result_v2.hw_desc.dwSize == sizeof(result_v2.hw_desc),
            "Got unexpected HW desc size %lu.\n", result_v2.hw_desc.dwSize);
    ok(result_v2.sw_desc.dwSize == sizeof(result_v2.sw_desc),
            "Got unexpected SW desc size %lu.\n", result_v2.sw_desc.dwSize);

    for (i = 0; i < ARRAY_SIZE(tests); ++i)
    {
        memset(&search, 0, sizeof(search));
        search.dwSize = sizeof(search);
        search.dwFlags = D3DFDS_GUID;
        search.guid = *tests[i].guid;

        memset(&result, 0, sizeof(result));
        result.dwSize = sizeof(result);

        hr = IDirect3D2_FindDevice(d3d, &search, &result);
        ok(hr == tests[i].hr, "Test %u: Got unexpected hr %#lx.\n", i, hr);
        ok(result.dwSize == sizeof(result), "Test %u: Got unexpected result size %lu.\n", i, result.dwSize);
        if (SUCCEEDED(hr))
        {
            ok(result.ddHwDesc.dwSize == sizeof(result_v2.hw_desc),
                    "Test %u: Got unexpected HW desc size %lu.\n", i, result.ddHwDesc.dwSize);
            ok(result.ddSwDesc.dwSize == sizeof(result_v2.sw_desc),
                    "Test %u: Got unexpected SW desc size %lu.\n", i, result.ddSwDesc.dwSize);
        }
        else
        {
            ok(!result.ddHwDesc.dwSize,
                    "Test %u: Got unexpected HW desc size %lu.\n", i, result.ddHwDesc.dwSize);
            ok(!result.ddSwDesc.dwSize,
                    "Test %u: Got unexpected SW desc size %lu.\n", i, result.ddSwDesc.dwSize);
        }
    }

    /* The HAL device can only be enumerated if hardware acceleration is present. */
    search.dwSize = sizeof(search);
    search.dwFlags = D3DFDS_GUID;
    search.guid = IID_IDirect3DHALDevice;
    result.dwSize = sizeof(result);
    hr = IDirect3D2_FindDevice(d3d, &search, &result);

    window = create_window();
    device = create_device(ddraw, window, DDSCL_NORMAL);
    if (hr == D3D_OK)
        ok(!!device, "Failed to create a 3D device.\n");
    else
        ok(!device, "Succeeded to create a 3D device.\n");
    if (device)
        IDirect3DDevice2_Release(device);
    DestroyWindow(window);

    /* Curiously the colour model criteria seem to be ignored. */
    search.dwSize = sizeof(search);
    search.dwFlags = D3DFDS_COLORMODEL;
    search.dcmColorModel = 0xdeadbeef;
    result.dwSize = sizeof(result);
    hr = IDirect3D2_FindDevice(d3d, &search, &result);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    IDirect3D2_Release(d3d);
    IDirectDraw2_Release(ddraw);
}

static IDirectDraw2 *killfocus_ddraw;
static IDirectDrawSurface *killfocus_surface;

static LRESULT CALLBACK killfocus_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam)
{
    ULONG ref;

    if (message == WM_KILLFOCUS)
    {
        ref = IDirectDrawSurface_Release(killfocus_surface);
        ok(!ref, "Unexpected surface refcount %lu.\n", ref);
        ref = IDirectDraw2_Release(killfocus_ddraw);
        ok(!ref, "Unexpected ddraw refcount %lu.\n", ref);
        killfocus_ddraw = NULL;
    }

    return DefWindowProcA(window, message, wparam, lparam);
}

static void test_killfocus(void)
{
    DDSURFACEDESC surface_desc;
    HRESULT hr;
    HWND window;
    WNDCLASSA wc = {0};

    wc.lpfnWndProc = killfocus_proc;
    wc.lpszClassName = "ddraw_killfocus_wndproc_wc";
    ok(RegisterClassA(&wc), "Failed to register window class.\n");

    window = CreateWindowA("ddraw_killfocus_wndproc_wc", "d3d7_test", WS_OVERLAPPEDWINDOW,
        0, 0, 640, 480, 0, 0, 0, 0);

    killfocus_ddraw = create_ddraw();
    ok(!!killfocus_ddraw, "Failed to create a ddraw object.\n");

    hr = IDirectDraw2_SetCooperativeLevel(killfocus_ddraw, window, DDSCL_FULLSCREEN | DDSCL_EXCLUSIVE);
    ok(SUCCEEDED(hr), "Failed to set cooperative level, hr %#lx.\n", hr);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE;
    hr = IDirectDraw2_CreateSurface(killfocus_ddraw, &surface_desc, &killfocus_surface, NULL);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);

    SetForegroundWindow(foreground);
    ok(!killfocus_ddraw, "WM_KILLFOCUS was not received.\n");

    DestroyWindow(window);
    UnregisterClassA("ddraw_killfocus_wndproc_wc", GetModuleHandleA(NULL));
}

static void test_gdi_surface(void)
{
    IDirectDrawSurface *primary, *backbuffer, *gdi_surface;
    DDSCAPS caps = {DDSCAPS_BACKBUFFER};
    DDSURFACEDESC surface_desc;
    IDirectDraw2 *ddraw;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

    /* Retrieving the GDI surface requires a primary surface to exist. */
    gdi_surface = (void *)0xc0dec0de;
    hr = IDirectDraw2_GetGDISurface(ddraw, &gdi_surface);
    ok(hr == DDERR_NOTFOUND, "Got unexpected hr %#lx.\n", hr);
    ok(!gdi_surface, "Got unexpected surface %p.\n", gdi_surface);

    hr = IDirectDraw2_FlipToGDISurface(ddraw);
    ok(hr == DDERR_NOTFOUND, "Got unexpected hr %#lx.\n", hr);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &primary, NULL);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirectDraw2_GetGDISurface(ddraw, &gdi_surface);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    ok(gdi_surface == primary, "Got unexpected surface %p, expected %p.\n", gdi_surface, primary);
    IDirectDrawSurface_Release(gdi_surface);

    /* Flipping to the GDI surface requires the primary surface to be
     * flippable. */
    hr = IDirectDraw2_FlipToGDISurface(ddraw);
    ok(hr == DDERR_NOTFLIPPABLE, "Got unexpected hr %#lx.\n", hr);

    IDirectDrawSurface_Release(primary);

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_BACKBUFFERCOUNT;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE | DDSCAPS_COMPLEX | DDSCAPS_FLIP;
    surface_desc.dwBackBufferCount = 1;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &primary, NULL);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_GetAttachedSurface(primary, &caps, &backbuffer);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    ok(backbuffer != primary, "Got unexpected backbuffer %p.\n", backbuffer);

    hr = IDirectDraw2_GetGDISurface(ddraw, &gdi_surface);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    ok(gdi_surface == primary, "Got unexpected surface %p, expected %p.\n", gdi_surface, primary);
    IDirectDrawSurface_Release(gdi_surface);

    hr = IDirectDrawSurface_Flip(primary, NULL, DDFLIP_WAIT);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDraw2_GetGDISurface(ddraw, &gdi_surface);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    ok(gdi_surface == backbuffer || broken(gdi_surface == primary),
            "Got unexpected surface %p, expected %p.\n", gdi_surface, backbuffer);
    IDirectDrawSurface_Release(gdi_surface);

    hr = IDirectDraw2_FlipToGDISurface(ddraw);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirectDraw2_GetGDISurface(ddraw, &gdi_surface);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    ok(gdi_surface == primary, "Got unexpected surface %p, expected %p.\n", gdi_surface, primary);
    IDirectDrawSurface_Release(gdi_surface);

    hr = IDirectDraw2_FlipToGDISurface(ddraw);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

    IDirectDrawSurface_Release(backbuffer);
    IDirectDrawSurface_Release(primary);

    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "%lu references left.\n", refcount);
    DestroyWindow(window);
}

static void test_alphatest(void)
{
#define ALPHATEST_PASSED 0x0000ff00
#define ALPHATEST_FAILED 0x00ff0000
    D3DRECT rect_full = {{0}, {0}, {640}, {480}};
    IDirect3DMaterial2 *blue, *failed;
    IDirect3DViewport2 *viewport;
    IDirect3DDevice2 *device;
    IDirectDrawSurface *rt;
    unsigned int color, i;
    IDirectDraw2 *ddraw;
    ULONG refcount;
    HWND window;
    DWORD value;
    HRESULT hr;

    static const struct
    {
        D3DCMPFUNC func;
        unsigned int color_less, color_equal, color_greater;
    }
    test_data[] =
    {
        {D3DCMP_NEVER,        ALPHATEST_FAILED, ALPHATEST_FAILED, ALPHATEST_FAILED},
        {D3DCMP_LESS,         ALPHATEST_PASSED, ALPHATEST_FAILED, ALPHATEST_FAILED},
        {D3DCMP_EQUAL,        ALPHATEST_FAILED, ALPHATEST_PASSED, ALPHATEST_FAILED},
        {D3DCMP_LESSEQUAL,    ALPHATEST_PASSED, ALPHATEST_PASSED, ALPHATEST_FAILED},
        {D3DCMP_GREATER,      ALPHATEST_FAILED, ALPHATEST_FAILED, ALPHATEST_PASSED},
        {D3DCMP_NOTEQUAL,     ALPHATEST_PASSED, ALPHATEST_FAILED, ALPHATEST_PASSED},
        {D3DCMP_GREATEREQUAL, ALPHATEST_FAILED, ALPHATEST_PASSED, ALPHATEST_PASSED},
        {D3DCMP_ALWAYS,       ALPHATEST_PASSED, ALPHATEST_PASSED, ALPHATEST_PASSED},
    };
    static D3DLVERTEX quad[] =
    {
        {{-1.0f}, {-1.0f}, {0.1f}, 0, {ALPHATEST_PASSED | 0x80000000}},
        {{-1.0f}, { 1.0f}, {0.1f}, 0, {ALPHATEST_PASSED | 0x80000000}},
        {{ 1.0f}, {-1.0f}, {0.1f}, 0, {ALPHATEST_PASSED | 0x80000000}},
        {{ 1.0f}, { 1.0f}, {0.1f}, 0, {ALPHATEST_PASSED | 0x80000000}},
    };

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    if (!(device = create_device(ddraw, window, DDSCL_NORMAL)))
    {
        skip("Failed to create a 3D device.\n");
        IDirectDraw2_Release(ddraw);
        DestroyWindow(window);
        return;
    }
    hr = IDirect3DDevice2_GetRenderTarget(device, &rt);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    blue = create_diffuse_material(device, 0.0f, 0.0f, 1.0f, 1.0f);
    failed = create_diffuse_material(device, 1.0f, 0.0f, 0.0f, 1.0f);

    viewport = create_viewport(device, 0, 0, 640, 480);
    hr = IDirect3DDevice2_SetCurrentViewport(device, viewport);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    viewport_set_background(device, viewport, blue);
    hr = IDirect3DViewport2_Clear(viewport, 1, &rect_full, D3DCLEAR_TARGET);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_LIGHTING, FALSE);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_ZENABLE, FALSE);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_ALPHATESTENABLE, TRUE);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    viewport_set_background(device, viewport, failed);
    for (i = 0; i < ARRAY_SIZE(test_data); ++i)
    {
        hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_ALPHAFUNC, test_data[i].func);
        ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

        hr = IDirect3DViewport2_Clear(viewport, 1, &rect_full, D3DCLEAR_TARGET);
        ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
        hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_ALPHAREF, 0x70);
        ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
        hr = IDirect3DDevice2_BeginScene(device);
        ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
        hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP,
                D3DVT_LVERTEX, quad, ARRAY_SIZE(quad), 0);
        ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
        hr = IDirect3DDevice2_EndScene(device);
        ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
        color = get_surface_color(rt, 320, 240);
        ok(compare_color(color, test_data[i].color_greater, 0),
                "Alphatest failed, color 0x%08x, expected 0x%08x, alpha > ref, func %u.\n",
                color, test_data[i].color_greater, test_data[i].func);

        hr = IDirect3DViewport2_Clear(viewport, 1, &rect_full, D3DCLEAR_TARGET);
        ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
        hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_ALPHAREF, 0xff70);
        ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
        hr = IDirect3DDevice2_GetRenderState(device, D3DRENDERSTATE_ALPHAREF, &value);
        ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
        ok(value == 0xff70, "Got unexpected value %#lx.\n", value);
        hr = IDirect3DDevice2_BeginScene(device);
        ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
        hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP,
                D3DVT_LVERTEX, quad, ARRAY_SIZE(quad), 0);
        ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
        hr = IDirect3DDevice2_EndScene(device);
        ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
        color = get_surface_color(rt, 320, 240);
        ok(compare_color(color, test_data[i].color_greater, 0),
                "Alphatest failed, color 0x%08x, expected 0x%08x, alpha > ref, func %u.\n",
                color, test_data[i].color_greater, test_data[i].func);
    }

    destroy_viewport(device, viewport);
    destroy_material(failed);
    destroy_material(blue);
    IDirectDrawSurface_Release(rt);
    refcount = IDirect3DDevice2_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "DirectDraw has %lu references left.\n", refcount);
    DestroyWindow(window);
}

static void test_clipper_refcount(void)
{
    IDirectDrawSurface *surface;
    IDirectDrawClipper *clipper, *clipper2;
    DDSURFACEDESC surface_desc;
    IDirectDraw2 *ddraw;
    IDirectDraw *ddraw1;
    ULONG refcount;
    HWND window;
    HRESULT hr;
    BOOL changed;
    const IDirectDrawClipperVtbl *orig_vtbl;

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirectDraw2_CreateClipper(ddraw, 0, &clipper, NULL);
    ok(SUCCEEDED(hr), "Failed to create clipper, hr %#lx.\n", hr);
    refcount = get_refcount((IUnknown *)clipper);
    ok(refcount == 1, "Got unexpected refcount %lu.\n", refcount);

    /* Show that clipper validation doesn't somehow happen through per-clipper vtable
     * pointers. */
    hr = IDirectDraw2_CreateClipper(ddraw, 0, &clipper2, NULL);
    ok(SUCCEEDED(hr), "Failed to create clipper, hr %#lx.\n", hr);
    ok(clipper->lpVtbl == clipper2->lpVtbl, "Got different clipper vtables %p and %p.\n",
            clipper->lpVtbl, clipper2->lpVtbl);
    orig_vtbl = clipper->lpVtbl;
    IDirectDrawClipper_Release(clipper2);

    /* Surfaces hold a reference to clippers. No surprises there. */
    hr = IDirectDrawSurface_SetClipper(surface, clipper);
    ok(SUCCEEDED(hr), "Failed to set clipper, hr %#lx.\n", hr);
    refcount = get_refcount((IUnknown *)clipper);
    ok(refcount == 2, "Got unexpected refcount %lu.\n", refcount);

    hr = IDirectDrawSurface_GetClipper(surface, &clipper2);
    ok(SUCCEEDED(hr), "Failed to get clipper, hr %#lx.\n", hr);
    ok(clipper == clipper2, "Got clipper %p, expected %p.\n", clipper2, clipper);
    refcount = IDirectDrawClipper_Release(clipper2);
    ok(refcount == 2, "Got unexpected refcount %lu.\n", refcount);

    hr = IDirectDrawSurface_SetClipper(surface, NULL);
    ok(SUCCEEDED(hr), "Failed to set clipper, hr %#lx.\n", hr);
    refcount = get_refcount((IUnknown *)clipper);
    ok(refcount == 1, "Got unexpected refcount %lu.\n", refcount);

    hr = IDirectDrawSurface_SetClipper(surface, clipper);
    ok(SUCCEEDED(hr), "Failed to set clipper, hr %#lx.\n", hr);
    refcount = get_refcount((IUnknown *)clipper);
    ok(refcount == 2, "Got unexpected refcount %lu.\n", refcount);

    refcount = IDirectDrawSurface_Release(surface);
    ok(!refcount, "%lu references left.\n", refcount);
    refcount = get_refcount((IUnknown *)clipper);
    ok(refcount == 1, "Got unexpected refcount %lu.\n", refcount);

    /* SetClipper with an invalid pointer crashes. */

    /* Clipper methods work with a broken vtable, with the exception of Release. */
    clipper->lpVtbl = (void *)0xdeadbeef;
    refcount = orig_vtbl->AddRef(clipper);
    todo_wine ok(refcount == 2, "Got unexpected refcount %lu.\n", refcount);
    refcount = orig_vtbl->Release(clipper);
    ok(!refcount, "Got unexpected refcount %lu.\n", refcount);

    clipper->lpVtbl = orig_vtbl;
    refcount = orig_vtbl->Release(clipper);
    todo_wine ok(refcount == 1, "Got unexpected refcount %lu.\n", refcount);

    /* Fix the refcount difference because Wine did not increase the ref in the
     * AddRef call above. */
    if (refcount)
    {
        refcount = IDirectDrawClipper_Release(clipper);
        ok(!refcount, "Got unexpected refcount %lu.\n", refcount);
    }

    /* Steal the reference and see what happens - releasing the surface works fine.
     * The clipper is destroyed and not kept alive by a hidden refcount - trying to
     * release it after the GetClipper call is likely to crash, and certain to crash
     * if we allocate and zero as much heap memory as we can get. */
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDraw2_CreateClipper(ddraw, 0, &clipper, NULL);
    ok(SUCCEEDED(hr), "Failed to create clipper, hr %#lx.\n", hr);
    hr = IDirectDrawSurface_SetClipper(surface, clipper);
    ok(SUCCEEDED(hr), "Failed to set clipper, hr %#lx.\n", hr);

    IDirectDrawClipper_Release(clipper);
    IDirectDrawClipper_Release(clipper);

    if (0)
    {
        /* Disabled because it causes heap corruption (HeapValidate fails and random
         * hangs in a later HeapFree) on Windows on one of my Machines: MacbookPro 10,1
         * running Windows 10 18363.535 and Nvidia driver 425.31. Driver version 441.66
         * is affected too. Some testbot machines have crashes directly in GetClipper
         * or proceed with a corrupted heap too.
         *
         * The same Windows and driver versions run the test without heap corruption on
         * a Geforce 1060 GTX card. I have not seen the problem on AMD GPUs either. */
        hr = IDirectDrawSurface_GetClipper(surface, &clipper2);
        ok(SUCCEEDED(hr), "Failed to get clipper, hr %#lx.\n", hr);
        ok(clipper == clipper2, "Got clipper %p, expected %p.\n", clipper2, clipper);
    }

    /* Show that invoking the Release method does not crash, but don't get the
     * vtable through the clipper pointer because it is no longer pointing to
     * valid memory. */
    refcount = orig_vtbl->Release(clipper);
    ok(!refcount, "%lu references left.\n", refcount);

    refcount = IDirectDrawSurface_Release(surface);
    ok(!refcount, "%lu references left.\n", refcount);

    /* It looks like the protection against invalid thispointers is part of
     * the IDirectDrawClipper method implementation, not IDirectDrawSurface. */
    clipper = calloc(1, 0x1000);
    ok(!!clipper, "failed to allocate memory\n");

    /* Assigning the vtable to our fake clipper does NOT make a difference on
     * native - there is a different member of the clipper implementation struct
     * that is used to determine if a clipper is valid. */
    clipper->lpVtbl = orig_vtbl;

    refcount = orig_vtbl->AddRef(clipper);
    todo_wine ok(!refcount, "Got refcount %lu.\n", refcount);
    refcount = orig_vtbl->AddRef((IDirectDrawClipper *)(ULONG_PTR)0xdeadbeef);
    ok(!refcount, "Got refcount %lu.\n", refcount);

    changed = 0x1234;
    hr = orig_vtbl->IsClipListChanged(clipper, &changed);
    todo_wine ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);
    todo_wine ok(changed == 0x1234, "'changed' changed: %x.\n", changed);

    changed = 0x1234;
    hr = orig_vtbl->IsClipListChanged((IDirectDrawClipper *)(ULONG_PTR)0xdeadbeef, &changed);
    ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);
    ok(changed == 0x1234, "'changed' changed: %x.\n", changed);

    /* Nope, we can't initialize our fake clipper. */
    hr = IDirectDraw2_QueryInterface(ddraw, &IID_IDirectDraw, (void **)&ddraw1);
    ok(SUCCEEDED(hr), "Failed to get ddraw1 interface, hr %#lx.\n", hr);

    hr = orig_vtbl->Initialize(clipper, ddraw1, 0);
    todo_wine ok(hr == DDERR_INVALIDPARAMS, "Got unexpected hr %#lx.\n", hr);

    IDirectDraw_Release(ddraw1);

    free(clipper);

    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "%lu references left.\n", refcount);
    DestroyWindow(window);
}

static void test_caps(void)
{
    DDCAPS hal_caps, hel_caps;
    IDirectDraw2 *ddraw;
    IDirectDraw *ddraw1;
    HWND window;
    HRESULT hr;
    BOOL no3d;

    static const struct
    {
        unsigned int depth;
        DWORD flag;
    }
    depth_caps[] =
    {
        {16, DDBD_16},
        {24, DDBD_24},
        {32, DDBD_32},
    };

    static const DWORD caps_hel = DDSCAPS_FLIP
            | DDSCAPS_OFFSCREENPLAIN
            | DDSCAPS_PALETTE
            | DDSCAPS_PRIMARYSURFACE
            | DDSCAPS_TEXTURE
            | DDSCAPS_ZBUFFER
            | DDSCAPS_MIPMAP;

    static const DWORD caps_never = DDSCAPS_RESERVED1
            | DDSCAPS_PRIMARYSURFACELEFT
            | DDSCAPS_WRITEONLY
            | DDSCAPS_LIVEVIDEO
            | DDSCAPS_RESERVED2
            | 0x01000000u
            | 0x02000000u
            | DDSCAPS_ALLOCONLOAD
            | DDSCAPS_VIDEOPORT
            | DDSCAPS_OPTIMIZED;

    static const DWORD caps_always = DDSCAPS_BACKBUFFER
            | DDSCAPS_FLIP
            | DDSCAPS_OFFSCREENPLAIN
            | DDSCAPS_PRIMARYSURFACE
            | DDSCAPS_TEXTURE
            | DDSCAPS_3DDEVICE
            | DDSCAPS_ZBUFFER
            | DDSCAPS_VIDEOMEMORY
            | DDSCAPS_MIPMAP;

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    hr = IDirectDraw_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

    memset(&hal_caps, 0, sizeof(hal_caps));
    memset(&hel_caps, 0, sizeof(hel_caps));
    hal_caps.dwSize = sizeof(hal_caps);
    hel_caps.dwSize = sizeof(hel_caps);
    hr = IDirectDraw2_GetCaps(ddraw, &hal_caps, &hel_caps);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    ok(hal_caps.ddsOldCaps.dwCaps == hal_caps.ddsCaps.dwCaps,
            "Got unexpected caps %#lx, expected %#lx.\n",
            hal_caps.ddsOldCaps.dwCaps, hal_caps.ddsCaps.dwCaps);
    ok(hel_caps.ddsOldCaps.dwCaps == hel_caps.ddsCaps.dwCaps,
            "Got unexpected caps %#lx, expected %#lx.\n",
            hel_caps.ddsOldCaps.dwCaps, hel_caps.ddsCaps.dwCaps);

    no3d = !(hal_caps.ddsCaps.dwCaps & DDSCAPS_3DDEVICE);
    if (hal_caps.ddsCaps.dwCaps)
    {
        ok(!(hal_caps.ddsCaps.dwCaps & caps_never), "Got unexpected caps %#lx.\n", hal_caps.ddsCaps.dwCaps);
        todo_wine_if(no3d) ok(!(~hal_caps.ddsCaps.dwCaps & caps_always),
                "Got unexpected caps %#lx.\n", hal_caps.ddsCaps.dwCaps);
    }
    todo_wine ok(hel_caps.ddsCaps.dwCaps == caps_hel, "Got unexpected caps %#lx.\n", hel_caps.ddsCaps.dwCaps);

    ok(!(hal_caps.dwZBufferBitDepths & ~(DDBD_16 | DDBD_24 | DDBD_32)),
            "Got HAL depth caps %#lx.\n", hal_caps.dwZBufferBitDepths);
    todo_wine ok(hel_caps.dwZBufferBitDepths == DDBD_16, "Got HEL depth caps %#lx.\n", hel_caps.dwZBufferBitDepths);

    for (unsigned int i = 0; i < ARRAY_SIZE(depth_caps); ++i)
    {
        bool supported = (hal_caps.dwZBufferBitDepths & depth_caps[i].flag);
        IDirectDrawSurface *surface;
        DDSURFACEDESC desc =
        {
            .dwSize = sizeof(DDSURFACEDESC),
            .dwFlags = DDSD_CAPS | DDSD_ZBUFFERBITDEPTH | DDSD_WIDTH | DDSD_HEIGHT,
            .ddsCaps =
            {
                .dwCaps = DDSCAPS_ZBUFFER,
            },
            .dwZBufferBitDepth = depth_caps[i].depth,
            .dwWidth = 64,
            .dwHeight = 64,
        };

        winetest_push_context("depth %u", depth_caps[i].depth);

        /* dwZBufferBitDepths sometimes reports false negatives,
         * but it has not been known to report false positives. */
        hr = IDirectDraw2_CreateSurface(ddraw, &desc, &surface, NULL);
        ok(hr == S_OK || (!supported && hr == DDERR_INVALIDPIXELFORMAT), "Got hr %#lx.\n", hr);

        if (hr == S_OK)
        {
            hr = IDirectDrawSurface_GetSurfaceDesc(surface, &desc);
            ok(hr == S_OK, "Got hr %#lx.\n", hr);
            ok(desc.ddsCaps.dwCaps == (DDSCAPS_VIDEOMEMORY | DDSCAPS_LOCALVIDMEM | DDSCAPS_ZBUFFER)
                    || (!supported && (desc.ddsCaps.dwCaps == (DDSCAPS_SYSTEMMEMORY | DDSCAPS_ZBUFFER))),
                    "Got caps %#lx.\n", desc.ddsCaps.dwCaps);
            IDirectDrawSurface_Release(surface);
        }

        winetest_pop_context();
    }

    IDirectDraw2_Release(ddraw);

    if (hal_caps.ddsCaps.dwCaps)
    {
        hr = DirectDrawCreate((GUID *)DDCREATE_HARDWAREONLY, &ddraw1, NULL);
        ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
        hr = IDirectDraw_QueryInterface(ddraw1, &IID_IDirectDraw2, (void **)&ddraw);
        ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
        IDirectDraw_Release(ddraw1);

        memset(&hal_caps, 0, sizeof(hal_caps));
        memset(&hel_caps, 0, sizeof(hel_caps));
        hal_caps.dwSize = sizeof(hal_caps);
        hel_caps.dwSize = sizeof(hel_caps);
        hr = IDirectDraw2_GetCaps(ddraw, &hal_caps, &hel_caps);
        ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
        ok(hal_caps.ddsOldCaps.dwCaps == hal_caps.ddsCaps.dwCaps,
                "Got unexpected caps %#lx, expected %#lx.\n",
                hal_caps.ddsOldCaps.dwCaps, hal_caps.ddsCaps.dwCaps);
        ok(hel_caps.ddsOldCaps.dwCaps == hel_caps.ddsCaps.dwCaps,
                "Got unexpected caps %#lx, expected %#lx.\n",
                hel_caps.ddsOldCaps.dwCaps, hel_caps.ddsCaps.dwCaps);

        ok(!(hal_caps.ddsCaps.dwCaps & caps_never), "Got unexpected caps %#lx.\n", hal_caps.ddsCaps.dwCaps);
        todo_wine_if(no3d) ok(!(~hal_caps.ddsCaps.dwCaps & caps_always),
                "Got unexpected caps %#lx.\n", hal_caps.ddsCaps.dwCaps);
        todo_wine ok(!(hel_caps.ddsCaps.dwCaps & ~(DDSCAPS_STANDARDVGAMODE | DDSCAPS_MODEX))
                || broken(hel_caps.ddsCaps.dwCaps == caps_hel), /* Windows 8+ */
                "Got unexpected caps %#lx.\n", hel_caps.ddsCaps.dwCaps);

        IDirectDraw2_Release(ddraw);
    }

    hr = DirectDrawCreate((GUID *)DDCREATE_EMULATIONONLY, &ddraw1, NULL);
    ok(hr == DD_OK || (is_ddraw64 && hr == E_FAIL), "Got unexpected hr %#lx.\n", hr);
    if (SUCCEEDED(hr))
    {
        hr = IDirectDraw_QueryInterface(ddraw1, &IID_IDirectDraw2, (void **)&ddraw);
        ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
        IDirectDraw_Release(ddraw1);
        hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
        ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

        memset(&hal_caps, 0, sizeof(hal_caps));
        memset(&hel_caps, 0, sizeof(hel_caps));
        hal_caps.dwSize = sizeof(hal_caps);
        hel_caps.dwSize = sizeof(hel_caps);
        hr = IDirectDraw2_GetCaps(ddraw, &hal_caps, &hel_caps);
        ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
        ok(hal_caps.ddsOldCaps.dwCaps == hal_caps.ddsCaps.dwCaps,
                "Got unexpected caps %#lx, expected %#lx.\n",
                hal_caps.ddsOldCaps.dwCaps, hal_caps.ddsCaps.dwCaps);
        ok(hel_caps.ddsOldCaps.dwCaps == hel_caps.ddsCaps.dwCaps,
                "Got unexpected caps %#lx, expected %#lx.\n",
                hel_caps.ddsOldCaps.dwCaps, hel_caps.ddsCaps.dwCaps);

        todo_wine ok(!(hal_caps.ddsCaps.dwCaps & ~(DDSCAPS_STANDARDVGAMODE | DDSCAPS_MODEX)),
                "Got unexpected caps %#lx.\n", hal_caps.ddsCaps.dwCaps);
        todo_wine ok(hel_caps.ddsCaps.dwCaps == caps_hel, "Got unexpected caps %#lx.\n", hel_caps.ddsCaps.dwCaps);

        for (unsigned int i = 0; i < ARRAY_SIZE(depth_caps); ++i)
        {
            IDirectDrawSurface *surface;
            DDSURFACEDESC desc =
            {
                .dwSize = sizeof(DDSURFACEDESC),
                .dwFlags = DDSD_CAPS | DDSD_ZBUFFERBITDEPTH | DDSD_WIDTH | DDSD_HEIGHT,
                .ddsCaps =
                {
                    .dwCaps = DDSCAPS_ZBUFFER,
                },
                .dwZBufferBitDepth = depth_caps[i].depth,
                .dwWidth = 64,
                .dwHeight = 64,
            };

            winetest_push_context("depth %u", depth_caps[i].depth);

            hr = IDirectDraw2_CreateSurface(ddraw, &desc, &surface, NULL);
            if (depth_caps[i].depth == 16 || depth_caps[i].depth == 32)
                ok(hr == S_OK, "Got hr %#lx.\n", hr);
            else
                todo_wine ok(hr == DDERR_INVALIDPIXELFORMAT, "Got hr %#lx.\n", hr);

            if (hr == S_OK)
            {
                hr = IDirectDrawSurface_GetSurfaceDesc(surface, &desc);
                ok(hr == S_OK, "Got hr %#lx.\n", hr);
                todo_wine_if (depth_caps[i].depth != 32)
                    ok(desc.ddsCaps.dwCaps == (DDSCAPS_SYSTEMMEMORY | DDSCAPS_ZBUFFER),
                            "Got caps %#lx.\n", desc.ddsCaps.dwCaps);
                IDirectDrawSurface_Release(surface);
            }

            winetest_pop_context();
        }

        IDirectDraw2_Release(ddraw);
    }

    DestroyWindow(window);
}

static void test_d32_support(void)
{
    IDirectDrawSurface *surface;
    DDSURFACEDESC surface_desc;
    IDirectDraw2 *ddraw;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_ZBUFFERBITDEPTH | DDSD_WIDTH | DDSD_HEIGHT;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_ZBUFFER;
    surface_desc.dwZBufferBitDepth = 32;
    surface_desc.dwWidth = 64;
    surface_desc.dwHeight = 64;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    hr = IDirectDrawSurface_GetSurfaceDesc(surface, &surface_desc);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    ok((surface_desc.dwFlags & DDSD_ZBUFFERBITDEPTH), "Got unexpected flags %#lx.\n", surface_desc.dwFlags);
    ok(surface_desc.dwZBufferBitDepth == 32,
            "Got unexpected dwZBufferBitDepth %lu.\n", surface_desc.dwZBufferBitDepth);
    IDirectDrawSurface_Release(surface);

    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "%lu references left.\n", refcount);
    DestroyWindow(window);
}

struct find_different_mode_param
{
    unsigned int old_width;
    unsigned int old_height;
    unsigned int old_frequency;
    unsigned int new_width;
    unsigned int new_height;
    unsigned int new_frequency;
    unsigned int new_bpp;
};

static HRESULT CALLBACK find_different_mode_callback(DDSURFACEDESC *surface_desc, void *context)
{
    struct find_different_mode_param *param = context;

    if (surface_desc->ddpfPixelFormat.dwRGBBitCount != registry_mode.dmBitsPerPel)
        return DDENUMRET_OK;

    /* See comment in ddraw7 about the frequency. */
    if (surface_desc->dwWidth != param->old_width && surface_desc->dwHeight != param->old_height &&
            (!compare_uint(surface_desc->dwRefreshRate, param->old_frequency, 1) || !param->old_frequency))
    {
        /* See test_coop_level_mode_set_enum_cb() for why enumeration might accidentally continue. */
        if (!param->new_width || (param->new_width < registry_mode.dmPelsWidth
                && param->new_height < registry_mode.dmPelsHeight))
        {
            param->new_width = surface_desc->dwWidth;
            param->new_height = surface_desc->dwHeight;
            param->new_frequency = surface_desc->dwRefreshRate;
            param->new_bpp = surface_desc->ddpfPixelFormat.dwRGBBitCount;
        }
        return DDENUMRET_CANCEL;
    }

    return DDENUMRET_OK;
}

static void test_cursor_clipping(void)
{
    struct find_different_mode_param param;
    DDSURFACEDESC surface_desc;
    RECT rect, clip_rect;
    IDirectDraw2 *ddraw;
    HWND window;
    HRESULT hr;
    BOOL ret;

    window = create_window();
    ok(!!window, "Failed to create a window.\n");
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    hr = IDirectDraw2_GetDisplayMode(ddraw, &surface_desc);
    ok(hr == DD_OK, "GetDisplayMode failed, hr %#lx.\n", hr);

    memset(&param, 0, sizeof(param));
    param.old_width = surface_desc.dwWidth;
    param.old_height = surface_desc.dwHeight;
    hr = IDirectDraw2_EnumDisplayModes(ddraw, 0, NULL, &param, find_different_mode_callback);
    ok(hr == DD_OK, "EnumDisplayModes failed, hr %#lx.\n", hr);
    if (!(param.new_width && param.new_height))
    {
        skip("Failed to find a different mode than %ux%u.\n", param.old_width, param.old_height);
        goto done;
    }

    ret = ClipCursor(NULL);
    ok(ret, "ClipCursor failed, error %lu.\n", GetLastError());
    get_virtual_rect(&rect);
    ret = GetClipCursor(&clip_rect);
    ok(ret, "GetClipCursor failed, error %lu.\n", GetLastError());
    ok(EqualRect(&clip_rect, &rect), "Expect clip rect %s, got %s.\n", wine_dbgstr_rect(&rect),
            wine_dbgstr_rect(&clip_rect));

    /* Set cooperative level to normal */
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(hr == DD_OK, "SetCooperativeLevel failed, hr %#lx.\n", hr);
    flush_events();
    get_virtual_rect(&rect);
    ret = GetClipCursor(&clip_rect);
    ok(ret, "GetClipCursor failed, error %lu.\n", GetLastError());
    ok(EqualRect(&clip_rect, &rect), "Expect clip rect %s, got %s.\n", wine_dbgstr_rect(&rect),
            wine_dbgstr_rect(&clip_rect));

    hr = set_display_mode(ddraw, param.new_width, param.new_height);
    ok(hr == DD_OK || hr == DDERR_UNSUPPORTED, "SetDisplayMode failed, hr %#lx.\n", hr);
    if (FAILED(hr))
    {
        win_skip("SetDisplayMode failed, hr %#lx.\n", hr);
        goto done;
    }
    flush_events();
    get_virtual_rect(&rect);
    ret = GetClipCursor(&clip_rect);
    ok(ret, "GetClipCursor failed, error %lu.\n", GetLastError());
    ok(EqualRect(&clip_rect, &rect), "Expect clip rect %s, got %s.\n", wine_dbgstr_rect(&rect),
            wine_dbgstr_rect(&clip_rect));

    hr = IDirectDraw2_RestoreDisplayMode(ddraw);
    ok(hr == DD_OK, "RestoreDisplayMode failed, hr %#lx.\n", hr);
    flush_events();
    get_virtual_rect(&rect);
    ret = GetClipCursor(&clip_rect);
    ok(ret, "GetClipCursor failed, error %lu.\n", GetLastError());
    ok(EqualRect(&clip_rect, &rect), "Expect clip rect %s, got %s.\n", wine_dbgstr_rect(&rect),
            wine_dbgstr_rect(&clip_rect));

    /* Switch to full screen cooperative level */
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(hr == DD_OK, "SetCooperativeLevel failed, hr %#lx.\n", hr);
    flush_events();
    SetRect(&rect, 0, 0, param.old_width, param.old_height);
    ret = GetClipCursor(&clip_rect);
    ok(ret, "GetClipCursor failed, error %lu.\n", GetLastError());
    ok(EqualRect(&clip_rect, &rect), "Expect clip rect %s, got %s.\n", wine_dbgstr_rect(&rect),
            wine_dbgstr_rect(&clip_rect));

    hr = set_display_mode(ddraw, param.new_width, param.new_height);
    ok(hr == DD_OK || hr == DDERR_UNSUPPORTED, "SetDisplayMode failed, hr %#lx.\n", hr);
    if (FAILED(hr))
    {
        win_skip("SetDisplayMode failed, hr %#lx.\n", hr);
        goto done;
    }
    flush_events();
    SetRect(&rect, 0, 0, param.new_width, param.new_height);
    ret = GetClipCursor(&clip_rect);
    ok(ret, "GetClipCursor failed, error %lu.\n", GetLastError());
    ok(EqualRect(&clip_rect, &rect), "Expect clip rect %s, got %s.\n", wine_dbgstr_rect(&rect),
            wine_dbgstr_rect(&clip_rect));

    /* Restore display mode */
    hr = IDirectDraw2_RestoreDisplayMode(ddraw);
    ok(hr == DD_OK, "RestoreDisplayMode failed, hr %#lx.\n", hr);
    flush_events();
    SetRect(&rect, 0, 0, param.old_width, param.old_height);
    ret = GetClipCursor(&clip_rect);
    ok(ret, "GetClipCursor failed, error %lu.\n", GetLastError());
    ok(EqualRect(&clip_rect, &rect), "Expect clip rect %s, got %s.\n", wine_dbgstr_rect(&rect),
            wine_dbgstr_rect(&clip_rect));

    /* Switch to normal cooperative level */
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(hr == DD_OK, "SetCooperativeLevel failed, hr %#lx.\n", hr);
    flush_events();
    get_virtual_rect(&rect);
    ret = GetClipCursor(&clip_rect);
    ok(ret, "GetClipCursor failed, error %lu.\n", GetLastError());
    ok(EqualRect(&clip_rect, &rect), "Expect clip rect %s, got %s.\n", wine_dbgstr_rect(&rect),
            wine_dbgstr_rect(&clip_rect));

done:
    IDirectDraw2_Release(ddraw);
    DestroyWindow(window);
}

static BOOL CALLBACK test_window_position_cb(HMONITOR monitor, HDC hdc, RECT *monitor_rect,
        LPARAM lparam)
{
    RECT primary_rect, window_rect, new_rect;
    IDirectDraw2 *ddraw;
    HWND window;
    HRESULT hr;
    BOOL ret;

    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    window = CreateWindowA("static", "ddraw_test", WS_POPUP | WS_VISIBLE, monitor_rect->left,
            monitor_rect->top, 100, 100, NULL, NULL, NULL, NULL);
    ok(!!window, "Failed to create a window.\n");
    flush_events();

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(hr == DD_OK, "SetCooperativeLevel failed, hr %#lx.\n", hr);
    flush_events();
    ret = GetWindowRect(window, &window_rect);
    ok(ret, "GetWindowRect failed, error %lu.\n", GetLastError());
    SetRect(&primary_rect, 0, 0, GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN));
    ok(EqualRect(&window_rect, &primary_rect), "Expect window rect %s, got %s.\n",
            wine_dbgstr_rect(&primary_rect), wine_dbgstr_rect(&window_rect));

    new_rect = window_rect;
    --new_rect.right;
    --new_rect.bottom;

    ret = MoveWindow(window, new_rect.left, new_rect.top, new_rect.right - new_rect.left,
            new_rect.bottom - new_rect.top, TRUE);
    ok(ret, "Got unexpected ret %#x, error %lu.\n", ret, GetLastError());
    ret = GetWindowRect(window, &window_rect);
    ok(ret, "Got unexpected ret %#x, error %lu.\n", ret, GetLastError());
    ok(EqualRect(&window_rect, &new_rect),
            "Expected window rect %s, got %s.\n",
            wine_dbgstr_rect(monitor_rect), wine_dbgstr_rect(&window_rect));
    /* After processing window events window rectangle gets restored. But only once, the size set
     * on the second resize remains. */
    flush_events();
    ret = GetWindowRect(window, &window_rect);
    ok(ret, "Got unexpected ret %#x, error %lu.\n", ret, GetLastError());
    /* Both Windows and Wine change the size of the window. On Windows it is exactly the new size but in Wine
     * it may get adjusted depending on window manager. */
    ok(window_rect.right != monitor_rect->right && window_rect.bottom != monitor_rect->bottom,
            "Expected window rect %s, got %s.\n",
            wine_dbgstr_rect(monitor_rect), wine_dbgstr_rect(&window_rect));

    ret = MoveWindow(window, new_rect.left, new_rect.top, new_rect.right - new_rect.left,
            new_rect.bottom - new_rect.top, TRUE);
    ok(ret, "Got unexpected ret %#x, error %lu.\n", ret, GetLastError());
    ret = GetWindowRect(window, &window_rect);
    ok(ret, "Got unexpected ret %#x, error %lu.\n", ret, GetLastError());
    ok(EqualRect(&window_rect, &new_rect),
            "Expected window rect %s, got %s.\n",
            wine_dbgstr_rect(monitor_rect), wine_dbgstr_rect(&window_rect));
    flush_events();
    ret = GetWindowRect(window, &window_rect);
    ok(ret, "Got unexpected ret %#x, error %lu.\n", ret, GetLastError());
    ok(window_rect.right != monitor_rect->right && window_rect.bottom != monitor_rect->bottom,
            "Expected window rect %s, got %s.\n",
            wine_dbgstr_rect(monitor_rect), wine_dbgstr_rect(&window_rect));

    /* Window activation should restore the window to fit the whole primary monitor */
    ret = SetWindowPos(window, 0, monitor_rect->left, monitor_rect->top, 0, 0,
            SWP_NOZORDER | SWP_NOSIZE);
    ok(ret, "SetWindowPos failed, error %lu.\n", GetLastError());
    ret = SetForegroundWindow(foreground);
    ok(ret, "Failed to set foreground window.\n");
    flush_events();
    ret = ShowWindow(window, SW_RESTORE);
    ok(ret, "Failed to restore window, error %lu.\n", GetLastError());
    flush_events();
    ret = SetForegroundWindow(window);
    ok(ret, "SetForegroundWindow failed, error %lu.\n", GetLastError());
    flush_events();
    ret = GetWindowRect(window, &window_rect);
    ok(ret, "GetWindowRect failed, error %lu.\n", GetLastError());
    ok(EqualRect(&window_rect, &primary_rect), "Expect window rect %s, got %s.\n",
            wine_dbgstr_rect(&primary_rect), wine_dbgstr_rect(&window_rect));

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(hr == DD_OK, "SetCooperativeLevel failed, hr %#lx.\n", hr);
    ret = GetWindowRect(window, &window_rect);
    ok(ret, "GetWindowRect failed, error %lu.\n", GetLastError());
    ok(EqualRect(&window_rect, &primary_rect), "Expect window rect %s, got %s.\n",
            wine_dbgstr_rect(&primary_rect), wine_dbgstr_rect(&window_rect));

    DestroyWindow(window);
    IDirectDraw2_Release(ddraw);
    return TRUE;
}

static void test_window_position(void)
{
    EnumDisplayMonitors(NULL, NULL, test_window_position_cb, 0);
}

static BOOL CALLBACK test_get_display_mode_cb(HMONITOR monitor, HDC hdc, RECT *monitor_rect,
        LPARAM lparam)
{
    DDSURFACEDESC surface_desc;
    IDirectDraw2 *ddraw;
    HWND window;
    HRESULT hr;
    BOOL ret;

    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    window = create_window();
    ok(!!window, "Failed to create a window.\n");

    /* Test that DirectDraw doesn't use the device window to determine which monitor to use */
    ret = SetWindowPos(window, 0, monitor_rect->left, monitor_rect->top, 0, 0,
            SWP_NOZORDER | SWP_NOSIZE);
    ok(ret, "SetWindowPos failed, error %lu.\n", GetLastError());

    surface_desc.dwSize = sizeof(surface_desc);
    hr = IDirectDraw2_GetDisplayMode(ddraw, &surface_desc);
    ok(hr == DD_OK, "GetDisplayMode failed, hr %#lx.\n", hr);
    ok(surface_desc.dwWidth == GetSystemMetrics(SM_CXSCREEN), "Expect width %d, got %lu.\n",
            GetSystemMetrics(SM_CXSCREEN), surface_desc.dwWidth);
    ok(surface_desc.dwHeight == GetSystemMetrics(SM_CYSCREEN), "Expect height %d, got %lu.\n",
            GetSystemMetrics(SM_CYSCREEN), surface_desc.dwHeight);

    DestroyWindow(window);
    IDirectDraw2_Release(ddraw);
    return TRUE;
}

static void test_get_display_mode(void)
{
    static const DWORD flags = DDSD_WIDTH | DDSD_HEIGHT | DDSD_REFRESHRATE | DDSD_PIXELFORMAT | DDSD_PITCH;
    struct find_different_mode_param param;
    DDSURFACEDESC surface_desc;
    IDirectDraw2 *ddraw;
    DEVMODEA devmode;
    HWND window;
    HRESULT hr;
    BOOL ret;

    EnumDisplayMonitors(NULL, NULL, test_get_display_mode_cb, 0);

    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    window = create_window();
    ok(!!window, "Failed to create a window.\n");

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(hr == DD_OK, "SetCooperativeLevel failed, hr %#lx.\n", hr);

    memset(&devmode, 0, sizeof(devmode));
    devmode.dmSize = sizeof(devmode);
    ret = EnumDisplaySettingsA(NULL, ENUM_CURRENT_SETTINGS, &devmode);
    ok(ret, "EnumDisplaySettingsA failed, error %lu.\n", GetLastError());

    surface_desc.dwSize = sizeof(surface_desc);
    hr = IDirectDraw2_GetDisplayMode(ddraw, &surface_desc);
    ok(hr == DD_OK, "GetDisplayMode failed, hr %#lx.\n", hr);
    ok(surface_desc.dwSize == sizeof(surface_desc), "Got dwSize %lu.\n", surface_desc.dwSize);
    ok(surface_desc.dwFlags == flags, "Expected dwFlags %#lx, got %#lx.\n", flags,
            surface_desc.dwFlags);
    ok(surface_desc.dwWidth == devmode.dmPelsWidth, "Expected width %lu, got %lu.\n",
            devmode.dmPelsWidth, surface_desc.dwWidth);
    ok(surface_desc.dwHeight == devmode.dmPelsHeight, "Expected height %lu, got %lu.\n",
            devmode.dmPelsHeight, surface_desc.dwHeight);
    ok(surface_desc.dwRefreshRate == devmode.dmDisplayFrequency, "Expected frequency %lu, got %lu.\n",
            devmode.dmDisplayFrequency, surface_desc.dwRefreshRate);
    ok(surface_desc.ddpfPixelFormat.dwSize == sizeof(surface_desc.ddpfPixelFormat),
            "Got ddpfPixelFormat.dwSize %lu.\n", surface_desc.ddpfPixelFormat.dwSize);
    ok(surface_desc.ddpfPixelFormat.dwRGBBitCount == devmode.dmBitsPerPel,
            "Expected ddpfPixelFormat.dwRGBBitCount %lu, got %lu.\n", devmode.dmBitsPerPel,
            surface_desc.ddpfPixelFormat.dwRGBBitCount);
    ok(surface_desc.lPitch == devmode.dmPelsWidth * devmode.dmBitsPerPel / 8,
            "Expected pitch %lu, got %lu.\n", devmode.dmPelsWidth * devmode.dmBitsPerPel / 8,
            surface_desc.lPitch);

    memset(&param, 0, sizeof(param));
    param.old_frequency = surface_desc.dwRefreshRate;
    hr = IDirectDraw2_EnumDisplayModes(ddraw, DDEDM_REFRESHRATES, NULL, &param,
            find_different_mode_callback);
    ok(hr == DD_OK, "EnumDisplayModes failed, hr %#lx.\n", hr);
    if (!param.new_frequency)
    {
        skip("Failed to find a display mode with a different frequency.\n");
        goto done;
    }

    hr = IDirectDraw2_SetDisplayMode(ddraw, param.new_width, param.new_height, param.new_bpp,
            param.new_frequency, 0);
    ok(hr == DD_OK, "SetDisplayMode failed, hr %#lx.\n", hr);
    hr = IDirectDraw2_GetDisplayMode(ddraw, &surface_desc);
    ok(hr == DD_OK, "GetDisplayMode failed, hr %#lx.\n", hr);
    ok(surface_desc.dwWidth == param.new_width, "Expected width %u, got %lu.\n", param.new_width,
            surface_desc.dwWidth);
    ok(surface_desc.dwHeight == param.new_height, "Expected height %u, got %lu.\n", param.new_height,
            surface_desc.dwHeight);
    ok(surface_desc.dwRefreshRate == param.new_frequency, "Expected frequency %u, got %lu.\n",
            param.new_frequency, surface_desc.dwRefreshRate);
    ok(surface_desc.ddpfPixelFormat.dwRGBBitCount == param.new_bpp,
            "Expected ddpfPixelFormat.dwRGBBitCount %lu, got %lu.\n", devmode.dmBitsPerPel,
            surface_desc.ddpfPixelFormat.dwRGBBitCount);

done:
    DestroyWindow(window);
    IDirectDraw2_Release(ddraw);
}

static void test_texture_wrong_caps(const GUID *device_guid)
{
    static D3DLVERTEX quad[] =
    {
        {{-1.0f}, {-1.0f}, {0.0f}, 0, {0xffffffff}, {0}, {0.0f}, {1.0f}},
        {{-1.0f}, { 1.0f}, {0.0f}, 0, {0xffffffff}, {0}, {0.0f}, {0.0f}},
        {{ 1.0f}, {-1.0f}, {0.0f}, 0, {0xffffffff}, {0}, {1.0f}, {1.0f}},
        {{ 1.0f}, { 1.0f}, {0.0f}, 0, {0xffffffff}, {0}, {1.0f}, {0.0f}},
    };
    static DDPIXELFORMAT fmt =
    {
        sizeof(DDPIXELFORMAT), DDPF_RGB | DDPF_ALPHAPIXELS, 0,
                {32}, {0x00ff0000}, {0x0000ff00}, {0x000000ff}, {0xff000000}
    };
    D3DRECT clear_rect = {{0}, {0}, {640}, {480}};
    D3DTEXTUREHANDLE texture_handle, ret_handle;
    unsigned int color, expected_color;
    IDirectDrawSurface *surface, *rt;
    IDirect3DMaterial2 *background;
    IDirect3DViewport2 *viewport;
    IDirect3DTexture2 *texture;
    IDirect3DDevice2 *device;
    IDirectDraw2 *ddraw;
    DDSURFACEDESC ddsd;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    if (!(device = create_device_ex(ddraw, window, DDSCL_NORMAL, device_guid, NULL)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        DestroyWindow(window);
        return;
    }
    hr = IDirect3DDevice2_GetRenderTarget(device, &rt);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    viewport = create_viewport(device, 0, 0, 640, 480);
    hr = IDirect3DDevice2_SetCurrentViewport(device, viewport);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    memset(&ddsd, 0, sizeof(ddsd));
    ddsd.dwSize = sizeof(ddsd);
    ddsd.dwFlags = DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PIXELFORMAT;
    ddsd.dwHeight = 16;
    ddsd.dwWidth = 16;
    ddsd.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN;
    ddsd.ddpfPixelFormat = fmt;
    hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &surface, NULL);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_QueryInterface(surface, &IID_IDirect3DTexture2, (void **)&texture);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DTexture2_GetHandle(texture, device, &texture_handle);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    fill_surface(surface, 0xff00ff00);

    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_ZENABLE, D3DZB_FALSE);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_LIGHTING, FALSE);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_TEXTUREHANDLE, texture_handle);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_GetRenderState(device, D3DRENDERSTATE_TEXTUREHANDLE, &ret_handle);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    todo_wine_if (!is_software_device_type(device_guid))
        ok(ret_handle == texture_handle, "Got handle %#lx.\n", ret_handle);

    background = create_diffuse_material(device, 1.0f, 0.0f, 0.0f, 1.0f);
    viewport_set_background(device, viewport, background);

    hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    if (is_software_device_type(device_guid))
        fill_surface(rt, 0xffff0000);

    hr = IDirect3DDevice2_BeginScene(device);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, D3DVT_LVERTEX, quad, ARRAY_SIZE(quad), 0);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_EndScene(device);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    expected_color = is_software_device_type(device_guid) ? 0x0000ff00 : 0x00ffffff;
    color = get_surface_color(rt, 320, 240);
    ok(compare_color(color, expected_color, 1), "Got color 0x%08x, expected 0x%08x.\n", color, expected_color);

    IDirect3DTexture2_Release(texture);
    IDirectDrawSurface_Release(surface);
    IDirectDrawSurface_Release(rt);
    destroy_viewport(device, viewport);
    destroy_material(background);
    refcount = IDirect3DDevice2_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirectDraw2_Release(ddraw);
    DestroyWindow(window);
}

static void test_filling_convention(void)
{
    IDirectDrawSurface *rt, *backbuffer, *cur, *ds;
    static const DWORD colour_bottom = 0x00ffff00;
    static const DWORD colour_clear = 0x000000ff;
    static const DWORD colour_right = 0x00000000;
    static const DWORD colour_left = 0x00ff0000;
    static const DWORD colour_top = 0x0000ff00;
    unsigned int colour, expected, i, j, x, y;
    IDirect3DMaterial2 *background;
    IDirect3DViewport2 *viewport;
    IDirect3DDevice2 *device;
    IDirectDraw2 *ddraw;
    DDSURFACEDESC desc;
    IDirect3D2 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;
    BOOL todo;

    static const unsigned int vp_size = 8;
    D3DRECT clear_rect = {{0}, {0}, {vp_size}, {vp_size}};

    /* This test data follows the examples in MSDN's
     * "Rasterization Rules (Direct3D 9)" article.
     *
     * See the d3d9 test for a comment about the eps value. */
    static const float eps = 1.0f / 64.0f;
    D3DLVERTEX center_tris[] =
    {
        /* left */
        {{-2.5f / 4.0f}, {-1.5f / 4.0f}, {0.0f}, 0, {colour_left}},
        {{-2.5f / 4.0f}, { 2.5f / 4.0f}, {0.0f}, 0, {colour_left}},
        {{-1.5f / 4.0f}, { 0.5f / 4.0f}, {0.0f}, 0, {colour_left}},

        /* top */
        {{-1.5f / 4.0f}, { 0.5f / 4.0f}, {0.0f}, 0, {colour_top}},
        {{-2.5f / 4.0f}, { 2.5f / 4.0f}, {0.0f}, 0, {colour_top}},
        {{-0.5f / 4.0f}, { 2.5f / 4.0f}, {0.0f}, 0, {colour_top}},

        /* right */
        {{-0.5f / 4.0f}, {-1.5f / 4.0f}, {0.0f}, 0, {colour_right}},
        {{-1.5f / 4.0f}, { 0.5f / 4.0f}, {0.0f}, 0, {colour_right}},
        {{-0.5f / 4.0f}, { 2.5f / 4.0f}, {0.0f}, 0, {colour_right}},

        /* bottom */
        {{-2.5f / 4.0f}, {-1.5f / 4.0f}, {0.0f}, 0, {colour_bottom}},
        {{-1.5f / 4.0f}, { 0.5f / 4.0f}, {0.0f}, 0, {colour_bottom}},
        {{-0.5f / 4.0f}, {-1.5f / 4.0f}, {0.0f}, 0, {colour_bottom}},
    },
    edge_tris[] =
    {
        /* left */
        {{-2.0f / 4.0f}, {-1.0f / 4.0f}, {0.0f}, 0, {colour_left}},
        {{-2.0f / 4.0f}, { 3.0f / 4.0f}, {0.0f}, 0, {colour_left}},
        {{-1.0f / 4.0f}, { 1.0f / 4.0f}, {0.0f}, 0, {colour_left}},

        /* top */
        {{-1.0f / 4.0f}, { 1.0f / 4.0f}, {0.0f}, 0, {colour_top}},
        {{-2.0f / 4.0f}, { 3.0f / 4.0f}, {0.0f}, 0, {colour_top}},
        {{ 0.0f / 4.0f}, { 3.0f / 4.0f}, {0.0f}, 0, {colour_top}},

        /* right */
        {{ 0.0f / 4.0f}, {-1.0f / 4.0f}, {0.0f}, 0, {colour_right}},
        {{-1.0f / 4.0f}, { 1.0f / 4.0f}, {0.0f}, 0, {colour_right}},
        {{ 0.0f / 4.0f}, { 3.0f / 4.0f}, {0.0f}, 0, {colour_right}},

        /* bottom */
        {{-2.0f / 4.0f}, {-1.0f / 4.0f}, {0.0f}, 0, {colour_bottom}},
        {{-1.0f / 4.0f}, { 1.0f / 4.0f}, {0.0f}, 0, {colour_bottom}},
        {{ 0.0f / 4.0f}, {-1.0f / 4.0f}, {0.0f}, 0, {colour_bottom}},
    },
    nudge_right_tris[] =
    {
        /* left */
        {{eps - 2.0f / 4.0f}, {-1.0f / 4.0f}, {0.0f}, 0, {colour_left}},
        {{eps - 2.0f / 4.0f}, { 3.0f / 4.0f}, {0.0f}, 0, {colour_left}},
        {{eps - 1.0f / 4.0f}, { 1.0f / 4.0f}, {0.0f}, 0, {colour_left}},

        /* top */
        {{eps - 1.0f / 4.0f}, { 1.0f / 4.0f}, {0.0f}, 0, {colour_top}},
        {{eps - 2.0f / 4.0f}, { 3.0f / 4.0f}, {0.0f}, 0, {colour_top}},
        {{eps - 0.0f / 4.0f}, { 3.0f / 4.0f}, {0.0f}, 0, {colour_top}},

        /* right */
        {{eps - 0.0f / 4.0f}, {-1.0f / 4.0f}, {0.0f}, 0, {colour_right}},
        {{eps - 1.0f / 4.0f}, { 1.0f / 4.0f}, {0.0f}, 0, {colour_right}},
        {{eps - 0.0f / 4.0f}, { 3.0f / 4.0f}, {0.0f}, 0, {colour_right}},

        /* bottom */
        {{eps - 2.0f / 4.0f}, {-1.0f / 4.0f}, {0.0f}, 0, {colour_bottom}},
        {{eps - 1.0f / 4.0f}, { 1.0f / 4.0f}, {0.0f}, 0, {colour_bottom}},
        {{eps - 0.0f / 4.0f}, {-1.0f / 4.0f}, {0.0f}, 0, {colour_bottom}},
    },
    nudge_left_tris[] =
    {
        {{-eps - 2.0f / 4.0f}, {-1.0f / 4.0f}, {0.0f}, 0, {colour_left}},
        {{-eps - 2.0f / 4.0f}, { 3.0f / 4.0f}, {0.0f}, 0, {colour_left}},
        {{-eps - 1.0f / 4.0f}, { 1.0f / 4.0f}, {0.0f}, 0, {colour_left}},

        /* top */
        {{-eps - 1.0f / 4.0f}, { 1.0f / 4.0f}, {0.0f}, 0, {colour_top}},
        {{-eps - 2.0f / 4.0f}, { 3.0f / 4.0f}, {0.0f}, 0, {colour_top}},
        {{-eps - 0.0f / 4.0f}, { 3.0f / 4.0f}, {0.0f}, 0, {colour_top}},

        /* right */
        {{-eps - 0.0f / 4.0f}, {-1.0f / 4.0f}, {0.0f}, 0, {colour_right}},
        {{-eps - 1.0f / 4.0f}, { 1.0f / 4.0f}, {0.0f}, 0, {colour_right}},
        {{-eps - 0.0f / 4.0f}, { 3.0f / 4.0f}, {0.0f}, 0, {colour_right}},

        /* bottom */
        {{-eps - 2.0f / 4.0f}, {-1.0f / 4.0f}, {0.0f}, 0, {colour_bottom}},
        {{-eps - 1.0f / 4.0f}, { 1.0f / 4.0f}, {0.0f}, 0, {colour_bottom}},
        {{-eps - 0.0f / 4.0f}, {-1.0f / 4.0f}, {0.0f}, 0, {colour_bottom}},
    },
    nudge_top_tris[] =
    {
        /* left */
        {{-2.0f / 4.0f}, {eps - 1.0f / 4.0f}, {0.0f}, 0, {colour_left}},
        {{-2.0f / 4.0f}, {eps + 3.0f / 4.0f}, {0.0f}, 0, {colour_left}},
        {{-1.0f / 4.0f}, {eps + 1.0f / 4.0f}, {0.0f}, 0, {colour_left}},

        /* top */
        {{-1.0f / 4.0f}, {eps + 1.0f / 4.0f}, {0.0f}, 0, {colour_top}},
        {{-2.0f / 4.0f}, {eps + 3.0f / 4.0f}, {0.0f}, 0, {colour_top}},
        {{ 0.0f / 4.0f}, {eps + 3.0f / 4.0f}, {0.0f}, 0, {colour_top}},

        /* right */
        {{ 0.0f / 4.0f}, {eps - 1.0f / 4.0f}, {0.0f}, 0, {colour_right}},
        {{-1.0f / 4.0f}, {eps + 1.0f / 4.0f}, {0.0f}, 0, {colour_right}},
        {{ 0.0f / 4.0f}, {eps + 3.0f / 4.0f}, {0.0f}, 0, {colour_right}},

        /* bottom */
        {{-2.0f / 4.0f}, {eps - 1.0f / 4.0f}, {0.0f}, 0, {colour_bottom}},
        {{-1.0f / 4.0f}, {eps + 1.0f / 4.0f}, {0.0f}, 0, {colour_bottom}},
        {{ 0.0f / 4.0f}, {eps - 1.0f / 4.0f}, {0.0f}, 0, {colour_bottom}},
    },
    nudge_bottom_tris[] =
    {
        /* left */
        {{-2.0f / 4.0f}, {-eps - 1.0f / 4.0f}, {0.0f}, 0, {colour_left}},
        {{-2.0f / 4.0f}, {-eps + 3.0f / 4.0f}, {0.0f}, 0, {colour_left}},
        {{-1.0f / 4.0f}, {-eps + 1.0f / 4.0f}, {0.0f}, 0, {colour_left}},

        /* top */
        {{-1.0f / 4.0f}, {-eps + 1.0f / 4.0f}, {0.0f}, 0, {colour_top}},
        {{-2.0f / 4.0f}, {-eps + 3.0f / 4.0f}, {0.0f}, 0, {colour_top}},
        {{ 0.0f / 4.0f}, {-eps + 3.0f / 4.0f}, {0.0f}, 0, {colour_top}},

        /* right */
        {{ 0.0f / 4.0f}, {-eps - 1.0f / 4.0f}, {0.0f}, 0, {colour_right}},
        {{-1.0f / 4.0f}, {-eps + 1.0f / 4.0f}, {0.0f}, 0, {colour_right}},
        {{ 0.0f / 4.0f}, {-eps + 3.0f / 4.0f}, {0.0f}, 0, {colour_right}},

        /* bottom */
        {{-2.0f / 4.0f}, {-eps - 1.0f / 4.0f}, {0.0f}, 0, {colour_bottom}},
        {{-1.0f / 4.0f}, {-eps + 1.0f / 4.0f}, {0.0f}, 0, {colour_bottom}},
        {{ 0.0f / 4.0f}, {-eps - 1.0f / 4.0f}, {0.0f}, 0, {colour_bottom}},
    };

    D3DTLVERTEX center_tris_t[] =
    {
        /* left */
        {{1.5f}, {1.5f}, {0.0f}, {1.0f}, {colour_left}},
        {{2.5f}, {3.5f}, {0.0f}, {1.0f}, {colour_left}},
        {{1.5f}, {5.5f}, {0.0f}, {1.0f}, {colour_left}},

        /* top */
        {{1.5f}, {1.5f}, {0.0f}, {1.0f}, {colour_top}},
        {{3.5f}, {1.5f}, {0.0f}, {1.0f}, {colour_top}},
        {{2.5f}, {3.5f}, {0.0f}, {1.0f}, {colour_top}},

        /* right */
        {{3.5f}, {1.5f}, {0.0f}, {1.0f}, {colour_right}},
        {{3.5f}, {5.5f}, {0.0f}, {1.0f}, {colour_right}},
        {{2.5f}, {3.5f}, {0.0f}, {1.0f}, {colour_right}},

        /* bottom */
        {{2.5f}, {3.5f}, {0.0f}, {1.0f}, {colour_bottom}},
        {{3.5f}, {5.5f}, {0.0f}, {1.0f}, {colour_bottom}},
        {{1.5f}, {5.5f}, {0.0f}, {1.0f}, {colour_bottom}},
    },
    edge_tris_t[] =
    {
        /* left */
        {{2.0f}, {1.0f}, {0.0f}, {1.0f}, {colour_left}},
        {{3.0f}, {3.0f}, {0.0f}, {1.0f}, {colour_left}},
        {{2.0f}, {5.0f}, {0.0f}, {1.0f}, {colour_left}},

        /* top */
        {{2.0f}, {1.0f}, {0.0f}, {1.0f}, {colour_top}},
        {{4.0f}, {1.0f}, {0.0f}, {1.0f}, {colour_top}},
        {{3.0f}, {3.0f}, {0.0f}, {1.0f}, {colour_top}},

        /* right */
        {{4.0f}, {1.0f}, {0.0f}, {1.0f}, {colour_right}},
        {{4.0f}, {5.0f}, {0.0f}, {1.0f}, {colour_right}},
        {{3.0f}, {3.0f}, {0.0f}, {1.0f}, {colour_right}},

        /* bottom */
        {{3.0f}, {3.0f}, {0.0f}, {1.0f}, {colour_bottom}},
        {{4.0f}, {5.0f}, {0.0f}, {1.0f}, {colour_bottom}},
        {{2.0f}, {5.0f}, {0.0f}, {1.0f}, {colour_bottom}},
    };

    const struct
    {
        void *geometry;
        DWORD fvf;
        const char *expected[8];
    }
    tests[] =
    {
        {
            center_tris,
            D3DVT_LVERTEX,
            {
                "        ",
                "        ",
                "  TT    ",
                "  LR    ",
                "  LR    ",
                "  BB    ",
                "        ",
                "        "
            }
        },
        {
            edge_tris,
            D3DVT_LVERTEX,
            {
                "        ",
                "  TT    ",
                "  LT    ",
                "  LR    ",
                "  LB    ",
                "        ",
                "        ",
                "        "
            }
        },
        {
            nudge_right_tris,
            D3DVT_LVERTEX,
            {
                "        ",
                "   TT   ",
                "   TR   ",
                "   LR   ",
                "   BR   ",
                "        ",
                "        ",
                "        "
            }
        },
        {
            nudge_left_tris,
            D3DVT_LVERTEX,
            {
                "        ",
                "  TT    ",
                "  LT    ",
                "  LR    ",
                "  LB    ",
                "        ",
                "        ",
                "        "
            }
        },
        {
            nudge_top_tris,
            D3DVT_LVERTEX,
            {
                "        ",
                "  LT    ",
                "  LT    ",
                "  LB    ",
                "  LB    ",
                "        ",
                "        ",
                "        "
            }
        },
        {
            nudge_bottom_tris,
            D3DVT_LVERTEX,
            {
                "        ",
                "        ",
                "  LT    ",
                "  Lt    ",
                "  LB    ",
                "  lB    ",
                "        ",
                "        "
            }
        },
        {
            center_tris_t,
            D3DVT_TLVERTEX,
            {
                "        ",
                "        ",
                "  TT    ",
                "  LR    ",
                "  LR    ",
                "  BB    ",
                "        ",
                "        "
            }
        },
        {
            edge_tris_t,
            D3DVT_TLVERTEX,
            {
                "        ",
                "  TT    ",
                "  LT    ",
                "  LR    ",
                "  LB    ",
                "        ",
                "        ",
                "        "
            }
        },
    };

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");
    if (!(device = create_device(ddraw, window, DDSCL_NORMAL)))
    {
        skip("Failed to create a 3D device.\n");
        IDirectDraw2_Release(ddraw);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice2_GetDirect3D(device, &d3d);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_GetRenderTarget(device, &backbuffer);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

    viewport = create_viewport(device, 0, 0, vp_size, vp_size);
    background = create_diffuse_material(device, 0.0f, 0.0f, 1.0f, 1.0f);
    viewport_set_background(device, viewport, background);
    hr = IDirect3DDevice2_SetCurrentViewport(device, viewport);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    memset(&desc, 0, sizeof(desc));
    desc.dwSize = sizeof(desc);
    desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT;
    desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN | DDSCAPS_3DDEVICE;
    desc.dwWidth = vp_size;
    desc.dwHeight = vp_size;
    desc.ddpfPixelFormat.dwSize = sizeof(desc.ddpfPixelFormat);
    desc.ddpfPixelFormat.dwFlags = DDPF_RGB;
    desc.ddpfPixelFormat.dwRGBBitCount = 32;
    desc.ddpfPixelFormat.dwRBitMask = 0x00ff0000;
    desc.ddpfPixelFormat.dwGBitMask = 0x0000ff00;
    desc.ddpfPixelFormat.dwBBitMask = 0x000000ff;
    hr = IDirectDraw2_CreateSurface(ddraw, &desc, &rt, NULL);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    /* Nvidia on Windows 10 refuses to set the offscreen RT
     * if it does not have an attached depth stencil. */
    ds = get_depth_stencil(device);
    memset(&desc, 0, sizeof(desc));
    desc.dwSize = sizeof(desc);
    desc.ddpfPixelFormat.dwSize = sizeof(desc.ddpfPixelFormat);
    hr = IDirectDrawSurface_GetPixelFormat(ds, &desc.ddpfPixelFormat);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    IDirectDrawSurface4_Release(ds);

    desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT;
    desc.ddsCaps.dwCaps = DDSCAPS_ZBUFFER;
    desc.dwWidth = vp_size;
    desc.dwHeight = vp_size;
    hr = IDirectDraw2_CreateSurface(ddraw, &desc, &ds, NULL);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirectDrawSurface_AddAttachedSurface(rt, ds);
    ok(SUCCEEDED(hr), "Failed to attach depth buffer, hr %#lx.\n", hr);

    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_LIGHTING, FALSE);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_ZENABLE, D3DZB_FALSE);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    for (i = 0; i < ARRAY_SIZE(tests); ++i)
    {
        for (j = 0; j < 2; ++j)
        {
            cur = j ? rt : backbuffer;

            hr = IDirect3DDevice2_SetRenderTarget(device, cur, 0);
            ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
            hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET);
            ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

            hr = IDirect3DDevice2_BeginScene(device);
            ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
            hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLELIST,
                    tests[i].fvf, tests[i].geometry, 12, 0);
            ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
            hr = IDirect3DDevice2_EndScene(device);
            ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

            for (y = 0; y < 8; y++)
            {
                for (x = 0; x < 8; x++)
                {
                    todo = FALSE;
                    switch (tests[i].expected[y][x])
                    {
                        case 'l': todo = TRUE;
                        case 'L':
                            expected = colour_left;
                            break;
                        case 't': todo = TRUE;
                        case 'T':
                            expected = colour_top;
                            break;
                        case 'r': todo = TRUE;
                        case 'R':
                            expected = colour_right;
                            break;
                        case 'b': todo = TRUE;
                        case 'B':
                            expected = colour_bottom;
                            break;
                        case ' ':
                            expected = colour_clear;
                            break;
                        default:
                            ok(0, "Unexpected entry in expected test char\n");
                            expected = 0xdeadbeef;
                    }
                    colour = get_surface_color(cur, x, y);
                    /* The nudge-to-bottom test fails on cards that give us a bottom-left
                     * filling convention. The cause isn't the bottom part of the filling
                     * convention, but because wined3d will nudge geometry to the left to
                     * keep diagonals (the 'R' in test case 'edge_tris') intact. */
                    todo_wine_if(todo && !compare_color(colour, expected, 1))
                        ok(compare_color(colour, expected, 1), "Got unexpected colour %08x, %ux%u, case %u, j %u.\n",
                                colour, x, y, i, j);
                }
            }
        }
    }

    destroy_viewport(device, viewport);
    IDirectDrawSurface_Release(backbuffer);
    IDirectDrawSurface_Release(rt);
    IDirectDrawSurface_Release(ds);
    IDirect3D2_Release(d3d);
    refcount = IDirect3DDevice2_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    DestroyWindow(window);
}

static unsigned int enum_devices_index;

static HRESULT WINAPI test_enum_devices_caps_callback(GUID *guid, char *device_desc,
        char *device_name, D3DDEVICEDESC *hal, D3DDEVICEDESC *hel, void *ctx)
{
    static const D3DLIGHTINGCAPS empty_lighting_caps = {.dwSize = sizeof(D3DLIGHTINGCAPS)};
    static const D3DPRIMCAPS empty_primitive_caps = {.dwSize = sizeof(D3DPRIMCAPS)};
    IDirectDraw2 *ddraw = ctx;

    ok(hal->dwSize == offsetof(D3DDEVICEDESC, dwMaxTextureRepeat), "Got size %lu.\n", hal->dwSize);
    ok(hel->dwSize == offsetof(D3DDEVICEDESC, dwMaxTextureRepeat), "Got size %lu.\n", hel->dwSize);
    ok(hal->dtcTransformCaps.dwSize == sizeof(D3DTRANSFORMCAPS)
            || (ddraw_is_warp(ddraw) && !hal->dtcTransformCaps.dwSize),
            "Got transform caps size %lu.\n", hal->dtcTransformCaps.dwSize);
    ok(hel->dtcTransformCaps.dwSize == sizeof(D3DTRANSFORMCAPS),
            "Got transform caps size %lu.\n", hel->dtcTransformCaps.dwSize);
    ok(hal->dlcLightingCaps.dwSize == sizeof(D3DLIGHTINGCAPS)
            || (ddraw_is_warp(ddraw) && !hal->dlcLightingCaps.dwSize),
            "Got lighting caps size %lu.\n", hal->dlcLightingCaps.dwSize);
    ok(hel->dlcLightingCaps.dwSize == sizeof(D3DLIGHTINGCAPS),
            "Got lighting caps size %lu.\n", hel->dlcLightingCaps.dwSize);
    ok(hal->dpcLineCaps.dwSize == sizeof(D3DPRIMCAPS),
            "Got line caps size %lu.\n", hal->dpcLineCaps.dwSize);
    ok(hel->dpcLineCaps.dwSize == sizeof(D3DPRIMCAPS),
            "Got line caps size %lu.\n", hel->dpcLineCaps.dwSize);
    ok(hal->dpcTriCaps.dwSize == sizeof(D3DPRIMCAPS),
            "Got triangle caps size %lu.\n", hal->dpcTriCaps.dwSize);
    ok(hel->dpcTriCaps.dwSize == sizeof(D3DPRIMCAPS),
            "Got triangle caps size %lu.\n", hel->dpcTriCaps.dwSize);

    if (!IsEqualGUID(guid, &IID_IDirect3DHALDevice))
    {
        ok(!hal->dwFlags, "Got HAL flags %#lx.\n", hal->dwFlags);
        ok(!hal->dcmColorModel, "Got color model %#lx.\n", hal->dcmColorModel);
        todo_wine ok(!hal->dwDevCaps, "Got device caps %#lx.\n", hal->dwDevCaps);
        todo_wine ok(!hal->dtcTransformCaps.dwCaps, "Got transform caps %#lx.\n", hal->dtcTransformCaps.dwCaps);
        todo_wine ok(!hal->bClipping, "Got clipping %#x.\n", hal->bClipping);
        todo_wine ok(!memcmp(&hal->dlcLightingCaps, &empty_lighting_caps, sizeof(D3DLIGHTINGCAPS)),
                "Lighting caps didn't match.\n");
        todo_wine ok(!memcmp(&hal->dpcLineCaps, &empty_primitive_caps, sizeof(D3DPRIMCAPS)), "Line caps didn't match.\n");
        todo_wine ok(!memcmp(&hal->dpcTriCaps, &empty_primitive_caps, sizeof(D3DPRIMCAPS)), "Triangle caps didn't match.\n");
        todo_wine ok(!hal->dwDeviceRenderBitDepth, "Got colour depth %#lx.\n", hal->dwDeviceRenderBitDepth);
        todo_wine ok(!hal->dwDeviceZBufferBitDepth, "Got Z depth %#lx.\n", hal->dwDeviceZBufferBitDepth);
        ok(!hal->dwMaxBufferSize, "Got max buffer size %lu.\n", hal->dwMaxBufferSize);
        todo_wine ok(!hal->dwMaxVertexCount, "Got max vertex count %lu.\n", hal->dwMaxVertexCount);
        todo_wine ok(!hal->dwMinTextureWidth, "Got min texture width %lu.\n", hal->dwMinTextureWidth);
        todo_wine ok(!hal->dwMinTextureHeight, "Got min texture height %lu.\n", hal->dwMinTextureHeight);
        todo_wine ok(!hal->dwMaxTextureWidth, "Got max texture width %lu.\n", hal->dwMaxTextureWidth);
        todo_wine ok(!hal->dwMaxTextureHeight, "Got max texture height %lu.\n", hal->dwMaxTextureHeight);
        todo_wine ok(!hal->dwMinStippleWidth, "Got min stipple width %lu.\n", hal->dwMinStippleWidth);
        todo_wine ok(!hal->dwMinStippleHeight, "Got min stipple height %lu.\n", hal->dwMinStippleHeight);
        todo_wine ok(!hal->dwMaxStippleWidth, "Got max stipple width %lu.\n", hal->dwMaxStippleWidth);
        todo_wine ok(!hal->dwMaxStippleHeight, "Got max stipple height %lu.\n", hal->dwMaxStippleHeight);
    }

    if(IsEqualGUID(&IID_IDirect3DRGBDevice, guid))
    {
        static const DWORD hel_flags = D3DDD_COLORMODEL
                | D3DDD_DEVCAPS
                | D3DDD_TRANSFORMCAPS
                | D3DDD_LIGHTINGCAPS
                | D3DDD_BCLIPPING
                | D3DDD_TRICAPS
                | D3DDD_DEVICERENDERBITDEPTH
                | D3DDD_DEVICEZBUFFERBITDEPTH
                | D3DDD_MAXBUFFERSIZE
                | D3DDD_MAXVERTEXCOUNT;

        static const DWORD device_caps = D3DDEVCAPS_FLOATTLVERTEX
                | D3DDEVCAPS_SORTINCREASINGZ
                | D3DDEVCAPS_SORTEXACT
                | D3DDEVCAPS_EXECUTESYSTEMMEMORY
                | D3DDEVCAPS_TLVERTEXSYSTEMMEMORY
                | D3DDEVCAPS_TEXTURESYSTEMMEMORY
                | D3DDEVCAPS_DRAWPRIMTLVERTEX;

        ok(enum_devices_index == 1, "Expected index %u.\n", enum_devices_index);
        ok(!strcmp(device_name, "RGB Emulation"), "Got name %s.\n", debugstr_a(device_name));

        todo_wine ok(hel->dwFlags == hel_flags, "Got HEL flags %#lx.\n", hel->dwFlags);
        ok(hel->dcmColorModel == D3DCOLOR_RGB, "Got color model %#lx.\n", hel->dcmColorModel);
        todo_wine ok(hel->dwDevCaps == device_caps, "Got device caps %#lx.\n", hel->dwDevCaps);

        ok(hel->dpcLineCaps.dwTextureCaps & D3DPTEXTURECAPS_POW2,
           "RGB Device hel line caps does not have D3DPTEXTURECAPS_POW2 flag set\n");
        ok(hel->dpcTriCaps.dwTextureCaps & D3DPTEXTURECAPS_POW2,
           "RGB Device hel tri caps does not have D3DPTEXTURECAPS_POW2 flag set\n");

        ok(hel->dpcLineCaps.dwTextureCaps & D3DPTEXTURECAPS_PERSPECTIVE,
           "RGB Device hel tri caps does not have D3DPTEXTURECAPS_PERSPECTIVE set\n");
        ok(hel->dpcTriCaps.dwTextureCaps & D3DPTEXTURECAPS_PERSPECTIVE,
           "RGB Device hel tri caps does not have D3DPTEXTURECAPS_PERSPECTIVE set\n");

        ok((hel->dwDevCaps & D3DDEVCAPS_HWTRANSFORMANDLIGHT) == 0,
           "RGB Device hel device caps has D3DDEVCAPS_HWTRANSFORMANDLIGHT set\n");
        ok((hel->dwDevCaps & D3DDEVCAPS_DRAWPRIMITIVES2EX) == 0,
           "RGB Device hel device caps has D3DDEVCAPS_DRAWPRIMITIVES2EX set\n");
        ok((hel->dwDevCaps & D3DDEVCAPS_HWRASTERIZATION) == 0,
           "RGB Device hel device caps has D3DDEVCAPS_HWRASTERIZATION set\n");
    }
    else if(IsEqualGUID(&IID_IDirect3DHALDevice, guid))
    {
        static const DWORD hel_flags = D3DDD_COLORMODEL
                | D3DDD_DEVCAPS
                | D3DDD_TRANSFORMCAPS
                | D3DDD_LIGHTINGCAPS
                | D3DDD_BCLIPPING;

        ok(enum_devices_index == 2, "Expected index %u.\n", enum_devices_index);
        ok(!strcmp(device_name, "Direct3D HAL"), "Got name %s.\n", debugstr_a(device_name));

        ok(hal->dcmColorModel == D3DCOLOR_RGB, "HAL Device hal caps has colormodel %lu\n", hel->dcmColorModel);

        ok(hal->dwFlags != 0, "HAL Device hal caps has hardware flags %#lx\n", hal->dwFlags);

        ok(hal->dwDevCaps & D3DDEVCAPS_DRAWPRIMITIVES2EX,
           "HAL Device hal device caps does not have D3DDEVCAPS_DRAWPRIMITIVES2EX set\n");

        todo_wine ok(hel->dwFlags == hel_flags, "Got HEL flags %#lx.\n", hel->dwFlags);
        ok(!hel->dcmColorModel, "Got color model %#lx.\n", hel->dcmColorModel);
        todo_wine ok(hel->dwDevCaps == D3DDEVCAPS_FLOATTLVERTEX, "Got device caps %#lx.\n", hel->dwDevCaps);
        ok(hel->dtcTransformCaps.dwCaps == D3DTRANSFORMCAPS_CLIP,
                "Got transform caps %#lx.\n", hel->dtcTransformCaps.dwCaps);
        ok(hel->bClipping == TRUE, "Got clipping %#x.\n", hel->bClipping);
        ok(hel->dlcLightingCaps.dwCaps == (D3DLIGHTCAPS_POINT | D3DLIGHTCAPS_SPOT
                | D3DLIGHTCAPS_DIRECTIONAL | D3DLIGHTCAPS_PARALLELPOINT),
                "Got lighting caps %#lx.\n", hel->dlcLightingCaps.dwCaps);
        ok(hel->dlcLightingCaps.dwLightingModel == D3DLIGHTINGMODEL_RGB,
                "Got lighting model %#lx.\n", hel->dlcLightingCaps.dwLightingModel);
        todo_wine ok(!hel->dlcLightingCaps.dwNumLights,
                "Got light count %lu.\n", hel->dlcLightingCaps.dwNumLights);
        todo_wine ok(!memcmp(&hel->dpcLineCaps, &empty_primitive_caps, sizeof(D3DPRIMCAPS)), "Line caps didn't match.\n");
        todo_wine ok(!memcmp(&hel->dpcTriCaps, &empty_primitive_caps, sizeof(D3DPRIMCAPS)), "Triangle caps didn't match.\n");
        todo_wine ok(!hel->dwDeviceRenderBitDepth, "Got colour depth %#lx.\n", hel->dwDeviceRenderBitDepth);
        todo_wine ok(!hel->dwDeviceZBufferBitDepth, "Got Z depth %#lx.\n", hel->dwDeviceZBufferBitDepth);
        ok(!hel->dwMaxBufferSize, "Got max buffer size %lu.\n", hel->dwMaxBufferSize);
        ok(hel->dwMaxVertexCount == hal->dwMaxVertexCount, "Got HAL max vertex count %lu, HEL %lu.\n",
                hal->dwMaxVertexCount, hel->dwMaxVertexCount);
        todo_wine ok(!hel->dwMinTextureWidth, "Got min texture width %lu.\n", hel->dwMinTextureWidth);
        todo_wine ok(!hel->dwMinTextureHeight, "Got min texture height %lu.\n", hel->dwMinTextureHeight);
        todo_wine ok(!hel->dwMaxTextureWidth, "Got max texture width %lu.\n", hel->dwMaxTextureWidth);
        todo_wine ok(!hel->dwMaxTextureHeight, "Got max texture height %lu.\n", hel->dwMaxTextureHeight);
        todo_wine ok(!hel->dwMinStippleWidth, "Got min stipple width %lu.\n", hel->dwMinStippleWidth);
        todo_wine ok(!hel->dwMinStippleHeight, "Got min stipple height %lu.\n", hel->dwMinStippleHeight);
        todo_wine ok(!hel->dwMaxStippleWidth, "Got max stipple width %lu.\n", hel->dwMaxStippleWidth);
        todo_wine ok(!hel->dwMaxStippleHeight, "Got max stipple height %lu.\n", hel->dwMaxStippleHeight);
    }
    else if(IsEqualGUID(&IID_IDirect3DRefDevice, guid))
    {
        ok(hel->dpcLineCaps.dwTextureCaps & D3DPTEXTURECAPS_POW2,
           "REF Device hel line caps does not have D3DPTEXTURECAPS_POW2 flag set\n");
        ok(hel->dpcTriCaps.dwTextureCaps & D3DPTEXTURECAPS_POW2,
           "REF Device hel tri caps does not have D3DPTEXTURECAPS_POW2 flag set\n");

        ok(hel->dpcLineCaps.dwTextureCaps & D3DPTEXTURECAPS_PERSPECTIVE,
           "REF Device hel tri caps does not have D3DPTEXTURECAPS_PERSPECTIVE set\n");
        ok(hel->dpcTriCaps.dwTextureCaps & D3DPTEXTURECAPS_PERSPECTIVE,
           "REF Device hel tri caps does not have D3DPTEXTURECAPS_PERSPECTIVE set\n");

        ok((hel->dwDevCaps & D3DDEVCAPS_HWTRANSFORMANDLIGHT) == 0,
           "REF Device hel device caps has D3DDEVCAPS_HWTRANSFORMANDLIGHT set\n");
        ok((hel->dwDevCaps & D3DDEVCAPS_DRAWPRIMITIVES2EX) == 0,
           "REF Device hel device caps has D3DDEVCAPS_DRAWPRIMITIVES2EX set\n");
    }
    else if(IsEqualGUID(&IID_IDirect3DRampDevice, guid))
    {
        ok(enum_devices_index == 0, "Expected index %u.\n", enum_devices_index);
        ok(!strcmp(device_name, "Ramp Emulation"), "Got name %s.\n", debugstr_a(device_name));

        ok(hel->dpcLineCaps.dwTextureCaps & D3DPTEXTURECAPS_POW2,
           "Ramp Device hel line caps does not have D3DPTEXTURECAPS_POW2 flag set\n");
        ok(hel->dpcTriCaps.dwTextureCaps & D3DPTEXTURECAPS_POW2,
           "Ramp Device hel tri caps does not have D3DPTEXTURECAPS_POW2 flag set\n");

        ok(hel->dpcLineCaps.dwTextureCaps & D3DPTEXTURECAPS_PERSPECTIVE,
           "Ramp Device hel tri caps does not have D3DPTEXTURECAPS_PERSPECTIVE set\n");
        ok(hel->dpcTriCaps.dwTextureCaps & D3DPTEXTURECAPS_PERSPECTIVE,
           "Ramp Device hel tri caps does not have D3DPTEXTURECAPS_PERSPECTIVE set\n");

        ok(hel->dcmColorModel == D3DCOLOR_MONO, "Ramp Device hel caps has colormodel %lu\n",
           hel->dcmColorModel);

        ok(hel->dwFlags != 0, "Ramp Device hel caps has hardware flags %#lx\n", hel->dwFlags);

        ok((hel->dwDevCaps & D3DDEVCAPS_HWTRANSFORMANDLIGHT) == 0,
           "Ramp Device hel device caps has D3DDEVCAPS_HWTRANSFORMANDLIGHT set\n");
        ok((hel->dwDevCaps & D3DDEVCAPS_DRAWPRIMITIVES2EX) == 0,
           "Ramp Device hel device caps has D3DDEVCAPS_DRAWPRIMITIVES2EX set\n");
    }
    else if(IsEqualGUID(&IID_IDirect3DMMXDevice, guid))
    {
        ok(enum_devices_index == 3, "Expected index %u.\n", enum_devices_index);
        ok(!strcmp(device_name, "MMX Emulation"), "Got name %s.\n", debugstr_a(device_name));

        ok(hel->dpcLineCaps.dwTextureCaps & D3DPTEXTURECAPS_POW2,
           "MMX Device hel line caps does not have D3DPTEXTURECAPS_POW2 flag set\n");
        ok(hel->dpcTriCaps.dwTextureCaps & D3DPTEXTURECAPS_POW2,
           "MMX Device hel tri caps does not have D3DPTEXTURECAPS_POW2 flag set\n");

        ok(hel->dpcLineCaps.dwTextureCaps & D3DPTEXTURECAPS_PERSPECTIVE,
           "MMX Device hel tri caps does not have D3DPTEXTURECAPS_PERSPECTIVE set\n");
        ok(hel->dpcTriCaps.dwTextureCaps & D3DPTEXTURECAPS_PERSPECTIVE,
           "MMX Device hel tri caps does not have D3DPTEXTURECAPS_PERSPECTIVE set\n");

        ok(hel->dcmColorModel == D3DCOLOR_RGB, "MMX Device hel caps has colormodel %lu\n", hel->dcmColorModel);

        ok(hel->dwFlags != 0, "MMX Device hel caps has hardware flags %#lx\n", hel->dwFlags);

        ok((hel->dwDevCaps & D3DDEVCAPS_HWTRANSFORMANDLIGHT) == 0,
           "MMX Device hel device caps has D3DDEVCAPS_HWTRANSFORMANDLIGHT set\n");
        ok((hel->dwDevCaps & D3DDEVCAPS_DRAWPRIMITIVES2EX) == 0,
           "MMX Device hel device caps has D3DDEVCAPS_DRAWPRIMITIVES2EX set\n");
    }
    else
    {
        ok(FALSE, "Unexpected device enumerated: \"%s\" \"%s\"\n", device_desc, device_name);
        if (hal->dpcLineCaps.dwTextureCaps & D3DPTEXTURECAPS_POW2)
            trace("hal line has pow2 set\n");
        else
            trace("hal line does NOT have pow2 set\n");
        if (hal->dpcTriCaps.dwTextureCaps & D3DPTEXTURECAPS_POW2)
            trace("hal tri has pow2 set\n");
        else
            trace("hal tri does NOT have pow2 set\n");
        if (hel->dpcLineCaps.dwTextureCaps & D3DPTEXTURECAPS_POW2)
            trace("hel line has pow2 set\n");
        else
            trace("hel line does NOT have pow2 set\n");
        if (hel->dpcTriCaps.dwTextureCaps & D3DPTEXTURECAPS_POW2)
            trace("hel tri has pow2 set\n");
        else
            trace("hel tri does NOT have pow2 set\n");
    }

    ++enum_devices_index;
    return DDENUMRET_OK;
}

static void test_enum_devices(void)
{
    IDirectDraw2 *ddraw;
    IDirect3D2 *d3d;
    ULONG refcount;
    HRESULT hr;

    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");

    hr = IDirectDraw2_QueryInterface(ddraw, &IID_IDirect3D2, (void **)&d3d);
    if (FAILED(hr))
    {
        skip("D3D interface is not available, skipping test.\n");
        IDirectDraw2_Release(ddraw);
        return;
    }

    hr = IDirect3D2_EnumDevices(d3d, NULL, NULL);
    ok(hr == DDERR_INVALIDPARAMS, "Got hr %#lx.\n", hr);

    hr = IDirect3D2_EnumDevices(d3d, test_enum_devices_caps_callback, ddraw);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    IDirect3D2_Release(d3d);
    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "Device has %lu references left.\n", refcount);
}

static void run_for_each_device_type(void (*test_func)(const GUID *))
{
    test_func(&IID_IDirect3DHALDevice);
    test_func(&IID_IDirect3DRGBDevice);
}

static void test_multiple_devices(void)
{
    D3DRECT clear_rect = {{0}, {0}, {640}, {480}};
    static D3DLVERTEX quad[] =
    {
        {{-1.0f}, {-1.0f}, {0.1f}, 0, {0x800000ff}},
        {{-1.0f}, { 1.0f}, {0.1f}, 0, {0x800000ff}},
        {{ 1.0f}, {-1.0f}, {0.1f}, 0, {0x800000ff}},
        {{ 1.0f}, { 1.0f}, {0.1f}, 0, {0x800000ff}},
    };

    D3DTEXTUREHANDLE texture_handle, texture_handle2, texture_handle3;
    IDirectDrawSurface *surface, *texture_surf, *texture_surf2;
    IDirect3DDevice2 *device, *device2, *device3;
    D3DMATERIALHANDLE mat_handle, mat_handle2;
    IDirect3DViewport2 *viewport, *viewport2;
    IDirect3DTexture2 *texture, *texture2;
    IDirectDraw2 *ddraw, *ddraw2;
    IDirect3DMaterial2 *material;
    DDSURFACEDESC surface_desc;
    IDirect3D2 *d3d;
    ULONG refcount;
    DWORD colour;
    DWORD value;
    HWND window;
    HRESULT hr;

    window = create_window();
    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");

    if (!(device = create_device_ex(ddraw, window, DDSCL_NORMAL, &IID_IDirect3DHALDevice, &surface)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice2_GetDirect3D(device, &d3d);
    ok(hr == D3D_OK, "got %#lx.\n", hr);
    hr = IDirect3D2_CreateDevice(d3d, &IID_IDirect3DHALDevice, surface, &device2);
    ok(hr == D3D_OK, "got %#lx.\n", hr);

    ddraw2 = create_ddraw();
    ok(!!ddraw2, "Failed to create a ddraw object.\n");
    device3 = create_device(ddraw2, window, DDSCL_NORMAL);
    ok(!!device3, "got NULL.\n");

    viewport = create_viewport(device, 0, 0, 640, 480);
    viewport2 = create_viewport(device2, 0, 0, 640, 480);
    hr = IDirect3DDevice2_SetCurrentViewport(device, viewport);
    ok(hr == D3D_OK, "got %#lx.\n", hr);
    hr = IDirect3DDevice2_SetCurrentViewport(device2, viewport);
    ok(hr == DDERR_INVALIDPARAMS, "got %#lx.\n", hr);
    hr = IDirect3DDevice2_SetCurrentViewport(device2, viewport2);
    ok(hr == D3D_OK, "got %#lx.\n", hr);

    material = create_diffuse_material(device, 1.0f, 0.0f, 0.0f, 1.0f);
    hr = IDirect3DMaterial2_GetHandle(material, device, &mat_handle);
    ok(hr == D3D_OK, "got %#lx.\n", hr);
    hr = IDirect3DMaterial2_GetHandle(material, device, &mat_handle2);
    ok(hr == D3D_OK, "got %#lx.\n", hr);
    ok(mat_handle == mat_handle2, "got different handles.\n");

    hr = IDirect3DMaterial2_GetHandle(material, device2, &mat_handle2);
    ok(hr == D3D_OK, "got %#lx.\n", hr);
    todo_wine ok(mat_handle != mat_handle2, "got same handles.\n");

    hr = IDirect3DDevice2_SetLightState(device, D3DLIGHTSTATE_MATERIAL, mat_handle);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetLightState(device2, D3DLIGHTSTATE_MATERIAL, mat_handle);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetLightState(device3, D3DLIGHTSTATE_MATERIAL, mat_handle);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetLightState(device, D3DLIGHTSTATE_MATERIAL, mat_handle2);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DViewport2_SetBackground(viewport, mat_handle);
    ok(hr == D3D_OK, "got %#lx.\n", hr);
    hr = IDirect3DViewport2_SetBackground(viewport2, mat_handle);
    ok(hr == D3D_OK, "got %#lx.\n", hr);

    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_ALPHABLENDENABLE, FALSE);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device2, D3DRENDERSTATE_ALPHABLENDENABLE, FALSE);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device3, D3DRENDERSTATE_ALPHABLENDENABLE, FALSE);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_ALPHABLENDENABLE, TRUE);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    value = 0xdeadbeef;
    hr = IDirect3DDevice2_GetRenderState(device, D3DRENDERSTATE_ALPHABLENDENABLE, &value);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    ok(value == TRUE, "got %#lx.\n", value);
    hr = IDirect3DDevice2_GetRenderState(device2, D3DRENDERSTATE_ALPHABLENDENABLE, &value);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    ok(!value, "got %#lx.\n", value);
    hr = IDirect3DDevice2_GetRenderState(device3, D3DRENDERSTATE_ALPHABLENDENABLE, &value);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    ok(!value, "got %#lx.\n", value);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_TEXTURE;
    surface_desc.dwWidth = 256;
    surface_desc.dwHeight = 256;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &texture_surf, NULL);
    ok(hr == D3D_OK, "got %#lx.\n", hr);
    hr = IDirectDrawSurface_QueryInterface(texture_surf, &IID_IDirect3DTexture2, (void **)&texture);
    ok(hr == D3D_OK, "got %#lx.\n", hr);
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &texture_surf2, NULL);
    ok(hr == D3D_OK, "got %#lx.\n", hr);
    hr = IDirectDrawSurface_QueryInterface(texture_surf2, &IID_IDirect3DTexture2, (void **)&texture2);
    ok(hr == D3D_OK, "got %#lx.\n", hr);

    hr = IDirect3DDevice2_SwapTextureHandles(device, texture, texture2);
    ok(hr == E_INVALIDARG, "got %#lx.\n", hr);
    hr = IDirect3DTexture2_GetHandle(texture, device, &texture_handle);
    ok(hr == D3D_OK, "got %#lx.\n", hr);
    hr = IDirect3DDevice2_SwapTextureHandles(device, texture, texture2);
    ok(hr == E_INVALIDARG, "got %#lx.\n", hr);
    hr = IDirect3DTexture2_GetHandle(texture, device2, &texture_handle2);
    ok(hr == D3D_OK, "got %#lx.\n", hr);
    ok(texture_handle == texture_handle2, "got different handles.\n");
    hr = IDirect3DTexture2_GetHandle(texture, device3, &texture_handle2);
    ok(hr == D3D_OK, "got %#lx.\n", hr);
    ok(texture_handle == texture_handle2, "got different handles.\n");
    hr = IDirect3DDevice2_SwapTextureHandles(device, texture, texture2);
    ok(hr == E_INVALIDARG, "got %#lx.\n", hr);
    hr = IDirect3DTexture2_GetHandle(texture2, device, &texture_handle2);
    ok(hr == D3D_OK, "got %#lx.\n", hr);
    ok(texture_handle != texture_handle2, "got same handles.\n");
    hr = IDirect3DDevice2_SwapTextureHandles(device, texture, texture2);
    ok(hr == D3D_OK, "got %#lx.\n", hr);
    hr = IDirect3DTexture2_GetHandle(texture, device, &texture_handle3);
    ok(hr == D3D_OK, "got %#lx.\n", hr);
    ok(texture_handle3 == texture_handle2, "got different handles.\n");
    hr = IDirect3DTexture2_GetHandle(texture2, device2, &texture_handle3);
    ok(hr == D3D_OK, "got %#lx.\n", hr);
    ok(texture_handle3 == texture_handle, "got different handles.\n");

    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_TEXTUREHANDLE, texture_handle);
    ok(hr == D3D_OK, "got %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device2, D3DRENDERSTATE_TEXTUREHANDLE, texture_handle);
    ok(hr == D3D_OK, "got %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device3, D3DRENDERSTATE_TEXTUREHANDLE, texture_handle);
    ok(hr == D3D_OK, "got %#lx.\n", hr);
    hr = IDirect3DDevice2_SwapTextureHandles(device, texture, texture2);
    ok(hr == S_OK, "got %#lx.\n", hr);
    hr = IDirect3DDevice2_GetRenderState(device, D3DRENDERSTATE_TEXTUREHANDLE, &texture_handle2);
    ok(hr == D3D_OK, "got %#lx.\n", hr);
    ok(texture_handle2 == texture_handle, "got different handles.\n");

    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_TEXTUREHANDLE, 0);
    ok(hr == D3D_OK, "got %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_ZENABLE, FALSE);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_ALPHABLENDENABLE, FALSE);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_LIGHTING, FALSE);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice2_SetRenderState(device2, D3DRENDERSTATE_TEXTUREHANDLE, 0);
    ok(hr == D3D_OK, "got %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device2, D3DRENDERSTATE_ZENABLE, FALSE);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device2, D3DRENDERSTATE_ALPHABLENDENABLE, FALSE);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device2, D3DRENDERSTATE_ALPHATESTENABLE, TRUE);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device2, D3DRENDERSTATE_ALPHAFUNC, D3DCMP_LESS);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device2, D3DRENDERSTATE_ALPHAREF, 0x70);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device2, D3DRENDERSTATE_LIGHTING, FALSE);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_BeginScene(device);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, D3DVT_LVERTEX, quad, ARRAY_SIZE(quad), 0);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_EndScene(device);
    colour = get_surface_color(surface, 320, 240);
    ok(colour == 0x0000ff, "got %#lx.\n", colour);

    hr = IDirect3DViewport2_Clear(viewport2, 1, &clear_rect, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_BeginScene(device2);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_DrawPrimitive(device2, D3DPT_TRIANGLESTRIP, D3DVT_LVERTEX, quad, ARRAY_SIZE(quad), 0);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_EndScene(device2);
    colour = get_surface_color(surface, 320, 240);
    ok(colour == 0xff0000, "got %#lx.\n", colour);

    hr = IDirect3DViewport2_Clear(viewport, 1, &clear_rect, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_BeginScene(device);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, D3DVT_LVERTEX, quad, ARRAY_SIZE(quad), 0);
    ok(hr == DD_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice2_EndScene(device);
    colour = get_surface_color(surface, 320, 240);
    ok(colour == 0x0000ff, "got %#lx.\n", colour);

    IDirect3DTexture2_Release(texture2);
    IDirect3DTexture2_Release(texture);
    IDirectDrawSurface_Release(texture_surf2);
    IDirectDrawSurface_Release(texture_surf);
    IDirect3DMaterial2_Release(material);
    IDirect3DViewport2_Release(viewport);
    IDirect3DViewport2_Release(viewport2);

    refcount = IDirect3DDevice2_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    refcount = IDirect3DDevice2_Release(device2);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    refcount = IDirect3DDevice2_Release(device3);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    refcount = IDirectDrawSurface_Release(surface);
    ok(!refcount, "Surface has %lu references left.\n", refcount);

    IDirectDraw2_Release(ddraw);
    IDirectDraw_Release(ddraw2);
    IDirect3D2_Release(d3d);
    DestroyWindow(window);
}

static void test_d3d_state_reset(void)
{
    struct find_different_mode_param param;
    IDirect3DViewport2 *viewport;
    IDirectDrawSurface *surface;
    IDirect3DDevice2 *device;
    D3DVIEWPORT2 vp1, vp2;
    IDirectDraw2 *ddraw;
    DDSURFACEDESC ddsd;
    DWORD state;
    HWND window;
    HRESULT hr;

    window = CreateWindowA("static", "ddraw_test", WS_OVERLAPPEDWINDOW, 0, 0, 100, 100, 0, 0, 0, 0);

    ddraw = create_ddraw();
    ok(!!ddraw, "Failed to create a ddraw object.\n");

    if (!(device = create_device(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN)))
    {
        skip("Failed to create 3D device.\n");
        IDirectDraw2_Release(ddraw);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_FOGCOLOR, 0x00282828);
    ok(hr == DD_OK, "got %#lx.\n", hr);
    hr = IDirect3DDevice2_SetRenderState(device, D3DRENDERSTATE_ZENABLE, TRUE);
    ok(hr == DD_OK, "got %#lx.\n", hr);
    hr = IDirect3DDevice2_BeginScene(device);
    ok(hr == DD_OK, "got %#lx.\n", hr);

    memset(&param, 0, sizeof(param));
    hr = IDirectDraw2_EnumDisplayModes(ddraw, 0, NULL, &param, find_different_mode_callback);
    ok(hr == DD_OK, "got %#lx.\n", hr);

    viewport = create_viewport(device, 0, 0, param.old_width, param.old_height);
    ok(hr == DD_OK, "got %#lx.\n", hr);

    vp1.dwSize = sizeof(vp1);
    vp2.dwSize = sizeof(vp2);

    hr = IDirect3DDevice2_SetCurrentViewport(device, viewport);
    ok(hr == DD_OK, "got %#lx.\n", hr);
    hr = IDirect3DViewport2_GetViewport2(viewport, &vp1);
    ok(hr == DD_OK, "got %#lx.\n", hr);

    hr = set_display_mode(ddraw, param.new_width, param.new_height);
    ok(hr == DD_OK, "got %#lx.\n", hr);

    hr = IDirect3DViewport2_GetViewport2(viewport, &vp2);
    ok(hr == DD_OK, "got %#lx.\n", hr);
    ok(vp2.dwWidth == vp1.dwWidth, "got %ld, expected %ld.\n", vp2.dwWidth, vp1.dwWidth);
    ok(vp2.dwHeight == vp1.dwHeight, "got %ld, expected %ld.\n", vp2.dwHeight, vp1.dwHeight);

    memset(&ddsd, 0, sizeof(ddsd));
    ddsd.dwSize = sizeof(ddsd);
    ddsd.dwFlags = DDSD_CAPS;
    ddsd.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE;

    hr = IDirectDraw2_CreateSurface(ddraw, &ddsd, &surface, NULL);
    ok(hr == DD_OK, "got %#lx.\n", hr);

    hr = IDirectDrawSurface_GetSurfaceDesc(surface, &ddsd);
    ok(hr == DD_OK, "got %#lx.\n", hr);
    ok(ddsd.dwWidth == param.new_width, "got %ld, expected %d.\n", ddsd.dwWidth, param.new_width);
    ok(ddsd.dwHeight == param.new_height, "got %ld, expected %d.\n", ddsd.dwHeight, param.new_height);

    hr = IDirect3DViewport2_GetViewport2(viewport, &vp2);
    ok(hr == DD_OK, "got %#lx.\n", hr);
    ok(vp2.dwWidth == vp1.dwWidth, "got %ld, expected %ld.\n", vp2.dwWidth, vp1.dwWidth);
    ok(vp2.dwHeight == vp1.dwHeight, "got %ld, expected %ld.\n", vp2.dwHeight, vp1.dwHeight);

    hr = IDirect3DDevice2_GetRenderState(device, D3DRENDERSTATE_FOGCOLOR, &state);
    ok(hr == DD_OK, "got %#lx.\n", hr);
    ok(state == 0x00282828, "got %#lx.\n", state);
    hr = IDirect3DDevice2_GetRenderState(device, D3DRENDERSTATE_ZENABLE, &state);
    ok(hr == DD_OK, "got %#lx.\n", hr);
    ok(state == TRUE, "got %#lx.\n", state);
    hr = IDirect3DDevice2_BeginScene(device);
    ok(hr == D3DERR_SCENE_IN_SCENE, "Unexpected hr %#lx.\n", hr);

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, NULL, DDSCL_NORMAL);
    ok(hr == DD_OK, "got %#lx.\n", hr);

    IDirect3DViewport2_Release(viewport);
    IDirectDrawSurface_Release(surface);
    IDirect3DDevice2_Release(device);
    IDirectDraw2_Release(ddraw);
    DestroyWindow(window);
}

/* The Egyptian Prophecy: The Fate of Ramses does this. */
static void test_sysmem_x_channel(void)
{
    DDSURFACEDESC surface_desc = {sizeof(surface_desc)};
    DDBLTFX fx = {.dwSize = sizeof(fx)};
    unsigned int colour, refcount;
    IDirectDrawSurface *surface;
    IDirectDraw2 *ddraw;
    HWND window;
    HRESULT hr;

    window = create_window();
    ddraw = create_ddraw();
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN | DDSCAPS_SYSTEMMEMORY;
    surface_desc.dwWidth = 32;
    surface_desc.dwHeight = 32;
    init_format_b8g8r8x8(&surface_desc.ddpfPixelFormat);
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    fx.dwFillColor = 0x0000ff00;
    hr = IDirectDrawSurface_Blt(surface, NULL, NULL, NULL, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    hr = IDirectDrawSurface_Lock(surface, NULL, &surface_desc, DDLOCK_READONLY, NULL);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    colour = *(unsigned int *)surface_desc.lpSurface;
    ok(colour == 0x0000ff00, "Got colour %08x.\n", colour);
    hr = IDirectDrawSurface_Unlock(surface, NULL);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    IDirectDrawSurface_Release(surface);
    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "Device has %u references left.\n", refcount);
    DestroyWindow(window);
}

static void test_yuv_blit(void)
{
    DDSURFACEDESC surface_desc = {sizeof(surface_desc)};
    IDirectDrawSurface *rgb_surface, *yuv_surface;
    const unsigned int width = 32, height = 32;
    uint8_t *buf, *chroma_buf, *u_buf, *v_buf;
    DDBLTFX fx = {.dwSize = sizeof(fx)};
    unsigned int color, refcount;
    IDirectDraw2 *ddraw;
    HWND window;
    HRESULT hr;

    static const struct
    {
        uint8_t y, u, v;
        uint32_t rgb_full, rgb_reduced;
    }
    tests[] =
    {
        {0x10, 0x80, 0x80, 0x000000, 0x101010},
        {0xeb, 0x80, 0x80, 0xffffff, 0xebebeb},
        {0x51, 0x5a, 0xf0, 0xff0000, 0xee0e0e},
        {0x91, 0x36, 0x22, 0x00ff01, 0x0dee0e},
        {0x29, 0xf0, 0x6e, 0x0000ff, 0x100fef},
        {0x7e, 0x80, 0x80, 0x808080, 0x7e7e7e},
        {0x00, 0x80, 0x80, 0x000000, 0x000000},
        {0xff, 0x80, 0x80, 0xffffff, 0xffffff},
        {0x00, 0x00, 0x00, 0x008800, 0x008800},
        {0xff, 0x00, 0x00, 0x4aff14, 0x4cff1c},
        {0x00, 0xff, 0x00, 0x0024ee, 0x0030e1},
        {0x00, 0x00, 0xff, 0xb80000, 0xb20000},
        {0xff, 0xff, 0x00, 0x4affff, 0x4cffff},
        {0xff, 0x00, 0xff, 0xffe114, 0xffd01c},
        {0x00, 0xff, 0xff, 0xb800ee, 0xb200e1},
        {0xff, 0xff, 0xff, 0xff7dff, 0xff78ff},
    };

    static const struct
    {
        DWORD fourcc;
        const char *str;
    }
    formats[] =
    {
        {MAKEFOURCC('U','Y','V','Y'), "UYVY"},
        {MAKEFOURCC('Y','U','Y','2'), "YUY2"},
        {MAKEFOURCC('Y','V','1','2'), "YV12"},
        {MAKEFOURCC('N','V','1','2'), "NV12"},
    };

    window = create_window();
    ddraw = create_ddraw();
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    surface_desc.dwFlags = DDSD_WIDTH | DDSD_HEIGHT | DDSD_CAPS | DDSD_PIXELFORMAT;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN;
    surface_desc.dwWidth = 640;
    surface_desc.dwHeight = 480;
    init_format_b8g8r8x8(&surface_desc.ddpfPixelFormat);

    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &rgb_surface, NULL);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    for (unsigned int fmt = 0; fmt < ARRAY_SIZE(formats); fmt++)
    {
        DWORD format = formats[fmt].fourcc;

        winetest_push_context("format %s", formats[fmt].str);

        surface_desc.dwWidth = width;
        surface_desc.dwHeight = height;
        surface_desc.ddpfPixelFormat.dwFlags = DDPF_FOURCC;
        surface_desc.ddpfPixelFormat.dwFourCC = format;
        hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &yuv_surface, NULL);
        if (hr != S_OK)
        {
            skip("Failed to create surface, hr %#lx.\n", hr);
            winetest_pop_context();
            continue;
        }

        for (unsigned int i = 0; i < ARRAY_SIZE(tests); i++)
        {
            winetest_push_context("value (%#x,%#x,%#x)", tests[i].y, tests[i].u, tests[i].v);

            hr = IDirectDrawSurface_Lock(yuv_surface, NULL, &surface_desc, DDLOCK_WAIT, NULL);
            ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
            buf = surface_desc.lpSurface;
            chroma_buf = buf + surface_desc.lPitch * height;
            if (format == MAKEFOURCC('Y','V','1','2'))
            {
                v_buf = chroma_buf;
                u_buf = chroma_buf + height / 2 * surface_desc.lPitch / 2;
            }
            for (unsigned int y = 0; y < height; y++)
            {
                for (unsigned int x = 0; x < width; x += 2)
                {
                    uint8_t Y = tests[i].y, U = tests[i].u, V = tests[i].v;
                    if (x < width / 2 && y < height / 2)
                        Y = U = V = 0x40;

                    if (format == MAKEFOURCC('U','Y','V','Y'))
                    {
                        buf[y * surface_desc.lPitch + 2 * x + 0] = U;
                        buf[y * surface_desc.lPitch + 2 * x + 1] = Y;
                        buf[y * surface_desc.lPitch + 2 * x + 2] = V;
                        buf[y * surface_desc.lPitch + 2 * x + 3] = Y;
                    }
                    else if (format == MAKEFOURCC('Y','U','Y','2'))
                    {
                        buf[y * surface_desc.lPitch + 2 * x + 0] = Y;
                        buf[y * surface_desc.lPitch + 2 * x + 1] = U;
                        buf[y * surface_desc.lPitch + 2 * x + 2] = Y;
                        buf[y * surface_desc.lPitch + 2 * x + 3] = V;
                    }
                    else if (format == MAKEFOURCC('Y','V','1','2'))
                    {
                        buf[y * surface_desc.lPitch + x + 0] = Y;
                        buf[y * surface_desc.lPitch + x + 1] = Y;
                        u_buf[(y / 2) * (surface_desc.lPitch / 2) + (x / 2)] = U;
                        v_buf[(y / 2) * (surface_desc.lPitch / 2) + (x / 2)] = V;
                    }
                    else if (format == MAKEFOURCC('N','V','1','2'))
                    {
                        buf[y * surface_desc.lPitch + x + 0] = Y;
                        buf[y * surface_desc.lPitch + x + 1] = Y;
                        chroma_buf[(y / 2) * surface_desc.lPitch + 2 * (x / 2) + 0] = U;
                        chroma_buf[(y / 2) * surface_desc.lPitch + 2 * (x / 2) + 1] = V;
                    }
                }
            }
            hr = IDirectDrawSurface_Unlock(yuv_surface, NULL);
            ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

            hr = IDirectDrawSurface_Blt(rgb_surface, NULL, yuv_surface, NULL, DDBLT_WAIT, NULL);
            if (hr != D3D_OK)
            {
                winetest_pop_context();
                skip("Failed to blit, hr %#lx.\n", hr);
                break;
            }
            ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

            hr = IDirectDrawSurface_Lock(rgb_surface, NULL, &surface_desc, DDLOCK_WAIT, NULL);
            ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

            for (unsigned int y = 0; y < 4; y++)
            {
                for (unsigned int x = 0; x < 4; x++)
                {
                    unsigned int xcoord = (1 + 2 * x) * 640 / 8;
                    unsigned int ycoord = (1 + 2 * y) * 480 / 8;

                    color = ((uint32_t *)((uint8_t *)surface_desc.lpSurface + ycoord * surface_desc.lPitch))[xcoord];
                    color &= 0xffffff;

                    if (x < 2 && y < 2)
                        ok(compare_color(color, 0x008400, 1),
                                "Got color %#x at (%u, %u).\n", color, xcoord, ycoord);
                    else
                        ok(compare_color(color, tests[i].rgb_full, 1)
                                || compare_color(color, tests[i].rgb_reduced, 1),
                                "Got color %#x at (%u, %u), expected %#x.\n", color, xcoord, ycoord, tests[i].rgb_full);
                }
            }
            hr = IDirectDrawSurface_Unlock(rgb_surface, NULL);
            ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

            winetest_pop_context();
        }

        IDirectDrawSurface_Release(yuv_surface);
        winetest_pop_context();
    }

    IDirectDrawSurface_Release(rgb_surface);
    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "Device has %u references left.\n", refcount);
    DestroyWindow(window);
}

static void test_blit_to_self(void)
{
    DDSURFACEDESC surface_desc = {sizeof(surface_desc)};
    const unsigned int width = 64, height = 64;
    IDirectDrawSurface *surface;
    unsigned int refcount;
    IDirectDraw2 *ddraw;
    HWND window;
    HRESULT hr;

    struct
    {
        RECT src, dst;
    }
    tests[] =
    {
        {{16, 16, 24, 24}, {18, 18, 26, 26}},
        {{16, 16, 24, 24}, {14, 14, 22, 22}},
        {{16, 16, 24, 24}, {12, 12, 28, 28}},
        {{16, 16, 24, 24}, {18, 18, 22, 22}},
    };

    window = create_window();
    ddraw = create_ddraw();
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_NORMAL);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    surface_desc.dwFlags = DDSD_WIDTH | DDSD_HEIGHT | DDSD_CAPS | DDSD_PIXELFORMAT;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN | DDSCAPS_SYSTEMMEMORY;
    surface_desc.dwWidth = width;
    surface_desc.dwHeight = height;
    init_format_b8g8r8x8(&surface_desc.ddpfPixelFormat);

    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &surface, NULL);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    for (unsigned int i = 0; i < ARRAY_SIZE(tests); ++i)
    {
        hr = IDirectDrawSurface_Lock(surface, NULL, &surface_desc, DDLOCK_WAIT, NULL);
        ok(hr == S_OK, "Got hr %#lx.\n", hr);
        for (unsigned int y = 0; y < height; ++y)
        {
            for (unsigned int x = 0; x < width; ++x)
                ((unsigned int *)surface_desc.lpSurface)[y * width + x] = (y << 8) | x;
        }
        hr = IDirectDrawSurface_Unlock(surface, NULL);
        ok(hr == S_OK, "Got hr %#lx.\n", hr);

        hr = IDirectDrawSurface_Blt(surface, &tests[i].dst, surface, &tests[i].src, DDBLT_WAIT, NULL);
        ok(hr == S_OK, "Got hr %#lx.\n", hr);

        hr = IDirectDrawSurface_Lock(surface, NULL, &surface_desc, DDLOCK_WAIT | DDLOCK_READONLY, NULL);
        ok(hr == S_OK, "Got hr %#lx.\n", hr);
        for (unsigned int y = 0; y < height; ++y)
        {
            for (unsigned int x = 0; x < width; ++x)
            {
                unsigned int colour = ((unsigned int *)surface_desc.lpSurface)[y * width + x];

                if (x >= tests[i].dst.left && x < tests[i].dst.right
                        && y >= tests[i].dst.top && y < tests[i].dst.bottom)
                {
                    unsigned int src_x = (x - tests[i].dst.left)
                            * (tests[i].src.right - tests[i].src.left)
                            / (tests[i].dst.right - tests[i].dst.left)
                            + tests[i].src.left;
                    unsigned int src_y = (y - tests[i].dst.top)
                            * (tests[i].src.bottom - tests[i].src.top)
                            / (tests[i].dst.bottom - tests[i].dst.top)
                            + tests[i].src.top;
                    if (colour != ((src_y << 8) | src_x))
                    {
                        ok(0, "Got colour 0x%08x at (%u, %u), expected 0x%08x.\n",
                                colour, x, y, ((src_y << 8) | src_x));
                        goto out;
                    }
                }
                else
                {
                    if (colour != ((y << 8) | x))
                    {
                        ok(0, "Got colour 0x%08x at (%u, %u).\n", colour, x, y);
                        goto out;
                    }
                }
            }
        }
out:
        hr = IDirectDrawSurface_Unlock(surface, NULL);
        ok(hr == S_OK, "Got hr %#lx.\n", hr);
    }

    IDirectDrawSurface_Release(surface);
    refcount = IDirectDraw2_Release(ddraw);
    ok(!refcount, "Device has %u references left.\n", refcount);
    DestroyWindow(window);
}

static void check_surface_clipper(IDirectDrawSurface *surface,
        IDirectDrawClipper *clipper, RECT *window_rect, DWORD style)
{
    unsigned int c;
    DDBLTFX fx;
    HRESULT hr;

    memset(&fx, 0, sizeof(fx));
    fx.dwSize = sizeof(fx);
    fx.dwFillColor = 0xff00ff00;

    fill_surface(surface, 0xffff0000);

    /* Clippers with a region work. Clippers with a window work on Windows 98,
     * but are ignored on modern windows. */

    hr = IDirectDrawSurface_SetClipper(surface, clipper);
    ok(hr == DD_OK, "got %#lx.\n", hr);
    c = get_surface_color(surface, 101, 101);
    ok(c == 0x00ff0000, "got %#x.\n", c);
    hr = IDirectDrawSurface_Blt(surface, NULL, NULL, NULL, DDBLT_COLORFILL | DDBLT_WAIT, &fx);
    ok(hr == DD_OK, "got %#lx.\n", hr);
    c = get_surface_color(surface, 0, 0);
    ok(c == 0x00ff0000, "got %#x.\n", c);
    c = get_surface_color(surface, 101, 101);
    ok(c == 0x0000ff00, "got %#x.\n", c);

    hr = IDirectDrawSurface_SetClipper(surface, NULL);
    ok(hr == DD_OK, "got %#lx.\n", hr);
    fill_surface(surface, 0);
}

static void test_clipper_in_exclusive_fullscreen(void)
{
    static const struct
    {
        DWORD style;
        BOOL parent;
    }
    tests[] =
    {
        { WS_POPUP },
        { WS_POPUP, TRUE },
        { WS_CHILD, TRUE },
        { WS_OVERLAPPED },
        { WS_CHILD | WS_VISIBLE, TRUE },
        { WS_POPUP | WS_VISIBLE },
    };
    IDirectDrawSurface *primary, *offscreen;
    IDirectDrawClipper *clipper;
    DDSURFACEDESC surface_desc;
    IDirectDraw2 *ddraw;
    RGNDATA *rgn_data;
    DWORD ret, style;
    RECT window_rect;
    ULONG refcount;
    unsigned int i;
    HWND window;
    HRESULT hr;
    HRGN rgn;

    if (!(ddraw = create_ddraw()))
    {
        skip("Failed to create ddraw, skipping test.\n");
        return;
    }
    hr = IDirectDraw2_CreateClipper(ddraw, 0, &clipper, NULL);
    ok(hr == DD_OK, "got %#lx.\n", hr);

    window = CreateWindowA("static", "ddraw_fullscreen", WS_POPUP | WS_VISIBLE, 0, 0, 640, 480, NULL, NULL, NULL, NULL);
    pump_messages();
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, NULL, DDSCL_NORMAL);
    ok(hr == DD_OK, "got %#lx.\n", hr);
    hr = IDirectDraw2_SetCooperativeLevel(ddraw, window, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    ok(hr == DD_OK, "got %#lx.\n", hr);
    pump_messages();

    rgn = CreateRectRgn(100, 100, 200, 200);
    ok(!!rgn, "Failed to create region.\n");
    ret = GetRegionData(rgn, 0, NULL);
    rgn_data = malloc(ret);
    ret = GetRegionData(rgn, ret, rgn_data);
    ok(!!ret, "Failed to get region data.\n");
    DeleteObject(rgn);
    hr = IDirectDrawClipper_SetClipList(clipper, rgn_data, 0);
    ok(hr == DD_OK, "got %#lx.\n", hr);
    free(rgn_data);

    memset(&surface_desc, 0, sizeof(surface_desc));
    surface_desc.dwSize = sizeof(surface_desc);
    surface_desc.dwFlags = DDSD_CAPS;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &primary, NULL);
    ok(hr == DD_OK, "got %#lx.\n", hr);

    surface_desc.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT;
    surface_desc.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN;
    surface_desc.dwWidth = 640;
    surface_desc.dwHeight = 480;
    hr = IDirectDraw2_CreateSurface(ddraw, &surface_desc, &offscreen, NULL);
    ok(hr == DD_OK, "got %#lx.\n", hr);

    for (i = 0; i < ARRAY_SIZE(tests); ++i)
    {
        winetest_push_context("test %u", i);
        style = tests[i].style;

        winetest_push_context("primary");
        check_surface_clipper(primary, clipper, &window_rect, style);
        winetest_pop_context();

        winetest_push_context("offscreen");
        check_surface_clipper(offscreen, clipper, &window_rect, style);
        winetest_pop_context();

        winetest_pop_context();
    }

    hr = IDirectDraw2_SetCooperativeLevel(ddraw, NULL, DDSCL_NORMAL);
    ok(hr == DD_OK, "got %#lx.\n", hr);
    IDirectDrawClipper_Release(clipper);
    refcount = IDirectDrawSurface_Release(offscreen);
    ok(!refcount, "Got unexpected refcount %lu.\n", refcount);
    refcount = IDirectDrawSurface_Release(primary);
    ok(!refcount, "Got unexpected refcount %lu.\n", refcount);

    IDirectDraw2_Release(ddraw);
    DestroyWindow(window);
    pump_messages();
}

START_TEST(ddraw2)
{
    DDDEVICEIDENTIFIER identifier;
    DEVMODEA current_mode;
    IDirectDraw2 *ddraw;
    HMODULE dwmapi;

    if (!(ddraw = create_ddraw()))
    {
        skip("Failed to create a ddraw object, skipping tests.\n");
        return;
    }

    if (ddraw_get_identifier(ddraw, &identifier))
    {
        trace("Driver string: \"%s\"\n", identifier.szDriver);
        trace("Description string: \"%s\"\n", identifier.szDescription);
        trace("Driver version %d.%d.%d.%d\n",
                HIWORD(identifier.liDriverVersion.HighPart), LOWORD(identifier.liDriverVersion.HighPart),
                HIWORD(identifier.liDriverVersion.LowPart), LOWORD(identifier.liDriverVersion.LowPart));
    }
    IDirectDraw2_Release(ddraw);

    memset(&current_mode, 0, sizeof(current_mode));
    current_mode.dmSize = sizeof(current_mode);
    ok(EnumDisplaySettingsA(NULL, ENUM_CURRENT_SETTINGS, &current_mode), "Failed to get display mode.\n");
    registry_mode.dmSize = sizeof(registry_mode);
    ok(EnumDisplaySettingsA(NULL, ENUM_REGISTRY_SETTINGS, &registry_mode), "Failed to get display mode.\n");
    if (registry_mode.dmPelsWidth != current_mode.dmPelsWidth
            || registry_mode.dmPelsHeight != current_mode.dmPelsHeight)
    {
        skip("Current mode does not match registry mode, skipping test.\n");
        return;
    }

    if ((dwmapi = LoadLibraryA("dwmapi.dll")))
        pDwmIsCompositionEnabled = (void *)GetProcAddress(dwmapi, "DwmIsCompositionEnabled");

    start_foreground_window_thread();

    test_coop_level_create_device_window();
    test_clipper_blt();
    test_coop_level_d3d_state();
    test_surface_interface_mismatch();
    test_coop_level_threaded();
    run_for_each_device_type(test_depth_blit);
    test_texture_load_ckey();
    test_viewport_object();
    run_for_each_device_type(test_zenable);
    run_for_each_device_type(test_ck_rgba);
    test_ck_default();
    test_ck_complex();
    test_surface_qi();
    test_device_qi();
    test_wndproc();
    test_window_style();
    test_redundant_mode_set();
    test_coop_level_mode_set();
    test_coop_level_mode_set_multi();
    test_initialize();
    test_coop_level_surf_create();
    test_coop_level_multi_window();
    test_clear_rect_count();
    test_coop_level_versions();
    test_lighting_interface_versions();
    test_coop_level_activateapp();
    test_unsupported_formats();
    run_for_each_device_type(test_rt_caps);
    test_primary_caps();
    test_surface_lock();
    test_surface_discard();
    test_flip();
    test_set_surface_desc();
    test_user_memory_getdc();
    test_sysmem_overlay();
    test_primary_palette();
    test_surface_attachment();
    test_pixel_format();
    test_create_surface_pitch();
    test_mipmap();
    test_palette_complex();
    test_p8_blit();
    test_material();
    test_lighting();
    test_specular_lighting();
    test_palette_gdi();
    test_palette_alpha();
    test_lost_device();
    test_surface_desc_lock();
    test_texturemapblend();
    test_viewport_clear_rect();
    test_color_fill();
    test_colorkey_precision();
    test_range_colorkey();
    test_shademode();
    test_lockrect_invalid();
    test_yv12_overlay();
    test_offscreen_overlay();
    test_overlay_rect();
    test_blt();
    test_blt_z_alpha();
    test_cross_device_blt();
    test_getdc();
    test_draw_primitive();
    test_edge_antialiasing_blending();
    test_transform_vertices();
    test_display_mode_surface_pixel_format();
    test_surface_desc_size();
    test_ck_operation();
    test_set_render_state();
    test_depth_readback();
    test_clear();
    test_enum_surfaces();
    test_viewport();
    test_find_device();
    test_killfocus();
    test_gdi_surface();
    test_alphatest();
    test_clipper_refcount();
    test_caps();
    test_d32_support();
    test_cursor_clipping();
    test_window_position();
    test_get_display_mode();
    run_for_each_device_type(test_texture_wrong_caps);
    test_filling_convention();
    test_enum_devices();
    test_multiple_devices();
    test_d3d_state_reset();
    test_sysmem_x_channel();
    test_yuv_blit();
    test_blit_to_self();
    test_clipper_in_exclusive_fullscreen();
}
