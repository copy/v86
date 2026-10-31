#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
#include <string.h>
typedef struct {const char* name;int width,vertical,diagonal,reverse,stipple,strip,loop,indexed,vbo,flat,crossW,arb,matrix,attributes,polygon;} Case;
/* Scene parameters mirror gl_program_line_cases.js. */
static const Case cases[]={
{"glsl_horizontal",4,0,0,0,0,0,0,0,0,0,0,0,0,0,0},
{"glsl_vertical",4,1,0,0,0,0,0,0,0,0,0,0,0,0,0},
{"glsl_diagonal",3,0,1,0,0,0,0,0,0,0,0,0,0,0,0},
{"glsl_reverse",4,0,0,1,0,0,0,0,0,0,0,0,0,0,0},
{"glsl_stipple",1,0,0,0,1,0,0,0,0,0,0,0,0,0,0},
{"glsl_wide_stipple",4,0,0,0,1,0,0,0,0,0,0,0,0,0,0},
{"glsl_strip",3,0,0,0,1,1,0,0,0,0,0,0,0,0,0},
{"glsl_loop",2,0,0,0,1,0,1,0,0,0,0,0,0,0,0},
{"glsl_indexed",4,0,0,0,0,0,0,1,0,0,0,0,0,0,0},
{"glsl_vbo",4,0,0,0,0,0,0,0,1,0,0,0,0,0,0},
{"glsl_flat",4,0,0,0,0,0,0,0,0,1,0,0,0,0,0},
{"glsl_cross_w",4,0,0,0,0,0,0,0,0,0,1,0,0,0,0},
{"arb_horizontal",4,0,0,0,0,0,0,0,0,0,0,1,0,0,0},
{"arb_stipple",4,0,0,0,1,0,0,0,0,0,0,1,0,0,0},
{"arb_strip",3,0,0,0,1,1,0,0,0,0,0,1,0,0,0},
{"arb_flat",4,0,0,0,0,0,0,0,0,1,0,1,0,0,0},
{"glsl_matrix",4,0,0,0,0,0,0,0,0,0,0,0,1,0,0},
{"glsl_attributes",4,0,0,0,0,0,0,0,0,0,0,0,0,1,0},
{"glsl_polygon",3,0,0,0,0,0,0,0,0,0,0,0,0,0,1},
{"glsl_polygon_stipple",3,0,0,0,1,0,0,0,0,0,0,0,0,0,1},
{"glsl_polygon_flat",3,0,0,0,0,0,0,0,0,1,0,0,0,0,1},
{"arb_polygon_stipple",3,0,0,0,1,0,0,0,0,0,0,1,0,0,1}
};
static GLuint shader(GLenum type,const char* source){GLuint s=glCreateShader(type);glShaderSource(s,1,&source,NULL);glCompileShader(s);return s;}
static void setup(const Case* c){glUseProgram(0);glPolygonMode(GL_FRONT_AND_BACK,c->polygon?GL_LINE:GL_FILL);glDisable(GL_VERTEX_PROGRAM_ARB);glDisable(GL_LINE_STIPPLE);glShadeModel(c->flat?GL_FLAT:GL_SMOOTH);glLineWidth(c->width);if(c->stipple){glEnable(GL_LINE_STIPPLE);glLineStipple(1,0x0F0F);}
 if(c->arb){char source[1024]="!!ARBvp1.0\nMUL result.position,vertex.position,{-1,1,1,1};";strcat(source,c->flat?"MAD result.color,vertex.position,{.25,.25,0,0},{.5,.5,0,1};END":"MOV result.color,vertex.color;END");GLuint p;glGenProgramsARB(1,&p);glBindProgramARB(GL_VERTEX_PROGRAM_ARB,p);glProgramStringARB(GL_VERTEX_PROGRAM_ARB,GL_PROGRAM_FORMAT_ASCII_ARB,strlen(source),source);glEnable(GL_VERTEX_PROGRAM_ARB);}
 else{char vs[8192]="#version 120\n",sum[1024]="",temp[256];
 if(c->matrix)strcat(vs,"attribute mat2 basis;");if(c->attributes)for(int i=1;i<16;i++){sprintf(temp,"attribute vec4 a%d;",i);strcat(vs,temp);sprintf(temp,"%sa%d",i==1?"":"+",i);strcat(sum,temp);}
 strcat(vs,"void main(){gl_Position=");strcat(vs,c->matrix?"vec4(basis*gl_Vertex.xy,gl_Vertex.zw);":"gl_Vertex;gl_Position.x=-gl_Position.x;");strcat(vs,"gl_FrontColor=");
 if(c->attributes){strcat(vs,"(");strcat(vs,sum);strcat(vs,")/15.0;}");}else strcat(vs,c->flat?"vec4(gl_Vertex.xy*.25+.5,0.0,1.0);}":"gl_Color;}");
 GLuint p=glCreateProgram();glAttachShader(p,shader(GL_VERTEX_SHADER,vs));glAttachShader(p,shader(GL_FRAGMENT_SHADER,"#version 120\nvoid main(){gl_FragColor=gl_Color;}"));
 if(c->matrix){glBindAttribLocation(p,8,"basis");glVertexAttrib4f(8,-1,0,0,1);glVertexAttrib4f(9,0,1,0,1);}if(c->attributes)for(int i=1;i<16;i++){sprintf(temp,"a%d",i);glBindAttribLocation(p,i,temp);glVertexAttrib4f(i,0,1,0,1);}glLinkProgram(p);glUseProgram(p);}}

static void draw(const Case* c,int explicitLoop){glClearColor(0,0,0,1);glClear(GL_COLOR_BUFFER_BIT);glColor4f(0,1,0,1);GLenum mode=c->polygon?(explicitLoop?GL_LINE_LOOP:GL_TRIANGLES):c->strip?GL_LINE_STRIP:c->loop?GL_LINE_LOOP:GL_LINES;float v[12]={-.4375,-.1875,0,1,.5625,-.1875,0,1,0,0,0,1};int count=2;
 if(c->strip||c->loop||c->polygon){float p[]={-.4375,-.4375,0,1,.3125,-.4375,0,1,.3125,.3125,0,1};memcpy(v,p,sizeof(p));count=3;}
 if(c->vertical){v[0]=v[4]=.0625;v[1]=-.4375;v[5]=.5625;}if(c->diagonal){v[1]=-.4375;v[5]=.0625;}if(c->crossW)v[3]=-1;if(c->reverse)for(int i=0;i<4;i++){float t=v[i];v[i]=v[4+i];v[4+i]=t;}
 if(c->indexed){float data[24]={0};memcpy(data+20,v,16);memcpy(data+4,v+4,16);unsigned short indices[]={5,1};glEnableClientState(GL_VERTEX_ARRAY);glVertexPointer(4,GL_FLOAT,16,data);glDrawElements(mode,2,GL_UNSIGNED_SHORT,indices);glDisableClientState(GL_VERTEX_ARRAY);}
 else{glBegin(mode);for(int i=0;i<count;i++)glVertex4fv(v+i*4);glEnd();}}
int main(void){CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};CGLPixelFormatObj pf;CGLContextObj ctx;GLint n;if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2;CGLSetCurrentContext(ctx);GLuint f,r;glGenFramebuffersEXT(1,&f);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,f);glGenRenderbuffersEXT(1,&r);glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,r);glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_RGBA8,16,16);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_RENDERBUFFER_EXT,r);glViewport(0,0,16,16);
 printf("{\"renderer\":\"%s\",\"cases\":[",glGetString(GL_RENDERER));for(unsigned i=0;i<sizeof(cases)/sizeof(cases[0]);i++){const Case* c=&cases[i];setup(c);draw(c,0);unsigned char pixels[1024];glReadPixels(0,0,16,16,GL_RGBA,GL_UNSIGNED_BYTE,pixels);printf("%s{\"name\":\"%s\",\"pixels\":[",i?",":"",c->name);for(int p=0;p<1024;p++)printf("%s%u",p?",":"",pixels[p]);printf("]");if(c->polygon&&c->stipple){draw(c,1);glReadPixels(0,0,16,16,GL_RGBA,GL_UNSIGNED_BYTE,pixels);printf(",\"loopPixels\":[");for(int p=0;p<1024;p++)printf("%s%u",p?",":"",pixels[p]);printf("]");}printf(",\"error\":%u}",glGetError());}printf("]}\n");CGLSetCurrentContext(NULL);CGLDestroyContext(ctx);CGLDestroyPixelFormat(pf);return 0;}
