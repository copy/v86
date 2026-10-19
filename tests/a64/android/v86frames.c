// The library of P12.3's sustained frame rate app (tests/a64/apk.mjs
// build_apk with native, android.app.NativeActivity): on its window, OpenGL
// ES 2 through EGL (ANGLE on the guest's Vulkan), each frame a cleared screen
// and a turning triangle, swapped with the display's pacing, for SECONDS
// seconds; then it logs the frames and their rate (logcat tag v86frames:
// "V86_FRAMES frames=<n> seconds=<s> fps=<f>") and finishes its activity.
#include <EGL/egl.h>
#include <GLES2/gl2.h>
#include <android/log.h>
#include <android/native_activity.h>
#include <math.h>
#include <pthread.h>
#include <stdatomic.h>
#include <time.h>

#define SECONDS 60
#define LOG(...) __android_log_print(ANDROID_LOG_INFO, "v86frames", __VA_ARGS__)

static ANativeActivity *the_activity;
static ANativeWindow *the_window;
static atomic_int stop;
static pthread_t thread;
static int running;

static double now(void)
{
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec + t.tv_nsec / 1e9;
}

static GLuint shader(GLenum type, const char *source)
{
    GLuint s = glCreateShader(type);
    glShaderSource(s, 1, &source, NULL);
    glCompileShader(s);
    return s;
}

static void *render(void *unused)
{
    (void)unused;
    EGLDisplay display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
    eglInitialize(display, NULL, NULL);
    const EGLint config_attributes[] = { EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT, EGL_SURFACE_TYPE, EGL_WINDOW_BIT,
        EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_NONE };
    EGLConfig config;
    EGLint count = 0;
    eglChooseConfig(display, config_attributes, &config, 1, &count);
    const EGLint context_attributes[] = { EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE };
    EGLContext context = eglCreateContext(display, config, EGL_NO_CONTEXT, context_attributes);
    EGLSurface surface = eglCreateWindowSurface(display, config, the_window, NULL);
    if(!count || context == EGL_NO_CONTEXT || surface == EGL_NO_SURFACE || !eglMakeCurrent(display, surface, surface, context))
    {
        LOG("V86_FRAMES error=egl 0x%x", eglGetError());
        ANativeActivity_finish(the_activity);
        return NULL;
    }
    GLuint program = glCreateProgram();
    glAttachShader(program, shader(GL_VERTEX_SHADER,
        "attribute vec2 p; uniform float a; void main() { gl_Position = vec4(cos(a) * p.x - sin(a) * p.y, sin(a) * p.x + cos(a) * p.y, 0.0, 1.0); }"));
    glAttachShader(program, shader(GL_FRAGMENT_SHADER, "precision mediump float; void main() { gl_FragColor = vec4(1.0, 0.8, 0.2, 1.0); }"));
    glBindAttribLocation(program, 0, "p");
    glLinkProgram(program);
    glUseProgram(program);
    const GLfloat triangle[] = { 0.0f, 0.6f, -0.5f, -0.4f, 0.5f, -0.4f };
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 0, triangle);
    glEnableVertexAttribArray(0);
    GLint angle = glGetUniformLocation(program, "a");
    LOG("V86_FRAMES start renderer=%s", (const char *)glGetString(GL_RENDERER));
    double start = now(), last = start;
    int frames = 0, frames_last = 0;
    while(!atomic_load(&stop) && now() - start < SECONDS)
    {
        double t = now() - start;
        glClearColor(0.1f, 0.2f + 0.2f * (float)sin(t), 0.4f, 1.0f);
        glClear(GL_COLOR_BUFFER_BIT);
        glUniform1f(angle, (float)t);
        glDrawArrays(GL_TRIANGLES, 0, 3);
        eglSwapBuffers(display, surface);
        frames++;
        if(now() - last >= 10)
        {
            LOG("V86_FRAMES progress frames=%d fps=%.2f", frames, (frames - frames_last) / (now() - last));
            last = now();
            frames_last = frames;
        }
    }
    double seconds = now() - start;
    LOG("V86_FRAMES frames=%d seconds=%.1f fps=%.2f", frames, seconds, frames / seconds);
    eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    eglDestroySurface(display, surface);
    eglDestroyContext(display, context);
    ANativeActivity_finish(the_activity);
    return NULL;
}

static void window_created(ANativeActivity *activity, ANativeWindow *window)
{
    (void)activity;
    if(running) return;
    the_window = window;
    running = 1;
    atomic_store(&stop, 0);
    pthread_create(&thread, NULL, render, NULL);
}

static void window_destroyed(ANativeActivity *activity, ANativeWindow *window)
{
    (void)activity;
    (void)window;
    if(!running) return;
    atomic_store(&stop, 1);
    pthread_join(thread, NULL);
    running = 0;
}

void ANativeActivity_onCreate(ANativeActivity *activity, void *saved_state, size_t saved_state_size)
{
    (void)saved_state;
    (void)saved_state_size;
    the_activity = activity;
    activity->callbacks->onNativeWindowCreated = window_created;
    activity->callbacks->onNativeWindowDestroyed = window_destroyed;
}
