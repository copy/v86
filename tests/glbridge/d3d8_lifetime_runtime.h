/* Project regression: nested maps preserve every writer until final Unlock.
 * CPU relocks check storage; native extracted-method tests also inspect uploads. */
static void lifetime_nested_buffers(void)
{
    HWND window = create_window();
    IDirect3D8 *root = Direct3DCreate8(D3D_SDK_VERSION);
    IDirect3DDevice8 *device = root ? create_device(root, window, NULL) : NULL;
    ok(!!device, "Missing nested buffer device.\n");
    if (device) {
        for (UINT index = 0; index < 2; ++index)
        for (UINT pool = D3DPOOL_DEFAULT; pool <= D3DPOOL_SYSTEMMEM; ++pool) {
            IDirect3DVertexBuffer8 *vb = NULL;
            IDirect3DIndexBuffer8 *ib = NULL;
            HRESULT hr = index
                ? IDirect3DDevice8_CreateIndexBuffer(device, 64, 0, D3DFMT_INDEX16, pool, &ib)
                : IDirect3DDevice8_CreateVertexBuffer(device, 64, 0, D3DFVF_XYZ, pool, &vb);
            ok(hr == D3D_OK, "Nested buffer create failed %#lx.\n", hr);
            if (FAILED(hr)) continue;
#define LIFETIME_LOCK(offset, size, data, flags) (index ? IDirect3DIndexBuffer8_Lock(ib, offset, size, data, flags) : IDirect3DVertexBuffer8_Lock(vb, offset, size, data, flags))
#define LIFETIME_UNLOCK() (index ? IDirect3DIndexBuffer8_Unlock(ib) : IDirect3DVertexBuffer8_Unlock(vb))
            BYTE *first = NULL, *second = NULL, *third = NULL;
            hr = LIFETIME_LOCK(0, 64, &first, 0);
            ok(hr == D3D_OK, "Initial lock failed.\n");
            if (SUCCEEDED(hr)) {memset(first, 0x35, 64);ok(LIFETIME_UNLOCK() == D3D_OK, "Initial unlock failed.\n");}
            hr = LIFETIME_LOCK(16, 8, &first, 0);
            ok(hr == D3D_OK, "First map failed.\n");
            if (SUCCEEDED(hr)) {
                memset(first, 0x81, 8);
                hr = LIFETIME_LOCK(2, 4, &second, D3DLOCK_READONLY);
                ok(hr == D3D_OK && second + 14 == first, "Nested readonly map offset.\n");
                if (SUCCEEDED(hr)) {
                    hr = LIFETIME_LOCK(40, 8, &third, D3DLOCK_NOOVERWRITE);
                    ok(hr == D3D_OK && third == first + 24, "Third map offset.\n");
                    if (SUCCEEDED(hr)) {memset(third, 0x92, 8);ok(LIFETIME_UNLOCK() == D3D_OK, "Third unlock failed.\n");}
                    ok(LIFETIME_UNLOCK() == D3D_OK, "Second unlock failed.\n");
                }
                ok(LIFETIME_UNLOCK() == D3D_OK, "Final unlock failed.\n");
            }
            hr = LIFETIME_LOCK(0, 64, &first, D3DLOCK_READONLY);
            ok(hr == D3D_OK, "Verification relock failed.\n");
            if (SUCCEEDED(hr)) {
                for (UINT b = 0; b < 64; ++b)
                    ok(first[b] == (b >= 16 && b < 24 ? 0x81 : b >= 40 && b < 48 ? 0x92 : 0x35), "Lost nested write at %u.\n", b);
                ok(LIFETIME_UNLOCK() == D3D_OK, "Verification unlock failed.\n");
            }
            if (index) IDirect3DIndexBuffer8_Release(ib);else IDirect3DVertexBuffer8_Release(vb);
#undef LIFETIME_LOCK
#undef LIFETIME_UNLOCK
        }
        for (UINT iteration = 0; iteration < 1000; ++iteration) {
            IDirect3DTexture8 *texture = NULL;
            HRESULT hr = IDirect3DDevice8_CreateTexture(device, 4, 4, 1, 0, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED, &texture);
            ok(hr == D3D_OK, "Repeated texture create failed.\n");
            if (SUCCEEDED(hr)) {
                ok(!IDirect3DTexture8_Release(texture), "Texture not released.\n");
                ok(!IDirect3DTexture8_Release(texture), "Immediate repeated Release revived texture.\n");
            }
        }
        ok(!IDirect3DDevice8_Release(device), "Nested buffer device leaked.\n");
    }
    if (root) IDirect3D8_Release(root);
    DestroyWindow(window);
}

static void lifetime_runtime_group(void)
{
    WNDCLASSA wc = {0};wc.lpfnWndProc = DefWindowProcA;wc.lpszClassName = "d3d8_test_wc";
    RegisterClassA(&wc);
    registry_mode.dmSize = sizeof(registry_mode);
    ok(EnumDisplaySettingsW(NULL, ENUM_REGISTRY_SETTINGS, &registry_mode), "Missing registry mode.\n");
    test_refcount();test_invalid_multisample();test_ApplyStateBlock();test_vb_lock_flags();
    lifetime_nested_buffers();
    UnregisterClassA(wc.lpszClassName, GetModuleHandleA(NULL));
}
