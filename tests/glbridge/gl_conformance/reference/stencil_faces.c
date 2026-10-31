#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
static int first=1;
static void triangle(int back){if(back){glVertex2f(-1,-1);glVertex2f(-1,3);glVertex2f(3,-1);}else{glVertex2f(-1,-1);glVertex2f(3,-1);glVertex2f(-1,3);}}
static void pixel(const char* name){unsigned char v=0;glReadPixels(8,8,1,1,GL_STENCIL_INDEX,GL_UNSIGNED_BYTE,&v);printf("%s{\"name\":\"%s\",\"error\":%u,\"value\":%u}",first?"":",\n",name,glGetError(),v);first=0;}
static void reset(void){glDisable(GL_CULL_FACE);glStencilMask(~0u);glClearStencil(0);glClear(GL_STENCIL_BUFFER_BIT);glStencilFuncSeparate(GL_FRONT,GL_ALWAYS,3,~0u);glStencilFuncSeparate(GL_BACK,GL_ALWAYS,9,~0u);glStencilOp(GL_KEEP,GL_KEEP,GL_REPLACE);}
int main(void){
 CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};CGLPixelFormatObj pf;CGLContextObj ctx;GLint n;
 if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2;CGLSetCurrentContext(ctx);
 GLuint fbo,r;glGenFramebuffersEXT(1,&fbo);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,fbo);glGenRenderbuffersEXT(1,&r);glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,r);
 glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_DEPTH24_STENCIL8,16,16);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_DEPTH_ATTACHMENT_EXT,GL_RENDERBUFFER_EXT,r);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_STENCIL_ATTACHMENT_EXT,GL_RENDERBUFFER_EXT,r);
 glDrawBuffer(GL_NONE);glReadBuffer(GL_NONE);glViewport(0,0,16,16);glEnable(GL_STENCIL_TEST);
 printf("{\"renderer\":\"%s\",\"cases\":[\n",glGetString(GL_RENDERER));
 reset();glBegin(GL_TRIANGLES);triangle(0);glEnd();pixel("front_ref");
 reset();glBegin(GL_TRIANGLES);triangle(1);glEnd();pixel("back_ref");
 reset();glStencilFuncSeparate(GL_FRONT,GL_ALWAYS,0xAB,~0u);glStencilFuncSeparate(GL_BACK,GL_ALWAYS,0xCD,~0u);glStencilMaskSeparate(GL_FRONT,0x0F);glStencilMaskSeparate(GL_BACK,0xF0);
 glBegin(GL_TRIANGLES);triangle(0);triangle(1);glEnd();pixel("write_masks");
 reset();glStencilFuncSeparate(GL_FRONT,GL_ALWAYS,1,~0u);glStencilFuncSeparate(GL_BACK,GL_ALWAYS,2,~0u);glStencilOpSeparate(GL_BACK,GL_KEEP,GL_KEEP,GL_INCR);
 glBegin(GL_TRIANGLES);triangle(1);triangle(0);triangle(1);glEnd();pixel("ordered_overlap");
 reset();glClearStencil(0xA3);glClear(GL_STENCIL_BUFFER_BIT);glStencilFuncSeparate(GL_FRONT,GL_EQUAL,3,0x0F);glStencilFuncSeparate(GL_BACK,GL_EQUAL,0xA0,0xF0);glStencilOp(GL_KEEP,GL_KEEP,GL_INVERT);
 glBegin(GL_TRIANGLES);triangle(1);glEnd();pixel("back_read_mask");
 reset();glEnable(GL_CULL_FACE);glCullFace(GL_BACK);glBegin(GL_TRIANGLES);triangle(1);triangle(0);glEnd();pixel("cull_back");
 reset();GLuint v=glCreateShader(GL_VERTEX_SHADER),p=glCreateProgram();const char* source="#version 120\nvoid main(){gl_Position=vec4(-gl_Vertex.x,gl_Vertex.y,gl_Vertex.z,gl_Vertex.w);}";glShaderSource(v,1,&source,NULL);glCompileShader(v);glAttachShader(p,v);glLinkProgram(p);glUseProgram(p);
 glBegin(GL_TRIANGLES);triangle(0);glEnd();pixel("program_flips_face");
 printf("\n]}\n");CGLSetCurrentContext(NULL);CGLDestroyContext(ctx);CGLDestroyPixelFormat(pf);return 0;
}
