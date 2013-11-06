
#define exec_op glue(exec_, OP)
#define exec_opq glue(glue(exec_, OP), q)
#define exec_opl glue(glue(exec_, OP), l)
#define exec_opw glue(glue(exec_, OP), w)
#define exec_opb glue(glue(exec_, OP), b)

#define EXECOP2(size, rsize, res, s1, flags) \
    asm ("push %4\n\t"\
         "popf\n\t"\
         stringify(OP) size " %" rsize "2, %" rsize "0\n\t" \
         "pushf\n\t"\
         "pop %1\n\t"\
         : "=q" (res), "=g" (flags)\
         : "q" (s1), "0" (res), "1" (flags)); \
    printf("%-10s A=" FMTLX " B=" FMTLX " R=" FMTLX " CCIN=%04lx CC=%04lx\n", \
           stringify(OP) size, s0, s1, res, iflags, flags & CC_MASK);

#define EXECOP1(size, rsize, res, flags) \
    asm ("push %3\n\t"\
         "popf\n\t"\
         stringify(OP) size " %" rsize "0\n\t" \
         "pushf\n\t"\
         "pop %1\n\t"\
         : "=q" (res), "=g" (flags)\
         : "0" (res), "1" (flags)); \
    printf("%-10s A=" FMTLX " R=" FMTLX " CCIN=%04lx CC=%04lx\n", \
           stringify(OP) size, s0, res, iflags, flags & CC_MASK);

#ifdef OP1
#if defined(__x86_64__)
void exec_opq(long s0, long s1, long iflags)
{
    long res, flags;
    res = s0;
    flags = iflags;
    EXECOP1("q", "", res, flags);
}
#endif

void exec_opl(long s0, long s1, long iflags)
{
    long res, flags;
    res = s0;
    flags = iflags;
    EXECOP1("l", "k", res, flags);
}

void exec_opw(long s0, long s1, long iflags)
{
    long res, flags;
    res = s0;
    flags = iflags;
    EXECOP1("w", "w", res, flags);
}

void exec_opb(long s0, long s1, long iflags)
{
    long res, flags;
    res = s0;
    flags = iflags;
    EXECOP1("b", "b", res, flags);
}
#else
#if defined(__x86_64__)
void exec_opq(long s0, long s1, long iflags)
{
    long res, flags;
    res = s0;
    flags = iflags;
    EXECOP2("q", "", res, s1, flags);
}
#endif

void exec_opl(long s0, long s1, long iflags)
{
    long res, flags;
    res = s0;
    flags = iflags;
    EXECOP2("l", "k", res, s1, flags);
}

void exec_opw(long s0, long s1, long iflags)
{
    long res, flags;
    res = s0;
    flags = iflags;
    EXECOP2("w", "w", res, s1, flags);
}

void exec_opb(long s0, long s1, long iflags)
{
    long res, flags;
    res = s0;
    flags = iflags;
    EXECOP2("b", "b", res, s1, flags);
}
#endif

void exec_op(long s0, long s1)
{
    s0 = i2l(s0);
    s1 = i2l(s1);
#if defined(__x86_64__)
    exec_opq(s0, s1, 0);
#endif
    exec_opl(s0, s1, 0);
    exec_opw(s0, s1, 0);
    exec_opb(s0, s1, 0);
#ifdef OP_CC
#if defined(__x86_64__)
    exec_opq(s0, s1, CC_C);
#endif
    exec_opl(s0, s1, CC_C);
    exec_opw(s0, s1, CC_C);
    exec_opb(s0, s1, CC_C);
#endif
}

void glue(test_, OP)(void)
{
    exec_op(0x12345678, 0x812FADA);
    exec_op(0x12341, 0x12341);
    exec_op(0x12341, -0x12341);
    exec_op(0xffffffff, 0);
    exec_op(0xffffffff, -1);
    exec_op(0xffffffff, 1);
    exec_op(0xffffffff, 2);
    exec_op(0x7fffffff, 0);
    exec_op(0x7fffffff, 1);
    exec_op(0x7fffffff, -1);
    exec_op(0x80000000, -1);
    exec_op(0x80000000, 1);
    exec_op(0x80000000, -2);
    exec_op(0x12347fff, 0);
    exec_op(0x12347fff, 1);
    exec_op(0x12347fff, -1);
    exec_op(0x12348000, -1);
    exec_op(0x12348000, 1);
    exec_op(0x12348000, -2);
    exec_op(0x12347f7f, 0);
    exec_op(0x12347f7f, 1);
    exec_op(0x12347f7f, -1);
    exec_op(0x12348080, -1);
    exec_op(0x12348080, 1);
    exec_op(0x12348080, -2);
}

void *glue(_test_, OP) __init_call = glue(test_, OP);

#undef OP
#undef OP_CC
