/* Project regressions complement the unchanged upstream device functions.
 * Expected mip offsets use public dimensions/format widths, not proxy metadata. */
static void retail_mip_storage(void)
{
    const D3DFORMAT formats[] = {D3DFMT_A8R8G8B8, D3DFMT_A8, D3DFMT_L8, D3DFMT_DXT1, D3DFMT_DXT5};
    HWND window = create_window();
    IDirect3D8 *root = Direct3DCreate8(D3D_SDK_VERSION);
    IDirect3DDevice8 *device = root ? create_device(root, window, NULL) : NULL;
    ok(!!device, "Missing retail storage device.\n");
    if (device) {
        BYTE info[32];memset(info, 0xa5, sizeof(info));
        for (UINT id = 0; id < 256; ++id) {
            HRESULT hr = IDirect3DDevice8_GetInfo(device, id, info, sizeof(info));
            ok(hr == (id < 4 ? E_FAIL : S_FALSE), "GetInfo %u returned %#lx.\n", id, hr);
            BOOL unchanged = TRUE;
            for (UINT b = 0; b < sizeof(info); ++b) unchanged &= info[b] == 0xa5;
            ok(unchanged, "GetInfo changed caller storage.\n");
        }
        ok(IDirect3DDevice8_SetIndices(device, NULL, 37) == D3D_OK, "Set zero-draw base failed.\n");
        ok(IDirect3DDevice8_DrawIndexedPrimitiveUP(device, D3DPT_TRIANGLELIST, 0, 3, 0,
                info, D3DFMT_INDEX16, info, 16) == D3D_OK, "Zero primitive UP failed.\n");
        IDirect3DIndexBuffer8 *indices = (void *)0xdeadbeef;UINT base_index = 0;
        ok(IDirect3DDevice8_GetIndices(device, &indices, &base_index) == D3D_OK
                && !indices && base_index == 37, "Zero primitive UP changed indices/base.\n");
        for (UINT f = 0; f < ARRAY_SIZE(formats); ++f)
            for (UINT pool = D3DPOOL_MANAGED; pool <= D3DPOOL_SCRATCH; ++pool)
                for (UINT cube = 0; cube < 2; ++cube) {
                    IDirect3DTexture8 *texture = NULL;
                    IDirect3DCubeTexture8 *cubemap = NULL;
                    const UINT dimension = f < 3 ? 257 : 256, levels = 9;
                    HRESULT hr = cube
                        ? IDirect3DDevice8_CreateCubeTexture(device, dimension, 0, 0, formats[f], pool, &cubemap)
                        : IDirect3DDevice8_CreateTexture(device, dimension, dimension, 0, 0, formats[f], pool, &texture);
                    ok(hr == D3D_OK, "Mip create format %u pool %u cube %u: %#lx.\n", f, pool, cube, hr);
                    if (FAILED(hr)) continue;
                    UINT count = cube ? IDirect3DCubeTexture8_GetLevelCount(cubemap) : IDirect3DTexture8_GetLevelCount(texture);
                    ok(count == levels, "Unexpected mip count %u.\n", count);
                    uintptr_t base = 0;UINT offset = 0;
                    for (UINT face = 0; face < (cube ? 6u : 1u); ++face) {
                        for (UINT level = 0; level < levels; ++level) {
                            UINT size = dimension >> level, pitch = f == 0 ? size * 4 : f < 3 ? size : ((size + 3) / 4) * (f == 3 ? 8 : 16);
                            UINT rows = f < 3 ? size : (size + 3) / 4;
                            D3DLOCKED_RECT lock;
                            hr = cube ? IDirect3DCubeTexture8_LockRect(cubemap, face, level, &lock, NULL, 0)
                                : IDirect3DTexture8_LockRect(texture, level, &lock, NULL, 0);
                            ok(hr == D3D_OK, "Mip lock failed %#lx.\n", hr);
                            if (FAILED(hr)) continue;
                            if (!face && !level) base = (uintptr_t)lock.pBits;
                            ok(lock.Pitch == (INT)pitch && (uintptr_t)lock.pBits == base + offset,
                                "Mip layout f%u pool%u face%u level%u.\n", f, pool, face, level);
                            memset(lock.pBits, 1 + face * 9 + level, pitch * rows);
                            hr = cube ? IDirect3DCubeTexture8_UnlockRect(cubemap, face, level) : IDirect3DTexture8_UnlockRect(texture, level);
                            ok(hr == D3D_OK, "Mip upload failed %#lx.\n", hr);
                            offset += pitch * rows;
                        }
                        offset = (offset + 15u) & ~15u;
                    }
                    for (UINT face = 0; face < (cube ? 6u : 1u); ++face)
                        for (UINT level = 0; level < levels; ++level) {
                            UINT size = dimension >> level, pitch = f == 0 ? size * 4 : f < 3 ? size : ((size + 3) / 4) * (f == 3 ? 8 : 16);
                            UINT bytes = pitch * (f < 3 ? size : (size + 3) / 4);
                            D3DLOCKED_RECT lock;
                            hr = cube ? IDirect3DCubeTexture8_LockRect(cubemap, face, level, &lock, NULL, D3DLOCK_READONLY)
                                : IDirect3DTexture8_LockRect(texture, level, &lock, NULL, D3DLOCK_READONLY);
                            ok(hr == D3D_OK, "Readback lock failed %#lx.\n", hr);
                            if (FAILED(hr)) continue;
                            BOOL same = TRUE;
                            for (UINT b = 0; b < bytes; ++b) same &= ((BYTE *)lock.pBits)[b] == 1 + face * 9 + level;
                            ok(same, "Mip/face storage overlapped.\n");
                            hr = cube ? IDirect3DCubeTexture8_UnlockRect(cubemap, face, level) : IDirect3DTexture8_UnlockRect(texture, level);
                            ok(hr == D3D_OK, "Readonly unlock failed %#lx.\n", hr);
                        }
                    if (cube) IDirect3DCubeTexture8_Release(cubemap);else IDirect3DTexture8_Release(texture);
                }
        IDirect3DVolumeTexture8 *volume = NULL;
        HRESULT hr = IDirect3DDevice8_CreateVolumeTexture(device, 4, 4, 2, 1, 0, D3DFMT_A8R8G8B8, D3DPOOL_SCRATCH, &volume);
        ok(hr == D3D_OK, "Scratch volume create failed %#lx.\n", hr);
        if (volume) {
            D3DLOCKED_BOX lock;
            hr = IDirect3DVolumeTexture8_LockBox(volume, 0, &lock, NULL, 0);
            ok(hr == D3D_OK, "Scratch volume lock failed %#lx.\n", hr);
            if (SUCCEEDED(hr)) {
                memset(lock.pBits, 0x7f, lock.SlicePitch * 2);
                ok(IDirect3DVolumeTexture8_UnlockBox(volume, 0) == D3D_OK, "Scratch volume upload failed.\n");
            }
            ok(IDirect3DDevice8_SetTexture(device, 0, (IDirect3DBaseTexture8 *)volume) == D3D_OK, "Scratch volume bind failed.\n");
            ok(IDirect3DDevice8_SetTexture(device, 0, NULL) == D3D_OK, "Scratch volume unbind failed.\n");
            IDirect3DVolumeTexture8_Release(volume);
        }
        ok(!IDirect3DDevice8_Release(device), "Leaked retail storage device.\n");
    }
    if (root) IDirect3D8_Release(root);
    DestroyWindow(window);
}

static void retail_runtime_group(void)
{
    WNDCLASSA wc = {0};wc.lpfnWndProc = DefWindowProcA;wc.lpszClassName = "d3d8_test_wc";
    RegisterClassA(&wc);
    test_get_info();test_multiply_transform();test_draw_primitive();test_destroyed_window();
    retail_mip_storage();
    UnregisterClassA(wc.lpszClassName, GetModuleHandleA(NULL));
}
