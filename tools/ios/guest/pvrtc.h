// PVRTC1 (IMG_texture_compression_pvrtc), decoded to native RGBA8.
// The PowerVR Native SDK decompressor is the reference for color rounding.
// This implementation evaluates the four neighboring endpoints per texel.
#ifndef V86_N90_PVRTC_H
#define V86_N90_PVRTC_H

struct pvrtc_word { unsigned modulation, endpoints; };

static unsigned pvrtc_u32(const unsigned char *p)
{
    return p[0] | (unsigned)p[1] << 8 | (unsigned)p[2] << 16 | (unsigned)p[3] << 24;
}

static struct pvrtc_word pvrtc_word(const unsigned char *image, unsigned cols, unsigned rows, unsigned x, unsigned y)
{
    const unsigned small = cols < rows ? cols : rows;
    unsigned index = 0, shift = 0;
    for(unsigned bit = 1; bit < small; bit <<= 1, shift++)
        index |= (y & bit) << shift | (x & bit) << (shift + 1);
    index |= ((cols > rows ? x : y) & ~(small - 1)) << shift;
    const unsigned char *p = image + 8 * index;
    return (struct pvrtc_word){ pvrtc_u32(p), pvrtc_u32(p + 4) };
}

static unsigned pvrtc_extend(unsigned value, unsigned bits)
{
    return value << (5 - bits) | value >> (2 * bits - 5);
}

static void pvrtc_endpoint(unsigned short code, unsigned high, unsigned *color)
{
    if(code & 0x8000)
    {
        color[0] = code >> 10 & 31;
        color[1] = code >> 5 & 31;
        color[2] = high ? code & 31 : pvrtc_extend(code >> 1 & 15, 4);
        color[3] = 15;
    }
    else
    {
        color[0] = pvrtc_extend(code >> 8 & 15, 4);
        color[1] = pvrtc_extend(code >> 4 & 15, 4);
        color[2] = high ? pvrtc_extend(code & 15, 4) : pvrtc_extend(code >> 1 & 7, 3);
        color[3] = code >> 11 & 14;
    }
}

static unsigned pvrtc_mod_sample(struct pvrtc_word word, unsigned x, unsigned y, unsigned two)
{
    static const unsigned standard[] = { 0, 3, 5, 8 }, punch[] = { 0, 4, 14, 8 };
    const unsigned m = word.modulation;
    if(!two) return (word.endpoints & 1 ? punch : standard)[m >> (2 * (4 * y + x)) & 3];
    if(!(word.endpoints & 1)) return (m >> (8 * y + x) & 1) * 8;
    const unsigned bit = 8 * y + (x & ~1u);
    if(!bit || (bit == 20 && (m & 1))) return (m >> (bit + 1) & 1) * 8;
    return standard[m >> bit & 3];
}

static unsigned pvrtc_2bpp_sample(const unsigned char *image, unsigned cols, unsigned rows, unsigned x, unsigned y)
{
    return pvrtc_mod_sample(pvrtc_word(image, cols, rows, x / 8 & (cols - 1), y / 4 & (rows - 1)), x & 7, y & 3, 1);
}

static unsigned pvrtc_size(unsigned w, unsigned h, unsigned two)
{
    if(!w || !h || w > 4096 || h > 4096 || (w & (w - 1)) || (h & (h - 1))) return 0;
    const unsigned minw = two ? 16 : 8;
    return ((w < minw ? minw : w) * (h < 8 ? 8 : h)) >> (two ? 2 : 1);
}

static void pvrtc_decode(const unsigned char *image, unsigned char *output, unsigned stride,
    unsigned w, unsigned h, unsigned two, unsigned alpha)
{
    const unsigned bw = two ? 8 : 4, cols = w < 2 * bw ? 2 : w / bw, rows = h < 8 ? 2 : h / 4;
    for(unsigned y = 0; y < h; y++)
        for(unsigned x = 0; x < w; x++)
        {
            const unsigned cx = x + bw / 2, cy = y + 2, tx = cx & (bw - 1), ty = cy & 3;
            const unsigned right = cx / bw & (cols - 1), bottom = cy / 4 & (rows - 1);
            const unsigned left = (right - 1) & (cols - 1), top = (bottom - 1) & (rows - 1);
            const struct pvrtc_word corner[] = {
                pvrtc_word(image, cols, rows, left, top), pvrtc_word(image, cols, rows, right, top),
                pvrtc_word(image, cols, rows, left, bottom), pvrtc_word(image, cols, rows, right, bottom),
            };
            const struct pvrtc_word local = corner[(y & 3) < 2 ? (x & (bw - 1)) < bw / 2 ? 3 : 2 :
                (x & (bw - 1)) < bw / 2 ? 1 : 0];
            unsigned mod;
            if(two && (local.endpoints & 1) && ((x ^ y) & 1))
            {
                const unsigned mode = local.modulation & 1 ? (local.modulation & (1u << 20) ? 2 : 1) : 0;
                const unsigned across = mode == 2 ? 0 : pvrtc_2bpp_sample(image, cols, rows, x - 1, y) +
                    pvrtc_2bpp_sample(image, cols, rows, x + 1, y);
                const unsigned down = mode == 1 ? 0 : pvrtc_2bpp_sample(image, cols, rows, x, y - 1) +
                    pvrtc_2bpp_sample(image, cols, rows, x, y + 1);
                mod = (across + down + (mode ? 1 : 2)) >> (mode ? 1 : 2);
            }
            else mod = pvrtc_mod_sample(local, x & (bw - 1), y & 3, two);

            unsigned endpoints[2][4];
            for(unsigned pair = 0; pair < 2; pair++)
            {
                unsigned colors[4][4];
                for(unsigned j = 0; j < 4; j++)
                    pvrtc_endpoint(corner[j].endpoints >> (16 * pair), pair, colors[j]);
                for(unsigned c = 0; c < 4; c++)
                {
                    const unsigned a = colors[0][c] * (bw - tx) + colors[1][c] * tx;
                    const unsigned b = colors[2][c] * (bw - tx) + colors[3][c] * tx;
                    const unsigned n = a * (4 - ty) + b * ty;
                    endpoints[pair][c] = c == 3 ? (n >> (two ? 5 : 4)) + (n >> two) :
                        (n >> (two ? 7 : 6)) + (n >> (two ? 2 : 1));
                }
            }
            unsigned char *pixel = output + y * stride + 4 * x;
            const unsigned punch = mod == 14;
            if(punch) mod = 4;
            for(unsigned c = 0; c < 4; c++) pixel[c] = (endpoints[0][c] * (8 - mod) + endpoints[1][c] * mod) >> 3;
            if(!alpha) pixel[3] = 255;
            else if(punch) pixel[3] = 0;
        }
}
#endif
