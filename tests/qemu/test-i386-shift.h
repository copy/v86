
#define exec_op glue(exec_, OP)
#define exec_opq glue(glue(exec_, OP), q)
#define exec_opl glue(glue(exec_, OP), l)
#define exec_opw glue(glue(exec_, OP), w)
#define exec_opb glue(glue(exec_, OP), b)

#ifndef OP_SHIFTD

#ifdef OP_NOBYTE
#define EXECSHIFT(size, rsize, res, s1, s2, flags) \
    asm ("push %4\n\t"\
         "popf\n\t"\
         stringify(OP) size " %" rsize "2, %" rsize "0\n\t" \
         "pushf\n\t"\
         "pop %1\n\t"\
         : "=g" (res), "=g" (flags)\
         : "r" (s1), "0" (res), "1" (flags));
#else
#define EXECSHIFT(size, rsize, res, s1, s2, flags) \
    asm ("push %4\n\t"\
         "popf\n\t"\
         stringify(OP) size " %%cl, %" rsize "0\n\t" \
         "pushf\n\t"\
         "pop %1\n\t"\
         : "=q" (res), "=g" (flags)\
         : "c" (s1), "0" (res), "1" (flags));
#endif

#if defined(__x86_64__)
void exec_opq(long s2, long s0, long s1, long iflags)
{
    long res, flags;
    res = s0;
    flags = iflags;
    EXECSHIFT("q", "", res, s1, s2, flags);
    /* overflow is undefined if count != 1 */
    if (s1 != 1)
      flags &= ~CC_O;
    printf("%-10s A=" FMTLX " B=" FMTLX " R=" FMTLX " CCIN=%04lx CC=%04lx\n",
           stringify(OP) "q", s0, s1, res, iflags, flags & CC_MASK);
}
#endif

void exec_opl(long s2, long s0, long s1, long iflags)
{
    long res, flags;
    res = s0;
    flags = iflags;
    EXECSHIFT("l", "k", res, s1, s2, flags);
    /* overflow is undefined if count != 1 */
    if (s1 != 1)
      flags &= ~CC_O;
    printf("%-10s A=" FMTLX " B=" FMTLX " R=" FMTLX " CCIN=%04lx CC=%04lx\n",
           stringify(OP) "l", s0, s1, res, iflags, flags & CC_MASK);
}

void exec_opw(long s2, long s0, long s1, long iflags)
{
    long res, flags;
    res = s0;
    flags = iflags;
    EXECSHIFT("w", "w", res, s1, s2, flags);
    /* overflow is undefined if count != 1 */
    if (s1 != 1)
      flags &= ~CC_O;
    printf("%-10s A=" FMTLX " B=" FMTLX " R=" FMTLX " CCIN=%04lx CC=%04lx\n",
           stringify(OP) "w", s0, s1, res, iflags, flags & CC_MASK);
}

#else
#define EXECSHIFT(size, rsize, res, s1, s2, flags) \
    asm ("push %4\n\t"\
         "popf\n\t"\
         stringify(OP) size " %%cl, %" rsize "5, %" rsize "0\n\t" \
         "pushf\n\t"\
         "pop %1\n\t"\
         : "=g" (res), "=g" (flags)\
         : "c" (s1), "0" (res), "1" (flags), "r" (s2));

#if defined(__x86_64__)
void exec_opq(long s2, long s0, long s1, long iflags)
{
    long res, flags;
    res = s0;
    flags = iflags;
    EXECSHIFT("q", "", res, s1, s2, flags);
    /* overflow is undefined if count != 1 */
    if (s1 != 1)
      flags &= ~CC_O;
    printf("%-10s A=" FMTLX " B=" FMTLX " C=" FMTLX " R=" FMTLX " CCIN=%04lx CC=%04lx\n",
           stringify(OP) "q", s0, s2, s1, res, iflags, flags & CC_MASK);
}
#endif

void exec_opl(long s2, long s0, long s1, long iflags)
{
    long res, flags;
    res = s0;
    flags = iflags;
    EXECSHIFT("l", "k", res, s1, s2, flags);
    /* overflow is undefined if count != 1 */
    if (s1 != 1)
      flags &= ~CC_O;
    printf("%-10s A=" FMTLX " B=" FMTLX " C=" FMTLX " R=" FMTLX " CCIN=%04lx CC=%04lx\n",
           stringify(OP) "l", s0, s2, s1, res, iflags, flags & CC_MASK);
}

void exec_opw(long s2, long s0, long s1, long iflags)
{
    long res, flags;
    res = s0;
    flags = iflags;
    EXECSHIFT("w", "w", res, s1, s2, flags);
    /* overflow is undefined if count != 1 */
    if (s1 != 1)
      flags &= ~CC_O;
    printf("%-10s A=" FMTLX " B=" FMTLX " C=" FMTLX " R=" FMTLX " CCIN=%04lx CC=%04lx\n",
           stringify(OP) "w", s0, s2, s1, res, iflags, flags & CC_MASK);
}

#endif

#ifndef OP_NOBYTE
void exec_opb(long s0, long s1, long iflags)
{
    long res, flags;
    res = s0;
    flags = iflags;
    EXECSHIFT("b", "b", res, s1, 0, flags);
    /* overflow is undefined if count != 1 */
    if (s1 != 1)
      flags &= ~CC_O;
    printf("%-10s A=" FMTLX " B=" FMTLX " R=" FMTLX " CCIN=%04lx CC=%04lx\n",
           stringify(OP) "b", s0, s1, res, iflags, flags & CC_MASK);
}
#endif

void exec_op(long s2, long s0, long s1)
{
    s2 = i2l(s2);
    s0 = i2l(s0);
#if defined(__x86_64__)
    exec_opq(s2, s0, s1, 0);
#endif
    exec_opl(s2, s0, s1, 0);
#ifdef OP_SHIFTD
    exec_opw(s2, s0, s1, 0);
#else
    exec_opw(s2, s0, s1, 0);
#endif
#ifndef OP_NOBYTE
    exec_opb(s0, s1, 0);
#endif
#ifdef OP_CC
#if defined(__x86_64__)
    exec_opq(s2, s0, s1, CC_C);
#endif
    exec_opl(s2, s0, s1, CC_C);
    exec_opw(s2, s0, s1, CC_C);
    exec_opb(s0, s1, CC_C);
#endif
}

void glue(test_, OP)(void)
{
    int i, n;
#if defined(__x86_64__)
    n = 64;
#else
    n = 32;
#endif
    for(i = 0; i < n; i++)
        exec_op(0x21ad3d34, 0x12345678, i);
    for(i = 0; i < n; i++)
        exec_op(0x813f3421, 0x82345679, i);
}

void *glue(_test_, OP) __init_call = glue(test_, OP);

#undef OP
#undef OP_CC
#undef OP_SHIFTD
#undef OP_NOBYTE
#undef EXECSHIFT
