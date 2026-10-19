// The library of P12.5's framework sound check (tests/a64/apk.mjs build_apk
// with native, android.app.NativeActivity): an AAudio output stream (media,
// 48 kHz stereo 16-bit) playing a 1 kHz tone for SECONDS seconds, through
// AudioFlinger and the audio HAL to the device's card; then it logs what it
// wrote (logcat tag v86tone: "V86_TONE frames=<n> rate=<hz> channels=<n>",
// or "V86_TONE error=<text>") and finishes its activity.
#include <aaudio/AAudio.h>
#include <android/log.h>
#include <android/native_activity.h>
#include <math.h>
#include <pthread.h>
#include <stdint.h>

#define SECONDS 2
#define FREQUENCY 1000
#define LOG(...) __android_log_print(ANDROID_LOG_INFO, "v86tone", __VA_ARGS__)

static ANativeActivity *the_activity;

static void *play(void *unused)
{
    (void)unused;
    AAudioStreamBuilder *builder;
    AAudioStream *stream = NULL;
    aaudio_result_t r = AAudio_createStreamBuilder(&builder);
    if(r == AAUDIO_OK)
    {
        AAudioStreamBuilder_setDirection(builder, AAUDIO_DIRECTION_OUTPUT);
        AAudioStreamBuilder_setFormat(builder, AAUDIO_FORMAT_PCM_I16);
        AAudioStreamBuilder_setChannelCount(builder, 2);
        AAudioStreamBuilder_setSampleRate(builder, 48000);
        AAudioStreamBuilder_setUsage(builder, AAUDIO_USAGE_MEDIA);
        r = AAudioStreamBuilder_openStream(builder, &stream);
        AAudioStreamBuilder_delete(builder);
    }
    if(r == AAUDIO_OK) r = AAudioStream_requestStart(stream);
    if(r != AAUDIO_OK)
    {
        LOG("V86_TONE error=%s", AAudio_convertResultToText(r));
        if(stream) AAudioStream_close(stream);
        ANativeActivity_finish(the_activity);
        return NULL;
    }
    int32_t rate = AAudioStream_getSampleRate(stream), channels = AAudioStream_getChannelCount(stream);
    int16_t buffer[2 * 480];
    int64_t frames = 0, total = (int64_t)rate * SECONDS;
    while(frames < total)
    {
        for(int i = 0; i < 480; i++)
        {
            int16_t v = (int16_t)(16000 * sin(2 * M_PI * FREQUENCY * (double)(frames + i) / rate));
            buffer[2 * i] = v;
            buffer[2 * i + 1] = v;
        }
        aaudio_result_t written = AAudioStream_write(stream, buffer, 480, 2000000000LL);
        if(written < 0)
        {
            LOG("V86_TONE error=%s", AAudio_convertResultToText(written));
            break;
        }
        frames += written;
    }
    // (until the stream has played what it holds)
    AAudioStream_requestStop(stream);
    aaudio_stream_state_t state = AAUDIO_STREAM_STATE_STOPPING;
    AAudioStream_waitForStateChange(stream, AAUDIO_STREAM_STATE_STOPPING, &state, 2000000000LL);
    AAudioStream_close(stream);
    LOG("V86_TONE frames=%lld rate=%d channels=%d", (long long)frames, rate, channels);
    ANativeActivity_finish(the_activity);
    return NULL;
}

void ANativeActivity_onCreate(ANativeActivity *activity, void *saved_state, size_t saved_state_size)
{
    (void)saved_state;
    (void)saved_state_size;
    the_activity = activity;
    pthread_t thread;
    pthread_create(&thread, NULL, play, NULL);
    pthread_detach(thread);
}
