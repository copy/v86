#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
#include <stdlib.h>
static int first=1;static GLuint fcolor,fdepth;
static void image(int level,int size,float r,float g,float b,int depth,int sub){float d[256];unsigned char c[1024];for(int i=0;i<256;i++){d[i]=r;c[i*4]=(unsigned char)r;c[i*4+1]=(unsigned char)g;c[i*4+2]=(unsigned char)b;c[i*4+3]=255;}
 if(sub)glTexSubImage2D(GL_TEXTURE_2D,level,0,0,size,size,depth?GL_DEPTH_COMPONENT:GL_RGBA,depth?GL_FLOAT:GL_UNSIGNED_BYTE,depth?(void*)d:(void*)c);
 else glTexImage2D(GL_TEXTURE_2D,level,depth?GL_DEPTH_COMPONENT32:GL_RGBA8,size,size,0,depth?GL_DEPTH_COMPONENT:GL_RGBA,depth?GL_FLOAT:GL_UNSIGNED_BYTE,depth?(void*)d:(void*)c);}
static void clearbase(GLuint texture,int level,int depth,float r,float g,float b){glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,depth?fdepth:fcolor);glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT,depth?GL_DEPTH_ATTACHMENT_EXT:GL_COLOR_ATTACHMENT0_EXT,GL_TEXTURE_2D,texture,level);glDrawBuffer(depth?GL_NONE:GL_COLOR_ATTACHMENT0_EXT);glReadBuffer(depth?GL_NONE:GL_COLOR_ATTACHMENT0_EXT);if(depth){glClearDepth(r);glClear(GL_DEPTH_BUFFER_BIT);}else{glClearColor(r,g,b,1);glClear(GL_COLOR_BUFFER_BIT);}glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,0);}
static void probe(const char* phase,int level,int depth){GLint w,h;glGetTexLevelParameteriv(GL_TEXTURE_2D,level,GL_TEXTURE_WIDTH,&w);glGetTexLevelParameteriv(GL_TEXTURE_2D,level,GL_TEXTURE_HEIGHT,&h);void* data=calloc((size_t)w*h,16);glGetTexImage(GL_TEXTURE_2D,level,depth?GL_DEPTH_COMPONENT:GL_RGBA,depth?GL_FLOAT:GL_UNSIGNED_BYTE,data);printf("%s{\"phase\":\"%s\",\"level\":%d,\"size\":%d,\"depth\":%s,\"error\":%u,\"values\":[",first?"":",\n",phase,level,w,depth?"true":"false",glGetError());first=0;for(int i=0;i<(depth?1:4);i++)printf("%s%.9g",i?",":"",depth?((float*)data)[i]:((unsigned char*)data)[i]);printf("]}");free(data);}
static void probes(const char* name,int depth){if(!depth)probe(name,0,0);for(int level=depth?1:2;level<=(depth?3:4);level++)probe(name,level,depth);}
int main(void){CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};CGLPixelFormatObj pf;CGLContextObj ctx;GLint n;if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2;CGLSetCurrentContext(ctx);glGenFramebuffersEXT(1,&fcolor);glGenFramebuffersEXT(1,&fdepth);GLuint t,d;glGenTextures(1,&t);glGenTextures(1,&d);printf("{\"renderer\":\"%s\",\"cases\":[\n",glGetString(GL_RENDERER));
 glBindTexture(GL_TEXTURE_2D,t);image(0,16,255,0,0,0,0);image(2,4,0,255,0,0,0);image(3,2,0,0,255,0,0);image(4,1,255,255,0,0,0);glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_BASE_LEVEL,2);glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAX_LEVEL,3);probes("before_manual",0);glGenerateMipmapEXT(GL_TEXTURE_2D);probes("cpu_manual",0);
 clearbase(t,2,0,0,1,1);glGenerateMipmapEXT(GL_TEXTURE_2D);probes("gpu_manual",0);
 glTexParameteri(GL_TEXTURE_2D,GL_GENERATE_MIPMAP,1);image(2,4,255,0,255,0,1);probes("gpu_auto_sub",0);
 clearbase(t,2,0,1,1,1);probes("gpu_no_auto_render",0);
 glBindTexture(GL_TEXTURE_2D,d);glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_BASE_LEVEL,1);glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAX_LEVEL,2);image(1,4,.25,0,0,1,0);image(3,1,.875,0,0,1,0);clearbase(d,1,1,.5,0,0);glGenerateMipmapEXT(GL_TEXTURE_2D);probes("depth_manual",1);
 glTexParameteri(GL_TEXTURE_2D,GL_GENERATE_MIPMAP,1);image(1,4,.75,0,0,1,1);probes("depth_auto",1);
 printf("\n]}\n");CGLSetCurrentContext(NULL);CGLDestroyContext(ctx);CGLDestroyPixelFormat(pf);return 0;}
