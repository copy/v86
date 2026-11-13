// The native iOS 6 installation entry point. The service loop is added
// separately; this CLI also makes the real installation path reproducible.
#include "app-native.h"
#include "app-code-hash.h"
typedef int (*install_fn)(CFStringRef, CFDictionaryRef, void (*)(CFDictionaryRef), CFStringRef);
typedef CFDictionaryRef (*lookup_fn)(CFDictionaryRef);
static install_fn native_install;
static lookup_fn native_lookup;
int app_native_load(void)
{
    void *mi=dlopen("/System/Library/PrivateFrameworks/MobileInstallation.framework/MobileInstallation",1);
    native_install=mi?(install_fn)dlsym(mi,"MobileInstallationInstall"):0;
    native_lookup=mi?(lookup_fn)dlsym(mi,"MobileInstallationLookup"):0;
    return native_install && native_lookup;
}
static CFMutableDictionaryRef user_options(void)
{
    CFMutableDictionaryRef options=CFDictionaryCreateMutable(0,0,kCFTypeDictionaryKeyCallBacks,kCFTypeDictionaryValueCallBacks);
    CFStringRef key=string("ApplicationType"),value=string("User");CFDictionarySetValue(options,key,value);CFRelease(key);CFRelease(value);return options;
}
int app_native_install(const char *filename,void (*callback)(CFDictionaryRef))
{
    void *pool=objc_autoreleasePoolPush();CFStringRef path=string(filename);CFMutableDictionaryRef options=user_options();
    int result=native_install(path,options,callback,path);CFRelease(options);CFRelease(path);objc_autoreleasePoolPop(pool);return result;
}
static int property(CFDictionaryRef dict,const char *name,char *out,unsigned capacity)
{
    CFStringRef key=string(name);CFTypeRef value=CFDictionaryGetValue(dict,key);int ok=value&&CFStringGetCString(value,out,capacity,UTF8);CFRelease(key);return ok;
}
int app_native_lookup(const char *bundle,struct app_identity *identity)
{
    memset(identity,0,sizeof(*identity));
    void *pool=objc_autoreleasePoolPush();CFMutableDictionaryRef options=user_options();CFDictionaryRef apps=native_lookup(options);
    CFStringRef key=string(bundle);CFDictionaryRef app=apps?CFDictionaryGetValue(apps,key):0;int ok=0;
    if(app)
    {
        char path[1024],executable[256];
        if(!property(app,"CFBundleShortVersionString",identity->version,sizeof(identity->version)))property(app,"CFBundleVersion",identity->version,sizeof(identity->version));
        if(property(app,"Path",path,sizeof(path)) && property(app,"CFBundleExecutable",executable,sizeof(executable)) &&
            snprintf(identity->executable,sizeof(identity->executable),"%s/%s",path,executable)<(int)sizeof(identity->executable))
            ok=app_code_hash(identity->executable,identity->cdhash);
    }
    CFRelease(key);if(apps)CFRelease(apps);CFRelease(options);objc_autoreleasePoolPop(pool);return ok;
}
unsigned long long app_native_free(void)
{
    void *pool=objc_autoreleasePoolPush(),*manager=send0(objc_getClass("NSFileManager"),"defaultManager");
    CFStringRef path=string("/private/var"),key=string("NSFileSystemFreeSize");
    void *attrs=((void *(*)(void *,void *,void *,void *))objc_msgSend)(manager,sel_registerName("attributesOfFileSystemForPath:error:"),(void *)path,0);
    void *number=send1(attrs,"objectForKey:",(void *)key);
    unsigned long long available=number?((unsigned long long (*)(void *,void *))objc_msgSend)(number,sel_registerName("unsignedLongLongValue")):0;
    CFRelease(path);CFRelease(key);objc_autoreleasePoolPop(pool);return available;
}
static int callback_failed;
static void trace(const char *text) { write(1, text, strlen(text)); }
static void dump_install_log(void)
{
    void *(*new_query)(unsigned)=(void *(*)(unsigned))dlsym((void *)-2,"asl_new");
    int (*set_query)(void *,const char *,const char *,unsigned)=(int (*)(void *,const char *,const char *,unsigned))dlsym((void *)-2,"asl_set_query");
    void *(*search)(void *,void *)=(void *(*)(void *,void *))dlsym((void *)-2,"asl_search");
    void *(*next)(void *)=(void *(*)(void *))dlsym((void *)-2,"aslresponse_next");
    const char *(*get)(void *,const char *)=(const char *(*)(void *,const char *))dlsym((void *)-2,"asl_get");
    void (*release_query)(void *)=(void (*)(void *))dlsym((void *)-2,"asl_free");
    void (*release_result)(void *)=(void (*)(void *))dlsym((void *)-2,"aslresponse_free");
    if(new_query && set_query && search && next && get && release_query && release_result)
    {
        trace("V86 installd ASL messages begin\n");void *q=new_query(1);set_query(q,"Sender","installd",1);void *r=search(0,q),*message;unsigned count=0;
        if(r){while(count++<512 && (message=next(r))){const char *text=get(message,"Message");if(text){trace(text);trace("\n");}}release_result(r);}release_query(q);
        trace("V86 installd ASL messages end\n");
    }
    char data[4096];int fd=open("/var/mobile/Library/Logs/MobileInstallation/mobile_installation.log",0);
    if(fd<0){trace("V86 native installation log is not present\n");return;}
    long long end=lseek(fd,0,2);if(end>65536)lseek(fd,end-65536,0);else lseek(fd,0,0);
    trace("V86 native installation log begins\n");int n;while((n=read(fd,data,sizeof(data)))>0)write(1,data,n);close(fd);trace("V86 native installation log ends\n");
}
static void status(CFDictionaryRef info)
{
    CFShow(info);
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
    int console = open("/dev/console", 2);
    if(console >= 0) { dup2(console, 1); dup2(console, 2); trace("V86 install helper started\n"); }
    if(argc == 2 && !strcmp(argv[1],"--serve"))return app_service();
    if(argc != 3 || strcmp(argv[1], "--install-test")) {
        printf("usage: v86-app-agent --install-test /absolute/path.ipa\n"); return 2;
    }
    trace("V86 install loading framework\n");
    void *mi = dlopen("/System/Library/PrivateFrameworks/MobileInstallation.framework/MobileInstallation", 1);
    trace("V86 install resolving API\n");
    install_fn install = mi ? (install_fn)dlsym(mi, "MobileInstallationInstall") : 0;
    lookup_fn lookup = mi ? (lookup_fn)dlsym(mi, "MobileInstallationLookup") : 0;
    if(!install || !lookup) { printf("V86 install unavailable: %s\n", dlerror()); return 3; }
    trace("V86 install preparing options\n");
    CFMutableDictionaryRef options = CFDictionaryCreateMutable(0, 0, kCFTypeDictionaryKeyCallBacks, kCFTypeDictionaryValueCallBacks);
    CFStringRef key = string("ApplicationType"), value = string("User"), path = string(argv[2]);
    CFDictionarySetValue(options, key, value);
    trace("V86 install querying applications before installation\n");
    CFDictionaryRef before = lookup(options);
    if(before) CFRelease(before);
    trace("V86 install initial lookup answered\n");
    trace("V86 install calling native installer\n");
    int result = install(path, options, status, path);
    dump_install_log();
    trace("V86 install querying installed applications\n");
    CFDictionaryRef apps = lookup(options);
    long count = apps ? CFDictionaryGetCount(apps) : -1;
    printf("V86 install result: %d callback_failed=%d user_apps=%ld\n", result, callback_failed, count);
    syslog(5, "V86 install result: %d callback_failed=%d user_apps=%ld", result, callback_failed, count);
    if(apps) CFRelease(apps);
    CFRelease(path); CFRelease(value); CFRelease(key); CFRelease(options);
    sync();
    return result || callback_failed ? 1 : 0;
}
