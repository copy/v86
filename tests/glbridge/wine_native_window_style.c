/* Diagnostic group selection. Frozen upstream assertions remain unchanged. */
#define main wine_original_main
#ifndef STANDALONE
#define STANDALONE
#endif
#include DDRAW_STYLE_SOURCE
#undef main
#define RUN_GROUP(name) do { \
    LONG before_fail=winetest_failures,before_flaky=winetest_flaky_failures,before_skip=winetest_skipped; \
    test_##name(); \
    printf("STYLE_GROUP name=%s failures=%ld flaky=%ld skipped=%ld\n",#name, \
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
#if DDRAW_STYLE_VERSION == 7
    pDirectDrawCreateEx=(void*)GetProcAddress(module,"DirectDrawCreateEx");
    if(!pDirectDrawCreateEx){printf("FAIL native factory\n");return 1;}
#endif
    ZeroMemory(&registry_mode,sizeof(registry_mode));registry_mode.dmSize=sizeof(registry_mode);
    if(!EnumDisplaySettingsA(NULL,ENUM_REGISTRY_SETTINGS,&registry_mode)){printf("FAIL registry mode\n");return 1;}
    start_foreground_window_thread();
    for (unsigned iteration=0;iteration<4;++iteration) {
        printf("WINDOW_STYLE iteration=%u\n",iteration);
        RUN_GROUP(window_style);
    }
    printf("STYLE_GROUP_TOTAL version=%u failures=%ld flaky=%ld skipped=%ld\n",
        DDRAW_STYLE_VERSION,winetest_failures,winetest_flaky_failures,winetest_skipped);
    printf("COMPLETE native_style_group=%u\n",DDRAW_STYLE_VERSION);
    return 0;
}
