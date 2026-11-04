// Only linked in the explicitly requested private GPU/pixel test image.
extern void *CFNumberCreate(void *, int, const void *), *CFDictionaryCreateMutable(void *, int, const void *, const void *);
extern void CFDictionarySetValue(void *, const void *, const void *), CFRelease(void *);
extern const char kCFTypeDictionaryKeyCallBacks, kCFTypeDictionaryValueCallBacks;
extern void *const kIOSurfaceWidth, *const kIOSurfaceHeight, *const kIOSurfaceBytesPerElement, *const kIOSurfacePixelFormat;
extern void *IOSurfaceCreate(void *), *IOSurfaceLookup(unsigned);
extern unsigned IOSurfaceGetID(void *), IOSurfaceGetBytesPerRow(void *);
extern int IOSurfaceLock(void *, unsigned, unsigned *), IOSurfaceUnlock(void *, unsigned, unsigned *);
extern void *IOSurfaceGetBaseAddress(void *);
extern void *sel_registerName(const char *);
extern void objc_msgSend(void);
extern void glGenFramebuffers(int, unsigned *), glGenTextures(int, unsigned *), glGenRenderbuffers(int, unsigned *);
extern void glDeleteFramebuffers(int, const unsigned *), glDeleteTextures(int, const unsigned *), glDeleteRenderbuffers(int, const unsigned *);
extern void glBindFramebuffer(unsigned, unsigned), glBindTexture(unsigned, unsigned), glBindRenderbuffer(unsigned, unsigned);
extern void glFramebufferRenderbuffer(unsigned, unsigned, unsigned, unsigned), glFramebufferTexture2D(unsigned, unsigned, unsigned, unsigned, int);
extern unsigned glCheckFramebufferStatus(unsigned), glGetError(void);
extern void glClearColor(float, float, float, float), glClear(unsigned), glEnable(unsigned), glScissor(int, int, int, int);
extern void glReadPixels(int, int, int, int, unsigned, unsigned, void *);

static void property(void *d, void *key, int value)
{
    void *n = CFNumberCreate(0, 3, &value);
    CFDictionarySetValue(d, key, n);
    CFRelease(n);
}

void *n90_test_surface(void)
{
    void *d = CFDictionaryCreateMutable(0, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    if(!d) return 0;
    property(d, kIOSurfaceWidth, 64); property(d, kIOSurfaceHeight, 48);
    property(d, kIOSurfaceBytesPerElement, 4); property(d, kIOSurfacePixelFormat, 0x42475241);
    void *surface = IOSurfaceCreate(d);
    CFRelease(d);
    return surface;
}

static int bind(void *cls, void *ctx)
{
    return ((signed char (*)(void *,void *,void *))objc_msgSend)(cls, sel_registerName("setCurrentContext:"), ctx);
}

static signed char attach(void *ctx, unsigned target, void *surface)
{
    return ((signed char (*)(void *,void *,unsigned,void *,signed char))objc_msgSend)(ctx,
        sel_registerName("attachImage:toCoreSurface:invertedRender:"), target, surface, 0);
}

static int paint_cpu(void *surface, unsigned red)
{
    if(IOSurfaceLock(surface, 0, 0)) return 0;
    unsigned char *base = IOSurfaceGetBaseAddress(surface);
    unsigned stride = IOSurfaceGetBytesPerRow(surface);
    if(base && stride >= 256)
        for(unsigned y = 0; y < 48; y++)
            for(unsigned x = 0; x < 64; x++)
            {
                unsigned char *p = base + y * stride + x * 4;
                p[0] = x; p[1] = y; p[2] = red; p[3] = 255;
            }
    return IOSurfaceUnlock(surface, 0, 0) == 0 && base && stride >= 256;
}

static int check_cpu(unsigned red)
{
    unsigned char pixels[64 * 48 * 4];
    glReadPixels(0, 0, 64, 48, 0x1908, 0x1401, pixels);
    if(glGetError()) return 0;
    for(unsigned y = 0; y < 48; y++)
        for(unsigned x = 0; x < 64; x++)
        {
            const unsigned char *p = pixels + (64 * y + x) * 4;
            if(p[0] != red || p[1] != 47 - y || p[2] != x || p[3] != 255) return 0;
        }
    return 1;
}

// Return the failing step, or zero after reading and checking every pixel.
int n90_surface_pixels(void *cls, void *first, void *second)
{
    void *surface = n90_test_surface(), *other = 0;
    unsigned rb = 0, tex = 0, fb = 0, read_fb = 0;
    int step = 2;
    if(!surface || !bind(cls, first)) goto done;
    other = IOSurfaceLookup(IOSurfaceGetID(surface));
    if(!other || !paint_cpu(surface, 201)) goto done;
    glGenFramebuffers(1, &fb); glGenRenderbuffers(1, &rb);
    step = 3;
    if(!fb || !rb) goto done;
    glBindFramebuffer(0x8d40, fb); glBindRenderbuffer(0x8d41, rb);
    if(!attach(first, 0x8d41, surface)) goto done;
    glFramebufferRenderbuffer(0x8d40, 0x8ce0, 0x8d41, rb);
    step = 4;
    if(glCheckFramebufferStatus(0x8d40) != 0x8cd5 || glGetError()) goto done;
    step = 8;
    if(!check_cpu(201)) goto done;
    glClearColor(0, 1, 0, 1); glClear(0x4000);
    glEnable(0xc11); glScissor(0, 0, 2, 2);
    glClearColor(1, 0, 0, 1); glClear(0x4000);
    step = 5;
    if(!bind(cls, second)) goto done;
    glGenFramebuffers(1, &read_fb); glGenTextures(1, &tex);
    glBindFramebuffer(0x8d40, read_fb); glBindTexture(0xde1, tex);
    if(!read_fb || !tex || !attach(second, 0xde1, other)) goto done;
    glFramebufferTexture2D(0x8d40, 0x8ce0, 0xde1, tex, 0);
    step = 6;
    if(glCheckFramebufferStatus(0x8d40) != 0x8cd5 || glGetError()) goto done;
    unsigned char pixels[64 * 48 * 4];
    glReadPixels(0, 0, 64, 48, 0x1908, 0x1401, pixels);
    step = 7;
    if(glGetError()) goto done;
    for(int y = 0; y < 48; y++)
        for(int x = 0; x < 64; x++)
        {
            unsigned char *p = pixels + (64 * y + x) * 4;
            int red = y < 2 && x < 2;
            if(p[0] != (red ? 255 : 0) || p[1] != (red ? 0 : 255) || p[2] || p[3] != 255) goto done;
        }
    step = 9;
    if(!paint_cpu(surface, 37) || !attach(second, 0xde1, other) || !check_cpu(37)) goto done;
    step = 0;
done:
    if(bind(cls, second))
    {
        if(tex) glDeleteTextures(1, &tex);
        if(read_fb) glDeleteFramebuffers(1, &read_fb);
    }
    if(bind(cls, first))
    {
        if(rb) glDeleteRenderbuffers(1, &rb);
        if(fb) glDeleteFramebuffers(1, &fb);
    }
    if(other) CFRelease(other);
    if(surface) CFRelease(surface);
    return step;
}
