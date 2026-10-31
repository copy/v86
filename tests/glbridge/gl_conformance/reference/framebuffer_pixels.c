#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
static int first=1;
#define CASE(name,...) do{__VA_ARGS__;printf("%s{\"name\":\"%s\",\"error\":%u}",first?"":",\n",name,glGetError());first=0;}while(0)
static GLuint framebuffer(GLenum format,GLenum attachment) {
 GLuint f,r;glGenFramebuffersEXT(1,&f);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,f);glGenRenderbuffersEXT(1,&r);glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,r);
 glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,format,8,8);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,attachment,GL_RENDERBUFFER_EXT,r);
 glDrawBuffer(attachment==GL_COLOR_ATTACHMENT0_EXT?GL_COLOR_ATTACHMENT0_EXT:GL_NONE);glReadBuffer(attachment==GL_COLOR_ATTACHMENT0_EXT?GL_COLOR_ATTACHMENT0_EXT:GL_NONE);
 return f;
}
int main(void) {
 setbuf(stdout,NULL);
 CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};CGLPixelFormatObj pf;CGLContextObj ctx;GLint n;
 if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2;CGLSetCurrentContext(ctx);
 GLint depth16bits,depth24bits,packedbits;unsigned char pixels[128]={0};GLuint color=framebuffer(GL_RGBA8,GL_COLOR_ATTACHMENT0_EXT);
 printf("{\"renderer\":\"%s\",\"cases\":[\n",glGetString(GL_RENDERER));
 CASE("read_depth_missing",glReadPixels(0,0,1,1,GL_DEPTH_COMPONENT,GL_FLOAT,pixels));
 CASE("read_stencil_missing",glReadPixels(0,0,1,1,GL_STENCIL_INDEX,GL_UNSIGNED_BYTE,pixels));
 CASE("read_depth_zero_missing",glReadPixels(0,0,0,1,GL_DEPTH_COMPONENT,GL_FLOAT,pixels));
 CASE("copy_depth_missing",glCopyPixels(0,0,1,1,GL_DEPTH));
 CASE("copy_stencil_missing",glCopyPixels(0,0,1,1,GL_STENCIL));
 CASE("draw_depth_missing",glDrawPixels(1,1,GL_DEPTH_COMPONENT,GL_FLOAT,pixels));
 CASE("draw_stencil_missing",glDrawPixels(1,1,GL_STENCIL_INDEX,GL_UNSIGNED_BYTE,pixels));
 glReadBuffer(GL_NONE);
 CASE("read_color_none",glReadPixels(0,0,1,1,GL_RGBA,GL_UNSIGNED_BYTE,pixels));
 CASE("read_color_zero_none",glReadPixels(0,0,0,1,GL_RGBA,GL_UNSIGNED_BYTE,pixels));
 CASE("copy_color_none",glCopyPixels(0,0,1,1,GL_COLOR));
 GLuint depth16=framebuffer(GL_DEPTH_COMPONENT16,GL_DEPTH_ATTACHMENT_EXT);glGetIntegerv(GL_DEPTH_BITS,&depth16bits);
 CASE("read_depth_present",glReadPixels(0,0,1,1,GL_DEPTH_COMPONENT,GL_FLOAT,pixels));
 CASE("read_color_depth_only",glReadPixels(0,0,1,1,GL_RGBA,GL_UNSIGNED_BYTE,pixels));
 CASE("copy_depth_present",glCopyPixels(0,0,1,1,GL_DEPTH));
 GLuint depth24=framebuffer(GL_DEPTH_COMPONENT24,GL_DEPTH_ATTACHMENT_EXT);glGetIntegerv(GL_DEPTH_BITS,&depth24bits);
 glBindFramebufferEXT(GL_READ_FRAMEBUFFER_EXT,depth16);
 CASE("blit_depth_mismatch",glBlitFramebufferEXT(0,0,1,1,0,0,1,1,GL_DEPTH_BUFFER_BIT,GL_NEAREST));
 glBindFramebufferEXT(GL_DRAW_FRAMEBUFFER_EXT,depth16);
 CASE("blit_depth_match",glBlitFramebufferEXT(0,0,1,1,0,0,1,1,GL_DEPTH_BUFFER_BIT,GL_NEAREST));
 glBindFramebufferEXT(GL_DRAW_FRAMEBUFFER_EXT,color);
 CASE("blit_depth_absent",glBlitFramebufferEXT(0,0,1,1,0,0,1,1,GL_DEPTH_BUFFER_BIT,GL_NEAREST));
 framebuffer(GL_DEPTH24_STENCIL8,GL_DEPTH_ATTACHMENT_EXT);glGetIntegerv(GL_DEPTH_BITS,&packedbits);
 glBindFramebufferEXT(GL_READ_FRAMEBUFFER_EXT,depth24);
 CASE("blit_depth_packed_plain",glBlitFramebufferEXT(0,0,1,1,0,0,1,1,GL_DEPTH_BUFFER_BIT,GL_NEAREST));
 printf("\n],\"depthBits\":[%d,%d,%d]}\n",depth16bits,depth24bits,packedbits);CGLSetCurrentContext(NULL);CGLDestroyContext(ctx);CGLDestroyPixelFormat(pf);return 0;
}
