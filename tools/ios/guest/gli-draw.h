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

static unsigned component_bytes(unsigned type)
{
    switch(type)
    {
        case 0x1400: case 0x1401: return 1;
        case 0x1402: case 0x1403: case 0x8d61: return 2;
        case 0x1406: case 0x140c: return 4;
        default: return 0;
    }
}

static void attrib_pointer(struct context *ctx, unsigned index, int size, unsigned type, unsigned char norm,
    int stride, const void *offset)
{
    if(index >= N90_ATTRIBS || size < 1 || size > 4 || stride < 0) { draw_error(ctx, 0x501); return; }
    if(!component_bytes(type)) { draw_error(ctx, 0x500); return; }
    int buffer = 0;
    if(!integer_value(ctx, 0x8894, &buffer)) { ctx->driver.ok = 0; return; }
    struct client_attrib *a = &ctx->attribs[index];
    a->client = !buffer;
    a->data = offset;
    a->type = type;
    a->size = size;
    a->stride = stride;
    a->normalized = !!norm;
    if(!buffer) return;
    // The wire GLboolean is one byte; stride and offset follow unaligned.
    unsigned p[8] = { gles2_glVertexAttribPointerOffset, 0, index, size, type };
    unsigned char *wire = (unsigned char *)p;
    wire[20] = norm;
    memcpy(wire + 21, &stride, 4);
    memcpy(wire + 25, &offset, 4);
    if(!gles_send(ctx->driver.connection, p, 29)) ctx->driver.ok = 0;
}

static void enable_attrib(struct context *ctx, unsigned index)
{
    if(index >= N90_ATTRIBS) { draw_error(ctx, 0x501); return; }
    ctx->attribs[index].enabled = 1;
    ctx->driver.ok &= SEND(ctx->driver.connection, gles2_glEnableVertexAttribArray, index);
}

static void disable_attrib(struct context *ctx, unsigned index)
{
    if(index >= N90_ATTRIBS) { draw_error(ctx, 0x501); return; }
    ctx->attribs[index].enabled = 0;
    ctx->driver.ok &= SEND(ctx->driver.connection, gles2_glDisableVertexAttribArray, index);
}

// Client arrays are live at the draw call; they may be stack-backed or
// have changed since glVertexAttribPointer. The renderer receives a copy.
static int send_client_attribs(struct context *ctx, unsigned vertices)
{
    for(unsigned index = 0; index < N90_ATTRIBS; index++)
    {
        const struct client_attrib *a = &ctx->attribs[index];
        if(!a->enabled || !a->client) continue;
        unsigned element = (unsigned)a->size * component_bytes(a->type);
        unsigned stride = a->stride ? (unsigned)a->stride : element;
        if(!a->data) { draw_error(ctx, 0x502); return 0; }
        unsigned length, span, last;
        if(__builtin_mul_overflow(vertices, element, &length) || length > N90_MAX_PAYLOAD ||
            __builtin_mul_overflow(vertices - 1, stride, &span) ||
            __builtin_add_overflow(span, element - 1, &last) ||
            __builtin_add_overflow(last, (unsigned)(usize)a->data, &last))
        {
            draw_error(ctx, 0x505);
            return 0;
        }
        const unsigned bytes = 33 + length;
        unsigned *p = draw_packet(ctx, gles2_glVertexAttribPointerData, bytes);
        if(!p) return 0;
        p[2] = index; p[3] = a->size; p[4] = a->type;
        unsigned char *wire = (unsigned char *)p;
        wire[20] = a->normalized;
        const unsigned tight = 0;
        memcpy(wire + 21, &tight, 4);
        memcpy(wire + 25, &length, 4);
        if(stride == element) memcpy(wire + 29, a->data, length);
        else for(unsigned i = 0; i < vertices; i++)
            memcpy(wire + 29 + i * element, (const unsigned char *)a->data + i * stride, element);
        memcpy(wire + 29 + length, &length, 4);
        send_draw_packet(ctx, p, bytes);
        if(!ctx->driver.ok) return 0;
    }
    return 1;
}

static void draw_arrays(struct context *ctx, unsigned mode, int first, int count)
{
    if(first < 0 || count < 0) { draw_error(ctx, 0x501); return; }
    if(!count || send_client_attribs(ctx, (unsigned)first + (unsigned)count))
    {
        ctx->driver.ok &= SEND(ctx->driver.connection, gles2_glDrawArrays, mode, first, count);
        if(count) ctx->frame_dirty |= !!ctx->framebuffer;
    }
}

static void draw_elements(struct context *ctx, unsigned mode, int count, unsigned type, const void *indices)
{
    if(count < 0) { draw_error(ctx, 0x501); return; }
    unsigned width = type == 0x1401 ? 1 : type == 0x1403 ? 2 : type == 0x1405 ? 4 : 0;
    if(!width) { draw_error(ctx, 0x500); return; }
    int buffer = 0;
    if(!integer_value(ctx, 0x8895, &buffer)) { ctx->driver.ok = 0; return; }
    if(buffer)
    {
        // The common indexed VBO path never dereferences the guest pointer.
        for(unsigned i = 0; count && i < N90_ATTRIBS; i++)
            if(ctx->attribs[i].client && ctx->attribs[i].enabled) { draw_error(ctx, 0x502); return; }
        ctx->driver.ok &= SEND(ctx->driver.connection, gles2_glDrawElementsOffset, mode, count, type, (unsigned)(usize)indices);
        if(count) ctx->frame_dirty |= !!ctx->framebuffer;
        return;
    }
    if(count && !indices) { draw_error(ctx, 0x502); return; }
    unsigned length;
    if(__builtin_mul_overflow((unsigned)count, width, &length) || length > N90_MAX_PAYLOAD)
    {
        draw_error(ctx, 0x505);
        return;
    }
    if(count)
    {
        const unsigned char *src = indices;
        unsigned maximum = 0;
        for(unsigned i = 0; i < length; i += width)
        {
            unsigned index = 0;
            memcpy(&index, src + i, width);
            if(index > maximum) maximum = index;
        }
        if(maximum == ~0u) { draw_error(ctx, 0x505); return; }
        if(!send_client_attribs(ctx, maximum + 1)) return;
    }
    const unsigned bytes = 28 + length;
    unsigned *p = draw_packet(ctx, gles2_glDrawElementsData, bytes);
    if(!p) return;
    p[2] = mode; p[3] = count; p[4] = type; p[5] = length;
    if(length) memcpy(p + 6, indices, length);
    memcpy((unsigned char *)(p + 6) + length, &length, 4);
    send_draw_packet(ctx, p, bytes);
    if(count) ctx->frame_dirty |= !!ctx->framebuffer;
}

static void install_draw_functions(driver_word *table)
{
    table[N90_glShaderSource - 5] = (driver_word)shader_source;
    table[N90_glBufferData - 5] = (driver_word)buffer_data;
    table[N90_glBufferSubData - 5] = (driver_word)buffer_subdata;
    table[N90_glGetAttribLocation - 5] = (driver_word)attrib_location;
    table[N90_glVertexAttribPointer - 5] = (driver_word)attrib_pointer;
    table[N90_glEnableVertexAttribArray - 5] = (driver_word)enable_attrib;
    table[N90_glDisableVertexAttribArray - 5] = (driver_word)disable_attrib;
    table[N90_glDrawArrays - 5] = (driver_word)draw_arrays;
    table[N90_glDrawElements - 5] = (driver_word)draw_elements;
}
