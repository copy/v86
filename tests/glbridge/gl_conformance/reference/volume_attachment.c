#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
static GLuint f,t;static int first=1;
static void attach(int level,int z){glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,f);glFramebufferTexture3DEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_TEXTURE_3D,t,level,z);}
static void pixel(const char* name){unsigned char p[4]={0};glReadPixels(0,0,1,1,GL_RGBA,GL_UNSIGNED_BYTE,p);printf("%s{\"name\":\"%s\",\"error\":%u,\"rgba\":[%u,%u,%u,%u]}",first?"":",\n",name,glGetError(),p[0],p[1],p[2],p[3]);first=0;}
int main(void){CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};CGLPixelFormatObj pf;CGLContextObj ctx;GLint n;
 if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2;CGLSetCurrentContext(ctx);printf("{\"renderer\":\"%s\",\"cases\":[\n",glGetString(GL_RENDERER));
 glGenTextures(1,&t);glBindTexture(GL_TEXTURE_3D,t);glTexImage3D(GL_TEXTURE_3D,0,GL_RGBA8,4,4,4,0,GL_RGBA,GL_UNSIGNED_BYTE,NULL);glGenFramebuffersEXT(1,&f);
 attach(0,0);glViewport(0,0,4,4);glClearColor(1,0,0,1);glClear(GL_COLOR_BUFFER_BIT);
 attach(0,1);glColor4f(0,1,0,1);glBegin(GL_TRIANGLES);glVertex2f(-1,-1);glVertex2f(3,-1);glVertex2f(-1,3);glEnd();
 GLuint f2,r;glGenFramebuffersEXT(1,&f2);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,f2);glGenRenderbuffersEXT(1,&r);glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,r);glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_RGBA8,4,4);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_RENDERBUFFER_EXT,r);
 glClearColor(1,1,0,1);glClear(GL_COLOR_BUFFER_BIT);glCopyTexSubImage3D(GL_TEXTURE_3D,0,0,0,2,0,0,4,4);
 attach(0,3);glClearColor(0,0,1,1);glClear(GL_COLOR_BUFFER_BIT);glColorMask(1,0,0,0);glClearColor(1,0,0,0);glClear(GL_COLOR_BUFFER_BIT);glColorMask(1,1,1,1);
 const char* names[]={"slice0","slice1","slice2","slice3"};for(int z=0;z<4;z++){attach(0,z);pixel(names[z]);}
 attach(0,3);GLuint t2,f3;glGenTextures(1,&t2);glBindTexture(GL_TEXTURE_2D,t2);glCopyTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,0,0,4,4,0);glGenFramebuffersEXT(1,&f3);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,f3);glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_TEXTURE_2D,t2,0);pixel("copy2d");
 attach(0,1);GLuint f4;glGenFramebuffersEXT(1,&f4);glBindFramebufferEXT(GL_DRAW_FRAMEBUFFER_EXT,f4);glFramebufferTexture3DEXT(GL_DRAW_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_TEXTURE_3D,t,0,3);glBlitFramebufferEXT(0,0,4,4,4,0,0,4,GL_COLOR_BUFFER_BIT,GL_NEAREST);glBindFramebufferEXT(GL_READ_FRAMEBUFFER_EXT,f4);pixel("blit3d");
 glBindTexture(GL_TEXTURE_3D,t);glGenerateMipmapEXT(GL_TEXTURE_3D);attach(1,0);pixel("mip1_0");attach(1,1);pixel("mip1_1");attach(2,0);pixel("mip2_0");
 printf("\n]}\n");CGLSetCurrentContext(NULL);CGLDestroyContext(ctx);CGLDestroyPixelFormat(pf);return 0;}
