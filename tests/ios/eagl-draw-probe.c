// The caller supplies a complete 64x48 IOSurface framebuffer. Draw an
// oversized triangle whose vertices arrive through an actual guest VBO.
extern unsigned glCreateShader(unsigned), glCreateProgram(void), glGetError(void);
extern void glShaderSource(unsigned, int, const char *const *, const int *);
extern void glCompileShader(unsigned), glAttachShader(unsigned, unsigned), glLinkProgram(unsigned);
extern void glUseProgram(unsigned), glDeleteProgram(unsigned), glDeleteShader(unsigned);
extern int glGetAttribLocation(unsigned, const char *);
extern void glGenBuffers(int, unsigned *), glBindBuffer(unsigned, unsigned), glDeleteBuffers(int, const unsigned *);
extern void glBufferData(unsigned, int, const void *, unsigned), glBufferSubData(unsigned, int, int, const void *);
extern void glEnableVertexAttribArray(unsigned), glDisableVertexAttribArray(unsigned);
extern void glVertexAttribPointer(unsigned, int, unsigned, unsigned char, int, const void *);
extern void glDrawArrays(unsigned, int, int), glViewport(int, int, int, int), glDisable(unsigned);
extern void glReadPixels(int, int, int, int, unsigned, unsigned, void *);
extern void glGetIntegerv(unsigned, int *), glGetFloatv(unsigned, float *), glGetBooleanv(unsigned, unsigned char *);
extern void glGetShaderiv(unsigned, unsigned, int *), glGetProgramiv(unsigned, unsigned, int *);
extern void glGetShaderInfoLog(unsigned, int, int *, char *), glGetProgramInfoLog(unsigned, int, int *, char *);
extern void glColorMask(unsigned char, unsigned char, unsigned char, unsigned char), glClearColor(float, float, float, float);

int n90_triangle_pixels(void)
{
    unsigned vs = glCreateShader(0x8b31), fs = glCreateShader(0x8b30), program = glCreateProgram(), vbo = 0;
    int step = 1, location = -1;
    if(!vs || !fs || !program) goto done;
    const char *vertex[] = { "attribute vec2 pos;IGNORE", "void main(){gl_Position=vec4(pos,0.,1.);}" };
    const int lengths[] = { 19, -1 };
    const char *fragment = "precision mediump float;void main(){gl_FragColor=vec4(1.,0.,1.,1.);}";
    glShaderSource(vs, 2, vertex, lengths);
    glShaderSource(fs, 1, &fragment, 0);
    glCompileShader(vs); glCompileShader(fs);
    int status = 0;
    glGetShaderiv(vs, 0x8b81, &status);
    if(status != 1) goto done;
    status = 0;
    glGetShaderiv(fs, 0x8b81, &status);
    if(status != 1) goto done;
    glAttachShader(program, vs); glAttachShader(program, fs);
    glLinkProgram(program);
    status = 0;
    glGetProgramiv(program, 0x8b82, &status);
    if(status != 1) goto done;
    char log[8] = { 91,91,91,91,91,91,91,92 };
    int length = -1;
    glGetProgramInfoLog(program, 1, &length, log + 1);
    if(length || log[0] != 91 || log[1] || log[2] != 91) goto done;
    glGetShaderInfoLog(vs, 1, 0, log + 1);
    if(log[1]) goto done;
    location = glGetAttribLocation(program, "pos");
    step = 2;
    if(location < 0 || glGetError()) goto done;
    glUseProgram(program);
    status = 0;
    glGetIntegerv(0x8b8d, &status);
    if((unsigned)status != program) goto done;
    glClearColor(0.25f, 0.5f, 0.75f, 1);
    float color[6] = { 91,0,0,0,0,92 };
    glGetFloatv(0xc22, color + 1);
    if(color[0] != 91 || color[1] != 0.25f || color[2] != 0.5f || color[3] != 0.75f || color[4] != 1 || color[5] != 92) goto done;
    glColorMask(1, 0, 1, 0);
    unsigned char mask[6] = { 91,9,9,9,9,92 };
    glGetBooleanv(0xc23, mask + 1);
    glColorMask(1, 1, 1, 1);
    if(mask[0] != 91 || mask[1] != 1 || mask[2] || mask[3] != 1 || mask[4] || mask[5] != 92) goto done;
    glGenBuffers(1, &vbo);
    glBindBuffer(0x8892, vbo);
    // Reserve room for a leading float to exercise a nonzero VBO offset.
    const float data[] = { -1,-1, 3,-1, -1,3 };
    glBufferData(0x8892, 4 + sizeof(data), 0, 0x88e4);
    glBufferSubData(0x8892, 4, sizeof(data), data);
    glVertexAttribPointer(location, 2, 0x1406, 0, 8, (void *)4);
    glEnableVertexAttribArray(location);
    glViewport(0, 0, 64, 48); glDisable(0xc11);
    int viewport[6] = { 91,-1,-1,-1,-1,92 };
    glGetIntegerv(0xba2, viewport + 1);
    if(viewport[0] != 91 || viewport[1] || viewport[2] || viewport[3] != 64 || viewport[4] != 48 || viewport[5] != 92) goto done;
    glDrawArrays(4, 0, 3);
    step = 3;
    if(glGetError()) goto done;
    unsigned char pixels[64 * 48 * 4];
    glReadPixels(0, 0, 64, 48, 0x1908, 0x1401, pixels);
    step = 4;
    if(glGetError()) goto done;
    for(unsigned i = 0; i < sizeof(pixels); i += 4)
        if(pixels[i] != 255 || pixels[i+1] || pixels[i+2] != 255 || pixels[i+3] != 255) goto done;
    step = 0;
done:
    if(location >= 0) glDisableVertexAttribArray(location);
    glUseProgram(0);
    if(vbo) glDeleteBuffers(1, &vbo);
    if(program) glDeleteProgram(program);
    if(vs) glDeleteShader(vs);
    if(fs) glDeleteShader(fs);
    return step;
}
