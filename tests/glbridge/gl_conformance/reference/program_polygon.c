#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
#include <string.h>
typedef struct {const char* name;int flip,front,back,cull,facing,flat,twoSide,cw,matrix,stage,arrays,offset;float units,factor;int slope,reverse;float scale;int clipW,quad,blend;} Case;
/* Scene parameters mirror gl_program_polygon_cases.js. */
static const Case cases[]={
{"glsl_back_fill",1,6913,6914,0,0,0,0,0,0,0,0,0,0,0,0,0,1.0,0,0,0},
{"glsl_front_line",0,6913,6914,0,0,0,0,0,0,0,0,0,0,0,0,0,1.0,0,0,0},
{"glsl_back_line",1,6914,6913,0,0,0,0,0,0,0,0,0,0,0,0,0,1.0,0,0,0},
{"glsl_cull_back",1,6913,6913,1029,0,0,0,0,0,0,0,0,0,0,0,0,1.0,0,0,0},
{"glsl_cull_front",1,6913,6913,1028,0,0,0,0,0,0,0,0,0,0,0,0,1.0,0,0,0},
{"glsl_facing_line",1,6913,6913,0,1,0,0,0,0,0,0,0,0,0,0,0,1.0,0,0,0},
{"glsl_facing_point",1,6912,6912,0,1,0,0,0,0,0,0,0,0,0,0,0,1.0,0,0,0},
{"glsl_flat_global",1,6913,6913,0,0,1,0,0,0,0,0,0,0,0,0,0,1.0,0,0,0},
{"glsl_front_cw",1,6913,6914,0,0,0,0,1,0,0,0,0,0,0,0,0,1.0,0,0,0},
{"glsl_back_color",1,6913,6913,0,0,0,1,0,0,0,0,0,0,0,0,0,1.0,0,0,0},
{"glsl_matrix2",1,6913,6914,0,0,0,0,0,2,0,0,0,0,0,0,0,1.0,0,0,0},
{"glsl_matrix3",1,6913,6914,0,0,0,0,0,3,0,0,0,0,0,0,0,1.0,0,0,0},
{"glsl_matrix4",1,6913,6914,0,0,0,0,0,4,0,0,0,0,0,0,0,1.0,0,0,0},
{"glsl_indexed",1,6913,6914,0,0,0,0,0,0,0,1,0,0,0,0,0,1.0,0,0,0},
{"glsl_vbo",1,6913,6914,0,0,0,0,0,0,0,2,0,0,0,0,0,1.0,0,0,0},
{"glsl_offset_positive",1,6913,6913,0,0,0,0,0,0,0,0,1,16,0,0,0,1.0,0,0,0},
{"glsl_offset_negative",1,6913,6913,0,0,0,0,0,0,0,0,1,-16,0,0,0,1.0,0,0,0},
{"glsl_offset_slope",1,6913,6913,0,0,0,0,0,0,0,0,1,0,1,1,0,1.0,0,0,0},
{"glsl_offset_reversed",1,6913,6913,0,0,0,0,0,0,0,0,1,16,0,0,1,1.0,0,0,0},
{"glsl_homogeneous_large",1,6913,6914,0,0,0,0,0,0,0,0,0,0,0,0,0,1e+20,0,0,0},
{"glsl_homogeneous_small",1,6913,6914,0,0,0,0,0,0,0,0,0,0,0,0,0,1e-20,0,0,0},
{"glsl_clip_w",1,6913,6914,0,0,0,0,0,0,0,0,0,0,0,0,0,1.0,1,0,0},
{"glsl_quad",1,6913,6913,0,0,0,0,0,0,0,0,0,0,0,0,0,1.0,0,1,0},
{"glsl_blend_order",0,6914,6913,0,0,0,0,0,0,0,0,0,0,0,0,0,1.0,0,0,1},
{"fragment_only",1,6913,6913,0,1,0,0,0,0,2,0,0,0,0,0,0,1.0,0,0,0},
{"vertex_only",1,6913,6914,0,0,0,0,0,0,3,0,0,0,0,0,0,1.0,0,0,0},
{"arb_back_fill",1,6913,6914,0,0,0,0,0,0,1,0,0,0,0,0,0,1.0,0,0,0},
{"arb_back_line",1,6914,6913,0,0,0,0,0,0,1,0,0,0,0,0,0,1.0,0,0,0},
{"arb_back_point",1,6912,6912,0,0,0,0,0,0,1,0,0,0,0,0,0,1.0,0,0,0},
{"arb_cull_back",1,6913,6913,1029,0,0,0,0,0,1,0,0,0,0,0,0,1.0,0,0,0},
{"arb_flat",1,6913,6913,0,0,1,0,0,0,1,0,0,0,0,0,0,1.0,0,0,0},
{"arb_offset_negative",1,6913,6913,0,0,0,0,0,0,1,0,1,-16,0,0,0,1.0,0,0,0}
};
static GLuint program(const Case* c){
 if(c->stage==1){GLuint p;glGenProgramsARB(1,&p);glBindProgramARB(GL_VERTEX_PROGRAM_ARB,p);char source[1024];snprintf(source,sizeof(source),"!!ARBvp1.0\nMUL result.position,vertex.position,{%d,1,1,1};%sEND",c->flip?-1:1,c->flat?"MAD result.color,vertex.position,{0.0,.25,0.0,0.0},{.3,.5,0.0,1.0};":"MOV result.color,vertex.color;");glProgramStringARB(GL_VERTEX_PROGRAM_ARB,GL_PROGRAM_FORMAT_ASCII_ARB,(GLsizei)strlen(source),source);glEnable(GL_VERTEX_PROGRAM_ARB);return 0;}
 char vs[4096],decl[128]="",position[256]="gl_Vertex",flip[128]="",scale[128]="";
 if(c->matrix){snprintf(decl,sizeof(decl),"attribute mat%d basis;",c->matrix);snprintf(position,sizeof(position),c->matrix==4?"basis*gl_Vertex":c->matrix==3?"vec4(basis*gl_Vertex.xyz,gl_Vertex.w)":"vec4(basis*gl_Vertex.xy,gl_Vertex.zw)");}
 if(c->blend)strcpy(flip,"gl_Position.x*=gl_Normal.x;");else if(c->flip&&!c->matrix)strcpy(flip,"gl_Position.x=-gl_Position.x;");if(c->scale!=1)snprintf(scale,sizeof(scale),"gl_Position*=%.9g;",c->scale);
 snprintf(vs,sizeof(vs),"#version 120\n%s%svoid main(){gl_Position=%s;%s%s%s%s}",decl,c->flat?"float info=.1;":"",position,flip,c->slope?"gl_Position.z=gl_Vertex.x*.5;":"",scale,c->flat?"info+=.2;gl_FrontColor=vec4(info,gl_Vertex.x*.25+.5,0.0,1.0);":c->twoSide?"gl_FrontColor=vec4(1.0,0.0,0.0,1.0);gl_BackColor=vec4(0.0,1.0,0.0,1.0);":"gl_FrontColor=gl_Color;");
 const char* fs=c->facing?"#version 120\nvoid main(){gl_FragColor=gl_FrontFacing?vec4(1,0,0,1):vec4(0,1,0,1);}":"#version 120\nvoid main(){gl_FragColor=gl_Color;}";
 GLuint p=glCreateProgram();const char* sources[]={vs,fs};for(int i=0;i<2;i++){if((c->stage==2&&!i)||(c->stage==3&&i))continue;GLuint s=glCreateShader(i?GL_FRAGMENT_SHADER:GL_VERTEX_SHADER);glShaderSource(s,1,&sources[i],NULL);glCompileShader(s);GLint ok;glGetShaderiv(s,GL_COMPILE_STATUS,&ok);if(!ok){char log[2048];glGetShaderInfoLog(s,2048,NULL,log);fprintf(stderr,"%s: %s\n",c->name,log);}glAttachShader(p,s);}if(c->matrix){glBindAttribLocation(p,8,"basis");for(int column=0;column<c->matrix;column++){float v[4]={0,0,0,0};v[column]=column?1:-1;glVertexAttrib4fv(8+column,v);}}glLinkProgram(p);glUseProgram(p);return p;
}
static int verts(const Case* c,float out[16]){const float triangle[]={-.4375,-.4375,0,1,.5625,-.4375,0,1,.0625,.5625,0,1},quad[]={-.4375,-.4375,0,1,.5625,-.4375,0,1,.5625,.5625,0,1,-.4375,.5625,0,1};int count=c->quad?4:3;memcpy(out,c->quad?quad:triangle,(size_t)count*16);if(c->clipW)out[3]=-1;return count;}
static void geometry(const Case* c,int explicitMode,float red,float green,float blue){float v[16];int count=verts(c,v);glColor4f(red,green,blue,1);
 if(c->arrays){float data[24]={0};unsigned short indices[]={5,1,3};if(c->arrays==1){for(int i=0;i<3;i++)memcpy(data+indices[i]*4,v+i*4,16);}else memcpy(data,v,48);GLuint b=0;if(c->arrays==2){glGenBuffers(1,&b);glBindBuffer(GL_ARRAY_BUFFER,b);glBufferData(GL_ARRAY_BUFFER,48,data,GL_STATIC_DRAW);}glVertexPointer(4,GL_FLOAT,16,b?NULL:data);glEnableClientState(GL_VERTEX_ARRAY);if(c->arrays==1)glDrawElements(GL_TRIANGLES,3,GL_UNSIGNED_SHORT,indices);else glDrawArrays(GL_TRIANGLES,0,3);glDisableClientState(GL_VERTEX_ARRAY);if(b){glBindBuffer(GL_ARRAY_BUFFER,0);glDeleteBuffers(1,&b);}return;}
 if(!c->blend){glBegin(c->quad?GL_QUADS:GL_TRIANGLES);for(int i=0;i<count;i++)glVertex4fv(v+i*4);glEnd();return;}
 if(!explicitMode)glBegin(GL_TRIANGLES);for(int primitive=0;primitive<3;primitive++){if(explicitMode){int back=(primitive==1)!=c->cw;glPolygonMode(GL_FRONT_AND_BACK,back?c->back:c->front);glBegin(GL_TRIANGLES);}glNormal3f(primitive==1?-1:1,0,1);glColor4f(primitive==0,primitive==1,primitive==2,.5);for(int i=0;i<count;i++)glVertex4fv(v+i*4);if(explicitMode)glEnd();}if(!explicitMode)glEnd();
}
static void modes(const Case* c,int explicitMode){if(explicitMode)glPolygonMode(GL_FRONT_AND_BACK,(c->flip!=c->cw)?c->back:c->front);else{glPolygonMode(GL_FRONT,c->front);glPolygonMode(GL_BACK,c->back);}}
static void draw(const Case* c,int explicitMode){glDisable(GL_BLEND);glDisable(GL_DEPTH_TEST);glDisable(GL_POLYGON_OFFSET_LINE);glDisable(GL_POLYGON_OFFSET_POINT);glClearColor(0,0,0,1);glClearDepth(1);glClear(GL_COLOR_BUFFER_BIT|GL_DEPTH_BUFFER_BIT);modes(c,explicitMode);
 if(c->offset){glEnable(GL_DEPTH_TEST);glDepthFunc(GL_LEQUAL);glPolygonMode(GL_FRONT_AND_BACK,GL_FILL);geometry(c,0,0,0,1);modes(c,explicitMode);glEnable(GL_POLYGON_OFFSET_LINE);glEnable(GL_POLYGON_OFFSET_POINT);glPolygonOffset(c->factor,c->units);}if(c->blend){glEnable(GL_BLEND);glBlendFunc(GL_SRC_ALPHA,GL_ONE_MINUS_SRC_ALPHA);}geometry(c,explicitMode,1,0,0);
}
static void probes(void){const int xy[]={8,7,8,4,11,4};printf("[");for(int i=0;i<3;i++){unsigned char v[4];glReadPixels(xy[i*2],xy[i*2+1],1,1,GL_RGBA,GL_UNSIGNED_BYTE,v);printf("%s[%u,%u,%u,%u]",i?",":"",v[0],v[1],v[2],v[3]);}printf("]");}
int main(void){CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};CGLPixelFormatObj pf;CGLContextObj ctx;GLint n;if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2;CGLSetCurrentContext(ctx);GLuint f,r,d;glGenFramebuffersEXT(1,&f);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,f);glGenRenderbuffersEXT(1,&r);glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,r);glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_RGBA8,16,16);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_RENDERBUFFER_EXT,r);glGenRenderbuffersEXT(1,&d);glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,d);glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_DEPTH24_STENCIL8,16,16);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_DEPTH_ATTACHMENT_EXT,GL_RENDERBUFFER_EXT,d);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_STENCIL_ATTACHMENT_EXT,GL_RENDERBUFFER_EXT,d);glViewport(0,0,16,16);
 printf("{\"renderer\":\"%s\",\"cases\":[",glGetString(GL_RENDERER));for(unsigned i=0;i<sizeof(cases)/sizeof(cases[0]);i++){const Case* c=&cases[i];glUseProgram(0);glDisable(GL_VERTEX_PROGRAM_ARB);glDisable(GL_VERTEX_PROGRAM_TWO_SIDE);glDisable(GL_CULL_FACE);glFrontFace(c->cw?GL_CW:GL_CCW);glMatrixMode(GL_MODELVIEW);glLoadIdentity();glDepthRange(c->reverse?1:0,c->reverse?0:1);program(c);if(c->stage==2&&c->flip)glScalef(-1,1,1);glShadeModel(c->flat?GL_FLAT:GL_SMOOTH);if(c->twoSide)glEnable(GL_VERTEX_PROGRAM_TWO_SIDE);if(c->cull){glEnable(GL_CULL_FACE);glCullFace(c->cull);}draw(c,0);printf("%s{\"name\":\"%s\",\"direct\":",i?",":"",c->name);probes();draw(c,1);printf(",\"rgba\":");probes();printf(",\"error\":%u}",glGetError());}printf("]}\n");CGLSetCurrentContext(NULL);CGLDestroyContext(ctx);CGLDestroyPixelFormat(pf);return 0;}
