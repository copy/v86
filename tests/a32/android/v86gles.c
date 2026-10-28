// A NativeActivity that draws fixed GLES 2.0 and GLES 1.1 scenes into its
// window and reads them back (docs/gles-proxy-plan.md E4, the self-built
// test APK): each scene logs "V86_GLES <scene> <x>,<y>=<r>,<g>,<b>,<a> ..."
// for the pixels tests/a32/android_gles.mjs checks, then "V86_GLES_DONE".
// The scenes: a clear and a scissored clear; a textured quad (RGBA, nearest)
// over a blended triangle; render to a texture through a framebuffer, then
// sampled; an ETC1 texture; GLES 1.1: glOrthof with a vertex array and the
// current color, a texture modulated by a color array, a directional light,
// glDrawTexiOES; EGL: swap intervals, a fence sync, a pbuffer surface, a
// texture shared between two contexts. GLES 3.0 (docs/gles3-plan.md L4), with
// a host that announces it: instanced quads from a vertex array object
// colored by a uniform block, two draw buffers and glClearBufferfv, an
// unsigned integer buffer read as integers, transform feedback mapped, a 3D
// texture's layer, a multisampled renderbuffer resolved by a blit, and a
// read into a pixel pack buffer mapped.
#define GL_GLEXT_PROTOTYPES
#include <android/log.h>
#include <android/native_activity.h>
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>
#include <GLES/gl.h>
#include <GLES/glext.h>
#include <stdio.h>
#include <string.h>
#include <pthread.h>

#define LOG(...) __android_log_print(ANDROID_LOG_INFO, "v86gles", __VA_ARGS__)

static EGLDisplay display;
static EGLSurface surface;
static EGLConfig config;
static int width, height;

/** a few pixels of the window, logged (GL's rows: y from the bottom) */
static void report(const char* scene, const int* points, int count)
{
    char line[512];
    int at = snprintf(line, sizeof line, "V86_GLES %s", scene);
    for(int i = 0; i < count; i++)
    {
        unsigned char p[4];
        glReadPixels(points[2 * i], points[2 * i + 1], 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, p);
        at += snprintf(line + at, sizeof line - at, " %d,%d=%d,%d,%d,%d", points[2 * i], points[2 * i + 1], p[0], p[1], p[2], p[3]);
    }
    LOG("%s glerror=%x", line, glGetError());
}

static GLuint compile(GLenum type, const char* source)
{
    GLuint shader = glCreateShader(type);
    glShaderSource(shader, 1, &source, 0);
    glCompileShader(shader);
    GLint ok = 0;
    glGetShaderiv(shader, GL_COMPILE_STATUS, &ok);
    if(!ok)
    {
        char log[512];
        glGetShaderInfoLog(shader, sizeof log, 0, log);
        LOG("V86_GLES compile failed: %s", log);
    }
    return shader;
}

static void gles2_scenes(void)
{
    const char* vs = "attribute vec2 p; attribute vec2 uv; varying vec2 v; void main() { v = uv; gl_Position = vec4(p, 0.0, 1.0); }";
    const char* fs = "precision mediump float; uniform sampler2D t; uniform vec4 c; uniform float k; varying vec2 v; "
        "void main() { gl_FragColor = mix(c, texture2D(t, v), k); }";
    GLuint program = glCreateProgram();
    glAttachShader(program, compile(GL_VERTEX_SHADER, vs));
    glAttachShader(program, compile(GL_FRAGMENT_SHADER, fs));
    glBindAttribLocation(program, 0, "p");
    glBindAttribLocation(program, 1, "uv");
    glLinkProgram(program);
    glUseProgram(program);
    GLint c = glGetUniformLocation(program, "c"), k = glGetUniformLocation(program, "k"), t = glGetUniformLocation(program, "t");
    glUniform1i(t, 0);
    glViewport(0, 0, width, height);

    // a clear, then a scissored one (the bottom left quarter)
    glClearColor(1, 0, 0, 1);
    glClear(GL_COLOR_BUFFER_BIT);
    glEnable(GL_SCISSOR_TEST);
    glScissor(0, 0, width / 2, height / 2);
    glClearColor(0, 1, 0, 1);
    glClear(GL_COLOR_BUFFER_BIT);
    glDisable(GL_SCISSOR_TEST);
    int clear_points[] = { 10, 10, width - 10, height - 10 };
    report("clear", clear_points, 2);

    // a blended triangle (half blue over red), then a 2 by 2 texture on the right half
    glClearColor(1, 0, 0, 1);
    glClear(GL_COLOR_BUFFER_BIT);
    const float tri[] = { -1, -1, 0, -1, -1, 1 };
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 0, tri);
    glVertexAttrib2f(1, 0, 0);
    glEnable(GL_BLEND);
    glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    glUniform4f(c, 0, 0, 1, 0.5f);
    glUniform1f(k, 0);
    glDrawArrays(GL_TRIANGLES, 0, 3);
    glDisable(GL_BLEND);
    GLuint texture;
    glGenTextures(1, &texture);
    glBindTexture(GL_TEXTURE_2D, texture);
    const unsigned char texels[] = { 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255 };
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 2, 2, 0, GL_RGBA, GL_UNSIGNED_BYTE, texels);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    const float quad[] = { 0, -1, 0, 0, 1, -1, 1, 0, 1, 1, 1, 1, 0, 1, 0, 1 };
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 16, quad);
    glEnableVertexAttribArray(1);
    glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 16, quad + 2);
    glUniform1f(k, 1);
    glDrawArrays(GL_TRIANGLE_FAN, 0, 4);
    int draw_points[] = { 10, 10, width / 2 + 10, 10, width - 10, 10, width / 2 + 10, height - 10, width - 10, height - 10, 10, height - 10 };
    report("draw", draw_points, 6);

    // render to a texture (yellow, a cyan triangle), then sample it over the window
    GLuint target, framebuffer;
    glGenTextures(1, &target);
    glBindTexture(GL_TEXTURE_2D, target);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 64, 64, 0, GL_RGBA, GL_UNSIGNED_BYTE, 0);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glGenFramebuffers(1, &framebuffer);
    glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, target, 0);
    LOG("V86_GLES fbo status=%x", glCheckFramebufferStatus(GL_FRAMEBUFFER));
    glViewport(0, 0, 64, 64);
    glClearColor(1, 1, 0, 1);
    glClear(GL_COLOR_BUFFER_BIT);
    glDisableVertexAttribArray(1);
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 0, tri);
    glUniform4f(c, 0, 1, 1, 1);
    glUniform1f(k, 0);
    glDrawArrays(GL_TRIANGLES, 0, 3);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glViewport(0, 0, width, height);
    const float full[] = { -1, -1, 0, 0, 1, -1, 1, 0, 1, 1, 1, 1, -1, 1, 0, 1 };
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 16, full);
    glEnableVertexAttribArray(1);
    glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 16, full + 2);
    glUniform1f(k, 1);
    glDrawArrays(GL_TRIANGLE_FAN, 0, 4);
    int fbo_points[] = { 10, 10, width - 10, 10, width - 10, height - 10 };
    report("fbo", fbo_points, 3);

    // ETC1: one block, colors 136 each, every pixel +2
    const unsigned char block[] = { 0x88, 0x88, 0x88, 0x00, 0, 0, 0, 0 };
    glBindTexture(GL_TEXTURE_2D, texture);
    glCompressedTexImage2D(GL_TEXTURE_2D, 0, GL_ETC1_RGB8_OES, 4, 4, 0, 8, block);
    glDrawArrays(GL_TRIANGLE_FAN, 0, 4);
    int etc1_points[] = { width / 2, height / 2 };
    report("etc1", etc1_points, 1);
    eglSwapBuffers(display, surface);
}

static GLuint link(const char* vs, const char* fs, const char* varying)
{
    GLuint program = glCreateProgram();
    glAttachShader(program, compile(GL_VERTEX_SHADER, vs));
    glAttachShader(program, compile(GL_FRAGMENT_SHADER, fs));
    if(varying) glTransformFeedbackVaryings(program, 1, &varying, GL_INTERLEAVED_ATTRIBS);
    glLinkProgram(program);
    GLint ok = 0;
    glGetProgramiv(program, GL_LINK_STATUS, &ok);
    if(!ok)
    {
        char log[512];
        glGetProgramInfoLog(program, sizeof log, 0, log);
        LOG("V86_GLES link failed: %s", log);
    }
    glUseProgram(program);
    return program;
}

static void gles3_scenes(void)
{
    glViewport(0, 0, width, height);
    // two quads, an instance each (the offset's divisor 1), the uniform block's color
    GLuint flat = link("#version 300 es\nlayout(location = 0) in vec2 p; layout(location = 1) in vec2 offset;\n"
        "void main() { gl_Position = vec4(p * 0.25 + offset, 0.0, 1.0); }",
        "#version 300 es\nprecision mediump float; layout(std140) uniform Colors { vec4 color; }; out vec4 o;\nvoid main() { o = color; }", 0);
    GLuint vao, buffers[6];
    glGenVertexArrays(1, &vao);
    glBindVertexArray(vao);
    glGenBuffers(6, buffers);
    const float quad[] = { -1, -1, 1, -1, -1, 1, 1, 1 };
    glBindBuffer(GL_ARRAY_BUFFER, buffers[0]);
    glBufferData(GL_ARRAY_BUFFER, sizeof quad, quad, GL_STATIC_DRAW);
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 0, 0);
    const float offsets[] = { -0.5f, 0, 0.5f, 0 };
    glBindBuffer(GL_ARRAY_BUFFER, buffers[1]);
    glBufferData(GL_ARRAY_BUFFER, sizeof offsets, offsets, GL_STATIC_DRAW);
    glEnableVertexAttribArray(1);
    glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 0, 0);
    glVertexAttribDivisor(1, 1);
    const float color[] = { 1, 0.5f, 0, 1 };
    glBindBuffer(GL_UNIFORM_BUFFER, buffers[2]);
    glBufferData(GL_UNIFORM_BUFFER, sizeof color, color, GL_STATIC_DRAW);
    glUniformBlockBinding(flat, glGetUniformBlockIndex(flat, "Colors"), 1);
    glBindBufferBase(GL_UNIFORM_BUFFER, 1, buffers[2]);
    glClearColor(0, 0, 0, 1);
    glClear(GL_COLOR_BUFFER_BIT);
    glDrawArraysInstanced(GL_TRIANGLE_STRIP, 0, 4, 2);
    int instanced_points[] = { width / 4, height / 2, width * 3 / 4, height / 2, width / 2, height / 2 };
    report("instanced", instanced_points, 3);

    // two draw buffers: red and blue, then the second cleared green
    link("#version 300 es\nlayout(location = 0) in vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }",
        "#version 300 es\nprecision mediump float; layout(location = 0) out vec4 a; layout(location = 1) out vec4 b;\n"
        "void main() { a = vec4(1.0, 0.0, 0.0, 1.0); b = vec4(0.0, 0.0, 1.0, 1.0); }", 0);
    GLuint textures[4], framebuffers[3];
    glGenTextures(4, textures);
    glGenFramebuffers(3, framebuffers);
    glBindFramebuffer(GL_FRAMEBUFFER, framebuffers[0]);
    for(int i = 0; i < 2; i++)
    {
        glBindTexture(GL_TEXTURE_2D, textures[i]);
        glTexStorage2D(GL_TEXTURE_2D, 1, GL_RGBA8, 16, 16);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0 + i, GL_TEXTURE_2D, textures[i], 0);
    }
    const GLenum draw[] = { GL_COLOR_ATTACHMENT0, GL_COLOR_ATTACHMENT1 };
    glDrawBuffers(2, draw);
    glViewport(0, 0, 16, 16);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    int middle[] = { 8, 8 };
    glReadBuffer(GL_COLOR_ATTACHMENT1);
    report("mrt1", middle, 1);
    const float green[] = { 0, 1, 0, 1 };
    glClearBufferfv(GL_COLOR, 1, green);
    report("mrtclear", middle, 1);
    glReadBuffer(GL_COLOR_ATTACHMENT0);
    report("mrt0", middle, 1);

    // an unsigned integer color buffer, cleared and read as integers
    glBindFramebuffer(GL_FRAMEBUFFER, framebuffers[1]);
    glBindTexture(GL_TEXTURE_2D, textures[2]);
    glTexStorage2D(GL_TEXTURE_2D, 1, GL_R32UI, 4, 4);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, textures[2], 0);
    const GLuint big[] = { 4000000000u, 0, 0, 0 };
    glClearBufferuiv(GL_COLOR, 0, big);
    GLuint value[4] = { 0 };
    glReadPixels(0, 0, 1, 1, GL_RGBA_INTEGER, GL_UNSIGNED_INT, value);
    LOG("V86_GLES integer %u,%u,%u,%u glerror=%x", value[0], value[1], value[2], value[3], glGetError());

    // transform feedback: three points' positions doubled, mapped
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glViewport(0, 0, width, height);
    link("#version 300 es\nlayout(location = 0) in vec2 p; out vec2 doubled; void main() { doubled = p * 2.0; gl_Position = vec4(p, 0.0, 1.0); }",
        "#version 300 es\nprecision mediump float; out vec4 o; void main() { o = vec4(1.0); }", "doubled");
    glBindBuffer(GL_TRANSFORM_FEEDBACK_BUFFER, buffers[3]);
    glBufferData(GL_TRANSFORM_FEEDBACK_BUFFER, 24, 0, GL_STREAM_READ);
    glBindBufferBase(GL_TRANSFORM_FEEDBACK_BUFFER, 0, buffers[3]);
    glEnable(GL_RASTERIZER_DISCARD);
    glBeginTransformFeedback(GL_POINTS);
    glDrawArrays(GL_POINTS, 0, 3);
    glEndTransformFeedback();
    glDisable(GL_RASTERIZER_DISCARD);
    const float* captured = glMapBufferRange(GL_TRANSFORM_FEEDBACK_BUFFER, 0, 24, GL_MAP_READ_BIT);
    if(captured) LOG("V86_GLES feedback %g,%g,%g,%g,%g,%g glerror=%x", captured[0], captured[1], captured[2], captured[3], captured[4], captured[5], glGetError());
    glUnmapBuffer(GL_TRANSFORM_FEEDBACK_BUFFER);

    // a 3D texture of two layers (red, blue), sampled at the second
    link("#version 300 es\nlayout(location = 0) in vec2 p; out vec2 uv; void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }",
        "#version 300 es\nprecision mediump float; uniform mediump sampler3D volume; in vec2 uv; out vec4 o;\n"
        "void main() { o = texture(volume, vec3(uv, 0.75)); }", 0);
    glBindTexture(GL_TEXTURE_3D, textures[3]);
    const unsigned char layers[] = { 255, 0, 0, 255, 0, 0, 255, 255 };
    glTexImage3D(GL_TEXTURE_3D, 0, GL_RGBA8, 1, 1, 2, 0, GL_RGBA, GL_UNSIGNED_BYTE, layers);
    glTexParameteri(GL_TEXTURE_3D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_3D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    int center[] = { width / 2, height / 2 };
    report("volume", center, 1);

    // a multisampled renderbuffer cleared magenta, resolved into the window's corner by a blit
    GLuint renderbuffer;
    glGenRenderbuffers(1, &renderbuffer);
    glBindRenderbuffer(GL_RENDERBUFFER, renderbuffer);
    glRenderbufferStorageMultisample(GL_RENDERBUFFER, 4, GL_RGBA8, 16, 16);
    glBindFramebuffer(GL_FRAMEBUFFER, framebuffers[2]);
    glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, renderbuffer);
    glClearColor(1, 0, 1, 1);
    glClear(GL_COLOR_BUFFER_BIT);
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
    glBlitFramebuffer(0, 0, 16, 16, 0, 0, 16, 16, GL_COLOR_BUFFER_BIT, GL_NEAREST);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    report("resolve", middle, 1);

    // that pixel into a pixel pack buffer, mapped
    glBindBuffer(GL_PIXEL_PACK_BUFFER, buffers[4]);
    glBufferData(GL_PIXEL_PACK_BUFFER, 4, 0, GL_STREAM_READ);
    glReadPixels(8, 8, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, 0);
    const unsigned char* packed = glMapBufferRange(GL_PIXEL_PACK_BUFFER, 0, 4, GL_MAP_READ_BIT);
    if(packed) LOG("V86_GLES pack %d,%d,%d,%d glerror=%x", packed[0], packed[1], packed[2], packed[3], glGetError());
    glUnmapBuffer(GL_PIXEL_PACK_BUFFER);
    glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
    eglSwapBuffers(display, surface);
}

static void gles1_scenes(void)
{
    glViewport(0, 0, width, height);
    glClearColor(0, 0, 0, 1);
    glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
    glMatrixMode(GL_PROJECTION);
    glLoadIdentity();
    glOrthof(0, 2, 0, 2, -1, 1);
    glMatrixMode(GL_MODELVIEW);
    glLoadIdentity();
    // the left half: the current color
    const float half[] = { 0, 0, 1, 0, 1, 2, 0, 0, 1, 2, 0, 2 };
    glEnableClientState(GL_VERTEX_ARRAY);
    glVertexPointer(2, GL_FLOAT, 0, half);
    glColor4f(1, 0.5f, 0, 1);
    glDrawArrays(GL_TRIANGLES, 0, 6);
    // the right half: a white texture modulated by a green color array
    GLuint texture;
    glGenTextures(1, &texture);
    glBindTexture(GL_TEXTURE_2D, texture);
    const unsigned char white[] = { 255, 255, 255, 255 };
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 1, 1, 0, GL_RGBA, GL_UNSIGNED_BYTE, white);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glEnable(GL_TEXTURE_2D);
    unsigned char colors[24];
    for(int i = 0; i < 24; i++) colors[i] = (i % 4 == 1 || i % 4 == 3) ? 255 : 0;
    glEnableClientState(GL_COLOR_ARRAY);
    glColorPointer(4, GL_UNSIGNED_BYTE, 0, colors);
    const float uv[12] = { 0.5f, 0.5f, 0.5f, 0.5f, 0.5f, 0.5f, 0.5f, 0.5f, 0.5f, 0.5f, 0.5f, 0.5f };
    glEnableClientState(GL_TEXTURE_COORD_ARRAY);
    glTexCoordPointer(2, GL_FLOAT, 0, uv);
    glTranslatef(1, 0, 0);
    glDrawArrays(GL_TRIANGLES, 0, 6);
    int fixed_points[] = { 10, 10, width - 10, 10 };
    report("gles1", fixed_points, 2);
    // a light along +z on the left half: the material's diffuse
    glDisable(GL_TEXTURE_2D);
    glDisableClientState(GL_COLOR_ARRAY);
    glDisableClientState(GL_TEXTURE_COORD_ARRAY);
    glLoadIdentity();
    glEnable(GL_LIGHTING);
    glEnable(GL_LIGHT0);
    const float position[] = { 0, 0, 1, 0 }, diffuse[] = { 0.5f, 0.5f, 0.5f, 1 }, black[] = { 0, 0, 0, 1 };
    glLightfv(GL_LIGHT0, GL_POSITION, position);
    glMaterialfv(GL_FRONT_AND_BACK, GL_DIFFUSE, diffuse);
    glMaterialfv(GL_FRONT_AND_BACK, GL_AMBIENT, black);
    glLightModelfv(GL_LIGHT_MODEL_AMBIENT, black);
    glNormal3f(0, 0, 1);
    glDrawArrays(GL_TRIANGLES, 0, 6);
    glDisable(GL_LIGHTING);
    int light_points[] = { 10, 10 };
    report("light", light_points, 1);
    // draw_texture: a 2 by 1 texture's right texel (blue) at the top right quarter
    const unsigned char texels[] = { 255, 0, 0, 0, 0, 255 };
    glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGB, 2, 1, 0, GL_RGB, GL_UNSIGNED_BYTE, texels);
    const GLint crop[] = { 1, 0, 1, 1 };
    glTexParameteriv(GL_TEXTURE_2D, GL_TEXTURE_CROP_RECT_OES, crop);
    // (the texture's own filtering applies: LINEAR with REPEAT would blend the red texel in at the edge)
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glEnable(GL_TEXTURE_2D);
    glTexEnvi(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_REPLACE);
    glDrawTexiOES(width / 2, height / 2, 0, width / 2, height / 2);
    int tex_points[] = { width - 10, height - 10, 10, 10 };
    report("drawtex", tex_points, 2);
    eglSwapBuffers(display, surface);
}

/** EGL: swap intervals, a fence, a pbuffer surface, a texture made in one context and sampled in another of its share group */
static void egl_scenes(EGLContext context2)
{
    PFNEGLCREATESYNCKHRPROC create_sync = (PFNEGLCREATESYNCKHRPROC)eglGetProcAddress("eglCreateSyncKHR");
    PFNEGLCLIENTWAITSYNCKHRPROC wait_sync = (PFNEGLCLIENTWAITSYNCKHRPROC)eglGetProcAddress("eglClientWaitSyncKHR");
    PFNEGLGETSYNCATTRIBKHRPROC sync_attrib = (PFNEGLGETSYNCATTRIBKHRPROC)eglGetProcAddress("eglGetSyncAttribKHR");
    PFNEGLDESTROYSYNCKHRPROC destroy_sync = (PFNEGLDESTROYSYNCKHRPROC)eglGetProcAddress("eglDestroySyncKHR");
    eglMakeCurrent(display, surface, surface, context2);
    EGLBoolean interval0 = eglSwapInterval(display, 0), interval1 = eglSwapInterval(display, 1);
    glClearColor(0, 0, 1, 1);
    glClear(GL_COLOR_BUFFER_BIT);
    EGLSyncKHR sync = create_sync ? create_sync(display, EGL_SYNC_FENCE_KHR, 0) : EGL_NO_SYNC_KHR;
    EGLint waited = 0, status = 0;
    if(sync != EGL_NO_SYNC_KHR)
    {
        waited = wait_sync(display, sync, EGL_SYNC_FLUSH_COMMANDS_BIT_KHR, 1000000000ull);
        sync_attrib(display, sync, EGL_SYNC_STATUS_KHR, &status);
        destroy_sync(display, sync);
    }
    LOG("V86_GLES egl intervals=%d,%d sync=%d wait=%x status=%x", interval0, interval1, sync != EGL_NO_SYNC_KHR, waited, status);
    // a 32 by 32 pbuffer, cleared yellow
    const EGLint pbuffer_attributes[] = { EGL_WIDTH, 32, EGL_HEIGHT, 32, EGL_NONE };
    EGLSurface pbuffer = eglCreatePbufferSurface(display, config, pbuffer_attributes);
    eglMakeCurrent(display, pbuffer, pbuffer, context2);
    glViewport(0, 0, 32, 32);
    glClearColor(1, 1, 0, 1);
    glClear(GL_COLOR_BUFFER_BIT);
    int pbuffer_points[] = { 16, 16 };
    report("pbuffer", pbuffer_points, 1);
    // a magenta texture made in context2, sampled in context3 (context2's share group)
    GLuint texture;
    glGenTextures(1, &texture);
    glBindTexture(GL_TEXTURE_2D, texture);
    const unsigned char magenta[] = { 255, 0, 255, 255 };
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 1, 1, 0, GL_RGBA, GL_UNSIGNED_BYTE, magenta);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glFinish();
    const EGLint version2[] = { EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE };
    EGLContext context3 = eglCreateContext(display, config, context2, version2);
    eglMakeCurrent(display, pbuffer, pbuffer, context3);
    glViewport(0, 0, 32, 32);
    GLuint program = glCreateProgram();
    glAttachShader(program, compile(GL_VERTEX_SHADER, "attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }"));
    glAttachShader(program, compile(GL_FRAGMENT_SHADER, "precision mediump float; uniform sampler2D t; void main() { gl_FragColor = texture2D(t, vec2(0.5)); }"));
    glBindAttribLocation(program, 0, "p");
    glLinkProgram(program);
    glUseProgram(program);
    glBindTexture(GL_TEXTURE_2D, texture);
    const float triangle[] = { -1, -1, 3, -1, -1, 3 };
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 0, triangle);
    glDrawArrays(GL_TRIANGLES, 0, 3);
    report("shared", pbuffer_points, 1);
    eglMakeCurrent(display, surface, surface, context2);
    eglDestroyContext(display, context3);
    eglDestroySurface(display, pbuffer);
}

static void* run(void* argument)
{
    ANativeWindow* window = (ANativeWindow*)argument;
    display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
    eglInitialize(display, 0, 0);
    const EGLint attributes[] = { EGL_SURFACE_TYPE, EGL_WINDOW_BIT | EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT | EGL_OPENGL_ES_BIT, EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8,
        EGL_BLUE_SIZE, 8, EGL_DEPTH_SIZE, 16, EGL_NONE };
    EGLint count = 0;
    eglChooseConfig(display, attributes, &config, 1, &count);
    surface = eglCreateWindowSurface(display, config, window, 0);
    eglQuerySurface(display, surface, EGL_WIDTH, &width);
    eglQuerySurface(display, surface, EGL_HEIGHT, &height);
    LOG("V86_GLES window %dx%d configs %d vendor", width, height, count);
    const EGLint version2[] = { EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE };
    EGLContext context2 = eglCreateContext(display, config, EGL_NO_CONTEXT, version2);
    eglMakeCurrent(display, surface, surface, context2);
    LOG("V86_GLES gles2 %s / %s", glGetString(GL_VERSION), glGetString(GL_RENDERER));
    gles2_scenes();
    const EGLint version1[] = { EGL_CONTEXT_CLIENT_VERSION, 1, EGL_NONE };
    EGLContext context1 = eglCreateContext(display, config, EGL_NO_CONTEXT, version1);
    eglMakeCurrent(display, surface, surface, context1);
    LOG("V86_GLES gles1 %s", glGetString(GL_VERSION));
    gles1_scenes();
    egl_scenes(context2);
    // (GLES 3.0: when the host announces it)
    const EGLint version3[] = { EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE };
    EGLContext context3 = eglCreateContext(display, config, EGL_NO_CONTEXT, version3);
    if(context3 != EGL_NO_CONTEXT && eglMakeCurrent(display, surface, surface, context3))
    {
        LOG("V86_GLES gles3 %s / %s", glGetString(GL_VERSION), glGetString(GL_SHADING_LANGUAGE_VERSION));
        gles3_scenes();
    }
    else LOG("V86_GLES gles3 none: %x", eglGetError());
    LOG("V86_GLES_DONE");
    return 0;
}

static void window_created(ANativeActivity* activity, ANativeWindow* window)
{
    (void)activity;
    pthread_t thread;
    pthread_create(&thread, 0, run, window);
}

void ANativeActivity_onCreate(ANativeActivity* activity, void* state, size_t size)
{
    (void)state;
    (void)size;
    activity->callbacks->onNativeWindowCreated = window_created;
}
