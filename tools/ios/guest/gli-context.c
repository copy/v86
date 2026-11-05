// iPhone3,1 10B329. The real EAGL framework owns its Objective-C objects,
// TLS, pixel-format selection and both 914-entry dispatch tables.
#include "gles-transport.h"
#include "gles-driver.h"
#include "gl-scalar.h"

typedef __SIZE_TYPE__ usize;
typedef void (*fn)(void);
extern void *calloc(usize, usize), *malloc(usize);
extern void free(void *);
extern int strcmp(const char *, const char *), memcmp(const void *, const void *, usize);
extern void *memcpy(void *, const void *, usize);
extern void *objc_getClass(const char *), *sel_registerName(const char *);
extern void *class_getInstanceMethod(void *, void *), *class_getInstanceVariable(void *, const char *);
extern long ivar_getOffset(void *);
extern fn method_getImplementation(void *), method_setImplementation(void *, fn);
extern int getpid(void);
extern void syslog(int, const char *, ...);
struct image_info { const char *file; void *base; const char *symbol; void *address; };
extern int dladdr(const void *, struct image_info *);
extern void *dlsym(void *, const char *);
extern void OSSpinLockLock(volatile int *), OSSpinLockUnlock(volatile int *);

struct context {
    struct n90_driver driver;    // also the opaque argument of public GL calls
    struct context *next;
    struct group *group;
    unsigned handle, error;
    char *strings[5];
};
struct group {
    struct group *next;
    struct binding *bindings;
    unsigned connection, handle;
};
static struct context *contexts;
static struct group *groups;
static volatile int lock;
static long group_offset, context_offset;
static fn original[18], *slots;
typedef void (*load_method)(void *, void *, const unsigned *, signed char);
typedef void (*dispose_method)(void *, void *);
static load_method original_load;
static dispose_method original_dispose;
typedef signed char (*present_method)(void *, void *, unsigned);
static present_method original_present;
static const char *const symbols[] = {
    "gliChoosePixelFormat", "gliDestroyPixelFormat", "gliQueryRendererInfo", "gliDestroyRendererInfo",
    "gliCreateContext", "gliCreateContextWithShared", "gliDestroyContext", "gliAttachDrawable",
    "gliAttachDrawableWithOptions", "gliSetInteger", "gliGetInteger", "gliGetAttribute", "gliSetAttribute",
    "gliCopyAttributes", "gliGetVersion", "gliBindViewES", "gliPresentViewES",
};

static int create_handle(unsigned *connection, unsigned *handle, unsigned share)
{
    int c = gles_open();
    if(c < 0) return 0;
    if(!SEND(c, rc_rcCreateContext, 3, share, 2) || !gles_read(c, handle, 4) || !*handle)
    {
        gles_call(5, 0, 0, c);
        return 0;
    }
    *connection = c;
    return 1;
}

static void close_handle(unsigned connection, unsigned handle)
{
    SEND(connection, rc_rcDestroyContext, handle);
    gles_call(5, 0, 0, connection);
}

static unsigned invalid_operation(struct context *ctx)
{
    if(!ctx->error) ctx->error = 0x502;
    return 0;
}

#include "gli-surface.h"
#include "gli-draw.h"
#include "gli-query.h"
#include "gli-uniform.h"

static unsigned get_error(struct context *ctx)
{
    unsigned error = ctx->error;
    ctx->error = 0;
    if(!ctx->driver.ok) { ctx->driver.ok = 1; if(!error) error = 0x502; }
    if(!error && (!SEND(ctx->driver.connection, gles2_glGetError) || !gles_read(ctx->driver.connection, &error, 4))) return 0x502;
    return error;
}

static const char *get_string(struct context *ctx, unsigned name)
{
    unsigned i = name - 0x1f00;
    if(name == 0x8b8c) i = 4;
    if(i >= 5) { if(!ctx->error) ctx->error = 0x500; return 0; }
    if(ctx->strings[i]) return ctx->strings[i];
    int size = 0, count = 0;
    unsigned conn = ctx->driver.connection;
    if(!SEND(conn, rc_rcGetGLString, name, 0, 0) || !gles_read(conn, &size, 4) || size >= 0 || size < -65536) return 0;
    size = -size;
    char *text = malloc(size);
    if(!text) { if(!ctx->error) ctx->error = 0x505; return 0; }
    if(!SEND(conn, rc_rcGetGLString, name, size, size) || !gles_read(conn, text, size) ||
        !gles_read(conn, &count, 4) || count != size || text[size - 1])
    {
        free(text);
        return 0;
    }
    return ctx->strings[i] = text;
}

// GLEngine's public glDeleteShader and glDeleteProgram are identical
// wrappers on 10B329. Both types share one host name space.
static void delete_object(struct context *ctx, unsigned name)
{
    if(!name) return;
    if(driver_glIsShader(&ctx->driver, name))
        ctx->driver.ok &= SEND(ctx->driver.connection, gles2_glDeleteShader, name);
    else if(driver_glIsProgram(&ctx->driver, name))
        ctx->driver.ok &= SEND(ctx->driver.connection, gles2_glDeleteProgram, name);
    else if(!ctx->error) ctx->error = 0x501;
}

typedef int (*create_fn)(void **, const void *, struct group *, driver_word *, driver_word *, const void *);
static int create_context(void **out, const void *format, struct group *group, driver_word *primary, driver_word *alternate, const void *opts)
{
    OSSpinLockLock(&lock);
    struct group *g = groups;
    while(g && g != group) g = g->next;
    OSSpinLockUnlock(&lock);
    if(!g) return ((create_fn)original[6])(out, format, group, primary, alternate, opts);
    struct context *ctx = calloc(1, sizeof(*ctx));
    if(!ctx) return 1;
    if(!create_handle(&ctx->driver.connection, &ctx->handle, g->handle)) { free(ctx); return 1; }
    unsigned ok = 0;
    if(!SEND(ctx->driver.connection, rc_rcMakeCurrent, ctx->handle, 0, 0) ||
        !gles_read(ctx->driver.connection, &ok, 4) || !ok)
    {
        close_handle(ctx->driver.connection, ctx->handle);
        free(ctx);
        return 1;
    }
    ctx->group = g;
    ctx->driver.ok = 1;
    // GLI receives pointers to the function arrays; OpenGLES public
    // wrappers index from the start of the enclosing EAGL private state.
    for(int i = 0; i < 914; i++) primary[i] = (driver_word)invalid_operation;
    install_frame_functions(primary);
    install_scalar_functions(primary);
    install_surface_functions(primary);
    install_draw_functions(primary);
    install_query_functions(primary);
    install_uniform_functions(primary);
    primary[N90_glDeleteShader - 5] = (driver_word)delete_object;
    primary[N90_glGetError - 5] = (driver_word)get_error;
    primary[N90_glGetString - 5] = (driver_word)get_string;
    memcpy(alternate, primary, 914 * sizeof(driver_word));
    OSSpinLockLock(&lock);
    ctx->next = contexts;
    contexts = ctx;
    OSSpinLockUnlock(&lock);
    *out = ctx;
    syslog(5, "V86 GLI created pid %d context %u share %u", getpid(), ctx->handle, g->handle);
    return 0;
}

static int destroy_context(struct context *ctx)
{
    OSSpinLockLock(&lock);
    struct context **p = &contexts;
    while(*p && *p != ctx) p = &(*p)->next;
    if(*p) *p = ctx->next;
    OSSpinLockUnlock(&lock);
    close_handle(ctx->driver.connection, ctx->handle);
    for(int i = 0; i < 5; i++) free(ctx->strings[i]);
    free(ctx);
    return 0;
}

static int unavailable(void) { return 1; }


static signed char present(void *obj, void *sel, unsigned target)
{
    struct context *ctx = host_context(obj);
    if(ctx) return target == 0x8d41 && present_view(ctx);
    return original_present(obj, sel, target);
}
fn n90_gli_target(unsigned slot, void *const *args)
{
    OSSpinLockLock(&lock);
    fn target = original[slot];
    for(struct context *c = contexts; c; c = c->next)
    {
        if(args[0] == c || args[1] == c || args[2] == c || args[3] == c)
        {
            if(slot == 7 && args[0] == c) target = (fn)destroy_context;
            else if(slot == 16 && args[0] == c) target = (fn)bind_view;
            else if(slot == 17 && args[0] == c) target = (fn)present_view;
            else target = (fn)unavailable;
            break;
        }
    }
    OSSpinLockUnlock(&lock);
    return target;
}

extern void n90_gli_5(void), n90_gli_7(void), n90_gli_8(void), n90_gli_9(void), n90_gli_10(void),
    n90_gli_11(void), n90_gli_12(void), n90_gli_13(void), n90_gli_14(void), n90_gli_16(void), n90_gli_17(void);
static fn const gates[18] = { 0, 0, 0, 0, 0, n90_gli_5, (fn)create_context, n90_gli_7, n90_gli_8,
    n90_gli_9, n90_gli_10, n90_gli_11, n90_gli_12, n90_gli_13, n90_gli_14, 0, n90_gli_16, n90_gli_17 };

static int route_provider(void)
{
    if(!slots[0]) return 0;
    // GLEngine can unload when the final sharegroup is released. Recheck
    // the current library's exports before each installation.
    fn resolved[18];
    for(unsigned i = 1; i < 18; i++)
    {
        resolved[i] = (fn)dlsym((void *)slots[0], symbols[i-1]);
        if(!resolved[i]) return 0;
    }
    int ok = 1;
    OSSpinLockLock(&lock);
    for(unsigned i = 1; i < 18; i++)
        if(slots[i] != resolved[i] && !(gates[i] && slots[i] == gates[i] && original[i] == resolved[i])) ok = 0;
    if(ok)
        for(unsigned i = 1; i < 18; i++)
            if(gates[i]) { original[i] = resolved[i]; slots[i] = gates[i]; }
    OSSpinLockUnlock(&lock);
    return ok;
}

static unsigned *group_state(void *obj) { return *(unsigned **)((char *)obj + group_offset); }
static void load_group(void *obj, void *sel, const unsigned *format, signed char compute)
{
    unsigned *state = group_state(obj);
    if(!state || state[0] != 2 || compute || !route_provider())
    {
        original_load(obj, sel, format, compute);
        return;
    }
    struct group *g = calloc(1, sizeof(*g));
    if(!g) return;
    if(!create_handle(&g->connection, &g->handle, 0)) { free(g); return; }
    memcpy(state + 3, format, 52);
    state[3] = 0;
    state[16] = (unsigned)g;
    OSSpinLockLock(&lock);
    g->next = groups;
    groups = g;
    OSSpinLockUnlock(&lock);
    state[1] = 1;
}

static void dispose_group(void *obj, void *sel)
{
    unsigned *state = group_state(obj);
    struct group *g = 0;
    if(state)
    {
        OSSpinLockLock(&lock);
        struct group **p = &groups;
        while(*p && (unsigned)*p != state[16]) p = &(*p)->next;
        if(*p) { g = *p; *p = g->next; state[16] = 0; }
        OSSpinLockUnlock(&lock);
    }
    if(g)
    {
        while(g->bindings)
        {
            struct binding *b = g->bindings;
            g->bindings = b->next;
            release_binding(b);
        }
        close_handle(g->connection, g->handle);
        free(g);
    }
    original_dispose(obj, sel);
}

int n90_install_contexts(void)
{
    void *cls = objc_getClass("EAGLSharegroup");
    void *load = class_getInstanceMethod(cls, sel_registerName("loadGLIPlugin:sharedWithCompute:"));
    void *dispose = class_getInstanceMethod(cls, sel_registerName("dealloc"));
    void *ivar = class_getInstanceVariable(cls, "_private");
    void *eagl = objc_getClass("EAGLContext");
    void *present_sel = class_getInstanceMethod(eagl, sel_registerName("presentRenderbuffer:"));
    void *ctx_ivar = class_getInstanceVariable(eagl, "_private");
    void *surface_sel = class_getInstanceMethod(eagl, sel_registerName(
        "texImageIOSurface:target:internalFormat:width:height:format:type:plane:invert:"));
    struct image_info info;
    if(!load || !dispose || !ivar || !present_sel || !surface_sel || !ctx_ivar || !dladdr((void *)method_getImplementation(load), &info)) return 0;
    const unsigned *hdr = info.base;
    if(hdr[0] != 0xfeedface || hdr[1] != 12) return 0;
    const unsigned *cmd = hdr + 7;
    unsigned unslid = 0, table = 0;
    int uuid_matches = 0;
    const unsigned char uuid[16] = {0xf2,0xed,0xe6,0xb2,0x06,0xf3,0x36,0xde,0x82,0xcc,0x38,0x61,0x96,0x92,0xe7,0x62};
    for(unsigned i = 0; i < hdr[4]; i++)
    {
        if(cmd[0] == 0x1b && cmd[1] == 24) uuid_matches = !memcmp(cmd + 2, uuid, 16);
        if(cmd[0] == 1 && !strcmp((const char *)(cmd + 2), "__TEXT")) unslid = cmd[6];
        if(cmd[0] == 1 && !strcmp((const char *)(cmd + 2), "__DATA"))
            for(unsigned j = 0; j < cmd[12]; j++)
            {
                const unsigned *sect = cmd + 14 + j * 17;
                if(!strcmp((const char *)sect, "__common") && sect[9] == 76) table = sect[8];
            }
        cmd += cmd[1] / 4;
    }
    if(!uuid_matches || !unslid || !table) return 0;
    slots = (fn *)((unsigned)hdr + table - unslid);
    group_offset = ivar_getOffset(ivar);
    context_offset = ivar_getOffset(ctx_ivar);
    native_surface = (surface_method)method_setImplementation(surface_sel, (fn)attach_surface);
    original_present = (present_method)method_setImplementation(present_sel, (fn)present);
    original_dispose = (dispose_method)method_setImplementation(dispose, (fn)dispose_group);
    original_load = (load_method)method_setImplementation(load, (fn)load_group);
    return 1;
}
