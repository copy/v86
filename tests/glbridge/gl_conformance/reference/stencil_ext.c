#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
static int first=1;
static GLenum pnames[]={GL_ACTIVE_STENCIL_FACE_EXT,GL_STENCIL_TEST_TWO_SIDE_EXT,GL_STENCIL_FUNC,GL_STENCIL_REF,GL_STENCIL_VALUE_MASK,GL_STENCIL_WRITEMASK,
    GL_STENCIL_FAIL,GL_STENCIL_PASS_DEPTH_FAIL,GL_STENCIL_PASS_DEPTH_PASS,GL_STENCIL_BACK_FUNC,GL_STENCIL_BACK_REF,GL_STENCIL_BACK_VALUE_MASK,GL_STENCIL_BACK_WRITEMASK,
    GL_STENCIL_BACK_FAIL,GL_STENCIL_BACK_PASS_DEPTH_FAIL,GL_STENCIL_BACK_PASS_DEPTH_PASS};
static void query(const char* name){
    GLint values[16]={0};for(int i=0;i<16;i++)glGetIntegerv(pnames[i],values+i);
    printf("%s{\"name\":\"%s\",\"error\":%u,\"values\":[",first?"":",\n",name,glGetError());first=0;
    for(int i=0;i<16;i++)printf("%s%d",i?",":"",values[i]);printf("]}");
}
static void error(const char* name){printf("%s{\"name\":\"%s\",\"error\":%u}",first?"":",\n",name,glGetError());first=0;}
int main(void){
    CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};CGLPixelFormatObj pf;CGLContextObj ctx;GLint n;
    if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2;CGLSetCurrentContext(ctx);
    GLuint fbo,color,depth;glGenFramebuffersEXT(1,&fbo);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,fbo);glGenRenderbuffersEXT(1,&color);glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,color);
    glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_RGBA8,16,16);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_RENDERBUFFER_EXT,color);
    glGenRenderbuffersEXT(1,&depth);glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,depth);glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_DEPTH24_STENCIL8,16,16);
    glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_DEPTH_ATTACHMENT_EXT,GL_RENDERBUFFER_EXT,depth);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_STENCIL_ATTACHMENT_EXT,GL_RENDERBUFFER_EXT,depth);
    printf("{\"renderer\":\"%s\",\"cases\":[\n",glGetString(GL_RENDERER));query("initial");
    glStencilFuncSeparate(GL_BACK,GL_LESS,5,0x0F);query("core_back");
    glActiveStencilFaceEXT(GL_BACK);glStencilFunc(GL_GREATER,7,0xF0);query("ext_back");
    glStencilFuncSeparate(GL_FRONT,GL_NOTEQUAL,3,0xAA);query("front_separate");
    glActiveStencilFaceEXT(GL_FRONT);glStencilFunc(GL_EQUAL,11,0xB0);query("front_nonseparate");
    glActiveStencilFaceEXT(GL_BACK);query("ext_back_kept");glEnable(GL_STENCIL_TEST_TWO_SIDE_EXT);query("ext_enabled");
    glPushAttrib(GL_STENCIL_BUFFER_BIT);glActiveStencilFaceEXT(GL_FRONT);glStencilFunc(GL_ALWAYS,13,0xC0);glActiveStencilFaceEXT(GL_BACK);glStencilFunc(GL_NEVER,19,0xD0);glStencilMask(7);glPopAttrib();query("attrib_restored");
    glStencilMaskSeparate(GL_BACK,0x33);glStencilMask(0x77);query("separate_masks");glActiveStencilFaceEXT(GL_FRONT);glStencilMask(0x55);query("front_mask");glActiveStencilFaceEXT(GL_BACK);query("ext_mask_kept");
    glStencilOpSeparate(GL_BACK,GL_REPLACE,GL_INCR,GL_DECR);glStencilOp(GL_KEEP,GL_DECR_WRAP,GL_INCR_WRAP);query("separate_ops");
    glActiveStencilFaceEXT(GL_FRONT);glStencilFunc(GL_ALWAYS,-7,~0u);query("negative_ref");glStencilFuncSeparate(GL_BACK,GL_ALWAYS,1234567,~0u);query("large_ref");
    glActiveStencilFaceEXT(GL_FRONT_AND_BACK);error("invalid_face");glBegin(GL_POINTS);glActiveStencilFaceEXT(GL_BACK);glEnd();error("face_inside_begin");
    glNewList(1,GL_COMPILE);glActiveStencilFaceEXT(GL_BACK);glStencilFunc(GL_NEVER,17,0xAA);glEndList();query("list_compile");glCallList(1);query("list_call");
    printf("\n]}\n");CGLSetCurrentContext(NULL);CGLDestroyContext(ctx);CGLDestroyPixelFormat(pf);return 0;
}
