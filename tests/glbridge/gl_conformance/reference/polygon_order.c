#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
static void full(void){glVertex2f(-1,-1);glVertex2f(3,-1);glVertex2f(-1,3);}
int main(void){CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};CGLPixelFormatObj pf;CGLContextObj ctx;GLint n;
 if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2;CGLSetCurrentContext(ctx);
 GLuint f,r;glGenFramebuffersEXT(1,&f);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,f);glGenRenderbuffersEXT(1,&r);glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,r);glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_RGBA8,16,16);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_RENDERBUFFER_EXT,r);
 printf("{\"renderer\":\"%s\",",glGetString(GL_RENDERER));
 for(int mode=0;mode<2;mode++){
 glViewport(0,0,16,16);glClearColor(0,0,0,1);glClear(GL_COLOR_BUFFER_BIT);glEnable(GL_BLEND);glBlendFunc(GL_SRC_ALPHA,GL_ONE_MINUS_SRC_ALPHA);
 if(!mode){glPolygonMode(GL_FRONT,GL_FILL);glPolygonMode(GL_BACK,GL_LINE);}
 for(int i=0;i<3;i++){
 if(mode)glPolygonMode(GL_FRONT_AND_BACK,i==1?GL_LINE:GL_FILL);
 glBegin(GL_TRIANGLES);if(i==0){glColor4f(1,0,0,.5);full();}else if(i==1){glColor4f(0,1,0,.5);glVertex2f(-.5,-.5);glVertex2f(-.5,.5);glVertex2f(.5,-.5);}else{glColor4f(0,0,1,.5);full();}glEnd();}
 unsigned char pixels[1024];glReadPixels(0,0,16,16,GL_RGBA,GL_UNSIGNED_BYTE,pixels);printf("\"%s\":[",mode?"probes":"directProbes");int points[3][2]={{8,3},{3,8},{7,8}};
 for(int i=0;i<3;i++){int x=points[i][0],y=points[i][1];unsigned char* p=pixels+(y*16+x)*4;printf("%s{\"x\":%d,\"y\":%d,\"rgba\":[%u,%u,%u,%u]}",i?",":"",x,y,p[0],p[1],p[2],p[3]);}printf("],");}
 printf("\"error\":%u}\n",glGetError());CGLSetCurrentContext(NULL);CGLDestroyContext(ctx);CGLDestroyPixelFormat(pf);return 0;}
