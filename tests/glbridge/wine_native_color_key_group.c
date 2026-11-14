/* Diagnostic entry selection only: include the frozen upstream translation
 * unit unchanged, and call its original caps/GDI tests with system DDraw.
 * This is not the complete Wine acceptance run and does not waive assertions. */
#define main wine_original_main
#ifndef STANDALONE
#define STANDALONE
#endif
#include DDRAW_COLOR_SOURCE
#undef main
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
    test_ck_operation();
    printf("COLOR_KEY_GROUP version=%u failures=%ld flaky=%ld skipped=%ld\n",
            DDRAW_COLOR_VERSION, winetest_failures, winetest_flaky_failures, winetest_skipped);
    printf("COMPLETE native_color_key_group=%u\n", DDRAW_COLOR_VERSION);
    return 0;
}
