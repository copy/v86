"use strict";
const fs=require("node:fs"),path=require("node:path"),manifest=require("../../arb_corpus/programs.json"),
 records=manifest.records,helper="!!ARBfp1.0\nMOV result.color,fragment.color;\nMOV result.color.w,1.0;\nEND\n",
 constant="!!ARBfp1.0\nMOV result.color,{0.25,0.5,0.75,1.0};\nEND\n";
const sources=records.map(c=>"{"+[c.name,c.stage,c.source,c.stage==="vertex"?(/result\.color/.test(c.source)?helper:constant):"",c.texture||"2D"].map(JSON.stringify).join(",")+"}").join(",\n"),
 setup=records.map((c,i)=>"case "+i+":"+c.locals.map(([index,value])=>"glProgramLocalParameter4fvARB("+(c.stage==="vertex"?"GL_VERTEX_PROGRAM_ARB":"GL_FRAGMENT_PROGRAM_ARB")+","+index+",(const GLfloat[]){"+value.map(v=>Number.isInteger(v)?v+".0f":Math.fround(v)+"f").join(",")+"});").join("")+"break;").join("\n");
const source=`// Generated from actual cgc output and the executed Wine 4.0 generator.
#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
#include <string.h>
static const char* cases[][5]={${sources}};
static void program(GLenum target,const char* source){GLuint p;glGenProgramsARB(1,&p);glBindProgramARB(target,p);glProgramStringARB(target,GL_PROGRAM_FORMAT_ASCII_ARB,(GLsizei)strlen(source),source);glEnable(target);}
int main(void){printf("{\\"cases\\":[");for(int scene=0;scene<${records.length};scene++){
 CGLPixelFormatAttribute a[]={kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};CGLPixelFormatObj pf;CGLContextObj ctx;GLint n;if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,0,&ctx))return 2;CGLSetCurrentContext(ctx);
 GLuint f,r;glGenFramebuffersEXT(1,&f);glBindFramebufferEXT(GL_FRAMEBUFFER_EXT,f);glGenRenderbuffersEXT(1,&r);glBindRenderbufferEXT(GL_RENDERBUFFER_EXT,r);glRenderbufferStorageEXT(GL_RENDERBUFFER_EXT,GL_RGBA8,16,16);glFramebufferRenderbufferEXT(GL_FRAMEBUFFER_EXT,GL_COLOR_ATTACHMENT0_EXT,GL_RENDERBUFFER_EXT,r);glViewport(0,0,16,16);glClearColor(0,0,0,0);glClear(GL_COLOR_BUFFER_BIT);
 int vertex=!strcmp(cases[scene][1],"vertex");GLenum stage=vertex?GL_VERTEX_PROGRAM_ARB:GL_FRAGMENT_PROGRAM_ARB;program(stage,cases[scene][2]);GLint position;glGetIntegerv(GL_PROGRAM_ERROR_POSITION_ARB,&position);GLenum compileError=glGetError();
 if(vertex)program(GL_FRAGMENT_PROGRAM_ARB,cases[scene][3]);
 switch(scene){${setup}}
 const char* kind=cases[scene][4];int depth=!strcmp(kind,"SHADOW2D");GLenum target=!strcmp(kind,"1D")?GL_TEXTURE_1D:!strcmp(kind,"3D")?GL_TEXTURE_3D:!strcmp(kind,"CUBE")?GL_TEXTURE_CUBE_MAP:!strcmp(kind,"RECT")?GL_TEXTURE_RECTANGLE_ARB:GL_TEXTURE_2D;
 GLubyte color[]={64,128,191,255};GLfloat d=.75;glBindTexture(target,1);glTexParameteri(target,GL_TEXTURE_MIN_FILTER,GL_NEAREST);glTexParameteri(target,GL_TEXTURE_MAG_FILTER,GL_NEAREST);
 if(depth){glTexParameteri(target,GL_TEXTURE_COMPARE_MODE,GL_COMPARE_R_TO_TEXTURE);glTexParameteri(target,GL_TEXTURE_COMPARE_FUNC,GL_LEQUAL);glTexImage2D(target,0,GL_DEPTH_COMPONENT24,1,1,0,GL_DEPTH_COMPONENT,GL_FLOAT,&d);}
 else if(target==GL_TEXTURE_1D)glTexImage1D(target,0,GL_RGBA8,1,0,GL_RGBA,GL_UNSIGNED_BYTE,color);
 else if(target==GL_TEXTURE_3D)glTexImage3D(target,0,GL_RGBA8,1,1,1,0,GL_RGBA,GL_UNSIGNED_BYTE,color);
 else if(target==GL_TEXTURE_CUBE_MAP){for(int face=0;face<6;face++)glTexImage2D(GL_TEXTURE_CUBE_MAP_POSITIVE_X+face,0,GL_RGBA8,1,1,0,GL_RGBA,GL_UNSIGNED_BYTE,color);}
 else glTexImage2D(target,0,GL_RGBA8,1,1,0,GL_RGBA,GL_UNSIGNED_BYTE,color);
 glColor4f(.25,.5,.75,1);glNormal3f(0,0,1);for(int i=0;i<8;i++)glMultiTexCoord4f(GL_TEXTURE0+i,.5,.5,.5,1);
 glBegin(GL_TRIANGLES);glVertex2f(-1,-1);glVertex2f(3,-1);glVertex2f(-1,3);glEnd();GLubyte pixels[1024];glReadPixels(0,0,16,16,GL_RGBA,GL_UNSIGNED_BYTE,pixels);GLenum error=glGetError();
 printf("%s{\\"name\\":\\"%s\\",\\"compileError\\":%u,\\"position\\":%d,\\"error\\":%u,\\"rgba\\":\\"",scene?",":"",cases[scene][0],compileError,position,error);for(int i=0;i<1024;i++)printf("%02x",pixels[i]);printf("\\"}");
 CGLSetCurrentContext(0);CGLDestroyContext(ctx);CGLDestroyPixelFormat(pf);
 }printf("]}\\n");return 0;}
`;
const output=path.join(__dirname,"arb_corpus.c");
if (process.argv.includes("--check")){if (fs.readFileSync(output,"utf8")!==source) throw new Error("stale arb_corpus.c");} else fs.writeFileSync(output,source);
