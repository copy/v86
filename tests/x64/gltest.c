// GLES 3.0 conformance-ish tests for the x86_64 Linux guest's GPU drivers
// (tests/x64/linux_gpu.mjs): each test draws into a 64 x 64 framebuffer
// object (or captures numbers) on EGL's surfaceless platform, then
//
//     LIBGL_ALWAYS_SOFTWARE=1 gltest ref     the images of llvmpipe, into /tmp/gltest-ref/
//     gltest cmp                             the driver's, compared with them
//
// prints "GLTEST <name> ok|FAIL max=<largest channel difference> bad=<pixels
// off by more than the tolerance>" and, for failures, both images as PPM in
// base64 ("GLIMG <name> <which> <chunk>") for the harness to save.
//
// Built without the C library's headers (the host has none for musl): the
// declarations it needs are here, it links against musl's libc and Mesa's
// libEGL from the guest's Alpine packages, and every GL function comes from
// eglGetProcAddress.

typedef unsigned int GLenum, GLuint, GLbitfield;
typedef int GLint, GLsizei;
typedef unsigned char GLubyte, GLboolean;
typedef float GLfloat;
typedef long GLintptr, GLsizeiptr;
typedef char GLchar;
typedef unsigned long GLuint64;
typedef struct GLsync_ *GLsync;
typedef unsigned long size_t;
typedef void *EGLDisplay, *EGLContext, *EGLConfig, *EGLSurface;
typedef int EGLint;
typedef unsigned int EGLBoolean, EGLenum;
typedef long EGLAttrib;

// the C library
int printf(const char *, ...);
int snprintf(char *, size_t, const char *, ...);
void *malloc(size_t);
void *calloc(size_t, size_t);
void free(void *);
void *memset(void *, int, size_t);
void *memcpy(void *, const void *, size_t);
int strcmp(const char *, const char *);
size_t strlen(const char *);
int open(const char *, int, ...);
long read(int, void *, size_t);
long write(int, const void *, size_t);
int close(int);
int mkdir(const char *, int);
void exit(int);
int fflush(void *);
#define O_RDONLY 0
#define O_WRONLY 1
#define O_CREAT 0100
#define O_TRUNC 01000

// EGL
EGLDisplay eglGetPlatformDisplay(EGLenum, void *, const EGLAttrib *);
EGLBoolean eglInitialize(EGLDisplay, EGLint *, EGLint *);
EGLBoolean eglBindAPI(EGLenum);
EGLContext eglCreateContext(EGLDisplay, EGLConfig, EGLContext, const EGLint *);
EGLBoolean eglMakeCurrent(EGLDisplay, EGLSurface, EGLSurface, EGLContext);
void *eglGetProcAddress(const char *);
EGLint eglGetError(void);
#define EGL_PLATFORM_SURFACELESS_MESA 0x31DD
#define EGL_OPENGL_ES_API 0x30A0
#define EGL_CONTEXT_MAJOR_VERSION 0x3098
#define EGL_CONTEXT_MINOR_VERSION 0x30FB
#define EGL_NONE 0x3038

// the start: what musl's crt1 does
int __libc_start_main(int (*)(int, char **, char **), int, char **, void (*)(void), void (*)(void), void (*)(void));
int main(int, char **, char **);
#if defined(__aarch64__)
// (the arm64 guest's, tests/a64/linux_gpu.mjs: the stack is 16-byte aligned at entry)
__asm__(".text\n.global _start\n_start:\n mov x29, #0\n mov x30, #0\n mov x0, sp\n bl start_c\n brk #0\n");
#else
__asm__(".text\n.global _start\n_start:\n xor %rbp, %rbp\n mov %rsp, %rdi\n andq $-16, %rsp\n call start_c\n hlt\n");
#endif
__attribute__((used)) void start_c(long *p)
{
    __libc_start_main(main, (int)p[0], (char **)(p + 1), 0, 0, 0);
}

// ---------------------------------------------------------------------------
// GL: functions from eglGetProcAddress, the constants used

#define GL_FUNCTIONS(F) \
    F(void, glClear, (GLbitfield)) F(void, glClearColor, (GLfloat, GLfloat, GLfloat, GLfloat)) \
    F(void, glClearDepthf, (GLfloat)) F(void, glClearStencil, (GLint)) F(void, glEnable, (GLenum)) F(void, glDisable, (GLenum)) \
    F(void, glScissor, (GLint, GLint, GLsizei, GLsizei)) F(void, glViewport, (GLint, GLint, GLsizei, GLsizei)) \
    F(GLenum, glGetError, (void)) F(const GLubyte *, glGetString, (GLenum)) F(void, glFinish, (void)) \
    F(void, glGenBuffers, (GLsizei, GLuint *)) F(void, glBindBuffer, (GLenum, GLuint)) \
    F(void, glBufferData, (GLenum, GLsizeiptr, const void *, GLenum)) F(void, glBufferSubData, (GLenum, GLintptr, GLsizeiptr, const void *)) \
    F(void, glDeleteBuffers, (GLsizei, const GLuint *)) F(void, glBindBufferBase, (GLenum, GLuint, GLuint)) \
    F(void *, glMapBufferRange, (GLenum, GLintptr, GLsizeiptr, GLbitfield)) F(GLboolean, glUnmapBuffer, (GLenum)) \
    F(GLuint, glCreateShader, (GLenum)) F(void, glShaderSource, (GLuint, GLsizei, const GLchar *const *, const GLint *)) \
    F(void, glCompileShader, (GLuint)) F(void, glGetShaderiv, (GLuint, GLenum, GLint *)) \
    F(void, glGetShaderInfoLog, (GLuint, GLsizei, GLsizei *, GLchar *)) F(GLuint, glCreateProgram, (void)) \
    F(void, glAttachShader, (GLuint, GLuint)) F(void, glLinkProgram, (GLuint)) F(void, glGetProgramiv, (GLuint, GLenum, GLint *)) \
    F(void, glGetProgramInfoLog, (GLuint, GLsizei, GLsizei *, GLchar *)) F(void, glUseProgram, (GLuint)) \
    F(void, glDeleteProgram, (GLuint)) F(void, glDeleteShader, (GLuint)) \
    F(GLint, glGetUniformLocation, (GLuint, const GLchar *)) F(void, glUniform1i, (GLint, GLint)) \
    F(void, glUniform1f, (GLint, GLfloat)) F(void, glUniform4f, (GLint, GLfloat, GLfloat, GLfloat, GLfloat)) \
    F(GLuint, glGetUniformBlockIndex, (GLuint, const GLchar *)) F(void, glUniformBlockBinding, (GLuint, GLuint, GLuint)) \
    F(void, glTransformFeedbackVaryings, (GLuint, GLsizei, const GLchar *const *, GLenum)) \
    F(void, glBeginTransformFeedback, (GLenum)) F(void, glEndTransformFeedback, (void)) \
    F(void, glGenVertexArrays, (GLsizei, GLuint *)) F(void, glBindVertexArray, (GLuint)) \
    F(void, glDeleteVertexArrays, (GLsizei, const GLuint *)) \
    F(void, glVertexAttribPointer, (GLuint, GLint, GLenum, GLboolean, GLsizei, const void *)) \
    F(void, glVertexAttribIPointer, (GLuint, GLint, GLenum, GLsizei, const void *)) \
    F(void, glEnableVertexAttribArray, (GLuint)) F(void, glVertexAttribDivisor, (GLuint, GLuint)) \
    F(void, glDrawArrays, (GLenum, GLint, GLsizei)) F(void, glDrawElements, (GLenum, GLsizei, GLenum, const void *)) \
    F(void, glDrawArraysInstanced, (GLenum, GLint, GLsizei, GLsizei)) \
    F(void, glDrawElementsInstanced, (GLenum, GLsizei, GLenum, const void *, GLsizei)) \
    F(void, glGenTextures, (GLsizei, GLuint *)) F(void, glBindTexture, (GLenum, GLuint)) F(void, glActiveTexture, (GLenum)) \
    F(void, glDeleteTextures, (GLsizei, const GLuint *)) F(void, glTexParameteri, (GLenum, GLenum, GLint)) \
    F(void, glTexImage2D, (GLenum, GLint, GLint, GLsizei, GLsizei, GLint, GLenum, GLenum, const void *)) \
    F(void, glTexSubImage2D, (GLenum, GLint, GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, const void *)) \
    F(void, glTexImage3D, (GLenum, GLint, GLint, GLsizei, GLsizei, GLsizei, GLint, GLenum, GLenum, const void *)) \
    F(void, glTexStorage2D, (GLenum, GLsizei, GLenum, GLsizei, GLsizei)) F(void, glGenerateMipmap, (GLenum)) \
    F(void, glPixelStorei, (GLenum, GLint)) \
    F(void, glGenFramebuffers, (GLsizei, GLuint *)) F(void, glBindFramebuffer, (GLenum, GLuint)) \
    F(void, glDeleteFramebuffers, (GLsizei, const GLuint *)) \
    F(void, glFramebufferTexture2D, (GLenum, GLenum, GLenum, GLuint, GLint)) \
    F(void, glFramebufferRenderbuffer, (GLenum, GLenum, GLenum, GLuint)) F(GLenum, glCheckFramebufferStatus, (GLenum)) \
    F(void, glGenRenderbuffers, (GLsizei, GLuint *)) F(void, glBindRenderbuffer, (GLenum, GLuint)) \
    F(void, glDeleteRenderbuffers, (GLsizei, const GLuint *)) \
    F(void, glRenderbufferStorage, (GLenum, GLenum, GLsizei, GLsizei)) \
    F(void, glRenderbufferStorageMultisample, (GLenum, GLsizei, GLenum, GLsizei, GLsizei)) \
    F(void, glDrawBuffers, (GLsizei, const GLenum *)) F(void, glReadBuffer, (GLenum)) \
    F(void, glReadPixels, (GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, void *)) \
    F(void, glBlitFramebuffer, (GLint, GLint, GLint, GLint, GLint, GLint, GLint, GLint, GLbitfield, GLenum)) \
    F(void, glCopyTexSubImage2D, (GLenum, GLint, GLint, GLint, GLint, GLint, GLsizei, GLsizei)) \
    F(void, glBlendFunc, (GLenum, GLenum)) F(void, glBlendEquation, (GLenum)) \
    F(void, glBlendFuncSeparate, (GLenum, GLenum, GLenum, GLenum)) F(void, glBlendColor, (GLfloat, GLfloat, GLfloat, GLfloat)) \
    F(void, glColorMask, (GLboolean, GLboolean, GLboolean, GLboolean)) F(void, glDepthFunc, (GLenum)) \
    F(void, glDepthMask, (GLboolean)) F(void, glStencilFunc, (GLenum, GLint, GLuint)) \
    F(void, glStencilOp, (GLenum, GLenum, GLenum)) F(void, glCullFace, (GLenum)) F(void, glFrontFace, (GLenum)) \
    F(void, glPolygonOffset, (GLfloat, GLfloat)) \
    F(void, glGenQueries, (GLsizei, GLuint *)) F(void, glBeginQuery, (GLenum, GLuint)) F(void, glEndQuery, (GLenum)) \
    F(void, glGetQueryObjectuiv, (GLuint, GLenum, GLuint *)) F(void, glDeleteQueries, (GLsizei, const GLuint *)) \
    F(void, glClearBufferfv, (GLenum, GLint, const GLfloat *)) F(void, glClearBufferuiv, (GLenum, GLint, const GLuint *)) \
    F(void, glTexBuffer, (GLenum, GLenum, GLuint)) \
    F(void, glDispatchCompute, (GLuint, GLuint, GLuint)) F(void, glMemoryBarrier, (GLbitfield)) \
    F(void, glBindImageTexture, (GLuint, GLuint, GLint, GLboolean, GLint, GLenum, GLenum)) \
    F(void, glPatchParameteri, (GLenum, GLint)) F(void, glUniform1ui, (GLint, GLuint)) \
    F(void, glUniform1d, (GLint, double)) \
    F(void, glDrawArraysIndirect, (GLenum, const void *)) F(void, glDrawElementsIndirect, (GLenum, GLenum, const void *)) \
    F(GLuint, glCreateShaderProgramv, (GLenum, GLsizei, const GLchar *const *)) \
    F(void, glTexImage2DMultisample, (GLenum, GLsizei, GLenum, GLsizei, GLsizei, GLboolean)) \
    F(void, glGetIntegerv, (GLenum, GLint *)) F(const GLubyte *, glGetStringi, (GLenum, GLuint)) \
    F(void, glBufferStorage, (GLenum, GLsizeiptr, const void *, GLbitfield)) \
    F(GLsync, glFenceSync, (GLenum, GLbitfield)) F(GLenum, glClientWaitSync, (GLsync, GLbitfield, GLuint64)) \
    F(void, glDeleteSync, (GLsync))

#define DECLARE(ret, name, args) static ret (*name) args;
GL_FUNCTIONS(DECLARE)

#define GL_COLOR_BUFFER_BIT 0x4000
#define GL_DEPTH_BUFFER_BIT 0x0100
#define GL_STENCIL_BUFFER_BIT 0x0400
#define GL_POINTS 0x0000
#define GL_LINES 0x0001
#define GL_LINE_STRIP 0x0003
#define GL_TRIANGLES 0x0004
#define GL_TRIANGLE_STRIP 0x0005
#define GL_TRIANGLE_FAN 0x0006
#define GL_BYTE 0x1400
#define GL_UNSIGNED_BYTE 0x1401
#define GL_SHORT 0x1402
#define GL_UNSIGNED_SHORT 0x1403
#define GL_INT 0x1404
#define GL_UNSIGNED_INT 0x1405
#define GL_FLOAT 0x1406
#define GL_HALF_FLOAT 0x140B
#define GL_ARRAY_BUFFER 0x8892
#define GL_ELEMENT_ARRAY_BUFFER 0x8893
#define GL_UNIFORM_BUFFER 0x8A11
#define GL_TRANSFORM_FEEDBACK_BUFFER 0x8C8E
#define GL_STATIC_DRAW 0x88E4
#define GL_STREAM_READ 0x88E1
#define GL_VERTEX_SHADER 0x8B31
#define GL_FRAGMENT_SHADER 0x8B30
#define GL_COMPILE_STATUS 0x8B81
#define GL_LINK_STATUS 0x8B82
#define GL_TEXTURE_2D 0x0DE1
#define GL_TEXTURE_3D 0x806F
#define GL_TEXTURE_2D_ARRAY 0x8C1A
#define GL_TEXTURE_CUBE_MAP 0x8513
#define GL_TEXTURE_CUBE_MAP_POSITIVE_X 0x8515
#define GL_TEXTURE0 0x84C0
#define GL_TEXTURE_MAG_FILTER 0x2800
#define GL_TEXTURE_MIN_FILTER 0x2801
#define GL_TEXTURE_WRAP_S 0x2802
#define GL_TEXTURE_WRAP_T 0x2803
#define GL_TEXTURE_WRAP_R 0x8072
#define GL_TEXTURE_SWIZZLE_R 0x8E42
#define GL_TEXTURE_SWIZZLE_G 0x8E43
#define GL_TEXTURE_SWIZZLE_B 0x8E44
#define GL_TEXTURE_SWIZZLE_A 0x8E45
#define GL_TEXTURE_COMPARE_MODE 0x884C
#define GL_TEXTURE_COMPARE_FUNC 0x884D
#define GL_COMPARE_REF_TO_TEXTURE 0x884E
#define GL_NEAREST 0x2600
#define GL_LINEAR 0x2601
#define GL_LINEAR_MIPMAP_NEAREST 0x2701
#define GL_NEAREST_MIPMAP_NEAREST 0x2700
#define GL_REPEAT 0x2901
#define GL_CLAMP_TO_EDGE 0x812F
#define GL_MIRRORED_REPEAT 0x8370
#define GL_ALPHA 0x1906
#define GL_RGB 0x1907
#define GL_RGBA 0x1908
#define GL_LUMINANCE 0x1909
#define GL_LUMINANCE_ALPHA 0x190A
#define GL_RED 0x1903
#define GL_BLUE 0x1905
#define GL_RG 0x8227
#define GL_R8 0x8229
#define GL_RG8 0x822B
#define GL_R32F 0x822E
#define GL_RGBA8 0x8058
#define GL_RGBA16F 0x881A
#define GL_RGBA32F 0x8814
#define GL_RGBA8UI 0x8D7C
#define GL_R32UI 0x8236
#define GL_RGBA_INTEGER 0x8D99
#define GL_RED_INTEGER 0x8D94
#define GL_SRGB8_ALPHA8 0x8C43
#define GL_DEPTH_COMPONENT 0x1902
#define GL_DEPTH_COMPONENT16 0x81A5
#define GL_DEPTH_COMPONENT24 0x81A6
#define GL_DEPTH24_STENCIL8 0x88F0
#define GL_FRAMEBUFFER 0x8D40
#define GL_READ_FRAMEBUFFER 0x8CA8
#define GL_DRAW_FRAMEBUFFER 0x8CA9
#define GL_RENDERBUFFER 0x8D41
#define GL_COLOR_ATTACHMENT0 0x8CE0
#define GL_COLOR_ATTACHMENT1 0x8CE1
#define GL_DEPTH_ATTACHMENT 0x8D00
#define GL_DEPTH_STENCIL_ATTACHMENT 0x821A
#define GL_FRAMEBUFFER_COMPLETE 0x8CD5
#define GL_DEPTH_TEST 0x0B71
#define GL_STENCIL_TEST 0x0B90
#define GL_BLEND 0x0BE2
#define GL_SCISSOR_TEST 0x0C11
#define GL_CULL_FACE 0x0B44
#define GL_RASTERIZER_DISCARD 0x8C89
#define GL_PRIMITIVE_RESTART_FIXED_INDEX 0x8D69
#define GL_POLYGON_OFFSET_FILL 0x8037
#define GL_NEVER 0x0200
#define GL_LESS 0x0201
#define GL_EQUAL 0x0202
#define GL_LEQUAL 0x0203
#define GL_GREATER 0x0204
#define GL_NOTEQUAL 0x0205
#define GL_GEQUAL 0x0206
#define GL_ALWAYS 0x0207
#define GL_KEEP 0x1E00
#define GL_REPLACE 0x1E01
#define GL_INCR 0x1E02
#define GL_ZERO 0
#define GL_ONE 1
#define GL_SRC_COLOR 0x0300
#define GL_SRC_ALPHA 0x0302
#define GL_ONE_MINUS_SRC_ALPHA 0x0303
#define GL_DST_COLOR 0x0306
#define GL_CONSTANT_COLOR 0x8001
#define GL_FUNC_ADD 0x8006
#define GL_MIN 0x8007
#define GL_MAX 0x8008
#define GL_FUNC_REVERSE_SUBTRACT 0x800B
#define GL_FRONT 0x0404
#define GL_BACK 0x0405
#define GL_CW 0x0900
#define GL_CCW 0x0901
#define GL_INTERLEAVED_ATTRIBS 0x8C8C
#define GL_SEPARATE_ATTRIBS 0x8C8D
#define GL_TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN 0x8C88
#define GL_ANY_SAMPLES_PASSED 0x8C2F
#define GL_QUERY_RESULT 0x8866
#define GL_MAP_READ_BIT 0x0001
#define GL_UNPACK_ALIGNMENT 0x0CF5
#define GL_PACK_ALIGNMENT 0x0D05
#define GL_VERSION 0x1F02
#define GL_RENDERER 0x1F01
#define GL_COLOR 0x1800
#define GL_TEXTURE_RECTANGLE 0x84F5
#define GL_TEXTURE_BUFFER 0x8C2A
#define GL_TEXTURE_2D_MULTISAMPLE 0x9100
#define GL_CLIP_DISTANCE0 0x3000
#define GL_GEOMETRY_SHADER 0x8DD9
#define GL_DEPTH_COMPONENT32F 0x8CAC
#define GL_RGBA32UI 0x8D70
#define GL_RGBA8I 0x8D8E
#define GL_R32I 0x8235
#define GL_UNSIGNED_INT_IMM 0
#define EGL_OPENGL_API 0x30A2
#define GL_COMPUTE_SHADER 0x91B9
#define GL_TESS_CONTROL_SHADER 0x8E88
#define GL_TESS_EVALUATION_SHADER 0x8E87
#define GL_PATCHES 0x000E
#define GL_PATCH_VERTICES 0x8E72
#define GL_SHADER_STORAGE_BUFFER 0x90D2
#define GL_DRAW_INDIRECT_BUFFER 0x8F3F
#define GL_ALL_BARRIER_BITS 0xFFFFFFFF
#define GL_WRITE_ONLY 0x88B9
#define GL_READ_ONLY 0x88B8
#define GL_READ_WRITE 0x88BA
#define GL_R32UI_IMAGE 0x8236
#define GL_MAP_WRITE_BIT 0x0002
#define GL_MAP_PERSISTENT_BIT 0x0040
#define GL_MAP_COHERENT_BIT 0x0080
#define GL_CLIENT_MAPPED_BUFFER_BARRIER_BIT 0x4000
#define GL_SYNC_GPU_COMMANDS_COMPLETE 0x9117
#define GL_SYNC_FLUSH_COMMANDS_BIT 0x0001
#define GL_NUM_EXTENSIONS 0x821D
#define GL_EXTENSIONS 0x1F03
#define EGL_CONTEXT_OPENGL_PROFILE_MASK 0x30FD
#define EGL_CONTEXT_OPENGL_CORE_PROFILE_BIT 0x1

// ---------------------------------------------------------------------------

#define W 64
#define H 64
static int mode_ref;
static int failures;
static unsigned char pixels[W * H * 4];
static const char *dir = "/tmp/gltest-ref";

static const char *base64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** An image as PPM in base64, in lines of the harness's */
static void print_image(const char *name, const char *which, const unsigned char *rgba)
{
    static unsigned char ppm[32 + W * H * 3];
    int n = snprintf((char *)ppm, 32, "P6\n%d %d\n255\n", W, H);
    for(int i = 0; i < W * H; i++)
    {
        // (bottom row first in GL: top first in the picture)
        int row = H - 1 - i / W, column = i % W;
        const unsigned char *p = rgba + (row * W + column) * 4;
        ppm[n++] = p[0]; ppm[n++] = p[1]; ppm[n++] = p[2];
    }
    static char line[4100];
    int at = 0, chunk = 0;
    for(int i = 0; i < n; i += 3)
    {
        unsigned v = ppm[i] << 16 | (i + 1 < n ? ppm[i + 1] << 8 : 0) | (i + 2 < n ? ppm[i + 2] : 0);
        line[at++] = base64[v >> 18 & 63];
        line[at++] = base64[v >> 12 & 63];
        line[at++] = i + 1 < n ? base64[v >> 6 & 63] : '=';
        line[at++] = i + 2 < n ? base64[v & 63] : '=';
        if(at >= 4000 || i + 3 >= n)
        {
            line[at] = 0;
            printf("GLIMG %s %s %d %s\n", name, which, chunk++, line);
            at = 0;
        }
    }
    printf("GLIMG %s %s end\n", name, which);
}

/** The result of a test: bytes (an image if `image`), to keep or to compare */
static void result(const char *name, const unsigned char *bytes, int length, int image, int tolerance)
{
    char path[256];
    snprintf(path, sizeof(path), "%s/%s.raw", dir, name);
    GLenum error = glGetError();
    if(mode_ref)
    {
        int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
        write(fd, bytes, length);
        close(fd);
        if(error) printf("GLTEST %s ref (GL error %x)\n", name, error);
        else printf("GLTEST %s ref\n", name);
        return;
    }
    static unsigned char ref[W * H * 4];
    int fd = open(path, O_RDONLY);
    long got = fd >= 0 ? read(fd, ref, length) : -1;
    if(fd >= 0) close(fd);
    if(got != length)
    {
        printf("GLTEST %s FAIL no reference\n", name);
        failures++;
        return;
    }
    int max = 0, bad = 0;
    for(int i = 0; i < length; i++)
    {
        int d = bytes[i] > ref[i] ? bytes[i] - ref[i] : ref[i] - bytes[i];
        if(d > max) max = d;
    }
    if(image)
    {
        for(int i = 0; i < W * H; i++)
        {
            for(int c = 0; c < 4; c++)
            {
                int d = bytes[4 * i + c] > ref[4 * i + c] ? bytes[4 * i + c] - ref[4 * i + c] : ref[4 * i + c] - bytes[4 * i + c];
                if(d > tolerance) { bad++; break; }
            }
        }
    }
    else
    {
        bad = max > tolerance;
        // (numbers: the first word that differs, for the log)
        for(int i = 0; i + 4 <= length && bad; i += 4)
        {
            const unsigned int *g = (const unsigned int *)(bytes + i), *r = (const unsigned int *)(ref + i);
            if(*g != *r)
            {
                printf("GLTEST %s first difference at byte %d: got %u (0x%x), expected %u (0x%x)\n", name, i, *g, *g, *r, *r);
                break;
            }
        }
    }
    // (a few pixels on edges may differ: GPUs need not rasterize alike)
    int ok = !error && bad <= (image ? 8 : 0);
    printf("GLTEST %s %s max=%d bad=%d", name, ok ? "ok" : "FAIL", max, bad);
    if(error) printf(" glerror=%x", error);
    printf("\n");
    if(!ok)
    {
        failures++;
        if(image)
        {
            print_image(name, "got", bytes);
            print_image(name, "ref", ref);
        }
        else
        {
            printf("GLDATA %s got", name);
            for(int i = 0; i < length && i < 64; i++) printf(" %02x", bytes[i]);
            printf("\nGLDATA %s ref", name);
            for(int i = 0; i < length && i < 64; i++) printf(" %02x", ref[i]);
            printf("\n");
        }
    }
    fflush(0);
}

static GLuint shader(GLenum type, const char *source)
{
    GLuint s = glCreateShader(type);
    glShaderSource(s, 1, &source, 0);
    glCompileShader(s);
    GLint ok = 0;
    glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
    if(!ok)
    {
        char log[1024];
        glGetShaderInfoLog(s, sizeof(log), 0, log);
        printf("shader: %s\n", log);
    }
    return s;
}

/** A program; `varyings` for transform feedback */
static GLuint program2(const char *vs, const char *fs, int count, const char *const *varyings, GLenum mode)
{
    GLuint p = glCreateProgram();
    GLuint v = shader(GL_VERTEX_SHADER, vs), f = shader(GL_FRAGMENT_SHADER, fs);
    glAttachShader(p, v);
    glAttachShader(p, f);
    if(count) glTransformFeedbackVaryings(p, count, varyings, mode);
    glLinkProgram(p);
    GLint ok = 0;
    glGetProgramiv(p, GL_LINK_STATUS, &ok);
    if(!ok)
    {
        char log[1024];
        glGetProgramInfoLog(p, sizeof(log), 0, log);
        printf("link: %s\n", log);
    }
    glDeleteShader(v);
    glDeleteShader(f);
    glUseProgram(p);
    return p;
}

static GLuint program(const char *vs, const char *fs)
{
    return program2(vs, fs, 0, 0, 0);
}

static GLuint program_gs(const char *vs, const char *gs, const char *fs)
{
    GLuint p = glCreateProgram();
    GLuint v = shader(GL_VERTEX_SHADER, vs), g = shader(GL_GEOMETRY_SHADER, gs), f = shader(GL_FRAGMENT_SHADER, fs);
    glAttachShader(p, v);
    glAttachShader(p, g);
    glAttachShader(p, f);
    glLinkProgram(p);
    GLint ok = 0;
    glGetProgramiv(p, GL_LINK_STATUS, &ok);
    if(!ok)
    {
        char log[1024];
        glGetProgramInfoLog(p, sizeof(log), 0, log);
        printf("link: %s\n", log);
    }
    glUseProgram(p);
    return p;
}

/** A framebuffer of a 64 x 64 RGBA8 texture, maybe with depth and stencil */
static GLuint fbo, fbo_color, fbo_depth;
static void target(int depth_stencil)
{
    glGenFramebuffers(1, &fbo);
    glBindFramebuffer(GL_FRAMEBUFFER, fbo);
    glGenTextures(1, &fbo_color);
    glBindTexture(GL_TEXTURE_2D, fbo_color);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, W, H, 0, GL_RGBA, GL_UNSIGNED_BYTE, 0);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, fbo_color, 0);
    fbo_depth = 0;
    if(depth_stencil)
    {
        glGenRenderbuffers(1, &fbo_depth);
        glBindRenderbuffer(GL_RENDERBUFFER, fbo_depth);
        glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH24_STENCIL8, W, H);
        glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_STENCIL_ATTACHMENT, GL_RENDERBUFFER, fbo_depth);
    }
    if(glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) printf("framebuffer incomplete\n");
    glViewport(0, 0, W, H);
    glClearColor(0.1f, 0.2f, 0.3f, 1.0f);
    glClearDepthf(1.0f);
    glClearStencil(0);
    glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT | GL_STENCIL_BUFFER_BIT);
}

/** The target's pixels compared (without a name: not), then everything made for the test deleted */
static void finish(const char *name, int tolerance)
{
    if(name)
    {
        glPixelStorei(GL_PACK_ALIGNMENT, 1);
        glReadPixels(0, 0, W, H, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
        result(name, pixels, W * H * 4, 1, tolerance);
    }
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glDeleteFramebuffers(1, &fbo);
    glDeleteTextures(1, &fbo_color);
    if(fbo_depth) glDeleteRenderbuffers(1, &fbo_depth);
    glUseProgram(0);
    glDisable(GL_DEPTH_TEST);
    glDisable(GL_STENCIL_TEST);
    glDisable(GL_BLEND);
    glDisable(GL_SCISSOR_TEST);
    glDisable(GL_CULL_FACE);
    glDisable(GL_POLYGON_OFFSET_FILL);
    glDisable(GL_PRIMITIVE_RESTART_FIXED_INDEX);
    glColorMask(1, 1, 1, 1);
    glDepthMask(1);
}

/** A vertex buffer of floats bound to attribute `index` */
static GLuint vbo(GLuint index, int components, const float *data, int bytes)
{
    GLuint b;
    glGenBuffers(1, &b);
    glBindBuffer(GL_ARRAY_BUFFER, b);
    glBufferData(GL_ARRAY_BUFFER, bytes, data, GL_STATIC_DRAW);
    glVertexAttribPointer(index, components, GL_FLOAT, 0, 0, 0);
    glEnableVertexAttribArray(index);
    return b;
}

static GLuint vao;
static void fresh_vao(void)
{
    if(vao) glDeleteVertexArrays(1, &vao);
    glGenVertexArrays(1, &vao);
    glBindVertexArray(vao);
}

#define VS_HEADER "#version 300 es\n"
#define FS_HEADER "#version 300 es\nprecision highp float;\nprecision highp int;\n"

static const float quad[] = { -1, -1, 1, -1, -1, 1, 1, 1 };

// ---------------------------------------------------------------------------
// The tests

static void test_clear(void)
{
    target(0);
    glEnable(GL_SCISSOR_TEST);
    glScissor(8, 16, 24, 20);
    glClearColor(1, 0.5f, 0, 1);
    glClear(GL_COLOR_BUFFER_BIT);
    finish("clear-scissor", 1);
}

static void test_triangle(void)
{
    target(0);
    fresh_vao();
    program(VS_HEADER "in vec2 p; in vec3 c; out vec3 v; void main() { v = c; gl_Position = vec4(p, 0.0, 1.0); }",
        FS_HEADER "in vec3 v; out vec4 o; void main() { o = vec4(v, 1.0); }");
    const float p[] = { -0.9f, -0.9f, 0.9f, -0.7f, 0.0f, 0.9f };
    const float c[] = { 1, 0, 0, 0, 1, 0, 0, 0, 1 };
    vbo(0, 2, p, sizeof(p));
    vbo(1, 3, c, sizeof(c));
    glDrawArrays(GL_TRIANGLES, 0, 3);
    finish("triangle", 2);
}

/** Front faces, culling, and the window's way up */
static void test_cull(void)
{
    target(0);
    fresh_vao();
    program(VS_HEADER "in vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }",
        FS_HEADER "out vec4 o; void main() { o = gl_FrontFacing ? vec4(0, 1, 0, 1) : vec4(1, 0, 0, 1); }");
    // a counter-clockwise triangle on the left, a clockwise one on the right
    const float p[] = { -0.9f, -0.5f, -0.1f, -0.5f, -0.5f, 0.5f, 0.1f, -0.5f, 0.5f, 0.5f, 0.9f, -0.5f };
    vbo(0, 2, p, sizeof(p));
    glDrawArrays(GL_TRIANGLES, 0, 6);
    glEnable(GL_CULL_FACE);
    glCullFace(GL_BACK);
    glFrontFace(GL_CW);
    glEnable(GL_SCISSOR_TEST);
    glScissor(0, 0, W, 16);
    glDrawArrays(GL_TRIANGLES, 0, 6);
    finish("cull-front-face", 2);
}

static void test_depth_stencil(void)
{
    target(1);
    fresh_vao();
    GLuint p = program(VS_HEADER "in vec2 p; uniform float z; void main() { gl_Position = vec4(p, z, 1.0); }",
        FS_HEADER "uniform vec4 color; out vec4 o; void main() { o = color; }");
    GLint z = glGetUniformLocation(p, "z"), color = glGetUniformLocation(p, "color");
    vbo(0, 2, quad, sizeof(quad));
    glEnable(GL_DEPTH_TEST);
    glDepthFunc(GL_LESS);
    glEnable(GL_STENCIL_TEST);
    // a stencil mask in the middle
    glStencilFunc(GL_ALWAYS, 1, 0xFF);
    glStencilOp(GL_KEEP, GL_KEEP, GL_REPLACE);
    glColorMask(0, 0, 0, 0);
    glDepthMask(0);
    glEnable(GL_SCISSOR_TEST);
    glScissor(16, 16, 32, 32);
    glUniform1f(z, 0.0f);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    glDisable(GL_SCISSOR_TEST);
    glColorMask(1, 1, 1, 1);
    glDepthMask(1);
    // red at z 0.5 everywhere, then green at 0.0 only where the stencil is 1,
    // then blue at 0.25 (behind green, in front of red)
    glStencilFunc(GL_ALWAYS, 0, 0xFF);
    glStencilOp(GL_KEEP, GL_KEEP, GL_KEEP);
    glUniform1f(z, 0.5f);
    glUniform4f(color, 1, 0, 0, 1);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    glStencilFunc(GL_EQUAL, 1, 0xFF);
    glUniform1f(z, 0.0f);
    glUniform4f(color, 0, 1, 0, 1);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    glDisable(GL_STENCIL_TEST);
    glEnable(GL_SCISSOR_TEST);
    glScissor(0, 0, 40, 40);
    glUniform1f(z, 0.25f);
    glUniform4f(color, 0, 0, 1, 1);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    finish("depth-stencil", 0);
}

static void test_blend(void)
{
    target(0);
    fresh_vao();
    GLuint p = program(VS_HEADER "in vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }",
        FS_HEADER "uniform vec4 color; out vec4 o; void main() { o = color; }");
    GLint color = glGetUniformLocation(p, "color");
    vbo(0, 2, quad, sizeof(quad));
    glEnable(GL_BLEND);
    glEnable(GL_SCISSOR_TEST);
    glScissor(0, 0, 32, 64);
    glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    glUniform4f(color, 1, 0, 0, 0.5f);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    glScissor(32, 0, 32, 32);
    glBlendFunc(GL_ONE, GL_ONE);
    glBlendEquation(GL_FUNC_REVERSE_SUBTRACT);
    glUniform4f(color, 0.05f, 0.1f, 0.1f, 0);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    glScissor(32, 32, 32, 32);
    glBlendEquation(GL_FUNC_ADD);
    glBlendColor(0.5f, 0.25f, 1, 1);
    glBlendFuncSeparate(GL_CONSTANT_COLOR, GL_ZERO, GL_ONE, GL_ZERO);
    glUniform4f(color, 1, 1, 1, 0.75f);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    finish("blend", 2);
}

/** A texture: a checkerboard of colors, its mipmaps, nearest and linear */
static void test_texture(void)
{
    target(0);
    fresh_vao();
    // left: wrapping, nearest; right: level 0 with the sub-image (nearest); then level 2 (linear)
    GLuint p = program(VS_HEADER "in vec2 p; out vec2 t; void main() { t = p * 0.75 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }",
        FS_HEADER "uniform sampler2D s; uniform sampler2D m; uniform float lod; in vec2 t; out vec4 o;\n"
        "void main() { o = t.x < 0.5 ? texture(s, t * 2.0) : textureLod(m, t, lod); }");
    static unsigned char texels[16 * 16 * 4];
    for(int y = 0; y < 16; y++)
        for(int x = 0; x < 16; x++)
        {
            unsigned char *t = texels + 4 * (y * 16 + x);
            t[0] = x * 16; t[1] = y * 16; t[2] = (x ^ y) & 1 ? 255 : 0; t[3] = 255;
        }
    GLuint tex[2];
    glGenTextures(2, tex);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, tex[0]);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, 16, 16, 0, GL_RGBA, GL_UNSIGNED_BYTE, texels);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_MIRRORED_REPEAT);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_REPEAT);
    glActiveTexture(GL_TEXTURE0 + 1);
    glBindTexture(GL_TEXTURE_2D, tex[1]);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, 16, 16, 0, GL_RGBA, GL_UNSIGNED_BYTE, texels);
    // (a sub-image: a white block)
    static unsigned char white[4 * 4 * 4];
    memset(white, 255, sizeof(white));
    glTexSubImage2D(GL_TEXTURE_2D, 0, 4, 4, 4, 4, GL_RGBA, GL_UNSIGNED_BYTE, white);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glUniform1i(glGetUniformLocation(p, "s"), 0);
    glUniform1i(glGetUniformLocation(p, "m"), 1);
    glUniform1f(glGetUniformLocation(p, "lod"), 0.0f);
    vbo(0, 2, quad, sizeof(quad));
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    finish("texture-subimage", 0);
    target(0);
    glUseProgram(p);
    glGenerateMipmap(GL_TEXTURE_2D);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR_MIPMAP_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glUniform1f(glGetUniformLocation(p, "lod"), 2.0f);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    finish("texture-mipmap", 3);
    glDeleteTextures(2, tex);
}

/** The legacy formats (swizzled) and texture swizzles */
static void test_swizzle(void)
{
    target(0);
    fresh_vao();
    GLuint p = program(VS_HEADER "in vec2 p; out vec2 t; void main() { t = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }",
        FS_HEADER "uniform sampler2D a, l, la, s; in vec2 t; out vec4 o;\n"
        "void main() { vec2 u = fract(t * 2.0); o = t.y < 0.5 ? (t.x < 0.5 ? texture(a, u) : texture(l, u)) : (t.x < 0.5 ? texture(la, u) : texture(s, u)); }");
    static unsigned char texels[4 * 4 * 4];
    for(int i = 0; i < 64; i++) texels[i] = i * 4;
    GLuint tex[4];
    glGenTextures(4, tex);
    const GLenum formats[] = { GL_ALPHA, GL_LUMINANCE, GL_LUMINANCE_ALPHA, GL_RGBA };
    const char *names[] = { "a", "l", "la", "s" };
    glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
    for(int i = 0; i < 4; i++)
    {
        glActiveTexture(GL_TEXTURE0 + i);
        glBindTexture(GL_TEXTURE_2D, tex[i]);
        glTexImage2D(GL_TEXTURE_2D, 0, formats[i], 4, 4, 0, formats[i], GL_UNSIGNED_BYTE, texels);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
        glUniform1i(glGetUniformLocation(p, names[i]), i);
    }
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_SWIZZLE_R, GL_BLUE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_SWIZZLE_G, GL_ONE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_SWIZZLE_B, GL_RED);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_SWIZZLE_A, GL_ZERO);
    vbo(0, 2, quad, sizeof(quad));
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    finish("legacy-formats-swizzle", 1);
    glDeleteTextures(4, tex);
}

/** Two render targets, flat integer varyings, gl_FragCoord */
static void test_mrt(void)
{
    target(0);
    GLuint second;
    glGenTextures(1, &second);
    glBindTexture(GL_TEXTURE_2D, second);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, W, H, 0, GL_RGBA, GL_UNSIGNED_BYTE, 0);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT1, GL_TEXTURE_2D, second, 0);
    const GLenum buffers[] = { GL_COLOR_ATTACHMENT0, GL_COLOR_ATTACHMENT1 };
    glDrawBuffers(2, buffers);
    const float black[] = { 0, 0, 0, 1 };
    glClearBufferfv(GL_COLOR, 1, black);
    fresh_vao();
    program(VS_HEADER "in vec2 p; flat out int k; void main() { k = gl_VertexID; gl_Position = vec4(p, 0.0, 1.0); }",
        FS_HEADER "flat in int k; layout(location = 0) out vec4 a; layout(location = 1) out vec4 b;\n"
        "void main() { a = vec4(float(k) / 4.0, 0.5, 0.0, 1.0); b = vec4(gl_FragCoord.xy / 64.0, gl_FragCoord.z, 1.0); }");
    vbo(0, 2, quad, sizeof(quad));
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    glReadBuffer(GL_COLOR_ATTACHMENT1);
    glPixelStorei(GL_PACK_ALIGNMENT, 1);
    glReadPixels(0, 0, W, H, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
    result("mrt-fragcoord", pixels, W * H * 4, 1, 2);
    glReadBuffer(GL_COLOR_ATTACHMENT0);
    finish("mrt-flat", 2);
    glDeleteTextures(1, &second);
}

/** Instancing, 8-bit indices, primitive restart, a uniform buffer */
static void test_instancing(void)
{
    target(0);
    fresh_vao();
    GLuint p = program(VS_HEADER "in vec2 p; in vec2 offset; in uvec4 tint;\n"
        "layout(std140) uniform U { vec4 scale; vec4 colors[4]; };\n"
        "out vec4 c; void main() { c = colors[gl_InstanceID & 3] * vec4(tint) / 255.0; gl_Position = vec4(p * scale.xy + offset, 0.0, 1.0); }",
        FS_HEADER "in vec4 c; out vec4 o; void main() { o = c; }");
    const float corners[] = { -1, -1, 1, -1, -1, 1, 1, 1, 0, 1.5f };
    vbo(0, 2, corners, sizeof(corners));
    const float offsets[] = { -0.5f, -0.5f, 0.5f, -0.5f, -0.5f, 0.5f, 0.5f, 0.5f };
    vbo(1, 2, offsets, sizeof(offsets));
    glVertexAttribDivisor(1, 1);
    const unsigned char tints[] = { 255, 255, 255, 255, 128, 255, 255, 255, 255, 128, 255, 255, 255, 255, 128, 255 };
    GLuint tb;
    glGenBuffers(1, &tb);
    glBindBuffer(GL_ARRAY_BUFFER, tb);
    glBufferData(GL_ARRAY_BUFFER, sizeof(tints), tints, GL_STATIC_DRAW);
    glVertexAttribIPointer(2, 4, GL_UNSIGNED_BYTE, 4, 0);
    glEnableVertexAttribArray(2);
    glVertexAttribDivisor(2, 1);
    const float u[] = { 0.3f, 0.3f, 0, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 0, 1 };
    GLuint ub;
    glGenBuffers(1, &ub);
    glBindBuffer(GL_UNIFORM_BUFFER, ub);
    glBufferData(GL_UNIFORM_BUFFER, sizeof(u), u, GL_STATIC_DRAW);
    glUniformBlockBinding(p, glGetUniformBlockIndex(p, "U"), 2);
    glBindBufferBase(GL_UNIFORM_BUFFER, 2, ub);
    // a strip, a restart, a triangle (to the fifth corner)
    const unsigned char indices[] = { 0, 1, 2, 3, 255, 2, 3, 4 };
    GLuint ib;
    glGenBuffers(1, &ib);
    glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, ib);
    glBufferData(GL_ELEMENT_ARRAY_BUFFER, sizeof(indices), indices, GL_STATIC_DRAW);
    glEnable(GL_PRIMITIVE_RESTART_FIXED_INDEX);
    glDrawElementsInstanced(GL_TRIANGLE_STRIP, 8, GL_UNSIGNED_BYTE, 0, 4);
    finish("instancing-ubo-restart", 2);
}

/** Transform feedback: what the vertex shader wrote, and how many primitives */
static void test_transform_feedback(void)
{
    target(0);
    fresh_vao();
    static const char *varyings[] = { "a", "b" };
    program2(VS_HEADER "in vec4 p; out vec4 a; out float b; void main() { a = p * 2.0 + vec4(1.0); b = float(gl_VertexID) * 0.5; gl_Position = p; }",
        FS_HEADER "out vec4 o; void main() { o = vec4(1.0); }", 2, varyings, GL_INTERLEAVED_ATTRIBS);
    const float p[] = { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24 };
    vbo(0, 4, p, sizeof(p));
    GLuint out;
    glGenBuffers(1, &out);
    glBindBuffer(GL_TRANSFORM_FEEDBACK_BUFFER, out);
    glBufferData(GL_TRANSFORM_FEEDBACK_BUFFER, 6 * 5 * 4, 0, GL_STREAM_READ);
    glBindBufferBase(GL_TRANSFORM_FEEDBACK_BUFFER, 0, out);
    GLuint q;
    glGenQueries(1, &q);
    glEnable(GL_RASTERIZER_DISCARD);
    glBeginQuery(GL_TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN, q);
    glBeginTransformFeedback(GL_TRIANGLES);
    glDrawArrays(GL_TRIANGLES, 0, 6);
    glEndTransformFeedback();
    glEndQuery(GL_TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN);
    glDisable(GL_RASTERIZER_DISCARD);
    GLuint written = 0;
    glGetQueryObjectuiv(q, GL_QUERY_RESULT, &written);
    static unsigned char data[6 * 5 * 4 + 4];
    void *mapped = glMapBufferRange(GL_TRANSFORM_FEEDBACK_BUFFER, 0, 6 * 5 * 4, GL_MAP_READ_BIT);
    if(mapped) memcpy(data, mapped, 6 * 5 * 4);
    glUnmapBuffer(GL_TRANSFORM_FEEDBACK_BUFFER);
    memcpy(data + 6 * 5 * 4, &written, 4);
    result("transform-feedback", data, sizeof(data), 0, 0);
    glDeleteBuffers(1, &out);
    glDeleteQueries(1, &q);
    finish(0, 0);
}

/** An occlusion query: how many samples passed (any) */
static void test_occlusion(void)
{
    target(1);
    fresh_vao();
    program(VS_HEADER "in vec2 p; void main() { gl_Position = vec4(p, 0.5, 1.0); }",
        FS_HEADER "out vec4 o; void main() { o = vec4(1.0); }");
    vbo(0, 2, quad, sizeof(quad));
    glEnable(GL_DEPTH_TEST);
    GLuint q[2];
    glGenQueries(2, q);
    glBeginQuery(GL_ANY_SAMPLES_PASSED, q[0]);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    glEndQuery(GL_ANY_SAMPLES_PASSED);
    // behind: nothing passes
    glDepthFunc(GL_GREATER);
    glBeginQuery(GL_ANY_SAMPLES_PASSED, q[1]);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    glEndQuery(GL_ANY_SAMPLES_PASSED);
    GLuint results[2] = { 7, 7 };
    glGetQueryObjectuiv(q[0], GL_QUERY_RESULT, &results[0]);
    glGetQueryObjectuiv(q[1], GL_QUERY_RESULT, &results[1]);
    result("occlusion-query", (unsigned char *)results, sizeof(results), 0, 0);
    glDeleteQueries(2, q);
    finish("occlusion-image", 0);
}

/** Copies: a blit (scaled, flipped), a copy into a texture */
static void test_blit(void)
{
    // a picture to copy from
    target(0);
    fresh_vao();
    program(VS_HEADER "in vec2 p; out vec2 t; void main() { t = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }",
        FS_HEADER "in vec2 t; out vec4 o; void main() { o = vec4(t, step(0.5, fract(t.x * 4.0)), 1.0); }");
    vbo(0, 2, quad, sizeof(quad));
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    GLuint source = fbo, source_color = fbo_color;
    target(0);
    glBindFramebuffer(GL_READ_FRAMEBUFFER, source);
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, fbo);
    glBlitFramebuffer(0, 0, 64, 64, 0, 0, 32, 32, GL_COLOR_BUFFER_BIT, GL_NEAREST);
    glBlitFramebuffer(0, 0, 64, 64, 32, 64, 64, 32, GL_COLOR_BUFFER_BIT, GL_NEAREST);
    glBlitFramebuffer(16, 16, 48, 48, 0, 32, 32, 64, GL_COLOR_BUFFER_BIT, GL_NEAREST);
    glBindFramebuffer(GL_FRAMEBUFFER, fbo);
    finish("blit", 1);
    glDeleteFramebuffers(1, &source);
    glDeleteTextures(1, &source_color);
}

/** Polygon offset, lines and points, a fan */
static void test_primitives(void)
{
    target(1);
    fresh_vao();
    GLuint p = program(VS_HEADER "in vec2 p; void main() { gl_PointSize = 1.0; gl_Position = vec4(p, 0.0, 1.0); }",
        FS_HEADER "uniform vec4 color; out vec4 o; void main() { o = color; }");
    GLint color = glGetUniformLocation(p, "color");
    const float shape[] = { 0, 0, 0.8f, 0, 0.5f, 0.6f, -0.2f, 0.8f, -0.7f, 0.3f, -0.6f, -0.5f, 0.1f, -0.8f };
    vbo(0, 2, shape, sizeof(shape));
    glUniform4f(color, 0.2f, 0.6f, 1, 1);
    glDrawArrays(GL_TRIANGLE_FAN, 0, 7);
    glUniform4f(color, 1, 1, 0, 1);
    glDrawArrays(GL_LINE_STRIP, 1, 6);
    glUniform4f(color, 1, 0, 1, 1);
    glDrawArrays(GL_POINTS, 0, 7);
    finish("fan-lines-points", 2);
}

/** Flat shading by the last vertex with indices: a strip with a restart, a fan */
static void test_flat_indexed(void)
{
    const char *vs = VS_HEADER "in vec2 p; flat out int k; void main() { k = gl_VertexID; gl_Position = vec4(p, 0.0, 1.0); }";
    const char *fs = FS_HEADER "flat in int k; out vec4 o; void main() { o = vec4(float(k % 3) / 2.0, float(k / 3) / 2.0, 0.5, 1.0); }";
    // a 3 x 3 grid of vertices, row by row
    float grid[18];
    for(int i = 0; i < 9; i++) { grid[2 * i] = (i % 3 - 1) * 0.9f; grid[2 * i + 1] = (i / 3 - 1) * 0.9f; }
    target(0);
    fresh_vao();
    program(vs, fs);
    vbo(0, 2, grid, sizeof(grid));
    const unsigned short strip[] = { 0, 3, 1, 4, 2, 5, 0xFFFF, 3, 6, 4, 7, 5, 8 };
    GLuint ib;
    glGenBuffers(1, &ib);
    glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, ib);
    glBufferData(GL_ELEMENT_ARRAY_BUFFER, sizeof(strip), strip, GL_STATIC_DRAW);
    glEnable(GL_PRIMITIVE_RESTART_FIXED_INDEX);
    glDrawElements(GL_TRIANGLE_STRIP, 13, GL_UNSIGNED_SHORT, 0);
    finish("flat-indexed-strip", 1);
    target(0);
    fresh_vao();
    program(vs, fs);
    vbo(0, 2, grid, sizeof(grid));
    // around the middle
    const unsigned short fan[] = { 4, 0, 1, 2, 5, 8, 7, 6, 3, 0 };
    glGenBuffers(1, &ib);
    glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, ib);
    glBufferData(GL_ELEMENT_ARRAY_BUFFER, sizeof(fan), fan, GL_STATIC_DRAW);
    glDrawElements(GL_TRIANGLE_FAN, 10, GL_UNSIGNED_SHORT, 0);
    finish("flat-indexed-fan", 1);
}


/** A depth texture drawn into, then sampled with a comparison */
static void test_shadow(void)
{
    // the depth: a gradient from left (0) to right (1)
    GLuint depth;
    glGenTextures(1, &depth);
    glBindTexture(GL_TEXTURE_2D, depth);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_DEPTH_COMPONENT24, W, H, 0, GL_DEPTH_COMPONENT, GL_UNSIGNED_INT, 0);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    GLuint f;
    glGenFramebuffers(1, &f);
    glBindFramebuffer(GL_FRAMEBUFFER, f);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_TEXTURE_2D, depth, 0);
    glViewport(0, 0, W, H);
    glClearDepthf(1.0f);
    glClear(GL_DEPTH_BUFFER_BIT);
    fresh_vao();
    program(VS_HEADER "in vec2 p; void main() { gl_Position = vec4(p, p.x, 1.0); }", FS_HEADER "out vec4 o; void main() { o = vec4(1.0); }");
    vbo(0, 2, quad, sizeof(quad));
    glEnable(GL_DEPTH_TEST);
    glDepthFunc(GL_ALWAYS);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    glDisable(GL_DEPTH_TEST);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glDeleteFramebuffers(1, &f);
    // compared with a reference that rises from bottom to top
    target(0);
    fresh_vao();
    GLuint p = program(VS_HEADER "in vec2 p; out vec2 t; void main() { t = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }",
        FS_HEADER "uniform highp sampler2DShadow s; in vec2 t; out vec4 o; void main() { float r = texture(s, vec3(t, t.y)); o = vec4(r, t.x, 0.0, 1.0); }");
    vbo(0, 2, quad, sizeof(quad));
    glBindTexture(GL_TEXTURE_2D, depth);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_COMPARE_MODE, GL_COMPARE_REF_TO_TEXTURE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_COMPARE_FUNC, GL_LEQUAL);
    glUniform1i(glGetUniformLocation(p, "s"), 0);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    // (along the diagonal the depth and the reference meet: rounding decides)
    finish("shadow-sampler", 2);
    glDeleteTextures(1, &depth);
}

/** A cube map, a 3D texture and an array, sampled */
static void test_texture_kinds(void)
{
    target(0);
    fresh_vao();
    GLuint p = program(VS_HEADER "in vec2 p; out vec2 t; void main() { t = p; gl_Position = vec4(p, 0.0, 1.0); }",
        FS_HEADER "uniform samplerCube c; uniform highp sampler3D v; uniform highp sampler2DArray a; in vec2 t; out vec4 o;\n"
        "void main() { vec2 u = t * 0.5 + 0.5;\n"
        "  if(t.y > 0.0) o = texture(c, vec3(t.x * 2.0, 1.0, t.y * 3.0 - 1.5));\n"
        "  else if(t.x < 0.0) o = texture(v, vec3(u.x * 2.0, u.y * 2.0, fract(u.x * 4.0)));\n"
        "  else o = texture(a, vec3(fract(u * 4.0), floor(u.x * 6.0) - 3.0)); }");
    vbo(0, 2, quad, sizeof(quad));
    GLuint tex[3];
    glGenTextures(3, tex);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_CUBE_MAP, tex[0]);
    for(int face = 0; face < 6; face++)
    {
        unsigned char texels[2 * 2 * 4];
        for(int i = 0; i < 4; i++)
        {
            texels[4 * i] = face & 1 ? 255 : 40 * i; texels[4 * i + 1] = face & 2 ? 255 : 60; texels[4 * i + 2] = face & 4 ? 255 : 30 * face; texels[4 * i + 3] = 255;
        }
        glTexImage2D(GL_TEXTURE_CUBE_MAP_POSITIVE_X + face, 0, GL_RGBA8, 2, 2, 0, GL_RGBA, GL_UNSIGNED_BYTE, texels);
    }
    glTexParameteri(GL_TEXTURE_CUBE_MAP, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_CUBE_MAP, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glActiveTexture(GL_TEXTURE0 + 1);
    glBindTexture(GL_TEXTURE_3D, tex[1]);
    static unsigned char volume[4 * 4 * 4 * 4];
    for(int i = 0; i < 64; i++) { volume[4 * i] = (i & 3) * 80; volume[4 * i + 1] = (i >> 2 & 3) * 80; volume[4 * i + 2] = (i >> 4) * 80; volume[4 * i + 3] = 255; }
    glTexImage3D(GL_TEXTURE_3D, 0, GL_RGBA8, 4, 4, 4, 0, GL_RGBA, GL_UNSIGNED_BYTE, volume);
    glTexParameteri(GL_TEXTURE_3D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_3D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_3D, GL_TEXTURE_WRAP_S, GL_REPEAT);
    glTexParameteri(GL_TEXTURE_3D, GL_TEXTURE_WRAP_T, GL_REPEAT);
    glActiveTexture(GL_TEXTURE0 + 2);
    glBindTexture(GL_TEXTURE_2D_ARRAY, tex[2]);
    static unsigned char layers[2 * 2 * 3 * 4];
    for(int i = 0; i < 12; i++) { layers[4 * i] = i / 4 == 0 ? 255 : 0; layers[4 * i + 1] = i / 4 == 1 ? 255 : 0; layers[4 * i + 2] = i / 4 == 2 ? 255 : (i & 3) * 60; layers[4 * i + 3] = 255; }
    glTexImage3D(GL_TEXTURE_2D_ARRAY, 0, GL_RGBA8, 2, 2, 3, 0, GL_RGBA, GL_UNSIGNED_BYTE, layers);
    glTexParameteri(GL_TEXTURE_2D_ARRAY, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D_ARRAY, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glUniform1i(glGetUniformLocation(p, "c"), 0);
    glUniform1i(glGetUniformLocation(p, "v"), 1);
    glUniform1i(glGetUniformLocation(p, "a"), 2);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    finish("cube-3d-array", 0);
    glActiveTexture(GL_TEXTURE0);
    glDeleteTextures(3, tex);
}

/** Each cube face in a stripe of its own (2 x 2 texels: its orientation), then each layer of an array */
static void test_cube_faces(void)
{
    target(0);
    fresh_vao();
    GLuint p = program(VS_HEADER "in vec2 p; out vec2 t; void main() { t = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }",
        FS_HEADER "uniform samplerCube c; uniform highp sampler2DArray a; in vec2 t; out vec4 o;\n"
        "void main() { float k = floor(t.x * 6.0); vec2 u = vec2(fract(t.x * 6.0), t.y * 2.0) * 1.6 - 0.8;\n"
        "  if(t.y < 0.5) { o = texture(a, vec3(fract(t.x * 4.0), t.y * 2.0, floor(t.x * 4.0))); return; }\n"
        "  u = vec2(fract(t.x * 6.0), t.y * 2.0 - 1.0) * 1.6 - 0.8;\n"
        "  vec3 d = k == 0.0 ? vec3(1.0, u.y, u.x) : k == 1.0 ? vec3(-1.0, u.y, u.x) : k == 2.0 ? vec3(u.x, 1.0, u.y) :\n"
        "    k == 3.0 ? vec3(u.x, -1.0, u.y) : k == 4.0 ? vec3(u.x, u.y, 1.0) : vec3(u.x, u.y, -1.0);\n"
        "  o = texture(c, d); }");
    vbo(0, 2, quad, sizeof(quad));
    GLuint tex[2];
    glGenTextures(2, tex);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_CUBE_MAP, tex[0]);
    for(int face = 0; face < 6; face++)
    {
        unsigned char texels[2 * 2 * 4];
        for(int i = 0; i < 4; i++)
        {
            texels[4 * i] = face * 40 + 35; texels[4 * i + 1] = i & 1 ? 230 : 20; texels[4 * i + 2] = i & 2 ? 230 : 20; texels[4 * i + 3] = 255;
        }
        glTexImage2D(GL_TEXTURE_CUBE_MAP_POSITIVE_X + face, 0, GL_RGBA8, 2, 2, 0, GL_RGBA, GL_UNSIGNED_BYTE, texels);
    }
    glTexParameteri(GL_TEXTURE_CUBE_MAP, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_CUBE_MAP, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glActiveTexture(GL_TEXTURE0 + 1);
    glBindTexture(GL_TEXTURE_2D_ARRAY, tex[1]);
    static unsigned char layers[2 * 2 * 4 * 4];
    for(int i = 0; i < 16; i++) { layers[4 * i] = (i / 4) * 70 + 20; layers[4 * i + 1] = i & 1 ? 230 : 20; layers[4 * i + 2] = i & 2 ? 230 : 20; layers[4 * i + 3] = 255; }
    glTexImage3D(GL_TEXTURE_2D_ARRAY, 0, GL_RGBA8, 2, 2, 4, 0, GL_RGBA, GL_UNSIGNED_BYTE, layers);
    glTexParameteri(GL_TEXTURE_2D_ARRAY, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D_ARRAY, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glUniform1i(glGetUniformLocation(p, "c"), 0);
    glUniform1i(glGetUniformLocation(p, "a"), 1);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    finish("cube-faces-array-layers", 0);
    glActiveTexture(GL_TEXTURE0);
    glDeleteTextures(2, tex);
}

/** An integer render target, read back as integers */
static void test_integer_target(void)
{
    target(0);
    GLuint t;
    glGenTextures(1, &t);
    glBindTexture(GL_TEXTURE_2D, t);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA32UI, 32, 32, 0, GL_RGBA_INTEGER, GL_UNSIGNED_INT, 0);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, t, 0);
    const GLuint clear[] = { 7, 70000, 0xFFFFFFF0u, 3 };
    glClearBufferuiv(GL_COLOR, 0, clear);
    glViewport(0, 0, 32, 32);
    fresh_vao();
    program(VS_HEADER "in vec2 p; flat out uint k; void main() { k = uint(gl_VertexID) * 1000u + 5u; gl_Position = vec4(p * 0.5, 0.0, 1.0); }",
        FS_HEADER "flat in uint k; out uvec4 o; void main() { o = uvec4(k, uint(gl_FragCoord.x) << 20, 0x80000000u | uint(gl_FragCoord.y), 9u); }");
    vbo(0, 2, quad, sizeof(quad));
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    glPixelStorei(GL_PACK_ALIGNMENT, 4);
    glReadPixels(0, 0, 32, 32, GL_RGBA_INTEGER, GL_UNSIGNED_INT, pixels);
    result("integer-target", pixels, 32 * 32 * 16, 0, 0);
    glViewport(0, 0, W, H);
    finish(0, 0);
    glDeleteTextures(1, &t);
}

// ---------------------------------------------------------------------------
// OpenGL 3.3 core

#define VS33 "#version 330 core\n"

/** A geometry shader: points into quads, with a varying of its own */
static void test_geometry_shader(void)
{
    target(0);
    fresh_vao();
    program_gs(VS33 "in vec2 p; out vec3 c; void main() { c = vec3(p * 0.5 + 0.5, 0.25); gl_Position = vec4(p, 0.0, 1.0); }",
        VS33 "layout(points) in; layout(triangle_strip, max_vertices = 4) out; in vec3 c[]; out vec3 color; out vec2 corner;\n"
        "void main() { for(int i = 0; i < 4; i++) { vec2 d = vec2(i & 1, i >> 1) * 2.0 - 1.0; corner = d; color = c[0];\n"
        "  gl_Position = gl_in[0].gl_Position + vec4(d * 0.15, 0.0, 0.0); EmitVertex(); } EndPrimitive(); }",
        VS33 "in vec3 color; in vec2 corner; out vec4 o; void main() { o = vec4(color, 1.0) * (1.0 - 0.5 * length(corner) / 1.5); }");
    const float points[] = { -0.6f, -0.6f, 0.6f, -0.5f, 0.0f, 0.0f, -0.5f, 0.6f, 0.6f, 0.6f };
    vbo(0, 2, points, sizeof(points));
    glDrawArrays(GL_POINTS, 0, 5);
    finish("geometry-shader", 2);
}

/** gl_ClipDistance: the triangle cut along a line */
static void test_clip_distance(void)
{
    target(0);
    fresh_vao();
    program(VS33 "in vec2 p; out vec3 c; void main() { c = vec3(1.0, p * 0.5 + 0.5); gl_ClipDistance[0] = p.x + p.y * 0.5; gl_Position = vec4(p, 0.0, 1.0); }",
        VS33 "in vec3 c; out vec4 o; void main() { o = vec4(c, 1.0); }");
    glEnable(GL_CLIP_DISTANCE0);
    const float p[] = { -0.9f, -0.9f, 0.9f, -0.9f, 0.0f, 0.9f };
    vbo(0, 2, p, sizeof(p));
    glDrawArrays(GL_TRIANGLES, 0, 3);
    glDisable(GL_CLIP_DISTANCE0);
    finish("clip-distance", 2);
}

/** Rectangle textures, buffer textures, texture() on an integer texture */
static void test_texture_33(void)
{
    target(0);
    fresh_vao();
    GLuint p = program(VS33 "in vec2 p; out vec2 t; void main() { t = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }",
        VS33 "uniform sampler2DRect r; uniform samplerBuffer b; uniform isampler2D i; in vec2 t; out vec4 o;\n"
        "void main() { if(t.y < 0.5) o = texture(r, t * vec2(5.0, 6.0));\n"
        "  else if(t.x < 0.5) o = texelFetch(b, int(t.x * 16.0));\n"
        "  else o = vec4(texture(i, t)) / 255.0; }");
    vbo(0, 2, quad, sizeof(quad));
    GLuint tex[3], buffer;
    glGenTextures(3, tex);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_RECTANGLE, tex[0]);
    unsigned char rect[5 * 3 * 4];
    for(int k = 0; k < 15; k++) { rect[4 * k] = k * 17; rect[4 * k + 1] = 255 - k * 17; rect[4 * k + 2] = k & 1 ? 200 : 50; rect[4 * k + 3] = 255; }
    glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
    glTexImage2D(GL_TEXTURE_RECTANGLE, 0, GL_RGBA8, 5, 3, 0, GL_RGBA, GL_UNSIGNED_BYTE, rect);
    glTexParameteri(GL_TEXTURE_RECTANGLE, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_RECTANGLE, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glActiveTexture(GL_TEXTURE0 + 1);
    float values[16 * 4];
    for(int k = 0; k < 64; k++) values[k] = (k * 7 % 16) / 15.0f;
    glGenBuffers(1, &buffer);
    glBindBuffer(GL_TEXTURE_BUFFER, buffer);
    glBufferData(GL_TEXTURE_BUFFER, sizeof(values), values, GL_STATIC_DRAW);
    glBindTexture(GL_TEXTURE_BUFFER, tex[1]);
    glTexBuffer(GL_TEXTURE_BUFFER, GL_RGBA32F, buffer);
    glActiveTexture(GL_TEXTURE0 + 2);
    glBindTexture(GL_TEXTURE_2D, tex[2]);
    signed char ints[4 * 4 * 4];
    for(int k = 0; k < 64; k++) ints[k] = (k * 13) & 127;
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8I, 4, 4, 0, GL_RGBA_INTEGER, GL_BYTE, ints);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glUniform1i(glGetUniformLocation(p, "r"), 0);
    glUniform1i(glGetUniformLocation(p, "b"), 1);
    glUniform1i(glGetUniformLocation(p, "i"), 2);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    finish("rect-buffer-integer-textures", 1);
    glActiveTexture(GL_TEXTURE0);
    glDeleteTextures(3, tex);
    glDeleteBuffers(1, &buffer);
}

/** A multisampled texture drawn into, then read sample by sample */
static void test_multisample_texture(void)
{
    GLuint ms, f;
    glGenTextures(1, &ms);
    glBindTexture(GL_TEXTURE_2D_MULTISAMPLE, ms);
    glTexImage2DMultisample(GL_TEXTURE_2D_MULTISAMPLE, 4, GL_RGBA8, W, H, 1);
    glGenFramebuffers(1, &f);
    glBindFramebuffer(GL_FRAMEBUFFER, f);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D_MULTISAMPLE, ms, 0);
    glViewport(0, 0, W, H);
    glClearColor(0.25f, 0.5f, 0.75f, 1.0f);
    glClear(GL_COLOR_BUFFER_BIT);
    fresh_vao();
    program(VS33 "in vec2 p; void main() { gl_Position = vec4(p * 0.5, 0.0, 1.0); }", VS33 "out vec4 o; void main() { o = vec4(1.0, 0.0, 0.5, 1.0); }");
    vbo(0, 2, quad, sizeof(quad));
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glDeleteFramebuffers(1, &f);
    target(0);
    fresh_vao();
    program(VS33 "in vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }",
        VS33 "uniform sampler2DMS s; out vec4 o; void main() { ivec2 at = ivec2(gl_FragCoord.xy); o = vec4(0.0);\n"
        "  for(int i = 0; i < 4; i++) o += texelFetch(s, at, i) * 0.25; }");
    vbo(0, 2, quad, sizeof(quad));
    glBindTexture(GL_TEXTURE_2D_MULTISAMPLE, ms);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    // (the quad's edges: sample positions differ between GPUs)
    finish("multisample-texture", 2);
    glDeleteTextures(1, &ms);
}

static void run_gl33(EGLDisplay display)
{
    eglBindAPI(EGL_OPENGL_API);
    const EGLint attributes[] = { EGL_CONTEXT_MAJOR_VERSION, 3, EGL_CONTEXT_MINOR_VERSION, 3,
        EGL_CONTEXT_OPENGL_PROFILE_MASK, EGL_CONTEXT_OPENGL_CORE_PROFILE_BIT, EGL_NONE };
    EGLContext context = eglCreateContext(display, 0, 0, attributes);
    if(!context || !eglMakeCurrent(display, 0, 0, context))
    {
        printf("GLTEST gl33 FAIL no context (%x)\n", eglGetError());
        failures++;
        return;
    }
    vao = 0;
    printf("GLTEST renderer %s, %s\n", glGetString(GL_RENDERER), glGetString(GL_VERSION));
    test_geometry_shader();
    test_clip_distance();
    test_texture_33();
    test_multisample_texture();
}


// ---------------------------------------------------------------------------
// OpenGL 4.3 core

#define VS43 "#version 430 core\n"

static GLuint program_stages(const GLenum *types, const char *const *sources, int count)
{
    GLuint p = glCreateProgram();
    for(int i = 0; i < count; i++)
    {
        GLuint s = shader(types[i], sources[i]);
        glAttachShader(p, s);
        glDeleteShader(s);
    }
    glLinkProgram(p);
    GLint ok = 0;
    glGetProgramiv(p, GL_LINK_STATUS, &ok);
    if(!ok)
    {
        char log[1024];
        glGetProgramInfoLog(p, sizeof(log), 0, log);
        printf("link: %s\n", log);
    }
    glUseProgram(p);
    return p;
}

/** A compute shader: shared memory, a barrier, a storage buffer with an atomic, an image */
static void test_compute(void)
{
    const char *cs = VS43 "layout(local_size_x = 8, local_size_y = 8) in;\n"
        "layout(std430, binding = 0) buffer Out { uint count; uint data[]; };\n"
        "layout(rgba8, binding = 0) writeonly uniform image2D img;\n"
        "shared uint tile[64];\n"
        "uniform uint scale;\n"
        "void main() { uvec2 g = gl_GlobalInvocationID.xy; uint i = gl_LocalInvocationIndex;\n"
        "  tile[i] = g.x * scale + g.y; barrier();\n"
        "  uint v = tile[63u - i];\n"
        "  atomicAdd(count, 1u);\n"
        "  data[g.y * 64u + g.x] = v + gl_WorkGroupID.x * 1000u + gl_NumWorkGroups.x * 100000u;\n"
        "  imageStore(img, ivec2(g), vec4(vec2(g) / 64.0, float(i) / 64.0, 1.0)); }";
    GLenum type = GL_COMPUTE_SHADER;
    GLuint p = program_stages(&type, &cs, 1);
    glUniform1ui(glGetUniformLocation(p, "scale"), 3);
    target(0);
    glBindImageTexture(0, fbo_color, 0, 0, 0, GL_WRITE_ONLY, GL_RGBA8);
    GLuint b;
    glGenBuffers(1, &b);
    glBindBuffer(GL_SHADER_STORAGE_BUFFER, b);
    static unsigned int zeros[1 + 64 * 64];
    glBufferData(GL_SHADER_STORAGE_BUFFER, sizeof(zeros), zeros, GL_STREAM_READ);
    glBindBufferBase(GL_SHADER_STORAGE_BUFFER, 0, b);
    glUseProgram(p);
    glDispatchCompute(8, 8, 1);
    glMemoryBarrier(GL_ALL_BARRIER_BITS);
    static unsigned char data[16384];
    const void *mapped = glMapBufferRange(GL_SHADER_STORAGE_BUFFER, 0, 16384, GL_MAP_READ_BIT);
    if(mapped) memcpy(data, mapped, 16384);
    glUnmapBuffer(GL_SHADER_STORAGE_BUFFER);
    result("compute-buffer", data, 16384, 0, 0);
    glDeleteBuffers(1, &b);
    finish("compute-image", 0);
}

/** A fragment shader with a storage buffer (atomics) and an image it reads */
static void test_fragment_storage(void)
{
    // an image to read: a gradient
    GLuint img;
    glGenTextures(1, &img);
    glBindTexture(GL_TEXTURE_2D, img);
    glTexStorage2D(GL_TEXTURE_2D, 1, GL_R32UI, 16, 16);
    static unsigned int texels[256];
    for(int i = 0; i < 256; i++) texels[i] = i * 977u;
    glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, 16, 16, GL_RED_INTEGER, GL_UNSIGNED_INT, texels);
    target(0);
    fresh_vao();
    GLenum types[2] = { GL_VERTEX_SHADER, GL_FRAGMENT_SHADER };
    const char *sources[2] = {
        VS43 "in vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }",
        VS43 "layout(std430, binding = 1) buffer Counts { uint total; uint rows[64]; };\n"
        "layout(r32ui, binding = 1) readonly uniform uimage2D src; out vec4 o;\n"
        "void main() { ivec2 at = ivec2(gl_FragCoord.xy); uint v = imageLoad(src, at / 4).x;\n"
        "  atomicAdd(total, 1u); atomicMax(rows[at.y], uint(at.x));\n"
        "  o = vec4(float(v & 255u) / 255.0, float((v >> 8) & 255u) / 255.0, 0.25, 1.0); }" };
    program_stages(types, sources, 2);
    vbo(0, 2, quad, sizeof(quad));
    glBindImageTexture(1, img, 0, 0, 0, GL_READ_ONLY, GL_R32UI);
    GLuint b;
    glGenBuffers(1, &b);
    glBindBuffer(GL_SHADER_STORAGE_BUFFER, b);
    static unsigned int zeros[65];
    glBufferData(GL_SHADER_STORAGE_BUFFER, sizeof(zeros), zeros, GL_STREAM_READ);
    glBindBufferBase(GL_SHADER_STORAGE_BUFFER, 1, b);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    glMemoryBarrier(GL_ALL_BARRIER_BITS);
    static unsigned char data[65 * 4];
    const void *mapped = glMapBufferRange(GL_SHADER_STORAGE_BUFFER, 0, sizeof(data), GL_MAP_READ_BIT);
    if(mapped) memcpy(data, mapped, sizeof(data));
    glUnmapBuffer(GL_SHADER_STORAGE_BUFFER);
    result("fragment-storage-buffer", data, sizeof(data), 0, 0);
    glDeleteBuffers(1, &b);
    finish("fragment-image-load", 1);
    glDeleteTextures(1, &img);
}

/** Tessellation: a quad patch into a grid, colored by where its vertices are */
static void test_tessellation(void)
{
    target(0);
    fresh_vao();
    GLenum types[4] = { GL_VERTEX_SHADER, GL_TESS_CONTROL_SHADER, GL_TESS_EVALUATION_SHADER, GL_FRAGMENT_SHADER };
    const char *sources[4] = {
        VS43 "in vec2 p; out vec2 v; void main() { v = p; }",
        VS43 "layout(vertices = 4) out; in vec2 v[]; out vec2 c[]; patch out float shade;\n"
        "void main() { c[gl_InvocationID] = v[gl_InvocationID] * 0.9;\n"
        "  if(gl_InvocationID == 0) { gl_TessLevelOuter[0] = 2.0; gl_TessLevelOuter[1] = 3.0; gl_TessLevelOuter[2] = 4.0;\n"
        "    gl_TessLevelOuter[3] = 5.0; gl_TessLevelInner[0] = 4.0; gl_TessLevelInner[1] = 3.0; shade = 0.75; } }",
        VS43 "layout(quads, equal_spacing, ccw) in; in vec2 c[]; patch in float shade; out vec3 color;\n"
        "void main() { vec2 a = mix(c[0], c[1], gl_TessCoord.x), b = mix(c[3], c[2], gl_TessCoord.x);\n"
        "  color = vec3(gl_TessCoord.xy, shade); gl_Position = vec4(mix(a, b, gl_TessCoord.y), 0.0, 1.0); }",
        VS43 "in vec3 color; out vec4 o; void main() { o = vec4(color, 1.0); }" };
    program_stages(types, sources, 4);
    const float corners[] = { -1, -1, 1, -1, 1, 1, -1, 1 };
    vbo(0, 2, corners, sizeof(corners));
    glPatchParameteri(GL_PATCH_VERTICES, 4);
    glDrawArrays(GL_PATCHES, 0, 4);
    finish("tessellation", 2);
}

/** Doubles (GX computes them as floats: values floats hold exactly) */
static void test_doubles(void)
{
    target(0);
    fresh_vao();
    GLenum types[2] = { GL_VERTEX_SHADER, GL_FRAGMENT_SHADER };
    const char *sources[2] = {
        VS43 "in vec2 p; out vec2 t; void main() { t = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }",
        VS43 "uniform double k; in vec2 t; out vec4 o;\n"
        "void main() { dvec2 d = dvec2(t) * k + dvec2(0.25, 0.5); double m = max(d.x, d.y) - floor(d.y);\n"
        "  o = vec4(vec2(fract(d)), float(m * 0.5), 1.0); }" };
    GLuint p = program_stages(types, sources, 2);
    glUniform1d(glGetUniformLocation(p, "k"), 2.0);
    vbo(0, 2, quad, sizeof(quad));
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    finish("doubles", 2);
}

/** Indirect draws, with and without indices; texture gathers with offsets */
static void test_indirect_gather(void)
{
    target(0);
    fresh_vao();
    GLenum types[2] = { GL_VERTEX_SHADER, GL_FRAGMENT_SHADER };
    const char *sources[2] = {
        VS43 "in vec2 p; out vec2 t; flat out int instance; void main() { t = p * 0.5 + 0.5; instance = gl_InstanceID;\n"
        "  gl_Position = vec4(p * 0.45 + vec2(gl_InstanceID % 2, gl_InstanceID / 2) - 0.5, 0.0, 1.0); }",
        VS43 "uniform sampler2D s; in vec2 t; flat in int instance; out vec4 o;\n"
        "void main() { vec4 g = textureGatherOffset(s, t, ivec2(instance - 1, 1), 1);\n"
        "  o = vec4(g.xy, g.z * 0.5 + g.w * 0.5, 1.0); }" };
    GLuint p = program_stages(types, sources, 2);
    vbo(0, 2, quad, sizeof(quad));
    GLuint tex;
    glGenTextures(1, &tex);
    glBindTexture(GL_TEXTURE_2D, tex);
    static unsigned char texels[8 * 8 * 4];
    for(int i = 0; i < 64; i++) { texels[4 * i] = i * 4; texels[4 * i + 1] = 255 - i * 4; texels[4 * i + 2] = (i * 37) & 255; texels[4 * i + 3] = 255; }
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, 8, 8, 0, GL_RGBA, GL_UNSIGNED_BYTE, texels);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glUniform1i(glGetUniformLocation(p, "s"), 0);
    // two instances without indices (from the second), two with
    const unsigned int arrays[4] = { 4, 2, 0, 0 };
    const unsigned int elements[5] = { 4, 2, 0, 0, 2 };
    const unsigned short indices[4] = { 0, 1, 2, 3 };
    GLuint ib, args[2];
    glGenBuffers(1, &ib);
    glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, ib);
    glBufferData(GL_ELEMENT_ARRAY_BUFFER, sizeof(indices), indices, GL_STATIC_DRAW);
    glGenBuffers(2, args);
    glBindBuffer(GL_DRAW_INDIRECT_BUFFER, args[0]);
    glBufferData(GL_DRAW_INDIRECT_BUFFER, sizeof(arrays), arrays, GL_STATIC_DRAW);
    glDrawArraysIndirect(GL_TRIANGLE_STRIP, 0);
    glBindBuffer(GL_DRAW_INDIRECT_BUFFER, args[1]);
    glBufferData(GL_DRAW_INDIRECT_BUFFER, sizeof(elements), elements, GL_STATIC_DRAW);
    glDrawElementsIndirect(GL_TRIANGLE_STRIP, GL_UNSIGNED_SHORT, 0);
    finish("indirect-gather", 1);
    glDeleteTextures(1, &tex);
}

static int has_extension(const char *name)
{
    GLint count = 0;
    glGetIntegerv(GL_NUM_EXTENSIONS, &count);
    for(int i = 0; i < count; i++)
    {
        const GLubyte *e = glGetStringi(GL_EXTENSIONS, i);
        if(e && !strcmp((const char *)e, name)) return 1;
    }
    return 0;
}

/** Wait until the GPU has done everything so far (a fence, as persistent mappings need) */
static void wait_gpu(void)
{
    GLsync sync = glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
    glClientWaitSync(sync, GL_SYNC_FLUSH_COMMANDS_BIT, 5000000000ul);
    glDeleteSync(sync);
}

/**
 * ARB_buffer_storage: persistent, coherent mappings (virtio-gpu's host
 * visible memory). Vertices written through a mapping while it stays mapped,
 * in pages far apart and again after the GPU used them; a compute shader that
 * reads its input through one and writes its output that the CPU reads from it.
 */
static void test_buffer_storage(void)
{
    if(!has_extension("GL_ARB_buffer_storage"))
    {
        printf("GLTEST buffer-storage skipped (no GL_ARB_buffer_storage)\n");
        return;
    }
    target(0);
    fresh_vao();
    GLenum types[2] = { GL_VERTEX_SHADER, GL_FRAGMENT_SHADER };
    const char *sources[2] = {
        VS43 "layout(location = 0) in vec2 p; layout(location = 1) in vec3 c; out vec3 v;\n"
        "void main() { v = c; gl_Position = vec4(p, 0.0, 1.0); }",
        VS43 "in vec3 v; out vec4 o; void main() { o = vec4(v, 1.0); }" };
    program_stages(types, sources, 2);
    const int size = 65536;
    const GLbitfield flags = GL_MAP_WRITE_BIT | GL_MAP_PERSISTENT_BIT | GL_MAP_COHERENT_BIT;
    GLuint b;
    glGenBuffers(1, &b);
    glBindBuffer(GL_ARRAY_BUFFER, b);
    glBufferStorage(GL_ARRAY_BUFFER, size, 0, flags);
    float *mapped = glMapBufferRange(GL_ARRAY_BUFFER, 0, size, flags);
    if(!mapped)
    {
        printf("GLTEST buffer-storage FAIL no mapping (%x)\n", glGetError());
        failures++;
        return;
    }
    glEnableVertexAttribArray(0);
    glEnableVertexAttribArray(1);
    // a triangle: x, y, r, g, b each vertex
    const float tri[3][15] = {
        { -0.9f, -0.9f, 1, 0, 0, -0.1f, -0.9f, 1, 0, 0, -0.5f, -0.1f, 1, 1, 0 },
        { 0.1f, -0.9f, 0, 1, 0, 0.9f, -0.9f, 0, 1, 0, 0.5f, -0.1f, 0, 1, 1 },
        { -0.4f, 0.1f, 0, 0, 1, 0.4f, 0.1f, 0, 0, 1, 0.0f, 0.9f, 1, 0, 1 },
    };
    // the first at the start, the second 32 KiB in
    memcpy(mapped, tri[0], sizeof(tri[0]));
    memcpy((char *)mapped + 32768, tri[1], sizeof(tri[1]));
    for(int k = 0; k < 2; k++)
    {
        const long at = k ? 32768 : 0;
        glVertexAttribPointer(0, 2, GL_FLOAT, 0, 20, (const void *)at);
        glVertexAttribPointer(1, 3, GL_FLOAT, 0, 20, (const void *)(at + 8));
        glDrawArrays(GL_TRIANGLES, 0, 3);
    }
    // the first one's bytes again, once the GPU has drawn it
    wait_gpu();
    memcpy(mapped, tri[2], sizeof(tri[2]));
    glVertexAttribPointer(0, 2, GL_FLOAT, 0, 20, (const void *)0);
    glVertexAttribPointer(1, 3, GL_FLOAT, 0, 20, (const void *)8);
    glDrawArrays(GL_TRIANGLES, 0, 3);
    finish("buffer-storage-vertices", 2);
    glDeleteBuffers(1, &b);

    // compute: in[i] written by the CPU, out[i] = in[i] * 3 + i read by it
    const char *cs = VS43 "layout(local_size_x = 64) in;\n"
        "layout(std430, binding = 2) buffer Data { uint in_[1024]; uint pad[1024]; uint out_[1024]; };\n"
        "void main() { uint i = gl_GlobalInvocationID.x; out_[i] = in_[i] * 3u + i; }";
    GLenum type = GL_COMPUTE_SHADER;
    program_stages(&type, &cs, 1);
    const GLbitfield rw = GL_MAP_READ_BIT | GL_MAP_WRITE_BIT | GL_MAP_PERSISTENT_BIT | GL_MAP_COHERENT_BIT;
    glGenBuffers(1, &b);
    glBindBuffer(GL_SHADER_STORAGE_BUFFER, b);
    glBufferStorage(GL_SHADER_STORAGE_BUFFER, 3 * 4096, 0, rw);
    unsigned int *words = glMapBufferRange(GL_SHADER_STORAGE_BUFFER, 0, 3 * 4096, rw);
    if(!words)
    {
        printf("GLTEST buffer-storage FAIL no storage mapping (%x)\n", glGetError());
        failures++;
        return;
    }
    glBindBufferBase(GL_SHADER_STORAGE_BUFFER, 2, b);
    static unsigned char data[2 * 4096];
    for(int round = 0; round < 2; round++)
    {
        for(int i = 0; i < 1024; i++) words[i] = i * 7u + round * 100000u;
        glDispatchCompute(16, 1, 1);
        glMemoryBarrier(GL_CLIENT_MAPPED_BUFFER_BARRIER_BIT);
        wait_gpu();
        memcpy(data + round * 4096, words + 2048, 4096);
    }
    glUnmapBuffer(GL_SHADER_STORAGE_BUFFER);
    result("buffer-storage-compute", data, sizeof(data), 0, 0);
    glDeleteBuffers(1, &b);
}

static void run_gl43(EGLDisplay display)
{
    const EGLint attributes[] = { EGL_CONTEXT_MAJOR_VERSION, 4, EGL_CONTEXT_MINOR_VERSION, 3,
        EGL_CONTEXT_OPENGL_PROFILE_MASK, EGL_CONTEXT_OPENGL_CORE_PROFILE_BIT, EGL_NONE };
    EGLContext context = eglCreateContext(display, 0, 0, attributes);
    if(!context || !eglMakeCurrent(display, 0, 0, context))
    {
        // (a driver without OpenGL 4.3: these are not its tests)
        printf("GLTEST gl43 skipped (%x)\n", eglGetError());
        return;
    }
    vao = 0;
    printf("GLTEST renderer %s, %s\n", glGetString(GL_RENDERER), glGetString(GL_VERSION));
    test_compute();
    test_fragment_storage();
    test_doubles();
    test_indirect_gather();
    test_tessellation();
    test_buffer_storage();
}

int main(int argc, char **argv, char **envp)
{
    mode_ref = argc > 1 && !strcmp(argv[1], "ref");
    mkdir(dir, 0755);
    EGLDisplay display = eglGetPlatformDisplay(EGL_PLATFORM_SURFACELESS_MESA, 0, 0);
    EGLint major, minor;
    if(!display || !eglInitialize(display, &major, &minor))
    {
        printf("GLTEST egl FAIL no display (%x)\n", eglGetError());
        return 1;
    }
    eglBindAPI(EGL_OPENGL_ES_API);
    const EGLint attributes[] = { EGL_CONTEXT_MAJOR_VERSION, 3, EGL_CONTEXT_MINOR_VERSION, 0, EGL_NONE };
    EGLContext context = eglCreateContext(display, 0, 0, attributes);
    if(!context || !eglMakeCurrent(display, 0, 0, context))
    {
        printf("GLTEST egl FAIL no context (%x)\n", eglGetError());
        return 1;
    }
#define LOAD(ret, name, args) name = (ret (*) args)eglGetProcAddress(#name);
    GL_FUNCTIONS(LOAD)
    printf("GLTEST renderer %s, %s\n", glGetString(GL_RENDERER), glGetString(GL_VERSION));
    test_clear();
    test_triangle();
    test_cull();
    test_depth_stencil();
    test_blend();
    test_texture();
    test_swizzle();
    test_mrt();
    test_instancing();
    test_transform_feedback();
    test_occlusion();
    test_blit();
    test_primitives();
    test_flat_indexed();
    test_shadow();
    test_texture_kinds();
    test_cube_faces();
    test_integer_target();
    run_gl33(display);
    run_gl43(display);
    printf("GLTEST done %d failures\n", failures);
    fflush(0);
    return 0;
}
