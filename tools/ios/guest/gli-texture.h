// Copy native texture pointers into the transport. PVRTC1 is expanded to
// RGBA8 before upload since WebGPU has no corresponding texture format.
#include "pvrtc.h"

static unsigned texel_size(unsigned format, unsigned type)
{
    if(type == 0x8363 && format == 0x1907) return 2; // RGB565
    if((type == 0x8033 || type == 0x8034) && format == 0x1908) return 2;
    if(type != 0x1401) return 0;
    switch(format)
    {
        case 0x1906: case 0x1909: return 1;
        case 0x190a: return 2;
        case 0x1907: return 3;
        case 0x1908: case 0x80e1: return 4;
        default: return 0;
    }
}

static unsigned texture_stride(struct context *ctx, unsigned row)
{
    int align = 0;
    if(!integer_value(ctx, 0x0cf5, &align) || !(align == 1 || align == 2 || align == 4 || align == 8))
    {
        ctx->driver.ok = 0;
        return 0;
    }
    return (row + align - 1) & ~(unsigned)(align - 1);
}

static void texture_packet(struct context *ctx, unsigned op, const unsigned *fields, unsigned count,
    const void *data, unsigned size)
{
    const unsigned header = (count + 3) * 4;
    if(size > N90_MAX_PAYLOAD) { draw_error(ctx, 0x505); return; }
    unsigned *p = draw_packet(ctx, op, header + size);
    if(!p) return;
    memcpy(p + 2, fields, count * 4);
    p[2 + count] = size;
    if(size) memcpy(p + 3 + count, data, size);
    send_draw_packet(ctx, p, header + size);
}

static void upload_texture(struct context *ctx, unsigned op, const unsigned *fields, int w, int h,
    unsigned format, unsigned type, const void *data)
{
    if(w < 0 || h < 0 || w > 16384 || h > 16384) { draw_error(ctx, 0x501); return; }
    unsigned size = 0, texel = texel_size(format, type);
    // The host validates unsupported format/type pairs without dereferencing data.
    if(data && w && h && texel)
    {
        const unsigned row = w * texel, stride = texture_stride(ctx, row);
        if(!stride) return;
        size = (h - 1) * stride + row;
    }
    texture_packet(ctx, op, fields, 8, data, size);
}

static void tex_image(struct context *ctx, unsigned target, int level, int internal, int w, int h,
    int border, unsigned format, unsigned type, const void *data)
{
    const unsigned fields[] = { target, level, internal, w, h, border, format, type };
    upload_texture(ctx, gles2_glTexImage2D, fields, w, h, format, type, data);
}

static void tex_sub_image(struct context *ctx, unsigned target, int level, int x, int y, int w, int h,
    unsigned format, unsigned type, const void *data)
{
    const unsigned fields[] = { target, level, x, y, w, h, format, type };
    upload_texture(ctx, gles2_glTexSubImage2D, fields, w, h, format, type, data);
}

static int pvrtc_format(unsigned format) { return format >= 0x8c00 && format <= 0x8c03; }

static void upload_pvrtc(struct context *ctx, unsigned target, int level, unsigned format, int w, int h,
    int size, const void *data, int sub)
{
    const unsigned two = format & 1, expected = pvrtc_size(w, h, two);
    if(!expected || expected != (unsigned)size || (sub && !data)) { draw_error(ctx, 0x501); return; }
    const unsigned row = 4 * w, stride = texture_stride(ctx, row);
    if(!stride) return;
    const unsigned length = data ? (h - 1) * stride + row : 0;
    unsigned *p = draw_packet(ctx, sub ? gles2_glTexSubImage2D : gles2_glTexImage2D, 44 + length);
    if(!p) return;
    const unsigned fields[] = { target, level, sub ? 0 : 0x1908, sub ? 0 : w,
        sub ? w : h, sub ? h : 0, 0x1908, 0x1401, length };
    memcpy(p + 2, fields, sizeof(fields));
    if(length)
    {
        unsigned char *pixels = (unsigned char *)(p + 11);
        if(stride != row)
            for(int y = 0; y < h - 1; y++) memset(pixels + y * stride + row, 0, stride - row);
        pvrtc_decode(data, pixels, stride, w, h, two, format & 2);
    }
    send_draw_packet(ctx, p, 44 + length);
}

static void compressed_image(struct context *ctx, unsigned target, int level, unsigned format, int w, int h,
    int border, int size, const void *data)
{
    if(border || size < 0) { draw_error(ctx, 0x501); return; }
    if(pvrtc_format(format)) { upload_pvrtc(ctx, target, level, format, w, h, size, data, 0); return; }
    const unsigned fields[] = { target, level, format, w, h, border, size };
    texture_packet(ctx, gles2_glCompressedTexImage2D, fields, 7, data, data ? size : 0);
}

static void compressed_sub_image(struct context *ctx, unsigned target, int level, int x, int y, int w, int h,
    unsigned format, int size, const void *data)
{
    if(size < 0) { draw_error(ctx, 0x501); return; }
    if(pvrtc_format(format))
    {
        if(x || y) { draw_error(ctx, 0x502); return; }
        upload_pvrtc(ctx, target, level, format, w, h, size, data, 1);
        return;
    }
    const unsigned fields[] = { target, level, x, y, w, h, format, size };
    texture_packet(ctx, gles2_glCompressedTexSubImage2D, fields, 8, data, data ? size : 0);
}

static void install_texture_functions(driver_word *table)
{
    table[N90_glTexImage2D - 5] = (driver_word)tex_image;
    table[N90_glTexSubImage2D - 5] = (driver_word)tex_sub_image;
    table[N90_glCompressedTexImage2D - 5] = (driver_word)compressed_image;
    table[N90_glCompressedTexSubImage2D - 5] = (driver_word)compressed_sub_image;
}
