#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
#include <string.h>
static void scene(const char *name){
 glViewport(0,0,16,16);glDisable(GL_MULTISAMPLE);glEnable(GL_SAMPLE_ALPHA_TO_COVERAGE);glEnable(GL_SAMPLE_COVERAGE);glSampleCoverage(0,0);
 glClearColor(0,0,1,1);glClearDepth(1);glClearStencil(3);glClear(GL_COLOR_BUFFER_BIT|GL_DEPTH_BUFFER_BIT|GL_STENCIL_BUFFER_BIT);
 if(!strcmp(name,"glsl_discard")){GLuint p=glCreateProgram(),v=glCreateShader(GL_VERTEX_SHADER),f=glCreateShader(GL_FRAGMENT_SHADER);const char *vs="#version 120\nvoid main(){gl_Position=gl_Vertex;gl_FrontColor=gl_Color;}",*fs="#version 120\nvoid main(){if(gl_FragCoord.x<6.0)discard;gl_FragColor=gl_Color;gl_FragDepth=.25;}";glShaderSource(v,1,&vs,0);glShaderSource(f,1,&fs,0);glCompileShader(v);glCompileShader(f);glAttachShader(p,v);glAttachShader(p,f);glLinkProgram(p);glUseProgram(p);glEnable(GL_DEPTH_TEST);}
 if(!strcmp(name,"blend")||!strcmp(name,"points")||!strcmp(name,"lines")||!strcmp(name,"clipped_points")){glEnable(GL_BLEND);glBlendFunc(GL_SRC_ALPHA,GL_ONE_MINUS_SRC_ALPHA);}
 if(!strcmp(name,"logic")){glEnable(GL_COLOR_LOGIC_OP);glLogicOp(GL_XOR);}
 if(!strcmp(name,"depth_stencil")){glEnable(GL_DEPTH_TEST);glEnable(GL_STENCIL_TEST);glStencilFunc(GL_ALWAYS,7,255);glStencilOp(GL_KEEP,GL_KEEP,GL_INCR);}
 if(!strcmp(name,"back_stencil")){glEnable(GL_STENCIL_TEST);glStencilFuncSeparate(GL_FRONT,GL_ALWAYS,17,255);glStencilFuncSeparate(GL_BACK,GL_ALWAYS,165,255);glStencilMaskSeparate(GL_FRONT,15);glStencilMaskSeparate(GL_BACK,240);glStencilOp(GL_KEEP,GL_KEEP,GL_REPLACE);}
 if(!strcmp(name,"scissor")){glEnable(GL_SCISSOR_TEST);glScissor(5,3,7,8);}
 int points=!strcmp(name,"points"),lines=!strcmp(name,"lines"),clipped=!strcmp(name,"clipped_points");if(points||clipped)glPointSize(5);if(lines)glLineWidth(3);if(clipped)glPolygonMode(GL_FRONT_AND_BACK,GL_POINT);
 glBegin(points?GL_POINTS:lines?GL_LINE_STRIP:GL_TRIANGLES);
 for(int i=0;i<(points?8:clipped?1:3);i++){glColor4f(i%3==0,i%3==1,0,.5);float v[3][2]={{-.731,-.647},{.693,-.539},{-.107,.843}};int count=3;
 if(points){v[0][0]=.0625;v[0][1]=.0625;count=1;}if(lines){v[0][0]=i%2?.5625:-.4375;v[0][1]=(i-1)*.4375;count=1;}if(clipped){v[0][0]=-.75;v[0][1]=-.1;v[1][0]=3;v[1][1]=0;v[2][0]=-.75;v[2][1]=.1;}
 for(int j=0;j<count;j++)glVertex4f(!strcmp(name,"back_stencil")&&i==1?-v[j][0]:v[j][0],v[j][1],i*.1,1);}
 glEnd();
}
static GLuint framebuffer(int samples){GLuint f,r;glGenFramebuffersEXT(1,&f);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,f);for(int i=0;i<2;i++){glGenRenderbuffersEXT(1,&r);glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,r);if(samples>1)glRenderbufferStorageMultisampleEXT(GL_RENDERBUFFER_EXT,samples,i?GL_DEPTH24_STENCIL8:GL_RGBA8,16,16);else glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,i?GL_DEPTH24_STENCIL8:GL_RGBA8,16,16);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,i?GL_DEPTH_ATTACHMENT_EXT:GL_COLOR_ATTACHMENT0_EXT,GL_RENDERBUFFER_EXT,r);if(i)glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_STENCIL_ATTACHMENT_EXT,GL_RENDERBUFFER_EXT,r);}return f;}
int main(void){const char *names[]={"triangle","blend","depth_stencil","logic","points","lines","glsl_discard","scissor","back_stencil","clipped_points"};printf("{\"cases\":[");
 for(int i=0;i<10;i++)for(int k=0;k<2;k++){CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};CGLPixelFormatObj pf;CGLContextObj ctx;GLint n;if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,0,&ctx))return 2;CGLSetCurrentContext(ctx);GLuint source=framebuffer(k?4:1);scene(names[i]);
 if(k){GLuint destination=framebuffer(1);glDisable(GL_SCISSOR_TEST);glBindFramebufferEXT(GL_READ_FRAMEBUFFER_EXT,source);glBindFramebufferEXT(GL_DRAW_FRAMEBUFFER_EXT,destination);glBlitFramebufferEXT(0,0,16,16,0,0,16,16,GL_COLOR_BUFFER_BIT|GL_DEPTH_BUFFER_BIT|GL_STENCIL_BUFFER_BIT,GL_NEAREST);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,destination);}
 unsigned char rgba[1024],stencil[256];float depth[256];glReadPixels(0,0,16,16,GL_RGBA,GL_UNSIGNED_BYTE,rgba);glReadPixels(0,0,16,16,GL_STENCIL_INDEX,GL_UNSIGNED_BYTE,stencil);glReadPixels(0,0,16,16,GL_DEPTH_COMPONENT,GL_FLOAT,depth);
 printf("%s{\"name\":\"%s\",\"samples\":%d,\"pixels\":[",i||k?",":"",names[i],k?4:1);for(int j=0;j<1024;j++)printf("%s%u",j?",":"",rgba[j]);printf("],\"stencil\":[");for(int j=0;j<256;j++)printf("%s%u",j?",":"",stencil[j]);printf("],\"depth\":[");for(int j=0;j<256;j++)printf("%s%.9g",j?",":"",depth[j]);printf("],\"error\":%u}",glGetError());CGLSetCurrentContext(0);CGLDestroyContext(ctx);CGLDestroyPixelFormat(pf);}
 printf("]}\n");return 0;}
