#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
int main(void){CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};CGLPixelFormatObj p;CGLContextObj c;GLint n;if(CGLChoosePixelFormat(a,&p,&n)||CGLCreateContext(p,0,&c))return 2;CGLSetCurrentContext(c);GLuint t,f;glGenTextures(1,&t);glBindTexture(GL_TEXTURE_2D,t);glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,1,1,0,GL_RGBA,GL_UNSIGNED_BYTE,0);glGenFramebuffersEXT(1,&f);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,f);glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_TEXTURE_2D,t,0);glViewport(0,0,1,1);GLbyte normal[]={-128,0,64},attrib[]={-128,-64,0,127};GLfloat v[]={0,0,0,2},out[4]={0};glEnableClientState(GL_VERTEX_ARRAY);glVertexPointer(4,GL_FLOAT,0,v);glEnableClientState(GL_NORMAL_ARRAY);glNormalPointer(GL_BYTE,0,normal);glEnableVertexAttribArray(7);glVertexAttribPointer(7,4,GL_BYTE,GL_TRUE,0,attrib);GLfloat feedback[64]={0};glFeedbackBuffer(64,GL_4D_COLOR_TEXTURE,feedback);glRenderMode(GL_FEEDBACK);glBegin(GL_POINTS);glArrayElement(0);glEnd();GLint returned=glRenderMode(GL_RENDER);
 printf("{\n  \"renderer\":\"%s\",\n  \"cases\":{\n",glGetString(GL_RENDERER));
 glGetVertexAttribfv(7,GL_CURRENT_VERTEX_ATTRIB,out);printf("    \"generic\":[%.9g,%.9g,%.9g,%.9g],\n",out[0],out[1],out[2],out[3]);
 glGetFloatv(GL_CURRENT_NORMAL,out);printf("    \"normal\":[%.9g,%.9g,%.9g],\n",out[0],out[1],out[2]);
 printf("    \"feedback\":[%d,%.9g,%.9g,%.9g,%.9g],\n",returned,feedback[1],feedback[2],feedback[3],feedback[4]);
 glNormal3b(-128,-64,127);glGetFloatv(GL_CURRENT_NORMAL,out);printf("    \"normal3b\":[%.9g,%.9g,%.9g],\n",out[0],out[1],out[2]);
 glNormal3s(-32768,-16384,32767);glGetFloatv(GL_CURRENT_NORMAL,out);printf("    \"normal3s\":[%.9g,%.9g,%.9g],\n",out[0],out[1],out[2]);
 glNormal3i(-2147483647-1,-1073741824,2147483647);glGetFloatv(GL_CURRENT_NORMAL,out);printf("    \"normal3i\":[%.9g,%.9g,%.9g],\n",out[0],out[1],out[2]);
 printf("    \"error\":%u\n  }\n}\n",glGetError());CGLSetCurrentContext(0);CGLDestroyContext(c);CGLDestroyPixelFormat(p);return 0;}
