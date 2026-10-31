// Keep the oracle scene bodies identical on Apple GL and Mesa. This adapter
// replaces only CGL's context/surface setup with desktop EGL, never GL calls.
#ifndef V86_GL_REFERENCE_EGL_H
#define V86_GL_REFERENCE_EGL_H
#include <EGL/egl.h>
#include <stdlib.h>
#include <stdio.h>
typedef int CGLPixelFormatAttribute;
typedef int* CGLPixelFormatObj;
typedef struct V86ReferenceContext { EGLDisplay display; EGLContext context; EGLSurface surface; }* CGLContextObj;
enum { kCGLPFAOpenGLProfile=1, kCGLOGLPVersion_Legacy, kCGLPFAColorSize, kCGLPFAAlphaSize,
    kCGLPFADepthSize, kCGLPFAStencilSize, kCGLPFAAccumSize, kCGLPFARendererID, kCGLRendererGenericFloatID, kCGLPFAAccelerated };
static EGLDisplay reference_display;
static inline int CGLChoosePixelFormat(const CGLPixelFormatAttribute* attributes,CGLPixelFormatObj* format,int* count) {
    (void)attributes;static int selected;const char* trace=getenv("GLREF_TRACE");if(trace&&*trace)setvbuf(stdout,NULL,_IONBF,0);*format=&selected;*count=1;return 0;
}
static inline int CGLCreateContext(CGLPixelFormatObj format,CGLContextObj shared,CGLContextObj* result) {
    (void)format;CGLContextObj ctx=calloc(1,sizeof(*ctx));if(!ctx)return 1;
    const EGLint attrs[]={EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_BIT,
        EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_ALPHA_SIZE,8,EGL_DEPTH_SIZE,24,EGL_STENCIL_SIZE,8,EGL_NONE};
    const EGLint surface[]={EGL_WIDTH,128,EGL_HEIGHT,128,EGL_NONE};EGLConfig config;EGLint count;
    ctx->display=eglGetDisplay(EGL_DEFAULT_DISPLAY);reference_display=ctx->display;
    if(!eglInitialize(ctx->display,NULL,NULL)||!eglBindAPI(EGL_OPENGL_API)||!eglChooseConfig(ctx->display,attrs,&config,1,&count)||!count)goto failure;
    ctx->surface=eglCreatePbufferSurface(ctx->display,config,surface);
    ctx->context=eglCreateContext(ctx->display,config,shared?shared->context:EGL_NO_CONTEXT,NULL);
    if(ctx->surface==EGL_NO_SURFACE||ctx->context==EGL_NO_CONTEXT)goto failure;
    *result=ctx;return 0;
failure:
    fprintf(stderr,"EGL reference context: 0x%x\n",eglGetError());free(ctx);return 1;
}
static inline int CGLSetCurrentContext(CGLContextObj ctx) {
    return !eglMakeCurrent(ctx?ctx->display:reference_display,ctx?ctx->surface:EGL_NO_SURFACE,
        ctx?ctx->surface:EGL_NO_SURFACE,ctx?ctx->context:EGL_NO_CONTEXT);
}
static inline int CGLDestroyContext(CGLContextObj ctx) {
    eglDestroyContext(ctx->display,ctx->context);eglDestroySurface(ctx->display,ctx->surface);free(ctx);return 0;
}
static inline int CGLDestroyPixelFormat(CGLPixelFormatObj format) { (void)format;return 0; }
#endif
