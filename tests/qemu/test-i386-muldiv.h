
void glue(glue(test_, OP), b)(long op0, long op1)
{
    long res, s1, s0, flags;
    s0 = op0;
    s1 = op1;
    res = s0;
    flags = 0;
    asm ("push %4\n\t"
         "popf\n\t"
         stringify(OP)"b %b2\n\t"
         "pushf\n\t"
         "pop %1\n\t"
         : "=a" (res), "=g" (flags)
         : "q" (s1), "0" (res), "1" (flags));
    printf("%-10s A=" FMTLX " B=" FMTLX " R=" FMTLX " CC=%04lx\n",
           stringify(OP) "b", s0, s1, res, flags & CC_MASK);
}

void glue(glue(test_, OP), w)(long op0h, long op0, long op1)
{
    long res, s1, flags, resh;
    s1 = op1;
    resh = op0h;
    res = op0;
    flags = 0;
    asm ("push %5\n\t"
         "popf\n\t"
         stringify(OP) "w %w3\n\t"
         "pushf\n\t"
         "pop %1\n\t"
         : "=a" (res), "=g" (flags), "=d" (resh)
         : "q" (s1), "0" (res), "1" (flags), "2" (resh));
    printf("%-10s AH=" FMTLX " AL=" FMTLX " B=" FMTLX " RH=" FMTLX " RL=" FMTLX " CC=%04lx\n",
           stringify(OP) "w", op0h, op0, s1, resh, res, flags & CC_MASK);
}

void glue(glue(test_, OP), l)(long op0h, long op0, long op1)
{
    long res, s1, flags, resh;
    s1 = op1;
    resh = op0h;
    res = op0;
    flags = 0;
    asm ("push %5\n\t"
         "popf\n\t"
         stringify(OP) "l %k3\n\t"
         "pushf\n\t"
         "pop %1\n\t"
         : "=a" (res), "=g" (flags), "=d" (resh)
         : "q" (s1), "0" (res), "1" (flags), "2" (resh));
    printf("%-10s AH=" FMTLX " AL=" FMTLX " B=" FMTLX " RH=" FMTLX " RL=" FMTLX " CC=%04lx\n",
           stringify(OP) "l", op0h, op0, s1, resh, res, flags & CC_MASK);
}

#if defined(__x86_64__)
void glue(glue(test_, OP), q)(long op0h, long op0, long op1)
{
    long res, s1, flags, resh;
    s1 = op1;
    resh = op0h;
    res = op0;
    flags = 0;
    asm ("push %5\n\t"
         "popf\n\t"
         stringify(OP) "q %3\n\t"
         "pushf\n\t"
         "pop %1\n\t"
         : "=a" (res), "=g" (flags), "=d" (resh)
         : "q" (s1), "0" (res), "1" (flags), "2" (resh));
    printf("%-10s AH=" FMTLX " AL=" FMTLX " B=" FMTLX " RH=" FMTLX " RL=" FMTLX " CC=%04lx\n",
           stringify(OP) "q", op0h, op0, s1, resh, res, flags & CC_MASK);
}
#endif

#undef OP
