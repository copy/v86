/*
 * Copyright (C) 2005 Henri Verbeet
 * Copyright (C) 2007, 2009, 2011-2013 Stefan Dösinger(for CodeWeavers)
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

/* See comment in dlls/d3d9/tests/visual.c for general guidelines */

#include <stdbool.h>
#include <limits.h>
#include <math.h>

#define COBJMACROS
#include <d3d8.h>
#include <winternl.h>
#include "wine/test.h"

static bool is_win64 = sizeof(void *) > sizeof(int);
static bool new_wow64;

struct vec2
{
    float x, y;
};

struct vec3
{
    float x, y, z;
};

struct vec4
{
    float x, y, z, w;
};

struct d3d8_test_context
{
    HWND window;
    IDirect3D8 *d3d;
    IDirect3DDevice8 *device;
    IDirect3DSurface8 *backbuffer;
};

static HWND create_window(void)
{
    RECT rect;

    SetRect(&rect, 0, 0, 640, 480);
    AdjustWindowRect(&rect, WS_OVERLAPPEDWINDOW | WS_VISIBLE, FALSE);
    return CreateWindowA("static", "d3d8_test", WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            0, 0, rect.right - rect.left, rect.bottom - rect.top, 0, 0, 0, 0);
}

static BOOL compare_uint(unsigned int x, unsigned int y, unsigned int max_diff)
{
    unsigned int diff = x > y ? x - y : y - x;

    return diff <= max_diff;
}

static BOOL color_match(D3DCOLOR c1, D3DCOLOR c2, BYTE max_diff)
{
    return compare_uint(c1 & 0xff, c2 & 0xff, max_diff)
            && compare_uint((c1 >> 8) & 0xff, (c2 >> 8) & 0xff, max_diff)
            && compare_uint((c1 >> 16) & 0xff, (c2 >> 16) & 0xff, max_diff)
            && compare_uint((c1 >> 24) & 0xff, (c2 >> 24) & 0xff, max_diff);
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

static BOOL adapter_is_warp(const D3DADAPTER_IDENTIFIER8 *identifier)
{
    return !strcmp(identifier->Driver, "d3d10warp.dll");
}

struct surface_readback
{
    IDirect3DSurface8 *surface;
    D3DLOCKED_RECT locked_rect;
};

static void get_surface_readback(IDirect3DSurface8 *surface, struct surface_readback *rb)
{
    IDirect3DTexture8 *tex = NULL;
    IDirect3DDevice8 *device;
    D3DSURFACE_DESC desc;
    HRESULT hr;

    memset(rb, 0, sizeof(*rb));
    hr = IDirect3DSurface8_GetDevice(surface, &device);
    ok(SUCCEEDED(hr), "Failed to get device, hr %#lx.\n", hr);
    hr = IDirect3DSurface8_GetDesc(surface, &desc);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);

    if (desc.Pool == D3DPOOL_DEFAULT || (desc.Usage & D3DUSAGE_WRITEONLY))
    {
        hr = IDirect3DDevice8_CreateTexture(device, desc.Width, desc.Height, 1, 0, desc.Format, D3DPOOL_SYSTEMMEM, &tex);
        ok(hr == S_OK, "Got hr %#lx.\n", hr);
        hr = IDirect3DTexture8_GetSurfaceLevel(tex, 0, &rb->surface);
        ok(hr == S_OK, "Got hr %#lx.\n", hr);
        hr = IDirect3DDevice8_CopyRects(device, surface, NULL, 0, rb->surface, NULL);
        ok(hr == S_OK, "Got hr %#lx.\n", hr);
        IDirect3DTexture8_Release(tex);
    }
    else
    {
        IDirect3DSurface8_AddRef(surface);
        rb->surface = surface;
    }
    hr = IDirect3DSurface8_LockRect(rb->surface, &rb->locked_rect, NULL, D3DLOCK_READONLY);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    IDirect3DDevice8_Release(device);
}

static DWORD get_readback_color(struct surface_readback *rb, unsigned int x, unsigned int y)
{
    return ((DWORD *)rb->locked_rect.pBits)[y * rb->locked_rect.Pitch / sizeof(DWORD) + x];
}

static void release_surface_readback(struct surface_readback *rb)
{
    HRESULT hr;

    hr = IDirect3DSurface8_UnlockRect(rb->surface);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    IDirect3DSurface8_Release(rb->surface);
}

static DWORD getPixelColor(IDirect3DDevice8 *device, UINT x, UINT y)
{
    DWORD ret;
    IDirect3DSurface8 *rt;
    struct surface_readback rb;
    HRESULT hr;

    hr = IDirect3DDevice8_GetRenderTarget(device, &rt);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    get_surface_readback(rt, &rb);
    /* Remove the X channel for now. DirectX and OpenGL have different ideas how to treat it apparently, and it isn't
     * really important for these tests
     */
    ret = get_readback_color(&rb, x, y) & 0x00ffffff;
    release_surface_readback(&rb);

    IDirect3DSurface8_Release(rt);
    return ret;
}

static D3DCOLOR get_surface_color(IDirect3DSurface8 *surface, UINT x, UINT y)
{
    DWORD color;
    HRESULT hr;
    D3DSURFACE_DESC desc;
    RECT rectToLock = {x, y, x+1, y+1};
    D3DLOCKED_RECT lockedRect;

    hr = IDirect3DSurface8_GetDesc(surface, &desc);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);

    hr = IDirect3DSurface8_LockRect(surface, &lockedRect, &rectToLock, D3DLOCK_READONLY);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);

    switch(desc.Format)
    {
        case D3DFMT_A8R8G8B8:
            color = ((D3DCOLOR *)lockedRect.pBits)[0];
            break;

        default:
            trace("Error: unknown surface format: %u.\n", desc.Format);
            color = 0xdeadbeef;
            break;
    }

    hr = IDirect3DSurface8_UnlockRect(surface);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);

    return color;
}

static void check_rect(struct surface_readback *rb, RECT r, const char *message)
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
                    unsigned int expected = (x_side == 1 && y_side == 1) ? 0xffffffff : 0xff000000;

                    x = x_coords[i][x_side];
                    y = y_coords[j][y_side];
                    if (x < 0 || x >= 640 || y < 0 || y >= 480)
                        continue;
                    color = get_readback_color(rb, x, y);
                    todo_wine_if(i == 0 && x_side == 0 && y_side == 1 && !is_win64 && !new_wow64)
                    ok(color == expected, "%s: Pixel (%ld, %ld) has color %08x, expected %08x.\n",
                            message, x, y, color, expected);
                }
            }
        }
    }
}

#define check_rt_color(a, b) check_rt_color_(__LINE__, a, b, false, 0, false)
#define check_rt_color_broken(a, b, c, d) check_rt_color_(__LINE__, a, b, false, c, d)
#define check_rt_color_todo(a, b) check_rt_color_(__LINE__, a, b, true, 0, false)
#define check_rt_color_todo_if(a, b, c) check_rt_color_(__LINE__, a, b, c, 0, false)
static void check_rt_color_(unsigned int line, IDirect3DSurface8 *rt, D3DCOLOR expected_color, bool todo,
    D3DCOLOR broken_color, bool is_broken)
{
    unsigned int color = 0xdeadbeef;
    struct surface_readback rb;
    D3DSURFACE_DESC desc;
    unsigned int x, y;
    HRESULT hr;

    hr = IDirect3DSurface8_GetDesc(rt, &desc);
    ok_(__FILE__, line)(hr == S_OK, "Failed to get surface desc, hr %#lx.\n", hr);

    get_surface_readback(rt, &rb);
    for (y = 0; y < desc.Height; ++y)
    {
        for (x = 0; x < desc.Width; ++x)
        {
            color = get_readback_color(&rb, x, y) & 0x00ffffff;
            if (color != expected_color)
                break;
        }
        if (color != expected_color)
            break;
    }
    release_surface_readback(&rb);
    todo_wine_if (todo)
        ok_(__FILE__, line)(color == expected_color || broken(is_broken && color == broken_color),
                "Got unexpected color 0x%08x.\n", color);
}

static IDirect3DDevice8 *create_device(IDirect3D8 *d3d, HWND device_window, HWND focus_window, BOOL windowed)
{
    D3DPRESENT_PARAMETERS present_parameters = {0};
    IDirect3DDevice8 *device;

    present_parameters.Windowed = windowed;
    present_parameters.hDeviceWindow = device_window;
    present_parameters.SwapEffect = D3DSWAPEFFECT_DISCARD;
    present_parameters.BackBufferWidth = 640;
    present_parameters.BackBufferHeight = 480;
    present_parameters.BackBufferFormat = D3DFMT_A8R8G8B8;
    present_parameters.EnableAutoDepthStencil = TRUE;
    present_parameters.AutoDepthStencilFormat = D3DFMT_D24S8;

    if (SUCCEEDED(IDirect3D8_CreateDevice(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, focus_window,
            D3DCREATE_HARDWARE_VERTEXPROCESSING, &present_parameters, &device)))
        return device;

    return NULL;
}

static bool init_test_context(struct d3d8_test_context *context)
{
    HRESULT hr;

    memset(context, 0, sizeof(*context));

    context->window = create_window();
    context->d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!context->d3d, "Failed to create a D3D object.\n");
    if (!(context->device = create_device(context->d3d, context->window, context->window, TRUE)))
    {
        skip("Failed to create a D3D device.\n");
        IDirect3D8_Release(context->d3d);
        DestroyWindow(context->window);
        return false;
    }

    hr = IDirect3DDevice8_GetRenderTarget(context->device, &context->backbuffer);
    ok(hr == S_OK, "Failed to get backbuffer, hr %#lx.\n", hr);

    return true;
}

#define release_test_context(a) release_test_context_(__LINE__, a)
static void release_test_context_(unsigned int line, struct d3d8_test_context *context)
{
    ULONG refcount;

    IDirect3DSurface8_Release(context->backbuffer);
    refcount = IDirect3DDevice8_Release(context->device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    refcount = IDirect3D8_Release(context->d3d);
    ok(!refcount, "D3D object has %lu references left.\n", refcount);
    DestroyWindow(context->window);
}

static void draw_textured_quad(struct d3d8_test_context *context, IDirect3DTexture8 *texture)
{
    IDirect3DDevice8 *device = context->device;
    HRESULT hr;

    static const struct
    {
        struct vec3 position;
        struct vec2 texcoord;
    }
    quad[] =
    {
        {{-1.0f, -1.0f, 0.0f}, {0.0f, 0.0f}},
        {{-1.0f,  1.0f, 0.0f}, {0.0f, 1.0f}},
        {{ 1.0f, -1.0f, 0.0f}, {1.0f, 0.0f}},
        {{ 1.0f,  1.0f, 0.0f}, {1.0f, 1.0f}},
    };

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZENABLE, FALSE);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_TEX1);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_COLOROP, D3DTOP_SELECTARG1);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_COLORARG1, D3DTA_TEXTURE);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *)texture);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_BeginScene(device);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, &quad, sizeof(*quad));
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
}

static HRESULT reset_device(struct d3d8_test_context *context)
{
    D3DPRESENT_PARAMETERS present_parameters = {0};
    HRESULT hr;

    IDirect3DSurface8_Release(context->backbuffer);

    present_parameters.BackBufferWidth = 640;
    present_parameters.BackBufferHeight = 480;
    present_parameters.BackBufferFormat = D3DFMT_A8R8G8B8;
    present_parameters.SwapEffect = D3DSWAPEFFECT_DISCARD;
    present_parameters.hDeviceWindow = context->window;
    present_parameters.Windowed = TRUE;
    present_parameters.EnableAutoDepthStencil = TRUE;
    present_parameters.AutoDepthStencilFormat = D3DFMT_D24S8;
    hr = IDirect3DDevice8_Reset(context->device, &present_parameters);

    if (SUCCEEDED(hr))
        IDirect3DDevice8_GetRenderTarget(context->device, &context->backbuffer);

    return hr;
}

static void test_sanity(void)
{
    IDirect3DDevice8 *device;
    unsigned int color;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xffff0000, 1.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);
    color = getPixelColor(device, 1, 1);
    ok(color == 0x00ff0000, "Got unexpected color 0x%08x.\n", color);

    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xff00ddee, 1.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);
    color = getPixelColor(device, 639, 479);
    ok(color == 0x0000ddee, "Got unexpected color 0x%08x.\n", color);

    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void lighting_test(void)
{
    DWORD nfvf = D3DFVF_XYZ | D3DFVF_DIFFUSE | D3DFVF_NORMAL;
    DWORD fvf = D3DFVF_XYZ | D3DFVF_DIFFUSE;
    IDirect3DDevice8 *device;
    unsigned int color, i;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    static const struct
    {
        struct vec3 position;
        DWORD diffuse;
    }
    unlitquad[] =
    {
        {{-1.0f, -1.0f, 0.1f}, 0xffff0000},
        {{-1.0f,  0.0f, 0.1f}, 0xffff0000},
        {{ 0.0f,  0.0f, 0.1f}, 0xffff0000},
        {{ 0.0f, -1.0f, 0.1f}, 0xffff0000},
    },
    litquad[] =
    {
        {{-1.0f,  0.0f, 0.1f}, 0xff00ff00},
        {{-1.0f,  1.0f, 0.1f}, 0xff00ff00},
        {{ 0.0f,  1.0f, 0.1f}, 0xff00ff00},
        {{ 0.0f,  0.0f, 0.1f}, 0xff00ff00},
    };
    static const struct
    {
        struct vec3 position;
        struct vec3 normal;
        DWORD diffuse;
    }
    unlitnquad[] =
    {
        {{0.0f, -1.0f, 0.1f}, {1.0f, 1.0f, 1.0f}, 0xff0000ff},
        {{0.0f,  0.0f, 0.1f}, {1.0f, 1.0f, 1.0f}, 0xff0000ff},
        {{1.0f,  0.0f, 0.1f}, {1.0f, 1.0f, 1.0f}, 0xff0000ff},
        {{1.0f, -1.0f, 0.1f}, {1.0f, 1.0f, 1.0f}, 0xff0000ff},
    },
    litnquad[] =
    {
        {{0.0f,  0.0f, 0.1f}, {1.0f, 1.0f, 1.0f}, 0xffffff00},
        {{0.0f,  1.0f, 0.1f}, {1.0f, 1.0f, 1.0f}, 0xffffff00},
        {{1.0f,  1.0f, 0.1f}, {1.0f, 1.0f, 1.0f}, 0xffffff00},
        {{1.0f,  0.0f, 0.1f}, {1.0f, 1.0f, 1.0f}, 0xffffff00},
    },
    nquad[] =
    {
        {{-1.0f, -1.0f, 0.0f}, {0.0f, 0.0f, -1.0f}, 0xff0000ff},
        {{-1.0f,  1.0f, 0.0f}, {0.0f, 0.0f, -1.0f}, 0xff0000ff},
        {{ 1.0f,  1.0f, 0.0f}, {0.0f, 0.0f, -1.0f}, 0xff0000ff},
        {{ 1.0f, -1.0f, 0.0f}, {0.0f, 0.0f, -1.0f}, 0xff0000ff},
    },
    rotatedquad[] =
    {
        {{-10.0f, -11.0f, 11.0f}, {-1.0f, 0.0f, 0.0f}, 0xff0000ff},
        {{-10.0f,  -9.0f, 11.0f}, {-1.0f, 0.0f, 0.0f}, 0xff0000ff},
        {{-10.0f,  -9.0f,  9.0f}, {-1.0f, 0.0f, 0.0f}, 0xff0000ff},
        {{-10.0f, -11.0f,  9.0f}, {-1.0f, 0.0f, 0.0f}, 0xff0000ff},
    },
    translatedquad[] =
    {
        {{-11.0f, -11.0f, -10.0f}, {0.0f, 0.0f, -1.0f}, 0xff0000ff},
        {{-11.0f,  -9.0f, -10.0f}, {0.0f, 0.0f, -1.0f}, 0xff0000ff},
        {{ -9.0f,  -9.0f, -10.0f}, {0.0f, 0.0f, -1.0f}, 0xff0000ff},
        {{ -9.0f, -11.0f, -10.0f}, {0.0f, 0.0f, -1.0f}, 0xff0000ff},
    };
    static const WORD indices[] = {0, 1, 2, 2, 3, 0};
    static const D3DMATRIX mat =
    {{{
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f,
    }}},
    mat_singular =
    {{{
        1.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        1.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.5f, 1.0f,
    }}},
    mat_transf =
    {{{
         0.0f,  0.0f,  1.0f, 0.0f,
         0.0f,  1.0f,  0.0f, 0.0f,
        -1.0f,  0.0f,  0.0f, 0.0f,
         10.f, 10.0f, 10.0f, 1.0f,
    }}},
    mat_nonaffine =
    {{{
        1.0f,  0.0f,  0.0f,  0.0f,
        0.0f,  1.0f,  0.0f,  0.0f,
        0.0f,  0.0f,  1.0f, -1.0f,
        10.f, 10.0f, 10.0f,  0.0f,
    }}};
    static const struct
    {
        const D3DMATRIX *world_matrix;
        const void *quad;
        unsigned int size;
        DWORD expected, broken;
        const char *message;
    }
    tests[] =
    {
        {&mat, nquad, sizeof(nquad[0]), 0x000000ff, 0xdeadbeef,
                "Lit quad with light"},
        /* Starting around Win10 20H? this test returns 0x00000000, but only
         * in d3d8. In ddraw and d3d9 it works like in older windows versions.
         * The behavior is GPU independent. */
        {&mat_singular, nquad, sizeof(nquad[0]), 0x000000ff, 0x00000000,
                "Lit quad with singular world matrix"},
        {&mat_transf, rotatedquad, sizeof(rotatedquad[0]), 0x000000ff, 0xdeadbeef,
                "Lit quad with transformation matrix"},
        {&mat_nonaffine, translatedquad, sizeof(translatedquad[0]), 0x00000000, 0xdeadbeef,
                "Lit quad with non-affine matrix"},
    };

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xffffffff, 0.0, 0);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTransform(device, D3DTS_WORLDMATRIX(0), &mat);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTransform(device, D3DTS_VIEW, &mat);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTransform(device, D3DTS_PROJECTION, &mat);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_CLIPPING, FALSE);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZENABLE, FALSE);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGENABLE, FALSE);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_STENCILENABLE, FALSE);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_CULLMODE, D3DCULL_NONE);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetVertexShader(device, fvf);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);

    /* No lights are defined... That means, lit vertices should be entirely black. */
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawIndexedPrimitiveUP(device, D3DPT_TRIANGLELIST, 0, 4,
            2, indices, D3DFMT_INDEX16, unlitquad, sizeof(unlitquad[0]));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, TRUE);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawIndexedPrimitiveUP(device, D3DPT_TRIANGLELIST, 0, 4,
            2, indices, D3DFMT_INDEX16, litquad, sizeof(litquad[0]));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetVertexShader(device, nfvf);
    ok(SUCCEEDED(hr), "Failed to set vertex shader, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawIndexedPrimitiveUP(device, D3DPT_TRIANGLELIST, 0, 4,
            2, indices, D3DFMT_INDEX16, unlitnquad, sizeof(unlitnquad[0]));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, TRUE);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawIndexedPrimitiveUP(device, D3DPT_TRIANGLELIST, 0, 4,
            2, indices, D3DFMT_INDEX16, litnquad, sizeof(litnquad[0]));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

    color = getPixelColor(device, 160, 360); /* Lower left quad - unlit without normals */
    ok(color == 0x00ff0000, "Unlit quad without normals has color 0x%08x, expected 0x00ff0000.\n", color);
    color = getPixelColor(device, 160, 120); /* Upper left quad - lit without normals */
    ok(color == 0x00000000, "Lit quad without normals has color 0x%08x, expected 0x00000000.\n", color);
    color = getPixelColor(device, 480, 360); /* Lower right quad - unlit with normals */
    ok(color == 0x000000ff, "Unlit quad with normals has color 0x%08x, expected 0x000000ff.\n", color);
    color = getPixelColor(device, 480, 120); /* Upper right quad - lit with normals */
    ok(color == 0x00000000, "Lit quad with normals has color 0x%08x, expected 0x00000000.\n", color);

    IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);

    hr = IDirect3DDevice8_LightEnable(device, 0, TRUE);
    ok(SUCCEEDED(hr), "Failed to enable light 0, hr %#lx.\n", hr);

    for (i = 0; i < ARRAY_SIZE(tests); ++i)
    {
        hr = IDirect3DDevice8_SetTransform(device, D3DTS_WORLD, tests[i].world_matrix);
        ok(SUCCEEDED(hr), "Failed to set world transform, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xffffffff, 0.0, 0);
        ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_BeginScene(device);
        ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_DrawIndexedPrimitiveUP(device, D3DPT_TRIANGLELIST, 0, 4,
                2, indices, D3DFMT_INDEX16, tests[i].quad, tests[i].size);
        ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_EndScene(device);
        ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

        color = getPixelColor(device, 320, 240);
        ok(color == tests[i].expected || broken(color == tests[i].broken),
                "%s has color 0x%08x.\n", tests[i].message, color);
    }

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_specular_lighting(void)
{
    static const unsigned int vertices_side = 5;
    const unsigned int indices_count = (vertices_side - 1) * (vertices_side - 1) * 2 * 3;
    static const DWORD fvf = D3DFVF_XYZ | D3DFVF_NORMAL;
    static const D3DMATRIX mat =
    {{{
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f,
    }}};
    static const D3DLIGHT8 directional =
    {
        D3DLIGHT_DIRECTIONAL,
        {0.0f, 0.0f, 0.0f, 0.0f},
        {1.0f, 1.0f, 1.0f, 0.0f},
        {0.0f, 0.0f, 0.0f, 0.0f},
        {0.0f, 0.0f, 0.0f},
        {0.0f, 0.0f, 1.0f},
    },
    point =
    {
        D3DLIGHT_POINT,
        {0.0f, 0.0f, 0.0f, 0.0f},
        {1.0f, 1.0f, 1.0f, 0.0f},
        {0.0f, 0.0f, 0.0f, 0.0f},
        {0.0f, 0.0f, 0.0f},
        {0.0f, 0.0f, 0.0f},
        100.0f,
        0.0f,
        0.0f, 0.0f, 1.0f,
    },
    spot =
    {
        D3DLIGHT_SPOT,
        {0.0f, 0.0f, 0.0f, 0.0f},
        {1.0f, 1.0f, 1.0f, 0.0f},
        {0.0f, 0.0f, 0.0f, 0.0f},
        {0.0f, 0.0f, 0.0f},
        {0.0f, 0.0f, 1.0f},
        100.0f,
        1.0f,
        0.0f, 0.0f, 1.0f,
        M_PI / 12.0f, M_PI / 3.0f
    },
    /* The chosen range value makes the test fail when using a manhattan
     * distance metric vs the correct euclidean distance. */
    point_range =
    {
        D3DLIGHT_POINT,
        {0.0f, 0.0f, 0.0f, 0.0f},
        {1.0f, 1.0f, 1.0f, 0.0f},
        {0.0f, 0.0f, 0.0f, 0.0f},
        {0.0f, 0.0f, 0.0f},
        {0.0f, 0.0f, 0.0f},
        1.2f,
        0.0f,
        0.0f, 0.0f, 1.0f,
    },
    point_side =
    {
        D3DLIGHT_POINT,
        {0.0f, 0.0f, 0.0f, 0.0f},
        {1.0f, 1.0f, 1.0f, 0.0f},
        {0.0f, 0.0f, 0.0f, 0.0f},
        {-1.1f, 0.0f, 1.1f},
        {0.0f, 0.0f, 0.0f},
        100.0f,
        0.0f,
        0.0f, 0.0f, 1.0f,
    };
    static const struct expected_color
    {
        unsigned int x, y, color;
    }
    expected_directional[] =
    {
        {160, 120, 0x00ffffff},
        {320, 120, 0x00ffffff},
        {480, 120, 0x00ffffff},
        {160, 240, 0x00ffffff},
        {320, 240, 0x00ffffff},
        {480, 240, 0x00ffffff},
        {160, 360, 0x00ffffff},
        {320, 360, 0x00ffffff},
        {480, 360, 0x00ffffff},
    },
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
    expected_point[] =
    {
        {160, 120, 0x00282828},
        {320, 120, 0x005a5a5a},
        {480, 120, 0x00282828},
        {160, 240, 0x005a5a5a},
        {320, 240, 0x00ffffff},
        {480, 240, 0x005a5a5a},
        {160, 360, 0x00282828},
        {320, 360, 0x005a5a5a},
        {480, 360, 0x00282828},
    },
    expected_point_local[] =
    {
        {160, 120, 0x00000000},
        {320, 120, 0x00070707},
        {480, 120, 0x00000000},
        {160, 240, 0x00070707},
        {320, 240, 0x00ffffff},
        {480, 240, 0x00070707},
        {160, 360, 0x00000000},
        {320, 360, 0x00070707},
        {480, 360, 0x00000000},
    },
    expected_spot[] =
    {
        {160, 120, 0x00000000},
        {320, 120, 0x00141414},
        {480, 120, 0x00000000},
        {160, 240, 0x00141414},
        {320, 240, 0x00ffffff},
        {480, 240, 0x00141414},
        {160, 360, 0x00000000},
        {320, 360, 0x00141414},
        {480, 360, 0x00000000},
    },
    expected_spot_local[] =
    {
        {160, 120, 0x00000000},
        {320, 120, 0x00020202},
        {480, 120, 0x00000000},
        {160, 240, 0x00020202},
        {320, 240, 0x00ffffff},
        {480, 240, 0x00020202},
        {160, 360, 0x00000000},
        {320, 360, 0x00020202},
        {480, 360, 0x00000000},
    },
    expected_point_range[] =
    {
        {160, 120, 0x00000000},
        {320, 120, 0x005a5a5a},
        {480, 120, 0x00000000},
        {160, 240, 0x005a5a5a},
        {320, 240, 0x00ffffff},
        {480, 240, 0x005a5a5a},
        {160, 360, 0x00000000},
        {320, 360, 0x005a5a5a},
        {480, 360, 0x00000000},
    },
    expected_point_side[] =
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
    },
    expected_directional_0[] =
    {
        {160, 120, 0x00ffffff},
        {320, 120, 0x00ffffff},
        {480, 120, 0x00ffffff},
        {160, 240, 0x00ffffff},
        {320, 240, 0x00ffffff},
        {480, 240, 0x00ffffff},
        {160, 360, 0x00ffffff},
        {320, 360, 0x00ffffff},
        {480, 360, 0x00ffffff},
    },
    expected_directional_local_0[] =
    {
        {160, 120, 0x00ffffff},
        {320, 120, 0x00ffffff},
        {480, 120, 0x00ffffff},
        {160, 240, 0x00ffffff},
        {320, 240, 0x00ffffff},
        {480, 240, 0x00ffffff},
        {160, 360, 0x00ffffff},
        {320, 360, 0x00ffffff},
        {480, 360, 0x00ffffff},
    },
    expected_point_0[] =
    {
        {160, 120, 0x00aaaaaa},
        {320, 120, 0x00cccccc},
        {480, 120, 0x00aaaaaa},
        {160, 240, 0x00cccccc},
        {320, 240, 0x00ffffff},
        {480, 240, 0x00cccccc},
        {160, 360, 0x00aaaaaa},
        {320, 360, 0x00cccccc},
        {480, 360, 0x00aaaaaa},
    },
    expected_spot_0[] =
    {
        {160, 120, 0x00000000},
        {320, 120, 0x002e2e2e},
        {480, 120, 0x00000000},
        {160, 240, 0x002e2e2e},
        {320, 240, 0x00ffffff},
        {480, 240, 0x002e2e2e},
        {160, 360, 0x00000000},
        {320, 360, 0x002e2e2e},
        {480, 360, 0x00000000},
    },
    expected_point_range_0[] =
    {
        {160, 120, 0x00000000},
        {320, 120, 0x00cccccc},
        {480, 120, 0x00000000},
        {160, 240, 0x00cccccc},
        {320, 240, 0x00ffffff},
        {480, 240, 0x00cccccc},
        {160, 360, 0x00000000},
        {320, 360, 0x00cccccc},
        {480, 360, 0x00000000},
    };
    static const struct
    {
        const D3DLIGHT8 *light;
        BOOL local_viewer;
        float specular_power;
        const struct expected_color *expected;
        unsigned int expected_count;
    }
    tests[] =
    {
        {&directional, FALSE, 30.0f, expected_directional, ARRAY_SIZE(expected_directional)},
        {&directional, TRUE, 30.0f, expected_directional_local, ARRAY_SIZE(expected_directional_local)},
        {&point, FALSE, 30.0f, expected_point, ARRAY_SIZE(expected_point)},
        {&point, TRUE, 30.0f, expected_point_local, ARRAY_SIZE(expected_point_local)},
        {&spot, FALSE, 30.0f, expected_spot, ARRAY_SIZE(expected_spot)},
        {&spot, TRUE, 30.0f, expected_spot_local, ARRAY_SIZE(expected_spot_local)},
        {&point_range, FALSE, 30.0f, expected_point_range, ARRAY_SIZE(expected_point_range)},
        {&point_side, TRUE, 0.0f, expected_point_side, ARRAY_SIZE(expected_point_side)},
        {&directional, FALSE, 0.0f, expected_directional_0, ARRAY_SIZE(expected_directional_0)},
        {&directional, TRUE, 0.0f, expected_directional_local_0, ARRAY_SIZE(expected_directional_local_0)},
        {&point, FALSE, 0.0f, expected_point_0, ARRAY_SIZE(expected_point_0)},
        {&point, TRUE, 0.0f, expected_point_0, ARRAY_SIZE(expected_point_0)},
        {&spot, FALSE, 0.0f, expected_spot_0, ARRAY_SIZE(expected_spot_0)},
        {&spot, TRUE, 0.0f, expected_spot_0, ARRAY_SIZE(expected_spot_0)},
        {&point_range, FALSE, 0.0f, expected_point_range_0, ARRAY_SIZE(expected_point_range_0)},
    };
    unsigned int color, i, j, x, y;
    IDirect3DDevice8 *device;
    D3DMATERIAL8 material;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;
    struct
    {
        struct vec3 position;
        struct vec3 normal;
    } *quad;
    WORD *indices;

    quad = malloc(vertices_side * vertices_side * sizeof(*quad));
    indices = malloc(indices_count * sizeof(*indices));
    for (i = 0, y = 0; y < vertices_side; ++y)
    {
        for (x = 0; x < vertices_side; ++x)
        {
            quad[i].position.x = x * 2.0f / (vertices_side - 1) - 1.0f;
            quad[i].position.y = y * 2.0f / (vertices_side - 1) - 1.0f;
            quad[i].position.z = 1.0f;
            quad[i].normal.x = 0.0f;
            quad[i].normal.y = 0.0f;
            quad[i++].normal.z = -1.0f;
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

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    hr = IDirect3DDevice8_SetTransform(device, D3DTS_WORLD, &mat);
    ok(SUCCEEDED(hr), "Failed to set world transform, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTransform(device, D3DTS_VIEW, &mat);
    ok(SUCCEEDED(hr), "Failed to set view transform, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTransform(device, D3DTS_PROJECTION, &mat);
    ok(SUCCEEDED(hr), "Failed to set projection transform, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_CLIPPING, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable clipping, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZENABLE, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable z test, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGENABLE, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable fog, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetVertexShader(device, fvf);
    ok(SUCCEEDED(hr), "Failed to set FVF, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_LightEnable(device, 0, TRUE);
    ok(SUCCEEDED(hr), "Failed to enable light 0, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_SPECULARENABLE, TRUE);
    ok(SUCCEEDED(hr), "Failed to enable specular lighting, hr %#lx.\n", hr);

    for (i = 0; i < ARRAY_SIZE(tests); ++i)
    {
        hr = IDirect3DDevice8_SetLight(device, 0, tests[i].light);
        ok(SUCCEEDED(hr), "Failed to set light parameters, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LOCALVIEWER, tests[i].local_viewer);
        ok(SUCCEEDED(hr), "Failed to set local viewer state, hr %#lx.\n", hr);

        memset(&material, 0, sizeof(material));
        material.Specular.r = 1.0f;
        material.Specular.g = 1.0f;
        material.Specular.b = 1.0f;
        material.Specular.a = 1.0f;
        material.Power = tests[i].specular_power;
        hr = IDirect3DDevice8_SetMaterial(device, &material);
        ok(SUCCEEDED(hr), "Failed to set material, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xff00ff00, 0.0, 0);
        ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_BeginScene(device);
        ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_DrawIndexedPrimitiveUP(device, D3DPT_TRIANGLELIST,
                0, vertices_side * vertices_side, indices_count / 3, indices,
                D3DFMT_INDEX16, quad, sizeof(quad[0]));
        ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_EndScene(device);
        ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

        for (j = 0; j < tests[i].expected_count; ++j)
        {
            color = getPixelColor(device, tests[i].expected[j].x, tests[i].expected[j].y);
            ok(color_match(color, tests[i].expected[j].color, 1),
                    "Expected color 0x%08x at location (%u, %u), got 0x%08x, case %u.\n",
                    tests[i].expected[j].color, tests[i].expected[j].x,
                    tests[i].expected[j].y, color, i);
        }
    }

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
    free(indices);
    free(quad);
}

static void clear_test(void)
{
    /* Tests the correctness of clearing parameters */
    D3DRECT rect_negneg, rect[2];
    IDirect3DDevice8 *device;
    unsigned int color;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xffffffff, 0.0, 0);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    /* Positive x, negative y */
    rect[0].x1 = 0;
    rect[0].y1 = 480;
    rect[0].x2 = 320;
    rect[0].y2 = 240;

    /* Positive x, positive y */
    rect[1].x1 = 0;
    rect[1].y1 = 0;
    rect[1].x2 = 320;
    rect[1].y2 = 240;
    /* Clear 2 rectangles with one call. Shows that a positive value is returned, but the negative rectangle
     * is ignored, the positive is still cleared afterwards
     */
    hr = IDirect3DDevice8_Clear(device, 2, rect, D3DCLEAR_TARGET, 0xffff0000, 0.0, 0);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    /* negative x, negative y */
    rect_negneg.x1 = 640;
    rect_negneg.y1 = 240;
    rect_negneg.x2 = 320;
    rect_negneg.y2 = 0;
    hr = IDirect3DDevice8_Clear(device, 1, &rect_negneg, D3DCLEAR_TARGET, 0xff00ff00, 0.0, 0);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    color = getPixelColor(device, 160, 360); /* lower left quad */
    ok(color == 0x00ffffff, "Clear rectangle 3(pos, neg) has color %08x\n", color);
    color = getPixelColor(device, 160, 120); /* upper left quad */
    ok(color == 0x00ff0000, "Clear rectangle 1(pos, pos) has color %08x\n", color);
    color = getPixelColor(device, 480, 360); /* lower right quad  */
    ok(color == 0x00ffffff, "Clear rectangle 4(NULL) has color %08x\n", color);
    color = getPixelColor(device, 480, 120); /* upper right quad */
    ok(color == 0x00ffffff, "Clear rectangle 4(neg, neg) has color %08x\n", color);

    IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xffffffff, 0.0, 0);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);

    rect[0].x1 = 0;
    rect[0].y1 = 0;
    rect[0].x2 = 640;
    rect[0].y2 = 480;
    hr = IDirect3DDevice8_Clear(device, 0, rect, D3DCLEAR_TARGET, 0xffff0000, 0.0, 0);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);

    color = getPixelColor(device, 320, 240);
    ok(color_match(color, D3DCOLOR_ARGB(0x00, 0xff, 0xff, 0xff), 1),
            "Clear with count = 0, rect != NULL has color %#08x\n", color);

    IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xffffffff, 0.0, 0);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Clear(device, 1, NULL, D3DCLEAR_TARGET, 0xff00ff00, 0.0, 0);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);

    color = getPixelColor(device, 320, 240);
    ok(color_match(color, D3DCOLOR_ARGB(0x00, 0x00, 0xff, 0x00), 1),
            "Clear with count = 1, rect = NULL has color %#08x\n", color);

    IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void fog_test(void)
{
    float start = 0.0f, end = 1.0f;
    IDirect3DDevice8 *device;
    unsigned int color;
    IDirect3D8 *d3d;
    ULONG refcount;
    D3DCAPS8 caps;
    HWND window;
    HRESULT hr;

    /* Gets full z based fog with linear fog, no fog with specular color. */
    static const struct
    {
        float x, y, z;
        D3DCOLOR diffuse;
        D3DCOLOR specular;
    }
    untransformed_1[] =
    {
        {-1.0f, -1.0f, 0.1f, 0xffff0000, 0xff000000},
        {-1.0f,  0.0f, 0.1f, 0xffff0000, 0xff000000},
        { 0.0f,  0.0f, 0.1f, 0xffff0000, 0xff000000},
        { 0.0f, -1.0f, 0.1f, 0xffff0000, 0xff000000},
    },
    /* Ok, I am too lazy to deal with transform matrices. */
    untransformed_2[] =
    {
        {-1.0f,  0.0f, 1.0f, 0xffff0000, 0xff000000},
        {-1.0f,  1.0f, 1.0f, 0xffff0000, 0xff000000},
        { 0.0f,  1.0f, 1.0f, 0xffff0000, 0xff000000},
        { 0.0f,  0.0f, 1.0f, 0xffff0000, 0xff000000},
    },
    far_quad1[] =
    {
        {-1.0f, -1.0f, 0.5f, 0xffff0000, 0xff000000},
        {-1.0f,  0.0f, 0.5f, 0xffff0000, 0xff000000},
        { 0.0f,  0.0f, 0.5f, 0xffff0000, 0xff000000},
        { 0.0f, -1.0f, 0.5f, 0xffff0000, 0xff000000},
    },
    far_quad2[] =
    {
        {-1.0f,  0.0f, 1.5f, 0xffff0000, 0xff000000},
        {-1.0f,  1.0f, 1.5f, 0xffff0000, 0xff000000},
        { 0.0f,  1.0f, 1.5f, 0xffff0000, 0xff000000},
        { 0.0f,  0.0f, 1.5f, 0xffff0000, 0xff000000},
    };

    /* Untransformed ones. Give them a different diffuse color to make the
     * test look nicer. It also makes making sure that they are drawn
     * correctly easier. */
    static const struct
    {
        float x, y, z, rhw;
        D3DCOLOR diffuse;
        D3DCOLOR specular;
    }
    transformed_1[] =
    {
        {320.0f,   0.0f, 1.0f, 1.0f, 0xffffff00, 0xff000000},
        {640.0f,   0.0f, 1.0f, 1.0f, 0xffffff00, 0xff000000},
        {640.0f, 240.0f, 1.0f, 1.0f, 0xffffff00, 0xff000000},
        {320.0f, 240.0f, 1.0f, 1.0f, 0xffffff00, 0xff000000},
    },
    transformed_2[] =
    {
        {320.0f, 240.0f, 1.0f, 1.0f, 0xffffff00, 0xff000000},
        {640.0f, 240.0f, 1.0f, 1.0f, 0xffffff00, 0xff000000},
        {640.0f, 480.0f, 1.0f, 1.0f, 0xffffff00, 0xff000000},
        {320.0f, 480.0f, 1.0f, 1.0f, 0xffffff00, 0xff000000},
    };
    static const D3DMATRIX ident_mat =
    {{{
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f,
    }}};
    static const D3DMATRIX world_mat1 =
    {{{
        1.0f, 0.0f,  0.0f, 0.0f,
        0.0f, 1.0f,  0.0f, 0.0f,
        0.0f, 0.0f,  1.0f, 0.0f,
        0.0f, 0.0f, -0.5f, 1.0f,
    }}};
    static const D3DMATRIX world_mat2 =
    {{{
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 1.0f,
    }}};
    static const D3DMATRIX proj_mat =
    {{{
        1.0f, 0.0f,  0.0f, 0.0f,
        0.0f, 1.0f,  0.0f, 0.0f,
        0.0f, 0.0f,  1.0f, 0.0f,
        0.0f, 0.0f, -1.0f, 1.0f,
    }}};
    static const WORD Indices[] = {0, 1, 2, 2, 3, 0};

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    memset(&caps, 0, sizeof(caps));
    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xffff00ff, 0.0, 0);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    /* Setup initial states: No lighting, fog on, fog color */
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZENABLE, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable D3DRS_ZENABLE, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGENABLE, TRUE);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGCOLOR, 0xFF00FF00 /* A nice green */);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    /* Some of the tests seem to depend on the projection matrix explicitly
     * being set to an identity matrix, even though that's the default.
     * (AMD Radeon HD 6310, Windows 7) */
    hr = IDirect3DDevice8_SetTransform(device, D3DTS_PROJECTION, &ident_mat);
    ok(SUCCEEDED(hr), "Failed to set projection transform, hr %#lx.\n", hr);

    /* First test: Both table fog and vertex fog off */
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGTABLEMODE, D3DFOG_NONE);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGVERTEXMODE, D3DFOG_NONE);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    /* Start = 0, end = 1. Should be default, but set them */
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGSTART, *((DWORD *) &start));
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGEND, *((DWORD *) &end));
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_DIFFUSE | D3DFVF_SPECULAR);
    ok(SUCCEEDED(hr), "Failed to set vertex shader, hr %#lx.\n", hr);
    /* Untransformed, vertex fog = NONE, table fog = NONE:
     * Read the fog weighting from the specular color. */
    hr = IDirect3DDevice8_DrawIndexedPrimitiveUP(device, D3DPT_TRIANGLELIST, 0 /* MinIndex */, 4 /* NumVerts */,
            2 /* PrimCount */, Indices, D3DFMT_INDEX16, untransformed_1, sizeof(untransformed_1[0]));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    /* This makes it use the Z value. */
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGVERTEXMODE, D3DFOG_LINEAR);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    /* Untransformed, vertex fog != none (or table fog != none):
     * Use the Z value as input into the equation. */
    hr = IDirect3DDevice8_DrawIndexedPrimitiveUP(device, D3DPT_TRIANGLELIST, 0 /* MinIndex */, 4 /* NumVerts */,
            2 /* PrimCount */, Indices, D3DFMT_INDEX16, untransformed_2, sizeof(untransformed_2[0]));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    /* Transformed vertices. */
    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZRHW | D3DFVF_DIFFUSE | D3DFVF_SPECULAR);
    ok(SUCCEEDED(hr), "Failed to set vertex shader, hr %#lx.\n", hr);
    /* Transformed, vertex fog != NONE, pixel fog == NONE:
     * Use specular color alpha component. */
    hr = IDirect3DDevice8_DrawIndexedPrimitiveUP(device, D3DPT_TRIANGLELIST, 0 /* MinIndex */, 4 /* NumVerts */,
            2 /* PrimCount */, Indices, D3DFMT_INDEX16, transformed_1, sizeof(transformed_1[0]));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGTABLEMODE, D3DFOG_LINEAR);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    /* Transformed, table fog != none, vertex anything:
     * Use Z value as input to the fog equation. */
    hr = IDirect3DDevice8_DrawIndexedPrimitiveUP(device, D3DPT_TRIANGLELIST, 0 /* MinIndex */, 4 /* NumVerts */,
            2 /* PrimCount */, Indices, D3DFMT_INDEX16, transformed_2, sizeof(transformed_2[0]));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

    color = getPixelColor(device, 160, 360);
    ok(color_match(color, D3DCOLOR_ARGB(0x00, 0xFF, 0x00, 0x00), 1),
            "Untransformed vertex with no table or vertex fog has color %08x\n", color);
    color = getPixelColor(device, 160, 120);
    ok(color_match(color, D3DCOLOR_ARGB(0x00, 0x00, 0xFF, 0x00), 1),
            "Untransformed vertex with linear vertex fog has color %08x\n", color);
    color = getPixelColor(device, 480, 120);
    ok(color_match(color, D3DCOLOR_ARGB(0x00, 0xFF, 0xFF, 0x00), 1),
            "Transformed vertex with linear vertex fog has color %08x\n", color);
    color = getPixelColor(device, 480, 360);
    ok(color_match(color, D3DCOLOR_ARGB(0x00, 0x00, 0xFF, 0x00), 1),
            "Transformed vertex with linear table fog has color %08x\n", color);

    IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);

    if (caps.RasterCaps & D3DPRASTERCAPS_FOGTABLE)
    {
        /* A simple fog + non-identity world matrix test */
        hr = IDirect3DDevice8_SetTransform(device, D3DTS_WORLDMATRIX(0), &world_mat1);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

        hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGTABLEMODE, D3DFOG_LINEAR);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGVERTEXMODE, D3DFOG_NONE);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

        hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xffff00ff, 0.0, 0);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

        hr = IDirect3DDevice8_BeginScene(device);
        ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_DIFFUSE | D3DFVF_SPECULAR);
        ok(SUCCEEDED(hr), "Failed to set vertex shader, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_DrawIndexedPrimitiveUP(device, D3DPT_TRIANGLELIST, 0, 4,
                2, Indices, D3DFMT_INDEX16, far_quad1, sizeof(far_quad1[0]));
        ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_DrawIndexedPrimitiveUP(device, D3DPT_TRIANGLELIST, 0, 4,
                2, Indices, D3DFMT_INDEX16, far_quad2, sizeof(far_quad2[0]));
        ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_EndScene(device);
        ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

        color = getPixelColor(device, 160, 360);
        ok(color_match(color, 0x00ff0000, 4), "Unfogged quad has color %08x\n", color);
        color = getPixelColor(device, 160, 120);
        ok(color_match(color, D3DCOLOR_ARGB(0x00, 0x00, 0xff, 0x00), 1),
                "Fogged out quad has color %08x\n", color);

        IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);

        /* Test fog behavior with an orthogonal (but not identity) projection matrix */
        hr = IDirect3DDevice8_SetTransform(device, D3DTS_WORLDMATRIX(0), &world_mat2);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetTransform(device, D3DTS_PROJECTION, &proj_mat);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

        hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xffff00ff, 0.0, 0);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

        hr = IDirect3DDevice8_BeginScene(device);
        ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_DIFFUSE | D3DFVF_SPECULAR);
        ok(SUCCEEDED(hr), "Failed to set vertex shader, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_DrawIndexedPrimitiveUP(device, D3DPT_TRIANGLELIST, 0, 4,
                2, Indices, D3DFMT_INDEX16, untransformed_1, sizeof(untransformed_1[0]));
        ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_DrawIndexedPrimitiveUP(device, D3DPT_TRIANGLELIST, 0, 4,
                2, Indices, D3DFMT_INDEX16, untransformed_2, sizeof(untransformed_2[0]));
        ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_EndScene(device);
        ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

        color = getPixelColor(device, 160, 360);
        ok(color_match(color, 0x00e51900, 4), "Partially fogged quad has color %08x\n", color);
        color = getPixelColor(device, 160, 120);
        ok(color_match(color, D3DCOLOR_ARGB(0x00, 0x00, 0xff, 0x00), 1),
                "Fogged out quad has color %08x\n", color);

        IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    }
    else
    {
        skip("D3DPRASTERCAPS_FOGTABLE not supported, skipping some fog tests\n");
    }

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

/* This tests fog in combination with shaders.
 * What's tested: linear fog (vertex and table) with pixel shader
 *                linear table fog with non foggy vertex shader
 *                vertex fog with foggy vertex shader, non-linear
 *                fog with shader, non-linear fog with foggy shader,
 *                linear table fog with foggy shader */
static void fog_with_shader_test(void)
{
    /* Fill the null-shader entry with the FVF (SetVertexShader is "overloaded" on d3d8...) */
    DWORD vertex_shader[3] = {D3DFVF_XYZ | D3DFVF_DIFFUSE, 0, 0};
    DWORD pixel_shader[2] = {0, 0};
    IDirect3DDevice8 *device;
    unsigned int color, i, j;
    IDirect3D8 *d3d;
    ULONG refcount;
    D3DCAPS8 caps;
    HWND window;
    HRESULT hr;
    union
    {
        float f;
        DWORD i;
    } start, end;

    /* Basic vertex shader without fog computation ("non foggy") */
    static const DWORD vertex_shader_code1[] =
    {
        0xfffe0100,                                                             /* vs.1.0                       */
        0x00000001, 0xc00f0000, 0x90e40000,                                     /* mov oPos, v0                 */
        0x00000001, 0xd00f0000, 0x90e40001,                                     /* mov oD0, v1                  */
        0x0000ffff
    };
    /* Basic vertex shader with reversed fog computation ("foggy") */
    static const DWORD vertex_shader_code2[] =
    {
        0xfffe0100,                                                             /* vs.1.0                        */
        0x00000001, 0xc00f0000, 0x90e40000,                                     /* mov oPos, v0                  */
        0x00000001, 0xd00f0000, 0x90e40001,                                     /* mov oD0, v1                   */
        0x00000002, 0x800f0000, 0x90aa0000, 0xa0aa0000,                         /* add r0, v0.z, c0.z            */
        0x00000005, 0xc00f0001, 0x80000000, 0xa0000000,                         /* mul oFog, r0.x, c0.x          */
        0x0000ffff
    };
    /* Basic pixel shader */
    static const DWORD pixel_shader_code[] =
    {
        0xffff0101,                                                             /* ps_1_1     */
        0x00000001, 0x800f0000, 0x90e40000,                                     /* mov r0, v0 */
        0x0000ffff
    };
    static struct
    {
        struct vec3 position;
        DWORD diffuse;
    }
    quad[] =
    {
        {{-1.0f, -1.0f, 0.0f}, 0xffff0000},
        {{-1.0f,  1.0f, 0.0f}, 0xffff0000},
        {{ 1.0f, -1.0f, 0.0f}, 0xffff0000},
        {{ 1.0f,  1.0f, 0.0f}, 0xffff0000},
    };
    static const DWORD decl[] =
    {
        D3DVSD_STREAM(0),
        D3DVSD_REG(0, D3DVSDT_FLOAT3),  /* position, v0 */
        D3DVSD_REG(1, D3DVSDT_D3DCOLOR),  /* diffuse color, v1 */
        D3DVSD_END()
    };
    static const float vs_constant[4] = {-1.25f, 0.0f, -0.9f, 0.0f};
    /* This reference data was collected on a nVidia GeForce 7600GS
     * driver version 84.19 DirectX version 9.0c on Windows XP */
    static const struct test_data_t
    {
        int vshader;
        int pshader;
        D3DFOGMODE vfog;
        D3DFOGMODE tfog;
        BOOL uninitialized_reg;
        unsigned int color[11];
    }
    test_data[] =
    {
        /* Only pixel shader */
        {0, 1, D3DFOG_NONE, D3DFOG_LINEAR, FALSE,
        {0x00ff0000, 0x00ff0000, 0x00df2000, 0x00bf4000, 0x009f6000, 0x007f8000,
        0x005fa000, 0x0040bf00, 0x0020df00, 0x0000ff00, 0x0000ff00}},
        {0, 1, D3DFOG_EXP, D3DFOG_LINEAR, FALSE,
        {0x00ff0000, 0x00ff0000, 0x00df2000, 0x00bf4000, 0x009f6000, 0x007f8000,
        0x005fa000, 0x0040bf00, 0x0020df00, 0x0000ff00, 0x0000ff00}},
        {0, 1, D3DFOG_EXP2, D3DFOG_LINEAR, FALSE,
        {0x00ff0000, 0x00ff0000, 0x00df2000, 0x00bf4000, 0x009f6000, 0x007f8000,
        0x005fa000, 0x0040bf00, 0x0020df00, 0x0000ff00, 0x0000ff00}},
        {0, 1, D3DFOG_LINEAR, D3DFOG_NONE, FALSE,
        {0x00ff0000, 0x00ff0000, 0x00df2000, 0x00bf4000, 0x009f6000, 0x007f8000,
        0x005fa000, 0x0040bf00, 0x0020df00, 0x0000ff00, 0x0000ff00}},
        {0, 1, D3DFOG_LINEAR, D3DFOG_LINEAR, FALSE,
        {0x00ff0000, 0x00ff0000, 0x00df2000, 0x00bf4000, 0x009f6000, 0x007f8000,
        0x005fa000, 0x0040bf00, 0x0020df00, 0x0000ff00, 0x0000ff00}},

        /* Vertex shader */
        {1, 0, D3DFOG_NONE, D3DFOG_NONE, TRUE,
        {0x0000ff00, 0x0000ff00, 0x0000ff00, 0x0000ff00, 0x0000ff00, 0x0000ff00,
         0x0000ff00, 0x0000ff00, 0x0000ff00, 0x0000ff00, 0x0000ff00}},
        {1, 0, D3DFOG_NONE, D3DFOG_LINEAR, FALSE,
        {0x00ff0000, 0x00ff0000, 0x00df2000, 0x00bf4000, 0x009f6000, 0x007f8000,
        0x005fa000, 0x0040bf00, 0x0020df00, 0x0000ff00, 0x0000ff00}},
        {1, 0, D3DFOG_EXP, D3DFOG_LINEAR, FALSE,
        {0x00ff0000, 0x00ff0000, 0x00df2000, 0x00bf4000, 0x009f6000, 0x007f8000,
        0x005fa000, 0x0040bf00, 0x0020df00, 0x0000ff00, 0x0000ff00}},

        {1, 0, D3DFOG_EXP2, D3DFOG_LINEAR, FALSE,
        {0x00ff0000, 0x00ff0000, 0x00df2000, 0x00bf4000, 0x009f6000, 0x007f8000,
        0x005fa000, 0x0040bf00, 0x0020df00, 0x0000ff00, 0x0000ff00}},
        {1, 0, D3DFOG_LINEAR, D3DFOG_LINEAR, FALSE,
        {0x00ff0000, 0x00ff0000, 0x00df2000, 0x00bf4000, 0x009f6000, 0x007f8000,
        0x005fa000, 0x0040bf00, 0x0020df00, 0x0000ff00, 0x0000ff00}},

        /* Vertex shader and pixel shader */
        /* The next 4 tests would read the fog coord output, but it isn't available.
         * The result is a fully fogged quad, no matter what the Z coord is. */
        {1, 1, D3DFOG_NONE, D3DFOG_NONE, TRUE,
        {0x0000ff00, 0x0000ff00, 0x0000ff00, 0x0000ff00, 0x0000ff00, 0x0000ff00,
        0x0000ff00, 0x0000ff00, 0x0000ff00, 0x0000ff00, 0x0000ff00}},
        {1, 1, D3DFOG_LINEAR, D3DFOG_NONE, TRUE,
        {0x0000ff00, 0x0000ff00, 0x0000ff00, 0x0000ff00, 0x0000ff00, 0x0000ff00,
        0x0000ff00, 0x0000ff00, 0x0000ff00, 0x0000ff00, 0x0000ff00}},
        {1, 1, D3DFOG_EXP, D3DFOG_NONE, TRUE,
        {0x0000ff00, 0x0000ff00, 0x0000ff00, 0x0000ff00, 0x0000ff00, 0x0000ff00,
        0x0000ff00, 0x0000ff00, 0x0000ff00, 0x0000ff00, 0x0000ff00}},
        {1, 1, D3DFOG_EXP2, D3DFOG_NONE, TRUE,
        {0x0000ff00, 0x0000ff00, 0x0000ff00, 0x0000ff00, 0x0000ff00, 0x0000ff00,
        0x0000ff00, 0x0000ff00, 0x0000ff00, 0x0000ff00, 0x0000ff00}},

        /* These use the Z coordinate with linear table fog */
        {1, 1, D3DFOG_NONE, D3DFOG_LINEAR, FALSE,
        {0x00ff0000, 0x00ff0000, 0x00df2000, 0x00bf4000, 0x009f6000, 0x007f8000,
        0x005fa000, 0x0040bf00, 0x0020df00, 0x0000ff00, 0x0000ff00}},
        {1, 1, D3DFOG_EXP, D3DFOG_LINEAR, FALSE,
        {0x00ff0000, 0x00ff0000, 0x00df2000, 0x00bf4000, 0x009f6000, 0x007f8000,
        0x005fa000, 0x0040bf00, 0x0020df00, 0x0000ff00, 0x0000ff00}},
        {1, 1, D3DFOG_EXP2, D3DFOG_LINEAR, FALSE,
        {0x00ff0000, 0x00ff0000, 0x00df2000, 0x00bf4000, 0x009f6000, 0x007f8000,
        0x005fa000, 0x0040bf00, 0x0020df00, 0x0000ff00, 0x0000ff00}},
        {1, 1, D3DFOG_LINEAR, D3DFOG_LINEAR, FALSE,
        {0x00ff0000, 0x00ff0000, 0x00df2000, 0x00bf4000, 0x009f6000, 0x007f8000,
        0x005fa000, 0x0040bf00, 0x0020df00, 0x0000ff00, 0x0000ff00}},

        /* Non-linear table fog without fog coord */
        {1, 1, D3DFOG_NONE, D3DFOG_EXP, FALSE,
        {0x00ff0000, 0x00e71800, 0x00d12e00, 0x00bd4200, 0x00ab5400, 0x009b6400,
        0x008d7200, 0x007f8000, 0x00738c00, 0x00689700, 0x005ea100}},
        {1, 1, D3DFOG_NONE, D3DFOG_EXP2, FALSE,
        {0x00fd0200, 0x00f50200, 0x00f50a00, 0x00e91600, 0x00d92600, 0x00c73800,
        0x00b24d00, 0x009c6300, 0x00867900, 0x00728d00, 0x005ea100}},

        /* These tests fail on older Nvidia drivers */
        /* Foggy vertex shader */
        {2, 0, D3DFOG_NONE, D3DFOG_NONE, FALSE,
        {0x00ff0000, 0x00fe0100, 0x00de2100, 0x00bf4000, 0x009f6000, 0x007f8000,
        0x005fa000, 0x003fc000, 0x001fe000, 0x0000ff00, 0x0000ff00}},
        {2, 0, D3DFOG_EXP, D3DFOG_NONE, FALSE,
        {0x00ff0000, 0x00fe0100, 0x00de2100, 0x00bf4000, 0x009f6000, 0x007f8000,
        0x005fa000, 0x003fc000, 0x001fe000, 0x0000ff00, 0x0000ff00}},
        {2, 0, D3DFOG_EXP2, D3DFOG_NONE, FALSE,
        {0x00ff0000, 0x00fe0100, 0x00de2100, 0x00bf4000, 0x009f6000, 0x007f8000,
        0x005fa000, 0x003fc000, 0x001fe000, 0x0000ff00, 0x0000ff00}},
        {2, 0, D3DFOG_LINEAR, D3DFOG_NONE, FALSE,
        {0x00ff0000, 0x00fe0100, 0x00de2100, 0x00bf4000, 0x009f6000, 0x007f8000,
        0x005fa000, 0x003fc000, 0x001fe000, 0x0000ff00, 0x0000ff00}},

        /* Foggy vertex shader and pixel shader. First 4 tests with vertex fog,
         * all using the fixed fog-coord linear fog */
        {2, 1, D3DFOG_NONE, D3DFOG_NONE, FALSE,
        {0x00ff0000, 0x00fe0100, 0x00de2100, 0x00bf4000, 0x009f6000, 0x007f8000,
        0x005fa000, 0x003fc000, 0x001fe000, 0x0000ff00, 0x0000ff00}},
        {2, 1, D3DFOG_EXP, D3DFOG_NONE, FALSE,
        {0x00ff0000, 0x00fe0100, 0x00de2100, 0x00bf4000, 0x009f6000, 0x007f8000,
        0x005fa000, 0x003fc000, 0x001fe000, 0x0000ff00, 0x0000ff00}},
        {2, 1, D3DFOG_EXP2, D3DFOG_NONE, FALSE,
        {0x00ff0000, 0x00fe0100, 0x00de2100, 0x00bf4000, 0x009f6000, 0x007f8000,
        0x005fa000, 0x003fc000, 0x001fe000, 0x0000ff00, 0x0000ff00}},
        {2, 1, D3DFOG_LINEAR, D3DFOG_NONE, FALSE,
        {0x00ff0000, 0x00fe0100, 0x00de2100, 0x00bf4000, 0x009f6000, 0x007f8000,
        0x005fa000, 0x003fc000, 0x001fe000, 0x0000ff00, 0x0000ff00}},

        /* These use table fog. Here the shader-provided fog coordinate is
         * ignored and the z coordinate used instead */
        {2, 1, D3DFOG_NONE, D3DFOG_EXP, FALSE,
        {0x00ff0000, 0x00e71800, 0x00d12e00, 0x00bd4200, 0x00ab5400, 0x009b6400,
        0x008d7200, 0x007f8000, 0x00738c00, 0x00689700, 0x005ea100}},
        {2, 1, D3DFOG_NONE, D3DFOG_EXP2, FALSE,
        {0x00fd0200, 0x00f50200, 0x00f50a00, 0x00e91600, 0x00d92600, 0x00c73800,
        0x00b24d00, 0x009c6300, 0x00867900, 0x00728d00, 0x005ea100}},
        {2, 1, D3DFOG_NONE, D3DFOG_LINEAR, FALSE,
        {0x00ff0000, 0x00ff0000, 0x00df2000, 0x00bf4000, 0x009f6000, 0x007f8000,
        0x005fa000, 0x0040bf00, 0x0020df00, 0x0000ff00, 0x0000ff00}},
    };
    static const D3DMATRIX identity =
    {{{
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f,
    }}};

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get device caps, hr %#lx.\n", hr);
    if (caps.VertexShaderVersion < D3DVS_VERSION(1, 1) || caps.PixelShaderVersion < D3DPS_VERSION(1, 1))
    {
        skip("No vs_1_1 / ps_1_1 support, skipping tests.\n");
        IDirect3DDevice8_Release(device);
        goto done;
    }

    /* NOTE: changing these values will not affect the tests with foggy vertex
     * shader, as the values are hardcoded in the shader constant. */
    start.f = 0.1f;
    end.f = 0.9f;

    /* Some of the tests seem to depend on the projection matrix explicitly
     * being set to an identity matrix, even though that's the default.
     * (AMD Radeon HD 6310, Windows 7) */
    hr = IDirect3DDevice8_SetTransform(device, D3DTS_PROJECTION, &identity);
    ok(SUCCEEDED(hr), "Failed to set projection transform, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CreateVertexShader(device, decl, vertex_shader_code1, &vertex_shader[1], 0);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateVertexShader(device, decl, vertex_shader_code2, &vertex_shader[2], 0);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreatePixelShader(device, pixel_shader_code, &pixel_shader[1]);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);

    /* Set shader constant value */
    hr = IDirect3DDevice8_SetVertexShader(device, vertex_shader[2]);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetVertexShaderConstant(device, 0, vs_constant, 1);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    /* Setup initial states: No lighting, fog on, fog color */
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGENABLE, TRUE);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGCOLOR, 0xFF00FF00 /* A nice green */);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGTABLEMODE, D3DFOG_NONE);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGVERTEXMODE, D3DFOG_NONE);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    /* Use fogtart = 0.1 and end = 0.9 to test behavior outside the fog transition phase, too */
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGSTART, start.i);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGEND, end.i);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    for (i = 0; i < ARRAY_SIZE(test_data); ++i)
    {
        hr = IDirect3DDevice8_SetVertexShader(device, vertex_shader[test_data[i].vshader]);
        ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetPixelShader(device, pixel_shader[test_data[i].pshader]);
        ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGVERTEXMODE, test_data[i].vfog);
        ok( hr == D3D_OK, "Got hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGTABLEMODE, test_data[i].tfog);
        ok( hr == D3D_OK, "Got hr %#lx.\n", hr);

        for(j = 0; j < 11; ++j)
        {
            /* Don't use the whole zrange to prevent rounding errors */
            quad[0].position.z = 0.001f + j / 10.02f;
            quad[1].position.z = 0.001f + j / 10.02f;
            quad[2].position.z = 0.001f + j / 10.02f;
            quad[3].position.z = 0.001f + j / 10.02f;

            hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0xffff00ff, 1.0f, 0);
            ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

            hr = IDirect3DDevice8_BeginScene(device);
            ok( hr == D3D_OK, "Got hr %#lx.\n", hr);

            hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, &quad[0], sizeof(quad[0]));
            ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);

            hr = IDirect3DDevice8_EndScene(device);
            ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

            /* As the red and green component are the result of blending use 5% tolerance on the expected value */
            color = getPixelColor(device, 128, 240);
            ok(color_match(color, test_data[i].color[j], 13) || broken(test_data[i].uninitialized_reg),
                    "fog vs%i ps%i fvm%i ftm%i %d: got color %08x, expected %08x +-5%%\n",
                    test_data[i].vshader, test_data[i].pshader,
                    test_data[i].vfog, test_data[i].tfog, j, color, test_data[i].color[j]);
        }
    }
    IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);

    IDirect3DDevice8_DeleteVertexShader(device, vertex_shader[1]);
    IDirect3DDevice8_DeleteVertexShader(device, vertex_shader[2]);
    IDirect3DDevice8_DeleteVertexShader(device, pixel_shader[1]);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void cnd_test(void)
{
    DWORD shader_11_coissue_2, shader_12_coissue_2, shader_13_coissue_2, shader_14_coissue_2;
    DWORD shader_11_coissue, shader_12_coissue, shader_13_coissue, shader_14_coissue;
    DWORD shader_11, shader_12, shader_13, shader_14;
    IDirect3DDevice8 *device;
    unsigned int color;
    IDirect3D8 *d3d;
    ULONG refcount;
    D3DCAPS8 caps;
    HWND window;
    HRESULT hr;

    /* ps 1.x shaders are rather picky with writemasks and source swizzles.
     * The dp3 is used to copy r0.r to all components of r1, then copy r1.a to
     * r0.a. Essentially it does a mov r0.a, r0.r, which isn't allowed as-is
     * in 1.x pixel shaders. */
    static const DWORD shader_code_11[] =
    {
        0xffff0101,                                                                 /* ps_1_1               */
        0x00000051, 0xa00f0000, 0x3f800000, 0x00000000, 0x00000000, 0x00000000,     /* def c0, 1, 0, 0, 0   */
        0x00000040, 0xb00f0000,                                                     /* texcoord t0          */
        0x00000001, 0x800f0000, 0xb0e40000,                                         /* mov r0, t0           */
        0x00000008, 0x800f0001, 0x80e40000, 0xa0e40000,                             /* dp3 r1, r0, c0       */
        0x00000001, 0x80080000, 0x80ff0001,                                         /* mov r0.a, r1.a       */
        0x00000050, 0x800f0000, 0x80ff0000, 0xa0e40001, 0xa0e40002,                 /* cnd r0, r0.a, c1, c2 */
        0x0000ffff                                                                  /* end                  */
    };
    static const DWORD shader_code_12[] =
    {
        0xffff0102,                                                                 /* ps_1_2               */
        0x00000051, 0xa00f0000, 0x3f800000, 0x00000000, 0x00000000, 0x00000000,     /* def c0, 1, 0, 0, 0   */
        0x00000040, 0xb00f0000,                                                     /* texcoord t0          */
        0x00000001, 0x800f0000, 0xb0e40000,                                         /* mov r0, t0           */
        0x00000008, 0x800f0001, 0x80e40000, 0xa0e40000,                             /* dp3 r1, r0, c0       */
        0x00000001, 0x80080000, 0x80ff0001,                                         /* mov r0.a, r1.a       */
        0x00000050, 0x800f0000, 0x80ff0000, 0xa0e40001, 0xa0e40002,                 /* cnd r0, r0.a, c1, c2 */
        0x0000ffff                                                                  /* end                  */
    };
    static const DWORD shader_code_13[] =
    {
        0xffff0103,                                                                 /* ps_1_3               */
        0x00000051, 0xa00f0000, 0x3f800000, 0x00000000, 0x00000000, 0x00000000,     /* def c0, 1, 0, 0, 0   */
        0x00000040, 0xb00f0000,                                                     /* texcoord t0          */
        0x00000001, 0x800f0000, 0xb0e40000,                                         /* mov r0, t0           */
        0x00000008, 0x800f0001, 0x80e40000, 0xa0e40000,                             /* dp3, r1, r0, c0      */
        0x00000001, 0x80080000, 0x80ff0001,                                         /* mov r0.a, r1.a       */
        0x00000050, 0x800f0000, 0x80ff0000, 0xa0e40001, 0xa0e40002,                 /* cnd r0, r0.a, c1, c2 */
        0x0000ffff                                                                  /* end                  */
    };
    static const DWORD shader_code_14[] =
    {
        0xffff0104,                                                                 /* ps_1_3               */
        0x00000051, 0xa00f0000, 0x00000000, 0x00000000, 0x00000000, 0x3f800000,     /* def c0, 0, 0, 0, 1   */
        0x00000040, 0x80070000, 0xb0e40000,                                         /* texcrd r0, t0        */
        0x00000001, 0x80080000, 0xa0ff0000,                                         /* mov r0.a, c0.a       */
        0x00000050, 0x800f0000, 0x80e40000, 0xa0e40001, 0xa0e40002,                 /* cnd r0, r0, c1, c2   */
        0x0000ffff                                                                  /* end                  */
    };

    /* Special fun: The coissue flag on cnd: Apparently cnd always selects the 2nd source,
     * as if the src0 comparison against 0.5 always evaluates to true. The coissue flag isn't
     * set by the compiler, it was added manually after compilation. Note that the COISSUE
     * flag on a color(.xyz) operation is only allowed after an alpha operation. DirectX doesn't
     * have proper docs, but GL_ATI_fragment_shader explains the pairing of color and alpha ops
     * well enough.
     *
     * The shader attempts to test the range [-1;1] against coissued cnd, which is a bit tricky.
     * The input from t0 is [0;1]. 0.5 is subtracted, then we have to multiply with 2. Since
     * constants are clamped to [-1;1], a 2.0 is constructed by adding c0.r(=1.0) to c0.r into r1.r,
     * then r1(2.0, 0.0, 0.0, 0.0) is passed to dp3(explained above).
     */
    static const DWORD shader_code_11_coissue[] =
    {
        0xffff0101,                                                             /* ps_1_1                   */
        0x00000051, 0xa00f0000, 0x3f800000, 0x00000000, 0x00000000, 0x00000000, /* def c0, 1, 0, 0, 0       */
        0x00000051, 0xa00f0003, 0x3f000000, 0x3f000000, 0x3f000000, 0x00000000, /* def c3, 0.5, 0.5, 0.5, 0 */
        0x00000040, 0xb00f0000,                                                 /* texcoord t0              */
        0x00000001, 0x800f0000, 0xb0e40000,                                     /* mov r0, t0               */
        0x00000003, 0x800f0000, 0x80e40000, 0xa0e40003,                         /* sub r0, r0, c3           */
        0x00000002, 0x800f0001, 0xa0e40000, 0xa0e40000,                         /* add r1, c0, c0           */
        0x00000008, 0x800f0001, 0x80e40000, 0x80e40001,                         /* dp3 r1, r0, r1           */
        0x00000001, 0x80080000, 0x80ff0001,                                     /* mov r0.a, r1.a           */
        0x40000050, 0x80070000, 0x80ff0000, 0xa0e40001, 0xa0e40002,             /* +cnd r0.xyz, r0.a, c1, c2*/
        0x0000ffff                                                              /* end                      */
    };
    static const DWORD shader_code_11_coissue_2[] =
    {
        0xffff0101,                                                             /* ps_1_1                   */
        0x00000051, 0xa00f0000, 0x3f800000, 0x00000000, 0x00000000, 0x00000000, /* def c0, 1, 0, 0, 0       */
        0x00000051, 0xa00f0003, 0x3f000000, 0x3f000000, 0x3f000000, 0x00000000, /* def c3, 0.5, 0.5, 0.5, 0 */
        0x00000040, 0xb00f0000,                                                 /* texcoord t0              */
        0x00000001, 0x800f0000, 0xb0e40000,                                     /* mov r0, t0               */
        0x00000003, 0x800f0000, 0x80e40000, 0xa0e40003,                         /* sub r0, r0, c3           */
        0x00000002, 0x800f0001, 0xa0e40000, 0xa0e40000,                         /* add r1, c0, c0           */
        0x00000008, 0x800f0001, 0x80e40000, 0x80e40001,                         /* dp3 r1, r0, r1           */
        0x00000001, 0x800f0000, 0x80e40001,                                     /* mov r0, r1               */
        0x00000001, 0x80070000, 0x80ff0001,                                     /* mov r0.xyz, r1.a         */
        0x40000050, 0x80080000, 0x80ff0000, 0xa0e40001, 0xa0e40002,             /* +cnd r0.a, r0.a, c1, c2  */
        0x00000001, 0x80070000, 0x80ff0000,                                     /* mov r0.xyz, r0.a         */
        0x0000ffff                                                              /* end                      */
    };
    static const DWORD shader_code_12_coissue[] =
    {
        0xffff0102,                                                             /* ps_1_2                   */
        0x00000051, 0xa00f0000, 0x3f800000, 0x00000000, 0x00000000, 0x00000000, /* def c0, 1, 0, 0, 0       */
        0x00000051, 0xa00f0003, 0x3f000000, 0x3f000000, 0x3f000000, 0x00000000, /* def c3, 0.5, 0.5, 0.5, 0 */
        0x00000040, 0xb00f0000,                                                 /* texcoord t0              */
        0x00000001, 0x800f0000, 0xb0e40000,                                     /* mov r0, t0               */
        0x00000003, 0x800f0000, 0x80e40000, 0xa0e40003,                         /* sub r0, r0, c3           */
        0x00000002, 0x800f0001, 0xa0e40000, 0xa0e40000,                         /* add r1, c0, c0           */
        0x00000008, 0x800f0001, 0x80e40000, 0x80e40001,                         /* dp3 r1, r0, r1           */
        0x00000001, 0x80080000, 0x80ff0001,                                     /* mov r0.a, r1.a           */
        0x40000050, 0x80070000, 0x80ff0000, 0xa0e40001, 0xa0e40002,             /* +cnd r0.xyz, r0.a, c1, c2*/
        0x0000ffff                                                              /* end                      */
    };
    static const DWORD shader_code_12_coissue_2[] =
    {
        0xffff0102,                                                             /* ps_1_2                   */
        0x00000051, 0xa00f0000, 0x3f800000, 0x00000000, 0x00000000, 0x00000000, /* def c0, 1, 0, 0, 0       */
        0x00000051, 0xa00f0003, 0x3f000000, 0x3f000000, 0x3f000000, 0x00000000, /* def c3, 0.5, 0.5, 0.5, 0 */
        0x00000040, 0xb00f0000,                                                 /* texcoord t0              */
        0x00000001, 0x800f0000, 0xb0e40000,                                     /* mov r0, t0               */
        0x00000003, 0x800f0000, 0x80e40000, 0xa0e40003,                         /* sub r0, r0, c3           */
        0x00000002, 0x800f0001, 0xa0e40000, 0xa0e40000,                         /* add r1, c0, c0           */
        0x00000008, 0x800f0001, 0x80e40000, 0x80e40001,                         /* dp3 r1, r0, r1           */
        0x00000001, 0x800f0000, 0x80e40001,                                     /* mov r0, r1               */
        0x00000001, 0x80070000, 0x80ff0001,                                     /* mov r0.xyz, r1.a         */
        0x40000050, 0x80080000, 0x80ff0000, 0xa0e40001, 0xa0e40002,             /* +cnd r0.a, r0.a, c1, c2  */
        0x00000001, 0x80070000, 0x80ff0000,                                     /* mov r0.xyz, r0.a         */
        0x0000ffff                                                              /* end                      */
    };
    static const DWORD shader_code_13_coissue[] =
    {
        0xffff0103,                                                             /* ps_1_3                   */
        0x00000051, 0xa00f0000, 0x3f800000, 0x00000000, 0x00000000, 0x00000000, /* def c0, 1, 0, 0, 0       */
        0x00000051, 0xa00f0003, 0x3f000000, 0x3f000000, 0x3f000000, 0x00000000, /* def c3, 0.5, 0.5, 0.5, 0 */
        0x00000040, 0xb00f0000,                                                 /* texcoord t0              */
        0x00000001, 0x800f0000, 0xb0e40000,                                     /* mov r0, t0               */
        0x00000003, 0x800f0000, 0x80e40000, 0xa0e40003,                         /* sub r0, r0, c3           */
        0x00000002, 0x800f0001, 0xa0e40000, 0xa0e40000,                         /* add r1, c0, c0           */
        0x00000008, 0x800f0001, 0x80e40000, 0x80e40001,                         /* dp3 r1, r0, r1           */
        0x00000001, 0x80080000, 0x80ff0001,                                     /* mov r0.a, r1.a           */
        0x40000050, 0x80070000, 0x80ff0000, 0xa0e40001, 0xa0e40002,             /* +cnd r0.xyz, r0.a, c1, c2*/
        0x0000ffff                                                              /* end                      */
    };
    static const DWORD shader_code_13_coissue_2[] =
    {
        0xffff0103,                                                             /* ps_1_3                   */
        0x00000051, 0xa00f0000, 0x3f800000, 0x00000000, 0x00000000, 0x00000000, /* def c0, 1, 0, 0, 0       */
        0x00000051, 0xa00f0003, 0x3f000000, 0x3f000000, 0x3f000000, 0x00000000, /* def c3, 0.5, 0.5, 0.5, 0 */
        0x00000040, 0xb00f0000,                                                 /* texcoord t0              */
        0x00000001, 0x800f0000, 0xb0e40000,                                     /* mov r0, t0               */
        0x00000003, 0x800f0000, 0x80e40000, 0xa0e40003,                         /* sub r0, r0, c3           */
        0x00000002, 0x800f0001, 0xa0e40000, 0xa0e40000,                         /* add r1, c0, c0           */
        0x00000008, 0x800f0001, 0x80e40000, 0x80e40001,                         /* dp3 r1, r0, r1           */
        0x00000001, 0x800f0000, 0x80e40001,                                     /* mov r0, r1               */
        0x00000001, 0x80070000, 0x80ff0001,                                     /* mov r0.xyz, r1.a         */
        0x40000050, 0x80080000, 0x80ff0000, 0xa0e40001, 0xa0e40002,             /* +cnd r0.a, r0.a, c1, c2  */
        0x00000001, 0x80070000, 0x80ff0000,                                     /* mov r0.xyz, r0.a         */
        0x0000ffff                                                              /* end                      */
    };
    /* ps_1_4 does not have a different cnd behavior, just pass the [0;1]
     * texcrd result to cnd, it will compare against 0.5. */
    static const DWORD shader_code_14_coissue[] =
    {
        0xffff0104,                                                             /* ps_1_4                   */
        0x00000051, 0xa00f0000, 0x00000000, 0x00000000, 0x00000000, 0x3f800000, /* def c0, 0, 0, 0, 1       */
        0x00000040, 0x80070000, 0xb0e40000,                                     /* texcrd r0.xyz, t0        */
        0x00000001, 0x80080000, 0xa0ff0000,                                     /* mov r0.a, c0.a           */
        0x40000050, 0x80070000, 0x80e40000, 0xa0e40001, 0xa0e40002,             /* +cnd r0.xyz, r0, c1, c2  */
        0x0000ffff                                                              /* end                      */
    };
    static const DWORD shader_code_14_coissue_2[] =
    {
        0xffff0104,                                                             /* ps_1_4                   */
        0x00000051, 0xa00f0000, 0x00000000, 0x00000000, 0x00000000, 0x3f800000, /* def c0, 0, 0, 0, 1       */
        0x00000040, 0x80070000, 0xb0e40000,                                     /* texcrd r0.xyz, t0        */
        0x00000001, 0x80080000, 0x80000000,                                     /* mov r0.a, r0.x           */
        0x00000001, 0x80070001, 0xa0ff0000,                                     /* mov r1.xyz, c0.a         */
        0x40000050, 0x80080001, 0x80ff0000, 0xa0e40001, 0xa0e40002,             /* +cnd r1.a, r0.a, c1, c2  */
        0x00000001, 0x80070000, 0x80ff0001,                                     /* mov r0.xyz, r1.a         */
        0x00000001, 0x80080000, 0xa0ff0000,                                     /* mov r0.a, c0.a           */
        0x0000ffff                                                              /* end                      */
    };
    static const float quad1[] =
    {
        -1.0f,   -1.0f,   0.1f,     0.0f,    0.0f,    1.0f,
        -1.0f,    0.0f,   0.1f,     0.0f,    1.0f,    0.0f,
         0.0f,   -1.0f,   0.1f,     1.0f,    0.0f,    1.0f,
         0.0f,    0.0f,   0.1f,     1.0f,    1.0f,    0.0f
    };
    static const float quad2[] =
    {
         0.0f,   -1.0f,   0.1f,     0.0f,    0.0f,    1.0f,
         0.0f,    0.0f,   0.1f,     0.0f,    1.0f,    0.0f,
         1.0f,   -1.0f,   0.1f,     1.0f,    0.0f,    1.0f,
         1.0f,    0.0f,   0.1f,     1.0f,    1.0f,    0.0f
    };
    static const float quad3[] =
    {
         0.0f,    0.0f,   0.1f,     0.0f,    0.0f,    1.0f,
         0.0f,    1.0f,   0.1f,     0.0f,    1.0f,    0.0f,
         1.0f,    0.0f,   0.1f,     1.0f,    0.0f,    1.0f,
         1.0f,    1.0f,   0.1f,     1.0f,    1.0f,    0.0f
    };
    static const float quad4[] =
    {
        -1.0f,    0.0f,   0.1f,     0.0f,    0.0f,    1.0f,
        -1.0f,    1.0f,   0.1f,     0.0f,    1.0f,    0.0f,
         0.0f,    0.0f,   0.1f,     1.0f,    0.0f,    1.0f,
         0.0f,    1.0f,   0.1f,     1.0f,    1.0f,    0.0f
    };
    static const float test_data_c1[4] = {0.0f, 0.0f, 0.0f, 0.0f};
    static const float test_data_c2[4] = {1.0f, 1.0f, 1.0f, 1.0f};
    static const float test_data_c1_coi[4] = {0.0f, 1.0f, 0.0f, 0.0f};
    static const float test_data_c2_coi[4] = {1.0f, 0.0f, 1.0f, 1.0f};

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get device caps, hr %#lx.\n", hr);
    if (caps.PixelShaderVersion < D3DPS_VERSION(1, 4))
    {
        skip("No ps_1_4 support, skipping tests.\n");
        IDirect3DDevice8_Release(device);
        goto done;
    }

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0xff00ffff, 1.0f, 0);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CreatePixelShader(device, shader_code_11, &shader_11);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreatePixelShader(device, shader_code_12, &shader_12);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreatePixelShader(device, shader_code_13, &shader_13);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreatePixelShader(device, shader_code_14, &shader_14);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreatePixelShader(device, shader_code_11_coissue, &shader_11_coissue);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreatePixelShader(device, shader_code_12_coissue, &shader_12_coissue);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreatePixelShader(device, shader_code_13_coissue, &shader_13_coissue);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreatePixelShader(device, shader_code_14_coissue, &shader_14_coissue);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreatePixelShader(device, shader_code_11_coissue_2, &shader_11_coissue_2);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreatePixelShader(device, shader_code_12_coissue_2, &shader_12_coissue_2);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreatePixelShader(device, shader_code_13_coissue_2, &shader_13_coissue_2);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreatePixelShader(device, shader_code_14_coissue_2, &shader_14_coissue_2);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetPixelShaderConstant(device, 1, test_data_c1, 1);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetPixelShaderConstant(device, 2, test_data_c2, 1);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_TEX1);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetPixelShader(device, shader_11);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad1, 6 * sizeof(float));
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetPixelShader(device, shader_12);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad2, 6 * sizeof(float));
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetPixelShader(device, shader_13);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad3, 6 * sizeof(float));
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetPixelShader(device, shader_14);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad4, 6 * sizeof(float));
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_EndScene(device);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetPixelShader(device, 0);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    /* This is the 1.4 test. Each component(r, g, b) is tested separately against 0.5 */
    color = getPixelColor(device, 158, 118);
    ok(color == 0x00ff00ff, "pixel 158, 118 has color %08x, expected 0x00ff00ff\n", color);
    color = getPixelColor(device, 162, 118);
    ok(color == 0x000000ff, "pixel 162, 118 has color %08x, expected 0x000000ff\n", color);
    color = getPixelColor(device, 158, 122);
    ok(color == 0x00ffffff, "pixel 162, 122 has color %08x, expected 0x00ffffff\n", color);
    color = getPixelColor(device, 162, 122);
    ok(color == 0x0000ffff, "pixel 162, 122 has color %08x, expected 0x0000ffff\n", color);

    /* 1.1 shader. All 3 components get set, based on the .w comparison */
    color = getPixelColor(device, 158, 358);
    ok(color == 0x00ffffff, "pixel 158, 358 has color %08x, expected 0x00ffffff\n", color);
    color = getPixelColor(device, 162, 358);
    ok(color_match(color, 0x00000000, 1),
            "pixel 162, 358 has color %08x, expected 0x00000000\n", color);
    color = getPixelColor(device, 158, 362);
    ok(color == 0x00ffffff, "pixel 158, 362 has color %08x, expected 0x00ffffff\n", color);
    color = getPixelColor(device, 162, 362);
    ok(color_match(color, 0x00000000, 1),
            "pixel 162, 362 has color %08x, expected 0x00000000\n", color);

    /* 1.2 shader */
    color = getPixelColor(device, 478, 358);
    ok(color == 0x00ffffff, "pixel 478, 358 has color %08x, expected 0x00ffffff\n", color);
    color = getPixelColor(device, 482, 358);
    ok(color_match(color, 0x00000000, 1),
            "pixel 482, 358 has color %08x, expected 0x00000000\n", color);
    color = getPixelColor(device, 478, 362);
    ok(color == 0x00ffffff, "pixel 478, 362 has color %08x, expected 0x00ffffff\n", color);
    color = getPixelColor(device, 482, 362);
    ok(color_match(color, 0x00000000, 1),
            "pixel 482, 362 has color %08x, expected 0x00000000\n", color);

    /* 1.3 shader */
    color = getPixelColor(device, 478, 118);
    ok(color == 0x00ffffff, "pixel 478, 118 has color %08x, expected 0x00ffffff\n", color);
    color = getPixelColor(device, 482, 118);
    ok(color_match(color, 0x00000000, 1),
            "pixel 482, 118 has color %08x, expected 0x00000000\n", color);
    color = getPixelColor(device, 478, 122);
    ok(color == 0x00ffffff, "pixel 478, 122 has color %08x, expected 0x00ffffff\n", color);
    color = getPixelColor(device, 482, 122);
    ok(color_match(color, 0x00000000, 1),
            "pixel 482, 122 has color %08x, expected 0x00000000\n", color);

    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xff00ffff, 0.0f, 0);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetPixelShaderConstant(device, 1, test_data_c1_coi, 1);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetPixelShaderConstant(device, 2, test_data_c2_coi, 1);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetPixelShader(device, shader_11_coissue);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad1, 6 * sizeof(float));
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetPixelShader(device, shader_12_coissue);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad2, 6 * sizeof(float));
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetPixelShader(device, shader_13_coissue);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad3, 6 * sizeof(float));
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetPixelShader(device, shader_14_coissue);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad4, 6 * sizeof(float));
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_EndScene(device);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetPixelShader(device, 0);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    /* This is the 1.4 test. The coissue doesn't change the behavior here, but keep in mind
     * that we swapped the values in c1 and c2 to make the other tests return some color
     */
    color = getPixelColor(device, 158, 118);
    ok(color == 0x00ffffff, "pixel 158, 118 has color %08x, expected 0x00ffffff\n", color);
    color = getPixelColor(device, 162, 118);
    ok(color == 0x0000ffff, "pixel 162, 118 has color %08x, expected 0x0000ffff\n", color);
    color = getPixelColor(device, 158, 122);
    ok(color == 0x00ff00ff, "pixel 162, 122 has color %08x, expected 0x00ff00ff\n", color);
    color = getPixelColor(device, 162, 122);
    ok(color == 0x000000ff, "pixel 162, 122 has color %08x, expected 0x000000ff\n", color);

    /* 1.1 shader. coissue flag changed the semantic of cnd, c1 is always selected
     * (The Win7 nvidia driver always selects c2)
     */
    color = getPixelColor(device, 158, 358);
    ok(color_match(color, 0x0000ff00, 1) || broken(color_match(color, 0x00ff00ff, 1)),
            "pixel 158, 358 has color %08x, expected 0x0000ff00\n", color);
    color = getPixelColor(device, 162, 358);
    ok(color_match(color, 0x0000ff00, 1) || broken(color_match(color, 0x00ff00ff, 1)),
            "pixel 162, 358 has color %08x, expected 0x0000ff00\n", color);
    color = getPixelColor(device, 158, 362);
    ok(color_match(color, 0x0000ff00, 1) || broken(color_match(color, 0x00ff00ff, 1)),
            "pixel 158, 362 has color %08x, expected 0x0000ff00\n", color);
    color = getPixelColor(device, 162, 362);
    ok(color_match(color, 0x0000ff00, 1) || broken(color_match(color, 0x00ff00ff, 1)),
            "pixel 162, 362 has color %08x, expected 0x0000ff00\n", color);

    /* 1.2 shader */
    color = getPixelColor(device, 478, 358);
    ok(color_match(color, 0x0000ff00, 1) || broken(color_match(color, 0x00ff00ff, 1)),
            "pixel 478, 358 has color %08x, expected 0x0000ff00\n", color);
    color = getPixelColor(device, 482, 358);
    ok(color_match(color, 0x0000ff00, 1) || broken(color_match(color, 0x00ff00ff, 1)),
            "pixel 482, 358 has color %08x, expected 0x0000ff00\n", color);
    color = getPixelColor(device, 478, 362);
    ok(color_match(color, 0x0000ff00, 1) || broken(color_match(color, 0x00ff00ff, 1)),
            "pixel 478, 362 has color %08x, expected 0x0000ff00\n", color);
    color = getPixelColor(device, 482, 362);
    ok(color_match(color, 0x0000ff00, 1) || broken(color_match(color, 0x00ff00ff, 1)),
            "pixel 482, 362 has color %08x, expected 0x0000ff00\n", color);

    /* 1.3 shader */
    color = getPixelColor(device, 478, 118);
    ok(color_match(color, 0x0000ff00, 1) || broken(color_match(color, 0x00ff00ff, 1)),
            "pixel 478, 118 has color %08x, expected 0x0000ff00\n", color);
    color = getPixelColor(device, 482, 118);
    ok(color_match(color, 0x0000ff00, 1) || broken(color_match(color, 0x00ff00ff, 1)),
            "pixel 482, 118 has color %08x, expected 0x0000ff00\n", color);
    color = getPixelColor(device, 478, 122);
    ok(color_match(color, 0x0000ff00, 1) || broken(color_match(color, 0x00ff00ff, 1)),
            "pixel 478, 122 has color %08x, expected 0x0000ff00\n", color);
    color = getPixelColor(device, 482, 122);
    ok(color_match(color, 0x0000ff00, 1) || broken(color_match(color, 0x00ff00ff, 1)),
            "pixel 482, 122 has color %08x, expected 0x0000ff00\n", color);

    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    /* Retest with the coissue flag on the alpha instruction instead. This
     * works "as expected". The Windows 8 testbot (WARP) seems to handle this
     * the same as coissue on .rgb. */
    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xff00ffff, 0.0f, 0);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetPixelShader(device, shader_11_coissue_2);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad1, 6 * sizeof(float));
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetPixelShader(device, shader_12_coissue_2);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad2, 6 * sizeof(float));
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetPixelShader(device, shader_13_coissue_2);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad3, 6 * sizeof(float));
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetPixelShader(device, shader_14_coissue_2);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad4, 6 * sizeof(float));
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_EndScene(device);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    /* 1.4 shader */
    color = getPixelColor(device, 158, 118);
    ok(color == 0x00ffffff, "pixel 158, 118 has color %08x, expected 0x00ffffff\n", color);
    color = getPixelColor(device, 162, 118);
    ok(color == 0x00000000, "pixel 162, 118 has color %08x, expected 0x00000000\n", color);
    color = getPixelColor(device, 158, 122);
    ok(color == 0x00ffffff, "pixel 162, 122 has color %08x, expected 0x00ffffff\n", color);
    color = getPixelColor(device, 162, 122);
    ok(color == 0x00000000, "pixel 162, 122 has color %08x, expected 0x00000000\n", color);

    /* 1.1 shader */
    color = getPixelColor(device, 238, 358);
    ok(color_match(color, 0x00ffffff, 1) || broken(color_match(color, 0x00000000, 1)),
            "pixel 238, 358 has color %08x, expected 0x00ffffff\n", color);
    color = getPixelColor(device, 242, 358);
    ok(color_match(color, 0x00000000, 1),
            "pixel 242, 358 has color %08x, expected 0x00000000\n", color);
    color = getPixelColor(device, 238, 362);
    ok(color_match(color, 0x00ffffff, 1) || broken(color_match(color, 0x00000000, 1)),
            "pixel 238, 362 has color %08x, expected 0x00ffffff\n", color);
    color = getPixelColor(device, 242, 362);
    ok(color_match(color, 0x00000000, 1),
            "pixel 242, 362 has color %08x, expected 0x00000000\n", color);

    /* 1.2 shader */
    color = getPixelColor(device, 558, 358);
    ok(color_match(color, 0x00ffffff, 1) || broken(color_match(color, 0x00000000, 1)),
            "pixel 558, 358 has color %08x, expected 0x00ffffff\n", color);
    color = getPixelColor(device, 562, 358);
    ok(color_match(color, 0x00000000, 1),
            "pixel 562, 358 has color %08x, expected 0x00000000\n", color);
    color = getPixelColor(device, 558, 362);
    ok(color_match(color, 0x00ffffff, 1) || broken(color_match(color, 0x00000000, 1)),
            "pixel 558, 362 has color %08x, expected 0x00ffffff\n", color);
    color = getPixelColor(device, 562, 362);
    ok(color_match(color, 0x00000000, 1),
            "pixel 562, 362 has color %08x, expected 0x00000000\n", color);

    /* 1.3 shader */
    color = getPixelColor(device, 558, 118);
    ok(color_match(color, 0x00ffffff, 1) || broken(color_match(color, 0x00000000, 1)),
            "pixel 558, 118 has color %08x, expected 0x00ffffff\n", color);
    color = getPixelColor(device, 562, 118);
    ok(color_match(color, 0x00000000, 1),
            "pixel 562, 118 has color %08x, expected 0x00000000\n", color);
    color = getPixelColor(device, 558, 122);
    ok(color_match(color, 0x00ffffff, 1) || broken(color_match(color, 0x00000000, 1)),
            "pixel 558, 122 has color %08x, expected 0x00ffffff\n", color);
    color = getPixelColor(device, 562, 122);
    ok(color_match(color, 0x00000000, 1),
            "pixel 562, 122 has color %08x, expected 0x00000000\n", color);

    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    IDirect3DDevice8_DeletePixelShader(device, shader_14_coissue_2);
    IDirect3DDevice8_DeletePixelShader(device, shader_13_coissue_2);
    IDirect3DDevice8_DeletePixelShader(device, shader_12_coissue_2);
    IDirect3DDevice8_DeletePixelShader(device, shader_11_coissue_2);
    IDirect3DDevice8_DeletePixelShader(device, shader_14_coissue);
    IDirect3DDevice8_DeletePixelShader(device, shader_13_coissue);
    IDirect3DDevice8_DeletePixelShader(device, shader_12_coissue);
    IDirect3DDevice8_DeletePixelShader(device, shader_11_coissue);
    IDirect3DDevice8_DeletePixelShader(device, shader_14);
    IDirect3DDevice8_DeletePixelShader(device, shader_13);
    IDirect3DDevice8_DeletePixelShader(device, shader_12);
    IDirect3DDevice8_DeletePixelShader(device, shader_11);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void z_range_test(void)
{
    IDirect3DDevice8 *device;
    unsigned int color;
    IDirect3D8 *d3d;
    ULONG refcount;
    D3DCAPS8 caps;
    DWORD shader;
    HWND window;
    HRESULT hr;

    static const struct
    {
        struct vec3 position;
        DWORD diffuse;
    }
    quad[] =
    {
        {{-1.0f, 0.0f,  1.1f}, 0xffff0000},
        {{-1.0f, 1.0f,  1.1f}, 0xffff0000},
        {{ 1.0f, 0.0f, -1.1f}, 0xffff0000},
        {{ 1.0f, 1.0f, -1.1f}, 0xffff0000},
    },
    quad2[] =
    {
        {{-1.0f, 0.0f,  1.1f}, 0xff0000ff},
        {{-1.0f, 1.0f,  1.1f}, 0xff0000ff},
        {{ 1.0f, 0.0f, -1.1f}, 0xff0000ff},
        {{ 1.0f, 1.0f, -1.1f}, 0xff0000ff},
    };
    static const struct
    {
        struct vec4 position;
        DWORD diffuse;
    }
    quad3[] =
    {
        {{640.0f, 240.0f, -1.1f, 1.0f}, 0xffffff00},
        {{640.0f, 480.0f, -1.1f, 1.0f}, 0xffffff00},
        {{  0.0f, 240.0f,  1.1f, 1.0f}, 0xffffff00},
        {{  0.0f, 480.0f,  1.1f, 1.0f}, 0xffffff00},
    },
    quad4[] =
    {
        {{640.0f, 240.0f, -1.1f, 1.0f}, 0xff00ff00},
        {{640.0f, 480.0f, -1.1f, 1.0f}, 0xff00ff00},
        {{  0.0f, 240.0f,  1.1f, 1.0f}, 0xff00ff00},
        {{  0.0f, 480.0f,  1.1f, 1.0f}, 0xff00ff00},
    };
    static const DWORD shader_code[] =
    {
        0xfffe0101,                                     /* vs_1_1           */
        0x00000001, 0xc00f0000, 0x90e40000,             /* mov oPos, v0     */
        0x00000001, 0xd00f0000, 0xa0e40000,             /* mov oD0, c0      */
        0x0000ffff                                      /* end              */
    };
    static const float color_const_1[] = {1.0f, 0.0f, 0.0f, 1.0f};
    static const float color_const_2[] = {0.0f, 0.0f, 1.0f, 1.0f};
    static const DWORD vertex_declaration[] =
    {
        D3DVSD_STREAM(0),
        D3DVSD_REG(D3DVSDE_POSITION, D3DVSDT_FLOAT3),
        D3DVSD_END()
    };

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get device caps, hr %#lx.\n", hr);

    /* Does the Present clear the depth stencil? Clear the depth buffer with some value != 0,
     * then call Present. Then clear the color buffer to make sure it has some defined content
     * after the Present with D3DSWAPEFFECT_DISCARD. After that draw a plane that is somewhere cut
     * by the depth value. */
    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0xffffffff, 0.75f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xffffffff, 0.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(SUCCEEDED(hr), "Failed to disabled lighting, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_CLIPPING, TRUE);
    ok(SUCCEEDED(hr), "Failed to enable clipping, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZENABLE, D3DZB_TRUE);
    ok(SUCCEEDED(hr), "Failed to enable z test, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZWRITEENABLE, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable z writes, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZFUNC, D3DCMP_GREATER);
    ok(SUCCEEDED(hr), "Failed to set z function, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_DIFFUSE);
    ok(SUCCEEDED(hr), "Failed set FVF, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);

    /* Test the untransformed vertex path */
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(quad[0]));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZFUNC, D3DCMP_LESS);
    ok(SUCCEEDED(hr), "Failed to set z function, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad2, sizeof(quad2[0]));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    /* Test the transformed vertex path */
    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZRHW | D3DFVF_DIFFUSE);
    ok(SUCCEEDED(hr), "Failed set FVF, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad4, sizeof(quad4[0]));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZFUNC, D3DCMP_GREATER);
    ok(SUCCEEDED(hr), "Failed to set z function, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad3, sizeof(quad3[0]));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

    /* Do not test the exact corner pixels, but go pretty close to them */

    /* Clipped because z > 1.0 */
    color = getPixelColor(device, 28, 238);
    ok(color_match(color, 0x00ffffff, 0), "Z range failed: Got color 0x%08x, expected 0x00ffffff.\n", color);
    color = getPixelColor(device, 28, 241);
    if (caps.PrimitiveMiscCaps & D3DPMISCCAPS_CLIPTLVERTS)
        ok(color_match(color, 0x00ffffff, 0), "Z range failed: Got color 0x%08x, expected 0x00ffffff.\n", color);
    else
        ok(color_match(color, 0x00ffff00, 0), "Z range failed: Got color 0x%08x, expected 0x00ffff00.\n", color);

    /* Not clipped, > z buffer clear value(0.75).
     *
     * On the r500 driver on Windows D3DCMP_GREATER and D3DCMP_GREATEREQUAL are broken for depth
     * values > 0.5. The range appears to be distorted, apparently an incoming value of ~0.875 is
     * equal to a stored depth buffer value of 0.5. */
    color = getPixelColor(device, 31, 238);
    ok(color_match(color, 0x00ff0000, 0), "Z range failed: Got color 0x%08x, expected 0x00ff0000.\n", color);
    color = getPixelColor(device, 31, 241);
    ok(color_match(color, 0x00ffff00, 0), "Z range failed: Got color 0x%08x, expected 0x00ffff00.\n", color);
    color = getPixelColor(device, 100, 238);
    ok(color_match(color, 0x00ff0000, 0) || broken(color_match(color, 0x00ffffff, 0)),
            "Z range failed: Got color 0x%08x, expected 0x00ff0000.\n", color);
    color = getPixelColor(device, 100, 241);
    ok(color_match(color, 0x00ffff00, 0) || broken(color_match(color, 0x00ffffff, 0)),
            "Z range failed: Got color 0x%08x, expected 0x00ffff00.\n", color);

    /* Not clipped, < z buffer clear value */
    color = getPixelColor(device, 104, 238);
    ok(color_match(color, 0x000000ff, 0), "Z range failed: Got color 0x%08x, expected 0x000000ff.\n", color);
    color = getPixelColor(device, 104, 241);
    ok(color_match(color, 0x0000ff00, 0), "Z range failed: Got color 0x%08x, expected 0x0000ff00.\n", color);
    color = getPixelColor(device, 318, 238);
    ok(color_match(color, 0x000000ff, 0), "Z range failed: Got color 0x%08x, expected 0x000000ff.\n", color);
    color = getPixelColor(device, 318, 241);
    ok(color_match(color, 0x0000ff00, 0), "Z range failed: Got color 0x%08x, expected 0x0000ff00.\n", color);

    /* Clipped because z < 0.0 */
    color = getPixelColor(device, 321, 238);
    ok(color_match(color, 0x00ffffff, 0), "Z range failed: Got color 0x%08x, expected 0x00ffffff.\n", color);
    color = getPixelColor(device, 321, 241);
    if (caps.PrimitiveMiscCaps & D3DPMISCCAPS_CLIPTLVERTS)
        ok(color_match(color, 0x00ffffff, 0), "Z range failed: Got color 0x%08x, expected 0x00ffffff.\n", color);
    else
        ok(color_match(color, 0x0000ff00, 0), "Z range failed: Got color 0x%08x, expected 0x00ffffff.\n", color);

    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    /* Test the shader path */
    if (caps.VertexShaderVersion < D3DVS_VERSION(1, 1))
    {
        skip("Vertex shaders not supported\n");
        IDirect3DDevice8_Release(device);
        goto done;
    }
    hr = IDirect3DDevice8_CreateVertexShader(device, vertex_declaration, shader_code, &shader, 0);
    ok(SUCCEEDED(hr), "Failed to create vertex shader, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xffffffff, 0.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetVertexShader(device, shader);
    ok(SUCCEEDED(hr), "Failed to set vertex shader, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetVertexShaderConstant(device, 0, color_const_1, 1);
    ok(SUCCEEDED(hr), "Failed to set vs constant 0, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(quad[0]));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZFUNC, D3DCMP_LESS);
    ok(SUCCEEDED(hr), "Failed to set z function, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetVertexShaderConstant(device, 0, color_const_2, 1);
    ok(SUCCEEDED(hr), "Failed to set vs constant 0, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad2, sizeof(quad2[0]));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetVertexShader(device, 0);
    ok(SUCCEEDED(hr), "Failed to set vertex shader, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_DeleteVertexShader(device, shader);
    ok(SUCCEEDED(hr), "Failed to delete vertex shader, hr %#lx.\n", hr);

    /* Z < 1.0 */
    color = getPixelColor(device, 28, 238);
    ok(color_match(color, 0x00ffffff, 0), "Z range failed: Got color 0x%08x, expected 0x00ffffff.\n", color);

    /* 1.0 < z < 0.75 */
    color = getPixelColor(device, 31, 238);
    ok(color_match(color, 0x00ff0000, 0), "Z range failed: Got color 0x%08x, expected 0x00ff0000.\n", color);
    color = getPixelColor(device, 100, 238);
    ok(color_match(color, 0x00ff0000, 0) || broken(color_match(color, 0x00ffffff, 0)),
            "Z range failed: Got color 0x%08x, expected 0x00ff0000.\n", color);

    /* 0.75 < z < 0.0 */
    color = getPixelColor(device, 104, 238);
    ok(color_match(color, 0x000000ff, 0), "Z range failed: Got color 0x%08x, expected 0x000000ff.\n", color);
    color = getPixelColor(device, 318, 238);
    ok(color_match(color, 0x000000ff, 0), "Z range failed: Got color 0x%08x, expected 0x000000ff.\n", color);

    /* 0.0 < z */
    color = getPixelColor(device, 321, 238);
    ok(color_match(color, 0x00ffffff, 0), "Z range failed: Got color 0x%08x, expected 0x00ffffff.\n", color);

    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_scalar_instructions(void)
{
    IDirect3DDevice8 *device;
    unsigned int color, i;
    IDirect3D8 *d3d;
    ULONG refcount;
    D3DCAPS8 caps;
    DWORD shader;
    HWND window;
    HRESULT hr;

    static const struct vec3 quad[] =
    {
        {-1.0f, -1.0f, 0.0f},
        {-1.0f,  1.0f, 0.0f},
        { 1.0f, -1.0f, 0.0f},
        { 1.0f,  1.0f, 0.0f},
    };
    static const DWORD decl[] =
    {
        D3DVSD_STREAM(0),
        D3DVSD_REG(D3DVSDE_POSITION, D3DVSDT_FLOAT3),                           /* dcl_position v0 */
        D3DVSD_CONST(0, 1), 0x3e800000, 0x3f000000, 0x3f800000, 0x40000000,     /* def c0, 0.25, 0.5, 1.0, 2.0 */
        D3DVSD_END()
    };
    static const DWORD rcp_test[] =
    {
        0xfffe0101,                                         /* vs_1_1 */
        0x0009fffe, 0x30303030, 0x30303030,                 /* Shaders have to have a minimal size.  */
        0x30303030, 0x30303030, 0x30303030,                 /* Add a filler comment. Usually d3dx8's */
        0x30303030, 0x30303030, 0x30303030,                 /* version comment makes the shader big  */
        0x00303030,                                         /* enough to make Windows happy.         */
        0x00000001, 0xc00f0000, 0x90e40000,                 /* mov oPos, v0 */
        0x00000006, 0xd00f0000, 0xa0e40000,                 /* rcp oD0, c0 */
        0x0000ffff                                          /* END */
    };
    static const DWORD rsq_test[] =
    {
        0xfffe0101,                                         /* vs_1_1 */
        0x0009fffe, 0x30303030, 0x30303030,                 /* Shaders have to have a minimal size.  */
        0x30303030, 0x30303030, 0x30303030,                 /* Add a filler comment. Usually d3dx8's */
        0x30303030, 0x30303030, 0x30303030,                 /* version comment makes the shader big  */
        0x00303030,                                         /* enough to make Windows happy.         */
        0x00000001, 0xc00f0000, 0x90e40000,                 /* mov oPos, v0 */
        0x00000007, 0xd00f0000, 0xa0e40000,                 /* rsq oD0, c0 */
        0x0000ffff                                          /* END */
    };
    static const DWORD exp_test[] =
    {
        0xfffe0101,                                         /* vs_1_1 */
        0x0009fffe, 0x30303030, 0x30303030,                 /* Shaders have to have a minimal size.  */
        0x30303030, 0x30303030, 0x30303030,                 /* Add a filler comment. Usually d3dx8's */
        0x30303030, 0x30303030, 0x30303030,                 /* version comment makes the shader big  */
        0x00303030,                                         /* enough to make Windows happy.         */
        0x00000001, 0xc00f0000, 0x90e40000,                 /* mov oPos, v0 */
        0x0000000e, 0x800f0000, 0xa0e40000,                 /* exp r0, c0 */
        0x00000006, 0xd00f0000, 0x80000000,                 /* rcp oD0, r0.x */
        0x0000ffff,                                         /* END */
    };
    static const DWORD expp_test[] =
    {
        0xfffe0101,                                         /* vs_1_1 */
        0x0009fffe, 0x30303030, 0x30303030,                 /* Shaders have to have a minimal size.  */
        0x30303030, 0x30303030, 0x30303030,                 /* Add a filler comment. Usually d3dx8's */
        0x30303030, 0x30303030, 0x30303030,                 /* version comment makes the shader big  */
        0x00303030,                                         /* enough to make Windows happy.         */
        0x00000001, 0xc00f0000, 0x90e40000,                 /* mov oPos, v0 */
        0x0000004e, 0x800f0000, 0xa0e40000,                 /* expp r0, c0 */
        0x00000006, 0xd00f0000, 0x80000000,                 /* rcp oD0, r0.x */
        0x0000ffff,                                         /* END */
    };
    static const DWORD log_test[] =
    {
        0xfffe0101,                                         /* vs_1_1 */
        0x0009fffe, 0x30303030, 0x30303030,                 /* Shaders have to have a minimal size.  */
        0x30303030, 0x30303030, 0x30303030,                 /* Add a filler comment. Usually d3dx8's */
        0x30303030, 0x30303030, 0x30303030,                 /* version comment makes the shader big  */
        0x00303030,                                         /* enough to make Windows happy.         */
        0x00000001, 0xc00f0000, 0x90e40000,                 /* mov oPos, v0 */
        0x0000000f, 0xd00f0000, 0xa0e40000,                 /* log oD0, c0 */
        0x0000ffff,                                         /* END */
    };
    static const DWORD logp_test[] =
    {
        0xfffe0101,                                         /* vs_1_1 */
        0x0009fffe, 0x30303030, 0x30303030,                 /* Shaders have to have a minimal size.  */
        0x30303030, 0x30303030, 0x30303030,                 /* Add a filler comment. Usually d3dx8's */
        0x30303030, 0x30303030, 0x30303030,                 /* version comment makes the shader big  */
        0x00303030,                                         /* enough to make Windows happy.         */
        0x00000001, 0xc00f0000, 0x90e40000,                 /* mov oPos, v0 */
        0x0000004f, 0xd00f0000, 0xa0e40000,                 /* logp oD0, c0 */
        0x0000ffff,                                         /* END */
    };
    static const struct
    {
        const char *name;
        const DWORD *byte_code;
        unsigned int color;
        /* Some drivers, including Intel HD4000 10.18.10.3345 and VMware SVGA
         * 3D 7.14.1.5025, use the .x component instead of the .w one. */
        unsigned int broken_color;
    }
    test_data[] =
    {
        {"rcp_test",    rcp_test,   D3DCOLOR_ARGB(0x00, 0x80, 0x80, 0x80), D3DCOLOR_ARGB(0x00, 0xff, 0xff, 0xff)},
        {"rsq_test",    rsq_test,   D3DCOLOR_ARGB(0x00, 0xb4, 0xb4, 0xb4), D3DCOLOR_ARGB(0x00, 0xff, 0xff, 0xff)},
        {"exp_test",    exp_test,   D3DCOLOR_ARGB(0x00, 0x40, 0x40, 0x40), D3DCOLOR_ARGB(0x00, 0xd6, 0xd6, 0xd6)},
        {"expp_test",   expp_test,  D3DCOLOR_ARGB(0x00, 0x40, 0x40, 0x40), D3DCOLOR_ARGB(0x00, 0xff, 0xff, 0xff)},
        {"log_test",    log_test,   D3DCOLOR_ARGB(0x00, 0xff, 0xff, 0xff), D3DCOLOR_ARGB(0x00, 0x00, 0x00, 0x00)},
        {"logp_test",   logp_test,  D3DCOLOR_ARGB(0x00, 0xff, 0xff, 0xff), D3DCOLOR_ARGB(0x00, 0x00, 0xff, 0x00)},
    };

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get device caps, hr %#lx.\n", hr);
    if (caps.VertexShaderVersion < D3DVS_VERSION(1, 1))
    {
        skip("No vs_1_1 support, skipping tests.\n");
        IDirect3DDevice8_Release(device);
        goto done;
    }

    for (i = 0; i < ARRAY_SIZE(test_data); ++i)
    {
        hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0xff336699, 0.0f, 0);
        ok(SUCCEEDED(hr), "%s: Failed to clear, hr %#lx.\n", test_data[i].name, hr);

        hr = IDirect3DDevice8_CreateVertexShader(device, decl, test_data[i].byte_code, &shader, 0);
        ok(SUCCEEDED(hr), "%s: Failed to create vertex shader, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirect3DDevice8_SetVertexShader(device, shader);
        ok(SUCCEEDED(hr), "%s: Failed to set vertex shader, hr %#lx.\n", test_data[i].name, hr);

        hr = IDirect3DDevice8_BeginScene(device);
        ok(SUCCEEDED(hr), "%s: Failed to begin scene, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, &quad[0], 3 * sizeof(float));
        ok(SUCCEEDED(hr), "%s: Failed to draw primitive, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirect3DDevice8_EndScene(device);
        ok(SUCCEEDED(hr), "%s: Failed to end scene, hr %#lx.\n", test_data[i].name, hr);

        color = getPixelColor(device, 320, 240);
        ok(color_match(color, test_data[i].color, 4) || broken(color_match(color, test_data[i].broken_color, 4)),
                "%s: Got unexpected color 0x%08x, expected 0x%08x.\n",
                test_data[i].name, color, test_data[i].color);

        hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
        ok(SUCCEEDED(hr), "%s: Failed to present, hr %#lx.\n", test_data[i].name, hr);

        hr = IDirect3DDevice8_SetVertexShader(device, 0);
        ok(SUCCEEDED(hr), "%s: Failed to set vertex shader, hr %#lx.\n", test_data[i].name, hr);
        hr = IDirect3DDevice8_DeleteVertexShader(device, shader);
        ok(SUCCEEDED(hr), "%s: Failed to delete vertex shader, hr %#lx.\n", test_data[i].name, hr);
    }

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void offscreen_test(void)
{
    IDirect3DSurface8 *backbuffer, *offscreen, *depthstencil;
    IDirect3DTexture8 *offscreenTexture;
    IDirect3DDevice8 *device;
    unsigned int color;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    static const float quad[][5] =
    {
        {-0.5f, -0.5f, 0.1f, 0.0f, 0.0f},
        {-0.5f,  0.5f, 0.1f, 0.0f, 1.0f},
        { 0.5f, -0.5f, 0.1f, 1.0f, 0.0f},
        { 0.5f,  0.5f, 0.1f, 1.0f, 1.0f},
    };

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0xffff0000, 1.0f, 0);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CreateTexture(device, 128, 128, 1, D3DUSAGE_RENDERTARGET,
            D3DFMT_X8R8G8B8, D3DPOOL_DEFAULT, &offscreenTexture);
    ok(hr == D3D_OK || hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);
    if (!offscreenTexture)
    {
        trace("Failed to create an X8R8G8B8 offscreen texture, trying R5G6B5\n");
        hr = IDirect3DDevice8_CreateTexture(device, 128, 128, 1, D3DUSAGE_RENDERTARGET,
                D3DFMT_R5G6B5, D3DPOOL_DEFAULT, &offscreenTexture);
        ok(hr == D3D_OK || hr == D3DERR_INVALIDCALL, "Got hr %#lx.\n", hr);
        if (!offscreenTexture)
        {
            skip("Cannot create an offscreen render target.\n");
            IDirect3DDevice8_Release(device);
            goto done;
        }
    }

    hr = IDirect3DDevice8_GetDepthStencilSurface(device, &depthstencil);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetBackBuffer(device, 0, D3DBACKBUFFER_TYPE_MONO, &backbuffer);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DTexture8_GetSurfaceLevel(offscreenTexture, 0, &offscreen);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_TEX1);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_COLOROP, D3DTOP_SELECTARG1);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_COLORARG1, D3DTA_TEXTURE);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_MINFILTER, D3DTEXF_NONE);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_MAGFILTER, D3DTEXF_NONE);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderTarget(device, offscreen, depthstencil);
    ok(SUCCEEDED(hr), "Failed to set render target, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xffff00ff, 1.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);

    /* Draw without textures - Should result in a white quad. */
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(quad[0]));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderTarget(device, backbuffer, depthstencil);
    ok(SUCCEEDED(hr), "Failed to set render target, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *)offscreenTexture);
    ok(SUCCEEDED(hr), "Failed to set texture, hr %#lx.\n", hr);

    /* This time with the texture .*/
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(quad[0]));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

    /* Center quad - should be white */
    color = getPixelColor(device, 320, 240);
    ok(color == 0x00ffffff, "Offscreen failed: Got color 0x%08x, expected 0x00ffffff.\n", color);
    /* Some quad in the cleared part of the texture */
    color = getPixelColor(device, 170, 240);
    ok(color == 0x00ff00ff, "Offscreen failed: Got color 0x%08x, expected 0x00ff00ff.\n", color);
    /* Part of the originally cleared back buffer */
    color = getPixelColor(device, 10, 10);
    ok(color == 0x00ff0000, "Offscreen failed: Got color 0x%08x, expected 0x00ff0000.\n", color);
    color = getPixelColor(device, 10, 470);
    ok(color == 0x00ff0000, "Offscreen failed: Got color 0x%08x, expected 0x00ff0000.\n", color);

    IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);

    IDirect3DSurface8_Release(backbuffer);
    IDirect3DTexture8_Release(offscreenTexture);
    IDirect3DSurface8_Release(offscreen);
    IDirect3DSurface8_Release(depthstencil);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_blend(void)
{
    IDirect3DSurface8 *backbuffer, *offscreen, *depthstencil;
    IDirect3DTexture8 *offscreenTexture;
    IDirect3DDevice8 *device;
    unsigned int color;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    static const struct
    {
        struct vec3 position;
        DWORD diffuse;
    }
    quad1[] =
    {
        {{-1.0f, -1.0f, 0.1f}, 0x4000ff00},
        {{-1.0f,  0.0f, 0.1f}, 0x4000ff00},
        {{ 1.0f, -1.0f, 0.1f}, 0x4000ff00},
        {{ 1.0f,  0.0f, 0.1f}, 0x4000ff00},
    },
    quad2[] =
    {
        {{-1.0f,  0.0f, 0.1f}, 0xc00000ff},
        {{-1.0f,  1.0f, 0.1f}, 0xc00000ff},
        {{ 1.0f,  0.0f, 0.1f}, 0xc00000ff},
        {{ 1.0f,  1.0f, 0.1f}, 0xc00000ff},
    };
    static const float composite_quad[][5] =
    {
        { 0.0f, -1.0f, 0.1f, 0.0f, 1.0f},
        { 0.0f,  1.0f, 0.1f, 0.0f, 0.0f},
        { 1.0f, -1.0f, 0.1f, 1.0f, 1.0f},
        { 1.0f,  1.0f, 0.1f, 1.0f, 0.0f},
    };

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    /* Clear the render target with alpha = 0.5 */
    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0x80ff0000, 1.0f, 0);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CreateTexture(device, 128, 128, 1, D3DUSAGE_RENDERTARGET,
            D3DFMT_X8R8G8B8, D3DPOOL_DEFAULT, &offscreenTexture);
    ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetDepthStencilSurface(device, &depthstencil);
    ok(SUCCEEDED(hr), "Failed to get depth/stencil buffer, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_GetBackBuffer(device, 0, D3DBACKBUFFER_TYPE_MONO, &backbuffer);
    ok(SUCCEEDED(hr), "Failed to get back buffer, hr %#lx.\n", hr);

    hr = IDirect3DTexture8_GetSurfaceLevel(offscreenTexture, 0, &offscreen);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_DIFFUSE);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_COLOROP, D3DTOP_SELECTARG1);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_COLORARG1, D3DTA_TEXTURE);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_MINFILTER, D3DTEXF_NONE);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_MAGFILTER, D3DTEXF_NONE);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ALPHABLENDENABLE, TRUE);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);

    /* Draw two quads, one with src alpha blending, one with dest alpha blending. */
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_SRCBLEND, D3DBLEND_SRCALPHA);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_DESTBLEND, D3DBLEND_INVSRCALPHA);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad1, sizeof(quad1[0]));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_SRCBLEND, D3DBLEND_DESTALPHA);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_DESTBLEND, D3DBLEND_INVDESTALPHA);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad2, sizeof(quad2[0]));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    /* Switch to the offscreen buffer, and redo the testing. The offscreen
     * render target doesn't have an alpha channel. DESTALPHA and INVDESTALPHA
     * "don't work" on render targets without alpha channel, they give
     * essentially ZERO and ONE blend factors. */
    hr = IDirect3DDevice8_SetRenderTarget(device, offscreen, 0);
    ok(SUCCEEDED(hr), "Failed to set render target, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0x80ff0000, 0.0, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_SRCBLEND, D3DBLEND_SRCALPHA);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_DESTBLEND, D3DBLEND_INVSRCALPHA);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad1, sizeof(quad1[0]));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_SRCBLEND, D3DBLEND_DESTALPHA);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_DESTBLEND, D3DBLEND_INVDESTALPHA);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad2, sizeof(quad2[0]));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderTarget(device, backbuffer, depthstencil);
    ok(SUCCEEDED(hr), "Failed to set render target, hr %#lx.\n", hr);

    /* Render the offscreen texture onto the frame buffer to be able to
     * compare it regularly. Disable alpha blending for the final
     * composition. */
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ALPHABLENDENABLE, FALSE);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_TEX1);
    ok(SUCCEEDED(hr), "Failed to set vertex shader, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *) offscreenTexture);
    ok(SUCCEEDED(hr), "Failed to set texture, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, composite_quad, sizeof(float) * 5);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

    color = getPixelColor(device, 160, 360);
    ok(color_match(color, D3DCOLOR_ARGB(0x00, 0xbf, 0x40, 0x00), 1),
       "SRCALPHA on frame buffer returned color %08x, expected 0x00bf4000\n", color);

    color = getPixelColor(device, 160, 120);
    ok(color_match(color, D3DCOLOR_ARGB(0x00, 0x7f, 0x00, 0x80), 2),
       "DSTALPHA on frame buffer returned color %08x, expected 0x007f0080\n", color);

    color = getPixelColor(device, 480, 360);
    ok(color_match(color, D3DCOLOR_ARGB(0x00, 0xbf, 0x40, 0x00), 1),
       "SRCALPHA on texture returned color %08x, expected 0x00bf4000\n", color);

    color = getPixelColor(device, 480, 120);
    ok(color_match(color, D3DCOLOR_ARGB(0x00, 0x00, 0x00, 0xff), 1),
       "DSTALPHA on texture returned color %08x, expected 0x000000ff\n", color);

    IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);

    IDirect3DSurface8_Release(backbuffer);
    IDirect3DTexture8_Release(offscreenTexture);
    IDirect3DSurface8_Release(offscreen);
    IDirect3DSurface8_Release(depthstencil);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void p8_texture_test(void)
{
    IDirect3DTexture8 *texture, *texture2;
    IDirect3DDevice8 *device;
    PALETTEENTRY table[256];
    unsigned int color, i;
    unsigned char *data;
    D3DLOCKED_RECT lr;
    IDirect3D8 *d3d;
    ULONG refcount;
    D3DCAPS8 caps;
    HWND window;
    HRESULT hr;

    static const float quad[] =
    {
        -1.0f,  0.0f, 0.1f, 0.0f, 0.0f,
        -1.0f,  1.0f, 0.1f, 0.0f, 1.0f,
         1.0f,  0.0f, 0.1f, 1.0f, 0.0f,
         1.0f,  1.0f, 0.1f, 1.0f, 1.0f,
    };
    static const float quad2[] =
    {
        -1.0f, -1.0f, 0.1f, 0.0f, 0.0f,
        -1.0f,  0.0f, 0.1f, 0.0f, 1.0f,
         1.0f, -1.0f, 0.1f, 1.0f, 0.0f,
         1.0f,  0.0f, 0.1f, 1.0f, 1.0f,
    };

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    if (IDirect3D8_CheckDeviceFormat(d3d, 0, D3DDEVTYPE_HAL,
            D3DFMT_X8R8G8B8, 0, D3DRTYPE_TEXTURE, D3DFMT_P8) != D3D_OK)
    {
        skip("D3DFMT_P8 textures not supported.\n");
        IDirect3DDevice8_Release(device);
        goto done;
    }

    hr = IDirect3DDevice8_CreateTexture(device, 1, 1, 1, 0, D3DFMT_P8, D3DPOOL_MANAGED, &texture2);
    ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx.\n", hr);
    memset(&lr, 0, sizeof(lr));
    hr = IDirect3DTexture8_LockRect(texture2, 0, &lr, NULL, 0);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    data = lr.pBits;
    *data = 1;
    hr = IDirect3DTexture8_UnlockRect(texture2, 0);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CreateTexture(device, 1, 1, 1, 0, D3DFMT_P8, D3DPOOL_MANAGED, &texture);
    ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx.\n", hr);
    memset(&lr, 0, sizeof(lr));
    hr = IDirect3DTexture8_LockRect(texture, 0, &lr, NULL, 0);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    data = lr.pBits;
    *data = 1;
    hr = IDirect3DTexture8_UnlockRect(texture, 0);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0xff000000, 1.0f, 0);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ALPHABLENDENABLE, TRUE);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    /* The first part of the test should work both with and without D3DPTEXTURECAPS_ALPHAPALETTE;
       alpha of every entry is set to 1.0, which MS says is required when there's no
       D3DPTEXTURECAPS_ALPHAPALETTE capability */
    for (i = 0; i < 256; i++) {
        table[i].peRed = table[i].peGreen = table[i].peBlue = 0;
        table[i].peFlags = 0xff;
    }
    table[1].peRed = 0xff;
    hr = IDirect3DDevice8_SetPaletteEntries(device, 0, table);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    table[1].peRed = 0;
    table[1].peBlue = 0xff;
    hr = IDirect3DDevice8_SetPaletteEntries(device, 1, table);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_SRCBLEND, D3DBLEND_SRCALPHA);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_DESTBLEND, D3DBLEND_INVSRCALPHA);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_TEX1);
    ok(SUCCEEDED(hr), "Failed to set vertex shader, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetCurrentTexturePalette(device, 0);
    ok(SUCCEEDED(hr), "Failed to set texture palette, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *)texture2);
    ok(SUCCEEDED(hr), "Failed to set texture, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, 5 * sizeof(float));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *)texture);
    ok(SUCCEEDED(hr), "Failed to set texture, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, 5 * sizeof(float));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetCurrentTexturePalette(device, 1);
    ok(SUCCEEDED(hr), "Failed to set texture palette, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad2, 5 * sizeof(float));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

    color = getPixelColor(device, 32, 32);
    ok(color_match(color, 0x00ff0000, 0), "Got unexpected color 0x%08x.\n", color);
    color = getPixelColor(device, 32, 320);
    ok(color_match(color, 0x000000ff, 0), "Got unexpected color 0x%08x.\n", color);

    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xff000000, 0.0, 0);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *)texture2);
    ok(SUCCEEDED(hr), "Failed to set texture, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, 5 * sizeof(float));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

    color = getPixelColor(device, 32, 32);
    ok(color_match(color, 0x000000ff, 0), "Got unexpected color 0x%08x.\n", color);

    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    /* Test palettes with alpha */
    IDirect3DDevice8_GetDeviceCaps(device, &caps);
    if (!(caps.TextureCaps & D3DPTEXTURECAPS_ALPHAPALETTE)) {
        skip("no D3DPTEXTURECAPS_ALPHAPALETTE capability, tests with alpha in palette will be skipped\n");
    } else {
        hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xff000000, 0.0, 0);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

        hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ALPHABLENDENABLE, TRUE);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

        for (i = 0; i < 256; i++) {
            table[i].peRed = table[i].peGreen = table[i].peBlue = 0;
            table[i].peFlags = 0xff;
        }
        table[1].peRed = 0xff;
        table[1].peFlags = 0x80;
        hr = IDirect3DDevice8_SetPaletteEntries(device, 0, table);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

        table[1].peRed = 0;
        table[1].peBlue = 0xff;
        table[1].peFlags = 0x80;
        hr = IDirect3DDevice8_SetPaletteEntries(device, 1, table);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

        hr = IDirect3DDevice8_BeginScene(device);
        ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_SetRenderState(device, D3DRS_SRCBLEND, D3DBLEND_SRCALPHA);
        ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetRenderState(device, D3DRS_DESTBLEND, D3DBLEND_INVSRCALPHA);
        ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_TEX1);
        ok(SUCCEEDED(hr), "Failed to set vertex shader, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_SetCurrentTexturePalette(device, 0);
        ok(SUCCEEDED(hr), "Failed to set texture palette, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, 5 * sizeof(float));
        ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_SetCurrentTexturePalette(device, 1);
        ok(SUCCEEDED(hr), "Failed to set texture palette, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad2, 5 * sizeof(float));
        ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_EndScene(device);
        ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

        color = getPixelColor(device, 32, 32);
        ok(color_match(color, 0x00800000, 1), "Got unexpected color 0x%08x.\n", color);
        color = getPixelColor(device, 32, 320);
        ok(color_match(color, 0x00000080, 1), "Got unexpected color 0x%08x.\n", color);

        hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
        ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    }

    IDirect3DTexture8_Release(texture);
    IDirect3DTexture8_Release(texture2);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void texop_test(void)
{
    IDirect3DTexture8 *texture;
    D3DLOCKED_RECT locked_rect;
    IDirect3DDevice8 *device;
    unsigned int color, i;
    IDirect3D8 *d3d;
    ULONG refcount;
    D3DCAPS8 caps;
    HWND window;
    HRESULT hr;

    static const struct {
        float x, y, z;
        D3DCOLOR diffuse;
        float s, t;
    } quad[] = {
        {-1.0f, -1.0f, 0.1f, D3DCOLOR_ARGB(0x55, 0xff, 0x00, 0x00), -1.0f, -1.0f},
        {-1.0f,  1.0f, 0.1f, D3DCOLOR_ARGB(0x55, 0xff, 0x00, 0x00), -1.0f,  1.0f},
        { 1.0f, -1.0f, 0.1f, D3DCOLOR_ARGB(0x55, 0xff, 0x00, 0x00),  1.0f, -1.0f},
        { 1.0f,  1.0f, 0.1f, D3DCOLOR_ARGB(0x55, 0xff, 0x00, 0x00),  1.0f,  1.0f}
    };

    static const struct {
        D3DTEXTUREOP op;
        const char *name;
        DWORD caps_flag;
        unsigned int result;
    } test_data[] = {
        {D3DTOP_SELECTARG1,                "SELECTARG1",                D3DTEXOPCAPS_SELECTARG1,                D3DCOLOR_ARGB(0x00, 0x00, 0xff, 0x00)},
        {D3DTOP_SELECTARG2,                "SELECTARG2",                D3DTEXOPCAPS_SELECTARG2,                D3DCOLOR_ARGB(0x00, 0x33, 0x33, 0x33)},
        {D3DTOP_MODULATE,                  "MODULATE",                  D3DTEXOPCAPS_MODULATE,                  D3DCOLOR_ARGB(0x00, 0x00, 0x33, 0x00)},
        {D3DTOP_MODULATE2X,                "MODULATE2X",                D3DTEXOPCAPS_MODULATE2X,                D3DCOLOR_ARGB(0x00, 0x00, 0x66, 0x00)},
        {D3DTOP_MODULATE4X,                "MODULATE4X",                D3DTEXOPCAPS_MODULATE4X,                D3DCOLOR_ARGB(0x00, 0x00, 0xcc, 0x00)},
        {D3DTOP_ADD,                       "ADD",                       D3DTEXOPCAPS_ADD,                       D3DCOLOR_ARGB(0x00, 0x33, 0xff, 0x33)},

        {D3DTOP_ADDSIGNED,                 "ADDSIGNED",                 D3DTEXOPCAPS_ADDSIGNED,                 D3DCOLOR_ARGB(0x00, 0x00, 0xb2, 0x00)},
        {D3DTOP_ADDSIGNED2X,               "ADDSIGNED2X",               D3DTEXOPCAPS_ADDSIGNED2X,               D3DCOLOR_ARGB(0x00, 0x00, 0xff, 0x00)},

        {D3DTOP_SUBTRACT,                  "SUBTRACT",                  D3DTEXOPCAPS_SUBTRACT,                  D3DCOLOR_ARGB(0x00, 0x00, 0xcc, 0x00)},
        {D3DTOP_ADDSMOOTH,                 "ADDSMOOTH",                 D3DTEXOPCAPS_ADDSMOOTH,                 D3DCOLOR_ARGB(0x00, 0x33, 0xff, 0x33)},
        {D3DTOP_BLENDDIFFUSEALPHA,         "BLENDDIFFUSEALPHA",         D3DTEXOPCAPS_BLENDDIFFUSEALPHA,         D3DCOLOR_ARGB(0x00, 0x22, 0x77, 0x22)},
        {D3DTOP_BLENDTEXTUREALPHA,         "BLENDTEXTUREALPHA",         D3DTEXOPCAPS_BLENDTEXTUREALPHA,         D3DCOLOR_ARGB(0x00, 0x14, 0xad, 0x14)},
        {D3DTOP_BLENDFACTORALPHA,          "BLENDFACTORALPHA",          D3DTEXOPCAPS_BLENDFACTORALPHA,          D3DCOLOR_ARGB(0x00, 0x07, 0xe4, 0x07)},
        {D3DTOP_BLENDTEXTUREALPHAPM,       "BLENDTEXTUREALPHAPM",       D3DTEXOPCAPS_BLENDTEXTUREALPHAPM,       D3DCOLOR_ARGB(0x00, 0x14, 0xff, 0x14)},
        {D3DTOP_BLENDCURRENTALPHA,         "BLENDCURRENTALPHA",         D3DTEXOPCAPS_BLENDCURRENTALPHA,         D3DCOLOR_ARGB(0x00, 0x22, 0x77, 0x22)},
        {D3DTOP_MODULATEALPHA_ADDCOLOR,    "MODULATEALPHA_ADDCOLOR",    D3DTEXOPCAPS_MODULATEALPHA_ADDCOLOR,    D3DCOLOR_ARGB(0x00, 0x1f, 0xff, 0x1f)},
        {D3DTOP_MODULATECOLOR_ADDALPHA,    "MODULATECOLOR_ADDALPHA",    D3DTEXOPCAPS_MODULATECOLOR_ADDALPHA,    D3DCOLOR_ARGB(0x00, 0x99, 0xcc, 0x99)},
        {D3DTOP_MODULATEINVALPHA_ADDCOLOR, "MODULATEINVALPHA_ADDCOLOR", D3DTEXOPCAPS_MODULATEINVALPHA_ADDCOLOR, D3DCOLOR_ARGB(0x00, 0x14, 0xff, 0x14)},
        {D3DTOP_MODULATEINVCOLOR_ADDALPHA, "MODULATEINVCOLOR_ADDALPHA", D3DTEXOPCAPS_MODULATEINVCOLOR_ADDALPHA, D3DCOLOR_ARGB(0x00, 0xcc, 0x99, 0xcc)},
        /* BUMPENVMAP & BUMPENVMAPLUMINANCE have their own tests */
        {D3DTOP_DOTPRODUCT3,               "DOTPRODUCT2",               D3DTEXOPCAPS_DOTPRODUCT3,               D3DCOLOR_ARGB(0x00, 0x99, 0x99, 0x99)},
        {D3DTOP_MULTIPLYADD,               "MULTIPLYADD",               D3DTEXOPCAPS_MULTIPLYADD,               D3DCOLOR_ARGB(0x00, 0xff, 0x33, 0x00)},
        {D3DTOP_LERP,                      "LERP",                      D3DTEXOPCAPS_LERP,                      D3DCOLOR_ARGB(0x00, 0x00, 0x33, 0x33)},
    };

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    memset(&caps, 0, sizeof(caps));
    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_DIFFUSE | D3DFVF_TEX0);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CreateTexture(device, 1, 1, 1, 0, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED, &texture);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);
    hr = IDirect3DTexture8_LockRect(texture, 0, &locked_rect, NULL, 0);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);
    *((DWORD *)locked_rect.pBits) = D3DCOLOR_ARGB(0x99, 0x00, 0xff, 0x00);
    hr = IDirect3DTexture8_UnlockRect(texture, 0);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *)texture);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_COLORARG0, D3DTA_DIFFUSE);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_COLORARG1, D3DTA_TEXTURE);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_COLORARG2, D3DTA_TFACTOR);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTextureStageState(device, 1, D3DTSS_COLOROP, D3DTOP_DISABLE);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_TEXTUREFACTOR, 0xdd333333);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_COLORWRITEENABLE, D3DCOLORWRITEENABLE_RED | D3DCOLORWRITEENABLE_GREEN | D3DCOLORWRITEENABLE_BLUE | D3DCOLORWRITEENABLE_ALPHA);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0x00000000, 1.0f, 0);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);

    for (i = 0; i < ARRAY_SIZE(test_data); ++i)
    {
        if (!(caps.TextureOpCaps & test_data[i].caps_flag))
        {
            skip("tex operation %s not supported\n", test_data[i].name);
            continue;
        }

        hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_COLOROP, test_data[i].op);
        ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);

        hr = IDirect3DDevice8_BeginScene(device);
        ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);

        hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(*quad));
        ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);

        hr = IDirect3DDevice8_EndScene(device);
        ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);

        color = getPixelColor(device, 320, 240);
        ok(color_match(color, test_data[i].result, 3), "Operation %s returned color 0x%08x, expected 0x%08x\n",
                test_data[i].name, color, test_data[i].result);

        hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
        ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);

        hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0x00000000, 1.0f, 0);
        ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);
    }

    IDirect3DTexture8_Release(texture);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

/* This test tests depth clamping / clipping behaviour:
 *   - With software vertex processing, depth values are clamped to the
 *     minimum / maximum z value when D3DRS_CLIPPING is disabled, and clipped
 *     when D3DRS_CLIPPING is enabled. Pretransformed vertices behave the
 *     same as regular vertices here.
 *   - With hardware vertex processing, D3DRS_CLIPPING seems to be ignored.
 *     Normal vertices are always clipped. Pretransformed vertices are
 *     clipped when D3DPMISCCAPS_CLIPTLVERTS is set, clamped when it isn't.
 *   - The viewport's MinZ/MaxZ is irrelevant for this.
 */
static void depth_clamp_test(void)
{
    IDirect3DDevice8 *device;
    unsigned int color;
    D3DVIEWPORT8 vp;
    IDirect3D8 *d3d;
    ULONG refcount;
    D3DCAPS8 caps;
    HWND window;
    HRESULT hr;

    static const struct
    {
        struct vec4 position;
        DWORD diffuse;
    }
    quad1[] =
    {
        {{  0.0f,   0.0f,  5.0f, 1.0f}, 0xff002b7f},
        {{640.0f,   0.0f,  5.0f, 1.0f}, 0xff002b7f},
        {{  0.0f, 480.0f,  5.0f, 1.0f}, 0xff002b7f},
        {{640.0f, 480.0f,  5.0f, 1.0f}, 0xff002b7f},
    },
    quad2[] =
    {
        {{  0.0f, 300.0f, 10.0f, 1.0f}, 0xfff9e814},
        {{640.0f, 300.0f, 10.0f, 1.0f}, 0xfff9e814},
        {{  0.0f, 360.0f, 10.0f, 1.0f}, 0xfff9e814},
        {{640.0f, 360.0f, 10.0f, 1.0f}, 0xfff9e814},
    },
    quad3[] =
    {
        {{112.0f, 108.0f,  5.0f, 1.0f}, 0xffffffff},
        {{208.0f, 108.0f,  5.0f, 1.0f}, 0xffffffff},
        {{112.0f, 204.0f,  5.0f, 1.0f}, 0xffffffff},
        {{208.0f, 204.0f,  5.0f, 1.0f}, 0xffffffff},
    },
    quad4[] =
    {
        {{ 42.0f,  41.0f, 10.0f, 1.0f}, 0xffffffff},
        {{112.0f,  41.0f, 10.0f, 1.0f}, 0xffffffff},
        {{ 42.0f, 108.0f, 10.0f, 1.0f}, 0xffffffff},
        {{112.0f, 108.0f, 10.0f, 1.0f}, 0xffffffff},
    };
    static const struct
    {
        struct vec3 position;
        DWORD diffuse;
    }
    quad5[] =
    {
        {{-0.5f,  0.5f,  10.0f}, 0xff14f914},
        {{ 0.5f,  0.5f,  10.0f}, 0xff14f914},
        {{-0.5f, -0.5f,  10.0f}, 0xff14f914},
        {{ 0.5f, -0.5f,  10.0f}, 0xff14f914},
    },
    quad6[] =
    {
        {{-1.0f,  0.5f,  10.0f}, 0xfff91414},
        {{ 1.0f,  0.5f,  10.0f}, 0xfff91414},
        {{-1.0f,  0.25f, 10.0f}, 0xfff91414},
        {{ 1.0f,  0.25f, 10.0f}, 0xfff91414},
    };

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get device caps, hr %#lx.\n", hr);

    vp.X = 0;
    vp.Y = 0;
    vp.Width = 640;
    vp.Height = 480;
    vp.MinZ = 0.0;
    vp.MaxZ = 7.5;

    hr = IDirect3DDevice8_SetViewport(device, &vp);
    ok(SUCCEEDED(hr), "SetViewport failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0xff00ff00, 1.0, 0);
    ok(SUCCEEDED(hr), "Clear failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_CLIPPING, FALSE);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZWRITEENABLE, TRUE);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZFUNC, D3DCMP_LESSEQUAL);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "BeginScene failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZRHW | D3DFVF_DIFFUSE);
    ok(SUCCEEDED(hr), "SetVertexShader failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad1, sizeof(*quad1));
    ok(SUCCEEDED(hr), "DrawPrimitiveUP failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad2, sizeof(*quad2));
    ok(SUCCEEDED(hr), "DrawPrimitiveUP failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_CLIPPING, TRUE);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad3, sizeof(*quad3));
    ok(SUCCEEDED(hr), "DrawPrimitiveUP failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad4, sizeof(*quad4));
    ok(SUCCEEDED(hr), "DrawPrimitiveUP failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_CLIPPING, FALSE);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_DIFFUSE);
    ok(SUCCEEDED(hr), "SetVertexShader failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad5, sizeof(*quad5));
    ok(SUCCEEDED(hr), "DrawPrimitiveUP failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_CLIPPING, TRUE);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad6, sizeof(*quad6));
    ok(SUCCEEDED(hr), "DrawPrimitiveUP failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "EndScene failed, hr %#lx.\n", hr);

    if (caps.PrimitiveMiscCaps & D3DPMISCCAPS_CLIPTLVERTS)
    {
        color = getPixelColor(device, 75, 75);
        ok(color_match(color, 0x0000ff00, 1), "color 0x%08x.\n", color);
        color = getPixelColor(device, 150, 150);
        ok(color_match(color, 0x0000ff00, 1), "color 0x%08x.\n", color);
        color = getPixelColor(device, 320, 240);
        ok(color_match(color, 0x0000ff00, 1), "color 0x%08x.\n", color);
        color = getPixelColor(device, 320, 330);
        ok(color_match(color, 0x0000ff00, 1), "color 0x%08x.\n", color);
        color = getPixelColor(device, 320, 330);
        ok(color_match(color, 0x0000ff00, 1), "color 0x%08x.\n", color);
    }
    else
    {
        color = getPixelColor(device, 75, 75);
        ok(color_match(color, 0x00ffffff, 1), "color 0x%08x.\n", color);
        color = getPixelColor(device, 150, 150);
        ok(color_match(color, 0x00ffffff, 1), "color 0x%08x.\n", color);
        color = getPixelColor(device, 320, 240);
        ok(color_match(color, 0x00002b7f, 1), "color 0x%08x.\n", color);
        color = getPixelColor(device, 320, 330);
        ok(color_match(color, 0x00f9e814, 1), "color 0x%08x.\n", color);
        color = getPixelColor(device, 320, 330);
        ok(color_match(color, 0x00f9e814, 1), "color 0x%08x.\n", color);
    }

    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void depth_buffer_test(void)
{
    IDirect3DSurface8 *backbuffer, *rt1, *rt2, *rt3;
    IDirect3DSurface8 *depth_stencil;
    IDirect3DDevice8 *device;
    unsigned int color, i, j;
    D3DVIEWPORT8 vp;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    static const struct
    {
        struct vec3 position;
        DWORD diffuse;
    }
    quad1[] =
    {
        {{-1.0f,  1.0f, 0.33f}, 0xff00ff00},
        {{ 1.0f,  1.0f, 0.33f}, 0xff00ff00},
        {{-1.0f, -1.0f, 0.33f}, 0xff00ff00},
        {{ 1.0f, -1.0f, 0.33f}, 0xff00ff00},
    },
    quad2[] =
    {
        {{-1.0f,  1.0f, 0.50f}, 0xffff00ff},
        {{ 1.0f,  1.0f, 0.50f}, 0xffff00ff},
        {{-1.0f, -1.0f, 0.50f}, 0xffff00ff},
        {{ 1.0f, -1.0f, 0.50f}, 0xffff00ff},
    },
    quad3[] =
    {
        {{-1.0f,  1.0f, 0.66f}, 0xffff0000},
        {{ 1.0f,  1.0f, 0.66f}, 0xffff0000},
        {{-1.0f, -1.0f, 0.66f}, 0xffff0000},
        {{ 1.0f, -1.0f, 0.66f}, 0xffff0000},
    };
    static const unsigned int expected_colors[4][4] =
    {
        {0x000000ff, 0x000000ff, 0x0000ff00, 0x00ff0000},
        {0x000000ff, 0x000000ff, 0x0000ff00, 0x00ff0000},
        {0x0000ff00, 0x0000ff00, 0x0000ff00, 0x00ff0000},
        {0x00ff0000, 0x00ff0000, 0x00ff0000, 0x00ff0000},
    };

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    vp.X = 0;
    vp.Y = 0;
    vp.Width = 640;
    vp.Height = 480;
    vp.MinZ = 0.0;
    vp.MaxZ = 1.0;

    hr = IDirect3DDevice8_SetViewport(device, &vp);
    ok(SUCCEEDED(hr), "SetViewport failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZENABLE, D3DZB_TRUE);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZWRITEENABLE, TRUE);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZFUNC, D3DCMP_LESSEQUAL);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_DIFFUSE);
    ok(SUCCEEDED(hr), "SetVertexShader failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetDepthStencilSurface(device, &depth_stencil);
    ok(SUCCEEDED(hr), "GetDepthStencilSurface failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_GetRenderTarget(device, &backbuffer);
    ok(SUCCEEDED(hr), "GetRenderTarget failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateRenderTarget(device, 320, 240, D3DFMT_A8R8G8B8,
            D3DMULTISAMPLE_NONE, FALSE, &rt1);
    ok(SUCCEEDED(hr), "CreateRenderTarget failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateRenderTarget(device, 480, 360, D3DFMT_A8R8G8B8,
            D3DMULTISAMPLE_NONE, FALSE, &rt2);
    ok(SUCCEEDED(hr), "CreateRenderTarget failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateRenderTarget(device, 640, 480, D3DFMT_A8R8G8B8,
            D3DMULTISAMPLE_NONE, FALSE, &rt3);
    ok(SUCCEEDED(hr), "CreateRenderTarget failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderTarget(device, rt3, depth_stencil);
    ok(SUCCEEDED(hr), "SetRenderTarget failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0xff0000ff, 0.0f, 0);
    ok(SUCCEEDED(hr), "Clear failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderTarget(device, backbuffer, depth_stencil);
    ok(SUCCEEDED(hr), "SetRenderTarget failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0xff0000ff, 1.0f, 0);
    ok(SUCCEEDED(hr), "Clear failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderTarget(device, rt1, depth_stencil);
    ok(SUCCEEDED(hr), "SetRenderTarget failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0xffffffff, 0.0f, 0);
    ok(SUCCEEDED(hr), "Clear failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderTarget(device, rt2, depth_stencil);
    ok(SUCCEEDED(hr), "SetRenderTarget failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "BeginScene failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad2, sizeof(*quad2));
    ok(SUCCEEDED(hr), "DrawPrimitiveUP failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "EndScene failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderTarget(device, backbuffer, depth_stencil);
    ok(SUCCEEDED(hr), "SetRenderTarget failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZWRITEENABLE, FALSE);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "BeginScene failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad1, sizeof(*quad1));
    ok(SUCCEEDED(hr), "DrawPrimitiveUP failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad3, sizeof(*quad3));
    ok(SUCCEEDED(hr), "DrawPrimitiveUP failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "EndScene failed, hr %#lx.\n", hr);

    for (i = 0; i < 4; ++i)
    {
        for (j = 0; j < 4; ++j)
        {
            unsigned int x = 80 * ((2 * j) + 1);
            unsigned int y = 60 * ((2 * i) + 1);
            color = getPixelColor(device, x, y);
            ok(color_match(color, expected_colors[i][j], 0),
                    "Expected color 0x%08x at %u,%u, got 0x%08x.\n", expected_colors[i][j], x, y, color);
        }
    }

    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);

    IDirect3DSurface8_Release(depth_stencil);
    IDirect3DSurface8_Release(backbuffer);
    IDirect3DSurface8_Release(rt3);
    IDirect3DSurface8_Release(rt2);
    IDirect3DSurface8_Release(rt1);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

/* Test that partial depth copies work the way they're supposed to. The clear
 * on rt2 only needs a partial copy of the onscreen depth/stencil buffer, and
 * the following draw should only copy back the part that was modified. */
static void depth_buffer2_test(void)
{
    IDirect3DSurface8 *backbuffer, *rt1, *rt2;
    IDirect3DSurface8 *depth_stencil;
    IDirect3DDevice8 *device;
    unsigned int color, i, j;
    D3DVIEWPORT8 vp;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    static const struct
    {
        struct vec3 position;
        DWORD diffuse;
    }
    quad[] =
    {
        {{-1.0f,  1.0f, 0.66f}, 0xffff0000},
        {{ 1.0f,  1.0f, 0.66f}, 0xffff0000},
        {{-1.0f, -1.0f, 0.66f}, 0xffff0000},
        {{ 1.0f, -1.0f, 0.66f}, 0xffff0000},
    };

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    vp.X = 0;
    vp.Y = 0;
    vp.Width = 640;
    vp.Height = 480;
    vp.MinZ = 0.0;
    vp.MaxZ = 1.0;

    hr = IDirect3DDevice8_SetViewport(device, &vp);
    ok(SUCCEEDED(hr), "SetViewport failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZENABLE, D3DZB_TRUE);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZWRITEENABLE, TRUE);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZFUNC, D3DCMP_LESSEQUAL);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_DIFFUSE);
    ok(SUCCEEDED(hr), "SetVertexShader failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CreateRenderTarget(device, 640, 480, D3DFMT_A8R8G8B8,
            D3DMULTISAMPLE_NONE, FALSE, &rt1);
    ok(SUCCEEDED(hr), "CreateRenderTarget failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateRenderTarget(device, 480, 360, D3DFMT_A8R8G8B8,
            D3DMULTISAMPLE_NONE, FALSE, &rt2);
    ok(SUCCEEDED(hr), "CreateRenderTarget failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_GetDepthStencilSurface(device, &depth_stencil);
    ok(SUCCEEDED(hr), "GetDepthStencilSurface failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_GetRenderTarget(device, &backbuffer);
    ok(SUCCEEDED(hr), "GetRenderTarget failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderTarget(device, rt1, depth_stencil);
    ok(SUCCEEDED(hr), "SetRenderTarget failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0xff0000ff, 1.0f, 0);
    ok(SUCCEEDED(hr), "Clear failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderTarget(device, backbuffer, depth_stencil);
    ok(SUCCEEDED(hr), "SetRenderTarget failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0xff00ff00, 0.5f, 0);
    ok(SUCCEEDED(hr), "Clear failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderTarget(device, rt2, depth_stencil);
    ok(SUCCEEDED(hr), "SetRenderTarget failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0xffffffff, 0.0f, 0);
    ok(SUCCEEDED(hr), "Clear failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderTarget(device, backbuffer, depth_stencil);
    ok(SUCCEEDED(hr), "SetRenderTarget failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZWRITEENABLE, FALSE);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "BeginScene failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(*quad));
    ok(SUCCEEDED(hr), "DrawPrimitiveUP failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "EndScene failed, hr %#lx.\n", hr);

    for (i = 0; i < 4; ++i)
    {
        for (j = 0; j < 4; ++j)
        {
            unsigned int x = 80 * ((2 * j) + 1);
            unsigned int y = 60 * ((2 * i) + 1);
            color = getPixelColor(device, x, y);
            ok(color_match(color, D3DCOLOR_ARGB(0x00, 0x00, 0xff, 0x00), 0),
                    "Expected color 0x0000ff00 %u,%u, got 0x%08x.\n", x, y, color);
        }
    }

    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);

    IDirect3DSurface8_Release(depth_stencil);
    IDirect3DSurface8_Release(backbuffer);
    IDirect3DSurface8_Release(rt2);
    IDirect3DSurface8_Release(rt1);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void intz_test(void)
{
    IDirect3DSurface8 *original_rt, *rt;
    struct surface_readback rb;
    IDirect3DTexture8 *texture;
    IDirect3DDevice8 *device;
    IDirect3DSurface8 *ds;
    IDirect3D8 *d3d;
    ULONG refcount;
    D3DCAPS8 caps;
    HWND window;
    HRESULT hr;
    DWORD ps;
    UINT i;

    static const DWORD ps_code[] =
    {
        0xffff0101,                                                             /* ps_1_1                       */
        0x00000051, 0xa00f0000, 0x3f800000, 0x00000000, 0x3f800000, 0x3f800000, /* def c0, 1.0, 0.0, 1.0, 1.0   */
        0x00000051, 0xa00f0001, 0x00000000, 0x3f800000, 0x00000000, 0x00000000, /* def c1, 0.0, 1.0, 0.0, 0.0   */
        0x00000042, 0xb00f0000,                                                 /* tex t0                       */
        0x00000042, 0xb00f0001,                                                 /* tex t1                       */
        0x00000005, 0xb00f0000, 0xa0e40000, 0xb0e40000,                         /* mul t0, c0, t0               */
        0x00000004, 0x800f0000, 0xa0e40001, 0xb0e40001, 0xb0e40000,             /* mad r0, c1, t1, t0           */
        0x0000ffff,                                                             /* end                          */
    };
    static const struct
    {
        float x, y, z;
        float s0, t0, p0;
        float s1, t1, p1, q1;
    }
    quad[] =
    {
        { -1.0f,  1.0f, 0.0f, 0.0f, 1.0f, 1.0f, 0.0f, 1.0f, 1.0f, 0.5f},
        {  1.0f,  1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 0.5f},
        { -1.0f, -1.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.5f},
        {  1.0f, -1.0f, 1.0f, 1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f, 0.5f},
    },
    half_quad_1[] =
    {
        { -1.0f,  0.0f, 0.0f, 0.0f, 1.0f, 1.0f, 0.0f, 1.0f, 1.0f, 0.5f},
        {  1.0f,  0.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 0.5f},
        { -1.0f, -1.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.5f},
        {  1.0f, -1.0f, 1.0f, 1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f, 0.5f},
    },
    half_quad_2[] =
    {
        { -1.0f,  1.0f, 0.0f, 0.0f, 1.0f, 1.0f, 0.0f, 1.0f, 1.0f, 0.5f},
        {  1.0f,  1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 0.5f},
        { -1.0f,  0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.5f},
        {  1.0f,  0.0f, 1.0f, 1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f, 0.5f},
    };
    static const struct
    {
        unsigned int x, y, color;
    }
    expected_colors[] =
    {
        { 80, 100, 0x20204020},
        {240, 100, 0x6060bf60},
        {400, 100, 0x9f9f409f},
        {560, 100, 0xdfdfbfdf},
        { 80, 450, 0x20204020},
        {240, 450, 0x6060bf60},
        {400, 450, 0x9f9f409f},
        {560, 450, 0xdfdfbfdf},
    };

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "GetDeviceCaps failed, hr %#lx.\n", hr);
    if (caps.PixelShaderVersion < D3DPS_VERSION(1, 1))
    {
        skip("No pixel shader 1.1 support, skipping INTZ test.\n");
        IDirect3DDevice8_Release(device);
        goto done;
    }
    if (caps.TextureCaps & D3DPTEXTURECAPS_POW2)
    {
        skip("No unconditional NP2 texture support, skipping INTZ test.\n");
        IDirect3DDevice8_Release(device);
        goto done;
    }

    if (FAILED(hr = IDirect3D8_CheckDeviceFormat(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            D3DFMT_X8R8G8B8, D3DUSAGE_DEPTHSTENCIL, D3DRTYPE_TEXTURE, MAKEFOURCC('I','N','T','Z'))))
    {
        skip("No INTZ support, skipping INTZ test.\n");
        IDirect3DDevice8_Release(device);
        goto done;
    }

    hr = IDirect3DDevice8_GetRenderTarget(device, &original_rt);
    ok(SUCCEEDED(hr), "GetRenderTarget failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CreateTexture(device, 640, 480, 1,
            D3DUSAGE_DEPTHSTENCIL, MAKEFOURCC('I','N','T','Z'), D3DPOOL_DEFAULT, &texture);
    ok(SUCCEEDED(hr), "CreateTexture failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateRenderTarget(device, 640, 480, D3DFMT_A8R8G8B8,
            D3DMULTISAMPLE_NONE, FALSE, &rt);
    ok(SUCCEEDED(hr), "CreateRenderTarget failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreatePixelShader(device, ps_code, &ps);
    ok(SUCCEEDED(hr), "CreatePixelShader failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_TEX2
            | D3DFVF_TEXCOORDSIZE3(0) | D3DFVF_TEXCOORDSIZE4(1));
    ok(SUCCEEDED(hr), "SetVertexShader failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZENABLE, D3DZB_TRUE);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZFUNC, D3DCMP_ALWAYS);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZWRITEENABLE, TRUE);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_MINFILTER, D3DTEXF_POINT);
    ok(SUCCEEDED(hr), "SetTextureStageState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_MIPFILTER, D3DTEXF_POINT);
    ok(SUCCEEDED(hr), "SetTextureStageState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_MAGFILTER, D3DTEXF_POINT);
    ok(SUCCEEDED(hr), "SetTextureStageState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_TEXTURETRANSFORMFLAGS, D3DTTFF_COUNT3);
    ok(SUCCEEDED(hr), "SetTextureStageState failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTextureStageState(device, 1, D3DTSS_ADDRESSU, D3DTADDRESS_WRAP);
    ok(SUCCEEDED(hr), "SetTextureStageState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 1, D3DTSS_ADDRESSV, D3DTADDRESS_WRAP);
    ok(SUCCEEDED(hr), "SetTextureStageState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 1, D3DTSS_MAGFILTER, D3DTEXF_POINT);
    ok(SUCCEEDED(hr), "SetTextureStageState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 1, D3DTSS_MINFILTER, D3DTEXF_POINT);
    ok(SUCCEEDED(hr), "SetTextureStageState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 1, D3DTSS_MIPFILTER, D3DTEXF_POINT);
    ok(SUCCEEDED(hr), "SetTextureStageState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 1, D3DTSS_TEXTURETRANSFORMFLAGS,
            D3DTTFF_COUNT4 | D3DTTFF_PROJECTED);
    ok(SUCCEEDED(hr), "SetTextureStageState failed, hr %#lx.\n", hr);

    hr = IDirect3DTexture8_GetSurfaceLevel(texture, 0, &ds);
    ok(SUCCEEDED(hr), "GetSurfaceLevel failed, hr %#lx.\n", hr);

    /* Render offscreen, using the INTZ texture as depth buffer */
    hr = IDirect3DDevice8_SetRenderTarget(device, rt, ds);
    ok(SUCCEEDED(hr), "SetRenderTarget failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetPixelShader(device, 0);
    ok(SUCCEEDED(hr), "SetPixelShader failed, hr %#lx.\n", hr);

    /* Setup the depth/stencil surface. */
    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_ZBUFFER, 0, 0.0f, 0);
    ok(SUCCEEDED(hr), "Clear failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "BeginScene failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(*quad));
    ok(SUCCEEDED(hr), "DrawPrimitiveUP failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "EndScene failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderTarget(device, original_rt, NULL);
    ok(SUCCEEDED(hr), "SetRenderTarget failed, hr %#lx.\n", hr);
    IDirect3DSurface8_Release(ds);
    hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *)texture);
    ok(SUCCEEDED(hr), "SetTexture failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTexture(device, 1, (IDirect3DBaseTexture8 *)texture);
    ok(SUCCEEDED(hr), "SetTexture failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetPixelShader(device, ps);
    ok(SUCCEEDED(hr), "SetPixelShader failed, hr %#lx.\n", hr);

    /* Read the depth values back. */
    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "BeginScene failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(*quad));
    ok(SUCCEEDED(hr), "DrawPrimitiveUP failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "EndScene failed, hr %#lx.\n", hr);

    get_surface_readback(original_rt, &rb);
    for (i = 0; i < ARRAY_SIZE(expected_colors); ++i)
    {
        unsigned int color = get_readback_color(&rb, expected_colors[i].x, expected_colors[i].y);
        ok(color_match(color, expected_colors[i].color, 1),
                "Expected color 0x%08x at (%u, %u), got 0x%08x.\n",
                expected_colors[i].color, expected_colors[i].x, expected_colors[i].y, color);
    }
    release_surface_readback(&rb);

    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Present failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTexture(device, 0, NULL);
    ok(SUCCEEDED(hr), "SetTexture failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTexture(device, 1, NULL);
    ok(SUCCEEDED(hr), "SetTexture failed, hr %#lx.\n", hr);
    IDirect3DTexture8_Release(texture);

    /* Render onscreen while using the INTZ texture as depth buffer */
    hr = IDirect3DDevice8_CreateTexture(device, 640, 480, 1,
            D3DUSAGE_DEPTHSTENCIL, MAKEFOURCC('I','N','T','Z'), D3DPOOL_DEFAULT, &texture);
    ok(SUCCEEDED(hr), "CreateTexture failed, hr %#lx.\n", hr);
    hr = IDirect3DTexture8_GetSurfaceLevel(texture, 0, &ds);
    ok(SUCCEEDED(hr), "GetSurfaceLevel failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderTarget(device, original_rt, ds);
    ok(SUCCEEDED(hr), "SetRenderTarget failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetPixelShader(device, 0);
    ok(SUCCEEDED(hr), "SetPixelShader failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_ZBUFFER, 0, 0.0f, 0);
    ok(SUCCEEDED(hr), "Clear failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "BeginScene failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(*quad));
    ok(SUCCEEDED(hr), "DrawPrimitiveUP failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "EndScene failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderTarget(device, original_rt, NULL);
    ok(SUCCEEDED(hr), "SetRenderTarget failed, hr %#lx.\n", hr);
    IDirect3DSurface8_Release(ds);
    hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *)texture);
    ok(SUCCEEDED(hr), "SetTexture failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTexture(device, 1, (IDirect3DBaseTexture8 *)texture);
    ok(SUCCEEDED(hr), "SetTexture failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetPixelShader(device, ps);
    ok(SUCCEEDED(hr), "SetPixelShader failed, hr %#lx.\n", hr);

    /* Read the depth values back. */
    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "BeginScene failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(*quad));
    ok(SUCCEEDED(hr), "DrawPrimitiveUP failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "EndScene failed, hr %#lx.\n", hr);

    get_surface_readback(original_rt, &rb);
    for (i = 0; i < ARRAY_SIZE(expected_colors); ++i)
    {
        unsigned int color = get_readback_color(&rb, expected_colors[i].x, expected_colors[i].y);
        ok(color_match(color, expected_colors[i].color, 1),
                "Expected color 0x%08x at (%u, %u), got 0x%08x.\n",
                expected_colors[i].color, expected_colors[i].x, expected_colors[i].y, color);
    }
    release_surface_readback(&rb);

    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Present failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTexture(device, 0, NULL);
    ok(SUCCEEDED(hr), "SetTexture failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTexture(device, 1, NULL);
    ok(SUCCEEDED(hr), "SetTexture failed, hr %#lx.\n", hr);
    IDirect3DTexture8_Release(texture);

    /* Render offscreen, then onscreen, and finally check the INTZ texture in both areas */
    hr = IDirect3DDevice8_CreateTexture(device, 640, 480, 1,
            D3DUSAGE_DEPTHSTENCIL, MAKEFOURCC('I','N','T','Z'), D3DPOOL_DEFAULT, &texture);
    ok(SUCCEEDED(hr), "CreateTexture failed, hr %#lx.\n", hr);
    hr = IDirect3DTexture8_GetSurfaceLevel(texture, 0, &ds);
    ok(SUCCEEDED(hr), "GetSurfaceLevel failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderTarget(device, rt, ds);
    ok(SUCCEEDED(hr), "SetRenderTarget failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetPixelShader(device, 0);
    ok(SUCCEEDED(hr), "SetPixelShader failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_ZBUFFER, 0, 0.0f, 0);
    ok(SUCCEEDED(hr), "Clear failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "BeginScene failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, half_quad_1, sizeof(*half_quad_1));
    ok(SUCCEEDED(hr), "DrawPrimitiveUP failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "EndScene failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderTarget(device, original_rt, ds);
    ok(SUCCEEDED(hr), "SetRenderTarget failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "BeginScene failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, half_quad_2, sizeof(*half_quad_2));
    ok(SUCCEEDED(hr), "DrawPrimitiveUP failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "EndScene failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderTarget(device, original_rt, NULL);
    ok(SUCCEEDED(hr), "SetRenderTarget failed, hr %#lx.\n", hr);
    IDirect3DSurface8_Release(ds);
    hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *)texture);
    ok(SUCCEEDED(hr), "SetTexture failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTexture(device, 1, (IDirect3DBaseTexture8 *)texture);
    ok(SUCCEEDED(hr), "SetTexture failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetPixelShader(device, ps);
    ok(SUCCEEDED(hr), "SetPixelShader failed, hr %#lx.\n", hr);

    /* Read the depth values back. */
    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "BeginScene failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(*quad));
    ok(SUCCEEDED(hr), "DrawPrimitiveUP failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "EndScene failed, hr %#lx.\n", hr);

    get_surface_readback(original_rt, &rb);
    for (i = 0; i < ARRAY_SIZE(expected_colors); ++i)
    {
        unsigned int color = get_readback_color(&rb, expected_colors[i].x, expected_colors[i].y);
        ok(color_match(color, expected_colors[i].color, 1),
                "Expected color 0x%08x at (%u, %u), got 0x%08x.\n",
                expected_colors[i].color, expected_colors[i].x, expected_colors[i].y, color);
    }
    release_surface_readback(&rb);

    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Present failed, hr %#lx.\n", hr);

    IDirect3DTexture8_Release(texture);
    hr = IDirect3DDevice8_DeletePixelShader(device, ps);
    ok(SUCCEEDED(hr), "DeletePixelShader failed, hr %#lx.\n", hr);
    IDirect3DSurface8_Release(original_rt);
    IDirect3DSurface8_Release(rt);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void shadow_test(void)
{
    IDirect3DSurface8 *original_rt, *rt;
    struct surface_readback rb;
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d;
    ULONG refcount;
    D3DCAPS8 caps;
    DWORD ps[3];
    HWND window;
    HRESULT hr;
    UINT i;

    static const DWORD ps1_code[] =
    {
        0xffff0101,                                                             /* ps_1_1                       */
        0x00000051, 0xa00f0000, 0x3f800000, 0x00000000, 0x3f800000, 0x3f800000, /* def c0, 1.0, 0.0, 1.0, 1.0   */
        0x00000051, 0xa00f0001, 0x00000000, 0x3f800000, 0x00000000, 0x00000000, /* def c1, 0.0, 1.0, 0.0, 0.0   */
        0x00000042, 0xb00f0000,                                                 /* tex t0                       */
        0x00000042, 0xb00f0001,                                                 /* tex t1                       */
        0x00000005, 0xb00f0000, 0xa0e40000, 0xb0e40000,                         /* mul t0, c0, t0               */
        0x00000004, 0x800f0000, 0xa0e40001, 0xb0e40001, 0xb0e40000,             /* mad r0, c1, t1, t0           */
        0x0000ffff,                                                             /* end                          */
    };

    static const DWORD ps14_code[] =
    {
        0xffff0104,                                                             /* ps_1_4                       */
        0x00000042, 0x800f0000, 0xb0e40000,                                     /* texld r0, t0                 */
        0x0000ffff,                                                             /* end                          */
    };

    static const struct
    {
        D3DFORMAT format;
        const char *name;
    }
    formats[] =
    {
        {D3DFMT_D16_LOCKABLE,   "D3DFMT_D16_LOCKABLE"},
        {D3DFMT_D32,            "D3DFMT_D32"},
        {D3DFMT_D15S1,          "D3DFMT_D15S1"},
        {D3DFMT_D24S8,          "D3DFMT_D24S8"},
        {D3DFMT_D24X8,          "D3DFMT_D24X8"},
        {D3DFMT_D24X4S4,        "D3DFMT_D24X4S4"},
        {D3DFMT_D16,            "D3DFMT_D16"},
    };
    static const struct
    {
        float x, y, z;
        float s0, t0, p0;
        float s1, t1, p1, q1;
    }
    quad[] =
    {
        { -1.0f,  1.0f, 0.0f, 0.0f, 1.0f, 1.0f, 0.0f, 1.0f, 1.0f, 0.0f},
        {  1.0f,  1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 0.0f},
        { -1.0f, -1.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 1.0f},
        {  1.0f, -1.0f, 1.0f, 1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f, 1.0f},
    };
    static const struct
    {
        unsigned int x, y, color, ps1_color;
    }
    expected_colors[] =
    {
        {400,  60, 0x00000000, 0x00000000},
        {560, 180, 0xffffffff, 0xffff00ff},
        {560, 300, 0xffffffff, 0xffff00ff},
        {400, 420, 0xffffffff, 0xffffffff},
        {240, 420, 0xffffffff, 0xffffffff},
        { 80, 300, 0x00000000, 0x00000000},
        { 80, 180, 0x00000000, 0x00000000},
        {240,  60, 0x00000000, 0x00000000},
    };

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "GetDeviceCaps failed, hr %#lx.\n", hr);
    if (caps.PixelShaderVersion < D3DPS_VERSION(1, 1))
    {
        skip("No pixel shader 1.1 support, skipping shadow test.\n");
        IDirect3DDevice8_Release(device);
        goto done;
    }

    hr = IDirect3DDevice8_GetRenderTarget(device, &original_rt);
    ok(SUCCEEDED(hr), "GetRenderTarget failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CreateRenderTarget(device, 1024, 1024, D3DFMT_A8R8G8B8,
            D3DMULTISAMPLE_NONE, FALSE, &rt);
    ok(SUCCEEDED(hr), "CreateRenderTarget failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreatePixelShader(device, ps1_code, &ps[0]);
    ok(SUCCEEDED(hr), "CreatePixelShader failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreatePixelShader(device, ps14_code, &ps[1]);
    ok(SUCCEEDED(hr), "CreatePixelShader failed, hr %#lx.\n", hr);
    ps[2] = 0;

    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_TEX2
            | D3DFVF_TEXCOORDSIZE3(0) | D3DFVF_TEXCOORDSIZE4(1));
    ok(SUCCEEDED(hr), "SetVertexShader failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZENABLE, D3DZB_TRUE);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZFUNC, D3DCMP_ALWAYS);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZWRITEENABLE, TRUE);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_MINFILTER, D3DTEXF_POINT);
    ok(SUCCEEDED(hr), "SetTextureStageState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_MIPFILTER, D3DTEXF_POINT);
    ok(SUCCEEDED(hr), "SetTextureStageState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_MAGFILTER, D3DTEXF_POINT);
    ok(SUCCEEDED(hr), "SetTextureStageState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_TEXTURETRANSFORMFLAGS, D3DTTFF_COUNT3);
    ok(SUCCEEDED(hr), "SetTextureStageState failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTextureStageState(device, 1, D3DTSS_ADDRESSU, D3DTADDRESS_WRAP);
    ok(SUCCEEDED(hr), "SetTextureStageState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 1, D3DTSS_ADDRESSV, D3DTADDRESS_WRAP);
    ok(SUCCEEDED(hr), "SetTextureStageState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 1, D3DTSS_MAGFILTER, D3DTEXF_POINT);
    ok(SUCCEEDED(hr), "SetTextureStageState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 1, D3DTSS_MINFILTER, D3DTEXF_POINT);
    ok(SUCCEEDED(hr), "SetTextureStageState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 1, D3DTSS_MIPFILTER, D3DTEXF_POINT);
    ok(SUCCEEDED(hr), "SetTextureStageState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 1, D3DTSS_TEXTURETRANSFORMFLAGS,
            D3DTTFF_COUNT4 | D3DTTFF_PROJECTED);
    ok(SUCCEEDED(hr), "SetTextureStageState failed, hr %#lx.\n", hr);

    for (i = 0; i < ARRAY_SIZE(formats); ++i)
    {
        D3DFORMAT format = formats[i].format;
        IDirect3DTexture8 *texture;
        IDirect3DSurface8 *ds;
        unsigned int j;

        if (FAILED(IDirect3D8_CheckDeviceFormat(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
                D3DFMT_X8R8G8B8, D3DUSAGE_DEPTHSTENCIL, D3DRTYPE_TEXTURE, format)))
            continue;

        hr = IDirect3DDevice8_CreateTexture(device, 1024, 1024, 1,
                D3DUSAGE_DEPTHSTENCIL, format, D3DPOOL_DEFAULT, &texture);
        ok(SUCCEEDED(hr), "CreateTexture failed, hr %#lx.\n", hr);

        hr = IDirect3DTexture8_GetSurfaceLevel(texture, 0, &ds);
        ok(SUCCEEDED(hr), "GetSurfaceLevel failed, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_SetRenderTarget(device, rt, ds);
        ok(SUCCEEDED(hr), "SetRenderTarget failed, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_SetPixelShader(device, 0);
        ok(SUCCEEDED(hr), "SetPixelShader failed, hr %#lx.\n", hr);

        /* Setup the depth/stencil surface. */
        hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_ZBUFFER, 0, 0.0f, 0);
        ok(SUCCEEDED(hr), "Clear failed, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_BeginScene(device);
        ok(SUCCEEDED(hr), "BeginScene failed, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(*quad));
        ok(SUCCEEDED(hr), "DrawPrimitiveUP failed, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_EndScene(device);
        ok(SUCCEEDED(hr), "EndScene failed, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_SetRenderTarget(device, original_rt, NULL);
        ok(SUCCEEDED(hr), "SetRenderTarget failed, hr %#lx.\n", hr);
        IDirect3DSurface8_Release(ds);

        hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *)texture);
        ok(SUCCEEDED(hr), "SetTexture failed, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetTexture(device, 1, (IDirect3DBaseTexture8 *)texture);
        ok(SUCCEEDED(hr), "SetTexture failed, hr %#lx.\n", hr);

        for (unsigned int p = 0; p < 3; ++p)
        {
            winetest_push_context("ps %u", p);

            hr = IDirect3DDevice8_SetPixelShader(device, ps[p]);
            ok(SUCCEEDED(hr), "SetPixelShader failed, hr %#lx.\n", hr);

            /* Do the actual shadow mapping. */
            hr = IDirect3DDevice8_BeginScene(device);
            ok(SUCCEEDED(hr), "BeginScene failed, hr %#lx.\n", hr);
            hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(*quad));
            ok(SUCCEEDED(hr), "DrawPrimitiveUP failed, hr %#lx.\n", hr);
            hr = IDirect3DDevice8_EndScene(device);
            ok(SUCCEEDED(hr), "EndScene failed, hr %#lx.\n", hr);

            get_surface_readback(original_rt, &rb);
            for (j = 0; j < ARRAY_SIZE(expected_colors); ++j)
            {
                unsigned int color = get_readback_color(&rb, expected_colors[j].x, expected_colors[j].y);
                unsigned int expect = (p == 0 ? expected_colors[j].ps1_color : expected_colors[j].color);

                /* Geforce 7 on Windows returns 1.0 in alpha when the depth format is D24S8 or D24X8,
                 * whereas other GPUs (all AMD, newer Nvidia) return the same value they return in .rgb.
                 * Accept alpha mismatches as broken but make sure to check the color channels. */
                todo_wine_if (p == 2) ok(color_match(color, expect, 0)
                        || broken(color_match(color & 0x00ffffff, expect & 0x00ffffff, 0)),
                        "Expected color 0x%08x at (%u, %u), got 0x%08x.\n",
                        expect, expected_colors[j].x, expected_colors[j].y, color);
            }
            release_surface_readback(&rb);

            winetest_pop_context();
        }

        hr = IDirect3DDevice8_SetTexture(device, 0, NULL);
        ok(SUCCEEDED(hr), "SetTexture failed, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetTexture(device, 1, NULL);
        ok(SUCCEEDED(hr), "SetTexture failed, hr %#lx.\n", hr);
        IDirect3DTexture8_Release(texture);
        winetest_pop_context();
    }

    IDirect3DSurface8_Release(original_rt);
    IDirect3DSurface8_Release(rt);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void multisample_copy_rects_test(void)
{
    IDirect3DSurface8 *ds, *ds_plain, *rt, *readback;
    RECT src_rect = {64, 64, 128, 128};
    POINT dst_point = {96, 96};
    D3DLOCKED_RECT locked_rect;
    IDirect3DDevice8 *device;
    unsigned int color;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    if (FAILED(IDirect3D8_CheckDeviceMultiSampleType(d3d, D3DADAPTER_DEFAULT,
            D3DDEVTYPE_HAL, D3DFMT_A8R8G8B8, TRUE, D3DMULTISAMPLE_2_SAMPLES)))
    {
        skip("Multisampling not supported for D3DFMT_A8R8G8B8, skipping multisampled CopyRects test.\n");
        IDirect3DDevice8_Release(device);
        goto done;
    }

    hr = IDirect3DDevice8_CreateRenderTarget(device, 256, 256, D3DFMT_A8R8G8B8,
            D3DMULTISAMPLE_2_SAMPLES, FALSE, &rt);
    ok(SUCCEEDED(hr), "Failed to create render target, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateDepthStencilSurface(device, 256, 256, D3DFMT_D24S8,
            D3DMULTISAMPLE_2_SAMPLES, &ds);
    ok(SUCCEEDED(hr), "Failed to create depth stencil surface, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateDepthStencilSurface(device, 256, 256, D3DFMT_D24S8,
            D3DMULTISAMPLE_NONE, &ds_plain);
    ok(SUCCEEDED(hr), "Failed to create depth stencil surface, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateImageSurface(device, 256, 256, D3DFMT_A8R8G8B8, &readback);
    ok(SUCCEEDED(hr), "Failed to create readback surface, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderTarget(device, rt, ds);
    ok(SUCCEEDED(hr), "Failed to set render target, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0xff00ff00, 1.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear render target, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CopyRects(device, rt, NULL, 0, readback, NULL);
    ok(SUCCEEDED(hr), "Failed to read render target back, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CopyRects(device, ds, NULL, 0, ds_plain, NULL);
    ok(hr == D3DERR_INVALIDCALL, "Depth buffer copy, hr %#lx, expected %#lx.\n", hr, D3DERR_INVALIDCALL);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xffff0000, 0.0, 0);
    ok(SUCCEEDED(hr), "Failed to clear render target, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CopyRects(device, rt, &src_rect, 1, readback, &dst_point);
    ok(SUCCEEDED(hr), "Failed to read render target back, hr %#lx.\n", hr);

    hr = IDirect3DSurface8_LockRect(readback, &locked_rect, NULL, D3DLOCK_READONLY);
    ok(SUCCEEDED(hr), "Failed to lock readback surface, hr %#lx.\n", hr);

    color = *(DWORD *)((BYTE *)locked_rect.pBits + 31 * locked_rect.Pitch + 31 * 4);
    ok(color == 0xff00ff00, "Got unexpected color 0x%08x.\n", color);

    color = *(DWORD *)((BYTE *)locked_rect.pBits + 127 * locked_rect.Pitch + 127 * 4);
    ok(color == 0xffff0000, "Got unexpected color 0x%08x.\n", color);

    hr = IDirect3DSurface8_UnlockRect(readback);
    ok(SUCCEEDED(hr), "Failed to unlock readback surface, hr %#lx.\n", hr);

    IDirect3DSurface8_Release(readback);
    IDirect3DSurface8_Release(ds_plain);
    IDirect3DSurface8_Release(ds);
    IDirect3DSurface8_Release(rt);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void resz_test(void)
{
    IDirect3DSurface8 *rt, *original_rt, *ds, *original_ds, *intz_ds;
    IDirect3DTexture8 *texture;
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d;
    DWORD ps, value;
    unsigned int i;
    ULONG refcount;
    D3DCAPS8 caps;
    HWND window;
    HRESULT hr;

    static const DWORD ps_code[] =
    {
        0xffff0101,                                                             /* ps_1_1                       */
        0x00000051, 0xa00f0000, 0x3f800000, 0x00000000, 0x00000000, 0x00000000, /* def c0, 1.0, 0.0, 0.0, 0.0   */
        0x00000051, 0xa00f0001, 0x00000000, 0x3f800000, 0x00000000, 0x00000000, /* def c1, 0.0, 1.0, 0.0, 0.0   */
        0x00000051, 0xa00f0002, 0x00000000, 0x00000000, 0x3f800000, 0x00000000, /* def c2, 0.0, 0.0, 1.0, 0.0   */
        0x00000042, 0xb00f0000,                                                 /* tex t0                       */
        0x00000042, 0xb00f0001,                                                 /* tex t1                       */
        0x00000008, 0xb0070001, 0xa0e40000, 0xb0e40001,                         /* dp3 t1.xyz, c0, t1           */
        0x00000005, 0x80070000, 0xa0e40001, 0xb0e40001,                         /* mul r0.xyz, c1, t1           */
        0x00000004, 0x80070000, 0xa0e40000, 0xb0e40000, 0x80e40000,             /* mad r0.xyz, c0, t0, r0       */
        0x40000001, 0x80080000, 0xa0aa0002,                                     /* +mov r0.w, c2.z              */
        0x0000ffff,                                                             /* end                          */
    };
    static const struct
    {
        float x, y, z;
        float s0, t0, p0;
        float s1, t1, p1, q1;
    }
    quad[] =
    {
        { -1.0f,  1.0f, 0.0f, 0.0f, 1.0f, 1.0f, 0.0f, 1.0f, 1.0f, 0.5f},
        {  1.0f,  1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 0.5f},
        { -1.0f, -1.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.5f},
        {  1.0f, -1.0f, 1.0f, 1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f, 0.5f},
    };
    static const struct
    {
        unsigned int x, y, color;
    }
    expected_colors[] =
    {
        { 80, 100, D3DCOLOR_ARGB(0x00, 0x20, 0x40, 0x00)},
        {240, 100, D3DCOLOR_ARGB(0x00, 0x60, 0xbf, 0x00)},
        {400, 100, D3DCOLOR_ARGB(0x00, 0x9f, 0x40, 0x00)},
        {560, 100, D3DCOLOR_ARGB(0x00, 0xdf, 0xbf, 0x00)},
        { 80, 450, D3DCOLOR_ARGB(0x00, 0x20, 0x40, 0x00)},
        {240, 450, D3DCOLOR_ARGB(0x00, 0x60, 0xbf, 0x00)},
        {400, 450, D3DCOLOR_ARGB(0x00, 0x9f, 0x40, 0x00)},
        {560, 450, D3DCOLOR_ARGB(0x00, 0xdf, 0xbf, 0x00)},
    };

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    if (FAILED(IDirect3D8_CheckDeviceMultiSampleType(d3d, D3DADAPTER_DEFAULT,
            D3DDEVTYPE_HAL, D3DFMT_A8R8G8B8, TRUE, D3DMULTISAMPLE_2_SAMPLES)))
    {
        skip("Multisampling not supported for D3DFMT_A8R8G8B8, skipping RESZ test.\n");
        IDirect3DDevice8_Release(device);
        goto done;
    }
    if (FAILED(IDirect3D8_CheckDeviceMultiSampleType(d3d, D3DADAPTER_DEFAULT,
            D3DDEVTYPE_HAL, D3DFMT_D24S8, TRUE, D3DMULTISAMPLE_2_SAMPLES)))
    {
        skip("Multisampling not supported for D3DFMT_D24S8, skipping RESZ test.\n");
        IDirect3DDevice8_Release(device);
        goto done;
    }
    if (FAILED(IDirect3D8_CheckDeviceFormat(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            D3DFMT_X8R8G8B8, D3DUSAGE_DEPTHSTENCIL, D3DRTYPE_TEXTURE, MAKEFOURCC('I','N','T','Z'))))
    {
        skip("No INTZ support, skipping RESZ test.\n");
        IDirect3DDevice8_Release(device);
        goto done;
    }
    if (FAILED(IDirect3D8_CheckDeviceFormat(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            D3DFMT_X8R8G8B8, D3DUSAGE_RENDERTARGET, D3DRTYPE_SURFACE, MAKEFOURCC('R','E','S','Z'))))
    {
        skip("No RESZ support, skipping RESZ test.\n");
        IDirect3DDevice8_Release(device);
        goto done;
    }

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "GetDeviceCaps failed, hr %#lx.\n", hr);
    if (caps.TextureCaps & D3DPTEXTURECAPS_POW2)
    {
        skip("No unconditional NP2 texture support, skipping INTZ test.\n");
        IDirect3DDevice8_Release(device);
        goto done;
    }

    hr = IDirect3DDevice8_GetRenderTarget(device, &original_rt);
    ok(SUCCEEDED(hr), "Failed to get render target, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_GetDepthStencilSurface(device, &original_ds);
    ok(SUCCEEDED(hr), "Failed to get depth/stencil, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CreateRenderTarget(device, 640, 480, D3DFMT_A8R8G8B8,
            D3DMULTISAMPLE_2_SAMPLES, FALSE, &rt);
    ok(SUCCEEDED(hr), "Failed to create render target, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateDepthStencilSurface(device, 640, 480, D3DFMT_D24S8,
            D3DMULTISAMPLE_2_SAMPLES, &ds);

    hr = IDirect3DDevice8_CreateTexture(device, 640, 480, 1,
            D3DUSAGE_DEPTHSTENCIL, MAKEFOURCC('I','N','T','Z'), D3DPOOL_DEFAULT, &texture);
    ok(SUCCEEDED(hr), "CreateTexture failed, hr %#lx.\n", hr);
    hr = IDirect3DTexture8_GetSurfaceLevel(texture, 0, &intz_ds);
    ok(SUCCEEDED(hr), "GetSurfaceLevel failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderTarget(device, original_rt, intz_ds);
    ok(SUCCEEDED(hr), "Failed to set render target, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0xff00ffff, 1.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear render target, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderTarget(device, rt, ds);
    ok(SUCCEEDED(hr), "Failed to set render target, hr %#lx.\n", hr);
    IDirect3DSurface8_Release(intz_ds);
    hr = IDirect3DDevice8_CreatePixelShader(device, ps_code, &ps);
    ok(SUCCEEDED(hr), "CreatePixelShader failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_TEX2
            | D3DFVF_TEXCOORDSIZE3(0) | D3DFVF_TEXCOORDSIZE4(1));
    ok(SUCCEEDED(hr), "SetVertexShader failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZENABLE, D3DZB_TRUE);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZFUNC, D3DCMP_ALWAYS);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZWRITEENABLE, TRUE);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_MINFILTER, D3DTEXF_POINT);
    ok(SUCCEEDED(hr), "SetTextureStageState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_MIPFILTER, D3DTEXF_POINT);
    ok(SUCCEEDED(hr), "SetTextureStageState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_MAGFILTER, D3DTEXF_POINT);
    ok(SUCCEEDED(hr), "SetTextureStageState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_TEXTURETRANSFORMFLAGS, D3DTTFF_COUNT3);
    ok(SUCCEEDED(hr), "SetTextureStageState failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTextureStageState(device, 1, D3DTSS_ADDRESSU, D3DTADDRESS_WRAP);
    ok(SUCCEEDED(hr), "SetTextureStageState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 1, D3DTSS_ADDRESSV, D3DTADDRESS_WRAP);
    ok(SUCCEEDED(hr), "SetTextureStageState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 1, D3DTSS_MAGFILTER, D3DTEXF_POINT);
    ok(SUCCEEDED(hr), "SetTextureStageState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 1, D3DTSS_MINFILTER, D3DTEXF_POINT);
    ok(SUCCEEDED(hr), "SetTextureStageState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 1, D3DTSS_MIPFILTER, D3DTEXF_POINT);
    ok(SUCCEEDED(hr), "SetTextureStageState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 1, D3DTSS_TEXTURETRANSFORMFLAGS,
            D3DTTFF_COUNT4 | D3DTTFF_PROJECTED);
    ok(SUCCEEDED(hr), "SetTextureStageState failed, hr %#lx.\n", hr);

    /* Render offscreen (multisampled), blit the depth buffer into the INTZ texture and then check its contents. */
    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0xff00ff00, 1.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear render target, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "BeginScene failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(*quad));
    ok(SUCCEEDED(hr), "DrawPrimitiveUP failed, hr %#lx.\n", hr);

    /* The destination depth texture has to be bound to sampler 0 */
    hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *)texture);
    ok(SUCCEEDED(hr), "SetTexture failed, hr %#lx.\n", hr);

    /* the ATI "spec" says you have to do a dummy draw to ensure correct commands ordering */
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZENABLE, FALSE);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZWRITEENABLE, FALSE);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_COLORWRITEENABLE, 0);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(*quad));
    ok(SUCCEEDED(hr), "DrawPrimitiveUP failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZENABLE, TRUE);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZWRITEENABLE, TRUE);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_COLORWRITEENABLE, 0xf);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);

    /* The actual multisampled depth buffer resolve happens here */
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_POINTSIZE, 0x7fa05000);
    ok(SUCCEEDED(hr), "SetRenderState (multisampled depth buffer resolve) failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_GetRenderState(device, D3DRS_POINTSIZE, &value);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);
    ok(value == 0x7fa05000, "Got value %#lx.\n", value);

    hr = IDirect3DDevice8_SetRenderTarget(device, original_rt, NULL);
    ok(SUCCEEDED(hr), "Failed to set render target, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTexture(device, 1, (IDirect3DBaseTexture8 *)texture);
    ok(SUCCEEDED(hr), "SetTexture failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetPixelShader(device, ps);
    ok(SUCCEEDED(hr), "SetPixelShader failed, hr %#lx.\n", hr);

    /* Read the depth values back. */
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(*quad));
    ok(SUCCEEDED(hr), "DrawPrimitiveUP failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "EndScene failed, hr %#lx.\n", hr);

    for (i = 0; i < ARRAY_SIZE(expected_colors); ++i)
    {
        unsigned int color = getPixelColor(device, expected_colors[i].x, expected_colors[i].y);
        ok(color_match(color, expected_colors[i].color, 1),
                "Expected color 0x%08x at (%u, %u), got 0x%08x.\n",
                expected_colors[i].color, expected_colors[i].x, expected_colors[i].y, color);
    }

    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);

    /* Test edge cases - try with no texture at all */
    hr = IDirect3DDevice8_SetTexture(device, 0, NULL);
    ok(SUCCEEDED(hr), "SetTexture failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTexture(device, 1, NULL);
    ok(SUCCEEDED(hr), "SetTexture failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderTarget(device, rt, ds);
    ok(SUCCEEDED(hr), "Failed to set render target, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "BeginScene failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(*quad));
    ok(SUCCEEDED(hr), "DrawPrimitiveUP failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "EndScene failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_POINTSIZE, 0x7fa05000);
    ok(SUCCEEDED(hr), "SetRenderState (multisampled depth buffer resolve) failed, hr %#lx.\n", hr);

    /* With a non-multisampled depth buffer */
    IDirect3DSurface8_Release(ds);
    IDirect3DSurface8_Release(rt);
    hr = IDirect3DDevice8_CreateDepthStencilSurface(device, 640, 480, D3DFMT_D24S8,
            D3DMULTISAMPLE_NONE, &ds);

    hr = IDirect3DDevice8_SetRenderTarget(device, original_rt, ds);
    ok(SUCCEEDED(hr), "Failed to set render target, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetPixelShader(device, 0);
    ok(SUCCEEDED(hr), "SetPixelShader failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "BeginScene failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(*quad));
    ok(SUCCEEDED(hr), "DrawPrimitiveUP failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "EndScene failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *)texture);
    ok(SUCCEEDED(hr), "SetTexture failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "BeginScene failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZENABLE, FALSE);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZWRITEENABLE, FALSE);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_COLORWRITEENABLE, 0);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(*quad));
    ok(SUCCEEDED(hr), "DrawPrimitiveUP failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZENABLE, TRUE);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZWRITEENABLE, TRUE);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_COLORWRITEENABLE, 0xf);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "EndScene failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_POINTSIZE, 0x7fa05000);
    ok(SUCCEEDED(hr), "SetRenderState (multisampled depth buffer resolve) failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTexture(device, 1, (IDirect3DBaseTexture8 *)texture);
    ok(SUCCEEDED(hr), "SetTexture failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetPixelShader(device, ps);
    ok(SUCCEEDED(hr), "SetPixelShader failed, hr %#lx.\n", hr);

    /* Read the depth values back. */
    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "BeginScene failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(*quad));
    ok(SUCCEEDED(hr), "DrawPrimitiveUP failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "EndScene failed, hr %#lx.\n", hr);

    for (i = 0; i < ARRAY_SIZE(expected_colors); ++i)
    {
        unsigned int color = getPixelColor(device, expected_colors[i].x, expected_colors[i].y);
        ok(color_match(color, expected_colors[i].color, 1),
                "Expected color 0x%08x at (%u, %u), got 0x%08x.\n",
                expected_colors[i].color, expected_colors[i].x, expected_colors[i].y, color);
    }

    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);

    IDirect3DSurface8_Release(ds);
    IDirect3DTexture8_Release(texture);
    hr = IDirect3DDevice8_DeletePixelShader(device, ps);
    ok(SUCCEEDED(hr), "DeletePixelShader failed, hr %#lx.\n", hr);
    IDirect3DSurface8_Release(original_ds);
    IDirect3DSurface8_Release(original_rt);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void zenable_test(void)
{
    unsigned int color, x, y, i, j, test;
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d;
    ULONG refcount;
    D3DCAPS8 caps;
    HWND window;
    HRESULT hr;
    IDirect3DSurface8 *ds, *rt;

    static const struct
    {
        struct vec4 position;
        D3DCOLOR diffuse;
    }
    tquad[] =
    {
        {{  0.0f, 480.0f, -0.5f, 1.0f}, 0xff00ff00},
        {{  0.0f,   0.0f, -0.5f, 1.0f}, 0xff00ff00},
        {{640.0f, 480.0f,  1.5f, 1.0f}, 0xff00ff00},
        {{640.0f,   0.0f,  1.5f, 1.0f}, 0xff00ff00},
    };

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    hr = IDirect3DDevice8_GetDepthStencilSurface(device, &ds);
    ok(SUCCEEDED(hr), "Failed to get depth stencil surface, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_GetRenderTarget(device, &rt);
    ok(SUCCEEDED(hr), "Failed to get render target surface, hr %#lx.\n", hr);

    for (test = 0; test < 2; ++test)
    {
        /* The Windows 8 testbot (WARP) appears to clip with
         * ZENABLE = D3DZB_TRUE and no depth buffer set. */
        static const D3DCOLOR expected_broken[] =
        {
            0x00ff0000, 0x0000ff00, 0x0000ff00, 0x00ff0000,
            0x00ff0000, 0x0000ff00, 0x0000ff00, 0x00ff0000,
            0x00ff0000, 0x0000ff00, 0x0000ff00, 0x00ff0000,
            0x00ff0000, 0x0000ff00, 0x0000ff00, 0x00ff0000,
        };

        if (!test)
        {
            hr = IDirect3DDevice8_SetRenderTarget(device, rt, NULL);
            ok(SUCCEEDED(hr), "Failed to set depth stencil surface, hr %#lx.\n", hr);
        }
        else
        {
            hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZENABLE, D3DZB_FALSE);
            ok(SUCCEEDED(hr), "Failed to disable z-buffering, hr %#lx.\n", hr);
            hr = IDirect3DDevice8_SetRenderTarget(device, rt, ds);
            ok(SUCCEEDED(hr), "Failed to set depth stencil surface, hr %#lx.\n", hr);
            hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_ZBUFFER, 0x00000000, 0.0f, 0);
            ok(SUCCEEDED(hr), "Failed to clear render target, hr %#lx.\n", hr);
        }
        hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZRHW | D3DFVF_DIFFUSE);
        ok(SUCCEEDED(hr), "Failed to set FVF, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xffff0000, 0.0f, 0);
        ok(SUCCEEDED(hr), "Failed to clear render target, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_BeginScene(device);
        ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, tquad, sizeof(*tquad));
        ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_EndScene(device);
        ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

        for (i = 0; i < 4; ++i)
        {
            for (j = 0; j < 4; ++j)
            {
                x = 80 * ((2 * j) + 1);
                y = 60 * ((2 * i) + 1);
                color = getPixelColor(device, x, y);
                ok(color_match(color, 0x0000ff00, 1)
                        || broken(color_match(color, expected_broken[i * 4 + j], 1) && !test),
                        "Expected color 0x0000ff00 at %u, %u, got 0x%08x.\n", x, y, color);
            }
        }

        hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
        ok(SUCCEEDED(hr), "Failed to present backbuffer, hr %#lx.\n", hr);
    }

    IDirect3DSurface8_Release(ds);
    IDirect3DSurface8_Release(rt);

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get device caps, hr %#lx.\n", hr);

    if (caps.PixelShaderVersion >= D3DPS_VERSION(1, 1)
            && caps.VertexShaderVersion >= D3DVS_VERSION(1, 1))
    {
        static const DWORD vs_code[] =
        {
            0xfffe0101,                                 /* vs_1_1           */
            0x00000001, 0xc00f0000, 0x90e40000,         /* mov oPos, v0     */
            0x00000001, 0xd00f0000, 0x90e40000,         /* mov oD0, v0      */
            0x0000ffff
        };
        static const DWORD ps_code[] =
        {
            0xffff0101,                                 /* ps_1_1           */
            0x00000001, 0x800f0000, 0x90e40000,         /* mov r0, v0       */
            0x0000ffff                                  /* end              */
        };
        static const struct vec3 quad[] =
        {
            {-1.0f, -1.0f, -0.5f},
            {-1.0f,  1.0f, -0.5f},
            { 1.0f, -1.0f,  1.5f},
            { 1.0f,  1.0f,  1.5f},
        };
        static const unsigned int expected[] =
        {
            0x00ff0000, 0x0060df60, 0x009fdf9f, 0x00ff0000,
            0x00ff0000, 0x00609f60, 0x009f9f9f, 0x00ff0000,
            0x00ff0000, 0x00606060, 0x009f609f, 0x00ff0000,
            0x00ff0000, 0x00602060, 0x009f209f, 0x00ff0000,
        };
        /* The Windows 8 testbot (WARP) appears to not clip z for regular
         * vertices either. */
        static const D3DCOLOR expected_broken[] =
        {
            0x0020df20, 0x0060df60, 0x009fdf9f, 0x00dfdfdf,
            0x00209f20, 0x00609f60, 0x009f9f9f, 0x00df9fdf,
            0x00206020, 0x00606060, 0x009f609f, 0x00df60df,
            0x00202020, 0x00602060, 0x009f209f, 0x00df20df,
        };
        static const DWORD decl[] =
        {
            D3DVSD_STREAM(0),
            D3DVSD_REG(D3DVSDE_POSITION, D3DVSDT_FLOAT3),
            D3DVSD_END()
        };
        DWORD vs, ps;

        hr = IDirect3DDevice8_CreateVertexShader(device, decl, vs_code, &vs, 0);
        ok(SUCCEEDED(hr), "Failed to create vertex shader, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_CreatePixelShader(device, ps_code, &ps);
        ok(SUCCEEDED(hr), "Failed to create pixel shader, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetVertexShader(device, vs);
        ok(SUCCEEDED(hr), "Failed to set vertex shader, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetPixelShader(device, ps);
        ok(SUCCEEDED(hr), "Failed to set pixel shader, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0xffff0000, 0.0f, 0);
        ok(SUCCEEDED(hr), "Failed to clear render target, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_BeginScene(device);
        ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(*quad));
        ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_EndScene(device);
        ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

        for (i = 0; i < 4; ++i)
        {
            for (j = 0; j < 4; ++j)
            {
                x = 80 * ((2 * j) + 1);
                y = 60 * ((2 * i) + 1);
                color = getPixelColor(device, x, y);
                ok(color_match(color, expected[i * 4 + j], 1)
                        || broken(color_match(color, expected_broken[i * 4 + j], 1)),
                        "Expected color 0x%08x at %u, %u, got 0x%08x.\n", expected[i * 4 + j], x, y, color);
            }
        }

        hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
        ok(SUCCEEDED(hr), "Failed to present backbuffer, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_DeletePixelShader(device, ps);
        ok(SUCCEEDED(hr), "Failed to delete pixel shader, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_DeleteVertexShader(device, vs);
        ok(SUCCEEDED(hr), "Failed to delete vertex shader, hr %#lx.\n", hr);
    }

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void fog_special_test(void)
{
    IDirect3DDevice8 *device;
    unsigned int color, i;
    IDirect3D8 *d3d;
    ULONG refcount;
    D3DCAPS8 caps;
    DWORD ps, vs;
    HWND window;
    HRESULT hr;
    union
    {
        float f;
        DWORD d;
    } conv;

    static const struct
    {
        struct vec3 position;
        D3DCOLOR diffuse;
    }
    quad[] =
    {
        {{ -1.0f,  -1.0f,  0.0f}, 0xff00ff00},
        {{ -1.0f,   1.0f,  0.0f}, 0xff00ff00},
        {{  1.0f,  -1.0f,  1.0f}, 0xff00ff00},
        {{  1.0f,   1.0f,  1.0f}, 0xff00ff00}
    };
    static const struct
    {
        DWORD vertexmode, tablemode;
        BOOL vs, ps;
        unsigned int color_left, color_right;
    }
    tests[] =
    {
        {D3DFOG_LINEAR, D3DFOG_NONE,   FALSE, FALSE, 0x00ff0000, 0x00ff0000},
        {D3DFOG_LINEAR, D3DFOG_NONE,   FALSE, TRUE,  0x00ff0000, 0x00ff0000},
        {D3DFOG_LINEAR, D3DFOG_NONE,   TRUE,  FALSE, 0x00ff0000, 0x00ff0000},
        {D3DFOG_LINEAR, D3DFOG_NONE,   TRUE,  TRUE,  0x00ff0000, 0x00ff0000},

        {D3DFOG_NONE,   D3DFOG_LINEAR, FALSE, FALSE, 0x0000ff00, 0x00ff0000},
        {D3DFOG_NONE,   D3DFOG_LINEAR, FALSE, TRUE,  0x0000ff00, 0x00ff0000},
        {D3DFOG_NONE,   D3DFOG_LINEAR, TRUE,  FALSE, 0x0000ff00, 0x00ff0000},
        {D3DFOG_NONE,   D3DFOG_LINEAR, TRUE,  TRUE,  0x0000ff00, 0x00ff0000},
    };
    static const DWORD pixel_shader_code[] =
    {
        0xffff0101,                                 /* ps.1.1               */
        0x00000001, 0x800f0000, 0x90e40000,         /* mov r0, v0           */
        0x0000ffff
    };
    static const DWORD vertex_decl[] =
    {
        D3DVSD_STREAM(0),
        D3DVSD_REG(0, D3DVSDT_FLOAT3),              /* position, v0         */
        D3DVSD_REG(1, D3DVSDT_D3DCOLOR),            /* diffuse color, v1    */
        D3DVSD_END()
    };
    static const DWORD vertex_shader_code[] =
    {
        0xfffe0101,                                 /* vs.1.1               */
        0x00000001, 0xc00f0000, 0x90e40000,         /* mov oPos, v0         */
        0x00000001, 0xd00f0000, 0x90e40001,         /* mov oD0, v1          */
        0x0000ffff
    };
    static const D3DMATRIX identity =
    {{{
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f,
    }}};

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get device caps, hr %#lx.\n", hr);
    if (caps.VertexShaderVersion >= D3DVS_VERSION(1, 1))
    {
        hr = IDirect3DDevice8_CreateVertexShader(device, vertex_decl, vertex_shader_code, &vs, 0);
        ok(SUCCEEDED(hr), "Failed to create vertex shader, hr %#lx.\n", hr);
    }
    else
    {
        skip("Vertex Shaders not supported, skipping some fog tests.\n");
        vs = 0;
    }
    if (caps.PixelShaderVersion >= D3DPS_VERSION(1, 1))
    {
        hr = IDirect3DDevice8_CreatePixelShader(device, pixel_shader_code, &ps);
        ok(SUCCEEDED(hr), "Failed to create pixel shader, hr %#lx.\n", hr);
    }
    else
    {
        skip("Pixel Shaders not supported, skipping some fog tests.\n");
        ps = 0;
    }

    /* The table fog tests seem to depend on the projection matrix explicitly
     * being set to an identity matrix, even though that's the default.
     * (AMD Radeon HD 6310, Windows 7) */
    hr = IDirect3DDevice8_SetTransform(device, D3DTS_PROJECTION, &identity);
    ok(SUCCEEDED(hr), "Failed to set projection transform, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable lighting, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGENABLE, TRUE);
    ok(SUCCEEDED(hr), "Failed to enable fog, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGCOLOR, 0xffff0000);
    ok(SUCCEEDED(hr), "Failed to set fog color, hr %#lx.\n", hr);

    conv.f = 0.5f;
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGSTART, conv.d);
    ok(SUCCEEDED(hr), "Failed to set fog start, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGEND, conv.d);
    ok(SUCCEEDED(hr), "Failed to set fog end, hr %#lx.\n", hr);

    for (i = 0; i < ARRAY_SIZE(tests); i++)
    {
        hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0xff0000ff, 1.0f, 0);
        ok(SUCCEEDED(hr), "Failed to clear render target, hr %#lx.\n", hr);

        if (!tests[i].vs)
        {
            hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_DIFFUSE);
            ok(SUCCEEDED(hr), "Failed to set fvf, hr %#lx.\n", hr);
        }
        else if (vs)
        {
            hr = IDirect3DDevice8_SetVertexShader(device, vs);
            ok(SUCCEEDED(hr), "Failed to set vertex shader, hr %#lx.\n", hr);
        }
        else
        {
            continue;
        }

        if (!tests[i].ps)
        {
            hr = IDirect3DDevice8_SetPixelShader(device, 0);
            ok(SUCCEEDED(hr), "Failed to set pixel shader, hr %#lx.\n", hr);
        }
        else if (ps)
        {
            hr = IDirect3DDevice8_SetPixelShader(device, ps);
            ok(SUCCEEDED(hr), "Failed to set pixel shader, hr %#lx.\n", hr);
        }
        else
        {
            continue;
        }

        hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGVERTEXMODE, tests[i].vertexmode);
        ok(SUCCEEDED(hr), "Failed to set fogvertexmode, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGTABLEMODE, tests[i].tablemode);
        ok(SUCCEEDED(hr), "Failed to set fogtablemode, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_BeginScene(device);
        ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(*quad));
        ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_EndScene(device);
        ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

        color = getPixelColor(device, 310, 240);
        todo_wine_if(tests[i].vertexmode == D3DFOG_NONE) ok(color_match(color, tests[i].color_left, 1),
                "Expected left color 0x%08x, got 0x%08x, case %u.\n", tests[i].color_left, color, i);
        color = getPixelColor(device, 330, 240);
        ok(color_match(color, tests[i].color_right, 1),
                "Expected right color 0x%08x, got 0x%08x, case %u.\n", tests[i].color_right, color, i);

        hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
        ok(SUCCEEDED(hr), "Failed to present backbuffer, hr %#lx.\n", hr);
    }

    if (vs)
        IDirect3DDevice8_DeleteVertexShader(device, vs);
    if (ps)
        IDirect3DDevice8_DeletePixelShader(device, ps);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void volume_dxtn_test(void)
{
    IDirect3DVolumeTexture8 *texture;
    struct surface_readback rb;
    unsigned int colour, i, j;
    IDirect3DDevice8 *device;
    IDirect3DSurface8 *rt;
    D3DLOCKED_BOX box;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    static const BYTE dxt1_data[] =
    {
        0x00, 0xf8, 0x00, 0xf8, 0xf0, 0xf0, 0xf0, 0xf0,
        0xe0, 0x07, 0xe0, 0x07, 0x00, 0x00, 0x00, 0x00,
        0x1f, 0x00, 0x1f, 0x00, 0x00, 0x00, 0x00, 0x00,
        0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00
    };
    static const BYTE dxt3_data[] =
    {
        0xff, 0xee, 0xff, 0xee, 0xff, 0xee, 0xff, 0xee, 0x00, 0xf8, 0x00, 0xf8, 0x00, 0x00, 0x00, 0x00,
        0xff, 0xdd, 0xff, 0xdd, 0xff, 0xdd, 0xff, 0xdd, 0xe0, 0x07, 0xe0, 0x07, 0x00, 0x00, 0x00, 0x00,
        0xff, 0xcc, 0xff, 0xcc, 0xff, 0xcc, 0xff, 0xcc, 0x1f, 0x00, 0x1f, 0x00, 0x00, 0x00, 0x00, 0x00,
        0xff, 0xbb, 0xff, 0xbb, 0xff, 0xbb, 0xff, 0xbb, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00
    };
    static const BYTE dxt5_data[] =
    {
        /* A 8x4x2 texture consisting of 4 4x4 blocks. The colours of the
         * blocks are red, green, blue and white. */
        0xff, 0xff, 0x80, 0x0d, 0xd8, 0x80, 0x0d, 0xd8, 0x00, 0xf8, 0x00, 0xf8, 0x00, 0x00, 0x00, 0x00,
        0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xe0, 0x07, 0xe0, 0x07, 0x00, 0x00, 0x00, 0x00,
        0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f, 0x00, 0x1f, 0x00, 0x00, 0x00, 0x00, 0x00,
        0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00
    };
    static const unsigned int dxt1_expected_colours[] =
    {
        0xffff0000, 0x00000000, 0xff00ff00, 0xff00ff00,
        0xff0000ff, 0xff0000ff, 0xffffffff, 0xffffffff,
    };
    static const unsigned int dxt3_expected_colours[] =
    {
        0xffff0000, 0xeeff0000, 0xff00ff00, 0xdd00ff00,
        0xff0000ff, 0xcc0000ff, 0xffffffff, 0xbbffffff,
    };
    static const unsigned int dxt5_expected_colours[] =
    {
        0xffff0000, 0x00ff0000, 0xff00ff00, 0xff00ff00,
        0xff0000ff, 0xff0000ff, 0xffffffff, 0xffffffff
    };

    static const struct
    {
        const char *name;
        D3DFORMAT format;
        const BYTE *data;
        DWORD data_size;
        const unsigned int *expected_colours;
    }
    tests[] =
    {
        {"DXT1", D3DFMT_DXT1, dxt1_data, sizeof(dxt1_data), dxt1_expected_colours},
        {"DXT3", D3DFMT_DXT3, dxt3_data, sizeof(dxt3_data), dxt3_expected_colours},
        {"DXT5", D3DFMT_DXT5, dxt5_data, sizeof(dxt5_data), dxt5_expected_colours},
    };

    static const struct
    {
        struct vec3 position;
        struct vec3 texcrd;
    }
    quads[] =
    {
        {{ -1.0f,  -1.0f,  0.0f}, { 0.0f, 0.0f, 0.25f}},
        {{ -1.0f,   1.0f,  0.0f}, { 0.0f, 1.0f, 0.25f}},
        {{  0.0f,  -1.0f,  1.0f}, { 1.0f, 0.0f, 0.25f}},
        {{  0.0f,   1.0f,  1.0f}, { 1.0f, 1.0f, 0.25f}},

        {{  0.0f,  -1.0f,  0.0f}, { 0.0f, 0.0f, 0.75f}},
        {{  0.0f,   1.0f,  0.0f}, { 0.0f, 1.0f, 0.75f}},
        {{  1.0f,  -1.0f,  1.0f}, { 1.0f, 0.0f, 0.75f}},
        {{  1.0f,   1.0f,  1.0f}, { 1.0f, 1.0f, 0.75f}},
    };

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");

    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    hr = IDirect3DDevice8_GetRenderTarget(device, &rt);
    ok(SUCCEEDED(hr), "Failed to get render target, hr %#lx.\n", hr);

    for (i = 0; i < ARRAY_SIZE(tests); ++i)
    {
        if (FAILED(IDirect3D8_CheckDeviceFormat(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
                D3DFMT_X8R8G8B8, 0, D3DRTYPE_VOLUMETEXTURE, tests[i].format)))
        {
            skip("%s volume textures are not supported, skipping test.\n", tests[i].name);
            continue;
        }
        hr = IDirect3DDevice8_CreateVolumeTexture(device, 8, 4, 2, 1, 0,
                tests[i].format, D3DPOOL_MANAGED, &texture);
        ok(SUCCEEDED(hr), "Failed to create volume texture, hr %#lx.\n", hr);

        hr = IDirect3DVolumeTexture8_LockBox(texture, 0, &box, NULL, 0);
        ok(SUCCEEDED(hr), "Failed to lock volume texture, hr %#lx.\n", hr);
        memcpy(box.pBits, tests[i].data, tests[i].data_size);
        hr = IDirect3DVolumeTexture8_UnlockBox(texture, 0);
        ok(SUCCEEDED(hr), "Failed to unlock volume texture, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_TEX1 | D3DFVF_TEXCOORDSIZE3(0));
        ok(SUCCEEDED(hr), "Failed to set FVF, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *)texture);
        ok(SUCCEEDED(hr), "Failed to set texture, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_COLOROP, D3DTOP_SELECTARG1);
        ok(SUCCEEDED(hr), "Failed to set colour op, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_COLORARG1, D3DTA_TEXTURE);
        ok(SUCCEEDED(hr), "Failed to set colour arg, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetTextureStageState(device, 1, D3DTSS_COLOROP, D3DTOP_DISABLE);
        ok(SUCCEEDED(hr), "Failed to set colour op, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_MAGFILTER, D3DTEXF_POINT);
        ok(SUCCEEDED(hr), "Failed to set mag filter, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0x00ff00ff, 1.0f, 0);
        ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_BeginScene(device);
        ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, &quads[0], sizeof(*quads));
        ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, &quads[4], sizeof(*quads));
        ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_EndScene(device);
        ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

        get_surface_readback(rt, &rb);
        for (j = 0; j < ARRAY_SIZE(dxt1_expected_colours); ++j)
        {
            colour = get_readback_color(&rb, 40 + 80 * j, 240);
            ok(color_match(colour, tests[i].expected_colours[j], 1),
                    "Expected colour 0x%08x, got 0x%08x, case %u.\n", tests[i].expected_colours[j], colour, j);
        }
        release_surface_readback(&rb);

        hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
        ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);
        IDirect3DVolumeTexture8_Release(texture);
    }

    IDirect3DSurface8_Release(rt);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void volume_v16u16_test(void)
{
    IDirect3DVolumeTexture8 *texture;
    IDirect3DDevice8 *device;
    unsigned int color, i;
    D3DLOCKED_BOX box;
    IDirect3D8 *d3d;
    ULONG refcount;
    D3DCAPS8 caps;
    DWORD shader;
    SHORT *texel;
    HWND window;
    HRESULT hr;

    static const struct
    {
        struct vec3 position;
        struct vec3 texcrd;
    }
    quads[] =
    {
        {{ -1.0f,  -1.0f,  0.0f}, { 0.0f, 0.0f, 0.25f}},
        {{ -1.0f,   1.0f,  0.0f}, { 0.0f, 1.0f, 0.25f}},
        {{  0.0f,  -1.0f,  1.0f}, { 1.0f, 0.0f, 0.25f}},
        {{  0.0f,   1.0f,  1.0f}, { 1.0f, 1.0f, 0.25f}},

        {{  0.0f,  -1.0f,  0.0f}, { 0.0f, 0.0f, 0.75f}},
        {{  0.0f,   1.0f,  0.0f}, { 0.0f, 1.0f, 0.75f}},
        {{  1.0f,  -1.0f,  1.0f}, { 1.0f, 0.0f, 0.75f}},
        {{  1.0f,   1.0f,  1.0f}, { 1.0f, 1.0f, 0.75f}},
    };
    static const DWORD shader_code[] =
    {
        0xffff0101,                                                     /* ps_1_1               */
        0x00000051, 0xa00f0000, 0x3f000000, 0x3f000000,                 /* def c0, 0.5, 0.5,    */
        0x3f000000, 0x3f000000,                                         /*         0.5, 0.5     */
        0x00000042, 0xb00f0000,                                         /* tex t0               */
        0x00000004, 0x800f0000, 0xb0e40000, 0xa0e40000, 0xa0e40000,     /* mad r0, t0, c0, c0   */
        0x0000ffff                                                      /* end                  */
    };

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    if (FAILED(IDirect3D8_CheckDeviceFormat(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            D3DFMT_X8R8G8B8, 0, D3DRTYPE_VOLUMETEXTURE, D3DFMT_V16U16)))
    {
        skip("Volume V16U16 textures are not supported, skipping test.\n");
        IDirect3DDevice8_Release(device);
        goto done;
    }
    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get caps, hr %#lx.\n", hr);
    if (caps.PixelShaderVersion < D3DPS_VERSION(1, 1))
    {
        skip("No pixel shader 1.1 support, skipping test.\n");
        IDirect3DDevice8_Release(device);
        goto done;
    }

    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_TEX1 | D3DFVF_TEXCOORDSIZE3(0));
    ok(SUCCEEDED(hr), "Failed to set FVF, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreatePixelShader(device, shader_code, &shader);
    ok(SUCCEEDED(hr), "Failed to create pixel shader, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetPixelShader(device, shader);
    ok(SUCCEEDED(hr), "Failed to set pixel shader, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_MAGFILTER, D3DTEXF_POINT);
    ok(SUCCEEDED(hr), "Failed to set filter, hr %#lx.\n", hr);

    for (i = 0; i < 2; i++)
    {
        D3DPOOL pool;

        if (i)
            pool = D3DPOOL_SYSTEMMEM;
        else
            pool = D3DPOOL_MANAGED;

        hr = IDirect3DDevice8_CreateVolumeTexture(device, 1, 2, 2, 1, 0, D3DFMT_V16U16,
                pool, &texture);
        ok(SUCCEEDED(hr), "Failed to create volume texture, hr %#lx.\n", hr);

        hr = IDirect3DVolumeTexture8_LockBox(texture, 0, &box, NULL, 0);
        ok(SUCCEEDED(hr), "Failed to lock volume texture, hr %#lx.\n", hr);

        texel = (SHORT *)((BYTE *)box.pBits + 0 * box.RowPitch + 0 * box.SlicePitch);
        texel[0] = 32767;
        texel[1] = 32767;
        texel = (SHORT *)((BYTE *)box.pBits + 1 * box.RowPitch + 0 * box.SlicePitch);
        texel[0] = -32768;
        texel[1] = 0;
        texel = (SHORT *)((BYTE *)box.pBits + 0 * box.RowPitch + 1 * box.SlicePitch);
        texel[0] = -16384;
        texel[1] =  16384;
        texel = (SHORT *)((BYTE *)box.pBits + 1 * box.RowPitch + 1 * box.SlicePitch);
        texel[0] =  0;
        texel[1] =  0;

        hr = IDirect3DVolumeTexture8_UnlockBox(texture, 0);
        ok(SUCCEEDED(hr), "Failed to unlock volume texture, hr %#lx.\n", hr);

        if (i)
        {
            IDirect3DVolumeTexture8 *texture2;

            hr = IDirect3DDevice8_CreateVolumeTexture(device, 1, 2, 2, 1, 0, D3DFMT_V16U16,
                    D3DPOOL_DEFAULT, &texture2);
            ok(SUCCEEDED(hr), "Failed to create volume texture, hr %#lx.\n", hr);

            hr = IDirect3DDevice8_UpdateTexture(device, (IDirect3DBaseTexture8 *)texture,
                    (IDirect3DBaseTexture8 *)texture2);
            ok(SUCCEEDED(hr), "Failed to update texture, hr %#lx.\n", hr);

            IDirect3DVolumeTexture8_Release(texture);
            texture = texture2;
        }

        hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *) texture);
        ok(SUCCEEDED(hr), "Failed to set texture, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0x00ff00ff, 1.0f, 0);
        ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_BeginScene(device);
        ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, &quads[0], sizeof(*quads));
        ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, &quads[4], sizeof(*quads));
        ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_EndScene(device);
        ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

        color = getPixelColor(device, 120, 160);
        ok (color_match(color, 0x000080ff, 2),
                "Expected color 0x000080ff, got 0x%08x, V16U16 input -32768, 0.\n", color);
        color = getPixelColor(device, 120, 400);
        ok (color_match(color, 0x00ffffff, 2),
                "Expected color 0x00ffffff, got 0x%08x, V16U16 input 32767, 32767.\n", color);
        color = getPixelColor(device, 360, 160);
        ok (color_match(color, 0x007f7fff, 2),
                "Expected color 0x007f7fff, got 0x%08x, V16U16 input 0, 0.\n", color);
        color = getPixelColor(device, 360, 400);
        ok (color_match(color, 0x0040c0ff, 2),
                "Expected color 0x0040c0ff, got 0x%08x, V16U16 input -16384, 16384.\n", color);

        hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
        ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

        IDirect3DVolumeTexture8_Release(texture);
    }

    hr = IDirect3DDevice8_DeletePixelShader(device, shader);
    ok(SUCCEEDED(hr), "Failed delete pixel shader, hr %#lx.\n", hr);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void fill_surface(IDirect3DSurface8 *surface, DWORD color, DWORD flags)
{
    D3DSURFACE_DESC desc;
    D3DLOCKED_RECT l;
    HRESULT hr;
    unsigned int x, y;
    DWORD *mem;

    hr = IDirect3DSurface8_GetDesc(surface, &desc);
    ok(SUCCEEDED(hr), "Failed to get surface desc, hr %#lx.\n", hr);
    hr = IDirect3DSurface8_LockRect(surface, &l, NULL, flags);
    ok(SUCCEEDED(hr), "Failed to lock surface, hr %#lx.\n", hr);
    if (FAILED(hr))
        return;

    for (y = 0; y < desc.Height; y++)
    {
        mem = (DWORD *)((BYTE *)l.pBits + y * l.Pitch);
        for (x = 0; x < l.Pitch / sizeof(DWORD); x++)
        {
            mem[x] = color;
        }
    }
    hr = IDirect3DSurface8_UnlockRect(surface);
    ok(SUCCEEDED(hr), "Failed to unlock surface, hr %#lx.\n", hr);
}

static void fill_texture(IDirect3DTexture8 *texture, DWORD color, DWORD flags)
{
    IDirect3DSurface8 *surface;

    IDirect3DTexture8_GetSurfaceLevel(texture, 0, &surface);
    fill_surface(surface, color, flags);
    IDirect3DSurface8_Release(surface);
}

static void add_dirty_rect_test_draw(IDirect3DDevice8 *device)
{
    HRESULT hr;
    static const struct
    {
        struct vec3 position;
        struct vec2 texcoord;
    }
    quad[] =
    {
        {{-1.0f, -1.0f, 0.0f}, {0.0f, 0.0f}},
        {{-1.0f,  1.0f, 0.0f}, {0.0f, 1.0f}},
        {{ 1.0f, -1.0f, 0.0f}, {1.0f, 0.0f}},
        {{ 1.0f,  1.0f, 0.0f}, {1.0f, 1.0f}},
    };

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, &quad, sizeof(*quad));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);
}

static void add_dirty_rect_test(void)
{
    IDirect3DTexture8 *tex_dst1, *tex_dst2, *tex_src_red, *tex_src_green,
        *tex_managed, *tex_dynamic;
    IDirect3DSurface8 *surface_dst2, *surface_src_green, *surface_src_red,
        *surface_managed0, *surface_managed1, *surface_dynamic;
    struct surface_readback rb;
    D3DLOCKED_RECT locked_rect;
    IDirect3DDevice8 *device;
    unsigned int color, i;
    IDirect3D8 *d3d;
    ULONG refcount;
    DWORD *texel;
    HWND window;
    HRESULT hr;

    static const RECT part_rect = {96, 96, 160, 160};
    static const RECT oob_rect[] =
    {
        {  0,   0, 200, 300},
        {  0,   0, 300, 200},
        {100, 100,  10,  10},
        {200, 300,  10,  10},
        {300, 200, 310, 210},
        {  0,   0,   0,   0},
    };

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    hr = IDirect3DDevice8_CreateTexture(device, 256, 256, 1, 0, D3DFMT_X8R8G8B8,
            D3DPOOL_DEFAULT, &tex_dst1);
    ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateTexture(device, 256, 256, 1, 0, D3DFMT_X8R8G8B8,
            D3DPOOL_DEFAULT, &tex_dst2);
    ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateTexture(device, 256, 256, 1, 0, D3DFMT_X8R8G8B8,
            D3DPOOL_SYSTEMMEM, &tex_src_red);
    ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateTexture(device, 256, 256, 1, 0, D3DFMT_X8R8G8B8,
            D3DPOOL_SYSTEMMEM, &tex_src_green);
    ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateTexture(device, 256, 256, 2, 0, D3DFMT_X8R8G8B8,
            D3DPOOL_MANAGED, &tex_managed);
    ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateTexture(device, 256, 256, 1, D3DUSAGE_DYNAMIC,
            D3DFMT_X8R8G8B8, D3DPOOL_DEFAULT, &tex_dynamic);
    ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx.\n", hr);

    hr = IDirect3DTexture8_GetSurfaceLevel(tex_dst2, 0, &surface_dst2);
    ok(SUCCEEDED(hr), "Failed to get surface level, hr %#lx.\n", hr);
    hr = IDirect3DTexture8_GetSurfaceLevel(tex_src_green, 0, &surface_src_green);
    ok(SUCCEEDED(hr), "Failed to get surface level, hr %#lx.\n", hr);
    hr = IDirect3DTexture8_GetSurfaceLevel(tex_src_red, 0, &surface_src_red);
    ok(SUCCEEDED(hr), "Failed to get surface level, hr %#lx.\n", hr);
    hr = IDirect3DTexture8_GetSurfaceLevel(tex_managed, 0, &surface_managed0);
    ok(SUCCEEDED(hr), "Failed to get surface level, hr %#lx.\n", hr);
    hr = IDirect3DTexture8_GetSurfaceLevel(tex_managed, 1, &surface_managed1);
    ok(SUCCEEDED(hr), "Failed to get surface level, hr %#lx.\n", hr);
    hr = IDirect3DTexture8_GetSurfaceLevel(tex_dynamic, 0, &surface_dynamic);
    ok(SUCCEEDED(hr), "Failed to get surface level, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_TEX1);
    ok(SUCCEEDED(hr), "Failed to set fvf, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_COLOROP, D3DTOP_SELECTARG1);
    ok(SUCCEEDED(hr), "Failed to set color op, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_COLORARG1, D3DTA_TEXTURE);
    ok(SUCCEEDED(hr), "Failed to set color arg, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_MIPFILTER, D3DTEXF_POINT);
    ok(SUCCEEDED(hr), "Failed to set mip filter, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *)tex_dst2);
    ok(hr == D3D_OK, "Unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_UpdateTexture(device, (IDirect3DBaseTexture8 *)tex_src_red,
            (IDirect3DBaseTexture8 *)tex_dst2);
    fill_surface(surface_src_green, 0x00000080, D3DLOCK_NO_DIRTY_UPDATE);
    hr = IDirect3DDevice8_UpdateTexture(device, (IDirect3DBaseTexture8 *)tex_src_green,
            (IDirect3DBaseTexture8 *)tex_dst2);
    ok(hr == D3D_OK, "Unexpected hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x00000080, 1), "Unexpected colour 0x%08x.\n", color);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(hr == D3D_OK, "Unexpected hr %#lx.\n", hr);

    fill_surface(surface_src_red, 0x00ff0000, 0);
    fill_surface(surface_src_green, 0x0000ff00, 0);

    hr = IDirect3DDevice8_UpdateTexture(device, (IDirect3DBaseTexture8 *)tex_src_green,
            (IDirect3DBaseTexture8 *)tex_dst1);
    ok(SUCCEEDED(hr), "Failed to update texture, hr %#lx.\n", hr);

    /* The second UpdateTexture call writing to tex_dst2 is ignored because tex_src_green is not dirty. */
    hr = IDirect3DDevice8_UpdateTexture(device, (IDirect3DBaseTexture8 *)tex_src_red,
            (IDirect3DBaseTexture8 *)tex_dst2);
    ok(SUCCEEDED(hr), "Failed to update texture, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_UpdateTexture(device, (IDirect3DBaseTexture8 *)tex_src_green,
            (IDirect3DBaseTexture8 *)tex_dst2);
    ok(SUCCEEDED(hr), "Failed to update texture, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *)tex_dst1);
    ok(SUCCEEDED(hr), "Failed to set texture, hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x0000ff00, 1),
            "Expected color 0x0000ff00, got 0x%08x.\n", color);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *)tex_dst2);
    ok(SUCCEEDED(hr), "Failed to set texture, hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x00ff0000, 1),
            "Expected color 0x00ff0000, got 0x%08x.\n", color);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    /* AddDirtyRect on the destination is ignored. */
    hr = IDirect3DTexture8_AddDirtyRect(tex_dst2, &part_rect);
    ok(SUCCEEDED(hr), "Failed to add dirty rect, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_UpdateTexture(device, (IDirect3DBaseTexture8 *)tex_src_green,
            (IDirect3DBaseTexture8 *)tex_dst2);
    ok(SUCCEEDED(hr), "Failed to update texture, hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x00ff0000, 1),
            "Expected color 0x00ff0000, got 0x%08x.\n", color);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    hr = IDirect3DTexture8_AddDirtyRect(tex_dst2, NULL);
    ok(SUCCEEDED(hr), "Failed to add dirty rect, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_UpdateTexture(device, (IDirect3DBaseTexture8 *)tex_src_green,
            (IDirect3DBaseTexture8 *)tex_dst2);
    ok(SUCCEEDED(hr), "Failed to update texture, hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x00ff0000, 1),
            "Expected color 0x00ff0000, got 0x%08x.\n", color);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    /* AddDirtyRect on the source makes UpdateTexture work. Partial rectangle
     * tracking is supported. */
    hr = IDirect3DTexture8_AddDirtyRect(tex_src_green, &part_rect);
    ok(SUCCEEDED(hr), "Failed to add dirty rect, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_UpdateTexture(device, (IDirect3DBaseTexture8 *)tex_src_green,
            (IDirect3DBaseTexture8 *)tex_dst2);
    ok(SUCCEEDED(hr), "Failed to update texture, hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x0000ff00, 1),
            "Expected color 0x0000ff00, got 0x%08x.\n", color);
    color = getPixelColor(device, 1, 1);
    ok(color_match(color, 0x00ff0000, 1),
            "Expected color 0x00ff0000, got 0x%08x.\n", color);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    hr = IDirect3DTexture8_AddDirtyRect(tex_src_green, NULL);
    ok(SUCCEEDED(hr), "Failed to add dirty rect, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_UpdateTexture(device, (IDirect3DBaseTexture8 *)tex_src_green,
            (IDirect3DBaseTexture8 *)tex_dst2);
    ok(SUCCEEDED(hr), "Failed to update texture, hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 1, 1);
    ok(color_match(color, 0x0000ff00, 1),
            "Expected color 0x0000ff00, got 0x%08x.\n", color);

    /* UpdateTexture() ignores locks made with D3DLOCK_NO_DIRTY_UPDATE. */
    fill_surface(surface_src_green, 0x00000080, D3DLOCK_NO_DIRTY_UPDATE);
    hr = IDirect3DDevice8_UpdateTexture(device, (IDirect3DBaseTexture8 *)tex_src_green,
            (IDirect3DBaseTexture8 *)tex_dst2);
    ok(SUCCEEDED(hr), "Failed to update texture, hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x0000ff00, 1),
            "Expected color 0x0000ff00, got 0x%08x.\n", color);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    /* Manually copying the surface works, though. */
    hr = IDirect3DDevice8_CopyRects(device, surface_src_green, NULL, 0, surface_dst2, NULL);
    ok(hr == D3D_OK, "Failed to copy rects, hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x00000080, 1), "Got unexpected colour 0x%08x.\n", color);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(hr == D3D_OK, "Failed to present, hr %#lx.\n", hr);

    /* Readonly maps write to D3DPOOL_SYSTEMMEM, but don't record a dirty rectangle. */
    fill_surface(surface_src_green, 0x000000ff, D3DLOCK_READONLY);
    hr = IDirect3DDevice8_UpdateTexture(device, (IDirect3DBaseTexture8 *)tex_src_green,
            (IDirect3DBaseTexture8 *)tex_dst2);
    ok(SUCCEEDED(hr), "Failed to update texture, hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x00000080, 1), "Got unexpected colour 0x%08x.\n", color);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    hr = IDirect3DTexture8_AddDirtyRect(tex_src_green, NULL);
    hr = IDirect3DDevice8_UpdateTexture(device, (IDirect3DBaseTexture8 *)tex_src_green,
            (IDirect3DBaseTexture8 *)tex_dst2);
    ok(SUCCEEDED(hr), "Failed to update texture, hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x000000ff, 1),
            "Expected color 0x000000ff, got 0x%08x.\n", color);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    /* Maps without either of these flags record a dirty rectangle. */
    fill_surface(surface_src_green, 0x00ffffff, 0);
    hr = IDirect3DDevice8_UpdateTexture(device, (IDirect3DBaseTexture8 *)tex_src_green,
            (IDirect3DBaseTexture8 *)tex_dst2);
    ok(SUCCEEDED(hr), "Failed to update texture, hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x00ffffff, 1),
            "Expected color 0x00ffffff, got 0x%08x.\n", color);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    /* Partial LockRect works just like a partial AddDirtyRect call. */
    hr = IDirect3DTexture8_LockRect(tex_src_green, 0, &locked_rect, &part_rect, 0);
    ok(SUCCEEDED(hr), "Failed to lock texture, hr %#lx.\n", hr);
    texel = locked_rect.pBits;
    for (i = 0; i < 64; i++)
        texel[i] = 0x00ff00ff;
    for (i = 1; i < 64; i++)
        memcpy((BYTE *)locked_rect.pBits + i * locked_rect.Pitch, locked_rect.pBits, locked_rect.Pitch);
    hr = IDirect3DTexture8_UnlockRect(tex_src_green, 0);
    ok(SUCCEEDED(hr), "Failed to unlock texture, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_UpdateTexture(device, (IDirect3DBaseTexture8 *)tex_src_green,
            (IDirect3DBaseTexture8 *)tex_dst2);
    ok(SUCCEEDED(hr), "Failed to update texture, hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x00ff00ff, 1),
            "Expected color 0x00ff00ff, got 0x%08x.\n", color);
    color = getPixelColor(device, 1, 1);
    ok(color_match(color, 0x00ffffff, 1),
            "Expected color 0x00ffffff, got 0x%08x.\n", color);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    fill_surface(surface_src_red, 0x00ff0000, 0);
    fill_surface(surface_src_green, 0x0000ff00, 0);

    hr = IDirect3DDevice8_UpdateTexture(device, (IDirect3DBaseTexture8 *)tex_src_green,
            (IDirect3DBaseTexture8 *)tex_dst1);
    ok(SUCCEEDED(hr), "Failed to update texture, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *)tex_dst1);
    ok(SUCCEEDED(hr), "Failed to set texture, hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x0000ff00, 1),
            "Expected color 0x0000ff00, got 0x%08x.\n", color);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    /* CopyRects() ignores the missing dirty marker. */
    hr = IDirect3DDevice8_UpdateTexture(device, (IDirect3DBaseTexture8 *)tex_src_red,
            (IDirect3DBaseTexture8 *)tex_dst2);
    hr = IDirect3DDevice8_CopyRects(device, surface_src_green, NULL, 0, surface_dst2, NULL);
    ok(SUCCEEDED(hr), "Failed to update surface, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *)tex_dst2);
    ok(SUCCEEDED(hr), "Failed to set texture, hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x0000ff00, 1),
            "Expected color 0x0000ff00, got 0x%08x.\n", color);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    fill_surface(surface_src_green, 0x000000ff, D3DLOCK_NO_DIRTY_UPDATE);

    /* So does drawing directly from the sysmem texture. */
    hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *)tex_src_green);
    ok(hr == S_OK, "Failed to set texture, hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    /* Radeon GPUs read zero from sysmem textures. */
    ok(color_match(color, 0x000000ff, 1) || broken(color_match(color, 0x00000000, 1)),
            "Got unexpected color 0x%08x.\n", color);

    /* Blitting to the sysmem texture adds a dirty rect. */
    fill_surface(surface_src_red, 0x00000000, D3DLOCK_NO_DIRTY_UPDATE);
    fill_surface(surface_src_green, 0x00ff00ff, D3DLOCK_NO_DIRTY_UPDATE);
    hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *)tex_dst1);
    ok(hr == S_OK, "Failed to set texture, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CopyRects(device, surface_src_green, NULL, 0, surface_src_red, NULL);
    ok(hr == S_OK, "Failed to update surface, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_UpdateTexture(device, (IDirect3DBaseTexture8 *)tex_src_red,
            (IDirect3DBaseTexture8 *)tex_dst1);
    ok(hr == S_OK, "Failed to update texture, hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x00ff00ff, 1), "Got unexpected color 0x%08x.\n", color);

    /* Tests with managed textures. They are initially dirty.*/
    fill_surface(surface_managed0, 0x00ffff00, D3DLOCK_READONLY);
    fill_surface(surface_managed1, 0x00ff00ff, D3DLOCK_READONLY);
    hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *)tex_managed);
    ok(SUCCEEDED(hr), "Failed to set texture, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_MAXMIPLEVEL, 0);
    ok(SUCCEEDED(hr), "Failed to set texture stage state, hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x00ffff00, 1), "Got unexpected color 0x%08x.\n", color);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_MAXMIPLEVEL, 1);
    ok(SUCCEEDED(hr), "Failed to set texture stage state, hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x00ff00ff, 1), "Got unexpected color 0x%08x.\n", color);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    /* Read-write map, this is uploaded. */
    fill_surface(surface_managed0, 0x00ff0080, 0);
    fill_surface(surface_managed1, 0x00ff8000, 0);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_MAXMIPLEVEL, 0);
    ok(SUCCEEDED(hr), "Failed to set texture stage state, hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x00ff0080, 1), "Got unexpected color 0x%08x.\n", color);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_MAXMIPLEVEL, 1);
    ok(SUCCEEDED(hr), "Failed to set texture stage state, hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x00ff8000, 1), "Got unexpected color 0x%08x.\n", color);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    /* D3DLOCK_READONLY is honored, so this data does not get uploaded. */
    fill_surface(surface_managed0, 0x00008000, D3DLOCK_READONLY);
    fill_surface(surface_managed1, 0x00000080, D3DLOCK_READONLY);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_MAXMIPLEVEL, 0);
    ok(SUCCEEDED(hr), "Failed to set texture stage state, hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x00ff0080, 1), "Got unexpected color 0x%08x.\n", color);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_MAXMIPLEVEL, 1);
    ok(SUCCEEDED(hr), "Failed to set texture stage state, hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x00ff8000, 1), "Got unexpected color 0x%08x.\n", color);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    /* Managed textures also honor D3DLOCK_NO_DIRTY_UPDATE. */
    fill_surface(surface_managed0, 0x0000ff00, D3DLOCK_NO_DIRTY_UPDATE);
    fill_surface(surface_managed1, 0x000000ff, D3DLOCK_NO_DIRTY_UPDATE);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_MAXMIPLEVEL, 0);
    ok(SUCCEEDED(hr), "Failed to set texture stage state, hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x00ff0080, 1), "Got unexpected color 0x%08x.\n", color);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_MAXMIPLEVEL, 1);
    ok(SUCCEEDED(hr), "Failed to set texture stage state, hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x00ff8000, 1), "Got unexpected color 0x%08x.\n", color);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    /* AddDirtyRect uploads the new contents.
     * Partial surface updates work, and two separate dirty rectangles are
     * tracked individually. Tested on Nvidia Kepler, other drivers untested. */
    hr = IDirect3DTexture8_AddDirtyRect(tex_managed, &part_rect);
    ok(hr == S_OK, "Failed to add dirty rect, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_MAXMIPLEVEL, 0);
    ok(SUCCEEDED(hr), "Failed to set texture stage state, hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x0000ff00, 1), "Got unexpected color 0x%08x.\n", color);
    color = getPixelColor(device, 1, 1);
    ok(color_match(color, 0x00ff0080, 1), "Got unexpected color 0x%08x.\n", color);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    hr = IDirect3DTexture8_AddDirtyRect(tex_managed, NULL);
    ok(hr == S_OK, "Failed to add dirty rect, hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x0000ff00, 1), "Got unexpected color 0x%08x.\n", color);
    color = getPixelColor(device, 1, 1);
    ok(color_match(color, 0x0000ff00, 1), "Got unexpected color 0x%08x.\n", color);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_MAXMIPLEVEL, 1);
    ok(SUCCEEDED(hr), "Failed to set texture stage state, hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x000000ff, 1), "Got unexpected color 0x%08x.\n", color);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    /* So does ResourceManagerDiscardBytes. */
    fill_surface(surface_managed0, 0x00ffff00, D3DLOCK_NO_DIRTY_UPDATE);
    fill_surface(surface_managed1, 0x00ff00ff, D3DLOCK_NO_DIRTY_UPDATE);
    hr = IDirect3DDevice8_ResourceManagerDiscardBytes(device, 0);
    ok(SUCCEEDED(hr), "Failed to evict managed resources, hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x00ff00ff, 1), "Got unexpected color 0x%08x.\n", color);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_MAXMIPLEVEL, 0);
    ok(SUCCEEDED(hr), "Failed to set texture stage state, hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x00ffff00, 1), "Got unexpected color 0x%08x.\n", color);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    /* Test blitting from a managed texture. */
    fill_surface(surface_managed0, 0x0000ff00, D3DLOCK_NO_DIRTY_UPDATE);
    hr = IDirect3DDevice8_CopyRects(device, surface_managed0, NULL, 0, surface_dst2, NULL);
    ok(hr == D3D_OK, "Failed to update surface, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *)tex_dst2);
    ok(hr == D3D_OK, "Failed to set texture, hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x0000ff00, 1), "Got unexpected colour 0x%08x.\n", color);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(hr == D3D_OK, "Failed to present, hr %#lx.\n", hr);

    /* Test blitting to a managed texture. */
    fill_surface(surface_managed0, 0x000000ff, 0);
    /* Draw so that both the CPU and GPU copies are blue. */
    hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *)tex_managed);
    ok(SUCCEEDED(hr), "Failed to set texture, hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x000000ff, 0), "Got unexpected colour 0x%08x.\n", color);
    hr = IDirect3DDevice8_CopyRects(device, surface_dst2, NULL, 0, surface_managed0, NULL);
    ok(hr == D3D_OK, "Failed to update surface, hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x0000ff00, 0), "Got unexpected colour 0x%08x.\n", color);
    get_surface_readback(surface_managed0, &rb);
    color = get_readback_color(&rb, 320, 240) & 0x00ffffff;
    ok(color_match(color, 0x0000ff00, 0), "Got unexpected colour 0x%08x.\n", color);
    release_surface_readback(&rb);

    /* Tests with dynamic textures */
    fill_surface(surface_dynamic, 0x0000ffff, 0);
    hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *)tex_dynamic);
    ok(SUCCEEDED(hr), "Failed to set texture, hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x0000ffff, 1),
            "Expected color 0x0000ffff, got 0x%08x.\n", color);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    /* Dynamic textures don't honor D3DLOCK_NO_DIRTY_UPDATE. */
    fill_surface(surface_dynamic, 0x00ffff00, D3DLOCK_NO_DIRTY_UPDATE);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x00ffff00, 1),
            "Expected color 0x00ffff00, got 0x%08x.\n", color);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    /* AddDirtyRect on a locked texture is allowed. */
    hr = IDirect3DTexture8_LockRect(tex_src_red, 0, &locked_rect, NULL, 0);
    ok(SUCCEEDED(hr), "Failed to lock texture, hr %#lx.\n", hr);
    hr = IDirect3DTexture8_AddDirtyRect(tex_src_red, NULL);
    ok(SUCCEEDED(hr), "Failed to add dirty rect, hr %#lx.\n", hr);
    hr = IDirect3DTexture8_UnlockRect(tex_src_red, 0);
    ok(SUCCEEDED(hr), "Failed to unlock texture, hr %#lx.\n", hr);

    /* Redundant AddDirtyRect calls are ok. */
    hr = IDirect3DTexture8_AddDirtyRect(tex_managed, NULL);
    ok(SUCCEEDED(hr), "Failed to add dirty rect, hr %#lx.\n", hr);
    hr = IDirect3DTexture8_AddDirtyRect(tex_managed, NULL);
    ok(SUCCEEDED(hr), "Failed to add dirty rect, hr %#lx.\n", hr);

    /* Test out-of-bounds regions. */
    for (i = 0; i < ARRAY_SIZE(oob_rect); ++i)
    {
        hr = IDirect3DTexture8_AddDirtyRect(tex_src_red, &oob_rect[i]);
        ok(hr == D3DERR_INVALIDCALL, "[%u] Got unexpected hr %#lx.\n", i, hr);
        hr = IDirect3DTexture8_LockRect(tex_src_red, 0, &locked_rect, &oob_rect[i], 0);
        ok(SUCCEEDED(hr), "[%u] Got unexpected hr %#lx.\n", i, hr);
        hr = IDirect3DTexture8_UnlockRect(tex_src_red, 0);
        ok(SUCCEEDED(hr), "[%u] Got unexpected hr %#lx.\n", i, hr);
    }

    IDirect3DSurface8_Release(surface_dst2);
    IDirect3DSurface8_Release(surface_managed1);
    IDirect3DSurface8_Release(surface_managed0);
    IDirect3DSurface8_Release(surface_src_red);
    IDirect3DSurface8_Release(surface_src_green);
    IDirect3DSurface8_Release(surface_dynamic);
    IDirect3DTexture8_Release(tex_src_red);
    IDirect3DTexture8_Release(tex_src_green);
    IDirect3DTexture8_Release(tex_dst1);
    IDirect3DTexture8_Release(tex_dst2);
    IDirect3DTexture8_Release(tex_managed);
    IDirect3DTexture8_Release(tex_dynamic);

    /* As above, test CopyRect() after locking the source with
     * D3DLOCK_NO_DIRTY_UPDATE, but this time do it immediately after creating
     * the destination texture. This is a regression test for a previously
     * broken code path. */

    hr = IDirect3DDevice8_CreateTexture(device, 256, 256, 1, 0, D3DFMT_X8R8G8B8,
            D3DPOOL_DEFAULT, &tex_dst2);
    ok(hr == D3D_OK, "Failed to create texture, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateTexture(device, 256, 256, 1, 0, D3DFMT_X8R8G8B8,
            D3DPOOL_SYSTEMMEM, &tex_src_green);
    ok(hr == D3D_OK, "Failed to create texture, hr %#lx.\n", hr);

    hr = IDirect3DTexture8_GetSurfaceLevel(tex_dst2, 0, &surface_dst2);
    ok(hr == D3D_OK, "Failed to get surface level, hr %#lx.\n", hr);
    hr = IDirect3DTexture8_GetSurfaceLevel(tex_src_green, 0, &surface_src_green);
    ok(hr == D3D_OK, "Failed to get surface level, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *)tex_dst2);
    ok(hr == D3D_OK, "Failed to set texture, hr %#lx.\n", hr);
    fill_surface(surface_src_green, 0x00ff0000, D3DLOCK_NO_DIRTY_UPDATE);
    hr = IDirect3DDevice8_CopyRects(device, surface_src_green, NULL, 0, surface_dst2, NULL);
    ok(hr == D3D_OK, "Failed to copy rects, hr %#lx.\n", hr);
    add_dirty_rect_test_draw(device);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x00ff0000, 1), "Got unexpected colour 0x%08x.\n", color);
    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(hr == D3D_OK, "Failed to present, hr %#lx.\n", hr);

    IDirect3DSurface8_Release(surface_dst2);
    IDirect3DSurface8_Release(surface_src_green);
    IDirect3DTexture8_Release(tex_dst2);
    IDirect3DTexture8_Release(tex_src_green);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_buffer_no_dirty_update(void)
{
    unsigned int refcount, colour;
    IDirect3DVertexBuffer8 *vb;
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d;
    HWND window;
    HRESULT hr;
    BYTE *data;

    static const struct
    {
        struct vec3 position;
        DWORD diffuse;
    }
    green_quad[] =
    {
        {{-1.0f, -1.0f, 0.1f}, 0xff00ff00},
        {{-1.0f,  1.0f, 0.1f}, 0xff00ff00},
        {{ 1.0f, -1.0f, 0.1f}, 0xff00ff00},

        {{ 1.0f, -1.0f, 0.1f}, 0xff00ff00},
        {{-1.0f,  1.0f, 0.1f}, 0xff00ff00},
        {{ 1.0f,  1.0f, 0.1f}, 0xff00ff00},
    },
    red_quad[] =
    {
        {{-1.0f, -1.0f, 0.1f}, 0xffff0000},
        {{-1.0f,  1.0f, 0.1f}, 0xffff0000},
        {{ 1.0f, -1.0f, 0.1f}, 0xffff0000},

        {{ 1.0f, -1.0f, 0.1f}, 0xffff0000},
        {{-1.0f,  1.0f, 0.1f}, 0xffff0000},
        {{ 1.0f,  1.0f, 0.1f}, 0xffff0000},
    };

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device.\n");
        goto done;
    }

    hr = IDirect3DDevice8_CreateVertexBuffer(device, sizeof(green_quad), 0, 0, D3DPOOL_MANAGED, &vb);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DVertexBuffer8_Lock(vb, 0, 0, &data, 0);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    memcpy(data, red_quad, sizeof(red_quad));
    hr = IDirect3DVertexBuffer8_Unlock(vb);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DVertexBuffer8_Lock(vb, 0, 0, &data, D3DLOCK_NO_DIRTY_UPDATE);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    memcpy(data, green_quad, sizeof(green_quad));
    hr = IDirect3DVertexBuffer8_Unlock(vb);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZENABLE, FALSE);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xffffffff, 0.0f, 0);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_DIFFUSE);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetStreamSource(device, 0, vb, sizeof(*green_quad));
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitive(device, D3DPT_TRIANGLELIST, 0, 2);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(hr == D3D_OK, "Got hr %#lx.\n", hr);
    colour = getPixelColor(device, 320, 240);
    ok(color_match(colour, 0x0000ff00, 1), "Got unexpected colour 0x%08x.\n", colour);

    IDirect3DVertexBuffer8_Release(vb);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %u references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_3dc_formats(void)
{
    static const char ati1n_data[] =
    {
        /* A 4x4 texture with the color component at 50%. */
        0x7f, 0x7f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    };
    static const char ati2n_data[] =
    {
        /* A 8x4 texture consisting of 2 4x4 blocks. The first block has 50% first color component,
         * 0% second component. Second block is the opposite. */
        0x7f, 0x7f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x7f, 0x7f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    };
    static const struct
    {
        struct vec3 position;
        struct vec2 texcoord;
    }
    quads[] =
    {
        {{-1.0f, -1.0f, 0.0f}, {0.0f, 0.0f}},
        {{-1.0f,  1.0f, 0.0f}, {0.0f, 1.0f}},
        {{ 0.0f, -1.0f, 1.0f}, {1.0f, 0.0f}},
        {{ 0.0f,  1.0f, 1.0f}, {1.0f, 1.0f}},

        {{ 0.0f, -1.0f, 0.0f}, {0.0f, 0.0f}},
        {{ 0.0f,  1.0f, 0.0f}, {0.0f, 1.0f}},
        {{ 1.0f, -1.0f, 1.0f}, {1.0f, 0.0f}},
        {{ 1.0f,  1.0f, 1.0f}, {1.0f, 1.0f}},
    };
    static const DWORD ati1n_fourcc = MAKEFOURCC('A','T','I','1');
    static const DWORD ati2n_fourcc = MAKEFOURCC('A','T','I','2');
    static const struct
    {
        struct vec2 position;
        D3DCOLOR amd_r500;
        D3DCOLOR amd_r600;
        D3DCOLOR nvidia_old;
        D3DCOLOR nvidia_new;
    }
    expected_colors[] =
    {
        {{ 80, 240}, 0x007fffff, 0x003f3f3f, 0x007f7f7f, 0x007f0000},
        {{240, 240}, 0x007fffff, 0x003f3f3f, 0x007f7f7f, 0x007f0000},
        {{400, 240}, 0x00007fff, 0x00007fff, 0x00007fff, 0x00007fff},
        {{560, 240}, 0x007f00ff, 0x007f00ff, 0x007f00ff, 0x007f00ff},
    };
    IDirect3D8 *d3d;
    IDirect3DDevice8 *device;
    IDirect3DTexture8 *ati1n_texture, *ati2n_texture;
    unsigned int color, i;
    D3DCAPS8 caps;
    D3DLOCKED_RECT rect;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (FAILED(IDirect3D8_CheckDeviceFormat(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            D3DFMT_X8R8G8B8, 0, D3DRTYPE_TEXTURE, ati1n_fourcc)))
    {
        skip("ATI1N textures are not supported, skipping test.\n");
        goto done;
    }
    if (FAILED(IDirect3D8_CheckDeviceFormat(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            D3DFMT_X8R8G8B8, 0, D3DRTYPE_TEXTURE, ati2n_fourcc)))
    {
        skip("ATI2N textures are not supported, skipping test.\n");
        goto done;
    }
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }
    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get device caps, hr %#lx.\n", hr);
    if (!(caps.PrimitiveMiscCaps & D3DPMISCCAPS_TSSARGTEMP))
    {
        skip("D3DTA_TEMP not supported, skipping tests.\n");
        IDirect3DDevice8_Release(device);
        goto done;
    }

    hr = IDirect3DDevice8_CreateTexture(device, 4, 4, 1, 0, ati1n_fourcc,
            D3DPOOL_MANAGED, &ati1n_texture);
    ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx.\n", hr);

    hr = IDirect3DTexture8_LockRect(ati1n_texture, 0, &rect, NULL, 0);
    ok(SUCCEEDED(hr), "Failed to lock texture, hr %#lx.\n", hr);
    memcpy(rect.pBits, ati1n_data, sizeof(ati1n_data));
    hr = IDirect3DTexture8_UnlockRect(ati1n_texture, 0);
    ok(SUCCEEDED(hr), "Failed to unlock texture, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CreateTexture(device, 8, 4, 1, 0, ati2n_fourcc,
            D3DPOOL_MANAGED, &ati2n_texture);
    ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx.\n", hr);

    hr = IDirect3DTexture8_LockRect(ati2n_texture, 0, &rect, NULL, 0);
    ok(SUCCEEDED(hr), "Failed to lock texture, hr %#lx.\n", hr);
    memcpy(rect.pBits, ati2n_data, sizeof(ati2n_data));
    hr = IDirect3DTexture8_UnlockRect(ati2n_texture, 0);
    ok(SUCCEEDED(hr), "Failed to unlock texture, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_TEX1 | D3DFVF_TEXCOORDSIZE2(0));
    ok(SUCCEEDED(hr), "Failed to set FVF, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_COLOROP, D3DTOP_BLENDTEXTUREALPHA);
    ok(SUCCEEDED(hr), "Failed to set color op, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_COLORARG1, D3DTA_TEXTURE);
    ok(SUCCEEDED(hr), "Failed to set color arg, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_COLORARG2, D3DTA_TEMP);
    ok(SUCCEEDED(hr), "Failed to set color arg, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_ALPHAOP, D3DTOP_SELECTARG1);
    ok(SUCCEEDED(hr), "Failed to set alpha op, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_ALPHAARG1, D3DTA_TEXTURE);
    ok(SUCCEEDED(hr), "Failed to set alpha arg, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 1, D3DTSS_COLOROP, D3DTOP_DISABLE);
    ok(SUCCEEDED(hr), "Failed to set color op, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_MAGFILTER, D3DTEXF_POINT);
    ok(SUCCEEDED(hr), "Failed to set mag filter, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0x00ff00ff, 1.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *)ati1n_texture);
    ok(SUCCEEDED(hr), "Failed to set texture, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, &quads[0], sizeof(*quads));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *)ati2n_texture);
    ok(SUCCEEDED(hr), "Failed to set texture, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, &quads[4], sizeof(*quads));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

    for (i = 0; i < 4; ++i)
    {
        color = getPixelColor(device, expected_colors[i].position.x, expected_colors[i].position.y);
        ok (color_match(color, expected_colors[i].amd_r500, 1)
                || color_match(color, expected_colors[i].amd_r600, 1)
                || color_match(color, expected_colors[i].nvidia_old, 1)
                || color_match(color, expected_colors[i].nvidia_new, 1),
                "Got unexpected color 0x%08x, case %u.\n", color, i);
    }

    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);
    IDirect3DTexture8_Release(ati2n_texture);
    IDirect3DTexture8_Release(ati1n_texture);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);

done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_fog_interpolation(void)
{
    HRESULT hr;
    IDirect3DDevice8 *device;
    unsigned int color, i;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;

    static const struct
    {
        struct vec3 position;
        D3DCOLOR diffuse;
        D3DCOLOR specular;
    }
    quad[] =
    {
        {{-1.0f, -1.0f, 0.0f}, 0xffff0000, 0xff000000},
        {{-1.0f,  1.0f, 0.0f}, 0xffff0000, 0xff000000},
        {{ 1.0f, -1.0f, 1.0f}, 0xffff0000, 0x00000000},
        {{ 1.0f,  1.0f, 1.0f}, 0xffff0000, 0x00000000},
    };
    union
    {
        DWORD d;
        float f;
    } conv;
    static const struct
    {
        D3DFOGMODE vfog, tfog;
        D3DSHADEMODE shade;
        D3DCOLOR middle_color;
        BOOL todo;
    }
    tests[] =
    {
        {D3DFOG_NONE, D3DFOG_NONE, D3DSHADE_FLAT,    0x00007f80, FALSE},
        {D3DFOG_NONE, D3DFOG_NONE, D3DSHADE_GOURAUD, 0x00007f80, FALSE},
        {D3DFOG_EXP,  D3DFOG_NONE, D3DSHADE_FLAT,    0x00007f80, TRUE},
        {D3DFOG_EXP,  D3DFOG_NONE, D3DSHADE_GOURAUD, 0x00007f80, TRUE},
        {D3DFOG_NONE, D3DFOG_EXP,  D3DSHADE_FLAT,    0x0000ea15, FALSE},
        {D3DFOG_NONE, D3DFOG_EXP,  D3DSHADE_GOURAUD, 0x0000ea15, FALSE},
        {D3DFOG_EXP,  D3DFOG_EXP,  D3DSHADE_FLAT,    0x0000ea15, FALSE},
        {D3DFOG_EXP,  D3DFOG_EXP,  D3DSHADE_GOURAUD, 0x0000ea15, FALSE},
    };
    static const D3DMATRIX ident_mat =
    {{{
        1.0f, 0.0f,  0.0f, 0.0f,
        0.0f, 1.0f,  0.0f, 0.0f,
        0.0f, 0.0f,  1.0f, 0.0f,
        0.0f, 0.0f,  0.0f, 1.0f
    }}};
    D3DCAPS8 caps;

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");

    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get device caps, hr %#lx.\n", hr);
    if (!(caps.RasterCaps & D3DPRASTERCAPS_FOGTABLE))
        skip("D3DPRASTERCAPS_FOGTABLE not supported, skipping some fog tests\n");

    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_DIFFUSE | D3DFVF_SPECULAR);
    ok(SUCCEEDED(hr), "Failed to set fvf, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZENABLE, FALSE);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGENABLE, TRUE);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGCOLOR, 0x0000ff00);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    conv.f = 5.0;
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGDENSITY, conv.d);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_COLOROP, D3DTOP_SELECTARG1);
    ok(SUCCEEDED(hr), "Failed to set texture stage state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_COLORARG1, D3DTA_TFACTOR);
    ok(SUCCEEDED(hr), "Failed to set texture stage state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_TEXTUREFACTOR, 0x000000ff);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);

    /* Some of the tests seem to depend on the projection matrix explicitly
     * being set to an identity matrix, even though that's the default.
     * (AMD Radeon X1600, AMD Radeon HD 6310, Windows 7). Without this,
     * the drivers seem to use a static z = 1.0 input for the fog equation.
     * The input value is independent of the actual z and w component of
     * the vertex position. */
    hr = IDirect3DDevice8_SetTransform(device, D3DTS_PROJECTION, &ident_mat);
    ok(SUCCEEDED(hr), "Failed to set projection transform, hr %#lx.\n", hr);

    for (i = 0; i < ARRAY_SIZE(tests); i++)
    {
        if(!(caps.RasterCaps & D3DPRASTERCAPS_FOGTABLE) && tests[i].tfog)
            continue;

        hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0x00808080, 0.0f, 0);
        ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_SetRenderState(device, D3DRS_SHADEMODE, tests[i].shade);
        ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGVERTEXMODE, tests[i].vfog);
        ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGTABLEMODE, tests[i].tfog);
        ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_BeginScene(device);
        ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(*quad));
        ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_EndScene(device);
        ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

        color = getPixelColor(device, 0, 240);
        ok(color_match(color, 0x000000ff, 2), "Got unexpected color 0x%08x, case %u.\n", color, i);
        color = getPixelColor(device, 320, 240);
        todo_wine_if (tests[i].todo)
            ok(color_match(color, tests[i].middle_color, 2),
                    "Got unexpected color 0x%08x, case %u.\n", color, i);
        color = getPixelColor(device, 639, 240);
        ok(color_match(color, 0x0000fd02, 2), "Got unexpected color 0x%08x, case %u.\n", color, i);
        hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
        ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);
    }

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_negative_fixedfunction_fog(void)
{
    HRESULT hr;
    IDirect3DDevice8 *device;
    unsigned int color, i;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;

    static const struct
    {
        struct vec3 position;
        D3DCOLOR diffuse;
    }
    quad[] =
    {
        {{-1.0f, -1.0f, -0.5f}, 0xffff0000},
        {{-1.0f,  1.0f, -0.5f}, 0xffff0000},
        {{ 1.0f, -1.0f, -0.5f}, 0xffff0000},
        {{ 1.0f,  1.0f, -0.5f}, 0xffff0000},
    };
    static const struct
    {
        struct vec4 position;
        D3DCOLOR diffuse;
    }
    tquad[] =
    {
        {{  0.0f,   0.0f, -0.5f, 1.0f}, 0xffff0000},
        {{640.0f,   0.0f, -0.5f, 1.0f}, 0xffff0000},
        {{  0.0f, 480.0f, -0.5f, 1.0f}, 0xffff0000},
        {{640.0f, 480.0f, -0.5f, 1.0f}, 0xffff0000},
    };
    static const D3DMATRIX zero =
    {{{
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f
    }}};
    /* Needed to make AMD drivers happy. Yeah, it is not supposed to
     * have an effect on RHW draws. */
    static const D3DMATRIX identity =
    {{{
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f
    }}};
    static const struct
    {
        DWORD pos_type;
        const void *quad;
        size_t stride;
        const D3DMATRIX *matrix;
        union
        {
            float f;
            DWORD d;
        } start, end;
        D3DFOGMODE vfog, tfog;
        DWORD color, color_broken, color_broken2;
    }
    tests[] =
    {
        /* Run the XYZRHW tests first. Depth clamping is broken after RHW draws on the testbot.
         *
         * Geforce8+ GPUs on Windows abs() table fog, everything else does not. */
        {D3DFVF_XYZRHW, tquad,  sizeof(*tquad), &identity, { 0.0f}, {1.0f},
                D3DFOG_NONE,   D3DFOG_LINEAR, 0x00ff0000, 0x00808000, 0x00808000},
        /* r200 GPUs and presumably all d3d8 and older HW clamp the fog
         * parameters to 0.0 and 1.0 in the table fog case. */
        {D3DFVF_XYZRHW, tquad,  sizeof(*tquad), &identity, {-1.0f}, {0.0f},
                D3DFOG_NONE,   D3DFOG_LINEAR, 0x00808000, 0x00ff0000, 0x0000ff00},
        /* test_fog_interpolation shows that vertex fog evaluates the fog
         * equation in the vertex pipeline. Start = -1.0 && end = 0.0 shows
         * that the abs happens before the fog equation is evaluated.
         *
         * Vertex fog abs() behavior is the same on all GPUs. */
        {D3DFVF_XYZ,    quad,   sizeof(*quad),  &zero,     { 0.0f}, {1.0f},
                D3DFOG_LINEAR, D3DFOG_NONE,   0x00808000, 0x00808000, 0x00808000},
        {D3DFVF_XYZ,    quad,   sizeof(*quad),  &zero,     {-1.0f}, {0.0f},
                D3DFOG_LINEAR, D3DFOG_NONE,   0x0000ff00, 0x0000ff00, 0x0000ff00},
        {D3DFVF_XYZ,    quad,   sizeof(*quad),  &zero,     { 0.0f}, {1.0f},
                D3DFOG_EXP,    D3DFOG_NONE,   0x009b6400, 0x009b6400, 0x009b6400},
    };
    D3DCAPS8 caps;

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");

    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get device caps, hr %#lx.\n", hr);
    if (!(caps.RasterCaps & D3DPRASTERCAPS_FOGTABLE))
        skip("D3DPRASTERCAPS_FOGTABLE not supported, skipping some fog tests.\n");

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZENABLE, D3DZB_FALSE);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGENABLE, TRUE);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGCOLOR, 0x0000ff00);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_CLIPPING, FALSE);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);

    for (i = 0; i < ARRAY_SIZE(tests); i++)
    {
        if (!(caps.RasterCaps & D3DPRASTERCAPS_FOGTABLE) && tests[i].tfog)
            continue;

        hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0x000000ff, 0.0f, 0);
        ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_SetTransform(device, D3DTS_PROJECTION, tests[i].matrix);
        ok(SUCCEEDED(hr), "Failed to set projection transform, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetVertexShader(device, tests[i].pos_type | D3DFVF_DIFFUSE);
        ok(SUCCEEDED(hr), "Failed to set fvf, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGSTART, tests[i].start.d);
        ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGEND, tests[i].end.d);
        ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGVERTEXMODE, tests[i].vfog);
        ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGTABLEMODE, tests[i].tfog);
        ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_BeginScene(device);
        ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, tests[i].quad, tests[i].stride);
        ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_EndScene(device);
        ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

        color = getPixelColor(device, 320, 240);
        ok(color_match(color, tests[i].color, 2) || broken(color_match(color, tests[i].color_broken, 2))
                || broken(color_match(color, tests[i].color_broken2, 2)),
                "Got unexpected color 0x%08x, case %u.\n", color, i);
        hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
        ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);
    }

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_table_fog_zw(void)
{
    HRESULT hr;
    IDirect3DDevice8 *device;
    unsigned int color, i;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;
    D3DCAPS8 caps;
    static struct
    {
        struct vec4 position;
        D3DCOLOR diffuse;
    }
    quad[] =
    {
        {{  0.0f,   0.0f, 0.0f, 0.0f}, 0xffff0000},
        {{640.0f,   0.0f, 0.0f, 0.0f}, 0xffff0000},
        {{  0.0f, 480.0f, 0.0f, 0.0f}, 0xffff0000},
        {{640.0f, 480.0f, 0.0f, 0.0f}, 0xffff0000},
    };
    static const D3DMATRIX identity =
    {{{
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f
    }}};
    static const struct
    {
        float z, w;
        D3DZBUFFERTYPE z_test;
        unsigned int color;
    }
    tests[] =
    {
        {0.7f,  0.0f, D3DZB_TRUE,  0x004cb200},
        {0.7f,  0.0f, D3DZB_FALSE, 0x004cb200},
        {0.7f,  0.3f, D3DZB_TRUE,  0x004cb200},
        {0.7f,  0.3f, D3DZB_FALSE, 0x004cb200},
        {0.7f,  3.0f, D3DZB_TRUE,  0x004cb200},
        {0.7f,  3.0f, D3DZB_FALSE, 0x004cb200},
        {0.3f,  0.0f, D3DZB_TRUE,  0x00b24c00},
        {0.3f,  0.0f, D3DZB_FALSE, 0x00b24c00},
    };

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");

    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get device caps, hr %#lx.\n", hr);
    if (!(caps.RasterCaps & D3DPRASTERCAPS_FOGTABLE))
    {
        skip("D3DPRASTERCAPS_FOGTABLE not supported, skipping POSITIONT table fog test.\n");
        goto done;
    }

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGENABLE, TRUE);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGCOLOR, 0x0000ff00);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_CLIPPING, FALSE);
    ok(SUCCEEDED(hr), "SetRenderState failed, hr %#lx.\n", hr);
    /* Work around an AMD Windows driver bug. Needs a proj matrix applied redundantly. */
    hr = IDirect3DDevice8_SetTransform(device, D3DTS_PROJECTION, &identity);
    ok(SUCCEEDED(hr), "Failed to set projection transform, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGTABLEMODE, D3DFOG_LINEAR);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZRHW | D3DFVF_DIFFUSE);
    ok(SUCCEEDED(hr), "Failed to set fvf, hr %#lx.\n", hr);

    for (i = 0; i < ARRAY_SIZE(tests); ++i)
    {
        hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0x000000ff, 1.0f, 0);
        ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);

        quad[0].position.z = tests[i].z;
        quad[1].position.z = tests[i].z;
        quad[2].position.z = tests[i].z;
        quad[3].position.z = tests[i].z;
        quad[0].position.w = tests[i].w;
        quad[1].position.w = tests[i].w;
        quad[2].position.w = tests[i].w;
        quad[3].position.w = tests[i].w;
        hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZENABLE, tests[i].z_test);
        ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_BeginScene(device);
        ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(quad[0]));
        ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_EndScene(device);
        ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

        color = getPixelColor(device, 320, 240);
        ok(color_match(color, tests[i].color, 2),
                "Got unexpected color 0x%08x, expected 0x%08x, case %u.\n", color, tests[i].color, i);
        hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
        ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);
    }

done:
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_signed_formats(void)
{
    unsigned int expected_color, color, i, j, x, y;
    IDirect3DDevice8 *device;
    HWND window;
    HRESULT hr;
    IDirect3DTexture8 *texture, *texture_sysmem;
    D3DLOCKED_RECT locked_rect;
    DWORD shader, shader_alpha;
    IDirect3D8 *d3d;
    D3DCAPS8 caps;
    ULONG refcount;

    /* See comments in the d3d9 version of this test for an
     * explanation of these values. */
    static const USHORT content_v8u8[4][4] =
    {
        {0x0000, 0x7f7f, 0x8880, 0x0000},
        {0x0080, 0x8000, 0x7f00, 0x007f},
        {0x193b, 0xe8c8, 0x0808, 0xf8f8},
        {0x4444, 0xc0c0, 0xa066, 0x22e0},
    };
    static const DWORD content_v16u16[4][4] =
    {
        {0x00000000, 0x7fff7fff, 0x88008000, 0x00000000},
        {0x00008000, 0x80000000, 0x7fff0000, 0x00007fff},
        {0x19993bbb, 0xe800c800, 0x08880888, 0xf800f800},
        {0x44444444, 0xc000c000, 0xa0006666, 0x2222e000},
    };
    static const DWORD content_q8w8v8u8[4][4] =
    {
        {0x00000000, 0xff7f7f7f, 0x7f008880, 0x817f0000},
        {0x10000080, 0x20008000, 0x30007f00, 0x4000007f},
        {0x5020193b, 0x6028e8c8, 0x70020808, 0x807ff8f8},
        {0x90414444, 0xa000c0c0, 0x8261a066, 0x834922e0},
    };
    static const DWORD content_x8l8v8u8[4][4] =
    {
        {0x00000000, 0x00ff7f7f, 0x00008880, 0x00ff0000},
        {0x00000080, 0x00008000, 0x00007f00, 0x0000007f},
        {0x0041193b, 0x0051e8c8, 0x00040808, 0x00fff8f8},
        {0x00824444, 0x0000c0c0, 0x00c2a066, 0x009222e0},
    };
    static const USHORT content_l6v5u5[4][4] =
    {
        {0x0000, 0xfdef, 0x0230, 0xfc00},
        {0x0010, 0x0200, 0x01e0, 0x000f},
        {0x4067, 0x53b9, 0x0421, 0xffff},
        {0x8108, 0x0318, 0xc28c, 0x909c},
    };
    static const struct
    {
        D3DFORMAT format;
        const char *name;
        const void *content;
        SIZE_T pixel_size;
        BOOL blue, alpha;
        unsigned int slop, slop_broken, alpha_broken;
    }
    formats[] =
    {
        {D3DFMT_V8U8,     "D3DFMT_V8U8",     content_v8u8,     sizeof(WORD),  FALSE, FALSE, 1, 0, FALSE},
        {D3DFMT_V16U16,   "D3DFMT_V16U16",   content_v16u16,   sizeof(DWORD), FALSE, FALSE, 1, 0, FALSE},
        {D3DFMT_Q8W8V8U8, "D3DFMT_Q8W8V8U8", content_q8w8v8u8, sizeof(DWORD), TRUE,  TRUE,  1, 0, TRUE },
        {D3DFMT_X8L8V8U8, "D3DFMT_X8L8V8U8", content_x8l8v8u8, sizeof(DWORD), TRUE,  FALSE, 1, 0, FALSE},
        {D3DFMT_L6V5U5,   "D3DFMT_L6V5U5",   content_l6v5u5,   sizeof(WORD),  TRUE,  FALSE, 4, 7, FALSE},
    };
    static const struct
    {
        D3DPOOL pool;
        UINT width;
    }
    tests[] =
    {
        {D3DPOOL_SYSTEMMEM, 4},
        {D3DPOOL_SYSTEMMEM, 1},
        {D3DPOOL_MANAGED,   4},
        {D3DPOOL_MANAGED,   1},
    };
    static const DWORD shader_code[] =
    {
        0xffff0101,                                                             /* ps_1_1                     */
        0x00000051, 0xa00f0000, 0x3f000000, 0x3f000000, 0x3f000000, 0x3f000000, /* def c0, 0.5, 0.5, 0,5, 0,5 */
        0x00000042, 0xb00f0000,                                                 /* tex t0                     */
        0x00000004, 0x800f0000, 0xb0e40000, 0xa0e40000, 0xa0e40000,             /* mad r0, t0, c0, c0         */
        0x0000ffff                                                              /* end                        */
    };
    static const DWORD shader_code_alpha[] =
    {
        /* The idea of this shader is to replicate the alpha value in .rg, and set
         * blue to 1.0 iff the alpha value is < -1.0 and 0.0 otherwise. */
        0xffff0101,                                                             /* ps_1_1                     */
        0x00000051, 0xa00f0000, 0x3f000000, 0x3f000000, 0x3f000000, 0x3f000000, /* def c0, 0.5, 0.5, 0.5, 0.5 */
        0x00000051, 0xa00f0001, 0x3f800000, 0x3f800000, 0x00000000, 0x3f800000, /* def c1, 1.0, 1.0, 0.0, 1.0 */
        0x00000051, 0xa00f0002, 0x00000000, 0x00000000, 0x3f800000, 0x00000000, /* def c2, 0.0, 0.0, 1.0, 0.0 */
        0x00000042, 0xb00f0000,                                                 /* tex t0                     */
        0x00000004, 0x80070000, 0xb0ff0000, 0xa0e40000, 0xa0e40000,             /* mad r0.rgb, t0.a, c0, c0   */
        0x00000003, 0x80080000, 0xb1ff0000, 0xa0e40000,                         /* sub r0.a, -t0.a, c0        */
        0x00000050, 0x80080000, 0x80ff0000, 0xa0ff0001, 0xa0ff0002,             /* cnd r0.a, r0.a, c1.a, c2.a */
        0x00000005, 0x80070001, 0xa0e40001, 0x80e40000,                         /* mul r1.rgb, c1, r0         */
        0x00000004, 0x80070000, 0x80ff0000, 0xa0e40002, 0x80e40001,             /* mad r0.rgb, r0.a, c2, r1   */
        0x0000ffff                                                              /* end                        */
    };
    static const struct
    {
        struct vec3 position;
        struct vec2 texcrd;
    }
    quad[] =
    {
        /* Flip the y coordinate to make the input and
         * output arrays easier to compare. */
        {{ -1.0f,  -1.0f,  0.0f}, { 0.0f, 1.0f}},
        {{ -1.0f,   1.0f,  0.0f}, { 0.0f, 0.0f}},
        {{  1.0f,  -1.0f,  0.0f}, { 1.0f, 1.0f}},
        {{  1.0f,   1.0f,  0.0f}, { 1.0f, 0.0f}},
    };
    static const D3DCOLOR expected_alpha[4][4] =
    {
        {0x00808000, 0x007f7f00, 0x00ffff00, 0x00000000},
        {0x00909000, 0x00a0a000, 0x00b0b000, 0x00c0c000},
        {0x00d0d000, 0x00e0e000, 0x00f0f000, 0x00000000},
        {0x00101000, 0x00202000, 0x00010100, 0x00020200},
    };
    static const BOOL alpha_broken[4][4] =
    {
        {FALSE, FALSE, FALSE, FALSE},
        {FALSE, FALSE, FALSE, FALSE},
        {FALSE, FALSE, FALSE, TRUE },
        {FALSE, FALSE, FALSE, FALSE},
    };
    static const D3DCOLOR expected_colors[4][4] =
    {
        {0x00808080, 0x00fefeff, 0x00010780, 0x008080ff},
        {0x00018080, 0x00800180, 0x0080fe80, 0x00fe8080},
        {0x00ba98a0, 0x004767a8, 0x00888881, 0x007878ff},
        {0x00c3c3c0, 0x003f3f80, 0x00e51fe1, 0x005fa2c8},
    };

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");

    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get device caps, hr %#lx.\n", hr);

    if (caps.PixelShaderVersion < D3DPS_VERSION(1, 1))
    {
        skip("Pixel shaders not supported, skipping converted format test.\n");
        goto done;
    }

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZENABLE, D3DZB_FALSE);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_TEX1);
    ok(SUCCEEDED(hr), "Failed to set FVF, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreatePixelShader(device, shader_code, &shader);
    ok(SUCCEEDED(hr), "Failed to create pixel shader, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreatePixelShader(device, shader_code_alpha, &shader_alpha);
    ok(SUCCEEDED(hr), "Failed to create pixel shader, hr %#lx.\n", hr);

    for (i = 0; i < ARRAY_SIZE(formats); i++)
    {
        hr = IDirect3D8_CheckDeviceFormat(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
                D3DFMT_X8R8G8B8, 0, D3DRTYPE_TEXTURE, formats[i].format);
        if (FAILED(hr))
        {
            skip("Format %s not supported, skipping.\n", formats[i].name);
            continue;
        }

        for (j = 0; j < ARRAY_SIZE(tests); j++)
        {
            texture_sysmem = NULL;
            hr = IDirect3DDevice8_CreateTexture(device, tests[j].width, 4, 1, 0,
                    formats[i].format, tests[j].pool, &texture);
            ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx.\n", hr);

            hr = IDirect3DTexture8_LockRect(texture, 0, &locked_rect, NULL, 0);
            ok(SUCCEEDED(hr), "Failed to lock texture, hr %#lx.\n", hr);
            for (y = 0; y < 4; y++)
            {
                memcpy((char *)locked_rect.pBits + y * locked_rect.Pitch,
                        (char *)formats[i].content + y * 4 * formats[i].pixel_size,
                        tests[j].width * formats[i].pixel_size);
            }
            hr = IDirect3DTexture8_UnlockRect(texture, 0);
            ok(SUCCEEDED(hr), "Failed to unlock texture, hr %#lx.\n", hr);

            if (tests[j].pool == D3DPOOL_SYSTEMMEM)
            {
                texture_sysmem = texture;
                hr = IDirect3DDevice8_CreateTexture(device, tests[j].width, 4, 1, 0,
                        formats[i].format, D3DPOOL_DEFAULT, &texture);
                ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx.\n", hr);

                hr = IDirect3DDevice8_UpdateTexture(device, (IDirect3DBaseTexture8 *)texture_sysmem,
                        (IDirect3DBaseTexture8 *)texture);
                ok(SUCCEEDED(hr), "Failed to update texture, hr %#lx.\n", hr);
                IDirect3DTexture8_Release(texture_sysmem);
            }

            hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *)texture);
            ok(SUCCEEDED(hr), "Failed to set texture, hr %#lx.\n", hr);
            hr = IDirect3DDevice8_SetPixelShader(device, shader_alpha);
            ok(SUCCEEDED(hr), "Failed to set pixel shader, hr %#lx.\n", hr);

            hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0x00330033, 0.0f, 0);
            ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);
            hr = IDirect3DDevice8_BeginScene(device);
            ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
            hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, &quad[0], sizeof(*quad));
            ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
            hr = IDirect3DDevice8_EndScene(device);
            ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

            for (y = 0; y < 4; y++)
            {
                for (x = 0; x < tests[j].width; x++)
                {
                    BOOL r200_broken = formats[i].alpha_broken && alpha_broken[y][x];
                    if (formats[i].alpha)
                        expected_color = expected_alpha[y][x];
                    else
                        expected_color = 0x00ffff00;

                    color = getPixelColor(device, 80 + 160 * x, 60 + 120 * y);
                    ok(color_match(color, expected_color, 1) || broken(r200_broken),
                            "Expected color 0x%08x, got 0x%08x, format %s, test %u, location %ux%u.\n",
                            expected_color, color, formats[i].name, j, x, y);
                }
            }
            hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
            ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

            hr = IDirect3DDevice8_SetPixelShader(device, shader);
            ok(SUCCEEDED(hr), "Failed to set pixel shader, hr %#lx.\n", hr);

            hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0x00330033, 0.0f, 0);
            ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);
            hr = IDirect3DDevice8_BeginScene(device);
            ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
            hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, &quad[0], sizeof(*quad));
            ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
            hr = IDirect3DDevice8_EndScene(device);
            ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

            for (y = 0; y < 4; y++)
            {
                for (x = 0; x < tests[j].width; x++)
                {
                    expected_color = expected_colors[y][x];
                    if (!formats[i].blue)
                        expected_color |= 0x000000ff;

                    color = getPixelColor(device, 80 + 160 * x, 60 + 120 * y);
                    ok(color_match(color, expected_color, formats[i].slop)
                            || broken(color_match(color, expected_color, formats[i].slop_broken)),
                            "Expected color 0x%08x, got 0x%08x, format %s, test %u, location %ux%u.\n",
                            expected_color, color, formats[i].name, j, x, y);
                }
            }
            hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
            ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

            IDirect3DTexture8_Release(texture);
        }
    }

    IDirect3DDevice8_DeletePixelShader(device, shader);
    IDirect3DDevice8_DeletePixelShader(device, shader_alpha);

done:
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_updatetexture(void)
{
    unsigned int color, t, i, f, l, x, y, z;
    D3DADAPTER_IDENTIFIER8 identifier;
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d;
    HWND window;
    HRESULT hr;
    IDirect3DBaseTexture8 *src, *dst;
    D3DLOCKED_RECT locked_rect;
    D3DLOCKED_BOX locked_box;
    ULONG refcount;
    D3DCAPS8 caps;
    BOOL ati2n_supported, do_visual_test;
    static const struct
    {
        struct vec3 pos;
        struct vec2 texcoord;
    }
    quad[] =
    {
        {{-1.0f, -1.0f, 0.0f}, {0.0f, 1.0f}},
        {{-1.0f,  1.0f, 0.0f}, {0.0f, 0.0f}},
        {{ 1.0f, -1.0f, 0.0f}, {1.0f, 1.0f}},
        {{ 1.0f,  1.0f, 0.0f}, {1.0f, 0.0f}},
    };
    static const struct
    {
        struct vec3 pos;
        struct vec3 texcoord;
    }
    quad_cube_tex[] =
    {
        {{-1.0f, -1.0f, 0.0f}, {1.0f, -0.5f,  0.5f}},
        {{-1.0f,  1.0f, 0.0f}, {1.0f,  0.5f,  0.5f}},
        {{ 1.0f, -1.0f, 0.0f}, {1.0f, -0.5f, -0.5f}},
        {{ 1.0f,  1.0f, 0.0f}, {1.0f,  0.5f, -0.5f}},
    };
    static const struct
    {
        UINT src_width, src_height;
        UINT dst_width, dst_height;
        UINT src_levels, dst_levels;
        D3DFORMAT src_format, dst_format;
        BOOL broken_result, broken_updatetex;
    }
    tests[] =
    {
        {8, 8, 8, 8, 0, 0, D3DFMT_A8R8G8B8, D3DFMT_A8R8G8B8, FALSE}, /* 0 */
        {8, 8, 8, 8, 4, 4, D3DFMT_A8R8G8B8, D3DFMT_A8R8G8B8, FALSE}, /* 1 */
        {8, 8, 8, 8, 2, 2, D3DFMT_A8R8G8B8, D3DFMT_A8R8G8B8, FALSE}, /* 2 */
        {8, 8, 8, 8, 1, 1, D3DFMT_A8R8G8B8, D3DFMT_A8R8G8B8, FALSE}, /* 3 */
        {8, 8, 8, 8, 4, 0, D3DFMT_A8R8G8B8, D3DFMT_A8R8G8B8, FALSE}, /* 4 */
        {8, 8, 2, 2, 4, 2, D3DFMT_A8R8G8B8, D3DFMT_A8R8G8B8, FALSE}, /* 5 */
        /* The WARP renderer doesn't handle these cases correctly. */
        {8, 8, 8, 8, 4, 2, D3DFMT_A8R8G8B8, D3DFMT_A8R8G8B8, TRUE}, /* 6 */
        {8, 8, 4, 4, 4, 2, D3DFMT_A8R8G8B8, D3DFMT_A8R8G8B8, TRUE}, /* 7 */
        /* Not clear what happens here on Windows, it doesn't make much sense
         * though (on Nvidia it seems to upload the 4x4 surface into the 7x7
         * one or something like that). */
        /* {8, 8, 7, 7, 4, 2, D3DFMT_A8R8G8B8, D3DFMT_A8R8G8B8, FALSE}, */
        {8, 8, 8, 8, 1, 4, D3DFMT_A8R8G8B8, D3DFMT_A8R8G8B8, FALSE}, /* 8 */
        /* For this one UpdateTexture() returns failure on WARP on > Win 10 1709. */
        {4, 4, 8, 8, 1, 1, D3DFMT_A8R8G8B8, D3DFMT_A8R8G8B8, FALSE, TRUE}, /* 9 */
        /* This one causes weird behavior on Windows (it probably writes out
         * of the texture memory). */
        /* {8, 8, 4, 4, 1, 1, D3DFMT_A8R8G8B8, D3DFMT_A8R8G8B8, FALSE}, */
        {8, 4, 4, 2, 4, 2, D3DFMT_A8R8G8B8, D3DFMT_A8R8G8B8, FALSE}, /* 10 */
        {8, 4, 2, 4, 4, 2, D3DFMT_A8R8G8B8, D3DFMT_A8R8G8B8, FALSE}, /* 11 */
        {8, 8, 8, 8, 4, 4, D3DFMT_A8R8G8B8, D3DFMT_X8R8G8B8, FALSE}, /* 12 */
        {8, 8, 8, 8, 4, 4, D3DFMT_X8R8G8B8, D3DFMT_A8R8G8B8, FALSE}, /* 13 */
        /* The data is converted correctly on AMD, on Nvidia nothing happens
         * (it draws a black quad). */
        {8, 8, 8, 8, 4, 4, D3DFMT_A8R8G8B8, D3DFMT_R5G6B5, TRUE}, /* 14 */
        /* This one doesn't seem to give the expected results on AMD. */
        /* {8, 8, 8, 8, 4, 4, D3DFMT_A8R8G8B8, D3DFMT_Q8W8V8U8, FALSE}, */
        {8, 8, 8, 8, 4, 4, MAKEFOURCC('A','T','I','2'), MAKEFOURCC('A','T','I','2'), FALSE}, /* 15 */
        {8, 8, 8, 8, 4, 2, MAKEFOURCC('A','T','I','2'), MAKEFOURCC('A','T','I','2'), FALSE}, /* 16 */
        {8, 8, 2, 2, 4, 2, MAKEFOURCC('A','T','I','2'), MAKEFOURCC('A','T','I','2'), FALSE}, /* 17 */
    };
    static const struct
    {
        D3DRESOURCETYPE type;
        DWORD fvf;
        const void *quad;
        unsigned int vertex_size;
        DWORD cap;
        const char *name;
    }
    texture_types[] =
    {
        {D3DRTYPE_TEXTURE, D3DFVF_XYZ | D3DFVF_TEX1,
         quad, sizeof(*quad), D3DPTEXTURECAPS_MIPMAP, "2D mipmapped"},

        {D3DRTYPE_CUBETEXTURE, D3DFVF_XYZ | D3DFVF_TEX1 | D3DFVF_TEXCOORDSIZE3(0),
         quad_cube_tex, sizeof(*quad_cube_tex), D3DPTEXTURECAPS_CUBEMAP, "Cube"},

        {D3DRTYPE_VOLUMETEXTURE, D3DFVF_XYZ | D3DFVF_TEX1,
         quad, sizeof(*quad), D3DPTEXTURECAPS_VOLUMEMAP, "Volume"}
    };

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3D8_GetAdapterIdentifier(d3d, D3DADAPTER_DEFAULT, 0, &identifier);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get caps, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_MAGFILTER, D3DTEXF_LINEAR);
    ok(SUCCEEDED(hr), "Failed to set texture filtering state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_ADDRESSU, D3DTADDRESS_CLAMP);
    ok(SUCCEEDED(hr), "Failed to set texture filtering state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_ADDRESSV, D3DTADDRESS_CLAMP);
    ok(SUCCEEDED(hr), "Failed to set texture filtering state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_ADDRESSW, D3DTADDRESS_CLAMP);
    ok(SUCCEEDED(hr), "Failed to set texture filtering state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_COLOROP, D3DTOP_SELECTARG1);
    ok(hr == D3D_OK, "Failed to set texture stage state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_COLORARG1, D3DTA_TEXTURE);
    ok(hr == D3D_OK, "Failed to set texture stage state, hr %#lx.\n", hr);

    for (t = 0; t < ARRAY_SIZE(texture_types); ++t)
    {
        if (!(caps.TextureCaps & texture_types[t].cap))
        {
            skip("%s textures not supported, skipping some tests.\n", texture_types[t].name);
            continue;
        }

        if (FAILED(IDirect3D8_CheckDeviceFormat(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
                D3DFMT_X8R8G8B8, 0, texture_types[t].type, MAKEFOURCC('A','T','I','2'))))
        {
            skip("%s ATI2N textures are not supported, skipping some tests.\n", texture_types[t].name);
            ati2n_supported = FALSE;
        }
        else
        {
            ati2n_supported = TRUE;
        }

        hr = IDirect3DDevice8_SetVertexShader(device, texture_types[t].fvf);
        ok(SUCCEEDED(hr), "Failed to set FVF, hr %#lx.\n", hr);

        for (i = 0; i < ARRAY_SIZE(tests); ++i)
        {
            if (tests[i].src_format == MAKEFOURCC('A','T','I','2') && !ati2n_supported)
                continue;

            switch (texture_types[t].type)
            {
                case D3DRTYPE_TEXTURE:
                    hr = IDirect3DDevice8_CreateTexture(device,
                            tests[i].src_width, tests[i].src_height,
                            tests[i].src_levels, 0, tests[i].src_format, D3DPOOL_SYSTEMMEM,
                            (IDirect3DTexture8 **)&src);
                    ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx, case %u, %u.\n", hr, t, i);
                    hr = IDirect3DDevice8_CreateTexture(device,
                            tests[i].dst_width, tests[i].dst_height,
                            tests[i].dst_levels, 0, tests[i].dst_format, D3DPOOL_DEFAULT,
                            (IDirect3DTexture8 **)&dst);
                    ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx, case %u, %u.\n", hr, t, i);
                    break;
                case D3DRTYPE_CUBETEXTURE:
                    hr = IDirect3DDevice8_CreateCubeTexture(device,
                            tests[i].src_width,
                            tests[i].src_levels, 0, tests[i].src_format, D3DPOOL_SYSTEMMEM,
                            (IDirect3DCubeTexture8 **)&src);
                    ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx, case %u, %u.\n", hr, t, i);
                    hr = IDirect3DDevice8_CreateCubeTexture(device,
                            tests[i].dst_width,
                            tests[i].dst_levels, 0, tests[i].dst_format, D3DPOOL_DEFAULT,
                            (IDirect3DCubeTexture8 **)&dst);
                    ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx, case %u, %u.\n", hr, t, i);
                    break;
                case D3DRTYPE_VOLUMETEXTURE:
                    hr = IDirect3DDevice8_CreateVolumeTexture(device,
                            tests[i].src_width, tests[i].src_height, tests[i].src_width,
                            tests[i].src_levels, 0, tests[i].src_format, D3DPOOL_SYSTEMMEM,
                            (IDirect3DVolumeTexture8 **)&src);
                    ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx, case %u, %u.\n", hr, t, i);
                    hr = IDirect3DDevice8_CreateVolumeTexture(device,
                            tests[i].dst_width, tests[i].dst_height, tests[i].dst_width,
                            tests[i].dst_levels, 0, tests[i].dst_format, D3DPOOL_DEFAULT,
                            (IDirect3DVolumeTexture8 **)&dst);
                    ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx, case %u, %u.\n", hr, t, i);
                    break;
                default:
                    trace("Unexpected resource type.\n");
            }

            /* Skip the visual part of the test for ATI2N (laziness) and cases that
             * give a different (and unlikely to be useful) result. */
            do_visual_test = (tests[i].src_format == D3DFMT_A8R8G8B8 || tests[i].src_format == D3DFMT_X8R8G8B8)
                    && tests[i].src_levels != 0
                    && tests[i].src_width >= tests[i].dst_width && tests[i].src_height >= tests[i].dst_height
                    && !(tests[i].src_width > tests[i].src_height && tests[i].dst_width < tests[i].dst_height);

            if (do_visual_test)
            {
                DWORD *ptr = NULL;
                unsigned int width, height, depth, row_pitch = 0, slice_pitch = 0;

                for (f = 0; f < (texture_types[t].type == D3DRTYPE_CUBETEXTURE ? 6 : 1); ++f)
                {
                    width = tests[i].src_width;
                    height = texture_types[t].type != D3DRTYPE_CUBETEXTURE ? tests[i].src_height : tests[i].src_width;
                    depth = texture_types[t].type == D3DRTYPE_VOLUMETEXTURE ? width : 1;

                    for (l = 0; l < tests[i].src_levels; ++l)
                    {
                        switch (texture_types[t].type)
                        {
                            case D3DRTYPE_TEXTURE:
                                hr = IDirect3DTexture8_LockRect((IDirect3DTexture8 *)src,
                                        l, &locked_rect, NULL, 0);
                                ptr = locked_rect.pBits;
                                row_pitch = locked_rect.Pitch / sizeof(*ptr);
                                break;
                            case D3DRTYPE_CUBETEXTURE:
                                hr = IDirect3DCubeTexture8_LockRect((IDirect3DCubeTexture8 *)src,
                                        f, l, &locked_rect, NULL, 0);
                                ptr = locked_rect.pBits;
                                row_pitch = locked_rect.Pitch / sizeof(*ptr);
                                break;
                            case D3DRTYPE_VOLUMETEXTURE:
                                hr = IDirect3DVolumeTexture8_LockBox((IDirect3DVolumeTexture8 *)src,
                                        l, &locked_box, NULL, 0);
                                ptr = locked_box.pBits;
                                row_pitch = locked_box.RowPitch / sizeof(*ptr);
                                slice_pitch = locked_box.SlicePitch / sizeof(*ptr);
                                break;
                            default:
                                trace("Unexpected resource type.\n");
                        }
                        ok(SUCCEEDED(hr), "Failed to lock texture, hr %#lx.\n", hr);

                        for (z = 0; z < depth; ++z)
                        {
                            for (y = 0; y < height; ++y)
                            {
                                for (x = 0; x < width; ++x)
                                {
                                    ptr[z * slice_pitch + y * row_pitch + x] = 0xff000000
                                            | (DWORD)(x / (width - 1.0f) * 255.0f) << 16
                                            | (DWORD)(y / (height - 1.0f) * 255.0f) << 8;
                                }
                            }
                        }

                        switch (texture_types[t].type)
                        {
                            case D3DRTYPE_TEXTURE:
                                hr = IDirect3DTexture8_UnlockRect((IDirect3DTexture8 *)src, l);
                                break;
                            case D3DRTYPE_CUBETEXTURE:
                                hr = IDirect3DCubeTexture8_UnlockRect((IDirect3DCubeTexture8 *)src, f, l);
                                break;
                            case D3DRTYPE_VOLUMETEXTURE:
                                hr = IDirect3DVolumeTexture8_UnlockBox((IDirect3DVolumeTexture8 *)src, l);
                                break;
                            default:
                                trace("Unexpected resource type.\n");
                        }
                        ok(SUCCEEDED(hr), "Failed to unlock texture, hr %#lx.\n", hr);

                        width >>= 1;
                        if (!width)
                            width = 1;
                        height >>= 1;
                        if (!height)
                            height = 1;
                        depth >>= 1;
                        if (!depth)
                            depth = 1;
                    }
                }
            }

            hr = IDirect3DDevice8_UpdateTexture(device, src, dst);
            if (FAILED(hr))
            {
                todo_wine ok(SUCCEEDED(hr) || broken(tests[i].broken_updatetex),
                        "Failed to update texture, hr %#lx, case %u, %u.\n", hr, t, i);
                IDirect3DBaseTexture8_Release(src);
                IDirect3DBaseTexture8_Release(dst);
                continue;
            }
            ok(SUCCEEDED(hr), "Failed to update texture, hr %#lx, case %u, %u.\n", hr, t, i);

            if (do_visual_test)
            {
                IDirect3DTexture8 *rb_texture;
                struct surface_readback rb;
                IDirect3DSurface8 *rt;
                D3DSURFACE_DESC desc;

                hr = IDirect3DDevice8_SetTexture(device, 0, dst);
                ok(SUCCEEDED(hr), "Failed to set texture, hr %#lx.\n", hr);

                hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xff0000ff, 1.0f, 0);
                ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);

                hr = IDirect3DDevice8_BeginScene(device);
                ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
                hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2,
                        texture_types[t].quad, texture_types[t].vertex_size);
                ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
                hr = IDirect3DDevice8_EndScene(device);
                ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

                /* Read back manually. WARP often completely breaks down with
                 * these draws and fails to copy to the staging texture. */

                hr = IDirect3DDevice8_GetRenderTarget(device, &rt);
                ok(hr == S_OK, "Got hr %#lx.\n", hr);

                hr = IDirect3DSurface8_GetDesc(rt, &desc);
                ok(hr == S_OK, "Got hr %#lx.\n", hr);
                hr = IDirect3DDevice8_CreateTexture(device, desc.Width, desc.Height,
                        1, 0, desc.Format, D3DPOOL_SYSTEMMEM, &rb_texture);
                ok(hr == S_OK, "Got hr %#lx.\n", hr);
                hr = IDirect3DTexture8_GetSurfaceLevel(rb_texture, 0, &rb.surface);
                ok(hr == S_OK, "Got hr %#lx.\n", hr);

                hr = IDirect3DDevice8_CopyRects(device, rt, NULL, 0, rb.surface, NULL);
                ok(hr == S_OK || broken(adapter_is_warp(&identifier)), "Got hr %#lx.\n", hr);
                if (SUCCEEDED(hr))
                {
                    hr = IDirect3DSurface8_LockRect(rb.surface, &rb.locked_rect, NULL, D3DLOCK_READONLY);
                    ok(hr == S_OK, "Got hr %#lx.\n", hr);

                    color = get_readback_color(&rb, 320, 240) & 0x00ffffff;
                    ok(color_match(color, 0x007f7f00, 3) || broken(tests[i].broken_result),
                            "Got unexpected color 0x%08x, case %u, %u.\n", color, t, i);

                    hr = IDirect3DSurface8_UnlockRect(rb.surface);
                    ok(hr == S_OK, "Got hr %#lx.\n", hr);
                }

                IDirect3DSurface8_Release(rb.surface);
                IDirect3DTexture8_Release(rb_texture);
                IDirect3DSurface8_Release(rt);
            }

            IDirect3DBaseTexture8_Release(src);
            IDirect3DBaseTexture8_Release(dst);
        }
    }

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static BOOL point_match(IDirect3DDevice8 *device, UINT x, UINT y, UINT r)
{
    D3DCOLOR color;

    color = D3DCOLOR_ARGB(0x00, 0xff, 0xff, 0xff);
    if (!color_match(getPixelColor(device, x + r, y), color, 1))
        return FALSE;
    if (!color_match(getPixelColor(device, x - r, y), color, 1))
        return FALSE;
    if (!color_match(getPixelColor(device, x, y + r), color, 1))
        return FALSE;
    if (!color_match(getPixelColor(device, x, y - r), color, 1))
        return FALSE;

    ++r;
    color = D3DCOLOR_ARGB(0x00, 0x00, 0x00, 0xff);
    if (!color_match(getPixelColor(device, x + r, y), color, 1))
        return FALSE;
    if (!color_match(getPixelColor(device, x - r, y), color, 1))
        return FALSE;
    if (!color_match(getPixelColor(device, x, y + r), color, 1))
        return FALSE;
    if (!color_match(getPixelColor(device, x, y - r), color, 1))
        return FALSE;

    return TRUE;
}

static void test_pointsize(void)
{
    static const float a = 0.5f, b = 0.5f, c = 0.5f;
    float ptsize, ptsizemax_orig, ptsizemin_orig;
    IDirect3DSurface8 *rt, *backbuffer, *depthstencil;
    IDirect3DTexture8 *tex1, *tex2;
    IDirect3DDevice8 *device;
    unsigned int color, i, j;
    DWORD vs, ps;
    D3DLOCKED_RECT lr;
    IDirect3D8 *d3d;
    ULONG refcount;
    D3DCAPS8 caps;
    HWND window;
    HRESULT hr;

    static const DWORD tex1_data[4] = {0x00ff0000, 0x00ff0000, 0x00000000, 0x00000000};
    static const DWORD tex2_data[4] = {0x00000000, 0x0000ff00, 0x00000000, 0x0000ff00};
    static const float vertices[] =
    {
         64.0f, 64.0f, 0.1f,
        128.0f, 64.0f, 0.1f,
        192.0f, 64.0f, 0.1f,
        256.0f, 64.0f, 0.1f,
        320.0f, 64.0f, 0.1f,
        384.0f, 64.0f, 0.1f,
        448.0f, 64.0f, 0.1f,
        512.0f, 64.0f, 0.1f,
    };
    static const struct
    {
        float x, y, z;
        float point_size;
    }
    vertex_pointsize = {64.0f, 64.0f, 0.1f, 48.0f},
    vertex_pointsize_scaled = {64.0f, 64.0f, 0.1f, 24.0f},
    vertex_pointsize_zero = {64.0f, 64.0f, 0.1f, 0.0f};
    static const DWORD decl[] =
    {
        D3DVSD_STREAM(0),
        D3DVSD_REG(0, D3DVSDT_FLOAT3),  /* position */
        D3DVSD_END()
    },
    decl_psize[] =
    {
        D3DVSD_STREAM(0),
        D3DVSD_REG(0, D3DVSDT_FLOAT3),  /* position, v0 */
        D3DVSD_REG(1, D3DVSDT_FLOAT1),  /* point size, v1 */
        D3DVSD_END()
    };
    static const DWORD vshader_code[] =
    {
        0xfffe0101,                                                 /* vs_1_1                 */
        0x00000005, 0x800f0000, 0x90000000, 0xa0e40000,             /* mul r0, v0.x, c0       */
        0x00000004, 0x800f0000, 0x90550000, 0xa0e40001, 0x80e40000, /* mad r0, v0.y, c1, r0   */
        0x00000004, 0x800f0000, 0x90aa0000, 0xa0e40002, 0x80e40000, /* mad r0, v0.z, c2, r0   */
        0x00000004, 0xc00f0000, 0x90ff0000, 0xa0e40003, 0x80e40000, /* mad oPos, v0.w, c3, r0 */
        0x0000ffff
    };
    static const DWORD vshader_psize_code[] =
    {
        0xfffe0101,                                                 /* vs_1_1                 */
        0x00000005, 0x800f0000, 0x90000000, 0xa0e40000,             /* mul r0, v0.x, c0       */
        0x00000004, 0x800f0000, 0x90550000, 0xa0e40001, 0x80e40000, /* mad r0, v0.y, c1, r0   */
        0x00000004, 0x800f0000, 0x90aa0000, 0xa0e40002, 0x80e40000, /* mad r0, v0.z, c2, r0   */
        0x00000004, 0xc00f0000, 0x90ff0000, 0xa0e40003, 0x80e40000, /* mad oPos, v0.w, c3, r0 */
        0x00000001, 0xc00f0002, 0x90000001,                         /* mov oPts, v1.x */
        0x0000ffff
    };
    static const DWORD pshader_code[] =
    {
        0xffff0101,                                                 /* ps_1_1                 */
        0x00000042, 0xb00f0000,                                     /* tex t0                 */
        0x00000042, 0xb00f0001,                                     /* tex t1                 */
        0x00000002, 0x800f0000, 0xb0e40000, 0xb0e40001,             /* add r0, t0, t1         */
        0x0000ffff
    };
    static const struct test_shader
    {
        DWORD version;
        const DWORD *code;
    }
    novs = {0, NULL},
    vs1 = {D3DVS_VERSION(1, 1), vshader_code},
    vs1_psize = {D3DVS_VERSION(1, 1), vshader_psize_code},
    nops = {0, NULL},
    ps1 = {D3DPS_VERSION(1, 1), pshader_code};
    static const struct
    {
        const DWORD *decl;
        const struct test_shader *vs;
        const struct test_shader *ps;
        DWORD accepted_fvf;
        unsigned int nonscaled_size, scaled_size;
    }
    test_setups[] =
    {
        {NULL, &novs, &nops, D3DFVF_XYZ, 32, 62},
        {decl, &vs1, &ps1, D3DFVF_XYZ, 32, 32},
        {NULL, &novs, &ps1, D3DFVF_XYZ, 32, 62},
        {decl, &vs1, &nops, D3DFVF_XYZ, 32, 32},
        {NULL, &novs, &nops, D3DFVF_XYZ | D3DFVF_PSIZE, 48, 48},
        {decl_psize, &vs1_psize, &ps1, D3DFVF_XYZ | D3DFVF_PSIZE, 48, 24},
    };
    static const struct
    {
        BOOL zero_size;
        BOOL scale;
        BOOL override_min;
        DWORD fvf;
        const void *vertex_data;
        unsigned int vertex_size;
    }
    tests[] =
    {
        {FALSE, FALSE, FALSE, D3DFVF_XYZ, vertices, sizeof(float) * 3},
        {FALSE, TRUE,  FALSE, D3DFVF_XYZ, vertices, sizeof(float) * 3},
        {FALSE, FALSE, TRUE,  D3DFVF_XYZ, vertices, sizeof(float) * 3},
        {TRUE,  FALSE, FALSE, D3DFVF_XYZ, vertices, sizeof(float) * 3},
        {FALSE, FALSE, FALSE, D3DFVF_XYZ | D3DFVF_PSIZE, &vertex_pointsize, sizeof(vertex_pointsize)},
        {FALSE, TRUE,  FALSE, D3DFVF_XYZ | D3DFVF_PSIZE, &vertex_pointsize_scaled, sizeof(vertex_pointsize_scaled)},
        {FALSE, FALSE, TRUE,  D3DFVF_XYZ | D3DFVF_PSIZE, &vertex_pointsize, sizeof(vertex_pointsize)},
        {TRUE,  FALSE, FALSE, D3DFVF_XYZ | D3DFVF_PSIZE, &vertex_pointsize_zero, sizeof(vertex_pointsize_zero)},
    };
    /* Transforms the coordinate system [-1.0;1.0]x[1.0;-1.0] to
     * [0.0;0.0]x[640.0;480.0]. Z is untouched. */
    D3DMATRIX matrix =
    {{{
        2.0f / 640.0f,           0.0f, 0.0f, 0.0f,
                 0.0f, -2.0f / 480.0f, 0.0f, 0.0f,
                 0.0f,           0.0f, 1.0f, 0.0f,
                -1.0f,           1.0f, 0.0f, 1.0f,
    }}};

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get caps, hr %#lx.\n", hr);
    if (caps.MaxPointSize < 32.0f)
    {
        skip("MaxPointSize %f < 32.0, skipping.\n", caps.MaxPointSize);
        IDirect3DDevice8_Release(device);
        goto done;
    }

    /* The r500 Windows driver needs a draw with regular texture coordinates at least once during the
     * device's lifetime, otherwise texture coordinate generation only works for texture 0. */
    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_TEX1);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_POINTLIST, 1, vertices, sizeof(float) * 5);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0xff0000ff, 1.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable lighting, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTransform(device, D3DTS_PROJECTION, &matrix);
    ok(SUCCEEDED(hr), "Failed to set projection matrix, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ);
    ok(SUCCEEDED(hr), "Failed to set FVF, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);

    ptsize = 15.0f;
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_POINTSIZE, *(DWORD *)&ptsize);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_POINTLIST, 1, &vertices[0], sizeof(float) * 3);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    ptsize = 31.0f;
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_POINTSIZE, *(DWORD *)&ptsize);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_POINTLIST, 1, &vertices[3], sizeof(float) * 3);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    ptsize = 30.75f;
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_POINTSIZE, *(DWORD *)&ptsize);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_POINTLIST, 1, &vertices[6], sizeof(float) * 3);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    if (caps.MaxPointSize >= 63.0f)
    {
        ptsize = 63.0f;
        hr = IDirect3DDevice8_SetRenderState(device, D3DRS_POINTSIZE, *(DWORD *)&ptsize);
        ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_POINTLIST, 1, &vertices[9], sizeof(float) * 3);
        ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

        ptsize = 62.75f;
        hr = IDirect3DDevice8_SetRenderState(device, D3DRS_POINTSIZE, *(DWORD *)&ptsize);
        ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_POINTLIST, 1, &vertices[15], sizeof(float) * 3);
        ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    }

    ptsize = 1.0f;
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_POINTSIZE, *(DWORD *)&ptsize);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_POINTLIST, 1, &vertices[12], sizeof(float) * 3);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetRenderState(device, D3DRS_POINTSIZE_MAX, (DWORD *)&ptsizemax_orig);
    ok(SUCCEEDED(hr), "Failed to get render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_GetRenderState(device, D3DRS_POINTSIZE_MIN, (DWORD *)&ptsizemin_orig);
    ok(SUCCEEDED(hr), "Failed to get render state, hr %#lx.\n", hr);

    /* What happens if point scaling is disabled, and POINTSIZE_MAX < POINTSIZE? */
    ptsize = 15.0f;
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_POINTSIZE, *(DWORD *)&ptsize);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    ptsize = 1.0f;
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_POINTSIZE_MAX, *(DWORD *)&ptsize);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_POINTLIST, 1, &vertices[18], sizeof(float) * 3);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_POINTSIZE_MAX, *(DWORD *)&ptsizemax_orig);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);

    /* pointsize < pointsize_min < pointsize_max?
     * pointsize = 1.0, pointsize_min = 15.0, pointsize_max = default(usually 64.0) */
    ptsize = 1.0f;
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_POINTSIZE, *(DWORD *)&ptsize);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    ptsize = 15.0f;
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_POINTSIZE_MIN, *(DWORD *)&ptsize);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_POINTLIST, 1, &vertices[21], sizeof(float) * 3);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_POINTSIZE_MIN, *(DWORD *)&ptsizemin_orig);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

    ok(point_match(device, 64, 64, 7), "point_match(64, 64, 7) failed, expected point size 15.\n");
    ok(point_match(device, 128, 64, 15), "point_match(128, 64, 15) failed, expected point size 31.\n");
    ok(point_match(device, 192, 64, 15), "point_match(192, 64, 15) failed, expected point size 31.\n");

    if (caps.MaxPointSize >= 63.0f)
    {
        ok(point_match(device, 256, 64, 31), "point_match(256, 64, 31) failed, expected point size 63.\n");
        ok(point_match(device, 384, 64, 31), "point_match(384, 64, 31) failed, expected point size 63.\n");
    }

    ok(point_match(device, 320, 64, 0), "point_match(320, 64, 0) failed, expected point size 1.\n");
    /* ptsize = 15, ptsize_max = 1 --> point has size 1 */
    ok(point_match(device, 448, 64, 0), "point_match(448, 64, 0) failed, expected point size 1.\n");
    /* ptsize = 1, ptsize_max = default(64), ptsize_min = 15 --> point has size 15 */
    ok(point_match(device, 512, 64, 7), "point_match(512, 64, 7) failed, expected point size 15.\n");

    IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);

    /* The following code tests point sprites with two textures, to see if each texture coordinate unit
     * generates texture coordinates for the point(result: Yes, it does)
     *
     * However, not all GL implementations support point sprites(they need GL_ARB_point_sprite), but there
     * is no point sprite cap bit in d3d because native d3d software emulates point sprites. Until the
     * SW emulation is implemented in wined3d, this test will fail on GL drivers that does not support them.
     */
    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0xff0000ff, 1.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CreateTexture(device, 2, 2, 1, 0, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED, &tex1);
    ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateTexture(device, 2, 2, 1, 0, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED, &tex2);
    ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx.\n", hr);
    memset(&lr, 0, sizeof(lr));
    hr = IDirect3DTexture8_LockRect(tex1, 0, &lr, NULL, 0);
    ok(SUCCEEDED(hr), "Failed to lock texture, hr %#lx.\n", hr);
    memcpy(lr.pBits, tex1_data, sizeof(tex1_data));
    hr = IDirect3DTexture8_UnlockRect(tex1, 0);
    ok(SUCCEEDED(hr), "Failed to unlock texture, hr %#lx.\n", hr);
    memset(&lr, 0, sizeof(lr));
    hr = IDirect3DTexture8_LockRect(tex2, 0, &lr, NULL, 0);
    ok(SUCCEEDED(hr), "Failed to lock texture, hr %#lx.\n", hr);
    memcpy(lr.pBits, tex2_data, sizeof(tex2_data));
    hr = IDirect3DTexture8_UnlockRect(tex2, 0);
    ok(SUCCEEDED(hr), "Failed to unlock texture, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *)tex1);
    ok(SUCCEEDED(hr), "Failed to set texture, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTexture(device, 1, (IDirect3DBaseTexture8 *)tex2);
    ok(SUCCEEDED(hr), "Failed to set texture, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_COLOROP, D3DTOP_SELECTARG1);
    ok(SUCCEEDED(hr), "Failed to set color op, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_COLORARG1, D3DTA_TEXTURE);
    ok(SUCCEEDED(hr), "Failed to set color arg, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 1, D3DTSS_COLOROP, D3DTOP_ADD);
    ok(SUCCEEDED(hr), "Failed to set color op, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 1, D3DTSS_COLORARG1, D3DTA_TEXTURE);
    ok(SUCCEEDED(hr), "Failed to set color arg, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 1, D3DTSS_COLORARG2, D3DTA_CURRENT);
    ok(SUCCEEDED(hr), "Failed to set color arg, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_POINTSPRITEENABLE, TRUE);
    ok(SUCCEEDED(hr), "Failed to enable point sprites, hr %#lx.\n", hr);
    ptsize = 32.0f;
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_POINTSIZE, *(DWORD *)&ptsize);
    ok(SUCCEEDED(hr), "Failed to set point size, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_POINTLIST, 1, &vertices[0], sizeof(float) * 3);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

    color = getPixelColor(device, 64 - 4, 64 - 4);
    ok(color == 0x00ff0000, "pSprite: Pixel (64 - 4),(64 - 4) has color 0x%08x, expected 0x00ff0000\n", color);
    color = getPixelColor(device, 64 - 4, 64 + 4);
    ok(color == 0x00000000, "pSprite: Pixel (64 - 4),(64 + 4) has color 0x%08x, expected 0x00000000\n", color);
    color = getPixelColor(device, 64 + 4, 64 + 4);
    ok(color == 0x0000ff00, "pSprite: Pixel (64 + 4),(64 + 4) has color 0x%08x, expected 0x0000ff00\n", color);
    color = getPixelColor(device, 64 + 4, 64 - 4);
    ok(color == 0x00ffff00, "pSprite: Pixel (64 + 4),(64 - 4) has color 0x%08x, expected 0x00ffff00\n", color);
    IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);

    matrix.m[0][0] =  1.0f / 64.0f;
    matrix.m[1][1] = -1.0f / 64.0f;
    hr = IDirect3DDevice8_SetTransform(device, D3DTS_PROJECTION, &matrix);
    ok(SUCCEEDED(hr), "Failed to set projection matrix, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetRenderTarget(device, &backbuffer);
    ok(SUCCEEDED(hr), "Failed to get backbuffer, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_GetDepthStencilSurface(device, &depthstencil);
    ok(SUCCEEDED(hr), "Failed to get depth / stencil buffer, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CreateRenderTarget(device, 128, 128, D3DFMT_A8R8G8B8,
            D3DMULTISAMPLE_NONE, TRUE, &rt);
    ok(SUCCEEDED(hr), "Failed to create a render target, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_POINTSCALE_A, *(DWORD *)&a);
    ok(SUCCEEDED(hr), "Failed setting point scale attenuation coefficient, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_POINTSCALE_B, *(DWORD *)&b);
    ok(SUCCEEDED(hr), "Failed setting point scale attenuation coefficient, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_POINTSCALE_C, *(DWORD *)&c);
    ok(SUCCEEDED(hr), "Failed setting point scale attenuation coefficient, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetVertexShaderConstant(device, 0, &matrix._11, 4);
    ok(SUCCEEDED(hr), "Failed to set vertex shader constants, hr %#lx.\n", hr);

    if (caps.MaxPointSize < 63.0f)
    {
        skip("MaxPointSize %f < 63.0, skipping some tests.\n", caps.MaxPointSize);
        goto cleanup;
    }

    hr = IDirect3DDevice8_SetRenderTarget(device, rt, depthstencil);
    ok(SUCCEEDED(hr), "Failed to set render target, hr %#lx.\n", hr);

    for (i = 0; i < ARRAY_SIZE(test_setups); ++i)
    {
        if (caps.VertexShaderVersion < test_setups[i].vs->version
                || caps.PixelShaderVersion < test_setups[i].ps->version)
        {
            skip("Vertex / pixel shader version not supported, skipping test.\n");
            continue;
        }
        if (test_setups[i].vs->code)
        {
            hr = IDirect3DDevice8_CreateVertexShader(device, test_setups[i].decl, test_setups[i].vs->code, &vs, 0);
            ok(SUCCEEDED(hr), "Failed to create vertex shader, hr %#lx (case %u).\n", hr, i);
        }
        else
        {
            vs = 0;
        }
        if (test_setups[i].ps->code)
        {
            hr = IDirect3DDevice8_CreatePixelShader(device, test_setups[i].ps->code, &ps);
            ok(SUCCEEDED(hr), "Failed to create pixel shader, hr %#lx (case %u).\n", hr, i);
        }
        else
        {
            ps = 0;
        }

        hr = IDirect3DDevice8_SetVertexShader(device, vs ? vs : test_setups[i].accepted_fvf);
        ok(SUCCEEDED(hr), "Failed to set vertex shader, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetPixelShader(device, ps);
        ok(SUCCEEDED(hr), "Failed to set pixel shader, hr %#lx.\n", hr);

        for (j = 0; j < ARRAY_SIZE(tests); ++j)
        {
            unsigned int size = tests[j].override_min ? 63 : tests[j].zero_size ? 0 : tests[j].scale
                    ? test_setups[i].scaled_size : test_setups[i].nonscaled_size;

            if (test_setups[i].accepted_fvf != tests[j].fvf)
                continue;

            ptsize = tests[j].zero_size ? 0.0f : 32.0f;
            hr = IDirect3DDevice8_SetRenderState(device, D3DRS_POINTSIZE, *(DWORD *)&ptsize);
            ok(SUCCEEDED(hr), "Failed to set pointsize, hr %#lx.\n", hr);

            ptsize = tests[j].override_min ? 63.0f : tests[j].zero_size ? 0.0f : ptsizemin_orig;
            hr = IDirect3DDevice8_SetRenderState(device, D3DRS_POINTSIZE_MIN, *(DWORD *)&ptsize);
            ok(SUCCEEDED(hr), "Failed to set minimum pointsize, hr %#lx.\n", hr);

            hr = IDirect3DDevice8_SetRenderState(device, D3DRS_POINTSCALEENABLE, tests[j].scale);
            ok(SUCCEEDED(hr), "Failed setting point scale state, hr %#lx.\n", hr);

            hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0xff00ffff, 1.0f, 0);
            ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);

            hr = IDirect3DDevice8_BeginScene(device);
            ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
            hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_POINTLIST, 1,
                    tests[j].vertex_data, tests[j].vertex_size);
            ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
            hr = IDirect3DDevice8_EndScene(device);
            ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

            if (tests[j].zero_size)
            {
                /* Technically 0 pointsize is undefined in OpenGL but in practice it seems like
                 * it does the "useful" thing on all the drivers I tried. */
                /* On WARP it does draw some pixels, most of the time. */
                color = getPixelColor(device, 64, 64);
                todo_wine_if(!color_match(color, 0x0000ffff, 0))
                ok(color_match(color, 0x0000ffff, 0)
                        || broken(color_match(color, 0x00ff0000, 0))
                        || broken(color_match(color, 0x00ffff00, 0))
                        || broken(color_match(color, 0x00000000, 0))
                        || broken(color_match(color, 0x0000ff00, 0)),
                        "Got unexpected color 0x%08x (case %u, %u, size %u).\n", color, i, j, size);
            }
            else
            {
                struct surface_readback rb;

                get_surface_readback(rt, &rb);
                color = get_readback_color(&rb, 64 - size / 2 + 1, 64 - size / 2 + 1);
                ok(color_match(color, 0x00ff0000, 0),
                        "Got unexpected color 0x%08x (case %u, %u, size %u).\n", color, i, j, size);
                color = get_readback_color(&rb, 64 + size / 2 - 1, 64 - size / 2 + 1);
                ok(color_match(color, 0x00ffff00, 0),
                        "Got unexpected color 0x%08x (case %u, %u, size %u).\n", color, i, j, size);
                color = get_readback_color(&rb, 64 - size / 2 + 1, 64 + size / 2 - 1);
                ok(color_match(color, 0x00000000, 0),
                        "Got unexpected color 0x%08x (case %u, %u, size %u).\n", color, i, j, size);
                color = get_readback_color(&rb, 64 + size / 2 - 1, 64 + size / 2 - 1);
                ok(color_match(color, 0x0000ff00, 0),
                        "Got unexpected color 0x%08x (case %u, %u, size %u).\n", color, i, j, size);

                color = get_readback_color(&rb, 64 - size / 2 - 1, 64 - size / 2 - 1);
                ok(color_match(color, 0xff00ffff, 0),
                        "Got unexpected color 0x%08x (case %u, %u, size %u).\n", color, i, j, size);
                color = get_readback_color(&rb, 64 + size / 2 + 1, 64 - size / 2 - 1);
                ok(color_match(color, 0xff00ffff, 0),
                        "Got unexpected color 0x%08x (case %u, %u, size %u).\n", color, i, j, size);
                color = get_readback_color(&rb, 64 - size / 2 - 1, 64 + size / 2 + 1);
                ok(color_match(color, 0xff00ffff, 0),
                        "Got unexpected color 0x%08x (case %u, %u, size %u).\n", color, i, j, size);
                color = get_readback_color(&rb, 64 + size / 2 + 1, 64 + size / 2 + 1);
                ok(color_match(color, 0xff00ffff, 0),
                        "Got unexpected color 0x%08x (case %u, %u, size %u).\n", color, i, j, size);

                release_surface_readback(&rb);
            }
        }
        IDirect3DDevice8_SetVertexShader(device, 0);
        IDirect3DDevice8_SetPixelShader(device, 0);
        if (vs)
            IDirect3DDevice8_DeleteVertexShader(device, vs);
        if (ps)
            IDirect3DDevice8_DeletePixelShader(device, ps);
    }
    hr = IDirect3DDevice8_SetRenderTarget(device, backbuffer, depthstencil);
    ok(SUCCEEDED(hr), "Failed to set render target, hr %#lx.\n", hr);

cleanup:
    IDirect3DSurface8_Release(backbuffer);
    IDirect3DSurface8_Release(depthstencil);
    IDirect3DSurface8_Release(rt);

    IDirect3DTexture8_Release(tex1);
    IDirect3DTexture8_Release(tex2);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_multisample_mismatch(void)
{
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d;
    HWND window;
    HRESULT hr;
    ULONG refcount;
    IDirect3DSurface8 *rt_multi, *ds;

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (FAILED(IDirect3D8_CheckDeviceMultiSampleType(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            D3DFMT_A8R8G8B8, TRUE, D3DMULTISAMPLE_2_SAMPLES)))
    {
        skip("Multisampling not supported for D3DFMT_A8R8G8B8, skipping multisample mismatch test.\n");
        IDirect3D8_Release(d3d);
        return;
    }

    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    hr = IDirect3DDevice8_CreateRenderTarget(device, 640, 480, D3DFMT_A8R8G8B8,
            D3DMULTISAMPLE_2_SAMPLES, FALSE, &rt_multi);
    ok(SUCCEEDED(hr), "Failed to create render target, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_GetDepthStencilSurface(device, &ds);
    ok(SUCCEEDED(hr), "Failed to get original depth/stencil, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderTarget(device, rt_multi, ds);
    ok(hr == D3DERR_INVALIDCALL, "Got unexpected hr %#lx.\n", hr);

    IDirect3DSurface8_Release(ds);
    IDirect3DSurface8_Release(rt_multi);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_texcoordindex(void)
{
    static const D3DMATRIX mat =
    {{{
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 0.0f,
    }}};
    static const struct
    {
        struct vec3 pos;
        struct vec2 texcoord1;
        struct vec2 texcoord2;
        struct vec2 texcoord3;
    }
    quad[] =
    {
        {{-1.0f, -1.0f, 0.0f}, {0.0f, 1.0f}, {0.0f, 0.0f}, {1.0f, 1.0f}},
        {{-1.0f,  1.0f, 0.0f}, {0.0f, 0.0f}, {0.0f, 1.0f}, {1.0f, 0.0f}},
        {{ 1.0f, -1.0f, 0.0f}, {1.0f, 1.0f}, {1.0f, 0.0f}, {0.0f, 1.0f}},
        {{ 1.0f,  1.0f, 0.0f}, {1.0f, 0.0f}, {1.0f, 1.0f}, {0.0f, 0.0f}},
    };
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d;
    HWND window;
    HRESULT hr;
    IDirect3DTexture8 *texture1, *texture2;
    D3DLOCKED_RECT locked_rect;
    unsigned int color;
    ULONG refcount;
    DWORD *ptr;

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_CreateTexture(device, 2, 2, 1, 0, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED, &texture1);
    ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateTexture(device, 2, 2, 1, 0, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED, &texture2);
    ok(SUCCEEDED(hr), "Failed to create texture, hr %#lx.\n", hr);

    hr = IDirect3DTexture8_LockRect(texture1, 0, &locked_rect, NULL, D3DLOCK_DISCARD);
    ok(SUCCEEDED(hr), "Failed to lock texture, hr %#lx.\n", hr);
    ptr = locked_rect.pBits;
    ptr[0] = 0xff000000;
    ptr[1] = 0xff00ff00;
    ptr[2] = 0xff0000ff;
    ptr[3] = 0xff00ffff;
    hr = IDirect3DTexture8_UnlockRect(texture1, 0);
    ok(SUCCEEDED(hr), "Failed to unlock texture, hr %#lx.\n", hr);

    hr = IDirect3DTexture8_LockRect(texture2, 0, &locked_rect, NULL, D3DLOCK_DISCARD);
    ok(SUCCEEDED(hr), "Failed to lock texture, hr %#lx.\n", hr);
    ptr = locked_rect.pBits;
    ptr[0] = 0xff000000;
    ptr[1] = 0xff0000ff;
    ptr[2] = 0xffff0000;
    ptr[3] = 0xffff00ff;
    hr = IDirect3DTexture8_UnlockRect(texture2, 0);
    ok(SUCCEEDED(hr), "Failed to unlock texture, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *)texture1);
    ok(SUCCEEDED(hr), "Failed to set texture, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTexture(device, 1, (IDirect3DBaseTexture8 *)texture2);
    ok(SUCCEEDED(hr), "Failed to set texture, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_TEX3);
    ok(SUCCEEDED(hr), "Failed to set FVF, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable lighting, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_COLOROP, D3DTOP_SELECTARG1);
    ok(SUCCEEDED(hr), "Failed to set color op, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_COLORARG1, D3DTA_TEXTURE);
    ok(SUCCEEDED(hr), "Failed to set color arg, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 1, D3DTSS_COLOROP, D3DTOP_ADD);
    ok(SUCCEEDED(hr), "Failed to set color op, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 1, D3DTSS_COLORARG1, D3DTA_TEXTURE);
    ok(SUCCEEDED(hr), "Failed to set color arg, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 1, D3DTSS_COLORARG2, D3DTA_CURRENT);
    ok(SUCCEEDED(hr), "Failed to set color arg, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 2, D3DTSS_COLOROP, D3DTOP_DISABLE);
    ok(SUCCEEDED(hr), "Failed to set color op, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_TEXCOORDINDEX, 1);
    ok(SUCCEEDED(hr), "Failed to set texcoord index, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 1, D3DTSS_TEXCOORDINDEX, 0);
    ok(SUCCEEDED(hr), "Failed to set texcoord index, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xffffff00, 1.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(*quad));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

    color = getPixelColor(device, 160, 120);
    ok(color_match(color, 0x000000ff, 2), "Got unexpected color 0x%08x.\n", color);
    color = getPixelColor(device, 480, 120);
    ok(color_match(color, 0x0000ffff, 2), "Got unexpected color 0x%08x.\n", color);
    color = getPixelColor(device, 160, 360);
    ok(color_match(color, 0x00ff0000, 2), "Got unexpected color 0x%08x.\n", color);
    color = getPixelColor(device, 480, 360);
    ok(color_match(color, 0x00ffffff, 2), "Got unexpected color 0x%08x.\n", color);

    hr = IDirect3DDevice8_SetTextureStageState(device, 1, D3DTSS_TEXTURETRANSFORMFLAGS, D3DTTFF_COUNT2);
    ok(SUCCEEDED(hr), "Failed to set texture transform flags, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTransform(device, D3DTS_TEXTURE1, &mat);
    ok(SUCCEEDED(hr), "Failed to set transformation matrix, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xffffff00, 1.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(*quad));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

    color = getPixelColor(device, 160, 120);
    ok(color_match(color, 0x000000ff, 2), "Got unexpected color 0x%08x.\n", color);
    color = getPixelColor(device, 480, 120);
    ok(color_match(color, 0x0000ffff, 2), "Got unexpected color 0x%08x.\n", color);
    color = getPixelColor(device, 160, 360);
    ok(color_match(color, 0x00000000, 2), "Got unexpected color 0x%08x.\n", color);
    color = getPixelColor(device, 480, 360);
    ok(color_match(color, 0x0000ffff, 2), "Got unexpected color 0x%08x.\n", color);

    hr = IDirect3DDevice8_SetTextureStageState(device, 1, D3DTSS_TEXTURETRANSFORMFLAGS, D3DTTFF_DISABLE);
    ok(SUCCEEDED(hr), "Failed to set texture transform flags, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 1, D3DTSS_TEXCOORDINDEX, 2);
    ok(SUCCEEDED(hr), "Failed to set texcoord index, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xffffff00, 1.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(*quad));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

    color = getPixelColor(device, 160, 120);
    ok(color_match(color, 0x000000ff, 2), "Got unexpected color 0x%08x.\n", color);
    color = getPixelColor(device, 480, 120);
    ok(color_match(color, 0x0000ffff, 2), "Got unexpected color 0x%08x.\n", color);
    color = getPixelColor(device, 160, 360);
    ok(color_match(color, 0x00ff00ff, 2), "Got unexpected color 0x%08x.\n", color);
    color = getPixelColor(device, 480, 360);
    ok(color_match(color, 0x00ffff00, 2), "Got unexpected color 0x%08x.\n", color);

    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    IDirect3DTexture8_Release(texture1);
    IDirect3DTexture8_Release(texture2);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_vshader_input(void)
{
    DWORD swapped_twotexcrd_shader, swapped_onetexcrd_shader = 0;
    DWORD swapped_twotex_wrongidx_shader = 0, swapped_twotexcrd_rightorder_shader;
    DWORD texcoord_color_shader, color_ubyte_shader, color_color_shader, color_float_shader;
    DWORD color_nocolor_shader = 0;
    IDirect3DDevice8 *device;
    unsigned int color;
    IDirect3D8 *d3d;
    ULONG refcount;
    D3DCAPS8 caps;
    HWND window;
    HRESULT hr;

    static const DWORD swapped_shader_code[] =
    {
        0xfffe0101,                                         /* vs_1_1               */
        0x00000001, 0xc00f0000, 0x90e40000,                 /* mov o0, v0           */
        0x00000001, 0x800f0001, 0x90e40001,                 /* mov r1, v1           */
        0x00000002, 0xd00f0000, 0x80e40001, 0x91e40002,     /* sub o1, r1, v2       */
        0x0000ffff                                          /* end                  */
    };
    static const DWORD texcoord_color_shader_code[] =
    {
        0xfffe0101,                                         /* vs_1_1               */
        0x00000001, 0xc00f0000, 0x90e40000,                 /* mov oPos, v0         */
        0x00000001, 0xd00f0000, 0x90e40007,                 /* mov oD0, v7          */
        0x0000ffff                                          /* end                  */
    };
    static const DWORD color_color_shader_code[] =
    {
        0xfffe0101,                                         /* vs_1_1               */
        0x00000001, 0xc00f0000, 0x90e40000,                 /* mov oPos, v0         */
        0x00000005, 0xd00f0000, 0xa0e40000, 0x90e40005,     /* mul oD0, c0, v5      */
        0x0000ffff                                          /* end                  */
    };
    static const float quad1[] =
    {
        -1.0f, -1.0f, 0.1f,  1.0f, 0.0f, 1.0f, 0.0f,  0.0f, -1.0f,  0.5f, 0.0f,
        -1.0f,  0.0f, 0.1f,  1.0f, 0.0f, 1.0f, 0.0f,  0.0f, -1.0f,  0.5f, 0.0f,
         0.0f, -1.0f, 0.1f,  1.0f, 0.0f, 1.0f, 0.0f,  0.0f, -1.0f,  0.5f, 0.0f,
         0.0f,  0.0f, 0.1f,  1.0f, 0.0f, 1.0f, 0.0f,  0.0f, -1.0f,  0.5f, 0.0f,
    };
    static const float quad4[] =
    {
         0.0f,  0.0f, 0.1f,  1.0f, 0.0f, 1.0f, 0.0f,  0.0f, -1.0f,  0.5f, 0.0f,
         0.0f,  1.0f, 0.1f,  1.0f, 0.0f, 1.0f, 0.0f,  0.0f, -1.0f,  0.5f, 0.0f,
         1.0f,  0.0f, 0.1f,  1.0f, 0.0f, 1.0f, 0.0f,  0.0f, -1.0f,  0.5f, 0.0f,
         1.0f,  1.0f, 0.1f,  1.0f, 0.0f, 1.0f, 0.0f,  0.0f, -1.0f,  0.5f, 0.0f,
    };
    static const struct
    {
        struct vec3 position;
        DWORD diffuse;
    }
    quad1_color[] =
    {
        {{-1.0f, -1.0f, 0.1f}, 0x00ff8040},
        {{-1.0f,  0.0f, 0.1f}, 0x00ff8040},
        {{ 0.0f, -1.0f, 0.1f}, 0x00ff8040},
        {{ 0.0f,  0.0f, 0.1f}, 0x00ff8040},
    },
    quad2_color[] =
    {
        {{ 0.0f, -1.0f, 0.1f}, 0x00ff8040},
        {{ 0.0f,  0.0f, 0.1f}, 0x00ff8040},
        {{ 1.0f, -1.0f, 0.1f}, 0x00ff8040},
        {{ 1.0f,  0.0f, 0.1f}, 0x00ff8040},
    };
    static const struct
    {
        struct vec3 position;
        struct vec3 dummy; /* testing D3DVSD_SKIP */
        DWORD diffuse;
    }
    quad3_color[] =
    {
        {{-1.0f,  0.0f, 0.1f}, {0.0f}, 0x00ff8040},
        {{-1.0f,  1.0f, 0.1f}, {0.0f}, 0x00ff8040},
        {{ 0.0f,  0.0f, 0.1f}, {0.0f}, 0x00ff8040},
        {{ 0.0f,  1.0f, 0.1f}, {0.0f}, 0x00ff8040},
    };
    static const float quad4_color[] =
    {
         0.0f,  0.0f, 0.1f,  1.0f, 1.0f, 0.0f, 0.0f,
         0.0f,  1.0f, 0.1f,  1.0f, 1.0f, 0.0f, 0.0f,
         1.0f,  0.0f, 0.1f,  1.0f, 1.0f, 0.0f, 1.0f,
         1.0f,  1.0f, 0.1f,  1.0f, 1.0f, 0.0f, 1.0f,
    };
    static const DWORD decl_twotexcrd[] =
    {
        D3DVSD_STREAM(0),
        D3DVSD_REG(0, D3DVSDT_FLOAT3), /* position */
        D3DVSD_REG(1, D3DVSDT_FLOAT4), /* texcoord0 */
        D3DVSD_REG(2, D3DVSDT_FLOAT4), /* texcoord1 */
        D3DVSD_END()
    };
    static const DWORD decl_twotexcrd_rightorder[] =
    {
        D3DVSD_STREAM(0),
        D3DVSD_REG(0, D3DVSDT_FLOAT3), /* position */
        D3DVSD_REG(2, D3DVSDT_FLOAT4), /* texcoord0 */
        D3DVSD_REG(1, D3DVSDT_FLOAT4), /* texcoord1 */
        D3DVSD_END()
    };
    static const DWORD decl_onetexcrd[] =
    {
        D3DVSD_STREAM(0),
        D3DVSD_REG(0, D3DVSDT_FLOAT3), /* position */
        D3DVSD_REG(1, D3DVSDT_FLOAT4), /* texcoord0 */
        D3DVSD_END()
    };
    static const DWORD decl_twotexcrd_wrongidx[] =
    {
        D3DVSD_STREAM(0),
        D3DVSD_REG(0, D3DVSDT_FLOAT3), /* position */
        D3DVSD_REG(2, D3DVSDT_FLOAT4), /* texcoord1 */
        D3DVSD_REG(3, D3DVSDT_FLOAT4), /* texcoord2 */
        D3DVSD_END()
    };
    static const DWORD decl_texcoord_color[] =
    {
        D3DVSD_STREAM(0),
        D3DVSD_REG(0, D3DVSDT_FLOAT3), /* position */
        D3DVSD_REG(7, D3DVSDT_D3DCOLOR), /* texcoord0 */
        D3DVSD_END()
    };
    static const DWORD decl_color_color[] =
    {
        D3DVSD_STREAM(0),
        D3DVSD_REG(0, D3DVSDT_FLOAT3), /* position */
        D3DVSD_SKIP(3),                /* not used */
        D3DVSD_REG(5, D3DVSDT_D3DCOLOR), /* diffuse */
        D3DVSD_END()
    };
    static const DWORD decl_color_ubyte[] =
    {
        D3DVSD_STREAM(0),
        D3DVSD_REG(0, D3DVSDT_FLOAT3),
        D3DVSD_REG(5, D3DVSDT_UBYTE4),
        D3DVSD_END()
    };
    static const DWORD decl_color_float[] =
    {
        D3DVSD_STREAM(0),
        D3DVSD_REG(0, D3DVSDT_FLOAT3),
        D3DVSD_REG(5, D3DVSDT_FLOAT4),
        D3DVSD_END()
    };
    static const DWORD decl_nocolor[] =
    {
        D3DVSD_STREAM(0),
        D3DVSD_REG(0, D3DVSDT_FLOAT3),
        D3DVSD_END()
    };
    static const float normalize[4] = {1.0f / 256.0f, 1.0f / 256.0f, 1.0f / 256.0f, 1.0f / 256.0f};
    static const float no_normalize[4] = {1.0f, 1.0f, 1.0f, 1.0f};

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get device caps, hr %#lx.\n", hr);
    if (caps.VertexShaderVersion < D3DVS_VERSION(1, 1))
    {
        skip("No vs_1_1 support, skipping tests.\n");
        IDirect3DDevice8_Release(device);
        goto done;
    }

    hr = IDirect3DDevice8_CreateVertexShader(device, decl_twotexcrd, swapped_shader_code, &swapped_twotexcrd_shader, 0);
    ok(SUCCEEDED(hr), "Failed to create vertex shader, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateVertexShader(device, decl_onetexcrd, swapped_shader_code, &swapped_onetexcrd_shader, 0);
    todo_wine ok(hr == D3DERR_INVALIDCALL, "Unexpected error while creating vertex shader, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateVertexShader(device, decl_twotexcrd_wrongidx, swapped_shader_code, &swapped_twotex_wrongidx_shader, 0);
    todo_wine ok(hr == D3DERR_INVALIDCALL, "Unexpected error while creating vertex shader, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateVertexShader(device, decl_twotexcrd_rightorder, swapped_shader_code, &swapped_twotexcrd_rightorder_shader, 0);
    ok(SUCCEEDED(hr), "Failed to create vertex shader, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CreateVertexShader(device, decl_texcoord_color, texcoord_color_shader_code, &texcoord_color_shader, 0);
    ok(SUCCEEDED(hr), "Failed to create vertex shader, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateVertexShader(device, decl_color_ubyte, color_color_shader_code, &color_ubyte_shader, 0);
    ok(SUCCEEDED(hr), "Failed to create vertex shader, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateVertexShader(device, decl_color_color, color_color_shader_code, &color_color_shader, 0);
    ok(SUCCEEDED(hr), "Failed to create vertex shader, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateVertexShader(device, decl_color_float, color_color_shader_code, &color_float_shader, 0);
    ok(SUCCEEDED(hr), "Failed to create vertex shader, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateVertexShader(device, decl_nocolor, color_color_shader_code, &color_nocolor_shader, 0);
    todo_wine ok(hr == D3DERR_INVALIDCALL, "Unexpected error while creating vertex shader, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0xffff0000, 1.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetVertexShader(device, swapped_twotexcrd_shader);
    ok(SUCCEEDED(hr), "Failed to set vertex shader, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad1, sizeof(float) * 11);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetVertexShader(device, swapped_twotexcrd_rightorder_shader);
    ok(SUCCEEDED(hr), "Failed to set vertex shader, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad4, sizeof(float) * 11);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

    color = getPixelColor(device, 160, 360);
    ok(color_match(color, 0x00ffff80, 1), "Got unexpected color 0x%08x for quad 1 (2crd).\n", color);
    color = getPixelColor(device, 480, 160);
    ok(color == 0x00000000, "Got unexpected color 0x%08x for quad 4 (2crd-rightorder).\n", color);

    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0xff0000ff, 1.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetVertexShader(device, texcoord_color_shader);
    ok(SUCCEEDED(hr), "Failed to set vertex shader, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad1_color, sizeof(quad1_color[0]));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetVertexShader(device, color_ubyte_shader);
    ok(SUCCEEDED(hr), "Failed to set vertex shader, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetVertexShaderConstant(device, 0, normalize, 1);
    ok(SUCCEEDED(hr), "Failed to set vertex shader constant, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad2_color, sizeof(quad2_color[0]));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetVertexShaderConstant(device, 0, no_normalize, 1);
    ok(SUCCEEDED(hr), "Failed to set vertex shader constant, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetVertexShader(device, color_color_shader);
    ok(SUCCEEDED(hr), "Failed to set vertex shader, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad3_color, sizeof(quad3_color[0]));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetVertexShader(device, color_float_shader);
    ok(SUCCEEDED(hr), "Failed to set vertex shader, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad4_color, sizeof(float) * 7);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

    IDirect3DDevice8_SetVertexShader(device, 0);

    color = getPixelColor(device, 160, 360);
    ok(color_match(color, D3DCOLOR_ARGB(0x00, 0xff, 0x80, 0x40), 1),
            "Input test: Quad 1(color-texcoord) returned color 0x%08x, expected 0x00ff8040\n", color);
    color = getPixelColor(device, 480, 360);
    ok(color_match(color, D3DCOLOR_ARGB(0x00, 0x40, 0x80, 0xff), 1),
            "Input test: Quad 2(color-ubyte) returned color 0x%08x, expected 0x004080ff\n", color);
    color = getPixelColor(device, 160, 120);
    ok(color_match(color, D3DCOLOR_ARGB(0x00, 0xff, 0x80, 0x40), 1),
            "Input test: Quad 3(color-color) returned color 0x%08x, expected 0x00ff8040\n", color);
    color = getPixelColor(device, 480, 160);
    ok(color_match(color, D3DCOLOR_ARGB(0x00, 0xff, 0xff, 0x00), 1),
            "Input test: Quad 4(color-float) returned color 0x%08x, expected 0x00ffff00\n", color);

    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    IDirect3DDevice8_DeleteVertexShader(device, swapped_twotexcrd_shader);
    IDirect3DDevice8_DeleteVertexShader(device, swapped_onetexcrd_shader);
    IDirect3DDevice8_DeleteVertexShader(device, swapped_twotex_wrongidx_shader);
    IDirect3DDevice8_DeleteVertexShader(device, swapped_twotexcrd_rightorder_shader);
    IDirect3DDevice8_DeleteVertexShader(device, texcoord_color_shader);
    IDirect3DDevice8_DeleteVertexShader(device, color_ubyte_shader);
    IDirect3DDevice8_DeleteVertexShader(device, color_color_shader);
    IDirect3DDevice8_DeleteVertexShader(device, color_float_shader);
    IDirect3DDevice8_DeleteVertexShader(device, color_nocolor_shader);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_fixed_function_fvf(void)
{
    IDirect3DDevice8 *device;
    unsigned int color;
    IDirect3D8 *d3d;
    ULONG refcount;
    D3DCAPS8 caps;
    HWND window;
    HRESULT hr;

    static const struct
    {
        struct vec3 position;
        DWORD diffuse;
    }
    quad1[] =
    {
        {{-1.0f, -1.0f, 0.1f}, 0x00ffff00},
        {{-1.0f,  0.0f, 0.1f}, 0x00ffff00},
        {{ 0.0f, -1.0f, 0.1f}, 0x00ffff00},
        {{ 0.0f,  0.0f, 0.1f}, 0x00ffff00},
    };
    static const struct vec3 quad2[] =
    {
        {-1.0f, -1.0f, 0.1f},
        {-1.0f,  0.0f, 0.1f},
        { 0.0f, -1.0f, 0.1f},
        { 0.0f,  0.0f, 0.1f},
    };
    static const struct
    {
        struct vec4 position;
        DWORD diffuse;
    }
    quad_transformed[] =
    {
        {{ 90.0f, 110.0f, 0.1f, 2.0f}, 0x00ffff00},
        {{570.0f, 110.0f, 0.1f, 2.0f}, 0x00ffff00},
        {{ 90.0f, 300.0f, 0.1f, 2.0f}, 0x00ffff00},
        {{570.0f, 300.0f, 0.1f, 2.0f}, 0x00ffff00},
    };

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    memset(&caps, 0, sizeof(caps));
    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get device caps, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0xffffffff, 1.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable lighting, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_DIFFUSE);
    ok(SUCCEEDED(hr), "Failed to set FVF, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad1, sizeof(quad1[0]));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

    color = getPixelColor(device, 160, 360);
    ok(color == 0x00ffff00,
            "D3DDECLTYPE_D3DCOLOR returned color %08x, expected 0x00ffff00\n", color);
    IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);

    /* Test with no diffuse color attribute. */
    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xff0000ff, 0.0, 0);
    ok(SUCCEEDED(hr), "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ);
    ok(SUCCEEDED(hr), "Failed to set FVF, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, &quad2, sizeof(quad2[0]));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

    color = getPixelColor(device, 160, 360);
    ok(color == 0x00ffffff, "Got unexpected color 0x%08x in the no diffuse attribute test.\n", color);
    IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);

    /* Test what happens with specular lighting enabled and no specular color attribute. */
    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0xffffffff, 1.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_SPECULARENABLE, TRUE);
    ok(SUCCEEDED(hr), "Failed to enable specular lighting, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_DIFFUSE);
    ok(SUCCEEDED(hr), "Failed to set FVF, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, &quad1, sizeof(quad1[0]));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_SPECULARENABLE, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable specular lighting, hr %#lx.\n", hr);

    color = getPixelColor(device, 160, 360);
    ok(color == 0x00ffff00, "Got unexpected color 0x%08x in the no specular attribute test.\n", color);

    IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);

    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZRHW | D3DFVF_DIFFUSE);
    ok(SUCCEEDED(hr), "Failed to set FVF, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xff0000ff, 0.0, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, &quad_transformed, sizeof(quad_transformed[0]));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

    color = getPixelColor(device, 88, 108);
    ok(color == 0x000000ff,
            "pixel 88/108 has color %08x, expected 0x000000ff\n", color);
    color = getPixelColor(device, 92, 108);
    ok(color == 0x000000ff,
            "pixel 92/108 has color %08x, expected 0x000000ff\n", color);
    color = getPixelColor(device, 88, 112);
    ok(color == 0x000000ff,
            "pixel 88/112 has color %08x, expected 0x000000ff\n", color);
    color = getPixelColor(device, 92, 112);
    ok(color == 0x00ffff00,
            "pixel 92/112 has color %08x, expected 0x00ffff00\n", color);

    color = getPixelColor(device, 568, 108);
    ok(color == 0x000000ff,
            "pixel 568/108 has color %08x, expected 0x000000ff\n", color);
    color = getPixelColor(device, 572, 108);
    ok(color == 0x000000ff,
            "pixel 572/108 has color %08x, expected 0x000000ff\n", color);
    color = getPixelColor(device, 568, 112);
    ok(color == 0x00ffff00,
            "pixel 568/112 has color %08x, expected 0x00ffff00\n", color);
    color = getPixelColor(device, 572, 112);
    ok(color == 0x000000ff,
            "pixel 572/112 has color %08x, expected 0x000000ff\n", color);

    color = getPixelColor(device, 88, 298);
    ok(color == 0x000000ff,
            "pixel 88/298 has color %08x, expected 0x000000ff\n", color);
    color = getPixelColor(device, 92, 298);
    ok(color == 0x00ffff00,
            "pixel 92/298 has color %08x, expected 0x00ffff00\n", color);
    color = getPixelColor(device, 88, 302);
    ok(color == 0x000000ff,
            "pixel 88/302 has color %08x, expected 0x000000ff\n", color);
    color = getPixelColor(device, 92, 302);
    ok(color == 0x000000ff,
            "pixel 92/302 has color %08x, expected 0x000000ff\n", color);

    color = getPixelColor(device, 568, 298);
    ok(color == 0x00ffff00,
            "pixel 568/298 has color %08x, expected 0x00ffff00\n", color);
    color = getPixelColor(device, 572, 298);
    ok(color == 0x000000ff,
            "pixel 572/298 has color %08x, expected 0x000000ff\n", color);
    color = getPixelColor(device, 568, 302);
    ok(color == 0x000000ff,
            "pixel 568/302 has color %08x, expected 0x000000ff\n", color);
    color = getPixelColor(device, 572, 302);
    ok(color == 0x000000ff,
            "pixel 572/302 has color %08x, expected 0x000000ff\n", color);

    IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_flip(void)
{
    IDirect3DDevice8 *device;
    unsigned int color, i;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;
    IDirect3DSurface8 *back_buffers[3], *test_surface;
    D3DPRESENT_PARAMETERS present_parameters = {0};

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");

    present_parameters.BackBufferWidth = 640;
    present_parameters.BackBufferHeight = 480;
    present_parameters.BackBufferFormat = D3DFMT_A8R8G8B8;
    present_parameters.SwapEffect = D3DSWAPEFFECT_DISCARD;
    present_parameters.hDeviceWindow = window;
    present_parameters.Windowed = TRUE;
    present_parameters.BackBufferCount = 3;
    present_parameters.Flags = D3DPRESENTFLAG_LOCKABLE_BACKBUFFER;
    if (FAILED(hr = IDirect3D8_CreateDevice(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            window, D3DCREATE_SOFTWARE_VERTEXPROCESSING, &present_parameters, &device)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    for (i = 0; i < ARRAY_SIZE(back_buffers); ++i)
    {
        hr = IDirect3DDevice8_GetBackBuffer(device, i, D3DBACKBUFFER_TYPE_MONO, &back_buffers[i]);
        ok(SUCCEEDED(hr), "Failed to get back buffer, hr %#lx.\n", hr);
    }
    hr = IDirect3DDevice8_GetRenderTarget(device, &test_surface);
    ok(SUCCEEDED(hr), "Failed to get render target, hr %#lx.\n", hr);
    ok(test_surface == back_buffers[0], "Expected render target %p, got %p.\n", back_buffers[0], test_surface);
    IDirect3DSurface8_Release(test_surface);


    hr = IDirect3DDevice8_SetRenderTarget(device, back_buffers[0], NULL);
    ok(SUCCEEDED(hr), "Failed to set render target, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xffff0000, 0.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx\n", hr);

    hr = IDirect3DDevice8_SetRenderTarget(device, back_buffers[1], NULL);
    ok(SUCCEEDED(hr), "Failed to set render target, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xff00ff00, 0.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx\n", hr);

    hr = IDirect3DDevice8_SetRenderTarget(device, back_buffers[2], NULL);
    ok(SUCCEEDED(hr), "Failed to set render target, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xff0000ff, 0.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx\n", hr);

    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    /* Render target is unmodified. */
    hr = IDirect3DDevice8_GetRenderTarget(device, &test_surface);
    ok(SUCCEEDED(hr), "Failed to get render target, hr %#lx.\n", hr);
    ok(test_surface == back_buffers[2], "Expected render target %p, got %p.\n", back_buffers[2], test_surface);
    IDirect3DSurface8_Release(test_surface);

    /* Backbuffer surface pointers are unmodified */
    for (i = 0; i < ARRAY_SIZE(back_buffers); ++i)
    {
        hr = IDirect3DDevice8_GetBackBuffer(device, i, D3DBACKBUFFER_TYPE_MONO, &test_surface);
        ok(SUCCEEDED(hr), "Failed to get back buffer, hr %#lx.\n", hr);
        ok(test_surface == back_buffers[i], "Expected back buffer %u = %p, got %p.\n",
                i, back_buffers[i], test_surface);
        IDirect3DSurface8_Release(test_surface);
    }

    /* Contents were changed. */
    color = get_surface_color(back_buffers[0], 1, 1);
    ok(color == 0xff00ff00, "Got unexpected color 0x%08x.\n", color);
    color = get_surface_color(back_buffers[1], 1, 1);
    ok(color == 0xff0000ff, "Got unexpected color 0x%08x.\n", color);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xff808080, 0.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx\n", hr);

    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    color = get_surface_color(back_buffers[0], 1, 1);
    ok(color == 0xff0000ff, "Got unexpected color 0x%08x.\n", color);
    color = get_surface_color(back_buffers[1], 1, 1);
    ok(color == 0xff808080, "Got unexpected color 0x%08x.\n", color);

    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    color = get_surface_color(back_buffers[0], 1, 1);
    ok(color == 0xff808080, "Got unexpected color 0x%08x.\n", color);

    for (i = 0; i < ARRAY_SIZE(back_buffers); ++i)
        IDirect3DSurface8_Release(back_buffers[i]);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);

    if (FAILED(IDirect3D8_CheckDeviceMultiSampleType(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            D3DFMT_A8R8G8B8, TRUE, D3DMULTISAMPLE_2_SAMPLES)))
    {
        skip("Multisampling not supported for D3DFMT_A8R8G8B8, skipping multisample flip test.\n");
        goto done;
    }

    present_parameters.BackBufferCount = 2;
    present_parameters.MultiSampleType = D3DMULTISAMPLE_2_SAMPLES;
    present_parameters.Flags = 0;
    hr = IDirect3D8_CreateDevice(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            window, D3DCREATE_SOFTWARE_VERTEXPROCESSING, &present_parameters, &device);

    for (i = 0; i < present_parameters.BackBufferCount; ++i)
    {
        hr = IDirect3DDevice8_GetBackBuffer(device, i, D3DBACKBUFFER_TYPE_MONO, &back_buffers[i]);
        ok(SUCCEEDED(hr), "Failed to get back buffer, hr %#lx.\n", hr);
    }

    hr = IDirect3DDevice8_SetRenderTarget(device, back_buffers[1], NULL);
    ok(SUCCEEDED(hr), "Failed to set render target, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xff808080, 0.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CreateRenderTarget(device, 640, 480, D3DFMT_A8R8G8B8,
            D3DMULTISAMPLE_NONE, TRUE, &test_surface);
    ok(SUCCEEDED(hr), "Failed to create surface, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CopyRects(device, back_buffers[0], NULL, 0, test_surface, NULL);
    ok(SUCCEEDED(hr), "CopyRects failed, hr %#lx.\n", hr);

    color = get_surface_color(test_surface, 1, 1);
    ok(color == 0xff808080, "Got unexpected color 0x%08x.\n", color);

    IDirect3DSurface8_Release(test_surface);
    for (i = 0; i < present_parameters.BackBufferCount; ++i)
        IDirect3DSurface8_Release(back_buffers[i]);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);

done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_uninitialized_varyings(void)
{
    static const D3DMATRIX mat =
    {{{
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f,
    }}};
    static const struct vec3 quad[] =
    {
        {-1.0f, -1.0f, 0.1f},
        {-1.0f,  1.0f, 0.1f},
        { 1.0f, -1.0f, 0.1f},
        { 1.0f,  1.0f, 0.1f},
    };
    static const DWORD decl[] =
    {
        D3DVSD_STREAM(0),
        D3DVSD_REG(0, D3DVSDT_FLOAT3),
        D3DVSD_CONST(0, 1), 0x3f000000, 0x3f000000, 0x3f000000, 0x3f000000,     /* def c0, 0.5, 0.5, 0.5, 0.5 */
        D3DVSD_END()
    };
    static const DWORD vs1_code[] =
    {
        0xfffe0101,                                                             /* vs_1_1                         */
        0x00000001, 0xc00f0000, 0x90e40000,                                     /* mov oPos, v0                   */
        0x0000ffff
    };
    static const DWORD vs1_partial_code[] =
    {
        0xfffe0101,                                                             /* vs_1_1                         */
        0x00000001, 0xc00f0000, 0x90e40000,                                     /* mov oPos, v0                   */
        0x00000001, 0xd0010000, 0xa0e40000,                                     /* mov oD0.x, c0                  */
        0x00000001, 0xd0010001, 0xa0e40000,                                     /* mov oD1.x, c0                  */
        0x00000001, 0xe0010000, 0xa0e40000,                                     /* mov oT0.x, c0                  */
        0x0000ffff
    };
    static const DWORD ps1_diffuse_code[] =
    {
        0xffff0101,                                                             /* ps_1_1                         */
        0x00000001, 0x800f0000, 0x90e40000,                                     /* mov r0, v0                     */
        0x0000ffff
    };
    static const DWORD ps1_specular_code[] =
    {
        0xffff0101,                                                             /* ps_1_1                         */
        0x00000001, 0x800f0000, 0x90e40001,                                     /* mov r0, v1                     */
        0x0000ffff
    };
    static const DWORD ps1_texcoord_code[] =
    {
        0xffff0101,                                                             /* ps_1_1                         */
        0x00000040, 0xb00f0000,                                                 /* texcoord t0                    */
        0x00000001, 0x800f0000, 0xb0e40000,                                     /* mov r0, t0                     */
        0x0000ffff
    };
    static const struct
    {
        DWORD vs_version;
        const DWORD *vs;
        DWORD ps_version;
        const DWORD *ps;
        D3DCOLOR expected;
        BOOL allow_zero_alpha;
        BOOL partial;
        BOOL broken_warp;
    }
    /* On AMD specular color is generally initialized to 0x00000000 and texcoords to 0xff000000
     * while on Nvidia it's the opposite. Just allow both.
     *
     * Partially initialized varyings reliably handle the component that has been initialized.
     * The uninitialized components generally follow the rule above, with some exceptions on
     * radeon cards. r500 and r600 GPUs have been found to set uninitialized components to 0.0,
     * 0.5 and 1.0 without a sensible pattern. */
    tests[] =
    {
        {D3DVS_VERSION(1, 1),         vs1_code,                   0,              NULL, 0xffffffff},
        {                  0,             NULL, D3DPS_VERSION(1, 1), ps1_texcoord_code, 0xff000000, TRUE},
        {D3DVS_VERSION(1, 1),         vs1_code, D3DPS_VERSION(1, 1),  ps1_diffuse_code, 0xffffffff},
        {D3DVS_VERSION(1, 1),         vs1_code, D3DPS_VERSION(1, 1), ps1_specular_code, 0xff000000, TRUE,  FALSE, TRUE},
        {D3DVS_VERSION(1, 1),         vs1_code, D3DPS_VERSION(1, 1), ps1_texcoord_code, 0xff000000, TRUE},
        {D3DVS_VERSION(1, 1), vs1_partial_code,                   0,              NULL, 0xff7fffff, FALSE, TRUE},
        {D3DVS_VERSION(1, 1), vs1_partial_code, D3DPS_VERSION(1, 1),  ps1_diffuse_code, 0xff7fffff, FALSE, TRUE},
        {D3DVS_VERSION(1, 1), vs1_partial_code, D3DPS_VERSION(1, 1), ps1_specular_code, 0xff7f0000, TRUE,  TRUE},
        {D3DVS_VERSION(1, 1), vs1_partial_code, D3DPS_VERSION(1, 1), ps1_texcoord_code, 0xff7f0000, TRUE,  TRUE},
    };
    IDirect3DDevice8 *device;
    unsigned int color, i;
    IDirect3D8 *d3d;
    HWND window;
    HRESULT hr;
    DWORD vs, ps;
    ULONG refcount;
    D3DCAPS8 caps;
    IDirect3DSurface8 *backbuffer;
    D3DADAPTER_IDENTIFIER8 identifier;
    struct surface_readback rb;
    BOOL warp;

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3D8_GetAdapterIdentifier(d3d, D3DADAPTER_DEFAULT, 0, &identifier);
    ok(SUCCEEDED(hr), "Failed to get adapter identifier, hr %#lx.\n", hr);
    warp = adapter_is_warp(&identifier);

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get caps, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetBackBuffer(device, 0, D3DBACKBUFFER_TYPE_MONO, &backbuffer);
    ok(SUCCEEDED(hr), "Failed to get back buffer, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTransform(device, D3DTS_WORLD, &mat);
    ok(SUCCEEDED(hr), "Failed to set world transform, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTransform(device, D3DTS_VIEW, &mat);
    ok(SUCCEEDED(hr), "Failed to set view transform, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTransform(device, D3DTS_PROJECTION, &mat);
    ok(SUCCEEDED(hr), "Failed to set projection transform, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_CLIPPING, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable clipping, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZENABLE, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable Z test, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGENABLE, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable fog, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_STENCILENABLE, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable stencil test, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_CULLMODE, D3DCULL_NONE);
    ok(SUCCEEDED(hr), "Failed to disable culling, hr %#lx.\n", hr);

    for (i = 0; i < ARRAY_SIZE(tests); ++i)
    {
        if (caps.VertexShaderVersion < tests[i].vs_version
                || caps.PixelShaderVersion < tests[i].ps_version)
        {
            skip("Vertex / pixel shader version not supported, skipping test %u.\n", i);
            continue;
        }
        if (tests[i].vs)
        {
            hr = IDirect3DDevice8_CreateVertexShader(device, decl, tests[i].vs, &vs, 0);
            ok(SUCCEEDED(hr), "Failed to create vertex shader, hr %#lx (case %u).\n", hr, i);
            hr = IDirect3DDevice8_SetVertexShader(device, vs);
            ok(SUCCEEDED(hr), "Failed to set vertex shader, hr %#lx.\n", hr);
        }
        else
        {
            vs = 0;
            hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ);
            ok(SUCCEEDED(hr), "Failed to set vertex shader, hr %#lx.\n", hr);
        }
        if (tests[i].ps)
        {
            hr = IDirect3DDevice8_CreatePixelShader(device, tests[i].ps, &ps);
            ok(SUCCEEDED(hr), "Failed to create pixel shader, hr %#lx (case %u).\n", hr, i);
        }
        else
        {
            ps = 0;
        }

        hr = IDirect3DDevice8_SetPixelShader(device, ps);
        ok(SUCCEEDED(hr), "Failed to set pixel shader, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xff00ff00, 0.0f, 0);
        ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_BeginScene(device);
        ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(quad[0]));
        ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_EndScene(device);
        ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

        get_surface_readback(backbuffer, &rb);
        color = get_readback_color(&rb, 320, 240);
        ok(color_match(color, tests[i].expected, 1)
                || (tests[i].allow_zero_alpha && color_match(color, tests[i].expected & 0x00ffffff, 1))
                || (broken(warp && tests[i].broken_warp))
                || broken(tests[i].partial && color_match(color & 0x00ff0000, tests[i].expected & 0x00ff0000, 1)),
                "Got unexpected color 0x%08x, case %u.\n", color, i);
        release_surface_readback(&rb);

        if (vs)
            IDirect3DDevice8_DeleteVertexShader(device, vs);
        if (ps)
            IDirect3DDevice8_DeletePixelShader(device, ps);
    }

    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    IDirect3DSurface8_Release(backbuffer);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_shademode(void)
{
    IDirect3DVertexBuffer8 *vb_strip;
    IDirect3DVertexBuffer8 *vb_list;
    unsigned int color0, color1;
    IDirect3DDevice8 *device;
    BYTE *data = NULL;
    IDirect3D8 *d3d;
    ULONG refcount;
    D3DCAPS8 caps;
    DWORD vs, ps;
    HWND window;
    HRESULT hr;
    UINT i;
    static const DWORD decl[] =
    {
        D3DVSD_STREAM(0),
        D3DVSD_REG(D3DVSDE_POSITION, D3DVSDT_FLOAT3),
        D3DVSD_REG(D3DVSDE_DIFFUSE, D3DVSDT_D3DCOLOR),
        D3DVSD_END()
    };
    static const DWORD vs1_code[] =
    {
        0xfffe0101,                                                             /* vs_1_1          */
        0x00000001, 0xc00f0000, 0x90e40000,                                     /* mov oPos, v0    */
        0x00000001, 0xd00f0000, 0x90e40005,                                     /* mov oD0, v5     */
        0x0000ffff
    };
    static const DWORD ps1_code[] =
    {
        0xffff0101,                                                             /* ps_1_1          */
        0x00000001, 0x800f0000, 0x90e40000,                                     /* mov r0, v0      */
        0x0000ffff
    };
    static const struct
    {
        struct vec3 position;
        DWORD diffuse;
    }
    quad_strip[] =
    {
        {{-1.0f, -1.0f, 0.0f}, 0xffff0000},
        {{-1.0f,  1.0f, 0.0f}, 0xff00ff00},
        {{ 1.0f, -1.0f, 0.0f}, 0xff0000ff},
        {{ 1.0f,  1.0f, 0.0f}, 0xffffffff},
    },
    quad_list[] =
    {
        {{-1.0f, -1.0f, 0.0f}, 0xffff0000},
        {{-1.0f,  1.0f, 0.0f}, 0xff00ff00},
        {{ 1.0f, -1.0f, 0.0f}, 0xff0000ff},

        {{ 1.0f, -1.0f, 0.0f}, 0xff0000ff},
        {{-1.0f,  1.0f, 0.0f}, 0xff00ff00},
        {{ 1.0f,  1.0f, 0.0f}, 0xffffffff},
    };
    static const struct test_shader
    {
        DWORD version;
        const DWORD *code;
    }
    novs = {0, NULL},
    vs_1 = {D3DVS_VERSION(1, 1), vs1_code},
    nops = {0, NULL},
    ps_1 = {D3DPS_VERSION(1, 1), ps1_code};
    static const struct
    {
        const struct test_shader *vs, *ps;
        DWORD primtype;
        DWORD shademode;
        unsigned int color0, color1;
    }
    tests[] =
    {
        {&novs, &nops, D3DPT_TRIANGLESTRIP, D3DSHADE_FLAT,    0x00ff0000, 0x0000ff00},
        {&novs, &nops, D3DPT_TRIANGLESTRIP, D3DSHADE_PHONG,   0x000dca28, 0x000d45c7},
        {&novs, &nops, D3DPT_TRIANGLESTRIP, D3DSHADE_GOURAUD, 0x000dca28, 0x000d45c7},
        {&novs, &nops, D3DPT_TRIANGLESTRIP, D3DSHADE_PHONG,   0x000dca28, 0x000d45c7},
        {&novs, &nops, D3DPT_TRIANGLELIST,  D3DSHADE_FLAT,    0x00ff0000, 0x000000ff},
        {&novs, &nops, D3DPT_TRIANGLELIST,  D3DSHADE_GOURAUD, 0x000dca28, 0x000d45c7},
        {&vs_1, &ps_1, D3DPT_TRIANGLESTRIP, D3DSHADE_FLAT,    0x00ff0000, 0x0000ff00},
        {&vs_1, &ps_1, D3DPT_TRIANGLESTRIP, D3DSHADE_GOURAUD, 0x000dca28, 0x000d45c7},
        {&vs_1, &ps_1, D3DPT_TRIANGLELIST,  D3DSHADE_FLAT,    0x00ff0000, 0x000000ff},
        {&vs_1, &ps_1, D3DPT_TRIANGLELIST,  D3DSHADE_GOURAUD, 0x000dca28, 0x000d45c7},
        {&novs, &ps_1, D3DPT_TRIANGLESTRIP, D3DSHADE_FLAT,    0x00ff0000, 0x0000ff00},
        {&vs_1, &nops, D3DPT_TRIANGLESTRIP, D3DSHADE_FLAT,    0x00ff0000, 0x0000ff00},
    };

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(hr == D3D_OK, "Failed to disable lighting, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGENABLE, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable fog, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CreateVertexBuffer(device, sizeof(quad_strip), 0, 0, D3DPOOL_MANAGED, &vb_strip);
    ok(hr == D3D_OK, "Failed to create vertex buffer, hr %#lx.\n", hr);
    hr = IDirect3DVertexBuffer8_Lock(vb_strip, 0, sizeof(quad_strip), &data, 0);
    ok(hr == D3D_OK, "Failed to lock vertex buffer, hr %#lx.\n", hr);
    memcpy(data, quad_strip, sizeof(quad_strip));
    hr = IDirect3DVertexBuffer8_Unlock(vb_strip);
    ok(hr == D3D_OK, "Failed to unlock vertex buffer, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CreateVertexBuffer(device, sizeof(quad_list), 0, 0, D3DPOOL_MANAGED, &vb_list);
    ok(hr == D3D_OK, "Failed to create vertex buffer, hr %#lx.\n", hr);
    hr = IDirect3DVertexBuffer8_Lock(vb_list, 0, sizeof(quad_list), &data, 0);
    ok(hr == D3D_OK, "Failed to lock vertex buffer, hr %#lx.\n", hr);
    memcpy(data, quad_list, sizeof(quad_list));
    hr = IDirect3DVertexBuffer8_Unlock(vb_list);
    ok(hr == D3D_OK, "Failed to unlock vertex buffer, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get device caps, hr %#lx.\n", hr);

    /* Try it first with a TRIANGLESTRIP.  Do it with different geometry because
     * the color fixups we have to do for FLAT shading will be dependent on that. */

    for (i = 0; i < ARRAY_SIZE(tests); ++i)
    {
        if (tests[i].vs->version)
        {
            if (caps.VertexShaderVersion >= tests[i].vs->version)
            {
                hr = IDirect3DDevice8_CreateVertexShader(device, decl, tests[i].vs->code, &vs, 0);
                ok(hr == D3D_OK, "Failed to create vertex shader, hr %#lx.\n", hr);
                hr = IDirect3DDevice8_SetVertexShader(device, vs);
                ok(hr == D3D_OK, "Failed to set vertex shader, hr %#lx.\n", hr);
            }
            else
            {
                skip("Shader version unsupported, skipping some tests.\n");
                continue;
            }
        }
        else
        {
            vs = 0;
            hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_DIFFUSE);
            ok(hr == D3D_OK, "Failed to set FVF, hr %#lx.\n", hr);
        }
        if (tests[i].ps->version)
        {
            if (caps.PixelShaderVersion >= tests[i].ps->version)
            {
                hr = IDirect3DDevice8_CreatePixelShader(device, tests[i].ps->code, &ps);
                ok(hr == D3D_OK, "Failed to create pixel shader, hr %#lx.\n", hr);
                hr = IDirect3DDevice8_SetPixelShader(device, ps);
                ok(hr == D3D_OK, "Failed to set pixel shader, hr %#lx.\n", hr);
            }
            else
            {
                skip("Shader version unsupported, skipping some tests.\n");
                if (vs)
                {
                    IDirect3DDevice8_SetVertexShader(device, 0);
                    IDirect3DDevice8_DeleteVertexShader(device, vs);
                }
                continue;
            }
        }
        else
        {
            ps = 0;
        }

        hr = IDirect3DDevice8_SetStreamSource(device, 0,
                tests[i].primtype == D3DPT_TRIANGLESTRIP ? vb_strip : vb_list, sizeof(quad_strip[0]));
        ok(hr == D3D_OK, "Failed to set stream source, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xffffffff, 0.0f, 0);
        ok(hr == D3D_OK, "Failed to clear, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_SetRenderState(device, D3DRS_SHADEMODE, tests[i].shademode);
        ok(hr == D3D_OK, "Failed to set shade mode, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_BeginScene(device);
        ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_DrawPrimitive(device, tests[i].primtype, 0, 2);
        ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_EndScene(device);
        ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

        color0 = getPixelColor(device, 100, 100); /* Inside first triangle */
        color1 = getPixelColor(device, 500, 350); /* Inside second triangle */

        /* For D3DSHADE_FLAT it should take the color of the first vertex of
         * each triangle. This requires EXT_provoking_vertex or similar
         * functionality being available. */
        /* PHONG should be the same as GOURAUD, since no hardware implements
         * this. */
        ok(color_match(color0, tests[i].color0, 1), "Test %u shading has color0 %08x, expected %08x.\n",
                i, color0, tests[i].color0);
        ok(color_match(color1, tests[i].color1, 1), "Test %u shading has color1 %08x, expected %08x.\n",
                i, color1, tests[i].color1);

        IDirect3DDevice8_SetVertexShader(device, 0);
        IDirect3DDevice8_SetPixelShader(device, 0);

        if (ps)
            IDirect3DDevice8_DeletePixelShader(device, ps);
        if (vs)
            IDirect3DDevice8_DeleteVertexShader(device, vs);
    }

    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(hr == D3D_OK, "Failed to present, hr %#lx.\n", hr);

    IDirect3DVertexBuffer8_Release(vb_strip);
    IDirect3DVertexBuffer8_Release(vb_list);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_multisample_init(void)
{
    IDirect3DDevice8 *device;
    unsigned int color, x, y;
    IDirect3D8 *d3d;
    IDirect3DSurface8 *back, *multi;
    ULONG refcount;
    HWND window;
    HRESULT hr;
    struct surface_readback rb;
    BOOL all_zero = TRUE;

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");

    if (FAILED(IDirect3D8_CheckDeviceMultiSampleType(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            D3DFMT_A8R8G8B8, TRUE, D3DMULTISAMPLE_2_SAMPLES)))
    {
        skip("Multisampling not supported for D3DFMT_A8R8G8B8, skipping multisample init test.\n");
        goto done;
    }

    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    hr = IDirect3DDevice8_GetBackBuffer(device, 0, D3DBACKBUFFER_TYPE_MONO, &back);
    ok(SUCCEEDED(hr), "Failed to get back buffer, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateRenderTarget(device, 640, 480, D3DFMT_A8R8G8B8,
            D3DMULTISAMPLE_2_SAMPLES, FALSE, &multi);
    ok(SUCCEEDED(hr), "Failed to create multisampled render target, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CopyRects(device, multi, NULL, 0, back, NULL);
    ok(SUCCEEDED(hr), "CopyRects failed, hr %#lx.\n", hr);

    get_surface_readback(back, &rb);
    for (y = 0; y < 480; ++y)
    {
        for (x = 0; x < 640; ++x)
        {
            color = get_readback_color(&rb, x, y);
            if (!color_match(color, 0x00000000, 0))
            {
                all_zero = FALSE;
                break;
            }
        }
        if (!all_zero)
            break;
    }
    release_surface_readback(&rb);
    ok(all_zero, "Got unexpected color 0x%08x, position %ux%u.\n", color, x, y);

    IDirect3DSurface8_Release(multi);
    IDirect3DSurface8_Release(back);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);

done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_texture_blending(void)
{
#define STATE_END()  {0xffffffff, 0xffffffff}
#define IS_STATE_END(s) (s.name == 0xffffffff && s.value == 0xffffffff)

    IDirect3DTexture8 *texture_bumpmap, *texture_red;
    IDirect3DSurface8 *backbuffer;
    unsigned int color, i, j, k;
    struct surface_readback rb;
    D3DLOCKED_RECT locked_rect;
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d;
    ULONG refcount;
    D3DCAPS8 caps;
    HWND window;
    HRESULT hr;

    static const struct
    {
        struct vec3 position;
        DWORD diffuse;
    }
    quad[] =
    {
        {{-1.0f, -1.0f, 0.1f}, D3DCOLOR_ARGB(0x80, 0xff, 0xff, 0x02)},
        {{-1.0f,  1.0f, 0.1f}, D3DCOLOR_ARGB(0x80, 0xff, 0xff, 0x02)},
        {{ 1.0f, -1.0f, 0.1f}, D3DCOLOR_ARGB(0x80, 0xff, 0xff, 0x02)},
        {{ 1.0f,  1.0f, 0.1f}, D3DCOLOR_ARGB(0x80, 0xff, 0xff, 0x02)},
    };

    static const float bumpenvmat[4] = {1.0f, 1.0f, 0.0f, 0.0f};

    struct texture_stage_state
    {
        D3DTEXTURESTAGESTATETYPE name;
        DWORD value;
    };

    struct texture_stage
    {
        enum
        {
            TEXTURE_INVALID,
            TEXTURE_NONE,
            TEXTURE_BUMPMAP,
            TEXTURE_RED,
        }
        texture;
        struct texture_stage_state state[20];
    };

    static const struct texture_stage default_stage_state =
    {
        TEXTURE_NONE,
        {
            {D3DTSS_COLOROP,               D3DTOP_DISABLE},
            {D3DTSS_COLORARG1,             D3DTA_TEXTURE},
            {D3DTSS_COLORARG2,             D3DTA_CURRENT},
            {D3DTSS_ALPHAOP,               D3DTOP_DISABLE},
            {D3DTSS_ALPHAARG1,             D3DTA_TEXTURE},
            {D3DTSS_ALPHAARG2,             D3DTA_CURRENT},
            {D3DTSS_BUMPENVMAT00,          0},
            {D3DTSS_BUMPENVMAT01,          0},
            {D3DTSS_BUMPENVMAT10,          0},
            {D3DTSS_BUMPENVMAT11,          0},
            {D3DTSS_BUMPENVLSCALE,         0},
            {D3DTSS_BUMPENVLOFFSET,        0},
            {D3DTSS_TEXTURETRANSFORMFLAGS, D3DTTFF_DISABLE},
            {D3DTSS_COLORARG0,             D3DTA_CURRENT},
            {D3DTSS_ALPHAARG0,             D3DTA_CURRENT},
            {D3DTSS_RESULTARG,             D3DTA_CURRENT},
            STATE_END(),
        },
    };

    const struct test
    {
        DWORD tex_op_caps;
        unsigned int expected_color;
        struct texture_stage stage[8];
    }
    tests[] =
    {
        {
            D3DTEXOPCAPS_DISABLE,
            0x80ffff02,
            {
                {
                    TEXTURE_NONE,
                    {
                        STATE_END(),
                    },
                },
            },
        },
        {
            D3DTEXOPCAPS_DISABLE | D3DTEXOPCAPS_SELECTARG1,
            0x80ffff02,
            {
                {
                    TEXTURE_NONE,
                    {
                        {D3DTSS_COLOROP,   D3DTOP_SELECTARG1},
                        {D3DTSS_COLORARG1, D3DTA_CURRENT},
                        STATE_END(),
                    },
                },
                {TEXTURE_INVALID}
            },
        },
        {
            D3DTEXOPCAPS_DISABLE | D3DTEXOPCAPS_SELECTARG1,
            0x80ffff02,
            {
                {
                    TEXTURE_NONE,
                    {
                        {D3DTSS_COLOROP,   D3DTOP_SELECTARG1},
                        {D3DTSS_COLORARG1, D3DTA_CURRENT},
                        {D3DTSS_ALPHAOP,   D3DTOP_SELECTARG1},
                        {D3DTSS_ALPHAARG1, D3DTA_CURRENT},
                        STATE_END(),
                    },
                },
            },
        },
        {
            D3DTEXOPCAPS_DISABLE | D3DTEXOPCAPS_SELECTARG1,
            0x80ffff02,
            {
                {
                    TEXTURE_NONE,
                    {
                        {D3DTSS_COLOROP,   D3DTOP_SELECTARG1},
                        {D3DTSS_COLORARG1, D3DTA_DIFFUSE},
                        {D3DTSS_ALPHAOP,   D3DTOP_SELECTARG1},
                        {D3DTSS_ALPHAARG1, D3DTA_DIFFUSE},
                        STATE_END(),
                    },
                },
            },
        },
        {
            D3DTEXOPCAPS_DISABLE | D3DTEXOPCAPS_SELECTARG1,
            0x00000000,
            {
                {
                    TEXTURE_NONE,
                    {
                        {D3DTSS_COLOROP,   D3DTOP_SELECTARG1},
                        {D3DTSS_COLORARG1, D3DTA_TEMP},
                        {D3DTSS_ALPHAOP,   D3DTOP_SELECTARG1},
                        {D3DTSS_ALPHAARG1, D3DTA_TEMP},
                        STATE_END(),
                    },
                },
            },
        },

        {
            D3DTEXOPCAPS_DISABLE | D3DTEXOPCAPS_SELECTARG1 | D3DTEXOPCAPS_BUMPENVMAP | D3DTEXOPCAPS_MODULATE,
            0x80ff0000,
            {
                {
                    TEXTURE_BUMPMAP,
                    {
                        {D3DTSS_COLOROP,      D3DTOP_BUMPENVMAP},
                        {D3DTSS_BUMPENVMAT00, *(DWORD *)&bumpenvmat[0]},
                        {D3DTSS_BUMPENVMAT01, *(DWORD *)&bumpenvmat[1]},
                        {D3DTSS_BUMPENVMAT10, *(DWORD *)&bumpenvmat[2]},
                        {D3DTSS_BUMPENVMAT11, *(DWORD *)&bumpenvmat[3]},
                        {D3DTSS_ALPHAOP,      D3DTOP_SELECTARG1},
                        {D3DTSS_ALPHAARG1,    D3DTA_TEXTURE},
                        STATE_END(),
                    },

                },
                {
                    TEXTURE_RED,
                    {
                        {D3DTSS_COLOROP, D3DTOP_MODULATE},
                        STATE_END(),
                    },
                },
                {TEXTURE_INVALID}
            },
        },
        {
            D3DTEXOPCAPS_DISABLE | D3DTEXOPCAPS_SELECTARG1 | D3DTEXOPCAPS_BUMPENVMAP | D3DTEXOPCAPS_MODULATE,
            0x80ff0000,
            {
                {
                    TEXTURE_BUMPMAP,
                    {
                        {D3DTSS_COLOROP,      D3DTOP_BUMPENVMAP},
                        {D3DTSS_BUMPENVMAT00, *(DWORD *)&bumpenvmat[0]},
                        {D3DTSS_BUMPENVMAT01, *(DWORD *)&bumpenvmat[1]},
                        {D3DTSS_BUMPENVMAT10, *(DWORD *)&bumpenvmat[2]},
                        {D3DTSS_BUMPENVMAT11, *(DWORD *)&bumpenvmat[3]},
                        {D3DTSS_ALPHAOP,      D3DTOP_SELECTARG1},
                        {D3DTSS_ALPHAARG1,    D3DTA_DIFFUSE},
                        STATE_END(),
                    },
                },
                {
                    TEXTURE_RED,
                    {
                        {D3DTSS_COLOROP, D3DTOP_MODULATE},
                        STATE_END(),
                    },
                },
                {TEXTURE_INVALID}
            },
        },
        {
            D3DTEXOPCAPS_DISABLE | D3DTEXOPCAPS_SELECTARG1 | D3DTEXOPCAPS_BUMPENVMAP | D3DTEXOPCAPS_MODULATE,
            0x80ff0000,
            {
                {
                    TEXTURE_BUMPMAP,
                    {
                        {D3DTSS_COLOROP,      D3DTOP_BUMPENVMAP},
                        {D3DTSS_BUMPENVMAT00, *(DWORD *)&bumpenvmat[0]},
                        {D3DTSS_BUMPENVMAT01, *(DWORD *)&bumpenvmat[1]},
                        {D3DTSS_BUMPENVMAT10, *(DWORD *)&bumpenvmat[2]},
                        {D3DTSS_BUMPENVMAT11, *(DWORD *)&bumpenvmat[3]},
                        {D3DTSS_ALPHAOP,      D3DTOP_SELECTARG1},
                        {D3DTSS_ALPHAARG1,    D3DTA_TEMP},
                        STATE_END(),
                    },
                },
                {
                    TEXTURE_RED,
                    {
                        {D3DTSS_COLOROP,   D3DTOP_MODULATE},
                        {D3DTSS_ALPHAOP,   D3DTOP_SELECTARG1},
                        {D3DTSS_ALPHAARG1, D3DTA_CURRENT},
                        STATE_END(),
                    },
                },
                {TEXTURE_INVALID}
            },
        },
        {
            D3DTEXOPCAPS_DISABLE | D3DTEXOPCAPS_SELECTARG1 | D3DTEXOPCAPS_BUMPENVMAP | D3DTEXOPCAPS_MODULATE,
            0x00ff0000,
            {
                {
                    TEXTURE_BUMPMAP,
                    {
                        {D3DTSS_COLOROP,      D3DTOP_BUMPENVMAP},
                        {D3DTSS_BUMPENVMAT00, *(DWORD *)&bumpenvmat[0]},
                        {D3DTSS_BUMPENVMAT01, *(DWORD *)&bumpenvmat[1]},
                        {D3DTSS_BUMPENVMAT10, *(DWORD *)&bumpenvmat[2]},
                        {D3DTSS_BUMPENVMAT11, *(DWORD *)&bumpenvmat[3]},
                        {D3DTSS_ALPHAOP,      D3DTOP_SELECTARG1},
                        {D3DTSS_ALPHAARG1,    D3DTA_TEMP},
                        STATE_END(),
                    },
                },
                {
                    TEXTURE_RED,
                    {
                        {D3DTSS_COLOROP,   D3DTOP_MODULATE},
                        {D3DTSS_COLORARG1, D3DTA_TEXTURE},
                        {D3DTSS_COLORARG2, D3DTA_CURRENT},
                        {D3DTSS_ALPHAOP,   D3DTOP_SELECTARG1},
                        {D3DTSS_ALPHAARG1, D3DTA_TEMP},
                        STATE_END(),
                    },
                },
                {TEXTURE_INVALID}
            },
        },
        {
            D3DTEXOPCAPS_DISABLE | D3DTEXOPCAPS_SELECTARG1 | D3DTEXOPCAPS_BUMPENVMAP | D3DTEXOPCAPS_MODULATE,
            0x80ff0000,
            {
                {
                    TEXTURE_BUMPMAP,
                    {
                        {D3DTSS_COLOROP,      D3DTOP_BUMPENVMAP},
                        {D3DTSS_BUMPENVMAT00, *(DWORD *)&bumpenvmat[0]},
                        {D3DTSS_BUMPENVMAT01, *(DWORD *)&bumpenvmat[1]},
                        {D3DTSS_BUMPENVMAT10, *(DWORD *)&bumpenvmat[2]},
                        {D3DTSS_BUMPENVMAT11, *(DWORD *)&bumpenvmat[3]},
                        {D3DTSS_ALPHAOP,      D3DTOP_SELECTARG1},
                        {D3DTSS_ALPHAARG1,    D3DTA_CURRENT},
                        STATE_END(),
                    },
                },
                {
                    TEXTURE_RED,
                    {
                        {D3DTSS_COLOROP,   D3DTOP_MODULATE},
                        {D3DTSS_COLORARG1, D3DTA_TEXTURE},
                        {D3DTSS_COLORARG2, D3DTA_CURRENT},
                        {D3DTSS_ALPHAOP,   D3DTOP_SELECTARG1},
                        {D3DTSS_ALPHAARG1, D3DTA_CURRENT},
                        STATE_END(),
                    },
                },
                {TEXTURE_INVALID}
            },
        },

        {
            D3DTEXOPCAPS_DISABLE | D3DTEXOPCAPS_SELECTARG1 | D3DTEXOPCAPS_BUMPENVMAP | D3DTEXOPCAPS_MODULATE
                    | D3DTEXOPCAPS_ADD,
            0x80ff0000,
            {
                {
                    TEXTURE_BUMPMAP,
                    {
                        {D3DTSS_COLOROP,      D3DTOP_BUMPENVMAP},
                        {D3DTSS_BUMPENVMAT00, *(DWORD *)&bumpenvmat[0]},
                        {D3DTSS_BUMPENVMAT01, *(DWORD *)&bumpenvmat[1]},
                        {D3DTSS_BUMPENVMAT10, *(DWORD *)&bumpenvmat[2]},
                        {D3DTSS_BUMPENVMAT11, *(DWORD *)&bumpenvmat[3]},
                        {D3DTSS_ALPHAOP,      D3DTOP_ADD},
                        {D3DTSS_ALPHAARG1,    D3DTA_DIFFUSE},
                        {D3DTSS_ALPHAARG2,    D3DTA_CURRENT},
                        STATE_END(),
                    },
                },
                {
                    TEXTURE_RED,
                    {
                        {D3DTSS_COLOROP,   D3DTOP_MODULATE},
                        {D3DTSS_COLORARG1, D3DTA_TEXTURE},
                        {D3DTSS_COLORARG2, D3DTA_CURRENT},
                        {D3DTSS_ALPHAOP,   D3DTOP_SELECTARG1},
                        {D3DTSS_ALPHAARG1, D3DTA_CURRENT},
                        STATE_END(),
                    },
                },
                {TEXTURE_INVALID}
            },
        },
        {
            D3DTEXOPCAPS_DISABLE | D3DTEXOPCAPS_SELECTARG1 | D3DTEXOPCAPS_BUMPENVMAP | D3DTEXOPCAPS_MODULATE
                    | D3DTEXOPCAPS_MODULATE2X,
            0x80ffff00,
            {
                {
                    TEXTURE_BUMPMAP,
                    {
                        {D3DTSS_COLOROP,      D3DTOP_BUMPENVMAP},
                        {D3DTSS_BUMPENVMAT00, *(DWORD *)&bumpenvmat[0]},
                        {D3DTSS_BUMPENVMAT01, *(DWORD *)&bumpenvmat[1]},
                        {D3DTSS_BUMPENVMAT10, *(DWORD *)&bumpenvmat[2]},
                        {D3DTSS_BUMPENVMAT11, *(DWORD *)&bumpenvmat[3]},
                        {D3DTSS_ALPHAOP,      D3DTOP_MODULATE2X},
                        {D3DTSS_ALPHAARG1,    D3DTA_CURRENT},
                        {D3DTSS_ALPHAARG2,    D3DTA_DIFFUSE},
                        STATE_END(),
                    },
                },
                {
                    TEXTURE_RED,
                    {
                        {D3DTSS_COLOROP,   D3DTOP_MODULATE},
                        {D3DTSS_COLORARG1, D3DTA_CURRENT},
                        {D3DTSS_COLORARG2, D3DTA_CURRENT},
                        {D3DTSS_ALPHAOP,   D3DTOP_SELECTARG1},
                        {D3DTSS_ALPHAARG1, D3DTA_CURRENT},
                        STATE_END(),
                    },
                },
                {TEXTURE_INVALID}
            },
        },
        {
            D3DTEXOPCAPS_DISABLE | D3DTEXOPCAPS_SELECTARG1 | D3DTEXOPCAPS_BUMPENVMAP,
            0x80ffff02,
            {
                {
                    TEXTURE_NONE,
                    {
                        {D3DTSS_COLOROP,   D3DTOP_SELECTARG1},
                        {D3DTSS_COLORARG1, D3DTA_DIFFUSE},
                        {D3DTSS_ALPHAOP,   D3DTOP_SELECTARG1},
                        {D3DTSS_ALPHAARG1, D3DTA_DIFFUSE},
                        {D3DTSS_RESULTARG, D3DTA_TEMP},
                        STATE_END(),
                    },
                },
                {
                    TEXTURE_BUMPMAP,
                    {
                        {D3DTSS_COLOROP,      D3DTOP_BUMPENVMAP},
                        {D3DTSS_BUMPENVMAT00, *(DWORD *)&bumpenvmat[0]},
                        {D3DTSS_BUMPENVMAT01, *(DWORD *)&bumpenvmat[1]},
                        {D3DTSS_BUMPENVMAT10, *(DWORD *)&bumpenvmat[2]},
                        {D3DTSS_BUMPENVMAT11, *(DWORD *)&bumpenvmat[3]},
                        {D3DTSS_ALPHAOP,      D3DTOP_SELECTARG1},
                        {D3DTSS_ALPHAARG1,    D3DTA_TEMP},
                        {D3DTSS_RESULTARG,    D3DTA_TEMP},
                        STATE_END(),
                    },
                },
                {
                    TEXTURE_RED,
                    {
                        {D3DTSS_COLOROP,   D3DTOP_SELECTARG1},
                        {D3DTSS_COLORARG1, D3DTA_TEXTURE},
                        {D3DTSS_ALPHAOP,   D3DTOP_SELECTARG1},
                        {D3DTSS_ALPHAARG1, D3DTA_TEXTURE},
                        STATE_END(),
                    },
                },
                {
                    TEXTURE_NONE,
                    {
                        {D3DTSS_COLOROP,   D3DTOP_SELECTARG1},
                        {D3DTSS_COLORARG1, D3DTA_TEMP},
                        {D3DTSS_ALPHAOP,   D3DTOP_SELECTARG1},
                        {D3DTSS_ALPHAARG1, D3DTA_TEMP},
                        STATE_END(),
                    },
                },
                {TEXTURE_INVALID}
            },
        },
    };

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device.\n");
        goto done;
    }

    memset(&caps, 0, sizeof(caps));
    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(hr == D3D_OK, "IDirect3DDevice8_GetDeviceCaps failed hr %#lx.\n", hr);

    if(!(caps.PrimitiveMiscCaps & D3DPMISCCAPS_TSSARGTEMP))
    {
        skip("D3DPMISCCAPS_TSSARGTEMP not supported.\n");
        IDirect3DDevice8_Release(device);
        goto done;
    }

    if (FAILED(IDirect3D8_CheckDeviceFormat(d3d, 0, D3DDEVTYPE_HAL,
            D3DFMT_X8R8G8B8, 0, D3DRTYPE_TEXTURE, D3DFMT_V8U8)))
    {
        skip("D3DFMT_V8U8 not supported for legacy bump mapping.\n");
        IDirect3DDevice8_Release(device);
        goto done;
    }

    hr = IDirect3DDevice8_GetBackBuffer(device, 0, D3DBACKBUFFER_TYPE_MONO, &backbuffer);
    ok(hr == D3D_OK, "Can't get back buffer, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CreateTexture(device, 1, 1, 1, 0, D3DFMT_V8U8, D3DPOOL_MANAGED, &texture_bumpmap);
    ok(hr == D3D_OK, "IDirect3DDevice8_CreateTexture failed, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateTexture(device, 1, 1, 1, 0, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED, &texture_red);
    ok(hr == D3D_OK, "IDirect3DDevice8_CreateTexture failed, hr %#lx.\n", hr);

    memset(&locked_rect, 0, sizeof(locked_rect));
    hr = IDirect3DTexture8_LockRect(texture_bumpmap, 0, &locked_rect, NULL, 0);
    ok(SUCCEEDED(hr), "LockRect failed, hr %#lx.\n", hr);
    *((WORD *)locked_rect.pBits) = 0xff00;
    hr = IDirect3DTexture8_UnlockRect(texture_bumpmap, 0);
    ok(SUCCEEDED(hr), "UnlockRect failed, hr %#lx.\n", hr);

    memset(&locked_rect, 0, sizeof(locked_rect));
    hr = IDirect3DTexture8_LockRect(texture_red, 0, &locked_rect, NULL, 0);
    ok(SUCCEEDED(hr), "LockRect failed, hr %#lx.\n", hr);
    *((DWORD *)locked_rect.pBits) = 0x00ff0000;
    hr = IDirect3DTexture8_UnlockRect(texture_red, 0);
    ok(SUCCEEDED(hr), "UnlockRect failed, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_DIFFUSE);
    ok(SUCCEEDED(hr), "Failed to set FVF, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(hr == D3D_OK, "Failed to disable lighting, hr %#lx.\n", hr);

    for (i = 0; i < ARRAY_SIZE(tests); ++i)
    {
        const struct test *current_test = &tests[i];

        if ((caps.TextureOpCaps & current_test->tex_op_caps) != current_test->tex_op_caps)
        {
            skip("Texture operations %#lx not supported.\n", current_test->tex_op_caps);
            continue;
        }

        for (j = 0; j < caps.MaxTextureBlendStages; ++j)
        {
            IDirect3DTexture8 *current_texture = NULL;

            for (k = 0; !IS_STATE_END(default_stage_state.state[k]); ++k)
            {
                hr = IDirect3DDevice8_SetTextureStageState(device, j,
                        default_stage_state.state[k].name, default_stage_state.state[k].value);
                ok(SUCCEEDED(hr), "Test %u: SetTextureStageState failed, hr %#lx.\n", i, hr);
            }

            if (current_test->stage[j].texture != TEXTURE_INVALID)
            {
                const struct texture_stage_state *current_state = current_test->stage[j].state;

                switch (current_test->stage[j].texture)
                {
                    case TEXTURE_RED:
                        current_texture = texture_red;
                        break;
                    case TEXTURE_BUMPMAP:
                        current_texture = texture_bumpmap;
                        break;
                    default:
                        current_texture = NULL;
                        break;
                }

                for (k = 0; !IS_STATE_END(current_state[k]); ++k)
                {
                    hr = IDirect3DDevice8_SetTextureStageState(device, j,
                            current_state[k].name, current_state[k].value);
                    ok(SUCCEEDED(hr), "Test %u: SetTextureStageState failed, hr %#lx.\n", i, hr);
                }
            }

            hr = IDirect3DDevice8_SetTexture(device, j, (IDirect3DBaseTexture8 *)current_texture);
            ok(SUCCEEDED(hr), "Test %u: SetTexture failed, hr %#lx.\n", i, hr);
        }

        hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0xff00ff00, 1.0f, 0);
        ok(hr == D3D_OK, "Test %u: IDirect3DDevice8_Clear failed, hr %#lx.\n", i, hr);

        hr = IDirect3DDevice8_BeginScene(device);
        ok(SUCCEEDED(hr), "Test %u: BeginScene failed, hr %#lx.\n", i, hr);
        hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, &quad[0], sizeof(quad[0]));
        ok(SUCCEEDED(hr), "Test %u: DrawPrimitiveUP failed, hr %#lx.\n", i, hr);
        hr = IDirect3DDevice8_EndScene(device);
        ok(SUCCEEDED(hr), "Test %u: EndScene failed, hr %#lx.\n", i, hr);

        get_surface_readback(backbuffer, &rb);
        color = get_readback_color(&rb, 320, 240);
        ok(color_match(color, current_test->expected_color, 1),
                "Test %u: Got color 0x%08x, expected 0x%08x.\n", i, color, current_test->expected_color);
        release_surface_readback(&rb);
        hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
        ok(SUCCEEDED(hr), "Test %u: Present failed, hr %#lx.\n", i, hr);
    }

    IDirect3DTexture8_Release(texture_bumpmap);
    IDirect3DTexture8_Release(texture_red);
    IDirect3DSurface8_Release(backbuffer);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_color_clamping(void)
{
    static const D3DMATRIX mat =
    {{{
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f,
    }}};
    static const struct vec3 quad[] =
    {
        {-1.0f, -1.0f, 0.1f},
        {-1.0f,  1.0f, 0.1f},
        { 1.0f, -1.0f, 0.1f},
        { 1.0f,  1.0f, 0.1f},
    };
    static const DWORD decl[] =
    {
        D3DVSD_STREAM(0),
        D3DVSD_REG(D3DVSDE_POSITION, D3DVSDT_FLOAT3),
        D3DVSD_CONST(0, 1), 0x3f800000, 0x3f800000, 0x3f800000, 0x3f800000,     /* def c0, 1.0, 1.0, 1.0, 1.0 */
        D3DVSD_END()
    };
    static const DWORD vs1_code[] =
    {
        0xfffe0101,                                                             /* vs_1_1                         */
        0x00000001, 0xc00f0000, 0x90e40000,                                     /* mov oPos, v0                   */
        0x00000002, 0xd00f0000, 0xa0e40000, 0xa0e40000,                         /* add oD0, c0, c0                */
        0x00000002, 0xd00f0001, 0xa0e40000, 0xa0e40000,                         /* add oD1, c0, c0                */
        0x0000ffff
    };
    static const DWORD ps1_code[] =
    {
        0xffff0101,                                                             /* ps_1_1                         */
        0x00000051, 0xa00f0000, 0x3e800000, 0x3e800000, 0x3e800000, 0x3e800000, /* def c0, 0.25, 0.25, 0.25, 0.25 */
        0x00000002, 0x800f0000, 0x90e40000, 0x90e40001,                         /* add r0, v0, v1                 */
        0x00000005, 0x800f0000, 0x80e40000, 0xa0e40000,                         /* mul r0, r0, c0                 */
        0x0000ffff
    };
    static const struct
    {
        DWORD vs_version;
        const DWORD *vs;
        DWORD ps_version;
        const DWORD *ps;
        D3DCOLOR expected, broken;
    }
    tests[] =
    {
        {0, NULL, 0, NULL, 0x00404040},
        {0, NULL, D3DPS_VERSION(1, 1), ps1_code, 0x00404040, 0x00808080},
        {D3DVS_VERSION(1, 1), vs1_code, 0, NULL, 0x00404040},
        {D3DVS_VERSION(1, 1), vs1_code, D3DPS_VERSION(1, 1), ps1_code, 0x007f7f7f},
    };
    IDirect3DDevice8 *device;
    unsigned int color, i;
    IDirect3D8 *d3d;
    ULONG refcount;
    D3DCAPS8 caps;
    DWORD vs, ps;
    HWND window;
    HRESULT hr;

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get caps, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTransform(device, D3DTS_WORLD, &mat);
    ok(SUCCEEDED(hr), "Failed to set world transform, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTransform(device, D3DTS_VIEW, &mat);
    ok(SUCCEEDED(hr), "Failed to set view transform, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTransform(device, D3DTS_PROJECTION, &mat);
    ok(SUCCEEDED(hr), "Failed to set projection transform, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_CLIPPING, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable clipping, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZENABLE, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable Z test, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_FOGENABLE, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable fog, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_STENCILENABLE, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable stencil test, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_CULLMODE, D3DCULL_NONE);
    ok(SUCCEEDED(hr), "Failed to disable culling, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable lighting, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_TEXTUREFACTOR, 0xff404040);
    ok(SUCCEEDED(hr), "Failed to set texture factor, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_COLOROP, D3DTOP_ADD);
    ok(SUCCEEDED(hr), "Failed to set color op, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_COLORARG1, D3DTA_DIFFUSE);
    ok(SUCCEEDED(hr), "Failed to set color arg, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_COLORARG2, D3DTA_SPECULAR);
    ok(SUCCEEDED(hr), "Failed to set color arg, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 1, D3DTSS_COLOROP, D3DTOP_MODULATE);
    ok(SUCCEEDED(hr), "Failed to set color op, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 1, D3DTSS_COLORARG1, D3DTA_TFACTOR);
    ok(SUCCEEDED(hr), "Failed to set color arg, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 1, D3DTSS_COLORARG2, D3DTA_CURRENT);
    ok(SUCCEEDED(hr), "Failed to set color arg, hr %#lx.\n", hr);

    for (i = 0; i < ARRAY_SIZE(tests); ++i)
    {
        if (caps.VertexShaderVersion < tests[i].vs_version
                || caps.PixelShaderVersion < tests[i].ps_version)
        {
            skip("Vertex / pixel shader version not supported, skipping test %u.\n", i);
            continue;
        }
        if (tests[i].vs)
        {
            hr = IDirect3DDevice8_CreateVertexShader(device, decl, tests[i].vs, &vs, 0);
            ok(SUCCEEDED(hr), "Failed to create vertex shader, hr %#lx (case %u).\n", hr, i);
        }
        else
        {
            vs = D3DFVF_XYZ;
        }
        if (tests[i].ps)
        {
            hr = IDirect3DDevice8_CreatePixelShader(device, tests[i].ps, &ps);
            ok(SUCCEEDED(hr), "Failed to create pixel shader, hr %#lx (case %u).\n", hr, i);
        }
        else
        {
            ps = 0;
        }

        hr = IDirect3DDevice8_SetVertexShader(device, vs);
        ok(SUCCEEDED(hr), "Failed to set vertex shader, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetPixelShader(device, ps);
        ok(SUCCEEDED(hr), "Failed to set pixel shader, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xff00ff00, 0.0f, 0);
        ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_BeginScene(device);
        ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(quad[0]));
        ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_EndScene(device);
        ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

        color = getPixelColor(device, 320, 240);
        ok(color_match(color, tests[i].expected, 1) || broken(color_match(color, tests[i].broken, 1)),
                "Got unexpected color 0x%08x, case %u.\n", color, i);

        if (vs != D3DFVF_XYZ)
            IDirect3DDevice8_DeleteVertexShader(device, vs);
        if (ps)
            IDirect3DDevice8_DeletePixelShader(device, ps);
    }

    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_edge_antialiasing_blending(void)
{
    IDirect3DDevice8 *device;
    unsigned int color;
    IDirect3D8 *d3d8;
    ULONG refcount;
    D3DCAPS8 caps;
    HWND window;
    HRESULT hr;

    static const struct
    {
        struct vec3 position;
        DWORD diffuse;
    }
    green_quad[] =
    {
        {{-1.0f, -1.0f, 0.1f}, D3DCOLOR_ARGB(0x7f, 0x00, 0xff, 0x00)},
        {{-1.0f,  1.0f, 0.1f}, D3DCOLOR_ARGB(0x7f, 0x00, 0xff, 0x00)},
        {{ 1.0f, -1.0f, 0.1f}, D3DCOLOR_ARGB(0x7f, 0x00, 0xff, 0x00)},
        {{ 1.0f,  1.0f, 0.1f}, D3DCOLOR_ARGB(0x7f, 0x00, 0xff, 0x00)},
    };
    static const struct
    {
        struct vec3 position;
        DWORD diffuse;
    }
    red_quad[] =
    {
        {{-1.0f, -1.0f, 0.1f}, D3DCOLOR_ARGB(0xcc, 0xff, 0x00, 0x00)},
        {{-1.0f,  1.0f, 0.1f}, D3DCOLOR_ARGB(0xcc, 0xff, 0x00, 0x00)},
        {{ 1.0f, -1.0f, 0.1f}, D3DCOLOR_ARGB(0xcc, 0xff, 0x00, 0x00)},
        {{ 1.0f,  1.0f, 0.1f}, D3DCOLOR_ARGB(0xcc, 0xff, 0x00, 0x00)},
    };

    window = create_window();
    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d8, window, window, TRUE)))
    {
        skip("Failed to create a D3D device.\n");
        IDirect3D8_Release(d3d8);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get caps, hr %#lx.\n", hr);
    trace("Edge antialiasing support: %#lx.\n", caps.RasterCaps & D3DPRASTERCAPS_ANTIALIASEDGES);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_CLIPPING, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable clipping, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZENABLE, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable Z test, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable lighting, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ALPHABLENDENABLE, TRUE);
    ok(SUCCEEDED(hr), "Failed to enable blending, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_BLENDOP, D3DBLENDOP_ADD);
    ok(SUCCEEDED(hr), "Failed to set blend op, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_SRCBLEND, D3DBLEND_SRCALPHA);
    ok(SUCCEEDED(hr), "Failed to set src blend, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_DESTBLEND, D3DBLEND_DESTALPHA);
    ok(SUCCEEDED(hr), "Failed to set dest blend, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_COLOROP, D3DTOP_SELECTARG1);
    ok(SUCCEEDED(hr), "Failed to set color op, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_COLORARG1, D3DTA_DIFFUSE);
    ok(SUCCEEDED(hr), "Failed to set color arg, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_ALPHAOP, D3DTOP_SELECTARG1);
    ok(SUCCEEDED(hr), "Failed to set alpha op, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_ALPHAARG1, D3DTA_DIFFUSE);
    ok(SUCCEEDED(hr), "Failed to set alpha arg, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_DIFFUSE);
    ok(SUCCEEDED(hr), "Failed to set FVF, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xccff0000, 0.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, green_quad, sizeof(*green_quad));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x00cc7f00, 1), "Got unexpected color 0x%08x.\n", color);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0x7f00ff00, 0.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, red_quad, sizeof(*red_quad));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x00cc7f00, 1), "Got unexpected color 0x%08x.\n", color);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ALPHABLENDENABLE, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable blending, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xccff0000, 0.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, green_quad, sizeof(*green_quad));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x0000ff00, 1), "Got unexpected color 0x%08x.\n", color);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0x7f00ff00, 0.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, red_quad, sizeof(*red_quad));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x00ff0000, 1), "Got unexpected color 0x%08x.\n", color);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_EDGEANTIALIAS, TRUE);
    ok(SUCCEEDED(hr), "Failed to enable edge antialiasing, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xccff0000, 0.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, green_quad, sizeof(*green_quad));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x0000ff00, 1), "Got unexpected color 0x%08x.\n", color);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0x7f00ff00, 0.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, red_quad, sizeof(*red_quad));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x00ff0000, 1), "Got unexpected color 0x%08x.\n", color);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d8);
    DestroyWindow(window);
}

/* This test shows that 0xffff is valid index in D3D8. */
static void test_max_index16(void)
{
    static const struct vertex
    {
        struct vec3 position;
        DWORD diffuse;
    }
    green_quad[] =
    {
        {{-1.0f, -1.0f, 0.1f}, D3DCOLOR_ARGB(0xff, 0x00, 0xff, 0x00)},
        {{-1.0f,  1.0f, 0.1f}, D3DCOLOR_ARGB(0xff, 0x00, 0xff, 0x00)},
        {{ 1.0f, -1.0f, 0.1f}, D3DCOLOR_ARGB(0xff, 0x00, 0xff, 0x00)},
        {{ 1.0f,  1.0f, 0.1f}, D3DCOLOR_ARGB(0xff, 0x00, 0xff, 0x00)},
    };
    static const unsigned short indices[] = {0, 1, 2, 0xffff};
    static const unsigned int vertex_count = 0xffff + 1;

    D3DADAPTER_IDENTIFIER8 identifier;
    IDirect3DVertexBuffer8 *vb;
    IDirect3DIndexBuffer8 *ib;
    IDirect3DDevice8 *device;
    struct vertex *vb_data;
    unsigned int color;
    IDirect3D8 *d3d8;
    ULONG refcount;
    D3DCAPS8 caps;
    HWND window;
    BYTE *data;
    HRESULT hr;
    BOOL warp;

    window = create_window();
    d3d8 = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d8, "Failed to create a D3D object.\n");

    hr = IDirect3D8_GetAdapterIdentifier(d3d8, D3DADAPTER_DEFAULT, 0, &identifier);
    ok(SUCCEEDED(hr), "Failed to get adapter identifier, hr %#lx.\n", hr);
    warp = adapter_is_warp(&identifier);

    if (!(device = create_device(d3d8, window, window, TRUE)))
    {
        skip("Failed to create a D3D device.\n");
        IDirect3D8_Release(d3d8);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get device caps, hr %#lx.\n", hr);
    if (caps.MaxVertexIndex < 0xffff)
    {
        skip("Max vertex index is lower than 0xffff (%#lx).\n", caps.MaxVertexIndex);
        IDirect3DDevice8_Release(device);
        IDirect3D8_Release(d3d8);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_CreateVertexBuffer(device, vertex_count * sizeof(*green_quad), 0,
            D3DFVF_XYZ | D3DFVF_DIFFUSE, D3DPOOL_MANAGED, &vb);
    ok(SUCCEEDED(hr), "Failed to create vertex buffer, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CreateIndexBuffer(device, sizeof(indices), 0,
            D3DFMT_INDEX16, D3DPOOL_MANAGED, &ib);
    ok(SUCCEEDED(hr), "Failed to create index buffer, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_CLIPPING, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable clipping, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZENABLE, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable Z test, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable lighting, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_DIFFUSE);
    ok(SUCCEEDED(hr), "Failed to set FVF, hr %#lx.\n", hr);

    hr = IDirect3DVertexBuffer8_Lock(vb, 0, sizeof(green_quad), (BYTE **)&vb_data, 0);
    ok(hr == D3D_OK, "Failed to lock vertex buffer, hr %#lx.\n", hr);
    vb_data[0] = green_quad[0];
    vb_data[1] = green_quad[1];
    vb_data[2] = green_quad[2];
    vb_data[0xffff] = green_quad[3];
    hr = IDirect3DVertexBuffer8_Unlock(vb);
    ok(hr == D3D_OK, "Failed to unlock vertex buffer, hr %#lx.\n", hr);

    hr = IDirect3DIndexBuffer8_Lock(ib, 0, sizeof(indices), &data, 0);
    ok(hr == D3D_OK, "Failed to lock index buffer, hr %#lx.\n", hr);
    memcpy(data, indices, sizeof(indices));
    hr = IDirect3DIndexBuffer8_Unlock(ib);
    ok(hr == D3D_OK, "Failed to unlock index buffer, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetIndices(device, ib, 0);
    ok(hr == D3D_OK, "Failed to set index buffer, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetStreamSource(device, 0, vb, sizeof(struct vertex));
    ok(hr == D3D_OK, "Failed to set stream source, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xffffffff, 0.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawIndexedPrimitive(device, D3DPT_TRIANGLESTRIP, 0, vertex_count, 0, 2);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);
    color = getPixelColor(device, 20, 20);
    ok(color_match(color, 0x0000ff00, 1), "Got unexpected color 0x%08x.\n", color);
    color = getPixelColor(device, 320, 240);
    ok(color_match(color, 0x0000ff00, 1) || broken(warp), "Got unexpected color 0x%08x.\n", color);
    color = getPixelColor(device, 620, 460);
    ok(color_match(color, 0x0000ff00, 1) || broken(warp), "Got unexpected color 0x%08x.\n", color);

    IDirect3DIndexBuffer8_Release(ib);
    IDirect3DVertexBuffer8_Release(vb);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d8);
    DestroyWindow(window);
}

static void test_backbuffer_resize(void)
{
    D3DPRESENT_PARAMETERS present_parameters = {0};
    IDirect3DSurface8 *backbuffer;
    IDirect3DDevice8 *device;
    unsigned int color;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    static const struct
    {
        struct vec3 position;
        DWORD diffuse;
    }
    quad[] =
    {
        {{-1.0f, -1.0f, 0.1f}, D3DCOLOR_ARGB(0xff, 0x00, 0xff, 0x00)},
        {{-1.0f,  1.0f, 0.1f}, D3DCOLOR_ARGB(0xff, 0x00, 0xff, 0x00)},
        {{ 1.0f, -1.0f, 0.1f}, D3DCOLOR_ARGB(0xff, 0x00, 0xff, 0x00)},
        {{ 1.0f,  1.0f, 0.1f}, D3DCOLOR_ARGB(0xff, 0x00, 0xff, 0x00)},
    };

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device.\n");
        goto done;
    }

    /* Wine d3d8 implementation had a bug which was triggered by a
     * SetRenderTarget() call with an unreferenced surface. */
    hr = IDirect3DDevice8_GetBackBuffer(device, 0, D3DBACKBUFFER_TYPE_MONO, &backbuffer);
    ok(SUCCEEDED(hr), "Failed to get backbuffer, hr %#lx.\n", hr);
    refcount = IDirect3DSurface8_Release(backbuffer);
    ok(!refcount, "Surface has %lu references left.\n", refcount);
    hr = IDirect3DDevice8_SetRenderTarget(device, backbuffer, NULL);
    ok(SUCCEEDED(hr), "Failed to set render target, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderTarget(device, backbuffer, NULL);
    ok(SUCCEEDED(hr), "Failed to set render target, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xffff0000, 1.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);
    color = getPixelColor(device, 1, 1);
    ok(color == 0x00ff0000, "Got unexpected color 0x%08x.\n", color);

    present_parameters.BackBufferWidth = 800;
    present_parameters.BackBufferHeight = 600;
    present_parameters.BackBufferFormat = D3DFMT_A8R8G8B8;
    present_parameters.SwapEffect = D3DSWAPEFFECT_DISCARD;
    present_parameters.hDeviceWindow = NULL;
    present_parameters.Windowed = TRUE;
    present_parameters.EnableAutoDepthStencil = TRUE;
    present_parameters.AutoDepthStencilFormat = D3DFMT_D24S8;
    hr = IDirect3DDevice8_Reset(device, &present_parameters);
    ok(SUCCEEDED(hr), "Failed to reset, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_CLIPPING, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable clipping, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZENABLE, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable Z test, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable lighting, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_DIFFUSE);
    ok(SUCCEEDED(hr), "Failed to set FVF, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetBackBuffer(device, 0, D3DBACKBUFFER_TYPE_MONO, &backbuffer);
    ok(SUCCEEDED(hr), "Failed to get backbuffer, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderTarget(device, backbuffer, NULL);
    ok(SUCCEEDED(hr), "Failed to set render target, hr %#lx.\n", hr);
    IDirect3DSurface8_Release(backbuffer);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xffffff00, 1.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);
    color = getPixelColor(device, 1, 1);
    ok(color == 0x00ffff00, "Got unexpected color 0x%08x.\n", color);
    color = getPixelColor(device, 700, 500);
    ok(color == 0x00ffff00, "Got unexpected color 0x%08x.\n", color);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(*quad));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);
    color = getPixelColor(device, 1, 1);
    ok(color == 0x0000ff00, "Got unexpected color 0x%08x.\n", color);
    color = getPixelColor(device, 700, 500);
    ok(color == 0x0000ff00, "Got unexpected color 0x%08x.\n", color);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_drawindexedprimitiveup(void)
{
    static const struct vertex
    {
        struct vec3 position;
        DWORD diffuse;
    }
    quad[] =
    {
        {{-1.0f, -1.0f, 0.1f}, 0xff00ff00},
        {{-1.0f,  1.0f, 0.1f}, 0xff0000ff},
        {{ 1.0f, -1.0f, 0.1f}, 0xffff0000},
        {{ 1.0f,  1.0f, 0.1f}, 0xff0000ff},

        {{-1.0f, -1.0f, 0.1f}, 0xff0000ff},
        {{-1.0f,  1.0f, 0.1f}, 0xff00ff00},
        {{ 1.0f, -1.0f, 0.1f}, 0xffff0000},
        {{ 1.0f,  1.0f, 0.1f}, 0xff00ff00},
    };
    static const unsigned short indices[] = {0, 1, 2, 3, 4, 5, 6, 7};
    IDirect3DDevice8 *device;
    unsigned int color;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");

    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_CLIPPING, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable clipping, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZENABLE, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable Z test, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable lighting, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_COLOROP, D3DTOP_SELECTARG1);
    ok(SUCCEEDED(hr), "Failed to set color op, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_COLORARG1, D3DTA_DIFFUSE);
    ok(SUCCEEDED(hr), "Failed to set color arg, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_ALPHAOP, D3DTOP_SELECTARG1);
    ok(SUCCEEDED(hr), "Failed to set alpha op, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_ALPHAARG1, D3DTA_DIFFUSE);
    ok(SUCCEEDED(hr), "Failed to set alpha arg, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_DIFFUSE);
    ok(SUCCEEDED(hr), "Failed to set FVF, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xffffffff, 0.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawIndexedPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 4, 4, 2, indices + 4, D3DFMT_INDEX16, quad, sizeof(*quad));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

    color = getPixelColor(device, 160, 120);
    ok(color_match(color, 0x0040bf00, 1), "Got unexpected color 0x%08x.\n", color);
    color = getPixelColor(device, 480, 120);
    ok(color_match(color, 0x0040bf00, 1), "Got unexpected color 0x%08x.\n", color);
    color = getPixelColor(device, 160, 360);
    ok(color_match(color, 0x00404080, 1), "Got unexpected color 0x%08x.\n", color);
    color = getPixelColor(device, 480, 360);
    ok(color_match(color, 0x00bf4000, 1), "Got unexpected color 0x%08x.\n", color);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xffffffff, 0.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawIndexedPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 0, 4, 2, indices, D3DFMT_INDEX16, quad, sizeof(*quad));
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

    color = getPixelColor(device, 160, 120);
    ok(color_match(color, 0x004000bf, 1), "Got unexpected color 0x%08x.\n", color);
    color = getPixelColor(device, 480, 120);
    ok(color_match(color, 0x004000bf, 1), "Got unexpected color 0x%08x.\n", color);
    color = getPixelColor(device, 160, 360);
    ok(color_match(color, 0x00408040, 1), "Got unexpected color 0x%08x.\n", color);
    color = getPixelColor(device, 480, 360);
    ok(color_match(color, 0x00bf0040, 1), "Got unexpected color 0x%08x.\n", color);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_map_synchronisation(void)
{
    unsigned int colour, i, j, tri_count, size;
    LARGE_INTEGER frequency, diff, ts[3];
    D3DADAPTER_IDENTIFIER8 identifier;
    IDirect3DVertexBuffer8 *buffer;
    IDirect3DDevice8 *device;
    BOOL unsynchronised, ret;
    IDirect3D8 *d3d;
    ULONG refcount;
    D3DCAPS8 caps;
    HWND window;
    HRESULT hr;

    static const struct
    {
        unsigned int flags;
        BOOL unsynchronised;
    }
    tests[] =
    {
        {0,                                     FALSE},
        {D3DLOCK_NOOVERWRITE,                   TRUE},
        {D3DLOCK_DISCARD,                       FALSE},
        {D3DLOCK_NOOVERWRITE | D3DLOCK_DISCARD, TRUE},
    };

    static const struct quad
    {
        struct
        {
            struct vec3 position;
            DWORD diffuse;
        } strip[4];
    }
    quad1 =
    {
        {
            {{-1.0f, -1.0f, 0.0f}, 0xffff0000},
            {{-1.0f,  1.0f, 0.0f}, 0xff00ff00},
            {{ 1.0f, -1.0f, 0.0f}, 0xff0000ff},
            {{ 1.0f,  1.0f, 0.0f}, 0xffffffff},
        }
    },
    quad2 =
    {
        {
            {{-1.0f, -1.0f, 0.0f}, 0xffffff00},
            {{-1.0f,  1.0f, 0.0f}, 0xffffff00},
            {{ 1.0f, -1.0f, 0.0f}, 0xffffff00},
            {{ 1.0f,  1.0f, 0.0f}, 0xffffff00},
        }
    };
    struct quad *quads;

    window = create_window();
    ok(!!window, "Failed to create a window.\n");

    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3D8_GetAdapterIdentifier(d3d, D3DADAPTER_DEFAULT, 0, &identifier);
    ok(SUCCEEDED(hr), "Failed to get adapter identifier, hr %#lx.\n", hr);
    /* Maps are always synchronised on WARP. */
    if (adapter_is_warp(&identifier))
    {
        skip("Running on WARP, skipping test.\n");
        goto done;
    }

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get device caps, hr %#lx.\n", hr);

    tri_count = 0x1000;
    if (tri_count > caps.MaxPrimitiveCount)
    {
        skip("Device supports only %lu primitives, skipping test.\n", caps.MaxPrimitiveCount);
        goto done;
    }
    size = (tri_count + 2) * sizeof(*quad1.strip);

    ret = QueryPerformanceFrequency(&frequency);
    ok(ret, "Failed to get performance counter frequency.\n");

    hr = IDirect3DDevice8_CreateVertexBuffer(device, size,
            D3DUSAGE_DYNAMIC | D3DUSAGE_WRITEONLY, 0, D3DPOOL_DEFAULT, &buffer);
    ok(SUCCEEDED(hr), "Failed to create vertex buffer, hr %#lx.\n", hr);
    hr = IDirect3DVertexBuffer8_Lock(buffer, 0, size, (BYTE **)&quads, D3DLOCK_DISCARD);
    ok(SUCCEEDED(hr), "Failed to lock vertex buffer, hr %#lx.\n", hr);
    for (j = 0; j < size / sizeof(*quads); ++j)
    {
        quads[j] = quad1;
    }
    hr = IDirect3DVertexBuffer8_Unlock(buffer);
    ok(SUCCEEDED(hr), "Failed to unlock vertex buffer, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_DIFFUSE);
    ok(SUCCEEDED(hr), "Failed to set FVF, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetStreamSource(device, 0, buffer, sizeof(*quads->strip));
    ok(SUCCEEDED(hr), "Failed to set stream source, hr %#lx.\n", hr);

    /* Initial draw to initialise states, compile shaders, etc. */
    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xff0000ff, 0.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, 0, tri_count);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);
    /* Read the result to ensure the GPU has finished drawing. */
    colour = getPixelColor(device, 320, 240);

    /* Time drawing tri_count triangles. */
    ret = QueryPerformanceCounter(&ts[0]);
    ok(ret, "Failed to read performance counter.\n");
    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xff0000ff, 0.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, 0, tri_count);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);
    colour = getPixelColor(device, 320, 240);
    /* Time drawing a single triangle. */
    ret = QueryPerformanceCounter(&ts[1]);
    ok(ret, "Failed to read performance counter.\n");
    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xff0000ff, 0.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_BeginScene(device);
    ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, 0, 1);
    ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);
    colour = getPixelColor(device, 320, 240);
    ret = QueryPerformanceCounter(&ts[2]);
    ok(ret, "Failed to read performance counter.\n");

    IDirect3DVertexBuffer8_Release(buffer);

    /* Estimate the number of triangles we can draw in 100ms. */
    diff.QuadPart = ts[1].QuadPart - ts[0].QuadPart + ts[1].QuadPart - ts[2].QuadPart;
    tri_count = (tri_count * frequency.QuadPart) / (diff.QuadPart * 10);
    tri_count = ((tri_count + 2 + 3) & ~3) - 2;
    if (tri_count > caps.MaxPrimitiveCount)
    {
        skip("Would need to draw %u triangles, but the device only supports %lu primitives.\n",
                tri_count, caps.MaxPrimitiveCount);
        goto done;
    }
    size = (tri_count + 2) * sizeof(*quad1.strip);

    for (i = 0; i < ARRAY_SIZE(tests); ++i)
    {
        hr = IDirect3DDevice8_CreateVertexBuffer(device, size,
                D3DUSAGE_DYNAMIC | D3DUSAGE_WRITEONLY, 0, D3DPOOL_DEFAULT, &buffer);
        ok(SUCCEEDED(hr), "Failed to create vertex buffer, hr %#lx.\n", hr);
        hr = IDirect3DVertexBuffer8_Lock(buffer, 0, size, (BYTE **)&quads, D3DLOCK_DISCARD);
        ok(SUCCEEDED(hr), "Failed to lock vertex buffer, hr %#lx.\n", hr);
        for (j = 0; j < size / sizeof(*quads); ++j)
        {
            quads[j] = quad1;
        }
        hr = IDirect3DVertexBuffer8_Unlock(buffer);
        ok(SUCCEEDED(hr), "Failed to unlock vertex buffer, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_SetStreamSource(device, 0, buffer, sizeof(*quads->strip));
        ok(SUCCEEDED(hr), "Failed to set stream source, hr %#lx.\n", hr);

        /* Start a draw operation. */
        hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xff0000ff, 0.0f, 0);
        ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_BeginScene(device);
        ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, 0, tri_count);
        ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_EndScene(device);
        ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

        /* Map the last quad while the draw is in progress. */
        hr = IDirect3DVertexBuffer8_Lock(buffer, size - sizeof(quad2),
                sizeof(quad2), (BYTE **)&quads, tests[i].flags);
        ok(SUCCEEDED(hr), "Failed to lock vertex buffer, hr %#lx.\n", hr);
        *quads = quad2;
        hr = IDirect3DVertexBuffer8_Unlock(buffer);
        ok(SUCCEEDED(hr), "Failed to unlock vertex buffer, hr %#lx.\n", hr);

        colour = getPixelColor(device, 320, 240);
        unsynchronised = color_match(colour, D3DCOLOR_ARGB(0x00, 0xff, 0xff, 0x00), 1);
        ok(tests[i].unsynchronised == unsynchronised, "Expected %s map for flags %#x.\n",
                tests[i].unsynchronised ? "unsynchronised" : "synchronised", tests[i].flags);

        hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
        ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

        IDirect3DVertexBuffer8_Release(buffer);
    }

done:
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_viewport(void)
{
    static const struct
    {
        D3DVIEWPORT8 vp;
        RECT expected_rect;
        const char *message;
    }
    tests[] =
    {
        {{  0,   0,  640,  480}, {  0, 120, 479, 359}, "Viewport (0, 0) - (640, 480)"},
        {{  0,   0,  320,  240}, {  0,  60, 239, 179}, "Viewport (0, 0) - (320, 240)"},
        {{  0,   0, 1280,  960}, {  0, 240, 639, 479}, "Viewport (0, 0) - (1280, 960)"},
        {{  0,   0, 2000, 1600}, {-10, -10, -10, -10}, "Viewport (0, 0) - (2000, 1600)"},
        {{100, 100,  640,  480}, {100, 220, 579, 459}, "Viewport (100, 100) - (640, 480)"},
        {{  0,   0, 8192, 8192}, {-10, -10, -10, -10}, "Viewport (0, 0) - (8192, 8192)"},
    };
    static const struct vec3 quad[] =
    {
        {-1.5f, -0.5f, 0.1f},
        {-1.5f,  0.5f, 0.1f},
        { 0.5f, -0.5f, 0.1f},
        { 0.5f,  0.5f, 0.1f},
    };
    static const struct vec2 rt_sizes[] =
    {
        {640, 480}, {1280, 960}, {320, 240}, {800, 600},
    };
    struct surface_readback rb;
    IDirect3DDevice8 *device;
    IDirect3DSurface8 *rt;
    unsigned int i, j;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZENABLE, D3DZB_FALSE);
    ok(SUCCEEDED(hr), "Failed to disable depth test, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(SUCCEEDED(hr), "Failed to disable lighting, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ);
    ok(SUCCEEDED(hr), "Failed to set FVF, hr %#lx.\n", hr);

    /* This crashes on Windows. */
    /* hr = IDirect3DDevice8_SetViewport(device, NULL); */

    for (i = 0; i < ARRAY_SIZE(rt_sizes); ++i)
    {
        if (i)
        {
            hr = IDirect3DDevice8_CreateRenderTarget(device, rt_sizes[i].x, rt_sizes[i].y,
                    D3DFMT_A8R8G8B8, D3DMULTISAMPLE_NONE, TRUE, &rt);
            ok(SUCCEEDED(hr), "Failed to create render target, hr %#lx (i %u).\n", hr, i);
            hr = IDirect3DDevice8_SetRenderTarget(device, rt, NULL);
            ok(SUCCEEDED(hr), "Failed to set render target, hr %#lx (i %u).\n", hr, i);
        }
        else
        {
            hr = IDirect3DDevice8_GetBackBuffer(device, 0, D3DBACKBUFFER_TYPE_MONO, &rt);
            ok(SUCCEEDED(hr), "Failed to get backbuffer, hr %#lx.\n", hr);
        }

        for (j = 0; j < ARRAY_SIZE(tests); ++j)
        {
            hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xff000000, 1.0f, 0);
            ok(SUCCEEDED(hr), "Failed to clear, hr %#lx (i %u, j %u).\n", hr, i, j);

            hr = IDirect3DDevice8_SetViewport(device, &tests[j].vp);
            if (tests[j].vp.X + tests[j].vp.Width > rt_sizes[i].x
                    || tests[j].vp.Y + tests[j].vp.Height > rt_sizes[i].y)
            {
                ok(hr == D3DERR_INVALIDCALL,
                        "Setting the viewport returned unexpected hr %#lx (i %u, j %u).\n", hr, i, j);
                continue;
            }
            else
            {
                ok(SUCCEEDED(hr), "Failed to set the viewport, hr %#lx (i %u, j %u).\n", hr, i, j);
            }

            hr = IDirect3DDevice8_BeginScene(device);
            ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx (i %u, j %u).\n", hr, i, j);
            hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(quad[0]));
            ok(SUCCEEDED(hr), "Got unexpected hr %#lx (i %u, j %u).\n", hr, i, j);
            hr = IDirect3DDevice8_EndScene(device);
            ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx (i %u, j %u).\n", hr, i, j);

            get_surface_readback(rt, &rb);
            check_rect(&rb, tests[j].expected_rect, tests[j].message);
            release_surface_readback(&rb);
        }

        IDirect3DSurface8_Release(rt);
    }

    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_color_vertex(void)
{
    IDirect3DDevice8 *device;
    unsigned int colour, i;
    D3DMATERIAL8 material;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    /* The idea here is to set up ambient light parameters in a way that the
     * ambient colour from the material is just passed through. The emissive
     * colour is just passed through anyway. The sum of ambient + emissive
     * should allow deduction of where the material colour came from.
     *
     * Note that in cases without a D3DFVF_DIFFUSE flag the first colour value
     * in the struct will be fed into the specular vertex colour slot. */
    static const struct
    {
        DWORD fvf, color_vertex, ambient, emissive;
        unsigned int result;
    }
    tests[] =
    {
        {D3DFVF_DIFFUSE | D3DFVF_SPECULAR, FALSE, D3DMCS_COLOR1,   D3DMCS_COLOR2,   0x000000c0},

        {D3DFVF_DIFFUSE | D3DFVF_SPECULAR, TRUE,  D3DMCS_COLOR1,   D3DMCS_COLOR2,   0x00ffff00},
        {D3DFVF_DIFFUSE | D3DFVF_SPECULAR, TRUE,  D3DMCS_MATERIAL, D3DMCS_COLOR2,   0x0000ff80},
        {D3DFVF_DIFFUSE | D3DFVF_SPECULAR, TRUE,  D3DMCS_COLOR1,   D3DMCS_MATERIAL, 0x00ff0040},
        {D3DFVF_DIFFUSE | D3DFVF_SPECULAR, TRUE,  D3DMCS_COLOR1,   D3DMCS_COLOR1,   0x00ff0000},
        {D3DFVF_DIFFUSE | D3DFVF_SPECULAR, TRUE,  D3DMCS_COLOR2,   D3DMCS_COLOR2,   0x0000ff00},

        {D3DFVF_SPECULAR,                  TRUE,  D3DMCS_COLOR1,   D3DMCS_COLOR2,   0x00ff0080},
        {D3DFVF_SPECULAR,                  TRUE,  D3DMCS_COLOR1,   D3DMCS_MATERIAL, 0x000000c0},
        {D3DFVF_SPECULAR,                  TRUE,  D3DMCS_MATERIAL, D3DMCS_COLOR2,   0x00ff0080},
        {D3DFVF_DIFFUSE,                   TRUE,  D3DMCS_COLOR1,   D3DMCS_COLOR2,   0x00ff0040},
        {D3DFVF_DIFFUSE,                   TRUE,  D3DMCS_COLOR1,   D3DMCS_MATERIAL, 0x00ff0040},
        {D3DFVF_DIFFUSE,                   TRUE,  D3DMCS_COLOR2,   D3DMCS_MATERIAL, 0x000000c0},

        {0,                                TRUE,  D3DMCS_COLOR1,   D3DMCS_COLOR2,   0x000000c0},
    };
    static const struct
    {
        struct vec3 position;
        DWORD diffuse;
        DWORD specular;
    }
    quad[] =
    {
        {{-1.0f, -1.0f, 0.0f}, 0xffff0000, 0xff00ff00},
        {{-1.0f,  1.0f, 0.0f}, 0xffff0000, 0xff00ff00},
        {{ 1.0f, -1.0f, 0.0f}, 0xffff0000, 0xff00ff00},
        {{ 1.0f,  1.0f, 0.0f}, 0xffff0000, 0xff00ff00},
    };

    window = create_window();
    ok(!!window, "Failed to create a window.\n");

    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, TRUE);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_AMBIENT, 0xffffffff);
    ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);

    memset(&material, 0, sizeof(material));
    material.Ambient.b = 0.5f;
    material.Emissive.b = 0.25f;
    hr = IDirect3DDevice8_SetMaterial(device, &material);
    ok(SUCCEEDED(hr), "Failed to set material, hr %#lx\n", hr);

    for (i = 0; i < ARRAY_SIZE(tests); ++i)
    {
        hr = IDirect3DDevice8_SetRenderState(device, D3DRS_COLORVERTEX, tests[i].color_vertex);
        ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetRenderState(device, D3DRS_AMBIENTMATERIALSOURCE, tests[i].ambient);
        ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetRenderState(device, D3DRS_EMISSIVEMATERIALSOURCE, tests[i].emissive);
        ok(SUCCEEDED(hr), "Failed to set render state, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | tests[i].fvf);
        ok(SUCCEEDED(hr), "Failed to set vertex format, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0x77777777, 0.0f, 0);
        ok(SUCCEEDED(hr), "Failed to clear depth/stencil, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_BeginScene(device);
        ok(SUCCEEDED(hr), "Failed to begin scene, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(*quad));
        ok(SUCCEEDED(hr), "Failed to draw, hr %#lx.\n", hr);
        hr = IDirect3DDevice8_EndScene(device);
        ok(SUCCEEDED(hr), "Failed to end scene, hr %#lx.\n", hr);

        colour = getPixelColor(device, 320, 240);
        ok(color_match(colour, tests[i].result, 1),
                "Expected colour 0x%08x for test %u, got 0x%08x.\n",
                tests[i].result, i, colour);
    }

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_sysmem_draw(void)
{
    IDirect3DVertexBuffer8 *vb, *vb_s0, *vb_s1, *dst_vb, *get_vb;
    D3DPRESENT_PARAMETERS present_parameters = {0};
    unsigned int colour, i, stride;
    IDirect3DTexture8 *texture;
    IDirect3DIndexBuffer8 *ib;
    IDirect3DDevice8 *device;
    struct vec4 *dst_data;
    D3DLOCKED_RECT lr;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;
    BYTE *data;
    DWORD vs;

    static const DWORD texture_data[4] = {0xffff0000, 0xff00ff00, 0xff0000ff, 0xffffffff};
    static const DWORD decl[] =
    {
        D3DVSD_STREAM(0),
        D3DVSD_REG(D3DVSDE_POSITION, D3DVSDT_FLOAT3),
        D3DVSD_STREAM(1),
        D3DVSD_REG(D3DVSDE_DIFFUSE, D3DVSDT_D3DCOLOR),
        D3DVSD_END()
    };
    static const struct
    {
        struct vec3 position;
        DWORD diffuse;
    }
    quad[] =
    {
        {{-0.5f, -0.5f, 0.0f}, 0xffff0000},
        {{-0.5f,  0.5f, 0.0f}, 0xff00ff00},
        {{ 0.5f, -0.5f, 0.0f}, 0xff0000ff},
        {{ 0.5f,  0.5f, 0.0f}, 0xffffffff},
    };
    static const struct vec3 quad_s0[] =
    {
        {-1.0f, -1.0f, 0.0f},
        {-1.0f,  1.0f, 0.0f},
        { 1.0f, -1.0f, 0.0f},
        { 1.0f,  1.0f, 0.0f},

        {-1.0f, -1.0f, 0.0f},
        {-1.0f,  1.0f, 0.0f},
        { 1.0f, -1.0f, 0.0f},
        { 1.0f,  1.0f, 0.0f},
    };
    static const DWORD quad_s1[] =
    {
        0xffff0000,
        0xff00ff00,
        0xff0000ff,
        0xffffffff,

        0xff443322,
        0xff443322,
        0xff443322,
        0xff443322,
    };
    static const short indices[] = {5, 6, 7, 8, 0, 1, 2, 3};

    window = create_window();
    ok(!!window, "Failed to create a window.\n");

    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");

    present_parameters.BackBufferWidth = 640;
    present_parameters.BackBufferHeight = 480;
    present_parameters.BackBufferFormat = D3DFMT_A8R8G8B8;
    present_parameters.SwapEffect = D3DSWAPEFFECT_DISCARD;
    present_parameters.hDeviceWindow = window;
    present_parameters.Windowed = TRUE;
    present_parameters.EnableAutoDepthStencil = TRUE;
    present_parameters.AutoDepthStencilFormat = D3DFMT_D24S8;
    if (FAILED(hr = IDirect3D8_CreateDevice(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            window, D3DCREATE_MIXED_VERTEXPROCESSING, &present_parameters, &device)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CreateVertexBuffer(device, sizeof(quad), 0, 0, D3DPOOL_SYSTEMMEM, &vb);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DVertexBuffer8_Lock(vb, 0, sizeof(quad), &data, 0);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    memcpy(data, quad, sizeof(quad));
    hr = IDirect3DVertexBuffer8_Unlock(vb);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0x77777777, 0.0f, 0);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_DIFFUSE);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetStreamSource(device, 0, vb, sizeof(*quad));
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, 0, 2);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    colour = getPixelColor(device, 320, 240);
    ok(color_match(colour, 0x00007f7f, 1), "Got unexpected colour 0x%08x.\n", colour);

    hr = IDirect3DDevice8_CreateVertexBuffer(device, ARRAY_SIZE(quad) * sizeof(*dst_data),
            0, D3DFVF_XYZRHW, D3DPOOL_SYSTEMMEM, &dst_vb);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_SOFTWAREVERTEXPROCESSING, TRUE);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_DIFFUSE);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetStreamSource(device, 0, vb, sizeof(*quad));
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_ProcessVertices(device, 0, 0, ARRAY_SIZE(quad), dst_vb, 0);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DVertexBuffer8_Lock(dst_vb, 0, 0, (BYTE **)&dst_data, 0);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    for (i = 0; i < ARRAY_SIZE(quad); ++i)
    {
        ok(compare_vec4(&dst_data[i], quad[i].position.x * 320.0f + 320.0f,
                -quad[i].position.y * 240.0f + 240.0f, 0.0f, 1.0f, 4),
                "Got unexpected vertex %u {%.8e, %.8e, %.8e, %.8e}.\n",
                i, dst_data[i].x, dst_data[i].y, dst_data[i].z, dst_data[i].w);
    }
    hr = IDirect3DVertexBuffer8_Unlock(dst_vb);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_SOFTWAREVERTEXPROCESSING, FALSE);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_DIFFUSE);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetStreamSource(device, 0, vb, sizeof(*quad));
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CreateIndexBuffer(device, sizeof(indices), 0,
            D3DFMT_INDEX16, D3DPOOL_SYSTEMMEM, &ib);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DIndexBuffer8_Lock(ib, 0, sizeof(indices), &data, 0);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    memcpy(data, indices, sizeof(indices));
    hr = IDirect3DIndexBuffer8_Unlock(ib);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0x77777777, 0.0f, 0);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetIndices(device, ib, 0);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawIndexedPrimitive(device, D3DPT_TRIANGLESTRIP, 0, 4, 4, 2);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    colour = getPixelColor(device, 320, 240);
    ok(color_match(colour, 0x00007f7f, 1), "Got unexpected colour 0x%08x.\n", colour);

    hr = IDirect3DDevice8_CreateVertexShader(device, decl, NULL, &vs, 0);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetVertexShader(device, vs);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CreateVertexBuffer(device, sizeof(quad_s0), 0, 0, D3DPOOL_SYSTEMMEM, &vb_s0);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DVertexBuffer8_Lock(vb_s0, 0, sizeof(quad_s0), &data, 0);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    memcpy(data, quad_s0, sizeof(quad_s0));
    hr = IDirect3DVertexBuffer8_Unlock(vb_s0);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateVertexBuffer(device, sizeof(quad_s1), 0, 0, D3DPOOL_SYSTEMMEM, &vb_s1);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DVertexBuffer8_Lock(vb_s1, 0, sizeof(quad_s1), &data, 0);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    memcpy(data, quad_s1, sizeof(quad_s1));
    hr = IDirect3DVertexBuffer8_Unlock(vb_s1);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetStreamSource(device, 0, vb_s0, sizeof(*quad_s0));
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetStreamSource(device, 1, vb_s1, sizeof(*quad_s1));
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0x77777777, 0.0f, 0);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawIndexedPrimitive(device, D3DPT_TRIANGLESTRIP, 0, 4, 4, 2);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    colour = getPixelColor(device, 320, 240);
    ok(color_match(colour, 0x00007f7f, 1), "Got unexpected colour 0x%08x.\n", colour);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0x77777777, 0.0f, 0);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetIndices(device, ib, 4);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawIndexedPrimitive(device, D3DPT_TRIANGLESTRIP, 0, 5, 4, 2);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    colour = getPixelColor(device, 320, 240);
    ok(color_match(colour, 0x00443322, 1), "Got unexpected colour 0x%08x.\n", colour);

    /* Test that releasing but not unbinding a vertex buffer doesn't break. */
    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_DIFFUSE);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetStreamSource(device, 0, vb, sizeof(*quad));
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetIndices(device, ib, 0);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    refcount = IDirect3DVertexBuffer8_Release(vb_s1);
    ok(!refcount, "Unexpected refcount %lu.\n", refcount);
    hr = IDirect3DDevice8_GetStreamSource(device, 1, &get_vb, &stride);
    ok(SUCCEEDED(hr), "Got unexpected hr %#lx.\n", hr);
    ok(get_vb == vb_s1, "Got unexpected vertex buffer %p.\n", get_vb);
    refcount = IDirect3DVertexBuffer8_Release(get_vb);
    ok(!refcount, "Unexpected refcount %lu.\n", refcount);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0x77777777, 0.0f, 0);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawIndexedPrimitive(device, D3DPT_TRIANGLESTRIP, 0, 4, 4, 2);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    colour = getPixelColor(device, 320, 240);
    ok(color_match(colour, 0x00007f7f, 1), "Got unexpected colour 0x%08x.\n", colour);

    hr = IDirect3DDevice8_SetVertexShader(device, vs);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetStreamSource(device, 0, vb_s0, sizeof(*quad_s0));
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0x77777777, 0.0f, 0);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawIndexedPrimitive(device, D3DPT_TRIANGLESTRIP, 0, 4, 4, 2);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    colour = getPixelColor(device, 320, 240);
    ok(color_match(colour, 0x00007f7f, 1), "Got unexpected colour 0x%08x.\n", colour);

    hr = IDirect3DDevice8_CreateTexture(device, 2, 2, 1, 0, D3DFMT_A8R8G8B8, D3DPOOL_SYSTEMMEM, &texture);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    memset(&lr, 0, sizeof(lr));
    hr = IDirect3DTexture8_LockRect(texture, 0, &lr, NULL, 0);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    memcpy(lr.pBits, texture_data, sizeof(texture_data));
    hr = IDirect3DTexture8_UnlockRect(texture, 0);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *)texture);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0x77777777, 0.0f, 0);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, 0, 2);
    ok(hr == D3D_OK || hr == E_FAIL, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    IDirect3DTexture8_Release(texture);
    IDirect3DVertexBuffer8_Release(vb_s0);
    IDirect3DDevice8_DeleteVertexShader(device, vs);
    IDirect3DIndexBuffer8_Release(ib);
    IDirect3DVertexBuffer8_Release(dst_vb);
    IDirect3DVertexBuffer8_Release(vb);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_alphatest(void)
{
#define ALPHATEST_PASSED 0x0000ff00
#define ALPHATEST_FAILED 0x00ff0000
    IDirect3DDevice8 *device;
    unsigned int color, i, j;
    IDirect3D8 *d3d;
    ULONG refcount;
    D3DCAPS8 caps;
    DWORD value;
    HWND window;
    HRESULT hr;
    DWORD ps;

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
    static const struct
    {
        struct vec3 position;
        DWORD diffuse;
    }
    quad[] =
    {
        {{-1.0f, -1.0f, 0.1f}, ALPHATEST_PASSED | 0x80000000},
        {{-1.0f,  1.0f, 0.1f}, ALPHATEST_PASSED | 0x80000000},
        {{ 1.0f, -1.0f, 0.1f}, ALPHATEST_PASSED | 0x80000000},
        {{ 1.0f,  1.0f, 0.1f}, ALPHATEST_PASSED | 0x80000000},
    };

    window = create_window();
    ok(!!window, "Failed to create a window.\n");

    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");

    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        goto done;
    }

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0xff0000ff, 1.0f, 0);
    ok(hr == D3D_OK, "Failed to clear, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(hr == D3D_OK, "Failed to disable lighting, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ALPHATESTENABLE, TRUE);
    ok(hr == D3D_OK, "IDirect3DDevice8_SetRenderState, hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_DIFFUSE);
    ok(hr == D3D_OK, "IDirect3DDevice8_SetVertexShader failed, hr %#lx.\n", hr);

    ps = 0;
    for (j = 0; j < 2; ++j)
    {
        if (j == 1)
        {
            /* Try a pixel shader instead of fixed function. The wined3d code
             * may emulate the alpha test either for performance reasons
             * (floating point RTs) or to work around driver bugs (GeForce
             * 7x00 cards on MacOS). There may be a different codepath for ffp
             * and shader in this case, and the test should cover both. */
            static const DWORD shader_code[] =
            {
                0xffff0101,                                 /* ps_1_1           */
                0x00000001, 0x800f0000, 0x90e40000,         /* mov r0, v0       */
                0x0000ffff                                  /* end              */
            };
            memset(&caps, 0, sizeof(caps));
            hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
            ok(hr == D3D_OK, "IDirect3DDevice8_GetDeviceCaps failed, hr %#lx.\n", hr);
            if (caps.PixelShaderVersion < D3DPS_VERSION(1, 1))
                break;

            hr = IDirect3DDevice8_CreatePixelShader(device, shader_code, &ps);
            ok(hr == D3D_OK, "IDirect3DDevice8_CreatePixelShader failed, hr %#lx.\n", hr);
            hr = IDirect3DDevice8_SetPixelShader(device, ps);
            ok(hr == D3D_OK, "IDirect3DDevice8_SetPixelShader failed, hr %#lx.\n", hr);
        }

        for (i = 0; i < ARRAY_SIZE(test_data); ++i)
        {
            hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ALPHAFUNC, test_data[i].func);
            ok(hr == D3D_OK, "IDirect3DDevice8_SetRenderState failed, hr %#lx.\n", hr);

            hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, ALPHATEST_FAILED, 0.0f, 0);
            ok(hr == D3D_OK, "IDirect3DDevice8_Clear failed, hr %#lx.\n", hr);
            hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ALPHAREF, 0x70);
            ok(hr == D3D_OK, "IDirect3DDevice8_SetRenderState failed, hr %#lx.\n", hr);
            hr = IDirect3DDevice8_BeginScene(device);
            ok(hr == D3D_OK, "IDirect3DDevice8_BeginScene failed, hr %#lx.\n", hr);
            hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(*quad));
            ok(hr == D3D_OK, "IDirect3DDevice8_DrawPrimitiveUP failed, hr %#lx.\n", hr);
            hr = IDirect3DDevice8_EndScene(device);
            ok(hr == D3D_OK, "IDirect3DDevice8_EndScene failed, hr %#lx.\n", hr);
            color = getPixelColor(device, 320, 240);
            ok(color_match(color, test_data[i].color_greater, 0),
                    "Alphatest failed, color 0x%08x, expected 0x%08x, alpha > ref, func %u.\n",
                    color, test_data[i].color_greater, test_data[i].func);
            hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
            ok(hr == D3D_OK, "IDirect3DDevice8_Present failed, hr %#lx.\n", hr);

            hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, ALPHATEST_FAILED, 0.0f, 0);
            ok(hr == D3D_OK, "IDirect3DDevice8_Clear failed, hr %#lx.\n", hr);
            hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ALPHAREF, 0xff70);
            ok(hr == D3D_OK, "IDirect3DDevice8_SetRenderState failed, hr %#lx.\n", hr);
            hr = IDirect3DDevice8_GetRenderState(device, D3DRS_ALPHAREF, &value);
            ok(hr == D3D_OK, "IDirect3DDevice8_GetRenderState failed, hr %#lx.\n", hr);
            ok(value == 0xff70, "Unexpected D3DRS_ALPHAREF value %#lx.\n", value);
            hr = IDirect3DDevice8_BeginScene(device);
            ok(hr == D3D_OK, "IDirect3DDevice8_BeginScene failed, hr %#lx.\n", hr);
            hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(*quad));
            ok(hr == D3D_OK, "IDirect3DDevice8_DrawPrimitiveUP failed, hr %#lx.\n", hr);
            hr = IDirect3DDevice8_EndScene(device);
            ok(hr == D3D_OK, "IDirect3DDevice8_EndScene failed, hr %#lx.\n", hr);
            color = getPixelColor(device, 320, 240);
            ok(color_match(color, test_data[i].color_greater, 0),
                    "Alphatest failed, color 0x%08x, expected 0x%08x, alpha > ref, func %u.\n",
                    color, test_data[i].color_greater, test_data[i].func);
            hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
            ok(hr == D3D_OK, "IDirect3DDevice8_Present failed, hr %#lx.\n", hr);
        }
    }
    if (ps)
        IDirect3DDevice8_DeletePixelShader(device, ps);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
done:
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_desktop_window(void)
{
    IDirect3DDevice8 *device;
    unsigned int color;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }
    IDirect3DDevice8_Release(device);
    DestroyWindow(window);

    device = create_device(d3d, GetDesktopWindow(), GetDesktopWindow(), TRUE);
    ok(!!device, "Failed to create a D3D device.\n");

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xffff0000, 1.0f, 0);
    ok(SUCCEEDED(hr), "Failed to clear, hr %#lx.\n", hr);
    color = getPixelColor(device, 1, 1);
    ok(color == 0x00ff0000, "Got unexpected color 0x%08x.\n", color);

    hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
    ok(SUCCEEDED(hr), "Failed to present, hr %#lx.\n", hr);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);

    IDirect3D8_Release(d3d);
}

static void test_sample_mask(void)
{
    IDirect3DSurface8 *rt, *ms_rt;
    struct surface_readback rb;
    IDirect3DDevice8 *device;
    unsigned int colour;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;

    static const struct
    {
        struct vec3 position;
        DWORD diffuse;
    }
    quad[] =
    {
        {{-1.0f, -1.0f, 0.1f}, 0xffffffff},
        {{-1.0f,  1.0f, 0.1f}, 0xffffffff},
        {{ 1.0f, -1.0f, 0.1f}, 0xffffffff},
        {{ 1.0f,  1.0f, 0.1f}, 0xffffffff},
    };

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");

    if (FAILED(IDirect3D8_CheckDeviceMultiSampleType(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            D3DFMT_A8R8G8B8, TRUE, D3DMULTISAMPLE_2_SAMPLES)))
    {
        skip("Multisampling not supported for D3DFMT_A8R8G8B8.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a 3D device.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_CreateRenderTarget(device, 128, 128, D3DFMT_A8R8G8B8, D3DMULTISAMPLE_NONE, FALSE, &rt);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_CreateRenderTarget(device, 128, 128,
            D3DFMT_A8R8G8B8, D3DMULTISAMPLE_2_SAMPLES, FALSE, &ms_rt);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderTarget(device, ms_rt, NULL);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_MULTISAMPLEMASK, 0x5);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xffff0000, 0.0f, 0);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_DIFFUSE);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(quad[0]));
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_CopyRects(device, ms_rt, NULL, 0, rt, NULL);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    get_surface_readback(rt, &rb);
    colour = get_readback_color(&rb, 64, 64);
    /* Multiple generations of Nvidia cards return broken results.
     * A mask with no bits or all bits set produce the expected results (0x00 / 0xff),
     * but any other mask behaves almost as if the result is 0.5 + (enabled / total)
     * samples. It's not quite that though (you'd expect 0xbf or 0xc0 instead of 0xbc).
     *
     * I looked at a few other possible problems: Incorrectly enabled Z test, alpha test,
     * culling, the multisample mask affecting CopyRects. Neither of these make a difference. */
    ok(color_match(colour, 0xffff8080, 1) || broken(color_match(colour, 0xffffbcbc, 1)),
            "Got unexpected colour %08x.\n", colour);
    release_surface_readback(&rb);

    hr = IDirect3DDevice8_EndScene(device);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    IDirect3DSurface8_Release(ms_rt);
    IDirect3DSurface8_Release(rt);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

struct dynamic_vb_vertex
{
    struct vec3 position;
    DWORD diffuse;
};

static void fill_dynamic_vb_quad(struct dynamic_vb_vertex *quad, unsigned int x, unsigned int y)
{
    unsigned int i;

    memset(quad, 0, 4 * sizeof(*quad));

    quad[0].position.x = quad[1].position.x = -1.0f + 0.01f * x;
    quad[2].position.x = quad[3].position.x = -1.0f + 0.01f * (x + 1);

    quad[0].position.y = quad[2].position.y = -1.0f + 0.01f * y;
    quad[1].position.y = quad[3].position.y = -1.0f + 0.01f * (y + 1);

    for (i = 0; i < 4; ++i)
        quad[i].diffuse = 0xff00ff00;
}

static void test_dynamic_map_synchronization(void)
{
    IDirect3DVertexBuffer8 *buffer;
    IDirect3DDevice8 *device;
    IDirect3DSurface8 *rt;
    unsigned int x, y;
    IDirect3D8 *d3d;
    ULONG refcount;
    HWND window;
    HRESULT hr;
    BYTE *data;

    window = create_window();
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");
    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a D3D device, skipping tests.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_CreateVertexBuffer(device, 200 * 4 * sizeof(struct dynamic_vb_vertex),
            D3DUSAGE_DYNAMIC, D3DFVF_XYZ, D3DPOOL_DEFAULT, &buffer);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xffff0000, 0.0f, 0);
    ok(hr == D3D_OK, "Failed to clear, hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetStreamSource(device, 0, buffer, sizeof(struct dynamic_vb_vertex));
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZENABLE, FALSE);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_DIFFUSE);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    for (y = 0; y < 200; ++y)
    {
        hr = IDirect3DVertexBuffer8_Lock(buffer, 0, 0, &data, D3DLOCK_DISCARD);
        ok(hr == D3D_OK, "Failed to map buffer, hr %#lx.\n", hr);

        fill_dynamic_vb_quad((struct dynamic_vb_vertex *)data, 0, y);

        hr = IDirect3DVertexBuffer8_Unlock(buffer);
        ok(hr == D3D_OK, "Failed to map buffer, hr %#lx.\n", hr);

        hr = IDirect3DDevice8_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, 0, 2);
        ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

        for (x = 1; x < 200; ++x)
        {
            hr = IDirect3DVertexBuffer8_Lock(buffer, 4 * sizeof(struct dynamic_vb_vertex) * x,
                    4 * sizeof(struct dynamic_vb_vertex), &data, D3DLOCK_NOOVERWRITE);
            ok(hr == D3D_OK, "Failed to map buffer, hr %#lx.\n", hr);

            fill_dynamic_vb_quad((struct dynamic_vb_vertex *)data, x, y);

            hr = IDirect3DVertexBuffer8_Unlock(buffer);
            ok(hr == D3D_OK, "Failed to map buffer, hr %#lx.\n", hr);

            hr = IDirect3DDevice8_DrawPrimitive(device, D3DPT_TRIANGLESTRIP, 4 * x, 2);
            ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
        }
    }

    hr = IDirect3DDevice8_GetRenderTarget(device, &rt);
    ok(hr == S_OK, "Failed to get render target, hr %#lx.\n", hr);
    check_rt_color(rt, 0x0000ff00);
    IDirect3DSurface8_Release(rt);

    hr = IDirect3DDevice8_EndScene(device);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    IDirect3DVertexBuffer8_Release(buffer);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_filling_convention(void)
{
    static const DWORD colour_bottom = 0x00ffff00;
    static const DWORD colour_clear = 0x000000ff;
    static const DWORD colour_right = 0x00000000;
    static const DWORD colour_left = 0x00ff0000;
    static const DWORD colour_top = 0x0000ff00;
    unsigned int colour, expected, i, j, x, y;
    IDirect3DSurface8 *rt, *backbuffer, *cur;
    struct surface_readback rb;
    IDirect3DDevice8 *device;
    DWORD shader = 0;
    IDirect3D8 *d3d;
    ULONG refcount;
    D3DCAPS8 caps;
    HWND window;
    HRESULT hr;
    BOOL todo;

    static const unsigned int vp_size = 8;
    const D3DVIEWPORT8 vp = { 0, 0, vp_size, vp_size, 0.0, 1.0 };
    static const DWORD vs_code[] =
    {
        0xfffe0101,                                             /* vs_1_1               */
        0x00000001, 0xc00f0000, 0x90e40000,                     /* mov oPos, v0         */
        0x00000001, 0xd00f0000, 0x90e40005,                     /* mov oD0, v5          */
        0x0000ffff                                              /* end                  */
    };
    static const DWORD decl[] =
    {
        D3DVSD_STREAM(0),
        D3DVSD_REG(D3DVSDE_POSITION, D3DVSDT_FLOAT3),
        D3DVSD_REG(D3DVSDE_DIFFUSE, D3DVSDT_D3DCOLOR),
        D3DVSD_END()
    };

    /* This test data follows the examples in MSDN's
     * "Rasterization Rules (Direct3D 9)" article.
     *
     * See the d3d9 test for a comment about the eps value. */
    static const float eps = 1.0f / 64.0f;
    const struct
    {
        struct vec3 position;
        DWORD diffuse;
    }
    center_tris[] =
    {
        /* left */
        {{-2.5f / 4.0f, -1.5f / 4.0f, 0.0f}, colour_left},
        {{-2.5f / 4.0f,  2.5f / 4.0f, 0.0f}, colour_left},
        {{-1.5f / 4.0f,  0.5f / 4.0f, 0.0f}, colour_left},

        /* top */
        {{-1.5f / 4.0f,  0.5f / 4.0f, 0.0f}, colour_top},
        {{-2.5f / 4.0f,  2.5f / 4.0f, 0.0f}, colour_top},
        {{-0.5f / 4.0f,  2.5f / 4.0f, 0.0f}, colour_top},

        /* right */
        {{-0.5f / 4.0f, -1.5f / 4.0f, 0.0f}, colour_right},
        {{-1.5f / 4.0f,  0.5f / 4.0f, 0.0f}, colour_right},
        {{-0.5f / 4.0f,  2.5f / 4.0f, 0.0f}, colour_right},

        /* bottom */
        {{-2.5f / 4.0f, -1.5f / 4.0f, 0.0f}, colour_bottom},
        {{-1.5f / 4.0f,  0.5f / 4.0f, 0.0f}, colour_bottom},
        {{-0.5f / 4.0f, -1.5f / 4.0f, 0.0f}, colour_bottom},

    },
    edge_tris[] =
    {
        /* left */
        {{-2.0f / 4.0f, -1.0f / 4.0f, 0.0f}, colour_left},
        {{-2.0f / 4.0f,  3.0f / 4.0f, 0.0f}, colour_left},
        {{-1.0f / 4.0f,  1.0f / 4.0f, 0.0f}, colour_left},

        /* top */
        {{-1.0f / 4.0f,  1.0f / 4.0f, 0.0f}, colour_top},
        {{-2.0f / 4.0f,  3.0f / 4.0f, 0.0f}, colour_top},
        {{ 0.0f / 4.0f,  3.0f / 4.0f, 0.0f}, colour_top},

        /* right */
        {{ 0.0f / 4.0f, -1.0f / 4.0f, 0.0f}, colour_right},
        {{-1.0f / 4.0f,  1.0f / 4.0f, 0.0f}, colour_right},
        {{ 0.0f / 4.0f,  3.0f / 4.0f, 0.0f}, colour_right},

        /* bottom */
        {{-2.0f / 4.0f, -1.0f / 4.0f, 0.0f}, colour_bottom},
        {{-1.0f / 4.0f,  1.0f / 4.0f, 0.0f}, colour_bottom},
        {{ 0.0f / 4.0f, -1.0f / 4.0f, 0.0f}, colour_bottom},
    },
    nudge_right_tris[] =
    {
        /* left */
        {{eps - 2.0f / 4.0f, -1.0f / 4.0f, 0.0f}, colour_left},
        {{eps - 2.0f / 4.0f,  3.0f / 4.0f, 0.0f}, colour_left},
        {{eps - 1.0f / 4.0f,  1.0f / 4.0f, 0.0f}, colour_left},

        /* top */
        {{eps - 1.0f / 4.0f,  1.0f / 4.0f, 0.0f}, colour_top},
        {{eps - 2.0f / 4.0f,  3.0f / 4.0f, 0.0f}, colour_top},
        {{eps - 0.0f / 4.0f,  3.0f / 4.0f, 0.0f}, colour_top},

        /* right */
        {{eps - 0.0f / 4.0f, -1.0f / 4.0f, 0.0f}, colour_right},
        {{eps - 1.0f / 4.0f,  1.0f / 4.0f, 0.0f}, colour_right},
        {{eps - 0.0f / 4.0f,  3.0f / 4.0f, 0.0f}, colour_right},

        /* bottom */
        {{eps - 2.0f / 4.0f, -1.0f / 4.0f, 0.0f}, colour_bottom},
        {{eps - 1.0f / 4.0f,  1.0f / 4.0f, 0.0f}, colour_bottom},
        {{eps - 0.0f / 4.0f, -1.0f / 4.0f, 0.0f}, colour_bottom},
    },
    nudge_left_tris[] =
    {
        {{-eps - 2.0f / 4.0f, -1.0f / 4.0f, 0.0f}, colour_left},
        {{-eps - 2.0f / 4.0f,  3.0f / 4.0f, 0.0f}, colour_left},
        {{-eps - 1.0f / 4.0f,  1.0f / 4.0f, 0.0f}, colour_left},

        /* top */
        {{-eps - 1.0f / 4.0f,  1.0f / 4.0f, 0.0f}, colour_top},
        {{-eps - 2.0f / 4.0f,  3.0f / 4.0f, 0.0f}, colour_top},
        {{-eps - 0.0f / 4.0f,  3.0f / 4.0f, 0.0f}, colour_top},

        /* right */
        {{-eps - 0.0f / 4.0f, -1.0f / 4.0f, 0.0f}, colour_right},
        {{-eps - 1.0f / 4.0f,  1.0f / 4.0f, 0.0f}, colour_right},
        {{-eps - 0.0f / 4.0f,  3.0f / 4.0f, 0.0f}, colour_right},

        /* bottom */
        {{-eps - 2.0f / 4.0f, -1.0f / 4.0f, 0.0f}, colour_bottom},
        {{-eps - 1.0f / 4.0f,  1.0f / 4.0f, 0.0f}, colour_bottom},
        {{-eps - 0.0f / 4.0f, -1.0f / 4.0f, 0.0f}, colour_bottom},
    },
    nudge_top_tris[] =
    {
        /* left */
        {{-2.0f / 4.0f, eps - 1.0f / 4.0f, 0.0f}, colour_left},
        {{-2.0f / 4.0f, eps + 3.0f / 4.0f, 0.0f}, colour_left},
        {{-1.0f / 4.0f, eps + 1.0f / 4.0f, 0.0f}, colour_left},

        /* top */
        {{-1.0f / 4.0f, eps + 1.0f / 4.0f, 0.0f}, colour_top},
        {{-2.0f / 4.0f, eps + 3.0f / 4.0f, 0.0f}, colour_top},
        {{ 0.0f / 4.0f, eps + 3.0f / 4.0f, 0.0f}, colour_top},

        /* right */
        {{ 0.0f / 4.0f, eps - 1.0f / 4.0f, 0.0f}, colour_right},
        {{-1.0f / 4.0f, eps + 1.0f / 4.0f, 0.0f}, colour_right},
        {{ 0.0f / 4.0f, eps + 3.0f / 4.0f, 0.0f}, colour_right},

        /* bottom */
        {{-2.0f / 4.0f, eps - 1.0f / 4.0f, 0.0f}, colour_bottom},
        {{-1.0f / 4.0f, eps + 1.0f / 4.0f, 0.0f}, colour_bottom},
        {{ 0.0f / 4.0f, eps - 1.0f / 4.0f, 0.0f}, colour_bottom},
    },
    nudge_bottom_tris[] =
    {
        /* left */
        {{-2.0f / 4.0f, -eps - 1.0f / 4.0f, 0.0f}, colour_left},
        {{-2.0f / 4.0f, -eps + 3.0f / 4.0f, 0.0f}, colour_left},
        {{-1.0f / 4.0f, -eps + 1.0f / 4.0f, 0.0f}, colour_left},

        /* top */
        {{-1.0f / 4.0f, -eps + 1.0f / 4.0f, 0.0f}, colour_top},
        {{-2.0f / 4.0f, -eps + 3.0f / 4.0f, 0.0f}, colour_top},
        {{ 0.0f / 4.0f, -eps + 3.0f / 4.0f, 0.0f}, colour_top},

        /* right */
        {{ 0.0f / 4.0f, -eps - 1.0f / 4.0f, 0.0f}, colour_right},
        {{-1.0f / 4.0f, -eps + 1.0f / 4.0f, 0.0f}, colour_right},
        {{ 0.0f / 4.0f, -eps + 3.0f / 4.0f, 0.0f}, colour_right},

        /* bottom */
        {{-2.0f / 4.0f, -eps - 1.0f / 4.0f, 0.0f}, colour_bottom},
        {{-1.0f / 4.0f, -eps + 1.0f / 4.0f, 0.0f}, colour_bottom},
        {{ 0.0f / 4.0f, -eps - 1.0f / 4.0f, 0.0f}, colour_bottom},
    };

    const struct
    {
        struct vec4 position;
        DWORD diffuse;
    }
    center_tris_t[] =
    {
        /* left */
        {{ 1.5f,  1.5f, 0.0f, 1.0f}, colour_left},
        {{ 2.5f,  3.5f, 0.0f, 1.0f}, colour_left},
        {{ 1.5f,  5.5f, 0.0f, 1.0f}, colour_left},

        /* top */
        {{ 1.5f,  1.5f, 0.0f, 1.0f}, colour_top},
        {{ 3.5f,  1.5f, 0.0f, 1.0f}, colour_top},
        {{ 2.5f,  3.5f, 0.0f, 1.0f}, colour_top},

        /* right */
        {{ 3.5f,  1.5f, 0.0f, 1.0f}, colour_right},
        {{ 3.5f,  5.5f, 0.0f, 1.0f}, colour_right},
        {{ 2.5f,  3.5f, 0.0f, 1.0f}, colour_right},

        /* bottom */
        {{ 2.5f,  3.5f, 0.0f, 1.0f}, colour_bottom},
        {{ 3.5f,  5.5f, 0.0f, 1.0f}, colour_bottom},
        {{ 1.5f,  5.5f, 0.0f, 1.0f}, colour_bottom},
    },
    edge_tris_t[] =
    {
        /* left */
        {{ 2.0f,  1.0f, 0.0f, 1.0f}, colour_left},
        {{ 3.0f,  3.0f, 0.0f, 1.0f}, colour_left},
        {{ 2.0f,  5.0f, 0.0f, 1.0f}, colour_left},

        /* top */
        {{ 2.0f,  1.0f, 0.0f, 1.0f}, colour_top},
        {{ 4.0f,  1.0f, 0.0f, 1.0f}, colour_top},
        {{ 3.0f,  3.0f, 0.0f, 1.0f}, colour_top},

        /* right */
        {{ 4.0f,  1.0f, 0.0f, 1.0f}, colour_right},
        {{ 4.0f,  5.0f, 0.0f, 1.0f}, colour_right},
        {{ 3.0f,  3.0f, 0.0f, 1.0f}, colour_right},

        /* bottom */
        {{ 3.0f,  3.0f, 0.0f, 1.0f}, colour_bottom},
        {{ 4.0f,  5.0f, 0.0f, 1.0f}, colour_bottom},
        {{ 2.0f,  5.0f, 0.0f, 1.0f}, colour_bottom},
    };

    const struct
    {
        const void *geometry;
        size_t stride;
        DWORD fvf;
        const char *expected[8];
    }
    tests[] =
    {
        {
            center_tris,
            sizeof(center_tris[0]),
            D3DFVF_XYZ | D3DFVF_DIFFUSE,
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
            sizeof(edge_tris[0]),
            D3DFVF_XYZ | D3DFVF_DIFFUSE,
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
            sizeof(nudge_right_tris[0]),
            D3DFVF_XYZ | D3DFVF_DIFFUSE,
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
            sizeof(nudge_left_tris[0]),
            D3DFVF_XYZ | D3DFVF_DIFFUSE,
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
            sizeof(nudge_top_tris[0]),
            D3DFVF_XYZ | D3DFVF_DIFFUSE,
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
            sizeof(nudge_bottom_tris[0]),
            D3DFVF_XYZ | D3DFVF_DIFFUSE,
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
            sizeof(center_tris_t[0]),
            D3DFVF_XYZRHW | D3DFVF_DIFFUSE,
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
            sizeof(edge_tris_t[0]),
            D3DFVF_XYZRHW | D3DFVF_DIFFUSE,
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
    d3d = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!d3d, "Failed to create a D3D object.\n");

    if (!(device = create_device(d3d, window, window, TRUE)))
    {
        skip("Failed to create a 3D device.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_CreateRenderTarget(device, vp_size, vp_size,
            D3DFMT_A8R8G8B8, D3DMULTISAMPLE_NONE, FALSE, &rt);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_GetBackBuffer(device, 0, D3DBACKBUFFER_TYPE_MONO, &backbuffer);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    if (caps.VertexShaderVersion >= D3DVS_VERSION(1, 1))
    {
        hr = IDirect3DDevice8_CreateVertexShader(device, decl, vs_code, &shader, 0);
        ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    }
    else
        skip("Skipping vertex shader codepath in filling convention test.\n");

    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZENABLE, D3DZB_FALSE);
    ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

    for (i = 0; i < ARRAY_SIZE(tests); ++i)
    {
        /* Run tests with shader and fixed function vertex processing if shaders are
         * supported. There's no point in running the XYZRHW tests with a VS though. */
        if (shader && ((tests[i].fvf & D3DFVF_POSITION_MASK) == D3DFVF_XYZ))
            j = 0;
        else
            j = 2;

        for (; j < 4; ++j)
        {
            cur = (j & 1) ? rt : backbuffer;

            hr = IDirect3DDevice8_SetVertexShader(device, (j & 2) ? tests[i].fvf : shader);
            ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

            hr = IDirect3DDevice8_SetRenderTarget(device, cur, NULL);
            ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
            hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, colour_clear, 0.0f, 0);
            ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
            hr = IDirect3DDevice8_SetViewport(device, &vp);
            ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

            hr = IDirect3DDevice8_BeginScene(device);
            ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
            hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLELIST, 4, tests[i].geometry, tests[i].stride);
            ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
            hr = IDirect3DDevice8_EndScene(device);
            ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);

            get_surface_readback(cur, &rb);
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
                    colour = get_readback_color(&rb, x, y);
                    /* The nudge-to-bottom test fails on cards that give us a bottom-left
                     * filling convention. The cause isn't the bottom part of the filling
                     * convention, but because wined3d will nudge geometry to the left to
                     * keep diagonals (the 'R' in test case 'edge_tris') intact. */
                    todo_wine_if(todo && !color_match(colour, expected, 1))
                        ok(color_match(colour, expected, 1), "Got unexpected colour %08x, %ux%u, case %u, j %u.\n",
                                colour, x, y, i, j);
                }
            }
            release_surface_readback(&rb);

            /* IDirect3DDevice8::CopyRects can't stretch, so don't bother making the offscreen surface
             * visible. Use the d3d9 test if you need to see visual output. */
            hr = IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
            ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
        }
    }

    if (shader)
        IDirect3DDevice8_DeleteVertexShader(device, shader);
    IDirect3DSurface8_Release(backbuffer);
    IDirect3DSurface8_Release(rt);
    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

static void test_managed_reset(void)
{
    struct d3d8_test_context context;
    IDirect3DTexture8 *texture;
    IDirect3DDevice8 *device;
    HRESULT hr;

    if (!init_test_context(&context))
        return;
    device = context.device;

    hr = IDirect3DDevice8_CreateTexture(device, 256, 256, 1, 0, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED, &texture);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    fill_texture(texture, 0x0000ff00, 0);

    draw_textured_quad(&context, texture);
    check_rt_color(context.backbuffer, 0x0000ff00);

    hr = reset_device(&context);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xffff0000, 0.0, 0);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    draw_textured_quad(&context, texture);
    check_rt_color(context.backbuffer, 0x0000ff00);

    IDirect3DTexture8_Release(texture);
    release_test_context(&context);
}

/* Some applications (Vivisector, Cryostasis) lock a mipmapped managed texture
 * at level 0, write every level at once, and expect it to be uploaded. */
static void test_mipmap_upload(void)
{
    unsigned int j, width, level_count;
    struct d3d8_test_context context;
    IDirect3DTexture8 *texture;
    D3DLOCKED_RECT locked_rect;
    IDirect3DDevice8 *device;
    unsigned int *mem;
    HRESULT hr;

    if (!init_test_context(&context))
        return;
    device = context.device;

    hr = IDirect3DDevice8_CreateTexture(device, 32, 32, 0, 0,
            D3DFMT_A8R8G8B8, D3DPOOL_MANAGED, &texture);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    level_count = IDirect3DBaseTexture8_GetLevelCount(texture);

    hr = IDirect3DTexture8_LockRect(texture, 0, &locked_rect, NULL, 0);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    mem = locked_rect.pBits;

    for (j = 0; j < level_count; ++j)
    {
        width = 32 >> j;
        memset(mem, 0x11 * (j + 1), width * width * 4);
        mem += width * width;
    }

    hr = IDirect3DTexture8_UnlockRect(texture, 0);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    for (j = 0; j < level_count; ++j)
    {
        winetest_push_context("level %u", j);

        hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xffff0000, 0.0, 0);
        ok(hr == S_OK, "Got hr %#lx.\n", hr);

        hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_MIPFILTER, D3DTEXF_POINT);
        ok(hr == S_OK, "Got hr %#lx.\n", hr);
        hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_MAXMIPLEVEL, j);
        ok(hr == S_OK, "Got hr %#lx.\n", hr);

        draw_textured_quad(&context, texture);
        check_rt_color(context.backbuffer, 0x00111111 * (j + 1));

        winetest_pop_context();
    }

    IDirect3DTexture8_Release(texture);
    release_test_context(&context);
}

static void test_specular_shaders(void)
{
    struct d3d8_test_context context;
    struct surface_readback rb;
    IDirect3DDevice8 *device;
    unsigned int color;
    DWORD vs, ps;
    HRESULT hr;

    static const DWORD vs_code[] =
    {
#if 0
        vs_1_1
        mov oPos, v0
        mov oD0, v5
        mov oD1, v6
#endif
        0xfffe0101,
        0x00000001, 0xc00f0000, 0x90e40000,
        0x00000001, 0xd00f0000, 0x90e40005,
        0x00000001, 0xd00f0001, 0x90e40006,
        0x0000ffff
    };

    static const DWORD ps_code[] =
    {
#if 0
        ps_1_1
        mov r0, v1
#endif
        0xffff0101,
        0x00000001, 0x800f0000, 0x90e40001,
        0x0000ffff
    };

    static const DWORD decl[] =
    {
        D3DVSD_STREAM(0),
        D3DVSD_REG(D3DVSDE_POSITION, D3DVSDT_FLOAT3),
        D3DVSD_REG(D3DVSDE_NORMAL, D3DVSDT_FLOAT3),
        D3DVSD_REG(D3DVSDE_DIFFUSE, D3DVSDT_D3DCOLOR),
        D3DVSD_REG(D3DVSDE_SPECULAR, D3DVSDT_D3DCOLOR),
        D3DVSD_END()
    };

    static const struct
    {
        struct vec3 position;
        struct vec3 normal;
        unsigned int diffuse;
        unsigned int specular;
    }
    quad[] =
    {
        {{-1.0f, -1.0f, 0.0f}, {1.0f, 1.0f, 1.0f}, 0x0000003f, 0x00007f00},
        {{-1.0f,  1.0f, 0.0f}, {1.0f, 1.0f, 1.0f}, 0x0000003f, 0x00007f00},
        {{ 1.0f, -1.0f, 0.0f}, {1.0f, 1.0f, 1.0f}, 0x0000003f, 0x00007f00},
        {{ 1.0f,  1.0f, 0.0f}, {1.0f, 1.0f, 1.0f}, 0x0000003f, 0x00007f00},
    };

    static const D3DMATERIAL8 material =
    {
        .Specular = {0.7f, 0.0f, 0.7f, 1.0f},
        .Power = 2.0f,
    };

    static const D3DLIGHT8 light =
    {
        .Type = D3DLIGHT_DIRECTIONAL,
        .Diffuse = {0.0f, 0.1f, 0.1f, 0.0f},
        .Specular = {0.8f, 0.8f, 0.8f, 0.0f},
        .Direction = {0.0f, 0.0f, -1.0f},
    };

    if (!init_test_context(&context))
        return;
    device = context.device;

    /* Vertex shader only. */

    hr = IDirect3DDevice8_CreateVertexShader(device, decl, vs_code, &vs, 0);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xffff0000, 0.0, 0);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetVertexShader(device, vs);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZENABLE, FALSE);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_SPECULARENABLE, TRUE);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(*quad));
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    check_rt_color(context.backbuffer, 0x00007f3f);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_SPECULARENABLE, FALSE);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(*quad));
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    check_rt_color(context.backbuffer, 0x0000003f);

    hr = IDirect3DDevice8_CreatePixelShader(device, ps_code, &ps);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    /* Pixel shader only. */

    hr = IDirect3DDevice8_SetPixelShader(device, ps);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_NORMAL | D3DFVF_DIFFUSE | D3DFVF_SPECULAR);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetMaterial(device, &material);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetLight(device, 0, &light);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_LightEnable(device, 0, TRUE);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_SPECULARENABLE, TRUE);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(*quad));
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    get_surface_readback(context.backbuffer, &rb);
    color = get_readback_color(&rb, 160, 120);
    ok(color_match(color, 0x003300, 1), "Got color %08x.\n", color);
    color = get_readback_color(&rb, 480, 120);
    ok(color_match(color, 0x001900, 1), "Got color %08x.\n", color);
    color = get_readback_color(&rb, 160, 360);
    ok(color_match(color, 0x009900, 1), "Got color %08x.\n", color);
    color = get_readback_color(&rb, 480, 360);
    ok(color_match(color, 0x003300, 1), "Got color %08x.\n", color);
    release_surface_readback(&rb);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_SPECULARENABLE, FALSE);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(*quad));
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    check_rt_color(context.backbuffer, 0x00007f00);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_SPECULARMATERIALSOURCE, D3DMCS_MATERIAL);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(*quad));
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    check_rt_color(context.backbuffer, 0x00007f00);

    /* Vertex shader and pixel shader. */

    hr = IDirect3DDevice8_SetVertexShader(device, vs);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_SPECULARENABLE, TRUE);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(*quad));
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    check_rt_color(context.backbuffer, 0x00007f00);

    hr = IDirect3DDevice8_BeginScene(device);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_SPECULARENABLE, FALSE);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 2, quad, sizeof(*quad));
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    check_rt_color(context.backbuffer, 0x00007f00);

    release_test_context(&context);
}

/* A test to show that lights are affected by the view matrix but not the world
 * matrix, and to make sure that lighting is invalidated when the view matrix
 * (and nothing else) changes. */
static void test_lighting_matrices(void)
{
    struct d3d8_test_context context;
    struct surface_readback rb;
    IDirect3DDevice8 *device;
    unsigned int color;
    HRESULT hr;

    static const D3DMATERIAL8 material = {.Power = 1.0f};

    static const D3DLIGHT8 light =
    {
        .Type = D3DLIGHT_SPOT,
        .Diffuse = {1.0f, 1.0f, 1.0f, 1.0f},
        .Specular = {1.0f, 1.0f, 1.0f, 1.0f},
        .Position = {2.0f, -2.0f, 2.0f},
        .Direction = {1.0f, 1.0f, -0.5f},
        .Range = 1000.0f,
        .Falloff = 1.0f,
        .Attenuation1 = 0.1f,
        .Theta = 1.0f,
        .Phi = 3.0f,
    };

    static const D3DMATRIX world_matrix =
    {{{
        0.5f, 0.0f, 0.0f, 0.0f,
        0.0f, 0.5f, 0.0f, 0.0f,
        0.0f, 0.0f, 0.5f, 0.0f,
        0.0f, 0.2f, 0.0f, 1.0f,
    }}};

    static const D3DMATRIX view_matrix =
    {{{
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.5f, 0.5f, 0.0f, 1.0f,
    }}};

    static const struct
    {
        struct vec3 position;
        struct vec3 normal;
        unsigned int diffuse;
        unsigned int specular;
    }
    tri[] =
    {
        {{ 2.0f, -2.0f, 0.5f}, {-0.3f, -0.4f, 0.4f}, 0x00ff0000, 0x0000ff00},
        {{-2.0f, -2.0f, 0.5f}, {-1.0f,  0.4f, 0.4f}, 0x00ff0000, 0x0000ff00},
        {{ 0.0f,  2.0f, 0.5f}, { 0.0f, -0.4f, 0.4f}, 0x00ff0000, 0x0000ff00},
    },
    tri2[] =
    {
        {{ 1.0f, -3.0f, 0.5f}, {-0.3f, -0.4f, 0.4f}, 0x00ff0000, 0x0000ff00},
        {{-3.0f, -3.0f, 0.5f}, {-1.0f,  0.4f, 0.4f}, 0x00ff0000, 0x0000ff00},
        {{-1.0f,  1.0f, 0.5f}, { 0.0f, -0.4f, 0.4f}, 0x00ff0000, 0x0000ff00},
    };

    if (!init_test_context(&context))
        return;
    device = context.device;

    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_NORMAL | D3DFVF_DIFFUSE | D3DFVF_SPECULAR);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetMaterial(device, &material);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetLight(device, 123, &light);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_LightEnable(device, 123, TRUE);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_SPECULARENABLE, TRUE);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTransform(device, D3DTS_WORLD, &world_matrix);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0x00000000, 1.0f, 0);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_BeginScene(device);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 1, tri, sizeof(*tri));
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    get_surface_readback(context.backbuffer, &rb);
    color = get_readback_color(&rb, 320, 240);
    ok(color_match(color, 0x939100, 1), "Got color %08x.\n", color);
    color = get_readback_color(&rb, 10, 430);
    ok(color_match(color, 0x040400, 1), "Got color %08x.\n", color);
    color = get_readback_color(&rb, 320, 10);
    ok(color_match(color, 0xb5a600, 1), "Got color %08x.\n", color);
    color = get_readback_color(&rb, 630, 430);
    ok(color_match(color, 0xeafb00, 1), "Got color %08x.\n", color);
    release_surface_readback(&rb);

    hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0x00000000, 1.0f, 0);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTransform(device, D3DTS_VIEW, &view_matrix);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_BeginScene(device);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 1, tri2, sizeof(*tri2));
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_EndScene(device);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    get_surface_readback(context.backbuffer, &rb);
    color = get_readback_color(&rb, 320, 240);
    ok(color_match(color, 0x1d1c00, 1), "Got color %08x.\n", color);
    color = get_readback_color(&rb, 10, 430);
    ok(color_match(color, 0x000000, 1), "Got color %08x.\n", color);
    color = get_readback_color(&rb, 320, 10);
    ok(color_match(color, 0x3f3d00, 1), "Got color %08x.\n", color);
    color = get_readback_color(&rb, 630, 430);
    ok(color_match(color, 0x000000, 1), "Got color %08x.\n", color);
    release_surface_readback(&rb);

    release_test_context(&context);
}

static void test_generated_texcoords(void)
{
    struct d3d8_test_context context;
    IDirect3DDevice8 *device;
    unsigned int color;
    HRESULT hr;
    DWORD ps;

    static const DWORD ps_code[] =
    {
        0xffff0101,                         /* ps_1_1      */
        0x00000040, 0xb00f0000,             /* texcoord t0 */
        0x00000001, 0x800f0000, 0xb0e40000, /* mov r0, t0  */
        0x0000ffff
    };

    /* Shift a little to show that we're using camera space coordinates. */
    static const D3DMATRIX transform =
    {{{
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.2f, 0.2f, 0.0f, 1.0f,
    }}};

    static const struct
    {
        struct vec3 position;
        struct vec3 normal;
    }
    tri[] =
    {
        {{ 2.0f, -2.0f, 0.1f}, {0.8f, 0.0f, 0.7f}},
        {{-2.0f, -2.0f, 0.1f}, {0.8f, 0.0f, 0.7f}},
        {{ 0.0f,  2.0f, 0.1f}, {0.8f, 0.0f, 0.7f}},
    };

    static const struct
    {
        unsigned int tci;
        unsigned int color;
    }
    tests[] =
    {
        {D3DTSS_TCI_CAMERASPACEPOSITION,            0x0000001a},
        {D3DTSS_TCI_CAMERASPACENORMAL,              0x00cc00b2},
        {D3DTSS_TCI_CAMERASPACEREFLECTIONVECTOR,    0x0000000f},
    };

    if (!init_test_context(&context))
        return;
    device = context.device;

    hr = IDirect3DDevice8_CreatePixelShader(device, ps_code, &ps);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetPixelShader(device, ps);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    hr = IDirect3DDevice8_SetVertexShader(device, D3DFVF_XYZ | D3DFVF_NORMAL);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_ZENABLE, FALSE);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetRenderState(device, D3DRS_LIGHTING, FALSE);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTransform(device, D3DTS_WORLD, &transform);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);
    hr = IDirect3DDevice8_SetTransform(device, D3DTS_VIEW, &transform);
    ok(hr == S_OK, "Got hr %#lx.\n", hr);

    for (unsigned int i = 0; i < ARRAY_SIZE(tests); ++i)
    {
        winetest_push_context("TCI %#x", tests[i].tci);

        hr = IDirect3DDevice8_SetTextureStageState(device, 0, D3DTSS_TEXCOORDINDEX, tests[i].tci);
        ok(hr == S_OK, "Got hr %#lx.\n", hr);
        hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xffffffff, 0.0f, 0);
        ok(hr == S_OK, "Got hr %#lx.\n", hr);
        hr = IDirect3DDevice8_BeginScene(device);
        ok(hr == S_OK, "Got hr %#lx.\n", hr);
        hr = IDirect3DDevice8_DrawPrimitiveUP(device, D3DPT_TRIANGLESTRIP, 1, tri, sizeof(*tri));
        ok(hr == S_OK, "Got hr %#lx.\n", hr);
        hr = IDirect3DDevice8_EndScene(device);
        ok(hr == S_OK, "Got hr %#lx.\n", hr);

        color = getPixelColor(device, 320, 240);
        ok(color_match(color, tests[i].color, 1), "Got color %08x.\n", color);

        winetest_pop_context();
    }

    release_test_context(&context);
}

START_TEST(visual)
{
    D3DADAPTER_IDENTIFIER8 identifier;
    IDirect3D8 *d3d;
    BOOL is_wow64;
    HRESULT hr;

    if (!(d3d = Direct3DCreate8(D3D_SDK_VERSION)))
    {
        skip("Failed to create D3D8 object.\n");
        return;
    }

    if (!is_win64 && IsWow64Process( GetCurrentProcess(), &is_wow64 ) && is_wow64)
    {
        TEB64 *teb64 = ULongToPtr( NtCurrentTeb()->GdiBatchCount );
        if (teb64)
        {
            PEB64 *peb64 = ULongToPtr( teb64->Peb );
            new_wow64 = !!peb64->LdrData;
        }
    }

    memset(&identifier, 0, sizeof(identifier));
    hr = IDirect3D8_GetAdapterIdentifier(d3d, D3DADAPTER_DEFAULT, 0, &identifier);
    ok(SUCCEEDED(hr), "Failed to get adapter identifier, hr %#lx.\n", hr);
    trace("Driver string: \"%s\"\n", identifier.Driver);
    trace("Description string: \"%s\"\n", identifier.Description);
    /* Only Windows XP's default VGA driver should have an empty description */
    ok(identifier.Description[0] || broken(!strcmp(identifier.Driver, "vga.dll")), "Empty driver description.\n");
    trace("Driver version %d.%d.%d.%d\n",
            HIWORD(identifier.DriverVersion.HighPart), LOWORD(identifier.DriverVersion.HighPart),
            HIWORD(identifier.DriverVersion.LowPart), LOWORD(identifier.DriverVersion.LowPart));

    IDirect3D8_Release(d3d);

    test_sanity();
    depth_clamp_test();
    lighting_test();
    test_specular_lighting();
    clear_test();
    fog_test();
    z_range_test();
    offscreen_test();
    test_blend();
    test_scalar_instructions();
    fog_with_shader_test();
    cnd_test();
    p8_texture_test();
    texop_test();
    depth_buffer_test();
    depth_buffer2_test();
    intz_test();
    shadow_test();
    multisample_copy_rects_test();
    zenable_test();
    resz_test();
    fog_special_test();
    volume_dxtn_test();
    volume_v16u16_test();
    add_dirty_rect_test();
    test_buffer_no_dirty_update();
    test_3dc_formats();
    test_fog_interpolation();
    test_negative_fixedfunction_fog();
    test_table_fog_zw();
    test_signed_formats();
    test_updatetexture();
    test_pointsize();
    test_multisample_mismatch();
    test_texcoordindex();
    test_vshader_input();
    test_fixed_function_fvf();
    test_flip();
    test_uninitialized_varyings();
    test_shademode();
    test_multisample_init();
    test_texture_blending();
    test_color_clamping();
    test_edge_antialiasing_blending();
    test_max_index16();
    test_backbuffer_resize();
    test_drawindexedprimitiveup();
    test_map_synchronisation();
    test_viewport();
    test_color_vertex();
    test_sysmem_draw();
    test_alphatest();
    test_desktop_window();
    test_sample_mask();
    test_dynamic_map_synchronization();
    test_filling_convention();
    test_managed_reset();
    test_mipmap_upload();
    test_specular_shaders();
    test_lighting_matrices();
    test_generated_texcoords();
}
