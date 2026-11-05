/* Project-owned pixel recovery test. The upstream window functions remain
 * unchanged; this checks the GPU target after loss, Reset and windowed return. */
static void window_recovery_pixels(void)
{
    HWND window = CreateWindowA("d3d8_test_wc", "Recovery pixels", WS_POPUP | WS_VISIBLE,
            0, 0, 640, 480, NULL, NULL, NULL, NULL);
    IDirect3D8 *root = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!window, "Pixel recovery window creation failed.\n");
    ok(!!root, "Pixel recovery Direct3D creation failed.\n");
    if (!window || !root) {
        if (root) IDirect3D8_Release(root);
        if (window) DestroyWindow(window);
        return;
    }
    IDirect3DDevice8 *device = NULL;
    D3DPRESENT_PARAMETERS pp = {0};
    pp.BackBufferWidth = 640;pp.BackBufferHeight = 480;
    pp.BackBufferFormat = D3DFMT_X8R8G8B8;pp.BackBufferCount = 1;
    pp.SwapEffect = D3DSWAPEFFECT_DISCARD;pp.hDeviceWindow = window;
    pp.Flags = D3DPRESENTFLAG_LOCKABLE_BACKBUFFER;
    HRESULT hr = IDirect3D8_CreateDevice(root, 0, D3DDEVTYPE_HAL, window,
            D3DCREATE_SOFTWARE_VERTEXPROCESSING, &pp, &device);
    ok(hr == D3D_OK, "Pixel fullscreen create failed %#lx.\n", hr);
    if (SUCCEEDED(hr)) {
        const DWORD colors[] = {0xffb83060, 0xff30b860, 0xff3060b8};
        for (UINT phase = 0; phase < 3; ++phase) {
            if (phase == 1) {
                ok(SetForegroundWindow(GetDesktopWindow()), "Cannot leave fullscreen focus.\n");
                ok(IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL) == D3DERR_DEVICELOST,
                        "Inactive fullscreen Present should be lost.\n");
                ok(IDirect3DDevice8_TestCooperativeLevel(device) == D3DERR_DEVICELOST,
                        "Inactive fullscreen cooperative state.\n");
                ok(IDirect3DDevice8_Reset(device, &pp) == D3DERR_DEVICELOST,
                        "Inactive fullscreen Reset should remain lost.\n");
                ShowWindow(window, SW_RESTORE);SetForegroundWindow(window);flush_events();
                ok(IDirect3DDevice8_TestCooperativeLevel(device) == D3DERR_DEVICENOTRESET,
                        "Active fullscreen must require Reset.\n");
            }
            if (phase) {
                if (phase == 2) {pp.Windowed = TRUE;pp.BackBufferWidth = 160;pp.BackBufferHeight = 120;}
                hr = IDirect3DDevice8_Reset(device, &pp);
                ok(hr == D3D_OK, "Pixel recovery Reset phase %u failed %#lx.\n", phase, hr);
                if (FAILED(hr)) break;
            }
            ok(IDirect3DDevice8_TestCooperativeLevel(device) == D3D_OK, "Pixel device not ready.\n");
            ok(IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, colors[phase], 1, 0) == D3D_OK,
                    "Pixel recovery Clear failed.\n");
            IDirect3DSurface8 *target = NULL;
            hr = IDirect3DDevice8_GetRenderTarget(device, &target);
            ok(hr == D3D_OK, "Pixel recovery target missing.\n");
            if (SUCCEEDED(hr)) {check_chain_pixels(target, colors[phase]);IDirect3DSurface8_Release(target);}
            ok(IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL) == D3D_OK, "Pixel recovery Present failed.\n");
        }
        ok(!IDirect3DDevice8_Release(device), "Pixel recovery device leaked.\n");
    }
    IDirect3D8_Release(root);DestroyWindow(window);
}
