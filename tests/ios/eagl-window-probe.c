// Exercise the original EAGL drawable method with a two-surface native
// window. Its post callback inspects real IOSurface memory as a consumer.
typedef __UINTPTR_TYPE__ word;
extern void *objc_getClass(const char *), *sel_registerName(const char *);
extern void *objc_allocateClassPair(void *, const char *, word), objc_registerClassPair(void *);
extern signed char class_addMethod(void *, void *, void (*)(void), const char *);
extern void objc_msgSend(void);
extern unsigned IOSurfaceGetWidth(void *), IOSurfaceGetHeight(void *), IOSurfaceGetBytesPerRow(void *);
extern void *IOSurfaceGetBaseAddress(void *), *CFRetain(void *);
extern int IOSurfaceLock(void *, unsigned, unsigned *), IOSurfaceUnlock(void *, unsigned, unsigned *);
extern void CFRelease(void *), *n90_test_surface(void);
extern void glGenFramebuffers(int, unsigned *), glGenRenderbuffers(int, unsigned *);
extern void glDeleteFramebuffers(int, const unsigned *), glDeleteRenderbuffers(int, const unsigned *);
extern void glBindFramebuffer(unsigned, unsigned), glBindRenderbuffer(unsigned, unsigned);
extern void glFramebufferRenderbuffer(unsigned, unsigned, unsigned, unsigned);
extern unsigned glCheckFramebufferStatus(unsigned);
extern void glClearColor(float, float, float, float), glClear(unsigned), glEnable(unsigned), glDisable(unsigned), glScissor(int, int, int, int);
extern void syslog(int, const char *, ...);
extern int getpid(void);

struct fixture {
    unsigned version;
    int (*open)(struct fixture *, unsigned, const void *);
    void (*close)(struct fixture *);
    void *(*next)(struct fixture *);
    int (*post)(struct fixture *, unsigned);
    void *reserved[2];
    void *surface[2];
    int opened, posted;
};

static void paint(int second)
{
    glDisable(0xc11);
    glClearColor(0, 1, 0, 1); glClear(0x4000);
    glEnable(0xc11); glScissor(0, 0, 2, 2);
    glClearColor(1, second ? 1 : 0, 0, 1); glClear(0x4000);
}

static int check_pixels(void *s, int second)
{
    if(!s || IOSurfaceLock(s, 1, 0)) return 0;
    unsigned char *base = IOSurfaceGetBaseAddress(s);
    unsigned stride = IOSurfaceGetBytesPerRow(s), w = IOSurfaceGetWidth(s), h = IOSurfaceGetHeight(s);
    int ok = base && w == 64 && h == 48 && stride >= w * 4;
    for(unsigned y = 0; ok && y < h; y++)
        for(unsigned x = 0; ok && x < w; x++)
        {
            unsigned char *p = base + y * stride + 4 * x;
            int corner = x < 2 && y >= h - 2;
            ok = !p[0] && p[1] == (corner && !second ? 0 : 255) && p[2] == (corner ? 255 : 0) && p[3] == 255;
            if(!ok) syslog(5, "V86 window pixel pid %d at %u %u BGRA %u %u %u %u", getpid(), x, y, p[0], p[1], p[2], p[3]);
        }
    IOSurfaceUnlock(s, 1, 0);
    return ok;
}

static int open_window(struct fixture *w, unsigned format, const void *callbacks)
{
    if(w->opened || format != 0x42475241 || !callbacks) return 0;
    w->opened = 1; return 1;
}
static void close_window(struct fixture *w) { w->opened = 0; }
static void *next_surface(struct fixture *w) { return w->surface[w->posted & 1]; }
static int post(struct fixture *w, unsigned flags)
{
    if(!w->opened || flags != 1 || !check_pixels(next_surface(w), w->posted != 0)) return 0;
    w->posted++; return 1;
}
static struct fixture fixture = { 1, open_window, close_window, next_surface, post };
static void *native_window(void *self, void *sel) { return &fixture; }
extern const void *const kEAGLDrawablePropertyRetainedBacking;
extern void *const kCFBooleanTrue;
static void *properties(void *self, void *sel)
{
    return ((void *(*)(void *, void *, void *, const void *))objc_msgSend)(objc_getClass("NSDictionary"),
        sel_registerName("dictionaryWithObject:forKey:"), kCFBooleanTrue, kEAGLDrawablePropertyRetainedBacking);
}
static void *send0(void *o, const char *name)
{
    return ((void *(*)(void *,void *))objc_msgSend)(o, sel_registerName(name));
}

static signed char storage(void *ctx, void *layer)
{
    return ((signed char (*)(void *,void *,unsigned,void *))objc_msgSend)(ctx,
        sel_registerName("renderbufferStorage:fromDrawable:"), 0x8d41, layer);
}
static signed char present(void *ctx)
{
    return ((signed char (*)(void *,void *,unsigned))objc_msgSend)(ctx, sel_registerName("presentRenderbuffer:"), 0x8d41);
}

// Real CAEAGLLayer exposes the same nativeWindow vtable. Keep its first
// backing surface alive through publication and check the committed pixels.
int n90_window_pixels(void *ctx, int real)
{
    unsigned fb = 0, rb = 0;
    int step = 1;
    void *layer = 0, *published = 0;
    if(real)
    {
        void *cls = objc_getClass("CAEAGLLayer");
        layer = send0(send0(cls, "alloc"), "init");
        if(!layer) goto done;
        struct bounds { float x, y, width, height; } bounds = { 0, 0, 64, 48 };
        ((void (*)(void *,void *,struct bounds))objc_msgSend)(layer, sel_registerName("setBounds:"), bounds);
        ((void (*)(void *,void *,float))objc_msgSend)(layer, sel_registerName("setContentsScale:"), 1);
    }
    else
    {
        fixture.surface[0] = n90_test_surface();
        fixture.surface[1] = n90_test_surface();
        if(!fixture.surface[0] || !fixture.surface[1]) goto done;
        void *cls = objc_allocateClassPair(objc_getClass("NSObject"), "N90TestDrawable", 0);
        if(!cls || !class_addMethod(cls, sel_registerName("nativeWindow"), (void (*)(void))native_window, "^v8@0:4")) goto done;
        if(!class_addMethod(cls, sel_registerName("drawableProperties"), (void (*)(void))properties, "@8@0:4")) goto done;
        objc_registerClassPair(cls);
        layer = send0(send0(cls, "alloc"), "init");
    }
    glGenFramebuffers(1, &fb); glGenRenderbuffers(1, &rb);
    glBindFramebuffer(0x8d40, fb); glBindRenderbuffer(0x8d41, rb);
    step = 20;
    if(!layer || !rb || !fb) goto done;
    if(real && !send0(layer, "nativeWindow")) { step = 21; goto done; }
    extern unsigned n90_window_trace;
    n90_window_trace = 99;
    if(!storage(ctx, layer)) { step = 100 + n90_window_trace; goto done; }
    if(real)
    {
        extern void *n90_test_window_surface(void *, unsigned);
        published = n90_test_window_surface(ctx, rb);
        if(!published) { step = 22; goto done; }
    }
    glFramebufferRenderbuffer(0x8d40, 0x8ce0, 0x8d41, rb);
    step = 3;
    if(glCheckFramebufferStatus(0x8d40) != 0x8cd5) goto done;
    paint(0);
    step = 4;
    if(!present(ctx)) goto done;
    if(real) { if(!check_pixels(published, 0)) goto done; }
    else
    {
        step = 6;
        // Change only the corner; the rotated surface must retain green.
        glClearColor(1, 1, 0, 1); glClear(0x4000);
        if(!present(ctx) || fixture.posted != 2) goto done;
    }
    step = 0;
done:
    if(rb) glDeleteRenderbuffers(1, &rb);
    if(fb) glDeleteFramebuffers(1, &fb);
    if(!real && fixture.opened) step = 5;
    if(layer) send0(layer, "release");
    if(published) CFRelease(published);
    if(!real)
        for(unsigned i = 0; i < 2; i++) if(fixture.surface[i]) CFRelease(fixture.surface[i]);
    return step;
}
