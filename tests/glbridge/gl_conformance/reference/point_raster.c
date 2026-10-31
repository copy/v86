#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
#include <string.h>
typedef struct {const char* name;float size,x,y,z;int glsl,attributes,matrix,programSize,disabledSize,indexed,polygon,fragmentOnly,arb,sprite,minimum;} Case;
/* Scene parameters mirror gl_point_raster_cases.js. */
static const Case cases[]={
{"fixed_even",4,0,0,0,0,0,0,0,0,0,0,0,0,0,0},
{"fixed_odd",3.2,0,0,0,0,0,0,0,0,0,0,0,0,0,0},
{"fixed_fractional",3.6,0,0,0,0,0,0,0,0,0,0,0,0,0,0},
{"fixed_centre",4,0.11,-0.08,0,0,0,0,0,0,0,0,0,0,0,0},
{"fixed_clipped",8,1.125,0,0,0,0,0,0,0,0,0,0,0,0,0},
{"fixed_depth_clipped",8,0,0,1.125,0,0,0,0,0,0,0,0,0,0,0},
{"fixed_indexed",4,0,0,0,0,0,0,0,0,1,0,0,0,0,0},
{"glsl_all_attributes",4,0,0,0,1,1,0,0,0,0,0,0,0,0,0},
{"glsl_matrix",4,0,0,0,1,0,1,0,0,0,0,0,0,0,0},
{"glsl_size",2,0,0,0,1,0,0,6,0,0,0,0,0,0,0},
{"glsl_size_disabled",4,0,0,0,1,0,0,8,1,0,0,0,0,0,0},
{"glsl_indexed",4,0,0,0,1,0,0,0,0,1,0,0,0,0,0},
{"glsl_polygon",4,0,0,0,1,0,0,0,0,0,1,0,0,0,0},
{"glsl_clipped",8,1.125,0,0,1,0,0,0,0,0,0,0,0,0,0},
{"fragment_only",4,0,0,0,1,0,0,0,0,0,0,1,0,0,0},
{"arb_size",4,0,0,0,0,0,0,0,0,0,0,0,1,0,0},
{"arb_program_size",2,0,0,0,0,0,0,6,0,0,0,0,1,0,0},
{"arb_size_disabled",4,0,0,0,0,0,0,8,1,0,0,0,1,0,0},
{"arb_indexed",4,0,0,0,0,0,0,0,0,1,0,0,1,0,0},
{"arb_polygon",4,0,0,0,0,0,0,0,0,0,1,0,1,0,0},
{"arb_clipped",8,1.125,0,0,0,0,0,0,0,0,0,0,1,0,0},
{"fixed_sprite",4.4,0.08,-0.08,0,0,0,0,0,0,0,0,0,0,1,0},
{"glsl_sprite",4.4,0.08,-0.08,0,1,0,0,0,0,0,0,0,0,1,0},
{"arb_sprite",4.4,0.08,-0.08,0,0,0,0,0,0,0,0,0,1,1,0},
{"fixed_minimum",4,0,0,0,0,0,0,0,0,0,0,0,0,0,1},
{"glsl_minimum",4,0,0,0,1,0,0,0,0,0,0,0,0,0,1},
{"glsl_program_minimum",4,0,0,0,1,0,0,6,0,0,0,0,0,0,1},
{"arb_program_minimum",4,0,0,0,0,0,0,6,0,0,0,0,1,0,1}
};
static GLuint shader(GLenum type,const char* source){GLuint s=glCreateShader(type);glShaderSource(s,1,&source,NULL);glCompileShader(s);GLint ok;glGetShaderiv(s,GL_COMPILE_STATUS,&ok);if(!ok){char log[8192];glGetShaderInfoLog(s,sizeof(log),NULL,log);fprintf(stderr,"%s\n",log);}return s;}
static void setup(const Case* c){
 glUseProgram(0);glDisable(GL_VERTEX_PROGRAM_ARB);glDisable(GL_VERTEX_PROGRAM_POINT_SIZE);glDisable(GL_POINT_SPRITE);glPointParameterf(GL_POINT_SIZE_MIN,0);glPolygonMode(GL_FRONT_AND_BACK,c->polygon?GL_POINT:GL_FILL);
 if(c->glsl){char vs[8192]="#version 120\n",sum[1024]="",temp[256];
 if(c->attributes)for(int i=1;i<16;i++){sprintf(temp,"attribute vec4 a%d;",i);strcat(vs,temp);sprintf(temp,"%sa%d",i==1?"":"+",i);strcat(sum,temp);}
 if(c->matrix)strcat(vs,"attribute mat4 basis;");strcat(vs,"void main(){gl_Position=gl_Vertex;gl_FrontColor=");
 if(c->attributes){strcat(vs,"(");strcat(vs,sum);strcat(vs,")/15.0;");}else strcat(vs,c->matrix?"basis[3];":"gl_Color;");
 if(c->programSize){sprintf(temp,"gl_PointSize=%d.0;",c->programSize);strcat(vs,temp);}strcat(vs,"}");
 GLuint p=glCreateProgram();if(!c->fragmentOnly)glAttachShader(p,shader(GL_VERTEX_SHADER,vs));glAttachShader(p,shader(GL_FRAGMENT_SHADER,"#version 120\nvoid main(){gl_FragColor=gl_Color;}"));
 if(c->attributes)for(int i=1;i<16;i++){sprintf(temp,"a%d",i);glBindAttribLocation(p,i,temp);glVertexAttrib4f(i,0,1,0,1);}
 if(c->matrix){glBindAttribLocation(p,4,"basis");for(int i=4;i<8;i++)glVertexAttrib4f(i,0,1,0,1);}glLinkProgram(p);glUseProgram(p);}
 if(c->arb){char source[1024]="!!ARBvp1.0\nMOV result.position,vertex.position;MOV result.color,vertex.color;",temp[128];
 if(c->programSize){sprintf(temp,"MOV result.pointsize,{%d,0,0,1};",c->programSize);strcat(source,temp);}strcat(source,"END");GLuint p;glGenProgramsARB(1,&p);glBindProgramARB(GL_VERTEX_PROGRAM_ARB,p);glProgramStringARB(GL_VERTEX_PROGRAM_ARB,GL_PROGRAM_FORMAT_ASCII_ARB,strlen(source),source);glEnable(GL_VERTEX_PROGRAM_ARB);}
 if(c->programSize&&!c->disabledSize)glEnable(GL_VERTEX_PROGRAM_POINT_SIZE);if(c->sprite)glEnable(GL_POINT_SPRITE);if(c->minimum)glPointParameterf(GL_POINT_SIZE_MIN,10);glPointSize(c->size);
}
static void draw(const Case* c){glClearColor(0,0,0,1);glClear(GL_COLOR_BUFFER_BIT);glColor4f(0,1,0,1);
 if(c->indexed){float v[]={0,0,0,1,.5,0,0,1,0,0,0,1,-.5,0,0,1};unsigned short indices[]={3,1};glEnableClientState(GL_VERTEX_ARRAY);glVertexPointer(4,GL_FLOAT,16,v);glDrawElements(GL_POINTS,2,GL_UNSIGNED_SHORT,indices);glDisableClientState(GL_VERTEX_ARRAY);}
 else{glBegin(c->polygon?GL_TRIANGLES:GL_POINTS);if(c->polygon){glVertex4f(-.5,-.5,0,1);glVertex4f(.5,-.5,0,1);glVertex4f(0,.5,0,1);}else glVertex4f(c->x,c->y,c->z,1);glEnd();}}
int main(void){CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};CGLPixelFormatObj pf;CGLContextObj ctx;GLint n;if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2;CGLSetCurrentContext(ctx);GLuint f,r;glGenFramebuffersEXT(1,&f);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,f);glGenRenderbuffersEXT(1,&r);glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,r);glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_RGBA8,16,16);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_RENDERBUFFER_EXT,r);glViewport(0,0,16,16);
 printf("{\"renderer\":\"%s\",\"cases\":[",glGetString(GL_RENDERER));for(unsigned i=0;i<sizeof(cases)/sizeof(cases[0]);i++){const Case* c=&cases[i];setup(c);draw(c);unsigned char pixels[1024];glReadPixels(0,0,16,16,GL_RGBA,GL_UNSIGNED_BYTE,pixels);printf("%s{\"name\":\"%s\",\"rows\":[",i?",":"",c->name);for(int y=0;y<16;y++){unsigned mask=0;for(int x=0;x<16;x++)if(pixels[(y*16+x)*4+1]>128)mask|=1u<<x;printf("%s%u",y?",":"",mask);}printf("],\"error\":%u}",glGetError());}printf("]}\n");CGLSetCurrentContext(NULL);CGLDestroyContext(ctx);CGLDestroyPixelFormat(pf);return 0;}
