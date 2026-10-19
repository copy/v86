// The library of P12.1's native APK test (tests/a64/apk.mjs build_apk with
// native, android.app.NativeActivity): loaded, it logs the page size it runs
// with (logcat tag v86native), then finishes its activity.
#include <android/log.h>
#include <android/native_activity.h>
#include <unistd.h>

void ANativeActivity_onCreate(ANativeActivity *activity, void *saved_state, size_t saved_state_size)
{
    (void)saved_state;
    (void)saved_state_size;
    __android_log_print(ANDROID_LOG_INFO, "v86native", "V86_NATIVE_LOADED page_size=%ld", sysconf(_SC_PAGESIZE));
    ANativeActivity_finish(activity);
}
