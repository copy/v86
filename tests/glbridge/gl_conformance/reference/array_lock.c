#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
#include <string.h>
#ifndef GL_ARRAY_ELEMENT_LOCK_FIRST_EXT
#define GL_ARRAY_ELEMENT_LOCK_FIRST_EXT 0x81A8
#define GL_ARRAY_ELEMENT_LOCK_COUNT_EXT 0x81A9
extern void glLockArraysEXT(GLint first,GLsizei count);
extern void glUnlockArraysEXT(void);
#endif
static void state(const char* name){GLint first=-1,count=-1;glGetIntegerv(GL_ARRAY_ELEMENT_LOCK_FIRST_EXT,&first);glGetIntegerv(GL_ARRAY_ELEMENT_LOCK_COUNT_EXT,&count);printf("\"%s\":[%d,%d,%u],\n",name,first,count,glGetError());}
int main(void){CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};CGLPixelFormatObj p;CGLContextObj c;GLint n;if(CGLChoosePixelFormat(a,&p,&n)||CGLCreateContext(p,0,&c))return 2;CGLSetCurrentContext(c);
int supported=strstr((const char*)glGetString(GL_EXTENSIONS),"GL_EXT_compiled_vertex_array")!=0;
printf("{\"renderer\":\"%s\",\"supported\":%s,\"cases\":{\n",glGetString(GL_RENDERER),supported?"true":"false");
if(!supported){printf("}}\n");CGLSetCurrentContext(0);CGLDestroyContext(c);CGLDestroyPixelFormat(p);return 0;}state("initial");
glLockArraysEXT(-1,3);state("negative_first");glLockArraysEXT(0,0);state("zero_count");glLockArraysEXT(0,-1);state("negative_count");
glLockArraysEXT(2,3);state("locked");glLockArraysEXT(4,2);state("nested");
glPushClientAttrib(GL_CLIENT_VERTEX_ARRAY_BIT);glUnlockArraysEXT();state("unlocked_inside_stack");glPopClientAttrib();state("restored_lock");glUnlockArraysEXT();state("unlocked");glUnlockArraysEXT();state("unbalanced");
glBegin(GL_POINTS);glLockArraysEXT(0,3);glEnd();state("inside_begin");
glNewList(99,GL_COMPILE);glLockArraysEXT(1,4);glEndList();state("during_compile");glUnlockArraysEXT();glCallList(99);state("list_does_not_lock");
printf("\"error\":%u}}\n",glGetError());CGLSetCurrentContext(0);CGLDestroyContext(c);CGLDestroyPixelFormat(p);return 0;}
