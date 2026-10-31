#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
static int first=1;
#define CASE(name,...) do{__VA_ARGS__;printf("%s{\"name\":\"%s\",\"error\":%u}",first?"":",\n",name,glGetError());first=0;}while(0)
int main(void){
    CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};CGLPixelFormatObj pf;CGLContextObj ctx;GLint n;
    if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2;CGLSetCurrentContext(ctx);
    GLuint fbo,color;glGenFramebuffersEXT(1,&fbo);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,fbo);glGenRenderbuffersEXT(1,&color);glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,color);
    glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_RGBA8,16,16);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_RENDERBUFFER_EXT,color);
    GLfloat vertices[12]={0};glEnableClientState(GL_VERTEX_ARRAY);glVertexPointer(3,GL_FLOAT,0,vertices);
    unsigned char data[256]={0};GLint start[2]={0,0};GLsizei count[2]={0,-1};
    printf("{\"renderer\":\"%s\",\"cases\":[\n",glGetString(GL_RENDERER));
    CASE("clear_mask",glClear(1));CASE("clear_accum",glClear(GL_ACCUM_BUFFER_BIT));CASE("clear_begin",glBegin(GL_POINTS);glClear(GL_COLOR_BUFFER_BIT);glEnd());
    CASE("arrays_mode",glDrawArrays(0xFFFF,0,0));CASE("arrays_first",glDrawArrays(GL_POINTS,-1,0));CASE("arrays_count",glDrawArrays(GL_POINTS,0,-1));
    CASE("elements_type",glDrawElements(GL_POINTS,0,GL_FLOAT,NULL));CASE("elements_count",glDrawElements(GL_POINTS,-1,GL_UNSIGNED_BYTE,NULL));
    CASE("multi_primcount",glMultiDrawArrays(GL_POINTS,start,count,-1));CASE("multi_count",glMultiDrawArrays(GL_POINTS,start,count,2));
    CASE("read_width",glReadPixels(0,0,-1,1,GL_RGBA,GL_UNSIGNED_BYTE,data));CASE("read_format",glReadPixels(0,0,1,1,0xFFFF,GL_UNSIGNED_BYTE,data));
    CASE("read_type",glReadPixels(0,0,1,1,GL_RGBA,0xFFFF,data));CASE("read_packed",glReadPixels(0,0,1,1,GL_RGBA,GL_UNSIGNED_SHORT_5_6_5,data));
    CASE("read_color_index",glReadPixels(0,0,1,1,GL_COLOR_INDEX,GL_UNSIGNED_BYTE,data));CASE("read_zero",glReadPixels(0,0,0,1,GL_RGBA,GL_UNSIGNED_BYTE,data));
    CASE("read_bitmap",glReadPixels(0,0,0,1,GL_RGBA,GL_BITMAP,data));
    CASE("draw_width",glDrawPixels(-1,1,GL_RGBA,GL_UNSIGNED_BYTE,data));CASE("draw_format",glDrawPixels(1,1,0xFFFF,GL_UNSIGNED_BYTE,data));
    CASE("draw_type",glDrawPixels(1,1,GL_RGBA,0xFFFF,data));CASE("draw_packed",glDrawPixels(1,1,GL_RGBA,GL_UNSIGNED_SHORT_5_6_5,data));
    CASE("draw_zero",glDrawPixels(0,1,GL_RGBA,GL_UNSIGNED_BYTE,data));CASE("copy_width",glCopyPixels(0,0,-1,1,GL_COLOR));CASE("copy_type",glCopyPixels(0,0,1,1,0xFFFF));
    CASE("accum_op",glAccum(0xFFFF,1));CASE("accum_missing",glAccum(GL_LOAD,1));
    CASE("blit_mask",glBlitFramebufferEXT(0,0,1,1,0,0,1,1,1,GL_NEAREST));CASE("blit_filter",glBlitFramebufferEXT(0,0,1,1,0,0,1,1,0,0xFFFF));
    CASE("blit_depth_linear",glBlitFramebufferEXT(0,0,1,1,0,0,1,1,GL_DEPTH_BUFFER_BIT,GL_LINEAR));CASE("blit_zero",glBlitFramebufferEXT(0,0,1,1,0,0,1,1,0,GL_NEAREST));
    CASE("get_error_begin",glBegin(GL_POINTS);glGetError();glEnd());
    CASE("get_error_compile_begin",glNewList(1,GL_COMPILE);glBegin(GL_POINTS);glGetError();glEnd();glEndList());
    printf("\n]}\n");CGLSetCurrentContext(NULL);CGLDestroyContext(ctx);CGLDestroyPixelFormat(pf);return 0;
}
