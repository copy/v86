// Generated texels, with expected hashes from Imagination's reference decoder.
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include "../../tools/ios/guest/pvrtc.h"

int main(void)
{
    const unsigned fixtures[][4] = {
        { 8, 8, 0, 0xcd1aeb1b }, { 16, 32, 0, 0xe0ecced6 },
        { 32, 8, 1, 0xcbd8c393 }, { 1, 4, 1, 0xe608485a },
    };
    uint32_t seed = 0x41390ca3;
    for(unsigned i = 0; i < sizeof(fixtures) / sizeof(fixtures[0]); i++)
    {
        const unsigned w = fixtures[i][0], h = fixtures[i][1], two = fixtures[i][2];
        unsigned char in[256], rgba[2048];
        const unsigned size = pvrtc_size(w, h, two);
        assert(size && size <= sizeof(in) && w * h * 4 <= sizeof(rgba));
        for(unsigned n = 0; n < size; n++)
        {
            seed = seed * 1664525u + 1013904223u;
            in[n] = seed >> 24;
        }
        pvrtc_decode(in, rgba, w * 4, w, h, two, 1);
        uint32_t hash = 2166136261u;
        for(unsigned n = 0; n < w * h * 4; n++) hash = (hash ^ rgba[n]) * 16777619u;
        assert(hash == fixtures[i][3]);
    }
    assert(!pvrtc_size(15, 4, 1));
    puts("PASS: PVRTC1 2 and 4 bpp, rectangular wrapping, alpha and minimum-size mip levels");
    return 0;
}
