/* Read-only guest audio capability audit for 3DMark03's sound-test gating. */
#define COBJMACROS
#define DIRECTSOUND_VERSION 0x0800
#include <windows.h>
#include <mmsystem.h>
#include <dsound.h>
#include <stdio.h>

static BOOL CALLBACK device(GUID *guid, LPCSTR description, LPCSTR module, LPVOID context)
{
    IDirectSound *sound = NULL;
    DSCAPS caps = {0};
    HRESULT hr;
    (void)context;
    printf("device=%s module=%s default=%d\n", description ? description : "",
           module ? module : "", guid == NULL);
    hr = DirectSoundCreate(guid, &sound, NULL);
    printf("DirectSoundCreate=%08lx\n", (unsigned long)hr);
    if (FAILED(hr)) return TRUE;
    caps.dwSize = sizeof(caps);
    hr = IDirectSound_GetCaps(sound, &caps);
    printf("GetCaps=%08lx flags=%08lx max_hw_mixing=%lu free_hw_mixing=%lu "
           "max_hw_3d=%lu free_hw_3d=%lu\n", (unsigned long)hr,
           (unsigned long)caps.dwFlags, (unsigned long)caps.dwMaxHwMixingAllBuffers,
           (unsigned long)caps.dwFreeHwMixingAllBuffers,
           (unsigned long)caps.dwMaxHw3DAllBuffers, (unsigned long)caps.dwFreeHw3DAllBuffers);
    IDirectSound_Release(sound);
    return TRUE;
}

int main(void)
{
    UINT count = waveOutGetNumDevs();
    printf("wave_devices=%u\n", count);
    for (UINT i = 0; i < count; ++i) {
        WAVEOUTCAPSA caps = {0};
        MMRESULT result = waveOutGetDevCapsA(i, &caps, sizeof(caps));
        printf("wave=%u result=%u name=%s channels=%u support=%08lx\n",
               i, result, caps.szPname, caps.wChannels, (unsigned long)caps.dwSupport);
    }
    HRESULT hr = DirectSoundEnumerateA(device, NULL);
    printf("DirectSoundEnumerate=%08lx\n", (unsigned long)hr);
    /* Some systems do not enumerate a default device when no driver exists. */
    device(NULL, "explicit default probe", "", NULL);
    return FAILED(hr);
}
