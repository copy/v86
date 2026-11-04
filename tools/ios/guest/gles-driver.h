// The iOS wrapper supplies the driver instance before the public GLES arguments.
#include "gl-slots.h"

struct n90_driver { unsigned connection; int ok; };
typedef __UINTPTR_TYPE__ driver_word;

static void driver_clear(struct n90_driver *d, unsigned mask)
{
    d->ok &= SEND(d->connection, gles2_glClear, mask);
}

static unsigned float_word(float f)
{
    union { float f; unsigned u; } word = { .f = f };
    return word.u;
}

static void driver_clear_color(struct n90_driver *d, float r, float g, float b, float a)
{
    d->ok &= SEND(d->connection, gles2_glClearColor, float_word(r), float_word(g), float_word(b), float_word(a));
}

static void driver_enable(struct n90_driver *d, unsigned capability)
{
    d->ok &= SEND(d->connection, gles2_glEnable, capability);
}

static void driver_scissor(struct n90_driver *d, int x, int y, int w, int h)
{
    d->ok &= SEND(d->connection, gles2_glScissor, x, y, w, h);
}

static void install_frame_functions(driver_word *functions)
{
    functions[N90_glClear - 5] = (driver_word)driver_clear;
    functions[N90_glClearColor - 5] = (driver_word)driver_clear_color;
    functions[N90_glEnable - 5] = (driver_word)driver_enable;
    functions[N90_glScissor - 5] = (driver_word)driver_scissor;
}
