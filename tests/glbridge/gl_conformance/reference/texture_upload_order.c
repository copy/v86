#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
static void draw(int x){glViewport(x,0,8,16);glBegin(GL_TRIANGLES);glVertex2f(-1,-1);glVertex2f(3,-1);glVertex2f(-1,3);glEnd();}
int main(void){CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};CGLPixelFormatObj pf;CGLContextObj ctx;GLint n;
 if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2;CGLSetCurrentContext(ctx);GLuint f,r;glGenFramebuffersEXT(1,&f);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,f);glGenRenderbuffersEXT(1,&r);glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,r);glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_RGBA8,16,16);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_RENDERBUFFER_EXT,r);
 const char* names[]={"rgba","rendered","volume","cube","bc1","depth16","depth32"};printf("{\"renderer\":\"%s\",\"cases\":[",glGetString(GL_RENDERER));
 for(int i=0;i<7;i++){GLenum target=i==2?GL_TEXTURE_3D:i==3?GL_TEXTURE_CUBE_MAP:GL_TEXTURE_2D,face=i==3?GL_TEXTURE_CUBE_MAP_NEGATIVE_X:target;GLuint t;glGenTextures(1,&t);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,f);glDisable(GL_TEXTURE_2D);glDisable(GL_TEXTURE_3D);glDisable(GL_TEXTURE_CUBE_MAP);glBindTexture(target,t);glEnable(target);glTexParameteri(target,GL_TEXTURE_MIN_FILTER,GL_NEAREST);glTexParameteri(target,GL_TEXTURE_MAG_FILTER,GL_NEAREST);glColor4f(1,1,1,1);glTexCoord4f(i==3?-1:.5,i==3?0:.5,i==2?.75:0,1);
 unsigned char red[]={255,0,0,255},blue[]={0,0,255,255},volume[]={255,0,0,255,0,255,0,255},bcRed[]={0,248,0,0,0,0,0,0},bcBlue[]={31,0,0,0,0,0,0,0};unsigned short d16=16384,d16b=49151;float d32=.25,d32b=.75;
 if(i>=5){glTexParameteri(target,GL_DEPTH_TEXTURE_MODE,GL_LUMINANCE);glTexImage2D(target,0,i==5?GL_DEPTH_COMPONENT16:GL_DEPTH_COMPONENT32,1,1,0,GL_DEPTH_COMPONENT,i==5?GL_UNSIGNED_SHORT:GL_FLOAT,i==5?(void*)&d16:(void*)&d32);}
 else if(i==1){glTexImage2D(target,0,GL_RGBA8,4,4,0,GL_RGBA,GL_UNSIGNED_BYTE,NULL);GLuint a;glGenFramebuffersEXT(1,&a);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,a);glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,target,t,0);glClearColor(1,0,0,1);glClear(GL_COLOR_BUFFER_BIT);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,f);}
 else if(i==2)glTexImage3D(target,0,GL_RGBA8,1,1,2,0,GL_RGBA,GL_UNSIGNED_BYTE,volume);
 else if(i==3)for(int j=0;j<6;j++)glTexImage2D(GL_TEXTURE_CUBE_MAP_POSITIVE_X+j,0,GL_RGBA8,1,1,0,GL_RGBA,GL_UNSIGNED_BYTE,red);
 else if(i==4)glCompressedTexImage2D(target,0,GL_COMPRESSED_RGBA_S3TC_DXT1_EXT,4,4,0,8,bcRed);
 else glTexImage2D(target,0,GL_RGBA8,1,1,0,GL_RGBA,GL_UNSIGNED_BYTE,red);
 draw(0);
 if(i>=5)glTexSubImage2D(target,0,0,0,1,1,GL_DEPTH_COMPONENT,i==5?GL_UNSIGNED_SHORT:GL_FLOAT,i==5?(void*)&d16b:(void*)&d32b);
 else if(i==1){unsigned char data[64];for(int j=0;j<64;j+=4)for(int k=0;k<4;k++)data[j+k]=blue[k];glTexSubImage2D(target,0,0,0,4,4,GL_RGBA,GL_UNSIGNED_BYTE,data);}
 else if(i==2)glTexSubImage3D(target,0,0,0,1,1,1,1,GL_RGBA,GL_UNSIGNED_BYTE,blue);
 else if(i==4)glCompressedTexSubImage2D(target,0,0,0,4,4,GL_COMPRESSED_RGBA_S3TC_DXT1_EXT,8,bcBlue);
 else glTexSubImage2D(face,0,0,0,1,1,GL_RGBA,GL_UNSIGNED_BYTE,blue);
 draw(8);unsigned char left[4],right[4];glReadPixels(4,8,1,1,GL_RGBA,GL_UNSIGNED_BYTE,left);glReadPixels(12,8,1,1,GL_RGBA,GL_UNSIGNED_BYTE,right);printf("%s{\"name\":\"%s\",\"error\":%u,\"left\":[%u,%u,%u,%u],\"right\":[%u,%u,%u,%u]}",i?",":"",names[i],glGetError(),left[0],left[1],left[2],left[3],right[0],right[1],right[2],right[3]);}
 printf("]}\n");CGLSetCurrentContext(NULL);CGLDestroyContext(ctx);CGLDestroyPixelFormat(pf);return 0;}
