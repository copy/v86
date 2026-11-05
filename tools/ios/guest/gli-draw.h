// Native ES2 pointer arguments are in the guest address space. Flatten
// the data into emugl's packed wire format before trapping to the host.
#define N90_MAX_PAYLOAD ((80u << 20) - 32)

static void draw_error(struct context *ctx, unsigned error)
{
    if(!ctx->error) ctx->error = error;
}

static unsigned *draw_packet(struct context *ctx, unsigned opcode, unsigned bytes)
{
    unsigned *p = bytes <= (80u << 20) ? malloc(bytes) : 0;
    if(p) p[0] = opcode;
    else draw_error(ctx, 0x505);
    return p;
}

static void send_draw_packet(struct context *ctx, unsigned *p, unsigned bytes)
{
    if(!gles_send(ctx->driver.connection, p, bytes)) ctx->driver.ok = 0;
    free(p);
}

static unsigned fragment_size(const char *text, int length, unsigned limit)
{
    if(length >= 0) return (unsigned)length;
    unsigned n = 0;
    while(n <= limit && text[n]) n++;
    return n;
}

static void shader_source(struct context *ctx, unsigned shader, int count, const char *const *text, const int *lengths)
{
    if(count < 0 || (count && !text)) { draw_error(ctx, 0x501); return; }
    unsigned total = 0;
    for(int i = 0; i < count; i++)
    {
        if(!text[i]) { draw_error(ctx, 0x501); return; }
        unsigned n = fragment_size(text[i], lengths ? lengths[i] : -1, N90_MAX_PAYLOAD - total);
        if(n > N90_MAX_PAYLOAD - total) { draw_error(ctx, 0x505); return; }
        total += n;
    }
    const unsigned bytes = 21 + total, terminated = total + 1;
    unsigned *p = draw_packet(ctx, gles2_glShaderString, bytes);
    if(!p) return;
    p[2] = shader; p[3] = terminated;
    char *dst = (char *)(p + 4);
    for(int i = 0; i < count; i++)
    {
        unsigned n = fragment_size(text[i], lengths ? lengths[i] : -1, total);
        memcpy(dst, text[i], n); dst += n;
    }
    *dst++ = 0;
    memcpy(dst, &terminated, 4);
    send_draw_packet(ctx, p, bytes);
}

static void buffer_data(struct context *ctx, unsigned target, int size, const void *data, unsigned usage)
{
    if(size < 0) { draw_error(ctx, 0x501); return; }
    if((unsigned)size > N90_MAX_PAYLOAD) { draw_error(ctx, 0x505); return; }
    unsigned n = data ? (unsigned)size : 0, bytes = 24 + n;
    unsigned *p = draw_packet(ctx, gles2_glBufferData, bytes);
    if(!p) return;
    p[2] = target; p[3] = size; p[4] = n;
    if(n) memcpy(p + 5, data, n);
    memcpy((char *)(p + 5) + n, &usage, 4);
    send_draw_packet(ctx, p, bytes);
}

static void buffer_subdata(struct context *ctx, unsigned target, int offset, int size, const void *data)
{
    if(offset < 0 || size < 0 || (size && !data)) { draw_error(ctx, 0x501); return; }
    if((unsigned)size > N90_MAX_PAYLOAD) { draw_error(ctx, 0x505); return; }
    unsigned bytes = 24 + (unsigned)size;
    unsigned *p = draw_packet(ctx, gles2_glBufferSubData, bytes);
    if(!p) return;
    p[2] = target; p[3] = offset; p[4] = size; p[5] = size;
    if(size) memcpy(p + 6, data, size);
    send_draw_packet(ctx, p, bytes);
}

static int named_location(struct context *ctx, unsigned program, const char *name, unsigned opcode)
{
    if(!name) { draw_error(ctx, 0x501); return -1; }
    unsigned n = fragment_size(name, -1, N90_MAX_PAYLOAD) + 1;
    if(n > N90_MAX_PAYLOAD) { draw_error(ctx, 0x505); return -1; }
    unsigned bytes = 16 + n;
    unsigned *p = draw_packet(ctx, opcode, bytes);
    if(!p) return -1;
    p[2] = program; p[3] = n;
    memcpy(p + 4, name, n);
    int location = -1;
    if(!gles_send(ctx->driver.connection, p, bytes) || !gles_read(ctx->driver.connection, &location, 4))
        ctx->driver.ok = 0;
    free(p);
    return location;
}

static int attrib_location(struct context *ctx, unsigned program, const char *name)
{
    return named_location(ctx, program, name, gles2_glGetAttribLocation);
}

static void attrib_pointer(struct context *ctx, unsigned index, int size, unsigned type, unsigned char norm,
    int stride, const void *offset)
{
    int buffer = 0;
    if(!integer_value(ctx, 0x8894, &buffer)) { ctx->driver.ok = 0; return; }
    if(!buffer) { invalid_operation(ctx); return; }
    // The wire GLboolean is one byte; stride and offset follow unaligned.
    unsigned p[8] = { gles2_glVertexAttribPointerOffset, 0, index, size, type };
    unsigned char *wire = (unsigned char *)p;
    wire[20] = norm;
    memcpy(wire + 21, &stride, 4);
    memcpy(wire + 25, &offset, 4);
    if(!gles_send(ctx->driver.connection, p, 29)) ctx->driver.ok = 0;
}

static void install_draw_functions(driver_word *table)
{
    table[N90_glShaderSource - 5] = (driver_word)shader_source;
    table[N90_glBufferData - 5] = (driver_word)buffer_data;
    table[N90_glBufferSubData - 5] = (driver_word)buffer_subdata;
    table[N90_glGetAttribLocation - 5] = (driver_word)attrib_location;
    table[N90_glVertexAttribPointer - 5] = (driver_word)attrib_pointer;
}
