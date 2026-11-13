// The native iOS 6 installation entry point. The service loop is added
// separately; this CLI also makes the real installation path reproducible.
#include "ios-api.h"
typedef int (*install_fn)(CFStringRef, CFDictionaryRef, void (*)(CFDictionaryRef), CFStringRef);
typedef CFDictionaryRef (*lookup_fn)(CFDictionaryRef);
static int callback_failed;
static void status(CFDictionaryRef info)
{
    CFStringRef key = string("Status"), error = string("Error");
    char text[256] = "", detail[256] = "";
    CFTypeRef value = CFDictionaryGetValue(info, key);
    if(value) CFStringGetCString(value, text, sizeof(text), UTF8);
    value = CFDictionaryGetValue(info, error);
    if(value) { callback_failed = 1; CFStringGetCString(value, detail, sizeof(detail), UTF8); }
    printf("V86 install status: %s %s\n", text, detail);
    syslog(5, "V86 install status: %s %s", text, detail);
    CFRelease(key); CFRelease(error);
}
int main(int argc, char **argv)
{
    if(argc != 3 || strcmp(argv[1], "--install-test")) {
        printf("usage: v86-app-agent --install-test /absolute/path.ipa\n"); return 2;
    }
    void *pool = objc_autoreleasePoolPush();
    void *mi = dlopen("/System/Library/PrivateFrameworks/MobileInstallation.framework/MobileInstallation", 1);
    install_fn install = mi ? (install_fn)dlsym(mi, "MobileInstallationInstall") : 0;
    lookup_fn lookup = mi ? (lookup_fn)dlsym(mi, "MobileInstallationLookup") : 0;
    if(!install || !lookup) { printf("V86 install unavailable: %s\n", dlerror()); return 3; }
    CFMutableDictionaryRef options = CFDictionaryCreateMutable(0, 0, kCFTypeDictionaryKeyCallBacks, kCFTypeDictionaryValueCallBacks);
    CFStringRef key = string("ApplicationType"), value = string("User"), path = string(argv[2]);
    CFDictionarySetValue(options, key, value);
    int result = install(path, options, status, path);
    CFDictionaryRef apps = lookup(options);
    long count = apps ? CFDictionaryGetCount(apps) : -1;
    printf("V86 install result: %d callback_failed=%d user_apps=%ld\n", result, callback_failed, count);
    syslog(5, "V86 install result: %d callback_failed=%d user_apps=%ld", result, callback_failed, count);
    if(apps) CFRelease(apps);
    CFRelease(path); CFRelease(value); CFRelease(key); CFRelease(options);
    sync(); objc_autoreleasePoolPop(pool);
    return result || callback_failed ? 1 : 0;
}
