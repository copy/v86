// 10B329 installd's verified lazy import is redirected to this adapter.
// Approved code still passes libmis's native ad-hoc signature validation.
#include "ios-api.h"
extern CFMutableDictionaryRef CFDictionaryCreateMutableCopy(CFAllocatorRef, long, CFDictionaryRef);
extern const void *kCFBooleanTrue;
extern void *CFURLCreateWithFileSystemPath(CFAllocatorRef, CFStringRef, long, Boolean);
extern void *CFBundleCreate(CFAllocatorRef, void *), *CFBundleCopyExecutableURL(void *);
extern Boolean CFURLGetFileSystemRepresentation(void *, Boolean, unsigned char *, long);
extern long long lseek(int, long long, int);
extern unsigned char *CC_SHA1(const void *, unsigned, unsigned char *);
extern const void *_dyld_get_image_header(unsigned);
typedef int (*validate_fn)(CFStringRef, CFDictionaryRef, CFDictionaryRef *);
static validate_fn native_validate;
static CFStringRef allow_adhoc, signature_only;
#include "app-code-hash.h"
#define le code_le
static int trusted_code(const char *path)
{
    unsigned char digest[20],list[12+189*20];if(!app_code_identity(path,digest,0))return 0;
    int fd=open("/private/var/v86/install-trust.bin",0);if(fd<0)return 0;unsigned used=0;int n;
    while(used<sizeof(list) && (n=read(fd,list+used,sizeof(list)-used))>0)used+=n;close(fd);
    if(used<12 || memcmp(list,"V86T",4) || le(list+4)!=1 || le(list+8)>189 || used!=12+20*le(list+8))return 0;
    for(unsigned i=0;i<le(list+8);i++)if(!memcmp(digest,list+12+20*i,20))
    {
        unsigned char verified[20];return app_code_hash(path,verified) && !memcmp(digest,verified,20);
    }
    return 0;
}
static int approved(CFStringRef path)
{
    unsigned char filename[1024]; int ok=0;
    if(CFStringGetCString(path,(char *)filename,sizeof(filename),UTF8) && trusted_code((char *)filename))return 1;
    void *url=CFURLCreateWithFileSystemPath(0,path,0,1);
    void *bundle=url?CFBundleCreate(0,url):0;
    void *executable=bundle?CFBundleCopyExecutableURL(bundle):0;
    if(executable && CFURLGetFileSystemRepresentation(executable,1,filename,sizeof(filename)))ok=trusted_code((const char *)filename);
    if(executable)CFRelease(executable);if(bundle)CFRelease(bundle);if(url)CFRelease(url);
    return ok;
}
static int validate(CFStringRef path,CFDictionaryRef options,CFDictionaryRef *info)
{
    int allowed=approved(path);char filename[1024]="?";CFStringGetCString(path,filename,sizeof(filename),UTF8);
    if(!allowed){int result=native_validate(path,options,info);syslog(5,"V86 MIS native path=%s result=%d",filename,result);return result;}
    CFMutableDictionaryRef local=options?CFDictionaryCreateMutableCopy(0,0,options):
        CFDictionaryCreateMutable(0,0,kCFTypeDictionaryKeyCallBacks,kCFTypeDictionaryValueCallBacks);
    if(!local)return native_validate(path,options,info);
    CFDictionarySetValue(local,allow_adhoc,kCFBooleanTrue);
    CFDictionarySetValue(local,signature_only,kCFBooleanTrue);
    int result=native_validate(path,local,info);CFRelease(local);
    syslog(5,"V86 MIS approved path=%s result=%d",filename,result);return result;
}
__attribute__((constructor)) static void install_policy(void)
{
    syslog(5,"V86 signature policy loading");
    void *mis=dlopen("/usr/lib/libmis.dylib",1);
    native_validate=mis?(validate_fn)dlsym(mis,"MISValidateSignatureAndCopyInfo"):0;
    CFStringRef *a=mis?(CFStringRef *)dlsym(mis,"kMISValidationOptionAllowAdHocSigning"):0;
    CFStringRef *s=mis?(CFStringRef *)dlsym(mis,"kMISValidationOptionValidateSignatureOnly"):0;
    if(!native_validate || !a || !s)return;
    allow_adhoc=*a;signature_only=*s;
    unsigned char *image=(unsigned char *)_dyld_get_image_header(0);
    // Host preparation verifies the full stock installd fingerprint before
    // inserting this library. __TEXT is 0x1000; MIS's lazy slot is 0x6d00c.
    if(image && le(image)==0xFEEDFACE && le(image+4)==12)
        *(validate_fn *)(image+0x6c00c)=validate;
}
