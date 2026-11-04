// Compiled only into the explicit --check-host-contexts test library. Run
// on a separate iOS thread after dyld/Objective-C finish initializers.
typedef __UINTPTR_TYPE__ word;
extern void *objc_getClass(const char *), *sel_registerName(const char *);
extern void objc_msgSend(void);
extern void *objc_autoreleasePoolPush(void), objc_autoreleasePoolPop(void *);
extern int pthread_create(void **, const void *, void *(*)(void *), void *), pthread_detach(void *);
extern void *dlsym(void *, const char *);
extern int strcmp(const char *, const char *), getpid(void);
extern void syslog(int, const char *, ...);

static void *send(void *obj, const char *name)
{
    return ((void *(*)(void *, void *))objc_msgSend)(obj, sel_registerName(name));
}

static void release_object(void *obj)
{
    if(obj) ((void (*)(void *,void *))objc_msgSend)(obj, sel_registerName("release"));
}

static int bind_context(void *cls, void *ctx)
{
    return ((signed char (*)(void *,void *,void *))objc_msgSend)(cls, sel_registerName("setCurrentContext:"), ctx);
}

static void *exercise(void *unused)
{
    void *pool = objc_autoreleasePoolPush();
    void *cls = objc_getClass("EAGLContext");
    void *first = ((void *(*)(void *,void *,unsigned))objc_msgSend)(send(cls, "alloc"), sel_registerName("initWithAPI:"), 2);
    void *group = first ? send(first, "sharegroup") : 0;
    void *second = group ? ((void *(*)(void *,void *,unsigned,void *))objc_msgSend)(send(cls, "alloc"),
        sel_registerName("initWithAPI:sharegroup:"), 2, group) : 0;
    const char *(*get_string)(unsigned) = dlsym((void *)-2, "glGetString");
    unsigned (*create_shader)(unsigned) = dlsym((void *)-2, "glCreateShader");
    unsigned char (*is_shader)(unsigned) = dlsym((void *)-2, "glIsShader");
    void (*delete_shader)(unsigned) = dlsym((void *)-2, "glDeleteShader");
    unsigned shader = 0;
    int ok = create_shader && is_shader && delete_shader && first && second && first != second && send(second, "sharegroup") == group && get_string;
    void *both[] = { first, second, first };
    for(int i = 0; ok && i < 3; i++)
    {
        ok = bind_context(cls, both[i]) && send(cls, "currentContext") == both[i] &&
            (word)send(both[i], "API") == 2;
        const char *renderer = ok ? get_string(0x1f01) : 0;
        ok = renderer && !strcmp(renderer, "v86 GLES (WebGPU)") && get_string(0x1f01) == renderer;
        if(ok && i == 0) { shader = create_shader(0x8b31); ok = shader != 0; }
        if(ok && i == 1) ok = is_shader(shader);
        if(ok && i == 2) { delete_shader(shader); ok = !is_shader(shader); }
    }
#ifdef N90_CHECK_SURFACES
    extern int n90_surface_pixels(void *, void *, void *);
    int surface_step = ok ? n90_surface_pixels(cls, first, second) : -1;
    syslog(5, "V86 IOSurface pixels pid %d step %d", getpid(), surface_step);
#endif
#ifdef N90_CHECK_WINDOW
    extern int n90_window_pixels(void *, int);
    int window_step = surface_step ? -1 : n90_window_pixels(first, 0);
    syslog(5, "V86 native window pid %d step %d", getpid(), window_step);
    int layer_step = window_step ? -1 : n90_window_pixels(first, 1);
    syslog(5, "V86 CAEAGLLayer pid %d step %d", getpid(), layer_step);
#endif
    if(!bind_context(cls, 0) || send(cls, "currentContext")) ok = 0;
    release_object(second);
    release_object(first);
    objc_autoreleasePoolPop(pool);
    syslog(5, "V86 GLI lifecycle and shared shader pid %d %s", getpid(), ok ? "passed" : "failed");
    return 0;
}

void n90_check_contexts(void)
{
    void *thread;
    if(!pthread_create(&thread, 0, exercise, 0)) pthread_detach(thread);
}
