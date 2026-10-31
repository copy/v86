#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glext.h>
#include <stdio.h>
static int first = 1;
static void query(const char* name, GLenum target, GLint level) {
    GLenum p[] = {GL_TEXTURE_WIDTH,GL_TEXTURE_HEIGHT,GL_TEXTURE_DEPTH,GL_TEXTURE_INTERNAL_FORMAT,GL_TEXTURE_BORDER,
        GL_TEXTURE_RED_SIZE,GL_TEXTURE_GREEN_SIZE,GL_TEXTURE_BLUE_SIZE,GL_TEXTURE_ALPHA_SIZE,
        GL_TEXTURE_LUMINANCE_SIZE,GL_TEXTURE_INTENSITY_SIZE,GL_TEXTURE_DEPTH_SIZE,GL_TEXTURE_COMPRESSED};
    printf("%s\n    \"%s\":[", first ? "" : ",", name); first = 0;
    for (int i=0;i<13;++i) { GLint v=-1; glGetTexLevelParameteriv(target,level,p[i],&v); printf("%s%d",i?",":"",v); }
    printf(",%u]",glGetError());
}
int main(void) {
    CGLPixelFormatAttribute a[] = {kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,0};
    CGLPixelFormatObj pf; CGLContextObj ctx; GLint n;
    if(CGLChoosePixelFormat(a,&pf,&n)||CGLCreateContext(pf,NULL,&ctx))return 2;
    CGLSetCurrentContext(ctx);
    printf("{\n  \"renderer\":\"%s\",\n  \"cases\":{",glGetString(GL_RENDERER));
    query("undefined",GL_TEXTURE_2D,0);
    glTexImage2D(GL_TEXTURE_2D,2,GL_RGBA4,3,5,0,GL_RGBA,GL_UNSIGNED_BYTE,NULL); query("rgba4_level2",GL_TEXTURE_2D,2);
    query("other_level",GL_TEXTURE_2D,1);
    glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,0,5,0,GL_RGBA,GL_UNSIGNED_BYTE,NULL); query("zero_width",GL_TEXTURE_2D,0);
    glTexImage1D(GL_TEXTURE_1D,0,GL_RGB8,7,0,GL_RGB,GL_UNSIGNED_BYTE,NULL); query("rgb1d",GL_TEXTURE_1D,0);
    glTexImage3D(GL_TEXTURE_3D,0,GL_LUMINANCE4,4,3,2,0,GL_LUMINANCE,GL_UNSIGNED_BYTE,NULL); query("luminance3d",GL_TEXTURE_3D,0);
    glTexImage2D(GL_TEXTURE_CUBE_MAP_POSITIVE_X,0,GL_RGBA8,4,4,0,GL_RGBA,GL_UNSIGNED_BYTE,NULL); query("cube_positive_x",GL_TEXTURE_CUBE_MAP_POSITIVE_X,0);
    query("cube_negative_x",GL_TEXTURE_CUBE_MAP_NEGATIVE_X,0);
    glTexImage2D(GL_TEXTURE_2D,0,GL_DEPTH_COMPONENT16,4,4,0,GL_DEPTH_COMPONENT,GL_UNSIGNED_SHORT,NULL); query("depth16",GL_TEXTURE_2D,0);
    glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA16F_ARB,4,4,0,GL_RGBA,GL_FLOAT,NULL); query("rgba16f",GL_TEXTURE_2D,0);
    glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA,4,4,0,GL_RGBA,GL_UNSIGNED_BYTE,NULL);
    GLint size=-77; glGetTexLevelParameteriv(GL_TEXTURE_2D,0,GL_TEXTURE_COMPRESSED_IMAGE_SIZE,&size);
    printf(",\n    \"uncompressed_size\":[%u,%d]",glGetError(),size);
    unsigned char block[8]={0};
    glCompressedTexImage2D(GL_TEXTURE_2D,0,GL_COMPRESSED_RGBA_S3TC_DXT1_EXT,4,4,0,8,block);
    query("dxt1",GL_TEXTURE_2D,0);
    glGetTexLevelParameteriv(GL_TEXTURE_2D,0,GL_TEXTURE_COMPRESSED_IMAGE_SIZE,&size);
    printf(",\n    \"compressed_size\":[%u,%d]",glGetError(),size);
    glTexImage2D(GL_PROXY_TEXTURE_2D,0,GL_RGBA8,64,32,0,GL_RGBA,GL_UNSIGNED_BYTE,NULL); query("proxy_ok",GL_PROXY_TEXTURE_2D,0);
    /* Exceed the actual limit. Mesa 26.1 crashes on the unrelated 1<<30
       integer-overflow probe; the CPU's extreme-size test remains separate. */
    GLint max; glGetIntegerv(GL_MAX_TEXTURE_SIZE,&max);
    glTexImage2D(GL_PROXY_TEXTURE_2D,0,GL_RGBA8,max+1,32,0,GL_RGBA,GL_UNSIGNED_BYTE,NULL); query("proxy_oversized",GL_PROXY_TEXTURE_2D,0);
    printf("\n  }\n}\n"); CGLSetCurrentContext(NULL); CGLDestroyContext(ctx); CGLDestroyPixelFormat(pf); return 0;
}
