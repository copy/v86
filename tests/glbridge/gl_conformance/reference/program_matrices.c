#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
static int first=1;
static void query(const char* name){
    GLfloat m[16],t[16];GLint depth,mode;glGetFloatv(GL_CURRENT_MATRIX_ARB,m);glGetFloatv(GL_TRANSPOSE_CURRENT_MATRIX_ARB,t);
    glGetIntegerv(GL_CURRENT_MATRIX_STACK_DEPTH_ARB,&depth);glGetIntegerv(GL_MATRIX_MODE,&mode);
    printf("%s{\"name\":\"%s\",\"error\":%u,\"mode\":%d,\"depth\":%d,\"matrix\":[",first?"":",\n",name,glGetError(),mode,depth);first=0;
    for(int i=0;i<16;i++)printf("%s%.9g",i?",":"",m[i]);printf("],\"transpose\":[");for(int i=0;i<16;i++)printf("%s%.9g",i?",":"",t[i]);printf("]}");
}
int main(void){
    CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};CGLPixelFormatObj pf;CGLContextObj ctx;GLint n;
    if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2;CGLSetCurrentContext(ctx);
    GLuint fbo,color;glGenFramebuffersEXT(1,&fbo);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,fbo);glGenRenderbuffersEXT(1,&color);glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,color);
    glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_RGBA8,16,16);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_RENDERBUFFER_EXT,color);
    GLint count,limit;glGetIntegerv(GL_MAX_PROGRAM_MATRICES_ARB,&count);glGetIntegerv(GL_MAX_PROGRAM_MATRIX_STACK_DEPTH_ARB,&limit);
    printf("{\"renderer\":\"%s\",\"count\":%d,\"limit\":%d,\"cases\":[\n",glGetString(GL_RENDERER),count,limit);query("initial");
    GLfloat m[16];for(int i=0;i<16;i++)m[i]=(GLfloat)(i+1);
    glMatrixMode(GL_MATRIX0_ARB);query("program_zero");glLoadMatrixf(m);query("load");glPushMatrix();glTranslatef(1,2,3);query("push_translate");glPopMatrix();query("pop");
    glMatrixMode(GL_MATRIX7_ARB);glScalef(2,3,4);query("last_matrix");glMatrixMode(GL_MATRIX0_ARB);query("independent");
    glMatrixMode(GL_PROJECTION);glTranslatef(4,5,6);query("projection");glMatrixMode(GL_TEXTURE);glActiveTexture(GL_TEXTURE3);glScalef(5,6,7);query("texture_three");
    glActiveTexture(GL_TEXTURE0);query("texture_zero");glMatrixMode(GL_MATRIX7_ARB);glPushAttrib(GL_TRANSFORM_BIT);glMatrixMode(GL_MODELVIEW);glTranslatef(7,8,9);glPopAttrib();query("transform_attrib");
    for(int i=1;i<limit;i++)glPushMatrix();query("full_stack");glPushMatrix();query("overflow");for(int i=1;i<limit;i++)glPopMatrix();query("empty_stack");glPopMatrix();query("underflow");
    glMatrixMode(GL_MATRIX0_ARB+count);query("invalid_mode");glBegin(GL_POINTS);glMatrixMode(GL_MATRIX0_ARB);glEnd();query("mode_inside_begin");
    glNewList(1,GL_COMPILE);glMatrixMode(GL_MATRIX0_ARB);glLoadIdentity();glTranslatef(10,11,12);glEndList();query("list_compile");glCallList(1);query("list_call");
    printf("\n]}\n");CGLSetCurrentContext(NULL);CGLDestroyContext(ctx);CGLDestroyPixelFormat(pf);return 0;
}
