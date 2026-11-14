/* Diagnostic entry selection only: include the frozen upstream translation
 * unit unchanged, and call its original cooperative/window-mode tests with system DDraw.
 * This is not the complete Wine acceptance run and does not waive assertions. */
#define main wine_original_main
#ifndef STANDALONE
#define STANDALONE
#endif
#include DDRAW_COLOR_SOURCE
#undef main
#if DDRAW_COLOR_VERSION == 7
static void native_index_probe(const GUID *guid, const char *name, unsigned variant)
{
    IDirect3DDevice7 *device;
    IDirect3D7 *d3d = NULL;
    IDirect3DVertexBuffer7 *vb = NULL, *other = NULL;
    D3DVERTEXBUFFERDESC desc = {sizeof(desc), 0, D3DFVF_XYZ, 4};
    D3DDEVICEDESC7 caps;
    const float vertices[9] = {-.5f,-.5f,.5f, .5f,-.5f,.5f, 0,.5f,.5f};
    WORD indices[3] = {0,1,2};
    HRESULT first = E_FAIL, second = E_FAIL, fresh = E_FAIL, prime = S_FALSE;
    HWND window = create_window();
    if (!(device = create_device_ex(window, DDSCL_NORMAL, guid, NULL)))
    {
        printf("NATIVE_INDEX class=%s variant=%u available=0\n", name, variant);
        DestroyWindow(window);
        return;
    }
    MEMORY_BASIC_INFORMATION memory;
    char module_path[MAX_PATH] = {0};
    if (VirtualQuery((const void *)device->lpVtbl->DrawIndexedPrimitiveVB, &memory, sizeof(memory)))
    {
        GetModuleFileNameA((HMODULE)memory.AllocationBase, module_path, sizeof(module_path));
        printf("NATIVE_INDEX_ENTRY class=%s variant=%u module=%s rva=%08lx\n", name, variant,
                module_path, (DWORD)((const BYTE *)device->lpVtbl->DrawIndexedPrimitiveVB - (const BYTE *)memory.AllocationBase));
    }
    ZeroMemory(&caps, sizeof(caps));
    IDirect3DDevice7_GetCaps(device, &caps);
    HRESULT setup = IDirect3DDevice7_GetDirect3D(device, &d3d);
    if (SUCCEEDED(setup))
        setup = IDirect3D7_CreateVertexBuffer(d3d, &desc, &vb, 0);
    if (FAILED(setup))
    {
        printf("NATIVE_INDEX class=%s variant=%u available=0 setup=%08lx\n", name, variant, (DWORD)setup);
        goto done;
    }
    if (variant == 1)
    {
        IDirect3DDevice7_SetRenderState(device, D3DRENDERSTATE_LIGHTING, FALSE);
        IDirect3DDevice7_SetRenderState(device, D3DRENDERSTATE_ZENABLE, FALSE);
        IDirect3DDevice7_BeginScene(device);
        prime = IDirect3DDevice7_DrawIndexedPrimitive(device, D3DPT_TRIANGLELIST,
                D3DFVF_XYZ, (void *)vertices, 3, indices, 3, 0);
        IDirect3DDevice7_EndScene(device);
    }
    else if (variant == 2)
        prime = IDirect3DDevice7_DrawIndexedPrimitive(device, D3DPT_TRIANGLESTRIP,
                D3DFVF_XYZ, NULL, 0, NULL, 0, 0);
    else if (variant == 3)
        prime = IDirect3DDevice7_DrawPrimitiveVB(device, D3DPT_TRIANGLESTRIP, vb, 0, 0, 0);
    else if (variant == 5)
    {
        void *data;
        prime = IDirect3DVertexBuffer7_Lock(vb, 0, &data, NULL);
        if (SUCCEEDED(prime))
        {
            memcpy(data, vertices, sizeof(vertices));
            prime = IDirect3DVertexBuffer7_Unlock(vb);
        }
        if (SUCCEEDED(prime))
        {
            IDirect3DDevice7_SetRenderState(device, D3DRENDERSTATE_LIGHTING, FALSE);
            IDirect3DDevice7_SetRenderState(device, D3DRENDERSTATE_ZENABLE, FALSE);
            IDirect3DDevice7_BeginScene(device);
            prime = IDirect3DDevice7_DrawIndexedPrimitiveVB(device, D3DPT_TRIANGLELIST,
                    vb, 0, 3, indices, 3, 0);
            IDirect3DDevice7_EndScene(device);
        }
    }
    else if (variant == 6)
    {
        D3DDRAWPRIMITIVESTRIDEDDATA strided;
        ZeroMemory(&strided, sizeof(strided));
        prime = IDirect3DDevice7_DrawIndexedPrimitive(device, D3DPT_TRIANGLESTRIP,
                D3DFVF_XYZ, NULL, 0, NULL, 0, 0);
        IDirect3DDevice7_DrawIndexedPrimitiveStrided(device, D3DPT_TRIANGLESTRIP,
                D3DFVF_XYZ, &strided, 0, NULL, 0, 0);
    }
    first = IDirect3DDevice7_DrawIndexedPrimitiveVB(device, D3DPT_TRIANGLESTRIP,
            vb, 0, 0, variant == 4 ? indices : NULL, variant == 4 ? 3 : 0, 0);
    second = IDirect3DDevice7_DrawIndexedPrimitiveVB(device, D3DPT_TRIANGLESTRIP,
            vb, 0, 0, NULL, 0, 0);
    if (SUCCEEDED(IDirect3D7_CreateVertexBuffer(d3d, &desc, &other, 0)))
        fresh = IDirect3DDevice7_DrawIndexedPrimitiveVB(device, D3DPT_TRIANGLESTRIP,
                other, 0, 0, NULL, 0, 0);
    printf("NATIVE_INDEX class=%s variant=%u available=1 caps=%08lx prime=%08lx first=%08lx second=%08lx fresh=%08lx\n",
            name, variant, caps.dwDevCaps, (DWORD)prime, (DWORD)first, (DWORD)second, (DWORD)fresh);
 done:
    if (other) IDirect3DVertexBuffer7_Release(other);
    if (vb) IDirect3DVertexBuffer7_Release(vb);
    if (d3d) IDirect3D7_Release(d3d);
    IDirect3DDevice7_Release(device);
    DestroyWindow(window);
}
#endif

int main(int argc, char **argv)
{
    char directory[MAX_PATH];
    HMODULE module;
    setvbuf(stdout, NULL, _IONBF, 0);
    winetest_mutex = CreateMutexA(NULL, FALSE, "winetest_print_mutex");
    winetest_argc = argc;
    winetest_argv = argv;
    current_test = &winetest_testlist[0];
    winetest_start_time = winetest_last_time = winetest_get_time();
    SetUnhandledExceptionFilter(exc_filter);
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
    GetSystemDirectoryA(directory, sizeof(directory));
    lstrcatA(directory, "\\ddraw.dll");
    module = LoadLibraryA(directory);
    if (!module) { printf("FAIL native DLL load\n"); return 1; }
    if (GetModuleHandleA("ddraw.dll") != module)
    { printf("FAIL imported DLL is not the system module\n"); return 1; }
#if DDRAW_COLOR_VERSION == 7
    pDirectDrawCreateEx = (void *)GetProcAddress(module, "DirectDrawCreateEx");
    if (!pDirectDrawCreateEx) { printf("FAIL native factory\n"); return 1; }
#endif
    ZeroMemory(&registry_mode, sizeof(registry_mode));
    registry_mode.dmSize = sizeof(registry_mode);
    if (!EnumDisplaySettingsA(NULL, ENUM_REGISTRY_SETTINGS, &registry_mode))
    { printf("FAIL registry mode\n"); return 1; }
    start_foreground_window_thread();
#if DDRAW_COLOR_VERSION == 7
    unsigned selected_variant;
    if (argc == 2 && sscanf(argv[1], "--index=%u", &selected_variant) == 1 && selected_variant < 7)
    {
        native_index_probe(&IID_IDirect3DRGBDevice, "RGB", selected_variant);
        native_index_probe(&IID_IDirect3DHALDevice, "HAL", selected_variant);
        printf("COMPLETE native_index_group=%u\n", selected_variant);
        return 0;
    }
#endif
    test_coop_level_mode_set();

    printf("WINDOW_MODE_GROUP version=%u failures=%ld flaky=%ld skipped=%ld\n",
            DDRAW_COLOR_VERSION, winetest_failures, winetest_flaky_failures, winetest_skipped);
#if DDRAW_COLOR_VERSION == 7
    for (unsigned variant = 0; variant < 7; ++variant) {
        native_index_probe(&IID_IDirect3DRGBDevice, "RGB", variant);
        native_index_probe(&IID_IDirect3DHALDevice, "HAL", variant);
    }
#endif
    printf("COMPLETE native_window_mode_group=%u\n", DDRAW_COLOR_VERSION);
    return 0;
}
