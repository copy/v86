// Public GL queries return into guest pointers. The wire carries output
// lengths and returns those bytes in parameter order, never guest addresses.
static unsigned state_count(struct context *ctx, unsigned pname)
{
    switch(pname)
    {
        case 0x0ba2: case 0x0c10: case 0x0c22: case 0x0c23: case 0x8005: return 4;
        case 0x0b70: case 0x0d3a: case 0x846d: case 0x846e: return 2;
        case 0x8df8:
        {
            int count = 0;
            if(!integer_value(ctx, 0x8df9, &count))
            {
                ctx->driver.ok = 0;
                return 0;
            }
            if(count < 0 || count > 16384) { draw_error(ctx, 0x505); return 0; }
            return count;
        }
        default: return 1;
    }
}

static void state_query(struct context *ctx, unsigned pname, void *out, unsigned opcode, unsigned width)
{
    if(pname == 0x86a2 || pname == 0x86a3) // compressed texture formats include guest-side PVRTC
    {
        if(!out) { draw_error(ctx, 0x501); return; }
        int count = 0;
        if(!integer_value(ctx, 0x86a2, &count)) { ctx->driver.ok = 0; return; }
        if(count < 0 || count > 16380) { draw_error(ctx, 0x505); return; }
        if(pname == 0x86a3 && (!SEND(ctx->driver.connection, opcode, pname, count * width) ||
            !gles_read(ctx->driver.connection, out, count * width)))
        {
            ctx->driver.ok = 0;
            return;
        }
        const unsigned first = pname == 0x86a2 ? 0 : count, n = pname == 0x86a2 ? 1 : 4;
        for(unsigned i = 0; i < n; i++)
        {
            const unsigned value = pname == 0x86a2 ? count + 4 : 0x8c00 + i;
            if(opcode == gles2_glGetIntegerv) ((int *)out)[first + i] = value;
            else if(opcode == gles2_glGetFloatv) ((float *)out)[first + i] = value;
            else ((unsigned char *)out)[first + i] = !!value;
        }
        return;
    }
    unsigned bytes = state_count(ctx, pname) * width;
    if(!out && bytes) { draw_error(ctx, 0x501); return; }
    if(!SEND(ctx->driver.connection, opcode, pname, bytes) ||
        !gles_read(ctx->driver.connection, out, bytes)) ctx->driver.ok = 0;
}

static void get_integers(struct context *ctx, unsigned pname, int *out)
{
    state_query(ctx, pname, out, gles2_glGetIntegerv, 4);
}
static void get_floats(struct context *ctx, unsigned pname, float *out)
{
    state_query(ctx, pname, out, gles2_glGetFloatv, 4);
}
static void get_booleans(struct context *ctx, unsigned pname, unsigned char *out)
{
    state_query(ctx, pname, out, gles2_glGetBooleanv, 1);
}

static void object_query(struct context *ctx, unsigned name, unsigned pname, int *out, unsigned opcode)
{
    if(!out) { draw_error(ctx, 0x501); return; }
    if(!SEND(ctx->driver.connection, opcode, name, pname, 4) ||
        !gles_read(ctx->driver.connection, out, 4)) ctx->driver.ok = 0;
}
static void shader_query(struct context *ctx, unsigned name, unsigned pname, int *out)
{
    object_query(ctx, name, pname, out, gles2_glGetShaderiv);
}
static void program_query(struct context *ctx, unsigned name, unsigned pname, int *out)
{
    object_query(ctx, name, pname, out, gles2_glGetProgramiv);
}

static void object_text(struct context *ctx, unsigned name, int size, int *length, char *out, unsigned opcode)
{
    if(size < 0 || (size && !out)) { draw_error(ctx, 0x501); return; }
    if((unsigned)size > N90_MAX_PAYLOAD) { draw_error(ctx, 0x505); return; }
    int count = 0;
    if(!SEND(ctx->driver.connection, opcode, name, size, 4, size) ||
        !gles_read(ctx->driver.connection, &count, 4) || !gles_read(ctx->driver.connection, out, size))
        ctx->driver.ok = 0;
    else if(length) *length = count;
}
static void shader_log(struct context *ctx, unsigned name, int size, int *length, char *out)
{
    object_text(ctx, name, size, length, out, gles2_glGetShaderInfoLog);
}
static void program_log(struct context *ctx, unsigned name, int size, int *length, char *out)
{
    object_text(ctx, name, size, length, out, gles2_glGetProgramInfoLog);
}
static void shader_text(struct context *ctx, unsigned name, int size, int *length, char *out)
{
    object_text(ctx, name, size, length, out, gles2_glGetShaderSource);
}

static void install_query_functions(driver_word *table)
{
    table[N90_glGetIntegerv - 5] = (driver_word)get_integers;
    table[N90_glGetFloatv - 5] = (driver_word)get_floats;
    table[N90_glGetBooleanv - 5] = (driver_word)get_booleans;
    table[N90_glGetShaderiv - 5] = (driver_word)shader_query;
    table[N90_glGetProgramiv - 5] = (driver_word)program_query;
    table[N90_glGetShaderInfoLog - 5] = (driver_word)shader_log;
    table[N90_glGetProgramInfoLog - 5] = (driver_word)program_log;
    table[N90_glGetShaderSource - 5] = (driver_word)shader_text;
}
