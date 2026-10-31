#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
#include <string.h>
static void draw(void){glBegin(GL_TRIANGLES);glTexCoord4f(0,0,.5,1);glVertex2f(-1,-1);glTexCoord4f(6,0,.5,1);glVertex2f(3,-1);glTexCoord4f(0,4,.5,1);glVertex2f(-1,3);glEnd();}
static const GLubyte image[]={255,0,0,255,0,255,0,255,0,0,255,255,128,128,0,255,0,128,128,255,128,0,128,255};
static GLuint glsl(const char* fragment){const char* vertex="#version 120\nvoid main(){gl_Position=gl_Vertex;gl_TexCoord[0]=gl_MultiTexCoord0;}";GLuint p=glCreateProgram();for(int i=0;i<2;i++){GLuint s=glCreateShader(i?GL_FRAGMENT_SHADER:GL_VERTEX_SHADER);const GLchar* source=i?fragment:vertex;glShaderSource(s,1,&source,NULL);glCompileShader(s);GLint ok;glGetShaderiv(s,GL_COMPILE_STATUS,&ok);if(!ok)return 0;glAttachShader(p,s);}glLinkProgram(p);GLint ok;glGetProgramiv(p,GL_LINK_STATUS,&ok);return ok?p:0;}
static void arb(const char* source){GLuint p;glGenProgramsARB(1,&p);glBindProgramARB(GL_FRAGMENT_PROGRAM_ARB,p);glProgramStringARB(GL_FRAGMENT_PROGRAM_ARB,GL_PROGRAM_FORMAT_ASCII_ARB,(GLsizei)strlen(source),source);glEnable(GL_FRAGMENT_PROGRAM_ARB);}
static void state(void){GLint defaults[6];glBindTexture(GL_TEXTURE_RECTANGLE_ARB,101);glGetTexParameteriv(GL_TEXTURE_RECTANGLE_ARB,GL_TEXTURE_MIN_FILTER,&defaults[0]);glGetTexParameteriv(GL_TEXTURE_RECTANGLE_ARB,GL_TEXTURE_WRAP_S,&defaults[1]);glGetTexParameteriv(GL_TEXTURE_RECTANGLE_ARB,GL_TEXTURE_WRAP_T,&defaults[2]);glGetTexParameteriv(GL_TEXTURE_RECTANGLE_ARB,GL_TEXTURE_WRAP_R,&defaults[3]);glGetTexParameteriv(GL_TEXTURE_RECTANGLE_ARB,GL_TEXTURE_BASE_LEVEL,&defaults[4]);glGetIntegerv(GL_TEXTURE_BINDING_RECTANGLE_ARB,&defaults[5]);printf("{\"defaults\":[");for(int i=0;i<6;i++)printf("%s%d",i?",":"",defaults[i]);printf("],\"errors\":[");
 for(int i=0;i<16;i++){GLint n=0;GLubyte data[256]={0};switch(i){
 case 0:glTexParameteri(GL_TEXTURE_RECTANGLE_ARB,GL_TEXTURE_MIN_FILTER,GL_LINEAR_MIPMAP_LINEAR);break;
 case 1:case 2:case 3:glTexParameteri(GL_TEXTURE_RECTANGLE_ARB,i==1?GL_TEXTURE_WRAP_S:i==2?GL_TEXTURE_WRAP_T:GL_TEXTURE_WRAP_R,GL_REPEAT);break;
 case 4:glTexParameteri(GL_TEXTURE_RECTANGLE_ARB,GL_TEXTURE_BASE_LEVEL,1);break;
 case 5:glTexImage2D(GL_TEXTURE_RECTANGLE_ARB,1,GL_RGBA8,1,1,0,GL_RGBA,GL_UNSIGNED_BYTE,data);break;
 case 6:glTexImage2D(GL_TEXTURE_RECTANGLE_ARB,0,GL_RGBA8,3,3,1,GL_RGBA,GL_UNSIGNED_BYTE,data);break;
 case 7:glCompressedTexImage2DARB(GL_TEXTURE_RECTANGLE_ARB,0,GL_COMPRESSED_RGBA_S3TC_DXT1_EXT,4,4,0,8,data);break;
 case 8:glTexImage2D(GL_TEXTURE_RECTANGLE_ARB,0,GL_RGBA8,1,1,0,GL_COLOR_INDEX,GL_UNSIGNED_BYTE,data);break;
 case 9:glTexImage2D(GL_TEXTURE_RECTANGLE_ARB,0,GL_RGBA8,-1,1,0,GL_RGBA,GL_UNSIGNED_BYTE,data);break;
 case 10:glCopyTexImage2D(GL_TEXTURE_RECTANGLE_ARB,1,GL_RGBA8,0,0,1,1,0);break;
 case 11:glTexSubImage2D(GL_TEXTURE_RECTANGLE_ARB,1,0,0,1,1,GL_RGBA,GL_UNSIGNED_BYTE,data);break;
 case 12:glGenerateMipmapEXT(GL_TEXTURE_RECTANGLE_ARB);break;
 case 13:glGetTexImage(GL_TEXTURE_RECTANGLE_ARB,1,GL_RGBA,GL_UNSIGNED_BYTE,data);break;
 case 14:glGetTexLevelParameteriv(GL_TEXTURE_RECTANGLE_ARB,1,GL_TEXTURE_WIDTH,&n);break;
 case 15:glBindTexture(GL_TEXTURE_2D,101);break;
 }printf("%s%u",i?",":"",glGetError());}printf("]}");}
int main(void){const char* names[]={"fixed_priority","arb_rect","glsl_rect","glsl_shadow_rect","arb_shadow_rect","default_object","copy_update","subimage","border","linear","fbo_image"};printf("{\"cases\":[");
 for(int c=0;c<11;c++){CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};CGLPixelFormatObj pf;CGLContextObj ctx;GLint n;if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,0,&ctx))return 2;CGLSetCurrentContext(ctx);GLuint f,r;glGenFramebuffersEXT(1,&f);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,f);glGenRenderbuffersEXT(1,&r);glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,r);glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_RGBA8,16,16);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_RENDERBUFFER_EXT,r);glViewport(0,0,16,16);glClearColor(0,0,0,0);glClear(GL_COLOR_BUFFER_BIT);
 glBindTexture(GL_TEXTURE_2D,2);GLubyte blue[]={0,0,255,255};glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,1,1,0,GL_RGBA,GL_UNSIGNED_BYTE,blue);glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,GL_NEAREST);glEnable(GL_TEXTURE_2D);
 glBindTexture(GL_TEXTURE_RECTANGLE_ARB,c==5?0:1);glTexImage2D(GL_TEXTURE_RECTANGLE_ARB,0,GL_RGBA8,3,2,0,GL_RGBA,GL_UNSIGNED_BYTE,image);glTexParameteri(GL_TEXTURE_RECTANGLE_ARB,GL_TEXTURE_MIN_FILTER,GL_NEAREST);glTexParameteri(GL_TEXTURE_RECTANGLE_ARB,GL_TEXTURE_MAG_FILTER,GL_NEAREST);glTexEnvi(GL_TEXTURE_ENV,GL_TEXTURE_ENV_MODE,GL_REPLACE);glEnable(GL_TEXTURE_RECTANGLE_ARB);
 if(c==3||c==4){GLfloat depth[]={.25,.25,.25,.75,.75,.75};glTexImage2D(GL_TEXTURE_RECTANGLE_ARB,0,GL_DEPTH_COMPONENT24,3,2,0,GL_DEPTH_COMPONENT,GL_FLOAT,depth);glTexParameteri(GL_TEXTURE_RECTANGLE_ARB,GL_TEXTURE_COMPARE_MODE,GL_COMPARE_R_TO_TEXTURE);glTexParameteri(GL_TEXTURE_RECTANGLE_ARB,GL_TEXTURE_COMPARE_FUNC,GL_LEQUAL);}
 if(c==1||c==4){glDisable(GL_TEXTURE_RECTANGLE_ARB);arb(c==4?"!!ARBfp1.0\nOPTION ARB_fragment_program_shadow;\nTEX result.color,fragment.texcoord[0],texture[0],SHADOWRECT;\nEND\n":"!!ARBfp1.0\nTEX result.color,fragment.texcoord[0],texture[0],RECT;\nEND\n");}
 if(c==2||c==3){glDisable(GL_TEXTURE_RECTANGLE_ARB);GLuint p=glsl(c==3?"#version 120\n#extension GL_ARB_texture_rectangle:require\nuniform sampler2DRectShadow image;void main(){gl_FragColor=shadow2DRect(image,gl_TexCoord[0].xyz);}":"#version 120\n#extension GL_ARB_texture_rectangle:require\nuniform sampler2DRect image;void main(){gl_FragColor=texture2DRect(image,gl_TexCoord[0].xy);}");if(!p)return 3;glUseProgram(p);}
 if(c==6){glClearColor(1,0,0,1);glClear(GL_COLOR_BUFFER_BIT);glCopyTexSubImage2D(GL_TEXTURE_RECTANGLE_ARB,0,0,0,0,0,3,2);glClearColor(0,0,0,0);glClear(GL_COLOR_BUFFER_BIT);}
 if(c==7){GLubyte white[]={255,255,255,255};glTexSubImage2D(GL_TEXTURE_RECTANGLE_ARB,0,1,1,1,1,GL_RGBA,GL_UNSIGNED_BYTE,white);}
 if(c==8){glTexParameteri(GL_TEXTURE_RECTANGLE_ARB,GL_TEXTURE_WRAP_S,GL_CLAMP_TO_BORDER);glTexParameterfv(GL_TEXTURE_RECTANGLE_ARB,GL_TEXTURE_BORDER_COLOR,(const GLfloat[]){0,1,0,1});glMatrixMode(GL_TEXTURE);glTranslatef(-4,0,0);glMatrixMode(GL_MODELVIEW);}
 if(c==9){GLubyte filtered[]={128,0,0,255,0,128,0,255,0,0,128,255,128,128,0,255,0,128,128,255,128,0,128,255};glTexImage2D(GL_TEXTURE_RECTANGLE_ARB,0,GL_RGBA8,3,2,0,GL_RGBA,GL_UNSIGNED_BYTE,filtered);glTexParameteri(GL_TEXTURE_RECTANGLE_ARB,GL_TEXTURE_MIN_FILTER,GL_LINEAR);glTexParameteri(GL_TEXTURE_RECTANGLE_ARB,GL_TEXTURE_MAG_FILTER,GL_LINEAR);glMatrixMode(GL_TEXTURE);glLoadIdentity();glTranslatef(1,1,0);glScalef(0,0,1);glMatrixMode(GL_MODELVIEW);}
 if(c==10){GLuint g;glGenFramebuffersEXT(1,&g);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,g);glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_TEXTURE_RECTANGLE_ARB,1,0);glClearColor(0,1,0,1);glClear(GL_COLOR_BUFFER_BIT);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,f);glClearColor(0,0,0,0);}
 draw();GLubyte pixels[1024];glReadPixels(0,0,16,16,GL_RGBA,GL_UNSIGNED_BYTE,pixels);printf("%s{\"name\":\"%s\",\"error\":%u,\"rgba\":\"",c?",":"",names[c],glGetError());for(int i=0;i<1024;i++)printf("%02x",pixels[i]);printf("\"}");if(c==10){printf("],\"state\":");state();}CGLSetCurrentContext(0);CGLDestroyContext(ctx);CGLDestroyPixelFormat(pf);}
 printf("}\n");return 0;}
