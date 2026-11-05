/* Project-owned integration regression; upstream Wine source is unchanged. */
static void check_chain_pixels(IDirect3DSurface8 *surface, DWORD expected)
{
    D3DLOCKED_RECT lock;
    D3DSURFACE_DESC desc;
    HRESULT hr = IDirect3DSurface8_GetDesc(surface, &desc);
    ok(hr == D3D_OK, "Backbuffer descriptor hr %#lx.\n", hr);
    hr = IDirect3DSurface8_LockRect(surface, &lock, NULL, D3DLOCK_READONLY);
    ok(hr == D3D_OK, "Backbuffer readback hr %#lx.\n", hr);
    if (FAILED(hr)) return;
    unsigned int mismatches = 0;
    for (UINT y = 0; y < desc.Height; ++y)
        for (UINT x = 0; x < desc.Width; ++x)
            mismatches += (((DWORD *)((BYTE *)lock.pBits + y * lock.Pitch))[x] & 0xffffff)
                    != (expected & 0xffffff);
    ok(!mismatches, "%u wrong pixels, expected %#lx.\n", mismatches, expected);
    hr = IDirect3DSurface8_UnlockRect(surface);
    ok(hr == D3D_OK, "Backbuffer unlock hr %#lx.\n", hr);
}

static void swapchain_pixels(void)
{
    const DWORD colors[] = {0xffe03050, 0xff20c060, 0xff3060e0};
    const D3DSWAPEFFECT effects[] = {D3DSWAPEFFECT_COPY, D3DSWAPEFFECT_DISCARD, D3DSWAPEFFECT_FLIP};
    HWND window = create_window(), second = create_window();
    IDirect3D8 *root = Direct3DCreate8(D3D_SDK_VERSION);
    ok(!!root, "Missing swapchain pixel root.\n");
    if (!root) goto done;
    for (UINT additional = 0; additional < 2; ++additional)
    for (UINT effect = 0; effect < ARRAY_SIZE(effects); ++effect)
    for (UINT count = 1; count <= (effect ? 3u : 1u); ++count) {
        D3DPRESENT_PARAMETERS pp = {0}, initial;
        IDirect3DDevice8 *device = NULL;
        IDirect3DSwapChain8 *chain = NULL;
        IDirect3DSurface8 *buffers[3] = {0}, *primary = NULL, *same = NULL;
        pp.BackBufferWidth = pp.BackBufferHeight = 32;
        pp.BackBufferFormat = D3DFMT_A8R8G8B8;
        pp.BackBufferCount = count;
        pp.SwapEffect = effects[effect];
        pp.Windowed = TRUE;
        pp.hDeviceWindow = window;
        pp.Flags = D3DPRESENTFLAG_LOCKABLE_BACKBUFFER;
        initial = pp;
        if (additional) {initial.BackBufferCount = 1; initial.SwapEffect = D3DSWAPEFFECT_COPY;}
        HRESULT hr = IDirect3D8_CreateDevice(root, 0, D3DDEVTYPE_HAL, window,
                D3DCREATE_SOFTWARE_VERTEXPROCESSING, &initial, &device);
        ok(hr == D3D_OK, "Pixel device %u/%u/%u hr %#lx.\n", additional, effect, count, hr);
        if (FAILED(hr)) continue;
        hr = IDirect3DDevice8_GetBackBuffer(device, 0, 0, &primary);
        ok(hr == D3D_OK, "Missing implicit target.\n");
        if (additional) {
            hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, 0xff987654, 1, 0);
            ok(hr == D3D_OK, "Implicit clear failed.\n");
            pp.hDeviceWindow = second;
            hr = IDirect3DDevice8_CreateAdditionalSwapChain(device, &pp, &chain);
            ok(hr == D3D_OK, "Pixel additional %u/%u hr %#lx.\n", effect, count, hr);
            if (FAILED(hr)) goto cleanup;
        }
        for (UINT i = 0; i < count; ++i) {
            hr = chain ? IDirect3DSwapChain8_GetBackBuffer(chain, i, 0, &buffers[i])
                    : IDirect3DDevice8_GetBackBuffer(device, i, 0, &buffers[i]);
            ok(hr == D3D_OK, "Missing pixel buffer %u.\n", i);
            if (FAILED(hr)) goto cleanup;
            for (UINT j = 0; j < i; ++j) ok(buffers[i] != buffers[j], "Aliased buffers %u/%u.\n", i, j);
            hr = IDirect3DDevice8_SetRenderTarget(device, buffers[i], NULL);
            ok(hr == D3D_OK, "Bind buffer %u hr %#lx.\n", i, hr);
            hr = IDirect3DDevice8_Clear(device, 0, NULL, D3DCLEAR_TARGET, colors[i], 1, 0);
            ok(hr == D3D_OK, "Clear buffer %u hr %#lx.\n", i, hr);
        }
        for (UINT i = 0; i < count; ++i) check_chain_pixels(buffers[i], colors[i]);
        for (UINT frame = 1; frame <= (effect == 2 ? count + 1 : 1); ++frame) {
            hr = chain ? IDirect3DSwapChain8_Present(chain, NULL, NULL, NULL, NULL)
                    : IDirect3DDevice8_Present(device, NULL, NULL, NULL, NULL);
            ok(hr == D3D_OK, "Present %u/%u/%u frame %u hr %#lx.\n", additional, effect, count, frame, hr);
            for (UINT i = 0; i < count; ++i) {
                hr = chain ? IDirect3DSwapChain8_GetBackBuffer(chain, i, 0, &same)
                        : IDirect3DDevice8_GetBackBuffer(device, i, 0, &same);
                ok(hr == D3D_OK && same == buffers[i], "Changed buffer identity.\n");
                if (SUCCEEDED(hr)) IDirect3DSurface8_Release(same);
                if (!effect) check_chain_pixels(buffers[i], colors[i]);
                else if (effect == 2) {
                    UINT source = (i + frame) % (count + 1);
                    /* The initial front buffer contents are unspecified. */
                    if (source < count) check_chain_pixels(buffers[i], colors[source]);
                }
                /* DISCARD contents are undefined; only identity is asserted. */
            }
            hr = IDirect3DDevice8_GetRenderTarget(device, &same);
            ok(hr == D3D_OK && same == buffers[count - 1], "Present changed target binding.\n");
            if (SUCCEEDED(hr)) IDirect3DSurface8_Release(same);
            if (additional) check_chain_pixels(primary, 0xff987654);
        }
        hr = IDirect3DDevice8_SetRenderTarget(device, primary, NULL);
        ok(hr == D3D_OK, "Restore implicit target failed.\n");
        if (chain) {
            /* The last spare alone must keep its parent chain/device alive. */
            ULONG refs = IDirect3DSwapChain8_Release(chain);
            ok(!refs, "Additional chain public references %lu.\n", refs);
            chain = NULL;
            hr = IDirect3DSurface8_GetDesc(buffers[count - 1], &(D3DSURFACE_DESC){0});
            ok(hr == D3D_OK, "Spare died with its chain.\n");
        }
        for (UINT i = 0; i < count; ++i) {IDirect3DSurface8_Release(buffers[i]); buffers[i] = NULL;}
        IDirect3DSurface8_Release(primary); primary = NULL;
        if (!additional && count > 1) {
            hr = IDirect3DDevice8_GetBackBuffer(device, count - 1, 0, &same);
            ok(hr == D3D_OK, "Spare revival failed.\n");
            pp.BackBufferWidth = 48;
            hr = IDirect3DDevice8_Reset(device, &pp);
            ok(hr == D3DERR_DEVICELOST, "Held spare must block Reset, hr %#lx.\n", hr);
            IDirect3DSurface8_Release(same);
            hr = IDirect3DDevice8_Reset(device, &pp);
            ok(hr == D3D_OK, "Released spare still blocks Reset, hr %#lx.\n", hr);
            if (SUCCEEDED(hr)) {
                hr = IDirect3DDevice8_GetBackBuffer(device, count - 1, 0, &same);
                ok(hr == D3D_OK, "Missing resized spare.\n");
                if (SUCCEEDED(hr)) {
                    D3DSURFACE_DESC desc;
                    IDirect3DSurface8_GetDesc(same, &desc);
                    ok(desc.Width == 48 && desc.Height == 32, "Stale spare dimensions.\n");
                    IDirect3DSurface8_Release(same);
                }
            }
        }
cleanup:
        if (primary) {
            IDirect3DDevice8_SetRenderTarget(device, primary, NULL);
            IDirect3DSurface8_Release(primary);
        }
        for (UINT i = 0; i < count; ++i) if (buffers[i]) IDirect3DSurface8_Release(buffers[i]);
        if (chain) IDirect3DSwapChain8_Release(chain);
        ULONG refs = IDirect3DDevice8_Release(device);
        ok(!refs, "Pixel device %u/%u/%u leaked %lu references.\n", additional, effect, count, refs);
    }
    IDirect3D8_Release(root);
done:
    DestroyWindow(second); DestroyWindow(window);
}
