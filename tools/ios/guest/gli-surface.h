// One lease per bound GL object in the EAGL sharegroup. The dedicated
// renderControl connection keeps the color buffer live independently of
// whichever context last bound the shared texture or renderbuffer.
extern unsigned IOSurfaceGetID(void *), IOSurfaceGetWidth(void *), IOSurfaceGetHeight(void *), IOSurfaceGetPixelFormat(void *);
extern void *CFRetain(void *);
extern void CFRelease(void *);

extern int IOSurfaceLock(void *, unsigned, unsigned *), IOSurfaceUnlock(void *, unsigned, unsigned *);
extern void *IOSurfaceGetBaseAddress(void *);
extern unsigned IOSurfaceGetBytesPerRow(void *);

struct window_callbacks {
    void *data;
    unsigned (*ready)(void *);
    void (*release_surface)(void *, void *);
    unsigned (*fence)(void *);
};
struct native_window {
    int version;
    int (*open)(struct native_window *, unsigned, const struct window_callbacks *);
    void (*close)(struct native_window *);
    void *(*surface)(struct native_window *);
    int (*post)(struct native_window *, unsigned);
};

struct binding {
    struct binding *next;
    void *surface;
    struct native_window *window;
    unsigned name, target, handle, id, refs, retained, published;
    int lease;
};

static void release_binding(struct binding *b)
{
    if(!b) return;
    OSSpinLockLock(&lock);
    unsigned refs = --b->refs;
    OSSpinLockUnlock(&lock);
    if(refs) return;
    if(b->window) b->window->close(b->window);
    gles_call(5, 0, 0, b->lease);
    CFRelease(b->surface);
    free(b);
}

static void replace_binding(struct group *group, unsigned target, unsigned name, struct binding *replacement)
{
    OSSpinLockLock(&lock);
    struct binding **p = &group->bindings;
    while(*p && ((*p)->target != target || (*p)->name != name)) p = &(*p)->next;
    struct binding *old = *p;
    if(old)
    {
        if(replacement && replacement->window == old->window) old->window = 0;
        *p = old->next;
    }
    if(replacement) { replacement->next = group->bindings; group->bindings = replacement; }
    OSSpinLockUnlock(&lock);
    release_binding(old);
}

static int integer_value(struct context *ctx, unsigned pname, int *out)
{
    unsigned c = ctx->driver.connection;
    return SEND(c, gles2_glGetIntegerv, pname, 4) && gles_read(c, out, 4);
}

static struct context *host_context(void *object)
{
    driver_word *state = *(driver_word **)((char *)object + context_offset);
    if(!state) return 0;
    OSSpinLockLock(&lock);
    struct context *c = contexts;
    while(c && (driver_word)c != state[4]) c = c->next;
    OSSpinLockUnlock(&lock);
    return c;
}

// CPU producers (including Core Animation) may fill a native surface
// before GL sees it. A read-only lock supplies the kernel seed covering
// these bytes. An unchanged seed must not overwrite newer GPU drawing.
static int import_pixels(struct binding *b)
{
    unsigned seed = 0, current = 0, ok = 0;
    if(IOSurfaceLock(b->surface, 1, &seed)) return 0;
    if(SEND(b->lease, v86_IOSurfaceIsCurrent, b->handle, seed) && gles_read(b->lease, &current, 4))
    {
        if(current) ok = 1;
        else
        {
            unsigned w = IOSurfaceGetWidth(b->surface), h = IOSurfaceGetHeight(b->surface);
            unsigned stride = IOSurfaceGetBytesPerRow(b->surface);
            const unsigned char *base = IOSurfaceGetBaseAddress(b->surface);
            if(base && w && w <= 0x4000 && h && h <= 0x4000 && stride >= 4 * w &&
                stride <= ~0u / h && w * h * 4 <= (80u << 20) - 20)
            {
                unsigned bytes = w * h * 4, size = bytes + 20;
                unsigned *packet = malloc(size);
                if(packet)
                {
                    packet[0] = v86_UploadIOSurface; packet[2] = b->handle;
                    packet[3] = seed; packet[4] = bytes;
                    unsigned char *pixels = (unsigned char *)(packet + 5);
                    for(unsigned y = 0; y < h; y++)
                        memcpy(pixels + 4 * w * y, base + stride * (b->window ? h - 1 - y : y), 4 * w);
                    if(gles_send(b->lease, packet, size)) gles_read(b->lease, &ok, 4);
                    free(packet);
                }
            }
        }
    }
    return IOSurfaceUnlock(b->surface, 1, 0) == 0 && ok;
}
static int bind_surface(struct context *ctx, unsigned target, void *surface, struct native_window *window, unsigned retained)
{
    if(!surface || IOSurfaceGetPixelFormat(surface) != 0x42475241 ||
        (target != 0x0de1 && target != 0x8d41)) return 0;
    int name = 0;
    if(!integer_value(ctx, target == 0x0de1 ? 0x8069 : 0x8ca7, &name) || !name) return 0;
    struct binding *b = calloc(1, sizeof(*b));
    if(!b) return 0;
    b->lease = gles_open();
    if(b->lease < 0) { free(b); return 0; }
    b->refs = 1;
    b->surface = CFRetain(surface);
    b->name = name;
    b->target = target;
    b->id = IOSurfaceGetID(surface);
    b->window = window;
    if(!SEND(b->lease, v86_AcquireIOSurface, b->id, IOSurfaceGetWidth(surface),
            IOSurfaceGetHeight(surface), IOSurfaceGetPixelFormat(surface)) || !gles_read(b->lease, &b->handle, 4) || !b->handle || !import_pixels(b) ||
        !SEND(ctx->driver.connection, target == 0x0de1 ? rc_rcBindTexture : rc_rcBindRenderbuffer, b->handle))
    {
        b->window = 0; // the caller owns the window until attachment succeeds
        release_binding(b);
        return 0;
    }
    b->retained = retained;
    replace_binding(ctx->group, target, name, b);
    return 1;
}

typedef signed char (*surface_method)(void *, void *, void *, unsigned, unsigned, unsigned, unsigned, unsigned, unsigned, unsigned, signed char);
static surface_method native_surface;
static signed char attach_surface(void *object, void *sel, void *surface, unsigned target, unsigned internal,
    unsigned width, unsigned height, unsigned format, unsigned type, unsigned plane, signed char invert)
{
    struct context *ctx = host_context(object);
    if(!ctx) return native_surface(object, sel, surface, target, internal, width, height, format, type, plane, invert);
    if(!surface || plane || invert || (internal != 0x1908 && internal != 0x8058) ||
        (format != 0x80e1 && format != 0x1908) || (type != 0x8367 && type != 0x1401) ||
        width != IOSurfaceGetWidth(surface) || height != IOSurfaceGetHeight(surface)) return 0;
    return bind_surface(ctx, target, surface, 0, 0);
}

static unsigned window_ready(void *unused) { return 1; }
static void window_release_surface(void *unused, void *surface) {}
static unsigned window_fence(void *unused) { return 0; } // readback completes before publication

#ifdef N90_CHECK_WINDOW
unsigned n90_window_trace;
// A version-3 native window transfers its next surface only once per frame.
// Let the probe inspect the acquired buffer without dequeuing it a second time.
void *n90_test_window_surface(void *object, unsigned name)
{
    struct context *ctx = host_context(object);
    if(!ctx) return 0;
    OSSpinLockLock(&lock);
    struct binding *b = ctx->group->bindings;
    while(b && (b->target != 0x8d41 || b->name != name)) b = b->next;
    void *surface = b && b->window ? CFRetain(b->surface) : 0;
    OSSpinLockUnlock(&lock);
    return surface;
}
#define WINDOW_TRACE(code) (n90_window_trace = (code))
#else
#define WINDOW_TRACE(code) ((void)0)
#endif

static int bind_view(struct context *ctx, struct native_window *win, unsigned retained, unsigned format)
{
    int name = 0;
    WINDOW_TRACE(1);
    if(!integer_value(ctx, 0x8ca7, &name) || !name) return 0;
    if(!win) { replace_binding(ctx->group, 0x8d41, name, 0); return 1; }
    static const struct window_callbacks callbacks = { 0, window_ready, window_release_surface, window_fence };
    WINDOW_TRACE(2);
    if(format != 0x8058 || !win->open || !win->surface || !win->close || !win->post) return 0;
    WINDOW_TRACE(3);
    if(win->open(win, 0x42475241, &callbacks) != 1) return 0;
    WINDOW_TRACE(4);
    void *surface = win->surface(win);
    if(surface)
    {
        WINDOW_TRACE(5);
        if(bind_surface(ctx, 0x8d41, surface, win, retained & 1)) { WINDOW_TRACE(0); return 1; }
    }
    win->close(win);
    return 0;
}

// Core Animation and the emulated panel can also consume native surface
// memory. Commit the completed GPU contents before handing it to the window.
static int publish_bytes(struct binding *b)
{
    unsigned w = IOSurfaceGetWidth(b->surface), h = IOSurfaceGetHeight(b->surface);
    unsigned stride = IOSurfaceGetBytesPerRow(b->surface);
    if(!w || w > 0x4000 || !h || h > 0x4000 || stride < 4 * w || stride > ~0u / h) return 0;
    unsigned rows = 1;
    while(rows <= h / 2 && rows * w <= (1u << 17)) rows *= 2;
    unsigned char *rgba = malloc(rows * w * 4);
    if(!rgba) return 0;
    if(IOSurfaceLock(b->surface, 0, 0)) { free(rgba); return 0; }
    unsigned char *base = IOSurfaceGetBaseAddress(b->surface);
    int ok = base != 0;
    for(unsigned y = 0; ok && y < h; y += rows)
    {
        unsigned n = rows < h - y ? rows : h - y, bytes = n * w * 4;
        ok = SEND(b->lease, rc_rcReadColorBuffer, b->handle, 0, y, w, n, 0x1908, 0x1401, bytes) &&
            gles_read(b->lease, rgba, bytes);
        if(ok)
            for(unsigned j = 0; j < n; j++)
            {
                // A native texture attachment uses the IOSurface's own
                // row order; a CAEAGLLayer drawable uses GL window coordinates.
                unsigned row = y + j;
                unsigned char *dst = base + (b->window ? h - 1 - row : row) * stride;
                const unsigned char *src = rgba + j * w * 4;
                for(unsigned x = 0; x < w; x++, src += 4, dst += 4)
                {
                    dst[0] = src[2]; dst[1] = src[1]; dst[2] = src[0]; dst[3] = src[3];
                }
            }
    }
    int unlocked = IOSurfaceUnlock(b->surface, 0, 0) == 0;
    free(rgba);
    return ok && unlocked;
}

static int framebuffer_attachment(struct context *ctx, unsigned pname, int *out)
{
    const unsigned conn = ctx->driver.connection;
    return SEND(conn, gles2_glGetFramebufferAttachmentParameteriv, 0x8d40, 0x8ce0, pname, 4) &&
        gles_read(conn, out, 4);
}

// The display compositor draws to an IOSurface-backed texture attached
// to its FBO and then unbinds that FBO before the native LCD swap.
static void publish_framebuffer(struct context *ctx)
{
    if(!ctx->frame_dirty || !ctx->framebuffer) return;
    ctx->frame_dirty = 0;
    int kind = 0, name = 0;
    if(!framebuffer_attachment(ctx, 0x8cd0, &kind)) { ctx->driver.ok = 0; return; }
    unsigned target = kind == 0x1702 ? 0x0de1 : kind == 0x8d41 ? 0x8d41 : 0;
    if(!target) return;
    if(!framebuffer_attachment(ctx, 0x8cd1, &name)) { ctx->driver.ok = 0; return; }
    OSSpinLockLock(&lock);
    struct binding *b = ctx->group->bindings;
    while(b && (b->target != target || b->name != (unsigned)name)) b = b->next;
    if(b && b->window) b = 0; // CAEAGLLayer publishes at present instead
    if(b) { b->refs++; b->published = 0; }
    OSSpinLockUnlock(&lock);
    if(b)
    {
        int published = publish_bytes(b);
        OSSpinLockLock(&lock);
        b->published = published;
        OSSpinLockUnlock(&lock);
        if(!published) ctx->driver.ok = 0;
        release_binding(b);
    }
}

// QuartzCore queues a deferred IOMobileFramebuffer layer when drawing on
// SGX. Its kernel swap then waits for a completion signal from that GPU.
// Our successful readback has already written and unlocked the IOSurface,
// so pass it to the original display driver as ready. Leave unrelated
// layers (including video and native producers) on the original path.
typedef int (*swap_layer_fn)(void *, unsigned, void *,
    unsigned, unsigned, unsigned, unsigned, unsigned, unsigned, unsigned, unsigned, unsigned);
static swap_layer_fn native_swap_layer;
static int swap_layer(void *display, unsigned layer, void *surface,
    unsigned sx, unsigned sy, unsigned sw, unsigned sh, unsigned dx, unsigned dy, unsigned dw, unsigned dh, unsigned flags)
{
    if(surface && (flags & 1))
    {
        const unsigned id = IOSurfaceGetID(surface);
        OSSpinLockLock(&lock);
        for(struct group *g = groups; g && (flags & 1); g = g->next)
            for(struct binding *b = g->bindings; b; b = b->next)
                if(b->id == id && b->published)
                {
                    b->published = 0;
                    flags &= ~1u;
                    break;
                }
        OSSpinLockUnlock(&lock);
    }
    // On ARMv7 the eight CGRect floats are passed as ordinary words.
    return native_swap_layer(display, layer, surface, sx, sy, sw, sh, dx, dy, dw, dh, flags);
}

static void install_swap_layer(void)
{
    void *quartz = dlsym((void *)-2, "CACurrentMediaTime");
    swap_layer_fn original_layer = (swap_layer_fn)dlsym((void *)-2, "IOMobileFramebufferSwapSetLayer");
    struct image_info info;
    if(!quartz || !original_layer || !dladdr(quartz, &info)) return;
    const unsigned *hdr = info.base, *cmd = hdr + 7;
    if(hdr[0] != 0xfeedface || hdr[1] != 12) return;
    const unsigned char uuid[16] = {0xc0,0x86,0xb6,0xe6,0xcd,0x9d,0x34,0x13,0x99,0xbc,0xc3,0x67,0x5c,0x82,0xf1,0xfe};
    for(unsigned i = 0; i < hdr[4]; i++, cmd += cmd[1] / 4)
        if(cmd[0] == 0x1b && cmd[1] == 24 && !memcmp(cmd + 2, uuid, sizeof(uuid)))
        {
            // 10B329 QuartzCore's prebound writable lazy symbol pointer.
            swap_layer_fn *slot = (swap_layer_fn *)((char *)hdr + (0x396fce28u - 0x32cdc000u));
            if(*slot == original_layer)
            {
                native_swap_layer = original_layer;
                *slot = swap_layer;
            }
            return;
        }
}

static void bind_framebuffer(struct context *ctx, unsigned target, unsigned name)
{
    if(target == 0x8d40 && name != ctx->framebuffer) publish_framebuffer(ctx);
    const int ok = SEND(ctx->driver.connection, gles2_glBindFramebuffer, target, name);
    ctx->driver.ok &= ok;
    if(ok && target == 0x8d40) ctx->framebuffer = name;
}

static void clear_framebuffer(struct context *ctx, unsigned mask)
{
    ctx->driver.ok &= SEND(ctx->driver.connection, gles2_glClear, mask);
    if(mask & 0x4000) ctx->frame_dirty |= !!ctx->framebuffer;
}

static void flush_framebuffer(struct context *ctx)
{
    publish_framebuffer(ctx);
    ctx->driver.ok &= SEND(ctx->driver.connection, gles2_glFlush);
}

static void finish_framebuffer(struct context *ctx)
{
    publish_framebuffer(ctx);
    ctx->driver.ok &= SEND(ctx->driver.connection, gles2_glFinish);
}

// Retained backing preserves the previous frame when Core Animation
// supplies a different surface of the same dimensions for the next frame.
static int retain_frame(void *src, void *dst)
{
    unsigned w = IOSurfaceGetWidth(src), h = IOSurfaceGetHeight(src);
    if(w != IOSurfaceGetWidth(dst) || h != IOSurfaceGetHeight(dst)) return 1;
    if(!w || !h || w > 0x4000 || h > 0x4000 || IOSurfaceGetPixelFormat(dst) != 0x42475241) return 0;
    unsigned stride = IOSurfaceGetBytesPerRow(src), target_stride = IOSurfaceGetBytesPerRow(dst);
    if(stride < 4 * w || target_stride < 4 * w || (unsigned long long)stride * h > ~0u || (unsigned long long)target_stride * h > ~0u) return 0;
    unsigned char *copy = malloc(4 * w * h);
    if(!copy) return 0;
    int ok = 0;
    if(!IOSurfaceLock(src, 1, 0))
    {
        const unsigned char *base = IOSurfaceGetBaseAddress(src);
        if(base) for(unsigned y = 0; y < h; y++) memcpy(copy + 4 * w * y, base + stride * y, 4 * w);
        ok = IOSurfaceUnlock(src, 1, 0) == 0 && base;
    }
    if(ok && !IOSurfaceLock(dst, 0, 0))
    {
        unsigned char *base = IOSurfaceGetBaseAddress(dst);
        if(base) for(unsigned y = 0; y < h; y++) memcpy(base + target_stride * y, copy + 4 * w * y, 4 * w);
        ok = IOSurfaceUnlock(dst, 0, 0) == 0 && base;
    }
    else ok = 0;
    free(copy);
    return ok;
}

static int present_view(struct context *ctx)
{
    int name = 0;
    if(!integer_value(ctx, 0x8ca7, &name) || !name) return 0;
    OSSpinLockLock(&lock);
    struct binding *b = ctx->group->bindings;
    while(b && (b->target != 0x8d41 || b->name != (unsigned)name)) b = b->next;
    if(b) b->refs++;
    OSSpinLockUnlock(&lock);
    if(!b) return 0;
    struct native_window *win = b->window;
    int published = win && publish_bytes(b) && win->post(win, 1) == 1;
    if(published)
    {
        void *next = win->surface(win);
        if(!next || (IOSurfaceGetID(next) != IOSurfaceGetID(b->surface) &&
            ((b->retained && !retain_frame(b->surface, next)) || !bind_surface(ctx, 0x8d41, next, win, b->retained))))
        {
            // Rendering may resume after the application binds storage again.
            replace_binding(ctx->group, 0x8d41, name, 0);
        }
    }
    release_binding(b);
    return published;
}

static void object_names(struct context *ctx, unsigned op, unsigned target, int n, unsigned *names, int remove)
{
    if(n < 0) { if(!ctx->error) ctx->error = 0x501; return; }
    for(int i = 0; i < n; i++)
    {
        unsigned c = ctx->driver.connection;
        if(remove)
        {
            if(!SEND(c, op, 1, 4, names[i])) { ctx->driver.ok = 0; return; }
            if(target) replace_binding(ctx->group, target, names[i], 0);
        }
        else if(!SEND(c, op, 1, 4) || !gles_read(c, &names[i], 4)) { ctx->driver.ok = 0; return; }
    }
}

#define OBJECT_NAMES(kind, target) \
static void gen_##kind(struct context *c, int n, unsigned *names) \
{ object_names(c, gles2_glGen##kind, target, n, names, 0); } \
static void delete_##kind(struct context *c, int n, unsigned *names) \
{ object_names(c, gles2_glDelete##kind, target, n, names, 1); }
OBJECT_NAMES(Textures, 0x0de1)
OBJECT_NAMES(Renderbuffers, 0x8d41)
OBJECT_NAMES(Framebuffers, 0)
OBJECT_NAMES(Buffers, 0)
#undef OBJECT_NAMES

static void read_rgba(struct context *ctx, int x, int y, int w, int h, unsigned format, unsigned type, void *pixels)
{
    if(w < 0 || h < 0) { if(!ctx->error) ctx->error = 0x501; return; }
    if(format != 0x1908 || type != 0x1401) { invalid_operation(ctx); return; }
    if(!w || !h) return;
    int alignment = 0;
    if(!integer_value(ctx, 0x0d05, &alignment) || !(alignment == 1 || alignment == 2 || alignment == 4 || alignment == 8))
    { ctx->driver.ok = 0; return; }
    // Send complete rows in bounded requests. Leave the application's
    // alignment padding untouched.
    unsigned row = (unsigned)w * 4;
    if((unsigned)w > 0x4000 || (unsigned)h > 0x4000) { invalid_operation(ctx); return; }
    unsigned stride = (row + alignment - 1) & ~(unsigned)(alignment - 1);
    unsigned conn = ctx->driver.connection;
    for(int j = 0; j < h;)
    {
        int rows = 1;
        if(stride == row)
            while(rows <= (h - j) / 2 && row * rows <= 32768) rows *= 2;
        unsigned bytes = row * rows;
        if(!SEND(conn, gles2_glReadPixels, x, (unsigned)y + j, w, rows, format, type, bytes) ||
            !gles_read(conn, (unsigned char *)pixels + j * stride, bytes))
        { ctx->driver.ok = 0; return; }
        j += rows;
    }
}

static void install_surface_functions(driver_word *table)
{
    table[N90_glGenTextures - 5] = (driver_word)gen_Textures;
    table[N90_glDeleteTextures - 5] = (driver_word)delete_Textures;
    table[N90_glGenRenderbuffers - 5] = (driver_word)gen_Renderbuffers;
    table[N90_glDeleteRenderbuffers - 5] = (driver_word)delete_Renderbuffers;
    table[N90_glGenFramebuffers - 5] = (driver_word)gen_Framebuffers;
    table[N90_glDeleteFramebuffers - 5] = (driver_word)delete_Framebuffers;
    table[N90_glGenBuffers - 5] = (driver_word)gen_Buffers;
    table[N90_glDeleteBuffers - 5] = (driver_word)delete_Buffers;
    table[N90_glReadPixels - 5] = (driver_word)read_rgba;
    table[N90_glBindFramebuffer - 5] = (driver_word)bind_framebuffer;
    table[N90_glClear - 5] = (driver_word)clear_framebuffer;
    table[N90_glFlush - 5] = (driver_word)flush_framebuffer;
    table[N90_glFinish - 5] = (driver_word)finish_framebuffer;
}
