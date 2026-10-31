#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
static const unsigned char bits[]={0x81,0x42,0x24,0x18,0x18,0x24,0x42,0x81};
static void glyph(float x,float y,float r,float g,float b,float a){glColor4f(r,g,b,a);glWindowPos3f(x,y,.25);glBitmap(8,8,0,0,0,0,bits);}
int main(void){const char *names[]={"shared_colors","zero_alpha_depth","ignores_zoom_transfer","unpack_skips_lsb","origin_scissor","latched_color_moves","ordered_new_masks","blend_alpha_stencil"};printf("{\"cases\":[");
 for(int c=0;c<8;c++){CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};CGLPixelFormatObj pf;CGLContextObj ctx;GLint n;if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,0,&ctx))return 2;CGLSetCurrentContext(ctx);GLuint f,r;glGenFramebuffersEXT(1,&f);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,f);glGenRenderbuffersEXT(1,&r);glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,r);glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_RGBA8,16,16);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_RENDERBUFFER_EXT,r);glGenRenderbuffersEXT(1,&r);glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,r);glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_DEPTH24_STENCIL8,16,16);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_DEPTH_ATTACHMENT_EXT,GL_RENDERBUFFER_EXT,r);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_STENCIL_ATTACHMENT_EXT,GL_RENDERBUFFER_EXT,r);glViewport(0,0,16,16);glClearColor(0,0,1,1);glClearDepth(.75);glClearStencil(66);glClear(GL_COLOR_BUFFER_BIT|GL_DEPTH_BUFFER_BIT|GL_STENCIL_BUFFER_BIT);glPixelStorei(GL_UNPACK_ALIGNMENT,1);
 if(c==0){glyph(0,0,1,0,0,1);glyph(8,0,0,1,0,1);glyph(0,8,1,1,0,.5);glyph(8,8,1,0,1,1);}
 if(c==1){glEnable(GL_DEPTH_TEST);glyph(4,4,1,0,0,0);}
 if(c==2){glPixelZoom(2,-3);glPixelTransferf(GL_RED_SCALE,0);glPixelTransferf(GL_GREEN_BIAS,1);glyph(4,4,1,0,0,1);}
 if(c==3){unsigned char data[]={0,0,0x90,0x01,0x48,0x02,0x24,0x04,0x12,0x08};glPixelStorei(GL_UNPACK_ROW_LENGTH,16);glPixelStorei(GL_UNPACK_SKIP_ROWS,1);glPixelStorei(GL_UNPACK_SKIP_PIXELS,3);glPixelStorei(GL_UNPACK_LSB_FIRST,1);glColor4f(1,1,0,1);glWindowPos3f(2,3,.25);glBitmap(8,4,0,0,0,0,data);}
 if(c==4){glEnable(GL_SCISSOR_TEST);glScissor(3,4,7,6);glViewport(1,1,2,2);glColor4f(0,1,0,1);glWindowPos3f(6,7,.25);glBitmap(8,8,2,3,0,0,bits);}
 if(c==5){glColor4f(1,0,0,1);glWindowPos3f(1,2,.25);glColor4f(0,1,0,1);glBitmap(8,8,0,0,7,3,bits);glBitmap(0,0,0,0,0,-2,0);glBitmap(8,8,0,0,0,0,bits);glRasterPos2f(2,2);glBitmap(8,8,0,0,-1,-1,bits);}
 if(c==6){unsigned char other[]={0xff,0x81,0xbd,0xa5,0xa5,0xbd,0x81,0xff};glyph(1,1,1,0,0,1);glColor4f(0,1,0,1);glWindowPos3f(7,7,.25);glBitmap(8,8,0,0,0,0,other);glyph(4,4,1,1,0,1);}
 if(c==7){glEnable(GL_BLEND);glBlendFunc(GL_SRC_ALPHA,GL_ONE_MINUS_SRC_ALPHA);glEnable(GL_ALPHA_TEST);glAlphaFunc(GL_GREATER,.25);glEnable(GL_STENCIL_TEST);glStencilFunc(GL_ALWAYS,77,255);glStencilOp(GL_KEEP,GL_KEEP,GL_REPLACE);glyph(1,1,1,0,0,.5);glyph(7,7,0,1,0,.2);}
 glPixelTransferf(GL_RED_SCALE,1);glPixelTransferf(GL_GREEN_BIAS,0);
 unsigned char pixels[1024],stencil[256];float depth[256];glReadPixels(0,0,16,16,GL_RGBA,GL_UNSIGNED_BYTE,pixels);glReadPixels(0,0,16,16,GL_STENCIL_INDEX,GL_UNSIGNED_BYTE,stencil);glReadPixels(0,0,16,16,GL_DEPTH_COMPONENT,GL_FLOAT,depth);printf("%s{\"name\":\"%s\",\"pixels\":[",c?",":"",names[c]);for(int i=0;i<1024;i++)printf("%s%u",i?",":"",pixels[i]);printf("],\"depth\":[");for(int i=0;i<256;i++)printf("%s%.9g",i?",":"",depth[i]);printf("],\"stencil\":[");for(int i=0;i<256;i++)printf("%s%u",i?",":"",stencil[i]);printf("],\"error\":%u}",glGetError());CGLSetCurrentContext(0);CGLDestroyContext(ctx);CGLDestroyPixelFormat(pf);}
 printf("]}\n");return 0;}
