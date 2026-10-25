// The library of the 32-bit app (tests/a64/apk.mjs build_apk with native
// and abi armeabi-v7a, android.app.NativeActivity; the NDK's armv7a target:
// Thumb-2 code with VFP). Loaded, it logs its pointers' width and a sum
// computed in floating point (logcat tag v86arm32: "V86_ARM32_LOADED
// bits=32 sum=<s>", the sum of 1/sqrt(i) for i from 1 to 1000). Built with
// -DV86_FINISH it then finishes its activity, with no window (aarch32 plan
// Q5.2: an arm64-only vendor has no 32-bit gralloc mapper for window
// buffers); otherwise (R7.1) on its window, drawn with the CPU
// (ANativeWindow's buffer), the top half magenta and the bottom half cyan,
// and it logs "V86_ARM32_DREW <w>x<h> sum=<s> bits=32", keeping the window.
#include <android/log.h>
#include <android/native_activity.h>
#include <android/native_window.h>
#include <math.h>
#include <stdint.h>

#define LOG(...) __android_log_print(ANDROID_LOG_INFO, "v86arm32", __VA_ARGS__)

static double sum(void)
{
    double s = 0;
    for(int i = 1; i <= 1000; i++) s += sqrt((double)i) / i;
    return s;
}

static void window_created(ANativeActivity *activity, ANativeWindow *window)
{
    (void)activity;
    ANativeWindow_setBuffersGeometry(window, 0, 0, WINDOW_FORMAT_RGBX_8888);
    ANativeWindow_Buffer buffer;
    if(ANativeWindow_lock(window, &buffer, NULL) != 0)
    {
        LOG("V86_ARM32_LOCK_FAILED");
        return;
    }
    for(int y = 0; y < buffer.height; y++)
    {
        uint32_t *row = (uint32_t *)buffer.bits + y * buffer.stride;
        // (RGBX in memory: R in the low byte)
        uint32_t color = y < buffer.height / 2 ? 0xFFFF00FF : 0xFFFFFF00;
        for(int x = 0; x < buffer.width; x++) row[x] = color;
    }
    ANativeWindow_unlockAndPost(window);
    LOG("V86_ARM32_DREW %dx%d sum=%.6f bits=%d", buffer.width, buffer.height, sum(), (int)sizeof(void *) * 8);
}

void ANativeActivity_onCreate(ANativeActivity *activity, void *saved_state, size_t saved_state_size)
{
    (void)saved_state;
    (void)saved_state_size;
    LOG("V86_ARM32_LOADED bits=%d sum=%.6f", (int)sizeof(void *) * 8, sum());
#ifdef V86_FINISH
    ANativeActivity_finish(activity);
#else
    activity->callbacks->onNativeWindowCreated = window_created;
#endif
}
