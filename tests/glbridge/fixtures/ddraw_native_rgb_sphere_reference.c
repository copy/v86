/* Selected original numerical test on XP's software RGB device.
 * The factory GUID is explicitly substituted; this is not full-suite or HAL evidence. */
#define COBJMACROS
#include <windows.h>
#include <ddraw.h>
#include <d3d.h>
#define IID_IDirect3DHALDevice IID_IDirect3DRGBDevice
#define main wine_original_main
#ifndef STANDALONE
#define STANDALONE
#endif
#include DDRAW_RGB_SOURCE
#undef main
static DWORD rgb_float_bits(float value)
{
    DWORD bits;memcpy(&bits, &value, sizeof(bits));return bits;
}

static void rgb_reference_rows(void)
{
    HWND window = create_window();
    IDirect3DDevice3 *device = create_device(window, DDSCL_NORMAL);
    if (!device) { printf("FAIL native RGB reference device\n");exit(1); }
    IDirect3DViewport3 *viewport = create_viewport(device, 0, 0, 640, 480);
    IDirect3DDevice3_SetCurrentViewport(device, viewport);
    MEMORY_BASIC_INFORMATION info;char module[MAX_PATH] = {0};
    void *method = (void *)device->lpVtbl->ComputeSphereVisibility;
    if (VirtualQuery(method, &info, sizeof(info))) {
        GetModuleFileNameA((HMODULE)info.AllocationBase, module, sizeof(module));
        printf("RGB_METHOD module=%s rva=%08lx\n", module,
                (DWORD)method - (DWORD)info.AllocationBase);
    }
    D3DMATRIX identity = {1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1};
    D3DMATRIX projections[] = {
        {1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1},
        {10,0,0,0,0,10,0,0,0,0,10,0,0,0,0,1},
        {1.810660f,0,0,0,0,2.414213f,0,0,0,0,1.020408f,1,0,0,-0.102041f,0}
    };
    D3DVECTOR centers[] = {{{0},{0},{0.5f}},{{-1},{-1},{0.5f}},
        {{0},{0},{0.05f}},{{0},{0},{0}},{{-0.5f},{0},{0.5f}},
        {{0},{0},{0.25f}},{{0},{0},{0.75f}},{{0},{0},{1}}};
    float values[] = {0,0.01f,0.04f,0.1f,0.25f,0.5f,0.75f,1,2,3,4};
    IDirect3DDevice3_SetTransform(device, D3DTRANSFORMSTATE_WORLD, &identity);
    IDirect3DDevice3_SetTransform(device, D3DTRANSFORMSTATE_VIEW, &identity);
    for (unsigned p = 0; p < ARRAY_SIZE(projections); ++p) {
        IDirect3DDevice3_SetTransform(device, D3DTRANSFORMSTATE_PROJECTION, &projections[p]);
        for (unsigned r = 0; r < ARRAY_SIZE(values); ++r) {
            float radii[ARRAY_SIZE(centers)];DWORD result[ARRAY_SIZE(centers)] = {0};
            for (unsigned c = 0; c < ARRAY_SIZE(centers); ++c) radii[c] = values[r];
            HRESULT hr = IDirect3DDevice3_ComputeSphereVisibility(device, centers, radii,
                    ARRAY_SIZE(centers), 0, result);
            for (unsigned c = 0; c < ARRAY_SIZE(centers); ++c)
                printf("RGB_ROW projection=%u center=%u radius=%08lx hr=%08lx result=%08lx\n",
                        p, c, rgb_float_bits(values[r]), hr, result[c]);
        }
    }
    destroy_viewport(device, viewport);IDirect3DDevice3_Release(device);DestroyWindow(window);
}

int main(int argc, char **argv)
{
    char directory[MAX_PATH];
    setvbuf(stdout, NULL, _IONBF, 0);
    winetest_mutex = CreateMutexA(NULL, FALSE, "winetest_print_mutex");
    winetest_argc = argc;winetest_argv = argv;
    current_test = &winetest_testlist[0];
    winetest_start_time = winetest_last_time = winetest_get_time();
    SetUnhandledExceptionFilter(exc_filter);
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
    GetSystemDirectoryA(directory, sizeof(directory));lstrcatA(directory, "\\ddraw.dll");
    HMODULE native = LoadLibraryA(directory);
    if (!native || GetModuleHandleA("ddraw.dll") != native) {
        printf("FAIL native system DLL identity\n");return 1;
    }
    ZeroMemory(&registry_mode, sizeof(registry_mode));registry_mode.dmSize = sizeof(registry_mode);
    if (!EnumDisplaySettingsA(NULL, ENUM_REGISTRY_SETTINGS, &registry_mode)) {
        printf("FAIL registry mode\n");return 1;
    }
    printf("RGB_SPHERE factory=IDirect3DRGBDevice original_assertions=unchanged\n");
    fflush(stdout);FlushFileBuffers(GetStdHandle(STD_OUTPUT_HANDLE));
    start_foreground_window_thread();
    test_compute_sphere_visibility();
    printf("RGB_SPHERE_TOTAL failures=%ld flaky=%ld skipped=%ld\n",
            winetest_failures, winetest_flaky_failures, winetest_skipped);
    rgb_reference_rows();
    printf("COMPLETE native_rgb_sphere=1\n");
    fflush(stdout);FlushFileBuffers(GetStdHandle(STD_OUTPUT_HANDLE));
    return winetest_failures || winetest_flaky_failures;
}
