#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
#include <string.h>
enum {F_POINT,F_TOP,F_CORNER,F_NEAR,F_FAR,F_USER,F_TWO,F_HOMOGENEOUS,F_EDGES,F_LIGHT,F_INSIDE,F_GLSL,F_CLIPW,F_NONLINEAR,F_PROGRAMSIZE,F_FLIP,F_MIXED,F_CULL,F_ARB,F_NONINVARIANT,F_PAIR,F_ALL,F_INDEXED,F_VBO,F_CROSSW,F_OFFSET,F_PROVOKINGOUT};
typedef struct {const char* name;unsigned flags;float units,factor;} Case;
#define HAS(bit) ((c->flags&(1u<<(bit)))!=0)
/* Scene parameters mirror gl_polygon_clip_cases.js. */
static const Case cases[]={
{"fixed_view_line",0,0,0},
{"fixed_view_point",1,0,0},
{"fixed_top_line",2,0,0},
{"fixed_corner_point",5,0,0},
{"fixed_near_line",8,0,0},
{"fixed_far_point",17,0,0},
{"fixed_user_line",32,0,0},
{"fixed_user_point",33,0,0},
{"fixed_two_planes_point",97,0,0},
{"fixed_homogeneous",160,0,0},
{"fixed_edges_line",256,0,0},
{"fixed_edges_point",257,0,0},
{"fixed_flat_light_line",512,0,0},
{"fixed_flat_light_point",513,0,0},
{"fixed_flat_inside",1536,0,0},
{"glsl_view_line",2048,0,0},
{"glsl_view_point",2049,0,0},
{"glsl_user_line",2080,0,0},
{"glsl_negative_clip_w",6177,0,0},
{"glsl_nonlinear_point",10241,0,0},
{"glsl_program_point",18433,0,0},
{"glsl_mixed_back",100352,0,0},
{"glsl_cull_back",165888,0,0},
{"arb_invariant_user",262176,0,0},
{"arb_noninvariant_user",786464,0,0},
{"arb_pair_user_point",1310753,0,0},
{"arb_all_outputs",2359329,0,0},
{"glsl_indexed_user",4196384,0,0},
{"glsl_vbo_point",8390657,0,0},
{"glsl_cross_w",16779264,0,0},
{"glsl_offset_positive",33556480,16,0},
{"glsl_offset_negative",33556480,-16,0},
{"fixed_offset_slope",0,0,1},
{"fixed_clipped_provoking",67109376,0,0}
};
static GLuint glslCurrent,arbCurrent[2];
static void releasePrograms(void){glUseProgram(0);glDisable(GL_VERTEX_PROGRAM_ARB);glDisable(GL_FRAGMENT_PROGRAM_ARB);glBindProgramARB(GL_VERTEX_PROGRAM_ARB,0);glBindProgramARB(GL_FRAGMENT_PROGRAM_ARB,0);if(glslCurrent){glDeleteProgram(glslCurrent);glslCurrent=0;}for(int i=0;i<2;i++)if(arbCurrent[i]){glDeleteProgramsARB(1,&arbCurrent[i]);arbCurrent[i]=0;}}
static GLuint shader(GLenum type,const char* source){GLuint s=glCreateShader(type);glShaderSource(s,1,&source,NULL);glCompileShader(s);GLint ok;glGetShaderiv(s,GL_COMPILE_STATUS,&ok);if(!ok){char log[8192];glGetShaderInfoLog(s,sizeof(log),NULL,log);fprintf(stderr,"%s\n",log);}return s;}
static void setup(const Case* c,int strict){releasePrograms();glBindBuffer(GL_ARRAY_BUFFER,0);glDisableClientState(GL_VERTEX_ARRAY);glVertexPointer(4,GL_FLOAT,16,NULL);glUseProgram(0);glDisable(GL_VERTEX_PROGRAM_ARB);glDisable(GL_FRAGMENT_PROGRAM_ARB);glDisable(GL_VERTEX_PROGRAM_POINT_SIZE);glDisable(GL_VERTEX_PROGRAM_TWO_SIDE);glDisable(GL_COLOR_SUM);glDisable(GL_LIGHTING);glDisable(GL_LIGHT0);glDisable(GL_CULL_FACE);glDisable(GL_DEPTH_TEST);glDisable(GL_POLYGON_OFFSET_LINE);glDisable(GL_POLYGON_OFFSET_POINT);glShadeModel(GL_SMOOTH);glFrontFace(GL_CCW);glMatrixMode(GL_MODELVIEW);glLoadIdentity();for(int i=0;i<6;i++)glDisable(GL_CLIP_PLANE0+i);
 if(HAS(F_GLSL)){char vs[8192]="#version 120\n",fs[1024]="#version 120\n";if(HAS(F_NONLINEAR)){strcat(vs,"varying vec4 custom;");strcat(fs,"varying vec4 custom;");}strcat(vs,"void main(){gl_Position=gl_ModelViewProjectionMatrix*gl_Vertex;gl_ClipVertex=");strcat(vs,HAS(F_CLIPW)?"vec4(gl_Vertex.xyz,-1.0);":"gl_ModelViewMatrix*gl_Vertex;");
 if(HAS(F_NONLINEAR))strcat(vs,"custom=vec4(0.0,.1+.05*gl_Vertex.x*gl_Vertex.x,0.0,1.0);gl_PointSize=6.0+4.0*gl_Vertex.x*gl_Vertex.x;");else{strcat(vs,"gl_FrontColor=gl_Color;");if(HAS(F_PROGRAMSIZE))strcat(vs,"gl_PointSize=6.0;");}strcat(vs,"}");strcat(fs,HAS(F_NONLINEAR)?"void main(){gl_FragColor=custom;}":"void main(){gl_FragColor=gl_Color;}");GLuint p=glCreateProgram(),v=shader(GL_VERTEX_SHADER,vs),f=shader(GL_FRAGMENT_SHADER,fs);glAttachShader(p,v);glAttachShader(p,f);glLinkProgram(p);glDeleteShader(v);glDeleteShader(f);glUseProgram(p);glslCurrent=p;}
 if(HAS(F_ARB)){char source[8192]="!!ARBvp1.0\n";strcat(source,HAS(F_NONINVARIANT)&&!strict?"MOV result.position,vertex.position;":"OPTION ARB_position_invariant;");strcat(source,"MOV result.color,vertex.color;");if(HAS(F_ALL)){strcat(source,"MOV result.color.back,{1,0,0,1};MOV result.color.secondary,{0,0,0,0};MOV result.color.back.secondary,{0,0,0,0};MOV result.pointsize,{4,0,0,1};");for(int i=0;i<8;i++){char temp[128];sprintf(temp,"MOV result.texcoord[%d],vertex.position;",i);strcat(source,temp);}}strcat(source,"END");GLuint p;glGenProgramsARB(1,&p);arbCurrent[0]=p;glBindProgramARB(GL_VERTEX_PROGRAM_ARB,p);glProgramStringARB(GL_VERTEX_PROGRAM_ARB,GL_PROGRAM_FORMAT_ASCII_ARB,strlen(source),source);glEnable(GL_VERTEX_PROGRAM_ARB);
 if(HAS(F_PAIR)){const char* fs="!!ARBfp1.0\nMOV result.color,fragment.color;END";glGenProgramsARB(1,&p);arbCurrent[1]=p;glBindProgramARB(GL_FRAGMENT_PROGRAM_ARB,p);glProgramStringARB(GL_FRAGMENT_PROGRAM_ARB,GL_PROGRAM_FORMAT_ASCII_ARB,strlen(fs),fs);glEnable(GL_FRAGMENT_PROGRAM_ARB);}}
 if(HAS(F_USER)){double p0[]={0,0,0,-1},p5[]={-1,0,0,.125};glClipPlane(GL_CLIP_PLANE0,p0);glClipPlane(GL_CLIP_PLANE0+5,p5);glEnable(GL_CLIP_PLANE0+5);}if(HAS(F_TWO)){double p[]={0,1,0,0};glClipPlane(GL_CLIP_PLANE0+4,p);glEnable(GL_CLIP_PLANE0+4);}if(HAS(F_FLIP))glScalef(-1,1,1);if(HAS(F_CULL)){glEnable(GL_CULL_FACE);glCullFace(GL_BACK);}if(HAS(F_NONLINEAR)||HAS(F_PROGRAMSIZE)||HAS(F_ALL))glEnable(GL_VERTEX_PROGRAM_POINT_SIZE);if(HAS(F_ALL)){glEnable(GL_VERTEX_PROGRAM_TWO_SIDE);glEnable(GL_COLOR_SUM);}
 if(HAS(F_LIGHT)){float ambient[]={0,0,0,1},diffuse[]={0,1,0,1},position[]={3,0,2,1},material[]={1,1,1,1};glEnable(GL_LIGHTING);glEnable(GL_LIGHT0);glShadeModel(GL_FLAT);glNormal3f(0,0,1);glLightModelfv(GL_LIGHT_MODEL_AMBIENT,ambient);glLightfv(GL_LIGHT0,GL_POSITION,position);glLightfv(GL_LIGHT0,GL_AMBIENT,ambient);glLightfv(GL_LIGHT0,GL_DIFFUSE,diffuse);glLightf(GL_LIGHT0,GL_LINEAR_ATTENUATION,.2);glMaterialfv(GL_FRONT_AND_BACK,GL_DIFFUSE,material);}glPointSize(4);glLineWidth(3);
}
static void geometry(const Case* c,int green){float v[]={-.75,-.75,0,1,3,0,0,1,-.75,.75,0,1};if(HAS(F_CORNER)){v[5]=-.75;v[9]=3;}if(HAS(F_NEAR)||HAS(F_FAR)){v[4]=.75;v[2]=v[10]=HAS(F_NEAR)?-.5:.5;v[6]=HAS(F_NEAR)?-3:3;}if(HAS(F_INSIDE))v[4]=.75;if(HAS(F_CROSSW))v[3]=-1;
 for(int i=0;i<3;i++){if(HAS(F_TOP)){float t=v[i*4];v[i*4]=v[i*4+1];v[i*4+1]=t;}if(c->factor)v[i*4+2]=v[i*4]*.2;if(HAS(F_HOMOGENEOUS))for(int k=0;k<4;k++)v[i*4+k]*=2;}
 if(HAS(F_PROVOKINGOUT)){float last[4];memcpy(last,v+8,16);memmove(v+4,v,32);memcpy(v,last,16);}
 glColor4f(0,green?1:0,green?0:1,1);
 if(HAS(F_INDEXED)){float data[24]={0};const int at[]={5,1,3};for(int i=0;i<3;i++)memcpy(data+at[i]*4,v+i*4,16);unsigned short indices[]={5,1,3};glBindBuffer(GL_ARRAY_BUFFER,0);glEnableClientState(GL_VERTEX_ARRAY);glVertexPointer(4,GL_FLOAT,16,data);glDrawElements(GL_TRIANGLES,3,GL_UNSIGNED_SHORT,indices);glDisableClientState(GL_VERTEX_ARRAY);}
 else if(HAS(F_VBO)){GLuint b;glGenBuffers(1,&b);glBindBuffer(GL_ARRAY_BUFFER,b);glBufferData(GL_ARRAY_BUFFER,sizeof(v),v,GL_STATIC_DRAW);glEnableClientState(GL_VERTEX_ARRAY);glVertexPointer(4,GL_FLOAT,16,(void*)0);glDrawArrays(GL_TRIANGLES,0,3);glDisableClientState(GL_VERTEX_ARRAY);glBindBuffer(GL_ARRAY_BUFFER,0);glDeleteBuffers(1,&b);}
 else{glBegin(GL_TRIANGLES);for(int i=0;i<3;i++){if(HAS(F_EDGES))glEdgeFlag(i!=1);glVertex4fv(v+i*4);}glEnd();glEdgeFlag(GL_TRUE);}}
/* Native user planes 1/65536 inside the view volume force intersections
 * without the guard-band fast path (the inset is 1/8192 pixel here). No software clipper
 * supplies the expected vertices, colors, sizes, or coverage. */
static void strictPlanes(const Case* c){
 const double edge=1.0-1.0/65536.0;
 if(HAS(F_USER)&&!HAS(F_NONINVARIANT))return;
 if(HAS(F_NONINVARIANT))for(int i=0;i<6;i++)glDisable(GL_CLIP_PLANE0+i);
 glMatrixMode(GL_MODELVIEW);glPushMatrix();glLoadIdentity();
 if(HAS(F_CROSSW)){double planes[6][4]={{1,0,0,edge},{-1,0,0,edge},{0,1,0,edge},{0,-1,0,edge},{0,0,1,edge},{0,0,-1,edge}};for(int i=0;i<6;i++){glClipPlane(GL_CLIP_PLANE0+i,planes[i]);glEnable(GL_CLIP_PLANE0+i);}}
 else if(HAS(F_NEAR)||HAS(F_FAR)){double p[]={0,0,HAS(F_NEAR)?1:-1,edge};glClipPlane(GL_CLIP_PLANE0+3,p);glEnable(GL_CLIP_PLANE0+3);}
 else if(!HAS(F_INSIDE)){if(!HAS(F_TOP)){double p[]={HAS(F_FLIP)?1:-1,0,0,edge};glClipPlane(GL_CLIP_PLANE0+1,p);glEnable(GL_CLIP_PLANE0+1);}if(HAS(F_TOP)||HAS(F_CORNER)){double p[]={0,-1,0,edge};glClipPlane(GL_CLIP_PLANE0+2,p);glEnable(GL_CLIP_PLANE0+2);}}
 glPopMatrix();
}
static void draw(const Case* c){glClearColor(0,0,0,1);glClearDepth(1);glClear(GL_COLOR_BUFFER_BIT|GL_DEPTH_BUFFER_BIT);if(HAS(F_OFFSET)||c->factor){glEnable(GL_DEPTH_TEST);glDepthFunc(GL_LEQUAL);glPolygonMode(GL_FRONT_AND_BACK,GL_FILL);geometry(c,0);glEnable(GL_POLYGON_OFFSET_LINE);glPolygonOffset(c->factor,c->units);}glPolygonMode(GL_FRONT_AND_BACK,HAS(F_POINT)?GL_POINT:GL_LINE);if(HAS(F_MIXED))glPolygonMode(GL_FRONT,GL_FILL);geometry(c,1);}
int main(void){CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};CGLPixelFormatObj pf;CGLContextObj ctx;GLint n;if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2;CGLSetCurrentContext(ctx);GLuint f,r,d;glGenFramebuffersEXT(1,&f);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,f);glGenRenderbuffersEXT(1,&r);glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,r);glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_RGBA8,16,16);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_RENDERBUFFER_EXT,r);glGenRenderbuffersEXT(1,&d);glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,d);glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_DEPTH24_STENCIL8,16,16);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_DEPTH_ATTACHMENT_EXT,GL_RENDERBUFFER_EXT,d);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_STENCIL_ATTACHMENT_EXT,GL_RENDERBUFFER_EXT,d);glViewport(0,0,16,16);
 printf("{\"renderer\":\"%s\",\"clipInset\":%.17g,\"cases\":[",glGetString(GL_RENDERER),1.0/65536.0);for(unsigned i=0;i<sizeof(cases)/sizeof(cases[0]);i++){const Case* c=&cases[i];setup(c,0);draw(c);unsigned char pixels[1024];glReadPixels(0,0,16,16,GL_RGBA,GL_UNSIGNED_BYTE,pixels);printf("%s{\"name\":\"%s\",\"pixels\":[",i?",":"",c->name);for(int p=0;p<1024;p++)printf("%s%u",p?",":"",pixels[p]);printf("]");GLenum error=glGetError();setup(c,1);strictPlanes(c);draw(c);glReadPixels(0,0,16,16,GL_RGBA,GL_UNSIGNED_BYTE,pixels);printf(",\"strictPixels\":[");for(int p=0;p<1024;p++)printf("%s%u",p?",":"",pixels[p]);printf("],\"error\":%u,\"strictError\":%u}",error,glGetError());}printf("]}\n");fflush(stdout);glFinish();releasePrograms();glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,0);glDeleteFramebuffersEXT(1,&f);glDeleteRenderbuffersEXT(1,&r);glDeleteRenderbuffersEXT(1,&d);glFinish();CGLSetCurrentContext(NULL);CGLDestroyContext(ctx);CGLDestroyPixelFormat(pf);return 0;}
