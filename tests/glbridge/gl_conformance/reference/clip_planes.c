#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
#include <string.h>
typedef struct {const char* name;int stage,mask,homogeneous,clipW,builtin,invariant,ignored;} Case;
/* Scene parameters mirror gl_clip_planes_cases.js. */
static const Case cases[]={
{"fixed_plane4",0,16,0,0,0,0,0},
{"fixed_plane5",0,32,0,0,0,0,0},
{"fixed_both",0,48,0,0,0,0,0},
{"fixed_hole",0,32,0,0,0,0,0},
{"fixed_homogeneous",0,32,1,0,0,0,0},
{"glsl_plane4",1,16,0,0,0,0,0},
{"glsl_plane5",1,32,0,0,0,0,0},
{"glsl_both",1,48,0,0,0,0,0},
{"glsl_hole",1,32,0,0,0,0,0},
{"glsl_homogeneous",1,32,1,0,0,0,0},
{"glsl_negative_clip_w",1,32,0,1,0,0,0},
{"glsl_inactive_builtin",1,32,0,0,1,0,0},
{"fragment_only",2,32,0,0,0,0,0},
{"vertex_only",3,32,0,0,0,0,0},
{"arb_invariant4",4,16,0,0,0,1,0},
{"arb_invariant5",4,32,0,0,0,1,0},
{"arb_invariant_hole",4,32,0,0,0,1,0},
{"arb_invariant_homogeneous",4,32,1,0,0,1,0},
{"arb_noninvariant",4,32,0,0,0,0,1},
{"arb_pair_invariant",5,32,0,0,0,1,0},
{"arb_pair_noninvariant",5,32,0,0,0,0,1},
{"fixed_arb_fragment",6,32,0,0,0,0,0}
};
static GLuint shader(GLenum type,const char* source){GLuint s=glCreateShader(type);glShaderSource(s,1,&source,NULL);glCompileShader(s);GLint ok;glGetShaderiv(s,GL_COMPILE_STATUS,&ok);if(!ok){char log[8192];glGetShaderInfoLog(s,sizeof(log),NULL,log);fprintf(stderr,"%s\n",log);}return s;}
static void setup(const Case* c){glUseProgram(0);glDisable(GL_VERTEX_PROGRAM_ARB);glDisable(GL_FRAGMENT_PROGRAM_ARB);glMatrixMode(GL_MODELVIEW);glLoadIdentity();for(int i=0;i<6;i++)glDisable(GL_CLIP_PLANE0+i);
 if(c->stage>=1&&c->stage<=3){char vs[2048]="#version 120\nvoid main(){gl_Position=gl_Vertex;gl_ClipVertex=";strcat(vs,c->clipW?"vec4(gl_Vertex.xyz,-1.0);":"gl_ModelViewMatrix*gl_Vertex;");strcat(vs,"gl_FrontColor=");strcat(vs,c->builtin?"vec4(0.0,gl_ClipPlane[0].y,0.0,1.0);}":"gl_Color;}");GLuint p=glCreateProgram();if(c->stage!=2)glAttachShader(p,shader(GL_VERTEX_SHADER,vs));if(c->stage!=3)glAttachShader(p,shader(GL_FRAGMENT_SHADER,"#version 120\nvoid main(){gl_FragColor=gl_Color;}"));glLinkProgram(p);glUseProgram(p);}
 if(c->stage==4||c->stage==5){char source[1024]="!!ARBvp1.0\n";strcat(source,c->invariant?"OPTION ARB_position_invariant;":"MOV result.position,vertex.position;");strcat(source,"MOV result.color,vertex.color;END");GLuint p;glGenProgramsARB(1,&p);glBindProgramARB(GL_VERTEX_PROGRAM_ARB,p);glProgramStringARB(GL_VERTEX_PROGRAM_ARB,GL_PROGRAM_FORMAT_ASCII_ARB,strlen(source),source);glEnable(GL_VERTEX_PROGRAM_ARB);}
 if(c->stage==5||c->stage==6){const char* source="!!ARBfp1.0\nMOV result.color,fragment.color;END";GLuint p;glGenProgramsARB(1,&p);glBindProgramARB(GL_FRAGMENT_PROGRAM_ARB,p);glProgramStringARB(GL_FRAGMENT_PROGRAM_ARB,GL_PROGRAM_FORMAT_ASCII_ARB,strlen(source),source);glEnable(GL_FRAGMENT_PROGRAM_ARB);}
 double planes[6][4]={{-1,0,0,-2},{0,0,0,0},{0,0,0,0},{0,0,0,0},{1,0,0,-.125},{0,1,0,-.125}};
 if(c->builtin){planes[0][0]=0;planes[0][1]=1;planes[0][3]=0;}if(c->homogeneous){planes[5][0]=1;planes[5][1]=0;planes[5][3]=.25;}if(c->ignored){planes[5][1]=0;planes[5][3]=-1;}if(c->clipW)planes[5][3]=.125;
 for(int i=0;i<6;i++){glClipPlane(GL_CLIP_PLANE0+i,planes[i]);if(c->mask&(1<<i))glEnable(GL_CLIP_PLANE0+i);}}
static void draw(const Case* c){glClearColor(0,0,0,1);glClear(GL_COLOR_BUFFER_BIT);glColor4f(0,1,0,1);float w=c->homogeneous?2:1;glBegin(GL_QUADS);glVertex4f(-.75*w,-.75*w,0,w);glVertex4f(.75*w,-.75*w,0,w);glVertex4f(.75*w,.75*w,0,w);glVertex4f(-.75*w,.75*w,0,w);glEnd();}
int main(void){CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};CGLPixelFormatObj pf;CGLContextObj ctx;GLint n;if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2;CGLSetCurrentContext(ctx);GLuint f,r;glGenFramebuffersEXT(1,&f);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,f);glGenRenderbuffersEXT(1,&r);glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,r);glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_RGBA8,16,16);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_RENDERBUFFER_EXT,r);glViewport(0,0,16,16);
 printf("{\"renderer\":\"%s\",\"cases\":[",glGetString(GL_RENDERER));for(unsigned i=0;i<sizeof(cases)/sizeof(cases[0]);i++){const Case* c=&cases[i];setup(c);draw(c);unsigned char pixels[1024];glReadPixels(0,0,16,16,GL_RGBA,GL_UNSIGNED_BYTE,pixels);printf("%s{\"name\":\"%s\",\"rows\":[",i?",":"",c->name);for(int y=0;y<16;y++){unsigned mask=0;for(int x=0;x<16;x++)if(pixels[(y*16+x)*4+1]>128)mask|=1u<<x;printf("%s%u",y?",":"",mask);}printf("],\"error\":%u}",glGetError());}printf("]}\n");CGLSetCurrentContext(NULL);CGLDestroyContext(ctx);CGLDestroyPixelFormat(pf);return 0;}
