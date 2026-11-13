// Deterministic UIKit/storage and GLES2 fixtures, sharing the same app shell.
#include "ios-api.h"
#ifndef V86_FIXTURE_VERSION
#define V86_FIXTURE_VERSION 1
#endif
typedef struct { float x, y, w, h; } Rect;
extern int UIApplicationMain(int, char **, void *, void *);
static void *label, *defaults, *counter_key;
static long count;
#ifdef V86_GLES_TEST
static void *gl_view;
static void draw(void *);
#endif
static void frame(void *o, Rect r) { ((void (*)(void *,void *,Rect))objc_msgSend)(o,sel_registerName("setFrame:"),r); }
static void update(void)
{
    char text[80]; snprintf(text, sizeof(text), "V86 test v%d: %ld taps", V86_FIXTURE_VERSION, count);
    CFStringRef s = string(text); send1(label, "setText:", (void *)s); CFRelease(s);
}
static void tap(void *self, void *cmd, void *sender)
{
    (void)self; (void)cmd; (void)sender; count++;
    ((void (*)(void *,void *,long,void *))objc_msgSend)(defaults,sel_registerName("setInteger:forKey:"),count,counter_key);
    send0(defaults,"synchronize"); update();
#ifdef V86_GLES_TEST
    if(gl_view)draw(gl_view);
#endif
}
#ifdef V86_GLES_TEST
extern void glGenRenderbuffers(int, unsigned *), glBindRenderbuffer(unsigned,unsigned), glGenFramebuffers(int,unsigned *);
extern void glBindFramebuffer(unsigned,unsigned), glFramebufferRenderbuffer(unsigned,unsigned,unsigned,unsigned);
extern void glGetRenderbufferParameteriv(unsigned,unsigned,int *);
extern void glViewport(int,int,int,int), glClearColor(float,float,float,float), glClear(unsigned);
extern unsigned glCreateShader(unsigned), glCreateProgram(void), glGetError(void);
extern void glShaderSource(unsigned,int,const char **,const int *), glCompileShader(unsigned), glAttachShader(unsigned,unsigned);
extern void glBindAttribLocation(unsigned,unsigned,const char *), glLinkProgram(unsigned), glUseProgram(unsigned);
extern void glVertexAttribPointer(unsigned,int,unsigned,unsigned char,int,const void *), glEnableVertexAttribArray(unsigned), glDrawArrays(unsigned,int,int);
static void *layer_class(void *self, void *cmd) { (void)self;(void)cmd;return objc_getClass("CAEAGLLayer"); }
static void draw(void *view)
{
    static void *context;static unsigned rb,fb,p;int width=320,height=300;
    if(!context)
    {
    context=send1(send0(objc_getClass("EAGLContext"),"alloc"),"initWithAPI:",(void *)2);
    send1(objc_getClass("EAGLContext"),"setCurrentContext:",context);
    glGenRenderbuffers(1,&rb);glBindRenderbuffer(0x8D41,rb);
    ((void *(*)(void *,void *,unsigned,void *))objc_msgSend)(context,sel_registerName("renderbufferStorage:fromDrawable:"),0x8D41,send0(view,"layer"));
    glGenFramebuffers(1,&fb);glBindFramebuffer(0x8D40,fb);glFramebufferRenderbuffer(0x8D40,0x8CE0,0x8D41,rb);
    const char *vs="attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";
    const char *fs="precision mediump float;void main(){gl_FragColor=vec4(1.,0.5,0.,1.);}";
    unsigned v=glCreateShader(0x8B31),f=glCreateShader(0x8B30);p=glCreateProgram();
    glShaderSource(v,1,&vs,0);glCompileShader(v);glShaderSource(f,1,&fs,0);glCompileShader(f);
    glAttachShader(p,v);glAttachShader(p,f);glBindAttribLocation(p,0,"p");glLinkProgram(p);glUseProgram(p);
    }
    send1(objc_getClass("EAGLContext"),"setCurrentContext:",context);
    glBindRenderbuffer(0x8D41,rb);glBindFramebuffer(0x8D40,fb);glUseProgram(p);
    glGetRenderbufferParameteriv(0x8D41,0x8D42,&width);glGetRenderbufferParameteriv(0x8D41,0x8D43,&height);
    glViewport(0,0,width,height);glClearColor(0.1f,count&1?0.55f:0.25f,count&1?0.2f:0.5f,1);glClear(0x4000);
    static const float vertices[]={-0.8f,-0.8f,0.8f,-0.8f,0.f,0.8f};
    glVertexAttribPointer(0,2,0x1406,0,0,vertices);glEnableVertexAttribArray(0);glDrawArrays(4,0,3);
    send1(context,"presentRenderbuffer:",(void *)0x8D41);
    syslog(5,"V86 GLES2 fixture glError=%u",glGetError());
}
#endif
static Boolean launched(void *self, void *cmd, void *app, void *options)
{
    (void)cmd;(void)app;(void)options;
    void *window=send0(send0(objc_getClass("UIWindow"),"alloc"),"init");frame(window,(Rect){0,0,320,480});
    void *controller=send0(send0(objc_getClass("UIViewController"),"alloc"),"init");
    void *view=send0(controller,"view");
    send1(view,"setBackgroundColor:",send0(objc_getClass("UIColor"),"whiteColor"));
    label=send0(send0(objc_getClass("UILabel"),"alloc"),"init");frame(label,(Rect){20,35,280,50});send1(view,"addSubview:",label);
    defaults=send0(objc_getClass("NSUserDefaults"),"standardUserDefaults");counter_key=(void *)string("v86.counter");
    count=(long)send1(defaults,"integerForKey:",counter_key);update();
    void *button=send1(objc_getClass("UIButton"),"buttonWithType:",(void *)1);frame(button,(Rect){20,95,280,50});
    CFStringRef title=string("Tap and save");
    ((void (*)(void *,void *,void *,unsigned))objc_msgSend)(button,sel_registerName("setTitle:forState:"),(void *)title,0);CFRelease(title);
    ((void (*)(void *,void *,void *,void *,unsigned))objc_msgSend)(button,sel_registerName("addTarget:action:forControlEvents:"),self,sel_registerName("tap:"),64);
    send1(view,"addSubview:",button);send1(window,"setRootViewController:",controller);send0(window,"makeKeyAndVisible");
#ifdef V86_GLES_TEST
    void *cls=objc_allocateClassPair(objc_getClass("UIView"),"V86GLView",0);
    // Class methods live on the metaclass, obtained through object_getClass's ABI.
    extern void *object_getClass(void *);
    class_addMethod(object_getClass(cls),sel_registerName("layerClass"),(void (*)(void))layer_class,"#@:");objc_registerClassPair(cls);
    gl_view=send0(send0(cls,"alloc"),"init");frame(gl_view,(Rect){0,160,320,300});send1(view,"addSubview:",gl_view);draw(gl_view);
#endif
    syslog(5,"V86 UIKit fixture launched count=%ld",count);return 1;
}
int main(int argc,char **argv)
{
    void *pool=objc_autoreleasePoolPush();void *cls=objc_allocateClassPair(objc_getClass("NSObject"),"V86TestDelegate",0);
    class_addMethod(cls,sel_registerName("application:didFinishLaunchingWithOptions:"),(void (*)(void))launched,"c@:@@");
    class_addMethod(cls,sel_registerName("tap:"),(void (*)(void))tap,"v@:@");objc_registerClassPair(cls);
    int result=UIApplicationMain(argc,argv,0,(void *)string("V86TestDelegate"));objc_autoreleasePoolPop(pool);return result;
}
