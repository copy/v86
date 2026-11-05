// Flatten guest uniform arrays. Matrix packets put the one-byte boolean
// before an unaligned pointer length, as required by the shared wire ABI.
static void uniform_array(struct context *ctx, int location, int count, const void *data,
    unsigned opcode, unsigned components, int matrix, unsigned char transpose)
{
    if(count < 0) { draw_error(ctx, 0x501); return; }
    if(matrix && transpose) { draw_error(ctx, 0x501); return; }
    if(location == -1) return;
    if(count && !data) { draw_error(ctx, 0x501); return; }
    unsigned long long total = (unsigned long long)(unsigned)count * components * 4;
    if(total > N90_MAX_PAYLOAD) { draw_error(ctx, 0x505); return; }
    unsigned n = (unsigned)total, head = matrix ? 21 : 20;
    unsigned *p = draw_packet(ctx, opcode, head + n);
    if(!p) return;
    p[2] = location; p[3] = count;
    unsigned char *wire = (unsigned char *)p;
    if(matrix) wire[16] = transpose;
    memcpy(wire + head - 4, &n, 4);
    if(n) memcpy(wire + head, data, n);
    send_draw_packet(ctx, p, head + n);
}

#define N90_UNIFORM_VECTOR(n, kind, type) \
static void uniform##n##kind(struct context *ctx, int location, int count, const type *data) \
{ uniform_array(ctx, location, count, data, gles2_glUniform##n##kind, n, 0, 0); }
N90_UNIFORM_VECTOR(1, fv, float)
N90_UNIFORM_VECTOR(2, fv, float)
N90_UNIFORM_VECTOR(3, fv, float)
N90_UNIFORM_VECTOR(4, fv, float)
N90_UNIFORM_VECTOR(1, iv, int)
N90_UNIFORM_VECTOR(2, iv, int)
N90_UNIFORM_VECTOR(3, iv, int)
N90_UNIFORM_VECTOR(4, iv, int)
#undef N90_UNIFORM_VECTOR

#define N90_UNIFORM_MATRIX(n) \
static void uniform_matrix##n(struct context *ctx, int location, int count, unsigned char transpose, const float *data) \
{ uniform_array(ctx, location, count, data, gles2_glUniformMatrix##n##fv, n * n, 1, transpose); }
N90_UNIFORM_MATRIX(2)
N90_UNIFORM_MATRIX(3)
N90_UNIFORM_MATRIX(4)
#undef N90_UNIFORM_MATRIX

static int uniform_location(struct context *ctx, unsigned program, const char *name)
{
    return named_location(ctx, program, name, gles2_glGetUniformLocation);
}

static void bind_attrib_location(struct context *ctx, unsigned program, unsigned index, const char *name)
{
    if(!name) { draw_error(ctx, 0x501); return; }
    unsigned n = fragment_size(name, -1, N90_MAX_PAYLOAD) + 1;
    if(n > N90_MAX_PAYLOAD) { draw_error(ctx, 0x505); return; }
    unsigned *p = draw_packet(ctx, gles2_glBindAttribLocation, 20 + n);
    if(!p) return;
    p[2] = program; p[3] = index; p[4] = n;
    memcpy(p + 5, name, n);
    send_draw_packet(ctx, p, 20 + n);
}

static void install_uniform_functions(driver_word *table)
{
#define N90_INSTALL_VECTOR(n, kind) table[N90_glUniform##n##kind - 5] = (driver_word)uniform##n##kind;
    N90_INSTALL_VECTOR(1, fv) N90_INSTALL_VECTOR(2, fv) N90_INSTALL_VECTOR(3, fv) N90_INSTALL_VECTOR(4, fv)
    N90_INSTALL_VECTOR(1, iv) N90_INSTALL_VECTOR(2, iv) N90_INSTALL_VECTOR(3, iv) N90_INSTALL_VECTOR(4, iv)
#undef N90_INSTALL_VECTOR
#define N90_INSTALL_MATRIX(n) table[N90_glUniformMatrix##n##fv - 5] = (driver_word)uniform_matrix##n;
    N90_INSTALL_MATRIX(2) N90_INSTALL_MATRIX(3) N90_INSTALL_MATRIX(4)
#undef N90_INSTALL_MATRIX
    table[N90_glGetUniformLocation - 5] = (driver_word)uniform_location;
    table[N90_glBindAttribLocation - 5] = (driver_word)bind_attrib_location;
}
