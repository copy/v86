#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
static GLuint make(float red,float blue,double depth,int stencil){
 GLuint f,r;glGenFramebuffersEXT(1,&f);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,f);glGenRenderbuffersEXT(1,&r);glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,r);
 glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_RGBA8,16,16);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_RENDERBUFFER_EXT,r);
 glGenRenderbuffersEXT(1,&r);glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,r);glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_DEPTH24_STENCIL8,16,16);
 glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_DEPTH_ATTACHMENT_EXT,GL_RENDERBUFFER_EXT,r);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_STENCIL_ATTACHMENT_EXT,GL_RENDERBUFFER_EXT,r);
 glDisable(GL_SCISSOR_TEST);glClearColor(red,0,blue,1);glClearDepth(depth);glClearStencil(stencil);glClear(GL_COLOR_BUFFER_BIT|GL_DEPTH_BUFFER_BIT|GL_STENCIL_BUFFER_BIT);return f;
}
int main(void){
 CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};CGLPixelFormatObj pf;CGLContextObj ctx;GLint n;
 if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2;CGLSetCurrentContext(ctx);
 printf("{\"renderer\":\"%s\",\"cases\":[\n",glGetString(GL_RENDERER));const char* names[]={"depth","stencil","combined","scissor","straight","scaled","clipped","missing"};
 for(int i=0;i<8;i++){GLuint src=make(1,0,.25,173);glEnable(GL_SCISSOR_TEST);glScissor(0,0,8,16);glClearColor(0,1,0,1);glClearDepth(.125);glClearStencil(17);glClear(GL_COLOR_BUFFER_BIT|GL_DEPTH_BUFFER_BIT|GL_STENCIL_BUFFER_BIT);
 if(i==7){glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_DEPTH_ATTACHMENT_EXT,GL_RENDERBUFFER_EXT,0);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_STENCIL_ATTACHMENT_EXT,GL_RENDERBUFFER_EXT,0);}GLuint dst=make(0,1,.75,42);glBindFramebufferEXT(GL_READ_FRAMEBUFFER_EXT,src);glBindFramebufferEXT(GL_DRAW_FRAMEBUFFER_EXT,dst);
 if(i==3){glEnable(GL_SCISSOR_TEST);glScissor(4,4,8,8);}glBlitFramebufferEXT(i==6?-8:0,0,i==6?8:16,16,i>=4?0:16,0,i==5?8:i>=4?16:0,i==5?8:16,i==0?GL_DEPTH_BUFFER_BIT:i==1?GL_STENCIL_BUFFER_BIT:GL_COLOR_BUFFER_BIT|GL_DEPTH_BUFFER_BIT|GL_STENCIL_BUFFER_BIT,GL_NEAREST);
 glBindFramebufferEXT(GL_READ_FRAMEBUFFER_EXT,dst);printf("%s{\"name\":\"%s\",\"pixels\":[",i?",\n":"",names[i]);
 for(int j=0;j<2;j++){float depth;unsigned char stencil=0,rgba[4];int x=j?2:8;glReadPixels(x,x,1,1,GL_DEPTH_COMPONENT,GL_FLOAT,&depth);glReadPixels(x,x,1,1,GL_STENCIL_INDEX,GL_UNSIGNED_BYTE,&stencil);glReadPixels(x,x,1,1,GL_RGBA,GL_UNSIGNED_BYTE,rgba);
 printf("%s{\"depth\":%.9g,\"stencil\":%u,\"rgba\":[%u,%u,%u,%u]}",j?",":"",depth,stencil,rgba[0],rgba[1],rgba[2],rgba[3]);}printf("],\"error\":%u}",glGetError());}
 printf("\n]}\n");CGLSetCurrentContext(NULL);CGLDestroyContext(ctx);CGLDestroyPixelFormat(pf);return 0;
}
