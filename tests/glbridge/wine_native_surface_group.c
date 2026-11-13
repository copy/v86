/* Diagnostic group selection. Frozen upstream assertions remain unchanged. */
#define main wine_original_main
#ifndef STANDALONE
#define STANDALONE
#endif
#include DDRAW_SURFACE_SOURCE
#undef main
#define RUN_GROUP(name) do { \
    LONG before_fail=winetest_failures,before_flaky=winetest_flaky_failures,before_skip=winetest_skipped; \
    test_##name(); \
    printf("SURFACE_GROUP name=%s failures=%ld flaky=%ld skipped=%ld\n",#name, \
        winetest_failures-before_fail,winetest_flaky_failures-before_flaky,winetest_skipped-before_skip); \
}while(0)
int main(int argc,char**argv)
{
    char directory[MAX_PATH];
    HMODULE module;
    setvbuf(stdout,NULL,_IONBF,0);
    winetest_mutex=CreateMutexA(NULL,FALSE,"winetest_print_mutex");
    winetest_argc=argc;winetest_argv=argv;
    current_test=&winetest_testlist[0];
    winetest_start_time=winetest_last_time=winetest_get_time();
    SetUnhandledExceptionFilter(exc_filter);
    SetErrorMode(SEM_FAILCRITICALERRORS|SEM_NOGPFAULTERRORBOX);
    GetSystemDirectoryA(directory,sizeof(directory));lstrcatA(directory,"\\ddraw.dll");
    module=LoadLibraryA(directory);
    if(!module||GetModuleHandleA("ddraw.dll")!=module){printf("FAIL native DLL load\n");return 1;}
#if DDRAW_SURFACE_VERSION == 7
    pDirectDrawCreateEx=(void*)GetProcAddress(module,"DirectDrawCreateEx");
    if(!pDirectDrawCreateEx){printf("FAIL native factory\n");return 1;}
#endif
    ZeroMemory(&registry_mode,sizeof(registry_mode));registry_mode.dmSize=sizeof(registry_mode);
    if(!EnumDisplaySettingsA(NULL,ENUM_REGISTRY_SETTINGS,&registry_mode)){printf("FAIL registry mode\n");return 1;}
    start_foreground_window_thread();
    RUN_GROUP(sysmem_overlay);
    RUN_GROUP(surface_attachment);
    RUN_GROUP(d32_support);
#if DDRAW_SURFACE_VERSION != 7
    RUN_GROUP(transform_vertices);
#endif
    RUN_GROUP(viewport);
    printf("SURFACE_GROUP_TOTAL version=%u failures=%ld flaky=%ld skipped=%ld\n",
        DDRAW_SURFACE_VERSION,winetest_failures,winetest_flaky_failures,winetest_skipped);
    printf("COMPLETE native_surface_group=%u\n",DDRAW_SURFACE_VERSION);
    return 0;
}
