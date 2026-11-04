// iPhone3,1 / iOS 6.1.3. Resolve the Objective-C selector at runtime so
// callers inside the shared cache take the same method as external callers.
#include "gles-transport.h"

extern int getpid(void);
extern void syslog(int, const char *, ...);
extern unsigned IORegistryEntryFromPath(unsigned, const char *);
extern int IORegistryEntryGetProperty(unsigned, const char *, char *, unsigned *);
extern int IOObjectRelease(unsigned);
extern void *objc_getClass(const char *);
extern void *sel_registerName(const char *);
extern void *class_getInstanceMethod(void *, void *);
typedef void (*implementation)(void);
extern implementation method_setImplementation(void *, implementation);

#ifdef N90_HOST_CONTEXTS
extern int n90_install_contexts(void);
#ifdef N90_CHECK_CONTEXTS
extern void n90_check_contexts(void);
#endif
#endif
typedef void *(*init_method)(void *, void *, unsigned, void *);
static init_method native_init;

static void *init_context(void *object, void *selector, unsigned api, void *properties)
{
    void *context = native_init(object, selector, api, properties);
    syslog(5, "V86 EAGL init pid %d API %u result %p", getpid(), api, context);
    return context;
}

static int host_available(void)
{
    // An image may also be started with the graphics transport disabled.
    // Only execute its UDF when this boot's hardware advertises support.
    unsigned chosen = IORegistryEntryFromPath(0, "IODeviceTree:/chosen");
    if(!chosen) return 0;
    unsigned version = 0, length = sizeof(version);
    int err = IORegistryEntryGetProperty(chosen, "v86,gles-backdoor", (char *)&version, &length);
    IOObjectRelease(chosen);
    return !err && length == sizeof(version) && version == 1;
}

__attribute__((constructor)) static void start_driver(void)
{
    if(!host_available()) return;
    int conn = gles_open();
    if(conn < 0) return;
    unsigned width = 0, height = 0;
    int ok = SEND(conn, rc_rcGetFBParam, 1) && gles_read(conn, &width, sizeof(width)) &&
        SEND(conn, rc_rcGetFBParam, 2) && gles_read(conn, &height, sizeof(height));
    gles_call(5, 0, 0, conn);
    if(!ok) return;
    void *cls = objc_getClass("EAGLContext");
    void *method = cls ? class_getInstanceMethod(cls, sel_registerName("initWithAPI:properties:")) : 0;
    if(!method) return;
    native_init = (init_method)method_setImplementation(method, (implementation)init_context);
#ifdef N90_HOST_CONTEXTS
    if(n90_install_contexts())
    {
        syslog(5, "V86 GLI provider installed pid %d", getpid());
#ifdef N90_CHECK_CONTEXTS
        n90_check_contexts();
#endif
    }
#endif
    syslog(5, "V86 EAGL attached pid %d display %ux%u", getpid(), width, height);
}
